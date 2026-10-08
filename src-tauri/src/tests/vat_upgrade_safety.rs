//! VAT upgrade safety (07/10/2026).
//!
//! Every order now stores its canonical computed VAT (the server's
//! `computeOrderTotals`, ported in `fiscal::greece_vat`) in `tax_amount`.
//! Prices stay VAT-inclusive, so that VAT is bookkeeping: for a store like
//! Tomikro (owner rate 0, no fiscal plugin, no myDATA fiscal device) or a
//! store with no owner rate, nothing visible or financial may change. Each
//! test builds the same order twice, once as this release stores it (the
//! computed VAT) and once as the previous release did (an order-dashboard
//! order stored tax 0 and no cents), and requires every consumer to answer
//! identically: the charged total and outstanding balance, the shift and
//! drawer math with the change given, the reports, the customer slip bytes,
//! the order JSON the screens read, the Z, and the create request body
//! (where only the server-ignored `tax_amount` fields may differ).
//!
//! The settings are Tomikro's real shape: `tax.default_tax_rate` 0 on the
//! branch-scoped main-till row, `tax_inclusive` served true (old tills stored
//! false), `tax_name` "Sales Tax", `auto_calculate_tax` true, and the branch
//! compliance row `gr_standard_24` / `mainland`. The branch has two Windows
//! tills and one Android satellite; the other two place orders the server
//! returns with its VAT through the pull.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::db::{self, DbState};
use crate::tests::fake_keyring;

const ORG: &str = "7c1d0f2e-1a2b-4c3d-8e4f-0000000000c1";
const BRANCH: &str = "7c1d0f2e-1a2b-4c3d-8e4f-000000000001";
const MAIN_TILL: &str = "7c1d0f2e-1a2b-4c3d-8e4f-0000000000a1";
const SECOND_TILL: &str = "7c1d0f2e-1a2b-4c3d-8e4f-0000000000a2";
const SATELLITE: &str = "7c1d0f2e-1a2b-4c3d-8e4f-0000000000b1";
const CREPE: &str = "7c1d0f2e-1a2b-4c3d-8e4f-0000000000d1";
const WAFFLE: &str = "7c1d0f2e-1a2b-4c3d-8e4f-0000000000d2";
const JUICE: &str = "7c1d0f2e-1a2b-4c3d-8e4f-0000000000d3";
const SHIFT: &str = "tomikro-main-till-cashier-shift";

/// The `settings.tax` block the server serves Tomikro's main till: rate 0 on
/// the branch-scoped main-till row. `Value::Null` is a branch with no rate.
fn tax_feed(rate: Value) -> Value {
    json!({"settings": {"tax": {
        "default_tax_rate": rate,
        "tax_inclusive": true,
        "tax_name": "Sales Tax",
        "auto_calculate_tax": true,
        "vat_default_category_code": "gr_standard_24",
        "vat_region_profile": "mainland"
    }}})
}

/// The main Windows till of a Tomikro-like branch with an open cashier shift
/// and drawer. `rate` is the owner's VAT rate the server serves.
fn main_till(rate: Value) -> (DbState, fake_keyring::Guard) {
    let keyring = fake_keyring::install_empty();
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    db::run_migrations_for_test(&conn);
    for (category, key, value) in [
        ("terminal", "__ignore_keyring", "1"),
        ("terminal", "branch_id", BRANCH),
        ("terminal", "terminal_id", MAIN_TILL),
        ("terminal", "organization_id", ORG),
        ("terminal", "terminal_type", "main"),
        ("general", "language", "el"),
        ("restaurant", "store_currency_branch_id", BRANCH),
        ("restaurant", "store_currency_available", "true"),
        ("restaurant", "store_currency_source", "branch_country"),
        ("restaurant", "currency", "EUR"),
    ] {
        db::set_setting(&conn, category, key, value).unwrap();
    }
    conn.execute(
        "INSERT INTO staff_shifts (
            id, staff_id, staff_name, branch_id, terminal_id, role_type,
            check_in_time, opening_cash_amount, opening_cash_amount_cents,
            status, sync_status, created_at, updated_at, currency
         ) VALUES (?1, 'tomikro-cashier', 'Cashier', ?2, ?3, 'cashier',
            datetime('now'), 100.0, 10000, 'active', 'pending',
            datetime('now'), datetime('now'), 'EUR')",
        params![SHIFT, BRANCH, MAIN_TILL],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cash_drawer_sessions (
            id, staff_shift_id, cashier_id, branch_id, terminal_id,
            opening_amount, opening_amount_cents, opened_at, created_at, updated_at, currency
         ) VALUES ('tomikro-drawer', ?1, 'tomikro-cashier', ?2, ?3, 100.0, 10000,
            datetime('now'), datetime('now'), datetime('now'), 'EUR')",
        params![SHIFT, BRANCH, MAIN_TILL],
    )
    .unwrap();
    let db = DbState {
        conn: std::sync::Mutex::new(conn),
        db_path: std::path::PathBuf::from(":memory:"),
    };
    crate::cache_terminal_settings_snapshot(&db, &tax_feed(rate)).expect("cache tax feed");
    (db, keyring)
}

/// A pickup of two crepes, paid in cash with change.
fn pickup_payload(request: &str) -> Value {
    json!({
        "clientRequestId": request,
        "branchId": BRANCH,
        "terminalId": MAIN_TILL,
        "items": [{"menu_item_id": CREPE, "name": "Crepe", "quantity": 2, "unit_price": 6.5, "total_price": 13.0}],
        "totalAmount": 13.0,
        "subtotal": 13.0,
        "orderType": "pickup",
        "status": "pending",
        "paymentMethod": "cash",
        "initialPayment": {"method": "cash", "amount": 13.0, "cashReceived": 20.0, "changeGiven": 7.0, "currency": "EUR"}
    })
}

/// A delivery with a discount, a delivery fee and a tip, paid by card (the
/// shared vector `delivery_order_full`: VAT 4.44).
fn delivery_payload(request: &str) -> Value {
    json!({
        "clientRequestId": request,
        "branchId": BRANCH,
        "terminalId": MAIN_TILL,
        "items": [
            {"menu_item_id": CREPE, "name": "Crepe", "quantity": 1, "unit_price": 8.5, "total_price": 8.5},
            {"menu_item_id": WAFFLE, "name": "Waffle", "quantity": 1, "unit_price": 9.4, "total_price": 9.4},
            {"menu_item_id": JUICE, "name": "Juice", "quantity": 2, "unit_price": 2.35, "total_price": 4.7}
        ],
        "subtotal": 22.6,
        "discountAmount": 0.75,
        "deliveryFee": 1.8,
        "tipAmount": 1.0,
        "totalAmount": 24.65,
        "orderType": "delivery",
        "deliveryAddress": "Ermou 1",
        "customerName": "Maria",
        "customerPhone": "6900000000",
        "status": "pending",
        "paymentMethod": "card",
        "initialPayment": {"method": "card", "amount": 24.65, "tipAmount": 1.0, "currency": "EUR"}
    })
}

fn create(db: &DbState, payload: &Value) -> String {
    let created = crate::sync::create_order(db, payload, &crate::print::NoopPrintQueueInvalidator)
        .expect("create order");
    created["orderId"].as_str().expect("order id").to_string()
}

fn stored_vat(db: &DbState, order: &str) -> (f64, Option<i64>) {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT tax_amount, tax_amount_cents FROM orders WHERE id = ?1",
        [order],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

/// The order as the previous release stored it: an order-dashboard create
/// carried no tax, so the row held 0 and no cents, and the queued create
/// named no tax.
fn as_previous_release(db: &DbState, order: &str) {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE orders SET tax_amount = 0, tax_amount_cents = NULL WHERE id = ?1",
        [order],
    )
    .unwrap();
    let data: String = conn
        .query_row(
            "SELECT data FROM parity_sync_queue WHERE table_name = 'orders' AND record_id = ?1",
            [order],
            |row| row.get(0),
        )
        .unwrap();
    let mut data: Value = serde_json::from_str(&data).unwrap();
    for key in ["taxAmount", "tax_amount", "tax_amount_cents"] {
        data.as_object_mut().unwrap().remove(key);
    }
    conn.execute(
        "UPDATE parity_sync_queue SET data = ?1 WHERE table_name = 'orders' AND record_id = ?2",
        params![data.to_string(), order],
    )
    .unwrap();
}

fn strip_keys(value: &mut Value, keys: &[&str]) {
    match value {
        Value::Object(map) => {
            for key in keys {
                map.remove(*key);
            }
            for child in map.values_mut() {
                strip_keys(child, keys);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_keys(item, keys);
            }
        }
        _ => {}
    }
}

/// Everything a consumer of the order answers, read the same way twice.
#[derive(Debug, PartialEq)]
struct Consumers {
    settlement: crate::payments::OrderSettlementSnapshot,
    payments: Value,
    shift_summary: Value,
    report_rows: String,
    slip_doc: Value,
    slip_bytes: Vec<u8>,
    order_json: Value,
    z_preview: Value,
    create_body: Value,
}

fn read_consumers(db: &DbState, order: &str) -> Consumers {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let (settlement, report_rows) = {
        let conn = db.conn.lock().unwrap();
        (
            crate::payments::load_order_settlement_snapshot(&conn, order).unwrap(),
            format!(
                "{:?}",
                crate::load_orders_for_period(&conn, BRANCH, &today, &today).unwrap()
            ),
        )
    };
    let mut payments = crate::payments::get_order_payments(db, order).unwrap();
    strip_keys(&mut payments, &["updatedAt", "updated_at"]);
    let mut shift_summary = crate::shifts::get_shift_summary(db, SHIFT).unwrap();
    strip_keys(&mut shift_summary, &["generatedAt", "generated_at"]);
    let doc = crate::print::build_order_receipt_doc(db, order).unwrap();
    let slip_bytes = crate::receipt_renderer::render_escpos(
        &crate::receipt_renderer::ReceiptDocument::OrderReceipt(doc.clone()),
        &crate::receipt_renderer::LayoutConfig::default(),
    )
    .bytes;
    let mut order_json = crate::sync::get_order_by_id(db, order).unwrap();
    // The stored VAT itself is the one field allowed to differ.
    strip_keys(&mut order_json, &["taxAmount"]);
    let mut z_preview =
        crate::zreport::preview_z_report_for_date(db, &json!({"branchId": BRANCH, "date": today}))
            .unwrap();
    // The preview period ends now.
    strip_keys(
        &mut z_preview,
        &["generatedAt", "generated_at", "periodEnd", "end"],
    );
    let mut create_body = {
        let conn = db.conn.lock().unwrap();
        crate::sync_queue::request_body_for_test(&conn, "orders", order).unwrap()
    };
    // The server ignores the client's VAT on a create and computes its own.
    strip_keys(&mut create_body, &["tax_amount", "tax_amount_cents"]);
    Consumers {
        settlement,
        payments,
        shift_summary,
        report_rows,
        slip_doc: serde_json::to_value(&doc).unwrap(),
        slip_bytes,
        order_json,
        z_preview,
        create_body,
    }
}

fn assert_nothing_changes(rate: Value, payload: Value, expected_vat_cents: i64) {
    let (db, _keyring) = main_till(rate);
    let order = create(&db, &payload);

    // This release: the canonical VAT of the very body the till sends.
    let (tax, cents) = stored_vat(&db, &order);
    assert_eq!(cents, Some(expected_vat_cents));
    assert_eq!(tax, expected_vat_cents as f64 / 100.0);
    let with_vat = read_consumers(&db, &order);
    assert_eq!(
        with_vat.order_json["printedVatAmount"],
        Value::Null,
        "no VAT shown"
    );
    assert!(
        !with_vat.slip_doc["totals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line["label"] == "Tax"),
        "no VAT line on the slip"
    );

    as_previous_release(&db, &order);
    let previous = read_consumers(&db, &order);
    assert_eq!(
        with_vat.settlement, previous.settlement,
        "(a) total and outstanding"
    );
    assert_eq!(
        with_vat.payments, previous.payments,
        "(a)(b) payments and change"
    );
    assert_eq!(
        with_vat.shift_summary, previous.shift_summary,
        "(b) shift and drawer"
    );
    assert_eq!(
        with_vat.report_rows, previous.report_rows,
        "(f) report rows"
    );
    assert_eq!(with_vat.slip_doc, previous.slip_doc, "(d) slip document");
    assert_eq!(with_vat.slip_bytes, previous.slip_bytes, "(d) slip bytes");
    assert_eq!(
        with_vat.order_json, previous.order_json,
        "(e) order JSON for screens"
    );
    assert_eq!(with_vat.z_preview, previous.z_preview, "(i) Z");
    assert_eq!(
        with_vat.create_body, previous.create_body,
        "(h) create body"
    );
}

#[test]
fn tomikro_pickup_is_unchanged_by_its_stored_vat() {
    // 13.00 at 24% included: VAT 2.52.
    assert_nothing_changes(json!(0), pickup_payload("tomikro-pickup"), 252);
}

#[test]
fn tomikro_delivery_with_tip_is_unchanged_by_its_stored_vat() {
    assert_nothing_changes(json!(0), delivery_payload("tomikro-delivery"), 444);
}

#[test]
fn unset_rate_store_pickup_and_delivery_are_unchanged_by_their_stored_vat() {
    assert_nothing_changes(Value::Null, pickup_payload("unset-pickup"), 252);
    assert_nothing_changes(Value::Null, delivery_payload("unset-delivery"), 444);
}

#[test]
fn the_charged_total_and_the_create_body_money_are_the_till_s_own() {
    let (db, _keyring) = main_till(json!(0));
    let order = create(&db, &delivery_payload("tomikro-body"));
    let conn = db.conn.lock().unwrap();
    let body = crate::sync_queue::request_body_for_test(&conn, "orders", &order).unwrap();
    for (field, expected) in [
        ("total_amount_cents", 2465),
        ("subtotal_cents", 2260),
        ("discount_amount_cents", 75),
        ("delivery_fee_cents", 180),
        ("tip_amount_cents", 100),
        ("tax_amount_cents", 444),
    ] {
        assert_eq!(body[field], expected, "{field}");
    }
    let (charged, paid): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER)),
                    (SELECT SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER)))
                     FROM order_payments WHERE order_id = orders.id AND status = 'completed')
             FROM orders WHERE id = ?1",
            [&order],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((charged, paid), (2465, 2465));
}

#[test]
fn a_tip_carried_only_in_the_total_is_still_recovered_with_the_vat_stored() {
    // The previous inference added the stored tax on top of the subtotal:
    // with real VAT stored the expected tip went negative and the server's
    // total disagreed. Prices include VAT, so nothing is added on top.
    let (db, _keyring) = main_till(json!(0));
    let mut payload = pickup_payload("tomikro-tip-in-total");
    payload["totalAmount"] = json!(13.5);
    payload["initialPayment"] =
        json!({"method": "card", "amount": 13.5, "tipAmount": 0.5, "currency": "EUR"});
    payload["paymentMethod"] = json!("card");
    let order = create(&db, &payload);
    assert_eq!(stored_vat(&db, &order).1, Some(252));
    let conn = db.conn.lock().unwrap();
    let body = crate::sync_queue::request_body_for_test(&conn, "orders", &order).unwrap();
    assert_eq!(body["tip_amount_cents"], 50);
    assert_eq!(body["total_amount_cents"], 1350);
}

#[test]
fn general_tax_rate_and_the_checkout_rate_change_nothing_charged() {
    // `general.tax_rate` (the cart preview's old rate) and
    // `tax.tax_rate_percentage` (the checkout readiness rate, default 24)
    // are no VAT source and never reach a total.
    let (db, _keyring) = main_till(json!(0));
    let plain = create(&db, &pickup_payload("rates-plain"));
    {
        let conn = db.conn.lock().unwrap();
        db::set_setting(&conn, "general", "tax_rate", "24").unwrap();
        db::set_setting(&conn, "tax", "tax_rate_percentage", "24").unwrap();
    }
    let with_rates = create(&db, &pickup_payload("rates-set"));
    let conn = db.conn.lock().unwrap();
    let read = |order: &str| -> (i64, i64, i64) {
        conn.query_row(
            "SELECT COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER)),
                    COALESCE(subtotal_cents, CAST(ROUND(subtotal * 100) AS INTEGER)),
                    tax_amount_cents
             FROM orders WHERE id = ?1",
            [order],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    };
    assert_eq!(read(&plain), read(&with_rates));
    assert_eq!(read(&with_rates), (1300, 1300, 252));
    assert_eq!(crate::commands::settings::read_tax_rate(&conn), Ok(24.0));
}

#[test]
fn orders_of_the_other_tills_and_the_satellite_print_no_vat_line_either() {
    // The second Windows till and the Android satellite place orders the
    // server returns with its own VAT; under the rule they print what a
    // tax-0 order printed on this till.
    let (db, _keyring) = main_till(json!(0));
    let now = chrono::Utc::now().to_rfc3339();
    let remote = |id: &str, terminal: &str| {
        json!({
            "id": id, "organization_id": ORG, "branch_id": BRANCH,
            "terminal_id": terminal, "owner_terminal_id": MAIN_TILL, "source_terminal_id": terminal,
            "order_number": format!("N-{}", &id[id.len() - 2..]), "status": "completed",
            "payment_status": "pending", "order_type": "pickup",
            "items": [{"menu_item_id": CREPE, "name": "Crepe", "quantity": 1, "unit_price": 13.0, "total_price": 13.0}],
            "total_amount": 13.0, "total_amount_cents": 1300, "subtotal": 13.0,
            "tax_amount": 2.52, "tax_amount_cents": 252,
            "created_at": now, "updated_at": now, "version": 1
        })
    };
    let ids = [
        ("7c1d0f2e-1a2b-4c3d-8e4f-0000000000e1", SECOND_TILL),
        ("7c1d0f2e-1a2b-4c3d-8e4f-0000000000e2", SATELLITE),
    ];
    {
        let conn = db.conn.lock().unwrap();
        let error = crate::sync::apply_remote_orders_page_for_test(
            &conn,
            ids.iter()
                .map(|(id, terminal)| remote(id, terminal))
                .collect(),
        );
        assert_eq!(error, None);
    }
    for (remote_id, _) in ids {
        let local: String = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT id FROM orders WHERE supabase_id = ?1",
                [remote_id],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            stored_vat(&db, &local).1,
            Some(252),
            "the server's VAT is kept"
        );
        let doc = crate::print::build_order_receipt_doc(&db, &local).unwrap();
        assert!(!doc.totals.iter().any(|line| line.label == "Tax"));
        let subtotal = doc
            .totals
            .iter()
            .find(|line| line.label == "Subtotal")
            .unwrap();
        assert_eq!(subtotal.amount, 13.0);
    }
}
