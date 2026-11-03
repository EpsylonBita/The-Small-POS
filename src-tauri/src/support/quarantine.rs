//! Two durable files: verified committed copies always precede source removal.
use super::{
    authorizer::{self, Policy},
    contracts,
    dry_run::Target,
    guards::{self, Scope},
    replica::quote,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct Copy {
    pub table: String,
    pub pk: Value,
    pub row: Value,
    pub hash: String,
    pub schema: String,
}
pub fn stage(
    store: &Connection,
    live: &Connection,
    group: &str,
    session: &str,
    approval: Option<&str>,
    reason: &str,
    members: &[Target],
    at: &str,
) -> Result<(), String> {
    if members.is_empty() || members.iter().any(|t| t.database != "main") {
        return Err("POLICY_REFUSED".into());
    }
    let schema = guards::schema(live)?;
    guards::no_implicit_effects(live, members.iter().map(|t| t.table.clone()))?;
    let tx = super::db::transaction(store).map_err(guards::error)?;
    for t in members {
        let row = t.before.as_ref().ok_or("POLICY_REFUSED")?;
        let sql = &schema
            .iter()
            .find(|i| i.name == t.table)
            .ok_or("POLICY_REFUSED")?
            .sql;
        tx.execute("INSERT INTO support_quarantine(id,group_id,session_id,approval_id,source_db,source_table,source_pk_json,row_json,row_sha256,reason,state,created_at) VALUES(?1,?2,?3,?4,'main',?5,?6,?7,?8,?9,'staged',?10)",params![uuid::Uuid::new_v4().to_string(),group,session,approval,t.table,t.pk.to_string(),json!({"schema":sql,"row":row}).to_string(),contracts::payload_hash(row),reason,at]).map_err(guards::error)?;
    }
    tx.commit().map_err(guards::error)?;
    let copies = load(store, group, "staged")?;
    if copies.len() != members.len() {
        return Err("PAYLOAD_DRIFT".into());
    }
    Ok(())
}
pub fn load(store: &Connection, group: &str, state: &str) -> Result<Vec<Copy>, String> {
    let rows=guards::rows(store,"SELECT source_db,source_table,source_pk_json,row_json,row_sha256 FROM support_quarantine WHERE group_id=? AND state=? ORDER BY rowid",&[group.to_string().into(),state.to_string().into()])?;
    if rows.is_empty() {
        return Err("POLICY_REFUSED".into());
    }
    rows.into_iter()
        .map(|r| {
            if r["source_db"] != "main" {
                return Err("UNSUPPORTED_ON_PLATFORM".into());
            }
            let packed: Value =
                serde_json::from_str(r["row_json"].as_str().ok_or("POLICY_REFUSED")?)
                    .map_err(|_| "POLICY_REFUSED")?;
            let row = packed["row"].clone();
            let hash = r["row_sha256"]
                .as_str()
                .ok_or("POLICY_REFUSED")?
                .to_string();
            if contracts::payload_hash(&row) != hash {
                return Err("PAYLOAD_DRIFT".into());
            }
            Ok(Copy {
                table: r["source_table"].as_str().ok_or("POLICY_REFUSED")?.into(),
                pk: serde_json::from_str(r["source_pk_json"].as_str().ok_or("POLICY_REFUSED")?)
                    .map_err(|_| "POLICY_REFUSED")?,
                row,
                hash,
                schema: packed["schema"].as_str().ok_or("POLICY_REFUSED")?.into(),
            })
        })
        .collect()
}
pub fn delete_verified(
    c: &Connection,
    policy: &Policy,
    scope: &Scope,
    copies: &[Copy],
) -> Result<usize, String> {
    let schema = guards::schema(c)?;
    guards::no_implicit_effects(c, copies.iter().map(|t| t.table.clone()))?;
    for copy in copies {
        let current = guards::find(c, &copy.table, &copy.pk)?;
        if current.len() != 1 {
            return Err("PAYLOAD_DRIFT".into());
        }
        guards::eligible(c, &copy.table, &current[0], scope)?;
        if contracts::payload_hash(&current[0]) != copy.hash
            || schema
                .iter()
                .find(|t| t.name == copy.table)
                .is_none_or(|t| t.sql != copy.schema)
        {
            return Err("PAYLOAD_DRIFT".into());
        }
    }
    guards::mode(c, policy, "quarantine", || {
        for copy in copies {
            let keys = copy.pk.as_object().ok_or("POLICY_REFUSED")?;
            let values = keys
                .values()
                .map(guards::sql_value)
                .collect::<Result<Vec<_>, _>>()?;
            let n = authorizer::internal(policy, || {
                c.execute(
                    &format!(
                        "DELETE FROM {} WHERE {}",
                        quote(&copy.table),
                        keys.keys()
                            .map(|k| format!("{} IS ?", quote(k)))
                            .collect::<Vec<_>>()
                            .join(" AND ")
                    ),
                    rusqlite::params_from_iter(values),
                )
            })
            .map_err(guards::error)?;
            if n != 1 {
                return Err("PAYLOAD_DRIFT".into());
            }
        }
        Ok(copies.len())
    })
}
pub fn restore_verified(
    c: &Connection,
    policy: &Policy,
    scope: &Scope,
    copies: &[Copy],
) -> Result<usize, String> {
    let schema = guards::schema(c)?;
    guards::no_implicit_effects(c, copies.iter().map(|t| t.table.clone()))?;
    // Prove the WHOLE group before inserting its first member.
    for copy in copies {
        let t = schema
            .iter()
            .find(|t| t.name == copy.table)
            .ok_or("POLICY_REFUSED")?;
        if t.sql != copy.schema
            || guards::key(t, &copy.row)? != copy.pk
            || contracts::payload_hash(&copy.row) != copy.hash
            || guards::policy(&copy.table)["quarantine"] != true
        {
            return Err("POLICY_REFUSED".into());
        }
        if !guards::find(c, &copy.table, &copy.pk)?.is_empty() {
            return Err("PAYLOAD_DRIFT".into());
        }
        for (key, value) in [
            ("organization_id", &scope.organization_id),
            ("branch_id", &scope.branch_id),
            ("terminal_id", &scope.terminal_id),
        ] {
            if copy.row.get(key).is_some_and(|v| v != value) {
                return Err("PROTECTED_RECORD".into());
            }
        }
    }
    guards::mode(c, policy, "restore_group", || {
        for copy in copies {
            let row = copy.row.as_object().ok_or("POLICY_REFUSED")?;
            let values = row
                .values()
                .map(guards::sql_value)
                .collect::<Result<Vec<_>, _>>()?;
            authorizer::internal(policy, || {
                c.execute(
                    &format!(
                        "INSERT INTO {}({}) VALUES({})",
                        quote(&copy.table),
                        row.keys().map(|k| quote(k)).collect::<Vec<_>>().join(","),
                        row.keys().map(|_| "?").collect::<Vec<_>>().join(",")
                    ),
                    rusqlite::params_from_iter(values),
                )
            })
            .map_err(guards::error)?;
        }
        Ok(copies.len())
    })
}
pub fn reconcile(
    store: &Connection,
    c: &Connection,
    group: &str,
    command: &str,
) -> Result<(), String> {
    let marker: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM support_txn_marker WHERE command_id=?1)",
            [command],
            |r| r.get(0),
        )
        .map_err(guards::error)?;
    store
        .execute(
            "UPDATE support_quarantine SET state=?1 WHERE group_id=?2 AND state='staged'",
            params![if marker { "quarantined" } else { "discarded" }, group],
        )
        .map_err(guards::error)?;
    Ok(())
}
pub fn mark_restored(store: &Connection, group: &str, at: &str) -> Result<(), String> {
    store.execute("UPDATE support_quarantine SET state='restored',restored_at=?1 WHERE group_id=?2 AND state='quarantined'",params![at,group]).map_err(guards::error)?;
    Ok(())
}
pub fn prune(store: &Connection, session: &str, now: i64) -> Result<(), String> {
    store.execute("UPDATE support_quarantine SET state='expired',row_json='{}' WHERE session_id<>?1 AND created_at<?2 AND state IN ('quarantined','restored','discarded') AND NOT EXISTS(SELECT 1 FROM support_session_state s WHERE s.session_id=support_quarantine.session_id AND s.status='active')",params![session,super::clock::iso(now.saturating_sub(30*86400000))]).map_err(guards::error)?;
    Ok(())
}
pub fn recover(store: &Connection, c: &Connection) -> Result<(), String> {
    for r in guards::rows(store,"SELECT DISTINCT q.group_id,q.state,a.command_id FROM support_quarantine q LEFT JOIN support_consumed_approvals a ON a.approval_id=q.approval_id WHERE q.state IN ('staged','quarantined')",&[])?{
        let group=r["group_id"].as_str().ok_or("POLICY_REFUSED")?;
        if r["state"]=="staged"{if let Some(id)=r["command_id"].as_str(){reconcile(store,c,group,id)?;}continue;}
        let copies=load(store,group,"quarantined")?;
        if copies.iter().all(|copy|guards::find(c,&copy.table,&copy.pk).is_ok_and(|rows|rows.len()==1&&contracts::payload_hash(&rows[0])==copy.hash)){mark_restored(store,group,&super::clock::iso(chrono::Utc::now().timestamp_millis()))?;}
    }
    Ok(())
}
pub fn list(store: &Connection, c: &Connection) -> Result<Value, String> {
    let rows=guards::rows(store,"SELECT group_id,session_id,source_table,created_at,restored_at,state FROM support_quarantine WHERE state IN ('quarantined','restored','expired') ORDER BY created_at DESC",&[])?;
    let mut groups = std::collections::BTreeMap::<String, Value>::new();
    let schema = guards::schema(c)?;
    for r in rows {
        let id = r["group_id"].as_str().ok_or("POLICY_REFUSED")?;
        let table = r["source_table"].as_str().ok_or("POLICY_REFUSED")?;
        let group=groups.entry(id.into()).or_insert_with(||json!({"group_id":id,"session_id":r["session_id"],"tables":[],"row_counts":{},"reason":{"kind":"untrusted_till_data","value":"[REDACTED]"},"created_at":r["created_at"],"restored_at":r["restored_at"],"restore_state":r["state"],"restorable":r["state"]=="quarantined","not_restorable_reason":if r["state"]=="expired"{json!("expired")}else{Value::Null},"contents":"redacted"}));
        if let Some(tables) = group["tables"].as_array_mut() {
            if !tables.contains(&json!(table)) {
                tables.push(json!(table));
            }
        }
        group["row_counts"][table] = json!(group["row_counts"][table].as_u64().unwrap_or(0) + 1);
    }
    for (id, group) in &mut groups {
        if group["restorable"] != true {
            continue;
        }
        match load(store, id, "quarantined") {
            Ok(copies) => {
                for copy in copies {
                    if schema
                        .iter()
                        .find(|t| t.name == copy.table)
                        .is_none_or(|t| t.sql != copy.schema)
                    {
                        group["restorable"] = json!(false);
                        group["not_restorable_reason"] = json!("schema_mismatch");
                        break;
                    }
                    if !guards::find(c, &copy.table, &copy.pk)?.is_empty() {
                        group["restorable"] = json!(false);
                        group["not_restorable_reason"] = json!("pk_taken");
                        break;
                    }
                }
            }
            Err(_) => {
                group["restorable"] = json!(false);
                group["not_restorable_reason"] = json!("schema_mismatch");
            }
        }
    }
    Ok(json!(groups.into_values().collect::<Vec<_>>()))
}
