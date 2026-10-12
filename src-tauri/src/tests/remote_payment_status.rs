//! The pull respects the server payment's status (item D2, fix review
//! 30/09/2026): a payment voided or refunded on the server never stays
//! completed local money.
//!
//! Symptom: another terminal (or the admin) voided a payment; every till that
//! had mirrored it while it was completed linked the server row by identity
//! and left the local row `completed`, so the order read paid there, an edit
//! asked only for the difference, and a courier was charged for it. The
//! pre-edit restore skipped voided server rows altogether.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::tests::harness::TestDb;

const BRANCH: &str = "branch-remote-status";
const LOCAL_ORDER: &str = "order-remote-status";
const REMOTE_ORDER: &str = "5b0f3c1e-2d4a-4b6c-8e9f-0a1b2c3d4e5f";
const REMOTE_PAYMENT: &str = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const SHIFT: &str = "shift-remote-status";

fn seed_order(conn: &Connection, order_type: &str) {
    conn.execute(
        "INSERT INTO orders (currency,
             id, supabase_id, order_number, items, order_type, total_amount, total_amount_cents,
             status, payment_status, sync_status, branch_id, staff_shift_id,
             created_at, updated_at
         ) VALUES ('EUR', ?1, ?2, 'A-0301', '[]', ?3, 13.0, 1300, 'completed', 'pending', 'synced',
                   ?4, ?5, '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
        params![LOCAL_ORDER, REMOTE_ORDER, order_type, BRANCH, SHIFT],
    )
    .expect("seed the order");
}

fn seed_drawer(conn: &Connection, cash_cents: i64) {
    conn.execute(
        "INSERT INTO staff_shifts (currency, id, staff_id, role_type, branch_id, check_in_time,
            opening_cash_amount, opening_cash_amount_cents, status, calculation_version,
            sync_status, created_at, updated_at) VALUES ('EUR', ?1, 'cashier-remote', 'cashier', ?2, '2026-09-30T08:00:00Z', 50.0, 5000,
                 'active', 2, 'pending', '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![SHIFT, BRANCH],
    )
    .expect("seed the cashier shift");
    conn.execute(
        "INSERT INTO cash_drawer_sessions (currency, id, staff_shift_id, cashier_id, branch_id,
            terminal_id, opening_amount, opening_amount_cents, total_cash_sales,
            total_cash_sales_cents, opened_at, created_at, updated_at) VALUES ('EUR', 'drawer-remote-status', ?1, 'cashier-remote', ?2, 'terminal-remote-status',
                 50.0, 5000, ?3, ?4,
                 '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z', '2026-09-30T08:00:00Z')",
        params![SHIFT, BRANCH, cash_cents as f64 / 100.0, cash_cents],
    )
    .expect("seed the drawer");
}

fn server_payment(status: &str, updated_at: &str) -> Value {
    json!({
        "id": REMOTE_PAYMENT,
        "order_id": REMOTE_ORDER,
        "payment_method": "cash",
        "amount": 13.0,
        "currency": "EUR",
        "status": status,
        "created_at": "2026-09-30T10:05:00Z",
        "updated_at": updated_at,
        "metadata": {}
    })
}

fn mirror(conn: &Connection, payment: &Value) {
    crate::sync::sync_remote_payment_into_local_for_test(conn, payment).expect("mirror the row");
}

fn local_rows(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare(
            "SELECT id, status FROM order_payments WHERE order_id = ?1 ORDER BY created_at, id",
        )
        .unwrap();
    statement
        .query_map(params![LOCAL_ORDER], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn payment_status(conn: &Connection) -> String {
    conn.query_row(
        "SELECT payment_status FROM orders WHERE id = ?1",
        params![LOCAL_ORDER],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn a_payment_voided_on_the_server_stops_counting_on_a_till_that_mirrored_it() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");

    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "completed");
    assert_eq!(payment_status(&conn), "paid");

    // Another terminal voids it; the next pull brings the voided row.
    mirror(&conn, &server_payment("voided", "2026-09-30T11:00:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1, "no new row");
    assert_eq!(rows[0].1, "voided", "never completed money here");
    assert_ne!(payment_status(&conn), "paid");

    // The pulled order page (server label pending) keeps it that way.
    let page_error = crate::sync::apply_remote_orders_page_for_test(
        &conn,
        vec![json!({
            "id": REMOTE_ORDER,
            "status": "completed",
            "payment_status": "pending",
            "updated_at": "2026-09-30T11:00:05Z"
        })],
    );
    assert!(page_error.is_none(), "{page_error:?}");
    assert_ne!(payment_status(&conn), "paid");
}

#[test]
fn a_refund_on_the_server_marks_the_local_row_refunded() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));

    mirror(&conn, &server_payment("refunded", "2026-09-30T11:00:00Z"));

    assert_eq!(local_rows(&conn)[0].1, "refunded");
    assert_ne!(payment_status(&conn), "paid");
}

#[test]
fn the_origin_tills_drawer_gives_back_a_payment_voided_on_the_server() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    seed_drawer(&conn, 1300);
    // Recorded on this till, pushed, and linked to its server row.
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status, payment_origin,
             staff_shift_id, remote_payment_id, sync_status, sync_state, created_at, updated_at
         ) VALUES ('pay-origin', ?1, 'cash', 13.0, 1300, 'EUR', 'completed', 'manual', ?2, ?3,
                   'synced', 'applied', '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![LOCAL_ORDER, SHIFT, REMOTE_PAYMENT],
    )
    .unwrap();
    conn.execute(
        "UPDATE orders SET payment_status = 'paid' WHERE id = ?1",
        params![LOCAL_ORDER],
    )
    .unwrap();

    mirror(&conn, &server_payment("voided", "2026-09-30T11:00:00Z"));

    assert_eq!(
        local_rows(&conn),
        vec![("pay-origin".to_string(), "voided".to_string())]
    );
    let drawer_cash: i64 = conn
        .query_row(
            "SELECT total_cash_sales_cents FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
            params![SHIFT],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(drawer_cash, 0, "the drawer no longer expects it");
}

#[test]
fn a_courier_is_not_charged_for_a_payment_voided_on_the_server() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    for (category, key, value) in [
        ("terminal", "branch_id", BRANCH),
        ("restaurant", "store_currency_branch_id", BRANCH),
        ("restaurant", "store_currency_available", "true"),
        ("restaurant", "store_currency_source", "branch_country"),
        ("restaurant", "currency", "EUR"),
    ] {
        crate::db::set_setting(&conn, category, key, value).unwrap();
    }
    seed_order(&conn, "delivery");
    conn.execute(
        "INSERT INTO staff_shifts (currency, id, staff_id, role_type, branch_id, check_in_time,
            opening_cash_amount, opening_cash_amount_cents, status, calculation_version,
            sync_status, created_at, updated_at) VALUES ('EUR', 'shift-courier-remote', 'driver-remote', 'driver', ?1, '2026-09-30T08:30:00Z',
                 20.0, 2000, 'active', 2, 'pending', '2026-09-30T08:30:00Z',
                 '2026-09-30T08:30:00Z')",
        params![BRANCH],
    )
    .unwrap();
    // The receipt was collected by this courier, whose shift is known here.
    // A later assignment alone must never transfer another collector's cash.
    conn.execute(
        "UPDATE orders SET staff_shift_id = 'shift-courier-remote' WHERE id = ?1",
        params![LOCAL_ORDER],
    )
    .unwrap();
    let mut receipt = server_payment("completed", "2026-09-30T10:05:00Z");
    receipt["metadata"] = json!({
        "staff_id": "driver-remote",
        "staff_shift_id": "shift-courier-remote",
        "collected_by": "driver_shift"
    });
    mirror(&conn, &receipt);
    let assignment = crate::order_ownership::assign_order_to_driver_shift(
        &conn,
        LOCAL_ORDER,
        "driver-remote",
        Some("Driver"),
        "shift-courier-remote",
        "2026-09-30T10:30:00Z",
    )
    .unwrap();
    crate::order_ownership::upsert_driver_earning(
        &conn,
        LOCAL_ORDER,
        "driver-remote",
        &assignment,
        "2026-09-30T10:30:00Z",
    )
    .unwrap();

    let before_void: i64 = conn
        .query_row(
            "SELECT cash_to_return_cents FROM driver_earnings WHERE order_id = ?1",
            params![LOCAL_ORDER],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(before_void, 1300, "the courier initially holds the receipt");
    receipt["status"] = json!("voided");
    receipt["updated_at"] = json!("2026-09-30T11:00:00Z");
    mirror(&conn, &receipt);

    let cash_to_return: i64 = conn
        .query_row(
            "SELECT cash_to_return_cents FROM driver_earnings WHERE order_id = ?1",
            params![LOCAL_ORDER],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cash_to_return, 0);
}

#[test]
fn a_local_change_still_on_its_way_goes_first() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));
    let payment_id = local_rows(&conn)[0].0.clone();
    // A refund recorded here, not applied on the server yet.
    conn.execute(
        "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount,
            amount_cents, reason, sync_state, created_at, updated_at)
         VALUES ('adj-in-flight', ?1, ?2, 'refund', 5.0, 500, 'wrong item', 'pending',
                 '2026-09-30T10:50:00Z', '2026-09-30T10:50:00Z')",
        params![payment_id, LOCAL_ORDER],
    )
    .unwrap();

    mirror(&conn, &server_payment("voided", "2026-09-30T11:00:00Z"));

    assert_eq!(local_rows(&conn)[0].1, "completed", "left for a later pull");
}

#[test]
fn the_pre_edit_restore_applies_a_void_and_never_raises_the_label_back() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    mirror(&conn, &server_payment("completed", "2026-09-30T10:05:00Z"));
    assert_eq!(payment_status(&conn), "paid");

    crate::sync::apply_order_payment_ledger_before_payment_decision(
        &conn,
        LOCAL_ORDER,
        REMOTE_ORDER,
        &[server_payment("voided", "2026-09-30T11:00:00Z")],
        "2026-09-30T11:00:10Z",
    )
    .expect("restore the ledger before the edit");

    assert_eq!(local_rows(&conn)[0].1, "voided");
    assert_ne!(
        payment_status(&conn),
        "paid",
        "the edit must not treat voided money as paid"
    );
}

/// A gift card row's return belongs to #308's gift return import, which nets
/// it by its proven return floor: the pull never flips it (as on Android).
#[test]
fn a_gift_card_row_is_left_to_its_return_import() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order(&conn, "takeaway");
    // The server's atomic redemption result, with its proof.
    let gift = |status: &str, updated_at: &str| {
        let mut payment = server_payment(status, updated_at);
        payment["payment_method"] = json!("gift_card");
        payment["external_transaction_id"] = json!("gift_card:gift-txn-0301");
        payment["metadata"] = json!({ "gift_card_transaction_id": "gift-txn-0301" });
        payment
    };

    mirror(&conn, &gift("completed", "2026-09-30T10:05:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "completed");

    mirror(&conn, &gift("refunded", "2026-09-30T11:00:00Z"));
    let rows = local_rows(&conn);
    assert_eq!(rows.len(), 1, "no new row");
    assert_eq!(
        rows[0].1, "completed",
        "its return import decides, not the pull"
    );
}

mod canonical_collector {
    use super::*;

    const STAFF: &str = "887b95e5-69d3-4820-98a9-00ef928f36e5";
    const COLLECTOR_SHIFT: &str = "ecfdc532-881f-4028-b5a5-1188db039c01";

    fn seed(conn: &Connection, order_type: &str) {
        seed_order(conn, order_type);
        seed_drawer(conn, 0);
        crate::db::set_setting(conn, "terminal", "organization_id", "org-mirror").unwrap();
        crate::db::set_setting(conn, "terminal", "branch_id", BRANCH).unwrap();
        conn.execute(
            "UPDATE orders SET staff_id='original-waiter', staff_shift_id='original-waiter-shift'
             WHERE id=?1",
            [LOCAL_ORDER],
        )
        .unwrap();
    }

    fn collector() -> Value {
        json!({ "staff_id": STAFF, "staff_shift_id": COLLECTOR_SHIFT,
            "collected_by": "cashier_drawer", "original_annotation": "kept" })
    }

    fn provenance(conn: &Connection) -> (Option<String>, Option<String>, Option<Value>) {
        conn.query_row(
            "SELECT staff_id, staff_shift_id, metadata FROM order_payments WHERE remote_payment_id=?1",
            [REMOTE_PAYMENT],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<String>>(2)?
                .map(|raw| serde_json::from_str(&raw).unwrap()))),
        ).unwrap()
    }

    fn unchanged_collection_side_effects(conn: &Connection) {
        let owner: (String, String) = conn
            .query_row(
                "SELECT staff_id, staff_shift_id FROM orders WHERE id=?1",
                [LOCAL_ORDER],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            owner,
            ("original-waiter".into(), "original-waiter-shift".into())
        );
        let cash: i64 = conn
            .query_row(
                "SELECT total_cash_sales_cents FROM cash_drawer_sessions WHERE staff_shift_id=?1",
                [SHIFT],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            cash, 0,
            "a canonical mirror never collects into this drawer"
        );
        for table in ["sync_queue", "parity_sync_queue"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "no payment or ownership queue on {table}");
        }
    }

    #[test]
    fn new_mirror_preserves_recorded_collector_in_object_and_text_aliases() {
        for metadata in [
            collector(),
            json!({ "staffId": STAFF, "staffShiftId": COLLECTOR_SHIFT,
            "collectedBy": "cashier_drawer", "original_annotation": "kept" }),
            Value::String(collector().to_string()),
        ] {
            let td = TestDb::open();
            let conn = td.state.conn.lock().unwrap();
            seed(&conn, "dine-in");
            let mut remote = server_payment("completed", "2026-09-30T10:05:00Z");
            remote["metadata"] = metadata.clone();
            remote["table_session_id"] = json!("recorded-table-session");
            remote["seat_number"] = json!(2);
            mirror(&conn, &remote);
            let expected = match metadata {
                Value::String(raw) => serde_json::from_str(&raw).unwrap(),
                other => other,
            };
            assert_eq!(
                provenance(&conn),
                (
                    Some(STAFF.into()),
                    Some(COLLECTOR_SHIFT.into()),
                    Some(expected)
                )
            );
            let receipt: (i64, i64, String, String, String, String, String, i64) = conn.query_row(
                "SELECT amount_cents,tip_amount_cents,currency,status,payment_origin,sync_state,table_session_id,seat_number
                 FROM order_payments WHERE remote_payment_id=?1", [REMOTE_PAYMENT],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
            ).unwrap();
            assert_eq!(
                receipt,
                (
                    1300,
                    0,
                    "EUR".into(),
                    "completed".into(),
                    "sync_reconstructed".into(),
                    "applied".into(),
                    "recorded-table-session".into(),
                    2
                )
            );
            unchanged_collection_side_effects(&conn);
        }
    }

    #[test]
    fn missing_collector_does_not_choose_waiter_or_current_cashier() {
        for (metadata, staff, shift) in [
            (json!({}), None, None),
            (json!({"staff_id": STAFF}), Some(STAFF), None),
            (json!({"staff_shift_id": SHIFT}), None, Some(SHIFT)),
        ] {
            let td = TestDb::open();
            let conn = td.state.conn.lock().unwrap();
            seed(&conn, "dine-in");
            let mut remote = server_payment("completed", "2026-09-30T10:05:00Z");
            remote["metadata"] = metadata.clone();
            mirror(&conn, &remote);
            assert_eq!(
                provenance(&conn),
                (
                    staff.map(String::from),
                    shift.map(String::from),
                    Some(metadata)
                )
            );
            unchanged_collection_side_effects(&conn);
        }
    }

    #[test]
    fn malformed_contradictory_or_foreign_collector_is_refused_before_insertion() {
        for metadata in [
            json!({ "staff_id": STAFF, "staffId": "another-person" }),
            json!({ "staff_shift_id": 27 }),
            json!({ "collected_by": "invented-handler" }),
            json!({ "staff_id": STAFF, "branch_id": "other-branch" }),
            json!({ "staff_id": STAFF, "organization_id": "other-org" }),
            json!([STAFF]),
            json!("{not-json"),
        ] {
            let td = TestDb::open();
            let conn = td.state.conn.lock().unwrap();
            seed(&conn, "dine-in");
            let mut remote = server_payment("completed", "2026-09-30T10:05:00Z");
            remote["metadata"] = metadata;
            assert!(crate::sync::sync_remote_payment_into_local_for_test(&conn, &remote).is_err());
            assert!(local_rows(&conn).is_empty());
            unchanged_collection_side_effects(&conn);
        }
    }

    #[test]
    fn known_collector_shift_must_match_branch_and_recorded_staff_but_may_be_closed() {
        for (branch, staff, accepted) in [
            (BRANCH, STAFF, true),
            ("foreign-branch", STAFF, false),
            (BRANCH, "other-staff", false),
        ] {
            let td = TestDb::open();
            let conn = td.state.conn.lock().unwrap();
            seed(&conn, "dine-in");
            conn.execute("INSERT INTO staff_shifts(currency,id,staff_id,role_type,branch_id,check_in_time,status,created_at,updated_at)
                VALUES('EUR',?1,?2,'cashier',?3,'old','closed','old','old')", params![COLLECTOR_SHIFT, staff, branch]).unwrap();
            let mut remote = server_payment("completed", "2026-09-30T10:05:00Z");
            remote["metadata"] = collector();
            let result = crate::sync::sync_remote_payment_into_local_for_test(&conn, &remote);
            assert_eq!(
                result.is_ok(),
                accepted,
                "known scope must match; closed historical shifts are valid"
            );
            if accepted {
                assert_eq!(provenance(&conn).0.as_deref(), Some(STAFF));
            } else {
                assert!(local_rows(&conn).is_empty());
            }
            unchanged_collection_side_effects(&conn);
        }
    }

    #[test]
    fn existing_receipt_provenance_remains_frozen_even_with_conflicting_pull_metadata() {
        let td = TestDb::open();
        let conn = td.state.conn.lock().unwrap();
        seed(&conn, "dine-in");
        conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,
            payment_origin,staff_id,staff_shift_id,remote_payment_id,sync_status,sync_state,metadata,created_at,updated_at)
            VALUES('original-receipt',?1,'cash',13,1300,'EUR','completed','manual',?2,?3,?4,'synced','applied',?5,'old','old')",
            params![LOCAL_ORDER, STAFF, COLLECTOR_SHIFT, REMOTE_PAYMENT, collector().to_string()]).unwrap();
        let before = provenance(&conn);
        let mut remote = server_payment("completed", "2026-09-30T11:00:00Z");
        remote["metadata"] =
            json!({ "staff_id": "later-staff", "staffId": "conflict", "staff_shift_id": SHIFT });
        mirror(&conn, &remote);
        assert_eq!(provenance(&conn), before);
        assert_eq!(local_rows(&conn).len(), 1);
        unchanged_collection_side_effects(&conn);
    }

    #[test]
    fn remote_driver_marker_is_evidence_without_a_second_driver_collection() {
        let td = TestDb::open();
        let conn = td.state.conn.lock().unwrap();
        seed(&conn, "delivery");
        conn.execute("INSERT INTO driver_earnings(id,driver_id,staff_shift_id,order_id,branch_id,
            total_earning,payment_method,cash_collected,cash_collected_cents,cash_to_return,cash_to_return_cents,created_at,updated_at)
            VALUES('earning','driver-original',NULL,?1,?2,0,'cash',0,0,0,0,'old','old')",
            params![LOCAL_ORDER, BRANCH]).unwrap();
        let mut remote = server_payment("completed", "2026-09-30T10:05:00Z");
        remote["metadata"] = json!({ "staff_id": "driver-original", "staff_shift_id": "original-waiter-shift", "collected_by": "driver_shift" });
        mirror(&conn, &remote);
        assert_eq!(provenance(&conn).0.as_deref(), Some("driver-original"));
        let cents: i64 = conn
            .query_row(
                "SELECT cash_collected_cents FROM driver_earnings WHERE id='earning'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cents, 0);
        unchanged_collection_side_effects(&conn);
    }

    #[test]
    fn internal_provenance_cannot_authorize_collection_queue_drawer_or_owner_writes() {
        for invalid in 0..8 {
            let td = TestDb::open();
            let conn = td.state.conn.lock().unwrap();
            seed(&conn, "dine-in");
            let mut input = crate::payments::build_applied_canonical_payment_record_input(&json!({
                "orderId": LOCAL_ORDER, "method": "cash", "amount": 13, "currency": "EUR",
                "paymentOrigin": "sync_reconstructed",
            }))
            .unwrap();
            let mut options = crate::payments::PaymentInsertOptions::applied_canonical(
                REMOTE_PAYMENT.into(),
                crate::payments::AppliedCanonicalPaymentProvenance {
                    staff_id: Some(STAFF.into()),
                    staff_shift_id: Some(COLLECTOR_SHIFT.into()),
                    metadata: Some(collector()),
                },
            );
            match invalid {
                0 => options.enqueue_sync = true,
                1 => options.update_cash_drawer = true,
                2 => options.sync_order_owner_with_payment = true,
                3 => options.remote_payment_id = None,
                4 => options.sync_state = Some("pending".into()),
                5 => options.sync_status = "pending".into(),
                6 => input.payment_origin = "manual".into(),
                _ => {
                    options
                        .applied_canonical_provenance
                        .as_mut()
                        .unwrap()
                        .metadata = Some(json!([]))
                }
            }
            let error =
                crate::payments::record_payment_in_connection(&conn, &input, &options).unwrap_err();
            assert_eq!(error, "CANONICAL_PAYMENT_PROVENANCE_MODE_INVALID");
            assert!(local_rows(&conn).is_empty());
            unchanged_collection_side_effects(&conn);
        }
    }

    #[test]
    fn public_json_does_not_create_internal_provenance_authority() {
        let input = crate::payments::build_payment_record_input(&json!({
            "orderId": LOCAL_ORDER, "method": "cash", "amount": 13, "currency": "EUR",
            "applied_canonical_provenance": { "staff_id": STAFF, "staff_shift_id": COLLECTOR_SHIFT },
            "trustedCanonical": true,
        })).unwrap();
        assert_eq!(input.payment_origin, "manual");
        assert!(input.requested_staff_id.is_none());
        assert!(input.requested_staff_shift_id.is_none());
        assert!(crate::payments::PaymentInsertOptions::local()
            .applied_canonical_provenance
            .is_none());
        assert!(
            crate::payments::PaymentInsertOptions::applied(Some(REMOTE_PAYMENT.into()))
                .applied_canonical_provenance
                .is_none()
        );
    }
}
