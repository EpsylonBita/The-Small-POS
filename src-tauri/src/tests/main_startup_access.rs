//! Actual cold-start access reconciliation with file SQLite and fake keyring.
use super::*;
use crate::tests::{fake_http::MockServer, fake_keyring, harness::TestDb};
use serde_json::{json, Value};

const ORG: &str = "11111111-1111-4111-8111-111111111111";
const BRANCH: &str = "22222222-2222-4222-8222-222222222222";
const TERMINAL: &str = "main-startup-access-fixture";

fn wire(enabled: bool) -> Value {
    json!({ "success": true, "organization_id": ORG, "branch_id": BRANCH,
        "terminal_id": TERMINAL, "terminal": { "id": TERMINAL,
            "organization_id": ORG, "branch_id": BRANCH, "terminal_type": "main",
            "source_terminal_id": TERMINAL, "owner_terminal_id": TERMINAL,
            "pos_operating_mode": "main_isolated" },
        "modules": if enabled { vec![json!({ "module_id": "repairs" })] } else { vec![] } })
}

fn fixture(url: &str, pending: bool, mirrors: bool) -> (fake_keyring::Guard, TestDb) {
    let scope = json!({ "version": 1, "organization_id": ORG, "branch_id": BRANCH,
        "terminal_id": TERMINAL, "scope_token": "33333333-3333-4333-8333-333333333333",
        "scope_epoch": 398, "transition_pending": pending, "reset_pending": false,
        "offline_terminal_token": null, "offline_sequence_lease_start": null, "offline_sequence_lease_end": null });
    let keys = fake_keyring::install_seeded([
        ("organization_id", ORG),
        ("branch_id", BRANCH),
        ("terminal_id", TERMINAL),
        ("admin_dashboard_url", url),
        ("pos_api_key", "fixture-original-key"),
        (
            crate::storage::KEY_REPAIR_SCOPE_V1,
            scope.to_string().as_str(),
        ),
    ]);
    let database = TestDb::open();
    {
        let conn = database.state.conn.lock().unwrap();
        if mirrors {
            for (key, value) in [
                ("organization_id", ORG),
                ("branch_id", BRANCH),
                ("terminal_id", TERMINAL),
                ("admin_dashboard_url", url),
            ] {
                crate::db::set_setting(&conn, "terminal", key, value).unwrap();
            }
        }
        for index in 0..6 {
            conn.execute("INSERT INTO orders (id, items, total_amount, total_amount_cents, currency, status,
                created_at, updated_at) VALUES (?1, '[{\"id\":\"original-line\"}]', 69, 6900, 'CHF', 'pending',
                '2026-10-09T20:00:00Z', '2026-10-09T20:00:00Z')", [format!("original-order-{index}")]).unwrap();
        }
        conn.execute("INSERT INTO staff_shifts (id, staff_id, branch_id, terminal_id, role_type, check_in_time, status, currency, created_at, updated_at)
            VALUES ('original-cashier-shift', 'original-cashier', ?1, ?2, 'cashier', '2026-10-09T20:00:00Z', 'active', 'CHF',
                '2026-10-09T20:00:00Z', '2026-10-09T20:00:00Z')",
            rusqlite::params![BRANCH, TERMINAL]).unwrap();
        for index in 0..4 {
            conn.execute("INSERT INTO order_payments (id, order_id, method, amount, currency, status, staff_id,
                staff_shift_id, idempotency_key, metadata, created_at, updated_at)
                VALUES (?1, ?2, 'cash', 10.5, 'CHF', ?3, 'original-cashier', 'original-cashier-shift', ?4,
                '{\"staff_id\":\"original-cashier\",\"staff_shift_id\":\"original-cashier-shift\"}',
                '2026-10-09T20:01:00Z', '2026-10-09T20:01:00Z')",
                rusqlite::params![format!("original-payment-{index}"), format!("original-order-{index}"),
                    if index == 0 { "refunded" } else { "completed" }, format!("original-payment-key-{index}")]).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type,
            amount, amount_cents, reason, created_at, updated_at) VALUES
            ('original-refund', 'original-payment-0', 'original-order-0', 'refund', 10.5, 1050,
            'Original refund', '2026-10-09T20:02:00Z', '2026-10-09T20:02:00Z');",
        )
        .unwrap();
        conn.execute_batch("CREATE TABLE table_attempt_recovery_v1 (id TEXT PRIMARY KEY, request_json TEXT);
            INSERT INTO table_attempt_recovery_v1 VALUES ('f501-original', '{\"event\":\"f501\",\"currency\":\"CHF\",\"amount_cents\":6900,\"approval\":\"original\"}');
            INSERT INTO table_attempt_recovery_v1 VALUES ('f7-original', '{\"event\":\"f7\",\"action\":\"whole_order_cancel\",\"approval\":\"original\"}');").unwrap();
    }
    (keys, database)
}

fn protected(database: &TestDb) -> Vec<Vec<Vec<String>>> {
    let conn = database.state.conn.lock().unwrap();
    [
        "orders",
        "order_payments",
        "staff_shifts",
        "payment_adjustments",
        "parity_sync_queue",
        "sync_queue",
        "table_attempt_recovery_v1",
    ]
    .into_iter()
    .map(|table| {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let count = stmt.column_count();
        stmt.query_map([], |row| {
            Ok((0..count)
                .map(|index| format!("{:?}", row.get::<_, rusqlite::types::Value>(index).unwrap()))
                .collect::<Vec<_>>())
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    })
    .collect()
}

fn binding() -> Vec<Option<String>> {
    [
        "organization_id",
        "branch_id",
        "terminal_id",
        "admin_dashboard_url",
        "pos_api_key",
    ]
    .into_iter()
    .map(|key| {
        crate::storage::get_credential_strict(key)
            .unwrap()
            .map(|value| value.to_string())
    })
    .collect()
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_legacy_pending_reverifies_actual_owner_with_absent_mirrors_and_preserves_money(
) {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let server = MockServer::new(wire(false).to_string());
    let (_keys, database) = fixture(&server.url, true, false);
    let original = protected(&database);
    let keys = binding();
    let database = database.restart();
    lifecycle.reset();
    assert!(terminal_connection_rebind_pending(&database.state).unwrap());
    let result = reconcile_startup_terminal_binding_with_access(&database.state).await;
    assert_eq!(
        result,
        Ok(Some(TERMINAL.to_string())),
        "same managed scope must be reverified by its owner, never re-bound"
    );
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
    assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
    let requests = server.recorded();
    assert!(requests
        .iter()
        .any(|request| request.path.starts_with("/api/pos/settings/")));
    assert!(requests
        .iter()
        .any(|request| request.path.starts_with("/api/pos/modules/enabled")));
    assert!(requests.iter().all(|request| request.method == "GET"
        && request.body.is_empty()
        && request.header("x-terminal-id") == Some(TERMINAL)));
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_actual_same_identity_failure_then_restart_never_requires_terminal_candidate(
) {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let server = MockServer::new(wire(false).to_string());
    let (_keys, database) = fixture(&server.url, false, true);
    let original = protected(&database);
    let keys = binding();
    {
        let conn = database.state.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TRIGGER interrupt_same_access BEFORE INSERT ON local_settings
            WHEN NEW.setting_category='terminal' AND NEW.setting_key='terminal_id'
            BEGIN SELECT RAISE(ABORT, 'fixture access mirror failure'); END;",
        )
        .unwrap();
    }
    let decision = crate::repairs::start_authoritative_access_decision().unwrap();
    assert!(crate::repairs::begin_authoritative_access_reconciliation(
        &database.state,
        ORG,
        BRANCH,
        TERMINAL,
        true,
        decision
    )
    .is_err());
    // Π1: the half-finished decision leaves Repairs pending and denied, never
    // a terminal rebind that refuses every admin call and ordinary sale.
    assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
    drop(crate::repairs::acquire_terminal_binding_lease().expect("ordinary sales stay admitted"));
    assert!(crate::repairs::access_reconciliation_pending().unwrap());
    assert_eq!(binding(), keys);
    assert_eq!(protected(&database), original);
    {
        let conn = database.state.conn.lock().unwrap();
        assert!(
            crate::db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY)
                .is_none()
        );
        conn.execute_batch("DROP TRIGGER interrupt_same_access;")
            .unwrap();
    }
    let database = database.restart();
    lifecycle.reset();
    assert_eq!(
        reconcile_startup_terminal_binding_with_access(&database.state).await,
        Ok(Some(TERMINAL.to_string()))
    );
    assert_eq!(binding(), keys);
    assert_eq!(protected(&database), original);
}

fn scope_json() -> Value {
    serde_json::from_str(&fake_keyring::get(crate::storage::KEY_REPAIR_SCOPE_V1).unwrap()).unwrap()
}

fn replace_scope(value: &Value) {
    assert!(fake_keyring::set(
        crate::storage::KEY_REPAIR_SCOPE_V1,
        &value.to_string()
    ));
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_enabled_without_staff_admits_pos_but_defers_repairs_and_janitor() {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let server = MockServer::new(wire(true).to_string());
    let (_keys, database) = fixture(&server.url, true, false);
    let original = protected(&database);
    let keys = binding();
    let restores = std::cell::Cell::new(0);
    crate::reconcile_native_startup(&database.state, || {
        restores.set(restores.get() + 1);
        assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
        let authority = resolve_strict_terminal_authority(&database.state)
            .unwrap()
            .unwrap();
        verify_complete_sqlite_binding_mirror(&database.state, &authority.binding).unwrap();
        assert!(crate::repairs::acquire_terminal_binding_lease().is_ok());
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(restores.get(), 1);
    assert!(scope_json()["transition_pending"].as_bool().unwrap());
    assert_eq!(scope_json()["scope_epoch"], 398);
    assert_eq!(
        scope_json()["scope_token"],
        "33333333-3333-4333-8333-333333333333"
    );
    {
        let connection = database.state.conn.lock().unwrap();
        assert!(crate::repairs::acquire_renderer_access(&connection).is_err());
        assert_eq!(
            crate::repairs::run_startup_staging_janitor(&connection).unwrap(),
            crate::repairs::RepairStagingJanitorReport::default()
        );
    }
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
    assert_eq!(server.count(), 2);
    assert!(server
        .recorded()
        .iter()
        .all(|request| request.method == "GET"));
    let database = database.restart();
    lifecycle.reset();
    reconcile_startup_terminal_binding_with_access(&database.state)
        .await
        .unwrap();
    assert_eq!(
        server.count(),
        2,
        "an exact previously verified purpose rehydrates generic POS offline without granting Repairs"
    );
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_legacy_startup_failure_never_restores_transport() {
    let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let mut response = wire(false);
    response["organization_id"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    response["terminal"]["organization_id"] = response["organization_id"].clone();
    let server = MockServer::new(response.to_string());
    let (_keys, database) = fixture(&server.url, true, false);
    let original = protected(&database);
    let keys = binding();
    let before_scope = scope_json();
    let restores = std::cell::Cell::new(0);
    assert!(
        crate::reconcile_native_startup(&database.state, || restores.set(restores.get() + 1))
            .await
            .is_err()
    );
    assert_eq!(restores.get(), 0);
    assert_eq!(server.count(), 1);
    assert!(terminal_connection_rebind_pending(&database.state).unwrap());
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
    // A legacy pending scope has no purpose, so it stays a fail-closed
    // binding marker exactly as stored until a full answer replaces it.
    assert_eq!(scope_json(), before_scope);
    assert!(
        reconcile_startup_terminal_binding_with_access(&database.state)
            .await
            .is_err()
    );
    assert!(terminal_connection_rebind_pending(&database.state).unwrap());
    assert_eq!(scope_json(), before_scope);
}

fn pending_access_purpose(verified: bool) {
    let mut scope = scope_json();
    scope["pending_purpose"] = json!({
        "kind": "access_reconciliation",
        "binding_digest": current_access_binding_digest().unwrap().unwrap(),
        "verified": verified,
    });
    replace_scope(&scope);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_failed_access_recovery_still_restores_transport_and_respects_its_gate()
{
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let mut response = wire(false);
    response["organization_id"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    response["terminal"]["organization_id"] = response["organization_id"].clone();
    let server = MockServer::new(response.to_string());
    let (_keys, database) = fixture(&server.url, true, true);
    pending_access_purpose(false);
    let original = protected(&database);
    let keys = binding();
    let restores = std::cell::Cell::new(0);
    let janitor = crate::reconcile_native_startup(&database.state, || {
        restores.set(restores.get() + 1);
        assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
        assert!(crate::repairs::acquire_terminal_binding_lease().is_ok());
    })
    .await
    .expect("a Repairs access failure never fails the binding");
    assert!(
        janitor.is_ok(),
        "a pending access decision defers the janitor"
    );
    assert_eq!(restores.get(), 1, "the waiters' LAN receiver must come up");
    assert_eq!(server.count(), 1);
    assert!(crate::repairs::lifecycle_snapshot_for_test().access_blocked);
    {
        let connection = database.state.conn.lock().unwrap();
        assert!(crate::repairs::acquire_renderer_access(&connection).is_err());
    }
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
    // The durable retry gate still holds the next attempt off the server.
    lifecycle.reset();
    assert_eq!(
        reconcile_startup_terminal_binding_with_access(&database.state).await,
        Ok(Some(TERMINAL.to_string()))
    );
    assert_eq!(
        server.count(),
        1,
        "failed recovery must respect its durable retry gate"
    );
    assert!(crate::repairs::acquire_terminal_binding_lease().is_ok());
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_unverified_access_offline_restart_admits_sales_and_denies_repairs() {
    let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
    // Every request answers 500: the store is offline or the server is down.
    let server = ScriptedReplies::new(vec![]);
    let (_keys, database) = fixture(&server.url, true, true);
    pending_access_purpose(false);
    let original = protected(&database);
    let keys = binding();
    let database = database.restart();
    let restores = std::cell::Cell::new(0);
    let janitor =
        crate::reconcile_native_startup(&database.state, || restores.set(restores.get() + 1))
            .await
            .expect("the binding is healthy");
    assert!(janitor.is_ok());
    assert_eq!(restores.get(), 1, "the transport restore callback must run");
    assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
    let lease = crate::repairs::acquire_terminal_binding_lease().expect("sales are admitted");
    assert_eq!(
        lease.generation(),
        0,
        "nothing moved the binding generation"
    );
    drop(lease);
    {
        let connection = database.state.conn.lock().unwrap();
        assert!(
            crate::repairs::acquire_renderer_access(&connection).is_err(),
            "Repairs is denied"
        );
    }
    assert!(crate::repairs::access_reconciliation_pending().unwrap());
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_real_intents_corruption_missing_credentials_and_mixed_mirrors_stay_closed(
) {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    for case in [
        "reset",
        "clear",
        "identity",
        "unknown",
        "wrong_scope",
        "missing_key",
        "keyring_failure",
        "mixed_mirror",
        "terminal_marker",
        "terminal_candidate",
        "repair_journal",
        "maintenance",
    ] {
        lifecycle.reset();
        let server = MockServer::new(wire(false).to_string());
        let (_keys, database) = fixture(&server.url, true, false);
        let mut scope = scope_json();
        match case {
            "reset" => scope["reset_pending"] = json!(true),
            "clear" => scope["pending_purpose"] = json!({"kind":"operational_clear"}),
            "identity" => scope["pending_purpose"] = json!({"kind":"identity_transition"}),
            "unknown" => scope["pending_purpose"] = json!({"kind":"invented_unknown_reason"}),
            "wrong_scope" => scope["branch_id"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            "missing_key" => {
                fake_keyring::delete("pos_api_key");
            }
            "keyring_failure" => {
                fake_keyring::fail_reads_for("pos_api_key", "fixture keyring locked")
            }
            "mixed_mirror" => {
                let conn = database.state.conn.lock().unwrap();
                crate::db::set_setting(
                    &conn,
                    "terminal",
                    "branch_id",
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                )
                .unwrap();
            }
            "terminal_marker" | "terminal_candidate" => {
                let conn = database.state.conn.lock().unwrap();
                crate::db::set_setting(
                    &conn,
                    "sync",
                    if case == "terminal_marker" {
                        TERMINAL_CONNECTION_REBIND_PENDING_KEY
                    } else {
                        TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY
                    },
                    if case == "terminal_marker" {
                        "1"
                    } else {
                        "not-valid-journal"
                    },
                )
                .unwrap();
            }
            "repair_journal" => {
                assert!(fake_keyring::set(
                    crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1,
                    "not-valid-journal"
                ));
            }
            "maintenance" => crate::repairs::latch_startup_binding_maintenance_failure(),
            _ => unreachable!(),
        }
        replace_scope(&scope);
        let original = protected(&database);
        let before_scope = scope_json();
        assert!(
            reconcile_startup_terminal_binding_with_access(&database.state)
                .await
                .is_err(),
            "case {case} unexpectedly admitted"
        );
        assert_eq!(
            server.count(),
            0,
            "case {case} must not perform recovery traffic"
        );
        assert_eq!(protected(&database), original);
        assert_eq!(scope_json(), before_scope);
    }
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_api_key_change_denies_repairs_but_origin_change_stays_closed() {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    for key in ["pos_api_key", "admin_dashboard_url"] {
        lifecycle.reset();
        let server = MockServer::new(wire(false).to_string());
        let (_keys, database) = fixture(&server.url, false, true);
        let decision = crate::repairs::start_authoritative_access_decision().unwrap();
        crate::repairs::begin_authoritative_access_reconciliation(
            &database.state,
            ORG,
            BRANCH,
            TERMINAL,
            true,
            decision,
        )
        .unwrap();
        assert!(fake_keyring::set(
            key,
            if key == "pos_api_key" {
                "fixture-new-key"
            } else {
                "https://changed.invalid"
            }
        ));
        let original = protected(&database);
        let before_scope = scope_json();
        let result = reconcile_startup_terminal_binding_with_access(&database.state).await;
        if key == "pos_api_key" {
            // Π1: an API-key-only rotation is not a binding change, and the
            // pending Repairs decision's digest no longer gates the binding.
            assert_eq!(result, Ok(Some(TERMINAL.to_string())));
            assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
            assert!(crate::repairs::acquire_terminal_binding_lease().is_ok());
            assert!(crate::repairs::lifecycle_snapshot_for_test().access_blocked);
        } else {
            // A changed origin contradicts the SQLite mirror: the binding
            // owner keeps failing closed.
            assert!(result.is_err(), "case {key}");
        }
        assert_eq!(server.count(), 0);
        assert_eq!(protected(&database), original);
        assert_eq!(scope_json(), before_scope);
    }
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_identity_or_later_denial_during_get_cannot_publish_old_reply() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    for case in [
        "organization_id",
        "branch_id",
        "terminal_id",
        "admin_dashboard_url",
        "pos_api_key",
        "scope",
        "later_denial",
    ] {
        lifecycle.reset();
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let server = MockServer::new_with_request_hook(wire(false).to_string(), {
            let entered = entered.clone();
            let release = release.clone();
            move || {
                entered.store(true, Ordering::SeqCst);
                let limit = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while !release.load(Ordering::SeqCst) && std::time::Instant::now() < limit {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        });
        let (_keys, database) = fixture(&server.url, true, false);
        let original = protected(&database);
        let (result, ()) = tokio::join!(
            reconcile_startup_terminal_binding_with_access(&database.state),
            async {
                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    while !entered.load(Ordering::SeqCst) {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                match case {
                    "scope" => {
                        let mut value = scope_json();
                        value["scope_epoch"] = json!(399);
                        replace_scope(&value);
                    }
                    "later_denial" => {
                        let later = crate::repairs::start_authoritative_access_decision().unwrap();
                        crate::repairs::latch_authoritative_access_pending(later).unwrap();
                    }
                    key => {
                        fake_keyring::set(
                            key,
                            match key {
                                "organization_id" | "branch_id" => {
                                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                                }
                                "terminal_id" => "other-terminal",
                                "admin_dashboard_url" => "https://changed.invalid",
                                _ => "fixture-other-key",
                            },
                        );
                    }
                }
                release.store(true, Ordering::SeqCst);
            }
        );
        assert!(
            result.is_err(),
            "case {case} published an obsolete response"
        );
        assert_eq!(server.count(), 1);
        assert_eq!(protected(&database), original);
        assert!(terminal_connection_rebind_pending(&database.state).unwrap());
    }
}

struct ScriptedReplies {
    url: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    calls: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl ScriptedReplies {
    fn new(replies: Vec<(u16, Value)>) -> Self {
        use std::io::{Read, Write};
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let worker = {
            let stop = stop.clone();
            let calls = calls.clone();
            std::thread::spawn(move || {
                let mut replies = replies.into_iter();
                while !stop.load(Ordering::SeqCst) {
                    if let Ok((mut stream, _)) = listener.accept() {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                            .unwrap();
                        let mut request = [0u8; 8192];
                        let read = stream.read(&mut request).unwrap_or(0);
                        calls.lock().unwrap().push(
                            String::from_utf8_lossy(&request[..read])
                                .lines()
                                .next()
                                .unwrap_or("")
                                .to_string(),
                        );
                        let (status, body) =
                            replies.next().unwrap_or((500, json!({"success":false})));
                        let body = body.to_string();
                        let response=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        let _ = stream.write_all(response.as_bytes());
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                }
            })
        };
        Self {
            url,
            stop,
            calls,
            worker: Some(worker),
        }
    }
}
impl Drop for ScriptedReplies {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_verified_pending_file_restart_preserves_offline_pos_admission() {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let server = ScriptedReplies::new(vec![
        (200, wire(true)),
        (200, wire(true)),
        (403, json!({"success":false})),
    ]);
    let (_keys, database) = fixture(&server.url, true, false);
    let original = protected(&database);
    let keys = binding();
    reconcile_startup_terminal_binding_with_access(&database.state)
        .await
        .unwrap();
    assert!(scope_json()["pending_purpose"]["verified"]
        .as_bool()
        .unwrap());
    assert!(
        super::super::modules::fetch_bound_repair_access(
            &server.url,
            "fixture-original-key",
            TERMINAL
        )
        .await
        .is_err(),
        "fixture must prove the endpoint is now denied"
    );
    assert_eq!(server.calls.lock().unwrap().len(), 3);
    let outage = crate::repairs::start_authoritative_access_decision().unwrap();
    assert!(
        crate::repairs::retain_verified_access_after_network_failure(&database.state, outage)
            .is_err(),
        "Repairs remains unavailable during the outage"
    );
    assert!(
        crate::repairs::acquire_terminal_binding_lease().is_ok(),
        "generic admission is retained by the same exact verified purpose"
    );
    let before_scope = scope_json();
    let database = database.restart();
    lifecycle.reset();
    assert_eq!(
        reconcile_startup_terminal_binding_with_access(&database.state).await,
        Ok(Some(TERMINAL.to_string())),
        "a verified unchanged terminal can resume ordinary POS offline while Repairs awaits staff"
    );
    assert_eq!(
        server.calls.lock().unwrap().len(),
        3,
        "verified-purpose restart performs no new fetch"
    );
    assert_eq!(scope_json(), before_scope);
    assert!(crate::repairs::acquire_terminal_binding_lease().is_ok());
    let connection = database.state.conn.lock().unwrap();
    assert!(crate::repairs::acquire_renderer_access(&connection).is_err());
    drop(connection);
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
}

#[test]
#[serial_test::serial]
fn main_startup_access_module_publication_rejects_key_changed_after_caller_check() {
    let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let server = MockServer::new(wire(true).to_string());
    let (_keys, database) = fixture(&server.url, false, true);
    let decision = crate::repairs::start_authoritative_access_decision().unwrap();
    let digest = current_access_binding_digest().unwrap();
    assert_eq!(
        digest,
        current_access_binding_digest().unwrap(),
        "the caller's comparison initially passed"
    );
    assert!(fake_keyring::set("pos_api_key", "fixture-later-key"));
    let original = protected(&database);
    let before_scope = scope_json();
    assert!(
        crate::repairs::begin_bound_authoritative_access_reconciliation(
            &database.state,
            ORG,
            BRANCH,
            TERMINAL,
            true,
            decision,
            digest.as_deref()
        )
        .is_err(),
        "the locked owner must reject the old reply before pending publication"
    );
    assert_eq!(protected(&database), original);
    assert_eq!(scope_json(), before_scope);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_later_module_denial_is_durable_for_repairs_only() {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let server = ScriptedReplies::new(vec![
        (200, wire(true)),
        (200, wire(true)),
        (403, json!({"success":false})),
    ]);
    let (_keys, database) = fixture(&server.url, true, false);
    reconcile_startup_terminal_binding_with_access(&database.state)
        .await
        .unwrap();
    let original = protected(&database);
    let keys = binding();
    let later = crate::repairs::start_authoritative_access_decision().unwrap();
    crate::repairs::latch_authoritative_access_pending(later).unwrap();
    assert_eq!(
        scope_json()["pending_purpose"]["verified"],
        false,
        "a newer denial must invalidate the persisted offline-admission proof"
    );
    let database = database.restart();
    lifecycle.reset();
    // Π1: the restart's recovery meets the denial (403) and Repairs stays
    // closed; the binding itself is healthy and admits ordinary sales.
    assert_eq!(
        reconcile_startup_terminal_binding_with_access(&database.state).await,
        Ok(Some(TERMINAL.to_string()))
    );
    assert_eq!(server.calls.lock().unwrap().len(), 3);
    assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
    assert!(crate::repairs::acquire_terminal_binding_lease().is_ok());
    assert_eq!(scope_json()["pending_purpose"]["verified"], false);
    {
        let connection = database.state.conn.lock().unwrap();
        assert!(crate::repairs::acquire_renderer_access(&connection).is_err());
    }
    assert_eq!(protected(&database), original);
    assert_eq!(binding(), keys);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_module_denial_wrong_scope_malformed_or_redirect_cannot_enable_pos() {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    for case in [
        "401",
        "403",
        "redirect",
        "wrong_scope",
        "missing_modules",
        "success_false",
    ] {
        lifecycle.reset();
        let mut modules = wire(false);
        let status = match case {
            "401" => 401,
            "403" => 403,
            "redirect" => 302,
            _ => 200,
        };
        match case {
            "wrong_scope" => modules["branch_id"] = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            "missing_modules" => {
                modules.as_object_mut().unwrap().remove("modules");
            }
            "success_false" => modules["success"] = json!(false),
            _ => {}
        }
        let server = ScriptedReplies::new(vec![(200, wire(false)), (status, modules)]);
        let (_keys, database) = fixture(&server.url, true, false);
        let original = protected(&database);
        let keys = binding();
        let result = reconcile_startup_terminal_binding_with_access(&database.state).await;
        assert!(result.is_err(), "case {case}");
        assert!(terminal_connection_rebind_pending(&database.state).unwrap());
        assert_eq!(protected(&database), original);
        assert_eq!(binding(), keys);
        let calls = server.calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "case {case}: {result:?}");
        assert!(calls.iter().all(|line| line.starts_with("GET ")));
    }
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_janitor_failure_denies_repairs_but_restores_transport() {
    let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let server = MockServer::new(wire(false).to_string());
    let (_keys, database) = fixture(&server.url, false, true);
    // The staging root is unusable: the Repairs janitor cannot run.
    std::fs::write(database.dir().join("repair-staging-v1"), b"not a directory").unwrap();
    let restores = std::cell::Cell::new(0);
    let janitor =
        crate::reconcile_native_startup(&database.state, || restores.set(restores.get() + 1))
            .await
            .expect("a Repairs janitor failure never fails the binding");
    assert_eq!(janitor.unwrap_err(), "REPAIR_STAGING_PATH_UNSAFE");
    assert_eq!(restores.get(), 1, "the waiters' LAN receiver must come up");
    let lifecycle = crate::repairs::lifecycle_snapshot_for_test();
    assert!(lifecycle.repair_maintenance_failed);
    assert!(!lifecycle.binding_blocked && !lifecycle.binding_maintenance_failed);
    assert!(crate::repairs::acquire_terminal_binding_lease().is_ok());
    assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
    assert_eq!(server.count(), 0);
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_unreadable_scope_denies_repairs_without_latching_binding() {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    for case in ["read_failure", "corrupt_json"] {
        lifecycle.reset();
        let server = MockServer::new(wire(false).to_string());
        let (_keys, database) = fixture(&server.url, true, true);
        pending_access_purpose(false);
        let original = protected(&database);
        let keys = binding();
        let generation = crate::repairs::acquire_terminal_binding_lease()
            .unwrap()
            .generation();
        if case == "read_failure" {
            fake_keyring::fail_reads_for(
                crate::storage::KEY_REPAIR_SCOPE_V1,
                "fixture scope locked",
            );
        } else {
            assert!(fake_keyring::set(
                crate::storage::KEY_REPAIR_SCOPE_V1,
                "not-json"
            ));
        }
        // Keep the failure active across both admission checks and startup.
        assert!(
            terminal_connection_rebind_pending(&database.state).is_err(),
            "{case}"
        );
        assert!(matches!(
            crate::resolve_admin_endpoint(Some(&database.state)).await,
            Err(error) if error.renderer_endpoint_error_code() == Some("TERMINAL_REBIND_PENDING")
        ));
        let restores = std::cell::Cell::new(0);
        let janitor = crate::reconcile_native_startup(&database.state, || {
            restores.set(restores.get() + 1);
            assert_eq!(
                crate::repairs::acquire_terminal_binding_lease()
                    .unwrap()
                    .generation(),
                generation,
                "{case}"
            );
            assert!(crate::repairs::acquire_transport_lease().is_err());
        })
        .await
        .unwrap_or_else(|error| panic!("{case}: Repairs scope failed the binding: {error}"));
        assert!(
            janitor.is_err(),
            "the unreadable scope must fail Repairs maintenance"
        );
        assert_eq!(restores.get(), 1, "{case}");
        assert_eq!(
            crate::repairs::acquire_terminal_binding_lease()
                .unwrap()
                .generation(),
            generation,
            "{case}"
        );
        assert!(crate::repairs::acquire_transport_lease().is_err());
        assert!(
            terminal_connection_rebind_pending(&database.state).is_err(),
            "{case}"
        );
        assert!(matches!(
            crate::resolve_admin_endpoint(Some(&database.state)).await,
            Err(error) if error.renderer_endpoint_error_code() == Some("TERMINAL_REBIND_PENDING")
        ));
        let state = crate::repairs::lifecycle_snapshot_for_test();
        assert!(state.repair_maintenance_failed);
        assert!(!state.binding_blocked && !state.binding_maintenance_failed);
        if case == "read_failure" {
            assert!(
                crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1).is_err()
            );
        } else {
            assert_eq!(
                fake_keyring::get(crate::storage::KEY_REPAIR_SCOPE_V1).as_deref(),
                Some("not-json")
            );
        }
        assert_eq!(
            server.count(),
            0,
            "{case}: scope failure must not trigger recovery HTTP"
        );
        assert_eq!(protected(&database), original);
        assert_eq!(binding(), keys);
    }
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_unreadable_scope_preserves_independent_binding_guards() {
    let lifecycle = crate::repairs::isolate_lifecycle_for_test();
    for case in [
        "terminal_marker",
        "terminal_candidate",
        "mixed_mirror",
        "missing_mirror",
        "missing_key",
        "binding_latch",
        "reset",
    ] {
        lifecycle.reset();
        let server = MockServer::new(wire(false).to_string());
        let (_keys, database) = fixture(&server.url, false, true);
        match case {
            "terminal_marker" | "terminal_candidate" => {
                let conn = database.state.conn.lock().unwrap();
                crate::db::set_setting(
                    &conn,
                    "sync",
                    if case == "terminal_marker" {
                        TERMINAL_CONNECTION_REBIND_PENDING_KEY
                    } else {
                        TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY
                    },
                    "fixture-pending",
                )
                .unwrap();
            }
            "mixed_mirror" => {
                let conn = database.state.conn.lock().unwrap();
                crate::db::set_setting(&conn, "terminal", "branch_id", "other-branch").unwrap();
            }
            "missing_mirror" => {
                let conn = database.state.conn.lock().unwrap();
                crate::db::delete_setting(&conn, "terminal", "branch_id").unwrap();
            }
            "missing_key" => {
                assert!(fake_keyring::delete("pos_api_key"));
            }
            "binding_latch" => crate::repairs::latch_startup_binding_maintenance_failure(),
            "reset" => {
                drop(crate::repairs::arm_process_reset().unwrap());
            }
            _ => unreachable!(),
        }
        fake_keyring::fail_reads_for(crate::storage::KEY_REPAIR_SCOPE_V1, "fixture scope locked");
        let restores = std::cell::Cell::new(0);
        assert!(
            crate::reconcile_native_startup(&database.state, || restores.set(restores.get() + 1))
                .await
                .is_err(),
            "{case}"
        );
        assert_eq!(restores.get(), 0, "{case}");
        assert_eq!(server.count(), 0, "{case}");
        assert!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1).is_err()
        );
        assert!(crate::repairs::acquire_transport_lease().is_err());
    }
}

#[tokio::test(flavor = "current_thread")]
#[serial_test::serial]
async fn main_startup_access_restores_lan_before_waiting_for_recovery_http() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
    let entered = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let server = MockServer::new_with_request_hook(wire(false).to_string(), {
        let entered = entered.clone();
        let release = release.clone();
        move || {
            entered.store(true, Ordering::SeqCst);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !release.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    });
    let (_keys, database) = fixture(&server.url, true, true);
    pending_access_purpose(false);
    let generation = crate::repairs::acquire_terminal_binding_lease()
        .unwrap()
        .generation();
    let restores = std::cell::Cell::new(0);
    let (result, ()) = tokio::join!(
        crate::reconcile_native_startup(&database.state, || {
            assert_eq!(
                server.count(),
                0,
                "LAN must restore before the first recovery request"
            );
            restores.set(restores.get() + 1);
        }),
        async {
            let arrived = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while !entered.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            let restored_while_response_held = restores.get();
            // Release even when the assertion fails so the server can shut down.
            release.store(true, Ordering::SeqCst);
            arrived.expect("startup must attempt Repairs recovery");
            assert_eq!(
                restored_while_response_held, 1,
                "LAN waited for a Repairs HTTP response"
            );
        }
    );
    result
        .expect("healthy binding")
        .expect("pending access defers the janitor");
    assert_eq!(restores.get(), 1);
    assert_eq!(
        server.count(),
        2,
        "settings validation and modules recovery must finish"
    );
    assert_eq!(
        crate::repairs::acquire_terminal_binding_lease()
            .unwrap()
            .generation(),
        generation
    );
    assert!(!terminal_connection_rebind_pending(&database.state).unwrap());
}
