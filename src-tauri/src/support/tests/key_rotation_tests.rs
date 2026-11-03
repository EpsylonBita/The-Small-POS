//! Rotation uses real support.db and the per-thread keyring; HTTP is injected.
use super::route_contract_tests::{golden, Fixture};
use crate::support::{critical_op, key_rotation as rotation};
use serde_json::{json, Value};
use std::sync::Mutex;

const OLD: &str = "your-old-terminal-api-key";
pub(super) const NEW: &str = "your-new-terminal-api-key";

struct Server {
    calls: Mutex<Vec<(String, String)>>,
    fetch_drop: Mutex<bool>,
    confirm_drop: Mutex<bool>,
    conflict: Mutex<bool>,
    promoted: Mutex<bool>,
    issued_at: String,
}
impl Default for Server {
    fn default() -> Self {
        Self {
            calls: Mutex::new(vec![]),
            fetch_drop: Mutex::new(false),
            confirm_drop: Mutex::new(false),
            conflict: Mutex::new(false),
            promoted: Mutex::new(false),
            issued_at: crate::support::clock::iso(chrono::Utc::now().timestamp_millis()),
        }
    }
}
impl rotation::Sender for Server {
    fn send<'a>(
        &'a self,
        key: &'a str,
        path: &'a str,
        method: &'a str,
        body: Option<Value>,
    ) -> rotation::ReplyFuture<'a> {
        // Retain hashes only, even in the test transport recorder.
        self.calls
            .lock()
            .unwrap()
            .push((path.into(), rotation::hash(key)));
        let authenticated = self.authenticates(key);
        Box::pin(async move {
            if !authenticated {
                return Err(rotation::Failure::Http(401));
            }
            if method == "GET" {
                if *self.fetch_drop.lock().unwrap() {
                    return Err(rotation::Failure::Offline);
                }
                if key == NEW && !*self.promoted.lock().unwrap() {
                    return Err(rotation::Failure::Http(403));
                }
                if *self.promoted.lock().unwrap() {
                    return Ok(golden("pos-key-rotation")["cases"][0]["response"].clone());
                }
                let mut reply = golden("pos-key-rotation")["cases"][1]["response"].clone();
                reply["issued_at"] = json!(self.issued_at);
                reply["revoke_old_at"] = json!(crate::support::clock::iso(
                    crate::support::clock::parse(&self.issued_at).unwrap() + 72 * 3600 * 1000
                ));
                return Ok(reply);
            }
            assert_eq!(path, rotation::CONFIRM);
            assert_eq!(body.unwrap(), json!({"issued_at":self.issued_at}));
            if *self.confirm_drop.lock().unwrap() {
                return Err(rotation::Failure::Offline);
            }
            if *self.conflict.lock().unwrap() {
                return Err(rotation::Failure::Http(409));
            }
            if key != NEW {
                return Err(rotation::Failure::Http(403));
            }
            *self.promoted.lock().unwrap() = true;
            Ok(golden("pos-key-rotation-confirm")["cases"][0]["response"].clone())
        })
    }
}
impl Server {
    fn authenticates(&self, key: &str) -> bool {
        rotation::hash(key) == rotation::hash(NEW)
            || (rotation::hash(key) == rotation::hash(OLD) && !*self.promoted.lock().unwrap())
    }
}

#[tokio::test]
async fn legacy_connection_string_and_decoded_header_share_handover_identity() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let legacy = json!({"key":OLD,"tid":"your-terminal","url":"https://example.test"}).to_string();
    crate::storage::seed_terminal_credential_for_test("pos_api_key", &legacy).unwrap();
    let f = Fixture::new();
    let server = Server {
        issued_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false),
        ..Server::default()
    };
    rotation::attempt(&server, &f.rt, rotation::Crash::None)
        .await
        .unwrap();
    assert_eq!(rotation::hash(&legacy), rotation::hash(OLD));
    rotation::retry_authenticated(OLD, |key| {
        let authenticated = server.authenticates(&key);
        async move {
            if authenticated {
                Ok(json!({"ok":true}))
            } else {
                Err(rotation::Failure::Http(401))
            }
        }
    })
    .await
    .unwrap();
    working(&server);
}
fn seed() {
    crate::storage::seed_terminal_credential_for_test("pos_api_key", OLD).unwrap();
}
fn working(server: &Server) {
    let key = crate::storage::get_credential("pos_api_key").unwrap();
    assert!(
        server.authenticates(&key),
        "the selected key must authenticate"
    );
}
struct Restarted {
    rt: crate::support::session::Runtime,
    _dir: crate::tests::harness::TempDir,
}
impl std::ops::Deref for Restarted {
    type Target = crate::support::session::Runtime;
    fn deref(&self) -> &Self::Target {
        &self.rt
    }
}
fn reopen(f: Fixture) -> Restarted {
    // Destroy the entire old runtime/connection: recovery has only the actual
    // SQLite files and simulated OS keyring, never an in-memory old key.
    let Fixture { rt, _dir } = f;
    drop(rt);
    let rt = crate::support::session::Runtime {
        core: Mutex::new(
            crate::support::session::Core::new(
                crate::support::db::SupportDb::open(_dir.path()).unwrap(),
            )
            .unwrap(),
        ),
        started: std::sync::atomic::AtomicBool::new(false),
        banner_ready: std::sync::atomic::AtomicBool::new(false),
    };
    Restarted { rt, _dir }
}

fn ended_command(f: &Fixture) {
    f.active();
    let mut core = f.rt.core.lock().unwrap();
    let id = core.session.as_ref().unwrap().info.session_id.clone();
    let at = crate::support::clock::iso(chrono::Utc::now().timestamp_millis());
    core.executor.db.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,accepted_at,started_at,finished_at,idempotency_key,state) VALUES('your-command',?1,1,'breakglass_propose_command',?2,?3,?3,?3,'your-idempotency-key','finished')", rusqlite::params![id, rotation::hash("your-payload"), at]).unwrap();
    core.end("server_end", false).unwrap();
    core.executor
        .db
        .conn
        .execute(
            "UPDATE support_session_state SET updated_at=?1 WHERE session_id=?2",
            rusqlite::params![at, id],
        )
        .unwrap();
}

#[tokio::test]
async fn fetch_drop_and_restart_leave_current_key_usable() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    seed();
    let f = Fixture::new();
    let server = Server::default();
    *server.fetch_drop.lock().unwrap() = true;
    assert!(rotation::attempt(&server, &f.rt, rotation::Crash::None)
        .await
        .is_err());
    working(&server);
    let resumed = reopen(f);
    *server.fetch_drop.lock().unwrap() = false;
    rotation::attempt(&server, &resumed, rotation::Crash::None)
        .await
        .unwrap();
    working(&server);
}

#[tokio::test]
async fn every_crash_point_restarts_without_losing_either_key() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for crash in [
        rotation::Crash::AfterFetch,
        rotation::Crash::BeforeWrite,
        rotation::Crash::AfterWrite,
        rotation::Crash::AfterConfirm,
    ] {
        seed();
        let f = Fixture::new();
        ended_command(&f);
        let server = Server::default();
        assert!(rotation::attempt(&server, &f.rt, crash).await.is_err());
        working(&server);
        let resumed = reopen(f);
        assert!(resumed
            .core
            .lock()
            .unwrap()
            .rotation
            .due(std::time::Instant::now()));
        rotation::attempt(&server, &resumed, rotation::Crash::None)
            .await
            .unwrap();
        working(&server);
        assert!(*server.promoted.lock().unwrap());
        let core = resumed.core.lock().unwrap();
        assert_eq!(
            rotation::load(&core.executor.db.conn)
                .unwrap()
                .unwrap()
                .phase,
            "confirmed"
        );
        if crash == rotation::Crash::AfterWrite {
            let calls = server.calls.lock().unwrap();
            assert!(calls
                .iter()
                .any(|(path, h)| path == rotation::FETCH && h == &rotation::hash(NEW)));
        }
    }
}

#[tokio::test]
async fn keyring_write_failure_and_readback_mismatch_never_confirm_and_recover() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for (slot, mismatch) in [
        ("pos_api_key", false),
        ("pos_api_key", true),
        ("pos_support_rotation_old", false),
        ("pos_support_rotation_old", true),
        ("pos_support_rotation_hashes", false),
        ("pos_support_rotation_hashes", true),
    ] {
        seed();
        let f = Fixture::new();
        let server = Server::default();
        if mismatch {
            crate::tests::fake_keyring::replace_next_write_with(slot, "your-corrupt-key");
        } else {
            crate::tests::fake_keyring::fail_writes_for(slot, "your-private-backend-error");
        }
        assert!(rotation::attempt(&server, &f.rt, rotation::Crash::None)
            .await
            .is_err());
        working(&server);
        assert!(!server
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _)| p == rotation::CONFIRM));
        crate::tests::fake_keyring::clear_failures_for(slot);
        let resumed = reopen(f);
        rotation::attempt(&server, &resumed, rotation::Crash::None)
            .await
            .unwrap();
        working(&server);
    }
}

#[tokio::test]
async fn transient_confirm_and_conflict_preserve_handover_across_restart() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for conflict in [false, true] {
        seed();
        let f = Fixture::new();
        let server = Server::default();
        *server.confirm_drop.lock().unwrap() = !conflict;
        *server.conflict.lock().unwrap() = conflict;
        assert!(rotation::attempt(&server, &f.rt, rotation::Crash::None)
            .await
            .is_err());
        working(&server);
        assert!(server.authenticates(OLD));
        let resumed = reopen(f);
        *server.confirm_drop.lock().unwrap() = false;
        *server.conflict.lock().unwrap() = false;
        rotation::attempt(&server, &resumed, rotation::Crash::None)
            .await
            .unwrap();
        working(&server);
    }
}

#[tokio::test]
async fn critical_operations_defer_rotation_and_checkout_can_preempt_the_switch() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    seed();
    let f = Fixture::new();
    let server = Server::default();
    for kind in [
        critical_op::CriticalKind::Checkout,
        critical_op::CriticalKind::Card,
        critical_op::CriticalKind::ZClose,
    ] {
        let token = critical_op::global().begin_critical(kind);
        assert!(rotation::attempt(&server, &f.rt, rotation::Crash::None)
            .await
            .is_err());
        assert!(server.calls.lock().unwrap().is_empty());
        working(&server);
        drop(token);
    }
    crate::tests::fake_keyring::after_next_write("pos_api_key", || {
        let checkout = critical_op::global().begin_critical(critical_op::CriticalKind::Checkout);
        assert!(matches!(
            crate::storage::get_credential("pos_api_key").as_deref(),
            Some(OLD | NEW)
        ));
        drop(checkout); // checkout starts and completes synchronously; no wait on rotation
    });
    assert!(rotation::attempt(&server, &f.rt, rotation::Crash::None)
        .await
        .is_err());
    working(&server);
    rotation::attempt(&server, &f.rt, rotation::Crash::None)
        .await
        .unwrap();
    working(&server);
}

#[tokio::test]
async fn unauthorized_request_retries_once_with_other_handover_key() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    seed();
    let f = Fixture::new();
    let server = Server::default();
    assert_eq!(
        rotation::attempt(&server, &f.rt, rotation::Crash::AfterWrite)
            .await
            .unwrap_err(),
        rotation::Failure::Crash
    );
    let calls = Mutex::new(vec![]);
    let response = rotation::retry_authenticated(OLD, |key| {
        calls.lock().unwrap().push(rotation::hash(&key));
        async move {
            if key.as_str() == OLD {
                Err(rotation::Failure::Http(401))
            } else {
                Ok(json!({"authenticated":true}))
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(response["authenticated"], true);
    assert_eq!(calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn request_dispatched_before_confirmation_retries_after_old_key_is_revoked() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    seed();
    let f = Fixture::new();
    let server = Server::default();
    rotation::attempt(&server, &f.rt, rotation::Crash::None)
        .await
        .unwrap();
    assert!(!server.authenticates(OLD));
    let calls = Mutex::new(0);
    rotation::retry_authenticated(OLD, |key| {
        *calls.lock().unwrap() += 1;
        let authenticated = server.authenticates(&key);
        async move {
            if authenticated {
                Ok(json!({"ok":true}))
            } else {
                Err(rotation::Failure::Http(401))
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(*calls.lock().unwrap(), 2);
    assert!(crate::storage::rotation_alternate(NEW).is_none());
}

#[test]
fn backoff_is_bounded_and_startup_resumes_only_rotation_evidence() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let mut schedule = rotation::Schedule::default();
    let now = std::time::Instant::now();
    assert!(!schedule.due(now));
    schedule.arm(now);
    assert!(schedule.due(now));
    assert!(!schedule.due(now));
    assert!(schedule.due(now + std::time::Duration::from_secs(5)));
    assert!(!schedule.due(now + std::time::Duration::from_secs(72 * 3600)));
}

#[tokio::test]
async fn startup_and_post_session_cycle_work_without_a_heartbeat_signal() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    seed();
    let f = Fixture::new();
    let idle = Server::default();
    rotation::cycle(&idle, &f.rt).await;
    assert!(idle.calls.lock().unwrap().is_empty());
    ended_command(&f);
    let resumed = reopen(f);
    rotation::cycle(&idle, &resumed).await;
    assert!(*idle.promoted.lock().unwrap());
    working(&idle);
    let count = idle.calls.lock().unwrap().len();
    rotation::cycle(&idle, &resumed).await;
    assert_eq!(idle.calls.lock().unwrap().len(), count);
}

#[tokio::test]
async fn readback_backend_error_preserves_backup_and_does_not_leak_error_text() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    seed();
    let f = Fixture::new();
    let server = Server::default();
    crate::tests::fake_keyring::after_next_write("pos_api_key", || {
        crate::tests::fake_keyring::fail_read_after("pos_api_key", 0, NEW);
    });
    let error = rotation::attempt(&server, &f.rt, rotation::Crash::None)
        .await
        .unwrap_err();
    assert!(!format!("{error:?}").contains(NEW));
    working(&server);
    assert!(!*server.promoted.lock().unwrap());
    rotation::attempt(&server, &reopen(f), rotation::Crash::None)
        .await
        .unwrap();
    working(&server);
}

#[tokio::test]
async fn confirm_waits_out_the_grace_so_requests_holding_the_old_key_finish() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    rotation::TEST_CONFIRM_GRACE.with(|g| g.set(None));
    seed();
    let f = Fixture::new();
    let server = Server::default();
    assert_eq!(
        rotation::attempt(&server, &f.rt, rotation::Crash::None).await,
        Err(rotation::Failure::Deferred)
    );
    // The new key is installed and verified, but confirm was not sent: the
    // server still accepts both keys, so an old-key request in flight succeeds.
    assert!(!server
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(path, _)| path == rotation::CONFIRM));
    assert_eq!(
        rotation::hash(&crate::storage::get_credential("pos_api_key").unwrap()),
        rotation::hash(NEW)
    );
    assert!(server.authenticates(OLD) && server.authenticates(NEW));
    // A restart inside the grace keeps waiting.
    let resumed = reopen(f);
    assert_eq!(
        rotation::attempt(&server, &resumed, rotation::Crash::None).await,
        Err(rotation::Failure::Deferred)
    );
    assert!(server.authenticates(OLD));
    // Once the grace has passed, confirm promotes the new key.
    let eleven_minutes_ago =
        crate::support::clock::iso(chrono::Utc::now().timestamp_millis() - 11 * 60 * 1000);
    resumed
        .core
        .lock()
        .unwrap()
        .executor
        .db
        .conn
        .execute(
            "UPDATE support_audit_local SET created_at=?1 WHERE status='key_rotation.written'",
            [&eleven_minutes_ago],
        )
        .unwrap();
    assert_eq!(
        rotation::attempt(&server, &resumed, rotation::Crash::None).await,
        Ok(true)
    );
    assert!(!server.authenticates(OLD));
    working(&server);
    rotation::TEST_CONFIRM_GRACE.with(|g| g.set(Some(std::time::Duration::ZERO)));
}

fn marker_reads() -> std::rc::Rc<std::cell::Cell<usize>> {
    let reads = std::rc::Rc::new(std::cell::Cell::new(0));
    let counter = reads.clone();
    crate::tests::fake_keyring::before_each_read(move |key| {
        if key == "pos_support_rotation_hashes" {
            counter.set(counter.get() + 1);
        }
    });
    reads
}

#[test]
fn an_api_key_read_reads_the_rotation_marker_once_then_from_memory() {
    let _keys = crate::tests::fake_keyring::install_empty();
    seed();
    let reads = marker_reads();
    for _ in 0..5 {
        assert_eq!(
            crate::storage::get_credential("pos_api_key").as_deref(),
            Some(OLD)
        );
    }
    assert_eq!(reads.get(), 1, "the marker is read from the keyring once");
    assert_eq!(
        crate::storage::rotation_marker_cached_for_test(),
        Some(false)
    );
}

#[tokio::test]
async fn a_pairing_reset_outside_rotation_clears_the_cached_marker() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    rotation::TEST_CONFIRM_GRACE.with(|g| g.set(None));
    seed();
    let f = Fixture::new();
    let server = Server::default();
    // Mid-handover: new key written, marker present and cached.
    assert_eq!(
        rotation::attempt(&server, &f.rt, rotation::Crash::None).await,
        Err(rotation::Failure::Deferred)
    );
    assert_eq!(
        crate::storage::get_credential("pos_api_key").as_deref(),
        Some(NEW)
    );
    assert_eq!(
        crate::storage::rotation_marker_cached_for_test(),
        Some(true)
    );
    // A pairing/reset owner replaces the key through the ordinary writer.
    crate::storage::seed_terminal_credential_for_test("pos_api_key", "your-repaired-terminal-key")
        .unwrap();
    assert_eq!(crate::storage::rotation_marker_cached_for_test(), None);
    let reads = marker_reads();
    // The repaired key is served as is: no stale marker sends readers to the
    // old handover backup.
    assert_eq!(
        crate::storage::get_credential("pos_api_key").as_deref(),
        Some("your-repaired-terminal-key")
    );
    assert_eq!(reads.get(), 1);
    assert_eq!(
        crate::storage::rotation_marker_cached_for_test(),
        Some(false)
    );
    rotation::TEST_CONFIRM_GRACE.with(|g| g.set(Some(std::time::Duration::ZERO)));
}

#[tokio::test]
async fn a_restart_starts_the_marker_cache_unknown_and_rereads_the_keyring() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    rotation::TEST_CONFIRM_GRACE.with(|g| g.set(None));
    seed();
    let f = Fixture::new();
    let server = Server::default();
    assert_eq!(
        rotation::attempt(&server, &f.rt, rotation::Crash::None).await,
        Err(rotation::Failure::Deferred)
    );
    assert_eq!(
        crate::storage::get_credential("pos_api_key").as_deref(),
        Some(NEW)
    );
    crate::storage::restart_rotation_marker_cache_for_test();
    assert_eq!(crate::storage::rotation_marker_cached_for_test(), None);
    let reads = marker_reads();
    assert_eq!(
        crate::storage::get_credential("pos_api_key").as_deref(),
        Some(NEW)
    );
    assert_eq!(reads.get(), 1, "a fresh process reads the persisted marker");
    assert_eq!(
        crate::storage::rotation_marker_cached_for_test(),
        Some(true)
    );
    rotation::TEST_CONFIRM_GRACE.with(|g| g.set(Some(std::time::Duration::ZERO)));
}
