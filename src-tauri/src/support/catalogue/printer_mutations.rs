//! Scoped printer control; physical output always remains unknown.
use super::{
    contract::{Action, PauseAction},
    Execution,
};
use crate::{print, support::onsite};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

pub(super) fn handles(action: &Action) -> bool {
    matches!(
        action,
        Action::PauseDispatch { .. } | Action::CancelJob { .. }
    )
}
pub(super) fn authorize(app: &tauri::AppHandle) -> Result<(), String> {
    // The manual queue controls need no permission of their own (R14.10), so
    // support needs only the on-site support permission. No PIN or keyring.
    if !crate::auth::has_permission(
        &app.state::<crate::auth::AuthState>(),
        Some("pos.support.connect"),
    ) {
        return Err("POLICY_REFUSED".into());
    }
    Ok(())
}
pub(super) fn run(native: &super::Native<'_>, execution: &Execution<'_>) -> Result<Value, String> {
    let reference = execution.action.printer().ok_or("INVALID_INPUT")?;
    authorize(native.app)?;
    execution.checkpoint()?;
    let conn = native.read(execution.permit)?;
    let profile = super::profile(&conn, &native.scope, &reference.id)?;
    let name = profile["name"]
        .as_str()
        .filter(|n| !n.is_empty() && n.chars().count() <= 160)
        .ok_or("PAYLOAD_DRIFT")?;
    let action = match execution.action {
        Action::PauseDispatch { inputs, .. } => match inputs.action {
            PauseAction::Pause => "pause",
            PauseAction::ResumeOwnPause => "resume_own_pause",
        },
        Action::CancelJob { .. } => "cancel_one_uncertain_job",
        _ => return Err("INVALID_INPUT".into()),
    };
    let payload = json!({"request_id":execution.command.command_id,"session_id":execution.command.session_id,
        "title":"support.onsite.title","description":"","technical_details":"","needs_staff_pin":false,"remaining_ms":300000,
        "catalogue":{"action":action,"printer_name":name}});
    drop(conn);
    onsite::global()
        .lock()
        .map_err(|_| "INTERNAL_ERROR")?
        .begin(
            &execution.command.command_id,
            &execution.command.session_id,
            payload.clone(),
            Instant::now(),
        )?;
    struct Clear(String);
    impl Drop for Clear {
        fn drop(&mut self) {
            if let Ok(mut state) = onsite::global().lock() {
                if state.answer(&self.0, Instant::now()).is_ok() {
                    state.clear();
                }
            }
        }
    }
    let _clear = Clear(execution.command.command_id.clone());
    native
        .app
        .emit("support://onsite-request", payload)
        .map_err(|_| "INTERNAL_ERROR")?;
    loop {
        execution.checkpoint()?;
        authorize(native.app)?;
        let answer = onsite::global()
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .answer(&execution.command.command_id, Instant::now())?;
        if let Some(answer) = answer {
            if answer != "confirmed" {
                return Err(answer);
            }
            break;
        }
        execution.after_wait(|| {
            std::thread::sleep(Duration::from_millis(25));
            Ok(())
        })?;
    }
    execution.checkpoint()?;
    authorize(native.app)?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let db = print::support_printer_connection(&native.live)?;
    let detail = match execution.action {
        Action::PauseDispatch { inputs, .. } => print::support_set_profile_pause(
            &db,
            &reference.id,
            &execution.command.session_id,
            &execution.command.command_id,
            matches!(inputs.action, PauseAction::Pause),
            execution.permit,
            deadline,
            &|| execution.checkpoint(),
            &|| execution.before_effect(),
        )?,
        Action::CancelJob { .. } => {
            let preview = native.preview.borrow();
            let preview = preview.as_ref().ok_or("PAYLOAD_DRIFT")?;
            print::support_cancel_uncertain(
                &db,
                &reference.id,
                preview,
                execution.permit,
                deadline,
                &|| execution.checkpoint(),
                &|| execution.before_effect(),
                Arc::new(crate::windows_spooler::SystemWindowsSpooler),
            )?
        }
        _ => return Err("INVALID_INPUT".into()),
    };
    print::notify_print_queue_changed(native.app);
    let outcome = match detail["state"].as_str() {
        Some("cancel_confirmed") => "resolved",
        Some("cancel_requested") => "pending",
        Some("cancel_failed") => "failed",
        Some(_) => "unknown",
        None => {
            if detail["status"] == "available" {
                "resolved"
            } else {
                "unknown"
            }
        }
    };
    Ok(
        json!({"kind":"untrusted_till_data","outcome":outcome,"observation_time":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"source":"printer_owner","complete":true,"details":[detail]}),
    )
}
pub(super) fn recheck_approval(
    native: &super::Native<'_>,
    command: &crate::support::contracts::Command,
) -> Result<(), String> {
    if let Some(proof) = &native.approval {
        let core = native.runtime.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let context = core.approval_context()?;
        core.verifier.assert_consumed_command(
            native.store,
            proof,
            &context,
            &command.command_id,
            &command.payload,
        )?;
    }
    Ok(())
}
