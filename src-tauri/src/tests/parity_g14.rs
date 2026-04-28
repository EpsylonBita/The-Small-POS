//! Parity Gate G14 — z-report offline → restart → sync exactly-once.
//!
//! # Gate text (from `PARITY_GATES.md`)
//!
//! > A z-report generated while offline survives a process crash and,
//! > on reconnection, is delivered to the server exactly once.
//! > Server-side upsert on `(terminal_id, report_date)` provides the
//! > idempotency guarantee; the client must still deliver the
//! > in-flight report after a crash.
//!
//! # Why this test looks different from G8/G13
//!
//!   - Z-reports live in the LEGACY `sync_queue` table, not
//!     `parity_sync_queue`. The production orchestrator loads them
//!     separately (sync.rs:9112–9124).
//!   - Z-report dispatch POSTs each report individually to
//!     `/api/pos/z-report/submit` with `{terminal_id, branch_id,
//!     report_date, report_data}` in the body — NOT the financial
//!     `items[].idempotency_key` envelope and NOT a top-level
//!     `idempotency_key` either. The server dedupes via
//!     `(terminal_id, report_date)` upsert, so the wire-level
//!     assertion is on request count and body `report_date`.
//!   - On success the dispatcher updates both `sync_queue.status =
//!     'synced'` AND `z_reports.sync_state = 'applied'`; the test
//!     asserts both.

use serde_json::Value;

use crate::sync;
use crate::tests::fake_http::MockServer;
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-g14";
const BRANCH_ID: &str = "33333333-3333-4333-8333-333333333333";

// (z_report_id, report_date, sync_queue.idempotency_key)
// The key is not sent on the wire for z-reports — we set it only to
// satisfy the `sync_queue.idempotency_key UNIQUE NOT NULL` column.
const REPORTS: [(&str, &str, &str); 2] = [
    ("zr-g14-a", "2026-04-22", "z_report:zr-g14-a"),
    ("zr-g14-b", "2026-04-23", "z_report:zr-g14-b"),
];

#[tokio::test]
async fn parity_g14_zreport_offline_restart_sync_exactly_once() {
    // ---------- Step 1: open TestDb ----------
    let td = TestDb::open();

    // ---------- Step 2: seed z_reports + legacy sync_queue rows ----------
    {
        let conn = td.state.conn.lock().expect("lock db");

        crate::db::set_setting(&conn, "terminal", "terminal_id", TERMINAL_ID)
            .expect("seed terminal_id");
        crate::db::set_setting(&conn, "terminal", "branch_id", BRANCH_ID).expect("seed branch_id");

        // z_reports has `FOREIGN KEY(shift_id) REFERENCES staff_shifts(id)
        // ON DELETE CASCADE` (db.rs:973). To avoid having to reason about
        // the staff_shifts schema (which has columns this test has no
        // interest in), disable FK enforcement for the seed block. This
        // scopes to the current connection only; production paths are
        // unaffected.
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .expect("disable FKs for seed");

        for (zr_id, report_date, key) in REPORTS.iter() {
            // z_reports NOT NULL columns (no defaults) per db.rs:940–974:
            //   id, shift_id, branch_id, terminal_id, report_date,
            //   generated_at, created_at, updated_at.
            // All REAL/INTEGER totals default to 0; JSON blobs default to '{}'.
            conn.execute(
                "INSERT INTO z_reports
                   (id, shift_id, terminal_id, branch_id, report_date,
                    generated_at, sync_state, created_at, updated_at)
                 VALUES (?1, 'shift-g14', ?2, ?3, ?4,
                         datetime('now'), 'pending',
                         datetime('now'), datetime('now'))",
                rusqlite::params![zr_id, TERMINAL_ID, BRANCH_ID, report_date],
            )
            .expect("seed z_report");

            // sync_queue row — entity_type = 'z_report'. Payload carries
            // the full body the dispatcher posts; see sync.rs:12749
            // (`api::fetch_from_admin(..., "/api/pos/z-report/submit",
            // ..., Some(data))`).
            let payload = format!(
                r#"{{"terminal_id":"{TERMINAL_ID}","branch_id":"{BRANCH_ID}","report_date":"{report_date}","report_data":{{}}}}"#
            );
            conn.execute(
                "INSERT INTO sync_queue
                   (entity_type, entity_id, operation, payload,
                    idempotency_key, status, retry_count, max_retries,
                    created_at)
                 VALUES ('z_report', ?1, 'insert', ?2, ?3, 'pending',
                         0, 5, datetime('now'))",
                rusqlite::params![zr_id, payload, key],
            )
            .expect("seed sync_queue z_report row");
        }

        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("re-enable FKs");

        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue
                 WHERE entity_type = 'z_report' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count pre-restart");
        assert_eq!(pending, 2, "pre-restart: 2 pending z-reports");
    }

    // ---------- Step 3: simulate crash ----------
    let td = td.restart();

    // ---------- Step 4: re-assert survival ----------
    {
        let conn = td.state.conn.lock().expect("lock db");
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue
                 WHERE entity_type = 'z_report' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count post-restart");
        assert_eq!(pending, 2, "z-report sync_queue rows survive restart");

        let zreport_pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM z_reports WHERE sync_state = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count z_reports post-restart");
        assert_eq!(zreport_pending, 2, "z_reports rows survive restart");
    }

    // ---------- Step 5/6: spawn MockServer, drive dispatch ----------
    let server = MockServer::new(r#"{"success":true}"#);
    let _kr = fake_keyring::install_seeded([
        ("admin_url", server.url.as_str()),
        ("api_key", "test-api-key-g14"),
        ("terminal_id", TERMINAL_ID),
    ]);

    let synced = sync::dispatch_pending_z_reports_for_test(
        &server.url,
        "test-api-key-g14",
        TERMINAL_ID,
        BRANCH_ID,
        &td.state,
    )
    .await;

    // ---------- Step 7: assertions ----------
    assert_eq!(synced, 2, "both z-reports dispatched");
    assert_eq!(
        server.count(),
        2,
        "server received exactly 2 z-report POSTs (exactly-once)"
    );

    // Every recorded request is a POST to /api/pos/z-report/submit
    // and carries a distinct `report_date` in the body.
    let recorded = server.recorded();
    let mut seen_dates: Vec<String> = recorded
        .iter()
        .map(|req| {
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/api/pos/z-report/submit");
            let body = req.json_body().expect("body is JSON");
            body.get("report_date")
                .and_then(Value::as_str)
                .expect("report_date in body")
                .to_string()
        })
        .collect();
    seen_dates.sort();
    let mut expected: Vec<String> = REPORTS.iter().map(|(_, d, _)| d.to_string()).collect();
    expected.sort();
    assert_eq!(
        seen_dates, expected,
        "every report_date we seeded hit the wire exactly once; \
         the server dedupes via (terminal_id, report_date) upsert"
    );

    // ---------- Step 8: local state reflects success ----------
    let conn = td.state.conn.lock().unwrap();
    let synced_queue: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue
             WHERE entity_type = 'z_report' AND status = 'synced'",
            [],
            |row| row.get(0),
        )
        .expect("count synced queue rows");
    assert_eq!(synced_queue, 2, "both sync_queue rows moved to 'synced'");

    let applied_reports: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM z_reports WHERE sync_state = 'applied'",
            [],
            |row| row.get(0),
        )
        .expect("count applied reports");
    assert_eq!(applied_reports, 2, "both z_reports moved to 'applied'");
}
