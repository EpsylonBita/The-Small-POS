//! Order-backed gift card redemption over the admin `atomic_v1` contract.
//!
//! The admin RPC debits the card and creates the canonical `pos_payments` row
//! in one transaction. This terminal never records a gift payment of its own:
//! it stores an immutable attempt before the debit, then mirrors exactly the
//! canonical payment the server returned or that reconciliation found. The full
//! card number lives only in memory for the request; attempts keep a scoped
//! SHA-256 fingerprint.
//!
//! Boundaries of this slice:
//! - Item-selected split payments are refused before any debit. The atomic RPC
//!   creates no canonical `pos_payment_items`, so a gift portion cannot show
//!   items as paid.
//! - Ordinary refund, void and method conversion of gift payments stay refused
//!   in `refunds.rs` / `payments.rs`. A gift payment returns only to its
//!   original card through `commands/gift_card_returns.rs` (`atomic_return_v1`).

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ecr::protocols::cap_driver;
use crate::{api, db, payments, resolve_order_id, storage, sync};

pub(crate) const GIFT_CARD_PAYMENT_CONTRACT: &str = "atomic_v1";
const REDEEM_PATH: &str = "/api/pos/gift-cards/redeem";
const CANONICAL_PAYMENTS_PATH: &str = "/api/pos/payments";
// Scheduling advice only; neither elapsed time nor an empty read is finality.
const RECONCILIATION_RETRY_SECS: i64 = 30;
const STAFF_SESSION_MAX_BYTES: usize = 16 * 1024;
const SPLIT_ID_MAX_CHARS: usize = 128;

const ATTEMPT_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS gift_card_redemption_attempts (
        idempotency_key TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        local_order_id TEXT NOT NULL,
        remote_order_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        currency TEXT NOT NULL,
        card_fingerprint TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        split_group_id TEXT,
        split_portion_id TEXT,
        status TEXT NOT NULL
            CHECK (status IN ('pending', 'remote_applied', 'applied', 'abandoned')),
        card_id TEXT,
        remote_payment_id TEXT,
        local_payment_id TEXT,
        last_error_code TEXT,
        definitive_rejection INTEGER NOT NULL DEFAULT 0 CHECK (definitive_rejection IN (0, 1)),
        send_count INTEGER NOT NULL DEFAULT 0,
        last_sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gift_card_attempts_scope_order
        ON gift_card_redemption_attempts (organization_id, terminal_id, local_order_id, status);
    CREATE TRIGGER IF NOT EXISTS trg_gift_card_attempt_identity_immutable
    BEFORE UPDATE OF idempotency_key, organization_id, branch_id, terminal_id,
        local_order_id, remote_order_id, amount_cents, currency, card_fingerprint,
        request_fingerprint, split_group_id, split_portion_id
    ON gift_card_redemption_attempts
    BEGIN
        SELECT RAISE(ABORT, 'GIFT_CARD_ATTEMPT_IMMUTABLE');
    END;
";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GiftScope {
    pub organization_id: String,
    pub branch_id: String,
    pub terminal_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SplitContext {
    group_id: String,
    portion_id: String,
}

/// Deliberately not `Debug`: the bearer card number must never reach a log.
struct RedeemRequest {
    order_ref: String,
    card_number: String,
    amount_cents: i64,
    currency: String,
    split: Option<SplitContext>,
}

#[derive(Debug, PartialEq)]
struct Refusal {
    code: &'static str,
    message: String,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn into_json(self) -> Value {
        json!({
            "success": false,
            "code": self.code,
            "error": self.message,
            "reconciliationPending": false,
        })
    }
}

#[derive(Clone, Debug)]
struct Attempt {
    idempotency_key: String,
    local_order_id: String,
    remote_order_id: String,
    amount_cents: i64,
    currency: String,
    request_fingerprint: String,
    split: Option<SplitContext>,
    status: String,
    send_count: i64,
    last_sent_at: Option<String>,
}

enum Prepared {
    Send(Attempt),
    Import(Attempt),
    ResolvePrior(Vec<Attempt>),
}

#[derive(Debug, PartialEq, Eq)]
enum GiftFiscalRoute {
    NoRegister,
    CapVoucher(u8),
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

fn text_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn normalize_card_number(raw: &str) -> Option<String> {
    let normalized = raw
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '-')
        .collect::<String>()
        .to_ascii_uppercase();
    ((4..=64).contains(&normalized.len())
        && normalized.chars().all(|ch| ch.is_ascii_alphanumeric()))
    .then_some(normalized)
}

fn whole_cents(amount: f64) -> Option<i64> {
    if !amount.is_finite() || amount <= 0.0 || amount > 1_000_000.0 {
        return None;
    }
    let scaled = amount * 100.0;
    let cents = scaled.round();
    ((scaled - cents).abs() < 1e-6).then_some(cents as i64)
}

fn cents_to_amount(cents: i64) -> f64 {
    cents as f64 / 100.0
}

fn parse_split(payload: &Value) -> Result<Option<SplitContext>, Refusal> {
    let nested = payload.get("split").filter(|value| value.is_object());
    let pick = |nested_keys: &[&str], flat_keys: &[&str]| {
        nested
            .and_then(|split| text_field(split, nested_keys))
            .or_else(|| text_field(payload, flat_keys))
    };
    let group = pick(
        &["groupId", "group_id"],
        &["splitGroupId", "split_group_id"],
    );
    let portion = pick(
        &["portionId", "portion_id"],
        &["splitPortionId", "split_portion_id"],
    );
    match (group, portion) {
        (None, None) => Ok(None),
        (Some(group_id), Some(portion_id))
            if group_id.chars().count() <= SPLIT_ID_MAX_CHARS
                && portion_id.chars().count() <= SPLIT_ID_MAX_CHARS =>
        {
            Ok(Some(SplitContext {
                group_id,
                portion_id,
            }))
        }
        _ => Err(Refusal::new(
            "GIFT_CARD_METADATA_INVALID",
            "Split context needs a group id and a portion id of at most 128 characters",
        )),
    }
}

fn parse_redeem_request(payload: &Value) -> Result<RedeemRequest, Refusal> {
    let order_ref = text_field(payload, &["orderId", "order_id"])
        .ok_or_else(|| Refusal::new("GIFT_CARD_ORDER_REQUIRED", "An order is required"))?;
    let item_selected = [
        "items",
        "itemIds",
        "item_ids",
        "orderItemIds",
        "selectedItems",
        "selected_items",
    ]
    .iter()
    .any(|key| {
        payload
            .get(*key)
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    });
    if item_selected {
        return Err(Refusal::new(
            "GIFT_CARD_ITEM_SPLIT_UNSUPPORTED",
            "Gift cards cannot pay selected items yet. Pay a split amount or the full balance instead.",
        ));
    }
    let card_number = text_field(payload, &["cardNumber", "card_number"])
        .as_deref()
        .and_then(normalize_card_number)
        .ok_or_else(|| {
            Refusal::new(
                "GIFT_CARD_NUMBER_REQUIRED",
                "Enter or scan the full gift card number",
            )
        })?;
    let amount_cents = payload
        .get("amount")
        .and_then(Value::as_f64)
        .and_then(whole_cents)
        .ok_or_else(|| {
            Refusal::new(
                "GIFT_CARD_AMOUNT_INVALID",
                "The gift card amount must be positive with at most two decimals",
            )
        })?;
    let currency = text_field(payload, &["currency"])
        .map(|value| value.to_ascii_uppercase())
        .filter(|value| value.len() == 3 && value.chars().all(|ch| ch.is_ascii_uppercase()))
        .ok_or_else(|| {
            Refusal::new(
                "GIFT_CARD_CURRENCY_REQUIRED",
                "The store currency from gift card status is required",
            )
        })?;
    Ok(RedeemRequest {
        order_ref,
        card_number,
        amount_cents,
        currency,
        split: parse_split(payload)?,
    })
}

// ---------------------------------------------------------------------------
// Fingerprints and scope
// ---------------------------------------------------------------------------

fn sha256_hex(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn card_fingerprint(scope: &GiftScope, card_number: &str) -> String {
    sha256_hex(&[
        "the-small/gift-card/v1",
        &scope.organization_id,
        card_number,
    ])
}

fn request_fingerprint(
    scope: &GiftScope,
    local_order_id: &str,
    remote_order_id: &str,
    request: &RedeemRequest,
    card_fingerprint: &str,
) -> String {
    let amount = request.amount_cents.to_string();
    let (group, portion) = request
        .split
        .as_ref()
        .map(|split| (split.group_id.as_str(), split.portion_id.as_str()))
        .unwrap_or(("", ""));
    sha256_hex(&[
        "the-small/gift-redeem/v1",
        GIFT_CARD_PAYMENT_CONTRACT,
        &scope.organization_id,
        &scope.branch_id,
        &scope.terminal_id,
        local_order_id,
        remote_order_id,
        &amount,
        &request.currency,
        card_fingerprint,
        group,
        portion,
    ])
}

fn read_scope_value(conn: &Connection, key: &str) -> Option<String> {
    db::get_setting(conn, "terminal", key)
        .or_else(|| storage::get_credential(key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn resolve_trusted_scope(conn: &Connection) -> Option<GiftScope> {
    Some(GiftScope {
        organization_id: read_scope_value(conn, "organization_id")?,
        branch_id: read_scope_value(conn, "branch_id")?,
        terminal_id: read_scope_value(conn, "terminal_id")?,
    })
}

// ---------------------------------------------------------------------------
// Durable attempts
// ---------------------------------------------------------------------------

pub(crate) fn ensure_attempt_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(ATTEMPT_SCHEMA)
        .map_err(|e| format!("ensure gift card attempt store: {e}"))?;
    let has_rejection_proof = conn
        .prepare("PRAGMA table_info(gift_card_redemption_attempts)")
        .and_then(|mut stmt| {
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            names.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| format!("inspect gift card attempt store: {e}"))?
        .iter()
        .any(|name| name == "definitive_rejection");
    if !has_rejection_proof {
        conn.execute_batch("ALTER TABLE gift_card_redemption_attempts ADD COLUMN definitive_rejection INTEGER NOT NULL DEFAULT 0 CHECK (definitive_rejection IN (0, 1));")
            .map_err(|e| format!("upgrade gift card rejection proof: {e}"))?;
    }
    // Native01's age/status-only release did not prove a request could never
    // commit. Restore those rows, including malformed historical timestamps.
    // New releases require a persisted, structured first-send rejection proof.
    conn.execute_batch(
        "SAVEPOINT gift_card_attempt_recovery;
         DROP TRIGGER IF EXISTS trg_gift_card_attempt_unresolved_kept;
         CREATE TRIGGER IF NOT EXISTS trg_gift_card_attempt_unresolved_kept_v2
         BEFORE DELETE ON gift_card_redemption_attempts
         WHEN OLD.status IN ('pending', 'remote_applied')
           OR (OLD.status = 'abandoned' AND OLD.definitive_rejection = 0
               AND (OLD.send_count > 0 OR OLD.last_sent_at IS NOT NULL))
         BEGIN
             SELECT RAISE(ABORT, 'GIFT_CARD_ATTEMPT_UNRESOLVED');
         END;
         UPDATE gift_card_redemption_attempts SET status = 'pending'
         WHERE status = 'abandoned' AND definitive_rejection = 0
           AND (send_count > 0 OR last_sent_at IS NOT NULL);
         RELEASE gift_card_attempt_recovery;",
    )
    .map_err(|e| {
        let _ = conn.execute_batch(
            "ROLLBACK TO gift_card_attempt_recovery; RELEASE gift_card_attempt_recovery;",
        );
        format!("recover gift card attempt history: {e}")
    })
}

fn store_unavailable(error: impl std::fmt::Display) -> Refusal {
    Refusal::new(
        "GIFT_CARD_ATTEMPT_STORE_UNAVAILABLE",
        format!(
            "The gift card attempt could not be saved. No new redemption request was sent: {error}"
        ),
    )
}

fn load_unresolved_attempts(
    conn: &Connection,
    scope: &GiftScope,
    local_order_id: &str,
) -> Result<Vec<Attempt>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT idempotency_key, local_order_id, remote_order_id, amount_cents, currency,
                    request_fingerprint, split_group_id, split_portion_id, status, send_count,
                    last_sent_at
             FROM gift_card_redemption_attempts
             WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
               AND local_order_id = ?4
               AND status IN ('pending', 'remote_applied')
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare gift card attempt lookup: {e}"))?;
    let rows = stmt
        .query_map(
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                local_order_id
            ],
            |row| {
                let group: Option<String> = row.get(6)?;
                let portion: Option<String> = row.get(7)?;
                Ok(Attempt {
                    idempotency_key: row.get(0)?,
                    local_order_id: row.get(1)?,
                    remote_order_id: row.get(2)?,
                    amount_cents: row.get(3)?,
                    currency: row.get(4)?,
                    request_fingerprint: row.get(5)?,
                    split: group
                        .zip(portion)
                        .map(|(group_id, portion_id)| SplitContext {
                            group_id,
                            portion_id,
                        }),
                    status: row.get(8)?,
                    send_count: row.get(9)?,
                    last_sent_at: row.get(10)?,
                })
            },
        )
        .map_err(|e| format!("query gift card attempts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read gift card attempt: {e}"))
}

// ---------------------------------------------------------------------------
// Original split projection
// ---------------------------------------------------------------------------

/// One canonical local payment row whose original gift split is asked for, as
/// `payments.rs` read it. `gross_cents` is the stored integer amount, compared
/// before any float conversion.
#[derive(Clone, Copy)]
pub(crate) struct CanonicalGiftRow<'a> {
    pub method: &'a str,
    pub local_payment_id: &'a str,
    pub remote_payment_id: Option<&'a str>,
    pub local_order_id: &'a str,
    pub currency: &'a str,
    pub gross_cents: Option<i64>,
}

/// Original split identity of one canonical gift payment. Carries no card,
/// fingerprint, idempotency key or amount.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OriginalGiftSplit {
    /// The applied attempt was this portion of an original split.
    Split {
        group_id: String,
        portion_id: String,
    },
    /// The applied attempt recorded no split: a full, unsplit gift tender.
    Full,
    /// Nothing is proven; the code says why, never which split it might be.
    Unavailable(&'static str),
}

struct JournalBinding {
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    local_order_id: String,
    amount_cents: i64,
    currency: String,
    split_group_id: Option<String>,
    split_portion_id: Option<String>,
    status: String,
    local_payment_id: Option<String>,
    remote_payment_id: Option<String>,
    remote_order_id: String,
}

fn well_formed_split_id(id: &str) -> bool {
    !id.is_empty() && id.trim() == id && id.chars().count() <= SPLIT_ID_MAX_CHARS
}

/// Prove the original split identity of one canonical gift row from the
/// immutable redemption journal. Read-only on the caller's connection and
/// transaction: it never ensures the schema, recovers, relocks or writes, so a
/// missing journal is simply unavailable. Only a single `applied` attempt in
/// the trusted scope and local order, bound to both of the row's payment IDs
/// with the same currency and integer gross, proves a split or a full tender.
/// Unresolved attempts stay with native recovery; nothing is ever guessed.
pub(crate) fn original_gift_split(
    conn: &Connection,
    scope: Option<&GiftScope>,
    row: &CanonicalGiftRow<'_>,
) -> OriginalGiftSplit {
    use OriginalGiftSplit::Unavailable;
    let Some(scope) = scope else {
        return Unavailable("trusted_scope_unavailable");
    };
    let remote_payment_id = row.remote_payment_id.filter(|id| !id.is_empty());
    let (Some(remote_payment_id), Some(gross_cents)) = (remote_payment_id, row.gross_cents) else {
        return Unavailable("payment_unverifiable");
    };
    if row.method != payments::GIFT_CARD_METHOD || row.local_payment_id.is_empty() {
        return Unavailable("payment_unverifiable");
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT organization_id, branch_id, terminal_id, local_order_id, amount_cents, currency,
                split_group_id, split_portion_id, status, local_payment_id, remote_payment_id, remote_order_id
         FROM gift_card_redemption_attempts
         WHERE local_payment_id = ?1 OR remote_payment_id = ?2",
    ) else {
        return Unavailable("journal_unavailable");
    };
    let Ok(bound) = stmt.query_map(params![row.local_payment_id, remote_payment_id], |r| {
        Ok(JournalBinding {
            organization_id: r.get(0)?,
            branch_id: r.get(1)?,
            terminal_id: r.get(2)?,
            local_order_id: r.get(3)?,
            amount_cents: r.get(4)?,
            currency: r.get(5)?,
            split_group_id: r.get(6)?,
            split_portion_id: r.get(7)?,
            status: r.get(8)?,
            local_payment_id: r.get(9)?,
            remote_payment_id: r.get(10)?,
            remote_order_id: r.get(11)?,
        })
    }) else {
        return Unavailable("journal_unavailable");
    };
    let Ok(mut bound) = bound.collect::<Result<Vec<_>, _>>() else {
        return Unavailable("journal_unreadable");
    };
    let journal = match bound.len() {
        0 => return Unavailable("journal_unmatched"),
        1 => bound.remove(0),
        _ => return Unavailable("journal_conflict"),
    };
    let local_bound = journal.local_payment_id.as_deref();
    let remote_bound = journal.remote_payment_id.as_deref();
    if local_bound.is_some_and(|id| id != row.local_payment_id)
        || remote_bound.is_some_and(|id| id != remote_payment_id)
    {
        return Unavailable("journal_conflict");
    }
    match journal.status.as_str() {
        "applied" => {}
        "pending" | "remote_applied" => return Unavailable("journal_unresolved"),
        _ => return Unavailable("journal_conflict"),
    }
    if local_bound.is_none()
        || remote_bound.is_none()
        || journal.organization_id != scope.organization_id
        || journal.branch_id != scope.branch_id
        || journal.terminal_id != scope.terminal_id
        || journal.local_order_id != row.local_order_id
        || journal.currency.trim().is_empty()
        || !journal
            .currency
            .trim()
            .eq_ignore_ascii_case(row.currency.trim())
        || journal.amount_cents != gross_cents
    {
        return Unavailable("journal_mismatch");
    }
    // Read the current header on this same connection, without payable/recovery
    // side effects. A local ID alone cannot prove the original hosted order.
    let current_order: Result<Option<(Option<String>, Option<String>, Option<String>)>, _> = conn
        .query_row(
            "SELECT supabase_id, organization_id, branch_id FROM orders WHERE id = ?1",
            params![row.local_order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional();
    let Ok(Some((Some(remote_order_id), organization_id, branch_id))) = current_order else {
        return Unavailable("journal_mismatch");
    };
    let remote_order_id = remote_order_id.trim();
    if uuid::Uuid::parse_str(remote_order_id).is_err()
        || remote_order_id != journal.remote_order_id
        || organization_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty() && id.trim() != scope.organization_id)
        || branch_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty() && id.trim() != scope.branch_id)
    {
        return Unavailable("journal_mismatch");
    }
    match (journal.split_group_id, journal.split_portion_id) {
        (None, None) => OriginalGiftSplit::Full,
        (Some(group_id), Some(portion_id))
            if well_formed_split_id(&group_id) && well_formed_split_id(&portion_id) =>
        {
            OriginalGiftSplit::Split {
                group_id,
                portion_id,
            }
        }
        _ => Unavailable("journal_malformed"),
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_attempt(
    conn: &Connection,
    scope: &GiftScope,
    local_order_id: &str,
    remote_order_id: &str,
    request: &RedeemRequest,
    card_fingerprint: &str,
    request_fingerprint: &str,
    now: &str,
) -> Result<Attempt, Refusal> {
    crate::unsaved_payments::refuse_new_collection_while_manual_receipt(conn, local_order_id)
        .map_err(|error| Refusal::new("TWINT_RECEIPT_PENDING", error))?;
    let idempotency_key = format!("gift-redeem-{}", uuid::Uuid::new_v4());
    conn.execute(
        "INSERT INTO gift_card_redemption_attempts (
             idempotency_key, organization_id, branch_id, terminal_id, local_order_id,
             remote_order_id, amount_cents, currency, card_fingerprint, request_fingerprint,
             split_group_id, split_portion_id, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', ?13, ?13)",
        params![
            idempotency_key,
            scope.organization_id,
            scope.branch_id,
            scope.terminal_id,
            local_order_id,
            remote_order_id,
            request.amount_cents,
            request.currency,
            card_fingerprint,
            request_fingerprint,
            request.split.as_ref().map(|split| split.group_id.clone()),
            request.split.as_ref().map(|split| split.portion_id.clone()),
            now,
        ],
    )
    .map_err(store_unavailable)?;
    Ok(Attempt {
        idempotency_key,
        local_order_id: local_order_id.to_string(),
        remote_order_id: remote_order_id.to_string(),
        amount_cents: request.amount_cents,
        currency: request.currency.clone(),
        request_fingerprint: request_fingerprint.to_string(),
        split: request.split.clone(),
        status: "pending".to_string(),
        send_count: 0,
        last_sent_at: None,
    })
}

fn mark_attempt_sent(conn: &Connection, key: &str, now: &str) -> Result<i64, String> {
    let changed = conn
        .execute(
            "UPDATE gift_card_redemption_attempts
             SET send_count = send_count + 1, last_sent_at = ?2, updated_at = ?2
             WHERE idempotency_key = ?1 AND status = 'pending'",
            params![key, now],
        )
        .map_err(|e| format!("record gift card send: {e}"))?;
    if changed != 1 {
        return Err("The gift card attempt is no longer pending".to_string());
    }
    conn.query_row(
        "SELECT send_count FROM gift_card_redemption_attempts WHERE idempotency_key = ?1",
        params![key],
        |row| row.get(0),
    )
    .map_err(|e| format!("read gift card send count: {e}"))
}

fn set_attempt_status(
    conn: &Connection,
    key: &str,
    status: &str,
    error_code: Option<&str>,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE gift_card_redemption_attempts
         SET status = ?2, last_error_code = ?3, updated_at = ?4,
             definitive_rejection = CASE WHEN ?2 = 'abandoned' AND send_count = 1 THEN 1 ELSE definitive_rejection END
         WHERE idempotency_key = ?1 AND status IN ('pending', 'remote_applied')",
        params![key, status, error_code, now],
    )
    .map(|_| ())
    .map_err(|e| format!("update gift card attempt: {e}"))
}

fn record_attempt_error(conn: &Connection, key: &str, error_code: &str, now: &str) {
    let _ = conn.execute(
        "UPDATE gift_card_redemption_attempts SET last_error_code = ?2, updated_at = ?3
         WHERE idempotency_key = ?1",
        params![key, error_code, now],
    );
}

// ---------------------------------------------------------------------------
// Pre-debit gates
// ---------------------------------------------------------------------------

/// Delivery-platform orders whose money the platform already holds cannot be
/// paid again with a gift card. Own-driver cash and unknown dispositions stay
/// collectible; the server guard remains authoritative.
fn platform_settlement_refusal(ghost_metadata: Option<&str>) -> Option<Refusal> {
    let mut value: Value = serde_json::from_str(ghost_metadata?.trim()).ok()?;
    if let Value::String(inner) = &value {
        value = serde_json::from_str(inner).ok()?;
    }
    let mut delivery = value
        .get("food_delivery")
        .or_else(|| value.get("foodDelivery"))?
        .clone();
    if let Value::String(inner) = &delivery {
        delivery = serde_json::from_str(inner).ok()?;
    }
    let prepaid = delivery.get("prepaid").and_then(Value::as_bool) == Some(true);
    let method = text_field(
        &delivery,
        &[
            "payment_method",
            "paymentMethod",
            "payment_type",
            "paymentType",
        ],
    )
    .map(|value| value.to_ascii_lowercase())
    .unwrap_or_default();
    let platform_delivery = delivery.as_object().is_some_and(|fields| {
        fields.values().any(|field| {
            field
                .as_str()
                .is_some_and(|text| text.trim().eq_ignore_ascii_case("platform_delivery"))
        })
    });
    (prepaid || method == "online" || (method == "cash" && platform_delivery)).then(|| {
        Refusal::new(
            "GIFT_CARD_ORDER_PLATFORM_SETTLED",
            "The delivery platform settles this order, so it cannot be paid with a gift card",
        )
    })
}

fn order_has_unsynced_changes(conn: &Connection, local_order_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sync_queue sq
             WHERE sq.status != 'synced'
               AND (
                    (sq.entity_type IN ('order', 'orders') AND sq.entity_id = ?1)
                    OR (sq.entity_type IN ('payment', 'order_payments')
                        AND sq.entity_id IN (SELECT id FROM order_payments WHERE order_id = ?1))
               )
         )",
        params![local_order_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .map_err(|e| format!("check unsynced order changes: {e}"))
}

/// Returns the remote order id and the outstanding cents after every local
/// check that can refuse the redemption before the card is debited.
fn check_order_payable(
    conn: &Connection,
    scope: &GiftScope,
    local_order_id: &str,
    amount_cents: i64,
) -> Result<(String, i64), Refusal> {
    let unavailable = |error: String| Refusal::new("GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error);
    type OrderRow = (
        Option<String>,
        String,
        String,
        i64,
        Option<String>,
        String,
        String,
    );
    let row: OrderRow = conn
        .query_row(
            "SELECT supabase_id, COALESCE(status, ''), COALESCE(payment_status, ''),
                    COALESCE(is_ghost, 0), ghost_metadata, COALESCE(order_context, ''),
                    COALESCE(organization_id, '')
             FROM orders WHERE id = ?1",
            params![local_order_id],
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
        .map_err(|e| unavailable(format!("load order: {e}")))?
        .ok_or_else(|| {
            Refusal::new(
                "GIFT_CARD_ORDER_NOT_FOUND",
                "Order not found on this terminal",
            )
        })?;
    let (supabase_id, status, payment_status, is_ghost, ghost_metadata, context, organization_id) =
        row;

    if !organization_id.trim().is_empty() && organization_id.trim() != scope.organization_id {
        return Err(Refusal::new(
            "GIFT_CARD_FORBIDDEN",
            "This order belongs to another organization",
        ));
    }
    let status = status.trim().to_ascii_lowercase();
    if is_ghost != 0
        || context.trim().eq_ignore_ascii_case("repair_settlement")
        || matches!(
            status.as_str(),
            "cancelled" | "canceled" | "refunded" | "voided"
        )
    {
        return Err(Refusal::new(
            "GIFT_CARD_ORDER_NOT_PAYABLE",
            "This order cannot be paid with a gift card",
        ));
    }
    if matches!(
        payment_status.trim().to_ascii_lowercase().as_str(),
        "paid" | "refunded"
    ) {
        return Err(Refusal::new(
            "GIFT_CARD_ORDER_ALREADY_PAID",
            "This order is already paid",
        ));
    }
    if let Some(refusal) = platform_settlement_refusal(ghost_metadata.as_deref()) {
        return Err(refusal);
    }
    // Shared rule R4 (round 3 review, 01/10/2026; Android
    // `assertOrderIsStoreCollectable`, gift value included): the server
    // refused a till payment on this order because the platform holds its
    // money. Gift value is store money too: never taken on it.
    if crate::payments::order_has_platform_held_set_aside(conn, local_order_id) {
        return Err(Refusal::new(
            "GIFT_CARD_ORDER_PLATFORM_SETTLED",
            "The delivery platform settles this order, so it cannot be paid with a gift card",
        ));
    }
    let remote_order_id = supabase_id
        .map(|value| value.trim().to_string())
        .filter(|value| uuid::Uuid::parse_str(value).is_ok());
    let sync_required = || {
        Refusal::new(
            "GIFT_CARD_ORDER_SYNC_REQUIRED",
            "Sync this order with the server, then try the gift card again",
        )
    };
    let remote_order_id = remote_order_id.ok_or_else(sync_required)?;
    if order_has_unsynced_changes(conn, local_order_id).map_err(unavailable)? {
        return Err(sync_required());
    }
    let snapshot =
        payments::load_order_payment_balance_snapshot(conn, local_order_id).map_err(unavailable)?;
    let outstanding_cents = (snapshot.outstanding_amount * 100.0).round() as i64;
    if outstanding_cents <= 0 {
        return Err(Refusal::new(
            "GIFT_CARD_ORDER_ALREADY_PAID",
            "This order has no outstanding balance",
        ));
    }
    if amount_cents > outstanding_cents {
        return Err(Refusal::new(
            "GIFT_CARD_ORDER_OVERPAYMENT",
            format!(
                "The gift card amount exceeds the outstanding balance of {:.2}",
                cents_to_amount(outstanding_cents)
            ),
        ));
    }
    Ok((remote_order_id, outstanding_cents))
}

fn order_payments_accept_gift_card(conn: &Connection) -> Result<bool, String> {
    db::order_payments_support_gift_cards(conn)
}

/// Same identifiers as `ecr::protocols::create_protocol` routes to the CAP Driver.
fn is_cap_protocol(protocol: &str) -> bool {
    matches!(
        protocol.trim().to_ascii_lowercase().as_str(),
        "cap_driver" | "rbs_cap_driver" | "mat_cap_driver"
    )
}

/// Every active fiscal register must be able to carry a gift tender before a
/// card is debited. Only the CAP Driver with a configured, non-cash, non-card
/// voucher payment number qualifies; other adapters have no verified mapping.
fn gift_fiscal_route(conn: &Connection) -> Result<GiftFiscalRoute, Refusal> {
    let unavailable = |error: rusqlite::Error| {
        Refusal::new(
            "GIFT_CARD_FISCAL_STATE_UNAVAILABLE",
            format!("Read the fiscal register configuration: {error}"),
        )
    };
    let mut stmt = conn
        .prepare("SELECT * FROM ecr_devices WHERE device_type = 'cash_register'")
        .map_err(unavailable)?;
    let columns: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(ToString::to_string)
        .collect();
    let position = |name: &str| columns.iter().position(|column| column == name);
    let protocol_index = position("protocol");
    let settings_index = ["settings", "config", "protocol_settings", "configuration"]
        .iter()
        .find_map(|name| position(name));
    let active_index = ["is_active", "enabled"]
        .iter()
        .find_map(|name| position(name));
    let json_column = |row: &rusqlite::Row<'_>, index: Option<usize>| -> Value {
        index
            .and_then(|index| row.get::<_, Option<String>>(index).ok().flatten())
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null)
    };

    let mut rows = stmt.query([]).map_err(unavailable)?;
    let mut route = GiftFiscalRoute::NoRegister;
    while let Some(row) = rows.next().map_err(unavailable)? {
        if let Some(index) = active_index {
            if row.get::<_, Option<i64>>(index).map_err(unavailable)? == Some(0) {
                continue;
            }
        }
        let protocol = match protocol_index {
            Some(index) => row.get::<_, Option<String>>(index).map_err(unavailable)?,
            None => None,
        }
        .unwrap_or_default();
        if !is_cap_protocol(&protocol) {
            return Err(Refusal::new(
                "GIFT_CARD_FISCAL_TENDER_UNSUPPORTED",
                format!(
                    "The fiscal register ({protocol}) has no verified gift card tender, so gift cards are unavailable on this terminal"
                ),
            ));
        }
        // Only the settings the CAP adapter consumes: connection details are
        // never a fallback, and payment 1 is always the fixed cash number.
        let settings = json_column(row, settings_index);
        match cap_driver::settled_gift_voucher_code(&settings) {
            Ok(code) => route = GiftFiscalRoute::CapVoucher(code),
            Err(error) => {
                return Err(Refusal::new(
                    "GIFT_CARD_FISCAL_TENDER_NOT_CONFIGURED",
                    error,
                ))
            }
        }
    }
    Ok(route)
}

fn check_local_tender_support(conn: &Connection) -> Result<(), Refusal> {
    if !order_payments_accept_gift_card(conn)
        .map_err(|error| Refusal::new("GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error))?
    {
        return Err(Refusal::new(
            "GIFT_CARD_LOCAL_SCHEMA_UNSUPPORTED",
            "Update this terminal before accepting gift cards",
        ));
    }
    match gift_fiscal_route(conn)? {
        GiftFiscalRoute::NoRegister => Ok(()),
        // A partial gift is carried by the final cash or card checkout as the
        // register's voucher tender; a gift that settles the order gets its one
        // fiscal receipt from `gift_card_fiscal_finalize`.
        GiftFiscalRoute::CapVoucher(_) => Ok(()),
    }
}

#[cfg(test)]
fn prepare_with_scope(
    conn: &Connection,
    scope: GiftScope,
    request: &RedeemRequest,
    local_order_id: &str,
    now: &str,
) -> Result<Prepared, Refusal> {
    prepare_with_scope_gated(conn, scope, request, local_order_id, now, None)
}

/// Prepare an attempt; a fresh debit is first checked against the native
/// register and branch route when a gate is given.
fn prepare_with_scope_gated(
    conn: &Connection,
    scope: GiftScope,
    request: &RedeemRequest,
    local_order_id: &str,
    now: &str,
    gate: Option<&super::gift_card_fiscal::FreshDebitGate<'_>>,
) -> Result<Prepared, Refusal> {
    ensure_attempt_schema(conn).map_err(store_unavailable)?;
    let card_fp = card_fingerprint(&scope, &request.card_number);
    let unresolved = load_unresolved_attempts(conn, &scope, local_order_id)
        .map_err(|error| Refusal::new("GIFT_CARD_LOCAL_STATE_UNAVAILABLE", error))?;
    // An unresolved attempt is finished before anything else, even when the
    // order now looks paid: its debit may be the reason.
    // Older clients may already have replaced an unsafely abandoned attempt.
    // Reconcile every retained key before sending any of them again.
    if unresolved.len() > 1 {
        return Ok(Prepared::ResolvePrior(unresolved));
    }
    if let Some(first) = unresolved.first() {
        let fingerprint = request_fingerprint(
            &scope,
            local_order_id,
            &first.remote_order_id,
            request,
            &card_fp,
        );
        if let Some(same) = unresolved
            .iter()
            .find(|attempt| attempt.request_fingerprint == fingerprint)
        {
            let same = same.clone();
            return Ok(if same.status == "remote_applied" {
                Prepared::Import(same)
            } else {
                Prepared::Send(same)
            });
        }
        return Ok(Prepared::ResolvePrior(unresolved));
    }
    let (remote_order_id, _) =
        check_order_payable(conn, &scope, local_order_id, request.amount_cents)?;
    check_local_tender_support(conn)?;
    if let Some(gate) = gate {
        super::gift_card_fiscal::check_fresh_gift_debit(
            conn,
            gate.access,
            &gate.cloud,
            local_order_id,
            &request.currency,
        )
        .map_err(|(code, message)| Refusal::new(code, message))?;
    }
    let fingerprint =
        request_fingerprint(&scope, local_order_id, &remote_order_id, request, &card_fp);
    let attempt = insert_attempt(
        conn,
        &scope,
        local_order_id,
        &remote_order_id,
        request,
        &card_fp,
        &fingerprint,
        now,
    )?;
    Ok(Prepared::Send(attempt))
}

// ---------------------------------------------------------------------------
// Canonical payment validation and mirror
// ---------------------------------------------------------------------------

/// Only a canonical row that proves this exact attempt may be imported.
fn validate_canonical_gift_payment(payment: &Value, attempt: &Attempt) -> Result<String, String> {
    let text = |key: &str| {
        payment
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let remote_payment_id = text("id").ok_or("Canonical gift payment has no id")?;
    let method = text("payment_method").or_else(|| text("method"));
    if method != Some(payments::GIFT_CARD_METHOD) {
        return Err(format!(
            "Canonical payment method {method:?} is not gift_card"
        ));
    }
    if text("status") != Some("completed") {
        return Err("Canonical gift payment is not completed".to_string());
    }
    if text("order_id") != Some(attempt.remote_order_id.as_str()) {
        return Err("Canonical gift payment belongs to another order".to_string());
    }
    if text("idempotency_key") != Some(attempt.idempotency_key.as_str()) {
        return Err("Canonical gift payment has another idempotency key".to_string());
    }
    if !text("currency").is_some_and(|currency| currency.eq_ignore_ascii_case(&attempt.currency)) {
        return Err("Canonical gift payment currency differs from the attempt".to_string());
    }
    let cents = payment
        .get("amount_cents")
        .and_then(Value::as_i64)
        .or_else(|| {
            payment
                .get("amount")
                .and_then(Value::as_f64)
                .and_then(whole_cents)
        });
    if cents != Some(attempt.amount_cents) {
        return Err("Canonical gift payment amount differs from the attempt".to_string());
    }
    let tip_cents = payment
        .get("tip_amount_cents")
        .and_then(Value::as_i64)
        .or_else(|| {
            payment
                .get("tip_amount")
                .and_then(Value::as_f64)
                .map(|tip| (tip * 100.0).round() as i64)
        })
        .unwrap_or(0);
    if tip_cents != 0 {
        return Err("Canonical gift payment carries a tip".to_string());
    }
    let transaction_id = text("external_transaction_id")
        .and_then(|reference| reference.strip_prefix("gift_card:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Canonical gift payment has no gift card transaction reference")?;
    let proof = payment
        .pointer("/metadata/gift_card_transaction_id")
        .and_then(Value::as_str)
        .map(str::trim);
    if proof != Some(transaction_id)
        || text("gift_card_transaction_id").is_some_and(|value| value != transaction_id)
    {
        return Err("Canonical gift payment proof does not match its transaction".to_string());
    }
    if let Some(split) = &attempt.split {
        let meta = |key: &str| {
            payment
                .pointer(&format!("/metadata/{key}"))
                .and_then(Value::as_str)
        };
        if meta("split_group_id") != Some(split.group_id.as_str())
            || meta("split_portion_id") != Some(split.portion_id.as_str())
        {
            return Err(
                "Canonical gift payment split context differs from the attempt".to_string(),
            );
        }
    }
    Ok(remote_payment_id.to_string())
}

/// Record the remote debit durably, then mirror the canonical row through the
/// ordinary applied-payment path: no sync queue row, no drawer movement.
fn import_canonical_gift_payment(
    conn: &Connection,
    attempt: &Attempt,
    payment: &Value,
    now: &str,
) -> Result<String, String> {
    let remote_payment_id = validate_canonical_gift_payment(payment, attempt)?;
    let card_id = payment
        .get("gift_card_id")
        .or_else(|| payment.pointer("/metadata/gift_card_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    conn.execute(
        "UPDATE gift_card_redemption_attempts
         SET status = 'remote_applied', remote_payment_id = ?2,
             card_id = COALESCE(?3, card_id), updated_at = ?4
         WHERE idempotency_key = ?1 AND status IN ('pending', 'remote_applied')",
        params![attempt.idempotency_key, remote_payment_id, card_id, now],
    )
    .map_err(|e| format!("record remote gift card debit: {e}"))?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin gift card mirror: {e}"))?;
    let (local_order_id, local_payment_id) = sync::mirror_canonical_payment(&tx, payment)?
        .ok_or("The canonical gift card payment could not be mirrored locally")?;
    if local_order_id != attempt.local_order_id {
        return Err("The canonical gift card payment resolved to another local order".to_string());
    }
    tx.execute(
        "UPDATE gift_card_redemption_attempts
         SET status = 'applied', local_payment_id = ?2, last_error_code = NULL, updated_at = ?3
         WHERE idempotency_key = ?1",
        params![attempt.idempotency_key, local_payment_id, now],
    )
    .map_err(|e| format!("mark gift card attempt applied: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit gift card mirror: {e}"))?;
    Ok(local_payment_id)
}

fn local_settlement(conn: &Connection, local_order_id: &str) -> Value {
    let snapshot = payments::load_order_payment_balance_snapshot(conn, local_order_id);
    let payment_status: Option<String> = conn
        .query_row(
            "SELECT COALESCE(payment_status, 'pending') FROM orders WHERE id = ?1",
            params![local_order_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    match snapshot {
        Ok(snapshot) => json!({
            "orderTotal": snapshot.order_total,
            "paidTotal": snapshot.net_paid,
            "remaining": snapshot.outstanding_amount,
            "paymentStatus": payment_status,
        }),
        Err(error) => json!({ "unavailable": true, "error": error }),
    }
}

fn safe_card_summary(card: &Value) -> Value {
    let pick = |key: &str| card.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": pick("id"),
        "maskedNumber": pick("masked_number"),
        "last4": pick("card_number_last4"),
        "balance": pick("balance"),
        "currency": pick("currency"),
        "status": pick("status"),
        "expiresAt": pick("expires_at"),
    })
}

fn redemption_success(
    conn: &Connection,
    attempt: &Attempt,
    local_payment_id: &str,
    payment: &Value,
    response: Option<&Value>,
    recovered: bool,
) -> Value {
    json!({
        "success": true,
        "code": Value::Null,
        "replayed": response.and_then(|body| body.get("replayed")).and_then(Value::as_bool).unwrap_or(false),
        "recovered": recovered,
        "reconciliationPending": false,
        "orderId": attempt.local_order_id,
        "remoteOrderId": attempt.remote_order_id,
        "idempotencyKey": attempt.idempotency_key,
        "payment": {
            "localPaymentId": local_payment_id,
            "remotePaymentId": payment.get("id"),
            "method": payments::GIFT_CARD_METHOD,
            "amount": cents_to_amount(attempt.amount_cents),
            "amountCents": attempt.amount_cents,
            "currency": attempt.currency,
            "transactionRef": payment.get("external_transaction_id"),
            "balanceAfter": payment.get("balance_after").or_else(|| payment.pointer("/metadata/gift_card_balance_after")),
            "cardLast4": payment.pointer("/metadata/gift_card_last4"),
        },
        "card": response.and_then(|body| body.get("card")).map(safe_card_summary).unwrap_or(Value::Null),
        "serverSettlement": response.and_then(|body| body.get("settlement")).cloned().unwrap_or(Value::Null),
        "localSettlement": local_settlement(conn, &attempt.local_order_id),
        // Fiscal receipt state, separate from the financial success above.
        "fiscal": crate::commands::gift_card_fiscal::fiscal_disposition_for_order(conn, &attempt.local_order_id),
    })
}

fn reconciliation_pending(attempt: &Attempt, code: &str, error: String) -> Value {
    json!({
        "success": false,
        "code": code,
        "error": error,
        "reconciliationPending": true,
        "orderId": attempt.local_order_id,
        "idempotencyKey": attempt.idempotency_key,
    })
}

// ---------------------------------------------------------------------------
// Network orchestration (never under the SQLite mutex)
// ---------------------------------------------------------------------------

fn lock(db: &db::DbState) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.conn.lock().map_err(|e| e.to_string())
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

/// Exact no-mutation errors from redeem/route.ts, helpers.ts and the atomic
/// redemption RPC. A status alone, an unknown code or an identity/key conflict
/// is not proof. Even these reasons cannot settle an earlier unknown send.
fn definitive_rejection_code(error: &api::AdminFetchError) -> Option<&str> {
    let code = error.code()?;
    let allowed = match error.status()? {
        400 => matches!(
            code,
            "GIFT_CARD_NUMBER_REQUIRED"
                | "GIFT_CARD_AMOUNT_INVALID"
                | "GIFT_CARD_CURRENCY_REQUIRED"
                | "GIFT_CARD_CURRENCY_INVALID"
                | "GIFT_CARD_CURRENCY_MISMATCH"
                | "GIFT_CARD_ID_MISMATCH"
                | "GIFT_CARD_REDEMPTION_INVALID"
                | "GIFT_CARD_METADATA_INVALID"
                | "GIFT_CARD_ORDER_NOT_PAYABLE"
                | "GIFT_CARD_ORDER_PLATFORM_SETTLED"
                | "GIFT_CARD_ORDER_CURRENCY_MIXED"
                | "GIFT_CARD_ORDER_ALREADY_PAID"
                | "GIFT_CARD_ORDER_OVERPAYMENT"
                | "GIFT_CARD_EXPIRED"
                | "GIFT_CARD_NOT_ACTIVE"
                | "GIFT_CARD_INSUFFICIENT_BALANCE"
        ),
        403 => code == "GIFT_CARDS_MODULE_DISABLED",
        404 => matches!(code, "GIFT_CARD_ORDER_NOT_FOUND" | "GIFT_CARD_NOT_FOUND"),
        _ => false,
    };
    allowed.then_some(code)
}

fn current_staff_session_candidate(scope: &GiftScope) -> Result<String, Refusal> {
    let persisted = storage::session_get_strict().map_err(|_| {
        Refusal::new(
            "GIFT_CARD_STAFF_SESSION_UNAVAILABLE",
            "Secure staff session storage is unavailable",
        )
    })?;
    validate_staff_session_candidate(persisted.as_deref().map(String::as_str), scope)
}

fn validate_staff_session_candidate(
    raw: Option<&str>,
    scope: &GiftScope,
) -> Result<String, Refusal> {
    let raw = raw.ok_or_else(|| {
        Refusal::new(
            "GIFT_CARD_STAFF_SESSION_REQUIRED",
            "Sign in with a staff session before using gift cards",
        )
    })?;
    let invalid = || {
        Refusal::new(
            "GIFT_CARD_STAFF_SESSION_INVALID",
            "The stored staff session is invalid",
        )
    };
    if raw.is_empty() || raw.len() > STAFF_SESSION_MAX_BYTES {
        return Err(invalid());
    }
    let parsed: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    let object = parsed.as_object().ok_or_else(invalid)?;
    let uuid = |field: &str| -> Option<uuid::Uuid> {
        let value = object.get(field)?.as_str()?;
        let id = uuid::Uuid::parse_str(value).ok()?;
        (!id.is_nil() && id.to_string() == value).then_some(id)
    };
    let session_id = uuid("sessionId").ok_or_else(invalid)?;
    let organization_id = uuid("organizationId").ok_or_else(invalid)?;
    let branch_id = uuid("branchId").ok_or_else(invalid)?;
    uuid("staffId").ok_or_else(invalid)?;
    let terminal_id = object
        .get("terminalId")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && *value == value.trim()
                && !value.chars().any(char::is_control)
        })
        .ok_or_else(invalid)?;
    if uuid::Uuid::parse_str(&scope.organization_id).ok() != Some(organization_id)
        || uuid::Uuid::parse_str(&scope.branch_id).ok() != Some(branch_id)
        || scope.terminal_id != terminal_id
    {
        return Err(Refusal::new(
            "GIFT_CARD_STAFF_SESSION_SCOPE_MISMATCH",
            "The staff session belongs to another terminal scope",
        ));
    }
    // This is only a candidate. The main local PIN login can generate a UUID;
    // only the server can establish a hosted session, expiry and permissions.
    Ok(session_id.to_string())
}

fn attempt_preflight_refusal(attempt: &Attempt, refusal: Refusal) -> Value {
    if attempt.send_count > 0
        || attempt.last_sent_at.is_some()
        || attempt.status == "remote_applied"
    {
        reconciliation_pending(attempt, refusal.code, refusal.message)
    } else {
        refusal.into_json()
    }
}

async fn prepare_send_context(
    db: &db::DbState,
) -> Result<(String, zeroize::Zeroizing<String>, String), Refusal> {
    let scope = {
        let conn = lock(db).map_err(|_| {
            Refusal::new(
                "GIFT_CARD_LOCAL_STATE_UNAVAILABLE",
                "Local state is unavailable",
            )
        })?;
        if !order_payments_accept_gift_card(&conn).unwrap_or(false) {
            return Err(Refusal::new(
                "GIFT_CARD_LOCAL_SCHEMA_UNSUPPORTED",
                "This terminal cannot safely store gift payments",
            ));
        }
        resolve_trusted_scope(&conn).ok_or_else(|| {
            Refusal::new(
                "GIFT_CARD_TERMINAL_SCOPE_UNAVAILABLE",
                "The terminal scope is unavailable",
            )
        })?
    };
    let staff_session_id = current_staff_session_candidate(&scope)?;
    let (url, key) = crate::resolve_admin_endpoint(Some(db)).await.map_err(|_| {
        Refusal::new(
            "GIFT_CARD_TERMINAL_CREDENTIALS_UNAVAILABLE",
            "The managed terminal connection is unavailable",
        )
    })?;
    Ok((url, key, staff_session_id))
}

fn build_redeem_body(request: &RedeemRequest, attempt: &Attempt) -> Value {
    let mut body = json!({
        "card_number": request.card_number,
        "amount": cents_to_amount(attempt.amount_cents),
        "currency": attempt.currency,
        "order_id": attempt.remote_order_id,
        "idempotency_key": attempt.idempotency_key,
        "payment_contract": GIFT_CARD_PAYMENT_CONTRACT,
    });
    if let Some(split) = &attempt.split {
        body["metadata"] = json!({
            "split_payment": true,
            "split_group_id": split.group_id,
            "split_portion_id": split.portion_id,
        });
    }
    body
}

async fn fetch_canonical_order_payments(
    db: &db::DbState,
    remote_order_id: &str,
) -> Result<Vec<Value>, String> {
    let path = format!("{CANONICAL_PAYMENTS_PATH}?order_id={remote_order_id}");
    let body = crate::admin_fetch_detailed(Some(db), &path, "GET", None)
        .await
        .map_err(|error| error.to_string())?;
    // A missing list is an unknown state, never "no payment".
    body.get("payments")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "The canonical payment list is missing from the server response".to_string())
}

#[derive(Default)]
struct ReconcileSummary {
    applied: Vec<(Attempt, String, Value)>,
    abandoned: usize,
    unresolved: usize,
    error: Option<String>,
    idempotency_keys: Vec<String>,
}

async fn reconcile_attempts(db: &db::DbState, attempts: Vec<Attempt>) -> ReconcileSummary {
    let mut summary = ReconcileSummary {
        idempotency_keys: attempts
            .iter()
            .map(|attempt| attempt.idempotency_key.clone())
            .collect(),
        ..ReconcileSummary::default()
    };
    let Some(remote_order_id) = attempts
        .first()
        .map(|attempt| attempt.remote_order_id.clone())
    else {
        return summary;
    };
    let canonical = match fetch_canonical_order_payments(db, &remote_order_id).await {
        Ok(canonical) => canonical,
        Err(error) => {
            summary.unresolved = attempts.len();
            summary.error = Some(error);
            return summary;
        }
    };
    let conn = match lock(db) {
        Ok(conn) => conn,
        Err(error) => {
            summary.unresolved = attempts.len();
            summary.error = Some(error);
            return summary;
        }
    };
    let now = Utc::now();
    let now_text = now.to_rfc3339();
    for attempt in attempts {
        let found = canonical.iter().find(|payment| {
            payment.get("idempotency_key").and_then(Value::as_str)
                == Some(attempt.idempotency_key.as_str())
        });
        match found {
            Some(payment) => {
                match import_canonical_gift_payment(&conn, &attempt, payment, &now_text) {
                    Ok(local_payment_id) => {
                        summary
                            .applied
                            .push((attempt, local_payment_id, payment.clone()))
                    }
                    Err(error) => {
                        record_attempt_error(
                            &conn,
                            &attempt.idempotency_key,
                            "GIFT_CARD_LOCAL_MIRROR_FAILED",
                            &now_text,
                        );
                        summary.unresolved += 1;
                        summary.error = Some(error);
                    }
                }
            }
            None if attempt.status == "pending"
                && attempt.send_count == 0
                && attempt.last_sent_at.is_none() =>
            {
                match set_attempt_status(
                    &conn,
                    &attempt.idempotency_key,
                    "abandoned",
                    Some("GIFT_CARD_NEVER_SENT"),
                    &now_text,
                ) {
                    Ok(()) => summary.abandoned += 1,
                    Err(error) => {
                        summary.unresolved += 1;
                        summary.error = Some(error);
                    }
                }
            }
            None => summary.unresolved += 1,
        }
    }
    summary
}

fn unresolved_json(summary: &ReconcileSummary, local_order_id: &str) -> Value {
    json!({
        "success": false,
        "code": "GIFT_CARD_ATTEMPT_UNRESOLVED",
        "error": summary.error.clone().unwrap_or_else(|| {
            "An earlier gift card attempt on this order is still unresolved. Retry the same card and amount, or reconcile once the terminal is online.".to_string()
        }),
        "reconciliationPending": true,
        "retryAfterSeconds": RECONCILIATION_RETRY_SECS,
        "orderId": local_order_id,
        "idempotencyKey": if summary.idempotency_keys.len() == 1 { summary.idempotency_keys.first() } else { None },
        "idempotencyKeys": summary.idempotency_keys,
    })
}

async fn send_attempt(
    db: &db::DbState,
    request: &RedeemRequest,
    attempt: Attempt,
) -> Result<Value, String> {
    send_attempt_with_timeout(db, request, attempt, std::time::Duration::from_secs(30)).await
}

async fn send_attempt_with_timeout(
    db: &db::DbState,
    request: &RedeemRequest,
    mut attempt: Attempt,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    let (url, api_key, staff_session_id) = match prepare_send_context(db).await {
        Ok(context) => context,
        Err(refusal) => return Ok(attempt_preflight_refusal(&attempt, refusal)),
    };
    let first_send = attempt.send_count == 0 && attempt.last_sent_at.is_none();
    // The send is durable before the request leaves the terminal, and the
    // in-memory copy retains its unknown history on every subsequent refusal.
    let sent_at = now_rfc3339();
    let send_count = {
        let conn = lock(db)?;
        match mark_attempt_sent(&conn, &attempt.idempotency_key, &sent_at) {
            Ok(count) => count,
            Err(error) => {
                return Ok(attempt_preflight_refusal(
                    &attempt,
                    store_unavailable(error),
                ))
            }
        }
    };
    attempt.send_count = send_count;
    attempt.last_sent_at = Some(sent_at);
    let body = build_redeem_body(request, &attempt);
    let response = api::fetch_from_admin_detailed_with_staff_session(
        &url,
        &api_key,
        REDEEM_PATH,
        "POST",
        Some(body),
        Some(&staff_session_id),
        timeout,
    )
    .await;
    match response {
        Ok(response) => {
            let payment = response
                .get("payment")
                .filter(|payment| payment.is_object())
                .filter(|_| response.get("success").and_then(Value::as_bool) == Some(true));
            let conn = lock(db)?;
            let now = now_rfc3339();
            let Some(payment) = payment else {
                record_attempt_error(
                    &conn,
                    &attempt.idempotency_key,
                    "GIFT_CARD_RESPONSE_INVALID",
                    &now,
                );
                return Ok(reconciliation_pending(
                    &attempt,
                    "GIFT_CARD_OUTCOME_UNKNOWN",
                    "The server response had no canonical gift card payment".to_string(),
                ));
            };
            if let Err(error) = validate_canonical_gift_payment(payment, &attempt) {
                record_attempt_error(
                    &conn,
                    &attempt.idempotency_key,
                    "GIFT_CARD_CANONICAL_MISMATCH",
                    &now,
                );
                return Ok(reconciliation_pending(
                    &attempt,
                    "GIFT_CARD_CANONICAL_MISMATCH",
                    error,
                ));
            }
            match import_canonical_gift_payment(&conn, &attempt, payment, &now) {
                Ok(local_payment_id) => Ok(redemption_success(
                    &conn,
                    &attempt,
                    &local_payment_id,
                    payment,
                    Some(&response),
                    false,
                )),
                Err(error) => {
                    record_attempt_error(
                        &conn,
                        &attempt.idempotency_key,
                        "GIFT_CARD_LOCAL_MIRROR_FAILED",
                        &now,
                    );
                    let mut pending =
                        reconciliation_pending(&attempt, "GIFT_CARD_LOCAL_MIRROR_PENDING", error);
                    pending["remotePaymentId"] = payment.get("id").cloned().unwrap_or(Value::Null);
                    Ok(pending)
                }
            }
        }
        Err(error) => handle_failed_send(db, attempt, first_send, &error).await,
    }
}

async fn handle_failed_send(
    db: &db::DbState,
    attempt: Attempt,
    first_send: bool,
    error: &api::AdminFetchError,
) -> Result<Value, String> {
    let status = error.status();
    // A rejection of the first send proves no debit under this key. After an
    // earlier send (lost response) only the ledger can tell.
    if let Some(code) =
        definitive_rejection_code(error).filter(|_| first_send && attempt.send_count == 1)
    {
        let conn = lock(db)?;
        set_attempt_status(
            &conn,
            &attempt.idempotency_key,
            "abandoned",
            Some(code),
            &now_rfc3339(),
        )?;
        return Ok(json!({
            "success": false,
            "code": code,
            "error": error.to_string(),
            "status": status,
            "reconciliationPending": false,
            "orderId": attempt.local_order_id,
        }));
    }
    // Unknown outcome, or a rejection after an earlier send: ask the ledger.
    let summary = reconcile_attempts(db, vec![attempt.clone()]).await;
    if let Some((applied, local_payment_id, payment)) = summary.applied.first() {
        let conn = lock(db)?;
        return Ok(redemption_success(
            &conn,
            applied,
            local_payment_id,
            payment,
            None,
            true,
        ));
    }
    let mut pending = reconciliation_pending(
        &attempt,
        "GIFT_CARD_OUTCOME_UNKNOWN",
        summary.error.unwrap_or_else(|| error.to_string()),
    );
    pending["status"] = json!(status);
    pending["serverCode"] = json!(error.code());
    pending["retryAfterSeconds"] = json!(RECONCILIATION_RETRY_SECS);
    Ok(pending)
}

#[cfg(test)]
async fn redeem_for_local_order(
    db: &db::DbState,
    request: &RedeemRequest,
    local_order_id: &str,
) -> Result<Value, String> {
    redeem_for_local_order_gated(db, request, local_order_id, None).await
}

async fn redeem_for_local_order_gated(
    db: &db::DbState,
    request: &RedeemRequest,
    local_order_id: &str,
    gate: Option<&super::gift_card_fiscal::FreshDebitGate<'_>>,
) -> Result<Value, String> {
    for _ in 0..2 {
        let prepared = {
            let conn = lock(db)?;
            match resolve_trusted_scope(&conn) {
                Some(scope) => prepare_with_scope_gated(
                    &conn,
                    scope,
                    request,
                    local_order_id,
                    &now_rfc3339(),
                    gate,
                ),
                None => Err(Refusal::new(
                    "GIFT_CARD_TERMINAL_SCOPE_UNAVAILABLE",
                    "This terminal is not paired with an organization, branch and terminal id",
                )),
            }
        };
        match prepared {
            Err(refusal) => return Ok(refusal.into_json()),
            Ok(Prepared::Send(attempt)) => return send_attempt(db, request, attempt).await,
            Ok(Prepared::Import(attempt)) => {
                let summary = reconcile_attempts(db, vec![attempt]).await;
                if let Some((applied, local_payment_id, payment)) = summary.applied.first() {
                    let conn = lock(db)?;
                    return Ok(redemption_success(
                        &conn,
                        applied,
                        local_payment_id,
                        payment,
                        None,
                        true,
                    ));
                }
                return Ok(unresolved_json(&summary, local_order_id));
            }
            Ok(Prepared::ResolvePrior(prior)) => {
                let summary = reconcile_attempts(db, prior).await;
                if !summary.applied.is_empty() {
                    let conn = lock(db)?;
                    return Ok(json!({
                        "success": false,
                        "code": "GIFT_CARD_PRIOR_ATTEMPT_APPLIED",
                        "error": "An earlier gift card payment on this order was completed. Review the remaining balance before charging again.",
                        "reconciliationPending": summary.unresolved > 0,
                        "idempotencyKeys": summary.idempotency_keys,
                        "orderId": local_order_id,
                        "localSettlement": local_settlement(&conn, local_order_id),
                    }));
                }
                if summary.unresolved > 0 {
                    return Ok(unresolved_json(&summary, local_order_id));
                }
                // Only demonstrably never-sent prior intents were released.
            }
        }
    }
    Ok(Refusal::new(
        "GIFT_CARD_ATTEMPT_UNRESOLVED",
        "The gift card attempt could not be prepared; try again",
    )
    .into_json())
}

fn resolve_local_order(db: &db::DbState, order_ref: &str) -> Result<Option<String>, String> {
    let conn = lock(db)?;
    Ok(resolve_order_id(&conn, order_ref))
}

/// Redeem a gift card against a local order through the atomic server RPC.
///
/// Payload: `{ orderId, cardNumber, amount, currency, split?: { groupId, portionId } }`.
/// The card number is used for this request only and never stored or logged.
#[tauri::command]
pub async fn gift_card_redeem_for_order(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, crate::ecr::DeviceManager>,
) -> Result<Value, String> {
    let payload = arg0.ok_or("Missing gift card redemption payload")?;
    let request = match parse_redeem_request(&payload) {
        Ok(request) => request,
        Err(refusal) => return Ok(refusal.into_json()),
    };
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let Some(local_order_id) = resolve_local_order(&db, &request.order_ref)? else {
        return Ok(Refusal::new(
            "GIFT_CARD_ORDER_NOT_FOUND",
            "Order not found on this terminal",
        )
        .into_json());
    };
    let _reservation = match crate::commands::payments::reserve_payment_record(&local_order_id) {
        Ok(reservation) => reservation,
        Err(error) => return Ok(Refusal::new("GIFT_CARD_ORDER_BUSY", error).into_json()),
    };
    // Refuse fiscal routes known to be unsupported or unverifiable before any
    // fresh debit, so no balance is taken that the register cannot fiscalise.
    let gate = super::gift_card_fiscal::FreshDebitGate {
        access: &*mgr,
        cloud: super::gift_card_fiscal::fetch_cloud_route(&db).await,
    };
    redeem_for_local_order_gated(&db, &request, &local_order_id, Some(&gate)).await
}

/// Resolve every unresolved gift card attempt of a local order for the current
/// terminal scope: import positive canonical proof. A sent attempt remains
/// unresolved through empty reads and any amount of elapsed time.
#[tauri::command]
pub async fn gift_card_reconcile_order(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.ok_or("Missing gift card reconciliation payload")?;
    let Some(order_ref) = text_field(&payload, &["orderId", "order_id"]) else {
        return Ok(Refusal::new("GIFT_CARD_ORDER_REQUIRED", "An order is required").into_json());
    };
    crate::hydrate_terminal_credentials_from_local_settings(&db);
    let Some(local_order_id) = resolve_local_order(&db, &order_ref)? else {
        return Ok(Refusal::new(
            "GIFT_CARD_ORDER_NOT_FOUND",
            "Order not found on this terminal",
        )
        .into_json());
    };
    let _reservation = match crate::commands::payments::reserve_payment_record(&local_order_id) {
        Ok(reservation) => reservation,
        Err(error) => return Ok(Refusal::new("GIFT_CARD_ORDER_BUSY", error).into_json()),
    };
    let unresolved = {
        let conn = lock(&db)?;
        let Some(scope) = resolve_trusted_scope(&conn) else {
            return Ok(Refusal::new(
                "GIFT_CARD_TERMINAL_SCOPE_UNAVAILABLE",
                "This terminal is not paired with an organization, branch and terminal id",
            )
            .into_json());
        };
        ensure_attempt_schema(&conn)?;
        load_unresolved_attempts(&conn, &scope, &local_order_id)?
    };
    let summary = reconcile_attempts(&db, unresolved).await;
    let conn = lock(&db)?;
    Ok(json!({
        "success": summary.unresolved == 0,
        "code": if summary.unresolved == 0 { Value::Null } else { json!("GIFT_CARD_ATTEMPT_UNRESOLVED") },
        "error": summary.error,
        "orderId": local_order_id,
        "applied": summary.applied.iter().map(|(attempt, local_payment_id, payment)| json!({
            "idempotencyKey": attempt.idempotency_key,
            "localPaymentId": local_payment_id,
            "remotePaymentId": payment.get("id"),
            "amountCents": attempt.amount_cents,
            "currency": attempt.currency,
        })).collect::<Vec<_>>(),
        "abandoned": summary.abandoned,
        "unresolved": summary.unresolved,
        "reconciliationPending": summary.unresolved > 0,
        "localSettlement": local_settlement(&conn, &local_order_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const ACTOR_SESSION: &str = "30a0484e-f0cc-42c7-aad0-d17b06b7e3f6";
    const ACTOR_ORG: &str = "50a0484e-f0cc-42c7-aad0-d17b06b7e3f6";
    const ACTOR_BRANCH: &str = "60a0484e-f0cc-42c7-aad0-d17b06b7e3f6";
    const ACTOR_STAFF: &str = "70a0484e-f0cc-42c7-aad0-d17b06b7e3f6";

    struct HttpReply {
        status: u16,
        body: Value,
        release: Option<Arc<tokio::sync::Notify>>,
        late_payment: Option<Value>,
    }

    impl HttpReply {
        fn json(status: u16, body: Value) -> Self {
            Self {
                status,
                body,
                release: None,
                late_payment: None,
            }
        }
    }

    #[derive(Default)]
    struct RemoteFixture {
        requests: Vec<crate::tests::fake_http::RecordedRequest>,
        replies: VecDeque<HttpReply>,
        payments: Vec<Value>,
        committed: usize,
        read_override: Option<Value>,
    }

    struct GiftHttpServer {
        url: String,
        remote: Arc<Mutex<RemoteFixture>>,
        committed: Arc<tokio::sync::Notify>,
        task: tokio::task::JoinHandle<()>,
    }

    impl GiftHttpServer {
        async fn new(replies: Vec<HttpReply>) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let remote = Arc::new(Mutex::new(RemoteFixture {
                replies: replies.into(),
                ..RemoteFixture::default()
            }));
            let shared = remote.clone();
            let committed = Arc::new(tokio::sync::Notify::new());
            let committed_signal = committed.clone();
            let task = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let shared = shared.clone();
                    let committed_signal = committed_signal.clone();
                    connections.spawn(async move {
                        let mut raw = Vec::new();
                        let header_end = loop {
                            let mut buf = [0u8; 2048];
                            let n = stream.read(&mut buf).await.unwrap();
                            assert!(n > 0 && raw.len() + n < 64 * 1024);
                            raw.extend_from_slice(&buf[..n]);
                            if let Some(offset) = raw.windows(4).position(|part| part == b"\r\n\r\n") {
                                break offset + 4;
                            }
                        };
                        let headers = String::from_utf8(raw[..header_end].to_vec()).unwrap();
                        let mut lines = headers.lines();
                        let mut first = lines.next().unwrap().split_whitespace();
                        let mut request = crate::tests::fake_http::RecordedRequest {
                            method: first.next().unwrap().into(), path: first.next().unwrap().into(),
                            ..Default::default()
                        };
                        for line in lines {
                            if let Some((key, value)) = line.split_once(':') {
                                request.headers.insert(key.trim().to_ascii_lowercase(), value.trim().into());
                            }
                        }
                        let length: usize = request.header("content-length").unwrap_or("0").parse().unwrap();
                        assert!(length < 32 * 1024);
                        while raw.len() < header_end + length {
                            let mut buf = [0u8; 2048];
                            let n = stream.read(&mut buf).await.unwrap();
                            assert!(n > 0);
                            raw.extend_from_slice(&buf[..n]);
                        }
                        request.body = String::from_utf8(raw[header_end..header_end + length].to_vec()).unwrap();
                        let reply = {
                            let mut state = shared.lock().unwrap();
                            state.requests.push(request.clone());
                            if request.method == "POST" {
                                state.replies.pop_front().expect("unexpected additional debit request")
                            } else {
                                HttpReply::json(200, state.read_override.clone().unwrap_or_else(|| json!({ "payments": state.payments })))
                            }
                        };
                        if let Some(release) = reply.release {
                            release.notified().await;
                        }
                        if let Some(payment) = reply.late_payment {
                            let mut state = shared.lock().unwrap();
                            state.payments.push(payment);
                            state.committed += 1;
                            committed_signal.notify_one();
                        }
                        let body = reply.body.to_string();
                        let response = format!("HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.status, body.len(), body);
                        let _ = stream.write_all(response.as_bytes()).await;
                    });
                }
            });
            Self {
                url,
                remote,
                committed,
                task,
            }
        }

        fn posts(&self) -> Vec<crate::tests::fake_http::RecordedRequest> {
            self.remote
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|request| request.method == "POST")
                .cloned()
                .collect()
        }
    }

    impl Drop for GiftHttpServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn actor_scope() -> GiftScope {
        GiftScope {
            organization_id: ACTOR_ORG.into(),
            branch_id: ACTOR_BRANCH.into(),
            terminal_id: "terminal-1".into(),
        }
    }

    fn actor_session() -> Value {
        json!({ "sessionId": ACTOR_SESSION, "organizationId": ACTOR_ORG,
            "branchId": ACTOR_BRANCH, "staffId": ACTOR_STAFF, "terminalId": "terminal-1" })
    }

    fn actor_state(conn: Connection, path: std::path::PathBuf) -> db::DbState {
        for (key, value) in [
            ("organization_id", ACTOR_ORG),
            ("branch_id", ACTOR_BRANCH),
            ("terminal_id", "terminal-1"),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        db::DbState {
            conn: Mutex::new(conn),
            db_path: path,
        }
    }

    fn actor_attempt(state: &db::DbState, req: &RedeemRequest) -> Attempt {
        let conn = state.conn.lock().unwrap();
        match prepare_with_scope(&conn, actor_scope(), req, "order-1", &now_rfc3339()).unwrap() {
            Prepared::Send(attempt) => attempt,
            _ => panic!("expected same-key send"),
        }
    }

    fn install_actor(url: &str) -> crate::tests::fake_keyring::Guard {
        let guard = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "terminal-1"),
            ("pos_api_key", "fixture-key"),
            ("admin_dashboard_url", url),
        ]);
        storage::session_set(&actor_session().to_string()).unwrap();
        guard
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        ensure_attempt_schema(&conn).expect("attempt schema");
        conn
    }

    fn scope() -> GiftScope {
        GiftScope {
            organization_id: "org-1".into(),
            branch_id: "branch-1".into(),
            terminal_id: "terminal-1".into(),
        }
    }

    const REMOTE_ORDER: &str = "6f1c2c1e-3a2b-4c5d-9e8f-0a1b2c3d4e5f";

    fn seed_order(conn: &Connection, id: &str, remote: Option<&str>, total_cents: i64) {
        conn.execute(
            "INSERT INTO orders (
                 id, items, total_amount, total_amount_cents, status, order_type,
                 payment_status, sync_status, supabase_id, created_at, updated_at
             ) VALUES (?1, '[]', ?2, ?3, 'completed', 'takeaway', 'pending', 'synced', ?4, ?5, ?5)",
            params![
                id,
                cents_to_amount(total_cents),
                total_cents,
                remote,
                "2026-09-28T10:00:00Z"
            ],
        )
        .expect("seed order");
    }

    fn request(amount: f64, card: &str) -> RedeemRequest {
        parse_redeem_request(&json!({
            "orderId": "order-1",
            "cardNumber": card,
            "amount": amount,
            "currency": "eur",
        }))
        .unwrap_or_else(|refusal| panic!("parse request: {refusal:?}"))
    }

    fn canonical_payment(attempt: &Attempt, id: &str) -> Value {
        json!({
            "id": id,
            "order_id": attempt.remote_order_id,
            "amount": cents_to_amount(attempt.amount_cents),
            "amount_cents": attempt.amount_cents,
            "tip_amount": 0,
            "tip_amount_cents": 0,
            "currency": "EUR",
            "payment_method": "gift_card",
            "method": "gift_card",
            "status": "completed",
            "idempotency_key": attempt.idempotency_key,
            "external_transaction_id": "gift_card:tx-1",
            "gift_card_id": "card-1",
            "gift_card_transaction_id": "tx-1",
            "metadata": {
                "source": "gift_card_redeem",
                "gift_card_id": "card-1",
                "gift_card_transaction_id": "tx-1",
                "gift_card_last4": "4321",
            },
            "created_at": "2026-09-28T10:01:00Z",
        })
    }

    fn send_attempt_for(conn: &Connection, amount: f64, card: &str) -> Attempt {
        match prepare_with_scope(
            conn,
            scope(),
            &request(amount, card),
            "order-1",
            "2026-09-28T10:00:30Z",
        ) {
            Ok(Prepared::Send(attempt)) => attempt,
            Ok(_) => panic!("expected a new attempt"),
            Err(refusal) => panic!("prepare refused: {refusal:?}"),
        }
    }

    fn split_attempt_for(conn: &Connection, amount: f64, group: &str, portion: &str) -> Attempt {
        let request = parse_redeem_request(&json!({
            "orderId": "order-1",
            "cardNumber": "GC12345678",
            "amount": amount,
            "currency": "eur",
            "split": { "groupId": group, "portionId": portion },
        }))
        .unwrap_or_else(|refusal| panic!("parse split request: {refusal:?}"));
        match prepare_with_scope(conn, scope(), &request, "order-1", "2026-09-28T10:00:30Z") {
            Ok(Prepared::Send(attempt)) => attempt,
            Ok(_) => panic!("expected a new split attempt"),
            Err(refusal) => panic!("prepare split refused: {refusal:?}"),
        }
    }

    /// Applies an attempt through the real validate-and-mirror import path.
    fn import_applied(conn: &Connection, attempt: &Attempt, remote_payment_id: &str) -> String {
        let mut payment = canonical_payment(attempt, remote_payment_id);
        if let Some(split) = &attempt.split {
            payment["metadata"]["split_group_id"] = json!(split.group_id);
            payment["metadata"]["split_portion_id"] = json!(split.portion_id);
        }
        import_canonical_gift_payment(conn, attempt, &payment, "2026-09-28T10:01:00Z")
            .expect("import canonical gift payment")
    }

    fn trust_terminal(conn: &Connection, terminal_id: &str) {
        for (key, value) in [
            ("organization_id", "org-1"),
            ("branch_id", "branch-1"),
            ("terminal_id", terminal_id),
        ] {
            db::set_setting(conn, "terminal", key, value).expect("trusted scope setting");
        }
    }

    fn db_state(conn: Connection) -> db::DbState {
        db::DbState {
            conn: Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn split_json(group: &str, portion: &str) -> Value {
        json!({ "classification": "split", "splitGroupId": group, "splitPortionId": portion })
    }

    fn unavailable_json(reason: &str) -> Value {
        json!({ "classification": "unavailable", "reason": reason })
    }

    fn without_projection(mut snapshot: Value) -> Value {
        for payment in snapshot["completedPayments"]
            .as_array_mut()
            .expect("payments")
        {
            payment
                .as_object_mut()
                .expect("payment")
                .remove("originalGiftSplit");
        }
        snapshot
    }

    #[test]
    fn applied_original_split_rereads_identically_after_reopen_without_replay() {
        let path = std::env::temp_dir().join(format!("gift-split-{}.db", uuid::Uuid::new_v4()));
        let open = || {
            let conn = Connection::open(&path).expect("open file db");
            conn.execute_batch("PRAGMA foreign_keys = ON;")
                .expect("pragma setup");
            conn
        };
        let conn = open();
        db::run_migrations_for_test(&conn);
        ensure_attempt_schema(&conn).expect("attempt schema");
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = split_attempt_for(&conn, 12.34, "group-7", "portion-2");
        let local_id = import_applied(&conn, &attempt, "remote-pay-1");
        trust_terminal(&conn, "terminal-1");
        let (card_fingerprint, request_fingerprint): (String, String) = conn
            .query_row(
                "SELECT card_fingerprint, request_fingerprint FROM gift_card_redemption_attempts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("one journal row");
        let read = |db: &db::DbState| {
            (
                payments::get_order_payments(db, "order-1").expect("order payments"),
                payments::get_order_settlement_snapshot(db, "order-1").expect("settlement"),
            )
        };
        let db = db_state(conn);
        let before = read(&db);
        drop(db);
        // A new process: no migration, schema ensure, recovery or reconcile runs.
        let db = db_state(open());
        let after = read(&db);
        assert_eq!(before, after);

        let (rows, snapshot) = &after;
        assert_eq!(rows[0]["id"], json!(local_id));
        assert_eq!(rows[0]["remotePaymentId"], "remote-pay-1");
        assert_eq!(
            rows[0]["originalGiftSplit"],
            split_json("group-7", "portion-2")
        );
        assert_eq!(snapshot["completedPayments"], *rows);
        assert!((snapshot["outstandingAmount"].as_f64().unwrap() - 7.66).abs() < 0.001);
        let text = serde_json::to_string(&after).unwrap();
        for secret in [
            "GC12345678",
            card_fingerprint.as_str(),
            request_fingerprint.as_str(),
        ] {
            assert!(
                !text.contains(secret),
                "canonical read leaked gift secret material"
            );
        }
        let projection = rows[0]["originalGiftSplit"].to_string();
        assert!(!projection.contains(&attempt.idempotency_key));
        {
            let conn = db.conn.lock().unwrap();
            let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
            assert_eq!(
                count("SELECT COUNT(*) FROM order_payments"),
                1,
                "no money replay"
            );
            assert_eq!(
                count(
                    "SELECT COUNT(*) FROM gift_card_redemption_attempts WHERE status = 'applied'"
                ),
                1
            );
        }
        drop(db);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn full_gift_tender_projects_an_explicit_no_split() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = send_attempt_for(&conn, 12.34, "GC12345678");
        let local_id = import_applied(&conn, &attempt, "remote-pay-1");
        trust_terminal(&conn, "terminal-1");
        let db = db_state(conn);
        let rows = payments::get_order_payments(&db, "order-1").expect("order payments");
        assert_eq!(rows[0]["id"], json!(local_id));
        assert_eq!(
            rows[0]["originalGiftSplit"],
            json!({ "classification": "full" })
        );
        let snapshot = payments::get_order_settlement_snapshot(&db, "order-1").expect("snapshot");
        assert_eq!(snapshot["completedPayments"], rows);
    }

    #[test]
    fn accepted_split_ids_keep_their_original_domain_after_reopen() {
        let path =
            std::env::temp_dir().join(format!("gift-split-domain-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        db::run_migrations_for_test(&conn);
        ensure_attempt_schema(&conn).unwrap();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = split_attempt_for(&conn, 12.34, "group-\n7", "portion-2");
        import_applied(&conn, &attempt, "remote-domain-1");
        trust_terminal(&conn, "terminal-1");
        drop(conn);
        let db = db_state(Connection::open(&path).unwrap());
        let rows = payments::get_order_payments(&db, "order-1").unwrap();
        assert_eq!(
            rows[0]["originalGiftSplit"],
            split_json("group-\n7", "portion-2")
        );
        assert_eq!(rows.as_array().unwrap().len(), 1);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn current_remote_order_binding_must_match_the_original_applied_journal() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = split_attempt_for(&conn, 12.34, "group-7", "portion-2");
        import_applied(&conn, &attempt, "remote-binding-1");
        trust_terminal(&conn, "terminal-1");
        let db = db_state(conn);
        let original = payments::get_order_settlement_snapshot(&db, "order-1").unwrap();
        for remote in [
            None,
            Some(""),
            Some("not-a-uuid"),
            Some("11111111-1111-4111-8111-111111111111"),
        ] {
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE orders SET supabase_id = ?1 WHERE id = 'order-1'",
                    params![remote],
                )
                .unwrap();
            let read = payments::get_order_settlement_snapshot(&db, "order-1").unwrap();
            assert_eq!(
                read["completedPayments"][0]["originalGiftSplit"],
                unavailable_json("journal_mismatch")
            );
            assert_eq!(
                without_projection(read),
                without_projection(original.clone())
            );
        }
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE orders SET supabase_id = ?1 WHERE id = 'order-1'",
                params![REMOTE_ORDER],
            )
            .unwrap();
        assert_eq!(
            payments::get_order_settlement_snapshot(&db, "order-1").unwrap(),
            original
        );
    }

    #[test]
    fn unproven_gift_rows_never_project_a_split() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = split_attempt_for(&conn, 12.34, "group-7", "portion-2");
        let local_id = import_applied(&conn, &attempt, "remote-pay-1");
        let trusted = scope();
        let proven = CanonicalGiftRow {
            method: "gift_card",
            local_payment_id: &local_id,
            remote_payment_id: Some("remote-pay-1"),
            local_order_id: "order-1",
            currency: "EUR",
            gross_cents: Some(1234),
        };
        let lower_iso = CanonicalGiftRow {
            currency: "eur",
            ..proven
        };
        for row in [proven, lower_iso] {
            assert_eq!(
                original_gift_split(&conn, Some(&trusted), &row),
                OriginalGiftSplit::Split {
                    group_id: "group-7".into(),
                    portion_id: "portion-2".into(),
                }
            );
        }

        let other_org = GiftScope {
            organization_id: "org-2".into(),
            ..scope()
        };
        let other_branch = GiftScope {
            branch_id: "branch-2".into(),
            ..scope()
        };
        let other_terminal = GiftScope {
            terminal_id: "terminal-2".into(),
            ..scope()
        };
        let cases = [
            (proven, None, "trusted_scope_unavailable"),
            (proven, Some(&other_org), "journal_mismatch"),
            (proven, Some(&other_branch), "journal_mismatch"),
            (proven, Some(&other_terminal), "journal_mismatch"),
            (
                CanonicalGiftRow {
                    local_order_id: "order-2",
                    ..proven
                },
                Some(&trusted),
                "journal_mismatch",
            ),
            (
                CanonicalGiftRow {
                    currency: "USD",
                    ..proven
                },
                Some(&trusted),
                "journal_mismatch",
            ),
            (
                CanonicalGiftRow {
                    gross_cents: Some(1235),
                    ..proven
                },
                Some(&trusted),
                "journal_mismatch",
            ),
            (
                CanonicalGiftRow {
                    method: "card",
                    ..proven
                },
                Some(&trusted),
                "payment_unverifiable",
            ),
            (
                CanonicalGiftRow {
                    gross_cents: None,
                    ..proven
                },
                Some(&trusted),
                "payment_unverifiable",
            ),
            (
                CanonicalGiftRow {
                    remote_payment_id: None,
                    ..proven
                },
                Some(&trusted),
                "payment_unverifiable",
            ),
            (
                CanonicalGiftRow {
                    remote_payment_id: Some("remote-pay-9"),
                    ..proven
                },
                Some(&trusted),
                "journal_conflict",
            ),
            (
                CanonicalGiftRow {
                    local_payment_id: "pay-other",
                    ..proven
                },
                Some(&trusted),
                "journal_conflict",
            ),
            (
                CanonicalGiftRow {
                    local_payment_id: "pay-other",
                    remote_payment_id: Some("remote-pay-9"),
                    ..proven
                },
                Some(&trusted),
                "journal_unmatched",
            ),
        ];
        for (row, trust, reason) in cases {
            assert_eq!(
                original_gift_split(&conn, trust, &row),
                OriginalGiftSplit::Unavailable(reason),
                "{reason}"
            );
        }

        // Through the canonical reads only the projection differs between a
        // proven and an unproven read: amount, refunds, net and generation don't.
        let db = db_state(conn);
        let read = |terminal_id: &str| {
            trust_terminal(&db.conn.lock().unwrap(), terminal_id);
            payments::get_order_settlement_snapshot(&db, "order-1").expect("settlement snapshot")
        };
        let proven_read = read("terminal-1");
        let foreign_read = read("terminal-2");
        assert_eq!(
            proven_read["completedPayments"][0]["originalGiftSplit"],
            split_json("group-7", "portion-2")
        );
        assert_eq!(
            foreign_read["completedPayments"][0]["originalGiftSplit"],
            unavailable_json("journal_mismatch")
        );
        let proven_read = without_projection(proven_read);
        assert_eq!(without_projection(foreign_read), proven_read);
        let payment = &proven_read["completedPayments"][0];
        assert_eq!(payment["amount"], json!(12.34));
        assert_eq!(payment["refundedAmount"], json!(0.0));
        assert_eq!(payment["remainingRefundable"], json!(12.34));
        assert!((proven_read["netPaid"].as_f64().unwrap() - 12.34).abs() < 0.001);
        assert!((proven_read["outstandingAmount"].as_f64().unwrap() - 7.66).abs() < 0.001);

        {
            let conn = db.conn.lock().unwrap();
            let bind = |key: &str,
                        status: &str,
                        split: (Option<&str>, Option<&str>),
                        local: Option<&str>,
                        remote: &str| {
                conn.execute(
                    "INSERT INTO gift_card_redemption_attempts (idempotency_key, organization_id,
                         branch_id, terminal_id, local_order_id, remote_order_id, amount_cents,
                         currency, card_fingerprint, request_fingerprint, split_group_id,
                         split_portion_id, status, local_payment_id, remote_payment_id,
                         created_at, updated_at)
                     VALUES (?1, 'org-1', 'branch-1', 'terminal-1', 'order-1', ?2, 1234, 'EUR',
                             'fp', 'rfp', ?3, ?4, ?5, ?6, ?7, 'now', 'now')",
                    params![key, REMOTE_ORDER, split.0, split.1, status, local, remote],
                )
                .expect("journal fixture");
            };
            let long = "g".repeat(SPLIT_ID_MAX_CHARS + 1);
            let fixtures = [
                (
                    "one-sided",
                    "applied",
                    (Some("group-9"), None),
                    Some("pay-a"),
                    "remote-a",
                    "journal_malformed",
                ),
                (
                    "padded",
                    "applied",
                    (Some(" group-9"), Some("portion-1")),
                    Some("pay-b"),
                    "remote-b",
                    "journal_malformed",
                ),
                (
                    "too-long",
                    "applied",
                    (Some(long.as_str()), Some("portion-1")),
                    Some("pay-c"),
                    "remote-c",
                    "journal_malformed",
                ),
                (
                    "unresolved",
                    "remote_applied",
                    (None, None),
                    None,
                    "remote-d",
                    "journal_unresolved",
                ),
                (
                    "abandoned",
                    "abandoned",
                    (None, None),
                    Some("pay-e"),
                    "remote-e",
                    "journal_conflict",
                ),
            ];
            for (key, status, split, local, remote, reason) in fixtures {
                bind(key, status, split, local, remote);
                let row = CanonicalGiftRow {
                    local_payment_id: local.unwrap_or("pay-d"),
                    remote_payment_id: Some(remote),
                    ..proven
                };
                assert_eq!(
                    original_gift_split(&conn, Some(&trusted), &row),
                    OriginalGiftSplit::Unavailable(reason),
                    "{key}"
                );
            }
            // A second applied row bound to the same payment is a duplicate,
            // never a choice.
            bind(
                "duplicate",
                "applied",
                (Some("group-7"), Some("portion-2")),
                Some(&local_id),
                "remote-pay-1",
            );
            assert_eq!(
                original_gift_split(&conn, Some(&trusted), &proven),
                OriginalGiftSplit::Unavailable("journal_conflict")
            );
            conn.execute_batch("DROP TABLE gift_card_redemption_attempts")
                .expect("lose the journal");
            assert_eq!(
                original_gift_split(&conn, Some(&trusted), &proven),
                OriginalGiftSplit::Unavailable("journal_unavailable")
            );
        }
        // A lost journal keeps the ordinary canonical read and proves nothing.
        let lost_read = read("terminal-1");
        assert_eq!(
            lost_read["completedPayments"][0]["originalGiftSplit"],
            unavailable_json("journal_unavailable")
        );
        assert_eq!(without_projection(lost_read), proven_read);
    }

    #[test]
    fn parses_whole_cents_currency_and_split_but_refuses_item_split() {
        let parsed = parse_redeem_request(&json!({
            "orderId": "o", "cardNumber": " gc-1234 5678 ", "amount": 12.34, "currency": "eur",
            "split": { "groupId": "g", "portionId": "p" },
        }))
        .unwrap_or_else(|refusal| panic!("{refusal:?}"));
        assert_eq!(parsed.card_number, "GC12345678");
        assert_eq!(parsed.amount_cents, 1234);
        assert_eq!(parsed.currency, "EUR");
        assert_eq!(
            parsed.split,
            Some(SplitContext {
                group_id: "g".into(),
                portion_id: "p".into()
            })
        );

        let refusal = |payload: Value| parse_redeem_request(&payload).err().map(|r| r.code);
        let base =
            json!({ "orderId": "o", "cardNumber": "GC12345678", "amount": 1.0, "currency": "EUR" });
        let with = |key: &str, value: Value| {
            let mut payload = base.clone();
            payload[key] = value;
            payload
        };
        assert_eq!(
            refusal(with("amount", json!(1.005))),
            Some("GIFT_CARD_AMOUNT_INVALID")
        );
        assert_eq!(
            refusal(with("amount", json!(-1))),
            Some("GIFT_CARD_AMOUNT_INVALID")
        );
        assert_eq!(
            refusal(with("currency", json!("EURO"))),
            Some("GIFT_CARD_CURRENCY_REQUIRED")
        );
        assert_eq!(
            refusal(with("cardNumber", json!("12"))),
            Some("GIFT_CARD_NUMBER_REQUIRED")
        );
        assert_eq!(
            refusal(with("items", json!([{ "order_item_id": "i1" }]))),
            Some("GIFT_CARD_ITEM_SPLIT_UNSUPPORTED")
        );
        assert_eq!(
            refusal(with("splitGroupId", json!("x".repeat(129)))),
            Some("GIFT_CARD_METADATA_INVALID")
        );
    }

    #[test]
    fn redeem_body_uses_atomic_contract_and_split_metadata() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let mut req = request(5.0, "GC12345678");
        req.split = Some(SplitContext {
            group_id: "g".into(),
            portion_id: "p".into(),
        });
        let Ok(Prepared::Send(attempt)) =
            prepare_with_scope(&conn, scope(), &req, "order-1", "2026-09-28T10:00:30Z")
        else {
            panic!("expected attempt");
        };
        let body = build_redeem_body(&req, &attempt);
        assert_eq!(body["payment_contract"], "atomic_v1");
        assert_eq!(body["order_id"], REMOTE_ORDER);
        assert_eq!(body["currency"], "EUR");
        assert_eq!(body["amount"], json!(5.0));
        assert_eq!(body["idempotency_key"], json!(attempt.idempotency_key));
        assert_eq!(body["metadata"]["split_group_id"], "g");
        assert_eq!(body["metadata"]["split_payment"], true);
    }

    #[test]
    fn attempt_is_durable_reused_and_blocks_changed_card_or_amount() {
        let path = std::env::temp_dir().join(format!("gift-attempts-{}.db", uuid::Uuid::new_v4()));
        let key = {
            let conn = Connection::open(&path).expect("open file db");
            db::run_migrations_for_test(&conn);
            seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
            send_attempt_for(&conn, 12.34, "GC12345678").idempotency_key
        };
        // A restart reopens the same attempt for the same request.
        let conn = Connection::open(&path).expect("reopen file db");
        match prepare_with_scope(
            &conn,
            scope(),
            &request(12.34, "GC12345678"),
            "order-1",
            "2026-09-28T10:02:00Z",
        ) {
            Ok(Prepared::Send(attempt)) => assert_eq!(attempt.idempotency_key, key),
            _ => panic!("same request must reuse its attempt"),
        }
        for (amount, card) in [(12.35, "GC12345678"), (12.34, "GC87654321")] {
            assert!(matches!(
                prepare_with_scope(
                    &conn,
                    scope(),
                    &request(amount, card),
                    "order-1",
                    "2026-09-28T10:02:00Z"
                ),
                Ok(Prepared::ResolvePrior(_))
            ));
        }
        // Another terminal scope never sees or resolves this attempt.
        let other = GiftScope {
            terminal_id: "terminal-2".into(),
            ..scope()
        };
        assert!(load_unresolved_attempts(&conn, &other, "order-1")
            .unwrap()
            .is_empty());
        // The key and fingerprint are immutable and the raw card is never stored.
        assert!(conn
            .execute(
                "UPDATE gift_card_redemption_attempts SET amount_cents = 1 WHERE idempotency_key = ?1",
                params![key],
            )
            .is_err());
        assert!(conn
            .execute(
                "DELETE FROM gift_card_redemption_attempts WHERE idempotency_key = ?1",
                params![key]
            )
            .is_err());
        let stored: String = conn
            .query_row(
                "SELECT group_concat(COALESCE(card_fingerprint,'') || request_fingerprint || idempotency_key, '|')
                 FROM gift_card_redemption_attempts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("GC12345678") && !stored.contains("12345678"));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pre_debit_gates_refuse_unsynced_overpaid_platform_and_foreign_orders() {
        let conn = test_conn();
        seed_order(&conn, "order-1", None, 2000);
        let code = |conn: &Connection, amount: f64| {
            prepare_with_scope(
                conn,
                scope(),
                &request(amount, "GC12345678"),
                "order-1",
                "2026-09-28T10:00:00Z",
            )
            .err()
            .map(|refusal| refusal.code)
        };
        assert_eq!(code(&conn, 5.0), Some("GIFT_CARD_ORDER_SYNC_REQUIRED"));
        conn.execute(
            "UPDATE orders SET supabase_id = ?1 WHERE id = 'order-1'",
            params![REMOTE_ORDER],
        )
        .unwrap();
        assert_eq!(code(&conn, 20.01), Some("GIFT_CARD_ORDER_OVERPAYMENT"));
        conn.execute(
            "UPDATE orders SET organization_id = 'org-2' WHERE id = 'order-1'",
            [],
        )
        .unwrap();
        assert_eq!(code(&conn, 5.0), Some("GIFT_CARD_FORBIDDEN"));
        conn.execute(
            "UPDATE orders SET organization_id = 'org-1', ghost_metadata = ?1 WHERE id = 'order-1'",
            params![json!({ "food_delivery": { "prepaid": true } }).to_string()],
        )
        .unwrap();
        assert_eq!(code(&conn, 5.0), Some("GIFT_CARD_ORDER_PLATFORM_SETTLED"));
        assert!(
            conn.query_row(
                "SELECT COUNT(*) FROM gift_card_redemption_attempts",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
                == 0
        );
    }

    #[test]
    fn platform_settlement_only_refuses_platform_held_money() {
        let refused =
            |value: Value| platform_settlement_refusal(Some(&value.to_string())).is_some();
        assert!(refused(json!({ "food_delivery": { "prepaid": true } })));
        assert!(refused(
            json!({ "food_delivery": { "payment_method": "online" } })
        ));
        assert!(refused(
            json!({ "food_delivery": { "payment_method": "cash", "delivery_by": "platform_delivery" } })
        ));
        let encoded = json!({ "food_delivery": { "payment_method": "cash", "fulfillment": "platform_delivery" } }).to_string();
        assert!(refused(Value::String(encoded)));
        assert!(!refused(
            json!({ "food_delivery": { "payment_method": "cash", "delivery_by": "own_driver" } })
        ));
        assert!(!refused(json!({ "note": "unknown disposition" })));
    }

    #[test]
    fn trusted_canonical_gift_import_is_applied_once_without_queue_or_drawer() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = send_attempt_for(&conn, 12.34, "GC12345678");
        let payment = canonical_payment(&attempt, "remote-pay-1");
        let local_id =
            import_canonical_gift_payment(&conn, &attempt, &payment, "2026-09-28T10:01:00Z")
                .expect("import canonical gift payment");
        let again =
            import_canonical_gift_payment(&conn, &attempt, &payment, "2026-09-28T10:01:05Z")
                .expect("re-import is idempotent");
        assert_eq!(local_id, again);

        let (method, remote, state, cents): (String, String, String, i64) = conn
            .query_row(
                "SELECT method, remote_payment_id, sync_state, amount_cents FROM order_payments WHERE id = ?1",
                params![local_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (method.as_str(), remote.as_str(), state.as_str(), cents),
            ("gift_card", "remote-pay-1", "applied", 1234)
        );
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_payments WHERE order_id = 'order-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);
        let queued: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_id = ?1",
                params![local_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queued, 0, "an applied canonical mirror is never queued");
        let snapshot = payments::load_order_payment_balance_snapshot(&conn, "order-1").unwrap();
        assert!((snapshot.outstanding_amount - 7.66).abs() < 0.001);
        let status: String = conn
            .query_row(
                "SELECT status FROM gift_card_redemption_attempts WHERE idempotency_key = ?1",
                params![attempt.idempotency_key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "applied");

        // The remainder completes the order through the standard ledger.
        let rest = Attempt {
            idempotency_key: "k2".into(),
            amount_cents: 766,
            ..attempt.clone()
        };
        conn.execute(
            "INSERT INTO gift_card_redemption_attempts (idempotency_key, organization_id, branch_id, terminal_id,
                 local_order_id, remote_order_id, amount_cents, currency, card_fingerprint, request_fingerprint,
                 status, created_at, updated_at)
             VALUES ('k2', 'org-1', 'branch-1', 'terminal-1', 'order-1', ?1, 766, 'EUR', 'fp', 'rfp', 'pending', 'now', 'now')",
            params![REMOTE_ORDER],
        )
        .unwrap();
        let mut second = canonical_payment(&rest, "remote-pay-2");
        second["external_transaction_id"] = json!("gift_card:tx-2");
        second["gift_card_transaction_id"] = json!("tx-2");
        second["metadata"]["gift_card_transaction_id"] = json!("tx-2");
        import_canonical_gift_payment(&conn, &rest, &second, "2026-09-28T10:02:00Z")
            .expect("full balance");
        let snapshot = payments::load_order_payment_balance_snapshot(&conn, "order-1").unwrap();
        assert!(snapshot.outstanding_amount.abs() < 0.001);
    }

    #[test]
    fn v83_widens_order_payment_methods_only_by_gift_card() {
        let conn = test_conn();
        let table_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_payments'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(table_sql.contains("'gift_card'"), "{table_sql}");
        assert!(
            !table_sql.contains("CHECK (method IN ('cash', 'card', 'other'))"),
            "{table_sql}"
        );
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(check, "ok");

        // The live connection enforces the edited schema: gift_card is
        // accepted and every other unknown method is still refused.
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = send_attempt_for(&conn, 5.0, "GC12345678");
        let local_id = import_canonical_gift_payment(
            &conn,
            &attempt,
            &canonical_payment(&attempt, "remote-pay-1"),
            "2026-09-28T10:01:00Z",
        )
        .expect("gift_card row is accepted after v83");
        let error = conn
            .execute(
                "UPDATE order_payments SET method = 'voucher' WHERE id = ?1",
                params![local_id],
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("CHECK constraint failed"), "{error}");
        assert!(check_local_tender_support(&conn).is_ok());
    }

    #[test]
    fn canonical_validation_rejects_every_mismatch() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = send_attempt_for(&conn, 5.0, "GC12345678");
        let good = canonical_payment(&attempt, "remote-pay-1");
        assert!(validate_canonical_gift_payment(&good, &attempt).is_ok());
        for (key, value) in [
            ("idempotency_key", json!("other-key")),
            ("amount_cents", json!(501)),
            ("currency", json!("USD")),
            ("order_id", json!("7f1c2c1e-3a2b-4c5d-9e8f-0a1b2c3d4e5f")),
            ("payment_method", json!("cash")),
            ("status", json!("pending")),
            ("external_transaction_id", json!("gift_card:tx-other")),
            ("tip_amount_cents", json!(100)),
        ] {
            let mut altered = good.clone();
            altered[key] = value;
            assert!(
                validate_canonical_gift_payment(&altered, &attempt).is_err(),
                "{key} must be rejected"
            );
        }
        // Unproven or renderer-shaped gift rows are neither imported nor parsed.
        let mut unproven = good.clone();
        unproven["external_transaction_id"] = Value::Null;
        assert!(sync::mirror_canonical_payment(&conn, &unproven)
            .unwrap()
            .is_none());
        assert!(payments::build_payment_record_input(&json!({
            "orderId": "order-1", "method": "gift_card", "amount": 5.0,
        }))
        .is_err());
    }

    #[test]
    fn twint_retained_manual_receipt_refuses_fresh_gift_attempt_before_debit() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let mut entry=crate::unsaved_payments::UnsavedChargedPayment::for_payment("order-1",&json!({"orderId":"order-1","method":"twint","amount":12,"currency":"CHF","idempotencyKey":"retained-manual","metadata":{"provider":"twint","confirmation":"cashier","confirmation_action":"confirm","qr_mode":"static_qr_manual"}}),None,"now").unwrap();
        entry.kind = "manual_twint_payment".into();
        crate::unsaved_payments::record(&conn, &entry).unwrap();
        let refusal = match prepare_with_scope_gated(
            &conn,
            scope(),
            &request(5.0, "GC12345678"),
            "order-1",
            "now",
            None,
        ) {
            Err(refusal) => refusal,
            Ok(_) => panic!("manual receipt must block a fresh gift debit"),
        };
        assert_eq!(refusal.code, "TWINT_RECEIPT_PENDING");
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM gift_card_redemption_attempts",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            crate::unsaved_payments::list(&conn, Some("order-1"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn gift_payments_refuse_refund_void_and_method_edit_before_any_write() {
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let attempt = send_attempt_for(&conn, 5.0, "GC12345678");
        let local_id = import_canonical_gift_payment(
            &conn,
            &attempt,
            &canonical_payment(&attempt, "remote-pay-1"),
            "now",
        )
        .expect("import");
        let refund = crate::refunds::refund_payment_in_connection(
            &conn,
            &json!({ "paymentId": local_id, "amount": 1.0, "reason": "customer" }),
        );
        assert!(refund
            .unwrap_err()
            .contains("GIFT_CARD_REVERSAL_UNSUPPORTED"));
        let state = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };
        let void =
            crate::refunds::void_payment_with_adjustment(&state, &local_id, "mistake", None, None);
        assert!(void.unwrap_err().contains("GIFT_CARD_REVERSAL_UNSUPPORTED"));
        let edit = payments::update_payment_method_for_payment(
            &state,
            "order-1",
            Some(local_id.as_str()),
            "cash",
        );
        assert!(edit.unwrap_err().contains("GIFT_CARD_PAYMENT_IMMUTABLE"));
        let conn = state.conn.lock().unwrap();
        let (status, method): (String, String) = conn
            .query_row(
                "SELECT status, method FROM order_payments WHERE id = ?1",
                params![local_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (status.as_str(), method.as_str()),
            ("completed", "gift_card")
        );
        let adjustments: i64 = conn
            .query_row("SELECT COUNT(*) FROM payment_adjustments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(adjustments, 0);
    }

    #[test]
    fn same_order_reservation_blocks_a_double_click() {
        let first =
            crate::commands::payments::reserve_payment_record("gift-double-click").expect("first");
        assert!(crate::commands::payments::reserve_payment_record("gift-double-click").is_err());
        drop(first);
        assert!(crate::commands::payments::reserve_payment_record("gift-double-click").is_ok());
    }

    #[test]
    fn status_alone_is_never_a_definitive_rejection() {
        for status in [400, 401, 403, 404, 409, 422, 429, 500, 503] {
            assert_eq!(
                definitive_rejection_code(&api::AdminFetchError::with_status(
                    "GIFT_CARD_NOT_FOUND",
                    status
                )),
                None
            );
        }
        assert_eq!(
            definitive_rejection_code(&api::AdminFetchError::transport("GIFT_CARD_AMOUNT_INVALID")),
            None
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sent_attempt_empty_http_read_keeps_exact_key_beyond_300_seconds() {
        let server = crate::tests::fake_http::MockServer::new(r#"{"payments":[]}"#);
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "terminal-1"),
            ("pos_api_key", "fixture-key"),
            ("admin_dashboard_url", server.url.as_str()),
        ]);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let mut attempt = send_attempt_for(&conn, 5.0, "GC12345678");
        attempt.send_count =
            mark_attempt_sent(&conn, &attempt.idempotency_key, "2000-01-01T00:00:00Z").unwrap();
        attempt.last_sent_at = Some("2000-01-01T00:00:00Z".into());
        let state = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };
        let summary = reconcile_attempts(&state, vec![attempt.clone()]).await;
        assert_eq!(server.count(), 1, "exercise the real terminal HTTP reader");
        assert_eq!(
            summary.abandoned, 0,
            "an empty read cannot cancel an earlier send"
        );
        assert_eq!(summary.unresolved, 1);
        let conn = state.conn.lock().unwrap();
        let unresolved = load_unresolved_attempts(&conn, &scope(), "order-1").unwrap();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].idempotency_key, attempt.idempotency_key);
    }

    #[test]
    fn fiscal_register_gates_gift_before_debit() {
        let conn = test_conn();
        assert_eq!(gift_fiscal_route(&conn), Ok(GiftFiscalRoute::NoRegister));
        assert_eq!(cap_driver::gift_voucher_payment_code(&json!({})), Ok(None));
        assert_eq!(
            cap_driver::gift_voucher_payment_code(&json!({ "giftCardPaymentCode": 5 })),
            Ok(Some(5))
        );
        assert!(
            cap_driver::gift_voucher_payment_code(&json!({ "giftCardPaymentCode": 1 })).is_err()
        );
        assert!(
            cap_driver::gift_voucher_payment_code(&json!({ "giftCardPaymentCode": 2 })).is_err()
        );
        assert!(!is_cap_protocol("generic"));
        assert!(is_cap_protocol("cap_driver"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn timed_out_inflight_debit_survives_empty_read_restart_and_late_commit() {
        let server = GiftHttpServer::new(vec![]).await;
        let _keyring = install_actor(&server.url);
        let path = std::env::temp_dir().join(format!("gift-late-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        db::run_migrations_for_test(&conn);
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, path.clone());
        let req = request(5.0, "GC12345678");
        let attempt = actor_attempt(&state, &req);
        let payment = canonical_payment(&attempt, "remote-late-payment");
        let release = Arc::new(tokio::sync::Notify::new());
        server.remote.lock().unwrap().replies.push_back(HttpReply {
            status: 200,
            body: json!({ "success": true, "payment": payment }),
            release: Some(release.clone()),
            late_payment: Some(payment.clone()),
        });
        let unknown = send_attempt_with_timeout(
            &state,
            &req,
            attempt.clone(),
            std::time::Duration::from_millis(100),
        )
        .await
        .unwrap();
        assert_eq!(unknown["reconciliationPending"], true);
        assert_eq!(unknown["idempotencyKey"], attempt.idempotency_key);
        assert_eq!(server.posts().len(), 1);
        assert_eq!(
            server.remote.lock().unwrap().committed,
            0,
            "the original request is still waiting"
        );
        {
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "UPDATE gift_card_redemption_attempts SET last_sent_at = '2000-01-01T00:00:00Z'",
                [],
            )
            .unwrap();
            let old = load_unresolved_attempts(&conn, &actor_scope(), "order-1").unwrap();
            assert_eq!(old.len(), 1);
        }
        let old = {
            load_unresolved_attempts(&state.conn.lock().unwrap(), &actor_scope(), "order-1")
                .unwrap()
        };
        let summary = reconcile_attempts(&state, old).await;
        assert_eq!((summary.abandoned, summary.unresolved), (0, 1));
        drop(state);
        let state = actor_state(Connection::open(&path).unwrap(), path.clone());
        let replay = actor_attempt(&state, &req);
        assert_eq!(
            replay.idempotency_key, attempt.idempotency_key,
            "restart/rescan retains K1"
        );
        {
            let conn = state.conn.lock().unwrap();
            let mut currency = request(5.0, "GC12345678");
            currency.currency = "USD".into();
            let mut split = request(5.0, "GC12345678");
            split.split = Some(SplitContext {
                group_id: "g".into(),
                portion_id: "p".into(),
            });
            for changed in [
                request(5.01, "GC12345678"),
                request(5.0, "GC87654321"),
                currency,
                split,
            ] {
                assert!(matches!(
                    prepare_with_scope(&conn, actor_scope(), &changed, "order-1", &now_rfc3339()),
                    Ok(Prepared::ResolvePrior(_))
                ));
            }
        }
        assert_eq!(
            server.posts()[0].header("x-staff-session-id"),
            Some(ACTOR_SESSION)
        );
        assert_eq!(
            server.posts()[0].json_body().unwrap()["idempotency_key"],
            attempt.idempotency_key
        );
        release.notify_one();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            server.committed.notified(),
        )
        .await
        .unwrap();
        let recovered = reconcile_attempts(&state, vec![replay.clone()]).await;
        assert_eq!((recovered.applied.len(), recovered.unresolved), (1, 0));
        let again = reconcile_attempts(&state, vec![replay]).await;
        assert_eq!(again.applied.len(), 1);
        let conn = state.conn.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM order_payments", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM gift_card_redemption_attempts",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sync_queue", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            server.posts().len(),
            1,
            "recovery only reads proof, never re-debits"
        );
        assert_eq!(server.remote.lock().unwrap().committed, 1);
        drop(conn);
        drop(state);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn real_http_business_codes_release_only_definite_first_send() {
        let cases = [
            (400, Some("GIFT_CARD_AMOUNT_INVALID"), true),
            (404, Some("GIFT_CARD_NOT_FOUND"), true),
            (403, Some("GIFT_CARDS_MODULE_DISABLED"), true),
            (400, None, false),
            (400, Some("NEW_SERVER_REASON"), false),
            (403, Some("GIFT_CARD_PAYMENT_IDENTITY_CONFLICT"), false),
            (409, Some("GIFT_CARD_IDEMPOTENCY_CONFLICT"), false),
            (409, Some("GIFT_CARD_PAYMENT_ALTERED"), false),
            (503, Some("GIFT_CARDS_SCHEMA_UNAVAILABLE"), false),
            (503, Some("GIFT_CARD_CURRENCY_NOT_CONFIGURED"), false),
        ];
        for (status, code, definitive) in cases {
            let server = GiftHttpServer::new(vec![HttpReply::json(
                status,
                json!({ "error": "fixture rejection", "code": code }),
            )])
            .await;
            let _keyring = install_actor(&server.url);
            let conn = test_conn();
            seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
            let state = actor_state(conn, ":memory:".into());
            let req = request(5.0, "GC12345678");
            let attempt = actor_attempt(&state, &req);
            let result = send_attempt(&state, &req, attempt.clone()).await.unwrap();
            assert_eq!(
                result["reconciliationPending"], !definitive,
                "{status} {code:?}"
            );
            assert_eq!(result["status"], status);
            let conn = state.conn.lock().unwrap();
            ensure_attempt_schema(&conn).unwrap();
            let (stored, proof): (String, i64) = conn.query_row("SELECT status, definitive_rejection FROM gift_card_redemption_attempts WHERE idempotency_key = ?1", params![attempt.idempotency_key], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
            assert_eq!(stored, if definitive { "abandoned" } else { "pending" });
            assert_eq!(proof, i64::from(definitive));
            if definitive {
                assert_eq!(result["code"], code.unwrap());
                match prepare_with_scope(&conn, actor_scope(), &req, "order-1", &now_rfc3339())
                    .unwrap()
                {
                    Prepared::Send(next) => {
                        assert_ne!(next.idempotency_key, attempt.idempotency_key)
                    }
                    _ => panic!("a proven first-send refusal may release its key"),
                }
            } else {
                assert_eq!(result["serverCode"], json!(code));
            }
            assert_eq!(server.posts().len(), 1);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn later_denial_never_clears_unknown_history_or_rotates_key() {
        let server = GiftHttpServer::new(vec![
            HttpReply::json(200, json!({ "success": true, "payment": null })),
            HttpReply::json(
                403,
                json!({ "error": "disabled", "code": "GIFT_CARDS_MODULE_DISABLED" }),
            ),
        ])
        .await;
        let _keyring = install_actor(&server.url);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, ":memory:".into());
        let req = request(5.0, "GC12345678");
        let original = actor_attempt(&state, &req);
        assert_eq!(
            send_attempt(&state, &req, original.clone()).await.unwrap()["reconciliationPending"],
            true
        );
        let retry = actor_attempt(&state, &req);
        let denial = send_attempt(&state, &req, retry).await.unwrap();
        assert_eq!(denial["reconciliationPending"], true);
        assert_eq!(denial["serverCode"], "GIFT_CARDS_MODULE_DISABLED");
        let conn = state.conn.lock().unwrap();
        let kept = load_unresolved_attempts(&conn, &actor_scope(), "order-1").unwrap();
        assert_eq!(kept[0].idempotency_key, original.idempotency_key);
        assert_eq!(kept[0].send_count, 2);
        assert_eq!(
            server
                .posts()
                .iter()
                .map(|request| request.json_body().unwrap()["idempotency_key"].clone())
                .collect::<Vec<_>>(),
            vec![
                json!(original.idempotency_key),
                json!(original.idempotency_key)
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn current_session_failures_stop_http_but_preserve_prior_unknown() {
        let server = GiftHttpServer::new(vec![]).await;
        let _keyring = install_actor(&server.url);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, ":memory:".into());
        let req = request(5.0, "GC12345678");
        let original = actor_attempt(&state, &req);
        let mut foreign = actor_session();
        foreign["branchId"] = json!(ACTOR_ORG);
        let mut invalid_id = actor_session();
        invalid_id["sessionId"] = json!("locally-invented-invalid-id");
        let mut nil = actor_session();
        nil["staffId"] = json!(uuid::Uuid::nil().to_string());
        let mut wrong_terminal = actor_session();
        wrong_terminal["terminalId"] = json!("terminal-2");
        let cases = [
            (None, "GIFT_CARD_STAFF_SESSION_REQUIRED"),
            (Some("{".to_string()), "GIFT_CARD_STAFF_SESSION_INVALID"),
            (
                Some("x".repeat(STAFF_SESSION_MAX_BYTES + 1)),
                "GIFT_CARD_STAFF_SESSION_INVALID",
            ),
            (
                Some(foreign.to_string()),
                "GIFT_CARD_STAFF_SESSION_SCOPE_MISMATCH",
            ),
            (
                Some(invalid_id.to_string()),
                "GIFT_CARD_STAFF_SESSION_INVALID",
            ),
            (Some(nil.to_string()), "GIFT_CARD_STAFF_SESSION_INVALID"),
            (
                Some(wrong_terminal.to_string()),
                "GIFT_CARD_STAFF_SESSION_SCOPE_MISMATCH",
            ),
        ];
        for (raw, code) in cases {
            match raw {
                Some(raw) => storage::session_set(&raw).unwrap(),
                None => storage::session_clear().unwrap(),
            }
            let refusal = send_attempt(&state, &req, original.clone()).await.unwrap();
            assert_eq!(refusal["code"], code);
            assert_eq!(refusal["reconciliationPending"], false);
        }
        storage::session_set(&actor_session().to_string()).unwrap();
        crate::tests::fake_keyring::fail_reads_for("pos_session", "fixture unavailable");
        let refused = send_attempt(&state, &req, original.clone()).await.unwrap();
        assert_eq!(refused["code"], "GIFT_CARD_STAFF_SESSION_UNAVAILABLE");
        crate::tests::fake_keyring::clear_failures_for("pos_session");
        {
            let conn = state.conn.lock().unwrap();
            mark_attempt_sent(&conn, &original.idempotency_key, "2000-01-01T00:00:00Z").unwrap();
        }
        storage::session_clear().unwrap();
        let retry = actor_attempt(&state, &req);
        let unknown = send_attempt(&state, &req, retry).await.unwrap();
        assert_eq!(unknown["code"], "GIFT_CARD_STAFF_SESSION_REQUIRED");
        assert_eq!(unknown["reconciliationPending"], true);
        assert_eq!(unknown["idempotencyKey"], original.idempotency_key);
        assert_eq!(
            server.remote.lock().unwrap().requests.len(),
            0,
            "no anonymous downgrade or local error HTTP"
        );
        assert_eq!(
            load_unresolved_attempts(&state.conn.lock().unwrap(), &actor_scope(), "order-1")
                .unwrap()[0]
                .send_count,
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mirror_failure_keeps_remote_proof_and_recovers_without_post() {
        let server = GiftHttpServer::new(vec![]).await;
        let _keyring = install_actor(&server.url);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, ":memory:".into());
        let req = request(5.0, "GC12345678");
        let original = actor_attempt(&state, &req);
        let payment = canonical_payment(&original, "mirror-proof");
        server
            .remote
            .lock()
            .unwrap()
            .replies
            .push_back(HttpReply::json(
                200,
                json!({ "success": true, "payment": payment }),
            ));
        {
            state.conn.lock().unwrap().execute_batch("CREATE TRIGGER gift_fixture_mirror_fail BEFORE INSERT ON order_payments WHEN NEW.method = 'gift_card' BEGIN SELECT RAISE(ABORT, 'fixture mirror blocked'); END;").unwrap();
        }
        let pending = send_attempt(&state, &req, original.clone()).await.unwrap();
        assert_eq!(pending["code"], "GIFT_CARD_LOCAL_MIRROR_PENDING");
        assert_eq!(pending["reconciliationPending"], true);
        let attempts = {
            let conn = state.conn.lock().unwrap();
            let attempts = load_unresolved_attempts(&conn, &actor_scope(), "order-1").unwrap();
            assert_eq!(attempts[0].status, "remote_applied");
            assert_eq!(
                conn.query_row(
                    "SELECT remote_payment_id FROM gift_card_redemption_attempts",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
                "mirror-proof"
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM order_payments", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            conn.execute_batch("DROP TRIGGER gift_fixture_mirror_fail")
                .unwrap();
            attempts
        };
        server.remote.lock().unwrap().payments.push(payment);
        let result = reconcile_attempts(&state, attempts).await;
        assert_eq!((result.applied.len(), result.unresolved), (1, 0));
        assert_eq!(server.posts().len(), 1);
    }

    #[test]
    fn legacy_abandoned_sent_rows_are_restored_without_bearer_or_tuple_changes() {
        let conn = Connection::open_in_memory().unwrap();
        let legacy = ATTEMPT_SCHEMA.replace("        definitive_rejection INTEGER NOT NULL DEFAULT 0 CHECK (definitive_rejection IN (0, 1)),\n", "");
        conn.execute_batch(&legacy).unwrap();
        for (key, count, sent, error) in [
            (
                "timer-key",
                1,
                Some("2000-01-01T00:00:00Z"),
                "GIFT_CARD_NOT_APPLIED",
            ),
            ("status-key", 1, Some("malformed"), "GIFT_CARD_REJECTED"),
            (
                "ambiguous-key",
                0,
                Some("malformed"),
                "GIFT_CARD_NOT_APPLIED",
            ),
            ("unsent-key", 0, None, "GIFT_CARD_NOT_APPLIED"),
        ] {
            conn.execute("INSERT INTO gift_card_redemption_attempts (idempotency_key,organization_id,branch_id,terminal_id,local_order_id,remote_order_id,amount_cents,currency,card_fingerprint,request_fingerprint,status,send_count,last_sent_at,last_error_code,created_at,updated_at) VALUES (?1,'org-1','branch-1','terminal-1','order-1',?2,500,'EUR','fingerprint','immutable-tuple','abandoned',?3,?4,?5,'bad-time','bad-time')", params![key,REMOTE_ORDER,count,sent,error]).unwrap();
        }
        ensure_attempt_schema(&conn).unwrap();
        ensure_attempt_schema(&conn).unwrap();
        let kept = load_unresolved_attempts(&conn, &scope(), "order-1").unwrap();
        assert_eq!(kept.len(), 3);
        for key in ["timer-key", "status-key", "ambiguous-key"] {
            let row = kept
                .iter()
                .find(|attempt| attempt.idempotency_key == key)
                .unwrap();
            assert_eq!(row.request_fingerprint, "immutable-tuple");
            assert_eq!(row.amount_cents, 500);
            assert!(conn
                .execute(
                    "DELETE FROM gift_card_redemption_attempts WHERE idempotency_key=?1",
                    params![key]
                )
                .is_err());
        }
        assert_eq!(conn.query_row("SELECT status FROM gift_card_redemption_attempts WHERE idempotency_key='unsent-key'", [], |row| row.get::<_,String>(0)).unwrap(), "abandoned");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ambiguous_legacy_send_timestamp_dominates_first_rejection() {
        let server = GiftHttpServer::new(vec![HttpReply::json(
            400,
            json!({ "code": "GIFT_CARD_AMOUNT_INVALID", "error": "invalid" }),
        )])
        .await;
        let _keyring = install_actor(&server.url);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, ":memory:".into());
        let req = request(5.0, "GC12345678");
        let original = actor_attempt(&state, &req);
        state.conn.lock().unwrap().execute("UPDATE gift_card_redemption_attempts SET last_sent_at='malformed' WHERE idempotency_key=?1",params![original.idempotency_key]).unwrap();
        let retry = actor_attempt(&state, &req);
        let response = send_attempt(&state, &req, retry).await.unwrap();
        assert_eq!(response["reconciliationPending"], true);
        let conn = state.conn.lock().unwrap();
        assert_eq!(
            load_unresolved_attempts(&conn, &actor_scope(), "order-1").unwrap()[0].idempotency_key,
            original.idempotency_key
        );
        assert_eq!(
            conn.query_row(
                "SELECT definitive_rejection FROM gift_card_redemption_attempts",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn never_sent_intent_can_release_without_treating_age_as_proof() {
        let server = GiftHttpServer::new(vec![]).await;
        let _keyring = install_actor(&server.url);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, ":memory:".into());
        let req = request(5.0, "GC12345678");
        let original = actor_attempt(&state, &req);
        assert_eq!(original.send_count, 0);
        assert!(original.last_sent_at.is_none());
        let result = reconcile_attempts(&state, vec![original.clone()]).await;
        assert_eq!((result.abandoned, result.unresolved), (1, 0));
        let conn = state.conn.lock().unwrap();
        ensure_attempt_schema(&conn).unwrap();
        let next = match prepare_with_scope(
            &conn,
            actor_scope(),
            &request(6.0, "GC87654321"),
            "order-1",
            &now_rfc3339(),
        )
        .unwrap()
        {
            Prepared::Send(attempt) => attempt,
            _ => panic!("never-sent key may release"),
        };
        assert_ne!(next.idempotency_key, original.idempotency_key);
        assert_eq!(server.posts().len(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn multiple_restored_keys_keep_remaining_uncertainty_after_one_import() {
        let server = GiftHttpServer::new(vec![]).await;
        let _keyring = install_actor(&server.url);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, ":memory:".into());
        let req = request(5.0, "GC12345678");
        let original = actor_attempt(&state, &req);
        {
            let conn = state.conn.lock().unwrap();
            mark_attempt_sent(&conn, &original.idempotency_key, "2000-01-01T00:00:00Z").unwrap();
            conn.execute("INSERT INTO gift_card_redemption_attempts (idempotency_key,organization_id,branch_id,terminal_id,local_order_id,remote_order_id,amount_cents,currency,card_fingerprint,request_fingerprint,status,send_count,last_sent_at,created_at,updated_at) SELECT 'old-replacement-key',organization_id,branch_id,terminal_id,local_order_id,remote_order_id,600,currency,card_fingerprint,'different-tuple','pending',1,last_sent_at,created_at,updated_at FROM gift_card_redemption_attempts WHERE idempotency_key=?1",params![original.idempotency_key]).unwrap();
        }
        server
            .remote
            .lock()
            .unwrap()
            .payments
            .push(canonical_payment(&original, "one-of-two-proofs"));
        let response = redeem_for_local_order(&state, &req, "order-1")
            .await
            .unwrap();
        assert_eq!(response["code"], "GIFT_CARD_PRIOR_ATTEMPT_APPLIED");
        assert_eq!(response["reconciliationPending"], true);
        let kept = load_unresolved_attempts(&state.conn.lock().unwrap(), &actor_scope(), "order-1")
            .unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].idempotency_key, "old-replacement-key");
        assert_eq!(server.posts().len(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unsupported_check_refuses_before_http_and_keeps_prior_unknown() {
        let server = GiftHttpServer::new(vec![]).await;
        let _keyring = install_actor(&server.url);
        let conn = test_conn();
        seed_order(&conn, "order-1", Some(REMOTE_ORDER), 2000);
        let state = actor_state(conn, ":memory:".into());
        let req = request(5.0, "GC12345678");
        let original = actor_attempt(&state, &req);
        {
            let conn = state.conn.lock().unwrap();
            mark_attempt_sent(&conn, &original.idempotency_key, "2000-01-01T00:00:00Z").unwrap();
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE name='order_payments'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let version: i64 = conn
                .query_row("PRAGMA schema_version", [], |row| row.get(0))
                .unwrap();
            conn.execute_batch("PRAGMA writable_schema=ON;").unwrap();
            let unsupported_sql = sql.replace(
                "CHECK (method IN ('cash', 'card', 'other', 'gift_card', 'twint'))",
                "CHECK (method IN ('cash','card','other','twint')) /* 'gift_card' */",
            );
            assert_ne!(
                unsupported_sql, sql,
                "the fixture must remove gift admission from the current v95 CHECK"
            );
            conn.execute(
                "UPDATE sqlite_master SET sql=?1 WHERE name='order_payments' AND type='table'",
                [unsupported_sql],
            )
            .unwrap();
            conn.execute_batch(&format!(
                "PRAGMA writable_schema=OFF; PRAGMA schema_version={};",
                version + 1
            ))
            .unwrap();
        }
        let retry = actor_attempt(&state, &req);
        let response = send_attempt(&state, &req, retry).await.unwrap();
        assert_eq!(response["code"], "GIFT_CARD_LOCAL_SCHEMA_UNSUPPORTED");
        assert_eq!(response["reconciliationPending"], true);
        assert_eq!(response["idempotencyKey"], original.idempotency_key);
        assert_eq!(server.remote.lock().unwrap().requests.len(), 0);
        assert_eq!(
            load_unresolved_attempts(&state.conn.lock().unwrap(), &actor_scope(), "order-1")
                .unwrap()[0]
                .send_count,
            1
        );
    }
}
