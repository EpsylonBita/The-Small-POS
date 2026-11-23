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
const SCENARIO_FIXTURE: &str =
    include_str!("../../../shared/pos/driver-tips/__fixtures__/driver-kept-tips-scenarios.json");

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ScenarioFixture {
    #[serde(rename = "$comment")]
    _comment: String,
    #[serde(rename = "vocabulary")]
    _vocabulary: std::collections::BTreeMap<String, String>,
    scenarios: Vec<Scenario>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scenario {
    name: String,
    #[serde(rename = "why")]
    _why: Option<String>,
    float_cents: i64,
    orders: Vec<Order>,
    claim: Option<Claim>,
    expect: Expected,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payment {
    method: String,
    amount_cents: i64,
    tip_cents: i64,
    tip_to: String,
    status: String,
    refunded_cents: Option<i64>,
    stored: Option<StoredPayment>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPayment {
    method: String,
    amount_cents: i64,
    tip_cents: i64,
    status: String,
    recipient: StoredRecipient,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredRecipient {
    Driver,
    None,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    before: Expected,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    kept_cents: i64,
    lines: Vec<Line>,
    due_cents: i64,
    cash_lines: Option<Vec<Line>>,
}

#[derive(Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
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
    check_in_cashier(db, "cashier-ct")
}

fn check_in_cashier(db: &DbState, staff_id: &str) -> String {
    let cashier = open_shift(
        db,
        &json!({
            "staffId": staff_id, "branchId": BRANCH, "terminalId": TERMINAL,
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
        return single_receipt_id(&conn, order);
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

fn single_receipt_id(conn: &Connection, order: &Order) -> String {
    conn.query_row(
        "SELECT MIN(id) FROM order_payments WHERE order_id=?1 HAVING COUNT(*)=1",
        [&order.code],
        |row| row.get(0),
    )
    .unwrap_or_else(|error| panic!("{}: expected one receipt: {error}", order.code))
}

fn record_auto_cash_at_assignment(db: &DbState, order: &Order) -> String {
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
    single_receipt_id(&conn, order)
}

fn assert_stored_receipts(db: &DbState, order: &Order, ids: &[String], shift_id: &str) {
    assert_eq!(ids.len(), order.payments.len(), "{}", order.code);
    for (id, payment) in ids.iter().zip(&order.payments) {
        let auto_cash = order.flow == "auto_cash_writer";
        let (method, amount, tip, status, recipient) = match &payment.stored {
            Some(stored) => (
                stored.method.as_str(),
                stored.amount_cents,
                stored.tip_cents,
                stored.status.as_str(),
                &stored.recipient,
            ),
            None if auto_cash => (
                payment.method.as_str(),
                payment.amount_cents,
                payment.tip_cents,
                payment.status.as_str(),
                &StoredRecipient::Driver,
            ),
            None => continue,
        };
        let actual = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT method, amount_cents, tip_amount_cents, status,
                        tip_recipient_role, tip_recipient_staff_id, tip_recipient_staff_shift_id
                 FROM order_payments WHERE id=?1 AND order_id=?2",
                params![id, order.code],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .unwrap();
        let (role, staff, shift) = match recipient {
            StoredRecipient::Driver => (Some("driver"), Some(DRIVER), Some(shift_id)),
            StoredRecipient::None => (None, None, None),
        };
        assert_eq!(
            (
                actual.0.as_str(),
                actual.1,
                actual.2,
                actual.3.as_str(),
                actual.4.as_deref(),
                actual.5.as_deref(),
                actual.6.as_deref(),
            ),
            (method, amount, tip, status, role, staff, shift),
            "{}: stored receipt {id}",
            order.code
        );
    }
}

fn record_receipts(
    db: &DbState,
    order: &Order,
    cashier: &str,
    shift_id: Option<&str>,
) -> Vec<String> {
    order
        .payments
        .iter()
        .map(|payment| {
            let id = record_scenario_payment(db, order, payment, cashier, shift_id);
            apply_payment_status(db, &id, payment, cashier);
            id
        })
        .collect()
}

fn run_order(db: &DbState, order: &Order, cashier: &str, shift_id: &str, prepaid_ids: Vec<String>) {
    if order.flow != "prepaid_before_check_in" {
        seed_scenario_order(db, order);
    }
    let receipt_ids = match order.flow.as_str() {
        "auto_cash_writer" => vec![record_auto_cash_at_assignment(db, order)],
        "assign_then_pay" => {
            assign(db, &order.code);
            record_receipts(db, order, cashier, Some(shift_id))
        }
        "pay_then_assign" => {
            let ids = record_receipts(db, order, cashier, None);
            assign(db, &order.code);
            ids
        }
        "prepaid_before_check_in" => {
            for id in &prepaid_ids {
                let prepaid: bool = db
                    .conn
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT op.created_at < ss.check_in_time
                         FROM order_payments op JOIN staff_shifts ss ON ss.id=?2 WHERE op.id=?1",
                        params![id, shift_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(prepaid);
            }
            assign(db, &order.code);
            prepaid_ids
        }
        flow => panic!("unknown fixture flow {flow}"),
    };
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
            // Mirror an earning that was already settled before this handover.
            let updated = db
                .conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE driver_earnings SET settled=1, settled_at=?2, updated_at=?2,
                        settlement_batch_id='fixture-settlement' WHERE order_id=?1",
                    params![order.code, chrono::Utc::now().to_rfc3339()],
                )
                .unwrap();
            assert_eq!(updated, 1, "{}: expected an earning to settle", order.code);
        }
        state => panic!("unknown fixture earning state {state}"),
    }
    assert_stored_receipts(db, order, &receipt_ids, shift_id);
}

fn parse_scenarios(fixture: &str) -> serde_json::Result<Vec<Scenario>> {
    serde_json::from_str::<ScenarioFixture>(fixture).map(|fixture| fixture.scenarios)
}

fn load_scenarios() -> Vec<Scenario> {
    parse_scenarios(SCENARIO_FIXTURE).unwrap()
}

fn run_scenario_orders(db: &DbState, scenario: &Scenario) -> String {
    let cashier = open_cashier(db);
    let prepaid_ids: Vec<_> = scenario
        .orders
        .iter()
        .map(|order| {
            if order.flow == "prepaid_before_check_in" {
                seed_scenario_order(db, order);
                record_receipts(db, order, &cashier, None)
            } else {
                Vec::new()
            }
        })
        .collect();
    let shift_id = open_driver(db, Cents::new(scenario.float_cents).to_f64_dp2());
    for (order, prepaid_ids) in scenario.orders.iter().zip(prepaid_ids) {
        run_order(db, order, &cashier, &shift_id, prepaid_ids);
    }
    shift_id
}

fn assert_cash_lines(
    db: &DbState,
    shift_id: &str,
    summary: &Value,
    expected: &[Line],
    scenario_name: &str,
) {
    let screen: Vec<Line> = summary["driverDeliveries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| Line {
            order: row["order_number"].as_str().unwrap().to_owned(),
            cents: cents(&row["cash_collected"]),
        })
        .collect();
    let doc = crate::print::build_document_for_job(db, "shift_checkout", shift_id, None).unwrap();
    let crate::receipt_renderer::ReceiptDocument::ShiftCheckout(doc) = doc else {
        panic!("expected a shift checkout document");
    };
    let printed: Vec<Line> = doc
        .driver_deliveries
        .iter()
        .map(|row| Line {
            order: row.order_number.clone(),
            cents: Cents::round_half_even(row.cash_collected).as_i64(),
        })
        .collect();
    assert_eq!(
        (screen.as_slice(), printed.as_slice()),
        (expected, expected),
        "{scenario_name}: screen and print cash lines"
    );
    let due = cents(&summary["amountToReturn"]);
    let cash_in_due = due - cents(&summary["shift"]["opening_cash_amount"])
        + cents(&summary["tipsReceived"])
        + cents(&summary["totalExpenses"]);
    assert_eq!(
        cash_in_due,
        screen.iter().map(|line| line.cents).sum::<i64>()
    );
    assert_eq!(
        Cents::round_half_even(doc.total_cash_collected).as_i64(),
        cash_in_due
    );
    assert_eq!(Cents::round_half_even(doc.amount_to_return).as_i64(), due);
}

fn cents(value: &Value) -> i64 {
    Cents::round_half_even(value.as_f64().unwrap()).as_i64()
}

fn assert_checkout(db: &DbState, shift_id: &str, expected: &Expected, name: &str) -> Value {
    let summary = get_shift_summary(db, shift_id).unwrap();
    assert_eq!(
        cents(&summary["tipsReceived"]),
        expected.kept_cents,
        "{name}"
    );
    assert_eq!(
        cents(&summary["amountToReturn"]),
        expected.due_cents,
        "{name}"
    );
    let lines: Vec<Line> = summary["driverKeptTipLines"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|line| {
            let code = line["orderNumber"].as_str().unwrap();
            // The fixture stores a provider code. Windows prints it with a #.
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
    assert_eq!(lines, expected.lines, "{name}");
    if let Some(cash_lines) = &expected.cash_lines {
        assert_cash_lines(db, shift_id, &summary, cash_lines, name);
    }
    summary
}

fn close_scenario_shift(db: &DbState, shift_id: &str, scenario: &Scenario, summary: &Value) {
    let pending = scenario.claim.is_none()
        && scenario
            .orders
            .iter()
            .any(|order| order.earning == "transferred");
    // A pending handover has no receiving drawer for a positive count.
    let closing_cash = if pending {
        0.0
    } else {
        summary["amountToReturn"].as_f64().unwrap()
    };
    let closed = close_shift(
        db,
        &json!({
            "shiftId": shift_id, "closingCash": closing_cash,
            "expectedDriverKeptTips": summary["tipsReceived"], "expectedDriverPayout": 0.0,
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

fn mixed_handover_checkout(reprint: bool) {
    let _fake = crate::tests::fake_keyring::install_empty();
    let scenario = load_scenarios()
        .into_iter()
        .find(|scenario| scenario.name == "mixed_handover_uses_the_active_population")
        .unwrap();
    let db = test_db();
    let shift_id = run_scenario_orders(&db, &scenario);
    if reprint {
        let summary = get_shift_summary(&db, &shift_id).unwrap();
        close_scenario_shift(&db, &shift_id, &scenario, &summary);
        // A later settlement can change the earning flags before a reprint.
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE driver_earnings SET settled=1 WHERE staff_shift_id=?1",
                [&shift_id],
            )
            .unwrap();
    }
    assert!(scenario.expect.cash_lines.is_some());
    assert_checkout(&db, &shift_id, &scenario.expect, &scenario.name);
}

#[test]
fn fu_win_w2_mixed_handover_checkout() {
    mixed_handover_checkout(false);
}

#[test]
fn fu_win_w2_mixed_handover_reprint_after_settlement() {
    mixed_handover_checkout(true);
}

#[test]
fn fu_win_fix_non_mixed_reprint_keeps_closed_delivery_lines() {
    let _fake = crate::tests::fake_keyring::install_empty();
    let scenario = load_scenarios()
        .into_iter()
        .find(|scenario| scenario.name == "phone_cash_tip")
        .unwrap();
    let db = test_db();
    let shift_id = run_scenario_orders(&db, &scenario);
    let summary = get_shift_summary(&db, &shift_id).unwrap();
    close_scenario_shift(&db, &shift_id, &scenario, &summary);

    let layout = crate::receipt_renderer::LayoutConfig::default();
    let print = || {
        let doc =
            crate::print::build_document_for_job(&db, "shift_checkout", &shift_id, None).unwrap();
        (
            crate::receipt_renderer::render_html(&doc, &layout),
            crate::receipt_renderer::render_escpos(&doc, &layout).bytes,
        )
    };
    let original_print = print();
    let original = get_shift_summary(&db, &shift_id).unwrap();
    assert_eq!(original["driverDeliveries"].as_array().unwrap().len(), 1);
    assert_eq!(original["driverDeliveries"][0]["order_number"], "#0010");

    for mutation in [
        "UPDATE orders SET status='cancelled', display_order_number='changed' WHERE id='#0010'",
        "DELETE FROM driver_earnings WHERE order_id='#0010'",
    ] {
        assert_eq!(db.conn.lock().unwrap().execute(mutation, []).unwrap(), 1);
        assert_eq!(print(), original_print, "{mutation}");
        let closed = get_shift_summary(&db, &shift_id).unwrap();
        assert_eq!(closed["driverDeliveries"], original["driverDeliveries"]);
        assert_eq!(closed["amountToReturn"], original["amountToReturn"]);
    }
}

#[test]
fn fu_win_fix_mixed_handover_freezes_split_tender_cents() {
    let _fake = crate::tests::fake_keyring::install_empty();
    let mut scenario = load_scenarios()
        .into_iter()
        .find(|scenario| scenario.name == "mixed_handover_uses_the_active_population")
        .unwrap();
    let active = &mut scenario.orders[1];
    assert_eq!(active.code, "#0018");
    active.total_cents = 1000;
    active.payments[0].amount_cents = 400;
    active.payments.push(Payment {
        method: "card".into(),
        amount_cents: 600,
        tip_cents: 0,
        tip_to: "none".into(),
        status: "completed".into(),
        refunded_cents: None,
        stored: None,
    });
    scenario.expect.due_cents = 2400;
    scenario.expect.cash_lines.as_mut().unwrap()[0].cents = 400;

    let db = test_db();
    let shift_id = run_scenario_orders(&db, &scenario);
    let summary = assert_checkout(&db, &shift_id, &scenario.expect, &scenario.name);
    close_scenario_shift(&db, &shift_id, &scenario, &summary);
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE driver_earnings SET cash_collected=1, cash_collected_cents=100,
                    card_amount=2, card_amount_cents=200 WHERE order_id='#0018'",
                [],
            )
            .unwrap(),
        1
    );

    let closed = assert_checkout(&db, &shift_id, &scenario.expect, &scenario.name);
    let line = &closed["driverDeliveries"][0];
    assert_eq!(line["order_id"], "#0018");
    assert_eq!(line["payment_method"], "mixed");
    assert_eq!(cents(&line["card_amount"]), 600);
    assert_eq!(cents(&line["total_amount"]), 1000);
    let doc = crate::print::build_document_for_job(&db, "shift_checkout", &shift_id, None).unwrap();
    let crate::receipt_renderer::ReceiptDocument::ShiftCheckout(checkout) = &doc else {
        panic!("expected a shift checkout document");
    };
    assert_eq!(
        Cents::round_half_even(checkout.total_card_collected).as_i64(),
        600
    );
    let html = crate::receipt_renderer::render_html(
        &doc,
        &crate::receipt_renderer::LayoutConfig::default(),
    );
    let delivery_row = html.split_once("018 —</span>").unwrap().1;
    let printed_amount = delivery_row
        .strip_prefix("<span class=\"payment-value\"><span>")
        .unwrap()
        .split_once("</span>")
        .unwrap()
        .0;
    assert!(printed_amount.starts_with("10.00"), "{printed_amount}");
}

#[test]
fn fu_win_w6_shared_runner_rejects_unknown_fields() {
    let fixture: Value = serde_json::from_str(SCENARIO_FIXTURE).unwrap();
    for path in [
        "/scenarios/0",
        "/scenarios/0/orders/0",
        "/scenarios/0/orders/0/payments/0",
        "/scenarios/0/orders/0/payments/0/stored",
        "/scenarios/0/expect",
        "/scenarios/0/expect/lines/0",
    ] {
        let mut fixture = fixture.clone();
        fixture.pointer_mut(path).unwrap()["unexpectedField"] = json!(true);
        let error = parse_scenarios(&fixture.to_string()).err().expect(path);
        assert!(error
            .to_string()
            .contains("unknown field `unexpectedField`"));
    }
}

#[test]
#[should_panic(expected = "B449: stored receipt")]
fn fu_win_w6_shared_runner_rejects_wrong_stored_settlement_tip() {
    let _fake = crate::tests::fake_keyring::install_empty();
    let mut scenario = load_scenarios()
        .into_iter()
        .find(|scenario| scenario.name == "box_online_tip_own_driver_b449")
        .unwrap();
    scenario.orders[0].payments[0]
        .stored
        .as_mut()
        .unwrap()
        .tip_cents = 1;
    run_scenario_orders(&test_db(), &scenario);
}

fn claim_handover(db: &DbState, shift_id: &str, orders: &[Order]) {
    let earning_state = |order: &Order| {
        db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COALESCE(settled, 0), COALESCE(is_transferred, 0)
                 FROM driver_earnings WHERE staff_shift_id=?1 AND order_id=?2",
                params![shift_id, order.code],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .unwrap()
    };
    let before: Vec<_> = orders.iter().map(&earning_state).collect();
    for (order, (settled, transferred)) in orders.iter().zip(&before) {
        match order.earning.as_str() {
            "settled" => assert!(*settled, "{}: expected settled earning", order.code),
            "transferred" => assert!(
                !*settled && *transferred,
                "{}: expected pending earning",
                order.code
            ),
            "active" => assert!(
                !*settled && !*transferred,
                "{}: expected active earning",
                order.code
            ),
            state => panic!("unknown fixture earning state {state}"),
        }
    }

    // open_shift calls claim_transferred_cash_staff as part of cashier check-in.
    let receiver = check_in_cashier(db, "receiving-cashier-ct");
    let (owner, pending): (Option<String>, bool) = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT transferred_to_cashier_shift_id, is_transfer_pending FROM staff_shifts WHERE id=?1",
            [shift_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (owner.as_deref(), pending),
        (Some(receiver.as_str()), false)
    );
    for (order, (settled, transferred)) in orders.iter().zip(before) {
        assert_eq!(
            earning_state(order),
            (settled, settled && transferred),
            "{}",
            order.code
        );
    }
}

#[test]
fn fu_win_w6_shared_driver_tip_scenarios() {
    let _fake = crate::tests::fake_keyring::install_empty();
    for scenario in load_scenarios() {
        let db = test_db();
        let shift_id = run_scenario_orders(&db, &scenario);
        if let Some(claim) = &scenario.claim {
            let name = format!("{} before claim", scenario.name);
            assert_checkout(&db, &shift_id, &claim.before, &name);
            claim_handover(&db, &shift_id, &scenario.orders);
        }
        let summary = assert_checkout(&db, &shift_id, &scenario.expect, &scenario.name);
        close_scenario_shift(&db, &shift_id, &scenario, &summary);
        if scenario.expect.cash_lines.is_some() {
            assert_checkout(&db, &shift_id, &scenario.expect, &scenario.name);
        }
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
