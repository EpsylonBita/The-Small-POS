use super::{
    clock::{self, ServerClock},
    contracts, critical_op,
    db::SupportDb,
    delivery::Admission,
    executor::Executor,
    transport::{self, Heartbeat, Schedule, SessionInfo},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub struct CodePending {
    pub id: String,
    pub expires_at: String,
}
pub struct NativeSession {
    pub info: SessionInfo,
    pub admission: Admission,
}
pub struct Core {
    pub verifier: super::approval_verify::Verifier,
    pub terminal_id: Option<String>,
    pub executor: Executor,
    pub clock: ServerClock,
    pub session: Option<NativeSession>,
    pub code: Option<CodePending>,
    pub schedule: Schedule,
    pub epoch: u64,
    pub ended_until: Option<Instant>,
    pub end_reason: Option<String>,
    pub key_rotation_pending: bool,
    pub rotation: super::key_rotation::Schedule,
}
pub struct Runtime {
    pub core: Mutex<Core>,
    pub started: AtomicBool,
    pub banner_ready: AtomicBool,
}
static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();

impl Core {
    pub fn new(db: SupportDb) -> Result<Self, String> {
        let old: Vec<(String, String)> = {
            let mut stmt = db
                .conn
                .prepare(
                    "SELECT session_id,status FROM support_session_state WHERE status!='ended'",
                )
                .map_err(|_| "INTERNAL_ERROR")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|_| "INTERNAL_ERROR")?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(|_| "INTERNAL_ERROR")?
        };
        let mut executor = Executor::new(db);
        let now = chrono::Utc::now().timestamp_millis();
        let pending:Option<(String,String)>=executor.db.conn.query_row("SELECT s.session_id,s.resume_token FROM support_session_state s JOIN support_accepted_commands c ON c.command_id=s.resume_token WHERE s.status='active' AND c.state IN ('restore_swapped','restore_rolled_back','restore_unknown') LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|"INTERNAL_ERROR")?;
        super::breakglass::recover(
            &executor.db.conn,
            &executor.db.path.with_file_name("pos.db"),
            pending.as_ref().map(|(_, token)| token.as_str()),
        )?;
        if pending.is_none() {
            executor.recover(now)?;
            executor
                .db
                .conn
                .execute(
                    "UPDATE support_session_state SET resume_token=NULL WHERE status='ended'",
                    [],
                )
                .map_err(|_| "INTERNAL_ERROR")?;
        } else {
            // Preserve only the delivered restore for authenticated resume.
            // Every other accepted command is completed, never replayed.
            for c in executor.queued()? {
                if pending.as_ref().is_none_or(|(_, id)| id != &c.command_id) {
                    executor.refuse_queued(&c, "SESSION_ENDED", now)?;
                }
            }
            let interrupted=super::guards::rows(&executor.db.conn,"SELECT envelope_json FROM support_accepted_commands WHERE started_at IS NOT NULL AND finished_at IS NULL AND state='executing'",&[])?;
            for row in interrupted {
                let c: contracts::Command =
                    serde_json::from_str(row["envelope_json"].as_str().ok_or("INTERNAL_ERROR")?)
                        .map_err(|_| "INTERNAL_ERROR")?;
                if pending.as_ref().is_none_or(|(_, id)| id != &c.command_id) {
                    executor.fail(&c, "OUTCOME_UNKNOWN", now)?;
                }
            }
        }
        for (id, status) in old {
            if pending.as_ref().is_some_and(|(session, _)| session == &id) {
                continue;
            }
            if pending.is_some() {
                executor.end(&id, now)?;
            }
            let (kind, body) = if status == "code_pending" {
                ("cancel_code", json!({"code_id":id}))
            } else {
                ("end", end_body(&id, "app_restart", now, None))
            };
            queue_notice(&executor.db, kind, body, now)?;
        }
        let rotation = super::key_rotation::Schedule::resume(&executor.db.conn)
            .map_err(|_| "INTERNAL_ERROR")?;
        Ok(Self {
            verifier: super::approval_verify::Verifier::pinned(),
            terminal_id: None,
            executor,
            clock: ServerClock::default(),
            session: None,
            code: None,
            schedule: Schedule::default(),
            epoch: 0,
            ended_until: None,
            end_reason: None,
            key_rotation_pending: false,
            rotation,
        })
    }
    pub fn resume_response(
        &mut self,
        response: Option<transport::SessionFetch>,
    ) -> Result<bool, String> {
        let pending:Option<(String,String,String,String)>=self.executor.db.conn.query_row("SELECT session_id,resume_token,max_expires_at,absolute_cap_at FROM support_session_state WHERE status='active' AND resume_token IS NOT NULL LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_|"INTERNAL_ERROR")?;
        let Some((id, command, max, absolute)) = pending else {
            return Ok(false);
        };
        let local:bool=self.executor.db.conn.query_row("SELECT EXISTS(SELECT 1 FROM support_accepted_commands WHERE command_id=?1 AND session_id=?2 AND kind='breakglass_propose_restore' AND started_at IS NOT NULL AND finished_at IS NULL AND state IN ('restore_swapped','restore_rolled_back','restore_unknown') AND json_extract(envelope_json,'$.payload.step')='execute' AND json_extract(envelope_json,'$.payload.target.kind')='snapshot')",params![command,id],|r|r.get(0)).map_err(|_|"INTERNAL_ERROR")?;
        let proof = response.and_then(|r| {
            let info = r.session?;
            let now = clock::parse(&r.server_time).ok()?;
            if !local
                || r.state != "active"
                || !info.resume_allowed
                || info.session_id != id
                || clock::parse(&max).ok()? <= now
                || clock::parse(&absolute).ok()? <= now
                || clock::parse(&info.max_expires_at).ok()? <= now
                || clock::parse(&info.absolute_cap_at).ok()? <= now
            {
                return None;
            }
            Some((info, r.server_time))
        });
        if let Some((mut info, time)) = proof {
            info.max_expires_at = clock::iso(
                clock::parse(&info.max_expires_at)
                    .map_err(str::to_string)?
                    .min(clock::parse(&max).map_err(str::to_string)?),
            );
            info.absolute_cap_at = clock::iso(
                clock::parse(&info.absolute_cap_at)
                    .map_err(str::to_string)?
                    .min(clock::parse(&absolute).map_err(str::to_string)?),
            );
            self.adopt(info, &time)?;
            self.session
                .as_mut()
                .ok_or("SESSION_ENDED")?
                .admission
                .active = true;
            // Heartbeat must supply current kill switches/tiers before dispatch.
            self.session
                .as_mut()
                .ok_or("SESSION_ENDED")?
                .admission
                .tiers_enabled
                .clear();
            super::restore::report_startup(
                &self.executor.db.conn,
                self.executor.db.path.parent().ok_or("INTERNAL_ERROR")?,
                &command,
            )?;
            super::breakglass::recover(
                &self.executor.db.conn,
                &self.executor.db.path.with_file_name("pos.db"),
                None,
            )?;
            self.executor.db.conn.execute("UPDATE support_session_state SET resume_token=NULL WHERE session_id=?1 AND resume_token=?2",params![id,command]).map_err(|_|"INTERNAL_ERROR")?;
            return Ok(true);
        }
        super::restore::report_startup(
            &self.executor.db.conn,
            self.executor.db.path.parent().ok_or("INTERNAL_ERROR")?,
            &command,
        )?;
        super::breakglass::recover(
            &self.executor.db.conn,
            &self.executor.db.path.with_file_name("pos.db"),
            None,
        )?;
        self.executor.db.conn.execute("UPDATE support_session_state SET status='ended',resume_token=NULL,end_reason='restore_resume_refused' WHERE session_id=?1",[&id]).map_err(|_|"INTERNAL_ERROR")?;
        self.session = None;
        self.end_reason = Some("restore_resume_refused".into());
        Ok(false)
    }
    pub fn approval_context(&self) -> Result<super::approval_verify::Context, String> {
        let session = self.session.as_ref().ok_or("SESSION_ENDED")?;
        Ok(super::approval_verify::Context {
            session_id: session.info.session_id.clone(),
            terminal_id: self.terminal_id.clone().ok_or("APPROVAL_NOT_VERIFIED")?,
            server_now: self.clock.now(&session.info.session_id),
            absolute_cap_at: session.info.absolute_cap_at.clone(),
        })
    }
    pub fn update_unattended(&self, proof: Option<&Value>) -> Result<(), String> {
        if let Ok(context) = self.approval_context() {
            self.verifier.mark_unattended(
                &self.executor.db.conn,
                proof.unwrap_or(&Value::Null),
                &context,
            )?;
        }
        Ok(())
    }
    pub fn now(&self) -> i64 {
        self.session
            .as_ref()
            .and_then(|s| self.clock.now(&s.info.session_id))
            .or_else(|| self.code.as_ref().and_then(|c| self.clock.now(&c.id)))
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
    }
    pub fn end(&mut self, reason: &str, notify: bool) -> Result<(), String> {
        let now = self.now();
        self.epoch += 1;
        let session = self.session.take();
        self.ended_until = Some(
            Instant::now() + Duration::from_millis(contracts::cap("transport", "endedLabelMs")),
        );
        self.end_reason = Some(reason.into());
        critical_op::global().cancel_support();
        critical_op::clear_payment_signals(None);
        withdraw_banner();
        if let Some(s) = session {
            // Key staging happens at server end, possibly on its next cron.
            // Check for a bounded window even though heartbeats now stop.
            let ran_command: bool = self.executor.db.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM support_accepted_commands WHERE session_id=?1 AND kind='breakglass_propose_command' AND started_at IS NOT NULL)",
                [&s.info.session_id], |r| r.get(0),
            ).map_err(|_| "INTERNAL_ERROR")?;
            if ran_command || self.key_rotation_pending {
                self.rotation.arm(Instant::now());
            }
            // Remove the in-memory authority first, even if persistence fails.
            self.executor.end(&s.info.session_id, now)?;
            self.executor.db.conn.execute("UPDATE support_session_state SET end_reason=COALESCE(end_reason,?1) WHERE session_id=?2",params![reason,s.info.session_id]).map_err(|_|"INTERNAL_ERROR")?;
            if notify {
                queue_notice(
                    &self.executor.db,
                    "end",
                    end_body(&s.info.session_id, reason, now, None),
                    now,
                )?;
            }
        }
        super::onsite::global()
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .clear();
        super::remedy_run::clear();
        super::tools::end_session();
        self.clock.clear();
        Ok(())
    }
    pub fn cancel_code(&mut self) -> Result<(), String> {
        let now = self.now();
        self.epoch += 1;
        if let Some(code) = self.code.take() {
            self.executor.db.conn.execute("UPDATE support_session_state SET status='ended',end_reason='code_cancelled' WHERE session_id=?1",[&code.id]).map_err(|_|"INTERNAL_ERROR")?;
            queue_notice(
                &self.executor.db,
                "cancel_code",
                json!({"code_id":code.id}),
                now,
            )?;
        }
        self.end("till_end", true)
    }
    pub fn expire(&mut self) -> Result<(), String> {
        if let Some(s) = &self.session {
            if self.clock.now(&s.info.session_id).is_none_or(|now| {
                clock::parse(&s.admission.max_expires_at).map_or(true, |at| now >= at)
                    || clock::parse(&s.info.absolute_cap_at).map_or(true, |at| now >= at)
            }) {
                return self.end("max_lifetime", false);
            }
        }
        if let Some(code) = &self.code {
            if self
                .clock
                .now(&code.id)
                .is_none_or(|now| clock::parse(&code.expires_at).map_or(true, |at| now >= at))
            {
                self.cancel_code()?;
                self.end_reason = Some("code_expired".into());
            }
        }
        Ok(())
    }
    pub fn adopt(&mut self, mut info: SessionInfo, server_time: &str) -> Result<(), String> {
        if !(1..=3).contains(&info.tier_ceiling)
            || info.doorbell_topic != format!("support:session:{}", info.session_id)
        {
            return Err("INVALID_INPUT".into());
        }
        self.clock
            .observe(&info.session_id, server_time, Instant::now())
            .map_err(str::to_string)?;
        let now = self.clock.now(&info.session_id).ok_or("COMMAND_EXPIRED")?;
        if clock::parse(&info.max_expires_at).map_err(str::to_string)? <= now
            || clock::parse(&info.absolute_cap_at).map_err(str::to_string)? <= now
        {
            return Err("SESSION_EXPIRED".into());
        }
        let absolute = clock::parse(&info.absolute_cap_at)
            .map_err(str::to_string)?
            .min(now + contracts::cap("sessions", "absoluteLifetimeMs") as i64);
        info.absolute_cap_at = clock::iso(absolute);
        info.max_expires_at = clock::iso(
            clock::parse(&info.max_expires_at)
                .map_err(str::to_string)?
                .min(now + contracts::cap("sessions", "lifetimeMs") as i64)
                .min(absolute),
        );
        let a = Admission {
            session_id: info.session_id.clone(),
            active: false,
            online: true,
            visible: false,
            tier_ceiling: info.tier_ceiling,
            tiers_enabled: BTreeSet::new(),
            disabled_tools: BTreeSet::new(),
            max_expires_at: info.max_expires_at.clone(),
        };
        self.executor.db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,last_server_time,updated_at) VALUES (?1,'pending_ack',?2,?3,?4,?5,?5) ON CONFLICT(session_id) DO NOTHING",params![info.session_id,info.tier_ceiling,info.max_expires_at,info.absolute_cap_at,server_time]).map_err(|_|"INTERNAL_ERROR")?;
        self.code = None;
        self.session = Some(NativeSession { info, admission: a });
        self.ended_until = None;
        self.end_reason = None;
        Ok(())
    }
    pub fn apply_heartbeat(&mut self, h: Heartbeat) -> Result<(), String> {
        let Some(s) = self.session.as_mut() else {
            return Ok(());
        };
        self.clock
            .observe(&s.info.session_id, &h.server_time, Instant::now())
            .map_err(str::to_string)?;
        let now = self
            .clock
            .now(&s.info.session_id)
            .ok_or("COMMAND_EXPIRED")?;
        let max_expires_at = clock::iso(
            clock::parse(&h.max_expires_at)
                .map_err(str::to_string)?
                .min(clock::parse(&s.info.absolute_cap_at).map_err(str::to_string)?),
        );
        let tx = super::db::transaction(&self.executor.db.conn).map_err(|_| "INTERNAL_ERROR")?;
        for id in &h.revoked_key_ids {
            tx.execute("INSERT INTO support_revoked_keys(credential_id,revoked_at,received_at) VALUES (?1,?2,?2) ON CONFLICT(credential_id) DO NOTHING",params![id,h.server_time]).map_err(|_|"INTERNAL_ERROR")?;
        }
        tx.execute("UPDATE support_session_state SET kill_epoch=MAX(kill_epoch,?1),tier_ceiling=?2,max_expires_at=?3,last_server_time=?4,updated_at=?4 WHERE session_id=?5",params![h.kill_epoch,s.admission.tier_ceiling.min(h.tier_ceiling),max_expires_at,h.server_time,s.info.session_id]).map_err(|_|"INTERNAL_ERROR")?;
        tx.commit().map_err(|_| "INTERNAL_ERROR")?;
        s.admission.tiers_enabled = h.tiers_enabled.into_iter().collect();
        let disabled: BTreeSet<String> = h.disabled_tools.into_iter().collect();
        if disabled
            .iter()
            .any(|tool| !s.admission.disabled_tools.contains(tool))
        {
            critical_op::global().cancel_support();
        }
        s.admission.disabled_tools = disabled;
        s.admission.tier_ceiling = s.admission.tier_ceiling.min(h.tier_ceiling);
        s.admission.max_expires_at = max_expires_at;
        s.admission.online = true;
        self.schedule.success();
        let last_seq: i64 = self
            .executor
            .db
            .conn
            .query_row(
                "SELECT last_seq FROM support_session_state WHERE session_id=?1",
                [&s.info.session_id],
                |r| r.get(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        if h.next_seq_available > last_seq {
            self.schedule.rung = true;
        }
        if h.key_rotation_pending && !self.key_rotation_pending {
            self.rotation.arm(Instant::now());
        }
        self.key_rotation_pending = h.key_rotation_pending;
        if h.session_status == "ended"
            || !h.available
            || h.min_protocol_version > 1
            || !matches!(h.consent["state"].as_str(), Some("valid" | "exempt"))
        {
            return self.end(h.end_reason.as_deref().unwrap_or("feature_disabled"), false);
        }
        if h.session_status == "active" {
            s.admission.active = true;
        }
        let a = s.admission.clone();
        self.update_unattended(h.unattended.as_ref())?;
        for c in self.executor.queued()? {
            if !a.tiers_enabled.contains(&c.tier) || a.disabled_tools.contains(&c.kind) {
                self.executor.refuse_queued(&c, "FEATURE_DISABLED", now)?;
            }
        }
        Ok(())
    }
    pub fn activity(&self) -> Result<Option<(String, String, String)>, String> {
        let Some(s) = &self.session else {
            return Ok(None);
        };
        self.executor.db.conn.query_row("SELECT command_id,kind,state FROM support_accepted_commands WHERE session_id=?1 AND state IN ('executing','awaiting_onsite') ORDER BY CASE state WHEN 'executing' THEN 0 ELSE 1 END LIMIT 1",[&s.info.session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|"INTERNAL_ERROR".into())
    }
    fn apply_extension(&mut self, id: &str, value: Value) -> Result<(), String> {
        #[derive(serde::Deserialize)]
        struct Extended {
            max_expires_at: String,
            absolute_cap_at: String,
            extended: bool,
            server_time: String,
        }
        let response: Extended = serde_json::from_value(value).map_err(|_| "INVALID_INPUT")?;
        let session = self
            .session
            .as_mut()
            .filter(|s| s.info.session_id == id && s.admission.active)
            .ok_or("SESSION_ENDED")?;
        let maximum = clock::parse(&response.max_expires_at).map_err(str::to_string)?;
        let absolute = clock::parse(&response.absolute_cap_at)
            .map_err(str::to_string)?
            .min(clock::parse(&session.info.absolute_cap_at).map_err(str::to_string)?);
        let now = clock::parse(&response.server_time).map_err(str::to_string)?;
        let old = clock::parse(&session.admission.max_expires_at).map_err(str::to_string)?;
        if maximum <= now
            || maximum > absolute
            || (response.extended
                && maximum > old + contracts::cap("sessions", "extensionMs") as i64)
        {
            return Err("INVALID_INPUT".into());
        }
        self.clock
            .observe(id, &response.server_time, Instant::now())
            .map_err(str::to_string)?;
        self.executor.db.conn.execute("UPDATE support_session_state SET max_expires_at=?1,absolute_cap_at=?2,last_server_time=?3,updated_at=?3 WHERE session_id=?4 AND status='active'", params![response.max_expires_at,clock::iso(absolute),response.server_time,id]).map_err(|_| "INTERNAL_ERROR")?;
        session.admission.max_expires_at = response.max_expires_at.clone();
        session.info.max_expires_at = response.max_expires_at;
        session.info.absolute_cap_at = clock::iso(absolute);
        Ok(())
    }
    pub fn banner(&mut self, visible: bool) -> Result<Value, String> {
        self.expire()?;
        let activity = self.activity()?;
        let unattended = self.approval_context().ok().is_some_and(|c| {
            self.verifier
                .is_unattended(&self.executor.db.conn, &c)
                .unwrap_or(false)
        });
        if let Some(s) = &mut self.session {
            s.admission.visible = visible;
            let now = self
                .clock
                .now(&s.info.session_id)
                .ok_or("COMMAND_EXPIRED")?;
            let status = if !visible || !s.admission.online {
                "paused"
            } else if critical_op::global().active() {
                "deferred"
            } else if activity
                .as_ref()
                .is_some_and(|(_, _, state)| state == "executing")
            {
                "executing"
            } else if activity
                .as_ref()
                .is_some_and(|(_, _, state)| state == "awaiting_onsite")
            {
                "awaiting_onsite"
            } else if s.admission.active {
                "connected"
            } else {
                "pending_ack"
            };
            return Ok(
                json!({"state":status,"session_id":s.info.session_id,"operator_display_name":s.info.operator_display_name,"remaining_ms":(clock::parse(&s.admission.max_expires_at).map_err(str::to_string)?-now).max(0),"attended":!unattended,"extend_allowed":s.admission.active && !unattended && clock::parse(&s.admission.max_expires_at).is_ok_and(|max| max-now <= 600_000 && clock::parse(&s.info.absolute_cap_at).is_ok_and(|cap| max < cap)),"tier_ceiling":s.admission.tier_ceiling,"activity":activity.as_ref().map(|(_,kind,_)|kind),"executing_command_id":activity.as_ref().filter(|(_,_,state)|state=="executing").map(|(id,_,_)|id),"write_outcome":null}),
            );
        }
        if let Some(c) = &self.code {
            return Ok(json!({"state":"code_pending","code_id":c.id,"expires_at":c.expires_at}));
        }
        Ok(if self.ended_until.is_some_and(|at| Instant::now() < at) {
            json!({"state":"ended","end_reason":self.end_reason,"write_outcome":self.write_outcome(None)?})
        } else {
            json!({"state":"none"})
        })
    }
    fn write_outcome(&self, session: Option<&str>) -> Result<Option<&'static str>, String> {
        let outcome:Option<String>=self.executor.db.conn.query_row("SELECT a.outcome FROM support_consumed_approvals a JOIN support_accepted_commands c ON c.command_id=a.command_id WHERE c.session_id=COALESCE(?1,(SELECT session_id FROM support_session_state WHERE status='ended' ORDER BY updated_at DESC LIMIT 1)) ORDER BY a.consumed_at DESC LIMIT 1",[session],|r|r.get(0)).optional().map_err(|_|"INTERNAL_ERROR")?.flatten();
        Ok(match outcome.as_deref() {
            Some("succeeded") => Some("committed"),
            Some("rolled_back") => Some("rolled_back"),
            _ => None,
        })
    }
}

fn end_body(id: &str, reason: &str, now: i64, outcome: Option<&str>) -> Value {
    json!({"session_id":id,"reason":reason,"ended_at_till":clock::iso(now),"write_outcome":outcome})
}
#[cfg(test)]
pub(super) mod harness {
    pub fn extension(
        core: &mut super::Core,
        id: &str,
        value: serde_json::Value,
    ) -> Result<(), String> {
        core.apply_extension(id, value)
    }
    pub fn end_body(id: &str, reason: &str, now: i64) -> serde_json::Value {
        super::end_body(id, reason, now, None)
    }
    pub fn consent_accept(
        body: serde_json::Value,
        staff: &serde_json::Value,
        persisted: &serde_json::Value,
    ) -> Result<(serde_json::Value, String), String> {
        super::consent_accept_request(body, staff, persisted)
    }
}
pub fn queue_notice(db: &SupportDb, kind: &str, body: Value, now: i64) -> Result<(), String> {
    db.conn.execute("INSERT INTO support_pending_notices(id,kind,body_json,created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO NOTHING",params![uuid::Uuid::new_v4().to_string(),kind,body.to_string(),clock::iso(now)]).map_err(|_|"INTERNAL_ERROR")?;
    Ok(())
}
// Used by task 8.9 (Phase 1 transport startup wiring).
#[allow(dead_code)]
pub fn initialize(db: SupportDb) -> Result<(), String> {
    let core = Core::new(db)?;
    RUNTIME
        .set(Arc::new(Runtime {
            core: Mutex::new(core),
            started: AtomicBool::new(false),
            banner_ready: AtomicBool::new(false),
        }))
        .map_err(|_| "support already initialized".into())
}
pub fn runtime(app: &tauri::AppHandle) -> Result<Arc<Runtime>, String> {
    let runtime = RUNTIME.get().cloned().ok_or("FEATURE_DISABLED")?;
    if !runtime.started.swap(true, Ordering::AcqRel) {
        let owned = runtime.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            transport::run(app, owned).await;
        });
    }
    Ok(runtime)
}

fn acknowledge_banner(ready: &AtomicBool, value: Option<&Value>) {
    // A state read cannot establish presentation. Only the mounted banner's
    // explicit visibility acknowledgment can arm command dispatch.
    if let Some(visible) = value.and_then(|v| v["visible"].as_bool()) {
        ready.store(visible, Ordering::Release);
    }
}
pub fn withdraw_banner() {
    if let Some(rt) = RUNTIME.get() {
        rt.banner_ready.store(false, Ordering::Release);
    }
}
fn checked_staff(app: &tauri::AppHandle) -> Result<Value, String> {
    let auth = app.state::<crate::auth::AuthState>();
    if !crate::auth::has_permission(&auth, Some("pos.support.connect")) {
        return Err("POLICY_REFUSED".into());
    }
    let staff = crate::auth::get_session_json(&auth);
    let id = staff["databaseStaffId"].as_str().ok_or("POLICY_REFUSED")?;
    uuid::Uuid::parse_str(id).map_err(|_| "POLICY_REFUSED")?;
    Ok(staff)
}
#[tauri::command]
pub async fn support_consent_fetch(app: tauri::AppHandle) -> Result<Value, String> {
    let native = app.clone();
    crate::database_lock::run_blocking_command("support_consent_fetch", move || {
        checked_staff(&native)
    })
    .await?;
    transport::request(&app, "/api/pos/support/consent", "GET", None).await
}
#[cfg(test)]
use super::transport::consent_accept_request;
#[cfg(test)]
pub(super) use super::transport::consent_decline_notice;
#[tauri::command]
pub async fn support_consent_accept(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let native = app.clone();
    let staff = crate::database_lock::run_blocking_command("support_consent_accept", move || {
        checked_staff(&native)
    })
    .await?;
    transport::consent_accept(&app, arg0, staff).await
}
#[tauri::command]
pub async fn support_consent_decline(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let rt = runtime(&app)?;
    crate::database_lock::run_blocking_command("support_consent_decline", move || {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let now = chrono::Utc::now().timestamp_millis();
        let tx = super::db::transaction(&core.executor.db.conn).map_err(|_| "INTERNAL_ERROR")?;
        super::audit_local::append(
            &tx,
            &super::audit_local::AuditEntry {
                terminal_seq: 0,
                session_id: None,
                command_id: None,
                phase: "finished".into(),
                status: Some("consent_declined".into()),
                outcome: Some("declined".into()),
                input_sha256: arg0.as_ref().map(contracts::payload_hash),
                result_sha256: None,
                created_at: clock::iso(now),
            },
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        tx.commit().map_err(|_| "INTERNAL_ERROR")?;
        // Audit durability precedes this best-effort notice. Missing text or
        // checked-in identity leaves the decline local; it never blocks closing.
        let notice = (|| {
            let staff = checked_staff(&app)?;
            transport::queue_consent_decline(
                &core.executor.db,
                arg0.as_ref().ok_or("INVALID_INPUT")?,
                &staff,
                now,
            )
        })();
        let _ = notice;

        // runtime() already starts the independent three-second delivery owner,
        // including while no code/session exists. No network is awaited here.
        Ok(json!({"declined":true}))
    })
    .await
}

pub(super) fn issue_code_body(app_version: &str, staff_ref: Option<Value>) -> Value {
    let mut body = json!({"protocol_version":1,"platform":"windows","app_version":app_version});
    if let Some(staff) = staff_ref {
        body["staff_ref"] = staff;
    }
    body
}

pub(super) fn bind_local_identity(
    conn: &rusqlite::Connection,
    core: &mut Core,
) -> Result<(), String> {
    core.terminal_id = None;
    core.terminal_id = Some(super::identity::local(conn)?.terminal_id);
    Ok(())
}

fn local_terminal(app: &tauri::AppHandle) -> Result<String, String> {
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let path = app.state::<crate::db::DbState>().db_path.clone();
    let conn =
        super::replica::read_connection(&path, &permit, Instant::now() + Duration::from_secs(1))?;
    Ok(super::identity::local(&conn)?.terminal_id)
}

#[tauri::command]
pub async fn support_request_code(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let rt = runtime(&app)?;
    let identity_app = app.clone();
    let terminal_id =
        crate::database_lock::run_blocking_command("support_request_code", move || {
            local_terminal(&identity_app)
        })
        .await?;
    rt.core.lock().map_err(|_| "INTERNAL_ERROR")?.terminal_id = Some(terminal_id);
    let auth = app.state::<crate::auth::AuthState>();
    if !crate::auth::has_permission(&auth, Some("pos.support.connect")) {
        return Err("POLICY_REFUSED".into());
    }
    let staff = arg0.as_ref().and_then(|v| v.get("staff_ref")).cloned();
    let body = issue_code_body(env!("CARGO_PKG_VERSION"), staff);
    let epoch = {
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        if core.session.is_some() {
            return Err("CONCURRENT_OPERATION".into());
        }
        core.epoch
    };
    let response =
        transport::request(&app, "/api/pos/support/sessions", "POST", Some(body)).await?;
    let value = response.clone();
    crate::database_lock::run_blocking_command("support_request_code",move || {
        let mut core=rt.core.lock().map_err(|_|"INTERNAL_ERROR")?;
        let id=value["code_id"].as_str().ok_or("INVALID_INPUT")?.to_string();
        let expires=value["expires_at"].as_str().ok_or("INVALID_INPUT")?.to_string();
        let time=value["server_time"].as_str().ok_or("INVALID_INPUT")?;
        if core.epoch!=epoch {queue_notice(&core.executor.db,"cancel_code",json!({"code_id":id}),chrono::Utc::now().timestamp_millis())?;return Err("SESSION_ENDED".into());}
        core.clock.observe(&id,time,Instant::now()).map_err(str::to_string)?;
        core.executor.db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,last_server_time,updated_at) VALUES (?1,'code_pending',1,?2,?2,?3,?3)",params![id,expires,time]).map_err(|_|"INTERNAL_ERROR")?;
        core.code=Some(CodePending {id,expires_at:expires}); core.schedule=Schedule::default(); core.epoch+=1;
        Ok(response)
    }).await
}
#[tauri::command]
pub async fn support_cancel_code(app: tauri::AppHandle) -> Result<Value, String> {
    let rt = runtime(&app)?;
    crate::database_lock::run_blocking_command("support_cancel_code", move || {
        rt.core
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .cancel_code()?;
        Ok(json!({"cancelled":true}))
    })
    .await
}
#[tauri::command]
pub async fn support_end(app: tauri::AppHandle) -> Result<Value, String> {
    let rt = runtime(&app)?;
    crate::database_lock::run_blocking_command("support_end", move || {
        let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let id=core.session.as_ref().map(|s|s.info.session_id.clone());
        core.cancel_code()?;
        drop(core);
        // End removes authority immediately, then gives the interrupted 250 ms
        // transaction time to settle without holding the transport/Core lock.
        let until=Instant::now()+Duration::from_millis(750);
        while !critical_op::global().support_idle()&&Instant::now()<until{std::thread::sleep(Duration::from_millis(5));}
        let core=rt.core.lock().map_err(|_|"INTERNAL_ERROR")?;
        let outcome=core.write_outcome(id.as_deref())?;
        if let Some(id)=id{core.executor.db.conn.execute("UPDATE support_pending_notices SET body_json=json_set(body_json,'$.write_outcome',?1) WHERE kind='end' AND json_extract(body_json,'$.session_id')=?2 AND sent_at IS NULL",params![outcome,id]).map_err(|_|"INTERNAL_ERROR")?;}
        Ok(json!({"ended":true,"write_outcome":outcome}))
    })
    .await
}
#[tauri::command]
pub async fn support_banner_state(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let rt = runtime(&app)?;
    acknowledge_banner(&rt.banner_ready, arg0.as_ref());
    resume_after_restore(&app, &rt).await?;
    let visible = super::dispatch::window_visible(&app);
    crate::database_lock::run_blocking_command("support_banner_state", move || {
        if !rt.banner_ready.load(Ordering::Acquire) {
            critical_op::global().cancel_support();
        }
        let auth = app.state::<crate::auth::AuthState>();
        let user = crate::auth::get_session_json(&auth);
        let can_connect = crate::auth::has_permission(&auth, Some("pos.support.connect"));
        let mut value = rt
            .core
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .banner(visible)?;
        value["can_connect"] = json!(can_connect);
        value["availability"] = app
            .try_state::<Arc<crate::sync::SyncState>>()
            .map(|state| {
                crate::sync::support_availability(
                    &app.state::<crate::db::DbState>().db_path,
                    &state,
                )
            })
            .unwrap_or(Value::Null);
        value["critical_op_active"] = json!(critical_op::global().active());
        value["restore_lease_held"] = json!(critical_op::global().restoring());
        value["staff"] = if can_connect {
            json!({"staff_id":user["staffId"],"base_role":user["role"]["name"]})
        } else {
            Value::Null
        };
        Ok(value)
    })
    .await
}
async fn resume_after_restore(app: &tauri::AppHandle, rt: &Arc<Runtime>) -> Result<(), String> {
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    if IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            IN_FLIGHT.store(false, Ordering::Release);
        }
    }
    let _reset = Reset;
    let owned = rt.clone();
    let pending=crate::database_lock::run_blocking_command("support_restore_resume",move||{
        let core=owned.core.lock().map_err(|_|"INTERNAL_ERROR")?;
        core.executor.db.conn.query_row("SELECT EXISTS(SELECT 1 FROM support_session_state s JOIN support_accepted_commands c ON c.command_id=s.resume_token WHERE s.status='active' AND c.state IN ('restore_swapped','restore_rolled_back','restore_unknown'))",[],|r|r.get::<_,bool>(0)).map_err(|_|"INTERNAL_ERROR".to_string())
    }).await?;
    if !pending {
        return Ok(());
    }
    // The first resumed banner response must reach the renderer before a later
    // banner poll re-arms dispatch. Heartbeats/results can already resume.
    rt.banner_ready.store(false, Ordering::Release);
    // Uses the persisted terminal credential. No token issuance or second ack.
    let response = transport::request(app, "/api/pos/support/session", "GET", None)
        .await
        .ok()
        .and_then(|v| serde_json::from_value(v).ok());
    let owned = rt.clone();
    let app = app.clone();
    crate::database_lock::run_blocking_command("support_restore_resume", move || {
        let mut core = owned.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        core.terminal_id = None;
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .map_err(str::to_string)?;
        let path = app.state::<crate::db::DbState>().db_path.clone();
        let conn = super::replica::read_connection(
            &path,
            &permit,
            Instant::now() + Duration::from_secs(1),
        )?;
        bind_local_identity(&conn, &mut core)?;
        core.resume_response(response)?;
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn support_extend(app: tauri::AppHandle) -> Result<Value, String> {
    let rt = runtime(&app)?;
    let owned = rt.clone();
    let native = app.clone();
    let (id, body, epoch) = crate::database_lock::run_blocking_command(
        "support_extend",
        move || -> Result<_, String> {
            let user = checked_staff(&native)?;
            if !super::dispatch::window_visible(&native)
                || !owned.banner_ready.load(Ordering::Acquire)
            {
                return Err("TILL_PAUSED".into());
            }
            let mut core = owned.core.lock().map_err(|_| "INTERNAL_ERROR")?;
            core.expire()?;
            let session = core
                .session
                .as_ref()
                .filter(|s| s.admission.active && s.admission.online)
                .ok_or("SESSION_ENDED")?;
            let id = session.info.session_id.clone();
            if core.banner(true)?["attended"] != true {
                return Err("POLICY_REFUSED".into());
            }
            Ok((
                id.clone(),
                json!({"session_id":id,"staff_ref":{"staff_id":user["databaseStaffId"]}}),
                core.epoch,
            ))
        },
    )
    .await?;
    let response =
        transport::request(&app, "/api/pos/support/session/extend", "POST", Some(body)).await?;
    crate::database_lock::run_blocking_command("support_extend", move || -> Result<_, String> {
        let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        if core.epoch != epoch {
            return Err("SESSION_ENDED".into());
        }
        core.apply_extension(&id, response.clone())?;
        Ok(response)
    })
    .await
}
#[tauri::command]
pub async fn support_doorbell(arg0: Option<Value>, app: tauri::AppHandle) -> Result<(), String> {
    let rt = runtime(&app)?;
    crate::database_lock::run_blocking_command("support_doorbell", move || {
        let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        if arg0.as_ref().and_then(|v| v["online"].as_bool()) == Some(false) {
            if let Some(s) = &mut core.session {
                s.admission.online = false;
            }
        }
        if let Some(healthy) = arg0.as_ref().and_then(|v| v["healthy"].as_bool()) {
            core.schedule.doorbell_healthy = healthy;
        }
        core.schedule.rung = true;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_resume_requires_same_active_server_session_and_never_extends_expiry() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        for (state, allowed, expected) in [
            ("restore_swapped", true, true),
            ("restore_swapped", false, false),
            ("restore_staged", true, false),
        ] {
            let (root, core) = core();
            let id = "30000000-0000-4000-a000-000000000003";
            let command = "70000000-0000-4000-a000-000000000007";
            let at = "2030-01-01T00:00:00.000Z";
            let cap = "2030-01-01T00:10:00.000Z";
            core.executor.db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,resume_token,updated_at) VALUES(?1,'active',3,?2,?2,?3,?4)",params![id,cap,command,at]).unwrap();
            let payload = json!({"step":"execute","target":{"kind":"snapshot","snapshot_id":"your_snapshot"}});
            let c = contracts::Command {
                command_id: command.into(),
                session_id: id.into(),
                sequence: 1,
                kind: "breakglass_propose_restore".into(),
                tier: 3,
                payload: payload.clone(),
                payload_sha256: contracts::payload_hash(&payload),
                idempotency_key: "your_restore_command".into(),
                call_id: command.into(),
                created_at: at.into(),
                expires_at: cap.into(),
                server_time: at.into(),
                approval: None,
            };
            core.executor.db.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,accepted_at,started_at,idempotency_key,state,envelope_json) VALUES(?1,?2,1,'breakglass_propose_restore',?3,?4,?4,'your_restore_command',?6,?5)",params![command,id,c.payload_sha256,at,serde_json::to_string(&c).unwrap(),state]).unwrap();
            drop(core);
            let mut restarted = Core::new(SupportDb::open(&root).unwrap()).unwrap();
            assert!(restarted.session.is_none());
            let response = transport::SessionFetch {
                state: "active".into(),
                session: Some(SessionInfo {
                    session_id: id.into(),
                    operator_display_name: "Your support".into(),
                    tier_ceiling: 3,
                    max_expires_at: "2030-01-01T01:00:00.000Z".into(),
                    absolute_cap_at: "2030-01-01T03:00:00.000Z".into(),
                    idle_timeout_s: 900,
                    ack_deadline_at: cap.into(),
                    doorbell_topic: format!("support:session:{id}"),
                    resume_allowed: allowed,
                }),
                server_time: at.into(),
                code: None,
                end_reason: None,
                unattended: None,
            };
            assert_eq!(restarted.resume_response(Some(response)).unwrap(), expected);
            let token: Option<String> = restarted
                .executor
                .db
                .conn
                .query_row(
                    "SELECT resume_token FROM support_session_state WHERE session_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(token.is_none());
            if expected {
                let session = restarted.session.as_ref().unwrap();
                assert_eq!(session.admission.max_expires_at, cap);
                assert!(session.admission.active);
                assert!(session.admission.tiers_enabled.is_empty());
            } else if state == "restore_staged" {
                let status: String = restarted
                    .executor
                    .db
                    .conn
                    .query_row(
                        "SELECT status FROM support_session_state WHERE session_id=?1",
                        [id],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(status, "ended");
            } else {
                assert_eq!(
                    restarted.end_reason.as_deref(),
                    Some("restore_resume_refused")
                );
            }
            assert_eq!(
                restarted
                    .executor
                    .db
                    .conn
                    .query_row("SELECT COUNT(*) FROM support_result_outbox", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            drop(restarted);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn consent_accept_preserves_the_golden_body_and_uses_the_checked_in_session_header() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        crate::tests::fake_keyring::before_each_read(|key| {
            panic!("unexpected support consent keyring read: {key}")
        });
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-consent-accept.json"
        ))
        .unwrap();
        let case = &fixture["cases"][0];
        let staff = json!({"databaseStaffId":case["body"]["staff_id"], "sessionId":"your_local_auth_session"});
        let persisted = json!({"staffId":case["body"]["staff_id"], "sessionId":case["headers"]["x-staff-session-id"]});
        let (body, header) =
            consent_accept_request(case["body"].clone(), &staff, &persisted).unwrap();
        assert_eq!(body, case["body"]);
        assert_eq!(header, case["headers"]["x-staff-session-id"]);
        let mut other = persisted.clone();
        other["staffId"] = json!("50000000-0000-4000-a000-000000000005");
        assert!(consent_accept_request(body.clone(), &staff, &other).is_err());
        let mut spoofed = body.clone();
        spoofed["staff_id"] = other["staffId"].clone();
        assert!(consent_accept_request(spoofed, &staff, &persisted).is_err());
    }
    #[test]
    fn state_polls_do_not_acknowledge_presentation_and_cleanup_withdraws_it() {
        let ready = AtomicBool::new(false);
        acknowledge_banner(&ready, None);
        assert!(!ready.load(Ordering::Acquire));
        acknowledge_banner(&ready, Some(&json!({"visible":true})));
        assert!(ready.load(Ordering::Acquire));
        acknowledge_banner(&ready, None);
        assert!(ready.load(Ordering::Acquire));
        acknowledge_banner(&ready, Some(&json!({"visible":false})));
        assert!(!ready.load(Ordering::Acquire));
    }
    #[test]
    fn extension_uses_server_fixture_and_pins_the_original_absolute_cap() {
        let _gate = critical_op::install_test_gate();
        let (root, mut core) = core();
        adopt(&mut core);
        core.session.as_mut().unwrap().admission.active = true;
        core.executor
            .db
            .conn
            .execute("UPDATE support_session_state SET status='active'", [])
            .unwrap();
        let id = core.session.as_ref().unwrap().info.session_id.clone();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-session-extend.json"
        ))
        .unwrap();
        core.apply_extension(&id, fixture["response"].clone())
            .unwrap();
        assert_eq!(
            core.session.as_ref().unwrap().admission.max_expires_at,
            fixture["response"]["max_expires_at"]
        );
        let mut over = fixture["response"].clone();
        over["max_expires_at"] = json!("2026-11-01T17:00:00.000Z");
        assert!(core.apply_extension(&id, over).is_err());
        core.end("till_end", false).unwrap();
        assert!(core
            .apply_extension(&id, fixture["response"].clone())
            .is_err());
        drop(core);
        std::fs::remove_dir_all(root).unwrap();
    }
    fn core() -> (std::path::PathBuf, Core) {
        let root = std::env::temp_dir().join(format!("support-session-{}", uuid::Uuid::new_v4()));
        (
            root.clone(),
            Core::new(SupportDb::open(&root).unwrap()).unwrap(),
        )
    }
    fn adopt(core: &mut Core) {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-session.json"
        ))
        .unwrap();
        core.adopt(
            serde_json::from_value(fixture["response"]["session"].clone()).unwrap(),
            "2026-11-01T12:00:00.000Z",
        )
        .unwrap();
    }
    #[test]
    fn offline_end_is_local_durable_and_does_not_wait_for_transport() {
        let _gate = critical_op::install_test_gate();
        let (root, mut core) = core();
        adopt(&mut core);
        let at = Instant::now();
        core.end("till_end", true).unwrap();
        assert!(at.elapsed() < Duration::from_secs(1));
        assert!(core.session.is_none());
        let body: String = core
            .executor
            .db
            .conn
            .query_row(
                "SELECT body_json FROM support_pending_notices WHERE kind='end'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["reason"],
            "till_end"
        );
        assert_eq!(core.banner(true).unwrap()["state"], "ended");
        drop(core);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn heartbeat_remove_only_revocation_and_kill_switch_end() {
        let _gate = critical_op::install_test_gate();
        let (root, mut core) = core();
        adopt(&mut core);
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-heartbeat.json"
        ))
        .unwrap();
        let mut h = fixture["response"].clone();
        h["revoked_key_ids"] = json!(["revoked-test-key"]);
        h["available"] = json!(false);
        core.apply_heartbeat(serde_json::from_value(h).unwrap())
            .unwrap();
        assert!(core.session.is_none());
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row("SELECT count(*) FROM support_revoked_keys", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(core);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn offline_expiry_uses_server_time_and_restart_queues_an_end_notice() {
        let _gate = critical_op::install_test_gate();
        let (root, mut core) = core();
        adopt(&mut core);
        let id = core.session.as_ref().unwrap().info.session_id.clone();
        core.clock
            .observe(&id, "2026-11-01T13:00:00.000Z", Instant::now())
            .unwrap();
        core.expire().unwrap();
        assert!(core.session.is_none());
        assert_eq!(core.end_reason.as_deref(), Some("max_lifetime"));
        adopt(&mut core);
        core.executor
            .db
            .conn
            .execute(
                "UPDATE support_session_state SET status='active',end_reason=NULL",
                [],
            )
            .unwrap();
        drop(core);
        let restarted = Core::new(SupportDb::open(&root).unwrap()).unwrap();
        assert!(restarted.session.is_none());
        let body: String = restarted
            .executor
            .db
            .conn
            .query_row(
                "SELECT body_json FROM support_pending_notices WHERE kind='end'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["reason"],
            "app_restart"
        );
        drop(restarted);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn heartbeat_cannot_raise_the_known_tier_or_exceed_the_absolute_lifetime() {
        let _gate = critical_op::install_test_gate();
        let (root, mut core) = core();
        adopt(&mut core);
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-heartbeat.json"
        ))
        .unwrap();
        let mut h = fixture["response"].clone();
        h["tier_ceiling"] = json!(3);
        h["max_expires_at"] = json!("2026-11-01T16:00:00.000Z");
        core.apply_heartbeat(serde_json::from_value(h).unwrap())
            .unwrap();
        let s = core.session.as_ref().unwrap();
        assert_eq!(s.admission.tier_ceiling, 1);
        assert_eq!(s.admission.max_expires_at, s.info.absolute_cap_at);
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row("SELECT tier_ceiling FROM support_session_state", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        drop(core);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn phase_two_unattended_uses_native_identity_clock_and_heartbeat_revocations() {
        let _gate = critical_op::install_test_gate();
        let _keyring = crate::tests::fake_keyring::install_empty();
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
        ))
        .unwrap();
        let v = fixtures["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "valid unattended record")
            .unwrap();
        let (root, mut core) = core();
        core.verifier = super::super::approval_verify::Verifier::from_file(&v["pinned_keys"]);
        core.terminal_id = Some(v["context"]["terminal_id"].as_str().unwrap().into());
        let id = v["context"]["session_id"].as_str().unwrap();
        let cap = v["context"]["absolute_cap_at"].as_str().unwrap();
        let info = SessionInfo {
            session_id: id.into(),
            operator_display_name: "Your support".into(),
            tier_ceiling: 2,
            max_expires_at: cap.into(),
            absolute_cap_at: cap.into(),
            idle_timeout_s: 300,
            ack_deadline_at: cap.into(),
            doorbell_topic: format!("support:session:{id}"),
            resume_allowed: false,
        };
        core.adopt(info, v["state"]["server_time"].as_str().unwrap())
            .unwrap();
        let proof = json!({"record":v["record"],"assertion":v["assertion"]});
        core.update_unattended(Some(&proof)).unwrap();
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row(
                    "SELECT attended FROM support_session_state WHERE session_id=?1",
                    [id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        core.executor
            .db
            .conn
            .execute(
                "UPDATE support_session_state SET status='active' WHERE session_id=?1",
                [id],
            )
            .unwrap();
        core.session.as_mut().unwrap().admission.active = true;
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-heartbeat.json"
        ))
        .unwrap();
        let mut h = fixture["response"].clone();
        h["server_time"] = v["state"]["server_time"].clone();
        h["max_expires_at"] = json!(cap);
        h["unattended"] = proof;
        h["available"] = json!(true);
        h["session_status"] = json!("active");
        h["tier_ceiling"] = json!(2);
        h["revoked_key_ids"] = json!([]);
        core.apply_heartbeat(serde_json::from_value(h.clone()).unwrap())
            .unwrap();
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row(
                    "SELECT attended FROM support_session_state WHERE session_id=?1",
                    [id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        h["revoked_key_ids"] = json!([v["credential_id"]]);
        core.apply_heartbeat(serde_json::from_value(h).unwrap())
            .unwrap();
        assert_eq!(
            core.executor
                .db
                .conn
                .query_row(
                    "SELECT attended FROM support_session_state WHERE session_id=?1",
                    [id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(core
            .verifier
            .live_key_ids(&core.executor.db.conn)
            .unwrap()
            .is_empty());
        core.clock.clear();
        assert!(core.approval_context().unwrap().server_now.is_none());
        drop(core);
        std::fs::remove_dir_all(root).unwrap();
    }
}
