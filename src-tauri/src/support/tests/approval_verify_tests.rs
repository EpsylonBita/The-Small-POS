use crate::support::{
    approval_verify::{Context, Verifier},
    contracts,
    db::SupportDb,
};
use rusqlite::params;
use serde_json::{json, Value};

#[test]
fn all_30_shared_breakglass_vectors_and_single_use_claims() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/breakglass-approval-vectors.json"
    ))
    .unwrap();
    let vectors = fixtures["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 30);
    for v in vectors {
        let dir = std::env::temp_dir().join(format!("support-breakglass-{}", uuid::Uuid::new_v4()));
        let db = SupportDb::open(&dir).unwrap();
        let c = &v["context"];
        let at = v["state"]["server_time"].as_str().unwrap();
        let dry = &v["breakglass"]["dry_run"];
        if !dry.is_null() {
            let r = &dry["result"];
            db.conn.execute("INSERT INTO support_dry_runs(dry_run_id,proposal_id,payload_sha256,target_key_sha256,result_json,expires_at,consumed_at,created_at) VALUES(?1,'your_proposal',?2,?3,?4,?5,?6,?7)", params![r["dry_run_id"].as_str(),r["payload_sha256"].as_str(),r["target_key_sha256"].as_str(),dry.to_string(),r["expires_at"].as_str(),dry["consumed_at"].as_str(),at]).unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO support_key_signcounts VALUES(?1,?2,?3)",
                params![
                    v["credential_id"].as_str(),
                    v["state"]["stored_sign_count"].as_i64(),
                    at
                ],
            )
            .unwrap();
        for id in v["state"]["revoked_ids"].as_array().unwrap() {
            db.conn
                .execute(
                    "INSERT INTO support_revoked_keys VALUES(?1,?2,?2)",
                    params![id.as_str(), at],
                )
                .unwrap();
        }
        let context = Context {
            session_id: c["session_id"].as_str().unwrap().into(),
            terminal_id: c["terminal_id"].as_str().unwrap().into(),
            server_now: Some(crate::support::clock::parse(at).unwrap()),
            absolute_cap_at: c["absolute_cap_at"].as_str().unwrap().into(),
        };
        let verifier = Verifier::from_file(&v["pinned_keys"]);
        let kind = v["record"]["kind"].as_str().unwrap();
        let run = || {
            verifier.consume_breakglass(
                &db.conn,
                &v["approval"],
                &context,
                c["command_id"].as_str().unwrap(),
                kind,
                &v["input"],
            )
        };
        let result = run();
        assert_eq!(
            result.as_ref().map(|_| "ok").unwrap_or_else(|e| e.as_str()),
            v["expected"].as_str().unwrap(),
            "{}",
            v["name"]
        );
        if result.is_ok() {
            assert_eq!(
                run().unwrap_err(),
                "APPROVAL_NOT_VERIFIED",
                "approval stays spent after decline/rollback/crash"
            );
        }
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn all_shared_payload_hash_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/payload-hash-vectors.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        assert_eq!(
            contracts::payload_hash(&vector["payload"]),
            vector["sha256"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn all_38_shared_assertion_vectors() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let vectors = fixtures["vectors"].as_array().unwrap();
    assert_eq!(vectors.len(), 38);
    for v in vectors {
        let dir = std::env::temp_dir().join(format!("support-approval-{}", uuid::Uuid::new_v4()));
        let db = SupportDb::open(&dir).unwrap();
        let c = &v["context"];
        let state = &v["state"];
        let text = |v: &Value| v.as_str().unwrap().to_string();
        let at = text(&state["server_time"]);
        db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES(?1,'active',2,?2,?2,?3)", params![text(&c["session_id"]),text(&c["absolute_cap_at"]),at]).unwrap();
        for id in state["revoked_ids"].as_array().unwrap() {
            db.conn
                .execute(
                    "INSERT INTO support_revoked_keys VALUES(?1,?2,?2)",
                    params![text(id), at],
                )
                .unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO support_key_signcounts VALUES(?1,?2,?3)",
                params![
                    text(&v["credential_id"]),
                    state["stored_sign_count"].as_i64().unwrap(),
                    at
                ],
            )
            .unwrap();
        let val = &state["validation"];
        if !val.is_null() {
            db.conn.execute("INSERT INTO support_validations(validation_id,session_id,device_kind,device_ref_json,record_json,record_sha256,expires_at,consumed_at,created_at) VALUES(?1,?2,'card_terminal','{}','{}',?3,?4,?5,?6)",params![text(&val["validation_id"]),text(&val["session_id"]),text(&val["record_sha256"]),text(&val["expires_at"]),val["consumed_at"].as_str(),at]).unwrap();
        }
        for id in state["consumed_approvals"].as_array().unwrap() {
            db.conn.execute("INSERT INTO support_consumed_approvals(approval_id,command_id,kind,payload_sha256,credential_id,consumed_at) VALUES(?1,?2,'device_apply',?3,?4,?5)",params![text(id),text(&c["command_id"]),text(&c["record_sha256"]),text(&v["credential_id"]),at]).unwrap();
        }
        let context = Context {
            session_id: text(&c["session_id"]),
            terminal_id: text(&c["terminal_id"]),
            server_now: Some(crate::support::clock::parse(&at).unwrap()),
            absolute_cap_at: text(&c["absolute_cap_at"]),
        };
        let verifier = Verifier::from_file(&v["pinned_keys"]);
        let result = match v["mode"].as_str().unwrap() {
            "capability" => {
                let (caps, ids) = verifier
                    .advertisement(
                        &db.conn,
                        vec![
                            "support.tier3.v1".into(),
                            "support.approval.webauthn-p256.v1".into(),
                        ],
                    )
                    .unwrap();
                assert!(caps.is_empty() && ids.is_empty());
                Ok(())
            }
            "unattended" => verifier
                .mark_unattended(
                    &db.conn,
                    &json!({"record":v["record"],"assertion":v["assertion"]}),
                    &context,
                )
                .and_then(|ok| {
                    if ok {
                        Ok(())
                    } else {
                        Err("APPROVAL_NOT_VERIFIED".into())
                    }
                }),
            _ => verifier.consume_device(
                &db.conn,
                &v["approval"],
                &context,
                &text(&c["command_id"]),
                &text(&c["validation_id"]),
                &text(&c["record_sha256"]),
                &c["target"],
            ),
        };
        assert_eq!(
            result.as_ref().map(|_| "ok").unwrap_or_else(|e| e.as_str()),
            v["expected"].as_str().unwrap(),
            "{}",
            v["name"]
        );
        if v["mode"] == "approval" && result.is_ok() {
            assert!(
                verifier
                    .consume_device(
                        &db.conn,
                        &v["approval"],
                        &context,
                        &text(&c["command_id"]),
                        &text(&c["validation_id"]),
                        &text(&c["record_sha256"]),
                        &c["target"]
                    )
                    .is_err(),
                "restart replay: {}",
                v["name"]
            );
        }
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn approval_advertisement_is_build_pinned_and_remove_only() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
    ))
    .unwrap();
    let v = &fixtures["vectors"][0];
    let dir = std::env::temp_dir().join(format!("support-capability-{}", uuid::Uuid::new_v4()));
    let db = SupportDb::open(&dir).unwrap();
    let verifier = Verifier::from_file(&v["pinned_keys"]);
    let (caps, ids) = verifier
        .advertisement(&db.conn, vec!["support.tier2.v1".into()])
        .unwrap();
    assert_eq!(
        caps,
        vec!["support.tier2.v1", "support.approval.webauthn-p256.v1"]
    );
    assert_eq!(ids.len(), 1);
    db.conn
        .execute(
            "INSERT INTO support_revoked_keys VALUES(?1,'your_time','your_time')",
            [&ids[0]],
        )
        .unwrap();
    let (caps, ids) = verifier
        .advertisement(
            &db.conn,
            vec![
                "support.tier2.v1".into(),
                "support.tier3.v1".into(),
                "support.approval.webauthn-p256.v1".into(),
            ],
        )
        .unwrap();
    assert_eq!(caps, vec!["support.tier2.v1"]);
    assert!(ids.is_empty());
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}
