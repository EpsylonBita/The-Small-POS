use super::*;

fn business() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::run_migrations_for_test(&conn);
    conn
}
fn input(kind: &str) -> Value {
    json!({"device_kind":kind,"discovered_device_ref":{"ip":"192.168.1.20","port":9100},
        "settings":if kind=="printer" { json!({"name":"Your printer","role":"receipt","connection_type":"network","port":9100,"emulation":"star_line","code_page":null,"character_set":"PC737_GREEK","greek_render_mode":"auto","paper_width_mm":80}) }
        else { json!({"name":"Your terminal","connection_type":"network","port":20007,"protocol":if kind=="cash_register" {"cap"} else {"zvt"}}) }})
}
#[test]
fn printer_support_owner_validate_save_read_update_remove_uses_callers_transaction() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let conn = business();
    let mut v = input("printer");
    let profile = printer_record(&v, "your-printer");
    crate::printers::support_validate_printer_profile(&conn, &profile, false).unwrap();
    assert!(read_configuration(&conn, "printer", "your-printer")
        .unwrap()
        .is_none());
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let tx = permit.begin_write(&conn).unwrap();
    crate::printers::support_save_printer_profile(&tx, &profile, "your-printer", false).unwrap();
    assert_eq!(
        read_configuration(&tx, "printer", "your-printer").unwrap(),
        Some(configuration(&v))
    );
    tx.rollback().unwrap();
    assert!(read_configuration(&conn, "printer", "your-printer")
        .unwrap()
        .is_none());
    let tx = permit.begin_write(&conn).unwrap();
    crate::printers::support_save_printer_profile(&tx, &profile, "your-printer", false).unwrap();
    tx.commit().unwrap();
    v["settings"]["name"] = json!("Your changed printer");
    let tx = permit.begin_write(&conn).unwrap();
    crate::printers::support_save_printer_profile(
        &tx,
        &printer_record(&v, "your-printer"),
        "your-printer",
        true,
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(
        read_configuration(&conn, "printer", "your-printer").unwrap(),
        Some(configuration(&v))
    );
    let tx = permit.begin_write(&conn).unwrap();
    crate::printers::support_delete_printer_profile(&tx, "your-printer").unwrap();
    tx.commit().unwrap();
    assert!(read_configuration(&conn, "printer", "your-printer")
        .unwrap()
        .is_none());
}
#[test]
fn ecr_support_owner_saves_only_nonsecret_settings_and_roundtrips_protocol_and_address() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let conn = business();
    for kind in ["card_terminal", "cash_register"] {
        let mut v = input(kind);
        let record = crate::commands::ecr::support_device_record(&v, kind).unwrap();
        let permit = critical_op::global().try_begin_support(true, None).unwrap();
        let tx = permit.begin_write(&conn).unwrap();
        crate::commands::ecr::support_save_device(&tx, &record, false).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            read_configuration(&conn, kind, kind).unwrap(),
            Some(configuration(&v))
        );
        let raw = crate::commands::ecr::support_read_device(&conn, kind)
            .unwrap()
            .unwrap();
        assert_eq!(raw["connectionDetails"]["ip"], "192.168.1.20");
        assert_eq!(raw["settings"], json!({}));
        for secret in ["password", "pin", "pairing_key", "api_key", "certificate"] {
            assert!(raw["connectionDetails"].get(secret).is_none());
        }
        v["settings"]["name"] = json!("Your changed terminal");
        let tx = permit.begin_write(&conn).unwrap();
        crate::commands::ecr::support_save_device(
            &tx,
            &crate::commands::ecr::support_device_record(&v, kind).unwrap(),
            true,
        )
        .unwrap();
        tx.commit().unwrap();
        assert_eq!(
            read_configuration(&conn, kind, kind).unwrap(),
            Some(configuration(&v))
        );
        let tx = permit.begin_write(&conn).unwrap();
        crate::commands::ecr::support_remove_device(&tx, kind).unwrap();
        tx.commit().unwrap();
        assert!(read_configuration(&conn, kind, kind).unwrap().is_none());
    }
}
#[test]
fn device_writer_denies_financial_fiscal_shift_schema_and_secret_writes() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    // Use the app's WAL/FULL setup; a default rollback-journal fixture spends
    // the support deadline fsyncing schema pages on a loaded Windows host.
    let db = crate::tests::harness::TestDb::open();
    let conn = device_write_connection(db.db_path()).unwrap();
    for sql in [
        "DELETE FROM order_payments",
        "DELETE FROM ecr_transactions",
        "DELETE FROM staff_shifts",
        "DELETE FROM z_reports",
        "CREATE TABLE your_forbidden(id TEXT)",
        "ATTACH ':memory:' AS your_db",
        "PRAGMA writable_schema=ON",
        "UPDATE ecr_devices SET terminal_id='your-forbidden'",
    ] {
        assert!(conn.execute_batch(sql).is_err(), "{sql}");
    }
    let permit = critical_op::global().try_begin_support(true, None).unwrap();
    let tx = permit.begin_write(&conn).unwrap();
    crate::printers::support_save_printer_profile(
        &tx,
        &printer_record(&input("printer"), "your-printer"),
        "your-printer",
        false,
    )
    .unwrap();
    tx.commit().unwrap();
    assert!(read_configuration(&conn, "printer", "your-printer")
        .unwrap()
        .is_some());
    drop(conn);
}

#[test]
fn typed_support_sources_do_not_call_credential_readers() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/support");
    fn scan(path: &std::path::Path) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path.file_name().unwrap() != "tests" {
                    scan(&path);
                }
                continue;
            }
            if path.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            // The dormant rotation receiver owns the credential itself.
            if path.ends_with("key_rotation.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            if !path.ends_with("transport.rs") {
                assert!(
                    !source.contains("session_get_strict("),
                    "{} reads staff credentials",
                    path.display()
                );
            }
            for reader in [
                "get_credential(",
                "get_credential_strict(",
                "read_runtime_terminal_credential(",
                "resolve_canonical_local_terminal_identity(",
            ] {
                assert!(
                    !source.contains(reader),
                    "{} calls {reader}",
                    path.display()
                );
            }
        }
    }
    scan(&root);
}

#[test]
fn native_device_apply_session_admission_never_reads_keyring() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let db = crate::tests::harness::TestDb::open();
    let conn = db.state.conn.lock().unwrap();
    for (key, value) in [
        ("organization_id", "your-org"),
        ("branch_id", "your-branch"),
        ("terminal_id", "your-terminal"),
    ] {
        crate::db::set_setting(&conn, "terminal", key, value).unwrap();
    }
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/routes/pos-support-commands.json"
    ))
    .unwrap();
    let command: Command =
        serde_json::from_value(fixture["response"]["commands"][0].clone()).unwrap();
    let root = crate::tests::harness::TempDir::new();
    let mut core =
        super::super::session::Core::new(super::super::db::SupportDb::open(root.path()).unwrap())
            .unwrap();
    core.terminal_id = Some("your-terminal".into());
    let info = super::super::transport::SessionInfo {
        session_id: command.session_id.clone(),
        operator_display_name: "Your support".into(),
        tier_ceiling: 2,
        max_expires_at: command.expires_at.clone(),
        absolute_cap_at: command.expires_at.clone(),
        idle_timeout_s: 300,
        ack_deadline_at: command.expires_at.clone(),
        doorbell_topic: format!("support:session:{}", command.session_id),
        resume_allowed: false,
    };
    core.adopt(info, &command.server_time).unwrap();
    let admission = &mut core.session.as_mut().unwrap().admission;
    admission.online = true;
    admission.active = true;
    admission.tiers_enabled.insert(command.tier);
    crate::tests::fake_keyring::before_each_read(|key| panic!("support read keyring: {key}"));
    assert_eq!(
        super::super::breakglass::scope_from_connection(&conn).unwrap(),
        super::super::identity::local(&conn).unwrap()
    );
    core.terminal_id = None;
    super::super::session::bind_local_identity(&conn, &mut core).unwrap();
    assert_eq!(core.terminal_id.as_deref(), Some("your-terminal"));
    super::super::identity::for_session(&conn, &core, &command.session_id).unwrap();
    current_session(&conn, &core, &command, &command.session_id, false).unwrap();
    current_session(&conn, &core, &command, &command.session_id, true).unwrap();
    core.terminal_id = Some("your-other-terminal".into());
    assert!(current_session(&conn, &core, &command, &command.session_id, false).is_err());
}

#[test]
fn catalogue_device_input_binds_only_the_selected_saved_profile_and_closed_emulation() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = critical_op::install_test_gate();
    let conn = business();
    for (key, value) in [
        ("organization_id", "your-org"),
        ("branch_id", "your-branch"),
        ("terminal_id", "your-terminal"),
    ] {
        crate::db::set_setting(&conn, "terminal", key, value).unwrap();
    }
    let id = "11111111-1111-4111-8111-111111111111";
    crate::printers::support_save_printer_profile(
        &conn,
        &printer_record(&input("printer"), id),
        id,
        false,
    )
    .unwrap();
    let scope = super::super::identity::local(&conn).unwrap();
    let reference = super::super::catalogue::configured_printer_ref(&conn, &scope, id).unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/routes/pos-support-commands.json"
    ))
    .unwrap();
    let c: Command = serde_json::from_value(fixture["response"]["commands"][0].clone()).unwrap();
    let input = super::super::catalogue::contract::ApplyProfile {
        printer: reference,
        emulation: super::super::catalogue::contract::Emulation::Escpos,
    };
    crate::tests::fake_keyring::before_each_read(|key| panic!("support read keyring: {key}"));
    let projected = catalogue_profile_command(&conn, &c, &input).unwrap();
    assert_eq!(projected.payload["existing_device_id"], id);
    assert_eq!(projected.payload["discovered_device_ref"]["device_id"], id);
    assert_eq!(projected.payload["settings"]["emulation"], "escpos");
    assert_eq!(
        projected.payload["discovered_device_ref"]["ip"],
        "192.168.1.20"
    );
    assert_eq!(projected.payload["settings"]["name"], "Your printer");
    conn.execute(
        "UPDATE printer_profiles SET name='Your changed printer' WHERE id=?1",
        [id],
    )
    .unwrap();
    assert_eq!(
        catalogue_profile_command(&conn, &c, &input).unwrap_err(),
        "PAYLOAD_DRIFT"
    );
}
