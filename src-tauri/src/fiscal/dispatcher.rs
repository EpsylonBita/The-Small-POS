//! pos-tauri online dispatcher for fiscalization.
//!
//! Implements Task 19 of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Reqs 4.1, 4.2, 4.3, 4.4, 4.8, 4.9, 4.10, 4.11, 12.
//!
//! Called from the order-persist path (T22 hook in `commands::orders`)
//! AFTER the order's local transaction commits. NEVER blocks the order
//! command — caller spawns this via `tokio::spawn` and discards the
//! result. Any error here is logged and swallowed; the order is already
//! persisted, so the cashier moves on.
//!
//! Decision tree:
//!   1. Consult [`active_cache`] — if `Inactive`, skip silently.
//!   2. Build payload via [`payload_builder`].
//!   3. Try `POST /api/plugins/fiscal/submit`.
//!   4. On HTTP 2xx → done, mirror server outcome.
//!   5. On network error / non-2xx → enqueue onto `parity_sync_queue`
//!      with `module_type='fiscal'`, replayed later by [`replay`].
//!
//! Per Req 12, every branch in this function ends in `Ok(_)` from the
//! caller's perspective — even configuration gaps, network failures, and
//! local-enqueue failures are absorbed into a log + return.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::active_cache::{self, CacheVerdict};
use super::payload_builder;

const SUBMIT_PATH: &str = "/api/plugins/fiscal/submit";
const REQUEST_TIMEOUT_SECS: u64 = 15;

/// What the server returned. Mirrors `FiscalDispatchOutcome` from
/// `shared/types/fiscalization.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchOutcome {
    pub status: String,
    #[serde(rename = "outboxRowId")]
    pub outbox_row_id: Option<String>,
    #[serde(rename = "pluginId")]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "authorityId", default)]
    pub authority_id: Option<String>,
}

/// Local-side disposition for a single submit attempt.
#[derive(Debug, Clone)]
pub enum LocalOutcome {
    /// Server accepted (status='submitted' / 'queued' / 'skipped').
    Server(DispatchOutcome),
    /// Active-cache said inactive — no payload built, no request sent.
    SkippedInactiveCached,
    /// Tried POST but network or 5xx failed; row enqueued for retry.
    EnqueuedForRetry { idempotency_key: String },
    /// Could not build payload, could not enqueue, etc. — logged, dropped.
    DroppedWithLog,
}

/// Submit-for-order entry point. Called from the order-persist hook (T22).
///
/// Caller MUST `tokio::spawn(submit_for_order(...))` and discard the
/// `JoinHandle`. This function returns `LocalOutcome` for observability
/// in tests; the production caller never inspects it.
pub async fn submit_for_order(
    conn: Arc<Mutex<Connection>>,
    order_id: String,
    admin_base_url: String,
    api_key: String,
    terminal_id: String,
    branch_id: String,
) -> LocalOutcome {
    // Step 1: short-circuit on cached inactive verdict (Req 4.10)
    if let CacheVerdict::Inactive = active_cache::verdict(&branch_id) {
        info!(
            "[fiscal.dispatcher] skipping enqueue for order {order_id} — \
             cached fiscal_active=false for branch {branch_id}"
        );
        return LocalOutcome::SkippedInactiveCached;
    }

    // Step 2: build payload
    let payload = {
        let db = match conn.lock() {
            Ok(g) => g,
            Err(e) => {
                warn!("[fiscal.dispatcher] DB mutex poisoned: {e}");
                return LocalOutcome::DroppedWithLog;
            }
        };
        match payload_builder::build_fiscal_receipt_input(&db, &order_id, &branch_id) {
            Ok(value) => value,
            Err(e) => {
                warn!("[fiscal.dispatcher] payload build failed for order {order_id}: {e}");
                return LocalOutcome::DroppedWithLog;
            }
        }
    };

    let idempotency_key = format!("fiscal:{order_id}:{branch_id}");

    // Step 3: try POST
    let post_outcome = try_post(&admin_base_url, &api_key, &terminal_id, &payload).await;

    match post_outcome {
        Ok(outcome) => LocalOutcome::Server(outcome),
        Err(post_err) => {
            warn!(
                "[fiscal.dispatcher] POST failed for order {order_id} (key {idempotency_key}): \
                 {post_err}. Enqueueing onto parity_sync_queue."
            );

            // Step 4: enqueue onto parity_sync_queue with module_type='fiscal'
            let enqueue_result = {
                let db = match conn.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        warn!("[fiscal.dispatcher] DB mutex poisoned during enqueue: {e}");
                        return LocalOutcome::DroppedWithLog;
                    }
                };
                enqueue_fiscal_row(&db, &order_id, &branch_id, &payload)
            };

            match enqueue_result {
                Ok(()) => LocalOutcome::EnqueuedForRetry { idempotency_key },
                Err(e) => {
                    warn!(
                        "[fiscal.dispatcher] enqueue also failed for order {order_id}: {e}. \
                         Receipt dropped — order itself is already persisted, cashier continues."
                    );
                    LocalOutcome::DroppedWithLog
                }
            }
        }
    }
}

/// Build and execute the POST. Used by both [`submit_for_order`] and
/// the replay path (T20).
pub(crate) async fn try_post(
    admin_base_url: &str,
    api_key: &str,
    terminal_id: &str,
    payload: &serde_json::Value,
) -> Result<DispatchOutcome, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("reqwest client build: {e}"))?;

    let url = format!("{}{}", admin_base_url.trim_end_matches('/'), SUBMIT_PATH);

    let response = client
        .post(&url)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", terminal_id)
        .header("Content-Type", "application/json")
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;

    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("read response body: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "POST {url} returned HTTP {}: {}",
            status.as_u16(),
            body_text
        ));
    }

    serde_json::from_str::<DispatchOutcome>(&body_text)
        .map_err(|e| format!("parse DispatchOutcome from response: {e}"))
}

/// Best-effort handoff for an order that was just persisted (T22 entry).
///
/// Reads `branch_id` from the local `orders` row, builds the canonical
/// payload via [`super::payload_builder`], and enqueues a
/// `module_type='fiscal'` row onto `parity_sync_queue` for replay by the
/// existing sync_queue dispatcher (T21 wires the routing).
///
/// Per Req 12 (fiscalization is optional): every error path returns
/// `Err(String)` to the caller so they can log; the caller MUST NOT
/// propagate this error to the order command. Currently consulted as a
/// fire-and-forget log-on-error from `commands::orders::order_create`.
///
/// If [`active_cache`] verdict is `Inactive`, returns Ok(()) without
/// enqueueing — the offline outbox would otherwise fill with payloads
/// that always resolve to `status='skipped'` once replayed.
pub fn enqueue_for_order(conn: &Connection, order_id: &str) -> Result<(), String> {
    let branch_id: String = conn
        .query_row(
            "SELECT COALESCE(branch_id, '') FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("read branch_id for order {order_id}: {e}"))?;

    if branch_id.is_empty() {
        return Err(format!(
            "order {order_id} has no branch_id; cannot enqueue fiscal row"
        ));
    }

    if let CacheVerdict::Inactive = active_cache::verdict(&branch_id) {
        info!(
            "[fiscal.dispatcher] skipping fiscal enqueue for order {order_id} — \
             cached fiscal_active=false for branch {branch_id}"
        );
        return Ok(());
    }

    let payload = super::payload_builder::build_fiscal_receipt_input(conn, order_id, &branch_id)?;

    enqueue_fiscal_row(conn, order_id, &branch_id, &payload)
}

/// Insert a `module_type='fiscal'` row into `parity_sync_queue` for replay
/// by the existing sync_queue dispatcher (T21 wires the routing).
///
/// **Delegates to `crate::sync_queue::enqueue_payload_item`** so we use the
/// EXACT same column shape (data / organization_id / operation IN ('INSERT',
/// 'UPDATE', 'DELETE')) every other module type uses. Earlier revisions of
/// this function used a hand-rolled `INSERT INTO parity_sync_queue` with the
/// wrong column names (`payload`, `retries`, `operation='POST'`) and missing
/// the NOT NULL `organization_id`; those would fail at the SQL layer on a
/// real terminal even though the tests passed against a fake schema.
///
/// We also call `clear_unsynced_items` first to drop any earlier pending
/// fiscal row for the same order — matches the dedup pattern used by
/// `enqueue_order_sync_payload` and friends in `commands::orders`.
fn enqueue_fiscal_row(
    conn: &Connection,
    order_id: &str,
    branch_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    // Drop any earlier pending fiscal row for this order so we don't queue
    // up duplicates locally. The server-side outbox's UNIQUE(org_id,
    // idempotency_key) is the ultimate dedup authority, but this keeps the
    // local queue clean.
    crate::sync_queue::clear_unsynced_items(conn, "fiscal_submission", order_id)
        .map_err(|e| format!("fiscal clear_unsynced_items: {e}"))?;

    crate::sync_queue::enqueue_payload_item(
        conn,
        "fiscal_submission",
        order_id,
        "INSERT", // operation must satisfy the CHECK ('INSERT','UPDATE','DELETE')
        payload,
        Some(100), // FINANCIAL_CRITICAL priority — tax-authority deadlines matter
        Some("fiscal"),
        Some("last-write-wins"),
        Some(1),
    )
    .map_err(|e| format!("enqueue parity_sync_queue (fiscal): {e}"))?;

    let _ = branch_id; // branch_id lives in the payload; sync_queue worker reads it from there
    Ok(())
}
