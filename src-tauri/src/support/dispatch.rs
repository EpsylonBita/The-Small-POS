use super::{
    contracts::{self, Command},
    critical_op::{self, SupportPermit},
    session::Runtime,
};
use crate::database_lock::run_blocking_command;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{atomic::Ordering, Arc, Mutex, OnceLock},
};
use tauri::Manager;

pub type TierOneHandler =
    Arc<dyn Fn(&Command, &SupportPermit) -> Result<Value, String> + Send + Sync>;
fn handlers() -> &'static Mutex<BTreeMap<String, TierOneHandler>> {
    static HANDLERS: OnceLock<Mutex<BTreeMap<String, TierOneHandler>>> = OnceLock::new();
    HANDLERS.get_or_init(Mutex::default)
}
/// Native shipped collectors register here, never through IPC or a server payload.
pub fn register_tier_one(kind: &str, handler: TierOneHandler) -> Result<(), String> {
    let definition = contracts::shared().kinds.get(kind).ok_or("INVALID_INPUT")?;
    if definition.tier != 1 || definition.execution != "till" || definition.mutating {
        return Err("TIER_NOT_ALLOWED".into());
    }
    handlers()
        .lock()
        .map_err(|_| "INTERNAL_ERROR")?
        .insert(kind.into(), handler);
    Ok(())
}
pub fn capabilities() -> Vec<String> {
    let mut caps = vec!["support.protocol.v1".into()];
    if handlers().lock().is_ok_and(|h| !h.is_empty()) {
        caps.push("support.tier1.v1".into());
    }
    caps.push("support.tier2.v1".into());
    caps.push("support.tier3.v1".into());
    caps
}
/// Whether the POS window is on screen. It asks for the window, not for a
/// "webview window": Tauri answers `None` to `get_webview_window` for a window
/// that holds more than one webview, and a till with efood keeps the efood
/// Partner page as a second webview in the main window from startup
/// (`efood_partner::ensure_webview`). Such a till read as hidden for good, so
/// its banner said paused and no support command ever started (12/11/2026).
pub fn window_visible(app: &tauri::AppHandle) -> bool {
    app.get_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true))
}
pub fn visible_admission(
    active: bool,
    banner_ready: bool,
    window_visible: bool,
) -> Result<(), &'static str> {
    if !active {
        return Err("SESSION_ENDED");
    }
    if !banner_ready || !window_visible {
        return Err("TILL_PAUSED");
    }
    Ok(())
}
fn admit_presented(
    core: &mut super::session::Core,
    c: &Command,
    ready: bool,
    visible: bool,
) -> Result<bool, String> {
    let active = core.session.as_ref().is_some_and(|s| s.admission.active);
    if let Err(code) = visible_admission(active, ready, visible) {
        let now = core.now();
        if code == "TILL_PAUSED" {
            core.executor.wait(c, "paused", now)?;
        } else {
            core.executor.refuse_queued(c, code, now)?;
        }
        return Ok(false);
    }
    Ok(true)
}
fn spawn_catalogue(
    app: tauri::AppHandle,
    rt: Arc<Runtime>,
    c: Command,
    path: std::path::PathBuf,
    approval: Option<super::approval_verify::ConsumedCommandApproval>,
) {
    // Human confirmation must not stall the command transport lane.
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let result = (|| {
            let store = rusqlite::Connection::open(path).map_err(|_| "INTERNAL_ERROR")?;
            store
                .busy_timeout(std::time::Duration::from_millis(100))
                .map_err(|_| "INTERNAL_ERROR")?;
            super::catalogue::run(&app, &rt, &store, &c, approval)
        })();
        let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let now = core.now();
        match result {
            Ok(data) => {
                if let Err(code) = core.executor.finish(&c, data, now) {
                    core.executor.fail(&c, &code, now)?;
                }
            }
            Err(code) => {
                let code = if code == "deferred_critical_operation" {
                    "PREEMPTED_BY_CRITICAL_OPERATION"
                } else {
                    &code
                };
                core.executor.fail(&c, code, now)?;
            }
        }
        Ok(())
    });
}

pub async fn drive(app: &tauri::AppHandle, rt: &Arc<Runtime>) {
    let tick_app = app.clone();
    let tick_rt = rt.clone();
    let _ = tokio::task::spawn_blocking(move || super::remedy_run::tick(&tick_app, &tick_rt)).await;
    let queued = {
        let Ok(core) = rt.core.lock() else {
            return;
        };
        core.executor.queued().unwrap_or_default()
    };
    for c in queued {
        let app = app.clone();
        let rt = rt.clone();
        let _ = run_blocking_command("support_dispatch", move || {
            let handler = handlers().lock().ok().and_then(|h| h.get(&c.kind).cloned());
            let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR".to_string())?;
            let visible = window_visible(&app);
            if !admit_presented(
                &mut core,
                &c,
                rt.banner_ready.load(Ordering::Acquire),
                visible,
            )? {
                return Ok::<(), String>(());
            }
            let mut a = core
                .session
                .as_ref()
                .ok_or("SESSION_ENDED")?
                .admission
                .clone();
            a.visible = visible;
            let now = core.now();
            if c.kind == "breakglass_propose_command" {
                let code = super::terminal_cmd::refuse_unavailable(&core.executor.db.conn);
                core.executor.refuse_queued(&c, code, now)?;
                return Ok(());
            }
            if c.kind == "breakglass_propose_catalogue_action" {
                // Spend before detaching a worker or waiting on the critical
                // gate, preview, snapshot or on-site confirmation.
                let super::session::Core {
                    executor, clock, ..
                } = &mut *core;
                if let Err(code) = executor.start(&c, &a, clock) {
                    executor.refuse_queued(&c, &code, now)?;
                    return Ok(());
                }
                let proof = (|| {
                    let context = core.approval_context()?;
                    core.verifier.consume_command(
                        &core.executor.db.conn,
                        c.approval.as_ref().ok_or("APPROVAL_NOT_VERIFIED")?,
                        &context,
                        &c.command_id,
                        &c.payload,
                    )
                })();
                let proof = match proof {
                    Ok(proof) => proof,
                    Err(code) => {
                        core.executor.fail(&c, &code, now)?;
                        return Ok(());
                    }
                };
                let path = core.executor.db.path.clone();
                drop(core);
                spawn_catalogue(app, rt, c, path, Some(proof));
                return Ok(());
            }
            let permit = match critical_op::global().try_begin_support(false, None) {
                Ok(p) => p,
                Err("deferred_critical_operation") => {
                    core.executor.wait(&c, "deferred", now)?;
                    return Ok(());
                }
                Err(_) => return Ok(()),
            };
            let phase_two = c.tier == 2
                && (super::remedy_run::handles(&c.kind) || c.kind == "till_apply_device_settings");
            let phase_three = c.tier == 3 && super::breakglass::handles(&c.kind);
            let catalogue = matches!(
                c.kind.as_str(),
                "till_run_catalogue_action" | "breakglass_propose_catalogue_action"
            );
            if !catalogue && !phase_three && !phase_two && (c.tier != 1 || handler.is_none()) {
                core.executor.refuse_queued(&c, "FEATURE_DISABLED", now)?;
                return Ok(());
            }
            let super::session::Core {
                executor, clock, ..
            } = &mut *core;
            if let Err(code) = executor.start(&c, &a, clock) {
                executor.refuse_queued(&c, &code, now)?;
                return Ok(());
            }
            if catalogue {
                let path = core.executor.db.path.clone();
                drop(core);
                drop(permit);
                spawn_catalogue(app, rt, c, path, None);
                return Ok(());
            }
            if phase_three {
                let path = core.executor.db.path.clone();
                drop(core);
                drop(permit);
                tokio::task::spawn_blocking(move || {
                    let result = (|| {
                        let conn =
                            rusqlite::Connection::open(path).map_err(|_| "INTERNAL_ERROR")?;
                        conn.busy_timeout(std::time::Duration::from_millis(100))
                            .map_err(|_| "INTERNAL_ERROR")?;
                        super::breakglass::run(&app, &rt, &conn, &c)
                    })();
                    if let Ok(mut core) = rt.core.lock() {
                        let now = core.now();
                        match result {
                            // Staging already wrote a pending result and the resume token.
                            // Startup alone can report whether the restore applied.
                            Ok(data) if data["restore"]["staged"] == true => {}
                            Ok(data) => {
                                let _ = super::breakglass::finish(
                                    &core.executor.db.conn,
                                    &c,
                                    data,
                                    now,
                                );
                            }
                            Err(code) => {
                                let _ = core.executor.fail(&c, &code, now);
                            }
                        }
                    }
                });
                return Ok(());
            }
            if phase_two {
                let context = core.approval_context();
                let path = core.executor.db.path.clone();
                drop(core);
                drop(permit);
                if c.kind == "till_apply_device_settings" {
                    let rt = rt.clone();
                    // Human waits and fresh admission must not stall transport.
                    tokio::task::spawn_blocking(move || {
                        let result = (|| {
                            let context = context?;
                            let conn =
                                rusqlite::Connection::open(path).map_err(|_| "INTERNAL_ERROR")?;
                            super::device_apply::run(&app, &conn, &c, &context)
                        })();
                        if let Ok(mut core) = rt.core.lock() {
                            let now = core.now();
                            match result {
                                Ok(data) => {
                                    let _ = core.executor.finish(&c, data, now);
                                }
                                Err(code) => {
                                    let _ = core.executor.fail(&c, &code, now);
                                }
                            }
                        }
                    });
                } else if let Err(code) = super::remedy_run::begin(&app, &c) {
                    let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR")?;
                    let now = core.now();
                    core.executor.fail(&c, &code, now)?;
                }
                return Ok(());
            }
            drop(core);
            // No runtime, support DB, gate or business DB mutex is held while
            // collector code runs. Every collector must honor the cancel flag.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handler.ok_or("FEATURE_DISABLED")?(&c, &permit)
            }))
            .unwrap_or_else(|_| Err("INTERNAL_ERROR".into()));
            let mut core = rt.core.lock().map_err(|_| "INTERNAL_ERROR".to_string())?;
            let now = core.now();
            if permit.is_cancelled() {
                let code = if core.session.is_none() {
                    "SESSION_ENDED"
                } else if core
                    .session
                    .as_ref()
                    .is_some_and(|s| s.admission.disabled_tools.contains(&c.kind))
                {
                    "FEATURE_DISABLED"
                } else {
                    "PREEMPTED_BY_CRITICAL_OPERATION"
                };
                core.executor.fail(&c, code, now)?;
            } else {
                match result {
                    Ok(data) => {
                        if let Err(code) = core.executor.finish(&c, data, now) {
                            core.executor.fail(&c, &code, now)?;
                        }
                    }
                    Err(code) => core.executor.fail(&c, &code, now)?,
                }
            }
            Ok(())
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_command_without_active_session_and_visible_banner() {
        for active in [false, true] {
            for ready in [false, true] {
                for visible in [false, true] {
                    assert_eq!(
                        visible_admission(active, ready, visible).is_ok(),
                        active && ready && visible
                    );
                }
            }
        }
    }
    /// A till with efood holds the efood Partner page as a second webview in
    /// the main window, and Tauri's single-webview lookups answer `None` for
    /// such a window. Support used one, read the till as hidden and ran no
    /// command at a store (12/11/2026). Nothing in the native app may find the
    /// POS window that way.
    #[test]
    fn nothing_finds_the_pos_window_through_a_single_webview_lookup() {
        fn walk(dir: &std::path::Path, needles: &[String], found: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).expect("source directory").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, needles, found);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    let source = std::fs::read_to_string(&path).expect("source file");
                    for (index, line) in source.lines().enumerate() {
                        if needles.iter().any(|needle| line.contains(needle.as_str())) {
                            found.push(format!("{}:{}", path.display(), index + 1));
                        }
                    }
                }
            }
        }
        // The two Tauri methods, as calls. Joined here so that this test does
        // not find itself.
        let needles = [
            [".get_webview", "_window("].concat(),
            [".webview", "_windows("].concat(),
        ];
        let mut found = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &needles,
            &mut found,
        );
        assert!(
            found.is_empty(),
            "single-webview window lookup at {found:?}"
        );
    }
    #[test]
    fn visible_window_without_presented_banner_never_starts_a_queued_command() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let root =
            std::env::temp_dir().join(format!("support-presentation-{}", uuid::Uuid::new_v4()));
        let mut core =
            super::super::session::Core::new(super::super::db::SupportDb::open(&root).unwrap())
                .unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-session.json"
        ))
        .unwrap();
        core.adopt(
            serde_json::from_value(fixture["response"]["session"].clone()).unwrap(),
            "2026-11-01T12:00:00.000Z",
        )
        .unwrap();
        core.executor
            .db
            .conn
            .execute("UPDATE support_session_state SET status='active'", [])
            .unwrap();
        let session = core.session.as_mut().unwrap();
        session.admission.active = true;
        session.admission.visible = true; // The OS window really is visible.
        session.admission.tiers_enabled.insert(1);
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/routes/pos-support-commands.json"
        ))
        .unwrap();
        let command: Command =
            serde_json::from_value(fixture["response"]["commands"][0].clone()).unwrap();
        let admission = session.admission.clone();
        assert!(core
            .executor
            .accept(&command, &admission, &core.clock)
            .unwrap());
        assert!(!admit_presented(&mut core, &command, false, true).unwrap());
        let started: Option<String> = core
            .executor
            .db
            .conn
            .query_row(
                "SELECT started_at FROM support_accepted_commands WHERE command_id=?1",
                [&command.command_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(started.is_none());
        assert!(admit_presented(&mut core, &command, true, true).unwrap());
        assert!(!admit_presented(&mut core, &command, false, true).unwrap());
        drop(core);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn registry_cannot_run_mutating_or_unknown_server_code() {
        let handler: TierOneHandler = Arc::new(|_, _| Ok(Value::Null));
        for kind in [
            "eval",
            "support_record_finding",
            "breakglass_propose_sql",
            "till_run_remedy",
        ] {
            assert!(register_tier_one(kind, handler.clone()).is_err());
        }
    }
}
