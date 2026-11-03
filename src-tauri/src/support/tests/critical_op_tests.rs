use crate::support::critical_op::{CriticalKind, CriticalOpGate};
use std::{
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

#[test]
fn every_kind_defers_support_and_releases_on_error_or_unwind() {
    for kind in [
        CriticalKind::Checkout,
        CriticalKind::Card,
        CriticalKind::Fiscal,
        CriticalKind::ZClose,
        CriticalKind::ShiftClose,
        CriticalKind::Restore,
        CriticalKind::Migration,
    ] {
        let gate = CriticalOpGate::new();
        let token = gate.begin_critical(kind);
        assert!(gate.active(), "{kind:?}");
        assert!(gate.try_begin_support(false, None).is_err());
        drop(token);
        assert!(!gate.active());
        assert!(gate.try_begin_support(false, None).is_ok());
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _token = gate.begin_critical(kind);
            panic!("test unwind");
        }));
        assert!(!gate.active());
    }
}

#[test]
fn nested_hooks_and_atomic_writer_admission() {
    let gate = CriticalOpGate::new();
    let a = gate.begin_critical(CriticalKind::Checkout);
    let b = gate.begin_critical(CriticalKind::Checkout);
    drop(a);
    assert!(gate.active());
    drop(b);
    let read = gate.try_begin_support(false, None).unwrap();
    assert!(gate.try_begin_support(true, None).is_err());
    drop(read);
    let write = gate.try_begin_support(true, None).unwrap();
    assert!(gate.try_begin_support(false, None).is_err());
    assert!(gate.try_begin_support(true, None).is_err());
    let checkout = gate.begin_critical(CriticalKind::Checkout);
    assert!(write.is_cancelled());
    drop(write);
    drop(checkout);
    assert!(CriticalOpGate::new().try_begin_support(true, None).is_ok());
}

#[test]
fn read_replica_scan_and_snapshot_cancellation_never_waits_for_the_worker() {
    let gate = CriticalOpGate::new();
    let reads: Vec<_> = (0..4)
        .map(|_| gate.try_begin_support(false, None).unwrap())
        .collect();
    let at = Instant::now();
    let token = gate.begin_critical(CriticalKind::Checkout);
    assert!(at.elapsed() < Duration::from_millis(50));
    assert!(reads.iter().all(|r| r.is_cancelled()));
    drop(token);
}

#[test]
fn critical_open_interrupts_executor_sqlite_transaction_within_250ms() {
    let gate = CriticalOpGate::new();
    let root = std::env::temp_dir().join(format!("support-preempt-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let conn = rusqlite::Connection::open(root.join("business.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE test(value INTEGER); BEGIN IMMEDIATE; INSERT INTO test VALUES (1);",
    )
    .unwrap();
    let checkout = rusqlite::Connection::open(root.join("business.db")).unwrap();
    checkout.busy_timeout(Duration::from_millis(250)).unwrap();
    let interrupt = Arc::new(conn.get_interrupt_handle());
    let permit = gate.try_begin_support(true, Some(interrupt)).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        conn.progress_handler(
            100,
            Some(move || {
                let _ = started_tx.send(());
                Instant::now() >= deadline
            }),
        );
        let result=conn.query_row("WITH RECURSIVE cnt(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM cnt WHERE x<1000000000) SELECT sum(x) FROM cnt",[],|r|r.get::<_,i64>(0));
        assert!(result.is_err());
        conn.execute_batch("ROLLBACK").unwrap();
        drop(permit);
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let at = Instant::now();
    let _checkout = gate.begin_critical(CriticalKind::Checkout);
    let hook_time = at.elapsed();
    checkout.execute_batch("BEGIN IMMEDIATE").unwrap();
    let lock_time = at.elapsed();
    checkout.execute("INSERT INTO test VALUES (2)", []).unwrap();
    checkout.execute_batch("COMMIT").unwrap();
    worker.join().unwrap();
    eprintln!("preemption hook={hook_time:?}, checkout write-lock={lock_time:?}, including checkout commit={:?}",at.elapsed());
    // The support rollback bound excludes the checkout's own durable commit.
    assert!(
        lock_time < Duration::from_millis(250),
        "support held the checkout lock for {lock_time:?}"
    );
    assert_eq!(
        checkout
            .query_row("SELECT sum(value) FROM test", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(checkout);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn business_hooks_precede_work_and_cover_every_assigned_path() {
    let files = &[
        (
            include_str!("../../commands/orders.rs"),
            &["order_create_with_initial_payment"][..],
        ),
        (
            include_str!("../../commands/analytics.rs"),
            &["report_submit_z_report"][..],
        ),
        (
            include_str!("../../commands/payments.rs"),
            &[
                "payment_record",
                "payment_save_unsaved",
                "payment_void",
                "refund_payment",
                "refund_void_payment",
            ][..],
        ),
        (
            include_str!("../../commands/ecr.rs"),
            &[
                "ecr_process_payment",
                "ecr_process_refund",
                "ecr_void_transaction",
                "ecr_cancel_transaction",
                "ecr_settlement",
                "ecr_fiscal_print",
            ][..],
        ),
        (
            include_str!("../../commands/zreports.rs"),
            &["zreport_generate"][..],
        ),
        (
            include_str!("../../commands/shifts.rs"),
            &["shift_close"][..],
        ),
        (
            include_str!("../../fiscal/dispatcher.rs"),
            &["submit_for_order"][..],
        ),
        (
            include_str!("../../db.rs"),
            &["run_migrations_with_preflight"][..],
        ),
        (
            include_str!("../../recovery.rs"),
            &[
                "maybe_apply_pending_restore_with_hooks",
                "stage_restore_from_point",
            ][..],
        ),
    ];
    for (source, names) in files {
        let file = syn::parse_file(source).unwrap();
        for name in *names {
            let function = file
                .items
                .iter()
                .find_map(|item| match item {
                    syn::Item::Fn(f) if f.sig.ident == *name => Some(f),
                    _ => None,
                })
                .unwrap();
            let Some(syn::Stmt::Local(local)) = function.block.stmts.first() else {
                panic!("{name} must open its RAII guard before work");
            };
            let syn::Pat::Ident(pattern) = &local.pat else {
                panic!("{name}");
            };
            assert_eq!(pattern.ident, "_support_critical");
        }
    }
}

#[test]
fn sale_completes_while_the_overrunning_support_write_is_cancelled() {
    let gate = CriticalOpGate::new();
    let root = std::env::temp_dir().join(format!("support-sale-deadline-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("business.db");
    let support = rusqlite::Connection::open(&path).unwrap();
    support
        .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE sales(id INTEGER);")
        .unwrap();
    let permit = gate
        .try_begin_support_write(Arc::new(support.get_interrupt_handle()))
        .unwrap();
    let (check_tx, check_rx) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        let tx = permit.begin_write(&support).unwrap();
        tx.execute("INSERT INTO sales VALUES(1)", []).unwrap();
        check_tx.send(()).unwrap();
        // Deliberately exceeds any legitimate support write. Pre-emption must
        // cancel this operation, preserving checkout's opportunity to commit.
        assert!(tx.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",[],|r|r.get::<_,i64>(0)).is_err());
        drop(tx);
        assert!(permit.is_cancelled());
    });
    check_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let at = Instant::now();
    let _sale = gate.begin_critical(CriticalKind::Checkout);
    let sale = rusqlite::Connection::open(&path).unwrap();
    sale.busy_timeout(Duration::from_secs(2)).unwrap();
    let tx = crate::db::immediate_transaction(&sale).unwrap();
    tx.execute("INSERT INTO sales VALUES(2)", []).unwrap();
    tx.commit().unwrap();
    writer.join().unwrap();
    assert!(at.elapsed() < Duration::from_secs(2));
    assert_eq!(
        sale.query_row("SELECT sum(id) FROM sales", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(sale);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn read_permit_cannot_open_support_write() {
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    assert_eq!(permit.begin_write(&conn).unwrap_err(), "TIER_NOT_ALLOWED");
}
#[test]
fn idle_critical_gate_never_refuses_sales() {
    let gate = CriticalOpGate::new();
    let _support = gate.try_begin_support(true, None).unwrap();
    let at = Instant::now();
    let sale = gate.begin_critical(CriticalKind::Checkout);
    assert!(at.elapsed() < Duration::from_millis(50));
    drop(sale);
}

#[test]
fn startup_reconciles_interrupted_executor_and_commit_markers_without_reviving_a_hook() {
    use crate::support::{contracts::Command, db::SupportDb, session::Core};
    use serde_json::json;
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = crate::support::critical_op::install_test_gate();
    let dir = crate::tests::harness::TempDir::new();
    let live = rusqlite::Connection::open(dir.path().join("pos.db")).unwrap();
    live.execute_batch(
        "CREATE TABLE support_txn_marker(command_id TEXT PRIMARY KEY,committed_at TEXT NOT NULL);",
    )
    .unwrap();
    let db = SupportDb::open(dir.path()).unwrap();
    let session = super::delivery_tests::command().session_id;
    db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES(?1,'active',3,'2030-01-01T00:00:00Z','2030-01-01T00:00:00Z','now')", [&session]).unwrap();
    // Both generic execution and the marker-bearing guarded write survive in
    // support.db. A committed marker is evidence, never permission to replay.
    for (index, kind, committed) in [
        (1, "till_health", false),
        (2, "breakglass_propose_sql", false),
        (3, "breakglass_propose_sql", true),
    ] {
        let mut command: Command = super::delivery_tests::command();
        command.command_id = format!("your_interrupted_{index}");
        command.idempotency_key = format!("your_interrupted_key_{index}");
        command.sequence = index;
        command.kind = kind.into();
        command.tier = if index == 1 { 1 } else { 3 };
        command.payload = if index == 1 {
            json!({})
        } else {
            json!({"step":"execute","sql":"UPDATE your_fixture SET value=1"})
        };
        db.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,accepted_at,started_at,idempotency_key,state,envelope_json) VALUES(?1,?2,?3,?4,?5,?6,?6,?7,'executing',?8)", rusqlite::params![command.command_id,session,index,kind,command.payload_sha256,command.server_time,command.idempotency_key,serde_json::to_string(&command).unwrap()]).unwrap();
        if committed {
            live.execute(
                "INSERT INTO support_txn_marker VALUES(?1,'now')",
                [&command.command_id],
            )
            .unwrap();
        }
    }
    drop(db);
    // A process-local forgotten token cannot be rehydrated from either file.
    // Keep it on an old, isolated gate instead of leaking the process gate.
    let old_gate = CriticalOpGate::new();
    let old_hook = old_gate.begin_critical(CriticalKind::Checkout);
    let old_worker = old_gate.try_begin_support(false, None);
    assert!(old_worker.is_err());
    let fresh_gate = crate::support::critical_op::global();
    assert!(!fresh_gate.active());
    assert!(fresh_gate.support_idle());
    let restarted = Core::new(SupportDb::open(dir.path()).unwrap()).unwrap();
    assert!(restarted.session.is_none());
    assert!(restarted.executor.queued().unwrap().is_empty());
    assert_eq!(restarted.executor.db.conn.query_row("SELECT count(*) FROM support_accepted_commands WHERE finished_at IS NULL OR state='executing'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(
        restarted
            .executor
            .db
            .conn
            .query_row("SELECT status FROM support_session_state", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "ended"
    );
    let results = restarted
        .executor
        .pending_results(chrono::Utc::now().timestamp_millis())
        .unwrap();
    assert_eq!(results.len(), 3);
    for result in results {
        match result["command_id"].as_str().unwrap() {
            "your_interrupted_1" => assert_eq!(result["error_code"], "OUTCOME_UNKNOWN"),
            "your_interrupted_2" => assert_eq!(result["outcome"], "rolled_back"),
            "your_interrupted_3" => assert_eq!(result["outcome"], "succeeded"),
            _ => panic!("unexpected recovery result"),
        }
    }
    assert!(fresh_gate.try_begin_support(true, None).is_ok());
    let sale = fresh_gate.begin_critical(CriticalKind::Checkout);
    assert!(
        fresh_gate.try_begin_support(false, None).is_err(),
        "fresh commands remain guarded"
    );
    drop(sale);
    drop(old_hook);
    drop(restarted);
    let again = Core::new(SupportDb::open(dir.path()).unwrap()).unwrap();
    assert!(
        again.executor.queued().unwrap().is_empty(),
        "recovery is idempotent and never replays the write"
    );
    assert_eq!(
        live.query_row("SELECT count(*) FROM support_txn_marker", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn scripted_checkout_adds_no_support_work_or_support_held_lock_waits() {
    super::availability_tests::checkout_under_held_support();
}

#[test]
fn payment_signals_and_critical_hooks_have_no_persisted_restart_authority() {
    // PaymentSignals and the gate contain only process-local RAII tokens. The
    // native module's private payment_signal_tests exercise clearing, stale
    // generations and window cleanup. Pin absence of a persistence dependency
    // so new durable hook state requires a new startup reconciliation test.
    let source = include_str!("../critical_op.rs");
    let file = syn::parse_file(source).unwrap();
    for item in file.items {
        if let syn::Item::Struct(item) = item {
            if item.ident == "PaymentSignals" || item.ident == "State" {
                for field in item.fields {
                    let syn::Type::Path(path) = field.ty else {
                        panic!("unexpected persisted hook state");
                    };
                    let name = path.path.segments.last().unwrap().ident.to_string();
                    assert!(
                        ["BTreeMap", "BTreeSet", "VecDeque", "Option", "u64", "bool"]
                            .contains(&name.as_str()),
                        "new hook state {name} requires restart coverage"
                    );
                }
            }
        }
    }
    assert!(!source.contains("SupportDb"));
    assert!(!source.contains("crate::storage"));
    assert!(!source.contains("std::fs::"));
}

#[test]
fn process_cancel_runs_before_critical_start_returns_for_both_entry_points() {
    let _test_gate = crate::support::critical_op::install_test_gate();
    for try_start in [false, true] {
        let gate = crate::support::critical_op::global();
        let (tx, rx) = mpsc::channel();
        let registrations: Vec<_> = (0..3)
            .map(|_| {
                let tx = tx.clone();
                gate.register_process_cancel(move || {
                    tx.send(()).unwrap();
                })
                .unwrap()
            })
            .collect();
        let critical = if try_start {
            gate.try_begin_critical(CriticalKind::Checkout).unwrap()
        } else {
            gate.begin_critical(CriticalKind::Checkout)
        };
        // The callback signals termination synchronously; it must not wait for
        // process exit. All handles fire before either admission API returns.
        for registration in registrations {
            rx.try_recv().unwrap();
            assert!(registration.is_cancelled());
        }
        drop(critical);
    }
}

#[test]
fn process_registration_refuses_active_critical_or_restore() {
    let _test_gate = crate::support::critical_op::install_test_gate();
    let gate = crate::support::critical_op::global();
    let critical = gate.begin_critical(CriticalKind::Checkout);
    assert!(gate
        .register_process_cancel(|| panic!("refused registration must not run"))
        .is_err());
    drop(critical);
    let restore = gate.begin_exclusive_restore().unwrap();
    assert!(gate
        .register_process_cancel(|| panic!("refused registration must not run"))
        .is_err());
    drop(restore);
}

#[test]
fn racing_process_registration_is_either_refused_or_cancellable_before_resume() {
    let _test_gate = crate::support::critical_op::install_test_gate();
    for _ in 0..64 {
        let gate = crate::support::critical_op::global();
        let (start_tx, start_rx) = mpsc::channel();
        let (end_tx, end_rx) = mpsc::channel();
        let (kill_tx, kill_rx) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            start_tx.send(()).unwrap();
            let critical = worker_gate.begin_critical(CriticalKind::Checkout);
            end_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            critical
        });
        start_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let registration = gate.register_process_cancel(move || {
            kill_tx.send(()).unwrap();
        });
        end_tx.send(()).unwrap();
        let critical = worker.join().unwrap();
        if let Ok(registration) = registration {
            assert!(
                registration.is_cancelled(),
                "a racing start must veto resume"
            );
            kill_rx.try_recv().unwrap();
        }
        drop(critical);
    }
}

#[test]
fn process_cancel_and_handle_destruction_never_hold_the_gate_mutex() {
    let _test_gate = crate::support::critical_op::install_test_gate();
    let gate = crate::support::critical_op::global();
    let callback_gate = gate.clone();
    let registration = gate
        .register_process_cancel(move || {
            let (tx, rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                tx.send(callback_gate.active()).unwrap();
            });
            assert!(rx.recv_timeout(Duration::from_millis(250)).unwrap());
            worker.join().unwrap();
        })
        .unwrap();
    let critical = gate.begin_critical(CriticalKind::Checkout);
    drop(registration);
    drop(critical);

    struct LockOnDrop(Arc<CriticalOpGate>);
    impl Drop for LockOnDrop {
        fn drop(&mut self) {
            let gate = self.0.clone();
            let (tx, rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                tx.send(gate.active()).unwrap();
            });
            assert!(!rx.recv_timeout(Duration::from_millis(250)).unwrap());
            worker.join().unwrap();
        }
    }
    let capture = LockOnDrop(gate.clone());
    let registration = gate
        .register_process_cancel(move || {
            drop(capture);
        })
        .unwrap();
    drop(registration); // Captured handle destructors must also run unlocked.
}

#[test]
fn deregistered_process_is_not_cancelled_and_explicit_cancel_is_sticky() {
    let _test_gate = crate::support::critical_op::install_test_gate();
    let gate = crate::support::critical_op::global();
    let (tx, rx) = mpsc::channel();
    let registration = gate
        .register_process_cancel(move || {
            tx.send(()).unwrap();
        })
        .unwrap();
    assert!(!gate.support_idle());
    drop(registration);
    assert!(gate.support_idle());
    let critical = gate.begin_critical(CriticalKind::Checkout);
    assert!(rx.try_recv().is_err());
    drop(critical);
    let (tx, rx) = mpsc::channel();
    let registration = gate
        .register_process_cancel(move || {
            tx.send(()).unwrap();
        })
        .unwrap();
    gate.cancel_support();
    rx.try_recv().unwrap();
    assert!(registration.is_cancelled());
    gate.cancel_support();
    assert!(rx.try_recv().is_err());
}
