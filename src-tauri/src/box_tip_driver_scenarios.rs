use super::*;
use crate::commands::orders::{
    assign_driver_locally, assign_driver_locally_with_platform_cash, change_order_driver_locally,
    reset_order_to_active_locally, DriverAssignmentCash, DriverChangeActor,
};
use crate::payments;

const BRANCH: &str = "branch-ct";
const TERMINAL: &str = "term-ct";
const ORG: &str = "tip-scenario-org";
const DRIVER: &str = "driver-ct";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    name: String,
    float_cents: i64,
    orders: Vec<Order>,
    expect: Expected,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Order {
    code: String,
    source: String,
    fleet: Option<String>,
    total_cents: i64,
    header_tip_cents: i64,
    flow: String,
    earning: String,
    payments: Vec<Payment>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payment {
    method: String,
    amount_cents: i64,
    tip_cents: i64,
    tip_to: String,
    status: String,
    refunded_cents: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    kept_cents: i64,
    lines: Vec<Line>,
    due_cents: i64,
}

#[derive(Debug, PartialEq, serde::Deserialize)]
struct Line {
    order: String,
    cents: i64,
}

pub(super) fn open_driver_till(db: &DbState, opening: f64) -> (String, String) {
    (open_cashier(db), open_driver(db, opening))
}

fn open_cashier(db: &DbState) -> String {
    seed_operating_currency_for_test(db, BRANCH, "EUR");
    {
        let conn = db.conn.lock().unwrap();
        db::set_setting(&conn, "terminal", "organization_id", ORG).unwrap();
        db::set_setting(&conn, "terminal", "terminal_id", TERMINAL).unwrap();
        db::set_setting(
            &conn,
            "terminal",
            "source_terminal_db_id",
            "tip-scenario-terminal-db",
        )
        .unwrap();
    }
    let cashier = open_shift(
        db,
        &json!({
            "staffId": "cashier-ct", "branchId": BRANCH, "terminalId": TERMINAL,
            "roleType": "cashier", "openingCash": 500.0,
        }),
    )
    .unwrap();
    cashier["shiftId"].as_str().unwrap().to_owned()
}

fn open_driver(db: &DbState, opening: f64) -> String {
    let driver = open_shift(
        db,
        &json!({
            "staffId": DRIVER, "branchId": BRANCH, "terminalId": TERMINAL,
            "roleType": "driver", "openingCash": opening,
        }),
    )
    .unwrap();
    driver["shiftId"].as_str().unwrap().to_owned()
}

pub(super) fn seed_phone_order(db: &DbState, code: &str, total: i64, tip: i64) {
    insert_order(
        &db.conn.lock().unwrap(),
        code,
        total,
        tip,
        None,
        None,
        &chrono::Utc::now().to_rfc3339(),
    );
}

fn insert_order(
    conn: &Connection,
    code: &str,
    total: i64,
    tip: i64,
    plugin: Option<&str>,
    metadata: Option<String>,
    created_at: &str,
) {
    conn.execute(
        "INSERT INTO orders (id, order_number, order_type, items, status, payment_status,
            total_amount, total_amount_cents, tip_amount, tip_amount_cents, branch_id,
            terminal_id, organization_id, currency, plugin, ghost_metadata, created_at, updated_at)
         VALUES (?1, ?1, 'delivery', '[]', 'ready', 'pending', ?2 / 100.0, ?2, ?3 / 100.0,
            ?3, ?4, ?5, ?6, 'EUR', ?7, ?8, ?9, ?9)",
        params![code, total, tip, BRANCH, TERMINAL, ORG, plugin, metadata, created_at],
    )
    .unwrap();
}

pub(super) fn assign(db: &DbState, code: &str) {
    assign_driver_locally(
        &db.conn.lock().unwrap(),
        code,
        DRIVER,
        None,
        &chrono::Utc::now().to_rfc3339(),
    )
    .unwrap();
}

fn record_scenario_payment(
    db: &DbState,
    order: &Order,
    payment: &Payment,
    cashier: &str,
    driver_shift: Option<&str>,
) -> String {
    if payment.method == "platform_settlement" {
        let conn = db.conn.lock().unwrap();
        assert!(payments::auto_settle_platform_order(&conn, &order.code).unwrap());
        return conn
            .query_row(
                "SELECT id FROM order_payments WHERE order_id=?1",
                [&order.code],
                |row| row.get(0),
            )
            .unwrap();
    }
    let method = match payment.method.as_str() {
        "credit_card" | "debit_card" => "card",
        method => method,
    };
    let mut payload = json!({
        "orderId": order.code,
        "method": method,
        "amount": Cents::new(payment.amount_cents).to_f64_dp2(),
        "tipAmount": Cents::new(payment.tip_cents).to_f64_dp2(),
    });
    if let Some(driver_shift) = driver_shift {
        payload["staffShiftId"] = json!(driver_shift);
        payload["collectedBy"] = json!("driver_shift");
    }
    if method == "cash" {
        payload["cashReceived"] = payload["amount"].clone();
        payload["changeGiven"] = json!(0.0);
    }
    match payment.tip_to.as_str() {
        "driver" => payload["tipRecipientRole"] = json!("driver"),
        "other_shift" => {
            payload["tipRecipientRole"] = json!("cashier");
            payload["tipRecipientStaffShiftId"] = json!(cashier);
        }
        "none" => {}
        recipient => panic!("unknown fixture tip recipient {recipient}"),
    }
    let recorded = payments::record_payment(db, &payload).unwrap();
    let id = recorded["paymentId"].as_str().unwrap().to_owned();
    if method != payment.method {
        // The local writer and current storage check only admit canonical
        // "card". Restore the legacy spelling to exercise the checkout read.
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        conn.execute(
            "UPDATE order_payments SET method=?1 WHERE id=?2",
            params![payment.method, id],
        )
        .unwrap();
        conn.execute_batch("PRAGMA ignore_check_constraints=OFF")
            .unwrap();
    }
    id
}

fn apply_payment_status(db: &DbState, id: &str, payment: &Payment, cashier: &str) {
    if payment.status == "voided" {
        payments::void_payment(db, id, "fixture void", None, Some(cashier)).unwrap();
    } else if let Some(cents) = payment
        .refunded_cents
        .or_else(|| (payment.status == "refunded").then_some(payment.amount_cents))
    {
        crate::refunds::refund_payment(
            db,
            &json!({
                "paymentId": id, "reason": "fixture refund", "staffShiftId": cashier,
                "refundMethod": "card", "amount": Cents::new(cents).to_f64_dp2(),
            }),
        )
        .unwrap();
    }
    let status: String = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT status FROM order_payments WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, payment.status);
}

fn seed_scenario_order(db: &DbState, order: &Order) {
    let auto = order.flow == "auto_cash_writer";
    let metadata = order.fleet.as_deref().map(|fleet| json!({
        "food_delivery": {
            "short_code": order.code, "box_daas": fleet == "courier",
            "delivery_provider": if fleet == "store" { "vendor_delivery" } else { "platform_delivery" },
            "payment_method": if auto { "cash" } else { "online" },
            "prepaid": !auto,
        }
    }).to_string());
    insert_order(
        &db.conn.lock().unwrap(),
        &order.code,
        order.total_cents,
        order.header_tip_cents,
        (order.source != "phone").then_some(order.source.as_str()),
        metadata,
        &chrono::Utc::now().to_rfc3339(),
    );
}

fn record_auto_cash_at_assignment(db: &DbState, order: &Order, shift_id: &str) {
    let conn = db.conn.lock().unwrap();
    let at = chrono::Utc::now().to_rfc3339();
    db::set_setting(
        &conn,
        "terminal",
        "enabled_features",
        r#"{"platform_driver_cash_auto":true}"#,
    )
    .unwrap();
    db::set_setting(
        &conn,
        "device_admission",
        "cash_register",
        &json!({
            "admitted": false, "fetchedAt": at, "organizationId": ORG,
            "branchId": BRANCH, "terminalId": TERMINAL,
        })
        .to_string(),
    )
    .unwrap();
    crate::fiscal::active_cache::pin_for_test(
        BRANCH,
        crate::fiscal::active_cache::CacheVerdict::Inactive,
    );
    let (_, _, _, refusal) = assign_driver_locally_with_platform_cash(
        &conn,
        &order.code,
        DRIVER,
        None,
        &at,
        DriverAssignmentCash::Direct { actor: None },
    )
    .unwrap();
    assert!(refusal.is_none(), "{refusal:?}");
    let (method, amount, tip, status, recipient): (String, i64, i64, String, String) = conn
        .query_row(
            "SELECT method, amount_cents, tip_amount_cents, status, tip_recipient_staff_shift_id
         FROM order_payments WHERE order_id=?1",
            [&order.code],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    let receipt_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE order_id=?1",
            [&order.code],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipt_count, 1);
    let [expected] = order.payments.as_slice() else {
        panic!("one automatic receipt expected")
    };
    assert_eq!(
        (method, amount, tip, status, recipient.as_str()),
        (
            expected.method.clone(),
            expected.amount_cents,
            expected.tip_cents,
            expected.status.clone(),
            shift_id
        )
    );
}

fn record_receipts(db: &DbState, order: &Order, cashier: &str, shift_id: Option<&str>) {
    for payment in &order.payments {
        let id = record_scenario_payment(db, order, payment, cashier, shift_id);
        apply_payment_status(db, &id, payment, cashier);
    }
}

fn run_order(db: &DbState, order: &Order, cashier: &str, shift_id: &str) {
    if order.flow != "prepaid_before_check_in" {
        seed_scenario_order(db, order);
    }
    match order.flow.as_str() {
        "auto_cash_writer" => record_auto_cash_at_assignment(db, order, shift_id),
        "assign_then_pay" => {
            assign(db, &order.code);
            record_receipts(db, order, cashier, Some(shift_id));
        }
        "pay_then_assign" => {
            record_receipts(db, order, cashier, None);
            assign(db, &order.code);
        }
        "prepaid_before_check_in" => {
            let prepaid: bool = db
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT op.created_at < ss.check_in_time
                 FROM order_payments op JOIN staff_shifts ss ON ss.id=?2 WHERE op.order_id=?1",
                    params![order.code, shift_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(prepaid);
            assign(db, &order.code);
        }
        flow => panic!("unknown fixture flow {flow}"),
    }
    match order.earning.as_str() {
        "active" => {}
        "transferred" => {
            let handover =
                close_shift(db, &json!({"shiftId": cashier, "closingCash": 500.0})).unwrap();
            assert_eq!(handover["success"], true, "{handover}");
            let transferred: bool = db
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT is_transferred FROM driver_earnings WHERE order_id=?1",
                    [&order.code],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(transferred);
        }
        "settled" => {
            // No scenario exercises settlement today. The flag mirrors an
            // already settled earning from the server.
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE driver_earnings SET settled=1, settled_at=?2, updated_at=?2,
                        settlement_batch_id='fixture-settlement' WHERE order_id=?1",
                    params![order.code, chrono::Utc::now().to_rfc3339()],
                )
                .unwrap();
        }
        state => panic!("unknown fixture earning state {state}"),
    }
}

#[test]
fn fix2_win_shared_driver_tip_scenarios() {
    let _fake = crate::tests::fake_keyring::install_empty();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../shared/pos/driver-tips/__fixtures__/driver-kept-tips-scenarios.json"
    ))
    .unwrap();
    let scenarios: Vec<Scenario> = serde_json::from_value(fixture["scenarios"].clone()).unwrap();
    for scenario in scenarios {
        let db = test_db();
        let cashier = open_cashier(&db);
        for order in scenario
            .orders
            .iter()
            .filter(|order| order.flow == "prepaid_before_check_in")
        {
            seed_scenario_order(&db, order);
            record_receipts(&db, order, &cashier, None);
        }
        let shift_id = open_driver(&db, Cents::new(scenario.float_cents).to_f64_dp2());
        for order in &scenario.orders {
            run_order(&db, order, &cashier, &shift_id);
        }
        let summary = get_shift_summary(&db, &shift_id).unwrap();
        let cents = |value: &Value| Cents::round_half_even(value.as_f64().unwrap()).as_i64();
        assert_eq!(
            cents(&summary["tipsReceived"]),
            scenario.expect.kept_cents,
            "{}",
            scenario.name
        );
        assert_eq!(
            cents(&summary["amountToReturn"]),
            scenario.expect.due_cents,
            "{}",
            scenario.name
        );
        let lines: Vec<Line> = summary["driverKeptTipLines"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|line| {
                let code = line["orderNumber"].as_str().unwrap();
                // The fixture stores a provider code. Windows displays it
                // with a leading #, which the printing gate tests separately.
                let order = if line["source"] == "box" {
                    code.trim_start_matches('#')
                } else {
                    code
                };
                Line {
                    order: order.to_owned(),
                    cents: cents(&line["amount"]),
                }
            })
            .collect();
        assert_eq!(lines, scenario.expect.lines, "{}", scenario.name);

        let handover = scenario
            .orders
            .iter()
            .any(|order| order.earning == "transferred");
        let due = summary["amountToReturn"].as_f64().unwrap();
        let closed = close_shift(
            &db,
            &json!({
                "shiftId": shift_id, "closingCash": if handover { 0.0 } else { due },
                "expectedDriverKeptTips": summary["tipsReceived"],
                "expectedDriverPayout": 0.0,
            }),
        )
        .unwrap();
        assert_eq!(closed["success"], true, "{}: {closed}", scenario.name);
        assert_eq!(
            cents(&closed["expected"]),
            scenario.expect.due_cents,
            "{}",
            scenario.name
        );
    }
}

#[test]
fn fix2_win_item1_pending_card_tip_follows_change_driver_and_unassign() {
    let _fake = crate::tests::fake_keyring::install_empty();
    let db = test_db();
    let (_, first_shift) = open_driver_till(&db, 20.0);
    let second = open_shift(
        &db,
        &json!({
            "staffId": "second-driver", "branchId": BRANCH, "terminalId": TERMINAL,
            "roleType": "driver", "openingCash": 20.0,
        }),
    )
    .unwrap();
    let second_shift = second["shiftId"].as_str().unwrap();
    seed_phone_order(&db, "reassign-tip", 1075, 75);
    let payment = payments::record_payment(
        &db,
        &json!({
            "orderId": "reassign-tip", "method": "card", "amount": 10.75,
            "tipAmount": 0.75, "tipRecipientRole": "driver",
        }),
    )
    .unwrap();
    let payment_id = payment["paymentId"].as_str().unwrap();
    let recipient = || {
        db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT tip_recipient_role, tip_recipient_staff_id, tip_recipient_staff_shift_id
         FROM order_payments WHERE id=?1",
                [payment_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .unwrap()
    };

    assert_eq!(recipient(), ("driver".into(), None, None));
    assign(&db, "reassign-tip");
    assert_eq!(
        recipient(),
        (
            "driver".into(),
            Some(DRIVER.into()),
            Some(first_shift.clone())
        )
    );
    assert_eq!(
        get_shift_summary(&db, &first_shift).unwrap()["tipsReceived"],
        0.75
    );

    change_order_driver_locally(
        &mut db.conn.lock().unwrap(),
        "reassign-tip",
        "second-driver",
        &DriverChangeActor::default(),
        &chrono::Utc::now().to_rfc3339(),
    )
    .unwrap();
    assert_eq!(
        recipient(),
        (
            "driver".into(),
            Some("second-driver".into()),
            Some(second_shift.into())
        )
    );
    assert_eq!(
        get_shift_summary(&db, &first_shift).unwrap()["tipsReceived"],
        0.0
    );
    assert_eq!(
        get_shift_summary(&db, second_shift).unwrap()["tipsReceived"],
        0.75
    );

    reset_order_to_active_locally(
        &mut db.conn.lock().unwrap(),
        "reassign-tip",
        &chrono::Utc::now().to_rfc3339(),
    )
    .unwrap();
    assert_eq!(recipient(), ("driver".into(), None, None));
    assert_eq!(
        get_shift_summary(&db, second_shift).unwrap()["tipsReceived"],
        0.0
    );
}
