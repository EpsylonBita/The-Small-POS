//! Transport regressions use real support state and a scripted admin API.
use super::*;
use crate::support::{
    critical_op,
    db::SupportDb,
    session::{CodePending, Core, Runtime},
};
use std::{
    collections::VecDeque,
    sync::{atomic::AtomicBool, Mutex},
};

fn golden(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../shared/pos/support/__fixtures__/routes")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

struct Fixture {
    rt: Runtime,
    _dir: crate::tests::harness::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = crate::tests::harness::TempDir::new();
        Self {
            rt: Runtime {
                core: Mutex::new(Core::new(SupportDb::open(dir.path()).unwrap()).unwrap()),
                started: AtomicBool::new(false),
                banner_ready: AtomicBool::new(false),
            },
            _dir: dir,
        }
    }
    fn pending(&self) {
        self.rt.core.lock().unwrap().code = Some(CodePending {
            id: golden("pos-support-sessions")["response"]["code_id"]
                .as_str()
                .unwrap()
                .into(),
            expires_at: "2026-11-01T12:10:00.000Z".into(),
        });
    }
    fn active(&self) {
        let value = golden("pos-support-session")["response"].clone();
        let mut core = self.rt.core.lock().unwrap();
        core.adopt(
            serde_json::from_value(value["session"].clone()).unwrap(),
            value["server_time"].as_str().unwrap(),
        )
        .unwrap();
        core.session.as_mut().unwrap().admission.active = true;
        core.session.as_mut().unwrap().admission.visible = true;
        core.executor
            .db
            .conn
            .execute("UPDATE support_session_state SET status='active'", [])
            .unwrap();
    }
}

type Call = (String, String, Option<Value>);
struct Admin<'a> {
    calls: Mutex<Vec<Call>>,
    replies: Mutex<VecDeque<Value>>,
    end_during_baseline: Option<&'a Runtime>,
    observed: tokio::sync::Notify,
}
impl<'a> Admin<'a> {
    fn new(replies: Vec<Value>) -> Self {
        Self {
            calls: Mutex::new(vec![]),
            replies: Mutex::new(replies.into()),
            end_during_baseline: None,
            observed: tokio::sync::Notify::new(),
        }
    }
}
impl SupportApi for Admin<'_> {
    fn request<'a>(&'a self, path: &'a str, method: &'a str, body: Option<Value>) -> ApiFuture<'a> {
        self.calls
            .lock()
            .unwrap()
            .push((path.into(), method.into(), body));
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected support request");
        self.observed.notify_one();
        Box::pin(async move { Ok(reply) })
    }
    fn visible(&self) -> bool {
        true
    }
    fn baseline(&self) -> ApiFuture<'_> {
        Box::pin(async {
            if let Some(rt) = self.end_during_baseline {
                rt.core.lock().unwrap().end("till_end", false).unwrap();
            }
            Ok(golden("pos-support-session-ack")["request"]["symptom_baseline"].clone())
        })
    }
}

#[tokio::test]
async fn ending_during_baseline_never_posts_an_ack_without_a_session() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    f.pending();
    let mut api = Admin::new(vec![
        golden("pos-support-session")["response"].clone(),
        golden("pos-support-session-ack")["response"].clone(),
    ]);
    api.end_during_baseline = Some(&f.rt);
    fetch_session(&api, &f.rt, 0).await.unwrap();
    assert!(f.rt.core.lock().unwrap().session.is_none());
    assert_eq!(
        api.calls.lock().unwrap().len(),
        1,
        "ending while collectors run must suppress the pending ack"
    );
}

fn empty_commands() -> Value {
    json!({"commands":[], "server_time":"2026-11-01T12:00:00.000Z"})
}

#[tokio::test]
async fn independent_status_lane_sends_mocked_heartbeats_inside_fifteen_seconds() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    f.active();
    let api = Admin::new(vec![golden("pos-support-heartbeat")["response"].clone(); 2]);
    let observed = async {
        api.observed.notified().await;
        let first = Instant::now();
        api.observed.notified().await;
        assert!(first.elapsed() < Duration::from_secs(15));
        assert_eq!(api.calls.lock().unwrap().len(), 2);
        assert!(api
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(path, method, _)| path == "/api/pos/support/heartbeat" && method == "POST"));
    };
    tokio::time::timeout(Duration::from_secs(8), async {
        tokio::select! {
            () = status_lane(&api, &f.rt) => panic!("status lane unexpectedly stopped"),
            () = observed => {}
        }
    })
    .await
    .expect("two real status ticks finish within the pause budget");
}

#[tokio::test]
async fn poll_lane_is_silent_until_a_code_exists_then_acks_the_real_baseline() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let api = Admin::new(vec![
        golden("pos-support-session")["response"].clone(),
        golden("pos-support-session-ack")["response"].clone(),
    ]);
    let at = Instant::now();
    for seconds in [0, 3, 15, 30, 60] {
        poll_cycle(&api, &f.rt, at + Duration::from_secs(seconds)).await;
        status_cycle(&api, &f.rt).await;
        flush(&api, &f.rt).await.unwrap();
    }
    assert!(api.calls.lock().unwrap().is_empty());
    f.pending();
    // Supply current-session server time for the production expiry check.
    let mut core = f.rt.core.lock().unwrap();
    let id = core.code.as_ref().unwrap().id.clone();
    core.clock
        .observe(&id, "2026-11-01T12:00:00.000Z", Instant::now())
        .unwrap();
    drop(core);
    poll_cycle(&api, &f.rt, at + Duration::from_secs(61)).await;
    let calls = api.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        (&calls[0].0, &calls[0].1),
        (&"/api/pos/support/session".to_string(), &"GET".to_string())
    );
    assert_eq!(calls[1].0, "/api/pos/support/session/ack");
    let ack = calls[1].2.as_ref().unwrap();
    assert_eq!(ack["protocol_version"], 1);
    assert_eq!(
        ack["symptom_baseline"],
        golden("pos-support-session-ack")["request"]["symptom_baseline"]
    );
    assert!(ack["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "support.protocol.v1"));
    assert!(
        f.rt.core
            .lock()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .admission
            .active
    );
}

#[tokio::test]
async fn mocked_command_polls_follow_fallback_doorbell_and_safety_cadence() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    f.active();
    f.rt.core
        .lock()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .admission
        .tiers_enabled
        .insert(1);
    let api = Admin::new(vec![empty_commands(); 4]);
    let at = Instant::now();
    poll_cycle(&api, &f.rt, at).await;
    poll_cycle(&api, &f.rt, at + Duration::from_millis(2999)).await;
    assert_eq!(api.calls.lock().unwrap().len(), 1);
    poll_cycle(&api, &f.rt, at + Duration::from_secs(3)).await;
    assert_eq!(api.calls.lock().unwrap().len(), 2);
    f.rt.core.lock().unwrap().schedule.doorbell_healthy = true;
    poll_cycle(&api, &f.rt, at + Duration::from_secs(6)).await;
    assert_eq!(api.calls.lock().unwrap().len(), 2);
    f.rt.core.lock().unwrap().schedule.rung = true;
    poll_cycle(&api, &f.rt, at + Duration::from_secs(7)).await;
    assert_eq!(api.calls.lock().unwrap().len(), 3);
    poll_cycle(&api, &f.rt, at + Duration::from_millis(36999)).await;
    assert_eq!(api.calls.lock().unwrap().len(), 3);
    poll_cycle(&api, &f.rt, at + Duration::from_secs(37)).await;
    assert_eq!(api.calls.lock().unwrap().len(), 4);
    for (path, method, body) in api.calls.lock().unwrap().iter() {
        assert!(path.starts_with("/api/pos/support/commands?session_id="));
        assert!(path.ends_with("after_seq=0"));
        assert_eq!(method, "GET");
        assert!(body.is_none());
    }
}

#[tokio::test]
async fn status_lane_applies_kill_epoch_and_refuses_queued_and_new_disabled_commands() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    f.active();
    let mut killed = golden("pos-support-heartbeat")["response"].clone();
    killed["kill_epoch"] = json!(42);
    killed["disabled_tools"] = json!(["till_health"]);
    let mut later = golden("pos-support-commands")["response"].clone();
    later["commands"][0]["command_id"] = json!("70000000-0000-4000-a000-000000000007");
    later["commands"][0]["idempotency_key"] = json!("your_later_command_02");
    later["commands"][0]["sequence"] = json!(2);
    let api = Admin::new(vec![
        golden("pos-support-heartbeat")["response"].clone(),
        golden("pos-support-commands")["response"].clone(),
        killed,
        later,
    ]);
    status_cycle(&api, &f.rt).await;
    fetch_commands(&api, &f.rt, 0).await.unwrap();
    assert_eq!(
        f.rt.core.lock().unwrap().executor.queued().unwrap().len(),
        1
    );
    let at = Instant::now();
    status_cycle(&api, &f.rt).await;
    assert!(SERVER_CHECK_INTERVAL + at.elapsed() < Duration::from_secs(15));
    fetch_commands(&api, &f.rt, 0).await.unwrap();
    let core = f.rt.core.lock().unwrap();
    assert!(core
        .session
        .as_ref()
        .unwrap()
        .admission
        .disabled_tools
        .contains("till_health"));
    assert_eq!(
        core.executor
            .db
            .conn
            .query_row("SELECT kill_epoch FROM support_session_state", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        42
    );
    assert!(core.executor.queued().unwrap().is_empty());
    let results = core.executor.pending_results(core.now()).unwrap();
    assert_eq!(results.len(), 2);
    for result in results {
        assert_eq!(result["error_code"], "FEATURE_DISABLED");
    }
    assert_eq!(
        core.executor
            .db
            .conn
            .query_row(
                "SELECT count(*) FROM support_accepted_commands WHERE started_at IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn heartbeat_revocations_persist_and_cannot_add_a_trusted_key() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    f.active();
    let pinned: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let vector = &pinned["vectors"][0];
    f.rt.core.lock().unwrap().verifier =
        crate::support::approval_verify::Verifier::from_file(&vector["pinned_keys"]);
    let before = {
        let core = f.rt.core.lock().unwrap();
        core.verifier.live_key_ids(&core.executor.db.conn).unwrap()
    };
    assert!(!before.is_empty());
    let mut h = golden("pos-support-heartbeat")["response"].clone();
    let mut revoked = before.clone();
    revoked.push("your_unknown_revoked_key".into());
    h["revoked_key_ids"] = json!(revoked);
    let mut empty = h.clone();
    empty["revoked_key_ids"] = json!([]);
    let api = Admin::new(vec![h.clone(), h, empty]);
    for _ in 0..3 {
        status_cycle(&api, &f.rt).await;
    }
    let core = f.rt.core.lock().unwrap();
    assert!(core
        .verifier
        .live_key_ids(&core.executor.db.conn)
        .unwrap()
        .is_empty());
    for id in revoked {
        let count: i64 = core
            .executor
            .db
            .conn
            .query_row(
                "SELECT count(*) FROM support_revoked_keys WHERE credential_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "revocation survives duplicates and later omission"
        );
    }
    let root = core.executor.db.path.parent().unwrap().to_path_buf();
    drop(core);
    let reopened = SupportDb::open(&root).unwrap();
    assert_eq!(
        reopened
            .conn
            .query_row("SELECT count(*) FROM support_revoked_keys", [], |r| r
                .get::<_, usize>(0))
            .unwrap(),
        before.len() + 1
    );
}

#[tokio::test]
async fn heartbeat_verifies_unattended_proof_and_revocation_restores_attendance() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let v = vectors["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "valid unattended record")
        .unwrap();
    let id = v["context"]["session_id"].as_str().unwrap();
    let cap = v["context"]["absolute_cap_at"].as_str().unwrap();
    {
        let mut core = f.rt.core.lock().unwrap();
        core.verifier = crate::support::approval_verify::Verifier::from_file(&v["pinned_keys"]);
        core.terminal_id = Some(v["context"]["terminal_id"].as_str().unwrap().into());
        core.adopt(
            SessionInfo {
                confirmation_mode: None,
                session_id: id.into(),
                operator_display_name: "Your support".into(),
                tier_ceiling: 2,
                max_expires_at: cap.into(),
                absolute_cap_at: cap.into(),
                idle_timeout_s: 300,
                ack_deadline_at: cap.into(),
                doorbell_topic: format!("support:session:{id}"),
                resume_allowed: false,
            },
            v["state"]["server_time"].as_str().unwrap(),
        )
        .unwrap();
        core.session.as_mut().unwrap().admission.active = true;
        core.executor
            .db
            .conn
            .execute("UPDATE support_session_state SET status='active'", [])
            .unwrap();
    }
    let mut h = golden("pos-support-heartbeat")["response"].clone();
    h["server_time"] = v["state"]["server_time"].clone();
    h["max_expires_at"] = json!(cap);
    h["tier_ceiling"] = json!(2);
    h["unattended"] = json!({"record":v["record"], "assertion":v["assertion"]});
    h["revoked_key_ids"] = json!([]);
    let mut revoked = h.clone();
    revoked["revoked_key_ids"] = json!([v["credential_id"]]);
    let api = Admin::new(vec![h, revoked]);
    for expected_attended in [0, 1] {
        status_cycle(&api, &f.rt).await;
        let core = f.rt.core.lock().unwrap();
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row("SELECT attended FROM support_session_state", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            expected_attended
        );
    }
}

#[tokio::test]
async fn heartbeat_rotation_signal_arms_only_the_existing_dormant_receiver() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let f = Fixture::new();
    f.active();
    assert!(!f.rt.core.lock().unwrap().rotation.due(Instant::now()));
    let mut h = golden("pos-support-heartbeat")["response"].clone();
    h["key_rotation_pending"] = json!(true);
    let api = Admin::new(vec![h]);
    status_cycle(&api, &f.rt).await;
    let mut core = f.rt.core.lock().unwrap();
    assert!(core.key_rotation_pending);
    assert!(core.rotation.due(Instant::now()));
    assert_eq!(api.calls.lock().unwrap().len(), 1);
    assert_eq!(api.calls.lock().unwrap()[0].0, "/api/pos/support/heartbeat");
}

#[tokio::test]
async fn support_admin_fetch_rejects_plain_http_before_sending_terminal_headers() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let server = crate::tests::fake_http::MockServer::new("{}");
    crate::storage::seed_terminal_credential_for_test("terminal_id", "your_terminal").unwrap();
    for path in [
        "/api/pos/support/session",
        "/api/pos/support/commands?after_seq=0",
        "/api/pos/support/results",
    ] {
        let error = crate::api::fetch_from_admin_detailed_with_staff_session(
            &server.url,
            "your_api_key",
            path,
            "GET",
            None,
            None,
            REQUEST_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(error.status().is_none());
        assert!(require_https(&server.url).is_err());
    }
    assert_eq!(
        server.count(),
        0,
        "HTTPS-only client must never send a support request over HTTP"
    );
}
