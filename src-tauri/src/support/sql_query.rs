use super::{
    critical_op::SupportPermit,
    redaction,
    replica::{self, Replica},
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// SQLite proves that a constant query reads no database cells. It need not
/// copy and sanitize an entire day's ledger to answer `SELECT 1`.
pub fn tableless(input: &Value, permit: &SupportPermit) -> Result<Option<Value>, String> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let sql = input["sql"].as_str().ok_or("INVALID_INPUT")?;
    if !single_read(sql) {
        return Err("POLICY_REFUSED".into());
    }
    let conn = rusqlite::Connection::open_in_memory().map_err(replica::sql_error)?;
    let read = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let accessed = read.clone();
    conn.authorizer(Some(move |ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Read { .. } => {
            accessed.store(true, std::sync::atomic::Ordering::Release);
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }));
    permit.guard_connection(&conn, Instant::now() + Duration::from_secs(5));
    if let Err(error) = conn.prepare(sql) {
        return if read.load(std::sync::atomic::Ordering::Acquire)
            || super::evidence::sql_error(&error) == Some("TABLE_MISSING")
        {
            Ok(None)
        } else {
            Err(replica::sql_error(error))
        };
    }
    // The normal query owner still applies its function allowlist, readonly
    // flag, SQL-tail check, cell and output budgets on this empty replica.
    let path = std::env::temp_dir().join(format!("support-constant-{}.db", uuid::Uuid::new_v4()));
    drop(rusqlite::Connection::open(&path).map_err(replica::sql_error)?);
    let r = Replica {
        path,
        taken_at: chrono::Utc::now().to_rfc3339(),
        schema: json!([]),
    };
    query(&r, input, permit).map(Some)
}
// The engine authorizer and readonly flag remain the security boundary. This
// lexical pass additionally rejects a nonempty SQL tail without extra_check.
pub fn single_read(sql: &str) -> bool {
    if sql.is_empty() || sql.len() > 4000 || sql.contains('\0') {
        return false;
    }
    let upper = sql.trim_start().to_ascii_uppercase();
    let first = upper
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>();
    if !matches!(first.as_str(), "SELECT" | "WITH") && !upper.starts_with("EXPLAIN QUERY PLAN ") {
        return false;
    }
    let mut chars = sql.chars().peekable();
    let mut quote = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                if chars.peek() == Some(&q) {
                    chars.next();
                } else {
                    quote = None;
                }
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => quote = Some(c),
            '[' => quote = Some(']'),
            '-' if chars.peek() == Some(&'-') => {
                chars.next();
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for c in chars.by_ref() {
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            ';' => return chars.all(char::is_whitespace),
            _ => (),
        }
    }
    quote.is_none()
}
/// Ask SQLite itself for the consumed SQL boundary. The lexical screen above
/// is only a fast reject; it must never be trusted to emulate SQLite quoting.
fn prepared_read_with_empty_tail(conn: &rusqlite::Connection, sql: &str) -> Result<(), String> {
    let sql = std::ffi::CString::new(sql).map_err(|_| "POLICY_REFUSED")?;
    let mut statement = std::ptr::null_mut();
    let mut tail = std::ptr::null();
    // The connection and CString stay alive on this worker; SQLite returns
    // tail into that CString and owns statement until its immediate finalize.
    let code = unsafe {
        rusqlite::ffi::sqlite3_prepare_v2(
            conn.handle(),
            sql.as_ptr(),
            -1,
            &mut statement,
            &mut tail,
        )
    };
    let valid = if code == rusqlite::ffi::SQLITE_OK && !statement.is_null() {
        let readonly = unsafe { rusqlite::ffi::sqlite3_stmt_readonly(statement) != 0 };
        let empty = tail.is_null()
            || unsafe { std::ffi::CStr::from_ptr(tail) }
                .to_bytes()
                .iter()
                .all(u8::is_ascii_whitespace);
        readonly && empty
    } else {
        false
    };
    if !statement.is_null() {
        unsafe { rusqlite::ffi::sqlite3_finalize(statement) };
    }
    if code == rusqlite::ffi::SQLITE_INTERRUPT {
        return Err("QUERY_TIMEOUT".into());
    }
    if valid {
        Ok(())
    } else {
        Err("POLICY_REFUSED".into())
    }
}
pub fn query(replica: &Replica, input: &Value, permit: &SupportPermit) -> Result<Value, String> {
    let sql = input["sql"].as_str().ok_or("INVALID_INPUT")?;
    if !single_read(sql) {
        return Err("POLICY_REFUSED".into());
    }
    let max = input["max_rows"].as_u64().unwrap_or(200);
    if !(1..=200).contains(&max) {
        return Err("INVALID_INPUT".into());
    }
    let start = Instant::now();
    let conn = replica::query_connection(replica, permit, start + Duration::from_secs(5))?;
    drop(conn.prepare(sql).map_err(replica::sql_error)?);
    prepared_read_with_empty_tail(&conn, sql)?;
    let mut stmt = conn.prepare(sql).map_err(replica::sql_error)?;
    if !stmt.readonly() {
        return Err("POLICY_REFUSED".into());
    }
    let columns = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut cursor = stmt.query([]).map_err(replica::sql_error)?;
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut cells = false;
    let mut bytes = false;
    let mut more = false;
    let mut size = 0;
    while let Some(row) = cursor.next().map_err(replica::sql_error)? {
        if rows.len() >= max as usize {
            more = true;
            break;
        }
        let mut values = Vec::new();
        for i in 0..columns.len() {
            use rusqlite::types::ValueRef;
            let value = match row.get_ref(i).map_err(replica::sql_error)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(s) => {
                    let s = String::from_utf8_lossy(s);
                    cells |= s.chars().count() > 1024;
                    super::evidence::Policy {
                        personal: super::evidence::personal(input)?,
                        ..Default::default()
                    }
                    .text(&s)
                }
                ValueRef::Blob(_) => redaction::text(redaction::MARKER),
            };
            values.push(value);
        }
        size += serde_json::to_vec(&values)
            .map_err(|_| "INTERNAL_ERROR")?
            .len();
        if size > 240 * 1024 {
            bytes = true;
            break;
        }
        rows.push(values);
    }
    Ok(
        json!({"database":"main","replica_taken_at":replica.taken_at,"columns":columns,"row_count":rows.len(),"rows":rows,"elapsed_ms":start.elapsed().as_millis(),"truncation":{"rows":more,"cells":cells,"bytes":bytes}}),
    )
}
