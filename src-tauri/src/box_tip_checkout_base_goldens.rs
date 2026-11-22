// Include this file in print::tests on c9100305e to record the released bytes.
use super::*;

fn base_golden(name: &str, actual: &[u8]) {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/testdata/box-tip-base-goldens");
    let path = directory.join(name);
    if std::env::var("BOX_TIP_WRITE_BASE_GOLDENS").as_deref() == Ok("1") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(path, actual).unwrap();
    } else {
        let expected = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("read released golden {}: {error}", path.display()));
        assert_eq!(actual, expected.as_slice(), "{}", path.display());
    }
}

fn compare_prints(name: &str, doc: &ReceiptDocument) {
    for (width, paper_width, printable_width_dots) in [
        (58, crate::escpos::PaperWidth::Mm58, 384),
        (80, crate::escpos::PaperWidth::Mm80, 576),
    ] {
        let layout = receipt_renderer::LayoutConfig {
            paper_width,
            printable_width_dots,
            template: receipt_renderer::ReceiptTemplate::Classic,
            classic_customer_render_mode: receipt_renderer::ClassicCustomerRenderMode::Text,
            organization_name: "Golden Store".into(),
            language: "el".into(),
            store_time_zone: Some(chrono_tz::Europe::Athens),
            decimal_comma: true,
            ..Default::default()
        };
        base_golden(
            &format!("{name}-{width}.escpos"),
            &receipt_renderer::render_escpos(doc, &layout).bytes,
        );
        base_golden(
            &format!("{name}-{width}.html"),
            receipt_renderer::render_html(doc, &layout).as_bytes(),
        );
    }
}

#[test]
fn box_tip_base_golden_zero_tip_driver_checkout() {
    let _fake = crate::tests::fake_keyring::install_empty();
    let db = test_db();
    seed_print_store_currency(&db);
    {
        let conn = db.conn.lock().unwrap();
        insert_shift_checkout_fixture(&conn, "golden-driver", "term-1");
        conn.execute_batch(
            "UPDATE staff_shifts SET role_type='driver', staff_name='Maria', currency='EUR',
                opening_cash_amount=20.0, opening_cash_amount_cents=2000,
                expected_cash_amount=30.0, expected_cash_amount_cents=3000,
                closing_cash_amount=29.5, closing_cash_amount_cents=2950,
                cash_variance=-0.5, cash_variance_cents=-50,
                total_orders_count=1, total_sales_amount=10.0, total_sales_amount_cents=1000,
                total_cash_sales=10.0, total_cash_sales_cents=1000,
                total_card_sales=0, total_card_sales_cents=0
             WHERE id='golden-driver';
             INSERT INTO orders (id, order_number, items, status, order_type, payment_status,
                staff_shift_id, total_amount, total_amount_cents, branch_id, terminal_id,
                currency, created_at, updated_at)
             VALUES ('golden-order', '#301', '[]', 'delivered', 'delivery', 'paid',
                'golden-driver', 10.0, 1000, 'branch-1', 'term-1',
                'EUR', '2026-03-15T12:00:00Z', '2026-03-15T12:00:00Z');
             INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status,
                staff_shift_id, currency, created_at, updated_at)
             VALUES ('golden-payment', 'golden-order', 'cash', 10.0, 1000, 'completed',
                'golden-driver', 'EUR', '2026-03-15T12:00:00Z', '2026-03-15T12:00:00Z');
             INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                total_earning, payment_method, cash_collected, cash_collected_cents,
                cash_to_return, cash_to_return_cents, currency, created_at, updated_at)
             VALUES ('golden-earning', 'staff-1', 'golden-driver', 'golden-order', 'branch-1',
                0, 'cash', 10.0, 1000, 10.0, 1000, 'EUR',
                '2026-03-15T12:00:00Z', '2026-03-15T12:00:00Z');",
        )
        .unwrap();
    }

    let summary = crate::shifts::get_shift_summary(&db, "golden-driver").unwrap();
    assert_eq!(summary["amountToReturn"], 30.0);
    assert_eq!(summary["tipsReceived"], 0.0);
    base_golden(
        "driver-checkout-summary.json",
        &serde_json::to_vec_pretty(&summary).unwrap(),
    );
    let doc = build_shift_checkout_doc(&db, "golden-driver", None).unwrap();
    compare_prints("driver-checkout", &ReceiptDocument::ShiftCheckout(doc));
}

#[test]
fn box_tip_base_golden_zero_tip_z_with_driver() {
    let db = test_db();
    let payload = serde_json::json!({
        "date": "2026-03-15", "generatedAt": "2026-03-15T16:30:00Z", "currency": "EUR",
        "presentation": { "deliveryModuleEnabled": true },
        "staffReports": [{
            "staffShiftId": "golden-driver", "staffName": "Maria", "role": "driver",
            "shiftStatus": "closed", "checkIn": "2026-03-15T08:00:00Z",
            "checkOut": "2026-03-15T16:00:00Z",
            "orders": { "count": 1, "cashAmount": 10.0, "totalAmount": 10.0 },
            "driver": { "cashToReturn": 30.0, "tips": 0.0 },
            "drawer": { "opening": 20.0, "expected": 30.0, "closing": 29.5, "variance": -0.5 },
            "returnedToDrawerAmount": 29.5
        }],
        "sales": { "cashSales": 10.0, "grossSales": 10.0, "totalOrders": 1 },
        "cashDrawer": {
            "openingTotal": 200.0, "driverCashGiven": 20.0, "driverCashReturned": 29.5,
            "expected": 209.5, "closing": 209.5, "totalVariance": 0.0
        }
    });
    let doc = build_z_report_doc_from_payload(&db, &payload, "golden-z");
    compare_prints("z-report", &ReceiptDocument::ZReport(doc));
}
