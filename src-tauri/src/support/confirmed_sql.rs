//! Bound scratch/live SQL. Authority is native, inventories are engine-derived.
use super::{
    authorizer, clock,
    contracts::{self, Command},
    critical_op::SupportPermit,
    dry_run::{self, Stored, Target},
    guards::{self, Scope},
    snapshot,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn proposal(c: &Command) -> &Value {
    &c.payload["proposal"]
}
pub fn params_of(p: &Value) -> Result<Vec<rusqlite::types::Value>, String> {
    let a = p["params"]
        .as_array()
        .filter(|a| a.len() <= 50)
        .ok_or("INVALID_INPUT")?;
    a.iter()
        .map(|v| match v {
            Value::Null => Ok(rusqlite::types::Value::Null),
            Value::String(s)
                if s.chars().count() <= 1024
                    && crate::diagnostics::scrub_and_bound_text(s, 1024) == *s =>
            {
                Ok(rusqlite::types::Value::Text(s.clone()))
            }
            Value::Number(n) if super::redaction::scrub_pan(&n.to_string()) == n.to_string() => n
                .as_i64()
                .map(rusqlite::types::Value::Integer)
                .or_else(|| {
                    n.as_f64()
                        .filter(|v| v.is_finite())
                        .map(rusqlite::types::Value::Real)
                })
                .ok_or("INVALID_INPUT".into()),
            _ => Err("POLICY_REFUSED".into()),
        })
        .collect()
}
/// A lexical deny screen supplements SQLite's single-statement preparation.
/// Quoted data is skipped; no subqueries, conflict clauses or computed authority.
fn screen(sql: &str) -> Result<(), String> {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut words = Vec::new();
    while i < b.len() {
        if [b'\'', b'"', b'`', b'['].contains(&b[i]) {
            let q = if b[i] == b'[' { b']' } else { b[i] };
            i += 1;
            loop {
                if i >= b.len() {
                    return Err("INVALID_INPUT".into());
                }
                if b[i] == q {
                    i += 1;
                    if b.get(i) == Some(&q) {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
        } else if b.get(i..i + 2) == Some(b"--") || b.get(i..i + 2) == Some(b"/*") {
            return Err("POLICY_REFUSED".into());
        } else if b[i].is_ascii_alphabetic() || b[i] == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1
            }
            words.push(sql[start..i].to_ascii_uppercase());
        } else {
            i += 1;
        }
    }
    if words.first().is_some_and(|word| word == "UPDATE") && words.iter().any(|word| word == "FROM")
    {
        return Err("POLICY_REFUSED".into());
    }
    if words.get(1).is_some_and(|word| word == "OR")
        || !words
            .first()
            .is_some_and(|w| ["UPDATE", "DELETE", "INSERT"].contains(&w.as_str()))
        || words.iter().any(|w| {
            [
                "SELECT",
                "WITH",
                "CONFLICT",
                "REPLACE",
                "RETURNING",
                "PRAGMA",
                "ATTACH",
                "DETACH",
                "TRIGGER",
            ]
            .contains(&w.as_str())
        })
    {
        return Err("POLICY_REFUSED".into());
    }
    Ok(())
}

fn scoped(row: &Value, scope: &Scope) -> Result<(), String> {
    for (k, v) in [
        ("organization_id", &scope.organization_id),
        ("branch_id", &scope.branch_id),
        ("terminal_id", &scope.terminal_id),
    ] {
        if row.get(k).is_some_and(|r| r != v) {
            return Err("PROTECTED_RECORD".into());
        }
    }
    Ok(())
}
fn order_scope(c: &Connection, id: &str, scope: &Scope) -> Result<Value, String> {
    let row = guards::rows(
        c,
        "SELECT * FROM orders WHERE id=?",
        &[id.to_string().into()],
    )?
    .into_iter()
    .next()
    .ok_or("PROTECTED_RECORD")?;
    scoped(&row, scope)?;
    if row["order_context"]
        .as_str()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("repair_settlement"))
    {
        return Err("PROTECTED_RECORD".into());
    }
    if row["branch_id"] != scope.branch_id || row["terminal_id"] != scope.terminal_id {
        return Err("PROTECTED_RECORD".into());
    }
    Ok(row)
}
/// Unknown/missing fiscal or Z evidence refuses; confirmation cannot erase it.
pub fn no_submitted_close(c: &Connection, shift: &str) -> Result<(), String> {
    let since: String = c
        .query_row(
            "SELECT check_in_time FROM staff_shifts WHERE id=?",
            [shift],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    if chrono::DateTime::parse_from_rfc3339(&since).is_err() {
        return Err("PROTECTED_RECORD".into());
    }
    let closed: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM z_reports WHERE julianday(generated_at)>=julianday(?))",
            [since],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    if closed {
        return Err("PROTECTED_RECORD".into());
    }
    Ok(())
}
pub fn protected_links(
    c: &Connection,
    order: Option<&Value>,
    shift: Option<&str>,
) -> Result<(), String> {
    let schema = guards::schema(c)?;
    let has = |t: &str, k: &str| {
        schema
            .iter()
            .any(|v| v.name == t && v.columns.iter().any(|v| v == k))
    };
    if !has("z_reports", "generated_at") {
        return Err("PROTECTED_RECORD".into());
    }
    let since = order
        .and_then(|r| r["created_at"].as_str())
        .or_else(|| None);
    let since = match (since, shift) {
        (Some(s), _) => s.to_string(),
        (_, Some(id)) => c
            .query_row(
                "SELECT check_in_time FROM staff_shifts WHERE id=?",
                [id],
                |r| r.get::<_, String>(0),
            )
            .map_err(guards::error)?,
        _ => return Err("PROTECTED_RECORD".into()),
    };
    let z: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM z_reports WHERE julianday(generated_at)>=julianday(?))",
            [&since],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    if z || chrono::DateTime::parse_from_rfc3339(&since).is_err() {
        return Err("PROTECTED_RECORD".into());
    }
    let orders = if let Some(order) = order {
        vec![order.clone()]
    } else {
        guards::rows(
            c,
            "SELECT * FROM orders WHERE staff_shift_id=?",
            &[shift.ok_or("PROTECTED_RECORD")?.to_string().into()],
        )?
    };
    for o in orders {
        let id = o["id"].as_str().ok_or("PROTECTED_RECORD")?;
        if !has("ecr_transactions", "order_id") || !has("ecr_transactions", "fiscal_receipt_number")
        {
            return Err("PROTECTED_RECORD".into());
        }
        let f:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM ecr_transactions WHERE order_id=? AND COALESCE(fiscal_receipt_number,'')<>'')",[id],|r|r.get(0)).map_err(guards::error)?;
        let gift_key = if has("gift_card_fiscal_operations", "local_order_id") {
            "local_order_id"
        } else if has("gift_card_fiscal_operations", "order_id") {
            "order_id"
        } else {
            return Err("PROTECTED_RECORD".into());
        };
        let gift: bool = c
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM gift_card_fiscal_operations WHERE {gift_key}=?)"
                ),
                [id],
                |r| r.get(0),
            )
            .map_err(guards::error)?;
        let fiscal:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE record_id=? AND module_type='fiscal')",[id],|r|r.get(0)).map_err(guards::error)?;
        if f || gift || fiscal {
            return Err("PROTECTED_RECORD".into());
        }
    }
    Ok(())
}

fn operational(row: &Value) -> bool {
    let Some(key) = row["setting_key"]
        .as_str()
        .and_then(|s| s.strip_prefix("printer_last_known_brand:"))
    else {
        return false;
    };
    row["setting_category"] == "local"
        && !key.is_empty()
        && key.len() <= 253
        && key
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
pub fn row_allowed(c: &Connection, t: &Target, p: &Value, scope: &Scope) -> Result<(), String> {
    let before = t.before.as_ref().ok_or("PROTECTED_RECORD")?;
    let after = t.after.as_ref();
    let policy = authorizer::write_policy(&t.table, true);
    scoped(before, scope)?;
    if let Some(after) = after {
        scoped(after, scope)?;
        for (key, value) in before.as_object().ok_or("PROTECTED_RECORD")? {
            if value != &after[key]
                && !policy["update"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|k| k == key))
            {
                return Err("PROTECTED_RECORD".into());
            }
        }
    } else if policy["delete"] != "operational_key" {
        return Err("PROTECTED_RECORD".into());
    }
    match policy["row_rule"].as_str() {
        Some("confirmed_payment_sync") => {
            let order = order_scope(
                c,
                before["order_id"].as_str().ok_or("PROTECTED_RECORD")?,
                scope,
            )?;
            protected_links(c, Some(&order), None)?;
        }
        Some("confirmed_queue") => {
            if before["organization_id"] != scope.organization_id
                || ["processing", "in_flight", "conflict"]
                    .contains(&before["status"].as_str().unwrap_or(""))
                || before["module_type"].as_str().is_some_and(|m| {
                    let m = m.to_ascii_lowercase();
                    [
                        "fiscal",
                        "refund",
                        "z_report",
                        "z_submission",
                        "credential",
                        "audit",
                        "support",
                    ]
                    .iter()
                    .any(|word| m.contains(word))
                })
            {
                return Err("PROTECTED_RECORD".into());
            }
            let table = before["table_name"].as_str().ok_or("PROTECTED_RECORD")?;
            if ![
                "orders",
                "order_payments",
                "staff_shifts",
                "cash_drawer_sessions",
            ]
            .contains(&table)
            {
                guards::eligible(c, &t.table, before, scope)?;
            } else {
                let data: Value =
                    serde_json::from_str(before["data"].as_str().ok_or("PROTECTED_RECORD")?)
                        .map_err(|_| "PROTECTED_RECORD")?;
                for (key, expected) in [
                    ("organization_id", &scope.organization_id),
                    ("branch_id", &scope.branch_id),
                    ("branchId", &scope.branch_id),
                    ("terminal_id", &scope.terminal_id),
                    ("terminalId", &scope.terminal_id),
                ] {
                    if data.get(key).is_some_and(|value| value != expected) {
                        return Err("PROTECTED_RECORD".into());
                    }
                }
                if ["staff_shifts", "cash_drawer_sessions"].contains(&table) {
                    let record = guards::rows(
                        c,
                        &format!("SELECT * FROM {} WHERE id=?", super::replica::quote(table)),
                        &[before["record_id"]
                            .as_str()
                            .ok_or("PROTECTED_RECORD")?
                            .to_string()
                            .into()],
                    )?
                    .into_iter()
                    .next()
                    .ok_or("PROTECTED_RECORD")?;
                    scoped(&record, scope)?;
                    let shift_id = if table == "staff_shifts" {
                        record["id"].as_str()
                    } else {
                        record["staff_shift_id"].as_str()
                    }
                    .ok_or("PROTECTED_RECORD")?;
                    let shift = guards::rows(
                        c,
                        "SELECT * FROM staff_shifts WHERE id=?",
                        &[shift_id.to_string().into()],
                    )?
                    .into_iter()
                    .next()
                    .ok_or("PROTECTED_RECORD")?;
                    if shift["branch_id"] != scope.branch_id
                        || shift["terminal_id"] != scope.terminal_id
                    {
                        return Err("PROTECTED_RECORD".into());
                    }
                    protected_links(c, None, Some(shift_id))?;
                } else {
                    let order_id = if table == "orders" {
                        before["record_id"].as_str()
                    } else {
                        data["orderId"].as_str().or(data["order_id"].as_str())
                    };
                    if let Some(id) = order_id {
                        protected_links(c, Some(&order_scope(c, id, scope)?), None)?;
                    } else {
                        return Err("PROTECTED_RECORD".into());
                    }
                }
            }
        }
        Some("confirmed_shift") => {
            let after = after.ok_or("PROTECTED_RECORD")?;
            let id = before["id"].as_str().ok_or("PROTECTED_RECORD")?;
            if before["branch_id"] != scope.branch_id
                || before["terminal_id"] != scope.terminal_id
                || crate::shifts::gift_opening_key_for_shift(c, id)?.is_some()
                || before["status"] != "active"
                || after["status"] != "closed"
                || after["check_out_time"]
                    .as_str()
                    .and_then(|v| clock::parse(v).ok())
                    .is_none_or(|at| at > chrono::Utc::now().timestamp_millis())
            {
                return Err("PROTECTED_RECORD".into());
            }
            protected_links(c, None, Some(id))?;
            // The ordinary owner must prepare financial/gift/transfer closes.
            // SQL accepts the provable zero-float kitchen case only.
            let drawer: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM cash_drawer_sessions WHERE staff_shift_id=?)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(guards::error)?;
            if drawer
                || !crate::shifts::is_non_financial_shift_role(
                    before["role_type"].as_str().unwrap_or(""),
                )
                || before["opening_cash_amount_cents"].as_i64().unwrap_or(1) != 0
                || after["closing_cash_amount_cents"].as_i64() != Some(0)
            {
                return Err("PROTECTED_RECORD".into());
            }
        }
        Some("confirmed_drawer") => {
            let after = after.ok_or("PROTECTED_RECORD")?;
            let counts = &p["counted_closing"];
            let shift_id = before["staff_shift_id"]
                .as_str()
                .ok_or("PROTECTED_RECORD")?;
            let shift = guards::rows(
                c,
                "SELECT * FROM staff_shifts WHERE id=?",
                &[shift_id.to_string().into()],
            )?
            .into_iter()
            .next()
            .ok_or("PROTECTED_RECORD")?;
            if before["id"] != counts["drawer_session_id"]
                || counts["shift_id"] != shift_id
                || counts["closing_card_cents"] != 0
                || counts["closing_other_cents"] != 0
                || !before["closed_at"].is_null()
                || after["closed_at"]
                    .as_str()
                    .and_then(|s| clock::parse(s).ok())
                    .is_none_or(|at| at > chrono::Utc::now().timestamp_millis())
                || after["closing_amount_cents"] != counts["closing_cash_cents"]
                || after["closing_amount_cents"].as_i64().is_none_or(|n| n < 0)
                || shift["branch_id"] != scope.branch_id
                || shift["terminal_id"] != scope.terminal_id
                || !["cashier", "manager"].contains(&shift["role_type"].as_str().unwrap_or(""))
                || crate::shifts::gift_opening_key_for_shift(c, shift_id)?.is_some()
            {
                return Err("PROTECTED_RECORD".into());
            }
            protected_links(c, None, Some(shift_id))?;
            let transfers:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM staff_shifts WHERE branch_id=? AND terminal_id=? AND status='active' AND role_type IN ('driver','server'))",params![scope.branch_id,scope.terminal_id],|r|r.get(0)).map_err(guards::error)?;
            if transfers {
                return Err("PROTECTED_RECORD".into());
            }
        }
        Some("operational_key") => {
            if !operational(before) || after.is_some_and(|r| !operational(r)) {
                return Err("PROTECTED_RECORD".into());
            }
        }
        _ => {
            if t.table == "orders" && before["sync_status"] == "synced" {
                return Err("PROTECTED_RECORD".into());
            }
            guards::eligible(c, &t.table, before, scope)?;
        }
    }
    if let Some(after) = after {
        for (decimal, cents) in [
            ("subtotal", "subtotal_cents"),
            ("tax_amount", "tax_amount_cents"),
            ("total_amount", "total_amount_cents"),
            ("discount_amount", "discount_amount_cents"),
            ("closing_cash_amount", "closing_cash_amount_cents"),
            ("closing_amount", "closing_amount_cents"),
        ] {
            if before.get(decimal).is_some()
                && before.get(cents).is_some()
                && (before[decimal] != after[decimal] || before[cents] != after[cents])
            {
                if (before[decimal] != after[decimal]) != (before[cents] != after[cents])
                    || after[decimal]
                        .as_f64()
                        .zip(after[cents].as_i64())
                        .is_none_or(|(d, n)| !d.is_finite() || (d * 100.0).round() != n as f64)
                {
                    return Err("PROTECTED_RECORD".into());
                }
            }
        }
        for key in ["status", "sync_status", "sync_state"] {
            if before[key] != after[key]
                && policy["row_rule"]
                    .as_str()
                    .is_some_and(|s| ["confirmed_queue", "confirmed_payment_sync"].contains(&s))
                && ![
                    "pending",
                    "failed",
                    "retryable",
                    "ready",
                    "due",
                    "waiting_parent",
                    "waiting_order",
                ]
                .contains(&after[key].as_str().unwrap_or(""))
            {
                return Err("PROTECTED_RECORD".into());
            }
        }
    }
    Ok(())
}

fn connect(path: &Path) -> Result<(Connection, std::sync::Arc<authorizer::Policy>), String> {
    let c = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(guards::error)?;
    c.busy_timeout(Duration::from_millis(100))
        .map_err(guards::error)?;
    c.execute_batch("PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;CREATE TEMP TABLE support_guard_mode(mode TEXT);INSERT INTO support_guard_mode VALUES('sql');").map_err(guards::error)?;
    c.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(guards::error)?;
    unsafe {
        rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, 262144);
        rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_SQL_LENGTH, 8000);
        rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_EXPR_DEPTH, 100);
        rusqlite::ffi::sqlite3_limit(c.handle(), rusqlite::ffi::SQLITE_LIMIT_VARIABLE_NUMBER, 50);
        if rusqlite::ffi::sqlite3_db_config(
            c.handle(),
            rusqlite::ffi::SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
            0,
            std::ptr::null_mut::<i32>(),
        ) != rusqlite::ffi::SQLITE_OK
        {
            return Err("POLICY_REFUSED".into());
        }
    }

    let tables = guards::schema(&c)?.into_iter().map(|t| t.name).collect();
    let accessors = guards::rows(
        &c,
        "SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')",
        &[],
    )?
    .into_iter()
    .filter_map(|r| r["name"].as_str().map(str::to_string))
    .collect();
    let policy = authorizer::install_confirmed(&c, tables, accessors);
    Ok((c, policy))
}
fn no_implicit_effects(c: &Connection, facts: &authorizer::Facts) -> Result<(), String> {
    let schema = guards::schema(c)?;
    for (table, columns) in &facts.writes {
        // SQLite preparation invokes the authorizer for active trigger bodies.
        // install_confirmed refuses every persistent accessor. Dormant guards
        // (for example UPDATE OF currency) cannot create an implicit effect.
        for child in &schema {
            for fk in guards::rows(
                c,
                &format!(
                    "PRAGMA foreign_key_list({})",
                    super::replica::quote(&child.name)
                ),
                &[],
            )? {
                if fk["table"] != *table {
                    continue;
                }
                let action = if columns.is_empty() {
                    "on_delete"
                } else {
                    "on_update"
                };
                let referenced = fk["to"]
                    .as_str()
                    .map(|col| columns.contains(col))
                    .unwrap_or_else(|| {
                        schema
                            .iter()
                            .find(|t| t.name == *table)
                            .is_none_or(|t| t.pk.iter().any(|k| columns.contains(k)))
                    });
                if (columns.is_empty() || referenced)
                    && ["CASCADE", "SET NULL", "SET DEFAULT"].contains(
                        &fk[action]
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
    }
    Ok(())
}
fn perform(
    c: &Connection,
    policy: &authorizer::Policy,
    p: &Value,
    scope: &Scope,
) -> Result<(Vec<Target>, authorizer::Facts), String> {
    let sql = p["sql"].as_str().ok_or("INVALID_INPUT")?;
    screen(sql)?;
    let bindings = params_of(p)?;
    let facts = authorizer::inspect(c, policy, sql)?;
    let _native = authorizer::native_scope(policy);
    for columns in facts.writes.values() {
        for (decimal, cents) in [
            ("subtotal", "subtotal_cents"),
            ("tax_amount", "tax_amount_cents"),
            ("total_amount", "total_amount_cents"),
            ("discount_amount", "discount_amount_cents"),
            ("closing_cash_amount", "closing_cash_amount_cents"),
            ("closing_amount", "closing_amount_cents"),
        ] {
            if columns.contains(decimal) != columns.contains(cents) {
                return Err("PROTECTED_RECORD".into());
            }
        }
    }
    if facts.writes.len() != 1 || facts.reads.keys().any(|t| !facts.writes.contains_key(t)) {
        return Err("POLICY_REFUSED".into());
    }
    no_implicit_effects(c, &facts)?;
    let before = dry_run::capture(c, facts.writes.keys().cloned())?;
    let n = authorizer::payload_bound(c, policy, sql, &bindings)?;
    let targets = dry_run::changed(c, &before)?;
    if targets.len() != n || targets.len() as u64 > p["rows_cap"].as_u64().ok_or("INVALID_INPUT")? {
        return Err("PAYLOAD_DRIFT".into());
    }
    for t in &targets {
        row_allowed(c, t, p, scope)?;
    }
    Ok((targets, facts))
}
pub fn dry(
    store: &Connection,
    live: &Path,
    c: &Command,
    scope: &Scope,
    now: i64,
    permit: &SupportPermit,
) -> Result<Value, String> {
    let p = proposal(c);
    if p["database"] != "main" {
        return Err("UNSUPPORTED_ON_PLATFORM".into());
    }
    let scratch = dry_run::scratch(live, permit)?;
    let (db, policy) = connect(&scratch.0)?;
    let _native = authorizer::native_scope(&policy);
    let start = Instant::now();
    permit.guard_connection(&db, start + Duration::from_millis(100));
    let tx = crate::db::immediate_transaction(&db).map_err(guards::error)?;
    let (targets, facts) = perform(&db, &policy, p, scope)?;
    let mut record = dry_run::result(
        p,
        targets,
        &c.session_id,
        now,
        p["rows_cap"].as_u64().ok_or("INVALID_INPUT")?,
        start.elapsed().as_millis(),
        Some(&facts),
    )?;
    record.result["payload_sha256"] = json!(super::confirmed_hash::hash(p));
    counts_match(&record, p)?;
    db.progress_handler(0, None::<fn() -> bool>);
    drop(tx);
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    dry_run::save(store, &record, &c.command_id, now)?;
    Ok(json!({"step":"sql_dry_run","kind":"untrusted_till_data","dry_run":record.result}))
}
fn counts_match(r: &Stored, p: &Value) -> Result<(), String> {
    let mut expected = p["expected_rows"]
        .as_array()
        .ok_or("INVALID_INPUT")?
        .clone();
    expected.sort_by_key(|r| r["table"].to_string());
    if r.result["rows_affected"] != json!(expected) {
        return Err("PAYLOAD_DRIFT".into());
    }
    Ok(())
}
pub fn execute(
    store: &Connection,
    live: &Path,
    c: &Command,
    scope: &Scope,
    now: i64,
    permit: &SupportPermit,
    snap: &snapshot::Snapshot,
    recheck: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let invoked = Instant::now();
    let p = proposal(c);
    let binding = &c.payload["binding"];
    let record = dry_run::load(
        store,
        binding["dry_run_id"].as_str().ok_or("INVALID_INPUT")?,
    )?;
    let (envelope,result):(String,String)=store.query_row("SELECT envelope_json,result_json FROM support_accepted_commands WHERE command_id=? AND session_id=? AND kind=? AND finished_at IS NOT NULL",params![c.payload["dry_run_command_id"].as_str(),c.session_id,super::confirmed::KIND],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"PAYLOAD_DRIFT")?;
    let source: Command = serde_json::from_str(&envelope).map_err(|_| "PAYLOAD_DRIFT")?;
    let result: Value = serde_json::from_str(&result).map_err(|_| "PAYLOAD_DRIFT")?;
    let mut unhashed = result.clone();
    unhashed
        .as_object_mut()
        .ok_or("PAYLOAD_DRIFT")?
        .remove("result_sha256");
    if result["result_sha256"] != contracts::payload_hash(&unhashed)
        || result["status"] != "completed"
        || result
            .get("truncation")
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    for key in [
        "protected_violations",
        "cascaded_effects",
        "pii_reads_flagged",
    ] {
        if record.result[key].as_array().is_none_or(|a| !a.is_empty()) {
            return Err("POLICY_REFUSED".into());
        }
    }
    if record.result["free_disk_ok"] != true
        || record.result["critical_operation_active"] != false
        || record.result["duration_ms"]
            .as_u64()
            .is_none_or(|n| n > 100)
    {
        return Err("POLICY_REFUSED".into());
    }
    if source.payload["step"] != "sql_dry_run"
        || super::confirmed_hash::hash(&source.payload) != source.payload_sha256
        || source.payload["proposal"] != *p
        || result["result_sha256"] != c.payload["dry_run_result_sha256"]
        || result["data"]["dry_run"] != record.result
        || record.session != c.session_id
        || record.result["payload_sha256"] != super::confirmed_hash::hash(p)
        || binding["proposal_sha256"] != record.result["payload_sha256"]
        || binding["target_key_sha256"] != record.result["target_key_sha256"]
        || binding["expires_at"] != record.result["expires_at"]
        || clock::parse(
            record.result["expires_at"]
                .as_str()
                .ok_or("INVALID_INPUT")?,
        )
        .map_err(str::to_string)?
            <= now
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    counts_match(&record, p)?;
    recheck()?;
    let used=store.execute("UPDATE support_dry_runs SET consumed_at=? WHERE dry_run_id=? AND proposal_id=? AND consumed_at IS NULL",params![clock::iso(now),binding["dry_run_id"].as_str(),source.command_id]).map_err(guards::error)?;
    if used != 1 {
        return Err("INVALID_INPUT".into());
    }

    recheck()?;
    let (db, policy) = connect(live)?;
    let _native = authorizer::native_scope(&policy);
    let start = Instant::now();
    permit.guard_connection(&db, start + Duration::from_millis(250));
    let tx = permit.begin_write(&db)?;
    if snapshot::watermarks_for_write(&db, permit, start + Duration::from_millis(250))? != snap.full
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    for t in &record.targets {
        let current = guards::find(&db, &t.table, &t.pk)?.into_iter().next();
        if current != t.before {
            return Err("PAYLOAD_DRIFT".into());
        }
    }
    let (targets, facts) = perform(&db, &policy, p, scope)?;
    if serde_json::to_value(&targets).map_err(|_| "INTERNAL_ERROR")?
        != serde_json::to_value(&record.targets).map_err(|_| "INTERNAL_ERROR")?
    {
        return Err("PAYLOAD_DRIFT".into());
    }
    recheck()?;
    if clock::parse(
        record.result["expires_at"]
            .as_str()
            .ok_or("INVALID_INPUT")?,
    )
    .map_err(str::to_string)?
        <= now + invoked.elapsed().as_millis() as i64
    {
        return Err("COMMAND_EXPIRED".into());
    }
    let post = snapshot::watermarks_for_write(&db, permit, start + Duration::from_millis(250))?;
    recheck()?;
    if clock::parse(
        record.result["expires_at"]
            .as_str()
            .ok_or("INVALID_INPUT")?,
    )
    .map_err(str::to_string)?
        <= now + invoked.elapsed().as_millis() as i64
    {
        return Err("COMMAND_EXPIRED".into());
    }
    super::breakglass::commit(&db, &policy, permit, &c.command_id, &clock::iso(now), start)?;
    tx.commit().map_err(|_| "OUTCOME_UNKNOWN")?;
    db.progress_handler(0, None::<fn() -> bool>);
    // A fresh post-commit observation is necessary; failures here are unknown.
    let verification = (|| {
        for t in &targets {
            if guards::find(&db, &t.table, &t.pk)?.into_iter().next() != t.after {
                return Err("OUTCOME_UNKNOWN".into());
            }
        }
        super::confirmed::save_post(store, &snap.id, &post)
    })();
    if verification.is_err() {
        return Err("OUTCOME_UNKNOWN".into());
    }
    let pending = facts.writes.keys().any(|t| t != "local_settings");
    Ok(
        json!({"step":"sql_execute","kind":"untrusted_till_data","outcome":if pending{"pending"}else{"resolved"},"observation_time":clock::iso(now+invoked.elapsed().as_millis() as i64),"snapshot_id":snap.id,"snapshot":snapshot::metadata(store,&snap.id).map_err(|_|"OUTCOME_UNKNOWN")?,"affected_ids":targets.iter().map(|t|contracts::payload_hash(&t.pk)).collect::<Vec<_>>(),"changed_rows":targets.len(),"verification":{"fresh":true,"matches_expected":true,"sync":if pending{"pending"}else{"not_applicable"}},"evidence":{"kind":"sql","dry_run_id":binding["dry_run_id"],"target_key_before_sha256":dry_run::target_hash(&targets),"target_key_after_sha256":dry_run::target_hash(&targets),"counts":record.result["rows_affected"]},"undo":{"kind":"snapshot","reference":snap.id,"reason":null}}),
    )
}
