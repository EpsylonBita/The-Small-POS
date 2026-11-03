//! Reference Windows till release gate. Compile in CI; never run implicitly.
//! Explicit invocation: cargo test --lib support::tests::latency_guard -- --ignored --nocapture
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[test]
#[ignore = "reference-hardware release gate: creates a temporary 500 MB SQLite fixture"]
fn reference_till_p95_added_checkout_latency_and_500mb_replica() {
    use crate::support::{critical_op, replica};
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = critical_op::install_test_gate();
    let business = super::availability_tests::business_fixture();
    let tracker = crate::database_lock::LockTracker::new();
    // Keep fixture generation out of the timing. This table is private to this
    // disposable benchmark, not a business schema change or committed asset.
    {
        let conn = business.state.conn.lock().unwrap();
        conn.execute_batch("CREATE TABLE support_harness_activity(value INTEGER); INSERT INTO support_harness_activity VALUES(0);").unwrap();
    }
    // ABAB on one fixture (coordinator 02/11): each pair is a checkout with
    // support idle, then a checkout that starts while a support read is in
    // progress and pre-empts it. Adjacent pairs cancel the fixture's growth
    // with table size, and the support worker never spins: it does one read per
    // pair, at most one per 500 ms (the protocol's 120-command-per-minute cap).
    const PAIRS: usize = 200;
    const SUPPORT_SPACING: Duration = Duration::from_millis(500);
    for n in 0..10 {
        super::availability_tests::checkout(&business.state, &format!("your_warmup_{n}"), &tracker);
    }
    let path = business.db_path().to_owned();
    let gate = critical_op::global();
    let preempted = Arc::new(AtomicUsize::new(0));
    let (go_tx, go_rx) = std::sync::mpsc::channel::<bool>();
    let (active_tx, active_rx) = std::sync::mpsc::channel::<()>();
    let (idle_tx, idle_rx) = std::sync::mpsc::channel::<()>();
    let worker_preempted = preempted.clone();
    let worker = std::thread::spawn(move || {
        while let Ok(true) = go_rx.recv() {
            let permit = gate
                .try_begin_support(false, None)
                .expect("support admitted while no checkout runs");
            let read =
                replica::read_connection(&path, &permit, Instant::now() + Duration::from_secs(5))
                    .expect("support read connection");
            let mut announced = false;
            // Keep a read in progress until the checkout pre-empts it.
            while !permit.is_cancelled() {
                let _ = read.query_row("SELECT count(*) FROM orders", [], |r| r.get::<_, i64>(0));
                if !announced {
                    active_tx.send(()).unwrap();
                    announced = true;
                }
            }
            worker_preempted.fetch_add(1, Ordering::Relaxed);
            drop(read);
            drop(permit);
            idle_tx.send(()).unwrap();
        }
    });
    let mut added = Vec::with_capacity(PAIRS);
    let mut last_support = Instant::now() - SUPPORT_SPACING;
    for n in 0..PAIRS {
        let at = Instant::now();
        super::availability_tests::checkout(&business.state, &format!("your_idle_{n}"), &tracker);
        let idle = at.elapsed();
        if let Some(wait) = SUPPORT_SPACING.checked_sub(last_support.elapsed()) {
            std::thread::sleep(wait);
        }
        go_tx.send(true).unwrap();
        active_rx.recv_timeout(Duration::from_secs(15)).unwrap();
        last_support = Instant::now();
        let at = Instant::now();
        super::availability_tests::checkout(&business.state, &format!("your_busy_{n}"), &tracker);
        let busy = at.elapsed();
        idle_rx.recv_timeout(Duration::from_secs(15)).unwrap();
        added.push(busy.saturating_sub(idle));
    }
    go_tx.send(false).unwrap();
    worker.join().unwrap();
    let support_ops = preempted.load(Ordering::Relaxed);
    assert_eq!(
        support_ops, PAIRS,
        "every measured checkout pre-empted a live support read"
    );
    added.sort_unstable();
    let pct = |p: usize| added[(PAIRS * p).div_ceil(100) - 1];
    let p95_added = pct(95);
    eprintln!(
        "reference checkout (ABAB, pre-empting a live support read) added p50={:?} p95={p95_added:?} p99={:?}; support reads pre-empted={support_ops}",
        pct(50),
        pct(99),
    );
    // Runtime-generated payload: no 500 MB fixture is checked into the repo.
    let dir = crate::tests::harness::TempDir::new();
    let path = dir.path().join("pos.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE support_harness_padding(payload BLOB); BEGIN IMMEDIATE;").unwrap();
    for _ in 0..500 {
        conn.execute(
            "INSERT INTO support_harness_padding VALUES(zeroblob(1048576))",
            [],
        )
        .unwrap();
    }
    conn.execute_batch("COMMIT").unwrap();
    drop(conn);
    assert!(std::fs::metadata(&path).unwrap().len() >= 500 * 1024 * 1024);
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .unwrap();
    let at = Instant::now();
    let built = replica::build(&path, &permit);
    let elapsed = at.elapsed();
    match &built {
        Ok(built) => eprintln!(
            "500 MB replica build={elapsed:?}, redacted bytes={}",
            std::fs::metadata(&built.path).unwrap().len()
        ),
        Err(error) => eprintln!("500 MB replica build failed after {elapsed:?}: {error}"),
    }
    // Both measurements are reported before either bound is enforced.
    assert!(p95_added <= Duration::from_millis(50));
    assert!(
        built.is_ok(),
        "500 MB replica must build on reference hardware"
    );
    assert!(elapsed <= Duration::from_secs(30));
}

/// Attribution of the reference gate's added checkout latency, by component.
/// Same 200-checkout sample, each variant against its own fresh baseline:
/// pure CPU contention, the gate permit alone, support reads, the full gate
/// load, and reads paced at the protocol's command cap (120 per minute).
/// Reports only; the release bound stays in the test above.
#[test]
#[ignore = "reference-hardware diagnostic: attribution of the latency gate"]
fn reference_till_latency_attribution_by_component() {
    use crate::support::{critical_op, replica};
    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Load {
        CpuOnly,
        PermitOnly,
        ReadsOnly,
        Full,
        PacedReads,
    }
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = critical_op::install_test_gate();
    let business = super::availability_tests::business_fixture();
    let tracker = crate::database_lock::LockTracker::new();
    {
        let conn = business.state.conn.lock().unwrap();
        conn.execute_batch("CREATE TABLE support_harness_activity(value INTEGER); INSERT INTO support_harness_activity VALUES(0);").unwrap();
    }
    const CHECKOUTS: usize = 200;
    let mut serial = 0usize;
    let mut sample = |label: &str| -> Vec<Duration> {
        (0..CHECKOUTS)
            .map(|_| {
                serial += 1;
                let at = Instant::now();
                super::availability_tests::checkout(
                    &business.state,
                    &format!("your_attr_{label}_{serial}"),
                    &tracker,
                );
                at.elapsed()
            })
            .collect()
    };
    let pct = |v: &[Duration], p: usize| v[(v.len() * p).div_ceil(100) - 1];
    for n in 0..10 {
        super::availability_tests::checkout(
            &business.state,
            &format!("your_attr_warm_{n}"),
            &tracker,
        );
    }
    for load in [
        Load::CpuOnly,
        Load::PermitOnly,
        Load::ReadsOnly,
        Load::Full,
        Load::PacedReads,
    ] {
        let baseline = sample("base");
        let running = Arc::new(AtomicBool::new(true));
        let ops = Arc::new(AtomicUsize::new(0));
        let path = business.db_path().to_owned();
        let gate = critical_op::global();
        let worker_running = running.clone();
        let worker_ops = ops.clone();
        let worker = std::thread::spawn(move || {
            let mut tick = 0usize;
            while worker_running.load(Ordering::Acquire) {
                match load {
                    Load::CpuOnly => {}
                    Load::PermitOnly => {
                        if gate.try_begin_support(false, None).is_ok() {
                            worker_ops.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Load::ReadsOnly | Load::Full | Load::PacedReads => {
                        if let Ok(permit) = gate.try_begin_support(false, None) {
                            if let Ok(read) = replica::read_connection(
                                &path,
                                &permit,
                                Instant::now() + Duration::from_secs(5),
                            ) {
                                if read
                                    .query_row("SELECT count(*) FROM orders", [], |r| {
                                        r.get::<_, i64>(0)
                                    })
                                    .is_ok()
                                {
                                    worker_ops.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        }
                    }
                }
                tick += 1;
                if load == Load::Full && tick % 32 == 0 {
                    let conn = rusqlite::Connection::open(&path).unwrap();
                    if let Ok(permit) =
                        gate.try_begin_support_write(Arc::new(conn.get_interrupt_handle()))
                    {
                        if let Ok(tx) = permit.begin_write(&conn) {
                            let _ =
                                tx.execute("UPDATE support_harness_activity SET value=value+1", []);
                            if !permit.is_cancelled() {
                                let _ = tx.commit();
                            }
                        }
                    }
                }
                if load == Load::PacedReads {
                    std::thread::sleep(Duration::from_millis(500));
                } else {
                    std::thread::yield_now();
                }
            }
        });
        let loaded = sample("load");
        running.store(false, Ordering::Release);
        worker.join().unwrap();
        let mut added: Vec<_> = loaded
            .iter()
            .zip(&baseline)
            .map(|(l, b)| l.saturating_sub(*b))
            .collect();
        added.sort_unstable();
        let mut base_sorted = baseline.clone();
        base_sorted.sort_unstable();
        eprintln!(
            "attribution {load:?}: baseline p50={:?}; added p50={:?} p95={:?} p99={:?}; support ops={}",
            pct(&base_sorted, 50),
            pct(&added, 50),
            pct(&added, 95),
            pct(&added, 99),
            ops.load(Ordering::Relaxed)
        );
    }
}

static PROFILED: std::sync::Mutex<Vec<(String, Duration)>> = std::sync::Mutex::new(Vec::new());
fn record_profile(sql: &str, took: Duration) {
    if let Ok(mut all) = PROFILED.lock() {
        all.push((sql.split_whitespace().collect::<Vec<_>>().join(" "), took));
    }
}

/// Diagnostic only (coordinator 02/11): which step of the harness checkout
/// grows with the local orders count. Times the order insert, record_payment,
/// enqueue_print_job and the Health observation separately at 0, 1k, 2k and
/// 5k local orders, then profiles one checkout at 5k and prints the slowest
/// statements with their query plans. No assertion, no fix.
#[test]
#[ignore = "diagnostic: checkout step scaling with local orders"]
fn checkout_step_scaling_with_local_orders() {
    use crate::support::critical_op;
    use serde_json::json;
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = critical_op::install_test_gate();
    let business = super::availability_tests::business_fixture();
    let db = &business.state;
    let insert = |id: &str| {
        db.conn.lock().unwrap().execute("INSERT INTO orders(id,order_number,items,total_amount,total_amount_cents,status,order_type,payment_status,sync_status,branch_id,terminal_id,staff_shift_id,staff_id,currency,created_at,updated_at) VALUES(?1,?1,'[]',10,1000,'pending','takeaway','pending','pending','your_branch','your_terminal','your_shift','your_cashier','EUR','2026-11-01T12:00:00Z','2026-11-01T12:00:00Z')", [id]).unwrap();
    };
    let pay = |id: &str| {
        crate::payments::record_payment(db, &json!({"orderId":id,"method":"cash","amount":10,"idempotencyKey":format!("your_payment_{id}")})).unwrap();
    };
    let print = |id: &str| {
        crate::print::enqueue_print_job(
            db,
            "order_receipt",
            id,
            None,
            &crate::print::NoopPrintQueueInvalidator,
        )
        .unwrap();
    };
    let median = |mut v: Vec<Duration>| {
        v.sort_unstable();
        v[v.len() / 2]
    };
    let mut seeded = 0usize;
    for level in [0usize, 1_000, 2_000, 5_000] {
        while seeded < level {
            let id = format!("your_seed_{seeded}");
            insert(&id);
            pay(&id);
            print(&id);
            seeded += 1;
        }
        let (mut i, mut p, mut q, mut h) = (vec![], vec![], vec![], vec![]);
        for n in 0..20 {
            let id = format!("your_level_{level}_{n}");
            let at = Instant::now();
            insert(&id);
            i.push(at.elapsed());
            let at = Instant::now();
            pay(&id);
            p.push(at.elapsed());
            let at = Instant::now();
            print(&id);
            q.push(at.elapsed());
            let at = Instant::now();
            crate::diagnostics::get_system_health(db).unwrap();
            h.push(at.elapsed());
            seeded += 1;
        }
        eprintln!(
            "scaling orders~{level}: insert={:?} record_payment={:?} enqueue_print_job={:?} get_system_health={:?}",
            median(i),
            median(p),
            median(q),
            median(h)
        );
    }
    PROFILED.lock().unwrap().clear();
    db.conn.lock().unwrap().profile(Some(record_profile));
    let id = "your_profiled";
    insert(id);
    pay(id);
    print(id);
    crate::diagnostics::get_system_health(db).unwrap();
    db.conn.lock().unwrap().profile(None);
    let mut all = PROFILED.lock().unwrap().clone();
    all.sort_by(|a, b| b.1.cmp(&a.1));
    let conn = db.conn.lock().unwrap();
    for (sql, took) in all.iter().take(12) {
        eprintln!("slow {took:?}: {sql}");
        if let Ok(mut plan) = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")) {
            let mut rows = plan.raw_query();
            while let Ok(Some(row)) = rows.next() {
                eprintln!("    plan: {}", row.get::<_, String>(3).unwrap_or_default());
            }
        }
    }
}
