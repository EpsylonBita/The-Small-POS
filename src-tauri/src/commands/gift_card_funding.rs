//! Windows funded gift card native core (`gift_funding_v1`).
//!
//! Every funding attempt is one immutable nonsecret SQLite row (schema v86),
//! committed before any funding request and before any physical collection.
//! Each request replays that row's exact original body under its original
//! idempotency key; the complete and cancel bodies are written once and then
//! replayed verbatim. Conditional, monotone state updates are the only claims,
//! so duplicate command calls and separate SQLite handles cannot collect
//! twice, credit twice or mint a new key. A restart retains every unknown
//! original for recovery.
//!
//! Authority is native and volatile. Cash and external-card attempts send the
//! original cashier's scoped hosted session (`gift_financial_opening`); a
//! manager grant sends a separately authorized manager session held here and
//! dropped by the same dedicated lifecycle clear. No staff session, PIN or raw
//! card number is persisted, logged or returned; the only exception is the
//! issued card number of a completed same-scope reply, returned once.
//!
//! Funding is stored value, not merchandise revenue: this module writes no
//! order, payment, fiscal, EFT or local drawer row. Cash drawer figures come
//! only from the server's pinned drawer projection, read by deliberately
//! replaying the original opening through `/api/pos/shifts/sync`.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::api::{self, AdminFetchError};
use crate::db;
use crate::gift_financial_opening::{
    self as opening, DispatchOutcome, HostedAccessError, HostedCashierScope, OpeningScope,
    OpeningState,
};

/// Shared `GIFT_CARD_FUNDING_CONTRACT`.
const FUNDING_CONTRACT: &str = "gift_funding_v1";
const INTENTS_PATH: &str = "/api/pos/gift-cards/funding/intents";
const GRANTS_PATH: &str = "/api/pos/gift-cards/funding/grants";
const SHIFT_SYNC_PATH: &str = "/api/pos/shifts/sync";
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_FUNDING_CENTS: i64 = 99_999_999;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
/// A manager grant authority serves one short purpose window.
const GRANT_AUTHORITY_SECS: i64 = 300;
const STATUS_LIMIT: i64 = 50;
/// Route refusal returned before any cash intent or transition is created.
const CASH_NOT_READY: &str = "GIFT_CARD_CASH_ACCOUNTING_REQUIRED";
const TERMINAL_STATES_SQL: &str = "('completed', 'canceled', 'refused', 'abandoned')";

/// Local schema v86: the immutable nonsecret funding attempt and its proof.
/// No PIN, staff session or raw card number has a column.
pub(crate) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS gift_card_funding_attempts (
    attempt_key TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('issue', 'reload')),
    mode TEXT NOT NULL
        CHECK (mode IN ('cash_confirmed', 'external_card_recorded', 'manager_grant')),
    card_id TEXT,
    amount_cents INTEGER NOT NULL
        CHECK (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 99999999),
    currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
    reason TEXT NOT NULL CHECK (length(reason) >= 1),
    drawer_id TEXT,
    shift_id TEXT,
    authority_opening_key TEXT,
    request_body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'prepare_pending' CHECK (state IN (
        'prepare_pending', 'prepared', 'collection_pending', 'collection_started',
        'complete_pending', 'cancel_pending', 'completed', 'canceled', 'refused', 'abandoned')),
    prepare_sends INTEGER NOT NULL DEFAULT 0 CHECK (prepare_sends >= 0),
    prepare_settled INTEGER NOT NULL DEFAULT 0
        CHECK (prepare_settled >= 0 AND prepare_settled <= prepare_sends),
    intent_id TEXT UNIQUE,
    owner_terminal_db_id TEXT,
    complete_body TEXT,
    cancel_body TEXT,
    server_state TEXT,
    result_card_id TEXT,
    credit_id TEXT UNIQUE,
    acknowledgement_id TEXT UNIQUE,
    card_balance_cents INTEGER,
    card_number_hash TEXT,
    evidence_json TEXT,
    completed_at TEXT,
    last_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((operation = 'reload') = (card_id IS NOT NULL)),
    CHECK ((mode = 'cash_confirmed') = (drawer_id IS NOT NULL AND shift_id IS NOT NULL)),
    CHECK (mode = 'cash_confirmed' OR (drawer_id IS NULL AND shift_id IS NULL)),
    CHECK ((mode = 'manager_grant') = (authority_opening_key IS NULL)),
    CHECK (mode <> 'manager_grant' OR state IN ('prepare_pending', 'completed', 'refused', 'abandoned')),
    CHECK (state IN ('prepare_pending', 'refused', 'abandoned') OR intent_id IS NOT NULL),
    CHECK (state NOT IN ('complete_pending', 'completed') OR mode = 'manager_grant' OR complete_body IS NOT NULL),
    CHECK (state <> 'cancel_pending' OR cancel_body IS NOT NULL),
    CHECK ((state = 'completed') = (credit_id IS NOT NULL)),
    CHECK (state <> 'completed' OR (result_card_id IS NOT NULL AND acknowledgement_id IS NOT NULL
        AND card_balance_cents IS NOT NULL AND card_number_hash IS NOT NULL
        AND evidence_json IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_gift_card_funding_attempts_scope
    ON gift_card_funding_attempts(terminal_id, state);
CREATE INDEX IF NOT EXISTS idx_gift_card_funding_attempts_shift
    ON gift_card_funding_attempts(shift_id);
CREATE TRIGGER IF NOT EXISTS trg_gift_card_funding_attempts_immutable
BEFORE UPDATE ON gift_card_funding_attempts
WHEN NEW.attempt_key IS NOT OLD.attempt_key
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.branch_id IS NOT OLD.branch_id
  OR NEW.terminal_id IS NOT OLD.terminal_id
  OR NEW.staff_id IS NOT OLD.staff_id
  OR NEW.operation IS NOT OLD.operation
  OR NEW.mode IS NOT OLD.mode
  OR NEW.card_id IS NOT OLD.card_id
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.currency IS NOT OLD.currency
  OR NEW.reason IS NOT OLD.reason
  OR NEW.drawer_id IS NOT OLD.drawer_id
  OR NEW.shift_id IS NOT OLD.shift_id
  OR NEW.authority_opening_key IS NOT OLD.authority_opening_key
  OR NEW.request_body IS NOT OLD.request_body
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.intent_id IS NOT NULL AND NEW.intent_id IS NOT OLD.intent_id)
  OR (OLD.owner_terminal_db_id IS NOT NULL AND NEW.owner_terminal_db_id IS NOT OLD.owner_terminal_db_id)
  OR (OLD.complete_body IS NOT NULL AND NEW.complete_body IS NOT OLD.complete_body)
  OR (OLD.cancel_body IS NOT NULL AND NEW.cancel_body IS NOT OLD.cancel_body)
  OR (OLD.result_card_id IS NOT NULL AND NEW.result_card_id IS NOT OLD.result_card_id)
  OR (OLD.credit_id IS NOT NULL AND NEW.credit_id IS NOT OLD.credit_id)
  OR (OLD.acknowledgement_id IS NOT NULL AND NEW.acknowledgement_id IS NOT OLD.acknowledgement_id)
  OR (OLD.card_balance_cents IS NOT NULL AND NEW.card_balance_cents IS NOT OLD.card_balance_cents)
  OR (OLD.card_number_hash IS NOT NULL AND NEW.card_number_hash IS NOT OLD.card_number_hash)
  OR (OLD.evidence_json IS NOT NULL AND NEW.evidence_json IS NOT OLD.evidence_json)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
  OR NEW.prepare_sends < OLD.prepare_sends
  OR NEW.prepare_settled < OLD.prepare_settled
  OR (OLD.state IN ('completed', 'canceled', 'refused', 'abandoned') AND NEW.state IS NOT OLD.state)
  OR (NEW.state IN ('refused', 'abandoned') AND OLD.state NOT IN ('prepare_pending', NEW.state))
  OR (NEW.state = 'collection_pending' AND OLD.state NOT IN ('prepared', 'collection_pending'))
  OR (NEW.state = 'collection_started' AND OLD.state NOT IN ('collection_pending', 'collection_started'))
  OR (NEW.state = 'complete_pending' AND OLD.state NOT IN ('collection_started', 'complete_pending'))
  OR (NEW.state = 'cancel_pending' AND OLD.state NOT IN ('prepared', 'cancel_pending'))
  OR (OLD.state = 'cancel_pending' AND NEW.state NOT IN ('cancel_pending', 'canceled'))
  OR (NEW.state = 'canceled' AND OLD.state NOT IN
        ('prepare_pending', 'prepared', 'collection_pending', 'cancel_pending', 'canceled'))
  OR (NEW.state = 'completed' AND OLD.state NOT IN ('complete_pending', 'completed')
        AND NOT (OLD.state = 'prepare_pending' AND OLD.mode = 'manager_grant'))
  OR (CASE NEW.state WHEN 'prepare_pending' THEN 0 WHEN 'prepared' THEN 1
        WHEN 'collection_pending' THEN 2 WHEN 'cancel_pending' THEN 2
        WHEN 'collection_started' THEN 3 WHEN 'complete_pending' THEN 4 ELSE 5 END)
   < (CASE OLD.state WHEN 'prepare_pending' THEN 0 WHEN 'prepared' THEN 1
        WHEN 'collection_pending' THEN 2 WHEN 'cancel_pending' THEN 2
        WHEN 'collection_started' THEN 3 WHEN 'complete_pending' THEN 4 ELSE 5 END)
BEGIN
    SELECT RAISE(ABORT, 'GIFT_FUNDING_ATTEMPT_IMMUTABLE');
END;
";

// ---------------------------------------------------------------------------
// Errors, values and the immutable attempt
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct FundingError {
    code: String,
    message: String,
}

impl FundingError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    /// Secret-free refusal; a retained attempt is included for recovery.
    fn to_value(&self, attempt: Option<&Attempt>) -> Value {
        let mut value = json!({ "success": false, "code": self.code, "error": self.message });
        if let Some(attempt) = attempt {
            value["attempt"] = attempt_view(attempt);
        }
        value
    }
}

fn local_error(error: impl fmt::Display) -> FundingError {
    warn!("gift funding local store failure: {error}");
    FundingError::new(
        "LOCAL_STORE_FAILED",
        "The local funding journal could not be read or written",
    )
}

fn not_found() -> FundingError {
    FundingError::new(
        "FUNDING_ATTEMPT_NOT_FOUND",
        "No funding attempt of this terminal has this key",
    )
}

fn scope_unavailable() -> FundingError {
    FundingError::new(
        "TERMINAL_SCOPE_UNAVAILABLE",
        "Terminal organization, branch and terminal identity are required",
    )
}

fn scope_changed() -> FundingError {
    FundingError::new(
        "FUNDING_SCOPE_CHANGED",
        "The terminal scope differs from the original attempt",
    )
}

fn not_configured() -> FundingError {
    FundingError::new(
        "TERMINAL_NOT_CONFIGURED",
        "Terminal admin connection is not configured",
    )
}

fn key_mismatch() -> FundingError {
    FundingError::new(
        "ATTEMPT_KEY_TUPLE_MISMATCH",
        "This attempt key belongs to a different original funding attempt",
    )
}

fn payload_mismatch() -> FundingError {
    FundingError::new(
        "FUNDING_PAYLOAD_MISMATCH",
        "The stored original body differs from its immutable attempt",
    )
}

fn hosted_refusal(error: HostedAccessError) -> FundingError {
    let (code, message) = match error {
        HostedAccessError::NoOriginalOpening => (
            "FINANCIAL_OPENING_REQUIRED",
            "The selected cashier has no original financial opening on this terminal",
        ),
        HostedAccessError::OpeningPending => (
            "FINANCIAL_OPENING_PENDING",
            "The original financial opening is not confirmed yet",
        ),
        HostedAccessError::OpeningUnusable => (
            "OPENING_UNUSABLE",
            "The original financial opening is not usable",
        ),
        HostedAccessError::LocalShiftNotActive => (
            "ORIGINAL_DRAWER_CLOSED",
            "The original shift or drawer is no longer open; it never reopens",
        ),
        HostedAccessError::ReauthRequired => (
            opening::CODE_REAUTH_REQUIRED,
            "The original cashier must authorize again with their PIN",
        ),
        HostedAccessError::Expired => (
            "HOSTED_SESSION_EXPIRED",
            "The original cashier's hosted authorization expired; authorize again",
        ),
    };
    FundingError::new(code, message)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Cash,
    ExternalCard,
    ManagerGrant,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cash => "cash_confirmed",
            Self::ExternalCard => "external_card_recorded",
            Self::ManagerGrant => "manager_grant",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "cash_confirmed" => Some(Self::Cash),
            "external_card_recorded" => Some(Self::ExternalCard),
            "manager_grant" => Some(Self::ManagerGrant),
            _ => None,
        }
    }

    fn evidence_kind(self) -> &'static str {
        match self {
            Self::Cash => "operator_cash_confirmation",
            Self::ExternalCard => "external_card_recorded",
            Self::ManagerGrant => "manager_grant",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operation {
    Issue,
    Reload,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Reload => "reload",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "issue" => Some(Self::Issue),
            "reload" => Some(Self::Reload),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AttemptState {
    /// Recorded; the original POST may or may not have been sent.
    PreparePending,
    /// Prepare acknowledgement persisted; nothing collected.
    Prepared,
    /// begin_collection possibly sent; collection is not permitted yet.
    CollectionPending,
    /// begin acknowledgement persisted: the only state permitting collection.
    CollectionStarted,
    /// The stored complete body was possibly sent; never collect again.
    CompletePending,
    /// The stored never-collected cancel body was possibly sent.
    CancelPending,
    Completed,
    Canceled,
    Refused,
    /// Never possibly sent; closed locally.
    Abandoned,
}

impl AttemptState {
    fn as_str(self) -> &'static str {
        match self {
            Self::PreparePending => "prepare_pending",
            Self::Prepared => "prepared",
            Self::CollectionPending => "collection_pending",
            Self::CollectionStarted => "collection_started",
            Self::CompletePending => "complete_pending",
            Self::CancelPending => "cancel_pending",
            Self::Completed => "completed",
            Self::Canceled => "canceled",
            Self::Refused => "refused",
            Self::Abandoned => "abandoned",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "prepare_pending" => Self::PreparePending,
            "prepared" => Self::Prepared,
            "collection_pending" => Self::CollectionPending,
            "collection_started" => Self::CollectionStarted,
            "complete_pending" => Self::CompletePending,
            "cancel_pending" => Self::CancelPending,
            "completed" => Self::Completed,
            "canceled" => Self::Canceled,
            "refused" => Self::Refused,
            "abandoned" => Self::Abandoned,
            _ => return None,
        })
    }

    fn unresolved(self) -> bool {
        !matches!(
            self,
            Self::Completed | Self::Canceled | Self::Refused | Self::Abandoned
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServerState {
    Prepared,
    CollectionStarted,
    Completed,
    Canceled,
}

impl ServerState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::CollectionStarted => "collection_started",
            Self::Completed => "completed",
            Self::Canceled => "canceled",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "prepared" => Some(Self::Prepared),
            "collection_started" => Some(Self::CollectionStarted),
            "completed" => Some(Self::Completed),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }
}

/// The immutable original tuple of one attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Original {
    attempt_key: String,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    staff_id: String,
    operation: Operation,
    mode: Mode,
    card_id: Option<String>,
    amount_cents: i64,
    currency: String,
    reason: String,
    /// Cash only: the original drawer and shift.
    drawer_id: Option<String>,
    shift_id: Option<String>,
    /// Cash/external: the cashier original whose authority recorded it.
    authority_opening_key: Option<String>,
}

impl Original {
    /// The exact nonsecret original POST body. An issue never carries a
    /// custom or raw card number: the server derives the deterministic one.
    fn request_body(&self) -> Value {
        let mut body = json!({
            "contract": FUNDING_CONTRACT,
            "operation": self.operation.as_str(),
            "mode": self.mode.as_str(),
            "amount_cents": self.amount_cents,
            "currency": self.currency,
            "reason": self.reason,
            "idempotency_key": self.attempt_key,
        });
        if let Some(card_id) = &self.card_id {
            body["card_id"] = json!(card_id);
        }
        if let (Some(drawer_id), Some(shift_id)) = (&self.drawer_id, &self.shift_id) {
            body["drawer_id"] = json!(drawer_id);
            body["shift_id"] = json!(shift_id);
        }
        body
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Completion {
    card_id: String,
    credit_id: String,
    acknowledgement_id: String,
    card_balance_cents: i64,
    card_number_hash: String,
    evidence_json: String,
    completed_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Attempt {
    original: Original,
    request_body: String,
    state: AttemptState,
    prepare_sends: i64,
    intent_id: Option<String>,
    owner_terminal_db_id: Option<String>,
    complete_body: Option<String>,
    cancel_body: Option<String>,
    completion: Option<Completion>,
    last_code: Option<String>,
    created_at: String,
    updated_at: String,
}

const ATTEMPT_COLUMNS: &str = "attempt_key, organization_id, branch_id, terminal_id, staff_id, \
    operation, mode, card_id, amount_cents, currency, reason, drawer_id, shift_id, \
    authority_opening_key, request_body, state, prepare_sends, prepare_settled, intent_id, \
    owner_terminal_db_id, complete_body, cancel_body, server_state, result_card_id, credit_id, \
    acknowledgement_id, card_balance_cents, card_number_hash, evidence_json, completed_at, \
    last_code, created_at, updated_at";

fn attempt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attempt> {
    fn invalid(index: usize, name: &str) -> rusqlite::Error {
        rusqlite::Error::InvalidColumnType(index, name.into(), rusqlite::types::Type::Text)
    }
    let operation: String = row.get(5)?;
    let mode: String = row.get(6)?;
    let state: String = row.get(15)?;
    let completion = match (
        row.get::<_, Option<String>>(23)?,
        row.get::<_, Option<String>>(24)?,
        row.get::<_, Option<String>>(25)?,
        row.get::<_, Option<i64>>(26)?,
        row.get::<_, Option<String>>(27)?,
        row.get::<_, Option<String>>(28)?,
        row.get::<_, Option<String>>(29)?,
    ) {
        (
            Some(card_id),
            Some(credit_id),
            Some(acknowledgement_id),
            Some(card_balance_cents),
            Some(card_number_hash),
            Some(evidence_json),
            Some(completed_at),
        ) => Some(Completion {
            card_id,
            credit_id,
            acknowledgement_id,
            card_balance_cents,
            card_number_hash,
            evidence_json,
            completed_at,
        }),
        _ => None,
    };
    Ok(Attempt {
        original: Original {
            attempt_key: row.get(0)?,
            organization_id: row.get(1)?,
            branch_id: row.get(2)?,
            terminal_id: row.get(3)?,
            staff_id: row.get(4)?,
            operation: Operation::parse(&operation).ok_or_else(|| invalid(5, "operation"))?,
            mode: Mode::parse(&mode).ok_or_else(|| invalid(6, "mode"))?,
            card_id: row.get(7)?,
            amount_cents: row.get(8)?,
            currency: row.get(9)?,
            reason: row.get(10)?,
            drawer_id: row.get(11)?,
            shift_id: row.get(12)?,
            authority_opening_key: row.get(13)?,
        },
        request_body: row.get(14)?,
        state: AttemptState::parse(&state).ok_or_else(|| invalid(15, "state"))?,
        prepare_sends: row.get(16)?,
        intent_id: row.get(18)?,
        owner_terminal_db_id: row.get(19)?,
        complete_body: row.get(20)?,
        cancel_body: row.get(21)?,
        completion,
        last_code: row.get(30)?,
        created_at: row.get(31)?,
        updated_at: row.get(32)?,
    })
}

fn load_attempt(conn: &Connection, key: &str) -> Result<Option<Attempt>, String> {
    conn.query_row(
        &format!("SELECT {ATTEMPT_COLUMNS} FROM gift_card_funding_attempts WHERE attempt_key = ?1"),
        params![key],
        attempt_from_row,
    )
    .optional()
    .map_err(|e| format!("load funding attempt: {e}"))
}

fn scope_matches(scope: &OpeningScope, original: &Original) -> bool {
    same_uuid(&scope.organization_id, &original.organization_id)
        && same_uuid(&scope.branch_id, &original.branch_id)
        && scope.terminal_id == original.terminal_id
}

fn collection_permitted(attempt: &Attempt) -> bool {
    attempt.state == AttemptState::CollectionStarted
        && attempt.complete_body.is_none()
        && attempt.original.mode != Mode::ManagerGrant
}

/// Secret-free projection: no session, PIN or raw card number.
fn attempt_view(a: &Attempt) -> Value {
    let o = &a.original;
    json!({
        "attemptKey": o.attempt_key,
        "organizationId": o.organization_id,
        "branchId": o.branch_id,
        "terminalId": o.terminal_id,
        "staffId": o.staff_id,
        "operation": o.operation.as_str(),
        "mode": o.mode.as_str(),
        "cardId": o.card_id,
        "amountCents": o.amount_cents,
        "currency": o.currency,
        "reason": o.reason,
        "drawerId": o.drawer_id,
        "shiftId": o.shift_id,
        "state": a.state.as_str(),
        "intentId": a.intent_id,
        "unresolved": a.state.unresolved(),
        "possiblySent": a.prepare_sends > 0,
        // Collection is authorized by one explicit acknowledged begin reply,
        // never by reading or replaying this durable state.
        "collectionPermitted": false,
        "lastCode": a.last_code,
        "result": a.completion.as_ref().map(|c| json!({
            "cardId": c.card_id,
            "creditId": c.credit_id,
            "acknowledgementId": c.acknowledgement_id,
            "cardBalanceCents": c.card_balance_cents,
            "cardNumberHash": c.card_number_hash,
            "completedAt": c.completed_at,
        })),
        "verifiedCapture": false,
        "fiscalReceipt": false,
        "createdAt": a.created_at,
        "updatedAt": a.updated_at,
    })
}

fn attempt_response(attempt: &Attempt, card_number: Option<String>) -> Value {
    let mut response = json!({ "success": true, "attempt": attempt_view(attempt) });
    if let Some(number) = card_number {
        response["cardNumber"] = Value::String(number);
    }
    response
}

// ---------------------------------------------------------------------------
// Renderer requests
// ---------------------------------------------------------------------------

const PREPARE_KEYS: [&str; 8] = [
    "attemptKey",
    "staffId",
    "mode",
    "operation",
    "cardId",
    "amountCents",
    "currency",
    "reason",
];
const GRANT_KEYS: [&str; 7] = [
    "attemptKey",
    "staffId",
    "operation",
    "cardId",
    "amountCents",
    "currency",
    "reason",
];

struct FundingRequest {
    attempt_key: Option<String>,
    staff_id: String,
    mode: Mode,
    operation: Operation,
    card_id: Option<String>,
    amount_cents: i64,
    currency: String,
    reason: String,
}

impl FundingRequest {
    fn parse(payload: &Value, grant: bool) -> Result<Self, FundingError> {
        let invalid = |message: &str| FundingError::new("INVALID_FUNDING_REQUEST", message);
        let obj = payload
            .as_object()
            .ok_or_else(|| invalid("A funding request object is required"))?;
        let allowed: &[&str] = if grant { &GRANT_KEYS } else { &PREPARE_KEYS };
        if obj.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(invalid("The funding request carries an unsupported field"));
        }
        let mode = if grant {
            Mode::ManagerGrant
        } else {
            match obj.get("mode").and_then(Value::as_str) {
                Some("cash_confirmed") => Mode::Cash,
                Some("external_card_recorded") => Mode::ExternalCard,
                Some("manager_grant") => {
                    return Err(FundingError::new(
                        "MODE_REQUIRES_MANAGER_GRANT",
                        "A manager grant needs its own separately authorized manager",
                    ))
                }
                _ => {
                    return Err(FundingError::new(
                        "FUNDING_MODE_UNSUPPORTED",
                        "Only confirmed cash or a recorded external card is collected; verified capture is unavailable",
                    ))
                }
            }
        };
        let attempt_key = match obj.get("attemptKey") {
            None | Some(Value::Null) => None,
            Some(_) => Some(
                uuid_field(obj, "attemptKey")
                    .ok_or_else(|| invalid("attemptKey must be a UUID"))?,
            ),
        };
        let staff_id =
            uuid_field(obj, "staffId").ok_or_else(|| invalid("staffId must be a UUID"))?;
        let operation = obj
            .get("operation")
            .and_then(Value::as_str)
            .and_then(Operation::parse)
            .ok_or_else(|| invalid("operation must be issue or reload"))?;
        let card_id = match obj.get("cardId") {
            None | Some(Value::Null) => None,
            Some(_) => {
                Some(uuid_field(obj, "cardId").ok_or_else(|| invalid("cardId must be a UUID"))?)
            }
        };
        if (operation == Operation::Reload) != card_id.is_some() {
            return Err(invalid(
                "A reload names its card UUID; an issue never names a card",
            ));
        }
        let amount_cents = obj
            .get("amountCents")
            .and_then(Value::as_i64)
            .filter(|cents| (1..=MAX_FUNDING_CENTS).contains(cents))
            .ok_or_else(|| invalid("amountCents must be integer cents 1..99999999"))?;
        let currency = obj
            .get("currency")
            .and_then(Value::as_str)
            .filter(|currency| is_currency(currency))
            .map(str::to_string)
            .ok_or_else(|| invalid("currency must be an uppercase ISO 4217 code"))?;
        let reason = obj
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| (1..=500).contains(&js_len(reason)))
            .map(str::to_string)
            .ok_or_else(|| invalid("A reason of 1..500 characters is required"))?;
        Ok(Self {
            attempt_key,
            staff_id,
            mode,
            operation,
            card_id,
            amount_cents,
            currency,
            reason,
        })
    }

    /// Whether a same-key call names the identical original.
    fn same_original(&self, original: &Original, scope: &OpeningScope) -> bool {
        scope_matches(scope, original)
            && same_uuid(&self.staff_id, &original.staff_id)
            && self.mode == original.mode
            && self.operation == original.operation
            && match (&self.card_id, &original.card_id) {
                (Some(left), Some(right)) => same_uuid(left, right),
                (None, None) => true,
                _ => false,
            }
            && self.amount_cents == original.amount_cents
            && self.currency == original.currency
            && self.reason == original.reason
    }

    fn original(
        &self,
        scope: &OpeningScope,
        drawer_id: Option<String>,
        shift_id: Option<String>,
        authority_opening_key: Option<String>,
    ) -> Original {
        Original {
            attempt_key: self
                .attempt_key
                .clone()
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            organization_id: scope.organization_id.clone(),
            branch_id: scope.branch_id.clone(),
            terminal_id: scope.terminal_id.clone(),
            staff_id: self.staff_id.clone(),
            operation: self.operation,
            mode: self.mode,
            card_id: self.card_id.clone(),
            amount_cents: self.amount_cents,
            currency: self.currency.clone(),
            reason: self.reason.clone(),
            drawer_id,
            shift_id,
            authority_opening_key,
        }
    }
}

fn attempt_key_arg(payload: &Value, extra: &[&str]) -> Result<String, FundingError> {
    let invalid = || FundingError::new("INVALID_ATTEMPT_KEY", "attemptKey must be a UUID");
    let obj = payload.as_object().ok_or_else(invalid)?;
    if obj
        .keys()
        .any(|key| key != "attemptKey" && !extra.contains(&key.as_str()))
    {
        return Err(FundingError::new(
            "INVALID_FUNDING_REQUEST",
            "The funding request carries an unsupported field",
        ));
    }
    uuid_field(obj, "attemptKey").ok_or_else(invalid)
}

const CASH_EVIDENCE_KEYS: [&str; 4] = ["kind", "amountCents", "currency", "confirmed"];
const EXTERNAL_EVIDENCE_KEYS: [&str; 8] = [
    "kind",
    "amountCents",
    "currency",
    "confirmed",
    "provider",
    "merchantId",
    "terminalReference",
    "transactionReference",
];

/// The complete body, built once from operator-recorded evidence. External
/// card evidence is an operator record, never a verified capture.
fn complete_body(a: &Attempt, evidence: &Value) -> Result<Value, FundingError> {
    let o = &a.original;
    let invalid = |message: &str| FundingError::new("INVALID_FUNDING_EVIDENCE", message);
    let e = evidence
        .as_object()
        .ok_or_else(|| invalid("Operator evidence is required"))?;
    let keys: &[&str] = match o.mode {
        Mode::Cash => &CASH_EVIDENCE_KEYS,
        Mode::ExternalCard => &EXTERNAL_EVIDENCE_KEYS,
        Mode::ManagerGrant => {
            return Err(FundingError::new(
                "GRANT_HAS_NO_COLLECTION",
                "A manager grant collects nothing",
            ))
        }
    };
    if e.len() != keys.len() || !keys.iter().all(|key| e.contains_key(*key)) {
        return Err(invalid("Evidence fields differ from the attempt mode"));
    }
    if str_field(e, "kind") != Some(o.mode.evidence_kind()) {
        return Err(invalid("Evidence kind differs from the attempt mode"));
    }
    if e.get("confirmed") != Some(&Value::Bool(true)) {
        return Err(invalid("The operator must confirm the collected value"));
    }
    if e.get("amountCents").and_then(Value::as_i64) != Some(o.amount_cents)
        || str_field(e, "currency") != Some(o.currency.as_str())
    {
        return Err(FundingError::new(
            "FUNDING_VALUE_MISMATCH",
            "The confirmed value differs from the original attempt",
        ));
    }
    let mut proof = json!({
        "kind": o.mode.evidence_kind(),
        "amount_cents": o.amount_cents,
        "currency": o.currency,
        "confirmed": true,
    });
    if o.mode == Mode::ExternalCard {
        for (input, output, max) in [
            ("provider", "provider", 100),
            ("merchantId", "merchant_id", 100),
            ("terminalReference", "terminal_reference", 100),
            ("transactionReference", "transaction_reference", 200),
        ] {
            let value = str_field(e, input)
                .map(str::trim)
                .filter(|value| (1..=max).contains(&js_len(value)))
                .ok_or_else(|| {
                    invalid("Provider, merchant, terminal and transaction references are required")
                })?;
            proof[output] = json!(value);
        }
    }
    Ok(json!({
        "contract": FUNDING_CONTRACT,
        "action": "complete",
        "idempotency_key": o.attempt_key,
        "evidence": proof,
    }))
}

fn expected_evidence(a: &Attempt) -> Option<Value> {
    match a.original.mode {
        Mode::ManagerGrant => Some(json!({
            "kind": "manager_grant",
            "amount_cents": a.original.amount_cents,
            "currency": a.original.currency,
            "confirmed": true,
        })),
        _ => a
            .complete_body
            .as_deref()
            .and_then(|body| serde_json::from_str::<Value>(body).ok())
            .and_then(|body| body.get("evidence").cloned()),
    }
}

// ---------------------------------------------------------------------------
// Attempt creation (committed before any request)
// ---------------------------------------------------------------------------

fn insert_attempt(
    conn: &Connection,
    original: &Original,
    now: DateTime<Utc>,
) -> Result<Attempt, FundingError> {
    let now_text = normalize_instant(now);
    let inserted = conn.execute(
        "INSERT INTO gift_card_funding_attempts (
            attempt_key, organization_id, branch_id, terminal_id, staff_id, operation, mode,
            card_id, amount_cents, currency, reason, drawer_id, shift_id, authority_opening_key,
            request_body, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 'prepare_pending', ?16, ?16)",
        params![
            original.attempt_key,
            original.organization_id,
            original.branch_id,
            original.terminal_id,
            original.staff_id,
            original.operation.as_str(),
            original.mode.as_str(),
            original.card_id,
            original.amount_cents,
            original.currency,
            original.reason,
            original.drawer_id,
            original.shift_id,
            original.authority_opening_key,
            original.request_body().to_string(),
            now_text,
        ],
    );
    let stored = load_attempt(conn, &original.attempt_key).map_err(local_error)?;
    match (inserted, stored) {
        (Ok(1), Some(attempt)) => {
            info!(attempt_key = %original.attempt_key, mode = original.mode.as_str(), "gift funding attempt recorded");
            Ok(attempt)
        }
        // A duplicate call or another handle recorded the same original first.
        (Err(_), Some(attempt)) if attempt.original == *original => Ok(attempt),
        (Err(_), Some(_)) => Err(key_mismatch()),
        (result, _) => Err(local_error(format!("insert funding attempt: {result:?}"))),
    }
}

/// Same key: only the identical caller tuple resumes the stored attempt.
fn resume_existing(
    conn: &Connection,
    request: &FundingRequest,
    scope: &OpeningScope,
) -> Result<Option<Attempt>, FundingError> {
    let Some(key) = request.attempt_key.as_deref() else {
        return Ok(None);
    };
    match load_attempt(conn, key).map_err(local_error)? {
        Some(existing) if request.same_original(&existing.original, scope) => Ok(Some(existing)),
        Some(_) => Err(key_mismatch()),
        None => Ok(None),
    }
}

fn cashier_scope(scope: &OpeningScope, staff_id: &str) -> HostedCashierScope {
    HostedCashierScope {
        organization_id: scope.organization_id.clone(),
        branch_id: scope.branch_id.clone(),
        terminal_id: scope.terminal_id.clone(),
        staff_id: staff_id.to_string(),
    }
}

/// Cash/external: the current usable original of the selected cashier is the
/// authority; cash is additionally bound to that original's drawer and
/// currency. A cash admission holds one immediate write transaction across
/// its retained-key lookup, fresh cashier/open-original eligibility and
/// immutable insertion, and commits before any request: a concurrent native
/// close either sees the attempt or has closed the drawer first.
fn open_cashier_attempt(
    conn: &Connection,
    request: &FundingRequest,
    now: DateTime<Utc>,
) -> Result<Attempt, FundingError> {
    if request.mode != Mode::Cash {
        return admit_cashier_attempt(conn, request, now);
    }
    // Never nest into a caller's transaction: the admission owns its lock.
    if !conn.is_autocommit() {
        return Err(local_error(
            "cash admission requires its own write transaction",
        ));
    }
    conn.execute_batch("BEGIN IMMEDIATE").map_err(local_error)?;
    let admitted = admit_cashier_attempt(conn, request, now).and_then(|attempt| {
        conn.execute_batch("COMMIT")
            .map(|()| attempt)
            .map_err(local_error)
    });
    if admitted.is_err() && !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    admitted
}

fn admit_cashier_attempt(
    conn: &Connection,
    request: &FundingRequest,
    now: DateTime<Utc>,
) -> Result<Attempt, FundingError> {
    let scope = opening::trusted_scope(conn).ok_or_else(scope_unavailable)?;
    if let Some(existing) = resume_existing(conn, request, &scope)? {
        return Ok(existing);
    }
    let cashier =
        opening::scoped_hosted_cashier(conn, &cashier_scope(&scope, &request.staff_id), now)
            .map_err(hosted_refusal)?;
    let (drawer_id, shift_id) = if request.mode == Mode::Cash {
        let original_currency = opening::load_intent(conn, cashier.opening_key())
            .map_err(local_error)?
            .map(|intent| intent.currency);
        if original_currency.as_deref() != Some(request.currency.as_str()) {
            return Err(FundingError::new(
                "CASH_CURRENCY_MISMATCH",
                "Cash funding must use the original drawer currency",
            ));
        }
        (
            Some(cashier.drawer_id().to_string()),
            Some(cashier.shift_id().to_string()),
        )
    } else {
        (None, None)
    };
    let original = request.original(
        &scope,
        drawer_id,
        shift_id,
        Some(cashier.opening_key().to_string()),
    );
    insert_attempt(conn, &original, now)
}

/// Manager grant: recorded only while the selected manager's separate
/// authority is live in the current trusted scope.
fn open_grant_attempt(
    conn: &Connection,
    request: &FundingRequest,
    now: DateTime<Utc>,
) -> Result<Attempt, FundingError> {
    let scope = opening::trusted_scope(conn).ok_or_else(scope_unavailable)?;
    if let Some(existing) = resume_existing(conn, request, &scope)? {
        return Ok(existing);
    }
    grant_session(&scope, &request.staff_id, now)?;
    insert_attempt(conn, &request.original(&scope, None, None, None), now)
}

/// Never possibly sent: nothing exists remotely, so a refused precondition
/// closes the attempt locally.
fn refuse_unsent(conn: &Connection, key: &str, code: &str, now: DateTime<Utc>) {
    if let Err(error) = conn.execute(
        "UPDATE gift_card_funding_attempts SET state = 'refused', last_code = ?2, updated_at = ?3
         WHERE attempt_key = ?1 AND state = 'prepare_pending' AND prepare_sends = 0",
        params![key, code, normalize_instant(now)],
    ) {
        warn!("gift funding local refusal failed: {error}");
    }
}

fn record_code(conn: &Connection, key: &str, code: &str, now: DateTime<Utc>) {
    let result = conn.execute(
        &format!(
            "UPDATE gift_card_funding_attempts SET last_code = ?2, updated_at = ?3
             WHERE attempt_key = ?1 AND state NOT IN {TERMINAL_STATES_SQL}"
        ),
        params![key, code, normalize_instant(now)],
    );
    if let Err(error) = result {
        warn!("gift funding retain bookkeeping failed: {error}");
    }
}

// ---------------------------------------------------------------------------
// Volatile manager grant authority
// ---------------------------------------------------------------------------

struct GrantAuthority {
    generation: u64,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    session_id: String,
    usable_until: DateTime<Utc>,
}

/// Grant authorities by lowercase manager staff id plus the fences shared by
/// in-flight manager check-ins and late funding replies. Never persisted,
/// logged or returned.
#[derive(Default)]
struct FundingAuthState {
    generation: u64,
    cleared_through: u64,
    grants: HashMap<String, GrantAuthority>,
}

impl FundingAuthState {
    fn admits(&self, fence: u64) -> bool {
        fence > self.cleared_through
    }
}

fn funding_auth() -> MutexGuard<'static, FundingAuthState> {
    static STATE: OnceLock<Mutex<FundingAuthState>> = OnceLock::new();
    STATE
        .get_or_init(|| Mutex::new(FundingAuthState::default()))
        .lock()
        // Every update is a single insert/remove/assignment; a poisoned lock
        // still holds a consistent state and keeps the clear effective.
        .unwrap_or_else(PoisonError::into_inner)
}

fn capture_fence() -> u64 {
    let mut auth = funding_auth();
    auth.generation += 1;
    auth.generation
}

/// Drops every manager grant authority and fences every in-flight manager
/// check-in and every late funding reply (no card number is published).
/// Called by `gift_financial_opening::clear_authorizations`, the same
/// explicit lifecycle boundary that clears the hosted cashier.
pub(crate) fn clear_grant_authorities() {
    let mut auth = funding_auth();
    auth.grants.clear();
    auth.cleared_through = auth.generation;
}

fn install_grant_authority(
    fence: u64,
    scope: &OpeningScope,
    staff_id: &str,
    session_id: &str,
    server_usable_until: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, FundingError> {
    let mut auth = funding_auth();
    let staff = staff_id.to_ascii_lowercase();
    if !auth.admits(fence)
        || auth
            .grants
            .get(&staff)
            .is_some_and(|installed| installed.generation > fence)
    {
        return Err(FundingError::new(
            "MANAGER_AUTHORIZATION_SUPERSEDED",
            "Manager authorization was cleared or superseded; authorize again",
        ));
    }
    let usable_until =
        server_usable_until.min(now + chrono::Duration::seconds(GRANT_AUTHORITY_SECS));
    if usable_until <= now {
        return Err(FundingError::new(
            "MANAGER_AUTHORIZATION_EXPIRED",
            "Manager authorization expired; authorize again",
        ));
    }
    auth.grants.insert(
        staff,
        GrantAuthority {
            generation: fence,
            organization_id: scope.organization_id.clone(),
            branch_id: scope.branch_id.clone(),
            terminal_id: scope.terminal_id.clone(),
            session_id: session_id.to_string(),
            usable_until,
        },
    );
    Ok(usable_until)
}

/// The live manager session for `staff_id` in the current trusted scope.
fn grant_session(
    trusted: &OpeningScope,
    staff_id: &str,
    now: DateTime<Utc>,
) -> Result<String, FundingError> {
    let mut auth = funding_auth();
    let staff = staff_id.to_ascii_lowercase();
    let usable = auth.grants.get(&staff).map(|authority| {
        let live = same_uuid(&authority.organization_id, &trusted.organization_id)
            && same_uuid(&authority.branch_id, &trusted.branch_id)
            && authority.terminal_id == trusted.terminal_id
            && authority.usable_until > now;
        (live, authority.session_id.clone())
    });
    match usable {
        Some((true, session_id)) => Ok(session_id),
        Some((false, _)) | None => {
            auth.grants.remove(&staff);
            Err(FundingError::new(
                "MANAGER_AUTHORIZATION_REQUIRED",
                "The selected manager must authorize this grant with their PIN",
            ))
        }
    }
}

fn drop_grant_authority(staff_id: &str) {
    funding_auth().grants.remove(&staff_id.to_ascii_lowercase());
}

// ---------------------------------------------------------------------------
// Step planning (under the DB lock) and strict reply adoption
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Prepare,
    Grant,
    Begin,
    Complete,
    Cancel,
    /// Status read of a prepared/collecting intent; performs no financial write.
    Read,
}

#[derive(Clone, Debug)]
enum Requested {
    Resume,
    /// Explicit operator check may retrieve a completed issue's transient number.
    Recover,
    BeginCollection,
    Complete(Value),
    Cancel(String),
}

struct SendPlan {
    attempt_key: String,
    step: Step,
    method: &'static str,
    path: String,
    body: Option<Value>,
    staff_session: String,
    /// Original opening whose cashier session is sent (cash/external).
    session_owner: Option<String>,
    fence: u64,
    allow_collection: bool,
}

impl fmt::Debug for SendPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SendPlan")
            .field("attempt_key", &self.attempt_key)
            .field("step", &self.step)
            .field("method", &self.method)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
enum Planned {
    Send(SendPlan),
    /// Nothing to send: the current attempt is the answer.
    Settled(Attempt),
}

fn exec<P: rusqlite::Params>(conn: &Connection, sql: &str, params: P) -> Result<usize, Value> {
    conn.execute(sql, params)
        .map_err(|e| local_error(e).to_value(None))
}

fn step_for(requested: &Requested, a: &Attempt) -> Option<Step> {
    match a.state {
        AttemptState::PreparePending if a.original.mode == Mode::ManagerGrant => Some(Step::Grant),
        AttemptState::PreparePending => Some(Step::Prepare),
        AttemptState::CollectionPending => Some(Step::Begin),
        AttemptState::CompletePending => Some(Step::Complete),
        AttemptState::CancelPending => Some(Step::Cancel),
        AttemptState::Prepared | AttemptState::CollectionStarted
            if matches!(requested, Requested::Resume | Requested::Recover) =>
        {
            Some(Step::Read)
        }
        AttemptState::Completed
            if matches!(requested, Requested::Recover)
                && a.original.operation == Operation::Issue =>
        {
            Some(Step::Read)
        }
        _ => None,
    }
}

fn step_request(
    a: &Attempt,
    step: Step,
) -> Result<(&'static str, String, Option<Value>), FundingError> {
    let o = &a.original;
    let intent_path = || {
        a.intent_id
            .as_deref()
            .map(|id| format!("{INTENTS_PATH}/{id}"))
            .ok_or_else(|| {
                FundingError::new(
                    "FUNDING_INTENT_UNKNOWN",
                    "The prepared intent is not recorded",
                )
            })
    };
    let stored = |body: Option<&str>| {
        body.and_then(|body| serde_json::from_str::<Value>(body).ok())
            .ok_or_else(payload_mismatch)
    };
    match step {
        Step::Prepare | Step::Grant => {
            let body = stored(Some(a.request_body.as_str()))?;
            if body != o.request_body() {
                return Err(payload_mismatch());
            }
            let path = if step == Step::Grant {
                GRANTS_PATH
            } else {
                INTENTS_PATH
            };
            Ok(("POST", path.to_string(), Some(body)))
        }
        Step::Begin => Ok((
            "POST",
            format!("{}/complete", intent_path()?),
            Some(json!({
                "contract": FUNDING_CONTRACT,
                "action": "begin_collection",
                "idempotency_key": o.attempt_key,
            })),
        )),
        Step::Complete => Ok((
            "POST",
            format!("{}/complete", intent_path()?),
            Some(stored(a.complete_body.as_deref())?),
        )),
        Step::Cancel => Ok((
            "POST",
            format!("{}/complete", intent_path()?),
            Some(stored(a.cancel_body.as_deref())?),
        )),
        Step::Read => Ok(("GET", intent_path()?, None)),
    }
}

/// The native session a send presents; renewal changes only this transport
/// authority, never the original actor, key or body.
fn send_authority(
    conn: &Connection,
    a: &Attempt,
    trusted: &OpeningScope,
    now: DateTime<Utc>,
) -> Result<(String, Option<String>), FundingError> {
    let o = &a.original;
    if o.mode == Mode::ManagerGrant {
        return Ok((grant_session(trusted, &o.staff_id, now)?, None));
    }
    let cashier = opening::scoped_hosted_cashier(conn, &cashier_scope(trusted, &o.staff_id), now)
        .map_err(hosted_refusal)?;
    if o.mode == Mode::Cash
        && !(o
            .drawer_id
            .as_deref()
            .is_some_and(|id| same_uuid(id, cashier.drawer_id()))
            && o.shift_id
                .as_deref()
                .is_some_and(|id| same_uuid(id, cashier.shift_id())))
    {
        return Err(FundingError::new(
            "ORIGINAL_DRAWER_UNAVAILABLE",
            "Cash funding continues only on its original open drawer",
        ));
    }
    Ok((
        cashier.staff_session_header().to_string(),
        Some(cashier.opening_key().to_string()),
    ))
}

fn state_refusal(requested: &Requested, a: &Attempt) -> Value {
    let (code, message) = match (requested, a.state) {
        (Requested::Cancel(_), AttemptState::PreparePending) => (
            "CANCEL_REQUIRES_RECOVERY",
            "The original may have been sent; recover it before canceling",
        ),
        (
            Requested::Cancel(_),
            AttemptState::CollectionPending
            | AttemptState::CollectionStarted
            | AttemptState::CompletePending,
        ) => (
            "COLLECTION_UNRESOLVED",
            "Collection may have started; only a never-collected original is canceled",
        ),
        (Requested::Cancel(_), _) => ("CANCEL_NOT_ALLOWED", "This attempt cannot be canceled"),
        (Requested::BeginCollection, _) => (
            "COLLECTION_NOT_ALLOWED",
            "Collection begins only from a prepared, acknowledged original",
        ),
        (Requested::Complete(_), _) => (
            "COMPLETE_NOT_ALLOWED",
            "Completion follows an acknowledged begin of collection only",
        ),
        (Requested::Resume | Requested::Recover, _) => (
            "FUNDING_STATE_CHANGED",
            "The attempt changed; read its status",
        ),
    };
    FundingError::new(code, message).to_value(Some(a))
}

/// Under the DB lock: applies the requested conditional claim, re-reads the
/// attempt and plans the one send it needs. A lost claim is decided on the
/// fresh state only. `can_send` is false when no admin endpoint resolved.
fn plan_step(
    conn: &Connection,
    key: &str,
    requested: &Requested,
    can_send: bool,
    now: DateTime<Utc>,
) -> Result<Planned, Value> {
    let load = |conn: &Connection| -> Result<Attempt, Value> {
        load_attempt(conn, key)
            .map_err(|e| local_error(e).to_value(None))?
            .ok_or_else(|| not_found().to_value(None))
    };
    let attempt = load(conn)?;
    let Some(trusted) =
        opening::trusted_scope(conn).filter(|scope| scope_matches(scope, &attempt.original))
    else {
        return Err(scope_changed().to_value(None));
    };
    let now_text = normalize_instant(now);
    match requested {
        Requested::Resume | Requested::Recover => {}
        Requested::BeginCollection => {
            if attempt.original.mode == Mode::ManagerGrant {
                return Err(FundingError::new(
                    "GRANT_HAS_NO_COLLECTION",
                    "A manager grant collects nothing",
                )
                .to_value(Some(&attempt)));
            }
            if attempt.state == AttemptState::Prepared {
                exec(
                    conn,
                    "UPDATE gift_card_funding_attempts SET state = 'collection_pending', updated_at = ?2
                     WHERE attempt_key = ?1 AND state = 'prepared'",
                    params![key, now_text],
                )?;
            }
        }
        Requested::Complete(evidence) => {
            if attempt.state == AttemptState::CollectionStarted {
                let body =
                    complete_body(&attempt, evidence).map_err(|e| e.to_value(Some(&attempt)))?;
                exec(
                    conn,
                    "UPDATE gift_card_funding_attempts
                     SET state = 'complete_pending', complete_body = ?3, updated_at = ?2
                     WHERE attempt_key = ?1 AND state = 'collection_started' AND complete_body IS NULL",
                    params![key, now_text, body.to_string()],
                )?;
            }
        }
        Requested::Cancel(reason) => match attempt.state {
            AttemptState::Prepared => {
                let body = json!({
                    "contract": FUNDING_CONTRACT,
                    "action": "cancel",
                    "idempotency_key": key,
                    "reason": reason,
                    "never_collected": true,
                });
                exec(
                    conn,
                    "UPDATE gift_card_funding_attempts
                     SET state = 'cancel_pending', cancel_body = ?3, updated_at = ?2
                     WHERE attempt_key = ?1 AND state = 'prepared' AND cancel_body IS NULL",
                    params![key, now_text, body.to_string()],
                )?;
            }
            AttemptState::PreparePending => {
                exec(
                    conn,
                    "UPDATE gift_card_funding_attempts
                     SET state = 'abandoned', last_code = 'ABANDONED_NEVER_SENT', updated_at = ?2
                     WHERE attempt_key = ?1 AND state = 'prepare_pending'
                       AND prepare_sends = prepare_settled",
                    params![key, now_text],
                )?;
            }
            _ => {}
        },
    }
    let attempt = load(conn)?;
    let allowed = match requested {
        Requested::Resume | Requested::Recover => true,
        Requested::BeginCollection => matches!(
            attempt.state,
            AttemptState::CollectionPending | AttemptState::CollectionStarted
        ),
        Requested::Complete(evidence) => match attempt.state {
            AttemptState::CompletePending | AttemptState::Completed => {
                let wanted = complete_body(&attempt, evidence).ok();
                let stored = attempt
                    .complete_body
                    .as_deref()
                    .and_then(|body| serde_json::from_str::<Value>(body).ok());
                if wanted.is_none() || wanted != stored {
                    return Err(FundingError::new(
                        "COMPLETE_EVIDENCE_MISMATCH",
                        "This completion is recorded with other evidence; recover it instead",
                    )
                    .to_value(Some(&attempt)));
                }
                true
            }
            _ => false,
        },
        Requested::Cancel(_) => matches!(
            attempt.state,
            AttemptState::CancelPending | AttemptState::Canceled | AttemptState::Abandoned
        ),
    };
    if !allowed {
        return Err(state_refusal(requested, &attempt));
    }
    let Some(step) = step_for(requested, &attempt) else {
        return Ok(Planned::Settled(attempt));
    };
    if !can_send {
        return Err(not_configured().to_value(Some(&attempt)));
    }
    let (method, path, body) =
        step_request(&attempt, step).map_err(|e| e.to_value(Some(&attempt)))?;
    let (staff_session, session_owner) =
        send_authority(conn, &attempt, &trusted, now).map_err(|e| e.to_value(Some(&attempt)))?;
    if matches!(step, Step::Prepare | Step::Grant) {
        // Durable "possibly sent" marker, committed before the request.
        let claimed = exec(
            conn,
            "UPDATE gift_card_funding_attempts SET prepare_sends = prepare_sends + 1, updated_at = ?2
             WHERE attempt_key = ?1 AND state = 'prepare_pending'",
            params![key, now_text],
        )?;
        if claimed != 1 {
            let fresh = load(conn)?;
            return Err(FundingError::new(
                "FUNDING_STATE_CHANGED",
                "The attempt changed; read its status",
            )
            .to_value(Some(&fresh)));
        }
    }
    Ok(Planned::Send(SendPlan {
        attempt_key: key.to_string(),
        step,
        method,
        path,
        body,
        staff_session,
        session_owner,
        fence: capture_fence(),
        allow_collection: matches!(requested, Requested::BeginCollection),
    }))
}

const RESULT_KEYS: [&str; 27] = [
    "contract",
    "intent_id",
    "organization_id",
    "branch_id",
    "terminal_id",
    "staff_id",
    "staff_session_id",
    "state",
    "operation",
    "mode",
    "amount_cents",
    "currency",
    "idempotency_key",
    "replayed",
    "card_id",
    "credit_id",
    "acknowledgement_id",
    "card_balance_cents",
    "card_number_hash",
    "drawer_id",
    "shift_id",
    "owner_terminal_id",
    "evidence",
    "collection_required",
    "collect_again",
    "verified_capture",
    "fiscal_receipt",
];

struct CompletionProof {
    card_id: String,
    credit_id: String,
    acknowledgement_id: String,
    card_balance_cents: i64,
    card_number_hash: String,
    evidence: Value,
}

struct FundingResult {
    intent_id: String,
    state: ServerState,
    owner_terminal_db_id: String,
    completion: Option<CompletionProof>,
    /// Transient: only a completed issue carries it; never stored.
    card_number: Option<String>,
}

impl fmt::Debug for FundingResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FundingResult")
            .field("intent_id", &self.intent_id)
            .field("state", &self.state)
            .field("completed", &self.completion.is_some())
            .finish_non_exhaustive()
    }
}

/// Strict flat `GiftCardFundingResponse` validation against the immutable
/// attempt. The recorded original `staff_session_id` may differ from a
/// renewed authorization: it is shape-checked only and never retained.
fn parse_funding_response(body: &Value, a: &Attempt) -> Result<FundingResult, &'static str> {
    const MALFORMED: &str = "MALFORMED_FUNDING_RESULT";
    const FOREIGN: &str = "FOREIGN_FUNDING_RESULT";
    const PROOF: &str = "FUNDING_PROOF_INVALID";
    let o = &a.original;
    let r = body.as_object().ok_or(MALFORMED)?;
    if r.get("success") != Some(&Value::Bool(true)) {
        return Err("UNCONFIRMED_FUNDING_RESULT");
    }
    let has_number = r.contains_key("card_number");
    if r.len() != RESULT_KEYS.len() + 1 + usize::from(has_number)
        || !RESULT_KEYS.iter().all(|key| r.contains_key(*key))
    {
        return Err(MALFORMED);
    }
    if str_field(r, "contract") != Some(FUNDING_CONTRACT) {
        return Err(MALFORMED);
    }
    let intent_id = str_field(r, "intent_id")
        .filter(|id| is_uuid(id))
        .ok_or(MALFORMED)?;
    if a.intent_id
        .as_deref()
        .is_some_and(|known| !same_uuid(known, intent_id))
    {
        return Err(FOREIGN);
    }
    if !str_field(r, "organization_id").is_some_and(|id| same_uuid(id, &o.organization_id))
        || !str_field(r, "branch_id").is_some_and(|id| same_uuid(id, &o.branch_id))
        || str_field(r, "terminal_id") != Some(o.terminal_id.as_str())
        || !str_field(r, "staff_id").is_some_and(|id| same_uuid(id, &o.staff_id))
        || str_field(r, "idempotency_key") != Some(o.attempt_key.as_str())
    {
        return Err(FOREIGN);
    }
    if !str_field(r, "staff_session_id").is_some_and(is_uuid) {
        return Err(MALFORMED);
    }
    let state = str_field(r, "state")
        .and_then(ServerState::parse)
        .ok_or(MALFORMED)?;
    if str_field(r, "operation") != Some(o.operation.as_str())
        || str_field(r, "mode") != Some(o.mode.as_str())
        || r.get("amount_cents").and_then(Value::as_i64) != Some(o.amount_cents)
        || str_field(r, "currency") != Some(o.currency.as_str())
    {
        return Err("FUNDING_VALUE_MISMATCH");
    }
    if !r.get("replayed").is_some_and(Value::is_boolean) {
        return Err(MALFORMED);
    }
    let drawer_ok = match (&o.drawer_id, &o.shift_id) {
        (Some(drawer), Some(shift)) => {
            str_field(r, "drawer_id").is_some_and(|id| same_uuid(id, drawer))
                && str_field(r, "shift_id").is_some_and(|id| same_uuid(id, shift))
        }
        _ => r.get("drawer_id") == Some(&Value::Null) && r.get("shift_id") == Some(&Value::Null),
    };
    if !drawer_ok {
        return Err("FUNDING_DRAWER_MISMATCH");
    }
    let owner = str_field(r, "owner_terminal_id")
        .filter(|id| is_uuid(id))
        .ok_or(MALFORMED)?;
    if a.owner_terminal_db_id
        .as_deref()
        .is_some_and(|pin| !same_uuid(pin, owner))
    {
        return Err(FOREIGN);
    }
    for flag in ["collect_again", "verified_capture", "fiscal_receipt"] {
        if r.get(flag) != Some(&Value::Bool(false)) {
            return Err("FUNDING_FLAGS_INVALID");
        }
    }
    let collection_required = state == ServerState::Prepared && o.mode != Mode::ManagerGrant;
    if r.get("collection_required") != Some(&Value::Bool(collection_required)) {
        return Err(MALFORMED);
    }
    let completion = if state == ServerState::Completed {
        let uuid_of = |key: &str| {
            str_field(r, key)
                .filter(|id| is_uuid(id))
                .map(str::to_ascii_lowercase)
        };
        let card_id = uuid_of("card_id").ok_or(PROOF)?;
        if o.card_id
            .as_deref()
            .is_some_and(|expected| !same_uuid(expected, &card_id))
        {
            return Err(FOREIGN);
        }
        let credit_id = uuid_of("credit_id").ok_or(PROOF)?;
        let acknowledgement_id = uuid_of("acknowledgement_id").ok_or(PROOF)?;
        let card_balance_cents = r
            .get("card_balance_cents")
            .and_then(Value::as_i64)
            .filter(|cents| (0..=MAX_SAFE_INTEGER).contains(cents))
            .ok_or(PROOF)?;
        let card_number_hash = str_field(r, "card_number_hash")
            .filter(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or(PROOF)?
            .to_string();
        let evidence = r
            .get("evidence")
            .filter(|evidence| evidence.is_object())
            .ok_or(PROOF)?;
        let expected = expected_evidence(a).ok_or("FUNDING_EVIDENCE_UNKNOWN")?;
        if *evidence != expected {
            return Err("FUNDING_EVIDENCE_MISMATCH");
        }
        Some(CompletionProof {
            card_id,
            credit_id,
            acknowledgement_id,
            card_balance_cents,
            card_number_hash,
            evidence: evidence.clone(),
        })
    } else {
        let proof_keys = [
            "card_id",
            "credit_id",
            "acknowledgement_id",
            "card_balance_cents",
            "card_number_hash",
            "evidence",
        ];
        if proof_keys
            .iter()
            .any(|key| r.get(*key) != Some(&Value::Null))
        {
            return Err(PROOF);
        }
        None
    };
    let card_number = match r.get("card_number") {
        None => None,
        Some(Value::String(number))
            if state == ServerState::Completed
                && o.operation == Operation::Issue
                && (8..=128).contains(&number.len())
                && number
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) =>
        {
            Some(number.clone())
        }
        Some(_) => return Err(MALFORMED),
    };
    Ok(FundingResult {
        intent_id: intent_id.to_ascii_lowercase(),
        state,
        owner_terminal_db_id: owner.to_ascii_lowercase(),
        completion,
        card_number,
    })
}

fn move_state(
    conn: &Connection,
    key: &str,
    target: AttemptState,
    from: &[AttemptState],
    result: &FundingResult,
    now: DateTime<Utc>,
) -> Result<bool, FundingError> {
    let from_sql = from
        .iter()
        .map(|state| format!("'{}'", state.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "UPDATE gift_card_funding_attempts SET state = ?2,
                intent_id = COALESCE(intent_id, ?3),
                owner_terminal_db_id = COALESCE(owner_terminal_db_id, ?4),
                server_state = ?5, last_code = NULL, updated_at = ?6
             WHERE attempt_key = ?1 AND state IN ({from_sql})"
        ),
        params![
            key,
            target.as_str(),
            result.intent_id,
            result.owner_terminal_db_id,
            result.state.as_str(),
            normalize_instant(now)
        ],
    )
    .map(|changed| changed == 1)
    .map_err(local_error)
}

/// Canonical acknowledgement and credit, recorded once. A lost claim is
/// idempotent only for the identical proof; nothing is ever overwritten.
fn adopt_completed(
    conn: &Connection,
    a: &Attempt,
    result: &FundingResult,
    from: AttemptState,
    now: DateTime<Utc>,
) -> Result<(), FundingError> {
    let key = a.original.attempt_key.as_str();
    let proof = result
        .completion
        .as_ref()
        .ok_or_else(|| FundingError::new("FUNDING_PROOF_INVALID", "Completion proof is missing"))?;
    let now_text = normalize_instant(now);
    let changed = conn.execute(
        "UPDATE gift_card_funding_attempts SET state = 'completed',
            intent_id = COALESCE(intent_id, ?2),
            owner_terminal_db_id = COALESCE(owner_terminal_db_id, ?3),
            server_state = 'completed', result_card_id = ?4, credit_id = ?5,
            acknowledgement_id = ?6, card_balance_cents = ?7, card_number_hash = ?8,
            evidence_json = ?9, completed_at = ?10, last_code = NULL, updated_at = ?10
         WHERE attempt_key = ?1 AND state = ?11",
        params![
            key,
            result.intent_id,
            result.owner_terminal_db_id,
            proof.card_id,
            proof.credit_id,
            proof.acknowledgement_id,
            proof.card_balance_cents,
            proof.card_number_hash,
            proof.evidence.to_string(),
            now_text,
            from.as_str(),
        ],
    );
    match changed {
        Ok(1) => {
            info!(attempt_key = %key, "gift funding completion acknowledged");
            return Ok(());
        }
        Ok(_) => {}
        Err(error) => warn!("gift funding completion persist refused: {error}"),
    }
    let fresh = load_attempt(conn, key).map_err(local_error)?;
    let same = fresh
        .as_ref()
        .and_then(|fresh| fresh.completion.as_ref())
        .is_some_and(|stored| {
            stored.card_id == proof.card_id
                && stored.credit_id == proof.credit_id
                && stored.acknowledgement_id == proof.acknowledgement_id
                && stored.card_number_hash == proof.card_number_hash
                && serde_json::from_str::<Value>(&stored.evidence_json)
                    .ok()
                    .as_ref()
                    == Some(&proof.evidence)
        });
    if same {
        Ok(())
    } else {
        record_code(conn, key, "FUNDING_ACK_CONFLICT", now);
        Err(FundingError::new(
            "FUNDING_ACK_CONFLICT",
            "A different canonical acknowledgement conflicts with this attempt; nothing was overwritten",
        ))
    }
}

/// Maps a strictly validated server state onto the monotone local state.
/// Returns the transient card number and whether this reply won the first
/// durable begin acknowledgement, including across separate SQLite handles.
fn adopt(
    conn: &Connection,
    a: &Attempt,
    step: Step,
    result: FundingResult,
    now: DateTime<Utc>,
) -> Result<(Option<String>, bool), FundingError> {
    use AttemptState as L;
    let key = a.original.attempt_key.as_str();
    match (step, result.state) {
        (Step::Prepare, ServerState::Prepared) => {
            move_state(conn, key, L::Prepared, &[L::PreparePending], &result, now)?;
            Ok((None, false))
        }
        (Step::Begin, ServerState::CollectionStarted) => {
            let claimed = move_state(
                conn,
                key,
                L::CollectionStarted,
                &[L::CollectionPending],
                &result,
                now,
            )?;
            Ok((None, claimed))
        }
        (Step::Cancel, ServerState::Canceled) => {
            move_state(conn, key, L::Canceled, &[L::CancelPending], &result, now)?;
            Ok((None, false))
        }
        (Step::Prepare | Step::Begin | Step::Read, ServerState::Canceled)
            if matches!(
                a.state,
                L::PreparePending | L::Prepared | L::CollectionPending
            ) =>
        {
            // Canceled remotely before any collection was ever permitted here.
            move_state(
                conn,
                key,
                L::Canceled,
                &[L::PreparePending, L::Prepared, L::CollectionPending],
                &result,
                now,
            )?;
            Ok((None, false))
        }
        (Step::Grant, ServerState::Completed) => {
            adopt_completed(conn, a, &result, L::PreparePending, now)?;
            Ok((result.card_number, false))
        }
        (Step::Complete, ServerState::Completed) => {
            adopt_completed(conn, a, &result, L::CompletePending, now)?;
            Ok((result.card_number, false))
        }
        (Step::Read, ServerState::Completed) if a.state == L::Completed => {
            // Compare the immutable completion proof without updating a completed row.
            // The original's status may reveal the number transiently, never another credit.
            adopt_completed(conn, a, &result, L::CompletePending, now)?;
            Ok((result.card_number, false))
        }
        (Step::Read, ServerState::Prepared) if a.state == L::Prepared => {
            move_state(conn, key, L::Prepared, &[L::Prepared], &result, now)?;
            Ok((None, false))
        }
        (Step::Read, ServerState::CollectionStarted) if a.state == L::CollectionStarted => {
            move_state(
                conn,
                key,
                L::CollectionStarted,
                &[L::CollectionStarted],
                &result,
                now,
            )?;
            Ok((None, false))
        }
        (_, ServerState::Canceled)
            if matches!(a.state, L::CollectionStarted | L::CompletePending) =>
        {
            record_code(conn, key, "SERVER_CANCELED_AFTER_COLLECTION", now);
            Err(FundingError::new(
                "SERVER_CANCELED_AFTER_COLLECTION",
                "The server canceled an intent whose collection may have happened; it stays unresolved",
            ))
        }
        _ => {
            record_code(conn, key, "FUNDING_STATE_UNEXPECTED", now);
            Err(FundingError::new(
                "FUNDING_STATE_UNEXPECTED",
                "The server state does not continue this attempt; recover it later",
            ))
        }
    }
}

fn failure_code(error: &AdminFetchError) -> String {
    if let Some(code) = error.code().filter(|code| is_code(code)) {
        return code.to_string();
    }
    match error.status() {
        Some(status) => format!("HTTP_{status}"),
        None => "TRANSPORT_UNCONFIRMED".to_string(),
    }
}

/// `(terminal, settled)` for a failed prepare/grant send. `settled`: the
/// server created nothing for this send (admission, validation or readiness
/// refusal). `terminal`: a retry of the same original cannot succeed either.
/// Conflicts, 5xx and transport failures stay unknown.
fn classify_failure(status: Option<u16>, code: Option<&str>) -> (bool, bool) {
    let terminal = matches!(status, Some(400 | 404 | 422))
        || (status == Some(503) && code == Some(CASH_NOT_READY));
    (
        terminal,
        terminal || matches!(status, Some(401 | 403 | 429)),
    )
}

/// An HTTP failure never adopts anything. A prepare/grant refused at
/// admission or validation created nothing; it becomes final only when no
/// other send of the same original is still unknown.
fn record_failure(
    conn: &Connection,
    a: &Attempt,
    plan: &SendPlan,
    error: &AdminFetchError,
    now: DateTime<Utc>,
) -> FundingError {
    let key = a.original.attempt_key.as_str();
    let code = failure_code(error);
    let status = error.status();
    let (terminal, settled) = classify_failure(status, error.code());
    if matches!(plan.step, Step::Prepare | Step::Grant) && settled {
        if let Err(error) = conn.execute(
            "UPDATE gift_card_funding_attempts SET
                state = CASE WHEN ?3 AND prepare_sends - prepare_settled = 1 THEN 'refused' ELSE state END,
                prepare_settled = prepare_settled + 1,
                last_code = ?2, updated_at = ?4
             WHERE attempt_key = ?1 AND state = 'prepare_pending' AND prepare_settled < prepare_sends",
            params![key, code, terminal, normalize_instant(now)],
        ) {
            warn!("gift funding refusal bookkeeping failed: {error}");
        }
    } else {
        record_code(conn, key, &code, now);
    }
    if matches!(
        code.as_str(),
        "GIFT_CARD_STAFF_SESSION_INVALID" | "GIFT_CARD_STAFF_SESSION_REQUIRED"
    ) {
        if let Some(owner) = plan.session_owner.as_deref() {
            opening::invalidate_hosted_cashier(owner);
        }
    }
    if a.original.mode == Mode::ManagerGrant && matches!(status, Some(401 | 403)) {
        drop_grant_authority(&a.original.staff_id);
    }
    let message = match status {
        Some(401 | 403) => {
            "Hosted staff authorization was refused; authorize again and recover the same attempt"
        }
        Some(429) => "The server is rate limiting; recover the same attempt later",
        _ if terminal => "The server refused this funding request",
        _ => {
            "The funding outcome is not confirmed; recover the same attempt and never collect again"
        }
    };
    FundingError::new(code, message)
}

/// Under the DB lock after the send: strict adoption, then the response. A
/// late reply (after a dedicated clear, or outside the attempt's current
/// trusted scope) still records the canonical proof. A foreign scope receives
/// no original attempt, and a cleared lifecycle never receives collection permission.
fn finish_step(
    conn: &Connection,
    plan: &SendPlan,
    reply: Result<&Value, &AdminFetchError>,
    now: DateTime<Utc>,
) -> Result<Value, String> {
    let Some(attempt) = load_attempt(conn, &plan.attempt_key)? else {
        return Ok(not_found().to_value(None));
    };
    let outcome = match reply {
        Err(error) => Err(record_failure(conn, &attempt, plan, error, now)),
        Ok(body) => match parse_funding_response(body, &attempt) {
            Ok(result) => adopt(conn, &attempt, plan.step, result, now),
            Err(code) => {
                record_code(conn, &plan.attempt_key, code, now);
                Err(FundingError::new(
                    code,
                    "The funding reply failed strict validation; nothing was adopted",
                ))
            }
        },
    };
    let fresh = load_attempt(conn, &plan.attempt_key)?.unwrap_or(attempt);
    if fresh.original.mode == Mode::ManagerGrant
        && matches!(fresh.state, AttemptState::Completed | AttemptState::Refused)
    {
        drop_grant_authority(&fresh.original.staff_id);
    }
    info!(
        attempt_key = %fresh.original.attempt_key,
        state = fresh.state.as_str(),
        "gift funding step settled"
    );
    let same_scope =
        opening::trusted_scope(conn).is_some_and(|scope| scope_matches(&scope, &fresh.original));
    if !same_scope {
        return Ok(scope_changed().to_value(None));
    }
    match outcome {
        Ok((card_number, collection_claimed)) => {
            let fenced_in = funding_auth().admits(plan.fence);
            let card_number = card_number.filter(|_| {
                fenced_in
                    && fresh.state == AttemptState::Completed
                    && fresh.original.operation == Operation::Issue
            });
            let mut response = attempt_response(&fresh, card_number);
            response["attempt"]["collectionPermitted"] = json!(
                collection_claimed
                    && plan.allow_collection
                    && fenced_in
                    && collection_permitted(&fresh)
            );
            Ok(response)
        }
        Err(error) => Ok(error.to_value(Some(&fresh))),
    }
}

// ---------------------------------------------------------------------------
// Current drawer read: deliberate replay of the stored original opening
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct DrawerView {
    opening_key: String,
    shift_id: String,
    drawer_id: String,
    staff_id: String,
    currency: String,
    version: i64,
    acknowledgement_id: Option<String>,
    gift_cash_cents: i64,
    ordinary_expected_cents: i64,
    expected_cents: i64,
}

impl DrawerView {
    fn to_value(&self) -> Value {
        json!({
            "openingKey": self.opening_key,
            "shiftId": self.shift_id,
            "drawerId": self.drawer_id,
            "staffId": self.staff_id,
            "currency": self.currency,
            "version": self.version,
            "acknowledgementId": self.acknowledgement_id,
            "giftCashCents": self.gift_cash_cents,
            "ordinaryExpectedCents": self.ordinary_expected_cents,
            "expectedCents": self.expected_cents,
        })
    }
}

struct ReadPlan {
    opening_key: String,
    cashier: HostedCashierScope,
    body: Value,
    staff_session: String,
    fence: u64,
}

impl fmt::Debug for ReadPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReadPlan")
            .field("opening_key", &self.opening_key)
            .finish_non_exhaustive()
    }
}

/// The stored original opening body and the same cashier's current private
/// authorization; no new endpoint, queue item or key.
fn plan_current_read(
    conn: &Connection,
    staff_id: &str,
    now: DateTime<Utc>,
) -> Result<ReadPlan, FundingError> {
    let scope = opening::trusted_scope(conn).ok_or_else(scope_unavailable)?;
    let cashier_scope = cashier_scope(&scope, staff_id);
    let cashier =
        opening::scoped_hosted_cashier(conn, &cashier_scope, now).map_err(hosted_refusal)?;
    let intent = opening::load_intent(conn, cashier.opening_key())
        .map_err(local_error)?
        .ok_or_else(|| hosted_refusal(HostedAccessError::NoOriginalOpening))?;
    Ok(ReadPlan {
        opening_key: intent.opening_key.clone(),
        cashier: cashier_scope,
        body: opening::build_sync_body(&intent),
        staff_session: cashier.staff_session_header().to_string(),
        fence: capture_fence(),
    })
}

/// Applies the strict nondecreasing pinned projection through the accepted
/// opening parser/persistence, then answers only from the fresh local proof.
/// An unknown read refuses; an unusable or closed original never reopens.
fn finish_current_read(
    conn: &Connection,
    plan: &ReadPlan,
    reply: Result<&Value, &AdminFetchError>,
    now: DateTime<Utc>,
) -> Result<DrawerView, FundingError> {
    match opening::apply_sync_result(conn, &plan.opening_key, reply, now) {
        DispatchOutcome::Confirmed {
            state: OpeningState::ConfirmedUsable,
        } => {}
        DispatchOutcome::Confirmed { .. } => {
            return Err(FundingError::new(
                "OPENING_UNUSABLE",
                "The original drawer is no longer usable",
            ))
        }
        DispatchOutcome::Retained { code } => {
            return Err(FundingError::new(
                "CURRENT_READ_UNCONFIRMED",
                format!("The current drawer read was not confirmed ({code})"),
            ))
        }
    }
    if !funding_auth().admits(plan.fence) {
        return Err(FundingError::new(
            "HOSTED_AUTHORIZATION_SUPERSEDED",
            "Authorization was cleared during the read; authorize again",
        ));
    }
    let cashier =
        opening::scoped_hosted_cashier(conn, &plan.cashier, now).map_err(hosted_refusal)?;
    if cashier.opening_key() != plan.opening_key {
        return Err(FundingError::new(
            "OPENING_CHANGED",
            "The cashier's original opening changed during the read",
        ));
    }
    let intent = opening::load_intent(conn, &plan.opening_key)
        .map_err(local_error)?
        .ok_or_else(|| hosted_refusal(HostedAccessError::NoOriginalOpening))?;
    let drawer = intent.drawer.as_ref().ok_or_else(|| {
        FundingError::new(
            "CURRENT_DRAWER_UNAVAILABLE",
            "No strict drawer projection is recorded",
        )
    })?;
    if drawer
        .ordinary_expected_cents
        .checked_add(drawer.gift_cash_cents)
        != Some(drawer.expected_cents)
    {
        return Err(FundingError::new(
            "DRAWER_NOT_CONSERVED",
            "The drawer projection is not conserved",
        ));
    }
    Ok(DrawerView {
        opening_key: intent.opening_key.clone(),
        shift_id: intent.shift_id.clone(),
        drawer_id: intent.drawer_id.clone(),
        staff_id: intent.staff_id.clone(),
        currency: intent.currency.clone(),
        version: drawer.version,
        acknowledgement_id: drawer.acknowledgement_id.clone(),
        gift_cash_cents: drawer.gift_cash_cents,
        ordinary_expected_cents: drawer.ordinary_expected_cents,
        expected_cents: drawer.expected_cents,
    })
}

// ---------------------------------------------------------------------------
// Async services (DB lock never held across an await)
// ---------------------------------------------------------------------------

fn lock(db: &db::DbState) -> Result<MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| format!("lock: {e}"))
}

async fn send(url: &str, api_key: &str, plan: &SendPlan) -> Result<Value, AdminFetchError> {
    if plan.method == "GET" {
        // A status read presents the original key; it never writes money.
        return api::fetch_raw_from_admin_detailed(
            url,
            api_key,
            &plan.path,
            "GET",
            "application/json",
            &[
                ("x-staff-session-id", plan.staff_session.as_str()),
                ("idempotency-key", plan.attempt_key.as_str()),
            ],
            Vec::new(),
        )
        .await;
    }
    api::fetch_from_admin_detailed_with_staff_session(
        url,
        api_key,
        &plan.path,
        plan.method,
        plan.body.clone(),
        Some(plan.staff_session.as_str()),
        HTTP_TIMEOUT,
    )
    .await
}

async fn drive(db: &db::DbState, key: &str, requested: Requested) -> Result<Value, String> {
    let endpoint = crate::resolve_admin_endpoint(Some(db)).await.ok();
    let plan = {
        let conn = lock(db)?;
        match plan_step(&conn, key, &requested, endpoint.is_some(), Utc::now()) {
            Ok(Planned::Send(plan)) => plan,
            Ok(Planned::Settled(attempt)) => return Ok(attempt_response(&attempt, None)),
            Err(refusal) => return Ok(refusal),
        }
    };
    let Some((url, api_key)) = endpoint else {
        return Ok(not_configured().to_value(None));
    };
    let reply = send(&url, &api_key, &plan).await;
    let conn = lock(db)?;
    finish_step(&conn, &plan, reply.as_ref(), Utc::now())
}

async fn current_read(
    db: &db::DbState,
    staff_id: &str,
) -> Result<Result<DrawerView, FundingError>, String> {
    let Ok((url, api_key)) = crate::resolve_admin_endpoint(Some(db)).await else {
        return Ok(Err(not_configured()));
    };
    let plan = {
        let conn = lock(db)?;
        match plan_current_read(&conn, staff_id, Utc::now()) {
            Ok(plan) => plan,
            Err(error) => return Ok(Err(error)),
        }
    };
    let reply = api::fetch_from_admin_detailed_with_staff_session(
        &url,
        &api_key,
        SHIFT_SYNC_PATH,
        "POST",
        Some(plan.body.clone()),
        Some(plan.staff_session.as_str()),
        HTTP_TIMEOUT,
    )
    .await;
    let conn = lock(db)?;
    Ok(finish_current_read(
        &conn,
        &plan,
        reply.as_ref(),
        Utc::now(),
    ))
}

async fn prepare_funding(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let request = match FundingRequest::parse(payload, false) {
        Ok(request) => request,
        Err(error) => return Ok(error.to_value(None)),
    };
    let attempt = {
        let conn = lock(db)?;
        match open_cashier_attempt(&conn, &request, Utc::now()) {
            Ok(attempt) => attempt,
            Err(error) => return Ok(error.to_value(None)),
        }
    };
    let key = attempt.original.attempt_key.clone();
    if attempt.original.mode == Mode::Cash
        && attempt.state == AttemptState::PreparePending
        && attempt.prepare_sends == 0
    {
        // Actual current drawer before any cash request; unknown refuses.
        let verified = match current_read(db, &attempt.original.staff_id).await? {
            Ok(drawer)
                if attempt
                    .original
                    .drawer_id
                    .as_deref()
                    .is_some_and(|id| same_uuid(id, &drawer.drawer_id))
                    && attempt
                        .original
                        .shift_id
                        .as_deref()
                        .is_some_and(|id| same_uuid(id, &drawer.shift_id)) =>
            {
                if drawer.currency == attempt.original.currency {
                    Ok(())
                } else {
                    Err(FundingError::new(
                        "CASH_CURRENCY_MISMATCH",
                        "Cash funding must use the original drawer currency",
                    ))
                }
            }
            Ok(_) => Err(FundingError::new(
                "ORIGINAL_DRAWER_UNAVAILABLE",
                "Cash funding continues only on its original open drawer",
            )),
            Err(error) => Err(error),
        };
        if let Err(error) = verified {
            let conn = lock(db)?;
            refuse_unsent(&conn, &key, &error.code, Utc::now());
            let fresh = load_attempt(&conn, &key)?;
            return Ok(error.to_value(fresh.as_ref()));
        }
    }
    drive(db, &key, Requested::Resume).await
}

async fn grant_funding(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let request = match FundingRequest::parse(payload, true) {
        Ok(request) => request,
        Err(error) => return Ok(error.to_value(None)),
    };
    let key = {
        let conn = lock(db)?;
        match open_grant_attempt(&conn, &request, Utc::now()) {
            Ok(attempt) => attempt.original.attempt_key,
            Err(error) => return Ok(error.to_value(None)),
        }
    };
    drive(db, &key, Requested::Resume).await
}

/// Separately selected manager, transient PIN, the exact hosted check-in and
/// its validation (a staff session, never a drawer). Fenced by the dedicated
/// clear; the trusted scope is rechecked before anything is installed.
async fn authorize_manager(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let Some(obj) = payload
        .as_object()
        .filter(|obj| obj.keys().all(|key| key == "staffId" || key == "pin"))
    else {
        return Ok(FundingError::new(
            "INVALID_FUNDING_REQUEST",
            "Only staffId and pin are accepted",
        )
        .to_value(None));
    };
    let Some(staff_id) = uuid_field(obj, "staffId") else {
        return Ok(FundingError::new("INVALID_STAFF_ID", "staffId must be a UUID").to_value(None));
    };
    let scope = {
        let conn = lock(db)?;
        match opening::trusted_scope(&conn) {
            Some(scope) => scope,
            None => return Ok(scope_unavailable().to_value(None)),
        }
    };
    let fence = capture_fence();
    let issued = match opening::issue_selected_staff_session(db, &scope, &staff_id, payload).await {
        Ok(issued) => issued,
        Err(error) => return Ok(FundingError::new(error.code, error.message).to_value(None)),
    };
    let conn = lock(db)?;
    if opening::trusted_scope(&conn).as_ref() != Some(&scope) {
        return Ok(scope_changed().to_value(None));
    }
    if !same_uuid(issued.staff_id(), &staff_id) {
        return Ok(FundingError::new(
            "HOSTED_STAFF_MISMATCH",
            "Hosted manager authorization was not accepted",
        )
        .to_value(None));
    }
    match install_grant_authority(
        fence,
        &scope,
        &staff_id,
        issued.staff_session_header(),
        issued.usable_until(),
        Utc::now(),
    ) {
        Ok(until) => Ok(json!({
            "success": true,
            "authorization": { "staffId": staff_id, "expiresAt": normalize_instant(until) },
        })),
        Err(error) => Ok(error.to_value(None)),
    }
}

async fn refresh_drawer(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    let Some(staff_id) = payload
        .as_object()
        .filter(|obj| obj.keys().all(|key| key == "staffId"))
        .and_then(|obj| uuid_field(obj, "staffId"))
    else {
        return Ok(FundingError::new("INVALID_STAFF_ID", "staffId must be a UUID").to_value(None));
    };
    Ok(match current_read(db, &staff_id).await? {
        Ok(drawer) => json!({ "success": true, "drawer": drawer.to_value() }),
        Err(error) => error.to_value(None),
    })
}

/// Nonsecret attempts of the current trusted scope: one by key, or the
/// unresolved ones first and then the most recent. An unverifiable scope, or
/// a key of another scope, yields none.
fn status_in(conn: &Connection, key: Option<&str>) -> Result<Value, String> {
    // An unverifiable scope is unknown, never an empty (healthy) journal.
    let Some(scope) = opening::trusted_scope(conn) else {
        return Ok(scope_unavailable().to_value(None));
    };
    let attempts = match key {
        Some(key) => load_attempt(conn, key)?
            .filter(|attempt| scope_matches(&scope, &attempt.original))
            .into_iter()
            .collect::<Vec<_>>(),
        None => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {ATTEMPT_COLUMNS} FROM gift_card_funding_attempts
                     WHERE lower(organization_id) = lower(?1) AND lower(branch_id) = lower(?2)
                       AND terminal_id = ?3
                     ORDER BY CASE WHEN state IN {TERMINAL_STATES_SQL} THEN 1 ELSE 0 END,
                              created_at DESC, rowid DESC
                     LIMIT ?4"
                ))
                .map_err(|e| format!("prepare funding status: {e}"))?;
            let rows = stmt
                .query_map(
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        STATUS_LIMIT
                    ],
                    attempt_from_row,
                )
                .map_err(|e| format!("query funding status: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("read funding status: {e}"))?
        }
    };
    Ok(json!({
        "success": true,
        "attempts": attempts.iter().map(attempt_view).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// Unresolved-funding blocker for the later close integration
// ---------------------------------------------------------------------------

/// One unresolved funding attempt a close must refuse on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UnresolvedFunding {
    pub attempt_key: String,
    pub state: &'static str,
    pub mode: &'static str,
    pub amount_cents: i64,
    pub currency: String,
    pub shift_id: Option<String>,
}

/// Unresolved attempts of the current trusted scope, optionally only those of
/// one original shift: its cash drawer attempts and the cashier attempts its
/// original authorized. `Err` (an unverifiable scope or a local read failure)
/// must block as well.
pub(crate) fn unresolved_funding(
    conn: &Connection,
    shift_id: Option<&str>,
) -> Result<Vec<UnresolvedFunding>, String> {
    let scope = opening::trusted_scope(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM gift_card_funding_attempts a
             WHERE lower(a.organization_id) = lower(?1) AND lower(a.branch_id) = lower(?2)
               AND a.terminal_id = ?3
               AND a.state NOT IN {TERMINAL_STATES_SQL}
               AND (?4 IS NULL OR lower(a.shift_id) = lower(?4)
                    OR a.authority_opening_key IN (
                        SELECT o.opening_key FROM gift_financial_openings o
                        WHERE lower(o.shift_id) = lower(?4)))
             ORDER BY a.created_at, a.rowid"
        ))
        .map_err(|e| format!("prepare unresolved funding: {e}"))?;
    let rows = stmt
        .query_map(
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                shift_id
            ],
            attempt_from_row,
        )
        .map_err(|e| format!("query unresolved funding: {e}"))?;
    let attempts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read unresolved funding: {e}"))?;
    Ok(attempts
        .into_iter()
        .map(|attempt| UnresolvedFunding {
            attempt_key: attempt.original.attempt_key,
            state: attempt.state.as_str(),
            mode: attempt.original.mode.as_str(),
            amount_cents: attempt.original.amount_cents,
            currency: attempt.original.currency,
            shift_id: attempt.original.shift_id,
        })
        .collect())
}

fn close_blocker_value(conn: &Connection, payload: Option<&Value>) -> Value {
    let shift_id = match payload.and_then(|payload| payload.get("shiftId")) {
        None | Some(Value::Null) => None,
        Some(value) => match value
            .as_str()
            .map(|id| id.trim().to_ascii_lowercase())
            .filter(|id| is_uuid(id))
        {
            Some(id) => Some(id),
            None => {
                return FundingError::new("INVALID_SHIFT_ID", "shiftId must be a UUID")
                    .to_value(None)
            }
        },
    };
    match unresolved_funding(conn, shift_id.as_deref()) {
        Ok(unresolved) => json!({
            "success": true,
            "blocked": !unresolved.is_empty(),
            "shiftId": shift_id,
            "unresolved": unresolved.iter().map(|item| json!({
                "attemptKey": item.attempt_key,
                "state": item.state,
                "mode": item.mode,
                "amountCents": item.amount_cents,
                "currency": item.currency,
                "shiftId": item.shift_id,
            })).collect::<Vec<_>>(),
        }),
        Err(error) => {
            warn!("gift funding blocker unavailable: {error}");
            FundingError::new(
                "FUNDING_BLOCKER_UNAVAILABLE",
                "Unresolved funding could not be verified; treat as blocked",
            )
            .to_value(None)
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (positional `{ arg0: payload }` envelope)
// ---------------------------------------------------------------------------

const MISSING_PAYLOAD: &str = "Missing gift funding payload";

/// Records the immutable cash/external original, then sends its prepare.
#[tauri::command]
pub async fn gift_funding_prepare(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    prepare_funding(&db, &payload).await
}

/// Persists the begin acknowledgement before returning collection permission.
#[tauri::command]
pub async fn gift_funding_begin_collection(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    match attempt_key_arg(&payload, &[]) {
        Ok(key) => drive(&db, &key, Requested::BeginCollection).await,
        Err(error) => Ok(error.to_value(None)),
    }
}

/// Records the complete body once (operator evidence), then sends it.
#[tauri::command]
pub async fn gift_funding_complete(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    match attempt_key_arg(&payload, &["evidence"]) {
        Ok(key) => {
            let evidence = payload.get("evidence").cloned().unwrap_or(Value::Null);
            drive(&db, &key, Requested::Complete(evidence)).await
        }
        Err(error) => Ok(error.to_value(None)),
    }
}

/// Cancels only a never-collected original (or abandons a never-sent one).
#[tauri::command]
pub async fn gift_funding_cancel(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    let key = match attempt_key_arg(&payload, &["reason"]) {
        Ok(key) => key,
        Err(error) => return Ok(error.to_value(None)),
    };
    let Some(reason) = payload
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| (1..=500).contains(&js_len(reason)))
    else {
        return Ok(FundingError::new(
            "INVALID_FUNDING_REQUEST",
            "A reason of 1..500 characters is required",
        )
        .to_value(None));
    };
    drive(&db, &key, Requested::Cancel(reason.to_string())).await
}

/// Replays the pending step with its original key and stored body, or reads
/// the status of a prepared/collecting intent. An explicit check of a completed
/// issue may retrieve its number from the original intent under fresh authority.
#[tauri::command]
pub async fn gift_funding_recover(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    match attempt_key_arg(&payload, &[]) {
        Ok(key) => drive(&db, &key, Requested::Recover).await,
        Err(error) => Ok(error.to_value(None)),
    }
}

/// Separate, volatile manager grant authority (cleared by the dedicated
/// `shift_financial_opening_clear_authorization` boundary).
#[tauri::command]
pub async fn gift_funding_authorize_manager(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    authorize_manager(&db, &payload).await
}

/// Records the immutable grant original, then sends it with the manager's
/// separate authority; the server enforces `pos.gift_cards.grant`.
#[tauri::command]
pub async fn gift_funding_grant(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    grant_funding(&db, &payload).await
}

#[tauri::command]
pub async fn gift_funding_status(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let conn = lock(&db)?;
    let key = arg0
        .as_ref()
        .and_then(|payload| payload.get("attemptKey"))
        .and_then(Value::as_str)
        .map(|key| key.trim().to_ascii_lowercase());
    status_in(&conn, key.as_deref())
}

/// Current strict drawer of the selected cashier's usable original.
#[tauri::command]
pub async fn gift_funding_refresh_drawer(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    refresh_drawer(&db, &payload).await
}

#[tauri::command]
pub async fn gift_funding_close_blocker(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let conn = lock(&db)?;
    Ok(close_blocker_value(&conn, arg0.as_ref()))
}

// Advisory hosted availability (`GET /api/pos/gift-cards/status`) with the
// selected purpose authority's private session.
#[path = "gift_card_funding_availability.rs"]
mod availability;

/// Advisory hosted funding availability for the selected cashier or the
/// separately authorized manager: one private-header status read that consumes
/// no grant and writes nothing. Not the local journal (`gift_funding_status`).
#[tauri::command]
pub async fn gift_funding_availability(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or(MISSING_PAYLOAD)?;
    availability::read_availability(&db, &payload).await
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

fn str_field<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn uuid_field(obj: &Map<String, Value>, key: &str) -> Option<String> {
    str_field(obj, key)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| is_uuid(value))
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36 && Uuid::parse_str(value).is_ok()
}

fn same_uuid(left: &str, right: &str) -> bool {
    is_uuid(left) && is_uuid(right) && left.eq_ignore_ascii_case(right)
}

fn is_currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase())
}

fn is_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// JavaScript string length (UTF-16 units), as the shared Zod bounds count.
fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Millisecond `Z` instant, identical to JavaScript `toISOString()`.
fn normalize_instant(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
#[path = "gift_card_funding_tests.rs"]
mod tests;
