//! Windows original gift-card financial closing journal (local schema v88).
//!
//! One nonsecret original per confirmed financial opening, shift and drawer:
//! the exact original `shift_close` event body its caller queues, that queue
//! item id and closing key, the original actor/scope, the owner/source
//! terminal DB pins of the confirmed opening and the drawer fingerprint the
//! count was taken against.
//!
//! Boundary: [`capture_original`] only records that original inside the
//! caller's already open SQLite transaction. It never begins or commits,
//! writes or consumes no queue item, closes no local shift or drawer and makes
//! no hosted call. The capture integration that calls it owns the
//! unresolved-funding race guard, the ordinary drawer reconciliation, the
//! mirror close and the queue write in that same transaction. A captured
//! original is `pending`: it is neither a closed production drawer nor hosted
//! proof.
//!
//! [`judge_closing_response`] reads one shift-sync reply strictly: only the
//! single event result's `financial_closing` proof of exactly this original
//! counts, never an HTTP status (207 included), `success`, `ok` or `skipped`.
//! [`adopt_closing_response`] adopts that proof inside the caller's open
//! transaction: the canonical close onto the locally closed shift and drawer
//! mirrors, the financial opening retired as unusable and the proof frozen in
//! the journal. It makes no hosted call, consumes no queue item and grants no
//! authority; the dispatcher that calls it owns the request, authorization and
//! queue consumption in that same transaction.

// Bound by the closing capture and dispatch integrations; until then only
// tests call it.
#![cfg_attr(not(test), allow(dead_code))]

use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

use crate::gift_financial_opening::{self, DrawerState, OpeningIntent, OpeningState};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_TEXT_ID_LEN: usize = 200;
const MAX_BODY_BYTES: usize = 64 * 1024;
/// Normalized (ASCII alphanumeric, lowercase) object keys a nonsecret event
/// body never carries: hosted session, PIN, header and credential material.
const SECRET_KEYS: &[&str] = &[
    "pin",
    "staffsessionid",
    "xstaffsessionid",
    "sessiontoken",
    "headers",
    "authorization",
    "cookie",
    "password",
    "secret",
    "apikey",
    "accesstoken",
    "refreshtoken",
];

/// Local schema v88: the nonsecret closing original. The proof/canonical
/// columns are reserved for strict closing-proof adoption and stay NULL while
/// an original is `pending`; the guard trigger keeps the original tuple and an
/// adopted proof immutable.
pub(crate) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS gift_financial_closings (
    closing_key TEXT PRIMARY KEY NOT NULL,
    opening_key TEXT NOT NULL UNIQUE,
    queue_item_id TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    shift_id TEXT NOT NULL UNIQUE,
    drawer_id TEXT NOT NULL UNIQUE,
    owner_terminal_db_id TEXT NOT NULL,
    source_terminal_db_id TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
    counted_cents INTEGER NOT NULL
        CHECK (typeof(counted_cents) = 'integer' AND counted_cents BETWEEN 0 AND 9007199254740991),
    closed_at TEXT NOT NULL,
    drawer_version INTEGER NOT NULL
        CHECK (typeof(drawer_version) = 'integer' AND drawer_version BETWEEN 0 AND 9007199254740991),
    drawer_acknowledgement_id TEXT,
    drawer_gift_cash_cents INTEGER NOT NULL
        CHECK (typeof(drawer_gift_cash_cents) = 'integer'
               AND drawer_gift_cash_cents BETWEEN 0 AND 9007199254740991),
    drawer_ordinary_expected_cents INTEGER NOT NULL
        CHECK (typeof(drawer_ordinary_expected_cents) = 'integer'
               AND drawer_ordinary_expected_cents BETWEEN -9007199254740991 AND 9007199254740991),
    drawer_expected_cents INTEGER NOT NULL
        CHECK (typeof(drawer_expected_cents) = 'integer'
               AND drawer_expected_cents BETWEEN -9007199254740991 AND 9007199254740991),
    variance_cents INTEGER NOT NULL
        CHECK (typeof(variance_cents) = 'integer'
               AND variance_cents BETWEEN -9007199254740991 AND 9007199254740991),
    request_body_json TEXT NOT NULL
        CHECK (json_valid(request_body_json) AND json_type(request_body_json) = 'object'),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed')),
    pending_reason TEXT
        CHECK (pending_reason IS NULL
               OR (length(pending_reason) BETWEEN 1 AND 100
                   AND pending_reason GLOB '[A-Z]*'
                   AND pending_reason NOT GLOB '*[^A-Z0-9_]*')),
    confirmation_json TEXT,
    canonical_closed_at TEXT,
    confirmed_at TEXT,
    adopted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (variance_cents = counted_cents - drawer_expected_cents),
    CHECK (state = 'confirmed'
           OR (confirmation_json IS NULL AND canonical_closed_at IS NULL
               AND confirmed_at IS NULL AND adopted_at IS NULL)),
    CHECK (state = 'pending'
           OR (confirmation_json IS NOT NULL AND json_valid(confirmation_json)
               AND confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_gift_financial_closings_actor
    ON gift_financial_closings(organization_id, branch_id, terminal_id, staff_id, state);
CREATE TRIGGER IF NOT EXISTS trg_gift_financial_closings_original_immutable
BEFORE UPDATE ON gift_financial_closings
WHEN OLD.closing_key IS NOT NEW.closing_key
  OR OLD.opening_key IS NOT NEW.opening_key
  OR OLD.queue_item_id IS NOT NEW.queue_item_id
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.branch_id IS NOT NEW.branch_id
  OR OLD.terminal_id IS NOT NEW.terminal_id
  OR OLD.staff_id IS NOT NEW.staff_id
  OR OLD.shift_id IS NOT NEW.shift_id
  OR OLD.drawer_id IS NOT NEW.drawer_id
  OR OLD.owner_terminal_db_id IS NOT NEW.owner_terminal_db_id
  OR OLD.source_terminal_db_id IS NOT NEW.source_terminal_db_id
  OR OLD.currency IS NOT NEW.currency
  OR OLD.counted_cents IS NOT NEW.counted_cents
  OR OLD.closed_at IS NOT NEW.closed_at
  OR OLD.drawer_version IS NOT NEW.drawer_version
  OR OLD.drawer_acknowledgement_id IS NOT NEW.drawer_acknowledgement_id
  OR OLD.drawer_gift_cash_cents IS NOT NEW.drawer_gift_cash_cents
  OR OLD.drawer_ordinary_expected_cents IS NOT NEW.drawer_ordinary_expected_cents
  OR OLD.drawer_expected_cents IS NOT NEW.drawer_expected_cents
  OR OLD.variance_cents IS NOT NEW.variance_cents
  OR OLD.request_body_json IS NOT NEW.request_body_json
  OR OLD.created_at IS NOT NEW.created_at
  OR (OLD.state = 'confirmed'
      AND (NEW.state IS NOT 'confirmed'
           OR OLD.confirmation_json IS NOT NEW.confirmation_json
           OR OLD.canonical_closed_at IS NOT NEW.canonical_closed_at
           OR OLD.confirmed_at IS NOT NEW.confirmed_at))
BEGIN
    SELECT RAISE(ABORT, 'GIFT_FINANCIAL_CLOSING_ORIGINAL_IMMUTABLE');
END;
";

// ---------------------------------------------------------------------------
// Errors, state and the original
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClosingError {
    pub code: &'static str,
    pub message: String,
}

impl ClosingError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ClosingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

fn storage_error(message: String) -> ClosingError {
    ClosingError::new("CLOSING_STORAGE_FAILED", message)
}

/// `pending` until [`adopt_closing_response`] adopts the hosted proof;
/// capture only writes `pending`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClosingState {
    Pending,
    Confirmed,
}

impl ClosingState {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "confirmed" => Some(Self::Confirmed),
            _ => None,
        }
    }
}

/// The structured capture input, prepared by the closing capture integration.
/// Organization, branch and public terminal come from the trusted native
/// scope (`OpeningScope::resolve`), never renderer input. `request_body` is
/// the exact original `shift_close` event that caller queues under
/// `queue_item_id`; this module never builds another hosted operation or key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClosingCapture {
    pub closing_key: String,
    pub opening_key: String,
    pub queue_item_id: String,
    pub organization_id: String,
    pub branch_id: String,
    pub terminal_id: String,
    pub staff_id: String,
    pub shift_id: String,
    pub drawer_id: String,
    pub owner_terminal_db_id: String,
    pub source_terminal_db_id: String,
    pub currency: String,
    pub counted_cents: i64,
    /// Local closing time as a millisecond `Z` instant.
    pub closed_at: String,
    /// Input only, never stored: the complete hosted drawer fingerprint
    /// (version, nullable ACK, gift/ordinary/total) of the confirmed opening
    /// the close was approved against, checked in full on a first capture.
    pub confirmed_drawer: DrawerState,
    /// The local approved preview the count was taken against, stored as the
    /// original's drawer: the confirmed version, ACK and gift cash, the
    /// separately approved local ordinary expected and their sum. Before
    /// hosted synchronization its ordinary and total terms may differ from
    /// `confirmed_drawer`.
    pub drawer: DrawerState,
    pub request_body: Value,
}

impl ClosingCapture {
    fn validate(&self) -> Result<(), ClosingError> {
        let invalid = |message: &str| -> Result<(), ClosingError> {
            Err(ClosingError::new("INVALID_CLOSING_CAPTURE", message))
        };
        if !is_lower_uuid(&self.closing_key) || !is_lower_uuid(&self.opening_key) {
            return invalid("closingKey and openingKey must be lowercase UUIDs");
        }
        if ![
            &self.queue_item_id,
            &self.terminal_id,
            &self.shift_id,
            &self.drawer_id,
        ]
        .iter()
        .all(|id| is_text_id(id))
        {
            return invalid(
                "queue item, public terminal, shift and drawer identities are required",
            );
        }
        if ![
            &self.organization_id,
            &self.branch_id,
            &self.staff_id,
            &self.owner_terminal_db_id,
            &self.source_terminal_db_id,
        ]
        .iter()
        .all(|id| is_uuid(id))
        {
            return invalid("organization, branch, staff and terminal DB identities must be UUIDs");
        }
        if !is_currency(&self.currency) {
            return invalid("currency must be an uppercase ISO 4217 code");
        }
        if !(0..=MAX_SAFE_INTEGER).contains(&self.counted_cents) {
            return invalid("countedCents must be nonnegative safe integer cents");
        }
        if !is_millisecond_instant(&self.closed_at) {
            return invalid("closedAt must be a millisecond UTC instant");
        }
        let safe_drawer = |drawer: &DrawerState| {
            (0..=MAX_SAFE_INTEGER).contains(&drawer.version)
                && (0..=MAX_SAFE_INTEGER).contains(&drawer.gift_cash_cents)
                && is_safe_signed(drawer.ordinary_expected_cents)
                && is_safe_signed(drawer.expected_cents)
                && !drawer
                    .acknowledgement_id
                    .as_deref()
                    .is_some_and(|ack| !is_text_id(ack))
        };
        let (drawer, confirmed) = (&self.drawer, &self.confirmed_drawer);
        if !safe_drawer(drawer) || !safe_drawer(confirmed) {
            return invalid("the pinned drawer must carry a safe version and safe integer cents");
        }
        // The local preview keeps the confirmed version, ACK and gift cash and
        // expects exactly its approved ordinary cash plus that gift cash.
        if drawer.version != confirmed.version
            || drawer.acknowledgement_id != confirmed.acknowledgement_id
            || drawer.gift_cash_cents != confirmed.gift_cash_cents
            || drawer
                .ordinary_expected_cents
                .checked_add(drawer.gift_cash_cents)
                != Some(drawer.expected_cents)
        {
            return invalid(
                "the local preview must keep the confirmed gift terms and add its ordinary cash",
            );
        }
        if self.variance_cents().is_none() {
            return invalid("the count variance must be a safe integer");
        }
        if !self.request_body.is_object() || carries_secret(&self.request_body) {
            return invalid("the original shift-close event must be a nonsecret JSON object");
        }
        if self.body_json()?.len() > MAX_BODY_BYTES {
            return invalid("the original shift-close event is too large");
        }
        Ok(())
    }

    fn variance_cents(&self) -> Option<i64> {
        self.counted_cents
            .checked_sub(self.drawer.expected_cents)
            .filter(|variance| is_safe_signed(*variance))
    }

    fn body_json(&self) -> Result<String, ClosingError> {
        serde_json::to_string(&self.request_body).map_err(|e| {
            ClosingError::new(
                "INVALID_CLOSING_CAPTURE",
                format!("serialize closing event: {e}"),
            )
        })
    }

    /// Every identity field of the actual confirmed original, including the
    /// owner/source terminal DB pins its stored proof carried.
    fn matches_opening(&self, intent: &OpeningIntent, owner: &str, source: &str) -> bool {
        self.opening_key == intent.opening_key
            && same_uuid(&self.organization_id, &intent.organization_id)
            && same_uuid(&self.branch_id, &intent.branch_id)
            && self.terminal_id == intent.terminal_id
            && same_uuid(&self.staff_id, &intent.staff_id)
            && self.shift_id == intent.shift_id
            && self.drawer_id == intent.drawer_id
            && self.currency == intent.currency
            && same_uuid(&self.owner_terminal_db_id, owner)
            && same_uuid(&self.source_terminal_db_id, source)
    }
}

/// The stored original, exactly as persisted. Identity fields are the
/// confirmed opening's own values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClosingOriginal {
    pub closing_key: String,
    pub opening_key: String,
    pub queue_item_id: String,
    pub organization_id: String,
    pub branch_id: String,
    pub terminal_id: String,
    pub staff_id: String,
    pub shift_id: String,
    pub drawer_id: String,
    pub owner_terminal_db_id: String,
    pub source_terminal_db_id: String,
    pub currency: String,
    pub counted_cents: i64,
    pub closed_at: String,
    pub drawer: DrawerState,
    pub variance_cents: i64,
    /// Exact serialized raw staff_shifts UPDATE payload; the dispatcher wraps it once as an event.
    pub request_body_json: String,
    pub state: ClosingState,
    pub pending_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl ClosingOriginal {
    /// The immutable original tuple; state and bookkeeping excluded.
    fn same_capture(&self, capture: &ClosingCapture) -> bool {
        self.closing_key == capture.closing_key
            && self.opening_key == capture.opening_key
            && self.queue_item_id == capture.queue_item_id
            && same_uuid(&self.organization_id, &capture.organization_id)
            && same_uuid(&self.branch_id, &capture.branch_id)
            && self.terminal_id == capture.terminal_id
            && same_uuid(&self.staff_id, &capture.staff_id)
            && self.shift_id == capture.shift_id
            && self.drawer_id == capture.drawer_id
            && same_uuid(&self.owner_terminal_db_id, &capture.owner_terminal_db_id)
            && same_uuid(&self.source_terminal_db_id, &capture.source_terminal_db_id)
            && self.currency == capture.currency
            && self.counted_cents == capture.counted_cents
            && self.closed_at == capture.closed_at
            && self.drawer == capture.drawer
            && serde_json::from_str::<Value>(&self.request_body_json)
                .is_ok_and(|body| body == capture.request_body)
    }
}

const ORIGINAL_COLUMNS: &str = "closing_key, opening_key, queue_item_id, organization_id, \
    branch_id, terminal_id, staff_id, shift_id, drawer_id, owner_terminal_db_id, \
    source_terminal_db_id, currency, counted_cents, closed_at, drawer_version, \
    drawer_acknowledgement_id, drawer_gift_cash_cents, drawer_ordinary_expected_cents, \
    drawer_expected_cents, variance_cents, request_body_json, state, pending_reason, \
    created_at, updated_at";

fn original_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClosingOriginal> {
    let state_text: String = row.get(21)?;
    let state = ClosingState::parse(&state_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(21, "state".into(), rusqlite::types::Type::Text)
    })?;
    Ok(ClosingOriginal {
        closing_key: row.get(0)?,
        opening_key: row.get(1)?,
        queue_item_id: row.get(2)?,
        organization_id: row.get(3)?,
        branch_id: row.get(4)?,
        terminal_id: row.get(5)?,
        staff_id: row.get(6)?,
        shift_id: row.get(7)?,
        drawer_id: row.get(8)?,
        owner_terminal_db_id: row.get(9)?,
        source_terminal_db_id: row.get(10)?,
        currency: row.get(11)?,
        counted_cents: row.get(12)?,
        closed_at: row.get(13)?,
        drawer: DrawerState {
            version: row.get(14)?,
            acknowledgement_id: row.get(15)?,
            gift_cash_cents: row.get(16)?,
            ordinary_expected_cents: row.get(17)?,
            expected_cents: row.get(18)?,
        },
        variance_cents: row.get(19)?,
        request_body_json: row.get(20)?,
        state,
        pending_reason: row.get(22)?,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
    })
}

pub(crate) fn load_original(
    conn: &Connection,
    closing_key: &str,
) -> Result<Option<ClosingOriginal>, String> {
    conn.query_row(
        &format!("SELECT {ORIGINAL_COLUMNS} FROM gift_financial_closings WHERE closing_key = ?1"),
        params![closing_key],
        original_from_row,
    )
    .optional()
    .map_err(|e| format!("load financial closing: {e}"))
}

pub(crate) fn load_original_for_opening(
    conn: &Connection,
    opening_key: &str,
) -> Result<Option<ClosingOriginal>, String> {
    conn.query_row(
        &format!("SELECT {ORIGINAL_COLUMNS} FROM gift_financial_closings WHERE opening_key = ?1"),
        params![opening_key],
        original_from_row,
    )
    .optional()
    .map_err(|e| format!("load financial closing for opening: {e}"))
}

/// Any stored original sharing the closing key, opening, queue item, shift or
/// drawer of `capture`.
fn colliding_originals(
    conn: &Connection,
    capture: &ClosingCapture,
) -> Result<Vec<ClosingOriginal>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ORIGINAL_COLUMNS} FROM gift_financial_closings
             WHERE closing_key = ?1 OR opening_key = ?2 OR queue_item_id = ?3
                OR shift_id = ?4 OR drawer_id = ?5
             LIMIT 2"
        ))
        .map_err(|e| format!("prepare financial closings: {e}"))?;
    let rows = stmt
        .query_map(
            params![
                capture.closing_key,
                capture.opening_key,
                capture.queue_item_id,
                capture.shift_id,
                capture.drawer_id
            ],
            original_from_row,
        )
        .map_err(|e| format!("query financial closings: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read financial closings: {e}"))
}

/// The opening's original-mirror predicate (private there): the original
/// active cashier shift of the original actor, branch and public terminal,
/// with its single linked drawer still open.
fn original_mirror_open(conn: &Connection, intent: &OpeningIntent) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS (
                SELECT 1 FROM staff_shifts s
                JOIN cash_drawer_sessions d ON d.id = ?2 AND d.staff_shift_id = s.id
                WHERE s.id = ?1
                  AND s.status = 'active'
                  AND s.role_type = 'cashier'
                  AND lower(s.staff_id) = lower(?3)
                  AND lower(s.branch_id) = lower(?4)
                  AND s.terminal_id = ?5
                  AND d.closed_at IS NULL
                  AND lower(d.cashier_id) = lower(?3)
                  AND lower(d.branch_id) = lower(?4)
                  AND d.terminal_id = ?5
            )
            AND (SELECT COUNT(*) FROM cash_drawer_sessions c WHERE c.staff_shift_id = ?1) = 1",
        params![
            intent.shift_id,
            intent.drawer_id,
            intent.staff_id,
            intent.branch_id,
            intent.terminal_id
        ],
        |row| row.get(0),
    )
    .map_err(|e| format!("read financial opening mirror: {e}"))
}

// ---------------------------------------------------------------------------
// Capture: one pending original inside the caller's transaction
// ---------------------------------------------------------------------------

/// Records the pending closing original inside the caller's open transaction
/// and returns the stored row with `true`, or replays an identical stored
/// original with `false`. The actual confirmed opening is reread and must
/// match every identity field. A first capture additionally requires a
/// confirmed usable opening whose current drawer is exactly the complete hosted
/// `confirmed_drawer` fingerprint and its still-open original mirror; the
/// journal stores the local approved preview `drawer`, and an identical
/// original (the same preview) replays after the local close. A
/// changed original never replaces the stored one. No BEGIN/COMMIT, queue
/// write/consumption or mirror close happens here.
pub(crate) fn capture_original(
    conn: &Connection,
    capture: &ClosingCapture,
    now: DateTime<Utc>,
) -> Result<(ClosingOriginal, bool), ClosingError> {
    if conn.is_autocommit() {
        return Err(ClosingError::new(
            "CLOSING_TRANSACTION_REQUIRED",
            "The closing capture must run inside the caller's open transaction",
        ));
    }
    capture.validate()?;
    let intent = gift_financial_opening::load_intent(conn, &capture.opening_key)
        .map_err(storage_error)?
        .ok_or_else(|| {
            ClosingError::new(
                "OPENING_NOT_FOUND",
                "No original financial opening has this key",
            )
        })?;
    if intent.state == OpeningState::Pending {
        return Err(ClosingError::new(
            "OPENING_NOT_CONFIRMED",
            "The original financial opening is not confirmed",
        ));
    }
    let (Some(owner), Some(source)) = (
        intent.owner_terminal_db_id.as_deref(),
        intent.source_terminal_db_id.as_deref(),
    ) else {
        return Err(ClosingError::new(
            "OPENING_PROOF_INCOMPLETE",
            "The confirmed opening has no pinned owner and source terminal",
        ));
    };
    if !capture.matches_opening(&intent, owner, source) {
        return Err(ClosingError::new(
            "OPENING_MISMATCH",
            "The closing does not match the original opening's actor and scope",
        ));
    }

    let existing = colliding_originals(conn, capture).map_err(storage_error)?;
    if let [original] = existing.as_slice() {
        if original.same_capture(capture) {
            return Ok((original.clone(), false));
        }
    }
    if !existing.is_empty() {
        return Err(ClosingError::new(
            "CLOSING_ORIGINAL_CONFLICT",
            "A different closing original already exists for this opening",
        ));
    }

    if intent.state != OpeningState::ConfirmedUsable {
        return Err(ClosingError::new(
            "OPENING_NOT_USABLE",
            "The original financial opening is not usable",
        ));
    }
    // The full hosted fingerprint, never the local preview, must be current.
    if intent.drawer.as_ref() != Some(&capture.confirmed_drawer) {
        return Err(ClosingError::new(
            "DRAWER_FINGERPRINT_MISMATCH",
            "The count was not taken against the current confirmed drawer",
        ));
    }
    if !original_mirror_open(conn, &intent).map_err(storage_error)? {
        return Err(ClosingError::new(
            "OPENING_MIRROR_NOT_OPEN",
            "The original shift and drawer are not open on this terminal",
        ));
    }

    let variance = capture.variance_cents().ok_or_else(|| {
        ClosingError::new(
            "INVALID_CLOSING_CAPTURE",
            "the count variance must be a safe integer",
        )
    })?;
    let body_json = capture.body_json()?;
    let now_text = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let drawer = &capture.drawer;
    conn.execute(
        "INSERT INTO gift_financial_closings (
            closing_key, opening_key, queue_item_id, organization_id, branch_id, terminal_id,
            staff_id, shift_id, drawer_id, owner_terminal_db_id, source_terminal_db_id, currency,
            counted_cents, closed_at, drawer_version, drawer_acknowledgement_id,
            drawer_gift_cash_cents, drawer_ordinary_expected_cents, drawer_expected_cents,
            variance_cents, request_body_json, state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                  ?18, ?19, ?20, ?21, 'pending', ?22, ?22)",
        params![
            capture.closing_key,
            intent.opening_key,
            capture.queue_item_id,
            intent.organization_id,
            intent.branch_id,
            intent.terminal_id,
            intent.staff_id,
            intent.shift_id,
            intent.drawer_id,
            owner,
            source,
            intent.currency,
            capture.counted_cents,
            capture.closed_at,
            drawer.version,
            drawer.acknowledgement_id,
            drawer.gift_cash_cents,
            drawer.ordinary_expected_cents,
            drawer.expected_cents,
            variance,
            body_json,
            now_text,
        ],
    )
    .map_err(|e| storage_error(format!("insert financial closing: {e}")))?;
    let stored = load_original(conn, &capture.closing_key)
        .map_err(storage_error)?
        .ok_or_else(|| {
            storage_error("the captured closing original could not be reread".to_string())
        })?;
    Ok((stored, true))
}

// ---------------------------------------------------------------------------
// Closing proof: strict parse and match of the per-event hosted proof
// ---------------------------------------------------------------------------

/// `GIFT_CARD_CLOSING_CONTRACT` in `shared/types/gift-card-closing.ts`.
pub(crate) const GIFT_CARD_CLOSING_CONTRACT: &str = "gift_closing_v1";
/// `GIFT_CARD_FUNDING_CONTRACT` of the frozen drawer inside a closing proof.
pub(crate) const GIFT_CARD_FUNDING_CONTRACT: &str = "gift_funding_v1";
/// Nothing proved this close yet: retry the same original close.
pub(crate) const GIFT_CARD_CLOSING_UNVERIFIED: &str = "GIFT_CARD_CLOSING_UNVERIFIED";
/// A valid proof of another close than this original.
pub(crate) const GIFT_CARD_CLOSING_MISMATCH: &str = "GIFT_CARD_CLOSING_MISMATCH";
/// The event's `financial_closing` is not a well-formed `gift_closing_v1` proof.
pub(crate) const GIFT_CARD_CLOSING_PROOF_INVALID: &str = "GIFT_CARD_CLOSING_PROOF_INVALID";
/// The event was skipped without a reason code.
pub(crate) const GIFT_CARD_CLOSING_SKIPPED: &str = "GIFT_CARD_CLOSING_SKIPPED";

/// Exactly the keys of the strict `giftCardFinancialClosingSchema`.
const CLOSING_PROOF_KEYS: &[&str] = &[
    "contract",
    "state",
    "organization_id",
    "branch_id",
    "terminal_id",
    "source_terminal_id",
    "owner_terminal_id",
    "shift_id",
    "drawer_id",
    "staff_id",
    "currency",
    "counted_cents",
    "variance_cents",
    "closed_at",
    "drawer",
];
/// Exactly the keys of the strict `giftCardFundingDrawerSchema`.
const DRAWER_PROOF_KEYS: &[&str] = &[
    "contract",
    "drawer_id",
    "shift_id",
    "owner_terminal_id",
    "currency",
    "gift_cash_cents",
    "ordinary_expected_cents",
    "expected_cents",
    "version",
    "acknowledgement_id",
];

type JsonMap = serde_json::Map<String, Value>;

/// The frozen drawer of a closing proof (`giftCardFundingDrawerSchema`):
/// expected = ordinary + gift at a version with its nullable ACK. Its unit is
/// the proof's currency.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalDrawer {
    pub drawer_id: String,
    pub shift_id: String,
    pub owner_terminal_id: String,
    pub gift_cash_cents: i64,
    pub ordinary_expected_cents: i64,
    pub expected_cents: i64,
    pub version: i64,
    pub acknowledgement_id: Option<String>,
}

/// The canonical close of one original (`giftCardFinancialClosingSchema`),
/// exactly as its hosted proof states it: the first counted close, the frozen
/// drawer and the signed variance = counted - expected. `closed_at` is the
/// canonical close time, which may differ from the original's local one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalClosing {
    pub organization_id: String,
    pub branch_id: String,
    pub terminal_id: String,
    pub source_terminal_id: String,
    pub owner_terminal_id: String,
    pub shift_id: String,
    pub drawer_id: String,
    pub staff_id: String,
    pub currency: String,
    pub counted_cents: i64,
    pub variance_cents: i64,
    pub closed_at: String,
    pub drawer: CanonicalDrawer,
}

impl CanonicalClosing {
    /// The proof in its `gift_closing_v1` wire shape, as `confirmation_json`
    /// stores it.
    pub(crate) fn to_value(&self) -> Value {
        let drawer = &self.drawer;
        serde_json::json!({
            "contract": GIFT_CARD_CLOSING_CONTRACT,
            "state": "closed",
            "organization_id": self.organization_id,
            "branch_id": self.branch_id,
            "terminal_id": self.terminal_id,
            "source_terminal_id": self.source_terminal_id,
            "owner_terminal_id": self.owner_terminal_id,
            "shift_id": self.shift_id,
            "drawer_id": self.drawer_id,
            "staff_id": self.staff_id,
            "currency": self.currency,
            "counted_cents": self.counted_cents,
            "variance_cents": self.variance_cents,
            "closed_at": self.closed_at,
            "drawer": {
                "contract": GIFT_CARD_FUNDING_CONTRACT,
                "drawer_id": drawer.drawer_id,
                "shift_id": drawer.shift_id,
                "owner_terminal_id": drawer.owner_terminal_id,
                "currency": self.currency,
                "gift_cash_cents": drawer.gift_cash_cents,
                "ordinary_expected_cents": drawer.ordinary_expected_cents,
                "expected_cents": drawer.expected_cents,
                "version": drawer.version,
                "acknowledgement_id": drawer.acknowledgement_id,
            }
        })
    }
}

/// Strict `giftCardFinancialClosingSchema` with its `giftCardFundingDrawerSchema`,
/// or `None`: exactly the allowed keys at both levels, both contracts and
/// `closed`, UUIDs, a public terminal of 1..=200 UTF-16 units, one uppercase
/// currency shared with the drawer, a UTC `Z` instant, safe JSON integers
/// (never a float or a string), the drawer of this proof's own drawer, shift
/// and owner, expected = ordinary + gift (gift cash needs its ACK and a
/// version) and variance = counted - expected.
pub(crate) fn parse_financial_closing(value: &Value) -> Option<CanonicalClosing> {
    let map = exact_object(value, CLOSING_PROOF_KEYS)?;
    let raw = exact_object(map.get("drawer")?, DRAWER_PROOF_KEYS)?;
    if text_field(map, "contract")? != GIFT_CARD_CLOSING_CONTRACT
        || text_field(map, "state")? != "closed"
        || text_field(raw, "contract")? != GIFT_CARD_FUNDING_CONTRACT
    {
        return None;
    }
    let terminal_id = text_field(map, "terminal_id")?;
    let currency = text_field(map, "currency")?;
    let closed_at = text_field(map, "closed_at")?;
    if !(1..=MAX_TEXT_ID_LEN).contains(&terminal_id.encode_utf16().count())
        || !is_currency(currency)
        || !is_utc_instant(closed_at)
    {
        return None;
    }
    // The schema compares these with strict equality, before any case folding.
    if ["drawer_id", "shift_id", "owner_terminal_id"]
        .iter()
        .any(|key| map.get(*key) != raw.get(*key))
        || raw.get("currency")?.as_str() != Some(currency)
    {
        return None;
    }
    let drawer = CanonicalDrawer {
        drawer_id: uuid_field(raw, "drawer_id")?,
        shift_id: uuid_field(raw, "shift_id")?,
        owner_terminal_id: uuid_field(raw, "owner_terminal_id")?,
        gift_cash_cents: safe_integer_field(raw, "gift_cash_cents", 0)?,
        ordinary_expected_cents: safe_integer_field(
            raw,
            "ordinary_expected_cents",
            -MAX_SAFE_INTEGER,
        )?,
        expected_cents: safe_integer_field(raw, "expected_cents", -MAX_SAFE_INTEGER)?,
        version: safe_integer_field(raw, "version", 0)?,
        acknowledgement_id: nullable_uuid_field(raw, "acknowledgement_id")?,
    };
    let conserved = drawer
        .ordinary_expected_cents
        .checked_add(drawer.gift_cash_cents)
        == Some(drawer.expected_cents);
    let acknowledged =
        drawer.gift_cash_cents == 0 || (drawer.acknowledgement_id.is_some() && drawer.version >= 1);
    if !conserved || !acknowledged {
        return None;
    }
    let closing = CanonicalClosing {
        organization_id: uuid_field(map, "organization_id")?,
        branch_id: uuid_field(map, "branch_id")?,
        terminal_id: terminal_id.to_string(),
        source_terminal_id: uuid_field(map, "source_terminal_id")?,
        owner_terminal_id: uuid_field(map, "owner_terminal_id")?,
        shift_id: uuid_field(map, "shift_id")?,
        drawer_id: uuid_field(map, "drawer_id")?,
        staff_id: uuid_field(map, "staff_id")?,
        currency: currency.to_string(),
        counted_cents: safe_integer_field(map, "counted_cents", 0)?,
        variance_cents: safe_integer_field(map, "variance_cents", -MAX_SAFE_INTEGER)?,
        closed_at: closed_at.to_string(),
        drawer,
    };
    let variance = closing
        .counted_cents
        .checked_sub(closing.drawer.expected_cents);
    (variance == Some(closing.variance_cents)).then_some(closing)
}

/// Android `matchGiftCardClosingProof`: every identity of the original, its
/// owner/source terminal DB pins, its currency and count, and a drawer
/// projection no older than the original's (the same version keeps its
/// nullable ACK). The canonical close time may differ from the local one.
fn proof_matches(original: &ClosingOriginal, proof: &CanonicalClosing) -> bool {
    let exact = same_uuid(&proof.organization_id, &original.organization_id)
        && same_uuid(&proof.branch_id, &original.branch_id)
        && proof.terminal_id == original.terminal_id
        && same_uuid(&proof.source_terminal_id, &original.source_terminal_db_id)
        && same_uuid(&proof.owner_terminal_id, &original.owner_terminal_db_id)
        && same_uuid(&proof.staff_id, &original.staff_id)
        && same_uuid(&proof.shift_id, &original.shift_id)
        && same_uuid(&proof.drawer_id, &original.drawer_id)
        && proof.currency == original.currency
        && proof.counted_cents == original.counted_cents;
    let version = proof.drawer.version;
    let compatible = version > original.drawer.version
        || (version == original.drawer.version
            && same_ack(
                proof.drawer.acknowledgement_id.as_deref(),
                original.drawer.acknowledgement_id.as_deref(),
            ));
    exact && compatible
}

/// The strict proof of exactly this retained original, or why it stays
/// pending: `GIFT_CARD_CLOSING_PROOF_INVALID` for a malformed value and
/// `GIFT_CARD_CLOSING_MISMATCH` for a valid proof of any other close.
pub(crate) fn match_closing_proof(
    original: &ClosingOriginal,
    value: &Value,
) -> Result<CanonicalClosing, ClosingRetained> {
    let proof = parse_financial_closing(value)
        .ok_or_else(|| retain_for(GIFT_CARD_CLOSING_PROOF_INVALID))?;
    if proof_matches(original, &proof) {
        Ok(proof)
    } else {
        Err(retain_for(GIFT_CARD_CLOSING_MISMATCH))
    }
}

/// Why a retained original stays `pending` (Android `retainFor`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RetainStatus {
    /// `GIFT_CARD_CLOSING_UNVERIFIED`: retry the same original close.
    Pending,
    /// `GIFT_CARD_CLOSING_MISMATCH`: the stored close is not this original's.
    Mismatch,
    /// A staff session or permission code.
    AuthRequired,
    /// `GIFT_CARD_SCOPE_REJECTED`, or a skipped event without a code.
    Refused,
    /// Any other code, `GIFT_CARD_CLOSING_PROOF_INVALID` included.
    Unknown,
}

/// A reply that proves nothing about this original: it stays `pending`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClosingRetained {
    pub status: RetainStatus,
    pub code: String,
}

fn retain_for(code: &str) -> ClosingRetained {
    let status = match code {
        GIFT_CARD_CLOSING_MISMATCH => RetainStatus::Mismatch,
        GIFT_CARD_CLOSING_UNVERIFIED => RetainStatus::Pending,
        "GIFT_CARD_SCOPE_REJECTED" => RetainStatus::Refused,
        _ if is_session_code(code) => RetainStatus::AuthRequired,
        _ => RetainStatus::Unknown,
    };
    ClosingRetained {
        status,
        code: code.to_string(),
    }
}

/// The verdict on one shift-sync reply to a retained original close.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClosingVerdict {
    Proof(CanonicalClosing),
    Retain(ClosingRetained),
}

/// Android `judgeGiftCardClosingResponse`: `data` is the parsed reply body and
/// `error` the transport error text. Only exactly one event result, of this
/// shift when it names one, carrying a matching `financial_closing` proves the
/// close, whatever the transport says; an HTTP status (207 included),
/// `success`, `ok` or `skipped` never does. Anything else retains the original
/// with the result's, reply's or transport's code, else
/// `GIFT_CARD_CLOSING_UNVERIFIED`.
pub(crate) fn judge_closing_response(
    original: &ClosingOriginal,
    data: Option<&Value>,
    error: Option<&str>,
) -> ClosingVerdict {
    let data = data.filter(|value| value.is_object());
    let result = match data
        .and_then(|value| value.get("results"))
        .and_then(Value::as_array)
    {
        Some(results) if results.len() == 1 && results[0].is_object() => Some(&results[0]),
        _ => None,
    };
    if let Some(shift) = result.and_then(|value| value.get("shift_id")) {
        if !shift
            .as_str()
            .is_some_and(|id| same_uuid(id, &original.shift_id))
        {
            return ClosingVerdict::Retain(retain_for(GIFT_CARD_CLOSING_UNVERIFIED));
        }
    }
    let closing = result
        .and_then(|value| value.get("financial_closing"))
        .filter(|value| !value.is_null());
    if let Some(closing) = closing {
        // The per-event proof is the sole evidence, whatever the transport status says.
        return match match_closing_proof(original, closing) {
            Ok(proof) => ClosingVerdict::Proof(proof),
            Err(retained) => ClosingVerdict::Retain(retained),
        };
    }
    let code = result
        .and_then(code_of)
        .or_else(|| data.and_then(code_of))
        .or_else(|| error.filter(|text| is_code(text)).map(str::to_string));
    let skipped = result
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        == Some("skipped");
    ClosingVerdict::Retain(match code {
        Some(code) => retain_for(&code),
        None if skipped => ClosingRetained {
            status: RetainStatus::Refused,
            code: GIFT_CARD_CLOSING_SKIPPED.to_string(),
        },
        None => retain_for(GIFT_CARD_CLOSING_UNVERIFIED),
    })
}

// ---------------------------------------------------------------------------
// Adoption: the canonical close inside the caller's transaction
// ---------------------------------------------------------------------------

/// The adopted canonical view: the immutable original (its local close time,
/// count and drawer preview untouched) with its frozen hosted proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AdoptedClosing {
    pub original: ClosingOriginal,
    pub proof: CanonicalClosing,
    pub canonical_closed_at: String,
    pub confirmed_at: String,
    pub adopted_at: String,
}

impl AdoptedClosing {
    /// Canonical counted cash, always the original count.
    pub(crate) fn counted_cents(&self) -> i64 {
        self.proof.counted_cents
    }

    /// Canonical expected cash: ordinary + gift.
    pub(crate) fn expected_cents(&self) -> i64 {
        self.proof.drawer.expected_cents
    }

    /// Canonical signed variance: counted - expected.
    pub(crate) fn variance_cents(&self) -> i64 {
        self.proof.variance_cents
    }
}

/// The outcome of one adoption attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClosingAdoption {
    /// The proof is adopted: `replayed` is `false` when this call wrote it and
    /// `true` for the identical proof of an already adopted close (no writes).
    Adopted {
        closing: AdoptedClosing,
        replayed: bool,
    },
    /// The reply proves nothing about this original; nothing was written.
    Retained(ClosingRetained),
}

/// Adopts the hosted proof of one retained original inside the caller's open
/// transaction (autocommit is refused). The stored original is reread and the
/// reply judged against it ([`judge_closing_response`]); a reply without its
/// proof returns [`ClosingAdoption::Retained`] and writes nothing.
///
/// A first adoption requires the original's confirmed financial opening (same
/// identities and terminal DB pins) and its locally closed mirror: exactly its
/// cashier shift and that shift's single drawer, of the original actor, branch
/// and public terminal, both holding the original count. It then writes, in
/// this order: the canonical close onto the drawer and the shift mirrors
/// (counted/expected/variance in decimal and cents and the canonical close
/// time; no sales or cash movement total), the opening retired as
/// `confirmed_unusable` with `server_usable = 0` (identities and current
/// drawer projection kept) and last the journal `confirmed` with the frozen
/// proof. Once adopted, the identical proof replays without writing and any
/// other proof is refused.
///
/// An error after the first write leaves the earlier writes in the open
/// transaction: the caller must roll back. No BEGIN/COMMIT and no queue write
/// or consumption happen here; the dispatcher consumes its queue item in the
/// same transaction only after this succeeds.
pub(crate) fn adopt_closing_response(
    conn: &Connection,
    closing_key: &str,
    data: Option<&Value>,
    error: Option<&str>,
    now: DateTime<Utc>,
) -> Result<ClosingAdoption, ClosingError> {
    if conn.is_autocommit() {
        return Err(ClosingError::new(
            "CLOSING_TRANSACTION_REQUIRED",
            "The closing proof adoption must run inside the caller's open transaction",
        ));
    }
    let original = load_original(conn, closing_key)
        .map_err(storage_error)?
        .ok_or_else(|| {
            ClosingError::new("CLOSING_NOT_FOUND", "No closing original has this key")
        })?;
    let proof = match judge_closing_response(&original, data, error) {
        ClosingVerdict::Proof(proof) => proof,
        ClosingVerdict::Retain(retained) => return Ok(ClosingAdoption::Retained(retained)),
    };
    if original.state == ClosingState::Confirmed {
        let adopted = reread_adopted(conn, closing_key)?;
        if adopted.proof != proof {
            return Err(ClosingError::new(
                "CLOSING_PROOF_CONFLICT",
                "A different closing proof is already adopted for this original",
            ));
        }
        return Ok(ClosingAdoption::Adopted {
            closing: adopted,
            replayed: true,
        });
    }

    let intent = gift_financial_opening::load_intent(conn, &original.opening_key)
        .map_err(storage_error)?
        .ok_or_else(|| {
            ClosingError::new(
                "OPENING_NOT_FOUND",
                "No original financial opening has this key",
            )
        })?;
    if intent.state == OpeningState::Pending {
        return Err(ClosingError::new(
            "OPENING_NOT_CONFIRMED",
            "The original financial opening is not confirmed",
        ));
    }
    if !original_matches_opening(&original, &intent) {
        return Err(ClosingError::new(
            "OPENING_MISMATCH",
            "The closing original does not match its financial opening",
        ));
    }
    verify_closed_mirror(conn, &original)?;

    let now_text = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let closed_at = proof.closed_at.as_str();
    let (counted, expected, variance) = (
        proof.counted_cents,
        proof.drawer.expected_cents,
        proof.variance_cents,
    );
    let proof_json = serde_json::to_string(&proof.to_value())
        .map_err(|e| storage_error(format!("serialize the closing proof: {e}")))?;
    let written = conn
        .execute(
            "UPDATE cash_drawer_sessions SET
                closing_amount = ?1, closing_amount_cents = ?2,
                expected_amount = ?3, expected_amount_cents = ?4,
                variance_amount = ?5, variance_amount_cents = ?6,
                closed_at = ?7, reconciled = 1, reconciled_at = ?7, updated_at = ?8
             WHERE id = ?9 AND staff_shift_id = ?10 AND closed_at IS NOT NULL",
            params![
                decimal(counted),
                counted,
                decimal(expected),
                expected,
                decimal(variance),
                variance,
                closed_at,
                now_text,
                original.drawer_id,
                original.shift_id
            ],
        )
        .map_err(|e| storage_error(format!("adopt the drawer mirror: {e}")))?;
    expect_one(written, "drawer mirror")?;
    let written = conn
        .execute(
            "UPDATE staff_shifts SET
                closing_cash_amount = ?1, closing_cash_amount_cents = ?2,
                expected_cash_amount = ?3, expected_cash_amount_cents = ?4,
                cash_variance = ?5, cash_variance_cents = ?6,
                check_out_time = ?7, status = 'closed', sync_status = 'synced', updated_at = ?8
             WHERE id = ?9 AND status = 'closed'",
            params![
                decimal(counted),
                counted,
                decimal(expected),
                expected,
                decimal(variance),
                variance,
                closed_at,
                now_text,
                original.shift_id
            ],
        )
        .map_err(|e| storage_error(format!("adopt the shift mirror: {e}")))?;
    expect_one(written, "shift mirror")?;
    let written = conn
        .execute(
            "UPDATE gift_financial_openings
                SET state = 'confirmed_unusable', server_usable = 0, updated_at = ?1
              WHERE opening_key = ?2 AND organization_id = ?3
                AND state IN ('confirmed_usable', 'confirmed_unusable')",
            params![now_text, intent.opening_key, intent.organization_id],
        )
        .map_err(|e| storage_error(format!("retire the financial opening: {e}")))?;
    expect_one(written, "financial opening")?;
    let written = conn
        .execute(
            "UPDATE gift_financial_closings
                SET state = 'confirmed', confirmation_json = ?1, canonical_closed_at = ?2,
                    confirmed_at = ?3, adopted_at = ?3, pending_reason = NULL, updated_at = ?3
              WHERE closing_key = ?4 AND organization_id = ?5 AND state = 'pending'",
            params![
                proof_json,
                closed_at,
                now_text,
                original.closing_key,
                original.organization_id
            ],
        )
        .map_err(|e| storage_error(format!("confirm the closing journal: {e}")))?;
    expect_one(written, "closing journal")?;
    Ok(ClosingAdoption::Adopted {
        closing: reread_adopted(conn, closing_key)?,
        replayed: false,
    })
}

/// The adopted canonical view of one confirmed original, read back from its
/// stored proof and revalidated against the original; `None` while pending.
pub(crate) fn load_adopted(
    conn: &Connection,
    closing_key: &str,
) -> Result<Option<AdoptedClosing>, String> {
    let Some(original) = load_original(conn, closing_key)? else {
        return Ok(None);
    };
    if original.state != ClosingState::Confirmed {
        return Ok(None);
    }
    let (proof_json, canonical_closed_at, confirmed_at, adopted_at): (
        String,
        Option<String>,
        String,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT confirmation_json, canonical_closed_at, confirmed_at, adopted_at
               FROM gift_financial_closings WHERE closing_key = ?1",
            params![closing_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("load adopted financial closing: {e}"))?;
    let proof = serde_json::from_str::<Value>(&proof_json)
        .ok()
        .and_then(|value| parse_financial_closing(&value))
        .filter(|proof| proof_matches(&original, proof))
        .ok_or("the stored closing proof is not a proof of its original")?;
    match (canonical_closed_at, adopted_at) {
        (Some(canonical_closed_at), Some(adopted_at)) if canonical_closed_at == proof.closed_at => {
            Ok(Some(AdoptedClosing {
                original,
                proof,
                canonical_closed_at,
                confirmed_at,
                adopted_at,
            }))
        }
        _ => Err("the adopted closing does not carry its proof's canonical close time".to_string()),
    }
}

fn reread_adopted(conn: &Connection, closing_key: &str) -> Result<AdoptedClosing, ClosingError> {
    load_adopted(conn, closing_key)
        .map_err(storage_error)?
        .ok_or_else(|| storage_error("the adopted closing could not be reread".to_string()))
}

/// Every identity field of the stored original against its actual opening,
/// including the owner/source terminal DB pins its stored proof carried.
fn original_matches_opening(original: &ClosingOriginal, intent: &OpeningIntent) -> bool {
    original.opening_key == intent.opening_key
        && same_uuid(&original.organization_id, &intent.organization_id)
        && same_uuid(&original.branch_id, &intent.branch_id)
        && original.terminal_id == intent.terminal_id
        && same_uuid(&original.staff_id, &intent.staff_id)
        && original.shift_id == intent.shift_id
        && original.drawer_id == intent.drawer_id
        && original.currency == intent.currency
        && intent
            .owner_terminal_db_id
            .as_deref()
            .is_some_and(|owner| same_uuid(&original.owner_terminal_db_id, owner))
        && intent
            .source_terminal_db_id
            .as_deref()
            .is_some_and(|source| same_uuid(&original.source_terminal_db_id, source))
}

/// The original's locally closed mirror: exactly its cashier shift and that
/// shift's single drawer, of the original actor, branch and public terminal,
/// both closed and both holding the original count.
fn verify_closed_mirror(conn: &Connection, original: &ClosingOriginal) -> Result<(), ClosingError> {
    let read = |e: rusqlite::Error| storage_error(format!("read the closing mirror: {e}"));
    let shift = conn
        .query_row(
            "SELECT staff_id, branch_id, terminal_id, role_type, status, closing_cash_amount_cents
               FROM staff_shifts WHERE id = ?1",
            params![original.shift_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(read)?;
    let drawer = conn
        .query_row(
            "SELECT staff_shift_id, cashier_id, branch_id, terminal_id, closed_at, closing_amount_cents,
                    (SELECT COUNT(*) FROM cash_drawer_sessions c WHERE c.staff_shift_id = ?2)
               FROM cash_drawer_sessions WHERE id = ?1",
            params![original.drawer_id, original.shift_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()
        .map_err(read)?;
    let (
        Some((staff, branch, terminal, role, status, shift_count)),
        Some((
            drawer_shift,
            cashier,
            drawer_branch,
            drawer_terminal,
            closed_at,
            drawer_count,
            drawers,
        )),
    ) = (shift, drawer)
    else {
        return Err(ClosingError::new(
            "CLOSING_MIRROR_MISSING",
            "The original shift or drawer mirror is missing",
        ));
    };
    let same = |value: &Option<String>, expected: &str| {
        value
            .as_deref()
            .is_some_and(|value| same_uuid(value, expected))
    };
    let own_terminal =
        |value: &Option<String>| value.as_deref() == Some(original.terminal_id.as_str());
    let own = same(&staff, &original.staff_id)
        && same(&branch, &original.branch_id)
        && own_terminal(&terminal)
        && role.as_deref() == Some("cashier")
        && drawer_shift.as_deref() == Some(original.shift_id.as_str())
        && same(&cashier, &original.staff_id)
        && same(&drawer_branch, &original.branch_id)
        && own_terminal(&drawer_terminal)
        && drawers == 1;
    if !own {
        return Err(ClosingError::new(
            "CLOSING_MIRROR_FOREIGN",
            "The local mirror is not the original's cashier shift and its single drawer",
        ));
    }
    if status.as_deref() != Some("closed") || closed_at.as_deref().map_or(true, str::is_empty) {
        return Err(ClosingError::new(
            "CLOSING_MIRROR_OPEN",
            "The original shift and drawer are not closed locally",
        ));
    }
    if shift_count != Some(original.counted_cents) || drawer_count != Some(original.counted_cents) {
        return Err(ClosingError::new(
            "CLOSING_MIRROR_COUNT_MISMATCH",
            "The local close does not hold the original count",
        ));
    }
    Ok(())
}

fn expect_one(written: usize, what: &str) -> Result<(), ClosingError> {
    if written == 1 {
        Ok(())
    } else {
        Err(storage_error(format!(
            "adopting the {what} changed {written} rows"
        )))
    }
}

/// The dual-written decimal amount of whole cents.
fn decimal(cents: i64) -> f64 {
    cents as f64 / 100.0
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a JsonMap> {
    let map = value.as_object()?;
    (map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key))).then_some(map)
}

fn text_field<'a>(map: &'a JsonMap, key: &str) -> Option<&'a str> {
    map.get(key)?.as_str()
}

fn uuid_field(map: &JsonMap, key: &str) -> Option<String> {
    text_field(map, key)
        .filter(|value| is_uuid(value))
        .map(str::to_string)
}

fn nullable_uuid_field(map: &JsonMap, key: &str) -> Option<Option<String>> {
    match map.get(key)? {
        Value::Null => Some(None),
        Value::String(value) if is_uuid(value) => Some(Some(value.clone())),
        _ => None,
    }
}

/// A JSON integer (never a float or a string) in `min..=MAX_SAFE_INTEGER`.
fn safe_integer_field(map: &JsonMap, key: &str, min: i64) -> Option<i64> {
    map.get(key)?
        .as_i64()
        .filter(|value| (min..=MAX_SAFE_INTEGER).contains(value))
}

/// zod `z.string().datetime()`: `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, UTC only.
fn is_utc_instant(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[10] == b'T'
        && matches!(bytes[19], b'Z' | b'.')
        && value.ends_with('Z')
        && DateTime::parse_from_rfc3339(value).is_ok()
}

fn same_ack(proof: Option<&str>, original: Option<&str>) -> bool {
    match (proof, original) {
        (None, None) => true,
        (Some(proof), Some(original)) => same_uuid(proof, original),
        _ => false,
    }
}

/// Android `codeOf`: the first `code`, `error_code` or `error` string that is a code.
fn code_of(value: &Value) -> Option<String> {
    let map = value.as_object()?;
    ["code", "error_code", "error"].iter().find_map(|key| {
        map.get(*key)?
            .as_str()
            .filter(|code| is_code(code))
            .map(str::to_string)
    })
}

/// Android `CODE_PATTERN`: `^[A-Z][A-Z0-9_]{2,}$`.
fn is_code(value: &str) -> bool {
    value.len() >= 3 && value.as_bytes()[0].is_ascii_uppercase() && value.bytes().all(is_code_byte)
}

fn is_code_byte(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
}

/// Android `SESSION_CODE`: `STAFF_SESSION_*`, `STAFF_FORBIDDEN` or `ACCESS_UNAVAILABLE`.
fn is_session_code(code: &str) -> bool {
    matches!(code, "STAFF_FORBIDDEN" | "ACCESS_UNAVAILABLE")
        || code
            .strip_prefix("STAFF_SESSION_")
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(is_code_byte))
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36 && Uuid::parse_str(value).is_ok()
}

fn is_lower_uuid(value: &str) -> bool {
    is_uuid(value) && !value.bytes().any(|byte| byte.is_ascii_uppercase())
}

fn same_uuid(left: &str, right: &str) -> bool {
    is_uuid(left) && is_uuid(right) && left.eq_ignore_ascii_case(right)
}

fn is_currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase())
}

fn is_text_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TEXT_ID_LEN
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn is_safe_signed(value: i64) -> bool {
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value)
}

fn is_millisecond_instant(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|instant| {
        instant
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            == value
    })
}

fn carries_secret(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, nested)| {
            let normalized: String = key
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .map(|c| c.to_ascii_lowercase())
                .collect();
            SECRET_KEYS.contains(&normalized.as_str()) || carries_secret(nested)
        }),
        Value::Array(items) => items.iter().any(carries_secret),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Nonsecret recovery reads and the explicit retry wake
// ---------------------------------------------------------------------------
//
// The selected original cashier's retained closings in the current trusted
// organization, branch and public terminal. A view carries identity, the
// count, its state, a safe code and either the count-time local preview
// (`localPreview`) or, once adopted, the frozen canonical proof (`canonical`,
// read through [`load_adopted`] only). It never carries a PIN, session,
// request body, provider diagnostic or another cashier's closing. The retry
// only makes the exact original protected queue row due again; the native
// sync dispatcher sends it and only a later status read proves the close.

/// At most this many closings are returned by one recovery list.
const MAX_RECOVERY_CLOSINGS: usize = 50;
const GIFT_CLOSING_ORIGINAL_MISSING: &str = "GIFT_CLOSING_ORIGINAL_MISSING";
const GIFT_CLOSING_PROOF_UNAVAILABLE: &str = "GIFT_CLOSING_PROOF_UNAVAILABLE";
const GIFT_CLOSING_QUEUE_MISSING: &str = "GIFT_CLOSING_QUEUE_MISSING";
const GIFT_CLOSING_QUEUE_MISMATCH: &str = "GIFT_CLOSING_QUEUE_MISMATCH";
const GIFT_CLOSING_QUEUE_UNAVAILABLE: &str = "GIFT_CLOSING_QUEUE_UNAVAILABLE";

/// Whether the original cashier's private hosted session is live for one
/// pending original.
type AuthorityProbe<'a> = &'a dyn Fn(
    &Connection,
    &ClosingOriginal,
    DateTime<Utc>,
) -> Result<(), gift_financial_opening::ClosingAccessError>;

/// The dispatcher's close-purpose accessor; its header is dropped here.
fn closing_authority(
    conn: &Connection,
    original: &ClosingOriginal,
    now: DateTime<Utc>,
) -> Result<(), gift_financial_opening::ClosingAccessError> {
    gift_financial_opening::closing_hosted_cashier(
        conn,
        &original.closing_key,
        &original.queue_item_id,
        now,
    )
    .map(|_| ())
}

fn recovery_refusal(code: &str, message: &str) -> Value {
    serde_json::json!({ "success": false, "code": code, "error": message })
}

fn scope_unavailable() -> Value {
    recovery_refusal(
        "TERMINAL_SCOPE_UNAVAILABLE",
        "Terminal organization, branch and terminal identity are required",
    )
}

fn read_failed() -> Value {
    recovery_refusal(
        "LOCAL_READ_FAILED",
        "The financial closing could not be read locally",
    )
}

fn request_uuid(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| is_uuid(value))
}

/// `(closingKey, staffId)` of a status or retry request, or its refusal.
fn keyed_request(payload: &Value) -> Result<(String, String), Value> {
    let closing_key = request_uuid(payload, "closingKey")
        .ok_or_else(|| recovery_refusal("INVALID_CLOSING_KEY", "closingKey must be a UUID"))?;
    let staff_id = request_uuid(payload, "staffId")
        .ok_or_else(|| recovery_refusal("INVALID_STAFF_ID", "staffId must be a UUID"))?;
    Ok((closing_key, staff_id))
}

/// The persisted original's own actor and scope against the current trusted
/// terminal scope and the selected original cashier.
fn in_recovery_scope(
    original: &ClosingOriginal,
    scope: &gift_financial_opening::OpeningScope,
    staff_id: &str,
) -> bool {
    same_uuid(&original.organization_id, &scope.organization_id)
        && same_uuid(&original.branch_id, &scope.branch_id)
        && original.terminal_id == scope.terminal_id
        && same_uuid(&original.staff_id, staff_id)
}

/// The original of `closing_key` only when it is `staff_id`'s in `scope`; any
/// other closing reads as not found.
fn scoped_original(
    conn: &Connection,
    scope: &gift_financial_opening::OpeningScope,
    staff_id: &str,
    closing_key: &str,
) -> Result<ClosingOriginal, Value> {
    load_original(conn, closing_key)
        .map_err(|_| read_failed())?
        .filter(|original| in_recovery_scope(original, scope, staff_id))
        .ok_or_else(|| {
            recovery_refusal(
                "CLOSING_NOT_FOUND",
                "No retained financial closing of this cashier has this key",
            )
        })
}

/// The queue row of one retained original. `exact` only while it is still the
/// original `staff_shifts` UPDATE of its organization carrying exactly the
/// frozen body and its closing key, as the protected dispatcher requires.
struct RetainedQueueRow {
    status: String,
    next_retry_at: Option<String>,
    error_message: Option<String>,
    data: String,
    exact: bool,
}

impl RetainedQueueRow {
    fn live(&self) -> bool {
        self.exact && matches!(self.status.as_str(), "pending" | "processing")
    }
}

fn retained_queue_row(
    conn: &Connection,
    original: &ClosingOriginal,
) -> Result<Option<RetainedQueueRow>, String> {
    let row = conn
        .query_row(
            "SELECT table_name, operation, organization_id, data, status, next_retry_at, error_message, record_id
               FROM parity_sync_queue WHERE id = ?1",
            params![original.queue_item_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("read the closing queue item: {e}"))?;
    let Some((table, operation, organization, data, status, next_retry_at, error_message, record)) =
        row
    else {
        return Ok(None);
    };
    let frozen = serde_json::from_str::<Value>(&original.request_body_json).ok();
    let queued = serde_json::from_str::<Value>(&data).ok();
    let exact = table == "staff_shifts"
        && operation == "UPDATE"
        && record
            .as_deref()
            .is_some_and(|record| same_uuid(record, &original.shift_id))
        && organization
            .as_deref()
            .is_some_and(|organization| same_uuid(organization, &original.organization_id))
        && frozen.is_some()
        && queued == frozen
        && queued
            .as_ref()
            .and_then(|body| body.get("idempotencyKey"))
            .and_then(Value::as_str)
            == Some(original.closing_key.as_str());
    Ok(Some(RetainedQueueRow {
        status,
        next_retry_at,
        error_message,
        data,
        exact,
    }))
}

/// A stored retry instant as a millisecond `Z` instant, else `None`.
fn retry_instant(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let instant = DateTime::parse_from_rfc3339(value)
        .map(|instant| instant.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|naive| chrono::TimeZone::from_utc_datetime(&Utc, &naive))
        })?;
    Some(instant.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// One closing: `localPreview` (the count-time local terms) while the original
/// is pending, only `canonical` (the frozen proof) once adopted, and neither
/// for an adopted original whose proof no longer reads. Never the request body.
fn closing_view(
    original: &ClosingOriginal,
    state: &str,
    code: Option<&str>,
    authorization_required: bool,
    queue: Option<&RetainedQueueRow>,
    adopted: Option<&AdoptedClosing>,
) -> Value {
    serde_json::json!({
        "closingKey": original.closing_key,
        "openingKey": original.opening_key,
        "shiftId": original.shift_id,
        "state": state,
        "code": code,
        "authorizationRequired": authorization_required,
        "currency": original.currency,
        "countedCents": original.counted_cents,
        "queue": queue.map(|row| serde_json::json!({
            "status": row.status,
            "nextRetryAt": retry_instant(row.next_retry_at.as_deref()),
        })),
        "localPreview": (original.state == ClosingState::Pending).then(|| serde_json::json!({
            "closedAt": original.closed_at,
            "ordinaryExpectedCents": original.drawer.ordinary_expected_cents,
            "giftCashCents": original.drawer.gift_cash_cents,
            "expectedCents": original.drawer.expected_cents,
            "varianceCents": original.variance_cents,
        })),
        "canonical": adopted.map(|adopted| serde_json::json!({
            "closedAt": adopted.canonical_closed_at,
            "confirmedAt": adopted.confirmed_at,
            "countedCents": adopted.counted_cents(),
            "ordinaryExpectedCents": adopted.proof.drawer.ordinary_expected_cents,
            "giftCashCents": adopted.proof.drawer.gift_cash_cents,
            "expectedCents": adopted.expected_cents(),
            "varianceCents": adopted.variance_cents(),
        })),
    })
}

/// A known gift-bound shift closed locally without its original: blocked,
/// never an ordinary completed close.
fn missing_original_view(opening_key: &str, shift_id: &str) -> Value {
    serde_json::json!({
        "closingKey": null,
        "openingKey": opening_key,
        "shiftId": shift_id,
        "state": "blocked",
        "code": GIFT_CLOSING_ORIGINAL_MISSING,
        "authorizationRequired": false,
        "currency": null,
        "countedCents": null,
        "queue": null,
        "localPreview": null,
        "canonical": null,
    })
}

/// The state of one in-scope original. Confirmed only through its revalidated
/// adopted proof; a missing or unreadable proof, a missing or changed queue
/// row or a refused retained closure is `blocked`.
fn recovery_view(
    conn: &Connection,
    original: &ClosingOriginal,
    now: DateTime<Utc>,
    authority: AuthorityProbe<'_>,
) -> Result<Value, String> {
    use gift_financial_opening::ClosingAccessError as Access;

    if original.state == ClosingState::Confirmed {
        return Ok(match load_adopted(conn, &original.closing_key) {
            Ok(Some(adopted)) => {
                closing_view(original, "confirmed", None, false, None, Some(&adopted))
            }
            Ok(None) | Err(_) => closing_view(
                original,
                "blocked",
                Some(GIFT_CLOSING_PROOF_UNAVAILABLE),
                false,
                None,
                None,
            ),
        });
    }
    let queue = retained_queue_row(conn, original)?;
    let live = queue.as_ref().filter(|row| row.live());
    let (authorization_required, authority_code) = match authority(conn, original, now) {
        Ok(()) => (false, None),
        Err(error @ (Access::ReauthRequired | Access::Expired)) => (true, Some(error.code())),
        Err(error) => {
            return Ok(closing_view(
                original,
                "blocked",
                Some(error.code()),
                false,
                live,
                None,
            ))
        }
    };
    let blocked = match &queue {
        None => Some(GIFT_CLOSING_QUEUE_MISSING),
        Some(row) if !row.exact => Some(GIFT_CLOSING_QUEUE_MISMATCH),
        Some(row) if !row.live() => Some(GIFT_CLOSING_QUEUE_UNAVAILABLE),
        Some(_) => None,
    };
    if let Some(code) = blocked {
        return Ok(closing_view(
            original,
            "blocked",
            Some(code),
            authorization_required,
            None,
            None,
        ));
    }
    // Only code-shaped text is published; free-text diagnostics never are.
    let safe = |code: &&str| code.len() <= 100 && is_code(code);
    let retained = live
        .and_then(|row| row.error_message.as_deref())
        .filter(safe)
        .or_else(|| original.pending_reason.as_deref().filter(safe));
    Ok(closing_view(
        original,
        "pending",
        authority_code.or(retained),
        authorization_required,
        live,
        None,
    ))
}

/// Pending originals (oldest first), adopted closes whose proof no longer
/// reads, then known gift-bound shifts closed without an original; each
/// category bounded, all of exactly this cashier in `scope`.
fn recovery_list(
    conn: &Connection,
    scope: &gift_financial_opening::OpeningScope,
    staff_id: &str,
    now: DateTime<Utc>,
    authority: AuthorityProbe<'_>,
) -> Result<Vec<Value>, String> {
    const ACTOR: &str = "terminal_id = ?1 AND lower(organization_id) = lower(?2) \
         AND lower(branch_id) = lower(?3) AND lower(staff_id) = lower(?4)";
    let limit = i64::try_from(MAX_RECOVERY_CLOSINGS + 1).unwrap_or(i64::MAX);
    let actor: [&dyn rusqlite::ToSql; 5] = [
        &scope.terminal_id,
        &scope.organization_id,
        &scope.branch_id,
        &staff_id,
        &limit,
    ];
    let list = |e: rusqlite::Error| format!("list financial closings: {e}");
    let originals = |state: &str, order: &str| -> Result<Vec<ClosingOriginal>, String> {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ORIGINAL_COLUMNS} FROM gift_financial_closings
                  WHERE state = '{state}' AND {ACTOR} ORDER BY {order} LIMIT ?5"
            ))
            .map_err(list)?;
        let rows = stmt
            .query_map(&actor[..], original_from_row)
            .map_err(list)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(list)
    };
    let mut views = Vec::new();
    for original in originals("pending", "closed_at, closing_key")? {
        views.push(recovery_view(conn, &original, now, authority)?);
    }
    for original in originals("confirmed", "closed_at DESC, closing_key")? {
        if !matches!(load_adopted(conn, &original.closing_key), Ok(Some(_))) {
            views.push(closing_view(
                &original,
                "blocked",
                Some(GIFT_CLOSING_PROOF_UNAVAILABLE),
                false,
                None,
                None,
            ));
        }
    }
    let mut stmt = conn
        .prepare(
            "SELECT o.opening_key, o.shift_id FROM gift_financial_openings o
               JOIN staff_shifts s ON lower(s.id) = lower(o.shift_id)
              WHERE o.terminal_id = ?1 AND lower(o.organization_id) = lower(?2)
                AND lower(o.branch_id) = lower(?3) AND lower(o.staff_id) = lower(?4)
                AND s.status = 'closed'
                AND NOT EXISTS (SELECT 1 FROM gift_financial_closings c
                                 WHERE c.opening_key = o.opening_key OR lower(c.shift_id) = lower(o.shift_id))
              ORDER BY s.check_out_time, o.opening_key LIMIT ?5",
        )
        .map_err(list)?;
    let missing = stmt
        .query_map(&actor[..], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(list)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(list)?;
    views.extend(
        missing
            .iter()
            .map(|(opening_key, shift_id)| missing_original_view(opening_key, shift_id)),
    );
    Ok(views)
}

fn list_pending_closings_in(
    conn: &Connection,
    payload: &Value,
    scope: Option<gift_financial_opening::OpeningScope>,
    now: DateTime<Utc>,
    authority: AuthorityProbe<'_>,
) -> Value {
    let Some(staff_id) = request_uuid(payload, "staffId") else {
        return recovery_refusal("INVALID_STAFF_ID", "staffId must be a UUID");
    };
    let Some(scope) = scope else {
        return scope_unavailable();
    };
    match recovery_list(conn, &scope, &staff_id, now, authority) {
        Ok(mut closings) => {
            let truncated = closings.len() > MAX_RECOVERY_CLOSINGS;
            closings.truncate(MAX_RECOVERY_CLOSINGS);
            serde_json::json!({ "success": true, "closings": closings, "truncated": truncated })
        }
        Err(_) => read_failed(),
    }
}

fn closing_status_in(
    conn: &Connection,
    payload: &Value,
    scope: Option<gift_financial_opening::OpeningScope>,
    now: DateTime<Utc>,
    authority: AuthorityProbe<'_>,
) -> Value {
    let (closing_key, staff_id) = match keyed_request(payload) {
        Ok(request) => request,
        Err(refusal) => return refusal,
    };
    let Some(scope) = scope else {
        return scope_unavailable();
    };
    let original = match scoped_original(conn, &scope, &staff_id, &closing_key) {
        Ok(original) => original,
        Err(refusal) => return refusal,
    };
    match recovery_view(conn, &original, now, authority) {
        Ok(closing) => serde_json::json!({ "success": true, "closing": closing }),
        Err(_) => read_failed(),
    }
}

/// The explicit retry under its own `BEGIN IMMEDIATE`: the reply and whether
/// the native sync should be woken. Only the exact original protected row's
/// `next_retry_at` is cleared; its key, body, count, attempts, retained code
/// and claim generation are kept, and nothing is captured or re-queued.
fn request_closing_retry_in(
    conn: &Connection,
    payload: &Value,
    scope: Option<gift_financial_opening::OpeningScope>,
    now: DateTime<Utc>,
    authority: AuthorityProbe<'_>,
) -> (Value, bool) {
    let (closing_key, staff_id) = match keyed_request(payload) {
        Ok(request) => request,
        Err(refusal) => return (refusal, false),
    };
    let Some(scope) = scope else {
        return (scope_unavailable(), false);
    };
    let store_failed = |message: &str| (recovery_refusal("LOCAL_STORE_FAILED", message), false);
    if !conn.is_autocommit() {
        return store_failed("The closing retry requires its own write transaction");
    }
    if conn.execute_batch("BEGIN IMMEDIATE").is_err() {
        return store_failed("The closing retry could not lock the local store");
    }
    match retry_in_transaction(conn, &scope, &staff_id, &closing_key, now, authority) {
        Ok((reply, wake)) => {
            if conn.execute_batch("COMMIT").is_err() {
                let _ = conn.execute_batch("ROLLBACK");
                return store_failed("The closing retry could not be saved");
            }
            (reply, wake)
        }
        Err(refusal) => {
            let _ = conn.execute_batch("ROLLBACK");
            (refusal, false)
        }
    }
}

fn retry_in_transaction(
    conn: &Connection,
    scope: &gift_financial_opening::OpeningScope,
    staff_id: &str,
    closing_key: &str,
    now: DateTime<Utc>,
    authority: AuthorityProbe<'_>,
) -> Result<(Value, bool), Value> {
    use gift_financial_opening::ClosingAccessError as Access;

    let original = scoped_original(conn, scope, staff_id, closing_key)?;
    if original.state != ClosingState::Pending {
        return Err(recovery_refusal(
            "CLOSING_NOT_PENDING",
            "This financial closing is no longer pending; read its status",
        ));
    }
    authority(conn, &original, now).map_err(|error| {
        let message = match error {
            Access::ReauthRequired | Access::Expired => {
                "The original cashier must authorize this closing again"
            }
            _ => "The retained financial closing cannot be retried",
        };
        recovery_refusal(error.code(), message)
    })?;
    let row = retained_queue_row(conn, &original)
        .map_err(|_| read_failed())?
        .ok_or_else(|| {
            recovery_refusal(
                GIFT_CLOSING_QUEUE_MISSING,
                "The original closing is no longer queued",
            )
        })?;
    let bound = crate::sync_queue::is_gift_close_bound_item(conn, &original.queue_item_id)
        .map_err(|_| read_failed())?;
    let mismatch = || {
        recovery_refusal(
            GIFT_CLOSING_QUEUE_MISMATCH,
            "The queued closing is not its exact original",
        )
    };
    if !row.exact || !bound {
        return Err(mismatch());
    }
    let queued = serde_json::json!({
        "success": true,
        "closing": { "closingKey": original.closing_key, "shiftId": original.shift_id, "state": "queued" },
    });
    match row.status.as_str() {
        // Already claimed: the dispatcher (or stale-claim recovery) owns it.
        "processing" => return Ok((queued, false)),
        "pending" => {
            // The existing audit row is also the durable duplicate-click guard.
            // It and the scheduling snapshot commit with the queue change, so a
            // failed write cannot consume the guard or erase the retry budget.
            let store_error =
                || recovery_refusal("LOCAL_STORE_FAILED", "The closing retry could not be saved");
            let last_retry: Option<String> = conn
                .query_row(
                    "SELECT created_at FROM recovery_action_log
                  WHERE action_id = 'gift_closing_retry_v1' AND entity_id = ?1
                    AND actor_staff_id = ?2
                  ORDER BY created_at DESC LIMIT 1",
                    params![original.closing_key, original.staff_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| store_error())?;
            if let Some(last_retry) = last_retry {
                let last = DateTime::parse_from_rfc3339(&last_retry).map_err(|_| store_error())?;
                // A clock that moved backwards must not bypass the guard.
                if now.signed_duration_since(last).num_seconds() < 30 {
                    return Ok((queued, false));
                }
            }
            let snapshot = serde_json::json!({
                "contract": "gift_closing_retry_v1", "outcome": "pending",
                "organizationId": original.organization_id,
                "branchId": original.branch_id, "terminalId": original.terminal_id,
                "queueItemId": original.queue_item_id,
                "before": { "status": row.status, "nextRetryAt": row.next_retry_at },
                "after": { "status": "pending", "nextRetryAt": null },
            });
            conn.execute(
                "INSERT INTO recovery_action_log
                    (id, action_id, issue_code, recipe_id, recipe_version,
                     entity_type, entity_id, shift_id, success, actor_staff_id,
                     message, payload_json, created_at)
                 VALUES (?1, 'gift_closing_retry_v1', 'GIFT_CLOSING_PENDING',
                         'gift_closing_retry_v1', 1, 'gift_financial_closing',
                         ?2, ?3, 0, ?4, 'Original closing retry scheduled; confirmation pending', ?5, ?6)",
                params![Uuid::new_v4().to_string(), original.closing_key, original.shift_id,
                    original.staff_id, snapshot.to_string(), now.to_rfc3339_opts(SecondsFormat::Millis, true)],
            ).map_err(|_| store_error())?;
            let written = conn
                .execute(
                    "UPDATE parity_sync_queue SET next_retry_at = NULL
                      WHERE id = ?1 AND status = 'pending' AND table_name = 'staff_shifts'
                        AND operation = 'UPDATE' AND data = ?2",
                    params![original.queue_item_id, row.data],
                )
                .map_err(|_| {
                    recovery_refusal("LOCAL_STORE_FAILED", "The closing retry could not be saved")
                })?;
            if written != 1 {
                return Err(mismatch());
            }
        }
        _ => {
            return Err(recovery_refusal(
                GIFT_CLOSING_QUEUE_UNAVAILABLE,
                "The queued closing cannot be retried from here",
            ))
        }
    }
    Ok((queued, true))
}

/// `shiftFinancialClosing.listPending`: `{ staffId }`.
pub(crate) fn list_pending_closings(
    db: &crate::db::DbState,
    payload: &Value,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    let scope = gift_financial_opening::trusted_scope(&conn);
    Ok(list_pending_closings_in(
        &conn,
        payload,
        scope,
        Utc::now(),
        &closing_authority,
    ))
}

/// `shiftFinancialClosing.status`: `{ closingKey, staffId }`.
pub(crate) fn closing_status(db: &crate::db::DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    let scope = gift_financial_opening::trusted_scope(&conn);
    Ok(closing_status_in(
        &conn,
        payload,
        scope,
        Utc::now(),
        &closing_authority,
    ))
}

/// `shiftFinancialClosing.retry`: `{ closingKey, staffId }`. Returns the reply
/// and whether the caller must wake the native sync; the scope, original,
/// authority and queue row are read and the row rescheduled under one lock.
pub(crate) fn request_closing_retry(
    db: &crate::db::DbState,
    payload: &Value,
) -> Result<(Value, bool), String> {
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    let scope = gift_financial_opening::trusted_scope(&conn);
    Ok(request_closing_retry_in(
        &conn,
        payload,
        scope,
        Utc::now(),
        &closing_authority,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ORG: &str = "6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf";
    const BRANCH: &str = "7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0";
    const OTHER_BRANCH: &str = "9fc3e0d1-9c7b-4d84-8a6b-7c8d9eafb0c1";
    const TERMINAL: &str = "terminal-main-01";
    const STAFF: &str = "5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e";
    const OTHER_STAFF: &str = "8e0c1d2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f";
    const OWNER_DB: &str = "a1b2c3d4-e5f6-4789-8abc-def012345678";
    const SOURCE_DB: &str = "b2c3d4e5-f6a7-4890-9bcd-ef0123456789";
    const OPENING_KEY: &str = "1f2e3d4c-5b6a-4789-8abc-0123456789ab";
    const OPENING_QUEUE_ID: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const SHIFT: &str = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
    const DRAWER: &str = "3b4c5d6e-7f8a-4b9c-8d0e-2f3a4b5c6d7e";
    const ACK: &str = "4c5d6e7f-8a9b-4c0d-9e1f-3a4b5c6d7e8f";
    const CLOSING_KEY: &str = "5d6e7f8a-9b0c-4d1e-8f2a-4b5c6d7e8f9a";
    const OTHER_CLOSING_KEY: &str = "7f8a9b0c-1d2e-4f3a-8b4c-6d7e8f9a0b1c";
    const QUEUE_ID: &str = "6e7f8a9b-0c1d-4e2f-9a3b-5c6d7e8f9a0b";
    const OPENED_AT: &str = "2026-09-30T08:00:00.000Z";
    const CLOSED_AT: &str = "2026-09-30T18:00:00.000Z";

    /// The original opening row exactly as the v85 journal stores it, plus
    /// its original mirror: the active cashier shift and its one open drawer.
    fn seed_opening(conn: &Connection, state: &str) {
        seed_opening_with(conn, state, &capture().confirmed_drawer);
    }

    /// [`seed_opening`] with its confirmed drawer projection pinned at `drawer`.
    fn seed_opening_with(conn: &Connection, state: &str, drawer: &DrawerState) {
        let confirmed = state != "pending";
        conn.execute(
            "INSERT INTO gift_financial_openings (
                opening_key, organization_id, branch_id, terminal_id, staff_id, staff_name,
                shift_id, drawer_id, opening_cents, currency, checked_in_at, business_date,
                period_start_at, is_day_start, calculation_version, queue_item_id, state,
                owner_terminal_db_id, source_terminal_db_id, server_usable, drawer_version,
                drawer_acknowledgement_id, drawer_gift_cash_cents, drawer_ordinary_expected_cents,
                drawer_expected_cents, confirmation_json, confirmed_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'Maria', ?6, ?7, 10000, 'EUR', ?8, '2026-09-30', ?8, 1, 2,
                      ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?8, ?8)",
            params![
                OPENING_KEY,
                ORG,
                BRANCH,
                TERMINAL,
                STAFF,
                SHIFT,
                DRAWER,
                OPENED_AT,
                OPENING_QUEUE_ID,
                state,
                confirmed.then_some(OWNER_DB),
                confirmed.then_some(SOURCE_DB),
                confirmed.then_some(i64::from(state == "confirmed_usable")),
                confirmed.then_some(drawer.version),
                confirmed
                    .then(|| drawer.acknowledgement_id.clone())
                    .flatten(),
                confirmed.then_some(drawer.gift_cash_cents),
                confirmed.then_some(drawer.ordinary_expected_cents),
                confirmed.then_some(drawer.expected_cents),
                confirmed.then_some(r#"{"fixture":"stored opening proof"}"#),
                confirmed.then_some(OPENED_AT),
            ],
        )
        .expect("seed the original opening");
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, report_date, period_start_at,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, transferred_to_cashier_shift_id,
                sync_status, created_at, updated_at, is_day_start
            ) VALUES (?1, ?2, 'Maria', ?3, ?4, 'cashier', ?5, '2026-09-30', ?5, 100, 10000,
                      'active', 2, NULL, 'pending', ?5, ?5, 1)",
            params![SHIFT, STAFF, BRANCH, TERMINAL, OPENED_AT],
        )
        .expect("seed the original shift");
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 100, 10000, ?6, ?6, ?6)",
            params![DRAWER, SHIFT, STAFF, BRANCH, TERMINAL, OPENED_AT],
        )
        .expect("seed the original drawer");
    }

    fn conn_with_opening(state: &str) -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        seed_opening(&conn, state);
        conn
    }

    fn body() -> Value {
        json!({
            "event": "shift_close",
            "shift_id": SHIFT,
            "drawer_id": DRAWER,
            "closing_key": CLOSING_KEY,
            "closing_cash_cents": 12_345,
            "closed_at": CLOSED_AT
        })
    }

    fn capture() -> ClosingCapture {
        ClosingCapture {
            closing_key: CLOSING_KEY.to_string(),
            opening_key: OPENING_KEY.to_string(),
            queue_item_id: QUEUE_ID.to_string(),
            organization_id: ORG.to_string(),
            branch_id: BRANCH.to_string(),
            terminal_id: TERMINAL.to_string(),
            staff_id: STAFF.to_string(),
            shift_id: SHIFT.to_string(),
            drawer_id: DRAWER.to_string(),
            owner_terminal_db_id: OWNER_DB.to_string(),
            source_terminal_db_id: SOURCE_DB.to_string(),
            currency: "EUR".to_string(),
            counted_cents: 12_345,
            closed_at: CLOSED_AT.to_string(),
            confirmed_drawer: hosted_drawer(),
            drawer: hosted_drawer(),
            request_body: body(),
        }
    }

    /// The confirmed hosted drawer of the fixture opening; the default local
    /// preview approves the same ordinary term.
    fn hosted_drawer() -> DrawerState {
        DrawerState {
            version: 3,
            acknowledgement_id: Some(ACK.to_string()),
            gift_cash_cents: 2_000,
            ordinary_expected_cents: 10_000,
            expected_cents: 12_000,
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-30T18:00:01.000Z")
            .expect("fixture instant")
            .with_timezone(&Utc)
    }

    /// One capture inside a real caller transaction; committed on success,
    /// rolled back (dropped) on refusal.
    fn capture_committed(
        conn: &Connection,
        capture: &ClosingCapture,
    ) -> Result<(ClosingOriginal, bool), ClosingError> {
        let tx = conn
            .unchecked_transaction()
            .expect("begin caller transaction");
        let outcome = capture_original(&tx, capture, now());
        if outcome.is_ok() {
            tx.commit().expect("commit caller transaction");
        }
        outcome
    }

    fn code(outcome: Result<(ClosingOriginal, bool), ClosingError>) -> &'static str {
        outcome.expect_err("the capture must be refused").code
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).expect("count")
    }

    fn closing_rows(conn: &Connection) -> i64 {
        count(conn, "SELECT COUNT(*) FROM gift_financial_closings")
    }

    /// Stands in for the later integration's local close of the mirror.
    fn close_mirror_locally(conn: &Connection) {
        conn.execute(
            "UPDATE cash_drawer_sessions SET closed_at = ?1 WHERE id = ?2",
            params![CLOSED_AT, DRAWER],
        )
        .expect("close the drawer");
        conn.execute(
            "UPDATE staff_shifts SET status = 'closed' WHERE id = ?1",
            params![SHIFT],
        )
        .expect("close the shift");
    }

    // -- Nonsecret recovery reads and the explicit retry ---------------------

    mod recovery {
        use super::*;
        use crate::gift_financial_opening::{ClosingAccessError, OpeningScope};

        const OTHER_ORG: &str = "9e8d7c6b-5a49-4382-9716-f5e4d3c2b1a0";
        const OTHER_TERMINAL: &str = "terminal-side-02";
        const RETRY_AT: &str = "2026-09-30T18:00:31.000Z";
        const VIEW_KEYS: [&str; 11] = [
            "authorizationRequired",
            "canonical",
            "closingKey",
            "code",
            "countedCents",
            "currency",
            "localPreview",
            "openingKey",
            "queue",
            "shiftId",
            "state",
        ];

        fn scope_of(org: &str, branch: &str, terminal: &str) -> Option<OpeningScope> {
            Some(OpeningScope {
                organization_id: org.to_string(),
                branch_id: branch.to_string(),
                terminal_id: terminal.to_string(),
            })
        }

        fn this_terminal() -> Option<OpeningScope> {
            scope_of(ORG, BRANCH, TERMINAL)
        }

        fn live_session(
            _: &Connection,
            _: &ClosingOriginal,
            _: DateTime<Utc>,
        ) -> Result<(), ClosingAccessError> {
            Ok(())
        }

        fn no_session(
            _: &Connection,
            _: &ClosingOriginal,
            _: DateTime<Utc>,
        ) -> Result<(), ClosingAccessError> {
            Err(ClosingAccessError::ReauthRequired)
        }

        fn unconsulted(
            _: &Connection,
            _: &ClosingOriginal,
            _: DateTime<Utc>,
        ) -> Result<(), ClosingAccessError> {
            panic!("an adopted closing never consults the hosted session")
        }

        fn cashier(staff: &str) -> Value {
            json!({ "staffId": staff })
        }

        fn keyed(staff: &str) -> Value {
            json!({ "closingKey": CLOSING_KEY, "staffId": staff })
        }

        /// The frozen body as the close capture writes it.
        fn retained_body() -> Value {
            let mut request_body = body();
            request_body["idempotencyKey"] = json!(CLOSING_KEY);
            request_body
        }

        /// The retained original as the close leaves it: the pending journal
        /// row, the local close of its mirror holding the count, and its exact
        /// protected queue row retained by the dispatcher with a safe code.
        fn retain(conn: &Connection) {
            let original = ClosingCapture {
                request_body: retained_body(),
                ..capture()
            };
            capture_committed(conn, &original).expect("capture the original");
            let (counted, expected) = (original.counted_cents, original.drawer.expected_cents);
            let variance = counted - expected;
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                    closing_amount = ?1, closing_amount_cents = ?2,
                    expected_amount = ?3, expected_amount_cents = ?4,
                    variance_amount = ?5, variance_amount_cents = ?6,
                    reconciled = 1, closed_at = ?7, reconciled_at = ?7, updated_at = ?7
                 WHERE id = ?8",
                params![
                    counted as f64 / 100.0,
                    counted,
                    expected as f64 / 100.0,
                    expected,
                    variance as f64 / 100.0,
                    variance,
                    CLOSED_AT,
                    DRAWER
                ],
            )
            .expect("close the drawer locally");
            conn.execute(
                "UPDATE staff_shifts SET
                    closing_cash_amount = ?1, closing_cash_amount_cents = ?2,
                    expected_cash_amount = ?3, expected_cash_amount_cents = ?4,
                    cash_variance = ?5, cash_variance_cents = ?6,
                    check_out_time = ?7, status = 'closed', sync_status = 'pending', updated_at = ?7
                 WHERE id = ?8",
                params![
                    counted as f64 / 100.0,
                    counted,
                    expected as f64 / 100.0,
                    expected,
                    variance as f64 / 100.0,
                    variance,
                    CLOSED_AT,
                    SHIFT
                ],
            )
            .expect("close the shift locally");
            conn.execute(
                "INSERT INTO parity_sync_queue (
                    id, table_name, record_id, operation, data, organization_id,
                    created_at, attempts, error_message, next_retry_at, status
                 ) VALUES (?1, 'staff_shifts', ?2, 'UPDATE', ?3, ?4, ?5, 2, 'TRANSPORT_UNCONFIRMED', ?6, 'pending')",
                params![QUEUE_ID, SHIFT, retained_body().to_string(), ORG, CLOSED_AT, RETRY_AT],
            )
            .expect("queue the original");
        }

        fn retained_conn() -> Connection {
            let conn = conn_with_opening("confirmed_usable");
            retain(&conn);
            conn
        }

        fn queue_item(conn: &Connection) -> Snapshot {
            row(conn, "parity_sync_queue", "id", QUEUE_ID)
        }

        fn journal(conn: &Connection) -> Snapshot {
            row(conn, "gift_financial_closings", "closing_key", CLOSING_KEY)
        }

        fn sorted_keys(value: &Value) -> Vec<String> {
            let mut keys: Vec<String> = value
                .as_object()
                .expect("an object")
                .keys()
                .cloned()
                .collect();
            keys.sort();
            keys
        }

        #[test]
        fn another_org_branch_terminal_or_cashier_cannot_enumerate_read_or_retry() {
            let conn = retained_conn();
            let listed = list_pending_closings_in(
                &conn,
                &cashier(&STAFF.to_ascii_uppercase()),
                this_terminal(),
                now(),
                &live_session,
            );
            assert_eq!(
                (listed["success"].as_bool(), listed["truncated"].as_bool()),
                (Some(true), Some(false))
            );
            let closings = listed["closings"].as_array().expect("closings");
            assert_eq!(closings.len(), 1);
            assert_eq!(
                (
                    closings[0]["closingKey"].as_str(),
                    closings[0]["state"].as_str()
                ),
                (Some(CLOSING_KEY), Some("pending"))
            );

            let (queue_before, journal_before) = (queue_item(&conn), journal(&conn));
            for (org, branch, terminal, staff) in [
                (OTHER_ORG, BRANCH, TERMINAL, STAFF),
                (ORG, OTHER_BRANCH, TERMINAL, STAFF),
                (ORG, BRANCH, OTHER_TERMINAL, STAFF),
                (ORG, BRANCH, TERMINAL, OTHER_STAFF),
            ] {
                assert_eq!(
                    list_pending_closings_in(
                        &conn,
                        &cashier(staff),
                        scope_of(org, branch, terminal),
                        now(),
                        &live_session
                    ),
                    json!({ "success": true, "closings": [], "truncated": false })
                );
                let status = closing_status_in(
                    &conn,
                    &keyed(staff),
                    scope_of(org, branch, terminal),
                    now(),
                    &live_session,
                );
                assert_eq!(
                    (status["code"].as_str(), status.get("closing")),
                    (Some("CLOSING_NOT_FOUND"), None)
                );
                let (refusal, wake) = request_closing_retry_in(
                    &conn,
                    &keyed(staff),
                    scope_of(org, branch, terminal),
                    now(),
                    &live_session,
                );
                assert_eq!(
                    (refusal["code"].as_str(), wake),
                    (Some("CLOSING_NOT_FOUND"), false)
                );
            }
            assert!(changed(&queue_before, &queue_item(&conn)).is_empty());
            assert!(changed(&journal_before, &journal(&conn)).is_empty());
            assert!(conn.is_autocommit());
        }

        #[test]
        fn an_unavailable_scope_or_invalid_request_publishes_nothing() {
            let conn = retained_conn();
            let (queue_before, journal_before) = (queue_item(&conn), journal(&conn));
            for refusal in [
                list_pending_closings_in(&conn, &cashier(STAFF), None, now(), &live_session),
                closing_status_in(&conn, &keyed(STAFF), None, now(), &live_session),
                request_closing_retry_in(&conn, &keyed(STAFF), None, now(), &live_session).0,
            ] {
                assert_eq!(refusal["code"], json!("TERMINAL_SCOPE_UNAVAILABLE"));
                assert_eq!(sorted_keys(&refusal), ["code", "error", "success"]);
            }
            for payload in [json!({}), json!({ "staffId": "cashier-1" })] {
                let refusal = list_pending_closings_in(
                    &conn,
                    &payload,
                    this_terminal(),
                    now(),
                    &live_session,
                );
                assert_eq!(refusal["code"], json!("INVALID_STAFF_ID"));
            }
            for (payload, code) in [
                (json!({ "staffId": STAFF }), "INVALID_CLOSING_KEY"),
                (
                    json!({ "closingKey": "closing-1", "staffId": STAFF }),
                    "INVALID_CLOSING_KEY",
                ),
                (json!({ "closingKey": CLOSING_KEY }), "INVALID_STAFF_ID"),
            ] {
                let status =
                    closing_status_in(&conn, &payload, this_terminal(), now(), &live_session);
                assert_eq!(status["code"], json!(code));
                let (refusal, wake) = request_closing_retry_in(
                    &conn,
                    &payload,
                    this_terminal(),
                    now(),
                    &live_session,
                );
                assert_eq!((refusal["code"].as_str(), wake), (Some(code), false));
            }
            assert!(changed(&queue_before, &queue_item(&conn)).is_empty());
            assert!(changed(&journal_before, &journal(&conn)).is_empty());
        }

        #[test]
        fn pending_status_carries_only_the_labelled_local_preview_and_a_safe_code() {
            let conn = retained_conn();
            let original = load_original(&conn, CLOSING_KEY)
                .unwrap()
                .expect("the retained original");
            let status =
                closing_status_in(&conn, &keyed(STAFF), this_terminal(), now(), &live_session);
            assert_eq!(sorted_keys(&status), ["closing", "success"]);
            assert_eq!(sorted_keys(&status["closing"]), VIEW_KEYS);
            assert_eq!(
                status["closing"],
                json!({
                    "closingKey": CLOSING_KEY,
                    "openingKey": OPENING_KEY,
                    "shiftId": SHIFT,
                    "state": "pending",
                    "code": "TRANSPORT_UNCONFIRMED",
                    "authorizationRequired": false,
                    "currency": original.currency,
                    "countedCents": 12_345,
                    "queue": { "status": "pending", "nextRetryAt": RETRY_AT },
                    "localPreview": {
                        "closedAt": original.closed_at,
                        "ordinaryExpectedCents": original.drawer.ordinary_expected_cents,
                        "giftCashCents": original.drawer.gift_cash_cents,
                        "expectedCents": original.drawer.expected_cents,
                        "varianceCents": original.variance_cents,
                    },
                    "canonical": null,
                })
            );
            let text = status.to_string();
            for withheld in [
                "idempotencyKey",
                "closing_cash_cents",
                "shift_close",
                "request",
                "session",
                "pin",
                STAFF,
                DRAWER,
                ORG,
                BRANCH,
                TERMINAL,
            ] {
                assert!(!text.contains(withheld), "{withheld} must not be published");
            }

            let reauth =
                closing_status_in(&conn, &keyed(STAFF), this_terminal(), now(), &no_session);
            let closing = &reauth["closing"];
            assert_eq!(
                (
                    &closing["state"],
                    &closing["authorizationRequired"],
                    &closing["code"]
                ),
                (
                    &json!("pending"),
                    &json!(true),
                    &json!(ClosingAccessError::ReauthRequired.code())
                )
            );
        }

        #[test]
        fn confirmed_status_reads_only_the_frozen_canonical_proof() {
            let conn = conn_with_closed_original(14_000, preview());
            adopted(adopt_committed(&conn, Some(&reply(canonical())), None));
            let adoption = load_adopted(&conn, CLOSING_KEY)
                .unwrap()
                .expect("the adopted proof");

            let status = closing_status_in(
                &conn,
                &keyed(STAFF),
                this_terminal(),
                adopt_now(),
                &unconsulted,
            );
            let closing = &status["closing"];
            assert_eq!(sorted_keys(closing), VIEW_KEYS);
            assert_eq!(
                (
                    &closing["state"],
                    &closing["code"],
                    &closing["queue"],
                    &closing["localPreview"]
                ),
                (
                    &json!("confirmed"),
                    &Value::Null,
                    &Value::Null,
                    &Value::Null
                )
            );
            assert_eq!(
                closing["canonical"],
                json!({
                    "closedAt": CANONICAL_AT,
                    "confirmedAt": adoption.confirmed_at,
                    "countedCents": 14_000,
                    "ordinaryExpectedCents": 12_345,
                    "giftCashCents": 2_000,
                    "expectedCents": 14_345,
                    "varianceCents": -345,
                })
            );
            // The frozen canonical time and money, not the count-time preview.
            let local = preview();
            assert_ne!(closing["canonical"]["closedAt"], json!(CLOSED_AT));
            assert_ne!(
                closing["canonical"]["expectedCents"],
                json!(local.expected_cents)
            );
            assert_ne!(
                closing["canonical"]["ordinaryExpectedCents"],
                json!(local.ordinary_expected_cents)
            );
            // An adopted close is no longer recovery work.
            assert_eq!(
                list_pending_closings_in(
                    &conn,
                    &cashier(STAFF),
                    this_terminal(),
                    adopt_now(),
                    &unconsulted
                )["closings"],
                json!([])
            );
        }

        #[test]
        fn a_missing_or_corrupt_proof_is_never_reported_confirmed() {
            for damage in [
                "UPDATE gift_financial_closings SET confirmation_json = '{\"contract\":\"gift_closing_v1\"}'",
                "UPDATE gift_financial_closings SET canonical_closed_at = '2026-09-30T18:00:09.000Z'",
            ] {
                let conn = conn_with_closed_original(14_000, preview());
                adopted(adopt_committed(&conn, Some(&reply(canonical())), None));
                // Simulated storage damage behind the immutable original.
                conn.execute_batch(&format!(
                    "DROP TRIGGER trg_gift_financial_closings_original_immutable; {damage};"
                ))
                .expect("damage the stored proof");
                assert!(!matches!(load_adopted(&conn, CLOSING_KEY), Ok(Some(_))), "{damage}");

                let status = closing_status_in(&conn, &keyed(STAFF), this_terminal(), adopt_now(), &unconsulted);
                let closing = &status["closing"];
                assert_eq!(
                    (&closing["state"], &closing["code"], &closing["canonical"], &closing["localPreview"]),
                    (&json!("blocked"), &json!("GIFT_CLOSING_PROOF_UNAVAILABLE"), &Value::Null, &Value::Null),
                    "{damage}"
                );
                let listed = list_pending_closings_in(&conn, &cashier(STAFF), this_terminal(), adopt_now(), &unconsulted);
                assert_eq!(listed["closings"].as_array().map(Vec::len), Some(1), "{damage}");
                assert_eq!(listed["closings"][0]["state"], json!("blocked"), "{damage}");
            }
        }

        #[test]
        fn a_gift_shift_closed_without_its_original_is_blocked_not_completed() {
            let conn = conn_with_opening("confirmed_usable");
            close_mirror_locally(&conn);
            assert_eq!(
                list_pending_closings_in(
                    &conn,
                    &cashier(STAFF),
                    this_terminal(),
                    now(),
                    &live_session
                ),
                json!({
                    "success": true,
                    "truncated": false,
                    "closings": [{
                        "closingKey": null,
                        "openingKey": OPENING_KEY,
                        "shiftId": SHIFT,
                        "state": "blocked",
                        "code": "GIFT_CLOSING_ORIGINAL_MISSING",
                        "authorizationRequired": false,
                        "currency": null,
                        "countedCents": null,
                        "queue": null,
                        "localPreview": null,
                        "canonical": null,
                    }],
                })
            );
            for (staff, scope) in [
                (OTHER_STAFF, this_terminal()),
                (STAFF, scope_of(ORG, BRANCH, OTHER_TERMINAL)),
            ] {
                assert_eq!(
                    list_pending_closings_in(&conn, &cashier(staff), scope, now(), &live_session)
                        ["closings"],
                    json!([])
                );
            }
            // A still-open gift shift is not a missing close.
            let open = conn_with_opening("confirmed_usable");
            assert_eq!(
                list_pending_closings_in(
                    &open,
                    &cashier(STAFF),
                    this_terminal(),
                    now(),
                    &live_session
                )["closings"],
                json!([])
            );
        }

        #[test]
        fn a_missing_or_changed_queue_item_is_blocked_and_never_recreated_or_retried() {
            let conn = retained_conn();
            let journal_before = journal(&conn);
            conn.execute(
                "DELETE FROM parity_sync_queue WHERE id = ?1",
                params![QUEUE_ID],
            )
            .expect("lose the queue item");
            let status =
                closing_status_in(&conn, &keyed(STAFF), this_terminal(), now(), &live_session);
            let closing = &status["closing"];
            assert_eq!(
                (&closing["state"], &closing["code"], &closing["queue"]),
                (
                    &json!("blocked"),
                    &json!("GIFT_CLOSING_QUEUE_MISSING"),
                    &Value::Null
                )
            );
            let (refusal, wake) = request_closing_retry_in(
                &conn,
                &keyed(STAFF),
                this_terminal(),
                now(),
                &live_session,
            );
            assert_eq!(
                (refusal["code"].as_str(), wake),
                (Some("GIFT_CLOSING_QUEUE_MISSING"), false)
            );
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM parity_sync_queue"), 0);
            assert!(changed(&journal_before, &journal(&conn)).is_empty());

            let mut altered = retained_body();
            altered["closing_cash_cents"] = json!(12_400);
            for (column, value, code) in [
                ("data", altered.to_string(), "GIFT_CLOSING_QUEUE_MISMATCH"),
                (
                    "record_id",
                    OTHER_CLOSING_KEY.to_string(),
                    "GIFT_CLOSING_QUEUE_MISMATCH",
                ),
                (
                    "status",
                    "conflict".to_string(),
                    "GIFT_CLOSING_QUEUE_UNAVAILABLE",
                ),
            ] {
                let conn = retained_conn();
                conn.execute(
                    &format!("UPDATE parity_sync_queue SET {column} = ?1 WHERE id = ?2"),
                    params![value, QUEUE_ID],
                )
                .expect("change the queue item");
                let before = queue_item(&conn);
                let status =
                    closing_status_in(&conn, &keyed(STAFF), this_terminal(), now(), &live_session);
                assert_eq!(
                    (&status["closing"]["state"], &status["closing"]["code"]),
                    (&json!("blocked"), &json!(code)),
                    "{column}"
                );
                let (refusal, wake) = request_closing_retry_in(
                    &conn,
                    &keyed(STAFF),
                    this_terminal(),
                    now(),
                    &live_session,
                );
                assert_eq!(
                    (refusal["code"].as_str(), wake),
                    (Some(code), false),
                    "{column}"
                );
                assert!(changed(&before, &queue_item(&conn)).is_empty(), "{column}");
            }
        }

        #[test]
        fn explicit_retry_only_makes_the_exact_original_due_again_and_stays_pending() {
            let conn = retained_conn();
            let (queue_before, journal_before) = (queue_item(&conn), journal(&conn));
            let (queued, wake) = request_closing_retry_in(
                &conn,
                &keyed(STAFF),
                this_terminal(),
                now(),
                &live_session,
            );
            assert!(wake);
            assert_eq!(
                queued,
                json!({ "success": true, "closing": { "closingKey": CLOSING_KEY, "shiftId": SHIFT, "state": "queued" } })
            );
            assert_eq!(
                changed(&queue_before, &queue_item(&conn)),
                ["next_retry_at"]
            );
            assert!(changed(&journal_before, &journal(&conn)).is_empty());
            assert_eq!(
                (
                    count(&conn, "SELECT COUNT(*) FROM parity_sync_queue"),
                    closing_rows(&conn)
                ),
                (1, 1)
            );
            assert!(conn.is_autocommit());

            // Queued is not completion: the same key and count stay pending.
            let status =
                closing_status_in(&conn, &keyed(STAFF), this_terminal(), now(), &live_session);
            let closing = &status["closing"];
            assert_eq!(
                (
                    &closing["closingKey"],
                    &closing["state"],
                    &closing["countedCents"],
                    &closing["code"]
                ),
                (
                    &json!(CLOSING_KEY),
                    &json!("pending"),
                    &json!(12_345),
                    &json!("TRANSPORT_UNCONFIRMED")
                )
            );
            assert_eq!(
                closing["queue"],
                json!({ "status": "pending", "nextRetryAt": null })
            );

            // A repeat changes nothing more; a claimed row is left to the dispatcher.
            let due = queue_item(&conn);
            assert_eq!(
                request_closing_retry_in(
                    &conn,
                    &keyed(STAFF),
                    this_terminal(),
                    now(),
                    &live_session
                ),
                (queued.clone(), false)
            );
            assert!(changed(&due, &queue_item(&conn)).is_empty());
            conn.execute(
                "UPDATE parity_sync_queue SET status = 'processing' WHERE id = ?1",
                params![QUEUE_ID],
            )
            .expect("claim the row");
            let claimed = queue_item(&conn);
            assert_eq!(
                request_closing_retry_in(
                    &conn,
                    &keyed(STAFF),
                    this_terminal(),
                    now(),
                    &live_session
                ),
                (queued, false)
            );
            assert!(changed(&claimed, &queue_item(&conn)).is_empty());
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM recovery_action_log"), 1);
        }

        #[test]
        fn retry_snapshot_guard_survives_restart_and_expires_without_resetting_attempts() {
            let tmp = crate::tests::harness::TempDir::new();
            let path = tmp.path().join("retry.db");
            {
                let conn = Connection::open(&path).unwrap();
                crate::db::run_migrations_for_test(&conn);
                seed_opening(&conn, "confirmed_usable");
                retain(&conn);
                assert!(
                    request_closing_retry_in(
                        &conn,
                        &keyed(STAFF),
                        this_terminal(),
                        now(),
                        &live_session
                    )
                    .1
                );
                let raw: String = conn
                    .query_row("SELECT payload_json FROM recovery_action_log", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                let snapshot: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(
                    snapshot["before"],
                    json!({"status": "pending", "nextRetryAt": RETRY_AT})
                );
                assert_eq!(
                    snapshot["after"],
                    json!({"status": "pending", "nextRetryAt": null})
                );
                assert_eq!(snapshot["outcome"], "pending");
                assert_eq!(count(&conn, "SELECT success FROM recovery_action_log"), 0);
                assert!(snapshot.get("body").is_none());
            }
            let conn = Connection::open(&path).unwrap();
            let before = queue_item(&conn);
            for delta in [-60, 0, 29] {
                assert!(
                    !request_closing_retry_in(
                        &conn,
                        &keyed(STAFF),
                        this_terminal(),
                        now() + chrono::Duration::seconds(delta),
                        &live_session
                    )
                    .1
                );
            }
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM recovery_action_log"), 1);
            assert!(
                request_closing_retry_in(
                    &conn,
                    &keyed(STAFF),
                    this_terminal(),
                    now() + chrono::Duration::seconds(30),
                    &live_session
                )
                .1
            );
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM recovery_action_log"), 2);
            assert!(changed(&before, &queue_item(&conn)).is_empty());
        }

        #[test]
        fn retry_audit_and_scheduling_roll_back_together_on_either_write_failure() {
            for failure in [
                "CREATE TRIGGER fail_audit BEFORE INSERT ON recovery_action_log BEGIN SELECT RAISE(ABORT, 'test'); END",
                "CREATE TRIGGER fail_schedule BEFORE UPDATE OF next_retry_at ON parity_sync_queue BEGIN SELECT RAISE(ABORT, 'test'); END",
            ] {
                let conn = retained_conn();
                let before = queue_item(&conn);
                conn.execute_batch(failure).unwrap();
                let (reply, wake) = request_closing_retry_in(&conn, &keyed(STAFF), this_terminal(), now(), &live_session);
                assert_eq!(reply["code"], "LOCAL_STORE_FAILED");
                assert!(!wake);
                assert!(conn.is_autocommit());
                assert!(changed(&before, &queue_item(&conn)).is_empty());
                assert_eq!(count(&conn, "SELECT COUNT(*) FROM recovery_action_log"), 0);
            }
        }

        #[test]
        fn retry_refuses_without_the_cashier_inside_a_caller_transaction_or_after_adoption() {
            let conn = retained_conn();
            let before = queue_item(&conn);
            let (refusal, wake) =
                request_closing_retry_in(&conn, &keyed(STAFF), this_terminal(), now(), &no_session);
            assert_eq!(
                (refusal["code"].clone(), wake),
                (json!(ClosingAccessError::ReauthRequired.code()), false)
            );
            {
                let tx = conn.unchecked_transaction().expect("a caller transaction");
                let (refusal, wake) = request_closing_retry_in(
                    &tx,
                    &keyed(STAFF),
                    this_terminal(),
                    now(),
                    &live_session,
                );
                assert_eq!(
                    (refusal["code"].as_str(), wake),
                    (Some("LOCAL_STORE_FAILED"), false)
                );
            }
            assert!(changed(&before, &queue_item(&conn)).is_empty());
            assert!(conn.is_autocommit());

            let adopted_conn = conn_with_closed_original(14_000, preview());
            adopted(adopt_committed(
                &adopted_conn,
                Some(&reply(canonical())),
                None,
            ));
            let (refusal, wake) = request_closing_retry_in(
                &adopted_conn,
                &keyed(STAFF),
                this_terminal(),
                adopt_now(),
                &unconsulted,
            );
            assert_eq!(
                (refusal["code"].as_str(), wake),
                (Some("CLOSING_NOT_PENDING"), false)
            );
        }

        #[test]
        fn the_retained_original_survives_a_restart() {
            let tmp = crate::tests::harness::TempDir::new();
            let path = tmp.path().join("pos.db");
            {
                let conn = Connection::open(&path).expect("open file-backed db");
                crate::db::run_migrations_for_test(&conn);
                seed_opening(&conn, "confirmed_usable");
                retain(&conn);
            }

            let conn = Connection::open(&path).expect("reopen file-backed db");
            let listed = list_pending_closings_in(
                &conn,
                &cashier(STAFF),
                this_terminal(),
                now(),
                &live_session,
            );
            let closings = listed["closings"].as_array().expect("closings");
            assert_eq!(closings.len(), 1);
            assert_eq!(
                (
                    &closings[0]["closingKey"],
                    &closings[0]["state"],
                    &closings[0]["countedCents"],
                    &closings[0]["queue"]["status"]
                ),
                (
                    &json!(CLOSING_KEY),
                    &json!("pending"),
                    &json!(12_345),
                    &json!("pending")
                )
            );
            let (_, wake) = request_closing_retry_in(
                &conn,
                &keyed(STAFF),
                this_terminal(),
                now(),
                &live_session,
            );
            assert!(wake);
            assert_eq!(
                (
                    count(&conn, "SELECT COUNT(*) FROM parity_sync_queue"),
                    closing_rows(&conn)
                ),
                (1, 1)
            );
        }

        #[test]
        fn native_entry_points_resolve_the_trusted_terminal_scope() {
            let conn = retained_conn();
            for (key, value) in [
                ("organization_id", ORG),
                ("branch_id", BRANCH),
                ("terminal_id", TERMINAL),
            ] {
                crate::db::set_setting(&conn, "terminal", key, value)
                    .expect("seed the trusted terminal scope");
            }
            let db = crate::db::DbState {
                conn: std::sync::Mutex::new(conn),
                db_path: std::path::PathBuf::new(),
            };

            let listed = list_pending_closings(&db, &cashier(STAFF)).expect("list");
            assert_eq!(listed["closings"][0]["closingKey"], json!(CLOSING_KEY));
            // The real close-purpose accessor keeps it pending (re-authorization
            // is flagged, never a blocked or completed close).
            let status = closing_status(&db, &keyed(STAFF)).expect("status");
            assert_eq!(status["closing"]["state"], json!("pending"));

            crate::db::set_setting(
                &db.conn.lock().expect("lock"),
                "terminal",
                "terminal_id",
                OTHER_TERMINAL,
            )
            .expect("move the terminal");
            let before = queue_item(&db.conn.lock().expect("lock"));
            assert_eq!(
                list_pending_closings(&db, &cashier(STAFF)).expect("list")["closings"],
                json!([])
            );
            assert_eq!(
                closing_status(&db, &keyed(STAFF)).expect("status")["code"],
                json!("CLOSING_NOT_FOUND")
            );
            let (refusal, wake) = request_closing_retry(&db, &keyed(STAFF)).expect("retry");
            assert_eq!(
                (refusal["code"].as_str(), wake),
                (Some("CLOSING_NOT_FOUND"), false)
            );
            assert!(changed(&before, &queue_item(&db.conn.lock().expect("lock"))).is_empty());
        }
    }

    #[test]
    fn capture_writes_one_pending_original_and_identical_replay_returns_it_after_local_close() {
        let conn = conn_with_opening("confirmed_usable");
        let queue_before = count(&conn, "SELECT COUNT(*) FROM parity_sync_queue");

        let (original, created) = capture_committed(&conn, &capture()).expect("first capture");
        assert!(created);
        assert_eq!(original.state, ClosingState::Pending);
        assert_eq!(original.pending_reason, None);
        assert_eq!(
            (original.counted_cents, original.variance_cents),
            (12_345, 345)
        );
        assert_eq!(
            (
                original.owner_terminal_db_id.as_str(),
                original.source_terminal_db_id.as_str()
            ),
            (OWNER_DB, SOURCE_DB)
        );
        assert_eq!(original.drawer, capture().drawer);
        assert_eq!(
            serde_json::from_str::<Value>(&original.request_body_json).unwrap(),
            body()
        );
        assert_eq!(closing_rows(&conn), 1);
        // Capture alone writes no queue item and closes no mirror.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM parity_sync_queue"),
            queue_before
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM staff_shifts WHERE status = 'active'"
            ),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM cash_drawer_sessions WHERE closed_at IS NULL"
            ),
            1
        );

        close_mirror_locally(&conn);
        let (replayed, created) =
            capture_committed(&conn, &capture()).expect("identical replay after local close");
        assert!(!created);
        assert_eq!(replayed, original);
        assert_eq!(closing_rows(&conn), 1);
        assert_eq!(
            load_original_for_opening(&conn, OPENING_KEY).unwrap(),
            Some(original)
        );
    }

    #[test]
    fn changed_count_body_key_or_queue_is_refused_without_replacing_the_original() {
        let conn = conn_with_opening("confirmed_usable");
        let (original, _) = capture_committed(&conn, &capture()).expect("first capture");

        let mut changed_count = capture();
        changed_count.counted_cents += 1;
        let mut changed_body = capture();
        changed_body.request_body["closing_cash_cents"] = json!(12_346);
        let mut changed_key = capture();
        changed_key.closing_key = OTHER_CLOSING_KEY.to_string();
        let mut changed_queue = capture();
        changed_queue.queue_item_id = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d".to_string();
        let mut changed_time = capture();
        changed_time.closed_at = "2026-09-30T18:05:00.000Z".to_string();
        for changed in [
            changed_count,
            changed_body,
            changed_key,
            changed_queue,
            changed_time,
        ] {
            assert_eq!(
                code(capture_committed(&conn, &changed)),
                "CLOSING_ORIGINAL_CONFLICT"
            );
        }
        assert_eq!(closing_rows(&conn), 1);
        assert_eq!(
            load_original(&conn, CLOSING_KEY).unwrap(),
            Some(original.clone())
        );

        // The stored original itself cannot be rewritten in place.
        for sql in [
            "UPDATE gift_financial_closings SET counted_cents = counted_cents + 1, variance_cents = variance_cents + 1",
            "UPDATE gift_financial_closings SET request_body_json = '{}'",
            "UPDATE gift_financial_closings SET queue_item_id = 'another-queue-item'",
        ] {
            let error = conn.execute(sql, []).expect_err("the original is immutable");
            assert!(error.to_string().contains("GIFT_FINANCIAL_CLOSING_ORIGINAL_IMMUTABLE"), "{error}");
        }
        assert_eq!(load_original(&conn, CLOSING_KEY).unwrap(), Some(original));
    }

    #[test]
    fn wrong_original_actor_scope_or_drawer_fingerprint_is_refused() {
        let conn = conn_with_opening("confirmed_usable");
        let refuse = |mutate: &dyn Fn(&mut ClosingCapture), expected: &str| {
            let mut wrong = capture();
            mutate(&mut wrong);
            assert_eq!(code(capture_committed(&conn, &wrong)), expected);
        };
        refuse(
            &|c| c.staff_id = OTHER_STAFF.to_string(),
            "OPENING_MISMATCH",
        );
        refuse(
            &|c| c.branch_id = OTHER_BRANCH.to_string(),
            "OPENING_MISMATCH",
        );
        refuse(
            &|c| c.terminal_id = "terminal-other-02".to_string(),
            "OPENING_MISMATCH",
        );
        refuse(
            &|c| c.owner_terminal_db_id = SOURCE_DB.to_string(),
            "OPENING_MISMATCH",
        );
        refuse(
            &|c| c.source_terminal_db_id = OWNER_DB.to_string(),
            "OPENING_MISMATCH",
        );
        refuse(&|c| c.drawer_id = SHIFT.to_string(), "OPENING_MISMATCH");
        refuse(&|c| c.currency = "USD".to_string(), "OPENING_MISMATCH");
        // The complete hosted fingerprint is checked, its local preview kept consistent.
        refuse(
            &|c| {
                c.confirmed_drawer.version = 4;
                c.drawer.version = 4;
            },
            "DRAWER_FINGERPRINT_MISMATCH",
        );
        refuse(
            &|c| {
                c.confirmed_drawer.acknowledgement_id = None;
                c.drawer.acknowledgement_id = None;
            },
            "DRAWER_FINGERPRINT_MISMATCH",
        );
        refuse(
            &|c| {
                c.confirmed_drawer.gift_cash_cents = 2_001;
                c.drawer.gift_cash_cents = 2_001;
                c.drawer.expected_cents = 12_001;
            },
            "DRAWER_FINGERPRINT_MISMATCH",
        );
        refuse(
            &|c| c.confirmed_drawer.ordinary_expected_cents = 9_999,
            "DRAWER_FINGERPRINT_MISMATCH",
        );
        refuse(
            &|c| c.confirmed_drawer.expected_cents = 12_001,
            "DRAWER_FINGERPRINT_MISMATCH",
        );
        // The local preview keeps the confirmed gift terms and adds up.
        refuse(&|c| c.drawer.version = 4, "INVALID_CLOSING_CAPTURE");
        refuse(
            &|c| c.drawer.acknowledgement_id = None,
            "INVALID_CLOSING_CAPTURE",
        );
        refuse(
            &|c| c.drawer.gift_cash_cents = 2_001,
            "INVALID_CLOSING_CAPTURE",
        );
        refuse(
            &|c| c.drawer.expected_cents = 12_001,
            "INVALID_CLOSING_CAPTURE",
        );
        refuse(
            &|c| c.request_body["x-staff-session-id"] = json!("hosted-session"),
            "INVALID_CLOSING_CAPTURE",
        );
        assert_eq!(closing_rows(&conn), 0);

        // Once the original exists, another actor can neither replay nor replace it.
        let (original, _) = capture_committed(&conn, &capture()).expect("first capture");
        refuse(
            &|c| c.staff_id = OTHER_STAFF.to_string(),
            "OPENING_MISMATCH",
        );
        assert_eq!(load_original(&conn, CLOSING_KEY).unwrap(), Some(original));
    }

    #[test]
    fn local_ordinary_preview_is_stored_while_the_full_hosted_fingerprint_stays_enforced() {
        let conn = conn_with_opening("confirmed_usable");
        // Before hosted synchronization the approved local ordinary (9_500)
        // differs from the hosted ordinary (10_000) the opening confirmed.
        let local = ClosingCapture {
            drawer: DrawerState {
                ordinary_expected_cents: 9_500,
                expected_cents: 11_500,
                ..hosted_drawer()
            },
            ..capture()
        };
        let refuse_host = |mutate: &dyn Fn(&mut DrawerState)| {
            let mut stale = local.clone();
            mutate(&mut stale.confirmed_drawer);
            assert_eq!(
                code(capture_committed(&conn, &stale)),
                "DRAWER_FINGERPRINT_MISMATCH"
            );
        };
        // The local terms never stand in for the complete hosted fingerprint.
        refuse_host(&|d| d.ordinary_expected_cents = 9_500);
        refuse_host(&|d| d.expected_cents = 11_500);
        refuse_host(&|d| {
            d.ordinary_expected_cents = 9_500;
            d.expected_cents = 11_500;
        });
        assert_eq!(closing_rows(&conn), 0);

        let (original, created) =
            capture_committed(&conn, &local).expect("capture the local preview");
        assert!(created);
        assert_eq!(original.drawer, local.drawer);
        assert_eq!(original.variance_cents, 12_345 - 11_500);
        assert_eq!(
            gift_financial_opening::load_intent(&conn, OPENING_KEY)
                .unwrap()
                .unwrap()
                .drawer,
            Some(hosted_drawer()),
            "the opening keeps the complete hosted fingerprint"
        );

        // Replay needs the exact stored preview; a hosted-ordinary preview conflicts.
        close_mirror_locally(&conn);
        let (replayed, created) = capture_committed(&conn, &local).expect("identical replay");
        assert!(!created);
        assert_eq!(replayed, original);
        assert_eq!(
            code(capture_committed(&conn, &capture())),
            "CLOSING_ORIGINAL_CONFLICT"
        );
        assert_eq!(load_original(&conn, CLOSING_KEY).unwrap(), Some(original));
    }

    #[test]
    fn file_backed_reopen_preserves_the_original_body_count_and_key() {
        let tmp = crate::tests::harness::TempDir::new();
        let path = tmp.path().join("pos.db");
        let original = {
            let conn = Connection::open(&path).expect("open file-backed db");
            crate::db::run_migrations_for_test(&conn);
            seed_opening(&conn, "confirmed_usable");
            capture_committed(&conn, &capture())
                .expect("first capture")
                .0
        };

        let conn = Connection::open(&path).expect("reopen file-backed db");
        let stored = load_original(&conn, CLOSING_KEY)
            .unwrap()
            .expect("the original survives a reopen");
        assert_eq!(stored, original);
        assert_eq!(
            stored.request_body_json,
            serde_json::to_string(&body()).unwrap()
        );
        assert_eq!(
            (
                stored.counted_cents,
                stored.closing_key.as_str(),
                stored.queue_item_id.as_str()
            ),
            (12_345, CLOSING_KEY, QUEUE_ID)
        );
        let (replayed, created) =
            capture_committed(&conn, &capture()).expect("replay after reopen");
        assert!(!created);
        assert_eq!(replayed, stored);
    }

    #[test]
    fn caller_rollback_removes_the_capture() {
        let conn = conn_with_opening("confirmed_usable");
        let tx = conn
            .unchecked_transaction()
            .expect("begin caller transaction");
        let (original, created) =
            capture_original(&tx, &capture(), now()).expect("capture in the caller transaction");
        assert!(created);
        assert_eq!(load_original(&tx, CLOSING_KEY).unwrap(), Some(original));
        tx.rollback().expect("caller rollback");

        assert!(conn.is_autocommit());
        assert_eq!(load_original(&conn, CLOSING_KEY).unwrap(), None);
        assert_eq!(closing_rows(&conn), 0);
        // Nothing was committed on the caller's behalf; the same original can still be captured.
        assert!(
            capture_committed(&conn, &capture())
                .expect("capture after rollback")
                .1
        );
    }

    #[test]
    fn autocommit_or_unconfirmed_original_is_refused() {
        let conn = conn_with_opening("confirmed_usable");
        assert_eq!(
            code(capture_original(&conn, &capture(), now())),
            "CLOSING_TRANSACTION_REQUIRED"
        );
        let mut unknown = capture();
        unknown.opening_key = "8a9b0c1d-2e3f-4a4b-9c5d-6e7f8a9b0c1d".to_string();
        assert_eq!(
            code(capture_committed(&conn, &unknown)),
            "OPENING_NOT_FOUND"
        );
        // A first capture needs the still-open original mirror.
        close_mirror_locally(&conn);
        assert_eq!(
            code(capture_committed(&conn, &capture())),
            "OPENING_MIRROR_NOT_OPEN"
        );
        assert_eq!(closing_rows(&conn), 0);

        for (state, expected) in [
            ("pending", "OPENING_NOT_CONFIRMED"),
            ("confirmed_unusable", "OPENING_NOT_USABLE"),
        ] {
            let conn = conn_with_opening(state);
            assert_eq!(code(capture_committed(&conn, &capture())), expected);
            assert_eq!(closing_rows(&conn), 0);
        }
    }

    // -----------------------------------------------------------------------
    // Proof and adoption
    // -----------------------------------------------------------------------

    const CANONICAL_AT: &str = "2026-09-30T18:00:07.250Z";
    const ADOPTED_AT: &str = "2026-09-30T18:02:00.000Z";
    const NEW_ACK: &str = "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

    /// The only columns adoption may write; every other column keeps its value.
    const DRAWER_ADOPTED: &[&str] = &[
        "closing_amount",
        "closing_amount_cents",
        "expected_amount",
        "expected_amount_cents",
        "variance_amount",
        "variance_amount_cents",
        "closed_at",
        "reconciled",
        "reconciled_at",
        "updated_at",
    ];
    const SHIFT_ADOPTED: &[&str] = &[
        "closing_cash_amount",
        "closing_cash_amount_cents",
        "expected_cash_amount",
        "expected_cash_amount_cents",
        "cash_variance",
        "cash_variance_cents",
        "check_out_time",
        "status",
        "sync_status",
        "updated_at",
    ];
    const OPENING_ADOPTED: &[&str] = &["state", "server_usable", "updated_at"];
    const JOURNAL_ADOPTED: &[&str] = &[
        "state",
        "confirmation_json",
        "canonical_closed_at",
        "confirmed_at",
        "adopted_at",
        "updated_at",
    ];

    fn adopt_now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(ADOPTED_AT)
            .expect("fixture instant")
            .with_timezone(&Utc)
    }

    /// The local drawer preview of the journal fixture: v3/ACK, 10000 + 2000.
    fn preview() -> DrawerState {
        capture().drawer
    }

    /// A committed original of `counted` cents taken against `drawer`, then the
    /// local close of its mirror with that count and the local preview (what
    /// the later capture integration does in its transaction).
    fn conn_with_closed_original(counted: i64, drawer: DrawerState) -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        seed_opening_with(&conn, "confirmed_usable", &drawer);
        let expected = drawer.expected_cents;
        let variance = counted - expected;
        let mut request_body = body();
        request_body["closing_cash_cents"] = json!(counted);
        let original = ClosingCapture {
            counted_cents: counted,
            confirmed_drawer: drawer.clone(),
            drawer,
            request_body,
            ..capture()
        };
        capture_committed(&conn, &original).expect("capture the original");
        conn.execute(
            "UPDATE cash_drawer_sessions SET
                closing_amount = ?1, closing_amount_cents = ?2,
                expected_amount = ?3, expected_amount_cents = ?4,
                variance_amount = ?5, variance_amount_cents = ?6,
                reconciled = 1, closed_at = ?7, reconciled_at = ?7, updated_at = ?7
             WHERE id = ?8",
            params![
                counted as f64 / 100.0,
                counted,
                expected as f64 / 100.0,
                expected,
                variance as f64 / 100.0,
                variance,
                CLOSED_AT,
                DRAWER
            ],
        )
        .expect("close the drawer locally");
        conn.execute(
            "UPDATE staff_shifts SET
                closing_cash_amount = ?1, closing_cash_amount_cents = ?2,
                expected_cash_amount = ?3, expected_cash_amount_cents = ?4,
                cash_variance = ?5, cash_variance_cents = ?6,
                check_out_time = ?7, status = 'closed', sync_status = 'pending', updated_at = ?7
             WHERE id = ?8",
            params![
                counted as f64 / 100.0,
                counted,
                expected as f64 / 100.0,
                expected,
                variance as f64 / 100.0,
                variance,
                CLOSED_AT,
                SHIFT
            ],
        )
        .expect("close the shift locally");
        conn
    }

    /// A `gift_closing_v1` proof of this original's scope whose canonical
    /// drawer is `ordinary + gift` at `version`/`ack`, conserved by construction.
    fn proof(
        counted: i64,
        ordinary: i64,
        gift: i64,
        version: i64,
        ack: Option<&str>,
        closed_at: &str,
    ) -> Value {
        let expected = ordinary + gift;
        json!({
            "contract": "gift_closing_v1",
            "state": "closed",
            "organization_id": ORG,
            "branch_id": BRANCH,
            "terminal_id": TERMINAL,
            "source_terminal_id": SOURCE_DB,
            "owner_terminal_id": OWNER_DB,
            "shift_id": SHIFT,
            "drawer_id": DRAWER,
            "staff_id": STAFF,
            "currency": "EUR",
            "counted_cents": counted,
            "variance_cents": counted - expected,
            "closed_at": closed_at,
            "drawer": {
                "contract": "gift_funding_v1",
                "drawer_id": DRAWER,
                "shift_id": SHIFT,
                "owner_terminal_id": OWNER_DB,
                "currency": "EUR",
                "gift_cash_cents": gift,
                "ordinary_expected_cents": ordinary,
                "expected_cents": expected,
                "version": version,
                "acknowledgement_id": ack
            }
        })
    }

    /// Canonical close of the 14000 count: ordinary 12345 + gift 2000 = 14345.
    fn canonical() -> Value {
        proof(14_000, 12_345, 2_000, 3, Some(ACK), CANONICAL_AT)
    }

    fn reply(closing: Value) -> Value {
        json!({
            "success": true,
            "results": [{ "shift_id": SHIFT, "status": "ok", "financial_closing": closing }]
        })
    }

    /// One adoption inside a real caller transaction: committed on `Ok`,
    /// rolled back on `Err`.
    fn adopt_committed(
        conn: &Connection,
        data: Option<&Value>,
        error: Option<&str>,
    ) -> Result<ClosingAdoption, ClosingError> {
        let tx = conn
            .unchecked_transaction()
            .expect("begin caller transaction");
        let outcome = adopt_closing_response(&tx, CLOSING_KEY, data, error, adopt_now());
        if outcome.is_ok() {
            tx.commit().expect("commit caller transaction");
        } else {
            tx.rollback().expect("roll back caller transaction");
        }
        outcome
    }

    fn adopted(outcome: Result<ClosingAdoption, ClosingError>) -> (AdoptedClosing, bool) {
        match outcome.expect("adoption") {
            ClosingAdoption::Adopted { closing, replayed } => (closing, replayed),
            ClosingAdoption::Retained(retained) => {
                panic!("expected adoption, retained {retained:?}")
            }
        }
    }

    fn retained(outcome: Result<ClosingAdoption, ClosingError>) -> ClosingRetained {
        match outcome.expect("judged reply") {
            ClosingAdoption::Retained(retained) => retained,
            ClosingAdoption::Adopted { .. } => panic!("expected the original to stay pending"),
        }
    }

    type Snapshot = Vec<(String, rusqlite::types::Value)>;

    /// Every column of one row.
    fn row(conn: &Connection, table: &str, key_column: &str, key: &str) -> Snapshot {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} WHERE {key_column} = ?1"))
            .expect("prepare row snapshot");
        let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
        stmt.query_row(params![key], |r| {
            names
                .iter()
                .enumerate()
                .map(|(index, name)| Ok((name.clone(), r.get::<_, rusqlite::types::Value>(index)?)))
                .collect::<rusqlite::Result<Snapshot>>()
        })
        .expect("read row snapshot")
    }

    /// Drawer mirror, shift mirror, financial opening and closing journal.
    fn rows(conn: &Connection) -> [Snapshot; 4] {
        [
            row(conn, "cash_drawer_sessions", "id", DRAWER),
            row(conn, "staff_shifts", "id", SHIFT),
            row(conn, "gift_financial_openings", "opening_key", OPENING_KEY),
            row(conn, "gift_financial_closings", "closing_key", CLOSING_KEY),
        ]
    }

    fn changed(before: &Snapshot, after: &Snapshot) -> Vec<String> {
        before
            .iter()
            .zip(after)
            .filter(|(old, new)| old != new)
            .map(|(old, _)| old.0.clone())
            .collect()
    }

    #[test]
    fn adoption_writes_the_canonical_close_to_both_mirrors_and_retires_the_opening() {
        let conn = conn_with_closed_original(14_000, preview());
        let queue_before = count(&conn, "SELECT COUNT(*) FROM parity_sync_queue");
        let before = rows(&conn);

        let (view, replayed) = adopted(adopt_committed(&conn, Some(&reply(canonical())), None));
        assert!(!replayed);
        // Canonical: ordinary 12345 + gift 2000 = expected 14345; count 14000 => variance -345.
        assert_eq!(
            (
                view.counted_cents(),
                view.expected_cents(),
                view.variance_cents()
            ),
            (14_000, 14_345, -345)
        );
        assert_eq!(
            (
                view.proof.drawer.ordinary_expected_cents,
                view.proof.drawer.gift_cash_cents
            ),
            (12_345, 2_000)
        );
        // The canonical close time differs from the local one and is adopted as stated.
        assert_eq!(
            (
                view.canonical_closed_at.as_str(),
                view.confirmed_at.as_str(),
                view.adopted_at.as_str()
            ),
            (CANONICAL_AT, ADOPTED_AT, ADOPTED_AT)
        );
        // The immutable original keeps its local time, count and preview.
        assert_eq!(view.original.state, ClosingState::Confirmed);
        assert_eq!(
            (
                view.original.closed_at.as_str(),
                view.original.counted_cents,
                view.original.variance_cents
            ),
            (CLOSED_AT, 14_000, 2_000)
        );
        assert_eq!(view.original.drawer, preview());

        let drawer: (f64, i64, f64, i64, f64, i64, String, i64, String) = conn
            .query_row(
                "SELECT closing_amount, closing_amount_cents, expected_amount, expected_amount_cents,
                        variance_amount, variance_amount_cents, closed_at, reconciled, reconciled_at
                   FROM cash_drawer_sessions WHERE id = ?1",
                params![DRAWER],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
            )
            .expect("read the drawer mirror");
        assert_eq!(
            drawer,
            (
                140.0,
                14_000,
                143.45,
                14_345,
                -3.45,
                -345,
                CANONICAL_AT.to_string(),
                1,
                CANONICAL_AT.to_string()
            )
        );
        let shift: (f64, i64, f64, i64, f64, i64, String, String, String) = conn
            .query_row(
                "SELECT closing_cash_amount, closing_cash_amount_cents, expected_cash_amount,
                        expected_cash_amount_cents, cash_variance, cash_variance_cents,
                        check_out_time, status, sync_status
                   FROM staff_shifts WHERE id = ?1",
                params![SHIFT],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .expect("read the shift mirror");
        assert_eq!(
            shift,
            (
                140.0,
                14_000,
                143.45,
                14_345,
                -3.45,
                -345,
                CANONICAL_AT.to_string(),
                "closed".to_string(),
                "synced".to_string()
            )
        );
        // Retired, never reopened: identities and its current projection stay.
        let opening: (String, i64, i64, Option<String>, i64, i64, i64) = conn
            .query_row(
                "SELECT state, server_usable, drawer_version, drawer_acknowledgement_id,
                        drawer_gift_cash_cents, drawer_ordinary_expected_cents, drawer_expected_cents
                   FROM gift_financial_openings WHERE opening_key = ?1",
                params![OPENING_KEY],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .expect("read the opening");
        assert_eq!(
            opening,
            (
                "confirmed_unusable".to_string(),
                0,
                3,
                Some(ACK.to_string()),
                2_000,
                10_000,
                12_000
            )
        );
        let stored: String = conn
            .query_row(
                "SELECT confirmation_json FROM gift_financial_closings WHERE closing_key = ?1",
                params![CLOSING_KEY],
                |r| r.get(0),
            )
            .expect("read the stored proof");
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), canonical());

        // Nothing else moved: sales and cash movement totals, identities and the original tuple.
        let after = rows(&conn);
        for (index, allowed) in [
            DRAWER_ADOPTED,
            SHIFT_ADOPTED,
            OPENING_ADOPTED,
            JOURNAL_ADOPTED,
        ]
        .into_iter()
        .enumerate()
        {
            for column in changed(&before[index], &after[index]) {
                assert!(
                    allowed.contains(&column.as_str()),
                    "adoption changed {column}"
                );
            }
        }
        // Adoption neither writes nor consumes a queue item.
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM parity_sync_queue"),
            queue_before
        );
        assert_eq!(load_adopted(&conn, CLOSING_KEY).unwrap(), Some(view));
    }

    #[test]
    fn identical_proof_replays_the_frozen_adoption_without_writing_again() {
        let conn = conn_with_closed_original(14_000, preview());
        let (first, _) = adopted(adopt_committed(&conn, Some(&reply(canonical())), None));
        let before = rows(&conn);

        // A later retry of the same proof, even without the result's shift id, replays it.
        let later = DateTime::parse_from_rfc3339("2026-09-30T19:00:00.000Z")
            .expect("fixture instant")
            .with_timezone(&Utc);
        let replay = json!({ "success": true, "results": [{ "financial_closing": canonical() }] });
        let tx = conn
            .unchecked_transaction()
            .expect("begin caller transaction");
        let outcome = adopt_closing_response(&tx, CLOSING_KEY, Some(&replay), None, later);
        tx.commit().expect("commit caller transaction");
        let (again, replayed) = adopted(outcome);
        assert!(replayed);
        assert_eq!(again, first);
        assert_eq!(rows(&conn), before);
        // The canonical expected amount is written once, never added again.
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT expected_amount_cents FROM cash_drawer_sessions WHERE id = '{DRAWER}'"
                )
            ),
            14_345
        );
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT expected_cash_amount_cents FROM staff_shifts WHERE id = '{SHIFT}'"
                )
            ),
            14_345
        );
    }

    #[test]
    fn version_zero_with_a_null_acknowledgement_is_adopted() {
        let unfunded = DrawerState {
            version: 0,
            acknowledgement_id: None,
            gift_cash_cents: 0,
            ordinary_expected_cents: 10_000,
            expected_cents: 10_000,
        };
        let conn = conn_with_closed_original(14_000, unfunded);
        // The same version must keep its null ACK.
        let acknowledged = proof(14_000, 13_000, 0, 0, Some(ACK), CANONICAL_AT);
        assert_eq!(
            retained(adopt_committed(&conn, Some(&reply(acknowledged)), None)).status,
            RetainStatus::Mismatch
        );

        let unacknowledged = proof(14_000, 13_000, 0, 0, None, CANONICAL_AT);
        let (view, replayed) = adopted(adopt_committed(&conn, Some(&reply(unacknowledged)), None));
        assert!(!replayed);
        assert_eq!(
            (
                view.proof.drawer.version,
                view.proof.drawer.acknowledgement_id.clone()
            ),
            (0, None)
        );
        assert_eq!(
            (view.expected_cents(), view.variance_cents()),
            (13_000, 1_000)
        );
        assert_eq!(
            count(
                &conn,
                &format!("SELECT cash_variance_cents FROM staff_shifts WHERE id = '{SHIFT}'")
            ),
            1_000
        );
    }

    #[test]
    fn unproven_or_incompatible_replies_leave_the_original_pending() {
        let conn = conn_with_closed_original(14_000, preview());
        let before = rows(&conn);
        let with = |edit: &dyn Fn(&mut Value)| {
            let mut closing = canonical();
            edit(&mut closing);
            reply(closing)
        };
        let result = |fields: Value| json!({ "success": true, "results": [fields] });
        let (mismatch, invalid, unverified) = (
            GIFT_CARD_CLOSING_MISMATCH,
            GIFT_CARD_CLOSING_PROOF_INVALID,
            GIFT_CARD_CLOSING_UNVERIFIED,
        );
        let cases: Vec<(&str, Option<Value>, Option<&str>, RetainStatus, &str)> = vec![
            (
                "same version, other ACK",
                Some(reply(proof(
                    14_000,
                    12_345,
                    2_000,
                    3,
                    Some(NEW_ACK),
                    CANONICAL_AT,
                ))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "same version, dropped ACK",
                Some(reply(proof(14_000, 12_345, 0, 3, None, CANONICAL_AT))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "lower version",
                Some(reply(proof(
                    14_000,
                    12_345,
                    2_000,
                    2,
                    Some(ACK),
                    CANONICAL_AT,
                ))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "other count",
                Some(reply(proof(
                    14_001,
                    12_345,
                    2_000,
                    3,
                    Some(ACK),
                    CANONICAL_AT,
                ))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "other organization",
                Some(with(&|c| c["organization_id"] = json!(OTHER_BRANCH))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "other branch",
                Some(with(&|c| c["branch_id"] = json!(OTHER_BRANCH))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "other staff",
                Some(with(&|c| c["staff_id"] = json!(OTHER_STAFF))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "other terminal",
                Some(with(&|c| c["terminal_id"] = json!("terminal-other-02"))),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "swapped terminal pins",
                Some(with(&|c| {
                    c["source_terminal_id"] = json!(OWNER_DB);
                    c["owner_terminal_id"] = json!(SOURCE_DB);
                    c["drawer"]["owner_terminal_id"] = json!(SOURCE_DB);
                })),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "other drawer",
                Some(with(&|c| {
                    c["drawer_id"] = json!(NEW_ACK);
                    c["drawer"]["drawer_id"] = json!(NEW_ACK);
                })),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "other currency",
                Some(with(&|c| {
                    c["currency"] = json!("USD");
                    c["drawer"]["currency"] = json!("USD");
                })),
                None,
                RetainStatus::Mismatch,
                mismatch,
            ),
            (
                "extra key",
                Some(with(&|c| c["ok"] = json!(true))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "extra drawer key",
                Some(with(&|c| c["drawer"]["note"] = json!("x"))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "missing key",
                Some(with(&|c| {
                    c.as_object_mut()
                        .expect("proof object")
                        .remove("variance_cents");
                })),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "string cents",
                Some(with(&|c| c["counted_cents"] = json!("14000"))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "fractional cents",
                Some(with(&|c| c["counted_cents"] = json!(14_000.5))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "unsafe cents",
                Some(with(&|c| {
                    c["counted_cents"] = json!(9_007_199_254_740_992_i64)
                })),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "variance not conserved",
                Some(with(&|c| c["variance_cents"] = json!(-344))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "drawer not conserved",
                Some(with(&|c| c["drawer"]["expected_cents"] = json!(14_346))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "other contract",
                Some(with(&|c| c["contract"] = json!("gift_closing_v2"))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "other drawer contract",
                Some(with(&|c| {
                    c["drawer"]["contract"] = json!("gift_closing_v1")
                })),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "open state",
                Some(with(&|c| c["state"] = json!("open"))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "offset instant",
                Some(with(&|c| {
                    c["closed_at"] = json!("2026-09-30T20:00:07.250+02:00")
                })),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "unitless drawer",
                Some(with(&|c| c["drawer"]["currency"] = json!(null))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "drawer of another drawer",
                Some(with(&|c| c["drawer"]["drawer_id"] = json!(SHIFT))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "not a UUID",
                Some(with(&|c| c["staff_id"] = json!("staff-1"))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "gift without ACK",
                Some(with(&|c| c["drawer"]["acknowledgement_id"] = json!(null))),
                None,
                RetainStatus::Unknown,
                invalid,
            ),
            (
                "no proof",
                Some(result(json!({ "shift_id": SHIFT, "status": "ok" }))),
                None,
                RetainStatus::Pending,
                unverified,
            ),
            (
                "null proof",
                Some(result(
                    json!({ "shift_id": SHIFT, "status": "ok", "financial_closing": null }),
                )),
                None,
                RetainStatus::Pending,
                unverified,
            ),
            (
                "207 generic",
                Some(json!({ "success": true, "partial": true, "results": [{ "status": "ok" }] })),
                Some("HTTP 207 Multi-Status"),
                RetainStatus::Pending,
                unverified,
            ),
            (
                "ok alone",
                Some(json!({ "success": true, "ok": true })),
                None,
                RetainStatus::Pending,
                unverified,
            ),
            (
                "skipped",
                Some(result(json!({ "shift_id": SHIFT, "status": "skipped" }))),
                None,
                RetainStatus::Refused,
                GIFT_CARD_CLOSING_SKIPPED,
            ),
            (
                "two results",
                Some(json!({ "success": true, "results": [
                    { "shift_id": SHIFT, "financial_closing": canonical() },
                    { "shift_id": SHIFT, "financial_closing": canonical() }
                ] })),
                None,
                RetainStatus::Pending,
                unverified,
            ),
            (
                "another shift's result",
                Some(result(
                    json!({ "shift_id": OTHER_STAFF, "financial_closing": canonical() }),
                )),
                None,
                RetainStatus::Pending,
                unverified,
            ),
            (
                "session code",
                Some(result(
                    json!({ "shift_id": SHIFT, "error": "STAFF_SESSION_EXPIRED" }),
                )),
                None,
                RetainStatus::AuthRequired,
                "STAFF_SESSION_EXPIRED",
            ),
            (
                "scope code",
                Some(json!({ "success": false, "code": "GIFT_CARD_SCOPE_REJECTED" })),
                None,
                RetainStatus::Refused,
                "GIFT_CARD_SCOPE_REJECTED",
            ),
            (
                "transport mismatch",
                None,
                Some(GIFT_CARD_CLOSING_MISMATCH),
                RetainStatus::Mismatch,
                mismatch,
            ),
            ("no reply", None, None, RetainStatus::Pending, unverified),
        ];
        for (label, data, error, status, code) in cases {
            let outcome = retained(adopt_committed(&conn, data.as_ref(), error));
            assert_eq!(
                (outcome.status, outcome.code.as_str()),
                (status, code),
                "{label}"
            );
            assert_eq!(rows(&conn), before, "{label}");
        }
        assert_eq!(
            load_original(&conn, CLOSING_KEY)
                .unwrap()
                .expect("original")
                .state,
            ClosingState::Pending
        );
        // The same original stays adoptable by its own proof.
        assert!(!adopted(adopt_committed(&conn, Some(&reply(canonical())), None)).1);
    }

    #[test]
    fn newer_compatible_drawer_version_is_adopted_on_first_adoption() {
        let conn = conn_with_closed_original(14_000, preview());
        let newer = proof(14_000, 12_345, 2_500, 4, Some(NEW_ACK), CANONICAL_AT);
        let (view, replayed) = adopted(adopt_committed(&conn, Some(&reply(newer)), None));
        assert!(!replayed);
        assert_eq!(
            (
                view.proof.drawer.version,
                view.proof.drawer.acknowledgement_id.as_deref()
            ),
            (4, Some(NEW_ACK))
        );
        assert_eq!(
            (view.expected_cents(), view.variance_cents()),
            (14_845, -845)
        );
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT variance_amount_cents FROM cash_drawer_sessions WHERE id = '{DRAWER}'"
                )
            ),
            -845
        );
    }

    #[test]
    fn conflicting_later_proof_is_refused_once_adopted() {
        let conn = conn_with_closed_original(14_000, preview());
        adopted(adopt_committed(&conn, Some(&reply(canonical())), None));
        let before = rows(&conn);
        for conflicting in [
            // Another canonical close time ...
            proof(
                14_000,
                12_345,
                2_000,
                3,
                Some(ACK),
                "2026-09-30T18:00:09.000Z",
            ),
            // ... another canonical amount ...
            proof(14_000, 12_000, 2_000, 3, Some(ACK), CANONICAL_AT),
            // ... or a later compatible projection once one proof is adopted.
            proof(14_000, 12_345, 2_000, 5, Some(NEW_ACK), CANONICAL_AT),
        ] {
            let error = adopt_committed(&conn, Some(&reply(conflicting)), None)
                .expect_err("a conflicting proof is refused");
            assert_eq!(error.code, "CLOSING_PROOF_CONFLICT");
            assert_eq!(rows(&conn), before);
        }
        // A proof of another count is no proof of this close at all.
        let other = proof(14_001, 12_345, 2_000, 3, Some(ACK), CANONICAL_AT);
        assert_eq!(
            retained(adopt_committed(&conn, Some(&reply(other)), None)).status,
            RetainStatus::Mismatch
        );
        // The frozen proof and canonical instant cannot be rewritten in place either.
        let error = conn
            .execute(
                "UPDATE gift_financial_closings SET canonical_closed_at = ?1",
                params!["2026-09-30T18:00:09.000Z"],
            )
            .expect_err("the adopted proof is frozen");
        assert!(
            error
                .to_string()
                .contains("GIFT_FINANCIAL_CLOSING_ORIGINAL_IMMUTABLE"),
            "{error}"
        );
        assert_eq!(rows(&conn), before);
    }

    #[test]
    fn failure_on_the_second_mirror_or_the_journal_is_undone_by_the_caller_rollback() {
        let conn = conn_with_closed_original(14_000, preview());
        let before = rows(&conn);
        for (name, target) in [
            ("refuse_shift_adoption", "BEFORE UPDATE ON staff_shifts"),
            (
                "refuse_journal_adoption",
                "BEFORE UPDATE ON gift_financial_closings WHEN NEW.state = 'confirmed'",
            ),
        ] {
            conn.execute_batch(&format!(
                "CREATE TRIGGER {name} {target} BEGIN SELECT RAISE(ABORT, '{name}'); END;"
            ))
            .expect("install the injected failure");
            let tx = conn
                .unchecked_transaction()
                .expect("begin caller transaction");
            let error = adopt_closing_response(
                &tx,
                CLOSING_KEY,
                Some(&reply(canonical())),
                None,
                adopt_now(),
            )
            .expect_err("the injected failure refuses the adoption");
            assert_eq!(error.code, "CLOSING_STORAGE_FAILED");
            assert!(error.message.contains(name), "{error}");
            // The earlier writes are real and wait inside the caller's still open transaction ...
            assert!(!tx.is_autocommit());
            assert_eq!(
                count(&tx, &format!("SELECT expected_amount_cents FROM cash_drawer_sessions WHERE id = '{DRAWER}'")),
                14_345
            );
            // ... and the caller's rollback leaves both mirrors, the opening and the pending original unchanged.
            tx.rollback().expect("caller rollback");
            assert_eq!(rows(&conn), before, "{name}");
            conn.execute_batch(&format!("DROP TRIGGER {name};"))
                .expect("remove the injected failure");
        }
        let (view, replayed) = adopted(adopt_committed(&conn, Some(&reply(canonical())), None));
        assert!(!replayed);
        assert_eq!(view.expected_cents(), 14_345);
    }

    #[test]
    fn adoption_needs_the_caller_transaction_and_never_commits_it() {
        let conn = conn_with_closed_original(14_000, preview());
        let before = rows(&conn);
        let error = adopt_closing_response(
            &conn,
            CLOSING_KEY,
            Some(&reply(canonical())),
            None,
            adopt_now(),
        )
        .expect_err("autocommit is refused");
        assert_eq!(error.code, "CLOSING_TRANSACTION_REQUIRED");
        assert_eq!(rows(&conn), before);

        let tx = conn
            .unchecked_transaction()
            .expect("begin caller transaction");
        let error = adopt_closing_response(
            &tx,
            OTHER_CLOSING_KEY,
            Some(&reply(canonical())),
            None,
            adopt_now(),
        )
        .expect_err("an unknown original is refused");
        assert_eq!(error.code, "CLOSING_NOT_FOUND");
        let (view, replayed) = adopted(adopt_closing_response(
            &tx,
            CLOSING_KEY,
            Some(&reply(canonical())),
            None,
            adopt_now(),
        ));
        assert!(!replayed);
        // Adoption wrote inside the caller's transaction and left it open ...
        assert!(!tx.is_autocommit());
        assert_eq!(load_adopted(&tx, CLOSING_KEY).unwrap(), Some(view));
        // ... so only the caller decides: its rollback undoes every write.
        tx.rollback().expect("caller rollback");
        assert!(conn.is_autocommit());
        assert_eq!(rows(&conn), before);
        assert_eq!(load_adopted(&conn, CLOSING_KEY).unwrap(), None);
        assert_eq!(
            load_original(&conn, CLOSING_KEY)
                .unwrap()
                .expect("original")
                .state,
            ClosingState::Pending
        );
    }

    #[test]
    fn missing_foreign_open_or_differently_counted_mirror_is_refused() {
        let conn = conn_with_closed_original(14_000, preview());
        let before = rows(&conn);
        for (mutation, expected) in [
            ("UPDATE cash_drawer_sessions SET closed_at = NULL", "CLOSING_MIRROR_OPEN"),
            ("UPDATE staff_shifts SET status = 'active'", "CLOSING_MIRROR_OPEN"),
            ("UPDATE cash_drawer_sessions SET closing_amount_cents = 13999", "CLOSING_MIRROR_COUNT_MISMATCH"),
            ("UPDATE staff_shifts SET closing_cash_amount_cents = 13999", "CLOSING_MIRROR_COUNT_MISMATCH"),
            (
                "UPDATE cash_drawer_sessions SET cashier_id = '8e0c1d2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f'",
                "CLOSING_MIRROR_FOREIGN",
            ),
            (
                "UPDATE staff_shifts SET branch_id = '9fc3e0d1-9c7b-4d84-8a6b-7c8d9eafb0c1'",
                "CLOSING_MIRROR_FOREIGN",
            ),
            ("UPDATE staff_shifts SET terminal_id = 'terminal-other-02'", "CLOSING_MIRROR_FOREIGN"),
            ("UPDATE staff_shifts SET role_type = 'manager'", "CLOSING_MIRROR_FOREIGN"),
            ("DELETE FROM cash_drawer_sessions", "CLOSING_MIRROR_MISSING"),
        ] {
            let tx = conn.unchecked_transaction().expect("begin caller transaction");
            tx.execute_batch(mutation).expect(mutation);
            let error = adopt_closing_response(&tx, CLOSING_KEY, Some(&reply(canonical())), None, adopt_now())
                .expect_err(mutation);
            assert_eq!(error.code, expected, "{mutation}");
            tx.rollback().expect("caller rollback");
            assert_eq!(rows(&conn), before, "{mutation}");
        }
    }
}
