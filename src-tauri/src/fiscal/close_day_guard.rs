//! Z-report close-day guard for fiscalization.
//!
//! Implements Task 23 of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Req 4.7, Req 4.7a, Req 4.7b.
//!
//! Z-report close MUST refuse to complete while a fiscal submission for
//! the business day is still queued UNDER A CURRENTLY ACTIVE PLUGIN. Rows of
//! a branch whose plugin is no longer active are NOT blocking — the server
//! answers them `skipped` — so the cashier can close the till.
//!
//! ## Field incident 29/09/2026 (Le Petit Paris, Android POS 1.0.12)
//!
//! A store without a fiscal plugin could not close its day over two queued
//! fiscal rows. On the desktop the same gaps existed:
//!
//! - the "inactive → do not block" bypass read [`active_cache`], which no
//!   production code wrote (now fed by [`super::status`]);
//! - the guard counted rows created on TODAY's UTC date, not the report's
//!   business window, so a Z taken after midnight UTC (or of a frozen past
//!   window) checked the wrong rows;
//! - it answered with an English-only sentence the renderer showed verbatim;
//! - it only ran in the legacy `zreport_generate` command, which the
//!   renderer never calls; the real close (`report_submit_z_report`) had no
//!   fiscal check at all.
//!
//! The guard now counts the rows of the Z's own business window (the window
//! the submission closes: `period_start_at`, and the frozen `cutoff_at` when
//! there is one) for the branch, whatever their queue status, and blocks
//! with the typed [`FISCAL_CLOSE_BLOCKED_ERROR_CODE`] plus parameters the
//! renderer localizes. Unknown verdict: fail closed, as before.
//!
//! A queue that cannot be read also fails closed (review of the 29/09/2026
//! fixes): the probe used to answer "nothing queued" on a read error, which
//! let the day close with receipts nobody had checked. The refusal keeps the
//! same code with `reason: "fiscal_queue_unreadable"`.

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};

use super::active_cache::{self, CacheVerdict};

/// Machine code of a blocked close; the renderer localizes it
/// (`modals.zReport.fiscalCloseBlocked`), never the English fallback.
pub const FISCAL_CLOSE_BLOCKED_ERROR_CODE: &str = "FISCAL_CLOSE_BLOCKED";

/// `reason` of a close held because the window's queued receipts are unsent.
pub const FISCAL_QUEUE_NOT_EMPTY_REASON: &str = "fiscal_queue_not_empty";

/// `reason` of a close held because the fiscal queue could not be read
/// (`modals.zReport.fiscalCloseCheckFailed`).
pub const FISCAL_QUEUE_UNREADABLE_REASON: &str = "fiscal_queue_unreadable";

/// Queued rows listed with a blocker. The count is always exact.
pub const FISCAL_BLOCKER_ROW_LIMIT: i64 = 50;

/// The business window a close-day check covers: the window the next Z
/// submission closes, for one branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiscalCloseScope {
    pub branch_id: String,
    /// The report's business date (`YYYY-MM-DD`), for the message.
    pub report_date: String,
    /// Start of the window (the previous Z's cutoff, RFC 3339).
    pub period_start_at: String,
    /// The frozen end of a past window; `None` for the live window.
    pub cutoff_at: Option<String>,
    /// Whether a row created exactly at `period_start_at` belongs to it.
    pub lower_bound_inclusive: bool,
}

impl FiscalCloseScope {
    /// A whole UTC calendar day (legacy callers and tests).
    pub fn utc_day(branch_id: &str, business_day_iso: &str) -> Self {
        let day = business_day_iso.trim();
        Self {
            branch_id: branch_id.to_string(),
            report_date: day.to_string(),
            period_start_at: format!("{day}T00:00:00.000Z"),
            cutoff_at: Some(format!("{day}T23:59:59.999Z")),
            lower_bound_inclusive: true,
        }
    }
}

/// One queued fiscal submission, as the Z-report and diagnostics list it.
/// Identifiers and bounded operational text only; never the payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedFiscalRow {
    pub queue_item_id: String,
    pub order_id: String,
    pub receipt_number: Option<String>,
    pub status: String,
    pub attempts: i64,
    pub max_retries: i64,
    pub created_at: String,
    pub last_attempt: Option<String>,
    pub next_retry_at: Option<String>,
    pub last_error: Option<String>,
}

/// What the fiscal queue means for this window's Z.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FiscalQueueBlockers {
    /// Queued fiscal rows of the branch inside the window, any status.
    pub count: i64,
    /// `active` / `inactive` / `unknown` — the verdict the guard applied.
    pub active_verdict: &'static str,
    /// Whether these rows hold the Z (`count > 0` and not inactive).
    pub blocking: bool,
    pub branch_id: String,
    pub report_date: String,
    pub period_start_at: String,
    pub cutoff_at: Option<String>,
    pub rows: Vec<QueuedFiscalRow>,
}

impl FiscalQueueBlockers {
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Why the close-day path was blocked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseBlockedError {
    /// The local fiscal queue still holds rows of the window's receipts.
    FiscalQueueNotEmpty(FiscalQueueBlockers),
    /// The local fiscal queue could not be read, so nothing proves the
    /// window's receipts were sent: fail closed.
    FiscalQueueUnreadable {
        scope: FiscalCloseScope,
        /// The verdict the guard applied (`active` / `unknown`).
        active_verdict: &'static str,
        /// Bounded, sanitized read error, for support.
        error: String,
    },
}

impl CloseBlockedError {
    /// The typed response a blocked Z submission answers with. `error` /
    /// `message` are only an English last resort; the renderer reads
    /// `errorCode` + `reason` + `count` + `businessDay`.
    pub fn to_response(&self) -> Value {
        match self {
            Self::FiscalQueueNotEmpty(blockers) => {
                let message = format!(
                    "Cannot close day: {} fiscal receipt(s) of {} have not been sent to the tax authority yet.",
                    blockers.count, blockers.report_date
                );
                json!({
                    "success": false,
                    "errorCode": FISCAL_CLOSE_BLOCKED_ERROR_CODE,
                    "code": "fiscal_close_blocked",
                    "reason": FISCAL_QUEUE_NOT_EMPTY_REASON,
                    "source": "local",
                    "count": blockers.count,
                    "branchId": blockers.branch_id,
                    "businessDay": blockers.report_date,
                    "periodStartAt": blockers.period_start_at,
                    "cutoffAt": blockers.cutoff_at,
                    "activeVerdict": blockers.active_verdict,
                    "fiscalRows": blockers.rows,
                    "error": message,
                    "message": message,
                })
            }
            Self::FiscalQueueUnreadable {
                scope,
                active_verdict,
                error,
            } => {
                let message = format!(
                    "Cannot close day: the fiscal submissions of {} could not be checked.",
                    scope.report_date
                );
                json!({
                    "success": false,
                    "errorCode": FISCAL_CLOSE_BLOCKED_ERROR_CODE,
                    "code": "fiscal_close_blocked",
                    "reason": FISCAL_QUEUE_UNREADABLE_REASON,
                    "source": "local",
                    "count": Value::Null,
                    "branchId": scope.branch_id,
                    "businessDay": scope.report_date,
                    "periodStartAt": scope.period_start_at,
                    "cutoffAt": scope.cutoff_at,
                    "activeVerdict": active_verdict,
                    "fiscalRows": [],
                    "checkError": error,
                    "error": message,
                    "message": message,
                })
            }
        }
    }
}

fn verdict_label(verdict: CacheVerdict) -> &'static str {
    match verdict {
        CacheVerdict::Active => "active",
        CacheVerdict::Inactive => "inactive",
        CacheVerdict::Unknown => "unknown",
    }
}

/// Rows of `module_type = 'fiscal'` for the branch inside the window.
///
/// Audit finding #7 (P2) fix (2026-05-25): `parity_sync_queue` has no
/// `branch_id` column, so the branch is read from the payload's `branchId`
/// (both POS payload builders emit it). Legacy rows without it — or with a
/// payload that is not JSON — produce NULL and never match, a deliberate
/// trade-off: they cannot block a close. Rows leave the queue on success,
/// so every status still present (`pending`, `processing`, `failed`,
/// `conflict`) is a receipt the server has not accepted.
const WINDOW_FILTER: &str = "module_type = 'fiscal'
   AND (CASE WHEN json_valid(data) THEN json_extract(data, '$.branchId') END) = ?1
   AND (
        (?4 = 1 AND julianday(created_at) >= julianday(?2))
        OR (?4 = 0 AND julianday(created_at) > julianday(?2))
   )
   AND (?3 IS NULL OR julianday(created_at) <= julianday(?3))";

fn count_queued_fiscal_in_window(
    conn: &Connection,
    scope: &FiscalCloseScope,
) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM parity_sync_queue WHERE {WINDOW_FILTER}"),
        params![
            scope.branch_id,
            scope.period_start_at,
            scope.cutoff_at,
            i64::from(scope.lower_bound_inclusive)
        ],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("count queued fiscal submissions: {e}"))
}

fn list_queued_fiscal_in_window(
    conn: &Connection,
    scope: &FiscalCloseScope,
    limit: i64,
) -> Result<Vec<QueuedFiscalRow>, String> {
    let sql = format!(
        "SELECT id, record_id, status, attempts, created_at, last_attempt, next_retry_at,
                error_message,
                CASE WHEN json_valid(data) THEN json_extract(data, '$.receiptNumber') END
           FROM parity_sync_queue
          WHERE {WINDOW_FILTER}
          ORDER BY created_at ASC, id ASC
          LIMIT ?5"
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare queued fiscal list: {e}"))?;
    let rows = statement
        .query_map(
            params![
                scope.branch_id,
                scope.period_start_at,
                scope.cutoff_at,
                i64::from(scope.lower_bound_inclusive),
                limit.clamp(1, 500)
            ],
            |row| {
                // A numeric receipt number reads back as INTEGER; it is only
                // a display aid, so anything but text is left out.
                let receipt_number = row
                    .get::<_, Option<String>>(8)
                    .ok()
                    .flatten()
                    .filter(|value| !value.trim().is_empty());
                Ok(QueuedFiscalRow {
                    queue_item_id: row.get(0)?,
                    order_id: row.get(1)?,
                    receipt_number,
                    status: row.get(2)?,
                    attempts: row.get(3)?,
                    max_retries: crate::sync_queue::MAX_RETRY_ATTEMPTS,
                    created_at: row.get(4)?,
                    last_attempt: row.get(5)?,
                    next_retry_at: row.get(6)?,
                    last_error: crate::print::safe_operational_error(row.get(7)?, 512),
                })
            },
        )
        .map_err(|e| format!("query queued fiscal list: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read queued fiscal row: {e}"))
}

/// The queued fiscal rows of the window and whether they hold the Z. Rows
/// are reported even for a fiscally inactive branch (support evidence), but
/// only block under an active or unknown verdict.
pub fn collect_fiscal_queue_blockers(
    conn: &Connection,
    scope: &FiscalCloseScope,
) -> Result<FiscalQueueBlockers, String> {
    let verdict = if scope.branch_id.trim().is_empty() {
        CacheVerdict::Unknown
    } else {
        active_cache::verdict(scope.branch_id.trim())
    };
    let count = count_queued_fiscal_in_window(conn, scope)?;
    let rows = if count > 0 {
        list_queued_fiscal_in_window(conn, scope, FISCAL_BLOCKER_ROW_LIMIT)?
    } else {
        Vec::new()
    };
    Ok(FiscalQueueBlockers {
        count,
        active_verdict: verdict_label(verdict),
        blocking: count > 0 && verdict != CacheVerdict::Inactive,
        branch_id: scope.branch_id.clone(),
        report_date: scope.report_date.clone(),
        period_start_at: scope.period_start_at.clone(),
        cutoff_at: scope.cutoff_at.clone(),
        rows,
    })
}

/// Support evidence for `closeout_readiness.json` → `fiscalQueueBlockers`, in
/// the shape the Android bundle uses: `count` is every queued fiscal row of
/// the branch (any day), `forReportDate` the rows the guard counts for the
/// window, `wouldBlockClose` the guard's answer, `rows` up to
/// [`FISCAL_BLOCKER_ROW_LIMIT`] of the branch's rows, oldest first.
pub fn fiscal_queue_evidence(conn: &Connection, scope: &FiscalCloseScope) -> Result<Value, String> {
    let window = collect_fiscal_queue_blockers(conn, scope)?;
    let whole_branch = FiscalCloseScope {
        branch_id: scope.branch_id.clone(),
        report_date: scope.report_date.clone(),
        period_start_at: "0001-01-01T00:00:00Z".to_string(),
        cutoff_at: None,
        lower_bound_inclusive: true,
    };
    let total = count_queued_fiscal_in_window(conn, &whole_branch)?;
    let rows = if total > 0 {
        list_queued_fiscal_in_window(conn, &whole_branch, FISCAL_BLOCKER_ROW_LIMIT)?
    } else {
        Vec::new()
    };
    Ok(json!({
        "count": total,
        "forReportDate": window.count,
        "reportDate": window.report_date,
        "periodStartAt": window.period_start_at,
        "cutoffAt": window.cutoff_at,
        "branchId": window.branch_id,
        "activeVerdict": window.active_verdict,
        "wouldBlockClose": window.blocking,
        "rows": rows,
        // Release-safety check: would the active plugin refuse the currency
        // these receipts carry (e.g. a Greek plugin and a non-EUR store)?
        "currencyCheck": super::currency::currency_check_evidence(conn, &scope.branch_id),
    }))
}

/// Refuse the close while the window's fiscal receipts are still queued
/// under an active (or unknown) plugin, or while the queue cannot be read.
/// Per Req 4.7a an inactive branch is never blocked; its rows stay queued
/// and drain as `skipped`.
pub fn ensure_no_queued_fiscal_for_window(
    conn: &Connection,
    scope: &FiscalCloseScope,
) -> Result<(), CloseBlockedError> {
    let verdict = active_cache::verdict(scope.branch_id.trim());
    if let CacheVerdict::Inactive = verdict {
        return Ok(());
    }
    // A queue that cannot be read proves nothing was sent: fail closed.
    let blockers = collect_fiscal_queue_blockers(conn, scope).map_err(|error| {
        tracing::warn!(
            error = %error,
            "[fiscal.close_day_guard] fiscal queue probe failed; the close is held"
        );
        CloseBlockedError::FiscalQueueUnreadable {
            scope: scope.clone(),
            active_verdict: verdict_label(verdict),
            error: crate::print::safe_operational_error(Some(error), 256)
                .unwrap_or_else(|| "fiscal queue unreadable".to_string()),
        }
    })?;
    if blockers.blocking {
        return Err(CloseBlockedError::FiscalQueueNotEmpty(blockers));
    }
    Ok(())
}

// =============================================================================
// Regression tests
// =============================================================================
#[cfg(test)]
mod audit_7_tests {
    use super::*;
    use crate::sync_queue;

    fn make_conn() -> Connection {
        // In-memory SQLite is per-process; create_tables exposes the real
        // production schema so this isn't a tautological test.
        let conn = Connection::open_in_memory().expect("open in-memory");
        sync_queue::create_tables(&conn).expect("create_tables");
        conn
    }

    fn insert_fiscal(conn: &Connection, branch_id: &str, created_at: &str, status: &str) -> String {
        let id = format!(
            "test-{branch_id}-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let data = serde_json::json!({
            "branchId": branch_id,
            "orderId": "test-order",
            "receiptNumber": "R-1",
        });
        conn.execute(
            "INSERT INTO parity_sync_queue
             (id, table_name, record_id, operation, data, organization_id, created_at, module_type, status)
             VALUES (?1, 'fiscal_submission', 'rec-1', 'INSERT', ?2, 'org-1', ?3, 'fiscal', ?4)",
            params![id, data.to_string(), created_at, status],
        )
        .expect("insert fiscal row");
        id
    }

    fn insert_pending_fiscal(conn: &Connection, branch_id: &str, business_day_iso: &str) -> String {
        insert_fiscal(conn, branch_id, business_day_iso, "pending")
    }

    fn day(branch_id: &str, iso: &str) -> FiscalCloseScope {
        FiscalCloseScope::utc_day(branch_id, iso)
    }

    #[test]
    #[serial_test::serial]
    fn audit_7_only_target_branch_blocks_close() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        let d = "2026-05-25";

        insert_pending_fiscal(&conn, "branch-A", d);
        insert_pending_fiscal(&conn, "branch-B", d);

        // Branch-A close should be blocked (its own row is pending).
        let result_a = ensure_no_queued_fiscal_for_window(&conn, &day("branch-A", d));
        assert!(matches!(
            result_a,
            Err(CloseBlockedError::FiscalQueueNotEmpty(
                FiscalQueueBlockers { count: 1, .. }
            ))
        ));

        // Branch-B close should ALSO be blocked (its own row is pending).
        let result_b = ensure_no_queued_fiscal_for_window(&conn, &day("branch-B", d));
        assert!(matches!(
            result_b,
            Err(CloseBlockedError::FiscalQueueNotEmpty(
                FiscalQueueBlockers { count: 1, .. }
            ))
        ));
    }

    #[test]
    #[serial_test::serial]
    fn audit_7_other_branch_pending_does_not_block_target_branch() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        let d = "2026-05-25";

        // Insert ONLY a Branch-B row. Pre-fix, Branch-A's close would still
        // have been blocked because the count ignored branch_id.
        insert_pending_fiscal(&conn, "branch-B", d);

        let result_a = ensure_no_queued_fiscal_for_window(&conn, &day("branch-A", d));
        assert!(
            result_a.is_ok(),
            "Branch-A close must succeed when only Branch-B has pending fiscal — got {result_a:?}"
        );

        // Sanity: Branch-B is still blocked by its own pending row.
        let result_b = ensure_no_queued_fiscal_for_window(&conn, &day("branch-B", d));
        assert!(matches!(
            result_b,
            Err(CloseBlockedError::FiscalQueueNotEmpty(
                FiscalQueueBlockers { count: 1, .. }
            ))
        ));
    }

    #[test]
    #[serial_test::serial]
    fn audit_7_legacy_row_without_branchid_does_not_block() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        let d = "2026-05-25";
        // Simulate a legacy row whose data JSON lacks branchId, and one whose
        // payload is not JSON at all: neither can match a branch.
        let data = serde_json::json!({ "orderId": "legacy", "receiptNumber": "R-OLD" });
        conn.execute(
            "INSERT INTO parity_sync_queue
             (id, table_name, record_id, operation, data, organization_id, created_at, module_type, status)
             VALUES ('legacy-1', 'fiscal_submission', 'rec-old', 'INSERT', ?1, 'org-1', ?2, 'fiscal', 'pending'),
                    ('garbled-1', 'fiscal_submission', 'rec-bad', 'INSERT', 'not json', 'org-1', ?2, 'fiscal', 'pending')",
            params![data.to_string(), d],
        )
        .expect("insert legacy rows");

        let result = ensure_no_queued_fiscal_for_window(&conn, &day("branch-A", d));
        assert!(
            result.is_ok(),
            "legacy rows without branchId must not block — got {result:?}"
        );
    }

    /// PR #305: a payload that is not JSON must not hide the branch's
    /// well-formed receipts. Without the json_valid guard json_extract fails
    /// the whole count on it; the guard once read that failure as "nothing
    /// queued" (unwrap_or(0)) and let branch-A close past its pending receipt.
    #[test]
    #[serial_test::serial]
    fn audit_7_payload_that_is_not_json_does_not_unblock_the_branch() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        let d = "2026-05-25";
        insert_pending_fiscal(&conn, "branch-A", d);
        // A torn or legacy payload that is not JSON.
        conn.execute(
            "INSERT INTO parity_sync_queue
             (id, table_name, record_id, operation, data, organization_id, created_at, module_type, status)
             VALUES ('torn-1', 'fiscal_submission', 'rec-torn', 'INSERT', ?1, 'org-1', ?2, 'fiscal', 'pending')",
            params![r#"{"branchId":"branch-A","receiptNumber":"#, d],
        )
        .expect("insert torn row");

        assert_eq!(
            count_queued_fiscal_in_window(&conn, &day("branch-A", d)),
            Ok(1)
        );
        let result = ensure_no_queued_fiscal_for_window(&conn, &day("branch-A", d));
        assert!(matches!(
            result,
            Err(CloseBlockedError::FiscalQueueNotEmpty(
                FiscalQueueBlockers { count: 1, .. }
            ))
        ));
    }

    #[test]
    #[serial_test::serial]
    fn audit_7_different_day_does_not_block() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        insert_pending_fiscal(&conn, "branch-A", "2026-05-24");

        let result = ensure_no_queued_fiscal_for_window(&conn, &day("branch-A", "2026-05-25"));
        assert!(
            result.is_ok(),
            "yesterday's row must not block today's close — got {result:?}"
        );
    }

    /// 29/09/2026: the guard read today's UTC date. A Z of the 29/09 business
    /// day (07:00 → 07:00 local, i.e. 05:00Z → 05:00Z next day) taken after
    /// midnight UTC checked 30/09 rows and missed the day's own receipts —
    /// and would block the next day's Z on rows that belong to it. The window
    /// is the report's own.
    #[test]
    #[serial_test::serial]
    fn the_guard_checks_the_reports_business_window_not_todays_utc_date() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        // Receipts of the 29/09 business day, one after midnight UTC.
        insert_fiscal(
            &conn,
            "branch-lpp",
            "2026-09-29T11:50:03.120+00:00",
            "pending",
        );
        insert_fiscal(&conn, "branch-lpp", "2026-09-30T01:15:00Z", "failed");
        // Before the window (the previous Z's day) and after its frozen end.
        insert_fiscal(&conn, "branch-lpp", "2026-09-29T04:59:59Z", "pending");
        insert_fiscal(&conn, "branch-lpp", "2026-09-30T05:30:00Z", "pending");

        let window = FiscalCloseScope {
            branch_id: "branch-lpp".to_string(),
            report_date: "2026-09-29".to_string(),
            period_start_at: "2026-09-29T05:00:00+00:00".to_string(),
            cutoff_at: Some("2026-09-30T04:59:59.999Z".to_string()),
            lower_bound_inclusive: true,
        };
        let Err(CloseBlockedError::FiscalQueueNotEmpty(blockers)) =
            ensure_no_queued_fiscal_for_window(&conn, &window)
        else {
            panic!("the window's two receipts must block its Z");
        };
        assert_eq!(blockers.count, 2, "failed rows are unsent receipts too");
        assert_eq!(blockers.report_date, "2026-09-29");
        assert_eq!(blockers.active_verdict, "unknown");
        assert_eq!(blockers.rows.len(), 2);
        assert_eq!(blockers.rows[0].receipt_number.as_deref(), Some("R-1"));
        assert_eq!(blockers.rows[1].status, "failed");

        // The live window of the NEXT day starts where this one was cut.
        let next_day = FiscalCloseScope {
            branch_id: "branch-lpp".to_string(),
            report_date: "2026-09-30".to_string(),
            period_start_at: "2026-09-30T04:59:59.999Z".to_string(),
            cutoff_at: None,
            lower_bound_inclusive: false,
        };
        let Err(CloseBlockedError::FiscalQueueNotEmpty(next)) =
            ensure_no_queued_fiscal_for_window(&conn, &next_day)
        else {
            panic!("the next day's own receipt must block the next Z");
        };
        assert_eq!(next.count, 1);
    }

    #[test]
    #[serial_test::serial]
    fn an_inactive_branch_is_never_blocked_but_its_rows_are_still_reported() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        let d = "2026-09-29";
        insert_pending_fiscal(&conn, "branch-no-plugin", d);
        insert_fiscal(&conn, "branch-no-plugin", d, "failed");

        active_cache::update("branch-no-plugin", false);
        assert!(ensure_no_queued_fiscal_for_window(&conn, &day("branch-no-plugin", d)).is_ok());
        let evidence = collect_fiscal_queue_blockers(&conn, &day("branch-no-plugin", d)).unwrap();
        assert_eq!(evidence.count, 2);
        assert!(!evidence.blocking);
        assert_eq!(evidence.active_verdict, "inactive");

        active_cache::update("branch-no-plugin", true);
        let Err(CloseBlockedError::FiscalQueueNotEmpty(active)) =
            ensure_no_queued_fiscal_for_window(&conn, &day("branch-no-plugin", d))
        else {
            panic!("an active plugin keeps the guard");
        };
        assert_eq!(active.active_verdict, "active");
        active_cache::reset_for_tests();
    }

    /// Review of the 29/09/2026 fixes: a read error used to answer "nothing
    /// queued" and let the day close with receipts nobody had checked.
    #[test]
    #[serial_test::serial]
    fn an_unreadable_fiscal_queue_holds_the_close() {
        active_cache::reset_for_tests();
        // No parity_sync_queue table: every read of the queue fails.
        let conn = Connection::open_in_memory().expect("open in-memory");
        let scope = day("branch-A", "2026-09-29");

        let Err(blocked) = ensure_no_queued_fiscal_for_window(&conn, &scope) else {
            panic!("an unreadable queue must fail closed");
        };
        assert!(matches!(
            blocked,
            CloseBlockedError::FiscalQueueUnreadable {
                active_verdict: "unknown",
                ..
            }
        ));
        let response = blocked.to_response();
        assert_eq!(response["success"], false);
        assert_eq!(response["errorCode"], FISCAL_CLOSE_BLOCKED_ERROR_CODE);
        assert_eq!(response["reason"], FISCAL_QUEUE_UNREADABLE_REASON);
        assert_eq!(response["businessDay"], "2026-09-29");
        assert!(response["count"].is_null());
        assert!(response["checkError"]
            .as_str()
            .is_some_and(|error| !error.is_empty()));

        // An active plugin holds it too; only a fresh inactive verdict (no
        // plugin: nothing to send) lets the day close without reading.
        active_cache::update("branch-A", true);
        assert!(ensure_no_queued_fiscal_for_window(&conn, &scope).is_err());
        active_cache::update("branch-A", false);
        assert!(ensure_no_queued_fiscal_for_window(&conn, &scope).is_ok());
        active_cache::reset_for_tests();
    }

    #[test]
    #[serial_test::serial]
    fn the_blocked_response_is_typed_for_the_renderer_to_localize() {
        active_cache::reset_for_tests();
        let conn = make_conn();
        insert_pending_fiscal(&conn, "branch-A", "2026-09-29");
        let Err(blocked) =
            ensure_no_queued_fiscal_for_window(&conn, &day("branch-A", "2026-09-29"))
        else {
            panic!("expected a block");
        };
        let response = blocked.to_response();
        assert_eq!(response["success"], false);
        assert_eq!(response["errorCode"], FISCAL_CLOSE_BLOCKED_ERROR_CODE);
        assert_eq!(response["reason"], FISCAL_QUEUE_NOT_EMPTY_REASON);
        assert_eq!(response["count"], 1);
        assert_eq!(response["businessDay"], "2026-09-29");
        assert_eq!(response["activeVerdict"], "unknown");
        assert_eq!(response["fiscalRows"][0]["orderId"], "rec-1");
        assert!(
            response["fiscalRows"][0].get("data").is_none(),
            "never the payload"
        );
    }
}
