//! Selected recovery for a close misclassified as a first-dispatch refusal.
//! Confirmation reads canonical state; it never sends a force-close or changes money.
use crate::table_session_cache::Scope;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin};

#[derive(Clone, Debug, PartialEq)]
struct Original {
    id: String,
    session: String,
    organization: String,
    raw: String,
    error: String,
    version: i64,
    generation: i64,
}

fn same_scope(a: &Scope, b: &Scope) -> bool {
    a.organization == b.organization
        && a.branch == b.branch
        && a.terminal == b.terminal
        && a.owner == b.owner
}

fn select_original(conn: &Connection, id: &str, scope: &Scope) -> Result<Option<Original>, String> {
    if !same_scope(scope, &crate::table_session_cache::current_scope(conn)?) {
        return Ok(None);
    }
    let original = conn.query_row(
        "SELECT q.id,q.record_id,q.organization_id,q.data,q.error_message,q.version,q.claim_generation
         FROM parity_sync_queue q JOIN conflict_audit_log a ON a.id='table-mutation-terminal:'||q.id
         WHERE q.id=?1 AND q.organization_id=?2 AND q.table_name='restaurant_table_sessions'
           AND q.operation='UPDATE' AND q.module_type='table_service' AND q.status='failed' AND q.attempts=1
           AND a.entity_id=q.id AND a.entity_type='table_batch_original'
           AND a.resolution='TABLE_MUTATION_FIRST_DISPATCH_REFUSED' AND a.reviewed_by_operator=0
           AND a.is_monetary=0 AND a.discarded_payload=q.data AND a.local_version=q.version",
        params![id, scope.organization], |r| Ok(Original {id:r.get(0)?,session:r.get(1)?,organization:r.get(2)?,raw:r.get(3)?,error:r.get(4)?,version:r.get(5)?,generation:r.get(6)?})
    ).optional().map_err(|_| "TABLE_CLOSE_ORIGINAL_READ_FAILED")?;
    let Some(original) = original else {
        return Ok(None);
    };
    if uuid::Uuid::parse_str(&original.session).is_err()
        || !original
            .error
            .starts_with("HTTP 409: TABLE_MUTATION_FIRST_DISPATCH_REFUSED ")
        || !original
            .error
            .contains("Cannot close a table session with outstanding money")
    {
        return Ok(None);
    }
    let payload: Value = match serde_json::from_str(&original.raw) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let matches = |key: &str, value: &str| payload.get(key).and_then(Value::as_str) == Some(value);
    if !matches("action", "close")
        || !matches("status", "closed")
        || !matches("organization_id", &scope.organization)
        || !matches("organizationId", &scope.organization)
        || !matches("branch_id", &scope.branch)
        || !matches("branchId", &scope.branch)
        || !matches("terminal_id", &scope.terminal)
        || !matches("terminalId", &scope.terminal)
        || payload
            .get("client_event_id")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
    {
        return Ok(None);
    }
    Ok(Some(original))
}

fn validate_confirmation(
    original: &Original,
    scope: &Scope,
    reply: &Value,
) -> Result<Value, String> {
    if reply.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("TABLE_CLOSE_CONFIRMATION_UNAVAILABLE".into());
    }
    let session = reply
        .get("session")
        .ok_or("TABLE_CLOSE_CONFIRMATION_UNAVAILABLE")?;
    let revision = crate::table_session_cache::validate(scope, session)?;
    let order = &session["order"];
    if session["id"].as_str() != Some(original.session.as_str())
        || session["status"].as_str() != Some("closed")
        || original.organization != scope.organization
    {
        return Err("TABLE_CLOSE_CONFIRMATION_SCOPE_CHANGED".into());
    }
    // loadSessionDetails scopes its order query by organization and branch,
    // but its allocated order DTO intentionally omits those columns. Refuse
    // conflicting explicit fields if a newer server supplies them. The current
    // parent session may differ after a transfer; only the selected historical
    // session's ended state is confirmed, without applying a table projection.
    for (key, expected) in [
        ("organization_id", scope.organization.as_str()),
        ("branch_id", scope.branch.as_str()),
    ] {
        if order
            .get(key)
            .is_some_and(|value| value.as_str() != Some(expected))
        {
            return Err("TABLE_CLOSE_CONFIRMATION_SCOPE_CHANGED".into());
        }
    }
    uuid::Uuid::parse_str(
        order["id"]
            .as_str()
            .ok_or("TABLE_CLOSE_ORDER_IDENTITY_REQUIRED")?,
    )
    .map_err(|_| "TABLE_CLOSE_ORDER_IDENTITY_REQUIRED")?;
    let closed = session["closed_at"]
        .as_str()
        .ok_or("TABLE_CLOSE_CONFIRMATION_NOT_ENDED")?;
    chrono::DateTime::parse_from_rfc3339(closed)
        .map_err(|_| "TABLE_CLOSE_CONFIRMATION_NOT_ENDED")?;
    // A fully refunded, already closed check may show a positive balance. The
    // canonical ended state is authoritative; no payment or physical table is changed.
    Ok(
        json!({"sessionId":original.session,"revision":revision,"closedAt":closed,
        "orderId":order["id"],"organizationId":scope.organization,"branchId":scope.branch,
        "terminalId":scope.terminal,"ownerTerminalId":scope.owner,"generation":original.generation}),
    )
}

fn finish_confirmation(
    conn: &Connection,
    original: &Original,
    scope: &Scope,
    reply: &Value,
    snapshot_id: &str,
) -> Result<(), String> {
    if snapshot_id.trim().is_empty() {
        return Err("TABLE_CLOSE_FULL_SNAPSHOT_REQUIRED".into());
    }
    let mut proof = validate_confirmation(original, scope, reply)?;
    proof["snapshotId"] = json!(snapshot_id);
    proof["remedyVersion"] = json!(1);
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| "TABLE_CLOSE_CONFIRMATION_WRITE_FAILED")?;
    if select_original(&transaction, &original.id, scope)?.as_ref() != Some(original) {
        return Err("TABLE_CLOSE_ORIGINAL_CHANGED".into());
    }
    transaction.execute("INSERT INTO conflict_audit_log
        (id,operation_type,entity_id,entity_type,local_version,server_version,timestamp,discarded_payload,resolution,is_monetary,reviewed_by_operator)
        VALUES(?1,'UPDATE',?2,'table_close_confirmation',?3,?4,datetime('now'),?5,'TABLE_SESSION_CLOSE_CANONICAL_ALREADY_ENDED',0,1)",
        params![format!("table-close-confirmed:{}",original.id),original.id,original.version,proof["revision"].as_i64(),
            json!({"originalQueuedPayload":original.raw,"confirmation":proof}).to_string()])
        .map_err(|_| "TABLE_CLOSE_CONFIRMATION_WRITE_FAILED")?;
    let reviewed = transaction.execute("UPDATE conflict_audit_log SET reviewed_by_operator=1
        WHERE id=?1 AND discarded_payload=?2 AND reviewed_by_operator=0 AND resolution='TABLE_MUTATION_FIRST_DISPATCH_REFUSED'",
        params![format!("table-mutation-terminal:{}",original.id),original.raw]).map_err(|_| "TABLE_CLOSE_CONFIRMATION_WRITE_FAILED")?;
    let removed = transaction.execute("DELETE FROM parity_sync_queue WHERE id=?1 AND organization_id=?2
        AND data=?3 AND version=?4 AND claim_generation=?5 AND status='failed' AND attempts=1 AND error_message=?6",
        params![original.id,original.organization,original.raw,original.version,original.generation,original.error])
        .map_err(|_| "TABLE_CLOSE_CONFIRMATION_WRITE_FAILED")?;
    if reviewed != 1 || removed != 1 {
        return Err("TABLE_CLOSE_ORIGINAL_CHANGED".into());
    }
    transaction
        .commit()
        .map_err(|_| "TABLE_CLOSE_CONFIRMATION_WRITE_FAILED".into())
}

trait Transport: Sync {
    fn get(&self, path: String)
        -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>>;
    fn complete(
        &self,
        original: &Original,
        scope: &Scope,
        reply: &Value,
        snapshot_id: &str,
    ) -> Result<(), String>;
}
struct NativeTransport<'a, 'context>(
    &'a crate::db::DbState,
    &'a crate::sync::RendererParityExecutionContext<'context>,
);
impl Transport for NativeTransport<'_, '_> {
    fn get(
        &self,
        path: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
        Box::pin(async move {
            crate::admin_fetch_detailed(Some(self.0), &path, "GET", None)
                .await
                .map_err(|_| "TABLE_CLOSE_CONFIRMATION_UNAVAILABLE".into())
        })
    }
    fn complete(
        &self,
        original: &Original,
        scope: &Scope,
        reply: &Value,
        snapshot_id: &str,
    ) -> Result<(), String> {
        // Recheck captured binding and current remote auth after GET, holding
        // the fresh lease through the selected audit and queue transaction.
        self.1
            .run_local_step(|conn| finish_confirmation(conn, original, scope, reply, snapshot_id))
    }
}

async fn confirm_original_with_transport(
    db: &crate::db::DbState,
    id: &str,
    transport: &dyn Transport,
) -> Result<bool, String> {
    let (scope, original) = {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "TABLE_CLOSE_ORIGINAL_READ_FAILED")?;
        let scope = crate::table_session_cache::current_scope(&conn)?;
        let original = select_original(&conn, id, &scope)?;
        (scope, original)
    };
    let Some(original) = original else {
        return Ok(false);
    };
    let point = crate::recovery::create_pre_recovery_action_snapshot(db)?;
    {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "TABLE_CLOSE_ORIGINAL_READ_FAILED")?;
        if select_original(&conn, id, &scope)?.as_ref() != Some(&original) {
            return Err("TABLE_CLOSE_ORIGINAL_CHANGED".into());
        }
    }
    let reply = transport
        .get(format!("/api/pos/table-sessions/{}", original.session))
        .await?;
    transport.complete(&original, &scope, &reply, &point.id)?;
    Ok(true)
}

pub(crate) async fn confirm_selected_close(
    db: &crate::db::DbState,
    sync: &crate::sync::SyncState,
    cancellation: &tokio_util::sync::CancellationToken,
    id: &str,
) -> Result<bool, String> {
    let context = crate::sync::RendererParityExecutionContext::new(db, sync, cancellation).await?;
    let _lease = context.acquire_step_lease()?;
    confirm_original_with_transport(db, id, &NativeTransport(db, &context)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;
    const ORG: &str = "11111111-1111-4111-8111-111111111111";
    const BRANCH: &str = "22222222-2222-4222-8222-222222222222";
    const TERMINAL: &str = "33333333-3333-4333-8333-333333333333";
    const SESSION: &str = "44444444-4444-4444-8444-444444444444";
    const ORDER: &str = "55555555-5555-4555-8555-555555555555";
    const ID: &str = "66666666-6666-4666-8666-666666666666";
    fn scope() -> Scope {
        Scope {
            organization: ORG.into(),
            branch: BRANCH.into(),
            terminal: TERMINAL.into(),
            owner: TERMINAL.into(),
        }
    }
    fn original() -> Original {
        Original { id:ID.into(),session:SESSION.into(),organization:ORG.into(),
            raw:json!({"action":"close","status":"closed","force":true,"release_status":"cleaning",
                "organization_id":ORG,"organizationId":ORG,"branch_id":BRANCH,"branchId":BRANCH,
                "terminal_id":TERMINAL,"terminalId":TERMINAL,"client_event_id":"original-close"}).to_string(),
            error:"HTTP 409: TABLE_MUTATION_FIRST_DISPATCH_REFUSED Cannot close a table session with outstanding money".into(),
            version:1,generation:1 }
    }
    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        seed(&conn);
        conn
    }
    fn seed(conn: &Connection) {
        crate::sync_queue::create_tables(&conn).unwrap();
        for (k, v) in [
            ("__ignore_keyring", "1"),
            ("organization_id", ORG),
            ("branch_id", BRANCH),
            ("terminal_id", TERMINAL),
            ("owner_terminal_db_id", TERMINAL),
        ] {
            crate::db::set_setting(&conn, "terminal", k, v).unwrap();
        }
        let o = original();
        conn.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,created_at,attempts,error_message,module_type,version,claim_generation,status)
            VALUES(?1,'restaurant_table_sessions',?2,'UPDATE',?3,?4,datetime('now'),1,?5,'table_service',1,1,'failed')",params![o.id,o.session,o.raw,o.organization,o.error]).unwrap();
        conn.execute("INSERT INTO conflict_audit_log(id,operation_type,entity_id,entity_type,local_version,server_version,timestamp,discarded_payload,resolution,is_monetary,reviewed_by_operator)
            VALUES(?1,'UPDATE',?2,'table_batch_original',1,1,datetime('now'),?3,'TABLE_MUTATION_FIRST_DISPATCH_REFUSED',0,0)",params![format!("table-mutation-terminal:{ID}"),ID,o.raw]).unwrap();
        conn.execute_batch("CREATE TABLE money_witness(id TEXT,amount INTEGER); INSERT INTO money_witness VALUES('original-receipt',4200);").unwrap();
    }
    fn reply() -> Value {
        json!({"success":true,"session":{"id":SESSION,"organization_id":ORG,"branch_id":BRANCH,"status":"closed",
            "closed_at":"2026-10-10T07:00:00Z","snapshot_revision":7,"active_order_id":ORDER,
            "order":{"id":ORDER,"owner_terminal_id":TERMINAL,"table_session_id":"77777777-7777-4777-8777-777777777777","order_items":[]},
            "balance":{"order_total":10.5,"paid_total":0,"outstanding_balance":10.5,"tip_total":0},
            "payments":[],"items":[],"tables":[{"id":"reused-table","is_active":false,"table":{"status":"occupied","active_session_id":"new-check"}}]}})
    }
    #[test]
    fn selects_only_the_exact_scoped_frozen_misclassified_close() {
        let conn = connection();
        assert_eq!(
            select_original(&conn, ID, &scope()).unwrap(),
            Some(original())
        );
        let mut foreign = scope();
        foreign.branch = "foreign".into();
        assert!(select_original(&conn, ID, &foreign).unwrap().is_none());
        conn.execute("UPDATE parity_sync_queue SET data=data||' '", [])
            .unwrap();
        assert!(select_original(&conn, ID, &scope()).unwrap().is_none());
    }
    #[test]
    fn confirms_a_closed_refunded_check_without_releasing_a_reused_table() {
        let proof = validate_confirmation(&original(), &scope(), &reply()).unwrap();
        assert_eq!(proof["sessionId"], SESSION);
        assert_eq!(proof["revision"], 7);
    }
    #[test]
    fn rejects_open_foreign_incomplete_and_invalid_canonical_answers() {
        for path in [
            "/success",
            "/session/id",
            "/session/organization_id",
            "/session/branch_id",
            "/session/closed_at",
            "/session/snapshot_revision",
            "/session/active_order_id",
            "/session/order/id",
            "/session/order/owner_terminal_id",
            "/session/items",
            "/session/payments",
            "/session/tables",
            "/session/order/order_items",
            "/session/balance/paid_total",
        ] {
            let mut v = reply();
            *v.pointer_mut(path).unwrap() = Value::Null;
            assert!(
                validate_confirmation(&original(), &scope(), &v).is_err(),
                "{path}"
            );
        }
        for state in ["open", "paid", "partially_paid", "cancelled", "merged"] {
            let mut v = reply();
            v["session"]["status"] = json!(state);
            assert!(validate_confirmation(&original(), &scope(), &v).is_err());
        }
    }
    #[test]
    fn allocated_order_dto_keeps_session_scope_and_refuses_conflicting_explicit_parent_scope() {
        let canonical = reply();
        assert!(canonical["session"]["order"]
            .get("organization_id")
            .is_none());
        assert!(canonical["session"]["order"].get("branch_id").is_none());
        assert_ne!(canonical["session"]["order"]["table_session_id"], SESSION);
        assert!(validate_confirmation(&original(), &scope(), &canonical).is_ok());
        for key in ["organization_id", "branch_id"] {
            for value in [json!(ORDER), Value::Null] {
                let mut invalid = canonical.clone();
                invalid["session"]["order"][key] = value;
                assert!(
                    validate_confirmation(&original(), &scope(), &invalid).is_err(),
                    "{key}"
                );
            }
        }
        let mut foreign_original = original();
        foreign_original.organization = ORDER.into();
        assert!(validate_confirmation(&foreign_original, &scope(), &canonical).is_err());
    }
    #[test]
    fn completes_only_the_selected_original_and_preserves_its_frozen_audit_and_money() {
        let conn = connection();
        let o = original();
        conn.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,created_at,attempts,error_message,module_type,version,claim_generation,status)
            SELECT 'other-intent',table_name,record_id,operation,data,organization_id,created_at,attempts,error_message,module_type,version,claim_generation,status FROM parity_sync_queue WHERE id=?1", [ID]).unwrap();
        finish_confirmation(&conn, &o, &scope(), &reply(), "full-before-recovery").unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM parity_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT data FROM parity_sync_queue WHERE id='other-intent'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            o.raw
        );
        let (raw, reviewed): (String, i64) = conn
            .query_row(
                "SELECT discarded_payload,reviewed_by_operator FROM conflict_audit_log WHERE id=?1",
                [format!("table-mutation-terminal:{ID}")],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(raw, o.raw);
        assert_eq!(reviewed, 1);
        let proof: String = conn
            .query_row(
                "SELECT discarded_payload FROM conflict_audit_log WHERE id=?1",
                [format!("table-close-confirmed:{ID}")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&proof).unwrap()["confirmation"]["snapshotId"],
            "full-before-recovery"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&proof).unwrap()["originalQueuedPayload"],
            o.raw
        );
        assert_eq!(
            conn.query_row("SELECT amount FROM money_witness", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4200
        );
    }
    #[test]
    fn stale_claim_or_missing_snapshot_cannot_retire_the_original() {
        for stale in [false, true] {
            let conn = connection();
            let o = original();
            if stale {
                conn.execute("UPDATE parity_sync_queue SET claim_generation=2", [])
                    .unwrap();
            }
            assert!(finish_confirmation(
                &conn,
                &o,
                &scope(),
                &reply(),
                if stale { "full-before-recovery" } else { "" }
            )
            .is_err());
            assert_eq!(
                conn.query_row("SELECT count(*) FROM parity_sync_queue", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM conflict_audit_log", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }

    struct Fake<'a> {
        db: &'a crate::db::DbState,
        calls: std::sync::Mutex<Vec<String>>,
        change: &'static str,
    }
    impl Transport for Fake<'_> {
        fn get(
            &self,
            path: String,
        ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
            Box::pin(async move {
                // This is the actual disk restore point owner, before the HTTP step.
                assert_eq!(
                    crate::recovery::list_recovery_points(self.db)
                        .unwrap()
                        .len(),
                    1
                );
                self.calls.lock().unwrap().push(path);
                let conn = self.db.conn.lock().unwrap();
                match self.change {
                    "generation" => {
                        conn.execute("UPDATE parity_sync_queue SET claim_generation=2", [])
                            .unwrap();
                    }
                    "body" => {
                        conn.execute("UPDATE parity_sync_queue SET data=data||' '", [])
                            .unwrap();
                    }
                    "owner" => {
                        crate::db::set_setting(&conn, "terminal", "owner_terminal_db_id", ORDER)
                            .unwrap();
                    }
                    "offline" => return Err("TABLE_CLOSE_CONFIRMATION_UNAVAILABLE".into()),
                    _ => {}
                }
                Ok(reply())
            })
        }
        fn complete(
            &self,
            original: &Original,
            scope: &Scope,
            reply: &Value,
            snapshot_id: &str,
        ) -> Result<(), String> {
            if self.change == "auth" {
                return Err("REMOTE_AUTH_PAUSED".into());
            }
            let conn = self.db.conn.lock().unwrap();
            finish_confirmation(&conn, original, scope, reply, snapshot_id)
        }
    }
    #[tokio::test]
    async fn restart_confirmation_is_one_get_after_full_snapshot_and_is_idempotent() {
        let disk = crate::tests::harness::TestDb::open();
        seed(&disk.state.conn.lock().unwrap());
        let disk = disk.restart();
        let transport = Fake {
            db: &disk.state,
            calls: std::sync::Mutex::new(Vec::new()),
            change: "",
        };
        assert!(confirm_original_with_transport(&disk.state, ID, &transport)
            .await
            .unwrap());
        assert!(
            !confirm_original_with_transport(&disk.state, ID, &transport)
                .await
                .unwrap()
        );
        assert_eq!(
            *transport.calls.lock().unwrap(),
            vec![format!("/api/pos/table-sessions/{SESSION}")]
        );
        let points = crate::recovery::list_recovery_points(&disk.state).unwrap();
        assert_eq!(points.len(), 1);
        let audit: String = disk
            .state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT discarded_payload FROM conflict_audit_log WHERE id=?1",
                [format!("table-close-confirmed:{ID}")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&audit).unwrap()["confirmation"]["snapshotId"],
            points[0].id
        );
    }
    #[tokio::test]
    async fn snapshot_failure_prevents_network_and_preserves_original() {
        let disk = crate::tests::harness::TestDb::open();
        seed(&disk.state.conn.lock().unwrap());
        std::fs::write(
            crate::recovery::recovery_root_for_db(&disk.state),
            b"blocked-test-restore-root",
        )
        .unwrap();
        let transport = Fake {
            db: &disk.state,
            calls: std::sync::Mutex::new(Vec::new()),
            change: "",
        };
        assert!(confirm_original_with_transport(&disk.state, ID, &transport)
            .await
            .is_err());
        assert!(transport.calls.lock().unwrap().is_empty());
        assert_eq!(
            select_original(&disk.state.conn.lock().unwrap(), ID, &scope()).unwrap(),
            Some(original())
        );
    }
    #[tokio::test]
    async fn uncertain_get_or_original_change_cannot_clear_any_intent() {
        for change in ["offline", "generation", "body", "owner", "auth"] {
            let disk = crate::tests::harness::TestDb::open();
            seed(&disk.state.conn.lock().unwrap());
            let transport = Fake {
                db: &disk.state,
                calls: std::sync::Mutex::new(Vec::new()),
                change,
            };
            assert!(
                confirm_original_with_transport(&disk.state, ID, &transport)
                    .await
                    .is_err(),
                "{change}"
            );
            let conn = disk.state.conn.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT count(*) FROM parity_sync_queue", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM conflict_audit_log", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                conn.query_row("SELECT amount FROM money_witness", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                4200
            );
        }
    }
}
