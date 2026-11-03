//! Private snapshots; only counts/digests leave this module's metadata boundary.
use super::{clock, contracts, critical_op::SupportPermit, guards, replica};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub session: String,
    pub approval: Option<String>,
    pub at: String,
    pub folder: PathBuf,
    pub version: String,
    pub versions: Value,
    pub size: u64,
    pub hash: String,
    pub full: Value,
    pub cheap: Value,
    pub reason: String,
    pub files: std::collections::BTreeMap<String, String>,
    pub schema_sha256: String,
}
#[cfg(test)]
impl Snapshot {
    pub fn metadata(&self) -> Value {
        json!({"local_snapshot_id":self.id,"taken_at":self.at,"app_version":self.version,"schema_versions":self.versions,"size_bytes":self.size,"integrity_hash":self.hash,"financial_watermark":{"main":self.full}})
    }
}
pub fn check_disk(free: u64, size: u64) -> Result<(), String> {
    if free < size.saturating_mul(2).saturating_add(500 * 1024 * 1024) {
        Err("INSUFFICIENT_DISK".into())
    } else {
        Ok(())
    }
}
pub fn check_limit(count: u64) -> Result<(), String> {
    if count >= 10 {
        Err("SNAPSHOT_LIMIT".into())
    } else {
        Ok(())
    }
}
#[cfg(windows)]
pub fn free_bytes(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let path = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut free = 0;
    if unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        Err("INSUFFICIENT_DISK".into())
    } else {
        Ok(free)
    }
}
#[cfg(not(windows))]
pub fn free_bytes(_path: &Path) -> Result<u64, String> {
    Err("UNSUPPORTED_ON_PLATFORM".into())
}
pub fn schema_version(c: &Connection) -> Result<i64, String> {
    c.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
        .map_err(guards::error)
}
pub fn cheap_watermark(c: &Connection) -> Result<Value, String> {
    let mut cheap = serde_json::Map::new();
    for t in guards::schema(c)? {
        if t.name == "support_txn_marker" {
            continue;
        }
        let sql = format!(
            "SELECT COUNT(*) AS count{}{} FROM {}",
            if t.sql.to_ascii_uppercase().contains("WITHOUT ROWID") {
                String::new()
            } else {
                ",MAX(rowid) AS max_rowid".into()
            },
            if t.columns.iter().any(|c| c == "updated_at") {
                ",MAX(updated_at) AS max_updated_at"
            } else {
                ""
            },
            replica::quote(&t.name)
        );
        cheap.insert(
            t.name,
            guards::rows(c, &sql, &[])?
                .into_iter()
                .next()
                .ok_or("SNAPSHOT_FAILED")?,
        );
    }
    Ok(Value::Object(cheap))
}
pub fn watermarks(c: &Connection) -> Result<(Value, Value), String> {
    watermarks_checked(c, || Ok(()))
}
pub fn watermarks_for_write(
    c: &Connection,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<Value, String> {
    watermarks_checked(c, || {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        if Instant::now() >= deadline {
            return Err("QUERY_TIMEOUT".into());
        }
        Ok(())
    })
    .map(|(full, _)| full)
}
fn watermarks_checked(
    c: &Connection,
    check: impl Fn() -> Result<(), String>,
) -> Result<(Value, Value), String> {
    check()?;
    let cheap = cheap_watermark(c)?;
    let mut full = serde_json::Map::new();
    for t in guards::schema(c)? {
        check()?;
        if t.name == "support_txn_marker" {
            continue;
        }
        let mut hashes = Vec::new();
        let order = if t.pk.is_empty() {
            if t.sql.to_ascii_uppercase().contains("WITHOUT ROWID") {
                t.columns
                    .iter()
                    .map(|c| replica::quote(c))
                    .collect::<Vec<_>>()
                    .join(",")
            } else {
                "rowid".into()
            }
        } else {
            t.pk.iter()
                .map(|c| replica::quote(c))
                .collect::<Vec<_>>()
                .join(",")
        };
        // Bounded batches avoid materializing customer/financial rows in memory.
        let mut offset = 0;
        loop {
            let batch = guards::rows(
                c,
                &format!(
                    "SELECT * FROM {} ORDER BY {order} LIMIT 64 OFFSET ?",
                    replica::quote(&t.name)
                ),
                &[rusqlite::types::Value::Integer(offset)],
            )?;
            let done = batch.len() < 64;
            for row in batch {
                check()?;
                hashes.push(contracts::payload_hash(&row));
                check()?;
            }
            if done {
                break;
            }
            offset += 64;
        }
        full.insert(t.name.clone(),json!({"count":cheap[&t.name]["count"],"sha256":contracts::payload_hash(&json!(hashes))}));
    }
    check()?;
    Ok((Value::Object(full), cheap))
}
pub fn disk_guard(live: &Path) -> Result<(), String> {
    let size = std::fs::metadata(live)
        .map_err(|_| "SNAPSHOT_FAILED")?
        .len()
        .saturating_add(
            std::fs::metadata(format!("{}-wal", live.display()))
                .map(|m| m.len())
                .unwrap_or(0),
        );
    check_disk(free_bytes(live.parent().ok_or("SNAPSHOT_FAILED")?)?, size)
}
pub fn take(
    store: &Connection,
    live: &Path,
    session: &str,
    approval: Option<&str>,
    reason: &str,
    permit: &SupportPermit,
) -> Result<Snapshot, String> {
    let count = store
        .query_row(
            "SELECT COUNT(*) FROM support_snapshots WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    check_limit(count)?;
    disk_guard(live)?;
    let id = uuid::Uuid::new_v4().to_string();
    let folder = live
        .parent()
        .ok_or("SNAPSHOT_FAILED")?
        .join("support-snapshots")
        .join(&id);
    std::fs::create_dir_all(&folder).map_err(|_| "SNAPSHOT_FAILED")?;
    let result = (|| {
        let c = replica::read_connection(live, permit, Instant::now() + Duration::from_secs(30))?;
        let before = watermarks(&c)?;
        let copy = folder.join("pos.db");
        c.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])
            .map_err(guards::error)?;
        let check =
            replica::read_connection(&copy, permit, Instant::now() + Duration::from_secs(30))?;
        integrity(&check)?;
        let (full, cheap) = watermarks(&check)?;
        if full != before.0 || watermarks(&c)?.0 != full {
            return Err("PAYLOAD_DRIFT".into());
        }
        let mut size = std::fs::metadata(&copy)
            .map_err(|_| "SNAPSHOT_FAILED")?
            .len();
        let mut files = std::collections::BTreeMap::new();
        // Native local configuration is normally in pos.db. Include these
        // app-private settings files if an older install still has them.
        for name in ["settings.json", "config.json"] {
            let file = live.parent().ok_or("SNAPSHOT_FAILED")?.join(name);
            if file.is_file() {
                let bytes = std::fs::read(&file).map_err(|_| "SNAPSHOT_FAILED")?;
                size = size.saturating_add(bytes.len() as u64);
                std::fs::write(folder.join(name), &bytes).map_err(|_| "SNAPSHOT_FAILED")?;
                files.insert(name.into(), contracts::sha256(&bytes));
            }
        }
        let schema_sha256 = contracts::payload_hash(&json!(guards::schema(&check)?));
        let hash = contracts::payload_hash(
            &json!({"main":contracts::payload_hash(&full),"settings":files,"schema":schema_sha256}),
        );
        let snap = Snapshot {
            id: id.clone(),
            session: session.into(),
            approval: approval.map(str::to_string),
            at: clock::iso(chrono::Utc::now().timestamp_millis()),
            folder: folder.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
            versions: json!({"main":schema_version(&check)?}),
            size,
            hash,
            full,
            cheap,
            reason: reason.into(),
            files,
            schema_sha256,
        };
        std::fs::write(
            folder.join("manifest.json"),
            serde_json::to_vec(&snap).map_err(|_| "SNAPSHOT_FAILED")?,
        )
        .map_err(|_| "SNAPSHOT_FAILED")?;
        let tx = super::db::transaction(store).map_err(guards::error)?;
        tx.execute("UPDATE support_snapshots SET superseded=1", [])
            .map_err(guards::error)?;
        tx.execute("INSERT INTO support_snapshots(id,session_id,approval_id,taken_at,path,app_version,schema_versions_json,size_bytes,integrity_hash,full_watermark_json,cheap_watermark_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![snap.id,session,approval,snap.at,folder.to_string_lossy(),snap.version,snap.versions.to_string(),size,snap.hash,snap.full.to_string(),snap.cheap.to_string()]).map_err(guards::error)?;
        tx.commit().map_err(guards::error)?;
        Ok(snap)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
    } else {
        let _ = prune(store, session, chrono::Utc::now().timestamp_millis());
    }
    if permit.is_cancelled() && result.is_err() {
        Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
    } else {
        result
    }
}
pub fn integrity(c: &Connection) -> Result<(), String> {
    let r = guards::rows(c, "PRAGMA integrity_check", &[]).map_err(|_| "SNAPSHOT_FAILED")?;
    if r.len() == 1
        && r[0]
            .as_object()
            .is_some_and(|o| o.values().all(|v| v == "ok"))
    {
        Ok(())
    } else {
        Err("SNAPSHOT_FAILED".into())
    }
}
pub fn load(store: &Connection, id: &str) -> Result<Snapshot, String> {
    let (path, hash, full): (String, String, String) = store
        .query_row(
            "SELECT path,integrity_hash,full_watermark_json FROM support_snapshots WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "SNAPSHOT_FAILED")?;
    let folder = PathBuf::from(path);
    let snap: Snapshot = serde_json::from_slice(
        &std::fs::read(folder.join("manifest.json")).map_err(|_| "SNAPSHOT_FAILED")?,
    )
    .map_err(|_| "SNAPSHOT_FAILED")?;
    if snap.hash != hash
        || snap.full.to_string() != full
        || snap.id != id
        || snap.folder != folder
        || folder.file_name().and_then(|s| s.to_str()) != Some(id)
        || folder
            .parent()
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            != Some("support-snapshots")
    {
        return Err("SNAPSHOT_FAILED".into());
    }
    Ok(snap)
}
/// Result delivery/retry must not depend on opening the snapshot file again.
/// The verified metadata was committed to support.db before the action.
pub fn metadata(store: &Connection, id: &str) -> Result<Value, String> {
    let (at,version,versions,size,hash,full):(String,String,String,i64,String,String)=store.query_row("SELECT taken_at,app_version,schema_versions_json,size_bytes,integrity_hash,full_watermark_json FROM support_snapshots WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|_|"SNAPSHOT_FAILED")?;
    let versions: Value = serde_json::from_str(&versions).map_err(|_| "SNAPSHOT_FAILED")?;
    let full: Value = serde_json::from_str(&full).map_err(|_| "SNAPSHOT_FAILED")?;
    Ok(
        json!({"local_snapshot_id":id,"taken_at":at,"app_version":version,"schema_versions":versions,"size_bytes":size,"integrity_hash":hash,"financial_watermark":{"main":full}}),
    )
}
pub fn verify(s: &Snapshot) -> Result<(), String> {
    verify_with(s, None)
}
pub fn verify_with(s: &Snapshot, permit: Option<&SupportPermit>) -> Result<(), String> {
    let work = (|| {
        let c = Connection::open_with_flags(
            s.folder.join("pos.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(guards::error)?;
        let end = Instant::now() + Duration::from_secs(30);
        if let Some(permit) = permit {
            permit.guard_connection(&c, end);
        } else {
            c.progress_handler(100, Some(move || Instant::now() > end));
        }
        integrity(&c)?;
        if watermarks(&c)?.0 != s.full
            || contracts::payload_hash(&json!(guards::schema(&c)?)) != s.schema_sha256
            || schema_version(&c)? != s.versions["main"].as_i64().ok_or("SNAPSHOT_FAILED")?
        {
            return Err("SNAPSHOT_FAILED".into());
        }
        for (name, hash) in &s.files {
            if !["settings.json", "config.json"].contains(&name.as_str())
                || contracts::sha256(
                    &std::fs::read(s.folder.join(name)).map_err(|_| "SNAPSHOT_FAILED")?,
                ) != *hash
            {
                return Err("SNAPSHOT_FAILED".into());
            }
        }
        if contracts::payload_hash(
            &json!({"main":contracts::payload_hash(&s.full),"settings":s.files,"schema":s.schema_sha256}),
        ) != s.hash
        {
            return Err("SNAPSHOT_FAILED".into());
        }
        Ok(())
    })();
    work.map_err(|_: String| "SNAPSHOT_FAILED".into())
}
#[cfg(test)]
pub fn post_change(store: &Connection, live: &Connection, id: &str) -> Result<(), String> {
    store
        .execute(
            "UPDATE support_snapshots SET post_change_watermark_json=?1 WHERE id=?2",
            params![watermarks(live)?.0.to_string(), id],
        )
        .map_err(guards::error)?;
    Ok(())
}
pub fn prune(store: &Connection, active: &str, now: i64) -> Result<(), String> {
    let rows=guards::rows(store,"SELECT id,session_id,taken_at,path FROM support_snapshots ORDER BY taken_at DESC,rowid DESC",&[])?;
    for (i, r) in rows.iter().enumerate() {
        if r["session_id"] == active {
            continue;
        }
        if i < 10
            && clock::parse(r["taken_at"].as_str().ok_or("SNAPSHOT_FAILED")?)
                .map_err(str::to_string)?
                > now.saturating_sub(14 * 86400000)
        {
            continue;
        }
        let id = r["id"].as_str().ok_or("SNAPSHOT_FAILED")?;
        let snap = load(store, id)?;
        std::fs::remove_dir_all(&snap.folder).map_err(|_| "SNAPSHOT_FAILED")?;
        store
            .execute("DELETE FROM support_snapshots WHERE id=?1", [id])
            .map_err(guards::error)?;
    }
    Ok(())
}
pub fn newest(store: &Connection) -> Result<Option<String>, String> {
    store
        .query_row(
            "SELECT id FROM support_snapshots ORDER BY taken_at DESC,rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(guards::error)
}
