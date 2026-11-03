use crate::support::{
    remedies::{self, Budget, Match},
    remedy_run,
};
use serde_json::json;

#[test]
fn manual_and_support_share_one_action_lease_until_success_or_refusal() {
    let gate = remedies::ActionGate::default();
    for _source in ["manual", "remote_support"] {
        let running = gate.try_begin().unwrap();
        assert_eq!(gate.try_begin().err().unwrap(), "CONCURRENT_OPERATION");
        drop(running);
        assert!(gate.try_begin().is_ok());
    }
}

#[test]
fn execution_requires_attributed_durable_audit_and_the_manual_snapshot() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::run_migrations_for_test(&conn);
    // Explicitly exercise the no-device notification collaborator, never a
    // printer transport or the real app's print worker.
    crate::print::notify_print_queue_changed(&crate::print::NoopPrintQueueInvalidator);
    let mut c = super::delivery_tests::command();
    c.kind = "till_run_remedy".into();
    let r = remedies::recipe("customer-address-default.retry", 1).unwrap();
    let id = format!("support:{}:your_target", c.command_id);
    for (source, session, snapshot, allowed) in [
        (
            "manual",
            c.session_id.as_str(),
            Some("your_snapshot"),
            false,
        ),
        (
            "remote_support",
            "your_other_session",
            Some("your_snapshot"),
            false,
        ),
        ("remote_support", c.session_id.as_str(), None, false),
        (
            "remote_support",
            c.session_id.as_str(),
            Some("your_snapshot"),
            true,
        ),
    ] {
        conn.execute("DELETE FROM recovery_action_log", []).unwrap();
        conn.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,recipe_id,recipe_version,snapshot_point_id,payload_json) VALUES(?1,?2,'your_issue',?3,1,?4,?5)",rusqlite::params![id,r.action_id,r.id,snapshot,json!({"source":source,"sessionId":session}).to_string()]).unwrap();
        assert_eq!(remedy_run::recovery_audit(&conn, &c, r).is_ok(), allowed);
    }
}

#[test]
fn only_closed_app_refusals_can_leave_the_till() {
    for code in [
        "FORBIDDEN",
        "UNAUTHORIZED",
        "REAUTH_REQUIRED",
        "POLICY_REFUSED",
        "CONCURRENT_OPERATION",
        "REMEDY_NOT_APPLICABLE",
    ] {
        assert_eq!(remedy_run::app_refusal(&json!(code)), Some(code));
    }
    for value in [
        json!("your_private_error"),
        json!({"code":"FORBIDDEN"}),
        json!(null),
    ] {
        assert_eq!(remedy_run::app_refusal(&value), None);
    }
}

#[test]
fn catalogue_summary_keeps_budget_and_target_facts_distinct() {
    let r = remedies::recipe("customer-address-default.retry", 1).unwrap();
    let m = Match {
        title: "Shipped title".into(),
        explanation: "Shipped explanation".into(),
        matches_now: json!(true),
        target_count: 2,
        ..Default::default()
    };
    let b = Budget {
        attempts: 2,
        next: Some(101),
        last: Some(json!({"outcome":"pending","at":"your_time"})),
    };
    let row = remedies::summarize(r, Some(&m), &b, 100);
    assert_eq!(row["id"], r.id);
    assert_eq!(row["version"], 1);
    assert_eq!(row["mutates_data"], true);
    assert_eq!(row["needs_onsite"], true);
    assert_eq!(row["needs_staff_pin"], true);
    assert_eq!(row["matches_now"], true);
    assert_eq!(row["target_count"], 2);
    assert_eq!(row["cooldown"]["active"], true);
    assert_eq!(row["attempts"], json!({"used":2,"cap":3}));
    assert_eq!(row["last_outcome"]["outcome"], "pending");
}

#[test]
fn outcome_needs_fresh_native_evidence_and_never_confuses_scheduling_with_resolution() {
    let before = vec!["sync.queue_failed".into()];
    assert_eq!(
        remedy_run::verified_native_outcome(false, &before, &[], Some("resolved")),
        "unknown"
    );
    assert_eq!(
        remedy_run::verified_native_outcome(true, &before, &[], Some("pending")),
        "pending"
    );
    assert_eq!(
        remedy_run::verified_native_outcome(true, &before, &[], Some("resolved")),
        "resolved"
    );
    assert_eq!(
        remedy_run::verified_native_outcome(true, &before, &before, Some("resolved")),
        "failed"
    );
}

#[test]
fn every_added_health_action_uses_the_same_native_admission_for_manual_and_support() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let conn = budget_db();
    for (id, action) in [
        (
            "customer-address-default.retry",
            "nativeCustomerAddressDefaultRetry",
        ),
        ("printerReprobe", "printerReprobe"),
        ("testPrint", "testPrint"),
    ] {
        let r = remedies::recipe(id, 1).unwrap();
        for source in ["manual", "remote_support"] {
            let request = json!({"actionId":action,"recipeId":id,"recipeVersion":1,"source":source,"sessionId":"your_session"});
            assert_eq!(
                crate::commands::recovery::health_action_admission(
                    &conn, &request, 100, true, false
                )
                .unwrap_err(),
                "REMEDY_NOT_APPLICABLE"
            );
            assert_eq!(
                crate::commands::recovery::health_action_admission(
                    &conn, &request, 100, false, true
                )
                .unwrap_err(),
                "CONCURRENT_OPERATION"
            );
            assert_eq!(
                crate::commands::recovery::health_action_admission(
                    &conn, &request, 100, false, false
                )
                .unwrap()
                .id,
                r.id
            );
        }
    }
}

fn budget_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value TEXT); CREATE TABLE parity_sync_queue(id TEXT,organization_id TEXT); CREATE TABLE orders(id TEXT,organization_id TEXT); CREATE TABLE recovery_action_log(recipe_id TEXT,action_id TEXT,payload_json TEXT,success INTEGER,created_at TEXT,queue_id TEXT,order_id TEXT,entity_id TEXT,entity_type TEXT,recipe_version INTEGER); INSERT INTO local_settings VALUES('terminal','organization_id','your_org'); INSERT INTO parity_sync_queue VALUES('your_row','your_org');").unwrap();
    conn
}

#[test]
fn manual_and_support_address_admission_share_durable_cooldown_and_cap() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let conn = budget_db();
    for (attempts, last, expected) in [
        (1, "2030-01-01T00:00:00.000Z", "REMEDY_COOLDOWN"),
        (3, "2020-01-01T00:00:00.000Z", "REMEDY_ATTEMPT_CAP"),
    ] {
        conn.execute(
            "DELETE FROM local_settings WHERE setting_category='recovery_probe'",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO local_settings VALUES('recovery_probe','customer-address-default.retry.v1:your_row',?1)", [json!({"recipeId":"customer-address-default.retry","recipeVersion":1,"attempts":attempts,"lastProbeAt":last}).to_string()]).unwrap();
        for source in ["manual", "remote_support"] {
            let request = json!({"actionId":"nativeCustomerAddressDefaultRetry","recipeId":"customer-address-default.retry","recipeVersion":1,"entityId":"your_row","source":source});
            assert_eq!(
                crate::commands::recovery::health_action_admission(
                    &conn,
                    &request,
                    1_800_000_000_000,
                    false,
                    false
                )
                .unwrap_err(),
                expected
            );
        }
    }
}
#[test]
fn remedy_guards_refuse_unknown_version_stale_concurrent_cooldown_and_cap() {
    assert_eq!(
        remedies::recipe("your_unshipped_recipe", 1).err().unwrap(),
        "REMEDY_NOT_APPLICABLE"
    );
    let r = remedies::recipe("customer-address-default.retry", 1).unwrap();
    assert_eq!(
        remedies::recipe(&r.id, 2).err().unwrap(),
        "PAYLOAD_MISMATCH"
    );
    let m = Match {
        id: r.id.clone(),
        version: 1,
        matches_now: json!(true),
        target_count: 1,
        ..Default::default()
    };
    assert!(remedies::eligible(r, &m, &Budget::default(), 100, false, false).is_ok());
    assert_eq!(
        remedies::eligible(r, &m, &Budget::default(), 100, true, false).unwrap_err(),
        "REMEDY_NOT_APPLICABLE"
    );
    assert_eq!(
        remedies::eligible(r, &m, &Budget::default(), 100, false, true).unwrap_err(),
        "CONCURRENT_OPERATION"
    );
    assert_eq!(
        remedies::eligible(
            r,
            &m,
            &Budget {
                attempts: 3,
                ..Default::default()
            },
            100,
            false,
            false
        )
        .unwrap_err(),
        "REMEDY_ATTEMPT_CAP"
    );
    assert_eq!(
        remedies::eligible(
            r,
            &m,
            &Budget {
                next: Some(101),
                ..Default::default()
            },
            100,
            false,
            false
        )
        .unwrap_err(),
        "REMEDY_COOLDOWN"
    );
}
#[test]
fn renderer_claim_cannot_establish_native_healing() {
    assert_eq!(remedy_run::verified_outcome(false, &[]), "unknown");
    assert_eq!(remedy_run::verified_outcome(true, &[]), "pending");
    assert_eq!(
        remedy_run::verified_outcome(true, &["sync.queue_failed".into()]),
        "failed"
    );
}

#[test]
fn native_recipe_budget_reads_persisted_owner_state_and_excludes_other_organizations() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value TEXT); CREATE TABLE parity_sync_queue(id TEXT,organization_id TEXT); CREATE TABLE orders(id TEXT,organization_id TEXT); CREATE TABLE recovery_action_log(recipe_id TEXT,action_id TEXT,payload_json TEXT,success INTEGER,created_at TEXT,queue_id TEXT,order_id TEXT,entity_id TEXT,entity_type TEXT,recipe_version INTEGER); INSERT INTO local_settings VALUES('terminal','organization_id','your_org'); INSERT INTO parity_sync_queue VALUES('your_row','your_org'),('foreign_row','foreign_org');").unwrap();
    let r = remedies::recipe("customer-address-default.retry", 1).unwrap();
    for (id, attempts) in [("your_row", 1), ("foreign_row", 3)] {
        conn.execute("INSERT INTO local_settings VALUES('recovery_probe',?1,?2)",rusqlite::params![format!("customer-address-default.retry.v1:{id}"),json!({"recipeId":r.id,"recipeVersion":1,"attempts":attempts,"lastProbeAt":"2030-01-01T00:00:00.000Z"}).to_string()]).unwrap();
    }
    let budget = remedies::budget(&conn, r, None).unwrap();
    assert_eq!(budget.attempts, 1);
    assert_eq!(budget.next, Some(1893456300000));
    conn.execute("UPDATE local_settings SET setting_value='broken' WHERE setting_key='customer-address-default.retry.v1:your_row'",[]).unwrap();
    assert_eq!(
        remedies::budget(&conn, r, None).err().unwrap(),
        "REMEDY_ATTEMPT_CAP"
    );
}

#[test]
fn old_or_renderer_claimed_resolution_is_not_native_verification() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let conn = budget_db();
    let r = remedies::recipe("customer-address-default.retry", 1).unwrap();
    conn.execute("INSERT INTO recovery_action_log(recipe_id,recipe_version,action_id,entity_id,entity_type,payload_json,created_at) VALUES(?1,1,'auto_retry','your_row','parity_sync_queue',?2,'2030-01-01T00:00:00.000Z')", rusqlite::params![r.id,json!({"outcome":"resolved","verifiedAt":"2030-01-01T00:00:01.000Z"}).to_string()]).unwrap();
    let before = crate::support::clock::parse("2030-01-01T00:00:00.000Z").unwrap();
    assert_eq!(
        remedies::native_outcome(&conn, r, Some("your_row"), Some(before))
            .unwrap()
            .as_deref(),
        Some("resolved")
    );
    assert_eq!(
        remedies::native_outcome(&conn, r, Some("your_row"), Some(before + 2000)).unwrap(),
        None
    );
    conn.execute(
        "UPDATE recovery_action_log SET action_id='nativeCustomerAddressDefaultRetry'",
        [],
    )
    .unwrap();
    assert_eq!(
        remedies::native_outcome(&conn, r, Some("your_row"), Some(before)).unwrap(),
        None
    );
}
