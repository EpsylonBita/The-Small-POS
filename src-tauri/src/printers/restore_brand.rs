//! Reviewed one-tap recovery for the 31 October unanswered brand probe.
use super::*;
use crate::support::catalogue::contract::ConfiguredPrinterRef;

use crate::support::{catalogue, critical_op, identity, replica};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::collections::HashSet;
use std::sync::OnceLock;

pub(crate) const RECIPE_ID: &str = "printer.restore_last_known_brand";
pub(crate) const RECIPE_VERSION: u32 = 1;
pub(crate) const COOLDOWN_MS: i64 = 300_000;
pub(crate) const ATTEMPT_CAP: u64 = 3;
const ISSUE_CODE: &str = "printer.brand_probe_unanswered";
const MAX_OBSERVATION_AGE_MS: i64 = 60_000;

fn locks() -> &'static Mutex<HashSet<String>> {
    static LOCKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}
struct PrinterLease(String);
impl Drop for PrinterLease {
    fn drop(&mut self) {
        locks()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}
fn claim_printer(key: String) -> Result<PrinterLease, String> {
    if !locks()
        .lock()
        .map_err(|_| "CONCURRENT_OPERATION")?
        .insert(key.clone())
    {
        return Err("CONCURRENT_OPERATION".into());
    }
    Ok(PrinterLease(key))
}

/// Local observations only: no network, keyring or printer-owner lock.
pub(crate) fn observations(conn: &Connection) -> Result<Value, String> {
    identity::local(conn)?;
    let collected = crate::support::collectors::printers::collect(conn)?;
    let mut eligible = Vec::new();
    for printer in collected["printers"]
        .as_array()
        .ok_or("REMEDY_NOT_APPLICABLE")?
    {
        if eligible_emulation(printer, Utc::now().timestamp_millis()).is_ok()
            && printer["configured_printer_ref"].is_object()
        {
            eligible.push(json!({"code":ISSUE_CODE,"printerId":printer["printer_id"],
                "configuredPrinterRef":printer["configured_printer_ref"],"observedAt":printer["last_probe"]["at"]}));
        }
    }
    Ok(Value::Array(eligible))
}
fn eligible_emulation(printer: &Value, now: i64) -> Result<&'static str, String> {
    let at = printer["last_probe"]["at"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|at| at.timestamp_millis())
        .ok_or("REMEDY_NOT_APPLICABLE")?;
    if printer["enabled"] != true
        || printer["resolved_brand"] != "unknown"
        || printer["configured_emulation"] != "auto"
        || printer["last_probe"]["result"] != "no_answer"
        || !(0..=MAX_OBSERVATION_AGE_MS).contains(&(now - at))
    {
        return Err("REMEDY_NOT_APPLICABLE".into());
    }
    match printer["last_known_brand"]
        .as_str()
        .and_then(PrinterBrand::from_label)
    {
        Some(PrinterBrand::Star) => Ok("star_line"),
        Some(PrinterBrand::Unknown) | None => Err("REMEDY_NOT_APPLICABLE".into()),
        Some(_) => Ok("escpos"),
    }
}
fn observed_printer(conn: &Connection, id: &str) -> Result<Value, String> {
    crate::support::collectors::printers::collect(conn)?["printers"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["printer_id"] == id))
        .cloned()
        .ok_or("REMEDY_NOT_APPLICABLE".into())
}
fn guard_key(scope: &crate::support::guards::Scope, id: &str) -> String {
    format!(
        "{RECIPE_ID}.v{RECIPE_VERSION}:{}",
        crate::support::contracts::payload_hash(&json!([
            scope.organization_id,
            scope.branch_id,
            scope.terminal_id,
            id
        ]))
    )
}
fn check_budget(conn: &Connection, key: &str, now: i64) -> Result<u64, String> {
    let Some(raw) = db::get_setting(conn, "recovery_recipe", key) else {
        return Ok(0);
    };
    let guard: Value = serde_json::from_str(&raw).map_err(|_| "REMEDY_ATTEMPT_CAP")?;
    let attempts = guard["attempts"].as_u64().ok_or("REMEDY_ATTEMPT_CAP")?;
    let at = guard["at"].as_i64().ok_or("REMEDY_ATTEMPT_CAP")?;
    if attempts >= ATTEMPT_CAP {
        return Err("REMEDY_ATTEMPT_CAP".into());
    }
    if now < at + COOLDOWN_MS {
        return Err("REMEDY_COOLDOWN".into());
    }
    Ok(attempts)
}
fn checkpoint(permit: &critical_op::SupportPermit) -> Result<(), String> {
    if permit.is_cancelled() {
        Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
    } else {
        Ok(())
    }
}

/// A private full SQLite snapshot, with no identity/credential fallback. Snapshot
/// files are never sent by telemetry. Admission holds no business writer.
fn take_snapshot(db: &DbState, permit: &critical_op::SupportPermit) -> Result<String, String> {
    crate::support::snapshot::disk_guard(&db.db_path)?;
    let folder = db
        .db_path
        .parent()
        .ok_or("SNAPSHOT_FAILED")?
        .join("recipe-snapshots")
        .join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).map_err(|_| "SNAPSHOT_FAILED")?;
    let path = folder.join("pos.db");
    let conn = replica::read_connection(
        &db.db_path,
        permit,
        Instant::now() + Duration::from_secs(30),
    )?;
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
        .map_err(|_| "SNAPSHOT_FAILED")?;
    checkpoint(permit)?;
    let copy = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "SNAPSHOT_FAILED")?;
    crate::support::snapshot::integrity(&copy)?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "SNAPSHOT_FAILED")?;
    if prune_snapshots(folder.parent().ok_or("SNAPSHOT_FAILED")?, &folder).is_err() {
        tracing::warn!("RECIPE_SNAPSHOT_PRUNE_FAILED");
    }
    Ok(path.to_string_lossy().to_string())
}

fn snapshot_directory(path: &std::path::Path) -> std::io::Result<bool> {
    let metadata = std::fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Ok(false);
        }
    }
    Ok(metadata.is_dir() && !metadata.file_type().is_symlink())
}

fn prune_snapshots(root: &std::path::Path, current: &std::path::Path) -> std::io::Result<()> {
    if !snapshot_directory(root)? {
        return Err(std::io::Error::other("RECIPE_SNAPSHOT_PRUNE_FAILED"));
    }
    let root = root.canonicalize()?;
    let current = current.canonicalize()?;
    if current.parent() != Some(root.as_path()) {
        return Err(std::io::Error::other("RECIPE_SNAPSHOT_PRUNE_FAILED"));
    }
    let mut folders = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .is_none_or(|name| Uuid::parse_str(name).is_err())
            || !snapshot_directory(&entry.path())?
        {
            continue;
        }
        let path = entry.path().canonicalize()?;
        if path.parent() != Some(root.as_path()) {
            return Err(std::io::Error::other("RECIPE_SNAPSHOT_PRUNE_FAILED"));
        }
        if path != current {
            folders.push((entry.metadata()?.modified()?, path));
        }
    }
    folders.sort_by(|a, b| b.cmp(a));
    // Always retain this verified snapshot, even if the clock moved backwards.
    for (_, path) in folders.into_iter().skip(2) {
        if !snapshot_directory(&path)? || path.canonicalize()?.parent() != Some(root.as_path()) {
            return Err(std::io::Error::other("RECIPE_SNAPSHOT_PRUNE_FAILED"));
        }
        std::fs::remove_dir_all(&path)?;
    }
    Ok(())
}
fn audit(
    conn: &Connection,
    id: &str,
    scope: &crate::support::guards::Scope,
    snapshot: &str,
    outcome: Option<&str>,
) -> Result<(), String> {
    let payload = json!({"recipeId":RECIPE_ID,"recipeVersion":RECIPE_VERSION,"organizationId":scope.organization_id,
        "branchId":scope.branch_id,"terminalId":scope.terminal_id,"outcome":outcome,"phase":if outcome.is_some(){"completed"}else{"intent"}});
    conn.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,recipe_id,recipe_version,entity_type,entity_id,snapshot_point_id,success,payload_json,created_at) VALUES(?1,'restoreLastKnownPrinterBrand',?2,?3,?4,'printer',?5,?6,?7,?8,?9)",
        params![Uuid::new_v4().to_string(),ISSUE_CODE,RECIPE_ID,RECIPE_VERSION,id,snapshot,i32::from(outcome == Some("resolved")),payload.to_string(),Utc::now().to_rfc3339()])
        .map_err(|_| "RECIPE_AUDIT_FAILED")?;
    Ok(())
}

pub(crate) fn restore_last_known_brand(
    db: &DbState,
    reference: &ConfiguredPrinterRef,
) -> Result<Value, String> {
    restore_with(db, reference, || Ok(()))
}
fn restore_with(
    db: &DbState,
    reference: &ConfiguredPrinterRef,
    before_effect: impl FnOnce() -> Result<(), String>,
) -> Result<Value, String> {
    let _lock = claim_printer(format!("{}:{}", db.db_path.display(), reference.id))?;
    let gate = critical_op::global();
    let started = Instant::now();
    let read_permit = gate.try_begin_support(false, None)?;
    let (scope, emulation) = {
        let conn = replica::read_connection(
            &db.db_path,
            &read_permit,
            Instant::now() + Duration::from_secs(5),
        )?;
        let scope = identity::local(&conn)?;
        catalogue::resolve_printer(&conn, &scope, reference)?;
        check_budget(
            &conn,
            &guard_key(&scope, &reference.id),
            Utc::now().timestamp_millis(),
        )?;
        (
            scope,
            eligible_emulation(
                &observed_printer(&conn, &reference.id)?,
                Utc::now().timestamp_millis(),
            )?,
        )
    };
    let snapshot = take_snapshot(db, &read_permit)?;
    checkpoint(&read_permit)?;
    drop(read_permit);
    if gate
        .activity_between(started, Instant::now())
        .is_none_or(|activity| !activity.is_empty())
    {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let conn = Connection::open(&db.db_path).map_err(|_| "REMEDY_NOT_APPLICABLE")?;
    conn.execute_batch("PRAGMA synchronous=FULL;")
        .map_err(|_| "REMEDY_NOT_APPLICABLE")?;
    let permit = gate.try_begin_support_write(std::sync::Arc::new(conn.get_interrupt_handle()))?;
    // Durable intent and budget precede the effect; a crash cannot reset the cap.
    {
        let tx = permit.begin_write(&conn)?;
        catalogue::resolve_printer(&tx, &scope, reference)?;
        let now = Utc::now().timestamp_millis();
        let key = guard_key(&scope, &reference.id);
        let attempts = check_budget(&tx, &key, now)?;
        audit(&tx, &reference.id, &scope, &snapshot, None)?;
        db::set_setting(
            &tx,
            "recovery_recipe",
            &key,
            &json!({"attempts":attempts+1,"at":now}).to_string(),
        )?;
        checkpoint(&permit)?;
        tx.commit().map_err(|_| "RECIPE_AUDIT_FAILED")?;
    }
    let effect = (|| -> Result<(), String> {
        before_effect()?;
        let tx = permit.begin_write(&conn)?;
        catalogue::resolve_printer(&tx, &scope, reference)?;
        if eligible_emulation(
            &observed_printer(&tx, &reference.id)?,
            Utc::now().timestamp_millis(),
        )? != emulation
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        let profile = support_get_printer_profile(&tx, &reference.id)?;
        let mut connection: Value =
            serde_json::from_str(profile["connectionJson"].as_str().ok_or("PAYLOAD_DRIFT")?)
                .map_err(|_| "PAYLOAD_DRIFT")?;
        connection["emulation"] = json!(emulation);
        // Printer owner applies only its own connection settings, inside the fenced transaction.
        update_printer_profile_on_connection(
            &tx,
            &json!({"id":reference.id,"connectionJson":connection}),
            CapabilityEvidenceTrust::Untrusted,
            false,
        )?;
        checkpoint(&permit)?;
        tx.commit()
            .map_err(|_| "PREEMPTED_BY_CRITICAL_OPERATION".into())
    })();
    drop(conn);
    drop(permit);
    // A new handle reads committed owner state; an acknowledgement is not healing.
    let fresh = Connection::open_with_flags(&db.db_path, OpenFlags::SQLITE_OPEN_READ_ONLY);
    let outcome = match fresh.as_ref().ok().and_then(|c| {
        if identity::local(c).ok().as_ref() != Some(&scope) {
            return None;
        }
        let profile = support_get_printer_profile(c, &reference.id).ok()?;
        let connection: Value = serde_json::from_str(profile["connectionJson"].as_str()?).ok()?;
        Some((
            profile["enabled"] == true,
            connection["emulation"] == emulation,
        ))
    }) {
        Some((true, true)) => "resolved",
        Some(_) if effect.is_err() => "failed",
        Some(_) => "pending",
        None => "unknown",
    };
    let conn = Connection::open(&db.db_path).map_err(|_| "RECIPE_AUDIT_FAILED")?;
    audit(&conn, &reference.id, &scope, &snapshot, Some(outcome))?;
    Ok(
        json!({"success":matches!(outcome,"resolved"|"pending"),"outcome":outcome,"requiresRefresh":true,
        "snapshotPointId":snapshot,"verification":{"status":match outcome {"resolved"=>"passed","failed"=>"failed","unknown"=>"unknown",_=>"pending"}}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_brand_snapshot_retains_newest_three_and_leaves_unrelated_folders() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let (db, _) = fixture();
        let root = db.state.db_path.parent().unwrap().join("recipe-snapshots");
        let unrelated = root.join("keep-this-folder");
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep.txt"), "keep").unwrap();
        let outside = db.state.db_path.parent().unwrap().join("keep-outside.txt");
        std::fs::write(&outside, "keep").unwrap();
        let mut old = Vec::new();
        for n in 1..=5 {
            let folder = root.join(format!("00000000-0000-4000-8000-{n:012}"));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("pos.db"), "old snapshot").unwrap();
            old.push((
                std::fs::metadata(&folder).unwrap().modified().unwrap(),
                folder,
            ));
        }
        old.sort();
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .unwrap();
        let snapshot = take_snapshot(&db.state, &permit).unwrap();
        assert!(std::path::Path::new(&snapshot).is_file());
        for (index, (_, folder)) in old.iter().enumerate() {
            assert_eq!(folder.exists(), index >= 3, "{}", folder.display());
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 4);
        assert_eq!(
            std::fs::read_to_string(unrelated.join("keep.txt")).unwrap(),
            "keep"
        );
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "keep");
    }

    fn fixture() -> (crate::tests::harness::TestDb, ConfiguredPrinterRef) {
        let db = crate::tests::harness::TestDb::open();
        let host = format!("your-host-{}", Uuid::new_v4());
        let id = "11111111-1111-4111-8111-111111111111";
        let reference = {
            let conn = db.state.conn.lock().unwrap();
            for (key, value) in [
                ("organization_id", "your-org"),
                ("branch_id", "your-branch"),
                ("terminal_id", "your-terminal"),
            ] {
                db::set_setting(&conn, "terminal", key, value).unwrap();
            }
            conn.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,printer_type,connection_json,created_at,updated_at) VALUES(?1,'Front printer',?2,'escpos','network',?3,'2026-10-31','2026-10-31')", params![id,host,json!({"ip":host,"emulation":"auto"}).to_string()]).unwrap();
            db::set_setting(
                &conn,
                "local",
                &format!("printer_last_known_brand:{host}"),
                "Star",
            )
            .unwrap();
            retain_support_probe(&host, PrinterBrand::Unknown);
            catalogue::configured_printer_ref(&conn, &identity::local(&conn).unwrap(), id).unwrap()
        };
        (db, reference)
    }

    #[test]
    fn recovery_brand_eligibility_is_exact_fresh_enabled_and_automatic() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let at = Utc::now().timestamp_millis();
        let valid = json!({"enabled":true,"resolved_brand":"unknown","configured_emulation":"auto",
            "last_known_brand":"Star","last_probe":{"result":"no_answer","at":crate::support::clock::iso(at)}});
        assert_eq!(eligible_emulation(&valid, at).unwrap(), "star_line");
        for brand in [
            "Epson", "Citizen", "Bixolon", "Custom", "Sewoo", "Rongta", "Xprinter",
        ] {
            let mut observation = valid.clone();
            observation["last_known_brand"] = json!(brand);
            assert_eq!(eligible_emulation(&observation, at).unwrap(), "escpos");
        }
        for (field, value) in [
            ("enabled", json!(false)),
            ("resolved_brand", json!("star")),
            ("configured_emulation", json!("escpos")),
            ("last_known_brand", json!("unrecognised")),
        ] {
            let mut observation = valid.clone();
            observation[field] = value;
            assert!(eligible_emulation(&observation, at).is_err());
        }
        for delta in [-1, 60_001] {
            assert!(eligible_emulation(&valid, at + delta).is_err());
        }
        let mut answered = valid.clone();
        answered["last_probe"]["result"] = json!("answered");
        assert!(eligible_emulation(&answered, at).is_err());
    }

    #[test]
    fn recovery_brand_refuses_drift_and_critical_operations_without_audit() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let (db, reference) = fixture();
        let critical = critical_op::global().begin_critical(critical_op::CriticalKind::Checkout);
        assert!(restore_last_known_brand(&db.state, &reference).is_err());
        drop(critical);
        db.state
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE printer_profiles SET name='Changed'", [])
            .unwrap();
        assert_eq!(
            restore_last_known_brand(&db.state, &reference).unwrap_err(),
            "PAYLOAD_DRIFT"
        );
        assert_eq!(
            db.state
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT count(*) FROM recovery_action_log", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn recovery_brand_intent_and_snapshot_precede_effect_and_budget_survives_restart() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let (db, reference) = fixture();
        let result = restore_with(&db.state, &reference, || {
            let conn = db.state.conn.lock().unwrap();
            let (snapshot, payload): (String, String) = conn
                .query_row(
                    "SELECT snapshot_point_id,payload_json FROM recovery_action_log",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&payload).unwrap()["phase"],
                "intent"
            );
            let copy =
                Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let before = support_get_printer_profile(&copy, &reference.id).unwrap();
            assert!(!profile_uses_star_line_mode(&before));
            assert!(!profile_uses_star_line_mode(
                &support_get_printer_profile(&conn, &reference.id).unwrap()
            ));
            Err("SIMULATED_OWNER_FAILURE".into())
        })
        .unwrap();
        assert_eq!(result["outcome"], "failed");
        let db = db.restart();
        assert_eq!(
            restore_last_known_brand(&db.state, &reference).unwrap_err(),
            "REMEDY_COOLDOWN"
        );
        let conn = db.state.conn.lock().unwrap();
        let key = guard_key(&identity::local(&conn).unwrap(), &reference.id);
        db::set_setting(
            &conn,
            "recovery_recipe",
            &key,
            &json!({"attempts":3,"at":0}).to_string(),
        )
        .unwrap();
        assert_eq!(
            check_budget(&conn, &key, Utc::now().timestamp_millis()).unwrap_err(),
            "REMEDY_ATTEMPT_CAP"
        );
    }

    #[test]
    fn recovery_brand_printer_lock_and_preemption_prevent_the_effect() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let (db, reference) = fixture();
        let lock =
            claim_printer(format!("{}:{}", db.state.db_path.display(), reference.id)).unwrap();
        assert_eq!(
            restore_last_known_brand(&db.state, &reference).unwrap_err(),
            "CONCURRENT_OPERATION"
        );
        drop(lock);
        let result = restore_with(&db.state, &reference, || {
            let _critical = critical_op::global().begin_critical(critical_op::CriticalKind::Card);
            Ok(())
        })
        .unwrap();
        assert_eq!(result["outcome"], "failed");
        assert!(!profile_uses_star_line_mode(
            &get_printer_profile(&db.state, &reference.id).unwrap()
        ));
    }

    #[test]
    fn recovery_unanswered_probe_restores_saved_star_without_keyring() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let db = crate::tests::harness::TestDb::open();
        let host = format!("your-host-{}", uuid::Uuid::new_v4());
        let id = "11111111-1111-4111-8111-111111111111";
        let reference = {
            let conn = db.state.conn.lock().unwrap();
            for (key, value) in [
                ("organization_id", "your-org"),
                ("branch_id", "your-branch"),
                ("terminal_id", "your-terminal"),
            ] {
                crate::db::set_setting(&conn, "terminal", key, value).unwrap();
            }
            conn.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,printer_type,connection_json,created_at,updated_at) VALUES(?1,'Front printer',?2,'escpos','network',?3,'2026-10-31','2026-10-31')", rusqlite::params![id,host,json!({"ip":host,"emulation":"auto"}).to_string()]).unwrap();
            crate::db::set_setting(
                &conn,
                "local",
                &format!("printer_last_known_brand:{host}"),
                "Star",
            )
            .unwrap();
            retain_support_probe(&host, PrinterBrand::Unknown);
            let observed = crate::support::collectors::printers::collect(&conn).unwrap();
            assert_eq!(observed["printers"][0]["resolved_brand"], "unknown");
            assert_eq!(observed["printers"][0]["last_probe"]["result"], "no_answer");
            let scope = crate::support::identity::local(&conn).unwrap();
            crate::support::catalogue::configured_printer_ref(&conn, &scope, id).unwrap()
        };
        crate::tests::fake_keyring::before_each_read(|key| panic!("recipe read keyring: {key}"));
        let result =
            restore_last_known_brand(&db.state, &reference).expect("reviewed one-tap remedy");
        assert_eq!(result["outcome"], "resolved");
        let profile = get_printer_profile(&db.state, id).unwrap();
        assert!(profile_uses_star_line_mode(&profile));
    }
}
