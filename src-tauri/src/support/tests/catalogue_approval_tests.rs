use crate::support::{
    approval_verify::{ConsumedCommandApproval, Context, Verifier},
    clock,
    contracts::sha256,
    db::SupportDb,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::{
    digest,
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
};
use serde_json::{json, Value};

struct Fixture {
    db: SupportDb,
    dir: crate::tests::harness::TempDir,
    verifier: Verifier,
    key: EcdsaKeyPair,
    approval: Value,
    payload: Value,
    context: Context,
    command_id: String,
}
impl Fixture {
    fn new(count: u32) -> Self {
        // Reuse the vector's RP, context, IDs and assertion format. Its private
        // key is unavailable, so sign using an ephemeral test-only key through
        // the existing from_file seam. Never change the shipped key file.
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
        ))
        .unwrap();
        let v = &vectors["vectors"][0];
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        let public = key.public_key().as_ref();
        let mut keys = v["pinned_keys"].clone();
        keys["keys"][0]["public_key"]["x"] = json!(B64.encode(&public[1..33]));
        keys["keys"][0]["public_key"]["y"] = json!(B64.encode(&public[33..65]));
        let dir = crate::tests::harness::TempDir::new();
        let db = SupportDb::open(dir.path()).unwrap();
        let context = Context {
            session_id: v["context"]["session_id"].as_str().unwrap().into(),
            terminal_id: v["context"]["terminal_id"].as_str().unwrap().into(),
            server_now: Some(clock::parse(v["state"]["server_time"].as_str().unwrap()).unwrap()),
            absolute_cap_at: v["context"]["absolute_cap_at"].as_str().unwrap().into(),
        };
        db.conn.execute("INSERT INTO support_session_state(session_id,status,tier_ceiling,max_expires_at,absolute_cap_at,updated_at) VALUES(?1,'active',3,?2,?2,'your_time')", rusqlite::params![context.session_id,context.absolute_cap_at]).unwrap();
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../../shared/pos/support/fixtures/catalogue-canonical-vectors.json"
        ))
        .unwrap();
        let mut payload = vectors[0]["payload"].clone();
        payload["session_id"] = json!(context.session_id);
        payload["terminal_id"] = json!(context.terminal_id);
        payload["expires_at"] = v["approval"]["record"]["expires_at"].clone();
        let mut approval = v["approval"].clone();
        approval["record"]["kind"] = json!("catalogue_action");
        approval["record"]["dry_run_or_validation_id"] = Value::Null;
        approval["record"]["payload_sha256"] = json!(Self::hash(&payload));
        approval["record"]["target_key_hash"] = payload["target_fingerprint"].clone();
        let mut fixture = Self {
            db,
            dir,
            verifier: Verifier::from_file(&keys),
            key,
            approval,
            payload,
            context,
            command_id: v["context"]["command_id"].as_str().unwrap().into(),
        };
        fixture.sign(count);
        fixture
    }
    fn hash(payload: &Value) -> String {
        sha256(
            crate::support::catalogue::contract::canonical_payload(payload.clone())
                .unwrap()
                .as_bytes(),
        )
    }

    fn sign(&mut self, count: u32) {
        let mut client: Value = serde_json::from_slice(
            &B64.decode(
                self.approval["assertion"]["client_data_json"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        client["challenge"] = json!(B64.encode(
            digest::digest(
                &digest::SHA256,
                self.approval["record"].to_string().as_bytes()
            )
            .as_ref()
        ));
        let client = client.to_string();
        let mut auth = B64
            .decode(
                self.approval["assertion"]["authenticator_data"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        auth[33..37].copy_from_slice(&count.to_be_bytes());
        let mut message = auth.clone();
        message.extend(digest::digest(&digest::SHA256, client.as_bytes()).as_ref());
        self.approval["assertion"]["client_data_json"] = json!(B64.encode(client));
        self.approval["assertion"]["authenticator_data"] = json!(B64.encode(auth));
        self.approval["assertion"]["signature"] = json!(B64.encode(
            self.key
                .sign(&SystemRandom::new(), &message)
                .unwrap()
                .as_ref()
        ));
    }
    fn consume(&self) -> Result<ConsumedCommandApproval, String> {
        self.verifier.consume_command(
            &self.db.conn,
            &self.approval,
            &self.context,
            &self.command_id,
            &self.payload,
        )
    }
    fn recheck(&self, proof: &ConsumedCommandApproval) -> Result<(), String> {
        self.verifier.assert_consumed_command(
            &self.db.conn,
            proof,
            &self.context,
            &self.command_id,
            &self.payload,
        )
    }
    fn revoke(&self) {
        self.db
            .conn
            .execute(
                "INSERT INTO support_revoked_keys VALUES(?1,'your_time','your_time')",
                [self.approval["assertion"]["credential_id"]
                    .as_str()
                    .unwrap()],
            )
            .unwrap();
    }
    fn assert_unspent(&self) {
        for table in [
            "support_consumed_approvals",
            "support_key_signcounts",
            "support_dry_runs",
        ] {
            assert_eq!(
                self.db
                    .conn
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
}

#[test]
fn catalogue_approval_is_bound_once_and_survives_decline_timeout_or_crash() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    for outcome in ["decline", "timeout", "crash"] {
        let f = Fixture::new(2);
        let proof = f.consume().unwrap();
        f.recheck(&proof).unwrap();
        let mut onsite = crate::support::onsite::Onsite::default();
        let now = std::time::Instant::now();
        onsite
            .begin(&f.command_id, &f.context.session_id, json!({}), now)
            .unwrap();
        if outcome == "decline" {
            onsite
                .decide(
                    &f.command_id,
                    &f.context.session_id,
                    "declined",
                    true,
                    false,
                    now,
                )
                .unwrap();
        } else if outcome == "timeout" {
            assert_eq!(
                onsite
                    .answer(&f.command_id, now + std::time::Duration::from_secs(300))
                    .unwrap()
                    .as_deref(),
                Some("ONSITE_TIMEOUT")
            );
        }
        drop(proof);
        assert!(f.consume().is_err(), "{outcome}");
        let db = SupportDb::open(f.dir.path()).unwrap();
        assert_eq!(
            db.conn
                .query_row("SELECT kind FROM support_consumed_approvals", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "catalogue_action"
        );
    }
}
#[test]
fn catalogue_approval_refuses_payload_session_expiry_and_revocation_drift() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    for case in 0..6 {
        let mut f = Fixture::new(2);
        match case {
            0 => f.payload["target_fingerprint"] = json!("e".repeat(64)),
            1 => f.context.session_id = uuid::Uuid::new_v4().to_string(),
            2 => f.context.terminal_id = uuid::Uuid::new_v4().to_string(),
            3 => {
                f.context.server_now = Some(
                    clock::parse(f.approval["record"]["expires_at"].as_str().unwrap()).unwrap(),
                )
            }
            4 => f.revoke(),
            _ => f.payload["inputs"]["printer"]["configuration_revision"] = json!(22),
        }
        assert!(f.consume().is_err(), "case {case}");
        f.assert_unspent();
    }
}
#[test]
fn catalogue_post_wait_checks_reject_drift_without_refunding_consumption() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let _gate = crate::support::critical_op::install_test_gate();
    crate::tests::fake_keyring::before_each_read(|key| panic!("Unexpected keyring read: {key}"));
    for case in 0..4 {
        let mut f = Fixture::new(2);
        let proof = f.consume().unwrap();
        match case {
            0 => f.payload["target_fingerprint"] = json!("b".repeat(64)),
            1 => f.context.session_id = uuid::Uuid::new_v4().to_string(),
            2 => {
                f.context.server_now = Some(
                    clock::parse(f.approval["record"]["expires_at"].as_str().unwrap()).unwrap(),
                )
            }
            _ => f.revoke(),
        }
        assert!(f.recheck(&proof).is_err(), "case {case}");
        assert_eq!(
            f.db.conn
                .query_row("SELECT count(*) FROM support_consumed_approvals", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
