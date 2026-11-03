use super::{
    contracts,
    critical_op::SupportPermit,
    dry_run::{self, Target},
    guards::{self, Scope},
    quarantine,
    replica::quote,
    snapshot,
};
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Value};
use std::{path::Path, time::Instant};
pub fn expand(c: &Connection, target: &Value, scope: &Scope) -> Result<Vec<Target>, String> {
    let schema = guards::schema(c)?;
    let mut members = std::collections::BTreeMap::new();
    let mut add = |table: &str, rows: Vec<Value>| -> Result<(), String> {
        let t = schema
            .iter()
            .find(|t| t.name == table)
            .ok_or("PROTECTED_RECORD")?;
        if guards::policy(table)["quarantine"] != true {
            return Err("PROTECTED_RECORD".into());
        }
        for row in rows {
            guards::eligible(c, table, &row, scope)?;
            let pk = guards::key(t, &row)?;
            members.insert(
                format!("{table}:{}", pk),
                Target {
                    database: "main".into(),
                    table: table.into(),
                    pk,
                    before: Some(row),
                    after: None,
                },
            );
            if members.len() > 50 {
                return Err("POLICY_REFUSED".into());
            }
        }
        Ok(())
    };
    let select = |table: &str, where_sql: &str, values: &[SqlValue]| {
        guards::rows(
            c,
            &format!("SELECT * FROM {} WHERE {where_sql}", quote(table)),
            values,
        )
    };
    if target["kind"] == "queue_items" {
        if target["database"] != "main" {
            return Err("UNSUPPORTED_ON_PLATFORM".into());
        }
        let table = target["table"]
            .as_str()
            .filter(|t| ["parity_sync_queue", "parity_sync_set_aside"].contains(t))
            .ok_or("UNSUPPORTED_ON_PLATFORM")?;
        let pk = if table == "parity_sync_set_aside" {
            "queue_id"
        } else {
            "id"
        };
        let ids = target["ids"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 50)
            .ok_or("INVALID_INPUT")?;
        for id in ids {
            let rows = select(
                table,
                &format!("{}=?", quote(pk)),
                &[guards::sql_value(id)?],
            )?;
            if rows.len() != 1 {
                return Err("PAYLOAD_DRIFT".into());
            }
            for row in rows {
                for t in ["parity_sync_queue", "parity_sync_set_aside"] {
                    if schema.iter().any(|s| s.name == t) {
                        add(
                            t,
                            select(
                                t,
                                "table_name=? AND record_id=?",
                                &[
                                    guards::sql_value(&row["table_name"])?,
                                    guards::sql_value(&row["record_id"])?,
                                ],
                            )?,
                        )?;
                    }
                }
            }
        }
    } else if target["kind"] == "orders" {
        let ids = target["order_ids"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 50)
            .ok_or("INVALID_INPUT")?;
        for id in ids {
            let orders = select("orders", "id=?", &[guards::sql_value(id)?])?;
            if orders.len() != 1 {
                return Err("PAYLOAD_DRIFT".into());
            }
            add("orders", orders)?;
            for t in &schema {
                if t.name == "orders" || t.name == "support_txn_marker" {
                    continue;
                }
                for column in ["order_id", "local_order_id"] {
                    if t.columns.iter().any(|c| c == column) {
                        let rows = select(
                            &t.name,
                            &format!("{}=?", quote(column)),
                            &[guards::sql_value(id)?],
                        )?;
                        if !rows.is_empty() {
                            add(&t.name, rows)?;
                        }
                    }
                }
            }
            for t in ["parity_sync_queue", "parity_sync_set_aside"] {
                if schema.iter().any(|s| s.name == t) {
                    add(
                        t,
                        select(
                            t,
                            "table_name='orders' AND record_id=?",
                            &[guards::sql_value(id)?],
                        )?,
                    )?;
                }
            }
        }
    } else {
        return Err("UNSUPPORTED_ON_PLATFORM".into());
    }
    Ok(members.into_values().collect())
}
pub fn quarantine(
    store: &Connection,
    live: &Path,
    session: &str,
    proposal: &str,
    payload: &Value,
    scope: &Scope,
    now: i64,
    permit: &SupportPermit,
) -> Result<Value, String> {
    let scratch = dry_run::scratch(live, permit)?;
    let (c, policy) = guards::open(&scratch.0, scope)?;
    let _native = super::authorizer::native_scope(&policy);
    let start = Instant::now();
    permit.guard_connection(&c, start + std::time::Duration::from_millis(100));
    let targets = expand(&c, &payload["target"], scope)?;
    let mut record = dry_run::result(
        payload,
        targets,
        session,
        now,
        50,
        start.elapsed().as_millis(),
        None,
    )?;
    record.result["synced_to_server_warning"] = json!(true);
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    dry_run::save(store, &record, proposal, now)?;
    Ok(record.result)
}
pub fn restore(
    store: &Connection,
    c: &Connection,
    session: &str,
    proposal: &str,
    payload: &Value,
    now: i64,
) -> Result<Value, String> {
    let start = Instant::now();
    let target = &payload["target"];
    let targets = if target["kind"] == "snapshot" {
        let id = target["snapshot_id"].as_str().ok_or("INVALID_INPUT")?;
        let snap = snapshot::load(store, id)?;
        super::restore::validate(store, c, &snap)?;
        snapshot::verify(&snap)?;
        vec![Target {
            database: "main".into(),
            table: "snapshot".into(),
            pk: json!({"id":id}),
            before: Some(json!({"id":id})),
            after: None,
        }]
    } else if target["kind"] == "quarantine_group" {
        let copies = quarantine::load(
            store,
            target["group_id"].as_str().ok_or("INVALID_INPUT")?,
            "quarantined",
        )?;
        let schema = guards::schema(c)?;
        copies
            .into_iter()
            .map(|copy| {
                if !guards::find(c, &copy.table, &copy.pk)?.is_empty() {
                    return Err("PAYLOAD_DRIFT".into());
                }
                if schema
                    .iter()
                    .find(|t| t.name == copy.table)
                    .is_none_or(|t| t.sql != copy.schema)
                {
                    return Err("POLICY_REFUSED".into());
                }
                Ok(Target {
                    database: "main".into(),
                    table: copy.table,
                    pk: copy.pk,
                    before: None,
                    after: Some(copy.row),
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        return Err("INVALID_INPUT".into());
    };
    let record = dry_run::result(
        payload,
        targets,
        session,
        now,
        50,
        start.elapsed().as_millis(),
        None,
    )?;
    dry_run::save(store, &record, proposal, now)?;
    Ok(record.result)
}
pub fn verify_targets(c: &Connection, targets: &[Target], scope: &Scope) -> Result<(), String> {
    for t in targets {
        let rows = guards::find(c, &t.table, &t.pk)?;
        if let Some(before) = &t.before {
            if rows.len() != 1 {
                return Err("PAYLOAD_DRIFT".into());
            }
            guards::eligible(c, &t.table, &rows[0], scope)?;
            if contracts::payload_hash(&rows[0]) != contracts::payload_hash(before) {
                return Err("PAYLOAD_DRIFT".into());
            }
        } else if !rows.is_empty() {
            return Err("PAYLOAD_DRIFT".into());
        }
    }
    Ok(())
}
