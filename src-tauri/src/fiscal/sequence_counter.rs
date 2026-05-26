//! Per-(branch, business-day) monotonic sequence counter for fiscal receipts.
//!
//! Audit finding #1 (P0) — partial fix (2026-05-25). The HR adapter
//! validator at `admin-dashboard/src/services/fiscal/adapters/hr/xml-builder.ts:171`
//! requires `metadata.sequenceNumber` to be a positive integer per receipt;
//! before this module there was no local counter so the payload was emitted
//! with an empty `metadata` map and the validator terminal-failed.
//!
//! Scope: `(branch_id, business_day_iso)`. Two branches sharing a single
//! terminal device get independent counters — matching the audit #7
//! isolation posture for the close-day guard. Sequences reset at each new
//! business day per Croatian Fiskalizacija convention; Greece's myDATA
//! receipts can use the same counter (the value space is per-branch
//! anyway).
//!
//! Concurrency: the UPSERT runs inside a SQLite transaction. SQLite's
//! per-connection write serialization means two concurrent calls on the
//! same connection cannot interleave the read-modify-write. Two
//! connections to the same database file may race; in practice pos-tauri
//! holds a single DB mutex so this is structurally safe today.
//!
//! Migration: the `fiscal_sequence_counters` table is created by
//! `db::migrate_v65`. This module assumes the table exists.

use rusqlite::{params, Connection};

/// Atomically allocate the next sequence number for the given
/// (branch, business-day). Returns the new value (always >= 1).
///
/// On first call for a (branch, day) pair, inserts a new row with
/// `last_seq = 1` and returns 1. On subsequent calls, increments and
/// returns the new value.
pub fn next_sequence(
    conn: &Connection,
    branch_id: &str,
    business_day_iso: &str,
) -> Result<i64, String> {
    // INSERT ... ON CONFLICT DO UPDATE pattern is atomic in SQLite —
    // RETURNING gives us the post-update value in one round-trip without a
    // separate SELECT (which would need its own transaction wrapper to
    // prevent two concurrent writers from racing).
    let next_val: i64 = conn
        .query_row(
            "INSERT INTO fiscal_sequence_counters
                (branch_id, business_day_iso, last_seq, updated_at)
             VALUES (?1, ?2, 1, datetime('now'))
             ON CONFLICT (branch_id, business_day_iso) DO UPDATE
               SET last_seq   = fiscal_sequence_counters.last_seq + 1,
                   updated_at = datetime('now')
             RETURNING last_seq",
            params![branch_id, business_day_iso],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("next_sequence({branch_id},{business_day_iso}): {e}"))?;

    Ok(next_val)
}

/// Read the current last_seq WITHOUT incrementing. Returns 0 if no row
/// exists yet for the (branch, day) pair. Useful for observability /
/// admin views; never use this for assigning a sequence to a receipt
/// (use [`next_sequence`] for that — it's atomic).
#[allow(dead_code)]
pub fn peek_last_sequence(
    conn: &Connection,
    branch_id: &str,
    business_day_iso: &str,
) -> Result<i64, String> {
    let value: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(last_seq), 0)
             FROM fiscal_sequence_counters
             WHERE branch_id = ?1 AND business_day_iso = ?2",
            params![branch_id, business_day_iso],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("peek_last_sequence({branch_id},{business_day_iso}): {e}"))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates the table this module operates on, mirroring the v65
    /// migration body. Tests use this rather than running the full
    /// migration chain to keep setup small.
    fn make_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch(
            "CREATE TABLE fiscal_sequence_counters (
                branch_id        TEXT NOT NULL,
                business_day_iso TEXT NOT NULL,
                last_seq         INTEGER NOT NULL DEFAULT 0,
                updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (branch_id, business_day_iso)
            );",
        )
        .expect("create table");
        conn
    }

    #[test]
    fn next_sequence_starts_at_one_on_first_call() {
        let conn = make_conn();
        let n = next_sequence(&conn, "branch-A", "2026-05-25").unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn next_sequence_monotonically_increments_for_same_branch_and_day() {
        let conn = make_conn();
        for expected in 1..=10 {
            let actual = next_sequence(&conn, "branch-A", "2026-05-25").unwrap();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn next_sequence_is_per_branch_independent() {
        let conn = make_conn();
        // Branch-A: 1, 2, 3
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-25").unwrap(), 1);
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-25").unwrap(), 2);
        // Branch-B starts fresh at 1
        assert_eq!(next_sequence(&conn, "branch-B", "2026-05-25").unwrap(), 1);
        assert_eq!(next_sequence(&conn, "branch-B", "2026-05-25").unwrap(), 2);
        // Branch-A continues from 3 (not affected by branch-B's calls)
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-25").unwrap(), 3);
    }

    #[test]
    fn next_sequence_resets_per_business_day() {
        let conn = make_conn();
        // 2026-05-25: 1, 2
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-25").unwrap(), 1);
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-25").unwrap(), 2);
        // 2026-05-26: fresh sequence starts at 1
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-26").unwrap(), 1);
        // 2026-05-25 continues from 3 — past days don't disappear
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-25").unwrap(), 3);
    }

    #[test]
    fn peek_last_sequence_returns_zero_when_no_row_exists() {
        let conn = make_conn();
        assert_eq!(
            peek_last_sequence(&conn, "branch-A", "2026-05-25").unwrap(),
            0
        );
    }

    #[test]
    fn peek_last_sequence_returns_current_without_incrementing() {
        let conn = make_conn();
        next_sequence(&conn, "branch-A", "2026-05-25").unwrap();
        next_sequence(&conn, "branch-A", "2026-05-25").unwrap();
        // last_seq is 2 — peek twice, both return 2 (no increment).
        assert_eq!(
            peek_last_sequence(&conn, "branch-A", "2026-05-25").unwrap(),
            2
        );
        assert_eq!(
            peek_last_sequence(&conn, "branch-A", "2026-05-25").unwrap(),
            2
        );
        // Next next_sequence still returns 3 (peek did not advance).
        assert_eq!(next_sequence(&conn, "branch-A", "2026-05-25").unwrap(), 3);
    }
}
