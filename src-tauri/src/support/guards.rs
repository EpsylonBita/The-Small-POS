//! Connection-local TEMP guards. Never install on an app-owned connection.
use super::{
    authorizer::{self, Policy},
    contracts,
    replica::quote,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{
    config::DbConfig,
    types::{Value as SqlValue, ValueRef},
    Connection, OpenFlags,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Scope {
    pub organization_id: String,
    pub branch_id: String,
    pub terminal_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Table {
    pub name: String,
    pub columns: Vec<String>,
    pub pk: Vec<String>,
    pub sql: String,
}
pub fn error(e: rusqlite::Error) -> String {
    if e.to_string().contains("PROTECTED_RECORD") {
        return "PROTECTED_RECORD".into();
    }
    match e.sqlite_error_code() {
        Some(rusqlite::ErrorCode::OperationInterrupted) => "QUERY_TIMEOUT",
        Some(rusqlite::ErrorCode::DatabaseBusy) | Some(rusqlite::ErrorCode::DatabaseLocked) => {
            "PREEMPTED_BY_CRITICAL_OPERATION"
        }
        _ => "POLICY_REFUSED",
    }
    .into()
}
pub fn policy(table: &str) -> &'static Value {
    &contracts::shared().write_policy["tables"]["windows"]["pos.db"][table]
}
pub fn schema(c: &Connection) -> Result<Vec<Table>, String> {
    let mut stmt=c.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map_err(error)?;
    let names = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(error)?;
    names
        .into_iter()
        .map(|(name, sql)| {
            let mut s = c
                .prepare(&format!("PRAGMA table_info({})", quote(&name)))
                .map_err(error)?;
            let cols = s
                .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(5)?)))
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?;
            let mut pk = cols
                .iter()
                .filter(|(_, p)| *p > 0)
                .cloned()
                .collect::<Vec<_>>();
            pk.sort_by_key(|(_, p)| *p);
            Ok(Table {
                name,
                sql,
                columns: cols.into_iter().map(|(n, _)| n).collect(),
                pk: pk.into_iter().map(|(n, _)| n).collect(),
            })
        })
        .collect()
}
fn lit(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}
fn list(v: &Value) -> String {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(lit)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}
fn order_predicate(s: &[Table], r: &str) -> String {
    let has = |t: &str, c: &str| {
        s.iter()
            .any(|v| v.name == t && v.columns.iter().any(|v| v == c))
    };
    let gift = if has("gift_card_fiscal_operations", "local_order_id") {
        "local_order_id"
    } else {
        "order_id"
    };
    if ![
        ("order_payments", "order_id"),
        ("ecr_transactions", "fiscal_receipt_number"),
        ("ecr_transactions", "order_id"),
        ("gift_card_fiscal_operations", gift),
        ("parity_sync_queue", "module_type"),
        ("parity_sync_queue", "record_id"),
        ("orders", "staff_shift_id"),
        ("staff_shifts", "status"),
        ("orders", "created_at"),
    ]
    .iter()
    .all(|(t, c)| has(t, c))
    {
        return "0".into();
    }
    let z = if has("z_reports", "window_cutoff") && has("z_reports", "generated_at") {
        format!("NOT EXISTS(SELECT 1 FROM z_reports z WHERE {r}.created_at<=COALESCE(z.window_cutoff,z.generated_at))")
    } else if has("z_reports", "period_start") && has("z_reports", "period_end") {
        format!("NOT EXISTS(SELECT 1 FROM z_reports z WHERE {r}.created_at BETWEEN z.period_start AND z.period_end)")
    } else {
        return "0".into();
    };
    let refs = ["id", "supabase_id", "client_request_id"]
        .into_iter()
        .filter(|key| has("orders", key))
        .map(|key| format!("f.order_id={r}.{key}"))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!("{r}.created_at IS NOT NULL AND {r}.sync_status IS NOT NULL AND {r}.sync_status<>'synced' AND NOT EXISTS(SELECT 1 FROM order_payments p WHERE p.order_id={r}.id) AND NOT EXISTS(SELECT 1 FROM ecr_transactions f WHERE ({refs}) AND f.fiscal_receipt_number IS NOT NULL AND f.fiscal_receipt_number<>'') AND NOT EXISTS(SELECT 1 FROM gift_card_fiscal_operations f WHERE f.{gift}={r}.id) AND NOT EXISTS(SELECT 1 FROM parity_sync_queue f WHERE f.record_id={r}.id AND f.module_type='fiscal') AND NOT EXISTS(SELECT 1 FROM staff_shifts s WHERE s.id={r}.staff_shift_id AND (s.status IS NULL OR s.status NOT IN ('active','open'))) AND {z}")
}
pub fn predicate(s: &[Table], t: &Table, r: &str, scope: &Scope) -> String {
    let p = policy(&t.name);
    if p.is_null() {
        return "0".into();
    }
    let mut checks = Vec::new();
    for (key, value) in [
        ("organization_id", &scope.organization_id),
        ("branch_id", &scope.branch_id),
        ("terminal_id", &scope.terminal_id),
    ] {
        if t.columns.iter().any(|c| c == key) {
            checks.push(format!("{r}.{} IS {}", quote(key), lit(value)));
        }
    }
    match p["row_rule"].as_str(){
        Some("eligible_order")=>checks.push(order_predicate(s,r)),
        Some("non_protected_target")=>{
            if !t.columns.iter().any(|c|c=="table_name") || !t.columns.iter().any(|c|c=="record_id"){return "0".into();}
            checks.push(format!("({r}.table_name IN ({}) OR ({r}.table_name='orders' AND EXISTS(SELECT 1 FROM orders q WHERE q.id={r}.record_id AND ({}))))",list(&contracts::shared().write_policy["non_protected_queue_targets"]),order_predicate(s,"q")));
            if t.columns.iter().any(|c|c=="module_type"){checks.push(format!("({r}.module_type IS NULL OR {r}.module_type IN ({}))",list(&contracts::shared().write_policy["non_protected_queue_modules"])));}
        }
        Some("operational_key")=>checks.push(format!("{r}.setting_category='local' AND substr({r}.setting_key,1,25) COLLATE BINARY='printer_last_known_brand:' AND substr({r}.setting_key,26)<>'' AND substr({r}.setting_key,26) NOT GLOB '*[^A-Za-z0-9._:-]*' AND substr({r}.setting_key,26,1) GLOB '[A-Za-z0-9]' AND length(substr({r}.setting_key,26))<=253")),
        _=>return "0".into(),
    }
    checks
        .into_iter()
        .map(|c| format!("({c})"))
        .collect::<Vec<_>>()
        .join(" AND ")
}
pub fn install(c: &Connection, scope: &Scope) -> Result<Arc<Policy>, String> {
    if [&scope.organization_id, &scope.branch_id, &scope.terminal_id]
        .iter()
        .any(|s| s.is_empty())
    {
        return Err("POLICY_REFUSED".into());
    }
    c.busy_timeout(Duration::from_millis(100)).map_err(error)?;
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")
        .map_err(error)?;
    c.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(error)?;
    // Explicitly disable the C extension API as well as SQL load_extension.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_db_config(
            c.handle(),
            rusqlite::ffi::SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
            0,
            std::ptr::null_mut::<i32>(),
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err("POLICY_REFUSED".into());
    }
    c.execute_batch("CREATE TEMP TABLE support_guard_mode(mode TEXT NOT NULL); INSERT INTO support_guard_mode VALUES('sql');").map_err(error)?;
    let s = schema(c)?;
    let mut triggers = std::collections::BTreeSet::new();
    for t in &s {
        let p = policy(&t.name);
        let old = format!("COALESCE(({}),0)", predicate(&s, t, "OLD", scope));
        let new = format!("COALESCE(({}),0)", predicate(&s, t, "NEW", scope));
        let mut immutable = t
            .columns
            .iter()
            .filter(|col| {
                !p["update"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(col)))
            })
            .map(|col| format!("OLD.{0} IS NOT NEW.{0}", quote(col)))
            .collect::<Vec<_>>();
        if t.name == "orders" {
            for (decimal, cents) in [
                ("subtotal", "subtotal_cents"),
                ("tax_amount", "tax_amount_cents"),
                ("total_amount", "total_amount_cents"),
                ("discount_amount", "discount_amount_cents"),
            ] {
                if t.columns.iter().any(|c| c == decimal) && t.columns.iter().any(|c| c == cents) {
                    immutable.push(format!("((OLD.{decimal} IS NOT NEW.{decimal})<>(OLD.{cents} IS NOT NEW.{cents})) OR typeof(NEW.{decimal}) NOT IN ('integer','real') OR typeof(NEW.{cents})<>'integer' OR NEW.{cents} IS NOT round(NEW.{decimal}*100)"));
                }
            }
        }
        immutable.push("0".into());
        let mode = "(SELECT mode FROM temp.support_guard_mode LIMIT 1)";
        let insert = if t.name == "support_txn_marker" {
            format!("{mode}<>'marker'")
        } else if p["insert"] == "operational_key" {
            format!("NOT ({new})")
        } else {
            format!(
                "NOT ({mode}='restore_group' AND {})",
                if p["quarantine"] == true {
                    new.clone()
                } else {
                    "0".into()
                }
            )
        };
        let update = if p["update"].as_array().is_some_and(|a| !a.is_empty()) {
            format!("NOT ({old}) OR NOT ({new}) OR {}", immutable.join(" OR "))
        } else {
            "1".into()
        };
        let delete = if p["delete"] == "operational_key" {
            format!("NOT ({old})")
        } else {
            format!(
                "NOT ({mode}='quarantine' AND {})",
                if p["quarantine"] == true {
                    old
                } else {
                    "0".into()
                }
            )
        };
        for (op, condition) in [("INSERT", insert), ("UPDATE", update), ("DELETE", delete)] {
            let name = format!("support_guard_{}_{}", t.name, op);
            triggers.insert(name.clone());
            c.execute_batch(&format!("CREATE TEMP TRIGGER {} BEFORE {op} ON main.{} WHEN {condition} BEGIN SELECT RAISE(ABORT,'PROTECTED_RECORD'); END;",quote(&name),quote(&t.name))).map_err(error)?;
        }
    }
    let accessors = rows(
        c,
        "SELECT name FROM sqlite_schema WHERE type IN ('view','trigger')",
        &[],
    )?
    .into_iter()
    .map(|r| {
        r["name"]
            .as_str()
            .map(str::to_string)
            .ok_or("POLICY_REFUSED".to_string())
    })
    .collect::<Result<_, _>>()?;
    // Bound SQLite values before native Rust copies/hashes them under the
    // writer reservation. These limits belong only to this support handle.
    unsafe {
        rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, 262144);
        rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_SQL_LENGTH, 8000);
        rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_EXPR_DEPTH, 100);
    }
    Ok(authorizer::install(
        c,
        triggers,
        s.iter().map(|t| t.name.clone()).collect(),
        accessors,
    ))
}
pub fn no_implicit_effects(
    c: &Connection,
    tables: impl Iterator<Item = String>,
) -> Result<(), String> {
    let tables = tables.collect::<std::collections::BTreeSet<_>>();
    for t in &tables {
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type='trigger' AND tbl_name=?1",
                [t],
                |r| r.get(0),
            )
            .map_err(error)?;
        if count != 0 {
            return Err("POLICY_REFUSED".into());
        }
    }
    for table in schema(c)? {
        for fk in rows(
            c,
            &format!("PRAGMA foreign_key_list({})", quote(&table.name)),
            &[],
        )? {
            if fk["table"].as_str().is_some_and(|t| tables.contains(t))
                && ["CASCADE", "SET NULL", "SET DEFAULT"].contains(
                    &fk["on_delete"]
                        .as_str()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                )
            {
                return Err("PROTECTED_RECORD".into());
            }
        }
    }
    Ok(())
}
pub fn open(path: &Path, scope: &Scope) -> Result<(Connection, Arc<Policy>), String> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(error)?;
    let policy = install(&c, scope)?;
    Ok((c, policy))
}
pub fn mode<T>(
    c: &Connection,
    p: &Policy,
    mode: &str,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    authorizer::internal(p, || {
        c.execute("UPDATE temp.support_guard_mode SET mode=?1", [mode])
    })
    .map_err(error)?;
    let result = f();
    let reset = authorizer::internal(p, || {
        c.execute("UPDATE temp.support_guard_mode SET mode='sql'", [])
    })
    .map_err(error);
    match result {
        Ok(v) => {
            reset?;
            Ok(v)
        }
        Err(e) => Err(e),
    }
}
pub fn marker(c: &Connection, p: &Policy, id: &str, at: &str) -> Result<(), String> {
    mode(c, p, "marker", || {
        authorizer::internal(p, || {
            c.execute(
                "INSERT INTO support_txn_marker VALUES(?1,?2)",
                rusqlite::params![id, at],
            )
        })
        .map_err(error)?;
        Ok(())
    })
}
pub fn rows(c: &Connection, sql: &str, params: &[SqlValue]) -> Result<Vec<Value>, String> {
    let mut s = c.prepare(sql).map_err(error)?;
    let names = s
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut cursor = s.query(rusqlite::params_from_iter(params)).map_err(error)?;
    let mut out = Vec::new();
    while let Some(r) = cursor.next().map_err(error)? {
        let mut row = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            row.insert(
                name.clone(),
                match r.get_ref(i).map_err(error)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(t) => {
                        json!(std::str::from_utf8(t).map_err(|_| "POLICY_REFUSED")?)
                    }
                    ValueRef::Blob(b) => json!({"support_blob_base64":STANDARD.encode(b)}),
                },
            );
        }
        out.push(Value::Object(row));
    }
    Ok(out)
}
pub fn sql_value(v: &Value) -> Result<SqlValue, String> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().ok_or("POLICY_REFUSED")?)
            }
        }
        Value::Object(o) if o.len() == 1 => SqlValue::Blob(
            STANDARD
                .decode(
                    o.get("support_blob_base64")
                        .and_then(Value::as_str)
                        .ok_or("POLICY_REFUSED")?,
                )
                .map_err(|_| "POLICY_REFUSED")?,
        ),
        _ => return Err("POLICY_REFUSED".into()),
    })
}
pub fn key(t: &Table, row: &Value) -> Result<Value, String> {
    if t.pk.is_empty() {
        return Err("POLICY_REFUSED".into());
    }
    Ok(json!(t
        .pk
        .iter()
        .map(|k| (k.clone(), row[k].clone()))
        .collect::<std::collections::BTreeMap<_, _>>()))
}
pub fn find(c: &Connection, table: &str, pk: &Value) -> Result<Vec<Value>, String> {
    let keys = pk
        .as_object()
        .filter(|o| !o.is_empty())
        .ok_or("POLICY_REFUSED")?;
    rows(
        c,
        &format!(
            "SELECT * FROM {} WHERE {}",
            quote(table),
            keys.keys()
                .map(|k| format!("{} IS ?", quote(k)))
                .collect::<Vec<_>>()
                .join(" AND ")
        ),
        &keys
            .values()
            .map(sql_value)
            .collect::<Result<Vec<_>, _>>()?,
    )
}
pub fn eligible(c: &Connection, table: &str, row: &Value, scope: &Scope) -> Result<(), String> {
    let s = schema(c)?;
    let t = s
        .iter()
        .find(|t| t.name == table)
        .ok_or("PROTECTED_RECORD")?;
    let pk = key(t, row)?;
    let keys = pk.as_object().ok_or("PROTECTED_RECORD")?;
    let sql = format!(
        "SELECT 1 FROM {} q WHERE {} AND ({})",
        quote(table),
        keys.keys()
            .map(|k| format!("q.{} IS ?", quote(k)))
            .collect::<Vec<_>>()
            .join(" AND "),
        predicate(&s, t, "q", scope)
    );
    if rows(
        c,
        &sql,
        &keys
            .values()
            .map(sql_value)
            .collect::<Result<Vec<_>, _>>()?,
    )?
    .len()
        != 1
    {
        return Err("PROTECTED_RECORD".into());
    }
    Ok(())
}
