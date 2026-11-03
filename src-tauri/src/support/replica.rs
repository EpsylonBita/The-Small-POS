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
    match error.sqlite_error_code() {
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
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sql_error)?;
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
struct Scratch(PathBuf);
impl Scratch {
    fn persist(mut self) -> PathBuf {
        std::mem::take(&mut self.0)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
pub struct Replica {
    pub path: PathBuf,
    pub taken_at: String,
    pub schema: Value,
}
impl Drop for Replica {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
#[derive(Default)]
pub struct ReplicaManager {
    pub session: String,
    pub replica: Option<Replica>,
    last_refresh: Option<Instant>,
}
impl ReplicaManager {
    pub fn clear(&mut self) {
        self.replica = None;
        self.last_refresh = None;
        self.session.clear();
    }
    pub fn get(
        &mut self,
        live: &Path,
        session: &str,
        refresh: bool,
        permit: &SupportPermit,
    ) -> Result<&Replica, String> {
        if self.session != session {
            self.clear();
            self.session = session.into();
        }
        if (refresh || self.replica.is_none())
            && self
                .last_refresh
                .is_some_and(|at| at.elapsed() < Duration::from_secs(120))
        {
            return Err("RATE_LIMITED".into());
        }
        if refresh || self.replica.is_none() {
            self.last_refresh = Some(Instant::now());
            let replica = build(live, permit)?;
            self.replica = Some(replica);
        }
        self.replica.as_ref().ok_or("INTERNAL_ERROR".into())
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
pub fn build(live: &Path, permit: &SupportPermit) -> Result<Replica, String> {
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
    let deadline = Instant::now() + build_budget();
    {
        let source = read_connection(live, permit, deadline)?;
        // VACUUM INTO works on a READ_ONLY source; never BEGIN a live read transaction.
        source
            .execute("VACUUM INTO ?1", [raw.0.to_string_lossy().as_ref()])
            .map_err(sql_error)?;
    }
    let snapshot = read_connection(&raw.0, permit, deadline)?;
    let dest = Connection::open(&clean.0).map_err(sql_error)?;
    permit.guard_connection(&dest, deadline);
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
                } else if classification(&name,col)=="safe" {quote(col)} else {"'[REDACTED]'".into()}
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
            while let Some(row) = rows.next().map_err(sql_error)? {
                if permit.is_cancelled() || Instant::now() >= deadline {
                    return Err("QUERY_TIMEOUT".into());
                }
                let values = (0..cols.len())
                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(sql_error)?;
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
        taken_at: chrono::Utc::now().to_rfc3339(),
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
