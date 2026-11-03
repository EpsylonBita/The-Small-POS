//! Protected content stays on this short-lived support reader. Only hashes leave.
use super::{
    contracts,
    critical_op::{self, SupportPermit},
    guards::{self, Scope, Table},
    replica,
};
use ring::digest::{Context, SHA256};
use rusqlite::{types::ValueRef, Connection};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    CriticalOperation,
    Deadline,
    ReadFailed,
    ConcurrentOperation,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TableDigest {
    pub rows: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "digest", rename_all = "snake_case")]
pub enum DigestOutcome {
    Available(BTreeMap<String, TableDigest>),
    Unavailable(UnavailableReason),
}

/// The runner supplies the window bound; a digest can never exceed the SQL cap.
/// The scope only controls which explicitly writable rows may be excluded.
/// All other local rows are fingerprinted, including foreign/unknown scope rows;
/// this integrity operation discloses no rows and never confers read authority.
pub fn collect(path: &Path, scope: &Scope, deadline: Instant) -> DigestOutcome {
    collect_checked(path, scope, deadline, || {})
}
#[cfg(test)]
pub(super) fn collect_with_checkpoint(
    path: &Path,
    scope: &Scope,
    deadline: Instant,
    checkpoint: impl FnMut(),
) -> DigestOutcome {
    collect_checked(path, scope, deadline, checkpoint)
}
fn check(permit: &SupportPermit, deadline: Instant) -> Result<(), UnavailableReason> {
    if permit.is_cancelled() {
        Err(UnavailableReason::CriticalOperation)
    } else if Instant::now() >= deadline {
        Err(UnavailableReason::Deadline)
    } else {
        Ok(())
    }
}
fn collect_checked(
    path: &Path,
    scope: &Scope,
    deadline: Instant,
    checkpoint: impl FnMut(),
) -> DigestOutcome {
    let deadline =
        deadline.min(Instant::now() + Duration::from_millis(contracts::cap("tools", "sqlMs")));
    let result = (|| {
        if Instant::now() >= deadline {
            return Err(UnavailableReason::Deadline);
        }
        if [&scope.organization_id, &scope.branch_id, &scope.terminal_id]
            .iter()
            .any(|v| v.is_empty())
            || contracts::shared().write_policy["excluded_databases"]
                .as_array()
                .is_some_and(|a| {
                    a.iter()
                        .any(|v| v.as_str() == path.file_name().and_then(|n| n.to_str()))
                })
        {
            return Err(UnavailableReason::ReadFailed);
        }
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .map_err(|e| {
                if e == "CONCURRENT_OPERATION" {
                    UnavailableReason::ConcurrentOperation
                } else {
                    UnavailableReason::CriticalOperation
                }
            })?;
        let result = (|| {
            check(&permit, deadline)?;
            let conn = replica::read_connection(path, &permit, deadline)
                .map_err(|_| UnavailableReason::ReadFailed)?;
            conn.busy_timeout(Duration::ZERO)
                .map_err(|_| UnavailableReason::ReadFailed)?;
            conn.execute_batch("PRAGMA query_only=ON")
                .map_err(|_| UnavailableReason::ReadFailed)?;
            // A coherent multi-table read must not take rollback-journal locks
            // against checkout. Existing business databases use WAL; never
            // change their mode from support if it is missing or damaged.
            let mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .map_err(|_| UnavailableReason::ReadFailed)?;
            if !mode.eq_ignore_ascii_case("wal") {
                return Err(UnavailableReason::ReadFailed);
            }
            conn.execute_batch("BEGIN DEFERRED")
                .map_err(|_| UnavailableReason::ReadFailed)?;
            let result = digest_tables(&conn, &permit, scope, deadline, checkpoint);
            let _ = conn.execute_batch("ROLLBACK");
            result
        })();
        // A tiny result can finish without SQLite calling the progress hook.
        check(&permit, deadline)?;
        result
    })();
    match result {
        Ok(tables) => DigestOutcome::Available(tables),
        Err(reason) => DigestOutcome::Unavailable(reason),
    }
}
fn frame(hash: &mut Context, tag: u8, bytes: &[u8]) {
    hash.update(&[tag]);
    hash.update(&(bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn value(
    hash: &mut Context,
    v: ValueRef<'_>,
    permit: &SupportPermit,
    deadline: Instant,
) -> Result<(), UnavailableReason> {
    let bytes = match v {
        ValueRef::Null => {
            frame(hash, 0, &[]);
            return check(permit, deadline);
        }
        ValueRef::Integer(v) => {
            frame(hash, 1, &v.to_be_bytes());
            return check(permit, deadline);
        }
        ValueRef::Real(v) => {
            frame(hash, 2, &v.to_bits().to_be_bytes());
            return check(permit, deadline);
        }
        ValueRef::Text(v) => (3, v),
        ValueRef::Blob(v) => (4, v),
    };
    hash.update(&[bytes.0]);
    hash.update(&(bytes.1.len() as u64).to_be_bytes());
    // Hash large cells incrementally so cancellation/deadlines also apply to
    // native hashing between SQLite progress callbacks, without copying cells.
    for chunk in bytes.1.chunks(65_536) {
        check(permit, deadline)?;
        hash.update(chunk);
    }
    check(permit, deadline)
}
fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn operational_keys(t: &Table, r: &str) -> String {
    // No local key allowlist: consume the same build-pinned entries as both apps.
    if !t.columns.iter().any(|c| c == "setting_category")
        || !t.columns.iter().any(|c| c == "setting_key")
    {
        return "0".into();
    }
    let Some(keys) = contracts::shared().other["classification"]["safe_keys"].as_array() else {
        return "0".into();
    };
    let rules=keys.iter().filter(|k|k["suffix"]=="hostname_or_ipv4" && k["tables"].as_array().is_some_and(|a|a.iter().any(|v|v==&t.name))).filter_map(|k|{
        let category=k["category"].as_str()?; let prefix=k["key_prefix"].as_str()?;
        let n=prefix.chars().count();
        Some(format!("({r}.setting_category COLLATE BINARY={} AND substr({r}.setting_key,1,{n}) COLLATE BINARY={} AND length(substr({r}.setting_key,{})) BETWEEN 1 AND 253 AND substr({r}.setting_key,{},1) GLOB '[A-Za-z0-9]' AND substr({r}.setting_key,{}) NOT GLOB '*[^A-Za-z0-9._:-]*')",literal(category),literal(prefix),n+1,n+1,n+1))
    }).collect::<Vec<_>>();
    if rules.is_empty() {
        "0".into()
    } else {
        rules.join(" OR ")
    }
}
fn digest_tables(
    c: &Connection,
    permit: &SupportPermit,
    scope: &Scope,
    deadline: Instant,
    mut checkpoint: impl FnMut(),
) -> Result<BTreeMap<String, TableDigest>, UnavailableReason> {
    let mut schema = guards::schema(c).map_err(|_| UnavailableReason::ReadFailed)?;
    for table in &mut schema {
        check(permit, deadline)?;
        // table_info omits generated columns. Their stored/computed values are
        // protected too; only virtual-table implementation columns are omitted.
        let mut stmt = c
            .prepare(&format!(
                "PRAGMA table_xinfo({})",
                replica::quote(&table.name)
            ))
            .map_err(|_| UnavailableReason::ReadFailed)?;
        let columns = stmt
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(6)?)))
            .map_err(|_| UnavailableReason::ReadFailed)?;
        table.columns = columns
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| UnavailableReason::ReadFailed)?
            .into_iter()
            .filter_map(|(name, hidden)| (hidden != 1).then_some(name))
            .collect();
    }
    let mut out = BTreeMap::new();
    for t in &schema {
        check(permit, deadline)?;
        let policy = guards::policy(&t.name);
        let eligible = if policy["row_rule"] == "operational_key" {
            // Keep any scope boundary from the native policy, and take the
            // admitted key grammar from the embedded shared list itself.
            format!(
                "({}) AND ({})",
                guards::predicate(&schema, t, "r", scope),
                operational_keys(t, "r")
            )
        } else {
            guards::predicate(&schema, t, "r", scope)
        };
        let rowid = ["rowid", "_rowid_", "oid"]
            .into_iter()
            .find(|n| !t.columns.iter().any(|c| c.eq_ignore_ascii_case(n)));
        let without_rowid = t.sql.to_ascii_uppercase().contains("WITHOUT ROWID");
        let mut order =
            t.pk.iter()
                .map(|n| format!("r.{} COLLATE BINARY", replica::quote(n)))
                .collect::<Vec<_>>();
        if !without_rowid {
            let rowid = rowid.ok_or(UnavailableReason::ReadFailed)?;
            order.push(format!("r.{rowid}"));
        }
        if order.is_empty() {
            return Err(UnavailableReason::ReadFailed);
        }
        let write_policy = &contracts::shared().write_policy;
        let writable = |column: &str| {
            policy["update"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(column)))
                && !write_policy["never_writable"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(column)))
                && !write_policy["never_writable_prefixes"]
                    .as_array()
                    .is_some_and(|a| {
                        a.iter()
                            .filter_map(serde_json::Value::as_str)
                            .any(|p| column.starts_with(p))
                    })
        };
        let mut projection = t
            .columns
            .iter()
            .map(|n| {
                let column = format!("r.{}", replica::quote(n));
                if writable(n) {
                    format!("CASE WHEN COALESCE(({eligible}),0) THEN NULL ELSE {column} END")
                } else {
                    column
                }
            })
            .collect::<Vec<_>>();
        // In a table without a declared PK the hidden rowid is its identity,
        // including when it changes without changing visible cell contents.
        if t.pk.is_empty() && !without_rowid {
            projection.push(format!("r.{}", rowid.ok_or(UnavailableReason::ReadFailed)?));
        }
        let columns = projection.join(",");
        // Operational-key rows permit insert/delete. Other policy tables still
        // have immutable identity/payload columns, even on an eligible row.
        let filter = if policy["row_rule"] == "operational_key" {
            format!("NOT COALESCE(({eligible}),0)")
        } else {
            "1".into()
        };
        let sql = format!(
            "SELECT {columns} FROM {} r WHERE {filter} ORDER BY {}",
            replica::quote(&t.name),
            order.join(",")
        );
        let mut stmt = c.prepare(&sql).map_err(|_| UnavailableReason::ReadFailed)?;
        let mut rows = stmt.query([]).map_err(|_| UnavailableReason::ReadFailed)?;
        let mut hash = Context::new(&SHA256);
        frame(&mut hash, 10, b"protected-digest-v1");
        frame(&mut hash, 11, t.sql.as_bytes());
        for col in &t.columns {
            frame(&mut hash, 12, col.as_bytes());
        }
        let mut count = 0u64;
        while let Some(row) = rows.next().map_err(|_| UnavailableReason::ReadFailed)? {
            check(permit, deadline)?;
            frame(&mut hash, 13, &[]);
            for i in 0..projection.len() {
                check(permit, deadline)?;
                value(
                    &mut hash,
                    row.get_ref(i).map_err(|_| UnavailableReason::ReadFailed)?,
                    permit,
                    deadline,
                )?;
            }
            count += 1;
            checkpoint();
            check(permit, deadline)?;
        }
        frame(&mut hash, 14, &count.to_be_bytes());
        let sha256 = hash
            .finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        out.insert(
            t.name.clone(),
            TableDigest {
                rows: count,
                sha256,
            },
        );
    }
    check(permit, deadline)?;
    Ok(out)
}
