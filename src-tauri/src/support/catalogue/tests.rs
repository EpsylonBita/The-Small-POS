use super::*;
use serde_json::json;
use std::{cell::RefCell, time::Instant};

fn execute_at(
    store: &rusqlite::Connection,
    command: &Command,
    action: &Action,
    environment: &dyn Environment,
    now: i64,
) -> Result<Value, String> {
    super::execute(store, command, action, environment, || Ok(now))
}

fn action(id: &str, inputs: Value) -> Action {
    contract::parse(json!({"action_id":id,"version":1,"inputs":inputs})).unwrap()
}

fn printer() -> Value {
    json!({"id":"11111111-1111-4111-8111-111111111111","configuration_revision":1})
}

#[test]
fn shared_canonical_vectors_match_bytes_and_hashes() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/fixtures/catalogue-canonical-vectors.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let payload = contract::canonical_payload(vector["payload"].clone()).unwrap();
        assert_eq!(payload, vector["canonical_json"].as_str().unwrap());
        assert_eq!(contracts::sha256(payload.as_bytes()), vector["sha256"]);
        for key in ["catalogue_version", "implementation_version", "version"] {
            let mut changed = vector["payload"].clone();
            changed[key] = json!(2);
            assert!(contract::canonical_payload(changed).is_err());
        }
    }
}

fn action_cases() -> Vec<(&'static str, Value)> {
    vec![
        (
            "printer.inspect_owned_transport.v1",
            json!({"printer":printer(),"detail":"transport"}),
        ),
        (
            "printer.apply_saved_profile.v1",
            json!({"printer":printer(),"emulation":"escpos"}),
        ),
        (
            "printer.pause_dispatch.v1",
            json!({"printer":printer(),"action":"pause"}),
        ),
        (
            "printer.cancel_one_uncertain_job.v1",
            json!({"printer":printer(),"selection":"oldest_dead_uncertain_nonfiscal"}),
        ),
        (
            "printer.close_proven_orphan.v1",
            json!({"printer":printer(),"selection":"proven_missing_job"}),
        ),
        (
            "sync.explain_blockers.v1",
            json!({"view":"capacity","limit":20}),
        ),
        (
            "network.inspect_configured_route.v1",
            json!({"target":"api"}),
        ),
        (
            "network.inspect_configured_route.v1",
            json!({"target":"printer","printer":printer()}),
        ),
        (
            "checkout.inspect_current_attempt.v1",
            json!({"slot":"current_terminal","view":"status_only"}),
        ),
        (
            "closeout.explain_readiness.v1",
            json!({"section":"closeout_readiness"}),
        ),
        (
            "runtime.sample_db_contention.v1",
            json!({"duration_ms":250}),
        ),
        (
            "updater.inspect_offer.v1",
            json!({"view":"installed_state"}),
        ),
    ]
}

#[test]
fn all_inputs_are_closed_and_versions_and_bounds_are_enforced() {
    assert_eq!(
        action_cases()
            .iter()
            .map(|(id, _)| *id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        11
    );
    for (id, input) in action_cases() {
        let value = json!({"action_id":id,"version":1,"inputs":input});
        assert!(contract::parse(value.clone()).is_ok(), "{id}");
        for key in [
            "command", "script", "sql", "path", "host", "port", "url", "text",
        ] {
            let mut changed = value.clone();
            changed["inputs"][key] = json!("your-untrusted-input");
            assert!(
                serde_json::from_value::<Action>(changed.clone()).is_err(),
                "{id}: {key}"
            );
            assert!(contract::parse(changed).is_err());
        }
        let mut changed = value.clone();
        changed["extra"] = json!(false);
        assert!(serde_json::from_value::<Action>(changed).is_err());
        let mut changed = value;
        changed["version"] = json!(2);
        assert!(serde_json::from_value::<Action>(changed).is_err());
    }
    for input in [
        json!({"view":"capacity","limit":21}),
        json!({"view":"capacity","limit":0}),
    ] {
        assert!(contract::parse(
            json!({"action_id":"sync.explain_blockers.v1","version":1,"inputs":input})
        )
        .is_err());
    }
    let mut p = printer();
    p["configuration_revision"] = json!(9_007_199_254_740_992_u64);
    assert!(contract::parse(json!({"action_id":"printer.pause_dispatch.v1","version":1,"inputs":{"printer":p,"action":"pause"}})).is_err());
}

#[test]
fn printer_resolution_requires_unchanged_enabled_local_profile() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let fixture = crate::tests::harness::TestDb::open();
    let db = fixture.state.conn.lock().unwrap();
    for (key, value) in [
        ("organization_id", "your_org"),
        ("branch_id", "your_branch"),
        ("terminal_id", "22222222-2222-4222-8222-222222222222"),
    ] {
        crate::db::set_setting(&db, "terminal", key, value).unwrap();
    }
    db.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111','your-printer','your-printer','escpos','2026-11-02T12:00:00Z','2026-11-02T12:00:00Z')",[]).unwrap();
    let scope = Scope {
        organization_id: "your_org".into(),
        branch_id: "your_branch".into(),
        terminal_id: "22222222-2222-4222-8222-222222222222".into(),
    };
    let reference =
        configured_printer_ref(&db, &scope, "11111111-1111-4111-8111-111111111111").unwrap();
    let original = resolve_printer(&db, &scope, &reference).unwrap();
    let mut foreign = scope.clone();
    foreign.organization_id = "your_other_org".into();
    assert_eq!(
        resolve_printer(&db, &foreign, &reference).unwrap_err(),
        "PAYLOAD_DRIFT"
    );
    foreign = scope.clone();
    foreign.branch_id = "your_other_branch".into();
    assert_eq!(
        resolve_printer(&db, &foreign, &reference).unwrap_err(),
        "PAYLOAD_DRIFT"
    );
    foreign = scope.clone();
    foreign.terminal_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        resolve_printer(&db, &foreign, &reference).unwrap_err(),
        "PAYLOAD_DRIFT"
    );
    db.execute("UPDATE printer_profiles SET driver_type='windows'", [])
        .unwrap();
    assert_eq!(
        resolve_printer(&db, &scope, &reference).unwrap_err(),
        "PAYLOAD_DRIFT"
    );
    let changed = configured_printer_ref(&db, &scope, &reference.id).unwrap();
    assert_ne!(
        reference.configuration_revision,
        changed.configuration_revision
    );
    assert_ne!(
        original.fingerprint,
        resolve_printer(&db, &scope, &changed).unwrap().fingerprint
    );
    db.execute("UPDATE printer_profiles SET enabled=0", [])
        .unwrap();
    assert_eq!(
        resolve_printer(&db, &scope, &reference).unwrap_err(),
        "PAYLOAD_DRIFT"
    );
    db.execute("DELETE FROM printer_profiles", []).unwrap();
    assert_eq!(
        resolve_printer(&db, &scope, &reference).unwrap_err(),
        "PAYLOAD_DRIFT"
    );
}

#[test]
fn mutation_switch_is_off_for_missing_false_or_stale_and_kills_cover_reads() {
    let mutation = action(
        "printer.close_proven_orphan.v1",
        json!({"printer":printer(),"selection":"proven_missing_job"}),
    );
    let read = action(
        "closeout.explain_readiness.v1",
        json!({"section":"closeout_readiness"}),
    );
    let good = json!({"available":true,"catalogue_mutations":true,"disabled_tools":[]});
    for (value, age) in [
        (Value::Null, Some(0)),
        (json!({"available":true,"disabled_tools":[]}), Some(0)),
        (
            json!({"available":true,"catalogue_mutations":false,"disabled_tools":[]}),
            Some(0),
        ),
        (good.clone(), None),
        (good.clone(), Some(60_001)),
    ] {
        assert_eq!(
            check_availability(&mutation, &value, age).unwrap_err(),
            "FEATURE_DISABLED"
        );
    }
    assert!(check_availability(&mutation, &good, Some(0)).is_ok());
    assert!(check_availability(&read, &Value::Null, None).is_ok());
    let killed = json!({"available":true,"catalogue_mutations":true,"disabled_tools":["catalogue:closeout.explain_readiness.v1"]});
    assert_eq!(
        check_availability(&read, &killed, Some(0)).unwrap_err(),
        "FEATURE_DISABLED"
    );
}

fn command(a: &Action) -> Command {
    let payload = serde_json::to_value(a).unwrap();
    Command {
        command_id: uuid::Uuid::new_v4().to_string(),
        session_id: "33333333-3333-4333-8333-333333333333".into(),
        sequence: 1,
        kind: "till_run_catalogue_action".into(),
        tier: 2,
        payload_sha256: contracts::payload_hash(&payload),
        payload,
        idempotency_key: "your_catalogue_attempt".into(),
        call_id: uuid::Uuid::new_v4().to_string(),
        created_at: "2026-11-02T12:00:00.000Z".into(),
        expires_at: "2026-11-02T12:30:00.000Z".into(),
        server_time: "2026-11-02T12:00:00.000Z".into(),
        approval: None,
    }
}

struct Fake {
    checks: RefCell<usize>,
    fail_at: usize,
    events: RefCell<Vec<&'static str>>,
    critical_in_owner: bool,
    snapshot_failed: bool,
    refusal: Option<&'static str>,
    availability: Option<(Value, Option<u64>)>,
}
impl Default for Fake {
    fn default() -> Self {
        Self {
            checks: RefCell::new(0),
            fail_at: usize::MAX,
            events: RefCell::new(Vec::new()),
            critical_in_owner: false,
            snapshot_failed: false,
            refusal: None,
            availability: None,
        }
    }
}
impl Environment for Fake {
    fn checkpoint(
        &self,
        _: &Command,
        action: &Action,
        permit: &SupportPermit,
    ) -> Result<(), String> {
        let mut checks = self.checks.borrow_mut();
        *checks += 1;
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        if *checks == self.fail_at {
            return Err("SESSION_ENDED".into());
        }
        if let Some((value, age)) = &self.availability {
            check_availability(action, value, *age)?;
        }
        Ok(())
    }
    fn target(&self, _: &Action, _: &SupportPermit) -> Result<Target, String> {
        Ok(Target {
            key: contracts::sha256(b"your-target"),
            fingerprint: contracts::sha256(b"your-config"),
        })
    }
    fn supported(&self, _: Owner) -> bool {
        true
    }
    fn snapshot(&self, _: &Execution<'_>) -> Result<String, String> {
        self.events.borrow_mut().push("snapshot");
        if self.snapshot_failed {
            return Err("SNAPSHOT_FAILED".into());
        }
        Ok("your-snapshot".into())
    }
    fn delegate(&self, owner: Owner, execution: &Execution<'_>) -> Result<Value, String> {
        execution.checkpoint()?;
        self.events.borrow_mut().push(owner.source());
        if let Some(code) = self.refusal {
            return Err(code.into());
        }
        if self.critical_in_owner {
            execution.before_effect()?;
            let _critical =
                critical_op::global().begin_critical(critical_op::CriticalKind::Checkout);
            execution.checkpoint()?;
        }
        Ok(
            json!({"kind":"untrusted_till_data","outcome":"pending","observation_time":"2026-11-02T12:00:00.000Z","source":owner.source(),"complete":true,"details":[]}),
        )
    }
}

#[test]
fn reused_actions_delegate_only_after_snapshot_intent_and_fresh_checks() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for (id, input, source) in [
        (
            "printer.apply_saved_profile.v1",
            json!({"printer":printer(),"emulation":"star_line"}),
            "device_apply",
        ),
        (
            "printer.close_proven_orphan.v1",
            json!({"printer":printer(),"selection":"proven_missing_job"}),
            "native_orphan_close",
        ),
        (
            "closeout.explain_readiness.v1",
            json!({"section":"closeout_readiness"}),
            "closeout_readiness",
        ),
    ] {
        let root = crate::tests::harness::TempDir::new();
        let store = super::super::db::SupportDb::open(root.path()).unwrap();
        let a = action(id, input);
        let c = command(&a);
        let env = Fake::default();
        execute_at(&store.conn, &c, &a, &env, 1_000).unwrap();
        let expected = if a.changes_state() {
            vec!["snapshot", source]
        } else {
            vec![source]
        };
        assert_eq!(*env.events.borrow(), expected);
        let intents: u64 = store
            .conn
            .query_row("SELECT count(*) FROM support_dry_runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(intents, u64::from(a.changes_state()));
    }
}

#[test]
fn reused_action_refusals_survive_and_disabled_killed_stale_actions_reach_no_owner() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for (id, inputs) in action_cases().into_iter().filter(|(id, _)| {
        matches!(
            *id,
            "printer.apply_saved_profile.v1"
                | "printer.close_proven_orphan.v1"
                | "printer.pause_dispatch.v1"
                | "printer.cancel_one_uncertain_job.v1"
        )
    }) {
        let a = action(id, inputs);
        for code in ["POLICY_REFUSED", "REMEDY_NOT_APPLICABLE", "ONSITE_DECLINED"] {
            let root = crate::tests::harness::TempDir::new();
            let store = super::super::db::SupportDb::open(root.path()).unwrap();
            let env = Fake {
                refusal: Some(code),
                ..Default::default()
            };
            assert_eq!(
                execute_at(&store.conn, &command(&a), &a, &env, 0).unwrap_err(),
                code
            );
            assert!(env.events.borrow().contains(&owner(&a).unwrap().source()));
            let outcome: String = store
                .conn
                .query_row(
                    "SELECT json_extract(result_json,'$.outcome') FROM support_dry_runs",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(outcome, "failed");
        }
        for (value, age) in [
            (
                json!({"available":true,"catalogue_mutations":false,"disabled_tools":[]}),
                Some(0),
            ),
            (
                json!({"available":true,"catalogue_mutations":true,"disabled_tools":[format!("catalogue:{id}")]}),
                Some(0),
            ),
            (
                json!({"available":true,"catalogue_mutations":true,"disabled_tools":[]}),
                Some(60_001),
            ),
        ] {
            let root = crate::tests::harness::TempDir::new();
            let store = super::super::db::SupportDb::open(root.path()).unwrap();
            let env = Fake {
                availability: Some((value, age)),
                ..Default::default()
            };
            assert_eq!(
                execute_at(&store.conn, &command(&a), &a, &env, 0).unwrap_err(),
                "FEATURE_DISABLED"
            );
            assert!(env.events.borrow().is_empty());
            assert_eq!(
                store
                    .conn
                    .query_row("SELECT count(*) FROM support_dry_runs", [], |row| row
                        .get::<_, u64>(0))
                    .unwrap(),
                0
            );
        }
        let root = crate::tests::harness::TempDir::new();
        let store = super::super::db::SupportDb::open(root.path()).unwrap();
        let env = Fake {
            critical_in_owner: true,
            ..Default::default()
        };
        assert_eq!(
            execute_at(&store.conn, &command(&a), &a, &env, 0).unwrap_err(),
            "OUTCOME_UNKNOWN"
        );
    }
}

#[test]
fn interrupted_mutation_is_unknown_and_is_not_replayed_after_reopen() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let root = crate::tests::harness::TempDir::new();
    let a = action(
        "printer.close_proven_orphan.v1",
        json!({"printer":printer(),"selection":"proven_missing_job"}),
    );
    let c = command(&a);
    let env = Fake {
        critical_in_owner: true,
        ..Default::default()
    };
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    assert_eq!(
        execute_at(&store.conn, &c, &a, &env, 1_000).unwrap_err(),
        "OUTCOME_UNKNOWN"
    );
    drop(store);
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    let fresh = Fake::default();
    assert_eq!(
        execute_at(&store.conn, &c, &a, &fresh, 601_000).unwrap_err(),
        "OUTCOME_UNKNOWN"
    );
    assert!(!fresh.events.borrow().contains(&"native_orphan_close"));
}

#[test]
fn budget_survives_restart_and_wait_refusal_does_not_reach_owner() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let root = crate::tests::harness::TempDir::new();
    let a = action(
        "printer.close_proven_orphan.v1",
        json!({"printer":printer(),"selection":"proven_missing_job"}),
    );
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    execute_at(&store.conn, &command(&a), &a, &Fake::default(), 1_000).unwrap();
    drop(store);
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    assert_eq!(
        execute_at(&store.conn, &command(&a), &a, &Fake::default(), 300_999).unwrap_err(),
        "REMEDY_COOLDOWN"
    );
    execute_at(&store.conn, &command(&a), &a, &Fake::default(), 301_000).unwrap();
    assert_eq!(
        execute_at(&store.conn, &command(&a), &a, &Fake::default(), 601_000).unwrap_err(),
        "REMEDY_ATTEMPT_CAP"
    );
    let env = Fake {
        fail_at: 2,
        ..Default::default()
    };
    assert_eq!(
        execute_at(&store.conn, &command(&a), &a, &env, 901_000).unwrap_err(),
        "SESSION_ENDED"
    );
    assert!(env.events.borrow().is_empty());
}

#[test]
fn critical_operation_cancels_read_and_refuses_atomic_admission() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let root = crate::tests::harness::TempDir::new();
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    let a = action(
        "closeout.explain_readiness.v1",
        json!({"section":"closeout_readiness"}),
    );
    let env = Fake {
        critical_in_owner: true,
        ..Default::default()
    };
    assert_eq!(
        execute_at(&store.conn, &command(&a), &a, &env, 0).unwrap_err(),
        "PREEMPTED_BY_CRITICAL_OPERATION"
    );
    let _critical = critical_op::global().begin_critical(critical_op::CriticalKind::Card);
    assert_eq!(
        execute_at(&store.conn, &command(&a), &a, &Fake::default(), 0).unwrap_err(),
        "deferred_critical_operation"
    );
}

#[test]
fn output_rejects_wrong_source_extra_fields_raw_text_and_excess_rows_or_bytes() {
    let a = action(
        "closeout.explain_readiness.v1",
        json!({"section":"closeout_readiness"}),
    );
    let value = json!({"kind":"untrusted_till_data","outcome":"unknown","observation_time":"2026-11-02T12:00:00.000Z","source":"closeout_readiness","complete":false,"details":[{"state":"unavailable","active_shifts":0,"pending_payments":0,"pending_fiscal":0,"queued_closeouts":0}]});
    contract::validate_output(&a, &value).unwrap();
    for (key, wrong) in [
        ("source", json!("syncNow")),
        ("outcome", json!("succeeded")),
        ("observation_time", json!("your-date")),
        ("stdout", json!("your-text")),
    ] {
        let mut changed = value.clone();
        changed[key] = wrong;
        assert!(contract::validate_output(&a, &changed).is_err());
    }
    let mut changed = value.clone();
    changed["details"][0]["amount"] = json!(1);
    assert!(contract::validate_output(&a, &changed).is_err());
    let mut changed = value.clone();
    changed["details"] = json!(vec![value["details"][0].clone(); 21]);
    assert_eq!(
        contract::validate_output(&a, &changed).unwrap_err(),
        "RESULT_TOO_LARGE"
    );
    let mut changed = value;
    changed["stdout"] = json!("x".repeat(16_384));
    assert_eq!(
        contract::validate_output(&a, &changed).unwrap_err(),
        "RESULT_TOO_LARGE"
    );
}

#[test]
fn every_checkpoint_rechecks_authority_including_after_snapshot_and_owner() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let a = action(
        "printer.close_proven_orphan.v1",
        json!({"printer":printer(),"selection":"proven_missing_job"}),
    );
    for fail_at in 1..=9 {
        let root = crate::tests::harness::TempDir::new();
        let store = super::super::db::SupportDb::open(root.path()).unwrap();
        let env = Fake {
            fail_at,
            ..Default::default()
        };
        let result = execute_at(&store.conn, &command(&a), &a, &env, 0);
        assert_eq!(result.unwrap_err(), "SESSION_ENDED");
        assert!(*env.checks.borrow() >= fail_at);
    }
}

#[test]
fn failed_snapshot_never_creates_an_intent_or_reaches_an_owner() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let root = crate::tests::harness::TempDir::new();
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    let a = action(
        "printer.close_proven_orphan.v1",
        json!({"printer":printer(),"selection":"proven_missing_job"}),
    );
    let env = Fake {
        snapshot_failed: true,
        ..Default::default()
    };
    assert_eq!(
        execute_at(&store.conn, &command(&a), &a, &env, 1_000).unwrap_err(),
        "SNAPSHOT_FAILED"
    );
    assert_eq!(*env.events.borrow(), ["snapshot"]);
    let count: u64 = store
        .conn
        .query_row("SELECT count(*) FROM support_dry_runs", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn cancellation_budget_is_one_and_intents_cannot_be_used_as_sql_previews() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let root = crate::tests::harness::TempDir::new();
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    let a = action(
        "printer.cancel_one_uncertain_job.v1",
        json!({"printer":printer(),"selection":"oldest_dead_uncertain_nonfiscal"}),
    );
    let c = command(&a);
    let other = command(&a);
    let env = Fake::default();
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let target = env.target(&a, &permit).unwrap();
    let execution = Execution {
        command: &c,
        action: &a,
        permit: &permit,
        environment: &env,
        target: &target,
        accepted_fingerprint: RefCell::new(None),
        effect_started: Cell::new(false),
        deadline: None,
    };
    let intent = begin_intent(&store.conn, &execution, "your-verified-snapshot", || {
        Ok(1_000)
    })
    .unwrap();
    assert!(super::super::dry_run::load(&store.conn, &intent).is_err());
    finish_intent(&store.conn, &intent, &json!({"outcome":"pending"})).unwrap();
    let execution = Execution {
        command: &other,
        ..execution
    };
    assert_eq!(
        begin_intent(&store.conn, &execution, "your-second-snapshot", || Ok(
            301_000
        ))
        .unwrap_err(),
        "REMEDY_ATTEMPT_CAP"
    );
    assert_eq!(
        store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn real_session_admission_checks_expiry_visibility_switches_and_merged_kill_list() {
    let a = action(
        "printer.close_proven_orphan.v1",
        json!({"printer":printer(),"selection":"proven_missing_job"}),
    );
    let c = command(&a);
    let mut clock = super::super::clock::ServerClock::default();
    clock
        .observe(&c.session_id, &c.server_time, Instant::now())
        .unwrap();
    let admission = super::super::delivery::Admission {
        session_id: c.session_id.clone(),
        active: true,
        online: true,
        visible: true,
        tier_ceiling: 2,
        tiers_enabled: [1, 2].into_iter().collect(),
        disabled_tools: Default::default(),
        max_expires_at: c.expires_at.clone(),
    };
    check_session(&c, &a, &admission, &clock, true).unwrap();
    let mut changed = admission.clone();
    changed.active = false;
    assert_eq!(
        check_session(&c, &a, &changed, &clock, true).unwrap_err(),
        "SESSION_ENDED"
    );
    changed = admission.clone();
    changed.session_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        check_session(&c, &a, &changed, &clock, true).unwrap_err(),
        "SESSION_ENDED"
    );
    changed = admission.clone();
    changed.online = false;
    assert_eq!(
        check_session(&c, &a, &changed, &clock, true).unwrap_err(),
        "TILL_OFFLINE"
    );
    assert_eq!(
        check_session(&c, &a, &admission, &clock, false).unwrap_err(),
        "TILL_PAUSED"
    );
    changed = admission.clone();
    changed.visible = false;
    assert_eq!(
        check_session(&c, &a, &changed, &clock, true).unwrap_err(),
        "TILL_PAUSED"
    );
    changed = admission.clone();
    changed.max_expires_at = c.server_time.clone();
    assert_eq!(
        check_session(&c, &a, &changed, &clock, true).unwrap_err(),
        "SESSION_EXPIRED"
    );
    let mut expired = c.clone();
    expired.expires_at = c.server_time.clone();
    assert_eq!(
        check_session(&expired, &a, &admission, &clock, true).unwrap_err(),
        "COMMAND_EXPIRED"
    );
    changed = admission.clone();
    changed.tiers_enabled.remove(&2);
    assert_eq!(
        check_session(&c, &a, &changed, &clock, true).unwrap_err(),
        "FEATURE_DISABLED"
    );
    for killed in [
        "till_run_catalogue_action",
        "catalogue:printer.close_proven_orphan.v1",
    ] {
        changed = admission.clone();
        changed.disabled_tools.insert(killed.into());
        assert_eq!(
            check_session(&c, &a, &changed, &clock, true).unwrap_err(),
            "FEATURE_DISABLED"
        );
    }
}

#[test]
fn closeout_catalogue_is_admitted_at_tier_one_and_cancel_stays_proposal_only() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let a = action(
        "closeout.explain_readiness.v1",
        json!({"section":"closeout_readiness"}),
    );
    let mut c = command(&a);
    c.tier = 1;
    let mut clock = super::super::clock::ServerClock::default();
    clock
        .observe(&c.session_id, &c.server_time, Instant::now())
        .unwrap();
    let mut admission = delivery::Admission {
        session_id: c.session_id.clone(),
        active: true,
        online: true,
        visible: true,
        tier_ceiling: 1,
        tiers_enabled: [1].into_iter().collect(),
        disabled_tools: Default::default(),
        max_expires_at: c.expires_at.clone(),
    };
    check_session(&c, &a, &admission, &clock, true).unwrap();
    c.tier = 2;
    assert_eq!(
        delivery::recheck(&c, &admission, &clock, Instant::now()),
        Err("TIER_NOT_ALLOWED")
    );
    let cancel = action(
        "printer.cancel_one_uncertain_job.v1",
        json!({"printer":printer(),"selection":"oldest_dead_uncertain_nonfiscal"}),
    );
    let mut c = command(&cancel);
    c.tier = 3;
    admission.tier_ceiling = 3;
    admission.tiers_enabled.insert(3);
    assert_eq!(
        delivery::recheck(&c, &admission, &clock, Instant::now()),
        Err("INVALID_INPUT")
    );
    assert_eq!(owner(&cancel), Some(Owner::PrinterMutation));
}

#[test]
fn native_closeout_owner_is_read_only_keyring_free_and_fails_closed() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    {
        let writer = db.state.conn.lock().unwrap();
        for (key, value) in [
            ("organization_id", "your-org"),
            ("branch_id", "your-branch"),
            ("terminal_id", "your-terminal"),
        ] {
            crate::db::set_setting(&writer, "terminal", key, value).unwrap();
        }
        writer.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,status,idempotency_key) VALUES('order','your-order','insert','{}','pending','your-order-key')",[]).unwrap();
        writer.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,status,idempotency_key) VALUES('z_report','your-z','insert','{}','pending','your-z-key')",[]).unwrap();
        writer.execute("INSERT INTO parity_sync_queue(id,table_name,operation,record_id,data,status,organization_id) VALUES('your-queue','z_reports','INSERT','your-z2','{}','pending','your-org')",[]).unwrap();
    }
    crate::tests::fake_keyring::before_each_read(|key| panic!("support read keyring: {key}"));
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .unwrap();
    let read = replica::read_connection(
        db.db_path(),
        &permit,
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap();
    let a = action(
        "closeout.explain_readiness.v1",
        json!({"section":"closeout_readiness"}),
    );
    let before = std::fs::read(db.db_path()).unwrap();
    for owner in [Owner::DeviceApply, Owner::NativeOrphanClose] {
        assert_eq!(
            native_supported(owner),
            matches!(owner, Owner::DeviceApply | Owner::NativeOrphanClose)
        );
        assert_eq!(
            delegate_read(owner, &read, &permit).unwrap_err(),
            "FEATURE_DISABLED"
        );
    }
    assert!(native_supported(Owner::CloseoutReadiness));
    let output = delegate_read(Owner::CloseoutReadiness, &read, &permit).unwrap();
    contract::validate_output(&a, &output).unwrap();
    assert_eq!(output["source"], "closeout_readiness");
    assert_eq!(output["complete"], true);
    assert_eq!(output["details"][0]["state"], "blocked");
    assert_eq!(output["details"][0]["queued_closeouts"], 2);
    assert_eq!(output["details"][0]["active_shifts"], 0);
    struct ReadOwner<'a> {
        conn: &'a Connection,
    }
    impl Environment for ReadOwner<'_> {
        fn checkpoint(&self, _c: &Command, _a: &Action, p: &SupportPermit) -> Result<(), String> {
            if p.is_cancelled() {
                return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
            }
            super::super::identity::local(self.conn).map(|_| ())
        }
        fn target(&self, _a: &Action, _p: &SupportPermit) -> Result<Target, String> {
            let scope = super::super::identity::local(self.conn)?;
            Ok(Target {
                key: scope.terminal_id,
                fingerprint: scope.branch_id,
            })
        }
        fn supported(&self, o: Owner) -> bool {
            native_supported(o)
        }
        fn snapshot(&self, _e: &Execution<'_>) -> Result<String, String> {
            panic!("read must not snapshot")
        }
        fn delegate(&self, o: Owner, e: &Execution<'_>) -> Result<Value, String> {
            delegate_read(o, self.conn, e.permit)
        }
    }
    let root = crate::tests::harness::TempDir::new();
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    let output = execute_at(&store.conn, &command(&a), &a, &ReadOwner { conn: &read }, 0).unwrap();
    contract::validate_output(&a, &output).unwrap();
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM support_dry_runs", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    assert_eq!(before, std::fs::read(db.db_path()).unwrap());
    db.state
        .conn
        .lock()
        .unwrap()
        .execute_batch("DROP TABLE parity_sync_queue")
        .unwrap();
    assert!(delegate_read(Owner::CloseoutReadiness, &read, &permit).is_err());
}

#[test]
fn catalogue_reference_and_read_selection_is_keyring_free() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    let writer = db.state.conn.lock().unwrap();
    for (key, value) in [
        ("organization_id", "your-org"),
        ("branch_id", "your-branch"),
        ("terminal_id", "your-terminal"),
    ] {
        crate::db::set_setting(&writer, "terminal", key, value).unwrap();
    }
    writer.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111','your-printer','your-printer','escpos','2026-11-02T12:00:00Z','2026-11-02T12:00:00Z')",[]).unwrap();
    crate::tests::fake_keyring::before_each_read(|key| panic!("support read keyring: {key}"));
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .unwrap();
    let read = replica::read_connection(
        db.db_path(),
        &permit,
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap();
    let scope = local_scope(&read).unwrap();
    let reference =
        configured_printer_ref(&read, &scope, "11111111-1111-4111-8111-111111111111").unwrap();
    for (id, mut inputs) in action_cases() {
        if inputs.get("printer").is_some() {
            inputs["printer"] = serde_json::to_value(&reference).unwrap();
        }
        let action = action(id, inputs);
        assert_eq!(local_scope(&read).unwrap(), scope);
        if let Some(reference) = action.printer() {
            resolve_printer(&read, &scope, reference).unwrap();
        }
        if let Some(owner) = owner(&action) {
            if owner == Owner::CloseoutReadiness {
                contract::validate_output(&action, &delegate_read(owner, &read, &permit).unwrap())
                    .unwrap();
            } else {
                assert_eq!(
                    delegate_read(owner, &read, &permit).unwrap_err(),
                    "FEATURE_DISABLED"
                );
            }
        }
    }
}

#[test]
fn removed_remedy_actions_are_unknown_to_rust_and_shared_contracts() {
    for (id, inputs) in [
        (
            "printer.print_fixed_sample.v1",
            json!({"printer":printer(),"sample":"transport_text"}),
        ),
        ("sync.request_normal_pass.v1", json!({})),
    ] {
        let value = json!({"action_id":id,"version":1,"inputs":inputs});
        assert!(
            serde_json::from_value::<Action>(value.clone()).is_err(),
            "{id}"
        );
        assert_eq!(contract::parse(value).unwrap_err(), "INVALID_INPUT");
    }
}

#[test]
fn cancellation_budget_is_one_per_job_attempt_across_sessions() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let root = crate::tests::harness::TempDir::new();
    let store = super::super::db::SupportDb::open(root.path()).unwrap();
    let a = action(
        "printer.cancel_one_uncertain_job.v1",
        json!({"printer":printer(),"selection":"oldest_dead_uncertain_nonfiscal"}),
    );
    let c = command(&a);
    let env = Fake::default();
    execute_at(&store.conn, &c, &a, &env, 0).unwrap();
    let mut other = command(&a);
    other.session_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        execute_at(&store.conn, &other, &a, &env, 300_001).unwrap_err(),
        "REMEDY_ATTEMPT_CAP"
    );
}
