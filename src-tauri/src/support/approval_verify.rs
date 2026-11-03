//! Build-pinned WebAuthn trust. Network messages may revoke, never add keys.
use super::{clock, contracts::sha256, db};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::{agreement, digest, rand::SystemRandom, signature};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

pub const PINNED: &str = include_str!("../../../../shared/pos/support/approver-keys.json");
const REFUSAL: &str = "APPROVAL_NOT_VERIFIED";
#[derive(Clone)]
pub struct Context {
    pub session_id: String,
    pub terminal_id: String,
    pub server_now: Option<i64>,
    pub absolute_cap_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyFile {
    version: u8,
    keys: Vec<Key>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    credential_id: String,
    public_key: Jwk,
    #[serde(rename = "rpId")]
    rp_id: String,
    origins: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Jwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assertion {
    credential_id: String,
    authenticator_data: String,
    client_data_json: String,
    signature: String,
    user_handle: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    record: Value,
    explanation_text: String,
    assertion: Value,
}
pub struct Verifier {
    keys: Vec<Key>,
}
/// In-memory proof issued only after durable consumption. Private fields prevent
/// a caller from manufacturing a post-wait recheck without verifying a signature.
// Catalogue actions retain this proof through snapshot and on-site waits.
#[allow(dead_code)]
pub struct ConsumedCommandApproval {
    record: Value,
    command_id: String,
    credential_id: String,
    sign_count: u32,
    consumed_at: String,
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key].as_str().ok_or_else(|| REFUSAL.into())
}
fn require(ok: bool) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(REFUSAL.into())
    }
}
fn decode(text: &str) -> Result<Vec<u8>, String> {
    require(!text.is_empty() && text.len() <= 32768)?;
    let bytes = B64.decode(text).map_err(|_| REFUSAL)?;
    require(B64.encode(&bytes) == text)?;
    Ok(bytes)
}
fn point(key: &Key) -> Result<Vec<u8>, String> {
    require(key.public_key.kty == "EC" && key.public_key.crv == "P-256")?;
    let x = decode(&key.public_key.x)?;
    let y = decode(&key.public_key.y)?;
    require(x.len() == 32 && y.len() == 32)?;
    let mut point = vec![4];
    point.extend(x);
    point.extend(y);
    Ok(point)
}
impl Verifier {
    pub fn pinned() -> Self {
        Self::from_file(&serde_json::from_str(PINNED).unwrap_or(Value::Null))
    }
    pub fn from_file(file: &Value) -> Self {
        let parsed = serde_json::from_value::<KeyFile>(file.clone());
        let Ok(file) = parsed else {
            return Self { keys: vec![] };
        };
        let mut ids = BTreeSet::new();
        if file.version != 1
            || file
                .keys
                .iter()
                .any(|k| !ids.insert(k.credential_id.clone()))
        {
            return Self { keys: vec![] };
        }
        let keys = file
            .keys
            .into_iter()
            .filter(|key| {
                let Ok(bytes) = point(key) else { return false };
                if decode(&key.credential_id).is_err() || key.origins.is_empty() {
                    return false;
                }
                let mut origins = BTreeSet::new();
                for origin in &key.origins {
                    let Ok(u) = url::Url::parse(origin) else {
                        return false;
                    };
                    let host = u.host_str().unwrap_or("");
                    if !origins.insert(origin)
                        || u.origin().ascii_serialization() != *origin
                        || !u.username().is_empty()
                        || u.password().is_some()
                        || !(u.scheme() == "https" || (u.scheme() == "http" && host == "localhost"))
                        || !(host == key.rp_id || host.ends_with(&format!(".{}", key.rp_id)))
                    {
                        return false;
                    }
                }
                // ECDH validates the uncompressed point using ring's P-256 decoder.
                agreement::EphemeralPrivateKey::generate(
                    &agreement::ECDH_P256,
                    &SystemRandom::new(),
                )
                .ok()
                .is_some_and(|private| {
                    agreement::agree_ephemeral(
                        private,
                        &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, bytes),
                        |_| (),
                    )
                    .is_ok()
                })
            })
            .collect();
        Self { keys }
    }
    pub fn live_key_ids(&self, conn: &Connection) -> Result<Vec<String>, String> {
        self.keys
            .iter()
            .filter_map(|key| {
                match conn
                    .query_row(
                        "SELECT 1 FROM support_revoked_keys WHERE credential_id=?1",
                        [&key.credential_id],
                        |_| Ok(()),
                    )
                    .optional()
                {
                    Ok(None) => Some(Ok(key.credential_id.clone())),
                    Ok(Some(())) => None,
                    Err(_) => Some(Err(REFUSAL.into())),
                }
            })
            .collect()
    }
    pub fn advertisement(
        &self,
        conn: &Connection,
        capabilities: Vec<String>,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let ids = self.live_key_ids(conn)?;
        let mut capabilities: Vec<String> = capabilities
            .into_iter()
            .filter(|c| {
                c != "support.approval.webauthn-p256.v1"
                    && (!ids.is_empty() || c != "support.tier3.v1")
            })
            .collect();
        if !ids.is_empty() {
            capabilities.push("support.approval.webauthn-p256.v1".into());
        }
        Ok((capabilities, ids))
    }
    fn assertion(
        &self,
        conn: &Connection,
        record: &Value,
        raw: &Value,
        cached: bool,
    ) -> Result<(String, u32), String> {
        require(
            raw.as_object()
                .is_some_and(|o| o.len() == 5 && o.contains_key("user_handle")),
        )?;
        let assertion: Assertion = serde_json::from_value(raw.clone()).map_err(|_| REFUSAL)?;
        if let Some(handle) = &assertion.user_handle {
            decode(handle)?;
        }
        let key = self
            .keys
            .iter()
            .find(|key| key.credential_id == assertion.credential_id)
            .ok_or(REFUSAL)?;
        require(self.live_key_ids(conn)?.contains(&key.credential_id))?;
        let client_bytes = decode(&assertion.client_data_json)?;
        let client: Value = serde_json::from_slice(&client_bytes).map_err(|_| REFUSAL)?;
        let auth = decode(&assertion.authenticator_data)?;
        let challenge = digest::digest(
            &digest::SHA256,
            serde_json::to_string(record)
                .map_err(|_| REFUSAL)?
                .as_bytes(),
        );
        require(
            client["type"] == "webauthn.get"
                && client["challenge"] == B64.encode(challenge.as_ref())
                && key.origins.iter().any(|o| client["origin"] == *o)
                && client.get("crossOrigin").is_none_or(|c| c == false)
                && auth.len() >= 37,
        )?;
        require(
            auth[..32] == *digest::digest(&digest::SHA256, key.rp_id.as_bytes()).as_ref()
                && auth[32] & 5 == 5,
        )?;
        let count = u32::from_be_bytes(auth[33..37].try_into().map_err(|_| REFUSAL)?);
        let stored: i64 = conn
            .query_row(
                "SELECT sign_count FROM support_key_signcounts WHERE credential_id=?1",
                [&key.credential_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| REFUSAL)?
            .unwrap_or(0);
        require(
            (0..=u32::MAX as i64).contains(&stored)
                && (cached || (count == 0 && stored == 0) || i64::from(count) > stored),
        )?;
        let mut message = auth;
        message.extend(digest::digest(&digest::SHA256, &client_bytes).as_ref());
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, point(key)?)
            .verify(&message, &decode(&assertion.signature)?)
            .map_err(|_| REFUSAL)?;
        Ok((assertion.credential_id, count))
    }
    fn current(record: &Value, c: &Context) -> Result<String, String> {
        let now = c.server_now.ok_or(REFUSAL)?;
        require(
            record["session_id"] == c.session_id
                && record["terminal_id"] == c.terminal_id
                && clock::parse(text(record, "expires_at")?).map_err(|_| REFUSAL)? > now
                && clock::parse(&c.absolute_cap_at).map_err(|_| REFUSAL)?
                    >= clock::parse(text(record, "expires_at")?).map_err(|_| REFUSAL)?,
        )?;
        for key in ["session_id", "terminal_id"] {
            uuid::Uuid::parse_str(text(record, key)?).map_err(|_| REFUSAL)?;
        }
        Ok(clock::iso(now))
    }
    fn binding(
        raw: &Value,
        c: &Context,
        validation: &str,
        hash: &str,
        target: &Value,
    ) -> Result<Approval, String> {
        let a: Approval = serde_json::from_value(raw.clone()).map_err(|_| REFUSAL)?;
        let r = &a.record;
        Self::current(r, c)?;
        require(
            r.as_object().is_some_and(|o| o.len() == 10)
                && r["kind"] == "device_apply"
                && r["rows_cap"] == 0
                && r["dry_run_or_validation_id"] == validation
                && r["payload_sha256"] == hash
                && !a.explanation_text.is_empty()
                && a.explanation_text.chars().count() <= 600
                && r["explanation_sha256"] == sha256(a.explanation_text.as_bytes()),
        )?;
        uuid::Uuid::parse_str(text(r, "approval_id")?).map_err(|_| REFUSAL)?;
        uuid::Uuid::parse_str(validation).map_err(|_| REFUSAL)?;
        let port = target["port"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 65535)
            .ok_or(REFUSAL)?;
        let kind = text(target, "device_kind")?;
        let ip = text(target, "ip")?;
        ip.parse::<std::net::Ipv4Addr>().map_err(|_| REFUSAL)?;
        let existing = target["existing_device_id"].as_str().unwrap_or("");
        require(
            ["printer", "card_terminal", "cash_register"].contains(&kind)
                && !existing.contains(['|', '\r', '\n'])
                && r["target_key_hash"]
                    == sha256(format!("{kind}|{ip}|{port}|{existing}").as_bytes()),
        )?;
        Ok(a)
    }
    /// Durably spend a local dry-run and its approval before any execution.
    pub fn consume_breakglass(
        &self,
        conn: &Connection,
        raw: &Value,
        c: &Context,
        command: &str,
        kind: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        (|| {
            let a:Approval=serde_json::from_value(raw.clone()).map_err(|_|REFUSAL)?;
            let at=Self::current(&a.record,c)?;
            require(["sql","quarantine","restore"].contains(&kind) && payload["step"]=="execute")?;
            let hash=super::dry_run::payload_digest(payload)?;let r=&a.record;
            require(r.as_object().is_some_and(|o|o.len()==10) && r["kind"]==kind && r["payload_sha256"]==hash && !a.explanation_text.is_empty() && a.explanation_text.chars().count()<=600 && r["explanation_sha256"]==sha256(a.explanation_text.as_bytes()))?;
            uuid::Uuid::parse_str(text(r,"approval_id")?).map_err(|_|REFUSAL)?;
            let dry_id=text(r,"dry_run_or_validation_id")?;uuid::Uuid::parse_str(dry_id).map_err(|_|REFUSAL)?;
            let tx=db::transaction(conn).map_err(|_|REFUSAL)?;
            let stored:Option<(String,String,String,String,Option<String>)>=tx.query_row("SELECT payload_sha256,target_key_sha256,result_json,expires_at,consumed_at FROM support_dry_runs WHERE dry_run_id=?1",[dry_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|_|REFUSAL)?;
            let (digest,target,encoded,expires,consumed)=stored.ok_or(REFUSAL)?;let stored:Value=serde_json::from_str(&encoded).map_err(|_|REFUSAL)?;let result=&stored["result"];
            let cap=r["rows_cap"].as_u64().ok_or(REFUSAL)?;
            let total=result["rows_affected"].as_array().ok_or(REFUSAL)?.iter().try_fold(0u64,|sum,t|["inserted","updated","deleted"].iter().try_fold(sum,|sum,k|sum.checked_add(t[k].as_u64()?).filter(|n|*n<=1000))).ok_or(REFUSAL)?;
            require(consumed.is_none() && clock::parse(&expires).map_err(|_|REFUSAL)?>c.server_now.ok_or(REFUSAL)? && stored["sessionId"]==c.session_id && digest==hash && result["dry_run_id"]==dry_id && result["payload_sha256"]==hash && result["target_key_sha256"]==target && r["target_key_hash"]==target && (1..=1000).contains(&cap) && total<=cap && cap<=result["rows_cap_evaluated"].as_u64().ok_or(REFUSAL)?)?;
            let (credential,count)=self.assertion(&tx,r,&a.assertion,false)?;
            require(tx.execute("UPDATE support_dry_runs SET consumed_at=?1 WHERE dry_run_id=?2 AND consumed_at IS NULL",params![at,dry_id]).map_err(|_|REFUSAL)?==1)?;
            tx.execute("INSERT INTO support_consumed_approvals(approval_id,command_id,kind,dry_run_or_validation_id,payload_sha256,credential_id,sign_count,consumed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![text(r,"approval_id")?,command,kind,dry_id,hash,credential,count,at]).map_err(|_|REFUSAL)?;
            save_count(&tx,&credential,count,&at)?;tx.commit().map_err(|_|REFUSAL)?;Ok(result.clone())
        })().map_err(|_:String|REFUSAL.into())
    }
    /// Spend before snapshot, on-site confirmation or process creation. Nothing
    /// in this API refunds consumption, including decline and prelaunch failure.
    // Wired by the task 21.4 runner.
    #[allow(dead_code)]
    pub fn consume_command(
        &self,
        conn: &Connection,
        raw: &Value,
        c: &Context,
        command: &str,
        payload: &Value,
    ) -> Result<ConsumedCommandApproval, String> {
        let a: Approval = serde_json::from_value(raw.clone()).map_err(|_| REFUSAL)?;
        let at = Self::command_binding(&a.record, c, payload)?;
        require(
            !a.explanation_text.is_empty()
                && a.explanation_text.chars().count() <= 600
                && a.record["explanation_sha256"] == sha256(a.explanation_text.as_bytes()),
        )?;
        uuid::Uuid::parse_str(command).map_err(|_| REFUSAL)?;
        let tx = db::transaction(conn).map_err(|_| REFUSAL)?;
        Self::command_session(&tx, c, &at)?;
        let (credential, count) = self.assertion(&tx, &a.record, &a.assertion, false)?;
        tx.execute(
            "INSERT INTO support_consumed_approvals(approval_id,command_id,kind,dry_run_or_validation_id,payload_sha256,credential_id,sign_count,consumed_at) VALUES(?1,?2,?7,NULL,?3,?4,?5,?6)",
            params![text(&a.record, "approval_id")?, command, text(&a.record, "payload_sha256")?, credential, count, at, "catalogue_action"],
        ).map_err(|_| REFUSAL)?;
        save_count(&tx, &credential, count, &at)?;
        tx.commit().map_err(|_| REFUSAL)?;
        Ok(ConsumedCommandApproval {
            record: a.record,
            command_id: command.into(),
            credential_id: credential,
            sign_count: count,
            consumed_at: at,
        })
    }
    /// Cheap post-wait check using the immutable, signature-verified proof. No
    /// counter update or signature verification, and never new authorization.
    /// Context must be freshly obtained from local identity/session/server time.
    // Catalogue actions recheck after every wait and immediately before an effect.
    #[allow(dead_code)]
    pub fn assert_consumed_command(
        &self,
        conn: &Connection,
        proof: &ConsumedCommandApproval,
        c: &Context,
        command: &str,
        payload: &Value,
    ) -> Result<(), String> {
        let at = Self::command_binding(&proof.record, c, payload)?;
        require(command == proof.command_id)?;
        require(
            self.keys
                .iter()
                .any(|key| key.credential_id == proof.credential_id),
        )?;
        Self::command_session(conn, c, &at)?;
        let matched: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM support_consumed_approvals a WHERE a.approval_id=?1 AND a.command_id=?2 AND a.kind=?7 AND a.dry_run_or_validation_id IS NULL AND a.payload_sha256=?3 AND a.credential_id=?4 AND a.sign_count=?5 AND a.consumed_at=?6 AND NOT EXISTS(SELECT 1 FROM support_revoked_keys r WHERE r.credential_id=a.credential_id))",
            params![text(&proof.record, "approval_id")?, command, text(&proof.record, "payload_sha256")?, proof.credential_id, proof.sign_count, proof.consumed_at, "catalogue_action"],
            |r| r.get(0),
        ).map_err(|_| REFUSAL)?;
        require(matched)
    }
    fn command_binding(record: &Value, c: &Context, payload: &Value) -> Result<String, String> {
        require(record["kind"] == "catalogue_action")?;
        let at = Self::current(record, c)?;
        if record["kind"] == "catalogue_action" {
            let canonical = super::catalogue::contract::canonical_payload(payload.clone())
                .map_err(|_| REFUSAL)?;
            require(
                record
                    .as_object()
                    .is_some_and(|o| o.len() == 10 && o.contains_key("dry_run_or_validation_id"))
                    && record["dry_run_or_validation_id"].is_null()
                    && record["rows_cap"] == 0
                    && record["payload_sha256"] == sha256(canonical.as_bytes())
                    && record["target_key_hash"] == payload["target_fingerprint"]
                    && payload["terminal_id"] == c.terminal_id
                    && payload["session_id"] == c.session_id
                    && payload["expires_at"] == record["expires_at"],
            )?;
            uuid::Uuid::parse_str(text(record, "approval_id")?).map_err(|_| REFUSAL)?;
            return Ok(at);
        }
        Err(REFUSAL.into())
    }
    fn command_session(conn: &Connection, c: &Context, at: &str) -> Result<(), String> {
        let active: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM support_session_state WHERE session_id=?1 AND status='active' AND tier_ceiling=3 AND absolute_cap_at=?2 AND julianday(max_expires_at)>julianday(?3))",
            params![c.session_id, c.absolute_cap_at, at], |r| r.get(0),
        ).map_err(|_| REFUSAL)?;
        require(active)
    }
    pub fn assert_consumed_breakglass(
        &self,
        conn: &Connection,
        raw: &Value,
        c: &Context,
        command: &str,
        payload: &Value,
    ) -> Result<(), String> {
        let a: Approval = serde_json::from_value(raw.clone()).map_err(|_| REFUSAL)?;
        let at = Self::current(&a.record, c)?;
        let (credential, _) = self.assertion(conn, &a.record, &a.assertion, true)?;
        let matched:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM support_consumed_approvals a JOIN support_dry_runs d ON d.dry_run_id=a.dry_run_or_validation_id WHERE a.command_id=?1 AND a.approval_id=?2 AND a.credential_id=?3 AND a.payload_sha256=?4 AND d.consumed_at IS NOT NULL AND julianday(d.expires_at)>julianday(?5))",params![command,text(&a.record,"approval_id")?,credential,super::dry_run::payload_digest(payload)?,at],|r|r.get(0)).map_err(|_|REFUSAL)?;
        require(matched)
    }
    pub fn consume_device(
        &self,
        conn: &Connection,
        raw: &Value,
        c: &Context,
        command: &str,
        validation: &str,
        hash: &str,
        target: &Value,
    ) -> Result<(), String> {
        (|| {
            let a=Self::binding(raw,c,validation,hash,target)?; let at=Self::current(&a.record,c)?;
            let tx=db::transaction(conn).map_err(|_|REFUSAL)?;
            let (credential,count)=self.assertion(&tx,&a.record,&a.assertion,false)?;
            let changed=tx.execute("UPDATE support_validations SET consumed_at=?1 WHERE validation_id=?2 AND session_id=?3 AND record_sha256=?4 AND consumed_at IS NULL AND julianday(expires_at)>julianday(?1)",params![at,validation,c.session_id,hash]).map_err(|_|REFUSAL)?;
            require(changed==1)?;
            tx.execute("INSERT INTO support_consumed_approvals(approval_id,command_id,kind,dry_run_or_validation_id,payload_sha256,credential_id,sign_count,consumed_at) VALUES(?1,?2,'device_apply',?3,?4,?5,?6,?7)",params![text(&a.record,"approval_id")?,command,validation,hash,credential,count,at]).map_err(|_|REFUSAL)?;
            save_count(&tx,&credential,count,&at)?; tx.commit().map_err(|_|REFUSAL)?; Ok(())
        })().map_err(|_: String|REFUSAL.into())
    }
    pub fn assert_consumed_device(
        &self,
        conn: &Connection,
        raw: &Value,
        c: &Context,
        command: &str,
        validation: &str,
        hash: &str,
        target: &Value,
    ) -> Result<(), String> {
        let a = Self::binding(raw, c, validation, hash, target)?;
        let (credential, _) = self.assertion(conn, &a.record, &a.assertion, true)?;
        let matched: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM support_consumed_approvals a JOIN support_validations v ON v.validation_id=a.dry_run_or_validation_id WHERE a.approval_id=?1 AND a.command_id=?2 AND a.credential_id=?3 AND a.payload_sha256=?4 AND v.validation_id=?5 AND v.session_id=?6 AND v.record_sha256=?4 AND v.consumed_at IS NOT NULL AND julianday(v.expires_at)>julianday(?7))",params![text(&a.record,"approval_id")?,command,credential,hash,validation,c.session_id,clock::iso(c.server_now.ok_or(REFUSAL)?)],|r|r.get(0)).map_err(|_|REFUSAL)?;
        require(matched)
    }
    pub fn mark_unattended(
        &self,
        conn: &Connection,
        raw: &Value,
        c: &Context,
    ) -> Result<bool, String> {
        let result = (|| {
            let r = &raw["record"];
            let a = &raw["assertion"];
            let at = Self::current(r, c)?;
            require(
                r.as_object().is_some_and(|o| o.len() == 4)
                    && r["kind"] == "mark_unattended"
                    && r["expires_at"] == c.absolute_cap_at,
            )?;
            let tx = db::transaction(conn).map_err(|_| REFUSAL)?;
            let existing: Option<(Option<String>,Option<String>,Option<String>)>=tx.query_row("SELECT unattended_record_json,unattended_assertion_json,unattended_verified_at FROM support_session_state WHERE session_id=?1 AND status='active' AND absolute_cap_at=?2",params![c.session_id,c.absolute_cap_at],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|_|REFUSAL)?;
            let existing = existing.ok_or(REFUSAL)?;
            let cached = existing.2.is_some()
                && existing.0.as_deref() == Some(&r.to_string())
                && existing.1.as_deref() == Some(&a.to_string());
            let (credential, count) = self.assertion(&tx, r, a, cached)?;
            if !cached {
                save_count(&tx, &credential, count, &at)?;
            }
            tx.execute("UPDATE support_session_state SET attended=0,unattended_record_json=?1,unattended_assertion_json=?2,unattended_verified_at=?3 WHERE session_id=?4",params![r.to_string(),a.to_string(),at,c.session_id]).map_err(|_|REFUSAL)?;
            tx.commit().map_err(|_| REFUSAL)?;
            Ok::<_, String>(true)
        })();
        if result.is_err() {
            conn.execute("UPDATE support_session_state SET attended=1,unattended_record_json=NULL,unattended_assertion_json=NULL,unattended_verified_at=NULL WHERE session_id=?1",[&c.session_id]).map_err(|_|REFUSAL)?;
        }
        Ok(result.unwrap_or(false))
    }
    pub fn is_unattended(&self, conn: &Connection, c: &Context) -> Result<bool, String> {
        let proof:Option<(String,String)>=conn.query_row("SELECT unattended_record_json,unattended_assertion_json FROM support_session_state WHERE session_id=?1 AND attended=0 AND unattended_verified_at IS NOT NULL",[&c.session_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|REFUSAL)?;
        let Some((r, a)) = proof else {
            return Ok(false);
        };
        let record = serde_json::from_str::<Value>(&r).unwrap_or(Value::Null);
        let assertion = serde_json::from_str::<Value>(&a).unwrap_or(Value::Null);
        self.mark_unattended(
            conn,
            &serde_json::json!({"record":record,"assertion":assertion}),
            c,
        )
    }
}
fn save_count(conn: &Connection, credential: &str, count: u32, at: &str) -> Result<(), String> {
    conn.execute("INSERT INTO support_key_signcounts VALUES(?1,?2,?3) ON CONFLICT(credential_id) DO UPDATE SET sign_count=excluded.sign_count,updated_at=excluded.updated_at",params![credential,count,at]).map_err(|_|REFUSAL)?;
    Ok(())
}

#[cfg(test)]
#[path = "tests/catalogue_approval_tests.rs"]
mod catalogue_tests;

#[cfg(test)]
mod withdrawn_command_tests {
    use super::*;
    #[test]
    fn historical_command_binding_cannot_recheck() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/approval-assertion-vectors.json"
        ))
        .unwrap();
        let vector = &vectors["vectors"][0];
        let payload = serde_json::json!({"step":"execute", "command":"your-text", "timeout_s":60});
        let normalized = serde_json::json!({"command":"your-text", "timeout_s":60});
        let mut record = vector["approval"]["record"].clone();
        record["kind"] = Value::from("command");
        record["rows_cap"] = Value::from(0);
        record["dry_run_or_validation_id"] = Value::Null;
        record["payload_sha256"] = Value::from(super::super::contracts::payload_hash(&normalized));
        record["target_key_hash"] = Value::from(sha256(b"your-text"));
        let context = Context {
            session_id: vector["context"]["session_id"].as_str().unwrap().into(),
            terminal_id: vector["context"]["terminal_id"].as_str().unwrap().into(),
            server_now: Some(
                clock::parse(vector["state"]["server_time"].as_str().unwrap()).unwrap(),
            ),
            absolute_cap_at: vector["context"]["absolute_cap_at"]
                .as_str()
                .unwrap()
                .into(),
        };
        assert!(Verifier::current(&record, &context).is_ok());
        assert!(Verifier::command_binding(&record, &context, &payload).is_err());
    }
}
