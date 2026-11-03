//! Snapshot validation and startup restore staging under an exclusive lease.
use super::{
    contracts, critical_op, guards,
    snapshot::{self, Snapshot},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{Emitter, Manager};

pub fn validate(store: &Connection, live: &Connection, snap: &Snapshot) -> Result<(), String> {
    if snapshot::newest(store)?.as_deref() != Some(&snap.id)
        || snap.version != env!("CARGO_PKG_VERSION")
        || snap.versions != json!({"main":snapshot::schema_version(live)?})
    {
        return Err("POLICY_REFUSED".into());
    }
    let post: Option<String> = store
        .query_row(
            "SELECT post_change_watermark_json FROM support_snapshots WHERE id=?1",
            [&snap.id],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    if post.as_deref() != Some(&snapshot::watermarks(live)?.0.to_string()) {
        return Err("RESTORE_WOULD_LOSE_SALES".into());
    }
    Ok(())
}
#[cfg(test)]
pub trait Backend {
    fn close_all(&mut self) -> Result<(), String>;
    fn replace(&mut self, source: &Path) -> Result<(), String>;
    fn restart(&mut self) -> Result<(), String>;
}
/// Caller has already acquired the exclusive lease, verified both snapshots and
/// rechecked the full watermark. A failed replacement rolls back to `pre`.
#[cfg(test)]
pub fn swap(backend: &mut dyn Backend, snap: &Snapshot, pre: &Snapshot) -> Result<(), String> {
    swap_with(backend, snap, pre, || Ok(()))
}
#[cfg(test)]
pub fn swap_with(
    backend: &mut dyn Backend,
    snap: &Snapshot,
    pre: &Snapshot,
    on_swapped: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    backend.close_all()?;
    if let Err(e) = backend.replace(&snap.folder.join("pos.db")) {
        return match backend.replace(&pre.folder.join("pos.db")) {
            Ok(()) => Err(e),
            Err(_) => Err("OUTCOME_UNKNOWN".into()),
        };
    }
    if let Err(e) = on_swapped().and_then(|_| backend.restart()) {
        return match backend.replace(&pre.folder.join("pos.db")) {
            Ok(()) => Err(e),
            Err(_) => Err("OUTCOME_UNKNOWN".into()),
        };
    }
    Ok(())
}
pub fn list(store: &Connection, c: &Connection) -> Result<Value, String> {
    let rows=guards::rows(store,"SELECT id,post_change_watermark_json FROM support_snapshots ORDER BY taken_at DESC,rowid DESC",&[])?;
    let mut result = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let s = snapshot::load(store, row["id"].as_str().ok_or("SNAPSHOT_FAILED")?)?;
        let integrity = snapshot::verify(&s).is_ok();
        let validation = validate(store, c, &s);
        let why = if i != 0 {
            json!("not_newest")
        } else if validation
            .as_ref()
            .is_err_and(|e| e == "RESTORE_WOULD_LOSE_SALES")
        {
            json!("watermark_changed")
        } else if validation.is_err() || !integrity {
            json!("version_mismatch")
        } else {
            Value::Null
        };
        let copy = Connection::open_with_flags(
            s.folder.join("pos.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        );
        let mut changes = Vec::new();
        if integrity {
            if let Ok(prior) = copy {
                let before = snapshot::watermarks(&prior)?.0;
                let live = snapshot::watermarks(c)?.0;
                for t in guards::schema(c)? {
                    if t.name == "support_txn_marker" || before[&t.name] == live[&t.name] {
                        continue;
                    }
                    if t.pk.is_empty() {
                        changes.push(json!({"table":t.name,"count":live[&t.name]["count"],"resynced_from_server":false}));
                        continue;
                    }
                    let old = guards::rows(
                        &prior,
                        &format!("SELECT * FROM {}", super::replica::quote(&t.name)),
                        &[],
                    )?;
                    let next = guards::rows(
                        c,
                        &format!("SELECT * FROM {}", super::replica::quote(&t.name)),
                        &[],
                    )?;
                    let mut old = old
                        .into_iter()
                        .map(|r| {
                            Ok((
                                guards::key(&t, &r)?.to_string(),
                                contracts::payload_hash(&r),
                            ))
                        })
                        .collect::<Result<std::collections::BTreeMap<_, _>, String>>()?;
                    let mut count = 0;
                    let mut resync = false;
                    for r in next {
                        let key = guards::key(&t, &r)?.to_string();
                        if old.remove(&key).as_deref() != Some(&contracts::payload_hash(&r)) {
                            count += 1;
                            resync |= r["sync_status"] == "synced";
                        }
                    }
                    count += old.len();
                    changes
                        .push(json!({"table":t.name,"count":count,"resynced_from_server":resync}));
                }
            }
        }
        result.push(json!({"snapshot_id":s.id,"session_id":s.session,"approval_id":s.approval,"taken_at":s.at,"reason":s.reason,"app_version":s.version,"schema_versions":s.versions,"size_bytes":s.size,"integrity_ok":integrity,"restorable":why.is_null(),"not_restorable_reason":why,"changed_since":changes}));
    }
    Ok(json!(result))
}
pub fn authorize(app: &tauri::AppHandle) -> Result<(), String> {
    authorize_state(
        &app.state::<crate::db::DbState>(),
        &app.state::<crate::auth::AuthState>(),
    )
    .map_err(|_| "POLICY_REFUSED".into())
}
pub fn authorize_state(
    db: &crate::db::DbState,
    auth: &crate::auth::AuthState,
) -> Result<(), crate::auth::PrivilegedActionError> {
    crate::auth::authorize_privileged_action(
        crate::auth::PrivilegedActionScope::SystemControl,
        db,
        auth,
    )
}
pub fn native_restore(
    app: &tauri::AppHandle,
    store: &Connection,
    live: &Path,
    id: &str,
    session: &str,
    command: Option<&str>,
) -> Result<(), String> {
    authorize(app)?;
    let rt = super::session::runtime(app)?;
    let (session, clock) = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let active = core.session.as_ref().ok_or("SESSION_ENDED")?;
        let session = if session == "onsite" {
            &active.info.session_id
        } else {
            session
        };
        if session != active.info.session_id || !active.admission.active {
            return Err("SESSION_ENDED".into());
        }
        let server_now = core.clock.now(session).ok_or("SESSION_ENDED")?;
        (
            session.to_string(),
            crate::recovery::SupportRestoreClock::capture(server_now)?,
        )
    };
    let result = stage_restore_with(store, live, id, &session, command, clock, || {
        let _ = app.emit("support://restore-lease", json!({"held":true}));
    });
    let _ = app.emit("support://restore-lease", json!({"held":false}));
    result
}
/// The lease ends after staging. No native connection is closed or restarted.
#[cfg(test)]
pub fn stage_restore(
    store: &Connection,
    live: &Path,
    id: &str,
    session: &str,
    command: Option<&str>,
) -> Result<(), String> {
    stage_restore_with(
        store,
        live,
        id,
        session,
        command,
        crate::recovery::SupportRestoreClock::capture(chrono::Utc::now().timestamp_millis())?,
        || {},
    )
}
fn stage_restore_with(
    store: &Connection,
    live: &Path,
    id: &str,
    session: &str,
    command: Option<&str>,
    clock: crate::recovery::SupportRestoreClock,
    on_lease: impl FnOnce(),
) -> Result<(), String> {
    let gate = critical_op::global();
    let _lease = gate.begin_exclusive_restore().map_err(str::to_string)?;
    on_lease();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !gate.support_idle() && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if !gate.support_idle() {
        return Err("CONCURRENT_OPERATION".into());
    }
    let c = Connection::open_with_flags(live, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(guards::error)?;
    let snap = snapshot::load(store, id)?;
    validate(store, &c, &snap)?;
    let post: String = store
        .query_row(
            "SELECT post_change_watermark_json FROM support_snapshots WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    let post: Value = serde_json::from_str(&post).map_err(|_| "SNAPSHOT_FAILED")?;
    snapshot::verify(&snap)?;
    let session = if session == "onsite" {
        &snap.session
    } else {
        session
    };
    let private = critical_op::CriticalOpGate::new();
    let permit = private
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let pre = snapshot::take(store, live, session, None, "pre_restore", &permit)?;
    if pre.full != post || snapshot::watermarks(&c)?.0 != post {
        return Err("RESTORE_WOULD_LOSE_SALES".into());
    }
    crate::recovery::stage_verified_support_snapshot(
        store, live, &snap, &pre, session, command, clock,
    )
}
/// Sanitized, persistent notice; available even before staff sign-in.
pub fn notice(app_data: &Path) -> Value {
    let stored = stored_notice(app_data);
    if stored.is_null() {
        Value::Null
    } else {
        json!({"id":stored["id"],"status":stored["status"]})
    }
}
fn stored_notice(app_data: &Path) -> Value {
    std::fs::read(app_data.join("support-restore-notice.json"))
        .ok()
        .and_then(|v| serde_json::from_slice::<Value>(&v).ok())
        .filter(|v| {
            matches!(
                v["status"].as_str(),
                Some("staged" | "applied" | "refused" | "expired" | "rolled_back")
            )
        })
        .unwrap_or(Value::Null)
}
/// Complete a staged command only after startup has recorded its actual result.
/// Existing result delivery remains usable even when session resume is refused.
pub fn report_startup(store: &Connection, app_data: &Path, command: &str) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let notice = stored_notice(app_data);
    if notice["command_id"] != command || notice["status"] == "staged" {
        return Ok(());
    }
    let raw: Option<String> = store.query_row(
        "SELECT envelope_json FROM support_accepted_commands WHERE command_id=?1 AND finished_at IS NULL",
        [command], |r| r.get(0),
    ).optional().map_err(guards::error)?;
    if let Some(raw) = raw {
        let c: contracts::Command = serde_json::from_str(&raw).map_err(|_| "INTERNAL_ERROR")?;
        let applied = notice["status"] == "applied";
        let mut data = json!({"outcome":if applied {"succeeded"} else {"rolled_back"},
            "snapshot":notice["snapshot"],"restore":{"restarted":true,"status":notice["status"],"rows_lost_or_reverted":[]}});
        if !notice["error_code"].is_null() {
            data["error_code"] = notice["error_code"].clone();
        }
        store
            .execute(
                "UPDATE support_consumed_approvals SET outcome=?1 WHERE command_id=?2",
                params![if applied { "succeeded" } else { "rolled_back" }, command],
            )
            .map_err(guards::error)?;
        super::breakglass::finish(store, &c, data, chrono::Utc::now().timestamp_millis())?;
    }
    Ok(())
}
fn local_context(app: &tauri::AppHandle) -> Result<(std::path::PathBuf, Connection), String> {
    if !crate::auth::has_permission(
        &app.state::<crate::auth::AuthState>(),
        Some("pos.support.connect"),
    ) {
        return Err("POLICY_REFUSED".into());
    }
    let path = app.state::<crate::db::DbState>().db_path.clone();
    let store = Connection::open(path.parent().ok_or("INTERNAL_ERROR")?.join("support.db"))
        .map_err(guards::error)?;
    store
        .busy_timeout(std::time::Duration::from_millis(100))
        .map_err(guards::error)?;
    Ok((path, store))
}
/// Startup guidance does not depend on support transport or staff sign-in.
#[tauri::command]
pub async fn support_restore_notice(app: tauri::AppHandle) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("support_restore_notice", move || {
        let path = app.state::<crate::db::DbState>().db_path.clone();
        Ok(
            json!({"restore_lease_held":critical_op::global().restoring(),
            "restore_notice":notice(path.parent().ok_or("INTERNAL_ERROR")?)}),
        )
    })
    .await
}
#[tauri::command]
pub async fn support_list_snapshots(app: tauri::AppHandle) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("support_list_snapshots", move || {
        let (path, store) = local_context(&app)?;
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .map_err(str::to_string)?;
        let c = super::replica::read_connection(
            &path,
            &permit,
            std::time::Instant::now() + std::time::Duration::from_secs(30),
        )?;
        Ok(json!({"snapshots":list(&store,&c)?}))
    })
    .await
}
#[tauri::command]
pub async fn support_list_quarantine(app: tauri::AppHandle) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("support_list_quarantine", move || {
        let (path, store) = local_context(&app)?;
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .map_err(str::to_string)?;
        let c = super::replica::read_connection(
            &path,
            &permit,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )?;
        Ok(json!({"groups":super::quarantine::list(&store,&c)?}))
    })
    .await
}
#[tauri::command]
pub async fn support_restore_snapshot(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, crate::auth::GuardedCommandError> {
    crate::database_lock::run_blocking_command("support_restore_snapshot", move || {
        let (path, store) = local_context(&app)?;
        if let Err(e) = authorize_state(
            &app.state::<crate::db::DbState>(),
            &app.state::<crate::auth::AuthState>(),
        ) {
            super::breakglass::local_audit(&store, "refused", Some("POLICY_REFUSED"))?;
            return Err(e.into());
        }
        let input = arg0.ok_or("INVALID_INPUT")?;
        let id = input["snapshot_id"].as_str().ok_or("INVALID_INPUT")?;
        super::breakglass::local_audit(&store, "started", None)?;
        let result = native_restore(&app, &store, &path, id, "onsite", None);
        super::breakglass::local_audit(
            &store,
            if result.is_ok() { "started" } else { "refused" },
            if result.is_ok() {
                Some("restore_staged")
            } else {
                result.as_ref().err().map(String::as_str)
            },
        )?;
        result?;
        Ok(json!({"success":true,"staged":true,"restart_required":true,"restarted":false}))
    })
    .await
}
#[tauri::command]
pub async fn support_restore_quarantine(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, crate::auth::GuardedCommandError> {
    crate::database_lock::run_blocking_command("support_restore_quarantine", move || {
        let (path, store) = local_context(&app)?;
        if let Err(e) = authorize_state(
            &app.state::<crate::db::DbState>(),
            &app.state::<crate::auth::AuthState>(),
        ) {
            super::breakglass::local_audit(&store, "refused", Some("POLICY_REFUSED"))?;
            return Err(e.into());
        }
        let input = arg0.ok_or("INVALID_INPUT")?;
        let id = input["group_id"].as_str().ok_or("INVALID_INPUT")?;
        super::breakglass::local_audit(&store, "started", None)?;
        let result = super::breakglass::local_restore_group(&app, &store, &path, id);
        super::breakglass::local_audit(
            &store,
            if result.is_ok() {
                "finished"
            } else {
                "refused"
            },
            result.as_ref().err().map(String::as_str),
        )?;
        result?;
        Ok(json!({"success":true,"restored":true}))
    })
    .await
}
/// Persisted while staging; startup reports the outcome before clearing it.
pub fn resume_token(store: &Connection, session: &str, command: &str) -> Result<(), String> {
    if store.execute("UPDATE support_session_state SET resume_token=?1 WHERE session_id=?2 AND status='active'",params![command,session]).map_err(guards::error)?!=1{return Err("SESSION_ENDED".into());}
    Ok(())
}
