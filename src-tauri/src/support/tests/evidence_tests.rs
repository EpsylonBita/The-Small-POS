use crate::support::{
    contracts,
    critical_op::{CriticalKind, CriticalOpGate},
    evidence, replica, screenshot, sql_query,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[test]
fn inputs_require_a_reason_without_ever_authorizing_secrets() {
    assert!(!evidence::personal(&json!({})).unwrap());
    assert!(!evidence::personal(
        &json!({"include_personal_data":false,"reason":"Review the failed order"})
    )
    .unwrap());
    assert!(evidence::personal(
        &json!({"include_personal_data":true,"reason":"  Review the failed order  "})
    )
    .unwrap());
    for input in [
        json!({"include_personal_data":true}),
        json!({"include_personal_data":"true"}),
        json!({"reason":"short"}),
        json!({"reason":"x".repeat(201)}),
        json!({"reason":"Read token=your-secret-value"}),
    ] {
        assert!(evidence::personal(&input).is_err(), "{input}");
    }
    assert_eq!(
        screenshot::input(&json!({"reason":"Review the failed order"}))
            .unwrap()
            .1,
        1280
    );
    for edge in [320, 1280, 1920] {
        assert_eq!(
            screenshot::input(&json!({"reason":"Review the failed order","max_edge":edge}))
                .unwrap()
                .1,
            edge
        );
    }
    for input in [
        json!({}),
        json!({"reason":"short"}),
        json!({"reason":"Review the failed order","max_edge":319}),
        json!({"reason":"Review the failed order","max_edge":1921}),
        json!({"reason":"Review the failed order","max_edge":320.5}),
        json!({"reason":"Review the failed order","max_edge":"1280"}),
        json!({"reason":"Review the failed order","extra":true}),
    ] {
        assert!(screenshot::input(&input).is_err(), "{input}");
    }
}
#[test]
fn every_closed_failure_detail_is_preserved_and_exception_text_is_never_a_detail() {
    let shared = &contracts::shared().other["failure_detail_codes"];
    assert_eq!(shared, &json!(evidence::DETAILS));
    for detail in evidence::DETAILS {
        assert_eq!(
            evidence::split_error(&evidence::error(detail)),
            ("INTERNAL_ERROR", Some(*detail))
        );
    }
    for text in [
        "INTERNAL_ERROR|C:\\private.db",
        "INTERNAL_ERROR|no such table: customer",
    ] {
        assert!(evidence::split_error(text).1.is_none());
    }
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    assert_eq!(
        evidence::sql_error(&conn.prepare("SELECT * FROM missing_table").err().unwrap()),
        Some("TABLE_MISSING")
    );
    conn.execute_batch("CREATE TABLE orders(id TEXT)").unwrap();
    assert_eq!(
        evidence::sql_error(
            &conn
                .prepare("SELECT missing_column FROM orders")
                .err()
                .unwrap()
        ),
        Some("COLUMN_MISSING")
    );
    assert_eq!(
        evidence::sql_error(&rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
            None
        )),
        Some("INSUFFICIENT_FREE_DISK")
    );
}
#[test]
fn secret_scrub_survives_personal_mode_and_precedes_cell_truncation() {
    for personal in [false, true] {
        let policy = evidence::Policy {
            personal,
            ..Default::default()
        };
        for secret in [
            "password=your-secret",
            "Bearer your-secret",
            "api_key=your-secret",
            "PIN is 1234",
            "ABCD-EFGH",
            "tss_yourSupportSecret",
            // Split so the repository secret scanner does not read the sample as a live key.
            concat!("sk_", "live_yourSecret"),
            "4111 1111 1111 1111",
        ] {
            let text = policy.string(&format!("{} {secret}", "x".repeat(1000)));
            assert!(
                !text.contains("your-secret")
                    && !text.contains("4111")
                    && !text.contains("1234")
                    && !text.contains("ABCD"),
                "{secret}: {text}"
            );
        }
        let value=policy.record(json!({"staff_id":"not-in-the-local-index","customer_name":"Your Customer","total_amount":12.34,"status":"failed","apiKey":"your-secret","nested":{"pin":"1234"},"payload":{"error":"Printer is offline","token":"your-secret"}}));
        assert_eq!(value["total_amount"], 12.34);
        assert_eq!(
            value["staff_id"],
            if personal {
                "not-in-the-local-index"
            } else {
                "[REDACTED]"
            }
        );
        assert_eq!(value["payload"]["error"], "Printer is offline");
        assert!(!value.to_string().contains("your-secret"));
        assert_eq!(
            value["customer_name"],
            if personal {
                "Your Customer"
            } else {
                "[REDACTED]"
            }
        );
    }
}
#[test]
fn personal_replica_is_isolated_and_disposed_without_contaminating_default_reads() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let db = crate::tests::harness::TestDb::open();
    {
        let conn = db.state.conn.lock().unwrap();
        conn.execute("INSERT INTO orders(id,customer_name,customer_phone,notes,total_amount,currency) VALUES('your-evidence-order','Your Customer','+49301234567','Printer is offline',12.34,'EUR')",[]).unwrap();
    }
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let normal = replica::build(db.db_path(), &permit).unwrap();
    let personal = replica::build_evidence(db.db_path(), &permit, true).unwrap();
    assert_ne!(normal.path, personal.path);
    let sql = json!({"sql":"SELECT customer_name AS alias,notes,total_amount FROM orders","include_personal_data":true,"reason":"Review the failed order"});
    let read = sql_query::query(&personal, &sql, &permit).unwrap();
    assert_eq!(read["rows"][0][0]["value"], "Your Customer");
    assert_eq!(read["rows"][0][1]["value"], "Printer is offline");
    assert_eq!(read["rows"][0][2], 12.34);
    let path = personal.path.clone();
    drop(personal);
    assert!(!path.exists());
    let read = sql_query::query(
        &normal,
        &json!({"sql":"SELECT customer_name AS alias FROM orders"}),
        &permit,
    )
    .unwrap();
    assert_eq!(read["rows"][0][0]["value"], "[REDACTED]");
}
#[test]
fn real_encoder_passes_ingress_marker_walk_and_rejects_metadata_after_scan() {
    use base64::Engine;
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        1600,
        800,
        image::Rgb([240, 230, 220]),
    ));
    let result =
        screenshot::encode(image, 640, &permit, Instant::now() + Duration::from_secs(5)).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(result["base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(screenshot::jpeg_dimensions(&bytes), Some((640, 320)));
    assert_eq!(result["byte_size"].as_u64(), Some(bytes.len() as u64));
    assert_eq!(result["sha256"], contracts::sha256(&bytes));
    assert!(bytes.len() <= 2 * 1024 * 1024);
    for marker in [0xe1, 0xe2, 0xef, 0xfe] {
        for after_scan in [false, true] {
            let mut hostile = bytes.clone();
            let at = if after_scan { hostile.len() - 2 } else { 2 };
            hostile.splice(at..at, [0xff, marker, 0, 4, b'x', b'x']);
            assert_eq!(screenshot::jpeg_dimensions(&hostile), None);
        }
    }
    let mut truncated = bytes.clone();
    truncated.pop();
    assert!(screenshot::jpeg_dimensions(&truncated).is_none());
    let mut trailing = bytes.clone();
    trailing.extend_from_slice(&[0xff, 0xd9]);
    assert!(screenshot::jpeg_dimensions(&trailing).is_none());
    let mut thumbnail = bytes;
    thumbnail[18] = 1;
    assert!(screenshot::jpeg_dimensions(&thumbnail).is_none());
}
#[test]
fn screenshot_encoding_and_presentation_wait_are_preempted_without_holding_checkout() {
    for (kind, detail) in [
        (CriticalKind::Checkout, "PREEMPTED_BY_SALE"),
        (CriticalKind::Card, "PREEMPTED_BY_PAYMENT"),
        (CriticalKind::Fiscal, "PREEMPTED_BY_PAYMENT"),
        (CriticalKind::ShiftClose, "PREEMPTED_BY_SHIFT_CLOSE"),
        (CriticalKind::ZClose, "PREEMPTED_BY_Z"),
    ] {
        let gate = CriticalOpGate::new();
        let permit = gate.try_begin_support(false, None).unwrap();
        let at = Instant::now();
        let _critical = gate.begin_critical(kind);
        assert!(at.elapsed() < Duration::from_millis(50));
        assert_eq!(evidence::preemption(kind), Some(detail));
        assert!(evidence::wait_presented("your-not-shown-command", &permit)
            .unwrap_err()
            .contains("PREEMPTED"));
        assert!(screenshot::encode(
            image::DynamicImage::new_rgb8(16, 16),
            320,
            &permit,
            Instant::now() + Duration::from_secs(5)
        )
        .unwrap_err()
        .contains("PREEMPTED"));
    }
}
#[test]
fn absent_and_unopenable_business_files_are_distinct() {
    let dir = crate::tests::harness::TempDir::new();
    let gate = CriticalOpGate::new();
    let permit = gate.try_begin_support(false, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    assert_eq!(
        evidence::split_error(
            &replica::read_connection(&dir.path().join("absent.db"), &permit, deadline)
                .err()
                .unwrap()
        )
        .1,
        Some("BUSINESS_DATABASE_MISSING")
    );
    let path = dir.path().join("corrupt.db");
    std::fs::write(&path, b"not a sqlite database").unwrap();
    let error = replica::read_connection(&path, &permit, deadline).err();
    // SQLite may defer validation until the first read. Either path must stay typed.
    if let Some(error) = error {
        assert_eq!(
            evidence::split_error(&error).1,
            Some("BUSINESS_DATABASE_OPEN_FAILED")
        );
    }
}
#[test]
fn journal_upgrade_is_separate_from_business_schema_and_binds_actor_scope_and_reason() {
    let _keys = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    {
        let conn = db.state.conn.lock().unwrap();
        for (key, value) in [
            ("organization_id", "your-org"),
            ("branch_id", "your-branch"),
            ("terminal_id", "your-terminal"),
        ] {
            crate::db::set_setting(&conn, "terminal", key, value).unwrap();
        }
    }
    let store = crate::support::db::SupportDb::open(db.dir()).unwrap();
    let mut command = super::delivery_tests::command();
    command.kind = "till_logs".into();
    store
        .conn
        .execute(
            "INSERT INTO support_evidence_sessions(session_id,actor_label,scope_json) VALUES(?1,'Your Technician',NULL)",
            [&command.session_id],
        )
        .unwrap();
    let details = json!({"event":"personal_data_access","command_id":command.command_id,"tool":command.kind,"reason":"Review the failed order"});
    evidence::journal(&store.path, &command, details.clone()).unwrap();
    let event: (String, String, String) = store
        .conn
        .query_row(
            "SELECT actor_label,organization_id,details_json FROM support_evidence_events",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(event.0, "Your Technician");
    assert_eq!(event.1, "your-org");
    assert_eq!(serde_json::from_str::<Value>(&event.2).unwrap(), details);
    assert_eq!(
        store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        super::super::db::VERSION
    );
}

#[test]
fn secret_and_ambiguous_capture_states_fail_closed() {
    assert!(screenshot::guard_result("ready").is_ok());
    for state in ["SCREEN_CONTAINS_SECRETS", "changed"] {
        assert_eq!(
            evidence::split_error(&screenshot::guard_result(state).unwrap_err()).1,
            Some("SCREEN_CONTAINS_SECRETS")
        );
    }
    for state in ["SCREEN_CAPTURE_UNAVAILABLE", "null", ""] {
        assert_eq!(
            evidence::split_error(&screenshot::guard_result(state).unwrap_err()).1,
            Some("SCREEN_CAPTURE_UNAVAILABLE")
        );
    }
}

#[test]
fn personal_value_substitution_cannot_corrupt_closed_wire_enums() {
    let policy = evidence::Policy {
        personal: false,
        known: vec![
            "redacted".into(),
            "pending".into(),
            "about".into(),
            "untrusted_till_data".into(),
        ],
    };
    assert_eq!(policy.string("[REDACTED]"), "[REDACTED]");
    let value=policy.record(json!({"status":"pending","section":"about","message":{"kind":"untrusted_till_data","value":"pending"}}));
    assert_eq!(value["status"], "pending");
    assert_eq!(value["section"], "about");
    assert_eq!(value["message"]["kind"], "untrusted_till_data");
    assert_eq!(value["message"]["value"], "[REDACTED]");
}

#[test]
fn installed_v3_support_database_upgrades_without_rewriting_existing_notice_or_audit() {
    let dir = crate::tests::harness::TempDir::new();
    let conn = rusqlite::Connection::open(dir.path().join("support.db")).unwrap();
    conn.execute_batch(include_str!("../schema.sql")).unwrap();
    conn.pragma_update(None, "user_version", 3).unwrap();
    conn.execute("INSERT INTO support_pending_notices VALUES('your-retained-notice','consent_decline','{}','your-time',NULL)",[]).unwrap();
    drop(conn);
    let store = crate::support::db::SupportDb::open(dir.path()).unwrap();
    assert_eq!(
        store
            .conn
            .query_row(
                "SELECT body_json FROM support_pending_notices WHERE id='your-retained-notice'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "{}"
    );
    assert_eq!(
        store
            .conn
            .query_row("SELECT count(*) FROM support_evidence_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        super::super::db::VERSION
    );
}

#[test]
fn secret_scrub_keeps_the_surrounding_operational_evidence() {
    assert_eq!(
        evidence::secrets("Printer offline; token=your-secret, retry 2"),
        "Printer offline; [REDACTED], retry 2"
    );
    assert_eq!(
        evidence::secrets("Before (ABCD-EFGH). After"),
        "Before ([REDACTED]). After"
    );
    assert_eq!(
        evidence::secrets("Before Bearer your-secret after"),
        "Before [REDACTED] after"
    );
}

#[test]
fn known_people_are_masked_case_insensitively_without_corrupting_unicode_boundaries() {
    let policy = evidence::Policy {
        personal: false,
        known: vec![
            "Your Customer".into(),
            "Li".into(),
            "\u{039d}\u{03af}\u{03ba}\u{03bf}\u{03c2}".into(),
            "Stra\u{00df}e".into(),
        ],
    };
    assert_eq!(
        policy.string(
            "YOUR CUSTOMER / li / \u{039d}\u{038a}\u{039a}\u{039f}\u{03a3} / STRA\u{1e9e}E"
        ),
        "[REDACTED] / [REDACTED] / [REDACTED] / [REDACTED]"
    );
}

#[test]
fn older_diagnostics_owner_messages_keep_only_a_closed_native_cause() {
    for (message, detail) in [
        (
            "read backlog: no such table: private_canary",
            "TABLE_MISSING",
        ),
        (
            "read readiness: no such column: private_canary",
            "COLUMN_MISSING",
        ),
        ("database or disk is full", "INSUFFICIENT_FREE_DISK"),
        (
            "file is not a database: private_canary",
            "BUSINESS_DATABASE_OPEN_FAILED",
        ),
    ] {
        assert_eq!(evidence::detail_of(message), Some(detail));
    }
    assert_eq!(evidence::detail_of("unavailable"), None);
}
