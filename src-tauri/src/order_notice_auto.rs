//! Durable, bounded retries of failures known to precede an order change.
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
/// Holds the editor registry across a confirmed owner's local transaction.
pub(crate) struct UneditedOrder {
    _guard: std::sync::MutexGuard<'static, Editors>,
}

pub(crate) fn claim_unedited_order(order: &str) -> Result<UneditedOrder, String> {
    let guard = editors()
        .0
        .try_lock()
        .map_err(|_| "ORDER_CORRECTION_NEWER_HEADER_EDIT")?;
    if guard.values().any(|ids| ids.iter().any(|id| id == order)) {
        return Err("ORDER_CORRECTION_NEWER_HEADER_EDIT".into());
    }
    Ok(UneditedOrder { _guard: guard })
}

pub(crate) fn clear_window(window: &str) {
    editors().clear_window(window)
}

const ATTEMPT_CAP: i64 = 3;
const COOLDOWN_MS: i64 = 60_000;

pub(crate) fn eligible(conn: &Connection, row: &owner::Refused) -> Result<bool, String> {
    // Any replacement (manual or automatic) is terminal for automatic retries.
    conn.query_row(
        "SELECT NOT EXISTS(
            SELECT 1 FROM recovery_action_log
            WHERE (id=?1 AND NOT (
                COALESCE(json_extract(payload_json,'$.outcome'),'')='failed'
                AND COALESCE(json_extract(payload_json,'$.attemptCount'),?3)<?3
                AND COALESCE(json_extract(payload_json,'$.retryAtMs'),?4+1)<=?4
            ))
            OR (json_extract(payload_json,'$.nativeOrderCorrection')=1
                AND json_extract(payload_json,'$.replacementQueueId')=?2)
        )",
        params![
            format!("automatic-order-header:{}", row.id),
            row.id,
            ATTEMPT_CAP,
            chrono::Utc::now().timestamp_millis()
        ],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
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

/// Caller owns an immediate transaction. Only an explicitly retryable failed
/// claim can be used again. A legacy claim has no retry metadata.
pub(crate) fn claim(conn: &Connection, row: &owner::Refused) -> Result<bool, String> {
    if !eligible(conn, row)? {
        return Ok(false);
    }
    let scope = crate::table_session_cache::current_scope(conn)?;
    conn.execute(
        "INSERT INTO recovery_action_log(id,action_id,issue_code,issue_id,recipe_id,recipe_version,entity_type,entity_id,order_id,success,created_at,payload_json)
         VALUES (?1,?2,'customer_correction_refused',?3,'order-customer-correction.resend',1,'order',?4,?4,0,?5,?6)
         ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, error_message=NULL,
           payload_json=json_set(excluded.payload_json,
             '$.attemptCount',json_extract(recovery_action_log.payload_json,'$.attemptCount')+1,
             '$.attemptFailures',json(COALESCE(json_extract(recovery_action_log.payload_json,'$.attemptFailures'),'[]')))",
        params![format!("automatic-order-header:{}",row.id), owner::RESEND, row.id, row.order, chrono::Utc::now().to_rfc3339(),
            json!({"openedAt":owner::opened_at(conn, &row.id)?,"automatic":true,"automaticIntent":true,"outcome":"running","attemptCount":1,"organizationId":scope.organization,"retiredQueueId":row.id,"retiredRequest":row.data,"reason":row.error}).to_string()])
        .map(|count| count == 1).map_err(|e| e.to_string())
}

fn fail_at(
    conn: &Connection,
    queue: &str,
    reason: &str,
    retry_at: Option<i64>,
) -> Result<(), String> {
    conn.execute("UPDATE recovery_action_log SET error_message=?2,
        payload_json=json_set(payload_json,'$.outcome','failed','$.machineReason',?2,'$.retryAtMs',?3,
          '$.attemptFailures',json_insert(COALESCE(json_extract(payload_json,'$.attemptFailures'),'[]'),
            '$[#]',json_object('reason',?2,'finishedAt',?4)))
        WHERE id=?1 AND json_extract(payload_json,'$.outcome')='running'",
        params![format!("automatic-order-header:{queue}"), reason, retry_at, chrono::Utc::now().to_rfc3339()]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn fail(conn: &Connection, queue: &str, reason: &str) -> Result<(), String> {
    fail_at(conn, queue, reason, None)
}

#[derive(Debug)]
pub(crate) struct FailedAttempt {
    reason: String,
    retry_at: Option<i64>,
}

impl FailedAttempt {
    fn new(error: &str, entered_apply: bool) -> Self {
        let mut reason = crate::order_notice_evidence::machine_code(error);
        if reason == "UNCLASSIFIED_REFUSAL" {
            reason = owner::notice_failure_code(error);
        }
        let retry_at = (!entered_apply
            && matches!(
                reason.as_str(),
                "NOTICE_DATABASE_BUSY"
                    | "ORDER_NOTICE_DATABASE_UNAVAILABLE"
                    | "PREEMPTED_BY_CRITICAL_OPERATION"
                    | "CONCURRENT_OPERATION"
                    | "ORDER_BEING_EDITED"
                    | "EDIT_CANONICAL_PREFLIGHT_UNREACHABLE"
            ))
        .then(|| chrono::Utc::now().timestamp_millis() + COOLDOWN_MS);
        Self { reason, retry_at }
    }
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

pub(crate) async fn attempt(
    db: &DbState,
    state: &SyncState,
    cancel: &tokio_util::sync::CancellationToken,
    id: &str,
) -> Result<Option<FailedAttempt>, String> {
    if !owner::online() || crate::support::critical_op::global().active() {
        return Ok(None);
    }
    crate::support::remedies::recipe("order-customer-correction.resend", 1)?;
    let permit = crate::support::critical_op::global()
        .try_begin_support(true, None)
        .map_err(|_| "CONCURRENT_OPERATION")?;
    let isolated = DbState {
        conn: Mutex::new(owner::observer_connection(&db.db_path, true)?),
        db_path: db.db_path.clone(),
    };
    let context =
        crate::sync::RendererParityExecutionContext::new(&isolated, state, cancel).await?;
    let prepared = context.run_local_step(|conn| {
        let Some(row) = owner::refused(conn, id)? else {
            return Ok(None);
        };
        if !admitted(
            conn,
            &row,
            owner::online(),
            permit.is_cancelled(),
            editing(&row.order),
        )? {
            return Ok(None);
        }
        // Capturing original lines and header state is read-only. Keep it
        // outside the deadline for the short, durable intent transaction.
        let before = owner::capture(conn, &row);
        let tx = permit.begin_write_nowait(conn)?;
        let Some(current) = owner::refused(&tx, id)? else {
            return Ok(None);
        };
        if current.data != row.data
            || current.status != row.status
            || current.error != row.error
            || !claim(&tx, &row)?
        {
            return Ok(None);
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Some((row, before)))
    })?;
    let Some((row, before)) = prepared else {
        return Ok(None);
    };
    owner::notify_queue_changed();
    let mut entered_apply = false;
    let result: Result<(), String> = async {
        let before = before?;
        let answer = owner::fetch_canonical(&isolated, &before).await?;
        owner::verify(&before, &answer)?;
        context.run_local_step(|conn| {
            let tx = permit.begin_write_nowait(conn)?;
            // A lease is seen here or registered after the transaction ends.
            let leases = editors()
                .0
                .lock()
                .map_err(|_| "ORDER_EDIT_LEASE_UNAVAILABLE")?;
            if leases.values().any(|ids| ids.contains(&row.order)) {
                return Err("ORDER_BEING_EDITED".into());
            }
            if !owner::online() {
                return Err("EDIT_CANONICAL_PREFLIGHT_UNREACHABLE".into());
            }
            if permit.is_cancelled() {
                return Err("CONCURRENT_OPERATION".into());
            }
            entered_apply = true;
            apply(&tx, &row, &before, &answer)?;
            if permit.is_cancelled() {
                return Err("CONCURRENT_OPERATION".into());
            }
            tx.commit().map_err(|e| e.to_string())
        })
    }
    .await;
    Ok(result
        .err()
        .map(|reason| FailedAttempt::new(&reason, entered_apply)))
}

/// Failure recording owns a fresh permit. If its non-waiting writer is busy,
/// the worker retains the classified failure and tries the audit again before
/// considering a new claim for this row. It never reuses a cancelled permit.
pub(crate) fn persist_failure(
    path: &std::path::Path,
    queue: &str,
    failure: &FailedAttempt,
) -> Result<(), String> {
    let permit = crate::support::critical_op::global()
        .try_begin_support(true, None)
        .map_err(str::to_string)?;
    let conn = owner::observer_connection(path, true)?;
    let tx = permit.begin_write_nowait(&conn)?;
    fail_at(&tx, queue, &failure.reason, failure.retry_at)?;
    tx.commit().map_err(|e| e.to_string())
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
        let mut startup_cleanup = true;
        let mut pending_failures = HashMap::new();
        loop {
            if cancel.is_cancelled() {
                break;
            }
            if startup_cleanup {
                if owner::observe(
                    "automatic_startup",
                    interrupt_previous_attempts(&db.db_path),
                )
                .is_err()
                {
                    tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(5)) => {} }
                    continue;
                }
                startup_cleanup = false;
            }
            pending_failures.retain(|id: &String, failure| {
                owner::observe(
                    "automatic_failure_audit",
                    persist_failure(&db.db_path, id, failure),
                )
                .is_err()
            });
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
                        if pending_failures.contains_key(id) {
                            continue;
                        }
                        let reason = match owner::observe(
                            "automatic_attempt",
                            attempt(&db, &state, &cancel, id).await,
                        ) {
                            Ok(Some(failure)) => {
                                if owner::observe(
                                    "automatic_failure_audit",
                                    persist_failure(&db.db_path, id, &failure),
                                )
                                .is_err()
                                {
                                    pending_failures.insert(id.into(), failure);
                                }
                                None
                            }
                            Ok(None) => None,
                            Err(error) => Some(owner::notice_failure_code(&error)),
                        };
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
    tx.execute("UPDATE recovery_action_log SET error_message='AUTOMATIC_ATTEMPT_INTERRUPTED',payload_json=json_set(payload_json,'$.outcome','failed','$.machineReason','AUTOMATIC_ATTEMPT_INTERRUPTED') WHERE json_valid(payload_json) AND json_extract(payload_json,'$.automaticIntent')=1 AND json_extract(payload_json,'$.outcome')='running'", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_change_failures_retry_until_the_persisted_cap_but_apply_failures_do_not() {
        let conn = crate::commands::orders::driver_restore_tests::test_conn();
        crate::commands::orders::driver_restore_tests::paid_delivery_order(&conn);
        let row = owner::Refused {
            id: "retry-cap-fixture".into(),
            order: crate::commands::orders::driver_restore_tests::ORDER.into(),
            data: "{}".into(),
            error: "UNKNOWN_CONFLICT_REVIEW".into(),
            status: "conflict".into(),
        };
        conn.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,created_at,conflict_strategy,version,status)
                      VALUES(?1,'orders',?2,'UPDATE','{}',?3,'2026-11-18T04:13:00Z','server-wins',1,'conflict')",
            params![row.id, row.order, crate::commands::orders::driver_restore_tests::ORG]).unwrap();
        for _ in 0..ATTEMPT_CAP {
            let tx = crate::db::immediate_transaction(&conn).unwrap();
            assert!(claim(&tx, &row).unwrap());
            let refusal = FailedAttempt::new("ORDER_BEING_EDITED", false);
            assert!(refusal.retry_at.is_some());
            fail_at(&tx, &row.id, &refusal.reason, refusal.retry_at).unwrap();
            tx.commit().unwrap();
            assert!(!eligible(&conn, &row).unwrap());
            conn.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.retryAtMs',0)", []).unwrap();
        }
        assert!(!eligible(&conn, &row).unwrap());
        let history: i64 = conn.query_row("SELECT json_array_length(payload_json,'$.attemptFailures') FROM recovery_action_log",[],|r|r.get(0)).unwrap();
        assert_eq!(history, ATTEMPT_CAP);
        assert!(FailedAttempt::new("NOTICE_DATABASE_BUSY", true)
            .retry_at
            .is_none());
        assert!(FailedAttempt::new("HTTP_403", false).retry_at.is_none());
    }

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
