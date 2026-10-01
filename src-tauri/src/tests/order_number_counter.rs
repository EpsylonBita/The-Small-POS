//! The till's order numbers (`ORD-DDMMYYYY-NNNNN`) never restart after a
//! failed or unparsable counter read (item G, fix review 30/09/2026; Android
//! parity, "never restart satellite display numbers after a failed counter
//! read").
//!
//! Symptom: `next_order_number` turned a counter read error, or a stored
//! value that is not a count, into 0 (`.unwrap_or(0)`); the write then saved
//! 1 over the stored counter and `ORD-DDMMYYYY-00001` repeated within the day.

use chrono::{Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection};

use crate::tests::harness::TestDb;

const TERMINAL: &str = "terminal-numbers";

fn today() -> String {
    chrono::Local::now().format("%d%m%Y").to_string()
}

fn number(sequence: i64) -> String {
    format!("ORD-{}-{:05}", today(), sequence)
}

fn at(offset: Duration) -> String {
    (Utc::now() + offset).to_rfc3339_opts(SecondsFormat::Secs, false)
}

fn seed_order(conn: &Connection, id: &str, order_number: &str, terminal: &str, created_at: &str) {
    conn.execute(
        "INSERT INTO orders (id, order_number, display_order_number, items, total_amount,
            total_amount_cents, status, order_type, payment_status, sync_status, terminal_id,
            created_at, updated_at)
         VALUES (?1, ?2, ?2, '[]', 5.0, 500, 'completed', 'takeaway', 'pending', 'synced', ?3,
                 ?4, ?4)",
        params![id, order_number, terminal, created_at],
    )
    .expect("seed an order");
}

fn set_counter(conn: &Connection, value: &str) {
    crate::db::set_setting(conn, "orders", "order_counter", value).expect("seed the counter");
}

fn stored_counter(conn: &Connection) -> Option<String> {
    crate::db::get_setting(conn, "orders", "order_counter")
}

/// The day's orders of this terminal, numbered up to 41.
fn seed_the_day(conn: &Connection) {
    seed_order(
        conn,
        "order-day-40",
        &number(40),
        TERMINAL,
        &at(-Duration::minutes(20)),
    );
    seed_order(
        conn,
        "order-day-41",
        &number(41),
        TERMINAL,
        &at(-Duration::minutes(10)),
    );
}

#[test]
fn an_unparsable_counter_continues_after_the_days_highest_number_and_is_left_alone() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_the_day(&conn);
    set_counter(&conn, "garbled");

    let minted = crate::sync::next_order_number(&conn, TERMINAL).expect("a number");

    assert_eq!(minted, number(42), "never ORD-…-00001 again");
    assert_eq!(
        stored_counter(&conn).as_deref(),
        Some("garbled"),
        "its value is unknown: left alone"
    );
}

#[test]
fn a_counter_that_cannot_be_read_continues_after_the_days_highest_number() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_the_day(&conn);
    set_counter(&conn, "57");
    // The read itself fails (the settings table is gone), not the value.
    conn.execute_batch("ALTER TABLE local_settings RENAME TO local_settings_unreadable")
        .unwrap();

    let minted = crate::sync::next_order_number(&conn, TERMINAL).expect("a number");

    assert_eq!(minted, number(42));
    conn.execute_batch("ALTER TABLE local_settings_unreadable RENAME TO local_settings")
        .unwrap();
    assert_eq!(stored_counter(&conn).as_deref(), Some("57"), "left alone");
}

#[test]
fn no_number_is_minted_when_neither_the_counter_nor_the_days_numbers_can_be_read() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_the_day(&conn);
    conn.execute_batch(
        "ALTER TABLE local_settings RENAME TO local_settings_unreadable;
         ALTER TABLE orders RENAME TO orders_unreadable;",
    )
    .unwrap();

    let refused = crate::sync::next_order_number(&conn, TERMINAL)
        .expect_err("no number rather than a repeated one");

    assert!(refused.contains("No number was issued"), "{refused}");
}

#[test]
fn a_readable_counter_counts_on_ahead_of_the_days_numbers() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_the_day(&conn);

    set_counter(&conn, "57");
    assert_eq!(
        crate::sync::next_order_number(&conn, TERMINAL).unwrap(),
        number(58)
    );
    assert_eq!(stored_counter(&conn).as_deref(), Some("58"));

    // A counter behind the day's numbers never mints one of them again.
    seed_order(
        &conn,
        "order-day-60",
        &number(60),
        TERMINAL,
        &at(-Duration::minutes(5)),
    );
    set_counter(&conn, "3");
    assert_eq!(
        crate::sync::next_order_number(&conn, TERMINAL).unwrap(),
        number(61)
    );
    assert_eq!(stored_counter(&conn).as_deref(), Some("61"));
}

#[test]
fn after_a_z_the_numbering_restarts_and_other_terminals_never_move_it() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    // The previous day, closed by the Z an hour ago.
    seed_order(
        &conn,
        "order-closed",
        &number(120),
        TERMINAL,
        &at(-Duration::hours(3)),
    );
    crate::db::set_setting(
        &conn,
        "system",
        "last_z_report_timestamp",
        &at(-Duration::hours(1)),
    )
    .unwrap();
    set_counter(&conn, "0");
    // Another till's number mirrored here.
    seed_order(
        &conn,
        "order-other-till",
        &number(90),
        "terminal-other",
        &at(-Duration::minutes(5)),
    );

    assert_eq!(
        crate::sync::next_order_number(&conn, TERMINAL).unwrap(),
        number(1)
    );
    assert_eq!(stored_counter(&conn).as_deref(), Some("1"));
}
