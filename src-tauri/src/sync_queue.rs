//! Offline sync queue backed by local SQLite.
//!
//! Provides a durable, priority-aware FIFO queue for offline POS operations.
//! Items are persisted to SQLite so they survive renderer crashes and app
//! restarts. Processing uses exponential backoff for transient failures.
//!
//! # Tables
//!
//! - `parity_sync_queue` -- queued operations awaiting sync to the admin API.
//! - `conflict_audit_log` -- audit trail for conflicts detected during sync.
//!
//! # Queue Semantics
//!
//! - FIFO within priority bands (higher priority processed first).
//! - Max queue size: 500 items (configurable via `MAX_QUEUE_SIZE`).
//! - Exponential backoff: initial 1s, doubles per attempt, capped at 60s.
//! - Max retries: 10 (item marked `failed` after exhaustion).
//! - Age warning threshold: 24 hours (logged, not blocking).

use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Method;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{db, storage, sync};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of items allowed in the queue before rejecting new entries.
pub const MAX_QUEUE_SIZE: i64 = 500;

/// Default initial retry delay in milliseconds.
const DEFAULT_INITIAL_RETRY_DELAY_MS: i64 = 1000;

/// Maximum retry delay in milliseconds (cap for exponential backoff).
const MAX_RETRY_DELAY_MS: i64 = 60_000;

/// Maximum number of retry attempts before marking an item as permanently failed.
pub const MAX_RETRY_ATTEMPTS: i64 = 10;

/// Age threshold in milliseconds for old-item warnings (24 hours).
const AGE_WARNING_THRESHOLD_MS: i64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Data structures (mirror shared/pos/sync-queue-types.ts)
// ---------------------------------------------------------------------------

/// A single queued sync operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncQueueItem {
    pub id: String,
    pub table_name: String,
    pub record_id: String,
    pub operation: String,
    pub data: String,
    pub organization_id: String,
    pub created_at: String,
    pub attempts: i64,
    pub last_attempt: Option<String>,
    pub error_message: Option<String>,
    pub next_retry_at: Option<String>,
    pub retry_delay_ms: i64,
    pub priority: i64,
    pub module_type: String,
    pub conflict_strategy: String,
    pub version: i64,
    pub status: String,
}

/// Input for enqueueing a new item (fields auto-populated by the queue).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueInput {
    pub table_name: String,
    pub record_id: String,
    pub operation: String,
    pub data: String,
    pub organization_id: String,
    pub priority: Option<i64>,
    pub module_type: Option<String>,
    pub conflict_strategy: Option<String>,
    pub version: Option<i64>,
}

/// Result of a queue processing batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub success: bool,
    pub processed: i64,
    pub failed: i64,
    pub conflicts: i64,
    pub errors: Vec<SyncError>,
}

/// Individual error from queue processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    pub item_id: String,
    pub table_name: String,
    pub record_id: String,
    pub error: String,
    pub http_status: Option<u16>,
}

/// Summary status of the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub total: i64,
    pub pending: i64,
    pub failed: i64,
    pub conflicts: i64,
    pub oldest_item_age: Option<i64>,
}

/// Query options for listing actionable parity queue items.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueListQuery {
    pub limit: Option<i64>,
    pub module_type: Option<String>,
}

/// Result of retrying parity queue items.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryItemsResult {
    pub retried: i64,
}

/// Conflict audit entry returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAuditEntry {
    pub id: String,
    pub operation_type: String,
    pub entity_id: String,
    pub entity_type: String,
    pub local_version: i64,
    pub server_version: i64,
    pub timestamp: String,
    pub discarded_payload: String,
    pub resolution: String,
    pub is_monetary: bool,
    pub reviewed_by_operator: bool,
}

#[derive(Debug)]
enum RequestPreparation {
    Ready(RequestSpec),
    Deferred { reason: String },
    Failed { reason: String },
}

#[derive(Debug)]
struct RequestSpec {
    endpoint: String,
    method: Method,
    body: Option<String>,
    terminal_id: String,
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/// Create the `parity_sync_queue` and `conflict_audit_log` tables if they do
/// not already exist. Called during database migration.
pub fn create_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS parity_sync_queue (
            id              TEXT PRIMARY KEY,
            table_name      TEXT NOT NULL,
            record_id       TEXT NOT NULL,
            operation       TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
            data            TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            attempts        INTEGER NOT NULL DEFAULT 0,
            last_attempt    TEXT,
            error_message   TEXT,
            next_retry_at   TEXT,
            retry_delay_ms  INTEGER NOT NULL DEFAULT 1000,
            priority        INTEGER NOT NULL DEFAULT 0,
            module_type     TEXT NOT NULL DEFAULT 'orders',
            conflict_strategy TEXT NOT NULL DEFAULT 'server-wins',
            version         INTEGER NOT NULL DEFAULT 1,
            status          TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'failed', 'conflict'))
        );

        CREATE INDEX IF NOT EXISTS idx_parity_sq_priority_created
            ON parity_sync_queue (priority DESC, created_at ASC);

        CREATE INDEX IF NOT EXISTS idx_parity_sq_next_retry
            ON parity_sync_queue (next_retry_at ASC)
            WHERE next_retry_at IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_parity_sq_org
            ON parity_sync_queue (organization_id);

        CREATE TABLE IF NOT EXISTS conflict_audit_log (
            id                    TEXT PRIMARY KEY,
            operation_type        TEXT NOT NULL,
            entity_id             TEXT NOT NULL,
            entity_type           TEXT NOT NULL,
            local_version         INTEGER NOT NULL,
            server_version        INTEGER NOT NULL,
            timestamp             TEXT NOT NULL DEFAULT (datetime('now')),
            discarded_payload     TEXT NOT NULL,
            resolution            TEXT NOT NULL,
            is_monetary           INTEGER NOT NULL DEFAULT 0,
            reviewed_by_operator  INTEGER NOT NULL DEFAULT 0
        );
        ",
    )
    .map_err(|e| format!("sync_queue create_tables: {e}"))?;

    info!("Parity sync queue tables initialized");
    Ok(())
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/// Enqueue a new sync item. Returns the generated UUID.
///
/// Rejects if the queue has reached `MAX_QUEUE_SIZE`.
pub fn enqueue(conn: &Connection, input: &EnqueueInput) -> Result<String, String> {
    // Check queue capacity
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("sync_queue count: {e}"))?;

    if count >= MAX_QUEUE_SIZE {
        return Err(format!(
            "Sync queue is full ({count}/{MAX_QUEUE_SIZE}). \
             Clear or process pending items before enqueuing more."
        ));
    }

    // Validate operation
    let op = input.operation.to_uppercase();
    if op != "INSERT" && op != "UPDATE" && op != "DELETE" {
        return Err(format!(
            "Invalid sync operation '{}'. Expected INSERT, UPDATE, or DELETE.",
            input.operation
        ));
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let priority = input.priority.unwrap_or(0);
    let module_type = input.module_type.as_deref().unwrap_or("orders");
    let conflict_strategy = input.conflict_strategy.as_deref().unwrap_or("server-wins");
    let version = input.version.unwrap_or(1);

    conn.execute(
        "INSERT INTO parity_sync_queue
            (id, table_name, record_id, operation, data, organization_id,
             created_at, attempts, retry_delay_ms, priority, module_type,
             conflict_strategy, version, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?12, 'pending')",
        params![
            id,
            input.table_name,
            input.record_id,
            op,
            input.data,
            input.organization_id,
            now,
            DEFAULT_INITIAL_RETRY_DELAY_MS,
            priority,
            module_type,
            conflict_strategy,
            version,
        ],
    )
    .map_err(|e| format!("sync_queue enqueue: {e}"))?;

    info!(
        id = %id,
        table = %input.table_name,
        record = %input.record_id,
        op = %op,
        org = %input.organization_id,
        "Enqueued sync item"
    );

    Ok(id)
}

fn string_field(payload: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn infer_organization_id(conn: &Connection, payload: &Value) -> String {
    string_field(payload, &["organizationId", "organization_id"])
        .or_else(|| db::get_setting(conn, "terminal", "organization_id"))
        .or_else(|| storage::get_credential("organization_id"))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "pending-org".to_string())
}

fn resolve_runtime_context(conn: &Connection, payload: &Value) -> (String, String, String) {
    // Keyring-first after the inline payload: OS credential store is
    // authoritative; plaintext `local_settings` is backward-compat fallback.
    let terminal_id = string_field(payload, &["terminalId", "terminal_id"])
        .or_else(|| storage::get_credential("terminal_id"))
        .or_else(|| db::get_setting(conn, "terminal", "terminal_id"))
        .unwrap_or_default();
    let branch_id = string_field(payload, &["branchId", "branch_id"])
        .or_else(|| storage::get_credential("branch_id"))
        .or_else(|| db::get_setting(conn, "terminal", "branch_id"))
        .unwrap_or_default();
    let organization_id = infer_organization_id(conn, payload);

    (terminal_id, branch_id, organization_id)
}

fn resolve_request_terminal_id(conn: &Connection, payload: &Value) -> Option<String> {
    let (terminal_id, _, _) = resolve_runtime_context(conn, payload);
    let trimmed = terminal_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn enqueue_payload_item(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
    operation: &str,
    payload: &Value,
    priority: Option<i64>,
    module_type: Option<&str>,
    conflict_strategy: Option<&str>,
    version: Option<i64>,
) -> Result<String, String> {
    let organization_id = infer_organization_id(conn, payload);

    enqueue(
        conn,
        &EnqueueInput {
            table_name: table_name.to_string(),
            record_id: record_id.to_string(),
            operation: operation.to_string(),
            data: payload.to_string(),
            organization_id,
            priority,
            module_type: module_type.map(ToString::to_string),
            conflict_strategy: conflict_strategy.map(ToString::to_string),
            version,
        },
    )
}

pub fn clear_unsynced_items(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM parity_sync_queue
         WHERE table_name = ?1
           AND record_id = ?2
           AND status IN ('pending', 'failed', 'conflict')",
        params![table_name, record_id],
    )
    .map_err(|e| format!("sync_queue clear_unsynced_items: {e}"))
}

/// Dequeue the next item to process (highest priority first, then oldest).
///
/// Returns `None` if the queue is empty or all items are scheduled for later.
/// Only considers items with status `pending` whose `next_retry_at` has passed.
pub fn dequeue(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    let now = Utc::now().to_rfc3339();

    let item = conn
        .query_row(
            "SELECT id, table_name, record_id, operation, data, organization_id,
                    created_at, attempts, last_attempt, error_message, next_retry_at,
                    retry_delay_ms, priority, module_type, conflict_strategy, version, status
             FROM parity_sync_queue
             WHERE status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= ?1)
             ORDER BY priority DESC, created_at ASC
             LIMIT 1",
            params![now],
            |row| {
                Ok(SyncQueueItem {
                    id: row.get(0)?,
                    table_name: row.get(1)?,
                    record_id: row.get(2)?,
                    operation: row.get(3)?,
                    data: row.get(4)?,
                    organization_id: row.get(5)?,
                    created_at: row.get(6)?,
                    attempts: row.get(7)?,
                    last_attempt: row.get(8)?,
                    error_message: row.get(9)?,
                    next_retry_at: row.get(10)?,
                    retry_delay_ms: row.get(11)?,
                    priority: row.get(12)?,
                    module_type: row.get(13)?,
                    conflict_strategy: row.get(14)?,
                    version: row.get(15)?,
                    status: row.get(16)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("sync_queue dequeue: {e}"))?;

    if let Some(ref item) = item {
        // Mark as processing so it won't be dequeued again
        conn.execute(
            "UPDATE parity_sync_queue SET status = 'processing' WHERE id = ?1",
            params![item.id],
        )
        .map_err(|e| format!("sync_queue mark processing: {e}"))?;
    }

    Ok(item)
}

/// Peek at the next item without removing or marking it.
pub fn peek(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    let now = Utc::now().to_rfc3339();

    conn.query_row(
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version, status
         FROM parity_sync_queue
         WHERE status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= ?1)
         ORDER BY priority DESC, created_at ASC
         LIMIT 1",
        params![now],
        |row| {
            Ok(SyncQueueItem {
                id: row.get(0)?,
                table_name: row.get(1)?,
                record_id: row.get(2)?,
                operation: row.get(3)?,
                data: row.get(4)?,
                organization_id: row.get(5)?,
                created_at: row.get(6)?,
                attempts: row.get(7)?,
                last_attempt: row.get(8)?,
                error_message: row.get(9)?,
                next_retry_at: row.get(10)?,
                retry_delay_ms: row.get(11)?,
                priority: row.get(12)?,
                module_type: row.get(13)?,
                conflict_strategy: row.get(14)?,
                version: row.get(15)?,
                status: row.get(16)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("sync_queue peek: {e}"))
}

/// Clear all items from the queue.
pub fn clear(conn: &Connection) -> Result<(), String> {
    let deleted: usize = conn
        .execute("DELETE FROM parity_sync_queue", [])
        .map_err(|e| format!("sync_queue clear: {e}"))?;

    info!(deleted = deleted, "Cleared parity sync queue");
    Ok(())
}

/// Get the current number of items in the queue.
pub fn get_length(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
        row.get(0)
    })
    .map_err(|e| format!("sync_queue length: {e}"))
}

/// Get detailed queue status including counts by status and oldest item age.
pub fn get_status(conn: &Connection) -> Result<QueueStatus, String> {
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("sync_queue status total: {e}"))?;

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status pending: {e}"))?;

    let failed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status failed: {e}"))?;

    let conflicts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'conflict'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status conflicts: {e}"))?;

    // Calculate oldest item age in milliseconds
    let oldest_created: Option<String> = conn
        .query_row("SELECT MIN(created_at) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("sync_queue status oldest: {e}"))?;

    let oldest_item_age = oldest_created.and_then(|ts| {
        chrono::DateTime::parse_from_rfc3339(&ts)
            .ok()
            .map(|dt| Utc::now().signed_duration_since(dt).num_milliseconds())
    });

    Ok(QueueStatus {
        total,
        pending,
        failed,
        conflicts,
        oldest_item_age,
    })
}

pub fn list_actionable_items(
    conn: &Connection,
    query: &QueueListQuery,
) -> Result<Vec<SyncQueueItem>, String> {
    let limit = query.limit.unwrap_or(200).clamp(1, 500);

    let sql = if query
        .module_type
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
           AND module_type = ?1
         ORDER BY
            CASE status
                WHEN 'conflict' THEN 0
                WHEN 'failed' THEN 1
                WHEN 'pending' THEN 2
                ELSE 3
            END,
            priority DESC,
            created_at ASC
         LIMIT ?2"
    } else {
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
         ORDER BY
            CASE status
                WHEN 'conflict' THEN 0
                WHEN 'failed' THEN 1
                WHEN 'pending' THEN 2
                ELSE 3
            END,
            priority DESC,
            created_at ASC
         LIMIT ?1"
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("sync_queue list_actionable_items prepare: {e}"))?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SyncQueueItem> {
        Ok(SyncQueueItem {
            id: row.get(0)?,
            table_name: row.get(1)?,
            record_id: row.get(2)?,
            operation: row.get(3)?,
            data: row.get(4)?,
            organization_id: row.get(5)?,
            created_at: row.get(6)?,
            attempts: row.get(7)?,
            last_attempt: row.get(8)?,
            error_message: row.get(9)?,
            next_retry_at: row.get(10)?,
            retry_delay_ms: row.get(11)?,
            priority: row.get(12)?,
            module_type: row.get(13)?,
            conflict_strategy: row.get(14)?,
            version: row.get(15)?,
            status: row.get(16)?,
        })
    };

    let rows = if let Some(module_type) = query
        .module_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        stmt.query_map(params![module_type, limit], map_row)
            .map_err(|e| format!("sync_queue list_actionable_items query: {e}"))?
    } else {
        stmt.query_map(params![limit], map_row)
            .map_err(|e| format!("sync_queue list_actionable_items query: {e}"))?
    };

    Ok(rows.filter_map(Result::ok).collect())
}

pub fn retry_item(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE parity_sync_queue
         SET status = 'pending',
             attempts = 0,
             error_message = NULL,
             next_retry_at = NULL,
             last_attempt = NULL,
             retry_delay_ms = ?1
         WHERE id = ?2",
        params![DEFAULT_INITIAL_RETRY_DELAY_MS, item_id],
    )
    .map_err(|e| format!("sync_queue retry_item: {e}"))?;

    Ok(())
}

pub fn retry_items_by_module(
    conn: &Connection,
    module_type: &str,
) -> Result<RetryItemsResult, String> {
    let retried = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 attempts = 0,
                 error_message = NULL,
                 next_retry_at = NULL,
                 last_attempt = NULL,
                 retry_delay_ms = ?1
             WHERE module_type = ?2
               AND status IN ('pending', 'failed', 'conflict')",
            params![DEFAULT_INITIAL_RETRY_DELAY_MS, module_type],
        )
        .map_err(|e| format!("sync_queue retry_items_by_module: {e}"))?;

    Ok(RetryItemsResult {
        retried: retried as i64,
    })
}

pub fn list_conflict_audit_entries(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<ConflictAuditEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, operation_type, entity_id, entity_type, local_version,
                    server_version, timestamp, discarded_payload, resolution,
                    is_monetary, reviewed_by_operator
             FROM conflict_audit_log
             ORDER BY timestamp DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("sync_queue list_conflict_audit_entries prepare: {e}"))?;

    let rows = stmt
        .query_map(params![limit.clamp(1, 500)], |row| {
            Ok(ConflictAuditEntry {
                id: row.get(0)?,
                operation_type: row.get(1)?,
                entity_id: row.get(2)?,
                entity_type: row.get(3)?,
                local_version: row.get(4)?,
                server_version: row.get(5)?,
                timestamp: row.get(6)?,
                discarded_payload: row.get(7)?,
                resolution: row.get(8)?,
                is_monetary: row.get::<_, i64>(9)? != 0,
                reviewed_by_operator: row.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|e| format!("sync_queue list_conflict_audit_entries query: {e}"))?;

    Ok(rows.filter_map(Result::ok).collect())
}

/// Mark an item as successfully processed and remove it from the queue.
pub fn mark_success(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM parity_sync_queue WHERE id = ?1",
        params![item_id],
    )
    .map_err(|e| format!("sync_queue mark_success: {e}"))?;

    Ok(())
}

/// Mark an item as failed with exponential backoff for retry.
///
/// If max retries are exhausted, the item status changes to `failed`.
pub fn mark_failure(conn: &Connection, item_id: &str, error_message: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    // Get current attempts and retry delay
    let (attempts, retry_delay_ms): (i64, i64) = conn
        .query_row(
            "SELECT attempts, retry_delay_ms FROM parity_sync_queue WHERE id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("sync_queue mark_failure read: {e}"))?;

    let new_attempts = attempts + 1;

    if new_attempts >= MAX_RETRY_ATTEMPTS {
        // Max retries exhausted -- mark as permanently failed
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed', attempts = ?1, last_attempt = ?2,
                 error_message = ?3
             WHERE id = ?4",
            params![new_attempts, now, error_message, item_id],
        )
        .map_err(|e| format!("sync_queue mark_failed: {e}"))?;

        warn!(
            id = %item_id,
            attempts = new_attempts,
            "Sync queue item exhausted max retries, marked as failed"
        );
    } else {
        // Schedule retry with exponential backoff
        let new_delay = (retry_delay_ms * 2).min(MAX_RETRY_DELAY_MS);
        let next_retry = Utc::now() + ChronoDuration::milliseconds(new_delay);

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'pending', attempts = ?1, last_attempt = ?2,
                 error_message = ?3, retry_delay_ms = ?4,
                 next_retry_at = ?5
             WHERE id = ?6",
            params![
                new_attempts,
                now,
                error_message,
                new_delay,
                next_retry.to_rfc3339(),
                item_id,
            ],
        )
        .map_err(|e| format!("sync_queue schedule_retry: {e}"))?;
    }

    Ok(())
}

pub fn mark_deferred(conn: &Connection, item_id: &str, reason: &str) -> Result<(), String> {
    let next_retry = Utc::now() + ChronoDuration::seconds(5);
    conn.execute(
        "UPDATE parity_sync_queue
         SET status = 'pending',
             error_message = ?1,
             next_retry_at = ?2
         WHERE id = ?3",
        params![reason, next_retry.to_rfc3339(), item_id],
    )
    .map_err(|e| format!("sync_queue mark_deferred: {e}"))?;

    Ok(())
}

/// Mark an item as having a conflict.
pub fn mark_conflict(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE parity_sync_queue SET status = 'conflict' WHERE id = ?1",
        params![item_id],
    )
    .map_err(|e| format!("sync_queue mark_conflict: {e}"))?;

    Ok(())
}

/// Log a conflict to the audit trail.
pub fn log_conflict(
    conn: &Connection,
    operation_type: &str,
    entity_id: &str,
    entity_type: &str,
    local_version: i64,
    server_version: i64,
    discarded_payload: &str,
    resolution: &str,
    is_monetary: bool,
    reviewed: bool,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO conflict_audit_log
            (id, operation_type, entity_id, entity_type, local_version,
             server_version, timestamp, discarded_payload, resolution,
             is_monetary, reviewed_by_operator)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            operation_type,
            entity_id,
            entity_type,
            local_version,
            server_version,
            now,
            discarded_payload,
            resolution,
            is_monetary as i32,
            reviewed as i32,
        ],
    )
    .map_err(|e| format!("sync_queue log_conflict: {e}"))?;

    info!(
        id = %id,
        entity = %entity_id,
        entity_type = %entity_type,
        resolution = %resolution,
        is_monetary = is_monetary,
        "Logged conflict to audit trail"
    );

    Ok(id)
}

/// Check for items older than the age warning threshold and log warnings.
pub fn check_age_warnings(conn: &Connection) -> Result<Vec<String>, String> {
    let threshold = Utc::now() - ChronoDuration::milliseconds(AGE_WARNING_THRESHOLD_MS);
    let threshold_str = threshold.to_rfc3339();

    let mut stmt = conn
        .prepare(
            "SELECT id, table_name, record_id, created_at
             FROM parity_sync_queue
             WHERE created_at <= ?1",
        )
        .map_err(|e| format!("sync_queue age_warnings prepare: {e}"))?;

    let warnings: Vec<String> = stmt
        .query_map(params![threshold_str], |row| {
            let id: String = row.get(0)?;
            let table: String = row.get(1)?;
            let record: String = row.get(2)?;
            let created: String = row.get(3)?;
            Ok(format!(
                "Item {id} ({table}/{record}) enqueued at {created} exceeds age threshold"
            ))
        })
        .map_err(|e| format!("sync_queue age_warnings query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    for warning in &warnings {
        warn!("{}", warning);
    }

    Ok(warnings)
}

fn prepare_request(conn: &Connection, item: &SyncQueueItem) -> Result<RequestPreparation, String> {
    let payload =
        serde_json::from_str::<Value>(&item.data).unwrap_or_else(|_| Value::Object(Map::new()));
    let terminal_id = match resolve_request_terminal_id(conn, &payload) {
        Some(value) => value,
        None => {
            return Ok(RequestPreparation::Failed {
                reason: "Parity sync request is missing terminal_id context".to_string(),
            })
        }
    };

    match item.table_name.as_str() {
        "orders" => prepare_order_request(conn, item, &payload, terminal_id.as_str()),
        "payments" => prepare_payment_request(conn, item, &payload, terminal_id.as_str()),
        "payment_adjustments" => {
            prepare_adjustment_request(conn, item, &payload, terminal_id.as_str())
        }
        "driver_earnings" | "driver_earning" | "shift_expenses" | "staff_payments" => {
            prepare_financial_request(conn, item, &payload, terminal_id.as_str())
        }
        "housekeeping_tasks" => prepare_housekeeping_request(item, &payload, terminal_id.as_str()),
        _ => Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: resolve_endpoint(item),
            method: resolve_http_method(item),
            body: if resolve_http_method(item) == Method::DELETE {
                None
            } else {
                Some(item.data.clone())
            },
            terminal_id,
        })),
    }
}

fn prepare_order_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    if item.operation == "INSERT" {
        return Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: "/api/pos/orders".to_string(),
            method: Method::POST,
            body: Some(item.data.clone()),
            terminal_id: terminal_id.to_string(),
        }));
    }

    let remote_id: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(supabase_id, '')), '')
             FROM orders
             WHERE id = ?1",
            params![item.record_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_order_request remote id: {e}"))?
        .flatten();

    let Some(remote_id) = remote_id else {
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent order sync".to_string(),
        });
    };

    let mut status = string_field(payload, &["status"]).unwrap_or_default();
    if status.is_empty() {
        status = conn
            .query_row(
                "SELECT COALESCE(status, '') FROM orders WHERE id = ?1",
                params![item.record_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("sync_queue prepare_order_request status: {e}"))?
            .unwrap_or_default();
    }
    if status.trim().is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Order update payload is missing status".to_string(),
        });
    }

    let mut body = Map::new();
    body.insert("id".to_string(), Value::String(remote_id));
    body.insert("status".to_string(), Value::String(status));

    if let Some(value) = payload
        .get("estimatedTime")
        .or_else(|| payload.get("estimated_time"))
    {
        if !value.is_null() {
            body.insert("estimated_time".to_string(), value.clone());
        }
    }
    if let Some(value) = payload
        .get("notes")
        .or_else(|| payload.get("reason"))
        .or_else(|| payload.get("orderNotes"))
        .or_else(|| payload.get("order_notes"))
    {
        if !value.is_null() {
            body.insert("notes".to_string(), value.clone());
        }
    }
    for (camel, snake) in [
        ("totalAmount", "total_amount"),
        ("subtotal", "subtotal"),
        ("discountAmount", "discount_amount"),
        ("discountPercentage", "discount_percentage"),
        ("taxAmount", "tax_amount"),
        ("deliveryFee", "delivery_fee"),
        ("tipAmount", "tip_amount"),
        ("paymentStatus", "payment_status"),
        ("paymentMethod", "payment_method"),
    ] {
        if let Some(value) = payload.get(camel).or_else(|| payload.get(snake)) {
            if !value.is_null() {
                body.insert(snake.to_string(), value.clone());
            }
        }
    }
    if let Some(items) = payload.get("items") {
        if !items.is_null() {
            body.insert("items".to_string(), items.clone());
        }
    }
    if let Some(order_notes) = payload
        .get("orderNotes")
        .or_else(|| payload.get("order_notes"))
    {
        if !order_notes.is_null() {
            body.insert("order_notes".to_string(), order_notes.clone());
        }
    }

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/orders".to_string(),
        method: Method::PATCH,
        body: Some(Value::Object(body).to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_payment_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let local_order_id = string_field(payload, &["orderId", "order_id"]).unwrap_or_default();
    if local_order_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Payment sync payload is missing orderId".to_string(),
        });
    }

    let remote_order_id: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(supabase_id, '')), '')
             FROM orders
             WHERE id = ?1 OR supabase_id = ?1
             LIMIT 1",
            params![local_order_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_payment_request remote order: {e}"))?
        .flatten();

    let Some(remote_order_id) = remote_order_id else {
        let _ = conn.execute(
            "UPDATE order_payments
             SET sync_state = 'waiting_parent',
                 sync_status = 'pending',
                 updated_at = datetime('now')
             WHERE id = ?1",
            params![item.record_id.as_str()],
        );
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent order sync".to_string(),
        });
    };

    let amount = payload
        .get("amount")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    if amount <= 0.0 {
        return Ok(RequestPreparation::Failed {
            reason: "Payment sync payload has invalid amount".to_string(),
        });
    }
    let payment_method = string_field(payload, &["method", "paymentMethod", "payment_method"])
        .unwrap_or_else(|| "other".to_string());

    let mut body = serde_json::json!({
        "order_id": remote_order_id,
        "amount": amount,
        "payment_method": payment_method,
        "idempotency_key": format!("payment:{}", item.record_id),
        "metadata": {
            "terminal_id": terminal_id,
            "local_payment_id": item.record_id,
            "payment_origin": string_field(payload, &["paymentOrigin", "payment_origin"]),
        }
    });
    if let Some(value) = string_field(payload, &["transactionRef", "transaction_ref"]) {
        body["external_transaction_id"] = Value::String(value);
    }
    if let Some(value) = payload.get("tipAmount").and_then(Value::as_f64) {
        body["tip_amount"] = Value::from(value);
    }
    if let Some(value) = string_field(payload, &["currency"]) {
        body["currency"] = Value::String(value);
    }
    if let Some(items) = payload.get("items") {
        if items
            .as_array()
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        {
            body["items"] = items.clone();
        }
    }

    let _ = conn.execute(
        "UPDATE order_payments
         SET sync_state = 'syncing',
             updated_at = datetime('now')
         WHERE id = ?1",
        params![item.record_id.as_str()],
    );

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/payments".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_adjustment_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let payment_id = string_field(payload, &["paymentId", "payment_id"]).unwrap_or_default();
    if payment_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Adjustment sync payload is missing paymentId".to_string(),
        });
    }

    let payment_context: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT COALESCE(sync_state, ''), remote_payment_id, order_id
             FROM order_payments
             WHERE id = ?1",
            params![payment_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_adjustment_request payment context: {e}"))?;

    let Some((payment_sync_state, remote_payment_id, order_id)) = payment_context else {
        return Ok(RequestPreparation::Failed {
            reason: "Adjustment parent payment was not found locally".to_string(),
        });
    };

    let canonical_payment_id = remote_payment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if payment_sync_state != "applied" || canonical_payment_id.is_none() {
        let _ = conn.execute(
            "UPDATE payment_adjustments
             SET sync_state = 'waiting_parent',
                 sync_last_error = NULL,
                 updated_at = datetime('now')
             WHERE id = ?1",
            params![item.record_id.as_str()],
        );
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent payment sync".to_string(),
        });
    }

    let (_, branch_id, _) = resolve_runtime_context(conn, payload);
    let adjustment_type =
        string_field(payload, &["adjustmentType", "adjustment_type"]).unwrap_or_default();
    let order_id_for_sync =
        string_field(payload, &["orderId", "order_id"]).or_else(|| order_id.clone());
    let client_order_id_for_sync =
        string_field(payload, &["clientOrderId", "client_order_id"]).or_else(|| order_id.clone());
    let idempotency_key = format!("adjustment:{}", item.record_id);
    let body = sync::build_adjustment_sync_body(
        item.record_id.as_str(),
        payment_id.as_str(),
        order_id_for_sync.as_deref(),
        client_order_id_for_sync.as_deref(),
        if adjustment_type.is_empty() {
            None
        } else {
            Some(adjustment_type.as_str())
        },
        payload.get("amount").and_then(Value::as_f64),
        string_field(payload, &["reason"]).as_deref(),
        string_field(payload, &["staffId", "staff_id"]).as_deref(),
        string_field(payload, &["staffShiftId", "staff_shift_id"]).as_deref(),
        terminal_id,
        branch_id.as_str(),
        idempotency_key.as_str(),
        string_field(payload, &["refundMethod", "refund_method"]).as_deref(),
        string_field(payload, &["cashHandler", "cash_handler"]).as_deref(),
        string_field(payload, &["adjustmentContext", "adjustment_context"]).as_deref(),
        canonical_payment_id.as_deref(),
        canonical_payment_id.as_deref(),
    );

    let _ = conn.execute(
        "UPDATE payment_adjustments
         SET sync_state = 'syncing',
             updated_at = datetime('now')
         WHERE id = ?1",
        params![item.record_id.as_str()],
    );

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/payments/adjustments/sync".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn financial_entity_type(table_name: &str) -> &str {
    match table_name {
        "driver_earnings" => "driver_earning",
        "shift_expenses" => "shift_expense",
        "staff_payments" => "staff_payment",
        other => other,
    }
}

fn financial_operation(operation: &str) -> &str {
    match operation {
        "DELETE" => "delete",
        _ => "create",
    }
}

fn prepare_financial_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let (_, branch_id, _) = resolve_runtime_context(conn, payload);
    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "items": [{
            "entity_type": financial_entity_type(item.table_name.as_str()),
            "entity_id": item.record_id,
            "operation": financial_operation(item.operation.as_str()),
            "idempotency_key": format!("parity:{}", item.id),
            "payload": payload,
        }],
    });

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/financial/sync".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_housekeeping_request(
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let endpoint = if payload.get("status").is_some() {
        "/api/pos/housekeeping".to_string()
    } else {
        format!("/api/pos/housekeeping/{}", item.record_id)
    };

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint,
        method: Method::PATCH,
        body: Some(item.data.clone()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn extract_response_string(response: Option<&Value>, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = response?;
        let mut found = true;
        for segment in path.split('.') {
            current = match current.get(segment) {
                Some(value) => value,
                None => {
                    found = false;
                    break;
                }
            };
        }

        if found {
            if let Some(value) = current.as_str() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

fn apply_success(
    conn: &Connection,
    item: &SyncQueueItem,
    response: Option<&Value>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    match item.table_name.as_str() {
        "orders" => {
            if item.operation == "INSERT" {
                let remote_id = extract_response_string(
                    response,
                    &["data.id", "data.order_id", "order_id", "id"],
                );
                conn.execute(
                    "UPDATE orders
                     SET sync_status = 'synced',
                         last_synced_at = ?1,
                         supabase_id = COALESCE(NULLIF(supabase_id, ''), ?2),
                         updated_at = ?1
                     WHERE id = ?3",
                    params![now, remote_id, item.record_id.as_str()],
                )
                .map_err(|e| format!("sync_queue apply_success order insert: {e}"))?;
                sync::promote_payments_for_order(conn, item.record_id.as_str());
            } else {
                conn.execute(
                    "UPDATE orders
                     SET sync_status = 'synced',
                         last_synced_at = ?1,
                         updated_at = ?1
                     WHERE id = ?2",
                    params![now, item.record_id.as_str()],
                )
                .map_err(|e| format!("sync_queue apply_success order update: {e}"))?;
            }
        }
        "payments" => {
            let remote_payment_id =
                extract_response_string(response, &["payment_id", "id", "data.id"]);
            sync::mark_local_payment_applied(
                conn,
                item.record_id.as_str(),
                now.as_str(),
                remote_payment_id.as_deref(),
            )?;
        }
        "payment_adjustments" => {
            conn.execute(
                "UPDATE payment_adjustments
                 SET sync_state = 'applied',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
                params![now, item.record_id.as_str()],
            )
            .map_err(|e| format!("sync_queue apply_success adjustment: {e}"))?;

            let payload = serde_json::from_str::<Value>(&item.data)
                .unwrap_or_else(|_| Value::Object(Map::new()));
            let adjustment_type =
                string_field(&payload, &["adjustmentType", "adjustment_type"]).unwrap_or_default();
            if adjustment_type.eq_ignore_ascii_case("void") {
                if let Some(payment_id) = string_field(&payload, &["paymentId", "payment_id"]) {
                    let _ = conn.execute(
                        "UPDATE order_payments
                         SET sync_status = 'synced',
                             sync_retry_count = 0,
                             sync_last_error = NULL,
                             sync_next_retry_at = NULL,
                             updated_at = ?1
                         WHERE id = ?2",
                        params![now, payment_id],
                    );
                }
            }
        }
        "driver_earnings" | "driver_earning" => {
            if item.operation != "DELETE" {
                let remote_id = response
                    .and_then(|value| value.get("results"))
                    .and_then(Value::as_array)
                    .and_then(|rows| rows.first())
                    .and_then(|result| {
                        result
                            .get("server_id")
                            .or_else(|| result.get("supabase_id"))
                            .and_then(Value::as_str)
                    })
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| item.record_id.clone());
                let _ = conn.execute(
                    "UPDATE driver_earnings
                     SET supabase_id = ?1,
                         updated_at = ?2
                     WHERE id = ?3",
                    params![remote_id, now, item.record_id.as_str()],
                );
            }
        }
        _ => {}
    }

    Ok(())
}

/// Process all pending items in the queue by sending them to the admin API.
///
/// Items are processed FIFO within priority bands. On success, items are
/// removed. On transient failure (5xx / network), items are rescheduled
/// with exponential backoff. On conflict (409), items are marked as
/// `conflict`. On client error (4xx != 409), items are marked as `failed`.
pub async fn process_queue(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
) -> Result<SyncResult, String> {
    // Check for age warnings before processing
    {
        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
        let _ = check_age_warnings(&db);
    }

    let client = reqwest::Client::new();
    let mut processed: i64 = 0;
    let mut failed: i64 = 0;
    let mut conflicts: i64 = 0;
    let mut errors: Vec<SyncError> = Vec::new();

    loop {
        // Dequeue next item under lock, then release lock before HTTP call
        let item = {
            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
            dequeue(&db)?
        };

        let item = match item {
            Some(i) => i,
            None => break,
        };

        let request_spec = {
            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
            prepare_request(&db, &item)?
        };

        let request_spec = match request_spec {
            RequestPreparation::Ready(spec) => spec,
            RequestPreparation::Deferred { reason } => {
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                mark_deferred(&db, &item.id, &reason)?;
                continue;
            }
            RequestPreparation::Failed { reason } => {
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                mark_failure(&db, &item.id, &reason)?;
                db.execute(
                    "UPDATE parity_sync_queue SET status = 'failed' WHERE id = ?1",
                    params![item.id],
                )
                .map_err(|e| format!("mark parity item permanently failed: {e}"))?;
                failed += 1;
                errors.push(SyncError {
                    item_id: item.id.clone(),
                    table_name: item.table_name.clone(),
                    record_id: item.record_id.clone(),
                    error: reason,
                    http_status: None,
                });
                continue;
            }
        };

        let url = format!(
            "{}{}",
            api_base_url.trim_end_matches('/'),
            request_spec.endpoint
        );

        let mut request = client
            .request(request_spec.method.clone(), &url)
            .header("x-pos-api-key", api_key)
            .header("x-terminal-id", request_spec.terminal_id.as_str())
            .header("Content-Type", "application/json");

        if let Some(body) = request_spec.body.as_ref() {
            request = request.body(body.clone());
        }

        let response = request.send().await;

        match response {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let is_success = resp.status().is_success();
                let response_body = resp.text().await.unwrap_or_default();
                let response_json = serde_json::from_str::<Value>(&response_body).ok();
                if is_success {
                    // Success -- remove from queue
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    apply_success(&db, &item, response_json.as_ref())?;
                    mark_success(&db, &item.id)?;
                    processed += 1;
                } else if status == 409 {
                    let server_record = fetch_server_record(
                        &client,
                        api_base_url,
                        api_key,
                        request_spec.terminal_id.as_str(),
                        &item,
                    )
                    .await;
                    let server_version =
                        derive_server_version(server_record.as_ref(), &response_body, item.version);
                    let is_monetary = is_monetary_item(&item);
                    let resolution = match item.conflict_strategy.as_str() {
                        "manual" => "manual",
                        "client-wins" => "client-wins",
                        _ if is_monetary => "server-wins",
                        _ => "auto-server-wins",
                    };
                    let requires_operator_review =
                        resolution == "manual" || resolution == "client-wins" || is_monetary;

                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    log_conflict(
                        &db,
                        &item.operation,
                        &item.record_id,
                        &item.table_name,
                        item.version,
                        server_version,
                        &item.data,
                        resolution,
                        is_monetary,
                        false,
                    )?;

                    if requires_operator_review {
                        mark_conflict(&db, &item.id)?;
                        conflicts += 1;
                        errors.push(SyncError {
                            item_id: item.id.clone(),
                            table_name: item.table_name.clone(),
                            record_id: item.record_id.clone(),
                            error: format!(
                                "Conflict detected (HTTP 409) requiring review: {}",
                                resolution
                            ),
                            http_status: Some(status),
                        });
                    } else {
                        mark_success(&db, &item.id)?;
                        processed += 1;
                    }
                } else if status >= 400 && status < 500 {
                    // Client error (not retriable)
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    mark_failure(&db, &item.id, &format!("HTTP {status}: {response_body}"))?;
                    // Force to failed status since client errors won't recover
                    db.execute(
                        "UPDATE parity_sync_queue SET status = 'failed' WHERE id = ?1",
                        params![item.id],
                    )
                    .map_err(|e| format!("mark client error failed: {e}"))?;
                    failed += 1;
                    errors.push(SyncError {
                        item_id: item.id.clone(),
                        table_name: item.table_name.clone(),
                        record_id: item.record_id.clone(),
                        error: format!("HTTP {status}: {response_body}"),
                        http_status: Some(status),
                    });
                } else {
                    // Server error (retriable)
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    mark_failure(&db, &item.id, &format!("HTTP {status}: {response_body}"))?;
                    failed += 1;
                    errors.push(SyncError {
                        item_id: item.id.clone(),
                        table_name: item.table_name.clone(),
                        record_id: item.record_id.clone(),
                        error: format!("HTTP {status}: {response_body}"),
                        http_status: Some(status),
                    });
                }
            }
            Err(e) => {
                // Network error (retriable)
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                mark_failure(&db, &item.id, &format!("Network error: {e}"))?;
                failed += 1;
                errors.push(SyncError {
                    item_id: item.id.clone(),
                    table_name: item.table_name.clone(),
                    record_id: item.record_id.clone(),
                    error: format!("Network error: {e}"),
                    http_status: None,
                });
            }
        }
    }

    let success = failed == 0 && conflicts == 0;

    Ok(SyncResult {
        success,
        processed,
        failed,
        conflicts,
        errors,
    })
}

/// Map a queue item's module type to the appropriate admin API endpoint.
fn resolve_endpoint(item: &SyncQueueItem) -> String {
    if matches!(item.table_name.as_str(), "payments" | "payment_adjustments") {
        return resolve_financial_endpoint(item);
    }

    if let Some(endpoint) = resolve_special_entity_endpoint(item) {
        return endpoint;
    }

    match item.module_type.as_str() {
        "orders" => resolve_orders_endpoint(item),
        "customers" => resolve_customers_endpoint(item),
        "shifts" => "/api/pos/shifts/sync".to_string(),
        "financial" => "/api/pos/financial/sync".to_string(),
        "z_report" => "/api/pos/z-report/submit".to_string(),
        "loyalty" => "/api/pos/loyalty/sync".to_string(),
        _ => resolve_generic_endpoint(item),
    }
}

fn resolve_special_entity_endpoint(item: &SyncQueueItem) -> Option<String> {
    match item.table_name.as_str() {
        "inventory_adjustments" => Some("/api/pos/inventory".to_string()),
        "coupons" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/coupons".to_string(),
            _ => format!("/api/pos/coupons/{}", item.record_id),
        }),
        "menu_categories" => Some(format!("/api/pos/sync/menu_categories/{}", item.record_id)),
        "menu_subcategories" => Some(format!("/api/pos/sync/subcategories/{}", item.record_id)),
        "menu_ingredients" => Some(format!("/api/pos/sync/ingredients/{}", item.record_id)),
        "menu_combos" => Some(format!("/api/menu/combos/{}", item.record_id)),
        "reservations" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/reservations".to_string(),
            _ => format!("/api/pos/reservations/{}", item.record_id),
        }),
        "appointments" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/appointments".to_string(),
            _ => format!("/api/pos/appointments/{}/status", item.record_id),
        }),
        "salon_staff_shifts" => Some("/api/pos/staff-schedule".to_string()),
        "drive_thru_orders" => Some("/api/pos/drive-through".to_string()),
        "rooms" => Some(format!("/api/pos/rooms/{}", item.record_id)),
        "products" => Some(format!("/api/pos/products/{}", item.record_id)),
        _ => None,
    }
}

fn resolve_http_method(item: &SyncQueueItem) -> Method {
    match item.operation.as_str() {
        "UPDATE" => Method::PATCH,
        "DELETE" => Method::DELETE,
        _ => Method::POST,
    }
}

fn resolve_orders_endpoint(item: &SyncQueueItem) -> String {
    match item.operation.as_str() {
        "INSERT" => "/api/pos/orders".to_string(),
        _ => "/api/pos/orders".to_string(),
    }
}

fn resolve_financial_endpoint(item: &SyncQueueItem) -> String {
    match item.table_name.as_str() {
        "payments" => "/api/pos/payments".to_string(),
        "payment_adjustments" => "/api/pos/payments/adjustments/sync".to_string(),
        "driver_earnings" | "driver_earning" | "shift_expenses" | "staff_payments" => {
            "/api/pos/financial/sync".to_string()
        }
        _ => "/api/pos/financial/sync".to_string(),
    }
}

fn extract_customer_id_from_sync_payload(item: &SyncQueueItem) -> Option<String> {
    serde_json::from_str::<Value>(&item.data)
        .ok()
        .and_then(|payload| {
            payload
                .get("customer_id")
                .or_else(|| payload.get("customerId"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

fn resolve_customers_endpoint(item: &SyncQueueItem) -> String {
    match item.table_name.as_str() {
        "customers" => match item.operation.as_str() {
            "INSERT" => "/api/pos/customers".to_string(),
            _ => format!("/api/pos/customers/{}", item.record_id),
        },
        "customer_addresses" => {
            if let Some(customer_id) = extract_customer_id_from_sync_payload(item) {
                match item.operation.as_str() {
                    "INSERT" => format!("/api/pos/customers/{customer_id}/addresses"),
                    _ => format!(
                        "/api/pos/customers/{customer_id}/addresses/{}",
                        item.record_id
                    ),
                }
            } else {
                resolve_generic_endpoint(item)
            }
        }
        _ => resolve_generic_endpoint(item),
    }
}

fn resolve_generic_endpoint(item: &SyncQueueItem) -> String {
    match item.operation.as_str() {
        "UPDATE" | "DELETE" => format!("/api/pos/sync/{}/{}", item.table_name, item.record_id),
        _ => format!("/api/pos/sync/{}", item.table_name),
    }
}

fn is_monetary_item(item: &SyncQueueItem) -> bool {
    let monetary_tables = [
        "payments",
        "payment_adjustments",
        "payment_transactions",
        "refund_transactions",
        "driver_earnings",
        "driver_earning",
    ];
    if monetary_tables.contains(&item.table_name.as_str()) {
        return true;
    }

    let monetary_fields = [
        "total",
        "subtotal",
        "tax",
        "discount_amount",
        "payment_amount",
        "refund_amount",
        "amount",
        "price",
        "unit_price",
        "order_total",
        "grand_total",
        "tip",
        "tip_amount",
    ];

    serde_json::from_str::<Value>(&item.data)
        .ok()
        .and_then(|payload| payload.as_object().cloned())
        .map(|payload| {
            payload
                .keys()
                .any(|key| monetary_fields.contains(&key.as_str()))
        })
        .unwrap_or(false)
}

async fn fetch_server_record(
    client: &reqwest::Client,
    api_base_url: &str,
    api_key: &str,
    terminal_id: &str,
    item: &SyncQueueItem,
) -> Option<Value> {
    let endpoint = format!(
        "{}/api/pos/sync/{}/{}",
        api_base_url.trim_end_matches('/'),
        item.table_name,
        item.record_id
    );

    let response = client
        .get(&endpoint)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", terminal_id)
        .header("Content-Type", "application/json")
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.json::<Value>().await.ok()?;
    body.get("data").cloned().or(Some(body))
}

fn derive_server_version(
    server_record: Option<&Value>,
    conflict_body: &str,
    local_version: i64,
) -> i64 {
    let read_version = |value: &Value| -> Option<i64> {
        value
            .get("version")
            .and_then(|candidate| candidate.as_i64())
            .or_else(|| {
                value
                    .get("server_version")
                    .and_then(|candidate| candidate.as_i64())
            })
            .or_else(|| {
                value
                    .get("row_version")
                    .and_then(|candidate| candidate.as_i64())
            })
    };

    if let Some(record) = server_record {
        if let Some(version) = read_version(record) {
            return version;
        }
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(conflict_body) {
        if let Some(version) = read_version(&parsed) {
            return version;
        }
    }

    local_version + 1
}

// ---------------------------------------------------------------------------
// Use rusqlite::OptionalExtension for query_row returning Option
// ---------------------------------------------------------------------------
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    fn clear_terminal_identity() {
        let _ = crate::storage::delete_credential("terminal_id");
    }

    fn queue_item(
        table_name: &str,
        operation: &str,
        record_id: &str,
        data: Value,
    ) -> SyncQueueItem {
        SyncQueueItem {
            id: "queue-1".to_string(),
            table_name: table_name.to_string(),
            record_id: record_id.to_string(),
            operation: operation.to_string(),
            data: data.to_string(),
            organization_id: "org-1".to_string(),
            created_at: Utc::now().to_rfc3339(),
            attempts: 0,
            last_attempt: None,
            error_message: None,
            next_retry_at: None,
            retry_delay_ms: 1000,
            priority: 0,
            module_type: "customers".to_string(),
            conflict_strategy: "manual".to_string(),
            version: 1,
            status: "pending".to_string(),
        }
    }

    #[derive(Debug)]
    struct CapturedRequest {
        request_line: String,
        headers: HashMap<String, String>,
        body: String,
    }

    #[derive(Debug, Clone)]
    struct MockResponse {
        status_code: u16,
        body: String,
    }

    impl MockResponse {
        fn json(status_code: u16, body: impl Into<String>) -> Self {
            Self {
                status_code,
                body: body.into(),
            }
        }
    }

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        create_tables(&conn).expect("create sync queue tables");
        conn
    }

    fn enqueue_test_item(
        conn: &Connection,
        table_name: &str,
        operation: &str,
        record_id: &str,
        data: Value,
    ) -> String {
        enqueue(
            conn,
            &EnqueueInput {
                table_name: table_name.to_string(),
                record_id: record_id.to_string(),
                operation: operation.to_string(),
                data: data.to_string(),
                organization_id: "org-1".to_string(),
                priority: None,
                module_type: Some("customers".to_string()),
                conflict_strategy: Some("manual".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue test item")
    }

    async fn spawn_mock_http_server(
        responses: Vec<MockResponse>,
    ) -> (
        String,
        mpsc::UnboundedReceiver<CapturedRequest>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let captured = read_http_request(&mut stream).await;
                tx.send(captured).expect("send captured request");
                write_http_response(&mut stream, &response)
                    .await
                    .expect("write mock response");
            }
        });

        (format!("http://{}", address), rx, handle)
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> CapturedRequest {
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 4096];
        let mut header_end = None;
        let mut content_length = 0_usize;

        loop {
            let read = stream.read(&mut chunk).await.expect("read request");
            assert!(read > 0, "request closed before mock server read completed");
            buffer.extend_from_slice(&chunk[..read]);

            if header_end.is_none() {
                header_end = find_bytes(&buffer, b"\r\n\r\n");
                if let Some(index) = header_end {
                    let headers_text = String::from_utf8_lossy(&buffer[..index + 4]).to_string();
                    content_length = parse_content_length(&headers_text);
                }
            }

            if let Some(index) = header_end {
                let total_length = index + 4 + content_length;
                if buffer.len() >= total_length {
                    let request_text =
                        String::from_utf8(buffer[..total_length].to_vec()).expect("utf8 request");
                    return parse_request_text(&request_text);
                }
            }
        }
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn parse_content_length(headers_text: &str) -> usize {
        headers_text
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0)
    }

    fn parse_request_text(request_text: &str) -> CapturedRequest {
        let mut sections = request_text.splitn(2, "\r\n\r\n");
        let header_block = sections.next().unwrap_or_default();
        let body = sections.next().unwrap_or_default().to_string();
        let mut header_lines = header_block.lines();
        let request_line = header_lines.next().unwrap_or_default().to_string();
        let headers = header_lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect::<HashMap<_, _>>();

        CapturedRequest {
            request_line,
            headers,
            body,
        }
    }

    async fn write_http_response(
        stream: &mut tokio::net::TcpStream,
        response: &MockResponse,
    ) -> Result<(), std::io::Error> {
        let reason = match response.status_code {
            200 => "OK",
            401 => "Unauthorized",
            409 => "Conflict",
            _ => "OK",
        };
        let response_text = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response.status_code,
            reason,
            response.body.len(),
            response.body
        );
        stream.write_all(response_text.as_bytes()).await?;
        stream.flush().await
    }

    #[test]
    fn resolve_customers_endpoint_uses_customer_routes() {
        let insert_customer = queue_item(
            "customers",
            "INSERT",
            "cust-1",
            serde_json::json!({ "name": "Ada", "phone": "1234" }),
        );
        let update_customer = queue_item(
            "customers",
            "UPDATE",
            "cust-1",
            serde_json::json!({ "name": "Ada Lovelace" }),
        );
        let insert_address = queue_item(
            "customer_addresses",
            "INSERT",
            "addr-1",
            serde_json::json!({
                "customer_id": "cust-1",
                "street_address": "Main St 42"
            }),
        );
        let update_address = queue_item(
            "customer_addresses",
            "UPDATE",
            "addr-1",
            serde_json::json!({
                "customer_id": "cust-1",
                "notes": "Ring once"
            }),
        );

        assert_eq!(resolve_endpoint(&insert_customer), "/api/pos/customers");
        assert_eq!(
            resolve_endpoint(&update_customer),
            "/api/pos/customers/cust-1"
        );
        assert_eq!(
            resolve_endpoint(&insert_address),
            "/api/pos/customers/cust-1/addresses"
        );
        assert_eq!(
            resolve_endpoint(&update_address),
            "/api/pos/customers/cust-1/addresses/addr-1"
        );
    }

    #[test]
    fn resolve_customers_endpoint_falls_back_when_customer_id_missing() {
        let address_item = queue_item(
            "customer_addresses",
            "UPDATE",
            "addr-1",
            serde_json::json!({ "notes": "Ring once" }),
        );

        assert_eq!(
            resolve_endpoint(&address_item),
            "/api/pos/sync/customer_addresses/addr-1"
        );
    }

    #[test]
    fn resolve_financial_endpoints_use_live_pos_routes() {
        let mut payment_item = queue_item(
            "payments",
            "INSERT",
            "payment-1",
            serde_json::json!({ "paymentId": "payment-1" }),
        );
        payment_item.module_type = "financial".to_string();

        let mut adjustment_item = queue_item(
            "payment_adjustments",
            "INSERT",
            "adj-1",
            serde_json::json!({ "adjustmentId": "adj-1" }),
        );
        adjustment_item.module_type = "financial".to_string();

        let mut driver_item = queue_item(
            "driver_earnings",
            "INSERT",
            "earning-1",
            serde_json::json!({ "id": "earning-1" }),
        );
        driver_item.module_type = "financial".to_string();

        assert_eq!(resolve_endpoint(&payment_item), "/api/pos/payments");
        assert_eq!(
            resolve_endpoint(&adjustment_item),
            "/api/pos/payments/adjustments/sync"
        );
        assert_eq!(resolve_endpoint(&driver_item), "/api/pos/financial/sync");
    }

    #[test]
    fn resolve_special_entity_endpoints_use_live_routes() {
        let inventory_item = queue_item(
            "inventory_adjustments",
            "INSERT",
            "prod-1",
            serde_json::json!({ "product_id": "prod-1", "adjustment": 5 }),
        );
        let coupon_insert = queue_item(
            "coupons",
            "INSERT",
            "coupon-1",
            serde_json::json!({ "id": "coupon-1", "code": "SAVE10" }),
        );
        let coupon_update = queue_item(
            "coupons",
            "UPDATE",
            "coupon-1",
            serde_json::json!({ "id": "coupon-1", "is_active": false }),
        );
        let reservation_item = queue_item(
            "reservations",
            "UPDATE",
            "reservation-1",
            serde_json::json!({ "status": "confirmed" }),
        );
        let appointment_item = queue_item(
            "appointments",
            "UPDATE",
            "appointment-1",
            serde_json::json!({ "status": "completed" }),
        );
        let staff_shift_item = queue_item(
            "salon_staff_shifts",
            "INSERT",
            "shift-1",
            serde_json::json!({ "staff_id": "staff-1" }),
        );
        let drive_thru_item = queue_item(
            "drive_thru_orders",
            "UPDATE",
            "dto-1",
            serde_json::json!({ "status": "serving" }),
        );
        let room_item = queue_item(
            "rooms",
            "UPDATE",
            "room-101",
            serde_json::json!({ "status": "occupied" }),
        );
        let product_item = queue_item(
            "products",
            "UPDATE",
            "product-1",
            serde_json::json!({ "quantity": 9 }),
        );

        assert_eq!(resolve_endpoint(&inventory_item), "/api/pos/inventory");
        assert_eq!(resolve_endpoint(&coupon_insert), "/api/pos/coupons");
        assert_eq!(
            resolve_endpoint(&coupon_update),
            "/api/pos/coupons/coupon-1"
        );
        assert_eq!(
            resolve_endpoint(&reservation_item),
            "/api/pos/reservations/reservation-1"
        );
        assert_eq!(
            resolve_endpoint(&appointment_item),
            "/api/pos/appointments/appointment-1/status"
        );
        assert_eq!(
            resolve_endpoint(&staff_shift_item),
            "/api/pos/staff-schedule"
        );
        assert_eq!(resolve_endpoint(&drive_thru_item), "/api/pos/drive-through");
        assert_eq!(resolve_endpoint(&room_item), "/api/pos/rooms/room-101");
        assert_eq!(
            resolve_endpoint(&product_item),
            "/api/pos/products/product-1"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_sends_terminal_id_header_on_parity_requests() {
        clear_terminal_identity();
        let conn = test_connection();
        crate::storage::set_credential("terminal_id", "terminal-test")
            .expect("seed terminal credential");
        crate::db::set_setting(&conn, "terminal", "terminal_id", "terminal-test")
            .expect("store terminal id");
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) =
            spawn_mock_http_server(vec![MockResponse::json(200, r#"{"success":true}"#)]).await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests.recv().await.expect("captured parity request");
        assert_eq!(request.request_line, "POST /api/pos/customers HTTP/1.1");
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );
        assert_eq!(
            request.headers.get("x-pos-api-key").map(String::as_str),
            Some("api-key")
        );
        assert!(
            request.body.contains("\"name\":\"Ada Lovelace\""),
            "request body should preserve the queued payload"
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    async fn fetch_server_record_sends_terminal_id_header() {
        let item = queue_item(
            "customers",
            "UPDATE",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let client = reqwest::Client::new();
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            200,
            r#"{"data":{"id":"cust-remote-1"}}"#,
        )])
        .await;

        let server_record =
            fetch_server_record(&client, &base_url, "api-key", "terminal-test", &item).await;

        assert_eq!(
            server_record
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str),
            Some("cust-remote-1")
        );

        let request = requests.recv().await.expect("captured fetch request");
        assert_eq!(
            request.request_line,
            "GET /api/pos/sync/customers/cust-1 HTTP/1.1"
        );
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );
        assert_eq!(
            request.headers.get("x-pos-api-key").map(String::as_str),
            Some("api-key")
        );

        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_marks_items_failed_when_terminal_context_is_missing() {
        clear_terminal_identity();
        let conn = test_connection();
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let conn = std::sync::Mutex::new(conn);

        let result = process_queue(&conn, "http://127.0.0.1:9", "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 1);
        assert!(result.errors.iter().any(|error| {
            error
                .error
                .contains("Parity sync request is missing terminal_id context")
        }));

        let (status, error_message): (String, Option<String>) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, error_message FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read failed queue item");
        assert_eq!(status, "failed");
        assert_eq!(
            error_message.as_deref(),
            Some("Parity sync request is missing terminal_id context")
        );

        clear_terminal_identity();
    }
}
