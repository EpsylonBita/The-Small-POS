//! pos-tauri online dispatcher for fiscalization.
//!
//! Implements Task 19 of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Reqs 4.1, 4.2, 4.3, 4.4, 4.8, 4.9, 4.10, 4.11, 12.
//!
//! Called from the order-persist path (T22 hook in `commands::orders`)
//! AFTER the order's local transaction commits. NEVER blocks the order
//! command — caller spawns this via `tokio::spawn` and discards the
//! result. Any error here is logged and swallowed; the order is already
//! persisted, so the cashier moves on.
//!
//! Decision tree:
//!   1. Build payload via [`payload_builder`].
//!   2. Try `POST /api/plugins/fiscal/submit`.
//!   3. On HTTP 2xx → done, mirror server outcome.
//!   4. On network error / non-2xx → enqueue onto `parity_sync_queue`
//!      with `module_type='fiscal'`, replayed later by [`replay`].
//!
//! A receipt is queued whatever the fiscal-active verdict says (review of the
//! 29/09/2026 fixes, decided for both POS apps). The verdict used to skip the
//! enqueue when it read "inactive"; one `active:false` answer (a plugin being
//! reconnected, a branch config saved a minute late) then dropped every
//! receipt of a store WITH a fiscal plugin until the next refresh, silently
//! and for good. A queued row of a branch without a plugin costs one request:
//! the server answers `200 skipped` and the row drains. The verdict only
//! decides whether queued rows hold the Z (see [`super::close_day_guard`] and
//! the drain's closeout exemption in `sync_queue`).
//!
//! Per Req 12, every branch in this function ends in `Ok(_)` from the
//! caller's perspective — even configuration gaps, network failures, and
//! local-enqueue failures are absorbed into a log + return.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::payload_builder;

const SUBMIT_PATH: &str = "/api/plugins/fiscal/submit";
const REQUEST_TIMEOUT_SECS: u64 = 15;

/// What the server returned. Mirrors `FiscalDispatchOutcome` from
/// `shared/types/fiscalization.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchOutcome {
    pub status: String,
    #[serde(rename = "outboxRowId")]
    pub outbox_row_id: Option<String>,
    #[serde(rename = "pluginId")]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "authorityId", default)]
    pub authority_id: Option<String>,
}

/// Local-side disposition for a single submit attempt.
#[derive(Debug, Clone)]
pub enum LocalOutcome {
    /// Server accepted (status='submitted' / 'queued' / 'skipped').
    Server(DispatchOutcome),
    /// Protected repair settlements use the trusted server repair worker.
    SkippedProtectedRepair,
    /// Tried POST but network or 5xx failed; row enqueued for retry.
    EnqueuedForRetry { idempotency_key: String },
    /// Could not build payload, could not enqueue, etc. — logged, dropped.
    DroppedWithLog,
}

/// Submit-for-order entry point. Called from the order-persist hook (T22).
///
/// Caller MUST `tokio::spawn(submit_for_order(...))` and discard the
/// `JoinHandle`. This function returns `LocalOutcome` for observability
/// in tests; the production caller never inspects it.
pub async fn submit_for_order(
    conn: Arc<Mutex<Connection>>,
    order_id: String,
    admin_base_url: String,
    api_key: String,
    terminal_id: String,
    branch_id: String,
) -> LocalOutcome {
    let _support_critical = crate::support::critical_op::begin_critical(
        crate::support::critical_op::CriticalKind::Fiscal,
    );
    {
        let db = match conn.lock() {
            Ok(guard) => guard,
            Err(error) => {
                warn!("[fiscal.dispatcher] DB mutex poisoned: {error}");
                return LocalOutcome::DroppedWithLog;
            }
        };
        if is_protected_repair_order(&db, &order_id).unwrap_or(false) {
            info!("[fiscal.dispatcher] protected repair settlement {order_id} uses server repair fiscal worker");
            return LocalOutcome::SkippedProtectedRepair;
        }
    }
    // No fiscal-active short-circuit: the server decides (`skipped` for a
    // branch without a plugin), see the module docs.

    // Step 1: build payload
    let payload = {
        let db = match conn.lock() {
            Ok(g) => g,
            Err(e) => {
                warn!("[fiscal.dispatcher] DB mutex poisoned: {e}");
                return LocalOutcome::DroppedWithLog;
            }
        };
        match payload_builder::build_fiscal_receipt_input(&db, &order_id, &branch_id) {
            Ok(value) => value,
            Err(e) => {
                warn!("[fiscal.dispatcher] payload build failed for order {order_id}: {e}");
                return LocalOutcome::DroppedWithLog;
            }
        }
    };

    let idempotency_key = format!("fiscal:{order_id}:{branch_id}");

    // Step 2: try POST
    let post_outcome = try_post(&admin_base_url, &api_key, &terminal_id, &payload).await;

    match post_outcome {
        Ok(outcome) => LocalOutcome::Server(outcome),
        Err(post_err) => {
            warn!(
                "[fiscal.dispatcher] POST failed for order {order_id} (key {idempotency_key}): \
                 {post_err}. Enqueueing onto parity_sync_queue."
            );

            // Step 3: enqueue onto parity_sync_queue with module_type='fiscal'
            let enqueue_result = {
                let db = match conn.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        warn!("[fiscal.dispatcher] DB mutex poisoned during enqueue: {e}");
                        return LocalOutcome::DroppedWithLog;
                    }
                };
                enqueue_fiscal_row(&db, &order_id, &branch_id, &payload)
            };

            match enqueue_result {
                Ok(()) => LocalOutcome::EnqueuedForRetry { idempotency_key },
                Err(e) => {
                    warn!(
                        "[fiscal.dispatcher] enqueue also failed for order {order_id}: {e}. \
                         Receipt dropped — order itself is already persisted, cashier continues."
                    );
                    LocalOutcome::DroppedWithLog
                }
            }
        }
    }
}

/// Build and execute the POST. Used by both [`submit_for_order`] and
/// the replay path (T20).
pub(crate) async fn try_post(
    admin_base_url: &str,
    api_key: &str,
    terminal_id: &str,
    payload: &serde_json::Value,
) -> Result<DispatchOutcome, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("reqwest client build: {e}"))?;

    let url = format!("{}{}", admin_base_url.trim_end_matches('/'), SUBMIT_PATH);

    let response = client
        .post(&url)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", terminal_id)
        .header("Content-Type", "application/json")
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;

    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("read response body: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "POST {url} returned HTTP {}: {}",
            status.as_u16(),
            body_text
        ));
    }

    serde_json::from_str::<DispatchOutcome>(&body_text)
        .map_err(|e| format!("parse DispatchOutcome from response: {e}"))
}

/// Best-effort handoff for an order that was just persisted (T22 entry).
///
/// Reads `branch_id` from the local `orders` row, builds the canonical
/// payload via [`super::payload_builder`], and enqueues a
/// `module_type='fiscal'` row onto `parity_sync_queue` for replay by the
/// existing sync_queue dispatcher (T21 wires the routing).
///
/// Per Req 12 (fiscalization is optional): every error path returns
/// `Err(String)` to the caller so they can log; the caller MUST NOT
/// propagate this error to the order command. Currently consulted as a
/// fire-and-forget log-on-error from `commands::orders::order_create`.
///
/// The receipt is queued whatever the fiscal-active verdict says: a store
/// with a fiscal plugin must never lose a receipt to one `active:false`
/// answer, and a branch without a plugin drains its row as `skipped`. A
/// FRESH inactive verdict only keeps the queued row from holding the Z.
pub fn enqueue_for_order(conn: &Connection, order_id: &str) -> Result<(), String> {
    if super::payload_builder::folio_fiscal_lines(conn, order_id)?
        .is_some_and(|lines| lines.is_empty())
    {
        return Ok(());
    }
    if is_protected_repair_order(conn, order_id)? {
        info!("[fiscal.dispatcher] skipping generic fiscal queue for protected repair settlement {order_id}");
        return Ok(());
    }
    let branch_id: String = conn
        .query_row(
            "SELECT COALESCE(branch_id, '') FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("read branch_id for order {order_id}: {e}"))?;

    if branch_id.is_empty() {
        return Err(format!(
            "order {order_id} has no branch_id; cannot enqueue fiscal row"
        ));
    }

    let payload = super::payload_builder::build_fiscal_receipt_input(conn, order_id, &branch_id)?;

    enqueue_fiscal_row(conn, order_id, &branch_id, &payload)
}

/// Retain admission intent before the best-effort handoff. Callers must keep
/// fiscal failures separate from the already committed order/payment outcome.
pub fn enqueue_with_admission_owed(conn: &Connection, order_id: &str) -> Result<(), String> {
    if let Err(error) = super::admission_owed::mark_owed(conn, order_id) {
        warn!(%order_id, %error, "Could not retain fiscal admission owed");
    }
    match enqueue_for_order(conn, order_id) {
        Ok(()) => super::admission_owed::clear(conn, order_id),
        Err(error) => {
            if let Err(note_error) = super::admission_owed::note_failure(conn, order_id, &error) {
                warn!(%order_id, %note_error, "Could not retain fiscal admission failure");
            }
            Err(error)
        }
    }
}

fn is_protected_repair_order(conn: &Connection, order_id: &str) -> Result<bool, String> {
    let has_context = conn
        .prepare("PRAGMA table_info(orders)")
        .and_then(|mut statement| {
            let names = statement.query_map([], |row| row.get::<_, String>(1))?;
            for name in names {
                if name? == "order_context" {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .map_err(|error| format!("inspect local orders schema: {error}"))?;
    if !has_context {
        return Ok(false);
    }
    conn.query_row(
        "SELECT COALESCE(order_context, '') = 'repair_settlement' FROM orders WHERE id = ?1",
        [order_id],
        |row| row.get::<_, bool>(0),
    )
    .optional()
    .map(|value| value.unwrap_or(false))
    .map_err(|error| format!("read order_context for {order_id}: {error}"))
}

/// Insert a `module_type='fiscal'` row into `parity_sync_queue` for replay
/// by the existing sync_queue dispatcher (T21 wires the routing).
///
/// **Delegates to `crate::sync_queue::enqueue_payload_item`** so we use the
/// EXACT same column shape (data / organization_id / operation IN ('INSERT',
/// 'UPDATE', 'DELETE')) every other module type uses. Earlier revisions of
/// this function used a hand-rolled `INSERT INTO parity_sync_queue` with the
/// wrong column names (`payload`, `retries`, `operation='POST'`) and missing
/// the NOT NULL `organization_id`; those would fail at the SQL layer on a
/// real terminal even though the tests passed against a fake schema.
///
/// We also call `clear_unsynced_items` first to drop any earlier pending
/// fiscal row for the same order — matches the dedup pattern used by
/// `enqueue_order_sync_payload` and friends in `commands::orders`.
fn enqueue_fiscal_row(
    conn: &Connection,
    order_id: &str,
    branch_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    // Drop any earlier pending fiscal row for this order so we don't queue
    // up duplicates locally. The server-side outbox's UNIQUE(org_id,
    // idempotency_key) is the ultimate dedup authority, but this keeps the
    // local queue clean.
    crate::sync_queue::clear_unsynced_items(conn, "fiscal_submission", order_id)
        .map_err(|e| format!("fiscal clear_unsynced_items: {e}"))?;

    crate::sync_queue::enqueue_payload_item(
        conn,
        "fiscal_submission",
        order_id,
        "INSERT", // operation must satisfy the CHECK ('INSERT','UPDATE','DELETE')
        payload,
        Some(100), // FINANCIAL_CRITICAL priority — tax-authority deadlines matter
        Some("fiscal"),
        Some("last-write-wins"),
        Some(1),
    )
    .map_err(|e| format!("enqueue parity_sync_queue (fiscal): {e}"))?;

    let _ = branch_id; // branch_id lives in the payload; sync_queue worker reads it from there
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fiscal::active_cache;
    use crate::fiscal::close_day_guard::{self, FiscalCloseScope};
    use rusqlite::params;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        conn
    }

    fn seed_paid_order(conn: &Connection, order_id: &str, branch_id: &str) {
        conn.execute(
            "INSERT INTO orders (id, supabase_id, organization_id, items, subtotal, subtotal_cents,
                                 total_amount, total_amount_cents, status, payment_status,
                                 sync_status, branch_id, created_at, updated_at, currency)
             VALUES (?1, ?2, 'org-1', '[]', 10.0, 1000, 10.0, 1000, 'completed', 'paid',
                     'synced', ?3, '2026-09-29T11:05:13Z', '2026-09-29T11:05:13Z', 'EUR')",
            params![order_id, format!("remote-{order_id}"), branch_id],
        )
        .expect("seed order");
    }

    fn queued_fiscal_rows(conn: &Connection, order_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM parity_sync_queue
             WHERE module_type = 'fiscal' AND record_id = ?1",
            [order_id],
            |row| row.get(0),
        )
        .expect("count queued fiscal rows")
    }

    fn whole_branch(branch_id: &str) -> FiscalCloseScope {
        FiscalCloseScope {
            branch_id: branch_id.to_string(),
            report_date: "2026-09-30".to_string(),
            period_start_at: "0001-01-01T00:00:00Z".to_string(),
            cutoff_at: None,
            lower_bound_inclusive: true,
        }
    }

    fn fail_fiscal_enqueue(conn: &Connection) {
        conn.execute_batch("CREATE TRIGGER fail_fiscal_admission BEFORE INSERT ON parity_sync_queue
            WHEN NEW.module_type = 'fiscal' BEGIN SELECT RAISE(ABORT, 'test fiscal enqueue failure'); END;")
            .unwrap();
    }

    #[test]
    fn admission_owed_survives_failure_and_retry_enqueues_exactly_once() {
        let conn = migrated_conn();
        seed_paid_order(&conn, "owed", "branch");
        fail_fiscal_enqueue(&conn);
        assert!(enqueue_with_admission_owed(&conn, "owed").is_err());
        super::super::admission_owed::retry_owed(&conn);
        assert_eq!(
            super::super::admission_owed::list_owed(&conn, 25).unwrap(),
            vec!["owed"]
        );
        let attempts: i64 = conn
            .query_row(
                "SELECT json_extract(setting_value, '$.attempts') FROM local_settings
            WHERE setting_category='fiscal_admission_owed' AND setting_key='owed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 2);
        conn.execute_batch("DROP TRIGGER fail_fiscal_admission")
            .unwrap();
        super::super::admission_owed::retry_owed(&conn);
        super::super::admission_owed::retry_owed(&conn);
        assert!(super::super::admission_owed::list_owed(&conn, 25)
            .unwrap()
            .is_empty());
        assert_eq!(queued_fiscal_rows(&conn, "owed"), 1);
    }

    #[test]
    fn admission_owed_success_and_protected_skip_clear_the_mark() {
        let conn = migrated_conn();
        seed_paid_order(&conn, "success", "branch");
        enqueue_with_admission_owed(&conn, "success").unwrap();
        assert_eq!(queued_fiscal_rows(&conn, "success"), 1);
        seed_paid_order(&conn, "repair", "branch");
        conn.execute(
            "UPDATE orders SET order_context='repair_settlement' WHERE id='repair'",
            [],
        )
        .unwrap();
        enqueue_with_admission_owed(&conn, "repair").unwrap();
        assert_eq!(queued_fiscal_rows(&conn, "repair"), 0);
        seed_paid_order(&conn, "folio", "branch");
        conn.execute(
            "UPDATE orders SET order_context='folio_settlement',
            ghost_metadata='{\"folio_settlement\":{\"fiscal_line_snapshot\":[]}}' WHERE id='folio'",
            [],
        )
        .unwrap();
        enqueue_with_admission_owed(&conn, "folio").unwrap();
        assert_eq!(queued_fiscal_rows(&conn, "folio"), 0);
        assert!(super::super::admission_owed::list_owed(&conn, 25)
            .unwrap()
            .is_empty());
        conn.execute(
            "DELETE FROM parity_sync_queue WHERE record_id='success'",
            [],
        )
        .unwrap();
        super::super::admission_owed::retry_owed(&conn);
        assert_eq!(
            queued_fiscal_rows(&conn, "success"),
            0,
            "an accepted/consumed queue row is not missing admission"
        );
    }

    #[test]
    fn admission_owed_mark_write_failure_does_not_prevent_enqueue() {
        let conn = migrated_conn();
        seed_paid_order(&conn, "unmarked", "branch");
        conn.execute_batch("CREATE TRIGGER fail_mark BEFORE INSERT ON local_settings
            WHEN NEW.setting_category='fiscal_admission_owed' BEGIN SELECT RAISE(ABORT, 'test mark failure'); END;")
            .unwrap();
        enqueue_with_admission_owed(&conn, "unmarked").unwrap();
        assert_eq!(queued_fiscal_rows(&conn, "unmarked"), 1);
    }

    #[test]
    fn admission_owed_retry_is_bounded_untried_first_and_continues_after_failure() {
        use super::super::admission_owed;
        let conn = migrated_conn();
        for index in 0..26 {
            let id = format!("owed-{index:02}");
            seed_paid_order(&conn, &id, if index == 0 { "" } else { "branch" });
            admission_owed::mark_owed(&conn, &id).unwrap();
            conn.execute(
                "UPDATE local_settings SET setting_value=json_set(setting_value, '$.since', ?1)
                WHERE setting_category='fiscal_admission_owed' AND setting_key=?2",
                params![format!("2026-09-29T11:05:{index:02}Z"), id],
            )
            .unwrap();
        }
        admission_owed::retry_owed(&conn);
        assert_eq!(
            admission_owed::list_owed(&conn, 25).unwrap(),
            // The untried mark goes ahead of the one that already failed.
            vec!["owed-25", "owed-00"]
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE module_type='fiscal'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            24
        );
        assert_eq!(queued_fiscal_rows(&conn, "owed-25"), 0);
    }

    #[test]
    fn admission_owed_missing_order_is_cleared_without_a_receipt() {
        let conn = migrated_conn();
        super::super::admission_owed::mark_owed(&conn, "missing").unwrap();
        super::super::admission_owed::retry_owed(&conn);
        assert!(super::super::admission_owed::list_owed(&conn, 25)
            .unwrap()
            .is_empty());
        assert_eq!(queued_fiscal_rows(&conn, "missing"), 0);
    }

    #[test]
    fn admission_owed_retry_retains_the_order_window_and_rolls_back_if_clear_fails() {
        use super::super::admission_owed;
        let conn = migrated_conn();
        seed_paid_order(&conn, "frozen", "branch");
        admission_owed::mark_owed(&conn, "frozen").unwrap();
        conn.execute_batch("CREATE TRIGGER fail_clear BEFORE DELETE ON local_settings
            WHEN OLD.setting_category='fiscal_admission_owed' BEGIN SELECT RAISE(ABORT, 'test clear failure'); END;")
            .unwrap();
        admission_owed::retry_owed(&conn);
        assert_eq!(queued_fiscal_rows(&conn, "frozen"), 0);
        assert_eq!(
            admission_owed::list_owed(&conn, 25).unwrap(),
            vec!["frozen"]
        );
        conn.execute_batch("DROP TRIGGER fail_clear").unwrap();
        admission_owed::retry_owed(&conn);
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM parity_sync_queue WHERE record_id='frozen'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(created_at, "2026-09-29T11:05:13Z");
    }

    #[test]
    fn admission_owed_retry_rolls_back_a_commit_failure_without_leaving_a_transaction_open() {
        use super::super::admission_owed;
        let conn = migrated_conn();
        seed_paid_order(&conn, "commit-failure", "branch");
        admission_owed::mark_owed(&conn, "commit-failure").unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE fiscal_commit_probe (order_id TEXT REFERENCES orders(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER fail_fiscal_commit AFTER INSERT ON parity_sync_queue
            WHEN NEW.module_type='fiscal' BEGIN INSERT INTO fiscal_commit_probe VALUES ('missing-order'); END;").unwrap();
        admission_owed::retry_owed(&conn);
        assert!(conn.is_autocommit());
        assert_eq!(queued_fiscal_rows(&conn, "commit-failure"), 0);
        assert_eq!(
            admission_owed::list_owed(&conn, 25).unwrap(),
            vec!["commit-failure"]
        );
        conn.execute_batch("DROP TRIGGER fail_fiscal_commit")
            .unwrap();
        admission_owed::retry_owed(&conn);
        assert_eq!(queued_fiscal_rows(&conn, "commit-failure"), 1);
        assert!(admission_owed::list_owed(&conn, 25).unwrap().is_empty());
    }

    #[test]
    fn admission_owed_is_durable_across_reopen_and_cleared_by_rebind() {
        use super::super::admission_owed;
        let directory = std::env::temp_dir().join(format!("fiscal-owed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fiscal.db");
        {
            let conn = Connection::open(&path).unwrap();
            crate::db::run_migrations_for_test(&conn);
            seed_paid_order(&conn, "restart", "branch");
            admission_owed::mark_owed(&conn, "restart").unwrap();
        }
        let mut conn = Connection::open(&path).unwrap();
        admission_owed::retry_owed(&conn);
        assert_eq!(queued_fiscal_rows(&conn, "restart"), 1);
        assert!(admission_owed::list_owed(&conn, 25).unwrap().is_empty());
        admission_owed::mark_owed(&conn, "old-scope").unwrap();
        crate::db::set_setting(&conn, "local", "retained", "yes").unwrap();
        let transaction = conn.transaction().unwrap();
        crate::core_helpers::clear_generic_operational_data_in_transaction(&transaction).unwrap();
        transaction.commit().unwrap();
        assert!(admission_owed::list_owed(&conn, 25).unwrap().is_empty());
        assert_eq!(
            crate::db::get_setting(&conn, "local", "retained").as_deref(),
            Some("yes")
        );
        drop(conn);
        std::fs::remove_dir_all(&directory).unwrap();
    }

    /// Review of the 29/09/2026 fixes (decided for both POS apps): a store
    /// WITH a fiscal plugin lost every receipt after one `active:false`
    /// answer, because the dispatcher skipped the enqueue under an inactive
    /// verdict. The receipt is always queued; a FRESH inactive verdict only
    /// keeps it from holding the Z, and an unknown or active one holds it.
    #[test]
    #[serial_test::serial]
    fn a_receipt_is_queued_even_when_the_branch_reads_fiscally_inactive() {
        active_cache::reset_for_tests();
        let conn = migrated_conn();
        seed_paid_order(&conn, "o-fiscal", "branch-1");
        active_cache::update("branch-1", false);

        enqueue_for_order(&conn, "o-fiscal").expect("the receipt is queued");
        assert_eq!(
            queued_fiscal_rows(&conn, "o-fiscal"),
            1,
            "an inactive verdict must never drop a receipt"
        );

        // Fresh inactive: the row neither holds the Z nor counts in the
        // closeout drain's failure accounting.
        assert!(close_day_guard::ensure_no_queued_fiscal_for_window(
            &conn,
            &whole_branch("branch-1")
        )
        .is_ok());
        conn.execute(
            "UPDATE parity_sync_queue SET status = 'failed' WHERE module_type = 'fiscal'",
            [],
        )
        .unwrap();
        assert_eq!(
            crate::sync_queue::get_closeout_blocking_status(&conn)
                .expect("closeout status")
                .failed,
            0
        );

        // Active (or unknown once the verdict expires): the same row holds.
        active_cache::update("branch-1", true);
        assert!(close_day_guard::ensure_no_queued_fiscal_for_window(
            &conn,
            &whole_branch("branch-1")
        )
        .is_err());
        assert_eq!(
            crate::sync_queue::get_closeout_blocking_status(&conn)
                .expect("closeout status")
                .failed,
            1
        );
        active_cache::reset_for_tests();
        assert!(
            close_day_guard::ensure_no_queued_fiscal_for_window(&conn, &whole_branch("branch-1"))
                .is_err(),
            "an unknown verdict fails closed"
        );
    }

    /// The online entry point follows the same rule: under an inactive
    /// verdict it still tries the server and, when that fails, queues.
    #[tokio::test]
    #[serial_test::serial]
    async fn the_online_submit_does_not_skip_an_inactive_branch_either() {
        active_cache::reset_for_tests();
        let conn = migrated_conn();
        seed_paid_order(&conn, "o-online", "branch-2");
        active_cache::update("branch-2", false);
        let conn = Arc::new(Mutex::new(conn));

        // Not a URL: the request fails before any network I/O.
        let outcome = submit_for_order(
            Arc::clone(&conn),
            "o-online".to_string(),
            "not a url".to_string(),
            "api-key".to_string(),
            "terminal-1".to_string(),
            "branch-2".to_string(),
        )
        .await;

        assert!(
            matches!(outcome, LocalOutcome::EnqueuedForRetry { .. }),
            "{outcome:?}"
        );
        assert_eq!(queued_fiscal_rows(&conn.lock().unwrap(), "o-online"), 1);
        active_cache::reset_for_tests();
    }
}
