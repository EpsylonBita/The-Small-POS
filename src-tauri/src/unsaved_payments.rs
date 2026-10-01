//! Charged payments this till could not save yet (fix review 30/09/2026,
//! Android 1.0.13 parity: `useOrderPaymentStore.saveMovedMoney`, the
//! `PaymentService` unsaved-record functions and `payments_not_saved`).
//!
//! Symptom: the payment terminal (or the fiscal device) approved a card and
//! then the payment write failed. The desktop answered with the generic
//! "Failed to collect payment": the collection stayed open and the next try
//! could charge the card again, a split portion went back to draft, nothing
//! durable said the customer had paid, and the Z did not know.
//!
//! Every write of card money that already moved now goes through
//! [`save_charged_payment`]:
//! 1. a durable record of the money is written first (`local_settings`,
//!    category [`UNSAVED_CHARGED_PAYMENT_CATEGORY`], keyed by the payment's
//!    idempotency key; `ecr_orphaned_receipts` is the desktop precedent). It
//!    holds the exact write to replay and survives a restart;
//! 2. the same idempotent write is retried with the same key, 3 times after
//!    250, 750 and 1500 ms, never for a refusal no retry can change;
//! 3. saved, or set aside for review (`payment_review`): the record goes;
//! 4. still not saved: the record stays and the answer is typed
//!    ([`PAYMENT_NOT_SAVED_ERROR_CODE`]). New tenders on the order are refused
//!    ([`PAYMENT_NOT_SAVED_PENDING_ERROR_CODE`]), the Z holds
//!    ([`PAYMENTS_NOT_SAVED_REASON_CODE`]) and "Save payment again" replays the
//!    same write with the same key: no new charge.
//!
//! A manager's way out on the Z, "Money given back to the customer", writes
//! an audit entry first and only then removes the record. The order is left
//! as it is, and the money given back counts nowhere: it never became a row.
//! Cash is unchanged: it is refused before the drawer takes it.
//!
//! With the direct-SALE admission (`commands::ecr`, #308, schema 89/91) one
//! approval can have two durable traces: its reserved `ecr_transactions` SALE
//! and this record. They are one payment, never two:
//! - a record is saved when a row with its key exists, or a card row of the
//!   same order with its terminal reference and cents
//!   ([`saved_row_for`]): the SALE's own recovery (the exact original, booked
//!   from the payment screens) clears it, and "Save payment again" then books
//!   nothing a second time;
//! - "Money given back" marks the SALE `receiptData.returnedToCustomer`
//!   ([`mark_direct_sale_returned`]), so it no longer holds the order and can
//!   never be booked from the payment screens afterwards;
//! - only this record holds the Z (`payments_not_saved`); the SALE holds new
//!   collections on its order, never the Z.

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{error, info, warn};

use crate::db::DbState;
use crate::money::Cents;
use crate::payments::OrderPaymentBalanceSnapshot;

/// `local_settings` category of the record of card money that moved while its
/// payment row is not saved yet. Keyed by the payment's idempotency key.
pub(crate) const UNSAVED_CHARGED_PAYMENT_CATEGORY: &str = "unsaved_charged_payment";
/// `local_settings` category of the audit entry a manager's resolution leaves:
/// the record as it was plus the decision. The first entry is kept.
pub(crate) const UNSAVED_CHARGED_PAYMENT_RESOLVED_CATEGORY: &str =
    "unsaved_charged_payment_resolved";
/// The Z blocker code: one blocker per record (the shared Health contract and
/// Android key on the same string).
pub(crate) const PAYMENTS_NOT_SAVED_REASON_CODE: &str = "payments_not_saved";
/// `payment_record` answer: the card was charged, the payment is not saved.
pub(crate) const PAYMENT_NOT_SAVED_ERROR_CODE: &str = "PAYMENT_NOT_SAVED";
/// `payment_record` refusal of a new tender while a charged payment of the
/// order is not saved: nothing is charged, nothing is written.
pub(crate) const PAYMENT_NOT_SAVED_PENDING_ERROR_CODE: &str = "PAYMENT_NOT_SAVED_PENDING";
/// The only outcome a manager can record for a charged payment not saved.
pub(crate) const RETURNED_TO_CUSTOMER_OUTCOME: &str = "returned_to_customer";
/// Waits between the save attempts of money that already moved: bounded and
/// short, the cashier is waiting.
pub(crate) const MOVED_MONEY_SAVE_DELAYS_MS: [u64; 3] = [250, 750, 1500];

pub(crate) const KIND_SINGLE: &str = "single";
pub(crate) const KIND_SPLIT_PORTION: &str = "split_portion";
pub(crate) const KIND_COLLECT_OUTSTANDING: &str = "collect_outstanding";
/// A new order whose card the fiscal device approved at checkout. The order
/// and its initial payment are written together (`sync::create_order`), so
/// the record holds the whole order and a replay writes both, with the same
/// keys: the order's client request id and the payment's idempotency key.
/// Its `order_id` is that client request id until the order exists (item E,
/// fix review 30/09/2026).
pub(crate) const KIND_NEW_ORDER_CHECKOUT: &str = "new_order_checkout";

/// The balance a collect-outstanding write expects (see
/// `payments::record_payment_with_expected_balance`), kept with its record so
/// a replay is held to the same generation.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExpectedBalance {
    pub order_total: f64,
    pub net_paid: f64,
    pub outstanding_amount: f64,
    pub completed_payment_count: i64,
    /// Hex of the 32-byte ledger generation.
    pub ledger_generation: String,
}

impl ExpectedBalance {
    pub(crate) fn from_snapshot(snapshot: &OrderPaymentBalanceSnapshot) -> Self {
        Self {
            order_total: snapshot.order_total,
            net_paid: snapshot.net_paid,
            outstanding_amount: snapshot.outstanding_amount,
            completed_payment_count: snapshot.completed_payment_count,
            ledger_generation: snapshot
                .ledger_generation
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        }
    }

    pub(crate) fn to_snapshot(&self) -> Option<OrderPaymentBalanceSnapshot> {
        let hex = self.ledger_generation.trim();
        if hex.len() != 64 {
            return None;
        }
        let mut generation = [0u8; 32];
        for (index, byte) in generation.iter_mut().enumerate() {
            *byte = u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok()?;
        }
        Some(OrderPaymentBalanceSnapshot {
            order_total: self.order_total,
            net_paid: self.net_paid,
            outstanding_amount: self.outstanding_amount,
            completed_payment_count: self.completed_payment_count,
            ledger_generation: generation,
        })
    }
}

/// Card money that moved while its payment row is not saved yet.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnsavedChargedPayment {
    pub idempotency_key: String,
    /// The local order id.
    pub order_id: String,
    pub method: String,
    pub amount: f64,
    pub amount_cents: i64,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub transaction_ref: Option<String>,
    #[serde(default)]
    pub terminal_device_id: Option<String>,
    /// [`KIND_SINGLE`], [`KIND_SPLIT_PORTION`] or [`KIND_COLLECT_OUTSTANDING`].
    pub kind: String,
    /// The `payment_record` payload a save replays: same key, no new charge.
    pub request: Value,
    #[serde(default)]
    pub expected_balance: Option<ExpectedBalance>,
    pub captured_at: String,
    /// Save attempts that failed so far.
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
}

fn str_field(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The key a charged card payment is saved under: the caller's idempotency
/// key, else one derived from the terminal's approval (its transaction
/// reference), so a retry and a replay can never write it twice.
pub(crate) fn moved_money_key(payload: &Value) -> Option<String> {
    str_field(payload, &["idempotencyKey", "idempotency_key"]).or_else(|| {
        str_field(
            payload,
            &[
                "transactionRef",
                "transaction_ref",
                "transactionId",
                "transaction_id",
            ],
        )
        .map(|reference| format!("terminal-card:{reference}"))
    })
}

impl UnsavedChargedPayment {
    /// The record of a card write about to be attempted. `None` when the
    /// payment has no reference to key it by (nothing proves a retry is the
    /// same payment), in which case the caller writes it once, as before.
    pub(crate) fn for_payment(
        order_id: &str,
        payload: &Value,
        expected_balance: Option<&OrderPaymentBalanceSnapshot>,
        captured_at: &str,
    ) -> Option<Self> {
        let key = moved_money_key(payload)?;
        let input = crate::payments::build_payment_record_input(payload).ok()?;
        let mut request = payload.clone();
        let object = request.as_object_mut()?;
        object.insert("idempotencyKey".to_string(), Value::String(key.clone()));
        object.insert("orderId".to_string(), Value::String(order_id.to_string()));
        let has_items = payload
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        let kind = if expected_balance.is_some() {
            KIND_COLLECT_OUTSTANDING
        } else if has_items || payload.get("splitPortion").is_some() {
            KIND_SPLIT_PORTION
        } else {
            KIND_SINGLE
        };
        Some(Self {
            idempotency_key: key,
            order_id: order_id.to_string(),
            method: input.method.clone(),
            amount: input.amount,
            amount_cents: Cents::round_half_even(input.amount).as_i64(),
            currency: str_field(payload, &["currency"]),
            transaction_ref: input.transaction_ref.clone(),
            terminal_device_id: input.terminal_device_id.clone(),
            kind: kind.to_string(),
            request,
            expected_balance: expected_balance.map(ExpectedBalance::from_snapshot),
            captured_at: captured_at.to_string(),
            attempts: 0,
            last_error: None,
        })
    }

    /// The record of a new-order checkout whose card moved money, and the
    /// order payload every write and replay uses: its initial payment keyed
    /// (the caller's key, else one derived from the approval's reference) and
    /// its client request id fixed, so a replay can neither create a second
    /// order nor write a second payment. `None` when the payment has no
    /// reference to key it by.
    pub(crate) fn for_new_order_checkout(
        client_request_id: &str,
        order_payload: &Value,
        captured_at: &str,
    ) -> Option<(Self, Value)> {
        let client_request_id = client_request_id.trim();
        if client_request_id.is_empty() {
            return None;
        }
        let payment = order_payload
            .get("initialPayment")
            .or_else(|| order_payload.get("initial_payment"))?;
        let key = moved_money_key(payment)?;
        let mut keyed_payment = payment.clone();
        keyed_payment
            .as_object_mut()?
            .insert("idempotencyKey".to_string(), Value::String(key.clone()));
        let mut parse_payload = keyed_payment.clone();
        parse_payload.as_object_mut()?.insert(
            "orderId".to_string(),
            Value::String(client_request_id.to_string()),
        );
        let input = crate::payments::build_payment_record_input(&parse_payload).ok()?;
        let mut request = order_payload.clone();
        let object = request.as_object_mut()?;
        object.insert("initialPayment".to_string(), keyed_payment.clone());
        object.insert("initial_payment".to_string(), keyed_payment.clone());
        for field in ["clientRequestId", "client_request_id"] {
            object.insert(
                field.to_string(),
                Value::String(client_request_id.to_string()),
            );
        }
        let entry = Self {
            idempotency_key: key,
            order_id: client_request_id.to_string(),
            method: input.method.clone(),
            amount: input.amount,
            amount_cents: Cents::round_half_even(input.amount).as_i64(),
            currency: str_field(&keyed_payment, &["currency"]),
            transaction_ref: input.transaction_ref.clone(),
            terminal_device_id: input.terminal_device_id.clone(),
            kind: KIND_NEW_ORDER_CHECKOUT.to_string(),
            request: request.clone(),
            expected_balance: None,
            captured_at: captured_at.to_string(),
            attempts: 0,
            last_error: None,
        };
        Some((entry, request))
    }

    /// A new-order checkout: its order may not exist on this till yet.
    pub(crate) fn is_new_order_checkout(&self) -> bool {
        self.kind == KIND_NEW_ORDER_CHECKOUT
    }
}

/// Hold the record: written before the payment row, updated after a failed
/// save (upsert).
pub(crate) fn record(conn: &Connection, entry: &UnsavedChargedPayment) -> Result<(), String> {
    let value = serde_json::to_string(entry)
        .map_err(|e| format!("serialize the record of a charged payment: {e}"))?;
    crate::db::set_setting(
        conn,
        UNSAVED_CHARGED_PAYMENT_CATEGORY,
        &entry.idempotency_key,
        &value,
    )
}

/// The payment row exists now (or a manager resolved it): the record goes.
pub(crate) fn clear(conn: &Connection, idempotency_key: &str) -> Result<(), String> {
    crate::db::delete_setting(conn, UNSAVED_CHARGED_PAYMENT_CATEGORY, idempotency_key).map(|_| ())
}

fn parse(raw: &str) -> Option<UnsavedChargedPayment> {
    serde_json::from_str::<UnsavedChargedPayment>(raw)
        .ok()
        .filter(|entry| !entry.idempotency_key.is_empty() && !entry.order_id.is_empty())
}

pub(crate) fn load(
    conn: &Connection,
    idempotency_key: &str,
) -> Result<Option<UnsavedChargedPayment>, String> {
    Ok(
        crate::db::get_setting(conn, UNSAVED_CHARGED_PAYMENT_CATEGORY, idempotency_key)
            .as_deref()
            .and_then(parse),
    )
}

/// Charged payments still not saved, oldest first; for one order when given.
/// A record whose payment row exists after all (its removal failed, or the
/// same approval was booked under another key: [`saved_row_for`]) is not
/// listed.
pub(crate) fn list(
    conn: &Connection,
    order_id: Option<&str>,
) -> Result<Vec<UnsavedChargedPayment>, String> {
    let mut statement = conn
        .prepare(
            "SELECT ls.setting_value
             FROM local_settings ls
             WHERE ls.setting_category = ?1
               AND NOT EXISTS (
                 SELECT 1 FROM order_payments op WHERE op.idempotency_key = ls.setting_key
               )
               AND NOT EXISTS (
                 SELECT 1 FROM order_payments op
                 WHERE json_valid(ls.setting_value)
                   -- A new-order checkout's record names its client request
                   -- id until the order exists: the order created for it.
                   AND (op.order_id = json_extract(ls.setting_value, '$.orderId')
                        OR op.order_id IN (
                            SELECT o.id FROM orders o
                            WHERE o.client_request_id = json_extract(ls.setting_value, '$.orderId')
                        ))
                   AND LOWER(TRIM(json_extract(ls.setting_value, '$.method'))) = 'card'
                   AND LOWER(TRIM(op.method)) = 'card'
                   AND op.transaction_ref IS NOT NULL
                   AND TRIM(op.transaction_ref) <> ''
                   AND op.transaction_ref = json_extract(ls.setting_value, '$.transactionRef')
                   AND COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0)
                       = json_extract(ls.setting_value, '$.amountCents')
               )
             ORDER BY (CASE WHEN json_valid(ls.setting_value)
                            THEN json_extract(ls.setting_value, '$.capturedAt') END) ASC,
                      ls.setting_key ASC",
        )
        .map_err(|e| format!("prepare the charged payments not saved: {e}"))?;
    let rows = statement
        .query_map(params![UNSAVED_CHARGED_PAYMENT_CATEGORY], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("read the charged payments not saved: {e}"))?;
    let mut entries = Vec::new();
    for raw in rows {
        let raw = raw.map_err(|e| format!("read a charged payment not saved: {e}"))?;
        if let Some(entry) = parse(&raw) {
            if order_id.map_or(true, |order_id| entry.order_id == order_id) {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

/// How many charged payments are still not saved (any order): the end of
/// day refuses while one exists.
pub(crate) fn count(conn: &Connection) -> Result<usize, String> {
    list(conn, None).map(|entries| entries.len())
}

struct SavedRow {
    payment_id: String,
    order_id: String,
    status: String,
    metadata: Option<String>,
    amount_cents: i64,
}

fn saved_row(conn: &Connection, idempotency_key: &str) -> Result<Option<SavedRow>, String> {
    conn.query_row(
        "SELECT id, order_id, LOWER(TRIM(COALESCE(status, ''))), metadata,
                COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0)
         FROM order_payments
         WHERE idempotency_key = ?1
         LIMIT 1",
        params![idempotency_key],
        |row| {
            Ok(SavedRow {
                payment_id: row.get(0)?,
                order_id: row.get(1)?,
                status: row.get(2)?,
                metadata: row.get(3)?,
                amount_cents: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("look up the saved charged payment: {e}"))
}

/// The row that saved `entry`'s money: the row with its key, else a card row
/// of the same order carrying its terminal reference and cents (a recovery of
/// the same approval booked under another key; any status: set aside, voided
/// or refunded, it still records this money). A new-order checkout's record
/// (item E) names its client request id until the order exists, so its order
/// is also the one created for that id. `None` when neither exists.
fn saved_row_for(
    conn: &Connection,
    entry: &UnsavedChargedPayment,
) -> Result<Option<SavedRow>, String> {
    if let Some(row) = saved_row(conn, &entry.idempotency_key)? {
        return Ok(Some(row));
    }
    let Some(reference) = entry
        .transaction_ref
        .as_deref()
        .map(str::trim)
        .filter(|reference| !reference.is_empty())
    else {
        return Ok(None);
    };
    if !entry.method.trim().eq_ignore_ascii_case("card") {
        return Ok(None);
    }
    conn.query_row(
        "SELECT id, order_id, LOWER(TRIM(COALESCE(status, ''))), metadata,
                COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0)
         FROM order_payments
         WHERE (order_id = ?1
                -- A new-order checkout's record names its client request id
                -- until the order exists: the order created for it.
                OR order_id IN (SELECT id FROM orders WHERE client_request_id = ?1))
           AND LOWER(TRIM(method)) = 'card'
           AND transaction_ref = ?2
           AND COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0) = ?3
         ORDER BY created_at ASC, id ASC
         LIMIT 1",
        params![entry.order_id, reference, entry.amount_cents],
        |row| {
            Ok(SavedRow {
                payment_id: row.get(0)?,
                order_id: row.get(1)?,
                status: row.get(2)?,
                metadata: row.get(3)?,
                amount_cents: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("look up the saved charged payment by its card reference: {e}"))
}

/// "Money given back" for a charged payment whose approval is a direct SALE of
/// its order (`ecr_transactions`, #308): the SALE keeps the decision in
/// `receiptData.returnedToCustomer`, so it stops holding the order and is
/// never offered for booking again (`commands::ecr::unresolved_direct_sales`
/// and the schema 91 triggers skip it). No SALE: nothing to mark.
pub(crate) fn mark_direct_sale_returned(
    conn: &Connection,
    entry: &UnsavedChargedPayment,
    resolution: &Value,
) -> Result<usize, String> {
    let Some(reference) = entry
        .transaction_ref
        .as_deref()
        .map(str::trim)
        .filter(|reference| !reference.is_empty())
    else {
        return Ok(0);
    };
    if !crate::payment_review::table_exists(conn, "ecr_transactions")? {
        return Ok(0);
    }
    let marker = json!({
        "idempotencyKey": entry.idempotency_key,
        "outcome": resolution.get("outcome").cloned().unwrap_or(Value::Null),
        "resolvedBy": resolution.get("resolved_by").cloned().unwrap_or(Value::Null),
        "resolvedAt": resolution.get("resolved_at").cloned().unwrap_or(Value::Null),
    });
    conn.execute(
        "UPDATE ecr_transactions
            SET receipt_data = CASE
                WHEN json_valid(receipt_data)
                    THEN json_set(receipt_data, '$.returnedToCustomer', json(?2))
                ELSE json_object('returnedToCustomer', json(?2))
            END
          WHERE id = ?1
            AND LOWER(TRIM(transaction_type)) = 'sale'
            AND (order_id = ?3
                 OR order_id = (SELECT supabase_id FROM orders WHERE id = ?3)
                 OR order_id = (SELECT client_request_id FROM orders WHERE id = ?3))",
        params![reference, marker.to_string(), entry.order_id],
    )
    .map_err(|e| format!("mark the direct card SALE of a charged payment as given back: {e}"))
}

/// A refusal by a rule: writing the same payment again cannot succeed (money
/// the platform holds, an order that is gone, a malformed write, a balance
/// the write no longer matches, an outstanding collection that is locked). It
/// is not retried and "Save payment again" cannot help; the Z offers the
/// manager's resolution. Everything else (a locked or busy database, a disk
/// or I/O error, anything unknown) is retried.
pub(crate) fn is_lasting_payment_refusal(error: &str) -> bool {
    const LASTING: &[&str] = &[
        crate::payments::PLATFORM_HELD_COLLECTION_ERROR,
        "Order not found",
        "Cannot record payment for ghost order",
        "Missing orderId",
        "Missing method",
        "Missing amount",
        "Invalid method",
        "Amount must be positive",
        "Invalid tip recipient role",
        "Only cash, card, and room_charge payments can be recorded locally",
        "exceeds outstanding balance",
        "Outstanding balance changed during payment collection",
        "The fiscal approval is not available for exact local payment persistence",
        "Outstanding fiscal payment identity does not match its durable attempt",
        "outstanding payment collection is active",
        "Cashier-collected payments require a cashier shift context",
        "is not a cashier or manager drawer",
    ];
    LASTING.iter().any(|marker| error.contains(marker))
}

fn amount_text(amount_cents: i64) -> String {
    format!("{:.2}", Cents::new(amount_cents).to_f64_dp2())
}

/// A charged payment not saved, as the renderer and the Z list it.
pub(crate) fn summary_json(entry: &UnsavedChargedPayment) -> Value {
    json!({
        "idempotencyKey": entry.idempotency_key,
        "orderId": entry.order_id,
        "method": entry.method,
        "amount": Cents::new(entry.amount_cents).to_f64_dp2(),
        "amountCents": entry.amount_cents,
        "currency": entry.currency.clone().unwrap_or_else(|| "EUR".to_string()),
        "transactionRef": entry.transaction_ref,
        "kind": entry.kind,
        "capturedAt": entry.captured_at,
        "attempts": entry.attempts,
        "canSaveAgain": can_save_again(entry),
    })
}

/// A save can still succeed unless the last refusal was a lasting one.
pub(crate) fn can_save_again(entry: &UnsavedChargedPayment) -> bool {
    !entry
        .last_error
        .as_deref()
        .is_some_and(is_lasting_payment_refusal)
}

/// The answer when the card was charged but the payment is not saved. Never a
/// generic failure: it says what happened and what not to do.
pub(crate) fn not_saved_response(entry: &UnsavedChargedPayment, extra: Option<&Value>) -> Value {
    let message = format!(
        "The card was charged {}, but the payment could not be saved on this till yet. Do not charge again: save the payment again.",
        amount_text(entry.amount_cents)
    );
    let mut answer = json!({
        "success": false,
        "errorCode": PAYMENT_NOT_SAVED_ERROR_CODE,
        "paymentNotSaved": true,
        "paymentApproved": true,
        "paymentPersisted": false,
        "requiresReconciliation": true,
        "orderId": entry.order_id,
        "method": entry.method,
        "amount": Cents::new(entry.amount_cents).to_f64_dp2(),
        "amountCents": entry.amount_cents,
        "unsavedPayment": summary_json(entry),
        "error": message,
        "message": message,
    });
    if entry.is_new_order_checkout() {
        // No order exists yet: the record holds it, under its client request
        // id, until "Save payment again" writes order and payment together.
        if let Some(object) = answer.as_object_mut() {
            object.insert("orderId".to_string(), Value::Null);
            object.insert("orderPersisted".to_string(), Value::Bool(false));
            object.insert("newOrderCheckout".to_string(), Value::Bool(true));
            object.insert(
                "clientRequestId".to_string(),
                Value::String(entry.order_id.clone()),
            );
        }
    }
    if let (Some(extra), Some(object)) = (extra.and_then(Value::as_object), answer.as_object_mut())
    {
        for (key, value) in extra {
            object.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    answer
}

/// The refusal of a new tender while a charged payment of the order is not
/// saved. Nothing was charged and nothing was written.
pub(crate) fn pending_refusal_response(order_id: &str, pending: &[UnsavedChargedPayment]) -> Value {
    let total_cents: i64 = pending.iter().map(|entry| entry.amount_cents).sum();
    let message = format!(
        "A card payment of {} on this order is charged but not saved on this till yet. Save it again before taking another payment; do not charge again.",
        amount_text(total_cents)
    );
    json!({
        "success": false,
        "errorCode": PAYMENT_NOT_SAVED_PENDING_ERROR_CODE,
        "paymentNotSaved": true,
        "paymentApproved": false,
        "paymentPersisted": false,
        "orderId": order_id,
        "amount": Cents::new(total_cents).to_f64_dp2(),
        "amountCents": total_cents,
        "unsavedPayments": pending.iter().map(summary_json).collect::<Vec<_>>(),
        "error": message,
        "message": message,
    })
}

/// The answer for a payment whose row exists: saved by an earlier attempt or
/// replay, or set aside for review when the order was already covered.
fn saved_row_answer(conn: &Connection, entry: &UnsavedChargedPayment, row: &SavedRow) -> Value {
    let amount = Cents::new(row.amount_cents).to_f64_dp2();
    if row.status == crate::payment_review::DUPLICATE_REVIEW_PAYMENT_STATUS {
        let review = row
            .metadata
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|metadata| metadata.get("duplicate_review").cloned())
            .unwrap_or(Value::Null);
        let due_cents = review
            .get("amount_due_cents")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let message = format!(
            "This order was already paid. The {amount:.2} just taken is recorded for a manager to give back and is not counted. Do not charge it again."
        );
        return json!({
            "success": false,
            "errorCode": crate::payment_review::PAYMENT_SET_ASIDE_ERROR_CODE,
            "paymentSetAside": true,
            "paymentApproved": true,
            "paymentPersisted": true,
            "requiresReconciliation": false,
            "orderId": row.order_id,
            "paymentId": row.payment_id,
            "method": entry.method,
            "amount": amount,
            "amountCents": row.amount_cents,
            "amountDue": Cents::new(due_cents).to_f64_dp2(),
            "amountDueCents": due_cents,
            "reason": review.get("reason").cloned().unwrap_or(Value::Null),
            "error": message,
            "message": message,
        });
    }
    let settlement = crate::payments::load_order_settlement_snapshot(conn, &row.order_id)
        .ok()
        .map(crate::payments::settlement_snapshot_json)
        .unwrap_or(Value::Null);
    json!({
        "success": true,
        "alreadySaved": true,
        "orderId": row.order_id,
        "paymentId": row.payment_id,
        "method": entry.method,
        "amount": amount,
        "settlement": settlement,
        "message": format!("Payment of {amount:.2} recorded"),
    })
}

/// A write's answer that ends the save: a collection, or a payment set aside
/// for review (money that moved on a covered order, see `payments`).
fn answer_is_final(answer: &Value) -> bool {
    answer.get("success").and_then(Value::as_bool) == Some(true)
        || answer.get("errorCode").and_then(Value::as_str)
            == Some(crate::payment_review::PAYMENT_SET_ASIDE_ERROR_CODE)
}

fn answer_error(answer: &Value) -> String {
    answer
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("The payment write did not confirm the payment")
        .to_string()
}

/// The saved payment's answer if its row exists now; the record goes then.
fn saved_answer(db: &DbState, entry: &UnsavedChargedPayment) -> Option<Value> {
    let conn = db.conn.lock().ok()?;
    let row = saved_row_for(&conn, entry).ok()??;
    if let Err(error) = clear(&conn, &entry.idempotency_key) {
        // Not listed while its row exists; the next save clears it.
        warn!(error = %error, "The record of a saved charged payment could not be removed");
    }
    Some(saved_row_answer(&conn, entry, &row))
}

fn clear_quietly(db: &DbState, idempotency_key: &str) {
    if let Ok(conn) = db.conn.lock() {
        if let Err(error) = clear(&conn, idempotency_key) {
            warn!(error = %error, "The record of a saved charged payment could not be removed");
        }
    }
}

/// Write (or refresh) the record before the payment row. A record already
/// held for this key keeps its first capture time and its attempts.
fn hold_record(db: &DbState, entry: &mut UnsavedChargedPayment) {
    let conn = match db.conn.lock() {
        Ok(conn) => conn,
        Err(poisoned) => {
            error!(error = %poisoned, "The record of a charged payment could not be written");
            return;
        }
    };
    if let Ok(Some(previous)) = load(&conn, &entry.idempotency_key) {
        entry.captured_at = previous.captured_at;
        entry.attempts = previous.attempts;
    }
    if let Err(write_error) = record(&conn, entry) {
        error!(
            order_id = %entry.order_id,
            error = %write_error,
            "The record of a charged payment could not be written"
        );
    }
}

/// Save card money that already moved, with its durable record and bounded
/// retries (see the module docs). Never answers with a generic failure: the
/// answer is the collection, the payment set aside, or
/// [`PAYMENT_NOT_SAVED_ERROR_CODE`].
///
/// `write` is the idempotent write itself (`payments::record_payment` or its
/// collect-outstanding twin); `delays_ms` the waits between attempts
/// ([`MOVED_MONEY_SAVE_DELAYS_MS`]); `extra` fields the not-saved answer also
/// carries (the fiscal checkout of a collect-outstanding payment).
pub(crate) async fn save_charged_payment<W>(
    db: &DbState,
    entry: UnsavedChargedPayment,
    delays_ms: &[u64],
    extra: Option<Value>,
    mut write: W,
) -> Value
where
    W: FnMut(&DbState, &UnsavedChargedPayment) -> Result<Value, String> + Send,
{
    let mut held = entry;
    hold_record(db, &mut held);

    let mut last_error = String::new();
    let mut attempts: u32 = 0;
    for attempt in 0..=delays_ms.len() {
        if attempt > 0 {
            let wait = delays_ms[attempt - 1];
            if wait > 0 {
                tokio::time::sleep(Duration::from_millis(wait)).await;
            }
        }
        if let Some(answer) = saved_answer(db, &held) {
            return answer;
        }
        attempts += 1;
        match write(db, &held) {
            Ok(answer) if answer_is_final(&answer) => {
                clear_quietly(db, &held.idempotency_key);
                if attempts > 1 {
                    info!(
                        order_id = %held.order_id,
                        attempts,
                        "A charged payment was saved on a retry"
                    );
                }
                return answer;
            }
            Ok(answer) => last_error = answer_error(&answer),
            Err(write_error) => last_error = write_error,
        }
        warn!(
            order_id = %held.order_id,
            attempt = attempts,
            error = %last_error,
            "Saving a charged payment failed"
        );
        if is_lasting_payment_refusal(&last_error) {
            break;
        }
    }

    // Saved by an attempt that reported a failure afterwards?
    if let Some(answer) = saved_answer(db, &held) {
        return answer;
    }
    held.attempts = held.attempts.saturating_add(attempts);
    held.last_error = Some(last_error.clone());
    if let Ok(conn) = db.conn.lock() {
        if let Err(write_error) = record(&conn, &held) {
            // The record written before the attempts still stands.
            error!(error = %write_error, "The record of a charged payment could not be updated");
        }
    }
    error!(
        order_id = %held.order_id,
        attempts,
        error = %last_error,
        "A charged payment is not saved on this till yet"
    );
    not_saved_response(&held, extra.as_ref())
}

/// The write a record replays: the same call, the same key, no new charge.
pub(crate) fn write_recorded_payment(
    db: &DbState,
    entry: &UnsavedChargedPayment,
) -> Result<Value, String> {
    match entry
        .expected_balance
        .as_ref()
        .and_then(ExpectedBalance::to_snapshot)
    {
        Some(expected) => crate::payments::record_payment_with_expected_balance(
            db,
            &entry.request,
            Some(expected),
        ),
        None => crate::payments::record_payment(db, &entry.request),
    }
}

/// Write a new-order checkout: the order and its initial payment in one
/// transaction (`sync::create_order`, deduplicated by the order's client
/// request id, the payment by its idempotency key), then its fiscal
/// submission. The order is never paid without its row: the payment row is
/// written with it and the paid status is derived from it. Nothing is charged
/// here.
pub(crate) fn write_new_order_checkout(
    db: &DbState,
    order_payload: &Value,
    invalidator: &dyn crate::print::PrintQueueInvalidator,
) -> Result<Value, String> {
    let response = crate::sync::create_order(db, order_payload, invalidator)?;
    if let Some(order_id) = response.get("orderId").and_then(Value::as_str) {
        if let Ok(conn) = db.conn.lock() {
            if let Err(error) = crate::fiscal::dispatcher::enqueue_for_order(&conn, order_id) {
                warn!(
                    order_id = %order_id,
                    error = %error,
                    "Fiscal enqueue after saving a new-order checkout failed (best effort)"
                );
            }
        }
    }
    Ok(response)
}

/// The write any record replays: a new-order checkout writes its order and
/// payment together, every other record its payment.
pub(crate) fn write_recorded_entry(
    db: &DbState,
    entry: &UnsavedChargedPayment,
    invalidator: &dyn crate::print::PrintQueueInvalidator,
) -> Result<Value, String> {
    if entry.is_new_order_checkout() {
        return write_new_order_checkout(db, &entry.request, invalidator);
    }
    write_recorded_payment(db, entry)
}

/// "Save payment again": replay the records of one order (or the one named
/// by `idempotency_key`) with their own writes and keys. No new charge.
pub(crate) async fn save_unsaved_payments(
    db: &DbState,
    order_id: Option<&str>,
    idempotency_key: Option<&str>,
    delays_ms: &[u64],
    invalidator: &dyn crate::print::PrintQueueInvalidator,
) -> Result<Value, String> {
    let records = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        list(&conn, order_id)?
            .into_iter()
            .filter(|entry| idempotency_key.map_or(true, |key| entry.idempotency_key == key))
            .collect::<Vec<_>>()
    };
    let mut saved = 0usize;
    let mut set_aside = Vec::new();
    let mut unsaved = Vec::new();
    let mut results = Vec::new();
    for entry in records {
        let answer = save_charged_payment(db, entry, delays_ms, None, |db, entry| {
            write_recorded_entry(db, entry, invalidator)
        })
        .await;
        if answer.get("success").and_then(Value::as_bool) == Some(true) {
            saved += 1;
        } else if answer.get("paymentSetAside").and_then(Value::as_bool) == Some(true) {
            set_aside.push(answer.clone());
        } else if let Some(summary) = answer.get("unsavedPayment") {
            unsaved.push(summary.clone());
        }
        results.push(answer);
    }
    Ok(json!({
        "success": unsaved.is_empty(),
        "saved": saved,
        "setAside": set_aside,
        "unsaved": unsaved,
        "results": results,
    }))
}

/// What a manager's resolution of a charged payment not saved found.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ResolveOutcome {
    /// The audit entry holds the decision and the record is gone.
    Resolved {
        order_id: String,
        method: String,
        amount_cents: i64,
    },
    /// Resolved before: nothing changed.
    AlreadyResolved,
    /// Its payment row exists after all: nothing was lost, nothing to give back.
    Saved,
    /// No such record.
    NotFound,
}

impl ResolveOutcome {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Resolved { .. } => "resolved",
            Self::AlreadyResolved => "already_resolved",
            Self::Saved => "saved",
            Self::NotFound => "not_found",
        }
    }
}

/// "Money given back to the customer" for a charged payment the till could
/// not save. The audit entry goes first (the record as it was, the outcome,
/// who and when; in `recovery_action_log` and in
/// [`UNSAVED_CHARGED_PAYMENT_RESOLVED_CATEGORY`], the first entry kept), then
/// the record, which releases the Z. One savepoint: both or neither. The
/// order is left as it is.
pub(crate) fn resolve_in_connection(
    conn: &Connection,
    idempotency_key: &str,
    resolved_by: Option<&str>,
    resolved_at: &str,
) -> Result<ResolveOutcome, String> {
    let key = idempotency_key.trim();
    if key.is_empty() {
        return Ok(ResolveOutcome::NotFound);
    }
    crate::payment_review::with_savepoint(conn, "unsaved_payment_resolve", || {
        if saved_row(conn, key)?.is_some() {
            clear(conn, key)?;
            return Ok(ResolveOutcome::Saved);
        }
        let Some(entry) = load(conn, key)? else {
            let resolved =
                crate::db::get_setting(conn, UNSAVED_CHARGED_PAYMENT_RESOLVED_CATEGORY, key)
                    .is_some();
            return Ok(if resolved {
                ResolveOutcome::AlreadyResolved
            } else {
                ResolveOutcome::NotFound
            });
        };
        // Booked meanwhile under another key (the SALE's own recovery): the
        // money is recorded, nothing is given back.
        if saved_row_for(conn, &entry)?.is_some() {
            clear(conn, key)?;
            return Ok(ResolveOutcome::Saved);
        }

        let resolution = json!({
            "outcome": RETURNED_TO_CUSTOMER_OUTCOME,
            "resolved_by": resolved_by,
            "resolved_at": resolved_at,
        });
        let mut audit = serde_json::to_value(&entry)
            .map_err(|e| format!("serialize the resolved charged payment: {e}"))?;
        if let Some(object) = audit.as_object_mut() {
            object.insert("resolution".to_string(), resolution.clone());
        }
        conn.execute(
            "INSERT OR IGNORE INTO local_settings (setting_category, setting_key, setting_value, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                UNSAVED_CHARGED_PAYMENT_RESOLVED_CATEGORY,
                key,
                audit.to_string(),
                resolved_at
            ],
        )
        .map_err(|e| format!("write the resolution of a charged payment: {e}"))?;
        write_resolution_audit(conn, &entry, resolved_by, resolved_at, &resolution)?;
        mark_direct_sale_returned(conn, &entry, &resolution)?;
        clear(conn, key)?;
        info!(
            order_id = %entry.order_id,
            method = %entry.method,
            amount_cents = entry.amount_cents,
            resolved_by = resolved_by.unwrap_or(""),
            "A charged payment not saved was given back to the customer"
        );
        Ok(ResolveOutcome::Resolved {
            order_id: entry.order_id,
            method: entry.method,
            amount_cents: entry.amount_cents,
        })
    })
}

fn write_resolution_audit(
    conn: &Connection,
    entry: &UnsavedChargedPayment,
    resolved_by: Option<&str>,
    resolved_at: &str,
    resolution: &Value,
) -> Result<(), String> {
    if !crate::payment_review::table_exists(conn, "recovery_action_log")? {
        return Err("recovery_action_log is missing; the audit entry cannot be written".into());
    }
    let order_number: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(order_number, '')), '') FROM orders WHERE id = ?1",
            params![entry.order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load the order number for the resolution audit: {e}"))?
        .flatten();
    let message = format!(
        "A {} {} payment charged on this till and never saved was given back to the customer",
        amount_text(entry.amount_cents),
        entry.method
    );
    conn.execute(
        "INSERT INTO recovery_action_log (
             id, action_id, issue_code, entity_type, entity_id, order_id, order_number,
             success, message, actor_staff_id, payload_json, created_at
         ) VALUES (?1, 'payment_not_saved_resolved', ?2, 'unsaved_charged_payment', ?3, ?4, ?5,
                   1, ?6, ?7, ?8, ?9)",
        params![
            uuid::Uuid::new_v4().to_string(),
            PAYMENTS_NOT_SAVED_REASON_CODE,
            entry.idempotency_key,
            entry.order_id,
            order_number,
            message,
            resolved_by,
            json!({
                "record": summary_json(entry),
                "resolution": resolution,
            })
            .to_string(),
            resolved_at,
        ],
    )
    .map_err(|e| format!("write the resolution audit entry: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("pragmas");
        crate::db::run_migrations_for_test(&conn);
        DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn seed_order(db: &DbState, order_id: &str, total_cents: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO orders (id, order_number, items, total_amount, total_amount_cents,
                    status, order_type, payment_status, sync_status, branch_id, created_at, updated_at)
                 VALUES (?1, 'A-0042', '[]', ?2, ?3, 'completed', 'takeaway', 'pending', 'synced',
                         'branch-1', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z')",
                params![order_id, total_cents as f64 / 100.0, total_cents],
            )
            .unwrap();
    }

    fn approved_card(order_id: &str, amount: f64, reference: &str) -> Value {
        json!({
            "orderId": order_id,
            "method": "card",
            "amount": amount,
            "transactionRef": reference,
            "paymentOrigin": "terminal",
            "terminalApproved": true,
            "terminalDeviceId": "eft-1",
        })
    }

    fn entry(order_id: &str, amount: f64, reference: &str) -> UnsavedChargedPayment {
        UnsavedChargedPayment::for_payment(
            order_id,
            &approved_card(order_id, amount, reference),
            None,
            "2026-09-30T10:05:00Z",
        )
        .expect("a keyed card payment")
    }

    fn completed_cents(db: &DbState, order_id: &str) -> i64 {
        db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COALESCE(SUM(amount_cents), 0) FROM order_payments
                 WHERE order_id = ?1 AND status = 'completed'",
                params![order_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn a_terminal_card_is_keyed_by_its_approval() {
        let entry = entry("ord-1", 13.0, "txn-1");
        assert_eq!(entry.idempotency_key, "terminal-card:txn-1");
        assert_eq!(entry.request["idempotencyKey"], "terminal-card:txn-1");
        assert_eq!(entry.amount_cents, 1300);
        assert_eq!(entry.kind, KIND_SINGLE);
        let explicit = json!({
            "orderId": "ord-1", "method": "card", "amount": 5.0,
            "transactionRef": "txn-2", "idempotencyKey": "attempt-7",
            "items": [{ "itemIndex": 0 }],
        });
        let split = UnsavedChargedPayment::for_payment("ord-1", &explicit, None, "now").unwrap();
        assert_eq!(split.idempotency_key, "attempt-7");
        assert_eq!(split.kind, KIND_SPLIT_PORTION);
        let unkeyed = json!({ "orderId": "ord-1", "method": "card", "amount": 5.0 });
        assert!(UnsavedChargedPayment::for_payment("ord-1", &unkeyed, None, "now").is_none());
    }

    #[test]
    fn the_expected_balance_round_trips_through_its_record() {
        let snapshot = OrderPaymentBalanceSnapshot {
            order_total: 20.0,
            net_paid: 7.0,
            outstanding_amount: 13.0,
            completed_payment_count: 1,
            ledger_generation: [0xab; 32],
        };
        let stored = ExpectedBalance::from_snapshot(&snapshot);
        assert_eq!(stored.ledger_generation.len(), 64);
        assert_eq!(stored.to_snapshot(), Some(snapshot));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_transient_failure_is_saved_on_a_retry_and_the_record_goes() {
        let db = test_db();
        seed_order(&db, "ord-retry", 1300);
        let mut writes = 0;
        let answer = save_charged_payment(
            &db,
            entry("ord-retry", 13.0, "txn-retry"),
            &[0, 0, 0],
            None,
            |db, entry| {
                writes += 1;
                if writes == 1 {
                    // Written before the first attempt, still there.
                    let conn = db.conn.lock().unwrap();
                    assert!(load(&conn, &entry.idempotency_key).unwrap().is_some());
                    return Err("database is locked".to_string());
                }
                write_recorded_payment(db, entry)
            },
        )
        .await;
        assert_eq!(answer["success"], true, "{answer}");
        assert_eq!(writes, 2, "one retry, the same key");
        assert_eq!(completed_cents(&db, "ord-retry"), 1300);
        let conn = db.conn.lock().unwrap();
        assert!(
            list(&conn, None).unwrap().is_empty(),
            "saved: the record goes"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_lasting_refusal_is_not_retried_and_the_record_stays() {
        let db = test_db();
        seed_order(&db, "ord-lasting", 1300);
        let mut writes = 0;
        let answer = save_charged_payment(
            &db,
            entry("ord-lasting", 13.0, "txn-lasting"),
            &[0, 0, 0],
            None,
            |_, _| {
                writes += 1;
                Err(format!(
                    "{}: order ord-lasting is settled by the platform (efood).",
                    crate::payments::PLATFORM_HELD_COLLECTION_ERROR
                ))
            },
        )
        .await;
        assert_eq!(writes, 1, "a rule, not a hiccup: no retry");
        assert_eq!(answer["errorCode"], PAYMENT_NOT_SAVED_ERROR_CODE);
        assert_eq!(answer["paymentApproved"], true);
        assert_eq!(answer["paymentPersisted"], false);
        assert_eq!(answer["unsavedPayment"]["canSaveAgain"], false);
        assert!(answer["error"]
            .as_str()
            .unwrap()
            .contains("Do not charge again"));
        let conn = db.conn.lock().unwrap();
        let kept = list(&conn, Some("ord-lasting")).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].attempts, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_persistent_failure_is_bounded_to_four_writes() {
        let db = test_db();
        seed_order(&db, "ord-bounded", 1300);
        let mut writes = 0;
        let answer = save_charged_payment(
            &db,
            entry("ord-bounded", 13.0, "txn-bounded"),
            &[0, 0, 0],
            None,
            |_, _| {
                writes += 1;
                Err("disk I/O error".to_string())
            },
        )
        .await;
        assert_eq!(writes, 4, "the first write and three retries");
        assert_eq!(answer["errorCode"], PAYMENT_NOT_SAVED_ERROR_CODE);
        assert_eq!(answer["unsavedPayment"]["canSaveAgain"], true);
        assert_eq!(
            completed_cents(&db, "ord-bounded"),
            0,
            "the order stays unpaid"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_write_that_committed_before_failing_is_never_written_twice() {
        let db = test_db();
        seed_order(&db, "ord-twice", 1300);
        let mut writes = 0;
        let answer = save_charged_payment(
            &db,
            entry("ord-twice", 13.0, "txn-twice"),
            &[0, 0, 0],
            None,
            |db, entry| {
                writes += 1;
                write_recorded_payment(db, entry)?;
                Err("the answer was lost after the commit".to_string())
            },
        )
        .await;
        assert_eq!(writes, 1);
        assert_eq!(answer["success"], true, "found saved by its key");
        assert_eq!(answer["alreadySaved"], true);
        assert_eq!(completed_cents(&db, "ord-twice"), 1300, "one row, not two");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolving_writes_the_audit_first_keeps_the_order_and_is_idempotent() {
        let db = test_db();
        seed_order(&db, "ord-resolve", 1300);
        save_charged_payment(
            &db,
            entry("ord-resolve", 13.0, "txn-resolve"),
            &[0, 0, 0],
            None,
            |_, _| Err("disk I/O error".to_string()),
        )
        .await;
        let conn = db.conn.lock().unwrap();
        let outcome = resolve_in_connection(
            &conn,
            "terminal-card:txn-resolve",
            Some("staff-manager"),
            "2026-09-30T18:00:00Z",
        )
        .unwrap();
        assert_eq!(
            outcome,
            ResolveOutcome::Resolved {
                order_id: "ord-resolve".to_string(),
                method: "card".to_string(),
                amount_cents: 1300,
            }
        );
        assert!(list(&conn, None).unwrap().is_empty(), "the Z is released");
        let audit: String = conn
            .query_row(
                "SELECT payload_json FROM recovery_action_log
                 WHERE action_id = 'payment_not_saved_resolved' AND issue_code = 'payments_not_saved'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(audit.contains("returned_to_customer"));
        let kept: String = crate::db::get_setting(
            &conn,
            UNSAVED_CHARGED_PAYMENT_RESOLVED_CATEGORY,
            "terminal-card:txn-resolve",
        )
        .unwrap();
        assert!(kept.contains("staff-manager"));
        let payment_status: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id = 'ord-resolve'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payment_status, "pending", "the order is left as it is");
        assert_eq!(
            resolve_in_connection(&conn, "terminal-card:txn-resolve", None, "later").unwrap(),
            ResolveOutcome::AlreadyResolved
        );
        assert_eq!(
            resolve_in_connection(&conn, "terminal-card:unknown", None, "later").unwrap(),
            ResolveOutcome::NotFound
        );
    }
}
