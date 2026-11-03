//! Durable typed device validation and single-use apply/undo policy.
//! Business writes are delegated exclusively to the device service owner.
use super::{
    approval_verify::{Context, Verifier},
    audit_local::{self, AuditEntry},
    contracts::{self, Command},
    critical_op::{self, SupportPermit},
    db, delivery,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::time::Instant;
use tauri::Manager;
pub trait DeviceServices {
    fn provenance(&self, session: &str, input: &Value) -> Result<bool, String>;
    fn validate(&self, input: &Value) -> Result<(), String>;
    fn read(&self, kind: &str, id: &str) -> Result<Option<Value>, String>;
    fn retained_identification(&self, session: &str, input: &Value) -> Result<Value, String>;
    fn fresh_admission(&self, kind: &str) -> Result<Option<bool>, String>;
    fn onsite(&self, command: &Command, input: &Value) -> Result<(), String>;
    fn authorize(&self, kind: &str) -> Result<bool, String>;
    fn current(&self, session: &str) -> Result<(), String>;
    fn before_effect(&self) -> Result<(), String> {
        Ok(())
    }
    fn release_read_permit(&self) -> Result<(), String> {
        Ok(())
    }
    fn save(
        &self,
        input: &Value,
        id: &str,
        expected: Option<&Value>,
        permit: &SupportPermit,
    ) -> Result<(), String>;
    fn remove(
        &self,
        kind: &str,
        id: &str,
        expected: &Value,
        permit: &SupportPermit,
    ) -> Result<(), String>;
}
fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str().ok_or_else(|| "PAYLOAD_MISMATCH".into())
}
fn checked(c: &Command) -> Result<&Value, String> {
    let input = &c.payload;
    if !delivery::valid_schema(
        &contracts::shared().payload_schemas["till_apply_device_settings"],
        input,
        0,
    ) || input["settings"]["port"] != input["discovered_device_ref"]["port"]
        || (input["discovered_device_ref"]["source"] == "scan"
            && input["discovered_device_ref"]["scan_id"].as_str().is_none())
        || (input["discovered_device_ref"]["source"] == "configured"
            && input["discovered_device_ref"]["device_id"]
                .as_str()
                .is_none())
    {
        return Err("POLICY_REFUSED".into());
    }
    if input["settings"]["name"]
        .as_str()
        .is_some_and(|name| name.trim() != name)
    {
        return Err("POLICY_REFUSED".into());
    }
    Ok(input)
}
pub fn configuration(input: &Value) -> Value {
    json!({"settings":input["settings"],"ip":input["discovered_device_ref"]["ip"]})
}
pub fn record_hash(input: &Value) -> String {
    contracts::payload_hash(
        &json!({"kind":input["device_kind"],"ref":input["discovered_device_ref"],"settings":input["settings"],"existing_device_id":input.get("existing_device_id").unwrap_or(&Value::Null)}),
    )
}
fn target(input: &Value) -> Value {
    json!({"device_kind":input["device_kind"],"ip":input["discovered_device_ref"]["ip"],"port":input["settings"]["port"],"existing_device_id":input.get("existing_device_id").unwrap_or(&Value::Null)})
}
fn admission(services: &dyn DeviceServices, kind: &str, now: i64) -> Result<Value, String> {
    if kind == "printer" {
        return Ok(Value::Null);
    }
    if services.fresh_admission(kind).unwrap_or(None) != Some(true) {
        return Err("DEVICE_NOT_ADMITTED".into());
    }
    Ok(
        json!({"admitted":true,"checked_at":super::clock::iso(now),"source":if kind=="cash_register"{"mydata_config"}else{"manual_admission"},"reason":null}),
    )
}
fn at(c: &Context, start: Instant) -> Result<i64, String> {
    Ok(c.server_now.ok_or("APPROVAL_NOT_VERIFIED")? + start.elapsed().as_millis() as i64)
}
fn current_context(c: &Context, start: Instant) -> Result<Context, String> {
    let mut c = c.clone();
    c.server_now = Some(at(&c, start)?);
    Ok(c)
}
pub fn validate(
    conn: &Connection,
    services: &dyn DeviceServices,
    c: &Command,
    context: &Context,
) -> Result<Value, String> {
    let input = checked(c)?;
    let now = context.server_now.ok_or("APPROVAL_NOT_VERIFIED")?;
    services.current(&c.session_id)?;
    if !services.provenance(&c.session_id, input)? {
        return Err("POLICY_REFUSED".into());
    }
    services.validate(input)?;
    let kind = field(input, "device_kind")?;
    let admission = admission(services, kind, now)?;
    let previous = match input["existing_device_id"].as_str() {
        Some(id) => Some(services.read(kind, id)?.ok_or("PAYLOAD_MISMATCH")?),
        None => None,
    };
    let identification = services.retained_identification(&c.session_id, input)?;
    services.current(&c.session_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let hash = record_hash(input);
    let expires = super::clock::iso(now + 600000);
    let tx = db::transaction(conn).map_err(|_| "INTERNAL_ERROR")?;
    services.current(&c.session_id)?;
    tx.execute("INSERT INTO support_validations(validation_id,session_id,device_kind,device_ref_json,record_json,record_sha256,previous_config_json,identification_json,admission_json,expires_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![id,c.session_id,kind,input.to_string(),input["settings"].to_string(),hash,previous.as_ref().map(Value::to_string),identification.to_string(),admission.to_string(),expires,super::clock::iso(now)]).map_err(|_|"INTERNAL_ERROR")?;
    tx.commit().map_err(|_| "INTERNAL_ERROR")?;
    Ok(
        json!({"observation_time":super::clock::iso(now),"app_version":env!("CARGO_PKG_VERSION"),"step":"validate","validation_id":id,"expires_at":expires,"record_to_save":input["settings"],"record_sha256":hash,"previous_config":previous.map(|v|v["settings"].clone()),"identification":identification,"admission":admission,"secret_fields_left_empty":if kind=="printer"{json!([])}else{json!(["password","pin","pairing_key","api_key","certificate"])},"requires":{"onsite":true,"founder_approval":kind!="printer"}}),
    )
}
fn load(
    conn: &Connection,
    c: &Command,
    context: &Context,
    consumed: bool,
) -> Result<Option<Value>, String> {
    let input = &c.payload;
    let now = context.server_now.ok_or("APPROVAL_NOT_VERIFIED")?;
    let row:Option<(String,String,Option<String>,bool,String)>=conn.query_row("SELECT session_id,record_sha256,previous_config_json,consumed_at IS NOT NULL,expires_at FROM support_validations WHERE validation_id=?1",[field(input,"validation_id")?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|_|"INTERNAL_ERROR")?;
    let row = row.ok_or("PAYLOAD_MISMATCH")?;
    if row.0 != c.session_id
        || row.1 != record_hash(input)
        || row.3 != consumed
        || super::clock::parse(&row.4).map_err(|_| "PAYLOAD_MISMATCH")? <= now
    {
        return Err("PAYLOAD_MISMATCH".into());
    }
    row.2
        .map(|s| serde_json::from_str(&s).map_err(|_| "PAYLOAD_MISMATCH".into()))
        .transpose()
}
fn audit(
    conn: &Connection,
    c: &Command,
    phase: &str,
    status: &str,
    outcome: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let evidence: Option<(String, Option<String>, String)> = conn.query_row(
        "SELECT applied_config_json,previous_config_json,admission_json FROM support_device_applies WHERE validation_id=?1 ORDER BY applied_at DESC LIMIT 1",
        [c.payload["validation_id"].as_str().unwrap_or("")],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).optional().map_err(|_| "INTERNAL_ERROR")?;
    audit_local::append(
        conn,
        &AuditEntry {
            terminal_seq: 0,
            session_id: Some(c.session_id.clone()),
            command_id: Some(c.command_id.clone()),
            phase: phase.into(),
            status: Some(status.into()),
            outcome: outcome.map(str::to_string),
            input_sha256: Some(record_hash(&c.payload)),
            result_sha256: evidence.map(|(saved, previous, admission)| contracts::payload_hash(&json!({"saved_record":saved,"previous_configuration":previous,"admission":admission}))),
            created_at: super::clock::iso(now),
        },
    )
    .map_err(|_| "INTERNAL_ERROR")?;
    Ok(())
}
pub fn apply(
    conn: &Connection,
    services: &dyn DeviceServices,
    verifier: &Verifier,
    c: &Command,
    context: &Context,
) -> Result<Value, String> {
    apply_inner(conn, services, verifier, c, context, None)
}

pub(crate) fn apply_with_permit(
    conn: &Connection,
    services: &dyn DeviceServices,
    verifier: &Verifier,
    c: &Command,
    context: &Context,
    permit: &SupportPermit,
) -> Result<Value, String> {
    apply_inner(conn, services, verifier, c, context, Some(permit))
}

fn apply_inner(
    conn: &Connection,
    services: &dyn DeviceServices,
    verifier: &Verifier,
    c: &Command,
    context: &Context,
    supplied: Option<&SupportPermit>,
) -> Result<Value, String> {
    let start = Instant::now();
    let input = checked(c)?;
    let kind = field(input, "device_kind")?;
    load(conn, c, context, false)?;
    services.current(&c.session_id)?;
    if !services.provenance(&c.session_id, input)? {
        return Err("POLICY_REFUSED".into());
    }
    services.validate(input)?;
    let approval_required = kind != "printer";
    let validation = field(input, "validation_id")?;
    let hash = record_hash(input);
    if approval_required {
        if c.approval.is_none() {
            return Err("APPROVAL_REQUIRED".into());
        }
        verifier.consume_device(
            conn,
            c.approval.as_ref().unwrap_or(&Value::Null),
            context,
            &c.command_id,
            validation,
            &hash,
            &target(input),
        )?;
    }
    let previous = load(conn, c, context, approval_required)?;
    admission(services, kind, at(context, start)?)?;
    let unattended = kind == "printer" && verifier.is_unattended(conn, context)?;
    if !unattended {
        services.onsite(c, input)?;
    }
    if supplied.is_some_and(SupportPermit::is_cancelled) {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    services.current(&c.session_id)?;
    if !services.authorize(kind)? {
        return Err("POLICY_REFUSED".into());
    }
    services.current(&c.session_id)?;
    services.validate(input)?;
    let context = current_context(context, start)?;
    load(conn, c, &context, approval_required)?;
    if approval_required {
        verifier.assert_consumed_device(
            conn,
            c.approval.as_ref().unwrap_or(&Value::Null),
            &context,
            &c.command_id,
            validation,
            &hash,
            &target(input),
        )?;
    }
    let now = context.server_now.ok_or("APPROVAL_NOT_VERIFIED")?;
    let admission = admission(services, kind, now)?;
    // Waits, authorization, network and device validation all precede admission.
    services.release_read_permit()?;
    let owned = if supplied.is_none() {
        Some(
            critical_op::global()
                .try_begin_support(true, None)
                .map_err(str::to_string)?,
        )
    } else {
        None
    };
    let permit = supplied.or(owned.as_ref()).ok_or("INTERNAL_ERROR")?;
    services.current(&c.session_id)?;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let device_id = input["existing_device_id"].as_str().unwrap_or(&id);
    let tx = db::transaction(conn).map_err(|_| "INTERNAL_ERROR")?;
    services.current(&c.session_id)?;
    if !approval_required {
        let claim=tx.execute("UPDATE support_validations SET consumed_at=?1 WHERE validation_id=?2 AND session_id=?3 AND record_sha256=?4 AND consumed_at IS NULL",params![super::clock::iso(now),validation,c.session_id,hash]).map_err(|_|"INTERNAL_ERROR")?;
        if claim != 1 {
            return Err("PAYLOAD_MISMATCH".into());
        }
    }
    tx.execute("INSERT INTO support_device_applies(id,validation_id,device_kind,device_id,previous_config_json,applied_at,state,applied_config_json,admission_json) VALUES(?1,?2,?3,?4,?5,?6,'saving',?7,?8)",params![id,validation,kind,device_id,previous.as_ref().map(Value::to_string),super::clock::iso(now),configuration(input).to_string(),admission.to_string()]).map_err(|_|"INTERNAL_ERROR")?;
    audit(&tx, c, "started", "device_apply", None, now)?;
    tx.commit().map_err(|_| "INTERNAL_ERROR")?;
    let saved: Result<Value, String> = (|| {
        services.current(&c.session_id)?;
        services.before_effect()?;
        services.save(input, device_id, previous.as_ref(), permit)?;
        services.current(&c.session_id)?;
        let read = services.read(kind, device_id)?;
        let matches = read == Some(configuration(input));
        // Configuration read-back is fresh. Device reachability remains pending
        // until the owner's normal refresh; support never probes or identifies.
        let identification = Value::Null;
        let outcome = if matches { "pending" } else { "failed" };
        let tx = db::transaction(conn).map_err(|_| "INTERNAL_ERROR")?;
        services.current(&c.session_id)?;
        tx.execute(
            "UPDATE support_device_applies SET state=?1 WHERE id=?2",
            params![outcome, id],
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        audit(&tx, c, "finished", "device_apply", Some(outcome), now)?;
        tx.commit().map_err(|_| "INTERNAL_ERROR")?;
        Ok(
            json!({"observation_time":super::clock::iso(now),"app_version":env!("CARGO_PKG_VERSION"),"step":"apply","device_id":device_id,"outcome":outcome,"read_back":{"matches_record":matches,"mismatched_fields":if matches{json!([])}else{json!(["record"])}},"post_identify":identification,"admission_at_save":admission,"undo_available":true,"audit_id":id}),
        )
    })();
    if let Err(error) = &saved {
        conn.execute(
            "UPDATE support_device_applies SET state='unknown' WHERE id=?1",
            [&id],
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        return Err(
            if [
                "DEVICE_NOT_ADMITTED",
                "POLICY_REFUSED",
                "PAYLOAD_MISMATCH",
                "PREEMPTED_BY_CRITICAL_OPERATION",
            ]
            .contains(&error.as_str())
            {
                error.clone()
            } else {
                "OUTCOME_UNKNOWN".into()
            },
        );
    }
    saved
}
pub fn undo(
    conn: &Connection,
    services: &dyn DeviceServices,
    c: &Command,
    id: &str,
    now: i64,
) -> Result<(), String> {
    let row:Option<(String,String,Option<String>,String,String,Option<String>)>=conn.query_row("SELECT a.device_kind,a.device_id,a.previous_config_json,a.applied_config_json,a.state,a.undone_at FROM support_device_applies a JOIN support_validations v ON v.validation_id=a.validation_id WHERE a.id=?1 AND v.session_id=?2",params![id,c.session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|_|"PAYLOAD_MISMATCH")?;
    let (kind, device, previous, applied, state, undone) = row.ok_or("PAYLOAD_MISMATCH")?;
    if undone.is_some() || !["resolved", "pending", "failed", "unknown"].contains(&state.as_str()) {
        return Err("PAYLOAD_MISMATCH".into());
    }
    services.current(&c.session_id)?;
    admission(services, &kind, now)?;
    let mut undo_input = c.payload.clone();
    if let Some(raw) = previous.as_deref() {
        let prior: Value = serde_json::from_str(raw).map_err(|_| "PAYLOAD_MISMATCH")?;
        undo_input["settings"] = prior["settings"].clone();
        undo_input["discovered_device_ref"]["ip"] = prior["ip"].clone();
        undo_input["discovered_device_ref"]["port"] = prior["settings"]["port"].clone();
    }
    services.onsite(c, &undo_input)?;
    if !services.authorize(&kind)? {
        return Err("POLICY_REFUSED".into());
    }
    services.current(&c.session_id)?;
    admission(services, &kind, now)?;
    if services
        .read(&kind, &device)?
        .as_ref()
        .map(Value::to_string)
        .as_deref()
        != Some(applied.as_str())
    {
        return Err("PAYLOAD_MISMATCH".into());
    }
    services.release_read_permit()?;
    let permit = critical_op::global()
        .try_begin_support(true, None)
        .map_err(str::to_string)?;
    services.current(&c.session_id)?;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let tx = db::transaction(conn).map_err(|_| "INTERNAL_ERROR")?;
    services.current(&c.session_id)?;
    let claim=tx.execute("UPDATE support_device_applies SET state='undoing',undone_at=?1 WHERE id=?2 AND undone_at IS NULL",params![super::clock::iso(now),id]).map_err(|_|"INTERNAL_ERROR")?;
    if claim != 1 {
        return Err("PAYLOAD_MISMATCH".into());
    }
    audit(&tx, c, "started", "device_undo", None, now)?;
    tx.commit().map_err(|_| "INTERNAL_ERROR")?;
    let result = (|| {
        let expected = if let Some(raw) = previous {
            let previous: Value = serde_json::from_str(&raw).map_err(|_| "PAYLOAD_MISMATCH")?;
            let mut input = c.payload.clone();
            input["device_kind"] = json!(kind);
            input["existing_device_id"] = json!(device);
            input["settings"] = previous["settings"].clone();
            input["discovered_device_ref"]["ip"] = previous["ip"].clone();
            input["discovered_device_ref"]["port"] = previous["settings"]["port"].clone();
            services.save(
                &input,
                &device,
                Some(&serde_json::from_str::<Value>(&applied).map_err(|_| "PAYLOAD_MISMATCH")?),
                &permit,
            )?;
            Some(previous)
        } else {
            services.remove(
                &kind,
                &device,
                &serde_json::from_str::<Value>(&applied).map_err(|_| "PAYLOAD_MISMATCH")?,
                &permit,
            )?;
            None
        };
        if services.read(&kind, &device)? != expected {
            return Err("OUTCOME_UNKNOWN".into());
        }
        let tx = db::transaction(conn).map_err(|_| "INTERNAL_ERROR")?;
        services.current(&c.session_id)?;
        tx.execute(
            "UPDATE support_device_applies SET state='undone' WHERE id=?1",
            [id],
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        audit(&tx, c, "finished", "device_undo", Some("resolved"), now)?;
        tx.commit().map_err(|_| "INTERNAL_ERROR")?;
        Ok::<_, String>(())
    })();
    if result.is_err() {
        conn.execute(
            "UPDATE support_device_applies SET state='undo_unknown' WHERE id=?1",
            [id],
        )
        .map_err(|_| "INTERNAL_ERROR")?;
        return Err("OUTCOME_UNKNOWN".into());
    }
    result
}

pub(super) fn private_business(app: &tauri::AppHandle) -> Result<crate::db::DbState, String> {
    let path = app.state::<crate::db::DbState>().db_path.clone();
    let conn = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "INTERNAL_ERROR")?;
    conn.busy_timeout(std::time::Duration::from_millis(100))
        .map_err(|_| "INTERNAL_ERROR")?;
    conn.execute_batch("PRAGMA query_only=ON")
        .map_err(|_| "INTERNAL_ERROR")?;
    let deadline = Instant::now() + std::time::Duration::from_secs(2);
    conn.progress_handler(100, Some(move || Instant::now() >= deadline));
    Ok(crate::db::DbState {
        conn: std::sync::Mutex::new(conn),
        db_path: path,
    })
}
/// The native device-apply admission's identity/session check, on its private
/// read connection. Shared with tests so no AppHandle mock can hide a key read.
fn current_session(
    conn: &Connection,
    core: &super::session::Core,
    command: &Command,
    session: &str,
    local_undo: bool,
) -> Result<(), String> {
    super::identity::for_session(conn, core, session)?;
    let s = core
        .session
        .as_ref()
        .filter(|s| s.info.session_id == session)
        .ok_or("SESSION_ENDED")?;
    if local_undo {
        return if s.admission.active
            && core
                .clock
                .now_at(session, Instant::now())
                .is_some_and(|now| {
                    super::clock::parse(&s.admission.max_expires_at).is_ok_and(|end| end > now)
                })
        {
            Ok(())
        } else {
            Err("SESSION_ENDED".into())
        };
    }
    delivery::recheck(command, &s.admission, &core.clock, Instant::now()).map_err(str::to_string)
}

struct NativeServices<'a> {
    app: &'a tauri::AppHandle,
    conn: &'a Connection,
    command: &'a Command,
    permit: std::cell::RefCell<Option<SupportPermit>>,
    local_undo: bool,
    catalogue: Option<&'a super::catalogue::Execution<'a>>,
}
pub(super) fn authorize_device_setting(app: &tauri::AppHandle) -> Result<(), String> {
    crate::auth::authorize_privileged_action(
        crate::auth::PrivilegedActionScope::SystemControl,
        &private_business(app)?,
        &app.state::<crate::auth::AuthState>(),
    )
    .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| "POLICY_REFUSED".into()))
}
impl NativeServices<'_> {
    fn connected(&self, input: &Value) -> Result<(), String> {
        if input["device_kind"] == "printer" {
            return Ok(());
        }
        let id = input["existing_device_id"]
            .as_str()
            .or_else(|| input["discovered_device_ref"]["device_id"].as_str());
        let mgr = self.app.state::<crate::ecr::DeviceManager>();
        if id.is_some_and(|id| mgr.is_connected(id)) {
            return Ok(());
        }
        // A new record can only describe an address the owner already knows
        // as connected. Never open a transport to establish this fact.
        if id.is_none() {
            let db = private_business(self.app)?;
            let conn = db.conn.lock().map_err(|_| "DEVICE_NOT_ADMITTED")?;
            if crate::db::ecr_list_devices(&conn).iter().any(|d| {
                let details = &d["connectionDetails"];
                d["id"].as_str().is_some_and(|id| mgr.is_connected(id))
                    && details["ip"] == input["discovered_device_ref"]["ip"]
                    && details["port"] == input["settings"]["port"]
                    && d["deviceType"]
                        == if input["device_kind"] == "cash_register" {
                            "cash_register"
                        } else {
                            "payment_terminal"
                        }
            }) {
                return Ok(());
            }
        }
        Err("DEVICE_NOT_ADMITTED".into())
    }
}

fn printer_record(input: &Value, id: &str) -> Value {
    let v = &input["settings"];
    json!({"id":id,"name":v["name"],"printerName":input["discovered_device_ref"]["ip"],
        "driverType":"escpos","printerType":"network","role":v["role"],
        "paperWidthMm":v["paper_width_mm"],"escposCodePage":v["code_page"],
        "characterSet":v["character_set"],"greekRenderMode":v["greek_render_mode"],
        "connectionJson":{"type":"network","host":input["discovered_device_ref"]["ip"],"port":v["port"],"emulation":v["emulation"]}})
}
fn read_configuration(conn: &Connection, kind: &str, id: &str) -> Result<Option<Value>, String> {
    if kind == "printer" {
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM printer_profiles WHERE id=?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        if !exists {
            return Ok(None);
        }
        let p = crate::printers::support_get_printer_profile(conn, id)?;
        if p["driverType"] != "escpos" {
            return Err("POLICY_REFUSED".into());
        }
        let connection: Value = p["connectionJson"]
            .as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null);
        return Ok(Some(
            json!({"ip":connection["host"].as_str().or_else(||connection["ip"].as_str()).unwrap_or(""),
            "settings":{"name":p["name"],"role":p["role"],"connection_type":"network","port":connection["port"].as_u64().unwrap_or(9100),
            "emulation":connection["emulation"].as_str().unwrap_or("auto"),"code_page":p["escposCodePage"],"character_set":p["characterSet"],
            "greek_render_mode":p["greekRenderMode"].as_str().unwrap_or("auto"),"paper_width_mm":p["paperWidthMm"]}}),
        ));
    }
    let Some(d) = crate::commands::ecr::support_read_device(conn, id)? else {
        return Ok(None);
    };
    let expected_kind = if kind == "card_terminal" {
        "payment_terminal"
    } else {
        "cash_register"
    };
    if d["deviceType"] != expected_kind || d["connectionType"] != "network" {
        return Err("POLICY_REFUSED".into());
    }
    let protocol = match d["protocol"].as_str().unwrap_or("") {
        "cap_driver" | "rbs_cap_driver" | "mat_cap_driver" => "cap",
        "generic" if kind == "cash_register" => "generic_fiscal",
        p => p,
    };
    Ok(Some(
        json!({"ip":d["connectionDetails"]["host"].as_str().or_else(||d["connectionDetails"]["ip"].as_str()).unwrap_or(""),
        "settings":{"name":d["name"],"connection_type":"network","port":d["connectionDetails"]["port"],"protocol":protocol}}),
    ))
}

/// Only device-owner SQL can write here. Financial, fiscal and shift tables,
/// schema changes, attachments and extension loading are denied by the engine.
fn device_write_connection(path: &std::path::Path) -> Result<Connection, String> {
    use rusqlite::{
        config::DbConfig,
        hooks::{AuthAction, AuthContext, Authorization},
    };
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "INTERNAL_ERROR")?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF")
        .map_err(|_| "INTERNAL_ERROR")?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|_| "INTERNAL_ERROR")?;
    let rc = unsafe {
        rusqlite::ffi::sqlite3_db_config(
            conn.handle(),
            rusqlite::ffi::SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
            0,
            std::ptr::null_mut::<i32>(),
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err("INTERNAL_ERROR".into());
    }
    conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Insert { table_name } | AuthAction::Delete { table_name }
            if ctx.database_name == Some("main")
                && ["printer_profiles", "ecr_devices"].contains(&table_name) =>
        {
            Authorization::Allow
        }
        AuthAction::Update {
            table_name,
            column_name,
        } if ctx.database_name == Some("main")
            && ((table_name == "printer_profiles"
                && [
                    "name",
                    "role",
                    "paper_width_mm",
                    "character_set",
                    "greek_render_mode",
                    "connection_json",
                    "escpos_code_page",
                    "updated_at",
                ]
                .contains(&column_name))
                || (table_name == "ecr_devices"
                    && [
                        "name",
                        "device_type",
                        "protocol",
                        "connection_type",
                        "connection_details",
                        "updated_at",
                    ]
                    .contains(&column_name))) =>
        {
            Authorization::Allow
        }
        AuthAction::Read { .. } | AuthAction::Select | AuthAction::Transaction { .. } => {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if ["datetime", "strftime", "coalesce"].contains(&function_name) =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }));
    Ok(conn)
}

impl DeviceServices for NativeServices<'_> {
    fn provenance(&self, session: &str, input: &Value) -> Result<bool, String> {
        let reference = &input["discovered_device_ref"];
        if reference["source"] == "configured" {
            let Some(id) = reference["device_id"].as_str() else {
                return Ok(false);
            };
            return Ok(self
                .read(field(input, "device_kind")?, id)?
                .is_some_and(|r| {
                    r["ip"] == reference["ip"] && r["settings"]["port"] == reference["port"]
                }));
        }
        let Some(scan) = reference["scan_id"].as_str() else {
            return Ok(false);
        };
        let result:Option<String>=self.conn.query_row("SELECT result_json FROM support_accepted_commands WHERE json_extract(result_json,'$.data.scan_id')=?1 AND session_id=?2 AND kind='till_network_scan' AND finished_at IS NOT NULL",params![scan,session],|r|r.get(0)).optional().map_err(|_|"POLICY_REFUSED")?;
        let result = result
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);
        Ok(result["data"]["devices"].as_array().is_some_and(|devices| {
            devices.iter().any(|d| {
                d["ip"] == reference["ip"]
                    && d["open_ports"]
                        .as_array()
                        .is_some_and(|ports| ports.contains(&reference["port"]))
            })
        }))
    }
    fn validate(&self, input: &Value) -> Result<(), String> {
        let db = private_business(self.app)?;
        let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        if input["device_kind"] == "printer" {
            let profile = printer_record(input, input["existing_device_id"].as_str().unwrap_or(""));
            crate::printers::support_validate_printer_profile(
                &conn,
                &profile,
                input["existing_device_id"].is_string(),
            )
            .map_err(|_| "POLICY_REFUSED".into())
        } else {
            crate::commands::ecr::support_device_record(input, "").map(|_| ())
        }
    }
    fn read(&self, kind: &str, id: &str) -> Result<Option<Value>, String> {
        let db = private_business(self.app)?;
        let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        read_configuration(&conn, kind, id)
    }
    fn retained_identification(&self, session: &str, input: &Value) -> Result<Value, String> {
        let result:Option<String>=self.conn.query_row("SELECT json_extract(result_json,'$.data') FROM support_accepted_commands WHERE session_id=?1 AND kind='till_network_identify' AND finished_at IS NOT NULL AND json_extract(result_json,'$.data.ip')=?2 AND json_extract(result_json,'$.data.port')=?3 ORDER BY finished_at DESC LIMIT 1",params![session,field(&input["discovered_device_ref"],"ip")?,input["settings"]["port"].as_u64()],|r|r.get(0)).optional().map_err(|_|"INTERNAL_ERROR")?;
        Ok(result
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or(Value::Null))
    }
    fn fresh_admission(&self, kind: &str) -> Result<Option<bool>, String> {
        // Connection state belongs to admission, after approval consumption on
        // apply. This reads only owner state and never opens a device transport.
        self.connected(&self.command.payload)?;
        let db = private_business(self.app)?;
        let scope = {
            let conn = db.conn.lock().map_err(|_| "DEVICE_NOT_ADMITTED")?;
            crate::gift_financial_opening::OpeningScope::resolve(&conn)
                .ok_or("DEVICE_NOT_ADMITTED")?
        };
        let path = if kind == "cash_register" {
            crate::device_admission::MYDATA_CONFIG_PATH
        } else {
            crate::device_admission::MANUAL_ADMISSION_PATH
        };
        let response =
            tauri::async_runtime::block_on(crate::admin_fetch(Some(&db), path, "GET", None))
                .map_err(|_| "DEVICE_NOT_ADMITTED")?;
        Ok(if kind == "cash_register" {
            crate::device_admission::fiscal_admission_from_response(&response).map(|v| v.0)
        } else {
            match crate::manual_order_cancellation::admission_from_response(&scope, &response) {
                crate::manual_order_cancellation::ProviderAdmission::Connected => Some(true),
                crate::manual_order_cancellation::ProviderAdmission::NotConnected => Some(false),
                _ => None,
            }
        })
    }
    fn onsite(&self, c: &Command, input: &Value) -> Result<(), String> {
        if self.local_undo {
            // This IPC is the local Undo tap. Unlike a remote command it has
            // no accepted-command envelope; manual authority is checked next.
            return self.current(&c.session_id);
        }
        let description = format!(
            "{}: {} {}:{} ({})",
            field(input, "device_kind")?,
            field(&input["settings"], "name")?,
            field(&input["discovered_device_ref"], "ip")?,
            input["settings"]["port"],
            input["settings"]
                .get("protocol")
                .or_else(|| input["settings"].get("emulation"))
                .unwrap_or(&Value::Null)
        );
        super::onsite::request(
            self.app,
            &c.command_id,
            &c.session_id,
            if self.local_undo {
                "support.deviceApply.undo"
            } else {
                "support.onsite.title"
            },
            &description,
            input,
            true,
            None,
            true,
        )?;
        struct ClearOnExit(String);
        impl Drop for ClearOnExit {
            fn drop(&mut self) {
                if let Ok(mut onsite) = super::onsite::global().lock() {
                    if onsite.answer(&self.0, Instant::now()).is_ok() {
                        onsite.clear();
                    }
                }
            }
        }
        let _clear = ClearOnExit(c.command_id.clone());
        loop {
            self.current(&c.session_id)?;
            let answer = super::onsite::global()
                .lock()
                .map_err(|_| "INTERNAL_ERROR")?
                .answer(&c.command_id, Instant::now())?;
            if let Some(answer) = answer {
                super::onsite::global()
                    .lock()
                    .map_err(|_| "INTERNAL_ERROR")?
                    .clear();
                return if answer == "confirmed" {
                    Ok(())
                } else {
                    Err(answer)
                };
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    fn authorize(&self, _kind: &str) -> Result<bool, String> {
        authorize_device_setting(self.app)?;
        Ok(true)
    }
    fn current(&self, session: &str) -> Result<(), String> {
        if let Some(execution) = self.catalogue {
            execution.checkpoint()?;
        }
        if self
            .permit
            .borrow()
            .as_ref()
            .is_some_and(SupportPermit::is_cancelled)
        {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        let db = private_business(self.app)?;
        let rt = super::session::runtime(self.app)?;
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let read = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        current_session(&read, &core, self.command, session, self.local_undo)
    }

    fn before_effect(&self) -> Result<(), String> {
        if let Some(execution) = self.catalogue {
            execution.checkpoint()?;
        }
        Ok(())
    }

    fn release_read_permit(&self) -> Result<(), String> {
        let permit = self.permit.borrow_mut().take();
        if permit.as_ref().is_some_and(SupportPermit::is_cancelled) {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        drop(permit);
        Ok(())
    }
    fn save(
        &self,
        input: &Value,
        id: &str,
        expected: Option<&Value>,
        permit: &SupportPermit,
    ) -> Result<(), String> {
        self.current(&self.command.session_id)?;
        authorize_device_setting(self.app).map_err(|_| "POLICY_REFUSED")?;
        self.connected(input)?;
        let path = self.app.state::<crate::db::DbState>().db_path.clone();
        let conn = device_write_connection(&path)?;
        let tx = permit.begin_write(&conn)?;
        self.current(&self.command.session_id)?;
        if read_configuration(&tx, field(input, "device_kind")?, id)?.as_ref() != expected {
            return Err("PAYLOAD_MISMATCH".into());
        }
        let existing = expected.is_some();
        if let Some(execution) = self.catalogue {
            execution.before_effect()?;
        }
        if input["device_kind"] == "printer" {
            crate::printers::support_save_printer_profile(
                &tx,
                &printer_record(input, id),
                id,
                existing,
            )?;
        } else {
            crate::commands::ecr::support_save_device(
                &tx,
                &crate::commands::ecr::support_device_record(input, id)?,
                existing,
            )?;
        }
        if read_configuration(&tx, field(input, "device_kind")?, id)? != Some(configuration(input))
        {
            return Err("PAYLOAD_MISMATCH".into());
        }
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        let fingerprint = self
            .catalogue
            .map(|execution| execution.saved_printer_fingerprint(&tx, id))
            .transpose()?;
        tx.commit().map_err(|_| "OUTCOME_UNKNOWN")?;
        if let (Some(execution), Some(fingerprint)) = (self.catalogue, fingerprint) {
            execution.accept_saved_printer(fingerprint);
        }
        Ok(())
    }
    fn remove(
        &self,
        kind: &str,
        id: &str,
        expected: &Value,
        permit: &SupportPermit,
    ) -> Result<(), String> {
        self.current(&self.command.session_id)?;
        authorize_device_setting(self.app).map_err(|_| "POLICY_REFUSED")?;
        let mut input = self.command.payload.clone();
        input["existing_device_id"] = json!(id);
        self.connected(&input)?;
        let path = self.app.state::<crate::db::DbState>().db_path.clone();
        let conn = device_write_connection(&path)?;
        let tx = permit.begin_write(&conn)?;
        if read_configuration(&tx, kind, id)?.as_ref() != Some(expected) {
            return Err("PAYLOAD_MISMATCH".into());
        }
        if kind == "printer" {
            crate::printers::support_delete_printer_profile(&tx, id)?;
        } else {
            crate::commands::ecr::support_remove_device(&tx, id)?;
        }
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        tx.commit().map_err(|_| "OUTCOME_UNKNOWN".into())
    }
}
/// Construct the existing owner's closed configured-device input from the
/// selected local profile. No address or settings come from operator prose.
pub(crate) fn catalogue_profile_command(
    conn: &Connection,
    command: &Command,
    input: &super::catalogue::contract::ApplyProfile,
) -> Result<Command, String> {
    let scope = super::identity::local(conn)?;
    super::catalogue::resolve_printer(conn, &scope, &input.printer)?;
    let profile = crate::printers::support_get_printer_profile(conn, &input.printer.id)?;
    if profile["driverType"] != "escpos" || profile["printerType"] != "network" {
        return Err("POLICY_REFUSED".into());
    }
    let previous =
        read_configuration(conn, "printer", &input.printer.id)?.ok_or("PAYLOAD_DRIFT")?;
    let mut c = command.clone();
    let mut settings = previous["settings"].clone();
    settings["emulation"] = serde_json::to_value(input.emulation).map_err(|_| "INVALID_INPUT")?;
    c.payload = json!({"step":"validate","device_kind":"printer","existing_device_id":input.printer.id,"discovered_device_ref":{"source":"configured","device_id":input.printer.id,"ip":previous["ip"],"port":settings["port"]},"settings":settings,"idempotency_key":command.idempotency_key});
    checked(&c)?;
    Ok(c)
}

pub(crate) fn apply_catalogue_saved_profile(
    app: &tauri::AppHandle,
    conn: &Connection,
    execution: &super::catalogue::Execution<'_>,
    context: &Context,
) -> Result<Value, String> {
    let super::catalogue::contract::Action::ApplyProfile { inputs, .. } = execution.action else {
        return Err("INVALID_INPUT".into());
    };
    execution.checkpoint()?;
    let db = private_business(app)?;
    let mut c = {
        let read = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        catalogue_profile_command(&read, execution.command, inputs)?
    };
    execution.checkpoint()?;
    let services = NativeServices {
        app,
        conn,
        command: execution.command,
        permit: std::cell::RefCell::new(None),
        local_undo: false,
        catalogue: Some(execution),
    };
    let validation = execution.after_wait(|| validate(conn, &services, &c, context))?;
    c.payload["step"] = json!("apply");
    c.payload["validation_id"] = validation["validation_id"].clone();
    apply_with_permit(
        conn,
        &services,
        &Verifier::pinned(),
        &c,
        context,
        execution.permit,
    )
}

pub fn run(
    app: &tauri::AppHandle,
    conn: &Connection,
    c: &Command,
    context: &Context,
) -> Result<Value, String> {
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let services = NativeServices {
        app,
        conn,
        command: c,
        permit: std::cell::RefCell::new(Some(permit)),
        local_undo: false,
        catalogue: None,
    };
    if c.payload["step"] == "validate" {
        validate(conn, &services, c, context)
    } else {
        apply(conn, &services, &Verifier::pinned(), c, context)
    }
}
#[tauri::command]
pub async fn support_undo_device_apply(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("support_undo_device_apply",move || {
        if !crate::auth::has_permission(&app.state::<crate::auth::AuthState>(),Some("pos.support.connect")){return Err("POLICY_REFUSED".into())}
        let input=arg0.unwrap_or(json!({"action":"list"}));
        let rt=super::session::runtime(&app)?;let core=rt.core.lock().map_err(|_|"INTERNAL_ERROR")?;
        if input["action"]=="list" {
            let Some(session)=core.session.as_ref() else {return Ok(json!({"applies":[]}))};
            let mut stmt=core.executor.db.conn.prepare("SELECT a.id,v.session_id,a.device_id,a.state,a.undone_at FROM support_device_applies a JOIN support_validations v ON v.validation_id=a.validation_id WHERE v.session_id=?1 ORDER BY a.applied_at DESC LIMIT 20").map_err(|_|"INTERNAL_ERROR")?;
            let rows=stmt.query_map([&session.info.session_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"session_id":r.get::<_,String>(1)?,"device_id":r.get::<_,String>(2)?,"state":r.get::<_,String>(3)?,"undo_available":r.get::<_,Option<String>>(4)?.is_none()}))).map_err(|_|"INTERNAL_ERROR")?;
            return Ok(json!({"applies":rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|"INTERNAL_ERROR")?}));
        }
        let id=input["apply_id"].as_str().or_else(||input["id"].as_str()).ok_or("INVALID_INPUT")?;
        let (session,payload,validation):(String,String,String)=core.executor.db.conn.query_row("SELECT v.session_id,v.device_ref_json,v.validation_id FROM support_device_applies a JOIN support_validations v ON v.validation_id=a.validation_id WHERE a.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"PAYLOAD_MISMATCH")?;
        if !core.session.as_ref().is_some_and(|s| s.info.session_id == session) || input["session_id"].as_str().is_some_and(|requested| requested != session) { return Err("SESSION_ENDED".into()); }
        let mut payload: Value = serde_json::from_str(&payload).map_err(|_| "PAYLOAD_MISMATCH")?;
        payload["validation_id"] = json!(validation);
        let c:Command=serde_json::from_value(json!({"command_id":uuid::Uuid::new_v4().to_string(),"session_id":session,"sequence":1,"kind":"till_apply_device_settings","tier":2,"payload":payload,"payload_sha256":"","idempotency_key":"your_local_undo_request","call_id":uuid::Uuid::new_v4().to_string(),"created_at":super::clock::iso(core.now()),"expires_at":super::clock::iso(core.now()),"server_time":super::clock::iso(core.now()),"approval":null})).map_err(|_|"PAYLOAD_MISMATCH")?;
        let id = id.to_string();
        let now = core.now();
        let path = core.executor.db.path.clone();
        // Never hold session state across the on-site wait: End and checkout
        // must remain able to cancel this operation.
        drop(core);
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| "INTERNAL_ERROR")?;
        conn.busy_timeout(std::time::Duration::from_millis(100)).map_err(|_| "INTERNAL_ERROR")?;
        let services=NativeServices{app:&app,conn:&conn,command:&c,permit:std::cell::RefCell::new(Some(critical_op::global().try_begin_support(false,None).map_err(str::to_string)?)),local_undo:true,catalogue:None};
        undo(&conn,&services,&c,&id,now)?;
        Ok(json!({"success":true}))
    }).await
}

#[cfg(test)]
#[path = "tests/device_apply_owner_tests.rs"]
mod owner_tests;
