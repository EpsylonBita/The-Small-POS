use crate::support::{
    confirmed, confirmed_actions, confirmed_sql, contracts,
    critical_op::{self, CriticalKind},
    db::SupportDb,
    guards::Scope,
    snapshot,
};
use serde_json::{json, Value};

const SHIFT: &str = "b0000000-0000-4000-a000-000000000001";
fn scope() -> Scope {
    Scope {
        organization_id: "your-org".into(),
        branch_id: "your-branch".into(),
        terminal_id: "your-terminal".into(),
    }
}
fn fixture() -> crate::tests::harness::TestDb {
    let db = crate::tests::harness::TestDb::open();
    {
        let c = db.state.conn.lock().unwrap();
        for (key, value) in [
            ("organization_id", "your-org"),
            ("branch_id", "your-branch"),
            ("terminal_id", "your-terminal"),
        ] {
            crate::db::set_setting(&c, "terminal", key, value).unwrap();
        }
        crate::db::set_setting(&c, "terminal", "__ignore_keyring", "1").unwrap();
        for (key, value) in [
            ("store_currency_branch_id", "your-branch"),
            ("store_currency_available", "true"),
            ("store_currency_source", "branch_country"),
            ("currency", "EUR"),
        ] {
            crate::db::set_setting(&c, "restaurant", key, value).unwrap();
        }
        c.execute("INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,check_in_time,status,currency,opening_cash_amount,opening_cash_amount_cents,created_at,updated_at) VALUES(?,'your-staff','your-branch','your-terminal','kitchen','2026-11-11T12:00:00Z','active','EUR',0,0,'2026-11-11T12:00:00Z','2026-11-11T12:00:00Z')",[SHIFT]).unwrap();
        c.execute("INSERT INTO orders(id,order_number,items,total_amount,total_amount_cents,status,order_type,payment_status,sync_status,branch_id,terminal_id,staff_shift_id,staff_id,currency,created_at,updated_at) VALUES('your-order','your-order','[]',10,1000,'pending','takeaway','pending','pending','your-branch','your-terminal',?,'your-staff','EUR','2026-11-11T12:00:00Z','2026-11-11T12:00:00Z')",[SHIFT]).unwrap();
        c.execute(
            "UPDATE orders SET organization_id='your-org' WHERE id='your-order'",
            [],
        )
        .unwrap();
        c.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,module_type,status,attempts,error_message,created_at) VALUES('your-row','orders','your-order','UPDATE','{\"orderId\":\"your-order\"}','your-org','orders','failed',1,'HTTP_422_CLIENT_ERROR','2026-11-11T12:00:00Z')",[]).unwrap();
    }
    db
}
fn command(action: &str, inputs: Value) -> contracts::Command {
    let mut c = super::delivery_tests::command();
    c.command_id = uuid::Uuid::new_v4().to_string();
    c.idempotency_key = uuid::Uuid::new_v4().to_string();
    c.kind = confirmed::KIND.into();
    c.tier = 3;
    c.approval = None;
    c.payload = json!({"mode":"founder_conversation","idempotency_key":c.idempotency_key,"step":"action","explanation":"Retry the blocked row on this till","reason":"The store needs to finish its work","founder_confirmed":true,"action":{"action_id":action,"version":1,"inputs":inputs},"rows_cap":50});
    c.payload_sha256 = contracts::payload_hash(&c.payload);
    c
}
fn action(
    db: &crate::tests::harness::TestDb,
    store: &SupportDb,
    c: &contracts::Command,
) -> Result<Value, String> {
    let gate = critical_op::global();
    let reader = gate
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let snap = snapshot::take(
        &store.conn,
        &db.state.db_path,
        &c.session_id,
        None,
        "pre_command",
        &reader,
    )?;
    drop(reader);
    let writer = gate.try_begin_support(true, None).map_err(str::to_string)?;
    confirmed_actions::run(
        &store.conn,
        &db.state.db_path,
        c,
        &scope(),
        chrono::Utc::now().timestamp_millis(),
        &writer,
        &snap,
        || Ok(()),
    )
}
#[test]
fn support_confirmed_admission_requires_explicit_authority_confirmation_and_idempotency() {
    let c = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    assert_eq!(confirmed::validate(&c, false), Err("TIER_NOT_ALLOWED"));
    assert!(confirmed::validate(&c, true).is_ok());
    for key in [
        "mode",
        "founder_confirmed",
        "idempotency_key",
        "reason",
        "explanation",
    ] {
        let mut bad = c.clone();
        bad.payload[key] = Value::Null;
        assert!(confirmed::validate(&bad, true).is_err(), "{key}");
    }
    let mut bad = c.clone();
    bad.approval = Some(json!({}));
    assert!(confirmed::validate(&bad, true).is_err());
}
#[test]
fn support_confirmed_owner_retry_is_pending_and_preserves_payload() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let result = action(
        &db,
        &store,
        &command("queue.retry_row.v1", json!({"queue_id":"your-row"})),
    )
    .unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(result["outcome"], "pending");
    assert_eq!(result["verification"]["sync"], "pending");
    assert_eq!(
        result["evidence"]["rows"][0]["before_payload_sha256"],
        result["evidence"]["rows"][0]["after_payload_sha256"]
    );
}

#[test]
fn support_confirmed_undo_baseline_excludes_a_sale_after_commit_before_persistence() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let path = db.state.db_path.clone();
    confirmed::before_post_save_for_test(move || {
        // Checkout starts immediately after the support COMMIT. Persisting the
        // captured watermark must never read this newer business state.
        let _checkout = critical_op::begin_critical(CriticalKind::Checkout);
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute("INSERT INTO orders(id,order_number,items,total_amount,total_amount_cents,status,order_type,payment_status,sync_status,branch_id,terminal_id,currency,created_at,updated_at) VALUES('your-later-sale','your-later-sale','[]',10,1000,'pending','takeaway','pending','pending','your-branch','your-terminal','EUR','2026-11-13T12:00:00Z','2026-11-13T12:00:00Z')", []).unwrap();
    });
    let result = action(
        &db,
        &store,
        &command("queue.retry_row.v1", json!({"queue_id":"your-row"})),
    )
    .unwrap();
    let snap = snapshot::load(&store.conn, result["snapshot_id"].as_str().unwrap()).unwrap();
    assert_eq!(
        crate::support::restore::validate(&store.conn, &db.state.conn.lock().unwrap(), &snap),
        Err("RESTORE_WOULD_LOSE_SALES".into())
    );
}

#[test]
fn support_confirmed_refuses_full_snapshot_drift_even_when_cheap_watermark_is_unchanged() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let c = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    let gate = critical_op::global();
    let reader = gate.try_begin_support(false, None).unwrap();
    let snap = snapshot::take(
        &store.conn,
        &db.state.db_path,
        &c.session_id,
        None,
        "pre_command",
        &reader,
    )
    .unwrap();
    drop(reader);
    {
        let conn = db.state.conn.lock().unwrap();
        conn.execute(
            "UPDATE orders SET total_amount=11,total_amount_cents=1100 WHERE id='your-order'",
            [],
        )
        .unwrap();
        assert_eq!(snapshot::cheap_watermark(&conn).unwrap(), snap.cheap);
    }
    let writer = gate.try_begin_support(true, None).unwrap();
    assert_eq!(
        confirmed_actions::run(
            &store.conn,
            &db.state.db_path,
            &c,
            &scope(),
            chrono::Utc::now().timestamp_millis(),
            &writer,
            &snap,
            || Ok(())
        ),
        Err("PAYLOAD_DRIFT".into())
    );
    assert_eq!(
        db.state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id='your-row'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "failed"
    );
}
#[test]
fn support_confirmed_group_sets_aside_order_edit_with_money_and_returns_originals() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    db.state.conn.lock().unwrap().execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,module_type,status,attempts,error_message,created_at) VALUES('your-money','payments','your-pay','INSERT','{\"orderId\":\"your-order\"}','your-org','payment','pending',0,'Waiting for parent order sync','2026-11-11T12:01:00Z')",[]).unwrap();
    let result = action(
        &db,
        &store,
        &command(
            "queue.set_aside.v1",
            json!({"queue_id":"your-row","include_dependents":true}),
        ),
    )
    .unwrap();
    assert_eq!(result["evidence"]["rows"].as_array().unwrap().len(), 2);
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(result["outcome"], "resolved");
    let result = action(
        &db,
        &store,
        &command("queue.return_to_queue.v1", json!({"queue_id":"your-row"})),
    )
    .unwrap();
    assert!(result["evidence"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["set_aside"] == false));
    assert_eq!(
        db.state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id='your-row'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "failed"
    );
}
#[test]
fn support_confirmed_cap_and_critical_operations_refuse_without_changing_a_row() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    for kind in [
        CriticalKind::Checkout,
        CriticalKind::Card,
        CriticalKind::ShiftClose,
        CriticalKind::ZClose,
    ] {
        let token = critical_op::global().begin_critical(kind);
        assert!(action(
            &db,
            &store,
            &command("queue.retry_row.v1", json!({"queue_id":"your-row"}))
        )
        .is_err());
        drop(token);
    }
    let mut c = command(
        "queue.set_aside.v1",
        json!({"queue_id":"your-row","include_dependents":true}),
    );
    c.payload["rows_cap"] = json!(1);
    assert!(action(&db, &store, &c).is_err());
    assert!(
        !crate::sync_queue::queue_row_is_set_aside(&db.state.conn.lock().unwrap(), "your-row")
            .unwrap()
    );
}
#[test]
fn support_confirmed_sql_bound_proposal_and_protected_target_refusals() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let gate = critical_op::global();
    let reader = gate.try_begin_support(false, None).unwrap();
    let mut c = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    c.payload = json!({"mode":"founder_conversation","step":"sql_dry_run","idempotency_key":c.idempotency_key,"explanation":"Schedule the row for another attempt","reason":"The last network request did not finish","proposal":{"database":"main","sql":"UPDATE parity_sync_queue SET attempts=? WHERE id=?","params":[0,"your-row"],"rows_cap":1,"expected_rows":[{"table":"parity_sync_queue","inserted":0,"updated":1,"deleted":0}]}});
    let queued = confirmed_sql::dry(
        &store.conn,
        &db.state.db_path,
        &c,
        &scope(),
        chrono::Utc::now().timestamp_millis(),
        &reader,
    )
    .unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&queued);
    c.command_id = uuid::Uuid::new_v4().to_string();
    // Also exercise bound strings through the reviewed operational setting.
    {
        let conn = db.state.conn.lock().unwrap();
        crate::db::set_setting(&conn, "local", "printer_last_known_brand:your-host", "old")
            .unwrap();
    }
    c.payload["proposal"] = json!({"database":"main","sql":"UPDATE local_settings SET setting_value=? WHERE setting_category=? AND setting_key=?","params":["new","local","printer_last_known_brand:your-host"],"rows_cap":1,"expected_rows":[{"table":"local_settings","inserted":0,"updated":1,"deleted":0}]});
    let result = confirmed_sql::dry(
        &store.conn,
        &db.state.db_path,
        &c,
        &scope(),
        chrono::Utc::now().timestamp_millis(),
        &reader,
    )
    .unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(
        result["dry_run"]["payload_sha256"],
        contracts::payload_hash(&c.payload["proposal"])
    );
    assert_eq!(
        db.state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT attempts FROM parity_sync_queue WHERE id='your-row'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    for sql in [
        "UPDATE order_payments SET amount=2",
        "UPDATE order_payments SET method='card'",
        "UPDATE z_reports SET status='submitted'",
        "UPDATE gift_card_fiscal_operations SET amount=2",
        "UPDATE local_settings SET setting_value='your-placeholder' WHERE setting_key='api_key'",
        "UPDATE financial_audit_log SET action='your-placeholder'",
        "UPDATE support_audit_local SET outcome='your-placeholder'",
        "UPDATE parity_sync_queue SET attempts=?1 WHERE id=?2",
        "UPDATE parity_sync_queue SET attempts=(SELECT count(*) FROM orders)",
    ] {
        c.command_id = uuid::Uuid::new_v4().to_string();
        c.payload["proposal"]["sql"] = json!(sql);
        assert!(
            confirmed_sql::dry(
                &store.conn,
                &db.state.db_path,
                &c,
                &scope(),
                chrono::Utc::now().timestamp_millis(),
                &reader
            )
            .is_err(),
            "{sql}"
        );
    }
}

#[test]
fn support_confirmed_shift_owner_closes_zero_float_kitchen_and_refuses_stale_or_invented_drawer() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let bad = command(
        "shift.close_stuck.v1",
        json!({"shift_id":SHIFT,"drawer":{"kind":"counted","drawer_session_id":"b0000000-0000-4000-a000-000000000002","closing_cash_cents":0,"closing_card_cents":1,"closing_other_cents":0}}),
    );
    assert!(action(&db, &store, &bad).is_err());
    let good = command(
        "shift.close_stuck.v1",
        json!({"shift_id":SHIFT,"drawer":{"kind":"none"}}),
    );
    let result = action(&db, &store, &good).unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(result["outcome"], "pending");
    assert_eq!(result["evidence"]["status"], "closed");
    assert!(action(
        &db,
        &store,
        &command(
            "shift.close_stuck.v1",
            json!({"shift_id":SHIFT,"drawer":{"kind":"none"}})
        )
    )
    .is_err());
}

#[test]
fn support_confirmed_sql_receipt_params_expiry_and_consumption_are_bound() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    {
        let conn = db.state.conn.lock().unwrap();
        crate::db::set_setting(&conn, "local", "printer_last_known_brand:your-host", "old")
            .unwrap();
    }
    let mut source = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    source.payload = json!({"mode":"founder_conversation","step":"sql_dry_run","idempotency_key":source.idempotency_key,"explanation":"Correct the remembered printer brand","reason":"The printer was identified during support","proposal":{"database":"main","sql":"UPDATE local_settings SET setting_value=? WHERE setting_category=? AND setting_key=?","params":["new","local","printer_last_known_brand:your-host"],"rows_cap":1,"expected_rows":[{"table":"local_settings","inserted":0,"updated":1,"deleted":0}]}});
    source.payload_sha256 = contracts::payload_hash(&source.payload);
    let now = chrono::Utc::now().timestamp_millis();
    let gate = critical_op::global();
    let reader = gate.try_begin_support(false, None).unwrap();
    let dry = confirmed_sql::dry(
        &store.conn,
        &db.state.db_path,
        &source,
        &scope(),
        now,
        &reader,
    )
    .unwrap();
    drop(reader);
    let mut receipt = json!({"command_id":source.command_id,"session_id":source.session_id,"status":"completed","outcome":"succeeded","data":dry});
    receipt["result_sha256"] = json!(contracts::payload_hash(&receipt));
    store.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,idempotency_key,accepted_at,finished_at,state,envelope_json,result_json) VALUES(?,?,1,?,?,?,?,?,'finished',?,?)",rusqlite::params![source.command_id,source.session_id,source.kind,source.payload_sha256,source.idempotency_key,crate::support::clock::iso(now),crate::support::clock::iso(now),serde_json::to_string(&source).unwrap(),receipt.to_string()]).unwrap();
    let mut execute = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    execute.payload = json!({"mode":"founder_conversation","step":"sql_execute","idempotency_key":execute.idempotency_key,"explanation":"Correct the remembered printer brand","reason":"The founder agreed to this exact change","founder_confirmed":true,"proposal":source.payload["proposal"],"dry_run_command_id":source.command_id,"dry_run_result_sha256":receipt["result_sha256"],"binding":{"dry_run_id":dry["dry_run"]["dry_run_id"],"target_key_sha256":dry["dry_run"]["target_key_sha256"],"proposal_sha256":dry["dry_run"]["payload_sha256"],"expires_at":dry["dry_run"]["expires_at"]}});
    let apply = |command: &contracts::Command| {
        let reader = gate.try_begin_support(false, None).unwrap();
        let snap = snapshot::take(
            &store.conn,
            &db.state.db_path,
            &command.session_id,
            None,
            "pre_command",
            &reader,
        )
        .unwrap();
        drop(reader);
        let writer = gate.try_begin_support(true, None).unwrap();
        confirmed_sql::execute(
            &store.conn,
            &db.state.db_path,
            command,
            &scope(),
            chrono::Utc::now().timestamp_millis(),
            &writer,
            &snap,
            || Ok(()),
        )
    };
    for change in ["receipt", "params", "expiry"] {
        let mut bad = execute.clone();
        match change {
            "receipt" => bad.payload["dry_run_result_sha256"] = json!("0".repeat(64)),
            "params" => bad.payload["proposal"]["params"][0] = json!("other"),
            _ => bad.payload["binding"]["expires_at"] = json!("2000-01-01T00:00:00.000Z"),
        };
        assert!(apply(&bad).is_err(), "{change}");
    }
    let result = apply(&execute).unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(result["outcome"], "resolved");
    assert!(apply(&execute).is_err());
    assert_eq!(db.state.conn.lock().unwrap().query_row("SELECT setting_value FROM local_settings WHERE setting_category='local' AND setting_key='printer_last_known_brand:your-host'",[],|r|r.get::<_,String>(0)).unwrap(),"new");
}

#[test]
fn support_confirmed_counted_drawer_uses_exact_cash_and_retains_close_sync() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    const DRAWER: &str = "b0000000-0000-4000-a000-000000000002";
    {
        let conn = db.state.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM parity_sync_queue;DELETE FROM orders;")
            .unwrap();
        conn.execute(
            "UPDATE staff_shifts SET role_type='cashier' WHERE id=?",
            [SHIFT],
        )
        .unwrap();
        conn.execute("INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,opening_amount,opening_amount_cents,currency,opened_at,created_at,updated_at) VALUES(?,?,'your-staff','your-branch','your-terminal',100,10000,'EUR','2026-11-11T12:00:00Z','2026-11-11T12:00:00Z','2026-11-11T12:00:00Z')",rusqlite::params![DRAWER,SHIFT]).unwrap();
    }
    let result=action(&db,&store,&command("shift.close_stuck.v1",json!({"shift_id":SHIFT,"drawer":{"kind":"counted","drawer_session_id":DRAWER,"closing_cash_cents":5000,"closing_card_cents":0,"closing_other_cents":0}}))).unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(result["outcome"], "pending");
    assert_eq!(result["evidence"]["drawer"]["closing_cash_cents"], 5000);
    assert_eq!(
        db.state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT closing_amount_cents FROM cash_drawer_sessions WHERE id=?",
                [DRAWER],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        5000
    );
}

#[test]
fn support_confirmed_financial_retry_refuses_unready_parent_then_schedules_without_payment_changes()
{
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let queue = {
        let conn = db.state.conn.lock().unwrap();
        conn.execute("INSERT INTO order_payments(id,order_id,method,amount,currency,status,sync_status,created_at,updated_at) VALUES('your-payment','your-order','cash',10,'EUR','completed','failed','2026-11-11T12:00:00Z','2026-11-11T12:00:00Z')",[]).unwrap();
        conn.execute("INSERT INTO sync_queue(entity_type,entity_id,operation,payload,status,retry_count,created_at,updated_at,idempotency_key) VALUES('payment','your-payment','insert','{\"orderId\":\"your-order\",\"paymentId\":\"your-payment\"}','failed',2,'2026-11-11T12:00:00Z','2026-11-11T12:00:00Z','your-financial-retry')",[]).unwrap();
        conn.last_insert_rowid().to_string()
    };
    assert!(action(
        &db,
        &store,
        &command(
            "queue.retry_row.v1",
            json!({"queue":"financial","queue_id":queue})
        )
    )
    .is_err());
    {
        let conn = db.state.conn.lock().unwrap();
        conn.execute("UPDATE orders SET supabase_id='b0000000-0000-4000-a000-000000000003',sync_status='synced' WHERE id='your-order'",[]).unwrap();
        conn.execute("DELETE FROM parity_sync_queue", []).unwrap();
    }
    let result = action(
        &db,
        &store,
        &command(
            "queue.retry_row.v1",
            json!({"queue":"financial","queue_id":queue}),
        ),
    )
    .unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(result["outcome"], "pending");
    assert_eq!(
        db.state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT amount,method FROM order_payments WHERE id='your-payment'",
                [],
                |r| Ok((r.get::<_, f64>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
        (10.0, "cash".into())
    );
}

#[test]
fn support_confirmed_availability_requires_exact_consent_switch_tier_tool_and_freshness() {
    let good = json!({"available":true,"min_protocol_version":1,"confirmed_commands":true,"tiers_enabled":[1,2,3],"disabled_tools":[],"consent":{"state":"valid","text_version":"1.1"}});
    assert!(confirmed::availability_ok(&good, Some(0)));
    for (field, value) in [
        ("available", json!(false)),
        ("confirmed_commands", json!(false)),
        ("min_protocol_version", json!(2)),
        ("tiers_enabled", json!([1, 2])),
        ("disabled_tools", json!([confirmed::KIND])),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        assert!(!confirmed::availability_ok(&bad, Some(0)), "{field}");
    }
    for version in ["1.0", "1.2", "2.0", ""] {
        let mut bad = good.clone();
        bad["consent"]["text_version"] = json!(version);
        assert!(!confirmed::availability_ok(&bad, Some(0)));
    }
    for state in ["exempt", "withdrawn", "missing", "outdated"] {
        let mut bad = good.clone();
        bad["consent"]["state"] = json!(state);
        assert!(!confirmed::availability_ok(&bad, Some(0)));
    }
    assert!(!confirmed::availability_ok(&good, None));
    assert!(!confirmed::availability_ok(&good, Some(15000)));
}
#[test]
fn support_confirmed_wait_start_refusal_replay_cooldown_and_end_are_durable() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let mut a = super::delivery_tests::admission();
    a.confirmed = true;
    a.tier_ceiling = 3;
    a.tiers_enabled = [1, 2, 3].into();
    store.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES(?,'active',3,?,?,?)",rusqlite::params![a.session_id,a.max_expires_at,a.max_expires_at,a.max_expires_at]).unwrap();
    let mut executor = crate::support::executor::Executor::new(store);
    let clock = super::delivery_tests::clock();
    let c = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    assert!(executor.accept(&c, &a, &clock).unwrap());
    assert!(!executor.accept(&c, &a, &clock).unwrap());
    let mut next = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    next.sequence = c.sequence + 1;
    assert!(!executor.accept(&next, &a, &clock).unwrap());
    executor.start(&c, &a, &clock).unwrap();
    executor
        .fail(&c, "POLICY_REFUSED", clock.now(&a.session_id).unwrap())
        .unwrap();
    let rows = executor
        .db
        .conn
        .prepare("SELECT event FROM support_confirmed_events WHERE command_id=? ORDER BY id")
        .unwrap()
        .query_map([&c.command_id], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            "confirmed_command_waiting",
            "confirmed_command_started",
            "confirmed_command_refused"
        ]
    );
    executor
        .end(&a.session_id, clock.now(&a.session_id).unwrap())
        .unwrap();
    assert!(executor.start(&c, &a, &clock).is_err());
    let path = executor.db.path.clone();
    drop(executor);
    let reopened = SupportDb::open(path.parent().unwrap()).unwrap();
    assert_eq!(
        reopened
            .conn
            .query_row(
                "SELECT count(*) FROM support_confirmed_events WHERE command_id=?",
                [c.command_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        3
    );
}

#[test]
fn support_confirmed_snapshot_undo_stages_through_owner_and_end_revokes_startup_authority() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let gate = critical_op::global();
    let reader = gate.try_begin_support(false, None).unwrap();
    let session = super::delivery_tests::command().session_id;
    let target = snapshot::take(
        &store.conn,
        &db.state.db_path,
        &session,
        None,
        "pre_command",
        &reader,
    )
    .unwrap();
    drop(reader);
    {
        let conn = db.state.conn.lock().unwrap();
        crate::db::set_setting(&conn, "local", "printer_last_known_brand:your-host", "new")
            .unwrap();
        snapshot::post_change(&store.conn, &conn, &target.id).unwrap();
    }
    let c = command(
        "recovery.undo_snapshot.v1",
        json!({"snapshot_id":target.id}),
    );
    let now = crate::support::clock::iso(chrono::Utc::now().timestamp_millis());
    let expiry = "2099-01-01T00:00:00.000Z";
    store.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES(?,'active',3,?,?,?)",rusqlite::params![session,expiry,expiry,now]).unwrap();
    store.conn.execute("INSERT INTO support_accepted_commands(command_id,session_id,sequence,kind,payload_sha256,idempotency_key,accepted_at,started_at,state,envelope_json) VALUES(?,?,1,?,?,?,?,?,'executing',?)",rusqlite::params![c.command_id,c.session_id,c.kind,c.payload_sha256,c.idempotency_key,now,now,serde_json::to_string(&c).unwrap()]).unwrap();
    store
        .conn
        .execute(
            "INSERT INTO support_confirmed_restores VALUES(?,?,1)",
            rusqlite::params![c.command_id, target.id],
        )
        .unwrap();
    crate::support::restore::stage_restore(
        &store.conn,
        &db.state.db_path,
        &target.id,
        &session,
        Some(&c.command_id),
    )
    .unwrap();
    let raw: String = store
        .conn
        .query_row(
            "SELECT result_json FROM support_result_outbox WHERE command_id=?",
            [&c.command_id],
            |r| r.get(0),
        )
        .unwrap();
    let result: Value = serde_json::from_str(&raw).unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result["data"]);
    assert_eq!(result["data"]["outcome"], "pending");
    assert_eq!(result["data"]["evidence"]["state"], "staged_restart");
    let mut executor = crate::support::executor::Executor::new(store);
    executor
        .end(&session, chrono::Utc::now().timestamp_millis())
        .unwrap();
    assert_eq!(
        executor
            .db
            .conn
            .query_row(
                "SELECT status FROM support_session_state WHERE session_id=?",
                [session],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "ended"
    );
}

#[test]
fn support_confirmed_sql_operational_delete_and_implicit_identity_insert_refusal() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    let gate = critical_op::global();
    let reader = gate.try_begin_support(false, None).unwrap();
    let mut c = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    for (sql,params,inserted,deleted)in [("INSERT INTO local_settings(setting_category,setting_key,setting_value,updated_at) VALUES(?,?,?,?)",json!(["local","printer_last_known_brand:your-host","new","2026-11-13T12:00:00Z"]),1,0),("DELETE FROM local_settings WHERE setting_category=? AND setting_key=?",json!(["local","printer_last_known_brand:your-host"]),0,1)]{
        if deleted==1{crate::db::set_setting(&db.state.conn.lock().unwrap(),"local","printer_last_known_brand:your-host","old").unwrap();}
        c.command_id=uuid::Uuid::new_v4().to_string();c.payload=json!({"step":"sql_dry_run","mode":"founder_conversation","idempotency_key":c.idempotency_key,"explanation":"Correct the remembered printer brand","reason":"The founder requested the reviewed change","proposal":{"database":"main","sql":sql,"params":params,"rows_cap":1,"expected_rows":[{"table":"local_settings","inserted":inserted,"updated":0,"deleted":deleted}]}});
        let result=confirmed_sql::dry(&store.conn,&db.state.db_path,&c,&scope(),chrono::Utc::now().timestamp_millis(),&reader);
        if inserted==1{assert!(result.is_err());}else{crate::support::tools::desktop_output_contract_tests::confirmed_result(&result.unwrap());}
    }
    for sql in [
        "INSERT INTO staff_shifts(id) VALUES(?)",
        "DELETE FROM order_payments WHERE id=?",
        "INSERT OR IGNORE INTO local_settings(setting_key) VALUES(?)",
    ] {
        c.payload["proposal"]["sql"] = json!(sql);
        c.payload["proposal"]["params"] = json!(["your-placeholder"]);
        assert!(confirmed_sql::dry(
            &store.conn,
            &db.state.db_path,
            &c,
            &scope(),
            chrono::Utc::now().timestamp_millis(),
            &reader
        )
        .is_err());
    }
}

#[test]
fn support_confirmed_return_accepts_an_existing_health_owner_group() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    crate::sync_queue::set_aside_queue_row(
        &db.state.conn.lock().unwrap(),
        "your-row",
        "your-manager",
        "manager_reviewed",
    )
    .unwrap();
    let result = action(
        &db,
        &store,
        &command("queue.return_to_queue.v1", json!({"queue_id":"your-row"})),
    )
    .unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    assert_eq!(result["outcome"], "resolved");
    assert_eq!(result["evidence"]["rows"][0]["set_aside"], false);
}

#[test]
fn support_confirmed_return_refuses_a_row_a_z_already_lists_and_leaves_it_set_aside() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    {
        let c = db.state.conn.lock().unwrap();
        crate::sync_queue::set_aside_queue_row(&c, "your-row", "your-manager", "manager_reviewed")
            .unwrap();
        c.execute(
            "UPDATE parity_sync_set_aside SET z_report_id='your-z' WHERE queue_id='your-row'",
            [],
        )
        .unwrap();
    }
    let refused = action(
        &db,
        &store,
        &command("queue.return_to_queue.v1", json!({"queue_id":"your-row"})),
    )
    .unwrap_err();
    assert_eq!(refused, "PROTECTED_RECORD");
    let c = db.state.conn.lock().unwrap();
    assert!(crate::sync_queue::queue_row_is_set_aside(&c, "your-row").unwrap());
    assert_eq!(
        c.query_row(
            "SELECT z_report_id FROM parity_sync_set_aside WHERE queue_id='your-row'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "your-z"
    );
}

#[test]
fn support_confirmed_known_operational_retry_and_shift_queue_sql_use_local_scope() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = fixture();
    let store = SupportDb::open(db.state.db_path.parent().unwrap()).unwrap();
    db.state.conn.lock().unwrap().execute("UPDATE parity_sync_queue SET table_name='inventory_items',record_id='your-item',module_type='inventory',data='{}' WHERE id='your-row'", []).unwrap();
    let result = action(
        &db,
        &store,
        &command("queue.retry_row.v1", json!({"queue_id":"your-row"})),
    )
    .unwrap();
    assert_eq!(result["outcome"], "pending");
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    db.state.conn.lock().unwrap().execute("UPDATE parity_sync_queue SET table_name='staff_shifts',record_id=?,module_type='shifts',status='failed',attempts=1 WHERE id='your-row'", [SHIFT]).unwrap();
    let mut c = command("queue.retry_row.v1", json!({"queue_id":"your-row"}));
    c.payload = json!({"mode":"founder_conversation","step":"sql_dry_run","idempotency_key":c.idempotency_key,"explanation":"Schedule the blocked shift queue row","reason":"The founder requested another attempt","proposal":{"database":"main","sql":"UPDATE parity_sync_queue SET attempts=? WHERE id=?","params":[0,"your-row"],"rows_cap":1,"expected_rows":[{"table":"parity_sync_queue","inserted":0,"updated":1,"deleted":0}]}});
    let reader = critical_op::global()
        .try_begin_support(false, None)
        .unwrap();
    let result = confirmed_sql::dry(
        &store.conn,
        &db.state.db_path,
        &c,
        &scope(),
        chrono::Utc::now().timestamp_millis(),
        &reader,
    )
    .unwrap();
    crate::support::tools::desktop_output_contract_tests::confirmed_result(&result);
    db.state
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE staff_shifts SET branch_id='your-other-branch' WHERE id=?",
            [SHIFT],
        )
        .unwrap();
    c.command_id = uuid::Uuid::new_v4().to_string();
    assert!(confirmed_sql::dry(
        &store.conn,
        &db.state.db_path,
        &c,
        &scope(),
        chrono::Utc::now().timestamp_millis(),
        &reader
    )
    .is_err());
}
