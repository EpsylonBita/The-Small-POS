use super::*;
use serde_json::json;

#[test]
fn terminal_heartbeat_retains_only_valid_server_support_in_memory() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    {
        let c = db.state.conn.lock().unwrap();
        crate::db::set_setting(&c, "terminal", "__ignore_keyring", "1").unwrap();
        crate::db::set_setting(&c, "terminal", "terminal_id", "your-heartbeat-terminal").unwrap();
    }
    let before = std::fs::read(db.db_path()).unwrap();
    let state = SyncState::new();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let expected = json!({"available":true,"min_protocol_version":1,"tiers_enabled":[1,2],"passkey_approvals":false,"catalogue_mutations":false,"disabled_tools":["your-tool"],"kill_epoch":7,"consent":{"state":"valid","text_version":"1","locale":"en","accepting_base_roles":["owner","admin"]}});
    assert!(support_availability(db.db_path(), &state).is_null());
    // Task 8.32: the route golden round-trips through the private sender. It
    // shares this test because the availability generation is process-wide.
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/routes/pos-terminal-heartbeat-support.json"
    ))
    .unwrap();
    let mut golden = fixture["response"]["support"].clone();
    golden["catalogue_mutations"] = json!(false);
    assert_eq!(
        validated_support_availability(&golden),
        Some(golden.clone())
    );
    assert!(runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            true,
            |_| async { Ok(json!({"success":true,"support":golden})) }
        ))
        .unwrap());
    assert_eq!(
        support_availability(db.db_path(), &state),
        validated_support_availability(&fixture["response"]["support"]).unwrap()
    );
    assert!(runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            true,
            |_| async { Ok(json!({"success":true,"support":expected})) }
        ))
        .unwrap());
    assert_eq!(support_availability(db.db_path(), &state), expected);
    let (retained, first_age) = support_availability_with_age(db.db_path(), &state);
    assert_eq!(retained, expected);
    let first_age = first_age.unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(
        support_availability_with_age(db.db_path(), &state)
            .1
            .unwrap()
            >= first_age + 5
    );
    for response in [
        json!({"success":true}),
        json!({"success":false,"support":expected}),
        json!({"success":true,"support":{"available":true}}),
    ] {
        runtime
            .block_on(send_terminal_heartbeat_with_sender(
                &db.state,
                &state,
                true,
                |_| async { Ok(response) },
            ))
            .unwrap();
        assert!(support_availability(db.db_path(), &state).is_null());
    }
    let mut disabled = expected.clone();
    disabled["available"] = json!(false);
    runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            true,
            |_| async { Ok(json!({"success":true,"support":disabled})) },
        ))
        .unwrap();
    assert_eq!(support_availability(db.db_path(), &state), disabled);
    assert!(runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            true,
            |_| async { Err("your-failure".into()) }
        ))
        .is_err());
    assert!(support_availability(db.db_path(), &state).is_null());
    runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            true,
            |_| async { Ok(json!({"success":true,"support":expected})) },
        ))
        .unwrap();
    assert!(!runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            false,
            |_| async { panic!("offline must not send") }
        ))
        .unwrap());
    assert!(support_availability(db.db_path(), &state).is_null());
    assert!(support_availability(&db.db_path().with_file_name("other.db"), &state).is_null());
    runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            true,
            |_| async { Ok(json!({"success":true,"support":expected})) },
        ))
        .unwrap();
    support_availability_generation().fetch_add(1, Ordering::AcqRel);
    assert!(support_availability(db.db_path(), &state).is_null()); // even if publishing a cache reset is skipped
    runtime
        .block_on(send_terminal_heartbeat_with_sender(
            &db.state,
            &state,
            true,
            |_| async { Ok(json!({"success":true,"support":expected})) },
        ))
        .unwrap();
    state.clear_remote_auth_pause(); // reset invalidates the old identity's answer
    assert!(support_availability(db.db_path(), &state).is_null());
    assert_eq!(before, std::fs::read(db.db_path()).unwrap());
}

#[test]
fn terminal_heartbeat_availability_validation_is_closed_and_typed() {
    let valid = json!({"available":false,"min_protocol_version":1,"tiers_enabled":[1,2,3],"passkey_approvals":true,"catalogue_mutations":true,"disabled_tools":[],"kill_epoch":0,"consent":{"state":"missing","text_version":null,"locale":null,"accepting_base_roles":[]}});
    assert_eq!(validated_support_availability(&valid), Some(valid.clone()));
    for (path, value) in [
        ("/available", json!(1)),
        ("/catalogue_mutations", json!("true")),
        ("/min_protocol_version", json!(0)),
        ("/tiers_enabled", json!([4])),
        ("/disabled_tools", json!([1])),
        ("/kill_epoch", json!(-1)),
        ("/consent/state", json!("unknown")),
        ("/consent/text_version", json!("")),
        ("/consent/accepting_base_roles", json!([""])),
    ] {
        let mut invalid = valid.clone();
        *invalid.pointer_mut(path).unwrap() = value;
        assert!(validated_support_availability(&invalid).is_none(), "{path}");
    }
    for path in ["", "/consent"] {
        let mut invalid = valid.clone();
        invalid
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("raw".into(), json!("your-prose"));
        assert!(validated_support_availability(&invalid).is_none());
    }
}

#[test]
fn old_support_servers_default_catalogue_mutations_to_false() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/routes/pos-terminal-heartbeat-support.json"
    ))
    .unwrap();
    let mut old = fixture["response"]["support"].clone();
    old.as_object_mut().unwrap().remove("catalogue_mutations");
    let normalized = validated_support_availability(&old).unwrap();
    assert_eq!(normalized["catalogue_mutations"], false);
}

#[test]
fn availability_age_is_original_observation_age_and_unknown_or_stale_refuses_mutations() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let action = crate::support::catalogue::contract::parse(
        json!({"action_id":"printer.pause_dispatch.v1","version":1,"inputs":{"printer":{"id":"11111111-1111-4111-8111-111111111111","configuration_revision":1},"action":"pause"}}),
    )
    .unwrap();
    let value = json!({"available":true,"catalogue_mutations":true,"disabled_tools":[]});
    for at in [
        Value::Null,
        json!("your-invalid-time"),
        json!((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339()),
        json!((chrono::Utc::now() - chrono::Duration::seconds(61)).to_rfc3339()),
    ] {
        let age = availability_observation_age(&json!({"at":at}));
        assert!(crate::support::catalogue::check_availability(&action, &value, age).is_err());
    }
    let age = availability_observation_age(&json!({"at":chrono::Utc::now().to_rfc3339()}));
    assert!(crate::support::catalogue::check_availability(&action, &value, age).is_ok());
}
