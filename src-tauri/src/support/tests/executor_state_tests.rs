use super::delivery_tests::{admission, clock, command};
use crate::support::{clock::parse, db::SupportDb, executor::Executor};
use serde_json::json;

fn fixture() -> (std::path::PathBuf, Executor) {
    let root = std::env::temp_dir().join(format!("support-executor-{}", uuid::Uuid::new_v4()));
    let db = SupportDb::open(&root).unwrap();
    let a = admission();
    db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES (?1,'active',1,?2,?2,?2)",rusqlite::params![a.session_id,a.max_expires_at]).unwrap();
    (root, Executor::new(db))
}
fn now() -> i64 {
    parse("2026-11-01T12:00:00.000Z").unwrap()
}

#[test]
fn evidence_failure_details_survive_envelopes_without_native_exception_text() {
    for detail in crate::support::evidence::DETAILS {
        let (root, mut executor) = fixture();
        let command = command();
        let admission = admission();
        let clock = clock();
        executor.accept(&command, &admission, &clock).unwrap();
        executor.start(&command, &admission, &clock).unwrap();
        executor
            .fail(&command, &crate::support::evidence::error(detail), now())
            .unwrap();
        let results = executor.pending_results(now()).unwrap();
        assert_eq!(results[0]["error_code"], "INTERNAL_ERROR");
        assert_eq!(results[0]["failure_detail_code"], *detail);
        drop(executor);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn screenshot_pixels_never_enter_durable_outbox_and_can_be_uploaded_only_once() {
    let (root, mut executor) = fixture();
    let mut command = command();
    command.kind = "till_screenshot".into();
    command.payload = json!({"reason":"Review the failed order"});
    command.payload_sha256 = crate::support::contracts::payload_hash(&command.payload);
    let admission = admission();
    let clock = clock();
    executor.accept(&command, &admission, &clock).unwrap();
    executor.start(&command, &admission, &clock).unwrap();
    let gate = crate::support::critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let data = crate::support::screenshot::encode(
        image::DynamicImage::new_rgb8(320, 240),
        320,
        &permit,
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    )
    .unwrap();
    let pixels = data["base64"].as_str().unwrap().to_string();
    executor.finish(&command, data, now()).unwrap();
    let stored: String = executor
        .db
        .conn
        .query_row("SELECT result_json FROM support_result_outbox", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!stored.contains("base64"));
    assert!(!stored.contains(&pixels));
    let first = executor.pending_results_limit(now(), 3).unwrap();
    assert_eq!(first[0]["data"]["base64"], pixels);
    let accounted: i64 = executor
        .db
        .conn
        .query_row("SELECT result_bytes FROM support_session_state", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(accounted as usize, first[0].to_string().len());
    let repeat = executor.pending_results_limit(now(), 3).unwrap();
    assert_eq!(repeat[0]["error_code"], "OUTCOME_UNKNOWN");
    assert_eq!(
        repeat[0]["failure_detail_code"],
        "SCREENSHOT_ALREADY_CONSUMED"
    );
    assert!(repeat[0].get("data").is_none());
    executor
        .delivered(
            &command.command_id,
            repeat[0]["result_sha256"].as_str().unwrap(),
        )
        .unwrap();
    assert!(executor.pending_results(now()).unwrap().is_empty());
    executor
        .db
        .conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let bytes = std::fs::read(&executor.db.path).unwrap();
    assert!(!bytes.windows(pixels.len()).any(|v| v == pixels.as_bytes()));
    drop(executor);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_screenshot_attempts_count_towards_durable_five_second_and_twenty_per_session_caps() {
    let (root, mut executor) = fixture();
    let mut command = command();
    command.kind = "till_screenshot".into();
    command.payload = json!({"reason":"Review the failed order"});
    command.payload_sha256 = crate::support::contracts::payload_hash(&command.payload);
    let admission = admission();
    let clock = clock();
    assert!(executor.accept(&command, &admission, &clock).unwrap());
    executor.start(&command, &admission, &clock).unwrap();
    executor
        .fail(
            &command,
            &crate::support::evidence::error("SCREEN_CONTAINS_SECRETS"),
            now(),
        )
        .unwrap();
    let mut next = command.clone();
    next.command_id = uuid::Uuid::new_v4().to_string();
    next.idempotency_key = "your_next_screenshot_01".into();
    next.sequence = 2;
    assert!(!executor.accept(&next, &admission, &clock).unwrap());
    assert!(executor
        .pending_results(now())
        .unwrap()
        .iter()
        .any(|r| r["command_id"] == next.command_id && r["error_code"] == "RATE_LIMITED"));
    executor
        .db
        .conn
        .execute(
            "UPDATE support_accepted_commands SET accepted_at='2026-11-01T11:00:00.000Z'",
            [],
        )
        .unwrap();
    for sequence in 2..=20 {
        executor.db.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,idempotency_key,accepted_at) VALUES(?1,?2,?3,'till_screenshot','your-hash',?4,'2026-11-01T11:00:00.000Z')",rusqlite::params![uuid::Uuid::new_v4().to_string(),command.session_id,sequence,format!("your_capped_key_{sequence}")]).unwrap();
    }
    next.command_id = uuid::Uuid::new_v4().to_string();
    next.idempotency_key = "your_next_screenshot_21".into();
    next.sequence = 21;
    assert!(!executor.accept(&next, &admission, &clock).unwrap());
    assert_eq!(
        crate::support::contracts::cap("screenshot", "perSession"),
        20
    );
    assert_eq!(
        crate::support::contracts::cap("screenshot", "intervalMs"),
        5000
    );
    drop(executor);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn durable_acceptance_precedes_execution_and_replay_or_out_of_order_is_never_started() {
    let (root, mut e) = fixture();
    let c = command();
    let a = admission();
    let clock = clock();
    assert_eq!(e.accept(&c, &a, &clock).unwrap(), true);
    assert_eq!(
        e.db.conn
            .query_row("SELECT count(*) FROM support_accepted_commands", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(e.accept(&c, &a, &clock).unwrap(), false);
    assert_eq!(
        e.db.conn
            .query_row(
                "SELECT count(*) FROM support_audit_local WHERE phase='refused'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    let mut later = c.clone();
    later.command_id = uuid::Uuid::new_v4().to_string();
    later.idempotency_key = "fixture_later_01".into();
    later.sequence = 8;
    assert!(e.accept(&later, &a, &clock).unwrap());
    let mut old = later.clone();
    old.command_id = uuid::Uuid::new_v4().to_string();
    old.idempotency_key = "fixture_old_0001".into();
    old.sequence = 7;
    assert!(!e.accept(&old, &a, &clock).unwrap());
    let mut duplicate = later.clone();
    duplicate.command_id = uuid::Uuid::new_v4().to_string();
    duplicate.sequence = 9;
    assert!(!e.accept(&duplicate, &a, &clock).unwrap());
    drop(e);
    let mut restarted = Executor::new(SupportDb::open(&root).unwrap());
    restarted.recover(now()).unwrap();
    assert!(!restarted.accept(&c, &a, &clock).unwrap());
    drop(restarted);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_execution_reports_unknown_with_guidance_and_stored_results_survive_end() {
    let (root, mut e) = fixture();
    let c = command();
    let a = admission();
    let clock = clock();
    e.accept(&c, &a, &clock).unwrap();
    e.start(&c, &a, &clock).unwrap();
    drop(e);
    let mut e = Executor::new(SupportDb::open(&root).unwrap());
    e.recover(now()).unwrap();
    let out = e.pending_results(now()).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["error_code"], "OUTCOME_UNKNOWN");
    assert!(
        out[0]["data"]["verification_guidance"]
            .as_str()
            .unwrap()
            .len()
            > 20
    );
    assert!(!e.accept(&c, &a, &clock).unwrap());
    e.end(&a.session_id, now()).unwrap();
    assert_eq!(e.pending_results(now() + 1000).unwrap().len(), 1);
    assert!(e.pending_results(now() + 86_400_001).unwrap().is_empty());
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn acceptance_storage_failure_and_session_end_fail_closed_and_refusals_are_recorded() {
    let (root, mut e) = fixture();
    let c = command();
    let a = admission();
    let clock = clock();
    e.db.conn.execute_batch("CREATE TRIGGER fail_accept BEFORE INSERT ON support_accepted_commands BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(e.accept(&c, &a, &clock).is_err());
    assert!(e.start(&c, &a, &clock).is_err());
    e.db.conn.execute_batch("DROP TRIGGER fail_accept").unwrap();
    let mut bad = c.clone();
    bad.payload_sha256 = "0".repeat(64);
    assert!(!e.accept(&bad, &a, &clock).unwrap());
    assert_eq!(
        e.pending_results(now()).unwrap()[0]["error_code"],
        "PAYLOAD_MISMATCH"
    );
    assert_eq!(
        e.db.conn
            .query_row(
                "SELECT count(*) FROM support_audit_local WHERE phase='refused'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    e.end(&a.session_id, now()).unwrap();
    assert!(!e.accept(&c, &a, &clock).unwrap());
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unstarted_commands_are_discarded_on_end_and_results_remain_bounded() {
    let (root, mut e) = fixture();
    let c = command();
    let a = admission();
    let clock = clock();
    e.accept(&c, &a, &clock).unwrap();
    e.end(&a.session_id, now()).unwrap();
    assert!(e.start(&c, &a, &clock).is_err());
    let out = e.pending_results(now()).unwrap();
    assert_eq!(out[0]["error_code"], "SESSION_ENDED");
    assert!(e
        .finish(&c, json!({"data":"x".repeat(300_000)}), now())
        .is_err());
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_refused_identity_cannot_be_rewritten_into_a_fresh_command() {
    let (root, mut e) = fixture();
    let mut c = command();
    let a = admission();
    let clock = clock();
    c.payload_sha256 = "0".repeat(64);
    assert!(!e.accept(&c, &a, &clock).unwrap());
    c.payload_sha256 = crate::support::contracts::payload_hash(&c.payload);
    assert!(!e.accept(&c, &a, &clock).unwrap());
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reads_wait_during_mutation_but_can_run_while_it_awaits_onsite() {
    let (root, mut e) = fixture();
    let mut a = admission();
    let clock = clock();
    a.tier_ceiling = 2;
    a.tiers_enabled.insert(2);
    let mut mutation = command();
    mutation.kind = "till_run_remedy".into();
    mutation.tier = 2;
    mutation.idempotency_key = "fixture_mutating01".into();
    mutation.payload = json!({"recipe_id":"your-recipe","recipe_version":1,"reason":"your-reason","idempotency_key":"fixture_mutating01"});
    mutation.payload_sha256 = crate::support::contracts::payload_hash(&mutation.payload);
    assert!(e.accept(&mutation, &a, &clock).unwrap());
    e.wait(&mutation, "awaiting_onsite", now()).unwrap();
    let mut read = command();
    read.command_id = uuid::Uuid::new_v4().to_string();
    read.sequence = 2;
    assert!(e.accept(&read, &a, &clock).unwrap());
    assert!(e.start(&read, &a, &clock).is_ok());
    assert!(e.start(&mutation, &a, &clock).is_err());
    e.finish(&read, json!({}), now()).unwrap();
    assert!(e.start(&mutation, &a, &clock).is_ok());
    let mut second = read.clone();
    second.command_id = uuid::Uuid::new_v4().to_string();
    second.idempotency_key = "fixture_read_next".into();
    second.sequence = 3;
    assert!(e.accept(&second, &a, &clock).unwrap());
    assert_eq!(
        e.start(&second, &a, &clock),
        Err("CONCURRENT_OPERATION".into())
    );
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn result_outbox_is_bounded_and_a_delivered_result_can_be_reported_again_without_execution() {
    let (root, mut e) = fixture();
    let a = admission();
    let clock = clock();
    for seq in 1..=30 {
        let mut c = command();
        c.sequence = seq;
        c.command_id = uuid::Uuid::new_v4().to_string();
        c.idempotency_key = format!("fixture_result_{seq:04}");
        assert!(e.accept(&c, &a, &clock).unwrap());
        e.start(&c, &a, &clock).unwrap();
        e.finish(&c, json!({"text":"x".repeat(200_000)}), now() + seq)
            .unwrap();
    }
    let out = e.pending_results(now() + 100).unwrap();
    assert!(out.iter().map(|v| v.to_string().len()).sum::<usize>() <= 5 * 1024 * 1024);
    assert!(out.len() < 30);
    let result = out.last().unwrap();
    let encoded: String =
        e.db.conn
            .query_row(
                "SELECT envelope_json FROM support_accepted_commands WHERE command_id=?1",
                [result["command_id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
    let c: crate::support::contracts::Command = serde_json::from_str(&encoded).unwrap();
    e.delivered(&c.command_id, result["result_sha256"].as_str().unwrap())
        .unwrap();
    assert!(!e.accept(&c, &a, &clock).unwrap());
    assert!(e.start(&c, &a, &clock).is_err());
    assert!(e
        .pending_results(now() + 100)
        .unwrap()
        .iter()
        .any(|v| v["command_id"] == c.command_id));
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn session_result_budget_survives_outbox_pruning() {
    let (root, mut e) = fixture();
    let a = admission();
    let clock = clock();
    let c = command();
    e.accept(&c, &a, &clock).unwrap();
    e.start(&c, &a, &clock).unwrap();
    e.db.conn
        .execute("UPDATE support_session_state SET result_bytes=20971520", [])
        .unwrap();
    assert_eq!(
        e.finish(&c, json!({"value":1}), now()),
        Err("RESULT_BUDGET_EXHAUSTED".into())
    );
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_end_discards_a_pending_batch_with_bounded_durable_commits() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let (root, mut e) = fixture();
    let a = admission();
    let clock = clock();
    for seq in 1..=20 {
        let mut c = command();
        c.sequence = seq;
        c.command_id = uuid::Uuid::new_v4().to_string();
        c.idempotency_key = format!("fixture_pending_{seq:04}");
        assert!(e.accept(&c, &a, &clock).unwrap());
    }
    let commits = Arc::new(AtomicUsize::new(0));
    let counter = commits.clone();
    e.db.conn.commit_hook(Some(move || {
        counter.fetch_add(1, Ordering::AcqRel);
        false
    }));
    let at = std::time::Instant::now();
    e.end(&a.session_id, now()).unwrap();
    assert!(at.elapsed() < std::time::Duration::from_secs(1));
    assert!(
        commits.load(Ordering::Acquire) <= 2,
        "ending must not fsync separately for each queued command"
    );
    assert!(e.queued().unwrap().is_empty());
    assert_eq!(e.pending_results(now()).unwrap().len(), 20);
    drop(e);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_screenshot_restart_uses_data_free_consumed_transport() {
    let (root, mut executor) = fixture();
    let mut command = command();
    command.kind = "till_screenshot".into();
    command.payload = json!({"reason":"Review the failed order"});
    command.payload_sha256 = crate::support::contracts::payload_hash(&command.payload);
    executor.accept(&command, &admission(), &clock()).unwrap();
    executor.start(&command, &admission(), &clock()).unwrap();
    drop(executor);
    let mut executor = Executor::new(SupportDb::open(&root).unwrap());
    executor.recover(now()).unwrap();
    let result = executor.pending_results(now()).unwrap();
    assert_eq!(result[0]["error_code"], "OUTCOME_UNKNOWN");
    assert_eq!(
        result[0]["failure_detail_code"],
        "SCREENSHOT_ALREADY_CONSUMED"
    );
    assert!(result[0].get("data").is_none());
    drop(executor);
    std::fs::remove_dir_all(root).unwrap();
}
