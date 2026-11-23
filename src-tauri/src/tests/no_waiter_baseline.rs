use std::{fs, path::Path};

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{params, types::ValueRef, Connection};
use serde_json::{json, Value};

use super::{fake_keyring, harness::TestDb};
use crate::{
    commands::orders::{apply_order_status_locally, assign_driver_locally, LocalStatusChange},
    db::{self, DbState},
    payments, refunds, shifts, sync, sync_queue, zreport,
};

const ORG: &str = "10000000-0000-4000-8000-000000000001";
const BRANCH: &str = "10000000-0000-4000-8000-000000000002";
const MAIN: &str = "main-till";
const MAIN_DB: &str = "10000000-0000-4000-8000-000000000003";
const CASHIER: &str = "10000000-0000-4000-8000-000000000004";
const DRIVER: &str = "10000000-0000-4000-8000-000000000005";
const TABLE: &str = "10000000-0000-4000-8000-000000000006";
const ADMIN_URL: &str = "https://no-waiter.invalid";
const VOID_REASON: &str = "Customer cancelled";

struct Sale {
    number: u8,
    kind: &'static str,
    session: Option<&'static str>,
    // Each portion is (method, principal cents, tip cents).
    tenders: &'static [(&'static str, i64, i64)],
}

const SALES: &[Sale] = &[
    Sale {
        number: 1,
        kind: "pickup",
        session: None,
        tenders: &[("cash", 1200, 0)],
    },
    Sale {
        number: 2,
        kind: "pickup",
        session: None,
        tenders: &[("card", 1500, 150)],
    },
    Sale {
        number: 3,
        kind: "pickup",
        session: None,
        tenders: &[("cash", 1000, 0), ("card", 800, 100)],
    },
    Sale {
        number: 4,
        kind: "dine-in",
        session: Some("10000000-0000-4000-8000-000000000014"),
        tenders: &[("cash", 2000, 200)],
    },
    Sale {
        number: 5,
        kind: "dine-in",
        session: Some("10000000-0000-4000-8000-000000000015"),
        tenders: &[("card", 1100, 100)],
    },
    Sale {
        number: 6,
        kind: "dine-in",
        session: None,
        tenders: &[("card", 900, 50)],
    },
    Sale {
        number: 7,
        kind: "delivery",
        session: None,
        tenders: &[("cash", 1400, 100)],
    },
    Sale {
        number: 8,
        kind: "delivery",
        session: None,
        tenders: &[("card", 1300, 75)],
    },
];

fn euros(cents: i64) -> f64 {
    cents as f64 / 100.0
}

fn cents(value: &Value) -> i64 {
    (value
        .as_f64()
        .unwrap_or_else(|| panic!("expected money, got {value}"))
        * 100.0)
        .round() as i64
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing {key}: {value}"))
}

fn seed_till(db: &DbState) {
    {
        let conn = db.conn.lock().unwrap();
        for (category, key, value) in [
            ("terminal", "organization_id", ORG),
            ("terminal", "branch_id", BRANCH),
            ("terminal", "terminal_id", MAIN),
            ("terminal", "terminal_type", "main"),
            ("terminal", "source_terminal_db_id", MAIN_DB),
            ("restaurant", "store_currency_branch_id", BRANCH),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
            ("restaurant", "currency", "EUR"),
        ] {
            db::set_setting(&conn, category, key, value).unwrap();
        }
    }
    crate::core_helpers::write_module_cache(
        db,
        &json!({
            "storeScopeVersion": 3,
            "adminDashboardUrl": ADMIN_URL,
            "organizationId": ORG,
            "branchId": BRANCH,
            "terminalId": MAIN,
            "apiModules": [{ "module_id": "tables" }, { "module_id": "delivery" }],
        }),
    )
    .unwrap();
}

fn open(db: &DbState, staff: &str, name: &str, role: &str, float: i64) -> String {
    let result = shifts::open_shift(
        db,
        &json!({
            "staffId": staff, "staffName": name, "roleType": role,
            "branchId": BRANCH, "terminalId": MAIN, "openingCash": euros(float),
        }),
    )
    .unwrap();
    assert_eq!(result["success"], true, "{result}");
    string(&result, "shiftId").to_owned()
}

fn seed_order(db: &DbState, sale: &Sale, order: &str, remote: &str, cashier: &str) {
    let principal = sale.tenders.iter().map(|portion| portion.1).sum::<i64>();
    // Checkout includes its tip in the order total. Table-check tips are
    // recorded on the receipt, on top of an existing check's principal.
    let header_tip = if sale.session.is_some() {
        0
    } else {
        sale.tenders.iter().map(|portion| portion.2).sum::<i64>()
    };
    let status = if sale.kind == "delivery" {
        "ready"
    } else {
        "pending"
    };
    let owner = sale.session.is_none().then_some(cashier);
    let owner_staff = owner.map(|_| CASHIER);
    let table = sale.session.map(|_| TABLE);
    let table_number = table.map(|_| "1");
    let now = Utc::now().to_rfc3339();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO orders (
            id, supabase_id, order_number, order_type, status, payment_status, sync_status,
            subtotal, total_amount, total_amount_cents, tip_amount, tip_amount_cents,
            table_id, table_number, table_session_id, staff_id, staff_shift_id,
            organization_id, branch_id, terminal_id, currency, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, 'pending', 'synced',
            ?6 / 100.0, ?7 / 100.0, ?7, ?8 / 100.0, ?8,
            ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'EUR', ?17, ?17
         )",
            params![
                order,
                remote,
                format!("#{}", sale.number),
                sale.kind,
                status,
                principal,
                principal + header_tip,
                header_tip,
                table,
                table_number,
                sale.session,
                owner_staff,
                owner,
                ORG,
                BRANCH,
                MAIN,
                now,
            ],
        )
        .unwrap();
}

fn assign(db: &DbState, order: &str) {
    let (_, _, status, refusal) = assign_driver_locally(
        &db.conn.lock().unwrap(),
        order,
        DRIVER,
        None,
        &Utc::now().to_rfc3339(),
    )
    .unwrap();
    assert_eq!(refusal, None, "{order}");
    assert_eq!(status, "delivered", "{order}");
}

fn order_status(db: &DbState, order: &str, status: &str, reason: Option<&str>) {
    let result =
        apply_order_status_locally(db, order, status, None, reason, &Utc::now().to_rfc3339())
            .unwrap();
    if let LocalStatusChange::Blocked(blocker) = result {
        panic!("{order} could not move to {status}: {blocker}");
    }
}

fn record(
    db: &DbState,
    order: &str,
    sale: &Sale,
    (method, principal, tip): (&str, i64, i64),
    driver_shift: &str,
) -> String {
    let amount = euros(principal + tip);
    let mut payload = json!({
        "orderId": order, "method": method, "paymentOrigin": "manual",
        "amount": amount, "tipAmount": euros(tip),
        "idempotencyKey": format!("no-waiter-{order}-{method}"),
    });
    if method == "cash" {
        payload["cashReceived"] = json!(amount);
        payload["changeGiven"] = json!(0);
    }
    if let Some(session) = sale.session {
        // The table manager uses record_payment with a session and no
        // explicit collector or tip recipient. The recorder resolves C.
        payload["tableSessionId"] = json!(session);
    }
    if sale.number == 7 {
        payload["staffShiftId"] = json!(driver_shift);
        payload["collectedBy"] = json!("driver_shift");
    }
    let result = payments::record_payment(db, &payload)
        .unwrap_or_else(|error| panic!("{order} {method}: {error}"));
    assert_eq!(result["success"], true, "{result}");
    string(&result, "paymentId").to_owned()
}

// Mirror the active checkout display using the till's live ledger and drawer
// reads. This script has one issuing drawer and no handed-over floats.
fn cashier_count(summary: &Value) -> i64 {
    let drawer = &summary["cashDrawer"];
    let cash = &summary["cashierCash"];
    let staff_payments = summary["staffPayments"].as_array().unwrap();
    let payouts = if staff_payments.is_empty() {
        cents(&drawer["total_staff_payments"])
    } else {
        staff_payments
            .iter()
            .map(|payment| cents(&payment["amount"]))
            .sum()
    };
    cents(&drawer["opening_amount"]) + cents(&cash["cashCollections"])
        - cents(&cash["cashRefunds"])
        - cents(&summary["totalExpenses"])
        - payouts
        - cents(&drawer["cash_drops"])
        - cents(&drawer["driver_cash_given"])
        + cents(&drawer["driver_cash_returned"])
}

fn close(db: &DbState, id: &str, counted: i64, driver_preview: Option<&Value>) -> Value {
    let mut payload = json!({ "shiftId": id, "closingCash": euros(counted) });
    if let Some(preview) = driver_preview {
        payload["expectedDriverKeptTips"] = preview["tipsReceived"].clone();
        payload["expectedDriverPayout"] =
            json!(preview["driverDrawerPayout"].as_f64().unwrap_or(0.0));
    }
    let result = shifts::close_shift(db, &payload).unwrap();
    assert_eq!(result["success"], true, "{result}");
    assert_eq!(cents(&result["closing"]), counted, "{result}");
    assert_eq!(cents(&result["variance"]), 0, "{result}");
    let closed = shifts::get_shift_summary(db, id).unwrap();
    json!({
        "expectedCents": cents(&result["expected"]),
        "countedCents": cents(&result["closing"]),
        "varianceCents": cents(&result["variance"]),
        "tipsReceivedCents": cents(&closed["tipsReceived"]),
        "keptTipsCents": driver_preview.map(|preview| cents(&preview["tipsReceived"])),
        "payoutCents": closed["driverDrawerPayout"].as_f64().map_or(0, |amount| cents(&json!(amount))),
        "netCollections": result["netCollections"],
    })
}

fn stored_receipts(conn: &Connection) -> Value {
    // Read the ledger directly so a new custody or tip_recipient_* column
    // is included even if the receipt's public response omits it.
    let mut query = conn
        .prepare("SELECT * FROM order_payments ORDER BY order_id, method, rowid")
        .unwrap();
    let columns: Vec<_> = query
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let receipts = query
        .query_map([], |row| {
            let mut receipt = serde_json::Map::new();
            for (index, column) in columns.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) => json!(value),
                    ValueRef::Real(value) => json!(value),
                    ValueRef::Text(value) => {
                        let raw = std::str::from_utf8(value).unwrap();
                        if column == "metadata" {
                            serde_json::from_str(raw).unwrap_or_else(|_| json!(raw))
                        } else {
                            json!(raw)
                        }
                    }
                    ValueRef::Blob(value) => json!(value),
                };
                receipt.insert(column.clone(), value);
            }
            Ok(Value::Object(receipt))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    json!(receipts)
}

fn queued_bodies(
    conn: &Connection,
    driver_shift: &str,
    reversal_parents: [(&str, &str); 2],
) -> Value {
    let mut query = conn
        .prepare(
            "SELECT table_name, record_id, data FROM parity_sync_queue
         WHERE table_name IN ('payments', 'payment_adjustments')
            OR (table_name = 'staff_shifts' AND operation = 'UPDATE')
         ORDER BY rowid",
        )
        .unwrap();
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();

    // The dispatcher prepares these bodies only after the office has seen
    // the shift opens and parent order writes. Simulate those acknowledgments
    // inside a savepoint so the Z sees the local day before any replay.
    conn.execute_batch("SAVEPOINT no_waiter_replay").unwrap();
    {
        let mut prerequisites = conn
            .prepare(
                "SELECT id, claim_generation FROM parity_sync_queue
             WHERE table_name = 'orders' OR (table_name = 'staff_shifts' AND operation = 'INSERT')",
            )
            .unwrap();
        let acknowledgments = prerequisites
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for (id, generation) in acknowledgments {
            sync_queue::mark_success(conn, &id, generation).unwrap();
        }
    }

    let mut bodies = json!({ "payments": [], "paymentAdjustments": [], "shiftCloses": [] });
    // The existing test seam prepares the newest row per record. This script
    // has no concurrent replay, so a second row for a record is a regression.
    let mut seen = std::collections::BTreeSet::new();
    for (table, id, raw) in &rows {
        assert!(
            seen.insert((table, id)),
            "duplicate queue row for {table}/{id}"
        );
        if table == "payment_adjustments" {
            continue;
        }
        let mut queued: Value = serde_json::from_str(raw).unwrap();
        let mut body = sync_queue::request_body_for_test(conn, table, id)
            .unwrap_or_else(|error| panic!("{table}/{id}: {error}"));
        let group = if table == "staff_shifts" {
            assert_eq!(body["events"][0]["event_type"], "shift_close", "{body}");
            let entity_key: String = conn
                .query_row(
                    "SELECT idempotency_key FROM staff_shifts WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                body["events"][0]["idempotency_key"],
                format!("{entity_key}:update"),
            );
            if id == driver_shift {
                // The sole compatibility allowance, on the driver's close.
                queued.as_object_mut().unwrap().remove("keptTips");
                body["events"][0]["data"]
                    .as_object_mut()
                    .unwrap()
                    .remove("keptTips");
            }
            "shiftCloses"
        } else {
            "payments"
        };
        bodies[group]
            .as_array_mut()
            .unwrap()
            .push(json!({ "queued": queued, "request": body }));
    }

    for (local, remote) in reversal_parents {
        sync::mark_local_payment_applied(conn, local, &Utc::now().to_rfc3339(), Some(remote))
            .unwrap();
    }
    for (table, id, raw) in &rows {
        if table == "payment_adjustments" {
            let queued: Value = serde_json::from_str(raw).unwrap();
            let body = sync_queue::request_body_for_test(conn, table, id)
                .unwrap_or_else(|error| panic!("{table}/{id}: {error}"));
            bodies["paymentAdjustments"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "queued": queued, "request": body }));
        }
    }
    conn.execute_batch("ROLLBACK TO no_waiter_replay; RELEASE no_waiter_replay")
        .unwrap();
    assert_eq!(bodies["payments"].as_array().unwrap().len(), 9);
    assert_eq!(bodies["paymentAdjustments"].as_array().unwrap().len(), 2);
    assert_eq!(bodies["shiftCloses"].as_array().unwrap().len(), 2);
    bodies
}

fn normalize(value: &mut Value, ids: &[(String, String)], date: &str, start: i64, end: i64) {
    match value {
        Value::String(raw) => {
            // SQLite can emit second-resolution UTC without an offset.
            let instant = DateTime::parse_from_rfc3339(raw)
                .map(|time| time.timestamp())
                .or_else(|_| {
                    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f")
                        .map(|time| time.and_utc().timestamp())
                });
            if instant.is_ok_and(|second| (start..=end).contains(&second)) {
                *raw = "@time".into();
            } else if raw == date {
                *raw = "@business-date".into();
            } else {
                for (id, label) in ids {
                    // IDs also occur inside composite idempotency keys.
                    if raw.contains(id.as_str()) {
                        *raw = raw.replace(id.as_str(), label);
                    }
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize(item, ids, date, start, end);
            }
        }
        Value::Object(fields) => {
            for item in fields.values_mut() {
                normalize(item, ids, date, start, end);
            }
        }
        _ => {}
    }
}

fn golden(name: &str, value: &Value) {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/no-waiter-baseline");
    let path = directory.join(name);
    let mut actual = serde_json::to_string_pretty(value).unwrap();
    actual.push('\n');
    if std::env::var("NO_WAITER_BASELINE_WRITE").as_deref() == Ok("1") {
        fs::create_dir_all(&directory).unwrap();
        fs::write(&path, actual.as_bytes()).unwrap();
        return;
    }

    let mut expected = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read baseline {}: {error}", path.display()));
    if name == "queued-sync-bodies.json" {
        // The schema generates a fresh entity key on insert. Compare the
        // released key shape after checking the actual key against its row.
        let mut released: Value = serde_json::from_str(&expected).unwrap();
        let mut current = value.clone();
        for capture in [&mut released, &mut current] {
            for close in capture["shiftCloses"].as_array_mut().unwrap() {
                let key = &mut close["request"]["events"][0]["idempotency_key"];
                let entity_key = key.as_str().unwrap().strip_suffix(":update").unwrap();
                assert_eq!(entity_key.len(), 32);
                assert!(entity_key.bytes().all(|byte| byte.is_ascii_hexdigit()));
                *key = json!("@shift-entity-key:update");
            }
        }
        expected = serde_json::to_string_pretty(&released).unwrap() + "\n";
        actual = serde_json::to_string_pretty(&current).unwrap() + "\n";
    }
    if expected.as_bytes() != actual.as_bytes() {
        let expected: Vec<_> = expected.split_inclusive('\n').collect();
        let actual: Vec<_> = actual.split_inclusive('\n').collect();
        let line = expected
            .iter()
            .zip(&actual)
            .position(|(left, right)| left != right)
            .unwrap_or_else(|| expected.len().min(actual.len()));
        let excerpt = |lines: &[&str]| -> String {
            lines
                .iter()
                .enumerate()
                .skip(line.saturating_sub(2))
                .take(5)
                .map(|(index, text)| format!("{:>4} {text:?}\n", index + 1))
                .collect::<Vec<_>>()
                .join("")
        };
        panic!(
            "{} differs at line {}\nExpected:\n{}Actual:\n{}",
            path.display(),
            line + 1,
            excerpt(&expected),
            excerpt(&actual)
        );
    }
}

#[test]
fn no_waiter_baseline() {
    let start = Utc::now().timestamp();
    let _keyring = fake_keyring::install_seeded([
        ("organization_id", ORG),
        ("branch_id", BRANCH),
        ("terminal_id", MAIN),
        ("admin_dashboard_url", ADMIN_URL),
    ]);
    let test_db = TestDb::open();
    let db = &test_db.state;
    seed_till(db);
    let cashier = open(db, CASHIER, "C", "cashier", 10_000);
    let driver = open(db, DRIVER, "D", "driver", 2_000);
    let mut ids = vec![
        (cashier.clone(), "C-shift".into()),
        (driver.clone(), "D-shift".into()),
        (CASHIER.into(), "C".into()),
        (DRIVER.into(), "D".into()),
        (ORG.into(), "store".into()),
        (BRANCH.into(), "branch".into()),
        (MAIN_DB.into(), "main-db".into()),
        (TABLE.into(), "table-1".into()),
    ];

    let mut payments = Vec::new();
    for sale in SALES {
        let order = format!("order-{}", sale.number);
        let remote = format!("20000000-0000-4000-8000-{:012}", sale.number);
        seed_order(db, sale, &order, &remote, &cashier);
        ids.push((remote, format!("server-{order}")));
        if let Some(session) = sale.session {
            ids.push((session.into(), format!("check-{}", sale.number)));
        }
        if sale.number == 7 {
            assign(db, &order);
        }
        for &tender in sale.tenders {
            let id = record(db, &order, sale, tender, &driver);
            ids.push((id.clone(), format!("receipt-{}-{}", sale.number, tender.0)));
            payments.push(id);
        }
        if sale.number == 8 {
            assign(db, &order);
        } else if sale.kind != "delivery" {
            order_status(db, &order, "completed", None);
        }
    }

    let refunded = refunds::refund_payment(
        db,
        &json!({
            "paymentId": payments[1], "amount": 5.0, "refundMethod": "card",
            "reason": "Partial return", "staffId": CASHIER, "staffShiftId": cashier,
        }),
    )
    .unwrap();
    assert_eq!(refunded["success"], true, "{refunded}");
    ids.push((string(&refunded, "adjustmentId").into(), "refund-2".into()));
    let voided =
        payments::void_payment(db, &payments[0], VOID_REASON, Some(CASHIER), Some(&cashier))
            .unwrap();
    assert_eq!(voided["success"], true, "{voided}");
    ids.push((string(&voided, "adjustmentId").into(), "void-1".into()));
    // A void reverses the receipt and leaves the order owing, so abandon
    // that sale through the same local cancellation used by the till.
    order_status(db, "order-1", "cancelled", Some(VOID_REASON));

    let driver_preview = shifts::get_shift_summary(db, &driver).unwrap();
    let driver_close = close(
        db,
        &driver,
        cents(&driver_preview["amountToReturn"]),
        Some(&driver_preview),
    );
    let cashier_preview = shifts::get_shift_summary(db, &cashier).unwrap();
    let cashier_close = close(db, &cashier, cashier_count(&cashier_preview), None);
    let close_figures = json!({ "driver": driver_close, "cashier": cashier_close });
    let server_void_parent = "30000000-0000-4000-8000-000000000001";
    let server_refund_parent = "30000000-0000-4000-8000-000000000002";
    ids.push((server_void_parent.into(), "server-receipt-1-cash".into()));
    ids.push((server_refund_parent.into(), "server-receipt-2-card".into()));
    let (receipts, queue) = {
        let conn = db.conn.lock().unwrap();
        let drawer: String = conn
            .query_row(
                "SELECT id FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                [&cashier],
                |row| row.get(0),
            )
            .unwrap();
        ids.push((drawer, "C-drawer".into()));
        for order in ["order-7", "order-8"] {
            let earning: String = conn
                .query_row(
                    "SELECT id FROM driver_earnings WHERE order_id = ?1",
                    [order],
                    |row| row.get(0),
                )
                .unwrap();
            ids.push((earning, format!("earning-{order}")));
        }
        let receipts = stored_receipts(&conn);
        assert_eq!(receipts.as_array().unwrap().len(), 9);
        let queue = queued_bodies(
            &conn,
            &driver,
            [
                (&payments[0], server_void_parent),
                (&payments[1], server_refund_parent),
            ],
        );
        (receipts, queue)
    };
    let mut z = zreport::generate_z_report_for_date(db, &json!({ "branchId": BRANCH })).unwrap();
    assert_eq!(z["success"], true, "{z}");
    assert_eq!(z["report"]["shiftCount"], 2, "{z}");
    ids.push((string(&z, "zReportId").into(), "day-z".into()));
    let date = string(&z["report"], "reportDate").to_owned();
    let end = Utc::now().timestamp();

    normalize(&mut z, &ids, &date, start, end);
    // The Z sorts these sets by generated IDs, so sort again by their labels.
    for path in [
        "/report/reportJson/countedMovements/paymentIds",
        "/report/reportJson/countedMovements/adjustmentIds",
    ] {
        z.pointer_mut(path)
            .unwrap()
            .as_array_mut()
            .unwrap()
            .sort_by(|left, right| left.as_str().unwrap().cmp(right.as_str().unwrap()));
    }
    for (name, mut value) in [
        ("stored-receipts.json", receipts),
        ("queued-sync-bodies.json", queue),
        ("close-figures.json", close_figures),
    ] {
        normalize(&mut value, &ids, &date, start, end);
        golden(name, &value);
    }
    golden("z-report.json", &z);
}
