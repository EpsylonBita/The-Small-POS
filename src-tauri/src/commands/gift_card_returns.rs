//! Original-card gift return (`atomic_return_v1`), Windows native adapter.
//!
//! A completed gift payment returns only to the card it debited, through
//! `POST /api/pos/gift-cards/redemptions/{originalPaymentId}/reverse` with the
//! private `x-staff-session-id` header. The renderer supplies the local payment
//! id, action, integer cents (refund only) and reason. Scope, original
//! identities, operator, native idempotency key and the exact body are captured
//! here once, before the first send, and are never regenerated.
//!
//! - At most one unresolved (pending) original per payment. Completed and
//!   refused records stay as history, so a later legitimate refund can start.
//! - Unknown outcomes (transport, 5xx, malformed or conflicting replies) stay
//!   pending and recover with the same key and body. Only definitive server
//!   refusals end an attempt.
//! - The purpose authority is a volatile single slot issued by the trusted
//!   hosted check-in. It needs no opening or drawer, and a resumed original
//!   keeps its recorded operator. Server permission remains final.
//! - Attempt details (key, reason, state, proof) are shown only to the live
//!   authority of the original operator, and a reply is published only while
//!   the authority captured for its send is still current.
//! - Adoption inserts the server adjustment and applies the one original gift
//!   payment update atomically, only when the canonical cumulative total is
//!   exactly the locally proven returns plus this one. Nothing is queued for
//!   outgoing sync.

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::gift_financial_opening::{self as opening, OpeningScope};
use crate::{api, db};

pub(crate) const RETURN_CONTRACT: &str = "atomic_return_v1";
const RETURN_TIMEOUT_SECS: u64 = 20;
const AUTHORITY_SECS: i64 = 300;
const MAX_AMOUNT_CENTS: i64 = 99_999_999;
const MAX_REASON_CHARS: usize = 500;
const STATUS_LIMIT: i64 = 50;

/// Durable original-return journal (schema v87). Idempotent, so every command
/// re-runs it as the repair control for a dropped table, index or trigger.
pub(crate) const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS gift_card_return_attempts (
    return_key TEXT PRIMARY KEY NOT NULL CHECK (length(return_key) = 36),
    organization_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    local_payment_id TEXT NOT NULL,
    remote_payment_id TEXT NOT NULL,
    local_order_id TEXT NOT NULL,
    remote_order_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    debit_transaction_id TEXT NOT NULL,
    redemption_key TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (length(currency) = 3),
    gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
    action TEXT NOT NULL CHECK (action IN ('refund', 'void')),
    requested_cents INTEGER,
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    staff_id TEXT NOT NULL,
    request_body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'refused')),
    send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
    last_sent_at TEXT,
    last_code TEXT,
    auth_required INTEGER NOT NULL DEFAULT 0 CHECK (auth_required IN (0, 1)),
    return_id TEXT,
    reversal_transaction_id TEXT,
    payment_adjustment_id TEXT,
    returned_cents INTEGER,
    total_returned_cents INTEGER,
    remaining_cents INTEGER,
    payment_status TEXT,
    order_total_cents INTEGER,
    order_paid_cents INTEGER,
    order_remaining_cents INTEGER,
    order_payment_status TEXT,
    card_balance_cents INTEGER,
    replayed INTEGER,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- A CHECK that evaluates to NULL passes; COALESCE makes these guards fail closed.
    CHECK (COALESCE((action = 'refund' AND requested_cents BETWEEN 1 AND 99999999)
        OR (action = 'void' AND requested_cents IS NULL), 0)),
    CHECK (state = 'completed' OR return_id IS NULL),
    CHECK (state <> 'completed' OR COALESCE((
        return_id IS NOT NULL AND reversal_transaction_id IS NOT NULL
        AND payment_adjustment_id IS NOT NULL AND returned_cents > 0
        AND total_returned_cents >= returned_cents AND remaining_cents >= 0
        AND total_returned_cents + remaining_cents = gross_cents
        AND payment_status IS NOT NULL AND order_payment_status IS NOT NULL
        AND order_total_cents IS NOT NULL AND order_paid_cents IS NOT NULL
        AND order_remaining_cents >= 0 AND card_balance_cents IS NOT NULL
        AND replayed IN (0, 1) AND completed_at IS NOT NULL), 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_return_one_pending
    ON gift_card_return_attempts(local_payment_id) WHERE state = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_return_return_id
    ON gift_card_return_attempts(return_id) WHERE return_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_return_adjustment_id
    ON gift_card_return_attempts(payment_adjustment_id) WHERE payment_adjustment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gift_return_scope
    ON gift_card_return_attempts(organization_id, branch_id, terminal_id, created_at);
CREATE TRIGGER IF NOT EXISTS trg_gift_return_original_immutable
BEFORE UPDATE ON gift_card_return_attempts
WHEN NEW.return_key IS NOT OLD.return_key
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.branch_id IS NOT OLD.branch_id
  OR NEW.terminal_id IS NOT OLD.terminal_id
  OR NEW.local_payment_id IS NOT OLD.local_payment_id
  OR NEW.remote_payment_id IS NOT OLD.remote_payment_id
  OR NEW.local_order_id IS NOT OLD.local_order_id
  OR NEW.remote_order_id IS NOT OLD.remote_order_id
  OR NEW.card_id IS NOT OLD.card_id
  OR NEW.debit_transaction_id IS NOT OLD.debit_transaction_id
  OR NEW.redemption_key IS NOT OLD.redemption_key
  OR NEW.currency IS NOT OLD.currency
  OR NEW.gross_cents IS NOT OLD.gross_cents
  OR NEW.action IS NOT OLD.action
  OR NEW.requested_cents IS NOT OLD.requested_cents
  OR NEW.reason IS NOT OLD.reason
  OR NEW.staff_id IS NOT OLD.staff_id
  OR NEW.request_body IS NOT OLD.request_body
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.send_count < OLD.send_count
BEGIN
  SELECT RAISE(ABORT, 'GIFT_RETURN_ORIGINAL_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS trg_gift_return_terminal_final
BEFORE UPDATE ON gift_card_return_attempts
WHEN OLD.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'GIFT_RETURN_TERMINAL_FINAL');
END;
CREATE TRIGGER IF NOT EXISTS trg_gift_return_pending_retained
BEFORE DELETE ON gift_card_return_attempts
WHEN OLD.state = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'GIFT_RETURN_PENDING_RETAINED');
END;
"#;

pub(crate) fn ensure_return_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("gift return journal schema: {e}"))
}

fn ensure_schemas(conn: &Connection) -> Result<(), String> {
    crate::commands::gift_cards::ensure_attempt_schema(conn).map_err(|e| e.to_string())?;
    ensure_return_schema(conn)
}

// -- Volatile purpose authority ----------------------------------------------

#[derive(Clone)]
struct ReturnAuthority {
    generation: u64,
    scope: OpeningScope,
    staff_id: String,
    session_id: String,
    usable_until: DateTime<Utc>,
}

impl std::fmt::Debug for ReturnAuthority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReturnAuthority")
            .field("generation", &self.generation)
            .field("staff_id", &self.staff_id)
            .field("usable_until", &self.usable_until)
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
struct ReturnAuthState {
    generation: u64,
    cleared_through: u64,
    current: Option<ReturnAuthority>,
}

fn return_auth() -> MutexGuard<'static, ReturnAuthState> {
    static STATE: OnceLock<Mutex<ReturnAuthState>> = OnceLock::new();
    STATE
        .get_or_init(|| Mutex::new(ReturnAuthState::default()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn capture_fence() -> u64 {
    let mut auth = return_auth();
    auth.generation += 1;
    auth.generation
}

/// Drops the return authority. Called from the existing financial lifecycle
/// clear in `gift_financial_opening::clear_authorizations`.
pub(crate) fn clear_return_authorities() {
    let mut auth = return_auth();
    auth.current = None;
    auth.cleared_through = auth.generation;
}

fn install_authority(
    fence: u64,
    scope: OpeningScope,
    staff_id: &str,
    session_id: &str,
    server_until: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, (&'static str, &'static str)> {
    let mut auth = return_auth();
    let newer = auth.current.as_ref().is_some_and(|c| c.generation > fence);
    if fence <= auth.cleared_through || newer {
        return Err((
            "GIFT_RETURN_AUTHORIZATION_SUPERSEDED",
            "The return authorization was cleared or replaced while it was issued",
        ));
    }
    let usable_until = server_until.min(now + Duration::seconds(AUTHORITY_SECS));
    if usable_until <= now {
        return Err((
            "GIFT_RETURN_AUTHORIZATION_EXPIRED",
            "The staff session has already expired",
        ));
    }
    auth.current = Some(ReturnAuthority {
        generation: fence,
        scope,
        staff_id: staff_id.to_string(),
        session_id: session_id.to_string(),
        usable_until,
    });
    Ok(usable_until)
}

fn live_authority(
    scope: &OpeningScope,
    staff_id: Option<&str>,
    now: DateTime<Utc>,
) -> Option<ReturnAuthority> {
    let auth = return_auth();
    auth.current
        .as_ref()
        .filter(|c| {
            c.generation > auth.cleared_through
                && &c.scope == scope
                && c.usable_until > now
                && staff_id.map_or(true, |staff| c.staff_id.eq_ignore_ascii_case(staff))
        })
        .cloned()
}

/// Publication fence: the authority captured for a send is still the live
/// slot, with the same generation, scope and operator, uncleared and unexpired.
fn still_current(auth: &ReturnAuthState, captured: &ReturnAuthority, now: DateTime<Utc>) -> bool {
    captured.generation > auth.cleared_through
        && auth.current.as_ref().is_some_and(|live| {
            live.generation == captured.generation
                && live.scope == captured.scope
                && live.staff_id.eq_ignore_ascii_case(&captured.staff_id)
                && live.usable_until > now
        })
}

fn drop_authority(auth: &mut ReturnAuthState, generation: u64) {
    if auth
        .current
        .as_ref()
        .is_some_and(|c| c.generation == generation)
    {
        auth.current = None;
    }
}

fn authority_view(actor: Option<&ReturnAuthority>) -> Value {
    match actor {
        Some(c) => {
            json!({ "active": true, "staffId": c.staff_id, "usableUntil": stamp(c.usable_until) })
        }
        None => json!({ "active": false, "staffId": null, "usableUntil": null }),
    }
}

// -- Refusals, records and views ---------------------------------------------

#[derive(Debug)]
struct Refusal {
    code: String,
    error: String,
    outcome: &'static str,
    view: Option<Value>,
}

impl Refusal {
    fn new(code: &str, error: impl Into<String>, outcome: &'static str) -> Self {
        Self {
            code: code.to_string(),
            error: error.into(),
            outcome,
            view: None,
        }
    }

    fn pending(self) -> Self {
        Self {
            outcome: "pending",
            ..self
        }
    }

    fn into_value(self) -> Value {
        let mut out = json!({
            "success": false,
            "code": self.code,
            "error": self.error,
            "outcome": self.outcome,
        });
        if let Some(view) = self.view {
            out["return"] = view;
        }
        out
    }
}

fn rejected(code: &str, error: &str) -> Refusal {
    Refusal::new(code, error, "rejected")
}

fn invalid(error: &str) -> Refusal {
    rejected("GIFT_RETURN_INVALID", error)
}

fn scope_unavailable() -> Value {
    rejected(
        "GIFT_RETURN_SCOPE_UNAVAILABLE",
        "This terminal has no trusted scope for gift card returns",
    )
    .into_value()
}

fn not_found() -> Value {
    rejected(
        "GIFT_RETURN_NOT_FOUND",
        "No gift card return with this key exists on this terminal",
    )
    .into_value()
}

fn unproven() -> Refusal {
    rejected(
        "GIFT_RETURN_ORIGINAL_UNPROVEN",
        "The original gift card redemption could not be proven on this terminal",
    )
}

fn journal_err(e: rusqlite::Error) -> String {
    format!("gift return journal: {e}")
}

#[derive(Clone, Debug, PartialEq)]
struct ReturnProof {
    return_id: String,
    reversal_transaction_id: String,
    payment_adjustment_id: String,
    returned_cents: i64,
    total_returned_cents: i64,
    remaining_cents: i64,
    payment_status: String,
    order_total_cents: i64,
    order_paid_cents: i64,
    order_remaining_cents: i64,
    order_payment_status: String,
    card_balance_cents: i64,
    replayed: bool,
    completed_at: String,
}

#[derive(Clone, Debug)]
struct ReturnRecord {
    return_key: String,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    local_payment_id: String,
    remote_payment_id: String,
    local_order_id: String,
    remote_order_id: String,
    card_id: String,
    debit_transaction_id: String,
    redemption_key: String,
    currency: String,
    gross_cents: i64,
    action: String,
    requested_cents: Option<i64>,
    reason: String,
    staff_id: String,
    request_body: String,
    state: String,
    send_count: i64,
    last_code: Option<String>,
    auth_required: bool,
    created_at: String,
    updated_at: String,
    proof: Option<ReturnProof>,
}

const RECORD_COLUMNS: &str = "return_key, organization_id, branch_id, terminal_id, \
    local_payment_id, remote_payment_id, local_order_id, remote_order_id, card_id, \
    debit_transaction_id, redemption_key, currency, gross_cents, action, requested_cents, \
    reason, staff_id, request_body, state, send_count, last_code, auth_required, created_at, \
    updated_at, return_id, reversal_transaction_id, payment_adjustment_id, returned_cents, \
    total_returned_cents, remaining_cents, payment_status, order_total_cents, order_paid_cents, \
    order_remaining_cents, order_payment_status, card_balance_cents, replayed, completed_at";

fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReturnRecord> {
    let return_id: Option<String> = row.get(24)?;
    let proof = match return_id {
        Some(return_id) => Some(ReturnProof {
            return_id,
            reversal_transaction_id: row.get(25)?,
            payment_adjustment_id: row.get(26)?,
            returned_cents: row.get(27)?,
            total_returned_cents: row.get(28)?,
            remaining_cents: row.get(29)?,
            payment_status: row.get(30)?,
            order_total_cents: row.get(31)?,
            order_paid_cents: row.get(32)?,
            order_remaining_cents: row.get(33)?,
            order_payment_status: row.get(34)?,
            card_balance_cents: row.get(35)?,
            replayed: row.get::<_, i64>(36)? != 0,
            completed_at: row.get(37)?,
        }),
        None => None,
    };
    Ok(ReturnRecord {
        return_key: row.get(0)?,
        organization_id: row.get(1)?,
        branch_id: row.get(2)?,
        terminal_id: row.get(3)?,
        local_payment_id: row.get(4)?,
        remote_payment_id: row.get(5)?,
        local_order_id: row.get(6)?,
        remote_order_id: row.get(7)?,
        card_id: row.get(8)?,
        debit_transaction_id: row.get(9)?,
        redemption_key: row.get(10)?,
        currency: row.get(11)?,
        gross_cents: row.get(12)?,
        action: row.get(13)?,
        requested_cents: row.get(14)?,
        reason: row.get(15)?,
        staff_id: row.get(16)?,
        request_body: row.get(17)?,
        state: row.get(18)?,
        send_count: row.get(19)?,
        last_code: row.get(20)?,
        auth_required: row.get::<_, i64>(21)? != 0,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
        proof,
    })
}

fn load_record(conn: &Connection, key: &str) -> Result<Option<ReturnRecord>, String> {
    conn.query_row(
        &format!("SELECT {RECORD_COLUMNS} FROM gift_card_return_attempts WHERE return_key = ?1"),
        params![key],
        map_record,
    )
    .optional()
    .map_err(journal_err)
}

fn pending_for_payment(
    conn: &Connection,
    local_payment_id: &str,
) -> Result<Option<ReturnRecord>, String> {
    conn.query_row(
        &format!(
            "SELECT {RECORD_COLUMNS} FROM gift_card_return_attempts \
             WHERE local_payment_id = ?1 AND state = 'pending'"
        ),
        params![local_payment_id],
        map_record,
    )
    .optional()
    .map_err(journal_err)
}

fn record_in_scope(record: &ReturnRecord, scope: &OpeningScope) -> bool {
    same_uuid(&record.organization_id, &scope.organization_id)
        && same_uuid(&record.branch_id, &scope.branch_id)
        && record.terminal_id == scope.terminal_id
}

/// The live authority is the record's original operator in the record's scope.
fn owns(record: &ReturnRecord, actor: &ReturnAuthority) -> bool {
    record_in_scope(record, &actor.scope) && record.staff_id.eq_ignore_ascii_case(&actor.staff_id)
}

/// Generic authorization refusal. It never carries an attempt view.
fn auth_required(error: &str) -> Value {
    Refusal::new("GIFT_RETURN_AUTH_REQUIRED", error, "auth_required").into_value()
}

/// A pending original blocks another; only its own live operator sees which.
fn pending_exists(existing: &ReturnRecord, actor: &ReturnAuthority) -> Value {
    let mut refusal = Refusal::new(
        "GIFT_RETURN_PENDING_EXISTS",
        "This payment already has an unresolved gift card return; its original operator must recover it first",
        "pending",
    );
    if owns(existing, actor) {
        refusal.view = Some(view(existing));
    }
    refusal.into_value()
}

/// Renderer view. Carries no session, PIN, request body or server diagnostics.
fn view(record: &ReturnRecord) -> Value {
    json!({
        "returnKey": record.return_key,
        "localPaymentId": record.local_payment_id,
        "localOrderId": record.local_order_id,
        "action": record.action,
        "state": record.state,
        "currency": record.currency,
        "grossCents": record.gross_cents,
        "requestedCents": record.requested_cents,
        "reason": record.reason,
        "staffId": record.staff_id,
        "sendCount": record.send_count,
        "lastCode": record.last_code,
        "authRequired": record.auth_required,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "proof": record.proof.as_ref().map(|p| json!({
            "returnId": p.return_id,
            "paymentAdjustmentId": p.payment_adjustment_id,
            "returnedCents": p.returned_cents,
            "totalReturnedCents": p.total_returned_cents,
            "remainingCents": p.remaining_cents,
            "paymentStatus": p.payment_status,
            "orderPaymentStatus": p.order_payment_status,
            "orderRemainingCents": p.order_remaining_cents,
            "cardBalanceCents": p.card_balance_cents,
            "replayed": p.replayed,
            "completedAt": p.completed_at,
        })),
    })
}

fn completed_value(record: &ReturnRecord) -> Value {
    json!({
        "success": true,
        "contract": RETURN_CONTRACT,
        "outcome": "completed",
        "return": view(record),
    })
}

fn refused_value(record: &ReturnRecord) -> Value {
    let code = record.last_code.as_deref().unwrap_or("GIFT_RETURN_REFUSED");
    let mut refusal = Refusal::new(code, "The server refused this gift card return", "refused");
    refusal.view = Some(view(record));
    refusal.into_value()
}

fn with_record(conn: &Connection, key: &str, mut refusal: Refusal) -> Result<Value, String> {
    refusal.view = load_record(conn, key)?.as_ref().map(view);
    Ok(refusal.into_value())
}

fn note_code(
    conn: &Connection,
    key: &str,
    code: &str,
    auth_required: bool,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE gift_card_return_attempts
            SET last_code = ?2, auth_required = ?3, updated_at = ?4
          WHERE return_key = ?1 AND state = 'pending'",
        params![key, code, i64::from(auth_required), stamp(now)],
    )
    .map(|_| ())
    .map_err(journal_err)
}

fn mark_sent(conn: &Connection, key: &str, now: DateTime<Utc>) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE gift_card_return_attempts
                SET send_count = send_count + 1, last_sent_at = ?2, auth_required = 0,
                    updated_at = ?2
              WHERE return_key = ?1 AND state = 'pending'",
            params![key, stamp(now)],
        )
        .map_err(journal_err)?;
    if changed == 1 {
        Ok(())
    } else {
        Err("gift return journal: the pending original disappeared before sending".into())
    }
}

fn mark_refused(
    conn: &Connection,
    key: &str,
    code: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE gift_card_return_attempts
            SET state = 'refused', last_code = ?2, auth_required = 0, updated_at = ?3
          WHERE return_key = ?1 AND state = 'pending'",
        params![key, code, stamp(now)],
    )
    .map(|_| ())
    .map_err(journal_err)
}

// -- Original proof ----------------------------------------------------------

#[derive(Clone, Debug)]
struct Original {
    local_payment_id: String,
    remote_payment_id: String,
    local_order_id: String,
    remote_order_id: String,
    card_id: String,
    debit_transaction_id: String,
    redemption_key: String,
    currency: String,
    gross_cents: i64,
    payment_status: String,
}

struct JournalRow {
    redemption_key: String,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    local_order_id: String,
    remote_order_id: String,
    amount_cents: i64,
    currency: String,
    card_id: Option<String>,
    local_payment_id: Option<String>,
    remote_payment_id: Option<String>,
}

/// Proves the local gift row, its applied redemption journal entry, the card and
/// debit reference and the order mapping. The payment may already be returned;
/// capture checks `payment_status` separately.
fn load_original(
    conn: &Connection,
    scope: &OpeningScope,
    local_payment_id: &str,
) -> Result<Original, Refusal> {
    let store =
        |e: rusqlite::Error| Refusal::new("GIFT_RETURN_STORE_FAILED", journal_err(e), "rejected");
    let row = conn
        .query_row(
            "SELECT order_id, method, status, amount_cents, remote_payment_id, transaction_ref
               FROM order_payments WHERE id = ?1",
            params![local_payment_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(store)?;
    let Some((order_id, method, status, amount_cents, remote_payment_id, transaction_ref)) = row
    else {
        return Err(rejected(
            "GIFT_RETURN_ORIGINAL_NOT_FOUND",
            "The original gift card payment was not found",
        ));
    };
    let status = status.unwrap_or_default();
    if method.as_deref() != Some(crate::payments::GIFT_CARD_METHOD)
        || !matches!(status.as_str(), "completed" | "refunded" | "voided")
    {
        return Err(rejected(
            "GIFT_RETURN_ORIGINAL_NOT_RETURNABLE",
            "Only a completed gift card payment returns to its original card",
        ));
    }
    let gross_cents = amount_cents
        .filter(|cents| *cents > 0)
        .ok_or_else(unproven)?;
    let remote_payment_id = remote_payment_id
        .filter(|id| is_uuid(id))
        .ok_or_else(unproven)?;
    let debit_transaction_id = transaction_ref
        .as_deref()
        .and_then(|reference| reference.strip_prefix("gift_card:"))
        .filter(|tx| is_uuid(tx))
        .map(str::to_string)
        .ok_or_else(unproven)?;
    let mut stmt = conn
        .prepare(
            "SELECT idempotency_key, organization_id, branch_id, terminal_id, local_order_id,
                    remote_order_id, amount_cents, currency, card_id, local_payment_id,
                    remote_payment_id
               FROM gift_card_redemption_attempts
              WHERE status = 'applied'
                AND (local_payment_id = ?1 OR lower(remote_payment_id) = lower(?2))",
        )
        .map_err(store)?;
    let rows = stmt
        .query_map(params![local_payment_id, remote_payment_id], |row| {
            Ok(JournalRow {
                redemption_key: row.get(0)?,
                organization_id: row.get(1)?,
                branch_id: row.get(2)?,
                terminal_id: row.get(3)?,
                local_order_id: row.get(4)?,
                remote_order_id: row.get(5)?,
                amount_cents: row.get(6)?,
                currency: row.get(7)?,
                card_id: row.get(8)?,
                local_payment_id: row.get(9)?,
                remote_payment_id: row.get(10)?,
            })
        })
        .map_err(store)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(store)?;
    let [journal] = rows.as_slice() else {
        return Err(unproven());
    };
    let card_id = journal
        .card_id
        .as_deref()
        .filter(|id| is_uuid(id))
        .ok_or_else(unproven)?;
    let proven = journal.local_payment_id.as_deref() == Some(local_payment_id)
        && journal
            .remote_payment_id
            .as_deref()
            .is_some_and(|id| same_uuid(id, &remote_payment_id))
        && same_uuid(&journal.organization_id, &scope.organization_id)
        && same_uuid(&journal.branch_id, &scope.branch_id)
        && journal.terminal_id == scope.terminal_id
        && journal.local_order_id == order_id
        && journal.amount_cents == gross_cents
        && is_currency(&journal.currency)
        && is_uuid(&journal.remote_order_id);
    if !proven {
        return Err(unproven());
    }
    let mapped: Option<String> = conn
        .query_row(
            "SELECT supabase_id FROM orders WHERE id = ?1",
            params![order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(store)?
        .flatten();
    if !mapped
        .as_deref()
        .is_some_and(|id| same_uuid(id, &journal.remote_order_id))
    {
        return Err(unproven());
    }
    Ok(Original {
        local_payment_id: local_payment_id.to_string(),
        remote_payment_id,
        local_order_id: order_id,
        remote_order_id: journal.remote_order_id.clone(),
        card_id: card_id.to_string(),
        debit_transaction_id,
        redemption_key: journal.redemption_key.clone(),
        currency: journal.currency.to_ascii_uppercase(),
        gross_cents,
        payment_status: status,
    })
}

fn same_identity(original: &Original, record: &ReturnRecord) -> bool {
    original.local_payment_id == record.local_payment_id
        && same_uuid(&original.remote_payment_id, &record.remote_payment_id)
        && original.local_order_id == record.local_order_id
        && same_uuid(&original.remote_order_id, &record.remote_order_id)
        && same_uuid(&original.card_id, &record.card_id)
        && same_uuid(&original.debit_transaction_id, &record.debit_transaction_id)
        && original.redemption_key == record.redemption_key
        && original.currency.eq_ignore_ascii_case(&record.currency)
        && original.gross_cents == record.gross_cents
}

fn recheck_original(
    conn: &Connection,
    scope: &OpeningScope,
    record: &ReturnRecord,
) -> Result<Original, Refusal> {
    let original = load_original(conn, scope, &record.local_payment_id)?;
    if same_identity(&original, record) {
        Ok(original)
    } else {
        Err(unproven())
    }
}

/// Locally known cumulative return: the newest adopted proof or the local
/// adjustments, whichever is larger. Advisory; the server cap is final.
fn prior_returned_cents(conn: &Connection, local_payment_id: &str) -> Result<i64, String> {
    let journal: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(total_returned_cents), 0) FROM gift_card_return_attempts
              WHERE local_payment_id = ?1 AND state = 'completed'",
            params![local_payment_id],
            |row| row.get(0),
        )
        .map_err(journal_err)?;
    Ok(journal.max(adjusted_returned_cents(conn, local_payment_id)?))
}

/// Refund and void adjustments recorded locally against the payment.
fn adjusted_returned_cents(conn: &Connection, local_payment_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
           FROM payment_adjustments
          WHERE payment_id = ?1 AND adjustment_type IN ('refund', 'void')",
        params![local_payment_id],
        |row| row.get(0),
    )
    .map_err(journal_err)
}

/// Absolute cumulative the strict importer proved returned from one local gift
/// payment: the largest completed proof, or 0 when none completed; pending or
/// refused attempts prove nothing. Every completed proof is read strictly and
/// rechecked against the payment's current canonical gift mirror under the
/// scope stored on its immutable record (not the current operator's), and its
/// stored totals must fit that original. An unreadable, foreign or mismatched
/// proof is an error, never 0. Coverage readers take max(local adjustments,
/// floor), never the sum (`payments::effective_reversed_cents`), so an earlier
/// return made on another terminal counts once, also after its real adjustment
/// is imported.
pub(crate) fn proven_return_floor_cents(
    conn: &Connection,
    local_payment_id: &str,
    local_order_id: &str,
    gross_cents: i64,
) -> Result<i64, String> {
    let refuse = |why: &str| format!("gift return proof for payment {local_payment_id}: {why}");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RECORD_COLUMNS} FROM gift_card_return_attempts
              WHERE local_payment_id = ?1 AND state = 'completed'"
        ))
        .map_err(|e| refuse(&e.to_string()))?;
    let records = stmt
        .query_map(params![local_payment_id], map_record)
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| refuse(&e.to_string()))?;
    let mut floor = 0;
    for record in &records {
        let proof = record
            .proof
            .as_ref()
            .ok_or_else(|| refuse("completed without a proof"))?;
        if record.local_order_id != local_order_id || record.gross_cents != gross_cents {
            return Err(refuse("bound to another order or amount"));
        }
        let scope = OpeningScope {
            organization_id: record.organization_id.clone(),
            branch_id: record.branch_id.clone(),
            terminal_id: record.terminal_id.clone(),
        };
        recheck_original(conn, &scope, record).map_err(|refusal| refuse(&refusal.code))?;
        if !proof_fits(record, proof) {
            return Err(refuse("stored totals do not fit the original"));
        }
        floor = floor.max(proof.total_returned_cents);
    }
    Ok(floor)
}

/// The stored proof arithmetic `parse_result` accepted, rechecked against the
/// record's original.
fn proof_fits(record: &ReturnRecord, proof: &ReturnProof) -> bool {
    let gross = record.gross_cents;
    let (returned, total) = (proof.returned_cents, proof.total_returned_cents);
    (1..=gross).contains(&returned)
        && (returned..=gross).contains(&total)
        && proof.remaining_cents == gross - total
        && match record.action.as_str() {
            "void" => returned == gross && total == gross,
            _ => Some(returned) == record.requested_cents,
        }
}

/// Checks every completed proof a gift card row of this order carries through
/// [`proven_return_floor_cents`], so a reader aggregating
/// [`PROVEN_RETURN_FLOOR_SQL`] fails closed on a corrupt or foreign proof
/// instead of skipping it. An order without gift card rows reads no journal.
pub(crate) fn check_order_return_proofs(
    conn: &Connection,
    local_order_id: &str,
) -> Result<(), String> {
    let refuse = |e: rusqlite::Error| format!("gift return proofs for order {local_order_id}: {e}");
    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0)
               FROM order_payments
              WHERE order_id = ?1 AND method = 'gift_card'",
        )
        .map_err(refuse)?;
    let payments = stmt
        .query_map(params![local_order_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(refuse)?;
    for (payment_id, gross_cents) in payments {
        proven_return_floor_cents(conn, &payment_id, local_order_id, gross_cents)?;
    }
    Ok(())
}

/// [`proven_return_floor_cents`] for an `order_payments op` row inside
/// aggregate SQL. The fragment only projects the maximum and skips a proof it
/// cannot bind, so every reader using it first validates the same rows through
/// [`check_order_return_proofs`].
pub(crate) const PROVEN_RETURN_FLOOR_SQL: &str =
    "(CASE WHEN op.method = 'gift_card' THEN COALESCE((
    SELECT MAX(gr.total_returned_cents) FROM gift_card_return_attempts gr
     WHERE gr.local_payment_id = op.id AND gr.state = 'completed'
       AND gr.local_order_id = op.order_id
       AND gr.gross_cents = COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0)
), 0) ELSE 0 END)";

// -- Requests ----------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Refund,
    Void,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Action::Refund => "refund",
            Action::Void => "void",
        }
    }
}

#[derive(Debug)]
struct BeginRequest {
    local_payment_id: String,
    action: Action,
    amount_cents: Option<i64>,
    reason: String,
}

enum StatusFilter {
    All,
    Payment(String),
    Key(String),
}

fn object<'a>(payload: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, Refusal> {
    let Some(obj) = payload.as_object() else {
        return Err(invalid("The request must be an object"));
    };
    if obj.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("The request contains an unsupported field"));
    }
    Ok(obj)
}

fn local_payment_id(value: Option<&Value>) -> Result<String, Refusal> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .map(str::to_string)
        .ok_or_else(|| invalid("localPaymentId is required"))
}

fn return_key(value: Option<&Value>) -> Result<String, Refusal> {
    value
        .and_then(Value::as_str)
        .filter(|key| is_uuid(key))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| invalid("returnKey must be a gift card return key"))
}

fn parse_authorize(payload: &Value) -> Result<String, Refusal> {
    let obj = object(payload, &["staffId", "pin"])?;
    let staff_id = obj
        .get("staffId")
        .and_then(Value::as_str)
        .filter(|id| is_uuid(id))
        .ok_or_else(|| invalid("staffId is required"))?;
    if !obj
        .get("pin")
        .and_then(Value::as_str)
        .is_some_and(|pin| !pin.is_empty())
    {
        return Err(invalid("pin is required"));
    }
    Ok(staff_id.to_string())
}

fn parse_begin(payload: &Value) -> Result<BeginRequest, Refusal> {
    let obj = object(
        payload,
        &["localPaymentId", "action", "amountCents", "reason"],
    )?;
    let local_payment_id = local_payment_id(obj.get("localPaymentId"))?;
    let action = match obj.get("action").and_then(Value::as_str) {
        Some("refund") => Action::Refund,
        Some("void") => Action::Void,
        _ => return Err(invalid("action must be refund or void")),
    };
    let amount_cents = match obj.get("amountCents") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_i64()
                .filter(|cents| (1..=MAX_AMOUNT_CENTS).contains(cents))
                .ok_or_else(|| invalid("amountCents must be a positive integer number of cents"))?,
        ),
    };
    match (action, amount_cents) {
        (Action::Refund, None) => return Err(invalid("amountCents is required for a refund")),
        (Action::Void, Some(_)) => {
            return Err(invalid(
                "A void returns the whole payment; omit amountCents",
            ))
        }
        _ => {}
    }
    let reason = obj
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| (1..=MAX_REASON_CHARS).contains(&reason.chars().count()))
        .ok_or_else(|| invalid("reason must contain 1 to 500 characters"))?;
    Ok(BeginRequest {
        local_payment_id,
        action,
        amount_cents,
        reason: reason.to_string(),
    })
}

fn parse_status(payload: &Value) -> Result<StatusFilter, Refusal> {
    if payload.is_null() {
        return Ok(StatusFilter::All);
    }
    let obj = object(payload, &["localPaymentId", "returnKey"])?;
    match (obj.get("localPaymentId"), obj.get("returnKey")) {
        (None, None) => Ok(StatusFilter::All),
        (Some(id), None) => local_payment_id(Some(id)).map(StatusFilter::Payment),
        (None, Some(key)) => return_key(Some(key)).map(StatusFilter::Key),
        _ => Err(invalid("Use either localPaymentId or returnKey")),
    }
}

/// Exact server body, stored once and resent unchanged.
fn request_body(request: &BeginRequest, key: &str) -> String {
    match request.action {
        Action::Refund => json!({
            "action": "refund",
            "amount_cents": request.amount_cents,
            "reason": request.reason,
            "idempotency_key": key,
        }),
        Action::Void => {
            json!({ "action": "void", "reason": request.reason, "idempotency_key": key })
        }
    }
    .to_string()
}

// -- Server reply ------------------------------------------------------------

fn text<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn int(obj: &Map<String, Value>, key: &str) -> Option<i64> {
    obj.get(key).and_then(Value::as_i64)
}

fn ensure(condition: bool, what: &'static str) -> Result<(), &'static str> {
    if condition {
        Ok(())
    } else {
        Err(what)
    }
}

fn uuid_eq(value: Option<&str>, expected: &str) -> bool {
    value.is_some_and(|value| same_uuid(value, expected))
}

/// Strict parse of the flat `{ success: true, ...GiftCardReturnResult }` route
/// envelope, bound to the captured original. Unknown extra fields are ignored.
fn parse_result(value: &Value, record: &ReturnRecord) -> Result<ReturnProof, &'static str> {
    let obj = value.as_object().ok_or("reply")?;
    ensure(obj.get("success") == Some(&Value::Bool(true)), "success")?;
    ensure(
        text(obj, "action") == Some(record.action.as_str()),
        "action",
    )?;
    ensure(
        uuid_eq(text(obj, "original_payment_id"), &record.remote_payment_id),
        "original payment",
    )?;
    ensure(
        uuid_eq(
            text(obj, "original_transaction_id"),
            &record.debit_transaction_id,
        ),
        "original transaction",
    )?;
    ensure(uuid_eq(text(obj, "gift_card_id"), &record.card_id), "card")?;
    ensure(
        uuid_eq(text(obj, "order_id"), &record.remote_order_id),
        "order",
    )?;
    let currency = text(obj, "currency")
        .filter(|c| is_currency(c) && c.eq_ignore_ascii_case(&record.currency))
        .ok_or("currency")?;
    let gross = record.gross_cents;
    ensure(
        int(obj, "original_amount_cents") == Some(gross),
        "original amount",
    )?;
    let returned = int(obj, "returned_amount_cents")
        .filter(|v| (1..=gross).contains(v))
        .ok_or("returned")?;
    let total = int(obj, "total_returned_amount_cents")
        .filter(|v| (returned..=gross).contains(v))
        .ok_or("total returned")?;
    let remaining = int(obj, "remaining_amount_cents")
        .filter(|v| *v == gross - total)
        .ok_or("remaining")?;
    match record.action.as_str() {
        "void" => ensure(returned == gross && total == gross, "void amount")?,
        _ => ensure(Some(returned) == record.requested_cents, "refund amount")?,
    }
    let return_id = text(obj, "return_id")
        .filter(|v| is_uuid(v))
        .ok_or("return id")?;
    let reversal = text(obj, "reversal_transaction_id")
        .filter(|v| is_uuid(v))
        .ok_or("reversal id")?;
    let adjustment = text(obj, "payment_adjustment_id")
        .filter(|v| is_uuid(v))
        .ok_or("adjustment id")?;
    let fresh = [return_id, reversal, adjustment];
    let known = [
        record.remote_payment_id.as_str(),
        record.debit_transaction_id.as_str(),
        record.card_id.as_str(),
        record.remote_order_id.as_str(),
    ];
    for (index, id) in fresh.iter().enumerate() {
        let clashes = fresh[index + 1..]
            .iter()
            .chain(known.iter())
            .any(|other| id.eq_ignore_ascii_case(other));
        ensure(!clashes, "distinct identities")?;
    }
    let replayed = obj
        .get("replayed")
        .and_then(Value::as_bool)
        .ok_or("replayed")?;
    let created_at = text(obj, "created_at")
        .filter(|v| DateTime::parse_from_rfc3339(v).is_ok())
        .ok_or("created at")?;

    let payment = obj
        .get("payment")
        .and_then(Value::as_object)
        .ok_or("payment")?;
    let payment_status = if remaining > 0 {
        "completed"
    } else if record.action == "void" {
        "voided"
    } else {
        "refunded"
    };
    ensure(
        uuid_eq(text(payment, "id"), &record.remote_payment_id),
        "payment id",
    )?;
    ensure(
        text(payment, "status") == Some(payment_status),
        "payment status",
    )?;
    ensure(
        int(payment, "amount_cents") == Some(gross),
        "payment amount",
    )?;
    ensure(
        int(payment, "reversed_amount_cents") == Some(total),
        "payment reversed",
    )?;
    ensure(
        text(payment, "currency").is_some_and(|c| c.eq_ignore_ascii_case(currency)),
        "payment currency",
    )?;

    let card = obj.get("card").and_then(Value::as_object).ok_or("card")?;
    ensure(uuid_eq(text(card, "id"), &record.card_id), "card id")?;
    let card_balance = int(card, "balance_cents")
        .filter(|v| *v >= 0)
        .ok_or("card balance")?;
    ensure(
        text(card, "currency").is_some_and(|c| c.eq_ignore_ascii_case(currency)),
        "card currency",
    )?;
    ensure(text(card, "status").is_some(), "card status")?;
    ensure(
        matches!(
            card.get("card_number_last4"),
            Some(Value::Null | Value::String(_))
        ),
        "card last4",
    )?;

    let order = obj.get("order").and_then(Value::as_object).ok_or("order")?;
    ensure(
        uuid_eq(text(order, "order_id"), &record.remote_order_id),
        "order id",
    )?;
    let order_total = int(order, "order_total_cents")
        .filter(|v| *v >= 0)
        .ok_or("order total")?;
    let order_paid = int(order, "paid_total_cents")
        .filter(|v| *v >= 0)
        .ok_or("order paid")?;
    let order_remaining = int(order, "remaining_cents")
        .filter(|v| *v == (order_total - order_paid).max(0))
        .ok_or("order remaining")?;
    let order_status = text(order, "payment_status")
        .filter(|s| matches!(*s, "pending" | "partially_paid" | "paid"))
        .ok_or("order status")?;
    ensure(
        matches!(
            order.get("payment_method"),
            Some(Value::Null | Value::String(_))
        ),
        "order method",
    )?;

    Ok(ReturnProof {
        return_id: return_id.to_ascii_lowercase(),
        reversal_transaction_id: reversal.to_ascii_lowercase(),
        payment_adjustment_id: adjustment.to_ascii_lowercase(),
        returned_cents: returned,
        total_returned_cents: total,
        remaining_cents: remaining,
        payment_status: payment_status.to_string(),
        order_total_cents: order_total,
        order_paid_cents: order_paid,
        order_remaining_cents: order_remaining,
        order_payment_status: order_status.to_string(),
        card_balance_cents: card_balance,
        replayed,
        completed_at: created_at.to_string(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    AuthRequired,
    Refused,
    Unknown,
}

/// Business refusals raised after the server's idempotency replay mean this key
/// never committed. Deterministic refusals raised before the replay are only
/// definitive on the first send; a resend could hide an earlier commit.
fn classify_failure(
    status: Option<u16>,
    code: Option<&str>,
    transport: bool,
    first_send: bool,
) -> Failure {
    if transport {
        return Failure::Unknown;
    }
    let code = code.map(|c| c.strip_prefix("GIFT_CARD_").unwrap_or(c));
    if status == Some(401)
        || matches!(
            code,
            Some("STAFF_SESSION_REQUIRED" | "STAFF_SESSION_EXPIRED" | "STAFF_SESSION_INVALID")
        )
    {
        return Failure::AuthRequired;
    }
    if !status.is_some_and(|s| (400..500).contains(&s)) {
        return Failure::Unknown;
    }
    match code {
        Some(
            "PAYMENT_ALREADY_REVERSED" | "VOID_AFTER_PARTIAL_RETURN" | "RETURN_EXCEEDS_REMAINING",
        ) => Failure::Refused,
        Some(
            "PERMISSION_REQUIRED"
            | "STAFF_FORBIDDEN"
            | "RETURN_INVALID"
            | "PAYMENT_NOT_FOUND"
            | "ORDER_NOT_FOUND"
            | "TERMINAL_REQUIRED",
        ) if first_send => Failure::Refused,
        _ => Failure::Unknown,
    }
}

fn safe_code(code: Option<&str>) -> Option<&str> {
    code.filter(|c| {
        !c.is_empty()
            && c.len() <= 64
            && c.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    })
}

// -- Adoption ----------------------------------------------------------------

/// Applies a proved return atomically: server adjustment, the one original gift
/// payment update (full returns only) and canonical order coverage. Any error
/// rolls everything back and leaves the original pending for an exact retry.
fn adopt(
    conn: &Connection,
    scope: &OpeningScope,
    key: &str,
    proof: &ReturnProof,
    now: DateTime<Utc>,
) -> Result<ReturnRecord, Refusal> {
    let import = |_: String| {
        Refusal::new(
            "GIFT_RETURN_IMPORT_FAILED",
            "The proven return could not be applied locally; it stays pending",
            "pending",
        )
    };
    let sql = |e: rusqlite::Error| import(e.to_string());
    let stale = || {
        Refusal::new(
            "GIFT_RETURN_PROOF_STALE",
            "The server proof is older than the local return history",
            "pending",
        )
    };
    let tx = conn.unchecked_transaction().map_err(sql)?;
    let record = load_record(&tx, key)
        .map_err(import)?
        .ok_or_else(|| import(String::new()))?;
    if record.state == "completed" {
        return match &record.proof {
            Some(existing) if existing.return_id.eq_ignore_ascii_case(&proof.return_id) => {
                Ok(record)
            }
            _ => Err(stale()),
        };
    }
    if record.state != "pending" {
        return Err(stale());
    }
    let original = recheck_original(&tx, scope, &record).map_err(Refusal::pending)?;
    let prior = prior_returned_cents(&tx, &record.local_payment_id).map_err(import)?;
    if proof.total_returned_cents < prior + proof.returned_cents {
        return Err(stale());
    }
    // A larger canonical total means earlier returns this terminal never
    // recorded (for example on another terminal). Only this return's own
    // adjustment is imported and no earlier refund is invented: the completed
    // proof becomes the payment's absolute return floor, which coverage reads
    // as max(local adjustments, floor), so those earlier returns count once.
    let at = stamp(now);
    tx.execute(
        "INSERT INTO payment_adjustments (
            id, payment_id, order_id, adjustment_type, amount, amount_cents, reason, staff_id,
            sync_state, idempotency_key, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'applied', ?9, ?10, ?10)",
        params![
            proof.payment_adjustment_id,
            record.local_payment_id,
            record.local_order_id,
            record.action,
            proof.returned_cents as f64 / 100.0,
            proof.returned_cents,
            record.reason,
            record.staff_id,
            record.return_key,
            at,
        ],
    )
    .map_err(sql)?;
    if proof.remaining_cents == 0 {
        if original.payment_status == "completed" {
            let changed = if record.action == "void" {
                tx.execute(
                    "UPDATE order_payments
                        SET status = 'voided', voided_at = ?2, voided_by = ?3, void_reason = ?4, updated_at = ?2
                      WHERE id = ?1 AND status = 'completed'",
                    params![record.local_payment_id, at, record.staff_id, record.reason],
                )
            } else {
                tx.execute(
                    "UPDATE order_payments SET status = 'refunded', updated_at = ?2
                      WHERE id = ?1 AND status = 'completed'",
                    params![record.local_payment_id, at],
                )
            }
            .map_err(sql)?;
            if changed != 1 {
                return Err(import(String::new()));
            }
        } else if original.payment_status != proof.payment_status {
            return Err(import(String::new()));
        }
    } else if original.payment_status != "completed" {
        return Err(import(String::new()));
    }
    // Completed before the header recompute so coverage reads the new floor;
    // the adjustment, proof and header commit together or not at all.
    let changed = tx
        .execute(
            "UPDATE gift_card_return_attempts
                SET state = 'completed', last_code = NULL, auth_required = 0, return_id = ?2,
                    reversal_transaction_id = ?3, payment_adjustment_id = ?4, returned_cents = ?5,
                    total_returned_cents = ?6, remaining_cents = ?7, payment_status = ?8,
                    order_total_cents = ?9, order_paid_cents = ?10, order_remaining_cents = ?11,
                    order_payment_status = ?12, card_balance_cents = ?13, replayed = ?14,
                    completed_at = ?15, updated_at = ?16
              WHERE return_key = ?1 AND state = 'pending'",
            params![
                key,
                proof.return_id,
                proof.reversal_transaction_id,
                proof.payment_adjustment_id,
                proof.returned_cents,
                proof.total_returned_cents,
                proof.remaining_cents,
                proof.payment_status,
                proof.order_total_cents,
                proof.order_paid_cents,
                proof.order_remaining_cents,
                proof.order_payment_status,
                proof.card_balance_cents,
                i64::from(proof.replayed),
                proof.completed_at,
                at,
            ],
        )
        .map_err(sql)?;
    if changed != 1 {
        return Err(import(String::new()));
    }
    crate::payments::recompute_order_payment_state(
        &tx,
        &record.local_order_id,
        &at,
        &record.local_payment_id,
    )
    .map_err(import)?;
    tx.commit().map_err(sql)?;
    load_record(conn, key)
        .map_err(import)?
        .ok_or_else(|| import(String::new()))
}

// -- Dispatch ----------------------------------------------------------------

struct InFlight(String);

fn in_flight() -> MutexGuard<'static, HashSet<String>> {
    static KEYS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    KEYS.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

impl InFlight {
    fn acquire(key: &str) -> Option<Self> {
        in_flight()
            .insert(key.to_string())
            .then(|| Self(key.to_string()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        in_flight().remove(&self.0);
    }
}

fn lock(db: &db::DbState) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| format!("lock: {e}"))
}

/// Sends (or resends) one captured original with its stored key and body under
/// a live authority of the recorded operator, then publishes the outcome.
async fn dispatch(db: &db::DbState, key: &str) -> Result<Value, String> {
    let Some(_in_flight) = InFlight::acquire(key) else {
        return Ok(Refusal::new(
            "GIFT_RETURN_IN_FLIGHT",
            "This gift card return is already being sent",
            "pending",
        )
        .into_value());
    };
    let endpoint = crate::resolve_admin_endpoint(Some(db)).await;
    let (record, scope, authority, body, url, api_key) = {
        let conn = lock(db)?;
        let now = Utc::now();
        let Some(scope) = opening::trusted_scope(&conn) else {
            return Ok(scope_unavailable());
        };
        let record = match load_record(&conn, key)? {
            Some(record) if record_in_scope(&record, &scope) => record,
            _ => return Ok(not_found()),
        };
        // Whatever its state, only the live original operator sees or sends it.
        let Some(authority) = live_authority(&scope, Some(&record.staff_id), now) else {
            return Ok(auth_required(
                "The original operator must authorize to view or recover this gift card return",
            ));
        };
        match record.state.as_str() {
            "completed" => return Ok(completed_value(&record)),
            "refused" => return Ok(refused_value(&record)),
            _ => {}
        }
        if let Err(refusal) = recheck_original(&conn, &scope, &record) {
            note_code(&conn, key, &refusal.code, false, now)?;
            return with_record(&conn, key, refusal.pending());
        }
        let Ok(body) = serde_json::from_str::<Value>(&record.request_body) else {
            note_code(&conn, key, "GIFT_RETURN_STORE_FAILED", false, now)?;
            let refusal = Refusal::new(
                "GIFT_RETURN_STORE_FAILED",
                "The stored return request is unreadable",
                "pending",
            );
            return with_record(&conn, key, refusal);
        };
        let Ok((url, api_key)) = endpoint else {
            note_code(&conn, key, "GIFT_RETURN_NOT_CONFIGURED", false, now)?;
            let refusal = Refusal::new(
                "GIFT_RETURN_NOT_CONFIGURED",
                "The terminal is not connected to the admin service; the return stays pending",
                "pending",
            );
            return with_record(&conn, key, refusal);
        };
        mark_sent(&conn, key, now)?;
        (record, scope, authority, body, url, api_key)
    };
    let path = format!(
        "/api/pos/gift-cards/redemptions/{}/reverse",
        record.remote_payment_id
    );
    let reply = api::fetch_from_admin_detailed_with_staff_session(
        &url,
        &api_key,
        &path,
        "POST",
        Some(body),
        Some(authority.session_id.as_str()),
        std::time::Duration::from_secs(RETURN_TIMEOUT_SECS),
    )
    .await;
    let first_send = record.send_count == 0;

    let conn = lock(db)?;
    let now = Utc::now();
    if opening::trusted_scope(&conn).as_ref() != Some(&scope) {
        note_code(&conn, key, "GIFT_RETURN_SCOPE_CHANGED", false, now)?;
        return Ok(Refusal::new(
            "GIFT_RETURN_SCOPE_CHANGED",
            "The terminal scope changed during the return; it stays pending",
            "pending",
        )
        .into_value());
    }
    // Publication fence: a reply reaches the renderer only while the authority
    // captured for this send is still current. Otherwise the original stays
    // retained with its key and body for its own operator, and nothing about it
    // is published.
    // Serialize the synchronous adoption and response construction with lifecycle
    // clear/replacement. The guard starts after HTTP; it never crosses an await.
    // A clear that already won suppresses this reply; otherwise publication
    // linearizes before the clear (the renderer also fences later IPC delivery).
    let mut publication = return_auth();
    let current = still_current(&publication, &authority, Utc::now());
    let ended = "The authorization changed or expired during the return; the original operator can recover it after authorizing again";
    match reply {
        Ok(value) => {
            if !current {
                note_code(&conn, key, "GIFT_RETURN_AUTH_REQUIRED", true, now)?;
                return Ok(auth_required(ended));
            }
            let proof = match parse_result(&value, &record) {
                Ok(proof) => proof,
                Err(_) => {
                    note_code(&conn, key, "GIFT_RETURN_RESULT_MALFORMED", false, now)?;
                    let refusal = Refusal::new(
                        "GIFT_RETURN_RESULT_MALFORMED",
                        "The server reply could not be proven; the return stays pending",
                        "pending",
                    );
                    return with_record(&conn, key, refusal);
                }
            };
            match adopt(&conn, &scope, key, &proof, now) {
                Ok(done) => Ok(completed_value(&done)),
                Err(refusal) => {
                    note_code(&conn, key, &refusal.code, false, now)?;
                    with_record(&conn, key, refusal.pending())
                }
            }
        }
        Err(error) => {
            // The durable classification is recorded as before; only its
            // publication is fenced.
            let server_code = safe_code(error.code()).map(str::to_string);
            let refusal = match classify_failure(
                error.status(),
                server_code.as_deref(),
                error.is_transport_failure(),
                first_send,
            ) {
                Failure::AuthRequired => {
                    drop_authority(&mut publication, authority.generation);
                    let code = server_code.unwrap_or_else(|| "GIFT_RETURN_AUTH_REQUIRED".into());
                    note_code(&conn, key, &code, true, now)?;
                    Refusal::new(
                        &code,
                        "The staff session ended; the original operator must authorize again",
                        "auth_required",
                    )
                }
                Failure::Refused => {
                    let code = server_code.unwrap_or_else(|| "GIFT_RETURN_REFUSED".into());
                    mark_refused(&conn, key, &code, now)?;
                    Refusal::new(&code, "The server refused this gift card return", "refused")
                }
                Failure::Unknown => {
                    let code = server_code.unwrap_or_else(|| "GIFT_RETURN_OUTCOME_UNKNOWN".into());
                    note_code(&conn, key, &code, false, now)?;
                    Refusal::new(
                        &code,
                        "The return outcome is unknown; it stays pending and can be recovered",
                        "pending",
                    )
                }
            };
            if current {
                with_record(&conn, key, refusal)
            } else {
                Ok(auth_required(ended))
            }
        }
    }
}

// -- Commands ----------------------------------------------------------------

async fn authorize(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let staff_id = match parse_authorize(payload) {
        Ok(staff_id) => staff_id,
        Err(refusal) => return Ok(refusal.into_value()),
    };
    let scope = {
        let conn = lock(db)?;
        match opening::trusted_scope(&conn) {
            Some(scope) => scope,
            None => return Ok(scope_unavailable()),
        }
    };
    let fence = capture_fence();
    let session = match opening::issue_selected_staff_session(db, &scope, &staff_id, payload).await
    {
        Ok(session) => session,
        Err(error) => {
            return Ok(Refusal::new(error.code, error.message, "auth_required").into_value())
        }
    };
    if !session.staff_id().eq_ignore_ascii_case(&staff_id) {
        return Ok(Refusal::new(
            "GIFT_RETURN_AUTH_REQUIRED",
            "The hosted check-in returned a different operator",
            "auth_required",
        )
        .into_value());
    }
    let conn = lock(db)?;
    if opening::trusted_scope(&conn).as_ref() != Some(&scope) {
        return Ok(rejected(
            "GIFT_RETURN_SCOPE_CHANGED",
            "The terminal scope changed during authorization",
        )
        .into_value());
    }
    match install_authority(
        fence,
        scope,
        &staff_id,
        session.staff_session_header(),
        session.usable_until(),
        Utc::now(),
    ) {
        Ok(until) => Ok(json!({
            "success": true,
            "contract": RETURN_CONTRACT,
            "staffId": staff_id,
            "usableUntil": stamp(until),
        })),
        Err((code, message)) => Ok(Refusal::new(code, message, "auth_required").into_value()),
    }
}

async fn begin(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let request = match parse_begin(payload) {
        Ok(request) => request,
        Err(refusal) => return Ok(refusal.into_value()),
    };
    let key =
        {
            let conn = lock(db)?;
            ensure_schemas(&conn)?;
            let now = Utc::now();
            let Some(scope) = opening::trusted_scope(&conn) else {
                return Ok(scope_unavailable());
            };
            let Some(authority) = live_authority(&scope, None, now) else {
                return Ok(Refusal::new(
                    "GIFT_RETURN_AUTH_REQUIRED",
                    "Authorize a staff member before returning to a gift card",
                    "auth_required",
                )
                .into_value());
            };
            let original = match load_original(&conn, &scope, &request.local_payment_id) {
                Ok(original) => original,
                Err(refusal) => return Ok(refusal.into_value()),
            };
            if let Some(existing) = pending_for_payment(&conn, &original.local_payment_id)? {
                return Ok(pending_exists(&existing, &authority));
            }
            let prior = prior_returned_cents(&conn, &original.local_payment_id)?;
            let remaining = original.gross_cents - prior;
            if original.payment_status != "completed" || remaining <= 0 {
                return Ok(rejected(
                    "GIFT_RETURN_ALREADY_RETURNED",
                    "This gift card payment was already returned",
                )
                .into_value());
            }
            match (request.action, request.amount_cents) {
                (Action::Void, _) if prior > 0 => return Ok(rejected(
                    "GIFT_RETURN_VOID_AFTER_PARTIAL",
                    "A partly returned gift card payment cannot be voided; refund the remainder",
                )
                .into_value()),
                (Action::Refund, Some(amount)) if amount > remaining => {
                    return Ok(rejected(
                        "GIFT_RETURN_EXCEEDS_REMAINING",
                        "The refund exceeds the amount still returnable to this card",
                    )
                    .into_value())
                }
                _ => {}
            }
            let key = Uuid::new_v4().to_string();
            let inserted = conn.execute(
                "INSERT INTO gift_card_return_attempts (
                return_key, organization_id, branch_id, terminal_id, local_payment_id,
                remote_payment_id, local_order_id, remote_order_id, card_id, debit_transaction_id,
                redemption_key, currency, gross_cents, action, requested_cents, reason, staff_id,
                request_body, state, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                       ?18, 'pending', ?19, ?19)",
                params![
                    key,
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    original.local_payment_id,
                    original.remote_payment_id,
                    original.local_order_id,
                    original.remote_order_id,
                    original.card_id,
                    original.debit_transaction_id,
                    original.redemption_key,
                    original.currency,
                    original.gross_cents,
                    request.action.as_str(),
                    request.amount_cents,
                    request.reason,
                    authority.staff_id,
                    request_body(&request, &key),
                    stamp(now),
                ],
            );
            if let Err(error) = inserted {
                if let Some(existing) = pending_for_payment(&conn, &original.local_payment_id)? {
                    return Ok(pending_exists(&existing, &authority));
                }
                return Ok(rejected("GIFT_RETURN_STORE_FAILED", &journal_err(error)).into_value());
            }
            key
        };
    dispatch(db, &key).await
}

async fn recover(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let key = match object(payload, &["returnKey"]).and_then(|obj| return_key(obj.get("returnKey")))
    {
        Ok(key) => key,
        Err(refusal) => return Ok(refusal.into_value()),
    };
    {
        let conn = lock(db)?;
        ensure_schemas(&conn)?;
        let Some(scope) = opening::trusted_scope(&conn) else {
            return Ok(scope_unavailable());
        };
        if !load_record(&conn, &key)?.is_some_and(|record| record_in_scope(&record, &scope)) {
            return Ok(not_found());
        }
    }
    dispatch(db, &key).await
}

/// The live operator's own attempts in its trusted scope. Nobody else's.
fn list_records(
    conn: &Connection,
    actor: &ReturnAuthority,
    filter: &StatusFilter,
) -> Result<Vec<ReturnRecord>, String> {
    let scope = &actor.scope;
    let (clause, extra) = match filter {
        StatusFilter::All => ("", None),
        StatusFilter::Payment(id) => (" AND local_payment_id = ?5", Some(id.as_str())),
        StatusFilter::Key(key) => (" AND return_key = ?5", Some(key.as_str())),
    };
    let sql = format!(
        "SELECT {RECORD_COLUMNS} FROM gift_card_return_attempts
          WHERE lower(organization_id) = lower(?1) AND lower(branch_id) = lower(?2)
            AND terminal_id = ?3 AND lower(staff_id) = lower(?4){clause}
          ORDER BY created_at DESC, rowid DESC LIMIT {STATUS_LIMIT}"
    );
    let mut stmt = conn.prepare(&sql).map_err(journal_err)?;
    let rows = match extra {
        Some(extra) => stmt.query_map(
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                actor.staff_id,
                extra
            ],
            map_record,
        ),
        None => stmt.query_map(
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                actor.staff_id
            ],
            map_record,
        ),
    }
    .map_err(journal_err)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(journal_err)?;
    Ok(rows
        .into_iter()
        .filter(|record| owns(record, actor))
        .collect())
}

/// Payment advisory. Anyone may learn that a pending original blocks the
/// payment; only its live original operator learns its key.
fn original_advisory(
    conn: &Connection,
    scope: &OpeningScope,
    local_payment_id: &str,
    actor: Option<&ReturnAuthority>,
) -> Result<Value, String> {
    let blocking = pending_for_payment(conn, local_payment_id)?
        .filter(|record| record_in_scope(record, scope));
    let pending_key = blocking
        .as_ref()
        .filter(|record| actor.is_some_and(|actor| owns(record, actor)))
        .map(|record| record.return_key.clone());
    Ok(match load_original(conn, scope, local_payment_id) {
        Ok(original) => {
            let prior = prior_returned_cents(conn, local_payment_id)?;
            let remaining = if original.payment_status == "completed" {
                (original.gross_cents - prior).max(0)
            } else {
                0
            };
            let code = if remaining == 0 {
                Some("GIFT_RETURN_ALREADY_RETURNED")
            } else if blocking.is_some() {
                Some("GIFT_RETURN_PENDING_EXISTS")
            } else {
                None
            };
            json!({
                "localPaymentId": local_payment_id,
                "eligible": code.is_none(),
                "code": code,
                "currency": original.currency,
                "grossCents": original.gross_cents,
                "returnedCents": original.gross_cents - remaining,
                "remainingCents": remaining,
                "pendingReturnKey": pending_key,
            })
        }
        Err(refusal) => json!({
            "localPaymentId": local_payment_id,
            "eligible": false,
            "code": refusal.code,
            "currency": null,
            "grossCents": null,
            "returnedCents": null,
            "remainingCents": null,
            "pendingReturnKey": pending_key,
        }),
    })
}

fn status(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let filter = match parse_status(payload) {
        Ok(filter) => filter,
        Err(refusal) => return Ok(refusal.into_value()),
    };
    let conn = lock(db)?;
    ensure_schemas(&conn)?;
    let Some(scope) = opening::trusted_scope(&conn) else {
        return Ok(scope_unavailable());
    };
    // Attempt details belong to the live original operator only. Without a
    // live authority the envelope stays useful but lists nothing.
    let actor = live_authority(&scope, None, Utc::now());
    let original = match &filter {
        StatusFilter::Payment(id) => original_advisory(&conn, &scope, id, actor.as_ref())?,
        _ => Value::Null,
    };
    let returns: Vec<Value> = match &actor {
        Some(actor) => list_records(&conn, actor, &filter)?
            .iter()
            .map(view)
            .collect(),
        None => Vec::new(),
    };
    Ok(json!({
        "success": true,
        "contract": RETURN_CONTRACT,
        "advisory": true,
        "authorization": authority_view(actor.as_ref()),
        "original": original,
        "returns": returns,
    }))
}

/// `gift-return:authorize` — `{ staffId, pin }` hosted check-in for the
/// separate return purpose. PIN and session stay native.
#[tauri::command]
pub async fn gift_return_authorize(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    authorize(db.inner(), &arg0.unwrap_or(Value::Null)).await
}

/// `gift-return:begin` — `{ localPaymentId, action, amountCents?, reason }`.
#[tauri::command]
pub async fn gift_return_begin(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    begin(db.inner(), &arg0.unwrap_or(Value::Null)).await
}

/// `gift-return:recover` — `{ returnKey }`; resends the stored original only.
#[tauri::command]
pub async fn gift_return_recover(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    recover(db.inner(), &arg0.unwrap_or(Value::Null)).await
}

/// `gift-return:status` — advisory discovery of the live operator's own
/// attempts in the trusted scope; never implies permission.
#[tauri::command]
pub async fn gift_return_status(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    status(db.inner(), &arg0.unwrap_or(Value::Null))
}

// -- Validators --------------------------------------------------------------

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36 && Uuid::parse_str(value).is_ok()
}

fn same_uuid(left: &str, right: &str) -> bool {
    is_uuid(left) && is_uuid(right) && left.eq_ignore_ascii_case(right)
}

fn is_currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|b| b.is_ascii_alphabetic())
}

#[cfg(test)]
#[path = "gift_card_returns_tests.rs"]
mod tests;
