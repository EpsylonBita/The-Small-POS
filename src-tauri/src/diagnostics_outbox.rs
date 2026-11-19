//! The ZIP and delivery journal live outside the business database. The
//! worker never owns the business mutex, a SQLite business write, or a support
//! permit while it sends a report.
use crate::{api, db, incident_reporting, support};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Emitter;

const ZIP_PREFIX: &str = "thesmall-pos-diagnostics-";
const MAX_ZIP_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTEMPTS: i64 = 8;
const UNCONFIRMED: &str = "INCIDENT_DELIVERY_UNVERIFIED";

type Endpoint = (String, zeroize::Zeroizing<String>);

struct Report {
    name: String,
    sha256: String,
    body: String,
    attempt: i64,
}

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn sha256(bytes: &[u8]) -> String {
    crate::core_helpers::lower_hex(&Sha256::digest(bytes))
}

fn report_file_name(path: &Path) -> Option<&str> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with(ZIP_PREFIX) && name.ends_with(".zip"))
}

fn archive(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS reports (
             name TEXT PRIMARY KEY,
             scope TEXT NOT NULL,
             sha256 TEXT NOT NULL,
             created_at TEXT NOT NULL,
             body TEXT NOT NULL,
             state TEXT NOT NULL DEFAULT 'waiting'
                 CHECK(state IN ('waiting','sending','sent','failed')),
             attempt INTEGER NOT NULL DEFAULT 0,
             next_at INTEGER NOT NULL DEFAULT 0,
             error TEXT,
             receipt TEXT,
             sent_at TEXT
         );",
    )
}

fn open_archive(root: &Path) -> Result<Connection, String> {
    let conn = Connection::open(root.join("diagnostics-outbox.db")).map_err(|e| e.to_string())?;
    archive(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn read_scope(conn: &Connection) -> Result<(String, String), String> {
    let scope = support::identity::local(conn).map_err(|_| "INCIDENT_REPORT_SCOPE_UNAVAILABLE")?;
    let key = json!([scope.organization_id, scope.branch_id, scope.terminal_id]);
    Ok((key.to_string(), scope.terminal_id))
}

fn read_upload_bytes(path: &Path) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "INCIDENT_ZIP_UNAVAILABLE")?;
    if !metadata.is_file() {
        return Err("INCIDENT_ZIP_UNAVAILABLE");
    }
    if metadata.len() > MAX_ZIP_BYTES as u64 {
        return Err("INCIDENT_ZIP_TOO_LARGE");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_ZIP_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| "INCIDENT_ZIP_UNAVAILABLE")?;
    if bytes.len() > MAX_ZIP_BYTES {
        return Err("INCIDENT_ZIP_TOO_LARGE");
    }
    Ok(bytes)
}

pub(crate) fn save_report(
    db: &db::DbState,
    root: &Path,
    health_view: Option<Value>,
) -> Result<Value, String> {
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    let binding = crate::order_notice_recovery::observer_connection(&db.db_path, false)
        .and_then(|observer| read_scope(&observer));
    let created_at = Utc::now();
    let zip_path = crate::diagnostics::export_diagnostics_bundle(
        db,
        root,
        crate::diagnostics::DiagnosticsExportOptions::default(),
        health_view,
    )?;
    let path = Path::new(&zip_path);
    let name = report_file_name(path).ok_or("INCIDENT_ZIP_UNAVAILABLE")?;
    let at = timestamp(created_at);
    // Flush the exact ZIP before committing its outbox row. An interruption
    // before that commit leaves an ordinary local copy, visible in the archive.
    let bytes = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .and_then(|_| fs::read(path));
    let journal = bytes.map_err(|e| e.to_string()).and_then(|bytes| {
        let Ok((scope, terminal)) = binding else {
            return Ok(Some("INCIDENT_REPORT_SCOPE_UNAVAILABLE"));
        };
        let health = json!({"terminalContext": {"terminalId": terminal}});
        let mut candidate = incident_reporting::manual_incident_candidate(&health);
        candidate.fingerprint = format!(
            "{terminal}:manual.diagnostics_sent:{}",
            uuid::Uuid::new_v4()
        );
        let body = incident_reporting::incident_body(&candidate, &health, created_at);
        let refused = (bytes.len() > MAX_ZIP_BYTES).then_some("INCIDENT_ZIP_TOO_LARGE");
        open_archive(root)?
            .execute(
                "INSERT INTO reports(name,scope,sha256,created_at,body,state,error)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    name,
                    scope,
                    sha256(&bytes),
                    at,
                    body.to_string(),
                    if refused.is_some() {
                        "failed"
                    } else {
                        "waiting"
                    },
                    refused
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(refused)
    });
    let reason = journal.unwrap_or_else(|error| {
        tracing::warn!(%error, "Could not queue the saved diagnostics ZIP");
        Some("INCIDENT_OUTBOX_WRITE_FAILED")
    });
    Ok(json!({
        "success": false, "localPrepared": true, "path": zip_path, "createdAt": at, "reportId": name,
        "deliveryState": if reason.is_some() { "failed" } else { "waiting" },
        "error": reason,
    }))
}

fn recover_interrupted(conn: &Connection) -> rusqlite::Result<usize> {
    // No receipt lookup/idempotency contract exists on the terminal route.
    // A prior POST may have reached storage, even if the till never got a reply.
    conn.execute(
        "UPDATE reports SET state='failed',error=?1 WHERE state='sending'",
        [UNCONFIRMED],
    )
}

fn oldest_due(conn: &Connection, scope: &str, now: i64) -> rusqlite::Result<Option<Report>> {
    conn.query_row(
        "SELECT name,sha256,body,attempt FROM reports
         WHERE scope=?1 AND state='waiting' AND next_at<=?2 ORDER BY created_at,name LIMIT 1",
        params![scope, now],
        |row| {
            Ok(Report {
                name: row.get(0)?,
                sha256: row.get(1)?,
                body: row.get(2)?,
                attempt: row.get(3)?,
            })
        },
    )
    .optional()
}

fn fail(conn: &Connection, name: &str, cause: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE reports SET state='failed',error=?2 WHERE name=?1",
        params![name, cause],
    )
}

fn claim(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.execute(
        "UPDATE reports SET state='sending',attempt=attempt+1 WHERE name=?1 AND state='waiting'",
        [name],
    )
    .map(|updated| updated == 1)
}

fn finish(
    conn: &Connection,
    report: &Report,
    response: Result<Value, api::AdminFetchError>,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    match response {
        Ok(receipt) if incident_reporting::verified_bundle_receipt(&receipt, &report.sha256) => {
            let receipt = json!({
                "bundleStored": true, "bundleSha256": report.sha256,
                "incidentId": receipt["incidentId"],
                "alertSent": receipt["alertSent"], "alertStatus": receipt["alertStatus"],
            });
            conn.execute(
                "UPDATE reports SET state='sent',receipt=?2,sent_at=?3,error=NULL WHERE name=?1",
                params![report.name, receipt.to_string(), timestamp(now)],
            )?;
        }
        Ok(receipt)
            if receipt["bundleSha256"]
                .as_str()
                .is_some_and(|hash| hash != report.sha256) =>
        {
            fail(conn, &report.name, "INCIDENT_RECEIPT_HASH_MISMATCH")?;
        }
        Err(error) if error.is_connect_failure() || error.status() == Some(429) => {
            if report.attempt + 1 >= MAX_ATTEMPTS {
                fail(conn, &report.name, "INCIDENT_DELIVERY_ATTEMPTS_EXHAUSTED")?;
            } else {
                let delay = (15 * 2_i64.pow(report.attempt as u32))
                    .max(error.retry_after_seconds().unwrap_or_default());
                conn.execute(
                    "UPDATE reports SET state='waiting',next_at=?2,error=NULL WHERE name=?1",
                    params![report.name, now.timestamp().saturating_add(delay)],
                )?;
            }
        }
        Err(error) if matches!(error.status(), Some(400..=499)) && error.status() != Some(408) => {
            fail(
                conn,
                &report.name,
                &format!("INCIDENT_SERVER_REFUSED_HTTP_{}", error.status().unwrap()),
            )?;
        }
        _ => {
            fail(conn, &report.name, UNCONFIRMED)?;
        }
    }
    Ok(())
}

async fn drain_one<F, Fut>(
    conn: &Connection,
    root: &Path,
    scope: &str,
    gate: &support::critical_op::CriticalOpGate,
    online: bool,
    send: F,
) -> Result<bool, String>
where
    F: FnOnce(Value, String, Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<Value, api::AdminFetchError>>,
{
    if !online || gate.active() {
        return Ok(false);
    }
    let result = |error: rusqlite::Error| error.to_string();
    let Some(report) = oldest_due(conn, scope, Utc::now().timestamp()).map_err(result)? else {
        return Ok(false);
    };
    let path = root.join(&report.name);
    let parsed = serde_json::from_str(&report.body);
    let checked = if report_file_name(Path::new(&report.name)) != Some(report.name.as_str()) {
        Err("INCIDENT_ZIP_UNAVAILABLE")
    } else {
        read_upload_bytes(&path).and_then(|bytes| {
            if sha256(&bytes) == report.sha256 {
                Ok(bytes)
            } else {
                Err("INCIDENT_ZIP_HASH_MISMATCH")
            }
        })
    };
    let (body, bytes) = match (parsed, checked) {
        (Ok(body), Ok(bytes)) => (body, bytes),
        (_, Err(cause)) => {
            fail(conn, &report.name, cause).map_err(result)?;
            return Ok(true);
        }
        _ => {
            fail(conn, &report.name, "INCIDENT_OUTBOX_RECORD_INVALID").map_err(result)?;
            return Ok(true);
        }
    };
    if gate.active() || !claim(conn, &report.name).map_err(result)? {
        return Ok(false);
    }
    if gate.active() {
        conn.execute(
            "UPDATE reports SET state='waiting',attempt=attempt-1 WHERE name=?1 AND state='sending'",
            [&report.name],
        ).map_err(result)?;
        return Ok(false);
    }
    // This HTTP request owns no operation gate. Once sent, allow its receipt
    // to arrive while a sale runs and check critical activity before the next.
    let reply = send(body, report.name.clone(), bytes).await;
    finish(conn, &report, reply, Utc::now()).map_err(result)?;
    Ok(true)
}

fn observed_endpoint(db_path: &Path) -> Result<(String, Endpoint), String> {
    let read = crate::order_notice_recovery::observer_connection(db_path, false)?;
    let (scope, terminal) = read_scope(&read)?;
    if crate::storage::get_credential_strict("terminal_id")
        .ok()
        .flatten()
        .as_deref()
        .map(|value| value.as_str())
        != Some(terminal.as_str())
    {
        return Err("INCIDENT_REPORT_SCOPE_UNAVAILABLE".into());
    }
    let isolated = db::DbState {
        conn: std::sync::Mutex::new(read),
        db_path: db_path.to_path_buf(),
    };
    let endpoint = tauri::async_runtime::block_on(crate::resolve_admin_endpoint(Some(&isolated)))
        .map_err(|error| error.to_string())?;
    Ok((scope, endpoint))
}

pub(crate) fn start(
    app: tauri::AppHandle,
    root: PathBuf,
    db_path: PathBuf,
    cancel: tokio_util::sync::CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        let mut started = false;
        while !cancel.is_cancelled() {
            let worker_root = root.clone();
            let db_path = db_path.clone();
            let gate = support::critical_op::global();
            let status = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
                if (started && (!crate::order_notice_recovery::online() || gate.active()))
                    || !worker_root.join("diagnostics-outbox.db").is_file()
                {
                    return Ok(false);
                }
                let _binding = crate::repairs::acquire_terminal_binding_lease()?;
                // An overlapping process cannot mistake a live POST for a
                // crashed attempt. Checkout never takes this file lock.
                let worker_lock = fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(worker_root.join("diagnostics-outbox.lock"))
                    .map_err(|e| e.to_string())?;
                if worker_lock.try_lock().is_err() {
                    return Ok(false);
                }
                let conn = open_archive(&worker_root)?;
                let interrupted = recover_interrupted(&conn).map_err(|e| e.to_string())?;
                if !crate::order_notice_recovery::online() || gate.active() {
                    return Ok(interrupted > 0);
                }
                let pending: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM reports WHERE state='waiting' AND next_at<=?1)",
                    [Utc::now().timestamp()],
                    |row| row.get(0),
                ).map_err(|e| e.to_string())?;
                if !pending {
                    return Ok(interrupted > 0);
                }
                let (scope, endpoint) = observed_endpoint(&db_path)?;
                let changed = tauri::async_runtime::block_on(drain_one(
                    &conn,
                    &worker_root,
                    &scope,
                    &gate,
                    crate::order_notice_recovery::online(),
                    |body, name, bytes| async move {
                        incident_reporting::post_bundle_report(&endpoint, body, &name, &bytes).await
                    },
                ))?;
                Ok(changed || interrupted > 0)
            })
            .await;
            match status {
                Ok(Ok(changed)) => {
                    started = true;
                    if changed {
                        let _ = app.emit("diagnostics_reports_changed", json!({}));
                    }
                }
                Ok(Err(error)) => tracing::debug!(%error, "Diagnostics outbox will check again"),
                Err(error) => tracing::warn!(%error, "Diagnostics outbox worker interrupted"),
            }
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
            }
        }
    });
}

pub(crate) fn list_reports(root: &Path, db_path: &Path) -> Result<Value, String> {
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    let db = crate::order_notice_recovery::observer_connection(db_path, false)?;
    let (scope, _) = read_scope(&db)?;
    list_archived_reports(root, &scope, &db)
}

fn list_archived_reports(root: &Path, scope: &str, business: &Connection) -> Result<Value, String> {
    let mut copies = Vec::new();
    let mut catalogued = std::collections::BTreeSet::new();
    if root.join("diagnostics-outbox.db").is_file() {
        let conn = open_archive(root)?;
        let mut statement = conn
            .prepare("SELECT name,scope,sha256,created_at,state,error,receipt,sent_at FROM reports")
            .map_err(|e| e.to_string())?;
        let mut rows = statement.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let read = |index| row.get::<_, String>(index).map_err(|e| e.to_string());
            let opt = |index| {
                row.get::<_, Option<String>>(index)
                    .map_err(|e| e.to_string())
            };
            let name = read(0)?;
            catalogued.insert(name.clone());
            if read(1)? != scope || report_file_name(Path::new(&name)) != Some(name.as_str()) {
                continue;
            }
            let path = root.join(&name);
            let exists = fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file());
            let hash = read(2)?;
            let state = read(4)?;
            let receipt: Value = opt(6)?
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or(Value::Null);
            let sent_at = opt(7)?;
            let sent = state == "sent"
                && sent_at.is_some()
                && incident_reporting::verified_bundle_receipt(&receipt, &hash);
            copies.push(json!({
                "success": sent, "localPrepared": exists, "path": exists.then_some(path),
                "reportId": name, "createdAt": read(3)?, "lastSentAt": sent_at, "bundleStored": sent,
                "deliveryState": if sent { "sent" } else if matches!(state.as_str(), "sending" | "waiting") { "waiting" } else { "failed" },
                "error": opt(5)?, "incidentId": receipt["incidentId"],
                "alertStatus": receipt["alertStatus"], "alertSent": receipt["alertSent"],
            }));
        }
    }

    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let Some(name) = report_file_name(&path) else {
            continue;
        };
        if catalogued.contains(name) || !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let at = entry
            .metadata()
            .and_then(|info| info.modified())
            .map_err(|e| e.to_string())?;
        copies.push(json!({
            "reportId": name, "success": false, "localPrepared": true, "path": path,
            "createdAt": timestamp(at.into()), "deliveryState": "local", "historical": true,
        }));
    }

    // Older automatic incident records retained a time and incident ID, but
    // no verified ZIP hash or path. They cannot prove delivery of a saved copy.
    let mut statement = business
        .prepare(
            "SELECT setting_key,setting_value FROM local_settings
         WHERE setting_category='diagnostics' AND setting_key GLOB 'incident_last_status.*'",
        )
        .map_err(|e| e.to_string())?;
    let mut records = statement.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = records.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let raw: String = row.get(1).map_err(|e| e.to_string())?;
        let Ok(record) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(at) = record["sentAt"]
            .as_str()
            .or_else(|| record["failedAt"].as_str())
        {
            copies.push(json!({
                "reportId": id, "success": false, "createdAt": at,
                "deliveryState": "local", "historical": true,
            }));
        }
    }
    copies.sort_by(|left, right| right["createdAt"].as_str().cmp(&left["createdAt"].as_str()));
    Ok(json!(copies))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const SCOPE: &str = "paired till";
    const ZIP: &[u8] = b"PK\x03\x04 exact saved diagnostics";
    const FIRST: &str = "thesmall-pos-diagnostics-first.zip";
    const SECOND: &str = "thesmall-pos-diagnostics-second.zip";

    fn fixture() -> (crate::tests::harness::TempDir, Connection) {
        let dir = crate::tests::harness::TempDir::new();
        let conn = open_archive(dir.path()).unwrap();
        (dir, conn)
    }

    fn queue(conn: &Connection, root: &Path, name: &str, age: i64) {
        fs::write(root.join(name), ZIP).unwrap();
        let at = timestamp(Utc::now() - chrono::Duration::seconds(age));
        conn.execute(
            "INSERT INTO reports(name,scope,sha256,created_at,body) VALUES (?1,?2,?3,?4,'{}')",
            params![name, SCOPE, sha256(ZIP), at],
        )
        .unwrap();
    }

    fn state(conn: &Connection, name: &str) -> (String, Option<String>) {
        conn.query_row(
            "SELECT state,error FROM reports WHERE name=?1",
            [name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    fn receipt(bytes: &[u8]) -> Value {
        json!({"bundleStored": true, "bundleSha256": sha256(bytes), "incidentId": "incident-1"})
    }

    #[tokio::test]
    async fn diagnostics_reports_drain_on_reconnect_and_startup_in_creation_order() {
        let (root, conn) = fixture();
        let gate = support::critical_op::CriticalOpGate::new();
        queue(&conn, root.path(), SECOND, 1);
        queue(&conn, root.path(), FIRST, 10);
        assert!(
            !drain_one(&conn, root.path(), SCOPE, &gate, false, |_, _, _| async {
                panic!("offline ZIP must stay on the till")
            })
            .await
            .unwrap()
        );
        assert_eq!(state(&conn, FIRST), ("waiting".into(), None));
        drop(conn);
        let conn = open_archive(root.path()).unwrap();
        assert_eq!(recover_interrupted(&conn).unwrap(), 0);
        for expected in [FIRST, SECOND] {
            assert!(drain_one(
                &conn,
                root.path(),
                SCOPE,
                &gate,
                true,
                |_, name, bytes| async move {
                    assert_eq!(name, expected);
                    assert_eq!(bytes, ZIP);
                    Ok(receipt(&bytes))
                }
            )
            .await
            .unwrap());
            assert_eq!(state(&conn, expected), ("sent".into(), None));
            assert_eq!(fs::read(root.path().join(expected)).unwrap(), ZIP);
        }
        assert!(
            !drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, _| async {
                panic!("no report should be sent twice")
            })
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    async fn diagnostics_lost_receipt_is_never_reposted_or_guessed_on_startup() {
        let (root, conn) = fixture();
        let gate = support::critical_op::CriticalOpGate::new();
        queue(&conn, root.path(), FIRST, 0);
        let simulated_uploads = Cell::new(0);
        let interrupted = async {
            drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, bytes| {
                assert_eq!(bytes, ZIP);
                simulated_uploads.set(simulated_uploads.get() + 1);
                std::future::pending()
            })
            .await
        };
        tokio::pin!(interrupted);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut interrupted)
                .await
                .is_err()
        );
        assert_eq!(state(&conn, FIRST).0, "sending");
        let restarted = open_archive(root.path()).unwrap();
        assert_eq!(recover_interrupted(&restarted).unwrap(), 1);
        assert_eq!(
            state(&restarted, FIRST),
            ("failed".into(), Some(UNCONFIRMED.into()))
        );
        assert!(!drain_one(
            &restarted,
            root.path(),
            SCOPE,
            &gate,
            true,
            |_, _, _| async { panic!("receipt loss cannot cause a second POST") }
        )
        .await
        .unwrap());
        assert_eq!(simulated_uploads.get(), 1);
    }

    #[tokio::test]
    async fn diagnostics_wrong_file_hash_and_wrong_receipt_hash_never_mark_sent() {
        let (root, conn) = fixture();
        let gate = support::critical_op::CriticalOpGate::new();
        queue(&conn, root.path(), FIRST, 3);
        queue(&conn, root.path(), SECOND, 0);
        fs::write(root.path().join(FIRST), b"different bytes").unwrap();
        assert!(
            drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, _| async {
                panic!("changed ZIP must not leave the till")
            })
            .await
            .unwrap()
        );
        assert_eq!(
            state(&conn, FIRST).1.as_deref(),
            Some("INCIDENT_ZIP_HASH_MISMATCH")
        );
        assert!(
            drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, _| async {
                Ok(receipt(b"some other ZIP"))
            })
            .await
            .unwrap()
        );
        assert_eq!(
            state(&conn, SECOND),
            (
                "failed".into(),
                Some("INCIDENT_RECEIPT_HASH_MISMATCH".into())
            )
        );
    }

    #[tokio::test]
    async fn diagnostics_refusal_keeps_copy_and_safe_failures_back_off_with_a_cap() {
        let (root, conn) = fixture();
        let gate = support::critical_op::CriticalOpGate::new();
        queue(&conn, root.path(), FIRST, 3);
        queue(&conn, root.path(), SECOND, 0);
        drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, _| async {
            Err(api::AdminFetchError::with_status("refused", 403))
        })
        .await
        .unwrap();
        assert_eq!(
            state(&conn, FIRST).1.as_deref(),
            Some("INCIDENT_SERVER_REFUSED_HTTP_403")
        );
        assert!(root.path().join(FIRST).is_file());
        for attempt in 1..=MAX_ATTEMPTS {
            assert!(
                drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, _| async {
                    Err(api::AdminFetchError::connect_failed_for_test(
                        "failed before sending",
                    ))
                })
                .await
                .unwrap()
            );
            assert!(
                !drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, _| async {
                    panic!("backoff or attempt cap must prevent an immediate retry")
                })
                .await
                .unwrap(),
                "attempt {attempt}"
            );
            conn.execute("UPDATE reports SET next_at=0 WHERE name=?1", [SECOND])
                .unwrap();
        }
        assert_eq!(
            state(&conn, SECOND).1.as_deref(),
            Some("INCIDENT_DELIVERY_ATTEMPTS_EXHAUSTED")
        );
    }

    #[tokio::test]
    async fn diagnostics_critical_work_never_waits_for_the_drain() {
        let (root, conn) = fixture();
        let gate = support::critical_op::CriticalOpGate::new();
        queue(&conn, root.path(), FIRST, 0);
        for kind in [
            support::critical_op::CriticalKind::Checkout,
            support::critical_op::CriticalKind::Card,
            support::critical_op::CriticalKind::ShiftClose,
            support::critical_op::CriticalKind::ZClose,
        ] {
            let token = gate.begin_critical(kind);
            assert!(
                !drain_one(&conn, root.path(), SCOPE, &gate, true, |_, _, _| async {
                    panic!("critical work goes first")
                })
                .await
                .unwrap()
            );
            drop(token);
        }
        let sale_gate = &gate;
        drain_one(
            &conn,
            root.path(),
            SCOPE,
            &gate,
            true,
            |_, _, bytes| async move {
                let _sale = sale_gate
                    .try_begin_critical(support::critical_op::CriticalKind::Checkout)
                    .unwrap();
                Ok(receipt(&bytes))
            },
        )
        .await
        .unwrap();
        assert_eq!(state(&conn, FIRST).0, "sent");
    }

    #[test]
    fn diagnostics_archive_includes_legacy_copies_and_requires_matching_saved_receipts() {
        let (root, conn) = fixture();
        queue(&conn, root.path(), FIRST, 100);
        let report = oldest_due(&conn, SCOPE, i64::MAX).unwrap().unwrap();
        claim(&conn, FIRST).unwrap();
        finish(&conn, &report, Ok(receipt(ZIP)), Utc::now()).unwrap();
        fs::write(root.path().join(SECOND), ZIP).unwrap();
        let business = Connection::open_in_memory().unwrap();
        business.execute_batch(
            "CREATE TABLE local_settings (setting_key TEXT, setting_value TEXT, setting_category TEXT);
             INSERT INTO local_settings VALUES ('incident_last_status.abc',
                 '{\"sentAt\":\"2020-01-01T00:00:00.000Z\",\"incidentId\":\"older-incident\"}',
                 'diagnostics');",
        ).unwrap();
        let copies = list_archived_reports(root.path(), SCOPE, &business).unwrap();
        assert_eq!(copies[0]["reportId"], SECOND);
        assert_eq!(copies[0]["deliveryState"], "local");
        assert_eq!(copies[1]["reportId"], FIRST);
        assert_eq!(copies[1]["deliveryState"], "sent");
        assert_eq!(copies[2]["deliveryState"], "local");
        assert!(copies[2]["path"].is_null());
        conn.execute("UPDATE reports SET receipt='{}' WHERE name=?1", [FIRST])
            .unwrap();
        let copies = list_archived_reports(root.path(), SCOPE, &business).unwrap();
        assert_eq!(copies[1]["success"], false);
    }
}
