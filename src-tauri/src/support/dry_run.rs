use super::{
    authorizer::{self, Facts, Policy},
    contracts,
    critical_op::SupportPermit,
    guards::{self, Scope},
    replica, snapshot,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Target {
    pub database: String,
    pub table: String,
    pub pk: Value,
    pub before: Option<Value>,
    pub after: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stored {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<Value>>,
    pub result: Value,
    pub targets: Vec<Target>,
    #[serde(rename = "sessionId")]
    pub session: String,
}
pub fn payload_digest(payload: &Value) -> Result<String, String> {
    let mut p = payload.as_object().ok_or("INVALID_INPUT")?.clone();
    p.remove("step");
    Ok(if p.contains_key("params") {
        super::confirmed_hash::hash(&Value::Object(p))
    } else {
        contracts::payload_hash(&Value::Object(p))
    })
}
pub fn target_hash(targets: &[Target]) -> String {
    let mut keys = targets
        .iter()
        .map(|t| json!({"database":t.database,"table":t.table,"pk":t.pk}))
        .collect::<Vec<_>>();
    keys.sort_by_key(Value::to_string);
    contracts::payload_hash(&json!(keys))
}
pub fn result(
    payload: &Value,
    targets: Vec<Target>,
    session: &str,
    now: i64,
    cap: u64,
    duration: u128,
    facts: Option<&Facts>,
) -> Result<Stored, String> {
    if targets.len() as u64 > cap || duration > 100 {
        return Err("POLICY_REFUSED".into());
    }
    let mut counts = BTreeMap::<String, [usize; 3]>::new();
    for t in &targets {
        counts.entry(t.table.clone()).or_default()[if t.before.is_none() {
            0
        } else if t.after.is_none() {
            2
        } else {
            1
        }] += 1;
    }
    let rows = counts
        .iter()
        .map(|(table, n)| json!({"table":table,"inserted":n[0],"updated":n[1],"deleted":n[2]}))
        .collect::<Vec<_>>();
    let samples=counts.keys().map(|table|json!({"table":table,"before":targets.iter().filter(|t|t.table==*table&&t.before.is_some()).take(5).map(|_|json!({"kind":"untrusted_till_data","value":"[REDACTED]"})).collect::<Vec<_>>(),"after":targets.iter().filter(|t|t.table==*table&&t.after.is_some()).take(5).map(|_|json!({"kind":"untrusted_till_data","value":"[REDACTED]"})).collect::<Vec<_>>() })).collect::<Vec<_>>();
    let mut facts = facts.cloned().unwrap_or_default();
    if facts.writes.is_empty() {
        for target in &targets {
            if let Some(row) = target
                .after
                .as_ref()
                .or(target.before.as_ref())
                .and_then(Value::as_object)
            {
                facts
                    .writes
                    .entry(target.table.clone())
                    .or_default()
                    .extend(row.keys().cloned());
            }
        }
    }
    let r = json!({"dry_run_id":uuid::Uuid::new_v4().to_string(),"payload_sha256":payload_digest(payload)?,"target_key_sha256":target_hash(&targets),"expires_at":super::clock::iso(now+600000),"duration_ms":duration,"rows_cap_evaluated":cap,"rows_affected":rows,"write_targets":facts.writes_json(),"reads":facts.reads_json(),"functions":facts.functions,"protected_violations":[],"cascaded_effects":[],"synced_to_server_warning":targets.iter().any(|t|t.before.as_ref().is_some_and(|r|r["sync_status"]=="synced")),"free_disk_ok":true,"critical_operation_active":false,"pii_reads_flagged":facts.pii,"samples":samples});
    Ok(Stored {
        params: payload.get("params").and_then(Value::as_array).cloned(),
        result: r,
        targets,
        session: session.into(),
    })
}
pub fn save(store: &Connection, record: &Stored, proposal: &str, now: i64) -> Result<(), String> {
    let r = &record.result;
    store.execute("INSERT INTO support_dry_runs(dry_run_id,proposal_id,payload_sha256,target_key_sha256,result_json,expires_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![r["dry_run_id"].as_str(),proposal,r["payload_sha256"].as_str(),r["target_key_sha256"].as_str(),serde_json::to_string(record).map_err(|_|"INTERNAL_ERROR")?,r["expires_at"].as_str(),super::clock::iso(now)]).map_err(guards::error)?;
    Ok(())
}
pub fn load(store: &Connection, id: &str) -> Result<Stored, String> {
    let s: String = store
        .query_row(
            "SELECT result_json FROM support_dry_runs WHERE dry_run_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| "APPROVAL_NOT_VERIFIED")?;
    serde_json::from_str(&s).map_err(|_| "APPROVAL_NOT_VERIFIED".into())
}
pub struct Scratch(pub PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}
pub fn scratch(live: &Path, permit: &SupportPermit) -> Result<Scratch, String> {
    snapshot::disk_guard(live)?;
    let dir = live
        .parent()
        .ok_or("SNAPSHOT_FAILED")?
        .join("support-replicas");
    std::fs::create_dir_all(&dir).map_err(|_| "SNAPSHOT_FAILED")?;
    let copy = Scratch(dir.join(format!("dry-{}.db", uuid::Uuid::new_v4())));
    let c = replica::read_connection(live, permit, Instant::now() + Duration::from_secs(30))?;
    c.execute("VACUUM INTO ?1", [copy.0.to_string_lossy().as_ref()])
        .map_err(guards::error)?;
    Ok(copy)
}
pub fn capture(
    c: &Connection,
    tables: impl Iterator<Item = String>,
) -> Result<BTreeMap<String, Vec<Value>>, String> {
    tables
        .map(|t| {
            Ok((
                t.clone(),
                guards::rows(c, &format!("SELECT * FROM {}", replica::quote(&t)), &[])?,
            ))
        })
        .collect()
}
pub fn changed(
    c: &Connection,
    before: &BTreeMap<String, Vec<Value>>,
) -> Result<Vec<Target>, String> {
    let schema = guards::schema(c)?;
    let mut targets = Vec::new();
    for (name, rows) in before {
        let t = schema
            .iter()
            .find(|t| t.name == *name)
            .ok_or("POLICY_REFUSED")?;
        let key = |rows: Vec<Value>| -> Result<BTreeMap<String, Value>, String> {
            rows.into_iter()
                .map(|r| Ok((guards::key(t, &r)?.to_string(), r)))
                .collect()
        };
        let old = key(rows.clone())?;
        let next = key(guards::rows(
            c,
            &format!("SELECT * FROM {}", replica::quote(name)),
            &[],
        )?)?;
        let keys = old
            .keys()
            .chain(next.keys())
            .collect::<std::collections::BTreeSet<_>>();
        for k in keys {
            if old.get(k) != next.get(k) {
                targets.push(Target {
                    database: "main".into(),
                    table: name.clone(),
                    pk: serde_json::from_str(k).map_err(|_| "POLICY_REFUSED")?,
                    before: old.get(k).cloned(),
                    after: next.get(k).cloned(),
                });
            }
        }
    }
    Ok(targets)
}
/// A deliberately narrow grammar only locates the WHERE for the pre-write key
/// proof. The engine authorizer determines all reads, columns and write targets.
pub fn live_targets(
    c: &Connection,
    policy: &Policy,
    sql: &str,
    scope: &Scope,
) -> Result<Vec<Target>, String> {
    live_targets_bound(c, policy, sql, scope, None)
}
pub fn live_targets_bound(
    c: &Connection,
    policy: &Policy,
    original: &str,
    scope: &Scope,
    bindings: Option<&[rusqlite::types::Value]>,
) -> Result<Vec<Target>, String> {
    let numbered;
    let sql = if bindings.is_some() {
        numbered = number_bindings(original)?;
        &numbered
    } else {
        original
    };
    let facts = authorizer::inspect(c, policy, original)?;
    if facts.writes.len() != 1 {
        return Err("POLICY_REFUSED".into());
    }
    let table = facts.writes.keys().next().ok_or("POLICY_REFUSED")?;
    let trimmed = sql.trim_start();
    let upper = trimmed.to_ascii_uppercase();
    let mut end = None;
    for name in [
        table.to_string(),
        replica::quote(table),
        format!("main.{table}"),
        format!("main.{}", replica::quote(table)),
    ] {
        for prefix in [
            format!("UPDATE {name} SET "),
            format!("DELETE FROM {name} "),
        ] {
            if upper.starts_with(&prefix.to_ascii_uppercase()) {
                end = Some(sql.len() - trimmed.len() + prefix.len());
            }
        }
    }
    let end = end.ok_or("POLICY_REFUSED")?;
    let bytes = sql.as_bytes();
    let mut i = end;
    let mut depth = 0i32;
    let mut quote = None;
    let mut where_at = None;
    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            if b == q {
                if bytes.get(i + 1) == Some(&q) {
                    i += 2;
                    continue;
                }
                quote = None;
            }
            i += 1;
            continue;
        }
        if b == b'\'' || b == b'"' || b == b'`' {
            quote = Some(b);
            i += 1;
            continue;
        }
        if b == b'[' {
            quote = Some(b']');
            i += 1;
            continue;
        }
        if bytes.get(i..i + 2) == Some(b"--") || bytes.get(i..i + 2) == Some(b"/*") {
            return Err("POLICY_REFUSED".into());
        }
        if b == b'(' {
            depth += 1;
        }
        if b == b')' {
            depth -= 1;
        }
        if depth == 0
            && b.is_ascii_alphabetic()
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_')
        {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let word = sql[start..i].to_ascii_uppercase();
            if ["RETURNING", "LIMIT", "ORDER"].contains(&word.as_str()) {
                return Err("POLICY_REFUSED".into());
            }
            if word == "WHERE" {
                where_at = Some(i);
            }
            continue;
        }
        i += 1;
    }
    let predicate = where_at
        .map(|i| sql[i..].trim().trim_end_matches(';').trim())
        .unwrap_or("1");
    let schema = guards::schema(c)?;
    let t = schema
        .iter()
        .find(|t| t.name == *table)
        .ok_or("POLICY_REFUSED")?;
    let query = format!(
        "SELECT * FROM {} WHERE ({predicate})",
        replica::quote(table)
    );
    let count = c.prepare(&query).map_err(guards::error)?.parameter_count();
    let selected = if let Some(bindings) = bindings {
        bindings.get(..count).ok_or("INVALID_INPUT")?
    } else {
        &[]
    };
    let found = guards::rows(c, &query, selected)?;
    found
        .into_iter()
        .map(|row| {
            guards::eligible(c, table, &row, scope)?;
            Ok(Target {
                database: "main".into(),
                table: table.clone(),
                pk: guards::key(t, &row)?,
                before: Some(row.clone()),
                after: Some(row),
            })
        })
        .collect()
}
pub fn sql(
    store: &Connection,
    live: &Path,
    session: &str,
    proposal: &str,
    payload: &Value,
    scope: &Scope,
    now: i64,
    permit: &SupportPermit,
) -> Result<Value, String> {
    if payload["database"] != "main" {
        return Err("UNSUPPORTED_ON_PLATFORM".into());
    }
    let scratch = scratch(live, permit)?;
    let (c, policy) = guards::open(&scratch.0, scope)?;
    let native = authorizer::native_scope(&policy);
    let started = Instant::now();
    permit.guard_connection(&c, started + Duration::from_millis(100));
    let sql = payload["sql"].as_str().ok_or("INVALID_INPUT")?;
    let facts = authorizer::inspect(&c, &policy, sql)?;
    // Reads of mixed-identity tables are refused, including reads in subqueries.
    let schema = guards::schema(&c)?;
    for table in facts.writes.keys().chain(facts.reads.keys()) {
        if let Some(t) = schema.iter().find(|t| t.name == *table) {
            for row in guards::rows(&c, &format!("SELECT * FROM {}", replica::quote(table)), &[])? {
                for (key, value) in [
                    ("organization_id", &scope.organization_id),
                    ("branch_id", &scope.branch_id),
                    ("terminal_id", &scope.terminal_id),
                ] {
                    if t.columns.iter().any(|c| c == key) && row[key] != *value {
                        return Err("POLICY_REFUSED".into());
                    }
                }
            }
        }
    }
    let bindings = payload
        .get("params")
        .map(|_| super::confirmed_sql::params_of(payload))
        .transpose()?;
    let expected = if bindings.is_some() {
        live_targets_bound(&c, &policy, sql, scope, bindings.as_deref())?
    } else {
        live_targets(&c, &policy, sql, scope)?
    };
    let before = capture(&c, facts.writes.keys().cloned())?;
    let tx = crate::db::immediate_transaction(&c).map_err(guards::error)?;
    let count = if let Some(bindings) = &bindings {
        authorizer::payload_bound(&c, &policy, sql, bindings)?
    } else {
        authorizer::payload(&c, &policy, sql)?
    };
    let targets = changed(&c, &before)?;
    if count != targets.len() || target_hash(&targets) != target_hash(&expected) {
        return Err("PAYLOAD_DRIFT".into());
    }
    let cap = payload["rows_cap_requested"].as_u64().unwrap_or(50);
    if !(1..=1000).contains(&cap) {
        return Err("INVALID_INPUT".into());
    }
    let record = result(
        payload,
        targets,
        session,
        now,
        cap,
        started.elapsed().as_millis(),
        Some(&facts),
    )?;
    let mut expected_rows = payload["expected_rows"]
        .as_array()
        .ok_or("INVALID_INPUT")?
        .clone();
    expected_rows.sort_by_key(|r| r["table"].to_string());
    if record.result["rows_affected"] != json!(expected_rows) {
        return Err("PAYLOAD_DRIFT".into());
    }
    c.progress_handler(0, None::<fn() -> bool>);
    drop(tx);
    drop(native);
    drop(c);
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    save(store, &record, proposal, now)?;
    Ok(record.result)
}

/// Number only anonymous bindings, keeping quoted question marks untouched.
/// Used solely in native target selection, never in a supplied statement.
fn number_bindings(sql: &str) -> Result<String, String> {
    let b = sql.as_bytes();
    let mut out = String::new();
    let mut last = 0;
    let mut i = 0;
    let mut index = 0;
    while i < b.len() {
        if [b'\'', b'"', b'`', b'['].contains(&b[i]) {
            let q = if b[i] == b'[' { b']' } else { b[i] };
            i += 1;
            while i < b.len() {
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
        } else if b[i] == b'?' {
            if b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                return Err("INVALID_INPUT".into());
            }
            index += 1;
            out.push_str(&sql[last..i]);
            out.push_str(&format!("?{index}"));
            i += 1;
            last = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&sql[last..]);
    Ok(out)
}
