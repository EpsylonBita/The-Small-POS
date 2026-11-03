use super::*;
use crate::print_dispatch::{create_attempt, DispatchState, NewAttempt, PrinterTargetKey};
use crate::support::critical_op::{self, CriticalKind};

fn failed_job(db: &DbState, kind: &str) -> (String, Uuid) {
    failed_job_on(
        db,
        kind,
        PrinterTargetKey::RawTcp {
            host: "your-printer.local".into(),
            port: 9100,
        },
    )
}
fn failed_job_on(db: &DbState, kind: &str, target: PrinterTargetKey) -> (String, Uuid) {
    let conn = db.conn.lock().unwrap();
    let job = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO print_jobs(id,entity_type,entity_id,printer_profile_id,status,created_at,updated_at) VALUES(?1,?2,?1,'your-profile','failed',datetime('now'),datetime('now'))",params![job,kind]).unwrap();
    let attempt = create_attempt(
        &conn,
        NewAttempt {
            local_job_id: job.clone(),
            target,
            document_kind: "receipt".into(),
            bytes_requested: 10,
            now: Utc::now(),
        },
    )
    .unwrap();
    conn.execute(
        "UPDATE print_job_attempts SET state='unknown' WHERE id=?1",
        [attempt.attempt_id.to_string()],
    )
    .unwrap();
    (job, attempt.attempt_id)
}
#[test]
#[serial_test::serial]
fn support_pause_records_previous_state_and_later_operator_pause_survives() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    let db = crate::tests::harness::TestDb::open();
    failed_job(&db.state, "order_receipt");
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-action",
        true,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(result["paused"], true);
    let conn = db.state.conn.lock().unwrap();
    conn.execute("UPDATE print_job_attempts SET state='cancelled'", [])
        .unwrap();
    write_print_queue_pause(&conn, Some("your-profile"), true).unwrap();
    drop(conn);
    assert!(support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-action",
        false,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(())
    )
    .is_err());
    assert!(is_print_queue_paused_with_conn(
        &db.state.conn.lock().unwrap(),
        Some("your-profile")
    ));
}
#[test]
#[serial_test::serial]
fn support_preview_refuses_protected_kinds_and_new_sender_after_preview() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    for kind in ["z_report", "shift_checkout", "label", "your-unknown"] {
        let db = crate::tests::harness::TestDb::open();
        failed_job(&db.state, kind);
        let permit = critical_op::global().try_begin_support(true, None).unwrap();
        assert!(support_preview_uncertain(
            &db.state,
            "your-profile",
            &permit,
            Instant::now() + Duration::from_secs(5)
        )
        .is_err());
    }
    let db = crate::tests::harness::TestDb::open();
    let (job, _) = failed_job(&db.state, "order_receipt");
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let preview = support_preview_uncertain(&db.state, "your-profile", &permit, deadline).unwrap();
    let active = ActivePrintGuard::register(&db.state, &job, Some("your-profile".into())).unwrap();
    assert!(support_cancel_uncertain(
        &db.state,
        "your-profile",
        &preview,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(()),
        Arc::new(SystemWindowsSpooler)
    )
    .is_err());
    drop(active);
}
#[test]
#[serial_test::serial]
fn support_cancellation_retains_original_and_critical_start_preempts_lock_wait() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    let db = crate::tests::harness::TestDb::open();
    let (job, attempt) = failed_job(&db.state, "order_receipt");
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let preview = support_preview_uncertain(&db.state, "your-profile", &permit, deadline).unwrap();
    let result = support_cancel_uncertain(
        &db.state,
        "your-profile",
        &preview,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(()),
        Arc::new(SystemWindowsSpooler),
    )
    .unwrap();
    assert_eq!(result["state"], "cancel_confirmed");
    let conn = db.state.conn.lock().unwrap();
    assert_eq!(
        crate::print_dispatch::read_attempt(&conn, attempt)
            .unwrap()
            .unwrap()
            .state,
        DispatchState::Cancelled
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM print_jobs WHERE id=?1", [job], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        1
    );
    drop(conn);
    let _lock = profile_association_coordination().lock().unwrap();
    let _critical = critical_op::global().begin_critical(CriticalKind::Checkout);
    assert_eq!(
        support_preview_uncertain(&db.state, "your-profile", &permit, deadline).unwrap_err(),
        "PREEMPTED_BY_CRITICAL_OPERATION"
    );
}

#[test]
#[serial_test::serial]
fn support_pause_closes_dispatch_eligibility_and_reports_existing_sender_separately() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    let db = crate::tests::harness::TestDb::open();
    let (job, _) = failed_job(&db.state, "order_receipt");
    let active = ActivePrintGuard::register(&db.state, &job, Some("your-profile".into())).unwrap();
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let result = support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-action",
        true,
        &permit,
        Instant::now() + Duration::from_secs(5),
        &|| Ok(()),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(result["in_flight"], true);
    assert!(
        !active.cancel_token().load(Ordering::Acquire),
        "pause dispatch does not claim to recall bytes"
    );
    let conn = db.state.conn.lock().unwrap();
    conn.execute("INSERT INTO print_jobs(id,entity_type,entity_id,printer_profile_id,status,created_at,updated_at) VALUES('your-pending','order_receipt','your-order','your-profile','pending',datetime('now'),datetime('now'))",[]).unwrap();
    let selected = select_ready_pending_jobs(
        &conn,
        &Utc::now().to_rfc3339(),
        &paused_printer_profiles(&conn),
        10,
    )
    .unwrap();
    assert!(
        selected.is_empty(),
        "a dispatcher selecting after pause must not claim the profile"
    );
}
#[test]
#[serial_test::serial]
fn support_cancel_refuses_reused_spool_identity_without_deleting_foreign_output() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    let db = crate::tests::harness::TestDb::open();
    let (job, attempt) = failed_job(&db.state, "order_receipt");
    {
        let conn = db.state.conn.lock().unwrap();
        conn.execute("UPDATE print_job_attempts SET transport='windows',resolved_target='Your queue',spool_job_id=73 WHERE id=?1",[attempt.to_string()]).unwrap();
    }
    let spooler = Arc::new(crate::windows_spooler::FakeWindowsSpooler::new(73));
    spooler.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
        job_id: 73,
        printer_name: "Your queue".into(),
        document_name: crate::windows_spooler::format_document_marker(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "receipt",
        )
        .unwrap(),
        status_text: None,
        status_bits: 0,
        position: 1,
        total_pages: 1,
        pages_printed: 0,
    });
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let preview = support_preview_uncertain(&db.state, "your-profile", &permit, deadline).unwrap();
    let result = support_cancel_uncertain(
        &db.state,
        "your-profile",
        &preview,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(()),
        spooler.clone(),
    )
    .unwrap();
    assert_eq!(result["state"], "unknown");
    assert!(spooler.controls().is_empty());
    assert_eq!(
        db.state
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM print_jobs WHERE id=?1", [job], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}
#[test]
#[serial_test::serial]
fn support_changed_attempt_refuses_and_pre_effect_critical_rolls_back_pause() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    let (_, attempt) = failed_job(&db.state, "order_receipt");
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let preview = support_preview_uncertain(&db.state, "your-profile", &permit, deadline).unwrap();
    db.state
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE print_job_attempts SET bytes_written=5 WHERE id=?1",
            [attempt.to_string()],
        )
        .unwrap();
    assert_eq!(
        support_cancel_uncertain(
            &db.state,
            "your-profile",
            &preview,
            &permit,
            deadline,
            &|| Ok(()),
            &|| Ok(()),
            Arc::new(SystemWindowsSpooler)
        )
        .unwrap_err(),
        "PAYLOAD_DRIFT"
    );
    let preempt = || {
        let _critical = critical_op::global().begin_critical(CriticalKind::Checkout);
        Ok(())
    };
    assert!(support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-action",
        true,
        &permit,
        deadline,
        &|| Ok(()),
        &preempt
    )
    .is_err());
    assert!(!is_print_queue_paused_with_conn(
        &db.state.conn.lock().unwrap(),
        Some("your-profile")
    ));
}

#[test]
#[serial_test::serial]
fn support_resume_is_session_owned_requires_no_uncertain_attempt_and_never_runs_automatically() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    failed_job(&db.state, "order_receipt");
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-pause",
        true,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(()),
    )
    .unwrap();
    assert!(support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-resume",
        false,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(())
    )
    .is_err());
    db.state
        .conn
        .lock()
        .unwrap()
        .execute("UPDATE print_job_attempts SET state='cancelled'", [])
        .unwrap();
    assert!(support_set_profile_pause(
        &db.state,
        "your-profile",
        "other-session",
        "your-resume",
        false,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(())
    )
    .is_err());
    let reopened = Connection::open(db.db_path()).unwrap();
    assert!(is_print_queue_paused_with_conn(
        &reopened,
        Some("your-profile")
    ));
    drop(reopened);
    let resumed = support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-resume",
        false,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(resumed["paused"], false);
    assert_eq!(resumed["status"], "available");
}
#[test]
#[serial_test::serial]
fn support_pause_requires_fresh_failure_and_expired_deadline_has_no_effect() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    failed_job(&db.state, "order_receipt");
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    db.state
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE print_jobs SET updated_at=datetime('now','-6 minutes')",
            [],
        )
        .unwrap();
    assert!(support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-pause",
        true,
        &permit,
        Instant::now() + Duration::from_secs(5),
        &|| Ok(()),
        &|| Ok(())
    )
    .is_err());
    assert!(support_set_profile_pause(
        &db.state,
        "your-profile",
        "your-session",
        "your-pause",
        true,
        &permit,
        Instant::now(),
        &|| Ok(()),
        &|| Ok(())
    )
    .is_err());
    assert!(!is_print_queue_paused_with_conn(
        &db.state.conn.lock().unwrap(),
        Some("your-profile")
    ));
}

struct ControlledSpooler {
    fake: crate::windows_spooler::FakeWindowsSpooler,
    deleted: AtomicBool,
    remove: bool,
    fail: bool,
    native_wait: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}
impl crate::windows_spooler::WindowsSpooler for ControlledSpooler {
    fn submit_raw(
        &self,
        _: crate::windows_spooler::WindowsRawRequest,
        _: &AtomicBool,
        _: &mut dyn FnMut(
            &crate::windows_spooler::SpoolStarted,
        ) -> Result<(), crate::windows_spooler::SpoolerError>,
    ) -> Result<crate::windows_spooler::SpoolSubmission, crate::windows_spooler::SpoolerError> {
        panic!("cancellation must never submit")
    }
    fn enum_jobs(
        &self,
        _: &str,
    ) -> Result<Vec<crate::windows_spooler::SpoolJobSnapshot>, crate::windows_spooler::SpoolerError>
    {
        panic!("cancellation must never enumerate")
    }
    fn get_job(
        &self,
        printer: &str,
        job: u32,
    ) -> Result<
        Option<crate::windows_spooler::SpoolJobSnapshot>,
        crate::windows_spooler::SpoolerError,
    > {
        if let Some(notify) = self.native_wait.lock().unwrap().take() {
            notify.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        if self.deleted.load(Ordering::Acquire) {
            return Ok(None);
        }
        self.fake.get_job(printer, job)
    }
    fn control_job(
        &self,
        printer: &str,
        job: u32,
        control: crate::windows_spooler::SpoolJobControl,
    ) -> Result<(), crate::windows_spooler::SpoolerError> {
        if self.fail {
            return Err(crate::windows_spooler::SpoolerError::Cancelled);
        }
        self.fake.control_job(printer, job, control)?;
        if self.remove {
            self.deleted.store(true, Ordering::Release);
        }
        Ok(())
    }
}
fn controlled_windows(
    db: &DbState,
    remove: bool,
    fail: bool,
    notify: Option<std::sync::mpsc::Sender<()>>,
) -> Arc<ControlledSpooler> {
    let (_, attempt) = failed_job_on(
        db,
        "order_receipt",
        PrinterTargetKey::WindowsQueue("Your support queue".into()),
    );
    let conn = db.conn.lock().unwrap();
    conn.execute("UPDATE print_job_attempts SET transport='windows',resolved_target='Your support queue',spool_job_id=73 WHERE id=?1",[attempt.to_string()]).unwrap();
    let marker = crate::print_dispatch::read_attempt(&conn, attempt)
        .unwrap()
        .unwrap()
        .document_name;
    let fake = crate::windows_spooler::FakeWindowsSpooler::new(73);
    fake.seed_snapshot(crate::windows_spooler::SpoolJobSnapshot {
        job_id: 73,
        printer_name: "Your support queue".into(),
        document_name: marker,
        status_text: None,
        status_bits: 0,
        position: 1,
        total_pages: 1,
        pages_printed: 0,
    });
    Arc::new(ControlledSpooler {
        fake,
        deleted: AtomicBool::new(false),
        remove,
        fail,
        native_wait: Mutex::new(notify),
    })
}
#[test]
#[serial_test::serial]
fn support_windows_cancel_reports_fresh_pending_or_failed_without_promoting_native_absence() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    for (remove, fail, expected) in [
        (false, false, "cancel_requested"),
        (false, true, "cancel_failed"),
        (true, false, "cancel_requested"),
    ] {
        let db = crate::tests::harness::TestDb::open();
        let spooler = controlled_windows(&db.state, remove, fail, None);
        let permit = critical_op::global().try_begin_support(true, None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let preview =
            support_preview_uncertain(&db.state, "your-profile", &permit, deadline).unwrap();
        let result = support_cancel_uncertain(
            &db.state,
            "your-profile",
            &preview,
            &permit,
            deadline,
            &|| Ok(()),
            &|| Ok(()),
            spooler,
        )
        .unwrap_or_else(|error| panic!("remove={remove}, fail={fail}: {error}"));
        assert_eq!(result["state"], expected);
        assert_eq!(result["physical_output"], "unknown");
    }
}
#[test]
#[serial_test::serial]
fn critical_start_during_native_identity_wait_prevents_late_delete_and_holds_no_business_mutex() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    let (tx, rx) = std::sync::mpsc::channel();
    let spooler = controlled_windows(&db.state, false, false, Some(tx));
    let gate = critical_op::global();
    let critical = std::thread::spawn(move || {
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let _critical = gate.begin_critical(CriticalKind::Checkout);
    });
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let preview = support_preview_uncertain(&db.state, "your-profile", &permit, deadline).unwrap();
    assert_eq!(
        support_cancel_uncertain(
            &db.state,
            "your-profile",
            &preview,
            &permit,
            deadline,
            &|| Ok(()),
            &|| Ok(()),
            spooler.clone()
        )
        .unwrap_err(),
        "PREEMPTED_BY_CRITICAL_OPERATION"
    );
    assert!(db.state.conn.try_lock().is_ok());
    critical.join().unwrap();
    std::thread::sleep(Duration::from_millis(125));
    assert!(spooler.fake.controls().is_empty());
}

#[test]
#[serial_test::serial]
fn support_connection_keeps_business_timeout_and_does_not_wait_for_its_mutex() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    let db = crate::tests::harness::TestDb::open();
    failed_job(&db.state, "order_receipt");
    let private = support_printer_connection(db.db_path()).unwrap();
    let conn = db.state.conn.lock().unwrap();
    let before: i64 = conn
        .pragma_query_value(None, "busy_timeout", |r| r.get(0))
        .unwrap();
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    support_preview_uncertain(&private, "your-profile", &permit, deadline).unwrap();
    support_set_profile_pause(
        &private,
        "your-profile",
        "your-session",
        "your-action",
        true,
        &permit,
        deadline,
        &|| Ok(()),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "busy_timeout", |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert!(is_print_queue_paused_with_conn(&conn, Some("your-profile")));
}
