use super::*;
pub fn collect(
    conn: &Connection,
    permit: &super::super::critical_op::SupportPermit,
) -> Result<Value, String> {
    collect_evidence(
        conn,
        &json!({}),
        permit,
        &super::super::evidence::Policy::load(conn, false, permit)?,
    )
}
pub fn collect_evidence(
    conn: &Connection,
    input: &Value,
    permit: &super::super::critical_op::SupportPermit,
    policy: &super::super::evidence::Policy,
) -> Result<Value, String> {
    if input
        .get("include_payload")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err("INVALID_INPUT".into());
    }
    let org = setting(conn, "terminal", "organization_id")
        .or_else(|| setting(conn, "organization", "id"))
        .ok_or("INTERNAL_ERROR")?;
    // Bound identity from local settings, never from a command's input.
    let mut count=conn.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM parity_sync_set_aside a WHERE a.queue_id=q.id AND a.organization_id=q.organization_id) THEN 'set_aside' ELSE status END AS support_status,table_name,module_type,count(*) FROM parity_sync_queue q WHERE organization_id=?1 GROUP BY support_status,table_name,module_type").map_err(replica::sql_error)?;
    let mut statuses = json!({"pending":0,"processing":0,"failed":0,"conflict":0,"set_aside":0});
    let mut tables = json!({});
    let mut modules = json!({});
    let grouped = count
        .query_map([&org], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(replica::sql_error)?;
    for row in grouped {
        let (status, table, module, n) = row.map_err(replica::sql_error)?;
        let key = if statuses.get(&status).is_some() {
            status.as_str()
        } else {
            "failed"
        };
        statuses[key] = json!(statuses[key].as_i64().unwrap_or(0) + n);
        tables[&table] = json!(tables[&table].as_i64().unwrap_or(0) + n);
        if let Some(module) = module {
            modules[&module] = json!(modules[&module].as_i64().unwrap_or(0) + n);
        }
    }
    let mut stmt=conn.prepare("SELECT id,table_name,lower(operation),module_type,attempts,next_retry_at,CASE WHEN EXISTS(SELECT 1 FROM parity_sync_set_aside a WHERE a.queue_id=q.id AND a.organization_id=q.organization_id) THEN 'set_aside' ELSE status END,error_message,CASE WHEN ?2 AND length(CAST(data AS BLOB))<=262144 THEN data ELSE NULL END FROM parity_sync_queue q WHERE organization_id=?1 ORDER BY created_at,id LIMIT 51").map_err(replica::sql_error)?;
    let mut payload_dropped = 0;
    let mut payload_cut = false;
    let items=stmt.query_map(rusqlite::params![org,input["include_payload"]==true],|r| {
        let payload=if input["include_payload"]==true {
            match r.get::<_,Option<String>>(8)?.filter(|s|s.len()<=256*1024).and_then(|s|serde_json::from_str::<Value>(&s).ok()) {
                Some(value)=>{let serialized=policy.record(value).to_string();payload_cut|=serialized.chars().count()>1024;policy.text(&serialized)},
                None=>{payload_dropped+=1;json!("redacted")}
            }
        }else{json!("redacted")};
        Ok(json!({"id":r.get::<_,String>(0)?,"table":r.get::<_,String>(1)?,"operation":r.get::<_,String>(2)?,"module":r.get::<_,Option<String>>(3)?,"attempts":r.get::<_,i64>(4)?,"next_retry_at":r.get::<_,Option<String>>(5)?,"status":r.get::<_,String>(6)?,"last_error":r.get::<_,Option<String>>(7)?.map(|s|policy.text(&s)),"retry_class":"transport","payload":payload}))
    }).map_err(replica::sql_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(replica::sql_error)?;
    let age:Option<i64>=conn.query_row("SELECT max(0,CAST((julianday('now')-julianday(min(created_at)))*86400 AS INTEGER)) FROM parity_sync_queue WHERE organization_id=?1",[&org],|r|r.get(0)).map_err(replica::sql_error)?;
    let truncated = items.len() > 50;
    let items = items.into_iter().take(50).collect::<Vec<_>>();
    let dropped = payload_dropped;
    let mut truncation = Vec::new();
    if truncated {
        truncation.push(json!({"field":"items","reason":"rows"}));
    }
    if payload_cut {
        truncation.push(json!({"field":"items.payload","reason":"cell"}));
    }
    Ok(
        json!({"counts_by_status":statuses,"counts_by_table":tables,"counts_by_module":modules,"oldest_item_age_s":age,"items":items,"truncation":truncation,"redaction_dropped":dropped,"diagnostics_backlog":crate::diagnostics::support_sync_backlog(conn)?,"financial_queue_status":crate::diagnostics::support_financial_queue_status(conn,permit)?}),
    )
}
