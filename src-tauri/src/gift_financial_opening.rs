//! Windows original gift-card financial opening core (API18 `gift_opening_v1`).
//!
//! One nonsecret local intent and exactly one queued lone `shift_open` event
//! carrying `data.financialOpening` are written in one SQLite transaction. The
//! selected cashier's hosted staff session is volatile native state, injected
//! as `x-staff-session-id` only at dispatch; a restart requires the same
//! cashier to authorize again. The local shift/drawer mirror is published only
//! after the exact Shared18 confirmation has been persisted, and only then is
//! the queue item consumed under its claim fence. Nothing here moves money.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::api::{self, AdminFetchError};
use crate::gift_financial_closing::{self, ClosingOriginal, ClosingState};
use crate::sync_queue::{self, SyncQueueItem};

/// Shared18 `GIFT_CARD_OPENING_CONTRACT`.
pub(crate) const OPENING_CONTRACT: &str = "gift_opening_v1";
/// Shared18 `GIFT_CARD_OPENING_CALCULATION_VERSION`.
pub(crate) const OPENING_CALCULATION_VERSION: i64 = 2;
/// Shared18 `GIFT_CARD_FUNDING_CONTRACT` carried by the strict drawer.
const FUNDING_CONTRACT: &str = "gift_funding_v1";
/// Queue table of the lone financial `shift_open` item. It is deliberately not
/// `staff_shifts`, so neither the ordinary shift batcher nor the generic 2xx
/// success path can see it.
pub(crate) const OPENING_QUEUE_TABLE: &str = "gift_financial_openings";
const OPENING_QUEUE_OPERATION: &str = "INSERT";
const SHIFT_SYNC_PATH: &str = "/api/pos/shifts/sync";
const HOSTED_CHECK_IN_PATH: &str = "/api/pos/staff-auth/check-in";
const MAX_OPENING_CENTS: i64 = 99_999_999;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
/// A hosted session this close to its expiry is treated as expired.
const SESSION_EXPIRY_SKEW_SECS: i64 = 30;
/// Hosted check-in accepts a 4..8 digit PIN and a 1..24 hour session.
const PIN_LENGTH: std::ops::RangeInclusive<usize> = 4..=8;
const HOSTED_SESSION_HOURS: i64 = 8;

pub(crate) const CODE_REAUTH_REQUIRED: &str = "HOSTED_REAUTH_REQUIRED";

/// Local schema v85: the nonsecret original intent and its retained proof.
pub(crate) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS gift_financial_openings (
    opening_key TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    staff_name TEXT,
    shift_id TEXT NOT NULL UNIQUE,
    drawer_id TEXT NOT NULL UNIQUE,
    opening_cents INTEGER NOT NULL
        CHECK (typeof(opening_cents) = 'integer' AND opening_cents BETWEEN 0 AND 99999999),
    currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
    checked_in_at TEXT NOT NULL,
    business_date TEXT NOT NULL,
    period_start_at TEXT NOT NULL,
    is_day_start INTEGER NOT NULL CHECK (is_day_start IN (0, 1)),
    calculation_version INTEGER NOT NULL CHECK (calculation_version = 2),
    queue_item_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'confirmed_usable', 'confirmed_unusable')),
    auth_requirement TEXT,
    last_pending_code TEXT,
    owner_terminal_db_id TEXT,
    source_terminal_db_id TEXT,
    server_usable INTEGER,
    drawer_version INTEGER,
    drawer_acknowledgement_id TEXT,
    drawer_gift_cash_cents INTEGER,
    drawer_ordinary_expected_cents INTEGER,
    drawer_expected_cents INTEGER,
    confirmation_json TEXT,
    confirmed_at TEXT,
    adopted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_financial_openings_pending_terminal
    ON gift_financial_openings(terminal_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_gift_financial_openings_staff
    ON gift_financial_openings(terminal_id, staff_id, state);
";

// ---------------------------------------------------------------------------
// Errors, state and the original intent
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpeningError {
    pub code: &'static str,
    pub message: String,
}

impl OpeningError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn to_value(&self) -> Value {
        json!({ "success": false, "code": self.code, "error": self.message })
    }
}

impl fmt::Display for OpeningError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpeningState {
    Pending,
    ConfirmedUsable,
    ConfirmedUnusable,
}

impl OpeningState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::ConfirmedUsable => "confirmed_usable",
            Self::ConfirmedUnusable => "confirmed_unusable",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "confirmed_usable" => Some(Self::ConfirmedUsable),
            "confirmed_unusable" => Some(Self::ConfirmedUnusable),
            _ => None,
        }
    }
}

/// Trusted native terminal scope (settings/keyring), never renderer input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpeningScope {
    pub organization_id: String,
    pub branch_id: String,
    /// Public terminal identity; never a terminal DB UUID.
    pub terminal_id: String,
}

impl OpeningScope {
    /// The gift checkout's trusted sources (terminal settings, then the
    /// terminal keyring), read the same way without widening its helper.
    pub(crate) fn resolve(conn: &Connection) -> Option<Self> {
        let read = |key: &str| {
            crate::db::get_setting(conn, "terminal", key)
                .or_else(|| crate::storage::get_credential(key))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Some(Self {
            organization_id: read("organization_id")?,
            branch_id: read("branch_id")?,
            terminal_id: read("terminal_id")?,
        })
    }

    fn validate(&self) -> Result<(), OpeningError> {
        if !is_uuid(&self.organization_id)
            || !is_uuid(&self.branch_id)
            || self.terminal_id.trim().is_empty()
            || self.terminal_id.chars().count() > 200
        {
            return Err(OpeningError::new(
                "TERMINAL_SCOPE_UNAVAILABLE",
                "Terminal organization, branch and terminal identity are required",
            ));
        }
        Ok(())
    }

    fn matches(&self, intent: &OpeningIntent) -> bool {
        same_uuid(&self.organization_id, &intent.organization_id)
            && same_uuid(&self.branch_id, &intent.branch_id)
            && self.terminal_id == intent.terminal_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DrawerState {
    pub version: i64,
    pub acknowledgement_id: Option<String>,
    pub gift_cash_cents: i64,
    pub ordinary_expected_cents: i64,
    pub expected_cents: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpeningIntent {
    pub opening_key: String,
    pub organization_id: String,
    pub branch_id: String,
    pub terminal_id: String,
    pub staff_id: String,
    pub staff_name: Option<String>,
    pub shift_id: String,
    pub drawer_id: String,
    pub opening_cents: i64,
    pub currency: String,
    pub checked_in_at: String,
    pub business_date: String,
    pub period_start_at: String,
    pub is_day_start: bool,
    pub calculation_version: i64,
    pub queue_item_id: String,
    pub state: OpeningState,
    pub auth_requirement: Option<String>,
    pub last_pending_code: Option<String>,
    pub owner_terminal_db_id: Option<String>,
    pub source_terminal_db_id: Option<String>,
    pub drawer: Option<DrawerState>,
    pub confirmed_at: Option<String>,
    pub adopted_at: Option<String>,
}

impl OpeningIntent {
    /// The immutable original tuple; renewal/pending/proof columns excluded.
    fn same_original(&self, other: &OpeningIntent) -> bool {
        self.opening_key == other.opening_key
            && self.organization_id == other.organization_id
            && self.branch_id == other.branch_id
            && self.terminal_id == other.terminal_id
            && self.staff_id == other.staff_id
            && self.shift_id == other.shift_id
            && self.drawer_id == other.drawer_id
            && self.opening_cents == other.opening_cents
            && self.currency == other.currency
            && self.checked_in_at == other.checked_in_at
            && self.business_date == other.business_date
            && self.period_start_at == other.period_start_at
            && self.is_day_start == other.is_day_start
            && self.calculation_version == other.calculation_version
            && self.queue_item_id == other.queue_item_id
    }
}

const INTENT_COLUMNS: &str = "opening_key, organization_id, branch_id, terminal_id, staff_id, \
    staff_name, shift_id, drawer_id, opening_cents, currency, checked_in_at, business_date, \
    period_start_at, is_day_start, calculation_version, queue_item_id, state, auth_requirement, \
    last_pending_code, owner_terminal_db_id, source_terminal_db_id, drawer_version, \
    drawer_acknowledgement_id, drawer_gift_cash_cents, drawer_ordinary_expected_cents, \
    drawer_expected_cents, confirmed_at, adopted_at";

fn intent_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OpeningIntent> {
    let state_text: String = row.get(16)?;
    let state = OpeningState::parse(&state_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(16, "state".into(), rusqlite::types::Type::Text)
    })?;
    let drawer_version: Option<i64> = row.get(21)?;
    let gift: Option<i64> = row.get(23)?;
    let ordinary: Option<i64> = row.get(24)?;
    let expected: Option<i64> = row.get(25)?;
    let drawer = match (drawer_version, gift, ordinary, expected) {
        (
            Some(version),
            Some(gift_cash_cents),
            Some(ordinary_expected_cents),
            Some(expected_cents),
        ) => Some(DrawerState {
            version,
            acknowledgement_id: row.get(22)?,
            gift_cash_cents,
            ordinary_expected_cents,
            expected_cents,
        }),
        _ => None,
    };
    Ok(OpeningIntent {
        opening_key: row.get(0)?,
        organization_id: row.get(1)?,
        branch_id: row.get(2)?,
        terminal_id: row.get(3)?,
        staff_id: row.get(4)?,
        staff_name: row.get(5)?,
        shift_id: row.get(6)?,
        drawer_id: row.get(7)?,
        opening_cents: row.get(8)?,
        currency: row.get(9)?,
        checked_in_at: row.get(10)?,
        business_date: row.get(11)?,
        period_start_at: row.get(12)?,
        is_day_start: row.get::<_, i64>(13)? != 0,
        calculation_version: row.get(14)?,
        queue_item_id: row.get(15)?,
        state,
        auth_requirement: row.get(17)?,
        last_pending_code: row.get(18)?,
        owner_terminal_db_id: row.get(19)?,
        source_terminal_db_id: row.get(20)?,
        drawer,
        confirmed_at: row.get(26)?,
        adopted_at: row.get(27)?,
    })
}

pub(crate) fn load_intent(
    conn: &Connection,
    opening_key: &str,
) -> Result<Option<OpeningIntent>, String> {
    conn.query_row(
        &format!("SELECT {INTENT_COLUMNS} FROM gift_financial_openings WHERE opening_key = ?1"),
        params![opening_key],
        intent_from_row,
    )
    .optional()
    .map_err(|e| format!("load financial opening: {e}"))
}

/// The original mirror of journal row `o` is open: its original shift is
/// active and its linked original drawer open, both carrying the original
/// cashier, branch and public terminal. Owner/source DB pins stay in the
/// journal; the Windows mirrors have no owner columns.
const ORIGINAL_MIRROR_OPEN: &str = "EXISTS (
        SELECT 1 FROM staff_shifts s
        JOIN cash_drawer_sessions d ON d.id = o.drawer_id AND d.staff_shift_id = s.id
        WHERE s.id = o.shift_id
          AND s.status = 'active'
          AND s.role_type = 'cashier'
          AND lower(s.staff_id) = lower(o.staff_id)
          AND lower(s.branch_id) = lower(o.branch_id)
          AND s.terminal_id = o.terminal_id
          AND d.closed_at IS NULL
          AND lower(d.cashier_id) = lower(o.staff_id)
          AND lower(d.branch_id) = lower(o.branch_id)
          AND d.terminal_id = o.terminal_id
    )
    AND (SELECT COUNT(*) FROM cash_drawer_sessions c WHERE c.staff_shift_id = o.shift_id) = 1";

fn original_mirror_open(conn: &Connection, opening_key: &str) -> Result<bool, String> {
    conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM gift_financial_openings o
                            WHERE o.opening_key = ?1 AND {ORIGINAL_MIRROR_OPEN})"
        ),
        params![opening_key],
        |row| row.get(0),
    )
    .map_err(|e| format!("read financial opening mirror: {e}"))
}

/// Current usability: a confirmed usable original of the current trusted full
/// scope whose original mirror is still open. A stored confirmation alone, a
/// local read failure or a closed/missing/inconsistent mirror is unusable.
fn currently_usable(conn: &Connection, scope: &OpeningScope, intent: &OpeningIntent) -> bool {
    intent.state == OpeningState::ConfirmedUsable
        && scope.matches(intent)
        && original_mirror_open(conn, &intent.opening_key).unwrap_or(false)
}

/// Pending or currently usable originals of the current trusted full scope;
/// the same public terminal id under another org/branch never matches.
fn load_open_intents_for_scope(
    conn: &Connection,
    scope: &OpeningScope,
) -> Result<Vec<OpeningIntent>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {INTENT_COLUMNS} FROM gift_financial_openings o
             WHERE lower(o.organization_id) = lower(?1) AND lower(o.branch_id) = lower(?2)
               AND o.terminal_id = ?3
               AND (o.state = 'pending'
                    OR (o.state = 'confirmed_usable' AND {ORIGINAL_MIRROR_OPEN}))
             ORDER BY o.created_at DESC, o.rowid DESC LIMIT 10"
        ))
        .map_err(|e| format!("prepare financial openings: {e}"))?;
    let rows = stmt
        .query_map(
            params![scope.organization_id, scope.branch_id, scope.terminal_id],
            intent_from_row,
        )
        .map_err(|e| format!("query financial openings: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read financial openings: {e}"))
}

// ---------------------------------------------------------------------------
// Prepare: one intent + one exact queue item in one transaction
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PrepareRequest {
    pub opening_key: Option<String>,
    pub staff_id: String,
    pub staff_name: Option<String>,
    pub opening_cents: i64,
    pub currency: String,
}

impl PrepareRequest {
    /// Parses the renderer request. A `pin`, if present, is ignored here and
    /// never copied into the request.
    pub(crate) fn from_value(value: &Value) -> Result<Self, OpeningError> {
        let invalid = |code: &'static str, message: &str| OpeningError::new(code, message);
        let obj = value
            .as_object()
            .ok_or_else(|| invalid("INVALID_REQUEST", "Opening request must be an object"))?;
        let opening_key = match obj.get("openingKey") {
            None | Some(Value::Null) => None,
            Some(Value::String(key)) => Some(key.trim().to_ascii_lowercase()),
            Some(_) => return Err(invalid("INVALID_OPENING_KEY", "openingKey must be a UUID")),
        };
        let staff_id = obj
            .get("staffId")
            .and_then(Value::as_str)
            .map(|id| id.trim().to_ascii_lowercase())
            .ok_or_else(|| invalid("INVALID_STAFF", "staffId is required"))?;
        let staff_name = obj
            .get("staffName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string);
        // Integer cents only: a float, string or out-of-range number refuses.
        let opening_cents = obj
            .get("openingCents")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                invalid(
                    "INVALID_OPENING_CENTS",
                    "openingCents must be integer cents",
                )
            })?;
        let currency = obj
            .get("currency")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("INVALID_CURRENCY", "currency is required"))?
            .to_string();
        let request = Self {
            opening_key,
            staff_id,
            staff_name,
            opening_cents,
            currency,
        };
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), OpeningError> {
        if self.opening_key.as_deref().is_some_and(|key| !is_uuid(key)) {
            return Err(OpeningError::new(
                "INVALID_OPENING_KEY",
                "openingKey must be a UUID",
            ));
        }
        if !is_uuid(&self.staff_id) {
            return Err(OpeningError::new(
                "INVALID_STAFF",
                "staffId must be the hosted staff UUID",
            ));
        }
        if !(0..=MAX_OPENING_CENTS).contains(&self.opening_cents) {
            return Err(OpeningError::new(
                "INVALID_OPENING_CENTS",
                "openingCents must be between 0 and 99999999",
            ));
        }
        if !is_currency(&self.currency) {
            return Err(OpeningError::new(
                "INVALID_CURRENCY",
                "currency must be an uppercase ISO 4217 code",
            ));
        }
        Ok(())
    }

    fn matches(&self, intent: &OpeningIntent, scope: &OpeningScope) -> bool {
        scope.matches(intent)
            && same_uuid(&self.staff_id, &intent.staff_id)
            && self.opening_cents == intent.opening_cents
            && self.currency == intent.currency
    }
}

fn local_error(error: impl fmt::Display) -> OpeningError {
    OpeningError::new("LOCAL_WRITE_FAILED", error.to_string())
}

/// Refuses a new original while this terminal has an unresolved one or the
/// cashier already has an active local shift.
fn check_new_opening_allowed(
    conn: &Connection,
    scope: &OpeningScope,
    staff_id: &str,
) -> Result<(), OpeningError> {
    let pending: Option<String> = conn
        .query_row(
            "SELECT opening_key FROM gift_financial_openings
             WHERE terminal_id = ?1 AND state = 'pending' LIMIT 1",
            params![scope.terminal_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(local_error)?;
    if let Some(key) = pending {
        return Err(OpeningError::new(
            "OPENING_ALREADY_PENDING",
            format!("Financial opening {key} is still awaiting confirmation"),
        ));
    }
    let active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM staff_shifts WHERE lower(staff_id) = lower(?1) AND status = 'active'",
            params![staff_id],
            |row| row.get(0),
        )
        .map_err(local_error)?;
    if active > 0 {
        return Err(OpeningError::new(
            "ACTIVE_LOCAL_SHIFT_EXISTS",
            "The selected cashier already has an active shift",
        ));
    }
    Ok(())
}

fn local_identity_exists(
    conn: &Connection,
    opening_key: &str,
    shift_id: &str,
    drawer_id: &str,
) -> Result<bool, OpeningError> {
    let count: i64 = conn
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM gift_financial_openings
                  WHERE opening_key = ?1 OR shift_id = ?2 OR drawer_id = ?3)
              + (SELECT COUNT(*) FROM staff_shifts WHERE id = ?2)
              + (SELECT COUNT(*) FROM cash_drawer_sessions WHERE id = ?3 OR staff_shift_id = ?2)
              + (SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = ?4 AND record_id = ?1)",
            params![opening_key, shift_id, drawer_id, OPENING_QUEUE_TABLE],
            |row| row.get(0),
        )
        .map_err(local_error)?;
    Ok(count > 0)
}

/// Mirrors the ordinary cashier-first rule (private
/// `shifts::resolve_check_in_eligibility`): a cashier opening starts the day
/// when no cashier shift of this branch/terminal checked in since the
/// business-day start. Captured once at prepare; retries never recalculate.
fn resolve_is_day_start(
    conn: &Connection,
    scope: &OpeningScope,
    period_start_at: &str,
) -> Result<bool, OpeningError> {
    let has_cashier: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM staff_shifts
                 WHERE role_type = 'cashier'
                   AND (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
                   AND (?2 = '' OR terminal_id = ?2 OR terminal_id IS NULL)
                   AND check_in_time >= ?3
            )",
            params![scope.branch_id, scope.terminal_id, period_start_at],
            |row| row.get(0),
        )
        .map_err(local_error)?;
    Ok(!has_cashier)
}

/// Retains the original intent and its exact lone queue item atomically.
/// Returns `(intent, created)`; a same-key same-tuple replay returns the
/// existing original without writing.
pub(crate) fn prepare_opening(
    conn: &Connection,
    scope: &OpeningScope,
    request: &PrepareRequest,
    now: DateTime<Utc>,
) -> Result<(OpeningIntent, bool), OpeningError> {
    scope.validate()?;
    request.validate()?;
    conn.execute_batch("BEGIN IMMEDIATE").map_err(local_error)?;
    match prepare_in_transaction(conn, scope, request, now) {
        Ok((intent, true)) => {
            if let Err(error) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(local_error(error));
            }
            Ok((intent, true))
        }
        other => {
            let _ = conn.execute_batch("ROLLBACK");
            other
        }
    }
}

fn prepare_in_transaction(
    conn: &Connection,
    scope: &OpeningScope,
    request: &PrepareRequest,
    now: DateTime<Utc>,
) -> Result<(OpeningIntent, bool), OpeningError> {
    if let Some(key) = request.opening_key.as_deref() {
        if let Some(existing) = load_intent(conn, key).map_err(local_error)? {
            if !request.matches(&existing, scope) {
                return Err(OpeningError::new(
                    "OPENING_KEY_TUPLE_MISMATCH",
                    "This opening key belongs to a different original opening",
                ));
            }
            return Ok((existing, false));
        }
    }
    check_new_opening_allowed(conn, scope, &request.staff_id)?;

    let opening_key = request
        .opening_key
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let shift_id = Uuid::new_v4().to_string();
    let drawer_id = Uuid::new_v4().to_string();
    if local_identity_exists(conn, &opening_key, &shift_id, &drawer_id)? {
        return Err(OpeningError::new(
            "LOCAL_ID_COLLISION",
            "A local row already uses this opening identity",
        ));
    }

    let checked_in_at = normalize_instant(now);
    let day = crate::shifts::resolve_shift_business_day_context(
        conn,
        &scope.branch_id,
        &checked_in_at,
        None,
        None,
    );
    if !is_calendar_date(&day.report_date) || day.period_start_at.trim().is_empty() {
        return Err(OpeningError::new(
            "BUSINESS_DAY_UNRESOLVED",
            "The business day of this opening could not be resolved",
        ));
    }
    let is_day_start = resolve_is_day_start(conn, scope, &day.period_start_at)?;

    let mut intent = OpeningIntent {
        opening_key: opening_key.clone(),
        organization_id: scope.organization_id.clone(),
        branch_id: scope.branch_id.clone(),
        terminal_id: scope.terminal_id.clone(),
        staff_id: request.staff_id.clone(),
        staff_name: request.staff_name.clone(),
        shift_id,
        drawer_id,
        opening_cents: request.opening_cents,
        currency: request.currency.clone(),
        checked_in_at,
        business_date: day.report_date,
        period_start_at: day.period_start_at,
        is_day_start,
        calculation_version: OPENING_CALCULATION_VERSION,
        queue_item_id: String::new(),
        state: OpeningState::Pending,
        auth_requirement: Some(CODE_REAUTH_REQUIRED.to_string()),
        last_pending_code: None,
        owner_terminal_db_id: None,
        source_terminal_db_id: None,
        drawer: None,
        confirmed_at: None,
        adopted_at: None,
    };
    let body = build_sync_body(&intent);
    intent.queue_item_id = sync_queue::enqueue_payload_item(
        conn,
        OPENING_QUEUE_TABLE,
        &opening_key,
        OPENING_QUEUE_OPERATION,
        &body,
        Some(1),
        Some("shifts"),
        Some("manual"),
        Some(1),
    )
    .map_err(local_error)?;

    let created_at = normalize_instant(now);
    conn.execute(
        "INSERT INTO gift_financial_openings (
            opening_key, organization_id, branch_id, terminal_id, staff_id, staff_name,
            shift_id, drawer_id, opening_cents, currency, checked_in_at, business_date,
            period_start_at, is_day_start, calculation_version, queue_item_id, state,
            auth_requirement, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                  'pending', ?17, ?18, ?18)",
        params![
            intent.opening_key,
            intent.organization_id,
            intent.branch_id,
            intent.terminal_id,
            intent.staff_id,
            intent.staff_name,
            intent.shift_id,
            intent.drawer_id,
            intent.opening_cents,
            intent.currency,
            intent.checked_in_at,
            intent.business_date,
            intent.period_start_at,
            intent.is_day_start,
            intent.calculation_version,
            intent.queue_item_id,
            intent.auth_requirement,
            created_at,
        ],
    )
    .map_err(local_error)?;
    Ok((intent, true))
}

/// The one original lone `shift_open` event. Money/time/date/day-start
/// aliases all agree with the marker; the staff session is never in the body.
pub(crate) fn build_sync_body(intent: &OpeningIntent) -> Value {
    let mut data = json!({
        "financialOpening": {
            "drawerId": intent.drawer_id,
            "openingCents": intent.opening_cents,
            "currency": intent.currency,
        },
        "staffId": intent.staff_id,
        "roleType": "cashier",
        "branchId": intent.branch_id,
        "terminalId": intent.terminal_id,
        "checkInTime": intent.checked_in_at,
        "reportDate": intent.business_date,
        "periodStartAt": intent.period_start_at,
        "isDayStart": intent.is_day_start,
        "openingCash": intent.opening_cents as f64 / 100.0,
        "opening_cash_cents": intent.opening_cents,
        "calculationVersion": intent.calculation_version,
    });
    if let Some(name) = intent.staff_name.as_deref() {
        data["staffName"] = json!(name);
    }
    json!({
        "terminal_id": intent.terminal_id,
        "branch_id": intent.branch_id,
        "events": [{
            "event_type": "shift_open",
            "shift_id": intent.shift_id,
            "idempotency_key": intent.opening_key,
            "data": data,
        }],
    })
}

// ---------------------------------------------------------------------------
// Volatile hosted cashier authorization
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct HostedCashierSession {
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    staff_id: String,
    session_id: String,
    expires_at: DateTime<Utc>,
}

impl fmt::Debug for HostedCashierSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostedCashierSession")
            .field("staff_id", &self.staff_id)
            .field("terminal_id", &self.terminal_id)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl HostedCashierSession {
    fn live(&self, now: DateTime<Utc>) -> bool {
        self.expires_at - chrono::Duration::seconds(SESSION_EXPIRY_SKEW_SECS) > now
    }

    fn authorizes(&self, intent: &OpeningIntent) -> bool {
        same_uuid(&self.staff_id, &intent.staff_id)
            && same_uuid(&self.organization_id, &intent.organization_id)
            && same_uuid(&self.branch_id, &intent.branch_id)
            && self.terminal_id == intent.terminal_id
    }

    fn issued_for(&self, scope: &OpeningScope, staff_id: &str) -> bool {
        same_uuid(&self.staff_id, staff_id)
            && same_uuid(&self.organization_id, &scope.organization_id)
            && same_uuid(&self.branch_id, &scope.branch_id)
            && self.terminal_id == scope.terminal_id
    }
}

/// The volatile dedicated hosted-cashier credentials and their issuance
/// fences, under one lock. Never persisted, logged or returned; the main
/// local login is separate and untouched.
#[derive(Default)]
struct HostedAuthState {
    /// Monotonic issuance generation, advanced when an issuer starts.
    generation: u64,
    /// Issuances at or below this generation predate the last dedicated clear.
    cleared_through: u64,
    /// Per original: issuances at or below this generation predate its last
    /// invalidation.
    revoked_through: HashMap<String, u64>,
    sessions: HashMap<String, InstalledSession>,
}

struct InstalledSession {
    generation: u64,
    session: HostedCashierSession,
}

/// Generation an issuer captured before its hosted HTTP await.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IssuanceFence {
    generation: u64,
}

impl HostedAuthState {
    /// True while no dedicated clear, no invalidation of `opening_key` and no
    /// newer installed issuance for it happened since `fence` was captured.
    fn admits(&self, fence: IssuanceFence, opening_key: Option<&str>) -> bool {
        fence.generation > self.cleared_through
            && opening_key.map_or(true, |key| {
                fence.generation > self.revoked_through.get(key).copied().unwrap_or(0)
                    && self
                        .sessions
                        .get(key)
                        .map_or(true, |installed| installed.generation < fence.generation)
            })
    }
}

fn hosted_auth() -> MutexGuard<'static, HostedAuthState> {
    static STATE: OnceLock<Mutex<HostedAuthState>> = OnceLock::new();
    STATE
        .get_or_init(|| Mutex::new(HostedAuthState::default()))
        .lock()
        // Every update is a single insert/remove, so a poisoned lock still
        // holds a consistent state; recovering it keeps revocation effective.
        .unwrap_or_else(PoisonError::into_inner)
}

fn capture_issuance_fence() -> IssuanceFence {
    let mut auth = hosted_auth();
    auth.generation += 1;
    IssuanceFence {
        generation: auth.generation,
    }
}

fn hosted_session(opening_key: &str) -> Option<HostedCashierSession> {
    hosted_auth()
        .sessions
        .get(opening_key)
        .map(|installed| installed.session.clone())
}

/// Drops this exact stale (expired or non-matching) session. It fences
/// nothing, so a newer in-flight same-cashier renewal can still install.
fn drop_stale_session(opening_key: &str, stale: &HostedCashierSession) {
    let mut auth = hosted_auth();
    if auth
        .sessions
        .get(opening_key)
        .is_some_and(|installed| installed.session.session_id == stale.session_id)
    {
        auth.sessions.remove(opening_key);
    }
}

/// Revokes the volatile hosted authorization of one original opening and
/// fences every issuance for it that is still awaiting its hosted reply.
pub(crate) fn invalidate_hosted_cashier(opening_key: &str) {
    let mut auth = hosted_auth();
    auth.sessions.remove(opening_key);
    let generation = auth.generation;
    auth.revoked_through
        .insert(opening_key.to_string(), generation);
}

/// Dedicated lifecycle clear (e.g. logout): drops every hosted cashier
/// credential and fences every in-flight issuance, including a first one
/// whose opening key does not exist yet. Durable originals, their queue items
/// and the main local login are untouched.
fn clear_hosted_cashier_authorizations() {
    let mut auth = hosted_auth();
    auth.sessions.clear();
    auth.revoked_through.clear();
    let generation = auth.generation;
    auth.cleared_through = generation;
}

/// The hosted check-in request: terminal-auth + selected cashier + transient
/// PIN only. It carries no opening identity and creates no shift or drawer.
fn build_check_in_body(staff_id: &str, pin: String) -> Value {
    json!({ "staffId": staff_id, "pin": pin, "sessionHours": HOSTED_SESSION_HOURS })
}

/// Validates an issued hosted staff session against the immutable original
/// cashier and trusted scope. `role_name` never substitutes for the
/// operational `role_type`.
fn validate_check_in_response(
    body: &Value,
    scope: &OpeningScope,
    staff_id: &str,
    now: DateTime<Utc>,
) -> Result<HostedCashierSession, &'static str> {
    let outer = body.as_object().ok_or("HOSTED_CHECK_IN_MALFORMED")?;
    if outer.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("HOSTED_CHECK_IN_REFUSED");
    }
    let session_id = str_field(outer, "session_id")
        .filter(|id| is_uuid(id))
        .ok_or("HOSTED_CHECK_IN_MALFORMED")?;
    let session = outer
        .get("session")
        .and_then(Value::as_object)
        .ok_or("HOSTED_CHECK_IN_MALFORMED")?;
    if !str_field(session, "id").is_some_and(|id| same_uuid(id, session_id)) {
        return Err("HOSTED_SESSION_MISMATCH");
    }
    for candidate in [str_field(outer, "staff_id"), str_field(session, "staff_id")] {
        if !candidate.is_some_and(|id| same_uuid(id, staff_id)) {
            return Err("HOSTED_STAFF_MISMATCH");
        }
    }
    for (obj, key, expected) in [
        (outer, "organization_id", &scope.organization_id),
        (session, "organization_id", &scope.organization_id),
        (outer, "branch_id", &scope.branch_id),
        (session, "branch_id", &scope.branch_id),
    ] {
        if !str_field(obj, key).is_some_and(|id| same_uuid(id, expected)) {
            return Err("HOSTED_SCOPE_MISMATCH");
        }
    }
    if str_field(session, "terminal_id") != Some(scope.terminal_id.as_str()) {
        return Err("HOSTED_SCOPE_MISMATCH");
    }
    let expires_at = str_field(session, "expires_at")
        .and_then(parse_instant)
        .ok_or("HOSTED_CHECK_IN_MALFORMED")?;
    // `role_name`/`staff.role` are permission data, never the operational
    // role: the original is always a `cashier` opening, which API18 proves.
    let issued = HostedCashierSession {
        organization_id: scope.organization_id.clone(),
        branch_id: scope.branch_id.clone(),
        terminal_id: scope.terminal_id.clone(),
        staff_id: staff_id.to_string(),
        session_id: session_id.to_ascii_lowercase(),
        expires_at,
    };
    if !issued.live(now) {
        return Err("HOSTED_SESSION_EXPIRED");
    }
    Ok(issued)
}

async fn issue_hosted_session(
    db: &crate::db::DbState,
    scope: &OpeningScope,
    staff_id: &str,
    pin: String,
) -> Result<HostedCashierSession, OpeningError> {
    let (url, api_key) = crate::resolve_admin_endpoint(Some(db))
        .await
        .map_err(|_| not_configured())?;
    let response = api::fetch_from_admin_detailed_with_staff_session(
        &url,
        &api_key,
        HOSTED_CHECK_IN_PATH,
        "POST",
        Some(build_check_in_body(staff_id, pin)),
        None,
        HTTP_TIMEOUT,
    )
    .await;
    match response {
        Ok(body) => {
            validate_check_in_response(&body, scope, staff_id, Utc::now()).map_err(|code| {
                OpeningError::new(code, "Hosted cashier authorization was not accepted")
            })
        }
        Err(error) => Err(OpeningError::new(
            if matches!(error.status(), Some(400..=499)) {
                "HOSTED_CHECK_IN_REFUSED"
            } else {
                "HOSTED_CHECK_IN_UNCONFIRMED"
            },
            "Hosted cashier authorization could not be confirmed",
        )),
    }
}

// ---------------------------------------------------------------------------
// Shared18 HTTP envelope parser
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpeningConfirmation {
    pub replayed: bool,
    pub usable: bool,
    pub owner_terminal_db_id: String,
    pub source_terminal_db_id: String,
    pub drawer: DrawerState,
    /// Canonical nonsecret transport retained as proof.
    pub proof: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ParsedOpening {
    Confirmed(OpeningConfirmation),
    Pending { code: String },
}

const PENDING_KEYS: [&str; 6] = [
    "contract",
    "opening_key",
    "shift_id",
    "drawer_id",
    "state",
    "code",
];
const CONFIRMED_KEYS: [&str; 21] = [
    "contract",
    "opening_key",
    "shift_id",
    "drawer_id",
    "state",
    "replayed",
    "usable",
    "organization_id",
    "branch_id",
    "owner_terminal_id",
    "source_terminal_id",
    "terminal_id",
    "staff_id",
    "role_type",
    "opening_cents",
    "currency",
    "business_date",
    "checked_in_at",
    "is_day_start",
    "calculation_version",
    "drawer",
];
const DRAWER_KEYS: [&str; 10] = [
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

/// Parses the per-event `results[0].financial_opening` of the lone event.
/// Top-level success, a result status or a strict drawer alone never prove
/// the opening; HTTP 207/`success: false` never confirms.
pub(crate) fn parse_sync_response(
    body: &Value,
    intent: &OpeningIntent,
) -> Result<ParsedOpening, &'static str> {
    let envelope = body.as_object().ok_or("MALFORMED_RESPONSE")?;
    let results = envelope
        .get("results")
        .and_then(Value::as_array)
        .ok_or("MALFORMED_RESPONSE")?;
    if results.len() != 1 {
        return Err("MALFORMED_RESPONSE");
    }
    let result = results[0].as_object().ok_or("MALFORMED_RESPONSE")?;
    if !str_field(result, "shift_id").is_some_and(|id| same_uuid(id, &intent.shift_id)) {
        return Err("FOREIGN_RESULT");
    }
    let transport = result
        .get("financial_opening")
        .and_then(Value::as_object)
        .ok_or("FINANCIAL_OPENING_ABSENT")?;
    if str_field(transport, "contract") != Some(OPENING_CONTRACT)
        || str_field(transport, "opening_key") != Some(intent.opening_key.as_str())
        || !str_field(transport, "shift_id").is_some_and(|id| same_uuid(id, &intent.shift_id))
        || !str_field(transport, "drawer_id").is_some_and(|id| same_uuid(id, &intent.drawer_id))
    {
        return Err("FOREIGN_CONFIRMATION");
    }
    match str_field(transport, "state") {
        Some("pending") => {
            if !exact_keys(transport, &PENDING_KEYS) {
                return Err("MALFORMED_CONFIRMATION");
            }
            let code = str_field(transport, "code")
                .filter(|code| is_pending_code(code))
                .ok_or("MALFORMED_CONFIRMATION")?;
            Ok(ParsedOpening::Pending {
                code: code.to_string(),
            })
        }
        Some("confirmed") => {
            if envelope.get("success") != Some(&Value::Bool(true))
                || str_field(result, "status") == Some("error")
            {
                return Err("UNCONFIRMED_ENVELOPE");
            }
            parse_confirmation(transport, intent).map(ParsedOpening::Confirmed)
        }
        _ => Err("MALFORMED_CONFIRMATION"),
    }
}

fn parse_confirmation(
    t: &Map<String, Value>,
    intent: &OpeningIntent,
) -> Result<OpeningConfirmation, &'static str> {
    const MALFORMED: &str = "MALFORMED_CONFIRMATION";
    if !exact_keys(t, &CONFIRMED_KEYS) {
        return Err(MALFORMED);
    }
    let replayed = t
        .get("replayed")
        .and_then(Value::as_bool)
        .ok_or(MALFORMED)?;
    let usable = t.get("usable").and_then(Value::as_bool).ok_or(MALFORMED)?;
    let owner = str_field(t, "owner_terminal_id")
        .filter(|id| is_uuid(id))
        .ok_or(MALFORMED)?;
    let source = str_field(t, "source_terminal_id")
        .filter(|id| is_uuid(id))
        .ok_or(MALFORMED)?;
    let terminal = str_field(t, "terminal_id")
        .filter(|id| !id.is_empty() && id.chars().count() <= 200)
        .ok_or(MALFORMED)?;
    let cents = bounded_int(t.get("opening_cents"), 0, MAX_OPENING_CENTS).ok_or(MALFORMED)?;
    let currency = str_field(t, "currency")
        .filter(|c| is_currency(c))
        .ok_or(MALFORMED)?;
    let business_date = str_field(t, "business_date")
        .filter(|d| is_calendar_date(d))
        .ok_or(MALFORMED)?;
    let checked_in_at = str_field(t, "checked_in_at")
        .and_then(parse_instant)
        .ok_or(MALFORMED)?;
    let is_day_start = t
        .get("is_day_start")
        .and_then(Value::as_bool)
        .ok_or(MALFORMED)?;
    if str_field(t, "role_type") != Some("cashier")
        || t.get("calculation_version").and_then(Value::as_i64) != Some(OPENING_CALCULATION_VERSION)
    {
        return Err(MALFORMED);
    }
    for key in ["organization_id", "branch_id", "staff_id"] {
        if !str_field(t, key).is_some_and(|id| is_uuid(id)) {
            return Err(MALFORMED);
        }
    }
    let drawer = t
        .get("drawer")
        .and_then(Value::as_object)
        .ok_or("MALFORMED_DRAWER")?;
    let drawer = parse_drawer(drawer, intent, owner, currency)?;

    if !str_field(t, "organization_id").is_some_and(|id| same_uuid(id, &intent.organization_id))
        || !str_field(t, "branch_id").is_some_and(|id| same_uuid(id, &intent.branch_id))
        || !str_field(t, "staff_id").is_some_and(|id| same_uuid(id, &intent.staff_id))
        || terminal != intent.terminal_id
        || cents != intent.opening_cents
        || currency != intent.currency
        || business_date != intent.business_date
        || parse_instant(&intent.checked_in_at) != Some(checked_in_at)
        || is_day_start != intent.is_day_start
    {
        return Err("CONFIRMATION_TUPLE_MISMATCH");
    }
    // Owner/source DB UUIDs are pinned by the first valid confirmation.
    if intent
        .owner_terminal_db_id
        .as_deref()
        .is_some_and(|pin| !same_uuid(pin, owner))
        || intent
            .source_terminal_db_id
            .as_deref()
            .is_some_and(|pin| !same_uuid(pin, source))
    {
        return Err("FOREIGN_CONFIRMATION");
    }
    Ok(OpeningConfirmation {
        replayed,
        usable,
        owner_terminal_db_id: owner.to_ascii_lowercase(),
        source_terminal_db_id: source.to_ascii_lowercase(),
        drawer,
        proof: Value::Object(t.clone()),
    })
}

fn parse_drawer(
    d: &Map<String, Value>,
    intent: &OpeningIntent,
    owner: &str,
    currency: &str,
) -> Result<DrawerState, &'static str> {
    const MALFORMED: &str = "MALFORMED_DRAWER";
    if !exact_keys(d, &DRAWER_KEYS) || str_field(d, "contract") != Some(FUNDING_CONTRACT) {
        return Err(MALFORMED);
    }
    if !str_field(d, "drawer_id").is_some_and(|id| same_uuid(id, &intent.drawer_id))
        || !str_field(d, "shift_id").is_some_and(|id| same_uuid(id, &intent.shift_id))
        || !str_field(d, "owner_terminal_id").is_some_and(|id| same_uuid(id, owner))
        || str_field(d, "currency") != Some(currency)
    {
        return Err("DRAWER_IDENTITY_MISMATCH");
    }
    let gift_cash_cents =
        bounded_int(d.get("gift_cash_cents"), 0, MAX_SAFE_INTEGER).ok_or(MALFORMED)?;
    let ordinary_expected_cents = bounded_int(
        d.get("ordinary_expected_cents"),
        -MAX_SAFE_INTEGER,
        MAX_SAFE_INTEGER,
    )
    .ok_or(MALFORMED)?;
    let expected_cents = bounded_int(d.get("expected_cents"), -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
        .ok_or(MALFORMED)?;
    let version = bounded_int(d.get("version"), 0, MAX_SAFE_INTEGER).ok_or(MALFORMED)?;
    let acknowledgement_id = match d.get("acknowledgement_id") {
        Some(Value::Null) => None,
        Some(Value::String(id)) if is_uuid(id) => Some(id.to_ascii_lowercase()),
        _ => return Err(MALFORMED),
    };
    if ordinary_expected_cents.checked_add(gift_cash_cents) != Some(expected_cents)
        || (gift_cash_cents > 0 && (acknowledgement_id.is_none() || version < 1))
    {
        return Err("DRAWER_NOT_CONSERVED");
    }
    Ok(DrawerState {
        version,
        acknowledgement_id,
        gift_cash_cents,
        ordinary_expected_cents,
        expected_cents,
    })
}

// ---------------------------------------------------------------------------
// Confirmation persistence and local mirror adoption
// ---------------------------------------------------------------------------

/// Persists the confirmation and adopts the original local mirror in one
/// transaction, before any queue consumption. Idempotent on replay: no second
/// shift/drawer, no double-add, no reopening of an unusable original.
fn persist_confirmation(
    conn: &Connection,
    intent: &OpeningIntent,
    confirmation: &OpeningConfirmation,
    now: DateTime<Utc>,
) -> Result<OpeningState, &'static str> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|error| {
        warn!("financial opening persist begin failed: {error}");
        "LOCAL_WRITE_FAILED"
    })?;
    match persist_in_transaction(conn, intent, confirmation, now) {
        Ok(state) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(state),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                warn!("financial opening persist commit failed: {error}");
                Err("LOCAL_WRITE_FAILED")
            }
        },
        Err(code) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(code)
        }
    }
}

fn persist_in_transaction(
    conn: &Connection,
    intent: &OpeningIntent,
    confirmation: &OpeningConfirmation,
    now: DateTime<Utc>,
) -> Result<OpeningState, &'static str> {
    let current = load_intent(conn, &intent.opening_key)
        .map_err(|_| "LOCAL_WRITE_FAILED")?
        .ok_or("OPENING_INTENT_MISSING")?;
    if !current.same_original(intent) {
        return Err("OPENING_TUPLE_CHANGED");
    }
    if current
        .owner_terminal_db_id
        .as_deref()
        .is_some_and(|pin| !same_uuid(pin, &confirmation.owner_terminal_db_id))
        || current
            .source_terminal_db_id
            .as_deref()
            .is_some_and(|pin| !same_uuid(pin, &confirmation.source_terminal_db_id))
    {
        return Err("FOREIGN_CONFIRMATION");
    }
    let next_state = match (current.state, confirmation.usable) {
        (OpeningState::Pending, true) => OpeningState::ConfirmedUsable,
        (OpeningState::Pending, false) => OpeningState::ConfirmedUnusable,
        // A strict later canonical `usable: false` permanently demotes a
        // usable original; nothing ever promotes, reopens or re-adopts one.
        (OpeningState::ConfirmedUsable, false) => OpeningState::ConfirmedUnusable,
        (settled, _) => settled,
    };
    // An unusable original never imports drawer state from a usable proof.
    let import_drawer = !(current.state == OpeningState::ConfirmedUnusable && confirmation.usable);
    let adopt =
        current.state == OpeningState::Pending && next_state == OpeningState::ConfirmedUsable;
    let now_text = normalize_instant(now);
    if adopt {
        adopt_local_mirror(conn, &current, &now_text)?;
    }
    let proof = confirmation.proof.to_string();
    conn.execute(
        "UPDATE gift_financial_openings SET
            state = ?2,
            owner_terminal_db_id = COALESCE(owner_terminal_db_id, ?3),
            source_terminal_db_id = COALESCE(source_terminal_db_id, ?4),
            server_usable = CASE WHEN ?2 = 'confirmed_unusable' THEN 0
                ELSE COALESCE(server_usable, ?5) END,
            drawer_acknowledgement_id = CASE WHEN ?14 AND (drawer_version IS NULL OR drawer_version <= ?6)
                THEN ?7 ELSE drawer_acknowledgement_id END,
            drawer_gift_cash_cents = CASE WHEN ?14 AND (drawer_version IS NULL OR drawer_version <= ?6)
                THEN ?8 ELSE drawer_gift_cash_cents END,
            drawer_ordinary_expected_cents = CASE WHEN ?14 AND (drawer_version IS NULL OR drawer_version <= ?6)
                THEN ?9 ELSE drawer_ordinary_expected_cents END,
            drawer_expected_cents = CASE WHEN ?14 AND (drawer_version IS NULL OR drawer_version <= ?6)
                THEN ?10 ELSE drawer_expected_cents END,
            drawer_version = CASE WHEN ?14 AND (drawer_version IS NULL OR drawer_version <= ?6)
                THEN ?6 ELSE drawer_version END,
            confirmation_json = COALESCE(confirmation_json, ?11),
            confirmed_at = COALESCE(confirmed_at, ?12),
            adopted_at = CASE WHEN ?13 THEN ?12 ELSE adopted_at END,
            last_pending_code = NULL,
            updated_at = ?12
         WHERE opening_key = ?1",
        params![
            current.opening_key,
            next_state.as_str(),
            confirmation.owner_terminal_db_id,
            confirmation.source_terminal_db_id,
            confirmation.usable,
            confirmation.drawer.version,
            confirmation.drawer.acknowledgement_id,
            confirmation.drawer.gift_cash_cents,
            confirmation.drawer.ordinary_expected_cents,
            confirmation.drawer.expected_cents,
            proof,
            now_text,
            adopt,
            import_drawer,
        ],
    )
    .map_err(|error| {
        warn!("financial opening persist failed: {error}");
        "LOCAL_WRITE_FAILED"
    })?;
    Ok(next_state)
}

/// Publishes the usable original shift/drawer with the original identities.
/// Any pre-existing (historic/contextless) row with these identities refuses.
fn adopt_local_mirror(
    conn: &Connection,
    intent: &OpeningIntent,
    now: &str,
) -> Result<(), &'static str> {
    let collisions: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM staff_shifts WHERE id = ?1)
                  + (SELECT COUNT(*) FROM cash_drawer_sessions WHERE id = ?2 OR staff_shift_id = ?1)",
            params![intent.shift_id, intent.drawer_id],
            |row| row.get(0),
        )
        .map_err(|_| "LOCAL_WRITE_FAILED")?;
    if collisions > 0 {
        return Err("LOCAL_ID_COLLISION");
    }
    let opening_amount = intent.opening_cents as f64 / 100.0;
    conn.execute(
        "INSERT INTO staff_shifts (
            id, staff_id, staff_name, branch_id, terminal_id, role_type,
            check_in_time, report_date, period_start_at,
            opening_cash_amount, opening_cash_amount_cents,
            status, calculation_version, transferred_to_cashier_shift_id,
            sync_status, created_at, updated_at, is_day_start
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'cashier', ?6, ?7, ?8, ?9, ?10, 'active', ?11, NULL,
                  'synced', ?12, ?12, ?13)",
        params![
            intent.shift_id,
            intent.staff_id,
            intent.staff_name.as_deref().unwrap_or(""),
            intent.branch_id,
            intent.terminal_id,
            intent.checked_in_at,
            intent.business_date,
            intent.period_start_at,
            opening_amount,
            intent.opening_cents,
            intent.calculation_version,
            now,
            intent.is_day_start,
        ],
    )
    .map_err(|error| {
        warn!("financial opening shift adoption failed: {error}");
        "LOCAL_ADOPTION_FAILED"
    })?;
    conn.execute(
        "INSERT INTO cash_drawer_sessions (
            id, staff_shift_id, cashier_id, branch_id, terminal_id,
            opening_amount, opening_amount_cents, opened_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            intent.drawer_id,
            intent.shift_id,
            intent.staff_id,
            intent.branch_id,
            intent.terminal_id,
            opening_amount,
            intent.opening_cents,
            intent.checked_in_at,
            now,
        ],
    )
    .map_err(|error| {
        warn!("financial opening drawer adoption failed: {error}");
        "LOCAL_ADOPTION_FAILED"
    })?;
    Ok(())
}

fn record_retained_code(conn: &Connection, opening_key: &str, code: &str, now: DateTime<Utc>) {
    let result = conn.execute(
        "UPDATE gift_financial_openings SET
            last_pending_code = ?2,
            auth_requirement = CASE WHEN ?2 = ?4 THEN ?4 ELSE auth_requirement END,
            updated_at = ?3
         WHERE opening_key = ?1 AND state = 'pending'",
        params![
            opening_key,
            code,
            normalize_instant(now),
            CODE_REAUTH_REQUIRED
        ],
    );
    if let Err(error) = result {
        warn!("financial opening retain bookkeeping failed: {error}");
    }
}

fn clear_auth_requirement(conn: &Connection, opening_key: &str) {
    let result = conn.execute(
        "UPDATE gift_financial_openings SET auth_requirement = NULL,
            last_pending_code = CASE WHEN last_pending_code = ?2 THEN NULL ELSE last_pending_code END,
            updated_at = ?3
         WHERE opening_key = ?1",
        params![opening_key, CODE_REAUTH_REQUIRED, normalize_instant(Utc::now())],
    );
    if let Err(error) = result {
        warn!("financial opening auth bookkeeping failed: {error}");
    }
}

// ---------------------------------------------------------------------------
// Queue dispatch (financial-only branch of the sync queue)
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum DispatchPlan {
    Send {
        body: Value,
        staff_session_id: String,
    },
    /// The original is already confirmed and persisted; consume without resend.
    Consume,
    Retain {
        code: &'static str,
    },
}

impl fmt::Debug for DispatchPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Send { .. } => {
                f.write_str("Send { body: <financial opening>, staff_session_id: <redacted> }")
            }
            Self::Consume => f.write_str("Consume"),
            Self::Retain { code } => write!(f, "Retain {{ code: {code} }}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DispatchOutcome {
    Confirmed { state: OpeningState },
    Retained { code: String },
}

pub(crate) fn is_financial_opening_item(item: &SyncQueueItem) -> bool {
    item.table_name == OPENING_QUEUE_TABLE
}

/// Decides whether the original item may be sent. Never falls back to an
/// ordinary send, a new key or a recalculated body.
pub(crate) fn plan_dispatch(
    conn: &Connection,
    queue_item_id: &str,
    opening_key: &str,
    stored_payload: &Value,
    current_scope: Option<&OpeningScope>,
    now: DateTime<Utc>,
) -> DispatchPlan {
    let intent = match load_intent(conn, opening_key) {
        Ok(Some(intent)) => intent,
        Ok(None) => {
            return DispatchPlan::Retain {
                code: "OPENING_INTENT_MISSING",
            }
        }
        Err(_) => {
            return DispatchPlan::Retain {
                code: "LOCAL_READ_FAILED",
            }
        }
    };
    if intent.queue_item_id != queue_item_id {
        return DispatchPlan::Retain {
            code: "OPENING_QUEUE_MISMATCH",
        };
    }
    if intent.state != OpeningState::Pending {
        return DispatchPlan::Consume;
    }
    if *stored_payload != build_sync_body(&intent) {
        return DispatchPlan::Retain {
            code: "OPENING_PAYLOAD_MISMATCH",
        };
    }
    if !current_scope.is_some_and(|scope| scope.matches(&intent)) {
        return DispatchPlan::Retain {
            code: "OPENING_SCOPE_CHANGED",
        };
    }
    let Some(session) = hosted_session(opening_key) else {
        return DispatchPlan::Retain {
            code: CODE_REAUTH_REQUIRED,
        };
    };
    if !session.authorizes(&intent) || !session.live(now) {
        drop_stale_session(opening_key, &session);
        return DispatchPlan::Retain {
            code: CODE_REAUTH_REQUIRED,
        };
    }
    DispatchPlan::Send {
        body: stored_payload.clone(),
        staff_session_id: session.session_id,
    }
}

/// Applies the hosted result natively before any queue success is recorded.
pub(crate) fn apply_sync_result(
    conn: &Connection,
    opening_key: &str,
    result: Result<&Value, &AdminFetchError>,
    now: DateTime<Utc>,
) -> DispatchOutcome {
    let code = match load_intent(conn, opening_key) {
        Ok(Some(intent)) => match result {
            Err(error) => match error.status() {
                Some(401) | Some(403) => {
                    invalidate_hosted_cashier(opening_key);
                    CODE_REAUTH_REQUIRED.to_string()
                }
                Some(status) => format!("HTTP_{status}"),
                None => "TRANSPORT_UNCONFIRMED".to_string(),
            },
            Ok(body) => match parse_sync_response(body, &intent) {
                Ok(ParsedOpening::Confirmed(confirmation)) => {
                    info!(
                        opening_key = %intent.opening_key,
                        replayed = confirmation.replayed,
                        usable = confirmation.usable,
                        "financial opening confirmation received"
                    );
                    match persist_confirmation(conn, &intent, &confirmation, now) {
                        Ok(state) => {
                            if state == OpeningState::ConfirmedUnusable {
                                // An unusable original keeps no private authorization.
                                invalidate_hosted_cashier(opening_key);
                            }
                            return DispatchOutcome::Confirmed { state };
                        }
                        Err(code) => code.to_string(),
                    }
                }
                Ok(ParsedOpening::Pending { code }) => {
                    if code.contains("SESSION") || code.contains("AUTH") {
                        invalidate_hosted_cashier(opening_key);
                    }
                    code
                }
                Err(code) => code.to_string(),
            },
        },
        Ok(None) => "OPENING_INTENT_MISSING".to_string(),
        Err(_) => "LOCAL_READ_FAILED".to_string(),
    };
    record_retained_code(conn, opening_key, &code, now);
    DispatchOutcome::Retained { code }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FinancialQueueResult {
    pub consumed: bool,
    pub code: Option<String>,
}

fn stored_item_payload(item: &SyncQueueItem) -> Value {
    serde_json::from_str(&item.data).unwrap_or(Value::Null)
}

fn settle_item(
    conn: &Connection,
    item: &SyncQueueItem,
    code: Option<&str>,
) -> Result<FinancialQueueResult, String> {
    match code {
        None => Ok(FinancialQueueResult {
            consumed: sync_queue::consume_financial_opening_item(conn, item)?,
            code: None,
        }),
        Some(code) => {
            sync_queue::retain_financial_opening_item(conn, item, code)?;
            Ok(FinancialQueueResult {
                consumed: false,
                code: Some(code.to_string()),
            })
        }
    }
}

/// Financial-only queue branch: scoped hosted header at dispatch, native
/// Shared18 parsing, persistence/adoption, then claim-fenced consumption.
pub(crate) async fn process_queue_item(
    conn: &Mutex<Connection>,
    item: &SyncQueueItem,
    admin_url: &str,
    api_key: &str,
) -> Result<FinancialQueueResult, String> {
    let plan = {
        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
        let scope = OpeningScope::resolve(&db);
        let plan = plan_dispatch(
            &db,
            &item.id,
            &item.record_id,
            &stored_item_payload(item),
            scope.as_ref(),
            Utc::now(),
        );
        match &plan {
            DispatchPlan::Retain { code } => {
                record_retained_code(&db, &item.record_id, code, Utc::now());
                return settle_item(&db, item, Some(*code));
            }
            DispatchPlan::Consume => return settle_item(&db, item, None),
            DispatchPlan::Send { .. } => {}
        }
        plan
    };
    let DispatchPlan::Send {
        body,
        staff_session_id,
    } = plan
    else {
        return Err("financial opening dispatch plan changed".to_string());
    };
    let response = api::fetch_from_admin_detailed_with_staff_session(
        admin_url,
        api_key,
        SHIFT_SYNC_PATH,
        "POST",
        Some(body),
        Some(&staff_session_id),
        HTTP_TIMEOUT,
    )
    .await;
    drop(staff_session_id);
    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
    match apply_sync_result(&db, &item.record_id, response.as_ref(), Utc::now()) {
        DispatchOutcome::Confirmed { state } => {
            info!(opening_key = %item.record_id, state = state.as_str(), "financial opening persisted");
            settle_item(&db, item, None)
        }
        DispatchOutcome::Retained { code } => settle_item(&db, item, Some(code.as_str())),
    }
}

// ---------------------------------------------------------------------------
// Crate-internal scoped hosted accessor (future gift senders)
// ---------------------------------------------------------------------------

/// Immutable original cashier scope a future native gift sender must present.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct HostedCashierScope {
    pub organization_id: String,
    pub branch_id: String,
    pub terminal_id: String,
    pub staff_id: String,
}

/// Native-only hosted authorization of the original cashier of a confirmed
/// usable opening. The session header never leaves native code.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct ScopedHostedCashier {
    opening_key: String,
    shift_id: String,
    drawer_id: String,
    scope: HostedCashierScope,
    session_id: String,
    expires_at: DateTime<Utc>,
}

impl fmt::Debug for ScopedHostedCashier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ScopedHostedCashier")
            .field("opening_key", &self.opening_key)
            .field("shift_id", &self.shift_id)
            .field("scope", &self.scope)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[cfg_attr(not(test), allow(dead_code))]
impl ScopedHostedCashier {
    /// Value for `x-staff-session-id`; for native HTTP headers only.
    pub(crate) fn staff_session_header(&self) -> &str {
        &self.session_id
    }
    pub(crate) fn scope(&self) -> &HostedCashierScope {
        &self.scope
    }
    pub(crate) fn opening_key(&self) -> &str {
        &self.opening_key
    }
    pub(crate) fn shift_id(&self) -> &str {
        &self.shift_id
    }
    pub(crate) fn drawer_id(&self) -> &str {
        &self.drawer_id
    }
    pub(crate) fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum HostedAccessError {
    NoOriginalOpening,
    OpeningPending,
    OpeningUnusable,
    LocalShiftNotActive,
    ReauthRequired,
    Expired,
}

/// Fail-closed accessor: only the exact original cashier of the latest
/// original in the current trusted native scope qualifies, and only while it
/// is confirmed usable, its original shift active and its linked original
/// drawer open, with a live volatile hosted session. Manager grants need their
/// own separate authorization; this never substitutes for them.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn scoped_hosted_cashier(
    conn: &Connection,
    scope: &HostedCashierScope,
    now: DateTime<Utc>,
) -> Result<ScopedHostedCashier, HostedAccessError> {
    // Admission compares against the current trusted native scope, never the
    // caller's claim alone: a public terminal id reused elsewhere refuses.
    let trusted = OpeningScope::resolve(conn)
        .filter(|trusted| {
            trusted.validate().is_ok()
                && same_uuid(&trusted.organization_id, &scope.organization_id)
                && same_uuid(&trusted.branch_id, &scope.branch_id)
                && trusted.terminal_id == scope.terminal_id
        })
        .ok_or(HostedAccessError::NoOriginalOpening)?;
    let intent = conn
        .query_row(
            &format!(
                "SELECT {INTENT_COLUMNS} FROM gift_financial_openings
                 WHERE terminal_id = ?1 AND lower(organization_id) = lower(?2)
                   AND lower(branch_id) = lower(?3) AND lower(staff_id) = lower(?4)
                 ORDER BY created_at DESC, rowid DESC LIMIT 1"
            ),
            params![
                trusted.terminal_id,
                trusted.organization_id,
                trusted.branch_id,
                scope.staff_id
            ],
            intent_from_row,
        )
        .optional()
        .map_err(|_| HostedAccessError::NoOriginalOpening)?
        .filter(|intent| trusted.matches(intent) && same_uuid(&intent.staff_id, &scope.staff_id))
        .ok_or(HostedAccessError::NoOriginalOpening)?;
    match intent.state {
        OpeningState::Pending => return Err(HostedAccessError::OpeningPending),
        OpeningState::ConfirmedUnusable => return Err(HostedAccessError::OpeningUnusable),
        OpeningState::ConfirmedUsable => {}
    }
    // A closed, missing, foreign-linked or inconsistent original mirror refuses.
    if !original_mirror_open(conn, &intent.opening_key).unwrap_or(false) {
        return Err(HostedAccessError::LocalShiftNotActive);
    }
    let session = hosted_session(&intent.opening_key).ok_or(HostedAccessError::ReauthRequired)?;
    if !session.authorizes(&intent) {
        drop_stale_session(&intent.opening_key, &session);
        return Err(HostedAccessError::ReauthRequired);
    }
    if !session.live(now) {
        drop_stale_session(&intent.opening_key, &session);
        return Err(HostedAccessError::Expired);
    }
    Ok(ScopedHostedCashier {
        opening_key: intent.opening_key,
        shift_id: intent.shift_id,
        drawer_id: intent.drawer_id,
        scope: scope.clone(),
        session_id: session.session_id,
        expires_at: session.expires_at,
    })
}

// ---------------------------------------------------------------------------
// Crate-internal trusted scope and purpose-scoped hosted check-in
// ---------------------------------------------------------------------------

/// The current trusted native terminal scope, if complete and valid.
pub(crate) fn trusted_scope(conn: &Connection) -> Option<OpeningScope> {
    OpeningScope::resolve(conn).filter(|scope| scope.validate().is_ok())
}

/// Hosted staff session of a separately selected actor (a gift grant
/// manager), issued by the exact hosted check-in and validated against the
/// trusted scope it was requested in. It is installed nowhere here, never
/// authorizes an opening and creates no shift or drawer; its owner holds,
/// fences and clears it. The header value never leaves native code.
pub(crate) struct SelectedStaffSession {
    staff_id: String,
    session_id: String,
    expires_at: DateTime<Utc>,
}

impl fmt::Debug for SelectedStaffSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SelectedStaffSession")
            .field("staff_id", &self.staff_id)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl SelectedStaffSession {
    pub(crate) fn staff_id(&self) -> &str {
        &self.staff_id
    }
    /// Value for `x-staff-session-id`; for native HTTP headers only.
    pub(crate) fn staff_session_header(&self) -> &str {
        &self.session_id
    }
    /// The server expiry less the shared expiry skew.
    pub(crate) fn usable_until(&self) -> DateTime<Utc> {
        self.expires_at - chrono::Duration::seconds(SESSION_EXPIRY_SKEW_SECS)
    }
}

/// Transient-PIN hosted check-in of `staff_id` in `scope`, with the same
/// endpoint, PIN rule and response validation as the cashier issuance.
pub(crate) async fn issue_selected_staff_session(
    db: &crate::db::DbState,
    scope: &OpeningScope,
    staff_id: &str,
    payload: &Value,
) -> Result<SelectedStaffSession, OpeningError> {
    scope.validate()?;
    if !is_uuid(staff_id) {
        return Err(OpeningError::new(
            "INVALID_STAFF_ID",
            "staffId must be a UUID",
        ));
    }
    let pin = transient_pin(payload)?;
    let issued = issue_hosted_session(db, scope, staff_id, pin).await?;
    Ok(SelectedStaffSession {
        staff_id: issued.staff_id.clone(),
        session_id: issued.session_id.clone(),
        expires_at: issued.expires_at,
    })
}

/// Test-only: serializes every test, in any module, that touches the
/// process-wide volatile hosted state (the dedicated clear is global).
#[cfg(test)]
pub(crate) fn hosted_auth_test_serial() -> MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Test-only: installs a live hosted session of an original's cashier as the
/// newest issuance, exactly as a validated check-in would.
#[cfg(test)]
pub(crate) fn install_hosted_cashier_for_test(intent: &OpeningIntent, expires_in_secs: i64) {
    let fence = capture_issuance_fence();
    hosted_auth().sessions.insert(
        intent.opening_key.clone(),
        InstalledSession {
            generation: fence.generation,
            session: HostedCashierSession {
                organization_id: intent.organization_id.clone(),
                branch_id: intent.branch_id.clone(),
                terminal_id: intent.terminal_id.clone(),
                staff_id: intent.staff_id.clone(),
                session_id: Uuid::new_v4().to_string(),
                expires_at: Utc::now() + chrono::Duration::seconds(expires_in_secs),
            },
        },
    );
}

// ---------------------------------------------------------------------------
// Command services (wrapped by commands/shifts.rs)
// ---------------------------------------------------------------------------

/// Nonsecret projection. `usable` is the caller's current usability (see
/// `currently_usable`); a stored confirmation alone never makes it true.
fn intent_view(intent: &OpeningIntent, usable: bool, now: DateTime<Utc>) -> Value {
    let usable = usable && intent.state == OpeningState::ConfirmedUsable;
    // Authorization is shown only where it can still act: a pending original
    // or a currently usable one.
    let authorized = hosted_session(&intent.opening_key).filter(|session| {
        (intent.state == OpeningState::Pending || usable)
            && session.authorizes(intent)
            && session.live(now)
    });
    json!({
        "openingKey": intent.opening_key,
        "shiftId": intent.shift_id,
        "drawerId": intent.drawer_id,
        "staffId": intent.staff_id,
        "organizationId": intent.organization_id,
        "branchId": intent.branch_id,
        "terminalId": intent.terminal_id,
        "openingCents": intent.opening_cents,
        "currency": intent.currency,
        "businessDate": intent.business_date,
        "checkedInAt": intent.checked_in_at,
        "isDayStart": intent.is_day_start,
        "calculationVersion": intent.calculation_version,
        "state": intent.state.as_str(),
        "usable": usable,
        "hostedAuthorization": match authorized {
            Some(session) => json!({ "state": "authorized", "expiresAt": normalize_instant(session.expires_at) }),
            None => json!({ "state": "required", "expiresAt": Value::Null }),
        },
        "lastPendingCode": intent.last_pending_code,
        "drawer": intent.drawer.as_ref().map(|drawer| json!({
            "version": drawer.version,
            "acknowledgementId": drawer.acknowledgement_id,
            "giftCashCents": drawer.gift_cash_cents,
            "ordinaryExpectedCents": drawer.ordinary_expected_cents,
            "expectedCents": drawer.expected_cents,
        })),
    })
}

fn success_view(conn: &Connection, scope: &OpeningScope, intent: &OpeningIntent) -> Value {
    let usable = currently_usable(conn, scope, intent);
    json!({ "success": true, "opening": intent_view(intent, usable, Utc::now()) })
}

fn transient_pin(payload: &Value) -> Result<String, OpeningError> {
    payload
        .get("pin")
        .and_then(Value::as_str)
        .filter(|pin| {
            PIN_LENGTH.contains(&pin.len()) && pin.bytes().all(|byte| byte.is_ascii_digit())
        })
        .map(str::to_string)
        .ok_or_else(|| {
            OpeningError::new("PIN_REQUIRED", "The selected cashier must enter their PIN")
        })
}

fn not_configured() -> OpeningError {
    OpeningError::new(
        "TERMINAL_NOT_CONFIGURED",
        "Terminal admin connection is not configured",
    )
}

fn resolve_valid_scope(conn: &Connection) -> Result<OpeningScope, OpeningError> {
    let scope = OpeningScope::resolve(conn).ok_or_else(|| {
        OpeningError::new(
            "TERMINAL_SCOPE_UNAVAILABLE",
            "Terminal organization, branch and terminal identity are required",
        )
    })?;
    scope.validate()?;
    Ok(scope)
}

fn scope_changed() -> OpeningError {
    OpeningError::new(
        "OPENING_SCOPE_CHANGED",
        "The terminal scope differs from the original opening",
    )
}

fn authorization_superseded() -> OpeningError {
    OpeningError::new(
        "HOSTED_AUTHORIZATION_SUPERSEDED",
        "Hosted cashier authorization was cleared or superseded; authorize again",
    )
}

/// Current eligibility of an existing original for hosted (re)authorization:
/// the trusted full scope, and a pending or currently usable original.
fn check_existing_eligible(
    conn: &Connection,
    scope: &OpeningScope,
    intent: &OpeningIntent,
) -> Result<(), OpeningError> {
    if !scope.matches(intent) {
        return Err(scope_changed());
    }
    let eligible = match intent.state {
        OpeningState::Pending => true,
        OpeningState::ConfirmedUnusable => false,
        OpeningState::ConfirmedUsable => {
            original_mirror_open(conn, &intent.opening_key).map_err(local_error)?
        }
    };
    if !eligible {
        return Err(OpeningError::new(
            "OPENING_UNUSABLE",
            "This original opening is not currently usable",
        ));
    }
    Ok(())
}

/// What an issued hosted session is for.
enum IssuanceTarget {
    /// First issuance: the original is prepared only if still fresh.
    New(PrepareRequest),
    /// Same-cashier (re)authorization of an existing original.
    Existing(OpeningIntent),
}

impl IssuanceTarget {
    fn staff_id(&self) -> &str {
        match self {
            Self::New(request) => &request.staff_id,
            Self::Existing(intent) => &intent.staff_id,
        }
    }
}

/// Post-await finalization shared by begin and authorize. Under the DB lock it
/// re-resolves the trusted scope and the original's current eligibility; then,
/// holding the volatile auth lock, it checks the fence captured before the
/// await, prepares (first issuance only) and installs. An invalidation is thus
/// strictly before (refused: nothing prepared or installed) or after (it
/// clears the installed session; a prepared original stays durable).
fn finalize_issuance(
    conn: &Connection,
    fence: IssuanceFence,
    issued_scope: &OpeningScope,
    target: &IssuanceTarget,
    session: HostedCashierSession,
    now: DateTime<Utc>,
) -> Result<OpeningIntent, OpeningError> {
    let current = resolve_valid_scope(conn)?;
    if current != *issued_scope {
        return Err(scope_changed());
    }
    let known_key = match target {
        IssuanceTarget::New(request) => request.opening_key.as_deref(),
        IssuanceTarget::Existing(original) => {
            let fresh = load_intent(conn, &original.opening_key)
                .map_err(local_error)?
                .filter(|fresh| fresh.same_original(original))
                .ok_or_else(|| {
                    OpeningError::new(
                        "OPENING_TUPLE_CHANGED",
                        "The original opening changed during authorization",
                    )
                })?;
            check_existing_eligible(conn, &current, &fresh)?;
            Some(original.opening_key.as_str())
        }
    };
    if !session.issued_for(&current, target.staff_id()) {
        return Err(OpeningError::new(
            "HOSTED_STAFF_MISMATCH",
            "Hosted cashier authorization was not accepted",
        ));
    }
    let mut auth = hosted_auth();
    if !auth.admits(fence, known_key) {
        return Err(authorization_superseded());
    }
    let opening_key = match target {
        IssuanceTarget::New(request) => {
            let (intent, created) = prepare_opening(conn, &current, request, now)?;
            if !created {
                check_existing_eligible(conn, &current, &intent)?;
            }
            intent.opening_key
        }
        IssuanceTarget::Existing(original) => original.opening_key.clone(),
    };
    auth.sessions.insert(
        opening_key.clone(),
        InstalledSession {
            generation: fence.generation,
            session,
        },
    );
    clear_auth_requirement(conn, &opening_key);
    drop(auth);
    load_intent(conn, &opening_key)
        .map_err(local_error)?
        .ok_or_else(|| {
            OpeningError::new("OPENING_INTENT_MISSING", "The original opening is missing")
        })
}

/// Issues the selected cashier's hosted session with the fence captured
/// before the HTTP await, then finalizes it only if it is still fresh.
async fn issue_and_finalize(
    db: &crate::db::DbState,
    scope: OpeningScope,
    target: IssuanceTarget,
    pin: String,
) -> Result<Value, String> {
    let fence = capture_issuance_fence();
    let session = match issue_hosted_session(db, &scope, target.staff_id(), pin).await {
        Ok(session) => session,
        Err(error) => return Ok(error.to_value()),
    };
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    match finalize_issuance(&conn, fence, &scope, &target, session, Utc::now()) {
        Ok(intent) => Ok(success_view(&conn, &scope, &intent)),
        Err(error) => Ok(error.to_value()),
    }
}

/// Starts (or re-authorizes the same-key) original financial opening: hosted
/// cashier check-in first, then the atomic intent + queue item.
pub(crate) async fn begin_opening(
    db: &crate::db::DbState,
    payload: &Value,
) -> Result<Value, String> {
    let request = match PrepareRequest::from_value(payload) {
        Ok(request) => request,
        Err(error) => return Ok(error.to_value()),
    };
    let pin = match transient_pin(payload) {
        Ok(pin) => pin,
        Err(error) => return Ok(error.to_value()),
    };
    let (scope, existing) = {
        let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
        let scope = match resolve_valid_scope(&conn) {
            Ok(scope) => scope,
            Err(error) => return Ok(error.to_value()),
        };
        let existing = match request.opening_key.as_deref() {
            Some(key) => load_intent(&conn, key)?,
            None => None,
        };
        let checked = match &existing {
            Some(intent) if !request.matches(intent, &scope) => Err(OpeningError::new(
                "OPENING_KEY_TUPLE_MISMATCH",
                "This opening key belongs to a different original opening",
            )),
            Some(intent) => check_existing_eligible(&conn, &scope, intent),
            None => check_new_opening_allowed(&conn, &scope, &request.staff_id),
        };
        if let Err(error) = checked {
            return Ok(error.to_value());
        }
        (scope, existing)
    };
    let target = match existing {
        Some(intent) => IssuanceTarget::Existing(intent),
        None => IssuanceTarget::New(request),
    };
    issue_and_finalize(db, scope, target, pin).await
}

/// Same-cashier re-authorization of an existing original (after restart,
/// expiry or refusal). Changes only the volatile hosted authorization.
pub(crate) async fn authorize_opening(
    db: &crate::db::DbState,
    payload: &Value,
) -> Result<Value, String> {
    let Some(key) = payload
        .get("openingKey")
        .and_then(Value::as_str)
        .map(|key| key.trim().to_ascii_lowercase())
        .filter(|key| is_uuid(key))
    else {
        return Ok(
            OpeningError::new("INVALID_OPENING_KEY", "openingKey must be a UUID").to_value(),
        );
    };
    let pin = match transient_pin(payload) {
        Ok(pin) => pin,
        Err(error) => return Ok(error.to_value()),
    };
    let (scope, intent) = {
        let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
        let Some(intent) = load_intent(&conn, &key)? else {
            return Ok(
                OpeningError::new("OPENING_NOT_FOUND", "No original opening has this key")
                    .to_value(),
            );
        };
        let scope = match resolve_valid_scope(&conn) {
            Ok(scope) => scope,
            Err(error) => return Ok(error.to_value()),
        };
        if let Err(error) = check_existing_eligible(&conn, &scope, &intent) {
            return Ok(error.to_value());
        }
        (scope, intent)
    };
    issue_and_finalize(db, scope, IssuanceTarget::Existing(intent), pin).await
}

/// Nonsecret status of one original (by key) or of this terminal's pending
/// and currently usable ones, only ever within the current trusted full scope.
pub(crate) fn opening_status(
    db: &crate::db::DbState,
    payload: Option<&Value>,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    let key = payload
        .and_then(|payload| payload.get("openingKey"))
        .and_then(Value::as_str)
        .map(|key| key.trim().to_ascii_lowercase());
    status_in(&conn, key.as_deref(), Utc::now())
}

/// An unverifiable scope, or a key of another org/branch/public terminal,
/// yields no opening and no foreign original detail.
fn status_in(conn: &Connection, key: Option<&str>, now: DateTime<Utc>) -> Result<Value, String> {
    let Some(scope) = OpeningScope::resolve(conn).filter(|scope| scope.validate().is_ok()) else {
        return Ok(json!({ "success": true, "openings": [] }));
    };
    let intents = match key {
        Some(key) => load_intent(conn, key)?
            .filter(|intent| scope.matches(intent))
            .into_iter()
            .collect::<Vec<_>>(),
        None => load_open_intents_for_scope(conn, &scope)?,
    };
    let openings = intents
        .iter()
        .map(|intent| intent_view(intent, currently_usable(conn, &scope, intent), now))
        .collect::<Vec<_>>();
    Ok(json!({ "success": true, "openings": openings }))
}

/// Dedicated clear of every hosted cashier authorization (see
/// `clear_hosted_cashier_authorizations`); it returns no credential detail.
pub(crate) fn clear_authorizations() -> Value {
    clear_hosted_cashier_authorizations();
    // The same explicit boundary drops every separate-purpose authority.
    crate::commands::gift_card_returns::clear_return_authorities();
    crate::commands::gift_card_funding::clear_grant_authorities();
    json!({ "success": true })
}

/// Queue item id of an original, for immediate-sync scheduling.
pub(crate) fn opening_shift_id(response: &Value) -> Option<String> {
    response
        .get("opening")
        .and_then(|opening| opening.get("shiftId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Close-purpose original-cashier authority (retained financial closing)
// ---------------------------------------------------------------------------

/// Refusal of the close-purpose hosted accessor or of a closing renewal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum ClosingAccessError {
    ClosingNotFound,
    /// Its proof was adopted: a confirmed original never authorizes again.
    ClosingNotPending,
    QueueMismatch,
    ScopeUnavailable,
    ScopeChanged,
    /// The opening is missing, pending or no longer the original's actor/pins.
    OpeningMismatch,
    /// The retained local closure (closed shift and drawer holding the count) differs.
    MirrorMismatch,
    ReauthRequired,
    Expired,
    LocalReadFailed,
}

impl ClosingAccessError {
    /// Safe nonsecret refusal code.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::ClosingNotFound => "CLOSING_NOT_FOUND",
            Self::ClosingNotPending => "CLOSING_NOT_PENDING",
            Self::QueueMismatch => "CLOSING_QUEUE_MISMATCH",
            Self::ScopeUnavailable => "TERMINAL_SCOPE_UNAVAILABLE",
            Self::ScopeChanged => "CLOSING_SCOPE_CHANGED",
            Self::OpeningMismatch => "CLOSING_OPENING_MISMATCH",
            Self::MirrorMismatch => "CLOSING_MIRROR_MISMATCH",
            Self::ReauthRequired => CODE_REAUTH_REQUIRED,
            Self::Expired => "HOSTED_SESSION_EXPIRED",
            Self::LocalReadFailed => "LOCAL_READ_FAILED",
        }
    }

    fn refusal(self) -> OpeningError {
        let message = match self {
            Self::ClosingNotFound => "No retained financial closing has this key",
            Self::ClosingNotPending => "This financial closing is no longer pending",
            Self::QueueMismatch => "The financial closing belongs to another queue item",
            Self::ScopeUnavailable => {
                "Terminal organization, branch and terminal identity are required"
            }
            Self::ScopeChanged => "The terminal scope differs from the original closing",
            Self::OpeningMismatch => "The original opening no longer matches this closing",
            Self::MirrorMismatch => "The local close does not match the original closing",
            Self::ReauthRequired => "The original cashier must authorize again",
            Self::Expired => "The original cashier authorization expired",
            Self::LocalReadFailed => "The financial closing could not be read locally",
        };
        OpeningError::new(self.code(), message)
    }
}

/// A pending closing original, its exact opening and the current trusted
/// scope they were validated in.
#[derive(Clone, Debug)]
struct RetainedClosing {
    original: ClosingOriginal,
    opening: OpeningIntent,
    scope: OpeningScope,
}

/// Every identity field of the closing original against its actual confirmed
/// opening, including the owner/source terminal DB pins of the opening proof.
fn closing_matches_opening(original: &ClosingOriginal, opening: &OpeningIntent) -> bool {
    opening.state != OpeningState::Pending
        && original.opening_key == opening.opening_key
        && same_uuid(&original.organization_id, &opening.organization_id)
        && same_uuid(&original.branch_id, &opening.branch_id)
        && original.terminal_id == opening.terminal_id
        && same_uuid(&original.staff_id, &opening.staff_id)
        && original.shift_id == opening.shift_id
        && original.drawer_id == opening.drawer_id
        && original.currency == opening.currency
        && opening
            .owner_terminal_db_id
            .as_deref()
            .is_some_and(|owner| same_uuid(&original.owner_terminal_db_id, owner))
        && opening
            .source_terminal_db_id
            .as_deref()
            .is_some_and(|source| same_uuid(&original.source_terminal_db_id, source))
}

/// The immutable closing original; state and bookkeeping excluded. The row
/// creation time is included, so a removed and recaptured row differs.
fn same_closing_original(left: &ClosingOriginal, right: &ClosingOriginal) -> bool {
    left.closing_key == right.closing_key
        && left.opening_key == right.opening_key
        && left.queue_item_id == right.queue_item_id
        && left.organization_id == right.organization_id
        && left.branch_id == right.branch_id
        && left.terminal_id == right.terminal_id
        && left.staff_id == right.staff_id
        && left.shift_id == right.shift_id
        && left.drawer_id == right.drawer_id
        && left.owner_terminal_db_id == right.owner_terminal_db_id
        && left.source_terminal_db_id == right.source_terminal_db_id
        && left.currency == right.currency
        && left.counted_cents == right.counted_cents
        && left.closed_at == right.closed_at
        && left.drawer == right.drawer
        && left.variance_cents == right.variance_cents
        && left.request_body_json == right.request_body_json
        && left.created_at == right.created_at
}

/// The retained local closure of a closing original: its original cashier
/// shift and that shift's single linked drawer, of the original actor, branch
/// and public terminal, both closed and both holding the original count.
fn retained_closure_matches(conn: &Connection, original: &ClosingOriginal) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS (
                SELECT 1 FROM staff_shifts s
                JOIN cash_drawer_sessions d ON d.id = ?2 AND d.staff_shift_id = s.id
                WHERE s.id = ?1
                  AND s.status = 'closed'
                  AND s.role_type = 'cashier'
                  AND lower(s.staff_id) = lower(?3)
                  AND lower(s.branch_id) = lower(?4)
                  AND s.terminal_id = ?5
                  AND s.closing_cash_amount_cents = ?6
                  AND d.closed_at IS NOT NULL
                  AND d.closed_at <> ''
                  AND lower(d.cashier_id) = lower(?3)
                  AND lower(d.branch_id) = lower(?4)
                  AND d.terminal_id = ?5
                  AND d.closing_amount_cents = ?6
            )
            AND (SELECT COUNT(*) FROM cash_drawer_sessions c WHERE c.staff_shift_id = ?1) = 1",
        params![
            original.shift_id,
            original.drawer_id,
            original.staff_id,
            original.branch_id,
            original.terminal_id,
            original.counted_cents
        ],
        |row| row.get(0),
    )
    .map_err(|e| format!("read financial closing mirror: {e}"))
}

/// Loads exactly the pending original of `closing_key` (bound to
/// `queue_item_id` when given) and validates it against the current trusted
/// scope, its exact opening and its retained local closure. It never selects
/// the latest opening and never applies the open-mirror/usable rule of the
/// opening and funding paths: an opening that is now unusable still backs its
/// already captured pending close (the first capture checked usability).
fn load_retained_closing(
    conn: &Connection,
    closing_key: &str,
    queue_item_id: Option<&str>,
) -> Result<RetainedClosing, ClosingAccessError> {
    let original = gift_financial_closing::load_original(conn, closing_key)
        .map_err(|_| ClosingAccessError::LocalReadFailed)?
        .ok_or(ClosingAccessError::ClosingNotFound)?;
    if original.state != ClosingState::Pending {
        return Err(ClosingAccessError::ClosingNotPending);
    }
    if queue_item_id.is_some_and(|queue_item_id| queue_item_id != original.queue_item_id) {
        return Err(ClosingAccessError::QueueMismatch);
    }
    let scope = trusted_scope(conn).ok_or(ClosingAccessError::ScopeUnavailable)?;
    if !same_uuid(&scope.organization_id, &original.organization_id)
        || !same_uuid(&scope.branch_id, &original.branch_id)
        || scope.terminal_id != original.terminal_id
    {
        return Err(ClosingAccessError::ScopeChanged);
    }
    let opening = load_intent(conn, &original.opening_key)
        .map_err(|_| ClosingAccessError::LocalReadFailed)?
        .filter(|opening| closing_matches_opening(&original, opening))
        .ok_or(ClosingAccessError::OpeningMismatch)?;
    if !retained_closure_matches(conn, &original)
        .map_err(|_| ClosingAccessError::LocalReadFailed)?
    {
        return Err(ClosingAccessError::MirrorMismatch);
    }
    Ok(RetainedClosing {
        original,
        opening,
        scope,
    })
}

/// Native-only hosted authorization of the original cashier of one retained
/// pending financial closing, bound to its exact closing key and queue item.
/// It serves that closing's dispatch only, never funding, a new opening or
/// other cash work. The session header never leaves native code.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct ClosingHostedCashier {
    closing_key: String,
    opening_key: String,
    queue_item_id: String,
    shift_id: String,
    drawer_id: String,
    scope: HostedCashierScope,
    session_id: String,
    expires_at: DateTime<Utc>,
}

impl fmt::Debug for ClosingHostedCashier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClosingHostedCashier")
            .field("closing_key", &self.closing_key)
            .field("queue_item_id", &self.queue_item_id)
            .field("scope", &self.scope)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[cfg_attr(not(test), allow(dead_code))]
impl ClosingHostedCashier {
    /// Value for `x-staff-session-id`; for native HTTP headers only.
    pub(crate) fn staff_session_header(&self) -> &str {
        &self.session_id
    }
    pub(crate) fn closing_key(&self) -> &str {
        &self.closing_key
    }
    pub(crate) fn opening_key(&self) -> &str {
        &self.opening_key
    }
    pub(crate) fn queue_item_id(&self) -> &str {
        &self.queue_item_id
    }
    pub(crate) fn shift_id(&self) -> &str {
        &self.shift_id
    }
    pub(crate) fn drawer_id(&self) -> &str {
        &self.drawer_id
    }
    pub(crate) fn scope(&self) -> &HostedCashierScope {
        &self.scope
    }
    pub(crate) fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
}

/// Close-purpose accessor: the live private session of the original cashier
/// of exactly this pending closing original (`closing_key` + `queue_item_id`)
/// after its local close, validated as [`load_retained_closing`] does. Unlike
/// [`scoped_hosted_cashier`] it neither selects the latest opening nor needs a
/// usable opening or an open mirror; that accessor and funding admission keep
/// refusing a closed original.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn closing_hosted_cashier(
    conn: &Connection,
    closing_key: &str,
    queue_item_id: &str,
    now: DateTime<Utc>,
) -> Result<ClosingHostedCashier, ClosingAccessError> {
    let RetainedClosing {
        original, opening, ..
    } = load_retained_closing(conn, closing_key, Some(queue_item_id))?;
    let session =
        hosted_session(&original.opening_key).ok_or(ClosingAccessError::ReauthRequired)?;
    if !session.authorizes(&opening) {
        drop_stale_session(&original.opening_key, &session);
        return Err(ClosingAccessError::ReauthRequired);
    }
    if !session.live(now) {
        drop_stale_session(&original.opening_key, &session);
        return Err(ClosingAccessError::Expired);
    }
    Ok(ClosingHostedCashier {
        scope: HostedCashierScope {
            organization_id: original.organization_id.clone(),
            branch_id: original.branch_id.clone(),
            terminal_id: original.terminal_id.clone(),
            staff_id: original.staff_id.clone(),
        },
        closing_key: original.closing_key,
        opening_key: original.opening_key,
        queue_item_id: original.queue_item_id,
        shift_id: original.shift_id,
        drawer_id: original.drawer_id,
        session_id: session.session_id,
        expires_at: session.expires_at,
    })
}

/// Original-cashier hosted renewal of one retained pending financial closing
/// (after its local close, a restart or expiry). The cashier is the stored
/// original's, never a renderer claim, and the PIN is transient. The closing
/// is validated before the hosted check-in and again after it; nothing durable
/// changes and no sync is scheduled.
pub(crate) async fn authorize_closing(
    db: &crate::db::DbState,
    payload: &Value,
) -> Result<Value, String> {
    let Some(closing_key) = payload
        .get("closingKey")
        .and_then(Value::as_str)
        .map(|key| key.trim().to_ascii_lowercase())
        .filter(|key| is_uuid(key))
    else {
        return Ok(
            OpeningError::new("INVALID_CLOSING_KEY", "closingKey must be a UUID").to_value(),
        );
    };
    let pin = match transient_pin(payload) {
        Ok(pin) => pin,
        Err(error) => return Ok(error.to_value()),
    };
    let retained = {
        let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
        match load_retained_closing(&conn, &closing_key, None) {
            Ok(retained) => retained,
            Err(error) => return Ok(error.refusal().to_value()),
        }
    };
    let fence = capture_issuance_fence();
    let session =
        match issue_hosted_session(db, &retained.scope, &retained.original.staff_id, pin).await {
            Ok(session) => session,
            Err(error) => return Ok(error.to_value()),
        };
    let conn = db.conn.lock().map_err(|e| format!("lock: {e}"))?;
    match finalize_closing_issuance(&conn, fence, &retained, session) {
        Ok((original, expires_at)) => Ok(closing_authorization_view(&original, expires_at)),
        Err(error) => Ok(error.to_value()),
    }
}

/// Post-await finalization of a closing renewal. Under the DB lock it rereads
/// the same pending original (key, queue item, opening and immutable tuple),
/// its opening, the trusted scope and the retained closure; then, holding the
/// volatile auth lock, it installs the original cashier's session only while
/// the fence captured before the await still admits it. A dedicated clear,
/// this original's invalidation, a newer install or proof consumption while
/// the reply was held thus installs nothing.
fn finalize_closing_issuance(
    conn: &Connection,
    fence: IssuanceFence,
    issued: &RetainedClosing,
    session: HostedCashierSession,
) -> Result<(ClosingOriginal, DateTime<Utc>), OpeningError> {
    let current = load_retained_closing(
        conn,
        &issued.original.closing_key,
        Some(issued.original.queue_item_id.as_str()),
    )
    .map_err(ClosingAccessError::refusal)?;
    if current.scope != issued.scope {
        return Err(ClosingAccessError::ScopeChanged.refusal());
    }
    if !same_closing_original(&current.original, &issued.original)
        || !current.opening.same_original(&issued.opening)
        || current.opening.owner_terminal_db_id != issued.opening.owner_terminal_db_id
        || current.opening.source_terminal_db_id != issued.opening.source_terminal_db_id
    {
        return Err(OpeningError::new(
            "CLOSING_TUPLE_CHANGED",
            "The retained closing changed during authorization",
        ));
    }
    if !session.issued_for(&current.scope, &current.original.staff_id)
        || !session.authorizes(&current.opening)
    {
        return Err(OpeningError::new(
            "HOSTED_STAFF_MISMATCH",
            "Hosted cashier authorization was not accepted",
        ));
    }
    // The database lock can be held while the hosted reply waits to finalize.
    // Do not install (or report success for) a session that expired meanwhile.
    if !session.live(Utc::now()) {
        return Err(OpeningError::new(
            "HOSTED_SESSION_EXPIRED",
            "The original cashier authorization expired",
        ));
    }
    let expires_at = session.expires_at;
    let mut auth = hosted_auth();
    if !auth.admits(fence, Some(current.original.opening_key.as_str())) {
        return Err(authorization_superseded());
    }
    auth.sessions.insert(
        current.original.opening_key.clone(),
        InstalledSession {
            generation: fence.generation,
            session,
        },
    );
    drop(auth);
    Ok((current.original, expires_at))
}

/// Nonsecret projection of a renewed closing authorization: the original's
/// identity and the hosted expiry, never a session or PIN.
fn closing_authorization_view(original: &ClosingOriginal, expires_at: DateTime<Utc>) -> Value {
    json!({
        "success": true,
        "closing": {
            "closingKey": original.closing_key,
            "openingKey": original.opening_key,
            "shiftId": original.shift_id,
            "drawerId": original.drawer_id,
            "staffId": original.staff_id,
            "organizationId": original.organization_id,
            "branchId": original.branch_id,
            "terminalId": original.terminal_id,
            "state": "pending",
            "hostedAuthorization": { "state": "authorized", "expiresAt": normalize_instant(expires_at) },
        }
    })
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

fn str_field<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn exact_keys(obj: &Map<String, Value>, keys: &[&str]) -> bool {
    obj.len() == keys.len() && keys.iter().all(|key| obj.contains_key(*key))
}

fn bounded_int(value: Option<&Value>, min: i64, max: i64) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|number| (min..=max).contains(number))
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

fn is_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
        && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn is_pending_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn parse_instant(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|instant| instant.with_timezone(&Utc))
}

/// Millisecond `Z` instant, identical to JavaScript `toISOString()`.
fn normalize_instant(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "6da1cebf-7a5f-4b62-9e4f-5a6b7c8d9eaf";
    const BRANCH: &str = "7eb2dfc0-8b6a-4c73-8f5a-6b7c8d9eafb0";
    const TERMINAL: &str = "terminal-main-01";
    const STAFF: &str = "5c90bdae-6f4e-4a51-8d3e-4f5a6b7c8d9e";
    const OTHER_STAFF: &str = "8e0c1d2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f";
    const OWNER_DB: &str = "a1b2c3d4-e5f6-4789-8abc-def012345678";
    const SOURCE_DB: &str = "b2c3d4e5-f6a7-4890-9bcd-ef0123456789";

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        for (key, value) in [
            ("organization_id", ORG),
            ("branch_id", BRANCH),
            ("terminal_id", TERMINAL),
        ] {
            crate::db::set_setting(&conn, "terminal", key, value).expect("seed terminal scope");
        }
        conn
    }

    fn scope() -> OpeningScope {
        OpeningScope {
            organization_id: ORG.to_string(),
            branch_id: BRANCH.to_string(),
            terminal_id: TERMINAL.to_string(),
        }
    }

    fn cashier_scope() -> HostedCashierScope {
        HostedCashierScope {
            organization_id: ORG.to_string(),
            branch_id: BRANCH.to_string(),
            terminal_id: TERMINAL.to_string(),
            staff_id: STAFF.to_string(),
        }
    }

    fn request(staff_id: &str, cents: i64) -> PrepareRequest {
        PrepareRequest {
            opening_key: None,
            staff_id: staff_id.to_string(),
            staff_name: Some("Maria".to_string()),
            opening_cents: cents,
            currency: "EUR".to_string(),
        }
    }

    fn prepare(conn: &Connection, cents: i64) -> OpeningIntent {
        let (intent, created) = prepare_opening(conn, &scope(), &request(STAFF, cents), Utc::now())
            .expect("prepare the original opening");
        assert!(created);
        intent
    }

    fn session_for(
        intent: &OpeningIntent,
        staff_id: &str,
        expires_in_secs: i64,
    ) -> HostedCashierSession {
        HostedCashierSession {
            organization_id: intent.organization_id.clone(),
            branch_id: intent.branch_id.clone(),
            terminal_id: intent.terminal_id.clone(),
            staff_id: staff_id.to_string(),
            session_id: Uuid::new_v4().to_string(),
            expires_at: Utc::now() + chrono::Duration::seconds(expires_in_secs),
        }
    }

    /// Serializes the tests that rely on the process-wide volatile hosted
    /// state; the dedicated clear is global by design.
    fn auth_serial() -> MutexGuard<'static, ()> {
        super::hosted_auth_test_serial()
    }

    /// Test seam: installs a freshly issued session as the newest generation.
    fn store_hosted_session(opening_key: &str, session: HostedCashierSession) {
        let fence = capture_issuance_fence();
        hosted_auth().sessions.insert(
            opening_key.to_string(),
            InstalledSession {
                generation: fence.generation,
                session,
            },
        );
    }

    /// A session exactly as the production check-in validator issues it.
    fn issued_session(scope: &OpeningScope, staff_id: &str) -> HostedCashierSession {
        let now = Utc::now();
        let session_id = Uuid::new_v4().to_string();
        let body = json!({
            "success": true,
            "session_id": session_id,
            "staff_id": staff_id,
            "organization_id": scope.organization_id,
            "branch_id": scope.branch_id,
            "session": {
                "id": session_id,
                "staff_id": staff_id,
                "terminal_id": scope.terminal_id,
                "organization_id": scope.organization_id,
                "branch_id": scope.branch_id,
                "expires_at": normalize_instant(now + chrono::Duration::hours(8))
            }
        });
        validate_check_in_response(&body, scope, staff_id, now).expect("a valid hosted check-in")
    }

    fn statuses(conn: &Connection, key: Option<&str>) -> Vec<Value> {
        status_in(conn, key, Utc::now()).expect("status")["openings"]
            .as_array()
            .expect("openings")
            .clone()
    }

    fn claim(conn: &Connection) -> SyncQueueItem {
        sync_queue::dequeue(conn)
            .expect("dequeue")
            .expect("the queued item is claimable")
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).expect("count")
    }

    fn queue_rows(conn: &Connection) -> i64 {
        count(
            conn,
            "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'gift_financial_openings'",
        )
    }

    fn mirror_rows(conn: &Connection) -> (i64, i64) {
        (
            count(conn, "SELECT COUNT(*) FROM staff_shifts"),
            count(conn, "SELECT COUNT(*) FROM cash_drawer_sessions"),
        )
    }

    fn insert_ordinary_shift(conn: &Connection, id: &str, staff_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, report_date, period_start_at,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, transferred_to_cashier_shift_id,
                sync_status, created_at, updated_at, is_day_start
            ) VALUES (?1, ?2, 'Ordinary', ?3, ?4, 'cashier', ?5, '2026-09-29', ?5, 0, 0,
                      ?6, 2, NULL, 'pending', ?5, ?5, 0)",
            params![
                id,
                staff_id,
                BRANCH,
                TERMINAL,
                "2026-09-29T08:00:00.000Z",
                status
            ],
        )
        .expect("insert ordinary shift");
    }

    fn confirmed_body(intent: &OpeningIntent, usable: bool) -> Value {
        json!({
            "success": true,
            "synced_count": 1,
            "skipped_count": 0,
            "results": [{
                "shift_id": intent.shift_id,
                "status": "success",
                "financial_opening": {
                    "contract": OPENING_CONTRACT,
                    "opening_key": intent.opening_key,
                    "shift_id": intent.shift_id,
                    "drawer_id": intent.drawer_id,
                    "state": "confirmed",
                    "replayed": false,
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
                        "gift_cash_cents": 0,
                        "ordinary_expected_cents": intent.opening_cents,
                        "expected_cents": intent.opening_cents,
                        "version": 0,
                        "acknowledgement_id": null
                    }
                }
            }]
        })
    }

    fn transport(body: &mut Value) -> &mut Value {
        &mut body["results"][0]["financial_opening"]
    }

    fn assert_retained(conn: &Connection, intent: &OpeningIntent, item: &SyncQueueItem) {
        let current = load_intent(conn, &intent.opening_key).unwrap().unwrap();
        assert_eq!(current.state, OpeningState::Pending);
        assert!(current.same_original(intent));
        assert!(current.owner_terminal_db_id.is_none());
        assert_eq!(mirror_rows(conn), (0, 0));
        assert!(
            !sync_queue::consume_financial_opening_item(conn, item).unwrap(),
            "a pending original is never consumed"
        );
        assert_eq!(queue_rows(conn), 1);
    }

    #[test]
    fn prepare_retains_one_original_intent_and_one_exact_lone_marker_item() {
        let conn = test_conn();
        let intent = prepare(&conn, 15_000);
        assert_eq!(intent.state, OpeningState::Pending);
        assert_eq!(intent.calculation_version, 2);
        assert!(is_calendar_date(&intent.business_date));
        assert_eq!(
            load_intent(&conn, &intent.opening_key).unwrap(),
            Some(intent.clone())
        );
        assert_eq!(queue_rows(&conn), 1);
        assert_eq!(
            mirror_rows(&conn),
            (0, 0),
            "an intent alone never publishes a shift or drawer"
        );

        let (stored, operation): (String, String) = conn
            .query_row(
                "SELECT data, operation FROM parity_sync_queue WHERE id = ?1",
                params![intent.queue_item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(operation, "INSERT");
        let payload: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(payload, build_sync_body(&intent));
        assert_eq!(payload["terminal_id"], json!(TERMINAL));
        let events = payload["events"].as_array().unwrap();
        assert_eq!(
            events.len(),
            1,
            "the financial opening is the lone event of its batch"
        );
        assert_eq!(events[0]["event_type"], "shift_open");
        assert_eq!(events[0]["shift_id"], json!(intent.shift_id));
        assert_eq!(events[0]["idempotency_key"], json!(intent.opening_key));
        let data = &events[0]["data"];
        assert_eq!(
            data["financialOpening"],
            json!({ "drawerId": intent.drawer_id, "openingCents": 15_000, "currency": "EUR" })
        );
        assert!(data.get("financial_opening").is_none());
        assert_eq!(data["opening_cash_cents"], json!(15_000));
        assert_eq!(data["openingCash"], json!(150.0));
        assert_eq!(data["checkInTime"], json!(intent.checked_in_at));
        assert_eq!(data["reportDate"], json!(intent.business_date));
        assert_eq!(data["isDayStart"], json!(intent.is_day_start));
        assert_eq!(data["roleType"], "cashier");
        assert_eq!(data["calculationVersion"], json!(2));
        let lowered = stored.to_ascii_lowercase();
        assert!(!lowered.contains("\"pin\"") && !lowered.contains("session"));
    }

    #[test]
    fn same_key_replay_is_the_original_and_a_changed_tuple_refuses() {
        let conn = test_conn();
        let mut first = request(STAFF, 2_500);
        first.opening_key = Some(Uuid::new_v4().to_string());
        let (original, created) = prepare_opening(&conn, &scope(), &first, Utc::now()).unwrap();
        assert!(created);
        let later = Utc::now() + chrono::Duration::minutes(5);
        let (replayed, created) = prepare_opening(&conn, &scope(), &first, later).unwrap();
        assert!(!created);
        assert_eq!(
            replayed, original,
            "a retry never recalculates ids, time, date or day-start"
        );

        for changed in [
            PrepareRequest {
                opening_cents: 2_501,
                ..first.clone()
            },
            PrepareRequest {
                currency: "USD".to_string(),
                ..first.clone()
            },
            PrepareRequest {
                staff_id: OTHER_STAFF.to_string(),
                ..first.clone()
            },
        ] {
            let error = prepare_opening(&conn, &scope(), &changed, Utc::now()).unwrap_err();
            assert_eq!(error.code, "OPENING_KEY_TUPLE_MISMATCH");
        }
        let foreign = OpeningScope {
            terminal_id: "terminal-other".to_string(),
            ..scope()
        };
        let error = prepare_opening(&conn, &foreign, &first, Utc::now()).unwrap_err();
        assert_eq!(error.code, "OPENING_KEY_TUPLE_MISMATCH");
        assert_eq!(queue_rows(&conn), 1);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM gift_financial_openings"),
            1
        );
    }

    #[test]
    fn a_second_original_an_active_shift_or_an_invalid_tuple_refuses_without_writes() {
        let conn = test_conn();
        prepare(&conn, 0);
        let error =
            prepare_opening(&conn, &scope(), &request(OTHER_STAFF, 100), Utc::now()).unwrap_err();
        assert_eq!(error.code, "OPENING_ALREADY_PENDING");

        let fresh = test_conn();
        insert_ordinary_shift(&fresh, &Uuid::new_v4().to_string(), STAFF, "active");
        let error = prepare_opening(&fresh, &scope(), &request(STAFF, 0), Utc::now()).unwrap_err();
        assert_eq!(error.code, "ACTIVE_LOCAL_SHIFT_EXISTS");
        for (cents, currency) in [(-1, "EUR"), (100_000_000, "EUR"), (10, "eur"), (10, "EURO")] {
            let invalid = PrepareRequest {
                opening_cents: cents,
                currency: currency.to_string(),
                ..request(OTHER_STAFF, 0)
            };
            assert!(prepare_opening(&fresh, &scope(), &invalid, Utc::now()).is_err());
        }
        for payload in [
            json!({ "staffId": STAFF, "openingCents": 10.5, "currency": "EUR" }),
            json!({ "staffId": STAFF, "openingCents": "10", "currency": "EUR" }),
            json!({ "staffId": "staff-1", "openingCents": 10, "currency": "EUR" }),
            json!({ "staffId": STAFF, "openingCents": 10, "currency": "EUR", "openingKey": "k" }),
        ] {
            assert!(PrepareRequest::from_value(&payload).is_err(), "{payload}");
        }
        assert_eq!(
            count(&fresh, "SELECT COUNT(*) FROM gift_financial_openings"),
            0
        );
        assert_eq!(queue_rows(&fresh), 0);
    }

    #[test]
    fn dispatch_requires_the_live_original_cashier_and_sends_only_the_stored_original() {
        let _auth = auth_serial();
        let conn = test_conn();
        let intent = prepare(&conn, 1_000);
        let item = claim(&conn);
        assert!(is_financial_opening_item(&item));
        assert_eq!(item.id, intent.queue_item_id);
        let stored = stored_item_payload(&item);
        let plan = |conn: &Connection, scope: Option<&OpeningScope>| {
            plan_dispatch(conn, &item.id, &item.record_id, &stored, scope, Utc::now())
        };
        let reauth = DispatchPlan::Retain {
            code: CODE_REAUTH_REQUIRED,
        };

        assert_eq!(plan(&conn, Some(&scope())), reauth, "absent after restart");
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, -60));
        assert_eq!(plan(&conn, Some(&scope())), reauth, "expired");
        assert!(
            hosted_session(&intent.opening_key).is_none(),
            "an expired session is dropped"
        );
        store_hosted_session(
            &intent.opening_key,
            session_for(&intent, OTHER_STAFF, 3_600),
        );
        assert_eq!(plan(&conn, Some(&scope())), reauth, "another cashier");

        let live = session_for(&intent, STAFF, 3_600);
        store_hosted_session(&intent.opening_key, live.clone());
        let foreign = OpeningScope {
            branch_id: Uuid::new_v4().to_string(),
            ..scope()
        };
        let changed = DispatchPlan::Retain {
            code: "OPENING_SCOPE_CHANGED",
        };
        assert_eq!(plan(&conn, Some(&foreign)), changed);
        assert_eq!(plan(&conn, None), changed);
        let mut tampered = stored.clone();
        tampered["events"][0]["data"]["financialOpening"]["openingCents"] = json!(1_001);
        assert_eq!(
            plan_dispatch(
                &conn,
                &item.id,
                &item.record_id,
                &tampered,
                Some(&scope()),
                Utc::now()
            ),
            DispatchPlan::Retain {
                code: "OPENING_PAYLOAD_MISMATCH"
            }
        );

        match plan(&conn, Some(&scope())) {
            DispatchPlan::Send {
                body,
                staff_session_id,
            } => {
                assert_eq!(body, stored);
                assert_eq!(staff_session_id, live.session_id);
                assert!(
                    !body.to_string().contains(&live.session_id),
                    "the session rides only the header"
                );
            }
            other => panic!("expected a send, got {other:?}"),
        }

        let retained = settle_item(&conn, &item, Some(CODE_REAUTH_REQUIRED)).unwrap();
        assert!(!retained.consumed);
        let (status, attempts, data, error): (String, i64, String, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, data, error_message FROM parity_sync_queue WHERE id = ?1",
                params![item.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(attempts, item.attempts, "retention burns no attempt");
        assert_eq!(data, item.data);
        assert_eq!(error.as_deref(), Some(CODE_REAUTH_REQUIRED));
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn same_cashier_renewal_changes_only_the_dispatch_header() {
        let _auth = auth_serial();
        let conn = test_conn();
        let intent = prepare(&conn, 500);
        let item = claim(&conn);
        let stored = stored_item_payload(&item);
        let mut sent = Vec::new();
        for _ in 0..2 {
            store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
            match plan_dispatch(
                &conn,
                &item.id,
                &item.record_id,
                &stored,
                Some(&scope()),
                Utc::now(),
            ) {
                DispatchPlan::Send {
                    body,
                    staff_session_id,
                } => sent.push((body, staff_session_id)),
                other => panic!("expected a send, got {other:?}"),
            }
        }
        assert_eq!(sent[0].0, sent[1].0);
        assert_ne!(sent[0].1, sent[1].1);
        assert_eq!(
            load_intent(&conn, &intent.opening_key).unwrap(),
            Some(intent.clone())
        );
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn a_lost_response_and_restart_resend_the_same_original_after_same_cashier_reauth() {
        let _auth = auth_serial();
        let conn = test_conn();
        let intent = prepare(&conn, 4_200);
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        let first = claim(&conn);
        let first_body = match plan_dispatch(
            &conn,
            &first.id,
            &first.record_id,
            &stored_item_payload(&first),
            Some(&scope()),
            Utc::now(),
        ) {
            DispatchPlan::Send { body, .. } => body,
            other => panic!("expected a send, got {other:?}"),
        };
        let lost = AdminFetchError::transport("connection reset");
        let DispatchOutcome::Retained { code } =
            apply_sync_result(&conn, &intent.opening_key, Err(&lost), Utc::now())
        else {
            panic!("a lost response never confirms");
        };
        assert_eq!(code, "TRANSPORT_UNCONFIRMED");
        assert!(
            !settle_item(&conn, &first, Some(code.as_str()))
                .unwrap()
                .consumed
        );

        invalidate_hosted_cashier(&intent.opening_key);
        conn.execute(
            "UPDATE parity_sync_queue SET next_retry_at = NULL WHERE id = ?1",
            params![first.id],
        )
        .unwrap();
        let second = claim(&conn);
        assert_eq!(second.id, first.id);
        let stored = stored_item_payload(&second);
        assert_eq!(
            plan_dispatch(
                &conn,
                &second.id,
                &second.record_id,
                &stored,
                Some(&scope()),
                Utc::now()
            ),
            DispatchPlan::Retain {
                code: CODE_REAUTH_REQUIRED
            }
        );
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        match plan_dispatch(
            &conn,
            &second.id,
            &second.record_id,
            &stored,
            Some(&scope()),
            Utc::now(),
        ) {
            DispatchPlan::Send { body, .. } => {
                assert_eq!(
                    body, first_body,
                    "no retry id, new key or recalculated tuple"
                )
            }
            other => panic!("expected a send, got {other:?}"),
        }
        assert_eq!(queue_rows(&conn), 1);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM gift_financial_openings"),
            1
        );
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn unconfirmed_or_mismatched_results_retain_the_original_without_adoption() {
        let conn = test_conn();
        let intent = prepare(&conn, 0);
        let item = claim(&conn);
        let mut cases: Vec<(Value, &str)> = vec![(
            json!({
                "success": false,
                "synced_count": 0,
                "skipped_count": 0,
                "results": [{
                    "shift_id": intent.shift_id,
                    "status": "error",
                    "code": "GIFT_CARD_OPENING_UNVERIFIED",
                    "message": "Financial opening unconfirmed",
                    "financial_opening": {
                        "contract": OPENING_CONTRACT,
                        "state": "pending",
                        "opening_key": intent.opening_key,
                        "shift_id": intent.shift_id,
                        "drawer_id": intent.drawer_id,
                        "code": "GIFT_CARD_OPENING_UNVERIFIED"
                    }
                }]
            }),
            "GIFT_CARD_OPENING_UNVERIFIED",
        )];
        let variant = |edit: &dyn Fn(&mut Value)| {
            let mut body = confirmed_body(&intent, true);
            edit(&mut body);
            body
        };
        cases.push((
            variant(&|b| b["success"] = json!(false)),
            "UNCONFIRMED_ENVELOPE",
        ));
        cases.push((
            variant(&|b| {
                b["results"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("financial_opening");
            }),
            "FINANCIAL_OPENING_ABSENT",
        ));
        cases.push((
            variant(&|b| transport(b)["staff_session_id"] = json!("x")),
            "MALFORMED_CONFIRMATION",
        ));
        cases.push((
            variant(&|b| transport(b)["opening_cents"] = json!(1)),
            "CONFIRMATION_TUPLE_MISMATCH",
        ));
        cases.push((
            variant(&|b| transport(b)["business_date"] = json!("2000-01-01")),
            "CONFIRMATION_TUPLE_MISMATCH",
        ));
        cases.push((
            variant(&|b| transport(b)["is_day_start"] = json!(!intent.is_day_start)),
            "CONFIRMATION_TUPLE_MISMATCH",
        ));
        cases.push((
            variant(&|b| transport(b)["branch_id"] = json!(Uuid::new_v4().to_string())),
            "CONFIRMATION_TUPLE_MISMATCH",
        ));
        cases.push((
            variant(&|b| transport(b)["terminal_id"] = json!(OWNER_DB)),
            "CONFIRMATION_TUPLE_MISMATCH",
        ));
        cases.push((
            variant(&|b| transport(b)["opening_key"] = json!(Uuid::new_v4().to_string())),
            "FOREIGN_CONFIRMATION",
        ));
        cases.push((
            variant(&|b| b["results"][0]["shift_id"] = json!(Uuid::new_v4().to_string())),
            "FOREIGN_RESULT",
        ));
        cases.push((
            variant(&|b| transport(b)["drawer"]["expected_cents"] = json!(1)),
            "DRAWER_NOT_CONSERVED",
        ));
        cases.push((
            variant(&|b| {
                let drawer = &mut transport(b)["drawer"];
                drawer["gift_cash_cents"] = json!(500);
                drawer["expected_cents"] = json!(500);
                drawer["version"] = json!(1);
            }),
            "DRAWER_NOT_CONSERVED",
        ));
        cases.push((
            variant(&|b| transport(b)["drawer"]["drawer_id"] = json!(Uuid::new_v4().to_string())),
            "DRAWER_IDENTITY_MISMATCH",
        ));
        cases.push((
            variant(&|b| transport(b)["calculation_version"] = json!(1)),
            "MALFORMED_CONFIRMATION",
        ));
        cases.push((
            variant(&|b| transport(b)["role_type"] = json!("manager")),
            "MALFORMED_CONFIRMATION",
        ));
        cases.push((
            variant(&|b| transport(b)["owner_terminal_id"] = json!(TERMINAL)),
            "MALFORMED_CONFIRMATION",
        ));
        cases.push((
            json!({ "success": true, "results": [] }),
            "MALFORMED_RESPONSE",
        ));
        cases.push((json!({ "success": true }), "MALFORMED_RESPONSE"));

        for (body, expected) in cases {
            let outcome = apply_sync_result(&conn, &intent.opening_key, Ok(&body), Utc::now());
            assert_eq!(
                outcome,
                DispatchOutcome::Retained {
                    code: expected.to_string()
                },
                "{body}"
            );
            assert_retained(&conn, &intent, &item);
        }
        for (error, expected) in [
            (AdminFetchError::with_status("upstream", 500), "HTTP_500"),
            (AdminFetchError::with_status("conflict", 409), "HTTP_409"),
            (
                AdminFetchError::transport("offline"),
                "TRANSPORT_UNCONFIRMED",
            ),
        ] {
            let outcome = apply_sync_result(&conn, &intent.opening_key, Err(&error), Utc::now());
            assert_eq!(
                outcome,
                DispatchOutcome::Retained {
                    code: expected.to_string()
                }
            );
            assert_retained(&conn, &intent, &item);
        }
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        let refused = AdminFetchError::with_status("expired", 401);
        let outcome = apply_sync_result(&conn, &intent.opening_key, Err(&refused), Utc::now());
        assert_eq!(
            outcome,
            DispatchOutcome::Retained {
                code: CODE_REAUTH_REQUIRED.to_string()
            }
        );
        assert!(
            hosted_session(&intent.opening_key).is_none(),
            "a refused session is dropped"
        );
        assert_retained(&conn, &intent, &item);
    }

    #[test]
    fn exact_confirmation_adopts_the_original_once_before_claim_fenced_consumption() {
        let conn = test_conn();
        let intent = prepare(&conn, 0);
        let item = claim(&conn);
        let outcome = apply_sync_result(
            &conn,
            &intent.opening_key,
            Ok(&confirmed_body(&intent, true)),
            Utc::now(),
        );
        assert_eq!(
            outcome,
            DispatchOutcome::Confirmed {
                state: OpeningState::ConfirmedUsable
            }
        );
        assert_eq!(queue_rows(&conn), 1, "adoption precedes consumption");
        assert_eq!(mirror_rows(&conn), (1, 1));
        let (shift_id, status, sync_status, cents, day_start): (String, String, String, i64, bool) = conn
            .query_row(
                "SELECT id, status, sync_status, opening_cash_amount_cents, is_day_start FROM staff_shifts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(shift_id, intent.shift_id);
        assert_eq!(status, "active");
        assert_eq!(sync_status, "synced");
        assert_eq!(cents, 0);
        assert_eq!(day_start, intent.is_day_start);
        let (drawer_id, drawer_shift): (String, String) = conn
            .query_row(
                "SELECT id, staff_shift_id FROM cash_drawer_sessions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(drawer_id, intent.drawer_id);
        assert_eq!(drawer_shift, intent.shift_id);
        let confirmed = load_intent(&conn, &intent.opening_key).unwrap().unwrap();
        assert_eq!(confirmed.state, OpeningState::ConfirmedUsable);
        assert_eq!(confirmed.owner_terminal_db_id.as_deref(), Some(OWNER_DB));
        assert_eq!(confirmed.source_terminal_db_id.as_deref(), Some(SOURCE_DB));
        assert_eq!(
            confirmed.drawer,
            Some(DrawerState {
                version: 0,
                acknowledgement_id: None,
                gift_cash_cents: 0,
                ordinary_expected_cents: 0,
                expected_cents: 0,
            })
        );

        let stale = SyncQueueItem {
            claim_generation: item.claim_generation - 1,
            ..item.clone()
        };
        assert!(
            !settle_item(&conn, &stale, None).unwrap().consumed,
            "a stale claim never consumes"
        );
        assert!(settle_item(&conn, &item, None).unwrap().consumed);
        assert_eq!(queue_rows(&conn), 0);

        let ack = Uuid::new_v4().to_string();
        let mut advanced = confirmed_body(&intent, true);
        transport(&mut advanced)["replayed"] = json!(true);
        {
            let drawer = &mut transport(&mut advanced)["drawer"];
            drawer["gift_cash_cents"] = json!(2_000);
            drawer["expected_cents"] = json!(2_000);
            drawer["version"] = json!(3);
            drawer["acknowledgement_id"] = json!(ack);
        }
        let usable = DispatchOutcome::Confirmed {
            state: OpeningState::ConfirmedUsable,
        };
        assert_eq!(
            apply_sync_result(&conn, &intent.opening_key, Ok(&advanced), Utc::now()),
            usable
        );
        assert_eq!(
            apply_sync_result(
                &conn,
                &intent.opening_key,
                Ok(&confirmed_body(&intent, true)),
                Utc::now()
            ),
            usable
        );
        assert_eq!(mirror_rows(&conn), (1, 1), "a replay never adopts twice");
        let drawer = load_intent(&conn, &intent.opening_key)
            .unwrap()
            .unwrap()
            .drawer
            .unwrap();
        assert_eq!(
            drawer.version, 3,
            "an older replay never regresses the drawer"
        );
        assert_eq!(drawer.acknowledgement_id.as_deref(), Some(ack.as_str()));
        assert_eq!(drawer.gift_cash_cents, 2_000);

        let other = Uuid::new_v4().to_string();
        let mut foreign_owner = confirmed_body(&intent, true);
        transport(&mut foreign_owner)["owner_terminal_id"] = json!(other);
        transport(&mut foreign_owner)["drawer"]["owner_terminal_id"] = json!(other);
        assert_eq!(
            apply_sync_result(&conn, &intent.opening_key, Ok(&foreign_owner), Utc::now()),
            DispatchOutcome::Retained {
                code: "FOREIGN_CONFIRMATION".to_string()
            }
        );
    }

    #[test]
    fn a_confirmed_unusable_original_is_retained_proof_and_never_reopens() {
        let conn = test_conn();
        let intent = prepare(&conn, 700);
        let item = claim(&conn);
        let unusable = DispatchOutcome::Confirmed {
            state: OpeningState::ConfirmedUnusable,
        };
        assert_eq!(
            apply_sync_result(
                &conn,
                &intent.opening_key,
                Ok(&confirmed_body(&intent, false)),
                Utc::now()
            ),
            unusable
        );
        assert_eq!(
            apply_sync_result(
                &conn,
                &intent.opening_key,
                Ok(&confirmed_body(&intent, true)),
                Utc::now()
            ),
            unusable
        );
        assert_eq!(mirror_rows(&conn), (0, 0));
        assert!(settle_item(&conn, &item, None).unwrap().consumed);
        let row = load_intent(&conn, &intent.opening_key).unwrap().unwrap();
        assert_eq!(row.state, OpeningState::ConfirmedUnusable);
        assert!(row.adopted_at.is_none());
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::OpeningUnusable
        );
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn a_local_collision_or_failed_adoption_rolls_back_and_retains_even_at_zero() {
        let conn = test_conn();
        let intent = prepare(&conn, 0);
        let item = claim(&conn);
        insert_ordinary_shift(&conn, &intent.shift_id, OTHER_STAFF, "closed");
        assert_eq!(
            apply_sync_result(
                &conn,
                &intent.opening_key,
                Ok(&confirmed_body(&intent, true)),
                Utc::now()
            ),
            DispatchOutcome::Retained {
                code: "LOCAL_ID_COLLISION".to_string()
            }
        );
        let row = load_intent(&conn, &intent.opening_key).unwrap().unwrap();
        assert_eq!(row.state, OpeningState::Pending);
        assert!(
            row.owner_terminal_db_id.is_none(),
            "nothing persists without its adoption"
        );
        assert!(!settle_item(&conn, &item, None).unwrap().consumed);

        let conn = test_conn();
        let intent = prepare(&conn, 900);
        let item = claim(&conn);
        conn.execute_batch(
            "CREATE TRIGGER refuse_drawer BEFORE INSERT ON cash_drawer_sessions
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .unwrap();
        assert_eq!(
            apply_sync_result(
                &conn,
                &intent.opening_key,
                Ok(&confirmed_body(&intent, true)),
                Utc::now()
            ),
            DispatchOutcome::Retained {
                code: "LOCAL_ADOPTION_FAILED".to_string()
            }
        );
        assert_eq!(
            mirror_rows(&conn),
            (0, 0),
            "the shift insert rolled back with the drawer"
        );
        assert!(!settle_item(&conn, &item, None).unwrap().consumed);
        conn.execute_batch("DROP TRIGGER refuse_drawer;").unwrap();
        assert_eq!(
            apply_sync_result(
                &conn,
                &intent.opening_key,
                Ok(&confirmed_body(&intent, true)),
                Utc::now()
            ),
            DispatchOutcome::Confirmed {
                state: OpeningState::ConfirmedUsable
            }
        );
        assert_eq!(mirror_rows(&conn), (1, 1));
        assert!(settle_item(&conn, &item, None).unwrap().consumed);
    }

    #[test]
    fn hosted_check_in_must_issue_a_live_session_for_the_selected_cashier_and_scope() {
        let now = Utc::now();
        let session_id = Uuid::new_v4().to_string();
        let issued = |expires: DateTime<Utc>| {
            json!({
                "success": true,
                "session_id": session_id,
                "staff_id": STAFF,
                "role_name": "manager",
                "branch_id": BRANCH,
                "organization_id": ORG,
                "permissions": [],
                "session": {
                    "id": session_id,
                    "staff_id": STAFF,
                    "role": "manager",
                    "permissions": [],
                    "terminal_id": TERMINAL,
                    "organization_id": ORG,
                    "branch_id": BRANCH,
                    "login_at": normalize_instant(now),
                    "expires_at": normalize_instant(expires)
                },
                "staff": { "id": STAFF }
            })
        };
        let live = now + chrono::Duration::hours(8);
        let session = validate_check_in_response(&issued(live), &scope(), STAFF, now)
            .expect("a role name never decides the operational cashier role");
        assert_eq!(session.session_id, session_id);
        assert!(session.live(now));

        let edited = |edit: &dyn Fn(&mut Value)| {
            let mut body = issued(live);
            edit(&mut body);
            body
        };
        for (body, expected) in [
            (
                json!({ "success": false, "error": "Invalid PIN" }),
                "HOSTED_CHECK_IN_REFUSED",
            ),
            (
                issued(now - chrono::Duration::minutes(1)),
                "HOSTED_SESSION_EXPIRED",
            ),
            (
                edited(&|b| b["session"]["staff_id"] = json!(OTHER_STAFF)),
                "HOSTED_STAFF_MISMATCH",
            ),
            (
                edited(&|b| b["staff_id"] = json!(OTHER_STAFF)),
                "HOSTED_STAFF_MISMATCH",
            ),
            (
                edited(&|b| b["session"]["terminal_id"] = json!("terminal-other")),
                "HOSTED_SCOPE_MISMATCH",
            ),
            (
                edited(&|b| b["organization_id"] = json!(Uuid::new_v4().to_string())),
                "HOSTED_SCOPE_MISMATCH",
            ),
            (
                edited(&|b| b["session"]["id"] = json!(Uuid::new_v4().to_string())),
                "HOSTED_SESSION_MISMATCH",
            ),
            (
                edited(&|b| {
                    b["session"].as_object_mut().unwrap().remove("expires_at");
                }),
                "HOSTED_CHECK_IN_MALFORMED",
            ),
        ] {
            assert_eq!(
                validate_check_in_response(&body, &scope(), STAFF, now).unwrap_err(),
                expected,
                "{body}"
            );
        }

        let body = build_check_in_body(STAFF, "1234".to_string());
        let mut keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["pin", "sessionHours", "staffId"]);
        assert!(transient_pin(&json!({ "pin": "12a4" })).is_err());
        assert!(transient_pin(&json!({ "pin": "123" })).is_err());
        assert!(transient_pin(&json!({})).is_err());
        assert_eq!(
            transient_pin(&json!({ "pin": "123456" })).unwrap(),
            "123456"
        );
    }

    #[test]
    fn the_scoped_hosted_accessor_fails_closed_until_a_usable_original_and_live_session() {
        let _auth = auth_serial();
        let conn = test_conn();
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::NoOriginalOpening
        );
        let intent = prepare(&conn, 100);
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::OpeningPending
        );
        let item = claim(&conn);
        apply_sync_result(
            &conn,
            &intent.opening_key,
            Ok(&confirmed_body(&intent, true)),
            Utc::now(),
        );
        assert!(settle_item(&conn, &item, None).unwrap().consumed);

        let access = scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now())
            .expect("a usable original with a live session");
        assert_eq!(access.opening_key(), intent.opening_key);
        assert_eq!(access.shift_id(), intent.shift_id);
        assert_eq!(access.drawer_id(), intent.drawer_id);
        assert_eq!(access.scope(), &cashier_scope());
        assert!(access.expires_at() > Utc::now());
        assert!(!format!("{access:?}").contains(access.staff_session_header()));

        let other_cashier = HostedCashierScope {
            staff_id: OTHER_STAFF.to_string(),
            ..cashier_scope()
        };
        assert_eq!(
            scoped_hosted_cashier(&conn, &other_cashier, Utc::now()).unwrap_err(),
            HostedAccessError::NoOriginalOpening
        );
        let foreign = HostedCashierScope {
            branch_id: Uuid::new_v4().to_string(),
            ..cashier_scope()
        };
        assert_eq!(
            scoped_hosted_cashier(&conn, &foreign, Utc::now()).unwrap_err(),
            HostedAccessError::NoOriginalOpening
        );
        let later = Utc::now() + chrono::Duration::hours(2);
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), later).unwrap_err(),
            HostedAccessError::Expired
        );
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::ReauthRequired,
            "an expired or restarted session needs the same cashier again"
        );
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        conn.execute(
            "UPDATE staff_shifts SET status = 'closed' WHERE id = ?1",
            params![intent.shift_id],
        )
        .unwrap();
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::LocalShiftNotActive
        );
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn the_view_and_retained_rows_carry_no_pin_or_session() {
        let _auth = auth_serial();
        let conn = test_conn();
        let intent = prepare(&conn, 1_234);
        let session = session_for(&intent, STAFF, 3_600);
        store_hosted_session(&intent.opening_key, session.clone());
        let view = intent_view(&intent, false, Utc::now());
        assert_eq!(view["hostedAuthorization"]["state"], "authorized");
        assert!(!view.to_string().contains(&session.session_id));
        let mut stmt = conn
            .prepare("PRAGMA table_info(gift_financial_openings)")
            .unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(columns
            .iter()
            .all(|column| !column.contains("pin") && !column.contains("session")));
        let queued: String = conn
            .query_row(
                "SELECT data FROM parity_sync_queue WHERE id = ?1",
                params![intent.queue_item_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!queued.contains(&session.session_id));
        assert!(!format!("{session:?}").contains(&session.session_id));
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn markerless_ordinary_items_never_take_the_financial_branch() {
        let conn = test_conn();
        let shift_id = Uuid::new_v4().to_string();
        let ordinary = json!({
            "terminal_id": TERMINAL,
            "branch_id": BRANCH,
            "events": [{ "event_type": "shift_open", "shift_id": shift_id, "data": { "staffId": STAFF } }]
        });
        sync_queue::enqueue_payload_item(
            &conn,
            "staff_shifts",
            &shift_id,
            "INSERT",
            &ordinary,
            None,
            Some("shifts"),
            None,
            None,
        )
        .unwrap();
        let item = claim(&conn);
        assert!(!is_financial_opening_item(&item));
        assert!(sync_queue::consume_financial_opening_item(&conn, &item).is_err());
        assert!(sync_queue::retain_financial_opening_item(&conn, &item, "X").is_err());
        assert_eq!(
            plan_dispatch(
                &conn,
                &item.id,
                &item.record_id,
                &stored_item_payload(&item),
                Some(&scope()),
                Utc::now()
            ),
            DispatchPlan::Retain {
                code: "OPENING_INTENT_MISSING"
            }
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM gift_financial_openings"),
            0
        );
    }

    #[test]
    fn renderer_queue_paths_never_peek_claim_or_clear_the_native_original() {
        let conn = test_conn();
        let intent = prepare(&conn, 300);
        assert!(sync_queue::renderer_peek(&conn).unwrap().is_none());
        assert!(sync_queue::renderer_dequeue(&conn).unwrap().is_none());
        sync_queue::renderer_clear(&conn).unwrap();
        assert_eq!(
            queue_rows(&conn),
            1,
            "a renderer clear preserves the queued original"
        );
        let item = claim(&conn);
        assert_eq!(
            item.id, intent.queue_item_id,
            "only the native loop claims it"
        );

        assert!(
            !settle_item(&conn, &item, Some(CODE_REAUTH_REQUIRED))
                .unwrap()
                .consumed
        );
        let row = |conn: &Connection| -> (String, i64, Option<String>, Option<String>) {
            conn.query_row(
                "SELECT status, attempts, error_message, next_retry_at
                   FROM parity_sync_queue WHERE id = ?1",
                params![item.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap()
        };
        let retained = row(&conn);
        let _ = sync_queue::renderer_retry_item(&conn, &item.id);
        let _ = sync_queue::renderer_retry_items_by_module(&conn, "shifts");
        assert!(
            sync_queue::renderer_retryable_item_ids_by_module(&conn, "shifts", 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            row(&conn),
            retained,
            "renderer retries never reschedule the retained original"
        );
    }

    #[test]
    fn a_deferred_first_issuance_after_a_dedicated_clear_prepares_and_installs_nothing() {
        let _auth = auth_serial();
        let conn = test_conn();
        let target = IssuanceTarget::New(request(STAFF, 1_000));
        // The fence is captured before the hosted await; the dedicated clear
        // (e.g. logout) runs while the first check-in reply is still in flight.
        let fence = capture_issuance_fence();
        assert_eq!(clear_authorizations(), json!({ "success": true }));
        let refused = finalize_issuance(
            &conn,
            fence,
            &scope(),
            &target,
            issued_session(&scope(), STAFF),
            Utc::now(),
        )
        .unwrap_err();
        assert_eq!(refused.code, "HOSTED_AUTHORIZATION_SUPERSEDED");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM gift_financial_openings"),
            0
        );
        assert_eq!(queue_rows(&conn), 0);
        assert_eq!(mirror_rows(&conn), (0, 0));

        // Control: the same scope with no clear since the fence prepares once
        // and installs the credential without exposing it.
        let fence = capture_issuance_fence();
        let session = issued_session(&scope(), STAFF);
        let intent =
            finalize_issuance(&conn, fence, &scope(), &target, session.clone(), Utc::now())
                .expect("a fresh first issuance");
        assert_eq!(intent.state, OpeningState::Pending);
        assert!(intent.auth_requirement.is_none());
        assert_eq!(queue_rows(&conn), 1);
        assert_eq!(
            hosted_session(&intent.opening_key).unwrap().session_id,
            session.session_id
        );
        let listed = statuses(&conn, Some(intent.opening_key.as_str()));
        assert_eq!(listed[0]["hostedAuthorization"]["state"], "authorized");
        assert!(!Value::Array(listed)
            .to_string()
            .contains(&session.session_id));

        // A later clear drops the credential only: the durable original and
        // its exact queued body stay, now awaiting reauthorization.
        clear_authorizations();
        assert!(hosted_session(&intent.opening_key).is_none());
        let kept = load_intent(&conn, &intent.opening_key).unwrap().unwrap();
        assert!(kept.same_original(&intent));
        assert_eq!(kept.state, OpeningState::Pending);
        let item = claim(&conn);
        let stored = stored_item_payload(&item);
        assert_eq!(stored, build_sync_body(&intent));
        assert_eq!(
            plan_dispatch(
                &conn,
                &item.id,
                &item.record_id,
                &stored,
                Some(&scope()),
                Utc::now()
            ),
            DispatchPlan::Retain {
                code: CODE_REAUTH_REQUIRED
            }
        );
    }

    #[test]
    fn a_deferred_renewal_never_installs_after_invalidation_supersession_or_scope_change() {
        let _auth = auth_serial();
        let conn = test_conn();
        let intent = prepare(&conn, 600);
        let target = IssuanceTarget::Existing(intent.clone());
        let finalize = |fence: IssuanceFence, session: HostedCashierSession| {
            finalize_issuance(&conn, fence, &scope(), &target, session, Utc::now())
        };
        let superseded = "HOSTED_AUTHORIZATION_SUPERSEDED";

        // Native invalidation of this original, then the dedicated clear, each
        // while a renewal reply is still in flight.
        let fence = capture_issuance_fence();
        invalidate_hosted_cashier(&intent.opening_key);
        assert_eq!(
            finalize(fence, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            superseded
        );
        let fence = capture_issuance_fence();
        clear_authorizations();
        assert_eq!(
            finalize(fence, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            superseded
        );
        assert!(hosted_session(&intent.opening_key).is_none());

        // A newer same-cashier authorization completed first; the slower,
        // older reply never overwrites it.
        let older = capture_issuance_fence();
        let newer = capture_issuance_fence();
        let newest = issued_session(&scope(), STAFF);
        finalize(newer, newest.clone()).expect("the newer authorization installs");
        assert_eq!(
            finalize(older, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            superseded
        );
        assert_eq!(
            hosted_session(&intent.opening_key).unwrap().session_id,
            newest.session_id
        );

        // The trusted terminal tuple changes during the await: another org
        // reusing this public terminal id, another branch or another terminal.
        for (setting, original) in [
            ("organization_id", ORG),
            ("branch_id", BRANCH),
            ("terminal_id", TERMINAL),
        ] {
            let fence = capture_issuance_fence();
            crate::db::set_setting(&conn, "terminal", setting, &Uuid::new_v4().to_string())
                .unwrap();
            let refused = finalize(fence, issued_session(&scope(), STAFF)).unwrap_err();
            assert_eq!(refused.code, "OPENING_SCOPE_CHANGED", "{setting}");
            assert_eq!(
                hosted_session(&intent.opening_key).unwrap().session_id,
                newest.session_id
            );
            crate::db::set_setting(&conn, "terminal", setting, original).unwrap();
        }

        // The original key, tuple, body and queue item are untouched.
        let kept = load_intent(&conn, &intent.opening_key).unwrap().unwrap();
        assert!(kept.same_original(&intent));
        assert_eq!(kept.state, OpeningState::Pending);
        assert_eq!(queue_rows(&conn), 1);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM gift_financial_openings"),
            1
        );
        let item = claim(&conn);
        assert_eq!(stored_item_payload(&item), build_sync_body(&intent));

        // Control: an unchanged scope renews and clears the requirement.
        let renewed = issued_session(&scope(), STAFF);
        let fresh =
            finalize(capture_issuance_fence(), renewed.clone()).expect("same-scope renewal");
        assert!(fresh.auth_requirement.is_none());
        assert_eq!(
            hosted_session(&intent.opening_key).unwrap().session_id,
            renewed.session_id
        );
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn current_usability_requires_the_trusted_scope_and_the_open_original_mirror() {
        let _auth = auth_serial();
        let conn = test_conn();
        let intent = prepare(&conn, 300);
        let pending = statuses(&conn, None);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["state"], "pending");
        assert_eq!(
            pending[0]["usable"], false,
            "a pending original has no active mirror"
        );
        let item = claim(&conn);
        apply_sync_result(
            &conn,
            &intent.opening_key,
            Ok(&confirmed_body(&intent, true)),
            Utc::now(),
        );
        assert!(settle_item(&conn, &item, None).unwrap().consumed);
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        let observe = |conn: &Connection| {
            let keyed = statuses(conn, Some(intent.opening_key.as_str()));
            let access = scoped_hosted_cashier(conn, &cashier_scope(), Utc::now()).map(|_| ());
            (
                keyed.first().map(|view| view["usable"].clone()),
                statuses(conn, None).len(),
                access,
            )
        };
        let open: (Option<Value>, usize, Result<(), HostedAccessError>) =
            (Some(json!(true)), 1, Ok(()));
        let not_open: (Option<Value>, usize, Result<(), HostedAccessError>) = (
            Some(json!(false)),
            0,
            Err(HostedAccessError::LocalShiftNotActive),
        );
        assert_eq!(observe(&conn), open, "matching original mirrors");

        for (broken, restored) in [
            (
                "UPDATE cash_drawer_sessions SET closed_at = '2026-09-29T20:00:00.000Z'"
                    .to_string(),
                "UPDATE cash_drawer_sessions SET closed_at = NULL".to_string(),
            ),
            (
                format!("UPDATE cash_drawer_sessions SET cashier_id = '{OTHER_STAFF}'"),
                format!("UPDATE cash_drawer_sessions SET cashier_id = '{STAFF}'"),
            ),
            (
                "UPDATE cash_drawer_sessions SET terminal_id = 'terminal-other'".to_string(),
                format!("UPDATE cash_drawer_sessions SET terminal_id = '{TERMINAL}'"),
            ),
            (
                "UPDATE staff_shifts SET terminal_id = 'terminal-other'".to_string(),
                format!("UPDATE staff_shifts SET terminal_id = '{TERMINAL}'"),
            ),
            (
                "UPDATE staff_shifts SET status = 'closed'".to_string(),
                "UPDATE staff_shifts SET status = 'active'".to_string(),
            ),
        ] {
            conn.execute_batch(&broken).unwrap();
            assert_eq!(observe(&conn), not_open, "{broken}");
            let renewal = finalize_issuance(
                &conn,
                capture_issuance_fence(),
                &scope(),
                &IssuanceTarget::Existing(intent.clone()),
                issued_session(&scope(), STAFF),
                Utc::now(),
            );
            assert_eq!(renewal.unwrap_err().code, "OPENING_UNUSABLE", "{broken}");
            conn.execute_batch(&restored).unwrap();
            assert_eq!(observe(&conn), open, "{restored}");
        }

        // The same public terminal id reused under another organization, or
        // another branch: no keyed detail, no listing and no admission.
        for (setting, original) in [("organization_id", ORG), ("branch_id", BRANCH)] {
            let foreign = Uuid::new_v4().to_string();
            crate::db::set_setting(&conn, "terminal", setting, &foreign).unwrap();
            assert_eq!(
                observe(&conn),
                (None, 0, Err(HostedAccessError::NoOriginalOpening)),
                "{setting}"
            );
            let mut reused = cashier_scope();
            if setting == "organization_id" {
                reused.organization_id = foreign;
            } else {
                reused.branch_id = foreign;
            }
            assert_eq!(
                scoped_hosted_cashier(&conn, &reused, Utc::now()).unwrap_err(),
                HostedAccessError::NoOriginalOpening
            );
            crate::db::set_setting(&conn, "terminal", setting, original).unwrap();
        }
        assert_eq!(observe(&conn), open);

        conn.execute(
            "DELETE FROM cash_drawer_sessions WHERE id = ?1",
            params![intent.drawer_id],
        )
        .unwrap();
        assert_eq!(observe(&conn), not_open, "a missing original drawer");
        invalidate_hosted_cashier(&intent.opening_key);
    }

    #[test]
    fn a_later_strict_unusable_proof_permanently_demotes_a_usable_original() {
        let _auth = auth_serial();
        let conn = test_conn();
        let intent = prepare(&conn, 0);
        let item = claim(&conn);
        let usable = DispatchOutcome::Confirmed {
            state: OpeningState::ConfirmedUsable,
        };
        let unusable = DispatchOutcome::Confirmed {
            state: OpeningState::ConfirmedUnusable,
        };
        let apply =
            |body: &Value| apply_sync_result(&conn, &intent.opening_key, Ok(body), Utc::now());
        assert_eq!(apply(&confirmed_body(&intent, true)), usable);
        assert!(settle_item(&conn, &item, None).unwrap().consumed);
        let adopted = load_intent(&conn, &intent.opening_key).unwrap().unwrap();
        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        assert!(scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).is_ok());

        let mut closed = confirmed_body(&intent, false);
        transport(&mut closed)["replayed"] = json!(true);
        assert_eq!(apply(&closed), unusable);
        assert!(
            hosted_session(&intent.opening_key).is_none(),
            "its private authorization is invalidated"
        );

        // Older usable replays, even one claiming a later drawer, never
        // promote, reopen, re-adopt or import.
        let mut stale = confirmed_body(&intent, true);
        transport(&mut stale)["drawer"]["version"] = json!(9);
        assert_eq!(apply(&stale), unusable);
        assert_eq!(apply(&confirmed_body(&intent, true)), unusable);
        let demoted = load_intent(&conn, &intent.opening_key).unwrap().unwrap();
        assert_eq!(demoted.state, OpeningState::ConfirmedUnusable);
        assert!(demoted.same_original(&intent));
        assert_eq!(
            (
                &demoted.owner_terminal_db_id,
                &demoted.source_terminal_db_id,
                &demoted.drawer
            ),
            (
                &adopted.owner_terminal_db_id,
                &adopted.source_terminal_db_id,
                &adopted.drawer
            )
        );
        assert_eq!(
            (&demoted.confirmed_at, &demoted.adopted_at),
            (&adopted.confirmed_at, &adopted.adopted_at)
        );
        let (server_usable, proof): (i64, String) = conn
            .query_row(
                "SELECT server_usable, confirmation_json FROM gift_financial_openings WHERE opening_key = ?1",
                params![intent.opening_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(server_usable, 0);
        let first: Value = serde_json::from_str(&proof).unwrap();
        assert_eq!(
            first["usable"],
            json!(true),
            "the first proof is never rewritten"
        );
        assert_eq!(
            mirror_rows(&conn),
            (1, 1),
            "local money is never deleted or adopted twice"
        );
        let status: String = conn
            .query_row(
                "SELECT status FROM staff_shifts WHERE id = ?1",
                params![intent.shift_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "active",
            "demotion never closes or reopens local money itself"
        );
        assert_eq!(queue_rows(&conn), 0);

        store_hosted_session(&intent.opening_key, session_for(&intent, STAFF, 3_600));
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::OpeningUnusable
        );
        let keyed = statuses(&conn, Some(intent.opening_key.as_str()));
        assert_eq!(keyed[0]["state"], "confirmed_unusable");
        assert_eq!(keyed[0]["usable"], false);
        assert!(statuses(&conn, None).is_empty());
        let renewal = finalize_issuance(
            &conn,
            capture_issuance_fence(),
            &scope(),
            &IssuanceTarget::Existing(intent.clone()),
            issued_session(&scope(), STAFF),
            Utc::now(),
        );
        assert_eq!(renewal.unwrap_err().code, "OPENING_UNUSABLE");

        let other = Uuid::new_v4().to_string();
        let mut foreign = confirmed_body(&intent, false);
        transport(&mut foreign)["owner_terminal_id"] = json!(other);
        transport(&mut foreign)["drawer"]["owner_terminal_id"] = json!(other);
        assert_eq!(
            apply(&foreign),
            DispatchOutcome::Retained {
                code: "FOREIGN_CONFIRMATION".to_string()
            }
        );
        invalidate_hosted_cashier(&intent.opening_key);
    }

    // -----------------------------------------------------------------------
    // Close-purpose original-cashier authority
    // -----------------------------------------------------------------------

    const COUNTED: i64 = 1_450;

    /// A confirmed usable opening of `cents` through its real proof path, then
    /// its pending closing original captured against the confirmed drawer by
    /// the real journal in a caller transaction. The mirror is still open.
    fn capture_pending_close(conn: &Connection, cents: i64) -> (OpeningIntent, ClosingOriginal) {
        let intent = prepare(conn, cents);
        let item = claim(conn);
        apply_sync_result(
            conn,
            &intent.opening_key,
            Ok(&confirmed_body(&intent, true)),
            Utc::now(),
        );
        assert!(settle_item(conn, &item, None).unwrap().consumed);
        let opening = load_intent(conn, &intent.opening_key)
            .unwrap()
            .expect("the confirmed opening");
        let closing_key = Uuid::new_v4().to_string();
        let capture = gift_financial_closing::ClosingCapture {
            closing_key: closing_key.clone(),
            opening_key: opening.opening_key.clone(),
            queue_item_id: Uuid::new_v4().to_string(),
            organization_id: opening.organization_id.clone(),
            branch_id: opening.branch_id.clone(),
            terminal_id: opening.terminal_id.clone(),
            staff_id: opening.staff_id.clone(),
            shift_id: opening.shift_id.clone(),
            drawer_id: opening.drawer_id.clone(),
            owner_terminal_db_id: OWNER_DB.to_string(),
            source_terminal_db_id: SOURCE_DB.to_string(),
            currency: opening.currency.clone(),
            counted_cents: COUNTED,
            closed_at: normalize_instant(Utc::now()),
            confirmed_drawer: opening.drawer.clone().expect("the confirmed drawer"),
            drawer: opening.drawer.clone().expect("the confirmed drawer"),
            request_body: json!({
                "event": "shift_close",
                "shift_id": opening.shift_id,
                "closing_key": closing_key,
                "closing_cash_cents": COUNTED
            }),
        };
        let tx = conn
            .unchecked_transaction()
            .expect("begin the capture transaction");
        let (original, created) =
            gift_financial_closing::capture_original(&tx, &capture, Utc::now())
                .expect("capture the original");
        assert!(created && original.state == ClosingState::Pending);
        tx.commit().expect("commit the capture");
        (opening, original)
    }

    /// The capture integration's local close of the original mirror with the count.
    fn close_locally(conn: &Connection, original: &ClosingOriginal) {
        conn.execute(
            "UPDATE cash_drawer_sessions SET closing_amount_cents = ?1, closed_at = ?2 WHERE id = ?3",
            params![original.counted_cents, original.closed_at, original.drawer_id],
        )
        .expect("close the drawer locally");
        conn.execute(
            "UPDATE staff_shifts SET closing_cash_amount_cents = ?1, check_out_time = ?2, status = 'closed'
              WHERE id = ?3",
            params![original.counted_cents, original.closed_at, original.shift_id],
        )
        .expect("close the shift locally");
    }

    fn retained_close(conn: &Connection, cents: i64) -> (OpeningIntent, ClosingOriginal) {
        let (opening, original) = capture_pending_close(conn, cents);
        close_locally(conn, &original);
        (opening, original)
    }

    /// The strict `gift_closing_v1` reply proving exactly this original.
    fn closing_proof_reply(original: &ClosingOriginal) -> Value {
        let drawer = &original.drawer;
        json!({
            "success": true,
            "results": [{
                "shift_id": original.shift_id,
                "status": "ok",
                "financial_closing": {
                    "contract": "gift_closing_v1",
                    "state": "closed",
                    "organization_id": original.organization_id,
                    "branch_id": original.branch_id,
                    "terminal_id": original.terminal_id,
                    "source_terminal_id": original.source_terminal_db_id,
                    "owner_terminal_id": original.owner_terminal_db_id,
                    "shift_id": original.shift_id,
                    "drawer_id": original.drawer_id,
                    "staff_id": original.staff_id,
                    "currency": original.currency,
                    "counted_cents": original.counted_cents,
                    "variance_cents": original.counted_cents - drawer.expected_cents,
                    "closed_at": original.closed_at,
                    "drawer": {
                        "contract": FUNDING_CONTRACT,
                        "drawer_id": original.drawer_id,
                        "shift_id": original.shift_id,
                        "owner_terminal_id": original.owner_terminal_db_id,
                        "currency": original.currency,
                        "gift_cash_cents": drawer.gift_cash_cents,
                        "ordinary_expected_cents": drawer.ordinary_expected_cents,
                        "expected_cents": drawer.expected_cents,
                        "version": drawer.version,
                        "acknowledgement_id": drawer.acknowledgement_id
                    }
                }
            }]
        })
    }

    /// Consumes the original by its real strict proof adoption, committed.
    fn consume_with_proof(conn: &Connection, original: &ClosingOriginal) {
        let tx = conn
            .unchecked_transaction()
            .expect("begin the adoption transaction");
        let adoption = gift_financial_closing::adopt_closing_response(
            &tx,
            &original.closing_key,
            Some(&closing_proof_reply(original)),
            None,
            Utc::now(),
        )
        .expect("adopt the closing proof");
        assert!(matches!(
            adoption,
            gift_financial_closing::ClosingAdoption::Adopted {
                replayed: false,
                ..
            }
        ));
        tx.commit().expect("commit the adoption");
    }

    fn close_access(
        conn: &Connection,
        original: &ClosingOriginal,
    ) -> Result<ClosingHostedCashier, ClosingAccessError> {
        closing_hosted_cashier(
            conn,
            &original.closing_key,
            &original.queue_item_id,
            Utc::now(),
        )
    }

    #[test]
    fn the_close_accessor_admits_only_the_exact_retained_original_and_its_live_cashier() {
        let _auth = auth_serial();
        let conn = test_conn();
        let (opening, original) = capture_pending_close(&conn, 1_000);
        store_hosted_session(&opening.opening_key, session_for(&opening, STAFF, 3_600));
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::MirrorMismatch,
            "no retained closure before the local close"
        );
        close_locally(&conn, &original);

        let access =
            close_access(&conn, &original).expect("the original cashier after the local close");
        assert_eq!(
            (
                access.closing_key(),
                access.opening_key(),
                access.queue_item_id()
            ),
            (
                original.closing_key.as_str(),
                opening.opening_key.as_str(),
                original.queue_item_id.as_str()
            )
        );
        assert_eq!(
            (access.shift_id(), access.drawer_id()),
            (opening.shift_id.as_str(), opening.drawer_id.as_str())
        );
        assert_eq!(access.scope(), &cashier_scope());
        assert!(access.expires_at() > Utc::now());
        assert_eq!(
            access.staff_session_header(),
            hosted_session(&opening.opening_key).unwrap().session_id
        );
        assert!(!format!("{access:?}").contains(access.staff_session_header()));

        // The open-only paths are unchanged: funding admission, opening
        // renewal and status all treat the closed original as unusable.
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::LocalShiftNotActive
        );
        assert_eq!(
            check_existing_eligible(&conn, &scope(), &opening)
                .unwrap_err()
                .code,
            "OPENING_UNUSABLE"
        );
        let keyed = statuses(&conn, Some(opening.opening_key.as_str()));
        assert_eq!(keyed[0]["usable"], json!(false));
        assert_eq!(keyed[0]["hostedAuthorization"]["state"], "required");
        assert!(statuses(&conn, None).is_empty());

        // Another queue item or key, expiry, another cashier and the lifecycle clear.
        assert_eq!(
            closing_hosted_cashier(
                &conn,
                &original.closing_key,
                "another-queue-item",
                Utc::now()
            )
            .unwrap_err(),
            ClosingAccessError::QueueMismatch
        );
        assert_eq!(
            closing_hosted_cashier(
                &conn,
                &Uuid::new_v4().to_string(),
                &original.queue_item_id,
                Utc::now()
            )
            .unwrap_err(),
            ClosingAccessError::ClosingNotFound
        );
        let later = Utc::now() + chrono::Duration::hours(2);
        assert_eq!(
            closing_hosted_cashier(&conn, &original.closing_key, &original.queue_item_id, later)
                .unwrap_err(),
            ClosingAccessError::Expired
        );
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::ReauthRequired
        );
        store_hosted_session(
            &opening.opening_key,
            session_for(&opening, OTHER_STAFF, 3_600),
        );
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::ReauthRequired
        );
        assert!(
            hosted_session(&opening.opening_key).is_none(),
            "another cashier's session is dropped"
        );
        store_hosted_session(&opening.opening_key, session_for(&opening, STAFF, 3_600));
        assert!(close_access(&conn, &original).is_ok());
        clear_authorizations();
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::ReauthRequired,
            "the lifecycle clear drops the held closing authorization"
        );
        store_hosted_session(&opening.opening_key, session_for(&opening, STAFF, 3_600));

        // The trusted terminal tuple changes: another org reusing this public
        // terminal id, another branch or another public terminal.
        for (setting, value) in [
            ("organization_id", ORG),
            ("branch_id", BRANCH),
            ("terminal_id", TERMINAL),
        ] {
            crate::db::set_setting(&conn, "terminal", setting, &Uuid::new_v4().to_string())
                .unwrap();
            assert_eq!(
                close_access(&conn, &original).unwrap_err(),
                ClosingAccessError::ScopeChanged,
                "{setting}"
            );
            crate::db::set_setting(&conn, "terminal", setting, value).unwrap();
        }
        // The opening's actor or owner/source pins no longer match the original.
        for (column, foreign, value) in [
            ("staff_id", OTHER_STAFF, STAFF),
            ("owner_terminal_db_id", SOURCE_DB, OWNER_DB),
            ("source_terminal_db_id", OWNER_DB, SOURCE_DB),
        ] {
            let update = format!("UPDATE gift_financial_openings SET {column} = ?1");
            conn.execute(&update, params![foreign]).unwrap();
            assert_eq!(
                close_access(&conn, &original).unwrap_err(),
                ClosingAccessError::OpeningMismatch,
                "{column}"
            );
            conn.execute(&update, params![value]).unwrap();
        }
        // The retained local closure is reopened, foreign or differently counted.
        for (broken, restored) in [
            (
                "UPDATE staff_shifts SET status = 'active'".to_string(),
                "UPDATE staff_shifts SET status = 'closed'".to_string(),
            ),
            (
                "UPDATE cash_drawer_sessions SET closed_at = NULL".to_string(),
                format!(
                    "UPDATE cash_drawer_sessions SET closed_at = '{}'",
                    original.closed_at
                ),
            ),
            (
                format!(
                    "UPDATE cash_drawer_sessions SET closing_amount_cents = {}",
                    COUNTED - 1
                ),
                format!("UPDATE cash_drawer_sessions SET closing_amount_cents = {COUNTED}"),
            ),
            (
                format!(
                    "UPDATE staff_shifts SET closing_cash_amount_cents = {}",
                    COUNTED + 1
                ),
                format!("UPDATE staff_shifts SET closing_cash_amount_cents = {COUNTED}"),
            ),
            (
                format!("UPDATE cash_drawer_sessions SET cashier_id = '{OTHER_STAFF}'"),
                format!("UPDATE cash_drawer_sessions SET cashier_id = '{STAFF}'"),
            ),
            (
                "UPDATE staff_shifts SET terminal_id = 'terminal-other'".to_string(),
                format!("UPDATE staff_shifts SET terminal_id = '{TERMINAL}'"),
            ),
        ] {
            conn.execute_batch(&broken).unwrap();
            assert_eq!(
                close_access(&conn, &original).unwrap_err(),
                ClosingAccessError::MirrorMismatch,
                "{broken}"
            );
            conn.execute_batch(&restored).unwrap();
        }
        assert!(close_access(&conn, &original).is_ok());

        // Proof consumption: the confirmed original never authorizes again and
        // its retired opening stays unusable for new cash work.
        consume_with_proof(&conn, &original);
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::ClosingNotPending
        );
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::OpeningUnusable
        );
        invalidate_hosted_cashier(&opening.opening_key);
    }

    #[test]
    fn a_held_closing_renewal_installs_only_for_the_same_pending_original_and_scope() {
        let _auth = auth_serial();
        let conn = test_conn();
        let (opening, original) = retained_close(&conn, 800);
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::ReauthRequired
        );
        let issued = load_retained_closing(&conn, &original.closing_key, None)
            .expect("validated before check-in");
        assert_eq!(issued.original, original);
        let finalize = |fence: IssuanceFence, session: HostedCashierSession| {
            finalize_closing_issuance(&conn, fence, &issued, session)
        };
        let superseded = "HOSTED_AUTHORIZATION_SUPERSEDED";

        // Replies held across the lifecycle clear or this original's invalidation.
        let fence = capture_issuance_fence();
        assert_eq!(clear_authorizations(), json!({ "success": true }));
        assert_eq!(
            finalize(fence, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            superseded
        );
        let fence = capture_issuance_fence();
        invalidate_hosted_cashier(&opening.opening_key);
        assert_eq!(
            finalize(fence, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            superseded
        );
        assert!(hosted_session(&opening.opening_key).is_none());

        // Another actor's hosted check-in never installs.
        let other = finalize(
            capture_issuance_fence(),
            issued_session(&scope(), OTHER_STAFF),
        )
        .unwrap_err();
        assert_eq!(other.code, "HOSTED_STAFF_MISMATCH");
        assert!(hosted_session(&opening.opening_key).is_none());

        // A valid reply can expire while waiting for the local database lock.
        let mut delayed = issued_session(&scope(), STAFF);
        delayed.expires_at = Utc::now() - chrono::Duration::seconds(1);
        let expired = finalize(capture_issuance_fence(), delayed).unwrap_err();
        assert_eq!(expired.code, "HOSTED_SESSION_EXPIRED");
        assert!(hosted_session(&opening.opening_key).is_none());

        // The same original cashier renews after the local close; a slower,
        // older reply never overwrites the newer authorization.
        let older = capture_issuance_fence();
        let newer = capture_issuance_fence();
        let renewed = issued_session(&scope(), STAFF);
        let (current, expires_at) =
            finalize(newer, renewed.clone()).expect("same-cashier renewal after the close");
        assert_eq!(current, original);
        assert_eq!(expires_at, renewed.expires_at);
        assert_eq!(
            finalize(older, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            superseded
        );
        let access = close_access(&conn, &original).expect("the renewed close authority");
        assert_eq!(access.staff_session_header(), renewed.session_id);
        assert_eq!(
            scoped_hosted_cashier(&conn, &cashier_scope(), Utc::now()).unwrap_err(),
            HostedAccessError::LocalShiftNotActive,
            "a closing renewal never reopens funding"
        );

        // The IPC view carries only nonsecret identity and expiry.
        let view = closing_authorization_view(&current, expires_at);
        assert_eq!(view["closing"]["closingKey"], json!(original.closing_key));
        assert_eq!(
            view["closing"]["hostedAuthorization"],
            json!({ "state": "authorized", "expiresAt": normalize_instant(renewed.expires_at) })
        );
        let mut keys: Vec<&str> = view["closing"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "branchId",
                "closingKey",
                "drawerId",
                "hostedAuthorization",
                "openingKey",
                "organizationId",
                "shiftId",
                "staffId",
                "state",
                "terminalId"
            ]
        );
        let text = view.to_string();
        assert!(!text.contains(&renewed.session_id));
        assert!(!text.to_ascii_lowercase().contains("session") && !text.contains("\"pin\""));

        // The trusted scope changes while the reply is held.
        for (setting, value) in [
            ("organization_id", ORG),
            ("branch_id", BRANCH),
            ("terminal_id", TERMINAL),
        ] {
            let fence = capture_issuance_fence();
            crate::db::set_setting(&conn, "terminal", setting, &Uuid::new_v4().to_string())
                .unwrap();
            let refused = finalize(fence, issued_session(&scope(), STAFF)).unwrap_err();
            assert_eq!(refused.code, "CLOSING_SCOPE_CHANGED", "{setting}");
            crate::db::set_setting(&conn, "terminal", setting, value).unwrap();
        }
        // Another queue item, a changed original tuple, a changed count or a
        // removed original while the reply is held.
        let mut other_queue = issued.clone();
        other_queue.original.queue_item_id = Uuid::new_v4().to_string();
        let refused = finalize_closing_issuance(
            &conn,
            capture_issuance_fence(),
            &other_queue,
            issued_session(&scope(), STAFF),
        );
        assert_eq!(refused.unwrap_err().code, "CLOSING_QUEUE_MISMATCH");
        let mut other_tuple = issued.clone();
        other_tuple.original.counted_cents += 1;
        let refused = finalize_closing_issuance(
            &conn,
            capture_issuance_fence(),
            &other_tuple,
            issued_session(&scope(), STAFF),
        );
        assert_eq!(refused.unwrap_err().code, "CLOSING_TUPLE_CHANGED");
        let fence = capture_issuance_fence();
        conn.execute(
            "UPDATE cash_drawer_sessions SET closing_amount_cents = closing_amount_cents + 1",
            [],
        )
        .unwrap();
        assert_eq!(
            finalize(fence, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            "CLOSING_MIRROR_MISMATCH"
        );
        conn.execute(
            "UPDATE cash_drawer_sessions SET closing_amount_cents = closing_amount_cents - 1",
            [],
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        tx.execute(
            "DELETE FROM gift_financial_closings WHERE closing_key = ?1",
            params![original.closing_key],
        )
        .unwrap();
        let refused = finalize_closing_issuance(
            &tx,
            capture_issuance_fence(),
            &issued,
            issued_session(&scope(), STAFF),
        );
        assert_eq!(refused.unwrap_err().code, "CLOSING_NOT_FOUND");
        tx.rollback().unwrap();
        assert_eq!(
            hosted_session(&opening.opening_key).unwrap().session_id,
            renewed.session_id
        );

        // A reply held while the proof is consumed never installs.
        let held = capture_issuance_fence();
        consume_with_proof(&conn, &original);
        assert_eq!(
            finalize(held, issued_session(&scope(), STAFF))
                .unwrap_err()
                .code,
            "CLOSING_NOT_PENDING"
        );
        assert_eq!(
            hosted_session(&opening.opening_key).unwrap().session_id,
            renewed.session_id
        );
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::ClosingNotPending
        );
        invalidate_hosted_cashier(&opening.opening_key);
    }

    #[test]
    fn the_same_original_cashier_renews_a_retained_close_after_a_restart() {
        let _auth = auth_serial();
        let tmp = crate::tests::harness::TempDir::new();
        let path = tmp.path().join("pos.db");
        let (opening, original) = {
            let conn = Connection::open(&path).expect("open file-backed db");
            crate::db::run_migrations_for_test(&conn);
            for (key, value) in [
                ("organization_id", ORG),
                ("branch_id", BRANCH),
                ("terminal_id", TERMINAL),
            ] {
                crate::db::set_setting(&conn, "terminal", key, value).expect("seed terminal scope");
            }
            let (opening, original) = retained_close(&conn, 2_000);
            store_hosted_session(&opening.opening_key, session_for(&opening, STAFF, 3_600));
            assert!(close_access(&conn, &original).is_ok());
            (opening, original)
        };
        // Restart: the durable original survives; the volatile authorization does not.
        clear_authorizations();
        let conn = Connection::open(&path).expect("reopen file-backed db");
        assert_eq!(
            close_access(&conn, &original).unwrap_err(),
            ClosingAccessError::ReauthRequired
        );
        let issued =
            load_retained_closing(&conn, &original.closing_key, None).expect("the retained close");
        assert_eq!(issued.original, original);
        let renewed = issued_session(&scope(), STAFF);
        finalize_closing_issuance(&conn, capture_issuance_fence(), &issued, renewed.clone())
            .expect("same-cashier renewal after a restart");
        assert_eq!(
            close_access(&conn, &original)
                .unwrap()
                .staff_session_header(),
            renewed.session_id
        );
        invalidate_hosted_cashier(&opening.opening_key);
    }

    #[test]
    fn authorize_closing_refuses_before_any_hosted_call_and_changes_nothing() {
        let _auth = auth_serial();
        let conn = test_conn();
        let (opening, original) = capture_pending_close(&conn, 500);
        let db = crate::db::DbState {
            conn: Mutex::new(conn),
            db_path: std::path::PathBuf::new(),
        };
        let authorize = |payload: Value| {
            let result = tauri::async_runtime::block_on(authorize_closing(&db, &payload))
                .expect("a refusal is a value");
            assert_eq!(result["success"], json!(false), "{payload}");
            let text = result.to_string().to_ascii_lowercase();
            assert!(
                !text.contains("1234") && !text.contains("session"),
                "{text}"
            );
            result["code"].as_str().expect("a refusal code").to_string()
        };
        let durable = || {
            let conn = db.conn.lock().unwrap();
            (
                gift_financial_closing::load_original(&conn, &original.closing_key).unwrap(),
                load_intent(&conn, &opening.opening_key).unwrap(),
                count(&conn, "SELECT COUNT(*) FROM parity_sync_queue"),
            )
        };
        let before = durable();
        assert_eq!(
            authorize(json!({ "closingKey": "not-a-key", "pin": "1234" })),
            "INVALID_CLOSING_KEY"
        );
        assert_eq!(
            authorize(json!({ "closingKey": original.closing_key })),
            "PIN_REQUIRED"
        );
        assert_eq!(
            authorize(json!({ "closingKey": original.closing_key, "pin": "12" })),
            "PIN_REQUIRED"
        );
        assert_eq!(
            authorize(json!({ "closingKey": Uuid::new_v4().to_string(), "pin": "1234" })),
            "CLOSING_NOT_FOUND"
        );
        // Not closed locally yet; a renderer staff claim never selects the cashier.
        assert_eq!(
            authorize(
                json!({ "closingKey": original.closing_key, "pin": "1234", "staffId": OTHER_STAFF })
            ),
            "CLOSING_MIRROR_MISMATCH"
        );
        assert_eq!(durable(), before);

        close_locally(&db.conn.lock().unwrap(), &original);
        let foreign = Uuid::new_v4().to_string();
        crate::db::set_setting(&db.conn.lock().unwrap(), "terminal", "branch_id", &foreign)
            .unwrap();
        assert_eq!(
            authorize(json!({ "closingKey": original.closing_key, "pin": "1234" })),
            "CLOSING_SCOPE_CHANGED"
        );
        crate::db::set_setting(&db.conn.lock().unwrap(), "terminal", "branch_id", BRANCH).unwrap();
        consume_with_proof(&db.conn.lock().unwrap(), &original);
        assert_eq!(
            authorize(json!({ "closingKey": original.closing_key, "pin": "1234" })),
            "CLOSING_NOT_PENDING"
        );
        assert!(
            hosted_session(&opening.opening_key).is_none(),
            "no refusal installs anything"
        );
    }
}
