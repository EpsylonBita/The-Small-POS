use super::*;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fixture {
    #[serde(rename = "$comment")]
    _comment: String,
    #[serde(rename = "vocabulary")]
    _conventions: BTreeMap<String, String>,
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Scenario {
    name: String,
    #[serde(rename = "why")]
    _why: Option<String>,
    float_cents: i64,
    close: Close,
    tables: Vec<Table>,
    payments: Vec<Payment>,
    #[serde(default)]
    cash_returns: Vec<CashReturn>,
    expect: Expected,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Close {
    MainLocal,
    PhoneSelfClose,
    MainRemote,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    code: String,
    waiter: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Payment {
    table: String,
    by: String,
    on: Origin,
    method: String,
    status: String,
    amount_cents: i64,
    tip_cents: i64,
    stamp: String,
    refunded_cents: Option<i64>,
    #[serde(default)]
    legacy_no_stamp: bool,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Origin {
    Main,
    Phone,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CashReturn {
    table: String,
    cents: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Expected {
    #[serde(rename = "W1")]
    w1: Figures,
    #[serde(rename = "W2")]
    w2: Option<Figures>,
    payout_cents: Option<i64>,
    close_outcome: String,
    drawer_receives_cents: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Figures {
    kept_cents: i64,
    due_cents: i64,
    lines: Vec<Line>,
}

#[derive(Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
struct Line {
    table: String,
    cents: i64,
}

fn drawer(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COALESCE(driver_cash_returned_cents, 0) FROM cash_drawer_sessions
         WHERE id='collecting-drawer'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn seed_waiter_shift(conn: &Connection, status: &str) {
    conn.execute(
        "INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,status,currency,
            check_in_time,opening_cash_amount,created_at,updated_at)
         VALUES('waiter-shift','original-waiter','b1','main-terminal','server',?1,'CHF',
            ?2,0,?2,?2)",
        params![
            status,
            (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339()
        ],
    )
    .unwrap();
}

#[test]
fn wt_payment_table_waiter_keeps_cash_custody_with_or_without_cashier() {
    for cashier_status in ["active", "closed"] {
        for tip in [0.0, 1.0] {
            let db = waiter_check_cashier_fixture();
            let mut payment = waiter_check_cash_payload();
            payment["tableSessionId"] = json!("table-session");
            payment["tableCollectorShiftId"] = json!("waiter-shift");
            payment["amount"] = json!(10.5 + tip);
            payment["tipAmount"] = json!(tip);
            {
                let conn = db.conn.lock().unwrap();
                seed_waiter_shift(&conn, "active");
                conn.execute(
                    "UPDATE staff_shifts SET status=?1 WHERE id='collecting-shift'",
                    [cashier_status],
                )
                .unwrap();
                if cashier_status == "closed" {
                    conn.execute(
                        "UPDATE cash_drawer_sessions SET closed_at=?1 WHERE id='collecting-drawer'",
                        [Utc::now().to_rfc3339()],
                    )
                    .unwrap();
                }
                prepare_local_payment_currency(&conn, &mut payment).unwrap();
            }
            record_payment(&db, &payment).unwrap();
            let conn = db.conn.lock().unwrap();
            let (shift, staff, recipient): (String, String, Option<String>) = conn
                .query_row(
                    "SELECT staff_shift_id, staff_id, tip_recipient_staff_shift_id
                     FROM order_payments WHERE order_id='waiter-check'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(shift, "waiter-shift");
            assert_eq!(staff, "original-waiter");
            assert_eq!(recipient.as_deref(), (tip > 0.0).then_some("waiter-shift"));
            let cashier_cash_cents: i64 = conn
                .query_row(
                    "SELECT COALESCE(total_cash_sales_cents, 0) FROM cash_drawer_sessions
                     WHERE id='collecting-drawer'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(cashier_cash_cents, 0);
        }
    }
}

#[test]
fn wt_close_waiter_reconfirms_after_last_tip_is_reversed() {
    let db = waiter_check_cashier_fixture();
    {
        let conn = db.conn.lock().unwrap();
        seed_waiter_shift(&conn, "active");
    }
    record_payment(
        &db,
        &json!({
            "orderId": "waiter-check", "tableSessionId": "table-session", "method": "card",
            "amount": 11.5, "tipAmount": 1.0, "tipCollectorShiftId": "waiter-shift",
        }),
    )
    .unwrap();
    let preview = crate::shifts::get_shift_summary(&db, "waiter-shift").unwrap();
    assert_eq!(preview["keptTips"]["totalCents"], 100);
    assert_eq!(preview["keptTips"]["payoutCents"], 100);
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE order_payments SET status='voided' WHERE order_id='waiter-check'",
            [],
        )
        .unwrap();
    }

    let changed = crate::shifts::close_shift(
        &db,
        &json!({
            "shiftId": "waiter-shift", "closingCash": -1.0,
            "expectedWaiterKeptTips": 1.0, "expectedWaiterPayout": 1.0,
        }),
    )
    .unwrap();
    assert_eq!(changed["code"], "WAITER_CHECKOUT_CHANGED");
    let live = &changed["waiterCheckout"];
    assert_eq!(live["amountToReturn"], 0.0);
    assert_eq!(live["tipsReceived"], 0.0);
    assert_eq!(live["keptTips"]["totalCents"], 0);
    assert_eq!(live["keptTips"]["payoutCents"], 0);
    assert_eq!(drawer(&db.conn.lock().unwrap()), 0);

    let closed = crate::shifts::close_shift(
        &db,
        &json!({
            "shiftId": "waiter-shift", "closingCash": live["amountToReturn"],
            "expectedWaiterKeptTips": 0, "expectedWaiterPayout": 0,
        }),
    )
    .unwrap();
    assert_eq!(closed["success"], true);
    assert_eq!(drawer(&db.conn.lock().unwrap()), 0);
}

#[test]
fn wt_close_keeps_all_501_tips_locally_and_omits_them_on_sync() {
    let db = waiter_check_cashier_fixture();
    let order_id = Uuid::new_v4().to_string();
    {
        let conn = db.conn.lock().unwrap();
        seed_waiter_shift(&conn, "active");
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE orders SET id=?1,total_amount=495.99,total_amount_cents=49599,
                status='completed',payment_status='paid',terminal_id='main-terminal',
                created_at=?2,updated_at=?2
             WHERE id='waiter-check'",
            params![order_id, now],
        )
        .unwrap();
        conn.execute(
            "WITH RECURSIVE receipt(n) AS (
                VALUES(1) UNION ALL SELECT n+1 FROM receipt WHERE n < 501
             )
             INSERT INTO order_payments(id,order_id,method,amount,amount_cents,status,
                tip_amount,tip_amount_cents,tip_recipient_role,tip_recipient_staff_shift_id,
                staff_shift_id,currency,created_at,updated_at)
             SELECT printf('00000000-0000-4000-8000-%012d', n),?1,'card',1,100,'completed',
                0.01,1,'waiter','waiter-shift','waiter-shift','CHF',?2,?2 FROM receipt",
            params![order_id, now],
        )
        .unwrap();
    }
    let preview = crate::shifts::get_shift_summary(&db, "waiter-shift").unwrap();
    assert_eq!(preview["amountToReturn"], -5.01);
    assert_eq!(preview["keptTips"]["totalCents"], 501);
    assert_eq!(preview["keptTips"]["lines"].as_array().unwrap().len(), 501);

    let closed = crate::shifts::close_shift(
        &db,
        &json!({
            "shiftId": "waiter-shift", "closingCash": -5.01,
            "expectedWaiterKeptTips": 5.01, "expectedWaiterPayout": 5.01,
        }),
    )
    .unwrap();
    assert_eq!(closed["success"], true);
    assert_eq!(closed["expected"], -5.01);
    let frozen = crate::shifts::get_shift_summary(&db, "waiter-shift").unwrap();
    assert_eq!(frozen["keptTips"], preview["keptTips"]);
    let document =
        crate::print::build_document_for_job(&db, "shift_checkout", "waiter-shift", None).unwrap();
    let crate::receipt_renderer::ReceiptDocument::ShiftCheckout(checkout) = document else {
        panic!("expected a checkout receipt");
    };
    let printed = checkout.waiter_kept_tips.unwrap();
    assert_eq!(printed.total_cents, 501);
    assert_eq!(printed.lines.len(), 501);

    let conn = db.conn.lock().unwrap();
    assert_eq!(drawer(&conn), -501);
    let read_queued = || {
        let queued: String = conn
            .query_row(
                "SELECT data FROM parity_sync_queue WHERE table_name='staff_shifts'
                 AND record_id='waiter-shift' AND operation='UPDATE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str::<Value>(&queued).unwrap()
    };
    assert!(read_queued().get("keptTips").is_none());
    crate::shifts::replace_unfinished_shift_sync_rows_with_current_snapshot(
        &conn,
        "waiter-shift",
        &Utc::now().to_rfc3339(),
    )
    .unwrap();
    assert!(read_queued().get("keptTips").is_none());
}

#[test]
fn wt_close_waiter_snapshot_failure_reconfirms_released_cash_figures() {
    for action in [None, Some("ABORT"), Some("ROLLBACK")] {
        let db = waiter_check_cashier_fixture();
        let order_id = action.map_or_else(
            || "legacy-local-check".to_string(),
            |_| Uuid::new_v4().to_string(),
        );
        {
            let conn = db.conn.lock().unwrap();
            seed_waiter_shift(&conn, "active");
            conn.execute(
                "UPDATE orders SET id=?1 WHERE id='waiter-check'",
                [&order_id],
            )
            .unwrap();
            if let Some(action) = action {
                conn.execute_batch(&format!(
                    "CREATE TEMP TRIGGER fail_waiter_snapshot BEFORE INSERT ON local_settings
                     WHEN NEW.setting_category='shift_waiter_kept_tips'
                     BEGIN SELECT RAISE({action}, 'cannot store waiter snapshot'); END;"
                ))
                .unwrap();
            }
        }
        record_payment(
            &db,
            &json!({
                "orderId": order_id, "method": "card", "amount": 11.5, "tipAmount": 1.0,
                "tableCollectorShiftId": "waiter-shift",
            }),
        )
        .unwrap();
        let close = crate::shifts::close_shift(
            &db,
            &json!({
                "shiftId": "waiter-shift", "closingCash": -1.0,
                "expectedWaiterKeptTips": 1.0, "expectedWaiterPayout": 1.0,
            }),
        )
        .unwrap();
        let (closed, expected) = if action.is_some() {
            assert_eq!(close["code"], "WAITER_CHECKOUT_CHANGED");
            assert_eq!(close["waiterCheckout"]["keptTips"]["totalCents"], 0);
            assert_eq!(close["waiterCheckout"]["keptTips"]["payoutCents"], 0);
            let retry = crate::shifts::close_shift(
                &db,
                &json!({
                    "shiftId": "waiter-shift", "closingCash": 0,
                    "expectedWaiterKeptTips": 0, "expectedWaiterPayout": 0,
                }),
            )
            .unwrap();
            (retry, 0.0)
        } else {
            (close, -1.0)
        };
        assert_eq!(closed["success"], true);
        assert_eq!(closed["expected"], expected);
        assert_eq!(closed["closing"], expected);
        let conn = db.conn.lock().unwrap();
        assert_eq!(drawer(&conn), Cents::round_half_even(expected).as_i64());
        let queued: String = conn
            .query_row(
                "SELECT data FROM parity_sync_queue WHERE table_name='staff_shifts'
                 AND record_id='waiter-shift' AND operation='UPDATE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(serde_json::from_str::<Value>(&queued)
            .unwrap()
            .get("keptTips")
            .is_none());
    }
}

#[test]
fn wt_close_expenses_without_kept_tips_do_not_pay_out() {
    let db = waiter_check_cashier_fixture();
    {
        let conn = db.conn.lock().unwrap();
        seed_waiter_shift(&conn, "active");
        conn.execute(
            "INSERT INTO shift_expenses(id,staff_shift_id,staff_id,branch_id,
            expense_type,amount,amount_cents,currency,description,created_at,updated_at)
            VALUES('expense','waiter-shift','original-waiter','b1','other',5,500,'CHF',
                'Supplies',?1,?1)",
            [Utc::now().to_rfc3339()],
        )
        .unwrap();
    }
    let summary = crate::shifts::get_shift_summary(&db, "waiter-shift").unwrap();
    assert_eq!(summary["amountToReturn"], -5.0);
    assert_eq!(summary["keptTips"]["payoutCents"], 0);
    let closed = crate::shifts::close_shift(
        &db,
        &json!({
            "shiftId": "waiter-shift", "closingCash": 0,
            "expectedWaiterKeptTips": 0, "expectedWaiterPayout": 0,
        }),
    )
    .unwrap();
    assert_eq!(closed["success"], true);
    assert_eq!(closed["expected"], -5.0);
    assert_eq!(closed["closing"], 0.0);
    assert_eq!(drawer(&db.conn.lock().unwrap()), 0);
}

#[test]
fn wt_summary_closed_waiter_without_snapshot_keeps_reported_tips() {
    let db = waiter_check_cashier_fixture();
    {
        let conn = db.conn.lock().unwrap();
        seed_waiter_shift(&conn, "closed");
        let end = Utc::now();
        let payment_time = (end - chrono::Duration::minutes(1)).to_rfc3339();
        conn.execute(
            "UPDATE staff_shifts SET check_out_time=?1 WHERE id='waiter-shift'",
            [end.to_rfc3339()],
        )
        .unwrap();
        conn.execute(
            "UPDATE orders SET created_at=?1,updated_at=?1 WHERE id='waiter-check'",
            [&payment_time],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments(id,order_id,method,amount,amount_cents,status,
            tip_amount,tip_amount_cents,tip_recipient_staff_shift_id,currency,created_at,updated_at)
            VALUES('old-tip','waiter-check','card',11.5,1150,'completed',1,100,
                'waiter-shift','CHF',?1,?1)",
            [&payment_time],
        )
        .unwrap();
    }
    let summary = crate::shifts::get_shift_summary(&db, "waiter-shift").unwrap();
    assert_eq!(summary["tipsReceived"], 1.0);
    assert!(summary.get("keptTips").is_none());
}

#[test]
fn wt_payment_cashier_uses_current_table_waiter_or_keeps_cashier_credit() {
    for (collector_role, assignment, shift_status, expected) in [
        (
            "cashier",
            json!("current-waiter"),
            "active",
            Some("current-shift"),
        ),
        (
            "manager",
            json!("current-waiter"),
            "active",
            Some("current-shift"),
        ),
        ("cashier", json!("current-waiter"), "closed", None),
        ("cashier", Value::Null, "active", None),
    ] {
        let db = waiter_check_cashier_fixture();
        let session = Uuid::new_v4().to_string();
        let remote_order = Uuid::new_v4().to_string();
        {
            let conn = db.conn.lock().unwrap();
            seed_waiter_shift(&conn, "active");
            conn.execute(
                "UPDATE staff_shifts SET role_type=?1 WHERE id='collecting-shift'",
                [collector_role],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,
                check_in_time,status,currency,created_at,updated_at)
                VALUES('current-shift','current-waiter','b1','main-terminal','server',
                    'now',?1,'CHF','now','now')",
                [shift_status],
            )
            .unwrap();
            db::set_setting(&conn, "terminal", "organization_id", "org-test").unwrap();
            conn.execute(
                "UPDATE orders SET table_id='table-one',table_session_id=?1,supabase_id=?2
                WHERE id='waiter-check'",
                params![session, remote_order],
            )
            .unwrap();
            let scope = crate::table_session_cache::Scope {
                organization: "org-test".into(),
                branch: "b1".into(),
                terminal: "main-terminal".into(),
                owner: "main-terminal".into(),
            };
            let mut snapshot = json!({
                "id": session, "organization_id": "org-test", "branch_id": "b1",
                "status": "open", "snapshot_revision": 1, "active_order_id": remote_order,
                "opened_by_waiter_id": "original-waiter",
                "metadata": {"current_waiter_id": "original-waiter"},
                "order": {"id": remote_order, "owner_terminal_id": "main-terminal", "order_items": []},
                "balance": {"order_total": 10.5, "paid_total": 0, "outstanding_balance": 10.5, "tip_total": 0},
                "items": [], "payments": [], "tables": [{"table_id": "table-one"}],
            });
            assert!(crate::table_session_cache::save_scoped(&conn, &scope, &snapshot).unwrap());
            snapshot["snapshot_revision"] = json!(2);
            snapshot["metadata"]["current_waiter_id"] = assignment;
            assert!(crate::table_session_cache::save_scoped(&conn, &scope, &snapshot).unwrap());
        }
        record_payment(
            &db,
            &json!({
                "orderId": "waiter-check", "method": "cash", "amount": 11.5, "tipAmount": 1.0,
                "tipRecipientStaffId": "original-waiter",
            }),
        )
        .unwrap();
        let conn = db.conn.lock().unwrap();
        let (collector, role, staff, shift): (String, Option<String>, Option<String>, Option<String>) = conn.query_row(
            "SELECT staff_shift_id, tip_recipient_role, tip_recipient_staff_id, tip_recipient_staff_shift_id
             FROM order_payments WHERE order_id='waiter-check'", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(collector, "collecting-shift");
        if let Some(waiter_shift) = expected {
            assert_eq!(role.as_deref(), Some("waiter"));
            assert_eq!(staff.as_deref(), Some("current-waiter"));
            assert_eq!(shift.as_deref(), Some(waiter_shift));
        } else {
            assert_eq!(role.as_deref(), Some("cashier"));
            assert_eq!(staff.as_deref(), Some("collecting-cashier"));
            assert_eq!(shift.as_deref(), Some("collecting-shift"));
        }
    }
}

#[test]
fn wt_payment_cashier_without_cached_table_session_does_not_stamp_waiter() {
    for session in [Some("table-session"), None] {
        let db = waiter_check_cashier_fixture();
        {
            let conn = db.conn.lock().unwrap();
            seed_waiter_shift(&conn, "active");
            db::set_setting(&conn, "terminal", "organization_id", "org-test").unwrap();
            conn.execute(
                "UPDATE orders SET table_session_id=?1, table_id='table-one',
                    staff_shift_id='collecting-shift' WHERE id='waiter-check'",
                [session],
            )
            .unwrap();
        }
        record_payment(
            &db,
            &json!({
                "orderId": "waiter-check", "method": "cash", "amount": 11.5, "tipAmount": 1.0,
                "tipRecipientStaffId": "original-waiter",
            }),
        )
        .unwrap();
        let conn = db.conn.lock().unwrap();
        let stamp: Option<String> = conn
            .query_row(
                "SELECT tip_recipient_staff_shift_id
            FROM order_payments WHERE order_id='waiter-check'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stamp.as_deref(),
            Some("collecting-shift"),
            "order table session: {session:?}",
        );
    }
}

#[test]
fn wt_payment_ordinary_waiter_stamp_preserves_released_collector() {
    let db = waiter_check_cashier_fixture();
    {
        let conn = db.conn.lock().unwrap();
        seed_waiter_shift(&conn, "active");
        conn.execute(
            "UPDATE orders SET table_session_id=NULL,terminal_id='main-terminal',
                staff_shift_id='collecting-shift',staff_id='collecting-cashier'
             WHERE id='waiter-check'",
            [],
        )
        .unwrap();
    }
    record_payment(
        &db,
        &json!({
            "orderId": "waiter-check", "method": "cash", "amount": 11.5, "tipAmount": 1.0,
            "staffShiftId": "waiter-shift", "staffId": "original-waiter",
        }),
    )
    .unwrap();
    let conn = db.conn.lock().unwrap();
    let (collector, recipient): (String, String) = conn
        .query_row(
            "SELECT staff_shift_id, tip_recipient_staff_shift_id
             FROM order_payments WHERE order_id='waiter-check'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(collector, "collecting-shift");
    assert_eq!(recipient, "waiter-shift");
}

#[test]
fn wt_payment_only_tipped_table_receipts_stamp_the_waiter() {
    for (order_type, tip, expected_collector, expected_stamp) in [
        ("dine-in", 0.0, "waiter-shift", None),
        ("pickup", 1.0, "collecting-shift", None),
        ("dine-in", 1.0, "waiter-shift", Some("waiter-shift")),
    ] {
        let db = waiter_check_cashier_fixture();
        {
            let conn = db.conn.lock().unwrap();
            seed_waiter_shift(&conn, "active");
            conn.execute(
                "UPDATE orders SET order_type=?1,staff_shift_id='collecting-shift',
                staff_id='collecting-cashier' WHERE id='waiter-check'",
                [order_type],
            )
            .unwrap();
        }
        record_payment(
            &db,
            &json!({
                "orderId": "waiter-check", "method": "card", "amount": 10.5 + tip,
                "tipAmount": tip, "tableCollectorShiftId": "waiter-shift",
            }),
        )
        .unwrap();
        let conn = db.conn.lock().unwrap();
        let (collector, stamp): (String, Option<String>) = conn.query_row(
            "SELECT staff_shift_id,CASE WHEN tip_recipient_role='waiter' THEN tip_recipient_staff_shift_id END
             FROM order_payments WHERE order_id='waiter-check'",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(collector, expected_collector);
        assert_eq!(stamp.as_deref(), expected_stamp);
    }
}

#[test]
fn wt_waiter_receipts_and_close_match_shared_scenarios() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../../shared/pos/waiter-tips/__fixtures__/waiter-kept-tips-scenarios.json"
    ))
    .unwrap();
    let wire: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/waiter-tips/__fixtures__/waiter-tips-wire.json"
    ))
    .unwrap();
    for valid in wire["keptTips"]["valid"].as_array().unwrap() {
        let snapshot = crate::kept_tips::Snapshot::read_wire(valid).unwrap();
        assert_eq!(snapshot.wire_value().as_ref(), Some(valid));
    }
    for invalid in wire["keptTips"]["invalid"].as_array().unwrap() {
        assert!(crate::kept_tips::Snapshot::read_wire(invalid).is_none());
    }
    for scenario in fixture
        .scenarios
        .into_iter()
        .filter(|s| s.close != Close::MainRemote)
    {
        let name = &scenario.name;
        let db = waiter_check_cashier_fixture();
        let start = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
        let w1_staff = Uuid::new_v4().to_string();
        let w2_staff = Uuid::new_v4().to_string();
        let w1 = Uuid::new_v4().to_string();
        let w2 = Uuid::new_v4().to_string();
        let shift = |worker: &str| match worker {
            "W1" => w1.as_str(),
            "W2" => w2.as_str(),
            "C" => "collecting-shift",
            other => panic!("{name}: unknown worker {other}"),
        };
        let staff_id = |worker: &str| match worker {
            "W1" => w1_staff.as_str(),
            "W2" => w2_staff.as_str(),
            "W3off" => "off-shift",
            other => panic!("{name}: unknown waiter {other}"),
        };
        let mut receipts = BTreeMap::new();
        let mut orders = BTreeMap::new();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE staff_shifts SET check_in_time=?1", [&start])
                .unwrap();
            db::set_setting(&conn, "terminal", "organization_id", "org-test").unwrap();
            let scope = crate::table_session_cache::Scope {
                organization: "org-test".into(),
                branch: "b1".into(),
                terminal: "main-terminal".into(),
                owner: "main-terminal".into(),
            };
            // Windows stores the waiter role as `server`, including when the
            // fixture compares its figures with a literal phone waiter.
            for worker in ["W1", "W2"] {
                if worker == "W2" && scenario.expect.w2.is_none() {
                    continue;
                }
                conn.execute(
                    "INSERT INTO staff_shifts(id,staff_id,staff_name,branch_id,terminal_id,
                    role_type,status,currency,check_in_time,opening_cash_amount,opening_cash_amount_cents,
                    created_at,updated_at)
                    VALUES(?1,?2,?2,'b1','main-terminal',?3,'active','CHF',?4,?5,?6,?4,?4)",
                    params![
                        shift(worker),
                        staff_id(worker),
                        "server",
                        start,
                        Cents::new(scenario.float_cents).to_f64_dp2(),
                        scenario.float_cents
                    ],
                )
                .unwrap();
            }
            for table in &scenario.tables {
                let total: i64 = scenario
                    .payments
                    .iter()
                    .filter(|p| p.table == table.code)
                    .map(|p| p.amount_cents - p.tip_cents)
                    .sum();
                let order_id = Uuid::new_v4().to_string();
                let session = Uuid::new_v4().to_string();
                let table_id = Uuid::new_v4().to_string();
                let amount = Cents::new(total).to_f64_dp2();
                crate::table_session_cache::save_scoped(&conn, &scope, &json!({
                    "id": session, "organization_id": "org-test", "branch_id": "b1",
                    "status": "open", "snapshot_revision": 1, "active_order_id": order_id,
                    "metadata": { "current_waiter_id": staff_id(&table.waiter) },
                    "order": {"id": order_id, "owner_terminal_id": "main-terminal", "order_items": []},
                    "balance": {"order_total": amount, "paid_total": 0, "outstanding_balance": amount, "tip_total": 0},
                    "items": [], "payments": [], "tables": [{"table_id": table_id}],
                })).unwrap();
                conn.execute("INSERT INTO orders(id,items,total_amount,total_amount_cents,status,order_type,
                    payment_status,branch_id,terminal_id,table_session_id,table_id,table_number,currency,
                    created_at,updated_at)
                    VALUES(?1,'[]',?2,?3,'pending','dine-in','pending','b1','main-terminal',?4,?5,?6,'CHF',?7,?7)",
                    params![order_id, amount, total, session, table_id, table.code, start]).unwrap();
                orders.insert(&table.code, (order_id, session));
            }
        }
        for payment in &scenario.payments {
            assert_eq!(
                payment.on == Origin::Phone,
                scenario.close == Close::PhoneSelfClose,
                "{name}"
            );
            let (order, session) = &orders[&payment.table];
            let mut payload = json!({
                "orderId": order, "tableSessionId": session, "method": payment.method,
                "amount": Cents::new(payment.amount_cents).to_f64_dp2(),
                "tipAmount": Cents::new(payment.tip_cents).to_f64_dp2(),
            });
            if payment.by != "C" {
                payload["tableCollectorShiftId"] = json!(shift(&payment.by));
            }
            if payment.method == "card"
                && (payment.status != "completed" || payment.refunded_cents.is_some())
            {
                payload["transactionRef"] = json!(format!("CARD-{}", Uuid::new_v4()));
            }
            let id = if payment.legacy_no_stamp {
                let conn = db.conn.lock().unwrap();
                let mut input = build_payment_record_input(&payload).unwrap();
                input.currency = "CHF".into();
                let receipt_id = Uuid::new_v4().to_string();
                let mut options = PaymentInsertOptions::local();
                options.payment_id = Some(receipt_id.clone());
                options.remote_payment_id = Some(receipt_id);
                options.created_at = Some(start.clone());
                options.updated_at = Some(start.clone());
                options.applied_canonical_provenance = Some(AppliedCanonicalPaymentProvenance {
                    staff_id: Some(staff_id(&payment.by).into()),
                    staff_shift_id: Some(shift(&payment.by).into()),
                    metadata: None,
                });
                conn.execute_batch("BEGIN IMMEDIATE").unwrap();
                let id = insert_applied_receipt_row(&conn, &input, &options).unwrap();
                conn.execute_batch("COMMIT").unwrap();
                id
            } else {
                {
                    let conn = db.conn.lock().unwrap();
                    prepare_local_payment_currency(&conn, &mut payload)
                        .unwrap_or_else(|err| panic!("{name}: payment preflight failed: {err}"));
                }
                let receipt = record_payment(&db, &payload)
                    .unwrap_or_else(|err| panic!("{name}: payment failed: {err}"));
                receipt["paymentId"].as_str().unwrap().to_owned()
            };
            let conn = db.conn.lock().unwrap();
            let collector: String = conn
                .query_row(
                    "SELECT staff_shift_id FROM order_payments WHERE id=?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(collector, shift(&payment.by), "{name}");
            let stamp: (Option<String>, Option<String>, Option<String>) = conn.query_row(
                "SELECT tip_recipient_role, tip_recipient_staff_id, tip_recipient_staff_shift_id
                 FROM order_payments WHERE id=?1", [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            ).unwrap();
            let expected = if payment.stamp == "none" {
                if payment.tip_cents > 0 && !payment.legacy_no_stamp {
                    assert_eq!(payment.by, "C", "{name}");
                    (
                        Some("cashier".into()),
                        Some("collecting-cashier".into()),
                        Some(shift("C").into()),
                    )
                } else {
                    (None, None, None)
                }
            } else {
                (
                    Some("waiter".into()),
                    Some(staff_id(&payment.stamp).into()),
                    Some(shift(&payment.stamp).into()),
                )
            };
            assert_eq!(stamp, expected, "{name}");
            if payment.status != "completed" {
                conn.execute(
                    "UPDATE order_payments SET status=?1 WHERE id=?2",
                    params![payment.status, id],
                )
                .unwrap();
            }
            if let Some(cents) = payment.refunded_cents {
                conn.execute(
                    "INSERT INTO payment_adjustments(id,payment_id,order_id,adjustment_type,
                    amount,amount_cents,refund_method,reason,created_at,updated_at)
                    VALUES('fixture-refund',?1,?2,'refund',?3,?4,'card','fixture refund',?5,?5)",
                    params![id, order, Cents::new(cents).to_f64_dp2(), cents, start],
                )
                .unwrap();
            }
            if payment.method == "cash" {
                receipts.insert(&payment.table, id);
            }
        }
        for returned in &scenario.cash_returns {
            let conn = db.conn.lock().unwrap();
            let scope = crate::gift_financial_opening::OpeningScope {
                organization_id: "org-test".into(),
                branch_id: "b1".into(),
                terminal_id: "main-terminal".into(),
            };
            crate::staff_cash_returns::record(
                &conn,
                &scope,
                &orders[&returned.table].0,
                &json!({
                    "paymentId": receipts[&returned.table], "source_staff_id": w1_staff,
                    "source_staff_shift_id": w1, "source_role": "server",
                    "amount_cents": returned.cents, "currency": "CHF",
                }),
                "collecting-shift",
                "collecting-drawer",
                "fixture-event",
                "collecting-cashier",
                "fixture handback",
                &start,
            )
            .unwrap();
        }
        for (worker, figures) in [
            ("W1", Some(&scenario.expect.w1)),
            ("W2", scenario.expect.w2.as_ref()),
        ] {
            let Some(figures) = figures else { continue };
            let shift_id = shift(worker);
            let summary = crate::shifts::get_shift_summary(&db, shift_id).unwrap();
            assert_eq!(
                summary["keptTips"]["totalCents"], figures.kept_cents,
                "{name}/{worker}"
            );
            let mut lines: Vec<_> = summary["keptTips"]["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| Line {
                    table: line["tableCode"].as_str().unwrap().into(),
                    cents: line["cents"].as_i64().unwrap(),
                })
                .collect();
            lines.sort();
            let mut expected_lines: Vec<_> = figures
                .lines
                .iter()
                .map(|l| Line {
                    table: l.table.clone(),
                    cents: l.cents,
                })
                .collect();
            expected_lines.sort();
            assert_eq!(lines, expected_lines, "{name}/{worker}");
            assert_eq!(
                summary["amountToReturn"],
                Cents::new(figures.due_cents).to_f64_dp2(),
                "{name}"
            );
            let payout = scenario.expect.payout_cents.unwrap_or(0);
            assert_eq!(
                summary["keptTips"]["payoutCents"], payout,
                "{name}/{worker}"
            );
            if scenario.close == Close::PhoneSelfClose {
                // Founder 23/11/2026 («Ναι, στο κεντρικό»): a phone waiter who
                // keeps any tip closes at the Main. The phone's refusal itself
                // is Android's; Windows checks the contract agrees.
                assert_eq!(
                    figures.kept_cents > 0 || payout > 0,
                    scenario.expect.close_outcome == "main_close_required",
                    "{name}"
                );
                continue;
            }
            assert_eq!(scenario.expect.close_outcome, "closed", "{name}");
            let before = drawer(&db.conn.lock().unwrap());
            if payout > 0 {
                let changed = crate::shifts::close_shift(
                    &db,
                    &json!({
                        "shiftId": shift_id, "closingCash": 0, "expectedWaiterKeptTips": 0,
                        "expectedWaiterPayout": 0,
                    }),
                )
                .unwrap();
                assert_eq!(changed["code"], "WAITER_CHECKOUT_CHANGED");
                assert_eq!(drawer(&db.conn.lock().unwrap()), before);
                {
                    let conn = db.conn.lock().unwrap();
                    conn.execute("UPDATE cash_drawer_sessions SET closed_at=?1", [&start])
                        .unwrap();
                }
                assert!(crate::shifts::close_shift(
                    &db,
                    &json!({
                        "shiftId": shift_id, "closingCash": 0,
                        "expectedWaiterKeptTips": figures.kept_cents as f64 / 100.0,
                        "expectedWaiterPayout": payout as f64 / 100.0,
                    })
                )
                .unwrap_err()
                .contains("no active cashier drawer"));
                {
                    let conn = db.conn.lock().unwrap();
                    conn.execute("UPDATE cash_drawer_sessions SET closed_at=NULL", [])
                        .unwrap();
                }
            }
            let closed = crate::shifts::close_shift(
                &db,
                &json!({
                    "shiftId": shift_id, "closingCash": Cents::new(figures.due_cents).to_f64_dp2(),
                    "expectedWaiterKeptTips": Cents::new(figures.kept_cents).to_f64_dp2(),
                    "expectedWaiterPayout": Cents::new(payout).to_f64_dp2(),
                }),
            )
            .unwrap_or_else(|err| panic!("{name}: close failed: {err}"));
            assert_eq!(closed["success"], true, "{name}: {closed}");
            let after = drawer(&db.conn.lock().unwrap());
            assert_eq!(
                after - before,
                if worker == "W1" {
                    scenario
                        .expect
                        .drawer_receives_cents
                        .unwrap_or(figures.due_cents)
                } else {
                    figures.due_cents
                },
                "{name}/{worker}"
            );
            {
                let conn = db.conn.lock().unwrap();
                let close: String = conn
                    .query_row(
                        "SELECT data FROM parity_sync_queue WHERE table_name='staff_shifts'
                     AND record_id=?1 AND operation='UPDATE' ORDER BY created_at DESC LIMIT 1",
                        [shift_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                let close: Value = serde_json::from_str(&close).unwrap();
                if figures.kept_cents > 0 {
                    assert_eq!(close["keptTips"], summary["keptTips"], "{name}/{worker}");
                } else {
                    assert!(close.get("keptTips").is_none(), "{name}/{worker}");
                }
                conn.execute(
                    "UPDATE order_payments SET tip_amount=0,tip_amount_cents=0
                    WHERE tip_recipient_staff_shift_id=?1",
                    [shift_id],
                )
                .unwrap();
            }
            let frozen = crate::shifts::get_shift_summary(&db, shift_id).unwrap();
            assert_eq!(frozen["keptTips"], summary["keptTips"], "{name}/{worker}");
        }
    }
}
