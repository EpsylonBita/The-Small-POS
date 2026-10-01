//! Payments set aside for review (Android 1.0.13 parity, fix review 30/09/2026).
//!
//! Symptom: a 13.00 cash payment on an order another terminal had already
//! charged 13.00 by card. The Z counted cash where the server counted card,
//! and a real double charge (the customer paid twice) was invisible: the
//! ledger never showed two payments, so `overpaid_order` could not fire.
//!
//! Root cause: `POST /api/pos/payments` answers `200 { already_paid: true,
//! payment_id }` WITHOUT recording the payment when the order is already
//! fully paid by other canonical payments and this one matches none of them.
//! `payment_id` names THAT other payment. The terminal linked its own row to
//! it, so one server payment had two local stand-ins and the mirror never
//! brought the real server row.
//!
//! Such a payment is now set aside: kept exactly as recorded (amount, method,
//! tender), `status = 'duplicate_review'`, counted nowhere, never re-sent. The
//! order's server payments are mirrored so the order keeps the money the
//! server holds, counted once. The Z lists every unresolved one as
//! `payments_need_review` until a manager confirms it was given back to the
//! customer (`status = 'voided'` with `metadata.duplicate_review.resolution`).
//!
//! POS parity: POSSystemMobile `PaymentService.setAsideDuplicatePaymentAsync`,
//! `resolveDuplicatePaymentAsync` and `SET_ASIDE_PAYMENT_SQL`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use tracing::{error, info, warn};

/// `order_payments.status` of a payment set aside as a possible duplicate.
/// Not completed money: every total, drawer and coverage read leaves it out.
/// The same value as Android's `DUPLICATE_REVIEW_PAYMENT_STATUS`.
pub(crate) const DUPLICATE_REVIEW_PAYMENT_STATUS: &str = "duplicate_review";

/// The typed Z blocker for unresolved set-aside payments. The shared Health
/// contract keys on this exact name.
pub(crate) const PAYMENTS_NEED_REVIEW_REASON_CODE: &str = "payments_need_review";

/// `errorCode` of a `payment_record` answer whose money moved but found the
/// order already covered: recorded set aside, not collected.
pub(crate) const PAYMENT_SET_ASIDE_ERROR_CODE: &str = "PAYMENT_SET_ASIDE_FOR_REVIEW";

/// The one resolution a manager can record for a set-aside payment.
pub(crate) const RETURNED_TO_CUSTOMER_OUTCOME: &str = "returned_to_customer";

/// Why a payment was set aside. Android: `DuplicatePaymentReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SetAsideReason {
    /// The server answered `already_paid`: other money already paid the order.
    AlreadyPaid,
    /// Money that moved (an approved card) found nothing still due.
    OrderAlreadyCovered,
    /// Money that moved found less still due than it carried.
    ExceedsAmountDue,
    /// The server refused it (`409 PLATFORM_HELD_ORDER`): the delivery
    /// platform already holds this order's money (item D, 30/09/2026).
    PlatformHeld,
}

impl SetAsideReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AlreadyPaid => "already_paid",
            Self::OrderAlreadyCovered => "order_already_covered",
            Self::ExceedsAmountDue => "exceeds_amount_due",
            Self::PlatformHeld => "platform_held",
        }
    }
}

/// The server's refusal code for a new cash/card row on money the delivery
/// platform holds (item D, founder decision 30/09/2026). Sent only to a
/// terminal that declares `platform-held-refusal-v1`
/// (`api::POS_CAPABILITIES`), as HTTP 409 with
/// `{ success: false, code: "PLATFORM_HELD_ORDER", error: "PLATFORM_HELD_ORDER: ..." }`.
pub(crate) const PLATFORM_HELD_ORDER_CODE: &str = "PLATFORM_HELD_ORDER";

/// Does a `POST /api/pos/payments` answer refuse the payment because the
/// delivery platform already holds the order's money? Only a 409 whose body
/// names `PLATFORM_HELD_ORDER`; any other 409 keeps its own handling.
pub(crate) fn response_reports_platform_held_refusal(status: u16, body: &str) -> bool {
    if status != 409 {
        return false;
    }
    let Ok(body) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    body.get("code").and_then(Value::as_str) == Some(PLATFORM_HELD_ORDER_CODE)
        || body
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.trim_start().starts_with(PLATFORM_HELD_ORDER_CODE))
}

/// The same refusal read from `api::fetch_from_admin`'s error text, which
/// carries the answer's `error` sentence, its status as `(HTTP 409)` and its
/// body.
pub(crate) fn error_message_reports_platform_held_refusal(message: &str) -> bool {
    message.contains("(HTTP 409)") && message.contains(PLATFORM_HELD_ORDER_CODE)
}

/// SQL predicate over an `order_payments` row aliased `alias`: the row is, or
/// was, a payment set aside as a possible duplicate (unresolved, or resolved
/// as given back). Android: `SET_ASIDE_PAYMENT_SQL`.
///
/// Its order's order-level payment facts describe that payment, not the money
/// that paid the order, so any fallback that counts a paid order by an
/// order-level tender must leave such an order out.
pub(crate) fn set_aside_payment_sql(alias: &str) -> String {
    format!(
        "({alias}.status = '{DUPLICATE_REVIEW_PAYMENT_STATUS}' \
         OR ({alias}.status = 'voided' \
             AND (CASE WHEN json_valid({alias}.metadata) \
                       THEN json_extract({alias}.metadata, '$.duplicate_review') END) IS NOT NULL))"
    )
}

/// Does a `POST /api/pos/payments` answer say the server did NOT record this
/// payment because the order was already paid by other money?
pub(crate) fn response_reports_already_paid(response: Option<&Value>) -> bool {
    let Some(response) = response else {
        return false;
    };
    [
        response.get("already_paid"),
        response.get("alreadyPaid"),
        response.pointer("/data/already_paid"),
        response.pointer("/data/alreadyPaid"),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.as_bool() == Some(true))
}

/// What [`set_aside_payment_in_connection`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SetAsideOutcome {
    /// The payment is now set aside.
    SetAside { order_id: String },
    /// It already was (a replayed answer): nothing changed.
    AlreadySetAside { order_id: String },
    /// Not completed money (voided meanwhile, or gone): nothing changed, and
    /// it is never linked to the server payment either.
    NotEligible,
    /// This terminal's schema cannot hold the status (v90 did not widen it):
    /// nothing changed. The caller keeps the payment held, never linked.
    StatusUnavailable { order_id: String },
}

impl SetAsideOutcome {
    pub(crate) fn order_id(&self) -> Option<&str> {
        match self {
            Self::SetAside { order_id }
            | Self::AlreadySetAside { order_id }
            | Self::StatusUnavailable { order_id } => Some(order_id.as_str()),
            Self::NotEligible => None,
        }
    }
}

fn parse_metadata_object(raw: Option<&str>) -> Map<String, Value> {
    raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

pub(crate) fn with_savepoint<T>(
    conn: &Connection,
    name: &str,
    body: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    conn.execute_batch(&format!("SAVEPOINT {name}"))
        .map_err(|e| format!("savepoint {name}: {e}"))?;
    match body() {
        Ok(value) => {
            conn.execute_batch(&format!("RELEASE {name}"))
                .map_err(|e| format!("release {name}: {e}"))?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch(&format!("ROLLBACK TO {name}"));
            let _ = conn.execute_batch(&format!("RELEASE {name}"));
            Err(error)
        }
    }
}

pub(crate) fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![table],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| format!("inspect table {table}: {e}"))
}

/// Close every queue row of a payment so it is never sent again: the legacy
/// financial queue marks it done, the parity queue drops its unsent rows. A
/// row the parity worker is processing right now is acknowledged by the
/// worker itself (`mark_success`) once this returns.
fn close_payment_queue_rows(conn: &Connection, payment_id: &str, now: &str) -> Result<(), String> {
    if table_exists(conn, "sync_queue")? {
        conn.execute(
            "UPDATE sync_queue
             SET status = 'synced',
                 synced_at = ?1,
                 retry_count = 0,
                 next_retry_at = NULL,
                 last_error = NULL,
                 updated_at = ?1
             WHERE entity_type IN ('payment', 'order_payments')
               AND entity_id = ?2
               AND status != 'synced'",
            params![now, payment_id],
        )
        .map_err(|e| format!("close legacy payment queue rows: {e}"))?;
    }
    if table_exists(conn, "parity_sync_queue")? {
        crate::sync_queue::clear_unsynced_items(conn, "payments", payment_id)?;
        crate::sync_queue::clear_unsynced_items(conn, "order_payments", payment_id)?;
    }
    Ok(())
}

struct AuditEntry<'a> {
    action_id: &'a str,
    payment_id: &'a str,
    order_id: &'a str,
    actor_staff_id: Option<&'a str>,
    message: &'a str,
    payload: Value,
    created_at: &'a str,
}

/// One row in the durable local audit trail (`recovery_action_log`).
fn write_audit_entry(conn: &Connection, entry: AuditEntry<'_>) -> Result<(), String> {
    if !table_exists(conn, "recovery_action_log")? {
        return Err("recovery_action_log is missing; the audit entry cannot be written".into());
    }
    let order_number: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(order_number, '')), '') FROM orders WHERE id = ?1",
            params![entry.order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load order number for payment audit: {e}"))?
        .flatten();
    conn.execute(
        "INSERT INTO recovery_action_log (
             id, action_id, issue_code, entity_type, entity_id, order_id, order_number,
             success, message, actor_staff_id, payload_json, created_at
         ) VALUES (?1, ?2, ?3, 'order_payment', ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10)",
        params![
            uuid::Uuid::new_v4().to_string(),
            entry.action_id,
            PAYMENTS_NEED_REVIEW_REASON_CODE,
            entry.payment_id,
            entry.order_id,
            order_number,
            entry.message,
            entry.actor_staff_id,
            entry.payload.to_string(),
            entry.created_at,
        ],
    )
    .map_err(|e| format!("write payment review audit entry: {e}"))?;
    Ok(())
}

/// Point `orders.payment_transaction_id` away from a payment that no longer
/// counts. Leaves `payment_status` (settled down to the counted rows by
/// `payments::settle_order_label_down_to_counted_rows`, item D4) and
/// `updated_at` alone: moving `updated_at` could move the order between Z
/// windows.
fn repoint_order_payment_reference(
    conn: &Connection,
    order_id: &str,
    payment_id: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE orders
         SET payment_transaction_id = (
             SELECT op.id FROM order_payments op
             WHERE op.order_id = ?1 AND op.status = 'completed'
             ORDER BY COALESCE(op.updated_at, op.created_at, '') DESC, op.id DESC
             LIMIT 1
         )
         WHERE id = ?1 AND payment_transaction_id = ?2",
        params![order_id, payment_id],
    )
    .map_err(|e| format!("repoint order payment reference: {e}"))?;
    Ok(())
}

/// Set an existing completed payment aside for review, in one atomic step.
///
/// The row keeps its amount, method and tender exactly as recorded. It
/// stops being completed money, its queue rows are closed so it is never
/// re-sent, and its sync bookkeeping is finished (`applied`/`synced`: there
/// is nothing left to send, so it counts as neither pending nor failed
/// anywhere; the Z holds the day for it through `payments_need_review`).
/// `metadata.duplicate_review` records why, the server payment the answer
/// named, when, and the sync state it had.
pub(crate) fn set_aside_payment_in_connection(
    conn: &Connection,
    payment_id: &str,
    reason: SetAsideReason,
    server_payment_id: Option<&str>,
    detected_at: &str,
) -> Result<SetAsideOutcome, String> {
    with_savepoint(conn, "payment_set_aside", || {
        let row: Option<(String, String, String, String, Option<String>, String, i64)> = conn
            .query_row(
                "SELECT order_id,
                        LOWER(TRIM(COALESCE(status, ''))),
                        COALESCE(sync_state, ''),
                        COALESCE(sync_status, ''),
                        metadata,
                        COALESCE(method, ''),
                        COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0)
                 FROM order_payments
                 WHERE id = ?1",
                params![payment_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("load payment to set aside: {e}"))?;
        let Some((order_id, status, sync_state, sync_status, metadata, method, amount_cents)) = row
        else {
            return Ok(SetAsideOutcome::NotEligible);
        };
        if status == DUPLICATE_REVIEW_PAYMENT_STATUS {
            close_payment_queue_rows(conn, payment_id, detected_at)?;
            return Ok(SetAsideOutcome::AlreadySetAside { order_id });
        }
        if status != "completed" {
            return Ok(SetAsideOutcome::NotEligible);
        }
        if !crate::db::order_payments_accept_duplicate_review(conn) {
            return Ok(SetAsideOutcome::StatusUnavailable { order_id });
        }

        let server_payment_id = server_payment_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut metadata = parse_metadata_object(metadata.as_deref());
        metadata.insert(
            "duplicate_review".to_string(),
            json!({
                "reason": reason.as_str(),
                "server_payment_id": server_payment_id,
                "detected_at": detected_at,
                "previous_sync_state": sync_state,
                "previous_sync_status": sync_status,
            }),
        );
        let changed = conn
            .execute(
                "UPDATE order_payments
                 SET status = ?1,
                     metadata = ?2,
                     sync_status = 'synced',
                     sync_state = 'applied',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?3
                 WHERE id = ?4
                   AND status = 'completed'",
                params![
                    DUPLICATE_REVIEW_PAYMENT_STATUS,
                    Value::Object(metadata).to_string(),
                    detected_at,
                    payment_id
                ],
            )
            .map_err(|e| format!("set payment aside: {e}"))?;
        if changed == 0 {
            return Ok(SetAsideOutcome::NotEligible);
        }
        close_payment_queue_rows(conn, payment_id, detected_at)?;
        repoint_order_payment_reference(conn, &order_id, payment_id)?;
        // Item D4 (founder rule 30/09 and 01/10/2026): the label claims no
        // more than the payments that still count prove, in this same write.
        // The ledger restore that follows every set-aside raises it again
        // from the server's own rows.
        crate::payments::settle_order_label_down_to_counted_rows(conn, &order_id)?;
        // The courier is never charged for money that is not there (founder,
        // 30/09/2026): a delivery's earning drops the set-aside money now.
        crate::order_ownership::release_driver_earning_money_for_payment(
            conn,
            payment_id,
            detected_at,
        )?;
        write_audit_entry(
            conn,
            AuditEntry {
                action_id: "payment_set_aside",
                payment_id,
                order_id: &order_id,
                actor_staff_id: None,
                message: "Payment set aside for review; it is not counted",
                payload: json!({
                    "reason": reason.as_str(),
                    "serverPaymentId": server_payment_id,
                    "method": method,
                    "amountCents": amount_cents,
                    "previousSyncState": sync_state,
                }),
                created_at: detected_at,
            },
        )?;
        error!(
            payment_id = %payment_id,
            order_id = %order_id,
            method = %method,
            amount_cents,
            reason = reason.as_str(),
            server_payment_id = server_payment_id.unwrap_or(""),
            "Payment set aside as a possible duplicate; it is not counted"
        );
        Ok(SetAsideOutcome::SetAside { order_id })
    })
}

/// Audit a collection recorded set aside at the till (money that moved but
/// found the order covered), in the caller's transaction.
#[allow(clippy::too_many_arguments)]
pub(crate) fn audit_recorded_set_aside(
    conn: &Connection,
    payment_id: &str,
    order_id: &str,
    reason: SetAsideReason,
    method: &str,
    amount_cents: i64,
    amount_due_cents: i64,
    created_at: &str,
) -> Result<(), String> {
    write_audit_entry(
        conn,
        AuditEntry {
            action_id: "payment_set_aside",
            payment_id,
            order_id,
            actor_staff_id: None,
            message: "Money that moved found the order covered; recorded set aside, not counted",
            payload: json!({
                "reason": reason.as_str(),
                "method": method,
                "amountCents": amount_cents,
                "amountDueCents": amount_due_cents,
            }),
            created_at,
        },
    )?;
    error!(
        payment_id = %payment_id,
        order_id = %order_id,
        method = %method,
        amount_cents,
        amount_due_cents,
        reason = reason.as_str(),
        "Approved payment found its order covered; recorded set aside for a manager to give back"
    );
    Ok(())
}

/// The server answered `already_paid`: set the payment aside instead of
/// linking it to the server payment the answer named.
pub(crate) fn set_aside_already_paid_payment(
    conn: &Connection,
    payment_id: &str,
    server_payment_id: Option<&str>,
    detected_at: &str,
) -> Result<SetAsideOutcome, String> {
    let outcome = set_aside_payment_in_connection(
        conn,
        payment_id,
        SetAsideReason::AlreadyPaid,
        server_payment_id,
        detected_at,
    )?;
    match &outcome {
        SetAsideOutcome::NotEligible => warn!(
            payment_id = %payment_id,
            "Server said the order was already paid; the local payment is no longer completed money, so nothing was set aside or linked"
        ),
        SetAsideOutcome::StatusUnavailable { order_id } => error!(
            payment_id = %payment_id,
            order_id = %order_id,
            "Server said the order was already paid, but this terminal cannot record a set-aside payment; the payment is held unsent and unlinked"
        ),
        _ => {}
    }
    Ok(outcome)
}

/// The server refused the payment (`409 PLATFORM_HELD_ORDER`): the delivery
/// platform already holds this order's money. The money already moved at the
/// till, so the payment is never parked as a conflict or failed row (which
/// held the pre-Z sync as `PARITY_SYNC_PARTIAL`): it is set aside for review
/// exactly like an `already_paid` answer, its queue rows closed in the same
/// step, and the Z holds the day on it until a manager records the money given
/// back. The order's server payments (the platform settlement) are mirrored
/// by the ledger restore that follows every set-aside.
pub(crate) fn set_aside_platform_held_payment(
    conn: &Connection,
    payment_id: &str,
    detected_at: &str,
) -> Result<SetAsideOutcome, String> {
    let outcome = set_aside_payment_in_connection(
        conn,
        payment_id,
        SetAsideReason::PlatformHeld,
        None,
        detected_at,
    )?;
    match &outcome {
        SetAsideOutcome::NotEligible => warn!(
            payment_id = %payment_id,
            "Server refused a payment on platform-held money; the local payment is no longer completed money, so nothing was set aside"
        ),
        SetAsideOutcome::StatusUnavailable { order_id } => error!(
            payment_id = %payment_id,
            order_id = %order_id,
            "Server refused a payment on platform-held money, but this terminal cannot record a set-aside payment; the payment is held unsent"
        ),
        _ => {}
    }
    Ok(outcome)
}

/// `sync_last_error` / queue error of an `already_paid` payment this terminal
/// could not set aside (its schema cannot hold the status).
pub(crate) const STATUS_UNAVAILABLE_ERROR: &str = "ALREADY_PAID_DUPLICATE: the server already had this order paid by other money and this terminal cannot set the payment aside; it is held unsent and unlinked";

/// Hold an `already_paid` payment this terminal cannot set aside: never
/// linked to the server payment, never counted as synced. Its legacy queue
/// row stays (or becomes) `failed`, which holds the day close and names it
/// in the sync blockers; its parity rows are closed so it is not re-sent in
/// a loop. Only reachable when v90 could not widen the status CHECK.
pub(crate) fn hold_payment_unlinked(
    conn: &Connection,
    payment_id: &str,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE order_payments
         SET sync_status = 'failed',
             sync_state = 'failed',
             sync_last_error = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![STATUS_UNAVAILABLE_ERROR, now, payment_id],
    )
    .map_err(|e| format!("hold unlinked payment: {e}"))?;
    if table_exists(conn, "sync_queue")? {
        let updated = conn
            .execute(
                "UPDATE sync_queue
                 SET status = 'failed',
                     last_error = ?1,
                     updated_at = ?2
                 WHERE entity_type IN ('payment', 'order_payments')
                   AND entity_id = ?3",
                params![STATUS_UNAVAILABLE_ERROR, now, payment_id],
            )
            .map_err(|e| format!("hold unlinked payment queue row: {e}"))?;
        if updated == 0 {
            conn.execute(
                "INSERT OR IGNORE INTO sync_queue (
                     entity_type, entity_id, operation, payload, idempotency_key,
                     status, last_error, created_at, updated_at
                 ) VALUES ('payment', ?1, 'insert', '{}', ?2, 'failed', ?3, ?4, ?4)",
                params![
                    payment_id,
                    format!("payment-held-unlinked:{payment_id}"),
                    STATUS_UNAVAILABLE_ERROR,
                    now
                ],
            )
            .map_err(|e| format!("record unlinked payment hold: {e}"))?;
        }
    }
    if table_exists(conn, "parity_sync_queue")? {
        crate::sync_queue::clear_unsynced_items(conn, "payments", payment_id)?;
    }
    Ok(())
}

/// A `payments_need_review` entry: one unresolved set-aside payment.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SetAsidePayment {
    pub payment_id: String,
    pub order_id: String,
    pub order_number: String,
    pub method: String,
    pub amount_cents: i64,
    pub currency: String,
    /// When the payment was taken.
    pub taken_at: String,
    pub reason: String,
    pub server_payment_id: Option<String>,
    pub detected_at: Option<String>,
    pub amount_due_cents: Option<i64>,
    pub order_total_cents: i64,
    /// The order's completed money (the set-aside payment is not part of it).
    pub order_settled_cents: i64,
    pub order_payment_status: String,
}

/// Unresolved set-aside payments of `branch_id` (empty = every branch) taken
/// up to `cutoff_at` (none = no upper bound). No lower bound: an older one
/// still holds today's day, because the rollover refuses to delete it.
pub(crate) fn load_unresolved_set_aside_payments(
    conn: &Connection,
    branch_id: &str,
    cutoff_at: Option<&str>,
) -> Result<Vec<SetAsidePayment>, String> {
    let mut statement = conn
        .prepare(
            "SELECT op.id,
                    op.order_id,
                    COALESCE(NULLIF(TRIM(o.order_number), ''), o.id, op.order_id),
                    LOWER(TRIM(COALESCE(op.method, ''))),
                    COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0),
                    COALESCE(NULLIF(TRIM(op.currency), ''), 'EUR'),
                    COALESCE(op.created_at, ''),
                    op.metadata,
                    COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0),
                    COALESCE((
                        SELECT SUM(COALESCE(c.amount_cents, CAST(ROUND(c.amount * 100) AS INTEGER), 0))
                        FROM order_payments c
                        WHERE c.order_id = op.order_id AND c.status = 'completed'
                    ), 0),
                    LOWER(TRIM(COALESCE(o.payment_status, 'pending')))
             FROM order_payments op
             LEFT JOIN orders o ON o.id = op.order_id
             WHERE op.status = ?1
               AND (?2 = '' OR o.id IS NULL OR o.branch_id = ?2 OR o.branch_id IS NULL)
               AND (?3 IS NULL OR datetime(op.created_at) <= datetime(?3))
             ORDER BY op.created_at ASC, op.id ASC",
        )
        .map_err(|e| format!("prepare set-aside payment list: {e}"))?;
    let rows = statement
        .query_map(
            params![DUPLICATE_REVIEW_PAYMENT_STATUS, branch_id, cutoff_at],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                ))
            },
        )
        .map_err(|e| format!("query set-aside payment list: {e}"))?;

    let mut payments = Vec::new();
    for row in rows {
        let (
            payment_id,
            order_id,
            order_number,
            method,
            amount_cents,
            currency,
            taken_at,
            metadata,
            order_total_cents,
            order_settled_cents,
            order_payment_status,
        ) = row.map_err(|e| format!("read set-aside payment: {e}"))?;
        let metadata = parse_metadata_object(metadata.as_deref());
        let review = metadata
            .get("duplicate_review")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let text = |key: &str| {
            review
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        };
        payments.push(SetAsidePayment {
            payment_id,
            order_id,
            order_number,
            method,
            amount_cents,
            currency,
            taken_at,
            reason: text("reason").unwrap_or_else(|| SetAsideReason::AlreadyPaid.as_str().into()),
            server_payment_id: text("server_payment_id"),
            detected_at: text("detected_at"),
            amount_due_cents: review.get("amount_due_cents").and_then(Value::as_i64),
            order_total_cents,
            order_settled_cents,
            order_payment_status,
        });
    }
    Ok(payments)
}

/// Unresolved set-aside payments among the orders an end-of-day cleanup is
/// about to delete (staged in `temp_z_report_order_ids`) or taken up to its
/// cutoff. The cleanup deletes payment rows; one set aside is the only record
/// of that money on this terminal, so it goes only once someone resolved it.
pub(crate) fn count_unresolved_set_aside_payments_for_cleanup(
    conn: &Connection,
    cutoff_at: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM order_payments op
         WHERE op.status = ?1
           AND (
                op.order_id IN (SELECT id FROM temp_z_report_order_ids)
                OR datetime(op.created_at) <= datetime(?2)
           )",
        params![DUPLICATE_REVIEW_PAYMENT_STATUS, cutoff_at],
        |row| row.get(0),
    )
    .map_err(|e| format!("count set-aside payments before cleanup: {e}"))
}

/// What [`resolve_set_aside_payment_in_connection`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResolveOutcome {
    Resolved {
        order_id: String,
        method: String,
        amount_cents: i64,
    },
    /// Already resolved earlier: nothing changed (a double tap).
    AlreadyResolved { order_id: String },
}

pub(crate) const PAYMENT_NOT_FOUND_ERROR: &str = "PAYMENT_NOT_FOUND";
pub(crate) const PAYMENT_NOT_SET_ASIDE_ERROR: &str = "PAYMENT_NOT_SET_ASIDE";

/// Close a set-aside payment: the money was given back to the customer. It
/// becomes `voided`, with who resolved it and when in
/// `metadata.duplicate_review.resolution`, and an audit entry. The server
/// never recorded it, so nothing is queued. Idempotent.
pub(crate) fn resolve_set_aside_payment_in_connection(
    conn: &Connection,
    payment_id: &str,
    resolved_by: Option<&str>,
    resolved_at: &str,
) -> Result<ResolveOutcome, String> {
    with_savepoint(conn, "payment_set_aside_resolve", || {
        let row: Option<(String, String, Option<String>, String, i64)> = conn
            .query_row(
                "SELECT order_id,
                        LOWER(TRIM(COALESCE(status, ''))),
                        metadata,
                        COALESCE(method, ''),
                        COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0)
                 FROM order_payments
                 WHERE id = ?1",
                params![payment_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("load set-aside payment to resolve: {e}"))?;
        let Some((order_id, status, metadata, method, amount_cents)) = row else {
            return Err(format!("{PAYMENT_NOT_FOUND_ERROR}: payment {payment_id}"));
        };
        let mut metadata = parse_metadata_object(metadata.as_deref());
        let mut review = metadata
            .get("duplicate_review")
            .and_then(Value::as_object)
            .cloned();
        if status == "voided"
            && review
                .as_ref()
                .is_some_and(|review| review.get("resolution").is_some())
        {
            return Ok(ResolveOutcome::AlreadyResolved { order_id });
        }
        if status != DUPLICATE_REVIEW_PAYMENT_STATUS {
            return Err(format!(
                "{PAYMENT_NOT_SET_ASIDE_ERROR}: payment {payment_id} is not set aside for review"
            ));
        }

        let resolved_by = resolved_by.map(str::trim).filter(|value| !value.is_empty());
        let review_entry = review.get_or_insert_with(Map::new);
        review_entry.insert(
            "resolution".to_string(),
            json!({
                "outcome": RETURNED_TO_CUSTOMER_OUTCOME,
                "resolved_by": resolved_by,
                "resolved_at": resolved_at,
            }),
        );
        metadata.insert(
            "duplicate_review".to_string(),
            Value::Object(review.unwrap_or_default()),
        );
        let changed = conn
            .execute(
                "UPDATE order_payments
                 SET status = 'voided',
                     voided_at = ?1,
                     voided_by = ?2,
                     void_reason = 'Set aside as a possible duplicate; given back to the customer',
                     metadata = ?3,
                     updated_at = ?1
                 WHERE id = ?4
                   AND status = ?5",
                params![
                    resolved_at,
                    resolved_by,
                    Value::Object(metadata).to_string(),
                    payment_id,
                    DUPLICATE_REVIEW_PAYMENT_STATUS
                ],
            )
            .map_err(|e| format!("resolve set-aside payment: {e}"))?;
        if changed == 0 {
            return Err(format!(
                "{PAYMENT_NOT_SET_ASIDE_ERROR}: payment {payment_id} changed while it was being resolved"
            ));
        }
        write_audit_entry(
            conn,
            AuditEntry {
                action_id: "payment_set_aside_resolved",
                payment_id,
                order_id: &order_id,
                actor_staff_id: resolved_by,
                message: "Set-aside payment given back to the customer",
                payload: json!({
                    "outcome": RETURNED_TO_CUSTOMER_OUTCOME,
                    "method": method,
                    "amountCents": amount_cents,
                }),
                created_at: resolved_at,
            },
        )?;
        info!(
            payment_id = %payment_id,
            order_id = %order_id,
            resolved_by = resolved_by.unwrap_or(""),
            "Set-aside payment resolved as given back to the customer"
        );
        Ok(ResolveOutcome::Resolved {
            order_id,
            method,
            amount_cents,
        })
    })
}

/// Is this payment set aside (unresolved or resolved)? A missing row is not.
pub(crate) fn payment_is_set_aside(conn: &Connection, payment_id: &str) -> Result<bool, String> {
    conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM order_payments op WHERE op.id = ?1 AND {})",
            set_aside_payment_sql("op")
        ),
        params![payment_id],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| format!("check set-aside payment {payment_id}: {e}"))
}

/// Orders holding an unresolved set-aside payment whose server ledger has
/// not been mirrored since (`metadata.duplicate_review.ledger_restored_at`).
///
/// Never-tried orders first, then the ones whose last restore failed, the
/// longest-waiting first (`metadata.duplicate_review.ledger_restore_last_failed_at`,
/// [`mark_ledger_restore_failed`]): one order that always fails goes to the
/// back of the line and never blocks the restores after it (round 3 item
/// DR5, as the placeholder restore's D3 fix). Before, the list was in a fixed
/// order (`ORDER BY order_id`) and the pass stopped at the first failure, so
/// one order the server could not answer for held every later one forever.
pub(crate) fn orders_awaiting_ledger_restore(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT op.order_id
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.status = ?1
               AND (CASE WHEN json_valid(op.metadata)
                         THEN json_extract(op.metadata, '$.duplicate_review.ledger_restored_at')
                    END) IS NULL
               AND lower(trim(COALESCE(o.order_context, ''))) <> 'repair_settlement'
             GROUP BY op.order_id
             ORDER BY MAX(CASE WHEN json_valid(op.metadata)
                               THEN json_extract(op.metadata, '$.duplicate_review.ledger_restore_last_failed_at')
                          END) IS NOT NULL,
                      MAX(CASE WHEN json_valid(op.metadata)
                               THEN json_extract(op.metadata, '$.duplicate_review.ledger_restore_last_failed_at')
                          END),
                      op.order_id
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare set-aside ledger restore scan: {e}"))?;
    let rows = statement
        .query_map(
            params![DUPLICATE_REVIEW_PAYMENT_STATUS, limit.max(1)],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("query set-aside ledger restore scan: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read set-aside ledger restore scan: {e}"))
}

/// Orders whose payment was set aside at or after `since` (an RFC 3339
/// instant) and still await their ledger restore (shared rule R4, round 3,
/// 01/10/2026): the parity queue pass that set them aside restores them
/// before it returns, never one sync pass later.
pub(crate) fn orders_set_aside_since(
    conn: &Connection,
    since: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT op.order_id
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.status = ?1
               AND (CASE WHEN json_valid(op.metadata)
                         THEN json_extract(op.metadata, '$.duplicate_review.ledger_restored_at')
                    END) IS NULL
               AND (CASE WHEN json_valid(op.metadata)
                         THEN json_extract(op.metadata, '$.duplicate_review.detected_at')
                    END) >= ?2
               AND lower(trim(COALESCE(o.order_context, ''))) <> 'repair_settlement'
             GROUP BY op.order_id
             ORDER BY op.order_id
             LIMIT ?3",
        )
        .map_err(|e| format!("prepare fresh set-aside ledger restore scan: {e}"))?;
    let rows = statement
        .query_map(
            params![DUPLICATE_REVIEW_PAYMENT_STATUS, since, limit.max(1)],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("query fresh set-aside ledger restore scan: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read fresh set-aside ledger restore scan: {e}"))
}

/// Stamp the order's set-aside payments still awaiting their ledger restore:
/// this pass could not mirror its server ledger. The order goes to the back
/// of the line ([`orders_awaiting_ledger_restore`]) and is tried again later.
pub(crate) fn mark_ledger_restore_failed(
    conn: &Connection,
    order_id: &str,
    failed_at: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE order_payments
         SET metadata = json_set(
                 CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                 '$.duplicate_review.ledger_restore_last_failed_at',
                 ?1
             )
         WHERE order_id = ?2
           AND status = ?3
           AND (CASE WHEN json_valid(metadata)
                     THEN json_extract(metadata, '$.duplicate_review.ledger_restored_at')
                END) IS NULL",
        params![failed_at, order_id, DUPLICATE_REVIEW_PAYMENT_STATUS],
    )
    .map_err(|e| format!("stamp set-aside ledger restore failure: {e}"))
}

/// Stamp the order's unresolved set-aside payments: its server ledger was
/// mirrored after they were set aside.
pub(crate) fn mark_ledger_restored(
    conn: &Connection,
    order_id: &str,
    restored_at: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE order_payments
         SET metadata = json_set(
                 CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                 '$.duplicate_review.ledger_restored_at',
                 ?1
             )
         WHERE order_id = ?2
           AND status = ?3
           AND (CASE WHEN json_valid(metadata)
                     THEN json_extract(metadata, '$.duplicate_review.ledger_restored_at')
                END) IS NULL",
        params![restored_at, order_id, DUPLICATE_REVIEW_PAYMENT_STATUS],
    )
    .map_err(|e| format!("stamp set-aside ledger restore: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        crate::sync_queue::create_tables(&conn).expect("create parity tables");
        conn
    }

    fn seed_order(conn: &Connection, order_id: &str, total_cents: i64) {
        conn.execute(
            "INSERT INTO orders (
                 id, order_number, supabase_id, items, total_amount, total_amount_cents,
                 status, payment_status, sync_status, branch_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, '[]', ?4, ?5, 'completed', 'paid', 'synced', 'branch-a',
                       '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
            params![
                order_id,
                format!("ORD-{order_id}"),
                format!("remote-{order_id}"),
                total_cents as f64 / 100.0,
                total_cents
            ],
        )
        .expect("seed order");
    }

    fn seed_payment(conn: &Connection, payment_id: &str, order_id: &str, method: &str, cents: i64) {
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents, status,
                 sync_status, sync_state, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', 'pending', 'syncing',
                       '2026-09-30T10:05:00Z', '2026-09-30T10:05:00Z')",
            params![payment_id, order_id, method, cents as f64 / 100.0, cents],
        )
        .expect("seed payment");
    }

    #[test]
    fn migration_lets_order_payments_hold_the_review_status() {
        let conn = test_conn();
        assert!(crate::db::order_payments_accept_duplicate_review(&conn));
        seed_order(&conn, "ord-1", 1300);
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, created_at, updated_at)
             VALUES ('pay-probe', 'ord-1', 'cash', 13.0, 1300, 'duplicate_review', 'now', 'now')",
            [],
        )
        .expect("duplicate_review is a valid status after v90");
        let bogus = conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, amount_cents, status, created_at, updated_at)
             VALUES ('pay-bogus', 'ord-1', 'cash', 13.0, 1300, 'bogus', 'now', 'now')",
            [],
        );
        assert!(
            bogus.is_err(),
            "the status CHECK still refuses unknown values"
        );
        let quick_check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(quick_check, "ok");
    }

    #[test]
    fn set_aside_keeps_the_money_as_recorded_closes_the_queue_and_counts_nowhere() {
        let conn = test_conn();
        seed_order(&conn, "ord-1", 1300);
        seed_payment(&conn, "pay-cash", "ord-1", "cash", 1300);
        crate::sync_queue::enqueue_payload_item(
            &conn,
            "payments",
            "pay-cash",
            "INSERT",
            &json!({ "paymentId": "pay-cash", "orderId": "ord-1" }),
            Some(1),
            Some("payment"),
            Some("manual"),
            Some(1),
        )
        .expect("enqueue");

        let outcome = set_aside_already_paid_payment(
            &conn,
            "pay-cash",
            Some("srv-card-1"),
            "2026-09-30T10:06:00Z",
        )
        .expect("set aside");
        assert_eq!(
            outcome,
            SetAsideOutcome::SetAside {
                order_id: "ord-1".into()
            }
        );

        let (status, method, cents, remote, sync_state, metadata): (
            String,
            String,
            i64,
            Option<String>,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT status, method, amount_cents, remote_payment_id, sync_state, metadata
                 FROM order_payments WHERE id = 'pay-cash'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(status, DUPLICATE_REVIEW_PAYMENT_STATUS);
        assert_eq!((method.as_str(), cents), ("cash", 1300));
        assert_eq!(remote, None, "never linked to the server payment");
        assert_eq!(sync_state, "applied");
        let metadata: Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(metadata["duplicate_review"]["reason"], "already_paid");
        assert_eq!(
            metadata["duplicate_review"]["server_payment_id"],
            "srv-card-1"
        );
        assert_eq!(
            metadata["duplicate_review"]["previous_sync_state"],
            "syncing"
        );
        assert_eq!(
            metadata["duplicate_review"]["detected_at"],
            "2026-09-30T10:06:00Z"
        );

        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE record_id = 'pay-cash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 0, "never re-sent");
        let net_paid = crate::payments::load_net_paid_for_order(&conn, "ord-1").unwrap();
        assert_eq!(net_paid, 0.0, "not money anywhere");
        assert_eq!(
            crate::payments::derive_payment_method(&conn, "ord-1").unwrap(),
            None
        );
        let audit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM recovery_action_log
                 WHERE action_id = 'payment_set_aside' AND entity_id = 'pay-cash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit, 1);

        // A replayed answer changes nothing.
        let again = set_aside_already_paid_payment(
            &conn,
            "pay-cash",
            Some("srv-card-1"),
            "2026-09-30T10:07:00Z",
        )
        .unwrap();
        assert_eq!(
            again,
            SetAsideOutcome::AlreadySetAside {
                order_id: "ord-1".into()
            }
        );
    }

    #[test]
    fn a_voided_payment_is_never_set_aside_nor_linked() {
        let conn = test_conn();
        seed_order(&conn, "ord-1", 1300);
        seed_payment(&conn, "pay-cash", "ord-1", "cash", 1300);
        conn.execute(
            "UPDATE order_payments SET status = 'voided' WHERE id = 'pay-cash'",
            [],
        )
        .unwrap();
        let outcome =
            set_aside_already_paid_payment(&conn, "pay-cash", Some("srv"), "now").unwrap();
        assert_eq!(outcome, SetAsideOutcome::NotEligible);
        let (status, remote): (String, Option<String>) = conn
            .query_row(
                "SELECT status, remote_payment_id FROM order_payments WHERE id = 'pay-cash'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), remote), ("voided", None));
    }

    #[test]
    fn resolving_voids_it_with_who_and_when_is_idempotent_and_audited() {
        let conn = test_conn();
        seed_order(&conn, "ord-1", 1300);
        seed_payment(&conn, "pay-cash", "ord-1", "cash", 1300);
        set_aside_already_paid_payment(&conn, "pay-cash", Some("srv"), "t1").unwrap();

        let outcome =
            resolve_set_aside_payment_in_connection(&conn, "pay-cash", Some("staff-m"), "t2")
                .unwrap();
        assert_eq!(
            outcome,
            ResolveOutcome::Resolved {
                order_id: "ord-1".into(),
                method: "cash".into(),
                amount_cents: 1300
            }
        );
        let (status, metadata, voided_by): (String, String, Option<String>) = conn
            .query_row(
                "SELECT status, metadata, voided_by FROM order_payments WHERE id = 'pay-cash'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "voided");
        assert_eq!(voided_by.as_deref(), Some("staff-m"));
        let metadata: Value = serde_json::from_str(&metadata).unwrap();
        let resolution = &metadata["duplicate_review"]["resolution"];
        assert_eq!(resolution["outcome"], RETURNED_TO_CUSTOMER_OUTCOME);
        assert_eq!(resolution["resolved_by"], "staff-m");
        assert_eq!(resolution["resolved_at"], "t2");
        assert_eq!(metadata["duplicate_review"]["reason"], "already_paid");

        let again =
            resolve_set_aside_payment_in_connection(&conn, "pay-cash", Some("staff-x"), "t3")
                .unwrap();
        assert_eq!(
            again,
            ResolveOutcome::AlreadyResolved {
                order_id: "ord-1".into()
            }
        );
        let audits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM recovery_action_log
                 WHERE action_id = 'payment_set_aside_resolved' AND entity_id = 'pay-cash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audits, 1, "one audit entry, one decision");
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE record_id = 'pay-cash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, 0, "the server never recorded it: nothing is queued");
        assert!(payment_is_set_aside(&conn, "pay-cash").unwrap());
        assert!(load_unresolved_set_aside_payments(&conn, "", None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn only_a_set_aside_payment_can_be_resolved() {
        let conn = test_conn();
        seed_order(&conn, "ord-1", 1300);
        seed_payment(&conn, "pay-cash", "ord-1", "cash", 1300);
        let error = resolve_set_aside_payment_in_connection(&conn, "pay-cash", None, "t")
            .expect_err("a completed payment is not given back from here");
        assert!(error.starts_with(PAYMENT_NOT_SET_ASIDE_ERROR));
        let error = resolve_set_aside_payment_in_connection(&conn, "missing", None, "t")
            .expect_err("missing");
        assert!(error.starts_with(PAYMENT_NOT_FOUND_ERROR));
    }

    #[test]
    fn the_review_list_names_order_amount_method_and_time() {
        let conn = test_conn();
        seed_order(&conn, "ord-1", 1300);
        seed_payment(&conn, "pay-card", "ord-1", "card", 1300);
        seed_payment(&conn, "pay-cash", "ord-1", "cash", 1300);
        set_aside_already_paid_payment(&conn, "pay-cash", Some("pay-card-remote"), "t1").unwrap();

        let listed = load_unresolved_set_aside_payments(&conn, "branch-a", None).unwrap();
        assert_eq!(listed.len(), 1);
        let entry = &listed[0];
        assert_eq!(entry.payment_id, "pay-cash");
        assert_eq!(entry.order_number, "ORD-ord-1");
        assert_eq!(entry.method, "cash");
        assert_eq!(entry.amount_cents, 1300);
        assert_eq!(entry.taken_at, "2026-09-30T10:05:00Z");
        assert_eq!(entry.reason, "already_paid");
        assert_eq!(entry.server_payment_id.as_deref(), Some("pay-card-remote"));
        assert_eq!(
            entry.order_settled_cents, 1300,
            "the card still counts once"
        );

        assert!(load_unresolved_set_aside_payments(&conn, "branch-b", None)
            .unwrap()
            .is_empty());
        assert!(
            load_unresolved_set_aside_payments(&conn, "", Some("2026-09-30T10:00:00Z"))
                .unwrap()
                .is_empty(),
            "taken after the cutoff"
        );
    }

    #[test]
    fn already_paid_is_read_from_the_answer_only_when_true() {
        assert!(response_reports_already_paid(Some(
            &json!({ "success": true, "already_paid": true })
        )));
        assert!(response_reports_already_paid(Some(
            &json!({ "data": { "alreadyPaid": true } })
        )));
        assert!(!response_reports_already_paid(Some(
            &json!({ "success": true, "already_paid": false })
        )));
        assert!(!response_reports_already_paid(Some(
            &json!({ "success": true, "payment_id": "p" })
        )));
        assert!(!response_reports_already_paid(None));
    }
}
