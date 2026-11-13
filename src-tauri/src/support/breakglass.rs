use super::{
    approval_verify::{Context, Verifier},
    audit_local::{self, AuditEntry},
    authorizer::{self, Policy},
    clock,
    contracts::{self, Command},
    critical_op::{self, SupportPermit},
    dry_run::{self, Stored},
    dry_run_groups,
    guards::{self, Scope},
    quarantine, replica,
    session::Runtime,
    snapshot,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

pub fn handles(kind: &str) -> bool {
    [
        "breakglass_propose_sql",
        "breakglass_propose_quarantine",
        "breakglass_propose_restore",
        "till_list_snapshots",
        "till_list_quarantine",
    ]
    .contains(&kind)
}
pub fn scope(app: &tauri::AppHandle) -> Result<Scope, String> {
    let db = super::device_apply::private_business(app)?;
    let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
    scope_from_connection(&conn)
}
pub(super) fn scope_from_connection(conn: &Connection) -> Result<Scope, String> {
    super::identity::local(conn).map_err(|_| "POLICY_REFUSED".into())
}
fn current(app: &tauri::AppHandle, rt: &Runtime, c: &Command) -> Result<Context, String> {
    if !rt.banner_ready.load(Ordering::Acquire) || !super::dispatch::window_visible(app) {
        return Err("TILL_PAUSED".into());
    }
    let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
    let s = core.session.as_ref().ok_or("SESSION_ENDED")?;
    super::delivery::recheck(c, &s.admission, &core.clock, Instant::now())
        .map_err(str::to_string)?;
    core.approval_context()
}
fn health(c: &Connection) -> Value {
    let h = super::collectors::health::collect(c).unwrap_or(Value::Null);
    let mut codes = h["issues"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| r["code"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if h["last_observation_ok"] != true {
        codes.push("health.observation_unavailable".into());
    }
    json!(codes)
}
fn wait_idle(
    app: &tauri::AppHandle,
    rt: &Runtime,
    c: &Command,
    store: &Connection,
) -> Result<(), String> {
    let mut reported = false;
    while critical_op::global().active() {
        current(app, rt, c)?;
        if !reported {
            progress(store, c, "deferred_critical_operation")?;
            reported = true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}
fn onsite(
    app: &tauri::AppHandle,
    rt: &Runtime,
    c: &Command,
    result: &Value,
    approval: &Value,
) -> Result<(), String> {
    struct Clear(String);
    impl Drop for Clear {
        fn drop(&mut self) {
            if let Ok(mut onsite) = super::onsite::global().lock() {
                if onsite.answer(&self.0, Instant::now()).is_ok() {
                    onsite.clear();
                }
            }
        }
    }
    let statement = if c.kind == "breakglass_propose_sql" {
        c.payload["sql"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("UPDATE")
            .to_ascii_uppercase()
    } else if c.kind == "breakglass_propose_quarantine" {
        "QUARANTINE".into()
    } else {
        "RESTORE".into()
    };
    let mut facts = json!({"statement_kind":statement,"rows":result["rows_affected"],"explanation_text":approval["explanation_text"]});
    if c.kind == "breakglass_propose_restore" {
        facts["restore_target"] = c.payload["target"]["kind"].clone();
    }
    let payload = json!({"request_id":c.command_id,"session_id":c.session_id,"title":"support.onsite.title","description":"support.restore.snapshotFirst","technical_details":json!({"database":c.payload["database"],"sql":c.payload["sql"],"target":c.payload["target"],"write_targets":result["write_targets"],"reads":result["reads"],"functions":result["functions"]}).to_string(),"needs_staff_pin":c.kind=="breakglass_propose_restore","remaining_ms":300000,"breakglass":facts});
    super::onsite::global()
        .lock()
        .map_err(|_| "INTERNAL_ERROR")?
        .begin(
            &c.command_id,
            &c.session_id,
            payload.clone(),
            Instant::now(),
        )?;
    let _clear = Clear(c.command_id.clone());
    app.emit("support://onsite-request", payload)
        .map_err(|_| "INTERNAL_ERROR")?;
    loop {
        current(app, rt, c)?;
        if let Some(answer) = super::onsite::global()
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .answer(&c.command_id, Instant::now())?
        {
            return if answer == "confirmed" {
                Ok(())
            } else {
                Err(answer)
            };
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
/// The caller commits immediately afterwards, with the progress/cancel hook
/// still installed. This helper performs no I/O outside the admitted database.
pub fn commit(
    c: &Connection,
    policy: &Policy,
    permit: &SupportPermit,
    id: &str,
    at: &str,
    started: Instant,
) -> Result<(), String> {
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    if started.elapsed() > Duration::from_millis(250) {
        return Err("QUERY_TIMEOUT".into());
    }
    guards::marker(c, policy, id, at)?;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    Ok(())
}
pub fn recover_outcome(c: &Connection, id: &str) -> &'static str {
    match c.query_row(
        "SELECT EXISTS(SELECT 1 FROM support_txn_marker WHERE command_id=?1)",
        [id],
        |r| r.get::<_, bool>(0),
    ) {
        Ok(true) => "succeeded",
        Ok(false) => "rolled_back",
        Err(_) => "outcome_unknown",
    }
}
pub struct WriteProof<'a> {
    pub stored: &'a Stored,
    pub cheap: &'a Value,
    pub expiry: Instant,
    pub cap: u64,
}
/// All caller-derived authority is captured before admission. Between BEGIN
/// IMMEDIATE and COMMIT this function uses only this SQLite connection, the
/// monotonic clock and the gate's atomic cancellation bit.
pub fn write_sql(
    c: &Connection,
    policy: &Policy,
    permit: &SupportPermit,
    scope: &Scope,
    sql: &str,
    proof: WriteProof<'_>,
    id: &str,
    at: &str,
) -> Result<Value, String> {
    let _native = authorizer::native_scope(policy);
    let started = Instant::now();
    let tx = permit.begin_write(c)?;
    let result = (|| {
        if Instant::now() >= proof.expiry {
            return Err("APPROVAL_EXPIRED".into());
        }
        if snapshot::cheap_watermark(c)? != *proof.cheap {
            return Err("PAYLOAD_DRIFT".into());
        }
        let bindings = proof
            .stored
            .params
            .as_ref()
            .map(|p| super::confirmed_sql::params_of(&json!({"params":p})))
            .transpose()?;
        let targets = dry_run::live_targets_bound(c, policy, sql, scope, bindings.as_deref())?;
        if dry_run::target_hash(&targets) != proof.stored.result["target_key_sha256"] {
            return Err("PAYLOAD_DRIFT".into());
        }
        dry_run_groups::verify_targets(c, &proof.stored.targets, scope)?;
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        let facts = authorizer::inspect(c, policy, sql)?;
        let before = dry_run::capture(c, facts.writes.keys().cloned())?;
        let n = if let Some(bindings) = &bindings {
            authorizer::payload_bound(c, policy, sql, bindings)?
        } else {
            authorizer::payload(c, policy, sql)?
        };
        let actual = dry_run::changed(c, &before)?;
        if n != actual.len()
            || actual.len() as u64 > proof.cap
            || actual.len() != proof.stored.targets.len()
            || dry_run::target_hash(&actual) != proof.stored.result["target_key_sha256"]
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        // Values must still be the exact outcome measured on scratch, not just
        // the same row count (e.g. a date/random/time-dependent expression).
        for actual in actual {
            let expected = proof
                .stored
                .targets
                .iter()
                .find(|t| t.table == actual.table && t.pk == actual.pk)
                .ok_or("PAYLOAD_DRIFT")?;
            if actual.after != expected.after {
                return Err("PAYLOAD_DRIFT".into());
            }
        }
        if Instant::now() >= proof.expiry {
            return Err("APPROVAL_EXPIRED".into());
        }
        // Capture under the writer reservation: a later sale must never become
        // the support change's restore baseline.
        let post = snapshot::watermarks_for_write(c, permit, started + Duration::from_millis(250))?;
        if Instant::now() >= proof.expiry {
            return Err("APPROVAL_EXPIRED".into());
        }
        commit(c, policy, permit, id, at, started)?;
        Ok(post)
    })();
    let result = match result {
        Ok(post) => tx.commit().map(|_| post).map_err(guards::error),
        Err(e) => {
            c.progress_handler(0, None::<fn() -> bool>);
            drop(tx);
            Err(e)
        }
    };
    c.progress_handler(0, None::<fn() -> bool>);
    if !c.is_autocommit() {
        let _ = c.execute_batch("ROLLBACK");
    }
    if permit.is_cancelled() && result.is_err() {
        Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
    } else {
        result
    }
}
pub fn run(
    app: &tauri::AppHandle,
    rt: &Arc<Runtime>,
    store: &Connection,
    c: &Command,
) -> Result<Value, String> {
    let live = app.state::<crate::db::DbState>().db_path.clone();
    let result = run_inner(app, rt, store, c, &live).map_err(|e| {
        if e == "deferred_critical_operation" {
            "PREEMPTED_BY_CRITICAL_OPERATION".into()
        } else {
            e
        }
    });
    let mut data = match result {
        Ok(v) => v,
        Err(e) => json!({"outcome":"failed","error_code":e}),
    };
    if data["outcome"] == "failed" {
        let outcome: Option<String> = store
            .query_row(
                "SELECT outcome FROM support_consumed_approvals WHERE command_id=?1",
                [&c.command_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(guards::error)?
            .flatten();
        if let Some(outcome) = outcome {
            data["outcome"] = json!(outcome);
        }
    }
    if let Some(approval) = &c.approval {
        let id:Option<String>=store.query_row("SELECT id FROM support_snapshots WHERE session_id=?1 AND approval_id=?2 ORDER BY taken_at DESC,rowid DESC LIMIT 1",params![c.session_id,approval["record"]["approval_id"].as_str()],|r|r.get(0)).optional().map_err(guards::error)?;
        if let Some(id) = id {
            data["snapshot"] = snapshot::metadata(store, &id)?;
        }
    }
    Ok(data)
}
fn run_inner(
    app: &tauri::AppHandle,
    rt: &Arc<Runtime>,
    store: &Connection,
    c: &Command,
    live: &Path,
) -> Result<Value, String> {
    let context = current(app, rt, c)?;
    let now = context.server_now.ok_or("APPROVAL_NOT_VERIFIED")?;
    quarantine::prune(store, &c.session_id, now)?;
    let binding = crate::repairs::acquire_terminal_binding_lease()?;
    let scope = scope(app)?;
    if scope.terminal_id != context.terminal_id {
        return Err("SESSION_ENDED".into());
    }
    let verifier = Verifier::pinned();
    if c.kind == "till_list_snapshots" || c.kind == "till_list_quarantine" {
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .map_err(str::to_string)?;
        let conn =
            replica::read_connection(live, &permit, Instant::now() + Duration::from_secs(30))?;
        return super::collectors::meta(if c.kind == "till_list_snapshots" {
            json!({"snapshots":super::restore::list(store,&conn)?})
        } else {
            json!({"groups":quarantine::list(store,&conn)?})
        });
    }
    if c.payload["step"] == "dry_run" {
        if c.approval.is_some() {
            return Err("POLICY_REFUSED".into());
        }
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .map_err(str::to_string)?;
        let result = match c.kind.as_str() {
            "breakglass_propose_sql" => dry_run::sql(
                store,
                live,
                &c.session_id,
                &c.command_id,
                &c.payload,
                &scope,
                now,
                &permit,
            ),
            "breakglass_propose_quarantine" => dry_run_groups::quarantine(
                store,
                live,
                &c.session_id,
                &c.command_id,
                &c.payload,
                &scope,
                now,
                &permit,
            ),
            "breakglass_propose_restore" => {
                let conn = replica::read_connection(
                    live,
                    &permit,
                    Instant::now() + Duration::from_secs(30),
                )?;
                dry_run_groups::restore(store, &conn, &c.session_id, &c.command_id, &c.payload, now)
            }
            _ => Err("FEATURE_DISABLED".into()),
        };
        return if permit.is_cancelled() && result.is_err() {
            Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
        } else {
            result
        };
    }
    let approval = c.approval.as_ref().ok_or("APPROVAL_NOT_VERIFIED")?;
    let kind = match c.kind.as_str() {
        "breakglass_propose_sql" => "sql",
        "breakglass_propose_quarantine" => "quarantine",
        "breakglass_propose_restore" => "restore",
        _ => return Err("FEATURE_DISABLED".into()),
    };
    let result =
        verifier.consume_breakglass(store, approval, &context, &c.command_id, kind, &c.payload)?;
    let record = dry_run::load(
        store,
        result["dry_run_id"]
            .as_str()
            .ok_or("APPROVAL_NOT_VERIFIED")?,
    )?;
    drop(binding); // Never hold a terminal lifecycle lock through a human wait.
    if kind == "restore" || !verifier.is_unattended(store, &context)? {
        progress(store, c, "awaiting_onsite")?;
        onsite(app, rt, c, &result, approval)?;
    }
    if kind == "restore" {
        super::restore::authorize(app)?;
    }
    wait_idle(app, rt, c, store)?;
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    if self::scope(app)? != scope {
        return Err("SESSION_ENDED".into());
    }
    let context = current(app, rt, c)?;
    verifier.assert_consumed_breakglass(store, approval, &context, &c.command_id, &c.payload)?;
    if kind == "restore" && c.payload["target"]["kind"] == "snapshot" {
        loop {
            match super::restore::native_restore(
                app,
                store,
                live,
                c.payload["target"]["snapshot_id"]
                    .as_str()
                    .ok_or("INVALID_INPUT")?,
                &c.session_id,
                Some(&c.command_id),
            ) {
                Err(e) if e == "deferred_critical_operation" => {
                    progress(store, c, "deferred_critical_operation")?;
                    wait_idle(app, rt, c, store)?;
                    let context = current(app, rt, c)?;
                    verifier.assert_consumed_breakglass(
                        store,
                        approval,
                        &context,
                        &c.command_id,
                        &c.payload,
                    )?;
                }
                result => {
                    result?;
                    break;
                }
            }
        }
        return Ok(
            json!({"outcome":"pending","restore":{"staged":true,"restart_required":true,"restarted":false,"notice_key":"support.restore.notices.staged","rows_lost_or_reverted":[]}}),
        );
    }
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let approval_id = approval["record"]["approval_id"]
        .as_str()
        .ok_or("APPROVAL_NOT_VERIFIED")?;
    let snap = snapshot::take(
        store,
        live,
        &c.session_id,
        Some(approval_id),
        if kind == "sql" {
            "pre_breakglass_sql"
        } else if kind == "quarantine" {
            "pre_quarantine"
        } else {
            "pre_quarantine_restore"
        },
        &permit,
    )?;
    let read = replica::read_connection(live, &permit, Instant::now() + Duration::from_secs(30))?;
    let health_before = health(&read);
    let group = if kind == "quarantine" {
        Some(uuid::Uuid::new_v4().to_string())
    } else {
        None
    };
    if let Some(group) = &group {
        quarantine::stage(
            store,
            &read,
            group,
            &c.session_id,
            Some(approval_id),
            c.payload["reason_el"].as_str().ok_or("INVALID_INPUT")?,
            &record.targets,
            &clock::iso(now),
        )?;
    }
    let copies = if let Some(group) = &group {
        Some(quarantine::load(store, group, "staged")?)
    } else if kind == "restore" {
        Some(quarantine::load(
            store,
            c.payload["target"]["group_id"]
                .as_str()
                .ok_or("INVALID_INPUT")?,
            "quarantined",
        )?)
    } else {
        None
    };
    drop(read);
    drop(permit);
    let context = current(app, rt, c)?;
    verifier.assert_consumed_breakglass(store, approval, &context, &c.command_id, &c.payload)?;
    let now = context.server_now.ok_or("APPROVAL_NOT_VERIFIED")?;
    let expires = clock::parse(
        approval["record"]["expires_at"]
            .as_str()
            .ok_or("APPROVAL_NOT_VERIFIED")?,
    )
    .map_err(str::to_string)?
    .min(clock::parse(&c.expires_at).map_err(str::to_string)?);
    let expiry = Instant::now() + Duration::from_millis(expires.saturating_sub(now).max(0) as u64);
    let (conn, policy) = guards::open(live, &scope)?;
    let _native = authorizer::native_scope(&policy);
    let permit = critical_op::global()
        .try_begin_support_write(Arc::new(conn.get_interrupt_handle()))
        .map_err(str::to_string)?;
    let cap = approval["record"]["rows_cap"]
        .as_u64()
        .ok_or("APPROVAL_NOT_VERIFIED")?;
    let executed = if kind == "sql" {
        write_sql(
            &conn,
            &policy,
            &permit,
            &scope,
            c.payload["sql"].as_str().ok_or("INVALID_INPUT")?,
            WriteProof {
                stored: &record,
                cheap: &snap.cheap,
                expiry,
                cap,
            },
            &c.command_id,
            &clock::iso(now),
        )
    } else {
        let start = Instant::now();
        let tx = permit.begin_write(&conn)?;
        let result = (|| {
            if Instant::now() >= expiry {
                return Err("APPROVAL_EXPIRED".into());
            }
            if snapshot::cheap_watermark(&conn)? != snap.cheap {
                return Err("PAYLOAD_DRIFT".into());
            }
            if kind == "quarantine" {
                let targets = dry_run_groups::expand(&conn, &c.payload["target"], &scope)?;
                if dry_run::target_hash(&targets) != record.result["target_key_sha256"] {
                    return Err("PAYLOAD_DRIFT".into());
                }
            }
            dry_run_groups::verify_targets(&conn, &record.targets, &scope)?;
            let copies = copies.as_ref().ok_or("POLICY_REFUSED")?;
            let n = if kind == "quarantine" {
                quarantine::delete_verified(&conn, &policy, &scope, copies)?
            } else {
                quarantine::restore_verified(&conn, &policy, &scope, copies)?
            };
            if n != record.targets.len() || n as u64 > cap {
                return Err("PAYLOAD_DRIFT".into());
            }
            if Instant::now() >= expiry {
                return Err("APPROVAL_EXPIRED".into());
            }
            let post =
                snapshot::watermarks_for_write(&conn, &permit, start + Duration::from_millis(250))?;
            if Instant::now() >= expiry {
                return Err("APPROVAL_EXPIRED".into());
            }
            commit(
                &conn,
                &policy,
                &permit,
                &c.command_id,
                &clock::iso(now),
                start,
            )?;
            Ok(post)
        })();
        let result = match result {
            Ok(post) => tx.commit().map(|_| post).map_err(guards::error),
            Err(e) => {
                conn.progress_handler(0, None::<fn() -> bool>);
                drop(tx);
                Err(e)
            }
        };
        conn.progress_handler(0, None::<fn() -> bool>);
        if !conn.is_autocommit() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    };
    conn.progress_handler(0, None::<fn() -> bool>);
    let outcome = recover_outcome(&conn, &c.command_id);
    store
        .execute(
            "UPDATE support_consumed_approvals SET outcome=?1 WHERE command_id=?2",
            params![outcome, c.command_id],
        )
        .map_err(guards::error)?;
    if let Some(group) = &group {
        let _ = quarantine::reconcile(store, &conn, group, &c.command_id);
    }
    if outcome == "succeeded" {
        if let Ok(post) = &executed {
            store
                .execute(
                    "UPDATE support_snapshots SET post_change_watermark_json=?1 WHERE id=?2",
                    params![post.to_string(), snap.id],
                )
                .map_err(guards::error)?;
        }
        if kind == "restore" {
            quarantine::mark_restored(
                store,
                c.payload["target"]["group_id"]
                    .as_str()
                    .ok_or("INVALID_INPUT")?,
                &clock::iso(now),
            )?;
        }
    }
    let code = if outcome == "outcome_unknown" {
        Some("OUTCOME_UNKNOWN".into())
    } else if permit.is_cancelled() && executed.is_err() {
        Some("PREEMPTED_BY_CRITICAL_OPERATION".into())
    } else {
        executed.err()
    };
    Ok(
        json!({"outcome":outcome,"error_code":code,"rollback_reason":if outcome=="rolled_back"{Some(match code.as_deref(){Some("PREEMPTED_BY_CRITICAL_OPERATION")=>"preempted_by_critical_operation",Some("PAYLOAD_DRIFT")=>"payload_drift",Some("PROTECTED_RECORD")=>"protected_record",Some("APPROVAL_EXPIRED")=>"approval_expired",_=>"error"})}else{None},"counts":if outcome=="succeeded"{result["rows_affected"].clone()}else{json!([])},"samples":if outcome=="succeeded"{result["samples"].clone()}else{json!([])},"snapshot_id":snap.id,"quarantine_group_id":group,"health_before":health_before,"health_after":health(&conn),"command":null,"restore":null,"finished_at":clock::iso(now)}),
    )
}
pub fn local_audit(store: &Connection, phase: &str, code: Option<&str>) -> Result<(), String> {
    let tx = super::db::transaction(store).map_err(guards::error)?;
    audit_local::append(
        &tx,
        &AuditEntry {
            terminal_seq: 0,
            session_id: None,
            command_id: None,
            phase: phase.into(),
            status: code.map(str::to_string),
            outcome: if phase == "finished" {
                Some("succeeded".into())
            } else {
                None
            },
            input_sha256: None,
            result_sha256: None,
            created_at: clock::iso(chrono::Utc::now().timestamp_millis()),
        },
    )
    .map_err(guards::error)?;
    tx.commit().map_err(guards::error)
}
pub fn local_restore_group(
    app: &tauri::AppHandle,
    store: &Connection,
    live: &Path,
    group: &str,
) -> Result<(), String> {
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    let scope = scope(app)?;
    let copies = quarantine::load(store, group, "quarantined")?;
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let session = super::session::runtime(app)?
        .core
        .lock()
        .map_err(|_| "INTERNAL_ERROR")?
        .session
        .as_ref()
        .map(|s| s.info.session_id.clone())
        .unwrap_or_else(|| format!("onsite:{}", uuid::Uuid::new_v4()));
    let snap = snapshot::take(
        store,
        live,
        &session,
        None,
        "pre_quarantine_restore",
        &permit,
    )?;
    drop(permit);
    super::restore::authorize(app)?;
    let (c, policy) = guards::open(live, &scope)?;
    let _native = authorizer::native_scope(&policy);
    let permit = critical_op::global()
        .try_begin_support_write(Arc::new(c.get_interrupt_handle()))
        .map_err(str::to_string)?;
    let start = Instant::now();
    let tx = permit.begin_write(&c)?;
    let id = uuid::Uuid::new_v4().to_string();
    let result = (|| {
        if snapshot::cheap_watermark(&c)? != snap.cheap {
            return Err("PAYLOAD_DRIFT".into());
        }
        quarantine::restore_verified(&c, &policy, &scope, &copies)?;
        let post = snapshot::watermarks_for_write(&c, &permit, start + Duration::from_millis(250))?;
        commit(
            &c,
            &policy,
            &permit,
            &id,
            &clock::iso(chrono::Utc::now().timestamp_millis()),
            start,
        )?;
        Ok(post)
    })();
    let result = match result {
        Ok(post) => tx.commit().map(|_| post).map_err(guards::error),
        Err(e) => {
            c.progress_handler(0, None::<fn() -> bool>);
            drop(tx);
            Err(e)
        }
    };
    c.progress_handler(0, None::<fn() -> bool>);
    let post = result?;
    quarantine::mark_restored(
        store,
        group,
        &clock::iso(chrono::Utc::now().timestamp_millis()),
    )?;
    store
        .execute(
            "UPDATE support_snapshots SET post_change_watermark_json=?1 WHERE id=?2",
            params![post.to_string(), snap.id],
        )
        .map_err(guards::error)?;
    Ok(())
}
pub fn finish(store: &Connection, c: &Command, data: Value, now: i64) -> Result<(), String> {
    let outcome = if c.kind == super::confirmed::KIND {
        match data["outcome"].as_str() {
            Some("unknown") => "outcome_unknown",
            Some("failed") => "failed",
            _ => "succeeded",
        }
    } else {
        data["outcome"].as_str().unwrap_or("succeeded")
    };
    let code = data["error_code"].as_str();
    let started: Option<String> = store
        .query_row(
            "SELECT started_at FROM support_accepted_commands WHERE command_id=?1",
            [&c.command_id],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    let mut result = json!({"command_id":c.command_id,"session_id":c.session_id,"status":if outcome=="succeeded"{"completed"}else{"failed"},"outcome":outcome,"data":data,"timings":{"accepted_at":c.server_time,"started_at":started,"finished_at":clock::iso(now),"ms":started.as_deref().and_then(|s|clock::parse(s).ok()).map_or(0,|s|now.saturating_sub(s).max(0))}});
    if let Some(code) = code {
        result["error_code"] = json!(
            if contracts::shared().error_codes.iter().any(|s| s == code) {
                code
            } else {
                "INTERNAL_ERROR"
            }
        );
    }
    result["result_sha256"] = json!(contracts::payload_hash(&result));
    let encoded = result.to_string();
    if encoded.len() as u64 > contracts::cap("tools", "resultBytes") {
        return Err("RESULT_TOO_LARGE".into());
    }
    let tx = super::db::transaction(store).map_err(guards::error)?;
    if tx.execute("UPDATE support_accepted_commands SET state='finished',finished_at=?1,outcome=?2,result_json=?3,result_bytes=?4 WHERE command_id=?5 AND finished_at IS NULL",params![clock::iso(now),outcome,encoded,encoded.len(),c.command_id]).map_err(guards::error)?!=1{return Err("INVALID_INPUT".into());}
    tx.execute("INSERT INTO support_result_outbox VALUES(?1,?2,?3,?4,0) ON CONFLICT(command_id) DO UPDATE SET result_json=excluded.result_json,created_ms=excluded.created_ms,delivered=0",params![c.command_id,c.session_id,encoded,now]).map_err(guards::error)?;
    tx.execute(
        "UPDATE support_session_state SET result_bytes=result_bytes+?1 WHERE session_id=?2",
        params![encoded.len(), c.session_id],
    )
    .map_err(guards::error)?;
    audit_local::append(
        &tx,
        &AuditEntry {
            terminal_seq: 0,
            session_id: Some(c.session_id.clone()),
            command_id: Some(c.command_id.clone()),
            phase: "finished".into(),
            status: code.map(str::to_string),
            outcome: Some(outcome.into()),
            input_sha256: Some(c.payload_sha256.clone()),
            result_sha256: result["result_sha256"].as_str().map(str::to_string),
            created_at: clock::iso(now),
        },
    )
    .map_err(guards::error)?;
    super::confirmed::event(&tx, c, "confirmed_command_finished", now)?;
    tx.commit().map_err(guards::error)
}
fn progress(store: &Connection, c: &Command, status: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut result = json!({"command_id":c.command_id,"session_id":c.session_id,"status":status,"outcome":"pending","timings":{"accepted_at":c.server_time,"finished_at":clock::iso(now),"ms":0}});
    result["result_sha256"] = json!(contracts::payload_hash(&result));
    store.execute("INSERT INTO support_result_outbox VALUES(?1,?2,?3,?4,0) ON CONFLICT(command_id) DO UPDATE SET result_json=excluded.result_json,created_ms=excluded.created_ms,delivered=0",params![c.command_id,c.session_id,result.to_string(),now]).map_err(guards::error)?;
    Ok(())
}
/// Runs before generic executor recovery. Never repeats a started payload.
pub fn recover(store: &Connection, live: &Path, skip: Option<&str>) -> Result<(), String> {
    let c = Connection::open_with_flags(live, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
    let rows=guards::rows(store,"SELECT command_id,envelope_json,state FROM support_accepted_commands WHERE started_at IS NOT NULL AND finished_at IS NULL AND kind IN ('breakglass_propose_sql','breakglass_propose_quarantine','breakglass_propose_restore')",&[])?;
    for row in rows {
        let id = row["command_id"].as_str().ok_or("INTERNAL_ERROR")?;
        if skip == Some(id) {
            continue;
        }
        let command: Command =
            serde_json::from_str(row["envelope_json"].as_str().ok_or("INTERNAL_ERROR")?)
                .map_err(|_| "INTERNAL_ERROR")?;
        let outcome = if command.kind == "breakglass_propose_restore"
            && command.payload["target"]["kind"] == "snapshot"
        {
            match row["state"].as_str() {
                Some("restore_swapped") => "succeeded",
                Some("restore_rolled_back") => "rolled_back",
                _ => "outcome_unknown",
            }
        } else {
            c.as_ref()
                .map(|c| recover_outcome(c, id))
                .unwrap_or("outcome_unknown")
        };
        if let Ok(c) = &c {
            let _ = quarantine::recover(store, c);
        }
        store
            .execute(
                "UPDATE support_consumed_approvals SET outcome=?1 WHERE command_id=?2",
                params![outcome, id],
            )
            .map_err(guards::error)?;
        let mut data =
            json!({"outcome":outcome,"verification_required":outcome=="outcome_unknown"});
        if outcome == "outcome_unknown" {
            data["error_code"] = json!("OUTCOME_UNKNOWN");
        }
        if let Some(a) = &command.approval {
            let snap:Option<String>=store.query_row("SELECT id FROM support_snapshots WHERE approval_id=?1 ORDER BY taken_at DESC,rowid DESC LIMIT 1",[a["record"]["approval_id"].as_str()],|r|r.get(0)).optional().map_err(guards::error)?;
            if let Some(id) = snap {
                data["snapshot"] = snapshot::metadata(store, &id)?;
            }
        }
        finish(store, &command, data, chrono::Utc::now().timestamp_millis())?;
    }
    Ok(())
}
