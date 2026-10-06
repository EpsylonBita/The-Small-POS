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

use chrono::{DateTime, Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::{self, DbState};
use crate::money::Cents;
use crate::{business_day, order_ownership, payment_integrity, storage, sync_queue};

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
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RepairReportingProjection {
    pub source: String,
    pub staff_shift_id: String,
    pub projection_version: i64,
    pub projected_at: String,
    pub overall_tender: f64,
    pub overall_cash: f64,
    pub overall_card: f64,
    pub overall_orders_count: i64,
    pub repair_tender: f64,
    pub repair_cash: f64,
    pub repair_card: f64,
    pub repair_orders_count: i64,
}

/// Cache a server-authored projection over the canonical payment and
/// adjustment ledgers. This is a read mirror, never a local money ledger.
pub fn apply_repair_reporting_projection(
    db: &DbState,
    projection: &RepairReportingProjection,
) -> Result<Value, String> {
    if projection.source != "repair_canonical_tender_projection_v1"
        || Uuid::parse_str(&projection.staff_shift_id).is_err()
        || projection.projection_version <= 0
        || DateTime::parse_from_rfc3339(&projection.projected_at).is_err()
        || projection.overall_orders_count < 0
        || projection.repair_orders_count < 0
        || ![
            projection.overall_tender,
            projection.overall_cash,
            projection.overall_card,
            projection.repair_tender,
            projection.repair_cash,
            projection.repair_card,
        ]
        .iter()
        .all(|value| value.is_finite())
    {
        return Err("REPAIR_REPORTING_EVIDENCE_INVALID".to_string());
    }

    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let current = conn
        .query_row(
            "SELECT COALESCE(repair_projection_version, 0),
                    repair_projection_synced_at,
                    COALESCE(total_sales_amount, 0),
                    COALESCE(total_cash_sales, 0),
                    COALESCE(total_card_sales, 0),
                    COALESCE(total_orders_count, 0),
                    COALESCE(repair_tender_sales, 0),
                    COALESCE(repair_cash_sales, 0),
                    COALESCE(repair_card_sales, 0),
                    COALESCE(repair_orders_count, 0)
               FROM staff_shifts WHERE id = ?1",
            params![projection.staff_shift_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, f64>(6)?,
                    row.get::<_, f64>(7)?,
                    row.get::<_, f64>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read repair reporting projection: {error}"))?
        .ok_or_else(|| "REPAIR_REPORTING_SHIFT_NOT_FOUND".to_string())?;

    if current.0 > projection.projection_version {
        return Ok(serde_json::json!({ "applied": false, "stale": true }));
    }
    if current.0 == projection.projection_version {
        let same = current.1.as_deref() == Some(projection.projected_at.as_str())
            && (current.2 - projection.overall_tender).abs() <= 0.000001
            && (current.3 - projection.overall_cash).abs() <= 0.000001
            && (current.4 - projection.overall_card).abs() <= 0.000001
            && current.5 == projection.overall_orders_count
            && (current.6 - projection.repair_tender).abs() <= 0.000001
            && (current.7 - projection.repair_cash).abs() <= 0.000001
            && (current.8 - projection.repair_card).abs() <= 0.000001
            && current.9 == projection.repair_orders_count;
        if !same {
            return Err("REPAIR_REPORTING_EVIDENCE_COLLISION".to_string());
        }
        return Ok(serde_json::json!({ "applied": false, "wasReplay": true }));
    }

    conn.execute(
        "UPDATE staff_shifts
            SET total_sales_amount=?2, total_cash_sales=?3, total_card_sales=?4,
                total_orders_count=?5, repair_tender_sales=?6,
                repair_cash_sales=?7, repair_card_sales=?8,
                repair_orders_count=?9, repair_projection_version=?10,
                repair_projection_synced_at=?11, updated_at=?11
          WHERE id=?1 AND COALESCE(repair_projection_version, 0) < ?10",
        params![
            projection.staff_shift_id,
            projection.overall_tender,
            projection.overall_cash,
            projection.overall_card,
            projection.overall_orders_count,
            projection.repair_tender,
            projection.repair_cash,
            projection.repair_card,
            projection.repair_orders_count,
            projection.projection_version,
            projection.projected_at,
        ],
    )
    .map_err(|error| format!("apply repair reporting projection: {error}"))?;
    Ok(serde_json::json!({ "applied": true, "wasReplay": false }))
}

/// Mark the affected active shift as requiring a fresh server-authored
/// projection after the remote money transaction committed but its evidence
/// could not be cached locally. No monetary value is reconstructed here.
pub fn invalidate_repair_reporting_projection(
    db: &DbState,
    staff_shift_id: Option<&str>,
) -> Result<bool, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "repair reporting database unavailable".to_string())?;
    let updated = if let Some(shift_id) = staff_shift_id {
        if shift_id.trim().is_empty() || shift_id.len() > 128 {
            return Err("REPAIR_REPORTING_SHIFT_INVALID".to_string());
        }
        conn.execute(
            "UPDATE staff_shifts
                SET repair_projection_version = MAX(
                      COALESCE(repair_projection_version, 0), 1
                    ),
                    repair_projection_synced_at = NULL,
                    updated_at = datetime('now')
              WHERE id = ?1",
            [shift_id],
        )
    } else {
        conn.execute(
            "UPDATE staff_shifts
                SET repair_projection_version = MAX(
                      COALESCE(repair_projection_version, 0), 1
                    ),
                    repair_projection_synced_at = NULL,
                    updated_at = datetime('now')
              WHERE status IN ('active', 'open')",
            [],
        )
    }
    .map_err(|error| format!("invalidate repair reporting projection: {error}"))?;
    Ok(updated > 0)
}

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

pub(crate) use payment_integrity::UnsettledPaymentBlocker;

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

fn report_date_for_business_window(period_start_at: &str, cutoff_at: &str) -> String {
    business_day::report_date_for_business_window(period_start_at, cutoff_at)
}

fn active_window_report_date(period_start_at: &str, fallback_now: &str) -> String {
    report_date_for_business_window(period_start_at, fallback_now)
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

fn synthesize_pending_z_report_context_at(
    conn: &Connection,
    branch_id: &str,
    now: DateTime<Local>,
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
        let current_business_day = business_day::current_business_day_report_date_at(conn, now);

        // Only synthesize a pending context for shifts from a previous
        // business day. Same-business-day shifts should not lock the terminal.
        if report_date >= current_business_day {
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

fn load_pending_z_report_context_at(
    conn: &Connection,
    branch_id: &str,
    now: DateTime<Local>,
) -> Option<PendingZReportContext> {
    let current_business_day = business_day::current_business_day_report_date_at(conn, now);

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

        // A stored context for the current business day (or later) is not
        // actionable yet — the business day is still in progress.
        if stored.report_date >= current_business_day {
            let _ = clear_pending_z_report_context(conn);
            return None;
        }

        let normalized_period_start =
            resolve_period_start_at(conn, branch_id, Some(stored.cutoff_at.as_str()));
        let normalized_report_date =
            report_date_for_business_window(&normalized_period_start, &stored.cutoff_at);
        if stored.period_start_at != normalized_period_start
            || stored.report_date != normalized_report_date
        {
            stored.period_start_at = normalized_period_start;
            stored.report_date = normalized_report_date;
            let _ = persist_pending_z_report_context(conn, &stored);
        }

        return Some(stored);
    }

    synthesize_pending_z_report_context_at(conn, branch_id, now)
}

fn load_pending_z_report_context(
    conn: &Connection,
    branch_id: &str,
) -> Option<PendingZReportContext> {
    load_pending_z_report_context_at(conn, branch_id, Local::now())
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

fn resolve_current_z_report_window(conn: &Connection, branch_id: &str) -> EffectiveZReportWindow {
    let lower_bound_mode = resolve_lower_bound_mode(conn);

    if let Some(context) = load_pending_z_report_context(conn, branch_id) {
        return EffectiveZReportWindow {
            report_date: context.report_date,
            period_start_at: context.period_start_at,
            cutoff_at: Some(context.cutoff_at),
            lower_bound_mode,
        };
    }

    let period_start_at = resolve_period_start_at(conn, branch_id, None);
    let fallback_now = Utc::now().to_rfc3339();
    EffectiveZReportWindow {
        report_date: active_window_report_date(&period_start_at, &fallback_now),
        period_start_at,
        cutoff_at: None,
        lower_bound_mode,
    }
}

fn resolve_effective_z_report_window(
    conn: &Connection,
    branch_id: &str,
    payload: &Value,
) -> EffectiveZReportWindow {
    let mut window = resolve_current_z_report_window(conn, branch_id);

    // A frozen closeout context always owns its business date. Otherwise the
    // date picker may select a historical report for preview, while the
    // period bounds continue to describe the current live window.
    if window.cutoff_at.is_none() {
        if let Some(requested_date) = str_field(payload, "date") {
            window.report_date = requested_date;
        }
    }

    window
}

fn canonicalize_report_json_report_date(report_json: &mut Value, report_date: &str) {
    if let Some(obj) = report_json.as_object_mut() {
        obj.insert("date".to_string(), Value::String(report_date.to_string()));
        obj.insert(
            "reportDate".to_string(),
            Value::String(report_date.to_string()),
        );
        obj.insert(
            "report_date".to_string(),
            Value::String(report_date.to_string()),
        );
    }
}

pub(crate) fn repair_retryable_z_report_business_dates(db: &DbState) -> Result<usize, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut repaired = 0usize;

    // Wave 5 Session 6: z-report sync rows now live on parity_sync_queue.
    // The repair JOIN and subsequent UPDATE target parity columns
    // (`data` instead of `payload`, `attempts` instead of `retry_count`,
    // `error_message` instead of `last_error`, `last_attempt` instead of
    // `updated_at`). Parity uses 'processing' where legacy used 'in_progress'.
    let mut stmt = conn
        .prepare(
            "SELECT zr.id, zr.report_date, zr.report_json, sq.id, sq.status, COALESCE(sq.data, '')
             FROM z_reports zr
             JOIN parity_sync_queue sq
               ON sq.table_name = 'z_reports'
              AND sq.record_id = zr.id
             WHERE sq.status IN ('failed', 'pending', 'processing')
               AND COALESCE(zr.sync_state, '') != 'applied'
             ORDER BY zr.created_at ASC, zr.id ASC",
        )
        .map_err(|e| format!("prepare z-report business-date repair selector: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| format!("query z-report business-date repair selector: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect z-report business-date repair selector: {e}"))?;

    for (
        z_report_id,
        stored_report_date,
        report_json_str,
        queue_id,
        queue_status,
        queue_payload_str,
    ) in rows
    {
        let mut report_json = serde_json::from_str::<Value>(&report_json_str)
            .unwrap_or_else(|_| serde_json::json!({}));
        let mut sync_payload_value = serde_json::from_str::<Value>(&queue_payload_str)
            .unwrap_or_else(|_| serde_json::json!({}));
        let (period_start, period_end) = extract_period_bounds_from_report_json(&report_json);
        let Some(period_start) = period_start else {
            continue;
        };
        let fallback_end = period_end.as_deref().unwrap_or(now.as_str());
        let normalized_report_date = report_date_for_business_window(&period_start, fallback_end);

        if normalized_report_date == stored_report_date {
            continue;
        }

        canonicalize_report_json_report_date(&mut report_json, &normalized_report_date);
        if !sync_payload_value.is_object() {
            sync_payload_value = serde_json::json!({});
        }
        let terminal_id = str_field(&sync_payload_value, "terminal_id")
            .or_else(|| str_field(&sync_payload_value, "terminalId"))
            .or_else(|| storage::get_credential("terminal_id"))
            .unwrap_or_default();
        let branch_id = str_field(&sync_payload_value, "branch_id")
            .or_else(|| str_field(&sync_payload_value, "branchId"))
            .or_else(|| storage::get_credential("branch_id"))
            .unwrap_or_default();
        if let Some(sync_payload_obj) = sync_payload_value.as_object_mut() {
            sync_payload_obj.insert(
                "terminal_id".to_string(),
                Value::String(terminal_id.clone()),
            );
            sync_payload_obj.insert("branch_id".to_string(), Value::String(branch_id.clone()));
            sync_payload_obj.insert(
                "report_date".to_string(),
                Value::String(normalized_report_date.clone()),
            );
            sync_payload_obj.insert("report_data".to_string(), report_json.clone());
        }
        let sync_payload = sync_payload_value.to_string();

        conn.execute(
            "UPDATE z_reports
             SET report_date = ?2,
                 report_json = ?3,
                 sync_state = 'pending',
                 sync_retry_count = 0,
                 sync_last_error = NULL,
                 sync_next_retry_at = NULL,
                 updated_at = ?4
             WHERE id = ?1",
            params![
                z_report_id,
                normalized_report_date,
                report_json.to_string(),
                now
            ],
        )
        .map_err(|e| format!("update repaired z_report business date: {e}"))?;

        conn.execute(
            "UPDATE parity_sync_queue
             SET data = ?2,
                 status = 'pending',
                 attempts = 0,
                 error_message = NULL,
                 next_retry_at = NULL,
                 last_attempt = ?3
             WHERE id = ?1",
            params![queue_id, sync_payload, now],
        )
        .map_err(|e| format!("update repaired z-report parity queue data: {e}"))?;

        repaired += 1;
        info!(
            z_report_id = %z_report_id,
            previous_report_date = %stored_report_date,
            normalized_report_date = %normalized_report_date,
            previous_queue_status = %queue_status,
            "Repaired retryable z-report business-date mismatch"
        );
    }

    Ok(repaired)
}

fn load_unsettled_payment_blockers_for_window(
    conn: &Connection,
    branch_id: &str,
    window: &EffectiveZReportWindow,
) -> Result<Vec<UnsettledPaymentBlocker>, String> {
    let mut blockers = payment_integrity::load_branch_window_payment_blockers(
        conn,
        branch_id,
        window.period_start_at.as_str(),
        window.cutoff_at.as_deref(),
        window.lower_bound_mode == LowerBoundMode::Inclusive,
    )
    .map_err(|e| format!("load unsettled z-report payment blockers: {e}"))?;
    // Payments set aside as possible duplicates hold the day's close until a
    // manager decides (`payments_need_review`, Android 1.0.13 parity).
    blockers.extend(
        payment_integrity::load_payments_need_review_blockers(
            conn,
            branch_id,
            window.cutoff_at.as_deref(),
        )
        .map_err(|e| format!("load z-report payments needing review: {e}"))?,
    );
    // A card charged on this till whose payment could not be saved holds
    // every Z until it is saved or a manager records the money given back
    // (`payments_not_saved`, Android 1.0.13 parity).
    blockers.extend(
        payment_integrity::load_payments_not_saved_blockers(conn, branch_id)
            .map_err(|e| format!("load z-report charged payments not saved: {e}"))?,
    );
    Ok(blockers)
}

fn unsettled_payment_blocker_message(blockers: &[UnsettledPaymentBlocker]) -> Option<String> {
    payment_integrity::build_unsettled_payment_blocker_message("Cannot generate Z-report", blockers)
}

pub(crate) fn unsettled_payment_blockers(
    db: &DbState,
    payload: &Value,
) -> Result<Vec<UnsettledPaymentBlocker>, String> {
    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let _ = order_ownership::repair_historical_pickup_financial_attribution(
        &conn,
        branch_id.as_str(),
        &Utc::now().to_rfc3339(),
    )?;
    let window = resolve_effective_z_report_window(&conn, &branch_id, payload);
    load_unsettled_payment_blockers_for_window(&conn, &branch_id, &window)
}

/// The Z blocker for money this till recorded that has not reached the
/// server yet (sync blocker reason; the renderer localizes it).
pub(crate) const MONEY_NOT_SYNCED_REASON: &str = "money_not_synced";

/// Parity tables whose rows are money: payments, refunds/voids, staff cash
/// handbacks, driver earnings, shift expenses and staff payments.
const MONEY_PARITY_TABLES_SQL: &str = "('payments', 'order_payments', 'payment_adjustments', \
     'staff_order_cash_returns', 'driver_earnings', 'driver_earning', 'shift_expenses', \
     'staff_payments')";

/// One unsent money row whose local record the Z at `cutoff_at` closes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UnsyncedMoneyRow {
    pub queue_id: String,
    pub table_name: String,
    pub record_id: String,
    pub operation: String,
    pub status: String,
    pub error_message: Option<String>,
    pub order_id: Option<String>,
    pub order_number: Option<String>,
}

/// Every money row still in the parity queue (pending, processing, failed or
/// a conflict: a synced row leaves the queue) whose local record belongs to
/// the business window a Z at `cutoff_at` closes: an order the rollover
/// deletes (the same selector as `finalize_end_of_day_counts`), or a shift
/// expense / staff payment it deletes by its own timestamp.
///
/// Incident 06/10/2026: a refund queued at 01:36 was still unsent when the Z
/// ran at 01:38; the rollover deleted the refund and its payment, and the
/// server never got the refund. Repair-owned rows are excluded (repair
/// settlement orders are never rolled over), and so are rows whose local
/// record is already gone: nothing is left for this Z to delete, and the
/// queue's own failed or conflict state shows them.
pub(crate) fn load_unsynced_money_for_cutoff(
    conn: &Connection,
    cutoff_at: &str,
) -> Result<Vec<UnsyncedMoneyRow>, String> {
    let table_present = |table: &str| -> Result<bool, String> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| format!("inspect {table} for unsent money: {e}"))
    };
    if !table_present("parity_sync_queue")? || !table_present("orders")? {
        return Ok(Vec::new());
    }
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let open_table_tab = business_day::open_unsettled_table_tab_expr("o");
    let columns = "live.id, live.table_name, live.record_id, live.operation, live.status, \
                   live.error_message";
    let mut branches = Vec::new();
    if table_present("order_payments")? {
        branches.push(format!(
            "SELECT {columns}, w.id, w.order_number, live.created_at
             FROM live
             JOIN order_payments op ON op.id = live.record_id
             JOIN window_orders w ON w.id = op.order_id
             WHERE live.table_name IN ('payments', 'order_payments')"
        ));
    }
    if table_present("payment_adjustments")? && table_present("order_payments")? {
        branches.push(format!(
            "SELECT {columns}, w.id, w.order_number, live.created_at
             FROM live
             JOIN payment_adjustments pa ON pa.id = live.record_id
             LEFT JOIN order_payments pop ON pop.id = pa.payment_id
             JOIN window_orders w ON w.id = COALESCE(NULLIF(pa.order_id, ''), pop.order_id)
             WHERE live.table_name = 'payment_adjustments'"
        ));
    }
    if table_present("driver_earnings")? {
        branches.push(format!(
            "SELECT {columns}, w.id, w.order_number, live.created_at
             FROM live
             JOIN driver_earnings de ON de.id = live.record_id
             JOIN window_orders w ON w.id = de.order_id
             WHERE live.table_name IN ('driver_earnings', 'driver_earning')"
        ));
    }
    if table_present("staff_order_cash_returns")? {
        branches.push(format!(
            "SELECT {columns}, w.id, w.order_number, live.created_at
             FROM live
             JOIN staff_order_cash_returns cash_return ON cash_return.id = live.record_id
             JOIN window_orders w ON w.id = cash_return.order_id
             WHERE live.table_name = 'staff_order_cash_returns'"
        ));
    }
    if table_present("shift_expenses")? {
        branches.push(format!(
            "SELECT {columns}, NULL, NULL, live.created_at
             FROM live
             JOIN shift_expenses se ON se.id = live.record_id
             WHERE live.table_name = 'shift_expenses'
               AND datetime(se.created_at) <= datetime(?1)"
        ));
    }
    if table_present("staff_payments")? {
        branches.push(format!(
            "SELECT {columns}, NULL, NULL, live.created_at
             FROM live
             JOIN staff_payments sp ON sp.id = live.record_id
             WHERE live.table_name = 'staff_payments'
               AND datetime(sp.created_at) <= datetime(?1)"
        ));
    }
    if branches.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "WITH window_orders AS (
             SELECT o.id AS id, NULLIF(TRIM(COALESCE(o.order_number, '')), '') AS order_number
             FROM orders o
             WHERE datetime({financial_expr}) <= datetime(?1)
               AND COALESCE(o.order_context, '') <> 'repair_settlement'
               AND NOT {open_table_tab}
         ),
         live AS (
             SELECT q.id, q.table_name, q.record_id, q.operation, q.status, q.error_message,
                    q.created_at
             FROM parity_sync_queue q
             WHERE q.table_name IN {MONEY_PARITY_TABLES_SQL}
               AND COALESCE(q.module_type, '') <> 'repairs'
         )
         {}
         ORDER BY 9, 1",
        branches.join("\n UNION ALL \n")
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare unsent money selector: {e}"))?;
    let rows = statement
        .query_map(params![cutoff_at], |row| {
            Ok(UnsyncedMoneyRow {
                queue_id: row.get(0)?,
                table_name: row.get(1)?,
                record_id: row.get(2)?,
                operation: row.get(3)?,
                status: row.get(4)?,
                error_message: row.get(5)?,
                order_id: row.get(6)?,
                order_number: row.get(7)?,
            })
        })
        .map_err(|e| format!("query unsent money: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read unsent money: {e}"))
}

/// The unsent money of the window the next Z closes on `branch_id` (its
/// frozen cutoff, or now for the live window). The pre-Z sync gate refuses
/// the close while this is not empty (`sync::capture_unsynced_sync_queue_snapshot`).
pub(crate) fn unsynced_money_in_closing_window(
    conn: &Connection,
    branch_id: &str,
) -> Result<Vec<UnsyncedMoneyRow>, String> {
    let window = resolve_current_z_report_window(conn, branch_id);
    let cutoff_at = window.cutoff_at.unwrap_or_else(|| Utc::now().to_rfc3339());
    load_unsynced_money_for_cutoff(conn, &cutoff_at)
}

fn load_active_staff_closeout_blockers(
    conn: &Connection,
    branch_id: &str,
    cutoff_at: Option<&str>,
) -> Result<Vec<Value>, String> {
    let cutoff_param = cutoff_at.map(str::to_string);
    let mut stmt = conn
        .prepare(
            "SELECT
                 id,
                 staff_id,
                 COALESCE(NULLIF(TRIM(staff_name), ''), staff_id),
                 role_type,
                 terminal_id,
                 check_in_time
             FROM staff_shifts
             -- Same `?1 = ''` wildcard as the submission gate in
             -- prepare_z_report_submission: these two must agree, or the
             -- readiness panel shows a clean day that the submit then rejects.
             WHERE status = 'active'
               AND (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
               AND (?2 IS NULL OR check_in_time <= ?2)
             ORDER BY COALESCE(check_in_time, created_at, updated_at) ASC, id ASC",
        )
        .map_err(|e| format!("prepare active closeout staff blockers: {e}"))?;
    let rows = stmt
        .query_map(params![branch_id, cutoff_param], |row| {
            Ok(serde_json::json!({
                "shiftId": row.get::<_, String>(0)?,
                "staffId": row.get::<_, String>(1)?,
                "staffName": row.get::<_, String>(2)?,
                "roleType": row.get::<_, String>(3)?,
                "terminalId": row.get::<_, Option<String>>(4)?,
                "checkInTime": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| format!("query active closeout staff blockers: {e}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

// ---------------------------------------------------------------------------
// Fiscal close-day scope and the last closeout attempt (29/09/2026)
// ---------------------------------------------------------------------------

/// The branch a closeout call is about: the payload's, else this terminal's.
pub(crate) fn resolve_closeout_branch_id(payload: &Value) -> String {
    str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default())
}

/// The window the fiscal close-day guard checks: exactly the window the next
/// Z submission closes (`resolve_current_z_report_window`, live or frozen),
/// never a date the picker chose and never today's UTC date.
pub(crate) fn current_fiscal_close_scope(
    conn: &Connection,
    branch_id: &str,
) -> crate::fiscal::close_day_guard::FiscalCloseScope {
    let window = resolve_current_z_report_window(conn, branch_id);
    crate::fiscal::close_day_guard::FiscalCloseScope {
        branch_id: branch_id.to_string(),
        report_date: window.report_date,
        period_start_at: window.period_start_at,
        cutoff_at: window.cutoff_at,
        lower_bound_inclusive: window.lower_bound_mode == LowerBoundMode::Inclusive,
    }
}

/// The queued fiscal receipts of the window the next Z closes, and whether
/// they hold it (shown by the Z preview before the cashier confirms).
pub(crate) fn fiscal_queue_blockers_for_closeout(
    db: &DbState,
    payload: &Value,
) -> Result<crate::fiscal::close_day_guard::FiscalQueueBlockers, String> {
    let branch_id = resolve_closeout_branch_id(payload);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let scope = current_fiscal_close_scope(&conn, &branch_id);
    crate::fiscal::close_day_guard::collect_fiscal_queue_blockers(&conn, &scope)
}

/// The typed refusal of a Z submission while the window's fiscal receipts
/// are still queued under an active (or unknown) plugin; `None` lets the
/// close continue.
pub(crate) fn fiscal_close_blocked_response(
    db: &DbState,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let branch_id = resolve_closeout_branch_id(payload);
    if branch_id.trim().is_empty() {
        // Rows are matched by branch; without one there is nothing to hold.
        warn!("Z-report fiscal guard skipped: no branch for this terminal");
        return Ok(None);
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let scope = current_fiscal_close_scope(&conn, &branch_id);
    match crate::fiscal::close_day_guard::ensure_no_queued_fiscal_for_window(&conn, &scope) {
        Ok(()) => Ok(None),
        Err(blocked) => Ok(Some(blocked.to_response())),
    }
}

const LAST_CLOSEOUT_ATTEMPT_CATEGORY: &str = "diagnostics";
const LAST_CLOSEOUT_ATTEMPT_KEY: &str = "last_closeout_attempt";

/// How the last Z submission on this terminal ended, for support
/// (`closeout_readiness.json` → `lastCloseoutAttempt`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseoutAttempt {
    /// When the attempt ended (RFC 3339).
    pub at: String,
    /// The step it reached: `pre_z_sync`, `sync_blocked`,
    /// `payment_blockers`, `fiscal_guard`, `prepare`, `post_submission_sync`,
    /// `finalize` or `submitted`.
    pub stage: String,
    /// `SUBMITTED`, the refusal's `errorCode`, or `ERROR`.
    pub code: String,
    /// Bounded, sanitized operational text; never customer data.
    pub message: Option<String>,
}

pub(crate) fn record_last_closeout_attempt(
    conn: &Connection,
    attempt: &CloseoutAttempt,
) -> Result<(), String> {
    let encoded = serde_json::to_string(attempt)
        .map_err(|e| format!("serialize last closeout attempt: {e}"))?;
    db::set_setting(
        conn,
        LAST_CLOSEOUT_ATTEMPT_CATEGORY,
        LAST_CLOSEOUT_ATTEMPT_KEY,
        &encoded,
    )
}

pub(crate) fn load_last_closeout_attempt(conn: &Connection) -> Option<CloseoutAttempt> {
    let raw = db::get_setting(
        conn,
        LAST_CLOSEOUT_ATTEMPT_CATEGORY,
        LAST_CLOSEOUT_ATTEMPT_KEY,
    )?;
    serde_json::from_str(&raw).ok()
}

/// Map a Z submission's result onto the attempt record: a typed refusal
/// keeps its `errorCode`, success is `SUBMITTED`, an error is `ERROR`.
pub(crate) fn closeout_attempt_from_result(
    stage: &str,
    result: &Result<Value, String>,
    at: &str,
) -> CloseoutAttempt {
    let bounded = |text: Option<String>| crate::print::safe_operational_error(text, 512);
    let (code, message) = match result {
        Ok(value) if value.get("success").and_then(Value::as_bool) == Some(false) => (
            value
                .get("errorCode")
                .and_then(Value::as_str)
                .filter(|code| !code.trim().is_empty())
                .unwrap_or("BLOCKED")
                .to_string(),
            bounded(
                value
                    .get("message")
                    .or_else(|| value.get("error"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            ),
        ),
        Ok(_) => ("SUBMITTED".to_string(), None),
        Err(error) => ("ERROR".to_string(), bounded(Some(error.clone()))),
    };
    CloseoutAttempt {
        at: at.to_string(),
        stage: stage.to_string(),
        code,
        message,
    }
}

pub(crate) fn get_closeout_readiness_snapshot(
    db: &DbState,
    payload: &Value,
) -> Result<Value, String> {
    let branch_id = resolve_closeout_branch_id(payload);

    let (window, active_staff_blockers, payment_blockers, gift_close, last_z_report) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let window = resolve_effective_z_report_window(&conn, &branch_id, payload);
        let active_staff_blockers =
            load_active_staff_closeout_blockers(&conn, &branch_id, window.cutoff_at.as_deref())?;
        let payment_blockers =
            load_unsettled_payment_blockers_for_window(&conn, &branch_id, &window)?;
        let gift_close = load_gift_close_report_for_effective_window(&conn, &branch_id, &window)?;
        let last_z_report = conn
            .query_row(
                // W4b-iii: cents-with-real-fallback shim (removed in 4e).
                "SELECT id, shift_id, generated_at, sync_state,
                        COALESCE(gross_sales_cents, CAST(ROUND(gross_sales * 100) AS INTEGER), 0),
                        COALESCE(net_sales_cents, CAST(ROUND(net_sales * 100) AS INTEGER), 0)
                 FROM z_reports
                 ORDER BY generated_at DESC
                 LIMIT 1",
                [],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "shiftId": row.get::<_, String>(1)?,
                        "generatedAt": row.get::<_, String>(2)?,
                        "syncState": row.get::<_, String>(3)?,
                        "totalGrossSales": Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
                        "totalNetSales": Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                    }))
                },
            )
            .optional()
            .map_err(|e| format!("load latest z-report for closeout readiness: {e}"))?
            .unwrap_or(Value::Null);
        (
            window,
            active_staff_blockers,
            payment_blockers,
            gift_close,
            last_z_report,
        )
    };

    let sync_snapshot = crate::sync::capture_unsynced_sync_queue_snapshot(db)?;
    let lower_bound_mode = match window.lower_bound_mode {
        LowerBoundMode::Inclusive => "inclusive",
        LowerBoundMode::Exclusive => "exclusive",
    };
    let payment_blocker_message = unsettled_payment_blocker_message(&payment_blockers);

    // The fiscal close-day guard's evidence (29/09/2026: a Z refused over
    // fiscal rows while the support bundle said nothing about them), and how
    // the last Z attempt ended. A read that fails says so; it never reads as
    // "nothing queued".
    let (fiscal_queue_blockers, last_closeout_attempt) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let fiscal = if branch_id.trim().is_empty() {
            serde_json::json!({ "status": "not_collected", "reason": "branch unknown" })
        } else {
            let scope = current_fiscal_close_scope(&conn, &branch_id);
            crate::fiscal::close_day_guard::fiscal_queue_evidence(&conn, &scope).unwrap_or_else(
                |error| {
                    serde_json::json!({
                        "status": "unavailable",
                        "error": crate::print::safe_operational_error(Some(error), 512),
                    })
                },
            )
        };
        let last_attempt = load_last_closeout_attempt(&conn)
            .and_then(|attempt| serde_json::to_value(attempt).ok())
            .unwrap_or_else(|| {
                serde_json::json!({
                    "status": "not_collected",
                    "reason": "no closeout attempt recorded on this terminal",
                })
            });
        (fiscal, last_attempt)
    };

    Ok(serde_json::json!({
        "branchId": if branch_id.trim().is_empty() { Value::Null } else { Value::String(branch_id) },
        "window": {
            "reportDate": window.report_date,
            "periodStartAt": window.period_start_at,
            "cutoffAt": window.cutoff_at,
            "lowerBoundMode": lower_bound_mode,
        },
        "activeStaffBlockers": {
            "count": active_staff_blockers.len(),
            "details": active_staff_blockers,
        },
        "unsettledPaymentBlockers": {
            "count": payment_blockers.len(),
            "message": payment_blocker_message,
            "details": payment_blockers,
        },
        "unsyncedSyncQueue": {
            "count": sync_snapshot.count,
            "blockersSummary": sync_snapshot.blockers_summary,
            "details": sync_snapshot.blocker_details,
        },
        "fiscalQueueBlockers": fiscal_queue_blockers,
        // Gift-bound drawer closes: adopted canonical proof, independent of the
        // generic queue count above. An adopted original's queue item is
        // consumed with its adoption; unrelated ordinary work stays counted.
        "giftCloseProof": gift_close.readiness_value(),
        "lastZReport": last_z_report,
        "lastCloseoutAttempt": last_closeout_attempt,
    }))
}

// ---------------------------------------------------------------------------
// Gift-bound drawer close: frozen report projection and finalization gate
// ---------------------------------------------------------------------------
//
// A cashier drawer opened through a persisted `gift_financial_openings` row is
// a gift-bound original (module entitlement is never consulted). Once closed,
// its only reportable figures are the adopted `gift_closing_v1` proof read
// through `gift_financial_closing::load_adopted`: canonical ordinary expected +
// gift liability cash = expected, the original count and the canonical
// variance. The journal's own `drawer` is the local preview and is not read.
// Gift liability cash is a drawer movement, never sales, tender, tax or fiscal
// revenue. A report is persisted, submitted or rolled over only when every
// closed original in its window and scope carries that proof; the projection
// is then frozen into the stored `report_json` once and never recomputed.

const GIFT_CLOSE_REPORT_KEY: &str = "giftFinancialClose";
const GIFT_CLOSE_REPORT_CONTRACT: &str = "gift_close_report_v1";
const GIFT_CLOSE_PROOF_REQUIRED: &str = "GIFT_CLOSE_PROOF_REQUIRED";
const GIFT_CLOSE_PROOF_PENDING: &str = "GIFT_CLOSE_PROOF_PENDING";
const GIFT_CLOSE_PROOF_UNAVAILABLE: &str = "GIFT_CLOSE_PROOF_UNAVAILABLE";
const GIFT_CLOSE_PROOF_MISMATCH: &str = "GIFT_CLOSE_PROOF_MISMATCH";
const GIFT_CLOSE_JOURNAL_MISSING: &str = "GIFT_CLOSE_JOURNAL_MISSING";
const GIFT_OPENING_UNCONFIRMED: &str = "GIFT_OPENING_UNCONFIRMED";
const GIFT_CLOSE_SNAPSHOT_STALE: &str = "GIFT_CLOSE_SNAPSHOT_STALE";

/// One closed gift-bound original with its adopted canonical close.
#[derive(Clone, Debug, PartialEq, Eq)]
struct GiftCloseReportRow {
    shift_id: String,
    drawer_id: String,
    staff_id: String,
    staff_name: Option<String>,
    terminal_id: String,
    currency: String,
    ordinary_expected_cents: i64,
    gift_cash_cents: i64,
    expected_cents: i64,
    counted_cents: i64,
    variance_cents: i64,
    /// Canonical ordinary expected minus the drawer's own local ordinary
    /// components (normally 0), so a listed drawer equation still sums to the
    /// canonical expected.
    ordinary_adjustment_cents: i64,
    drawer_version: i64,
    local_closed_at: String,
    canonical_closed_at: String,
    confirmed_at: String,
    adopted_at: String,
}

/// A closed gift-bound original without usable confirmed proof. It blocks
/// final persistence, submission and rollover.
#[derive(Clone, Debug, PartialEq, Eq)]
struct GiftCloseBlocker {
    code: &'static str,
    shift_id: String,
    drawer_id: String,
    staff_id: String,
    staff_name: Option<String>,
    pending_reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct GiftCloseReport {
    originals: Vec<GiftCloseReportRow>,
    blockers: Vec<GiftCloseBlocker>,
}

fn gift_cents_value(cents: i64) -> Value {
    serde_json::json!(Cents::new(cents).to_f64_dp2())
}

impl GiftCloseReportRow {
    fn to_value(&self) -> Value {
        serde_json::json!({
            "shiftId": self.shift_id,
            "drawerId": self.drawer_id,
            "staffId": self.staff_id,
            "staffName": self.staff_name,
            "terminalId": self.terminal_id,
            "currency": self.currency,
            "ordinaryExpected": gift_cents_value(self.ordinary_expected_cents),
            "ordinaryExpected_cents": self.ordinary_expected_cents,
            "giftLiabilityCash": gift_cents_value(self.gift_cash_cents),
            "giftLiabilityCash_cents": self.gift_cash_cents,
            "expected": gift_cents_value(self.expected_cents),
            "expected_cents": self.expected_cents,
            "counted": gift_cents_value(self.counted_cents),
            "counted_cents": self.counted_cents,
            "variance": gift_cents_value(self.variance_cents),
            "variance_cents": self.variance_cents,
            "ordinaryAdjustment_cents": self.ordinary_adjustment_cents,
            "drawerVersion": self.drawer_version,
            "provenance": {
                "contract": crate::gift_financial_closing::GIFT_CARD_CLOSING_CONTRACT,
                "status": "confirmed",
                "localClosedAt": self.local_closed_at,
                "canonicalClosedAt": self.canonical_closed_at,
                "confirmedAt": self.confirmed_at,
                "adoptedAt": self.adopted_at,
            },
        })
    }
}

impl GiftCloseBlocker {
    fn to_value(&self) -> Value {
        serde_json::json!({
            "code": self.code,
            "shiftId": self.shift_id,
            "drawerId": self.drawer_id,
            "staffId": self.staff_id,
            "staffName": self.staff_name,
            "pendingReason": self.pending_reason,
        })
    }
}

impl GiftCloseReport {
    fn is_empty(&self) -> bool {
        self.originals.is_empty() && self.blockers.is_empty()
    }

    fn is_ready(&self) -> bool {
        self.blockers.is_empty()
    }

    fn gift_cash_cents(&self) -> i64 {
        self.originals.iter().map(|row| row.gift_cash_cents).sum()
    }

    fn ordinary_adjustment_cents(&self) -> i64 {
        self.originals
            .iter()
            .map(|row| row.ordinary_adjustment_cents)
            .sum()
    }

    fn blocker_message(&self) -> Option<String> {
        if self.blockers.is_empty() {
            return None;
        }
        let details = self
            .blockers
            .iter()
            .map(|blocker| {
                format!(
                    "{} ({} for shift {})",
                    blocker
                        .staff_name
                        .as_deref()
                        .unwrap_or(blocker.staff_id.as_str()),
                    blocker.code,
                    blocker.shift_id
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        Some(format!(
            "{GIFT_CLOSE_PROOF_REQUIRED}: Cannot generate Z-report: {} gift-bound drawer close(s) lack confirmed canonical proof: {details}",
            self.blockers.len()
        ))
    }

    /// Nonsecret readiness block for the closeout checklist and previews.
    fn readiness_value(&self) -> Value {
        serde_json::json!({
            "ready": self.is_ready(),
            "count": self.blockers.len(),
            "confirmedCount": self.originals.len(),
            "message": self.blocker_message(),
            "details": self.blockers.iter().map(GiftCloseBlocker::to_value).collect::<Vec<_>>(),
        })
    }

    /// The frozen `report_json` block, stored once with the report.
    fn projection_value(&self) -> Value {
        let gift = self.gift_cash_cents();
        let adjustment = self.ordinary_adjustment_cents();
        serde_json::json!({
            "contract": GIFT_CLOSE_REPORT_CONTRACT,
            "ready": self.is_ready(),
            "giftLiabilityCash": gift_cents_value(gift),
            "giftLiabilityCash_cents": gift,
            "ordinaryAdjustment": gift_cents_value(adjustment),
            "ordinaryAdjustment_cents": adjustment,
            "originals": self.originals.iter().map(GiftCloseReportRow::to_value).collect::<Vec<_>>(),
            "blockers": self.blockers.iter().map(GiftCloseBlocker::to_value).collect::<Vec<_>>(),
        })
    }

    /// Adds the separate gift liability row to a drawer equation whose
    /// `expected` already carries the canonical total.
    fn annotate_drawer(&self, drawer: &mut Value, expected_cents: i64) {
        let Some(obj) = drawer.as_object_mut() else {
            return;
        };
        let gift = self.gift_cash_cents();
        for (key, cents) in [
            ("ordinaryExpected", expected_cents - gift),
            ("giftLiabilityCash", gift),
            ("ordinaryAdjustment", self.ordinary_adjustment_cents()),
        ] {
            obj.insert(key.to_string(), gift_cents_value(cents));
            obj.insert(format!("{key}_cents"), serde_json::json!(cents));
        }
    }
}

/// The drawer's own ordinary cash equation in cents (never its stored
/// expected), the same components the date aggregate sums.
fn drawer_ordinary_components_cents_expr(alias: &str) -> String {
    let money = |column: &str| drawer_money_cents_expr(Some(alias), column);
    format!(
        "({} + {} - {} - {} - {} - {} - {} + {})",
        money("opening_amount"),
        money("total_cash_sales"),
        money("total_refunds"),
        money("total_expenses"),
        money("total_staff_payments"),
        money("cash_drops"),
        money("driver_cash_given"),
        money("driver_cash_returned"),
    )
}

struct GiftOpeningCandidate {
    opening_key: String,
    opening_state: String,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    staff_id: String,
    staff_name: Option<String>,
    shift_id: String,
    drawer_id: String,
    shift_status: Option<String>,
    drawer_present: bool,
    drawer_closed_at: Option<String>,
    drawer_closing_cents: Option<i64>,
    drawer_expected_cents: Option<i64>,
    drawer_ordinary_cents: Option<i64>,
    drawer_branch_id: Option<String>,
}

fn load_gift_opening_candidates(
    conn: &Connection,
    scope_sql: &str,
    scope_params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<GiftOpeningCandidate>, String> {
    let ordinary_expr = drawer_ordinary_components_cents_expr("cds");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT o.opening_key, o.state, o.organization_id, o.branch_id,
                    o.terminal_id, o.staff_id,
                    COALESCE(NULLIF(TRIM(ss.staff_name), ''), NULLIF(TRIM(o.staff_name), '')),
                    o.shift_id, o.drawer_id, ss.status, cds.id IS NOT NULL, cds.closed_at,
                    COALESCE(cds.closing_amount_cents, CAST(ROUND(cds.closing_amount * 100) AS INTEGER)),
                    COALESCE(cds.expected_amount_cents, CAST(ROUND(cds.expected_amount * 100) AS INTEGER)),
                    CASE WHEN cds.id IS NULL THEN NULL ELSE {ordinary_expr} END,
                    cds.branch_id
               FROM gift_financial_openings o
               LEFT JOIN staff_shifts ss ON ss.id = o.shift_id
               LEFT JOIN cash_drawer_sessions cds ON cds.id = o.drawer_id
              WHERE {scope_sql}
              ORDER BY COALESCE(cds.opened_at, ss.check_in_time, o.checked_in_at) ASC,
                       o.opening_key ASC"
        ))
        .map_err(|e| format!("prepare gift close report candidates: {e}"))?;
    let rows = stmt
        .query_map(scope_params, |row| {
            Ok(GiftOpeningCandidate {
                opening_key: row.get(0)?,
                opening_state: row.get(1)?,
                organization_id: row.get(2)?,
                branch_id: row.get(3)?,
                terminal_id: row.get(4)?,
                staff_id: row.get(5)?,
                staff_name: row.get(6)?,
                shift_id: row.get(7)?,
                drawer_id: row.get(8)?,
                shift_status: row.get(9)?,
                drawer_present: row.get::<_, i64>(10)? != 0,
                drawer_closed_at: row.get(11)?,
                drawer_closing_cents: row.get(12)?,
                drawer_expected_cents: row.get(13)?,
                drawer_ordinary_cents: row.get(14)?,
                drawer_branch_id: row.get(15)?,
            })
        })
        .map_err(|e| format!("query gift close report candidates: {e}"))?;
    // A gate must never silently drop an unreadable original.
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read gift close report candidates: {e}"))
}

/// Gift-bound originals whose drawer (else shift, else opening) falls in the
/// report window and branch scope, with the same bounds as the drawer rows.
fn load_gift_close_report_for_window(
    conn: &Connection,
    branch_id: &str,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
) -> Result<GiftCloseReport, String> {
    let anchor = "COALESCE(cds.opened_at, ss.check_in_time, o.checked_in_at)";
    let scope_sql = format!(
        "{} AND (?2 IS NULL OR {anchor} <= ?2)
         AND (?3 = '' OR lower(o.branch_id) = lower(?3) OR lower(cds.branch_id) = lower(?3))",
        lower_bound_mode.sql_predicate(anchor, "?1")
    );
    let candidates = load_gift_opening_candidates(
        conn,
        &scope_sql,
        params![period_start, cutoff_at, branch_id],
    )?;
    classify_gift_close_candidates(conn, candidates, branch_id)
}

fn load_gift_close_report_for_effective_window(
    conn: &Connection,
    branch_id: &str,
    window: &EffectiveZReportWindow,
) -> Result<GiftCloseReport, String> {
    load_gift_close_report_for_window(
        conn,
        branch_id,
        window.period_start_at.as_str(),
        window.cutoff_at.as_deref(),
        window.lower_bound_mode,
    )
}

fn load_gift_close_report_for_shift(
    conn: &Connection,
    shift_id: &str,
) -> Result<GiftCloseReport, String> {
    let candidates = load_gift_opening_candidates(conn, "o.shift_id = ?1", params![shift_id])?;
    classify_gift_close_candidates(conn, candidates, "")
}

fn same_gift_id(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

/// Every closed original needs its matching confirmed canonical close; the
/// sync queue is never evidence (a missing journal or an already consumed
/// queue item still blocks). Open drawers stay the active-staff gate's concern.
fn classify_gift_close_candidates(
    conn: &Connection,
    candidates: Vec<GiftOpeningCandidate>,
    scope_branch_id: &str,
) -> Result<GiftCloseReport, String> {
    use crate::gift_financial_closing::{self as closing, ClosingState};

    let mut report = GiftCloseReport::default();
    for candidate in candidates {
        let closed = candidate
            .shift_status
            .as_deref()
            .is_some_and(|status| status != "active")
            || candidate
                .drawer_closed_at
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || (candidate.shift_status.is_none() && !candidate.drawer_present);
        if !closed {
            continue;
        }
        let blocker = |code: &'static str, pending_reason: Option<String>| GiftCloseBlocker {
            code,
            shift_id: candidate.shift_id.clone(),
            drawer_id: candidate.drawer_id.clone(),
            staff_id: candidate.staff_id.clone(),
            staff_name: candidate.staff_name.clone(),
            pending_reason,
        };

        let Ok(original) = closing::load_original_for_opening(conn, &candidate.opening_key) else {
            report
                .blockers
                .push(blocker(GIFT_CLOSE_PROOF_UNAVAILABLE, None));
            continue;
        };
        let Some(original) = original else {
            let other_journals: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM gift_financial_closings
                      WHERE shift_id = ?1 OR drawer_id = ?2",
                    params![candidate.shift_id, candidate.drawer_id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("read gift close journal scope: {e}"))?;
            let code = if other_journals > 0 {
                Some(GIFT_CLOSE_PROOF_MISMATCH)
            } else {
                match candidate.opening_state.as_str() {
                    "pending" => Some(GIFT_OPENING_UNCONFIRMED),
                    // Persisted opening identity also governs native close capture.
                    // Zero or unreadable gift cash cannot prove an ordinary close.
                    "confirmed_usable" | "confirmed_unusable" => Some(GIFT_CLOSE_JOURNAL_MISSING),
                    _ => Some(GIFT_CLOSE_PROOF_UNAVAILABLE),
                }
            };
            if let Some(code) = code {
                report.blockers.push(blocker(code, None));
            }
            continue;
        };

        let journal_in_scope = original.shift_id == candidate.shift_id
            && original.drawer_id == candidate.drawer_id
            && original.terminal_id == candidate.terminal_id
            && same_gift_id(&original.organization_id, &candidate.organization_id)
            && same_gift_id(&original.staff_id, &candidate.staff_id)
            && same_gift_id(&original.branch_id, &candidate.branch_id)
            && (scope_branch_id.is_empty() || same_gift_id(&original.branch_id, scope_branch_id));
        if !journal_in_scope {
            report
                .blockers
                .push(blocker(GIFT_CLOSE_PROOF_MISMATCH, None));
            continue;
        }
        if original.state == ClosingState::Pending {
            report.blockers.push(blocker(
                GIFT_CLOSE_PROOF_PENDING,
                original.pending_reason.clone(),
            ));
            continue;
        }
        let adopted = match closing::load_adopted(conn, &original.closing_key) {
            Ok(Some(adopted)) => adopted,
            Ok(None) | Err(_) => {
                report
                    .blockers
                    .push(blocker(GIFT_CLOSE_PROOF_UNAVAILABLE, None));
                continue;
            }
        };
        let proof = &adopted.proof;
        let proof_in_scope = same_gift_id(&proof.shift_id, &candidate.shift_id)
            && same_gift_id(&proof.drawer_id, &candidate.drawer_id)
            && same_gift_id(&proof.branch_id, &candidate.branch_id);
        // The adopted mirror must still hold the proof: an ordinary repair or
        // auto-close must never replace the gift original's count or expected.
        let mirror_holds_proof = candidate.drawer_closing_cents == Some(adopted.counted_cents())
            && candidate.drawer_expected_cents == Some(adopted.expected_cents())
            && candidate
                .drawer_branch_id
                .as_deref()
                .map_or(true, |branch| same_gift_id(branch, &candidate.branch_id));
        let Some(local_ordinary_cents) = candidate
            .drawer_ordinary_cents
            .filter(|_| proof_in_scope && mirror_holds_proof)
        else {
            report
                .blockers
                .push(blocker(GIFT_CLOSE_PROOF_MISMATCH, None));
            continue;
        };
        report.originals.push(GiftCloseReportRow {
            shift_id: candidate.shift_id.clone(),
            drawer_id: candidate.drawer_id.clone(),
            staff_id: candidate.staff_id.clone(),
            staff_name: candidate.staff_name.clone(),
            terminal_id: proof.terminal_id.clone(),
            currency: proof.currency.clone(),
            ordinary_expected_cents: proof.drawer.ordinary_expected_cents,
            gift_cash_cents: proof.drawer.gift_cash_cents,
            expected_cents: adopted.expected_cents(),
            counted_cents: adopted.counted_cents(),
            variance_cents: adopted.variance_cents(),
            ordinary_adjustment_cents: proof.drawer.ordinary_expected_cents - local_ordinary_cents,
            drawer_version: proof.drawer.version,
            local_closed_at: adopted.original.closed_at.clone(),
            canonical_closed_at: adopted.canonical_closed_at.clone(),
            confirmed_at: adopted.confirmed_at.clone(),
            adopted_at: adopted.adopted_at.clone(),
        });
    }
    Ok(report)
}

/// Refuses to reuse a stored report persisted before a gift-bound close in its
/// window was adopted; the stored report itself is never rewritten.
fn ensure_gift_close_snapshot_current(
    conn: &Connection,
    z_report_id: &str,
    current: &GiftCloseReport,
) -> Result<(), String> {
    if current.originals.is_empty() {
        return Ok(());
    }
    let stored: Option<String> = conn
        .query_row(
            "SELECT report_json FROM z_reports WHERE id = ?1",
            params![z_report_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|e| format!("load stored z-report gift close snapshot: {e}"))?
        .flatten();
    let frozen = stored
        .and_then(|json| serde_json::from_str::<Value>(&json).ok())
        .and_then(|json| json.get(GIFT_CLOSE_REPORT_KEY).cloned())
        .filter(|projection| {
            projection.get("contract").and_then(Value::as_str) == Some(GIFT_CLOSE_REPORT_CONTRACT)
                && projection.get("ready").and_then(Value::as_bool) == Some(true)
                && projection
                    .get("blockers")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
        });
    let frozen_rows = frozen
        .as_ref()
        .and_then(|projection| projection.get("originals"))
        .and_then(Value::as_array);
    // Presence of a drawer ID alone does not establish a final snapshot. Compare
    // immutable proof fields; staff names and the current ordinary-component
    // adjustment may change later without rewriting valid frozen history.
    const PROOF_FIELDS: &[&str] = &[
        "shiftId",
        "drawerId",
        "staffId",
        "terminalId",
        "currency",
        "drawerVersion",
        "ordinaryExpected",
        "ordinaryExpected_cents",
        "giftLiabilityCash",
        "giftLiabilityCash_cents",
        "expected",
        "expected_cents",
        "counted",
        "counted_cents",
        "variance",
        "variance_cents",
        "provenance",
    ];
    let missing = current
        .originals
        .iter()
        .filter(|row| {
            let expected = row.to_value();
            let Some(rows) = frozen_rows else { return true };
            let mut matching = rows.iter().filter(|stored| {
                stored.get("drawerId").and_then(Value::as_str) == Some(row.drawer_id.as_str())
            });
            let Some(stored) = matching.next() else {
                return true;
            };
            matching.next().is_some()
                || !PROOF_FIELDS
                    .iter()
                    .all(|key| stored.get(*key) == expected.get(*key))
        })
        .map(|row| row.shift_id.as_str())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{GIFT_CLOSE_SNAPSHOT_STALE}: Cannot reuse Z-report {z_report_id}: it was stored before the confirmed gift-bound close of shift(s) {} was adopted",
        missing.join(", ")
    ))
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

fn canonicalize_report_json_period(report_json: &mut Value, period_start: &str, period_end: &str) {
    if let Some(obj) = report_json.as_object_mut() {
        obj.insert(
            "period".to_string(),
            serde_json::json!({
                "start": period_start,
                "end": period_end,
            }),
        );
        obj.insert(
            "periodStart".to_string(),
            Value::String(period_start.to_string()),
        );
        obj.insert(
            "periodEnd".to_string(),
            Value::String(period_end.to_string()),
        );
    }
}

fn extract_period_bounds_from_report_json(report_json: &Value) -> (Option<String>, Option<String>) {
    (
        report_json
            .get("period")
            .and_then(|period| str_field(period, "start"))
            .or_else(|| str_field(report_json, "periodStart"))
            .or_else(|| str_field(report_json, "period_start")),
        report_json
            .get("period")
            .and_then(|period| str_field(period, "end"))
            .or_else(|| str_field(report_json, "periodEnd"))
            .or_else(|| str_field(report_json, "period_end")),
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

fn load_latest_local_z_report_for_report_date(
    conn: &Connection,
    branch_id: &str,
    report_date: &str,
) -> Result<Option<Value>, String> {
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id
             FROM z_reports
             WHERE report_date = ?1
               AND (branch_id = ?2 OR branch_id IS NULL)
             ORDER BY generated_at DESC, created_at DESC, id DESC
             LIMIT 1",
            params![report_date, branch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load existing z-report by date: {e}"))?;

    existing_id
        .map(|id| get_z_report_by_id(conn, &id))
        .transpose()
}

fn existing_response_from_local_z_report(report: Value) -> Value {
    serde_json::json!({
        "success": true,
        "preview": false,
        "existing": true,
        "report": report,
    })
}

fn load_existing_local_z_report_response(
    db: &DbState,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let requested_date = str_field(payload, "date");
    let Some(report_date) = requested_date else {
        return Ok(None);
    };

    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let current_window = resolve_current_z_report_window(&conn, branch_id.as_str());

    // A business date is not a report identity: a store may close more than
    // once on the same date. Never let the historical date lookup replace a
    // live/frozen window with an earlier report from that date.
    if current_window.cutoff_at.is_some() || current_window.report_date == report_date {
        return Ok(None);
    }

    load_latest_local_z_report_for_report_date(&conn, branch_id.as_str(), report_date.as_str())
        .map(|report| report.map(existing_response_from_local_z_report))
}

fn ensure_z_report_sync_queue_row(
    conn: &Connection,
    z_report_id: &str,
    sync_payload: &str,
    _now: &str,
) -> Result<(), String> {
    // Wave 5 Session 6: convert the legacy UPSERT pattern into a clear-and-
    // insert on parity_sync_queue. Admin-server dedup is driven by the
    // business key (`z_report_id` + `shift_id` inside report_data), so a
    // fresh parity row with the synthetic `entity:z_reports:{id}` key is
    // still exactly-once equivalent to the legacy `zreport:{id}` key.
    //
    // If the legacy queue already has a `synced` row for this z-report we
    // stay idempotent and do nothing — matches the original skip-on-synced
    // fast path. We also scan parity's `conflict` status because the admin
    // may have flagged a prior attempt.
    let legacy_synced: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue
             WHERE entity_type = 'z_report' AND entity_id = ?1
               AND status IN ('synced', 'applied')",
            params![z_report_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if legacy_synced > 0 {
        return Ok(());
    }

    // Clear stale legacy rows so a drain doesn't race a resubmission with a
    // stale payload. Synced/applied rows are kept for audit history.
    conn.execute(
        "DELETE FROM sync_queue
         WHERE entity_type = 'z_report'
           AND entity_id = ?1
           AND status NOT IN ('synced', 'applied')",
        params![z_report_id],
    )
    .map_err(|e| format!("clear stale z-report legacy queue rows: {e}"))?;

    // Clear any lingering parity rows — the UPSERT semantic is "latest
    // payload wins" so the new row replaces prior unsynced attempts.
    sync_queue::clear_unsynced_items(conn, "z_reports", z_report_id)
        .map_err(|e| format!("clear stale z-report parity queue rows: {e}"))?;

    let sync_payload_value: Value = serde_json::from_str(sync_payload)
        .map_err(|e| format!("parse z-report sync payload: {e}"))?;

    sync_queue::enqueue_payload_item(
        conn,
        "z_reports",
        z_report_id,
        "INSERT",
        &sync_payload_value,
        Some(1),
        Some("z_report"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("enqueue z-report sync: {e}"))?;

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
        // Wave 5 Session 6: duplicate z-report cleanup must scrub both
        // queues. `sync_queue::clear_unsynced_items` only removes pending/
        // failed/conflict parity rows; since parity deletes rows on success
        // (no 'synced' status), that's equivalent to "all rows" here.
        conn.execute(
            "DELETE FROM sync_queue WHERE entity_type = 'z_report' AND entity_id = ?1",
            params![duplicate_id],
        )
        .map_err(|e| format!("delete duplicate z-report legacy sync queue row: {e}"))?;
        sync_queue::clear_unsynced_items(conn, "z_reports", &duplicate_id)
            .map_err(|e| format!("delete duplicate z-report parity sync queue row: {e}"))?;
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
            "currency": report.report_json.get("currency").cloned().unwrap_or(Value::Null),
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
            "twintSales": report.twint_sales,
            "refundsTotal": report.refunds_total,
            "voidsTotal": report.voids_total,
            "discountsTotal": report.discounts_total,
            "tipsTotal": report.tips_total,
            "expensesTotal": report.expenses_total,
            "cashVariance": report.total_variance,
            "openingCash": report.total_opening,
            "closingCash": report.total_closing,
            "expectedCash": report.total_expected,
            "paymentsBreakdown": report.payments_breakdown,
            "reportJson": report.report_json,
            "syncState": if preview_only { "preview" } else { "pending" },
        },
        "giftCloseReadiness": report.gift_close.readiness_value(),
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
    // Whether the courier's money came from their earnings, which already
    // carry every cash refund the courier handed back (the write lowers the
    // earning, the recount reads it net: `order_ownership::courier_order_tender_cents`).
    let mut driver_totals_from_earnings = false;
    let (cash_collected, card_amount): (f64, f64) = if role_type == "driver" {
        // W4b-iii: cents-with-real-fallback shim (removed in 4e).
        let driver_totals = conn
            .query_row(
                "SELECT
                COALESCE(SUM(COALESCE(de.cash_collected_cents, CAST(ROUND(de.cash_collected * 100) AS INTEGER))), 0),
                COALESCE(SUM(COALESCE(de.card_amount_cents, CAST(ROUND(de.card_amount * 100) AS INTEGER))), 0)
             FROM driver_earnings de
             LEFT JOIN orders o ON o.id = de.order_id
             WHERE de.staff_shift_id = ?1
               AND (o.id IS NULL OR COALESCE(o.is_ghost, 0) = 0)
               AND (o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded'))",
                params![staff_shift_id],
                |row| {
                    Ok((
                        Cents::new(row.get::<_, i64>(0)?).to_f64_dp2(),
                        Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    ))
                },
            )
            .map_err(|e| format!("query driver cash breakdown totals: {e}"))?;

        if driver_totals.0 > 0.0 || driver_totals.1 > 0.0 {
            driver_totals_from_earnings = true;
            driver_totals
        } else {
            // W4b-iii: cents-with-real-fallback shim (removed in 4e).
            let sql = "SELECT
                    COALESCE(SUM(CASE WHEN (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = '')) AND op.method = 'cash' THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)) ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = '')) AND op.method = 'card' THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)) ELSE 0 END), 0)
                 FROM orders o
                 LEFT JOIN order_payments op ON op.order_id = o.id
                 WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
                   AND COALESCE(o.is_ghost, 0) = 0
                   AND COALESCE(o.is_test, 0) = 0
                   AND COALESCE(o.order_context, '') <> 'repair_settlement'
                   AND o.status NOT IN ('cancelled', 'canceled')
                   AND COALESCE(o.order_type, 'dine-in') = 'delivery'";

            conn.query_row(sql, params![staff_shift_id], |row| {
                Ok((
                    Cents::new(row.get::<_, i64>(0)?).to_f64_dp2(),
                    Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                ))
            })
            .map_err(|e| format!("fallback driver cash breakdown totals: {e}"))?
        }
    } else {
        let sql = format!(
            "SELECT
                COALESCE(SUM(CASE WHEN (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = '')) AND op.method = 'cash' THEN op.amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = '')) AND op.method = 'card' THEN op.amount ELSE 0 END), 0)
             FROM orders o
             LEFT JOIN order_payments op ON op.order_id = o.id
             WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
               AND COALESCE(o.is_ghost, 0) = 0
               AND COALESCE(o.is_test, 0) = 0
               AND COALESCE(o.order_context, '') <> 'repair_settlement'
               AND o.status NOT IN ('cancelled', 'canceled')
               {}",
            role_order_type_filter_sql(role_type, "o")
        );

        conn.query_row(&sql, params![staff_shift_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| format!("query staff cash breakdown totals: {e}"))?
    };

    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    let expenses: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
             FROM shift_expenses WHERE staff_shift_id = ?1",
            params![staff_shift_id],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    // Wave 10 medium: cash refunds physically remove cash from the drawer
    // and must be deducted from the amount the staff returns at end of
    // shift. Card refunds don't touch the drawer, so we only sum
    // refund_method = 'cash'. Without this, a shift with a EUR 20 cash
    // refund had cashToReturn overstated by EUR 20 — the shift would
    // appear short by exactly the refund amount during reconciliation.
    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    //
    // Shared rule R2 (round 3, 01/10/2026): each cash refund is counted once,
    // by whoever handed it back. A drawer row (cashier, manager, server)
    // takes only the drawer's refunds (`refunds::refund_paid_by_drawer_sql`);
    // a courier row never takes one the drawer paid.
    let refund_is_cash = crate::refunds::refund_counts_as_cash_sql("pa", "op");
    let refund_paid_by_drawer = crate::refunds::refund_paid_by_drawer_sql("pa", "o");
    let handler_filter = if role_type == "driver" {
        format!("NOT {refund_paid_by_drawer}")
    } else {
        refund_paid_by_drawer
    };
    //
    // A courier row read from the courier's earnings takes none: the
    // earnings are already net of the refunds the courier handed back, so a
    // `driver_shift` refund booked under the driver's own shift came off
    // twice (round 3 review, 01/10/2026). The driver's own checkout
    // (`shifts::get_shift_summary` `amountToReturn`) reads the earnings the
    // same way and subtracts no refund either.
    let cash_refunds: f64 = if driver_totals_from_earnings {
        0.0
    } else {
        conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER))), 0)
                 FROM payment_adjustments pa
                 LEFT JOIN order_payments op ON op.id = pa.payment_id
                 LEFT JOIN orders o ON o.id = pa.order_id
                 WHERE pa.staff_shift_id = ?1
                   AND pa.adjustment_type = 'refund'
                   AND {refund_is_cash}
                   AND {handler_filter}"
            ),
            params![staff_shift_id],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0)
    };

    Ok(serde_json::json!({
        "roleType": role_type,
        "driverName": staff_name.unwrap_or_default(),
        "driverShiftId": staff_shift_id,
        "startingAmount": opening_amount,
        "cashCollected": cash_collected,
        "cardAmount": card_amount,
        "cashToReturn": opening_amount + cash_collected - expenses - cash_refunds,
        "cashRefunds": cash_refunds,
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
    status: String,
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
    twint_sales: f64,
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
    gift_close: GiftCloseReport,
}

/// A report label is evidence about every amount in the snapshot, never a
/// preference. An absent/invalid contributor or mixed original units has no
/// single currency; even an empty report must not borrow today's store setting.
fn common_report_currency(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let mut currency: Option<String> = None;
    for value in values {
        let value = value.filter(|value| {
            value.len() == 3
                && value
                    .bytes()
                    .all(|character| character.is_ascii_uppercase())
        })?;
        if currency.as_ref().is_some_and(|known| known != &value) {
            return None;
        }
        currency = Some(value);
    }
    currency
}

fn report_shift_currency(conn: &Connection, shift_id: &str) -> Result<Option<String>, String> {
    let Some(currency) = crate::shifts::shift_summary_currency(conn, shift_id)? else {
        return Ok(None);
    };
    // Repair projections currently carry totals/version but no original unit.
    // A generic shift snapshot cannot prove the currency of that remote ledger.
    let uncertain: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM staff_shifts WHERE id=?1 AND
           (COALESCE(repair_orders_count,0)<>0 OR COALESCE(repair_tender_sales,0)<>0
            OR COALESCE(repair_cash_sales,0)<>0 OR COALESCE(repair_card_sales,0)<>0))
         OR EXISTS(SELECT 1 FROM payment_adjustments a
           LEFT JOIN order_payments p ON p.id=a.payment_id
           LEFT JOIN orders o ON o.id=p.order_id
           WHERE (a.staff_shift_id=?1 OR COALESCE(p.staff_shift_id,o.staff_shift_id)=?1)
             AND (p.currency IS NULL OR p.currency<>?2))",
            params![shift_id, currency],
            |row| row.get(0),
        )
        .map_err(|error| format!("read report shift currency evidence: {error}"))?;
    Ok((!uncertain).then_some(currency))
}

fn report_currency_from_staff(
    staff: &[Value],
    gift_close: &GiftCloseReport,
) -> Vec<Option<String>> {
    staff
        .iter()
        .map(|row| {
            row.get("currency")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .chain(
            gift_close
                .originals
                .iter()
                .map(|row| Some(row.currency.clone())),
        )
        .collect()
}

/// Date reports also include platform/unassigned orders and expenses/drawers
/// outside their staff list. Read the full scoped population, not the capped
/// order detail list, so an unseen legacy or mixed row cannot acquire a label.
fn report_window_currency(
    conn: &Connection,
    branch_id: &str,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
    mut values: Vec<Option<String>>,
) -> Result<Option<String>, String> {
    let financial = business_day::order_financial_timestamp_expr("o");
    let financial_start = lower_bound_mode.sql_predicate(&financial, "?1");
    let expense_start = lower_bound_mode.sql_predicate("created_at", "?1");
    let drawer_start = lower_bound_mode.sql_predicate("opened_at", "?1");
    let payout_start = lower_bound_mode.sql_predicate("sp.created_at", "?1");
    let sql = format!(
        "WITH scoped_orders AS (
           SELECT o.id,o.currency FROM orders o WHERE {financial_start}
             AND (?2 IS NULL OR {financial}<=?2)
             AND (?3='' OR o.branch_id=?3 OR o.branch_id IS NULL)
             AND COALESCE(o.is_ghost,0)=0 AND COALESCE(o.is_test,0)=0
             AND COALESCE(o.order_context,'')<>'repair_settlement'
         )
         SELECT currency FROM scoped_orders
         UNION ALL SELECT p.currency FROM order_payments p JOIN scoped_orders o ON o.id=p.order_id
           WHERE p.status IN ('completed','refunded')
         UNION ALL SELECT p.currency FROM payment_adjustments a JOIN scoped_orders o ON o.id=a.order_id
           LEFT JOIN order_payments p ON p.id=a.payment_id
         UNION ALL SELECT currency FROM shift_expenses WHERE {expense_start}
           AND (?2 IS NULL OR created_at<=?2) AND (?3='' OR branch_id=?3 OR branch_id IS NULL)
         UNION ALL SELECT currency FROM cash_drawer_sessions WHERE {drawer_start}
           AND (?2 IS NULL OR opened_at<=?2) AND (?3='' OR branch_id=?3 OR branch_id IS NULL)
         UNION ALL SELECT sp.currency FROM staff_payments sp LEFT JOIN staff_shifts ss ON ss.id=sp.cashier_shift_id
           WHERE {payout_start} AND (?2 IS NULL OR sp.created_at<=?2)
             AND (?3='' OR ss.branch_id=?3 OR ss.branch_id IS NULL)"
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("prepare report currency: {error}"))?;
    let rows = statement
        .query_map(params![period_start, cutoff_at, branch_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(|error| format!("query report currency: {error}"))?;
    for row in rows {
        values.push(row.map_err(|error| format!("read report currency: {error}"))?);
    }
    Ok(common_report_currency(values))
}

/// Presentation evidence only: this remembered cache never admits a payment.
fn z_report_presentation_from_cache(
    modules: &Value,
    integrations: &Value,
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
) -> Value {
    let scoped = !organization_id.is_empty()
        && !branch_id.is_empty()
        && !terminal_id.is_empty()
        && modules.get("organizationId").and_then(Value::as_str) == Some(organization_id)
        && modules.get("branchId").and_then(Value::as_str) == Some(branch_id)
        && modules.get("terminalId").and_then(Value::as_str) == Some(terminal_id);
    if !scoped {
        return serde_json::json!({});
    }
    let Some(enabled) = modules.get("apiModules").and_then(Value::as_array) else {
        return serde_json::json!({});
    };
    let has_module = |id: &str| {
        enabled
            .iter()
            .any(|m| m.get("module_id").and_then(Value::as_str) == Some(id))
    };
    let mut flags = serde_json::json!({"deliveryModuleEnabled": has_module("delivery")});
    if !has_module("plugin_integrations") {
        flags["twintPluginEnabled"] = serde_json::json!(false);
    } else if integrations.get("success").and_then(Value::as_bool) == Some(true) {
        if let Some(plugins) = integrations.get("integrations").and_then(Value::as_array) {
            let twint_enabled = plugins.iter().any(|plugin| {
                plugin.get("plugin_id").and_then(Value::as_str) == Some("twint")
                    && plugin.get("branch_id").and_then(Value::as_str) == Some(branch_id)
                    && plugin.get("is_purchased").and_then(Value::as_bool) == Some(true)
                    && plugin.get("is_enabled").and_then(Value::as_bool) == Some(true)
                    && plugin
                        .pointer("/settings/target_terminal_id")
                        .map_or(true, |target| {
                            target.is_null() || target.as_str() == Some(terminal_id)
                        })
            });
            flags["twintPluginEnabled"] = serde_json::json!(twint_enabled);
        }
    }
    flags
}

fn load_z_report_presentation(db: &DbState, conn: &Connection, report_branch: &str) -> Value {
    let setting = |key: &str| {
        db::get_setting(conn, "terminal", key)
            .or_else(|| storage::get_credential(key))
            .unwrap_or_default()
    };
    let organization_id = setting("organization_id");
    let branch_id = setting("branch_id");
    // Managed API identity is canonical even when legacy display settings differ.
    let terminal_id = ["pos_api_key", "api_key"]
        .iter()
        .find_map(|key| crate::api::extract_terminal_id_from_connection_string(&setting(key)))
        .unwrap_or_else(|| setting("terminal_id"));
    if report_branch != branch_id {
        return serde_json::json!({});
    }
    let modules = crate::core_helpers::read_module_cache(db).unwrap_or(Value::Null);
    let integrations = db::get_setting(conn, "local", "admin_api_get::/api/pos/integrations")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|cache| cache.get("data").cloned())
        .unwrap_or(Value::Null);
    z_report_presentation_from_cache(
        &modules,
        &integrations,
        &organization_id,
        &branch_id,
        &terminal_id,
    )
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
    let _ = crate::shifts::ensure_staff_payments_table(conn);
}

fn drawer_money_cents_expr(alias: Option<&str>, column: &str) -> String {
    let column_ref = alias
        .map(|alias| format!("{alias}.{column}"))
        .unwrap_or_else(|| column.to_string());
    let cents_ref = alias
        .map(|alias| format!("{alias}.{column}_cents"))
        .unwrap_or_else(|| format!("{column}_cents"));
    format!("COALESCE({cents_ref}, CAST(ROUND({column_ref} * 100) AS INTEGER), 0)")
}

fn drawer_expected_cents_expr(alias: Option<&str>) -> String {
    let col = |name: &str| {
        alias
            .map(|alias| format!("{alias}.{name}"))
            .unwrap_or_else(|| name.to_string())
    };
    format!(
        "COALESCE(
            {expected_cents},
            CAST(ROUND({expected_amount} * 100) AS INTEGER),
            {opening}
              + {cash_sales}
              - {refunds}
              - {expenses}
              - {staff_payments}
              - {drops}
              - {driver_given}
              + {driver_returned}
        )",
        expected_cents = col("expected_amount_cents"),
        expected_amount = col("expected_amount"),
        opening = drawer_money_cents_expr(alias, "opening_amount"),
        cash_sales = drawer_money_cents_expr(alias, "total_cash_sales"),
        refunds = drawer_money_cents_expr(alias, "total_refunds"),
        expenses = drawer_money_cents_expr(alias, "total_expenses"),
        staff_payments = drawer_money_cents_expr(alias, "total_staff_payments"),
        drops = drawer_money_cents_expr(alias, "cash_drops"),
        driver_given = drawer_money_cents_expr(alias, "driver_cash_given"),
        driver_returned = drawer_money_cents_expr(alias, "driver_cash_returned"),
    )
}

fn load_staff_expense_items(conn: &Connection, shift_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            // W4b-iii: cents-with-real-fallback shim (removed in 4e).
            "SELECT id, expense_type,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    description, created_at
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
                "amount": Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
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
                "SELECT sp.id, sp.amount, sp.payment_type, sp.notes, sp.created_at,
                        (SELECT ss.staff_name
                         FROM staff_shifts ss
                         WHERE ss.staff_id = sp.paid_to_staff_id
                         ORDER BY ss.check_in_time DESC
                         LIMIT 1),
                        (SELECT ss.role_type
                         FROM staff_shifts ss
                         WHERE ss.staff_id = sp.paid_to_staff_id
                         ORDER BY ss.check_in_time DESC
                         LIMIT 1), sp.currency
                 FROM staff_payments sp
                 WHERE sp.cashier_shift_id = ?1
                 ORDER BY sp.created_at ASC",
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
                    "staffName": row.get::<_, Option<String>>(5)?,
                    "role": row.get::<_, Option<String>>(6)?,
                    "currency": row.get::<_, Option<String>>(7)?,
                }))
            })
            .map_err(|e| format!("query cashier staff payments: {e}"))?
            .filter_map(|row| row.ok())
            .collect::<Vec<_>>();

        return Ok(payments);
    }

    let mut stmt = conn
        .prepare(
            "SELECT sp.id, sp.amount, sp.payment_type, sp.notes, sp.created_at,
                    (SELECT ss.staff_name
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1),
                    (SELECT ss.role_type
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1), sp.currency
             FROM staff_payments sp
             WHERE sp.paid_to_staff_id = ?1
               AND (?2 IS NULL OR sp.created_at >= ?2)
               AND (?3 IS NULL OR sp.created_at <= ?3)
             ORDER BY sp.created_at ASC",
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
                    "staffName": row.get::<_, Option<String>>(5)?,
                    "role": row.get::<_, Option<String>>(6)?,
                    "currency": row.get::<_, Option<String>>(7)?,
                }))
            },
        )
        .map_err(|e| format!("query received staff payments: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    Ok(payments)
}

fn load_staff_drawer_snapshot(conn: &Connection, shift_id: &str) -> Result<Option<Value>, String> {
    let expected_expr = drawer_expected_cents_expr(None);
    conn.query_row(
        &format!(
            // W4b-iii: cents-with-real-fallback shim on 10 monetary cols.
            "SELECT
                COALESCE(opening_amount_cents, CAST(ROUND(opening_amount * 100) AS INTEGER), 0),
                {expected_expr},
                COALESCE(closing_amount_cents, CAST(ROUND(closing_amount * 100) AS INTEGER)),
                COALESCE(variance_amount_cents, CAST(ROUND(variance_amount * 100) AS INTEGER)),
                COALESCE(total_cash_sales_cents, CAST(ROUND(total_cash_sales * 100) AS INTEGER), 0),
                COALESCE(total_card_sales_cents, CAST(ROUND(total_card_sales * 100) AS INTEGER), 0),
                COALESCE(cash_drops_cents, CAST(ROUND(cash_drops * 100) AS INTEGER), 0),
                COALESCE(driver_cash_returned_cents, CAST(ROUND(driver_cash_returned * 100) AS INTEGER), 0),
                COALESCE(driver_cash_given_cents, CAST(ROUND(driver_cash_given * 100) AS INTEGER), 0),
                COALESCE(total_staff_payments_cents, CAST(ROUND(total_staff_payments * 100) AS INTEGER), 0)
         FROM cash_drawer_sessions
         WHERE staff_shift_id = ?1"
        ),
        params![shift_id],
        |row| {
            Ok(serde_json::json!({
                "opening": Cents::new(row.get::<_, i64>(0).unwrap_or(0)).to_f64_dp2(),
                "expected": row.get::<_, Option<i64>>(1)?.map(|c| Cents::new(c).to_f64_dp2()),
                "closing": row.get::<_, Option<i64>>(2)?.map(|c| Cents::new(c).to_f64_dp2()),
                "variance": row.get::<_, Option<i64>>(3)?.map(|c| Cents::new(c).to_f64_dp2()),
                "cashSales": Cents::new(row.get::<_, i64>(4).unwrap_or(0)).to_f64_dp2(),
                "cardSales": Cents::new(row.get::<_, i64>(5).unwrap_or(0)).to_f64_dp2(),
                "drops": Cents::new(row.get::<_, i64>(6).unwrap_or(0)).to_f64_dp2(),
                "driverCashReturned": Cents::new(row.get::<_, i64>(7).unwrap_or(0)).to_f64_dp2(),
                "driverCashGiven": Cents::new(row.get::<_, i64>(8).unwrap_or(0)).to_f64_dp2(),
                "staffPayments": Cents::new(row.get::<_, i64>(9).unwrap_or(0)).to_f64_dp2(),
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
    branch_id: &str,
) -> Result<Vec<Value>, String> {
    let opened_at_predicate = lower_bound_mode.sql_predicate("cds.opened_at", "?1");
    let expected_expr = drawer_expected_cents_expr(Some("cds"));
    let mut stmt = conn
        .prepare(&format!(
            // W4b-iii: cents-with-real-fallback shim on 10 monetary cols.
            "SELECT cds.id, cds.staff_shift_id, ss.staff_name,
                    COALESCE(cds.opening_amount_cents, CAST(ROUND(cds.opening_amount * 100) AS INTEGER), 0),
                    {expected_expr},
                    COALESCE(cds.closing_amount_cents, CAST(ROUND(cds.closing_amount * 100) AS INTEGER)),
                    COALESCE(cds.variance_amount_cents, CAST(ROUND(cds.variance_amount * 100) AS INTEGER)),
                    COALESCE(cds.total_cash_sales_cents, CAST(ROUND(cds.total_cash_sales * 100) AS INTEGER), 0),
                    COALESCE(cds.total_card_sales_cents, CAST(ROUND(cds.total_card_sales * 100) AS INTEGER), 0),
                    COALESCE(cds.driver_cash_given_cents, CAST(ROUND(cds.driver_cash_given * 100) AS INTEGER), 0),
                    COALESCE(cds.driver_cash_returned_cents, CAST(ROUND(cds.driver_cash_returned * 100) AS INTEGER), 0),
                    COALESCE(cds.cash_drops_cents, CAST(ROUND(cds.cash_drops * 100) AS INTEGER), 0),
                    COALESCE(cds.total_staff_payments_cents, CAST(ROUND(cds.total_staff_payments * 100) AS INTEGER), 0),
                    cds.opened_at, cds.closed_at, cds.reconciled, cds.terminal_id
             FROM cash_drawer_sessions cds
             LEFT JOIN staff_shifts ss ON ss.id = cds.staff_shift_id
             WHERE {opened_at_predicate}
               AND (?2 IS NULL OR cds.opened_at <= ?2)
               AND (?3 = '' OR cds.branch_id = ?3 OR cds.branch_id IS NULL)
              ORDER BY cds.opened_at ASC"
        ))
        .map_err(|e| format!("prepare drawer rows for period: {e}"))?;

    let rows = stmt
        .query_map(params![period_start, cutoff_at, branch_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "staffShiftId": row.get::<_, String>(1)?,
                "staffName": row.get::<_, Option<String>>(2)?,
                "opening": Cents::new(row.get::<_, i64>(3).unwrap_or(0)).to_f64_dp2(),
                "expected": row.get::<_, Option<i64>>(4)?.map(|c| Cents::new(c).to_f64_dp2()),
                "closing": row.get::<_, Option<i64>>(5)?.map(|c| Cents::new(c).to_f64_dp2()),
                "variance": row.get::<_, Option<i64>>(6)?.map(|c| Cents::new(c).to_f64_dp2()),
                "cashSales": Cents::new(row.get::<_, i64>(7).unwrap_or(0)).to_f64_dp2(),
                "cardSales": Cents::new(row.get::<_, i64>(8).unwrap_or(0)).to_f64_dp2(),
                "driverCashGiven": Cents::new(row.get::<_, i64>(9).unwrap_or(0)).to_f64_dp2(),
                "driverCashReturned": Cents::new(row.get::<_, i64>(10).unwrap_or(0)).to_f64_dp2(),
                "drops": Cents::new(row.get::<_, i64>(11).unwrap_or(0)).to_f64_dp2(),
                "staffPayments": Cents::new(row.get::<_, i64>(12).unwrap_or(0)).to_f64_dp2(),
                "openedAt": row.get::<_, Option<String>>(13)?,
                "closedAt": row.get::<_, Option<String>>(14)?,
                "reconciled": row.get::<_, i64>(15).unwrap_or(0) != 0,
                "terminalId": row.get::<_, Option<String>>(16)?,
            }))
        })
        .map_err(|e| format!("query drawer rows for period: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    Ok(rows)
}

fn money_in_drawer_from_rows(drawer_rows: &[Value]) -> f64 {
    let mut latest_by_terminal = HashMap::<String, f64>::new();
    for drawer in drawer_rows {
        let terminal_id = drawer
            .get("terminalId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("__default_terminal__")
            .to_string();
        let amount = drawer
            .get("closing")
            .and_then(Value::as_f64)
            .unwrap_or_else(|| {
                drawer
                    .get("expected")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    + drawer
                        .get("variance")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
            });
        latest_by_terminal.insert(terminal_id, amount);
    }
    latest_by_terminal.values().sum()
}

fn opening_in_drawer_from_rows(drawer_rows: &[Value]) -> f64 {
    let mut first_by_terminal = HashMap::<String, f64>::new();
    for drawer in drawer_rows {
        let terminal_id = drawer
            .get("terminalId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("__default_terminal__")
            .to_string();
        first_by_terminal
            .entry(terminal_id)
            .or_insert_with(|| drawer.get("opening").and_then(Value::as_f64).unwrap_or(0.0));
    }
    first_by_terminal.values().sum()
}

fn load_drawer_rows_for_shift(conn: &Connection, shift_id: &str) -> Result<Vec<Value>, String> {
    let expected_expr = drawer_expected_cents_expr(Some("cds"));
    let mut stmt = conn
        .prepare(&format!(
            // W4b-iii: cents-with-real-fallback shim on 10 monetary cols.
            "SELECT cds.id, cds.staff_shift_id, ss.staff_name,
                    COALESCE(cds.opening_amount_cents, CAST(ROUND(cds.opening_amount * 100) AS INTEGER), 0),
                    {expected_expr},
                    COALESCE(cds.closing_amount_cents, CAST(ROUND(cds.closing_amount * 100) AS INTEGER)),
                    COALESCE(cds.variance_amount_cents, CAST(ROUND(cds.variance_amount * 100) AS INTEGER)),
                    COALESCE(cds.total_cash_sales_cents, CAST(ROUND(cds.total_cash_sales * 100) AS INTEGER), 0),
                    COALESCE(cds.total_card_sales_cents, CAST(ROUND(cds.total_card_sales * 100) AS INTEGER), 0),
                    COALESCE(cds.driver_cash_given_cents, CAST(ROUND(cds.driver_cash_given * 100) AS INTEGER), 0),
                    COALESCE(cds.driver_cash_returned_cents, CAST(ROUND(cds.driver_cash_returned * 100) AS INTEGER), 0),
                    COALESCE(cds.cash_drops_cents, CAST(ROUND(cds.cash_drops * 100) AS INTEGER), 0),
                    COALESCE(cds.total_staff_payments_cents, CAST(ROUND(cds.total_staff_payments * 100) AS INTEGER), 0),
                    cds.opened_at, cds.closed_at, cds.reconciled
             FROM cash_drawer_sessions cds
             LEFT JOIN staff_shifts ss ON ss.id = cds.staff_shift_id
             WHERE cds.staff_shift_id = ?1
             ORDER BY cds.opened_at ASC"
        ))
        .map_err(|e| format!("prepare drawer rows for shift: {e}"))?;

    let rows = stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "staffShiftId": row.get::<_, String>(1)?,
                "staffName": row.get::<_, Option<String>>(2)?,
                "opening": Cents::new(row.get::<_, i64>(3).unwrap_or(0)).to_f64_dp2(),
                "expected": row.get::<_, Option<i64>>(4)?.map(|c| Cents::new(c).to_f64_dp2()),
                "closing": row.get::<_, Option<i64>>(5)?.map(|c| Cents::new(c).to_f64_dp2()),
                "variance": row.get::<_, Option<i64>>(6)?.map(|c| Cents::new(c).to_f64_dp2()),
                "cashSales": Cents::new(row.get::<_, i64>(7).unwrap_or(0)).to_f64_dp2(),
                "cardSales": Cents::new(row.get::<_, i64>(8).unwrap_or(0)).to_f64_dp2(),
                "driverCashGiven": Cents::new(row.get::<_, i64>(9).unwrap_or(0)).to_f64_dp2(),
                "driverCashReturned": Cents::new(row.get::<_, i64>(10).unwrap_or(0)).to_f64_dp2(),
                "drops": Cents::new(row.get::<_, i64>(11).unwrap_or(0)).to_f64_dp2(),
                "staffPayments": Cents::new(row.get::<_, i64>(12).unwrap_or(0)).to_f64_dp2(),
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
    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    let sql = format!(
        "SELECT
            CASE
                WHEN COALESCE(o.order_type, 'dine-in') = 'delivery' THEN 'delivery'
                ELSE 'instore'
            END AS bucket,
            op.method,
            COUNT(DISTINCT o.id),
            COALESCE(SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER))), 0)
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
         WHERE {financial_predicate}
           AND (?2 IS NULL OR {financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = ''))
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
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
                Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
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
            // W4b-iii: cents-with-real-fallback shim (removed in 4e).
            "SELECT
                CASE
                    WHEN COALESCE(o.order_type, 'dine-in') = 'delivery' THEN 'delivery'
                    ELSE 'instore'
                END AS bucket,
                op.method,
                COUNT(DISTINCT o.id),
                COALESCE(SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER))), 0)
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
               AND (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = ''))
               AND COALESCE(o.is_ghost, 0) = 0
               AND COALESCE(o.is_test, 0) = 0
               AND COALESCE(o.order_context, '') <> 'repair_settlement'
               AND o.status NOT IN ('cancelled', 'canceled')
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
                Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
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
    // Gap review P0-03: per-staff totals must agree with the day-level
    // aggregates — a live never-settled tab's money was not collected on
    // this shift and must not appear in the staff section either.
    let staff_open_tab = business_day::open_unsettled_table_tab_expr("o");
    // A payment set aside as a possible duplicate is money nowhere, so it
    // never puts an order in the section of the shift that took it (fix
    // review 30/09/2026): the order is attributed as if it did not exist.
    let set_aside = crate::payment_review::set_aside_payment_sql("op");
    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    let order_scope_sql = format!(
        "SELECT COUNT(*), COALESCE(SUM(order_total_cents), 0)
         FROM (
            SELECT o.id, MAX(COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0)) AS order_total_cents
            FROM orders o
            LEFT JOIN order_payments op ON op.order_id = o.id AND NOT {set_aside}
            WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
              AND {financial_expr} >= ?2
              AND (?3 IS NULL OR {financial_expr} <= ?3)
              AND COALESCE(o.is_ghost, 0) = 0
              AND COALESCE(o.is_test, 0) = 0
              AND COALESCE(o.order_context, '') <> 'repair_settlement'
              AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
              AND NOT {staff_open_tab}
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
            |row| Ok((row.get(0)?, Cents::new(row.get::<_, i64>(1)?).to_f64_dp2())),
        )
        .map_err(|e| format!("query non-driver order totals: {e}"))?;

    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    let payment_sql = format!(
        "SELECT
            COALESCE(SUM(CASE WHEN (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = '')) AND op.method = 'cash' THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)) ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = '')) AND op.method = 'card' THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)) ELSE 0 END), 0)
         FROM orders o
         LEFT JOIN order_payments op ON op.order_id = o.id
         WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
           AND {financial_expr} >= ?2
           AND (?3 IS NULL OR {financial_expr} <= ?3)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
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
            |row| {
                Ok((
                    Cents::new(row.get::<_, i64>(0)?).to_f64_dp2(),
                    Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                ))
            },
        )
        .map_err(|e| format!("query non-driver payment totals: {e}"))?;

    Ok((order_count, cash_amount, card_amount, total_amount))
}

#[allow(clippy::type_complexity)]
fn load_driver_order_totals(
    conn: &Connection,
    shift_id: &str,
) -> Result<(i64, i64, i64, f64, f64, f64, f64, f64), String> {
    // W4b-iii: cents-with-real-fallback shim on 4 monetary SUM cols.
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
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded')
                    THEN COALESCE(de.total_earning_cents, CAST(ROUND(de.total_earning * 100) AS INTEGER))
                        + MAX(
                            COALESCE(o.tip_amount_cents, CAST(ROUND(o.tip_amount * 100) AS INTEGER), 0)
                                - COALESCE(de.tip_amount_cents, CAST(ROUND(de.tip_amount * 100) AS INTEGER), 0),
                            0
                        )
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded')
                    THEN MAX(
                        COALESCE(de.tip_amount_cents, CAST(ROUND(de.tip_amount * 100) AS INTEGER), 0),
                        COALESCE(o.tip_amount_cents, CAST(ROUND(o.tip_amount * 100) AS INTEGER), 0)
                    )
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded')
                    THEN COALESCE(de.cash_collected_cents, CAST(ROUND(de.cash_collected * 100) AS INTEGER))
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded')
                    THEN COALESCE(de.card_amount_cents, CAST(ROUND(de.card_amount * 100) AS INTEGER))
                ELSE 0
            END), 0),
            COALESCE(SUM(CASE
                WHEN o.id IS NULL OR o.status NOT IN ('cancelled', 'canceled', 'refunded')
                    THEN COALESCE(o.total_amount_cents,
                                  CAST(ROUND(o.total_amount * 100) AS INTEGER),
                                  CAST(ROUND((de.cash_collected + de.card_amount) * 100) AS INTEGER))
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
                Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
                Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                Cents::new(row.get::<_, i64>(6)?).to_f64_dp2(),
                Cents::new(row.get::<_, i64>(7)?).to_f64_dp2(),
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
    // W6: `orders.payment_method` was dropped in migration v55. Derive
    // the method inline from `order_payments` using the same semantic as
    // `payments::derive_payment_method` — multi-method = "split"; one
    // method = that method; no rows = "pending". Inline as
    // a subquery (not a Rust post-process) because this query already
    // joins across order and payment tables and we want to keep the
    // classification deterministic per SELECT pass.
    // A set-aside payment never lists the order under the shift that took it.
    let set_aside = crate::payment_review::set_aside_payment_sql("op");
    let detail_sql = format!(
        "SELECT o.id,
                COALESCE(NULLIF(TRIM(o.order_number), ''), o.id),
                COALESCE(o.order_type, 'dine-in'),
                o.table_number,
                o.delivery_address,
                COALESCE(o.total_amount, 0),
                COALESCE((
                    SELECT CASE
                        WHEN COUNT(DISTINCT LOWER(TRIM(method))) > 1
                          THEN 'split'
                        ELSE LOWER(TRIM(MIN(method)))
                    END
                    FROM order_payments op2
                    WHERE op2.order_id = o.id
                      AND op2.status = 'completed'
                      AND TRIM(COALESCE(op2.method, '')) != ''
                ), 'pending') AS payment_method,
                o.payment_status,
                o.status,
                o.created_at
         FROM orders o
         WHERE o.id IN (
            SELECT DISTINCT o2.id
            FROM orders o2
            LEFT JOIN order_payments op ON op.order_id = o2.id AND NOT {set_aside}
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

/// Day-level order list for the Z modal's Orders tab (founder, 06/09/2026:
/// the tab listed only the staff shifts' orders, so every platform order was
/// missing from the list, the badge and the CSV).
///
/// Every order the day COUNTS — store and platform alike — in chronological
/// order, selected with exactly the predicate behind `sales.totalOrders`
/// (same window, branch wildcard, ghost/test/repair exclusions, cancelled
/// excluded, open unsettled table tabs excluded), so
/// `dayOrders.len() + sales.repairOrders == daySummary.totalOrders`.
///
/// Platform orders are the ones `staffReports[].ordersDetails` can never
/// hold: they carry no staff shift (ingested without a cashier assignment,
/// settled with a NULL-shift `other` payment), so the per-shift lists skip
/// them. Their tender is labelled like `paymentsBreakdown`
/// (`platform_online` / `platform_cod`), never the bare `other`, and the row
/// names its platform (`orders.plugin`) and whether the platform's own rider
/// carried it. Store orders keep their staff attribution (driver shift first,
/// then the settling payment's shift, then the order's own). Capped like the
/// per-shift lists: 1000 rows + `dayOrdersTruncated`.
fn load_day_order_details(
    conn: &Connection,
    branch_id: &str,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
) -> Result<(Vec<Value>, bool), String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let financial_predicate = lower_bound_mode.sql_predicate(&financial_expr, "?1");
    // Same population as the turnover aggregate and the closeout gate, so the
    // Orders tab lists exactly the orders the totals were built from.
    let last_z_anchor = business_day::last_z_anchor_utc(conn);
    let reportable_order = business_day::z_report_reportable_order_expr("o", "?4");
    // `plugin` names an order SOURCE, and only a marketplace we can NAME is a
    // platform: `pos`/`kiosk`/`web`/`android-ios` are our own channels and must
    // read as platform-less here, or the modal's «Platforms» filter (which
    // keys on a non-null `platform`) sweeps the whole till in. A slug we do
    // not recognise is platform-less too — it is reported by
    // `integrity.unclassifiedPlatforms` instead of being guessed into a
    // marketplace it may have nothing to do with.
    let external_platform_label = crate::platforms::external_marketplace_label_sql_expr("o.plugin");
    // instr() instead of LIKE for the fleet marker: it contains `_`, which
    // LIKE treats as a single-character wildcard.
    let sql = format!(
        "SELECT x.*,
                (SELECT ss.staff_name FROM staff_shifts ss WHERE ss.id = x.staff_shift_id) AS staff_name,
                (SELECT original.currency FROM orders original WHERE original.id=x.id) AS currency
         FROM (
            SELECT o.id AS id,
                   COALESCE(NULLIF(TRIM(o.order_number), ''), o.id) AS order_number,
                   COALESCE(o.order_type, 'dine-in') AS order_type,
                   o.table_number AS table_number,
                   o.delivery_address AS delivery_address,
                   COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0) AS amount_cents,
                   COALESCE((
                       SELECT CASE
                           WHEN COUNT(DISTINCT LOWER(TRIM(op2.method))) > 1 THEN 'split'
                           WHEN LOWER(TRIM(MIN(op2.method))) = 'other'
                                AND MAX(CASE WHEN COALESCE(op2.transaction_ref, '') LIKE 'platform_settlement:online:%' THEN 1 ELSE 0 END) = 1
                             THEN 'platform_online'
                           WHEN LOWER(TRIM(MIN(op2.method))) = 'other'
                                AND MAX(CASE WHEN COALESCE(op2.transaction_ref, '') LIKE 'platform_settlement:cod:%' THEN 1 ELSE 0 END) = 1
                             THEN 'platform_cod'
                           ELSE LOWER(TRIM(MIN(op2.method)))
                       END
                       FROM order_payments op2
                       WHERE op2.order_id = o.id
                         AND op2.status = 'completed'
                         AND TRIM(COALESCE(op2.method, '')) != ''
                   ), 'pending') AS payment_method,
                   o.payment_status AS payment_status,
                   o.status AS status,
                   o.created_at AS created_at,
                   NULLIF({external_platform_label}, '') AS platform,
                   CASE WHEN instr(COALESCE(o.ghost_metadata, ''),
                                   '\"delivery_provider\":\"platform_delivery\"') > 0
                        THEN 1 ELSE 0 END AS platform_fleet,
                   COALESCE(
                       (SELECT de.staff_shift_id FROM driver_earnings de
                         WHERE de.order_id = o.id AND de.staff_shift_id IS NOT NULL
                         ORDER BY de.created_at DESC LIMIT 1),
                       (SELECT op3.staff_shift_id FROM order_payments op3
                         WHERE op3.order_id = o.id AND op3.status = 'completed'
                           AND op3.staff_shift_id IS NOT NULL
                         ORDER BY op3.created_at ASC LIMIT 1),
                       o.staff_shift_id
                   ) AS staff_shift_id
            FROM orders o
            WHERE {financial_predicate}
              AND (?2 IS NULL OR {financial_expr} <= ?2)
              AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
              AND COALESCE(o.is_ghost, 0) = 0
              AND COALESCE(o.is_test, 0) = 0
              AND COALESCE(o.order_context, '') <> 'repair_settlement'
              AND o.status NOT IN ('cancelled', 'canceled')
              AND {reportable_order}
         ) x
         ORDER BY x.created_at ASC, x.id ASC
         LIMIT 1001"
    );

    let mut rows = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare day order details: {e}"))?
        .query_map(
            params![period_start, cutoff_at, branch_id, last_z_anchor],
            |row| {
                let raw_order_type = row.get::<_, String>(2)?;
                Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "orderNumber": row.get::<_, String>(1)?,
                "orderType": normalize_order_type(&raw_order_type),
                "tableNumber": row.get::<_, Option<String>>(3)?,
                "deliveryAddress": row.get::<_, Option<String>>(4)?,
                "amount": Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                "paymentMethod": row.get::<_, Option<String>>(6)?,
                "paymentStatus": row.get::<_, Option<String>>(7)?,
                // Nullable in the local schema; a NULL must not drop the row
                // (the list promises the aggregate's count).
                "status": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                "createdAt": row.get::<_, Option<String>>(9)?.unwrap_or_default(),
                "platform": row.get::<_, Option<String>>(10)?,
                "platformFleet": row.get::<_, i64>(11)? == 1,
                "staffShiftId": row.get::<_, Option<String>>(12)?,
                "staffName": row.get::<_, Option<String>>(13)?,
                "currency": row.get::<_, Option<String>>(14)?,
                }))
            },
        )
        .map_err(|e| format!("query day order details: {e}"))?
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
        mut orders_value,
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
            tips,
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
                "tips": tips,
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

    let twint_cents: i64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER))),0)
         FROM order_payments op JOIN orders o ON o.id = op.order_id
         WHERE op.staff_shift_id = ?1 AND op.method = 'twint' AND op.status = 'completed'
           AND op.currency = 'CHF'
           AND NOT (COALESCE(op.payment_origin,'') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id,'')) = '')
           AND COALESCE(o.is_ghost,0) = 0 AND COALESCE(o.is_test,0) = 0
           AND COALESCE(o.order_context,'') <> 'repair_settlement'
           AND {financial_expr} >= ?2 AND (?3 IS NULL OR {financial_expr} <= ?3)", financial_expr = business_day::order_financial_timestamp_expr("o")),
        params![shift.id,shift.check_in_time.as_deref().unwrap_or(business_day::EPOCH_RFC3339),shift.check_out_time.as_deref()], |row| row.get(0),
    ).map_err(|e| format!("load staff TWINT payments: {e}"))?;
    orders_value["twintAmount"] = serde_json::json!(Cents::new(twint_cents).to_f64_dp2());

    Ok(serde_json::json!({
        "staffShiftId": shift.id,
        "currency": common_report_currency(std::iter::once(report_shift_currency(conn, &shift.id)?)
            .chain(payment_items.iter().map(|row|row.get("currency").and_then(Value::as_str).map(str::to_owned)))),
        "staffId": shift.staff_id,
        "staffName": display_name,
        "role": shift.role_type,
        "checkIn": shift.check_in_time,
        "checkOut": shift.check_out_time,
        "shiftStatus": shift.status,
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
        tips: f64,
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
        entry.tips += driver.get("tips").and_then(Value::as_f64).unwrap_or(0.0);
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
    let mut total_tips = 0.0_f64;
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
            total_tips += aggregate.tips;
            total_cash_collected += aggregate.cash_collected;
            total_card_amount += aggregate.card_amount;
            total_cash_to_return += aggregate.cash_to_return;
            unsettled_total += aggregate.unsettled_count;

            serde_json::json!({
                "driverId": driver_id,
                "name": aggregate.name,
                "deliveries": aggregate.deliveries,
                "earnings": aggregate.earnings,
                "tips": aggregate.tips,
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
        "totalTips": total_tips,
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

/// Load the server-authored repair tender projection for a reporting window.
/// A non-zero/versioned row without sync evidence is deliberately fatal: the
/// desktop must never reconstruct repair money from local repair commands.
fn load_server_repair_projection(
    conn: &rusqlite::Connection,
    branch_id: &str,
    period_start: &str,
    period_end: &str,
) -> Result<Value, String> {
    let invalid_evidence: i64 = conn
        .query_row(
            "SELECT COUNT(*)
               FROM staff_shifts
              WHERE branch_id = ?1
                AND check_in_time >= ?2
                AND check_in_time <= ?3
                AND (
                  COALESCE(repair_projection_version, 0) > 0
                  OR ABS(COALESCE(repair_tender_sales, 0)) > 0.000001
                  OR ABS(COALESCE(repair_cash_sales, 0)) > 0.000001
                  OR ABS(COALESCE(repair_card_sales, 0)) > 0.000001
                  OR COALESCE(repair_orders_count, 0) <> 0
                )
                AND (
                  COALESCE(repair_projection_version, 0) <= 0
                  OR repair_projection_synced_at IS NULL
                  OR trim(repair_projection_synced_at) = ''
                )",
            params![branch_id, period_start, period_end],
            |row| row.get(0),
        )
        .map_err(|error| format!("load repair reporting evidence: {error}"))?;
    if invalid_evidence > 0 {
        return Err("REPAIR_REPORTING_EVIDENCE_REQUIRED".to_string());
    }

    let (orders, total, cash, card): (i64, f64, f64, f64) = conn
        .query_row(
            "SELECT
                COALESCE(SUM(repair_orders_count), 0),
                COALESCE(SUM(repair_tender_sales), 0),
                COALESCE(SUM(repair_cash_sales), 0),
                COALESCE(SUM(repair_card_sales), 0)
               FROM staff_shifts
              WHERE branch_id = ?1
                AND check_in_time >= ?2
                AND check_in_time <= ?3
                AND COALESCE(repair_projection_version, 0) > 0",
            params![branch_id, period_start, period_end],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("load server repair projection: {error}"))?;
    Ok(serde_json::json!({
        "repairOrders": orders,
        "repairSales": total,
        "repairCashSales": cash,
        "repairCardSales": card,
        "repairOtherSales": total - cash - card,
    }))
}

/// Generate a Z-report for a closed shift.
///
/// Aggregates orders, payments, adjustments, and expenses for the given shift,
/// persists the snapshot in `z_reports`, and enqueues a sync entry.
///
/// **Idempotent:** If a z_report already exists for this shift, returns the
/// existing one without creating a duplicate.
/// Per order type, the part of each gift card row's proven return cumulative
/// that no local refund adjustment records: an earlier original-card return
/// another terminal made, which settlement coverage already counts through
/// `payments::effective_reversed_cents`. Each row goes through the shared
/// checked reader, so an unreadable or foreign proof fails the report instead
/// of reading as 0; a shift without gift card rows reads no journal. Rows with
/// a void adjustment are excluded because order-type NET never subtracts voids.
fn shift_unrecorded_gift_returns_by_order_type(
    conn: &Connection,
    shift_id: &str,
    open_tab_expr: &str,
) -> Result<HashMap<String, i64>, String> {
    let sql = format!(
        // W4b-iii: cents-with-real-fallback shim (removed in 4e).
        "SELECT COALESCE(o.order_type, 'dine-in'), op.id, op.order_id,
                COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                COALESCE((
                    SELECT SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER)))
                    FROM payment_adjustments pa
                    WHERE pa.payment_id = op.id AND pa.adjustment_type = 'refund'
                ), 0)
         FROM orders o
         JOIN order_payments op ON op.order_id = o.id AND op.method = 'gift_card'
         WHERE o.staff_shift_id = ?1
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND o.status NOT IN ('cancelled', 'canceled')
           AND NOT {open_tab_expr}
           AND NOT EXISTS (
               SELECT 1 FROM payment_adjustments pv
               WHERE pv.payment_id = op.id AND pv.adjustment_type = 'void'
           )"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare gift return floor query: {e}"))?;
    let rows = stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| format!("query gift return floor: {e}"))?;
    let mut unrecorded = HashMap::new();
    for (order_type, payment_id, order_id, gross_cents, refunded_cents) in rows {
        let floor = crate::commands::gift_card_returns::proven_return_floor_cents(
            conn,
            &payment_id,
            &order_id,
            gross_cents,
        )?;
        *unrecorded.entry(order_type).or_insert(0) += (floor - refunded_cents).max(0);
    }
    Ok(unrecorded)
}

pub fn generate_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .ok_or("Missing shiftId")?;

    // A gift-bound original reports only its adopted canonical close, and an
    // earlier stored report must already carry it.
    let gift_close = load_gift_close_report_for_shift(&conn, &shift_id)?;
    if let Some(message) = gift_close.blocker_message() {
        return Err(message);
    }

    // Check for existing z_report (idempotent)
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM z_reports WHERE shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing_id) = existing {
        ensure_gift_close_snapshot_current(&conn, &existing_id, &gift_close)?;
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
                    report_date, period_start_at,
                    repair_tender_sales, repair_cash_sales, repair_card_sales,
                    repair_orders_count, repair_projection_version,
                    repair_projection_synced_at
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
                    row.get::<_, f64>(15)?,            // repair_tender_sales
                    row.get::<_, f64>(16)?,            // repair_cash_sales
                    row.get::<_, f64>(17)?,            // repair_card_sales
                    row.get::<_, i64>(18)?,            // repair_orders_count
                    row.get::<_, i64>(19)?,            // repair_projection_version
                    row.get::<_, Option<String>>(20)?, // repair_projection_synced_at
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
        repair_tender_sales,
        repair_cash_sales,
        repair_card_sales,
        repair_orders_count,
        repair_projection_version,
        repair_projection_synced_at,
    ) = shift;

    if status != "closed" {
        return Err(format!(
            "Shift must be closed to generate Z-report (current status: {status})"
        ));
    }
    let has_repair_projection = repair_projection_version > 0
        || repair_tender_sales.abs() > 0.000001
        || repair_cash_sales.abs() > 0.000001
        || repair_card_sales.abs() > 0.000001
        || repair_orders_count != 0;
    if has_repair_projection
        && (repair_projection_version <= 0
            || repair_projection_synced_at
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none())
    {
        return Err("REPAIR_REPORTING_EVIDENCE_REQUIRED".to_string());
    }
    let primary_shift = ReportStaffShift {
        id: shift_id.to_string(),
        staff_id: staff_id.clone(),
        staff_name: staff_name.clone(),
        role_type: role_type.clone(),
        status: status.clone(),
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

    // Orders: count, gross sales, discounts, tips.
    //
    // Wave 6 H16 — invariant: `orders.total_amount` is the POST-discount
    // order total. `gross` here reconstructs the PRE-discount revenue by
    // adding `discount_amount` back in: `SUM(total_amount + discount_amount)`.
    // The downstream `net_sales = gross - refunds - voids - discounts`
    // formula in `build_z_report_*` therefore does NOT double-deduct
    // discounts: gross is pre-discount, subtracting `discounts_total`
    // brings it back to post-discount revenue, and the remaining
    // refund/void subtractions are on money that was actually recognised
    // but later returned. If the schema convention for `total_amount`
    // ever changes (e.g. starts storing pre-discount), this reconstruction
    // formula MUST change too.
    // Gap review P0-03: exclude live never-settled table tabs from shift gross —
    // same rule as the date-based aggregates, or the single-shift Z reports
    // uncollected tab money as revenue.
    let single_shift_open_tab = business_day::open_unsettled_table_tab_expr("orders");
    let single_shift_order_agg_sql = format!(
        "SELECT COUNT(*) as cnt,
                COALESCE(SUM(total_amount + COALESCE(discount_amount, 0)), 0) as gross,
                COALESCE(SUM(discount_amount), 0) as discounts,
                COALESCE(SUM(tip_amount), 0) as tips
         FROM orders
         WHERE staff_shift_id = ?1
           AND COALESCE(is_ghost, 0) = 0
           AND COALESCE(is_test, 0) = 0
           AND COALESCE(order_context, '') <> 'repair_settlement'
           AND status NOT IN ('cancelled', 'canceled')
           AND NOT {single_shift_open_tab}"
    );
    let order_agg = conn
        .query_row(&single_shift_order_agg_sql, params![shift_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })
        .unwrap_or((0, 0.0, 0.0, 0.0));

    let (ordinary_total_orders, ordinary_gross_sales, discounts_total, tips_total) = order_agg;
    let total_orders = ordinary_total_orders + repair_orders_count;
    let gross_sales = ordinary_gross_sales + repair_tender_sales;

    // Payments: breakdown by method
    let mut pay_stmt = conn
        .prepare(
            // W4b-iii: cents-with-real-fallback shim (removed in 4e).
            // THE-437: platform_ref splits bank-settled platform money out of
            // `other` — see the multi-shift twin in build_z_report_for_date.
            "SELECT op.method,
                    CASE WHEN op.method NOT IN ('cash','card','twint')
                              AND COALESCE(op.transaction_ref, '') LIKE 'platform_settlement:%'
                         THEN COALESCE(op.transaction_ref, '')
                         ELSE '' END AS platform_ref,
                    COUNT(*) as cnt,
                    COALESCE(SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER))), 0) as total,
                    COALESCE(SUM(CASE WHEN op.method = 'twint' AND o.status IN ('cancelled','canceled','refunded') THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)) ELSE 0 END),0) as retained_total
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.staff_shift_id = ?1
               AND (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = ''))
               AND COALESCE(o.is_ghost, 0) = 0
               AND COALESCE(o.is_test, 0) = 0
               AND COALESCE(o.order_context, '') <> 'repair_settlement'
               AND (?2 = '' OR o.branch_id = ?2 OR o.branch_id IS NULL)
               AND (op.method <> 'twint' OR op.currency = 'CHF')
               AND (op.method = 'twint' OR o.status NOT IN ('cancelled', 'canceled', 'refunded'))
             GROUP BY op.method, platform_ref",
        )
        .map_err(|e| format!("prepare payment query: {e}"))?;

    let mut cash_sales = 0.0_f64;
    let mut card_sales = 0.0_f64;
    let mut twint_sales = 0.0_f64;
    let mut retained_twint_sales = 0.0_f64;
    let mut other_sales = 0.0_f64;
    let mut platform_online_sales = 0.0_f64;
    let mut platform_cod_sales = 0.0_f64;
    let mut cash_count = 0_i64;
    let mut card_count = 0_i64;
    let mut twint_count = 0_i64;
    let mut other_count = 0_i64;
    let mut platform_online_count = 0_i64;
    let mut platform_cod_count = 0_i64;

    let pay_rows = pay_stmt
        .query_map(params![shift_id, branch_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?;

    for row in pay_rows.flatten() {
        let (method, platform_ref, count, total, retained_total) = row;
        match method.as_str() {
            "cash" => {
                cash_sales += total;
                cash_count += count;
            }
            "card" => {
                card_sales += total;
                card_count += count;
            }
            "twint" => {
                twint_sales += total;
                retained_twint_sales += retained_total;
                twint_count += count;
            }
            _ if platform_ref.starts_with("platform_settlement:online") => {
                platform_online_sales += total;
                platform_online_count += count;
            }
            _ if platform_ref.starts_with("platform_settlement:cod") => {
                platform_cod_sales += total;
                platform_cod_count += count;
            }
            _ => {
                other_sales += total;
                other_count += count;
            }
        }
    }
    cash_sales += repair_cash_sales;
    card_sales += repair_card_sales;
    other_sales += repair_tender_sales - repair_cash_sales - repair_card_sales;
    if repair_orders_count > 0 {
        if repair_cash_sales.abs() > 0.000001 && repair_card_sales.abs() <= 0.000001 {
            cash_count += repair_orders_count;
        } else if repair_card_sales.abs() > 0.000001 && repair_cash_sales.abs() <= 0.000001 {
            card_count += repair_orders_count;
        } else {
            other_count += repair_orders_count;
        }
    }

    // Adjustments: refunds and voids.
    //
    // Use COALESCE(op.staff_shift_id, o.staff_shift_id) so adjustments on
    // orders whose payment row has a NULL staff_shift_id (delivery orders,
    // unassigned driver) still aggregate under the owning shift via the
    // order's shift_id. Previously the bare `op.staff_shift_id = ?1` filter
    // silently dropped these, under-reporting refunds/voids in the Z-report.
    let mut adj_stmt = conn
        .prepare(
            // W4b-iii: cents-with-real-fallback shim (removed in 4e).
            "SELECT pa.adjustment_type,
                    COALESCE(SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER))), 0)
             FROM payment_adjustments pa
             JOIN order_payments op ON pa.payment_id = op.id
             JOIN orders o ON o.id = op.order_id
             WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
               AND COALESCE(o.is_ghost, 0) = 0
               AND COALESCE(o.is_test, 0) = 0
               AND COALESCE(o.order_context, '') <> 'repair_settlement'
               AND o.status NOT IN ('cancelled', 'canceled')
             GROUP BY pa.adjustment_type",
        )
        .map_err(|e| format!("prepare adjustment query: {e}"))?;

    let mut refunds_total = 0.0_f64;
    let mut voids_total = 0.0_f64;

    let adj_rows = adj_stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
            ))
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
    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    let expenses_total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
             FROM shift_expenses WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    // Expense items for report_json
    let mut exp_stmt = conn
        .prepare(
            // W4b-iii: cents-with-real-fallback shim (removed in 4e).
            "SELECT se.id, se.expense_type,
                    COALESCE(se.amount_cents, CAST(ROUND(se.amount * 100) AS INTEGER), 0),
                    se.description, se.created_at, ss.staff_name
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
                "amount": Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                "description": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "createdAt": row.get::<_, String>(4)?,
                "staffName": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| format!("query expenses: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Cash drawer session
    // W4b-iii: cents-with-real-fallback shim on 12 monetary cols.
    let mut drawer = conn
        .query_row(
            "SELECT
                COALESCE(opening_amount_cents, CAST(ROUND(opening_amount * 100) AS INTEGER), 0),
                COALESCE(closing_amount_cents, CAST(ROUND(closing_amount * 100) AS INTEGER)),
                COALESCE(expected_amount_cents, CAST(ROUND(expected_amount * 100) AS INTEGER)),
                COALESCE(variance_amount_cents, CAST(ROUND(variance_amount * 100) AS INTEGER)),
                COALESCE(total_cash_sales_cents, CAST(ROUND(total_cash_sales * 100) AS INTEGER), 0),
                COALESCE(total_card_sales_cents, CAST(ROUND(total_card_sales * 100) AS INTEGER), 0),
                COALESCE(total_refunds_cents, CAST(ROUND(total_refunds * 100) AS INTEGER), 0),
                COALESCE(total_expenses_cents, CAST(ROUND(total_expenses * 100) AS INTEGER), 0),
                COALESCE(cash_drops_cents, CAST(ROUND(cash_drops * 100) AS INTEGER), 0),
                COALESCE(driver_cash_given_cents, CAST(ROUND(driver_cash_given * 100) AS INTEGER), 0),
                COALESCE(driver_cash_returned_cents, CAST(ROUND(driver_cash_returned * 100) AS INTEGER), 0),
                reconciled,
                COALESCE(total_staff_payments_cents, CAST(ROUND(total_staff_payments * 100) AS INTEGER), 0)
             FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                let reconciled: bool = row.get::<_, i64>(11).unwrap_or(0) != 0;
                Ok(serde_json::json!({
                    "openingTotal": Cents::new(row.get::<_, i64>(0).unwrap_or(0)).to_f64_dp2(),
                    "closing": row.get::<_, Option<i64>>(1)?
                        .map(|c| Cents::new(c).to_f64_dp2()).unwrap_or(0.0),
                    "expected": row.get::<_, Option<i64>>(2)?
                        .map(|c| Cents::new(c).to_f64_dp2()).unwrap_or(0.0),
                    "totalVariance": row.get::<_, Option<i64>>(3)?
                        .map(|c| Cents::new(c).to_f64_dp2()).unwrap_or(0.0),
                    "cashSales": Cents::new(row.get::<_, i64>(4).unwrap_or(0)).to_f64_dp2(),
                    "cardSales": Cents::new(row.get::<_, i64>(5).unwrap_or(0)).to_f64_dp2(),
                    "totalRefunds": Cents::new(row.get::<_, i64>(6).unwrap_or(0)).to_f64_dp2(),
                    "totalExpenses": Cents::new(row.get::<_, i64>(7).unwrap_or(0)).to_f64_dp2(),
                    "totalCashDrops": Cents::new(row.get::<_, i64>(8).unwrap_or(0)).to_f64_dp2(),
                    "driverCashGiven": Cents::new(row.get::<_, i64>(9).unwrap_or(0)).to_f64_dp2(),
                    "driverCashReturned": Cents::new(row.get::<_, i64>(10).unwrap_or(0)).to_f64_dp2(),
                    "unreconciledCount": if reconciled { 0 } else { 1 },
                    "staffPaymentsTotal": Cents::new(row.get::<_, i64>(12).unwrap_or(0)).to_f64_dp2(),
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

    // Order type breakdown (dine-in, takeaway, delivery).
    //
    // Wave 2b: subtract refund adjustments before emitting per-type
    // totals. Previously the query summed `orders.total_amount` only,
    // which overstates delivery/takeaway/dine-in revenue whenever
    // refunds are recorded against an order but leave the order in
    // a non-cancelled status. The per-order refund subtotal is
    // pre-aggregated in a subquery so the LEFT JOIN does not
    // multiply `total_amount` by the number of adjustments per order.
    // Gap review P0-03: exclude live never-settled table tabs, mirroring the
    // shift gross aggregate above.
    let shift_ot_open_tab = business_day::open_unsettled_table_tab_expr("o");
    let shift_ot_sql = format!(
        // W4b-iii: cents-with-real-fallback shim (removed in 4e).
        "SELECT COALESCE(o.order_type, 'dine-in'),
                COUNT(*),
                COALESCE(SUM(COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER))), 0)
                    - COALESCE(SUM(COALESCE(r.refund_sum_cents, 0)), 0) AS net_total_cents
         FROM orders o
         LEFT JOIN (
             SELECT order_id,
                    SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))) AS refund_sum_cents
             FROM payment_adjustments
             WHERE adjustment_type = 'refund'
             GROUP BY order_id
         ) r ON r.order_id = o.id
         WHERE o.staff_shift_id = ?1
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND o.status NOT IN ('cancelled', 'canceled')
           AND NOT {shift_ot_open_tab}
         GROUP BY COALESCE(o.order_type, 'dine-in')"
    );
    // Order-type NET is per-order coverage: a gift card row's proven return
    // cumulative counts once, as in settlement coverage, so only the part no
    // refund adjustment records here is subtracted. Refund, void and cash
    // movement totals stay bound to the recorded adjustments.
    let unrecorded_gift_returns =
        shift_unrecorded_gift_returns_by_order_type(&conn, &shift_id, &shift_ot_open_tab)?;
    let mut ot_stmt = conn
        .prepare(&shift_ot_sql)
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
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("query order_type: {e}"))?;

    for row in ot_rows.flatten() {
        let (otype, count, net_cents) = row;
        let unrecorded = unrecorded_gift_returns.get(&otype).copied().unwrap_or(0);
        let total = Cents::new(net_cents - unrecorded).to_f64_dp2();
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

    // net_sales subtracts voids_total from gross_sales. This is NOT double-counting
    // with cash_sales/card_sales: gross_sales comes from `orders.total_amount`
    // (order-level, includes orders whose payments were later voided), while
    // cash_sales/card_sales come from `op.status = 'completed'` (payment-level,
    // excludes voided payments). Gross is an order-side figure; voids adjust it
    // down to money actually recognized. A prior review flagged this as a possible
    // double-deduction — it isn't.
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
        "twint": { "count": twint_count, "total": twint_sales },
        "other": { "count": other_count, "total": other_sales },
        "platform_online": { "count": platform_online_count, "total": platform_online_sales },
        "platform_cod": { "count": platform_cod_count, "total": platform_cod_sales },
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
    let period_start = check_in_time
        .as_deref()
        .unwrap_or_else(|| check_out_time.as_deref().unwrap_or(now.as_str()));
    let period_end = check_out_time.as_deref().unwrap_or(now.as_str());

    // Build full report_json (matches Electron POS shape for server compat).
    // W4d-iv additive emission: every monetary float key (top-level and
    // nested) carries a `_cents` integer sibling so admin-dashboard can
    // read either shape during the bake window.
    let total_sales = gross_sales - discounts_total;
    let day_total = cash_sales
        + card_sales
        + twint_sales
        + other_sales
        + platform_online_sales
        + platform_cod_sales;
    if !gift_close.is_empty() {
        if let Some(drawer) = drawer.as_mut() {
            // The adopted mirror's expected is already the canonical total.
            let expected_cents = drawer
                .get("expected")
                .and_then(Value::as_f64)
                .map(|value| Cents::round_half_even(value).as_i64())
                .unwrap_or_default();
            gift_close.annotate_drawer(drawer, expected_cents);
        }
    }
    let currency = common_report_currency(report_currency_from_staff(&staff_reports, &gift_close));
    let presentation = load_z_report_presentation(db, &conn, &branch_id);
    let mut report_json = serde_json::json!({
        "currency": currency,
        "presentation": presentation,
        "paymentsBreakdown": payments_breakdown,
        "date": report_date,
        "shifts": shift_counts,
        "sales": {
            "totalOrders": total_orders,
            "totalSales": total_sales,
            "totalSales_cents": Cents::round_half_even(total_sales).as_i64(),
            "discountsTotal": discounts_total,
            "discountsTotal_cents": Cents::round_half_even(discounts_total).as_i64(),
            "cashSales": cash_sales,
            "cashSales_cents": Cents::round_half_even(cash_sales).as_i64(),
            "cardSales": card_sales,
            "cardSales_cents": Cents::round_half_even(card_sales).as_i64(),
            "twintSales": twint_sales,
            "twintPaymentCount": twint_count,
            "retainedTwintSales": retained_twint_sales,
            "retainedTwintSalesCents": Cents::round_half_even(retained_twint_sales).as_i64(),
            "twintSalesCents": Cents::round_half_even(twint_sales).as_i64(),
            "twint_sales_cents": Cents::round_half_even(twint_sales).as_i64(),
            "platformOnlineSales": platform_online_sales,
            "platformOnlineSales_cents": Cents::round_half_even(platform_online_sales).as_i64(),
            "platformCodSales": platform_cod_sales,
            "platformCodSales_cents": Cents::round_half_even(platform_cod_sales).as_i64(),
            "dineInOrders": dine_in_orders,
            "dineInSales": dine_in_sales,
            "dineInSales_cents": Cents::round_half_even(dine_in_sales).as_i64(),
            "takeawayOrders": takeaway_orders,
            "takeawaySales": takeaway_sales,
            "takeawaySales_cents": Cents::round_half_even(takeaway_sales).as_i64(),
            "deliveryOrders": delivery_orders,
            "deliverySales": delivery_sales,
            "deliverySales_cents": Cents::round_half_even(delivery_sales).as_i64(),
            // Repair tender/revenue is server-owned and never mirrored into
            // the generic local order/payment queues. Older JSON omits these
            // keys; readers default them to zero.
            "repairOrders": repair_orders_count,
            "repairSales": repair_tender_sales,
            "repairSales_cents": Cents::round_half_even(repair_tender_sales).as_i64(),
            "byType": sales_by_type,
        },
        "cashDrawer": drawer.as_ref().unwrap_or(&serde_json::json!({
            "totalVariance": variance,
            "totalVariance_cents": Cents::round_half_even(variance).as_i64(),
            "openingTotal": opening,
            "openingTotal_cents": Cents::round_half_even(opening).as_i64(),
        })),
        "expenses": {
            "total": expenses_total,
            "total_cents": Cents::round_half_even(expenses_total).as_i64(),
            "staffPaymentsTotal": staff_payments_total,
            "staffPaymentsTotal_cents": Cents::round_half_even(staff_payments_total).as_i64(),
            "pendingCount": pending_expenses_count,
            "items": expense_items,
        },
        "driverEarnings": driver_summary,
        "drawers": drawer_rows,
        "staffPayments": {
            "total": staff_payments_total,
            "total_cents": Cents::round_half_even(staff_payments_total).as_i64(),
        },
        "tips": {
            "total": tips_total,
            "total_cents": Cents::round_half_even(tips_total).as_i64(),
        },
        "daySummary": {
            "cashTotal": cash_sales,
            "cashTotal_cents": Cents::round_half_even(cash_sales).as_i64(),
            "cardTotal": card_sales,
            "cardTotal_cents": Cents::round_half_even(card_sales).as_i64(),
            "twintTotal": twint_sales,
            "twintTotal_cents": Cents::round_half_even(twint_sales).as_i64(),
            "platformOnlineTotal": platform_online_sales,
            "platformOnlineTotal_cents": Cents::round_half_even(platform_online_sales).as_i64(),
            "platformCodTotal": platform_cod_sales,
            "platformCodTotal_cents": Cents::round_half_even(platform_cod_sales).as_i64(),
            "total": day_total,
            "total_cents": Cents::round_half_even(day_total).as_i64(),
            "totalOrders": total_orders,
        },
        "staffReports": staff_reports,
    });
    if !gift_close.is_empty() {
        if let Some(obj) = report_json.as_object_mut() {
            obj.insert(
                GIFT_CLOSE_REPORT_KEY.to_string(),
                gift_close.projection_value(),
            );
        }
    }
    canonicalize_report_json_period(&mut report_json, period_start, period_end);

    // --- Persist in transaction ---

    let z_report_id = Uuid::new_v4().to_string();
    let payments_json_str = payments_breakdown.to_string();
    let report_json_str = report_json.to_string();
    let idempotency_key = format!("zreport:{z_report_id}");

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    // Re-check idempotency inside the BEGIN IMMEDIATE critical section.
    // The pre-transaction SELECT near the top of this function is a fast
    // path that avoids doing the aggregation work if a report already
    // exists, but two concurrent callers can both pass that early check
    // and then serialize on this write lock. Without this re-check the
    // second caller would INSERT a duplicate z_report row for the same
    // shift_id (there is no UNIQUE constraint on z_reports.shift_id).
    let racing_existing: Option<String> = conn
        .query_row(
            "SELECT id FROM z_reports WHERE shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(existing_id) = racing_existing {
        // Wave 6: ROLLBACK, not COMMIT. We opened BEGIN IMMEDIATE but
        // performed no writes on the idempotency-race short-circuit
        // path; COMMIT forces a zero-op WAL checkpoint marker.
        // ROLLBACK is semantically identical (no writes to undo) and
        // keeps the journal clean.
        let _ = conn.execute_batch("ROLLBACK");
        ensure_gift_close_snapshot_current(&conn, &existing_id, &gift_close)?;
        return get_z_report_by_id(&conn, &existing_id).map(|report| {
            serde_json::json!({
                "success": true,
                "existing": true,
                "report": report,
            })
        });
    }

    // W4c dual-write: every monetary REAL column gets its `_cents` sibling.
    let gross_sales_cents = Cents::round_half_even(gross_sales).as_i64();
    let net_sales_cents = Cents::round_half_even(net_sales).as_i64();
    let cash_sales_cents = Cents::round_half_even(cash_sales).as_i64();
    let card_sales_cents = Cents::round_half_even(card_sales).as_i64();
    let refunds_total_cents = Cents::round_half_even(refunds_total).as_i64();
    let voids_total_cents = Cents::round_half_even(voids_total).as_i64();
    let discounts_total_cents = Cents::round_half_even(discounts_total).as_i64();
    let tips_total_cents = Cents::round_half_even(tips_total).as_i64();
    let expenses_total_cents = Cents::round_half_even(expenses_total).as_i64();
    let variance_cents = Cents::round_half_even(variance).as_i64();
    let opening_cents = Cents::round_half_even(opening).as_i64();
    let closing_cents = Cents::round_half_even(closing).as_i64();
    let expected_cents = Cents::round_half_even(expected).as_i64();
    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO z_reports (
                id, shift_id, branch_id, terminal_id, report_date, generated_at,
                gross_sales, gross_sales_cents,
                net_sales, net_sales_cents,
                total_orders,
                cash_sales, cash_sales_cents,
                card_sales, card_sales_cents,
                refunds_total, refunds_total_cents,
                voids_total, voids_total_cents,
                discounts_total, discounts_total_cents,
                tips_total, tips_total_cents,
                expenses_total, expenses_total_cents,
                cash_variance, cash_variance_cents,
                opening_cash, opening_cash_cents,
                closing_cash, closing_cash_cents,
                expected_cash, expected_cash_cents,
                payments_breakdown_json, report_json,
                sync_state, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8,
                ?9, ?10,
                ?11,
                ?12, ?13,
                ?14, ?15,
                ?16, ?17,
                ?18, ?19,
                ?20, ?21,
                ?22, ?23,
                ?24, ?25,
                ?26, ?27,
                ?28, ?29,
                ?30, ?31,
                ?32, ?33,
                ?34, ?35,
                'pending', ?36, ?36
             )",
            params![
                z_report_id,
                shift_id,
                branch_id,
                terminal_id,
                report_date,
                now,
                gross_sales,
                gross_sales_cents,
                net_sales,
                net_sales_cents,
                total_orders,
                cash_sales,
                cash_sales_cents,
                card_sales,
                card_sales_cents,
                refunds_total,
                refunds_total_cents,
                voids_total,
                voids_total_cents,
                discounts_total,
                discounts_total_cents,
                tips_total,
                tips_total_cents,
                expenses_total,
                expenses_total_cents,
                variance,
                variance_cents,
                opening,
                opening_cents,
                closing,
                closing_cents,
                expected,
                expected_cents,
                payments_json_str,
                report_json_str,
                now,
            ],
        )
        .map_err(|e| format!("insert z_report: {e}"))?;

        // Wave 5 Session 6: enqueue via canonical parity queue. The legacy
        // stamp `idempotency_key` ("zreport:{id}") is no longer needed —
        // parity's default dispatch reads the entity row's idempotency_key
        // column, and for `z_reports` (not in v47) falls back to the
        // deterministic synthetic `entity:z_reports:{id}`. Admin dedup is
        // on the business key (z_report_id + shift_id), so format changes
        // don't break exactly-once.
        let _ = idempotency_key; // Kept in scope for log tracing elsewhere.
        let sync_payload = serde_json::json!({
            "terminal_id": terminal_id,
            "branch_id": branch_id,
            "report_date": report_date,
            "report_data": report_json,
        });

        sync_queue::enqueue_payload_item(
            &conn,
            "z_reports",
            &z_report_id,
            "INSERT",
            &sync_payload,
            Some(1),
            Some("z_report"),
            Some("manual"),
            Some(1),
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

    // Deliberately NO `last_z_report_timestamp` write here: generating a Z
    // row is not closing the day. `report_generate_z_report` generates and
    // then DISCARDS a single-shift report as a preview, and the submission
    // flow can fail after generation — advancing the retention marker from
    // this function would let a mere preview hide (and later prune) orders
    // no Z has settled. The marker moves only inside
    // `apply_local_day_rollover`'s transaction, the atomic close that also
    // discards the Z on failure.

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
            "currency": report_json.get("currency").cloned().unwrap_or(Value::Null),
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
            "twintSales": twint_sales,
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
pub fn print_z_report(
    db: &DbState,
    payload: &Value,
    invalidator: &dyn crate::print::PrintQueueInvalidator,
) -> Result<Value, String> {
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

    crate::print::enqueue_print_job(db, "z_report", &z_report_id, None, invalidator)
}

fn get_end_of_day_status_at(
    db: &DbState,
    payload: &Value,
    now: DateTime<Utc>,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());

    let now_rfc3339 = now.to_rfc3339();
    let _ = order_ownership::repair_historical_pickup_financial_attribution(
        &conn,
        branch_id.as_str(),
        &now_rfc3339,
    )?;
    let active_period_start_at =
        resolve_period_start_at(&conn, &branch_id, Some(now_rfc3339.as_str()));
    let active_report_date =
        business_day::current_business_day_report_date_at(&conn, now.with_timezone(&Local));

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

    if let Some(context) =
        load_pending_z_report_context_at(&conn, &branch_id, now.with_timezone(&Local))
    {
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

pub fn get_end_of_day_status(db: &DbState, payload: &Value) -> Result<Value, String> {
    get_end_of_day_status_at(db, payload, Utc::now())
}

// ---------------------------------------------------------------------------
// Multi-shift aggregation (Gap 7)
// ---------------------------------------------------------------------------

/// Build a multi-shift Z-report snapshot for a branch/date window.
///
/// The returned value is not persisted. Callers choose whether the snapshot
/// is used as a preview or materialized into `z_reports` and `sync_queue`.
/// Orders this Z window would have counted before 16/09/2026 but that belong
/// to a day an earlier Z already closed (see
/// `business_day::z_report_reportable_order_expr`). Reported, never totalled:
/// hiding money silently is the failure mode we are fixing, not the fix.
fn load_carried_over_from_closed_days(
    conn: &Connection,
    branch_id: &str,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
    last_z_anchor: Option<&str>,
) -> Result<Value, String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let financial_predicate = lower_bound_mode.sql_predicate(&financial_expr, "?1");
    let swept = business_day::paid_order_swept_by_last_z_expr("o", "?4");
    let sql = format!(
        "SELECT COUNT(*),
                COALESCE(SUM(COALESCE(o.total_amount_cents,
                                      CAST(ROUND(o.total_amount * 100) AS INTEGER), 0)), 0)
         FROM orders o
         WHERE {financial_predicate}
           AND (?2 IS NULL OR {financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND o.status NOT IN ('cancelled', 'canceled')
           AND {swept}"
    );
    let (count, amount_cents) = conn
        .query_row(
            &sql,
            params![period_start, cutoff_at, branch_id, last_z_anchor],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .unwrap_or((0, 0));

    Ok(serde_json::json!({
        "orders": count,
        "amount": Cents::new(amount_cents).to_f64_dp2(),
        "amount_cents": amount_cents,
    }))
}

/// Orders whose `plugin` names a source we cannot classify — neither one of
/// our own channels nor a marketplace we know.
///
/// These are deliberately NOT filed under ΠΛΑΤΦΟΡΜΕΣ (see `crate::platforms`
/// for why: `plugin` shares its namespace with payment gateways, analytics and
/// e-commerce integrations, and guessing an unrecognised slug into a delivery
/// marketplace would be a fabrication). Their money is untouched — it stays in
/// `sales.totalSales` and `daySummary.total` like any other order, because the
/// platform block is a breakdown, not a total. Only the attribution is
/// withheld, and it is withheld out loud: the slug, the count and the amount
/// are reported here so the slug can be added to the classifier.
fn load_unclassified_platform_sources(
    conn: &Connection,
    branch_id: &str,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
    last_z_anchor: Option<&str>,
) -> Result<Vec<Value>, String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let financial_predicate = lower_bound_mode.sql_predicate(&financial_expr, "?1");
    let reportable_order = business_day::z_report_reportable_order_expr("o", "?4");
    let is_unknown = crate::platforms::unknown_platform_sql_predicate("o.plugin");
    let sql = format!(
        "SELECT LOWER(TRIM(COALESCE(o.plugin, ''))) AS source,
                COUNT(*),
                COALESCE(SUM(COALESCE(o.total_amount_cents,
                                      CAST(ROUND(o.total_amount * 100) AS INTEGER), 0)), 0)
         FROM orders o
         WHERE {financial_predicate}
           AND (?2 IS NULL OR {financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND o.status NOT IN ('cancelled', 'canceled')
           AND {reportable_order}
           AND {is_unknown}
         GROUP BY source
         ORDER BY source"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare unclassified platform sources: {e}"))?;
    let rows = stmt
        .query_map(
            params![period_start, cutoff_at, branch_id, last_z_anchor],
            |row| {
                let source: String = row.get(0)?;
                let orders: i64 = row.get(1)?;
                let amount_cents: i64 = row.get(2)?;
                Ok(serde_json::json!({
                    "source": source,
                    "orders": orders,
                    "amount": Cents::new(amount_cents).to_f64_dp2(),
                    "amount_cents": amount_cents,
                }))
            },
        )
        .map_err(|e| format!("query unclassified platform sources: {e}"))?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

/// The part of `orderTurnover - paymentCoverage` that has a LEGITIMATE
/// explanation, so a healthy day does not read as a financial gap.
///
/// Review item C (16/09/2026): the two sides count different populations by
/// design. Turnover excludes only `cancelled`/`canceled`; the payment query
/// also excludes `refunded`, because a refunded order's money went back to the
/// customer and must not be reported as takings. The order itself still
/// belongs to the day's gross (the refunds line subtracts it separately), so a
/// fully-refunded order leaves a non-zero difference with no finding behind it
/// — and the panel painted that red.
///
/// A partial refund recorded as a `payment_adjustments` row moves NEITHER side
/// (coverage is gross completed payments), so the founder's «order paid then
/// €0,70 refunded» day nets to zero difference on its own. It is the
/// order-level `refunded` STATUS that opens the gap, and this is what accounts
/// for it.
///
/// Anything this does NOT explain is a real break and stays visible.
fn load_reconciliation_explanations(
    conn: &Connection,
    branch_id: &str,
    period_start: &str,
    cutoff_at: Option<&str>,
    lower_bound_mode: LowerBoundMode,
    last_z_anchor: Option<&str>,
) -> Result<(i64, i64), String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let financial_predicate = lower_bound_mode.sql_predicate(&financial_expr, "?1");
    let reportable_order = business_day::z_report_reportable_order_expr("o", "?4");
    // Same population as the turnover aggregate, narrowed to the orders the
    // payment side deliberately drops.
    let sql = format!(
        "SELECT COUNT(*),
                COALESCE(SUM(COALESCE(o.total_amount_cents,
                                      CAST(ROUND(o.total_amount * 100) AS INTEGER), 0)), 0)
         FROM orders o
         WHERE {financial_predicate}
           AND (?2 IS NULL OR {financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND LOWER(TRIM(COALESCE(o.status, ''))) = 'refunded'
           AND {reportable_order}"
    );
    conn.query_row(
        &sql,
        params![period_start, cutoff_at, branch_id, last_z_anchor],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .map_err(|e| format!("load reconciliation explanations: {e}"))
}

/// The Z-report reconciliation block: does the order side of the day agree
/// with the payment side, and if not, exactly which orders break it?
///
/// Founder rule (16/09/2026): «Αν ένα order θεωρείται οικονομικά paid, πρέπει
/// να υπάρχει αντίστοιχη canonical completed payment κάλυψη για το ποσό του.»
/// This block is how the Z proves that rule held for the day — and refuses to
/// close when it did not.
///
/// `orderTurnover` is the order side (Σ order totals, = `sales.totalSales`);
/// `paymentCoverage` is the ledger side (Σ completed payments, =
/// `daySummary.total`). They are reported SEPARATELY and never summed: the
/// founder's efood «x43 / €504,80» is platform turnover already inside both,
/// not an extra amount to add on top.
fn build_z_integrity_block(
    order_turnover: f64,
    payment_coverage: f64,
    carried_over: &Value,
    unclassified_platforms: &[Value],
    refunded_orders: (i64, i64),
    blockers: &[UnsettledPaymentBlocker],
) -> Value {
    let mut uncovered_cents = 0_i64;
    let mut excess_cents = 0_i64;
    let mut blocking = 0_i64;
    let mut warnings = 0_i64;
    let mut by_reason: std::collections::BTreeMap<String, (i64, i64)> =
        std::collections::BTreeMap::new();

    for blocker in blockers {
        if blocker.is_blocking() {
            blocking += 1;
        } else {
            warnings += 1;
        }
        let difference = blocker.difference_cents;
        if difference > 0 {
            uncovered_cents += difference;
        } else {
            excess_cents += -difference;
        }
        let entry = by_reason
            .entry(blocker.reason_code.clone())
            .or_insert((0, 0));
        entry.0 += 1;
        entry.1 += difference;
    }

    let reasons: Vec<Value> = by_reason
        .into_iter()
        .map(|(reason_code, (count, difference_cents))| {
            serde_json::json!({
                "reasonCode": reason_code,
                "orders": count,
                "differenceCents": difference_cents,
                "difference": Cents::new(difference_cents).to_f64_dp2(),
            })
        })
        .collect();

    let turnover_cents = Cents::round_half_even(order_turnover).as_i64();
    let coverage_cents = Cents::round_half_even(payment_coverage).as_i64();
    let difference_cents = turnover_cents - coverage_cents;

    // The two sides count different populations on purpose (see
    // `load_reconciliation_explanations`). Subtract what that accounts for;
    // only the residual is a real break.
    let (refunded_order_count, refunded_order_cents) = refunded_orders;
    let explained_cents = refunded_order_cents;
    let unexplained_cents = difference_cents - explained_cents;
    // `reconciled` is the single flag the UI colours on and the operator
    // reads. It must mean "nothing here is wrong", not "the arithmetic is
    // zero" — a legitimate refund must not paint the panel red, and a real
    // gap must not be excused by one.
    let reconciled = blocking == 0 && unexplained_cents == 0;

    serde_json::json!({
        // Order side vs ledger side. Shown side by side in the Z; never added.
        "orderTurnover": Cents::new(turnover_cents).to_f64_dp2(),
        "orderTurnover_cents": turnover_cents,
        "paymentCoverage": Cents::new(coverage_cents).to_f64_dp2(),
        "paymentCoverage_cents": coverage_cents,
        "difference": Cents::new(difference_cents).to_f64_dp2(),
        "difference_cents": difference_cents,
        // Difference with a known, legitimate cause — today: orders whose
        // `refunded` status keeps them in turnover but out of coverage.
        "explainedDifference": Cents::new(explained_cents).to_f64_dp2(),
        "explainedDifference_cents": explained_cents,
        "refundedOrders": {
            "orders": refunded_order_count,
            "amount": Cents::new(refunded_order_cents).to_f64_dp2(),
            "amount_cents": refunded_order_cents,
        },
        // What is left over. THIS is the number that means something is wrong.
        "unexplainedDifference": Cents::new(unexplained_cents).to_f64_dp2(),
        "unexplainedDifference_cents": unexplained_cents,
        // Money the day is short because a paid order has no ledger row.
        "uncoveredAmount": Cents::new(uncovered_cents).to_f64_dp2(),
        "uncoveredAmount_cents": uncovered_cents,
        // Money the ledger holds beyond the orders' worth (overpay/duplicate).
        "excessAmount": Cents::new(excess_cents).to_f64_dp2(),
        "excessAmount_cents": excess_cents,
        "blockingFindings": blocking,
        "warningFindings": warnings,
        "findingsByReason": reasons,
        "findings": blockers,
        "carriedOverFromClosedDays": carried_over.clone(),
        // Sources recorded on orders that name neither our own channels nor a
        // marketplace we know. Their money is fully counted in the totals
        // above; only their attribution to a platform is withheld, and it is
        // named here so the slug can be classified.
        "unclassifiedPlatforms": unclassified_platforms.to_vec(),
        "reconciled": reconciled,
    })
}

fn build_z_report_for_date(
    db: &DbState,
    payload: &Value,
    include_active_shifts: bool,
) -> Result<BuiltDateZReport, String> {
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
    let repair_projection = load_server_repair_projection(
        &conn,
        branch_id.as_str(),
        period_start.as_str(),
        period_end.as_str(),
    )?;
    let repair_orders_count = repair_projection
        .get("repairOrders")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let repair_tender_sales = repair_projection
        .get("repairSales")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let repair_cash_sales = repair_projection
        .get("repairCashSales")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let repair_card_sales = repair_projection
        .get("repairCardSales")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    info!(
        branch_id = %branch_id,
        date = %date,
        period_start = %period_start,
        cutoff_at = ?cutoff_at,
        "Generating multi-shift Z-report"
    );

    // --- Query all reportable shifts since period_start for this branch ---
    //
    // Live previews include active shifts so the Z modal can show current
    // staff status and order activity. Final Z generation still passes
    // `include_active_shifts = false`, and submission keeps its active-shift
    // precondition before any persisted report is created.
    let shift_start_predicate = lower_bound_mode.sql_predicate("check_in_time", "?1");
    let shift_status_filter = if include_active_shifts {
        "status IN ('closed', 'active')"
    } else {
        "status = 'closed'"
    };
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
               AND {shift_status_filter}
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
                status: row.get(4)?,
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
    // Gap review P0-03: open tabs are exempt from the closeout gate, so they can
    // still exist here — but their money was never collected, so they must not
    // be reported as revenue. They are counted on the day they are settled.
    //
    // 16/09/2026: the same predicate now also drops paid orders the LAST Z
    // already closed. Turnover and the payment-integrity gate must report on
    // ONE population — when they disagreed, a closed day's order whose
    // `updated_at` drifted back into the window inflated turnover while being
    // exempt from the check that would have caught it. See
    // `business_day::z_report_reportable_order_expr`.
    let last_z_anchor = business_day::last_z_anchor_utc(&conn);
    let reportable_order = business_day::z_report_reportable_order_expr("o", "?4");
    let order_agg_sql = format!(
        // W4b-iii: cents-with-real-fallback shim (removed in 4e).
        "SELECT COUNT(*) as cnt,
                COALESCE(SUM(COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER))
                             + COALESCE(o.discount_amount_cents, CAST(ROUND(o.discount_amount * 100) AS INTEGER), 0)), 0) as gross_cents,
                COALESCE(SUM(COALESCE(o.discount_amount_cents, CAST(ROUND(o.discount_amount * 100) AS INTEGER))), 0) as discounts_cents,
                COALESCE(SUM(COALESCE(o.tip_amount_cents, CAST(ROUND(o.tip_amount * 100) AS INTEGER))), 0) as tips_cents
         FROM orders o
         WHERE {financial_predicate}
           AND (?2 IS NULL OR {financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND o.status NOT IN ('cancelled', 'canceled')
           AND {reportable_order}"
    );
    let order_agg = conn
        .query_row(
            &order_agg_sql,
            params![period_start, cutoff_param, branch_id, last_z_anchor],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                    Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                ))
            },
        )
        .unwrap_or((0, 0.0, 0.0, 0.0));

    let (ordinary_orders, ordinary_gross_sales, discounts_total, tips_total) = order_agg;

    // What the predicate above held back, so it is excluded from the totals
    // but never from the operator's sight (rendered as «μεταφορά από κλεισμένη
    // ημέρα» in the Z reconciliation panel).
    let carried_over = load_carried_over_from_closed_days(
        &conn,
        branch_id.as_str(),
        period_start.as_str(),
        cutoff_param,
        lower_bound_mode,
        last_z_anchor.as_deref(),
    )?;
    let total_orders = ordinary_orders + repair_orders_count;
    let gross_sales = ordinary_gross_sales + repair_tender_sales;

    // --- Payments: breakdown by method across all shifts ---
    let payment_scope_expr = business_day::order_financial_timestamp_expr("o");
    let payment_scope_predicate = lower_bound_mode.sql_predicate(&payment_scope_expr, "?1");
    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    // THE-437: platform-settled money (prepaid online, or COD collected by the
    // platform's own rider) is auto-recorded as method='other' with a
    // `platform_settlement:*` transaction_ref. Split it out of the catch-all
    // `other` bucket so the Z shows it as its own line — revenue that arrives
    // by bank settlement and must never look like drawer cash.
    //
    // Population parity with the turnover aggregate above (review item E,
    // 16/09/2026). This query carries no `{reportable_order}` clause and does
    // not need one: BOTH halves of that predicate
    // (`open_unsettled_table_tab_expr`, `paid_order_swept_by_last_z_expr`)
    // require `NOT EXISTS (a completed order_payments row)`, and this query
    // only counts `op.status = 'completed'`. An order the predicate hides
    // therefore contributes zero here by construction — the two sides agree on
    // the same orders. Pinned by
    // `test_turnover_and_coverage_agree_on_the_reportable_population`; if that
    // predicate ever stops requiring "no completed payments", this query must
    // grow the clause (and a `?4` anchor param) or coverage will outrun
    // turnover.
    let payment_scope_sql = format!(
        "SELECT op.method,
                CASE WHEN op.method NOT IN ('cash','card','twint')
                          AND COALESCE(op.transaction_ref, '') LIKE 'platform_settlement:%'
                     THEN COALESCE(op.transaction_ref, '')
                     ELSE '' END AS platform_ref,
                COUNT(*) as cnt,
                COALESCE(SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER))), 0) as total,
                    COALESCE(SUM(CASE WHEN op.method = 'twint' AND o.status IN ('cancelled','canceled','refunded') THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)) ELSE 0 END),0) as retained_total
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
         WHERE {payment_scope_predicate}
           AND (?2 IS NULL OR {payment_scope_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = ''))
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND (op.method <> 'twint' OR op.currency = 'CHF')
           AND (op.method = 'twint' OR o.status NOT IN ('cancelled', 'canceled', 'refunded'))
         GROUP BY op.method, platform_ref"
    );
    let mut pay_stmt = conn
        .prepare(&payment_scope_sql)
        .map_err(|e| format!("prepare payment query: {e}"))?;

    let mut cash_sales = 0.0_f64;
    let mut card_sales = 0.0_f64;
    let mut twint_sales = 0.0_f64;
    let mut retained_twint_sales = 0.0_f64;
    let mut other_sales = 0.0_f64;
    let mut platform_online_sales = 0.0_f64;
    let mut platform_cod_sales = 0.0_f64;
    let mut cash_count = 0_i64;
    let mut card_count = 0_i64;
    let mut twint_count = 0_i64;
    let mut other_count = 0_i64;
    let mut platform_online_count = 0_i64;
    let mut platform_cod_count = 0_i64;

    let pay_rows = pay_stmt
        .query_map(params![period_start, cutoff_param, branch_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?;

    for row in pay_rows.flatten() {
        let (method, platform_ref, count, total, retained_total) = row;
        match method.as_str() {
            "cash" => {
                cash_sales += total;
                cash_count += count;
            }
            "card" => {
                card_sales += total;
                card_count += count;
            }
            "twint" => {
                twint_sales += total;
                retained_twint_sales += retained_total;
                twint_count += count;
            }
            _ if platform_ref.starts_with("platform_settlement:online") => {
                platform_online_sales += total;
                platform_online_count += count;
            }
            _ if platform_ref.starts_with("platform_settlement:cod") => {
                platform_cod_sales += total;
                platform_cod_count += count;
            }
            _ => {
                other_sales += total;
                other_count += count;
            }
        }
    }
    cash_sales += repair_cash_sales;
    card_sales += repair_card_sales;
    other_sales += repair_tender_sales - repair_cash_sales - repair_card_sales;
    if repair_orders_count > 0 {
        if repair_cash_sales.abs() > 0.000001 && repair_card_sales.abs() <= 0.000001 {
            cash_count += repair_orders_count;
        } else if repair_card_sales.abs() > 0.000001 && repair_cash_sales.abs() <= 0.000001 {
            card_count += repair_orders_count;
        } else {
            other_count += repair_orders_count;
        }
    }

    // --- Per-platform breakdown (founder request 01/09/2026) ---
    //
    // The Z slip gets a ΠΛΑΤΦΟΡΜΕΣ section mirroring ΕΞΟΔΑ: per platform,
    // orders carried by the platform's own rider show count + amount (bank
    // money), while orders delivered by the store's own driver split into
    // the cash/card actually collected (those also keep appearing inside the
    // driver's own checkout section, unchanged).
    #[derive(Default)]
    struct PlatformDayAgg {
        fleet_orders: i64,
        fleet_amount: f64,
        vendor_orders: i64,
        vendor_amount: f64,
        vendor_cash: f64,
        vendor_card: f64,
    }
    let mut platform_aggs: std::collections::BTreeMap<String, PlatformDayAgg> =
        std::collections::BTreeMap::new();
    {
        let platform_scope_expr = business_day::order_financial_timestamp_expr("o");
        let platform_scope_predicate = lower_bound_mode.sql_predicate(&platform_scope_expr, "?1");
        // «POS x37» (founder, 16/09/2026): this block used to group every
        // order whose `plugin` was merely non-empty, so the store's own till
        // (`plugin = 'pos'`) printed inside ΠΛΑΤΦΟΡΜΕΣ next to efood and
        // Wolt. Only a marketplace we can NAME belongs here — the list is
        // closed, and anything else is reported as unclassified rather than
        // filed under a platform. See `crate::platforms`.
        let is_external_platform = crate::platforms::external_marketplace_sql_predicate("o.plugin");
        // instr() instead of LIKE: the marker contains `_`, which LIKE treats
        // as a single-character wildcard.
        let platform_orders_sql = format!(
            "SELECT LOWER(TRIM(COALESCE(o.plugin, ''))) AS platform,
                    CASE WHEN instr(COALESCE(o.ghost_metadata, ''),
                                    '\"delivery_provider\":\"platform_delivery\"') > 0
                         THEN 1 ELSE 0 END AS platform_fleet,
                    COUNT(*) AS cnt,
                    COALESCE(SUM(COALESCE(o.total_amount_cents,
                                          CAST(ROUND(o.total_amount * 100) AS INTEGER), 0)), 0)
             FROM orders o
             WHERE {platform_scope_predicate}
               AND (?2 IS NULL OR {platform_scope_expr} <= ?2)
               AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
               AND COALESCE(o.is_ghost, 0) = 0
               AND COALESCE(o.is_test, 0) = 0
               AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
               AND {is_external_platform}
               AND {reportable_order}
             GROUP BY platform, platform_fleet"
        );
        let mut platform_stmt = conn
            .prepare(&platform_orders_sql)
            .map_err(|e| format!("prepare platform breakdown query: {e}"))?;
        let platform_rows = platform_stmt
            .query_map(
                params![period_start, cutoff_param, branch_id, last_z_anchor],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                    ))
                },
            )
            .map_err(|e| format!("query platform breakdown: {e}"))?;
        for row in platform_rows.flatten() {
            let (platform, is_platform_fleet, count, total) = row;
            let agg = platform_aggs.entry(platform).or_default();
            if is_platform_fleet == 1 {
                agg.fleet_orders += count;
                agg.fleet_amount += total;
            } else {
                agg.vendor_orders += count;
                agg.vendor_amount += total;
            }
        }

        let vendor_payments_sql = format!(
            "SELECT LOWER(TRIM(COALESCE(o.plugin, ''))) AS platform,
                    op.method,
                    COALESCE(SUM(COALESCE(op.amount_cents,
                                          CAST(ROUND(op.amount * 100) AS INTEGER))), 0)
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE {platform_scope_predicate}
               AND (?2 IS NULL OR {platform_scope_expr} <= ?2)
               AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
               AND (op.status = 'completed' AND NOT (COALESCE(op.payment_origin, '') = 'sync_reconstructed' AND TRIM(COALESCE(op.remote_payment_id, '')) = ''))
               AND op.method IN ('cash', 'card')
               AND COALESCE(o.is_ghost, 0) = 0
               AND COALESCE(o.is_test, 0) = 0
               AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
               AND {is_external_platform}
               AND instr(COALESCE(o.ghost_metadata, ''),
                         '\"delivery_provider\":\"platform_delivery\"') = 0
             GROUP BY platform, op.method"
        );
        let mut vendor_stmt = conn
            .prepare(&vendor_payments_sql)
            .map_err(|e| format!("prepare platform vendor payments query: {e}"))?;
        let vendor_rows = vendor_stmt
            .query_map(params![period_start, cutoff_param, branch_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                ))
            })
            .map_err(|e| format!("query platform vendor payments: {e}"))?;
        for row in vendor_rows.flatten() {
            let (platform, method, total) = row;
            let agg = platform_aggs.entry(platform).or_default();
            match method.as_str() {
                "cash" => agg.vendor_cash += total,
                "card" => agg.vendor_card += total,
                _ => {}
            }
        }
    }
    let platform_breakdown: Vec<Value> = platform_aggs
        .iter()
        .map(|(platform, agg)| {
            serde_json::json!({
                "platform": platform,
                "fleetOrders": agg.fleet_orders,
                "fleetAmount": agg.fleet_amount,
                "fleetAmount_cents": Cents::round_half_even(agg.fleet_amount).as_i64(),
                "vendorOrders": agg.vendor_orders,
                "vendorAmount": agg.vendor_amount,
                "vendorAmount_cents": Cents::round_half_even(agg.vendor_amount).as_i64(),
                "vendorCash": agg.vendor_cash,
                "vendorCash_cents": Cents::round_half_even(agg.vendor_cash).as_i64(),
                "vendorCard": agg.vendor_card,
                "vendorCard_cents": Cents::round_half_even(agg.vendor_card).as_i64(),
            })
        })
        .collect();

    // --- Adjustments: refunds and voids across all shifts ---
    let adjustment_scope_expr = business_day::order_financial_timestamp_expr("o");
    let adjustment_scope_predicate = lower_bound_mode.sql_predicate(&adjustment_scope_expr, "?1");
    let adjustment_scope_sql = format!(
        // W4b-iii: cents-with-real-fallback shim (removed in 4e).
        "SELECT pa.adjustment_type,
                COALESCE(SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER))), 0)
         FROM payment_adjustments pa
         JOIN orders o ON o.id = pa.order_id
         WHERE {adjustment_scope_predicate}
           AND (?2 IS NULL OR {adjustment_scope_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
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
            Ok((
                row.get::<_, String>(0)?,
                Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
            ))
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
    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    let expenses_total: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
                 FROM shift_expenses
                 WHERE {}
                   AND (?2 IS NULL OR created_at <= ?2)
                   AND (?3 = '' OR branch_id = ?3 OR branch_id IS NULL)
                   AND (expense_type IS NULL OR expense_type != 'staff_payment')",
                lower_bound_mode.sql_predicate("created_at", "?1")
            ),
            params![period_start, cutoff_param, branch_id],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    // Expense items for report_json
    let mut exp_stmt = conn
        .prepare(&format!(
            // W4b-iii: cents-with-real-fallback shim (removed in 4e).
            "SELECT se.id, se.expense_type,
                    COALESCE(se.amount_cents, CAST(ROUND(se.amount * 100) AS INTEGER), 0),
                    se.description, se.created_at, ss.staff_name
             FROM shift_expenses se
             LEFT JOIN staff_shifts ss ON ss.id = se.staff_shift_id
             WHERE {}
               AND (?2 IS NULL OR se.created_at <= ?2)
               AND (?3 = '' OR se.branch_id = ?3 OR se.branch_id IS NULL)
               AND (se.expense_type IS NULL OR se.expense_type != 'staff_payment')
             ORDER BY se.created_at ASC",
            lower_bound_mode.sql_predicate("se.created_at", "?1")
        ))
        .map_err(|e| format!("prepare expense query: {e}"))?;

    let expense_items: Vec<Value> = exp_stmt
        .query_map(params![period_start, cutoff_param, branch_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expenseType": row.get::<_, Option<String>>(1)?,
                "amount": Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                "description": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "createdAt": row.get::<_, String>(4)?,
                "staffName": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| format!("query expenses: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // --- Cash drawer sessions (aggregate across all shifts) ---
    // W4b-iii: cents-with-real-fallback shim on 12 monetary SUMs.
    let drawer_expected_expr = drawer_expected_cents_expr(None);
    let mut drawer_agg = conn
        .query_row(
            &format!(
                "SELECT
                    COALESCE(SUM(COALESCE(opening_amount_cents, CAST(ROUND(opening_amount * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(closing_amount_cents, CAST(ROUND(closing_amount * 100) AS INTEGER))), 0),
                    COALESCE(SUM({drawer_expected_expr}), 0),
                    COALESCE(SUM(COALESCE(variance_amount_cents, CAST(ROUND(variance_amount * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(total_cash_sales_cents, CAST(ROUND(total_cash_sales * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(total_card_sales_cents, CAST(ROUND(total_card_sales * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(total_refunds_cents, CAST(ROUND(total_refunds * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(total_expenses_cents, CAST(ROUND(total_expenses * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(cash_drops_cents, CAST(ROUND(cash_drops * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(driver_cash_given_cents, CAST(ROUND(driver_cash_given * 100) AS INTEGER))), 0),
                    COALESCE(SUM(COALESCE(driver_cash_returned_cents, CAST(ROUND(driver_cash_returned * 100) AS INTEGER))), 0),
                    SUM(CASE WHEN (reconciled = 0 OR reconciled IS NULL) THEN 1 ELSE 0 END),
                    COALESCE(SUM(COALESCE(total_staff_payments_cents, CAST(ROUND(total_staff_payments * 100) AS INTEGER))), 0)
             FROM cash_drawer_sessions
             WHERE {}
               AND (?2 IS NULL OR opened_at <= ?2)
               AND (?3 = '' OR branch_id = ?3 OR branch_id IS NULL)",
                lower_bound_mode.sql_predicate("opened_at", "?1")
            ),
            params![period_start, cutoff_param, branch_id],
            |row| {
                Ok(serde_json::json!({
                    "openingTotal": Cents::new(row.get::<_, i64>(0)?).to_f64_dp2(),
                    "closing": Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    "expected": Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                    "totalVariance": Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                    "cashSales": Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
                    "cardSales": Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                    "totalRefunds": Cents::new(row.get::<_, i64>(6)?).to_f64_dp2(),
                    "totalExpenses": Cents::new(row.get::<_, i64>(7)?).to_f64_dp2(),
                    "totalCashDrops": Cents::new(row.get::<_, i64>(8)?).to_f64_dp2(),
                    "driverCashGiven": Cents::new(row.get::<_, i64>(9)?).to_f64_dp2(),
                    "driverCashReturned": Cents::new(row.get::<_, i64>(10)?).to_f64_dp2(),
                    "unreconciledCount": row.get::<_, i64>(11)?,
                    "staffPaymentsTotal": Cents::new(row.get::<_, i64>(12)?).to_f64_dp2(),
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
    // Gap review P0-03: keep the per-type breakdown consistent with the main
    // order aggregate — uncollected open tabs are not part of this day's sales.
    let order_type_open_tab = business_day::open_unsettled_table_tab_expr("o");
    // W4b-iii: cents-with-real-fallback shim (removed in 4e).
    let order_type_scope_sql = format!(
        "SELECT COALESCE(o.order_type, 'dine-in'), COUNT(*),
                COALESCE(SUM(COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER))), 0)
         FROM orders o
         WHERE {order_type_scope_predicate}
           AND (?2 IS NULL OR {order_type_scope_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.is_test, 0) = 0
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND o.status NOT IN ('cancelled', 'canceled')
           AND NOT {order_type_open_tab}
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
                Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
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
                "SELECT COALESCE(SUM(sp.amount), 0)
                 FROM staff_payments sp
                 LEFT JOIN staff_shifts ss ON ss.id = sp.cashier_shift_id
                 WHERE {}
                   AND (?2 IS NULL OR sp.created_at <= ?2)
                   AND (?3 = '' OR ss.branch_id = ?3 OR ss.branch_id IS NULL)",
                lower_bound_mode.sql_predicate("sp.created_at", "?1")
            ),
            params![period_start, cutoff_param, branch_id],
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
               AND (?3 = '' OR branch_id = ?3 OR branch_id IS NULL)
               AND status = 'pending'
               AND (expense_type IS NULL OR expense_type != 'staff_payment')",
                lower_bound_mode.sql_predicate("created_at", "?1")
            ),
            params![period_start, cutoff_param, branch_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // --- Compute derived totals ---
    // See single-shift path for the rationale: gross_sales is order-level
    // (orders.total_amount, NOT cash_sales + card_sales), so subtracting
    // voids_total does not double-count against payment-level figures.
    let net_sales = gross_sales - refunds_total - voids_total - discounts_total;

    // Driver/server amounts are wallets handed out from the till, not extra
    // physical drawers. These role-filtered values are only the legacy
    // fallback when no cash_drawer_session snapshots exist.
    let physical_till_shifts = shifts
        .iter()
        .filter(|shift| matches!(shift.role_type.as_str(), "cashier" | "manager"))
        .collect::<Vec<_>>();
    let mut total_opening: f64 = physical_till_shifts
        .iter()
        .map(|shift| shift.opening_cash)
        .sum();
    let mut total_closing: f64 = physical_till_shifts
        .iter()
        .map(|shift| shift.closing_cash.unwrap_or(0.0))
        .sum();
    let mut total_expected: f64 = physical_till_shifts
        .iter()
        .map(|shift| shift.expected_cash.unwrap_or(0.0))
        .sum();
    let mut total_variance: f64 = physical_till_shifts
        .iter()
        .map(|shift| shift.cash_variance.unwrap_or(0.0))
        .sum();

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
        "twint": { "count": twint_count, "total": twint_sales },
        "other": { "count": other_count, "total": other_sales },
        "platform_online": { "count": platform_online_count, "total": platform_online_sales },
        "platform_cod": { "count": platform_cod_count, "total": platform_cod_sales },
    });
    let mut sales_by_type = load_sales_by_type_for_period(
        &conn,
        branch_id.as_str(),
        &period_start,
        cutoff_param,
        lower_bound_mode,
    )?;
    if let Some(by_type) = sales_by_type.as_object_mut() {
        by_type.insert(
            "repair".to_string(),
            serde_json::json!({
                "count": repair_orders_count,
                "total": repair_tender_sales,
                "cash": repair_cash_sales,
                "card": repair_card_sales,
                "other": repair_tender_sales - repair_cash_sales - repair_card_sales,
            }),
        );
    }
    let drawer_rows = load_drawer_rows_for_period(
        &conn,
        &period_start,
        cutoff_param,
        lower_bound_mode,
        branch_id.as_str(),
    )?;
    let gift_close = {
        let mut gift_close = load_gift_close_report_for_window(
            &conn,
            branch_id.as_str(),
            period_start.as_str(),
            cutoff_param,
            lower_bound_mode,
        )?;
        // A confirmed original reports only inside this report's own drawer
        // population; anything else is a scope mismatch, never a silent skip.
        let report_drawer_ids = drawer_rows
            .iter()
            .filter_map(|row| row.get("id").and_then(Value::as_str))
            .collect::<std::collections::HashSet<_>>();
        let (in_report, outside): (Vec<_>, Vec<_>) = std::mem::take(&mut gift_close.originals)
            .into_iter()
            .partition(|row| report_drawer_ids.contains(row.drawer_id.as_str()));
        gift_close.originals = in_report;
        gift_close
            .blockers
            .extend(outside.into_iter().map(|row| GiftCloseBlocker {
                code: GIFT_CLOSE_PROOF_MISMATCH,
                shift_id: row.shift_id,
                drawer_id: row.drawer_id,
                staff_id: row.staff_id,
                staff_name: row.staff_name,
                pending_reason: None,
            }));
        gift_close
    };
    let mut money_in_drawer = if drawer_rows.is_empty() {
        if include_active_shifts {
            total_expected + total_variance
        } else {
            total_closing
        }
    } else {
        money_in_drawer_from_rows(&drawer_rows)
    };

    if !drawer_rows.is_empty() {
        total_opening = opening_in_drawer_from_rows(&drawer_rows);
        total_closing = money_in_drawer;

        let drawer_number = |key: &str| {
            drawer_agg
                .as_ref()
                .and_then(|drawer| drawer.get(key))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        let expected_cents = Cents::round_half_even(total_opening).as_i64()
            + Cents::round_half_even(drawer_number("cashSales")).as_i64()
            - Cents::round_half_even(drawer_number("totalRefunds")).as_i64()
            - Cents::round_half_even(drawer_number("totalExpenses")).as_i64()
            - Cents::round_half_even(drawer_number("staffPaymentsTotal")).as_i64()
            - Cents::round_half_even(drawer_number("totalCashDrops")).as_i64()
            - Cents::round_half_even(drawer_number("driverCashGiven")).as_i64()
            + Cents::round_half_even(drawer_number("driverCashReturned")).as_i64()
            // Adopted gift-bound closes: the canonical gift liability cash and
            // canonical ordinary correction, each added exactly once.
            + gift_close.gift_cash_cents()
            + gift_close.ordinary_adjustment_cents();
        let closing_cents = Cents::round_half_even(total_closing).as_i64();
        total_expected = Cents::new(expected_cents).to_f64_dp2();
        total_variance = Cents::new(closing_cents - expected_cents).to_f64_dp2();
    } else {
        // Keep the response and report JSON aligned for legacy days that only
        // have cashier/manager shift snapshots.
        total_closing = money_in_drawer;
    }
    money_in_drawer = total_closing;

    if let Some(ref mut drawer) = drawer_agg {
        if let Some(obj) = drawer.as_object_mut() {
            for (key, value) in [
                ("openingTotal", total_opening),
                ("closing", total_closing),
                ("expected", total_expected),
                ("totalVariance", total_variance),
                ("moneyInDrawer", money_in_drawer),
            ] {
                obj.insert(key.to_string(), serde_json::json!(value));
                obj.insert(
                    format!("{key}_cents"),
                    serde_json::json!(Cents::round_half_even(value).as_i64()),
                );
            }
        }
    }
    if !gift_close.is_empty() {
        if let Some(ref mut drawer) = drawer_agg {
            gift_close.annotate_drawer(drawer, Cents::round_half_even(total_expected).as_i64());
        }
    }
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
    // Day-level order list (store + platform) for the modal's Orders tab;
    // same window and predicate as the `totalOrders` aggregate above.
    let (day_orders, day_orders_truncated) = load_day_order_details(
        &conn,
        branch_id.as_str(),
        period_start.as_str(),
        cutoff_param,
        lower_bound_mode,
    )?;

    // Build Electron-compatible report_json.
    // W4d-iv additive emission: every monetary float key carries a `_cents`
    // sibling. Mirrors the single-shift body at line 2844.
    let total_sales = gross_sales - discounts_total;
    let day_total = cash_sales
        + card_sales
        + twint_sales
        + other_sales
        + platform_online_sales
        + platform_cod_sales;

    // Reconciliation, computed on the SAME window and population as the
    // totals above. `sales.totalSales` is the order side, `daySummary.total`
    // the ledger side; when they disagree, `integrity.findings` names every
    // order responsible and `prepare_z_report_submission` refuses to close.
    let mut integrity_blockers = payment_integrity::load_branch_window_payment_blockers(
        &conn,
        branch_id.as_str(),
        period_start.as_str(),
        cutoff_param,
        lower_bound_mode == LowerBoundMode::Inclusive,
    )
    .map_err(|e| format!("load z-report integrity findings: {e}"))?;
    // The same `payments_need_review` findings the submission refuses on, so
    // the preview lists them (with their resolve action) before anyone
    // presses close. They carry no difference: the payments are counted
    // nowhere.
    integrity_blockers.extend(
        payment_integrity::load_payments_need_review_blockers(
            &conn,
            branch_id.as_str(),
            cutoff_param,
        )
        .map_err(|e| format!("load z-report payments needing review: {e}"))?,
    );
    // And the charged payments not saved, with their Save and resolve actions.
    integrity_blockers.extend(
        payment_integrity::load_payments_not_saved_blockers(&conn, branch_id.as_str())
            .map_err(|e| format!("load z-report charged payments not saved: {e}"))?,
    );
    // Cancelled orders of the period that still claim money with no payment
    // record (item D7, round 2): listed as WARNINGS, never blocking (no till
    // action resolves a cancel with no money). The submission gate
    // (`load_unsettled_payment_blockers_for_window`) does not read them.
    integrity_blockers.extend(
        payment_integrity::load_cancelled_order_claims_payment_findings(
            &conn,
            branch_id.as_str(),
            period_start.as_str(),
            cutoff_param,
            lower_bound_mode == LowerBoundMode::Inclusive,
        )
        .map_err(|e| format!("load z-report cancelled orders claiming a payment: {e}"))?,
    );
    let unclassified_platforms = load_unclassified_platform_sources(
        &conn,
        branch_id.as_str(),
        period_start.as_str(),
        cutoff_param,
        lower_bound_mode,
        last_z_anchor.as_deref(),
    )?;
    let refunded_orders = load_reconciliation_explanations(
        &conn,
        branch_id.as_str(),
        period_start.as_str(),
        cutoff_param,
        lower_bound_mode,
        last_z_anchor.as_deref(),
    )?;
    let integrity = build_z_integrity_block(
        total_sales,
        day_total,
        &carried_over,
        &unclassified_platforms,
        refunded_orders,
        &integrity_blockers,
    );

    let currency = if repair_orders_count != 0
        || repair_tender_sales != 0.0
        || repair_cash_sales != 0.0
        || repair_card_sales != 0.0
    {
        None
    } else {
        report_window_currency(
            &conn,
            &branch_id,
            &period_start,
            cutoff_param,
            lower_bound_mode,
            report_currency_from_staff(&staff_reports, &gift_close),
        )?
    };
    let presentation = load_z_report_presentation(db, &conn, &branch_id);
    let mut report_json = serde_json::json!({
        "currency": currency,
        "presentation": presentation,
        "paymentsBreakdown": payments_breakdown,
        "date": date,
        "shifts": {
            "total": shifts_total,
            "cashier": shifts_cashier,
            "driver": shifts_driver,
            "kitchen": shifts_kitchen,
        },
        "sales": {
            "totalOrders": total_orders,
            "totalSales": total_sales,
            "totalSales_cents": Cents::round_half_even(total_sales).as_i64(),
            "discountsTotal": discounts_total,
            "discountsTotal_cents": Cents::round_half_even(discounts_total).as_i64(),
            "cashSales": cash_sales,
            "cashSales_cents": Cents::round_half_even(cash_sales).as_i64(),
            "cardSales": card_sales,
            "cardSales_cents": Cents::round_half_even(card_sales).as_i64(),
            "twintSales": twint_sales,
            "twintPaymentCount": twint_count,
            "retainedTwintSales": retained_twint_sales,
            "retainedTwintSalesCents": Cents::round_half_even(retained_twint_sales).as_i64(),
            "twintSalesCents": Cents::round_half_even(twint_sales).as_i64(),
            "twint_sales_cents": Cents::round_half_even(twint_sales).as_i64(),
            "platformOnlineSales": platform_online_sales,
            "platformOnlineSales_cents": Cents::round_half_even(platform_online_sales).as_i64(),
            "platformCodSales": platform_cod_sales,
            "platformCodSales_cents": Cents::round_half_even(platform_cod_sales).as_i64(),
            "platforms": platform_breakdown,
            "dineInOrders": dine_in_orders,
            "dineInSales": dine_in_sales,
            "dineInSales_cents": Cents::round_half_even(dine_in_sales).as_i64(),
            "takeawayOrders": takeaway_orders,
            "takeawaySales": takeaway_sales,
            "takeawaySales_cents": Cents::round_half_even(takeaway_sales).as_i64(),
            "deliveryOrders": delivery_orders,
            "deliverySales": delivery_sales,
            "deliverySales_cents": Cents::round_half_even(delivery_sales).as_i64(),
            "repairOrders": repair_orders_count,
            "repairSales": repair_tender_sales,
            "repairSales_cents": Cents::round_half_even(repair_tender_sales).as_i64(),
            "byType": sales_by_type,
        },
        "cashDrawer": drawer_agg.as_ref().unwrap_or(&serde_json::json!({
            "totalVariance": total_variance,
            "totalVariance_cents": Cents::round_half_even(total_variance).as_i64(),
            "openingTotal": total_opening,
            "openingTotal_cents": Cents::round_half_even(total_opening).as_i64(),
        })),
        "expenses": {
            "total": expenses_total,
            "total_cents": Cents::round_half_even(expenses_total).as_i64(),
            "staffPaymentsTotal": staff_payments_total,
            "staffPaymentsTotal_cents": Cents::round_half_even(staff_payments_total).as_i64(),
            "pendingCount": pending_expenses_count,
            "items": expense_items,
        },
        "driverEarnings": driver_summary,
        "drawers": drawer_rows,
        "staffPayments": {
            "total": staff_payments_total,
            "total_cents": Cents::round_half_even(staff_payments_total).as_i64(),
        },
        "tips": {
            "total": tips_total,
            "total_cents": Cents::round_half_even(tips_total).as_i64(),
        },
        "daySummary": {
            "cashTotal": cash_sales,
            "cashTotal_cents": Cents::round_half_even(cash_sales).as_i64(),
            "cardTotal": card_sales,
            "cardTotal_cents": Cents::round_half_even(card_sales).as_i64(),
            "twintTotal": twint_sales,
            "twintTotal_cents": Cents::round_half_even(twint_sales).as_i64(),
            "platformOnlineTotal": platform_online_sales,
            "platformOnlineTotal_cents": Cents::round_half_even(platform_online_sales).as_i64(),
            "platformCodTotal": platform_cod_sales,
            "platformCodTotal_cents": Cents::round_half_even(platform_cod_sales).as_i64(),
            "total": day_total,
            "total_cents": Cents::round_half_even(day_total).as_i64(),
            "totalOrders": total_orders,
        },
        "staffReports": staff_reports,
        // Founder (06/09/2026): the Orders tab lists the whole day, not the
        // staff subset. Date-path only — the legacy single-shift builder
        // (`generate_z_report`) reports one shift by design.
        "dayOrders": day_orders,
        "dayOrdersTruncated": day_orders_truncated,
        // Founder rule 16/09/2026: a paid order must have canonical completed
        // payment coverage. This block is the Z's proof, and the reason it
        // refuses to close when the proof fails.
        "integrity": integrity,
    });
    if !gift_close.is_empty() {
        if let Some(obj) = report_json.as_object_mut() {
            obj.insert(
                GIFT_CLOSE_REPORT_KEY.to_string(),
                gift_close.projection_value(),
            );
        }
    }
    canonicalize_report_json_period(&mut report_json, period_start.as_str(), period_end.as_str());

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
        twint_sales,
        refunds_total,
        voids_total,
        discounts_total,
        tips_total,
        expenses_total,
        total_variance,
        total_opening,
        total_closing,
        total_expected,
        payments_breakdown,
        report_json,
        gift_close,
    })
}

pub fn preview_z_report_for_date(db: &DbState, payload: &Value) -> Result<Value, String> {
    if let Some(existing) = load_existing_local_z_report_response(db, payload)? {
        return Ok(existing);
    }

    let built = build_z_report_for_date(db, payload, true)?;
    if built.shift_count == 0 {
        info!("No closed shifts in period — returning preview-only Z-report");
    }
    Ok(preview_response_from_built_date_z_report(&built, true))
}

pub fn generate_z_report_for_date(db: &DbState, payload: &Value) -> Result<Value, String> {
    let built = build_z_report_for_date(db, payload, false)?;
    if built.shift_count == 0 {
        info!("No closed shifts in period — returning preview-only Z-report");
        return Ok(preview_response_from_built_date_z_report(&built, true));
    }
    if let Some(message) = built.gift_close.blocker_message() {
        return Err(message);
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let (period_start, period_end) = extract_period_bounds_from_report_json(&built.report_json);
    let period_start =
        period_start.ok_or("Missing reportJson.periodStart for Z-report persistence")?;
    let period_end = period_end.ok_or("Missing reportJson.periodEnd for Z-report persistence")?;
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
        ensure_gift_close_snapshot_current(&conn, &existing_id, &built.gift_close)?;
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

    // Race-guard — see the single-shift generate_z_report path above for
    // rationale. Two callers that both pass the pre-tx idempotency SELECT
    // will serialize here; the second must exit without inserting a
    // duplicate row for the same shift.
    let racing_existing: Option<String> = conn
        .query_row(
            "SELECT id FROM z_reports WHERE shift_id = ?1",
            params![shift_id_for_db],
            |row| row.get(0),
        )
        .ok();
    if let Some(existing_id) = racing_existing {
        // Wave 6: ROLLBACK, not COMMIT. We opened BEGIN IMMEDIATE but
        // performed no writes on the idempotency-race short-circuit
        // path; COMMIT forces a zero-op WAL checkpoint marker.
        // ROLLBACK is semantically identical (no writes to undo) and
        // keeps the journal clean.
        let _ = conn.execute_batch("ROLLBACK");
        ensure_gift_close_snapshot_current(&conn, &existing_id, &built.gift_close)?;
        return get_z_report_by_id(&conn, &existing_id).map(|report| {
            serde_json::json!({
                "success": true,
                "existing": true,
                "report": report,
            })
        });
    }

    // W4c dual-write: every monetary REAL column gets its `_cents` sibling
    // (multi-shift z-report variant — uses `built.*` aggregates).
    let built_gross_sales_cents = Cents::round_half_even(built.gross_sales).as_i64();
    let built_net_sales_cents = Cents::round_half_even(built.net_sales).as_i64();
    let built_cash_sales_cents = Cents::round_half_even(built.cash_sales).as_i64();
    let built_card_sales_cents = Cents::round_half_even(built.card_sales).as_i64();
    let built_refunds_total_cents = Cents::round_half_even(built.refunds_total).as_i64();
    let built_voids_total_cents = Cents::round_half_even(built.voids_total).as_i64();
    let built_discounts_total_cents = Cents::round_half_even(built.discounts_total).as_i64();
    let built_tips_total_cents = Cents::round_half_even(built.tips_total).as_i64();
    let built_expenses_total_cents = Cents::round_half_even(built.expenses_total).as_i64();
    let built_total_variance_cents = Cents::round_half_even(built.total_variance).as_i64();
    let built_total_opening_cents = Cents::round_half_even(built.total_opening).as_i64();
    let built_total_closing_cents = Cents::round_half_even(built.total_closing).as_i64();
    let built_total_expected_cents = Cents::round_half_even(built.total_expected).as_i64();
    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO z_reports (
                id, shift_id, branch_id, terminal_id, report_date, generated_at,
                gross_sales, gross_sales_cents,
                net_sales, net_sales_cents,
                total_orders,
                cash_sales, cash_sales_cents,
                card_sales, card_sales_cents,
                refunds_total, refunds_total_cents,
                voids_total, voids_total_cents,
                discounts_total, discounts_total_cents,
                tips_total, tips_total_cents,
                expenses_total, expenses_total_cents,
                cash_variance, cash_variance_cents,
                opening_cash, opening_cash_cents,
                closing_cash, closing_cash_cents,
                expected_cash, expected_cash_cents,
                payments_breakdown_json, report_json,
                sync_state, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8,
                ?9, ?10,
                ?11,
                ?12, ?13,
                ?14, ?15,
                ?16, ?17,
                ?18, ?19,
                ?20, ?21,
                ?22, ?23,
                ?24, ?25,
                ?26, ?27,
                ?28, ?29,
                ?30, ?31,
                ?32, ?33,
                ?34, ?35,
                'pending', ?36, ?36
             )",
            params![
                z_report_id,
                shift_id_for_db,
                built.branch_id,
                built.terminal_id,
                built.report_date,
                built.generated_at,
                built.gross_sales,
                built_gross_sales_cents,
                built.net_sales,
                built_net_sales_cents,
                built.total_orders,
                built.cash_sales,
                built_cash_sales_cents,
                built.card_sales,
                built_card_sales_cents,
                built.refunds_total,
                built_refunds_total_cents,
                built.voids_total,
                built_voids_total_cents,
                built.discounts_total,
                built_discounts_total_cents,
                built.tips_total,
                built_tips_total_cents,
                built.expenses_total,
                built_expenses_total_cents,
                built.total_variance,
                built_total_variance_cents,
                built.total_opening,
                built_total_opening_cents,
                built.total_closing,
                built_total_closing_cents,
                built.total_expected,
                built_total_expected_cents,
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
            "currency": built.report_json.get("currency").cloned().unwrap_or(Value::Null),
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
            "twintSales": built.twint_sales,
            "refundsTotal": built.refunds_total,
            "voidsTotal": built.voids_total,
            "discountsTotal": built.discounts_total,
            "tipsTotal": built.tips_total,
            "expensesTotal": built.expenses_total,
            "cashVariance": built.total_variance,
            "openingCash": built.total_opening,
            "closingCash": built.total_closing,
            "expectedCash": built.total_expected,
            "paymentsBreakdown": built.payments_breakdown,
            "reportJson": built.report_json,
            "syncState": "pending",
        },
    }))
}

// ---------------------------------------------------------------------------
// Submit Z-report + finalize end-of-day (Gap 8)
// ---------------------------------------------------------------------------

fn payload_for_z_report_window(
    payload: &Value,
    branch_id: &str,
    window: &EffectiveZReportWindow,
) -> Value {
    let mut normalized = payload.as_object().cloned().unwrap_or_default();
    normalized.insert("branchId".to_string(), Value::String(branch_id.to_string()));
    normalized.insert(
        "date".to_string(),
        Value::String(window.report_date.clone()),
    );
    Value::Object(normalized)
}

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
        // Submission always closes the current live/frozen window. A date
        // picker is useful for historical preview, but must never choose the
        // report identity or rollover bounds for a commit.
        resolve_current_z_report_window(&conn, &branch_id)
    };
    let cutoff_param = window.cutoff_at.as_deref();

    // --- Pre-condition: all staff must be checked out ---
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                // `?1 = ''` is the house wildcard (business_day.rs:345/352/370/413,
                // shifts.rs:3506): an unresolved branch must mean ALL rows, not
                // "only rows with a NULL branch". branch_id here falls back to
                // storage::get_credential("branch_id").unwrap_or_default(), so on a
                // terminal whose keyring credential is missing or whose branch cache
                // drifted it is the empty string — and without the wildcard this gate
                // silently matched nothing and reported "no staff checked in" while
                // the step-9 sweep below, which has no branch predicate at all, went
                // on to touch exactly the rows the gate could not see.
                "SELECT id, COALESCE(staff_name, staff_id) as name
                 FROM staff_shifts
                 WHERE status = 'active'
                   AND (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
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
        let blockers = load_unsettled_payment_blockers_for_window(&conn, &branch_id, &window)?;
        if let Some(message) = unsettled_payment_blocker_message(&blockers) {
            return Err(message);
        }
    }

    // --- Pre-condition: every closed gift-bound drawer is canonically closed ---
    // Adopted proof is the evidence, never generic sync-queue emptiness.
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let gift_close = load_gift_close_report_for_effective_window(&conn, &branch_id, &window)?;
        if let Some(message) = gift_close.blocker_message() {
            return Err(message);
        }
    }

    // Step 1: Generate the report (multi-shift or single-shift)
    let has_shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .is_some();
    let has_branch_date =
        str_field(payload, "branchId").is_some() || str_field(payload, "date").is_some();
    let window_payload = payload_for_z_report_window(payload, &branch_id, &window);

    let generated = if has_shift_id && !has_branch_date {
        generate_z_report(db, payload)?
    } else {
        generate_z_report_for_date(db, &window_payload)?
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
    fn safe_delete(
        conn: &Connection,
        table: &str,
        sql: &str,
        cutoff_at: Option<&str>,
    ) -> Result<i64, String> {
        let execution = if sql.contains("?1") {
            conn.execute(sql, params![cutoff_at.unwrap_or_default()])
        } else {
            conn.execute(sql, [])
        };

        match execution {
            Ok(count) => Ok(count as i64),
            Err(e) => {
                if e.to_string().contains("no such table:") {
                    warn!(table = %table, error = %e, "Cleanup: optional table is absent");
                    return Ok(0);
                }
                warn!(table = %table, error = %e, "Cleanup: table delete failed");
                Err(format!("cleanup delete {table}: {e}"))
            }
        }
    }

    let financial_expr = business_day::order_financial_timestamp_expr("o");
    // Gap review P0-03: an unpaid order's financial timestamp falls back to its
    // created_at, so a bare cutoff filter selected still-open table tabs for
    // deletion — destroying a live order (and orphaning its table session) at
    // day close. The closeout gate deliberately lets the day close with a tab
    // open; the tab belongs to the business day it is eventually settled on.
    // The strict variant keeps cancelled/refunded/settled tabs deletable.
    let open_table_tab = business_day::open_unsettled_table_tab_expr("o");
    let target_order_ids_sql = format!(
        "SELECT o.id
         FROM orders o
         WHERE datetime({financial_expr}) <= datetime(?1)
           AND COALESCE(o.order_context, '') <> 'repair_settlement'
           AND NOT {open_table_tab}"
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

    // The cleanup below deletes the window's payment rows. A payment set
    // aside as a possible duplicate is the only record of that money on this
    // terminal: it goes only once someone resolved it. The Z already refuses
    // on `payments_need_review`; a payment a sync pass set aside after that
    // check stops the close here (Android: `finalizeEndOfDay`).
    let set_aside =
        crate::payment_review::count_unresolved_set_aside_payments_for_cleanup(conn, cutoff_at)?;
    if set_aside > 0 {
        return Err(format!(
            "Cannot close the day: {set_aside} payment(s) set aside as possible duplicates must be resolved first ({})",
            crate::payment_review::PAYMENTS_NEED_REVIEW_REASON_CODE
        ));
    }
    // Nor while a card charged on this till is not saved: the record is the
    // only trace of money the customer paid (fix review 30/09/2026).
    if !crate::table_manual_cancellation::pending(conn, "")?.is_empty() {
        return Err("Cannot close the day: the original table cancellation return must be saved (table_cancellation_not_saved)".into());
    }
    let pending_edits = crate::edit_settlement_recovery::pending_financial_edits(conn, "")?.len();
    if pending_edits > 0 {
        return Err(format!("Cannot close the day: {pending_edits} confirmed order correction(s) need their original collection/refund saved (edit_settlement_not_saved)"));
    }
    let not_saved = crate::unsaved_payments::count(conn)?;
    if not_saved > 0 {
        return Err(format!(
            "Cannot close the day: {not_saved} charged payment(s) are not saved on this till yet ({})",
            crate::unsaved_payments::PAYMENTS_NOT_SAVED_REASON_CODE
        ));
    }
    // Nor while a payment, refund or other money record this step would
    // delete is still waiting to reach the server: its local row is what the
    // queued sync reads (06/10/2026: a refund deleted here never reached the
    // server). The pre-Z sync gate refuses first; this covers a record
    // queued after that check.
    let unsent_money = load_unsynced_money_for_cutoff(conn, cutoff_at)?;
    if !unsent_money.is_empty() {
        return Err(format!(
            "Cannot close the day: {} payment, refund or staff money record(s) of this day have not reached the server yet ({MONEY_NOT_SYNCED_REASON})",
            unsent_money.len()
        ));
    }

    let mut cleared = serde_json::Map::new();

    // 1. payment_adjustments linked to orders inside the closed business window.
    let c = safe_delete(
        conn,
        "payment_adjustments",
        "DELETE FROM payment_adjustments
        WHERE order_id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    )?;
    cleared.insert("payment_adjustments".into(), serde_json::json!(c));

    // 2. order_payments linked to the same closed orders.
    let c = safe_delete(
        conn,
        "order_payments",
        "DELETE FROM order_payments
        WHERE order_id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    )?;
    cleared.insert("order_payments".into(), serde_json::json!(c));

    // 3. driver_earnings linked to the closed orders.
    let c = safe_delete(
        conn,
        "driver_earnings",
        "DELETE FROM driver_earnings
        WHERE order_id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    )?;
    cleared.insert("driver_earnings".into(), serde_json::json!(c));

    // 4. sync_queue -- only clear synced items that were already materialized before the cutoff.
    let c = safe_delete(
        conn,
        "sync_queue",
        "DELETE FROM sync_queue
         WHERE status = 'synced'
           AND datetime(created_at) <= datetime(?1)",
        Some(cutoff_at),
    )?;
    cleared.insert("sync_queue".into(), serde_json::json!(c));

    // 5. shift_expenses by their own operational timestamp.
    let c = safe_delete(
        conn,
        "shift_expenses",
        "DELETE FROM shift_expenses
         WHERE datetime(created_at) <= datetime(?1)
           AND id NOT IN (SELECT id FROM temp_rollover_protected_shift_expense_ids)",
        Some(cutoff_at),
    )?;
    cleared.insert("shift_expenses".into(), serde_json::json!(c));

    // 6. staff_payments by their own operational timestamp.
    let c = safe_delete(
        conn,
        "staff_payments",
        "DELETE FROM staff_payments
         WHERE datetime(created_at) <= datetime(?1)
           AND id NOT IN (SELECT id FROM temp_rollover_protected_staff_payment_ids)",
        Some(cutoff_at),
    )?;
    cleared.insert("staff_payments".into(), serde_json::json!(c));

    // 7. print_jobs of the closed day (finished or pending), with their
    // attempts. Jobs that are printing or hold a printer stay: see
    // `clear_closed_day_print_jobs`.
    let print_cleanup = clear_closed_day_print_jobs(conn, cutoff_at)?;
    cleared.insert("print_jobs".into(), serde_json::json!(print_cleanup.jobs));
    cleared.insert(
        "print_job_attempts".into(),
        serde_json::json!(print_cleanup.attempts),
    );
    cleared.insert(
        "print_jobs_kept_live".into(),
        serde_json::json!(print_cleanup.kept),
    );
    cleared.insert(
        "print_jobs_kept_evidence".into(),
        serde_json::json!(print_cleanup.retained_evidence),
    );

    // 8. cash_drawer_sessions by close/open timestamp.
    let c = safe_delete(
        conn,
        "cash_drawer_sessions",
        "DELETE FROM cash_drawer_sessions
         WHERE datetime(COALESCE(closed_at, opened_at, created_at)) <= datetime(?1)
           AND staff_shift_id NOT IN (SELECT id FROM temp_rollover_protected_shift_ids)",
        Some(cutoff_at),
    )?;
    cleared.insert("cash_drawer_sessions".into(), serde_json::json!(c));

    // 9. staff_shifts by close/check-in timestamp.
    //
    // Close anything still open BEFORE the sweep. A Z-report ends the business
    // day, so no shift may outlive it — and this DELETE used to match on the
    // timestamp alone, erasing `status='active'` rows from local SQLite while
    // the Supabase row kept `check_out_time IS NULL` forever. pos-tauri never
    // hydrates staff_shifts back from the server, so once the local copy was
    // gone, no terminal, no Z and no sync could ever close that row again. The
    // `staff_shifts_one_open_per_staff` partial unique index then refused that
    // person's check-ins on every OTHER terminal, while this one kept offering
    // them as available (the busy check exempts shifts on our own terminal).
    // One cashier sat in that state for twenty days.
    //
    // So: mark them abandoned, enqueue the closure so the server learns of it,
    // and only then let the sweep drop the local row.
    //
    // This scan is deliberately branch-blind, exactly like the DELETE it guards.
    // Do NOT add a branch predicate here to "match" the submission gate: the gate
    // is branch-scoped and the sweep is not, and the safe way to reconcile that
    // is for the protective step to cover everything the destructive step can
    // reach — never the other way round.
    let shifts_open_at_rollover: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM staff_shifts
                  WHERE datetime(COALESCE(check_out_time, check_in_time, created_at)) <= datetime(?1)
                    AND id NOT IN (SELECT id FROM temp_rollover_protected_shift_ids)
                    AND (check_out_time IS NULL OR status = 'active')",
            )
            .map_err(|e| format!("prepare rollover open-shift scan: {e}"))?;
        let rows = stmt
            .query_map(params![cutoff_at], |row| row.get::<_, String>(0))
            .map_err(|e| format!("scan shifts left open at rollover: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect shifts left open at rollover: {e}"))?
    };

    for shift_id in &shifts_open_at_rollover {
        conn.execute(
            "UPDATE staff_shifts
                SET status = 'abandoned',
                    check_out_time = COALESCE(check_out_time, ?2),
                    updated_at = ?2
              WHERE id = ?1",
            params![shift_id, cutoff_at],
        )
        .map_err(|e| format!("close shift {shift_id} left open at rollover: {e}"))?;

        // Best-effort: the Admin z-report/submit route releases the terminal
        // unit's staff server-side as well, so a queue hiccup here degrades the
        // report rather than failing a close the server has already accepted.
        if let Err(e) = crate::shifts::replace_unfinished_shift_sync_rows_with_current_snapshot(
            conn, shift_id, cutoff_at,
        ) {
            warn!(
                shift_id = %shift_id,
                error = %e,
                "Z-report: failed to enqueue closure for a shift left open at rollover"
            );
        }
    }

    if !shifts_open_at_rollover.is_empty() {
        warn!(
            count = shifts_open_at_rollover.len(),
            "Z-report: closed shifts that were still open at day rollover"
        );
    }
    cleared.insert(
        "staff_shifts_closed_at_rollover".into(),
        serde_json::json!(shifts_open_at_rollover.len()),
    );

    let c = safe_delete(
        conn,
        "staff_shifts",
        "DELETE FROM staff_shifts
         WHERE datetime(COALESCE(check_out_time, check_in_time, created_at)) <= datetime(?1)
           AND id NOT IN (SELECT id FROM temp_rollover_protected_shift_ids)",
        Some(cutoff_at),
    )?;
    cleared.insert("staff_shifts".into(), serde_json::json!(c));

    // 10. orders in the closed business window. Payments/adjustments were already removed above.
    //
    // BEFORE deleting the orders, fold their items into the persistent
    // `top_sellers_rolling` table so the Featured tab in the menu picker
    // doesn't go blank after the rollover. Without this step, every
    // Z-report wipes the leaderboard's source data and the Featured tab
    // shows "no products" until a new day's worth of orders accumulates.
    // The aggregator reads from `temp_z_report_order_ids` (already
    // populated upstream in this function), parses each order's items
    // JSON, and UPSERTs per-(branch, menu_item) totals.
    match crate::commands::analytics::top_sellers_aggregate_into_rolling(conn) {
        Ok(upserts) => {
            info!(
                upserts,
                "Z-report: rolled order items into top_sellers_rolling"
            );
        }
        Err(e) => {
            // Don't block the Z-report on a leaderboard hiccup — log
            // and proceed. The Featured tab will simply fall back to
            // whatever's already in the rolling table from prior runs.
            warn!(error = %e, "Z-report: failed to update top_sellers_rolling (continuing)");
        }
    }

    let c = safe_delete(
        conn,
        "orders",
        "DELETE FROM orders
         WHERE id IN (SELECT id FROM temp_z_report_order_ids)",
        None,
    )?;
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

/// Row counts of the day close's print-queue step.
#[derive(Debug, Default, PartialEq, Eq)]
struct PrintJobCleanup {
    /// `print_jobs` rows deleted: finished jobs, and pending jobs that hold no
    /// printer.
    jobs: i64,
    /// `print_job_attempts` rows deleted: those of the deleted jobs, plus
    /// finished attempts an older day close had already cut off their job.
    attempts: i64,
    /// Jobs from before the cutoff that stay: printing, holding a printer, or
    /// the source of a reprint that stays.
    kept: i64,
    /// Finished jobs from before the cutoff kept, with their attempts, as
    /// print evidence (`PRINT_EVIDENCE_RETENTION_DAYS`, `PRINT_EVIDENCE_MAX_JOBS`).
    retained_evidence: i64,
}

/// Days of finished print jobs (with their attempts) a day close keeps as
/// support evidence. Android: `PrintAttemptJournal` `RETENTION_DAYS`.
const PRINT_EVIDENCE_RETENTION_DAYS: i64 = 7;

/// Most finished print jobs a day close keeps as evidence. Android:
/// `PrintAttemptJournal` `MAX_ROWS`.
const PRINT_EVIDENCE_MAX_JOBS: i64 = 1000;

/// The day close's print-queue step: delete the print jobs of the closed day,
/// together with their attempts, and never one that holds a printer.
///
/// Incident (Tomikro Parisi, desktop 1.4.119, 30/09/2026): from the closing Z
/// at 03:25 every print stayed "pending" with transport "not started", while
/// Health said the printer was ready, and restarts did not help. This step
/// used to be `DELETE FROM print_jobs WHERE created_at <= cutoff`. It ran
/// while another print was being sent, so it deleted that job, and the
/// rollover runs with `PRAGMA foreign_keys = OFF`, so the `ON DELETE CASCADE`
/// to `print_job_attempts` did not fire. The attempt stayed in `submitting`
/// with no job above it: a durable printer blocker nothing could close.
/// Hydration retained the printer lane on every tick, the lane sweep refused
/// to release a lane with a blocker, every later job was deferred with no
/// attempt and no error, and staff had nothing to cancel because the queue
/// lists jobs, not attempts. The dispatcher now closes such legacy orphans
/// (`DispatchManager::sweep_orphaned_lanes`); this step no longer makes them.
///
/// A job goes only when all of these hold:
/// - it was created before the cutoff;
/// - its status is `pending` or final (`printed`, `dispatched`, `failed`,
///   `cancelled`), never `printing`;
/// - none of its attempts matches the dispatcher's printer-blocker predicate
///   (`print_dispatch::shared_attempt_blocker_predicate_sql`);
/// - no reprint that stays points at it (a reprint deleted in this same step
///   does not hold its source back);
/// - it is not among the newest finished jobs of the last 7 days (at most
///   1,000), kept with their attempts as print evidence for support exports
///   (06/10/2026; Android `PrintAttemptJournal` keeps 7 days or 1,000 rows).
///
/// Pending jobs go, as they did before 1.4.120: this same rollover deletes
/// the closed day's orders and shifts they would print, so a pending job kept
/// past the Z could no longer render. It would fail later, three such
/// failures raise a false `printer.critical_failure` incident
/// (`incident_reporting`), and a job left pending raises
/// `printer.jobs_not_printing`. Deleting one cannot orphan a send: the worker
/// moves a job from `pending` to `printing` in the transaction that creates
/// its attempt (`print_dispatch::prepare_managed_attempt`), so a pending job
/// has no attempt in flight, and a worker that selected a job this step
/// deletes finds no row to claim and creates no attempt. Its earlier,
/// finished attempts are deleted with it.
///
/// Foreign keys are off here, so the attempts of exactly those jobs are
/// deleted explicitly in the same transaction. Finished attempts whose job an
/// older version's day close had already deleted go too; a blocking orphan is
/// left to the lane sweep, which closes it under the printer lane lock.
///
/// Without `print_job_attempts` (a partial repair schema; a real POS database
/// always has it) nothing can hold a printer, so the jobs go by the status
/// and cutoff rules alone. Without `print_jobs` there is nothing to delete.
fn clear_closed_day_print_jobs(
    conn: &Connection,
    cutoff_at: &str,
) -> Result<PrintJobCleanup, String> {
    let table_present = |table: &str| -> Result<bool, String> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| format!("cleanup inspect {table}: {e}"))
    };
    if !table_present("print_jobs")? {
        // Repair fixtures may carry a partial schema without the spooler
        // (see db::migrate_v73); a real POS database always has this table.
        warn!("Cleanup: print queue tables are absent");
        return Ok(PrintJobCleanup::default());
    }
    let attempts_present = table_present("print_job_attempts")?;
    if !attempts_present {
        warn!("Cleanup: print_job_attempts is absent; print jobs are cleared by status alone");
    }
    let reprints_tracked = db::column_exists(conn, "print_jobs", "reprint_of_job_id")?;

    let no_blocking_attempt = if attempts_present {
        format!(
            "AND NOT EXISTS (
                 SELECT 1 FROM print_job_attempts attempt
                 WHERE attempt.print_job_id = job.id
                   AND {}
             )",
            crate::print_dispatch::shared_attempt_blocker_predicate_sql("attempt")
        )
    } else {
        String::new()
    };
    let no_kept_reprint = if reprints_tracked {
        "AND NOT EXISTS (
             SELECT 1 FROM print_jobs child
             WHERE child.reprint_of_job_id = job.id
               AND child.id NOT IN (SELECT id FROM temp_z_report_print_job_ids)
         )"
    } else {
        ""
    };
    let stage_jobs_sql = format!(
        "INSERT INTO temp_z_report_print_job_ids (id)
         SELECT job.id
         FROM print_jobs job
         WHERE datetime(job.created_at) <= datetime(?1)
           AND job.status IN ('pending', 'printed', 'dispatched', 'failed', 'cancelled')
           AND job.id NOT IN (SELECT id FROM temp_z_report_print_job_ids)
           AND job.id NOT IN (SELECT id FROM temp_z_report_print_evidence_ids)
           {no_blocking_attempt}
           {no_kept_reprint}"
    );

    conn.execute_batch(
        "DROP TABLE IF EXISTS temp_z_report_print_job_ids;
         CREATE TEMP TABLE temp_z_report_print_job_ids (
             id TEXT PRIMARY KEY
         );
         DROP TABLE IF EXISTS temp_z_report_print_evidence_ids;
         CREATE TEMP TABLE temp_z_report_print_evidence_ids (
             id TEXT PRIMARY KEY
         );",
    )
    .map_err(|e| format!("prepare print cleanup temp table: {e}"))?;

    // Print-attempt evidence outlives the day close (06/10/2026): a support
    // export the next morning had nothing, because every Z deleted the day's
    // finished jobs and their attempts. The newest finished jobs of the last
    // `PRINT_EVIDENCE_RETENTION_DAYS` days, at most `PRINT_EVIDENCE_MAX_JOBS`,
    // stay with their attempts, as Android keeps 7 days or 1,000 rows
    // (`PrintAttemptJournal`). A finished job never prints again, so keeping
    // it raises no printer incident; pending jobs still go (see above).
    let evidence_since = (Utc::now() - chrono::Duration::days(PRINT_EVIDENCE_RETENTION_DAYS))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let retained = conn
        .execute(
            "INSERT INTO temp_z_report_print_evidence_ids (id)
             SELECT id
             FROM print_jobs
             WHERE status IN ('printed', 'dispatched', 'failed', 'cancelled')
               AND julianday(created_at) >= julianday(?1)
             ORDER BY julianday(created_at) DESC, id DESC
             LIMIT ?2",
            params![evidence_since, PRINT_EVIDENCE_MAX_JOBS],
        )
        .map_err(|e| format!("stage print evidence kept at day close: {e}"))?;

    // Leaves first: a reprint's source becomes deletable once the reprint is
    // staged. Every pass stages at least one new row or ends the loop.
    loop {
        let staged = conn
            .execute(&stage_jobs_sql, params![cutoff_at])
            .map_err(|e| format!("stage print jobs for day close: {e}"))?;
        if staged == 0 {
            break;
        }
    }

    let mut attempts = 0;
    if attempts_present {
        attempts += conn
            .execute(
                "DELETE FROM print_job_attempts
                 WHERE print_job_id IN (SELECT id FROM temp_z_report_print_job_ids)",
                [],
            )
            .map_err(|e| format!("cleanup delete print_job_attempts: {e}"))?;
    }
    let jobs = conn
        .execute(
            "DELETE FROM print_jobs
             WHERE id IN (SELECT id FROM temp_z_report_print_job_ids)",
            [],
        )
        .map_err(|e| format!("cleanup delete print_jobs: {e}"))?;
    let mut finished_orphan_attempts = 0;
    if attempts_present {
        finished_orphan_attempts = conn
            .execute(
                &format!(
                    "DELETE FROM print_job_attempts
                     WHERE NOT EXISTS (
                         SELECT 1 FROM print_jobs job
                         WHERE job.id = print_job_attempts.print_job_id
                     )
                       AND NOT {}",
                    crate::print_dispatch::shared_attempt_blocker_predicate_sql(
                        "print_job_attempts"
                    )
                ),
                [],
            )
            .map_err(|e| format!("cleanup delete orphaned print_job_attempts: {e}"))?;
        attempts += finished_orphan_attempts;
    }
    // Live jobs only: the finished evidence kept above is counted apart.
    let (kept, retained_evidence): (i64, i64) = conn
        .query_row(
            "SELECT
                 COALESCE(SUM(CASE WHEN id NOT IN (SELECT id FROM temp_z_report_print_evidence_ids)
                                   THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN id IN (SELECT id FROM temp_z_report_print_evidence_ids)
                                   THEN 1 ELSE 0 END), 0)
             FROM print_jobs WHERE datetime(created_at) <= datetime(?1)",
            params![cutoff_at],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("count print jobs kept at day close: {e}"))?;

    conn.execute_batch(
        "DROP TABLE IF EXISTS temp_z_report_print_job_ids;
         DROP TABLE IF EXISTS temp_z_report_print_evidence_ids;",
    )
    .map_err(|e| format!("cleanup print temp table: {e}"))?;

    if kept > 0 {
        info!(
            kept,
            "Z-report: kept print jobs that are printing, hold a printer, or are the source of a kept reprint"
        );
    }
    if retained > 0 {
        info!(
            retained_evidence,
            "Z-report: kept recent finished print jobs and their attempts as support evidence"
        );
    }
    if finished_orphan_attempts > 0 {
        warn!(
            count = finished_orphan_attempts,
            "Z-report: deleted finished print attempts whose print job was already gone"
        );
    }

    Ok(PrintJobCleanup {
        jobs: jobs as i64,
        attempts: attempts as i64,
        kept,
        retained_evidence,
    })
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
        // THIS is the moment the working day closes — the founder's model has
        // no other: a day opens with its first activity and ends only here,
        // whether it ran two hours or five days. The marker anchors the local
        // ledger's retention (`business_day::retention_cutoff_utc`): the
        // orders view and the daily prune both read it, so nothing is hidden
        // or deleted until a Z has settled it. It advances only inside this
        // transaction — the atomic rollover whose failure also discards the
        // freshly generated Z — never at Z *generation*, which previews
        // exercise and discard.
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
    let currency = common_report_currency([report_json
        .get("currency")
        .and_then(Value::as_str)
        .map(str::to_owned)])
    .unwrap_or_else(|| "Unknown".to_string());
    let shift_count = report_json
        .pointer("/shifts/total")
        .and_then(Value::as_i64)
        .filter(|count| *count > 0);
    let shift_line = if let Some(count) = shift_count {
        let label = if count == 1 { "Shift" } else { "Shifts" };
        format!("{label}: {count}<br/>")
    } else if !shift_id.trim().is_empty() {
        "Shift: 1<br/>".to_string()
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
Generated: {generated_at}<br/>
Currency: {currency}
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
    let report_json: String = row.get(21)?;
    let currency = serde_json::from_str::<Value>(&report_json)
        .ok()
        .and_then(|report| {
            report
                .get("currency")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let currency = common_report_currency([currency]);
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
        "reportJson": report_json,
        "currency": currency,
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
    #[test]
    fn confirmed_edit_refund_pending_blocks_cleanup_before_any_deletion() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("CREATE TABLE edit_settlement_attempts_v1(order_id TEXT,branch_id TEXT,state TEXT,request_json TEXT); INSERT INTO edit_settlement_attempts_v1 VALUES('held-order','branch','refused','{\"action\":{\"type\":\"refund\"}}');").unwrap();
        let error = super::finalize_end_of_day_counts(&conn, "2026-10-05T18:00:00Z").unwrap_err();
        assert!(error.contains("edit_settlement_not_saved"), "{error}");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM edit_settlement_attempts_v1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    use super::*;
    use crate::db;
    use chrono::{LocalResult, TimeZone};
    use rusqlite::Connection;

    #[derive(Default)]
    struct CountingPrintQueueInvalidator(std::sync::atomic::AtomicUsize);

    impl crate::print::PrintQueueInvalidator for CountingPrintQueueInvalidator {
        fn invalidate_print_queue(&self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
    }

    impl CountingPrintQueueInvalidator {
        fn count(&self) -> usize {
            self.0.load(std::sync::atomic::Ordering::Acquire)
        }
    }

    // -----------------------------------------------------------------------
    // Gift-bound drawer close: frozen report projection and finalization gates
    // -----------------------------------------------------------------------

    const GC_ORG: &str = "6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf";
    const GC_BRANCH: &str = "7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0";
    const GC_OTHER_BRANCH: &str = "9fc3e0d1-9c7b-4d84-8a6b-7c8d9eafb0c1";
    const GC_TERMINAL: &str = "terminal-main-01";
    const GC_STAFF: &str = "5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e";
    const GC_OWNER_DB: &str = "a1b2c3d4-e5f6-4789-8abc-def012345678";
    const GC_SOURCE_DB: &str = "b2c3d4e5-f6a7-4890-9bcd-ef0123456789";
    const GC_OPENING_KEY: &str = "1f2e3d4c-5b6a-4789-8abc-0123456789ab";
    const GC_OPENING_QUEUE_ID: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const GC_SHIFT: &str = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
    const GC_DRAWER: &str = "3b4c5d6e-7f8a-4b9c-8d0e-2f3a4b5c6d7e";
    const GC_ACK: &str = "4c5d6e7f-8a9b-4c0d-9e1f-3a4b5c6d7e8f";
    const GC_CLOSING_KEY: &str = "5d6e7f8a-9b0c-4d1e-8f2a-4b5c6d7e8f9a";
    const GC_QUEUE_ID: &str = "6e7f8a9b-0c1d-4e2f-9a3b-5c6d7e8f9a0b";
    const GC_OPENED_AT: &str = "2026-09-30T08:00:00.000Z";
    const GC_CLOSED_AT: &str = "2026-09-30T18:00:00.000Z";
    const GC_CANONICAL_AT: &str = "2026-09-30T18:00:07.250Z";
    const GC_ADOPTED_AT: &str = "2026-09-30T18:02:00.000Z";

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum GiftCloseStage {
        /// Persisted opening refused as unusable, without a closing proof.
        RefusedUnusable,
        /// Opening confirmed usable, mirror closed locally, no closing journal.
        JournalMissing,
        /// Closing original captured; the hosted proof is not adopted.
        Pending,
        /// Canonical proof adopted onto both mirrors.
        Adopted,
    }

    #[derive(Clone, Copy, Debug)]
    enum GiftCloseTamper {
        Untouched,
        MirrorCount,
        MirrorBranch,
        OpeningOrganization,
    }

    fn gc_instant(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("fixture instant")
            .with_timezone(&Utc)
    }

    fn gc_payload() -> Value {
        serde_json::json!({ "branchId": GC_BRANCH, "date": "2026-09-30" })
    }

    fn gc_execute(db: &DbState, sql: &str, values: &[&dyn rusqlite::ToSql]) {
        let conn = db.conn.lock().unwrap();
        conn.execute(sql, values).expect(sql);
    }

    fn gc_count(db: &DbState, sql: &str) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row(sql, [], |row| row.get(0)).expect(sql)
    }

    fn gc_stored_report_text(db: &DbState, z_report_id: &str) -> String {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT report_json FROM z_reports WHERE id = ?1",
            params![z_report_id],
            |row| row.get(0),
        )
        .expect("stored report_json")
    }

    fn gc_only_z_report_id(db: &DbState) -> String {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT id FROM z_reports", [], |row| row.get(0))
            .expect("one stored z-report")
    }

    /// Local approved preview the count is taken against: v3/ACK, 10000 + 2000.
    fn gc_preview_drawer() -> crate::gift_financial_opening::DrawerState {
        crate::gift_financial_opening::DrawerState {
            version: 3,
            acknowledgement_id: Some(GC_ACK.to_string()),
            gift_cash_cents: 2_000,
            ordinary_expected_cents: 10_000,
            expected_cents: 12_000,
        }
    }

    /// A cashier drawer opened through a persisted financial opening and taken
    /// through the accepted journal APIs up to `stage`: float 10000, ordinary
    /// cash sales 2345, the 14000 count closed locally against the preview and,
    /// when adopted, the hosted proof ordinary 12345 + gift 2000 = 14345.
    fn seed_gift_close(db: &DbState, stage: GiftCloseStage) {
        use crate::gift_financial_closing as closing;
        let conn = db.conn.lock().unwrap();
        let usable = stage != GiftCloseStage::RefusedUnusable;
        let drawer = if usable {
            gc_preview_drawer()
        } else {
            crate::gift_financial_opening::DrawerState {
                version: 0,
                acknowledgement_id: None,
                gift_cash_cents: 0,
                ordinary_expected_cents: 10_000,
                expected_cents: 10_000,
            }
        };
        let state = if usable {
            "confirmed_usable"
        } else {
            "confirmed_unusable"
        };
        conn.execute(
            "INSERT INTO gift_financial_openings (
                opening_key, organization_id, branch_id, terminal_id, staff_id, staff_name,
                shift_id, drawer_id, opening_cents, currency, checked_in_at, business_date,
                period_start_at, is_day_start, calculation_version, queue_item_id, state,
                owner_terminal_db_id, source_terminal_db_id, server_usable, drawer_version,
                drawer_acknowledgement_id, drawer_gift_cash_cents, drawer_ordinary_expected_cents,
                drawer_expected_cents, confirmation_json, confirmed_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'Maria', ?6, ?7, 10000, 'EUR', ?8, '2026-09-30', ?8, 1, 2,
                      ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?8, ?8, ?8)",
            params![
                GC_OPENING_KEY,
                GC_ORG,
                GC_BRANCH,
                GC_TERMINAL,
                GC_STAFF,
                GC_SHIFT,
                GC_DRAWER,
                GC_OPENED_AT,
                GC_OPENING_QUEUE_ID,
                state,
                GC_OWNER_DB,
                GC_SOURCE_DB,
                i64::from(usable),
                drawer.version,
                drawer.acknowledgement_id,
                drawer.gift_cash_cents,
                drawer.ordinary_expected_cents,
                drawer.expected_cents,
                r#"{"fixture":"stored opening proof"}"#,
            ],
        )
        .expect("seed the financial opening");
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, report_date, period_start_at,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, transferred_to_cashier_shift_id,
                sync_status, created_at, updated_at, is_day_start
            ) VALUES (?1, ?2, 'Maria', ?3, ?4, 'cashier', ?5, '2026-09-30', ?5, 100, 10000,
                      'active', 2, NULL, 'pending', ?5, ?5, 1)",
            params![GC_SHIFT, GC_STAFF, GC_BRANCH, GC_TERMINAL, GC_OPENED_AT],
        )
        .expect("seed the cashier shift");
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 100, 10000, ?6, ?6, ?6)",
            params![
                GC_DRAWER,
                GC_SHIFT,
                GC_STAFF,
                GC_BRANCH,
                GC_TERMINAL,
                GC_OPENED_AT
            ],
        )
        .expect("seed the drawer");

        if matches!(stage, GiftCloseStage::Pending | GiftCloseStage::Adopted) {
            let tx = conn.unchecked_transaction().expect("begin the capture");
            closing::capture_original(
                &tx,
                &closing::ClosingCapture {
                    closing_key: GC_CLOSING_KEY.to_string(),
                    opening_key: GC_OPENING_KEY.to_string(),
                    queue_item_id: GC_QUEUE_ID.to_string(),
                    organization_id: GC_ORG.to_string(),
                    branch_id: GC_BRANCH.to_string(),
                    terminal_id: GC_TERMINAL.to_string(),
                    staff_id: GC_STAFF.to_string(),
                    shift_id: GC_SHIFT.to_string(),
                    drawer_id: GC_DRAWER.to_string(),
                    owner_terminal_db_id: GC_OWNER_DB.to_string(),
                    source_terminal_db_id: GC_SOURCE_DB.to_string(),
                    currency: "EUR".to_string(),
                    counted_cents: 14_000,
                    closed_at: GC_CLOSED_AT.to_string(),
                    confirmed_drawer: drawer.clone(),
                    drawer: drawer.clone(),
                    request_body: serde_json::json!({
                        "event": "shift_close",
                        "shift_id": GC_SHIFT,
                        "drawer_id": GC_DRAWER,
                        "closing_key": GC_CLOSING_KEY,
                        "closing_cash_cents": 14_000,
                        "closed_at": GC_CLOSED_AT
                    }),
                },
                gc_instant("2026-09-30T18:00:01.000Z"),
            )
            .expect("capture the closing original");
            tx.commit().expect("commit the capture");
        }

        let expected = drawer.expected_cents;
        let variance = 14_000 - expected;
        conn.execute(
            "UPDATE cash_drawer_sessions SET
                closing_amount = 140.0, closing_amount_cents = 14000,
                expected_amount = ?1, expected_amount_cents = ?2,
                variance_amount = ?3, variance_amount_cents = ?4,
                total_cash_sales = 23.45, total_cash_sales_cents = 2345,
                reconciled = 1, closed_at = ?5, reconciled_at = ?5, updated_at = ?5
             WHERE id = ?6",
            params![
                expected as f64 / 100.0,
                expected,
                variance as f64 / 100.0,
                variance,
                GC_CLOSED_AT,
                GC_DRAWER
            ],
        )
        .expect("close the drawer locally");
        conn.execute(
            "UPDATE staff_shifts SET
                closing_cash_amount = 140.0, closing_cash_amount_cents = 14000,
                expected_cash_amount = ?1, expected_cash_amount_cents = ?2,
                cash_variance = ?3, cash_variance_cents = ?4,
                check_out_time = ?5, status = 'closed', sync_status = 'pending', updated_at = ?5
             WHERE id = ?6",
            params![
                expected as f64 / 100.0,
                expected,
                variance as f64 / 100.0,
                variance,
                GC_CLOSED_AT,
                GC_SHIFT
            ],
        )
        .expect("close the shift locally");

        if stage == GiftCloseStage::Adopted {
            let proof = serde_json::json!({
                "contract": "gift_closing_v1",
                "state": "closed",
                "organization_id": GC_ORG,
                "branch_id": GC_BRANCH,
                "terminal_id": GC_TERMINAL,
                "source_terminal_id": GC_SOURCE_DB,
                "owner_terminal_id": GC_OWNER_DB,
                "shift_id": GC_SHIFT,
                "drawer_id": GC_DRAWER,
                "staff_id": GC_STAFF,
                "currency": "EUR",
                "counted_cents": 14_000,
                "variance_cents": -345,
                "closed_at": GC_CANONICAL_AT,
                "drawer": {
                    "contract": "gift_funding_v1",
                    "drawer_id": GC_DRAWER,
                    "shift_id": GC_SHIFT,
                    "owner_terminal_id": GC_OWNER_DB,
                    "currency": "EUR",
                    "gift_cash_cents": 2_000,
                    "ordinary_expected_cents": 12_345,
                    "expected_cents": 14_345,
                    "version": 3,
                    "acknowledgement_id": GC_ACK
                }
            });
            let reply = serde_json::json!({
                "success": true,
                "results": [{ "shift_id": GC_SHIFT, "status": "ok", "financial_closing": proof }]
            });
            let tx = conn.unchecked_transaction().expect("begin the adoption");
            match closing::adopt_closing_response(
                &tx,
                GC_CLOSING_KEY,
                Some(&reply),
                None,
                gc_instant(GC_ADOPTED_AT),
            )
            .expect("adopt the canonical close")
            {
                closing::ClosingAdoption::Adopted {
                    replayed: false, ..
                } => {}
                _ => panic!("expected the first adoption of the canonical close"),
            }
            tx.commit().expect("commit the adoption");
        }
    }

    #[test]
    fn gift_close_report_freezes_canonical_ordinary_plus_gift_and_replays_unchanged() {
        let db = test_db();
        seed_gift_close(&db, GiftCloseStage::Adopted);

        let built = build_z_report_for_date(&db, &gc_payload(), false).expect("build");
        assert_eq!(built.shift_count, 1);
        assert_eq!(
            Cents::round_half_even(built.total_expected).as_i64(),
            14_345
        );
        assert_eq!(Cents::round_half_even(built.total_variance).as_i64(), -345);
        // Gift liability cash is a drawer movement: no sale, tender or revenue.
        assert_eq!(built.cash_sales, 0.0);
        assert_eq!(built.gross_sales, 0.0);
        assert!(built.gift_close.is_ready());
        assert_eq!(built.gift_close.originals.len(), 1);

        let generated = generate_z_report_for_date(&db, &gc_payload()).expect("generate");
        assert_eq!(generated["existing"], false);
        let z_report_id = generated["zReportId"]
            .as_str()
            .expect("zReportId")
            .to_string();
        let stored = gc_stored_report_text(&db, &z_report_id);
        let report_json: Value = serde_json::from_str(&stored).expect("stored report_json");

        let drawer = &report_json["cashDrawer"];
        assert_eq!(drawer["expected_cents"], 14_345);
        assert_eq!(drawer["totalVariance_cents"], -345);
        assert_eq!(drawer["ordinaryExpected_cents"], 12_345);
        assert_eq!(drawer["giftLiabilityCash_cents"], 2_000);
        assert_eq!(drawer["ordinaryAdjustment_cents"], 0);

        let gift = &report_json[GIFT_CLOSE_REPORT_KEY];
        assert_eq!(gift["contract"], GIFT_CLOSE_REPORT_CONTRACT);
        assert_eq!(gift["ready"], true);
        assert_eq!(gift["giftLiabilityCash_cents"], 2_000);
        assert_eq!(gift["blockers"], serde_json::json!([]));
        assert_eq!(gift["originals"].as_array().map(Vec::len), Some(1));
        let original = &gift["originals"][0];
        assert_eq!(original["shiftId"], GC_SHIFT);
        assert_eq!(original["drawerId"], GC_DRAWER);
        assert_eq!(original["terminalId"], GC_TERMINAL);
        assert_eq!(original["currency"], "EUR");
        assert_eq!(original["ordinaryExpected_cents"], 12_345);
        assert_eq!(original["giftLiabilityCash_cents"], 2_000);
        assert_eq!(original["expected_cents"], 14_345);
        assert_eq!(original["counted_cents"], 14_000);
        assert_eq!(original["variance_cents"], -345);
        assert_eq!(original["ordinaryAdjustment_cents"], 0);
        assert_eq!(original["drawerVersion"], 3);
        assert_eq!(original["provenance"]["contract"], "gift_closing_v1");
        assert_eq!(original["provenance"]["localClosedAt"], GC_CLOSED_AT);
        assert_eq!(original["provenance"]["canonicalClosedAt"], GC_CANONICAL_AT);
        assert!(original["provenance"]["adoptedAt"].is_string());
        // Nonsecret: neither the acknowledgement nor the request body.
        assert!(!gift.to_string().contains(GC_ACK));
        assert!(!gift.to_string().contains("closing_cash_cents"));

        // A later local drawer edit never reaches the frozen report: replay
        // returns the stored row and nothing is added twice or duplicated.
        gc_execute(
            &db,
            "UPDATE cash_drawer_sessions SET total_cash_sales = 99.99, total_cash_sales_cents = 9999
              WHERE id = ?1",
            params![GC_DRAWER],
        );
        let replay = generate_z_report_for_date(&db, &gc_payload()).expect("replay");
        assert_eq!(replay["existing"], true);
        assert_eq!(
            extract_z_report_id(&replay).as_deref(),
            Some(z_report_id.as_str())
        );
        // A same-day preview rebuilds the live window and never persists.
        preview_z_report_for_date(&db, &gc_payload()).expect("live preview");
        assert_eq!(gc_count(&db, "SELECT COUNT(*) FROM z_reports"), 1);
        assert_eq!(gc_stored_report_text(&db, &z_report_id), stored);
    }

    #[test]
    fn gift_close_shift_report_freezes_the_adopted_close_once() {
        let db = test_db();
        seed_gift_close(&db, GiftCloseStage::Adopted);

        generate_z_report(&db, &serde_json::json!({ "shiftId": GC_SHIFT })).expect("shift report");
        let z_report_id = gc_only_z_report_id(&db);
        let stored = gc_stored_report_text(&db, &z_report_id);
        let report_json: Value = serde_json::from_str(&stored).expect("stored report_json");
        assert_eq!(report_json["cashDrawer"]["giftLiabilityCash_cents"], 2_000);
        assert_eq!(report_json["cashDrawer"]["ordinaryExpected_cents"], 12_345);
        assert_eq!(report_json["cashDrawer"]["ordinaryAdjustment_cents"], 0);
        let original = &report_json[GIFT_CLOSE_REPORT_KEY]["originals"][0];
        assert_eq!(original["expected_cents"], 14_345);
        assert_eq!(original["counted_cents"], 14_000);
        assert_eq!(original["variance_cents"], -345);

        let replay =
            generate_z_report(&db, &serde_json::json!({ "shiftId": GC_SHIFT })).expect("replay");
        assert_eq!(replay["existing"], true);
        assert_eq!(gc_count(&db, "SELECT COUNT(*) FROM z_reports"), 1);
        assert_eq!(gc_stored_report_text(&db, &z_report_id), stored);
    }

    #[test]
    fn gift_close_pending_missing_or_mismatched_proof_blocks_finalization_with_an_empty_queue() {
        for (stage, tamper, code) in [
            (
                GiftCloseStage::Pending,
                GiftCloseTamper::Untouched,
                GIFT_CLOSE_PROOF_PENDING,
            ),
            (
                GiftCloseStage::JournalMissing,
                GiftCloseTamper::Untouched,
                GIFT_CLOSE_JOURNAL_MISSING,
            ),
            (
                GiftCloseStage::Adopted,
                GiftCloseTamper::MirrorCount,
                GIFT_CLOSE_PROOF_MISMATCH,
            ),
            (
                GiftCloseStage::Adopted,
                GiftCloseTamper::MirrorBranch,
                GIFT_CLOSE_PROOF_MISMATCH,
            ),
            (
                GiftCloseStage::Adopted,
                GiftCloseTamper::OpeningOrganization,
                GIFT_CLOSE_PROOF_MISMATCH,
            ),
        ] {
            let case = format!("{stage:?}/{tamper:?}");
            let db = test_db();
            seed_gift_close(&db, stage);
            match tamper {
                GiftCloseTamper::Untouched => {}
                // An ordinary repair replaced the adopted count: never evidence.
                GiftCloseTamper::MirrorCount => gc_execute(
                    &db,
                    "UPDATE cash_drawer_sessions SET closing_amount = 120.0, closing_amount_cents = 12000
                      WHERE id = ?1",
                    params![GC_DRAWER],
                ),
                // The adopted drawer no longer sits in its original's branch.
                GiftCloseTamper::MirrorBranch => gc_execute(
                    &db,
                    "UPDATE cash_drawer_sessions SET branch_id = ?1 WHERE id = ?2",
                    params![GC_OTHER_BRANCH, GC_DRAWER],
                ),
                GiftCloseTamper::OpeningOrganization => gc_execute(
                    &db,
                    "UPDATE gift_financial_openings SET organization_id = ?1 WHERE opening_key = ?2",
                    params![GC_OTHER_BRANCH, GC_OPENING_KEY],
                ),
            }
            {
                // An already consumed queue: emptiness is never proof.
                let conn = db.conn.lock().unwrap();
                let _ = conn.execute("DELETE FROM sync_queue", []);
                let _ = conn.execute("DELETE FROM parity_sync_queue", []);
            }

            let readiness =
                get_closeout_readiness_snapshot(&db, &serde_json::json!({ "branchId": GC_BRANCH }))
                    .expect("readiness");
            assert_eq!(readiness["unsyncedSyncQueue"]["count"], 0, "{case}");
            let gift = &readiness["giftCloseProof"];
            assert_eq!(gift["ready"], false, "{case}");
            assert_eq!(gift["count"], 1, "{case}");
            assert_eq!(gift["confirmedCount"], 0, "{case}");
            assert_eq!(gift["details"][0]["code"], code, "{case}");
            assert_eq!(gift["details"][0]["shiftId"], GC_SHIFT, "{case}");

            let preview = preview_z_report_for_date(&db, &gc_payload()).expect("preview");
            assert_eq!(preview["giftCloseReadiness"]["ready"], false, "{case}");
            assert_eq!(
                preview["giftCloseReadiness"]["details"][0]["code"], code,
                "{case}"
            );

            for (seam, outcome) in [
                (
                    "prepare",
                    prepare_z_report_submission(&db, &gc_payload()).map(|_| ()),
                ),
                ("submit", submit_z_report(&db, &gc_payload()).map(|_| ())),
                (
                    "date",
                    generate_z_report_for_date(&db, &gc_payload()).map(|_| ()),
                ),
                (
                    "shift",
                    generate_z_report(&db, &serde_json::json!({ "shiftId": GC_SHIFT })).map(|_| ()),
                ),
            ] {
                let error = outcome.expect_err(&format!("{case}: {seam} must be blocked"));
                assert!(
                    error.starts_with(GIFT_CLOSE_PROOF_REQUIRED),
                    "{case} {seam}: {error}"
                );
                assert!(error.contains(code), "{case} {seam}: {error}");
            }
            assert_eq!(gc_count(&db, "SELECT COUNT(*) FROM z_reports"), 0, "{case}");
            assert_eq!(
                gc_count(&db, "SELECT COUNT(*) FROM staff_shifts"),
                1,
                "{case}"
            );
            assert_eq!(
                gc_count(&db, "SELECT COUNT(*) FROM cash_drawer_sessions"),
                1,
                "{case}"
            );

            if matches!(tamper, GiftCloseTamper::Untouched) {
                // Scope control: another branch's closeout is not held by it.
                let other = get_closeout_readiness_snapshot(
                    &db,
                    &serde_json::json!({ "branchId": GC_OTHER_BRANCH }),
                )
                .expect("other branch readiness");
                assert_eq!(other["giftCloseProof"]["ready"], true, "{case}");
                assert_eq!(other["giftCloseProof"]["count"], 0, "{case}");

                // Window control: only windows covering the drawer hold it.
                let conn = db.conn.lock().unwrap();
                let held = |start: &str, cutoff: Option<&str>| {
                    load_gift_close_report_for_window(
                        &conn,
                        GC_BRANCH,
                        start,
                        cutoff,
                        LowerBoundMode::Inclusive,
                    )
                    .expect("window gift report")
                    .blockers
                    .len()
                };
                assert_eq!(held("2026-09-30T00:00:00.000Z", None), 1, "{case}");
                assert_eq!(
                    held(GC_OPENED_AT, Some("2026-09-30T23:59:59.000Z")),
                    1,
                    "{case}"
                );
                assert_eq!(held("2026-09-30T08:00:00.001Z", None), 0, "{case}");
                assert_eq!(
                    held("2026-09-29T00:00:00.000Z", Some("2026-09-30T07:59:59.999Z")),
                    0,
                    "{case}"
                );
            }
        }
    }

    #[test]
    fn gift_close_stale_pre_proof_snapshot_cannot_finalize_or_be_rewritten() {
        let db = test_db();
        seed_gift_close(&db, GiftCloseStage::Adopted);
        let generated = generate_z_report_for_date(&db, &gc_payload()).expect("generate");
        let z_report_id = generated["zReportId"]
            .as_str()
            .expect("zReportId")
            .to_string();
        // Stand in for a report stored before the canonical close was adopted.
        gc_execute(
            &db,
            "UPDATE z_reports SET report_json = json_remove(report_json, '$.giftFinancialClose')
              WHERE id = ?1",
            params![z_report_id],
        );
        let stale = gc_stored_report_text(&db, &z_report_id);
        assert!(!stale.contains(GIFT_CLOSE_REPORT_KEY));

        for (seam, outcome) in [
            (
                "prepare",
                prepare_z_report_submission(&db, &gc_payload()).map(|_| ()),
            ),
            ("submit", submit_z_report(&db, &gc_payload()).map(|_| ())),
            (
                "date",
                generate_z_report_for_date(&db, &gc_payload()).map(|_| ()),
            ),
        ] {
            let error = outcome.expect_err(&format!("{seam} must refuse the stale snapshot"));
            assert!(
                error.starts_with(GIFT_CLOSE_SNAPSHOT_STALE),
                "{seam}: {error}"
            );
            assert!(error.contains(&z_report_id), "{seam}: {error}");
        }
        // Nothing was rewritten, discarded or rolled over.
        assert_eq!(gc_stored_report_text(&db, &z_report_id), stale);
        assert_eq!(gc_count(&db, "SELECT COUNT(*) FROM z_reports"), 1);
        assert_eq!(gc_count(&db, "SELECT COUNT(*) FROM staff_shifts"), 1);
        assert_eq!(
            gc_count(&db, "SELECT COUNT(*) FROM cash_drawer_sessions"),
            1
        );
    }

    #[test]
    fn gift_close_snapshot_with_same_drawer_requires_matching_confirmed_values() {
        for tamper in ["amount", "currency", "provenance", "pending", "duplicate"] {
            let db = test_db();
            seed_gift_close(&db, GiftCloseStage::Adopted);
            let generated = generate_z_report_for_date(&db, &gc_payload()).expect("generate");
            let id = generated["zReportId"].as_str().unwrap().to_string();
            let mut stored: Value = serde_json::from_str(&gc_stored_report_text(&db, &id)).unwrap();
            let projection = &mut stored[GIFT_CLOSE_REPORT_KEY];
            match tamper {
                "amount" => projection["originals"][0]["expected_cents"] = serde_json::json!(12000),
                "currency" => projection["originals"][0]["currency"] = serde_json::json!("USD"),
                "provenance" => {
                    projection["originals"][0]["provenance"]["status"] =
                        serde_json::json!("pending")
                }
                "pending" => projection["ready"] = serde_json::json!(false),
                "duplicate" => {
                    let duplicate = projection["originals"][0].clone();
                    projection["originals"]
                        .as_array_mut()
                        .unwrap()
                        .push(duplicate);
                }
                _ => unreachable!(),
            }
            let frozen = serde_json::to_string(&stored).unwrap();
            gc_execute(
                &db,
                "UPDATE z_reports SET report_json = ?1 WHERE id = ?2",
                params![frozen, id],
            );
            for result in [
                prepare_z_report_submission(&db, &gc_payload()).map(|_| ()),
                generate_z_report_for_date(&db, &gc_payload()).map(|_| ()),
            ] {
                let error = result.expect_err(tamper);
                assert!(
                    error.starts_with(GIFT_CLOSE_SNAPSHOT_STALE),
                    "{tamper}: {error}"
                );
            }
            assert_eq!(gc_stored_report_text(&db, &id), frozen, "{tamper}");
        }
    }

    #[test]
    fn gift_close_ordinary_is_unchanged_but_refused_opening_still_requires_proof() {
        // Ordinary control: no financial opening, no gift block.
        let db = test_db();
        seed_closed_shift(&db);
        let readiness =
            get_closeout_readiness_snapshot(&db, &serde_json::json!({ "branchId": "branch-1" }))
                .expect("readiness");
        assert_eq!(readiness["giftCloseProof"]["ready"], true);
        assert_eq!(readiness["giftCloseProof"]["count"], 0);
        assert_eq!(readiness["giftCloseProof"]["confirmedCount"], 0);
        let generated = generate_z_report_for_date(
            &db,
            &serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" }),
        )
        .expect("ordinary report");
        let id = generated["zReportId"]
            .as_str()
            .expect("zReportId")
            .to_string();
        let report_json: Value =
            serde_json::from_str(&gc_stored_report_text(&db, &id)).expect("stored report_json");
        assert!(report_json.get(GIFT_CLOSE_REPORT_KEY).is_none());
        assert!(report_json["cashDrawer"]
            .get("giftLiabilityCash_cents")
            .is_none());

        // Same persisted identity rule as native close capture. Neither zero
        // nor missing funding totals prove a successful ordinary closure.
        let db = test_db();
        seed_gift_close(&db, GiftCloseStage::RefusedUnusable);
        for cash in [Some(0_i64), None] {
            gc_execute(
                &db,
                "UPDATE gift_financial_openings SET drawer_gift_cash_cents = ?1",
                params![cash],
            );
            let built = build_z_report_for_date(&db, &gc_payload(), false).expect("build");
            assert!(!built.gift_close.is_ready());
            assert_eq!(
                built.gift_close.blockers[0].code,
                GIFT_CLOSE_JOURNAL_MISSING
            );
            let error =
                generate_z_report_for_date(&db, &gc_payload()).expect_err("missing original");
            assert!(error.starts_with(GIFT_CLOSE_PROOF_REQUIRED));
            assert_eq!(gc_count(&db, "SELECT COUNT(*) FROM z_reports"), 0);
        }
    }

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

    fn seed_original_currency_report(db: &DbState) {
        let conn = db.conn.lock().unwrap();
        conn.execute_batch(
            "INSERT INTO staff_shifts (id,staff_id,staff_name,branch_id,terminal_id,role_type,
               opening_cash_amount,closing_cash_amount,expected_cash_amount,cash_variance,
               check_in_time,check_out_time,status,currency,created_at,updated_at)
             VALUES ('currency-shift','currency-staff','Cashier','branch-1','term-1','cashier',
               10,20,20,0,'2026-02-16T09:00:00Z','2026-02-16T18:00:00Z','closed','CHF',
               '2026-02-16T09:00:00Z','2026-02-16T18:00:00Z');
             INSERT INTO cash_drawer_sessions (id,staff_shift_id,cashier_id,branch_id,terminal_id,
               opening_amount,closing_amount,expected_amount,variance_amount,total_cash_sales,
               reconciled,opened_at,closed_at,currency,created_at,updated_at)
             VALUES ('currency-drawer','currency-shift','currency-staff','branch-1','term-1',
               10,20,20,0,10,1,'2026-02-16T09:00:00Z','2026-02-16T18:00:00Z','CHF',
               '2026-02-16T09:00:00Z','2026-02-16T18:00:00Z');
             INSERT INTO orders(id,order_number,items,total_amount,status,order_type,payment_status,
               staff_shift_id,branch_id,currency,created_at,updated_at)
             VALUES ('currency-order','C1','[]',10,'completed','pickup','paid','currency-shift','branch-1',
               'CHF','2026-02-16T12:00:00Z','2026-02-16T12:00:00Z');
             INSERT INTO order_payments(id,order_id,method,amount,status,staff_shift_id,currency,created_at,updated_at)
             VALUES ('currency-payment','currency-order','cash',10,'completed','currency-shift','CHF',
               '2026-02-16T12:00:00Z','2026-02-16T12:00:00Z');"
        ).expect("seed original CHF report");
    }

    #[test]
    fn z_report_currency_is_frozen_and_never_relabelled_by_current_country() {
        let db = test_db();
        seed_original_currency_report(&db);
        let date_report = build_z_report_for_date(
            &db,
            &serde_json::json!({"branchId":"branch-1","date":"2026-02-16"}),
            false,
        )
        .unwrap();
        assert_eq!(date_report.report_json["currency"], "CHF");
        assert_eq!(date_report.report_json["dayOrders"][0]["currency"], "CHF");
        let payload = serde_json::json!({"shiftId":"currency-shift"});
        let first = generate_z_report(&db, &payload).unwrap();
        assert_eq!(first["report"]["currency"], "CHF");
        assert_eq!(first["report"]["reportJson"]["currency"], "CHF");
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "restaurant", "currency", "USD").unwrap();
            db::set_setting(&conn, "terminal", "store_country", "United States").unwrap();
        }
        let replay = generate_z_report(&db, &payload).unwrap();
        assert_eq!(replay["report"]["currency"], "CHF");
        let stored: Value =
            serde_json::from_str(replay["report"]["reportJson"].as_str().unwrap()).unwrap();
        assert_eq!(stored["currency"], "CHF");
        assert_eq!(replay["zReportId"], first["zReportId"]);
    }

    #[test]
    fn z_report_currency_checks_unassigned_orders_and_legacy_expenses() {
        let db = test_db();
        seed_original_currency_report(&db);
        let conn = db.conn.lock().unwrap();
        let currency = || {
            report_window_currency(
                &conn,
                "branch-1",
                "2026-02-16T00:00:00Z",
                Some("2026-02-16T23:59:59Z"),
                LowerBoundMode::Inclusive,
                vec![Some("CHF".to_string())],
            )
            .unwrap()
        };
        assert_eq!(currency(), Some("CHF".to_string()));
        conn.execute("INSERT INTO orders(id,order_number,items,total_amount,status,order_type,branch_id,currency,created_at,updated_at)
          VALUES ('unassigned-currency','C2','[]',5,'completed','pickup','branch-1','USD','2026-02-16T12:00:00Z','2026-02-16T12:00:00Z')",[]).unwrap();
        assert_eq!(currency(), None);
        conn.execute("DELETE FROM orders WHERE id='unassigned-currency'", [])
            .unwrap();
        conn.execute("INSERT INTO shift_expenses(id,staff_shift_id,staff_id,branch_id,expense_type,amount,description,created_at,updated_at)
          VALUES ('legacy-currency-expense','currency-shift','currency-staff','branch-1','supplies',2,'legacy unit','2026-02-16T12:00:00Z','2026-02-16T12:00:00Z')",[]).unwrap();
        assert_eq!(currency(), None);
    }

    #[test]
    fn z_report_currency_leaves_legacy_and_mixed_units_unknown() {
        assert_eq!(
            common_report_currency([Some("CHF".to_string()), None]),
            None
        );
        assert_eq!(
            common_report_currency([Some("CHF".to_string()), Some("USD".to_string())]),
            None
        );
        assert_eq!(common_report_currency([Some("EUR;bad".to_string())]), None);
        let db = test_db();
        let shift = seed_closed_shift(&db);
        let report = generate_z_report(&db, &serde_json::json!({"shiftId":shift})).unwrap();
        assert!(report["report"]["currency"].is_null());
        assert!(report["report"]["reportJson"]["currency"].is_null());
    }

    #[test]
    fn z_report_currency_checks_void_parent_without_adjustment_shift() {
        // Adjustment totals follow the original payment/order owner even when
        // legacy adjustments did not capture their own staff_shift_id.
        for payment_has_shift in [true, false] {
            let db = test_db();
            seed_original_currency_report(&db);
            {
                let conn = db.conn.lock().unwrap();
                conn.execute(
                    "UPDATE order_payments SET status='voided',currency='',staff_shift_id=?1
                     WHERE id='currency-payment'",
                    [payment_has_shift.then_some("currency-shift")],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO payment_adjustments(id,payment_id,order_id,adjustment_type,
                       amount,amount_cents,reason,sync_state,created_at,updated_at)
                     VALUES ('currency-void','currency-payment','currency-order','void',10,1000,
                       'legacy void','applied','2026-02-16T13:00:00Z','2026-02-16T13:00:00Z')",
                    [],
                )
                .unwrap();
                assert_eq!(
                    report_shift_currency(&conn, "currency-shift").unwrap(),
                    None
                );
            }
            let report =
                generate_z_report(&db, &serde_json::json!({"shiftId":"currency-shift"})).unwrap();
            assert_eq!(report["report"]["voidsTotal"], 10.0);
            assert!(report["report"]["currency"].is_null());
            assert!(report["report"]["reportJson"]["currency"].is_null());
        }
    }

    fn local_datetime(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> DateTime<Local> {
        match Local.with_ymd_and_hms(year, month, day, hour, minute, second) {
            LocalResult::Single(value) => value,
            LocalResult::Ambiguous(earliest, _) => earliest,
            LocalResult::None => panic!("invalid local datetime"),
        }
    }

    fn utc_rfc3339_from_local(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> String {
        local_datetime(year, month, day, hour, minute, second)
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    #[test]
    fn print_z_report_invalidates_once_per_committed_job_insert() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        let generated = generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id }))
            .expect("generate z-report");
        let z_report_id = generated["zReportId"].as_str().expect("z-report id");
        let invalidator = CountingPrintQueueInvalidator::default();
        let payload = serde_json::json!({ "zReportId": z_report_id });

        let first = print_z_report(&db, &payload, &invalidator).expect("enqueue z-report print");
        assert_eq!(first["success"], true);
        assert_eq!(invalidator.count(), 1);

        let duplicate =
            print_z_report(&db, &payload, &invalidator).expect("deduplicate z-report print");
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(invalidator.count(), 1);

        assert!(print_z_report(
            &db,
            &serde_json::json!({ "zReportId": "missing-z-report" }),
            &invalidator,
        )
        .is_err());
        assert_eq!(
            invalidator.count(),
            1,
            "lookup failure must not invalidate without a print INSERT"
        );
    }

    #[test]
    fn twint_z_uses_canonical_portions_and_persists_a_distinct_bucket() {
        let db = test_db();
        let shift = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE order_payments SET amount=10,amount_cents=1000 WHERE id='pay-1'",
                [],
            )
            .unwrap();
            conn.execute("UPDATE order_payments SET method='card',amount=20,amount_cents=2000,order_id='ord-3' WHERE id='pay-2'", []).unwrap();
            conn.execute("UPDATE order_payments SET method='twint',amount=25,amount_cents=2500,currency='CHF',idempotency_key='twint-original' WHERE id='pay-3'", []).unwrap();
            // A completed legacy/corrupt receipt is not a CHF TWINT tender
            // merely because its method is TWINT. Ordinary EUR rows above
            // keep their existing cash/card admission and amounts.
            for (id, currency) in [
                ("wrong-currency-twint", "EUR"),
                ("malformed-currency-twint", "chf"),
                ("empty-currency-twint", ""),
            ] {
                conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,status,staff_shift_id,currency,created_at,updated_at) VALUES(?1,'ord-3','twint',99,9900,'completed',?2,?3,'2026-02-16T18:00:00Z','2026-02-16T18:00:00Z')",params![id,shift,currency]).unwrap();
            }
            for (id, status) in [
                ("ignored-review", "duplicate_review"),
                ("ignored-refunded", "refunded"),
                ("ignored-void", "voided"),
            ] {
                conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,status,staff_shift_id,currency,created_at,updated_at) VALUES(?1,'ord-3','twint',99,9900,?2,?3,'CHF','2026-02-16T18:00:00Z','2026-02-16T18:00:00Z')",params![id,status,shift]).unwrap();
            }
            conn.execute("INSERT OR IGNORE INTO order_payments(id,order_id,method,amount,amount_cents,status,staff_shift_id,currency,idempotency_key,created_at,updated_at) VALUES('twint-replay','ord-3','twint',25,2500,'completed',?1,'CHF','twint-original','2026-02-16T18:00:00Z','2026-02-16T18:00:00Z')",params![shift]).unwrap();
        }
        let built = build_z_report_for_date(&db,&serde_json::json!({"branchId":"branch-1","date":"2026-02-16","cutoffAt":"2026-02-16T23:00:00Z"}), false).unwrap();
        assert_eq!(built.report_json["daySummary"]["total"], 55.0);
        assert_eq!(built.report_json["sales"]["cardSales"], 20.0);
        assert_eq!(built.report_json["sales"]["twintSales"], 25.0);
        assert_eq!(built.report_json["sales"]["twintPaymentCount"], 1);
        assert_eq!(built.report_json["sales"]["twintSalesCents"], 2500);
        assert_eq!(
            built.report_json["staffReports"][0]["orders"]["twintAmount"],
            25.0
        );
        assert_eq!(built.payments_breakdown["other"]["total"], 0.0);
        let generated = generate_z_report(&db, &serde_json::json!({"shiftId":shift})).unwrap();
        assert_eq!(
            generated["report"]["reportJson"]["daySummary"]["total"],
            55.0
        );
        assert_eq!(
            generated["report"]["reportJson"]["sales"]["twintPaymentCount"],
            1
        );
        assert_eq!(
            generated["report"]["reportJson"]["staffReports"][0]["orders"]["twintAmount"],
            25.0
        );
        let saved = get_z_report(
            &db,
            &serde_json::json!({"zReportId":generated["zReportId"]}),
        )
        .unwrap();
        let json: Value =
            serde_json::from_str(saved["report"]["reportJson"].as_str().unwrap()).unwrap();
        assert_eq!(json["sales"]["twintSales"], 25.0);
        assert!(json["presentation"].is_object());
        // Analytics reads the same completed portions, including a split order.
        let conn = db.conn.lock().unwrap();
        let analytics = crate::commands::analytics::load_payment_method_breakdown_for_day(
            &conn,
            "branch-1",
            "2026-02-16",
        )
        .unwrap();
        // Old fixture orders have no branch; scope must not treat them as current branch.
        assert_eq!(analytics["twint"]["total"], 0.0);
        conn.execute("UPDATE orders SET branch_id='branch-1'", [])
            .unwrap();
        let analytics = crate::commands::analytics::load_payment_method_breakdown_for_day(
            &conn,
            "branch-1",
            "2026-02-16",
        )
        .unwrap();
        assert_eq!(analytics["twint"]["total"], 25.0);
        assert_eq!(analytics["twint"]["count"], 1);
        assert_eq!(analytics["card"]["total"], 20.0);
        assert_eq!(analytics["other"]["total"], 0.0);
        assert_eq!(
            crate::commands::analytics::load_payment_method_breakdown_for_day(
                &conn,
                "foreign",
                "2026-02-16"
            )
            .unwrap()["twint"]["total"],
            0.0
        );
        assert_eq!(
            crate::commands::analytics::load_payment_method_breakdown_for_day(
                &conn,
                "branch-1",
                "2026-02-17"
            )
            .unwrap()["twint"]["total"],
            0.0
        );
        conn.execute("UPDATE orders SET status='cancelled' WHERE id='ord-3'", [])
            .unwrap();
        let retained = crate::commands::analytics::load_payment_method_breakdown_for_day(
            &conn,
            "branch-1",
            "2026-02-16",
        )
        .unwrap();
        assert_eq!(
            retained["twint"]["total"], 25.0,
            "cancelling fulfillment never returns TWINT money"
        );
        assert_eq!(
            retained["card"]["total"], 0.0,
            "ordinary cancellation semantics stay unchanged"
        );
        conn.execute("INSERT INTO orders(id,order_number,branch_id,items,total_amount,total_amount_cents,status,payment_status,order_type,staff_shift_id,created_at,updated_at) VALUES('partial-twint','#partial','branch-1','[]',30,3000,'completed','partially_paid','dine-in',?1,'2026-02-16T18:00:00Z','2026-02-16T18:00:00Z')",params![shift]).unwrap();
        conn.execute("INSERT INTO orders(id,order_number,branch_id,items,total_amount,total_amount_cents,status,payment_status,order_type,staff_shift_id,created_at,updated_at) VALUES('future-twint','#future','branch-1','[]',50,5000,'completed','paid','dine-in',?1,'2026-02-17T01:00:00Z','2026-02-17T01:00:00Z')",params![shift]).unwrap();
        for (id, date, amount) in [
            ("partial-5", "2026-02-16T18:00:00Z", 5),
            ("later-50", "2026-02-17T01:00:00Z", 50),
        ] {
            conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,status,staff_shift_id,currency,created_at,updated_at) VALUES(?1,CASE WHEN ?1='later-50' THEN 'future-twint' ELSE 'partial-twint' END,'twint',?2,?2*100,'completed',?3,'CHF',?4,?4)",params![id,amount,shift,date]).unwrap();
        }
        assert_eq!(
            crate::commands::analytics::load_payment_method_breakdown_for_day(
                &conn,
                "branch-1",
                "2026-02-16"
            )
            .unwrap()["twint"]["total"],
            30.0
        );
        persist_pending_z_report_context(
            &conn,
            &PendingZReportContext {
                branch_id: "branch-1".into(),
                report_date: "2026-02-16".into(),
                cutoff_at: "2026-02-16T23:00:00Z".into(),
                period_start_at: business_day::EPOCH_RFC3339.into(),
            },
        )
        .unwrap();
        drop(conn);
        let retained_z=build_z_report_for_date(&db,&serde_json::json!({"branchId":"branch-1","date":"2026-02-16","cutoffAt":"2026-02-16T23:00:00Z"}),false).unwrap();
        assert_eq!(retained_z.report_json["sales"]["twintSales"], 30.0);
        assert_eq!(retained_z.report_json["sales"]["retainedTwintSales"], 25.0);
        assert_eq!(retained_z.payments_breakdown["other"]["total"], 0.0);
    }

    #[test]
    fn twint_presentation_cache_requires_scope_and_entitlement_but_not_qr_readiness() {
        let mut modules = serde_json::json!({"organizationId":"org","branchId":"branch","terminalId":"term","apiModules":[{"module_id":"plugin_integrations"}]});
        let mut integrations = serde_json::json!({"success":true,"integrations":[{"plugin_id":"twint","branch_id":"branch","is_purchased":true,"is_enabled":true,"settings":{"target_terminal_id":null},"payment_setup":{"configuration_state":"pending_verification","integration_mode":"worldline_terminal"}}]});
        let flags =
            z_report_presentation_from_cache(&modules, &integrations, "org", "branch", "term");
        assert_eq!(flags["twintPluginEnabled"], true);
        assert_eq!(flags["deliveryModuleEnabled"], false);
        integrations["integrations"][0]["settings"]["target_terminal_id"] =
            serde_json::json!("other-term");
        assert_eq!(
            z_report_presentation_from_cache(&modules, &integrations, "org", "branch", "term")
                ["twintPluginEnabled"],
            false
        );
        integrations["integrations"][0]["settings"]["target_terminal_id"] = Value::Null;
        integrations["integrations"][0]["is_purchased"] = serde_json::json!(false);
        assert_eq!(
            z_report_presentation_from_cache(&modules, &integrations, "org", "branch", "term")
                ["twintPluginEnabled"],
            false
        );
        modules["terminalId"] = serde_json::json!("foreign");
        assert_eq!(
            z_report_presentation_from_cache(&modules, &integrations, "org", "branch", "term"),
            serde_json::json!({})
        );
        assert_eq!(
            z_report_presentation_from_cache(&Value::Null, &Value::Null, "org", "branch", "term"),
            serde_json::json!({})
        );
    }

    /// Insert a closed shift with associated data for testing.
    fn seed_closed_shift(db: &DbState) -> String {
        let conn = db.conn.lock().unwrap();
        let shift_id = "shift-zr-1";
        let now = "2026-02-16T18:00:00Z";

        // W4e Step 0: dual-populate every monetary column.
        // Insert shift (200/235/235/0 → 20000/23500/23500/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 20000, 235.0, 23500, 235.0, 23500, 0.0, 0,
                '2026-02-16T09:00:00Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert shift");

        // Insert cash drawer session (every monetary column dual-populated).
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                closing_amount, closing_amount_cents,
                expected_amount, expected_amount_cents,
                variance_amount, variance_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                total_refunds, total_refunds_cents,
                total_expenses, total_expenses_cents,
                cash_drops, cash_drops_cents,
                driver_cash_given, driver_cash_given_cents,
                driver_cash_returned, driver_cash_returned_cents,
                total_staff_payments, total_staff_payments_cents,
                reconciled,
                opened_at, created_at, updated_at
             ) VALUES (
                'cds-1', ?1, 'staff-1', 'branch-1', 'term-1',
                200.0, 20000, 235.0, 23500, 235.0, 23500, 0.0, 0,
                60.0, 6000, 40.0, 4000, 10.0, 1000, 15.0, 1500,
                0.0, 0, 0.0, 0, 0.0, 0,
                0.0, 0,
                0,
                '2026-02-16T09:00:00Z', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert drawer");

        // Insert 3 orders — dual-populate via Cents::round_half_even.
        for (i, total) in [(1, 25.0), (2, 35.0), (3, 40.0)] {
            let total_cents = Cents::round_half_even(total).as_i64();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id,
                    discount_amount, discount_amount_cents,
                    tip_amount, tip_amount_cents,
                    sync_status, created_at, updated_at
                 ) VALUES (?1, ?2, '[]', ?3, ?4, 'completed', 'dine-in',
                    'paid', ?5, 0.0, 0, 0.0, 0, 'pending', ?6, ?6)",
                params![
                    format!("ord-{i}"),
                    format!("#{i}"),
                    total,
                    total_cents,
                    shift_id,
                    now,
                ],
            )
            .expect("insert order");
        }

        // Insert payments: cash for orders 1+2, card for order 3.
        // Dual-populate amount + amount_cents (25/35/40 → 2500/3500/4000).
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-1', 'ord-1', 'cash', 25.0, 2500, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 1");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-2', 'ord-2', 'cash', 35.0, 3500, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 2");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-3', 'ord-3', 'card', 40.0, 4000, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 3");

        // Insert a refund adjustment on payment 1 (10.0 → 1000).
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, amount_cents, reason, sync_state, created_at, updated_at)
             VALUES ('adj-1', 'pay-1', 'ord-1', 'refund', 10.0, 1000, 'wrong item', 'pending', ?1, ?1)",
            params![now],
        ).expect("insert adjustment");

        // Insert an expense (15.0 → 1500).
        conn.execute(
            "INSERT INTO shift_expenses (id, staff_shift_id, staff_id, branch_id, expense_type, amount, amount_cents, description, sync_status, created_at, updated_at)
             VALUES ('exp-1', ?1, 'staff-1', 'branch-1', 'supplies', 15.0, 1500, 'Napkins', 'pending', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert expense");

        shift_id.to_string()
    }

    #[test]
    fn test_generate_z_report_basic() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id, integration_environment, is_test,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-sandbox-z', 'TEST-Z', '[]', 500.0, 50000, 'completed', 'delivery',
                    'paid', ?1, 'sandbox', 1, 'pending',
                    '2026-02-16T18:00:00Z', '2026-02-16T18:00:00Z'
                 )",
                params![shift_id],
            )
            .expect("insert sandbox order");
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status,
                    staff_shift_id, currency, created_at, updated_at
                 ) VALUES (
                    'pay-sandbox-z', 'ord-sandbox-z', 'cash', 500.0, 50000, 'completed',
                    ?1, 'EUR', '2026-02-16T18:00:00Z', '2026-02-16T18:00:00Z'
                 )",
                params![shift_id],
            )
            .expect("insert sandbox payment");
        }

        let payload = serde_json::json!({ "shiftId": shift_id });
        {
            let conn = db.conn.lock().unwrap();
            assert!(
                crate::business_day::stored_period_start(&conn).is_none(),
                "no day has closed yet — the marker must be absent before the first Z"
            );
        }
        let result = generate_z_report(&db, &payload).expect("generate should succeed");

        assert_eq!(result["success"], true);
        assert_eq!(result["existing"], false);

        // Generating a Z row must NOT close the day: previews generate and
        // discard, and the submission flow can still fail after generation.
        // The retention marker advances only inside
        // `apply_local_day_rollover`'s transaction (pinned below in
        // `test_apply_local_day_rollover_advances_day_close_marker`).
        {
            let conn = db.conn.lock().unwrap();
            assert!(
                crate::business_day::stored_period_start(&conn).is_none(),
                "Z generation alone must never advance the day-close marker"
            );
        }

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
        assert_eq!(report_json["period"]["start"], "2026-02-16T09:00:00Z");
        assert_eq!(report_json["period"]["end"], "2026-02-16T18:00:00Z");
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

        // Wave 5 Session 6: verify parity_sync_queue has entry
        let sq_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'z_reports'",
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
        assert_eq!(
            report["reportJson"]["period"]["start"],
            "2026-02-16T09:00:00Z"
        );
        assert_eq!(
            report["reportJson"]["period"]["end"],
            "2026-02-16T18:00:00Z"
        );
        assert_eq!(report["reportJson"]["periodStart"], "2026-02-16T09:00:00Z");
    }

    #[test]
    fn test_extract_period_bounds_prefers_nested_period() {
        let report_json = serde_json::json!({
            "period": {
                "start": "2026-02-16T08:00:00Z",
                "end": "2026-02-16T18:00:00Z",
            },
            "periodStart": "2026-02-16T09:00:00Z",
            "periodEnd": "2026-02-16T19:00:00Z",
        });

        let (start, end) = extract_period_bounds_from_report_json(&report_json);
        assert_eq!(start.as_deref(), Some("2026-02-16T08:00:00Z"));
        assert_eq!(end.as_deref(), Some("2026-02-16T18:00:00Z"));
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

        // Insert an active (not closed) shift — W4e Step 0: dual-populate (200.0 → 20000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                check_in_time, status,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-active', 'staff-1', 'branch-1', 'term-1', 'cashier',
                200.0, 20000, ?1, 'active', 'pending', ?1, ?1
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

        // W4e Step 0: dual-populate every monetary column (300/350/350/0 → 30000/35000/35000/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-2', 'Jane', 'branch-1', 'term-1', 'cashier',
                300.0, 30000, 350.0, 35000, 350.0, 35000, 0.0, 0,
                '2026-02-16T14:00:00Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert shift 2");

        // 2 more orders for shift 2 — dual-populate via Cents::round_half_even.
        for (i, total) in [(4, 50.0), (5, 70.0)] {
            let total_cents = Cents::round_half_even(total).as_i64();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id,
                    discount_amount, discount_amount_cents,
                    tip_amount, tip_amount_cents,
                    sync_status, created_at, updated_at
                 ) VALUES (?1, ?2, '[]', ?3, ?4, 'completed', 'dine-in',
                    'paid', ?5, 0.0, 0, 0.0, 0, 'pending', ?6, ?6)",
                params![
                    format!("ord-{i}"),
                    format!("#{i}"),
                    total,
                    total_cents,
                    shift_id,
                    now
                ],
            )
            .expect("insert order");
        }

        // Payments for shift 2: cash + card. Dual-populate (50/70 → 5000/7000).
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-4', 'ord-4', 'cash', 50.0, 5000, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 4");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-5', 'ord-5', 'card', 70.0, 7000, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 5");
    }

    fn seed_window_cashier_shift(
        db: &DbState,
        shift_id: &str,
        staff_name: &str,
        check_in_time: &str,
        check_out_time: Option<&str>,
    ) {
        let conn = db.conn.lock().unwrap();
        let status = if check_out_time.is_some() {
            "closed"
        } else {
            "active"
        };
        let closing_amount = check_out_time.map(|_| 10.0_f64);
        let closing_amount_cents = check_out_time.map(|_| 1000_i64);
        let updated_at = check_out_time.unwrap_or(check_in_time);

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, ?1, ?2, 'branch-1', 'term-1', 'cashier',
                10.0, 1000, ?3, ?4, 10.0, 1000, 0.0, 0,
                ?5, ?6, ?7, 2, 'pending', ?5, ?8
             )",
            params![
                shift_id,
                staff_name,
                closing_amount,
                closing_amount_cents,
                check_in_time,
                check_out_time,
                status,
                updated_at,
            ],
        )
        .expect("insert window cashier shift");

        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                closing_amount, closing_amount_cents,
                expected_amount, expected_amount_cents,
                variance_amount, variance_amount_cents,
                reconciled, opened_at, closed_at, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?2, 'branch-1', 'term-1',
                10.0, 1000, ?3, ?4, 10.0, 1000, 0.0, 0,
                ?5, ?6, ?7, ?6, ?8
             )",
            params![
                format!("drawer-{shift_id}"),
                shift_id,
                closing_amount,
                closing_amount_cents,
                i64::from(check_out_time.is_some()),
                check_in_time,
                check_out_time,
                updated_at,
            ],
        )
        .expect("insert window cashier drawer");
    }

    fn seed_late_day_order(db: &DbState, created_at: &str) {
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (80.0 → 8000).
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id,
                discount_amount, discount_amount_cents,
                tip_amount, tip_amount_cents,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-late', '#late', '[]', 80.0, 8000, 'completed', 'dine-in',
                'paid', 'shift-zr-1', 0.0, 0, 0.0, 0, 'pending', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert late order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
             ) VALUES (
                'pay-late', 'ord-late', 'cash', 80.0, 8000, 'completed', 'shift-zr-1', 'EUR', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert late payment");
    }

    fn seed_next_day_active_shift(db: &DbState, check_in_time: &str) {
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (100.0 → 10000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                check_in_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-next-day-active', 'staff-next', 'Next Day', 'branch-1', 'term-1', 'cashier',
                100.0, 10000, ?1, 'active', 2, 'pending', ?1, ?1
             )",
            params![check_in_time],
        )
        .expect("insert next day active shift");
    }

    fn seed_other_branch_unpaid_order(db: &DbState, created_at: &str) {
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (22.0 → 2200).
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id, branch_id,
                discount_amount, discount_amount_cents,
                tip_amount, tip_amount_cents,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-other-branch-unpaid', '#other-branch', '[]', 22.0, 2200, 'completed', 'dine-in',
                'pending', 'shift-other-branch', 'branch-2', 0.0, 0, 0.0, 0, 'pending', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert other branch unpaid order");
    }

    fn seed_paid_order_with_stale_payment_status(db: &DbState, created_at: &str) {
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (22.0 → 2200).
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id, branch_id,
                discount_amount, discount_amount_cents,
                tip_amount, tip_amount_cents,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-stale-paid-status', '#stale-paid', '[]', 22.0, 2200, 'completed', 'pickup',
                'pending', 'shift-zr-1', 'branch-1', 0.0, 0, 0.0, 0, 'pending', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert stale payment-status order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
             ) VALUES (
                'pay-stale-paid-status', 'ord-stale-paid-status', 'cash', 22.0, 2200, 'completed',
                'shift-zr-1', 'EUR', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert settled payment for stale payment-status order");
    }

    fn seed_paid_order_missing_local_payment_rows(db: &DbState, created_at: &str) {
        let conn = db.conn.lock().unwrap();
        // W4e Step 0: dual-populate (18.0 → 1800).
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id, branch_id,
                discount_amount, discount_amount_cents,
                tip_amount, tip_amount_cents,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-missing-local-payment', '#missing-local', '[]', 18.0, 1800, 'completed', 'pickup',
                'paid', 'shift-zr-1', 'branch-1', 0.0, 0, 0.0, 0, 'synced', ?1, ?1
             )",
            params![created_at],
        )
        .expect("insert paid order missing local payment rows");
    }

    /// 1.4.119 placeholder rows (guessed from a pulled order's own label and
    /// total, no server id) are no drawer money: the Z's sales by tender,
    /// for the period and for the shift, count only real rows. Before, the
    /// 7.00 guess counted as cash the drawer never held.
    #[test]
    fn z_sales_never_count_a_placeholder_payment_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        for (order_id, cents) in [("ord-real-cash", 1000_i64), ("ord-guessed-cash", 700)] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status,
                    order_type, payment_status, staff_shift_id, branch_id, sync_status,
                    created_at, updated_at
                 ) VALUES (?1, ?1, '[]', ?2, ?3, 'completed', 'pickup', 'paid',
                           'shift-placeholder', 'branch-1', 'synced',
                           '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
                params![order_id, cents as f64 / 100.0, cents],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, payment_origin,
                staff_shift_id, sync_status, sync_state, created_at, updated_at
             ) VALUES
                ('pay-real', 'ord-real-cash', 'cash', 10.0, 1000, 'completed', 'manual',
                 'shift-placeholder', 'synced', 'applied',
                 '2026-09-30T10:01:00Z', '2026-09-30T10:01:00Z'),
                ('pay-guess', 'ord-guessed-cash', 'cash', 7.0, 700, 'completed',
                 'sync_reconstructed', 'shift-placeholder', 'synced', 'applied',
                 '2026-09-30T10:01:00Z', '2026-09-30T10:01:00Z')",
            [],
        )
        .unwrap();

        let period = load_sales_by_type_for_period(
            &conn,
            "branch-1",
            "2026-09-30T00:00:00Z",
            None,
            LowerBoundMode::Inclusive,
        )
        .unwrap();
        assert_eq!(
            period["instore"]["cash"]["total"],
            serde_json::json!(10.0),
            "{period}"
        );
        assert_eq!(
            period["instore"]["cash"]["count"],
            serde_json::json!(1),
            "{period}"
        );
        let shift = load_sales_by_type_for_shift(&conn, "shift-placeholder").unwrap();
        assert_eq!(
            shift["instore"]["cash"]["total"],
            serde_json::json!(10.0),
            "{shift}"
        );

        // The server's real payment adopts the placeholder (it gets the
        // server's id): from then on it is money like any other row.
        conn.execute(
            "UPDATE order_payments SET remote_payment_id = 'remote-pay-guess' WHERE id = 'pay-guess'",
            [],
        )
        .unwrap();
        let adopted = load_sales_by_type_for_shift(&conn, "shift-placeholder").unwrap();
        assert_eq!(
            adopted["instore"]["cash"]["total"],
            serde_json::json!(17.0),
            "{adopted}"
        );
    }

    fn seed_cashier_driver_zreport_day(db: &DbState) {
        let conn = db.conn.lock().unwrap();
        let cashier_shift_id = "cashier-zr-day";
        let driver_shift_id = "driver-zr-day";
        let now = "2026-03-06T19:05:40Z";

        // The cashier shift mirrors the physical drawer. Driver float remains
        // in the driver wallet and must not be added to these closing totals.
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'cashier-11', 'Alexandra Evaggelou', 'branch-1', 'term-1', 'cashier',
                100.0, 10000, 144.5, 14450, 144.5, 14450, 0.0, 0,
                '2026-03-06T12:10:16Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![cashier_shift_id, now],
        )
        .unwrap();
        // W4e Step 0: dual-populate (every monetary column).
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                closing_amount, closing_amount_cents,
                expected_amount, expected_amount_cents,
                variance_amount, variance_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                total_refunds, total_refunds_cents,
                total_expenses, total_expenses_cents,
                cash_drops, cash_drops_cents,
                driver_cash_given, driver_cash_given_cents,
                driver_cash_returned, driver_cash_returned_cents,
                total_staff_payments, total_staff_payments_cents,
                reconciled, opened_at, created_at, updated_at
             ) VALUES (
                'drawer-zr-day', ?1, 'cashier-11', 'branch-1', 'term-1',
                100.0, 10000, 144.5, 14450, 144.5, 14450, 0.0, 0,
                12.0, 1200, 18.0, 1800, 0.0, 0, 0.0, 0,
                0.0, 0, 20.0, 2000, 52.5, 5250, 0.0, 0,
                1, '2026-03-06T12:10:16Z', ?2, ?2
             )",
            params![cashier_shift_id, now],
        )
        .unwrap();

        // W4e Step 0: dual-populate (20/52.5/52.5/0 → 2000/5250/5250/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'driver-11', 'Endrit Bashi', 'branch-1', 'term-1', 'driver',
                20.0, 2000, 52.5, 5250, 52.5, 5250, 0.0, 0,
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
            // W4e Step 0: dual-populate via Cents::round_half_even.
            let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id, staff_id,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    ?1, ?1, '[]', ?2, ?3, 'completed', 'dine-in',
                    'paid', ?4, 'cashier-11',
                    'pending', '2026-03-06T15:00:00Z', '2026-03-06T15:00:00Z'
                 )",
                params![order_id, total_amount, total_amount_cents, cashier_shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, 'EUR', '2026-03-06T15:00:00Z', '2026-03-06T15:00:00Z')",
                params![format!("pay-{order_id}"), order_id, method, total_amount, total_amount_cents, cashier_shift_id],
            )
            .unwrap();
        }

        for (suffix, total_amount, cash_collected, order_tip) in
            [("1", 13.0, 13.0, 1.5), ("2", 19.5, 19.5, 0.0)]
        {
            let order_id = format!("delivery-order-{suffix}");
            // W4e Step 0: dual-populate via Cents::round_half_even.
            let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
            let cash_collected_cents = Cents::round_half_even(cash_collected).as_i64();
            let order_tip_cents = Cents::round_half_even(order_tip).as_i64();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id, staff_id, driver_id,
                    tip_amount, tip_amount_cents,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    ?1, ?1, '[]', ?2, ?3, 'completed', 'delivery',
                    'paid', ?4, 'cashier-11', 'driver-11',
                    ?5, ?6,
                    'pending', '2026-03-06T16:00:00Z', '2026-03-06T16:00:00Z'
                 )",
                params![
                    order_id,
                    total_amount,
                    total_amount_cents,
                    cashier_shift_id,
                    order_tip,
                    order_tip_cents
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
                 ) VALUES (?1, ?2, 'cash', ?3, ?4, 'completed', ?5, 'EUR', '2026-03-06T16:00:00Z', '2026-03-06T16:00:00Z')",
                params![format!("pay-{order_id}"), order_id, total_amount, total_amount_cents, cashier_shift_id],
            )
            .unwrap();
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
                    settled, created_at, updated_at
                 ) VALUES (
                    ?1, 'driver-11', ?2, ?3, 'branch-1',
                    2.5, 250, 0.0, 0, 2.5, 250, 'cash',
                    ?4, ?5, 0.0, 0, ?4, ?5,
                    0, '2026-03-06T16:00:00Z', '2026-03-06T16:00:00Z'
                 )",
                params![
                    format!("de-{suffix}"),
                    driver_shift_id,
                    order_id,
                    cash_collected,
                    cash_collected_cents
                ],
            )
            .unwrap();
        }
    }

    #[test]
    fn test_date_z_report_breaks_platform_orders_down_by_fleet() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            // efood, platform fleet: one count+amount line, no drawer money.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, status, order_type, payment_status, staff_shift_id, plugin, ghost_metadata, sync_status, created_at, updated_at)
                 VALUES ('ord-efood-fleet', 'EF-1', '[]', 12.10, 1210, 'delivered', 'delivery', 'paid', ?1, 'efood', '{\"food_delivery\":{\"delivery_provider\":\"platform_delivery\",\"payment_method\":\"online\",\"prepaid\":true}}', 'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
            // efood, own driver: cash 8 + card 5 across two orders — this
            // money reconciles with the drawer/terminal, so the Z splits it.
            for (id, num, total, cents, method) in [
                ("ord-efood-vc", "EF-2", 8.0_f64, 800_i64, "cash"),
                ("ord-efood-vk", "EF-3", 5.0, 500, "card"),
            ] {
                conn.execute(
                    "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, status, order_type, payment_status, staff_shift_id, plugin, ghost_metadata, sync_status, created_at, updated_at)
                     VALUES (?1, ?2, '[]', ?3, ?4, 'delivered', 'delivery', 'paid', ?5, 'efood', '{\"food_delivery\":{\"delivery_provider\":\"vendor_delivery\",\"payment_method\":\"cash\"}}', 'pending', '2026-02-16T13:00:00Z', '2026-02-16T13:00:00Z')",
                    params![id, num, total, cents, shift_id],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, sync_status, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'completed', 'pending', '2026-02-16T13:05:00Z', '2026-02-16T13:05:00Z')",
                    params![format!("pay-{id}"), id, method, total, cents],
                )
                .unwrap();
            }
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate with platforms");
        let platforms = result["report"]["reportJson"]["sales"]["platforms"]
            .as_array()
            .expect("platforms array");
        assert_eq!(platforms.len(), 1, "one platform expected: {platforms:?}");
        let efood = &platforms[0];
        assert_eq!(efood["platform"], "efood");
        assert_eq!(efood["fleetOrders"], 1);
        assert_eq!(efood["fleetAmount"], 12.10);
        assert_eq!(efood["vendorOrders"], 2);
        assert_eq!(efood["vendorCash"], 8.0);
        assert_eq!(efood["vendorCard"], 5.0);
    }

    #[test]
    fn test_date_z_report_lists_every_order_of_the_day_including_platform_orders() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            // efood, platform fleet, prepaid online: no staff shift anywhere
            // (ingested without a cashier assignment, settled with a
            // NULL-shift `other` payment) — invisible to every staff list.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, status, order_type, payment_status, plugin, ghost_metadata, delivery_address, sync_status, created_at, updated_at)
                 VALUES ('ord-efood-online', 'EF-ONLINE', '[]', 12.10, 1210, 'delivered', 'delivery', 'paid', 'efood', '{\"food_delivery\":{\"delivery_provider\":\"platform_delivery\",\"payment_method\":\"online\",\"prepaid\":true}}', 'Εγνατία 1', 'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, transaction_ref, sync_status, created_at, updated_at)
                 VALUES ('pay-efood-online', 'ord-efood-online', 'other', 12.10, 1210, 'completed', 'platform_settlement:online:ord-efood-online', 'pending', '2026-02-16T12:00:30Z', '2026-02-16T12:00:30Z')",
                [],
            )
            .unwrap();
            // efood COD carried by the platform's own rider.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents, status, order_type, payment_status, plugin, ghost_metadata, delivery_address, sync_status, created_at, updated_at)
                 VALUES ('ord-efood-cod', 'EF-COD', '[]', 9.50, 950, 'delivered', 'delivery', 'paid', 'efood', '{\"food_delivery\":{\"delivery_provider\":\"platform_delivery\",\"payment_method\":\"cash\",\"prepaid\":false}}', 'Τσιμισκή 2', 'pending', '2026-02-16T12:30:00Z', '2026-02-16T12:30:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, transaction_ref, sync_status, created_at, updated_at)
                 VALUES ('pay-efood-cod', 'ord-efood-cod', 'other', 9.50, 950, 'completed', 'platform_settlement:cod:ord-efood-cod', 'pending', '2026-02-16T12:30:30Z', '2026-02-16T12:30:30Z')",
                [],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate with day orders");
        let report = &result["report"]["reportJson"];
        let day_orders = report["dayOrders"].as_array().expect("dayOrders array");
        assert_eq!(report["dayOrdersTruncated"], false);

        // The list is exactly what the headline counts.
        let total_orders = report["daySummary"]["totalOrders"]
            .as_i64()
            .expect("daySummary.totalOrders");
        let repair_orders = report["sales"]["repairOrders"].as_i64().unwrap_or(0);
        assert_eq!(
            day_orders.len() as i64 + repair_orders,
            total_orders,
            "day list must match the day count: {day_orders:?}"
        );

        // Chronological.
        let created: Vec<&str> = day_orders
            .iter()
            .map(|order| order["createdAt"].as_str().expect("createdAt"))
            .collect();
        let mut sorted = created.clone();
        sorted.sort_unstable();
        assert_eq!(created, sorted, "dayOrders must be in created_at order");

        // Platform orders are listed with the paymentsBreakdown tender names.
        let online = day_orders
            .iter()
            .find(|order| order["id"] == "ord-efood-online")
            .expect("platform online order listed");
        assert_eq!(online["paymentMethod"], "platform_online");
        assert_eq!(online["platform"], "efood");
        assert_eq!(online["platformFleet"], true);
        assert_eq!(online["amount"], 12.10);
        assert_eq!(online["orderType"], "delivery");
        assert_eq!(online["deliveryAddress"], "Εγνατία 1");
        assert!(online["staffShiftId"].is_null());
        assert!(online["staffName"].is_null());
        let cod = day_orders
            .iter()
            .find(|order| order["id"] == "ord-efood-cod")
            .expect("platform COD order listed");
        assert_eq!(cod["paymentMethod"], "platform_cod");

        // Store orders keep their staff attribution.
        let store = day_orders
            .iter()
            .find(|order| order["staffShiftId"] == shift_id.as_str())
            .expect("a cashier order is listed too");
        assert_eq!(store["staffName"], "John");
        assert!(store["platform"].is_null());
        assert_eq!(store["platformFleet"], false);

        // …and the platform orders still sit in no staff list (that is the gap
        // the day list closes).
        for staff in report["staffReports"].as_array().expect("staffReports") {
            for detail in staff["ordersDetails"].as_array().expect("ordersDetails") {
                assert_ne!(detail["id"], "ord-efood-online");
                assert_ne!(detail["id"], "ord-efood-cod");
            }
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
    fn cash_drawer_formula_z_report_period_staff_payments_are_branch_scoped() {
        let db = test_db();
        seed_closed_shift(&db);

        {
            let conn = db.conn.lock().unwrap();
            ensure_staff_payments_table(&conn);
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, branch_id, terminal_id, role_type,
                    opening_cash_amount, opening_cash_amount_cents,
                    closing_cash_amount, closing_cash_amount_cents,
                    expected_cash_amount, expected_cash_amount_cents,
                    cash_variance, cash_variance_cents,
                    check_in_time, check_out_time, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'branch-2-cashier', 'staff-branch-2', 'Other Branch', 'branch-2', 'term-2', 'cashier',
                    100.0, 10000, 100.0, 10000, 100.0, 10000, 0.0, 0,
                    '2026-02-16T09:00:00Z', '2026-02-16T18:00:00Z', 'closed', 2,
                    'pending', '2026-02-16T09:00:00Z', '2026-02-16T18:00:00Z'
                 )",
                [],
            )
            .expect("insert branch 2 shift");
            conn.execute(
                "INSERT INTO staff_payments (
                    id, cashier_shift_id, paid_to_staff_id, amount, payment_type, created_at, updated_at
                 ) VALUES
                    ('branch-1-staff-payment', 'shift-zr-1', 'staff-paid-1', 12.0, 'wage', '2026-02-16T10:00:00Z', '2026-02-16T10:00:00Z'),
                    ('branch-2-staff-payment', 'branch-2-cashier', 'staff-paid-2', 40.0, 'wage', '2026-02-16T10:00:00Z', '2026-02-16T10:00:00Z')",
                [],
            )
            .expect("insert branch-scoped staff payments");
        }

        let result = generate_z_report_for_date(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
                "date": "2026-02-16",
            }),
        )
        .expect("generate branch 1 z-report");

        let report_json = result["report"]["reportJson"]
            .as_object()
            .expect("reportJson object");
        assert_eq!(report_json["expenses"]["staffPaymentsTotal"], 12.0);
        assert_eq!(report_json["staffPayments"]["total"], 12.0);
    }

    #[test]
    fn cash_drawer_formula_z_report_drawer_rows_are_branch_scoped() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, branch_id, terminal_id, role_type,
                    opening_cash_amount, opening_cash_amount_cents,
                    closing_cash_amount, closing_cash_amount_cents,
                    expected_cash_amount, expected_cash_amount_cents,
                    cash_variance, cash_variance_cents,
                    check_in_time, check_out_time, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES
                    ('shift-branch-1', 'cashier-1', 'Cashier One', 'branch-1', 'term-1', 'cashier',
                     10.0, 1000, 10.0, 1000, 10.0, 1000, 0.0, 0,
                     '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z', 'closed', 2,
                     'pending', '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z'),
                    ('shift-branch-2', 'cashier-2', 'Cashier Two', 'branch-2', 'term-2', 'cashier',
                     20.0, 2000, 20.0, 2000, 20.0, 2000, 0.0, 0,
                     '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z', 'closed', 2,
                     'pending', '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z')",
                [],
            )
            .expect("insert drawer staff shifts");
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents,
                    expected_amount, expected_amount_cents,
                    closing_amount, closing_amount_cents,
                    variance_amount, variance_amount_cents,
                    opened_at, closed_at, reconciled, created_at, updated_at
                 ) VALUES
                    ('drawer-branch-1', 'shift-branch-1', 'cashier-1', 'branch-1', 'term-1',
                     10.0, 1000, 10.0, 1000, 10.0, 1000, 0.0, 0,
                     '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z', 1, '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z'),
                    ('drawer-branch-2', 'shift-branch-2', 'cashier-2', 'branch-2', 'term-2',
                     20.0, 2000, 20.0, 2000, 20.0, 2000, 0.0, 0,
                     '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z', 1, '2026-02-16T09:00:00Z', '2026-02-16T10:00:00Z')",
                [],
            )
            .expect("insert branch drawer rows");

            let rows = load_drawer_rows_for_period(
                &conn,
                "2026-02-16T00:00:00Z",
                None,
                LowerBoundMode::Inclusive,
                "branch-1",
            )
            .expect("load drawer rows for branch");

            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["id"], "drawer-branch-1");
        }
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
    fn test_preview_z_report_for_date_includes_active_shift_orders_and_open_drawer() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, branch_id, terminal_id, role_type,
                    opening_cash_amount, opening_cash_amount_cents,
                    check_in_time, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'active-zr-shift', 'staff-active', 'Active Cashier', 'branch-1', 'term-1',
                    'cashier', 100.0, 10000, '2026-05-21T07:00:00Z', 'active', 2,
                    'pending', '2026-05-21T07:00:00Z', '2026-05-21T07:00:00Z'
                 )",
                [],
            )
            .expect("insert active shift");

            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents,
                    total_cash_sales, total_cash_sales_cents,
                    total_card_sales, total_card_sales_cents,
                    total_refunds, total_refunds_cents,
                    total_expenses, total_expenses_cents,
                    cash_drops, cash_drops_cents,
                    driver_cash_given, driver_cash_given_cents,
                    driver_cash_returned, driver_cash_returned_cents,
                    total_staff_payments, total_staff_payments_cents,
                    reconciled, opened_at, created_at, updated_at
                 ) VALUES (
                    'active-zr-drawer', 'active-zr-shift', 'staff-active', 'branch-1', 'term-1',
                    100.0, 10000, 13.0, 1300, 0.0, 0, 0.0, 0, 0.0, 0,
                    0.0, 0, 0.0, 0, 0.0, 0, 0.0, 0, 0,
                    '2026-05-21T07:00:00Z', '2026-05-21T07:00:00Z', '2026-05-21T07:00:00Z'
                 )",
                [],
            )
            .expect("insert active drawer");

            conn.execute(
                "INSERT INTO orders (
                    id, order_number, branch_id, items,
                    total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id, table_number,
                    discount_amount, discount_amount_cents,
                    tip_amount, tip_amount_cents,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'active-zr-order', 'ORD-ACTIVE-1', 'branch-1', '[]',
                    22.0, 2200, 'completed', 'dine-in',
                    'partially_paid', 'active-zr-shift', 'T1',
                    0.0, 0, 0.0, 0,
                    'pending', '2026-05-21T08:00:00Z', '2026-05-21T08:00:00Z'
                 )",
                [],
            )
            .expect("insert active order");

            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status,
                    staff_shift_id, currency, created_at, updated_at
                 ) VALUES (
                    'active-zr-payment', 'active-zr-order', 'cash', 13.0, 1300, 'completed',
                    'active-zr-shift', 'EUR', '2026-05-21T08:05:00Z', '2026-05-21T08:05:00Z'
                 )",
                [],
            )
            .expect("insert active payment");
        }

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-05-21",
        });
        let result = preview_z_report_for_date(&db, &payload)
            .expect("live preview should include active shift data");

        assert_eq!(result["success"], true);
        assert_eq!(result["preview"], true);
        let report_json = result["report"]["reportJson"]
            .as_object()
            .expect("preview reportJson object");
        assert_eq!(report_json["shifts"]["total"], 1);
        assert_eq!(report_json["sales"]["totalOrders"], 1);
        assert_eq!(report_json["sales"]["totalSales"], 22.0);
        assert_eq!(report_json["sales"]["cashSales"], 13.0);
        assert_eq!(report_json["cashDrawer"]["expected"], 113.0);
        assert_eq!(report_json["cashDrawer"]["moneyInDrawer"], 113.0);

        let drawers = report_json["drawers"].as_array().expect("drawer rows");
        assert_eq!(drawers.len(), 1);
        assert_eq!(drawers[0]["expected"], 113.0);
        assert_eq!(drawers[0]["cashSales"], 13.0);

        let staff_reports = report_json["staffReports"]
            .as_array()
            .expect("staffReports");
        assert_eq!(staff_reports.len(), 1);
        assert_eq!(staff_reports[0]["shiftStatus"], "active");
        assert_eq!(staff_reports[0]["orders"]["count"], 1);
        assert_eq!(staff_reports[0]["orders"]["cashAmount"], 13.0);
        assert_eq!(staff_reports[0]["orders"]["totalAmount"], 22.0);
        assert_eq!(staff_reports[0]["drawer"]["expected"], 113.0);
        assert_eq!(
            staff_reports[0]["ordersDetails"][0]["orderNumber"],
            "ORD-ACTIVE-1"
        );

        let generate_result = generate_z_report_for_date(&db, &payload)
            .expect("final generation should not persist active-only preview");
        assert_eq!(generate_result["preview"], true);
        assert_eq!(
            generate_result["report"]["reportJson"]["shifts"]["total"],
            0
        );

        let conn = db.conn.lock().unwrap();
        let z_reports_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            z_reports_count, 0,
            "active live preview must not materialize a final z_report"
        );
    }

    #[test]
    fn test_preview_z_report_for_date_reuses_existing_local_report_for_historical_day() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });

        let generated =
            generate_z_report_for_date(&db, &payload).expect("historical generate should persist");
        let existing_id = generated["report"]["id"]
            .as_str()
            .expect("generated z-report id")
            .to_string();

        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-17T08:00:00Z",
            )
            .expect("advance active period");
        }

        let result = preview_z_report_for_date(&db, &payload)
            .expect("historical preview should reuse local z-report");

        assert_eq!(result["success"], true);
        assert_eq!(result["preview"], false);
        assert_eq!(result["existing"], true);
        assert_eq!(result["report"]["id"], existing_id);
        assert_eq!(result["report"]["reportDate"], "2026-02-16");

        let report_json_str = result["report"]["reportJson"]
            .as_str()
            .expect("stored reportJson string");
        let report_json: Value =
            serde_json::from_str(report_json_str).expect("parse stored reportJson");
        assert_eq!(report_json["shifts"]["total"], 2);
    }

    #[test]
    fn test_preview_same_business_date_uses_live_window_after_prior_z_report() {
        let db = test_db();
        seed_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let prior = generate_z_report_for_date(&db, &payload).expect("generate prior report");
        let prior_id = prior["report"]["id"]
            .as_str()
            .expect("prior report id")
            .to_string();

        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-16T19:00:00Z",
            )
            .expect("advance to second same-date window");
        }
        seed_window_cashier_shift(
            &db,
            "shift-zr-live-2",
            "Evening Cashier",
            "2026-02-16T20:00:00Z",
            None,
        );

        let result = preview_z_report_for_date(&db, &payload)
            .expect("same-date preview should use current live window");

        assert_eq!(result["success"], true);
        assert_eq!(result["preview"], true);
        assert_eq!(result["existing"], false);
        assert_ne!(result["report"]["id"], prior_id);
        assert_eq!(result["report"]["reportJson"]["shifts"]["total"], 1);
        assert_eq!(
            result["report"]["reportJson"]["staffReports"][0]["staffShiftId"],
            "shift-zr-live-2"
        );
        assert_eq!(
            result["report"]["reportJson"]["staffReports"][0]["shiftStatus"],
            "active"
        );
        assert_eq!(
            result["report"]["reportJson"]["cashDrawer"]["totalVariance"],
            0.0
        );
    }

    #[test]
    fn test_submit_same_business_date_creates_new_window_report() {
        let db = test_db();
        seed_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let prior = generate_z_report_for_date(&db, &payload).expect("generate prior report");
        let prior_id = prior["report"]["id"]
            .as_str()
            .expect("prior report id")
            .to_string();

        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-16T19:00:00Z",
            )
            .expect("advance to second same-date window");
        }
        seed_window_cashier_shift(
            &db,
            "shift-zr-closed-2",
            "Evening Cashier",
            "2026-02-16T20:00:00Z",
            Some("2026-02-16T22:00:00Z"),
        );

        let result = submit_z_report(&db, &payload)
            .expect("second same-date closeout should create its own report");
        let new_id = result["zReportId"]
            .as_str()
            .expect("new same-date report id");

        assert_ne!(new_id, prior_id);
        assert_eq!(result["data"]["existing"], false);
        assert_eq!(
            result["data"]["report"]["reportJson"]["periodStart"],
            "2026-02-16T19:00:00Z"
        );

        let conn = db.conn.lock().unwrap();
        let same_date_reports: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM z_reports WHERE report_date = '2026-02-16'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(same_date_reports, 2);
    }

    #[test]
    fn test_prepare_submission_ignores_historical_picker_date_for_live_window() {
        let db = test_db();
        seed_closed_shift(&db);

        let historical_payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let prior = generate_z_report_for_date(&db, &historical_payload)
            .expect("generate historical report");
        let prior_id = prior["report"]["id"]
            .as_str()
            .expect("historical report id")
            .to_string();

        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-17T08:00:00Z",
            )
            .expect("advance live business window");
        }
        seed_window_cashier_shift(
            &db,
            "shift-zr-next-day",
            "Next Day Cashier",
            "2026-02-17T09:00:00Z",
            Some("2026-02-17T10:00:00Z"),
        );

        let prepared = prepare_z_report_submission(&db, &historical_payload)
            .expect("submission should target the live business window");
        let prepared_id = prepared.z_report_id.as_deref().expect("live report id");

        assert_ne!(prepared_id, prior_id);
        assert_eq!(prepared.report_date, "2026-02-17");
        assert_eq!(prepared.generated["report"]["reportDate"], "2026-02-17");
        assert_eq!(
            prepared.generated["report"]["reportJson"]["periodStart"],
            "2026-02-17T08:00:00Z"
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
        // Wave 5 Session 6: z-report mutations now enqueue on parity.
        let queue_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'z_reports'",
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
        assert_eq!(driver["driver"]["earnings"], 6.5);
        assert_eq!(driver["driver"]["tips"], 1.5);
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
        assert_eq!(report_json["driverEarnings"]["totalEarnings"], 6.5);
        assert_eq!(report_json["driverEarnings"]["totalTips"], 1.5);
        assert_eq!(report_json["tips"]["total"], 1.5);
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
        assert_eq!(
            result["report"]["openingCash"], 100.0,
            "driver starting cash is a driver wallet, not physical till opening"
        );
        assert_eq!(
            result["report"]["expectedCash"], 144.5,
            "persisted expected cash must match the physical drawer"
        );
        assert_eq!(
            result["report"]["closingCash"], 144.5,
            "driver checkout cash must not be added to the counted till"
        );
        assert_eq!(result["report"]["cashVariance"], 0.0);
    }

    #[test]
    fn money_in_drawer_uses_each_terminal_latest_count_instead_of_summing_handoffs() {
        let drawer_rows = vec![
            serde_json::json!({
                "terminalId": "terminal-1",
                "closing": 200.0,
                "expected": 198.0,
                "variance": 2.0
            }),
            serde_json::json!({
                "terminalId": "terminal-1",
                "closing": 250.0,
                "expected": 249.0,
                "variance": 1.0
            }),
            serde_json::json!({
                "terminalId": "terminal-2",
                "closing": 80.0,
                "expected": 80.0,
                "variance": 0.0
            }),
        ];

        assert_eq!(money_in_drawer_from_rows(&drawer_rows), 330.0);
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

        // W4e Step 0: dual-populate (100/170/170/0 → 10000/17000/17000/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'cashier-zr', 'cashier-1', 'Cashier One', 'branch-1', 'term-1', 'cashier',
                100.0, 10000, 170.0, 17000, 170.0, 17000, 0.0, 0,
                '2026-03-05T09:00:00Z', '2026-03-05T17:00:00Z', 'closed', 2,
                'pending', '2026-03-05T17:00:00Z', '2026-03-05T17:00:00Z'
             )",
            [],
        )
        .unwrap();
        // W4e Step 0: dual-populate every monetary column.
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                closing_amount, closing_amount_cents,
                expected_amount, expected_amount_cents,
                variance_amount, variance_amount_cents,
                total_cash_sales, total_cash_sales_cents,
                total_card_sales, total_card_sales_cents,
                total_refunds, total_refunds_cents,
                total_expenses, total_expenses_cents,
                cash_drops, cash_drops_cents,
                driver_cash_given, driver_cash_given_cents,
                driver_cash_returned, driver_cash_returned_cents,
                total_staff_payments, total_staff_payments_cents,
                reconciled, opened_at, created_at, updated_at
             ) VALUES (
                'drawer-zr', 'cashier-zr', 'cashier-1', 'branch-1', 'term-1',
                100.0, 10000, 170.0, 17000, 170.0, 17000, 0.0, 0,
                0.0, 0, 0.0, 0, 0.0, 0, 0.0, 0,
                0.0, 0, 20.0, 2000, 70.0, 7000, 0.0, 0,
                1, '2026-03-05T09:00:00Z', '2026-03-05T17:00:00Z', '2026-03-05T17:00:00Z'
             )",
            [],
        )
        .unwrap();

        // W4e Step 0: dual-populate (20/70/70/0 → 2000/7000/7000/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'driver-zr', 'driver-1', 'Driver One', 'branch-1', 'term-1', 'driver',
                20.0, 2000, 70.0, 7000, 70.0, 7000, 0.0, 0,
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
            // W4e Step 0: dual-populate via Cents::round_half_even.
            let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id, sync_status, created_at, updated_at
                 ) VALUES (?1, ?1, '[]', ?2, ?3, 'completed', ?4,
                    'paid', 'driver-zr', 'pending', '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z')",
                params![order_id, total_amount, total_amount_cents, order_type],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
                 ) VALUES (?1, ?2, 'cash', ?3, ?4, 'completed', 'driver-zr', 'EUR', '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z')",
                params![format!("pay-{order_id}"), order_id, total_amount, total_amount_cents],
            )
            .unwrap();

            if order_type == "delivery" {
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
                        settled, created_at, updated_at
                     ) VALUES (
                        ?1, 'driver-1', 'driver-zr', ?2, 'branch-1',
                        0.0, 0, 0.0, 0, ?3, ?4, 'cash',
                        ?3, ?4, 0.0, 0, ?3, ?4,
                        0, '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z'
                     )",
                    params![
                        format!("earning-{order_id}"),
                        order_id,
                        total_amount,
                        total_amount_cents
                    ],
                )
                .unwrap();
            }
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

        // W4e Step 0: dual-populate (20/65/65/0 → 2000/6500/6500/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'driver-zr-single', 'driver-9', 'Driver Nine', 'branch-9', 'term-9', 'driver',
                20.0, 2000, 65.0, 6500, 65.0, 6500, 0.0, 0,
                '2026-03-05T10:00:00Z', '2026-03-05T16:00:00Z', 'closed', 2,
                'pending', '2026-03-05T16:00:00Z', '2026-03-05T16:00:00Z'
             )",
            [],
        )
        .unwrap();
        // W4e Step 0: dual-populate (45.0 → 4500).
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id, staff_id, driver_id,
                sync_status, created_at, updated_at
             ) VALUES (
                'delivery-zr-single', 'ORD-DRIVER-1', '[]', 45.0, 4500, 'completed', 'delivery',
                'paid', 'driver-zr-single', 'driver-9', 'driver-9',
                'pending', '2026-03-05T12:00:00Z', '2026-03-05T12:00:00Z'
             )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
             ) VALUES (
                'pay-driver-zr-single', 'delivery-zr-single', 'cash', 45.0, 4500, 'completed',
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
    fn test_apply_local_day_rollover_advances_day_close_marker() {
        // The founder's law: the day closes at the Z — and "at the Z" means
        // this transaction, the atomic rollover. Retention (orders view +
        // prune via `business_day::retention_cutoff_utc`) anchors to the
        // marker this writes.
        let db = test_db();
        seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            assert!(crate::business_day::stored_period_start(&conn).is_none());
        }

        apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("rollover should succeed");

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            crate::business_day::stored_period_start(&conn).as_deref(),
            Some("2026-02-16T23:59:59Z"),
            "the rollover transaction is the one and only day-close marker writer"
        );
    }

    #[test]
    fn test_preview_generate_and_discard_leaves_day_close_marker_untouched() {
        // `report_generate_z_report` previews a single shift by generating a
        // real Z row and discarding it. That round trip must leave retention
        // completely untouched — a preview that advanced the marker would
        // hide (and later prune) orders no Z has settled.
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        let result = generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id }))
            .expect("generate should succeed");
        let z_report_id = result["report"]["id"].as_str().unwrap().to_string();
        discard_generated_z_report_by_id(&db, &z_report_id).expect("discard should succeed");

        let conn = db.conn.lock().unwrap();
        assert!(
            crate::business_day::stored_period_start(&conn).is_none(),
            "a generate-and-discard preview must never advance the day-close marker"
        );
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM z_reports WHERE id = ?1",
                params![z_report_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0, "the previewed Z row must be gone after discard");
    }

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

    /// An open dine-in tab: unpaid (payment_status 'pending'), linked to a
    /// table, created inside the business day being closed. The closeout gate
    /// (payment_integrity) deliberately exempts this shape so a tavern can
    /// close the day with a tab still running.
    fn seed_open_table_tab_order(db: &DbState, created_at: &str) {
        seed_table_tab_order_with(db, created_at, "active", None);
    }

    /// Variant seeder for the open-tab protection tests: `status` controls
    /// whether the tab is live ('active') or dead ('cancelled'), and
    /// `staff_shift_id` attaches it to a shift for the per-shift aggregates.
    fn seed_table_tab_order_with(
        db: &DbState,
        created_at: &str,
        status: &str,
        staff_shift_id: Option<&str>,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, table_number, staff_shift_id,
                discount_amount, discount_amount_cents,
                tip_amount, tip_amount_cents,
                sync_status, created_at, updated_at
             ) VALUES (
                'ord-open-tab', '#tab', '[]', 55.0, 5500, ?2, 'dine-in',
                'pending', '7', ?3, 0.0, 0, 0.0, 0, 'pending', ?1, ?1
             )",
            params![created_at, status, staff_shift_id],
        )
        .expect("insert table tab order");
    }

    // Gap review 2026-07-10 P0-03: the rollover's order selector filtered only on
    // the financial timestamp — for an unpaid order that falls back to created_at —
    // so an open tab from 19:00 was hard-deleted by the 23:59 rollover and its
    // (uncollected) total was counted as revenue by the Z aggregate.
    #[test]
    fn test_apply_local_day_rollover_preserves_open_unpaid_table_tab() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_open_table_tab_order(&db, "2026-02-16T19:00:00Z");

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("cleanup should succeed");

        assert_eq!(
            result["orders"], 3,
            "only the settled orders are cleared; the open tab is not part of the closed day"
        );

        let conn = db.conn.lock().unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 1, "the open tab must survive the rollover");
        let remaining_id: String = conn
            .query_row("SELECT id FROM orders LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining_id, "ord-open-tab");
    }

    #[test]
    fn test_generate_z_report_for_date_excludes_open_unpaid_table_tab_from_sales() {
        let db = test_db();
        seed_closed_shift(&db);
        // Attach the tab to the closed shift so the per-staff section is
        // exercised too (review round 2: staff rows must agree with gross).
        seed_table_tab_order_with(&db, "2026-02-16T12:00:00Z", "active", Some("shift-zr-1"));

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let report = &result["report"];

        // seed_closed_shift's settled orders: 25 + 35 + 40 = 100. The 55.00 open
        // tab was never collected, so it must appear in neither count nor gross.
        assert_eq!(
            report["totalOrders"], 3,
            "open unpaid tab must not count as an order of the closed day"
        );
        assert_eq!(
            report["grossSales"], 100.0,
            "uncollected tab money must not be reported as revenue"
        );

        // The per-staff section must reconcile with the headline gross.
        let staff_reports = report["reportJson"]["staffReports"]
            .as_array()
            .expect("staffReports array");
        assert_eq!(
            staff_reports[0]["orders"]["totalAmount"], 100.0,
            "staff order totals must exclude the uncollected tab"
        );
        assert_eq!(staff_reports[0]["orders"]["count"], 3);
    }

    // Review round 2: the single-shift Z path aggregates orders by
    // staff_shift_id directly and was missed by the first fix pass.
    #[test]
    fn test_generate_z_report_excludes_open_unpaid_table_tab_from_shift_gross() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        seed_table_tab_order_with(&db, "2026-02-16T12:00:00Z", "active", Some("shift-zr-1"));

        let payload = serde_json::json!({ "shiftId": shift_id });
        let result = generate_z_report(&db, &payload).expect("generate");
        let report = &result["report"];

        assert_eq!(
            report["grossSales"], 100.0,
            "single-shift gross must exclude the uncollected tab"
        );
        assert_eq!(report["totalOrders"], 3);
    }

    // Review round 2: a CANCELLED unpaid table order is dead history, not a
    // live tab — it must remain deletable or it accumulates forever.
    #[test]
    fn test_apply_local_day_rollover_clears_cancelled_unpaid_table_order() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_table_tab_order_with(&db, "2026-02-16T19:00:00Z", "cancelled", None);

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("cleanup should succeed");

        assert_eq!(
            result["orders"], 4,
            "the cancelled tab is not a live order and must be cleared with the day"
        );
        let conn = db.conn.lock().unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "no immortal cancelled tabs may survive");
    }

    // Review round 2: a fully-refunded order can recompute back to
    // payment_status 'pending', but its money WAS collected and returned —
    // gross must still include it (the refund line subtracts it) and the
    // rollover must still clear it.
    #[test]
    fn test_settled_order_with_pending_payment_status_is_still_reported_and_rolled_over() {
        let db = test_db();
        seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, table_number,
                    discount_amount, discount_amount_cents,
                    tip_amount, tip_amount_cents,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'ord-refunded-tab', '#rtab', '[]', 55.0, 5500, 'completed', 'dine-in',
                    'pending', '7', 0.0, 0, 0.0, 0, 'pending', ?1, ?1
                 )",
                params!["2026-02-16T12:00:00Z"],
            )
            .expect("insert refund-shaped order");
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at)
                 VALUES ('pay-rtab', 'ord-refunded-tab', 'card', 55.0, 5500, 'completed', 'shift-zr-1', 'EUR', ?1, ?1)",
                params!["2026-02-16T12:05:00Z"],
            )
            .expect("insert settled payment");
        }

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let report = &result["report"];
        assert_eq!(
            report["grossSales"], 155.0,
            "an order with settled payment activity is collected money and must stay in gross"
        );
        assert_eq!(report["totalOrders"], 4);

        let cleanup = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("cleanup should succeed");
        assert_eq!(
            cleanup["orders"], 4,
            "a settled order is closed-day history and must be cleared"
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

    fn seed_print_job(
        conn: &Connection,
        id: &str,
        status: &str,
        created_at: &str,
        reprint_of: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO print_jobs
             (id, entity_type, entity_id, status, created_at, updated_at, reprint_of_job_id)
             VALUES (?1, 'order_receipt', ?1, ?2, ?3, ?3, ?4)",
            params![id, status, created_at, reprint_of],
        )
        .expect("insert print job");
    }

    fn seed_print_attempt(conn: &Connection, attempt_id: &str, job_id: &str, state: &str) {
        conn.execute(
            "INSERT INTO print_job_attempts
             (id, print_job_id, attempt_number, transport, resolved_target, document_name,
              state, bytes_requested, bytes_written, started_at, last_seen_at)
             VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(attempt_number), 0) + 1
                      FROM print_job_attempts WHERE print_job_id = ?2),
                     'raw_tcp', 'host:12:192.168.1.19:9100', 'receipt', ?3,
                     100, 0, '2026-02-16T20:00:00.000Z', '2026-02-16T20:00:00.000Z')",
            params![attempt_id, job_id, state],
        )
        .expect("insert print attempt");
    }

    fn print_job_ids(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT id FROM print_jobs ORDER BY id")
            .unwrap();
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        ids
    }

    fn print_attempt_ids(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT id FROM print_job_attempts ORDER BY id")
            .unwrap();
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        ids
    }

    fn orphaned_print_attempts(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM print_job_attempts a
             WHERE NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.id = a.print_job_id)",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Tomikro Parisi, 30/09/2026 (desktop 1.4.119): the closing Z deleted
    /// every print job created before the cutoff, including one whose raw_tcp
    /// attempt was still `submitting`. Foreign keys are off during the
    /// rollover, so that attempt survived with no job above it and blocked
    /// the printer until a manual repair. The day close now keeps every job
    /// that is printing or holds a printer, and deletes the rest of the
    /// closed day's jobs (finished or pending) always together with their
    /// attempts. Pending jobs go because the same rollover deletes the orders
    /// and shifts they would print: kept, they would fail later and could
    /// raise a false `printer.critical_failure`.
    #[test]
    fn test_local_day_rollover_clears_the_days_print_jobs_but_never_one_holding_a_printer() {
        let db = test_db();
        let before = "2026-02-16T20:00:00Z";
        {
            let conn = db.conn.lock().unwrap();
            // Stay: printing, or an attempt still holds the printer.
            seed_print_job(&conn, "pj-printing", "printing", before, None);
            seed_print_attempt(&conn, "pa-printing", "pj-printing", "submitting");
            seed_print_job(&conn, "pj-printing-no-attempt", "printing", before, None);
            seed_print_job(&conn, "pj-pending-blocked", "pending", before, None);
            seed_print_attempt(&conn, "pa-pending-blocked", "pj-pending-blocked", "unknown");
            seed_print_job(&conn, "pj-failed-unresolved", "failed", before, None);
            seed_print_attempt(
                &conn,
                "pa-failed-unknown",
                "pj-failed-unresolved",
                "unknown",
            );
            // Go: pending with nothing holding a printer, with their finished
            // attempts.
            seed_print_job(&conn, "pj-pending", "pending", before, None);
            seed_print_job(&conn, "pj-pending-retry", "pending", before, None);
            seed_print_attempt(
                &conn,
                "pa-pending-retry",
                "pj-pending-retry",
                "transport_error",
            );
            // Go: finished, with the attempts that must leave with them.
            seed_print_job(&conn, "pj-dispatched", "dispatched", before, None);
            seed_print_attempt(&conn, "pa-dispatched", "pj-dispatched", "sent");
            seed_print_job(&conn, "pj-failed", "failed", before, None);
            seed_print_attempt(&conn, "pa-failed-1", "pj-failed", "transport_error");
            seed_print_attempt(&conn, "pa-failed-2", "pj-failed", "transport_error");
            seed_print_job(&conn, "pj-cancelled", "cancelled", before, None);
            seed_print_attempt(&conn, "pa-cancelled", "pj-cancelled", "cancelled");
            // A reprint that stays keeps its source; one that goes does not.
            seed_print_job(&conn, "pj-source-kept", "printed", before, None);
            seed_print_job(
                &conn,
                "pj-reprint-printing",
                "printing",
                before,
                Some("pj-source-kept"),
            );
            seed_print_job(&conn, "pj-source-cleared", "printed", before, None);
            seed_print_job(
                &conn,
                "pj-reprint-cleared",
                "dispatched",
                before,
                Some("pj-source-cleared"),
            );
            seed_print_job(&conn, "pj-source-of-pending", "printed", before, None);
            seed_print_job(
                &conn,
                "pj-reprint-pending",
                "pending",
                before,
                Some("pj-source-of-pending"),
            );
            // After the cutoff: the next day's work.
            seed_print_job(
                &conn,
                "pj-next-day",
                "dispatched",
                "2026-02-17T08:00:00Z",
                None,
            );
            seed_print_attempt(&conn, "pa-next-day", "pj-next-day", "sent");
            seed_print_job(
                &conn,
                "pj-next-day-pending",
                "pending",
                "2026-02-17T08:00:00Z",
                None,
            );
        }

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("rollover should succeed");

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            print_job_ids(&conn),
            vec![
                "pj-failed-unresolved",
                "pj-next-day",
                "pj-next-day-pending",
                "pj-pending-blocked",
                "pj-printing",
                "pj-printing-no-attempt",
                "pj-reprint-printing",
                "pj-source-kept",
            ],
            "only jobs that are printing, hold a printer, or are the source of a kept reprint outlive the day"
        );
        assert_eq!(
            print_attempt_ids(&conn),
            vec![
                "pa-failed-unknown",
                "pa-next-day",
                "pa-pending-blocked",
                "pa-printing"
            ],
            "the attempts of deleted jobs leave with them"
        );
        assert_eq!(
            orphaned_print_attempts(&conn),
            0,
            "no attempt without a job"
        );
        assert_eq!(result["print_jobs"], 9);
        assert_eq!(result["print_job_attempts"], 5);
        assert_eq!(result["print_jobs_kept_live"], 6);
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1, "the rollover restores foreign keys");
    }

    /// A partial repair schema without `print_job_attempts`: nothing can hold
    /// a printer, so the closed day's pending and finished jobs go by status
    /// alone, as before 1.4.120, and a printing job stays.
    #[test]
    fn test_local_day_rollover_clears_print_jobs_by_status_without_the_attempt_table() {
        let db = test_db();
        let before = "2026-02-16T20:00:00Z";
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("DROP TABLE print_job_attempts").unwrap();
            seed_print_job(&conn, "pj-pending", "pending", before, None);
            seed_print_job(&conn, "pj-printed", "printed", before, None);
            seed_print_job(&conn, "pj-failed", "failed", before, None);
            seed_print_job(&conn, "pj-printing", "printing", before, None);
            seed_print_job(
                &conn,
                "pj-next-day",
                "pending",
                "2026-02-17T08:00:00Z",
                None,
            );
        }

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("rollover should succeed without the attempt table");

        let conn = db.conn.lock().unwrap();
        assert_eq!(print_job_ids(&conn), vec!["pj-next-day", "pj-printing"]);
        assert_eq!(result["print_jobs"], 3);
        assert_eq!(result["print_job_attempts"], 0);
        assert_eq!(result["print_jobs_kept_live"], 1);
    }

    /// Databases that closed a day on 1.4.119 or earlier may already hold
    /// orphans. A finished one is deleted here. A blocking one is left to the
    /// dispatcher's lane sweep, which closes it under the printer lane lock
    /// (`print_dispatch::DispatchManager::sweep_orphaned_lanes`); the next
    /// day close then deletes it.
    #[test]
    fn test_local_day_rollover_clears_finished_legacy_orphans_and_leaves_blocking_ones() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
            seed_print_attempt(&conn, "pa-legacy-sent", "pj-long-gone", "sent");
            seed_print_attempt(&conn, "pa-legacy-cancelled", "pj-repaired", "cancelled");
            seed_print_attempt(&conn, "pa-legacy-submitting", "pj-tomikro", "submitting");
            conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        }

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("rollover should succeed");

        let conn = db.conn.lock().unwrap();
        assert_eq!(print_attempt_ids(&conn), vec!["pa-legacy-submitting"]);
        assert_eq!(result["print_job_attempts"], 2);
    }

    /// Every `recovery_action_log` row, as one JSON array per row.
    fn recovery_log_rows(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare(
                "SELECT json_array(id, action_id, issue_code, recipe_id, recipe_version,
                                   entity_type, entity_id, success, message, payload_json,
                                   created_at)
                 FROM recovery_action_log
                 ORDER BY rowid",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    }

    /// The lane sweep closes a legacy orphan and audits the close. The next
    /// day close deletes the closed attempt (now a finished orphan), so the
    /// audit row is the only trail left: it must survive that day close
    /// unchanged, with the attempt's ids and previous state.
    #[test]
    fn test_orphan_close_audit_row_survives_the_next_day_close() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
            seed_print_attempt(&conn, "pa-tomikro", "pj-deleted-at-z", "submitting");
            conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

            let manager =
                crate::print_dispatch::DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
            // Real order of events: the sweep closes the orphan during the day,
            // BEFORE the next Z's cutoff. Dating the audit row before the cutoff
            // makes this test catch a day close that ever starts deleting audit
            // rows by date (a row dated after the cutoff would survive that).
            let swept_at = chrono::DateTime::parse_from_rfc3339("2026-02-16T21:00:00Z")
                .unwrap()
                .with_timezone(&Utc);
            let released = manager.sweep_orphaned_lanes(&conn, swept_at).unwrap();
            assert_eq!(released.len(), 1, "the sweep releases the orphan's printer");
        }
        let audit = {
            let conn = db.conn.lock().unwrap();
            let rows = recovery_log_rows(&conn);
            assert_eq!(rows.len(), 1, "one audit row for the one closed orphan");
            let before_cutoff: bool = conn
                .query_row(
                    "SELECT julianday(created_at) < julianday('2026-02-16T23:59:59Z')
                     FROM recovery_action_log",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(
                before_cutoff,
                "the audit row is dated before the next day close's cutoff"
            );
            let (action_id, entity_id, payload): (String, String, String) = conn
                .query_row(
                    "SELECT action_id, entity_id, payload_json FROM recovery_action_log",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(action_id, "print_orphan_attempt_closed");
            assert_eq!(entity_id, "pa-tomikro");
            let payload: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["attemptId"], "pa-tomikro");
            assert_eq!(payload["printJobId"], "pj-deleted-at-z");
            assert_eq!(payload["previousState"], "submitting");
            assert_eq!(payload["transport"], "raw_tcp");
            assert_eq!(payload["target"], "host:12:192.168.1.19:9100");
            assert_eq!(payload["bytesWritten"], 0);
            assert_eq!(payload["previousLastError"], Value::Null);
            assert_eq!(payload["outcome"], "resolved");
            rows
        };

        apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("rollover should succeed");

        let conn = db.conn.lock().unwrap();
        assert!(
            print_attempt_ids(&conn).is_empty(),
            "the day close deletes the closed orphan"
        );
        assert_eq!(
            recovery_log_rows(&conn),
            audit,
            "the audit row outlives the attempt it describes"
        );
    }

    #[test]
    fn test_active_staff_blockers_are_visible_when_branch_id_is_unresolved() {
        // Regression: the gate filtered `(branch_id = ?1 OR branch_id IS NULL)`
        // without the `?1 = ''` wildcard every sibling query uses. branch_id
        // falls back to storage::get_credential("branch_id").unwrap_or_default(),
        // so on a terminal with a missing keyring credential or a drifted branch
        // cache it is "" — and the gate then matched nothing and declared the day
        // clean, while the branch-blind step-9 sweep could still reach those rows.
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-other-branch', 'staff-7', 'Still In', 'branch-1', 'term-1', 'cashier',
                0.0, 0,
                '2026-02-16T09:00:00Z', NULL, 'active', 2,
                'pending', '2026-02-16T09:00:00Z', '2026-02-16T09:00:00Z'
             )",
            [],
        )
        .expect("insert active shift");

        let unresolved = load_active_staff_closeout_blockers(&conn, "", None)
            .expect("blocker scan with an unresolved branch should succeed");
        assert_eq!(
            unresolved.len(),
            1,
            "an unresolved branch must mean ALL rows, not just NULL-branch rows"
        );

        // A resolved branch still scopes normally.
        let scoped = load_active_staff_closeout_blockers(&conn, "branch-1", None)
            .expect("blocker scan for the real branch should succeed");
        assert_eq!(scoped.len(), 1, "the shift's own branch still matches");

        let other = load_active_staff_closeout_blockers(&conn, "branch-2", None)
            .expect("blocker scan for a different branch should succeed");
        assert_eq!(other.len(), 0, "a different resolved branch must not match");
    }

    #[test]
    fn test_local_day_rollover_closes_shift_left_open_before_sweeping_it() {
        // Regression: the sweep matched on timestamp alone, so a shift still
        // status='active' was erased locally while the Supabase row kept
        // check_out_time NULL forever. pos-tauri never pulls staff_shifts back
        // from the server, so nothing could ever close it again — and the
        // staff_shifts_one_open_per_staff unique index then blocked that
        // person's check-ins on every other terminal.
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, branch_id, terminal_id, role_type,
                    opening_cash_amount, opening_cash_amount_cents,
                    check_in_time, check_out_time, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'shift-left-open', 'staff-9', 'Left Open', 'branch-1', 'term-1', 'cashier',
                    0.0, 0,
                    '2026-02-16T09:00:00Z', NULL, 'active', 2,
                    'pending', '2026-02-16T09:00:00Z', '2026-02-16T09:00:00Z'
                 )",
                [],
            )
            .expect("insert shift left open");
        }

        let result = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("rollover should succeed");

        assert_eq!(
            result["staff_shifts_closed_at_rollover"], 1,
            "the shift left open must be closed by the rollover, not silently dropped"
        );

        let conn = db.conn.lock().unwrap();

        // The local row is still swept — but only after its closure was queued.
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_shifts WHERE id = 'shift-left-open'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0, "row is swept once it has been closed");

        // The closure has to reach the server, or the row there stays open forever.
        let (queued, payload): (i64, String) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(data), '')
                   FROM parity_sync_queue
                  WHERE table_name = 'staff_shifts' AND record_id = 'shift-left-open'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            queued, 1,
            "closure must be queued so the server learns the shift ended"
        );
        assert!(
            payload.contains("2026-02-16T23:59:59Z"),
            "queued closure should carry the rollover cutoff as the check-out time, got: {payload}"
        );
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

        // Wave 5 Session 6: z-report sync queue entries live on parity now.
        let queued_z_reports: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue
                 WHERE table_name = 'z_reports' AND status = 'pending'",
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
    fn test_get_end_of_day_status_idle_for_current_business_day_before_seven_am() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let check_in = utc_rfc3339_from_local(2026, 2, 16, 15, 0, 0);
        let check_out = utc_rfc3339_from_local(2026, 2, 16, 23, 15, 0);

        // W4e Step 0: dual-populate (200/235/235/0/10 → 20000/23500/23500/0/1000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-current-business-day', 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 20000, 235.0, 23500, 235.0, 23500, 0.0, 0,
                ?1, ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![check_in, check_out],
        )
        .expect("insert closed shift");
        conn.execute(
            "INSERT INTO orders (id, branch_id, order_number, order_type, status, total_amount, total_amount_cents, created_at, updated_at)
             VALUES ('ord-current-business-day', 'branch-1', 1002, 'dine_in', 'completed', 10.0, 1000, ?1, ?1)",
            params![check_out],
        )
        .expect("insert order");
        drop(conn);

        let status = get_end_of_day_status_at(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
            local_datetime(2026, 2, 17, 0, 30, 0).with_timezone(&Utc),
        )
        .expect("status should load");

        assert_eq!(
            status["status"], "idle",
            "the previous calendar day is still the active business day before 07:00"
        );
        assert_eq!(status["activeReportDate"], "2026-02-16");
    }

    #[test]
    fn test_get_end_of_day_status_marks_previous_business_day_pending_at_boundary() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let check_in = utc_rfc3339_from_local(2026, 2, 16, 15, 0, 0);
        let check_out = utc_rfc3339_from_local(2026, 2, 16, 23, 15, 0);

        // W4e Step 0: dual-populate (200/235/235/0 → 20000/23500/23500/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-overnight', 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 20000, 235.0, 23500, 235.0, 23500, 0.0, 0,
                ?1, ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![check_in, check_out],
        )
        .expect("insert overnight shift");
        drop(conn);

        let status = get_end_of_day_status_at(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
            local_datetime(2026, 2, 17, 7, 0, 0).with_timezone(&Utc),
        )
        .expect("status should load");

        assert_eq!(status["status"], "pending_local_submit");
        assert_eq!(status["pendingReportDate"], "2026-02-16");
    }

    #[test]
    fn test_get_end_of_day_status_idle_exposes_active_business_window() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let check_in = utc_rfc3339_from_local(2026, 2, 16, 15, 0, 0);

        // W4e Step 0: dual-populate (200.0 → 20000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                check_in_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-active-overnight', 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 20000, ?1, 'active', 2,
                'pending', ?1, ?1
             )",
            params![check_in],
        )
        .expect("insert active overnight shift");
        drop(conn);

        let status = get_end_of_day_status_at(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
            local_datetime(2026, 2, 17, 0, 30, 0).with_timezone(&Utc),
        )
        .expect("status should load");

        assert_eq!(status["status"], "idle");
        assert_eq!(status["activeReportDate"], "2026-02-16");
        assert_eq!(status["activePeriodStartAt"], check_in);
    }

    #[test]
    fn test_load_pending_z_report_context_suppresses_current_business_day_before_boundary() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();

        persist_pending_z_report_context(
            &conn,
            &PendingZReportContext {
                branch_id: "branch-1".to_string(),
                report_date: "2026-02-16".to_string(),
                cutoff_at: utc_rfc3339_from_local(2026, 2, 16, 23, 15, 0),
                period_start_at: utc_rfc3339_from_local(2026, 2, 16, 15, 0, 0),
            },
        )
        .expect("persist pending context");

        let suppressed = load_pending_z_report_context_at(
            &conn,
            "branch-1",
            local_datetime(2026, 2, 17, 0, 30, 0),
        );
        assert!(
            suppressed.is_none(),
            "current business day should stay open before 07:00"
        );
        assert!(
            db::get_setting(&conn, "system", PENDING_Z_REPORT_CONTEXT_KEY).is_none(),
            "suppressed same-business-day pending context should be cleared"
        );

        persist_pending_z_report_context(
            &conn,
            &PendingZReportContext {
                branch_id: "branch-1".to_string(),
                report_date: "2026-02-16".to_string(),
                cutoff_at: utc_rfc3339_from_local(2026, 2, 16, 23, 15, 0),
                period_start_at: utc_rfc3339_from_local(2026, 2, 16, 15, 0, 0),
            },
        )
        .expect("persist pending context again");

        let actionable = load_pending_z_report_context_at(
            &conn,
            "branch-1",
            local_datetime(2026, 2, 17, 7, 1, 0),
        );
        assert!(
            actionable.is_some(),
            "pending context should become actionable after 07:00"
        );
    }

    #[test]
    fn test_active_window_report_date_uses_period_start_local_date() {
        let period_start = utc_rfc3339_from_local(2026, 4, 2, 0, 44, 47);
        let fallback_now = utc_rfc3339_from_local(2026, 4, 2, 1, 38, 24);

        assert_eq!(
            active_window_report_date(&period_start, &fallback_now),
            "2026-04-02",
            "active report date must follow the local date implied by periodStart"
        );
    }

    #[test]
    fn test_repair_retryable_z_report_business_dates_requeues_failed_rows() {
        let db = test_db();
        seed_closed_shift(&db);
        let expected_report_date =
            report_date_for_business_window("2026-04-01T22:44:47.248Z", "2026-04-01T23:38:24.403Z");

        let generated = generate_z_report_for_date(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
                "date": "2026-02-16",
            }),
        )
        .expect("generate should persist z-report");

        let z_report_id = generated["zReportId"]
            .as_str()
            .or_else(|| generated["report"]["id"].as_str())
            .expect("z_report_id should be present")
            .to_string();

        let conn = db.conn.lock().unwrap();
        let report_json_str: String = conn
            .query_row(
                "SELECT report_json FROM z_reports WHERE id = ?1",
                params![z_report_id.as_str()],
                |row| row.get(0),
            )
            .expect("load report_json");
        let mut report_json: Value =
            serde_json::from_str(&report_json_str).expect("report_json should parse");
        canonicalize_report_json_period(
            &mut report_json,
            "2026-04-01T22:44:47.248Z",
            "2026-04-01T23:38:24.403Z",
        );
        canonicalize_report_json_report_date(&mut report_json, "2026-03-31");

        conn.execute(
            "UPDATE z_reports
             SET report_date = '2026-03-31',
                 report_json = ?2,
                 sync_state = 'failed',
                 sync_retry_count = 5,
                 sync_last_error = 'report_date must match the branch business date for periodStart (2026-04-02)'
             WHERE id = ?1",
            params![z_report_id.as_str(), report_json.to_string()],
        )
        .expect("poison z_report");

        let poisoned_payload = serde_json::json!({
            "terminal_id": "term-1",
            "branch_id": "branch-1",
            "report_date": "2026-03-31",
            "report_data": report_json,
        });
        // Wave 5 Session 6: generate_z_report now enqueues on parity, so
        // the failed-state poison targets parity columns (data, attempts,
        // error_message, last_attempt) instead of their legacy siblings.
        conn.execute(
            "UPDATE parity_sync_queue
             SET data = ?2,
                 status = 'failed',
                 attempts = 5,
                 error_message = 'report_date must match the branch business date for periodStart (2026-04-02)',
                 next_retry_at = '2026-04-02T00:00:00Z'
             WHERE table_name = 'z_reports'
               AND record_id = ?1",
            params![z_report_id.as_str(), poisoned_payload.to_string()],
        )
        .expect("poison z_report parity queue row");
        drop(conn);

        let repaired =
            repair_retryable_z_report_business_dates(&db).expect("repair should succeed");
        assert_eq!(repaired, 1);

        let conn = db.conn.lock().unwrap();
        let (report_date, sync_state, sync_retry_count, sync_last_error, repaired_report_json): (
            String,
            String,
            i64,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT report_date, sync_state, sync_retry_count, sync_last_error, report_json
                 FROM z_reports
                 WHERE id = ?1",
                params![z_report_id.as_str()],
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
            .expect("load repaired z_report");
        // Wave 5 Session 6: repair target is parity, so the post-repair
        // state check reads parity columns (attempts, error_message, data).
        let (queue_status, queue_retry_count, queue_last_error, queue_payload): (
            String,
            i64,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT status, attempts, error_message, data
                 FROM parity_sync_queue
                 WHERE table_name = 'z_reports'
                   AND record_id = ?1",
                params![z_report_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("load repaired parity queue row");

        assert_eq!(report_date, expected_report_date);
        assert_eq!(sync_state, "pending");
        assert_eq!(sync_retry_count, 0);
        assert!(sync_last_error.is_none());

        assert_eq!(queue_status, "pending");
        assert_eq!(queue_retry_count, 0);
        assert!(queue_last_error.is_none());

        let repaired_report_json: Value =
            serde_json::from_str(&repaired_report_json).expect("repaired report_json should parse");
        assert_eq!(repaired_report_json["date"], expected_report_date);
        assert_eq!(repaired_report_json["reportDate"], expected_report_date);
        assert_eq!(repaired_report_json["report_date"], expected_report_date);
        assert_eq!(
            repaired_report_json["periodStart"],
            "2026-04-01T22:44:47.248Z"
        );
        assert_eq!(
            repaired_report_json["periodEnd"],
            "2026-04-01T23:38:24.403Z"
        );

        let repaired_queue_payload: Value =
            serde_json::from_str(&queue_payload).expect("repaired queue payload should parse");
        assert_eq!(repaired_queue_payload["report_date"], expected_report_date);
        assert_eq!(repaired_queue_payload["terminal_id"], "term-1");
        assert_eq!(repaired_queue_payload["branch_id"], "branch-1");
        assert_eq!(
            repaired_queue_payload["report_data"]["date"],
            expected_report_date
        );
        assert_eq!(
            repaired_queue_payload["report_data"]["periodStart"],
            "2026-04-01T22:44:47.248Z"
        );
        assert_eq!(
            repaired_queue_payload["report_data"]["periodEnd"],
            "2026-04-01T23:38:24.403Z"
        );
    }

    #[test]
    fn test_get_end_of_day_status_respects_configured_business_day_boundary() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        db::set_setting(&conn, "system", "business_day_start", "06:00")
            .expect("store business day start");

        let check_in = utc_rfc3339_from_local(2026, 2, 16, 15, 0, 0);
        let check_out = utc_rfc3339_from_local(2026, 2, 16, 23, 15, 0);
        // W4e Step 0: dual-populate (200/235/235/0 → 20000/23500/23500/0).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-configured-boundary', 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 20000, 235.0, 23500, 235.0, 23500, 0.0, 0,
                ?1, ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![check_in, check_out],
        )
        .expect("insert closed shift");
        drop(conn);

        let status = get_end_of_day_status_at(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
            }),
            local_datetime(2026, 2, 17, 6, 30, 0).with_timezone(&Utc),
        )
        .expect("status should load");

        assert_eq!(status["status"], "pending_local_submit");
        assert_eq!(status["pendingReportDate"], "2026-02-16");
    }

    #[test]
    fn test_generate_z_report_for_date_uses_frozen_cutoff_to_exclude_late_orders() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_late_day_order(&db, "2026-02-16T19:00:00Z");

        {
            let conn = db.conn.lock().unwrap();
            // Keep the late receipt's branch consistent with its original
            // cashier shift, so custody remains valid even outside the cutoff.
            conn.execute(
                "UPDATE orders SET branch_id = 'branch-1' WHERE id = 'ord-late'",
                [],
            )
            .expect("scope late order to its cashier branch");
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
        assert_eq!(
            report["reportJson"]["period"]["start"],
            "2026-02-16T09:00:00Z"
        );
        assert_eq!(
            report["reportJson"]["period"]["end"],
            "2026-02-16T18:00:00Z"
        );
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
        drop(conn);

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

    /// Item D7 (round 2, founder rule 30/09 and 01/10/2026): a cancelled
    /// order of the period still labelled paid with no payment record used to
    /// vanish from the Z (every Z query skips cancelled orders). It is now a
    /// WARNING finding `cancelled_order_claims_payment` (Android: the same
    /// name and wording): listed, never blocking the close, and never in the
    /// totals. A cancelled pending order and a platform-held one are not.
    #[test]
    fn z_lists_a_cancelled_order_still_claiming_a_payment_as_a_warning() {
        let db = test_db();
        seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            for (id, label, metadata) in [
                ("ord-cancelled-paid", "paid", None),
                ("ord-cancelled-partial", "Partially_Paid", None),
                ("ord-cancelled-pending", "pending", None),
                (
                    "ord-cancelled-efood",
                    "paid",
                    Some(
                        r#"{"food_delivery":{"prepaid":true,"payment_method":"online","delivery_provider":"platform_delivery"}}"#,
                    ),
                ),
            ] {
                conn.execute(
                    "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                        status, order_type, payment_status, branch_id, ghost_metadata,
                        sync_status, created_at, updated_at)
                     VALUES (?1, ?1, '[]', 8.0, 800, 'cancelled', 'pickup', ?2, 'branch-1', ?3,
                             'synced', '2026-02-16T13:00:00Z', '2026-02-16T13:30:00Z')",
                    params![id, label, metadata],
                )
                .unwrap();
            }
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let integrity = &result["report"]["reportJson"]["integrity"];
        let findings: Vec<(String, String, String)> = integrity["findings"]
            .as_array()
            .expect("findings")
            .iter()
            .filter(|finding| finding["reasonCode"] == "cancelled_order_claims_payment")
            .map(|finding| {
                (
                    finding["orderId"].as_str().unwrap_or("").to_string(),
                    finding["severity"].as_str().unwrap_or("").to_string(),
                    finding["reasonText"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        assert_eq!(
            findings.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(),
            vec!["ord-cancelled-paid", "ord-cancelled-partial"],
            "{integrity}"
        );
        assert!(findings.iter().all(|finding| finding.1 == "warning"));
        assert!(findings[0].2.contains("This does not hold the day."));
        assert_eq!(integrity["warningFindings"], 2, "{integrity}");
        assert_eq!(integrity["blockingFindings"], 0, "{integrity}");
        assert_eq!(integrity["reconciled"], true, "never in the totals");

        // The close is never held by it.
        let gate = unsettled_payment_blockers(&db, &payload).expect("gate");
        assert!(
            gate.iter()
                .all(|blocker| blocker.reason_code != "cancelled_order_claims_payment"),
            "{gate:?}"
        );
    }

    #[test]
    fn test_unsettled_payment_blockers_treat_paid_split_order_without_local_rows_as_missing() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_paid_order_missing_local_payment_rows(&db, "2026-02-16T17:00:00Z");

        let blockers = unsettled_payment_blockers(
            &db,
            &serde_json::json!({
                "branchId": "branch-1",
                "date": "2026-02-16",
            }),
        )
        .expect("blocking orders should load");

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].order_id, "ord-missing-local-payment");
        assert!(!blockers[0].order_number.is_empty());
        assert!(blockers[0].missing_local_payment_row());

        let message =
            unsettled_payment_blocker_message(&blockers).expect("message should be present");
        assert!(message.contains(&blockers[0].order_number));
        assert!(message.contains(&blockers[0].reason_text));
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

    /// Wave 10 medium regression: a shift with a EUR 20 cash refund must
    /// have that refund deducted from `cashToReturn` so the drawer
    /// reconciliation matches the physical till.
    ///
    /// Before the fix, `cashToReturn` was `opening + cashCollected -
    /// expenses`; after the fix it also subtracts `cashRefunds`. Card
    /// refunds must NOT be deducted (they do not touch the drawer).
    #[test]
    fn test_build_staff_cash_breakdown_row_subtracts_cash_refunds() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let shift_id = "shift-cashref";
        let now = "2026-02-16T18:00:00Z";

        // W4e Step 0: dual-populate every monetary column.
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                check_in_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-1', 'Maria', 'branch-1', 'term-1', 'cashier',
                100.0, 10000, '2026-02-16T09:00:00Z', 'closed', 2,
                'pending', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert shift");

        // One paid-in-cash order, EUR 50 → 5000.
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id,
                discount_amount, discount_amount_cents,
                tip_amount, tip_amount_cents,
                sync_status, created_at, updated_at
             ) VALUES ('ord-cashref', '#1', '[]', 50.0, 5000, 'completed', 'dine-in',
                'paid', ?1, 0.0, 0, 0.0, 0, 'pending', ?2, ?2)",
            params![shift_id, now],
        )
        .expect("insert order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id,
                currency, created_at, updated_at
             ) VALUES ('pay-cashref', 'ord-cashref', 'cash', 50.0, 5000, 'completed',
                ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        )
        .expect("insert payment");

        // The cash refund the drawer must give back to the customer (20.0 → 2000).
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                staff_shift_id, refund_method, sync_state, created_at, updated_at
             ) VALUES ('adj-cash', 'pay-cashref', 'ord-cashref', 'refund', 20.0, 2000,
                'too cold', ?1, 'cash', 'pending', ?2, ?2)",
            params![shift_id, now],
        )
        .expect("insert cash refund");

        // A card refund on the same shift (7.5 → 750) — must NOT be deducted
        // from the cash drawer return amount.
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                staff_shift_id, refund_method, sync_state, created_at, updated_at
             ) VALUES ('adj-card', 'pay-cashref', 'ord-cashref', 'refund', 7.5, 750,
                'late delivery', ?1, 'card', 'pending', ?2, ?2)",
            params![shift_id, now],
        )
        .expect("insert card refund");

        // EUR 5 staff expense (5.0 → 500) for completeness — should also reduce
        // cashToReturn.
        conn.execute(
            "INSERT INTO shift_expenses (
                id, staff_shift_id, staff_id, branch_id, expense_type, amount, amount_cents,
                description, sync_status, created_at, updated_at
             ) VALUES ('exp-cashref', ?1, 'staff-1', 'branch-1', 'supplies',
                5.0, 500, 'Receipt rolls', 'pending', ?2, ?2)",
            params![shift_id, now],
        )
        .expect("insert expense");

        let row = build_staff_cash_breakdown_row(&conn, shift_id, Some("Maria"), "cashier", 100.0)
            .expect("build_staff_cash_breakdown_row");

        // 100 opening + 50 cash collected - 5 expenses - 20 cash refund = 125.
        // The 7.5 card refund must NOT factor into the drawer return.
        assert_eq!(row["cashToReturn"].as_f64(), Some(125.0));
        assert_eq!(row["cashRefunds"].as_f64(), Some(20.0));
        assert_eq!(row["cashCollected"].as_f64(), Some(50.0));
        assert_eq!(row["expenses"].as_f64(), Some(5.0));
        assert_eq!(row["startingAmount"].as_f64(), Some(100.0));
    }

    /// Round 3 review (01/10/2026, shared rule R2): a courier row read from
    /// the courier's earnings took the refunds the courier handed back off
    /// AGAIN when they were booked under the driver's own shift: the earning
    /// is already net of them (the refund lowers it, every recount reads it
    /// net). The driver's own checkout subtracts none.
    #[test]
    fn a_courier_row_takes_the_cash_the_courier_handed_back_off_once() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let now = "2026-10-01T18:00:00Z";
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, opening_cash_amount_cents,
                check_in_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-courier-z', 'driver-z', 'Nikos', 'branch-1', 'term-1', 'driver',
                20.0, 2000, '2026-10-01T09:00:00Z', 'active', 2, 'pending', ?1, ?1
             )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id, driver_id, sync_status, created_at, updated_at
             ) VALUES ('ord-courier-z', '#7', '[]', 13.0, 1300, 'delivered', 'delivery',
                'paid', 'shift-courier-z', 'driver-z', 'pending', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id,
                currency, created_at, updated_at
             ) VALUES ('pay-courier-z', 'ord-courier-z', 'cash', 13.0, 1300, 'completed',
                'shift-courier-z', 'EUR', ?1, ?1)",
            params![now],
        )
        .unwrap();
        // The earning after the courier handed 5.00 back: 13.00 - 5.00.
        conn.execute(
            "INSERT INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id, delivery_fee, tip_amount,
                total_earning, payment_method, cash_collected, cash_collected_cents,
                card_amount, card_amount_cents, cash_to_return, cash_to_return_cents,
                settled, created_at, updated_at
             ) VALUES ('earning-courier-z', 'driver-z', 'shift-courier-z', 'ord-courier-z',
                'branch-1', 0, 0, 0, 'cash', 8.0, 800, 0, 0, 8.0, 800, 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (
                id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                staff_shift_id, refund_method, cash_handler, sync_state, created_at, updated_at
             ) VALUES ('adj-courier-z', 'pay-courier-z', 'ord-courier-z', 'refund', 5.0, 500,
                'Synthetic', 'shift-courier-z', 'cash', 'driver_shift', 'pending', ?1, ?1)",
            params![now],
        )
        .unwrap();

        let row =
            build_staff_cash_breakdown_row(&conn, "shift-courier-z", Some("Nikos"), "driver", 20.0)
                .expect("courier row");
        assert_eq!(row["cashCollected"].as_f64(), Some(8.0));
        assert_eq!(row["cashRefunds"].as_f64(), Some(0.0), "{row}");
        assert_eq!(row["cashToReturn"].as_f64(), Some(28.0), "{row}");
    }

    #[test]
    fn server_repair_projection_covers_cross_day_refund_and_fails_closed_without_evidence() {
        let state = test_db();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, status, sync_status, created_at, updated_at,
                repair_tender_sales, repair_cash_sales, repair_card_sales,
                repair_orders_count, repair_projection_version, repair_projection_synced_at
             ) VALUES (
                'repair-pay', 'staff-1', 'Alex', 'branch-1', 'term-1', 'cashier',
                '2026-05-01T08:00:00Z', '2026-05-01T18:00:00Z', 'closed', 'synced',
                '2026-05-01T08:00:00Z', '2026-05-01T18:01:00Z',
                100.0, 100.0, 0.0, 1, 1, '2026-05-01T18:01:00Z'
             )",
            [],
        )
        .expect("insert payment projection");
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, status, sync_status, created_at, updated_at,
                repair_tender_sales, repair_cash_sales, repair_card_sales,
                repair_orders_count, repair_projection_version, repair_projection_synced_at
             ) VALUES (
                'repair-refund', 'staff-1', 'Alex', 'branch-1', 'term-1', 'cashier',
                '2026-05-02T08:00:00Z', '2026-05-02T12:00:00Z', 'closed', 'synced',
                '2026-05-02T08:00:00Z', '2026-05-02T12:01:00Z',
                -20.0, -20.0, 0.0, 1, 1, '2026-05-02T12:01:00Z'
             )",
            [],
        )
        .expect("insert refund projection");

        let projection = load_server_repair_projection(
            &conn,
            "branch-1",
            "2026-05-01T00:00:00Z",
            "2026-05-03T00:00:00Z",
        )
        .expect("authoritative projection");
        assert_eq!(projection["repairOrders"], 2);
        assert_eq!(projection["repairSales"], 80.0);
        assert_eq!(projection["repairCashSales"], 80.0);

        conn.execute(
            "UPDATE staff_shifts SET repair_projection_synced_at=NULL WHERE id='repair-refund'",
            [],
        )
        .unwrap();
        assert_eq!(
            load_server_repair_projection(
                &conn,
                "branch-1",
                "2026-05-01T00:00:00Z",
                "2026-05-03T00:00:00Z",
            )
            .unwrap_err(),
            "REPAIR_REPORTING_EVIDENCE_REQUIRED",
        );
    }

    #[test]
    fn repair_reporting_projection_apply_is_replay_safe_and_collision_safe() {
        let state = test_db();
        let shift_id = "11111111-1111-4111-8111-111111111111";
        {
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, branch_id, terminal_id, role_type,
                    check_in_time, status, sync_status, created_at, updated_at
                 ) VALUES (
                    ?1, 'staff-1', 'Alex', 'branch-1', 'term-1', 'cashier',
                    '2026-08-25T08:00:00Z', 'active', 'synced',
                    '2026-08-25T08:00:00Z', '2026-08-25T08:00:00Z'
                 )",
                params![shift_id],
            )
            .expect("insert reporting shift");
        }
        let projection = RepairReportingProjection {
            source: "repair_canonical_tender_projection_v1".to_string(),
            staff_shift_id: shift_id.to_string(),
            projection_version: 3,
            projected_at: "2026-08-25T10:11:12Z".to_string(),
            overall_tender: 178.0,
            overall_cash: 88.0,
            overall_card: 70.0,
            overall_orders_count: 4,
            repair_tender: 78.0,
            repair_cash: 28.0,
            repair_card: 50.0,
            repair_orders_count: 2,
        };
        assert_eq!(
            apply_repair_reporting_projection(&state, &projection).unwrap()["applied"],
            true
        );
        assert_eq!(
            apply_repair_reporting_projection(&state, &projection).unwrap()["wasReplay"],
            true
        );
        let mut stale = projection.clone();
        stale.projection_version = 2;
        stale.projected_at = "2026-08-25T10:10:00Z".to_string();
        assert_eq!(
            apply_repair_reporting_projection(&state, &stale).unwrap()["stale"],
            true
        );
        let mut collision = projection.clone();
        collision.overall_tender = 179.0;
        assert_eq!(
            apply_repair_reporting_projection(&state, &collision).unwrap_err(),
            "REPAIR_REPORTING_EVIDENCE_COLLISION"
        );
        let mut invalid = projection;
        invalid.source = "local_projection".to_string();
        assert_eq!(
            apply_repair_reporting_projection(&state, &invalid).unwrap_err(),
            "REPAIR_REPORTING_EVIDENCE_INVALID"
        );
    }

    #[test]
    fn repair_reporting_projection_invalidation_marks_stale_evidence_fail_closed() {
        let state = test_db();
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, check_in_time, status,
                branch_id, repair_projection_version, repair_projection_synced_at,
                created_at, updated_at
             ) VALUES (
                'repair-invalidate', 'staff-1', 'Tech', 'cashier',
                '2026-08-25T09:00:00Z', 'active', 'branch-1', 4,
                '2026-08-25T10:00:00Z', '2026-08-25T09:00:00Z',
                '2026-08-25T10:00:00Z'
             )",
            [],
        )
        .unwrap();
        drop(conn);

        assert!(invalidate_repair_reporting_projection(&state, Some("repair-invalidate")).unwrap());
        let conn = state.conn.lock().unwrap();
        let evidence: (i64, Option<String>) = conn
            .query_row(
                "SELECT repair_projection_version, repair_projection_synced_at
                   FROM staff_shifts WHERE id='repair-invalidate'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(evidence, (4, None));
    }

    // ------------------------------------------------------------------
    // 16/09/2026 incident regressions.
    //
    // Two bugs, one Z slip: «POS x37» printed inside ΠΛΑΤΦΟΡΜΕΣ, and
    // order-level turnover of €1.636,16 against payment-level €1.105,73 with
    // the report closing without a word.
    // ------------------------------------------------------------------

    #[test]
    fn test_plugin_pos_is_not_reported_as_an_external_platform() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            // 3 in-store orders that the till itself took. `plugin = 'pos'`
            // is an order SOURCE, not a marketplace: these used to print as
            // «POS ×3» next to efood.
            for (index, total_cents) in [(1_i64, 1000_i64), (2, 1500), (3, 2000)] {
                let order_id = format!("ord-pos-{index}");
                conn.execute(
                    "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                        status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                        created_at, updated_at)
                     VALUES (?1, ?1, '[]', ?2, ?3, 'completed', 'takeaway', 'paid', ?4, 'pos',
                             'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                    params![order_id, total_cents as f64 / 100.0, total_cents, shift_id],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                        staff_shift_id, sync_status, created_at, updated_at)
                     VALUES (?1, ?2, 'cash', ?3, ?4, 'completed', ?5, 'pending',
                             '2026-02-16T12:05:00Z', '2026-02-16T12:05:00Z')",
                    params![
                        format!("pay-{order_id}"),
                        order_id,
                        total_cents as f64 / 100.0,
                        total_cents,
                        shift_id
                    ],
                )
                .unwrap();
            }
            // One real platform order, so the section is not merely empty.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, plugin, ghost_metadata, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-efood-1', 'EF-1', '[]', 12.10, 1210, 'delivered', 'delivery', 'paid',
                         'efood', '{\"food_delivery\":{\"delivery_provider\":\"platform_delivery\",\"payment_method\":\"online\",\"prepaid\":true}}',
                         'pending', '2026-02-16T12:10:00Z', '2026-02-16T12:10:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                    transaction_ref, sync_status, created_at, updated_at)
                 VALUES ('pay-efood-1', 'ord-efood-1', 'other', 12.10, 1210, 'completed',
                         'platform_settlement:online:ord-efood-1', 'pending',
                         '2026-02-16T12:10:30Z', '2026-02-16T12:10:30Z')",
                [],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let report = &result["report"]["reportJson"];

        let platforms = report["sales"]["platforms"]
            .as_array()
            .expect("platforms array");
        let names: Vec<&str> = platforms
            .iter()
            .map(|entry| entry["platform"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(names, vec!["efood"], "only external platforms belong here");
        assert!(
            !names.contains(&"pos"),
            "«POS x37»: the store's own till is not a platform"
        );

        // Same rule in the Orders tab: a POS order carries no platform, so
        // the modal's «Platforms» filter cannot sweep the whole till in.
        let day_orders = report["dayOrders"].as_array().expect("dayOrders");
        for order in day_orders {
            let id = order["id"].as_str().unwrap_or("");
            if id.starts_with("ord-pos-") {
                assert!(
                    order["platform"].is_null(),
                    "POS order {id} must have no platform: {order:?}"
                );
            }
        }
        let efood_row = day_orders
            .iter()
            .find(|order| order["id"] == "ord-efood-1")
            .expect("efood order listed");
        assert_eq!(efood_row["platform"], "efood");
    }

    #[test]
    fn test_unknown_order_source_is_reported_not_filed_under_platforms() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            // `plugin` shares its namespace with payment gateways, analytics
            // and e-commerce integrations. `woocommerce` is catalogued with
            // `supports_order_sync`, so it is the realistic near-term case:
            // a web-shop order must NOT print inside ΠΛΑΤΦΟΡΜΕΣ as though a
            // delivery marketplace had carried it.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-woo', 'WOO-1', '[]', 24.0, 2400, 'completed', 'takeaway', 'paid', ?1,
                         'woocommerce', 'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                    staff_shift_id, sync_status, created_at, updated_at)
                 VALUES ('pay-woo', 'ord-woo', 'card', 24.0, 2400, 'completed', ?1, 'pending',
                         '2026-02-16T12:05:00Z', '2026-02-16T12:05:00Z')",
                params![shift_id],
            )
            .unwrap();
            // A real marketplace alongside it, so the section is not just empty.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, plugin, ghost_metadata, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-ef', 'EF-1', '[]', 12.10, 1210, 'delivered', 'delivery', 'paid',
                         'efood', '{\"food_delivery\":{\"delivery_provider\":\"platform_delivery\",\"payment_method\":\"online\",\"prepaid\":true}}',
                         'pending', '2026-02-16T12:10:00Z', '2026-02-16T12:10:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                    transaction_ref, sync_status, created_at, updated_at)
                 VALUES ('pay-ef', 'ord-ef', 'other', 12.10, 1210, 'completed',
                         'platform_settlement:online:ord-ef', 'pending',
                         '2026-02-16T12:10:30Z', '2026-02-16T12:10:30Z')",
                [],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let report = &result["report"]["reportJson"];

        // Only the marketplace is a platform.
        let names: Vec<&str> = report["sales"]["platforms"]
            .as_array()
            .expect("platforms array")
            .iter()
            .map(|entry| entry["platform"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(names, vec!["efood"]);

        // The unknown source is NAMED, not swallowed.
        let unclassified = report["integrity"]["unclassifiedPlatforms"]
            .as_array()
            .expect("unclassifiedPlatforms array");
        assert_eq!(unclassified.len(), 1, "{unclassified:?}");
        assert_eq!(unclassified[0]["source"], "woocommerce");
        assert_eq!(unclassified[0]["orders"], 1);
        assert_eq!(unclassified[0]["amount"], 24.0);

        // …and it keeps its full weight in BOTH totals: the platform block is
        // a breakdown, never a total. 100.00 fixture + 24.00 + 12.10.
        assert_eq!(report["integrity"]["orderTurnover"], 136.10);
        assert_eq!(report["integrity"]["paymentCoverage"], 136.10);
        assert_eq!(report["integrity"]["reconciled"], true);

        // The Orders tab shows it with no platform, so the «Platforms» filter
        // cannot sweep it in.
        let woo_row = report["dayOrders"]
            .as_array()
            .expect("dayOrders")
            .iter()
            .find(|order| order["id"] == "ord-woo")
            .expect("woocommerce order listed");
        assert!(woo_row["platform"].is_null());
    }

    #[test]
    fn test_z_report_carries_a_reconciliation_block() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-clean', 'C-1', '[]', 20.0, 2000, 'completed', 'takeaway', 'paid', ?1,
                         'pos', 'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                    staff_shift_id, sync_status, created_at, updated_at)
                 VALUES ('pay-clean', 'ord-clean', 'cash', 20.0, 2000, 'completed', ?1, 'pending',
                         '2026-02-16T12:05:00Z', '2026-02-16T12:05:00Z')",
                params![shift_id],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let integrity = &result["report"]["reportJson"]["integrity"];

        // `seed_closed_shift` already seeds 3 fully covered orders worth
        // EUR 100.00 in this window; this test adds EUR 20.00 on top.
        assert_eq!(integrity["reconciled"], true);
        assert_eq!(integrity["blockingFindings"], 0);
        assert_eq!(integrity["orderTurnover"], 120.0);
        assert_eq!(integrity["paymentCoverage"], 120.0);
        assert_eq!(integrity["difference"], 0.0);
        assert_eq!(integrity["uncoveredAmount"], 0.0);
        assert_eq!(integrity["excessAmount"], 0.0);
        // The two sides are reported separately and never summed: efood
        // turnover already sits inside both.
        assert_eq!(
            integrity["orderTurnover"],
            result["report"]["reportJson"]["sales"]["totalSales"]
        );
        assert_eq!(
            integrity["paymentCoverage"],
            result["report"]["reportJson"]["daySummary"]["total"]
        );
    }

    #[test]
    fn test_turnover_and_coverage_agree_on_the_reportable_population() {
        // Review item E (founder, 16/09/2026): the turnover aggregate carries
        // `z_report_reportable_order_expr`; the payment aggregate does NOT.
        // That asymmetry is only safe because both halves of the predicate
        // require the order to have no completed payment row, and the payment
        // aggregate counts only completed rows — so a hidden order contributes
        // zero to both sides.
        //
        // This is the executable proof of that reasoning. Relax either half and
        // coverage starts outrunning turnover (a negative `difference` with no
        // finding behind it), so this test fails first and says what to do.
        // The end-to-end behaviour it protects is pinned by
        // `test_z_report_turnover_excludes_orders_an_earlier_z_already_closed`.
        let open_tab = crate::business_day::open_unsettled_table_tab_expr("o");
        let swept = crate::business_day::paid_order_swept_by_last_z_expr("o", "?4");
        for (name, half) in [
            ("open unsettled tab", &open_tab),
            ("swept by last Z", &swept),
        ] {
            assert!(
                half.contains("NOT EXISTS")
                    && (half.contains("op_tab.status IN ('completed', 'refunded')")
                        || half.contains("op_swept.status = 'completed'")),
                "`{name}` must require \"no completed payment row\", or the payment \
                 aggregate needs the reportable clause (and a ?4 anchor) too: {half}"
            );
        }
        // …and those two really are the whole predicate.
        let expr = crate::business_day::z_report_reportable_order_expr("o", "?4");
        assert_eq!(
            expr,
            format!("(NOT {open_tab} AND NOT {swept})"),
            "a third exclusion would need its own review against the payment side"
        );
        // And the payment aggregate must keep counting only completed rows —
        // the other side of the same argument.
        let zreport_src = include_str!("zreport.rs");
        assert!(
            zreport_src.contains("AND op.status = 'completed'"),
            "the payment aggregate must count only completed rows"
        );
    }

    #[test]
    fn test_a_legitimate_refund_is_not_a_financial_integrity_gap() {
        // Review item C (founder, 16/09/2026): «order fully paid -> refund
        // €0,70 -> otherwise completely healthy day». A normal refund must not
        // be presented as a financial-integrity gap.
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-refund-070', 'R-070', '[]', 12.00, 1200, 'completed', 'takeaway',
                         'paid', ?1, 'pos', 'pending',
                         '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                    staff_shift_id, sync_status, created_at, updated_at)
                 VALUES ('pay-refund-070', 'ord-refund-070', 'card', 12.00, 1200, 'completed', ?1,
                         'pending', '2026-02-16T12:05:00Z', '2026-02-16T12:05:00Z')",
                params![shift_id],
            )
            .unwrap();
            // The €0,70 refund, as a payment adjustment — the normal shape.
            conn.execute(
                "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type,
                    amount, amount_cents, reason, sync_state, created_at, updated_at)
                 VALUES ('adj-070', 'pay-refund-070', 'ord-refund-070', 'refund', 0.70, 70,
                         'wrong side order', 'pending',
                         '2026-02-16T12:30:00Z', '2026-02-16T12:30:00Z')",
                [],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let integrity = &result["report"]["reportJson"]["integrity"];

        // The day is healthy: no finding, nothing unexplained, not red.
        assert_eq!(integrity["reconciled"], true);
        assert_eq!(integrity["blockingFindings"], 0);
        assert_eq!(integrity["unexplainedDifference"], 0.0);
        assert_eq!(
            integrity["findings"].as_array().map(Vec::len),
            Some(0),
            "a refund is not a payment-integrity finding: {:?}",
            integrity["findings"]
        );

        // The refund itself is still reported — on the refunds line, where it
        // belongs — so nothing is hidden. €10,00 is `seed_closed_shift`'s own
        // refund adjustment; €0,70 is this fixture's.
        assert_eq!(result["report"]["refundsTotal"], 10.70);
    }

    #[test]
    fn test_a_refunded_order_is_explained_not_reported_as_missing_money() {
        // The other refund shape: the ORDER's status becomes 'refunded'. Such
        // an order stays in turnover (gross) but is excluded from the payment
        // side on purpose, which used to leave a non-zero difference painted
        // red with no finding behind it.
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-fully-refunded', 'FR-1', '[]', 15.00, 1500, 'refunded', 'takeaway',
                         'refunded', ?1, 'pos', 'pending',
                         '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let integrity = &result["report"]["reportJson"]["integrity"];

        // The raw arithmetic still shows the €15 …
        assert_eq!(integrity["difference"], 15.0);
        // … but it is ACCOUNTED FOR, not a gap.
        assert_eq!(integrity["explainedDifference"], 15.0);
        assert_eq!(integrity["unexplainedDifference"], 0.0);
        assert_eq!(integrity["refundedOrders"]["orders"], 1);
        assert_eq!(integrity["refundedOrders"]["amount"], 15.0);
        assert_eq!(integrity["reconciled"], true);
        assert_eq!(integrity["blockingFindings"], 0);
    }

    #[test]
    fn test_a_real_missing_payment_is_still_unexplained_and_blocking() {
        // The guard rail on the two tests above: explaining refunds must not
        // become a way to excuse a genuine gap.
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            // One legitimately refunded order …
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-refunded', 'FR-2', '[]', 15.00, 1500, 'refunded', 'takeaway',
                         'refunded', ?1, 'pos', 'pending',
                         '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
            // … and one genuinely missing payment.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-really-missing', 'RM-1', '[]', 9.40, 940, 'completed', 'takeaway',
                         'paid', ?1, 'pos', 'pending',
                         '2026-02-16T13:00:00Z', '2026-02-16T13:00:00Z')",
                params![shift_id],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let integrity = &result["report"]["reportJson"]["integrity"];

        assert_eq!(integrity["explainedDifference"], 15.0);
        // The refund is explained; the missing EUR 9,40 is NOT.
        assert_eq!(integrity["unexplainedDifference"], 9.40);
        assert_eq!(integrity["reconciled"], false);
        assert_eq!(integrity["blockingFindings"], 1);
        assert_eq!(integrity["findings"][0]["orderId"], "ord-really-missing");
    }

    #[test]
    fn test_z_report_names_a_paid_order_with_no_payment_and_refuses_to_close() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            // Covered order — the day is not empty.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-ok', 'OK-1', '[]', 20.0, 2000, 'completed', 'takeaway', 'paid', ?1,
                         'pos', 'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                    staff_shift_id, sync_status, created_at, updated_at)
                 VALUES ('pay-ok', 'ord-ok', 'cash', 20.0, 2000, 'completed', ?1, 'pending',
                         '2026-02-16T12:05:00Z', '2026-02-16T12:05:00Z')",
                params![shift_id],
            )
            .unwrap();
            // The incident shape: paid on the order row, absent from the ledger.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-ghost-paid', 'GP-1', '[]', 10.43, 1043, 'completed', 'takeaway',
                         'paid', ?1, 'pos', 'pending', '2026-02-16T12:30:00Z', '2026-02-16T12:30:00Z')",
                params![shift_id],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let integrity = &result["report"]["reportJson"]["integrity"];

        assert_eq!(integrity["reconciled"], false);
        assert_eq!(integrity["blockingFindings"], 1);
        assert_eq!(integrity["uncoveredAmount"], 10.43);
        // Order side counts it, payment side does not — exactly the shape of
        // the EUR 531,13 gap, now stated on the report instead of hidden
        // inside it. (EUR 100.00 of that turnover is the shared fixture's own
        // fully covered orders.)
        assert_eq!(integrity["orderTurnover"], 130.43);
        assert_eq!(integrity["paymentCoverage"], 120.0);
        assert_eq!(integrity["difference"], 10.43);

        let findings = integrity["findings"].as_array().expect("findings");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0]["orderId"], "ord-ghost-paid");
        assert_eq!(findings[0]["reasonCode"], "missing_local_payment_row");
        assert_eq!(findings[0]["severity"], "blocking");

        // And the day must not close over it.
        let blockers = unsettled_payment_blockers(&db, &payload).expect("closeout blockers");
        assert!(
            blockers.iter().any(|b| b.order_id == "ord-ghost-paid"),
            "the closeout gate must see the same order the report names"
        );
        assert!(
            unsettled_payment_blocker_message(&blockers).is_some(),
            "a real inconsistency must produce an operator-facing blocker"
        );
    }

    #[test]
    fn test_z_report_turnover_excludes_orders_an_earlier_z_already_closed() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        {
            let conn = db.conn.lock().unwrap();
            // Mark a Z as already run — this is what makes the rollover's
            // payment-row deletion legitimate history.
            crate::db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-16T04:00:00Z",
            )
            .unwrap();
            // Today's real order.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-today', 'T-1', '[]', 20.0, 2000, 'completed', 'takeaway', 'paid', ?1,
                         'pos', 'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
                params![shift_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                    staff_shift_id, sync_status, created_at, updated_at)
                 VALUES ('pay-today', 'ord-today', 'cash', 20.0, 2000, 'completed', ?1, 'pending',
                         '2026-02-16T12:05:00Z', '2026-02-16T12:05:00Z')",
                params![shift_id],
            )
            .unwrap();
            // A paid order from the CLOSED day whose payment rows the
            // rollover deleted, with `updated_at` dragged back into the open
            // window by a routine remote-snapshot refresh. This is the shape
            // that inflated turnover while staying exempt from the gate.
            conn.execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                    created_at, updated_at)
                 VALUES ('ord-yesterday', 'Y-1', '[]', 31.13, 3113, 'completed', 'takeaway', 'paid',
                         ?1, 'pos', 'pending', '2026-02-15T20:00:00Z', '2026-02-16T12:40:00Z')",
                params![shift_id],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let report = &result["report"]["reportJson"];
        let integrity = &report["integrity"];

        // Turnover and coverage now describe ONE population…
        // (EUR 100.00 of both is the shared fixture's own covered orders.)
        assert_eq!(integrity["orderTurnover"], 120.0);
        assert_eq!(integrity["paymentCoverage"], 120.0);
        assert_eq!(integrity["reconciled"], true);
        // …and the held-back order is reported rather than silently dropped.
        assert_eq!(integrity["carriedOverFromClosedDays"]["orders"], 1);
        assert_eq!(integrity["carriedOverFromClosedDays"]["amount"], 31.13);
        assert!(
            !report["dayOrders"]
                .as_array()
                .expect("dayOrders")
                .iter()
                .any(|order| order["id"] == "ord-yesterday"),
            "a closed day's order must not be listed in the open day"
        );
    }
    /// A 20.00 cash order paid once, plus a second 20.00 card taken on it
    /// after it was already paid and set aside (B1, fix review 30/09/2026).
    fn seed_order_with_set_aside_payment(db: &DbState, shift_id: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                status, order_type, payment_status, staff_shift_id, plugin, sync_status,
                created_at, updated_at)
             VALUES ('ord-dup', 'D-1', '[]', 20.0, 2000, 'completed', 'takeaway', 'paid', ?1,
                     'pos', 'pending', '2026-02-16T12:00:00Z', '2026-02-16T12:00:00Z')",
            params![shift_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                staff_shift_id, sync_status, created_at, updated_at)
             VALUES ('pay-dup-cash', 'ord-dup', 'cash', 20.0, 2000, 'completed', ?1, 'pending',
                     '2026-02-16T12:05:00Z', '2026-02-16T12:05:00Z')",
            params![shift_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                staff_shift_id, sync_status, created_at, updated_at)
             VALUES ('pay-dup-card', 'ord-dup', 'card', 20.0, 2000, 'completed', ?1, 'pending',
                     '2026-02-16T12:06:00Z', '2026-02-16T12:06:00Z')",
            params![shift_id],
        )
        .unwrap();
        crate::payment_review::set_aside_already_paid_payment(
            &conn,
            "pay-dup-card",
            Some("srv-cash"),
            "2026-02-16T12:07:00Z",
        )
        .unwrap();
    }

    #[test]
    fn the_z_lists_a_set_aside_payment_with_no_difference_and_counts_it_nowhere() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        seed_order_with_set_aside_payment(&db, &shift_id);

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let report = &result["report"]["reportJson"];
        let integrity = &report["integrity"];

        // The shared fixture's 100.00 plus the 20.00 order, paid once.
        assert_eq!(integrity["orderTurnover"], 120.0);
        assert_eq!(
            integrity["paymentCoverage"], 120.0,
            "the set-aside card is not money"
        );
        assert_eq!(report["daySummary"]["total"], 120.0);
        assert_eq!(
            integrity["excessAmount"], 0.0,
            "and not an overpayment either"
        );
        assert_eq!(integrity["reconciled"], false, "the day needs a decision");
        let findings = integrity["findings"].as_array().expect("findings");
        let review: Vec<&serde_json::Value> = findings
            .iter()
            .filter(|finding| finding["reasonCode"] == "payments_need_review")
            .collect();
        assert_eq!(review.len(), 1);
        assert_eq!(review[0]["differenceCents"], 0);
        assert_eq!(review[0]["orderNumber"], "D-1");
        assert_eq!(review[0]["reviewPayment"]["paymentId"], "pay-dup-card");
        assert_eq!(review[0]["reviewPayment"]["method"], "card");
        assert_eq!(
            review[0]["reviewPayment"]["takenAt"],
            "2026-02-16T12:06:00Z"
        );
    }

    #[test]
    fn the_day_rollover_refuses_while_a_set_aside_payment_is_unresolved() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        seed_order_with_set_aside_payment(&db, &shift_id);

        let refused = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect_err("the cleanup never deletes the only record of money to give back");
        assert!(refused.contains("payments_need_review"), "{refused}");
        {
            let conn = db.conn.lock().unwrap();
            let kept: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM order_payments WHERE id = 'pay-dup-card'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(kept, 1, "rolled back whole");
            assert!(
                crate::business_day::stored_period_start(&conn).is_none(),
                "the day did not close"
            );
            crate::payment_review::resolve_set_aside_payment_in_connection(
                &conn,
                "pay-dup-card",
                Some("staff-1"),
                "2026-02-16T22:00:00Z",
            )
            .unwrap();
        }

        let cleared = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("once resolved, the day closes");
        assert_eq!(cleared["order_payments"], 5);
    }

    /// A card charged on this till whose payment could not be saved holds the
    /// day close: the cleanup never deletes the order its record replays onto
    /// (fix review 30/09/2026, Android `finalizeEndOfDay`).
    #[test]
    fn the_day_rollover_refuses_while_a_charged_payment_is_not_saved() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        seed_order_with_set_aside_payment(&db, &shift_id);
        {
            let conn = db.conn.lock().unwrap();
            crate::payment_review::resolve_set_aside_payment_in_connection(
                &conn,
                "pay-dup-card",
                Some("staff-1"),
                "2026-02-16T22:00:00Z",
            )
            .unwrap();
            let entry = crate::unsaved_payments::UnsavedChargedPayment::for_payment(
                "ord-dup",
                &serde_json::json!({
                    "orderId": "ord-dup",
                    "method": "card",
                    "amount": 4.0,
                    "transactionRef": "txn-not-saved",
                    "terminalApproved": true,
                }),
                None,
                "2026-02-16T12:30:00Z",
            )
            .unwrap();
            crate::unsaved_payments::record(&conn, &entry).unwrap();
        }

        let refused = apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect_err("the record is the only trace of money the customer paid");
        assert!(refused.contains("payments_not_saved"), "{refused}");
        {
            let conn = db.conn.lock().unwrap();
            let orders: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM orders WHERE id = 'ord-dup'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(orders, 1, "rolled back whole");
            assert_eq!(
                crate::unsaved_payments::resolve_in_connection(
                    &conn,
                    "terminal-card:txn-not-saved",
                    Some("staff-1"),
                    "2026-02-16T22:30:00Z",
                )
                .unwrap()
                .as_str(),
                "resolved"
            );
        }

        apply_local_day_rollover(&db, "2026-02-16", "2026-02-16T23:59:59Z")
            .expect("once resolved, the day closes");
    }

    /// The card was set aside on another cashier's shift. It is money
    /// nowhere, so that shift's section neither lists the order nor counts
    /// its total: the order stays with the shift that sold it.
    #[test]
    fn a_set_aside_payment_never_puts_the_order_in_the_section_of_the_shift_that_took_it() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);
        seed_order_with_set_aside_payment(&db, &shift_id);
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, branch_id, terminal_id, role_type,
                    opening_cash_amount, opening_cash_amount_cents,
                    check_in_time, check_out_time, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'shift-zr-2', 'staff-2', 'Second cashier', 'branch-1', 'term-1', 'cashier',
                    0.0, 0,
                    '2026-02-16T10:00:00Z', '2026-02-16T17:00:00Z', 'closed', 2,
                    'pending', '2026-02-16T17:00:00Z', '2026-02-16T17:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE order_payments SET staff_shift_id = 'shift-zr-2' WHERE id = 'pay-dup-card'",
                [],
            )
            .unwrap();
        }

        let payload = serde_json::json!({ "branchId": "branch-1", "date": "2026-02-16" });
        let result = generate_z_report_for_date(&db, &payload).expect("generate");
        let staff_reports = result["report"]["reportJson"]["staffReports"]
            .as_array()
            .expect("staffReports");
        let section = |shift: &str| {
            staff_reports
                .iter()
                .find(|report| report["staffShiftId"] == shift)
                .unwrap_or_else(|| panic!("a section for {shift}: {staff_reports:?}"))
        };
        let second = section("shift-zr-2");
        assert_eq!(second["orders"]["count"], 0, "{second}");
        assert_eq!(second["orders"]["totalAmount"], 0.0);
        assert_eq!(second["ordersDetails"].as_array().map(Vec::len), Some(0));
        let first = section(&shift_id);
        assert_eq!(
            first["orders"]["count"], 4,
            "the order stays with the shift that sold it"
        );
    }
}

/// Field incident 29/09/2026 (Le Petit Paris): the Z was held by fiscal rows
/// of a store with no fiscal plugin, through a guard that checked today's
/// UTC date and answered in English. On the desktop that guard only ran in a
/// command the renderer never calls. These pin the window the guard checks,
/// the inactive bypass, the typed refusal and the support evidence.
#[cfg(test)]
mod fiscal_closeout_tests {
    use super::*;
    use crate::fiscal::active_cache;
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

    fn seed_fiscal(conn: &Connection, id: &str, branch_id: &str, created_at: &str, status: &str) {
        conn.execute(
            "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id, created_at,
                 attempts, status, error_message, module_type, conflict_strategy
             ) VALUES (?1, 'fiscal_submission', ?2, 'INSERT', ?3, 'org-1', ?4,
                 3, ?5, 'HTTP_400_CLIENT_ERROR: Invalid FiscalReceiptInput', 'fiscal', 'last-write-wins')",
            params![
                id,
                format!("order-{id}"),
                serde_json::json!({
                    "branchId": branch_id,
                    "orderId": format!("order-{id}"),
                    "receiptNumber": format!("R-{id}"),
                })
                .to_string(),
                created_at,
                status
            ],
        )
        .expect("seed fiscal row");
    }

    /// The previous Z closed the 28/09 business day at 29/09 05:00Z.
    fn close_previous_day(conn: &Connection) {
        db::set_setting(
            conn,
            "system",
            "last_z_report_timestamp",
            "2026-09-29T05:00:00+00:00",
        )
        .expect("store previous cutoff");
    }

    #[test]
    #[serial_test::serial]
    fn the_z_submission_is_held_by_its_own_windows_fiscal_receipts_only() {
        active_cache::reset_for_tests();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            close_previous_day(&conn);
            // The day's own receipts (one after midnight UTC).
            seed_fiscal(
                &conn,
                "in-1",
                "branch-lpp",
                "2026-09-29T11:50:03.140276+00:00",
                "pending",
            );
            seed_fiscal(
                &conn,
                "in-2",
                "branch-lpp",
                "2026-09-30T01:15:00Z",
                "failed",
            );
            // Receipts of the day the previous Z already closed, and another
            // branch's receipt: neither belongs to this Z.
            seed_fiscal(
                &conn,
                "before",
                "branch-lpp",
                "2026-09-28T20:00:00Z",
                "pending",
            );
            seed_fiscal(
                &conn,
                "other",
                "branch-other",
                "2026-09-29T12:00:00Z",
                "pending",
            );
        }
        let payload = serde_json::json!({ "branchId": "branch-lpp" });

        let response = fiscal_close_blocked_response(&db, &payload)
            .expect("guard runs")
            .expect("the window's receipts hold the Z");
        assert_eq!(response["errorCode"], "FISCAL_CLOSE_BLOCKED");
        assert_eq!(response["count"], 2);
        assert_eq!(response["periodStartAt"], "2026-09-29T05:00:00+00:00");
        assert_eq!(response["activeVerdict"], "unknown", "unknown fails closed");
        assert_eq!(response["fiscalRows"].as_array().map(Vec::len), Some(2));
        assert!(
            response["businessDay"]
                .as_str()
                .is_some_and(|day| day.len() == 10),
            "the refusal names the report's business day: {response}"
        );

        // The preview shows the same blocker before the cashier confirms.
        let preview = fiscal_queue_blockers_for_closeout(&db, &payload).expect("preview blockers");
        assert!(preview.blocking);
        assert_eq!(preview.count, 2);

        // A branch the server reports as fiscally inactive closes; the rows
        // stay queued (nothing deleted client-side).
        active_cache::update("branch-lpp", false);
        assert_eq!(fiscal_close_blocked_response(&db, &payload).unwrap(), None);
        let preview = fiscal_queue_blockers_for_closeout(&db, &payload).expect("preview blockers");
        assert!(!preview.blocking);
        assert_eq!(preview.count, 2, "the evidence is still reported");
        let queued: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE module_type = 'fiscal'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 4);
        active_cache::reset_for_tests();
    }

    #[test]
    #[serial_test::serial]
    fn a_terminal_without_a_branch_is_not_held_by_rows_it_cannot_match() {
        active_cache::reset_for_tests();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_fiscal(
                &conn,
                "orphan",
                "branch-lpp",
                "2026-09-29T11:50:00Z",
                "pending",
            );
        }
        // No branch in the payload and no terminal credential in tests.
        let payload = serde_json::json!({ "branchId": "" });
        if resolve_closeout_branch_id(&payload).trim().is_empty() {
            assert_eq!(fiscal_close_blocked_response(&db, &payload).unwrap(), None);
        }
    }

    #[test]
    fn the_last_closeout_attempt_keeps_the_typed_code_and_bounded_text() {
        let at = "2026-09-29T16:38:14Z";
        let blocked = zreport_attempt(
            "fiscal_guard",
            Ok(serde_json::json!({
                "success": false,
                "errorCode": "FISCAL_CLOSE_BLOCKED",
                "message": "Cannot close day: 2 fiscal receipt(s) of 2026-09-29 have not been sent to the tax authority yet.",
            })),
            at,
        );
        assert_eq!(blocked.code, "FISCAL_CLOSE_BLOCKED");
        assert_eq!(blocked.stage, "fiscal_guard");
        assert!(blocked
            .message
            .as_deref()
            .is_some_and(|m| m.contains("2026-09-29")));

        let submitted = zreport_attempt(
            "submitted",
            Ok(serde_json::json!({ "success": true, "localDayClosed": true })),
            at,
        );
        assert_eq!(
            (submitted.code.as_str(), submitted.message),
            ("SUBMITTED", None)
        );

        let failed = zreport_attempt(
            "pre_z_sync",
            Err("Cannot close day: pre-Z-report sync failed: PARITY_SYNC_PARTIAL".to_string()),
            at,
        );
        assert_eq!(failed.code, "ERROR");
        assert_eq!(failed.stage, "pre_z_sync");

        let unlabelled = zreport_attempt(
            "sync_blocked",
            Ok(serde_json::json!({ "success": false })),
            at,
        );
        assert_eq!(unlabelled.code, "BLOCKED");
    }

    fn zreport_attempt(stage: &str, result: Result<Value, String>, at: &str) -> CloseoutAttempt {
        closeout_attempt_from_result(stage, &result, at)
    }

    #[test]
    #[serial_test::serial]
    fn closeout_readiness_carries_the_fiscal_evidence_and_the_last_attempt() {
        active_cache::reset_for_tests();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            close_previous_day(&conn);
            seed_fiscal(
                &conn,
                "in-1",
                "branch-lpp",
                "2026-09-29T11:50:03Z",
                "pending",
            );
            seed_fiscal(&conn, "old", "branch-lpp", "2026-09-27T11:00:00Z", "failed");
        }
        let payload = serde_json::json!({ "branchId": "branch-lpp" });

        let before = get_closeout_readiness_snapshot(&db, &payload).expect("readiness");
        assert_eq!(before["lastCloseoutAttempt"]["status"], "not_collected");
        let fiscal = &before["fiscalQueueBlockers"];
        assert_eq!(fiscal["count"], 2, "every queued fiscal row of the branch");
        assert_eq!(fiscal["forReportDate"], 1, "the rows the guard counts");
        assert_eq!(fiscal["activeVerdict"], "unknown");
        assert_eq!(fiscal["wouldBlockClose"], true);
        assert_eq!(fiscal["rows"][0]["attempts"], 3);
        assert_eq!(
            fiscal["rows"][0]["maxRetries"],
            crate::sync_queue::MAX_RETRY_ATTEMPTS
        );
        assert!(fiscal["rows"][0].get("data").is_none(), "never the payload");

        {
            let conn = db.conn.lock().unwrap();
            record_last_closeout_attempt(
                &conn,
                &CloseoutAttempt {
                    at: "2026-09-29T16:38:14Z".to_string(),
                    stage: "fiscal_guard".to_string(),
                    code: "FISCAL_CLOSE_BLOCKED".to_string(),
                    message: Some("Cannot close day: 1 fiscal receipt(s)".to_string()),
                },
            )
            .expect("record attempt");
        }
        let after = get_closeout_readiness_snapshot(&db, &payload).expect("readiness");
        assert_eq!(after["lastCloseoutAttempt"]["code"], "FISCAL_CLOSE_BLOCKED");
        assert_eq!(after["lastCloseoutAttempt"]["stage"], "fiscal_guard");
        assert_eq!(after["lastCloseoutAttempt"]["at"], "2026-09-29T16:38:14Z");
        active_cache::reset_for_tests();
    }
}

/// Release 1.4.124 (06/10/2026): a Z never erases money that has not reached
/// the server, and the day close keeps recent print evidence.
#[cfg(test)]
mod money_closeout_tests {
    use super::*;
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
        crate::sync_queue::create_tables(&conn).expect("parity queue");
        // The closeout gate resolves the branch through the credential
        // store; never the real keyring of this machine.
        db::set_setting(&conn, "terminal", "__ignore_keyring", "1").expect("hermetic keyring");
        DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn hours_ago(hours: i64) -> String {
        (Utc::now() - chrono::Duration::hours(hours)).to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    /// The 06/10/2026 incident shape: a card payment, then a manual
    /// cancellation's refund of it whose sync is still queued.
    fn seed_cancelled_order_with_queued_refund(conn: &Connection) -> String {
        let at = hours_ago(2);
        conn.execute(
            "INSERT INTO orders (id, supabase_id, order_number, items, total_amount,
                                 total_amount_cents, status, payment_status, sync_status,
                                 created_at, updated_at)
             VALUES ('order-refunded', '33333333-3333-4333-8333-333333333333', 'A-17', '[]',
                     6.5, 650, 'cancelled', 'pending', 'synced', ?1, ?1)",
            params![at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, currency,
                                         status, sync_status, sync_state, remote_payment_id,
                                         created_at, updated_at)
             VALUES ('pay-refunded', 'order-refunded', 'card', 6.5, 650, 'EUR', 'refunded',
                     'synced', 'applied', '44444444-4444-4444-8444-444444444444', ?1, ?1)",
            params![at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount,
                                              reason, sync_state, refund_method,
                                              created_at, updated_at)
             VALUES ('adj-refund', 'pay-refunded', 'order-refunded', 'refund', 6.5,
                     'Customer cancelled', 'pending', 'card', ?1, ?1)",
            params![at],
        )
        .unwrap();
        crate::sync_queue::enqueue_payload_item(
            conn,
            "payment_adjustments",
            "adj-refund",
            "INSERT",
            &serde_json::json!({
                "adjustmentId": "adj-refund",
                "paymentId": "pay-refunded",
                "orderId": "33333333-3333-4333-8333-333333333333",
                "clientOrderId": "order-refunded",
                "adjustmentType": "refund",
                "amount": 6.5,
                "reason": "Customer cancelled",
                "refundMethod": "card"
            }),
            Some(1),
            Some("financial"),
            Some("manual"),
            Some(1),
        )
        .unwrap()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// A refund queued at 01:36 and its payment were deleted by the 01:38 Z
    /// while the refund was unsent. The rollover now refuses, and every
    /// record stays.
    #[test]
    fn the_rollover_never_deletes_a_payment_or_refund_still_waiting_to_sync() {
        let db = test_db();
        let queue_id = {
            let conn = db.conn.lock().unwrap();
            seed_cancelled_order_with_queued_refund(&conn)
        };
        let now = Utc::now().to_rfc3339();
        let error = apply_local_day_rollover(&db, "2026-10-06", &now)
            .expect_err("the close refuses while the refund is unsent");
        assert!(error.contains(MONEY_NOT_SYNCED_REASON), "{error}");
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(
                count(
                    &conn,
                    "SELECT COUNT(*) FROM orders WHERE id = 'order-refunded'"
                ),
                1
            );
            assert_eq!(
                count(
                    &conn,
                    "SELECT COUNT(*) FROM order_payments WHERE id = 'pay-refunded'"
                ),
                1
            );
            assert_eq!(
                count(
                    &conn,
                    "SELECT COUNT(*) FROM payment_adjustments WHERE id = 'adj-refund'"
                ),
                1
            );
            // Once the refund reached the server, the day closes as before.
            conn.execute(
                "DELETE FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
            )
            .unwrap();
        }
        apply_local_day_rollover(&db, "2026-10-06", &Utc::now().to_rfc3339())
            .expect("the close proceeds once the money is synced");
        let conn = db.conn.lock().unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM payment_adjustments"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_payments"), 0);
    }

    /// The pre-Z sync gate names unsent money of the window as a blocker
    /// before anything is generated, in the operator's terms.
    #[test]
    fn the_pre_z_gate_refuses_while_money_of_the_window_is_unsent() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            seed_cancelled_order_with_queued_refund(&conn);
        }
        let snapshot = crate::sync::capture_unsynced_sync_queue_snapshot(&db).unwrap();
        assert_eq!(snapshot.count, 1, "{snapshot:?}");
        assert_eq!(
            snapshot.blockers_summary,
            "money_not_synced:payment_adjustment:pending x1"
        );
        let detail = &snapshot.blocker_details[0];
        assert_eq!(detail.blocker_reason, MONEY_NOT_SYNCED_REASON);
        assert_eq!(detail.entity_type, "payment_adjustment");
        assert_eq!(detail.adjustment_id.as_deref(), Some("adj-refund"));
        assert_eq!(detail.order_number.as_deref(), Some("A-17"));
        let blocked =
            crate::sync::build_sync_closeout_blocked_response_for_stage(&db, "pre-Z-report sync")
                .unwrap()
                .expect("the close is refused");
        assert_eq!(blocked["errorCode"], "SYNC_CLOSEOUT_BLOCKED");
        assert_eq!(
            blocked["syncBlockerDetails"][0]["blockerReason"],
            "money_not_synced"
        );
    }

    /// Only money whose record this Z closes holds it: a record of the next
    /// period is outside the window, and a row whose record is already gone
    /// is the queue's own failure or conflict to show.
    #[test]
    fn the_gate_reads_only_the_money_of_the_closing_window() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let cutoff = hours_ago(1);
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status,
                                 payment_status, sync_status, created_at, updated_at)
             VALUES ('order-later', '[]', 5.0, 500, 'completed', 'paid', 'pending', ?1, ?1)",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                                         sync_status, sync_state, created_at, updated_at)
             VALUES ('pay-later', 'order-later', 'cash', 5.0, 500, 'completed', 'pending',
                     'pending', ?1, ?1)",
            params![now],
        )
        .unwrap();
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "payments",
            "pay-later",
            "INSERT",
            &serde_json::json!({ "paymentId": "pay-later", "orderId": "order-later", "amount": 5.0 }),
            Some(1),
            Some("payment"),
            Some("manual"),
            Some(1),
        )
        .unwrap();
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "payment_adjustments",
            "adj-record-gone",
            "INSERT",
            &serde_json::json!({ "paymentId": "pay-gone", "amount": 1.0 }),
            Some(1),
            Some("financial"),
            Some("manual"),
            Some(1),
        )
        .unwrap();
        assert_eq!(
            load_unsynced_money_for_cutoff(&conn, &cutoff).unwrap(),
            Vec::new(),
            "a payment after the cutoff and a row without its record do not hold this Z"
        );
        let later = load_unsynced_money_for_cutoff(&conn, &Utc::now().to_rfc3339()).unwrap();
        assert_eq!(later.len(), 1, "{later:?}");
        assert_eq!(later[0].record_id, "pay-later");
        assert_eq!(later[0].order_id.as_deref(), Some("order-later"));
    }

    fn seed_job(conn: &Connection, id: &str, status: &str, created_at: &str) {
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES (?1, 'order_receipt', ?1, ?2, ?3, ?3)",
            params![id, status, created_at],
        )
        .expect("insert print job");
    }

    fn seed_attempt(conn: &Connection, id: &str, job_id: &str, state: &str, at: &str) {
        conn.execute(
            "INSERT INTO print_job_attempts
             (id, print_job_id, attempt_number, transport, resolved_target, document_name,
              state, bytes_requested, bytes_written, started_at, last_seen_at)
             VALUES (?1, ?2, 1, 'raw_tcp', 'host:12:192.168.1.19:9100', 'receipt', ?3,
                     100, 100, ?4, ?4)",
            params![id, job_id, state, at],
        )
        .expect("insert print attempt");
    }

    /// Each Z deleted the closed day's finished print jobs and attempts, so a
    /// support export the next morning had no print evidence at all. The
    /// recent finished ones now stay with their attempts (7 days, at most
    /// 1,000, as Android); older ones and pending jobs still go.
    #[test]
    fn the_day_close_keeps_recent_print_evidence() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            let recent = hours_ago(3);
            let old = (Utc::now() - chrono::Duration::days(9)).to_rfc3339();
            seed_job(&conn, "pj-printed-today", "printed", &recent);
            seed_attempt(
                &conn,
                "pa-printed-today",
                "pj-printed-today",
                "sent",
                &recent,
            );
            seed_job(&conn, "pj-failed-today", "failed", &recent);
            seed_attempt(
                &conn,
                "pa-failed-today",
                "pj-failed-today",
                "transport_error",
                &recent,
            );
            seed_job(&conn, "pj-cancelled-today", "cancelled", &recent);
            seed_job(&conn, "pj-pending-today", "pending", &recent);
            seed_job(&conn, "pj-printed-old", "printed", &old);
            seed_attempt(&conn, "pa-printed-old", "pj-printed-old", "sent", &old);
        }

        let result = apply_local_day_rollover(&db, "2026-10-06", &Utc::now().to_rfc3339())
            .expect("rollover");

        let conn = db.conn.lock().unwrap();
        let ids = |sql: &str| -> Vec<String> {
            conn.prepare(sql)
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            ids("SELECT id FROM print_jobs ORDER BY id"),
            vec!["pj-cancelled-today", "pj-failed-today", "pj-printed-today"]
        );
        assert_eq!(
            ids("SELECT id FROM print_job_attempts ORDER BY id"),
            vec!["pa-failed-today", "pa-printed-today"]
        );
        assert_eq!(result["print_jobs_kept_evidence"], 3);
        assert_eq!(result["print_jobs_kept_live"], 0);
        assert_eq!(
            result["print_jobs"], 2,
            "the old finished job and the pending one"
        );
    }

    /// At most 1,000 finished jobs stay: the oldest beyond that goes.
    #[test]
    fn the_print_evidence_kept_at_day_close_is_bounded() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            for index in 0..(PRINT_EVIDENCE_MAX_JOBS + 2) {
                let at = (Utc::now() - chrono::Duration::minutes(index + 1))
                    .to_rfc3339_opts(SecondsFormat::Millis, true);
                seed_job(&conn, &format!("pj-{index:05}"), "printed", &at);
            }
        }
        let result = apply_local_day_rollover(&db, "2026-10-06", &Utc::now().to_rfc3339())
            .expect("rollover");
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM print_jobs"),
            PRINT_EVIDENCE_MAX_JOBS
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM print_jobs WHERE id IN ('pj-01000', 'pj-01001')"
            ),
            0,
            "the two oldest go"
        );
        assert_eq!(result["print_jobs_kept_evidence"], PRINT_EVIDENCE_MAX_JOBS);
    }
}
