//! IPC command handlers for the parity sync queue.
//!
//! These commands wrap the `sync_queue` module's SQLite operations and expose
//! them to the renderer via `@tauri-apps/api/core::invoke()`.
//!
//! The ones with a synchronous body run it on Tokio's blocking pool
//! (`run_blocking_command`): Tauri 2 would run a plain `fn` on the window
//! thread, where a wait for the connection froze the till (Tomikro 20/10/2026,
//! see `database_lock.rs`), and a `fn` marked `(async)` on a runtime worker,
//! where such waits stall the runtime. Ordering does not rely on any thread:
//! each call is atomic under the connection mutex, and the renderer awaits
//! each enqueue before the next.

use tauri::{Manager, State};

use crate::database_lock::run_blocking_command;
use crate::db::DbState;
use crate::sync_queue;

#[tauri::command]
pub async fn order_notice_editing(
    window: tauri::WebviewWindow,
    arg0: serde_json::Value,
) -> Result<(), String> {
    let label = window.label().to_string();
    run_blocking_command("order_notice_editing", move || {
        let session = arg0["session"].as_str().ok_or("ORDER_EDIT_LEASE_INVALID")?;
        let ids: Vec<String> = serde_json::from_value(arg0["orderIds"].clone())
            .map_err(|_| "ORDER_EDIT_LEASE_INVALID")?;
        crate::order_notice_auto::set_editing(format!("{label}:{session}"), ids)
    })
    .await
}

#[tauri::command]
pub async fn order_notice_employee_attempt(
    app: tauri::AppHandle,
    arg0: serde_json::Value,
) -> Result<serde_json::Value, String> {
    run_blocking_command("order_notice_employee_attempt", move || {
        let db = app.state::<DbState>();
        crate::order_notice_recovery::observe(
            "employee_attempt",
            (|| {
                let permit = crate::support::critical_op::global()
                    .try_begin_support(true, None)
                    .map_err(str::to_string)?;
                let conn = crate::order_notice_recovery::observer_connection(&db.db_path, true)?;
                let tx = permit.begin_write_nowait(&conn)?;
                let result = crate::order_notice_evidence::employee_attempt(&tx, &arg0)?;
                tx.commit().map_err(|e| e.to_string())?;
                Ok(result)
            })(),
        )
    })
    .await
}

#[tauri::command]
pub async fn order_sync_notices(
    app: tauri::AppHandle,
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let order_ids = order_notice_ids(arg0)?;
    run_blocking_command("order_sync_notices", move || {
        let db = app.state::<DbState>();
        crate::order_notice_recovery::observe(
            "order_sync_notices",
            (|| {
                let conn = crate::order_notice_recovery::observer_connection(&db.db_path, false)?;
                crate::order_notice_recovery::notices(&conn, order_ids.as_deref())
            })(),
        )
    })
    .await
}

// PlatformBridge.invoke uses the positional arg0 envelope. An invalid list
// must fail the read, never broaden a per-order request to every order.
fn order_notice_ids(arg0: Option<serde_json::Value>) -> Result<Option<Vec<String>>, String> {
    let Some(request) = arg0 else { return Ok(None) };
    let ids = request
        .get("orderIds")
        .ok_or("Invalid order notice request")?;
    serde_json::from_value(ids.clone()).map_err(|_| "Invalid order notice IDs".into())
}

#[cfg(test)]
mod order_notice_command_tests {
    use super::order_notice_ids;
    use serde_json::json;

    #[test]
    fn order_notice_recovery_arg0_envelope_preserves_the_requested_ids() {
        let envelope = json!({"arg0":{"orderIds":["local-order"]}});
        assert_eq!(
            order_notice_ids(Some(envelope["arg0"].clone())).unwrap(),
            Some(vec!["local-order".into()])
        );
        assert_eq!(
            order_notice_ids(Some(json!({"orderIds":[]}))).unwrap(),
            Some(vec![])
        );
        assert_eq!(
            order_notice_ids(Some(json!({"orderIds":null}))).unwrap(),
            None
        );
        assert_eq!(order_notice_ids(None).unwrap(), None);
        assert!(order_notice_ids(Some(json!({"orderIds":"wrong"}))).is_err());
        assert!(order_notice_ids(Some(json!({"wrongName":["local-order"]}))).is_err());
    }
}

/// Enqueue a new item into the offline sync queue.
///
/// Returns the generated UUID for the item.
#[tauri::command]
pub async fn sync_queue_enqueue(
    app: tauri::AppHandle,
    item: sync_queue::EnqueueInput,
) -> Result<String, String> {
    run_blocking_command("sync_queue_enqueue", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_enqueue")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::enqueue(&conn, &item)
    })
    .await
}

#[tauri::command]
pub async fn sync_queue_enqueue_table_batch(
    app: tauri::AppHandle,
    items: Vec<sync_queue::EnqueueInput>,
) -> Result<Vec<String>, String> {
    run_blocking_command("sync_queue_enqueue_table_batch", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_enqueue_table_batch")
            .map_err(|error| format!("db lock: {error}"))?;
        sync_queue::enqueue_table_transfer_batch(&conn, &items)
    })
    .await
}

/// Dequeue the next item to process (highest priority, oldest first).
///
/// Marks the item as `processing` so it won't be dequeued again.
/// Returns `null` if no items are ready.
#[tauri::command]
pub async fn sync_queue_dequeue(
    app: tauri::AppHandle,
) -> Result<Option<sync_queue::SyncQueueItem>, String> {
    run_blocking_command("sync_queue_dequeue", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_dequeue")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_dequeue(&conn)
    })
    .await
}

/// Peek at the next item without removing or changing its status.
#[tauri::command]
pub async fn sync_queue_peek(
    app: tauri::AppHandle,
) -> Result<Option<sync_queue::SyncQueueItem>, String> {
    run_blocking_command("sync_queue_peek", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_peek")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_peek(&conn)
    })
    .await
}

/// Remove all items from the sync queue (the canonical parity outbox).
///
/// Gap review 2026-07-10 P0: this wipes every pending/failed offline order,
/// payment, and adjustment awaiting push to the Admin API. Like the sibling
/// full-wipe commands it must require SystemControl and snapshot first — the
/// webview is the trust boundary.
#[tauri::command]
pub async fn sync_queue_clear(
    app: tauri::AppHandle,
) -> Result<(), crate::auth::GuardedCommandError> {
    run_blocking_command("sync_queue_clear", move || {
        let db = app.state::<DbState>();
        let auth_state = app.state::<crate::auth::AuthState>();
        crate::auth::authorize_privileged_action(
            crate::auth::PrivilegedActionScope::SystemControl,
            &db,
            &auth_state,
        )?;
        crate::recovery::snapshot_before_destructive_action(
            &db,
            crate::recovery::RecoveryPointKind::PreClearOperationalData,
        )?;
        let conn = db
            .lock_traced("sync_queue_clear")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_clear(&conn).map_err(Into::into)
    })
    .await
}

/// Get the current number of items in the sync queue.
#[tauri::command]
pub async fn sync_queue_length(app: tauri::AppHandle) -> Result<i64, String> {
    run_blocking_command("sync_queue_length", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_length")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_get_length(&conn)
    })
    .await
}

/// Get detailed queue status (total, pending, failed, conflicts, oldest age).
#[tauri::command]
pub async fn sync_queue_status(app: tauri::AppHandle) -> Result<sync_queue::QueueStatus, String> {
    run_blocking_command("sync_queue_status", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_status")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_get_status(&conn)
    })
    .await
}

/// List actionable parity queue items, optionally filtered by module.
#[tauri::command]
pub async fn sync_queue_list_items(
    app: tauri::AppHandle,
    query: Option<sync_queue::QueueListQuery>,
) -> Result<Vec<sync_queue::SyncQueueItem>, String> {
    run_blocking_command("sync_queue_list_items", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_list_items")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_list_actionable_items(&conn, &query.unwrap_or_default())
    })
    .await
}

/// Retry a single parity queue item immediately.
#[tauri::command]
pub async fn sync_queue_retry_item(app: tauri::AppHandle, item_id: String) -> Result<(), String> {
    run_blocking_command("sync_queue_retry_item", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_retry_item")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_retry_item(&conn, item_id.as_str())
    })
    .await
}

/// Health "Sync now": make these renderer-visible pending rows due now
/// (their retry time only, recorded in the recovery action log first).
#[tauri::command]
pub async fn sync_queue_make_due(
    app: tauri::AppHandle,
    item_ids: Vec<String>,
    issue_code: Option<String>,
) -> Result<sync_queue::MakeDueResult, String> {
    run_blocking_command("sync_queue_make_due", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_make_due")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_make_items_due(
            &conn,
            &item_ids,
            issue_code.as_deref().unwrap_or("sync"),
        )
    })
    .await
}

/// Renderer-visible parity queue rows by id (a missing row is gone).
#[tauri::command]
pub async fn sync_queue_items_by_id(
    app: tauri::AppHandle,
    item_ids: Vec<String>,
) -> Result<Vec<sync_queue::SyncQueueItem>, String> {
    run_blocking_command("sync_queue_items_by_id", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_items_by_id")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_items_by_id(&conn, &item_ids)
    })
    .await
}

/// Retry all actionable parity queue items for a module.
#[tauri::command]
pub async fn sync_queue_retry_module(
    app: tauri::AppHandle,
    module_type: String,
) -> Result<sync_queue::RetryItemsResult, String> {
    run_blocking_command("sync_queue_retry_module", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_retry_module")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_retry_items_by_module(&conn, module_type.as_str())
    })
    .await
}

/// List conflict audit records produced by parity queue processing.
#[tauri::command]
pub async fn sync_queue_list_conflicts(
    app: tauri::AppHandle,
    limit: Option<i64>,
) -> Result<Vec<sync_queue::ConflictAuditEntry>, String> {
    run_blocking_command("sync_queue_list_conflicts", move || {
        let db = app.state::<DbState>();
        let conn = db
            .lock_traced("sync_queue_list_conflicts")
            .map_err(|e| format!("db lock: {e}"))?;
        sync_queue::renderer_list_conflict_audit_entries(&conn, limit.unwrap_or(100))
    })
    .await
}

/// Process all pending items in the queue by syncing them to the admin API.
///
/// Items are sent FIFO within priority bands. On success, items are removed.
/// On failure, items are rescheduled with exponential backoff.
#[tauri::command]
pub async fn sync_queue_process(
    report_health_targets: Option<bool>,
    db: State<'_, DbState>,
    sync_state: State<'_, std::sync::Arc<crate::sync::SyncState>>,
    cancellation: State<'_, tokio_util::sync::CancellationToken>,
    app: tauri::AppHandle,
) -> Result<sync_queue::SyncResult, String> {
    if report_health_targets == Some(true) {
        return crate::sync::RendererParityExecutionContext::new(
            &db,
            sync_state.inner().as_ref(),
            cancellation.inner(),
        )
        .await?
        .process_queue(&app, "sync_queue_process", true)
        .await;
    }
    crate::sync::process_renderer_parity_queue_guarded(
        &db,
        sync_state.inner().as_ref(),
        &app,
        cancellation.inner(),
        "sync_queue_process",
    )
    .await
}
