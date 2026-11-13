//! Typed owner calls on a private writer, never on the checkout connection.
use super::{
    clock,
    contracts::{self, Command},
    critical_op::SupportPermit,
    guards::{self, Scope},
    snapshot,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};

fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v[k].as_str().ok_or("INVALID_INPUT".into())
}
fn row(c: &Connection, table: &str, id: &str) -> Result<Value, String> {
    guards::rows(
        c,
        &format!("SELECT * FROM {} WHERE id=?", super::replica::quote(table)),
        &[id.to_string().into()],
    )?
    .into_iter()
    .next()
    .ok_or("POLICY_REFUSED".into())
}
fn payload_hash(r: &Value) -> String {
    contracts::payload_hash(
        &json!({"id":r["id"],"table_name":r["table_name"],"record_id":r["record_id"],"operation":r["operation"],"organization_id":r["organization_id"],"data":r["data"],"entity_type":r["entity_type"],"entity_id":r["entity_id"],"payload":r["payload"]}),
    )
}
fn queue_scope(c: &Connection, r: &Value, scope: &Scope, financial: bool) -> Result<(), String> {
    if !financial && r["organization_id"] != scope.organization_id {
        return Err("PROTECTED_RECORD".into());
    }
    let table = if financial {
        r["entity_type"].as_str()
    } else {
        r["table_name"].as_str()
    }
    .ok_or("PROTECTED_RECORD")?;
    let module = r["module_type"].as_str().unwrap_or("").to_ascii_lowercase();
    if module.contains("fiscal")
        || module.contains("z_report")
        || module.contains("repair")
        || module.contains("gift")
        || (![
            "orders",
            "payments",
            "order_payments",
            "payment_adjustments",
            "customers",
            "reservations",
            "staff_shifts",
            "cash_drawer_sessions",
            "payment",
            "expense",
            "staff_payment",
        ]
        .contains(&table)
            && !contracts::shared().write_policy["non_protected_queue_targets"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|target| target == table)))
    {
        return Err("PROTECTED_RECORD".into());
    }
    let data: Value = serde_json::from_str(if financial {
        field(r, "payload")?
    } else {
        field(r, "data")?
    })
    .map_err(|_| "PROTECTED_RECORD")?;
    for (key, value) in [
        ("terminal_id", &scope.terminal_id),
        ("terminalId", &scope.terminal_id),
        ("branch_id", &scope.branch_id),
        ("branchId", &scope.branch_id),
        ("organization_id", &scope.organization_id),
    ] {
        if data.get(key).is_some_and(|v| v != value) {
            return Err("PROTECTED_RECORD".into());
        }
    }
    if [
        "orders",
        "payments",
        "order_payments",
        "payment_adjustments",
        "payment",
    ]
    .contains(&table)
    {
        let order_id = if table == "orders" {
            r["record_id"].as_str()
        } else {
            data["orderId"].as_str().or(data["order_id"].as_str())
        }
        .ok_or("PROTECTED_RECORD")?;
        let order = row(c, "orders", order_id)?;
        if order["order_context"]
            .as_str()
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("repair_settlement"))
            || ["conflict", "processing"].contains(&order["sync_status"].as_str().unwrap_or(""))
        {
            return Err("PROTECTED_RECORD".into());
        }
        if financial {
            let payment = row(c, "order_payments", field(r, "entity_id")?)?;
            if payment["order_id"] != order_id {
                return Err("PROTECTED_RECORD".into());
            }
        }
        if order["organization_id"] != scope.organization_id
            || order["branch_id"] != scope.branch_id
            || order["terminal_id"] != scope.terminal_id
        {
            return Err("PROTECTED_RECORD".into());
        }
        super::confirmed_sql::protected_links(c, Some(&order), None)?;
    } else if ["staff_shifts", "cash_drawer_sessions"].contains(&table) {
        let record = row(c, table, field(r, "record_id")?)?;
        let shift = if table == "staff_shifts" {
            record
        } else {
            if record["branch_id"] != scope.branch_id || record["terminal_id"] != scope.terminal_id
            {
                return Err("PROTECTED_RECORD".into());
            }
            row(c, "staff_shifts", field(&record, "staff_shift_id")?)?
        };
        if shift["branch_id"] != scope.branch_id || shift["terminal_id"] != scope.terminal_id {
            return Err("PROTECTED_RECORD".into());
        }
        super::confirmed_sql::protected_links(c, None, Some(field(&shift, "id")?))?;
    } else if financial {
        return Err("POLICY_REFUSED".into());
    } else {
        guards::eligible(c, "parity_sync_queue", r, scope)?;
    }
    Ok(())
}
fn not_claimed(c: &Connection, id: &str) -> Result<(), String> {
    let claimed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_set_aside WHERE queue_id=? AND z_report_id IS NOT NULL)",[id],|r|r.get(0)).map_err(guards::error)?;
    if claimed {
        return Err("PROTECTED_RECORD".into());
    }
    Ok(())
}
struct Effects {
    count: std::sync::Arc<std::sync::atomic::AtomicU64>,
    protected: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Effects {
    fn install(c: &Connection) -> Self {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;
        let count = Arc::new(AtomicU64::new(0));
        let protected = Arc::new(AtomicBool::new(false));
        let n = count.clone();
        let denied = protected.clone();
        c.update_hook(Some(
            move |action: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                if table != "support_txn_marker" {
                    n.fetch_add(1, Ordering::AcqRel);
                }
                if [
                    "z_reports",
                    "ecr_transactions",
                    "gift_card_fiscal_operations",
                ]
                .contains(&table)
                    || (table.contains("audit") && action != rusqlite::hooks::Action::SQLITE_INSERT)
                {
                    denied.store(true, Ordering::Release);
                }
            },
        ));
        Self { count, protected }
    }
}
fn changes(_c: &Connection, before: &Effects, cap: u64) -> Result<usize, String> {
    use std::sync::atomic::Ordering;
    let n = before.count.load(Ordering::Acquire);
    if n > cap || before.protected.load(Ordering::Acquire) {
        return Err("POLICY_REFUSED".into());
    }
    Ok(n as usize)
}

pub fn run(
    store: &Connection,
    live: &Path,
    c: &Command,
    scope: &Scope,
    now: i64,
    permit: &SupportPermit,
    snap: &snapshot::Snapshot,
    recheck: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let action = &c.payload["action"];
    let input = &action["inputs"];
    let id = field(action, "action_id")?;
    let cap = c.payload["rows_cap"]
        .as_u64()
        .filter(|n| (1..=50).contains(n))
        .ok_or("INVALID_INPUT")?;
    let conn = Connection::open_with_flags(
        live,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(guards::error)?;
    conn.busy_timeout(Duration::from_millis(100))
        .map_err(guards::error)?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(guards::error)?;
    permit.guard_connection(&conn, Instant::now() + Duration::from_secs(2));
    // Scope is re-resolved on this connection, never accepted from the command.
    if super::identity::local(&conn)? != *scope {
        return Err("PAYLOAD_DRIFT".into());
    }
    let before = Effects::install(&conn);

    recheck()?;
    let post = std::cell::RefCell::new(None::<Value>);
    let start = Instant::now();
    permit.guard_connection(&conn, start + Duration::from_millis(250));
    let db = crate::db::DbState {
        conn: std::sync::Mutex::new(conn),
        db_path: live.to_path_buf(),
    };
    let mut evidence;
    let mut affected = Vec::new();
    let mut pending = false;
    let mut group = false;
    if id == "shift.close_stuck.v1" {
        let shift = field(input, "shift_id")?;
        let drawer = &input["drawer"];
        let check = |conn: &Connection, after: bool| -> Result<(), String> {
            recheck()?;
            if !after
                && !conn.is_autocommit()
                && snapshot::watermarks_for_write(conn, permit, start + Duration::from_millis(250))?
                    != snap.full
            {
                return Err("PAYLOAD_DRIFT".into());
            }
            if super::identity::local(conn)? != *scope {
                return Err("PAYLOAD_DRIFT".into());
            }
            if permit.is_cancelled() {
                return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
            }
            let r = row(conn, "staff_shifts", shift)?;
            if r["branch_id"] != scope.branch_id
                || r["terminal_id"] != scope.terminal_id
                || r["status"] != if after { "closed" } else { "active" }
            {
                return Err("PROTECTED_RECORD".into());
            }
            super::confirmed_sql::no_submitted_close(conn, shift)?;
            if crate::shifts::gift_opening_key_for_shift(conn, shift)?.is_some() {
                return Err("POLICY_REFUSED".into());
            }
            let drawers = guards::rows(
                conn,
                "SELECT * FROM cash_drawer_sessions WHERE staff_shift_id=?",
                &[shift.to_string().into()],
            )?;
            if drawer["kind"] == "none" {
                if !drawers.is_empty()
                    || !crate::shifts::is_non_financial_shift_role(
                        r["role_type"].as_str().unwrap_or(""),
                    )
                    || r["opening_cash_amount_cents"].as_i64().unwrap_or(1) != 0
                {
                    return Err("POLICY_REFUSED".into());
                }
            } else {
                if drawers.len() != 1
                    || drawers[0]["id"] != drawer["drawer_session_id"]
                    || drawer["closing_card_cents"] != 0
                    || drawer["closing_other_cents"] != 0
                    || !["cashier", "manager"].contains(&r["role_type"].as_str().unwrap_or(""))
                {
                    return Err("POLICY_REFUSED".into());
                }
                if !after {
                    let active:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM staff_shifts WHERE branch_id=? AND terminal_id=? AND id<>? AND status='active' AND role_type IN ('driver','server','waiter'))",params![scope.branch_id,scope.terminal_id,shift],|r|r.get(0)).map_err(guards::error)?;
                    if active {
                        return Err("POLICY_REFUSED".into());
                    }
                }
                if after {
                    if drawers[0]["closed_at"].is_null()
                        || drawers[0]["closing_amount_cents"] != drawer["closing_cash_cents"]
                    {
                        return Err("PAYLOAD_DRIFT".into());
                    }
                } else if !drawers[0]["closed_at"].is_null() {
                    return Err("POLICY_REFUSED".into());
                }
            }
            if after {
                changes(conn, &before, cap)?;
                if !conn.is_autocommit() {
                    conn.execute(
                        "INSERT INTO support_txn_marker VALUES(?,?)",
                        params![c.command_id, clock::iso(now)],
                    )
                    .map_err(guards::error)?;
                    *post.borrow_mut() = Some(snapshot::watermarks_for_write(
                        conn,
                        permit,
                        start + Duration::from_millis(250),
                    )?);
                    recheck()?;
                }
            }
            Ok(())
        };
        {
            let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
            check(&conn, false)?;
        }
        let result = crate::shifts::close_shift_with_support(
            &db,
            &json!({"shiftId":shift,"closingCash":drawer["closing_cash_cents"].as_i64().unwrap_or(0) as f64/100.0}),
            Some(&check),
        ).map_err(|e|if e.starts_with("commit:"){"OUTCOME_UNKNOWN".to_string()}else{e})?;
        if result["success"] != true {
            return Err("POLICY_REFUSED".into());
        }
        let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        check(&conn, true).map_err(|_| "OUTCOME_UNKNOWN")?;
        evidence = json!({"kind":"shift","shift_id":shift,"status":"closed","drawer":if drawer["kind"]=="none"{json!({"kind":"none"})}else{let mut d=drawer.clone();d["closed"]=json!(true);d}});
        affected.push(shift.to_string());
        if let Some(drawer) = drawer["drawer_session_id"].as_str() {
            affected.push(drawer.to_string());
        }
        pending = true;
    } else {
        let queue_id = field(input, "queue_id")?;
        let financial = input["queue"] == "financial";
        let table = if financial {
            "sync_queue"
        } else {
            "parity_sync_queue"
        };
        let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
        let tx = permit.begin_write(&conn)?;
        if super::identity::local(&conn)? != *scope {
            return Err("PAYLOAD_DRIFT".into());
        }
        if snapshot::watermarks_for_write(&conn, permit, start + Duration::from_millis(250))?
            != snap.full
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        let root = row(&conn, table, queue_id)?;
        queue_scope(&conn, &root, scope, financial)?;
        if ["processing", "in_flight", "conflict", "synced", "completed"]
            .contains(&root["status"].as_str().unwrap_or(""))
        {
            return Err("POLICY_REFUSED".into());
        }
        let mut members = vec![queue_id.to_string()];
        if id == "queue.set_aside.v1" {
            if financial {
                return Err("POLICY_REFUSED".into());
            }
            let mut index = 0;
            while index < members.len() {
                for dependent in
                    crate::sync_queue::rows_waiting_on_queue_row(&conn, &members[index])?
                {
                    if !members.contains(&dependent) {
                        members.push(dependent)
                    }
                }
                if members.len() as u64 > cap {
                    return Err("POLICY_REFUSED".into());
                }
                index += 1;
            }
            if let Some(parent) = input["waiting_on_set_aside_queue_id"].as_str() {
                if !crate::sync_queue::queue_row_is_set_aside(&conn, parent)?
                    || !crate::sync_queue::rows_waiting_on_queue_row(&conn, parent)?
                        .contains(&queue_id.to_string())
                {
                    return Err("POLICY_REFUSED".into());
                }
                queue_scope(&conn, &row(&conn, table, parent)?, scope, false)?;
            }
        } else if id == "queue.return_to_queue.v1" {
            if financial {
                return Err("POLICY_REFUSED".into());
            }
            let retained:Option<(String,String,String)>=store.query_row("SELECT members_json,session_id,command_id FROM support_confirmed_groups WHERE root_id=? AND returned_at IS NULL",[queue_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|"POLICY_REFUSED")?;
            if let Some((encoded, session, command)) = retained {
                members = serde_json::from_str(&encoded).map_err(|_| "POLICY_REFUSED")?;
                for member in &members {
                    let actor: String = conn
                    .query_row(
                        "SELECT set_aside_by_staff_id FROM parity_sync_set_aside WHERE queue_id=?",
                        [member],
                        |r| r.get(0),
                    )
                    .map_err(|_| "POLICY_REFUSED")?;
                    if actor != format!("support:{session}:{command}") {
                        return Err("POLICY_REFUSED".into());
                    }
                }
            } else {
                members = crate::sync_queue::retained_set_aside_group(&conn, queue_id)?;
            }
        } else if id != "queue.retry_row.v1" {
            return Err("INVALID_INPUT".into());
        }
        if members.is_empty() || members.len() as u64 > cap {
            return Err("POLICY_REFUSED".into());
        }
        let mut originals = BTreeMap::new();
        for member in &members {
            let r = row(&conn, table, member)?;
            queue_scope(&conn, &r, scope, financial)?;
            if !financial {
                not_claimed(&conn, member)?;
            }
            originals.insert(member.clone(), r);
        }
        let actor = format!("support:{}:{}", c.session_id, c.command_id);
        if id == "queue.retry_row.v1" {
            if !["failed", "blocked"].contains(&root["status"].as_str().unwrap_or("")) {
                return Err("POLICY_REFUSED".into());
            }
            let error = root[if financial {
                "last_error"
            } else {
                "error_message"
            }]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase();
            if error.contains("waiting") || error.contains("parent") || error.contains("conflict") {
                return Err("POLICY_REFUSED".into());
            }
            if financial {
                let payload: Value = serde_json::from_str(field(&root, "payload")?)
                    .map_err(|_| "PROTECTED_RECORD")?;
                let order = payload["orderId"]
                    .as_str()
                    .or(payload["order_id"].as_str())
                    .ok_or("PROTECTED_RECORD")?;
                let blocked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE organization_id=? AND table_name='orders' AND record_id=? AND status IN ('pending','processing','failed','conflict'))",params![scope.organization_id,order],|r|r.get(0)).map_err(guards::error)?;
                if blocked {
                    return Err("POLICY_REFUSED".into());
                }
                drop(tx);
                drop(conn);
                let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
                conn.execute_batch("BEGIN IMMEDIATE")
                    .map_err(guards::error)?;
                drop(conn);
                let result: Result<(), String> = (|| {
                    {
                        let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
                        if row(&conn, table, queue_id)? != root
                            || snapshot::watermarks_for_write(
                                &conn,
                                permit,
                                start + Duration::from_millis(250),
                            )? != snap.full
                        {
                            return Err("PAYLOAD_DRIFT".into());
                        }
                    }
                    crate::sync::retry_financial_queue_item(
                        &db,
                        queue_id.parse().map_err(|_| "INVALID_INPUT")?,
                    )?;
                    let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
                    recheck()?;
                    let after = row(&conn, table, queue_id)?;
                    if payload_hash(&root) != payload_hash(&after) || after["status"] != "pending" {
                        return Err("PAYLOAD_DRIFT".into());
                    }
                    changes(&conn, &before, cap)?;
                    if permit.is_cancelled() {
                        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
                    }
                    conn.execute(
                        "INSERT INTO support_txn_marker VALUES(?,?)",
                        params![c.command_id, clock::iso(now)],
                    )
                    .map_err(guards::error)?;
                    *post.borrow_mut() = Some(snapshot::watermarks_for_write(
                        &conn,
                        permit,
                        start + Duration::from_millis(250),
                    )?);
                    recheck()?;
                    conn.execute_batch("COMMIT")
                        .map_err(|_| "OUTCOME_UNKNOWN")?;
                    Ok(())
                })();
                if result.is_err() {
                    if let Ok(conn) = db.conn.lock() {
                        let _ = conn.execute_batch("ROLLBACK");
                    }
                }
                result?;
                let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
                let after = row(&conn, table, queue_id)?;
                if payload_hash(&root) != payload_hash(&after) || after["status"] != "pending" {
                    return Err("OUTCOME_UNKNOWN".into());
                }
                evidence = json!({"kind":"queue","queue_id":queue_id,"disposition":"due","rows":[{"queue_id":queue_id,"set_aside":false,"before_payload_sha256":payload_hash(&root),"after_payload_sha256":payload_hash(&after)}]});
                affected = members;
                pending = true;
            } else {
                crate::sync_queue::support_retry_dependencies_ready(&conn, queue_id)?;
                crate::sync_queue::retry_item(&conn, queue_id)?;
                pending = true;
                evidence = queue_evidence(&conn, table, queue_id, "due", false, &originals)?;
                finish_tx(
                    &conn, tx, c, now, permit, start, &recheck, &before, cap, &post,
                )?;
                affected = members;
            }
        } else {
            for member in &members {
                let r = originals.get(member).ok_or("INTERNAL_ERROR")?;
                if r["status"] == "conflict" || r["status"] == "processing" {
                    return Err("POLICY_REFUSED".into());
                }
                if id == "queue.set_aside.v1" {
                    crate::sync_queue::set_aside_queue_row(
                        &conn,
                        member,
                        &actor,
                        "founder_confirmed",
                    )?;
                } else {
                    crate::sync_queue::undo_set_aside(&conn, member, &actor)?;
                }
            }
            group = id == "queue.set_aside.v1";
            evidence = queue_evidence(
                &conn,
                table,
                queue_id,
                if group { "set_aside" } else { "failed" },
                group,
                &originals,
            )?;
            if group {
                store.execute("INSERT INTO support_confirmed_groups(root_id,session_id,command_id,members_json,returned_at) VALUES(?,?,?,?,NULL) ON CONFLICT(root_id) DO UPDATE SET session_id=excluded.session_id,command_id=excluded.command_id,members_json=excluded.members_json,returned_at=NULL",params![queue_id,c.session_id,c.command_id,serde_json::to_string(&members).map_err(|_|"INTERNAL_ERROR")?]).map_err(guards::error)?;
            }
            finish_tx(
                &conn, tx, c, now, permit, start, &recheck, &before, cap, &post,
            )?;
            affected = members;
            if !group {
                store
                    .execute(
                        "UPDATE support_confirmed_groups SET returned_at=? WHERE root_id=?",
                        params![clock::iso(now), queue_id],
                    )
                    .map_err(guards::error)?;
            }
        }
    }
    let conn = db.conn.lock().map_err(|_| "INTERNAL_ERROR")?;
    conn.progress_handler(0, None::<fn() -> bool>);
    let changed = changes(&conn, &before, cap).map_err(|_| "OUTCOME_UNKNOWN")?;
    if evidence["kind"] == "queue" {
        let table = if input["queue"] == "financial" {
            "sync_queue"
        } else {
            "parity_sync_queue"
        };
        for item in evidence["rows"].as_array().ok_or("OUTCOME_UNKNOWN")? {
            let qid = item["queue_id"].as_str().ok_or("OUTCOME_UNKNOWN")?;
            let fresh = row(&conn, table, qid).map_err(|_| "OUTCOME_UNKNOWN")?;
            if payload_hash(&fresh) != item["after_payload_sha256"]
                || (table == "parity_sync_queue"
                    && crate::sync_queue::queue_row_is_set_aside(&conn, qid)
                        .map_err(|_| "OUTCOME_UNKNOWN")?
                        != item["set_aside"])
            {
                return Err("OUTCOME_UNKNOWN".into());
            }
        }
        if pending {
            let fresh =
                row(&conn, table, field(input, "queue_id")?).map_err(|_| "OUTCOME_UNKNOWN")?;
            if ["processing", "in_flight"].contains(&fresh["status"].as_str().unwrap_or("")) {
                evidence["disposition"] = json!("in_flight");
            } else if fresh["status"] != "pending" {
                return Err("OUTCOME_UNKNOWN".into());
            }
        }
    }
    super::confirmed::save_post(
        store,
        &snap.id,
        post.borrow().as_ref().ok_or("OUTCOME_UNKNOWN")?,
    )?;
    Ok(
        json!({"step":"action","kind":"untrusted_till_data","outcome":if pending{"pending"}else{"resolved"},"observation_time":clock::iso(now+start.elapsed().as_millis() as i64),"snapshot_id":snap.id,"snapshot":snapshot::metadata(store,&snap.id).map_err(|_|"OUTCOME_UNKNOWN")?,"affected_ids":affected,"changed_rows":changed,"verification":{"fresh":true,"matches_expected":true,"sync":if pending{"pending"}else{"not_applicable"}},"evidence":evidence,"undo":{"kind":if group{"set_aside_group"}else{"snapshot"},"reference":if group{input["queue_id"].clone()}else{json!(snap.id)},"reason":null}}),
    )
}
fn finish_tx(
    conn: &Connection,
    tx: rusqlite::Transaction<'_>,
    c: &Command,
    now: i64,
    permit: &SupportPermit,
    start: Instant,
    recheck: &impl Fn() -> Result<(), String>,
    before: &Effects,
    cap: u64,
    post: &std::cell::RefCell<Option<Value>>,
) -> Result<(), String> {
    changes(conn, before, cap)?;
    recheck()?;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    if start.elapsed() > Duration::from_millis(250) {
        return Err("QUERY_TIMEOUT".into());
    }
    conn.execute(
        "INSERT INTO support_txn_marker VALUES(?,?)",
        params![c.command_id, clock::iso(now)],
    )
    .map_err(guards::error)?;
    *post.borrow_mut() = Some(snapshot::watermarks_for_write(
        conn,
        permit,
        start + Duration::from_millis(250),
    )?);
    recheck()?;
    tx.commit().map_err(|_| "OUTCOME_UNKNOWN".into())
}
fn queue_evidence(
    conn: &Connection,
    table: &str,
    root: &str,
    disposition: &str,
    set_aside: bool,
    originals: &BTreeMap<String, Value>,
) -> Result<Value, String> {
    let mut rows = Vec::new();
    for (id, before) in originals {
        let after = row(conn, table, id)?;
        if payload_hash(before) != payload_hash(&after)
            || crate::sync_queue::queue_row_is_set_aside(conn, id)? != set_aside
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        if disposition == "due" && (after["status"] != "pending" || after["attempts"] != 0) {
            return Err("PAYLOAD_DRIFT".into());
        }
        rows.push(json!({"queue_id":id,"set_aside":set_aside,"before_payload_sha256":payload_hash(before),"after_payload_sha256":payload_hash(&after)}));
    }
    Ok(json!({"kind":"queue","queue_id":root,"disposition":disposition,"rows":rows}))
}
