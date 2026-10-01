// Gift-bound drawer close print regressions. Included inside `print::tests`, so
// they run on its real-migration fixtures and managed-dispatch fakes. Items
// only: an included file cannot carry inner attributes.

use crate::gift_financial_closing as closing;
use crate::receipt_renderer::{GiftCloseDrawerLine, ShiftCheckoutDoc};
use serde_json::{json, Value as JsonValue};

// The accepted `zreport` gift-close fixture: float 10000, ordinary cash sales
// 2345, a 14000 count and the hosted proof ordinary 12345 + gift 2000 = 14345.
const GC_ORG: &str = "6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf";
const GC_OTHER_ORG: &str = "8fb3e0d1-9c7b-4d84-8a6b-7c8d9eafb0c2";
const GC_BRANCH: &str = "7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0";
const GC_TERMINAL: &str = "terminal-main-01";
const GC_STAFF: &str = "5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e";
const GC_OWNER_DB: &str = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const GC_SOURCE_DB: &str = "b2c3d4e5-f6a7-4890-9bcd-ef0123456789";
const GC_OPENING_KEY: &str = "1f2e3d4c-5b6a-4789-8abc-0123456789ab";
const GC_OPENING_QUEUE_ID: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const GC_SHIFT: &str = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const GC_DRAWER: &str = "3b4c5d6e-7f8a-4b9c-8d0e-2f3a4b5c6d7e";
const GC_ACK: &str = "4c5d6e7f-8a9b-4c0d-9e1f-3a4b5c6d7e8f";
const GC_CLOSING_KEY: &str = "5d6e7f8a-9b0c-4d1e-8f2a-4b5c6d7e8f9a";
const GC_QUEUE_ID: &str = "6e7f8a9b-0c1d-4e2f-9a3b-5c6d7e8f9a0b";
const GC_OPENED_AT: &str = "2026-09-30T08:00:00.000Z";
const GC_CLOSED_AT: &str = "2026-09-30T18:00:00.000Z";
const GC_CANONICAL_AT: &str = "2026-09-30T18:00:07.250Z";
const GC_ADOPTED_AT: &str = "2026-09-30T18:02:00.000Z";
const GC_PROFILE: &str = "gift-close-profile";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// Persisted opening refused as unusable (zero gift), no closing proof.
    RefusedUnusable,
    /// Usable opening, mirror closed locally, no closing journal.
    JournalMissing,
    /// Closing original captured; the hosted proof is not adopted.
    Pending,
    /// Canonical proof adopted onto both mirrors.
    Adopted,
}

fn gc_instant(value: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(value)
        .expect("fixture instant")
        .with_timezone(&chrono::Utc)
}

fn gc_drawer(usable: bool) -> crate::gift_financial_opening::DrawerState {
    if usable {
        crate::gift_financial_opening::DrawerState {
            version: 3,
            acknowledgement_id: Some(GC_ACK.to_string()),
            gift_cash_cents: 2_000,
            ordinary_expected_cents: 10_000,
            expected_cents: 12_000,
        }
    } else {
        crate::gift_financial_opening::DrawerState {
            version: 0,
            acknowledgement_id: None,
            gift_cash_cents: 0,
            ordinary_expected_cents: 10_000,
            expected_cents: 10_000,
        }
    }
}

fn gc_seed_opening(db: &DbState, usable: bool) {
    let drawer = gc_drawer(usable);
    let state = if usable { "confirmed_usable" } else { "confirmed_unusable" };
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO gift_financial_openings (
            opening_key, organization_id, branch_id, terminal_id, staff_id, staff_name,
            shift_id, drawer_id, opening_cents, currency, checked_in_at, business_date,
            period_start_at, is_day_start, calculation_version, queue_item_id, state,
            owner_terminal_db_id, source_terminal_db_id, server_usable, drawer_version,
            drawer_acknowledgement_id, drawer_gift_cash_cents, drawer_ordinary_expected_cents,
            drawer_expected_cents, confirmation_json, confirmed_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'Maria', ?6, ?7, 10000, 'EUR', ?8, '2026-09-30', ?8, 1, 2,
                  ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?8, ?8, ?8)",
        rusqlite::params![
            GC_OPENING_KEY,
            GC_ORG,
            GC_BRANCH,
            GC_TERMINAL,
            GC_STAFF,
            GC_SHIFT,
            GC_DRAWER,
            GC_OPENED_AT,
            GC_OPENING_QUEUE_ID,
            state,
            GC_OWNER_DB,
            GC_SOURCE_DB,
            i64::from(usable),
            drawer.version,
            drawer.acknowledgement_id,
            drawer.gift_cash_cents,
            drawer.ordinary_expected_cents,
            drawer.expected_cents,
            r#"{"fixture":"stored opening proof"}"#,
        ],
    )
    .expect("seed the persisted financial opening");
}

fn gc_seed_shift_and_drawer(db: &DbState) {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO staff_shifts (
            id, staff_id, staff_name, branch_id, terminal_id, role_type,
            check_in_time, report_date, period_start_at,
            opening_cash_amount, opening_cash_amount_cents,
            status, calculation_version, transferred_to_cashier_shift_id,
            sync_status, created_at, updated_at, is_day_start
        ) VALUES (?1, ?2, 'Maria', ?3, ?4, 'cashier', ?5, '2026-09-30', ?5, 100, 10000,
                  'active', 2, NULL, 'pending', ?5, ?5, 1)",
        rusqlite::params![GC_SHIFT, GC_STAFF, GC_BRANCH, GC_TERMINAL, GC_OPENED_AT],
    )
    .expect("seed the cashier shift");
    conn.execute(
        "INSERT INTO cash_drawer_sessions (
            id, staff_shift_id, cashier_id, branch_id, terminal_id,
            opening_amount, opening_amount_cents, opened_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 100, 10000, ?6, ?6, ?6)",
        rusqlite::params![GC_DRAWER, GC_SHIFT, GC_STAFF, GC_BRANCH, GC_TERMINAL, GC_OPENED_AT],
    )
    .expect("seed the drawer");
}

/// Captures the original, closes the mirror locally and adopts the hosted proof
/// through the accepted journal APIs, up to `stage`.
fn gc_seed_close(db: &DbState, stage: Stage) {
    let usable = stage != Stage::RefusedUnusable;
    let drawer = gc_drawer(usable);
    let conn = db.conn.lock().unwrap();
    if matches!(stage, Stage::Pending | Stage::Adopted) {
        let tx = conn.unchecked_transaction().expect("begin the capture");
        closing::capture_original(
            &tx,
            &closing::ClosingCapture {
                closing_key: GC_CLOSING_KEY.to_string(),
                opening_key: GC_OPENING_KEY.to_string(),
                queue_item_id: GC_QUEUE_ID.to_string(),
                organization_id: GC_ORG.to_string(),
                branch_id: GC_BRANCH.to_string(),
                terminal_id: GC_TERMINAL.to_string(),
                staff_id: GC_STAFF.to_string(),
                shift_id: GC_SHIFT.to_string(),
                drawer_id: GC_DRAWER.to_string(),
                owner_terminal_db_id: GC_OWNER_DB.to_string(),
                source_terminal_db_id: GC_SOURCE_DB.to_string(),
                currency: "EUR".to_string(),
                counted_cents: 14_000,
                closed_at: GC_CLOSED_AT.to_string(),
                confirmed_drawer: drawer.clone(),
                drawer: drawer.clone(),
                request_body: json!({
                    "event": "shift_close",
                    "shift_id": GC_SHIFT,
                    "drawer_id": GC_DRAWER,
                    "closing_key": GC_CLOSING_KEY,
                    "closing_cash_cents": 14_000,
                    "closed_at": GC_CLOSED_AT
                }),
            },
            gc_instant("2026-09-30T18:00:01.000Z"),
        )
        .expect("capture the closing original");
        tx.commit().expect("commit the capture");
    }

    let expected = drawer.expected_cents;
    let variance = 14_000 - expected;
    conn.execute(
        "UPDATE cash_drawer_sessions SET
            closing_amount = 140.0, closing_amount_cents = 14000,
            expected_amount = ?1, expected_amount_cents = ?2,
            variance_amount = ?3, variance_amount_cents = ?4,
            total_cash_sales = 23.45, total_cash_sales_cents = 2345,
            reconciled = 1, closed_at = ?5, reconciled_at = ?5, updated_at = ?5
         WHERE id = ?6",
        rusqlite::params![
            expected as f64 / 100.0,
            expected,
            variance as f64 / 100.0,
            variance,
            GC_CLOSED_AT,
            GC_DRAWER
        ],
    )
    .expect("close the drawer locally");
    conn.execute(
        "UPDATE staff_shifts SET
            closing_cash_amount = 140.0, closing_cash_amount_cents = 14000,
            expected_cash_amount = ?1, expected_cash_amount_cents = ?2,
            cash_variance = ?3, cash_variance_cents = ?4,
            check_out_time = ?5, status = 'closed', sync_status = 'pending', updated_at = ?5
         WHERE id = ?6",
        rusqlite::params![
            expected as f64 / 100.0,
            expected,
            variance as f64 / 100.0,
            variance,
            GC_CLOSED_AT,
            GC_SHIFT
        ],
    )
    .expect("close the shift locally");

    if stage == Stage::Adopted {
        let proof = json!({
            "contract": "gift_closing_v1",
            "state": "closed",
            "organization_id": GC_ORG,
            "branch_id": GC_BRANCH,
            "terminal_id": GC_TERMINAL,
            "source_terminal_id": GC_SOURCE_DB,
            "owner_terminal_id": GC_OWNER_DB,
            "shift_id": GC_SHIFT,
            "drawer_id": GC_DRAWER,
            "staff_id": GC_STAFF,
            "currency": "EUR",
            "counted_cents": 14_000,
            "variance_cents": -345,
            "closed_at": GC_CANONICAL_AT,
            "drawer": {
                "contract": "gift_funding_v1",
                "drawer_id": GC_DRAWER,
                "shift_id": GC_SHIFT,
                "owner_terminal_id": GC_OWNER_DB,
                "currency": "EUR",
                "gift_cash_cents": 2_000,
                "ordinary_expected_cents": 12_345,
                "expected_cents": 14_345,
                "version": 3,
                "acknowledgement_id": GC_ACK
            }
        });
        let reply = json!({
            "success": true,
            "results": [{ "shift_id": GC_SHIFT, "status": "ok", "financial_closing": proof }]
        });
        let tx = conn.unchecked_transaction().expect("begin the adoption");
        match closing::adopt_closing_response(
            &tx,
            GC_CLOSING_KEY,
            Some(&reply),
            None,
            gc_instant(GC_ADOPTED_AT),
        )
        .expect("adopt the canonical close")
        {
            closing::ClosingAdoption::Adopted {
                replayed: false, ..
            } => {}
            _ => panic!("expected the first adoption of the canonical close"),
        }
        tx.commit().expect("commit the adoption");
    }
}

fn gc_seed(db: &DbState, stage: Stage) {
    gc_seed_opening(db, stage != Stage::RefusedUnusable);
    gc_seed_shift_and_drawer(db);
    gc_seed_close(db, stage);
}

/// A stored Z generated through the real date report builder.
fn gc_generate_date_z(db: &DbState) -> String {
    let generated = crate::zreport::generate_z_report_for_date(
        db,
        &json!({ "branchId": GC_BRANCH, "date": "2026-09-30" }),
    )
    .expect("generate the stored gift Z");
    generated["zReportId"]
        .as_str()
        .expect("stored zReportId")
        .to_owned()
}

/// The managed-reprint fixture's stored Z shape: no drawer or shift ID and no
/// gift projection anywhere in its JSON.
fn gc_legacy_z_json(expected: f64) -> String {
    json!({
        "terminalName": "Legacy Z Terminal",
        "shifts": { "total": 1 },
        "cashDrawer": {
            "openingTotal": 100.0,
            "cashSales": 25.0,
            "expected": expected,
            "moneyInDrawer": expected,
            "totalVariance": 0.0
        }
    })
    .to_string()
}

fn gc_insert_legacy_z(db: &DbState, z_report_id: &str, shift_id: &str) {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO z_reports (
             id, shift_id, branch_id, terminal_id, report_date, generated_at,
             gross_sales, net_sales, total_orders, cash_sales, card_sales,
             tips_total, cash_variance, opening_cash, closing_cash, expected_cash,
             report_json, created_at, updated_at
         ) VALUES (
             ?1, ?2, 'branch-1', 'terminal-1', '2026-03-15',
             '2026-03-15T23:59:00Z', 25.0, 25.0, 3, 15.0, 10.0,
             0.0, 0.0, 100.0, 125.0, 125.0, ?3,
             '2026-03-15T23:59:00Z', '2026-03-15T23:59:00Z'
         )",
        rusqlite::params![z_report_id, shift_id, gc_legacy_z_json(125.0)],
    )
    .expect("insert the stored Z row");
}

fn gc_text_profile(db: &DbState, host: &str) {
    let conn = db.conn.lock().unwrap();
    insert_managed_network_profile(&conn, GC_PROFILE, host, 9100, true);
    gc_retarget_profile(&conn, host, 9100);
}

fn gc_retarget_profile(conn: &rusqlite::Connection, host: &str, port: u16) {
    let connection = json!({
        "type": "network",
        "ip": host,
        "port": port,
        "render_mode": "text"
    })
    .to_string();
    conn.execute(
        "UPDATE printer_profiles SET printer_name = ?1, connection_json = ?2 WHERE id = ?3",
        rusqlite::params![host, connection, GC_PROFILE],
    )
    .expect("deterministic text rendering on the gift-close profile");
}

fn gc_enqueue(
    db: &DbState,
    entity_type: &str,
    entity_id: &str,
    payload: Option<&JsonValue>,
) -> Result<JsonValue, String> {
    enqueue_print_job_with_payload(
        db,
        entity_type,
        entity_id,
        None,
        payload,
        &NoopPrintQueueInvalidator,
    )
}

fn gc_latest_job(db: &DbState, entity_id: &str) -> Option<String> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id FROM print_jobs WHERE entity_id = ?1 ORDER BY rowid DESC LIMIT 1",
        [entity_id],
        |row| row.get(0),
    )
    .optional()
    .expect("read the latest print job")
}

fn gc_insert_pending_job(db: &DbState, entity_type: &str, entity_id: &str) -> String {
    let job_id = uuid::Uuid::new_v4().to_string();
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', datetime('now'), datetime('now'))",
        rusqlite::params![job_id, entity_type, entity_id],
    )
    .expect("insert a pending print job");
    job_id
}

/// A Reprint child of a dispatched job: it replays that job's frozen snapshot.
fn gc_reprint(db: &DbState, job_id: &str) -> String {
    let cloned = crate::print_history::clone_reprint_job(db, job_id, chrono::Utc::now())
        .expect("clone the frozen document");
    assert_eq!(cloned.affected, 1);
    cloned.new_job_id.expect("Reprint child ID")
}

/// (status, last_error, frozen envelope stored)
fn gc_job_state(db: &DbState, job_id: &str) -> (String, Option<String>, bool) {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT status, last_error, render_profile_snapshot_json IS NOT NULL
           FROM print_jobs WHERE id = ?1",
        [job_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .expect("read the print job")
}

fn gc_assert_refused(db: &DbState, job_id: &str, reason: &str, case: &str) {
    let (status, error, _) = gc_job_state(db, job_id);
    let error = error.unwrap_or_default();
    assert_eq!(status, "failed", "{case}: {error}");
    assert!(
        error.contains(GIFT_CLOSE_PRINT_NOT_FINAL) && error.contains(reason),
        "{case}: expected {reason}, got {error}"
    );
}

fn gc_assert_dispatched(db: &DbState, job_id: &str, case: &str) {
    let (status, error, _) = gc_job_state(db, job_id);
    assert_eq!(status, "dispatched", "{case}: {}", error.unwrap_or_default());
}

fn gc_cents(amount: f64) -> i64 {
    (amount * 100.0).round() as i64
}

fn gc_binding_value(db: &DbState, job_id: &str) -> JsonValue {
    frozen_envelope_value(db, job_id)
        .get("gift_close_binding")
        .cloned()
        .unwrap_or(JsonValue::Null)
}

struct GiftPrinter {
    data_dir: std::path::PathBuf,
    raw: CapturingManagedRaw,
    spooler: std::sync::Arc<dyn WindowsSpooler>,
    manager: DispatchManager,
}

impl GiftPrinter {
    fn new(case: &str) -> Self {
        Self {
            data_dir: std::env::temp_dir()
                .join(format!("gift-close-print-{case}-{}", uuid::Uuid::new_v4())),
            raw: CapturingManagedRaw::default(),
            spooler: std::sync::Arc::new(FakeWindowsSpooler::new(73)),
            manager: DispatchManager::isolated_for_test(),
        }
    }

    /// Several worker passes, so every eligible job on the shared target drains.
    fn run(&self, db: &DbState) {
        for _ in 0..3 {
            process_pending_jobs_with_adapters(
                db,
                &self.data_dir,
                &self.manager,
                &self.raw,
                std::sync::Arc::clone(&self.spooler),
                std::time::Duration::from_secs(10),
            )
            .expect("process the print queue");
        }
    }

    fn calls(&self) -> Vec<CapturedRawCall> {
        self.raw.calls.lock().unwrap().clone()
    }
}

impl Drop for GiftPrinter {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

fn gc_prepare_refusal(db: &DbState, job_id: &str, entity_type: &str, entity_id: &str) -> String {
    let data_dir =
        std::env::temp_dir().join(format!("gift-close-capture-{}", uuid::Uuid::new_v4()));
    let manager = DispatchManager::isolated_for_test();
    let outcome = prepare_frozen_attempt(
        db,
        &data_dir,
        &manager,
        job_id,
        entity_type,
        entity_id,
        None,
        None,
    );
    crate::print::gift_close_capture_hook::set(None);
    let _ = std::fs::remove_dir_all(&data_dir);
    match outcome {
        Ok(_) => panic!("{entity_type} changed after capture must be refused before transport"),
        Err(failure) => String::from(failure),
    }
}

fn gc_checkout_without_gift_fields(doc: &ShiftCheckoutDoc) -> JsonValue {
    let mut value = serde_json::to_value(doc).expect("serialize the checkout document");
    let object = value.as_object_mut().expect("checkout document object");
    for key in [
        "expected_amount",
        "closing_amount",
        "variance_amount",
        "check_out",
        "gift_close",
    ] {
        object.remove(key);
    }
    value
}

#[test]
fn gift_checkout_prints_the_canonical_close_and_ignores_the_caller_snapshot() {
    let db = test_db();
    gc_seed(&db, Stage::Adopted);
    {
        // A wrong current currency cannot relabel the proven original.
        let conn = db.conn.lock().unwrap();
        crate::db::set_setting(&conn, "receipt", "currency_symbol", "USD")
            .expect("wrong current currency");
    }
    let malicious = json!({
        "terminalName": "Till 7",
        "currency": "USD",
        "expectedAmount": 999.99,
        "expected_amount": 999.99,
        "closingAmount": 1.0,
        "closing_amount": 1.0,
        "closingCashAmount": 1.0,
        "varianceAmount": 500.0,
        "variance_amount": 500.0,
        "cashVariance": 500.0,
        "checkOut": "2099-01-01T00:00:00Z",
        "check_out": "2099-01-01T00:00:00Z",
        "checkOutTime": "2099-01-01T00:00:00Z"
    });

    let (document, binding) = build_document_and_gift_binding_for_job(
        &db,
        "shift_checkout",
        GC_SHIFT,
        Some(&malicious.to_string()),
    )
    .expect("a proven gift checkout builds");
    let ReceiptDocument::ShiftCheckout(doc) = document else {
        panic!("shift checkout document");
    };
    assert_eq!(doc.expected_amount, Some(143.45));
    assert_eq!(doc.closing_amount, Some(140.0));
    assert_eq!(doc.variance_amount, Some(-3.45));
    assert_eq!(doc.check_out, GC_CANONICAL_AT);
    let expected_line = GiftCloseDrawerLine {
        staff_name: None,
        currency: "EUR".into(),
        ordinary_expected_cents: 12_345,
        gift_liability_cash_cents: 2_000,
        expected_cents: 14_345,
        counted_cents: 14_000,
        variance_cents: -345,
        canonical_closed_at: GC_CANONICAL_AT.into(),
    };
    assert_eq!(doc.gift_close.as_ref(), Some(&expected_line));
    let binding = binding.expect("the binding is captured with its document");
    assert_eq!(binding.contract, "gift_close_print_v1");
    assert_eq!(binding.originals.len(), 1);
    let original = &binding.originals[0];
    assert_eq!(
        (
            original.shift_id.as_str(),
            original.drawer_id.as_str(),
            original.currency.as_str(),
            original.ordinary_expected_cents,
            original.gift_liability_cash_cents,
            original.expected_cents,
            original.counted_cents,
            original.variance_cents,
            original.canonical_closed_at.as_str(),
        ),
        (GC_SHIFT, GC_DRAWER, "EUR", 12_345, 2_000, 14_345, 14_000, -345, GC_CANONICAL_AT)
    );
    // Only the drawer equation changes: no gift reaches sales, tender or tax.
    let ordinary = build_shift_checkout_doc(&db, GC_SHIFT, Some(&json!({ "terminalName": "Till 7" })))
        .expect("ordinary view of the same shift");
    assert_eq!(
        gc_checkout_without_gift_fields(&doc),
        gc_checkout_without_gift_fields(&ordinary)
    );

    // End to end through the queue gate, managed preparation and transport.
    gc_text_profile(&db, "gift-checkout.local");
    gc_enqueue(&db, "shift_checkout", GC_SHIFT, Some(&malicious))
        .expect("a proven gift checkout is admitted");
    let job_id = gc_latest_job(&db, GC_SHIFT).expect("queued gift checkout");
    let printer = GiftPrinter::new("checkout");
    printer.run(&db);
    let calls = printer.calls();
    assert_eq!(calls.len(), 1);
    let text = String::from_utf8_lossy(&calls[0].bytes).to_string();
    for forbidden in ["999.99", "999,99", "500.00", "500,00", "2099"] {
        assert!(!text.contains(forbidden), "caller value {forbidden} printed");
    }
    assert!(text.contains("EUR"), "the gift close prints its own currency");
    assert_eq!(gc_job_state(&db, &job_id).0, "dispatched");
    let frozen = gc_binding_value(&db, &job_id);
    assert_eq!(frozen["originals"][0]["expectedCents"], 14_345);
    assert_eq!(frozen["originals"][0]["varianceCents"], -345);
    assert_eq!(frozen["originals"][0]["currency"], "EUR");
    assert_eq!(frozen["originals"][0]["canonicalClosedAt"], GC_CANONICAL_AT);
}

#[test]
fn gift_checkout_without_adopted_proof_is_refused_while_ordinary_checkout_prints() {
    for (stage, reason) in [
        (Stage::Pending, "GIFT_CLOSE_PROOF_PENDING"),
        (Stage::JournalMissing, "GIFT_CLOSE_JOURNAL_MISSING"),
        // An unusable, zero-gift persisted opening is not an ordinary exemption.
        (Stage::RefusedUnusable, "GIFT_CLOSE_JOURNAL_MISSING"),
    ] {
        let case = format!("{stage:?}");
        let db = test_db();
        gc_seed(&db, stage);
        gc_text_profile(&db, "gift-refusal.local");

        let refused = gc_enqueue(
            &db,
            "shift_checkout",
            GC_SHIFT,
            Some(&json!({ "terminalName": "Till 7", "expectedAmount": 143.45 })),
        )
        .expect_err("an unproven gift close must not queue");
        assert!(
            refused.starts_with(GIFT_CLOSE_PRINT_NOT_FINAL) && refused.contains(reason),
            "{case}: {refused}"
        );
        assert_eq!(gc_latest_job(&db, GC_SHIFT), None, "{case}: nothing queued");
        let built = build_document_and_gift_binding_for_job(&db, "shift_checkout", GC_SHIFT, None)
            .err()
            .expect("an unproven gift checkout never builds");
        assert!(built.contains(reason), "{case}: {built}");

        // A row that reached the queue another way never reaches transport.
        let job_id = gc_insert_pending_job(&db, "shift_checkout", GC_SHIFT);
        let printer = GiftPrinter::new("checkout-refusal");
        printer.run(&db);
        assert!(printer.calls().is_empty(), "{case}: no transport");
        gc_assert_refused(&db, &job_id, reason, &case);
        assert!(!gc_job_state(&db, &job_id).2, "{case}: nothing frozen");

        // Ordinary checkout on the same database still prints.
        {
            let conn = db.conn.lock().unwrap();
            insert_shift_checkout_fixture(&conn, "ordinary-shift", "terminal-1");
        }
        gc_enqueue(&db, "shift_checkout", "ordinary-shift", None)
            .expect("an ordinary checkout queues");
        let ordinary_job = gc_latest_job(&db, "ordinary-shift").expect("ordinary job");
        printer.run(&db);
        assert_eq!(printer.calls().len(), 1, "{case}: the ordinary checkout prints");
        assert_eq!(gc_job_state(&db, &ordinary_job).0, "dispatched");
        assert!(gc_binding_value(&db, &ordinary_job).is_null());
    }
}

#[test]
fn stored_gift_z_from_the_report_builder_prints_the_gift_once_and_ordinary_z_still_prints() {
    let db = test_db();
    gc_seed(&db, Stage::Adopted);
    let z_report_id = gc_generate_date_z(&db);
    let stored: JsonValue = {
        let conn = db.conn.lock().unwrap();
        let text: String = conn
            .query_row(
                "SELECT report_json FROM z_reports WHERE id = ?1",
                [&z_report_id],
                |row| row.get(0),
            )
            .expect("stored report_json");
        serde_json::from_str(&text).expect("stored report JSON")
    };
    // A stale caller payload cannot change a proven stored Z.
    let caller = json!({
        "cashDrawer": { "expected": 999.0, "giftLiabilityCash_cents": 9_999 },
        "giftFinancialClose": { "ready": true, "giftLiabilityCash_cents": 9_999 }
    });

    let (document, binding) = build_document_and_gift_binding_for_job(
        &db,
        "z_report",
        &z_report_id,
        Some(&caller.to_string()),
    )
    .expect("a proven stored Z builds");
    let ReceiptDocument::ZReport(doc) = document else {
        panic!("Z report document");
    };
    assert_eq!(gc_cents(doc.expected_cash), 14_345, "gift cash counted once");
    assert_eq!(gc_cents(doc.cash_variance), -345);
    assert_eq!(doc.gift_liability_cash_cents, 2_000);
    assert_eq!(doc.gift_close_lines.len(), 1);
    let line = &doc.gift_close_lines[0];
    assert_eq!(
        (
            line.currency.as_str(),
            line.ordinary_expected_cents,
            line.gift_liability_cash_cents,
            line.expected_cents,
            line.counted_cents,
            line.variance_cents,
            line.canonical_closed_at.as_str(),
        ),
        ("EUR", 12_345, 2_000, 14_345, 14_000, -345, GC_CANONICAL_AT)
    );
    // The independent ordinary adjustment is carried as stored, never merged.
    let stored_adjustment = stored["giftFinancialClose"]["ordinaryAdjustment_cents"]
        .as_i64()
        .unwrap_or(0);
    assert_eq!(doc.gift_ordinary_adjustment_cents, stored_adjustment);
    assert_eq!(
        stored["cashDrawer"]["ordinaryAdjustment_cents"].as_i64().unwrap_or(0),
        stored_adjustment
    );
    // Gift liability cash is a drawer movement, never a sale.
    assert_eq!((doc.cash_sales, doc.gross_sales, doc.net_sales), (0.0, 0.0, 0.0));
    assert_eq!(binding.expect("Z binding").originals.len(), 1);

    gc_text_profile(&db, "gift-z.local");
    gc_enqueue(&db, "z_report", &z_report_id, Some(&caller))
        .expect("a proven stored Z is admitted");
    let z_job = gc_latest_job(&db, &z_report_id).expect("queued stored Z");
    let printer = GiftPrinter::new("z");
    printer.run(&db);
    let calls = printer.calls();
    assert_eq!(calls.len(), 1);
    let text = String::from_utf8_lossy(&calls[0].bytes).to_string();
    for doubled in ["163.45", "163,45", "99.99", "99,99", "999.00", "999,00"] {
        assert!(!text.contains(doubled), "{doubled} printed on the gift Z");
    }
    assert_eq!(gc_job_state(&db, &z_job).0, "dispatched");
    assert_eq!(gc_binding_value(&db, &z_job)["originals"][0]["expectedCents"], 14_345);

    // An ordinary stored Z (no gift opening on its shift) still prints.
    {
        let conn = db.conn.lock().unwrap();
        insert_shift_checkout_fixture(&conn, "ordinary-z-shift", "terminal-1");
    }
    gc_insert_legacy_z(&db, "ordinary-z", "ordinary-z-shift");
    gc_enqueue(&db, "z_report", "ordinary-z", None).expect("an ordinary stored Z queues");
    let ordinary_job = gc_latest_job(&db, "ordinary-z").expect("ordinary Z job");
    printer.run(&db);
    assert_eq!(printer.calls().len(), 2);
    assert_eq!(gc_job_state(&db, &ordinary_job).0, "dispatched");
    assert!(gc_binding_value(&db, &ordinary_job).is_null());
}

#[test]
fn stored_z_bound_to_a_gift_shift_is_stale_even_when_its_json_omits_every_id() {
    // Pending proof: a pre-proof stored Z shaped like the managed-reprint
    // fixture (row shift_id only, no ID or projection in its JSON).
    let db = test_db();
    gc_seed(&db, Stage::Pending);
    gc_insert_legacy_z(&db, "pre-proof-z", GC_SHIFT);
    gc_text_profile(&db, "stale-z.local");
    let refused = gc_enqueue(&db, "z_report", "pre-proof-z", None)
        .expect_err("a pending gift Z never queues as ordinary");
    assert!(refused.contains("GIFT_CLOSE_SNAPSHOT_STALE"), "{refused}");
    assert_eq!(gc_latest_job(&db, "pre-proof-z"), None);
    let job_id = gc_insert_pending_job(&db, "z_report", "pre-proof-z");
    let printer = GiftPrinter::new("stale-z");
    printer.run(&db);
    assert!(printer.calls().is_empty(), "no transport for a pending gift Z");
    gc_assert_refused(&db, &job_id, "GIFT_CLOSE_SNAPSHOT_STALE", "pending");

    // Adopted proof: a real stored shift Z stripped of its projection and IDs.
    let db = test_db();
    gc_seed(&db, Stage::Adopted);
    crate::zreport::generate_z_report(&db, &json!({ "shiftId": GC_SHIFT }))
        .expect("generate the stored shift Z");
    let z_report_id: String = {
        let conn = db.conn.lock().unwrap();
        let (id, shift_id): (String, Option<String>) = conn
            .query_row("SELECT id, shift_id FROM z_reports", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("one stored shift Z");
        assert_eq!(shift_id.as_deref(), Some(GC_SHIFT));
        conn.execute(
            "UPDATE z_reports SET report_json = ?2 WHERE id = ?1",
            rusqlite::params![id, gc_legacy_z_json(143.45)],
        )
        .expect("strip the projection and IDs");
        id
    };
    let refused = gc_enqueue(&db, "z_report", &z_report_id, None)
        .expect_err("a stripped gift Z never queues as ordinary");
    assert!(refused.contains("GIFT_CLOSE_SNAPSHOT_STALE"), "{refused}");
    let built = build_document_and_gift_binding_for_job(&db, "z_report", &z_report_id, None)
        .err()
        .expect("a stripped gift Z never builds");
    assert!(built.contains("GIFT_CLOSE_SNAPSHOT_STALE"), "{built}");

    // A renderer-only gift snapshot without an authoritative stored report.
    let renderer_only = json!({
        "cashDrawer": { "expected": 143.45, "giftLiabilityCash_cents": 2_000 },
        "giftFinancialClose": {
            "contract": "gift_close_report_v1",
            "ready": true,
            "blockers": [],
            "giftLiabilityCash_cents": 2_000,
            "originals": [{ "drawerId": GC_DRAWER, "expected_cents": 14_345 }]
        }
    });
    let refused = gc_enqueue(&db, "z_report", "renderer-only-z", Some(&renderer_only))
        .expect_err("a renderer-only gift snapshot never queues");
    assert!(
        refused.contains("GIFT_CLOSE_PRINT_REQUIRES_STORED_REPORT"),
        "{refused}"
    );
    let built = build_document_and_gift_binding_for_job(
        &db,
        "z_report",
        "renderer-only-z",
        Some(&renderer_only.to_string()),
    )
    .err()
    .expect("a renderer-only gift snapshot never builds");
    assert!(built.contains("GIFT_CLOSE_PRINT_REQUIRES_STORED_REPORT"), "{built}");
}

#[test]
fn frozen_pre_proof_checkout_and_z_stay_refused_after_proof_arrives() {
    let db = test_db();
    // Printed while the shift has no persisted opening or closing proof.
    gc_seed_shift_and_drawer(&db);
    gc_insert_legacy_z(&db, "pre-proof-frozen-z", GC_SHIFT);
    gc_text_profile(&db, "pre-proof.local");
    gc_enqueue(&db, "shift_checkout", GC_SHIFT, None).expect("ordinary before any opening");
    let checkout_job = gc_latest_job(&db, GC_SHIFT).expect("checkout job");
    let printer = GiftPrinter::new("pre-proof");
    printer.run(&db);
    gc_assert_dispatched(&db, &checkout_job, "pre-proof checkout");
    assert_eq!(printer.calls().len(), 1);
    // Drain each control separately: one target admits one prepared job per batch.
    gc_enqueue(&db, "z_report", "pre-proof-frozen-z", None).expect("ordinary Z before any opening");
    let z_job = gc_latest_job(&db, "pre-proof-frozen-z").expect("Z job");
    printer.run(&db);
    for job_id in [&checkout_job, &z_job] {
        gc_assert_dispatched(&db, job_id, "pre-proof print");
        assert!(gc_binding_value(&db, job_id).is_null(), "frozen without a binding");
    }
    assert_eq!(printer.calls().len(), 2);

    // The persisted opening and its adopted proof arrive afterwards.
    gc_seed_opening(&db, true);
    gc_seed_close(&db, Stage::Adopted);

    // A Reprint never relabels the pre-proof bytes as the proven close.
    let checkout_child = gc_reprint(&db, &checkout_job);
    let z_child = gc_reprint(&db, &z_job);
    printer.run(&db);
    assert_eq!(printer.calls().len(), 2, "no transport for either pre-proof job");
    gc_assert_refused(&db, &checkout_child, "GIFT_CLOSE_PRINT_BINDING_MISSING", "checkout");
    gc_assert_refused(&db, &z_child, "GIFT_CLOSE_SNAPSHOT_STALE", "Z");
}

#[test]
fn proven_frozen_gift_checkout_and_z_replay_original_bytes_after_live_changes() {
    for entity_type in ["shift_checkout", "z_report"] {
        let db = test_db();
        gc_seed(&db, Stage::Adopted);
        let entity_id = if entity_type == "z_report" {
            gc_generate_date_z(&db)
        } else {
            GC_SHIFT.to_owned()
        };
        gc_text_profile(&db, "proven-original.local");
        gc_enqueue(&db, entity_type, &entity_id, None).expect("a proven gift close queues");
        let source_job = gc_latest_job(&db, &entity_id).expect("source job");
        let printer = GiftPrinter::new("proven");
        printer.run(&db);
        let original = printer.calls()[0].clone();
        let source_binding = gc_binding_value(&db, &source_job);
        assert_eq!(source_binding["originals"][0]["expectedCents"], 14_345);

        // Live mirror amounts, staff names, settings and the target change.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                    closing_amount = 1.0, closing_amount_cents = 100,
                    expected_amount = 2.0, expected_amount_cents = 200,
                    variance_amount = -1.0, variance_amount_cents = -100,
                    total_cash_sales = 99.99, total_cash_sales_cents = 9999
                 WHERE id = ?1",
                [GC_DRAWER],
            )
            .expect("mutate the live drawer mirror");
            conn.execute(
                "UPDATE staff_shifts SET staff_name = 'Mutated Cashier',
                    closing_cash_amount = 1.0, closing_cash_amount_cents = 100,
                    expected_cash_amount = 2.0, expected_cash_amount_cents = 200,
                    cash_variance = -1.0, cash_variance_cents = -100
                 WHERE id = ?1",
                [GC_SHIFT],
            )
            .expect("mutate the live shift mirror");
            crate::db::set_setting(&conn, "receipt", "currency_symbol", "USD")
                .expect("mutate the receipt currency");
            gc_retarget_profile(&conn, "proven-mutated.local", 9200);
        }
        let control_job = gc_insert_pending_job(&db, entity_type, &entity_id);
        printer.run(&db);
        let control = printer.calls()[1].clone();
        assert_eq!(gc_job_state(&db, &control_job).0, "dispatched");
        assert_ne!(control.target, original.target, "{entity_type}: fresh control");
        if entity_type == "shift_checkout" {
            assert_ne!(control.bytes, original.bytes, "live staff name reaches a fresh print");
        }

        let cloned = crate::print_history::clone_reprint_job(&db, &source_job, chrono::Utc::now())
            .expect("clone the frozen gift document");
        assert_eq!(cloned.affected, 1);
        let child_job = cloned.new_job_id.expect("Reprint child ID");
        printer.run(&db);
        let calls = printer.calls();
        assert_eq!(calls.len(), 3, "{entity_type}: the Reprint is dispatched");
        assert_eq!(calls[2].bytes, original.bytes, "{entity_type}: original bytes");
        assert_eq!(calls[2].target, original.target, "{entity_type}: original target");
        assert_eq!(gc_job_state(&db, &child_job).0, "dispatched");
        assert_eq!(gc_binding_value(&db, &child_job), source_binding);
    }
}

#[test]
fn frozen_gift_replay_with_a_wrong_bound_original_or_proof_mismatch_never_reaches_transport() {
    for entity_type in ["shift_checkout", "z_report"] {
        for tamper in ["wrong-bound-original", "proof-mismatch"] {
            let case = format!("{entity_type}/{tamper}");
            let db = test_db();
            gc_seed(&db, Stage::Adopted);
            let entity_id = if entity_type == "z_report" {
                gc_generate_date_z(&db)
            } else {
                GC_SHIFT.to_owned()
            };
            gc_text_profile(&db, "tamper.local");
            gc_enqueue(&db, entity_type, &entity_id, None).expect("a proven gift close queues");
            let job_id = gc_latest_job(&db, &entity_id).expect("gift job");
            let printer = GiftPrinter::new("tamper");
            printer.run(&db);
            assert_eq!(printer.calls().len(), 1, "{case}: first print");

            let (replay_job, reason) = if tamper == "wrong-bound-original" {
                // Stored snapshots are immutable, so the original bytes bound to
                // another original can only arrive as a complete copy of a
                // frozen Reprint row; the untouched child is taken off the queue.
                let child = gc_reprint(&db, &job_id);
                let replay_job = uuid::Uuid::new_v4().to_string();
                let conn = db.conn.lock().unwrap();
                let raw: String = conn
                    .query_row(
                        "SELECT render_profile_snapshot_json FROM print_jobs WHERE id = ?1",
                        [&child],
                        |row| row.get(0),
                    )
                    .expect("frozen envelope");
                let mut envelope: JsonValue =
                    serde_json::from_str(&raw).expect("frozen envelope JSON");
                envelope["gift_close_binding"]["originals"][0]["varianceCents"] = json!(0);
                conn.execute_batch(&format!(
                    "CREATE TEMP TABLE gc_job_copy AS SELECT * FROM print_jobs WHERE id = '{child}';
                     UPDATE print_jobs SET status = 'failed' WHERE id = '{child}';"
                ))
                .expect("copy the frozen Reprint row");
                conn.execute(
                    "UPDATE temp.gc_job_copy SET id = ?1, reprint_of_job_id = NULL,
                         render_profile_snapshot_json = ?2",
                    rusqlite::params![replay_job, envelope.to_string()],
                )
                .expect("bind the copied bytes to a wrong original");
                conn.execute_batch(
                    "INSERT INTO print_jobs SELECT * FROM temp.gc_job_copy;
                     DROP TABLE temp.gc_job_copy;",
                )
                .expect("freeze the copy");
                (replay_job, "GIFT_CLOSE_PRINT_BINDING_MISMATCH")
            } else {
                {
                    let conn = db.conn.lock().unwrap();
                    conn.execute(
                        "UPDATE gift_financial_openings SET organization_id = ?1
                          WHERE opening_key = ?2",
                        rusqlite::params![GC_OTHER_ORG, GC_OPENING_KEY],
                    )
                    .expect("move the opening out of its proof's scope");
                }
                (gc_reprint(&db, &job_id), "GIFT_CLOSE_PROOF_MISMATCH")
            };
            printer.run(&db);
            assert_eq!(printer.calls().len(), 1, "{case}: no transport");
            gc_assert_refused(&db, &replay_job, reason, &case);
        }
    }
}

#[test]
fn first_print_refuses_a_gift_source_changed_after_capture_before_transport() {
    // Z: after capture the stored report loses its projection and IDs and gets
    // new cash totals. The bytes hold the old gift rows, so they never freeze
    // an ordinary binding or print.
    let db = test_db();
    gc_seed(&db, Stage::Adopted);
    let z_report_id = gc_generate_date_z(&db);
    gc_text_profile(&db, "capture-z.local");
    let job_id = gc_insert_pending_job(&db, "z_report", &z_report_id);
    let rewritten = z_report_id.clone();
    crate::print::gift_close_capture_hook::set(Some(Box::new(move |db: &DbState| {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE z_reports SET expected_cash = 999.0, report_json = ?2 WHERE id = ?1",
            rusqlite::params![rewritten, gc_legacy_z_json(999.0)],
        )
        .expect("rewrite the stored Z after capture");
    })));
    let message = gc_prepare_refusal(&db, &job_id, "z_report", &z_report_id);
    assert!(
        message.contains(GIFT_CLOSE_PRINT_NOT_FINAL)
            && (message.contains("GIFT_CLOSE_PRINT_BINDING_MISMATCH")
                || message.contains("GIFT_CLOSE_SNAPSHOT_STALE")),
        "{message}"
    );
    assert_eq!(gc_job_state(&db, &job_id), ("pending".to_owned(), None, false));

    // Checkout: the opening leaves its proof's scope after capture.
    let db = test_db();
    gc_seed(&db, Stage::Adopted);
    gc_text_profile(&db, "capture-checkout.local");
    let job_id = gc_insert_pending_job(&db, "shift_checkout", GC_SHIFT);
    crate::print::gift_close_capture_hook::set(Some(Box::new(|db: &DbState| {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE gift_financial_openings SET organization_id = ?1 WHERE opening_key = ?2",
            rusqlite::params![GC_OTHER_ORG, GC_OPENING_KEY],
        )
        .expect("move the opening after capture");
    })));
    let message = gc_prepare_refusal(&db, &job_id, "shift_checkout", GC_SHIFT);
    assert!(message.contains("GIFT_CLOSE_PROOF_MISMATCH"), "{message}");
    assert_eq!(gc_job_state(&db, &job_id), ("pending".to_owned(), None, false));

    // Controls: live edits that leave the proof and stored report intact keep
    // a proven first print, and an ordinary Z rewritten at the same boundary
    // still prints (ordinary jobs carry no binding to compare).
    let db = test_db();
    gc_seed(&db, Stage::Adopted);
    let z_report_id = gc_generate_date_z(&db);
    {
        let conn = db.conn.lock().unwrap();
        insert_shift_checkout_fixture(&conn, "ordinary-capture-shift", "terminal-1");
    }
    gc_insert_legacy_z(&db, "ordinary-capture-z", "ordinary-capture-shift");
    gc_text_profile(&db, "capture-benign.local");
    let gift_job = gc_insert_pending_job(&db, "z_report", &z_report_id);
    let ran = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = std::sync::Arc::clone(&ran);
    crate::print::gift_close_capture_hook::set(Some(Box::new(move |db: &DbState| {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE cash_drawer_sessions SET total_cash_sales = 99.99, total_cash_sales_cents = 9999
              WHERE id = ?1",
            [GC_DRAWER],
        )
        .expect("mutate the live drawer mirror");
        conn.execute(
            "UPDATE staff_shifts SET staff_name = 'Mutated Cashier' WHERE id = ?1",
            [GC_SHIFT],
        )
        .expect("mutate the live staff name");
        conn.execute(
            "UPDATE z_reports SET expected_cash = 777.0, report_json = ?1
              WHERE id = 'ordinary-capture-z'",
            [gc_legacy_z_json(777.0)],
        )
        .expect("rewrite the ordinary stored Z");
    })));
    let printer = GiftPrinter::new("capture-benign");
    printer.run(&db);
    gc_assert_dispatched(&db, &gift_job, "unchanged gift proof");
    assert_eq!(printer.calls().len(), 1);
    let ordinary_job = gc_insert_pending_job(&db, "z_report", "ordinary-capture-z");
    printer.run(&db);
    crate::print::gift_close_capture_hook::set(None);
    gc_assert_dispatched(&db, &ordinary_job, "ordinary Z");
    assert!(
        ran.load(std::sync::atomic::Ordering::SeqCst) >= 2,
        "the capture boundary ran for both fresh preparations"
    );
    assert_eq!(printer.calls().len(), 2);
    assert_eq!(gc_binding_value(&db, &gift_job)["originals"][0]["varianceCents"], -345);
    assert!(gc_binding_value(&db, &ordinary_job).is_null());
}
