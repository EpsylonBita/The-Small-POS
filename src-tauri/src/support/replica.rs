//! Private, disposable sanitized replicas. Live reads have their own READ_ONLY handle.
use super::{contracts, critical_op::SupportPermit};
use rusqlite::{
    config::DbConfig,
    hooks::{AuthAction, AuthContext, Authorization},
    Connection, OpenFlags,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub fn sql_error(error: rusqlite::Error) -> String {
    if let Some(detail) = super::evidence::sql_error(&error) {
        return super::evidence::error(detail);
    }
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt) => {
            return super::evidence::error("BUSINESS_DATABASE_OPEN_FAILED")
        }
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            return super::evidence::error("BUSINESS_DATABASE_BUSY")
        }
        Some(rusqlite::ErrorCode::OperationInterrupted) => "QUERY_TIMEOUT",
        _ => "POLICY_REFUSED",
    }
    .into()
}
pub fn read_connection(
    path: &Path,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<Connection, String> {
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    match std::fs::metadata(path) {
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(super::evidence::error("BUSINESS_DATABASE_MISSING"))
        }
        Err(_) => return Err(super::evidence::error("BUSINESS_DATABASE_OPEN_FAILED")),
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| super::evidence::error("BUSINESS_DATABASE_OPEN_FAILED"))?;
    conn.busy_timeout(Duration::from_millis(100))
        .map_err(sql_error)?;
    permit.guard_connection(&conn, deadline);
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(sql_error)?;
    conn.execute_batch("PRAGMA trusted_schema=OFF")
        .map_err(sql_error)?;
    Ok(conn)
}
pub fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn schema_indexes(conn: &Connection, table: &str) -> Result<Vec<Value>, String> {
    let mut list = conn
        .prepare(&format!("PRAGMA index_list({})", quote(table)))
        .map_err(sql_error)?;
    let names = list
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, bool>(2)?)))
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    let mut indexes = Vec::new();
    for (name, unique) in names {
        let mut q = conn
            .prepare(&format!("PRAGMA index_info({})", quote(&name)))
            .map_err(sql_error)?;
        let columns = q
            .query_map([], |r| r.get::<_, Option<String>>(2))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        indexes.push(json!({"name":name,"columns":columns,"unique":unique}));
    }
    Ok(indexes)
}
/// Metadata has no need for a data replica. Never export schema SQL, defaults,
/// trigger bodies or index expressions, all of which can contain credentials.
pub fn schema(live: &Path, permit: &SupportPermit) -> Result<Value, String> {
    let conn = read_connection(live, permit, Instant::now() + Duration::from_secs(5))?;
    let mut tables = Vec::new();
    let mut q = conn.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(sql_error)?;
    let names = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    for name in names {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        let mut q = conn
            .prepare(&format!("PRAGMA table_xinfo({})", quote(&name)))
            .map_err(sql_error)?;
        let cols = q.query_map([], |r| Ok(json!({"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"not_null":r.get::<_,bool>(3)?,"pk":r.get::<_,i64>(5)?>0})))
            .map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        let columns: Vec<_> = cols
            .into_iter()
            .map(|mut c| {
                c["classification"] =
                    json!(classification(&name, c["name"].as_str().unwrap_or("")));
                c
            })
            .collect();
        // Count only admitted tables. Secret table occupancy is secret too.
        let secret = desktop_map()["tables"]
            .get(&name)
            .is_none_or(|t| t["classification"] == "secret");
        let count: i64 = if secret {
            0
        } else {
            conn.query_row(&format!("SELECT count(*) FROM {}", quote(&name)), [], |r| {
                r.get(0)
            })
            .map_err(sql_error)?
        };
        let indexes = schema_indexes(&conn, &name)?;
        tables.push(json!({"name":name,"row_count":count,"emptied_as_secret":secret,"columns":columns,"indexes":indexes}));
    }
    Ok(
        json!({"database":"main","replica_taken_at":chrono::Utc::now().to_rfc3339(),"sqlite_version":rusqlite::version(),"tables":tables}),
    )
}
pub fn desktop_map() -> &'static Value {
    contracts::shared().other["classification"]["maps"]
        .as_array()
        .expect("maps")
        .iter()
        .find(|m| m["app"] == "windows" && m["database"] == "pos.db")
        .expect("desktop classification")
}
pub fn classification(table: &str, column: &str) -> &'static str {
    let t = &desktop_map()["tables"][table];
    if t["classification"] == "secret" {
        return "secret";
    }
    t["columns"][column].as_str().unwrap_or("secret")
}
pub fn safe_key(category: &str, key: &str) -> bool {
    category == "local"
        && key
            .strip_prefix("printer_last_known_brand:")
            .is_some_and(|host| {
                !host.is_empty()
                    && host.as_bytes()[0].is_ascii_alphanumeric()
                    && host.len() <= 253
                    && host
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
            })
}
fn cleanup_file(path: &Path) {
    if path.as_os_str().is_empty() {
        return;
    }
    let _ = std::fs::remove_file(path);
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut side = path.as_os_str().to_os_string();
        side.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(side));
    }
}
struct Scratch(PathBuf);
impl Scratch {
    fn persist(mut self) -> PathBuf {
        std::mem::take(&mut self.0)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        cleanup_file(&self.0);
    }
}
pub struct Replica {
    pub path: PathBuf,
    pub taken_at: String,
    pub schema: Value,
}
impl Drop for Replica {
    fn drop(&mut self) {
        cleanup_file(&self.path);
    }
}
#[derive(Default)]
struct ReplicaState {
    session: String,
    replica: Option<std::sync::Arc<Replica>>,
    last_refresh: Option<Instant>,
    building: bool,
    error: Option<String>,
    retry_at: Option<Instant>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    worker_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}
#[derive(Default)]
pub struct ReplicaManager {
    state: std::sync::Arc<std::sync::Mutex<ReplicaState>>,
}
impl ReplicaManager {
    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.state.lock().unwrap().replica.is_none()
    }
    pub fn clear(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state
                .cancelled
                .store(true, std::sync::atomic::Ordering::Release);
            if let Some(cancel) = &state.worker_cancel {
                cancel.store(true, std::sync::atomic::Ordering::Release);
            }
            state.replica = None;
        }
        // The cancelled worker owns the old state until its scratch files drop.
        self.state = Default::default();
    }
    pub fn get(
        &mut self,
        live: &Path,
        session: &str,
        refresh: bool,
        permit: &SupportPermit,
    ) -> Result<std::sync::Arc<Replica>, String> {
        self.get_evidence(live, session, refresh, permit, false)
    }
    pub fn get_evidence(
        &mut self,
        live: &Path,
        session: &str,
        refresh: bool,
        permit: &SupportPermit,
        personal: bool,
    ) -> Result<std::sync::Arc<Replica>, String> {
        if self.state.lock().map_err(|_| "INTERNAL_ERROR")?.session != session {
            self.clear();
            self.state.lock().map_err(|_| "INTERNAL_ERROR")?.session = session.into();
        }
        let mut state = self.state.lock().map_err(|_| "INTERNAL_ERROR")?;
        if !refresh {
            if let Some(replica) = &state.replica {
                return Ok(replica.clone());
            }
        }
        if state.building {
            return Err("REPLICA_BUILDING".into());
        }
        if let Some(error) = &state.error {
            if state.retry_at.is_some_and(|at| Instant::now() < at) {
                return Err(error.clone());
            }
            state.error = None;
        }
        if state.replica.is_some()
            && state.last_refresh.is_some_and(|at| {
                at.elapsed() < Duration::from_millis(contracts::cap("tools", "replicaRefreshMs"))
            })
        {
            return Err("RATE_LIMITED".into());
        }
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        state.building = true;
        let shared = self.state.clone();
        let cancelled = state.cancelled.clone();
        let live = live.to_path_buf();
        let gate = permit.gate();
        drop(state);
        // One bounded worker per session. Never hold Core, a business write
        // transaction or the manager mutex while copying/redacting the database.
        if std::thread::Builder::new()
            .name("support-replica".into())
            .spawn(move || {
                let result = (|| {
                    let permit = gate
                        .try_begin_support(false, None)
                        .map_err(|_| "PREEMPTED_BY_CRITICAL_OPERATION")?;
                    {
                        let mut state = shared.lock().map_err(|_| "INTERNAL_ERROR")?;
                        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
                        }
                        state.worker_cancel = Some(permit.cancelled.clone());
                    }
                    build_evidence(&live, &permit, personal)
                })();
                if let Ok(mut state) = shared.lock() {
                    state.building = false;
                    state.worker_cancel = None;
                    if !cancelled.load(std::sync::atomic::Ordering::Acquire) {
                        match result {
                            Ok(replica) => {
                                state.replica = Some(std::sync::Arc::new(replica));
                                // Measure cooldown from the completed publication,
                                // not the beginning of a potentially long copy.
                                state.last_refresh = Some(Instant::now());
                                state.error = None;
                            }
                            Err(error) => {
                                let delay = if error == "PREEMPTED_BY_CRITICAL_OPERATION" {
                                    contracts::cap("performance", "replicaRetryAfterMs")
                                } else {
                                    contracts::cap("tools", "replicaRefreshMs")
                                };
                                state.retry_at =
                                    Some(Instant::now() + Duration::from_millis(delay));
                                state.error = Some(error);
                            }
                        }
                    }
                }
            })
            .is_err()
        {
            self.state.lock().map_err(|_| "INTERNAL_ERROR")?.building = false;
            return Err(super::evidence::error("REPLICA_BUILD_FAILED"));
        }
        Err("REPLICA_BUILDING".into())
    }
}
impl Drop for ReplicaManager {
    fn drop(&mut self) {
        self.clear();
    }
}
pub fn cleanup_startup(dir: &Path) -> Result<(), String> {
    let scratch = dir.join("support-replicas");
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch).map_err(|_| "INTERNAL_ERROR")?;
    }
    std::fs::create_dir_all(scratch).map_err(|_| "INTERNAL_ERROR".into())
}
#[cfg(windows)]
fn free_bytes(path: &Path) -> Result<u64, String> {
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
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err("INTERNAL_ERROR".into())
    } else {
        Ok(available)
    }
}
#[cfg(not(windows))]
fn free_bytes(_path: &Path) -> Result<u64, String> {
    Err("UNSUPPORTED_ON_PLATFORM".into())
}
pub(super) fn build_budget() -> Duration {
    Duration::from_millis(contracts::cap("performance", "replicaBuildMs"))
}
pub(super) fn background_budget() -> Duration {
    Duration::from_millis(contracts::cap("performance", "replicaBackgroundBuildMs"))
}
/// Incremental backup releases the live read lock between 64-page steps.
/// Only private scratch is written; checkout admission never waits on support.
fn copy_snapshot(
    live: &Path,
    raw: &Path,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<(), String> {
    let source = read_connection(live, permit, deadline)?;
    let target = Connection::open(raw).map_err(sql_error)?;
    target
        .busy_timeout(Duration::from_millis(100))
        .map_err(sql_error)?;
    unsafe {
        let backup = rusqlite::ffi::sqlite3_backup_init(
            target.handle(),
            c"main".as_ptr(),
            source.handle(),
            c"main".as_ptr(),
        );
        if backup.is_null() {
            return Err(super::evidence::error("REPLICA_BUILD_FAILED"));
        }
        let result = loop {
            if permit.is_cancelled() {
                break Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
            }
            if Instant::now() >= deadline {
                break Err("QUERY_TIMEOUT".into());
            }
            match rusqlite::ffi::sqlite3_backup_step(backup, 64) {
                rusqlite::ffi::SQLITE_DONE => break Ok(()),
                rusqlite::ffi::SQLITE_OK
                | rusqlite::ffi::SQLITE_BUSY
                | rusqlite::ffi::SQLITE_LOCKED => std::thread::sleep(Duration::from_millis(2)),
                _ => break Err(super::evidence::error("REPLICA_BUILD_FAILED")),
            }
        };
        let finished = rusqlite::ffi::sqlite3_backup_finish(backup);
        result?;
        if finished != rusqlite::ffi::SQLITE_OK {
            return Err(super::evidence::error("REPLICA_BUILD_FAILED"));
        }
    }
    Ok(())
}
pub fn build(live: &Path, permit: &SupportPermit) -> Result<Replica, String> {
    build_evidence(live, permit, false)
}
pub fn build_evidence(
    live: &Path,
    permit: &SupportPermit,
    personal: bool,
) -> Result<Replica, String> {
    build_inner(live, permit, personal).map_err(|code| {
        if permit.is_cancelled() {
            "PREEMPTED_BY_CRITICAL_OPERATION".into()
        } else if super::evidence::split_error(&code).1 == Some("HEALTH_OBSERVATION_MISSING") {
            super::evidence::error("REPLICA_BUILD_FAILED")
        } else if super::evidence::split_error(&code).1.is_some()
            || matches!(
                code.as_str(),
                "PREEMPTED_BY_CRITICAL_OPERATION" | "RATE_LIMITED"
            )
        {
            code
        } else if code == "QUERY_TIMEOUT" {
            super::evidence::error("REPLICA_BUILD_TIMEOUT")
        } else if code == "INSUFFICIENT_DISK" {
            format!("{code}|INSUFFICIENT_FREE_DISK")
        } else {
            super::evidence::error("REPLICA_BUILD_FAILED")
        }
    })
}
fn build_inner(live: &Path, permit: &SupportPermit, personal: bool) -> Result<Replica, String> {
    let source = read_connection(live, permit, Instant::now() + background_budget())?;
    drop(source);
    let dir = live
        .parent()
        .ok_or("INTERNAL_ERROR")?
        .join("support-replicas");
    std::fs::create_dir_all(&dir).map_err(|_| "INTERNAL_ERROR")?;
    let size = std::fs::metadata(live)
        .map_err(|_| "INTERNAL_ERROR")?
        .len()
        .saturating_add(
            std::fs::metadata(format!("{}-wal", live.display()))
                .map(|m| m.len())
                .unwrap_or(0),
        );
    if free_bytes(&dir)? < size.saturating_mul(2).saturating_add(500 * 1024 * 1024) {
        return Err("INSUFFICIENT_DISK".into());
    }
    let raw = Scratch(dir.join(format!("raw-{}.db", uuid::Uuid::new_v4())));
    let clean = Scratch(dir.join(format!("redacted-{}.db", uuid::Uuid::new_v4())));
    let deadline = Instant::now() + background_budget();
    copy_snapshot(live, &raw.0, permit, deadline)?;
    let taken_at = chrono::Utc::now().to_rfc3339();
    let snapshot = read_connection(&raw.0, permit, deadline)?;
    let policy = super::evidence::Policy::load_until(&snapshot, personal, permit, deadline)?;
    let dest = Connection::open(&clean.0).map_err(sql_error)?;
    permit.guard_connection(&dest, deadline);
    // Scratch is disposable and published only after commit. Bound the page
    // cache; avoid journal syncs and keep sort spill on disk.
    dest.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE").map_err(sql_error)?;
    let write = crate::db::immediate_transaction(&dest).map_err(sql_error)?;
    // Reconstruct data-only tables: raw triggers, views, generated expressions,
    // CHECK/default expressions and sqlite_stat samples must never reach a query.
    let mut tables=snapshot.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(sql_error)?;
    let names = tables
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    drop(tables);
    let mut schema = Vec::new();
    for name in names {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        let mut stmt = snapshot
            .prepare(&format!("PRAGMA table_xinfo({})", quote(&name)))
            .map_err(sql_error)?;
        let cols=stmt.query_map([],|r|Ok(json!({"name":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"not_null":r.get::<_,bool>(3)?,"pk":r.get::<_,i64>(5)?>0}))).map_err(sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_error)?;
        if cols.is_empty() {
            continue;
        }
        let defs = cols
            .iter()
            .map(|c| {
                // Preserve SQLite affinity without copying any schema SQL,
                // default expression, CHECK, trigger or uniqueness constraint.
                let declared = c["type"].as_str().unwrap_or("").to_ascii_uppercase();
                let affinity = if declared.contains("INT") {
                    "INTEGER"
                } else if ["CHAR", "CLOB", "TEXT"]
                    .iter()
                    .any(|s| declared.contains(s))
                {
                    "TEXT"
                } else if declared.is_empty() || declared.contains("BLOB") {
                    "BLOB"
                } else if ["REAL", "FLOA", "DOUB"]
                    .iter()
                    .any(|s| declared.contains(s))
                {
                    "REAL"
                } else {
                    "NUMERIC"
                };
                format!("{} {affinity}", quote(c["name"].as_str().unwrap()))
            })
            .collect::<Vec<_>>()
            .join(",");
        dest.execute_batch(&format!("CREATE TABLE {} ({defs})", quote(&name)))
            .map_err(sql_error)?;
        let secret = desktop_map()["tables"]
            .get(&name)
            .is_none_or(|t| t["classification"] == "secret");
        if !secret {
            let expressions=cols.iter().map(|c|{
                let col=c["name"].as_str().unwrap();
                if (name=="local_settings" || name=="pos_local_config") && matches!(col,"setting_value"|"config_value") {
                    // Only operational printer-brand keys can retain their value.
                    format!("CASE WHEN setting_category='local' AND setting_key GLOB 'printer_last_known_brand:[A-Za-z0-9]*' AND substr(setting_key,26) NOT GLOB '*[^A-Za-z0-9._:-]*' AND length(setting_key)<=278 THEN {} ELSE '[REDACTED]' END",quote(col))
                } else if matches!(classification(&name,col),"safe"|"free_text") || personal && classification(&name,col)=="pii" {quote(col)} else {"'[REDACTED]'".into()}
            }).collect::<Vec<_>>().join(",");
            // An arbitrary source scan may choose an index on a sensitive
            // column. Do not preserve that ordering as a hidden property of
            // the original value: order the copy only by admitted safe cells.
            let safe_order = cols
                .iter()
                .filter_map(|c| c["name"].as_str())
                .filter(|col| classification(&name, col) == "safe")
                .map(quote)
                .collect::<Vec<_>>();
            let order = if safe_order.is_empty() {
                String::new()
            } else {
                format!(" ORDER BY {}", safe_order.join(","))
            };
            let mut read = snapshot
                .prepare(&format!(
                    "SELECT {expressions} FROM {}{order}",
                    quote(&name)
                ))
                .map_err(sql_error)?;
            let mut rows = read.query([]).map_err(sql_error)?;
            let placeholders = (0..cols.len()).map(|_| "?").collect::<Vec<_>>().join(",");
            let mut insert = dest
                .prepare(&format!(
                    "INSERT INTO {} VALUES({placeholders})",
                    quote(&name)
                ))
                .map_err(sql_error)?;
            let mut copied = 0usize;
            while let Some(row) = rows.next().map_err(sql_error)? {
                if permit.is_cancelled() || Instant::now() >= deadline {
                    return Err("QUERY_TIMEOUT".into());
                }
                if copied > 0 && copied % 64 == 0 {
                    std::thread::sleep(Duration::from_millis(2));
                }
                copied += 1;
                let mut values = (0..cols.len())
                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(sql_error)?;
                for (index, value) in values.iter_mut().enumerate() {
                    if (name == "local_settings" || name == "pos_local_config")
                        && matches!(
                            cols[index]["name"].as_str(),
                            Some("setting_key" | "setting_category")
                        )
                    {
                        continue;
                    }
                    if let rusqlite::types::Value::Text(text) = value {
                        // JSON free text gets field-level masking before SQL/aliases.
                        *text = match serde_json::from_str::<Value>(text) {
                            Ok(v) if v.is_object() || v.is_array() => policy.record(v).to_string(),
                            _ => policy.string(text),
                        };
                    }
                }
                insert
                    .execute(rusqlite::params_from_iter(values))
                    .map_err(sql_error)?;
            }
        }
        let count: i64 = dest
            .query_row(&format!("SELECT count(*) FROM {}", quote(&name)), [], |r| {
                r.get(0)
            })
            .map_err(sql_error)?;
        let columns = cols
            .into_iter()
            .map(|mut c| {
                c["classification"] = json!(classification(&name, c["name"].as_str().unwrap()));
                c
            })
            .collect::<Vec<_>>();
        let mut indexes = Vec::new();
        let mut list = snapshot
            .prepare(&format!("PRAGMA index_list({})", quote(&name)))
            .map_err(sql_error)?;
        let rows = list
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, bool>(2)?)))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)?;
        for (index, unique) in rows {
            let mut stmt = snapshot
                .prepare(&format!("PRAGMA index_info({})", quote(&index)))
                .map_err(sql_error)?;
            let cols = stmt
                .query_map([], |r| r.get::<_, Option<String>>(2))
                .map_err(sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            indexes.push(json!({"name":index,"columns":cols,"unique":unique}));
        }
        schema.push(json!({"name":name,"row_count":count,"emptied_as_secret":secret,"columns":columns,"indexes":indexes}));
    }
    write.commit().map_err(sql_error)?;
    drop(dest);
    drop(snapshot);
    let path = clean.persist();
    Ok(Replica {
        path,
        taken_at,
        schema: json!(schema),
    })
}
pub fn query_connection(
    replica: &Replica,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<Connection, String> {
    let conn = read_connection(&replica.path, permit, deadline)?;
    conn.execute_batch("PRAGMA query_only=ON")
        .map_err(sql_error)?;
    // Bound allocations inside SQLite functions before cell truncation (a
    // printf/zeroblob expression must not allocate an unbounded intermediate).
    unsafe {
        let db = conn.handle();
        rusqlite::ffi::sqlite3_limit(db, rusqlite::ffi::SQLITE_LIMIT_LENGTH, 262144);
        rusqlite::ffi::sqlite3_limit(db, rusqlite::ffi::SQLITE_LIMIT_SQL_LENGTH, 4000);
        rusqlite::ffi::sqlite3_limit(db, rusqlite::ffi::SQLITE_LIMIT_COLUMN, 200);
        rusqlite::ffi::sqlite3_limit(db, rusqlite::ffi::SQLITE_LIMIT_EXPR_DEPTH, 100);
    }
    // Extension loading is disabled by default and no enabling API is compiled.
    conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
        AuthAction::Read {
            table_name,
            column_name,
        } if table_name == "sqlite_master"
            || table_name == "sqlite_schema"
            || classification(table_name, column_name) != "secret" =>
        {
            Authorization::Allow
        }
        AuthAction::Read {
            column_name: "", ..
        } => Authorization::Allow,
        AuthAction::Function { function_name }
            if contracts::shared().functions["allowlist"]
                .as_object()
                .is_some_and(|groups| {
                    groups.values().any(|g| {
                        g.as_array()
                            .is_some_and(|f| f.iter().any(|n| n.as_str() == Some(function_name)))
                    })
                }) =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }));
    Ok(conn)
}

#[cfg(test)]
mod background_tests {
    use super::*;
    use crate::support::critical_op::CriticalOpGate;
    fn wait_ready(
        manager: &mut ReplicaManager,
        live: &Path,
        permit: &SupportPermit,
    ) -> std::sync::Arc<Replica> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match manager.get(live, "session", false, permit) {
                Err(code) if code == "REPLICA_BUILDING" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                result => return result.unwrap(),
            }
        }
    }
    #[test]
    fn failed_background_refresh_keeps_the_last_good_replica() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let db = crate::tests::harness::TestDb::open();
        let gate = CriticalOpGate::new();
        let permit = gate.try_begin_support(false, None).unwrap();
        let mut manager = ReplicaManager::default();
        let prior = wait_ready(&mut manager, db.db_path(), &permit);
        manager.state.lock().unwrap().last_refresh = None;
        let missing = db.dir().join("missing-business.db");
        assert!(
            matches!(manager.get(&missing, "session", true, &permit), Err(code) if code == "REPLICA_BUILDING")
        );
        // A query remains served even when the replacement build fails.
        assert_eq!(
            manager
                .get(db.db_path(), "session", false, &permit)
                .unwrap()
                .path,
            prior.path
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while manager.state.lock().unwrap().building {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            matches!(manager.get(&missing, "session", true, &permit), Err(code) if code.contains("BUSINESS_DATABASE_MISSING"))
        );
        let current = manager
            .get(db.db_path(), "session", false, &permit)
            .unwrap();
        assert_eq!(current.path, prior.path);
        assert!(super::super::sql_query::query(
            &current,
            &json!({"sql":"SELECT count(*) FROM orders"}),
            &permit
        )
        .is_ok());
    }
    #[test]
    fn session_clear_cancels_inflight_publication_and_disposes_scratch() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let db = crate::tests::harness::TestDb::open();
        let gate = CriticalOpGate::new();
        let permit = gate.try_begin_support(false, None).unwrap();
        let mut manager = ReplicaManager::default();
        assert!(
            matches!(manager.get(db.db_path(), "session", false, &permit), Err(code) if code == "REPLICA_BUILDING")
        );
        let old = manager.state.clone();
        manager.clear();
        let deadline = Instant::now() + Duration::from_secs(15);
        while old.lock().unwrap().building {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(old.lock().unwrap().replica.is_none());
        assert!(manager.is_empty());
        let scratch = db.dir().join("support-replicas");
        if scratch.exists() {
            assert_eq!(std::fs::read_dir(scratch).unwrap().count(), 0);
        }
    }
}
