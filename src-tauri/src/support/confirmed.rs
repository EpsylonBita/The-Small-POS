//! Explicit conversational authority. This module never consumes a passkey or
//! requests an on-site approval. The existing passkey executor is independent.
use super::{
    clock,
    contracts::{self, Command},
    critical_op, delivery, guards,
    session::Runtime,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{sync::atomic::Ordering, time::Instant};
use tauri::Manager;

pub const KIND: &str = "till_confirmed_command";
pub const CAPABILITY: &str = "support.founder-confirmed-commands.v1";
pub const CONSENT_VERSION: &str = "1.1";

/// Observe UI/session authority away from the business writer reservation.
/// The owner transaction checks only the sticky permit bit and its deadline.
struct AuthorityWatch(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for AuthorityWatch {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
fn watch_authority(
    app: &tauri::AppHandle,
    c: &Command,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<AuthorityWatch, String> {
    let rt = super::session::runtime(app)?;
    let app = app.clone();
    let c = c.clone();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done = stop.clone();
    std::thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            if current(&app, &rt, &c).is_err() {
                cancel.store(true, Ordering::Release);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    });
    Ok(AuthorityWatch(stop))
}
#[cfg(test)]
thread_local! {
    static BEFORE_POST_SAVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub fn before_post_save_for_test(f: impl FnOnce() + 'static) {
    BEFORE_POST_SAVE.with(|hook| *hook.borrow_mut() = Some(Box::new(f)));
}
pub fn save_post(store: &Connection, snapshot: &str, post: &Value) -> Result<(), String> {
    #[cfg(test)]
    BEFORE_POST_SAVE.with(|hook| {
        if let Some(f) = hook.borrow_mut().take() {
            f();
        }
    });
    if store
        .execute(
            "UPDATE support_snapshots SET post_change_watermark_json=? WHERE id=?",
            params![post.to_string(), snapshot],
        )
        .map_err(|_| "OUTCOME_UNKNOWN")?
        != 1
    {
        return Err("OUTCOME_UNKNOWN".into());
    }
    Ok(())
}

pub fn availability(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<std::sync::Arc<crate::sync::SyncState>>() else {
        return false;
    };
    let Some(db) = app.try_state::<crate::db::DbState>() else {
        return false;
    };
    let (v, age) = crate::sync::support_availability_with_age(&db.db_path, &state);
    availability_ok(&v, age)
}
pub fn availability_ok(v: &Value, age: Option<u64>) -> bool {
    v["available"] == true
        && v["min_protocol_version"].as_u64().is_some_and(|n| n <= 1)
        && v["tiers_enabled"]
            .as_array()
            .is_some_and(|a| a.iter().any(|n| n == 3))
        && !v["disabled_tools"]
            .as_array()
            .is_none_or(|a| a.iter().any(|n| n == KIND))
        && v["confirmed_commands"] == true
        && v["consent"]["state"] == "valid"
        && v["consent"]["text_version"] == CONSENT_VERSION
        && age.is_some_and(|ms| ms < contracts::cap("transport", "heartbeatMs"))
}

pub fn validate(c: &Command, admitted: bool) -> Result<(), &'static str> {
    if !admitted {
        return Err("TIER_NOT_ALLOWED");
    }
    if c.approval.is_some()
        || c.payload["mode"] != "founder_conversation"
        || c.payload["idempotency_key"] != c.idempotency_key
        || (c.payload["step"] != "sql_dry_run" && c.payload["founder_confirmed"] != true)
    {
        return Err("INVALID_INPUT");
    }
    for (key, max) in [("explanation", 300), ("reason", 200)] {
        let text = c.payload[key].as_str().ok_or("INVALID_INPUT")?;
        if text != text.trim()
            || !(10..=max).contains(&text.chars().count())
            || crate::diagnostics::scrub_and_bound_text(text, max) != text
        {
            return Err("POLICY_REFUSED");
        }
    }
    if c.payload.get("proposal").is_some() {
        super::confirmed_sql::params_of(&c.payload["proposal"]).map_err(|_| "POLICY_REFUSED")?;
        let sql = c.payload["proposal"]["sql"]
            .as_str()
            .ok_or("INVALID_INPUT")?;
        if crate::diagnostics::scrub_and_bound_text(sql, 8000) != sql
            || super::redaction::scrub_pan(sql) != sql
        {
            return Err("POLICY_REFUSED");
        }
    }
    Ok(())
}

pub fn current(app: &tauri::AppHandle, rt: &Runtime, c: &Command) -> Result<(), String> {
    if !rt.banner_ready.load(Ordering::Acquire) || !super::dispatch::window_visible(app) {
        return Err("TILL_PAUSED".into());
    }
    if !availability(app) {
        return Err("FEATURE_DISABLED".into());
    }
    let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
    let s = core.session.as_ref().ok_or("SESSION_ENDED")?;
    delivery::recheck(c, &s.admission, &core.clock, Instant::now()).map_err(str::to_string)?;
    let pinned:bool=core.executor.db.conn.query_row("SELECT EXISTS(SELECT 1 FROM support_confirmed_sessions WHERE session_id=? AND consent_version=? AND mode='founder_conversation')",params![c.session_id,CONSENT_VERSION],|r|r.get(0)).map_err(guards::error)?;
    if !pinned {
        return Err("TIER_NOT_ALLOWED".into());
    }
    let context = core.approval_context()?;
    if core
        .verifier
        .is_unattended(&core.executor.db.conn, &context)?
    {
        return Err("TIER_NOT_ALLOWED".into());
    }
    Ok(())
}

/// Append in the caller's support transaction, before any business work.
pub fn event(store: &Connection, c: &Command, name: &str, now: i64) -> Result<(), String> {
    if c.kind != KIND {
        return Ok(());
    }
    let safe = |key: &str| {
        crate::diagnostics::scrub_and_bound_text(
            c.payload[key]
                .as_str()
                .unwrap_or("Command refused before admission"),
            if key == "reason" { 200 } else { 300 },
        )
    };
    let details = json!({"event":name,"command_id":c.command_id,"session_id":c.session_id,"explanation":safe("explanation"),"reason":safe("reason"),"payload_sha256":c.payload_sha256,"at":clock::iso(now)});
    store.execute("INSERT INTO support_confirmed_events(session_id,command_id,event,details_json,created_at) VALUES(?1,?2,?3,?4,?5)",params![c.session_id,c.command_id,name,details.to_string(),clock::iso(now)]).map_err(guards::error)?;
    Ok(())
}

pub fn rate(store: &Connection, c: &Command, now: i64) -> Result<(), &'static str> {
    if c.kind != KIND {
        return Ok(());
    }
    let (count,last):(u64,Option<String>)=store.query_row("SELECT count(*),max(accepted_at) FROM support_accepted_commands WHERE session_id=?1 AND kind=?2",params![c.session_id,KIND],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"INTERNAL_ERROR")?;
    if count >= contracts::cap("confirmed", "perSession")
        || last
            .and_then(|s| clock::parse(&s).ok())
            .is_some_and(|at| now - at < contracts::cap("confirmed", "intervalMs") as i64)
    {
        return Err("RATE_LIMITED");
    }
    Ok(())
}

pub fn history(store: &Connection, scope: &guards::Scope) -> Result<Value, String> {
    let scope_json=json!({"organization_id":scope.organization_id,"branch_id":scope.branch_id,"terminal_id":scope.terminal_id}).to_string();
    let mut q=store.prepare("SELECT e.details_json,e.event,c.result_json FROM support_confirmed_events e LEFT JOIN support_accepted_commands c ON c.command_id=e.command_id JOIN support_evidence_sessions s ON s.session_id=e.session_id WHERE s.scope_json=?1 AND e.id=(SELECT max(latest.id) FROM support_confirmed_events latest WHERE latest.command_id=e.command_id) ORDER BY e.id DESC LIMIT 20").map_err(guards::error)?;
    let rows = q
        .query_map([scope_json], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(guards::error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(guards::error)?;
    rows.into_iter()
        .map(|(s, event, result)| {
            let mut v: Value = serde_json::from_str(&s).map_err(|_| "INTERNAL_ERROR")?;
            v["state"] = json!(event.trim_start_matches("confirmed_command_"));
            if let Some(result) = result {
                let r: Value = serde_json::from_str(&result).map_err(|_| "INTERNAL_ERROR")?;
                v["outcome"] = r["data"]["outcome"].clone();
            }
            Ok(v)
        })
        .collect::<Result<Vec<_>, String>>()
        .map(Value::Array)
}

pub fn run(
    app: &tauri::AppHandle,
    rt: &Runtime,
    store: &Connection,
    c: &Command,
) -> Result<Value, String> {
    current(app, rt, c)?;
    if critical_op::global().active() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let live = app.state::<crate::db::DbState>().db_path.clone();
    if c.payload["action"]["action_id"] == "recovery.undo_snapshot.v1" {
        return super::confirmed_restore::run(app, rt, store, &live, c);
    }
    let gate = critical_op::global();
    let handoff = gate
        .register_process_cancel(|| {})
        .map_err(str::to_string)?;
    let permit = gate
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let db = super::replica::read_connection(
        &live,
        &permit,
        Instant::now() + std::time::Duration::from_secs(2),
    )?;
    let scope = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        super::identity::for_session(&db, &core, &c.session_id)?
    };
    drop(db);
    let now = { rt.core.lock().map_err(|_| "INTERNAL_ERROR")?.now() };
    if c.payload["step"] == "sql_dry_run" {
        return super::confirmed_sql::dry(store, &live, c, &scope, now, &permit);
    }
    let snap = super::snapshot::take(store, &live, &c.session_id, None, "pre_command", &permit)?;
    if permit.is_cancelled() || handoff.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    drop(permit);
    let writer = gate.try_begin_support(true, None).map_err(str::to_string)?;
    current(app, rt, c)?;
    let (now, end) = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let session = core.session.as_ref().ok_or("SESSION_ENDED")?;
        (
            core.now(),
            clock::parse(&session.admission.max_expires_at)
                .map_err(str::to_string)?
                .min(clock::parse(&c.expires_at).map_err(str::to_string)?),
        )
    };
    let authority_start = Instant::now();
    let remaining = end
        .checked_sub(now)
        .filter(|n| *n > 0)
        .ok_or("COMMAND_EXPIRED")? as u64;
    let _watch = watch_authority(app, c, writer.cancelled.clone())?;
    let recheck = || {
        if handoff.is_cancelled()
            || writer.is_cancelled()
            || !rt.banner_ready.load(Ordering::Acquire)
        {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        if authority_start.elapsed() >= std::time::Duration::from_millis(remaining) {
            return Err("COMMAND_EXPIRED".into());
        }
        Ok(())
    };
    recheck()?;
    match c.payload["step"].as_str() {
        Some("sql_execute") => {
            super::confirmed_sql::execute(store, &live, c, &scope, now, &writer, &snap, recheck)
        }
        Some("action") => {
            super::confirmed_actions::run(store, &live, c, &scope, now, &writer, &snap, recheck)
        }
        _ => Err("INVALID_INPUT".into()),
    }
}
