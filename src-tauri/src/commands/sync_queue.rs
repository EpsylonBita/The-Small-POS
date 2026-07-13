//! IPC command handlers for the parity sync queue.
//!
//! These commands wrap the `sync_queue` module's SQLite operations and expose
//! them to the renderer via `@tauri-apps/api/core::invoke()`.

use tauri::{Emitter, State};
use zeroize::Zeroizing;

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
    sync_queue::dequeue(&conn)
}

/// Peek at the next item without removing or changing its status.
#[tauri::command]
pub fn sync_queue_peek(
    db: State<'_, DbState>,
) -> Result<Option<sync_queue::SyncQueueItem>, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::peek(&conn)
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
    sync_queue::clear(&conn).map_err(Into::into)
}

/// Get the current number of items in the sync queue.
#[tauri::command]
pub fn sync_queue_length(db: State<'_, DbState>) -> Result<i64, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::get_length(&conn)
}

/// Get detailed queue status (total, pending, failed, conflicts, oldest age).
#[tauri::command]
pub fn sync_queue_status(db: State<'_, DbState>) -> Result<sync_queue::QueueStatus, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::get_status(&conn)
}

/// List actionable parity queue items, optionally filtered by module.
#[tauri::command]
pub fn sync_queue_list_items(
    db: State<'_, DbState>,
    query: Option<sync_queue::QueueListQuery>,
) -> Result<Vec<sync_queue::SyncQueueItem>, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::list_actionable_items(&conn, &query.unwrap_or_default())
}

/// Retry a single parity queue item immediately.
#[tauri::command]
pub fn sync_queue_retry_item(db: State<'_, DbState>, item_id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::retry_item(&conn, item_id.as_str())
}

/// Retry all actionable parity queue items for a module.
#[tauri::command]
pub fn sync_queue_retry_module(
    db: State<'_, DbState>,
    module_type: String,
) -> Result<sync_queue::RetryItemsResult, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::retry_items_by_module(&conn, module_type.as_str())
}

/// List conflict audit records produced by parity queue processing.
#[tauri::command]
pub fn sync_queue_list_conflicts(
    db: State<'_, DbState>,
    limit: Option<i64>,
) -> Result<Vec<sync_queue::ConflictAuditEntry>, String> {
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    sync_queue::list_conflict_audit_entries(&conn, limit.unwrap_or(100))
}

/// Process all pending items in the queue by syncing them to the admin API.
///
/// Items are sent FIFO within priority bands. On success, items are removed.
/// On failure, items are rescheduled with exponential backoff.
#[tauri::command]
pub async fn sync_queue_process(
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<sync_queue::SyncResult, String> {
    let (api_base_url, api_key) = resolve_sync_queue_credentials(&db)?;
    let result = sync_queue::process_queue(&db.conn, &api_base_url, &api_key).await?;

    // Wave 4 H: emit an operator-visible alarm for every monetary
    // dead-letter in this batch. The renderer UI subscribes to this
    // event and surfaces a persistent banner + admin-dashboard row;
    // without it, a dead-lettered payment is effectively invisible
    // outside the logs.
    for dl in &result.monetary_dead_letters {
        let _ = app.emit("sync:dead-letter:monetary", dl);
    }

    Ok(result)
}

fn resolve_sync_queue_credentials(db: &DbState) -> Result<(String, Zeroizing<String>), String> {
    crate::hydrate_terminal_credentials_from_local_settings(db);

    let mut raw_api_key = Zeroizing::new(
        crate::storage::get_credential("pos_api_key")
            .or_else(|| crate::read_local_setting(db, "terminal", "pos_api_key"))
            .or_else(|| crate::read_local_setting(db, "terminal", "api_key"))
            .ok_or_else(|| "Terminal not configured: missing API key".to_string())?,
    );
    let api_key_source = raw_api_key.clone();

    if let Some(decoded_api_key) =
        crate::api::extract_api_key_from_connection_string(&api_key_source)
    {
        if *decoded_api_key != **raw_api_key {
            let _ = crate::storage::set_credential("pos_api_key", decoded_api_key.trim());
            if let Ok(conn) = db.conn.lock() {
                let _ = crate::db::set_setting(
                    &conn,
                    "terminal",
                    "pos_api_key",
                    decoded_api_key.trim(),
                );
            }
            *raw_api_key = decoded_api_key;
        }
    }

    if let Some(decoded_tid) =
        crate::api::extract_terminal_id_from_connection_string(&api_key_source)
    {
        let _ = crate::storage::set_credential("terminal_id", decoded_tid.trim());
        if let Ok(conn) = db.conn.lock() {
            let _ = crate::db::set_setting(&conn, "terminal", "terminal_id", decoded_tid.trim());
        }
    }

    let mut admin_url = crate::storage::get_credential("admin_dashboard_url")
        .or_else(|| crate::read_local_setting(db, "terminal", "admin_dashboard_url"))
        .or_else(|| crate::read_local_setting(db, "terminal", "admin_url"))
        .unwrap_or_default();
    if admin_url.trim().is_empty() {
        if let Some(decoded_url) =
            crate::api::extract_admin_url_from_connection_string(&api_key_source)
        {
            admin_url = decoded_url;
        }
    }
    let normalized_admin_url = crate::api::normalize_admin_url(&admin_url);
    if normalized_admin_url.trim().is_empty() {
        return Err("Terminal not configured: missing admin URL".to_string());
    }

    let api_key = Zeroizing::new(raw_api_key.trim().to_string());
    if api_key.is_empty() {
        return Err("Terminal not configured: missing API key".to_string());
    }

    Ok((normalized_admin_url, api_key))
}
