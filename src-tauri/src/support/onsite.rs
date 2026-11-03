//! Native presentation and staff-authority fence; renderer timestamps are never trusted.
use super::critical_op;
use serde_json::{json, Value};
use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

pub struct Request {
    pub id: String,
    pub session: String,
    pub payload: Value,
    created: Instant,
    shown: Option<Instant>,
    pub answer: Option<String>,
}
#[derive(Default)]
pub struct Onsite {
    pending: Option<Request>,
}
impl Onsite {
    pub fn begin(
        &mut self,
        id: &str,
        session: &str,
        payload: Value,
        now: Instant,
    ) -> Result<(), String> {
        if self.pending.as_ref().is_some_and(|p| p.answer.is_none()) {
            return Err("CONCURRENT_OPERATION".into());
        }
        self.pending = Some(Request {
            id: id.into(),
            session: session.into(),
            payload,
            created: now,
            shown: None,
            answer: None,
        });
        Ok(())
    }
    pub fn decide(
        &mut self,
        id: &str,
        session: &str,
        decision: &str,
        permitted: bool,
        critical: bool,
        now: Instant,
    ) -> Result<(), String> {
        let p = self
            .pending
            .as_mut()
            .filter(|p| p.id == id && p.session == session)
            .ok_or("PAYLOAD_MISMATCH")?;
        if p.answer.as_deref() == Some("ONSITE_TIMEOUT") && decision == "timeout" {
            return Ok(());
        }
        if p.answer.is_some() {
            return Err("PAYLOAD_MISMATCH".into());
        }
        if now.saturating_duration_since(p.created) >= Duration::from_secs(300) {
            p.answer = Some("ONSITE_TIMEOUT".into());
            return if decision == "timeout" {
                Ok(())
            } else {
                Err("ONSITE_TIMEOUT".into())
            };
        }
        if critical {
            p.shown = None;
            return Err("CONCURRENT_OPERATION".into());
        }
        if decision == "shown" {
            p.shown.get_or_insert(now);
            return Ok(());
        }
        if decision == "timeout" {
            return Err("PAYLOAD_MISMATCH".into());
        }
        if !permitted {
            return Err("POLICY_REFUSED".into());
        }
        if decision == "declined" {
            p.answer = Some("ONSITE_DECLINED".into());
            return Ok(());
        }
        if p.shown
            .is_none_or(|at| now.saturating_duration_since(at) < Duration::from_secs(2))
        {
            return Err("POLICY_REFUSED".into());
        }
        let physical = p.payload.get("check_id").is_some();
        if !(if physical {
            ["done", "not_done"].contains(&decision)
        } else {
            decision == "confirmed"
        }) {
            return Err("INVALID_INPUT".into());
        }
        p.answer = Some(decision.into());
        Ok(())
    }
    pub fn answer(&mut self, id: &str, now: Instant) -> Result<Option<String>, String> {
        let p = self
            .pending
            .as_mut()
            .filter(|p| p.id == id)
            .ok_or("PAYLOAD_MISMATCH")?;
        if now.saturating_duration_since(p.created) >= Duration::from_secs(300)
            && p.answer.is_none()
        {
            p.answer = Some("ONSITE_TIMEOUT".into());
        }
        Ok(p.answer.clone())
    }
    pub fn clear(&mut self) {
        self.pending = None;
    }
    pub fn reset_during_critical(&mut self) {
        if let Some(p) = &mut self.pending {
            p.shown = None;
        }
    }
    pub fn shown(&self) -> Option<Instant> {
        self.pending.as_ref().and_then(|p| p.shown)
    }
}
pub fn global() -> &'static Mutex<Onsite> {
    static STATE: OnceLock<Mutex<Onsite>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}
pub fn request(
    app: &tauri::AppHandle,
    id: &str,
    session: &str,
    title: &str,
    description: &str,
    details: &Value,
    needs_pin: bool,
    check: Option<&str>,
    emit: bool,
) -> Result<(), String> {
    let mut payload = json!({"request_id":id,"session_id":session,"title":title,"description":description,"technical_details":details.to_string(),"needs_staff_pin":needs_pin,"remaining_ms":300000});
    if let Some(check) = check {
        payload["check_id"] = json!(check);
    }
    global().lock().map_err(|_| "INTERNAL_ERROR")?.begin(
        id,
        session,
        payload.clone(),
        Instant::now(),
    )?;
    if emit {
        app.emit("support://onsite-request", payload)
            .map_err(|_| "INTERNAL_ERROR")?;
    }
    Ok(())
}
#[tauri::command]
pub async fn support_onsite_decision(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("support_onsite_decision", move || {
        let input = arg0.ok_or("INVALID_INPUT")?;
        let session = input["session_id"].as_str().ok_or("INVALID_INPUT")?;
        let id = input["request_id"].as_str().ok_or("INVALID_INPUT")?;
        let decision = input["decision"].as_str().ok_or("INVALID_INPUT")?;
        let rt = super::session::runtime(&app)?;
        let core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        if core
            .session
            .as_ref()
            .is_none_or(|s| !s.admission.active || s.info.session_id != session)
        {
            return Err("SESSION_ENDED".into());
        }
        if ["confirmed","done","not_done"].contains(&decision) {
            let encoded:String=core.executor.db.conn.query_row("SELECT envelope_json FROM support_accepted_commands WHERE command_id=?1 AND session_id=?2 AND state='executing'",rusqlite::params![id,session],|r|r.get(0)).map_err(|_|"PAYLOAD_MISMATCH")?;
            let command:super::contracts::Command=serde_json::from_str(&encoded).map_err(|_|"PAYLOAD_MISMATCH")?;
            let admission=&core.session.as_ref().ok_or("SESSION_ENDED")?.admission;
            super::delivery::recheck(&command,admission,&core.clock,Instant::now()).map_err(str::to_string)?;
            if command.kind == "till_apply_device_settings" {
                super::device_apply::authorize_device_setting(&app)?;
            }
        }
        let permitted = crate::auth::has_permission(
            &app.state::<crate::auth::AuthState>(),
            Some("pos.support.connect"),
        );
        let mut onsite = global().lock().map_err(|_| "INTERNAL_ERROR")?;
        let now = Instant::now();
        if onsite.shown().is_some_and(|shown| {
            critical_op::global()
                .activity_between(shown, now)
                .is_none_or(|history| !history.is_empty())
        }) {
            onsite.reset_during_critical();
        }
        onsite.decide(
            id,
            session,
            decision,
            permitted,
            critical_op::global().active(),
            now,
        )?;
        Ok(json!({"accepted":true}))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn onsite_presentation_permission_decline_timeout_and_critical_fences() {
        let now = Instant::now();
        let mut o = Onsite::default();
        o.begin("a", "s", json!({}), now).unwrap();
        assert!(o.begin("b", "s", json!({}), now).is_err());
        assert!(o
            .decide(
                "a",
                "s",
                "confirmed",
                true,
                false,
                now + Duration::from_secs(3)
            )
            .is_err());
        o.decide("a", "s", "shown", false, false, now).unwrap();
        assert!(o
            .decide(
                "a",
                "s",
                "confirmed",
                true,
                false,
                now + Duration::from_millis(1999)
            )
            .is_err());
        assert!(o
            .decide(
                "a",
                "s",
                "confirmed",
                false,
                false,
                now + Duration::from_secs(2)
            )
            .is_err());
        assert!(o
            .decide(
                "a",
                "s",
                "confirmed",
                true,
                true,
                now + Duration::from_secs(2)
            )
            .is_err());
        o.decide(
            "a",
            "s",
            "shown",
            false,
            false,
            now + Duration::from_secs(3),
        )
        .unwrap();
        o.decide(
            "a",
            "s",
            "confirmed",
            true,
            false,
            now + Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            o.answer("a", now + Duration::from_secs(5))
                .unwrap()
                .as_deref(),
            Some("confirmed")
        );
        o.clear();
        o.begin("b", "s", json!({}), now).unwrap();
        o.decide("b", "s", "declined", true, false, now).unwrap();
        assert_eq!(
            o.answer("b", now).unwrap().as_deref(),
            Some("ONSITE_DECLINED")
        );
        o.clear();
        o.begin("c", "s", json!({"check_id":"check_printer_paper"}), now)
            .unwrap();
        o.decide("c", "s", "shown", false, false, now).unwrap();
        assert!(o
            .decide(
                "c",
                "s",
                "confirmed",
                true,
                false,
                now + Duration::from_secs(2)
            )
            .is_err());
        o.decide(
            "c",
            "s",
            "not_done",
            true,
            false,
            now + Duration::from_secs(2),
        )
        .unwrap();
        o.clear();
        o.begin("d", "s", json!({}), now).unwrap();
        assert_eq!(
            o.answer("d", now + Duration::from_secs(300))
                .unwrap()
                .as_deref(),
            Some("ONSITE_TIMEOUT")
        );
        o.decide(
            "d",
            "s",
            "timeout",
            false,
            false,
            now + Duration::from_secs(300),
        )
        .unwrap();
        o.begin("e", "s", json!({}), now + Duration::from_secs(300))
            .unwrap();
    }
}
