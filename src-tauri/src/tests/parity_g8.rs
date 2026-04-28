//! Parity Gate G8 — payment offline → restart → sync exactly-once.
//!
//! # Gate text (from `PARITY_GATES.md`)
//!
//! > A payment taken while offline survives a process crash and, on
//! > reconnection, is delivered to the server exactly once with a
//! > stable, record-anchored idempotency key.
//!
//! # Why this test uses the legacy `sync_queue`
//!
//! Payments were moved off `parity_sync_queue` in a prior wave — see
//! `payments.rs:978` which deletes any legacy parity rows for the
//! payment table, and `payments.rs:966` which writes to the legacy
//! `sync_queue` via `sync::upsert_payment_sync_queue_row`. Dispatch is
//! via `sync::sync_payment_items`, not `sync_queue::process_queue`.
//!
//! The idempotency key for a payment is `payment:<record_id>`,
//! generated at enqueue time and stored on `sync_queue.idempotency_key`
//! (UNIQUE NOT NULL). Because the key is derived from the payment's
//! primary key — which does not change across a restart — the server
//! dedupes correctly even if the sync cycle runs twice after a crash.
//!
//! # Test shape
//!
//!   1. Open a `TestDb` on a real filesystem path.
//!   2. Seed a parent order with a non-empty `supabase_id` (required
//!      by `sync_payment_items` — it rejects payments whose parent
//!      hasn't synced yet).
//!   3. Seed 5 `order_payments` rows (FK to the parent order).
//!   4. Seed 5 matching legacy `sync_queue` rows with
//!      `entity_type = 'payment'` and stable keys.
//!   5. Call `TestDb::restart` — simulates a process crash.
//!   6. Assert all 5 queue rows + their idempotency keys survived.
//!   7. Spawn a `MockServer`, install `fake_keyring`, and drive
//!      `sync::dispatch_pending_payments_for_test` (a `#[cfg(test)]
//!      pub(crate)` wrapper around the private `sync_payment_items`).
//!   8. Assert `server.count() == 5` and every recorded request's
//!      body carries its expected `payment:<id>` key at
//!      `body.idempotency_key` (top-level — `sync_payment_items`
//!      does not use the financial `items[0]` envelope).
//!   9. Assert every queue row moved to `status = 'synced'`.

use serde_json::Value;

use crate::sync;
use crate::tests::fake_http::MockServer;
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-g8";
const BRANCH_ID: &str = "11111111-1111-4111-8111-111111111111";
const SUPABASE_ORDER_ID: &str = "11111111-1111-4111-8111-111111111111";

// (payment_id, expected idempotency_key)
// The key format matches what `sync::upsert_payment_sync_queue_row`
// generates in production: `format!("payment:{payment_id}")`.
const PAYMENTS: [(&str, &str); 5] = [
    ("pay-g8-a", "payment:pay-g8-a"),
    ("pay-g8-b", "payment:pay-g8-b"),
    ("pay-g8-c", "payment:pay-g8-c"),
    ("pay-g8-d", "payment:pay-g8-d"),
    ("pay-g8-e", "payment:pay-g8-e"),
];

#[tokio::test]
async fn parity_g8_payment_offline_restart_sync_exactly_once() {
    // ---------- Step 1: open TestDb ----------
    let td = TestDb::open();

    // ---------- Step 2-4: seed order + payments + legacy sync_queue rows ----------
    {
        let conn = td.state.conn.lock().expect("lock db");

        crate::db::set_setting(&conn, "terminal", "terminal_id", TERMINAL_ID)
            .expect("seed terminal_id");
        crate::db::set_setting(&conn, "terminal", "branch_id", BRANCH_ID).expect("seed branch_id");

        // Parent order with a non-empty supabase_id — sync_payment_items
        // DEFERS any payment whose parent order has `supabase_id IS NULL`.
        // W4e Step 0: dual-populate REAL + cents columns.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, supabase_id, created_at, updated_at)
             VALUES ('ord-g8', '[]', 50.0, 5000, 'completed', 'synced', ?1, datetime('now'), datetime('now'))",
            rusqlite::params![SUPABASE_ORDER_ID],
        ).expect("seed order");

        for (pay_id, key) in PAYMENTS.iter() {
            // W4e Step 0: dual-populate amount + amount_cents.
            conn.execute(
                "INSERT INTO order_payments
                   (id, order_id, method, amount, amount_cents, status,
                    sync_status, sync_state, created_at, updated_at)
                 VALUES (?1, 'ord-g8', 'cash', 10.0, 1000, 'completed',
                         'pending', 'pending', datetime('now'), datetime('now'))",
                rusqlite::params![pay_id],
            )
            .expect("seed order_payment");

            let payload = format!(
                r#"{{"paymentId":"{pay_id}","orderId":"ord-g8","method":"cash","amount":10.0}}"#
            );
            conn.execute(
                "INSERT INTO sync_queue
                   (entity_type, entity_id, operation, payload,
                    idempotency_key, status, retry_count, max_retries,
                    created_at)
                 VALUES ('payment', ?1, 'insert', ?2, ?3, 'pending',
                         0, 5, datetime('now'))",
                rusqlite::params![pay_id, payload, key],
            )
            .expect("seed sync_queue payment row");
        }

        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue
             WHERE entity_type = 'payment' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count pre-restart");
        assert_eq!(pending, 5, "pre-restart: 5 pending payment rows");
    }

    // ---------- Step 5: simulate process crash ----------
    let td = td.restart();

    // ---------- Step 6: re-assert survival + key stability ----------
    {
        let conn = td.state.conn.lock().expect("lock db");
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue
             WHERE entity_type = 'payment' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count post-restart");
        assert_eq!(pending, 5, "all 5 legacy queue rows must survive restart");

        for (pay_id, expected_key) in PAYMENTS.iter() {
            let actual: String = conn
                .query_row(
                    "SELECT idempotency_key FROM sync_queue
                 WHERE entity_type = 'payment' AND entity_id = ?1",
                    rusqlite::params![pay_id],
                    |row| row.get(0),
                )
                .expect("read idempotency_key");
            assert_eq!(
                &actual, expected_key,
                "idempotency_key for {pay_id} must survive restart"
            );
        }
    }

    // ---------- Step 7: spawn MockServer + drive dispatch ----------
    let server = MockServer::new(r#"{"success":true,"data":{"id":"remote-pay-id"}}"#);
    let _kr = fake_keyring::install_seeded([
        ("admin_url", server.url.as_str()),
        ("api_key", "test-api-key-g8"),
        ("terminal_id", TERMINAL_ID),
    ]);

    let synced = sync::dispatch_pending_payments_for_test(
        &server.url,
        "test-api-key-g8",
        TERMINAL_ID,
        &td.state,
    )
    .await;

    // ---------- Step 8: assertions ----------
    assert_eq!(synced, 5, "all 5 payments dispatched");
    assert_eq!(
        server.count(),
        5,
        "server received exactly 5 POSTs (exactly-once)"
    );

    // Every request is a POST to /api/pos/payments with
    // `idempotency_key` at body top-level (see sync.rs:12192).
    let recorded = server.recorded();
    let mut recorded_keys: Vec<String> = recorded
        .iter()
        .filter_map(|req| {
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/api/pos/payments");
            req.json_body().and_then(|body| {
                body.get("idempotency_key")
                    .and_then(Value::as_str)
                    .map(String::from)
            })
        })
        .collect();
    recorded_keys.sort();
    let mut expected: Vec<String> = PAYMENTS.iter().map(|(_, k)| k.to_string()).collect();
    expected.sort();
    assert_eq!(
        recorded_keys, expected,
        "every dispatched request carried its expected record-anchored \
         idempotency key; duplicates or missing keys would indicate \
         the key not flowing from sync_queue.idempotency_key to the wire"
    );

    // ---------- Step 9: assert queue rows are now synced ----------
    let synced_count: i64 = td
        .state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sync_queue
         WHERE entity_type = 'payment' AND status = 'synced'",
            [],
            |row| row.get(0),
        )
        .expect("count synced");
    assert_eq!(synced_count, 5, "all 5 queue rows moved to 'synced'");
}
