//! Focused native tests of the funded gift card core (schema v86): real
//! rusqlite handles, simulated held/lost/late replies, no network.

use std::path::PathBuf;

use super::*;
use crate::gift_financial_opening::{OpeningIntent, PrepareRequest};

const ORG: &str = "6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf";
const BRANCH: &str = "7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0";
const TERMINAL: &str = "terminal-main-01";
const OTHER_TERMINAL: &str = "terminal-other-02";
const STAFF: &str = "5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e";
const MANAGER: &str = "8e0c1d2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f";
const OWNER_DB: &str = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const SOURCE_DB: &str = "b2c3d4e5-f6a7-4890-9bcd-ef0123456789";
const RELOAD_CARD: &str = "c3d4e5f6-a7b8-4901-8cde-f01234567890";
const FOREIGN_ID: &str = "d4e5f6a7-b8c9-4012-9def-012345678901";
const DRAWER_ACK: &str = "1b8c9d0e-f2a3-4456-9123-456789012345";
const MANAGER_SESSION: &str = "2c9d0e1f-a3b4-4567-8234-567890123456";
const CARD_NUMBER: &str = "GC7K2M9Q4XRT";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn configure(conn: &Connection) {
    crate::db::run_migrations_for_test(conn);
    for (key, value) in [("organization_id", ORG), ("branch_id", BRANCH)] {
        crate::db::set_setting(conn, "terminal", key, value).expect("seed terminal scope");
    }
    set_terminal(conn, TERMINAL);
}

fn set_terminal(conn: &Connection, terminal_id: &str) {
    crate::db::set_setting(conn, "terminal", "terminal_id", terminal_id).expect("seed terminal id");
}

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    configure(&conn);
    conn
}

/// One file-backed database reached through separate handles.
struct FileDb(PathBuf);

impl FileDb {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("gift-funding-{}.db", Uuid::new_v4()));
        configure(&Connection::open(&path).expect("create file db"));
        Self(path)
    }

    fn open(&self) -> Connection {
        let conn = Connection::open(&self.0).expect("open file db");
        conn.busy_timeout(Duration::from_secs(5))
            .expect("busy timeout");
        conn
    }
}

impl Drop for FileDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn scope() -> OpeningScope {
    OpeningScope {
        organization_id: ORG.to_string(),
        branch_id: BRANCH.to_string(),
        terminal_id: TERMINAL.to_string(),
    }
}

/// Shared18 confirmation (also the current read's replayed reply).
fn opening_reply(
    intent: &OpeningIntent,
    usable: bool,
    gift_cash: i64,
    version: i64,
    ack: Option<&str>,
) -> Value {
    json!({
        "success": true,
        "synced_count": 1,
        "skipped_count": 0,
        "results": [{
            "shift_id": intent.shift_id,
            "status": "success",
            "financial_opening": {
                "contract": opening::OPENING_CONTRACT,
                "opening_key": intent.opening_key,
                "shift_id": intent.shift_id,
                "drawer_id": intent.drawer_id,
                "state": "confirmed",
                "replayed": version > 0,
                "usable": usable,
                "organization_id": intent.organization_id,
                "branch_id": intent.branch_id,
                "owner_terminal_id": OWNER_DB,
                "source_terminal_id": SOURCE_DB,
                "terminal_id": intent.terminal_id,
                "staff_id": intent.staff_id,
                "role_type": "cashier",
                "opening_cents": intent.opening_cents,
                "currency": intent.currency,
                "business_date": intent.business_date,
                "checked_in_at": intent.checked_in_at,
                "is_day_start": intent.is_day_start,
                "calculation_version": 2,
                "drawer": {
                    "contract": FUNDING_CONTRACT,
                    "drawer_id": intent.drawer_id,
                    "shift_id": intent.shift_id,
                    "owner_terminal_id": OWNER_DB,
                    "currency": intent.currency,
                    "gift_cash_cents": gift_cash,
                    "ordinary_expected_cents": intent.opening_cents,
                    "expected_cents": intent.opening_cents + gift_cash,
                    "version": version,
                    "acknowledgement_id": ack,
                }
            }
        }]
    })
}

/// A confirmed usable original with its published mirror and a live hosted
/// cashier session.
fn usable_original(conn: &Connection, staff: &str) -> OpeningIntent {
    let request = PrepareRequest {
        opening_key: None,
        staff_id: staff.to_string(),
        staff_name: Some("Maria".to_string()),
        opening_cents: 5_000,
        currency: "EUR".to_string(),
    };
    let (intent, created) = opening::prepare_opening(conn, &scope(), &request, Utc::now())
        .expect("prepare the original opening");
    assert!(created);
    assert_eq!(
        opening::apply_sync_result(
            conn,
            &intent.opening_key,
            Ok(&opening_reply(&intent, true, 0, 0, None)),
            Utc::now()
        ),
        DispatchOutcome::Confirmed {
            state: OpeningState::ConfirmedUsable
        }
    );
    opening::install_hosted_cashier_for_test(&intent, 3_600);
    opening::load_intent(conn, &intent.opening_key)
        .unwrap()
        .unwrap()
}

fn authorize_manager_for_test() {
    let now = Utc::now();
    install_grant_authority(
        capture_fence(),
        &scope(),
        MANAGER,
        MANAGER_SESSION,
        now + chrono::Duration::hours(8),
        now,
    )
    .expect("manager authority");
}

fn external_request(key: Option<&str>, cents: i64) -> Value {
    let mut body = json!({
        "staffId": STAFF,
        "mode": "external_card_recorded",
        "operation": "issue",
        "amountCents": cents,
        "currency": "EUR",
        "reason": "Birthday card",
    });
    if let Some(key) = key {
        body["attemptKey"] = json!(key);
    }
    body
}

fn cash_request(cents: i64, currency: &str) -> Value {
    json!({
        "staffId": STAFF,
        "mode": "cash_confirmed",
        "operation": "reload",
        "cardId": RELOAD_CARD,
        "amountCents": cents,
        "currency": currency,
        "reason": "Top up",
    })
}

fn grant_request(cents: i64) -> Value {
    json!({
        "staffId": MANAGER,
        "operation": "issue",
        "amountCents": cents,
        "currency": "EUR",
        "reason": "Complaint goodwill",
    })
}

fn external_evidence(cents: i64) -> Value {
    json!({
        "kind": Mode::ExternalCard.evidence_kind(),
        "amountCents": cents,
        "currency": "EUR",
        "confirmed": true,
        "provider": " Viva ",
        "merchantId": "M-100",
        "terminalReference": "T-7",
        "transactionReference": "TX-42",
    })
}

fn cash_evidence(cents: i64) -> Value {
    json!({ "kind": Mode::Cash.evidence_kind(), "amountCents": cents, "currency": "EUR", "confirmed": true })
}

fn record(conn: &Connection, payload: &Value) -> Attempt {
    let request = FundingRequest::parse(payload, false).expect("valid request");
    open_cashier_attempt(conn, &request, Utc::now()).expect("recorded attempt")
}

// ---------------------------------------------------------------------------
// Gift-bound native close against cash admission (separate handles)
// ---------------------------------------------------------------------------

use crate::gift_financial_opening::DrawerState;

/// A native close service over its own handle of the file database.
fn close_db(file: &FileDb) -> crate::db::DbState {
    crate::db::DbState {
        conn: std::sync::Mutex::new(file.open()),
        db_path: file.0.clone(),
    }
}

/// Confirms a synchronized gift top-up on the original: the hosted ordinary
/// term (5_300) differs from the local reconciliation of its opening cash.
fn hosted_gift_drawer(conn: &Connection, intent: &OpeningIntent) -> DrawerState {
    let drawer = DrawerState {
        version: 3,
        acknowledgement_id: Some(DRAWER_ACK.to_string()),
        gift_cash_cents: 2_000,
        ordinary_expected_cents: 5_300,
        expected_cents: 7_300,
    };
    conn.execute(
        "UPDATE gift_financial_openings SET drawer_version = ?2, drawer_acknowledgement_id = ?3,
             drawer_gift_cash_cents = ?4, drawer_ordinary_expected_cents = ?5, drawer_expected_cents = ?6
         WHERE opening_key = ?1",
        params![
            intent.opening_key,
            drawer.version,
            drawer.acknowledgement_id,
            drawer.gift_cash_cents,
            drawer.ordinary_expected_cents,
            drawer.expected_cents
        ],
    )
    .expect("confirm the hosted gift drawer");
    drawer
}

/// The explicit approval: the full hosted fingerprint and the approved local
/// ordinary cents, beside the ordinary `closingCash` input.
fn gift_close(
    intent: &OpeningIntent,
    counted: i64,
    hosted: &DrawerState,
    approved_ordinary: i64,
) -> Value {
    json!({
        "shiftId": intent.shift_id,
        "closingCash": counted as f64 / 100.0,
        "closedBy": STAFF,
        "giftClosing": {
            "countedCents": counted,
            "drawer": {
                "version": hosted.version,
                "acknowledgementId": hosted.acknowledgement_id,
                "giftCashCents": hosted.gift_cash_cents,
                "ordinaryExpectedCents": hosted.ordinary_expected_cents,
                "expectedCents": hosted.expected_cents,
            },
            "approvedOrdinaryExpectedCents": approved_ordinary,
        },
    })
}

fn close(db: &crate::db::DbState, payload: &Value) -> Value {
    crate::shifts::close_shift(db, payload).expect("close result")
}

/// The closing journal, parity queue and both mirrors of the original.
fn close_state(conn: &Connection, intent: &OpeningIntent) -> (i64, i64, String, Option<String>) {
    let count = |sql: &str| conn.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap();
    (
        count("SELECT COUNT(*) FROM gift_financial_closings"),
        count("SELECT COUNT(*) FROM parity_sync_queue"),
        conn.query_row(
            "SELECT status FROM staff_shifts WHERE id = ?1",
            params![intent.shift_id],
            |row| row.get(0),
        )
        .unwrap(),
        conn.query_row(
            "SELECT closed_at FROM cash_drawer_sessions WHERE id = ?1",
            params![intent.drawer_id],
            |row| row.get(0),
        )
        .unwrap(),
    )
}

#[test]
fn gift_close_captures_one_original_with_its_exact_queue_body_key_and_mirrors() {
    let _serial = opening::hosted_auth_test_serial();
    let file = FileDb::new();
    let conn = file.open();
    let intent = usable_original(&conn, STAFF);
    let hosted = hosted_gift_drawer(&conn, &intent);
    let db = close_db(&file);
    let before = close_state(&conn, &intent);

    let result = close(&db, &gift_close(&intent, 7_450, &hosted, 5_000));
    assert_eq!(result["success"], true, "{result}");
    let closing = result["giftFinancialClosing"].clone();
    assert_eq!(closing["pendingFinancialConfirmation"], true);
    assert_eq!(closing["replayed"], false);
    assert_eq!(
        (result["expected"].as_f64(), result["variance"].as_f64()),
        (Some(70.0), Some(4.5))
    );

    let original =
        crate::gift_financial_closing::load_original_for_opening(&conn, &intent.opening_key)
            .unwrap()
            .expect("one closing original");
    assert_eq!(closing["closingKey"], original.closing_key.as_str());
    assert_eq!(closing["queueItemId"], original.queue_item_id.as_str());
    assert_eq!(closing["closedAt"], original.closed_at.as_str());
    assert_eq!(original.counted_cents, 7_450);
    // The journal keeps the local approved preview, the opening the hosted fingerprint.
    assert_eq!(
        original.drawer,
        DrawerState {
            ordinary_expected_cents: 5_000,
            expected_cents: 7_000,
            ..hosted.clone()
        }
    );
    assert_eq!(original.variance_cents, 450);
    assert_eq!(
        opening::load_intent(&conn, &intent.opening_key)
            .unwrap()
            .unwrap()
            .drawer,
        Some(hosted.clone())
    );

    // The one queued item is exactly the captured body under its closing key.
    let queued: String = conn
        .query_row(
            "SELECT data FROM parity_sync_queue WHERE id = ?1",
            params![original.queue_item_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queued, original.request_body_json);
    let body: Value = serde_json::from_str(&queued).unwrap();
    assert_eq!(body["idempotencyKey"], original.closing_key.as_str());
    assert_eq!(body["checkOutTime"], original.closed_at.as_str());
    assert_eq!(body["expectedCash"].as_f64(), Some(70.0));
    assert_eq!(body["cashDrawer"]["expected_amount_cents"], 7_000);
    assert_eq!(body["cashDrawer"]["variance_amount_cents"], 450);
    assert_eq!(body["cashDrawer"]["closedAt"], original.closed_at.as_str());
    let after = close_state(&conn, &intent);
    assert_eq!((after.0, after.1), (before.0 + 1, before.1 + 1));
    assert_eq!(
        (after.2.as_str(), after.3.as_deref()),
        ("closed", Some(original.closed_at.as_str()))
    );
    let (shift_expected, shift_variance): (i64, i64) = conn
        .query_row(
            "SELECT expected_cash_amount_cents, cash_variance_cents FROM staff_shifts WHERE id = ?1",
            params![intent.shift_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((shift_expected, shift_variance), (7_000, 450));

    // An identical retry returns the retained original; nothing is recaptured.
    let retry = close(&db, &gift_close(&intent, 7_450, &hosted, 5_000));
    assert_eq!(retry["giftFinancialClosing"]["replayed"], true, "{retry}");
    for field in [
        "closingKey",
        "queueItemId",
        "closedAt",
        "countedCents",
        "drawer",
        "varianceCents",
    ] {
        assert_eq!(
            retry["giftFinancialClosing"][field], closing[field],
            "{field}"
        );
    }
    // A conflicting count, approval or scope is refused, never replaced.
    let refused = |payload: &Value| {
        close(&db, payload)["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };
    assert_eq!(
        refused(&gift_close(&intent, 7_451, &hosted, 5_000)),
        "GIFT_CLOSING_ORIGINAL_CONFLICT"
    );
    assert_eq!(
        refused(&gift_close(&intent, 7_450, &hosted, 5_300)),
        "GIFT_CLOSING_ORIGINAL_CONFLICT"
    );
    set_terminal(&conn, OTHER_TERMINAL);
    assert_eq!(
        refused(&gift_close(&intent, 7_450, &hosted, 5_000)),
        "GIFT_CLOSING_SCOPE_MISMATCH"
    );
    set_terminal(&conn, TERMINAL);
    assert_eq!(close_state(&conn, &intent), after);
    assert_eq!(
        crate::gift_financial_closing::load_original_for_opening(&conn, &intent.opening_key)
            .unwrap(),
        Some(original)
    );
}

#[test]
fn confirmed_gift_close_replay_uses_canonical_money_and_time_without_recapturing() {
    let _serial = opening::hosted_auth_test_serial();
    let file = FileDb::new();
    let conn = file.open();
    let intent = usable_original(&conn, STAFF);
    let hosted = hosted_gift_drawer(&conn, &intent);
    let db = close_db(&file);
    let payload = gift_close(&intent, 7_450, &hosted, 5_000);
    assert_eq!(close(&db, &payload)["success"], true);
    let original =
        crate::gift_financial_closing::load_original_for_opening(&conn, &intent.opening_key)
            .unwrap()
            .unwrap();
    let canonical_at = Utc::now() + chrono::Duration::minutes(1);
    let canonical_stamp = normalize_instant(canonical_at);
    let proof = crate::gift_financial_closing::CanonicalClosing {
        organization_id: original.organization_id.clone(),
        branch_id: original.branch_id.clone(),
        terminal_id: original.terminal_id.clone(),
        source_terminal_id: original.source_terminal_db_id.clone(),
        owner_terminal_id: original.owner_terminal_db_id.clone(),
        shift_id: original.shift_id.clone(),
        drawer_id: original.drawer_id.clone(),
        staff_id: original.staff_id.clone(),
        currency: original.currency.clone(),
        counted_cents: original.counted_cents,
        variance_cents: 150,
        closed_at: canonical_stamp.clone(),
        drawer: crate::gift_financial_closing::CanonicalDrawer {
            drawer_id: original.drawer_id.clone(),
            shift_id: original.shift_id.clone(),
            owner_terminal_id: original.owner_terminal_db_id.clone(),
            gift_cash_cents: 2_000,
            ordinary_expected_cents: 5_300,
            expected_cents: 7_300,
            version: hosted.version,
            acknowledgement_id: hosted.acknowledgement_id.clone(),
        },
    };
    let reply = json!({"results": [{"shift_id": original.shift_id, "status": "ok", "financial_closing": proof.to_value()}]});
    let tx = conn.unchecked_transaction().unwrap();
    let adoption = crate::gift_financial_closing::adopt_closing_response(
        &tx,
        &original.closing_key,
        Some(&reply),
        None,
        canonical_at,
    )
    .unwrap();
    assert!(matches!(
        adoption,
        crate::gift_financial_closing::ClosingAdoption::Adopted { .. }
    ));
    tx.commit().unwrap();
    let before_replay = close_state(&conn, &intent);

    let replay = close(&db, &payload);
    assert_eq!(replay["success"], true, "{replay}");
    assert_eq!(replay["expected"].as_f64(), Some(73.0));
    assert_eq!(replay["variance"].as_f64(), Some(1.5));
    let view = &replay["giftFinancialClosing"];
    assert_eq!(view["state"], "confirmed");
    assert_eq!(view["pendingFinancialConfirmation"], false);
    assert_eq!(view["drawer"]["ordinaryExpectedCents"], 5_300);
    assert_eq!(view["drawer"]["expectedCents"], 7_300);
    assert_eq!(view["varianceCents"], 150);
    assert_eq!(view["closedAt"], canonical_stamp);
    assert_eq!(view["capturedAt"], original.closed_at);
    assert_eq!(view["countedCents"], original.counted_cents);
    assert_eq!(view["closingKey"], original.closing_key);
    assert_eq!(view["queueItemId"], original.queue_item_id);
    assert_eq!(
        view["requestBody"],
        serde_json::from_str::<Value>(&original.request_body_json).unwrap()
    );
    assert_eq!(close_state(&conn, &intent), before_replay);
    let stored = crate::gift_financial_closing::load_original(&conn, &original.closing_key)
        .unwrap()
        .unwrap();
    assert_eq!(stored.drawer, original.drawer);
    assert_eq!(stored.variance_cents, original.variance_cents);

    // Simulate an unavailable proof read, without weakening the immutable-proof
    // trigger. A confirmed flag cannot publish the old local preview on error.
    conn.execute_batch("ALTER TABLE gift_financial_closings RENAME COLUMN confirmation_json TO unavailable_confirmation_json").unwrap();
    let refused = close(&db, &payload);
    assert_eq!(refused["success"], false);
    assert_eq!(refused["code"], "GIFT_CLOSING_PROOF_UNAVAILABLE");
    assert!(refused.get("giftFinancialClosing").is_none());
    assert_eq!(close_state(&conn, &intent), before_replay);
}

#[test]
fn gift_close_failures_roll_back_everything_and_stale_terms_need_renewed_approval() {
    let _serial = opening::hosted_auth_test_serial();
    let file = FileDb::new();
    let conn = file.open();
    let intent = usable_original(&conn, STAFF);
    let hosted = hosted_gift_drawer(&conn, &intent);
    let db = close_db(&file);
    let before = close_state(&conn, &intent);
    let refused = |payload: &Value| {
        close(&db, payload)["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    };

    // Stale hosted fingerprint terms, stale approved local ordinary cents and
    // an ordinary input all write nothing.
    let stale_host = DrawerState {
        version: 2,
        ..hosted.clone()
    };
    assert_eq!(
        refused(&gift_close(&intent, 7_450, &stale_host, 5_000)),
        "GIFT_CLOSING_DRAWER_CHANGED"
    );
    let stale_ordinary = DrawerState {
        ordinary_expected_cents: 5_000,
        expected_cents: 7_000,
        ..hosted.clone()
    };
    assert_eq!(
        refused(&gift_close(&intent, 7_450, &stale_ordinary, 5_000)),
        "GIFT_CLOSING_DRAWER_CHANGED"
    );
    assert_eq!(
        refused(&gift_close(&intent, 7_450, &hosted, 4_900)),
        "GIFT_CLOSING_TERMS_CHANGED"
    );
    assert_eq!(
        refused(&json!({ "shiftId": intent.shift_id, "closingCash": 74.5 })),
        "GIFT_CLOSING_PREPARATION_REQUIRED"
    );
    let mut inexact = gift_close(&intent, 7_450, &hosted, 5_000);
    inexact["closingCash"] = json!(74.4);
    assert_eq!(refused(&inexact), "INVALID_GIFT_CLOSING_PREPARATION");
    assert_eq!(close_state(&conn, &intent), before);

    // A late failure after capture rolls back reconciliation, queue, journal and mirrors.
    db.conn
        .lock()
        .unwrap()
        .execute_batch(
            "CREATE TEMP TRIGGER fail_gift_close BEFORE UPDATE OF status ON staff_shifts
             WHEN NEW.status = 'closed' BEGIN SELECT RAISE(ABORT, 'injected late failure'); END;",
        )
        .unwrap();
    let failed =
        crate::shifts::close_shift(&db, &gift_close(&intent, 7_450, &hosted, 5_000)).unwrap_err();
    assert!(failed.contains("injected late failure"), "{failed}");
    assert!(db.conn.lock().unwrap().is_autocommit());
    assert_eq!(close_state(&conn, &intent), before);

    db.conn
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER temp.fail_gift_close")
        .unwrap();
    assert_eq!(
        close(&db, &gift_close(&intent, 7_450, &hosted, 5_000))["success"],
        true
    );
    assert_eq!(close_state(&conn, &intent).0, before.0 + 1);
}

#[test]
fn funding_first_blocks_the_close_and_close_first_admits_no_new_cash() {
    let _serial = opening::hosted_auth_test_serial();
    let file = FileDb::new();
    let (a, b) = (file.open(), file.open());
    let intent = usable_original(&a, STAFF);
    let hosted = hosted_gift_drawer(&a, &intent);
    let db = close_db(&file);

    // Funding first: the committed unresolved cash attempt blocks the close.
    let mut keyed = cash_request(1_000, "EUR");
    keyed["attemptKey"] = json!(Uuid::new_v4().to_string());
    let attempt = record(&a, &keyed);
    assert!(
        a.is_autocommit(),
        "the admission commits before any request"
    );
    let before = close_state(&b, &intent);
    assert_eq!(
        close(&db, &gift_close(&intent, 7_450, &hosted, 5_000))["code"],
        "GIFT_FUNDING_UNRESOLVED"
    );
    assert_eq!(close_state(&b, &intent), before);

    // The unsent attempt is refused; the close is then admitted.
    refuse_unsent(
        &a,
        &attempt.original.attempt_key,
        "FUNDING_TEST_ABANDONED",
        Utc::now(),
    );
    assert!(unresolved_funding(&a, Some(&intent.shift_id))
        .unwrap()
        .is_empty());
    assert_eq!(
        close(&db, &gift_close(&intent, 7_450, &hosted, 5_000))["success"],
        true
    );

    // Close first: another handle admits no new cash attempt...
    let fresh = FundingRequest::parse(&cash_request(500, "EUR"), false).unwrap();
    assert_eq!(
        open_cashier_attempt(&b, &fresh, Utc::now())
            .unwrap_err()
            .code,
        "ORIGINAL_DRAWER_CLOSED"
    );
    assert!(b.is_autocommit());
    assert_eq!(count_attempts(&b), 1);
    // ...while the identical retained attempt still recovers after the close.
    assert_eq!(record(&b, &keyed).original, attempt.original);
    assert_eq!(count_attempts(&b), 1);
}

#[test]
fn cash_admission_holds_its_own_write_lock_and_never_nests() {
    let _serial = opening::hosted_auth_test_serial();
    let file = FileDb::new();
    let (a, b) = (file.open(), file.open());
    usable_original(&a, STAFF);
    let request = FundingRequest::parse(&cash_request(1_000, "EUR"), false).unwrap();

    // A caller transaction is refused rather than blindly nested.
    a.execute_batch("BEGIN").unwrap();
    assert_eq!(
        open_cashier_attempt(&a, &request, Utc::now())
            .unwrap_err()
            .code,
        "LOCAL_STORE_FAILED"
    );
    a.execute_batch("ROLLBACK").unwrap();

    // While another writer holds the lock, admission reads and inserts nothing.
    a.execute_batch("BEGIN IMMEDIATE").unwrap();
    b.busy_timeout(Duration::from_millis(0)).unwrap();
    assert_eq!(
        open_cashier_attempt(&b, &request, Utc::now())
            .unwrap_err()
            .code,
        "LOCAL_STORE_FAILED"
    );
    assert!(b.is_autocommit());
    a.execute_batch("COMMIT").unwrap();
    assert_eq!(count_attempts(&b), 0);

    b.busy_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        open_cashier_attempt(&b, &request, Utc::now())
            .unwrap()
            .original
            .amount_cents,
        1_000
    );
    assert!(b.is_autocommit());
    assert_eq!(count_attempts(&a), 1);
}

fn load(conn: &Connection, key: &str) -> Attempt {
    load_attempt(conn, key)
        .expect("read")
        .expect("attempt exists")
}

fn plan(conn: &Connection, key: &str, requested: Requested) -> SendPlan {
    match plan_step(conn, key, &requested, true, Utc::now()).expect("a planned step") {
        Planned::Send(plan) => plan,
        Planned::Settled(attempt) => panic!("settled in {}", attempt.state.as_str()),
    }
}

fn refusal(conn: &Connection, key: &str, requested: Requested) -> String {
    match plan_step(conn, key, &requested, true, Utc::now()) {
        Err(value) => value["code"].as_str().expect("refusal code").to_string(),
        Ok(planned) => panic!("expected a refusal, got {planned:?}"),
    }
}

fn finish(conn: &Connection, plan: &SendPlan, reply: Result<&Value, &AdminFetchError>) -> Value {
    finish_step(conn, plan, reply, Utc::now()).expect("finish")
}

/// The exact flat `GiftCardFundingResponse` for `a` in `state`.
fn funding_reply(a: &Attempt, state: &str) -> Value {
    let o = &a.original;
    let mut body = json!({
        "success": true,
        "contract": FUNDING_CONTRACT,
        "intent_id": a.intent_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string()),
        "organization_id": o.organization_id,
        "branch_id": o.branch_id,
        "terminal_id": o.terminal_id,
        "staff_id": o.staff_id,
        "staff_session_id": Uuid::new_v4().to_string(),
        "state": state,
        "operation": o.operation.as_str(),
        "mode": o.mode.as_str(),
        "amount_cents": o.amount_cents,
        "currency": o.currency,
        "idempotency_key": o.attempt_key,
        "replayed": false,
        "card_id": null,
        "credit_id": null,
        "acknowledgement_id": null,
        "card_balance_cents": null,
        "card_number_hash": null,
        "drawer_id": o.drawer_id,
        "shift_id": o.shift_id,
        "owner_terminal_id": OWNER_DB,
        "evidence": null,
        "collection_required": (state == "prepared" && o.mode != Mode::ManagerGrant),
        "collect_again": false,
        "verified_capture": false,
        "fiscal_receipt": false,
    });
    if state == "completed" {
        body["card_id"] = json!(o
            .card_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()));
        body["credit_id"] = json!(Uuid::new_v4().to_string());
        body["acknowledgement_id"] = json!(Uuid::new_v4().to_string());
        body["card_balance_cents"] = json!(o.amount_cents);
        body["card_number_hash"] = json!("ab".repeat(32));
        body["evidence"] = expected_evidence(a).expect("known evidence");
        if o.operation == Operation::Issue {
            body["card_number"] = json!(CARD_NUMBER);
        }
    }
    body
}

fn rejected(
    base: &Value,
    attempt: &Attempt,
    change: impl FnOnce(&mut Value),
) -> Option<&'static str> {
    let mut body = base.clone();
    change(&mut body);
    parse_funding_response(&body, attempt).err()
}

fn count_attempts(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM gift_card_funding_attempts",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn table_rows(conn: &Connection, table: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(&format!("SELECT * FROM \"{table}\"")) else {
        return vec!["<unreadable>".to_string()];
    };
    let columns = stmt.column_count();
    let mut rows: Vec<String> = stmt
        .query_map([], |row| {
            (0..columns)
                .map(|i| {
                    row.get::<_, rusqlite::types::Value>(i)
                        .map(|value| format!("{value:?}"))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|cells| cells.join("|"))
        })
        .map(|rows| rows.filter_map(Result::ok).collect::<Vec<String>>())
        .unwrap_or_default();
    rows.sort();
    rows
}

/// Every table except the funding journal, row by row: funding writes no
/// order, payment, EFT, fiscal, drawer, shift, queue or setting row.
fn outside_journal(conn: &Connection) -> Vec<(String, Vec<String>)> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name <> 'gift_card_funding_attempts' ORDER BY name",
        )
        .unwrap();
    let tables: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let rows = table_rows(conn, &table);
            (table, rows)
        })
        .collect()
}

fn gift_cash(conn: &Connection, intent: &OpeningIntent) -> i64 {
    opening::load_intent(conn, &intent.opening_key)
        .unwrap()
        .unwrap()
        .drawer
        .expect("strict drawer")
        .gift_cash_cents
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn schema_v86_attempt_original_is_immutable_and_rolls_back() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    assert!(crate::db::CURRENT_SCHEMA_VERSION >= 86);
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, i64::from(crate::db::CURRENT_SCHEMA_VERSION));
    usable_original(&conn, STAFF);
    let attempt = record(&conn, &external_request(None, 2_500));
    let key = attempt.original.attempt_key.clone();
    for sql in [
        "UPDATE gift_card_funding_attempts SET amount_cents = 2600 WHERE attempt_key = ?1",
        "UPDATE gift_card_funding_attempts SET staff_id = 'someone' WHERE attempt_key = ?1",
        "UPDATE gift_card_funding_attempts SET request_body = '{}' WHERE attempt_key = ?1",
        "UPDATE gift_card_funding_attempts SET state = 'collection_started' WHERE attempt_key = ?1",
        "UPDATE gift_card_funding_attempts SET state = 'prepared' WHERE attempt_key = ?1",
        "UPDATE gift_card_funding_attempts SET prepare_sends = -1 WHERE attempt_key = ?1",
    ] {
        assert!(conn.execute(sql, params![key]).is_err(), "{sql}");
    }
    {
        let tx = conn.unchecked_transaction().unwrap();
        tx.execute(
            "UPDATE gift_card_funding_attempts SET last_code = 'PARTIAL' WHERE attempt_key = ?1",
            params![key],
        )
        .unwrap();
        assert!(tx
            .execute(
                "UPDATE gift_card_funding_attempts SET currency = 'USD' WHERE attempt_key = ?1",
                params![key]
            )
            .is_err());
    }
    assert_eq!(
        load(&conn, &key),
        attempt,
        "the dropped transaction rolled back"
    );
    let non_cash_drawer = conn.execute(
        "INSERT INTO gift_card_funding_attempts (attempt_key, organization_id, branch_id, terminal_id,
            staff_id, operation, mode, amount_cents, currency, reason, drawer_id, shift_id,
            authority_opening_key, request_body, created_at, updated_at)
         VALUES ('k', ?1, ?2, ?3, ?4, 'issue', 'external_card_recorded', 100, 'EUR', 'r', 'd', 's',
                 'o', '{}', 'now', 'now')",
        params![ORG, BRANCH, TERMINAL, STAFF],
    );
    assert!(non_cash_drawer.is_err(), "only cash names a drawer");
}

#[test]
fn requests_are_strict_and_never_carry_custom_numbers_or_other_modes() {
    let parse = |payload: Value| FundingRequest::parse(&payload, false).err().map(|e| e.code);
    let mut custom = external_request(None, 100);
    custom["cardNumber"] = json!(CARD_NUMBER);
    assert_eq!(parse(custom).as_deref(), Some("INVALID_FUNDING_REQUEST"));
    let mut grant = external_request(None, 100);
    grant["mode"] = json!("manager_grant");
    assert_eq!(parse(grant).as_deref(), Some("MODE_REQUIRES_MANAGER_GRANT"));
    let mut verified = external_request(None, 100);
    verified["mode"] = json!("card_verified_capture");
    assert_eq!(parse(verified).as_deref(), Some("FUNDING_MODE_UNSUPPORTED"));
    let mut issue_with_card = external_request(None, 100);
    issue_with_card["cardId"] = json!(RELOAD_CARD);
    assert_eq!(
        parse(issue_with_card).as_deref(),
        Some("INVALID_FUNDING_REQUEST")
    );
    let mut reload_without_card = cash_request(100, "EUR");
    reload_without_card
        .as_object_mut()
        .unwrap()
        .remove("cardId");
    assert_eq!(
        parse(reload_without_card).as_deref(),
        Some("INVALID_FUNDING_REQUEST")
    );
    assert_eq!(
        parse(external_request(None, 0)).as_deref(),
        Some("INVALID_FUNDING_REQUEST")
    );
    assert_eq!(
        parse(external_request(None, 100_000_000)).as_deref(),
        Some("INVALID_FUNDING_REQUEST")
    );
    let mut long_reason = external_request(None, 100);
    long_reason["reason"] = json!("x".repeat(501));
    assert_eq!(
        parse(long_reason).as_deref(),
        Some("INVALID_FUNDING_REQUEST")
    );
    let mut grant_with_mode = grant_request(100);
    grant_with_mode["mode"] = json!("manager_grant");
    assert!(FundingRequest::parse(&grant_with_mode, true).is_err());
}

#[test]
fn external_card_flow_replays_identical_originals_and_collects_once() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    let intent = usable_original(&conn, STAFF);
    let before = outside_journal(&conn);
    let attempt = record(&conn, &external_request(None, 2_500));
    let key = attempt.original.attempt_key.clone();
    assert_eq!(attempt.state, AttemptState::PreparePending);
    assert_eq!(
        attempt.original.authority_opening_key.as_deref(),
        Some(intent.opening_key.as_str())
    );
    assert!(attempt.original.drawer_id.is_none());
    let unconfigured = plan_step(&conn, &key, &Requested::Resume, false, Utc::now()).unwrap_err();
    assert_eq!(unconfigured["code"], "TERMINAL_NOT_CONFIGURED");
    assert_eq!(
        load(&conn, &key).prepare_sends,
        0,
        "nothing was possibly sent"
    );

    // Lost prepare: the identical original body and key are replayed.
    let first = plan(&conn, &key, Requested::Resume);
    assert_eq!(
        (first.step, first.method, first.path.as_str()),
        (Step::Prepare, "POST", INTENTS_PATH)
    );
    assert_eq!(first.body.as_ref(), Some(&attempt.original.request_body()));
    assert_eq!(
        finish(
            &conn,
            &first,
            Err(&AdminFetchError::transport("reply lost"))
        )["code"],
        "TRANSPORT_UNCONFIRMED"
    );
    assert_eq!(load(&conn, &key).state, AttemptState::PreparePending);
    assert_eq!(
        refusal(&conn, &key, Requested::Cancel("mistake".into())),
        "CANCEL_REQUIRES_RECOVERY"
    );
    assert_eq!(
        refusal(&conn, &key, Requested::BeginCollection),
        "COLLECTION_NOT_ALLOWED"
    );
    let replay = plan(&conn, &key, Requested::Resume);
    assert_eq!(replay.body, first.body);
    assert_eq!(load(&conn, &key).prepare_sends, 2);
    let prepared = finish(
        &conn,
        &replay,
        Ok(&funding_reply(&load(&conn, &key), "prepared")),
    );
    assert_eq!(prepared["attempt"]["state"], "prepared");
    assert_eq!(prepared["attempt"]["collectionPermitted"], false);
    let intent_id = load(&conn, &key).intent_id.expect("pinned intent");

    // Begin: claimed durably before the send; permission only after its ACK.
    let begin = plan(&conn, &key, Requested::BeginCollection);
    assert_eq!(begin.step, Step::Begin);
    assert_eq!(begin.path, format!("{INTENTS_PATH}/{intent_id}/complete"));
    assert_eq!(begin.body.as_ref().unwrap()["action"], "begin_collection");
    assert_eq!(load(&conn, &key).state, AttemptState::CollectionPending);
    let held = finish(
        &conn,
        &begin,
        Err(&AdminFetchError::with_status("gateway", 502)),
    );
    assert_eq!(held["attempt"]["collectionPermitted"], false);
    // Renewal changes only the transport authority, never the key or body.
    opening::install_hosted_cashier_for_test(&intent, 3_600);
    let renewed = plan(&conn, &key, Requested::BeginCollection);
    assert_eq!(renewed.body, begin.body);
    assert_ne!(renewed.staff_session, begin.staff_session);
    let started = finish(
        &conn,
        &renewed,
        Ok(&funding_reply(&load(&conn, &key), "collection_started")),
    );
    assert_eq!(started["attempt"]["collectionPermitted"], true);

    // Complete: evidence must match the mode and value; stored once.
    assert_eq!(
        refusal(&conn, &key, Requested::Complete(cash_evidence(2_500))),
        "INVALID_FUNDING_EVIDENCE"
    );
    assert_eq!(
        refusal(&conn, &key, Requested::Complete(external_evidence(2_400))),
        "FUNDING_VALUE_MISMATCH"
    );
    let complete = plan(&conn, &key, Requested::Complete(external_evidence(2_500)));
    assert_eq!(complete.step, Step::Complete);
    assert_eq!(
        complete.body.as_ref().unwrap()["evidence"]["provider"],
        "Viva"
    );
    let stored = load(&conn, &key);
    assert_eq!(stored.state, AttemptState::CompletePending);
    // A late begin reply after a possibly sent complete never permits collection.
    let late_begin = finish(
        &conn,
        &begin,
        Ok(&funding_reply(&stored, "collection_started")),
    );
    assert_eq!(late_begin["attempt"]["state"], "complete_pending");
    assert_eq!(late_begin["attempt"]["collectionPermitted"], false);
    finish(
        &conn,
        &complete,
        Err(&AdminFetchError::transport("reply lost")),
    );
    assert_eq!(
        refusal(&conn, &key, Requested::BeginCollection),
        "COLLECTION_NOT_ALLOWED"
    );
    assert_eq!(
        refusal(&conn, &key, Requested::Cancel("late".into())),
        "COLLECTION_UNRESOLVED"
    );
    assert_eq!(
        refusal(&conn, &key, Requested::Complete(external_evidence(2_400))),
        "COMPLETE_EVIDENCE_MISMATCH"
    );
    let recovered = plan(&conn, &key, Requested::Resume);
    assert_eq!(recovered.body, complete.body);
    let completed_reply = funding_reply(&load(&conn, &key), "completed");
    let done = finish(&conn, &recovered, Ok(&completed_reply));
    assert_eq!(done["attempt"]["state"], "completed");
    assert_eq!(done["cardNumber"], CARD_NUMBER);
    assert_eq!(done["attempt"]["verifiedCapture"], false);
    assert_eq!(done["attempt"]["fiscalReceipt"], false);

    // Canonical ACK and credit once: a conflicting proof never overwrites.
    let completed = load(&conn, &key);
    let conflict = finish(
        &conn,
        &recovered,
        Ok(&funding_reply(&completed, "completed")),
    );
    assert_eq!(conflict["code"], "FUNDING_ACK_CONFLICT");
    assert!(conflict.get("cardNumber").is_none());
    assert_eq!(load(&conn, &key).completion, completed.completion);
    assert!(matches!(
        plan_step(&conn, &key, &Requested::Resume, true, Utc::now()),
        Ok(Planned::Settled(_))
    ));

    // A renderer can lose the completed reply even though native persisted it.
    // Only its explicit Check retrieves the original credential: GET, same key,
    // no collection, no second completion or financial projection write.
    let check = plan(&conn, &key, Requested::Recover);
    assert_eq!(check.step, Step::Read);
    assert_eq!(check.method, "GET");
    assert_eq!(check.path, format!("{INTENTS_PATH}/{intent_id}"));
    assert!(check.body.is_none());
    let restored = finish(&conn, &check, Ok(&completed_reply));
    assert_eq!(restored["cardNumber"], CARD_NUMBER);
    assert_eq!(restored["attempt"]["collectionPermitted"], false);
    assert_eq!(load(&conn, &key).completion, completed.completion);
    let mut foreign_proof = completed_reply.clone();
    foreign_proof["credit_id"] = json!(Uuid::new_v4().to_string());
    assert_eq!(
        finish(&conn, &check, Ok(&foreign_proof))["code"],
        "FUNDING_ACK_CONFLICT"
    );
    assert_eq!(load(&conn, &key).completion, completed.completion);
    opening::clear_authorizations();
    assert!(finish(&conn, &check, Ok(&completed_reply))
        .get("cardNumber")
        .is_none());
    assert!(plan_step(&conn, &key, &Requested::Recover, true, Utc::now()).is_err());

    // Stored value only: no other table changed; the raw number is not kept.
    assert_eq!(outside_journal(&conn), before);
    assert_eq!(gift_cash(&conn, &intent), 0);
    assert!(!table_rows(&conn, "gift_card_funding_attempts")
        .concat()
        .contains(CARD_NUMBER));
}

#[test]
fn cash_attempt_binds_original_scope_drawer_and_value() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    let cash = |conn: &Connection, currency: &str| {
        let request = FundingRequest::parse(&cash_request(1_000, currency), false).unwrap();
        open_cashier_attempt(conn, &request, Utc::now())
    };
    assert_eq!(
        cash(&conn, "EUR").unwrap_err().code,
        "FINANCIAL_OPENING_REQUIRED"
    );
    let intent = usable_original(&conn, STAFF);
    assert_eq!(
        cash(&conn, "USD").unwrap_err().code,
        "CASH_CURRENCY_MISMATCH"
    );
    assert_eq!(count_attempts(&conn), 0);
    let attempt = cash(&conn, "EUR").expect("cash attempt");
    let key = attempt.original.attempt_key.clone();
    assert_eq!(
        attempt.original.drawer_id.as_deref(),
        Some(intent.drawer_id.as_str())
    );
    assert_eq!(
        attempt.original.shift_id.as_deref(),
        Some(intent.shift_id.as_str())
    );
    let body = attempt.original.request_body();
    assert_eq!(
        (body["drawer_id"].as_str(), body["card_id"].as_str()),
        (Some(intent.drawer_id.as_str()), Some(RELOAD_CARD))
    );
    assert!(body.get("card_number").is_none() && body.get("staff_session_id").is_none());

    // A foreign terminal scope neither sends nor adopts.
    set_terminal(&conn, OTHER_TERMINAL);
    assert_eq!(
        refusal(&conn, &key, Requested::Resume),
        "FUNDING_SCOPE_CHANGED"
    );
    set_terminal(&conn, TERMINAL);

    let prepare = plan(&conn, &key, Requested::Resume);
    let fresh = load(&conn, &key);
    for (field, value, code) in [
        ("organization_id", json!(BRANCH), "FOREIGN_FUNDING_RESULT"),
        (
            "idempotency_key",
            json!(FOREIGN_ID),
            "FOREIGN_FUNDING_RESULT",
        ),
        ("amount_cents", json!(1_001), "FUNDING_VALUE_MISMATCH"),
        ("currency", json!("USD"), "FUNDING_VALUE_MISMATCH"),
        ("drawer_id", json!(FOREIGN_ID), "FUNDING_DRAWER_MISMATCH"),
        ("shift_id", Value::Null, "FUNDING_DRAWER_MISMATCH"),
    ] {
        let mut reply = funding_reply(&fresh, "prepared");
        reply[field] = value;
        assert_eq!(finish(&conn, &prepare, Ok(&reply))["code"], code, "{field}");
        assert_eq!(load(&conn, &key).state, AttemptState::PreparePending);
    }

    // Readiness refusal creates nothing; other failures stay unknown.
    assert_eq!(
        classify_failure(Some(503), Some(CASH_NOT_READY)),
        (true, true)
    );
    assert_eq!(classify_failure(Some(503), None), (false, false));
    assert_eq!(
        classify_failure(Some(409), Some("IDEMPOTENCY_CONFLICT")),
        (false, false)
    );
    assert_eq!(
        classify_failure(Some(403), Some("GIFT_CARD_STAFF_SESSION_INVALID")),
        (false, true)
    );
    assert_eq!(classify_failure(None, None), (false, false));
    let refused = finish(
        &conn,
        &prepare,
        Err(&AdminFetchError::with_status("invalid", 422)),
    );
    assert_eq!(refused["attempt"]["state"], "refused");
    assert_eq!(refused["attempt"]["unresolved"], false);
    assert_eq!(gift_cash(&conn, &intent), 0);
}

#[test]
fn a_refusal_is_final_only_without_another_unknown_send() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    usable_original(&conn, STAFF);
    let key = record(&conn, &external_request(None, 700))
        .original
        .attempt_key;
    let unknown = plan(&conn, &key, Requested::Resume);
    let second = plan(&conn, &key, Requested::Resume);
    finish(
        &conn,
        &second,
        Err(&AdminFetchError::with_status("invalid", 400)),
    );
    assert_eq!(
        load(&conn, &key).state,
        AttemptState::PreparePending,
        "the first send is still unknown"
    );
    finish(
        &conn,
        &unknown,
        Err(&AdminFetchError::with_status("invalid", 400)),
    );
    assert_eq!(load(&conn, &key).state, AttemptState::Refused);
}

#[test]
fn current_drawer_read_is_strict_nondecreasing_and_never_reopens() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    let intent = usable_original(&conn, STAFF);
    let read = plan_current_read(&conn, STAFF, Utc::now()).expect("read plan");
    assert_eq!(read.body, opening::build_sync_body(&intent));
    let view = finish_current_read(
        &conn,
        &read,
        Ok(&opening_reply(&intent, true, 700, 2, Some(DRAWER_ACK))),
        Utc::now(),
    )
    .expect("current drawer");
    assert_eq!(
        (
            view.version,
            view.gift_cash_cents,
            view.ordinary_expected_cents,
            view.expected_cents
        ),
        (2, 700, 5_000, 5_700)
    );
    assert_eq!(view.acknowledgement_id.as_deref(), Some(DRAWER_ACK));
    assert_eq!(view.drawer_id, intent.drawer_id);

    let stale = finish_current_read(
        &conn,
        &read,
        Ok(&opening_reply(&intent, true, 300, 1, Some(FOREIGN_ID))),
        Utc::now(),
    );
    assert!(
        stale.as_ref().map_or(true, |drawer| *drawer == view),
        "a stale projection is never adopted"
    );
    assert_eq!(gift_cash(&conn, &intent), 700);

    let unknown = finish_current_read(
        &conn,
        &read,
        Err(&AdminFetchError::transport("offline")),
        Utc::now(),
    );
    assert_eq!(unknown.unwrap_err().code, "CURRENT_READ_UNCONFIRMED");

    let fenced = plan_current_read(&conn, STAFF, Utc::now()).expect("read plan");
    opening::clear_authorizations();
    let cleared = finish_current_read(
        &conn,
        &fenced,
        Ok(&opening_reply(&intent, true, 700, 2, Some(DRAWER_ACK))),
        Utc::now(),
    );
    assert!(
        cleared.is_err(),
        "nothing is published after the dedicated clear"
    );
    opening::install_hosted_cashier_for_test(&intent, 3_600);

    let mut unconserved = opening_reply(&intent, true, 700, 3, Some(DRAWER_ACK));
    unconserved["results"][0]["financial_opening"]["drawer"]["expected_cents"] = json!(9_999);
    assert!(finish_current_read(&conn, &read, Ok(&unconserved), Utc::now()).is_err());

    let demoted = finish_current_read(
        &conn,
        &read,
        Ok(&opening_reply(&intent, false, 700, 3, Some(DRAWER_ACK))),
        Utc::now(),
    );
    assert_eq!(demoted.unwrap_err().code, "OPENING_UNUSABLE");
    let again = finish_current_read(
        &conn,
        &read,
        Ok(&opening_reply(&intent, true, 700, 4, Some(DRAWER_ACK))),
        Utc::now(),
    );
    assert!(again.is_err(), "an unusable original never reopens");
    assert_eq!(
        plan_current_read(&conn, STAFF, Utc::now())
            .unwrap_err()
            .code,
        "OPENING_UNUSABLE"
    );
    let request = FundingRequest::parse(&cash_request(1_000, "EUR"), false).unwrap();
    assert_eq!(
        open_cashier_attempt(&conn, &request, Utc::now())
            .unwrap_err()
            .code,
        "OPENING_UNUSABLE"
    );
}

#[test]
fn manager_grant_authority_is_separate_fenced_and_cleared_with_the_cashier() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    opening::clear_authorizations();
    let now = Utc::now();
    let intent = usable_original(&conn, STAFF);
    let before = outside_journal(&conn);

    // A cashier original, local PIN or role is no grant authority.
    let cashier_grant = FundingRequest::parse(
        &json!({ "staffId": STAFF, "operation": "issue", "amountCents": 100, "currency": "EUR", "reason": "x" }),
        true,
    )
    .unwrap();
    assert_eq!(
        open_grant_attempt(&conn, &cashier_grant, now)
            .unwrap_err()
            .code,
        "MANAGER_AUTHORIZATION_REQUIRED"
    );
    let request = FundingRequest::parse(&grant_request(1_500), true).unwrap();
    assert_eq!(
        open_grant_attempt(&conn, &request, now).unwrap_err().code,
        "MANAGER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(count_attempts(&conn), 0);

    // Fenced installation: a clear or a newer authorization wins.
    let hours = now + chrono::Duration::hours(8);
    let stale_fence = capture_fence();
    opening::clear_authorizations();
    let stale =
        install_grant_authority(stale_fence, &scope(), MANAGER, MANAGER_SESSION, hours, now);
    assert_eq!(stale.unwrap_err().code, "MANAGER_AUTHORIZATION_SUPERSEDED");
    let (older, newer) = (capture_fence(), capture_fence());
    let until =
        install_grant_authority(newer, &scope(), MANAGER, MANAGER_SESSION, hours, now).unwrap();
    assert_eq!(until, now + chrono::Duration::seconds(GRANT_AUTHORITY_SECS));
    let superseded = install_grant_authority(older, &scope(), MANAGER, FOREIGN_ID, hours, now);
    assert_eq!(
        superseded.unwrap_err().code,
        "MANAGER_AUTHORIZATION_SUPERSEDED"
    );
    assert_eq!(
        grant_session(&scope(), MANAGER, now).unwrap(),
        MANAGER_SESSION
    );
    let mut foreign_scope = scope();
    foreign_scope.terminal_id = OTHER_TERMINAL.to_string();
    assert!(grant_session(&foreign_scope, MANAGER, now).is_err());
    assert!(
        grant_session(&scope(), MANAGER, now).is_err(),
        "a foreign-scope use drops the authority"
    );
    authorize_manager_for_test();
    assert!(grant_session(
        &scope(),
        MANAGER,
        now + chrono::Duration::seconds(GRANT_AUTHORITY_SECS + 1)
    )
    .is_err());
    assert!(
        grant_session(&scope(), MANAGER, now).is_err(),
        "an expired authority is dropped"
    );

    // Grant: the manager's own session, the stored body, no collection.
    authorize_manager_for_test();
    let attempt = open_grant_attempt(&conn, &request, now).expect("grant recorded");
    let key = attempt.original.attempt_key.clone();
    assert!(
        attempt.original.drawer_id.is_none() && attempt.original.authority_opening_key.is_none()
    );
    let first = plan(&conn, &key, Requested::Resume);
    assert_eq!(
        (
            first.step,
            first.path.as_str(),
            first.staff_session.as_str()
        ),
        (Step::Grant, GRANTS_PATH, MANAGER_SESSION)
    );
    assert_eq!(first.body.as_ref().unwrap()["mode"], "manager_grant");
    assert!(first.body.as_ref().unwrap().get("drawer_id").is_none());
    assert_eq!(
        refusal(&conn, &key, Requested::BeginCollection),
        "GRANT_HAS_NO_COLLECTION"
    );
    let denied = finish(
        &conn,
        &first,
        Err(&AdminFetchError::with_status("forbidden", 403)),
    );
    assert_eq!(denied["attempt"]["state"], "prepare_pending");
    assert!(
        grant_session(&scope(), MANAGER, Utc::now()).is_err(),
        "a refused manager session is dropped"
    );
    assert_eq!(
        refusal(&conn, &key, Requested::Resume),
        "MANAGER_AUTHORIZATION_REQUIRED"
    );
    authorize_manager_for_test();
    let replay = plan(&conn, &key, Requested::Resume);
    assert_eq!(replay.body, first.body);
    let completed_reply = funding_reply(&load(&conn, &key), "completed");
    let done = finish(&conn, &replay, Ok(&completed_reply));
    assert_eq!(done["attempt"]["state"], "completed");
    assert_eq!(done["cardNumber"], CARD_NUMBER);
    assert!(
        grant_session(&scope(), MANAGER, Utc::now()).is_err(),
        "one authorization serves one grant"
    );

    // Recovering the completed issue requires this same manager to authorize again.
    assert_eq!(
        refusal(&conn, &key, Requested::Recover),
        "MANAGER_AUTHORIZATION_REQUIRED"
    );
    authorize_manager_for_test();
    let check = plan(&conn, &key, Requested::Recover);
    assert_eq!(
        (check.step, check.method, check.staff_session.as_str()),
        (Step::Read, "GET", MANAGER_SESSION)
    );
    assert!(check.body.is_none());
    let restored = finish(&conn, &check, Ok(&completed_reply));
    assert_eq!(restored["cardNumber"], CARD_NUMBER);
    assert_eq!(restored["attempt"]["collectionPermitted"], false);
    assert!(grant_session(&scope(), MANAGER, Utc::now()).is_err());

    // Late replies after the dedicated clear or outside the scope publish no number.
    authorize_manager_for_test();
    let late = open_grant_attempt(
        &conn,
        &FundingRequest::parse(&grant_request(900), true).unwrap(),
        now,
    )
    .unwrap();
    let late_plan = plan(&conn, &late.original.attempt_key, Requested::Resume);
    opening::clear_authorizations();
    let late_done = finish(
        &conn,
        &late_plan,
        Ok(&funding_reply(
            &load(&conn, &late.original.attempt_key),
            "completed",
        )),
    );
    assert_eq!(late_done["attempt"]["state"], "completed");
    assert!(late_done.get("cardNumber").is_none());
    authorize_manager_for_test();
    let foreign = open_grant_attempt(
        &conn,
        &FundingRequest::parse(&grant_request(800), true).unwrap(),
        now,
    )
    .unwrap();
    let foreign_plan = plan(&conn, &foreign.original.attempt_key, Requested::Resume);
    set_terminal(&conn, OTHER_TERMINAL);
    let foreign_done = finish(
        &conn,
        &foreign_plan,
        Ok(&funding_reply(
            &load(&conn, &foreign.original.attempt_key),
            "completed",
        )),
    );
    set_terminal(&conn, TERMINAL);
    assert!(foreign_done.get("cardNumber").is_none());

    // No drawer cash, no other table, no retained session.
    assert_eq!(gift_cash(&conn, &intent), 0);
    assert_eq!(outside_journal(&conn), before);
    assert!(!table_rows(&conn, "gift_card_funding_attempts")
        .concat()
        .contains(MANAGER_SESSION));
    assert!(!status_in(&conn, None)
        .unwrap()
        .to_string()
        .contains(MANAGER_SESSION));
}

#[test]
fn separate_handles_share_one_original_with_exclusive_claims_across_restart() {
    let _serial = opening::hosted_auth_test_serial();
    let db = FileDb::new();
    let (a, b) = (db.open(), db.open());
    usable_original(&a, STAFF);
    let key = Uuid::new_v4().to_string();
    let first = record(&a, &external_request(Some(&key), 2_500));
    assert_eq!(
        record(&b, &external_request(Some(&key), 2_500)),
        first,
        "same key and tuple resume"
    );
    let collision = FundingRequest::parse(&external_request(Some(&key), 2_600), false).unwrap();
    assert_eq!(
        open_cashier_attempt(&b, &collision, Utc::now())
            .unwrap_err()
            .code,
        "ATTEMPT_KEY_TUPLE_MISMATCH"
    );
    let mut foreign = first.original.clone();
    foreign.amount_cents = 2_600;
    assert_eq!(
        insert_attempt(&b, &foreign, Utc::now()).unwrap_err().code,
        "ATTEMPT_KEY_TUPLE_MISMATCH"
    );
    assert_eq!(
        insert_attempt(&b, &first.original, Utc::now()).unwrap(),
        first
    );
    assert_eq!(count_attempts(&a), 1);

    // A possibly sent original survives a restart with its key and body.
    let sent = plan(&a, &key, Requested::Resume);
    drop((a, b));
    let (a, b) = (db.open(), db.open());
    let retained = load(&b, &key);
    assert_eq!(
        (retained.state, retained.prepare_sends),
        (AttemptState::PreparePending, 1)
    );
    assert_eq!(
        refusal(&b, &key, Requested::Cancel("restart".into())),
        "CANCEL_REQUIRES_RECOVERY"
    );
    let replay = plan(&b, &key, Requested::Resume);
    assert_eq!(replay.body, sent.body);
    finish(&a, &replay, Ok(&funding_reply(&load(&a, &key), "prepared")));

    // Begin and cancel claims are exclusive across handles.
    let begin = plan(&a, &key, Requested::BeginCollection);
    assert_eq!(
        refusal(&b, &key, Requested::Cancel("race".into())),
        "COLLECTION_UNRESOLVED"
    );
    assert_eq!(
        plan(&b, &key, Requested::BeginCollection).body,
        begin.body,
        "a duplicate replays one claim"
    );

    let other = record(&a, &external_request(None, 1_200))
        .original
        .attempt_key;
    let prepare = plan(&a, &other, Requested::Resume);
    finish(
        &a,
        &prepare,
        Ok(&funding_reply(&load(&a, &other), "prepared")),
    );
    let cancel = plan(&b, &other, Requested::Cancel("customer left".into()));
    assert_eq!(cancel.body.as_ref().unwrap()["never_collected"], true);
    assert_eq!(
        refusal(&a, &other, Requested::BeginCollection),
        "COLLECTION_NOT_ALLOWED"
    );
    let canceled = finish(
        &b,
        &cancel,
        Ok(&funding_reply(&load(&b, &other), "canceled")),
    );
    assert_eq!(canceled["attempt"]["state"], "canceled");

    let never = record(&a, &external_request(None, 300))
        .original
        .attempt_key;
    let abandoned = plan_step(
        &b,
        &never,
        &Requested::Cancel("typo".into()),
        true,
        Utc::now(),
    );
    assert!(matches!(abandoned, Ok(Planned::Settled(ref x)) if x.state == AttemptState::Abandoned));
}

#[test]
fn strict_parser_rejects_foreign_or_malformed_funding_results() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    usable_original(&conn, STAFF);
    let mut reload_request = cash_request(400, "EUR");
    reload_request["mode"] = json!("external_card_recorded");
    let key = record(&conn, &reload_request).original.attempt_key;
    let prepare = plan(&conn, &key, Requested::Resume);
    let fresh = load(&conn, &key);
    let ok = funding_reply(&fresh, "prepared");
    assert!(parse_funding_response(&ok, &fresh).is_ok());
    for (change, code) in [
        (json!({ "extra": 1 }), "MALFORMED_FUNDING_RESULT"),
        (json!({ "success": false }), "UNCONFIRMED_FUNDING_RESULT"),
        (json!({ "verified_capture": true }), "FUNDING_FLAGS_INVALID"),
        (json!({ "collect_again": true }), "FUNDING_FLAGS_INVALID"),
        (json!({ "fiscal_receipt": true }), "FUNDING_FLAGS_INVALID"),
        (
            json!({ "collection_required": false }),
            "MALFORMED_FUNDING_RESULT",
        ),
        (
            json!({ "card_number": CARD_NUMBER }),
            "MALFORMED_FUNDING_RESULT",
        ),
        (
            json!({ "terminal_id": OTHER_TERMINAL }),
            "FOREIGN_FUNDING_RESULT",
        ),
        (json!({ "staff_id": MANAGER }), "FOREIGN_FUNDING_RESULT"),
        (json!({ "mode": "manager_grant" }), "FUNDING_VALUE_MISMATCH"),
        (json!({ "operation": "issue" }), "FUNDING_VALUE_MISMATCH"),
        (
            json!({ "drawer_id": FOREIGN_ID }),
            "FUNDING_DRAWER_MISMATCH",
        ),
        (json!({ "credit_id": FOREIGN_ID }), "FUNDING_PROOF_INVALID"),
        (
            json!({ "staff_session_id": "not-a-session" }),
            "MALFORMED_FUNDING_RESULT",
        ),
    ] {
        let got = rejected(&ok, &fresh, |body| {
            for (field, value) in change.as_object().unwrap() {
                body[field.as_str()] = value.clone();
            }
        });
        assert_eq!(got, Some(code), "{change}");
    }
    // A renewed session id is shape-checked only, never compared or kept.
    let renewed = rejected(&ok, &fresh, |body| {
        body["staff_session_id"] = json!(Uuid::new_v4().to_string())
    });
    assert_eq!(renewed, None);

    finish(&conn, &prepare, Ok(&ok));
    let begin = plan(&conn, &key, Requested::BeginCollection);
    finish(
        &conn,
        &begin,
        Ok(&funding_reply(&load(&conn, &key), "collection_started")),
    );
    plan(&conn, &key, Requested::Complete(external_evidence(400)));
    let pending = load(&conn, &key);
    let done = funding_reply(&pending, "completed");
    assert!(parse_funding_response(&done, &pending).is_ok());
    assert!(
        parse_funding_response(&done, &pending)
            .unwrap()
            .card_number
            .is_none(),
        "a reload has no number"
    );
    for (field, value, code) in [
        ("card_id", json!(FOREIGN_ID), "FOREIGN_FUNDING_RESULT"),
        ("intent_id", json!(FOREIGN_ID), "FOREIGN_FUNDING_RESULT"),
        (
            "owner_terminal_id",
            json!(FOREIGN_ID),
            "FOREIGN_FUNDING_RESULT",
        ),
        (
            "card_number",
            json!(CARD_NUMBER),
            "MALFORMED_FUNDING_RESULT",
        ),
        (
            "card_number_hash",
            json!("AB".repeat(32)),
            "FUNDING_PROOF_INVALID",
        ),
        ("acknowledgement_id", Value::Null, "FUNDING_PROOF_INVALID"),
    ] {
        assert_eq!(
            rejected(&done, &pending, |body| body[field] = value),
            Some(code),
            "{field}"
        );
    }
    let tampered = rejected(&done, &pending, |body| {
        body["evidence"]["transaction_reference"] = json!("TX-43")
    });
    assert_eq!(tampered, Some("FUNDING_EVIDENCE_MISMATCH"));
}

#[test]
fn close_blocker_reports_unresolved_funding_of_the_current_scope_and_shift() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    let intent = usable_original(&conn, STAFF);
    assert_eq!(close_blocker_value(&conn, None)["blocked"], false);
    let cash = record(&conn, &cash_request(1_000, "EUR"))
        .original
        .attempt_key;
    let external = record(&conn, &external_request(None, 2_000))
        .original
        .attempt_key;
    let resolved = record(&conn, &external_request(None, 300))
        .original
        .attempt_key;
    plan_step(
        &conn,
        &resolved,
        &Requested::Cancel("typo".into()),
        true,
        Utc::now(),
    )
    .expect("abandoned");
    authorize_manager_for_test();
    let grant_request = FundingRequest::parse(&grant_request(500), true).unwrap();
    let grant = open_grant_attempt(&conn, &grant_request, Utc::now())
        .unwrap()
        .original
        .attempt_key;

    let all = unresolved_funding(&conn, None).unwrap();
    let keys: Vec<&str> = all.iter().map(|item| item.attempt_key.as_str()).collect();
    assert_eq!(keys, [cash.as_str(), external.as_str(), grant.as_str()]);
    let shift = unresolved_funding(&conn, Some(&intent.shift_id)).unwrap();
    assert_eq!(
        shift.len(),
        2,
        "cash on its drawer and the attempt its original authorized"
    );
    let blocker = close_blocker_value(&conn, Some(&json!({ "shiftId": intent.shift_id })));
    assert_eq!(blocker["blocked"], true);
    assert_eq!(blocker["unresolved"].as_array().unwrap().len(), 2);
    assert_eq!(
        close_blocker_value(&conn, Some(&json!({ "shiftId": "nope" })))["code"],
        "INVALID_SHIFT_ID"
    );
    assert!(unresolved_funding(&conn, Some(FOREIGN_ID))
        .unwrap()
        .is_empty());

    set_terminal(&conn, OTHER_TERMINAL);
    assert!(unresolved_funding(&conn, None).unwrap().is_empty());
    assert_eq!(
        status_in(&conn, Some(&external)).unwrap()["attempts"],
        json!([])
    );
    set_terminal(&conn, TERMINAL);
    crate::db::set_setting(&conn, "terminal", "organization_id", "").unwrap();
    assert_eq!(
        status_in(&conn, None).unwrap()["code"],
        "TERMINAL_SCOPE_UNAVAILABLE"
    );
    assert_eq!(
        close_blocker_value(&conn, None)["code"],
        "FUNDING_BLOCKER_UNAVAILABLE"
    );
    assert!(
        unresolved_funding(&conn, None).is_err(),
        "an unverifiable scope is unknown, not empty"
    );
    crate::db::set_setting(&conn, "terminal", "organization_id", ORG).unwrap();
    let status = status_in(&conn, None).unwrap();
    assert_eq!(status["attempts"].as_array().unwrap().len(), 4);
    assert_eq!(status["attempts"][3]["state"], "abandoned");
    assert!(!status.to_string().contains(MANAGER_SESSION));
}

// Recovery and lifecycle regression coverage over real SQLite handles.

fn root_prepared_external(conn: &Connection) -> String {
    usable_original(conn, STAFF);
    let key = record(conn, &external_request(None, 2_500))
        .original
        .attempt_key;
    let prepare = plan(conn, &key, Requested::Resume);
    let response = funding_reply(&load(conn, &key), "prepared");
    finish(conn, &prepare, Ok(&response));
    key
}

#[test]
fn root_collection_permission_is_a_single_ack_not_a_durable_status() {
    let _serial = opening::hosted_auth_test_serial();
    let db = FileDb::new();
    let (a, b) = (db.open(), db.open());
    let key = root_prepared_external(&a);
    let first = plan(&a, &key, Requested::BeginCollection);
    let duplicate = plan(&b, &key, Requested::BeginCollection);
    let response = funding_reply(&load(&a, &key), "collection_started");
    assert_eq!(
        finish(&a, &first, Ok(&response))["attempt"]["collectionPermitted"],
        true
    );
    assert_eq!(
        finish(&b, &duplicate, Ok(&response))["attempt"]["collectionPermitted"],
        false
    );
    let repeated = plan_step(&a, &key, &Requested::BeginCollection, true, Utc::now()).unwrap();
    match repeated {
        Planned::Settled(attempt) => assert_eq!(
            attempt_response(&attempt, None)["attempt"]["collectionPermitted"],
            false
        ),
        Planned::Send(_) => panic!("acknowledged begin must not send again"),
    }
    assert_eq!(
        status_in(&a, Some(&key)).unwrap()["attempts"][0]["collectionPermitted"],
        false
    );
    let read = plan(&b, &key, Requested::Resume);
    assert_eq!(
        finish(&b, &read, Ok(&response))["attempt"]["collectionPermitted"],
        false
    );
    let denied = plan_step(
        &a,
        &key,
        &Requested::Cancel("customer left".into()),
        true,
        Utc::now(),
    )
    .unwrap_err();
    assert_eq!(denied["attempt"]["collectionPermitted"], false);
}

#[test]
fn root_lost_begin_recovered_by_resume_never_invites_collection_again() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    let key = root_prepared_external(&conn);
    let begin = plan(&conn, &key, Requested::BeginCollection);
    finish(
        &conn,
        &begin,
        Err(&AdminFetchError::transport("lost begin reply")),
    );
    let recovery = plan(&conn, &key, Requested::Resume);
    assert_eq!(recovery.step, Step::Begin);
    assert_eq!(recovery.body, begin.body);
    let response = funding_reply(&load(&conn, &key), "collection_started");
    let recovered = finish(&conn, &recovery, Ok(&response));
    assert_eq!(recovered["attempt"]["state"], "collection_started");
    assert_eq!(recovered["attempt"]["collectionPermitted"], false);
    assert_eq!(
        finish(&conn, &begin, Ok(&response))["attempt"]["collectionPermitted"],
        false
    );
}

#[test]
fn root_lifecycle_clear_fences_a_held_begin_acknowledgement() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    let key = root_prepared_external(&conn);
    let begin = plan(&conn, &key, Requested::BeginCollection);
    opening::clear_authorizations();
    let response = funding_reply(&load(&conn, &key), "collection_started");
    let held = finish(&conn, &begin, Ok(&response));
    assert_ne!(held["attempt"]["collectionPermitted"], true);
    assert_eq!(
        load(&conn, &key).state,
        AttemptState::CollectionStarted,
        "retain canonical recovery evidence"
    );
    assert_eq!(
        attempt_view(&load(&conn, &key))["collectionPermitted"],
        false
    );
}

#[test]
fn root_scope_change_never_discloses_original_attempt_in_keyed_or_held_replies() {
    let _serial = opening::hosted_auth_test_serial();
    let conn = test_conn();
    let key = root_prepared_external(&conn);
    let begin = plan(&conn, &key, Requested::BeginCollection);
    for terminal in [OTHER_TERMINAL, ""] {
        set_terminal(&conn, terminal);
        for requested in [
            Requested::Resume,
            Requested::BeginCollection,
            Requested::Complete(external_evidence(2_500)),
            Requested::Cancel("changed scope".into()),
        ] {
            let refused = plan_step(&conn, &key, &requested, true, Utc::now()).unwrap_err();
            assert_eq!(refused["code"], "FUNDING_SCOPE_CHANGED");
            assert!(refused.get("attempt").is_none());
            assert!(!refused.to_string().contains(ORG));
            assert!(!refused.to_string().contains(STAFF));
        }
    }
    let response = funding_reply(&load(&conn, &key), "collection_started");
    let held = finish(&conn, &begin, Ok(&response));
    assert_eq!(held["code"], "FUNDING_SCOPE_CHANGED");
    assert!(held.get("attempt").is_none());
    assert_eq!(load(&conn, &key).state, AttemptState::CollectionStarted);
    let failed = finish(
        &conn,
        &begin,
        Err(&AdminFetchError::transport("held transport error")),
    );
    assert_eq!(failed["code"], "FUNDING_SCOPE_CHANGED");
    assert!(failed.get("attempt").is_none());
    set_terminal(&conn, TERMINAL);
    assert_eq!(
        status_in(&conn, Some(&key)).unwrap()["attempts"][0]["collectionPermitted"],
        false
    );
}

// ---------------------------------------------------------------------------
// Hosted funding availability (advisory private-header status read)
// ---------------------------------------------------------------------------

use super::availability::{
    finish_availability, plan_availability, AvailabilityPlan, AvailabilityRequest,
};

fn availability_request(staff: &str, authority: &str) -> AvailabilityRequest {
    AvailabilityRequest::parse(&json!({ "staffId": staff, "authority": authority }))
        .expect("valid availability request")
}

#[tokio::test]
async fn root_availability_pins_authority_before_endpoint_resolution() {
    let _serial = opening::hosted_auth_test_serial();
    for clear in [true, false] {
        opening::clear_authorizations();
        let conn = test_conn();
        let original = usable_original(&conn, STAFF);
        let db = crate::db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: PathBuf::new(),
        };
        let payload = json!({ "staffId": STAFF, "authority": "cashier" });
        let held_endpoint = async {
            tokio::task::yield_now().await;
            if clear {
                opening::clear_authorizations();
                opening::install_hosted_cashier_for_test(&original, 3_600);
            } else {
                set_terminal(&db.conn.lock().unwrap(), OTHER_TERMINAL);
            }
            // No keychain, credentials or HTTP: even a failed resolution must respect the original fence.
            Err(AdminFetchError::transport(
                "endpoint unavailable after held resolution",
            ))
        };
        let answer = availability::read_availability_with_endpoint(&db, &payload, held_endpoint)
            .await
            .unwrap();
        assert_eq!(answer["success"], false);
        assert_eq!(
            answer["code"],
            if clear {
                "HOSTED_AUTHORIZATION_SUPERSEDED"
            } else {
                "FUNDING_SCOPE_CHANGED"
            }
        );
        for field in ["availability", "attempt", "staffId", "organizationId"] {
            assert!(answer.get(field).is_none());
        }
        assert_eq!(count_attempts(&db.conn.lock().unwrap()), 0);
    }
}

/// The exact `GET /api/pos/gift-cards/status` body of `status/route.ts` with
/// `funding-readiness.ts` for an enabled EUR store whose session of `staff`
/// holds the collection permission but not the grant permission.
fn status_reply(staff: &str) -> Value {
    json!({
        "success": true,
        "configured": true,
        "enabled": true,
        "unavailable": false,
        "gift_cards": {
            "configured": true,
            "enabled": true,
            "unavailable": false,
            "module_enabled": true,
            "terminal_enabled": true,
            "currency": "EUR",
            "configuration_required": null,
            "payment_contract": "atomic_v1",
            "supports_lookup": true,
            "supports_issue": false,
            "supports_reload": false,
            "supports_redeem": true,
            "supports_manual_deduction": false,
            "supports_history": true,
            "supports_return": true,
            "operator": {
                "staff_session_required": true,
                "ready": true,
                "reason": null,
                "staff_id": staff,
                "capabilities": { "return_payments": true },
            },
            "funding": {
                "contract": FUNDING_CONTRACT,
                "configured": true,
                "staff_session_required": true,
                "modes": {
                    "cash_confirmed": { "supported": true, "ready": false, "reason": "ACCOUNTING_INTEGRATION_REQUIRED" },
                    "external_card_recorded": { "supported": true, "ready": true, "reason": "" },
                    "manager_grant": { "supported": true, "ready": false, "reason": "OPERATOR_OR_FUNDING_UNAVAILABLE" },
                    "verified_capture": { "supported": false, "ready": false, "reason": "VERIFIED_CAPTURE_UNAVAILABLE" },
                },
                "collection_permission": "pos.payments.process",
                "grant_permission": "pos.gift_cards.grant",
                "verified_capture": false,
                "fiscal_receipt": false,
            },
        },
    })
}

const STORE_CURRENCY_TEXT: &str = "Set the store currency before selling gift cards";

/// The route's reply without a store currency: its actual code, its message
/// in `error`, and the early funding result (unconfigured, nothing ready).
fn configuration_required_reply(staff: &str) -> Value {
    let mut body = status_reply(staff);
    body["error"] = json!(STORE_CURRENCY_TEXT);
    let gift = &mut body["gift_cards"];
    gift["currency"] = Value::Null;
    gift["configuration_required"] = json!("GIFT_CARD_CURRENCY_NOT_CONFIGURED");
    gift["supports_redeem"] = json!(false);
    gift["funding"]["configured"] = json!(false);
    gift["funding"]["modes"]["external_card_recorded"] =
        json!({ "supported": true, "ready": false, "reason": "OPERATOR_OR_FUNDING_UNAVAILABLE" });
    body
}

/// `base` with the value at `pointer` replaced, or removed for `None`.
fn edited(base: &Value, pointer: &str, value: Option<Value>) -> Value {
    let mut body = base.clone();
    let (parent, key) = pointer.rsplit_once('/').expect("json pointer");
    let target = body
        .pointer_mut(parent)
        .and_then(Value::as_object_mut)
        .expect("object parent");
    match value {
        Some(value) => {
            target.insert(key.to_string(), value);
        }
        None => {
            target.remove(key);
        }
    }
    body
}

fn availability_refusal(conn: &Connection, plan: &AvailabilityPlan, body: &Value) -> String {
    finish_availability(conn, plan, Ok(body), Utc::now())
        .expect_err("never adopted")
        .code
}

#[test]
fn availability_request_is_strict_and_carries_no_credential_url_or_scope() {
    assert!(AvailabilityRequest::parse(
        &json!({ "staffId": STAFF.to_uppercase(), "authority": "cashier" })
    )
    .is_ok());
    for payload in [
        json!({ "staffId": STAFF, "authority": "cashier", "staffSessionId": FOREIGN_ID }),
        json!({ "staffId": STAFF, "authority": "manager", "pin": "482915" }),
        json!({ "staffId": STAFF, "authority": "cashier", "headers": { "x-staff-session-id": FOREIGN_ID } }),
        json!({ "staffId": STAFF, "authority": "cashier", "url": "https://admin.example/api/pos/gift-cards/status" }),
        json!({ "staffId": STAFF, "authority": "cashier", "organizationId": ORG }),
        json!({ "staffId": STAFF, "authority": "owner" }),
        json!({ "staffId": STAFF, "authority": "Cashier" }),
        json!({ "staffId": "not-a-uuid", "authority": "manager" }),
        json!({ "staffId": STAFF }),
        json!({ "authority": "cashier" }),
        json!([STAFF, "cashier"]),
    ] {
        assert!(AvailabilityRequest::parse(&payload).is_err(), "{payload}");
    }
}

#[test]
fn availability_sends_only_the_selected_cashier_or_the_separately_authorized_manager() {
    let _serial = opening::hosted_auth_test_serial();
    opening::clear_authorizations();
    let conn = test_conn();
    let now = Utc::now();
    usable_original(&conn, STAFF);
    let cashier_session =
        opening::scoped_hosted_cashier(&conn, &cashier_scope(&scope(), STAFF), now)
            .expect("live hosted cashier")
            .staff_session_header()
            .to_string();

    // The selected cashier: its usable original and its own hosted session.
    let cashier = plan_availability(&conn, &availability_request(STAFF, "cashier"), now)
        .expect("cashier plan");
    assert_eq!(cashier.staff_session, cashier_session);
    assert!(cashier.opening_key.is_some());
    assert!(
        !format!("{cashier:?}").contains(&cashier_session),
        "Debug never shows the session"
    );
    let published = finish_availability(&conn, &cashier, Ok(&status_reply(STAFF)), now)
        .expect("cashier availability");
    assert_eq!(published["availability"]["authority"], "cashier");
    assert_eq!(
        published["availability"]["modes"]["external_card_recorded"],
        json!({ "supported": true, "ready": true, "reason": null })
    );
    assert!(!published.to_string().contains(&cashier_session));

    // Neither authority substitutes for the other.
    let refused =
        plan_availability(&conn, &availability_request(STAFF, "manager"), now).unwrap_err();
    assert_eq!(refused.code, "MANAGER_AUTHORIZATION_REQUIRED");
    authorize_manager_for_test();
    let refused =
        plan_availability(&conn, &availability_request(MANAGER, "cashier"), now).unwrap_err();
    assert_eq!(refused.code, "FINANCIAL_OPENING_REQUIRED");

    // The separately authorized manager's own grant session.
    let manager = plan_availability(&conn, &availability_request(MANAGER, "manager"), now)
        .expect("manager plan");
    assert_eq!(
        (
            manager.staff_session.as_str(),
            manager.opening_key.as_deref()
        ),
        (MANAGER_SESSION, None)
    );
    assert!(!format!("{manager:?}").contains(MANAGER_SESSION));
    let mut reply = status_reply(MANAGER);
    reply["gift_cards"]["funding"]["modes"]["manager_grant"] =
        json!({ "supported": true, "ready": true, "reason": "" });
    reply["error"] = json!("server diagnostic text");
    let published =
        finish_availability(&conn, &manager, Ok(&reply), now).expect("manager availability");
    assert_eq!(
        published,
        json!({
            "success": true,
            "availability": {
                "staffId": MANAGER,
                "authority": "manager",
                "organizationId": ORG,
                "branchId": BRANCH,
                "terminalId": TERMINAL,
                "configured": true,
                "enabled": true,
                "unavailable": false,
                "currency": "EUR",
                "configurationRequired": null,
                "fundingConfigured": true,
                "modes": {
                    "cash_confirmed": { "supported": true, "ready": false, "reason": "ACCOUNTING_INTEGRATION_REQUIRED" },
                    "external_card_recorded": { "supported": true, "ready": true, "reason": null },
                    "manager_grant": { "supported": true, "ready": true, "reason": null },
                    "verified_capture": { "supported": false, "ready": false, "reason": "VERIFIED_CAPTURE_UNAVAILABLE" },
                },
                "operator": { "ready": true, "reason": null, "returnPayments": true },
                "verifiedCapture": false,
                "fiscalReceipt": false,
            },
        })
    );
}

#[test]
fn availability_consumes_no_grant_writes_nothing_and_keeps_begin_single() {
    let _serial = opening::hosted_auth_test_serial();
    opening::clear_authorizations();
    let conn = test_conn();
    let key = root_prepared_external(&conn);
    authorize_manager_for_test();
    let begin = plan(&conn, &key, Requested::BeginCollection);
    let outside = outside_journal(&conn);
    let journal = table_rows(&conn, "gift_card_funding_attempts");
    let status = status_in(&conn, None).unwrap();

    for (staff, authority) in [
        (STAFF, "cashier"),
        (MANAGER, "manager"),
        (MANAGER, "manager"),
    ] {
        let read = plan_availability(&conn, &availability_request(staff, authority), Utc::now())
            .expect("plan");
        let published = finish_availability(&conn, &read, Ok(&status_reply(staff)), Utc::now())
            .expect("published");
        assert_eq!(published["availability"]["staffId"], staff);
        let failed = finish_availability(
            &conn,
            &read,
            Err(&AdminFetchError::with_status("unavailable", 503)),
            Utc::now(),
        );
        assert_eq!(failed.unwrap_err().code, "AVAILABILITY_READ_FAILED");
    }
    assert_eq!(
        outside_journal(&conn),
        outside,
        "no opening, shift, drawer, queue or setting row"
    );
    assert_eq!(
        table_rows(&conn, "gift_card_funding_attempts"),
        journal,
        "no attempt row"
    );
    assert_eq!(
        status_in(&conn, None).unwrap(),
        status,
        "the local journal status is unchanged"
    );

    // The begin planned before the reads still permits collection exactly once.
    let started = funding_reply(&load(&conn, &key), "collection_started");
    assert_eq!(
        finish(&conn, &begin, Ok(&started))["attempt"]["collectionPermitted"],
        true
    );
    match plan_step(&conn, &key, &Requested::BeginCollection, true, Utc::now()).unwrap() {
        Planned::Settled(attempt) => assert_eq!(
            attempt_response(&attempt, None)["attempt"]["collectionPermitted"],
            false
        ),
        Planned::Send(_) => panic!("acknowledged begin must not send again"),
    }
    assert_eq!(
        status_in(&conn, Some(&key)).unwrap()["attempts"][0]["collectionPermitted"],
        false
    );

    // Reading consumed no grant: the same manager authority still records a
    // grant (in a journal without the cashier's open attempt).
    assert_eq!(
        grant_session(&scope(), MANAGER, Utc::now()).unwrap(),
        MANAGER_SESSION
    );
    let grant = FundingRequest::parse(&grant_request(700), true).unwrap();
    assert!(open_grant_attempt(&test_conn(), &grant, Utc::now()).is_ok());
}

#[test]
fn availability_refuses_missing_or_expired_authority_before_any_transport() {
    let _serial = opening::hosted_auth_test_serial();
    opening::clear_authorizations();
    let now = Utc::now();
    let code = |conn: &Connection, staff: &str, authority: &str, at: DateTime<Utc>| {
        plan_availability(conn, &availability_request(staff, authority), at)
            .unwrap_err()
            .code
    };

    // No trusted terminal scope.
    let unscoped = Connection::open_in_memory().expect("open in-memory db");
    crate::db::run_migrations_for_test(&unscoped);
    assert_eq!(
        code(&unscoped, STAFF, "cashier", now),
        "TERMINAL_SCOPE_UNAVAILABLE"
    );
    assert_eq!(
        code(&unscoped, MANAGER, "manager", now),
        "TERMINAL_SCOPE_UNAVAILABLE"
    );

    // No original and no manager authority.
    let conn = test_conn();
    assert_eq!(
        code(&conn, STAFF, "cashier", now),
        "FINANCIAL_OPENING_REQUIRED"
    );
    assert_eq!(
        code(&conn, MANAGER, "manager", now),
        "MANAGER_AUTHORIZATION_REQUIRED"
    );

    // An expired hosted cashier session is dropped; the dedicated clear needs a new PIN.
    let intent = usable_original(&conn, STAFF);
    assert_eq!(
        code(&conn, STAFF, "cashier", now + chrono::Duration::hours(2)),
        "HOSTED_SESSION_EXPIRED"
    );
    assert_eq!(
        code(&conn, STAFF, "cashier", now),
        opening::CODE_REAUTH_REQUIRED
    );
    opening::install_hosted_cashier_for_test(&intent, 3_600);
    opening::clear_authorizations();
    assert_eq!(
        code(&conn, STAFF, "cashier", now),
        opening::CODE_REAUTH_REQUIRED
    );

    // An expired manager authority is dropped.
    authorize_manager_for_test();
    let late = Utc::now() + chrono::Duration::seconds(GRANT_AUTHORITY_SECS + 1);
    assert_eq!(
        code(&conn, MANAGER, "manager", late),
        "MANAGER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(
        code(&conn, MANAGER, "manager", Utc::now()),
        "MANAGER_AUTHORIZATION_REQUIRED"
    );
    assert_eq!(count_attempts(&conn), 0);
}

#[test]
fn availability_publishes_nothing_held_across_a_clear_scope_or_authority_change() {
    let _serial = opening::hosted_auth_test_serial();
    opening::clear_authorizations();
    let conn = test_conn();
    let intent = usable_original(&conn, STAFF);
    let cashier = availability_request(STAFF, "cashier");
    let ok = status_reply(STAFF);
    let failure = AdminFetchError::transport("held transport error");
    let refused = |plan: &AvailabilityPlan, reply: Result<&Value, &AdminFetchError>| {
        let value = finish_availability(&conn, plan, reply, Utc::now())
            .expect_err("nothing held is published")
            .to_value(None);
        assert!(value.get("availability").is_none() && value.get("attempt").is_none());
        for private in [STAFF, ORG, BRANCH, TERMINAL] {
            assert!(!value.to_string().contains(private), "{private} in {value}");
        }
        value["code"].as_str().expect("refusal code").to_string()
    };

    // The dedicated clear fences a held success or error, even after a fresh PIN.
    for reply in [Ok(&ok), Err(&failure)] {
        let held = plan_availability(&conn, &cashier, Utc::now()).unwrap();
        opening::clear_authorizations();
        opening::install_hosted_cashier_for_test(&intent, 3_600);
        assert_eq!(refused(&held, reply), "HOSTED_AUTHORIZATION_SUPERSEDED");
    }

    // A changed or missing trusted scope; the same plan publishes once it is back.
    let held = plan_availability(&conn, &cashier, Utc::now()).unwrap();
    for terminal in [OTHER_TERMINAL, ""] {
        set_terminal(&conn, terminal);
        for reply in [Ok(&ok), Err(&failure)] {
            let code = refused(&held, reply);
            assert!(
                code == "FUNDING_SCOPE_CHANGED" || code == "TERMINAL_SCOPE_UNAVAILABLE",
                "{code}"
            );
        }
    }
    set_terminal(&conn, TERMINAL);
    assert_eq!(
        finish_availability(&conn, &held, Ok(&ok), Utc::now()).unwrap()["availability"]["staffId"],
        STAFF
    );

    // The cashier's hosted session expired while held.
    let late = Utc::now() + chrono::Duration::hours(2);
    let expired = finish_availability(&conn, &held, Ok(&ok), late)
        .expect_err("an expired session never answers");
    assert_eq!(expired.code, "HOSTED_SESSION_EXPIRED");

    // The manager re-authorized (a different session) or expired while held.
    authorize_manager_for_test();
    let manager = availability_request(MANAGER, "manager");
    let held = plan_availability(&conn, &manager, Utc::now()).unwrap();
    let now = Utc::now();
    install_grant_authority(
        capture_fence(),
        &scope(),
        MANAGER,
        FOREIGN_ID,
        now + chrono::Duration::hours(8),
        now,
    )
    .expect("re-authorized manager");
    assert_eq!(
        refused(&held, Ok(&status_reply(MANAGER))),
        "HOSTED_AUTHORIZATION_CHANGED"
    );
    let held = plan_availability(&conn, &manager, Utc::now()).unwrap();
    let late = Utc::now() + chrono::Duration::seconds(GRANT_AUTHORITY_SECS + 1);
    let expired = finish_availability(&conn, &held, Ok(&status_reply(MANAGER)), late).unwrap_err();
    assert_eq!(expired.code, "MANAGER_AUTHORIZATION_REQUIRED");
}

#[test]
fn availability_parser_refuses_malformed_partial_contradictory_or_foreign_replies() {
    let _serial = opening::hosted_auth_test_serial();
    opening::clear_authorizations();
    let conn = test_conn();
    usable_original(&conn, STAFF);
    let plan =
        plan_availability(&conn, &availability_request(STAFF, "cashier"), Utc::now()).unwrap();
    let base = status_reply(STAFF);
    let not_ready_operator = json!({
        "staff_session_required": true,
        "ready": false,
        "reason": "STAFF_SESSION_EXPIRED",
        "staff_id": null,
        "capabilities": { "return_payments": false },
    });
    let cases = [
        ("/success", Some(json!(false))),
        ("/gift_cards", None),
        ("/enabled", Some(json!(false))),
        ("/gift_cards/enabled", Some(json!("true"))),
        ("/gift_cards/unavailable", None),
        ("/gift_cards/currency", Some(json!("eur"))),
        ("/gift_cards/currency", None),
        (
            "/gift_cards/configuration_required",
            Some(json!("Set a store currency first")),
        ),
        (
            "/gift_cards/configuration_required",
            Some(json!("GIFT_CARD_CURRENCY_NOT_CONFIGURED")),
        ),
        ("/gift_cards/funding", None),
        (
            "/gift_cards/funding/contract",
            Some(json!("gift_funding_v2")),
        ),
        ("/gift_cards/funding/configured", Some(json!(false))),
        ("/gift_cards/funding/staff_session_required", None),
        ("/gift_cards/funding/verified_capture", Some(json!(true))),
        ("/gift_cards/funding/fiscal_receipt", None),
        ("/gift_cards/funding/modes", Some(json!([]))),
        ("/gift_cards/funding/modes/manager_grant", None),
        (
            "/gift_cards/funding/modes/external_card_recorded/reason",
            None,
        ),
        (
            "/gift_cards/funding/modes/external_card_recorded/ready",
            Some(json!("true")),
        ),
        (
            "/gift_cards/funding/modes/external_card_recorded/reason",
            Some(json!("OPERATOR_OR_FUNDING_UNAVAILABLE")),
        ),
        (
            "/gift_cards/funding/modes/external_card_recorded/supported",
            Some(json!(false)),
        ),
        (
            "/gift_cards/funding/modes/cash_confirmed/reason",
            Some(json!("")),
        ),
        (
            "/gift_cards/funding/modes/cash_confirmed/reason",
            Some(json!("accounting integration required")),
        ),
        (
            "/gift_cards/funding/modes/verified_capture/supported",
            Some(json!(true)),
        ),
        ("/gift_cards/operator", None),
        ("/gift_cards/operator", Some(not_ready_operator.clone())),
        ("/gift_cards/operator/staff_id", Some(Value::Null)),
        (
            "/gift_cards/operator/reason",
            Some(json!("STAFF_SESSION_EXPIRED")),
        ),
        ("/gift_cards/operator/capabilities", None),
    ];
    for (pointer, value) in cases {
        let body = edited(&base, pointer, value.clone());
        assert_eq!(
            availability_refusal(&conn, &plan, &body),
            "AVAILABILITY_REPLY_INVALID",
            "{pointer} {value:?}"
        );
    }
    let disabled = edited(
        &edited(&base, "/enabled", Some(json!(false))),
        "/gift_cards/enabled",
        Some(json!(false)),
    );
    assert_eq!(
        availability_refusal(&conn, &plan, &disabled),
        "AVAILABILITY_REPLY_INVALID"
    );
    assert_eq!(
        availability_refusal(&conn, &plan, &json!([])),
        "AVAILABILITY_REPLY_INVALID"
    );

    // A session reported for other staff adopts nothing; the same UUID in any case does.
    let foreign = edited(
        &base,
        "/gift_cards/operator/staff_id",
        Some(json!(FOREIGN_ID)),
    );
    assert_eq!(
        availability_refusal(&conn, &plan, &foreign),
        "HOSTED_STAFF_MISMATCH"
    );
    let same = edited(
        &base,
        "/gift_cards/operator/staff_id",
        Some(json!(STAFF.to_uppercase())),
    );
    assert!(finish_availability(&conn, &plan, Ok(&same), Utc::now()).is_ok());

    // A not-ready operator with nothing ready is an answer, with or without its staff.
    let not_ready = edited(
        &edited(&base, "/gift_cards/operator", Some(not_ready_operator)),
        "/gift_cards/funding/modes/external_card_recorded",
        Some(
            json!({ "supported": true, "ready": false, "reason": "OPERATOR_OR_FUNDING_UNAVAILABLE" }),
        ),
    );
    let published = finish_availability(&conn, &plan, Ok(&not_ready), Utc::now())
        .expect("not ready is an answer");
    assert_eq!(
        published["availability"]["operator"],
        json!({ "ready": false, "reason": "STAFF_SESSION_EXPIRED", "returnPayments": false })
    );
    assert!(published["availability"]["modes"]
        .as_object()
        .unwrap()
        .values()
        .all(|mode| mode["ready"] == false));
    let forbidden = edited(
        &not_ready,
        "/gift_cards/operator/staff_id",
        Some(json!(STAFF)),
    );
    assert!(finish_availability(&conn, &plan, Ok(&forbidden), Utc::now()).is_ok());
    let foreign = edited(
        &not_ready,
        "/gift_cards/operator/staff_id",
        Some(json!(FOREIGN_ID)),
    );
    assert_eq!(
        availability_refusal(&conn, &plan, &foreign),
        "HOSTED_STAFF_MISMATCH"
    );
    // Unknown extra modes and unread fields are ignored, never projected.
    let extra = edited(
        &base,
        "/gift_cards/funding/modes/bank_transfer",
        Some(json!({ "supported": true, "ready": true, "reason": "" })),
    );
    let published = finish_availability(&conn, &plan, Ok(&extra), Utc::now()).unwrap();
    assert!(published["availability"]["modes"]
        .get("bank_transfer")
        .is_none());
}

#[test]
fn availability_reports_the_actual_store_currency_requirement_without_server_text() {
    let _serial = opening::hosted_auth_test_serial();
    opening::clear_authorizations();
    let conn = test_conn();
    usable_original(&conn, STAFF);
    let plan =
        plan_availability(&conn, &availability_request(STAFF, "cashier"), Utc::now()).unwrap();

    let published = finish_availability(
        &conn,
        &plan,
        Ok(&configuration_required_reply(STAFF)),
        Utc::now(),
    )
    .expect("configuration required is a valid answer");
    let view = &published["availability"];
    assert_eq!(view["currency"], Value::Null);
    assert_eq!(
        view["configurationRequired"],
        "GIFT_CARD_CURRENCY_NOT_CONFIGURED"
    );
    assert_eq!(view["fundingConfigured"], false);
    assert!(view["modes"]
        .as_object()
        .unwrap()
        .values()
        .all(|mode| mode["ready"] == false));
    assert_eq!(
        view["modes"]["cash_confirmed"],
        json!({ "supported": true, "ready": false, "reason": "ACCOUNTING_INTEGRATION_REQUIRED" })
    );
    assert!(
        !published.to_string().contains(STORE_CURRENCY_TEXT),
        "server text is never projected"
    );

    let unreadable = edited(
        &configuration_required_reply(STAFF),
        "/gift_cards/configuration_required",
        Some(json!("GIFT_CARD_CURRENCY_UNAVAILABLE")),
    );
    let published = finish_availability(&conn, &plan, Ok(&unreadable), Utc::now()).unwrap();
    assert_eq!(
        published["availability"]["configurationRequired"],
        "GIFT_CARD_CURRENCY_UNAVAILABLE"
    );
}
