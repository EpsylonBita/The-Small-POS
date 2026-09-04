//! IPC command handlers for the parity sync queue.
//!
//! These commands wrap the `sync_queue` module's SQLite operations and expose
//! them to the renderer via `@tauri-apps/api/core::invoke()`.

use tauri::State;

use crate::db::DbState;
use crate::sync_queue;

/// Enqueue a new item into the offline sync queue.
///
/// Returns the generated UUID for the item.
#[tauri::command]
pub fn sync_queue_enqueue(
    db: State<'_, DbState>,
    item: sync_queue::EnqueueInput,
) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::enqueue(&conn, &item)
}

/// Dequeue the next item to process (highest priority, oldest first).
///
/// Marks the item as `processing` so it won't be dequeued again.
/// Returns `null` if no items are ready.
#[tauri::command]
pub fn sync_queue_dequeue(
    db: State<'_, DbState>,
) -> Result<Option<sync_queue::SyncQueueItem>, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_dequeue(&conn)
}

/// Peek at the next item without removing or changing its status.
#[tauri::command]
pub fn sync_queue_peek(
    db: State<'_, DbState>,
) -> Result<Option<sync_queue::SyncQueueItem>, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_peek(&conn)
}

/// Remove all items from the sync queue (the canonical parity outbox).
///
/// Gap review 2026-07-10 P0: this wipes every pending/failed offline order,
/// payment, and adjustment awaiting push to the Admin API. Like the sibling
/// full-wipe commands it must require SystemControl and snapshot first — the
/// webview is the trust boundary.
#[tauri::command]
pub fn sync_queue_clear(
    db: State<'_, DbState>,
    auth_state: State<'_, crate::auth::AuthState>,
) -> Result<(), crate::auth::GuardedCommandError> {
    crate::auth::authorize_privileged_action(
        crate::auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    crate::recovery::snapshot_before_destructive_action(
        &db,
        crate::recovery::RecoveryPointKind::PreClearOperationalData,
    )?;
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_clear(&conn).map_err(Into::into)
}

/// Get the current number of items in the sync queue.
#[tauri::command]
pub fn sync_queue_length(db: State<'_, DbState>) -> Result<i64, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_get_length(&conn)
}

/// Get detailed queue status (total, pending, failed, conflicts, oldest age).
#[tauri::command]
pub fn sync_queue_status(db: State<'_, DbState>) -> Result<sync_queue::QueueStatus, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_get_status(&conn)
}

/// List actionable parity queue items, optionally filtered by module.
#[tauri::command]
pub fn sync_queue_list_items(
    db: State<'_, DbState>,
    query: Option<sync_queue::QueueListQuery>,
) -> Result<Vec<sync_queue::SyncQueueItem>, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_list_actionable_items(&conn, &query.unwrap_or_default())
}

/// Retry a single parity queue item immediately.
#[tauri::command]
pub fn sync_queue_retry_item(db: State<'_, DbState>, item_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_retry_item(&conn, item_id.as_str())
}

/// Retry all actionable parity queue items for a module.
#[tauri::command]
pub fn sync_queue_retry_module(
    db: State<'_, DbState>,
    module_type: String,
) -> Result<sync_queue::RetryItemsResult, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_retry_items_by_module(&conn, module_type.as_str())
}

/// List conflict audit records produced by parity queue processing.
#[tauri::command]
pub fn sync_queue_list_conflicts(
    db: State<'_, DbState>,
    limit: Option<i64>,
) -> Result<Vec<sync_queue::ConflictAuditEntry>, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::renderer_list_conflict_audit_entries(&conn, limit.unwrap_or(100))
}

/// Process all pending items in the queue by syncing them to the admin API.
///
/// Items are sent FIFO within priority bands. On success, items are removed.
/// On failure, items are rescheduled with exponential backoff.
#[tauri::command]
pub async fn sync_queue_process(
    db: State<'_, DbState>,
    sync_state: State<'_, std::sync::Arc<crate::sync::SyncState>>,
    cancellation: State<'_, tokio_util::sync::CancellationToken>,
    app: tauri::AppHandle,
) -> Result<sync_queue::SyncResult, String> {
    crate::sync::process_renderer_parity_queue_guarded(
        &db,
        sync_state.inner().as_ref(),
        &app,
        cancellation.inner(),
        "sync_queue_process",
    )
    .await
}
