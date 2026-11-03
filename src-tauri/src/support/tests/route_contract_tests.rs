//! Golden contracts exercise real transport lanes; no HTTP or keyring is used.
use crate::support::{
    audit_local::{self, AuditEntry},
    contracts::Command,
    db::SupportDb,
    session::{CodePending, Core, Runtime},
    transport::{self, harness, ApiFuture, Heartbeat, SessionFetch, SupportApi},
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{atomic::AtomicBool, Mutex},
};

pub(super) fn golden(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../shared/pos/support/__fixtures__/routes")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub(super) struct Fixture {
    pub rt: Runtime,
    pub _dir: crate::tests::harness::TempDir,
}
impl Fixture {
    pub fn new() -> Self {
        let dir = crate::tests::harness::TempDir::new();
        let core = Core::new(SupportDb::open(dir.path()).unwrap()).unwrap();
        Self {
            rt: Runtime {
                core: Mutex::new(core),
                started: AtomicBool::new(false),
                banner_ready: AtomicBool::new(false),
            },
            _dir: dir,
        }
    }
    pub fn active(&self) {
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
        core.schedule.doorbell_healthy = true;
    }
}

type Call = (String, String, Option<Value>);
struct GoldenApi {
    calls: Mutex<Vec<Call>>,
    replies: Mutex<VecDeque<Value>>,
}
impl GoldenApi {
    fn new(names: &[&str]) -> Self {
        Self {
            calls: Mutex::new(vec![]),
            replies: Mutex::new(
                names
                    .iter()
                    .map(|name| golden(name)["response"].clone())
                    .collect(),
            ),
        }
    }
    fn assert_call(&self, index: usize, name: &str) {
        let fixture = golden(name);
        let calls = self.calls.lock().unwrap();
        let (path, method, body) = &calls[index];
        assert_eq!(method, fixture["method"].as_str().unwrap());
        if method == "GET" {
            let url = url::Url::parse(&format!("https://example.test{path}")).unwrap();
            assert_eq!(url.path(), fixture["path"].as_str().unwrap());
            assert!(body.is_none());
            let mut query = json!({});
            for (key, value) in url.query_pairs() {
                query[key.as_ref()] = if key == "after_seq" {
                    json!(value.parse::<i64>().unwrap())
                } else {
                    json!(value)
                };
            }
            assert_eq!(
                query, fixture["request"],
                "{name}: recursive keys, types and values"
            );
        } else {
            assert_eq!(path, fixture["path"].as_str().unwrap());
            assert_eq!(body.as_ref().unwrap(), &fixture["request"], "{name}");
        }
    }
}
impl SupportApi for GoldenApi {
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
            .expect("unexpected request");
        // Value is the production parser for ack/results/end/audit/cancel.
        let reply: Value = serde_json::from_str(&serde_json::to_string(&reply).unwrap()).unwrap();
        Box::pin(async move { Ok(reply) })
    }
    fn visible(&self) -> bool {
        true
    }
    fn baseline(&self) -> ApiFuture<'_> {
        Box::pin(async {
            Ok(golden("pos-support-session-ack")["request"]["symptom_baseline"].clone())
        })
    }
}

#[tokio::test]
async fn session_fetch_and_ack_use_real_transport_and_lossless_typed_parser() {
    let _gate = crate::support::critical_op::install_test_gate();
    let fixture = Fixture::new();
    fixture.rt.core.lock().unwrap().code = Some(CodePending {
        id: golden("pos-support-sessions")["response"]["code_id"]
            .as_str()
            .unwrap()
            .into(),
        expires_at: "2026-11-01T12:10:00.000Z".into(),
    });
    let api = GoldenApi::new(&["pos-support-session", "pos-support-session-ack"]);
    harness::session(&api, &fixture.rt).await.unwrap();
    api.assert_call(0, "pos-support-session");
    let input = golden("pos-support-session-ack")["request"].clone();
    assert_eq!(
        transport::ack(
            input["session_id"].as_str().unwrap(),
            input["symptom_baseline"].clone(),
            serde_json::from_value(input["capabilities"].clone()).unwrap()
        ),
        input
    );
    let response = golden("pos-support-session")["response"].clone();
    let parsed: SessionFetch = serde_json::from_value(response.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), response);
    assert!(
        fixture
            .rt
            .core
            .lock()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .admission
            .active
    );
    assert_eq!(api.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn heartbeat_and_commands_build_exact_goldens_and_parse_without_key_loss() {
    let _gate = crate::support::critical_op::install_test_gate();
    let fixture = Fixture::new();
    fixture.active();
    let api = GoldenApi::new(&["pos-support-heartbeat", "pos-support-commands"]);
    harness::status(&api, &fixture.rt).await;
    harness::commands(&api, &fixture.rt).await.unwrap();
    api.assert_call(0, "pos-support-heartbeat");
    api.assert_call(1, "pos-support-commands");
    let response = golden("pos-support-heartbeat")["response"].clone();
    let parsed: Heartbeat = serde_json::from_value(response.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), response);
    let mut response = golden("pos-support-commands")["response"].clone();
    let command: Command = serde_json::from_value(response["commands"][0].clone()).unwrap();
    response["commands"][0] = serde_json::to_value(command).unwrap();
    assert_eq!(response, golden("pos-support-commands")["response"]);
    assert_eq!(
        fixture
            .rt
            .core
            .lock()
            .unwrap()
            .executor
            .queued()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn result_outbox_and_audit_build_exact_goldens_and_accept_golden_replies() {
    let _gate = crate::support::critical_op::install_test_gate();
    let fixture = Fixture::new();
    let result = golden("pos-support-results")["request"].clone();
    let now = chrono::Utc::now().timestamp_millis();
    {
        let core = fixture.rt.core.lock().unwrap();
        core.executor.db.conn.execute("INSERT INTO support_result_outbox(command_id,session_id,result_json,created_ms) VALUES (?1,?2,?3,?4)", rusqlite::params![result["command_id"].as_str(), result["session_id"].as_str(), result.to_string(), now]).unwrap();
        let entry: AuditEntry =
            serde_json::from_value(golden("pos-support-audit")["request"]["entries"][0].clone())
                .unwrap();
        audit_local::append(&core.executor.db.conn, &entry).unwrap();
    }
    let api = GoldenApi::new(&["pos-support-results", "pos-support-audit"]);
    harness::deliver(&api, &fixture.rt).await.unwrap();
    api.assert_call(0, "pos-support-results");
    api.assert_call(1, "pos-support-audit");
    let core = fixture.rt.core.lock().unwrap();
    assert!(core.executor.pending_results(now).unwrap().is_empty());
    assert!(audit_local::pending(&core.executor.db.conn)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn end_and_code_cancel_build_exact_goldens_from_local_session_state() {
    let _gate = crate::support::critical_op::install_test_gate();
    for (name, kind) in [
        ("pos-support-end", "end"),
        ("pos-support-sessions-cancel", "cancel_code"),
    ] {
        let fixture = Fixture::new();
        // Startup queues app_restart notices through the same end-body builder;
        // supply the golden server time rather than the machine clock.
        let body = if kind == "end" {
            crate::support::session::harness::end_body(
                golden(name)["request"]["session_id"].as_str().unwrap(),
                "till_end",
                crate::support::clock::parse("2026-11-01T12:00:00.000Z").unwrap(),
            )
        } else {
            let mut core = fixture.rt.core.lock().unwrap();
            core.code = Some(CodePending {
                id: golden(name)["request"]["code_id"].as_str().unwrap().into(),
                expires_at: "2026-11-01T12:10:00.000Z".into(),
            });
            core.cancel_code().unwrap();
            let text: String = core
                .executor
                .db
                .conn
                .query_row("SELECT body_json FROM support_pending_notices", [], |r| {
                    r.get(0)
                })
                .unwrap();
            serde_json::from_str(&text).unwrap()
        };
        if kind == "end" {
            crate::support::session::queue_notice(
                &fixture.rt.core.lock().unwrap().executor.db,
                kind,
                body,
                0,
            )
            .unwrap();
        } else {
            assert_eq!(body, golden(name)["request"]);
        }
        let api = GoldenApi::new(&[name]);
        harness::deliver(&api, &fixture.rt).await.unwrap();
        api.assert_call(0, name);
        assert_eq!(
            fixture
                .rt
                .core
                .lock()
                .unwrap()
                .executor
                .db
                .conn
                .query_row(
                    "SELECT count(*) FROM support_pending_notices WHERE sent_at IS NULL",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}

#[test]
fn code_issuance_builder_matches_golden_with_the_installed_version() {
    let input = golden("pos-support-sessions")["request"].clone();
    let mut expected = input.clone();
    // app_version is the installed binary's version, not the example release.
    expected["app_version"] = json!(env!("CARGO_PKG_VERSION"));
    assert_eq!(expected["protocol_version"], 1);
    assert_eq!(expected["platform"], "windows");
    // IssueCodeReqSchema accepts any nonempty string of at most 32 characters;
    // it deliberately has no semver regex.
    let version = input["app_version"].as_str().unwrap();
    assert!((1..=32).contains(&version.chars().count()));
    assert_eq!(
        crate::support::session::issue_code_body(
            env!("CARGO_PKG_VERSION"),
            Some(input["staff_ref"].clone())
        ),
        expected
    );
    let response = golden("pos-support-sessions")["response"].clone();
    assert_eq!(
        serde_json::from_str::<Value>(&response.to_string()).unwrap(),
        response
    );
}

#[test]
fn terminal_heartbeat_support_golden_is_reserved_for_the_private_sync_sender_seam() {
    let fixture = golden("pos-terminal-heartbeat-support");
    assert_eq!(fixture["request"], json!({"support_protocol_version":1}));
    // The sync sender is private; the response round-trip lives in
    // heartbeat_availability_tests.rs (compiled inside sync.rs) and the request
    // field in sync.rs's own heartbeat payload test. This pins the wiring.
    let source = include_str!("../../sync.rs");
    assert!(source.contains("async fn send_terminal_heartbeat_with_sender"));
    assert!(source.contains("validated_support_availability(&response[\"support\"])"));
    assert!(source.contains("payload[\"support_protocol_version\"] = Value::from(version)"));
}

#[tokio::test]
async fn key_rotation_fetch_and_confirm_use_the_golden_routes_and_bodies() {
    use crate::support::key_rotation as rotation;
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    struct RotationApi {
        calls: Mutex<Vec<Call>>,
        pending: bool,
    }
    impl rotation::Sender for RotationApi {
        fn send<'a>(
            &'a self,
            _: &'a str,
            path: &'a str,
            method: &'a str,
            body: Option<Value>,
        ) -> rotation::ReplyFuture<'a> {
            self.calls
                .lock()
                .unwrap()
                .push((path.into(), method.into(), body));
            Box::pin(async move {
                Ok(if method == "GET" {
                    golden("pos-key-rotation")["cases"][usize::from(self.pending)]["response"]
                        .clone()
                } else {
                    golden("pos-key-rotation-confirm")["cases"][0]["response"].clone()
                })
            })
        }
    }
    for pending in [false, true] {
        crate::storage::seed_terminal_credential_for_test(
            "pos_api_key",
            "your-current-terminal-api-key",
        )
        .unwrap();
        let f = Fixture::new();
        let api = RotationApi {
            calls: Mutex::new(vec![]),
            pending,
        };
        assert_eq!(
            rotation::attempt(&api, &f.rt, rotation::Crash::None)
                .await
                .unwrap(),
            pending
        );
        let calls = api.calls.lock().unwrap();
        let fetch = golden("pos-key-rotation");
        assert_eq!(
            calls[0],
            (
                fetch["route"].as_str().unwrap().into(),
                fetch["cases"][usize::from(pending)]["method"]
                    .as_str()
                    .unwrap()
                    .into(),
                None
            )
        );
        assert_eq!(fetch["cases"][usize::from(pending)]["query"], json!({}));
        let parsed =
            rotation::parse_fetch(fetch["cases"][usize::from(pending)]["response"].clone())
                .unwrap();
        assert_eq!(parsed.is_some(), pending);
        if pending {
            let fixture = golden("pos-key-rotation-confirm");
            assert_eq!(
                calls[1],
                (
                    fixture["route"].as_str().unwrap().into(),
                    "POST".into(),
                    Some(fixture["cases"][0]["request"].clone())
                )
            );
            assert_eq!(
                serde_json::to_value(
                    rotation::parse_confirm(fixture["cases"][0]["response"].clone()).unwrap()
                )
                .unwrap(),
                fixture["cases"][0]["response"]
            );
        }
    }
}

#[test]
fn consent_accept_builds_exact_golden_including_checked_in_staff_header() {
    let fixture = golden("pos-support-consent-accept");
    let case = &fixture["cases"][0];
    let staff = json!({"databaseStaffId":case["body"]["staff_id"]});
    let persisted = json!({"staffId":case["body"]["staff_id"],"sessionId":case["headers"]["x-staff-session-id"]});
    let (body, session) =
        crate::support::session::harness::consent_accept(case["body"].clone(), &staff, &persisted)
            .unwrap();
    assert_eq!(body, case["body"]);
    assert_eq!(session, case["headers"]["x-staff-session-id"]);
    let response: Value = serde_json::from_str(&case["response"].to_string()).unwrap();
    assert_eq!(response, case["response"]);
}

#[test]
fn consent_decline_builder_uses_native_time_and_checked_in_staff() {
    let fixture = golden("pos-support-consent-decline");
    assert_eq!(fixture["route"], "/api/pos/support/consent/decline");
    let staff = json!({"databaseStaffId":"50000000-0000-4000-a000-000000000005"});
    let persisted = json!({"staffId":staff["databaseStaffId"],"sessionId":"60000000-0000-4000-a000-000000000006"});
    let text = json!({"text_id":fixture["request"]["text_id"],"text_sha256":fixture["request"]["text_sha256"]});
    let now =
        crate::support::clock::parse(fixture["request"]["declined_at_till"].as_str().unwrap())
            .unwrap();
    let notice =
        crate::support::session::consent_decline_notice(&text, &staff, &persisted, now).unwrap();
    let (body, header) = transport::consent_decline_request(&notice).unwrap();
    assert_eq!(body, fixture["request"]);
    assert_eq!(header, persisted["sessionId"]);
    let response = transport::parse_consent_decline(fixture["response"].clone()).unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), fixture["response"]);
    let mut spoofed = text.clone();
    spoofed["declined_at_till"] = json!("renderer-controlled");
    assert!(
        crate::support::session::consent_decline_notice(&spoofed, &staff, &persisted, now).is_err()
    );
    let mut wrong = persisted.clone();
    wrong["staffId"] = json!("70000000-0000-4000-a000-000000000007");
    assert!(crate::support::session::consent_decline_notice(&text, &staff, &wrong, now).is_err());
    for bad in [
        json!(null),
        json!({"text_id":"invalid","text_sha256":"a".repeat(64)}),
        json!({"text_id":text["text_id"],"text_sha256":"A".repeat(64)}),
    ] {
        assert!(
            crate::support::session::consent_decline_notice(&bad, &staff, &persisted, now).is_err()
        );
    }
}

#[test]
fn extension_golden_response_is_consumed_losslessly_by_the_session_core() {
    let _gate = crate::support::critical_op::install_test_gate();
    let fixture = Fixture::new();
    fixture.active();
    let golden = golden("pos-support-session-extend");
    let response = golden["response"].clone();
    let id = golden["request"]["session_id"].as_str().unwrap();
    let mut core = fixture.rt.core.lock().unwrap();
    crate::support::session::harness::extension(&mut core, id, response.clone()).unwrap();
    assert_eq!(
        core.session.as_ref().unwrap().info.max_expires_at,
        response["max_expires_at"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(&response.to_string()).unwrap(),
        response
    );
    // The live AppHandle builder omits optional staff_ref.display_name from
    // this golden. Do not silently normalize it into a full builder match.
    assert!(golden["request"]["staff_ref"].get("display_name").is_some());
}
