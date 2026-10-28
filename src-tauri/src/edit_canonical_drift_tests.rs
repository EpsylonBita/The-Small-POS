//! Tomikro 25–26/10/2026 (desktop 1.4.136, ORD-26102026-00072): a delivery
//! order paid cash at creation took one non-money correction (customer and
//! address details, 00:37:30), and every later attempt to add products was
//! refused with `modals.menu.editCanonicalChanged`; "refresh" changed nothing
//! and nothing reached the support log.
//!
//! Native failure mechanism reproduced here on the till's code with server-shaped
//! answers: the till's lines keep the renderer's cart ids. The create
//! acknowledgement never projected the server's line UUIDs, and the payment
//! acknowledgement stamps the order newer than the server, so the pull skips
//! it. The customer correction's preflight ignores line ids and passed; the
//! paid-edit preflight requires them and refused with
//! EDIT_ORIGINAL_ITEMS_UNAVAILABLE, which the menu shows as "Order details
//! need a refresh". The precise production refusal remains unconfirmed: the
//! old build recorded no refusal evidence.
use super::*;
use serde_json::{json, Value};

pub(crate) const ORG: &str = "0a9e0000-0000-4000-8000-000000000001";
pub(crate) const BRANCH: &str = "b7a2c400-0000-4000-8000-000000000001";
pub(crate) const TERMINAL: &str = "terminal-d80762ac";
pub(crate) const ORDER: &str = "local-order-72";
pub(crate) const REMOTE: &str = "3fc3c34f-0000-4000-8000-000000000072";
const CUSTOMER: &str = "c0000000-0000-4000-8000-0000000000c1";
const ADDRESS: &str = "a0000000-0000-4000-8000-0000000000a1";
const ZONE: &str = "20000000-0000-4000-8000-0000000000a1";
pub(crate) const LINE_SAVORY: &str = "57b97566-0000-4000-8000-000000000001";
pub(crate) const LINE_SWEET: &str = "c591cf4b-0000-4000-8000-000000000002";
const MENU_SAVORY: &str = "e0000000-0000-4000-8000-0000000000e1";
const MENU_SWEET: &str = "e0000000-0000-4000-8000-0000000000e2";
const INGREDIENT_HAM: &str = "f0000000-0000-4000-8000-0000000000f1";
const INGREDIENT_CHEESE: &str = "f0000000-0000-4000-8000-0000000000f2";
const PAYMENT: &str = "94c9ce67-0000-4000-8000-000000000003";
const REMOTE_PAYMENT: &str = "90000000-0000-4000-8000-000000000001";
/// The renderer's cart line ids at creation (`${Date.now()}-…`): the server
/// gives the lines its own UUIDs.
const CART_LINE_SAVORY: &str = "1761431578569-k3j9x2m1q-p0z8w7v6u";
const CART_LINE_SWEET: &str = "1761431581207-a8s7d6f5g-h4j3k2l1m";

/// The address geometry's latitude: one ULP above the decimal the address row
/// stores. This is a synthetic rounding stress case; coordinates were ruled
/// out for the reported incident. PostgREST can render doubles with 15 digits
/// (`extra_float_digits = 0`), so the server's JSON shows the decimal.
fn geometry_latitude() -> f64 {
    f64::from_bits(37.9765432f64.to_bits() + 1)
}

pub(crate) fn connection() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::db::run_migrations_for_test(&conn);
    create_tables(&conn).expect("create sync queue tables");
    for (key, value) in [
        ("__ignore_keyring", "1"),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
        ("terminal_id", TERMINAL),
    ] {
        crate::db::set_setting(&conn, "terminal", key, value).expect("terminal scope");
    }
    conn
}

pub(crate) fn till_items() -> Value {
    // The till's own cart shape: an ingredient list with catalog decoration.
    json!([
        {"id":CART_LINE_SAVORY,"menu_item_id":MENU_SAVORY,"name":"Κρέπα Αλμυρή","quantity":2,"unit_price":5.6,"price":5.6,
         "total_price":11.2,"original_unit_price":5.6,"is_price_overridden":false,"notes":null,"category_name":"Κρέπες",
         "customizations":[
            {"ingredient":{"id":INGREDIENT_HAM,"name":"Ζαμπόν","price":0.5,"category_id":"cat-1"},"quantity":1,"isWithout":false},
            {"ingredient":{"id":INGREDIENT_CHEESE,"name":"Τυρί","price":0.6,"category_id":"cat-1"},"quantity":1,"isWithout":false}]},
        {"id":CART_LINE_SWEET,"menu_item_id":MENU_SWEET,"name":"Γλυκιά Κρέπα","quantity":1,"unit_price":3.4,"price":3.4,
         "total_price":3.4,"original_unit_price":3.4,"is_price_overridden":false,"notes":null,"customizations":null}
    ])
}

/// `order_items.customizations` as the server keeps them (keyed rows plus `_meta`).
fn stored_customizations(line: &str) -> Value {
    if line == LINE_SAVORY {
        json!({INGREDIENT_HAM:{"ingredient":{"id":INGREDIENT_HAM,"name":"Ζαμπόν","price":0.5},"quantity":1,"isWithout":false},
            INGREDIENT_CHEESE:{"ingredient":{"id":INGREDIENT_CHEESE,"name":"Τυρί","price":0.6},"quantity":1,"isWithout":false},
            "_meta":{"product_name":"Κρέπα Αλμυρή","category_name":"Κρέπες","line_kind":"menu"}})
    } else {
        json!({"_meta":{"product_name":"Γλυκιά Κρέπα","line_kind":"menu"}})
    }
}

/// `getCanonicalOrderSnapshot` lines (`mapOrderItem`).
fn canonical_items() -> Value {
    let line = |id: &str, menu: &str, name: &str, quantity: f64, unit: f64| {
        let mut customizations = stored_customizations(id);
        customizations.as_object_mut().unwrap().remove("_meta");
        json!({"id":id,"menu_item_id":menu,"retail_product_id":null,"quantity":quantity,"price":unit,"unit_price":unit,
            "original_unit_price":unit,"is_price_overridden":false,"total_price":unit*quantity,"name":name,
            "customizations":customizations,"notes":null,"vat_rate_percent":13,"price_includes_vat":true})
    };
    json!([
        line(LINE_SAVORY, MENU_SAVORY, "Κρέπα Αλμυρή", 2.0, 5.6),
        line(LINE_SWEET, MENU_SWEET, "Γλυκιά Κρέπα", 1.0, 3.4)
    ])
}

/// The server's order row at a version, as JSON leaves PostgREST: the
/// latitude rendered with 15 significant digits.
pub(crate) fn server_order(version: i64, floor: &str) -> Value {
    json!({"id":REMOTE,"version":version,"organization_id":ORG,"branch_id":BRANCH,"terminal_id":TERMINAL,
        "owner_terminal_id":null,"source_terminal_id":null,"status":"pending","order_type":"delivery",
        "payment_status":"paid","payment_method":"cash","currency":"EUR","total_amount":14.6,"subtotal":14.6,
        "tax_amount":2.83,"discount_amount":0,"delivery_fee":0,"tip_amount":0,"service_fee":0,
        "customer_id":CUSTOMER,"customer_name":"Γιώργος Π.","customer_phone":"6900000000","customer_email":null,
        "delivery_address":"Οδός Δοκιμής 5","delivery_address_id":ADDRESS,"delivery_city":"Αθήνα",
        "delivery_postal_code":"11111","delivery_floor":floor,"delivery_notes":null,"name_on_ringer":"Π.",
        "delivery_latitude":37.9765432,"delivery_longitude":23.7654321,"delivery_address_fingerprint":"fp-1",
        "delivery_zone_id":ZONE,"table_number":null,"table_id":null,"table_session_id":null,"driver_id":null,
        "driver_name":null,"notes":null,"special_instructions":null,"updated_at":"2026-10-25T22:37:30.691479+00:00",
        "items":canonical_items()})
}

fn sync_get_answer(version: i64, floor: &str) -> Value {
    // GET /api/pos/orders/sync?order_id=: plaintext columns, sync item shape.
    let mut order = server_order(version, floor);
    order["items"] = json!([
        {"id":LINE_SAVORY,"menu_item_id":MENU_SAVORY,"menuItemId":MENU_SAVORY,"menu_item_name":"Κρέπα Αλμυρή","name":"Κρέπα Αλμυρή",
         "quantity":2,"unit_price":5.6,"price":5.6,"total_price":11.2,"notes":null,"customizations":stored_customizations(LINE_SAVORY)},
        {"id":LINE_SWEET,"menu_item_id":MENU_SWEET,"menuItemId":MENU_SWEET,"menu_item_name":"Γλυκιά Κρέπα","name":"Γλυκιά Κρέπα",
         "quantity":1,"unit_price":3.4,"price":3.4,"total_price":3.4,"notes":null,"customizations":stored_customizations(LINE_SWEET)}
    ]);
    json!({"success":true,"exact_order_lookup":true,"orders":[order]})
}

fn server_payments(amount_cents: i64) -> Value {
    json!([{"id":REMOTE_PAYMENT,"organization_id":ORG,"branch_id":BRANCH,"order_id":REMOTE,
        "payment_method":"cash","amount":amount_cents as f64 / 100.0,"amount_cents":amount_cents,"tip_amount":0,
        "tip_amount_cents":0,"currency":"EUR","status":"completed","external_transaction_id":"CASH-1792967577974",
        "metadata":{"payment_origin":"manual","collected_by":"cashier_drawer","local_payment_id":PAYMENT}}])
}

/// The edit-capabilities answer (POST with a quote, or GET for a refresh).
pub(crate) fn capability(order: Value) -> Value {
    json!({"order":order,"payments":server_payments(1460),"adjustments":[],"retained_paid_cents":1460})
}

/// A synced delivery order paid cash 14.60 at creation, as the till holds it
/// after the create and payment acknowledgements: lines under cart ids.
pub(crate) fn seed_paid_delivery(conn: &Connection) {
    seed_order(conn, &till_items(), "synced", Some(REMOTE));
    seed_payment(conn);
}

fn seed_order(conn: &Connection, items: &Value, sync_status: &str, remote: Option<&str>) {
    conn.execute(
        "INSERT INTO orders(id,supabase_id,organization_id,branch_id,terminal_id,items,total_amount,subtotal,tax_amount,
            discount_amount,delivery_fee,tip_amount,status,payment_status,order_type,sync_status,version,remote_version,currency,
            customer_id,customer_name,customer_phone,customer_email,delivery_address,delivery_address_id,delivery_city,
            delivery_postal_code,delivery_floor,delivery_notes,name_on_ringer,delivery_latitude,delivery_longitude,
            delivery_address_fingerprint,delivery_zone_id,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,14.6,14.6,2.83,0,0,0,'pending','paid','delivery',?7,1,5,'EUR',?8,'Γιώργος Π.','6900000000',NULL,
            'Οδός Δοκιμής 5',?9,'Αθήνα','11111','2',NULL,'Π.',?10,23.7654321,'fp-1',?11,
            '2026-10-25T22:32:58.000Z','2026-10-25T22:33:20.000Z')",
        rusqlite::params![ORDER, remote, ORG, BRANCH, TERMINAL, items.to_string(), sync_status, CUSTOMER, ADDRESS,
            geometry_latitude(), ZONE],
    )
    .expect("seed order");
}

fn seed_payment(conn: &Connection) {
    conn.execute(
        "INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,sync_status,sync_state,
            remote_payment_id,idempotency_key,payment_origin,transaction_ref,created_at,updated_at)
         VALUES(?1,?2,'cash',14.6,1460,'EUR','completed','synced','applied',?3,
            ?4,'manual','CASH-1792967577974','2026-10-25T22:32:58.000Z','2026-10-25T22:33:20.000Z')",
        rusqlite::params![PAYMENT, ORDER, REMOTE_PAYMENT, format!("payment:{PAYMENT}")],
    )
    .expect("seed payment");
}

fn claim_order_row(conn: &Connection) -> SyncQueueItem {
    let id: String = conn
        .query_row(
            "SELECT id FROM parity_sync_queue WHERE table_name='orders' AND record_id=?1 ORDER BY rowid DESC LIMIT 1",
            [ORDER],
            |row| row.get(0),
        )
        .expect("queued order row");
    conn.execute(
        "UPDATE parity_sync_queue SET status='processing',claim_generation=1 WHERE id=?1",
        [&id],
    )
    .unwrap();
    conn.query_row("SELECT id,table_name,record_id,operation,data,organization_id,created_at,attempts,last_attempt,error_message,next_retry_at,retry_delay_ms,priority,module_type,conflict_strategy,version,claim_generation,status FROM parity_sync_queue WHERE id=?1",
        [&id], map_internal_queue_item).unwrap()
}

fn acknowledge(conn: &Connection, item: &SyncQueueItem, answer: &Value) {
    with_live_generic_claim(conn, item, |conn| {
        apply_success(conn, item, Some(answer))?;
        mark_success(conn, &item.id, item.claim_generation)
    })
    .expect("acknowledge")
    .expect("live claim");
}

/// The first, non-money correction through the command's own header
/// preflight: the customer form changes the floor (same destination).
fn header_edit(conn: &Connection, extra: Value) {
    let mut raw = json!({"orderId":ORDER,"expectedVersion":5,"expectedLocalVersion":1,"customerId":CUSTOMER,
        "customerName":"Γιώργος Π.","customerPhone":"6900000000","deliveryAddress":"Οδός Δοκιμής 5",
        "deliveryFloor":"3","nameOnRinger":"Π.","deliveryNotes":null,"clientEventId":"header-edit-1"});
    raw.as_object_mut()
        .unwrap()
        .extend(extra.as_object().cloned().unwrap_or_default());
    let original = crate::order_header_preflight::capture(conn, ORDER, &raw).expect("capture");
    let proof =
        crate::order_header_preflight::verify(conn, ORDER, &original, &sync_get_answer(5, "2"))
            .expect("the customer correction's preflight ignores line ids");
    crate::commands::orders::update_customer_headers_in_connection(conn, raw, Some(&proof))
        .expect("header edit applied");
}

pub(crate) fn header_edit_and_ack(conn: &Connection) {
    header_edit(conn, json!({}));
    let item = claim_order_row(conn);
    acknowledge(
        conn,
        &item,
        &json!({"success":true,"data":server_order(6, "3")}),
    );
}

fn money_preflight(conn: &Connection, order: Value) -> Result<(i64, i64), EditRefusal> {
    let before = crate::edit_settlement_recovery::capture_preflight(conn, ORDER)?;
    crate::edit_settlement_recovery::remember_canonical_preflight_detailed(
        conn,
        ORDER,
        "add-products",
        &before,
        &capability(order),
    )
}

use crate::edit_settlement_recovery::{DriftResolution, EditRefusal};

fn local_items(conn: &Connection) -> Vec<Value> {
    let raw: String = conn
        .query_row("SELECT items FROM orders WHERE id=?1", [ORDER], |row| {
            row.get(0)
        })
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
#[serial_test::serial]
fn tomikro_paid_add_product_after_a_customer_correction_adopts_the_line_identities() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    let conn = connection();
    seed_paid_delivery(&conn);
    header_edit_and_ack(&conn);
    // 1.4.136 refused here with EDIT_ORIGINAL_ITEMS_UNAVAILABLE; the
    // difference is now named: the lines' identities only.
    let refusal = money_preflight(&conn, server_order(6, "3")).unwrap_err();
    assert_eq!(
        refusal,
        EditRefusal::at("EDIT_CANONICAL_ORIGINAL_CHANGED", Some("items.identity"))
    );
    let before = crate::edit_settlement_recovery::capture_preflight(&conn, ORDER).unwrap();
    let resolution = crate::edit_settlement_recovery::reconcile_canonical_drift(
        &conn,
        ORDER,
        &before,
        &capability(server_order(6, "3")),
    )
    .unwrap();
    assert_eq!(resolution, DriftResolution::Adopted(vec!["items.identity"]));
    // The same sale under the server's UUIDs; each line still answers to the
    // cart id the open menu holds.
    let lines = local_items(&conn);
    let ids: Vec<(&str, &str)> = lines
        .iter()
        .map(|line| {
            (
                line["id"].as_str().unwrap(),
                line["client_line_id"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        ids,
        vec![
            (LINE_SAVORY, CART_LINE_SAVORY),
            (LINE_SWEET, CART_LINE_SWEET)
        ]
    );
    // The preview runs again and the edit continues.
    assert_eq!(money_preflight(&conn, server_order(6, "3")), Ok((6, 1)));
}

#[test]
#[serial_test::serial]
fn the_create_acknowledgement_projects_the_server_line_uuids() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    let conn = connection();
    seed_order(&conn, &till_items(), "pending", None);
    let body =
        json!({"orderId":ORDER,"items":till_items(),"orderType":"delivery","totalAmount":14.6});
    enqueue(
        &conn,
        &EnqueueInput {
            table_name: "orders".into(),
            record_id: ORDER.into(),
            operation: "INSERT".into(),
            data: body.to_string(),
            organization_id: ORG.into(),
            priority: None,
            module_type: Some("orders".into()),
            conflict_strategy: Some("server-wins".into()),
            version: Some(1),
        },
    )
    .unwrap();
    let item = claim_order_row(&conn);
    // POST /api/pos/orders answers with the canonical created order.
    acknowledge(
        &conn,
        &item,
        &json!({"success":true,"data":server_order(4, "2")}),
    );
    seed_payment(&conn);
    // The payment acknowledgement stamps the order newer than the server.
    crate::sync::mark_local_payment_applied(
        &conn,
        PAYMENT,
        "2026-10-25T22:33:19.000Z",
        Some(REMOTE_PAYMENT),
    )
    .unwrap();
    let lines = local_items(&conn);
    assert_eq!(lines[0]["id"], LINE_SAVORY);
    assert_eq!(lines[0]["client_line_id"], CART_LINE_SAVORY);
    // A paid correction proves its original at once (1.4.136:
    // EDIT_ORIGINAL_ITEMS_UNAVAILABLE until a later server change).
    assert_eq!(money_preflight(&conn, server_order(5, "2")), Ok((5, 1)));
}

#[test]
#[serial_test::serial]
fn a_named_coordinate_with_all_its_digits_no_longer_skips_the_header_acknowledgement() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    let conn = connection();
    seed_paid_delivery(&conn);
    // A changed destination names its point with all 17 digits (the address
    // geometry's double); SQLite renders the stored REAL with 15.
    header_edit(
        &conn,
        json!({"deliveryAddress":"Οδός Δοκιμής 7","deliveryAddressId":ADDRESS,"deliveryCity":"Αθήνα",
            "deliveryPostalCode":"11111","deliveryLatitude":geometry_latitude(),"deliveryLongitude":23.7654321,
            "deliveryAddressFingerprint":"fp-1","deliveryZoneId":ZONE}),
    );
    let item = claim_order_row(&conn);
    let mut answer = server_order(6, "3");
    answer["delivery_address"] = json!("Οδός Δοκιμής 7");
    acknowledge(&conn, &item, &json!({"success":true,"data":answer}));
    let (sync_status, remote_version): (String, Option<i64>) = conn
        .query_row(
            "SELECT sync_status,remote_version FROM orders WHERE id=?1",
            [ORDER],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    // 1.4.136 treated its own edit as a newer local change: the order stayed
    // `pending` at version 5 and every paid correction waited for a sync
    // that had already happened.
    assert_eq!((sync_status.as_str(), remote_version), ("synced", Some(6)));
}

#[test]
#[serial_test::serial]
fn the_header_acknowledgement_adopts_headers_the_server_resolved_without_being_named() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    let conn = connection();
    seed_paid_delivery(&conn);
    header_edit(&conn, json!({}));
    let item = claim_order_row(&conn);
    // The server's customer/address resolution links the customer's email
    // and refreshes the address identity the correction never named.
    let mut answer = server_order(6, "3");
    answer["customer_email"] = json!("customer@example.test");
    answer["delivery_address_fingerprint"] = json!("fp-2");
    acknowledge(&conn, &item, &json!({"success":true,"data":answer.clone()}));
    let (email, fingerprint): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT customer_email,delivery_address_fingerprint FROM orders WHERE id=?1",
            [ORDER],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (email.as_deref(), fingerprint.as_deref()),
        (Some("customer@example.test"), Some("fp-2"))
    );
    // A key the answer does not carry is not a NULL.
    let name: Option<String> = conn
        .query_row(
            "SELECT customer_name FROM orders WHERE id=?1",
            [ORDER],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(name.as_deref(), Some("Γιώργος Π."));
}

#[test]
#[serial_test::serial]
fn a_non_money_header_difference_is_adopted_and_the_preview_continues() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    let conn = connection();
    seed_order(&conn, &canonical_items(), "synced", Some(REMOTE));
    seed_payment(&conn);
    let mut order = server_order(6, "4");
    order["name_on_ringer"] = json!("Παπαδόπουλος");
    order["notes"] = json!("Κουδούνι δεξιά");
    let refusal = money_preflight(&conn, order.clone()).unwrap_err();
    assert_eq!(refusal.field, Some("delivery_floor"));
    let before = crate::edit_settlement_recovery::capture_preflight(&conn, ORDER).unwrap();
    let resolution = crate::edit_settlement_recovery::reconcile_canonical_drift(
        &conn,
        ORDER,
        &before,
        &capability(order.clone()),
    )
    .unwrap();
    assert_eq!(
        resolution,
        DriftResolution::Adopted(vec!["delivery_floor", "name_on_ringer", "notes"])
    );
    assert_eq!(money_preflight(&conn, order), Ok((6, 1)));
}

#[test]
#[serial_test::serial]
fn money_status_fulfillment_and_identity_differences_are_still_refused() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    for change in [
        "total",
        "status",
        "version",
        "order_type",
        "payment",
        "payment_status",
        "paid",
        "scope",
        "queued",
    ] {
        let conn = connection();
        seed_order(&conn, &canonical_items(), "synced", Some(REMOTE));
        seed_payment(&conn);
        let mut order = server_order(6, "2");
        let mut remote = capability(order.clone());
        match change {
            "total" => order["total_amount"] = json!(18.0),
            "status" => order["status"] = json!("delivered"),
            "version" => order["version"] = json!(4),
            "order_type" => order["order_type"] = json!("pickup"),
            "payment" => remote["payments"] = server_payments(1000),
            "payment_status" => remote["payments"][0]["status"] = json!("refunded"),
            "paid" => remote["retained_paid_cents"] = json!(1000),
            "scope" => order["branch_id"] = json!("b7a2c400-0000-4000-8000-0000000000ff"),
            "queued" => {
                order["total_amount"] = json!(18.0);
                conn.execute(
                    "INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,created_at,status)
                     VALUES('queued-status','orders',?1,'UPDATE','{}',?2,datetime('now'),'pending')",
                    rusqlite::params![ORDER, ORG],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        if !matches!(change, "payment" | "payment_status" | "paid") {
            remote["order"] = order;
        }
        let items_before = local_items(&conn);
        if change == "queued" {
            // A queued change of the order is waited for, never overwritten.
            assert_eq!(
                crate::edit_settlement_recovery::capture_preflight(&conn, ORDER).unwrap_err(),
                "EDIT_PREVIOUS_SETTLEMENT_SYNC_REQUIRED"
            );
            assert!(crate::edit_settlement_recovery::order_has_local_queue(&conn, ORDER).unwrap());
            continue;
        }
        let before = crate::edit_settlement_recovery::capture_preflight(&conn, ORDER).unwrap();
        let refusal = crate::edit_settlement_recovery::remember_canonical_preflight_detailed(
            &conn,
            ORDER,
            "add-products",
            &before,
            &remote,
        )
        .unwrap_err();
        if change == "scope" {
            assert_eq!(refusal.code, "EDIT_SETTLEMENT_SCOPE_MISMATCH", "{change}");
            continue;
        }
        assert_eq!(refusal.code, "EDIT_CANONICAL_ORIGINAL_CHANGED", "{change}");
        let resolution = crate::edit_settlement_recovery::reconcile_canonical_drift(
            &conn, ORDER, &before, &remote,
        )
        .unwrap();
        match change {
            // Recorded money is never rewritten: the refusal stands and the
            // mirror is untouched.
            "payment" | "payment_status" | "paid" | "version" => {
                assert_eq!(resolution, DriftResolution::Kept, "{change}");
                assert_eq!(local_items(&conn), items_before, "{change}");
            }
            // The order itself changed: refreshed from the server, and this
            // attempt is refused (the cart was built on the old order).
            _ => assert!(
                matches!(resolution, DriftResolution::Refreshed(_)),
                "{change}: {resolution:?}"
            ),
        }
    }
}

#[test]
#[serial_test::serial]
fn the_refresh_replaces_the_mirror_only_when_the_money_already_matches() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    let conn = connection();
    seed_paid_delivery(&conn);
    let mut order = server_order(7, "3");
    order["total_amount"] = json!(18.0);
    order["subtotal"] = json!(18.0);
    order["status"] = json!("preparing");
    order["items"] = json!([canonical_items()[0].clone(), canonical_items()[1].clone(),
        {"id":"d0000000-0000-4000-8000-0000000000d1","menu_item_id":MENU_SWEET,"quantity":1,"unit_price":3.4,
         "total_price":3.4,"name":"Γλυκιά Κρέπα","customizations":{},"notes":null}]);
    // Another till already took the extra 3.40: the till does not hold it.
    let mut remote = capability(order.clone());
    remote["payments"] = json!([server_payments(1460)[0].clone(), {"id":"90000000-0000-4000-8000-000000000002",
        "organization_id":ORG,"branch_id":BRANCH,"order_id":REMOTE,"payment_method":"cash","amount":3.4,
        "amount_cents":340,"tip_amount_cents":0,"currency":"EUR","status":"completed","metadata":{"payment_origin":"manual"}}]);
    remote["retained_paid_cents"] = json!(1800);
    let refused =
        crate::edit_settlement_recovery::refresh_order_from_canonical(&conn, ORDER, &remote)
            .unwrap_err();
    assert_eq!(refused.code, "EDIT_CANONICAL_ORIGINAL_CHANGED");
    assert_eq!(refused.field, Some("payments"));
    let total: f64 = conn
        .query_row(
            "SELECT total_amount FROM orders WHERE id=?1",
            [ORDER],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(total, 14.6);
    // With the same money, the server's order replaces the mirror.
    let refreshed = crate::edit_settlement_recovery::refresh_order_from_canonical(
        &conn,
        ORDER,
        &capability(server_order(7, "3")),
    )
    .unwrap();
    assert!(refreshed.contains(&"delivery_floor"));
    assert!(refreshed.contains(&"items.identity"));
    let (floor, remote_version, sync_status): (String, i64, String) = conn
        .query_row(
            "SELECT delivery_floor,remote_version,sync_status FROM orders WHERE id=?1",
            [ORDER],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (floor.as_str(), remote_version, sync_status.as_str()),
        ("3", 7, "synced")
    );
    assert_eq!(money_preflight(&conn, server_order(7, "3")), Ok((7, 1)));
}

#[test]
#[serial_test::serial]
fn every_refusal_writes_one_fixed_code_event_with_the_field_name_only() {
    assert_eq!(
        crate::edit_settlement_recovery::refusal_code("PRIVATE_TOKEN_CANARY"),
        "EDIT_LOCAL_OPERATION_FAILED"
    );
    #[derive(Clone, Default)]
    struct Buffer(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buffer {
        type Writer = Buffer;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
    let buffer = Buffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buffer.clone())
        .with_ansi(false)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        crate::edit_settlement_recovery::log_edit_refusal(
            "preview",
            &EditRefusal::at(
                "EDIT_ORIGINAL_ITEMS_UNAVAILABLE: Γιώργος 6900000000",
                Some("items.identity"),
            ),
        );
    });
    let line = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    assert!(line.contains("checkout::order_edit"), "{line}");
    assert!(
        line.contains("event_code=\"checkout_edit_refused\""),
        "{line}"
    );
    assert!(line.contains("edit_field=\"items.identity\""), "{line}");
    assert!(
        line.contains("refusal=\"EDIT_ORIGINAL_ITEMS_UNAVAILABLE\""),
        "{line}"
    );
    // Only the code: never the detail a refusal may carry.
    assert!(
        !line.contains("Γιώργος") && !line.contains("6900000000"),
        "{line}"
    );
}

#[test]
#[serial_test::serial]
fn the_refusal_field_names_are_the_shared_list() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../shared/pos/health/__fixtures__/runtime-log-edit-fields.json"
    ))
    .unwrap();
    let mut own: Vec<&str> = crate::edit_settlement_recovery::EDIT_REFUSAL_FIELDS.to_vec();
    own.push("none");
    own.sort_unstable();
    let shared: Vec<&str> = fixture["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|field| field.as_str().unwrap())
        .collect();
    assert_eq!(own, shared);
}

#[test]
#[serial_test::serial]
fn headers_compare_by_meaning_not_by_rendering() {
    use crate::edit_settlement_recovery::same_canonical_header as same;
    assert!(same(&json!(geometry_latitude()), &json!(37.9765432)));
    assert!(!same(&json!(37.9765432), &json!(37.9765433)));
    assert!(same(&json!(null), &json!("  ")));
    assert!(same(&json!(" 3 "), &json!("3")));
    assert!(same(&json!("5"), &json!(5)));
    assert!(!same(&json!("6900000000"), &json!("06900000000")));
    assert!(!same(&json!(null), &json!("3")));
}

#[test]
#[serial_test::serial]
fn canonical_adoption_rolls_back_the_preimage_guard_and_all_fields_on_failure() {
    let _keyring = crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL),
        ("organization_id", ORG),
        ("branch_id", BRANCH),
    ]);
    let conn = connection();
    seed_paid_delivery(&conn);
    let original_items = local_items(&conn);
    conn.execute_batch("CREATE TRIGGER refuse_test_total BEFORE UPDATE OF total_amount ON orders BEGIN SELECT RAISE(ABORT,'test write failure'); END;").unwrap();
    let mut canonical = server_order(7, "4");
    canonical["total_amount"] = json!(18.0);
    let refused = crate::edit_settlement_recovery::refresh_order_from_canonical(
        &conn,
        ORDER,
        &capability(canonical),
    )
    .unwrap_err();
    assert_eq!(refused.code, "EDIT_LOCAL_OPERATION_FAILED");
    let (floor, total): (String, f64) = conn
        .query_row(
            "SELECT delivery_floor,total_amount FROM orders WHERE id=?1",
            [ORDER],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((floor.as_str(), total), ("2", 14.6));
    assert_eq!(local_items(&conn), original_items);
    assert!(crate::db::get_setting(
        &conn,
        "edit_canonical_adoption_v1",
        &format!("{ORG}:{BRANCH}:{TERMINAL}:{ORDER}:7:Full")
    )
    .is_none());
    conn.execute_batch("DROP TRIGGER refuse_test_total")
        .unwrap();
    let snapshot = capability(server_order(7, "4"));
    crate::edit_settlement_recovery::refresh_order_from_canonical(&conn, ORDER, &snapshot).unwrap();
    let key = format!("{ORG}:{BRANCH}:{TERMINAL}:{ORDER}:7:Full");
    let audit = crate::db::get_setting(&conn, "edit_canonical_adoption_v1", &key).unwrap();
    // Repeating the same snapshot is a no-op and preserves the first preimage.
    crate::edit_settlement_recovery::refresh_order_from_canonical(&conn, ORDER, &snapshot).unwrap();
    assert_eq!(
        crate::db::get_setting(&conn, "edit_canonical_adoption_v1", &key).unwrap(),
        audit
    );
}
