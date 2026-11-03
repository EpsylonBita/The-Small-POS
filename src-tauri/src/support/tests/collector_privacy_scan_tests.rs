//! Value-based privacy regression: never infer privacy from field names alone.
use crate::support::{collectors, critical_op, network, replica, sql_query};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub(crate) const PRIVATE: &[&str] = &[
    "PrivStaffIdQuokka",
    "PrivStaffNameQuokka",
    "PrivCustomerQuokka",
    "+493012345679",
    "PrivAddressQuokka",
    "PrivNoteQuokka",
];

pub(crate) fn seed(db: &crate::tests::harness::TestDb) {
    let c = db.state.conn.lock().unwrap();
    crate::db::set_setting(&c, "terminal", "organization_id", "your-test-org").unwrap();
    crate::db::set_setting(&c, "terminal", "branch_id", "your-test-branch").unwrap();
    crate::db::set_setting(&c, "terminal", "terminal_id", "your-test-terminal").unwrap();
    crate::db::set_setting(
        &c,
        "staff",
        "directory",
        &json!({"staff_id":PRIVATE[0],"staff_name":PRIVATE[1],"notes":PRIVATE[5]}).to_string(),
    )
    .unwrap();
    crate::db::set_setting(&c, "terminal", "private_note", PRIVATE[5]).unwrap();
    c.execute("INSERT INTO staff_sessions(id,staff_id,pin_hash) VALUES('your-test-session',?1,'your-test-pin')", [PRIVATE[0]]).unwrap();
    c.execute("INSERT INTO staff_shifts(id,staff_id,staff_name,role_type,branch_id,terminal_id,check_in_time,created_at,updated_at,notes,currency) VALUES('your-test-shift',?1,?2,'driver','your-test-branch','your-test-terminal','2026-11-01 08:00:00','2026-11-01 08:00:00','2026-11-01 08:00:00',?3,'EUR')",rusqlite::params![PRIVATE[0],PRIVATE[1],PRIVATE[5]]).unwrap();
    c.execute("INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,opened_at,created_at,updated_at,reconciliation_notes,currency) VALUES('your-test-drawer','your-test-shift',?1,'your-test-branch','your-test-terminal','2026-11-01 08:00:00','2026-11-01 08:00:00','2026-11-01 08:00:00',?2,'EUR')",rusqlite::params![PRIVATE[0],PRIVATE[5]]).unwrap();
    c.execute("INSERT INTO orders(id,customer_name,customer_phone,delivery_address,delivery_notes,staff_id,branch_id,currency) VALUES('your-test-order',?1,?2,?3,?4,?5,'your-test-branch','EUR')",rusqlite::params![PRIVATE[2],PRIVATE[3],PRIVATE[4],PRIVATE[5],PRIVATE[0]]).unwrap();
    c.execute("INSERT INTO loyalty_customers(id,user_profile_id,organization_id,customer_name,customer_phone) VALUES('your-test-customer','your-test-user','your-test-org',?1,?2)",rusqlite::params![PRIVATE[2],PRIVATE[3]]).unwrap();
    c.execute("INSERT INTO parity_sync_queue(id,table_name,record_id,operation,data,organization_id,error_message,status) VALUES('your-test-queue','orders','your-test-order','INSERT',?1,'your-test-org',?2,'failed')",rusqlite::params![json!({"customer_name":PRIVATE[2],"notes":PRIVATE[5]}).to_string(),PRIVATE.join(" ")]).unwrap();
    c.execute("INSERT INTO printer_profiles(id,name,printer_name,driver_type,printer_type,created_at,updated_at) VALUES('your-test-printer','Front printer','your-test-printer','escpos','network','2026-11-01','2026-11-01')",[]).unwrap();
    c.execute("INSERT INTO print_jobs(id,entity_type,entity_id,printer_profile_id,status,last_error,entity_payload_json,created_at,updated_at) VALUES('your-test-job','order_receipt','your-test-order','your-test-printer','failed',?1,?2,'2026-11-01 09:00:00','2026-11-01 09:01:00')",rusqlite::params![PRIVATE.join(" "),json!({"staff_id":PRIVATE[0],"notes":PRIVATE[5]}).to_string()]).unwrap();
    c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    std::fs::write(db.dir().join("module-cache.json"),json!({"organizationId":"your-test-org","apiModules":[{"module_id":"orders","version":"1"}],"apiTimestamp":"2026-11-01T00:00:00Z"}).to_string()).unwrap();
    let logs = db.dir().join("support-log-fixture");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("pos.log"),format!("2026-11-01T00:00:00Z WARN the_small_pos_lib::sync: Parity sync failed: AUTH_LOCKED_OUT {}\n", PRIVATE.join(" "))).unwrap();
}

pub(crate) fn outputs(
    db: &crate::tests::harness::TestDb,
    permit: &critical_op::SupportPermit,
) -> Vec<(String, Value)> {
    let read = replica::read_connection(
        db.db_path(),
        permit,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    assert!(read.is_readonly(rusqlite::DatabaseName::Main).unwrap());
    let mut out = Vec::new();
    for (name, value) in [
        ("till_health", collectors::health::collect(&read)),
        ("till_settings", collectors::settings::collect(&read)),
        ("till_shifts", collectors::shifts::collect(&read, permit)),
        ("till_modules", collectors::modules::collect(&read)),
        ("till_printers", collectors::printers::collect(&read)),
        (
            "till_sync_queue",
            collectors::sync_queue::collect(&read, permit),
        ),
        (
            "till_logs",
            collectors::logs::collect(&db.dir().join("support-log-fixture"), &json!({}), permit),
        ),
        (
            "till_error_codes",
            collectors::error_codes::collect_from(
                &db.dir().join("support-log-fixture"),
                &json!({}),
                permit,
            ),
        ),
    ] {
        out.push((
            name.into(),
            collectors::meta(value.unwrap_or_else(|e| panic!("{name}: {e}"))).unwrap(),
        ));
    }
    for section in [
        "about",
        "system_health",
        "sync_backlog",
        "payment_adjustment_backlog",
        "terminal_settings_snapshot",
        "closeout_readiness",
        "financial_queue_status",
        "printer_diagnostics",
        "sync_errors",
        "health_view",
        "terminal_context",
        "sync_status",
        "parity_queue_status",
        "parity_actionable_items",
        "parity_failure_families",
        "financial_queue_items",
        "financial_integrity",
        "last_parity_sync",
        "credential_state",
        "sync_blocker_details",
        "runtime_logs",
        "diagnostics_manifest",
    ] {
        out.push((
            format!("till_diagnostics_bundle/{section}"),
            collectors::meta(
                collectors::diagnostics::collect(&read, &json!({"section":section}), permit)
                    .unwrap(),
            )
            .unwrap(),
        ));
    }
    let r = replica::build(db.db_path(), permit).unwrap();
    out.push(("till_sql_schema".into(),collectors::meta(json!({"database":"main","replica_taken_at":r.taken_at,"sqlite_version":rusqlite::version(),"tables":r.schema})).unwrap()));
    out.push(("till_sql_query".into(),collectors::meta(sql_query::query(&r,&json!({"sql":"SELECT customer_name,customer_phone,delivery_address,delivery_notes,staff_id FROM orders"}),permit).unwrap()).unwrap()));
    out.push(("till_sql_refresh_replica".into(),collectors::meta(json!({"replica_taken_at":r.taken_at,"databases":["main"],"build_ms":0,"size_bytes":std::fs::metadata(&r.path).unwrap().len()})).unwrap()));
    // Pure projection and injected scan: no OS adapter discovery or device I/O.
    let interfaces = network::info::parse(
        json!([{ "id":3,"name":"Ethernet","virtual":false,"up":true,"kind":"ethernet","ipv4":[{"address":"192.168.1.1","prefix":30}],"gateway":"192.168.1.2","dns":[] }]),
    );
    out.push(("till_network_info".into(),collectors::meta(json!({"interfaces":interfaces,"network_name":"not_collected","support_server":{"reachable":false,"rtt_ms":null}})).unwrap()));
    struct Offline;
    impl network::scan::Connector for Offline {
        fn probe(
            &self,
            _: std::net::Ipv4Addr,
            _: u16,
            _: Instant,
            _: &critical_op::SupportPermit,
        ) -> network::scan::Reply {
            network::scan::Reply {
                open: false,
                mat_ecr: false,
            }
        }
    }
    out.push((
        "till_network_scan".into(),
        collectors::meta(
            network::scan::sweep(
                &json!({"port_groups":["printers"]}),
                &interfaces,
                &mut network::DiscoveryState::default(),
                permit,
                &Offline,
            )
            .unwrap(),
        )
        .unwrap(),
    ));
    let (_, _, _, request) = network::identify::request(
        &json!({"ip":"192.168.1.2","port":10009}),
        &network::DiscoveryState::default(),
        &[("192.168.1.2".into(), 10009)],
    )
    .unwrap();
    let mut reply = b"\x02000000\x1c1.0\x1cyour-device-serial\x03".to_vec();
    reply.push(reply[1..].iter().fold(0, |a, b| a ^ b));
    out.push((
        "till_network_identify/parsed".into(),
        collectors::meta(network::identify::parse_binary("pax_a00", &request, &reply).unwrap())
            .unwrap(),
    ));
    out
}

#[test]
fn every_tier_one_projection_excludes_seeded_private_values() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _test_gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    seed(&db);
    let before = std::fs::read(db.db_path()).unwrap();
    let gate = critical_op::CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let read = replica::read_connection(
        db.db_path(),
        &permit,
        Instant::now() + Duration::from_secs(5),
    )
    .unwrap();
    let source = crate::diagnostics::support_closeout_readiness(&read, &permit).unwrap();
    assert!(
        source.to_string().contains(PRIVATE[0]),
        "fixture must exercise the leaking readiness source"
    );
    let mut leaks = Vec::new();
    for (tool, value) in outputs(&db, &permit) {
        let text = value.to_string();
        let lower = text.to_lowercase();
        for private in PRIVATE {
            if text.contains(private) || lower.contains(&private.to_lowercase()) {
                leaks.push(format!("{tool}: {private}"));
            }
        }
        if tool == "till_printers" {
            let printer = &value["printers"][0];
            for at in [
                &printer["last_print_error_at"],
                &printer["recent_jobs"][0]["at"],
            ] {
                chrono::DateTime::parse_from_rfc3339(at.as_str().unwrap()).unwrap();
            }
        }
        if tool == "till_shifts" {
            assert!(value["closeout_readiness"].get("observation").is_none());
            assert_eq!(value["open_shifts"][0]["staff"], "redacted");
            chrono::DateTime::parse_from_rfc3339(
                value["open_shifts"][0]["opened_at"].as_str().unwrap(),
            )
            .unwrap();
            chrono::DateTime::parse_from_rfc3339(
                value["drawer_sessions"][0]["opened_at"].as_str().unwrap(),
            )
            .unwrap();
        }
        assert_eq!(
            before,
            std::fs::read(db.db_path()).unwrap(),
            "{tool} changed business data"
        );
    }
    assert!(
        leaks.is_empty(),
        "Private values escaped: {}",
        leaks.join(", ")
    );
}

#[test]
fn persisted_dates_are_utc_rfc3339_or_absent() {
    for (input, expected) in [
        ("2026-11-01 09:15:16", Some("2026-11-01T09:15:16+00:00")),
        (
            "2026-11-01 09:15:16.123",
            Some("2026-11-01T09:15:16.123+00:00"),
        ),
        (
            "2026-11-01T09:15:16+02:00",
            Some("2026-11-01T09:15:16+02:00"),
        ),
        ("2026-02-30 09:15:16", None),
        ("not a date", None),
        ("", None),
    ] {
        assert_eq!(collectors::timestamp(&json!(input)).as_deref(), expected);
    }
    assert_eq!(collectors::timestamp(&Value::Null), None);
}

#[tokio::test]
async fn rotated_key_is_absent_from_audit_support_outputs_replica_and_database_bytes() {
    use crate::support::key_rotation as rotation;
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    const ROTATED: &str = "your-rotated-privacy-api-key";
    crate::storage::seed_terminal_credential_for_test(
        "pos_api_key",
        "your-current-privacy-api-key",
    )
    .unwrap();
    struct Sender;
    impl rotation::Sender for Sender {
        fn send<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            method: &'a str,
            _: Option<Value>,
        ) -> rotation::ReplyFuture<'a> {
            Box::pin(async move {
                if method == "GET" {
                    let mut reply = super::route_contract_tests::golden("pos-key-rotation")
                        ["cases"][1]["response"]
                        .clone();
                    reply["new_api_key"] = json!(ROTATED);
                    Ok(reply)
                } else {
                    Ok(
                        super::route_contract_tests::golden("pos-key-rotation-confirm")["cases"][0]
                            ["response"]
                            .clone(),
                    )
                }
            })
        }
    }
    let f = super::route_contract_tests::Fixture::new();
    rotation::attempt(&Sender, &f.rt, rotation::Crash::None)
        .await
        .unwrap();
    let core = f.rt.core.lock().unwrap();
    let audit = crate::support::audit_local::pending(&core.executor.db.conn).unwrap();
    assert!(!serde_json::to_string(&audit).unwrap().contains(ROTATED));
    core.executor
        .db
        .conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let bytes = std::fs::read(&core.executor.db.path).unwrap();
    assert!(!bytes
        .windows(ROTATED.len())
        .any(|w| w == ROTATED.as_bytes()));
    drop(core);
    let db = crate::tests::harness::TestDb::open();
    seed(&db);
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .unwrap();
    for (_, value) in outputs(&db, &permit) {
        assert!(!value.to_string().contains(ROTATED));
    }
    let replica = replica::build(db.db_path(), &permit).unwrap();
    let bytes = std::fs::read(&replica.path).unwrap();
    assert!(!bytes
        .windows(ROTATED.len())
        .any(|w| w == ROTATED.as_bytes()));
    assert!(!format!("{:?}", rotation::Failure::Storage).contains(ROTATED));
}
