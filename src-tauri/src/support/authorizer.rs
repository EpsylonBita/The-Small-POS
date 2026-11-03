//! Engine policy for payloads. Native bookkeeping has a scoped, non-SQL bypass.
use super::{contracts, guards, replica};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    Connection,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Default, Clone)]
pub struct Facts {
    pub writes: BTreeMap<String, BTreeSet<String>>,
    pub reads: BTreeMap<String, BTreeSet<String>>,
    pub functions: BTreeSet<String>,
    pub pii: BTreeSet<String>,
}
impl Facts {
    pub fn writes_json(&self) -> Value {
        json!(self
            .writes
            .iter()
            .map(|(t, c)| json!({"table":t,"columns":c}))
            .collect::<Vec<_>>())
    }
    pub fn reads_json(&self) -> Value {
        json!(self
            .reads
            .iter()
            .map(|(t, c)| json!({"table":t,"columns":c}))
            .collect::<Vec<_>>())
    }
}
pub struct Policy {
    internal: AtomicBool,
    pub facts: Mutex<Facts>,
    triggers: BTreeSet<String>,
    tables: BTreeSet<String>,
    accessors: BTreeSet<String>,
}
pub fn allowed_function(name: &str) -> bool {
    contracts::shared().functions["allowlist"]
        .as_object()
        .is_some_and(|g| {
            g.values().any(|v| {
                v.as_array()
                    .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(name)))
            })
        })
}
pub fn install(
    conn: &Connection,
    triggers: BTreeSet<String>,
    tables: BTreeSet<String>,
    accessors: BTreeSet<String>,
) -> Arc<Policy> {
    let policy = Arc::new(Policy {
        internal: AtomicBool::new(false),
        facts: Mutex::new(Facts::default()),
        triggers,
        tables,
        accessors,
    });
    let own = policy.clone();
    conn.authorizer(Some(move |ctx: AuthContext<'_>| {
        if own.internal.load(Ordering::Acquire) {
            return Authorization::Allow;
        }
        // Only TEMP triggers just installed by native code may read eligibility
        // evidence. Payloads cannot create/drop/alter triggers or change mode.
        if let Some(trigger) = ctx.accessor {
            if own.triggers.contains(trigger) {
                return Authorization::Allow;
            }
            if own.accessors.contains(trigger) {
                return Authorization::Deny;
            }
            // SQLite also uses this field for CTEs. Continue through the real
            // read/function/write checks for their derived expressions.
        }
        if ctx.database_name.is_some_and(|d| d != "main") {
            return Authorization::Deny;
        }
        let Ok(mut facts) = own.facts.lock() else {
            return Authorization::Deny;
        };
        match ctx.action {
            AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
            AuthAction::Read {
                table_name,
                column_name,
            } => {
                if table_name.starts_with("sqlite_") {
                    return Authorization::Deny;
                }
                // CTE/derived cursor names are not business tables. Their
                // underlying reads are separately authorized by SQLite.
                let real = own.tables.contains(table_name);
                let secret_table = replica::desktop_map()["tables"]
                    .get(table_name)
                    .is_none_or(|t| t["classification"] == "secret");
                if real
                    && (secret_table
                        || replica::classification(table_name, column_name) == "secret"
                            && !column_name.is_empty())
                {
                    return Authorization::Deny;
                }
                facts
                    .reads
                    .entry(table_name.into())
                    .or_default()
                    .insert(column_name.into());
                if real
                    && matches!(
                        replica::classification(table_name, column_name),
                        "pii" | "free_text"
                    )
                {
                    facts.pii.insert(format!("{table_name}.{column_name}"));
                }
                Authorization::Allow
            }
            AuthAction::Update {
                table_name,
                column_name,
            } if guards::policy(table_name)["update"]
                .as_array()
                .is_some_and(|a| a.iter().any(|c| c.as_str() == Some(column_name))) =>
            {
                facts
                    .writes
                    .entry(table_name.into())
                    .or_default()
                    .insert(column_name.into());
                Authorization::Allow
            }
            AuthAction::Delete { table_name }
                if guards::policy(table_name)["delete"] == "operational_key" =>
            {
                facts.writes.entry(table_name.into()).or_default();
                Authorization::Allow
            }
            // INSERT is conservatively refused, matching Android until the
            // shared engine-derived insert target proof has been implemented.
            AuthAction::Function { function_name } if allowed_function(function_name) => {
                facts.functions.insert(function_name.into());
                Authorization::Allow
            }
            _ => Authorization::Deny,
        }
    }));
    policy
}
struct Reset<'a>(&'a AtomicBool, bool);
impl Drop for Reset<'_> {
    fn drop(&mut self) {
        self.0.store(self.1, Ordering::Release);
    }
}
pub struct NativeScope<'a> {
    _reset: Reset<'a>,
}
/// Only native code can enter this scope. The default connection state denies
/// DDL and untrusted writes, including callers bypassing the payload helper.
pub fn native_scope(policy: &Policy) -> NativeScope<'_> {
    NativeScope {
        _reset: Reset(
            &policy.internal,
            policy.internal.swap(true, Ordering::AcqRel),
        ),
    }
}
pub fn internal<T>(policy: &Policy, f: impl FnOnce() -> T) -> T {
    let before = policy.internal.swap(true, Ordering::AcqRel);
    let _reset = Reset(&policy.internal, before);
    f()
}
pub fn single_statement(conn: &Connection, sql: &str) -> Result<(), String> {
    if sql.len() > 8000 {
        return Err("POLICY_REFUSED".into());
    }
    let sql = std::ffi::CString::new(sql).map_err(|_| "POLICY_REFUSED")?;
    let mut stmt = std::ptr::null_mut();
    let mut tail = std::ptr::null();
    // SQLite, not the lexical screen, decides the consumed statement boundary.
    let code = unsafe {
        rusqlite::ffi::sqlite3_prepare_v2(conn.handle(), sql.as_ptr(), -1, &mut stmt, &mut tail)
    };
    let ok = code == rusqlite::ffi::SQLITE_OK
        && !stmt.is_null()
        && (tail.is_null()
            || unsafe { std::ffi::CStr::from_ptr(tail) }
                .to_bytes()
                .iter()
                .all(u8::is_ascii_whitespace));
    if !stmt.is_null() {
        unsafe { rusqlite::ffi::sqlite3_finalize(stmt) };
    }
    if ok {
        Ok(())
    } else {
        Err(if code == rusqlite::ffi::SQLITE_INTERRUPT {
            "QUERY_TIMEOUT"
        } else {
            "POLICY_REFUSED"
        }
        .into())
    }
}
pub fn payload(conn: &Connection, policy: &Policy, sql: &str) -> Result<usize, String> {
    *policy.facts.lock().map_err(|_| "INTERNAL_ERROR")? = Facts::default();
    let before = policy.internal.swap(false, Ordering::AcqRel);
    let _reset = Reset(&policy.internal, before);
    single_statement(conn, sql)?;
    conn.execute(sql, []).map_err(guards::error)
}
pub fn inspect(conn: &Connection, policy: &Policy, sql: &str) -> Result<Facts, String> {
    *policy.facts.lock().map_err(|_| "INTERNAL_ERROR")? = Facts::default();
    let before = policy.internal.swap(false, Ordering::AcqRel);
    let _reset = Reset(&policy.internal, before);
    single_statement(conn, sql)?;
    let facts = policy.facts.lock().map_err(|_| "INTERNAL_ERROR")?.clone();
    if facts.writes.is_empty() {
        return Err("POLICY_REFUSED".into());
    }
    Ok(facts)
}
