//! Real-SQLite tests for the original-card gift return adapter
//! (`atomic_return_v1`). Replies use the route's flat success envelope.

use super::*;
use crate::tests::fake_http::MockServer;

const ORG: &str = "6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf";
const BRANCH: &str = "7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0";
const TERMINAL: &str = "terminal-main-01";
const STAFF: &str = "5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e";
const OTHER_STAFF: &str = "8f1e2d3c-4b5a-4968-8776-65544332211f";
const CARD: &str = "0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5";
const REMOTE_ORDER: &str = "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const REMOTE_PAYMENT: &str = "2e3f4a5b-6c7d-4e8f-9a01-b2c3d4e5f607";
const DEBIT_TX: &str = "3f4a5b6c-7d8e-4f90-8b12-c3d4e5f60718";
const LOCAL_ORDER: &str = "local-order-gift-return";
const SESSION: &str = "return-session-secret-7Q";
const PIN: &str = "864213";
const REASON: &str = "Customer returned an item";
const AT: &str = "2026-09-30T10:00:00.000Z";

struct Fixture {
    db: db::DbState,
    scope: OpeningScope,
    payment: String,
    gross: i64,
    order_total: i64,
}

impl Fixture {
    fn new(gross: i64, cash: i64) -> Self {
        Self::with_journal_terminal(gross, cash, TERMINAL)
    }

    fn with_journal_terminal(gross: i64, cash: i64, journal_terminal: &str) -> Self {
        clear_return_authorities();
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        for (key, value) in [
            ("organization_id", ORG),
            ("branch_id", BRANCH),
            ("terminal_id", TERMINAL),
        ] {
            crate::db::set_setting(&conn, "terminal", key, value).expect("seed terminal scope");
        }
        ensure_schemas(&conn).expect("return schemas");
        let order_total = gross + cash;
        conn.execute(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, order_type,
                                 payment_status, sync_status, supabase_id, created_at, updated_at)
             VALUES (?1, '[]', ?2, ?3, 'completed', 'takeaway', 'pending', 'synced', ?4, ?5, ?5)",
            params![
                LOCAL_ORDER,
                order_total as f64 / 100.0,
                order_total,
                REMOTE_ORDER,
                AT
            ],
        )
        .expect("seed order");
        if cash > 0 {
            conn.execute(
                "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, currency, status,
                                             sync_status, sync_state, created_at, updated_at)
                 VALUES ('cash-sibling', ?1, 'cash', ?2, ?3, 'EUR', 'completed', 'synced', 'applied', ?4, ?4)",
                params![LOCAL_ORDER, cash as f64 / 100.0, cash, AT],
            )
            .expect("seed cash sibling");
        }
        let canonical = json!({
            "id": REMOTE_PAYMENT,
            "order_id": REMOTE_ORDER,
            "amount": gross as f64 / 100.0,
            "amount_cents": gross,
            "tip_amount": 0,
            "tip_amount_cents": 0,
            "currency": "EUR",
            "payment_method": "gift_card",
            "method": "gift_card",
            "status": "completed",
            "idempotency_key": "gift-redeem-key-1",
            "external_transaction_id": format!("gift_card:{DEBIT_TX}"),
            "gift_card_id": CARD,
            "gift_card_transaction_id": DEBIT_TX,
            "metadata": {
                "source": "gift_card_redeem",
                "gift_card_id": CARD,
                "gift_card_transaction_id": DEBIT_TX,
                "gift_card_last4": "4242",
            },
            "created_at": AT,
        });
        let (order, payment) = crate::sync::mirror_canonical_payment(&conn, &canonical)
            .expect("mirror gift payment")
            .expect("gift row mirrored");
        assert_eq!(order, LOCAL_ORDER);
        conn.execute(
            "INSERT INTO gift_card_redemption_attempts (
                idempotency_key, organization_id, branch_id, terminal_id, local_order_id, remote_order_id,
                amount_cents, currency, card_fingerprint, request_fingerprint, status, card_id,
                remote_payment_id, local_payment_id, created_at, updated_at
             ) VALUES ('gift-redeem-key-1', ?1, ?2, ?3, ?4, ?5, ?6, 'EUR', 'fp-card', 'fp-request',
                       'applied', ?7, ?8, ?9, ?10, ?10)",
            params![ORG, BRANCH, journal_terminal, LOCAL_ORDER, REMOTE_ORDER, gross, CARD, REMOTE_PAYMENT, payment, AT],
        )
        .expect("seed applied redemption journal");
        crate::payments::recompute_order_payment_state(&conn, LOCAL_ORDER, AT, &payment)
            .expect("initial coverage");
        let scope = opening::trusted_scope(&conn).expect("trusted scope");
        Self {
            db: db::DbState {
                conn: Mutex::new(conn),
                db_path: std::path::PathBuf::new(),
            },
            scope,
            payment,
            gross,
            order_total,
        }
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.db.conn.lock().expect("db lock")
    }

    fn authorize_as(&self, staff: &str) -> u64 {
        let fence = capture_fence();
        let now = Utc::now();
        install_authority(
            fence,
            self.scope.clone(),
            staff,
            SESSION,
            now + Duration::hours(8),
            now,
        )
        .expect("install return authority");
        fence
    }

    fn reply(
        &self,
        action: &str,
        returned: i64,
        total: i64,
        ids: &[String; 3],
        replayed: bool,
    ) -> Value {
        server_reply(
            self.gross,
            self.order_total,
            action,
            returned,
            total,
            ids,
            replayed,
        )
    }

    fn net_paid(&self) -> f64 {
        crate::payments::load_net_paid_for_order(&self.conn(), LOCAL_ORDER).expect("net paid")
    }

    fn count(&self, sql: &str) -> i64 {
        self.conn()
            .query_row(sql, [], |row| row.get(0))
            .expect("count")
    }

    fn payment_status(&self, id: &str) -> String {
        self.conn()
            .query_row(
                "SELECT status FROM order_payments WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .expect("payment status")
    }
}

fn server_reply(
    gross: i64,
    order_total: i64,
    action: &str,
    returned: i64,
    total: i64,
    ids: &[String; 3],
    replayed: bool,
) -> Value {
    let remaining = gross - total;
    let payment_status = if remaining > 0 {
        "completed"
    } else if action == "void" {
        "voided"
    } else {
        "refunded"
    };
    let paid = order_total - total;
    let order_status = if paid >= order_total {
        "paid"
    } else if paid > 0 {
        "partially_paid"
    } else {
        "pending"
    };
    json!({
        "success": true,
        "replayed": replayed,
        "return_id": ids[0],
        "action": action,
        "original_payment_id": REMOTE_PAYMENT,
        "original_transaction_id": DEBIT_TX,
        "reversal_transaction_id": ids[1],
        "payment_adjustment_id": ids[2],
        "gift_card_id": CARD,
        "order_id": REMOTE_ORDER,
        "currency": "EUR",
        "original_amount_cents": gross,
        "returned_amount_cents": returned,
        "total_returned_amount_cents": total,
        "remaining_amount_cents": remaining,
        "created_at": "2026-09-30T10:05:00.000Z",
        "card": {
            "id": CARD,
            "balance_cents": 5000 + total,
            "currency": "EUR",
            "status": "active",
            "card_number_last4": "4242",
        },
        "payment": {
            "id": REMOTE_PAYMENT,
            "status": payment_status,
            "amount_cents": gross,
            "reversed_amount_cents": total,
            "currency": "EUR",
        },
        "order": {
            "order_id": REMOTE_ORDER,
            "order_total_cents": order_total,
            "paid_total_cents": paid,
            "remaining_cents": (order_total - paid).max(0),
            "payment_status": order_status,
            "payment_method": "gift_card",
        },
        "server_trace": "ignored extra field",
    })
}

fn ids() -> [String; 3] {
    [
        Uuid::new_v4().to_string(),
        Uuid::new_v4().to_string(),
        Uuid::new_v4().to_string(),
    ]
}

fn seed_keys(url: &str) -> impl Sized {
    crate::tests::fake_keyring::install_seeded([
        ("terminal_id", TERMINAL.to_string()),
        ("organization_id", ORG.to_string()),
        ("branch_id", BRANCH.to_string()),
        ("pos_api_key", "fixture-key".to_string()),
        ("admin_dashboard_url", url.to_string()),
    ])
}

fn refund(payment: &str, cents: i64) -> Value {
    json!({ "localPaymentId": payment, "action": "refund", "amountCents": cents, "reason": REASON })
}

fn void(payment: &str) -> Value {
    json!({ "localPaymentId": payment, "action": "void", "reason": REASON })
}

fn close(left: f64, right: f64) -> bool {
    (left - right).abs() < 1e-9
}

#[tokio::test]
async fn partial_refund_then_next_refund_adopt_exact_canonical_adjustments() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 1000);
    fx.authorize_as(STAFF);
    let queued = fx.count("SELECT COUNT(*) FROM sync_queue");
    assert!(close(fx.net_paid(), 40.0));

    let first_ids = ids();
    let server = MockServer::new(
        fx.reply("refund", 1200, 1200, &first_ids, false)
            .to_string(),
    );
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 1200))
        .await
        .expect("begin");
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_eq!(out["return"]["proof"]["remainingCents"], 1800);
    let first_key = out["return"]["returnKey"]
        .as_str()
        .expect("return key")
        .to_string();
    let requests = server.recorded();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(
        requests[0].path,
        format!("/api/pos/gift-cards/redemptions/{REMOTE_PAYMENT}/reverse")
    );
    assert_eq!(requests[0].header("x-staff-session-id"), Some(SESSION));
    assert_eq!(
        requests[0].json_body(),
        Some(
            json!({ "action": "refund", "amount_cents": 1200, "reason": REASON, "idempotency_key": first_key })
        )
    );

    let adjustment: (String, String, i64, bool, String, String, String) = fx
        .conn()
        .query_row(
            "SELECT id, adjustment_type, amount_cents, refund_method IS NULL, sync_state, idempotency_key, order_id
               FROM payment_adjustments WHERE payment_id = ?1",
            params![fx.payment],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .expect("exactly one canonical adjustment");
    assert_eq!(
        adjustment,
        (
            first_ids[2].clone(),
            "refund".into(),
            1200,
            true,
            "applied".into(),
            first_key.clone(),
            LOCAL_ORDER.into()
        )
    );
    assert_eq!(
        fx.payment_status(&fx.payment),
        "completed",
        "a partial return keeps the row completed"
    );
    assert_eq!(fx.payment_status("cash-sibling"), "completed");
    assert!(
        close(fx.net_paid(), 28.0),
        "coverage moves by the gift net only"
    );
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM sync_queue"),
        queued,
        "no outgoing queue"
    );

    let second_ids = ids();
    let server = MockServer::new(
        fx.reply("refund", 1800, 3000, &second_ids, false)
            .to_string(),
    );
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 1800))
        .await
        .expect("begin next");
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_ne!(
        out["return"]["returnKey"],
        first_key.as_str(),
        "a later legitimate refund gets its own original"
    );
    assert_eq!(out["return"]["proof"]["paymentStatus"], "refunded");
    assert_eq!(fx.payment_status(&fx.payment), "refunded");
    assert_eq!(fx.payment_status("cash-sibling"), "completed");
    assert!(
        close(fx.net_paid(), 10.0),
        "the refunded row is excluded once, never double subtracted"
    );
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM payment_adjustments WHERE refund_method IS NOT NULL"),
        0
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM sync_queue"), queued);

    let out = begin(&fx.db, &refund(&fx.payment, 1))
        .await
        .expect("begin after full");
    assert_eq!(out["code"], "GIFT_RETURN_ALREADY_RETURNED");
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM gift_card_return_attempts"),
        2
    );
}

#[tokio::test]
async fn full_refund_void_and_void_after_partial() {
    let _serial = opening::hosted_auth_test_serial();
    let full = Fixture::new(2500, 0);
    full.authorize_as(STAFF);
    let server = MockServer::new(full.reply("refund", 2500, 2500, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    assert_eq!(
        begin(&full.db, &refund(&full.payment, 2500)).await.unwrap()["outcome"],
        "completed"
    );
    drop(creds);
    assert_eq!(full.payment_status(&full.payment), "refunded");
    assert!(close(full.net_paid(), 0.0));

    let fx = Fixture::new(2500, 500);
    fx.authorize_as(STAFF);
    let server = MockServer::new(fx.reply("void", 2500, 2500, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &void(&fx.payment)).await.expect("void");
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    let body = server.recorded()[0].json_body().expect("void body");
    assert_eq!(body["action"], "void");
    assert!(body.get("amount_cents").is_none());
    let row: (String, Option<String>, Option<String>) = fx
        .conn()
        .query_row(
            "SELECT status, voided_by, void_reason FROM order_payments WHERE id = ?1",
            params![fx.payment],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        ("voided".into(), Some(STAFF.into()), Some(REASON.into()))
    );
    assert_eq!(
        fx.count(
            "SELECT COUNT(*) FROM payment_adjustments
              WHERE adjustment_type = 'void' AND refund_method IS NULL AND amount_cents = 2500"
        ),
        1
    );
    assert_eq!(fx.payment_status("cash-sibling"), "completed");
    assert!(close(fx.net_paid(), 5.0));

    let partial = Fixture::new(2500, 0);
    partial.authorize_as(STAFF);
    let server = MockServer::new(partial.reply("refund", 700, 700, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    assert_eq!(
        begin(&partial.db, &refund(&partial.payment, 700))
            .await
            .unwrap()["outcome"],
        "completed"
    );
    let out = begin(&partial.db, &void(&partial.payment)).await.unwrap();
    drop(creds);
    assert_eq!(out["code"], "GIFT_RETURN_VOID_AFTER_PARTIAL");
    assert_eq!(
        server.count(),
        1,
        "the refused void never reached the server"
    );
}

#[tokio::test]
async fn original_cap_and_command_validation_refuse_before_capture() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 0);
    let out = begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap();
    assert_eq!(
        (out["code"].as_str(), out["outcome"].as_str()),
        (Some("GIFT_RETURN_AUTH_REQUIRED"), Some("auth_required"))
    );
    fx.authorize_as(STAFF);
    assert_eq!(
        begin(&fx.db, &refund(&fx.payment, 3001)).await.unwrap()["code"],
        "GIFT_RETURN_EXCEEDS_REMAINING"
    );
    for bad in [
        Value::Null,
        json!({ "localPaymentId": fx.payment, "action": "refund", "amountCents": 12.5, "reason": REASON }),
        json!({ "localPaymentId": fx.payment, "action": "refund", "reason": REASON }),
        json!({ "localPaymentId": fx.payment, "action": "void", "amountCents": 100, "reason": REASON }),
        json!({ "localPaymentId": fx.payment, "action": "refund", "amountCents": 100_000_000, "reason": REASON }),
        json!({ "localPaymentId": fx.payment, "action": "refund", "amountCents": 100, "reason": "   " }),
        json!({ "localPaymentId": fx.payment, "action": "refund", "amountCents": 100, "reason": "x".repeat(501) }),
        json!({ "localPaymentId": fx.payment, "action": "cash", "reason": REASON }),
        json!({ "localPaymentId": fx.payment, "action": "void", "reason": REASON, "idempotencyKey": "k" }),
        json!({ "localPaymentId": fx.payment, "action": "void", "reason": REASON, "remotePaymentId": REMOTE_PAYMENT }),
    ] {
        assert_eq!(
            begin(&fx.db, &bad).await.unwrap()["code"],
            "GIFT_RETURN_INVALID",
            "{bad}"
        );
    }
    for bad in [
        json!({ "staffId": STAFF }),
        json!({ "staffId": "not-a-uuid", "pin": PIN }),
        json!({ "staffId": STAFF, "pin": PIN, "sessionId": "x" }),
    ] {
        assert_eq!(
            authorize(&fx.db, &bad).await.unwrap()["code"],
            "GIFT_RETURN_INVALID",
            "{bad}"
        );
    }
    assert_eq!(
        recover(&fx.db, &json!({ "returnKey": "nope" }))
            .await
            .unwrap()["code"],
        "GIFT_RETURN_INVALID"
    );
    let both = json!({ "localPaymentId": fx.payment, "returnKey": Uuid::new_v4().to_string() });
    assert_eq!(
        status(&fx.db, &both).unwrap()["code"],
        "GIFT_RETURN_INVALID"
    );
    let unknown = json!({ "returnKey": Uuid::new_v4().to_string() });
    assert_eq!(
        recover(&fx.db, &unknown).await.unwrap()["code"],
        "GIFT_RETURN_NOT_FOUND"
    );
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM gift_card_return_attempts"),
        0,
        "nothing was captured"
    );
    let advisory = status(&fx.db, &json!({ "localPaymentId": fx.payment })).unwrap();
    assert_eq!(advisory["advisory"], true);
    assert_eq!(advisory["original"]["remainingCents"], 3000);
    assert_eq!(advisory["authorization"]["active"], true);
}

#[tokio::test]
async fn lost_reply_and_restart_resend_the_identical_original() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 0);
    fx.authorize_as(STAFF);
    let lost = MockServer::new(json!({ "success": true, "replayed": false }).to_string());
    let creds = seed_keys(&lost.url);
    let out = begin(&fx.db, &refund(&fx.payment, 1000)).await.unwrap();
    assert_eq!(
        (out["code"].as_str(), out["outcome"].as_str()),
        (Some("GIFT_RETURN_RESULT_MALFORMED"), Some("pending")),
        "{out}"
    );
    let key = out["return"]["returnKey"]
        .as_str()
        .expect("pending original")
        .to_string();
    let again = begin(&fx.db, &refund(&fx.payment, 500)).await.unwrap();
    drop(creds);
    assert_eq!(again["code"], "GIFT_RETURN_PENDING_EXISTS");
    assert_eq!(
        again["return"]["returnKey"],
        key.as_str(),
        "one unresolved original per payment"
    );
    assert_eq!(lost.count(), 1);

    clear_return_authorities(); // restart: the volatile authority is gone
    let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    assert_eq!(out["outcome"], "auth_required");
    assert!(
        out.get("return").is_none(),
        "no details before the original operator authorizes"
    );
    fx.authorize_as(OTHER_STAFF);
    let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    assert_eq!(
        out["outcome"], "auth_required",
        "a renewed authority never rebinds the recorded operator"
    );
    assert!(
        out.get("return").is_none(),
        "another operator learns nothing about the original"
    );
    assert_eq!(status(&fx.db, &Value::Null).unwrap()["returns"], json!([]));

    fx.authorize_as(STAFF);
    let server = MockServer::new(fx.reply("refund", 1000, 1000, &ids(), true).to_string());
    let creds = seed_keys(&server.url);
    let out = recover(&fx.db, &json!({ "returnKey": key.to_uppercase() }))
        .await
        .unwrap();
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_eq!(out["return"]["sendCount"], 2);
    assert_eq!(out["return"]["proof"]["replayed"], true);
    assert_eq!(
        lost.recorded()[0].body,
        server.recorded()[0].body,
        "identical body and key"
    );
    assert_eq!(
        server.recorded()[0].json_body().unwrap()["idempotency_key"],
        key.as_str()
    );
    let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed");
    assert_eq!(
        server.count(),
        1,
        "an adopted proof is idempotent and never resent"
    );
}

#[tokio::test]
async fn import_failure_rolls_back_everything_and_exact_replay_adopts_once() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 1000);
    fx.authorize_as(STAFF);
    fx.conn()
        .execute_batch(
            "CREATE TEMP TRIGGER gift_return_forced_failure BEFORE INSERT ON payment_adjustments
             BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;",
        )
        .unwrap();
    let server = MockServer::new(fx.reply("refund", 3000, 3000, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 3000)).await.unwrap();
    assert_eq!(
        (out["code"].as_str(), out["outcome"].as_str()),
        (Some("GIFT_RETURN_IMPORT_FAILED"), Some("pending")),
        "{out}"
    );
    assert_eq!(out["return"]["state"], "pending");
    assert!(out["return"]["proof"].is_null());
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 0);
    assert_eq!(fx.payment_status(&fx.payment), "completed");
    assert!(close(fx.net_paid(), 40.0));

    fx.conn()
        .execute_batch("DROP TRIGGER gift_return_forced_failure;")
        .unwrap();
    let key = out["return"]["returnKey"].as_str().unwrap().to_string();
    let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    let requests = server.recorded();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].body, requests[1].body,
        "the retry resends the exact original"
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);
    assert_eq!(fx.payment_status(&fx.payment), "refunded");
    assert_eq!(fx.payment_status("cash-sibling"), "completed");
    assert!(close(fx.net_paid(), 10.0));
}

#[tokio::test]
async fn unproven_foreign_or_reparented_originals_are_refused() {
    let _serial = opening::hosted_auth_test_serial();
    let foreign = Fixture::with_journal_terminal(3000, 1000, "terminal-other");
    foreign.authorize_as(STAFF);
    let code = |out: Value| out["code"].as_str().unwrap_or_default().to_string();
    assert_eq!(
        code(
            begin(&foreign.db, &refund(&foreign.payment, 100))
                .await
                .unwrap()
        ),
        "GIFT_RETURN_ORIGINAL_UNPROVEN"
    );
    assert_eq!(
        code(
            begin(&foreign.db, &refund("cash-sibling", 100))
                .await
                .unwrap()
        ),
        "GIFT_RETURN_ORIGINAL_NOT_RETURNABLE"
    );
    assert_eq!(
        code(begin(&foreign.db, &refund("missing", 100)).await.unwrap()),
        "GIFT_RETURN_ORIGINAL_NOT_FOUND"
    );

    let malformed = Fixture::new(3000, 0);
    malformed.authorize_as(STAFF);
    malformed
        .conn()
        .execute(
            "UPDATE order_payments SET transaction_ref = 'gift_card:not-a-uuid' WHERE id = ?1",
            params![malformed.payment],
        )
        .unwrap();
    assert_eq!(
        code(
            begin(&malformed.db, &refund(&malformed.payment, 100))
                .await
                .unwrap()
        ),
        "GIFT_RETURN_ORIGINAL_UNPROVEN"
    );

    let fx = Fixture::new(3000, 0);
    fx.authorize_as(STAFF);
    let lost = MockServer::new("{}");
    let creds = seed_keys(&lost.url);
    let out = begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap();
    let key = out["return"]["returnKey"]
        .as_str()
        .expect("pending original")
        .to_string();
    fx.conn()
        .execute(
            "UPDATE orders SET supabase_id = ?1 WHERE id = ?2",
            params![Uuid::new_v4().to_string(), LOCAL_ORDER],
        )
        .unwrap();
    let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    drop(creds);
    assert_eq!(
        (out["code"].as_str(), out["outcome"].as_str()),
        (Some("GIFT_RETURN_ORIGINAL_UNPROVEN"), Some("pending"))
    );
    assert_eq!(out["return"]["state"], "pending");
    assert_eq!(lost.count(), 1, "a reparented original is never resent");
}

#[tokio::test]
async fn hosted_check_in_authorizes_without_opening_or_drawer_and_keeps_secrets_native() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 0);
    let sid = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";
    let check_in = MockServer::new(
        json!({
            "success": true,
            "session_id": sid,
            "staff_id": STAFF,
            "role_name": "manager",
            "branch_id": BRANCH,
            "organization_id": ORG,
            "permissions": [],
            "session": {
                "id": sid,
                "staff_id": STAFF,
                "terminal_id": TERMINAL,
                "organization_id": ORG,
                "branch_id": BRANCH,
                "expires_at": stamp(Utc::now() + Duration::hours(8)),
            },
        })
        .to_string(),
    );
    let creds = seed_keys(&check_in.url);
    let before = Utc::now();
    let out = authorize(&fx.db, &json!({ "staffId": STAFF, "pin": PIN }))
        .await
        .unwrap();
    drop(creds);
    assert_eq!(out["success"], true, "{out}");
    assert_eq!(out["staffId"], STAFF);
    let until = DateTime::parse_from_rfc3339(out["usableUntil"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    assert!(until > before && until <= Utc::now() + Duration::seconds(AUTHORITY_SECS));
    assert_eq!(check_in.recorded()[0].path, "/api/pos/staff-auth/check-in");

    let server = MockServer::new(fx.reply("refund", 500, 500, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 500)).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_eq!(server.recorded()[0].header("x-staff-session-id"), Some(sid));
    let snapshot = status(&fx.db, &Value::Null).unwrap();
    assert_eq!(snapshot["returns"].as_array().map(Vec::len), Some(1));
    let exposed = format!(
        "{out}{snapshot}{:?}",
        live_authority(&fx.scope, None, Utc::now())
    );
    assert!(
        !exposed.contains(sid) && !exposed.contains(PIN),
        "views and Debug never carry the session or PIN"
    );
}

#[tokio::test]
async fn authority_expiry_clear_and_held_scope_switch() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 0);
    let now = Utc::now();
    let expired = install_authority(
        capture_fence(),
        fx.scope.clone(),
        STAFF,
        SESSION,
        now - Duration::seconds(1),
        now,
    );
    assert_eq!(expired.unwrap_err().0, "GIFT_RETURN_AUTHORIZATION_EXPIRED");
    let until = install_authority(
        capture_fence(),
        fx.scope.clone(),
        STAFF,
        SESSION,
        now + Duration::hours(8),
        now,
    )
    .unwrap();
    assert_eq!(
        until,
        now + Duration::seconds(AUTHORITY_SECS),
        "capped at the purpose window"
    );
    assert!(live_authority(&fx.scope, Some(STAFF), until).is_none());
    let stale = capture_fence();
    fx.authorize_as(STAFF);
    let superseded = install_authority(
        stale,
        fx.scope.clone(),
        STAFF,
        SESSION,
        now + Duration::hours(1),
        Utc::now(),
    );
    assert_eq!(
        superseded.unwrap_err().0,
        "GIFT_RETURN_AUTHORIZATION_SUPERSEDED"
    );
    let in_flight = capture_fence();
    opening::clear_authorizations();
    assert!(
        live_authority(&fx.scope, Some(STAFF), Utc::now()).is_none(),
        "the lifecycle clear drops it"
    );
    let resurrected = install_authority(
        in_flight,
        fx.scope.clone(),
        STAFF,
        SESSION,
        now + Duration::hours(1),
        Utc::now(),
    );
    assert_eq!(
        resurrected.unwrap_err().0,
        "GIFT_RETURN_AUTHORIZATION_SUPERSEDED"
    );
    assert_eq!(
        begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap()["outcome"],
        "auth_required"
    );

    fx.authorize_as(STAFF);
    let lost = MockServer::new("{}");
    let creds = seed_keys(&lost.url);
    let out = begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap();
    drop(creds);
    let key = out["return"]["returnKey"]
        .as_str()
        .expect("pending original")
        .to_string();
    crate::db::set_setting(&fx.conn(), "terminal", "terminal_id", "terminal-other").unwrap();
    let foreign = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    assert_eq!(foreign["code"], "GIFT_RETURN_NOT_FOUND");
    assert!(foreign.get("return").is_none(), "no previous actor details");
    let listed = status(&fx.db, &Value::Null).unwrap();
    assert_eq!(listed["returns"], json!([]));
    assert_eq!(listed["authorization"]["active"], false);
    assert_eq!(
        begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap()["outcome"],
        "auth_required"
    );
    crate::db::set_setting(&fx.conn(), "terminal", "terminal_id", TERMINAL).unwrap();
    let listed = status(&fx.db, &json!({ "returnKey": key })).unwrap();
    assert_eq!(listed["returns"][0]["state"], "pending");
    assert_eq!(listed["returns"][0]["staffId"], STAFF);
}

#[tokio::test]
async fn a_clear_during_the_request_keeps_the_original_pending() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 0);
    fx.authorize_as(STAFF);
    let reply_ids = ids();
    let racing = MockServer::new_with_request_hook(
        fx.reply("refund", 400, 400, &reply_ids, false).to_string(),
        clear_return_authorities,
    );
    let creds = seed_keys(&racing.url);
    let out = begin(&fx.db, &refund(&fx.payment, 400)).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "auth_required", "{out}");
    assert!(
        out.get("return").is_none(),
        "a held reply publishes nothing after the clear"
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 0);
    fx.authorize_as(STAFF);
    let listed = status(&fx.db, &Value::Null).unwrap();
    assert_eq!(listed["returns"][0]["state"], "pending", "{listed}");
    let key = listed["returns"][0]["returnKey"].clone();
    let server = MockServer::new(fx.reply("refund", 400, 400, &reply_ids, true).to_string());
    let creds = seed_keys(&server.url);
    let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_eq!(
        racing.recorded()[0].body,
        server.recorded()[0].body,
        "the retained original is replayed exactly"
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);
}

/// Request hook: a different operator authorizes while the reply is held.
fn replace_with_other_staff(scope: OpeningScope) -> impl Fn() + Send + Sync + 'static {
    move || {
        let now = Utc::now();
        install_authority(
            capture_fence(),
            scope.clone(),
            OTHER_STAFF,
            "other-session",
            now + Duration::hours(1),
            now,
        )
        .expect("replacement authority");
    }
}

/// Request hook: the captured authority expires while the reply is held.
fn expire_in_place() {
    if let Some(live) = return_auth().current.as_mut() {
        live.usable_until = Utc::now() - Duration::seconds(1);
    }
}

#[tokio::test]
async fn a_remote_prior_return_is_covered_once_by_the_proven_cumulative_floor() {
    let _serial = opening::hosted_auth_test_serial();
    // Another terminal already returned 300 of this 1000 original; this terminal never saw it.
    let fx = Fixture::new(1000, 500);
    fx.authorize_as(STAFF);
    let queued = fx.count("SELECT COUNT(*) FROM sync_queue");
    let header = |fx: &Fixture| -> String {
        fx.conn()
            .query_row(
                "SELECT payment_status FROM orders WHERE id = ?1",
                params![LOCAL_ORDER],
                |row| row.get(0),
            )
            .expect("order header")
    };
    let strict = |fx: &Fixture| -> Vec<(String, i64)> {
        let mut nets: Vec<(String, i64)> =
            crate::payments::load_settled_fiscal_tenders(&fx.conn(), LOCAL_ORDER)
                .expect("strict fiscal tenders")
                .into_iter()
                .map(|tender| (tender.method, tender.net_cents))
                .collect();
        nets.sort();
        let receipt = crate::fiscal::payload_builder::build_fiscal_receipt_input(
            &fx.conn(),
            LOCAL_ORDER,
            BRANCH,
        )
        .expect("ordinary receipt from the same canonical original");
        let mut receipt_nets: Vec<(String, i64)> = receipt["payments"]
            .as_array()
            .expect("receipt payments")
            .iter()
            .map(|payment| {
                (
                    payment["method"]
                        .as_str()
                        .expect("receipt tender")
                        .to_owned(),
                    payment["amountCents"].as_i64().expect("receipt cents"),
                )
            })
            .collect();
        receipt_nets.sort();
        assert_eq!(
            receipt_nets, nets,
            "ordinary and strict receipts use the same return coverage"
        );
        nets
    };
    let held = crate::payments::load_order_settlement_snapshot(&fx.conn(), LOCAL_ORDER)
        .expect("held")
        .ledger_generation;
    assert_eq!(header(&fx), "paid");

    // A failed header recompute rolls the adjustment and the completed proof back together.
    fx.conn()
        .execute_batch(
            "CREATE TEMP TRIGGER gift_return_forced_header_failure BEFORE UPDATE OF payment_status ON orders
             BEGIN SELECT RAISE(ABORT, 'forced header failure'); END;",
        )
        .unwrap();
    let reply_ids = ids();
    let server = MockServer::new(fx.reply("refund", 200, 500, &reply_ids, false).to_string());
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 200)).await.unwrap();
    assert_eq!(
        (out["code"].as_str(), out["outcome"].as_str()),
        (Some("GIFT_RETURN_IMPORT_FAILED"), Some("pending")),
        "{out}"
    );
    let key = out["return"]["returnKey"]
        .as_str()
        .expect("retained original")
        .to_string();
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 0);
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM gift_card_return_attempts WHERE state = 'completed'"),
        0
    );
    assert_eq!(
        (fx.payment_status(&fx.payment), header(&fx)),
        ("completed".into(), "paid".into())
    );
    assert!(close(fx.net_paid(), 15.0), "nothing adopted");

    fx.conn()
        .execute_batch("DROP TRIGGER gift_return_forced_header_failure;")
        .unwrap();
    let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_eq!(out["return"]["proof"]["remainingCents"], 500);
    let requests = server.recorded();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].body, requests[1].body,
        "the exact original is resent"
    );
    let adjustment: (String, String, i64, String) = fx
        .conn()
        .query_row(
            "SELECT id, adjustment_type, amount_cents, idempotency_key FROM payment_adjustments",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("only this return's adjustment");
    assert_eq!(
        adjustment,
        (reply_ids[2].clone(), "refund".into(), 200, key.clone()),
        "no prior refund is invented"
    );
    assert_eq!(fx.count("SELECT MAX(total_returned_cents) FROM gift_card_return_attempts WHERE state = 'completed'"), 500);
    assert_eq!(fx.payment_status(&fx.payment), "completed");
    assert_eq!(fx.payment_status("cash-sibling"), "completed");
    assert!(
        close(fx.net_paid(), 10.0),
        "gift 1000 - max(200, 500) + cash 500"
    );
    assert_eq!(header(&fx), "partially_paid");
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM order_payments"),
        2,
        "no cash or card movement"
    );

    // Settlement, edit-settlement and strict fiscal readers all see gift 500 + cash 500.
    let snapshot =
        crate::payments::load_order_settlement_snapshot(&fx.conn(), LOCAL_ORDER).expect("snapshot");
    assert!(close(snapshot.net_paid, 10.0) && close(snapshot.outstanding_amount, 5.0));
    assert_ne!(
        snapshot.ledger_generation, held,
        "the proven floor invalidates a held settlement"
    );
    let gift = snapshot
        .completed_payments
        .iter()
        .find(|p| p["id"] == fx.payment.as_str())
        .expect("gift row");
    assert_eq!(
        (
            gift["refundedAmount"].as_f64(),
            gift["remainingRefundable"].as_f64()
        ),
        (Some(5.0), Some(5.0))
    );
    let edit = crate::commands::orders::list_completed_payments_for_edit(&fx.conn(), LOCAL_ORDER)
        .expect("edit rows");
    let edit_gift = edit
        .iter()
        .find(|p| p["id"] == fx.payment.as_str())
        .expect("edit gift row");
    assert_eq!(edit_gift["remainingRefundable"].as_f64(), Some(5.0));
    assert_eq!(
        strict(&fx),
        vec![("cash".to_string(), 500), ("gift_card".to_string(), 500)]
    );

    // An exact replay of the adopted proof changes nothing.
    let record = load_record(&fx.conn(), &key)
        .unwrap()
        .expect("completed original");
    let replayed = adopt(
        &fx.conn(),
        &fx.scope,
        &key,
        record.proof.as_ref().expect("proof"),
        Utc::now(),
    );
    assert!(replayed.is_ok_and(|again| again.state == "completed"));
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);

    // A later proof below the known cumulative stays pending and imports nothing.
    let server = MockServer::new(fx.reply("refund", 100, 550, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap();
    drop(creds);
    assert_eq!(
        (out["code"].as_str(), out["outcome"].as_str()),
        (Some("GIFT_RETURN_PROOF_STALE"), Some("pending")),
        "{out}"
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);
    assert!(close(fx.net_paid(), 10.0));
    assert_eq!(
        fx.count("SELECT COUNT(*) FROM sync_queue"),
        queued,
        "no outgoing queue or payout"
    );

    // Later local cash stays counted, and the floor is never read as money still held.
    fx.conn()
        .execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, currency, status,
                                         sync_status, sync_state, created_at, updated_at)
             VALUES ('cash-later', ?1, 'cash', 3.0, 300, 'EUR', 'completed', 'synced', 'applied', ?2, ?2)",
            params![LOCAL_ORDER, AT],
        )
        .expect("later local cash");
    assert!(
        close(fx.net_paid(), 13.0),
        "gift 500 + cash 500 + later cash 300"
    );
    let blockers = crate::payment_integrity::load_order_payment_blockers(&fx.conn(), LOCAL_ORDER)
        .expect("blockers");
    assert!(
        blockers
            .iter()
            .all(|blocker| blocker.reason_code != "overpaid_order"),
        "gift 1000 - 200 + 800 cash would read as 1600 of 1500"
    );

    // The real earlier return imported later is not subtracted twice.
    fx.conn()
        .execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, amount_cents,
                                              reason, staff_id, sync_state, idempotency_key, created_at, updated_at)
             VALUES ('remote-prior-300', ?1, ?2, 'refund', 3.0, 300, ?3, ?4, 'applied', 'remote-prior-key', ?5, ?5)",
            params![fx.payment, LOCAL_ORDER, REASON, OTHER_STAFF, AT],
        )
        .expect("real earlier return");
    assert!(
        close(fx.net_paid(), 13.0),
        "max(200 + 300, 500) counts it once"
    );
    assert_eq!(
        strict(&fx),
        vec![
            ("cash".to_string(), 300),
            ("cash".to_string(), 500),
            ("gift_card".to_string(), 500)
        ]
    );
}

/// Seeds a closed cashier shift and moves the fixture order into it.
fn open_shift(fx: &Fixture, shift: &str) {
    let conn = fx.conn();
    conn.execute(
        "INSERT INTO staff_shifts (
            id, staff_id, staff_name, branch_id, terminal_id, role_type,
            check_in_time, check_out_time, report_date, period_start_at,
            opening_cash_amount, opening_cash_amount_cents,
            status, calculation_version, transferred_to_cashier_shift_id,
            sync_status, created_at, updated_at, is_day_start
        ) VALUES (?1, ?2, 'Maria', ?3, ?4, 'cashier', ?5, '2026-09-30T18:00:00.000Z', '2026-09-30', ?5, 0, 0,
                  'closed', 2, NULL, 'pending', ?5, ?5, 1)",
        params![shift, STAFF, BRANCH, TERMINAL, AT],
    )
    .expect("seed cashier shift");
    conn.execute(
        "UPDATE orders SET staff_shift_id = ?1 WHERE id = ?2",
        params![shift, LOCAL_ORDER],
    )
    .expect("order in shift");
}

/// The shift Z's takeaway order-type NET and its recorded refund movements.
fn z_takeaway_net_and_refunds(fx: &Fixture, shift: &str) -> Result<(f64, f64), String> {
    let out = crate::zreport::generate_z_report(&fx.db, &json!({ "shiftId": shift }))?;
    let report = &out["report"];
    Ok((
        report["reportJson"]["sales"]["takeawaySales"]
            .as_f64()
            .expect("takeaway NET"),
        report["refundsTotal"].as_f64().expect("recorded refunds"),
    ))
}

/// Every non-Z coverage reader of the fixture order.
fn coverage_reads(fx: &Fixture) -> Vec<(&'static str, Result<(), String>)> {
    let conn = fx.conn();
    let since = "2000-01-01T00:00:00.000Z";
    vec![
        (
            "net paid",
            crate::payments::load_net_paid_for_order(&conn, LOCAL_ORDER).map(drop),
        ),
        (
            "settlement",
            crate::payments::load_order_settlement_snapshot(&conn, LOCAL_ORDER)
                .map(drop)
                .map_err(|e| e.to_string()),
        ),
        (
            "strict tenders",
            crate::payments::load_settled_fiscal_tenders(&conn, LOCAL_ORDER)
                .map(drop)
                .map_err(|e| e.to_string()),
        ),
        (
            "edit rows",
            crate::commands::orders::list_completed_payments_for_edit(&conn, LOCAL_ORDER)
                .map(drop)
                .map_err(|e| e.to_string()),
        ),
        (
            "order blockers",
            crate::payment_integrity::load_order_payment_blockers(&conn, LOCAL_ORDER).map(drop),
        ),
        (
            "window blockers",
            crate::payment_integrity::load_branch_window_payment_blockers(
                &conn, BRANCH, since, None, true,
            )
            .map(drop),
        ),
    ]
}

#[tokio::test]
async fn z_order_type_net_counts_the_proven_floor_once_and_refund_movements_stay_recorded() {
    let _serial = opening::hosted_auth_test_serial();
    // 1000 gift + 500 cash; this return is 200, the canonical cumulative 500.
    let fx = Fixture::new(1000, 500);
    fx.authorize_as(STAFF);
    let server = MockServer::new(fx.reply("refund", 200, 500, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 200)).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");

    open_shift(&fx, "shift-before-import");
    let (net, refunds) = z_takeaway_net_and_refunds(&fx, "shift-before-import").expect("shift Z");
    assert!(
        close(net, 10.0),
        "1500 - 200 recorded - 300 proven elsewhere, got {net}"
    );
    assert!(
        close(refunds, 2.0),
        "one recorded 200 refund movement, got {refunds}"
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);

    // The real earlier 300 imported later moves the refund total, not the NET.
    fx.conn()
        .execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, amount_cents,
                                              reason, staff_id, sync_state, idempotency_key, created_at, updated_at)
             VALUES ('remote-prior-300', ?1, ?2, 'refund', 3.0, 300, ?3, ?4, 'applied', 'remote-prior-key', ?5, ?5)",
            params![fx.payment, LOCAL_ORDER, REASON, OTHER_STAFF, AT],
        )
        .expect("real earlier return");
    open_shift(&fx, "shift-after-import");
    let (net, refunds) =
        z_takeaway_net_and_refunds(&fx, "shift-after-import").expect("shift Z after import");
    assert!(
        close(net, 10.0),
        "max(0, 500 - 500) is subtracted, got {net}"
    );
    assert!(
        close(refunds, 5.0),
        "recorded 200 + 300 refund movements, got {refunds}"
    );
}

#[tokio::test]
async fn a_corrupt_or_rebound_completed_proof_fails_every_coverage_reader_closed() {
    const OTHER_REMOTE: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(1000, 500);
    fx.authorize_as(STAFF);
    let server = MockServer::new(fx.reply("refund", 200, 500, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    let out = begin(&fx.db, &refund(&fx.payment, 200)).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    let key = out["return"]["returnKey"]
        .as_str()
        .expect("return key")
        .to_string();
    open_shift(&fx, "shift-proof");
    fx.conn()
        .execute_batch(
            "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, order_type,
                                 payment_status, sync_status, created_at, updated_at)
             VALUES ('control-order', '[]', 4.0, 400, 'completed', 'takeaway', 'paid', 'synced',
                     '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z');
             INSERT INTO order_payments (id, order_id, method, amount, amount_cents, currency, status,
                                         sync_status, sync_state, created_at, updated_at)
             VALUES ('control-cash', 'control-order', 'cash', 4.0, 400, 'EUR', 'completed', 'synced',
                     'applied', '2026-09-30T10:00:00.000Z', '2026-09-30T10:00:00.000Z');
             DROP TRIGGER trg_gift_return_original_immutable;
             DROP TRIGGER trg_gift_return_terminal_final;",
        )
        .expect("ordinary control order and a mutable journal");

    // The completed proof is the journal's only row.
    let set = "UPDATE gift_card_return_attempts SET";
    let cases = [
        (
            "wrong currency",
            format!("{set} currency = 'USD'"),
            format!("{set} currency = 'EUR'"),
        ),
        (
            "another original payment",
            format!("{set} remote_payment_id = '{OTHER_REMOTE}'"),
            format!("{set} remote_payment_id = '{REMOTE_PAYMENT}'"),
        ),
        (
            "another local order",
            format!("{set} local_order_id = 'another-local-order'"),
            format!("{set} local_order_id = '{LOCAL_ORDER}'"),
        ),
        (
            "another gross",
            format!("{set} gross_cents = 1100, remaining_cents = 600"),
            format!("{set} gross_cents = 1000, remaining_cents = 500"),
        ),
        (
            "unreadable totals",
            format!("{set} total_returned_cents = 500.5, remaining_cents = 499.5"),
            format!("{set} total_returned_cents = 500, remaining_cents = 500"),
        ),
        (
            "canonical order remapped",
            format!("UPDATE orders SET supabase_id = '{OTHER_REMOTE}' WHERE id = '{LOCAL_ORDER}'"),
            format!("UPDATE orders SET supabase_id = '{REMOTE_ORDER}' WHERE id = '{LOCAL_ORDER}'"),
        ),
    ];
    for (case, corrupt, restore) in &cases {
        fx.conn().execute_batch(corrupt).expect(case);
        for (reader, read) in coverage_reads(&fx) {
            assert!(
                read.is_err(),
                "{case}: {reader} must fail closed, never read the proof as 0"
            );
        }
        let z = crate::zreport::generate_z_report(&fx.db, &json!({ "shiftId": "shift-proof" }));
        assert!(
            z.as_ref().is_err_and(|e| e.contains("gift return proof")),
            "{case}: the shift Z NET must fail closed on the proof: {z:?}"
        );
        {
            let conn = fx.conn();
            let control = crate::payments::load_net_paid_for_order(&conn, "control-order");
            assert!(
                control.is_ok_and(|net| close(net, 4.0)),
                "{case}: an ordinary order is not blocked"
            );
            assert!(
                crate::payment_integrity::load_order_payment_blockers(&conn, "control-order")
                    .is_ok(),
                "{case}"
            );
        }
        fx.conn().execute_batch(restore).expect(case);
        for (reader, read) in coverage_reads(&fx) {
            assert!(read.is_ok(), "{case}: {reader} after restore: {read:?}");
        }
        assert!(
            close(fx.net_paid(), 10.0),
            "{case}: the valid proof reads again"
        );
    }

    // The valid original replays unchanged and the shift Z reads its floor once.
    let record = load_record(&fx.conn(), &key)
        .unwrap()
        .expect("completed original");
    let replayed = adopt(
        &fx.conn(),
        &fx.scope,
        &key,
        record.proof.as_ref().expect("proof"),
        Utc::now(),
    );
    assert!(replayed.is_ok_and(|again| again.state == "completed"));
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);
    let (net, refunds) = z_takeaway_net_and_refunds(&fx, "shift-proof").expect("valid shift Z");
    assert!(
        close(net, 10.0) && close(refunds, 2.0),
        "net {net}, refunds {refunds}"
    );
}

#[tokio::test]
async fn a_held_reply_publishes_nothing_under_a_replaced_or_expired_authority() {
    let _serial = opening::hosted_auth_test_serial();
    for replaced in [true, false] {
        let fx = Fixture::new(3000, 0);
        fx.authorize_as(STAFF);
        let reply_ids = ids();
        let body = fx.reply("refund", 400, 400, &reply_ids, false).to_string();
        let held = if replaced {
            MockServer::new_with_request_hook(body, replace_with_other_staff(fx.scope.clone()))
        } else {
            MockServer::new_with_request_hook(body, expire_in_place)
        };
        let creds = seed_keys(&held.url);
        let out = begin(&fx.db, &refund(&fx.payment, 400)).await.unwrap();
        drop(creds);
        assert_eq!(
            (out["code"].as_str(), out["outcome"].as_str()),
            (Some("GIFT_RETURN_AUTH_REQUIRED"), Some("auth_required")),
            "replaced={replaced} {out}"
        );
        assert!(
            out.get("return").is_none(),
            "replaced={replaced}: no original details are published"
        );
        assert_eq!(
            fx.count("SELECT COUNT(*) FROM payment_adjustments"),
            0,
            "no adoption"
        );
        if replaced {
            let other = status(&fx.db, &json!({ "localPaymentId": fx.payment })).unwrap();
            assert_eq!(other["authorization"]["staffId"], OTHER_STAFF);
            assert_eq!(other["returns"], json!([]));
            assert_eq!(other["original"]["code"], "GIFT_RETURN_PENDING_EXISTS");
            assert!(other["original"]["pendingReturnKey"].is_null());
        }
        fx.authorize_as(STAFF);
        let listed = status(&fx.db, &Value::Null).unwrap();
        assert_eq!(
            listed["returns"].as_array().map(Vec::len),
            Some(1),
            "{listed}"
        );
        let key = listed["returns"][0]["returnKey"].clone();
        let server = MockServer::new(fx.reply("refund", 400, 400, &reply_ids, true).to_string());
        let creds = seed_keys(&server.url);
        let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
        drop(creds);
        assert_eq!(out["outcome"], "completed", "replaced={replaced} {out}");
        assert_eq!(
            held.recorded()[0].body,
            server.recorded()[0].body,
            "renewal replays the exact original"
        );
        assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);
    }

    // A failed reply is fenced the same way: its classification is recorded
    // durably, but nothing is published under the replaced authority.
    let fx = Fixture::new(3000, 0);
    fx.authorize_as(STAFF);
    let held = MockServer::new_with_request_hook(
        "<html>gateway</html>",
        replace_with_other_staff(fx.scope.clone()),
    );
    let creds = seed_keys(&held.url);
    let out = begin(&fx.db, &refund(&fx.payment, 400)).await.unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "auth_required", "{out}");
    assert!(out.get("return").is_none());
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 0);
    fx.authorize_as(STAFF);
    let listed = status(&fx.db, &Value::Null).unwrap();
    assert_eq!(
        listed["returns"][0]["lastCode"], "GIFT_RETURN_OUTCOME_UNKNOWN",
        "the error path ran: {listed}"
    );
    assert_eq!(listed["returns"][0]["state"], "pending");
    let server = MockServer::new(fx.reply("refund", 400, 400, &ids(), true).to_string());
    let creds = seed_keys(&server.url);
    let out = recover(
        &fx.db,
        &json!({ "returnKey": listed["returns"][0]["returnKey"] }),
    )
    .await
    .unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_eq!(
        held.recorded()[0].body,
        server.recorded()[0].body,
        "renewal replays the exact original"
    );
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 1);
}

#[tokio::test]
async fn attempt_details_belong_only_to_the_live_original_operator() {
    let _serial = opening::hosted_auth_test_serial();
    let fx = Fixture::new(3000, 0);
    fx.authorize_as(STAFF);
    let server = MockServer::new(fx.reply("refund", 1000, 1000, &ids(), false).to_string());
    let creds = seed_keys(&server.url);
    let done = begin(&fx.db, &refund(&fx.payment, 1000)).await.unwrap();
    drop(creds);
    assert_eq!(done["outcome"], "completed", "{done}");
    let done_key = done["return"]["returnKey"].as_str().unwrap().to_string();
    let lost = MockServer::new("{}");
    let creds = seed_keys(&lost.url);
    let refused = begin(&fx.db, &refund(&fx.payment, 500)).await.unwrap();
    let refused_key = refused["return"]["returnKey"]
        .as_str()
        .expect("captured")
        .to_string();
    mark_refused(
        &fx.conn(),
        &refused_key,
        "GIFT_CARD_PAYMENT_ALREADY_REVERSED",
        Utc::now(),
    )
    .unwrap();
    let pending = begin(&fx.db, &refund(&fx.payment, 300)).await.unwrap();
    drop(creds);
    let pending_key = pending["return"]["returnKey"]
        .as_str()
        .expect("captured")
        .to_string();

    for other in [None, Some(OTHER_STAFF)] {
        clear_return_authorities();
        if let Some(staff) = other {
            fx.authorize_as(staff);
        }
        let all = status(&fx.db, &Value::Null).unwrap();
        assert_eq!(all["success"], true);
        assert_eq!(all["authorization"]["active"], other.is_some());
        assert_eq!(all["returns"], json!([]), "{other:?}");
        for key in [&done_key, &refused_key, &pending_key] {
            assert_eq!(
                status(&fx.db, &json!({ "returnKey": key })).unwrap()["returns"],
                json!([])
            );
            let out = recover(&fx.db, &json!({ "returnKey": key })).await.unwrap();
            assert_eq!(out["outcome"], "auth_required", "{other:?} {out}");
            assert!(out.get("return").is_none(), "{other:?} {out}");
        }
        let advisory = status(&fx.db, &json!({ "localPaymentId": fx.payment })).unwrap();
        assert_eq!(advisory["original"]["code"], "GIFT_RETURN_PENDING_EXISTS");
        assert!(
            advisory["original"]["pendingReturnKey"].is_null(),
            "{other:?}"
        );
        assert_eq!(advisory["returns"], json!([]));
        if other.is_some() {
            let blocked = begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap();
            assert_eq!(blocked["code"], "GIFT_RETURN_PENDING_EXISTS");
            assert!(
                blocked.get("return").is_none(),
                "another operator learns only that a return is pending"
            );
        }
    }
    assert_eq!(lost.count(), 2, "no other operator ever sent the originals");

    clear_return_authorities(); // restart, then the original operator authorizes again
    fx.authorize_as(STAFF);
    assert_eq!(
        status(&fx.db, &Value::Null).unwrap()["returns"]
            .as_array()
            .map(Vec::len),
        Some(3)
    );
    let advisory = status(&fx.db, &json!({ "localPaymentId": fx.payment })).unwrap();
    assert_eq!(
        advisory["original"]["pendingReturnKey"],
        pending_key.as_str()
    );
    assert_eq!(
        recover(&fx.db, &json!({ "returnKey": done_key }))
            .await
            .unwrap()["outcome"],
        "completed"
    );
    let out = recover(&fx.db, &json!({ "returnKey": refused_key }))
        .await
        .unwrap();
    assert_eq!(
        (out["outcome"].as_str(), out["return"]["state"].as_str()),
        (Some("refused"), Some("refused"))
    );
    let blocked = begin(&fx.db, &refund(&fx.payment, 100)).await.unwrap();
    assert_eq!(blocked["return"]["returnKey"], pending_key.as_str());
    let server = MockServer::new(fx.reply("refund", 300, 1300, &ids(), true).to_string());
    let creds = seed_keys(&server.url);
    let out = recover(&fx.db, &json!({ "returnKey": pending_key }))
        .await
        .unwrap();
    drop(creds);
    assert_eq!(out["outcome"], "completed", "{out}");
    assert_eq!(out["return"]["sendCount"], 2);
    assert_eq!(fx.count("SELECT COUNT(*) FROM payment_adjustments"), 2);
}

#[test]
fn failure_classification_keeps_unknown_outcomes_pending() {
    use Failure::{AuthRequired, Refused, Unknown};
    let cases: &[(Option<u16>, Option<&str>, bool, bool, Failure)] = &[
        (None, None, true, true, Unknown),
        (Some(401), None, false, false, AuthRequired),
        (
            Some(403),
            Some("STAFF_SESSION_EXPIRED"),
            false,
            false,
            AuthRequired,
        ),
        (
            Some(409),
            Some("GIFT_CARD_PAYMENT_ALREADY_REVERSED"),
            false,
            false,
            Refused,
        ),
        (
            Some(409),
            Some("GIFT_CARD_VOID_AFTER_PARTIAL_RETURN"),
            false,
            false,
            Refused,
        ),
        (
            Some(409),
            Some("GIFT_CARD_RETURN_EXCEEDS_REMAINING"),
            false,
            false,
            Refused,
        ),
        (Some(403), Some("PERMISSION_REQUIRED"), false, true, Refused),
        (
            Some(403),
            Some("PERMISSION_REQUIRED"),
            false,
            false,
            Unknown,
        ),
        (
            Some(400),
            Some("GIFT_CARD_RETURN_INVALID"),
            false,
            true,
            Refused,
        ),
        (
            Some(400),
            Some("GIFT_CARD_RETURN_INVALID"),
            false,
            false,
            Unknown,
        ),
        (
            Some(409),
            Some("IDEMPOTENCY_CONFLICT"),
            false,
            true,
            Unknown,
        ),
        (Some(409), Some("SCOPE_REJECTED"), false, true, Unknown),
        (
            Some(409),
            Some("GIFT_CARD_RECONCILIATION_REQUIRED"),
            false,
            true,
            Unknown,
        ),
        (
            Some(500),
            Some("GIFT_CARD_PAYMENT_ALREADY_REVERSED"),
            false,
            true,
            Unknown,
        ),
        (Some(502), None, false, true, Unknown),
        (Some(409), None, false, true, Unknown),
    ];
    for (status, code, transport, first, expected) in cases {
        assert_eq!(
            classify_failure(*status, *code, *transport, *first),
            *expected,
            "{status:?} {code:?} first={first}"
        );
    }
    assert_eq!(
        safe_code(Some("GIFT_CARD_PAYMENT_ALREADY_REVERSED")),
        Some("GIFT_CARD_PAYMENT_ALREADY_REVERSED")
    );
    assert_eq!(safe_code(Some("pin 864213 leaked")), None);
}

fn sample_record(action: &str, requested: Option<i64>) -> ReturnRecord {
    ReturnRecord {
        return_key: Uuid::new_v4().to_string(),
        organization_id: ORG.into(),
        branch_id: BRANCH.into(),
        terminal_id: TERMINAL.into(),
        local_payment_id: "local-gift".into(),
        remote_payment_id: REMOTE_PAYMENT.into(),
        local_order_id: LOCAL_ORDER.into(),
        remote_order_id: REMOTE_ORDER.into(),
        card_id: CARD.into(),
        debit_transaction_id: DEBIT_TX.into(),
        redemption_key: "gift-redeem-key-1".into(),
        currency: "EUR".into(),
        gross_cents: 3000,
        action: action.into(),
        requested_cents: requested,
        reason: REASON.into(),
        staff_id: STAFF.into(),
        request_body: "{}".into(),
        state: "pending".into(),
        send_count: 1,
        last_code: None,
        auth_required: false,
        created_at: AT.into(),
        updated_at: AT.into(),
        proof: None,
    }
}

type Mutation = Box<dyn Fn(&mut Value)>;

#[test]
fn strict_reply_parse_binds_identities_and_arithmetic() {
    let record = sample_record("refund", Some(1200));
    let good = server_reply(3000, 3000, "refund", 1200, 1200, &ids(), false);
    let proof = parse_result(&good, &record).expect("server-shaped reply parses");
    assert_eq!(
        (
            proof.returned_cents,
            proof.total_returned_cents,
            proof.remaining_cents
        ),
        (1200, 1200, 1800)
    );
    assert_eq!(proof.payment_status, "completed");
    let mutations: Vec<(&str, Mutation)> = vec![
        ("success false", Box::new(|v| v["success"] = json!(false))),
        ("action", Box::new(|v| v["action"] = json!("void"))),
        (
            "foreign card",
            Box::new(|v| v["gift_card_id"] = json!(Uuid::new_v4().to_string())),
        ),
        (
            "original payment",
            Box::new(|v| v["original_payment_id"] = json!(Uuid::new_v4().to_string())),
        ),
        ("currency", Box::new(|v| v["currency"] = json!("USD"))),
        (
            "gross",
            Box::new(|v| v["original_amount_cents"] = json!(3100)),
        ),
        (
            "remaining",
            Box::new(|v| v["remaining_amount_cents"] = json!(1700)),
        ),
        (
            "total below returned",
            Box::new(|v| v["total_returned_amount_cents"] = json!(1000)),
        ),
        (
            "duplicate identity",
            Box::new(|v| v["payment_adjustment_id"] = v["return_id"].clone()),
        ),
        (
            "reused original identity",
            Box::new(|v| v["reversal_transaction_id"] = json!(DEBIT_TX)),
        ),
        (
            "payment status",
            Box::new(|v| v["payment"]["status"] = json!("refunded")),
        ),
        (
            "payment reversed",
            Box::new(|v| v["payment"]["reversed_amount_cents"] = json!(1000)),
        ),
        (
            "order remaining",
            Box::new(|v| v["order"]["remaining_cents"] = json!(1)),
        ),
        (
            "order status",
            Box::new(|v| v["order"]["payment_status"] = json!("unpaid")),
        ),
        (
            "float cents",
            Box::new(|v| v["returned_amount_cents"] = json!(1200.0)),
        ),
        (
            "created at",
            Box::new(|v| v["created_at"] = json!("yesterday")),
        ),
        (
            "missing card",
            Box::new(|v| {
                v.as_object_mut().unwrap().remove("card");
            }),
        ),
        (
            "other amount",
            Box::new(|v| {
                v["returned_amount_cents"] = json!(1100);
                v["total_returned_amount_cents"] = json!(1100);
                v["remaining_amount_cents"] = json!(1900);
                v["payment"]["reversed_amount_cents"] = json!(1100);
            }),
        ),
    ];
    for (name, mutate) in mutations {
        let mut reply = good.clone();
        mutate(&mut reply);
        assert!(
            parse_result(&reply, &record).is_err(),
            "{name} must not parse"
        );
    }
    let void_record = sample_record("void", None);
    assert!(parse_result(
        &server_reply(3000, 3000, "void", 3000, 3000, &ids(), false),
        &void_record
    )
    .is_ok());
    let partial_void = server_reply(3000, 3000, "void", 1200, 1200, &ids(), false);
    assert!(
        parse_result(&partial_void, &void_record).is_err(),
        "a void returns the whole payment"
    );
}

#[test]
fn schema_v87_stamps_repairs_and_guards_history() {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::run_migrations_for_test(&conn);
    assert!(crate::db::CURRENT_SCHEMA_VERSION >= 87);
    let stamped: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_version WHERE version = 87",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stamped, 1);
    let objects = |conn: &Connection| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN (
                'gift_card_return_attempts', 'idx_gift_return_one_pending', 'idx_gift_return_return_id',
                'idx_gift_return_adjustment_id', 'idx_gift_return_scope',
                'trg_gift_return_original_immutable', 'trg_gift_return_terminal_final',
                'trg_gift_return_pending_retained')",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(objects(&conn), 8);
    conn.execute_batch("DROP TABLE gift_card_return_attempts;")
        .unwrap();
    assert_eq!(objects(&conn), 0);
    ensure_return_schema(&conn).unwrap();
    ensure_return_schema(&conn).unwrap();
    assert_eq!(
        objects(&conn),
        8,
        "the idempotent repair control restores the journal and its guards"
    );

    let insert = |key: &str, payment: &str, action: &str, requested: Option<i64>| {
        conn.execute(
            "INSERT INTO gift_card_return_attempts (
                return_key, organization_id, branch_id, terminal_id, local_payment_id, remote_payment_id,
                local_order_id, remote_order_id, card_id, debit_transaction_id, redemption_key, currency,
                gross_cents, action, requested_cents, reason, staff_id, request_body, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'k', 'EUR', 3000, ?11, ?12, ?13, ?14, '{}', ?15, ?15)",
            params![key, ORG, BRANCH, TERMINAL, payment, REMOTE_PAYMENT, LOCAL_ORDER, REMOTE_ORDER, CARD, DEBIT_TX, action, requested, REASON, STAFF, AT],
        )
    };
    let first = Uuid::new_v4().to_string();
    insert(&first, "p1", "refund", Some(100)).unwrap();
    assert!(
        insert(&Uuid::new_v4().to_string(), "p1", "refund", Some(100)).is_err(),
        "one pending per payment"
    );
    assert!(
        insert(&Uuid::new_v4().to_string(), "p2", "void", Some(100)).is_err(),
        "a void carries no amount"
    );
    assert!(
        insert(&Uuid::new_v4().to_string(), "p3", "refund", None).is_err(),
        "a refund needs cents"
    );
    let update = |sql: &str| conn.execute(sql, params![first]);
    assert!(update(
        "UPDATE gift_card_return_attempts SET reason = 'changed' WHERE return_key = ?1"
    )
    .is_err());
    assert!(update(
        "UPDATE gift_card_return_attempts SET staff_id = 'other' WHERE return_key = ?1"
    )
    .is_err());
    assert!(update(
        "UPDATE gift_card_return_attempts SET state = 'completed' WHERE return_key = ?1"
    )
    .is_err());
    assert!(
        update(
            "UPDATE gift_card_return_attempts
                SET state = 'completed', return_id = 'r', reversal_transaction_id = 'x', payment_adjustment_id = 'a',
                    total_returned_cents = 100, remaining_cents = 2900, payment_status = 'completed',
                    order_total_cents = 3000, order_paid_cents = 2900, order_remaining_cents = 100,
                    order_payment_status = 'partially_paid', card_balance_cents = 100, replayed = 0,
                    completed_at = 'now'
              WHERE return_key = ?1"
        )
        .is_err(),
        "a NULL returned_cents cannot satisfy the completed guard"
    );
    assert!(update("DELETE FROM gift_card_return_attempts WHERE return_key = ?1").is_err());
    update("UPDATE gift_card_return_attempts SET state = 'refused', last_code = 'X' WHERE return_key = ?1").unwrap();
    assert!(
        update("UPDATE gift_card_return_attempts SET state = 'pending' WHERE return_key = ?1")
            .is_err()
    );
    insert(&Uuid::new_v4().to_string(), "p1", "refund", Some(100)).unwrap();
}

#[test]
fn commands_are_registered_and_the_lifecycle_clear_is_hooked() {
    let lib = include_str!("../lib.rs");
    for command in [
        "gift_return_authorize",
        "gift_return_begin",
        "gift_return_recover",
        "gift_return_status",
    ] {
        assert!(
            lib.contains(&format!("commands::gift_card_returns::{command},")),
            "{command} registered"
        );
    }
    let opening_source = include_str!("../gift_financial_opening.rs");
    assert!(
        opening_source.contains("crate::commands::gift_card_returns::clear_return_authorities();")
    );
}

#[test]
fn one_dispatch_handle_per_original() {
    let key = Uuid::new_v4().to_string();
    let first = InFlight::acquire(&key).expect("first handle");
    assert!(
        InFlight::acquire(&key).is_none(),
        "a second handle cannot send the same original"
    );
    drop(first);
    assert!(InFlight::acquire(&key).is_some());
}
