//! A checkout never waits for a Health scan (02/11/2026).
//!
//! Symptom: a checkout that started while Health ran waited up to about
//! 0.5 s at 5,000 local orders on a 2-core till, and far longer while Health
//! ran repeatedly (17 s measured, 2 cores). Health takes the business mutex
//! when the right rail's Health panel mounts or refreshes, from the recovery
//! modal, from remote support's remedy listing and for an export.
//! `record_payment` also grew from 3 to 16 ms while the parity queue was long
//! (offline).
//!
//! Root cause: `get_system_health` ran its reads on the business connection
//! under `DbState.conn`: the per-order paid-coverage query (~183 ms at 5,000
//! orders) and eight scans of the parity queue through the repair-owner
//! filter. Every enqueue also scanned the whole queue for repair look-alikes.
//!
//! The benchmark below is the reproduction: an ignored timing run at about 0,
//! 1k, 2k and 5k local orders on a file-backed WAL database.
//! Explicit invocation:
//! cargo test --lib tests::health_checkout_scaling -- --ignored --nocapture

use crate::db::DbState;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn fixture() -> crate::tests::harness::TestDb {
    let fixture = crate::tests::harness::TestDb::open();
    {
        let conn = fixture.state.conn.lock().unwrap();
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
        conn.execute(
            "INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,check_in_time,status,currency,created_at,updated_at)
             VALUES('your_shift','your_cashier','your_branch','your_terminal','cashier','now','active','EUR','now','now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,opening_amount,opening_amount_cents,currency,opened_at,created_at,updated_at)
             VALUES('your_drawer','your_shift','your_cashier','your_branch','your_terminal',100,10000,'EUR','now','now','now')",
            [],
        )
        .unwrap();
    }
    fixture
}

fn insert_order(db: &DbState, id: &str) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO orders(id,order_number,items,total_amount,total_amount_cents,status,order_type,payment_status,sync_status,branch_id,terminal_id,staff_shift_id,staff_id,currency,created_at,updated_at)
             VALUES(?1,?1,'[]',10,1000,'pending','takeaway','pending','pending','your_branch','your_terminal','your_shift','your_cashier','EUR','2026-11-01T12:00:00Z','2026-11-01T12:00:00Z')",
            [id],
        )
        .unwrap();
}

fn pay(db: &DbState, id: &str) {
    crate::payments::record_payment(
        db,
        &json!({"orderId":id,"method":"cash","amount":10,"idempotencyKey":format!("your_payment_{id}")}),
    )
    .unwrap();
}

fn print(db: &DbState, id: &str) {
    crate::print::enqueue_print_job(
        db,
        "order_receipt",
        id,
        None,
        &crate::print::NoopPrintQueueInvalidator,
    )
    .unwrap();
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

static PROFILED: Mutex<Vec<(String, Duration)>> = Mutex::new(Vec::new());

fn record_profile(sql: &str, took: Duration) {
    PROFILED.lock().unwrap().push((sql.to_string(), took));
}

/// The longest the business mutex made a would-be checkout wait while three
/// Health runs went on in another thread. The probe takes the mutex, releases
/// it at once and looks again 1 ms later, like a till taking a sale.
fn business_mutex_wait_during_health(db: &DbState) -> (Duration, Duration) {
    let done = AtomicBool::new(false);
    let mut longest = Duration::ZERO;
    let mut health = Duration::ZERO;
    std::thread::scope(|scope| {
        let runner = scope.spawn(|| {
            let _keyring = crate::tests::fake_keyring::install_empty();
            let at = Instant::now();
            for _ in 0..3 {
                crate::diagnostics::get_system_health(db).unwrap();
            }
            done.store(true, Ordering::SeqCst);
            at.elapsed() / 3
        });
        while !done.load(Ordering::SeqCst) {
            let at = Instant::now();
            drop(db.conn.lock().unwrap());
            longest = longest.max(at.elapsed());
            std::thread::sleep(Duration::from_millis(1));
        }
        health = runner.join().unwrap();
    });
    (longest, health)
}

#[test]
#[ignore = "timing run on a growing fixture; prints, never asserts"]
fn health_and_checkout_scaling_with_local_orders() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let business = fixture();
    let db = &business.state;
    let mut seeded = 0usize;
    for level in [0usize, 1_000, 2_000, 5_000] {
        while seeded < level {
            let id = format!("your_seed_{seeded}");
            insert_order(db, &id);
            pay(db, &id);
            print(db, &id);
            seeded += 1;
        }
        let (mut i, mut p, mut q, mut h) = (vec![], vec![], vec![], vec![]);
        for n in 0..20 {
            let id = format!("your_level_{level}_{n}");
            let at = Instant::now();
            insert_order(db, &id);
            i.push(at.elapsed());
            let at = Instant::now();
            pay(db, &id);
            p.push(at.elapsed());
            let at = Instant::now();
            print(db, &id);
            q.push(at.elapsed());
            let at = Instant::now();
            crate::diagnostics::get_system_health(db).unwrap();
            h.push(at.elapsed());
            seeded += 1;
        }
        let (wait, health_in_thread) = business_mutex_wait_during_health(db);
        eprintln!(
            "scaling orders~{level}: insert={:?} record_payment={:?} enqueue_print_job={:?} get_system_health={:?} | during Health ({health_in_thread:?} each): longest business-mutex wait={wait:?}",
            median(i),
            median(p),
            median(q),
            median(h),
        );
    }
    PROFILED.lock().unwrap().clear();
    db.conn.lock().unwrap().profile(Some(record_profile));
    let id = "your_profiled";
    insert_order(db, id);
    pay(db, id);
    print(db, id);
    let business_statements = PROFILED.lock().unwrap().len();
    // Health's own read-only connection reports into the same list.
    crate::diagnostics::HEALTH_READER_OPENED.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(|conn: &mut rusqlite::Connection| {
            conn.profile(Some(record_profile));
        }));
    });
    crate::diagnostics::get_system_health(db).unwrap();
    db.conn.lock().unwrap().profile(None);
    let mut all = PROFILED.lock().unwrap().clone();
    let total: Duration = all.iter().map(|(_, took)| *took).sum();
    eprintln!(
        "checkout + Health: {} statements ({business_statements} for the checkout), {total:?} in all",
        all.len()
    );
    all.sort_by(|a, b| b.1.cmp(&a.1));
    let conn = db.conn.lock().unwrap();
    for (sql, took) in all.iter().take(12) {
        let flat: String = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        eprintln!(
            "slow {took:?}: {}",
            flat.chars().take(300).collect::<String>()
        );
        if let Ok(mut plan) = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")) {
            let mut rows = plan.raw_query();
            while let Ok(Some(row)) = rows.next() {
                eprintln!("    plan: {}", row.get::<_, String>(3).unwrap_or_default());
            }
        }
    }
}

/// The benchmark's fixture plus what the Health reads have to look at: an
/// organization (parked checkouts), paid orders with their receipts, an order
/// marked paid without a payment row (a paid-coverage blocker) and failed
/// parity rows.
fn regression_fixture() -> crate::tests::harness::TestDb {
    let business = fixture();
    let db = &business.state;
    crate::db::set_setting(
        &db.conn.lock().unwrap(),
        "terminal",
        "organization_id",
        "your_org",
    )
    .unwrap();
    for n in 0..5 {
        let id = format!("your_paid_{n}");
        insert_order(db, &id);
        pay(db, &id);
        print(db, &id);
    }
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO orders(id,order_number,items,total_amount,total_amount_cents,status,order_type,payment_status,sync_status,branch_id,terminal_id,staff_shift_id,staff_id,currency,created_at,updated_at)
         VALUES('your_paid_without_payment','your_paid_without_payment','[]',10,1000,'completed','takeaway','paid','pending','your_branch','your_terminal','your_shift','your_cashier','EUR','2026-11-01T12:00:00Z','2026-11-01T12:00:00Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE parity_sync_queue SET status = 'failed', attempts = 10, error_message = 'HTTP 500'
          WHERE id IN (SELECT id FROM parity_sync_queue ORDER BY created_at LIMIT 2)",
        [],
    )
    .unwrap();
    drop(conn);
    business
}

type PauseChannels = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);

thread_local! {
    static BUSINESS_STATEMENTS: std::cell::RefCell<Vec<String>> =
        const { std::cell::RefCell::new(Vec::new()) };
    static PAUSE_AT_PAID_COVERAGE: std::cell::RefCell<Option<PauseChannels>> =
        const { std::cell::RefCell::new(None) };
    static PAID_COVERAGE_SQL: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

fn is_paid_coverage(sql: &str) -> bool {
    sql.contains("FROM orders o") && sql.contains("julianday(")
}

fn record_business_statement(sql: &str) {
    BUSINESS_STATEMENTS.with(|statements| statements.borrow_mut().push(sql.to_string()));
}

/// Pauses the first paid-coverage read (the per-order sums over the shift's
/// window) until the test lets it go on.
fn pause_at_paid_coverage(sql: &str) {
    if !is_paid_coverage(sql) {
        return;
    }
    if let Some((reading, resume)) = PAUSE_AT_PAID_COVERAGE.with(|slot| slot.borrow_mut().take()) {
        reading.send(()).unwrap();
        resume.recv().unwrap();
    }
}

fn capture_paid_coverage(sql: &str) {
    if is_paid_coverage(sql) {
        PAID_COVERAGE_SQL.with(|slot| *slot.borrow_mut() = Some(sql.to_string()));
    }
}

/// Health's only work on the business connection is the legacy order-update
/// cleanup (`sync_queue` and `orders`); every read goes to its own connection.
/// Before 02/11/2026 every read ran here, the paid coverage and the parity
/// queue counts included.
#[test]
fn health_reads_nothing_on_the_business_connection() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let business = regression_fixture();
    let db = &business.state;
    BUSINESS_STATEMENTS.with(|statements| statements.borrow_mut().clear());
    db.conn
        .lock()
        .unwrap()
        .trace(Some(record_business_statement));
    let health = crate::diagnostics::get_system_health(db).expect("Health answers");
    db.conn.lock().unwrap().trace(None);
    assert_eq!(health["readFailures"], json!([]), "{health:#}");
    assert!(
        health["checkoutPaymentBlockers"]["count"].as_u64() >= Some(1),
        "the fixture's paid order without a payment row: {health:#}"
    );
    let statements = BUSINESS_STATEMENTS.with(|statements| statements.borrow().clone());
    assert!(
        statements
            .iter()
            .any(|sql| sql.contains("FROM sync_queue sq")),
        "the legacy cleanup still runs on the business connection: {statements:#?}"
    );
    let reads: Vec<&String> = statements
        .iter()
        .filter(|sql| {
            let cleanup = sql.contains("sync_queue") && !sql.contains("parity_sync_queue");
            !(cleanup || sql.trim_start().starts_with("UPDATE orders"))
        })
        .collect();
    assert!(
        reads.is_empty(),
        "Health read on the business connection: {reads:#?}"
    );
}

/// The founder's rule: a checkout never waits. While Health is in the middle
/// of its paid-coverage read, holding a read snapshot, a checkout takes the
/// business mutex at once and commits; Health then finishes normally.
#[test]
fn a_checkout_started_during_health_does_not_wait_for_it() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let business = regression_fixture();
    let db = &business.state;
    let (reading_tx, reading_rx) = std::sync::mpsc::channel::<()>();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel::<()>();
    std::thread::scope(|scope| {
        let health = scope.spawn(move || {
            let _keyring = crate::tests::fake_keyring::install_empty();
            PAUSE_AT_PAID_COVERAGE.with(|slot| *slot.borrow_mut() = Some((reading_tx, resume_rx)));
            crate::diagnostics::HEALTH_READER_OPENED.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(|conn: &mut rusqlite::Connection| {
                    // One read snapshot for the whole run, held while paused.
                    conn.execute_batch("BEGIN").unwrap();
                    conn.query_row("SELECT COUNT(*) FROM orders", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap();
                    conn.trace(Some(pause_at_paid_coverage));
                }));
            });
            crate::diagnostics::get_system_health(db)
        });
        if reading_rx.recv_timeout(Duration::from_secs(60)).is_err() {
            panic!("Health never reached its paid-coverage read on a connection of its own");
        }
        let free = db.conn.try_lock().is_ok();
        assert!(
            free,
            "Health holds the business mutex during its paid-coverage read"
        );
        let at = Instant::now();
        insert_order(db, "your_checkout_during_health");
        pay(db, "your_checkout_during_health");
        print(db, "your_checkout_during_health");
        let checkout = at.elapsed();
        resume_tx.send(()).unwrap();
        let health = health.join().unwrap().expect("Health answers");
        assert_eq!(health["readFailures"], json!([]), "{health:#}");
        let paid: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'your_checkout_during_health'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(paid, "paid", "the checkout committed in {checkout:?}");
    });
}

fn without_clock_fields(mut value: serde_json::Value) -> serde_json::Value {
    match &mut value {
        serde_json::Value::Object(fields) => {
            fields.remove("oldestItemAge");
            for field in fields.values_mut() {
                *field = without_clock_fields(field.take());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                *item = without_clock_fields(item.take());
            }
        }
        _ => {}
    }
    value
}

/// Same answers on its own read-only connection as on the business one.
#[test]
fn health_on_its_own_connection_reads_what_the_business_connection_reads() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let business = regression_fixture();
    let db = &business.state;
    let on_business = crate::diagnostics::build_system_health(db, db).expect("business read");
    let on_reader = crate::diagnostics::get_system_health(db).expect("own connection");
    assert_eq!(on_reader["readFailures"], json!([]), "{on_reader:#}");
    assert_eq!(
        without_clock_fields(on_reader),
        without_clock_fields(on_business)
    );
}

/// Paid coverage reads every local order's business-day timestamp from the
/// v107 index alone, and an order's completed payments by key.
#[test]
fn paid_coverage_reads_completed_payments_by_key() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let business = regression_fixture();
    let mut conn = business.state.conn.lock().unwrap();
    conn.trace(Some(capture_paid_coverage));
    let blockers = crate::payment_integrity::load_branch_window_payment_blockers(
        &conn,
        "your_branch",
        "2026-01-01T00:00:00Z",
        None,
        true,
    )
    .expect("paid coverage");
    conn.trace(None);
    assert!(
        !blockers.is_empty(),
        "the fixture's paid order without a payment row"
    );
    let sql = PAID_COVERAGE_SQL
        .with(|slot| slot.borrow_mut().take())
        .expect("the paid-coverage statement");
    let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let plan = statement
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join(" | ");
    assert!(
        plan.contains("SEARCH op_fin USING COVERING INDEX idx_order_payments_order_status"),
        "{plan}"
    );
}

/// v107 adds its three indexes to a v105 till, keeps its rows, and a second
/// pass changes nothing.
#[test]
fn v107_adds_its_indexes_to_a_v105_till() {
    const INDEXES: [&str; 3] = [
        "idx_parity_sync_queue_repair_lookalike",
        "idx_orders_repair_settlement",
        "idx_order_payments_order_status",
    ];
    let _keyring = crate::tests::fake_keyring::install_empty();
    let business = regression_fixture();
    let conn = business.state.conn.lock().unwrap();
    let present = |conn: &rusqlite::Connection| -> Vec<String> {
        INDEXES
            .iter()
            .filter(|name| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
                    [name],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap()
            })
            .map(|name| name.to_string())
            .collect()
    };
    let rows = |conn: &rusqlite::Connection| -> (i64, i64, i64) {
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM order_payments),
                    (SELECT COUNT(*) FROM parity_sync_queue)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    };
    assert_eq!(present(&conn), INDEXES, "a new till");
    let before = rows(&conn);
    conn.execute_batch(
        "DROP INDEX idx_parity_sync_queue_repair_lookalike;
         DROP INDEX idx_orders_repair_settlement;
         DROP INDEX idx_order_payments_order_status;
         DELETE FROM schema_version WHERE version >= 106;",
    )
    .unwrap();
    assert!(present(&conn).is_empty());
    crate::db::run_migrations_for_test(&conn);
    assert_eq!(present(&conn), INDEXES, "upgraded from v105");
    assert_eq!(rows(&conn), before);
    crate::db::run_migrations_for_test(&conn);
    assert_eq!(present(&conn), INDEXES, "second pass");
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, i64::from(crate::db::CURRENT_SCHEMA_VERSION));
}
