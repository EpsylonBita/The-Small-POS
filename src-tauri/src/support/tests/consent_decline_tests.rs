use super::route_contract_tests::{golden, Fixture};
use crate::support::{
    session,
    transport::{self, ApiFuture, DeclineError, DeclineFuture, SupportApi},
};
use serde_json::{json, Value};
use std::sync::Mutex;
struct Api {
    failure: Option<(u16, &'static str)>,
    calls: Mutex<Vec<String>>,
}
impl SupportApi for Api {
    fn request<'a>(&'a self, path: &'a str, _: &'a str, _: Option<Value>) -> ApiFuture<'a> {
        self.calls.lock().unwrap().push(path.into());
        Box::pin(async {
            Ok(json!({"ended":true,"cancelled":true,"server_time":"2026-11-01T12:00:00.000Z"}))
        })
    }
    fn consent_decline<'a>(&'a self, body: Value, staff: &'a str) -> DeclineFuture<'a> {
        assert_eq!(body, golden("pos-support-consent-decline")["request"]);
        assert_eq!(staff, "60000000-0000-4000-a000-000000000006");
        self.calls.lock().unwrap().push("decline".into());
        Box::pin(async move {
            match self.failure {
                Some((status, code)) => Err(DeclineError {
                    status: Some(status),
                    code: Some(code.into()),
                }),
                None => Ok(golden("pos-support-consent-decline")["response"].clone()),
            }
        })
    }
    fn visible(&self) -> bool {
        true
    }
}
fn queued() -> Fixture {
    let fixture = Fixture::new();
    let core = fixture.rt.core.lock().unwrap();
    let mut notice = golden("pos-support-consent-decline")["request"].clone();
    notice["staff_session_id"] = json!("60000000-0000-4000-a000-000000000006");
    session::queue_notice(&core.executor.db, "consent_decline", notice, 0).unwrap();
    drop(core);
    fixture
}
fn pending(f: &Fixture) -> i64 {
    f.rt.core
        .lock()
        .unwrap()
        .executor
        .db
        .conn
        .query_row(
            "SELECT count(*) FROM support_pending_notices WHERE sent_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
#[tokio::test]
async fn decline_replays_without_a_session_and_permanent_refusals_retire() {
    let _gate = crate::support::critical_op::install_test_gate();
    for failure in [
        None,
        Some((400, "INVALID_INPUT")),
        Some((403, "POLICY_REFUSED")),
        Some((409, "PAYLOAD_MISMATCH")),
    ] {
        let f = queued();
        {
            let core = f.rt.core.lock().unwrap();
            session::queue_notice(
                &core.executor.db,
                "end",
                golden("pos-support-end")["request"].clone(),
                1,
            )
            .unwrap();
            session::queue_notice(
                &core.executor.db,
                "cancel_code",
                json!({"code_id":"your_code"}),
                2,
            )
            .unwrap();
        }
        let api = Api {
            failure,
            calls: Mutex::new(vec![]),
        };
        transport::harness::deliver(&api, &f.rt).await.unwrap();
        assert_eq!(pending(&f), 0);
        assert_eq!(
            *api.calls.lock().unwrap(),
            vec![
                "/api/pos/support/end",
                "/api/pos/support/sessions/cancel",
                "decline"
            ]
        );
    }
}
#[tokio::test]
async fn failing_decline_keeps_its_notice_but_never_stalls_end_or_cancel() {
    let _gate = crate::support::critical_op::install_test_gate();
    for failure in [
        (0, "TILL_OFFLINE"),
        (408, "TIMEOUT"),
        (429, "RATE_LIMITED"),
        (500, "INTERNAL_ERROR"),
        (403, "OTHER"),
        (409, "OTHER"),
        (401, "TERMINAL_AUTH_REFUSED"),
    ] {
        let f = queued();
        {
            let core = f.rt.core.lock().unwrap();
            session::queue_notice(
                &core.executor.db,
                "end",
                golden("pos-support-end")["request"].clone(),
                1,
            )
            .unwrap();
            session::queue_notice(
                &core.executor.db,
                "cancel_code",
                json!({"code_id":"your_code"}),
                2,
            )
            .unwrap();
        }
        let api = Api {
            failure: Some(failure),
            calls: Mutex::new(vec![]),
        };
        // A failed decline stops only the notice pass; delivery itself goes on
        // to results and audit, so it reports success here.
        transport::harness::deliver(&api, &f.rt).await.unwrap();
        assert_eq!(pending(&f), 1);
        assert_eq!(
            *api.calls.lock().unwrap(),
            vec![
                "/api/pos/support/end",
                "/api/pos/support/sessions/cancel",
                "decline"
            ]
        );
    }
}
#[test]
fn malformed_acknowledgements_are_transient() {
    for value in [
        json!({"recorded":false,"server_time":"2026-11-01T12:00:00.000Z"}),
        json!({"recorded":true}),
        json!({"recorded":true,"server_time":"invalid"}),
    ] {
        assert!(transport::parse_consent_decline(value).is_err());
    }
}

#[tokio::test]
async fn a_stalled_decline_times_out_without_holding_the_runtime_lock() {
    struct Stalled;
    impl SupportApi for Stalled {
        fn request<'a>(&'a self, _: &'a str, _: &'a str, _: Option<Value>) -> ApiFuture<'a> {
            Box::pin(async { unreachable!() })
        }
        fn consent_decline<'a>(&'a self, _: Value, _: &'a str) -> DeclineFuture<'a> {
            Box::pin(std::future::pending())
        }
        fn visible(&self) -> bool {
            true
        }
    }
    let _gate = crate::support::critical_op::install_test_gate();
    let f = queued();
    let delivery = transport::harness::deliver(&Stalled, &f.rt);
    tokio::pin!(delivery);
    tokio::select! {
        result=&mut delivery => panic!("stalled sender returned early: {result:?}"),
        _=tokio::time::sleep(std::time::Duration::from_millis(1)) => { assert!(f.rt.core.try_lock().is_ok()); }
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), delivery)
        .await
        .unwrap();
    result.unwrap();
    assert_eq!(pending(&f), 1);
}

#[tokio::test]
async fn an_unreadable_stored_decline_is_retired_without_a_send() {
    let _gate = crate::support::critical_op::install_test_gate();
    let f = queued();
    {
        let core = f.rt.core.lock().unwrap();
        core.executor
            .db
            .conn
            .execute(
                "UPDATE support_pending_notices SET body_json='{\"text_id\":\"not-a-uuid\"}' WHERE kind='consent_decline'",
                [],
            )
            .unwrap();
    }
    let api = Api {
        failure: None,
        calls: Mutex::new(vec![]),
    };
    transport::harness::deliver(&api, &f.rt).await.unwrap();
    assert_eq!(pending(&f), 0);
    assert!(api.calls.lock().unwrap().is_empty());
}

#[test]
fn consent_decline_outbox_survives_reopening_support_db() {
    let _gate = crate::support::critical_op::install_test_gate();
    let f = queued();
    let path = f._dir.path().to_path_buf();
    drop(f.rt);
    let reopened = crate::support::db::SupportDb::open(&path).unwrap();
    let (kind, body): (String, String) = reopened
        .conn
        .query_row(
            "SELECT kind,body_json FROM support_pending_notices WHERE sent_at IS NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(kind, "consent_decline");
    let (body, header) =
        transport::consent_decline_request(&serde_json::from_str(&body).unwrap()).unwrap();
    assert_eq!(body, golden("pos-support-consent-decline")["request"]);
    assert_eq!(header, "60000000-0000-4000-a000-000000000006");
}
