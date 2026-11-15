//! One owner for adopting authoritative order state after refused status-only
//! writes. Queue originals and refusal codes survive as terminal evidence.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) const REFUSED_STATUS_INDEX_SQL:&str="CREATE INDEX IF NOT EXISTS idx_parity_refused_order_status ON parity_sync_queue(organization_id,created_at,record_id) WHERE table_name='orders' AND module_type='orders' AND status='failed';";

pub(crate) fn migrate_queue(c: &Connection) -> Result<(), String> {
    let sql: String = c
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='parity_sync_queue'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if sql.contains("'superseded'") {
        return Ok(());
    }
    let old = "'pending', 'processing', 'failed', 'conflict'";
    if !sql.contains(old) {
        return Err("ORDER_QUEUE_SCHEMA_UNRECOGNIZED".into());
    }
    let mut q = c.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='parity_sync_queue' AND type IN ('index','trigger') AND sql IS NOT NULL").map_err(|e|e.to_string())?;
    let dependents = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    c.execute_batch(
        &sql.replacen("parity_sync_queue", "parity_sync_queue_adopt_v108", 1)
            .replace(
                old,
                "'pending', 'processing', 'failed', 'conflict', 'superseded'",
            ),
    )
    .map_err(|e| e.to_string())?;
    c.execute_batch("INSERT INTO parity_sync_queue_adopt_v108 SELECT * FROM parity_sync_queue; DROP TABLE parity_sync_queue; ALTER TABLE parity_sync_queue_adopt_v108 RENAME TO parity_sync_queue;").map_err(|e|e.to_string())?;
    for sql in dependents {
        c.execute_batch(&sql).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// These are exactly the payload fields emitted by update/accept order status.
/// A metadata, item, settlement, money or customer edit is never a status row.
pub(crate) fn status_only(operation: &str, data: &str) -> bool {
    if operation != "UPDATE" {
        return false;
    }
    let Ok(Value::Object(v)) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    v.get("orderId").is_some_and(Value::is_string)
        && v.get("status")
            .is_some_and(|s| s.as_str().is_some_and(|s| !s.is_empty()))
        && v.keys().all(|k| {
            matches!(
                k.as_str(),
                "orderId" | "status" | "estimatedTime" | "estimated_time" | "organization_id"
            )
        })
        && v.get("organization_id")
            .is_none_or(|n| n.as_str().is_some_and(|s| !s.is_empty()))
        && ["estimatedTime", "estimated_time"].iter().all(|k| {
            v.get(*k)
                .is_none_or(|n| n.is_null() || n.as_i64().is_some())
        })
}
pub(crate) fn transition_refused(status: u16, body: &str) -> bool {
    if status != 400 {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return body.starts_with("Invalid status transition:");
    };
    v["code"] == "ORDER_STATUS_TRANSITION_REFUSED"
        || ["error", "message"].iter().any(|k| {
            v[*k]
                .as_str()
                .is_some_and(|s| s.starts_with("Invalid status transition:"))
        })
}
pub(crate) fn permanent_refusal(error: &str) -> bool {
    let code = error
        .strip_prefix("HTTP_")
        .and_then(|s| s.get(..3))
        .or_else(|| error.strip_prefix("HTTP ").and_then(|s| s.get(..3)))
        .and_then(|s| s.parse::<u16>().ok());
    code.is_some_and(|s| (400..500).contains(&s) && !matches!(s, 408 | 429))
}
pub(crate) fn resolve(
    c: &Connection,
    id: &str,
) -> Result<(String, String, String, String), String> {
    let mut order:(String,String,String,String)=c.query_row("SELECT id,COALESCE(NULLIF(supabase_id,''),id),COALESCE(organization_id,''),status FROM orders WHERE id=?1 OR supabase_id=?1 ORDER BY CASE WHEN id=?1 THEN 0 ELSE 1 END LIMIT 1", [id], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_|"INTERNAL_ERROR")?.ok_or("ORDER_NOT_FOUND")?;
    // The shipped remote materializer predates the order's organization
    // column. Such rows remain branch-bound; every queue row must still match
    // this native organization, and the authenticated state endpoint must
    // return the exact server id before the owner can write.
    if order.2.is_empty() {
        let scope = crate::support::identity::local(c)?;
        let branch: Option<String> = c
            .query_row(
                "SELECT branch_id FROM orders WHERE id=?1",
                [&order.0],
                |r| r.get(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        if branch.as_deref() != Some(scope.branch_id.as_str()) {
            return Err("PROTECTED_RECORD".into());
        }
        order.2 = scope.organization_id;
    }
    Ok(order)
}
#[derive(Debug)]
pub(crate) struct StatusRow {
    pub id: String,
    pub status: String,
}
pub(crate) fn eligible(
    c: &Connection,
    id: &str,
    confirmed: bool,
) -> Result<Vec<StatusRow>, String> {
    let (local, remote, org, _) = resolve(c, id)?;
    let scope = crate::support::identity::local(c)?;
    let branch: Option<String> = c
        .query_row("SELECT branch_id FROM orders WHERE id=?1", [&local], |r| {
            r.get(0)
        })
        .map_err(|_| "INTERNAL_ERROR")?;
    if org != scope.organization_id || branch.as_deref() != Some(scope.branch_id.as_str()) {
        return Err("PROTECTED_RECORD".into());
    }
    let context: String = c
        .query_row(
            "SELECT COALESCE(order_context,'') FROM orders WHERE id=?1",
            [&local],
            |r| r.get(0),
        )
        .map_err(|_| "INTERNAL_ERROR")?;
    if context.trim().eq_ignore_ascii_case("repair_settlement") {
        return Err("PROTECTED_RECORD".into());
    }
    let mut q = c.prepare("SELECT id,status,operation,data,COALESCE(error_message,''),organization_id,module_type FROM parity_sync_queue WHERE table_name='orders' AND record_id IN (?1,?2) AND status IN ('pending','processing','failed','conflict') ORDER BY created_at,id").map_err(|_|"INTERNAL_ERROR")?;
    let rows = q
        .query_map(params![local, remote], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|_| "INTERNAL_ERROR")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "INTERNAL_ERROR")?;
    if rows.is_empty() || rows.len() > 50 {
        return Err("ORDER_STATUS_ROWS_INELIGIBLE".into());
    }
    let mut refused = false;
    let mut result = Vec::new();
    for (id, status, operation, data, error, row_org, module) in rows {
        if row_org != org
            || module != "orders"
            || !status_only(&operation, &data)
            || status == "processing"
            || status == "conflict"
        {
            return Err("ORDER_HAS_LOCAL_WORK".into());
        }
        let payload: Value = serde_json::from_str(&data).map_err(|_| "ORDER_HAS_LOCAL_WORK")?;
        if payload["orderId"] != local && payload["orderId"] != remote {
            return Err("ORDER_HAS_LOCAL_WORK".into());
        }
        if payload.get("organization_id").is_some_and(|v| v != &org) {
            return Err("PROTECTED_RECORD".into());
        }
        let is_refused = status == "failed" && permanent_refusal(&error);
        let marked: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM parity_sync_set_aside WHERE queue_id=?1)",
                [&id],
                |r| r.get(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        if marked {
            return Err("ORDER_HAS_LOCAL_WORK".into());
        }
        if confirmed && !is_refused {
            return Err("ORDER_STATUS_ROWS_INELIGIBLE".into());
        }
        refused |= is_refused;
        result.push(StatusRow { id, status });
    }
    if !refused {
        return Err("ORDER_STATUS_ROWS_INELIGIBLE".into());
    }
    // Both financial queues and unsent local money mirrors are barriers. No
    // payment amount, method or ledger row is changed by this owner.
    let money: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue q WHERE q.status IN ('pending','processing','failed','conflict') AND q.table_name<>'orders' AND (q.record_id IN (SELECT id FROM order_payments WHERE order_id=?1) OR q.record_id IN (SELECT id FROM payment_adjustments WHERE order_id=?1) OR (json_valid(q.data) AND (json_extract(q.data,'$.orderId') IN (?1,?2) OR json_extract(q.data,'$.order_id') IN (?1,?2))))) OR EXISTS(SELECT 1 FROM sync_queue WHERE status NOT IN ('synced','completed') AND (entity_id IN (?1,?2) OR (json_valid(payload) AND (json_extract(payload,'$.orderId') IN (?1,?2) OR json_extract(payload,'$.order_id') IN (?1,?2))))) OR EXISTS(SELECT 1 FROM order_payments WHERE order_id=?1 AND (COALESCE(sync_status,'pending') NOT IN ('synced','completed') OR COALESCE(sync_state,'pending')<>'applied')) OR EXISTS(SELECT 1 FROM payment_adjustments WHERE order_id=?1 AND COALESCE(sync_state,'pending')<>'applied')",params![local,remote],|r|r.get(0)).map_err(|_|"INTERNAL_ERROR")?;
    if money {
        return Err("ORDER_HAS_LOCAL_WORK".into());
    }
    Ok(result)
}

/// Caller owns a writer transaction (the savepoint composes with the confirmed
/// executor). The normal pull is the only state-application implementation.
pub(crate) fn adopt(
    c: &Connection,
    id: &str,
    server: &Value,
    confirmed: bool,
) -> Result<Value, String> {
    // SAVEPOINT supplies rollback on every error even when the support
    // executor already owns BEGIN IMMEDIATE.
    c.execute_batch("SAVEPOINT adopt_server_order_state")
        .map_err(|_| "INTERNAL_ERROR")?;
    let result = (|| {
        let (local, remote, _, before) = resolve(c, id)?;
        if server["id"] != remote {
            return Err("PAYLOAD_DRIFT".into());
        }
        let status = server["status"]
            .as_str()
            .ok_or("INVALID_SERVER_ORDER_STATE")?;
        if !confirmed && !matches!(status, "cancelled" | "canceled") {
            return Err("ORDER_NOT_CANCELLED".into());
        }
        if status.is_empty()
            || status.len() > 80
            || status.trim() != status
            || status.chars().any(char::is_control)
            || server["version"].as_i64().is_none_or(|n| n < 0)
            || server["updated_at"]
                .as_str()
                .is_none_or(|s| chrono::DateTime::parse_from_rfc3339(s).is_err())
        {
            return Err("INVALID_SERVER_ORDER_STATE".into());
        }
        let rows = eligible(c, &local, confirmed)?;
        let mut evidence = Vec::new();
        for r in rows {
            c.execute("UPDATE parity_sync_queue SET status='superseded',next_retry_at=NULL,claim_generation=claim_generation+1 WHERE id=?1 AND status=?2", params![r.id,r.status]).map_err(|_|"INTERNAL_ERROR")?;
            evidence.push(
                json!({"queue_id":r.id,"before_status":r.status,"after_status":"superseded"}),
            );
        }
        let payment_status: Option<String> = c
            .query_row(
                "SELECT payment_status FROM orders WHERE id=?1",
                [&local],
                |r| r.get(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        let state = json!({"id":remote,"status":status,"version":server["version"],"updated_at":server["updated_at"],"cancelled_at":server["cancelled_at"],"cancellation_reason":server["cancellation_reason"],"payment_status":payment_status});
        crate::sync::apply_authoritative_order_state(c, &local, state)?;
        let fresh: String = c
            .query_row("SELECT status FROM orders WHERE id=?1", [&local], |r| {
                r.get(0)
            })
            .map_err(|_| "INTERNAL_ERROR")?;
        if fresh != status || crate::sync::has_outstanding_local_order_queue(c, &local) {
            return Err("OUTCOME_UNKNOWN".into());
        }
        crate::db::set_setting(c, "sync", &format!("adopted_server_order:{local}"), status)?;
        Ok(
            json!({"kind":"order_adopt","order_id":local,"server_order_id":remote,"before_status":before,"after_status":fresh,"rows":evidence}),
        )
    })();
    match result {
        Ok(v) => {
            c.execute_batch("RELEASE adopt_server_order_state")
                .map_err(|_| "OUTCOME_UNKNOWN")?;
            Ok(v)
        }
        Err(e) => {
            let _ = c.execute_batch(
                "ROLLBACK TO adopt_server_order_state; RELEASE adopt_server_order_state",
            );
            Err(e)
        }
    }
}

pub(crate) async fn fetch(base: &str, key: &str, id: &str) -> Result<Value, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "ORDER_NOT_FOUND")?;
    let reply = crate::api::fetch_from_admin_detailed_with_timeout(
        base,
        key,
        &format!("/api/pos/orders/state?order_id={id}"),
        "GET",
        None,
        std::time::Duration::from_secs(5),
    )
    .await
    .map_err(|e| {
        if e.status() == Some(404) && e.code() == Some("ORDER_NOT_FOUND") {
            "ORDER_NOT_FOUND"
        } else {
            "SERVER_ORDER_STATE_UNAVAILABLE"
        }
    })?;
    if reply["success"] != true || reply["order"]["id"] != id {
        return Err("SERVER_ORDER_STATE_UNAVAILABLE".into());
    }
    Ok(reply["order"].clone())
}

pub(crate) async fn heal_one(
    conn: &std::sync::Mutex<Connection>,
    base: &str,
    key: &str,
    id: &str,
) -> Result<Value, String> {
    let (local, remote, path) = {
        let c = conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        eligible(&c, id, false)?;
        let (local, remote, _, _) = resolve(&c, id)?;
        let path: String = c
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name='main'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "INTERNAL_ERROR")?;
        (local, remote, path)
    };
    let server = fetch(base, key, &remote).await?;
    if !matches!(server["status"].as_str(), Some("cancelled" | "canceled")) {
        return Err("ORDER_NOT_CANCELLED".into());
    }
    let gate = crate::support::critical_op::global();
    let reader = gate
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    if path.is_empty() {
        return Err("SNAPSHOT_REQUIRED".into());
    }
    let snapshot_db = crate::db::DbState {
        conn: std::sync::Mutex::new(Connection::open(&path).map_err(|_| "SNAPSHOT_REQUIRED")?),
        db_path: path.into(),
    };
    crate::recovery::create_pre_recovery_action_snapshot(&snapshot_db)
        .map_err(|_| "SNAPSHOT_REQUIRED")?;
    if reader.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    drop(reader);
    let writer = gate.try_begin_support(true, None).map_err(str::to_string)?;
    let c = snapshot_db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
    let tx = writer.begin_write(&c)?;
    let result = adopt(&c, &local, &server, false)?;
    if writer.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    tx.commit().map_err(|_| "OUTCOME_UNKNOWN")?;
    c.progress_handler(0, None::<fn() -> bool>);
    Ok(result)
}

/// Startup's first sync and every later ordinary sync pass share this bounded
/// sweep. The persisted claim precedes HTTP, so restarts do not erase cooldowns.
pub(crate) async fn heal_pass(conn: &std::sync::Mutex<Connection>, base: &str, key: &str) {
    if crate::support::critical_op::global().active() {
        return;
    }
    let ids: Result<Vec<String>, String> = (|| {
        let c = conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        claim_heal_candidates(&c, chrono::Utc::now().timestamp_millis())
    })();
    if let Ok(ids) = ids {
        for id in ids {
            if crate::support::critical_op::global().active() {
                break;
            }
            let _ = heal_one(conn, base, key, &id).await;
        }
    }
}

fn claim_heal_candidates(c: &Connection, now: i64) -> Result<Vec<String>, String> {
    let tx = crate::db::immediate_transaction(c).map_err(|_| "INTERNAL_ERROR")?;
    let scope = crate::support::identity::local(c)?;
    let mut q=c.prepare("SELECT DISTINCT record_id FROM parity_sync_queue q WHERE table_name='orders' AND module_type='orders' AND status='failed' AND organization_id=?2 AND (error_message GLOB 'HTTP_4??_CLIENT_ERROR*' OR error_message GLOB 'HTTP 4??:*') AND NOT EXISTS(SELECT 1 FROM local_settings s WHERE setting_category='sync' AND setting_key='server_order_adopt_attempt:'||q.record_id AND CAST(setting_value AS INTEGER)>?1) ORDER BY created_at LIMIT 200").map_err(|_|"INTERNAL_ERROR")?;
    let candidates = q
        .query_map(params![now - 600_000, scope.organization_id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|_| "INTERNAL_ERROR")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "INTERNAL_ERROR")?;
    drop(q);
    let mut ids = Vec::new();
    for id in candidates {
        if ids.len() >= 20 {
            break;
        }
        if eligible(&c, &id, false).is_err() {
            continue;
        }
        let cooldown = format!("server_order_adopt_attempt:{id}");
        if crate::db::get_setting(&c, "sync", &cooldown)
            .and_then(|s| s.parse::<i64>().ok())
            .is_some_and(|at| now.saturating_sub(at) < 600_000)
        {
            continue;
        }
        crate::db::set_setting(&c, "sync", &cooldown, &now.to_string())?;
        ids.push(id);
    }
    tx.commit().map_err(|_| "INTERNAL_ERROR")?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    const REMOTE: &str = "b9062fca-5b0b-4064-901c-7fe040d6a01f";
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&c);
        for (key, value) in [
            ("organization_id", "org"),
            ("branch_id", "branch"),
            ("terminal_id", "terminal"),
        ] {
            crate::db::set_setting(&c, "terminal", key, value).unwrap();
        }
        c.execute("INSERT INTO orders(id,supabase_id,organization_id,branch_id,terminal_id,items,total_amount,total_amount_cents,status,payment_status,sync_status,created_at,updated_at) VALUES('local',?1,NULL,'branch',NULL,'[]',39,3900,'delivered','paid','pending','2026-11-15T02:17:59Z','2026-11-15T03:47:00Z')",[REMOTE]).unwrap();
        c.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,sync_status,sync_state,created_at,updated_at) VALUES('payment','local','other',39,3900,'EUR','completed','synced','applied','2026-11-15T02:18:00Z','2026-11-15T02:18:00Z')",[]).unwrap();
        for (id, status) in [
            ("refused-confirmed", "confirmed"),
            ("refused-ready", "ready"),
            ("refused-delivered", "delivered"),
        ] {
            c.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,module_type,status,error_message,attempts) VALUES(?1,'orders','local','UPDATE',?2,'org','orders','failed','HTTP_400_CLIENT_ERROR',1)",params![id,json!({"orderId":"local","status":status,"estimatedTime":20}).to_string()]).unwrap();
        }
        c
    }
    fn server(status: &str) -> Value {
        json!({"id":REMOTE,"status":status,"version":4,"updated_at":"2026-11-15T02:18:23.118+00:00","cancelled_at":"2026-11-15T02:18:23.118+00:00","cancellation_reason":"customer: ORDER_MODIFICATION_NOT_POSSIBLE","payment_status":"completed","total_amount":39})
    }
    #[test]
    fn tomikro_cancellation_adopts_old_server_time_and_retains_all_three_refusals() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let c = fixture();
        let before: Vec<Value> = crate::support::guards::rows(
            &c,
            "SELECT id,data,error_message,attempts FROM parity_sync_queue ORDER BY id",
            &[],
        )
        .unwrap();
        let evidence = adopt(&c, REMOTE, &server("cancelled"), false).unwrap();
        assert_eq!(evidence["rows"].as_array().unwrap().len(), 3);
        let order = crate::support::guards::rows(&c, "SELECT * FROM orders WHERE id='local'", &[])
            .unwrap()
            .remove(0);
        assert_eq!(order["status"], "cancelled");
        assert_eq!(order["version"], 4);
        assert_eq!(order["remote_version"], 4);
        assert_eq!(order["cancelled_at"], server("cancelled")["cancelled_at"]);
        assert_eq!(
            order["cancellation_reason"],
            server("cancelled")["cancellation_reason"]
        );
        assert_eq!(order["updated_at"], server("cancelled")["updated_at"]);
        assert_eq!(order["total_amount_cents"], 3900);
        assert_eq!(order["payment_status"], "paid");
        assert_eq!(
            crate::support::guards::rows(
                &c,
                "SELECT id,data,error_message,attempts FROM parity_sync_queue ORDER BY id",
                &[]
            )
            .unwrap(),
            before
        );
        assert!(!crate::sync::has_outstanding_local_order_queue(&c, "local"));
        assert_eq!(crate::sync_queue::get_status(&c).unwrap().total, 0);
        assert_eq!(
            crate::sync_queue::get_closeout_blocking_status(&c)
                .unwrap()
                .total,
            0
        );
        assert!(crate::sync_queue::retry_item(&c, "refused-ready").is_err());
        assert_eq!(
            c.query_row(
                "SELECT method,amount_cents,status FROM order_payments WHERE id='payment'",
                [],
                |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?
                ))
            )
            .unwrap(),
            ("other".into(), 3900, "completed".into())
        );
    }
    #[test]
    fn remote_pull_uses_the_same_owner_for_a_cancellation() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let c = fixture();
        assert!(
            crate::sync::apply_remote_orders_page_for_test(&c, vec![server("cancelled")]).is_none()
        );
        assert_eq!(
            c.query_row("SELECT status FROM orders WHERE id='local'", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "cancelled"
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM parity_sync_queue WHERE status='superseded'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        let mut partial = server("cancelled");
        partial.as_object_mut().unwrap().remove("cancelled_at");
        partial["version"] = json!(5);
        partial["updated_at"] = json!("2026-11-15T02:19:00+00:00");
        assert!(crate::sync::apply_remote_orders_page_for_test(&c, vec![partial]).is_none());
        assert_eq!(
            c.query_row(
                "SELECT cancelled_at FROM orders WHERE id='local'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "2026-11-15T02:18:23.118+00:00"
        );
    }
    #[test]
    fn confirmed_adoption_accepts_any_server_status_but_automatic_adoption_only_cancellation() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let c = fixture();
        c.execute("UPDATE orders SET status='cancelled'", [])
            .unwrap();
        assert!(adopt(&c, "local", &server("ready"), false).is_err());
        c.execute("UPDATE orders SET cancellation_reason='old reason',cancelled_at='2026-11-15T03:47:00Z'",[]).unwrap();
        let mut state = server("awaiting_collection");
        state["cancellation_reason"] = Value::Null;
        state["cancelled_at"] = Value::Null;
        assert_eq!(
            adopt(&c, "local", &state, true).unwrap()["after_status"],
            "awaiting_collection"
        );
        let cleared: (Option<String>, Option<String>) = c
            .query_row(
                "SELECT cancellation_reason,cancelled_at FROM orders WHERE id='local'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(cleared, (None, None));
    }
    #[test]
    fn edits_money_pending_and_retryable_or_inflight_rows_refuse_without_any_write() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let c = fixture();
        for sql in [
            "UPDATE parity_sync_queue SET data='{\"orderId\":\"local\",\"status\":\"ready\",\"items\":[]}' WHERE id='refused-ready'",
            "UPDATE order_payments SET sync_status='pending'",
            "UPDATE order_payments SET sync_state='waiting_parent'",
            "UPDATE parity_sync_queue SET organization_id='other-org'",
            "UPDATE orders SET branch_id='other-branch'",
            "UPDATE parity_sync_queue SET error_message='HTTP_408_CLIENT_ERROR'",
            "UPDATE parity_sync_queue SET error_message='HTTP_429_CLIENT_ERROR'",
            "UPDATE parity_sync_queue SET status='processing' WHERE id='refused-ready'",
            "UPDATE parity_sync_queue SET status='pending' WHERE id='refused-ready'",
        ] {
            c.execute_batch("SAVEPOINT case_test").unwrap();
            c.execute_batch(sql).unwrap();
            assert!(adopt(&c,"local",&server("cancelled"),true).is_err(),"{sql}");
            assert_eq!(c.query_row("SELECT count(*) FROM parity_sync_queue WHERE status='superseded'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            c.execute_batch("ROLLBACK TO case_test; RELEASE case_test").unwrap();
        }
        c.execute(
            "UPDATE parity_sync_queue SET status='pending' WHERE id='refused-ready'",
            [],
        )
        .unwrap();
        // The automatic rule also closes later unsent status-only taps, once
        // one permanent refusal and the server cancellation establish authority.
        assert!(adopt(&c, "local", &server("cancelled"), false).is_ok());
    }
    #[test]
    fn a_failed_order_apply_rolls_back_the_terminal_queue_transition() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let c = fixture();
        c.execute_batch("CREATE TRIGGER refuse_adoption BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT,'test'); END").unwrap();
        assert!(adopt(&c, "local", &server("cancelled"), false).is_err());
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM parity_sync_queue WHERE status='failed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
    }
    #[test]
    fn only_producer_status_payloads_and_typed_or_legacy_transition_refusals_match() {
        assert!(status_only(
            "UPDATE",
            r#"{"orderId":"x","status":"confirmed","estimatedTime":20}"#
        ));
        for body in [
            r#"{"orderId":"x","status":"ready","items":[]}"#,
            r#"{"orderId":"x","status":"ready","settlement_context":{}}"#,
            r#"{"orderId":"x","status":"ready","total_amount":39}"#,
        ] {
            assert!(!status_only("UPDATE", body));
        }
        assert!(transition_refused(
            400,
            r#"{"code":"ORDER_STATUS_TRANSITION_REFUSED"}"#
        ));
        assert!(transition_refused(
            400,
            r#"{"error":"Invalid status transition: Cannot transition from cancelled to confirmed. Allowed: pending"}"#
        ));
        assert!(!transition_refused(400, r#"{"error":"invalid customer"}"#));
        assert!(!transition_refused(
            429,
            r#"{"code":"ORDER_STATUS_TRANSITION_REFUSED"}"#
        ));
        assert!(!permanent_refusal("HTTP_408_CLIENT_ERROR"));
        assert!(!permanent_refusal("HTTP_429_CLIENT_ERROR"));
        assert!(permanent_refusal("HTTP_400_CLIENT_ERROR"));
    }
    #[test]
    fn the_current_producers_organization_envelope_is_bookkeeping_and_must_match() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let c = fixture();
        c.execute(
            "UPDATE orders SET organization_id='org' WHERE id='local'",
            [],
        )
        .unwrap();
        let mut payload = json!({"orderId":"local","status":"ready","estimatedTime":20});
        crate::order_ownership::add_order_organization(&c, "local", &mut payload);
        assert_eq!(payload["organization_id"], "org");
        assert!(status_only("UPDATE", &payload.to_string()));
        c.execute(
            "UPDATE parity_sync_queue SET data=?1 WHERE id='refused-ready'",
            [payload.to_string()],
        )
        .unwrap();
        assert!(eligible(&c, "local", true).is_ok());
        payload["organization_id"] = json!("other-org");
        c.execute(
            "UPDATE parity_sync_queue SET data=?1 WHERE id='refused-ready'",
            [payload.to_string()],
        )
        .unwrap();
        assert_eq!(eligible(&c, "local", true).unwrap_err(), "PROTECTED_RECORD");
    }
    #[test]
    fn queue_upgrade_preserves_originals_indexes_and_triggers() {
        let c = Connection::open_in_memory().unwrap();
        crate::sync_queue::create_tables(&c).unwrap();
        let sql: String = c
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name='parity_sync_queue'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        c.execute_batch("DROP TABLE parity_sync_queue").unwrap();
        c.execute_batch(&sql.replace(", 'superseded'", "")).unwrap();
        c.execute_batch("CREATE INDEX retained_queue_index ON parity_sync_queue(record_id); CREATE TRIGGER retained_queue_trigger BEFORE DELETE ON parity_sync_queue BEGIN SELECT RAISE(ABORT,'retained'); END; INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,status,error_message) VALUES('x','orders','o','UPDATE','{}','org','failed','HTTP_400_CLIENT_ERROR');").unwrap();
        c.execute_batch("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,module_type,status,claim_generation,repair_aggregate_id) VALUES('repair-original','repairs','repair-id','UPDATE','{\"original\":\"opaque-native-repair-command\"}','org','repairs','processing',7,'repair-aggregate');").unwrap();
        let originals =
            crate::support::guards::rows(&c, "SELECT * FROM parity_sync_queue ORDER BY id", &[])
                .unwrap();
        {
            let tx = crate::db::immediate_transaction(&c).unwrap();
            migrate_queue(&c).unwrap();
            assert_eq!(
                crate::support::guards::rows(
                    &c,
                    "SELECT * FROM parity_sync_queue ORDER BY id",
                    &[]
                )
                .unwrap(),
                originals
            );
            drop(tx); // Every schema and row change rolls back with the caller.
        }
        let rolled_back: String = c
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name='parity_sync_queue'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!rolled_back.contains("'superseded'"));
        let tx = crate::db::immediate_transaction(&c).unwrap();
        migrate_queue(&c).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            crate::support::guards::rows(&c, "SELECT * FROM parity_sync_queue ORDER BY id", &[])
                .unwrap(),
            originals
        );
        assert_eq!(
            c.query_row(
                "SELECT data,error_message FROM parity_sync_queue WHERE id='x'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("{}".into(), "HTTP_400_CLIENT_ERROR".into())
        );
        c.execute("UPDATE parity_sync_queue SET status='superseded'", [])
            .unwrap();
        assert!(c.execute("DELETE FROM parity_sync_queue", []).is_err());
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='retained_queue_index'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn self_heal_is_bounded_and_its_per_order_cooldown_survives_passes() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let c = fixture();
        for n in 0..24 {
            let id = format!("order-{n}");
            c.execute("INSERT INTO orders(id,supabase_id,organization_id,branch_id,terminal_id,items,total_amount,status,created_at,updated_at) VALUES(?1,?2,'org','branch','terminal','[]',1,'ready','2026-11-15T02:18:00Z','2026-11-15T02:18:00Z')",params![id,uuid::Uuid::new_v4().to_string()]).unwrap();
            c.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,module_type,status,error_message) VALUES(?1,'orders',?1,'UPDATE',?2,'org','orders','failed','HTTP_400_CLIENT_ERROR')",params![id,json!({"orderId":id,"status":"ready"}).to_string()]).unwrap();
        }
        let now = chrono::Utc::now().timestamp_millis();
        let first = claim_heal_candidates(&c, now).unwrap();
        assert_eq!(first.len(), 20);
        let second = claim_heal_candidates(&c, now + 1).unwrap();
        assert_eq!(second.len(), 5);
        assert!(first.iter().all(|id| !second.contains(id)));
        assert!(claim_heal_candidates(&c, now + 599_999).unwrap().is_empty());
        assert_eq!(claim_heal_candidates(&c, now + 600_000).unwrap().len(), 20);
    }
}
