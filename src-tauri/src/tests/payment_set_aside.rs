//! Payments set aside for review: end-to-end regressions (B1, fix review
//! 30/09/2026; Android 1.0.13 parity).
//!
//! Symptom: a 13.00 cash payment on an order another terminal had already
//! charged 13.00 by card. `POST /api/pos/payments` answered `200 {
//! already_paid: true, payment_id: <the card> }` WITHOUT recording the cash;
//! the desktop linked its cash row to the card's server id. The Z counted
//! cash where the server counted card, the mirror never brought the card, and
//! the double charge was invisible.
//!
//! Every test here drives an entry point that existed before the fix
//! (`sync_queue::process_queue`, the legacy `sync_payment_items`,
//! `sync::capture_unsynced_sync_queue_snapshot`,
//! `zreport::unsettled_payment_blockers`, `zreport::submit_z_report`,
//! `payments::record_payment`) and asserts only through SQL and JSON, so the
//! same file compiles against the unfixed code and fails there.

use rusqlite::params;
use serde_json::{json, Value};

use crate::tests::fake_http::MockServer;
use crate::tests::fake_keyring;
use crate::tests::harness::TestDb;

const TERMINAL_ID: &str = "terminal-set-aside";
const BRANCH_ID: &str = "11111111-2222-4333-8444-555555555555";
const ORGANIZATION_ID: &str = "99999999-8888-4777-8666-555555555555";
const LOCAL_ORDER_ID: &str = "ord-set-aside";
const REMOTE_ORDER_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOCAL_CASH_PAYMENT_ID: &str = "pay-local-cash";
/// The OTHER terminal's card payment that really paid the order.
const SERVER_CARD_PAYMENT_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/// What the server answers when the order is already paid by the card: the
/// cash is NOT recorded, and `payment_id` names the card. The same body also
/// carries the order's server ledger, for the `GET /api/pos/payments` mirror.
fn already_paid_answer() -> String {
    json!({
        "success": true,
        "already_paid": true,
        "payment_id": SERVER_CARD_PAYMENT_ID,
        "order_id": REMOTE_ORDER_ID,
        "payment_status": "paid",
        "payment_method": "card",
        "payments": [{
            "id": SERVER_CARD_PAYMENT_ID,
            "order_id": REMOTE_ORDER_ID,
            "payment_method": "card",
            "amount": 13.0,
            "amount_cents": 1300,
            "currency": "EUR",
            "status": "completed",
            "created_at": "2026-09-30T10:04:00Z",
            "updated_at": "2026-09-30T10:04:00Z",
            "metadata": {
                "terminal_id": "android-terminal",
                "local_payment_id": "android-local-card"
            }
        }]
    })
    .to_string()
}

fn seed_terminal(conn: &rusqlite::Connection) {
    crate::db::set_setting(conn, "terminal", "__ignore_keyring", "1").unwrap();
    crate::db::set_setting(conn, "terminal", "terminal_id", TERMINAL_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "branch_id", BRANCH_ID).unwrap();
    crate::db::set_setting(conn, "terminal", "organization_id", ORGANIZATION_ID).unwrap();
}

/// A 13.00 order, completed and paid, with the local 13.00 cash payment that
/// was taken on this terminal and is about to be sent.
fn seed_order_with_local_cash(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO orders (
             id, order_number, supabase_id, items, total_amount, total_amount_cents,
             status, payment_status, sync_status, branch_id, terminal_id,
             created_at, updated_at
         ) VALUES (?1, 'A-0042', ?2, '[]', 13.0, 1300, 'completed', 'paid', 'synced', ?3, ?4,
                   '2026-09-30T10:00:00Z', '2026-09-30T10:06:00Z')",
        params![LOCAL_ORDER_ID, REMOTE_ORDER_ID, BRANCH_ID, TERMINAL_ID],
    )
    .expect("seed order");
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status,
             cash_received, change_given, sync_status, sync_state, created_at, updated_at
         ) VALUES (?1, ?2, 'cash', 13.0, 1300, 'EUR', 'completed', 13.0, 0,
                   'pending', 'pending', '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![LOCAL_CASH_PAYMENT_ID, LOCAL_ORDER_ID],
    )
    .expect("seed local cash payment");
}

fn cash_payload() -> String {
    json!({
        "paymentId": LOCAL_CASH_PAYMENT_ID,
        "orderId": LOCAL_ORDER_ID,
        "method": "cash",
        "amount": 13.0,
        "amount_cents": 1300,
        "currency": "EUR",
        "paymentOrigin": "manual",
    })
    .to_string()
}

fn enqueue_cash_on_parity_queue(conn: &rusqlite::Connection) {
    crate::sync::upsert_payment_sync_queue_row(
        conn,
        LOCAL_CASH_PAYMENT_ID,
        &cash_payload(),
        "pending",
        0,
        None,
        None,
        None,
        "2026-09-30T10:05:00Z",
    )
    .expect("enqueue the cash payment on the parity queue");
}

fn enqueue_cash_on_legacy_queue(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO sync_queue (
             entity_type, entity_id, operation, payload, idempotency_key, status,
             retry_count, max_retries, created_at, updated_at
         ) VALUES ('payment', ?1, 'insert', ?2, ?3, 'pending', 0, 5,
                   '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
        params![
            LOCAL_CASH_PAYMENT_ID,
            cash_payload(),
            format!("payment:{LOCAL_CASH_PAYMENT_ID}")
        ],
    )
    .expect("enqueue the cash payment on the legacy queue");
}

#[derive(Debug)]
struct PaymentRow {
    status: String,
    method: String,
    amount_cents: i64,
    remote_payment_id: Option<String>,
}

fn payment_row(conn: &rusqlite::Connection, payment_id: &str) -> PaymentRow {
    conn.query_row(
        "SELECT status, method, COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER)),
                remote_payment_id
         FROM order_payments WHERE id = ?1",
        params![payment_id],
        |row| {
            Ok(PaymentRow {
                status: row.get(0)?,
                method: row.get(1)?,
                amount_cents: row.get(2)?,
                remote_payment_id: row.get(3)?,
            })
        },
    )
    .expect("load payment row")
}

fn completed_money(conn: &rusqlite::Connection) -> Vec<(String, i64, Option<String>)> {
    let mut statement = conn
        .prepare(
            "SELECT method, COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER)),
                    remote_payment_id
             FROM order_payments
             WHERE order_id = ?1 AND status = 'completed'
             ORDER BY method",
        )
        .unwrap();
    statement
        .query_map(params![LOCAL_ORDER_ID], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn metadata_of(conn: &rusqlite::Connection, payment_id: &str) -> Value {
    // `metadata` arrives with the fix (v90): on the unfixed schema this query
    // fails, which is the regression failing, not the test being wrong.
    let raw: Option<String> = conn
        .query_row(
            "SELECT metadata FROM order_payments WHERE id = ?1",
            params![payment_id],
            |row| row.get(0),
        )
        .expect("order_payments.metadata");
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null)
}

/// Put the v36 status CHECK back, as on a terminal where v90 met an unknown
/// CHECK and left it unchanged: `duplicate_review` cannot be stored.
fn narrow_order_payment_status_check(conn: &rusqlite::Connection) {
    let version: i64 = conn
        .query_row("PRAGMA schema_version", [], |row| row.get(0))
        .unwrap();
    conn.execute_batch("PRAGMA writable_schema = ON").unwrap();
    conn.execute(
        "UPDATE sqlite_master
         SET sql = replace(sql, ?1, ?2)
         WHERE type = 'table' AND name = 'order_payments'",
        params![
            "CHECK (status IN ('completed', 'voided', 'refunded', 'duplicate_review'))",
            "CHECK (status IN ('completed', 'voided', 'refunded'))"
        ],
    )
    .unwrap();
    conn.execute_batch(&format!("PRAGMA schema_version = {}", version + 1))
        .unwrap();
    conn.execute_batch("PRAGMA writable_schema = OFF").unwrap();
}

fn parity_rows_for(conn: &rusqlite::Connection, payment_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM parity_sync_queue WHERE record_id = ?1",
        params![payment_id],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn parity_already_paid_sets_the_cash_aside_instead_of_linking_it_to_the_card() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_order_with_local_cash(&conn);
        enqueue_cash_on_parity_queue(&conn);
    }
    let server = MockServer::new(already_paid_answer());

    let result = crate::sync_queue::process_queue(&td.state.conn, &server.url, "api-key")
        .await
        .expect("the parity queue processes the answer");
    assert_eq!(result.failed, 0, "an already-paid answer is not a failure");
    let posts: Vec<_> = server
        .recorded()
        .into_iter()
        .filter(|request| request.method == "POST" && request.path == "/api/pos/payments")
        .collect();
    assert_eq!(posts.len(), 1, "the cash was sent once");
    assert_eq!(
        crate::sync::capture_unsynced_sync_queue_snapshot(&td.state)
            .unwrap()
            .count,
        0,
        "the day close never waits on it as pending or failed"
    );

    let conn = td.state.conn.lock().unwrap();
    let cash = payment_row(&conn, LOCAL_CASH_PAYMENT_ID);
    assert_eq!(
        cash.remote_payment_id, None,
        "the cash must never become the local stand-in of the card"
    );
    assert_eq!(cash.status, "duplicate_review", "the cash is set aside");
    assert_eq!(
        (cash.method.as_str(), cash.amount_cents),
        ("cash", 1300),
        "amount and tender are kept exactly as recorded"
    );
    let metadata = metadata_of(&conn, LOCAL_CASH_PAYMENT_ID);
    let review = &metadata["duplicate_review"];
    assert_eq!(review["reason"], "already_paid");
    assert_eq!(review["server_payment_id"], SERVER_CARD_PAYMENT_ID);
    assert_eq!(review["previous_sync_state"], "syncing");
    assert!(review["detected_at"].as_str().is_some());
    assert_eq!(
        parity_rows_for(&conn, LOCAL_CASH_PAYMENT_ID),
        0,
        "its queue row is closed: it is never re-sent"
    );
    assert_eq!(
        crate::payments::load_net_paid_for_order(&conn, LOCAL_ORDER_ID).unwrap(),
        0.0,
        "the set-aside cash is money nowhere"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn legacy_already_paid_sets_the_cash_aside_and_mirrors_the_card_once() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_order_with_local_cash(&conn);
        enqueue_cash_on_legacy_queue(&conn);
    }
    let server = MockServer::new(already_paid_answer());

    let synced = crate::sync::dispatch_pending_payments_for_test(
        &server.url,
        "api-key",
        TERMINAL_ID,
        &td.state,
    )
    .await;
    assert_eq!(synced, 1, "the answer finishes the cash's sync");
    assert_eq!(
        crate::sync::capture_unsynced_sync_queue_snapshot(&td.state)
            .unwrap()
            .count,
        0,
        "the day close never waits on it as pending or failed"
    );

    let conn = td.state.conn.lock().unwrap();
    let cash = payment_row(&conn, LOCAL_CASH_PAYMENT_ID);
    assert_eq!(cash.remote_payment_id, None, "never linked to the card");
    assert_eq!(cash.status, "duplicate_review");
    assert_eq!((cash.method.as_str(), cash.amount_cents), ("cash", 1300));

    // The order keeps the money the server holds, counted once: the card,
    // mirrored as its own row.
    assert_eq!(
        completed_money(&conn),
        vec![(
            "card".to_string(),
            1300,
            Some(SERVER_CARD_PAYMENT_ID.to_string())
        )],
        "only the card counts, exactly once"
    );
    let carriers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE remote_payment_id = ?1",
            params![SERVER_CARD_PAYMENT_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(carriers, 1, "one server payment, one local row");
    assert_eq!(
        crate::payments::derive_payment_method(&conn, LOCAL_ORDER_ID).unwrap(),
        Some("card".to_string())
    );
    let queue_status: String = conn
        .query_row(
            "SELECT status FROM sync_queue WHERE entity_id = ?1",
            params![LOCAL_CASH_PAYMENT_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queue_status, "synced", "the legacy row is closed");
}

/// The other order of events: the card was mirrored first (incremental pull),
/// then the cash went out. Before the fix the link hit the card's unique
/// server id and failed, so the cash stayed completed next to the card and
/// the order held 26.00 locally.
#[tokio::test(flavor = "current_thread")]
async fn parity_already_paid_after_the_card_was_mirrored_counts_the_order_once() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_order_with_local_cash(&conn);
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, currency, status,
                 sync_status, sync_state, remote_payment_id, payment_origin,
                 created_at, updated_at
             ) VALUES ('pay-mirrored-card', ?1, 'card', 13.0, 1300, 'EUR', 'completed',
                       'synced', 'applied', ?2, 'sync_reconstructed',
                       '2026-09-30T10:04:00Z', '2026-09-30T10:04:00Z')",
            params![LOCAL_ORDER_ID, SERVER_CARD_PAYMENT_ID],
        )
        .expect("seed the mirrored card");
        enqueue_cash_on_parity_queue(&conn);
    }
    let server = MockServer::new(already_paid_answer());

    let result = crate::sync_queue::process_queue(&td.state.conn, &server.url, "api-key")
        .await
        .expect("the answer is applied, not a failed run");
    assert_eq!(result.failed, 0);

    let conn = td.state.conn.lock().unwrap();
    assert_eq!(
        completed_money(&conn),
        vec![(
            "card".to_string(),
            1300,
            Some(SERVER_CARD_PAYMENT_ID.to_string())
        )],
        "the order holds the card once, not card + cash"
    );
    assert_eq!(
        payment_row(&conn, LOCAL_CASH_PAYMENT_ID).status,
        "duplicate_review"
    );
    assert_eq!(parity_rows_for(&conn, LOCAL_CASH_PAYMENT_ID), 0);
}

/// A terminal whose schema cannot hold the review status (v90 met an unknown
/// status CHECK and left it unchanged): the answer still never links the
/// cash to the card. It is held unsent, unlinked and failed, so the day
/// close names it for support instead of counting it as the card.
#[tokio::test(flavor = "current_thread")]
async fn without_the_review_status_the_payment_is_held_unlinked_never_linked() {
    let _keyring = fake_keyring::install_seeded([("terminal_id", TERMINAL_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        narrow_order_payment_status_check(&conn);
        seed_terminal(&conn);
        seed_order_with_local_cash(&conn);
        enqueue_cash_on_parity_queue(&conn);
    }
    let server = MockServer::new(already_paid_answer());

    crate::sync_queue::process_queue(&td.state.conn, &server.url, "api-key")
        .await
        .expect("the answer is handled");

    let snapshot = crate::sync::capture_unsynced_sync_queue_snapshot(&td.state).unwrap();
    assert_eq!(
        snapshot.count, 1,
        "the day close names it: {}",
        snapshot.blockers_summary
    );
    let conn = td.state.conn.lock().unwrap();
    let cash = payment_row(&conn, LOCAL_CASH_PAYMENT_ID);
    assert_eq!(
        cash.remote_payment_id, None,
        "never the local stand-in of the card"
    );
    assert_eq!(cash.status, "completed", "the schema cannot set it aside");
    assert_eq!(
        parity_rows_for(&conn, LOCAL_CASH_PAYMENT_ID),
        0,
        "not re-sent in a loop"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_z_is_held_by_payments_need_review_listing_each_set_aside_payment() {
    let _keyring =
        fake_keyring::install_seeded([("terminal_id", TERMINAL_ID), ("branch_id", BRANCH_ID)]);
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_terminal(&conn);
        seed_order_with_local_cash(&conn);
        enqueue_cash_on_parity_queue(&conn);
    }
    let server = MockServer::new(already_paid_answer());
    crate::sync_queue::process_queue(&td.state.conn, &server.url, "api-key")
        .await
        .expect("process the answer");

    let payload = json!({ "branchId": BRANCH_ID });
    let blockers = crate::zreport::unsettled_payment_blockers(&td.state, &payload)
        .expect("load the Z blockers");
    let blockers = serde_json::to_value(&blockers).unwrap();
    let review: Vec<&Value> = blockers
        .as_array()
        .unwrap()
        .iter()
        .filter(|blocker| blocker["reasonCode"] == "payments_need_review")
        .collect();
    assert_eq!(
        review.len(),
        1,
        "one blocker per set-aside payment: {blockers}"
    );
    let blocker = review[0];
    assert_eq!(blocker["orderNumber"], "A-0042");
    assert_eq!(blocker["severity"], "blocking");
    assert_eq!(
        blocker["differenceCents"], 0,
        "it names a decision, never money the day is short or over"
    );
    let payment = &blocker["reviewPayment"];
    assert_eq!(payment["paymentId"], LOCAL_CASH_PAYMENT_ID);
    assert_eq!(payment["method"], "cash");
    assert_eq!(payment["amount"], 13.0);
    assert_eq!(payment["amountCents"], 1300);
    assert_eq!(payment["takenAt"], "2026-09-30T10:05:00Z");
    assert_eq!(payment["reason"], "already_paid");

    // The submission refuses on the same blockers (the order also reads
    // "paid without a local row" until the next sync pass mirrors the card).
    let refused = crate::zreport::submit_z_report(&td.state, &payload)
        .expect_err("the day does not close over a set-aside payment");
    assert!(
        refused.starts_with("Cannot generate Z-report"),
        "the payment gate refuses: {refused}"
    );
}

fn seed_order_paid_by_other_money(conn: &rusqlite::Connection, paid_cents: i64) {
    conn.execute(
        "INSERT INTO orders (
             id, order_number, supabase_id, items, total_amount, total_amount_cents,
             status, payment_status, sync_status, created_at, updated_at
         ) VALUES (?1, 'A-0043', ?2, '[]', 13.0, 1300, 'completed', 'paid', 'synced',
                   '2026-09-30T11:00:00Z', '2026-09-30T11:00:00Z')",
        params![LOCAL_ORDER_ID, REMOTE_ORDER_ID],
    )
    .expect("seed order");
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status,
             sync_status, sync_state, remote_payment_id, payment_origin,
             created_at, updated_at
         ) VALUES ('pay-restored', ?1, 'cash', ?2, ?3, 'EUR', 'completed',
                   'synced', 'applied', ?4, 'sync_reconstructed',
                   '2026-09-30T11:01:00Z', '2026-09-30T11:01:00Z')",
        params![
            LOCAL_ORDER_ID,
            paid_cents as f64 / 100.0,
            paid_cents,
            SERVER_CARD_PAYMENT_ID
        ],
    )
    .expect("seed the money that landed during the card interaction");
}

fn approved_card(transaction_ref: &str) -> Value {
    json!({
        "orderId": LOCAL_ORDER_ID,
        "method": "card",
        "amount": 13.0,
        "transactionRef": transaction_ref,
        "paymentOrigin": "terminal",
        "terminalApproved": true,
        "terminalDeviceId": "eft-1",
    })
}

/// A restore landed while the customer was at the card terminal: the
/// approved card must not be refused into thin air.
#[test]
fn an_approved_card_that_finds_the_order_covered_is_recorded_set_aside() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order_paid_by_other_money(&conn, 1300);
    }

    let answer = crate::payments::record_payment(&td.state, &approved_card("txn-approved-1"))
        .expect("money that moved is never refused");
    assert_eq!(answer["success"], false, "it is not a collection");
    assert_eq!(answer["errorCode"], "PAYMENT_SET_ASIDE_FOR_REVIEW");
    assert_eq!(answer["reason"], "order_already_covered");
    let payment_id = answer["paymentId"]
        .as_str()
        .expect("payment id")
        .to_string();

    // A retried answer for the same approval records nothing new.
    let again = crate::payments::record_payment(&td.state, &approved_card("txn-approved-1"))
        .expect("retry");
    assert_eq!(again["paymentId"], payment_id.as_str());

    let conn = td.state.conn.lock().unwrap();
    let row = payment_row(&conn, &payment_id);
    assert_eq!(row.status, "duplicate_review");
    assert_eq!((row.method.as_str(), row.amount_cents), ("card", 1300));
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE transaction_ref = 'txn-approved-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "one approval, one row");
    assert_eq!(
        crate::payments::load_net_paid_for_order(&conn, LOCAL_ORDER_ID).unwrap(),
        13.0,
        "counted nowhere: the order still holds only the money that paid it"
    );
    assert_eq!(
        metadata_of(&conn, &payment_id)["duplicate_review"]["reason"],
        "order_already_covered"
    );
    assert_eq!(parity_rows_for(&conn, &payment_id), 0, "never sent");
}

#[test]
fn an_approved_card_worth_more_than_is_still_due_is_set_aside_whole() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order_paid_by_other_money(&conn, 500);
    }

    let answer = crate::payments::record_payment(&td.state, &approved_card("txn-approved-2"))
        .expect("money that moved is never refused");
    assert_eq!(answer["errorCode"], "PAYMENT_SET_ASIDE_FOR_REVIEW");
    assert_eq!(answer["reason"], "exceeds_amount_due");
    assert_eq!(
        answer["amountDue"], 8.0,
        "the message says what was still due"
    );

    let conn = td.state.conn.lock().unwrap();
    assert_eq!(
        crate::payments::load_net_paid_for_order(&conn, LOCAL_ORDER_ID).unwrap(),
        5.0,
        "the order keeps what it owed"
    );
}

#[test]
fn cash_on_a_covered_order_is_still_refused_before_the_drawer_takes_it() {
    let td = TestDb::open();
    {
        let conn = td.state.conn.lock().unwrap();
        seed_order_paid_by_other_money(&conn, 1300);
    }
    let refused = crate::payments::record_payment(
        &td.state,
        &json!({
            "orderId": LOCAL_ORDER_ID,
            "method": "cash",
            "amount": 13.0,
            "cashReceived": 13.0,
            "changeGiven": 0.0,
        }),
    );
    assert!(refused.is_err(), "cash is refused, nothing was taken yet");
    let conn = td.state.conn.lock().unwrap();
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_payments WHERE order_id = ?1",
            params![LOCAL_ORDER_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "no row for the refused cash");
}

// ---------------------------------------------------------------------------
// Item D4 (round 2, founder rule 30/09 and 01/10/2026): setting a payment
// aside settles the order's label to what the payments that still count
// prove, never higher, in the same write. The label stayed `paid` over a
// payment that no longer counted: the grid and the Z read a claim no record
// backed. The ledger restore that follows every set-aside raises it again
// from the server's own rows (a mirrored row recomputes the label).

fn order_label(conn: &rusqlite::Connection) -> String {
    conn.query_row(
        "SELECT payment_status FROM orders WHERE id = ?1",
        params![LOCAL_ORDER_ID],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn setting_the_only_payment_aside_settles_the_label_to_pending() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order_with_local_cash(&conn);
    assert_eq!(order_label(&conn), "paid");

    let outcome = crate::payment_review::set_aside_already_paid_payment(
        &conn,
        LOCAL_CASH_PAYMENT_ID,
        Some(SERVER_CARD_PAYMENT_ID),
        "2026-10-01T09:00:00Z",
    )
    .unwrap();
    assert!(matches!(
        outcome,
        crate::payment_review::SetAsideOutcome::SetAside { .. }
    ));
    assert_eq!(
        order_label(&conn),
        "pending",
        "nothing that counts backs `paid`"
    );
    let updated_at: String = conn
        .query_row(
            "SELECT updated_at FROM orders WHERE id = ?1",
            params![LOCAL_ORDER_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        updated_at, "2026-09-30T10:06:00Z",
        "the order keeps its Z window"
    );
}

#[test]
fn setting_one_of_two_payments_aside_leaves_what_the_other_proves() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order_with_local_cash(&conn);
    // A second, real 5.00 card row on the 13.00 order (the cash was the
    // duplicate of a payment the server holds).
    conn.execute(
        "INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status,
             sync_status, sync_state, remote_payment_id, created_at, updated_at
         ) VALUES ('pay-card-part', ?1, 'card', 5.0, 500, 'EUR', 'completed', 'synced',
                   'applied', 'remote-card-part', '2026-09-30T10:01:00Z', '2026-09-30T10:01:00Z')",
        params![LOCAL_ORDER_ID],
    )
    .unwrap();

    crate::payment_review::set_aside_already_paid_payment(
        &conn,
        LOCAL_CASH_PAYMENT_ID,
        None,
        "2026-10-01T09:00:00Z",
    )
    .unwrap();
    assert_eq!(order_label(&conn), "partially_paid");
}

#[test]
fn a_set_aside_never_raises_the_label() {
    let td = TestDb::open();
    let conn = td.state.conn.lock().unwrap();
    seed_order_with_local_cash(&conn);
    // Two rows of 13.00 on a 13.00 order labelled partly paid: setting one
    // aside leaves 13.00 counted, which would prove `paid`; the label is not
    // raised here (the restore and the pull own that).
    conn.execute_batch(
        "UPDATE orders SET payment_status = 'partially_paid' WHERE id = 'ord-set-aside';
         INSERT INTO order_payments (
             id, order_id, method, amount, amount_cents, currency, status,
             sync_status, sync_state, created_at, updated_at
         ) VALUES ('pay-second-cash', 'ord-set-aside', 'cash', 13.0, 1300, 'EUR', 'completed',
                   'pending', 'pending', '2026-09-30T10:05:30Z', '2026-09-30T10:05:30Z');",
    )
    .unwrap();

    crate::payment_review::set_aside_already_paid_payment(
        &conn,
        LOCAL_CASH_PAYMENT_ID,
        None,
        "2026-10-01T09:00:00Z",
    )
    .unwrap();
    assert_eq!(order_label(&conn), "partially_paid");
}
