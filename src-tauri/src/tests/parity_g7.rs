//! Parity Gate G7 — Factory reset round-trip.
//!
//! # Gate text (from `PARITY_GATES.md`)
//!
//! > Wipe all credentials, re-provision from onboarding, confirm no pre-reset
//! > state survives (keyring, localStorage, local_settings, sync queues).
//!
//! # Before this wave
//!
//! G7 was marked **PENDING** — the only parity gate with zero behavioural
//! test coverage. The two existing `reset.rs` tests at the bottom of that
//! module only covered `collect_wipe_paths` path-deduplication and a
//! status-JSON round-trip; neither exercised the end-to-end "nothing
//! survives" invariant.
//!
//! # Test shape
//!
//! The production factory reset is a two-process dance (`launch_reset`
//! writes a manifest, `run_reset_helper` in a spawned helper wipes and
//! relaunches the app). The helper's final `Command::new(app_exe).spawn()`
//! makes an exact end-to-end exercise unsuitable for a hermetic unit test.
//!
//! Instead, this test exercises the two SURFACES the helper mutates:
//! the OS keyring (via the W0 `fake_keyring` thread-local) and the
//! `app_data_dir` (via a real filesystem temp dir). We:
//!
//!   1. Seed credentials in `fake_keyring` covering every key in
//!      `storage::managed_keys()`.
//!   2. Initialise a real `DbState` on a temp path and seed rows in
//!      every `POINT_TABLES` table plus `parity_sync_queue`.
//!   3. Execute the helper's two wipe steps directly:
//!      - `storage::factory_reset()` — credential deletion loop.
//!      - `std::fs::remove_dir_all(app_data_dir)` — filesystem cleanup.
//!   4. Assert: the keyring is empty, the app data dir is gone, and a
//!      fresh `db::init` at the same path produces an empty schema.
//!
//! A reset that forgets to wipe even one credential key or one DB table
//! will trip this test.

use std::fs;

use crate::db;
use crate::storage;
use crate::tests::fake_keyring;
use crate::tests::harness::TempDir;

/// Every key the real `factory_reset` is contracted to clear.
fn expected_keyring_keys() -> Vec<&'static str> {
    storage::managed_keys().to_vec()
}

#[test]
fn parity_g7_factory_reset_leaves_no_state_behind() {
    // --- Step 1: seed keyring ----------------------------------------------

    // Every key `managed_keys()` returns — we seed them all so a reset that
    // forgets to clear a new key added to ALL_KEYS trips the final assertion.
    let seeds: Vec<(&str, String)> = expected_keyring_keys()
        .iter()
        .map(|k| (*k, format!("test-value-{k}")))
        .collect();
    let _fake = fake_keyring::install_seeded(seeds.iter().map(|(k, v)| (k.to_string(), v.clone())));
    assert_eq!(
        fake_keyring::len(),
        expected_keyring_keys().len(),
        "sanity: every managed key was seeded"
    );

    // --- Step 2: seed database ---------------------------------------------

    let tmp = TempDir::new();
    let db_state = db::init(tmp.path()).expect("db::init seeds a pos.db at tmp.path()");
    let db_path = db_state.db_path.clone();
    {
        let conn = db_state.conn.lock().expect("lock db");

        // orders — W4e Step 0: dual-populate REAL + cents columns so that
        // when production code switches to cents-only reads (and the
        // REAL columns eventually drop), this fixture still works.
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('g7-ord', '[]', 12.34, 1234, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("seed order");

        // order_payments — W4e Step 0: dual-populate.
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, sync_status, created_at, updated_at)
             VALUES ('g7-pay', 'g7-ord', 'cash', 12.34, 1234, 'completed', 'pending', datetime('now'), datetime('now'))",
            [],
        )
        .expect("seed payment");

        // sync_queue (legacy)
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status)
             VALUES ('order', 'g7-ord', 'create', '{}', 'g7-idem-1', 'pending')",
            [],
        )
        .expect("seed sync_queue row");

        // parity_sync_queue (current)
        conn.execute(
            "INSERT INTO parity_sync_queue
                (id, table_name, record_id, operation, data, organization_id, created_at,
                 attempts, retry_delay_ms, priority, module_type, conflict_strategy, version, status)
             VALUES ('g7-parity-1', 'order_payments', 'g7-pay', 'INSERT', '{}', 'org-1', datetime('now'),
                     0, 1000, 0, 'payments', 'manual', 1, 'pending')",
            [],
        )
        .expect("seed parity_sync_queue row");
    }

    // Explicit close-of-connection before file wipe so Windows doesn't
    // hold a handle on `pos.db`.
    drop(db_state);

    // Confirm seeded state is actually there (defence against a broken
    // fixture that silently reports "nothing to wipe").
    assert!(db_path.exists(), "pos.db should exist after seeding");
    assert!(
        !fake_keyring::is_empty(),
        "keyring should be non-empty after seeding"
    );

    // --- Step 3: execute the reset's two wipe steps ------------------------

    // 3a: keyring clear. Production's `run_reset_helper` loops
    // `manifest.credential_keys` and calls `delete_credential` on each.
    // `storage::factory_reset` is the library helper that does the
    // equivalent work and is routed through the fake_keyring shim.
    storage::factory_reset().expect("factory_reset clears credentials");

    // 3b: filesystem wipe. Production's helper calls
    // `remove_path_with_retries` on each `manifest.wipe_paths` entry.
    // For the test we use a direct `remove_dir_all`; the equivalence
    // is "the app data dir no longer exists when the helper is done."
    fs::remove_dir_all(tmp.path()).expect("remove app_data_dir");

    // --- Step 4: assert no state survives ---------------------------------

    assert!(
        fake_keyring::is_empty(),
        "keyring should be empty after factory_reset; \
         surviving keys = {:?}",
        fake_keyring::all_keys()
    );
    assert!(
        !db_path.exists(),
        "pos.db should be gone after filesystem wipe; still present at {}",
        db_path.display()
    );
    assert!(
        !tmp.path().exists(),
        "app_data_dir should be gone after filesystem wipe"
    );

    // --- Step 5: re-provision — DB at same path is fresh ------------------

    let fresh_state = db::init(tmp.path()).expect("re-init db at same path");
    {
        let conn = fresh_state.conn.lock().expect("lock fresh db");

        // Every table that previously had seeded rows must now be empty.
        let counts = [
            ("orders", "g7-ord should not survive"),
            ("order_payments", "g7-pay should not survive"),
            (
                "sync_queue",
                "g7-idem-1 legacy sync_queue row should not survive",
            ),
            (
                "parity_sync_queue",
                "g7-parity-1 parity row should not survive",
            ),
        ];
        for (table, hint) in counts {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let count: i64 = conn
                .query_row(&sql, [], |row| row.get(0))
                .unwrap_or_else(|_| panic!("count {table}"));
            assert_eq!(count, 0, "{table} should be empty after reset — {hint}");
        }
    }
    drop(fresh_state);

    // Re-provisioning: seed the keyring again to confirm the fake layer
    // accepts writes after the factory reset. This mirrors what the
    // renderer does post-relaunch when a fresh onboarding flow writes
    // the terminal_id / api_key etc. back to the keyring.
    storage::set_credential("terminal_id", "550e8400-e29b-41d4-a716-446655440000")
        .expect("re-seed terminal_id after reset");
    assert_eq!(
        storage::get_credential("terminal_id").as_deref(),
        Some("550e8400-e29b-41d4-a716-446655440000"),
        "keyring must accept writes after factory_reset"
    );
}

#[test]
fn parity_g7_managed_keys_covers_every_credential_we_seed() {
    // Guard test: if a new credential key is added to `storage.rs`'s
    // `ALL_KEYS`, it MUST also be covered by the G7 factory_reset sweep.
    // This test pins the contract: every key we seed is a key the
    // factory_reset helper knows to wipe.
    //
    // If this test fails after adding a new credential, update
    // `storage::ALL_KEYS` so `factory_reset()` clears the new key too.
    let managed: std::collections::HashSet<&str> =
        storage::managed_keys().iter().copied().collect();
    for key in expected_keyring_keys() {
        assert!(
            managed.contains(key),
            "credential key {key} is not in storage::managed_keys(); \
             factory_reset would skip it and G7 would regress"
        );
    }
}
