use super::*;
use crate::support::{catalogue::contract, critical_op};
static SAMPLE_TEST: Mutex<()> = Mutex::new(());

fn cases() -> Vec<Action> {
    [
        ("printer.inspect_owned_transport.v1",json!({"printer":{"id":"11111111-1111-4111-8111-111111111111","configuration_revision":1},"detail":"transport"})),
        ("sync.explain_blockers.v1",json!({"view":"retry_disposition","limit":20})),
        ("network.inspect_configured_route.v1",json!({"target":"api"})),
        ("checkout.inspect_current_attempt.v1",json!({"slot":"current_terminal","view":"status_only"})),
        ("runtime.sample_db_contention.v1",json!({"duration_ms":250})),
        ("updater.inspect_offer.v1",json!({"view":"current_offer"})),
    ].into_iter().map(|(action_id,inputs)|contract::parse(json!({"action_id":action_id,"version":1,"inputs":inputs})).unwrap()).collect()
}
fn identity(conn: &Connection) {
    conn.execute_batch("CREATE TABLE local_settings(setting_category TEXT,setting_key TEXT,setting_value TEXT);
        INSERT INTO local_settings VALUES('terminal','organization_id','your_org'),('terminal','branch_id','your_branch'),
        ('terminal','terminal_id','22222222-2222-4222-8222-222222222222');").unwrap();
}
fn business() -> DbState {
    DbState {
        conn: Mutex::new(Connection::open_in_memory().unwrap()),
        db_path: ":memory:".into(),
    }
}

#[test]
fn every_read_only_output_validates_without_secrets_writes_or_business_lock() {
    let _serial = SAMPLE_TEST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let _gate = critical_op::install_test_gate();
    let conn = Connection::open_in_memory().unwrap();
    identity(&conn);
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let db = business();
    let _held = db.conn.lock().unwrap();
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .unwrap();
    for action in cases() {
        let value = collect(&conn, &db, &action, &permit, &|| Ok(()), None).unwrap();
        contract::validate_output(&action, &value).unwrap();
        assert_ne!(value["outcome"], "resolved");
        for forbidden in [
            "your_org",
            "22222222",
            "amount",
            "payload",
            "document_name",
            "your-secret",
            "last_error",
            "clientRequestId",
        ] {
            assert!(
                !value.to_string().contains(forbidden),
                "{}: {forbidden}",
                action.id()
            );
        }
        if !matches!(
            action,
            Action::InspectRoute { .. } | Action::SampleContention { .. }
        ) {
            assert_eq!(value["complete"], false, "{}", action.id());
        }
    }
    assert_eq!(conn.total_changes(), 3);
}

#[test]
fn every_read_only_action_cancels_when_critical_work_starts() {
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let _gate = critical_op::install_test_gate();
    let conn = Connection::open_in_memory().unwrap();
    identity(&conn);
    let db = business();
    for action in cases() {
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .unwrap();
        let calls = std::cell::Cell::new(0);
        let token = std::cell::RefCell::new(None);
        let check = || {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                *token.borrow_mut() =
                    Some(critical_op::global().begin_critical(critical_op::CriticalKind::Checkout));
            }
            Ok(())
        };
        assert_eq!(
            collect(&conn, &db, &action, &permit, &check, None).unwrap_err(),
            "PREEMPTED_BY_CRITICAL_OPERATION",
            "{}",
            action.id()
        );
        drop(token);
    }
}

#[test]
fn sampler_reports_untraced_poison_and_single_sampler_and_cancels_between_ticks() {
    let _serial = SAMPLE_TEST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let _gate = critical_op::install_test_gate();
    let db = business();
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .unwrap();
    let held = db.conn.lock().unwrap();
    let value = sample(&db.conn, 250, &permit, &|| Ok(())).unwrap();
    assert_eq!(value["details"][0]["state"], "untraced_contention");
    assert_eq!(value["details"][0]["samples"], 5);
    drop(held);
    let traced = database_lock::lock(&db.conn, "checkout_draft_inspect").unwrap();
    let traced_value = sample(&db.conn, 250, &permit, &|| Ok(())).unwrap();
    assert_eq!(traced_value["details"][0]["state"], "traced_holder");
    assert_eq!(traced_value["details"][0]["label"], "checkout");
    drop(traced);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _held = db.conn.lock().unwrap();
        panic!("test poison")
    }));
    let value = sample(&db.conn, 250, &permit, &|| Ok(())).unwrap();
    assert_eq!(value["details"][0]["state"], "poisoned");
    assert_eq!(value["complete"], false);
    let active = Sampling::begin().unwrap();
    assert!(matches!(Sampling::begin(),Err(code) if code=="CONCURRENT_OPERATION"));
    drop(active);
    let calls = std::cell::Cell::new(0);
    let critical = std::cell::RefCell::new(None);
    let check = || {
        calls.set(calls.get() + 1);
        if calls.get() == 3 {
            *critical.borrow_mut() =
                Some(critical_op::global().begin_critical(critical_op::CriticalKind::Card));
        }
        Ok(())
    };
    assert_eq!(
        sample(&db.conn, 1000, &permit, &check).unwrap_err(),
        "PREEMPTED_BY_CRITICAL_OPERATION"
    );
}

#[test]
fn updater_retained_offer_is_unverified_and_current_offer_is_unavailable() {
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let conn = Connection::open_in_memory().unwrap();
    identity(&conn);
    conn.execute("INSERT INTO local_settings VALUES('local','updater_state',?1)",[json!({"available":true,"updateInfo":{"version":"0.0.1","releaseNotes":"your-secret"},"error":"your-secret","downloadedArtifactPath":"your-secret"}).to_string()]).unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let before = conn.total_changes();
    let retained = updater(&conn, UpdaterView::InstalledState);
    assert_eq!(retained["details"][0]["state"], "lower_offer");
    assert_eq!(retained["details"][0]["artifact_verified"], false);
    let fresh = updater(&conn, UpdaterView::CurrentOffer);
    assert_eq!(fresh["details"][0]["state"], "unavailable");
    assert_eq!(fresh["complete"], false);
    assert!(!retained.to_string().contains("your-secret"));
    assert_eq!(before, conn.total_changes());
}

#[test]
fn sync_unknown_codes_are_never_transport_and_partial_sources_are_unavailable() {
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let fixture = crate::tests::harness::TestDb::open();
    let conn = fixture.state.conn.lock().unwrap();
    for (key, value) in [
        ("organization_id", "your_org"),
        ("branch_id", "your_branch"),
        ("terminal_id", "22222222-2222-4222-8222-222222222222"),
    ] {
        crate::db::set_setting(&conn, "terminal", key, value).unwrap();
    }
    conn.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,status,error_message) VALUES('your-row','orders','your-order','INSERT','{}','your_org','failed','your-secret-error-prose')",[]).unwrap();
    conn.execute_batch("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,status,error_message,next_retry_at) VALUES
        ('your-400','orders','your-order','INSERT','{}','your_org','failed','HTTP_400',NULL),
        ('your-409','orders','your-order','INSERT','{}','your_org','failed','HTTP_409',NULL),
        ('your-429','orders','your-order','INSERT','{}','your_org','pending','HTTP_429_RATE_LIMITED',datetime('now','+1 minute')),
        ('your-wait','orders','your-order','INSERT','{}','your_org','pending','SHIFT_WAITING_FOR_CHECK_IN: your-secret',NULL),
        ('your-foreign','orders','your-order','INSERT','{}','your_other_org','failed','your-secret',NULL)").unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let action = cases().remove(1);
    let Action::ExplainSync { inputs, .. } = &action else {
        unreachable!()
    };
    let value = sync(&conn, inputs).unwrap();
    contract::validate_output(&action, &value).unwrap();
    assert!(value["details"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["source"] == "central_queue"
            && row["disposition"] == "unknown"
            && row["count"] == 3));
    assert!(value["details"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["source"] == "central_queue"
            && row["disposition"] == "rate_limited"
            && row["retry_after_s"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= 60)));
    assert!(value["details"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["source"] == "central_queue"
            && row["disposition"] == "dependency_wait"
            && row["count"] == 1));
    assert!(!value.to_string().contains("your-secret-error-prose"));
    assert!(!value.to_string().contains("exhausted_transport"));
    assert!(value["details"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["disposition"] == "unavailable"));
    assert_eq!(value["complete"], false);
}

#[test]
fn printer_reads_durable_windows_attempt_without_live_inventory_or_content() {
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let fixture = crate::tests::harness::TestDb::open();
    let conn = fixture.state.conn.lock().unwrap();
    let id = "11111111-1111-4111-8111-111111111111";
    // An unverified USB configuration must not fall through to live enumeration.
    conn.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,printer_type,created_at,updated_at) VALUES(?1,'your-printer','your-queue','escpos','usb',?2,?2)",rusqlite::params![id,chrono::Utc::now().to_rfc3339()]).unwrap();
    let Action::InspectPrinter { mut inputs, .. } = cases().remove(0) else {
        unreachable!()
    };
    assert_eq!(printer(&conn, &inputs, None)["complete"], false);
    conn.execute("UPDATE printer_profiles SET printer_type='system'", [])
        .unwrap();
    conn.execute("INSERT INTO print_jobs(id,entity_type,entity_id,printer_profile_id,status,created_at,updated_at) VALUES('your-job','order','your-order',?1,'printing',?2,?2)",rusqlite::params![id,chrono::Utc::now().to_rfc3339()]).unwrap();
    conn.execute("INSERT INTO print_job_attempts(id,print_job_id,attempt_number,transport,resolved_target,document_name,spool_job_id,state,started_at,last_error,native_status_text) VALUES('your-attempt','your-job',1,'windows','your-queue','your-secret-document',1,'windows_queued',?1,'your-secret-error','your-secret-status')",[chrono::Utc::now().to_rfc3339()]).unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let before = conn.total_changes();
    let transport = printer(&conn, &inputs, None);
    assert_eq!(transport["details"][0]["state"], "queued");
    assert_eq!(transport["details"][0]["ownership"], "owned");
    assert!(!transport.to_string().contains("your-secret"));
    inputs.detail = PrinterDetail::SpoolerService;
    let service = printer(&conn, &inputs, None);
    assert_eq!(service["details"][0]["service"], "unavailable");
    assert_eq!(service["complete"], false);
    assert_eq!(
        service["details"][0]["unavailable_reason"],
        "live_check_on_site"
    );
    assert_eq!(conn.total_changes(), before);
}

#[test]
fn printer_carries_only_a_well_formed_cancel_target() {
    let fixture = crate::tests::harness::TestDb::open();
    let conn = fixture.state.conn.lock().unwrap();
    let action = cases().remove(0);
    let Action::InspectPrinter { inputs, .. } = &action else {
        unreachable!()
    };
    let without = printer(&conn, inputs, None);
    assert!(without["details"][0]
        .get("cancel_target_fingerprint")
        .is_none());
    assert!(super::super::contract::validate_output(&action, &without).is_ok());
    let target = "a".repeat(64);
    let with = printer(&conn, inputs, Some(&target));
    assert_eq!(with["details"][0]["cancel_target_fingerprint"], target);
    assert!(super::super::contract::validate_output(&action, &with).is_ok());
    let malformed = printer(&conn, inputs, Some("not-a-fingerprint"));
    assert_eq!(
        super::super::contract::validate_output(&action, &malformed),
        Err("INVALID_INPUT".into())
    );
}

#[test]
fn checkout_status_uses_the_support_connection_and_never_claims_absence_is_safe() {
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let fixture = crate::tests::harness::TestDb::open();
    let conn = fixture.state.conn.lock().unwrap();
    for (key, value) in [
        ("organization_id", "your_org"),
        ("branch_id", "your_branch"),
        ("terminal_id", "22222222-2222-4222-8222-222222222222"),
    ] {
        crate::db::set_setting(&conn, "terminal", key, value).unwrap();
    }
    conn.execute_batch("CREATE TABLE checkout_drafts_v1(organization_id TEXT,branch_id TEXT,terminal_id TEXT,generation INTEGER,draft_json TEXT,updated_at TEXT)").unwrap();
    conn.execute("INSERT INTO checkout_drafts_v1 VALUES('your_org','your_branch','22222222-2222-4222-8222-222222222222',7,?1,?2)",rusqlite::params![json!({"phase":"checkout_pending","checkoutRequestId":"your-request","amount":9999,"customer":"your-secret"}).to_string(),chrono::Utc::now().to_rfc3339()]).unwrap();
    for key in ["your-first", "your-second"] {
        crate::db::set_setting(
            &conn,
            "unsaved_charged_payment",
            key,
            &json!({"orderId":"your-request","amount":9999,"customer":"your-secret"}).to_string(),
        )
        .unwrap();
    }
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let before = conn.total_changes();
    let value = checkout(&conn, &fixture.state);
    let action = cases().remove(3);
    contract::validate_output(&action, &value).unwrap();
    assert_eq!(value["complete"], true);
    assert_eq!(value["details"][0]["state"], "uncertain");
    assert_eq!(value["details"][0]["phase"], "checkout_pending");
    assert_eq!(value["details"][0]["generation"], 7);
    assert_eq!(value["details"][0]["pending_payments"], 2);
    assert!(!value.to_string().contains("your-secret"));
    assert!(!value.to_string().contains("9999"));
    let live = crate::commands::orders::claim_checkout(&fixture.state, "your-request")
        .unwrap()
        .unwrap();
    assert_eq!(value["details"][0]["checkout_in_progress"], false);
    let running = checkout(&conn, &fixture.state);
    assert_eq!(running["complete"], false);
    assert_eq!(running["details"][0]["checkout_in_progress"], true);
    assert_eq!(running["details"][0]["phase"], "checkout_pending");
    drop(live);
    assert_eq!(conn.total_changes(), before);
    conn.execute_batch("PRAGMA query_only=OFF; UPDATE checkout_drafts_v1 SET updated_at='2020-01-01T00:00:00Z'; PRAGMA query_only=ON").unwrap();
    let stale = checkout(&conn, &fixture.state);
    assert_eq!(stale["complete"], false);
    assert_eq!(stale["details"][0]["phase"], "unknown");
    assert_ne!(stale["details"][0]["state"], "not_found");
}

#[test]
fn queue_projection_queries_match_current_owner_schemas_and_limit_is_honest() {
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let fixture = crate::tests::harness::TestDb::open();
    let conn = fixture.state.conn.lock().unwrap();
    for (key, value) in [
        ("organization_id", "your_org"),
        ("branch_id", "your_branch"),
        ("terminal_id", "22222222-2222-4222-8222-222222222222"),
    ] {
        crate::db::set_setting(&conn, "terminal", key, value).unwrap();
    }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS checkout_drafts_v1(organization_id TEXT,branch_id TEXT,terminal_id TEXT,draft_json TEXT);
        CREATE TABLE IF NOT EXISTS table_attempt_recovery_v1(organization_id TEXT,branch_id TEXT,terminal_id TEXT,status TEXT,last_error_code TEXT);
        CREATE TABLE IF NOT EXISTS gift_card_funding_attempts(organization_id TEXT,branch_id TEXT,terminal_id TEXT,state TEXT);
        CREATE TABLE IF NOT EXISTS gift_card_return_attempts(organization_id TEXT,branch_id TEXT,terminal_id TEXT,state TEXT);").unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let Action::ExplainSync { mut inputs, .. } = cases().remove(1) else {
        unreachable!()
    };
    let value = sync(&conn, &inputs).unwrap();
    assert_eq!(value["complete"], true, "{value}");
    assert_eq!(value["details"].as_array().unwrap().len(), 10);
    inputs.limit = 1;
    assert_eq!(sync(&conn, &inputs).unwrap()["complete"], false);
}

#[test]
fn diagnostic_paths_cannot_reintroduce_live_printer_or_updater_owners() {
    let printer = include_str!("../../../print_dispatch.rs")
        .split("pub(crate) fn support_inspect_transport(")
        .nth(1)
        .unwrap()
        .split("fn timestamp(")
        .next()
        .unwrap();
    for forbidden in [
        "resolve_printer_target(",
        "list_system_printers(",
        "available_ports(",
        "TcpStream",
        ".execute(",
        ".execute_batch(",
    ] {
        assert!(!printer.contains(forbidden), "printer: {forbidden}");
    }
    let updater = include_str!("../../../commands/updates.rs")
        .split("pub(crate) fn support_installed_state(")
        .nth(1)
        .unwrap()
        .split("fn parse_update_channel_payload(")
        .next()
        .unwrap();
    for forbidden in [
        "update_check(",
        "update_get_state(",
        "reconcile_",
        "remove_artifact(",
        "write_update_state(",
        ".updater(",
    ] {
        assert!(!updater.contains(forbidden), "updater: {forbidden}");
    }
}

#[test]
fn checkout_generation_change_during_collection_returns_unknown() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let _keys = crate::tests::fake_keyring::install_empty();
    crate::tests::fake_keyring::before_each_read(|key| panic!("unexpected keyring read: {key}"));
    let fixture = crate::tests::harness::TestDb::open();
    let conn = fixture.state.conn.lock().unwrap();
    for (key, value) in [
        ("organization_id", "your_org"),
        ("branch_id", "your_branch"),
        ("terminal_id", "22222222-2222-4222-8222-222222222222"),
    ] {
        crate::db::set_setting(&conn, "terminal", key, value).unwrap();
    }
    conn.execute_batch("CREATE TABLE checkout_drafts_v1(organization_id TEXT,branch_id TEXT,terminal_id TEXT,generation INTEGER,draft_json TEXT,updated_at TEXT)").unwrap();
    conn.execute("INSERT INTO checkout_drafts_v1 VALUES('your_org','your_branch','22222222-2222-4222-8222-222222222222',1,'{}',?1)",[chrono::Utc::now().to_rfc3339()]).unwrap();
    let writer = Connection::open(fixture.db_path()).unwrap();
    let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = reads.clone();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        if matches!(
            ctx.action,
            AuthAction::Read {
                table_name: "checkout_drafts_v1",
                column_name: "generation"
            }
        ) && observed.fetch_add(1, Ordering::AcqRel) == 1
        {
            writer
                .execute("UPDATE checkout_drafts_v1 SET generation=generation+1", [])
                .unwrap();
        }
        Authorization::Allow
    }));
    let value = checkout(&conn, &fixture.state);
    assert!(reads.load(Ordering::Acquire) >= 2);
    assert_eq!(value["complete"], false);
    assert_eq!(value["details"][0]["phase"], "unknown");
    assert_ne!(value["details"][0]["state"], "not_found");
}

#[test]
fn unavailable_details_emit_closed_reasons() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let conn = Connection::open_in_memory().unwrap();
    identity(&conn);
    let db = business();
    let current = updater(&conn, UpdaterView::CurrentOffer);
    assert_eq!(
        current["details"][0]["unavailable_reason"],
        "no_pure_offer_check"
    );
    let value = checkout(&conn, &db);
    assert_eq!(
        value["details"][0]["unavailable_reason"],
        "owner_table_missing"
    );
    let value = sync(
        &conn,
        &super::super::contract::ExplainSync {
            view: super::super::contract::SyncView::Capacity,
            limit: 20,
        },
    )
    .unwrap();
    assert!(value["details"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["unavailable_reason"] == "owner_table_missing"));
}

#[test]
fn unavailable_present_owner_table_is_read_failed() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let conn = Connection::open_in_memory().unwrap();
    identity(&conn);
    conn.execute_batch("CREATE TABLE checkout_drafts_v1(invalid TEXT)")
        .unwrap();
    assert_eq!(
        checkout(&conn, &business())["details"][0]["unavailable_reason"],
        "read_failed"
    );
}
