//! Changing the driver of a delivery (founder request, Tomikro 26/10/2026).
//!
//! Symptom: the cashier picked the wrong driver; the order went to the
//! delivered list and another driver carried it. Nothing could correct it:
//! the delivered tab lost its "change driver" action in 1.4.40 and the
//! order's Edit options had no driver.
//!
//! `commands::orders::change_order_driver_locally` moves the order and its
//! driver money (the earning, the receipts' courier custody, a delivery tip)
//! to the driver who carried it, while both shifts are open, without creating
//! or losing a cent, audited and queued for the server.

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::commands::orders::{
    change_order_driver_locally, plan_driver_change, DriverChangeActor,
    DRIVER_CHANGE_ADJUSTED_ORDER, DRIVER_CHANGE_CANCELLED, DRIVER_CHANGE_NEW_DRIVER_OFF_SHIFT,
    DRIVER_CHANGE_SAME_DRIVER, DRIVER_CHANGE_SHIFT_CLOSED,
};
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const BRANCH: &str = "b7a2c400-0000-4000-8000-0000000000c1";
const TERMINAL: &str = "7e57a11a-0000-4000-8000-0000000000c1";
const ORGANIZATION: &str = "0a9e0000-0000-4000-8000-0000000000c1";
const CASHIER_SHIFT: &str = "shift-change-cashier";
const WRONG_DRIVER: &str = "d0000000-0000-4000-8000-0000000000a1";
const WRONG_SHIFT: &str = "shift-change-wrong-driver";
const RIGHT_DRIVER: &str = "d0000000-0000-4000-8000-0000000000b2";
const RIGHT_SHIFT: &str = "shift-change-right-driver";
const OPENING: f64 = 20.0;
const NOW: &str = "2026-10-26T12:00:00Z";

fn keyring() -> fake_keyring::Guard {
    fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("branch_id", BRANCH),
        ("organization_id", ORGANIZATION),
    ])
}

fn seed_shift(conn: &Connection, id: &str, staff: &str, name: &str, role: &str, opening: f64) {
    conn.execute(
        "INSERT INTO staff_shifts (id, staff_id, staff_name, role_type, branch_id, terminal_id,
            check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, calculation_version, sync_status, created_at, updated_at, currency)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-10-26T08:00:00Z', ?7, ?8,
            'active', 2, 'pending', '2026-10-26T08:00:00Z', '2026-10-26T08:00:00Z', 'EUR')",
        params![
            id,
            staff,
            name,
            role,
            BRANCH,
            TERMINAL,
            opening,
            (opening * 100.0).round() as i64
        ],
    )
    .expect("seed a shift");
}

fn seed_till(conn: &Connection) {
    for (category, key, value) in [
        ("terminal", "terminal_id", TERMINAL),
        ("terminal", "branch_id", BRANCH),
        ("terminal", "organization_id", ORGANIZATION),
        ("restaurant", "store_currency_branch_id", BRANCH),
        ("restaurant", "store_currency_available", "true"),
        ("restaurant", "store_currency_source", "branch_country"),
        ("restaurant", "currency", "EUR"),
    ] {
        crate::db::set_setting(conn, category, key, value).unwrap();
    }
    seed_shift(
        conn,
        CASHIER_SHIFT,
        "cashier-change",
        "Cashier",
        "cashier",
        100.0,
    );
    conn.execute(
        "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
            terminal_id, opening_amount, opening_amount_cents,
            opened_at, created_at, updated_at, currency)
         VALUES ('drawer-change', ?1, 'cashier-change', ?2, ?3, 100.0, 10000,
            '2026-10-26T08:00:00Z', '2026-10-26T08:00:00Z', '2026-10-26T08:00:00Z', 'EUR')",
        params![CASHIER_SHIFT, BRANCH, TERMINAL],
    )
    .expect("cashier drawer");
    seed_shift(conn, WRONG_SHIFT, WRONG_DRIVER, "Nikos", "driver", OPENING);
    seed_shift(
        conn,
        RIGHT_SHIFT,
        RIGHT_DRIVER,
        "Giorgos",
        "driver",
        OPENING,
    );
}

/// A 15.00 delivery (2.00 fee, 1.00 tip), paid 15.00 in cash on delivery.
fn seed_cash_delivery(conn: &Connection, order_id: &str) {
    conn.execute(
        "INSERT INTO orders (
             id, order_number, items, order_type, total_amount, total_amount_cents,
             tip_amount, tip_amount_cents, delivery_fee, delivery_fee_cents,
             status, payment_status, sync_status, branch_id, terminal_id,
             staff_shift_id, created_at, updated_at, currency
         ) VALUES (?1, ?1, '[]', 'delivery', 15.0, 1500, 1.0, 100, 2.0, 200,
                   'ready', 'paid', 'synced', ?2, ?3, ?4,
                   '2026-10-26T10:00:00Z', '2026-10-26T10:00:00Z', 'EUR')",
        params![order_id, BRANCH, TERMINAL, CASHIER_SHIFT],
    )
    .expect("seed delivery");
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status,
             staff_shift_id, sync_status, sync_state, created_at, updated_at
         ) VALUES (?1, ?2, 'cash', 15.0, 1500, 'EUR', 'completed', ?3, 'synced', 'applied',
                   '2026-10-26T10:05:00Z', '2026-10-26T10:05:00Z')",
        params![format!("{order_id}-cash"), order_id, CASHIER_SHIFT],
    )
    .expect("seed cash payment");
}

/// The wrong driver, as the cashier picked them (`order_assign_driver`).
fn assign_wrong_driver(conn: &Connection, order_id: &str) {
    crate::commands::orders::assign_driver_locally(conn, order_id, WRONG_DRIVER, None, NOW)
        .expect("assign the wrong driver");
}

fn change_driver(td: &TestDb, order_id: &str, driver: &str) -> Result<Value, String> {
    let mut conn = td.state.conn.lock().unwrap();
    let actor = DriverChangeActor {
        staff_id: Some("cashier-change".into()),
        approved_by: Some("manager-change".into()),
        approval_via: Some("manager_pin".into()),
    };
    change_order_driver_locally(&mut conn, order_id, driver, &actor, NOW)
        .map(|outcome| serde_json::to_value(outcome).unwrap())
}

/// (driver, shift, fee, tip, total, cash collected, card, cash to return), cents.
#[allow(clippy::type_complexity)]
fn earning(conn: &Connection, order_id: &str) -> (String, String, i64, i64, i64, i64, i64, i64) {
    conn.query_row(
        "SELECT driver_id, staff_shift_id,
                delivery_fee_cents, tip_amount_cents, total_earning_cents,
                cash_collected_cents, card_amount_cents, cash_to_return_cents
         FROM driver_earnings WHERE order_id = ?1",
        params![order_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        },
    )
    .expect("the order has one driver earning")
}

fn earnings_of_order(conn: &Connection, order_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM driver_earnings WHERE order_id = ?1",
        params![order_id],
        |row| row.get(0),
    )
    .unwrap()
}

fn amount_to_return(td: &TestDb, shift: &str) -> f64 {
    crate::shifts::get_shift_summary(&td.state, shift).expect("summary")["amountToReturn"]
        .as_f64()
        .expect("a courier return")
}

fn refused(result: Result<Value, String>, code: &str) {
    let error = result.expect_err("the change is refused");
    assert!(error.starts_with(code), "{code} expected, got: {error}");
}

#[test]
#[serial_test::serial]
fn a_delivered_cash_order_moves_its_earning_and_cash_to_the_driver_who_carried_it() {
    let _keyring = keyring();
    let td = TestDb::open();
    let money_before;
    {
        let conn = td.state.conn.lock().unwrap();
        seed_till(&conn);
        seed_cash_delivery(&conn, "tomikro-00042");
        assign_wrong_driver(&conn, "tomikro-00042");
        let wrong = earning(&conn, "tomikro-00042");
        assert_eq!(
            (wrong.0.as_str(), wrong.1.as_str()),
            (WRONG_DRIVER, WRONG_SHIFT)
        );
        money_before = (wrong.2, wrong.3, wrong.4, wrong.5, wrong.6, wrong.7);
        assert_eq!(money_before, (200, 100, 300, 1500, 0, 1500));
    }
    // The wrong driver holds the 15.00 less the 1.00 tip they keep.
    assert_eq!(amount_to_return(&td, WRONG_SHIFT), OPENING + 14.0);
    assert_eq!(amount_to_return(&td, RIGHT_SHIFT), OPENING);

    let outcome = change_driver(&td, "tomikro-00042", RIGHT_DRIVER).expect("change the driver");
    assert_eq!(outcome["corrected"], true);
    assert_eq!(outcome["previousDriverId"], WRONG_DRIVER);
    assert_eq!(outcome["driverId"], RIGHT_DRIVER);
    assert_eq!(outcome["driverName"], "Giorgos");

    {
        let conn = td.state.conn.lock().unwrap();
        // One earning, same id, same money, now the right driver's.
        assert_eq!(earnings_of_order(&conn, "tomikro-00042"), 1);
        let moved = earning(&conn, "tomikro-00042");
        assert_eq!(
            (moved.0.as_str(), moved.1.as_str()),
            (RIGHT_DRIVER, RIGHT_SHIFT)
        );
        assert_eq!(
            (moved.2, moved.3, moved.4, moved.5, moved.6, moved.7),
            money_before
        );
        // The order and its receipt follow; the status stays delivered.
        let (driver, name, shift, status): (String, String, String, String) = conn
            .query_row(
                "SELECT driver_id, driver_name, staff_shift_id, status FROM orders WHERE id = 'tomikro-00042'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (
                driver.as_str(),
                name.as_str(),
                shift.as_str(),
                status.as_str()
            ),
            (RIGHT_DRIVER, "Giorgos", RIGHT_SHIFT, "delivered")
        );
        let receipt_shift: String = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE order_id = 'tomikro-00042'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(receipt_shift, RIGHT_SHIFT);
        // Health sees nothing wrong with either courier.
        assert!(crate::courier_integrity::collect(&conn).unwrap()["issues"]
            .as_array()
            .unwrap()
            .is_empty());
        // Audited: who, from whom, to whom, the money.
        let (actor, payload): (String, String) = conn
            .query_row(
                "SELECT actor_staff_id, payload_json FROM recovery_action_log
                 WHERE action_id = 'order_driver_change' AND order_id = 'tomikro-00042'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("an audit entry");
        assert_eq!(actor, "manager-change");
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["fromDriverId"], WRONG_DRIVER);
        assert_eq!(payload["fromDriverName"], "Nikos");
        assert_eq!(payload["toDriverId"], RIGHT_DRIVER);
        assert_eq!(payload["changedBy"], "cashier-change");
        assert_eq!(payload["money"]["cashToReturnCents"], 1500);
    }
    // The checkout of each driver: the cash and the tip moved, nothing else.
    assert_eq!(amount_to_return(&td, WRONG_SHIFT), OPENING);
    assert_eq!(amount_to_return(&td, RIGHT_SHIFT), OPENING + 14.0);
}

#[test]
#[serial_test::serial]
fn the_server_gets_the_same_earning_and_the_order_under_the_new_driver() {
    let _keyring = keyring();
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_till(&conn);
        seed_cash_delivery(&conn, "tomikro-00043");
        assign_wrong_driver(&conn, "tomikro-00043");
    }
    change_driver(&td, "tomikro-00043", RIGHT_DRIVER).expect("change the driver");
    let conn = td.state.conn.lock().unwrap();
    let earning_id: String = conn
        .query_row(
            "SELECT id FROM driver_earnings WHERE order_id = 'tomikro-00043'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // One pending earning row: the same id, the new driver and shift.
    let rows: Vec<(String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT record_id, data FROM parity_sync_queue
                 WHERE table_name = 'driver_earnings' AND status = 'pending'",
            )
            .unwrap();
        let mapped = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        mapped.collect::<Result<_, _>>().unwrap()
    };
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, earning_id);
    let earning: Value = serde_json::from_str(&rows[0].1).unwrap();
    assert_eq!(earning["driver_id"], RIGHT_DRIVER);
    assert_eq!(earning["staff_shift_id"], RIGHT_SHIFT);
    assert_eq!(earning["cash_collected_cents"], 1500);
    assert_eq!(earning["total_earning_cents"], 300);

    // The order update names the new driver and marks the change.
    let update: String = conn
        .query_row(
            "SELECT data FROM parity_sync_queue
             WHERE table_name = 'orders' AND record_id = 'tomikro-00043'
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let update: Value = serde_json::from_str(&update).unwrap();
    assert_eq!(update["driverId"], RIGHT_DRIVER);
    assert_eq!(update["driverName"], "Giorgos");
    assert_eq!(update["driverReassigned"], true);
    assert_eq!(update["previousDriverId"], WRONG_DRIVER);
}

#[test]
#[serial_test::serial]
fn a_closed_shift_keeps_its_cash() {
    let _keyring = keyring();
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_till(&conn);
        for order in ["closed-old", "closed-new", "settled"] {
            seed_cash_delivery(&conn, order);
            assign_wrong_driver(&conn, order);
        }
        conn.execute(
            "UPDATE driver_earnings SET settled = 1 WHERE order_id = 'settled'",
            [],
        )
        .unwrap();
    }
    refused(
        change_driver(&td, "settled", RIGHT_DRIVER),
        DRIVER_CHANGE_SHIFT_CLOSED,
    );

    // The right driver checked out: there is no open shift to take it.
    td.state
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE staff_shifts SET status = 'closed', check_out_time = ?2 WHERE id = ?1",
            params![RIGHT_SHIFT, NOW],
        )
        .unwrap();
    refused(
        change_driver(&td, "closed-new", RIGHT_DRIVER),
        DRIVER_CHANGE_NEW_DRIVER_OFF_SHIFT,
    );

    // The wrong driver checked out: their closed shift keeps the order.
    {
        let conn = td.state.conn.lock().unwrap();
        conn.execute(
            "UPDATE staff_shifts SET status = 'active', check_out_time = NULL WHERE id = ?1",
            params![RIGHT_SHIFT],
        )
        .unwrap();
        conn.execute(
            "UPDATE staff_shifts SET status = 'closed', check_out_time = ?2 WHERE id = ?1",
            params![WRONG_SHIFT, NOW],
        )
        .unwrap();
    }
    refused(
        change_driver(&td, "closed-old", RIGHT_DRIVER),
        DRIVER_CHANGE_SHIFT_CLOSED,
    );

    // Nothing moved and nothing was audited.
    let conn = td.state.conn.lock().unwrap();
    for order in ["closed-old", "closed-new", "settled"] {
        let kept = earning(&conn, order);
        assert_eq!(
            (kept.0.as_str(), kept.1.as_str()),
            (WRONG_DRIVER, WRONG_SHIFT)
        );
        assert_eq!(kept.5, 1500, "{order}");
    }
    let audits: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM recovery_action_log WHERE action_id = 'order_driver_change'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(audits, 0);
}

#[test]
#[serial_test::serial]
fn a_cancelled_order_has_no_driver_to_change() {
    let _keyring = keyring();
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_till(&conn);
        seed_cash_delivery(&conn, "cancelled-order");
        assign_wrong_driver(&conn, "cancelled-order");
        conn.execute(
            "UPDATE orders SET status = 'cancelled' WHERE id = 'cancelled-order'",
            [],
        )
        .unwrap();
        let plan = plan_driver_change(&conn, "cancelled-order", RIGHT_DRIVER);
        assert!(plan.unwrap_err().starts_with(DRIVER_CHANGE_CANCELLED));
    }
    refused(
        change_driver(&td, "cancelled-order", RIGHT_DRIVER),
        DRIVER_CHANGE_CANCELLED,
    );
}

#[test]
#[serial_test::serial]
fn the_same_driver_or_a_refunded_order_is_refused() {
    let _keyring = keyring();
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_till(&conn);
        for order in ["same-driver", "refunded-part"] {
            seed_cash_delivery(&conn, order);
            assign_wrong_driver(&conn, order);
        }
        // 3.00 of the 15.00 cash went back to the customer.
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type,
                 amount, reason, sync_state, created_at, updated_at)
             VALUES ('refund-part', 'refunded-part-cash', 'refunded-part', 'refund',
                 3.0, 'cold food', 'applied', ?1, ?1)",
            params![NOW],
        )
        .unwrap();
    }
    refused(
        change_driver(&td, "same-driver", WRONG_DRIVER),
        DRIVER_CHANGE_SAME_DRIVER,
    );
    refused(
        change_driver(&td, "refunded-part", RIGHT_DRIVER),
        DRIVER_CHANGE_ADJUSTED_ORDER,
    );
}

#[test]
#[serial_test::serial]
fn a_delivered_order_without_a_driver_is_given_one_as_an_assignment() {
    let _keyring = keyring();
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_till(&conn);
        seed_cash_delivery(&conn, "no-driver-yet");
        conn.execute(
            "UPDATE orders SET status = 'delivered' WHERE id = 'no-driver-yet'",
            [],
        )
        .unwrap();
        let plan = plan_driver_change(&conn, "no-driver-yet", RIGHT_DRIVER).unwrap();
        assert!(!plan.is_correction(), "a first driver is no correction");
    }
    let outcome = change_driver(&td, "no-driver-yet", RIGHT_DRIVER).expect("give a driver");
    assert_eq!(outcome["corrected"], false);
    let conn = td.state.conn.lock().unwrap();
    let given = earning(&conn, "no-driver-yet");
    assert_eq!(
        (given.0.as_str(), given.1.as_str()),
        (RIGHT_DRIVER, RIGHT_SHIFT)
    );
    assert_eq!(given.5, 1500);
}

/// The Tomikro flow end to end: shifts opened and the order taken with its
/// cash payment through the till's own code, the wrong driver assigned, then
/// changed. The money each driver hands in follows the order, the total does
/// not change, and the old driver can check out with only their float.
#[test]
#[serial_test::serial]
fn the_tills_own_checkout_payment_follows_the_driver_change() {
    let _keyring = keyring();
    let td = TestDb::open();
    let db = &td.state;
    {
        let conn = db.conn.lock().unwrap();
        for (category, key, value) in [
            ("terminal", "terminal_id", TERMINAL),
            ("terminal", "branch_id", BRANCH),
            ("terminal", "organization_id", ORGANIZATION),
            ("restaurant", "store_currency_branch_id", BRANCH),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
            ("restaurant", "currency", "EUR"),
        ] {
            crate::db::set_setting(&conn, category, key, value).unwrap();
        }
    }
    let open = |staff: &str, name: &str, role: &str, opening: f64| -> String {
        crate::shifts::open_shift(
            db,
            &serde_json::json!({
                "staffId": staff,
                "staffName": name,
                "branchId": BRANCH,
                "terminalId": TERMINAL,
                "roleType": role,
                "openingCash": opening,
            }),
        )
        .unwrap_or_else(|error| panic!("open {name}: {error}"))["shiftId"]
            .as_str()
            .unwrap()
            .to_string()
    };
    open(
        "ca5e0000-0000-4000-8000-0000000000c1",
        "Cashier",
        "cashier",
        100.0,
    );
    let wrong_shift = open(WRONG_DRIVER, "Nikos", "driver", OPENING);
    let right_shift = open(RIGHT_DRIVER, "Giorgos", "driver", OPENING);

    let created = crate::sync::create_order(
        db,
        &serde_json::json!({
            "organizationId": ORGANIZATION,
            "branchId": BRANCH,
            "terminalId": TERMINAL,
            "clientRequestId": "tomikro-checkout-1",
            "items": [{
                "menu_item_id": "menu-crepe",
                "name": "Crepe",
                "quantity": 2,
                "price": 6.5,
                "unit_price": 6.5,
                "total_price": 13.0
            }],
            "totalAmount": 15.0,
            "subtotal": 13.0,
            "deliveryFee": 2.0,
            "status": "pending",
            "orderType": "delivery",
            "paymentStatus": "paid",
            "customerName": "Maria",
            "customerPhone": "6900000001",
            "deliveryAddress": "Odos Ermou 12",
            "initialPayment": {
                "method": "cash",
                "amount": 15.0,
                "currency": "EUR",
                "idempotencyKey": "tomikro-checkout-1-pay",
                "cashReceived": 20.0,
                "changeGiven": 5.0
            }
        }),
        &crate::print::NoopPrintQueueInvalidator,
    )
    .expect("the till takes the order");
    let order_id = created["orderId"].as_str().unwrap().to_string();

    {
        let conn = db.conn.lock().unwrap();
        crate::commands::orders::assign_driver_locally(&conn, &order_id, WRONG_DRIVER, None, NOW)
            .expect("assign the wrong driver");
    }
    let wrong_before = amount_to_return(&td, &wrong_shift);
    let right_before = amount_to_return(&td, &right_shift);
    let (before_driver, before_shift, fee, tip, total, cash, card, to_return) = {
        let conn = db.conn.lock().unwrap();
        earning(&conn, &order_id)
    };
    assert_eq!(
        (before_driver.as_str(), before_shift.as_str()),
        (WRONG_DRIVER, wrong_shift.as_str())
    );
    // The checkout's 15.00 cash is courier cash, held by the wrong driver.
    assert_eq!((cash, card, to_return), (1500, 0, 1500));
    assert!(
        (wrong_before - (OPENING + 15.0)).abs() < 0.001,
        "{wrong_before}"
    );
    assert_eq!(right_before, OPENING);

    change_driver(&td, &order_id, RIGHT_DRIVER).expect("change the driver");

    {
        let conn = db.conn.lock().unwrap();
        let moved = earning(&conn, &order_id);
        assert_eq!(
            (moved.0.as_str(), moved.1.as_str()),
            (RIGHT_DRIVER, right_shift.as_str())
        );
        assert_eq!(
            (moved.2, moved.3, moved.4, moved.5, moved.6, moved.7),
            (fee, tip, total, cash, card, to_return)
        );
        assert!(crate::courier_integrity::collect(&conn).unwrap()["issues"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    let wrong_after = amount_to_return(&td, &wrong_shift);
    let right_after = amount_to_return(&td, &right_shift);
    // What left the wrong driver is exactly what the right driver now holds.
    assert!((wrong_after - OPENING).abs() < 0.001, "{wrong_after}");
    assert!(((wrong_before - wrong_after) - (right_after - right_before)).abs() < 0.001);
    assert!(
        (right_after - wrong_before).abs() < 0.001,
        "{right_after} vs {wrong_before}"
    );

    // The wrong driver checks out with only their float.
    let closed = crate::shifts::close_shift(
        db,
        &serde_json::json!({ "shiftId": wrong_shift, "closingCash": OPENING }),
    )
    .expect("the wrong driver checks out");
    assert_eq!(closed["success"], true, "{closed}");
}
