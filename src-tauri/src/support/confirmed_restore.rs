//! The existing staged snapshot owner retains its schema/loss/watermark guards.
use super::{clock, contracts::Command, guards, session::Runtime, snapshot};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;

pub fn data(
    store: &Connection,
    c: &Command,
    pre: &str,
    state: &str,
    outcome: &str,
    matches: bool,
) -> Result<Value, String> {
    let (target,count):(String,u64)=store.query_row("SELECT target_snapshot_id,changed_rows FROM support_confirmed_restores WHERE command_id=?",[&c.command_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(guards::error)?;
    Ok(
        json!({"step":"action","kind":"untrusted_till_data","outcome":outcome,"observation_time":clock::iso(chrono::Utc::now().timestamp_millis()),"snapshot_id":pre,"snapshot":snapshot::metadata(store,pre)?,"affected_ids":[target],"changed_rows":count,"verification":{"fresh":true,"matches_expected":matches,"sync":"not_applicable"},"evidence":{"kind":"restore","target_snapshot_id":target,"state":state},"undo":{"kind":"unavailable","reference":null,"reason":"Restore eligibility must be checked again against current sales"}}),
    )
}
pub fn run(
    app: &tauri::AppHandle,
    rt: &Runtime,
    store: &Connection,
    live: &Path,
    c: &Command,
) -> Result<Value, String> {
    super::confirmed::current(app, rt, c)?;
    let id = c.payload["action"]["inputs"]["snapshot_id"]
        .as_str()
        .ok_or("INVALID_INPUT")?;
    let conn = Connection::open_with_flags(live, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(guards::error)?;
    let report = super::restore::list(store, &conn)?;
    let item = report
        .as_array()
        .and_then(|a| a.iter().find(|v| v["snapshot_id"] == id))
        .ok_or("POLICY_REFUSED")?;
    if item["restorable"] != true {
        return Err("POLICY_REFUSED".into());
    }
    let count = item["changed_since"]
        .as_array()
        .ok_or("POLICY_REFUSED")?
        .iter()
        .try_fold(0u64, |n, r| {
            n.checked_add(r["count"].as_u64().ok_or("POLICY_REFUSED")?)
                .ok_or("POLICY_REFUSED")
        })?;
    if count > c.payload["rows_cap"].as_u64().ok_or("INVALID_INPUT")? {
        return Err("POLICY_REFUSED".into());
    }
    store
        .execute(
            "INSERT INTO support_confirmed_restores VALUES(?,?,?)",
            params![c.command_id, id, count],
        )
        .map_err(guards::error)?;
    drop(conn);
    super::restore::native_restore(app, store, live, id, &c.session_id, Some(&c.command_id))?;
    let pre = snapshot::newest(store)?.ok_or("SNAPSHOT_FAILED")?;
    data(store, c, &pre, "staged_restart", "pending", true)
}
pub fn complete(
    store: &Connection,
    app_data: &Path,
    c: &Command,
    applied: bool,
) -> Result<(), String> {
    let target = c.payload["action"]["inputs"]["snapshot_id"]
        .as_str()
        .ok_or("INVALID_INPUT")?;
    let target = snapshot::load(store, target)?;
    let matches = applied
        && (|| {
            let conn = Connection::open_with_flags(
                app_data.join("pos.db"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(guards::error)?;
            Ok::<_, String>(snapshot::watermarks(&conn)?.0 == target.full)
        })()
        .unwrap_or(false);
    let pre = snapshot::newest(store)?.ok_or("SNAPSHOT_FAILED")?;
    let data = data(
        store,
        c,
        &pre,
        if applied { "restored" } else { "refused" },
        if matches { "resolved" } else { "unknown" },
        matches,
    )?;
    super::breakglass::finish(store, c, data, chrono::Utc::now().timestamp_millis())?;
    if matches {
        super::confirmed::event(
            store,
            c,
            "confirmed_command_undone",
            chrono::Utc::now().timestamp_millis(),
        )?;
    }
    Ok(())
}
