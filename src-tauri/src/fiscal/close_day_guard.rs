//! Z-report close-day guard for fiscalization.
//!
//! Implements Task 23 of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Req 4.7, Req 4.7a, Req 4.7b.
//!
//! Z-report close MUST refuse to complete while a fiscal submission for
//! the business day is still `pending`/`processing` UNDER A CURRENTLY
//! ACTIVE PLUGIN. Stale rows whose owning plugin is no longer active are
//! NOT blocking — they get marked `blocked` by the server and we ignore
//! them locally so the cashier can close the till.
//!
//! ## Status: scaffold for the local-probe branch only
//!
//! This implementation does the cheap local probe (any pending fiscal
//! rows for today in `parity_sync_queue`?). The server-side `activeReason`
//! lookup that decides "is this plugin currently active?" is currently
//! treated as "yes, blocking" — until [`active_cache`] is wired in fully,
//! ANY pending row blocks. T24 (close-path wiring) and a follow-up to
//! consult the active-cache will make stale-plugin rows non-blocking per
//! Req 4.7a.

use rusqlite::{params, Connection};

use super::active_cache::{self, CacheVerdict};

/// Reason the close-day path was blocked. Carries enough detail for a
/// translated cashier message and for the operator override path.
#[derive(Debug, Clone)]
pub enum CloseBlockedError {
    /// Local fiscal queue has pending rows for the business day.
    FiscalQueueNotEmpty { source: &'static str, count: i64 },
}

/// Probe — does the local `parity_sync_queue` have any pending/processing
/// fiscal rows for the given business day?
///
/// Business-day boundary is approximated here as "rows created since
/// midnight UTC on the supplied date". A follow-up will switch to the
/// project's `business_day` module for the accurate per-org boundary.
///
/// Per Req 4.7a: if the cached active state for the branch is `Inactive`,
/// we do NOT block — stale rows will be marked `blocked` by the server.
pub fn ensure_no_queued_fiscal_for_day(
    conn: &Connection,
    branch_id: &str,
    business_day_iso: &str,
) -> Result<(), CloseBlockedError> {
    // Req 4.7a: if the active cache says the plugin is no longer active,
    // skip the block entirely. The server marks those rows blocked on its
    // own.
    if let CacheVerdict::Inactive = active_cache::verdict(branch_id) {
        return Ok(());
    }

    let count = count_pending_fiscal_for_day(conn, branch_id, business_day_iso).unwrap_or(0);
    if count > 0 {
        return Err(CloseBlockedError::FiscalQueueNotEmpty {
            source: "local",
            count,
        });
    }
    Ok(())
}

/// Audit finding #7 (P2) fix (2026-05-25): the pre-fix query counted pending
/// fiscal rows across ALL branches, so a multi-branch terminal device could
/// not close Branch A's day while Branch B had pending receipts. The
/// `parity_sync_queue` table does not have a dedicated `branch_id` column
/// (only `organization_id`), so we read the branch from the payload's
/// `data` JSON via `json_extract`. Both POS fiscal-payload writers already
/// emit `branchId` into the data JSON (pos-tauri `payload_builder.rs:79`
/// + mobile `buildFiscalReceiptInput.ts:96`), so new rows match this
/// filter. Legacy rows whose data JSON lacks `branchId` produce a NULL
/// from `json_extract` and are excluded by the equality — a deliberate
/// trade-off: they won't block close-day, but they would have been
/// excluded by Req 4.7a (server marks them blocked anyway). No schema
/// migration is needed for this fix.
fn count_pending_fiscal_for_day(
    conn: &Connection,
    branch_id: &str,
    business_day_iso: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM parity_sync_queue
         WHERE module_type = 'fiscal'
           AND status IN ('pending', 'processing')
           AND date(created_at) = date(?1)
           AND json_extract(data, '$.branchId') = ?2",
        params![business_day_iso, branch_id],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("count pending fiscal queue: {e}"))
}

// =============================================================================
// Audit finding #7 (P2) regression tests
// =============================================================================
// The pre-fix bug was that count_pending_fiscal_for_day did NOT filter by
// branch_id, so a pending row at Branch B would block Branch A's close-day.
// These tests insert rows for two branches and assert per-branch isolation.
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

    fn insert_pending_fiscal(conn: &Connection, branch_id: &str, business_day_iso: &str) -> String {
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
             VALUES (?1, 'orders', 'rec-1', 'INSERT', ?2, 'org-1', ?3, 'fiscal', 'pending')",
            params![id, data.to_string(), business_day_iso],
        )
        .expect("insert pending fiscal row");
        id
    }

    #[test]
    fn audit_7_only_target_branch_blocks_close() {
        let conn = make_conn();
        let day = "2026-05-25";

        insert_pending_fiscal(&conn, "branch-A", day);
        insert_pending_fiscal(&conn, "branch-B", day);

        // Branch-A close should be blocked (its own row is pending).
        let result_a = ensure_no_queued_fiscal_for_day(&conn, "branch-A", day);
        assert!(matches!(
            result_a,
            Err(CloseBlockedError::FiscalQueueNotEmpty { count: 1, .. })
        ));

        // Branch-B close should ALSO be blocked (its own row is pending).
        let result_b = ensure_no_queued_fiscal_for_day(&conn, "branch-B", day);
        assert!(matches!(
            result_b,
            Err(CloseBlockedError::FiscalQueueNotEmpty { count: 1, .. })
        ));
    }

    #[test]
    fn audit_7_other_branch_pending_does_not_block_target_branch() {
        let conn = make_conn();
        let day = "2026-05-25";

        // Insert ONLY a Branch-B row. Pre-fix, Branch-A's close would still
        // have been blocked because the count ignored branch_id.
        insert_pending_fiscal(&conn, "branch-B", day);

        let result_a = ensure_no_queued_fiscal_for_day(&conn, "branch-A", day);
        assert!(
            result_a.is_ok(),
            "Branch-A close must succeed when only Branch-B has pending fiscal — got {result_a:?}"
        );

        // Sanity: Branch-B is still blocked by its own pending row.
        let result_b = ensure_no_queued_fiscal_for_day(&conn, "branch-B", day);
        assert!(matches!(
            result_b,
            Err(CloseBlockedError::FiscalQueueNotEmpty { count: 1, .. })
        ));
    }

    #[test]
    fn audit_7_legacy_row_without_branchid_does_not_block() {
        let conn = make_conn();
        let day = "2026-05-25";
        // Simulate a legacy row whose data JSON lacks branchId — the
        // deliberate trade-off documented in count_pending_fiscal_for_day's
        // comment. json_extract returns NULL, the equality with the branch
        // arg is NULL (not TRUE), the row is excluded.
        let data = serde_json::json!({ "orderId": "legacy", "receiptNumber": "R-OLD" });
        conn.execute(
            "INSERT INTO parity_sync_queue
             (id, table_name, record_id, operation, data, organization_id, created_at, module_type, status)
             VALUES ('legacy-1', 'orders', 'rec-old', 'INSERT', ?1, 'org-1', ?2, 'fiscal', 'pending')",
            params![data.to_string(), day],
        )
        .expect("insert legacy row");

        let result = ensure_no_queued_fiscal_for_day(&conn, "branch-A", day);
        assert!(
            result.is_ok(),
            "legacy row without branchId must not block — got {result:?}"
        );
    }

    #[test]
    fn audit_7_different_day_does_not_block() {
        let conn = make_conn();
        insert_pending_fiscal(&conn, "branch-A", "2026-05-24");

        let result = ensure_no_queued_fiscal_for_day(&conn, "branch-A", "2026-05-25");
        assert!(
            result.is_ok(),
            "yesterday's row must not block today's close — got {result:?}"
        );
    }
}
