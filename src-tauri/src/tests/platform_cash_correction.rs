use chrono::{Duration, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::commands::orders;
use crate::gift_financial_opening::OpeningScope;
use crate::manual_order_cancellation::{self, tests as manual_cancel};
use crate::payment_review::{self, SetAsideReason};
use crate::payments::{self, PaymentInsertOptions};
use crate::tests::{fake_keyring, harness::TestDb};
use crate::{order_ownership, refunds, shifts};

const ORG: &str = "00000000-0000-4000-8000-000000000001";
const BRANCH: &str = "00000000-0000-4000-8000-000000000002";
const TILL: &str = "00000000-0000-4000-8000-000000000003";
const DRIVER: &str = "00000000-0000-4000-8000-000000000004";
const DRIVER_SHIFT: &str = "00000000-0000-4000-8000-000000000005";
const CASHIER: &str = "00000000-0000-4000-8000-000000000006";
const CASHIER_SHIFT: &str = "00000000-0000-4000-8000-000000000007";
const REMOTE: &str = "00000000-0000-4000-8000-000000000008";
const ORDER: &str = "00000000-0000-4000-8000-000000000009";
const PAYMENT: &str = "00000000-0000-4000-8000-000000000010";
const DRAWER: &str = "00000000-0000-4000-8000-000000000011";
const COD: &str = r#"{"food_delivery":{"payment_method":"cash","prepaid":false,"delivery_provider":"vendor_delivery","short_code":"2015"}}"#;
const SERVER_PAYMENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn fixture() -> (TestDb, fake_keyring::Guard, String) {
    let keyring = fake_keyring::install_seeded([
        ("terminal_id", TILL),
        ("branch_id", BRANCH),
        ("organization_id", ORG),
    ]);
    let db = TestDb::open();
    let check_in = (Utc::now() - Duration::minutes(15)).to_rfc3339();
    let order_at = (Utc::now() - Duration::minutes(5)).to_rfc3339();
    {
        let conn = db.state.conn.lock().unwrap();
        for (category, key, value) in [
            ("terminal", "terminal_id", TILL),
            ("terminal", "branch_id", BRANCH),
            ("terminal", "organization_id", ORG),
            ("general", "language", "en"),
            ("restaurant", "store_currency_branch_id", BRANCH),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
            ("restaurant", "currency", "EUR"),
        ] {
            crate::db::set_setting(&conn, category, key, value).unwrap();
        }
        seed_shift(
            &conn,
            (DRIVER_SHIFT, DRIVER, "Nikos", "driver"),
            TILL,
            0,
            &check_in,
        );
        seed_shift(
            &conn,
            (CASHIER_SHIFT, CASHIER, "Maria", "cashier"),
            TILL,
            10000,
            &check_in,
        );
        conn.execute(
            "INSERT INTO cash_drawer_sessions (id,staff_shift_id,cashier_id,branch_id,terminal_id,
                 opening_amount,opening_amount_cents,opened_at,created_at,updated_at,currency)
             VALUES (?1,?2,?3,?4,?5,100,10000,?6,?6,?6,'EUR')",
            params![DRAWER, CASHIER_SHIFT, CASHIER, BRANCH, TILL, check_in],
        )
        .unwrap();
    }
    (db, keyring, order_at)
}

fn seed_shift(
    conn: &Connection,
    (id, staff, name, role): (&str, &str, &str, &str),
    terminal: &str,
    opening: i64,
    at: &str,
) {
    conn.execute(
        "INSERT INTO staff_shifts (id,staff_id,staff_name,role_type,branch_id,terminal_id,
             check_in_time,opening_cash_amount,opening_cash_amount_cents,status,calculation_version,
             sync_status,created_at,updated_at,currency)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'active',2,'pending',?7,?7,'EUR')",
        params![
            id,
            staff,
            name,
            role,
            BRANCH,
            terminal,
            at,
            opening as f64 / 100.0,
            opening
        ],
    )
    .unwrap();
}

fn seed_order(conn: &Connection, at: &str, plugin: Option<&str>, metadata: Option<&str>) {
    conn.execute(
        "INSERT INTO orders (id,supabase_id,order_number,items,order_type,total_amount,total_amount_cents,
             status,payment_status,sync_status,branch_id,terminal_id,plugin,external_plugin_order_id,
             ghost_metadata,created_at,updated_at,currency)
         VALUES (?1,?2,'2015','[]','delivery',15,1500,'ready','pending','synced',?3,?4,
                 ?5,CASE WHEN ?5 IS NULL THEN NULL ELSE 'ext' END,?6,?7,?7,'EUR')",
        params![ORDER, REMOTE, BRANCH, TILL, plugin, metadata, at],
    ).unwrap();
}

fn assign(conn: &Connection, at: &str) {
    let assignment = order_ownership::assign_order_to_driver_shift(
        conn,
        ORDER,
        DRIVER,
        Some("Nikos"),
        DRIVER_SHIFT,
        at,
    )
    .unwrap();
    order_ownership::upsert_driver_earning(conn, ORDER, DRIVER, &assignment, at).unwrap();
}

fn record(conn: &Connection, id: &str, amount: f64, tender: &str, at: &str, cashier: bool) {
    let mut payload = json!({
        "orderId": ORDER, "method": tender, "amount": amount, "currency": "EUR",
        "paymentOrigin": "manual", "idempotencyKey": id,
        "staffId": if cashier { CASHIER } else { DRIVER },
        "staffShiftId": if cashier { CASHIER_SHIFT } else { DRIVER_SHIFT },
    });
    if cashier {
        payload["collectedBy"] = json!("cashier_drawer");
    }
    let input = payments::build_payment_record_input(&payload).unwrap();
    let mut options = PaymentInsertOptions::local();
    options.payment_id = Some(id.into());
    options.created_at = Some(at.into());
    let receipt = payments::record_payment_in_connection(conn, &input, &options).unwrap();
    assert_eq!(receipt.payment_id, id);
    assert_eq!(receipt.payment_origin, "manual");
}

/// An ordinary cash payment on a platform cash order, stamped with the
/// driver's staff and shift: the row every design under discussion ends in.
fn record_driver_cash(conn: &Connection, at: &str) {
    let tx = conn.unchecked_transaction().unwrap();
    record(&tx, PAYMENT, 15.0, "cash", at, false);
    order_ownership::refresh_existing_driver_earning_payment_snapshot(&tx, ORDER, at).unwrap();
    tx.commit().unwrap();
}

fn mark_receipt_synced(conn: &Connection, payment_id: &str) {
    conn.execute(
        "UPDATE order_payments SET remote_payment_id=?1,sync_state='applied',sync_status='synced'
         WHERE id=?2",
        params![SERVER_PAYMENT, payment_id],
    )
    .unwrap();
}

fn phone_driver_cash_fixture() -> (TestDb, fake_keyring::Guard, String) {
    let (db, guard, at) = fixture();
    {
        let conn = db.state.conn.lock().unwrap();
        seed_order(&conn, &at, None, None);
        assign(&conn, &at);
        record_driver_cash(&conn, &at);
        mark_receipt_synced(&conn, PAYMENT);
    }
    (db, guard, at)
}

fn driver_cash_fixture() -> (TestDb, fake_keyring::Guard, String) {
    let (db, guard, at) = fixture();
    {
        let conn = db.state.conn.lock().unwrap();
        seed_order(&conn, &at, Some("efood"), Some(COD));
        assign(&conn, &at);
        record_driver_cash(&conn, &at);
        let owner: (String, String, Option<String>) = conn
            .query_row(
                "SELECT staff_id,staff_shift_id,metadata FROM order_payments WHERE id=?1",
                [PAYMENT],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(owner, (DRIVER.into(), DRIVER_SHIFT.into(), None));
    }
    (db, guard, at)
}

fn void(db: &TestDb) {
    let answer =
        refunds::void_payment_with_adjustment(&db.state, PAYMENT, "Cash correction", None, None)
            .unwrap();
    assert_eq!(answer["success"], true);
}

fn close(db: &TestDb, shift: &str, count: f64) -> Value {
    let answer =
        shifts::close_shift(&db.state, &json!({"shiftId":shift,"closingCash":count})).unwrap();
    assert_eq!(answer["success"], true, "{answer}");
    answer
}

fn earning(db: &TestDb) -> (i64, i64) {
    db.state.conn.lock().unwrap().query_row(
        "SELECT cash_collected_cents,cash_to_return_cents FROM driver_earnings WHERE order_id=?1",
        [ORDER], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap()
}

fn expected_return(db: &TestDb) -> Value {
    shifts::get_shift_summary(&db.state, DRIVER_SHIFT).unwrap()["amountToReturn"].clone()
}

fn frozen_close(db: &TestDb) -> (i64, i64, i64) {
    db.state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT expected_cash_amount_cents,closing_cash_amount_cents,cash_variance_cents
         FROM staff_shifts WHERE id=?1",
            [DRIVER_SHIFT],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn drawer_movements(db: &TestDb) -> (i64, i64, i64) {
    db.state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COALESCE(total_cash_sales_cents,0),COALESCE(driver_cash_returned_cents,0),
                COALESCE(total_refunds_cents,0) FROM cash_drawer_sessions WHERE id=?1",
            [DRAWER],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn adopt_remote_cancel(db: &TestDb) {
    let conn = db.state.conn.lock().unwrap();
    // The assignment has already been acknowledged. Exercise the released
    // remote apply, including its rules around kept local financial receipts.
    conn.execute(
        "UPDATE orders SET sync_status='synced' WHERE id=?1",
        [ORDER],
    )
    .unwrap();
    let error = crate::sync::apply_remote_orders_page_for_test(
        &conn,
        vec![json!({
            "id": REMOTE, "status":"cancelled", "payment_status":"paid", "payment_method":"cash",
            "cancellation_reason":"Cancelled on platform", "updated_at":Utc::now().to_rfc3339(),
        })],
    );
    assert!(error.is_none(), "{error:?}");
    let status: String = conn
        .query_row("SELECT status FROM orders WHERE id=?1", [ORDER], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(status, "cancelled");
}

fn notice(db: &TestDb, id: &str) -> Value {
    serde_json::to_value(crate::platform_cash_notice::read_for_notice(&db.state, id)).unwrap()
}

fn driver_notice(amount: i64, name: Option<&str>) -> Value {
    json!({"state":"driver_cash","amountCents":amount,"currency":"EUR","collectorName":name})
}

#[test]
fn notice_reads_local_and_remote_ids_partial_refunds_and_closed_custody() {
    let (db, _guard, _) = driver_cash_fixture();
    assert_eq!(notice(&db, ORDER), driver_notice(1500, Some("Nikos")));
    assert_eq!(notice(&db, REMOTE), notice(&db, ORDER));
    let answer = refunds::refund_payment(
        &db.state,
        &json!({"paymentId":PAYMENT,"amount":4,"reason":"Partial"}),
    )
    .unwrap();
    assert_eq!(answer["cashHandler"], "driver_shift");
    assert_eq!(notice(&db, ORDER), driver_notice(1100, Some("Nikos")));
    close(&db, DRIVER_SHIFT, 11.0);
    assert_eq!(notice(&db, ORDER), driver_notice(1100, Some("Nikos")));
    for name in ["", " ", DRIVER] {
        db.state
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE staff_shifts SET staff_name=?1 WHERE id=?2",
                params![name, DRIVER_SHIFT],
            )
            .unwrap();
        assert_eq!(notice(&db, ORDER), driver_notice(1100, None));
    }
}

#[test]
fn notice_after_change_driver_follows_the_staff_cash_return_planner() {
    const OTHER_DRIVER: &str = "00000000-0000-4000-8000-000000000012";
    const OTHER_SHIFT: &str = "00000000-0000-4000-8000-000000000013";
    const MANAGER: &str = "00000000-0000-4000-8000-000000000014";
    let (db, _guard, at) = driver_cash_fixture();
    {
        let mut conn = db.state.conn.lock().unwrap();
        seed_shift(
            &conn,
            (OTHER_SHIFT, OTHER_DRIVER, "Eleni", "driver"),
            TILL,
            0,
            &at,
        );
        let actor = orders::DriverChangeActor {
            staff_id: Some(CASHIER.into()),
            approved_by: Some(MANAGER.into()),
            approval_via: Some("manager_pin".into()),
        };
        orders::change_order_driver_locally(
            &mut conn,
            ORDER,
            OTHER_DRIVER,
            &actor,
            &Utc::now().to_rfc3339(),
        )
        .unwrap();
        mark_receipt_synced(&conn, PAYMENT);
        let plan = crate::staff_cash_returns::plan(&conn, ORDER).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0]["source_staff_id"], OTHER_DRIVER);
        assert_eq!(plan[0]["amount_cents"], 1500);
    }
    assert_eq!(notice(&db, ORDER), driver_notice(1500, Some("Eleni")));
}

#[test]
fn notice_returns_null_for_no_cash_cashier_void_and_read_failure() {
    {
        let (db, _guard, at) = fixture();
        {
            let conn = db.state.conn.lock().unwrap();
            seed_order(&conn, &at, None, None);
        }
        assert_eq!(notice(&db, ORDER), Value::Null);
        record(
            &db.state.conn.lock().unwrap(),
            PAYMENT,
            15.0,
            "cash",
            &at,
            true,
        );
        assert_eq!(notice(&db, ORDER), Value::Null);
        db.state
            .conn
            .lock()
            .unwrap()
            .execute_batch("ALTER TABLE payment_adjustments RENAME TO unreadable_adjustments")
            .unwrap();
        assert_eq!(notice(&db, ORDER), Value::Null);
    }
    let (db, _guard, _) = driver_cash_fixture();
    void(&db);
    assert_eq!(notice(&db, ORDER), Value::Null);
}

#[test]
fn notice_checks_mixed_collectors_and_inconsistent_amounts() {
    let (db, _guard, at) = driver_cash_fixture();
    let answer = refunds::refund_payment(
        &db.state,
        &json!({"paymentId":PAYMENT,"amount":2,"reason":"Partial"}),
    )
    .unwrap();
    assert_eq!(answer["cashHandler"], "driver_shift");
    {
        let conn = db.state.conn.lock().unwrap();
        record(&conn, "second", 2.0, "cash", &at, true);
    }
    assert_eq!(notice(&db, ORDER), json!({"state":"check"}));
    {
        let conn = db.state.conn.lock().unwrap();
        conn.execute("DELETE FROM order_payments WHERE id='second'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO payment_adjustments (id,payment_id,order_id,adjustment_type,
                      amount,amount_cents,reason,created_at,updated_at)
                      VALUES ('bad',?1,?2,'refund',16,1600,'bad',?3,?3)",
            params![PAYMENT, ORDER, at],
        )
        .unwrap();
    }
    assert_eq!(notice(&db, ORDER), json!({"state":"check"}));
}

#[test]
fn notice_keeps_driver_cash_after_a_drawer_or_bank_refund() {
    for method in ["cash", "card"] {
        let (db, _guard, _) = driver_cash_fixture();
        let drawer_pays = method == "cash";
        if drawer_pays {
            db.state
                .conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE driver_earnings SET settled=1 WHERE order_id=?1",
                    [ORDER],
                )
                .unwrap();
        }
        for amount in [4, 11] {
            let answer = refunds::refund_payment(
                &db.state,
                &json!({"paymentId":PAYMENT,"amount":amount,"refundMethod":method,"reason":"Return",
                        "staffShiftId":drawer_pays.then_some(CASHIER_SHIFT)}),
            )
            .unwrap();
            assert_eq!(
                answer["cashHandler"],
                if drawer_pays {
                    json!("cashier_drawer")
                } else {
                    Value::Null
                }
            );
            assert_eq!(notice(&db, ORDER), driver_notice(1500, Some("Nikos")));
        }
        assert_eq!(
            drawer_movements(&db),
            (0, 0, if drawer_pays { 1500 } else { 0 })
        );
    }
}

#[test]
fn notice_checks_a_driver_funded_refund_of_cashiers_split_receipt() {
    let (db, _guard, at) = fixture();
    {
        let conn = db.state.conn.lock().unwrap();
        seed_order(&conn, &at, Some("efood"), Some(COD));
        assign(&conn, &at);
        record(&conn, "cashier-part", 4.0, "cash", &at, true);
        record(&conn, PAYMENT, 11.0, "cash", &at, false);
        order_ownership::refresh_existing_driver_earning_payment_snapshot(&conn, ORDER, &at)
            .unwrap();
    }
    let answer = refunds::refund_payment(
        &db.state,
        &json!({"paymentId":"cashier-part","amount":4,"refundMethod":"cash","reason":"Return"}),
    )
    .unwrap();
    assert_eq!(answer["cashHandler"], "driver_shift");
    assert_eq!(answer["fullyRefunded"], true);
    assert_eq!(notice(&db, ORDER), json!({"state":"check"}));
}

#[test]
fn notice_counts_a_verified_handback_once_and_checks_wrong_collector_or_currency() {
    let (db, _guard, at) = driver_cash_fixture();
    let receipt = {
        let conn = db.state.conn.lock().unwrap();
        mark_receipt_synced(&conn, PAYMENT);
        let source = crate::staff_cash_returns::plan(&conn, ORDER)
            .unwrap()
            .remove(0);
        let scope = OpeningScope::resolve(&conn).unwrap();
        crate::staff_cash_returns::record(
            &conn,
            &scope,
            ORDER,
            &source,
            CASHIER_SHIFT,
            DRAWER,
            "notice-handback",
            CASHIER,
            "Cash handed in",
            &at,
        )
        .unwrap()
    };
    assert_eq!(notice(&db, ORDER), Value::Null);
    for (staff, unit) in [("different-collector", "EUR"), (DRIVER, "CHF")] {
        db.state
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE staff_order_cash_returns SET source_staff_id=?1,currency=?2 WHERE id=?3",
                params![staff, unit, receipt["id"].as_str().unwrap()],
            )
            .unwrap();
        assert_eq!(notice(&db, ORDER), json!({"state":"check"}));
    }
}

#[test]
fn notice_counts_full_handback_linked_to_a_cashier_refund() {
    let (db, _guard, at) = phone_driver_cash_fixture();
    let conn = db.state.conn.lock().unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let scope = OpeningScope::resolve(&tx).unwrap();
    let source = crate::staff_cash_returns::plan(&tx, ORDER)
        .unwrap()
        .remove(0);
    let event = "cash-handback";
    let reason = "Return";
    let receipt = crate::staff_cash_returns::record(
        &tx,
        &scope,
        ORDER,
        &source,
        CASHIER_SHIFT,
        DRAWER,
        event,
        CASHIER,
        reason,
        &at,
    )
    .unwrap();
    let refund = refunds::refund_manual_cancellation_in_connection(
        &tx,
        &json!({"paymentId":PAYMENT,"amount":15,"reason":reason,
                "staffId":CASHIER,"staffShiftId":CASHIER_SHIFT,
                "refundMethod":"cash","cashHandler":"cashier_drawer",
                "idempotencyKey":format!("manual-cancel:{event}:{PAYMENT}")}),
    )
    .unwrap();
    let adjustment = refund["adjustmentId"].as_str().unwrap();
    crate::staff_cash_returns::enqueue(&tx, &source, &receipt, CASHIER, reason, Some(adjustment))
        .unwrap();
    let linked: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM staff_order_cash_returns WHERE adjustment_id=?1)",
            [adjustment],
            |row| row.get(0),
        )
        .unwrap();
    assert!(linked);
    tx.commit().unwrap();
    drop(conn);
    assert_eq!(notice(&db, ORDER), Value::Null);
    assert_eq!(drawer_movements(&db), (0, 1500, 1500));
}

#[test]
fn notice_prioritizes_a_live_review_and_clears_a_resolved_one() {
    let (db, _guard, at) = fixture();
    {
        let conn = db.state.conn.lock().unwrap();
        seed_order(&conn, &at, Some("efood"), Some(COD));
        assign(&conn, &at);
        record(&conn, "under-review", 2.0, "cash", &at, true);
        payment_review::set_aside_payment_in_connection(
            &conn,
            "under-review",
            SetAsideReason::ReconciliationRequired,
            None,
            &at,
        )
        .unwrap();
        record_driver_cash(&conn, &at);
    }
    assert_eq!(notice(&db, ORDER), json!({"state":"review"}));
    void(&db);
    assert_eq!(notice(&db, ORDER), json!({"state":"review"}));
    payment_review::resolve_set_aside_payment_in_connection(
        &db.state.conn.lock().unwrap(),
        "under-review",
        Some(CASHIER),
        &at,
    )
    .unwrap();
    assert_eq!(notice(&db, ORDER), Value::Null);
}

#[test]
fn active_void_releases_fifteen_and_allows_local_cancel() {
    let (db, _guard, _) = driver_cash_fixture();
    assert_eq!(earning(&db), (1500, 1500));
    assert_eq!(expected_return(&db), 15.0);
    void(&db);
    assert_eq!(earning(&db), (0, 0));
    assert_eq!(expected_return(&db), 0.0);
    assert_eq!(drawer_movements(&db), (0, 0, 0));
    orders::decline_order_locally(&db.state, ORDER, "No cash taken", &Utc::now().to_rfc3339())
        .unwrap();
    db.state
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT status FROM orders WHERE id=?1", [ORDER], |row| {
            assert_eq!(row.get::<_, String>(0)?, "cancelled");
            Ok(())
        })
        .unwrap();
}

#[test]
fn void_after_checkout_preserves_the_zero_count_and_fifteen_short() {
    let (db, _guard, _) = driver_cash_fixture();
    adopt_remote_cancel(&db);
    close(&db, DRIVER_SHIFT, 0.0);
    assert_eq!(frozen_close(&db), (1500, 0, -1500));
    void(&db);
    assert_eq!(frozen_close(&db), (1500, 0, -1500));
    assert_eq!(earning(&db), (1500, 1500));
    assert_eq!(drawer_movements(&db), (0, 0, 0));
    assert_eq!(close(&db, CASHIER_SHIFT, 100.0)["expected"], 100.0);
}

#[test]
fn a_void_on_a_live_order_leaves_it_unpaid_and_the_cashier_close_waits_as_today() {
    let (db, _guard, _) = driver_cash_fixture();
    close(&db, DRIVER_SHIFT, 0.0);
    void(&db);
    let answer = shifts::close_shift(
        &db.state,
        &json!({"shiftId":CASHIER_SHIFT,"closingCash":100.0}),
    )
    .unwrap();
    assert_eq!(answer["success"], false, "{answer}");
    assert_eq!(answer["errorCode"], "UNSETTLED_PAYMENT_BLOCKER");
    assert_eq!(answer["blockers"][0]["reasonCode"], "no_persisted_payment");
}

#[test]
fn remote_cancel_keeps_the_receipt_and_driver_return() {
    let (db, _guard, _) = driver_cash_fixture();
    adopt_remote_cancel(&db);
    let status: String = db
        .state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT status FROM order_payments WHERE id=?1",
            [PAYMENT],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(earning(&db), (1500, 1500));
    assert_eq!(expected_return(&db), 15.0);
    assert_eq!(close(&db, DRIVER_SHIFT, 15.0)["expected"], 15.0);
}

fn z_report(db: &TestDb) -> Value {
    let response =
        crate::zreport::preview_z_report_for_date(&db.state, &json!({"branchId":BRANCH})).unwrap();
    assert_eq!(response["success"], true, "{response}");
    response["report"]["reportJson"].clone()
}

fn enable_platform_cash(conn: &Connection) {
    crate::db::set_setting(
        conn,
        "terminal",
        "enabled_features",
        r#"{"platform_driver_cash_auto":true}"#,
    )
    .unwrap();
}

fn cash_receipt_owner(conn: &Connection, payment_id: &str) -> (String, String) {
    conn.query_row(
        "SELECT staff_id,staff_shift_id FROM order_payments WHERE id=?1",
        [payment_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[test]
fn phone_cash_recorded_at_entry_returns_to_the_cashier_before_cancelling() {
    let (db, _guard, at) = fixture();
    {
        let conn = db.state.conn.lock().unwrap();
        seed_order(&conn, &at, None, None);
        record(&conn, PAYMENT, 15.0, "cash", &at, true);
        assert_eq!(
            cash_receipt_owner(&conn, PAYMENT),
            (CASHIER.to_owned(), CASHIER_SHIFT.to_owned())
        );
        mark_receipt_synced(&conn, PAYMENT);
    }
    assert_eq!(drawer_movements(&db), (1500, 0, 0));
    {
        let conn = db.state.conn.lock().unwrap();
        orders::assign_driver_locally(&conn, ORDER, DRIVER, None, &Utc::now().to_rfc3339())
            .unwrap();
    }
    staff_return_and_cancel(&db, PAYMENT, "phone");
}

#[test]
fn staff_return_and_cancel_takes_the_cash_off_the_driver() {
    let (db, _guard, at) = fixture();
    let payment_id: String = {
        let conn = db.state.conn.lock().unwrap();
        seed_order(&conn, &at, Some("efood"), Some(COD));
        enable_platform_cash(&conn);
        let now = Utc::now().to_rfc3339();
        crate::db::set_setting(
            &conn,
            "device_admission",
            "cash_register",
            &json!({
                "admitted":false, "fetchedAt":now, "organizationId":ORG,
                "branchId":BRANCH, "terminalId":TILL,
            })
            .to_string(),
        )
        .unwrap();
        use crate::fiscal::active_cache::{pin_for_test, CacheVerdict};
        pin_for_test(BRANCH, CacheVerdict::Inactive);
        orders::assign_driver_locally_with_platform_cash(
            &conn,
            ORDER,
            DRIVER,
            None,
            &now,
            orders::DriverAssignmentCash::Direct {
                actor: Some(CASHIER),
            },
        )
        .unwrap();
        let payment_id: String = conn
            .query_row(
                "SELECT json_extract(payload_json,'$.paymentId') FROM recovery_action_log
                 WHERE order_id=?1 AND action_id='platform_cash_at_assignment' AND success=1",
                [ORDER],
                |row| row.get(0),
            )
            .expect("automatic writer must record and audit the receipt");
        mark_receipt_synced(&conn, &payment_id);
        payment_id
    };
    staff_return_and_cancel(&db, &payment_id, "platform");
}

fn staff_return_and_cancel(db: &TestDb, payment_id: &str, flow: &str) {
    assert_eq!(earning(db), (1500, 1500), "{flow}");
    assert_eq!(expected_return(db), 15.0, "{flow}");
    assert_eq!(drawer_movements(db), (0, 0, 0), "{flow}");
    {
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            cash_receipt_owner(&conn, payment_id),
            (DRIVER.to_owned(), DRIVER_SHIFT.to_owned()),
            "{flow}"
        );
        let plan = manual_cancel::prepare(&conn, ORDER).unwrap();
        assert_eq!(plan["requiresReturn"], true);
        assert_eq!(plan["requiresHandback"], true);
        assert_eq!(plan["amountCents"], 1500);
        let result = manual_cancel::commit(
            &conn,
            &json!({
                "orderId":ORDER, "reason":"Customer did not open", "returnChannel":"cash_drawer",
                "requestId":"return-and-cancel", "generation":plan["generation"],
            }),
            CASHIER,
        )
        .unwrap();
        assert_eq!(result["success"], true);
        let (order_status, payment_status, refunded): (String, String, i64) = conn
            .query_row(
                "SELECT o.status,p.status,a.amount_cents FROM orders o
                 JOIN order_payments p ON p.order_id=o.id
                 JOIN payment_adjustments a ON a.payment_id=p.id AND a.adjustment_type='refund'
                 WHERE o.id=?1 AND p.id=?2",
                params![ORDER, payment_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (order_status.as_str(), payment_status.as_str(), refunded),
            ("cancelled", "refunded", 1500)
        );
        let queued_reason: String = conn
            .query_row(
                "SELECT json_extract(data,'$.cancellationReason') FROM parity_sync_queue
                 WHERE table_name='orders' AND record_id=?1 AND json_extract(data,'$.status')='cancelled'",
                [ORDER],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queued_reason, "Customer did not open");
    }
    let summary = shifts::get_shift_summary(&db.state, DRIVER_SHIFT).unwrap();
    let delivery = &summary["driverDeliveries"][0];
    assert_eq!(delivery["cash_collected"], 0.0);
    assert_eq!(delivery["cash_to_return"], 0.0);
    assert_eq!(summary["amountToReturn"], 0.0);
    assert_eq!(drawer_movements(db), (0, 1500, 1500), "{flow}");
    let driver = close(db, DRIVER_SHIFT, 0.0);
    let cashier = close(db, CASHIER_SHIFT, 100.0);
    eprintln!(
        "{flow}: driver expected {} variance {}; cashier expected {} variance {}",
        driver["expected"], driver["variance"], cashier["expected"], cashier["variance"]
    );
    assert_eq!(driver["expected"], 0.0, "{flow}");
    assert_eq!(driver["variance"], 0.0, "{flow}");
    assert_eq!(frozen_close(db), (0, 0, 0), "{flow}");
    assert_eq!(cashier["expected"], 100.0, "{flow}");
    assert_eq!(cashier["variance"], 0.0, "{flow}");
    assert_z_full_cash_correction(db);
}

#[test]
fn platform_manual_return_requires_the_rollout_switch() {
    let (db, _guard, _) = driver_cash_fixture();
    let conn = db.state.conn.lock().unwrap();
    mark_receipt_synced(&conn, PAYMENT);
    enable_platform_cash(&conn);
    let plan = manual_cancel::prepare(&conn, ORDER).unwrap();
    assert_eq!(plan["requiresReturn"], true);
    assert_eq!(plan["requiresHandback"], true);
    assert_eq!(plan["amountCents"], 1500);

    conn.execute(
        "DELETE FROM local_settings WHERE setting_category='terminal' AND setting_key='enabled_features'",
        [],
    )
    .unwrap();
    assert_platform_return_refused(&conn, &plan, "missing");
    for (case, raw) in [
        ("off", r#"{"platform_driver_cash_auto":false}"#),
        ("unreadable", "{"),
    ] {
        crate::db::set_setting(&conn, "terminal", "enabled_features", raw).unwrap();
        assert_platform_return_refused(&conn, &plan, case);
    }
    enable_platform_cash(&conn);
    let committed = manual_cancel::commit(
        &conn,
        &json!({
            "orderId":ORDER, "reason":"Return", "returnChannel":"cash_drawer",
            "requestId":"enabled-return", "generation":plan["generation"],
        }),
        CASHIER,
    )
    .unwrap();
    assert_eq!(committed["success"], true);
}

#[test]
fn platform_manual_return_refusals_write_nothing() {
    let settlement_ref = Some("platform_settlement:cod:order");
    let external_courier = json!({
        "food_delivery": json!({
            "platform":"efood", "payment_method":"cash", "prepaid":false,
            "delivery_provider":"platform_delivery",
        }).to_string(),
    })
    .to_string();
    for (case, order_status, metadata, extra_receipt) in [
        (
            "prepaid",
            "delivered",
            Some(
                r#"{"food_delivery":{"prepaid":true,"payment_method":"online","delivery_provider":"vendor_delivery"}}"#,
            ),
            None,
        ),
        // Pending bypasses the earlier platform-courier status guard.
        (
            "platform held",
            "pending",
            Some(
                r#"{"food_delivery":{"payment_method":"cash","delivery_provider":"platform_delivery"}}"#,
            ),
            None,
        ),
        (
            "mixed cash and card",
            "delivered",
            Some(COD),
            Some(("card", "manual", "completed", None)),
        ),
        (
            "settlement",
            "delivered",
            Some(COD),
            Some(("other", "manual", "completed", settlement_ref)),
        ),
        (
            "voided settlement without disposition",
            "pending",
            Some(COD),
            Some(("other", "manual", "voided", settlement_ref)),
        ),
        (
            "unproven cash",
            "delivered",
            Some(COD),
            Some(("cash", "terminal", "completed", None)),
        ),
        (
            "canonical check unavailable",
            "delivered",
            Some(COD),
            Some(("cash", "sync_reconstructed", "completed", None)),
        ),
        (
            "metadata-only external courier",
            "delivered",
            Some(external_courier.as_str()),
            None,
        ),
        (
            "stringified external courier",
            "pending",
            Some(external_courier.as_str()),
            None,
        ),
        (
            "receipt in review",
            "delivered",
            Some(COD),
            Some(("card", "manual", "duplicate_review", None)),
        ),
        ("unresolved gift debit", "delivered", Some(COD), None),
        ("unsaved charge", "delivered", Some(COD), None),
    ] {
        let (db, _guard, at) = driver_cash_fixture();
        let conn = db.state.conn.lock().unwrap();
        enable_platform_cash(&conn);
        mark_receipt_synced(&conn, PAYMENT);
        let original = manual_cancel::prepare(&conn, ORDER).unwrap();
        conn.execute(
            "UPDATE orders SET status=?1,ghost_metadata=?2 WHERE id=?3",
            params![order_status, metadata, ORDER],
        )
        .unwrap();
        match case {
            "metadata-only external courier" => {
                conn.execute(
                    "UPDATE orders SET plugin='',external_plugin_order_id=NULL WHERE id=?1",
                    [ORDER],
                )
                .unwrap();
            }
            "unresolved gift debit" => {
                conn.execute(
                    "INSERT INTO gift_card_redemption_attempts(
                        idempotency_key,organization_id,branch_id,terminal_id,local_order_id,
                        remote_order_id,amount_cents,currency,card_fingerprint,request_fingerprint,
                        status,created_at,updated_at)
                     VALUES ('gift-key',?1,?2,?3,?4,?5,100,'EUR','card','request','remote_applied',?6,?6)",
                    params![ORG, BRANCH, TILL, ORDER, REMOTE, at],
                )
                .unwrap();
            }
            "unsaved charge" => {
                let unsaved = crate::unsaved_payments::UnsavedChargedPayment::for_payment(
                    REMOTE,
                    &json!({"orderId":REMOTE,"method":"card","amount":1.0,"currency":"EUR",
                           "idempotencyKey":"unsaved-key","paymentOrigin":"terminal",
                           "terminalApproved":true,"transactionRef":"approval"}),
                    None,
                    &at,
                )
                .unwrap();
                crate::unsaved_payments::record(&conn, &unsaved).unwrap();
            }
            _ => {}
        }
        if let Some((method, origin, status, reference)) = extra_receipt {
            conn.execute(
                "INSERT INTO order_payments(id,order_id,method,payment_origin,status,amount,amount_cents,
                    currency,staff_id,staff_shift_id,created_at,updated_at,transaction_ref)
                 VALUES('extra',?1,?2,?3,?4,1,100,'EUR',?5,?6,?7,?7,?8)",
                params![ORDER, method, origin, status, CASHIER, CASHIER_SHIFT, at, reference],
            )
            .unwrap();
            if origin == "sync_reconstructed" {
                // A mirrored receipt is synced; only its canonical check is missing here.
                conn.execute(
                    "UPDATE order_payments SET remote_payment_id='server-extra',
                        sync_state='applied',sync_status='synced' WHERE id='extra'",
                    [],
                )
                .unwrap();
            }
        }
        assert_platform_return_refused(&conn, &original, case);
    }
}

fn assert_platform_return_refused(conn: &Connection, original: &Value, case: &str) {
    let changes = || {
        conn.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            .unwrap()
    };
    let before = changes();
    assert_eq!(
        manual_cancel::prepare(conn, ORDER).unwrap_err(),
        manual_order_cancellation::PLATFORM_ORDER_RETURN_REQUIRED,
        "{case}"
    );
    assert_eq!(
        manual_cancel::commit(
            conn,
            &json!({
                "orderId":ORDER, "reason":"Return", "returnChannel":"cash_drawer",
                "requestId":"refused-return", "generation":original["generation"],
            }),
            CASHIER,
        )
        .unwrap_err(),
        manual_order_cancellation::PLATFORM_ORDER_RETURN_REQUIRED,
        "{case}"
    );
    assert_eq!(changes(), before, "{case}");
}

#[test]
fn remote_cancel_then_void_releases_the_driver_and_the_z() {
    let (db, _guard, _) = driver_cash_fixture();
    adopt_remote_cancel(&db);
    assert_eq!(earning(&db), (1500, 1500));
    let result = payments::void_payment(&db.state, PAYMENT, "Cash correction", None, None).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(earning(&db), (0, 0));
    assert_eq!(expected_return(&db), 0.0);
    close_driver_and_cashier_after_full_cash_correction(&db);
    assert_z_full_cash_correction(&db);
}

fn close_driver_and_cashier_after_full_cash_correction(db: &TestDb) {
    close(db, DRIVER_SHIFT, 0.0);
    assert_eq!(frozen_close(db), (0, 0, 0));
    assert_eq!(close(db, CASHIER_SHIFT, 100.0)["expected"], 100.0);
}

fn assert_z_full_cash_correction(db: &TestDb) {
    let report = z_report(db);
    let cash = report["tenderReconciliation"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["tender"] == "cash")
        .unwrap();
    assert_eq!(cash["receivedCents"], 1500);
    assert_eq!(cash["refundedCents"], 1500);
    assert_eq!(cash["keptCents"], 0);
    assert_eq!(report["integrity"]["blockingFindings"], 0);
}

#[test]
fn z_kept_platform_cancellation_reports_cash_reconciliation_and_drawer() {
    let (db, _guard, _) = driver_cash_fixture();
    adopt_remote_cancel(&db);
    close(&db, DRIVER_SHIFT, 15.0);
    assert_eq!(drawer_movements(&db), (0, 1500, 0));
    assert_eq!(close(&db, CASHIER_SHIFT, 115.0)["expected"], 115.0);
    let report = z_report(&db);
    eprintln!(
        "cancelled and cash kept: {}",
        json!({"sales":report["sales"],"driver":report["driverEarnings"],"tender":report["tenderReconciliation"],"drawer":report["cashDrawer"],"integrity":report["integrity"]})
    );
    assert_eq!(report["sales"]["grossSales_cents"], 0);
    assert_eq!(report["sales"]["netSales_cents"], 0);
    assert_eq!(report["sales"]["cashSales_cents"], 0);
    assert_eq!(report["sales"]["totalOrders"], 0);
    assert_eq!(report["driverEarnings"]["cancelledDeliveries"], 1);
    assert_eq!(
        report["tenderReconciliation"]["totals"]["receivedCents"],
        1500
    );
    assert_eq!(report["tenderReconciliation"]["totals"]["refundedCents"], 0);
    assert_eq!(report["tenderReconciliation"]["totals"]["keptCents"], 1500);
    assert_eq!(report["cashDrawer"]["expected_cents"], 11500);
    assert_eq!(report["integrity"]["unexplainedDifference"], 0.0);
    assert_eq!(report["integrity"]["blockingFindings"], 0);
}

#[tokio::test]
async fn ended_order_conflict_sets_payment_aside_and_driver_can_close() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let (db, _guard, _) = driver_cash_fixture();
    let queue_id: String = db
        .state
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT id FROM parity_sync_queue WHERE table_name='payments' AND record_id=?1",
            [PAYMENT],
            |row| row.get(0),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 2048];
        loop {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            request.extend_from_slice(&buffer[..count]);
            if let Some(headers_end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..headers_end]).unwrap();
                let body_len: usize = headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse().unwrap())
                    .unwrap_or(0);
                if request.len() >= headers_end + 4 + body_len {
                    break;
                }
            }
        }
        assert!(request.starts_with(b"POST /api/pos/payments "));
        let body = r#"{"success":false,"code":"PAYMENT_ADMISSION_CONFLICT","reconciliation_required":true,"error":"Order ended"}"#;
        stream.write_all(format!("HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let batch = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::sync_queue::process_queue_renderer_safe_item_with_claim_gate(
            &db.state.conn,
            &base_url,
            "test-key",
            &queue_id,
            || Ok(()),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(batch.processed, 1, "{:?}", batch.errors);
    server.await.unwrap();
    {
        let conn = db.state.conn.lock().unwrap();
        let queued: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE id=?1)",
                [&queue_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!queued);
        let reason: String = conn.query_row(
            "SELECT json_extract(metadata, '$.duplicate_review.reason') FROM order_payments WHERE id=?1",
            [PAYMENT], |row| row.get(0),
        ).unwrap();
        assert_eq!(reason, "reconciliation_required");
    }
    assert_eq!(notice(&db, ORDER), json!({"state":"review"}));
    assert_eq!(earning(&db), (0, 0));
    assert_eq!(expected_return(&db), 0.0);
    assert_eq!(close(&db, DRIVER_SHIFT, 0.0)["expected"], 0.0);
    assert_eq!(drawer_movements(&db), (0, 0, 0));
    let report = z_report(&db);
    assert!(report["integrity"]["findings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|finding| finding["reasonCode"] == "payments_need_review"));
}

#[test]
fn z_same_window_void_and_repayment_exposes_gross_voids_and_net() {
    let (db, _guard, _) = driver_cash_fixture();
    void(&db);
    let at = Utc::now().to_rfc3339();
    {
        let conn = db.state.conn.lock().unwrap();
        record(&conn, "again", 15.0, "cash", &at, false);
        order_ownership::refresh_existing_driver_earning_payment_snapshot(&conn, ORDER, &at)
            .unwrap();
    }
    let report = z_report(&db);
    eprintln!(
        "void and repayment: {}",
        json!({"sales":report["sales"],"tender":report["tenderReconciliation"],"integrity":report["integrity"]})
    );
    assert_eq!(report["sales"]["grossSales_cents"], 1500);
    assert_eq!(report["sales"]["voidsTotal_cents"], 1500);
    assert_eq!(report["sales"]["netSales_cents"], 0);
    assert_eq!(
        report["tenderReconciliation"]["totals"]["receivedCents"],
        3000
    );
    assert_eq!(
        report["tenderReconciliation"]["totals"]["refundedCents"],
        1500
    );
    assert_eq!(report["tenderReconciliation"]["totals"]["keptCents"], 1500);
}
