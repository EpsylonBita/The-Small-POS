//! Renderer execution bridge. Native code owns the closed catalogue and final report.
use super::{contracts::Command, critical_op, delivery, onsite, remedies};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
#[derive(Clone)]
struct Pending {
    command: Command,
    at: Instant,
    before: Vec<String>,
    running: bool,
    execution_at: Option<i64>,
    correction_key: Option<String>,
}
fn pending() -> &'static Mutex<BTreeMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<BTreeMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(Mutex::default)
}
pub fn clear() {
    if let Ok(mut p) = pending().lock() {
        p.clear();
    }
}
pub fn handles(kind: &str) -> bool {
    [
        "till_list_remedies",
        "till_run_remedy",
        "till_request_physical_check",
    ]
    .contains(&kind)
}
fn native_observation(app: &tauri::AppHandle) -> Result<(Vec<String>, bool, Option<i64>), String> {
    let db = app.state::<crate::db::DbState>();
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let conn = super::replica::read_connection(
        &db.db_path,
        &permit,
        Instant::now() + Duration::from_millis(500),
    )?;
    let health = super::collectors::health::collect(&conn)?;
    let codes = health["issues"]
        .as_array()
        .ok_or("REMEDY_NOT_APPLICABLE")?
        .iter()
        .filter_map(|v| v["code"].as_str().map(str::to_string))
        .collect();
    let at = health["last_observation_at"]
        .as_str()
        .and_then(|at| super::clock::parse(at).ok());
    Ok((codes, health["last_observation_ok"] == true, at))
}
pub fn begin(app: &tauri::AppHandle, c: &Command) -> Result<(), String> {
    if c.kind == "till_run_remedy" {
        remedies::recipe(
            c.payload["recipe_id"].as_str().ok_or("INVALID_INPUT")?,
            c.payload["recipe_version"]
                .as_u64()
                .ok_or("INVALID_INPUT")?,
        )?;
    }
    let correction = c.kind == "till_run_remedy"
        && c.payload["recipe_id"]
            .as_str()
            .is_some_and(remedies::is_correction);
    let correction_key = if correction {
        let read = super::matcher::MatcherRead::open(&app.state::<crate::db::DbState>().db_path)?;
        let conn = read.db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        super::identity::observed_session(&conn, &read.db.db_path, &c.session_id)?;
        let notices = remedies::correction_notices(&conn, c.payload["target_key"].as_str())?;
        if notices.len() != 1 {
            return Err("REMEDY_NOT_APPLICABLE".into());
        }
        Some(
            notices[0]["queueId"]
                .as_str()
                .ok_or("REMEDY_NOT_APPLICABLE")?
                .to_owned(),
        )
    } else {
        None
    };
    let before = if correction_key.is_some() {
        vec!["customer_correction_refused".to_owned()]
    } else if c.kind == "till_list_remedies" {
        vec![]
    } else {
        native_observation(app)?.0
    };
    pending().lock().map_err(|_| "INTERNAL_ERROR")?.insert(
        c.command_id.clone(),
        Pending {
            command: c.clone(),
            at: Instant::now(),
            before,
            running: false,
            execution_at: None,
            correction_key,
        },
    );
    if c.kind == "till_request_physical_check" {
        let check = c.payload["check_id"].as_str().ok_or("INVALID_INPUT")?;
        let catalogue = &super::contracts::shared().other["physical_checks"];
        let label = catalogue[check].as_str().unwrap_or(check);
        onsite::request(
            app,
            &c.command_id,
            &c.session_id,
            label,
            label,
            &json!({"check_id":check}),
            false,
            Some(check),
            true,
        )?;
    } else {
        app.emit("till_list_remedies", json!({"request_id":c.command_id}))
            .map_err(|_| "INTERNAL_ERROR")?;
    }
    Ok(())
}

/// Invoked by recovery_execute_action, after the app's PIN dialog has had a
/// chance to run, and before any manual recovery owner is called.
pub fn authorize_execution(
    app: &tauri::AppHandle,
    request: &Value,
) -> Result<(), crate::auth::GuardedCommandError> {
    let id = request["supportRequestId"]
        .as_str()
        .ok_or("PAYLOAD_MISMATCH")?;
    let p = pending()
        .lock()
        .map_err(|_| "INTERNAL_ERROR")?
        .get(id)
        .cloned()
        .filter(|p| p.running)
        .ok_or("PAYLOAD_MISMATCH")?;
    let fresh = if let Some(target) = &p.correction_key {
        let read = super::matcher::MatcherRead::open(&app.state::<crate::db::DbState>().db_path)?;
        let conn = read.db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        super::identity::observed_session(&conn, &read.db.db_path, &p.command.session_id)?;
        remedies::correction_notices(&conn, Some(target))?.len() == 1
    } else {
        native_observation(app)?.1
    };
    let audit_db = super::device_apply::private_business(app)?;
    let rt = super::session::runtime(app)?;
    let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
    authorize_execution_in_context(
        request,
        &p,
        fresh,
        &core,
        &audit_db,
        &app.state::<crate::auth::AuthState>(),
        onsite::global(),
    )?;
    pending()
        .lock()
        .map_err(|_| "INTERNAL_ERROR")?
        .get_mut(id)
        .ok_or("PAYLOAD_MISMATCH")?
        .execution_at = Some(chrono::Utc::now().timestamp_millis());
    Ok(())
}

fn authorize_execution_in_context(
    request: &Value,
    p: &Pending,
    fresh: bool,
    core: &super::session::Core,
    audit_db: &crate::db::DbState,
    auth: &crate::auth::AuthState,
    onsite: &Mutex<onsite::Onsite>,
) -> Result<(), crate::auth::GuardedCommandError> {
    let id = request["supportRequestId"]
        .as_str()
        .ok_or("PAYLOAD_MISMATCH")?;
    let c = &p.command;
    let r = remedies::recipe(
        c.payload["recipe_id"].as_str().ok_or("INVALID_INPUT")?,
        c.payload["recipe_version"]
            .as_u64()
            .ok_or("INVALID_INPUT")?,
    )?;
    if request["sessionId"] != c.session_id
        || request["recipeId"] != r.id
        || request["recipeVersion"] != r.version
        || request["actionId"] != r.action_id
    {
        return Err("PAYLOAD_MISMATCH".into());
    }
    if let Some(key) = &p.correction_key {
        if request["params"]["queueId"] != key.as_str() || request["entityId"] != key.as_str() {
            return Err("PAYLOAD_MISMATCH".into());
        }
    }
    if critical_op::global().active() {
        return Err("CONCURRENT_OPERATION".into());
    }
    if !fresh {
        return Err("REMEDY_NOT_APPLICABLE".into());
    }
    let session = core.session.as_ref().ok_or("SESSION_ENDED")?;
    delivery::recheck(c, &session.admission, &core.clock, Instant::now())
        .map_err(str::to_string)?;
    let unattended = core.approval_context().ok().is_some_and(|context| {
        core.verifier
            .is_unattended(&core.executor.db.conn, &context)
            .unwrap_or(false)
    });
    if r.needs_onsite && !unattended {
        let answer = onsite
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .answer(id, Instant::now())?;
        match answer.as_deref() {
            Some("confirmed") => {}
            Some("ONSITE_TIMEOUT") => return Err("ONSITE_TIMEOUT".into()),
            _ => return Err("ONSITE_DECLINED".into()),
        }
    }
    let snapshot = {
        let conn = audit_db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        recovery_audit(&conn, c, r)?.1
    };
    if p.correction_key.is_some() && request["snapshotPointId"].as_str() != snapshot.as_deref() {
        return Err("SNAPSHOT_FAILED".into());
    }
    if r.requires_snapshot {
        let points = crate::recovery::list_recovery_points(audit_db)?;
        if !points.iter().any(|point| {
            Some(&point.id) == snapshot.as_ref()
                && point.kind == crate::recovery::RecoveryPointKind::PreRecoveryAction
                && std::path::Path::new(&point.snapshot_path).is_file()
        }) {
            return Err("SNAPSHOT_FAILED".into());
        }
    }
    if r.needs_staff_pin {
        authorize_cash_drawer(audit_db, auth, core, &c.session_id)?;
    }
    Ok(())
}

pub(crate) fn authorize_recovery_cash_drawer(
    app: &tauri::AppHandle,
    session: &str,
) -> Result<(), crate::auth::GuardedCommandError> {
    let db = super::device_apply::private_business(app)?;
    let rt = super::session::runtime(app)?;
    let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
    authorize_cash_drawer(&db, &app.state::<crate::auth::AuthState>(), &core, session)
}

/// Uses a private support connection and the same bound terminal as delivery.
pub(crate) fn authorize_cash_drawer(
    db: &crate::db::DbState,
    auth: &crate::auth::AuthState,
    core: &super::session::Core,
    session: &str,
) -> Result<(), crate::auth::GuardedCommandError> {
    let scope = {
        let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        super::identity::for_session(&conn, core, session)?
    };
    crate::auth::authorize_support_cash_drawer(db, auth, &scope.terminal_id)?;
    Ok(())
}

pub fn recovery_audit(
    conn: &rusqlite::Connection,
    c: &Command,
    r: &remedies::Remedy,
) -> Result<(String, Option<String>), String> {
    let prefix = format!("support:{}:", c.command_id);
    let record: Option<(String, Option<String>)> = conn.query_row(
        "SELECT id,snapshot_point_id FROM recovery_action_log WHERE recipe_id=?1 AND recipe_version=?2 AND action_id=?3 AND substr(id,1,length(?4))=?4 AND json_extract(payload_json,'$.source')='remote_support' AND json_extract(payload_json,'$.sessionId')=?5 ORDER BY created_at DESC LIMIT 1",
        rusqlite::params![r.id, r.version, r.action_id, prefix, c.session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map_err(|_| "REMEDY_NOT_APPLICABLE")?;
    let record = record.ok_or("REMEDY_NOT_APPLICABLE")?;
    if r.requires_snapshot && record.1.is_none() {
        return Err("SNAPSHOT_FAILED".into());
    }
    Ok(record)
}

pub fn app_refusal(value: &Value) -> Option<&str> {
    value.as_str().filter(|code| {
        [
            "FORBIDDEN",
            "UNAUTHORIZED",
            "REAUTH_REQUIRED",
            "POLICY_REFUSED",
            "CONCURRENT_OPERATION",
            "REMEDY_NOT_APPLICABLE",
            "REMEDY_COOLDOWN",
            "REMEDY_ATTEMPT_CAP",
        ]
        .contains(code)
    })
}

pub fn verified_native_outcome(
    fresh: bool,
    before: &[String],
    after: &[String],
    persisted: Option<&str>,
) -> &'static str {
    if !fresh {
        return "unknown";
    }
    if persisted == Some("pending") {
        return "pending";
    }
    if persisted == Some("failed") || before.iter().any(|code| after.contains(code)) {
        return "failed";
    }
    if persisted == Some("resolved") && !before.is_empty() {
        return "resolved";
    }
    verified_outcome(fresh, after)
}
pub fn tick(
    app: &tauri::AppHandle,
    rt: &std::sync::Arc<super::session::Runtime>,
) -> Result<(), String> {
    if critical_op::global().active() {
        onsite::global()
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .reset_during_critical();
    }
    let work: Vec<Pending> = pending()
        .lock()
        .map_err(|_| "INTERNAL_ERROR")?
        .values()
        .cloned()
        .collect();
    for p in work {
        let c = &p.command;
        let onsite_answer = onsite::global()
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .answer(&c.command_id, Instant::now())
            .ok()
            .flatten();
        let answer = if c.kind == "till_request_physical_check" {
            onsite_answer
        } else {
            None
        };
        if answer.is_none() && p.at.elapsed() < Duration::from_secs(300) {
            continue;
        }
        let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let now = core.now();
        let still_executing:bool=core.executor.db.conn.query_row("SELECT EXISTS(SELECT 1 FROM support_accepted_commands WHERE command_id=?1 AND state='executing')",[&c.command_id],|r|r.get(0)).map_err(|_|"INTERNAL_ERROR")?;
        if still_executing {
            if answer
                .as_deref()
                .is_some_and(|s| s == "done" || s == "not_done")
            {
                core.executor.finish(c,json!({"observation_time":super::clock::iso(now),"app_version":env!("CARGO_PKG_VERSION"),"check_id":c.payload["check_id"],"answer":answer,"answered_at":super::clock::iso(now)}),now)?;
            } else {
                core.executor
                    .fail(c, answer.as_deref().unwrap_or("ONSITE_TIMEOUT"), now)?;
            }
        }
        pending()
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .remove(&c.command_id);
    }
    let _ = app;
    Ok(())
}
#[tauri::command]
pub async fn till_list_remedies(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("till_list_remedies",move || {
        let input=arg0.ok_or("INVALID_INPUT")?;
        let id=input["request_id"].as_str().ok_or("INVALID_INPUT")?;
        let p=pending().lock().map_err(|_|"INTERNAL_ERROR")?.get(id).cloned().ok_or("PAYLOAD_MISMATCH")?;
        if p.running {return Err("PAYLOAD_MISMATCH".into())}
        let rt=super::session::runtime(&app)?;
        let confirmed_previews = if p.command.kind == "till_list_remedies" {
            (|| {
                let path = app.state::<crate::db::DbState>().db_path.clone();
                let db = crate::db::DbState {
                    conn: Mutex::new(crate::order_notice_recovery::observer_connection(&path,false)?),
                    db_path:path,
                };
                let permit = critical_op::global().try_begin_support(false,None).map_err(str::to_string)?;
                let read = super::replica::read_connection(&db.db_path,&permit,Instant::now()+Duration::from_secs(2))?;
                let scope = super::identity::observed_session(&read,&db.db_path,&p.command.session_id)?;
                drop(read);
                super::confirmed_recovery::correction_previews(&db,&scope,&permit,|| {
                    if permit.is_cancelled() {return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());}
                    let core = rt.core.lock().map_err(|_|"INTERNAL_ERROR")?;
                    let session = core.session.as_ref().ok_or("SESSION_ENDED")?;
                    delivery::recheck(&p.command,&session.admission,&core.clock,Instant::now()).map_err(str::to_string)
                })
            })().unwrap_or_default()
        } else { Vec::new() };
        let mut core=rt.core.lock().map_err(|_|"INTERNAL_ERROR")?;
        let now=core.now(); let session=core.session.as_ref().ok_or("SESSION_ENDED")?;
        delivery::recheck(&p.command,&session.admission,&core.clock,Instant::now()).map_err(str::to_string)?;
        let matches: Vec<remedies::Match> = if input["error"].is_string() {
            if p.command.kind != "till_list_remedies" && p.correction_key.is_none() {
                core.executor.fail(&p.command,"REMEDY_NOT_APPLICABLE",now)?;
                pending().lock().map_err(|_|"INTERNAL_ERROR")?.remove(id);
                return Ok(json!({"accepted":true}));
            }
            Vec::new()
        } else { serde_json::from_value(input["remedies"].clone()).map_err(|_|"INVALID_INPUT")? };
        if matches.len()>64 || matches.iter().any(|m|m.title.len()>2400||m.explanation.len()>8000||m.target_count>100000||!(m.matches_now==true||m.matches_now==false||m.matches_now=="not_applicable")) {return Err("INVALID_INPUT".into())}
        let db=app.state::<crate::db::DbState>();
        let permit=critical_op::global().try_begin_support(false,None).map_err(str::to_string)?;
        let conn=super::replica::read_connection(&db.db_path,&permit,Instant::now()+Duration::from_millis(500))?;
        let organization_id=super::collectors::setting(&conn,"terminal","organization_id").or_else(||super::collectors::setting(&conn,"organization","id"));
        if p.command.kind=="till_list_remedies" {
            let rows:Result<Vec<Value>,String>=remedies::shipped().iter().map(|r|{
                let m=matches.iter().find(|m|m.id==r.id&&m.version==r.version);
                let native = remedies::is_correction(&r.id).then(||remedies::correction_match(&conn,r,None,m));
                Ok(remedies::summarize(r,native.as_ref().or(m),&remedies::budget(&conn,r,None)?,now))
            }).collect();
            drop(conn);drop(permit);core.executor.finish(&p.command,json!({"observation_time":super::clock::iso(now),"app_version":env!("CARGO_PKG_VERSION"),"remedies":rows?,"confirmed_previews":confirmed_previews}),now)?;
            pending().lock().map_err(|_|"INTERNAL_ERROR")?.remove(id);
        } else {
            let c=&p.command;
            let r=remedies::recipe(c.payload["recipe_id"].as_str().ok_or("INVALID_INPUT")?,c.payload["recipe_version"].as_u64().ok_or("INVALID_INPUT")?)?;
            let eligibility=(||{
                let wording=matches.iter().find(|m|m.id==r.id&&m.version==r.version);
                let (m,stale) = if let Some(target)=p.correction_key.as_deref() {
                    (remedies::correction_match(&conn,r,Some(target),wording),false)
                } else {
                    (wording.cloned().ok_or("REMEDY_NOT_APPLICABLE")?,super::collectors::health::collect(&conn)?["last_observation_ok"]!=true)
                };
                let target = p.correction_key.as_deref().or_else(|| c.payload["target_key"].as_str());
                remedies::eligible(r,&m,&remedies::budget(&conn,r,target)?,now,stale,critical_op::global().active())?;
                Ok::<_,String>(m)
            })();
            drop(conn);drop(permit);
            let m=match eligibility {Ok(m)=>m,Err(code)=>{
                core.executor.fail(c,&code,now)?;
                pending().lock().map_err(|_|"INTERNAL_ERROR")?.remove(id);
                return Ok(json!({"accepted":true}));
            }};
            let unattended=core.approval_context().ok().is_some_and(|context|core.verifier.is_unattended(&core.executor.db.conn,&context).unwrap_or(false));
            if r.mutates_data && !unattended {onsite::request(&app,id,&c.session_id,&m.title,&m.explanation,&json!({"recipe_id":r.id,"recipe_version":r.version,"target_key":c.payload["target_key"]}),r.needs_staff_pin,None,false)?;}
            pending().lock().map_err(|_|"INTERNAL_ERROR")?.get_mut(id).ok_or("PAYLOAD_MISMATCH")?.running=true;
            let mut event=json!({"request_id":id,"session_id":c.session_id,"recipe_id":r.id,"recipe_version":r.version,"unattended":unattended,"unattended_verified":unattended,"organization_id":organization_id});
            if let Some(target)=p.correction_key.as_deref().or_else(||c.payload["target_key"].as_str()){
                event["target_key"]=json!(target);
            }
            app.emit("support://run-remedy",event).map_err(|_|"INTERNAL_ERROR")?;
        }
        Ok(json!({"accepted":true}))
    }).await
}
#[tauri::command]
pub async fn support_remedy_result(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("support_remedy_result",move || {
        let input=arg0.ok_or("INVALID_INPUT")?;
        let id=input["request_id"].as_str().ok_or("INVALID_INPUT")?;
        let p=pending().lock().map_err(|_|"INTERNAL_ERROR")?.get(id).cloned().filter(|p|p.running).ok_or("PAYLOAD_MISMATCH")?;
        let c=&p.command;
        if input["session_id"]!=c.session_id {return Err("PAYLOAD_MISMATCH".into())}
        let (after,observed,observed_at)=if p.correction_key.is_some(){
            (vec![],false,None)
        } else {native_observation(&app).unwrap_or((p.before.clone(),false,None))};
        let fresh=observed && p.execution_at.zip(observed_at).is_some_and(|(start,at)|at > start);
        let rt=super::session::runtime(&app)?;let mut core=rt.core.lock().map_err(|_|"INTERNAL_ERROR")?;
        let session=core.session.as_ref().ok_or("SESSION_ENDED")?;
        delivery::recheck(c,&session.admission,&core.clock,Instant::now()).map_err(str::to_string)?;
        let now=core.now();
        let r=remedies::recipe(c.payload["recipe_id"].as_str().ok_or("INVALID_INPUT")?,c.payload["recipe_version"].as_u64().ok_or("INVALID_INPUT")?)?;
        let result=(|| {
            if let Some(error)=input["error"].as_str() {return Err(if ["REMEDY_NOT_APPLICABLE","REMEDY_COOLDOWN","REMEDY_ATTEMPT_CAP","SNAPSHOT_FAILED","INSUFFICIENT_DISK","CONCURRENT_OPERATION","ONSITE_TIMEOUT","ONSITE_DECLINED","PAYLOAD_MISMATCH"].contains(&error){error.to_string()}else{"REMEDY_NOT_APPLICABLE".into()})}
            let unattended=core.approval_context().ok().is_some_and(|context|core.verifier.is_unattended(&core.executor.db.conn,&context).unwrap_or(false));
            if r.mutates_data && !unattended {
                let answer=onsite::global().lock().map_err(|_|"INTERNAL_ERROR")?.answer(id,Instant::now())?;
                if answer.as_deref()!=Some("confirmed"){return Err("ONSITE_DECLINED".into())}
            }
            // An acknowledgement cannot establish recovery. This DB-only Health
            // observation cannot prove external device/network state fresh.
            let audit_db=super::device_apply::private_business(&app)?;
            let audit_conn=audit_db.conn.lock().map_err(|_|"INTERNAL_ERROR")?;
            let (recovery_id,snapshot_id)=recovery_audit(&audit_conn,c,r)?;
            let target=p.correction_key.as_deref().or_else(||c.payload["target_key"].as_str());
            let persisted=remedies::native_outcome(&audit_conn,r,target,p.execution_at)?;
            let (outcome,fresh,after)=if p.correction_key.is_some() {
                let outcome=persisted.as_deref().unwrap_or("unknown");
                (outcome,persisted.is_some(),if outcome=="resolved"{vec![]}else{p.before.clone()})
            } else {
                (verified_native_outcome(fresh,&p.before,&after,persisted.as_deref()),fresh,after)
            };
            drop(audit_conn);
            let data=json!({"observation_time":super::clock::iso(now),"app_version":env!("CARGO_PKG_VERSION"),"recipe_id":r.id,"recipe_version":r.version,"outcome":outcome,"onsite":if unattended{"unattended_verified"}else if r.mutates_data{"confirmed"}else{"not_required"},"pin_gate":if r.needs_staff_pin{"approved"}else{"not_required"},"verification":{"method":"fresh_native_health","checked_at":super::clock::iso(now),"evidence":[{"key":"issue_count","before":p.before.len(),"after":if fresh{Some(after.len())}else{None}}]},"health_before":p.before,"health_after":after,"recovery_audit_id":recovery_id,"snapshot_id":snapshot_id,"targets_applied":input["targets_applied"].as_u64().unwrap_or(0),"app_refusal":app_refusal(&input["app_refusal"])});
            Ok(data)
        })();
        match result {Ok(data)=>core.executor.finish(c,data,now)?,Err(code)=>{
            // Keep the allowlisted refusal; if even that cannot fit, still close the command.
            if core.executor.fail_with_data(c,&code,json!({"app_refusal":app_refusal(&input["app_refusal"])}),now).is_err() { core.executor.fail(c,&code,now)?; }
        },}
        pending().lock().map_err(|_|"INTERNAL_ERROR")?.remove(id);onsite::global().lock().map_err(|_|"INTERNAL_ERROR")?.clear();
        Ok(json!({"accepted":true}))
    }).await
}
pub fn verified_outcome(fresh: bool, after: &[String]) -> &'static str {
    if !fresh {
        "unknown"
    } else if after.is_empty() {
        "pending"
    } else {
        "failed"
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn remote_admission_fixture(
        terminal: &str,
    ) -> (
        crate::tests::harness::TempDir,
        super::super::session::Core,
        Command,
    ) {
        let root = crate::tests::harness::TempDir::new();
        let mut core = super::super::session::Core::new(
            super::super::db::SupportDb::open(root.path()).unwrap(),
        )
        .unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-commands.json"
        ))
        .unwrap();
        let command: Command =
            serde_json::from_value(fixture["response"]["commands"][0].clone()).unwrap();
        core.terminal_id = Some(terminal.into());
        core.adopt(
            super::super::transport::SessionInfo {
                confirmation_mode: None,
                session_id: command.session_id.clone(),
                operator_display_name: "Your support".into(),
                tier_ceiling: 2,
                max_expires_at: command.expires_at.clone(),
                absolute_cap_at: command.expires_at.clone(),
                idle_timeout_s: 300,
                ack_deadline_at: command.expires_at.clone(),
                doorbell_topic: format!("support:session:{}", command.session_id),
                resume_allowed: false,
            },
            &command.server_time,
        )
        .unwrap();
        {
            let session = core.session.as_mut().unwrap();
            session.admission.active = true;
            session.admission.online = true;
            session.admission.visible = true;
            session.admission.tiers_enabled = [1, 2].into_iter().collect();
        }
        (root, core, command)
    }

    pub(crate) fn authorize_address_retry_for_test(
        db: &crate::db::DbState,
        auth: &crate::auth::AuthState,
        target: &str,
    ) -> Value {
        let terminal = super::super::identity::local(&db.conn.lock().unwrap())
            .unwrap()
            .terminal_id;
        let (_root, core, mut command) = remote_admission_fixture(&terminal);
        let recipe = remedies::recipe("customer-address-default.retry", 1).unwrap();
        command.kind = "till_run_remedy".into();
        command.tier = 2;
        command.payload = json!({"recipe_id":recipe.id,"recipe_version":1,"target_key":target,
            "reason":"your-reason","idempotency_key":"your-remedy-attempt-key"});
        command.payload_sha256 = super::super::contracts::payload_hash(&command.payload);
        let request = json!({"source":"remote_support","supportRequestId":command.command_id,
            "sessionId":command.session_id,"recipeId":recipe.id,"recipeVersion":1,
            "actionId":recipe.action_id,"entityId":target});
        let snapshot = crate::recovery::create_pre_recovery_action_snapshot(db).unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO recovery_action_log(id,action_id,issue_code,recipe_id,recipe_version,entity_id,snapshot_point_id,payload_json) VALUES(?1,?2,'CUSTOMER_ADDRESS_DEFAULT_CONFLICT',?3,1,?4,?5,?6)",
            rusqlite::params![format!("support:{}:{target}",command.command_id),recipe.action_id,recipe.id,target,snapshot.id,request.to_string()]).unwrap();
        let pending = Pending {
            command,
            at: Instant::now(),
            before: vec![],
            running: true,
            execution_at: None,
            correction_key: None,
        };
        let onsite = Mutex::new(onsite::Onsite::default());
        let shown = Instant::now() - Duration::from_secs(3);
        {
            let mut owner = onsite.lock().unwrap();
            let command = &pending.command;
            owner
                .begin(&command.command_id, &command.session_id, json!({}), shown)
                .unwrap();
            owner
                .decide(
                    &command.command_id,
                    &command.session_id,
                    "shown",
                    true,
                    false,
                    shown,
                )
                .unwrap();
            owner
                .decide(
                    &command.command_id,
                    &command.session_id,
                    "confirmed",
                    true,
                    false,
                    Instant::now(),
                )
                .unwrap();
        }
        authorize_execution_in_context(&request, &pending, true, &core, db, auth, &onsite).unwrap();
        let audit = recovery_audit(&db.conn.lock().unwrap(), &pending.command, recipe).unwrap();
        assert_eq!(audit.1, Some(snapshot.id));
        request
    }

    pub(crate) fn assert_remote_remedy_admission(
        db: &crate::db::DbState,
        auth: &crate::auth::AuthState,
    ) {
        let (_root, core, mut command) = remote_admission_fixture("your-terminal");
        for id in ["testPrint", "syncNow"] {
            let r = remedies::recipe(id, 1).unwrap();
            assert!(r.needs_onsite && r.needs_staff_pin && r.mutates_data);
            assert!(!r.requires_snapshot);
            assert_eq!(r.cooldown_ms, 0);
            assert_eq!(r.attempt_cap, 9_007_199_254_740_991);
            command.kind = "till_run_remedy".into();
            command.tier = 2;
            command.payload = json!({"recipe_id":id,"recipe_version":1,"reason":"your-reason","idempotency_key":"your-remedy-attempt-key"});
            command.payload_sha256 = super::super::contracts::payload_hash(&command.payload);
            let request = json!({"source":"remote_support","supportRequestId":command.command_id,"sessionId":command.session_id,
                "recipeId":id,"recipeVersion":1,"actionId":r.action_id});
            let p = Pending {
                command: command.clone(),
                at: Instant::now(),
                before: vec![],
                running: true,
                execution_at: None,
                correction_key: None,
            };
            let onsite = Mutex::new(onsite::Onsite::default());
            let at = Instant::now() - Duration::from_secs(3);
            {
                let mut owner = onsite.lock().unwrap();
                owner
                    .begin(&command.command_id, &command.session_id, json!({}), at)
                    .unwrap();
                owner
                    .decide(
                        &command.command_id,
                        &command.session_id,
                        "shown",
                        true,
                        false,
                        at,
                    )
                    .unwrap();
            }
            assert_eq!(
                authorize_execution_in_context(&request, &p, true, &core, db, auth, &onsite)
                    .unwrap_err()
                    .to_string(),
                "ONSITE_DECLINED"
            );
            onsite
                .lock()
                .unwrap()
                .decide(
                    &command.command_id,
                    &command.session_id,
                    "confirmed",
                    true,
                    false,
                    Instant::now(),
                )
                .unwrap();
            assert_eq!(
                authorize_execution_in_context(&request, &p, true, &core, db, auth, &onsite)
                    .unwrap_err()
                    .to_string(),
                "REMEDY_NOT_APPLICABLE"
            );
            db.conn.lock().unwrap().execute("INSERT INTO recovery_action_log(id,action_id,issue_code,recipe_id,recipe_version,payload_json) VALUES(?1,?2,'your_issue',?3,1,?4)",
                rusqlite::params![format!("support:{}:{id}",command.command_id), r.action_id, id, request.to_string()]).unwrap();
            assert!(
                authorize_execution_in_context(&request, &p, false, &core, db, auth, &onsite)
                    .is_err()
            );
            authorize_execution_in_context(&request, &p, true, &core, db, auth, &onsite).unwrap();
            // The testPrint recovery entry repeats the same CashDrawer check.
            if id == "testPrint" {
                let conn = db.conn.lock().unwrap();
                crate::commands::recovery::health_action_admission(
                    &conn, &request, 100, false, false,
                )
                .unwrap();
                drop(conn);
                authorize_cash_drawer(db, auth, &core, &command.session_id).unwrap();
            }
            let mut blocked = core.session.as_ref().unwrap().admission.clone();
            blocked.tier_ceiling = 1;
            assert_eq!(
                delivery::recheck(&command, &blocked, &core.clock, Instant::now()).unwrap_err(),
                "TIER_NOT_ALLOWED"
            );
        }
    }
}
