// Include from print::tests on either c9100305e or the round-two checkout.
use super::*;
use serde_json::json;

fn add_cash_delivery(
    db: &DbState,
    shift_id: &str,
    code: &str,
    cash: i64,
    tip: i64,
    cancelled: bool,
) {
    let at = chrono::Utc::now().to_rfc3339();
    let conn = db.conn.lock().unwrap();
    let status = if cancelled { "cancelled" } else { "delivered" };
    conn.execute(
        "INSERT INTO orders (id, order_number, items, order_type, status, payment_status,
            staff_shift_id, total_amount, total_amount_cents, tip_amount, tip_amount_cents,
            branch_id, terminal_id, currency, created_at, updated_at)
         VALUES (?1, ?1, '[]', 'delivery', ?2, 'paid', ?3, ?4 / 100.0, ?4,
            ?5 / 100.0, ?5, 'branch-1', 'term-1', 'EUR', ?6, ?6)",
        params![code, status, shift_id, cash, tip, at],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO order_payments (id, order_id, method, amount, amount_cents,
            tip_amount, tip_amount_cents, status, staff_shift_id, tip_recipient_staff_shift_id,
            currency, created_at, updated_at)
         VALUES (?1, ?1, 'cash', ?2 / 100.0, ?2, ?3 / 100.0, ?3, 'completed', ?4,
            CASE WHEN ?3 > 0 THEN ?4 END, 'EUR', ?5, ?5)",
        params![code, cash, tip, shift_id, at],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
            total_earning, payment_method, tip_amount, tip_amount_cents,
            cash_collected, cash_collected_cents, cash_to_return, cash_to_return_cents,
            currency, created_at, updated_at)
         VALUES (?1, 'probe-driver', ?2, ?1, 'branch-1', ?3 / 100.0, 'cash', ?3 / 100.0, ?3,
            ?4 / 100.0, ?4, ?4 / 100.0, ?4, 'EUR', ?5, ?5)",
        params![code, shift_id, tip, cash, at],
    )
    .unwrap();
}

fn print_figures(db: &DbState, shift_id: &str, label: &str) {
    let summary = crate::shifts::get_shift_summary(db, shift_id).unwrap();
    let screen_lines: Vec<_> = summary["driverDeliveries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                &row["order_number"],
                &row["status"],
                row["cash_collected"].as_f64().unwrap(),
            )
        })
        .collect();
    let screen_cash = screen_lines.iter().map(|row| row.2).sum::<f64>();
    let opening = summary["shift"]["opening_cash_amount"].as_f64().unwrap();
    let expenses = summary["totalExpenses"].as_f64().unwrap();
    let tips = summary["tipsReceived"].as_f64().unwrap();
    eprintln!("{label} screen: due={}, opening={opening}, cash={screen_cash}, expenses={expenses}, tips={tips}, cash lines={screen_lines:?}, cash-line sum={screen_cash}, formula sum={}",
        summary["amountToReturn"], opening + screen_cash - expenses - tips);

    let doc = build_shift_checkout_doc(db, shift_id, None).unwrap();
    let print_lines: Vec<_> = doc
        .driver_deliveries
        .iter()
        .map(|row| (&row.order_number, &row.status, row.cash_collected))
        .collect();
    let print_line_sum = print_lines.iter().map(|row| row.2).sum::<f64>();
    eprintln!("{label} print: due={}, opening={}, cash={}, expenses={}, tips={}, delivery cash lines={print_lines:?}, delivery cash-line sum={print_line_sum}, formula sum={}",
        doc.amount_to_return, doc.opening_amount, doc.total_cash_collected, doc.total_expenses,
        doc.total_tips, doc.opening_amount + doc.total_cash_collected - doc.total_expenses - doc.total_tips);
}

#[test]
fn fix2_win_cash_breakdown_base_probe() {
    let _fake = crate::tests::fake_keyring::install_empty();
    for mixed in [false, true] {
        let db = test_db();
        seed_print_store_currency(&db);
        let at = (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339();
        {
            let conn = db.conn.lock().unwrap();
            insert_active_cashier_fixture(&conn, "probe-cashier", "probe-drawer");
            conn.execute("UPDATE staff_shifts SET check_in_time=?1", [&at])
                .unwrap();
            conn.execute("UPDATE cash_drawer_sessions SET opened_at=?1", [&at])
                .unwrap();
        }
        let opened = crate::shifts::open_shift(
            &db,
            &json!({
                "staffId": "probe-driver", "branchId": "branch-1", "terminalId": "term-1",
                "roleType": "driver", "openingCash": 20.0,
            }),
        )
        .unwrap();
        let shift_id = opened["shiftId"].as_str().unwrap();
        let fixture = if mixed {
            "mixed handover"
        } else {
            "cancelled cash"
        };
        add_cash_delivery(
            &db,
            shift_id,
            "#0017",
            1000,
            if mixed { 100 } else { 0 },
            !mixed,
        );
        if mixed {
            let handover = crate::shifts::close_shift(
                &db,
                &json!({
                    "shiftId": "probe-cashier", "closingCash": 180.0,
                }),
            )
            .unwrap();
            eprintln!("{fixture} cashier close: {handover}");
            add_cash_delivery(&db, shift_id, "#0018", 500, 0, false);
        }
        print_figures(&db, shift_id, &format!("{fixture}, open"));
        // During handover there is no receiving drawer. A zero count lets the
        // probe observe native expected cash without recording a hand-in.
        let close = crate::shifts::close_shift(
            &db,
            &json!({
                "shiftId": shift_id, "closingCash": if mixed { 0.0 } else { 30.0 },
                "expectedDriverKeptTips": 0.0, "expectedDriverPayout": 0.0,
            }),
        )
        .unwrap();
        eprintln!("{fixture} driver close: {close}");
        print_figures(&db, shift_id, &format!("{fixture}, closed"));
    }
}
