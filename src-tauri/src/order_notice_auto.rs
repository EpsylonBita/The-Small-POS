//! One durable automatic attempt per original refused header edit. The intent
//! survives a crash; an interrupted attempt is left for a person, never replayed.
use crate::{db::DbState, order_notice_recovery as owner, sync::SyncState};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

type Editors = HashMap<String, Vec<String>>;
/// Orders open in an edit window, per window session. One instance serves the
/// process; a test builds its own so that it never contends with another test.
#[derive(Default)]
struct Leases(Mutex<Editors>);
static EDITORS: OnceLock<Leases> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);
static DEFERRED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
pub(crate) fn deferred_reason(queue: &str) -> Option<String> {
    DEFERRED
        .get_or_init(Mutex::default)
        .try_lock()
        .ok()?
        .get(queue)
        .cloned()
}
fn editors() -> &'static Leases {
    EDITORS.get_or_init(Leases::default)
}

impl Leases {
    /// Runs on the blocking pool. It waits for an automatic attempt's final
    /// transaction (non-waiting writer under a 250 ms deadline), so a lease is
    /// either seen by that attempt or registered right after it committed. A
    /// refused registration would leave the employee editing with no lease.
    fn set(&self, session: String, ids: Vec<String>) -> Result<(), String> {
        let mut leases = self.0.lock().map_err(|_| "ORDER_EDIT_LEASE_UNAVAILABLE")?;
        if ids.is_empty() {
            leases.remove(&session);
        } else {
            leases.insert(session, ids);
        }
        Ok(())
    }

    /// Observation only: it never waits, and contention reads as "being edited".
    fn editing(&self, order: &str) -> bool {
        self.0
            .try_lock()
            .map(|leases| leases.values().any(|ids| ids.iter().any(|id| id == order)))
            .unwrap_or(true)
    }

    /// Called from the window event on the main thread, which never waits. When
    /// an automatic attempt holds the leases at that instant, a short-lived
    /// thread finishes the release: a lease left behind would keep its orders
    /// "being edited" (no automatic attempt for them) until the app restarts.
    fn clear_window(&'static self, window: &str) {
        fn release(leases: &mut Editors, window: &str) {
            leases.retain(|key, _| !key.starts_with(&format!("{window}:")));
        }
        match self.0.try_lock() {
            Ok(mut leases) => release(&mut leases, window),
            Err(std::sync::TryLockError::WouldBlock) => {
                let window = window.to_string();
                std::thread::spawn(move || {
                    if let Ok(mut leases) = self.0.lock() {
                        release(&mut leases, &window);
                    }
                });
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {}
        }
    }
}

pub(crate) fn set_editing(session: String, ids: Vec<String>) -> Result<(), String> {
    editors().set(session, ids)
}
pub(crate) fn editing(order: &str) -> bool {
    editors().editing(order)
}
pub(crate) fn clear_window(window: &str) {
    editors().clear_window(window)
}

pub(crate) fn eligible(conn: &Connection, row: &owner::Refused) -> Result<bool, String> {
    // Any replacement (manual or automatic) is terminal for automatic retries.
    conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM recovery_action_log WHERE id=?1 OR (json_extract(payload_json,'$.nativeOrderCorrection')=1 AND json_extract(payload_json,'$.replacementQueueId')=?2))",
        params![format!("automatic-order-header:{}", row.id), row.id], |r| r.get(0)).map_err(|e| e.to_string())
}

pub(crate) fn admitted(
    conn: &Connection,
    row: &owner::Refused,
    online: bool,
    busy: bool,
    edited: bool,
) -> Result<bool, String> {
    Ok(online && !busy && !edited && eligible(conn, row)?)
}

/// The primary key is the cross-window/restart claim. Caller owns the immediate
/// transaction; claiming is the attempt's first durable action, before I/O.
pub(crate) fn claim(conn: &Connection, row: &owner::Refused) -> Result<bool, String> {
    if !eligible(conn, row)? {
        return Ok(false);
    }
    let scope = crate::table_session_cache::current_scope(conn)?;
    conn.execute("INSERT OR IGNORE INTO recovery_action_log(id,action_id,issue_code,issue_id,recipe_id,recipe_version,entity_type,entity_id,order_id,success,created_at,payload_json) VALUES (?1,?2,'customer_correction_refused',?3,'order-customer-correction.resend',1,'order',?4,?4,0,?5,?6)",
        params![format!("automatic-order-header:{}",row.id), owner::RESEND, row.id, row.order, chrono::Utc::now().to_rfc3339(), json!({"openedAt":owner::opened_at(conn, &row.id)?,"automatic":true,"automaticIntent":true,"outcome":"running","organizationId":scope.organization,"retiredQueueId":row.id,"retiredRequest":row.data,"reason":row.error}).to_string()])
        .map(|count| count == 1).map_err(|e| e.to_string())
}

pub(crate) fn fail(conn: &Connection, queue: &str, reason: &str) -> Result<(), String> {
    conn.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.outcome','failed','$.machineReason',?2) WHERE id=?1 AND json_extract(payload_json,'$.outcome')='running'",
        params![format!("automatic-order-header:{queue}"), reason]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn apply(
    conn: &Connection,
    row: &owner::Refused,
    before: &Value,
    answer: &Value,
) -> Result<Value, String> {
    let running: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM recovery_action_log WHERE id=?1 AND json_extract(payload_json,'$.outcome')='running')", [format!("automatic-order-header:{}",row.id)], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !running {
        return Err("AUTOMATIC_ATTEMPT_ALREADY_USED".into());
    }
    if owner::refused(conn, &row.id)?.is_none() {
        return Err("REMEDY_NOT_APPLICABLE".into());
    }
    let result = owner::apply(conn, row, before, answer, owner::RESEND, "")?;
    // Both the retired request's audit and the intent are updated in exactly
    // the transaction that retires the old row and queues its replacement.
    conn.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.automatic',json('true')) WHERE json_extract(payload_json,'$.nativeOrderCorrection')=1 AND json_extract(payload_json,'$.retiredQueueId')=?1", [&row.id]).map_err(|e| e.to_string())?;
    conn.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.outcome','pending','$.replacementQueueId',(SELECT json_extract(payload_json,'$.replacementQueueId') FROM recovery_action_log WHERE json_extract(payload_json,'$.nativeOrderCorrection')=1 AND json_extract(payload_json,'$.retiredQueueId')=?2 LIMIT 1)) WHERE id=?1", params![format!("automatic-order-header:{}",row.id),row.id]).map_err(|e| e.to_string())?;
    Ok(result)
}

async fn attempt(
    db: &DbState,
    state: &SyncState,
    cancel: &tokio_util::sync::CancellationToken,
    id: &str,
) -> Result<(), String> {
    if !owner::online() || crate::support::critical_op::global().active() {
        return Ok(());
    }
    crate::support::remedies::recipe("order-customer-correction.resend", 1)?;
    let permit = crate::support::critical_op::global()
        .try_begin_support(true, None)
        .map_err(|_| "CONCURRENT_OPERATION")?;
    // The normal binding fence is retained, but its local steps use a private
    // handle. The automatic helper never acquires the business mutex.
    let isolated = DbState {
        conn: Mutex::new(owner::observer_connection(&db.db_path, true)?),
        db_path: db.db_path.clone(),
    };
    let db = &isolated;
    let prepared = crate::sync::guarded_renderer_local_mutation(db, state, cancel, |conn| {
        let result = (|| {
            let tx = permit.begin_write_nowait(conn)?;
            let Some(row) = owner::refused(&tx, id)? else {
                return Ok(None);
            };
            if !admitted(
                &tx,
                &row,
                owner::online(),
                permit.is_cancelled(),
                editing(&row.order),
            )? {
                return Ok(None);
            }
            if !claim(&tx, &row)? {
                return Ok(None);
            }
            // Capture failure consumes the attempt too, with no order changes.
            let before = owner::capture(&tx, &row);
            if let Err(reason) = &before {
                fail(
                    &tx,
                    &row.id,
                    &crate::order_notice_evidence::machine_code(reason),
                )?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(before.ok().map(|before| (row, before)))
        })();
        conn.progress_handler(0, None::<fn() -> bool>);
        result
    })
    .await?;
    let Some((row, before)) = prepared else {
        owner::notify_queue_changed();
        return Ok(());
    };
    owner::notify_queue_changed();
    let result: Result<(), String> = async {
        let remote = crate::order_header_preflight::remote_id(&before)?
            .ok_or("EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
        let answer = crate::admin_fetch_detailed(
            Some(db),
            &format!("/api/pos/orders/sync?order_id={remote}"),
            "GET",
            None,
        )
        .await
        .map_err(|_| "EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
        owner::verify(&before, &answer)?;
        crate::sync::guarded_renderer_local_mutation(db, state, cancel, |conn| {
            let result = (|| {
                let tx = permit.begin_write_nowait(conn)?;
                // Held until this transaction ends: a lease is either seen
                // here or registered after the commit. Its other holders keep
                // it for a map operation only, so waiting cannot consume the
                // order's single automatic attempt the way a refusal would.
                let leases = editors()
                    .0
                    .lock()
                    .map_err(|_| "ORDER_EDIT_LEASE_UNAVAILABLE")?;
                if leases.values().any(|ids| ids.contains(&row.order)) {
                    return Err("ORDER_BEING_EDITED".into());
                }
                if !owner::online() {
                    return Err("EDIT_CANONICAL_PREFLIGHT_REQUIRED".into());
                }
                apply(&tx, &row, &before, &answer)?;
                if permit.is_cancelled() {
                    return Err("CONCURRENT_OPERATION".into());
                }
                tx.commit().map_err(|e| e.to_string())?;
                Ok(())
            })();
            conn.progress_handler(0, None::<fn() -> bool>);
            result
        })
        .await
    }
    .await;
    if let Err(reason) = result {
        let conn = db.conn.lock().map_err(|_| "AUTOMATIC_AUDIT_UNAVAILABLE")?;
        let tx = permit.begin_write_nowait(&conn)?;
        fail(
            &tx,
            &row.id,
            &crate::order_notice_evidence::machine_code(&reason),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    owner::notify_queue_changed();
    Ok(())
}

pub(crate) fn start(
    db: Arc<DbState>,
    state: Arc<SyncState>,
    cancel: tokio_util::sync::CancellationToken,
) {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // A crash after claiming cannot cause a second attempt. The queue is
        // untouched unless its final transaction committed.
        loop {
            if cancel.is_cancelled() {
                break;
            }
            // Also finishes a prior pass whose failure audit was pre-empted.
            // This single native worker never has an active attempt here.
            let _ = owner::observe(
                "automatic_startup",
                interrupt_previous_attempts(&db.db_path),
            );
            let ids = owner::observe(
                "automatic_notices",
                owner::observer_connection(&db.db_path, false)
                    .and_then(|conn| owner::notices(&conn, None)),
            )
            .ok()
            .and_then(|rows| rows.as_array().cloned())
            .unwrap_or_default();
            for notice in ids {
                if cancel.is_cancelled() {
                    break;
                }
                if notice["kind"] == "customer_correction_refused" {
                    if let Some(id) = notice["queueId"].as_str() {
                        let reason = owner::observe(
                            "automatic_attempt",
                            attempt(&db, &state, &cancel, id).await,
                        )
                        .err()
                        .map(|error| crate::order_notice_evidence::machine_code(&error));
                        if let Ok(mut deferred) = DEFERRED.get_or_init(Mutex::default).try_lock() {
                            if let Some(reason) = reason {
                                deferred.insert(id.into(), reason);
                            } else {
                                deferred.remove(id);
                            }
                        }
                        owner::notify_queue_changed();
                    }
                }
            }
            tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
        }
    });
}

fn interrupt_previous_attempts(path: &std::path::Path) -> Result<(), String> {
    let permit = crate::support::critical_op::global()
        .try_begin_support(true, None)
        .map_err(str::to_string)?;
    let conn = owner::observer_connection(path, true)?;
    let tx = permit.begin_write_nowait(&conn)?;
    tx.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.outcome','failed','$.machineReason','AUTOMATIC_ATTEMPT_INTERRUPTED') WHERE json_extract(payload_json,'$.automaticIntent')=1 AND json_extract(payload_json,'$.outcome')='running'", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lease change that meets an automatic attempt's final transaction is
    /// never lost: registering waits for it, and a closed window is released
    /// as soon as the attempt lets go, without the caller ever waiting.
    #[test]
    fn lease_changes_during_an_automatic_attempt_are_never_lost() {
        let leases: &'static Leases = Box::leak(Box::default());
        let attempt = leases.0.lock().unwrap();
        let registering =
            std::thread::spawn(move || leases.set("window:session".into(), vec!["order".into()]));
        std::thread::sleep(Duration::from_millis(50));
        assert!(!registering.is_finished());
        // Contention is never read as "nobody is editing".
        assert!(leases.editing("order"));
        drop(attempt);
        registering.join().unwrap().unwrap();
        assert!(leases.editing("order"));
        assert!(!leases.editing("another-order"));

        let attempt = leases.0.lock().unwrap();
        let asked = std::time::Instant::now();
        leases.clear_window("window");
        assert!(asked.elapsed() < Duration::from_millis(50));
        drop(attempt);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while leases.editing("order") && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!leases.editing("order"));
    }
}
