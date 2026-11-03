use crate::support::{
    approval_verify::{ConsumedCommandApproval, Context, Verifier},
    clock,
    contracts::{payload_hash, sha256},
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
    _dir: crate::tests::harness::TempDir,
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
        let payload = json!({"step":"execute","command":"Write-Output 'Καλημέρα'\nWrite-Output 'your_fixture'", "explanation_el":"Your test explanation", "reason":"Your test reason", "timeout_s":60,"idempotency_key":"your_command_test_key"});
        let mut approval = v["approval"].clone();
        approval["record"]["kind"] = json!("command");
        approval["record"]["dry_run_or_validation_id"] = Value::Null;
        approval["record"]["payload_sha256"] = json!(Self::hash(&payload));
        approval["record"]["target_key_hash"] =
            json!(sha256(payload["command"].as_str().unwrap().as_bytes()));
        let mut fixture = Self {
            db,
            _dir: dir,
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
        let mut p = payload.as_object().unwrap().clone();
        p.remove("step");
        p.entry("timeout_s").or_insert(json!(60));
        payload_hash(&Value::Object(p))
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
fn withdrawn_command_record_refuses_before_any_support_write() {
    let _keyring = crate::tests::fake_keyring::install_empty();
    let f = Fixture::new(2);
    assert!(f.consume().is_err());
    f.assert_unspent();
}
