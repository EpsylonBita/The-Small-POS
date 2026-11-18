use super::*;
use crate::support::{
    db::SupportDb,
    session::{CodePending, Core, Runtime},
};
use std::{
    collections::VecDeque,
    sync::{atomic::AtomicBool, Mutex},
};

struct ResultApi {
    calls: Mutex<Vec<String>>,
    replies: Mutex<VecDeque<Result<Value, ResultDeliveryError>>>,
}
impl ResultApi {
    fn new(replies: Vec<Result<Value, ResultDeliveryError>>) -> Self {
        Self {
            calls: Mutex::new(vec![]),
            replies: Mutex::new(replies.into()),
        }
    }
}
impl SupportApi for ResultApi {
    fn request<'a>(&'a self, path: &'a str, _: &'a str, _: Option<Value>) -> ApiFuture<'a> {
        panic!("unexpected request {path}")
    }
    fn post_result(&self, body: Value) -> ResultDeliveryFuture<'_> {
        self.calls
            .lock()
            .unwrap()
            .push(body["command_id"].as_str().unwrap().into());
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected result send");
        Box::pin(async move { reply })
    }
    fn visible(&self) -> bool {
        true
    }
}
fn runtime(path: &std::path::Path) -> Runtime {
    Runtime {
        core: Mutex::new(Core::new(SupportDb::open(path).unwrap()).unwrap()),
        started: AtomicBool::new(false),
        banner_ready: AtomicBool::new(false),
    }
}
fn at(rt: &Runtime, now: i64) {
    let mut core = rt.core.lock().unwrap();
    core.code = Some(CodePending {
        id: "delivery-clock".into(),
        expires_at: super::super::clock::iso(now + 3_600_000),
    });
    core.clock
        .observe(
            "delivery-clock",
            &super::super::clock::iso(now),
            Instant::now(),
        )
        .unwrap();
}
fn seed(rt: &Runtime, id: &str, session: &str, now: i64) {
    let result = json!({"command_id":id,"session_id":session,"result_sha256":"a".repeat(64),"status":"completed"});
    rt.core.lock().unwrap().executor.db.conn.execute("INSERT INTO support_result_outbox(command_id,session_id,result_json,created_ms) VALUES(?1,?2,?3,?4)",rusqlite::params![id,session,result.to_string(),now]).unwrap();
}
fn good() -> Result<Value, ResultDeliveryError> {
    Ok(json!({"stored":true,"duplicate":false}))
}
fn failed(status: u16, code: &str) -> Result<Value, ResultDeliveryError> {
    Err(ResultDeliveryError {
        status: Some(status),
        code: Some(code.into()),
    })
}

#[tokio::test]
async fn permanent_refusal_retires_only_that_result_and_sends_the_next_two_even_after_restart() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for restart in [false, true] {
        let dir = crate::tests::harness::TempDir::new();
        let mut rt = runtime(dir.path());
        let now = chrono::Utc::now().timestamp_millis();
        seed(&rt, "old", "ended-session", now);
        seed(&rt, "next-1", "new-session", now + 1);
        seed(&rt, "next-2", "new-session", now + 2);
        if restart {
            rt = runtime(dir.path());
        }
        at(&rt, now + 3);
        let api = ResultApi::new(vec![failed(400, "INVALID_INPUT"), good(), good()]);
        flush(&api, &rt).await.unwrap();
        assert_eq!(*api.calls.lock().unwrap(), vec!["old", "next-1", "next-2"]);
        let core = rt.core.lock().unwrap();
        assert!(core.executor.pending_results(now + 3).unwrap().is_empty());
        let record: (String, String, String) = core
            .executor
            .db
            .conn
            .query_row(
                "SELECT command_id,session_id,server_code FROM support_result_refusals",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            record,
            ("old".into(), "ended-session".into(), "INVALID_INPUT".into())
        );
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row("SELECT count(*) FROM support_result_delivery", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn transient_failures_yield_after_three_and_persist_backoff_across_restart() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for restart in [false, true] {
        let dir = crate::tests::harness::TempDir::new();
        let mut rt = runtime(dir.path());
        let now = chrono::Utc::now().timestamp_millis();
        seed(&rt, "old", "ended-session", now);
        let api = ResultApi::new(vec![
            failed(503, "INTERNAL_ERROR"),
            failed(503, "INTERNAL_ERROR"),
            failed(503, "INTERNAL_ERROR"),
            good(),
            good(),
        ]);
        let n = crate::support::executor::result_failure_threshold();
        assert_eq!(n, 3);
        let mut next = now;
        for failure in 0..n {
            at(&rt, next);
            let result = flush(&api, &rt).await;
            assert_eq!(result.is_err(), failure + 1 < n);
            next = rt
                .core
                .lock()
                .unwrap()
                .executor
                .db
                .conn
                .query_row(
                    "SELECT next_attempt_ms FROM support_result_delivery WHERE command_id='old'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if failure == 0 {
                seed(&rt, "good", "new-session", now + 1);
            }
            if restart {
                rt = runtime(dir.path());
            }
        }
        assert_eq!(
            *api.calls.lock().unwrap(),
            vec!["old", "old", "old", "good"]
        );
        at(&rt, next - 1_000);
        flush(&api, &rt).await.unwrap();
        assert_eq!(
            api.calls.lock().unwrap().len(),
            4,
            "restart must not reset backoff"
        );
        at(&rt, next);
        flush(&api, &rt).await.unwrap();
        assert_eq!(
            *api.calls.lock().unwrap(),
            vec!["old", "old", "old", "good", "old"]
        );
    }
}

#[tokio::test]
async fn persisted_reservation_caps_sends_even_if_the_process_dies_before_a_reply() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let dir = crate::tests::harness::TempDir::new();
    let mut rt = runtime(dir.path());
    let now = chrono::Utc::now().timestamp_millis();
    seed(&rt, "old", "ended-session", now);
    let mut sends = 0;
    for elapsed in (0..60_000).step_by(100) {
        if rt
            .core
            .lock()
            .unwrap()
            .executor
            .reserve_result_send("old", now + elapsed)
            .unwrap()
        {
            sends += 1;
        }
        if elapsed % 10_000 == 0 {
            rt = runtime(dir.path());
        }
    }
    assert_eq!(
        sends, 4,
        "at most four starts in any half-open minute, even with no failure reply"
    );
}

#[tokio::test]
async fn late_result_is_sent_for_audit_and_does_not_block_a_new_session() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let dir = crate::tests::harness::TempDir::new();
    let rt = runtime(dir.path());
    let now = chrono::Utc::now().timestamp_millis();
    seed(&rt, "old", "ended-session", now);
    seed(&rt, "new", "new-session", now + 1);
    at(&rt, now + 2);
    let api = ResultApi::new(vec![good(), good()]);
    flush(&api, &rt).await.unwrap();
    assert_eq!(*api.calls.lock().unwrap(), vec!["old", "new"]);
}

#[test]
fn result_refusals_use_http_status_and_never_store_error_prose() {
    for status in 400..600 {
        let error = ResultDeliveryError {
            status: Some(status),
            code: Some("your private server text".into()),
        };
        assert_eq!(
            error.permanent(),
            status < 500 && !matches!(status, 401 | 408 | 425 | 429)
        );
        assert_eq!(error.audit_code(), format!("HTTP_{status}"));
    }
    assert!(!ResultDeliveryError::transient().permanent());
}

#[test]
fn five_minutes_of_server_failure_has_eight_attempts_with_capped_backoff_across_restarts() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let dir = crate::tests::harness::TempDir::new();
    let mut rt = runtime(dir.path());
    let now = chrono::Utc::now().timestamp_millis();
    seed(&rt, "old", "ended-session", now);
    let mut starts = vec![];
    for elapsed in (0..300_000).step_by(3_000) {
        {
            let core = rt.core.lock().unwrap();
            if core
                .executor
                .reserve_result_send("old", now + elapsed)
                .unwrap()
            {
                starts.push(elapsed);
                core.executor
                    .result_send_failed("old", now + elapsed)
                    .unwrap();
            }
        }
        if elapsed % 30_000 == 0 {
            rt = runtime(dir.path());
        }
    }
    assert_eq!(
        starts,
        vec![0, 15_000, 30_000, 45_000, 75_000, 135_000, 195_000, 255_000]
    );
    assert!(starts
        .windows(2)
        .all(|pair| pair[1] - pair[0] <= cap("transport", "deliveryExpiryMs") as i64));
}
