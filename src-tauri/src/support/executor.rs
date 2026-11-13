use super::{
    audit_local::{self, AuditEntry},
    clock::{self, ServerClock},
    contracts::{self, Command},
    db::SupportDb,
    delivery::{self, Admission, Delivery},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::time::Instant;

pub struct Executor {
    pub db: SupportDb,
    pub delivery: Delivery,
    pixels: std::sync::Arc<std::sync::Mutex<std::collections::BTreeMap<String, (Instant, Value)>>>,
}
impl Executor {
    pub fn new(db: SupportDb) -> Self {
        Self {
            db,
            delivery: Delivery::default(),
            pixels: Default::default(),
        }
    }
    pub fn accept(
        &mut self,
        c: &Command,
        a: &Admission,
        clock: &ServerClock,
    ) -> Result<bool, String> {
        let check = self.delivery.check(c, a, clock, Instant::now());
        let now = clock
            .now(&a.session_id)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let tx = super::db::transaction(&self.db.conn).map_err(db_error)?;
        let existing:Option<(String,Option<String>)>=tx.query_row("SELECT command_id,result_json FROM support_accepted_commands WHERE command_id=?1 OR idempotency_key=?2",params![c.command_id,c.idempotency_key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
        if let Some((id, result)) = existing {
            if id != c.command_id {
                refuse(&tx, c, "INVALID_INPUT", now)?;
            } else {
                audit_local::append(
                    &tx,
                    &entry(c, "refused", Some("INVALID_INPUT"), Some("failed"), now),
                )
                .map_err(db_error)?;
                if let Some(encoded) = result {
                    let result: Value =
                        serde_json::from_str(&encoded).map_err(|_| "INTERNAL_ERROR")?;
                    store_result(&tx, c, &result, now)?;
                }
            }
            tx.commit().map_err(db_error)?;
            return Ok(false);
        }
        let refused:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM support_command_refusals WHERE command_id=?1 OR idempotency_key=?2)",params![c.command_id,c.idempotency_key],|r|r.get(0)).map_err(db_error)?;
        if refused {
            audit_local::append(
                &tx,
                &entry(c, "refused", Some("INVALID_INPUT"), Some("failed"), now),
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            return Ok(false);
        }
        let session: Option<(String, i64)> = tx
            .query_row(
                "SELECT status,last_seq FROM support_session_state WHERE session_id=?1",
                [&a.session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        let capture_rate = if c.kind == "till_screenshot" {
            let (count,last):(u64,Option<String>)=tx.query_row("SELECT count(*),max(accepted_at) FROM support_accepted_commands WHERE session_id=?1 AND kind='till_screenshot'",[&c.session_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
            count >= contracts::cap("screenshot", "perSession")
                || last
                    .as_deref()
                    .and_then(|s| clock::parse(s).ok())
                    .is_some_and(|at| now - at < contracts::cap("screenshot", "intervalMs") as i64)
        } else {
            false
        };
        let code = check
            .err()
            .or(super::confirmed::rate(&tx, c, now).err())
            .or(if capture_rate {
                Some("RATE_LIMITED")
            } else {
                None
            })
            .or_else(|| match session {
                Some((ref status, last)) if status == "active" => {
                    if c.sequence <= last {
                        Some("INVALID_INPUT")
                    } else {
                        None
                    }
                }
                _ => Some("SESSION_ENDED"),
            });
        if let Some(code) = code {
            refuse(&tx, c, code, now)?;
            tx.commit().map_err(db_error)?;
            return Ok(false);
        }
        tx.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,idempotency_key,accepted_at,envelope_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![c.command_id,c.session_id,c.sequence,c.kind,c.payload_sha256,c.idempotency_key,clock::iso(now),serde_json::to_string(c).map_err(|_|"INTERNAL_ERROR")?]).map_err(db_error)?;
        tx.execute(
            "UPDATE support_session_state SET last_seq=?1 WHERE session_id=?2",
            params![c.sequence, c.session_id],
        )
        .map_err(db_error)?;
        audit_local::append(&tx, &entry(c, "accepted", None, None, now)).map_err(db_error)?;
        super::confirmed::event(&tx, c, "confirmed_command_waiting", now)?;
        tx.commit().map_err(db_error)?;
        Ok(true)
    }
    pub(crate) fn start(
        &mut self,
        c: &Command,
        a: &Admission,
        clock: &ServerClock,
    ) -> Result<(), String> {
        delivery::recheck(c, a, clock, Instant::now()).map_err(str::to_string)?;
        if !a.visible {
            return Err("TILL_PAUSED".into());
        }
        let now = clock.now(&a.session_id).ok_or("COMMAND_EXPIRED")?;
        let tx = super::db::transaction(&self.db.conn).map_err(db_error)?;
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM support_session_state WHERE session_id=?1",
                [&a.session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if status.as_deref() != Some("active") {
            return Err("SESSION_ENDED".into());
        }
        let definition = contracts::shared()
            .kinds
            .get(&c.kind)
            .ok_or("INVALID_INPUT")?;
        let running: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT kind FROM support_accepted_commands WHERE state='executing'")
                .map_err(db_error)?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(db_error)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_error)?
        };
        if (!running.is_empty() && definition.mutating)
            || running
                .iter()
                .any(|k| contracts::shared().kinds.get(k).is_none_or(|d| d.mutating))
        {
            return Err("CONCURRENT_OPERATION".into());
        }
        let updated=tx.execute("UPDATE support_accepted_commands SET state='executing',started_at=?1 WHERE command_id=?2 AND session_id=?3 AND started_at IS NULL AND finished_at IS NULL AND state IN ('accepted','deferred','paused','awaiting_onsite')",params![clock::iso(now),c.command_id,c.session_id]).map_err(db_error)?;
        if updated != 1 {
            return Err("INVALID_INPUT".into());
        }
        audit_local::append(&tx, &entry(c, "started", None, None, now)).map_err(db_error)?;
        super::confirmed::event(&tx, c, "confirmed_command_started", now)?;
        tx.commit().map_err(db_error)
    }
    pub fn finish(&mut self, c: &Command, data: Value, now: i64) -> Result<(), String> {
        let result = make_result(&self.db.conn, c, Some(data), None, now)?;
        let used: i64 = self
            .db
            .conn
            .query_row(
                "SELECT result_bytes FROM support_session_state WHERE session_id=?1",
                [&c.session_id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if used as u64 + result.to_string().len() as u64
            > contracts::cap("accountability", "sessionResultBytes")
        {
            return Err("RESULT_BUDGET_EXHAUSTED".into());
        }
        if serde_json::to_vec(&result)
            .map_err(|_| "INTERNAL_ERROR")?
            .len() as u64
            > result_cap(c)
        {
            return Err("RESULT_TOO_LARGE".into());
        }
        let pixels = c.kind == "till_screenshot" && result["data"]["base64"].is_string();
        self.complete(c, result.clone(), now, true)?;
        if pixels {
            let weak = std::sync::Arc::downgrade(&self.pixels);
            let id = c.command_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(30));
                if let Some(map) = weak.upgrade() {
                    if let Ok(mut map) = map.lock() {
                        map.remove(&id);
                    }
                }
            });
            self.pixels
                .lock()
                .map_err(|_| "INTERNAL_ERROR")?
                .insert(c.command_id.clone(), (Instant::now(), result));
        }
        Ok(())
    }
    pub fn fail_with_data(
        &mut self,
        c: &Command,
        code: &str,
        data: Value,
        now: i64,
    ) -> Result<(), String> {
        let result = make_result(
            &self.db.conn,
            c,
            Some(super::redaction::record(data).ok_or("INTERNAL_ERROR")?),
            Some(code),
            now,
        )?;
        let used: i64 = self
            .db
            .conn
            .query_row(
                "SELECT result_bytes FROM support_session_state WHERE session_id=?1",
                [&c.session_id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if used as u64 + result.to_string().len() as u64
            > contracts::cap("accountability", "sessionResultBytes")
        {
            return Err("RESULT_BUDGET_EXHAUSTED".into());
        }
        if serde_json::to_vec(&result)
            .map_err(|_| "INTERNAL_ERROR")?
            .len() as u64
            > result_cap(c)
        {
            return Err("RESULT_TOO_LARGE".into());
        }
        self.complete(c, result, now, true)
    }
    pub fn fail(&mut self, c: &Command, code: &str, now: i64) -> Result<(), String> {
        let result = make_result(&self.db.conn, c, None, Some(code), now)?;
        self.complete(c, result, now, true)
    }
    pub fn refuse_queued(&mut self, c: &Command, code: &str, now: i64) -> Result<(), String> {
        let result = make_result(&self.db.conn, c, None, Some(code), now)?;
        self.complete(c, result, now, false)
    }
    fn complete(
        &mut self,
        c: &Command,
        result: Value,
        now: i64,
        started: bool,
    ) -> Result<(), String> {
        let tx = super::db::transaction(&self.db.conn).map_err(db_error)?;
        complete_on(&tx, c, &result, now, started)?;
        tx.commit().map_err(db_error)
    }
    pub fn wait(&mut self, c: &Command, state: &str, now: i64) -> Result<(), String> {
        let status = match state {
            "deferred" => "deferred_critical_operation",
            "paused" => "pending",
            "awaiting_onsite" => "awaiting_onsite",
            _ => return Err("INVALID_INPUT".into()),
        };
        let mut result = make_result(
            &self.db.conn,
            c,
            None,
            if state == "paused" {
                Some("TILL_PAUSED")
            } else {
                None
            },
            now,
        )?;
        result["status"] = json!(status);
        result["outcome"] = json!("pending");
        result
            .as_object_mut()
            .ok_or("INTERNAL_ERROR")?
            .remove("result_sha256");
        result["result_sha256"] = json!(contracts::payload_hash(&result));
        let tx = super::db::transaction(&self.db.conn).map_err(db_error)?;
        let changed=tx.execute("UPDATE support_accepted_commands SET state=?1 WHERE command_id=?2 AND started_at IS NULL AND finished_at IS NULL",params![state,c.command_id]).map_err(db_error)?;
        if changed == 1 {
            store_result(&tx, c, &result, now)?;
        }
        tx.commit().map_err(db_error)
    }
    pub fn queued(&self) -> Result<Vec<Command>, String> {
        let mut stmt=self.db.conn.prepare("SELECT envelope_json FROM support_accepted_commands WHERE started_at IS NULL AND finished_at IS NULL ORDER BY sequence").map_err(db_error)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_error)?;
        rows.map(|s| {
            serde_json::from_str(&s.map_err(db_error)?).map_err(|_| "INTERNAL_ERROR".into())
        })
        .collect()
    }
    pub fn recover(&mut self, now: i64) -> Result<(), String> {
        let unfinished: Vec<(Command, bool)> = {
            let mut stmt=self.db.conn.prepare("SELECT envelope_json,started_at IS NOT NULL FROM support_accepted_commands WHERE finished_at IS NULL").map_err(db_error)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))
                .map_err(db_error)?;
            rows.map(|r| {
                let (json, started) = r.map_err(db_error)?;
                Ok((
                    serde_json::from_str(&json).map_err(|_| "INTERNAL_ERROR")?,
                    started,
                ))
            })
            .collect::<Result<_, String>>()?
        };
        let tx = super::db::transaction(&self.db.conn).map_err(db_error)?;
        for (c, started) in unfinished {
            let result = make_result(
                &tx,
                &c,
                None,
                Some(if started {
                    "OUTCOME_UNKNOWN"
                } else {
                    "SESSION_ENDED"
                }),
                now,
            )?;
            complete_on(&tx, &c, &result, now, false)?;
        }
        tx.execute("UPDATE support_session_state SET status='ended',end_reason=COALESCE(end_reason,'app_restart'),updated_at=?1 WHERE status!='ended'",[clock::iso(now)]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    pub fn end(&mut self, id: &str, now: i64) -> Result<(), String> {
        self.pixels
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .retain(|_, (_, v)| v["session_id"] != id);
        self.db
            .conn
            .execute(
                "UPDATE support_session_state SET status='ended',updated_at=?1 WHERE session_id=?2",
                params![clock::iso(now), id],
            )
            .map_err(db_error)?;
        let queued = self.queued()?;
        let tx = super::db::transaction(&self.db.conn).map_err(db_error)?;
        for c in queued.into_iter().filter(|c| c.session_id == id) {
            let result = make_result(&tx, &c, None, Some("SESSION_ENDED"), now)?;
            complete_on(&tx, &c, &result, now, false)?;
        }
        tx.commit().map_err(db_error)
    }
    pub fn pending_results(&self, now: i64) -> Result<Vec<Value>, String> {
        self.pending_results_limit(now, 200)
    }
    pub fn pending_results_limit(&self, now: i64, limit: usize) -> Result<Vec<Value>, String> {
        let tx = super::db::transaction(&self.db.conn).map_err(db_error)?;
        let oldest = now - contracts::cap("transport", "localResultRetentionMs") as i64;
        tx.execute(
            "DELETE FROM support_result_outbox WHERE created_ms<?1",
            [oldest],
        )
        .map_err(db_error)?;
        tx.execute("UPDATE support_accepted_commands SET result_json=NULL,result_bytes=NULL,envelope_json=NULL WHERE finished_at<?1",[clock::iso(oldest)]).map_err(db_error)?;
        let strings: Vec<String> = {
            let mut stmt=tx.prepare("SELECT result_json FROM support_result_outbox WHERE delivered=0 ORDER BY created_ms,command_id LIMIT ?1").map_err(db_error)?;
            let rows = stmt
                .query_map([limit as i64], |r| r.get(0))
                .map_err(db_error)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_error)?
        };
        tx.commit().map_err(db_error)?;
        strings
            .into_iter()
            .map(|s| {
                let mut result: Value = serde_json::from_str(&s).map_err(|_| "INTERNAL_ERROR")?;
                if result["data"]["mime_type"] == "image/jpeg" {
                    let id = result["command_id"].as_str().ok_or("INTERNAL_ERROR")?;
                    let pending = self.pixels.lock().map_err(|_| "INTERNAL_ERROR")?.remove(id);
                    if let Some((at, pixels)) =
                        pending.filter(|(at, _)| at.elapsed() < std::time::Duration::from_secs(30))
                    {
                        let _ = at;
                        return Ok(pixels);
                    }
                    result["status"] = json!("failed");
                    result["outcome"] = json!("outcome_unknown");
                    result
                        .as_object_mut()
                        .ok_or("INTERNAL_ERROR")?
                        .remove("data");
                    result["error_code"] = json!("OUTCOME_UNKNOWN");
                    result["failure_detail_code"] = json!("SCREENSHOT_ALREADY_CONSUMED");
                    result
                        .as_object_mut()
                        .ok_or("INTERNAL_ERROR")?
                        .remove("result_sha256");
                    result["result_sha256"] = json!(contracts::payload_hash(&result));
                    self.db.conn.execute("UPDATE support_result_outbox SET result_json=?1 WHERE command_id=?2",params![result.to_string(),result["command_id"].as_str()]).map_err(db_error)?;
                    self.db.conn.execute("UPDATE support_accepted_commands SET result_json=?1 WHERE command_id=?2",params![result.to_string(),result["command_id"].as_str()]).map_err(db_error)?;
                }
                Ok(result)
            })
            .collect()
    }
    pub fn delivered(&self, id: &str, hash: &str) -> Result<(), String> {
        self.db.conn.execute("DELETE FROM support_result_outbox WHERE command_id=?1 AND json_extract(result_json,'$.result_sha256')=?2",params![id,hash]).map_err(db_error)?;
        self.db.conn.execute("UPDATE support_accepted_commands SET delivered=1,state=CASE WHEN finished_at IS NOT NULL THEN 'reported' ELSE state END WHERE command_id=?1 AND json_extract(result_json,'$.result_sha256')=?2",params![id,hash]).map_err(db_error)?;
        Ok(())
    }
}

fn complete_on(
    conn: &Connection,
    c: &Command,
    result: &Value,
    now: i64,
    started: bool,
) -> Result<(), String> {
    let updated=conn.execute("UPDATE support_accepted_commands SET state='finished',finished_at=?1,outcome=?2,result_json=?3,result_bytes=?4 WHERE command_id=?5 AND finished_at IS NULL AND (?6=0 OR state='executing')",params![clock::iso(now),result["outcome"].as_str(),storage_result(result).to_string(),result.to_string().len(),c.command_id,started]).map_err(db_error)?;
    if updated != 1 {
        return Err("INVALID_INPUT".into());
    }
    store_result(conn, c, &result, now)?;
    super::confirmed::event(
        conn,
        c,
        if result["error_code"].is_string() {
            "confirmed_command_refused"
        } else {
            "confirmed_command_finished"
        },
        now,
    )?;
    if c.kind == super::confirmed::KIND
        && c.payload["action"]["action_id"] == "queue.return_to_queue.v1"
        && !result["error_code"].is_string()
    {
        super::confirmed::event(conn, c, "confirmed_command_undone", now)?;
    }
    conn.execute(
        "UPDATE support_session_state SET result_bytes=result_bytes+?1 WHERE session_id=?2",
        params![result.to_string().len(), c.session_id],
    )
    .map_err(db_error)?;
    let mut audit = entry(
        c,
        "finished",
        result["error_code"].as_str(),
        result["outcome"].as_str(),
        now,
    );
    audit.result_sha256 = result["result_sha256"].as_str().map(str::to_string);
    audit_local::append(conn, &audit).map_err(db_error)?;
    Ok(())
}
fn result_cap(c: &Command) -> u64 {
    contracts::cap(
        if c.kind == "till_screenshot" {
            "screenshot"
        } else {
            "tools"
        },
        "resultBytes",
    )
}
fn storage_result(result: &Value) -> Value {
    let mut safe = result.clone();
    if safe["data"]["mime_type"] == "image/jpeg" {
        if let Some(data) = safe["data"].as_object_mut() {
            data.remove("base64");
        }
    }
    safe
}
fn db_error(_: rusqlite::Error) -> String {
    "INTERNAL_ERROR".into()
}
fn entry(
    c: &Command,
    phase: &str,
    status: Option<&str>,
    outcome: Option<&str>,
    now: i64,
) -> AuditEntry {
    AuditEntry {
        terminal_seq: 0,
        session_id: Some(c.session_id.clone()),
        command_id: Some(c.command_id.clone()),
        phase: phase.into(),
        status: status.map(str::to_string),
        outcome: outcome.map(str::to_string),
        input_sha256: Some(c.payload_sha256.clone()),
        result_sha256: None,
        created_at: clock::iso(now),
    }
}
fn make_result(
    conn: &Connection,
    c: &Command,
    data: Option<Value>,
    code: Option<&str>,
    now: i64,
) -> Result<Value, String> {
    let times: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT accepted_at,started_at FROM support_accepted_commands WHERE command_id=?1",
            [&c.command_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let (accepted, started) = times.unwrap_or((clock::iso(now), None));
    let mut timings = json!({"accepted_at":accepted,"finished_at":clock::iso(now),"ms":started.as_deref().and_then(|s|clock::parse(s).ok()).map_or(0,|ms|now.saturating_sub(ms).max(0))});
    if let Some(at) = started {
        timings["started_at"] = json!(at);
    }
    let detail = code.and_then(|code| super::evidence::split_error(code).1);
    let code = code.map(|code| super::evidence::split_error(code).0);
    let mut result = json!({"command_id":c.command_id,"session_id":c.session_id,"status":if code.is_some(){"failed"}else{"completed"},"outcome":if code==Some("OUTCOME_UNKNOWN"){"outcome_unknown"}else if code.is_some(){"failed"}else{"succeeded"},"timings":timings});
    if let Some(detail) = detail {
        result["failure_detail_code"] = json!(detail);
    }
    if let Some(data) = data {
        result["data"] = data;
    }
    if let Some(code) = code {
        result["error_code"] = json!(
            if contracts::shared().error_codes.iter().any(|s| s == code) {
                code
            } else {
                "INTERNAL_ERROR"
            }
        );
    }
    if code == Some("OUTCOME_UNKNOWN") {
        if c.kind == "till_screenshot" {
            result
                .as_object_mut()
                .ok_or("INTERNAL_ERROR")?
                .remove("data");
            result["failure_detail_code"] = json!("SCREENSHOT_ALREADY_CONSUMED");
        } else {
            result["data"] = json!({"verification_guidance":"Verify the current till state and audit before proposing another action. This command will never execute again."});
        }
    }
    result["result_sha256"] = json!(contracts::payload_hash(&result));
    Ok(result)
}
fn store_result(conn: &Connection, c: &Command, result: &Value, now: i64) -> Result<(), String> {
    let encoded = storage_result(result).to_string();
    if encoded.len() as u64 > result_cap(c) {
        return Err("RESULT_TOO_LARGE".into());
    }
    let created = result["timings"]["finished_at"]
        .as_str()
        .and_then(|s| clock::parse(s).ok())
        .unwrap_or(now);
    conn.execute("INSERT INTO support_result_outbox(command_id,session_id,result_json,created_ms) VALUES (?1,?2,?3,?4) ON CONFLICT(command_id) DO UPDATE SET result_json=excluded.result_json,created_ms=excluded.created_ms,delivered=0",params![c.command_id,c.session_id,encoded,created]).map_err(db_error)?;
    loop {
        let bytes:i64=conn.query_row("SELECT COALESCE(sum(length(CAST(result_json AS BLOB))),0) FROM support_result_outbox",[],|r|r.get(0)).map_err(db_error)?;
        if bytes as u64 <= contracts::cap("transport", "localResultBytes") {
            break;
        }
        let oldest:String=conn.query_row("SELECT command_id FROM support_result_outbox ORDER BY created_ms,command_id LIMIT 1",[],|r|r.get(0)).map_err(db_error)?;
        conn.execute(
            "UPDATE support_accepted_commands SET result_json=NULL WHERE command_id=?1",
            [&oldest],
        )
        .map_err(db_error)?;
        conn.execute(
            "DELETE FROM support_result_outbox WHERE command_id=?1",
            [oldest],
        )
        .map_err(db_error)?;
    }
    Ok(())
}
fn refuse(conn: &Connection, c: &Command, code: &str, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO support_command_refusals(command_id,idempotency_key,created_at) VALUES (?1,?2,?3) ON CONFLICT(command_id) DO NOTHING",params![c.command_id,c.idempotency_key,clock::iso(now)]).map_err(db_error)?;
    let result = make_result(conn, c, None, Some(code), now)?;
    let mut audit = entry(c, "refused", Some(code), Some("failed"), now);
    audit.result_sha256 = result["result_sha256"].as_str().map(str::to_string);
    audit_local::append(conn, &audit).map_err(db_error)?;
    super::confirmed::event(conn, c, "confirmed_command_refused", now)?;
    store_result(conn, c, &result, now)
}
