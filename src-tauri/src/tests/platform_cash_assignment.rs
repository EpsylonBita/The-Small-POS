use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::commands::orders::{
    assign_driver_locally_with_platform_cash, change_order_driver_locally,
    reset_order_to_active_locally, DriverAssignmentCash, DriverChangeActor,
};
use crate::platform_cash_assignment::PlatformCash;
use crate::{business_day, db, fiscal::active_cache, payments, sync_queue};

const BRANCH: &str = "pc-branch";
const ORG: &str = "pc-org";
const TERMINAL: &str = "main";
const TERMINAL_DB: &str = "main-db";
const DRIVER: &str = "driver";
const SHIFT: &str = "driver-shift";
const OPENED: &str = "2026-11-19T08:00:00Z";
const CREATED: &str = "2026-11-19T09:00:00Z";
const NOW: &str = "2026-11-19T18:00:00Z";
const RULE: &str = "platform_cash_at_assignment";

fn till() -> db::DbState {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations_for_test(&conn);
    for (category, key, value) in [
        ("terminal", "branch_id", BRANCH),
        ("terminal", "organization_id", ORG),
        ("terminal", "terminal_id", TERMINAL),
        ("terminal", "source_terminal_db_id", TERMINAL_DB),
        ("restaurant", "store_currency_branch_id", BRANCH),
        ("restaurant", "store_currency_available", "true"),
        ("restaurant", "store_currency_source", "branch_country"),
        ("restaurant", "currency", "EUR"),
    ] {
        db::set_setting(&conn, category, key, value).unwrap();
    }
    for (id, staff, role, float) in [
        ("cash-shift", "cashier", "cashier", 100),
        (SHIFT, DRIVER, "driver", 20),
    ] {
        conn.execute(
            "INSERT INTO staff_shifts(id,staff_id,staff_name,role_type,branch_id,terminal_id,
                check_in_time,opening_cash_amount,opening_cash_amount_cents,status,
                calculation_version,sync_status,created_at,updated_at,currency)
             VALUES (?1,?2,?2,?3,?4,?5,?6,?7,?8,'active',2,'synced',?6,?6,'EUR')",
            params![
                id,
                staff,
                role,
                BRANCH,
                TERMINAL,
                OPENED,
                float,
                float * 100
            ],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,
            opening_amount,opening_amount_cents,driver_cash_given,driver_cash_given_cents,
            total_cash_sales_cents,total_card_sales_cents,
            opened_at,created_at,updated_at,currency)
         VALUES ('drawer','cash-shift','cashier',?1,?2,100,10000,20,2000,0,0,?3,?3,?3,'EUR')",
        params![BRANCH, TERMINAL, OPENED],
    )
    .unwrap();
    cash_register(&conn, false);
    db::DbState {
        conn: std::sync::Mutex::new(conn),
        db_path: ":memory:".into(),
    }
}

fn enable_platform_cash(conn: &Connection) {
    db::set_setting(
        conn,
        "terminal",
        "enabled_features",
        r#"{"platform_driver_cash_auto":true}"#,
    )
    .unwrap();
}

fn cash_register(conn: &Connection, admitted: bool) {
    let branch = db::get_setting(conn, "terminal", "branch_id").unwrap();
    let terminal = db::get_setting(conn, "terminal", "terminal_id").unwrap();
    db::set_setting(
        conn,
        "device_admission",
        "cash_register",
        &json!({
            "admitted": admitted, "fetchedAt": OPENED, "organizationId": ORG,
            "branchId": branch, "terminalId": terminal
        })
        .to_string(),
    )
    .unwrap();
}

fn declaration() -> Value {
    json!({"delivery_provider":"vendor_delivery","payment_method":"cash",
        "prepaid":null,"box_daas":false,"box_daas_declared":"absent"})
}

fn order(conn: &Connection, id: &str, platform: Option<&str>, food: Option<&Value>, tip: i64) {
    let blob = food.map(|value| json!({"food_delivery":value}).to_string());
    conn.execute(
        "INSERT INTO orders(id,supabase_id,order_number,items,order_type,total_amount,total_amount_cents,
                            delivery_fee,delivery_fee_cents,tip_amount,tip_amount_cents,
                            status,payment_status,sync_status,branch_id,terminal_id,
                            organization_id,staff_id,staff_shift_id,plugin,ghost_metadata,created_at,
                            updated_at,currency)
         VALUES (?1,?2,?1,'[]','delivery',12,1200,2,200,?3,?4,'ready','pending','synced',?5,
                 ?6,?7,'cashier','cash-shift',?8,?9,?10,?10,'EUR')",
        params![id, format!("{id}-remote"), tip as f64 / 100.0, tip, BRANCH, TERMINAL, ORG,
                platform, blob, CREATED],
    ).unwrap();
}

fn assign(
    conn: &Connection,
    id: &str,
    cash: DriverAssignmentCash<'_>,
) -> Result<(String, Option<String>, String, Option<String>), String> {
    assign_driver_locally_with_platform_cash(conn, id, DRIVER, Some("door"), NOW, cash)
}

fn direct(conn: &Connection, id: &str) -> (String, Option<String>, String, Option<String>) {
    assign(conn, id, DriverAssignmentCash::Direct { actor: None }).unwrap()
}

fn counts(conn: &Connection, id: &str) -> (i64, i64) {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM order_payments WHERE order_id=?1),
                (SELECT COUNT(*) FROM recovery_action_log WHERE action_id=?2 AND order_id=?1)",
        params![id, RULE],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

/// The fiscal answer for this test's thread. The shared cache is one per
/// process: any parallel test that opens a database re-initialises it, and an
/// `update` here would be persisted into whichever test database it names.
fn pin_fiscal(active: bool) {
    active_cache::pin_for_test(
        BRANCH,
        if active {
            active_cache::CacheVerdict::Active
        } else {
            active_cache::CacheVerdict::Inactive
        },
    );
}

fn json_row(conn: &Connection, sql: &str, id: &str) -> Value {
    let raw: String = conn.query_row(sql, [id], |row| row.get(0)).unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn payment_row(conn: &Connection, id: &str) -> Value {
    json_row(conn,
        "SELECT json_object('method',method,'status',status,'origin',payment_origin,
            'amount',amount,'amountCents',amount_cents,'currency',currency,
            'staff',staff_id,'shift',staff_shift_id,'syncStatus',sync_status,'syncState',sync_state,
            'cashReceived',cash_received,'cashReceivedCents',cash_received_cents,
            'change',change_given,'changeCents',change_given_cents,'tip',tip_amount,
            'tipCents',tip_amount_cents,'tipRole',tip_recipient_role,'tipStaff',tip_recipient_staff_id,
            'tipShift',tip_recipient_staff_shift_id,'discount',discount_amount,
            'discountCents',discount_amount_cents,'reference',transaction_ref,
            'hasIdempotency',(idempotency_key IS NOT NULL),
            'metadata',metadata,'device',terminal_device_id,'remoteId',remote_payment_id,
            'tableSession',table_session_id,'seat',seat_number,
            'allocations',(SELECT COUNT(*) FROM payment_items WHERE payment_id=op.id))
         FROM order_payments op WHERE order_id=?1", id)
}

fn earning(conn: &Connection, id: &str) -> Value {
    json_row(
        conn,
        "SELECT json_object('driver',driver_id,'shift',staff_shift_id,'branch',branch_id,
                'fee',delivery_fee_cents,'tip',tip_amount_cents,'earned',total_earning_cents,
                'cash',cash_collected_cents,'card',card_amount_cents,'return',cash_to_return_cents,
                'method',payment_method,'currency',currency,'settled',settled)
         FROM driver_earnings WHERE order_id=?1",
        id,
    )
}

fn drawer(conn: &Connection) -> Value {
    json_row(
        conn,
        "SELECT json_array(total_cash_sales_cents,total_card_sales_cents,
                driver_cash_given_cents,driver_cash_returned_cents,total_staff_payments_cents)
        FROM cash_drawer_sessions WHERE id=?1",
        "drawer",
    )
}

fn queued_payment(conn: &Connection, payment: &str) -> Value {
    json_row(
        conn,
        "SELECT data FROM parity_sync_queue WHERE table_name='payments' AND record_id=?1",
        payment,
    )
}

fn remove_keys(value: &mut Value, keys: &[&str]) {
    let fields = value.as_object_mut().unwrap();
    for key in keys {
        fields.remove(*key);
    }
}

fn checkout_blockers(
    conn: &Connection,
    cutoff: Option<&str>,
) -> Vec<crate::payment_integrity::UnsettledPaymentBlocker> {
    crate::payment_integrity::load_branch_window_payment_blockers(
        conn,
        BRANCH,
        &business_day::resolve_period_start(conn, BRANCH, None),
        cutoff,
        business_day::open_period_lower_bound_inclusive(conn, BRANCH),
    )
    .unwrap()
}

#[test]
fn box_cash_driver_receipt_and_close_count_the_tip_once_like_phone_cash() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    for platform in [Some("box"), None] {
        let db = till();
        let id = if platform.is_some() {
            "box-cash"
        } else {
            "phone-cash"
        };
        {
            let conn = db.conn.lock().unwrap();
            enable_platform_cash(&conn);
            order(
                &conn,
                id,
                platform,
                platform.map(|_| declaration()).as_ref(),
                75,
            );
            conn.execute(
                "UPDATE orders SET total_amount=7.65, total_amount_cents=765,
                    delivery_fee=0.0, delivery_fee_cents=0 WHERE id=?1",
                [id],
            )
            .unwrap();
            pin_fiscal(false);
            direct(&conn, id);
        }
        if platform.is_none() {
            payments::record_payment(
                &db,
                &json!({
                    "orderId": id, "amount": 7.65, "method": "cash", "currency": "EUR",
                    "paymentOrigin": "manual", "staffId": DRIVER, "staffShiftId": SHIFT,
                    "cashReceived": 7.65, "changeGiven": 0.0, "tipAmount": 0.75
                }),
            )
            .unwrap();
        }
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(counts(&conn, id), (1, i64::from(platform.is_some())));
            let payment = payment_row(&conn, id);
            assert_eq!(payment["method"], "cash");
            assert_eq!(payment["amount"], 7.65);
            assert_eq!(payment["amountCents"], 765);
            assert_eq!(payment["tip"], 0.75);
            assert_eq!(payment["tipCents"], 75);
        }
        let summary = crate::shifts::get_shift_summary(&db, SHIFT).unwrap();
        assert_eq!(summary["amountToReturn"], 26.90);
        let close =
            crate::shifts::close_shift(&db, &json!({"shiftId": SHIFT, "closingCash": 26.90, "expectedDriverKeptTips": 0.75, "expectedDriverPayout": 0.0}))
                .unwrap();
        assert_eq!(close["success"], true, "{id}: {close}");
        assert_eq!(close["expected"], 26.90);
        assert_eq!(close["variance"], 0.0);
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT expected_cash_amount_cents FROM staff_shifts WHERE id=?1",
                    [SHIFT],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2690
        );
    }
}

fn compare_phone(tip: i64) {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let phone = till();
    let auto = till();
    let mut manual = json!({
        "orderId":"phone","amount":12.0,"method":"cash","currency":"EUR",
        "paymentOrigin":"manual","staffId":DRIVER,"staffShiftId":SHIFT,
        "cashReceived":12.0,"changeGiven":0.0
    });
    if tip > 0 {
        manual["tipAmount"] = json!(tip as f64 / 100.0);
    }
    {
        let phone_conn = phone.conn.lock().unwrap();
        order(&phone_conn, "phone", None, None, tip);
        assign(&phone_conn, "phone", DriverAssignmentCash::Disabled).unwrap();
    }
    let manual_result = payments::record_payment(&phone, &manual).unwrap();
    let phone_payment = manual_result["paymentId"].as_str().unwrap();
    let phone_conn = phone.conn.lock().unwrap();
    let auto_conn = auto.conn.lock().unwrap();
    enable_platform_cash(&auto_conn);
    order(&auto_conn, "auto", Some("efood"), Some(&declaration()), tip);
    let original_drawer = drawer(&auto_conn);
    pin_fiscal(false);
    let mut candidate = PlatformCash::before_move(&auto_conn, "auto", DRIVER, SHIFT, NOW)
        .unwrap()
        .payment_input()
        .unwrap();
    candidate.order_id = "phone".into();
    // Debug includes the private item-allocation input as well.
    assert_eq!(
        format!("{candidate:?}"),
        format!(
            "{:?}",
            payments::build_payment_record_input(&manual).unwrap()
        )
    );
    direct(&auto_conn, "auto");
    assert!(auto_conn.is_autocommit());
    assert!(phone_conn.is_autocommit());
    assert_eq!(counts(&auto_conn, "auto"), (1, 1));
    let audit = json_row(
        &auto_conn,
        "SELECT payload_json FROM recovery_action_log WHERE order_id=?1",
        "auto",
    );
    let auto_payment = audit["paymentId"].as_str().unwrap();
    assert_eq!(
        payment_row(&auto_conn, "auto"),
        payment_row(&phone_conn, "phone")
    );
    assert_eq!(drawer(&auto_conn), original_drawer);
    assert_eq!(drawer(&phone_conn), original_drawer);

    let mut phone_queue = queued_payment(&phone_conn, phone_payment);
    let mut auto_queue = queued_payment(&auto_conn, auto_payment);
    assert!(phone_queue.get("collected_by").is_none());
    assert!(auto_queue.get("collected_by").is_none());
    assert_eq!(phone_queue["collectedBy"], Value::Null);
    if tip > 0 {
        // The release's delivery tip tail rebuilds from the row with the
        // recovery payload shape. Its additional keys carry no provenance.
        assert!(auto_queue.get("collectedBy").is_none());
        assert!(auto_queue.get("metadata").is_none());
        assert_eq!(auto_queue["payment_id"], auto_payment);
        assert_eq!(auto_queue["local_payment_id"], auto_payment);
        for key in [
            "remote_payment_id",
            "canonical_payment_id",
            "settlement_adjustments",
        ] {
            assert_eq!(auto_queue.get(key), Some(&Value::Null), "{key}");
        }
        // The rebuilt row carries the receipt's own stored key.
        let stored_key: Option<String> = auto_conn
            .query_row(
                "SELECT idempotency_key FROM order_payments WHERE id=?1",
                [auto_payment],
                |row| row.get(0),
            )
            .unwrap();
        assert!(stored_key.as_deref().is_some_and(|key| !key.is_empty()));
        assert_eq!(auto_queue["idempotency_key"], json!(stored_key));
        remove_keys(
            &mut auto_queue,
            &[
                "payment_id",
                "local_payment_id",
                "remote_payment_id",
                "canonical_payment_id",
                "idempotency_key",
                "settlement_adjustments",
            ],
        );
        remove_keys(&mut phone_queue, &["collectedBy", "metadata"]);
    }
    for queue in [&mut phone_queue, &mut auto_queue] {
        remove_keys(queue, &["paymentId", "orderId"]);
    }
    assert_eq!(auto_queue, phone_queue);

    let mut phone_earning = earning(&phone_conn, "phone");
    let mut auto_earning = earning(&auto_conn, "auto");
    for key in ["cash", "return"] {
        assert_eq!(phone_earning[key], 0);
        assert_eq!(auto_earning[key], 1200);
    }
    remove_keys(&mut phone_earning, &["cash", "return"]);
    remove_keys(&mut auto_earning, &["cash", "return"]);
    assert_eq!(auto_earning, phone_earning);
    assert!(checkout_blockers(&auto_conn, None).is_empty());
    assert!(checkout_blockers(&phone_conn, None).is_empty());

    // The dispatcher releases an ordinary payment after its parent order
    // update leaves the pending queue. Model that boundary without sending.
    let body = |conn: &Connection, payment: &str, order_id: &str| {
        conn.execute(
            "UPDATE parity_sync_queue SET status='superseded' WHERE table_name='orders'",
            [],
        )
        .unwrap();
        let mut body = sync_queue::request_body_for_test(conn, "payments", payment).unwrap();
        let key = format!("payment:{payment}");
        assert_eq!(body["idempotency_key"], key);
        assert_eq!(body["paymentId"], payment);
        assert_eq!(body["payment_id"], payment);
        assert_eq!(body["order_id"], format!("{order_id}-remote"));
        // Only a row rebuilt by the released tip tail also names the receipt's
        // stored key, as it does for any payment whose delivery tip it resolves.
        let legacy = body["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("legacy_idempotency_key");
        assert_eq!(legacy.is_some(), tip > 0 && order_id == "auto");
        if let Some(legacy) = legacy {
            let stored: Option<String> = conn
                .query_row(
                    "SELECT idempotency_key FROM order_payments WHERE id=?1",
                    [payment],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(legacy, json!(stored));
        }
        assert_eq!(
            body["metadata"],
            json!({
                "terminal_id": TERMINAL, "local_order_id": order_id, "local_payment_id": payment,
                "canonical_idempotency_key": key, "payment_origin": "manual",
                "staff_id": DRIVER, "staff_shift_id": SHIFT
            })
        );
        remove_keys(
            &mut body["metadata"],
            &[
                "local_order_id",
                "local_payment_id",
                "canonical_idempotency_key",
            ],
        );
        remove_keys(
            &mut body,
            &[
                "order_id",
                "paymentId",
                "payment_id",
                "idempotency_key",
                "clientOccurredAt",
            ],
        );
        body
    };
    assert_eq!(
        body(&phone_conn, phone_payment, "phone"),
        body(&auto_conn, auto_payment, "auto")
    );
    drop(phone_conn);
    drop(auto_conn);
    let expected = json!(32.0 - tip as f64 / 100.0);
    assert_eq!(
        crate::shifts::get_shift_summary(&phone, SHIFT).unwrap()["amountToReturn"],
        expected
    );
    assert_eq!(
        crate::shifts::get_shift_summary(&auto, SHIFT).unwrap()["amountToReturn"],
        expected
    );
}

#[test]
#[serial_test::serial]
fn ordinary_phone_cash_matches_platform_cash() {
    compare_phone(0);
}

#[test]
#[serial_test::serial]
fn ordinary_phone_cash_with_tip_matches_platform_cash_after_tip_refresh() {
    compare_phone(100);
}

#[test]
#[serial_test::serial]
fn only_affirmative_store_driver_cash_declarations_are_eligible() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    let valid = declaration();
    let mut box_missing = valid.clone();
    box_missing
        .as_object_mut()
        .unwrap()
        .remove("box_daas_declared");
    let mut unreadable = valid.clone();
    unreadable["box_daas_declared"] = json!("unreadable");
    let mut courier = valid.clone();
    courier["box_daas_declared"] = json!("courier");
    let mut daas = valid.clone();
    daas["box_daas"] = json!(true);
    let mut no_daas = valid.clone();
    no_daas.as_object_mut().unwrap().remove("box_daas");
    let mut wrong_case = valid.clone();
    wrong_case["delivery_provider"] = json!("VENDOR_DELIVERY");
    let mut no_cash = valid.clone();
    no_cash.as_object_mut().unwrap().remove("payment_method");
    let mut prepaid = valid.clone();
    prepaid["prepaid"] = json!(true);
    let mut rider = valid.clone();
    rider["delivery_provider"] = json!("platform_delivery");
    for (id, platform, food, rows) in [
        ("efood", "efood", &valid, 1),
        ("wolt", "wolt", &valid, 1),
        ("box", "box", &valid, 1),
        ("box-gr", "BOX-GR", &valid, 1),
        ("box-conflicting-fleet", "box", &rider, 0),
        ("missing", "box", &box_missing, 1),
        ("unreadable", "box", &unreadable, 0),
        ("courier", "box", &courier, 0),
        ("daas", "box", &daas, 0),
        ("no-daas", "box", &no_daas, 0),
        ("wrong-case", "efood", &wrong_case, 0),
        ("no-cash", "wolt", &no_cash, 0),
        ("prepaid", "efood", &prepaid, 0),
        ("rider", "efood", &rider, 0),
    ] {
        order(&conn, id, Some(platform), Some(food), 0);
        pin_fiscal(false);
        direct(&conn, id);
        assert_eq!(counts(&conn, id), (rows, rows), "{id}");
    }
    order(&conn, "broken", Some("efood"), Some(&valid), 0);
    conn.execute("UPDATE orders SET ghost_metadata='{' WHERE id='broken'", [])
        .unwrap();
    direct(&conn, "broken");
    assert_eq!(counts(&conn, "broken"), (0, 0));

    order(&conn, "pickup", Some("efood"), Some(&valid), 0);
    conn.execute(
        "UPDATE orders SET order_type='pickup' WHERE id='pickup'",
        [],
    )
    .unwrap();
    // The release refuses driver assignment to takeaways before its move.
    let result = assign(
        &conn,
        "pickup",
        DriverAssignmentCash::Direct { actor: None },
    );
    assert_eq!(
        result,
        assign(&conn, "pickup", DriverAssignmentCash::Disabled)
    );
    assert!(result.is_err());
    assert_eq!(counts(&conn, "pickup"), (0, 0));

    order(&conn, "folio", Some("efood"), Some(&valid), 0);
    conn.execute(
        "UPDATE orders SET order_context='folio_settlement' WHERE id='folio'",
        [],
    )
    .unwrap();
    let result = assign(&conn, "folio", DriverAssignmentCash::Direct { actor: None });
    assert_eq!(
        result,
        assign(&conn, "folio", DriverAssignmentCash::Disabled)
    );
    assert_eq!(counts(&conn, "folio"), (0, 0));
}

#[test]
#[serial_test::serial]
fn paid_headers_without_receipts_stay_in_missing_payment_recovery() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    pin_fiscal(false);
    for (status, reason) in [
        ("paid", "missing_local_payment_row"),
        ("partially_paid", "no_persisted_payment"),
    ] {
        order(&conn, status, Some("efood"), Some(&declaration()), 0);
        conn.execute(
            "UPDATE orders SET payment_status = ?1 WHERE id = ?1",
            [status],
        )
        .unwrap();

        assert_eq!(direct(&conn, status).2, "delivered");
        assert_eq!(counts(&conn, status), (0, 0));
        let blockers =
            crate::payment_integrity::load_order_payment_blockers(&conn, status).unwrap();
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].reason_code, reason);
    }
}

#[test]
#[serial_test::serial]
fn earlier_collection_attempts_and_audit_evidence_keep_the_order_manual() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    for id in ["gift", "unsaved", "audit", "folio-intent"] {
        order(&conn, id, Some("efood"), Some(&declaration()), 0);
    }
    conn.execute(
        "INSERT INTO gift_card_redemption_attempts(idempotency_key,organization_id,branch_id,
           terminal_id,local_order_id,remote_order_id,amount_cents,currency,card_fingerprint,
           request_fingerprint,status,created_at,updated_at)
         VALUES ('gift-key',?1,?2,?3,'gift','gift-remote',1200,'EUR','card','request','remote_applied',?4,?4)",
        params![ORG, BRANCH, TERMINAL, CREATED],
    ).unwrap();
    let unsaved = crate::unsaved_payments::UnsavedChargedPayment::for_payment(
        "unsaved-remote",
        &json!({"orderId":"unsaved-remote","method":"card","amount":12.0,"currency":"EUR",
               "idempotencyKey":"unsaved-key","paymentOrigin":"terminal","terminalApproved":true,
               "transactionRef":"approval"}),
        None,
        CREATED,
    )
    .unwrap();
    crate::unsaved_payments::record(&conn, &unsaved).unwrap();
    conn.execute(
        "INSERT INTO recovery_action_log(id,action_id,issue_code,order_id,success,payload_json)
         VALUES ('earlier',?1,?1,'audit',1,'{}')",
        [RULE],
    )
    .unwrap();
    conn.execute(
        "UPDATE orders SET ghost_metadata=json_set(ghost_metadata,'$.room_charge',json(?1)) WHERE id='folio-intent'",
        [r#"{"currency":"EUR","applied":true}"#],
    ).unwrap();
    assert!(crate::commands::ecr::direct_sale_admission(&conn, "folio-intent", None).is_err());
    pin_fiscal(false);
    for id in ["gift", "unsaved", "audit", "folio-intent"] {
        assert!(
            PlatformCash::before_move(&conn, id, DRIVER, SHIFT, NOW).is_none(),
            "{id}"
        );
        assert_eq!(direct(&conn, id).2, "delivered");
        assert_eq!(counts(&conn, id), (0, if id == "audit" { 1 } else { 0 }));
    }
}

fn released_snapshot(conn: &Connection) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    use rusqlite::types::Value as SqlValue;

    // The earning's id and its key are generated independently by each assignment.
    let (earning_id, earning_key): (String, Option<String>) = conn
        .query_row(
            "SELECT id, idempotency_key FROM driver_earnings WHERE order_id='order'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let earning_key = earning_key.filter(|key| !key.is_empty());
    [
        "orders",
        "order_payments",
        "driver_earnings",
        "cash_drawer_sessions",
        "parity_sync_queue",
        "recovery_action_log",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let rows = statement
            .query_map([], |row| {
                columns
                    .iter()
                    .enumerate()
                    .map(|(index, column)| {
                        // These outbox fields are generated independently by each assignment.
                        if table == "parity_sync_queue"
                            && matches!(column.as_str(), "id" | "created_at")
                        {
                            return Ok(SqlValue::Null);
                        }
                        match row.get::<_, SqlValue>(index)? {
                            SqlValue::Text(value) => {
                                let value = value.replace(&earning_id, "earning");
                                Ok(SqlValue::Text(match &earning_key {
                                    Some(key) => value.replace(key, "earning-key"),
                                    None => value,
                                }))
                            }
                            value => Ok(value),
                        }
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    })
    .collect()
}

#[test]
#[serial_test::serial]
fn switch_off_is_the_released_till() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let baseline = till();
    let baseline_conn = baseline.conn.lock().unwrap();
    let food = declaration();
    order(&baseline_conn, "order", Some("efood"), Some(&food), 100);
    enable_platform_cash(&baseline_conn);
    pin_fiscal(false);
    assert!(PlatformCash::before_move(&baseline_conn, "order", DRIVER, SHIFT, NOW).is_some());
    let released_answer = assign(&baseline_conn, "order", DriverAssignmentCash::Disabled).unwrap();
    let released = released_snapshot(&baseline_conn);

    for (case, setting) in [
        ("setting missing", None),
        ("key missing", Some("{}")),
        ("key false", Some(r#"{"platform_driver_cash_auto":false}"#)),
        ("unreadable JSON", Some("{")),
        ("wrong JSON shape", Some("[true]")),
        (
            "unreadable flag",
            Some(r#"{"platform_driver_cash_auto":"enabled"}"#),
        ),
    ] {
        let db = till();
        let conn = db.conn.lock().unwrap();
        if let Some(setting) = setting {
            db::set_setting(&conn, "terminal", "enabled_features", setting).unwrap();
        }
        order(&conn, "order", Some("efood"), Some(&food), 100);
        assert_eq!(direct(&conn, "order"), released_answer, "{case}");
        assert_eq!(counts(&conn, "order"), (0, 0), "{case}");
        assert_eq!(released_snapshot(&conn), released, "{case}");
    }
}

#[test]
#[serial_test::serial]
fn switch_accepts_camel_case_and_records_without_a_terminal_db_id() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    db::delete_setting(&conn, "terminal", "source_terminal_db_id").unwrap();
    order(&conn, "order", Some("wolt"), Some(&declaration()), 0);
    conn.execute("UPDATE orders SET supabase_id=NULL WHERE id='order'", [])
        .unwrap();
    pin_fiscal(false);
    for value in [json!(true), json!(1), json!(" On ")] {
        db::set_setting(
            &conn,
            "terminal",
            "enabled_features",
            &json!({"platformDriverCashAuto":value}).to_string(),
        )
        .unwrap();
        assert!(PlatformCash::before_move(&conn, "order", DRIVER, SHIFT, NOW).is_some());
    }
    direct(&conn, "order");
    assert_eq!(counts(&conn, "order"), (1, 1));
    let audit = json_row(
        &conn,
        "SELECT payload_json FROM recovery_action_log WHERE order_id=?1",
        "order",
    );
    assert_eq!(audit["terminalId"], TERMINAL);
    assert!(audit["remoteOrderId"].is_null());
}

#[test]
#[serial_test::serial]
fn every_optional_write_failure_replays_the_released_tail() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let baseline = till();
    let baseline_conn = baseline.conn.lock().unwrap();
    order(
        &baseline_conn,
        "order",
        Some("efood"),
        Some(&declaration()),
        100,
    );
    let released_answer = assign(&baseline_conn, "order", DriverAssignmentCash::Disabled).unwrap();
    let released = released_snapshot(&baseline_conn);
    for (site, trigger) in [
        ("receipt insert", "BEFORE INSERT ON order_payments
            BEGIN SELECT RAISE(ABORT,'receipt'); END"),
        ("receipt read-back", "AFTER INSERT ON order_payments
            BEGIN UPDATE order_payments SET staff_id='wrong' WHERE id=NEW.id; END"),
        ("audit insert", "BEFORE INSERT ON recovery_action_log
            WHEN NEW.action_id='platform_cash_at_assignment' BEGIN SELECT RAISE(ABORT,'audit'); END"),
        ("earning write", "BEFORE INSERT ON driver_earnings
            WHEN EXISTS(SELECT 1 FROM order_payments WHERE order_id=NEW.order_id)
            BEGIN SELECT RAISE(ABORT,'earning'); END"),
        ("tip-recipient refresh", "BEFORE UPDATE OF tip_recipient_staff_shift_id ON order_payments
            WHEN NEW.tip_amount_cents>0 BEGIN SELECT RAISE(ABORT,'tip'); END"),
        ("outbox enqueue", "BEFORE INSERT ON parity_sync_queue
            WHEN NEW.table_name='orders' AND EXISTS(SELECT 1 FROM recovery_action_log
                WHERE order_id=NEW.record_id AND action_id='platform_cash_at_assignment')
            BEGIN SELECT RAISE(ABORT,'outbox'); END"),
    ] {
        let db = till();
        let conn = db.conn.lock().unwrap();
        enable_platform_cash(&conn);
        order(&conn, "order", Some("efood"), Some(&declaration()), 100);
        conn.execute_batch(&format!("CREATE TEMP TRIGGER fault {trigger};")).unwrap();
        pin_fiscal(false);
        assert!(PlatformCash::before_move(&conn, "order", DRIVER, SHIFT, NOW).is_some(), "{site}");
        assert_eq!(direct(&conn, "order"), released_answer, "{site}");
        assert!(conn.is_autocommit(), "{site}");
        assert_eq!(counts(&conn, "order"), (0, 0), "{site}");
        assert_eq!(released_snapshot(&conn), released, "{site}");
    }
}

#[test]
#[serial_test::serial]
fn failed_optional_rollback_aborts_assignment() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};

    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    order(&conn, "order", Some("efood"), Some(&declaration()), 0);
    pin_fiscal(false);
    conn.execute_batch(
        "CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON recovery_action_log
         WHEN NEW.action_id = 'platform_cash_at_assignment'
         BEGIN SELECT RAISE(ABORT, 'audit'); END;
         BEGIN IMMEDIATE;",
    )
    .unwrap();
    conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Savepoint {
            operation: TransactionOperation::Rollback,
            savepoint_name: "platform_cash_at_assignment",
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }));

    let error = assign(&conn, "order", DriverAssignmentCash::Direct { actor: None }).unwrap_err();
    assert!(
        error.starts_with("Could not roll back assigned cash:"),
        "{error}"
    );
    assert!(!conn.is_autocommit());
    conn.execute_batch("COMMIT").unwrap();
    assert_eq!(counts(&conn, "order"), (0, 0));
    let (status, driver): (String, Option<String>) = conn
        .query_row(
            "SELECT status, driver_id FROM orders WHERE id = 'order'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((status.as_str(), driver), ("ready", None));
}

#[test]
#[serial_test::serial]
fn released_tail_fits_when_receipt_and_driver_checkout_do_not() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    order(&conn, "order", Some("efood"), Some(&declaration()), 0);
    conn.execute(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?1)
         INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id)
         SELECT 'fill-'||x,'orders','fill-'||x,'UPDATE','{}',?2 FROM n",
        params![sync_queue::MAX_QUEUE_SIZE - 3, ORG],
    )
    .unwrap();
    pin_fiscal(false);
    assert!(PlatformCash::before_move(&conn, "order", DRIVER, SHIFT, NOW).is_some());
    assert!(sync_queue::ensure_enqueue_capacity(&conn, 3).is_ok());
    assert!(sync_queue::ensure_enqueue_capacity(&conn, 4).is_err());
    assert_eq!(direct(&conn, "order").2, "delivered");
    assert_eq!(counts(&conn, "order"), (0, 0));
}

#[test]
#[serial_test::serial]
fn change_driver_analytics_and_remote_snapshot_never_take_cash() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let mut conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    for id in ["change", "analytics", "remote"] {
        order(&conn, id, Some("efood"), Some(&declaration()), 0);
        pin_fiscal(false);
        assert!(PlatformCash::before_move(&conn, id, DRIVER, SHIFT, NOW).is_some());
    }
    let change = change_order_driver_locally(
        &mut conn,
        "change",
        DRIVER,
        &DriverChangeActor::default(),
        NOW,
    )
    .unwrap();
    assert!(!change.corrected);
    assert_eq!(change.status, "delivered");

    // The analytics command's Tauri wrapper is not needed to exercise its
    // private transaction's ownership and earning calls.
    let source = include_str!("../commands/analytics.rs");
    let analytics = source
        .split_once("fn driver_record_earning_inner(")
        .unwrap()
        .1
        .split_once("#[tauri::command]")
        .unwrap()
        .0;
    assert!(analytics.contains("order_ownership::assign_order_to_driver_shift("));
    assert!(analytics.contains("order_ownership::upsert_driver_earning("));
    assert!(!analytics.contains("assign_driver_locally"));
    {
        let tx = conn.transaction().unwrap();
        let moved = crate::order_ownership::assign_order_to_driver_shift(
            &tx,
            "analytics",
            DRIVER,
            None,
            SHIFT,
            NOW,
        )
        .unwrap();
        let earning_id =
            crate::order_ownership::upsert_driver_earning(&tx, "analytics", DRIVER, &moved, NOW)
                .unwrap();
        let payload =
            crate::order_ownership::build_driver_earning_sync_payload(&tx, &earning_id).unwrap();
        crate::order_ownership::enqueue_or_refresh_driver_earning_sync_row(
            &tx,
            &earning_id,
            &payload,
        )
        .unwrap();
        tx.commit().unwrap();
    }

    let applied = crate::sync::sync_remote_order_snapshot_into_local(
        &conn,
        "remote",
        &json!({
            "id":"remote-remote", "organization_id":ORG, "branch_id":BRANCH, "terminal_id":TERMINAL,
            "status":"delivered", "payment_status":"pending",
            "order_type":"delivery", "total_amount":12.0, "currency":"EUR", "driver_id":DRIVER,
            "staff_id":DRIVER, "staff_shift_id":SHIFT, "updated_at":NOW,
            "plugin":"efood", "ghost_metadata":{"food_delivery":declaration()}
        }),
        NOW,
    )
    .unwrap();
    assert_eq!(applied, 1);
    for id in ["change", "analytics", "remote"] {
        assert_eq!(counts(&conn, id), (0, 0), "{id}");
        let driver: String = conn
            .query_row("SELECT driver_id FROM orders WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(driver, DRIVER, "{id}");
    }
}

fn cashier_records(db: &db::DbState, order_id: &str) -> Value {
    payments::resolve_unsettled_payment_blocker_payment(
        db,
        &json!({
            "orderId":order_id, "method":"cash", "amountCents":1200,
            "staffId":"cashier", "staffShiftId":"cash-shift"
        }),
    )
    .unwrap()
}

#[test]
#[serial_test::serial]
fn cashier_payment_first_moves_locally_and_keeps_queued_cashier_stamp() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let before = {
        let conn = db.conn.lock().unwrap();
        enable_platform_cash(&conn);
        order(&conn, "order", Some("efood"), Some(&declaration()), 0);
        conn.execute("UPDATE orders SET status='delivered' WHERE id='order'", [])
            .unwrap();
        drawer(&conn)
    };
    let receipt = cashier_records(&db, "order");
    assert_eq!(receipt["success"], true, "{receipt}");
    let payment_id = receipt["paymentId"].as_str().unwrap();
    let conn = db.conn.lock().unwrap();
    let queued_before = queued_payment(&conn, payment_id);
    assert_eq!(queued_before["collectedBy"], "cashier_drawer");
    assert_eq!(queued_before["staffShiftId"], "cash-shift");
    assert_eq!(drawer(&conn)[0], 1200);
    pin_fiscal(false);
    direct(&conn, "order");
    assert_eq!(counts(&conn, "order"), (1, 0));
    assert_eq!(payment_row(&conn, "order")["staff"], DRIVER);
    assert_eq!(payment_row(&conn, "order")["shift"], SHIFT);
    assert_eq!(drawer(&conn), before);
    assert_eq!(queued_payment(&conn, payment_id), queued_before);
}

#[test]
#[serial_test::serial]
fn assignment_first_leaves_the_cashier_nothing_to_record_and_retry_is_idempotent() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    {
        let conn = db.conn.lock().unwrap();
        enable_platform_cash(&conn);
        order(&conn, "order", Some("efood"), Some(&declaration()), 0);
        pin_fiscal(false);
        let answer = direct(&conn, "order");
        assert_eq!(direct(&conn, "order"), answer);
        assert_eq!(counts(&conn, "order"), (1, 1));
    }
    let result = cashier_records(&db, "order");
    assert_eq!(result["success"], false);
    let conn = db.conn.lock().unwrap();
    assert_eq!(counts(&conn, "order"), (1, 1));
    assert!(
        crate::payment_integrity::load_order_payment_blockers(&conn, "order")
            .unwrap()
            .is_empty()
    );
}

#[test]
#[serial_test::serial]
fn voided_history_survives_retry_and_reset_then_fresh_assignment() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    {
        let conn = db.conn.lock().unwrap();
        enable_platform_cash(&conn);
        order(&conn, "order", Some("efood"), Some(&declaration()), 0);
        assign(&conn, "order", DriverAssignmentCash::Disabled).unwrap();
    }
    // A manual receipt has no feature audit, which lets the test isolate
    // the retained payment history after both the retry and the reset.
    let payment = payments::record_payment(
        &db,
        &json!({
            "orderId":"order","method":"cash","amount":12.0,"currency":"EUR",
            "paymentOrigin":"manual","staffId":DRIVER,"staffShiftId":SHIFT,
            "cashReceived":12.0,"changeGiven":0.0
        }),
    )
    .unwrap();
    payments::void_payment(
        &db,
        payment["paymentId"].as_str().unwrap(),
        "fixture void",
        Some(DRIVER),
        Some(SHIFT),
    )
    .unwrap();
    let mut conn = db.conn.lock().unwrap();
    pin_fiscal(false);
    direct(&conn, "order");
    assert_eq!(counts(&conn, "order"), (1, 0));
    assert!(
        reset_order_to_active_locally(&mut conn, "order", NOW)
            .unwrap()
            .2
    );
    let driver: Option<String> = conn
        .query_row("SELECT driver_id FROM orders WHERE id='order'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(driver.is_none());
    direct(&conn, "order");
    assert_eq!(counts(&conn, "order"), (1, 0));
    assert_eq!(payment_row(&conn, "order")["status"], "voided");
}

#[test]
#[serial_test::serial]
fn only_known_non_fiscal_scope_and_matching_driver_shift_are_eligible() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    for (id, admission, fiscal, edit) in [
        ("unknown", Some(false), None, None),
        ("active", Some(false), Some(true), None),
        ("missing", None, Some(false), None),
        ("admitted", Some(true), Some(false), None),
        (
            "currency",
            Some(false),
            Some(false),
            // An order's currency is immutable on a real till.
            Some(
                "DROP TRIGGER IF EXISTS orders_currency_immutable;
                 UPDATE orders SET currency='CHF'",
            ),
        ),
        (
            "terminal",
            Some(false),
            Some(false),
            Some("UPDATE staff_shifts SET terminal_id='peer' WHERE role_type='driver'"),
        ),
        (
            "ghost",
            Some(false),
            Some(false),
            Some("UPDATE orders SET is_ghost=1"),
        ),
        (
            "test",
            Some(false),
            Some(false),
            Some("UPDATE orders SET is_test=1"),
        ),
    ] {
        let db = till();
        let conn = db.conn.lock().unwrap();
        enable_platform_cash(&conn);
        order(&conn, id, Some("efood"), Some(&declaration()), 0);
        if let Some(edit) = edit {
            conn.execute_batch(edit).unwrap();
        }
        if let Some(admission) = admission {
            cash_register(&conn, admission);
        } else {
            db::delete_setting(&conn, "device_admission", "cash_register").unwrap();
        }
        if let Some(fiscal) = fiscal {
            pin_fiscal(fiscal);
        } else {
            // An isolated branch name has no cache answer in any other test.
            let branch = "pc-unknown";
            db::set_setting(&conn, "terminal", "branch_id", branch).unwrap();
            db::set_setting(&conn, "restaurant", "store_currency_branch_id", branch).unwrap();
            cash_register(&conn, false);
            conn.execute("UPDATE orders SET branch_id=?1", [branch])
                .unwrap();
            conn.execute("UPDATE staff_shifts SET branch_id=?1", [branch])
                .unwrap();
            assert_eq!(
                active_cache::closeout_verdict(branch),
                active_cache::CacheVerdict::Unknown
            );
        }
        if id == "currency" {
            let result = assign(&conn, id, DriverAssignmentCash::Direct { actor: None });
            assert_eq!(result, assign(&conn, id, DriverAssignmentCash::Disabled));
            assert!(
                result.is_err(),
                "the release refuses a mixed-currency earning"
            );
        } else {
            assert_eq!(direct(&conn, id).2, "delivered", "{id}");
        }
        assert_eq!(counts(&conn, id), (0, 0), "{id}");
    }
}

#[test]
#[serial_test::serial]
fn issued_z_uses_the_orders_financial_time_before_the_move() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    let cutoff = "2026-11-19T10:00:00Z";
    db::set_setting(
        &conn,
        "system",
        business_day::PENDING_Z_REPORT_CONTEXT_KEY,
        &json!({
            "frozen":true,"branchId":BRANCH,"cutoffAt":cutoff
        })
        .to_string(),
    )
    .unwrap();
    pin_fiscal(false);
    assert_eq!(
        business_day::resolve_period_start(&conn, BRANCH, None),
        cutoff
    );
    for (id, at, rows) in [
        ("old", CREATED, 0),
        ("boundary", "2026-11-19T11:00:00+01:00", 0),
        ("current", "2026-11-19T10:01:00Z", 1),
    ] {
        order(&conn, id, Some("efood"), Some(&declaration()), 0);
        conn.execute(
            "UPDATE orders SET created_at=?1,updated_at=?1 WHERE id=?2",
            params![at, id],
        )
        .unwrap();
        assert_eq!(direct(&conn, id).2, "delivered");
        assert_eq!(counts(&conn, id), (rows, rows), "{id}");
    }
}

#[test]
#[serial_test::serial]
fn open_order_notice_holds_completion_and_cash() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    order(&conn, "order", Some("efood"), Some(&declaration()), 0);
    let queue_id = sync_queue::enqueue(
        &conn,
        &sync_queue::EnqueueInput {
            table_name: "orders".into(),
            record_id: "order".into(),
            operation: "UPDATE".into(),
            data: json!({"customer_name":"Edited","client_event_id":"edit","expected_version":1})
                .to_string(),
            organization_id: ORG.into(),
            priority: None,
            module_type: None,
            conflict_strategy: None,
            version: None,
        },
    )
    .unwrap();
    conn.execute("UPDATE parity_sync_queue SET status='conflict',error_message='UNKNOWN_CONFLICT_REVIEW' WHERE id=?1", [&queue_id]).unwrap();
    pin_fiscal(false);
    assert!(PlatformCash::before_move(&conn, "order", DRIVER, SHIFT, NOW).is_some());
    let answer = direct(&conn, "order");
    assert_eq!(answer.2, "ready");
    assert_eq!(
        answer.3.as_deref(),
        Some(crate::order_notice_recovery::ORDER_HAS_OPEN_NOTICE)
    );
    assert_eq!(counts(&conn, "order"), (0, 0));
}

#[test]
#[serial_test::serial]
fn evening_cashier_checkout_has_no_payment_blocker_while_driver_is_out() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    order(&conn, "order", Some("efood"), Some(&declaration()), 0);
    conn.execute("UPDATE orders SET status='delivered' WHERE id='order'", [])
        .unwrap();
    assert!(checkout_blockers(&conn, Some(NOW))
        .iter()
        .any(|blocker| blocker.order_id == "order"));
    pin_fiscal(false);
    direct(&conn, "order");
    let end = chrono::Utc::now()
        .max(NOW.parse::<chrono::DateTime<chrono::Utc>>().unwrap())
        .to_rfc3339();
    assert!(!checkout_blockers(&conn, Some(&end))
        .iter()
        .any(|blocker| blocker.order_id == "order"));
    assert_eq!(counts(&conn, "order"), (1, 1));
    let status: String = conn
        .query_row(
            "SELECT status FROM staff_shifts WHERE id=?1",
            [SHIFT],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "active");
}

#[test]
#[serial_test::serial]
fn audit_payload_has_the_exact_contract_and_preserves_missing_and_null() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let db = till();
    let conn = db.conn.lock().unwrap();
    enable_platform_cash(&conn);
    order(&conn, "order", Some("efood"), Some(&declaration()), 0);
    pin_fiscal(false);
    direct(&conn, "order");
    let receipt_id: String = conn
        .query_row(
            "SELECT id FROM order_payments WHERE order_id=?1",
            ["order"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        json_row(
            &conn,
            "SELECT json_array(action_id,success,entity_type,entity_id,
        order_id,shift_id,actor_staff_id) FROM recovery_action_log WHERE order_id=?1",
            "order"
        ),
        json!([RULE, 1, "order", "order", "order", SHIFT, null])
    );
    assert_eq!(
        json_row(
            &conn,
            "SELECT payload_json FROM recovery_action_log WHERE order_id=?1",
            "order"
        ),
        json!({
            "paymentId":receipt_id,"orderId":"order","remoteOrderId":"order-remote",
            "terminalId":TERMINAL_DB,"branchId":BRANCH,"amountCents":1200,"currency":"EUR",
            "driverId":DRIVER,"driverShiftId":SHIFT,"recordedAt":NOW,"rule":RULE,
            "ruleVersion":1,"actor":"unknown","declaration":{
                "delivery_provider":"vendor_delivery","payment_method":"cash","payment_type":"<missing>",
                "prepaid":null,"box_daas":false,"box_daas_declared":"absent"
            }
        })
    );
}
