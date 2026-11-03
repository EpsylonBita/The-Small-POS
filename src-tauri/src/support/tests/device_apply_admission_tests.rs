use crate::support::{
    approval_verify::{Context, Verifier},
    contracts::Command,
    critical_op::SupportPermit,
    db::SupportDb,
    device_apply::{self, DeviceServices},
};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
struct Services {
    admitted: Cell<Option<bool>>,
    admission_error: Cell<bool>,
    admission_after_tap: Cell<Option<Option<bool>>>,
    provenance: bool,
    authorized: Cell<bool>,
    saved: RefCell<Option<Value>>,
    saves: Cell<usize>,
    onsite_calls: Cell<usize>,
    identification_calls: Cell<usize>,
    business: rusqlite::Connection,
    read_permit: RefCell<Option<SupportPermit>>,
    critical_after_tap: Cell<bool>,
    critical: RefCell<Option<crate::support::critical_op::CriticalToken>>,
}
impl DeviceServices for Services {
    fn provenance(&self, _session: &str, _input: &Value) -> Result<bool, String> {
        Ok(self.provenance)
    }
    fn validate(&self, _input: &Value) -> Result<(), String> {
        Ok(())
    }
    fn read(&self, _kind: &str, _id: &str) -> Result<Option<Value>, String> {
        Ok(self.saved.borrow().clone())
    }
    fn retained_identification(&self, _session: &str, _input: &Value) -> Result<Value, String> {
        self.identification_calls
            .set(self.identification_calls.get() + 1);
        Ok(Value::Null)
    }
    fn fresh_admission(&self, _kind: &str) -> Result<Option<bool>, String> {
        if self.admission_error.get() {
            return Err("your_admission_unavailable".into());
        }
        Ok(self.admitted.get())
    }
    fn onsite(&self, _c: &Command, _input: &Value) -> Result<(), String> {
        self.onsite_calls.set(self.onsite_calls.get() + 1);
        if self.critical_after_tap.get() {
            *self.critical.borrow_mut() = Some(
                crate::support::critical_op::global()
                    .begin_critical(crate::support::critical_op::CriticalKind::Card),
            );
        }
        if let Some(value) = self.admission_after_tap.get() {
            self.admitted.set(value);
        }
        Ok(())
    }
    fn authorize(&self, _kind: &str) -> Result<bool, String> {
        Ok(self.authorized.get())
    }
    fn current(&self, _session: &str) -> Result<(), String> {
        if self
            .read_permit
            .borrow()
            .as_ref()
            .is_some_and(SupportPermit::is_cancelled)
        {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        Ok(())
    }
    fn release_read_permit(&self) -> Result<(), String> {
        let permit = self.read_permit.borrow_mut().take();
        if permit.as_ref().is_some_and(SupportPermit::is_cancelled) {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        drop(permit);
        Ok(())
    }
    fn save(
        &self,
        input: &Value,
        _id: &str,
        expected: Option<&Value>,
        _permit: &SupportPermit,
    ) -> Result<(), String> {
        if self.saved.borrow().as_ref() != expected {
            return Err("PAYLOAD_MISMATCH".into());
        }
        let tx = _permit.begin_write(&self.business)?;
        if input["device_kind"] == "printer" {
            let settings = &input["settings"];
            let profile = json!({"id":_id,"name":settings["name"],"printerName":input["discovered_device_ref"]["ip"],"driverType":"escpos","role":settings["role"],"paperWidthMm":settings["paper_width_mm"],"connectionJson":{"type":"network","host":input["discovered_device_ref"]["ip"],"port":settings["port"],"emulation":settings["emulation"]}});
            crate::printers::support_save_printer_profile(
                &tx,
                &profile,
                _id,
                input["existing_device_id"].is_string(),
            )?;
        } else {
            crate::commands::ecr::support_save_device(
                &tx,
                &crate::commands::ecr::support_device_record(input, _id)?,
                input["existing_device_id"].is_string(),
            )?;
        }
        tx.commit().map_err(|_| "INTERNAL_ERROR")?;
        self.saves.set(self.saves.get() + 1);
        *self.saved.borrow_mut() = Some(device_apply::configuration(input));
        Ok(())
    }
    fn remove(
        &self,
        _kind: &str,
        _id: &str,
        expected: &Value,
        _permit: &SupportPermit,
    ) -> Result<(), String> {
        if self.saved.borrow().as_ref() != Some(expected) {
            return Err("PAYLOAD_MISMATCH".into());
        }
        let tx = _permit.begin_write(&self.business)?;
        if _kind == "printer" {
            crate::printers::support_delete_printer_profile(&tx, _id)?;
        } else {
            crate::commands::ecr::support_remove_device(&tx, _id)?;
        }
        tx.commit().map_err(|_| "INTERNAL_ERROR")?;
        *self.saved.borrow_mut() = None;
        Ok(())
    }
}
fn fixture(kind: &str) -> (std::path::PathBuf, SupportDb, Services, Command, Context) {
    let dir = std::env::temp_dir().join(format!("support-device-{}", uuid::Uuid::new_v4()));
    let db = SupportDb::open(&dir).unwrap();
    let settings = if kind == "printer" {
        json!({"name":"Your printer","role":"receipt","connection_type":"network","port":9100,"emulation":"star_line","code_page":null,"character_set":"PC737_GREEK","greek_render_mode":"auto","paper_width_mm":80})
    } else if kind == "cash_register" {
        json!({"name":"Your register","protocol":"cap","connection_type":"network","port":80})
    } else {
        json!({"name":"Your terminal","protocol":"zvt","connection_type":"network","port":20007})
    };
    let input = json!({"step":"validate","device_kind":kind,"discovered_device_ref":{"source":"scan","scan_id":"10000000-0000-4000-a000-000000000001","ip":"192.168.1.20","port":if kind=="printer"{9100}else if kind=="cash_register"{80}else{20007}},"settings":settings,"idempotency_key":"your_device_request_key"});
    let c = Command {
        command_id: uuid::Uuid::new_v4().to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        sequence: 1,
        kind: "till_apply_device_settings".into(),
        tier: 2,
        payload: input,
        payload_sha256: String::new(),
        idempotency_key: "your_device_request_key".into(),
        call_id: uuid::Uuid::new_v4().to_string(),
        created_at: "2030-01-01T00:00:00.000Z".into(),
        expires_at: "2030-01-01T00:10:00.000Z".into(),
        server_time: "2030-01-01T00:00:00.000Z".into(),
        approval: None,
    };
    let context = Context {
        session_id: c.session_id.clone(),
        terminal_id: uuid::Uuid::new_v4().to_string(),
        server_now: Some(1893456000000),
        absolute_cap_at: "2030-01-01T00:20:00.000Z".into(),
    };
    let business = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::run_migrations_for_test(&business);
    crate::db::ecr_insert_device(&business,&json!({"id":"your-unchanged-terminal","name":"Your unchanged terminal","deviceType":"payment_terminal"})).unwrap();
    (
        dir,
        db,
        Services {
            admitted: Cell::new(Some(true)),
            admission_error: Cell::new(false),
            admission_after_tap: Cell::new(None),
            provenance: true,
            authorized: Cell::new(true),
            saved: RefCell::new(None),
            saves: Cell::new(0),
            onsite_calls: Cell::new(0),
            identification_calls: Cell::new(0),
            business,
            read_permit: RefCell::new(None),
            critical_after_tap: Cell::new(false),
            critical: RefCell::new(None),
        },
        c,
        context,
    )
}
fn device_tables(services: &Services) -> Vec<Vec<String>> {
    ["printer_profiles", "ecr_devices"]
        .into_iter()
        .map(|table| {
            let mut stmt = services
                .business
                .prepare(&format!("SELECT * FROM {table} ORDER BY id"))
                .unwrap();
            let columns = stmt.column_count();
            stmt.query_map([], |r| {
                Ok((0..columns)
                    .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        })
        .collect()
}
#[test]
fn device_admission_failure_or_unknown_and_foreign_provenance_save_nothing() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for (kind, value) in ["card_terminal", "cash_register"]
        .into_iter()
        .flat_map(|kind| [Some(false), None].map(|value| (kind, value)))
    {
        let (dir, db, services, c, context) = fixture(kind);
        let before = device_tables(&services);
        services.admitted.set(value);
        assert_eq!(
            device_apply::validate(&db.conn, &services, &c, &context).unwrap_err(),
            "DEVICE_NOT_ADMITTED"
        );
        assert_eq!(services.saves.get(), 0);
        assert_eq!(device_tables(&services), before);
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM support_validations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
    let (dir, db, mut services, c, context) = fixture("printer");
    services.provenance = false;
    assert_eq!(
        device_apply::validate(&db.conn, &services, &c, &context).unwrap_err(),
        "POLICY_REFUSED"
    );
    assert_eq!(services.saves.get(), 0);
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn device_rejects_secret_fields_and_only_support_connect_authorization() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let (dir, db, services, mut c, context) = fixture("printer");
    c.payload["settings"]["password"] = json!("your_placeholder");
    assert!(device_apply::validate(&db.conn, &services, &c, &context).is_err());
    c.payload["settings"]
        .as_object_mut()
        .unwrap()
        .remove("password");
    let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
    c.payload["step"] = json!("apply");
    c.payload["validation_id"] = validation["validation_id"].clone();
    services.authorized.set(false);
    assert_eq!(
        device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context).unwrap_err(),
        "POLICY_REFUSED"
    );
    assert_eq!(services.saves.get(), 0);
    assert_eq!(services.onsite_calls.get(), 1);
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn device_printer_apply_readback_undo_and_consumption() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let (dir, db, services, mut c, context) = fixture("printer");
    let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
    c.payload["step"] = json!("apply");
    c.payload["validation_id"] = validation["validation_id"].clone();
    let result =
        device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context).unwrap();
    assert_eq!(result["outcome"], "pending");
    assert_eq!(
        services.identification_calls.get(),
        1,
        "apply must not identify or probe"
    );
    assert_eq!(services.saves.get(), 1);
    assert!(device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context).is_err());
    device_apply::undo(
        &db.conn,
        &services,
        &c,
        result["audit_id"].as_str().unwrap(),
        context.server_now.unwrap(),
    )
    .unwrap();
    assert!(services.saved.borrow().is_none());
    assert!(device_apply::undo(
        &db.conn,
        &services,
        &c,
        result["audit_id"].as_str().unwrap(),
        context.server_now.unwrap()
    )
    .is_err());
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn catalogue_apply_reuses_its_permit_and_keeps_owner_authorization_and_preemption() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for mode in ["apply", "refused", "critical"] {
        let (dir, db, services, mut c, context) = fixture("printer");
        let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
        c.payload["step"] = json!("apply");
        c.payload["validation_id"] = validation["validation_id"].clone();
        services.authorized.set(mode != "refused");
        services.critical_after_tap.set(mode == "critical");
        let permit = crate::support::critical_op::global()
            .try_begin_support(true, None)
            .unwrap();
        crate::tests::fake_keyring::before_each_read(|key| panic!("support read keyring: {key}"));
        let result = device_apply::apply_with_permit(
            &db.conn,
            &services,
            &Verifier::pinned(),
            &c,
            &context,
            &permit,
        );
        match mode {
            "apply" => {
                assert_eq!(result.unwrap()["outcome"], "pending");
                assert_eq!(services.saves.get(), 1);
            }
            "refused" => {
                assert_eq!(result.unwrap_err(), "POLICY_REFUSED");
                assert_eq!(services.saves.get(), 0);
            }
            _ => {
                assert_eq!(result.unwrap_err(), "PREEMPTED_BY_CRITICAL_OPERATION");
                assert_eq!(services.saves.get(), 0);
            }
        }
        assert_eq!(services.onsite_calls.get(), 1);
        drop(permit);
        drop(services);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
#[test]
fn device_payload_drift_expiry_missing_approval_and_no_clock_refuse() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let (dir, db, services, mut c, mut context) = fixture("printer");
    let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
    c.payload["step"] = json!("apply");
    c.payload["validation_id"] = validation["validation_id"].clone();
    c.payload["settings"]["name"] = json!("Changed");
    assert_eq!(
        device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context).unwrap_err(),
        "PAYLOAD_MISMATCH"
    );
    c.payload["settings"]["name"] = json!("Your printer");
    context.server_now = Some(1893456600000);
    assert!(device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context).is_err());
    context.server_now = None;
    assert!(device_apply::validate(&db.conn, &services, &c, &context).is_err());
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
    let (dir, db, services, mut c, context) = fixture("card_terminal");
    let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
    c.payload["step"] = json!("apply");
    c.payload["validation_id"] = validation["validation_id"].clone();
    assert_eq!(
        device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context).unwrap_err(),
        "APPROVAL_REQUIRED"
    );
    assert_eq!(services.saves.get(), 0);
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn device_signed_card_approval_is_consumed_before_fresh_admission_failure() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let v = &fixtures["vectors"][0];
    for (admitted, after_tap, admission_error) in [
        (Some(false), None, false),
        (None, None, false),
        (Some(true), None, true),
        (Some(true), Some(Some(false)), false),
        (Some(true), Some(None), false),
    ] {
        let (dir, db, services, mut c, mut context) = fixture("card_terminal");
        c.payload = v["input"].clone();
        c.approval = Some(v["approval"].clone());
        c.session_id = v["context"]["session_id"].as_str().unwrap().into();
        c.command_id = v["context"]["command_id"].as_str().unwrap().into();
        context.session_id = c.session_id.clone();
        context.terminal_id = v["context"]["terminal_id"].as_str().unwrap().into();
        context.absolute_cap_at = v["context"]["absolute_cap_at"].as_str().unwrap().into();
        let validation = v["context"]["validation_id"].as_str().unwrap();
        let hash = v["context"]["record_sha256"].as_str().unwrap();
        assert_eq!(device_apply::record_hash(&c.payload), hash);
        db.conn.execute("INSERT INTO support_validations(validation_id,session_id,device_kind,device_ref_json,record_json,record_sha256,expires_at,created_at) VALUES(?1,?2,'card_terminal','{}','{}',?3,?4,?5)",rusqlite::params![validation,c.session_id,hash,context.absolute_cap_at,c.created_at]).unwrap();
        let before = device_tables(&services);
        services.admitted.set(admitted);
        services.admission_after_tap.set(after_tap);
        services.admission_error.set(admission_error);
        assert_eq!(
            device_apply::apply(
                &db.conn,
                &services,
                &Verifier::from_file(&v["pinned_keys"]),
                &c,
                &context
            )
            .unwrap_err(),
            "DEVICE_NOT_ADMITTED"
        );
        assert_eq!(
            services.onsite_calls.get(),
            usize::from(after_tap.is_some()),
            "failed pre-tap admission never waits; post-tap failure saves nothing"
        );
        assert_eq!(services.saves.get(), 0);
        assert_eq!(device_tables(&services), before);
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM support_consumed_approvals", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(device_apply::apply(
            &db.conn,
            &services,
            &Verifier::from_file(&v["pinned_keys"]),
            &c,
            &context
        )
        .is_err());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn device_validation_keeps_exact_ten_minute_record_and_secret_fields_empty() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for kind in ["printer", "card_terminal", "cash_register"] {
        let (dir, db, services, mut c, context) = fixture(kind);
        let previous = device_apply::configuration(&c.payload);
        *services.saved.borrow_mut() = Some(previous.clone());
        c.payload["existing_device_id"] = json!("your-existing-device");
        let v = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
        assert_eq!(v["record_to_save"], c.payload["settings"]);
        assert_eq!(v["record_sha256"], device_apply::record_hash(&c.payload));
        assert_eq!(v["previous_config"], previous["settings"]);
        assert_eq!(
            crate::support::clock::parse(v["expires_at"].as_str().unwrap()).unwrap(),
            context.server_now.unwrap() + 600000
        );
        let (record, prior): (String, String) = db
            .conn
            .query_row(
                "SELECT record_json,previous_config_json FROM support_validations",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&record).unwrap(),
            c.payload["settings"]
        );
        assert_eq!(serde_json::from_str::<Value>(&prior).unwrap(), previous);
        for secret in ["password", "pin", "pairing_key", "api_key", "certificate"] {
            assert!(c.payload["settings"].get(secret).is_none());
            if kind != "printer" {
                assert!(v["secret_fields_left_empty"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(secret)));
            }
            c.payload["settings"][secret] = json!("your-placeholder");
            assert_eq!(
                device_apply::validate(&db.conn, &services, &c, &context).unwrap_err(),
                "POLICY_REFUSED"
            );
            c.payload["settings"]
                .as_object_mut()
                .unwrap()
                .remove(secret);
        }
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
#[test]
fn device_undo_checks_manual_rights_after_tap_and_does_not_change_record() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let (dir, db, services, mut c, context) = fixture("printer");
    let v = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
    c.payload["step"] = json!("apply");
    c.payload["validation_id"] = v["validation_id"].clone();
    let result =
        device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context).unwrap();
    services.authorized.set(false);
    assert_eq!(
        device_apply::undo(
            &db.conn,
            &services,
            &c,
            result["audit_id"].as_str().unwrap(),
            context.server_now.unwrap()
        )
        .unwrap_err(),
        "POLICY_REFUSED"
    );
    assert_eq!(services.onsite_calls.get(), 2);
    assert_eq!(
        *services.saved.borrow(),
        Some(device_apply::configuration(&c.payload))
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT undone_at IS NULL FROM support_device_applies",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap(),
        true
    );
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn device_outside_session_and_unavailable_admission_leave_both_device_tables_unchanged() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for kind in ["printer", "card_terminal", "cash_register"] {
        let (dir, db, mut services, c, context) = fixture(kind);
        let before = device_tables(&services);
        services.provenance = false;
        assert_eq!(
            device_apply::validate(&db.conn, &services, &c, &context).unwrap_err(),
            "POLICY_REFUSED"
        );
        services.provenance = true;
        if kind != "printer" {
            services.admission_error.set(true);
            assert_eq!(
                device_apply::validate(&db.conn, &services, &c, &context).unwrap_err(),
                "DEVICE_NOT_ADMITTED"
            );
        }
        assert_eq!(device_tables(&services), before);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn device_signed_card_apply_saves_reads_back_audits_and_undoes_without_device_io() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let v = &fixtures["vectors"][0];
    let (dir, db, services, mut c, mut context) = fixture("card_terminal");
    c.payload = v["input"].clone();
    c.approval = Some(v["approval"].clone());
    c.session_id = v["context"]["session_id"].as_str().unwrap().into();
    c.command_id = v["context"]["command_id"].as_str().unwrap().into();
    context.session_id = c.session_id.clone();
    context.terminal_id = v["context"]["terminal_id"].as_str().unwrap().into();
    context.absolute_cap_at = v["context"]["absolute_cap_at"].as_str().unwrap().into();
    let mut prior = c.payload.clone();
    prior["settings"]["name"] = json!("Your previous terminal");
    let device = c.payload["existing_device_id"].as_str().unwrap();
    crate::commands::ecr::support_save_device(
        &services.business,
        &crate::commands::ecr::support_device_record(&prior, device).unwrap(),
        false,
    )
    .unwrap();
    *services.saved.borrow_mut() = Some(device_apply::configuration(&prior));
    db.conn.execute("INSERT INTO support_validations(validation_id,session_id,device_kind,device_ref_json,record_json,record_sha256,expires_at,created_at,previous_config_json) VALUES(?1,?2,'card_terminal',?3,?4,?5,?6,?7,?8)",rusqlite::params![c.payload["validation_id"].as_str(),c.session_id,c.payload.to_string(),c.payload["settings"].to_string(),device_apply::record_hash(&c.payload),context.absolute_cap_at,c.created_at,device_apply::configuration(&prior).to_string()]).unwrap();
    let result = device_apply::apply(
        &db.conn,
        &services,
        &Verifier::from_file(&v["pinned_keys"]),
        &c,
        &context,
    )
    .unwrap();
    assert_eq!(result["read_back"]["matches_record"], true);
    assert_eq!(result["outcome"], "pending");
    assert!(result["post_identify"].is_null());
    assert_eq!(services.onsite_calls.get(), 1);
    assert_eq!(services.identification_calls.get(), 0);
    let raw = crate::commands::ecr::support_read_device(
        &services.business,
        result["device_id"].as_str().unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(raw["name"], c.payload["settings"]["name"]);
    let (saved, admission): (String, String) = db
        .conn
        .query_row(
            "SELECT applied_config_json,admission_json FROM support_device_applies",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap(),
        device_apply::configuration(&c.payload)
    );
    assert_eq!(
        serde_json::from_str::<Value>(&admission).unwrap()["admitted"],
        true
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM support_audit_local WHERE result_sha256 IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    device_apply::undo(
        &db.conn,
        &services,
        &c,
        result["audit_id"].as_str().unwrap(),
        context.server_now.unwrap(),
    )
    .unwrap();
    assert_eq!(
        crate::commands::ecr::support_read_device(&services.business, device)
            .unwrap()
            .unwrap()["name"],
        "Your previous terminal"
    );
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn device_printer_skips_tap_only_for_till_verified_unattended_proof() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let v = &fixtures["vectors"][1];
    for verified in [false, true] {
        let (dir, db, services, mut c, mut context) = fixture("printer");
        c.session_id = v["context"]["session_id"].as_str().unwrap().into();
        context.session_id = c.session_id.clone();
        context.terminal_id = v["context"]["terminal_id"].as_str().unwrap().into();
        context.absolute_cap_at = v["context"]["absolute_cap_at"].as_str().unwrap().into();
        db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at,attended) VALUES(?1,'active',2,?2,?2,?3,0)",rusqlite::params![c.session_id,context.absolute_cap_at,c.created_at]).unwrap();
        let verifier = Verifier::from_file(&v["pinned_keys"]);
        if verified {
            assert!(verifier
                .mark_unattended(
                    &db.conn,
                    &json!({"record":v["record"],"assertion":v["assertion"]}),
                    &context
                )
                .unwrap());
        }
        let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
        c.payload["step"] = json!("apply");
        c.payload["validation_id"] = validation["validation_id"].clone();
        device_apply::apply(&db.conn, &services, &verifier, &c, &context).unwrap();
        assert_eq!(services.onsite_calls.get(), usize::from(!verified));
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn device_releases_read_lease_before_writer_and_critical_operation_preempts_wait() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for preempt in [false, true] {
        let (dir, db, services, mut c, context) = fixture("printer");
        let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
        c.payload["step"] = json!("apply");
        c.payload["validation_id"] = validation["validation_id"].clone();
        *services.read_permit.borrow_mut() = Some(
            crate::support::critical_op::global()
                .try_begin_support(false, None)
                .unwrap(),
        );
        services.critical_after_tap.set(preempt);
        let before = device_tables(&services);
        let result = device_apply::apply(&db.conn, &services, &Verifier::pinned(), &c, &context);
        if preempt {
            assert_eq!(result.unwrap_err(), "PREEMPTED_BY_CRITICAL_OPERATION");
            assert_eq!(device_tables(&services), before);
        } else {
            assert_eq!(result.unwrap()["outcome"], "pending");
        }
        drop(db);
        drop(services);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

// Same ephemeral-key/from_file seam used by command_approval_tests; no shipped
// key or private credential is read, written or added to the repository.
fn approve_device(c: &mut Command, context: &Context) -> Verifier {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
    use ring::{
        digest,
        rand::SystemRandom,
        signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
    };
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let v = &vectors["vectors"][0];
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
    let key =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let public = key.public_key().as_ref();
    let mut keys = v["pinned_keys"].clone();
    keys["keys"][0]["public_key"]["x"] = json!(B64.encode(&public[1..33]));
    keys["keys"][0]["public_key"]["y"] = json!(B64.encode(&public[33..65]));
    let mut approval = v["approval"].clone();
    approval["record"]["session_id"] = json!(context.session_id);
    approval["record"]["terminal_id"] = json!(context.terminal_id);
    approval["record"]["dry_run_or_validation_id"] = c.payload["validation_id"].clone();
    approval["record"]["payload_sha256"] = json!(device_apply::record_hash(&c.payload));
    approval["record"]["target_key_hash"] = json!(crate::support::contracts::sha256(
        format!(
            "{}|{}|{}|{}",
            c.payload["device_kind"].as_str().unwrap(),
            c.payload["discovered_device_ref"]["ip"].as_str().unwrap(),
            c.payload["settings"]["port"].as_u64().unwrap(),
            c.payload["existing_device_id"].as_str().unwrap_or("")
        )
        .as_bytes()
    ));
    let mut client: Value = serde_json::from_slice(
        &B64.decode(approval["assertion"]["client_data_json"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    client["challenge"] = json!(B64.encode(
        digest::digest(&digest::SHA256, approval["record"].to_string().as_bytes()).as_ref()
    ));
    let client = client.to_string();
    let auth = B64
        .decode(
            approval["assertion"]["authenticator_data"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    let mut message = auth.clone();
    message.extend(digest::digest(&digest::SHA256, client.as_bytes()).as_ref());
    approval["assertion"]["client_data_json"] = json!(B64.encode(client));
    approval["assertion"]["signature"] =
        json!(B64.encode(key.sign(&rng, &message).unwrap().as_ref()));
    c.approval = Some(approval);
    Verifier::from_file(&keys)
}
#[test]
fn device_cash_register_fresh_admission_refusals_and_signed_save_undo_are_db_only() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    for (admitted, after_tap, unavailable) in [
        (Some(false), None, false),
        (None, None, false),
        (Some(true), None, true),
        (Some(true), Some(Some(false)), false),
        (Some(true), Some(None), false),
        (Some(true), None, false),
    ] {
        let (dir, db, services, mut c, context) = fixture("cash_register");
        let validation = device_apply::validate(&db.conn, &services, &c, &context).unwrap();
        c.payload["step"] = json!("apply");
        c.payload["validation_id"] = validation["validation_id"].clone();
        let verifier = approve_device(&mut c, &context);
        services.admitted.set(admitted);
        services.admission_after_tap.set(after_tap);
        services.admission_error.set(unavailable);
        let before = device_tables(&services);
        let result = device_apply::apply(&db.conn, &services, &verifier, &c, &context);
        if admitted == Some(true) && after_tap.is_none() && !unavailable {
            let result = result.unwrap();
            assert_eq!(result["outcome"], "pending");
            assert_eq!(services.onsite_calls.get(), 1);
            assert_eq!(
                crate::commands::ecr::support_read_device(
                    &services.business,
                    result["device_id"].as_str().unwrap()
                )
                .unwrap()
                .unwrap()["protocol"],
                "cap_driver"
            );
            device_apply::undo(
                &db.conn,
                &services,
                &c,
                result["audit_id"].as_str().unwrap(),
                context.server_now.unwrap(),
            )
            .unwrap();
            assert_eq!(device_tables(&services), before);
        } else {
            assert_eq!(result.unwrap_err(), "DEVICE_NOT_ADMITTED");
            assert_eq!(device_tables(&services), before);
            assert_eq!(services.saves.get(), 0);
        }
        assert_eq!(
            db.conn
                .query_row("SELECT count(*) FROM support_consumed_approvals", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(services.identification_calls.get(), 1);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
