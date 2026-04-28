//! Parity Gate G13 — refund/void offline → restart → sync exactly-once.
//!
//! # Gate text (from `PARITY_GATES.md`)
//!
//! > A refund or void adjustment taken while offline survives a process
//! > crash and, on reconnection, is delivered to the server exactly once
//! > with a stable, record-anchored idempotency key.
//!
//! # Test shape
//!
//! Refunds and voids flow through the **parity** queue —
//! `refunds.rs` enqueues `payment_adjustments` rows into
//! `parity_sync_queue`. Dispatch is `sync_queue::process_queue` which
//! routes `table_name = 'payment_adjustments'` to
//! `prepare_adjustment_request` (sync_queue.rs:3107). That function
//! stamps `idempotency_key = format!("adjustment:{record_id}")` at
//! body top-level and POSTs to `/api/pos/payments/adjustments/sync`.
//!
//! Because the key is derived from the adjustment's primary key
//! (which does not change across a restart), the server dedupes
//! correctly even if the sync cycle runs twice after a crash.
//!
//! # Parent-payment precondition
//!
//! `prepare_adjustment_request` DEFERS the dispatch unless the parent
//! `order_payments` row has BOTH:
//!   - `sync_state = 'applied'`, AND
//!   - `remote_payment_id` non-empty.
//!
//! This guard is there to stop us from POSTing adjustments that
//! reference a payment the server has not seen yet. The test seeds a
//! single "fully synced" parent payment and hangs five adjustments
//! off it.

use serde_json::Value;

use crate::sync_queue;
use crate::tests::fake_http::MockServer;
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-g13";
const BRANCH_ID: &str = "22222222-2222-4222-8222-222222222222";
const ORG_ID: &str = "org-g13";
const SUPABASE_ORDER_ID: &str = "22222222-2222-4222-8222-222222222222";
const REMOTE_PAYMENT_ID: &str = "remote-pay-g13";

// (adjustment_id, adjustment_type, amount)
// The idempotency key for each will be `adjustment:<adjustment_id>`.
const ADJUSTMENTS: [(&str, &str, f64); 5] = [
    ("adj-g13-refund-1", "refund", 5.00),
    ("adj-g13-refund-2", "refund", 7.50),
    ("adj-g13-refund-3", "refund", 2.25),
    ("adj-g13-void-1", "void", 40.0),
    ("adj-g13-void-2", "void", 12.0),
];

#[tokio::test]
async fn parity_g13_refund_void_offline_restart_sync_exactly_once() {
    // ---------- Step 1: open TestDb ----------
    let td = TestDb::open();

    // ---------- Step 2: seed parent order/payment + adjustments + parity queue ----------
    {
        let conn = td.state.conn.lock().expect("lock db");

        crate::db::set_setting(&conn, "terminal", "terminal_id", TERMINAL_ID)
            .expect("seed terminal_id");
        crate::db::set_setting(&conn, "terminal", "branch_id", BRANCH_ID).expect("seed branch_id");

        // Parent order — synced, with a non-empty supabase_id.
        // W4e Step 0: dual-populate.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-g13', '[]', 100.0, 10000, 'completed', 'synced', ?1,
                     datetime('now'), datetime('now'))",
            rusqlite::params![SUPABASE_ORDER_ID],
        ).expect("seed order");

        // Parent payment — MUST have sync_state='applied' AND
        // remote_payment_id non-empty, or prepare_adjustment_request
        // will DEFER every row. W4e Step 0: dual-populate.
        conn.execute(
            "INSERT INTO order_payments
               (id, order_id, method, amount, amount_cents, status,
                sync_status, sync_state, remote_payment_id,
                created_at, updated_at)
             VALUES ('pay-g13', 'ord-g13', 'cash', 100.0, 10000, 'completed',
                     'synced', 'applied', ?1,
                     datetime('now'), datetime('now'))",
            rusqlite::params![REMOTE_PAYMENT_ID],
        )
        .expect("seed parent payment");

        for (adj_id, adj_type, amount) in ADJUSTMENTS.iter() {
            // payment_adjustments has FKs on both payment_id and order_id
            // (db.rs:910–911). Both parents ('pay-g13' and 'ord-g13') are
            // seeded above, so the FK is satisfied regardless of whether
            // foreign_keys PRAGMA is ON.
            // W4e Step 0: dual-populate amount + amount_cents (cents
            // computed from the same f64 value via round-half-even).
            let amount_cents = (amount * 100.0_f64).round() as i64;
            conn.execute(
                "INSERT INTO payment_adjustments
                   (id, payment_id, order_id, adjustment_type, amount, amount_cents, reason,
                    sync_state, created_at, updated_at)
                 VALUES (?1, 'pay-g13', 'ord-g13', ?2, ?3, ?4, 'G13 test',
                         'pending', datetime('now'), datetime('now'))",
                rusqlite::params![adj_id, adj_type, amount, amount_cents],
            )
            .expect("seed payment_adjustment");

            let queue_id = format!("q-g13-{adj_id}");
            // Payload mirrors the shape `refunds.rs` writes in
            // production: paymentId, adjustmentType, amount, reason,
            // branch_id.
            let data = format!(
                r#"{{"adjustmentType":"{adj_type}","amount":{amount},"paymentId":"pay-g13","reason":"G13 test","branch_id":"{BRANCH_ID}"}}"#
            );
            conn.execute(
                "INSERT INTO parity_sync_queue
                   (id, table_name, record_id, operation, data, organization_id,
                    created_at, attempts, retry_delay_ms, priority, module_type,
                    conflict_strategy, version, status)
                 VALUES (?1, 'payment_adjustments', ?2, 'INSERT', ?3, ?4, datetime('now'),
                         0, 1000, 0, 'financial', 'manual', 1, 'pending')",
                rusqlite::params![queue_id, adj_id, data, ORG_ID],
            )
            .expect("seed parity_sync_queue row");
        }

        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count pre-restart");
        assert_eq!(pending, 5, "pre-restart: 5 pending adjustments");
    }

    // ---------- Step 3: simulate crash ----------
    let td = td.restart();

    // ---------- Step 4: re-assert survival ----------
    {
        let conn = td.state.conn.lock().expect("lock db");
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count post-restart");
        assert_eq!(pending, 5, "all 5 queue rows survive restart");

        // Verify each adjustment's record_id survives — the idempotency
        // key on the wire will be `adjustment:<record_id>`.
        for (adj_id, _, _) in ADJUSTMENTS.iter() {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue WHERE record_id = ?1",
                    rusqlite::params![adj_id],
                    |row| row.get(0),
                )
                .expect("read queue row");
            assert_eq!(exists, 1, "{adj_id} queue row survives restart");
        }
    }

    // ---------- Step 5/6: spawn MockServer, drive process_queue ----------
    let server = MockServer::new(r#"{"success":true}"#);
    let _kr = fake_keyring::install_seeded([
        ("admin_url", server.url.as_str()),
        ("api_key", "test-api-key-g13"),
    ]);

    let result = sync_queue::process_queue(&td.state.conn, &server.url, "test-api-key-g13")
        .await
        .expect("process_queue succeeds");

    // ---------- Step 7: assertions ----------
    assert_eq!(result.processed, 5, "all 5 adjustments processed");
    assert_eq!(result.failed, 0, "none failed");
    assert_eq!(
        server.count(),
        5,
        "5 distinct adjustment requests (exactly-once)"
    );

    // Every request is a POST to /api/pos/payments/adjustments/sync
    // with `idempotency_key` at body top-level (see
    // build_adjustment_sync_body at sync.rs:9506).
    let recorded = server.recorded();
    let mut recorded_keys: Vec<String> = recorded
        .iter()
        .filter_map(|req| {
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/api/pos/payments/adjustments/sync");
            req.json_body().and_then(|body| {
                body.get("idempotency_key")
                    .and_then(Value::as_str)
                    .map(String::from)
            })
        })
        .collect();
    recorded_keys.sort();
    let mut expected: Vec<String> = ADJUSTMENTS
        .iter()
        .map(|(id, _, _)| format!("adjustment:{id}"))
        .collect();
    expected.sort();
    assert_eq!(
        recorded_keys, expected,
        "every adjustment request carries its record-anchored \
         `adjustment:<id>` key; duplicates or missing keys would \
         indicate parity_sync_queue.id leaking into the wire instead \
         of the entity-stable adjustment id"
    );

    let remaining: i64 = td
        .state
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .expect("count final");
    assert_eq!(remaining, 0, "every queue row removed on success");
}
