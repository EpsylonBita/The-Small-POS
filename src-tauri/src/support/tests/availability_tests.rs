//! Availability checks use injected failures and local durable APIs only.
use crate::support::{
    critical_op,
    transport::{harness, ApiFuture, SupportApi},
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

pub(super) fn business_fixture() -> crate::tests::harness::TestDb {
    let fixture = crate::tests::harness::TestDb::open();
    {
        let conn = fixture.state.conn.lock().unwrap();
        conn.busy_timeout(Duration::ZERO).unwrap();
        for (category, key, value) in [
            ("terminal", "__ignore_keyring", "1"),
            ("terminal", "terminal_id", "your_terminal"),
            ("terminal", "branch_id", "your_branch"),
            ("restaurant", "store_currency_branch_id", "your_branch"),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
            ("restaurant", "currency", "EUR"),
        ] {
            crate::db::set_setting(&conn, category, key, value).unwrap();
        }
        conn.execute("INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,check_in_time,status,currency,created_at,updated_at) VALUES('your_shift','your_cashier','your_branch','your_terminal','cashier','now','active','EUR','now','now')", []).unwrap();
        conn.execute("INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,opening_amount,opening_amount_cents,currency,opened_at,created_at,updated_at) VALUES('your_drawer','your_shift','your_cashier','your_branch','your_terminal',100,10000,'EUR','now','now','now')", []).unwrap();
    }
    fixture
}

/// Real local cash persistence + print enqueue + durable payment replay + Health.
/// No background spooler, sync sender, terminal or fiscal command is started.
pub(super) fn checkout(
    db: &crate::db::DbState,
    id: &str,
    tracker: &crate::database_lock::LockTracker,
) -> Value {
    let _sale = critical_op::global().begin_critical(critical_op::CriticalKind::Checkout);
    {
        let conn = crate::database_lock::lock_with(
            &db.conn,
            "wH1_checkout",
            tracker,
            Duration::ZERO,
            |wait| panic!("checkout waited on {}", wait.holder_label),
        )
        .unwrap();
        conn.execute("INSERT INTO orders(id,order_number,items,total_amount,total_amount_cents,status,order_type,payment_status,sync_status,branch_id,terminal_id,staff_shift_id,staff_id,currency,created_at,updated_at) VALUES(?1,?1,'[]',10,1000,'pending','takeaway','pending','pending','your_branch','your_terminal','your_shift','your_cashier','EUR','2026-11-01T12:00:00Z','2026-11-01T12:00:00Z')", [id]).unwrap();
    }
    assert!(
        db.conn.try_lock().is_ok(),
        "support never owns the live app mutex"
    );
    crate::payments::record_payment(db, &json!({"orderId":id,"method":"cash","amount":10,"idempotencyKey":format!("your_payment_{id}")})).unwrap();
    let print = crate::print::enqueue_print_job(
        db,
        "order_receipt",
        id,
        None,
        &crate::print::NoopPrintQueueInvalidator,
    )
    .unwrap();
    assert_eq!(print["success"], true);
    let health = crate::diagnostics::get_system_health(db).unwrap();
    assert!(
        health["readFailures"]
            .as_array()
            .is_some_and(|v| v.is_empty()),
        "Health must complete its existing local observations: {health}"
    );
    let conn = crate::database_lock::lock_with(
        &db.conn,
        "wH1_checkout_readback",
        tracker,
        Duration::ZERO,
        |wait| panic!("checkout waited on {}", wait.holder_label),
    )
    .unwrap();
    let paid: i64 = conn
        .query_row(
            "SELECT sum(amount_cents) FROM order_payments WHERE order_id=?1 AND status='completed'",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let prints: i64 = conn
        .query_row(
            "SELECT count(*) FROM print_jobs WHERE entity_id=?1 AND status='pending'",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let replay: i64 = conn.query_row("SELECT count(*) FROM parity_sync_queue WHERE table_name='payments' AND status IN ('pending','deferred')", [], |r| r.get(0)).unwrap();
    assert_eq!(paid, 1000);
    assert_eq!(prints, 1);
    assert!(
        replay > 0,
        "payment sync is durable while support is offline"
    );
    json!({"paid":paid,"prints":prints,"sync_queued":replay > 0,"health_schema":health["schemaVersion"],"health_failures":health["readFailures"],"health_sync_status":health["syncBacklogStatus"]})
}

struct FailedApi {
    stalled: bool,
    calls: AtomicUsize,
}
impl SupportApi for FailedApi {
    fn request<'a>(&'a self, _: &'a str, _: &'a str, _: Option<Value>) -> ApiFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.stalled {
            Box::pin(std::future::pending())
        } else {
            Box::pin(async { Err("TILL_OFFLINE".into()) })
        }
    }
    fn visible(&self) -> bool {
        true
    }
}

async fn unavailable(stalled: bool) {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let business = business_fixture();
    let tracker = crate::database_lock::LockTracker::new();
    let baseline = checkout(&business.state, "your_baseline", &tracker);
    let support = super::route_contract_tests::Fixture::new();
    support.active();
    let api = FailedApi {
        stalled,
        calls: AtomicUsize::new(0),
    };
    // Poll until the request has actually started; checkout then runs while the
    // status lane is suspended in its injected never-resolving response.
    let status = harness::status(&api, &support.rt);
    tokio::pin!(status);
    let mut observed = false;
    let completed = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::select! {
            biased;
            () = &mut status => {}
            () = async {
                assert!(stalled);
                assert_eq!(api.calls.load(Ordering::SeqCst), 1);
                assert_eq!(checkout(&business.state, "your_stalled", &tracker), baseline);
                observed = true;
            } => { status.await; }
        }
    })
    .await;
    assert!(completed.is_ok(), "support status deadline is bounded");
    if stalled {
        assert!(observed, "checkout ran before support answered");
    } else {
        assert_eq!(
            checkout(&business.state, "your_refused", &tracker),
            baseline
        );
    }
    assert_eq!(api.calls.load(Ordering::SeqCst), 1);
    let core = support.rt.core.lock().unwrap();
    assert!(!core.session.as_ref().unwrap().admission.online);
    assert!(!critical_op::global().active());
    assert!(critical_op::global().support_idle());
}

#[tokio::test]
async fn support_connection_refused_leaves_checkout_print_sync_and_health_available() {
    unavailable(false).await;
}

#[tokio::test]
async fn support_accepts_then_never_answers_leaves_checkout_print_sync_and_health_available() {
    unavailable(true).await;
}

#[test]
fn unreachable_doorbell_uses_monotonic_polling_without_business_locks() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let business = business_fixture();
    let tracker = crate::database_lock::LockTracker::new();
    let before = checkout(&business.state, "your_doorbell_before", &tracker);
    let mut schedule = crate::support::transport::Schedule::default();
    let start = Instant::now();
    schedule.failure(start);
    assert!(!schedule.doorbell_healthy);
    assert!(schedule.due(true, true, start).commands);
    assert!(!schedule.due(true, true, start).commands);
    assert!(
        schedule
            .due(true, true, start + Duration::from_secs(5))
            .commands
    );
    assert!(schedule.paused(start + Duration::from_secs(20)));
    assert_eq!(
        checkout(&business.state, "your_doorbell_unreachable", &tracker),
        before
    );
    schedule.success();
    assert!(!schedule.paused(start + Duration::from_secs(20)));
    assert!(critical_op::global().support_idle());
}

/// Small CI counterpart to the reference-hardware gate. All support-held
/// mutexes and SQLite read locks remain held until after checkout commits.
/// Completion before release proves independence without a clock assertion.
pub(super) fn checkout_under_held_support() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let business = business_fixture();
    let gate = critical_op::global();
    let tracker = crate::database_lock::LockTracker::new();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let mut threads = vec![];
    let mut releases = vec![];
    let permits: Vec<_> = (0..3)
        .map(|_| gate.try_begin_support(false, None).unwrap())
        .collect();
    let cancelled: Vec<_> = permits.iter().map(|p| p.cancelled.clone()).collect();
    for (index, permit) in permits.into_iter().enumerate() {
        let path = business.db_path().to_owned();
        let ready = ready_tx.clone();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        releases.push(release_tx);
        threads.push(std::thread::spawn(move || {
            if index == 2 {
                held_scan(&permit, ready, release_rx);
                return;
            }
            // Pause actual SQLite work at its first progress callback. A raw
            // VACUUM INTO is the live-file copy phase used by replica::build.
            // The callback stands in for a descheduled worker; checkout must
            // finish even before this worker has a chance to handle cancel.
            let source = crate::support::replica::read_connection(
                &path, &permit, Instant::now() + Duration::from_secs(15),
            ).unwrap();
            let mutex = Mutex::new(source);
            let tracker = crate::database_lock::LockTracker::new();
            let conn = crate::database_lock::lock_with(
                &mutex,
                ["support_read", "support_replica"][index],
                &tracker,
                Duration::ZERO,
                |_| panic!("uncontended support fixture"),
            )
            .unwrap();
            let cancelled = permit.cancelled.clone();
            if index == 0 {
                conn.execute_batch("BEGIN;").unwrap();
                conn.query_row("SELECT count(*) FROM orders", [], |r| r.get::<_, i64>(0)).unwrap();
            }
            let mut announced = false;
            let mut steps = 0;
            conn.progress_handler(1, Some(move || {
                steps += 1;
                if !announced && (index == 0 || steps == 100) {
                    announced = true;
                    ready.send(std::thread::current().id()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(15)).unwrap();
                }
                cancelled.load(Ordering::Acquire)
            }));
            let result = if index == 0 {
                conn.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n", [], |r| r.get::<_, i64>(0)).map(|_| ())
            } else {
                conn.execute("VACUUM INTO ?1", [path.with_file_name("your_raw_replica.db").to_string_lossy().as_ref()]).map(|_| ())
            };
            assert!(result.is_err(), "paused support work must be interrupted");
            assert!(permit.is_cancelled());
            conn.progress_handler(0, None::<fn() -> bool>);
            if !conn.is_autocommit() { conn.execute_batch("ROLLBACK").unwrap(); }
        }));
    }
    for _ in 0..3 {
        assert_ne!(
            ready_rx.recv_timeout(Duration::from_secs(15)).unwrap(),
            std::thread::current().id()
        );
    }
    checkout(&business.state, "your_under_support", &tracker);
    assert!(cancelled.iter().all(|flag| flag.load(Ordering::Acquire)));
    assert!(
        !gate.support_idle(),
        "checkout completed before any support worker returned"
    );
    assert!(!gate.active());
    for release in releases {
        release.send(()).unwrap();
    }
    for worker in threads {
        worker.join().unwrap();
    }
    assert!(gate.support_idle());
}

fn held_scan(
    permit: &critical_op::SupportPermit,
    ready: std::sync::mpsc::Sender<std::thread::ThreadId>,
    release: std::sync::mpsc::Receiver<()>,
) {
    use crate::support::network::{
        info::{Address, Interface},
        scan::{self, Connector, Reply},
        DiscoveryState,
    };
    struct PausedConnector {
        first: std::sync::atomic::AtomicBool,
        ready: std::sync::mpsc::Sender<std::thread::ThreadId>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Connector for PausedConnector {
        fn probe(
            &self,
            _: std::net::Ipv4Addr,
            _: u16,
            _: Instant,
            _: &critical_op::SupportPermit,
        ) -> Reply {
            if !self.first.swap(true, Ordering::AcqRel) {
                self.ready.send(std::thread::current().id()).unwrap();
                self.release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(15))
                    .unwrap();
            }
            Reply::default()
        }
    }
    let connector = PausedConnector {
        first: std::sync::atomic::AtomicBool::new(false),
        ready,
        release: Mutex::new(release),
    };
    let interface = Interface {
        interface_id: "your_interface".into(),
        name: json!({"value":"Ethernet"}),
        kind: "ethernet".into(),
        ipv4: vec![Address {
            address: "192.168.1.1".parse().unwrap(),
            prefix_length: 30,
        }],
        gateway: None,
        dns: vec![],
        is_vpn_or_virtual: false,
        scan_eligible: true,
    };
    let result = scan::sweep(
        &json!({"port_groups":["printers"]}),
        &[interface],
        &mut DiscoveryState::default(),
        permit,
        &connector,
    )
    .unwrap();
    assert_eq!(result["stopped"], "critical_operation");
}

#[test]
fn fast_ci_checkout_has_zero_support_held_lock_waits() {
    checkout_under_held_support();
}

#[test]
fn stalled_support_deadline_is_used_by_the_real_status_lane() {
    // Guard against accidentally moving a network await under the core mutex.
    let source = include_str!("../transport.rs");
    assert!(source.contains(
        "bounded_request(api, \"/api/pos/support/heartbeat\", \"POST\", Some(body)).await?"
    ));
}

#[test]
fn remedy_matcher_uses_only_the_isolated_native_support_input_command() {
    let source = include_str!("../../../../src/renderer/services/support/SupportMatcherBridge.ts");
    assert!(source.contains("support_matcher_inputs"));
    for business_command in [
        "getSystemHealth(",
        "getFailedFinancialItems(",
        "validateFinancialIntegrity(",
        "getSyncQueueBridge(",
    ] {
        assert!(
            !source.contains(business_command),
            "matcher invoked {business_command}"
        );
    }
}

#[test]
fn checkout_during_matcher_evaluation_has_zero_business_mutex_waits() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let business = business_fixture();
    let tracker = crate::database_lock::LockTracker::new();
    let matcher = crate::support::matcher::MatcherRead::open(business.db_path()).unwrap();
    let cancelled = matcher.permit.cancelled.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        {
            let conn = matcher.db.conn.lock().unwrap();
            let cancel = matcher.permit.cancelled.clone();
            let mut announced = false;
            conn.progress_handler(
                1,
                Some(move || {
                    if !announced {
                        announced = true;
                        ready_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(15)).unwrap();
                    }
                    cancel.load(Ordering::Acquire)
                }),
            );
        }
        matcher.collect()
    });
    ready_rx.recv_timeout(Duration::from_secs(15)).unwrap();
    // The evaluation still owns its SQLite handle/mutex when this real checkout
    // commits. checkout() instruments the business lock at a zero threshold.
    checkout(&business.state, "your_during_matcher", &tracker);
    assert!(cancelled.load(Ordering::Acquire));
    assert!(!critical_op::global().support_idle());
    release_tx.send(()).unwrap();
    let inputs = worker.join().unwrap();
    for name in ["systemHealth", "integrity", "financialItems", "parityItems"] {
        assert_eq!(inputs[name]["status"], "unavailable");
    }
    assert!(critical_op::global().support_idle());
}
