//! Offline week Ω10 (plan §6, founder 21/10/2026): seven days on one Windows
//! till with the admin API unreachable, then the connection back.
//!
//! Everything the staff do goes through the till's own code:
//! - the PIN is checked on the till because the server does not answer
//!   (`auth::verify_staff_check_in_pin_with`), and the vault grant opens the
//!   shift (`shifts::open_shift_with_admission`, as the `shift_open` command
//!   does), with the `offline_check_in` marker;
//! - orders are taken with their payment (`sync::create_order`,
//!   `initialPayment`), deliveries are assigned (`assign_driver_locally`: the
//!   driver earning and the order update), drivers and the cashier check out
//!   (`shifts::close_shift`);
//! - the Z closes the day on the till through the command's own local stages
//!   (`commands::analytics::close_z_report_locally_core`, which the Z command
//!   runs before it prints and emits);
//! - the queue is the real `sync_queue::process_queue`, first against a line
//!   that never answers, then against a simulated admin API on a virtual
//!   clock; the refused payment is set aside through the Health command's own
//!   core after the manager's approval
//!   (`commands::diagnostics::apply_z_gate_set_aside`).
//!
//! The till has no clock seam. A day passes by moving every stored date one
//! day back ([`one_day_passes`]), so each day keeps its own report date and
//! its own Z window.
//!
//! Size: `OFFLINE_WEEK_ORDERS_PER_DAY` (default 40, Tomikro is 110). The
//! catch-up harness measured about 20 ms per queue row at 3,600 rows in a
//! debug build (`desktop-catchup-7x110.log`), so 7 × 110 orders (about 2,700
//! rows, plus the week itself) would not finish in the 60 s a blocking test
//! has. The per-day capacity and size limits are also checked as projected to
//! 110 orders a day.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Datelike, Duration as ChronoDuration, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::db::DbState;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "7e57a11a-0000-4000-8000-000000000001";
const BRANCH_ID: &str = "b7a2c400-0000-4000-8000-000000000001";
const ORGANIZATION_ID: &str = "0a9e0000-0000-4000-8000-000000000001";
const CASHIER_ID: &str = "ca5e0000-0000-4000-8000-000000000001";
const DRIVER_IDS: [&str; 3] = [
    "d0000000-0000-4000-8000-0000000000d1",
    "d0000000-0000-4000-8000-0000000000d2",
    "d0000000-0000-4000-8000-0000000000d3",
];
/// The manager who approves the set-aside (the approval itself is the
/// command layer's, `auth::authorize_permitted_money_action`).
const MANAGER_ID: &str = "aa000000-0000-4000-8000-0000000000aa";
const STAFF_PIN: &str = "4321";
const API_KEY: &str = "offline-week-api-key";

const DAYS: u32 = 7;
const DEFAULT_ORDERS_PER_DAY: u32 = 40;
const TOMIKRO_ORDERS_PER_DAY: u32 = 110;
/// Orders of day 8, taken after the 7th Z and before the connection is back.
const MORNING_ORDERS: u32 = 3;
/// The server refuses one payment for good: day 2, order 7 (a pickup).
const REFUSED_DAY: u32 = 2;
const REFUSED_ORDER: u32 = 7;
/// The cashier's close of day 3 meets one 503.
const TRANSIENT_DAY: u32 = 3;

/// Simulated round trip per request, and the background loop's interval.
const LATENCY_MS: u64 = 250;
const PASS_INTERVAL_MS: u64 = 15_000;
/// Every row but the refused one reaches the server within 30 virtual minutes.
const DRAIN_LIMIT_MS: u64 = 30 * 60 * 1_000;
const MAX_PASSES: u32 = 400;
/// The database file stays under 15 MB all week.
const MAX_DB_BYTES: i64 = 15 * 1024 * 1024;

fn orders_per_day() -> u32 {
    std::env::var("OFFLINE_WEEK_ORDERS_PER_DAY")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT_ORDERS_PER_DAY)
        .max(REFUSED_ORDER + 3)
}

/// What the week left for the reconnection to check.
#[derive(Default)]
struct Week {
    /// Per day, the client ids of its orders (`clientRequestId`, which the
    /// order sync sends as `client_order_id`).
    client_ids: Vec<BTreeSet<String>>,
    orders: usize,
    deliveries: usize,
    refused_order_id: Option<String>,
    refused_payment_id: Option<String>,
    transient_close_shift: Option<String>,
}

/// Seven days without the server, one Z each evening, then the connection
/// back: every row reaches the server in order, the refused payment is set
/// aside by a manager, seven Zs arrive in window order and the sweeps leave
/// only what came after the 7th Z, and the set-aside record.
#[tokio::test]
#[serial_test::serial]
async fn seven_offline_days_then_one_z_per_day() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL_ID),
        ("branch_id", BRANCH_ID),
        ("organization_id", ORGANIZATION_ID),
    ]);
    let fixture = TestDb::open();
    let db = &fixture.state;
    seed_till(db);
    let per_day = orders_per_day();
    let scale = f64::from(TOMIKRO_ORDERS_PER_DAY) / f64::from(per_day);
    let start = footprint(db);
    let line = DeadLine::start().await;
    let mut week = Week::default();

    // Days 1–7: the server never answers.
    for day in 1..=DAYS {
        run_offline_day(db, day, per_day, &line, &mut week).await;
        assert_day_footprint(day, &footprint(db), &start, scale);
        {
            let conn = db.conn.lock().expect("lock the database");
            crate::sync_queue::ensure_enqueue_capacity(&conn, 3).unwrap_or_else(|refusal| {
                panic!("day {day}: the queue would refuse a delivery assignment: {refusal}")
            });
        }
        one_day_passes(db);
    }

    // Day 8, morning: still offline, the cashier opens and sells.
    let morning_shift =
        check_in_without_the_server(db, CASHIER_ID, "Cashier", "cashier", 100.0).await;
    for k in 0..MORNING_ORDERS {
        take_order(db, &format!("week-d8-o{k:03}"), false, 8_000 + k);
    }
    line.one_pass_one_request(db, "day 8 morning").await;
    line.stop();

    // Offline nothing was deleted (invariant 1), and seven Zs wait.
    {
        let conn = db.conn.lock().expect("lock the database");
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .expect("count the orders");
        assert_eq!(
            orders,
            (week.orders + MORNING_ORDERS as usize) as i64,
            "no order leaves the till before the server confirms its Z"
        );
        assert_eq!(
            crate::zreport::unconfirmed_local_z_count(&conn).expect("count the local Zs"),
            i64::from(DAYS),
            "seven Zs closed on the till wait for the server"
        );
    }

    // The connection is back.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the admin API");
    let base_url = format!(
        "http://{}",
        listener.local_addr().expect("the admin API's address")
    );
    let sim = Arc::new(Mutex::new(SimServer {
        transient_close_shift: week.transient_close_shift.clone(),
        refused_payment_id: week.refused_payment_id.clone(),
        ..SimServer::default()
    }));
    let server = spawn_admin_api(listener, Arc::clone(&sim));
    let drain = drain_with_the_server_back(db, &base_url, &sim, &week).await;
    server.abort();

    assert_reconnection(db, &sim, &week, &drain, &morning_shift);
    eprintln!(
        "offline week: {DAYS} days x {per_day} orders, {} deliveries; reconnection: {} passes, \
         {:.1} virtual minutes, set-aside after {} Z(s)",
        week.deliveries,
        drain.passes,
        drain.finished_ms as f64 / 60_000.0,
        drain.z_before_set_aside
    );
}

// ---------------------------------------------------------------------------
// One day on the till
// ---------------------------------------------------------------------------

async fn run_offline_day(db: &DbState, day: u32, per_day: u32, line: &DeadLine, week: &mut Week) {
    // Morning: the cashier first, then three drivers, each by PIN on the till.
    let cashier = check_in_without_the_server(db, CASHIER_ID, "Cashier", "cashier", 100.0).await;
    let mut drivers = Vec::new();
    for (index, driver_id) in DRIVER_IDS.iter().enumerate() {
        let name = format!("Driver {}", index + 1);
        drivers.push(check_in_without_the_server(db, driver_id, &name, "driver", 0.0).await);
    }

    // The day's orders: 70 % deliveries, each assigned to a driver.
    let mut client_ids = BTreeSet::new();
    for k in 0..per_day {
        let delivery = k % 10 < 7;
        let client_id = format!("week-d{day}-o{k:03}");
        let order_id = take_order(db, &client_id, delivery, day * 1_000 + k);
        if delivery {
            assign_delivery(db, &order_id, DRIVER_IDS[(k as usize) % DRIVER_IDS.len()]);
            week.deliveries += 1;
        }
        if day == REFUSED_DAY && k == REFUSED_ORDER {
            week.refused_payment_id = Some(payment_of(db, &order_id));
            week.refused_order_id = Some(order_id.clone());
        }
        client_ids.insert(client_id);
        week.orders += 1;
    }
    week.client_ids.push(client_ids);

    // The background sync tries during the day, and stops at once.
    line.one_pass_one_request(db, &format!("day {day} midday"))
        .await;

    // Evening: the drivers hand in their cash, then the cashier counts.
    let mut returned_cents = 0_i64;
    for shift_id in &drivers {
        let cash_cents = driver_cash_to_return_cents(db, shift_id);
        returned_cents += cash_cents;
        check_out(db, shift_id, cash_cents);
    }
    let drawer_cents = 10_000 + cashier_cash_sales_cents(db, &cashier) + returned_cents;
    check_out(db, &cashier, drawer_cents);
    if day == TRANSIENT_DAY {
        week.transient_close_shift = Some(cashier.clone());
    }

    close_the_day_without_the_server(db, day);
    line.one_pass_one_request(db, &format!("day {day} night"))
        .await;
}

/// The till as Tomikro's main register: identity, store currency, the staff
/// directory it cached while online, and the PIN hashes in the credential
/// store (the vault).
fn seed_till(db: &DbState) {
    let conn = db.conn.lock().expect("lock the database");
    // Commits are not fsynced one by one (production runs FULL): nothing here
    // has to survive a power cut, and the week has to run in seconds.
    conn.execute_batch("PRAGMA synchronous = NORMAL")
        .expect("relax fsync for the test");
    for (category, key, value) in [
        ("terminal", "terminal_id", TERMINAL_ID),
        ("terminal", "branch_id", BRANCH_ID),
        ("terminal", "organization_id", ORGANIZATION_ID),
        ("restaurant", "store_currency_branch_id", BRANCH_ID),
        ("restaurant", "store_currency_available", "true"),
        ("restaurant", "store_currency_source", "branch_country"),
        ("restaurant", "currency", "EUR"),
    ] {
        crate::db::set_setting(&conn, category, key, value).expect("seed a till setting");
    }
    let mut staff = vec![json!({
        "id": CASHIER_ID,
        "name": "Cashier",
        "role_name": "cashier",
        "is_active": true,
        "can_login_pos": true,
        "has_pin": true,
    })];
    for (index, driver_id) in DRIVER_IDS.iter().enumerate() {
        staff.push(json!({
            "id": driver_id,
            "name": format!("Driver {}", index + 1),
            "role_name": "driver",
            "is_active": true,
            "can_login_pos": true,
            "has_pin": true,
        }));
    }
    let directory = json!({
        "version": 1,
        "branch_id": BRANCH_ID,
        "synced_at": Utc::now().to_rfc3339(),
        "staff": staff,
    });
    crate::db::set_setting(
        &conn,
        "staff_auth_cache",
        &format!("branch_{BRANCH_ID}"),
        &directory.to_string(),
    )
    .expect("cache the staff directory");
    drop(conn);

    let hash = bcrypt::hash(STAFF_PIN, 4).expect("hash the test PIN");
    let entries: Vec<crate::staff_pin_vault::DirectoryPinEntry> = std::iter::once(CASHIER_ID)
        .chain(DRIVER_IDS)
        .map(|id| crate::staff_pin_vault::DirectoryPinEntry {
            id: id.to_string(),
            hash: Some(hash.clone()),
            pin_removed: false,
            active: true,
            can_login_pos: true,
        })
        .collect();
    crate::staff_pin_vault::save_directory(BRANCH_ID, &entries, Utc::now())
        .expect("hold the PIN hashes on the till");
}

/// A check-in while the server does not answer: the till checks the PIN
/// against its vault and leaves the grant the shift opening reads, as the
/// `shift_open` command does. Answers the new shift id.
async fn check_in_without_the_server(
    db: &DbState,
    staff_id: &str,
    staff_name: &str,
    role: &str,
    opening_cash: f64,
) -> String {
    let verified = crate::auth::verify_staff_check_in_pin_with(
        Some(json!({ "staffId": staff_id, "branchId": BRANCH_ID, "pin": STAFF_PIN })),
        db,
        |_request| async {
            Err::<Value, crate::api::AdminFetchError>(crate::api::AdminFetchError::transport(
                "Cannot reach admin dashboard",
            ))
        },
    )
    .await
    .unwrap_or_else(|error| panic!("{staff_name}: the PIN check failed: {error}"));
    assert_eq!(verified["success"], true, "{staff_name}: {verified}");
    assert_eq!(verified["source"], "offline", "{staff_name}: {verified}");

    let admission = crate::offline_check_in::admission_for(staff_id, Utc::now());
    assert_eq!(
        admission,
        crate::offline_check_in::CheckInAdmission::Offline,
        "{staff_name}: the PIN checked on the till admits the opening"
    );
    let opened = crate::shifts::open_shift_with_admission(
        db,
        &json!({
            "staffId": staff_id,
            "staffName": staff_name,
            "branchId": BRANCH_ID,
            "terminalId": TERMINAL_ID,
            "roleType": role,
            "openingCash": opening_cash,
        }),
        &admission,
    )
    .unwrap_or_else(|error| panic!("{staff_name}: the shift did not open: {error}"));
    crate::offline_check_in::complete(staff_id);
    assert_eq!(opened["offlineCheckIn"], true, "{staff_name}: {opened}");
    opened["shiftId"]
        .as_str()
        .unwrap_or_else(|| panic!("{staff_name}: no shift id in {opened}"))
        .to_string()
}

/// One order with its cash payment, as the checkout sends it (the payload
/// of the 21/10/2026 storage probe).
fn order_payload(client_id: &str, delivery: bool, sequence: u32) -> Value {
    let items: Vec<Value> = (0..3)
        .map(|line| {
            json!({
                "menu_item_id": format!("menu-{line}"),
                "name": format!("Crepe {line} with chocolate and banana"),
                "quantity": 1,
                "price": 6.5,
                "unit_price": 6.5,
                "total_price": 7.0,
                "notes": "no nuts",
                "customizations": [
                    { "name": "Extra banana", "price": 0.5 },
                    { "name": "Whipped cream", "price": 0.0 }
                ]
            })
        })
        .collect();
    let mut payload = json!({
        "organizationId": ORGANIZATION_ID,
        "branchId": BRANCH_ID,
        "terminalId": TERMINAL_ID,
        "clientRequestId": client_id,
        "items": items,
        "totalAmount": 21.0,
        "subtotal": 19.5,
        "status": "pending",
        "orderType": if delivery { "delivery" } else { "takeaway" },
        "paymentStatus": "paid",
        "customerName": "Maria Papadopoulou",
        "customerPhone": format!("69{sequence:08}"),
        "initialPayment": {
            "method": "cash",
            "amount": 21.0,
            "currency": "EUR",
            "idempotencyKey": format!("{client_id}-pay"),
            "cashReceived": 25.0,
            "changeGiven": 4.0
        }
    });
    if delivery {
        payload["deliveryFee"] = json!(1.5);
        payload["deliveryAddress"] = json!("Odos Ermou 12, 3rd floor");
        payload["deliveryCity"] = json!("Thessaloniki");
        payload["deliveryPostalCode"] = json!("54624");
        payload["deliveryNotes"] = json!("Ring twice, second door");
    }
    payload
}

fn take_order(db: &DbState, client_id: &str, delivery: bool, sequence: u32) -> String {
    let created = crate::sync::create_order(
        db,
        &order_payload(client_id, delivery, sequence),
        &crate::print::NoopPrintQueueInvalidator,
    )
    .unwrap_or_else(|error| panic!("{client_id}: the till refused the order: {error}"));
    created["orderId"]
        .as_str()
        .unwrap_or_else(|| panic!("{client_id}: no order id in {created}"))
        .to_string()
}

/// `order_assign_driver` without its print and events: the order moves to
/// the driver's shift, the earning and the order update are queued.
fn assign_delivery(db: &DbState, order_id: &str, driver_id: &str) {
    let conn = db.conn.lock().expect("lock the database");
    let now = Utc::now().to_rfc3339();
    crate::commands::orders::assign_driver_locally(&conn, order_id, driver_id, None, &now)
        .unwrap_or_else(|error| panic!("assign {order_id} to {driver_id}: {error}"));
}

fn payment_of(db: &DbState, order_id: &str) -> String {
    db.conn
        .lock()
        .expect("lock the database")
        .query_row(
            "SELECT id FROM order_payments WHERE order_id = ?1",
            params![order_id],
            |row| row.get(0),
        )
        .expect("the order's payment row")
}

fn driver_cash_to_return_cents(db: &DbState, shift_id: &str) -> i64 {
    db.conn
        .lock()
        .expect("lock the database")
        .query_row(
            "SELECT COALESCE(SUM(COALESCE(cash_to_return_cents,
                                          CAST(ROUND(cash_to_return * 100) AS INTEGER))), 0)
             FROM driver_earnings WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .expect("the driver's cash")
}

fn cashier_cash_sales_cents(db: &DbState, shift_id: &str) -> i64 {
    db.conn
        .lock()
        .expect("lock the database")
        .query_row(
            "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
             FROM order_payments
             WHERE staff_shift_id = ?1 AND method = 'cash' AND status = 'completed'",
            params![shift_id],
            |row| row.get(0),
        )
        .expect("the cashier's cash sales")
}

fn check_out(db: &DbState, shift_id: &str, counted_cents: i64) {
    let closed = crate::shifts::close_shift(
        db,
        &json!({ "shiftId": shift_id, "closingCash": counted_cents as f64 / 100.0 }),
    )
    .unwrap_or_else(|error| panic!("check-out of {shift_id}: {error}"));
    assert_eq!(closed["success"], true, "check-out of {shift_id}: {closed}");
}

/// The Z of a day without the server: the Z command's local stages
/// (`commands::analytics::close_z_report_locally_core`; the command then
/// prints and emits through its `AppHandle`). Answers the Z id.
fn close_the_day_without_the_server(db: &DbState, day: u32) -> String {
    let payload = json!({ "branchId": BRANCH_ID });
    // The store's confirmed "no fiscal plugin" answer. The verdict cache is
    // process-wide and another test's `db::init` clears it, so it is stated
    // right before the close.
    crate::fiscal::active_cache::update(BRANCH_ID, false);
    // Where the offline pre-Z drain hands over to the local close.
    let mut stage: &'static str = "pre_z_sync";
    let closed =
        crate::commands::analytics::close_z_report_locally_core(&payload, db, &mut stage, None)
            .unwrap_or_else(|error| {
                panic!("day {day}: the day did not close on the till: {error}")
            });
    assert_eq!(
        closed["success"], true,
        "day {day}: the till refused or a blocker held the Z: {closed}"
    );
    assert_eq!(closed["localClose"], true, "day {day}: {closed}");
    assert_eq!(closed["pendingUpload"], true, "day {day}: {closed}");
    assert_eq!(closed["localDayClosed"], true, "day {day}: {closed}");
    assert_eq!(stage, "closed_local", "day {day}: the stage reached");
    closed["zReportId"]
        .as_str()
        .unwrap_or_else(|| panic!("day {day}: the Z stored no report to send later: {closed}"))
        .to_string()
}

/// Rows the queue holds and the bytes the database file takes.
struct Footprint {
    queue_rows: i64,
    page_bytes: i64,
}

fn footprint(db: &DbState) -> Footprint {
    let conn = db.conn.lock().expect("lock the database");
    let queue_rows = conn
        .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .expect("count the queue");
    let page_bytes = conn
        .query_row(
            "SELECT (SELECT page_count FROM pragma_page_count())
                  * (SELECT page_size FROM pragma_page_size())",
            [],
            |row| row.get(0),
        )
        .expect("measure the database");
    Footprint {
        queue_rows,
        page_bytes,
    }
}

/// No capacity refusal (every write above succeeded), the queue under 30 %
/// of its ceiling and the file under 15 MB; also projected to 110 orders a
/// day, scaling every row and byte the week added (an overestimate: shift and
/// Z rows do not grow with the orders).
fn assert_day_footprint(day: u32, now: &Footprint, start: &Footprint, scale: f64) {
    let queue_limit = crate::sync_queue::MAX_QUEUE_SIZE * 30 / 100;
    let projected_rows = (now.queue_rows as f64 * scale).ceil() as i64;
    let projected_bytes =
        start.page_bytes + ((now.page_bytes - start.page_bytes) as f64 * scale).ceil() as i64;
    eprintln!(
        "offline week, day {day}: {} queue rows ({projected_rows} at 110/day), {:.2} MB ({:.2} MB at 110/day)",
        now.queue_rows,
        now.page_bytes as f64 / 1_048_576.0,
        projected_bytes as f64 / 1_048_576.0
    );
    assert!(
        now.queue_rows < queue_limit,
        "day {day}: {} queue rows, 30 % of the ceiling is {queue_limit}",
        now.queue_rows
    );
    assert!(
        projected_rows < queue_limit,
        "day {day}: at 110 orders a day the queue would hold {projected_rows} rows"
    );
    assert!(
        now.page_bytes < MAX_DB_BYTES,
        "day {day}: the database takes {} bytes",
        now.page_bytes
    );
    assert!(
        projected_bytes < MAX_DB_BYTES,
        "day {day}: at 110 orders a day the database would take {projected_bytes} bytes"
    );
}

// ---------------------------------------------------------------------------
// A day passes: every stored date moves one day back
// ---------------------------------------------------------------------------

/// The till reads `Utc::now()` everywhere, so the test cannot move its clock.
/// Instead every stored date of the years 2000–2099 moves one day back: in
/// every column of every table, inside stored JSON and keys too, timestamps
/// and plain dates alike (`2026-10-22T08:15:00.123+00:00` keeps its time and
/// format). Order is kept everywhere, the epoch sentinels stay, and the next
/// day's check-in, taken at the real now, lands one day after the last Z.
/// Triggers are dropped and recreated around the rewrite (some refuse any
/// update of their rows), and foreign keys and CHECKs are off meanwhile.
fn one_day_passes(db: &DbState) {
    let conn = db.conn.lock().expect("lock the database");
    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .expect("read foreign_keys");
    conn.execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;")
        .expect("pause the constraints");
    let triggers = name_and_sql(
        &conn,
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
    );
    let tables = name_and_sql(
        &conn,
        "SELECT name, COALESCE(sql, '') FROM sqlite_master
         WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_'",
    );
    let virtual_tables: Vec<String> = tables
        .iter()
        .filter(|(_, sql)| {
            sql.trim_start()
                .to_ascii_uppercase()
                .starts_with("CREATE VIRTUAL TABLE")
        })
        .map(|(name, _)| name.clone())
        .collect();

    conn.execute_batch("BEGIN IMMEDIATE")
        .expect("begin the day change");
    for (name, _) in &triggers {
        conn.execute_batch(&format!("DROP TRIGGER IF EXISTS {}", quoted(name)))
            .expect("drop a trigger for the day change");
    }
    for (table, sql) in &tables {
        let virtual_or_shadow = virtual_tables
            .iter()
            .any(|name| table == name || table.starts_with(&format!("{name}_")));
        if virtual_or_shadow {
            continue;
        }
        let without_rowid = sql.to_ascii_uppercase().contains("WITHOUT ROWID");
        for column in plain_columns(&conn, table) {
            shift_column_one_day_back(&conn, table, &column, without_rowid);
        }
    }
    for (_, sql) in &triggers {
        conn.execute_batch(sql).expect("recreate a trigger");
    }
    conn.execute_batch("COMMIT").expect("commit the day change");

    conn.execute_batch("PRAGMA ignore_check_constraints = OFF")
        .expect("checks back on");
    if foreign_keys == 1 {
        conn.execute_batch("PRAGMA foreign_keys = ON")
            .expect("foreign keys back on");
    }
}

fn name_and_sql(conn: &Connection, sql: &str) -> Vec<(String, String)> {
    let mut statement = conn.prepare(sql).expect("prepare the schema read");
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query the schema")
        .collect::<Result<Vec<(String, String)>, _>>()
        .expect("read the schema");
    rows
}

/// The table's stored columns (no generated or hidden ones).
fn plain_columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_xinfo({})", quoted(table)))
        .expect("prepare the column list");
    let columns = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(6)?))
        })
        .expect("query the column list")
        .collect::<Result<Vec<_>, _>>()
        .expect("read the column list");
    columns
        .into_iter()
        .filter(|(_, hidden)| *hidden == 0)
        .map(|(name, _)| name)
        .collect()
}

fn quoted(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn shift_column_one_day_back(conn: &Connection, table: &str, column: &str, without_rowid: bool) {
    let t = quoted(table);
    let c = quoted(column);
    // A value that is one instant or one date, and nothing else.
    let plain = format!(
        "(length({c}) <= 35
          AND {c} GLOB '20[0-9][0-9]-[01][0-9]-[0-3][0-9]*'
          AND substr({c}, 11) NOT GLOB '*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')"
    );
    let any_date =
        format!("typeof({c}) = 'text' AND {c} GLOB '*20[0-9][0-9]-[01][0-9]-[0-3][0-9]*'");

    // JSON, keys and other text that holds dates elsewhere: rewritten here,
    // before the plain values (whose shape it never produces).
    if without_rowid {
        let mut select = conn
            .prepare(&format!(
                "SELECT DISTINCT {c} FROM {t} WHERE {any_date} AND NOT {plain} ORDER BY {c}"
            ))
            .expect("prepare the dated values");
        let values = select
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query the dated values")
            .collect::<Result<Vec<_>, _>>()
            .expect("read the dated values");
        let mut update = conn
            .prepare(&format!("UPDATE {t} SET {c} = ?1 WHERE {c} = ?2"))
            .expect("prepare the date update");
        for old in values {
            if let Some(new) = shift_dates_back_one_day(&old) {
                update
                    .execute(params![new, old])
                    .unwrap_or_else(|error| panic!("move the dates of {table}.{column}: {error}"));
            }
        }
    } else {
        let mut select = conn
            .prepare(&format!(
                "SELECT rowid, {c} FROM {t} WHERE {any_date} AND NOT {plain} ORDER BY rowid"
            ))
            .expect("prepare the dated rows");
        let rows = select
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query the dated rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("read the dated rows");
        let mut update = conn
            .prepare(&format!("UPDATE {t} SET {c} = ?1 WHERE rowid = ?2"))
            .expect("prepare the date update");
        for (rowid, old) in rows {
            if let Some(new) = shift_dates_back_one_day(&old) {
                update
                    .execute(params![new, rowid])
                    .unwrap_or_else(|error| panic!("move the dates of {table}.{column}: {error}"));
            }
        }
    }

    // One instant or one date: the date part moves, the rest stays as is.
    conn.execute(
        &format!(
            "UPDATE {t} SET {c} = date(substr({c}, 1, 10), '-1 day') || substr({c}, 11)
             WHERE typeof({c}) = 'text' AND {plain} AND date(substr({c}, 1, 10)) IS NOT NULL"
        ),
        [],
    )
    .unwrap_or_else(|error| panic!("move the instants of {table}.{column}: {error}"));
}

/// `text` with every `YYYY-MM-DD` of the years 2000–2099 that is not part of
/// a longer number one day earlier, or `None` when it holds none.
fn shift_dates_back_one_day(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut shifted = String::with_capacity(text.len());
    let mut copied_to = 0;
    let mut changed = false;
    let mut index = 0;
    while index + 10 <= bytes.len() {
        if starts_a_date(bytes, index) {
            let previous = NaiveDate::parse_from_str(&text[index..index + 10], "%Y-%m-%d")
                .ok()
                .filter(|date| (2000..=2099).contains(&date.year()))
                .and_then(|date| date.pred_opt());
            if let Some(previous) = previous {
                shifted.push_str(&text[copied_to..index]);
                shifted.push_str(&previous.format("%Y-%m-%d").to_string());
                index += 10;
                copied_to = index;
                changed = true;
                continue;
            }
        }
        index += 1;
    }
    if !changed {
        return None;
    }
    shifted.push_str(&text[copied_to..]);
    Some(shifted)
}

fn starts_a_date(bytes: &[u8], at: usize) -> bool {
    let digit = |offset: usize| bytes[at + offset].is_ascii_digit();
    (at == 0 || !bytes[at - 1].is_ascii_digit())
        && digit(0)
        && digit(1)
        && digit(2)
        && digit(3)
        && bytes[at + 4] == b'-'
        && digit(5)
        && digit(6)
        && bytes[at + 7] == b'-'
        && digit(8)
        && digit(9)
        && bytes.get(at + 10).is_none_or(|next| !next.is_ascii_digit())
}

// ---------------------------------------------------------------------------
// The line without an answer
// ---------------------------------------------------------------------------

/// A line to the admin API that never answers: each connection is taken and
/// dropped without a response (the router is up, the uplink is down). Unlike
/// a refused port, which costs about 2 s per attempt on Windows, it fails at
/// once, and it counts the requests.
struct DeadLine {
    url: String,
    requests: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl DeadLine {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the dead line");
        let url = format!(
            "http://{}",
            listener.local_addr().expect("the dead line's address")
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let task = {
            let requests = Arc::clone(&requests);
            let seen = Arc::clone(&seen);
            tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        return;
                    };
                    requests.fetch_add(1, Ordering::SeqCst);
                    if let Some(request) = read_request(&mut stream).await {
                        let line = format!("{} {}", request.method, request.path);
                        seen.lock().expect("the dead line's log").push(line);
                    }
                    // No answer: the connection just closes.
                    drop(stream);
                }
            })
        };
        Self {
            url,
            requests,
            seen,
            task,
        }
    }

    /// One background pass offline: it stops at its first transport failure
    /// (Ω2), so it makes exactly one request however long the queue is.
    async fn one_pass_one_request(&self, db: &DbState, when: &str) {
        let before = self.requests.load(Ordering::SeqCst);
        let result = crate::sync_queue::process_queue(&db.conn, &self.url, API_KEY)
            .await
            .unwrap_or_else(|error| panic!("{when}: the offline pass failed: {error}"));
        let made = self.requests.load(Ordering::SeqCst) - before;
        let last: Vec<String> = {
            let seen = self.seen.lock().expect("the dead line's log");
            seen.iter().rev().take(3).cloned().collect()
        };
        assert_eq!(
            made, 1,
            "{when}: an offline pass made {made} requests ({last:?})"
        );
        assert!(
            result.stopped_on_transport_failure,
            "{when}: the pass did not stop at the dead line"
        );
        assert!(
            result.failed >= 1,
            "{when}: the failed request was not counted"
        );
    }

    fn stop(self) {
        self.task.abort();
    }
}

// ---------------------------------------------------------------------------
// The admin API, simulated on a virtual clock
// ---------------------------------------------------------------------------

/// The admin API the queue meets once the connection is back: orders,
/// payments, shift events (a result per event), financial items, fiscal
/// submissions and Zs, each answered as the server does, `LATENCY_MS` of
/// virtual time per request. It keeps a shift chain per person and records
/// what arrived, in order.
#[derive(Default)]
struct SimServer {
    now_ms: u64,
    requests: u64,
    seq: u64,
    /// The day-3 cashier close meets one 503.
    transient_close_shift: Option<String>,
    transient_served: bool,
    /// One payment is refused for good (422).
    refused_payment_id: Option<String>,
    refused_payment_requests: u64,
    accepted_payments: HashSet<String>,
    duplicate_payments: u64,
    /// Client order id → arrival.
    orders: HashMap<String, u64>,
    duplicate_orders: u64,
    order_updates: u64,
    earnings: HashSet<String>,
    /// Person → the shift the server has open for them.
    open_shift_of: HashMap<String, String>,
    /// Shifts the server knows, and those it has closed.
    known_shifts: HashSet<String>,
    closed_shifts: HashSet<String>,
    /// Closes that arrived before their own opening (the server records the
    /// shift closed, `close-before-open`, and later answers the opening
    /// `skipped`: its `offline_check_in` marker is never re-checked).
    closes_before_open: Vec<String>,
    /// Accepted shift events: (person, event type, shift id).
    shift_events: Vec<(String, String, String)>,
    /// Openings the server had to hold for an earlier shift of the person.
    predecessor_waits: u64,
    /// Z submissions: (arrival, body).
    z_submissions: Vec<(u64, Value)>,
    other: Vec<String>,
}

impl SimServer {
    fn answer(&mut self, method: &str, path: &str, body: &Value) -> (u16, Value) {
        self.now_ms += LATENCY_MS;
        self.requests += 1;
        self.seq += 1;
        let seq = self.seq;
        let path = path.split('?').next().unwrap_or(path);
        match (method, path) {
            ("POST", "/api/pos/shifts/sync") => self.answer_shift_events(body),
            ("POST", "/api/pos/orders") => {
                let client_id = text_of(
                    body,
                    &[
                        "client_order_id",
                        "clientOrderId",
                        "client_request_id",
                        "clientRequestId",
                    ],
                )
                .unwrap_or_default();
                if self.orders.insert(client_id.clone(), seq).is_some() {
                    self.duplicate_orders += 1;
                }
                (
                    200,
                    json!({
                        "success": true,
                        "data": {
                            "id": uuid::Uuid::new_v4().to_string(),
                            "client_order_id": client_id
                        }
                    }),
                )
            }
            ("PATCH", "/api/pos/orders") => {
                self.order_updates += 1;
                (200, json!({ "success": true }))
            }
            ("POST", "/api/pos/payments") => {
                let payment_id = text_of(body, &["payment_id", "paymentId"]).unwrap_or_default();
                if self.refused_payment_id.as_deref() == Some(payment_id.as_str()) {
                    self.refused_payment_requests += 1;
                    return (
                        422,
                        json!({
                            "success": false,
                            "error": "The payment could not be accepted",
                            "code": "PAYMENT_REFUSED"
                        }),
                    );
                }
                if !self.accepted_payments.insert(payment_id) {
                    self.duplicate_payments += 1;
                }
                (
                    200,
                    json!({ "success": true, "payment_id": uuid::Uuid::new_v4().to_string() }),
                )
            }
            ("POST", "/api/pos/financial/sync") => {
                let entity_id = body
                    .pointer("/items/0/entity_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.earnings.insert(entity_id.clone());
                (
                    200,
                    json!({
                        "success": true,
                        "results": [{ "entity_id": entity_id, "success": true, "status": "ok" }]
                    }),
                )
            }
            ("POST", "/api/pos/z-report/submit") => {
                self.z_submissions.push((seq, body.clone()));
                (
                    200,
                    json!({ "success": true, "data": { "id": uuid::Uuid::new_v4().to_string() } }),
                )
            }
            ("POST", "/api/plugins/fiscal/submit") => {
                (200, json!({ "success": true, "status": "skipped" }))
            }
            _ => {
                self.other.push(format!("{method} {path}"));
                (200, json!({ "success": true }))
            }
        }
    }

    /// `/api/pos/shifts/sync`: a result per event, as `shifts/sync/route.ts`
    /// answers. An opening while the server still has an earlier shift of the
    /// person open is held (`SHIFT_PREDECESSOR_PENDING`, retryable, W7). A
    /// close of a shift the server does not know is recorded closed
    /// (`shifts-sync-close-before-open`), and its later opening answers
    /// `skipped` ("Shift already closed"). The day-3 cashier close meets one
    /// 503.
    fn answer_shift_events(&mut self, body: &Value) -> (u16, Value) {
        let events = body
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !self.transient_served {
            if let Some(shift) = self.transient_close_shift.clone() {
                let close_of_that_shift = events.iter().any(|event| {
                    text_of(event, &["shift_id"]).as_deref() == Some(shift.as_str())
                        && text_of(event, &["event_type"]).as_deref() != Some("shift_open")
                });
                if close_of_that_shift {
                    self.transient_served = true;
                    return (
                        503,
                        json!({ "success": false, "error": "Service Unavailable" }),
                    );
                }
            }
        }
        let mut results = Vec::new();
        for event in &events {
            let shift_id = text_of(event, &["shift_id"]).unwrap_or_default();
            let event_type = text_of(event, &["event_type"]).unwrap_or_default();
            let staff_id = event
                .get("data")
                .and_then(|data| text_of(data, &["staffId", "staff_id"]))
                .unwrap_or_default();
            if event_type == "shift_open" {
                if self.closed_shifts.contains(&shift_id) {
                    self.shift_events
                        .push((staff_id, event_type, shift_id.clone()));
                    results.push(json!({
                        "shift_id": shift_id,
                        "status": "skipped",
                        "message": "Shift already closed"
                    }));
                    continue;
                }
                let held = self
                    .open_shift_of
                    .get(&staff_id)
                    .is_some_and(|open| *open != shift_id);
                if held {
                    self.predecessor_waits += 1;
                    results.push(json!({
                        "shift_id": shift_id,
                        "status": "error",
                        "code": "SHIFT_PREDECESSOR_PENDING",
                        "retryable": true,
                        "message": "An earlier shift of this person is still open"
                    }));
                    continue;
                }
                self.known_shifts.insert(shift_id.clone());
                self.open_shift_of
                    .insert(staff_id.clone(), shift_id.clone());
            } else {
                if !self.known_shifts.contains(&shift_id) {
                    self.closes_before_open.push(shift_id.clone());
                }
                self.known_shifts.insert(shift_id.clone());
                self.closed_shifts.insert(shift_id.clone());
                if self.open_shift_of.get(&staff_id) == Some(&shift_id) {
                    self.open_shift_of.remove(&staff_id);
                }
            }
            self.shift_events
                .push((staff_id, event_type, shift_id.clone()));
            results.push(json!({ "shift_id": shift_id, "status": "ok" }));
        }
        (207, json!({ "success": true, "results": results }))
    }
}

fn text_of(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn spawn_admin_api(listener: TcpListener, sim: Arc<Mutex<SimServer>>) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let Some(request) = read_request(&mut stream).await else {
                continue;
            };
            let body = serde_json::from_str::<Value>(&request.body).unwrap_or(Value::Null);
            let (status, answer) =
                sim.lock()
                    .expect("the admin API")
                    .answer(&request.method, &request.path, &body);
            write_response(&mut stream, status, &answer.to_string()).await;
        }
    })
}

struct HttpRequest {
    method: String,
    path: String,
    body: String,
}

async fn read_request(stream: &mut TcpStream) -> Option<HttpRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        let Some(header_end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.trim().eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let body_start = header_end + 4;
        if buffer.len() < body_start + length {
            continue;
        }
        let mut request_line = head.lines().next()?.split_whitespace();
        let method = request_line.next()?.to_string();
        let path = request_line.next()?.to_string();
        let body = String::from_utf8_lossy(&buffer[body_start..body_start + length]).to_string();
        return Some(HttpRequest { method, path, body });
    }
}

async fn write_response(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        207 => "Multi-Status",
        422 => "Unprocessable Entity",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

// ---------------------------------------------------------------------------
// The reconnection
// ---------------------------------------------------------------------------

struct Drain {
    passes: u32,
    set_aside_queue_id: String,
    /// Zs the server had when the manager set the refused payment aside.
    z_before_set_aside: usize,
    /// Virtual time when the last row went out.
    finished_ms: u64,
}

/// Background passes every 15 virtual seconds until the queue is empty. A
/// row the queue schedules for later waits that long in virtual time (the
/// harness releases it then). Once only the Zs are left, held by the refused
/// payment of day 2, the manager sets it aside as the Health command does
/// after the approval: the candidate check, the set-aside, the refresh of
/// the waiting Zs' "not on the server" list.
async fn drain_with_the_server_back(
    db: &DbState,
    base_url: &str,
    sim: &Arc<Mutex<SimServer>>,
    week: &Week,
) -> Drain {
    let refused_payment_id = week
        .refused_payment_id
        .clone()
        .expect("the payment the server refuses");
    let mut parked: HashMap<String, (String, u64)> = HashMap::new();
    let mut set_aside: Option<(String, usize)> = None;
    let mut passes = 0_u32;
    loop {
        release_parked_rows(db, sim, &mut parked);
        let result = crate::sync_queue::process_queue(&db.conn, base_url, API_KEY)
            .await
            .unwrap_or_else(|error| panic!("pass {passes}: {error}"));
        passes += 1;
        assert!(
            result.shift_conflicts.is_empty(),
            "pass {passes}: the server refused a shift: {:?}",
            result.shift_conflicts
        );
        assert_eq!(
            result.conflicts,
            0,
            "pass {passes}: a row parked as a conflict: {}",
            queue_summary(db)
        );
        assert!(
            result.auth_outcome.is_none(),
            "pass {passes}: the terminal's credentials were refused"
        );

        if set_aside.is_none() {
            let z_sent = sim.lock().expect("the admin API").z_submissions.len();
            if z_sent >= (REFUSED_DAY - 1) as usize {
                if let Some(queue_id) = refused_payment_waits_for_a_manager(db, &refused_payment_id)
                {
                    assert_eq!(
                        z_sent,
                        (REFUSED_DAY - 1) as usize,
                        "a Z of the refused payment's window or later reached the server while it held"
                    );
                    set_aside_like_the_manager(db, &queue_id);
                    set_aside = Some((queue_id, z_sent));
                }
            }
        }

        let remaining = pending_rows(db);
        if remaining == 0 {
            assert!(
                set_aside.is_some(),
                "the queue drained, yet the refused payment never held a Z: {}",
                queue_summary(db)
            );
            break;
        }
        assert!(
            passes < MAX_PASSES,
            "the reconnection did not drain in {MAX_PASSES} passes: {}",
            queue_summary(db)
        );
        park_waiting_rows(db, sim, &mut parked);
        advance_the_clock(db, sim, &parked);
    }
    let (set_aside_queue_id, z_before_set_aside) = set_aside.expect("the set-aside");
    let finished_ms = sim.lock().expect("the admin API").now_ms;
    Drain {
        passes,
        set_aside_queue_id,
        z_before_set_aside,
        finished_ms,
    }
}

/// The refused payment's queue row once everything else but the Zs went
/// out: what Health then shows a manager.
fn refused_payment_waits_for_a_manager(db: &DbState, payment_id: &str) -> Option<String> {
    let conn = db.conn.lock().expect("lock the database");
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, status FROM parity_sync_queue
             WHERE table_name = 'payments' AND record_id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .expect("read the refused payment's row");
    let (queue_id, status) = row?;
    if status != "failed" {
        return None;
    }
    let others: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue
             WHERE status IN ('pending', 'processing') AND table_name <> 'z_reports'",
            [],
            |row| row.get(0),
        )
        .expect("count the rows still going out");
    (others == 0).then_some(queue_id)
}

/// `recovery_z_gate_set_aside` after its approval: Health lists the refused
/// row and the Z it holds, then the command's own core
/// (`commands::diagnostics::apply_z_gate_set_aside`) checks the row again,
/// sets it aside and refreshes the waiting Zs.
fn set_aside_like_the_manager(db: &DbState, queue_id: &str) {
    let conn = db.conn.lock().expect("lock the database");
    let health = crate::zreport::local_z_health(&conn).expect("Health: the Z gates");
    let refused = health["refused"].as_array().cloned().unwrap_or_default();
    let listed = refused
        .iter()
        .find(|row| row["queueId"] == queue_id)
        .unwrap_or_else(|| panic!("Health lists the refused payment: {health}"));
    assert!(
        listed["errorCode"]
            .as_str()
            .is_some_and(|code| code.starts_with("HTTP_422")),
        "the server's refusal is shown: {listed}"
    );
    assert_eq!(listed["setAside"], false, "{listed}");
    assert_eq!(
        health["localZs"][0]["waitsFor"], "window_rows",
        "the day-{REFUSED_DAY} Z waits for the money of its window: {health}"
    );
    assert_eq!(
        health["localZs"][1]["waitsFor"], "earlier_z",
        "the next Z waits for it: {health}"
    );
    let after =
        crate::commands::diagnostics::apply_z_gate_set_aside(&conn, queue_id, MANAGER_ID, false)
            .expect("set the refused payment aside");
    assert_eq!(after["applied"], "set_aside", "{after}");
    assert_eq!(after["queueId"], queue_id, "{after}");
    let listed = after["refused"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["queueId"] == queue_id))
        .unwrap_or_else(|| panic!("Health still lists the row, set aside: {after}"));
    assert_eq!(listed["setAside"], true, "{listed}");
}

fn pending_rows(db: &DbState) -> i64 {
    db.conn
        .lock()
        .expect("lock the database")
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status IN ('pending', 'processing')",
            [],
            |row| row.get(0),
        )
        .expect("count the rows still going out")
}

/// Rows the queue scheduled for later (a backoff, a wait for a parent): due
/// at the virtual time it chose, `(stored next_retry_at, virtual due)`.
fn park_waiting_rows(
    db: &DbState,
    sim: &Arc<Mutex<SimServer>>,
    parked: &mut HashMap<String, (String, u64)>,
) {
    let now_ms = sim.lock().expect("the admin API").now_ms;
    let wall = Utc::now();
    let rows: Vec<(String, String)> = {
        let conn = db.conn.lock().expect("lock the database");
        let mut statement = conn
            .prepare(
                "SELECT id, next_retry_at FROM parity_sync_queue
                 WHERE status = 'pending' AND next_retry_at IS NOT NULL
                   AND julianday(next_retry_at) > julianday('now')",
            )
            .expect("prepare the waiting rows");
        let waiting = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query the waiting rows")
            .collect::<Result<Vec<(String, String)>, _>>()
            .expect("read the waiting rows");
        waiting
    };
    let waiting: HashSet<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
    parked.retain(|id, _| waiting.contains(id.as_str()));
    for (id, next_retry_at) in &rows {
        if parked
            .get(id)
            .is_some_and(|(stored, _)| stored == next_retry_at)
        {
            continue;
        }
        let wait_ms = DateTime::parse_from_rfc3339(next_retry_at)
            .map(|at| (at.with_timezone(&Utc) - wall).num_milliseconds().max(0) as u64)
            .unwrap_or(0);
        parked.insert(id.clone(), (next_retry_at.clone(), now_ms + wait_ms));
    }
}

fn release_parked_rows(
    db: &DbState,
    sim: &Arc<Mutex<SimServer>>,
    parked: &mut HashMap<String, (String, u64)>,
) {
    let now_ms = sim.lock().expect("the admin API").now_ms;
    let due: Vec<(String, String)> = parked
        .iter()
        .filter(|(_, (_, due_ms))| *due_ms <= now_ms)
        .map(|(id, (stored, _))| (id.clone(), stored.clone()))
        .collect();
    if due.is_empty() {
        return;
    }
    let conn = db.conn.lock().expect("lock the database");
    let past = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
    for (id, stored) in due {
        conn.execute(
            "UPDATE parity_sync_queue SET next_retry_at = ?1
             WHERE id = ?2 AND status = 'pending' AND next_retry_at = ?3",
            params![past, id, stored],
        )
        .expect("release a row whose virtual wait is over");
        parked.remove(&id);
    }
}

/// The background loop runs every 15 s; with nothing due before the next
/// scheduled row, the clock jumps to it.
fn advance_the_clock(
    db: &DbState,
    sim: &Arc<Mutex<SimServer>>,
    parked: &HashMap<String, (String, u64)>,
) {
    let due_now: i64 = db
        .conn
        .lock()
        .expect("lock the database")
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue
             WHERE status = 'pending'
               AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday('now'))",
            [],
            |row| row.get(0),
        )
        .expect("count the due rows");
    let mut sim = sim.lock().expect("the admin API");
    sim.now_ms += PASS_INTERVAL_MS;
    if due_now == 0 {
        if let Some(next) = parked.values().map(|(_, due_ms)| *due_ms).min() {
            sim.now_ms = sim.now_ms.max(next);
        }
    }
}

fn queue_summary(db: &DbState) -> String {
    let conn = db.conn.lock().expect("lock the database");
    let mut statement = conn
        .prepare(
            "SELECT table_name, operation, status, COALESCE(substr(error_message, 1, 80), ''),
                    COUNT(*)
             FROM parity_sync_queue
             GROUP BY 1, 2, 3, 4
             ORDER BY 5 DESC
             LIMIT 25",
        )
        .expect("prepare the queue summary");
    let rows = statement
        .query_map([], |row| {
            Ok(format!(
                "{} {} {} [{}] x{}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?
            ))
        })
        .expect("query the queue summary")
        .collect::<Result<Vec<_>, _>>()
        .expect("read the queue summary");
    rows.join("; ")
}

fn period_end_of(report: &Value) -> Option<String> {
    ["/period/end", "/periodEnd", "/period_end"]
        .iter()
        .find_map(|pointer| report.pointer(pointer).and_then(Value::as_str))
        .map(str::to_string)
}

fn same_instant(left: &str, right: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(left),
        DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// One stored Z, in window order.
struct LocalZ {
    report_date: String,
    window_cutoff: String,
    close_state: String,
    sync_state: String,
    closed_order_client_ids: BTreeSet<String>,
}

fn assert_reconnection(
    db: &DbState,
    sim: &Arc<Mutex<SimServer>>,
    week: &Week,
    drain: &Drain,
    morning_shift: &str,
) {
    let refused_payment_id = week
        .refused_payment_id
        .clone()
        .expect("the refused payment");
    let refused_order_id = week.refused_order_id.clone().expect("the refused order");
    let sim = sim.lock().expect("the admin API");
    let conn = db.conn.lock().expect("lock the database");
    if !sim.other.is_empty() {
        eprintln!(
            "offline week: requests the simulation answered generically: {:?}",
            sim.other
        );
    }
    assert!(
        sim.transient_served,
        "the day-{TRANSIENT_DAY} cashier close met its 503"
    );

    // Every row reached the server except the refused payment, which stays
    // on the till, set aside, never sent again.
    let left: Vec<(String, String, String, String)> = {
        let mut statement = conn
            .prepare("SELECT id, table_name, record_id, status FROM parity_sync_queue")
            .expect("prepare the queue read");
        let rows = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("query the queue")
            .collect::<Result<Vec<_>, _>>()
            .expect("read the queue");
        rows
    };
    assert_eq!(
        left.len(),
        1,
        "only the set-aside row stays queued: {left:?}"
    );
    assert_eq!(left[0].0, drain.set_aside_queue_id);
    assert_eq!(left[0].1, "payments");
    assert_eq!(left[0].2, refused_payment_id);
    assert_eq!(left[0].3, "failed", "a set-aside row keeps its status");
    let listed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_set_aside WHERE queue_id = ?1",
            params![drain.set_aside_queue_id],
            |row| row.get(0),
        )
        .expect("read the set-aside listing");
    assert_eq!(listed, 1);
    let total_orders = week.orders + MORNING_ORDERS as usize;
    assert_eq!(
        sim.orders.len(),
        total_orders,
        "every order reached the server"
    );
    assert_eq!(sim.duplicate_orders, 0, "no order was sent twice");
    assert_eq!(
        sim.accepted_payments.len(),
        total_orders - 1,
        "every payment but the refused one reached the server"
    );
    assert_eq!(sim.duplicate_payments, 0, "no payment was sent twice");
    assert_eq!(
        sim.refused_payment_requests, 1,
        "a payment refused for good is not sent again"
    );
    assert_eq!(sim.earnings.len(), week.deliveries, "every driver earning");
    eprintln!(
        "offline week: {} requests, {} order updates (a delivery assignment the order's own \
         create already carried is consumed locally)",
        sim.requests, sim.order_updates
    );
    assert!(
        drain.finished_ms <= DRAIN_LIMIT_MS,
        "the reconnection took {:.1} virtual minutes",
        drain.finished_ms as f64 / 60_000.0
    );

    // Ω4: the manager's set-aside released the Zs.
    assert_eq!(
        drain.z_before_set_aside,
        (REFUSED_DAY - 1) as usize,
        "only the Zs before the refused payment's window went out before the set-aside"
    );

    // Ω3: seven Zs, in window order, each with its own date and the client
    // ids of exactly its own orders, each order on the server before its Z.
    let local: Vec<LocalZ> = {
        let mut statement = conn
            .prepare(
                "SELECT report_date, COALESCE(window_cutoff, ''), COALESCE(close_state, ''),
                        COALESCE(sync_state, ''), COALESCE(closed_order_client_ids, '[]')
                 FROM z_reports ORDER BY julianday(window_cutoff) ASC",
            )
            .expect("prepare the Z read");
        let rows = statement
            .query_map([], |row| {
                let ids: String = row.get(4)?;
                Ok(LocalZ {
                    report_date: row.get(0)?,
                    window_cutoff: row.get(1)?,
                    close_state: row.get(2)?,
                    sync_state: row.get(3)?,
                    closed_order_client_ids: serde_json::from_str::<Vec<String>>(&ids)
                        .unwrap_or_default()
                        .into_iter()
                        .collect(),
                })
            })
            .expect("query the Zs")
            .collect::<Result<Vec<_>, _>>()
            .expect("read the Zs");
        rows
    };
    assert_eq!(local.len(), DAYS as usize, "one Z per day");
    assert_eq!(
        sim.z_submissions.len(),
        DAYS as usize,
        "exactly seven Z submissions"
    );
    let mut previous_date: Option<NaiveDate> = None;
    let mut previous_end: Option<DateTime<chrono::FixedOffset>> = None;
    for (index, ((arrival, body), stored)) in sim.z_submissions.iter().zip(&local).enumerate() {
        let day = index + 1;
        let report = &body["report_data"];
        assert_eq!(body["terminal_id"], TERMINAL_ID, "Z {day}");
        assert_eq!(
            body["report_date"],
            stored.report_date.as_str(),
            "Z {day} arrived in window order"
        );
        let end = period_end_of(report).unwrap_or_else(|| panic!("Z {day} names its window"));
        assert!(
            same_instant(&end, &stored.window_cutoff),
            "Z {day}: sent window end {end}, stored {}",
            stored.window_cutoff
        );
        let end = DateTime::parse_from_rfc3339(&end).expect("an RFC 3339 window end");
        assert!(
            previous_end.is_none_or(|previous| previous < end),
            "Z {day} arrived after a later window"
        );
        previous_end = Some(end);
        let date = NaiveDate::parse_from_str(&stored.report_date, "%Y-%m-%d")
            .unwrap_or_else(|error| panic!("Z {day} report date: {error}"));
        assert!(
            previous_date.is_none_or(|previous| previous < date),
            "Z {day} has its own report date: {date} after {previous_date:?}"
        );
        previous_date = Some(date);

        let closed: BTreeSet<String> = report["closedOrderClientIds"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(
            closed, week.client_ids[index],
            "Z {day} lists exactly its orders"
        );
        assert_eq!(
            stored.closed_order_client_ids, closed,
            "Z {day}: the stored Z is what the server got"
        );
        for id in &closed {
            let order_arrival =
                sim.orders.get(id).copied().unwrap_or_else(|| {
                    panic!("Z {day} lists {id}, which never reached the server")
                });
            assert!(
                order_arrival < *arrival,
                "Z {day} reached the server before its order {id}"
            );
        }
        let not_on_server = report["notOnServer"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if day as u32 == REFUSED_DAY {
            assert!(
                not_on_server
                    .iter()
                    .any(|entry| entry["recordId"] == refused_payment_id.as_str()),
                "Z {day} lists the set-aside payment as not on the server: {report}"
            );
        } else {
            assert!(not_on_server.is_empty(), "Z {day}: {not_on_server:?}");
        }
        assert_eq!(stored.sync_state, "applied", "Z {day} confirmed");
        assert_eq!(stored.close_state, "swept", "Z {day}'s window was swept");
    }

    // The sweeps left only what came after the 7th Z, and the set-aside
    // record with its order.
    let cutoff = local
        .last()
        .map(|z| z.window_cutoff.clone())
        .expect("the 7th Z");
    let floor = crate::db::get_setting(
        &conn,
        "system",
        crate::business_day::LAST_CONFIRMED_Z_CUTOFF_KEY,
    )
    .expect("the deletion floor");
    assert!(
        same_instant(&floor, &cutoff),
        "the deletion floor {floor} is the 7th Z's cutoff {cutoff}"
    );
    let count = |sql: &str, first: &str, second: &str| -> i64 {
        conn.query_row(sql, params![first, second], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    };
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM orders
             WHERE julianday(created_at) <= julianday(?1) AND id <> ?2",
            cutoff.as_str(),
            refused_order_id.as_str()
        ),
        0,
        "no order of a confirmed window is left but the set-aside one"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM orders
             WHERE julianday(created_at) > julianday(?1) AND id <> ?2",
            cutoff.as_str(),
            refused_order_id.as_str()
        ),
        i64::from(MORNING_ORDERS),
        "day 8's orders stay"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM orders WHERE id = ?1 AND ?2 <> ''",
            refused_order_id.as_str(),
            "kept"
        ),
        1,
        "the set-aside payment keeps its order"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM order_payments
             WHERE julianday(created_at) <= julianday(?1) AND id <> ?2",
            cutoff.as_str(),
            refused_payment_id.as_str()
        ),
        0,
        "no payment of a confirmed window is left but the set-aside one"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM order_payments WHERE id = ?1 AND ?2 <> ''",
            refused_payment_id.as_str(),
            "kept"
        ),
        1,
        "the set-aside payment is never deleted"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM driver_earnings
             WHERE julianday(created_at) <= julianday(?1) AND order_id <> ?2",
            cutoff.as_str(),
            refused_order_id.as_str()
        ),
        0,
        "no earning of a confirmed window is left"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM staff_shifts
             WHERE julianday(check_in_time) <= julianday(?1) AND id <> ?2",
            cutoff.as_str(),
            morning_shift
        ),
        0,
        "no shift of a confirmed window is left"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM staff_shifts WHERE id = ?1 AND status = ?2",
            morning_shift,
            "active"
        ),
        1,
        "day 8's cashier is still checked in"
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM cash_drawer_sessions
             WHERE julianday(COALESCE(closed_at, opened_at, created_at)) <= julianday(?1)
               AND staff_shift_id <> ?2",
            cutoff.as_str(),
            morning_shift
        ),
        0,
        "no drawer of a confirmed window is left"
    );

    // Health: nothing waits, the set-aside record is listed as such.
    let health = crate::zreport::local_z_health(&conn).expect("Health: the Z gates");
    assert_eq!(health["unconfirmedLocalZs"], 0, "{health}");
    let refused = health["refused"].as_array().cloned().unwrap_or_default();
    assert!(
        refused
            .iter()
            .any(|row| row["queueId"] == drain.set_aside_queue_id.as_str()
                && row["setAside"] == true),
        "Health lists the set-aside payment: {health}"
    );

    // Ω1, last so every other check above has run: each person's chain
    // reached the server in order (open, close, open, ...), none refused and
    // none held for an earlier shift. A shift's opening carries the
    // `offline_check_in` marker the server re-checks; a close that overtakes
    // it makes the server record the shift closed and answer the opening
    // `skipped`, so that re-check never runs.
    assert!(
        sim.closes_before_open.is_empty(),
        "a shift's close reached the server before its own opening: {:?}",
        sim.closes_before_open
    );
    assert_eq!(
        sim.predecessor_waits, 0,
        "an opening reached the server before the person's earlier close"
    );
    let mut per_person: HashMap<&str, Vec<(&str, &str)>> = HashMap::new();
    for (staff, event, shift) in &sim.shift_events {
        per_person
            .entry(staff.as_str())
            .or_default()
            .push((event.as_str(), shift.as_str()));
    }
    for staff in std::iter::once(CASHIER_ID).chain(DRIVER_IDS) {
        let events = per_person.get(staff).cloned().unwrap_or_default();
        let expected = if staff == CASHIER_ID {
            2 * DAYS as usize + 1
        } else {
            2 * DAYS as usize
        };
        assert_eq!(events.len(), expected, "{staff}: {events:?}");
        for pair in events.chunks(2) {
            assert_eq!(pair[0].0, "shift_open", "{staff}: {events:?}");
            if let Some(close) = pair.get(1) {
                assert_eq!(close.0, "shift_close", "{staff}: {events:?}");
                assert_eq!(
                    close.1, pair[0].1,
                    "{staff}: a shift closes before the next opens"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The day change itself
// ---------------------------------------------------------------------------

/// The scaffolding the week relies on: dates move one day back wherever they
/// are stored, times, formats and the epoch sentinel stay, and the triggers
/// and constraints come back.
#[test]
fn a_day_passing_moves_every_stored_date_one_day_back() {
    assert_eq!(
        shift_dates_back_one_day("2026-10-22T08:15:00.123456789+00:00").as_deref(),
        Some("2026-10-21T08:15:00.123456789+00:00")
    );
    assert_eq!(
        shift_dates_back_one_day("2026-03-01").as_deref(),
        Some("2026-02-28")
    );
    assert_eq!(
        shift_dates_back_one_day(r#"{"a":"2026-10-01T00:00:00Z","b":"1970-01-01T00:00:00Z","c":"Ωμέγα 2026-01-01 08:00"}"#)
            .as_deref(),
        Some(r#"{"a":"2026-09-30T00:00:00Z","b":"1970-01-01T00:00:00Z","c":"Ωμέγα 2025-12-31 08:00"}"#)
    );
    assert_eq!(shift_dates_back_one_day("1970-01-01T00:00:00Z"), None);
    assert_eq!(shift_dates_back_one_day("week-d2-o007"), None);
    assert_eq!(shift_dates_back_one_day("12026-10-22"), None);
    assert_eq!(shift_dates_back_one_day("2026-10-221"), None);

    let conn = Connection::open_in_memory().expect("open a database");
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE t (id INTEGER PRIMARY KEY, at TEXT, doc TEXT, n INTEGER,
                         CHECK (at IS NULL OR at >= '2000'));
         CREATE TABLE k (label TEXT PRIMARY KEY, day TEXT) WITHOUT ROWID;
         CREATE TRIGGER t_frozen BEFORE UPDATE ON t BEGIN SELECT RAISE(ABORT, 'frozen'); END;
         INSERT INTO t (at, doc, n) VALUES
             ('2026-10-22T08:00:00.5+00:00',
              '{\"at\":\"2026-10-01T00:00:00Z\",\"epoch\":\"1970-01-01T00:00:00Z\"}',
              20261022);
         INSERT INTO k (label, day) VALUES ('z:2026-03-01T00:00:00Z|2026-03-02T00:00:00Z', '2026-03-01');",
    )
    .expect("seed the tables");
    let db = DbState {
        conn: Mutex::new(conn),
        db_path: std::path::PathBuf::from(":memory:"),
    };
    one_day_passes(&db);
    let conn = db.conn.lock().expect("lock the database");
    let (at, doc, n): (String, String, i64) = conn
        .query_row("SELECT at, doc, n FROM t", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .expect("read t");
    assert_eq!(at, "2026-10-21T08:00:00.5+00:00");
    assert_eq!(
        doc,
        r#"{"at":"2026-09-30T00:00:00Z","epoch":"1970-01-01T00:00:00Z"}"#
    );
    assert_eq!(n, 20261022, "numbers are not dates");
    let (label, day): (String, String) = conn
        .query_row("SELECT label, day FROM k", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("read k");
    assert_eq!(label, "z:2026-02-28T00:00:00Z|2026-03-01T00:00:00Z");
    assert_eq!(day, "2026-02-28");
    assert!(
        conn.execute("UPDATE t SET n = 1", []).is_err(),
        "the trigger is back"
    );
    let foreign_keys: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .expect("read foreign_keys");
    assert_eq!(foreign_keys, 1, "foreign keys are back on");
}
