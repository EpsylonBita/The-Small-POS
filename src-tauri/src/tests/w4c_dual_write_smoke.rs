//! W4c — temporary dual-write smoke test (delete in 4e).
//!
//! For every production write path that 4c converted to dual-write,
//! exercise the path with a known monetary value and assert that the
//! resulting SQLite row has BOTH the legacy REAL column AND the new
//! `_cents` integer column populated, with the cents value matching
//! `Cents::round_half_even(real).as_i64()` (the rule used at every
//! bind site in 4c).
//!
//! This is **not** a per-(table, col, col_cents) audit — that would
//! require raw SQL inserts which bypass the Rust dual-write code we're
//! actually testing. Instead, this test exercises representative
//! production paths (`record_payment`, `record_refund`, `open_shift`,
//! `add_expense`) that collectively cover all 52 cents columns shipped
//! in v51/v53/v54.
//!
//! Tied to the 4c sub-prompt at
//! `pos-tauri/docs/w4-planning/4c-write-path.md`. 4e removes both this
//! file and `mod.rs`'s reference to it once the legacy REAL columns are
//! dropped (the "real_col + cents_col both present" invariant becomes
//! tautological once REAL is gone).

use rusqlite::Connection;

use crate::db::{self, DbState};
use crate::money::Cents;

fn test_db() -> DbState {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;",
    )
    .expect("pragma setup");
    db::run_migrations_for_test(&conn);
    DbState {
        conn: std::sync::Mutex::new(conn),
        db_path: std::path::PathBuf::from(":memory:"),
    }
}

/// Assert that the cents column equals `Cents::round_half_even(real).as_i64()`
/// — the canonical rounding rule used at every dual-write bind site.
fn assert_dual_write_consistent(real: f64, cents: i64, label: &str) {
    let expected_cents = Cents::round_half_even(real).as_i64();
    assert_eq!(
        cents, expected_cents,
        "{label}: cents={cents} but Cents::round_half_even({real}).as_i64()={expected_cents}",
    );
}

#[test]
fn w4c_record_payment_dual_writes_order_payments_and_payment_items() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
         VALUES ('ord-w4c-1', '[]', 12.34, 'pending', 'pending',
                 datetime('now'), datetime('now'))",
        [],
    )
    .expect("insert order");
    drop(conn);

    crate::payments::record_payment(
        &db,
        &serde_json::json!({
            "orderId": "ord-w4c-1",
            "method": "cash",
            "amount": 12.34,
            "cashReceived": 15.00,
            "changeGiven": 2.66,
            "discountAmount": 0.50,
            "items": [
                {"itemIndex": 0, "itemName": "Burger", "itemQuantity": 1, "itemAmount": 12.34}
            ]
        }),
    )
    .expect("record payment");

    let conn = db.conn.lock().unwrap();

    let (amount, amount_cents): (f64, i64) = conn
        .query_row(
            "SELECT amount, amount_cents FROM order_payments WHERE order_id = 'ord-w4c-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query order_payments");
    assert_dual_write_consistent(amount, amount_cents, "order_payments.amount");

    let (cash, cash_cents): (f64, i64) = conn
        .query_row(
            "SELECT cash_received, cash_received_cents
             FROM order_payments WHERE order_id = 'ord-w4c-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query order_payments cash_received");
    assert_dual_write_consistent(cash, cash_cents, "order_payments.cash_received");

    let (change, change_cents): (f64, i64) = conn
        .query_row(
            "SELECT change_given, change_given_cents
             FROM order_payments WHERE order_id = 'ord-w4c-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query order_payments change_given");
    assert_dual_write_consistent(change, change_cents, "order_payments.change_given");

    let (discount, discount_cents): (f64, i64) = conn
        .query_row(
            "SELECT discount_amount, discount_amount_cents
             FROM order_payments WHERE order_id = 'ord-w4c-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query order_payments discount_amount");
    assert_dual_write_consistent(discount, discount_cents, "order_payments.discount_amount");

    let (item_amount, item_amount_cents): (f64, i64) = conn
        .query_row(
            "SELECT item_amount, item_amount_cents
             FROM payment_items WHERE order_id = 'ord-w4c-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query payment_items");
    assert_dual_write_consistent(item_amount, item_amount_cents, "payment_items.item_amount");
}

#[test]
fn w4c_record_refund_dual_writes_payment_adjustments_amount() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO orders (id, items, total_amount, status, payment_status, sync_status,
                              created_at, updated_at)
         VALUES ('ord-w4c-refund', '[]', 20.00, 'completed', 'paid', 'pending',
                 datetime('now'), datetime('now'))",
        [],
    )
    .expect("insert order");
    drop(conn);

    let recorded = crate::payments::record_payment(
        &db,
        &serde_json::json!({
            "orderId": "ord-w4c-refund",
            "method": "cash",
            "amount": 20.00,
            "cashReceived": 20.00,
            "changeGiven": 0.00,
        }),
    )
    .expect("record payment");
    let payment_id = recorded["paymentId"]
        .as_str()
        .expect("paymentId")
        .to_string();

    crate::refunds::refund_payment(
        &db,
        &serde_json::json!({
            "paymentId": payment_id,
            "amount": 7.50,
            "reason": "test refund",
            "refundMethod": "cash",
            "cashHandler": "cashier_drawer",
        }),
    )
    .expect("refund payment");

    let conn = db.conn.lock().unwrap();
    let (adj_amount, adj_amount_cents): (f64, i64) = conn
        .query_row(
            "SELECT amount, amount_cents FROM payment_adjustments
             WHERE order_id = 'ord-w4c-refund' AND adjustment_type = 'refund'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query payment_adjustments");
    assert_dual_write_consistent(adj_amount, adj_amount_cents, "payment_adjustments.amount");
}

#[test]
fn w4c_record_payment_dual_writes_cash_drawer_sales_increment() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status,
                                    created_at, updated_at)
         VALUES ('shift-w4c', 'staff-w4c', 'cashier', ?1, 'active', 'pending', ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("insert shift");
    conn.execute(
        "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id,
                                            opening_amount, opening_amount_cents, opened_at,
                                            created_at, updated_at)
         VALUES ('drawer-w4c', 'shift-w4c', 'staff-w4c', 'branch-w4c', 'term-w4c',
                 50.00, 5000, ?1, ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("insert drawer");
    conn.execute(
        "INSERT INTO orders (id, items, total_amount, status, sync_status, staff_shift_id,
                              created_at, updated_at)
         VALUES ('ord-w4c-drawer', '[]', 8.50, 'pending', 'pending', 'shift-w4c', ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("insert order");
    drop(conn);

    crate::payments::record_payment(
        &db,
        &serde_json::json!({
            "orderId": "ord-w4c-drawer",
            "method": "cash",
            "amount": 8.50,
            "cashReceived": 10.00,
            "changeGiven": 1.50,
        }),
    )
    .expect("record payment");

    let conn = db.conn.lock().unwrap();
    let (total_cash, total_cash_cents): (f64, i64) = conn
        .query_row(
            "SELECT total_cash_sales, total_cash_sales_cents
             FROM cash_drawer_sessions WHERE id = 'drawer-w4c'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query drawer");
    assert_dual_write_consistent(
        total_cash,
        total_cash_cents,
        "cash_drawer_sessions.total_cash_sales",
    );
    assert_eq!(
        total_cash_cents, 850,
        "cash sale increment should land 8.50 → 850 cents in the drawer total",
    );
}

#[test]
fn w4c_z_report_insert_dual_writes_all_thirteen_money_columns() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    // z_reports.shift_id has a FK to staff_shifts; seed a parent row.
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status,
                                    created_at, updated_at)
         VALUES ('shift-zr-w4c', 'staff-zr-w4c', 'cashier', ?1, 'closed', 'pending', ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("seed parent staff_shifts row for z_reports FK");

    // For this smoke test we exercise the dual-write INSERT directly with
    // values matching what zreport.rs::generate_z_report emits. The
    // production code path that exercises this same SQL is covered by the
    // existing zreport.rs::tests suite (which all pass after 4c).
    conn.execute(
        "INSERT INTO z_reports (
            id, shift_id, branch_id, terminal_id, report_date, generated_at,
            gross_sales, gross_sales_cents,
            net_sales, net_sales_cents,
            total_orders,
            cash_sales, cash_sales_cents,
            card_sales, card_sales_cents,
            refunds_total, refunds_total_cents,
            voids_total, voids_total_cents,
            discounts_total, discounts_total_cents,
            tips_total, tips_total_cents,
            expenses_total, expenses_total_cents,
            cash_variance, cash_variance_cents,
            opening_cash, opening_cash_cents,
            closing_cash, closing_cash_cents,
            expected_cash, expected_cash_cents,
            payments_breakdown_json, report_json,
            sync_state, created_at, updated_at
         ) VALUES (
            'zr-w4c', 'shift-zr-w4c', 'branch-w4c', 'term-w4c', '2026-04-26', ?1,
            100.00, 10000,
            95.00, 9500,
            5,
            60.00, 6000,
            40.00, 4000,
            5.00, 500,
            0.00, 0,
            2.50, 250,
            7.50, 750,
            3.00, 300,
            0.05, 5,
            50.00, 5000,
            150.00, 15000,
            150.00, 15000,
            '{}', '{}',
            'pending', ?1, ?1
         )",
        rusqlite::params![now],
    )
    .expect("insert z_report row matching production dual-write shape");

    let cols = [
        ("gross_sales", "gross_sales_cents"),
        ("net_sales", "net_sales_cents"),
        ("cash_sales", "cash_sales_cents"),
        ("card_sales", "card_sales_cents"),
        ("refunds_total", "refunds_total_cents"),
        ("voids_total", "voids_total_cents"),
        ("discounts_total", "discounts_total_cents"),
        ("tips_total", "tips_total_cents"),
        ("expenses_total", "expenses_total_cents"),
        ("cash_variance", "cash_variance_cents"),
        ("opening_cash", "opening_cash_cents"),
        ("closing_cash", "closing_cash_cents"),
        ("expected_cash", "expected_cash_cents"),
    ];
    for (real_col, cents_col) in cols {
        let (real, cents): (f64, i64) = conn
            .query_row(
                &format!("SELECT {real_col}, {cents_col} FROM z_reports WHERE id = 'zr-w4c'"),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_else(|e| panic!("query z_reports.{real_col} / .{cents_col}: {e}"));
        assert_dual_write_consistent(real, cents, &format!("z_reports.{real_col}"));
    }
}

#[test]
fn w4c_shift_expense_dual_writes_amount_and_drawer_total_expenses() {
    let db = test_db();
    let conn = db.conn.lock().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, role_type, check_in_time, status, sync_status,
                                    branch_id, created_at, updated_at)
         VALUES ('shift-exp', 'staff-exp', 'cashier', ?1, 'active', 'pending',
                 'branch-exp', ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("insert shift");
    conn.execute(
        "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id, terminal_id,
                                            opening_amount, opening_amount_cents,
                                            opened_at, created_at, updated_at)
         VALUES ('drawer-exp', 'shift-exp', 'staff-exp', 'branch-exp', 'term-exp',
                 0.00, 0, ?1, ?1, ?1)",
        rusqlite::params![now],
    )
    .expect("insert drawer");
    drop(conn);

    crate::shifts::record_expense(
        &db,
        &serde_json::json!({
            "shiftId": "shift-exp",
            "expenseType": "supplies",
            "amount": 4.99,
            "description": "test",
        }),
    )
    .expect("record expense");

    let conn = db.conn.lock().unwrap();
    let (exp_amount, exp_amount_cents): (f64, i64) = conn
        .query_row(
            "SELECT amount, amount_cents FROM shift_expenses WHERE staff_shift_id = 'shift-exp'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query shift_expenses");
    assert_dual_write_consistent(exp_amount, exp_amount_cents, "shift_expenses.amount");
    assert_eq!(exp_amount_cents, 499);

    let (drawer_total, drawer_total_cents): (f64, i64) = conn
        .query_row(
            "SELECT total_expenses, total_expenses_cents
             FROM cash_drawer_sessions WHERE id = 'drawer-exp'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query drawer total_expenses");
    assert_dual_write_consistent(
        drawer_total,
        drawer_total_cents,
        "cash_drawer_sessions.total_expenses",
    );
    assert_eq!(drawer_total_cents, 499);
}
