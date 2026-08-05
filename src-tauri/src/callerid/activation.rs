//! Cache-first activation policy for the always-bundled Caller ID runtime.
//!
//! The telephony bridge is a safety-critical local facility and must remain
//! available independently of subscription state.  This policy therefore
//! gates only Caller ID collection/emission.  An expired or explicitly
//! revoked lease resolves to `BridgeOnly`; it never requests voice teardown.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

const CACHE_VERSION: u8 = 1;
const CLOCK_SKEW: Duration = Duration::minutes(5);
const MAX_OFFLINE_LEASE: Duration = Duration::hours(72);
// Windows Credential Manager accepts at most 2560 bytes per generic
// credential.  Staying below 900 UTF-16 code units leaves ample room for the
// platform encoding while the two-bank manifest gives us crash-safe writes.
const CACHE_CHUNK_UTF16_UNITS: usize = 900;
const OFFLINE_LEASE_MEDIA_TYPE: &str = "the-small/caller-id-offline-lease+jws";
const MAX_PROTECTED_JWS_BYTES: usize = 1_024;
const MAX_PAYLOAD_JWS_BYTES: usize = 64 * 1_024;
const MAX_SIGNATURE_JWS_BYTES: usize = 512;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivationWire {
    source_terminal: bool,
    source_terminal_id: Option<String>,
    caller_id_mode: String,
    voice_continuity: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfflineLeaseWire {
    terminal_id: String,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    on_expiry: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotWire {
    enabled: bool,
    activation: ActivationWire,
    ip_trust_source_policy: IpTrustSourcePolicyWire,
    offline_lease: OfflineLeaseWire,
    signed_lease: SignedLeaseWire,
    source_lines: Vec<Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum IpTrustSourcePolicyWire {
    Blocked,
    FounderPilot,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedLeaseWire {
    protected: String,
    payload: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedLeaseHeaderWire {
    alg: String,
    kid: String,
    typ: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedLeaseClaimsWire {
    version: u8,
    lease_id: String,
    terminal_id: String,
    terminal_db_id: String,
    organization_id: String,
    branch_id: String,
    issued_at: String,
    expires_at: String,
    on_expiry: String,
    ip_trust_source_policy: IpTrustSourcePolicyWire,
    activation: ActivationWire,
    config: SignedLeaseConfigWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedLeaseConfigWire {
    enabled: bool,
    source_lines: Vec<Value>,
}

#[derive(Debug, Clone)]
struct OfflineLeaseVerifier {
    key_id: String,
    public_key: [u8; 32],
}

/// Transitional shape emitted by production servers that predate offline
/// leases.  It is accepted only for the current authenticated online poll and
/// is never written to the offline cache.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyOnlineSnapshotWire {
    enabled: bool,
    source_lines: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeActivation {
    CallerIdSource,
    InactiveTerminal,
    BridgeOnly,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivationDecision {
    pub mode: RuntimeActivation,
    pub config: Value,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedActivation {
    version: u8,
    terminal_id: String,
    stored_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    config: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CacheBank {
    A,
    B,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheManifest {
    version: u8,
    bank: CacheBank,
    chunks: usize,
}

fn valid_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn verifier_from_config(
    public_key: Option<&str>,
    key_id: Option<&str>,
) -> Result<OfflineLeaseVerifier, String> {
    let key_id = key_id
        .map(str::trim)
        .filter(|value| valid_key_id(value))
        .ok_or_else(|| "Caller ID offline lease verification key ID is unavailable".to_string())?;
    let encoded_key = public_key
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .ok_or_else(|| "Caller ID offline lease public key is unavailable".to_string())?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded_key)
        .map_err(|_| "Caller ID offline lease public key is invalid".to_string())?;
    let public_key: [u8; 32] = decoded
        .try_into()
        .map_err(|_| "Caller ID offline lease public key must contain 32 raw bytes".to_string())?;
    Ok(OfflineLeaseVerifier {
        key_id: key_id.to_string(),
        public_key,
    })
}

#[cfg(not(test))]
fn configured_offline_lease_verifier() -> Result<OfflineLeaseVerifier, String> {
    verifier_from_config(
        option_env!("CALLER_ID_OFFLINE_LEASE_PUBLIC_KEY"),
        option_env!("CALLER_ID_OFFLINE_LEASE_KEY_ID"),
    )
}

#[cfg(test)]
const TEST_OFFLINE_LEASE_SEED: [u8; 32] = [0x42; 32];

#[cfg(test)]
const TEST_OFFLINE_LEASE_KEY_ID: &str = "caller-id-tauri-test-2026-08";

#[cfg(test)]
fn configured_offline_lease_verifier() -> Result<OfflineLeaseVerifier, String> {
    use ring::signature::{Ed25519KeyPair, KeyPair};

    let pair = Ed25519KeyPair::from_seed_unchecked(&TEST_OFFLINE_LEASE_SEED)
        .map_err(|_| "Caller ID test lease key is invalid".to_string())?;
    Ok(OfflineLeaseVerifier {
        key_id: TEST_OFFLINE_LEASE_KEY_ID.to_string(),
        public_key: pair
            .public_key()
            .as_ref()
            .try_into()
            .map_err(|_| "Caller ID test lease public key has an invalid length".to_string())?,
    })
}

fn decode_jws_segment(value: &str, maximum: usize, label: &str) -> Result<Vec<u8>, String> {
    if value.is_empty()
        || value.len() > maximum
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("Caller ID offline lease {label} is invalid"));
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("Caller ID offline lease {label} is invalid"))
}

fn verify_signed_snapshot(
    config: &Value,
    wire: &SnapshotWire,
    expected_terminal_id: &str,
) -> Result<(), String> {
    let verifier = configured_offline_lease_verifier()?;
    verify_signed_snapshot_with(config, wire, expected_terminal_id, &verifier)
}

fn verify_signed_snapshot_with(
    config: &Value,
    wire: &SnapshotWire,
    expected_terminal_id: &str,
    verifier: &OfflineLeaseVerifier,
) -> Result<(), String> {
    let protected = decode_jws_segment(
        &wire.signed_lease.protected,
        MAX_PROTECTED_JWS_BYTES,
        "protected header",
    )?;
    let header: SignedLeaseHeaderWire = serde_json::from_slice(&protected)
        .map_err(|_| "Caller ID offline lease protected header is invalid".to_string())?;
    if header.alg != "EdDSA"
        || header.kid != verifier.key_id
        || header.typ != OFFLINE_LEASE_MEDIA_TYPE
    {
        return Err("Caller ID offline lease protected header is unsupported".into());
    }

    let payload = decode_jws_segment(&wire.signed_lease.payload, MAX_PAYLOAD_JWS_BYTES, "payload")?;
    let signature = decode_jws_segment(
        &wire.signed_lease.signature,
        MAX_SIGNATURE_JWS_BYTES,
        "signature",
    )?;
    if signature.len() != 64 {
        return Err("Caller ID offline lease signature has an invalid length".into());
    }
    let signing_input = format!(
        "{}.{}",
        wire.signed_lease.protected, wire.signed_lease.payload
    );
    UnparsedPublicKey::new(&ED25519, &verifier.public_key)
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| "Caller ID offline lease signature is invalid".to_string())?;

    let claims: SignedLeaseClaimsWire = serde_json::from_slice(&payload)
        .map_err(|_| "Caller ID offline lease claims are invalid".to_string())?;
    if claims.version != 1
        || Uuid::parse_str(&claims.lease_id).is_err()
        || Uuid::parse_str(&claims.terminal_db_id).is_err()
        || Uuid::parse_str(&claims.organization_id).is_err()
        || Uuid::parse_str(&claims.branch_id).is_err()
        || claims.terminal_id != expected_terminal_id
        || claims.terminal_id != wire.offline_lease.terminal_id
        || claims.on_expiry != wire.offline_lease.on_expiry
        || claims.ip_trust_source_policy != wire.ip_trust_source_policy
        || claims.activation != wire.activation
        || claims.config.enabled != wire.enabled
        || claims.config.source_lines != wire.source_lines
    {
        return Err("Caller ID offline lease claims do not match the runtime snapshot".into());
    }
    if wire.activation.source_terminal
        && wire.activation.source_terminal_id.as_deref() != Some(claims.terminal_db_id.as_str())
    {
        return Err("Caller ID offline lease terminal identity is inconsistent".into());
    }

    let outer_lease = config
        .get("offlineLease")
        .and_then(Value::as_object)
        .ok_or_else(|| "Caller ID offline lease outer contract is invalid".to_string())?;
    let outer_issued_at = outer_lease.get("issuedAt").and_then(Value::as_str);
    let outer_expires_at = outer_lease.get("expiresAt").and_then(Value::as_str);
    if outer_issued_at != Some(claims.issued_at.as_str())
        || outer_expires_at != Some(claims.expires_at.as_str())
    {
        return Err("Caller ID offline lease timestamps do not match the runtime snapshot".into());
    }
    Ok(())
}

pub fn encode_online_snapshot(
    config: &Value,
    expected_terminal_id: &str,
    now: DateTime<Utc>,
) -> Result<(String, ActivationDecision), String> {
    let decision = resolve_snapshot(config, expected_terminal_id, now, false, true)?;
    let cached = CachedActivation {
        version: CACHE_VERSION,
        terminal_id: expected_terminal_id.to_string(),
        stored_at: now,
        revoked_at: None,
        config: config.clone(),
    };
    serde_json::to_string(&cached)
        .map(|encoded| (encoded, decision))
        .map_err(|_| "Caller ID activation cache could not be encoded".to_string())
}

pub fn resolve_cached_snapshot(
    encoded: &str,
    expected_terminal_id: &str,
    now: DateTime<Utc>,
) -> Result<ActivationDecision, String> {
    let cached: CachedActivation = serde_json::from_str(encoded)
        .map_err(|_| "Caller ID activation cache is invalid".to_string())?;
    if cached.version != CACHE_VERSION || cached.terminal_id != expected_terminal_id {
        return Err("Caller ID activation cache belongs to another terminal".into());
    }
    if cached.stored_at > now + CLOCK_SKEW
        || cached
            .revoked_at
            .is_some_and(|revoked_at| revoked_at > now + CLOCK_SKEW)
    {
        return Err("Caller ID activation cache has an invalid local timestamp".into());
    }
    resolve_snapshot(
        &cached.config,
        expected_terminal_id,
        now,
        cached.revoked_at.is_some(),
        false,
    )
}

fn bank_keys(bank: CacheBank) -> &'static [&'static str; 8] {
    match bank {
        CacheBank::A => &crate::storage::CALLERID_ACTIVATION_CACHE_BANK_A_KEYS,
        CacheBank::B => &crate::storage::CALLERID_ACTIVATION_CACHE_BANK_B_KEYS,
    }
}

fn split_cache_chunks(encoded: &str) -> Result<Vec<String>, String> {
    let mut chunks = Vec::<String>::new();
    let mut current = String::new();
    let mut current_units = 0_usize;
    for character in encoded.chars() {
        let units = character.len_utf16();
        if current_units + units > CACHE_CHUNK_UTF16_UNITS && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            current_units = 0;
        }
        current.push(character);
        current_units += units;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() || chunks.len() > bank_keys(CacheBank::A).len() {
        return Err("Caller ID activation cache is too large for secure storage".into());
    }
    Ok(chunks)
}

fn read_encoded_cache() -> Result<Option<String>, String> {
    let Some(raw_manifest) =
        crate::storage::get_credential(crate::storage::KEY_CALLERID_ACTIVATION_CACHE_MANIFEST)
    else {
        return Ok(None);
    };
    let manifest: CacheManifest = serde_json::from_str(&raw_manifest)
        .map_err(|_| "Caller ID activation cache manifest is invalid".to_string())?;
    let keys = bank_keys(manifest.bank);
    if manifest.version != CACHE_VERSION || manifest.chunks == 0 || manifest.chunks > keys.len() {
        return Err("Caller ID activation cache manifest is invalid".into());
    }
    let mut encoded = String::new();
    for key in keys.iter().take(manifest.chunks) {
        let chunk = crate::storage::get_credential(key)
            .ok_or_else(|| "Caller ID activation cache is incomplete".to_string())?;
        encoded.push_str(&chunk);
    }
    Ok(Some(encoded))
}

fn write_encoded_cache(encoded: &str) -> Result<(), String> {
    let chunks = split_cache_chunks(encoded)?;
    let current_bank =
        crate::storage::get_credential(crate::storage::KEY_CALLERID_ACTIVATION_CACHE_MANIFEST)
            .and_then(|manifest| serde_json::from_str::<CacheManifest>(&manifest).ok())
            .filter(|manifest| manifest.version == CACHE_VERSION)
            .map(|manifest| manifest.bank);
    let target_bank = match current_bank {
        Some(CacheBank::A) => CacheBank::B,
        Some(CacheBank::B) | None => CacheBank::A,
    };
    let keys = bank_keys(target_bank);

    // Write the inactive bank first.  The old manifest remains authoritative
    // until every new chunk is durable, so a crash can only discard the new
    // snapshot; it cannot corrupt the last known-good one.
    for (index, chunk) in chunks.iter().enumerate() {
        crate::storage::set_credential(keys[index], chunk)?;
    }
    for key in keys.iter().skip(chunks.len()) {
        crate::storage::delete_credential(key)?;
    }
    let manifest = serde_json::to_string(&CacheManifest {
        version: CACHE_VERSION,
        bank: target_bank,
        chunks: chunks.len(),
    })
    .map_err(|_| "Caller ID activation cache manifest could not be encoded".to_string())?;
    crate::storage::set_credential(
        crate::storage::KEY_CALLERID_ACTIVATION_CACHE_MANIFEST,
        &manifest,
    )
}

pub fn store_online_snapshot(
    config: &Value,
    expected_terminal_id: &str,
    now: DateTime<Utc>,
) -> Result<ActivationDecision, String> {
    let has_activation = config.get("activation").is_some();
    let has_offline_lease = config.get("offlineLease").is_some();
    if !has_activation && !has_offline_lease {
        return resolve_legacy_online_snapshot(config, expected_terminal_id, now);
    }
    let (encoded, decision) = encode_online_snapshot(config, expected_terminal_id, now)?;
    write_encoded_cache(&encoded)?;
    Ok(decision)
}

fn resolve_legacy_online_snapshot(
    config: &Value,
    expected_terminal_id: &str,
    now: DateTime<Utc>,
) -> Result<ActivationDecision, String> {
    let expected_terminal_id = expected_terminal_id.trim();
    if expected_terminal_id.is_empty() || expected_terminal_id.chars().count() > 200 {
        return Err("Caller ID activation requires a valid local terminal ID".into());
    }
    let wire: LegacyOnlineSnapshotWire = serde_json::from_value(config.clone())
        .map_err(|_| "Caller ID legacy online policy has an invalid shape".to_string())?;
    if !wire.enabled {
        return Err("Caller ID activation policy is unsupported".into());
    }
    Ok(ActivationDecision {
        mode: if wire.source_lines.is_empty() {
            RuntimeActivation::InactiveTerminal
        } else {
            RuntimeActivation::CallerIdSource
        },
        config: config.clone(),
        // A legacy response has no server-issued offline lifetime.  The value
        // is deliberately non-cacheable and is valid only for this online
        // reconciliation cycle.
        expires_at: now,
    })
}

pub fn load_cached_snapshot(
    expected_terminal_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<ActivationDecision>, String> {
    read_encoded_cache()?
        .map(|encoded| resolve_cached_snapshot(&encoded, expected_terminal_id, now))
        .transpose()
}

/// Persist an online revocation without deleting the last bridge config.
/// Returns `false` only when this installation has never received a valid
/// source snapshot.
pub fn persist_online_revocation(
    expected_terminal_id: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let Some(encoded) = read_encoded_cache()? else {
        return Ok(false);
    };
    let revoked = mark_cached_snapshot_revoked(&encoded, expected_terminal_id, now)?;
    write_encoded_cache(&revoked)?;
    Ok(true)
}

pub fn mark_cached_snapshot_revoked(
    encoded: &str,
    expected_terminal_id: &str,
    now: DateTime<Utc>,
) -> Result<String, String> {
    let mut cached: CachedActivation = serde_json::from_str(encoded)
        .map_err(|_| "Caller ID activation cache is invalid".to_string())?;
    if cached.version != CACHE_VERSION || cached.terminal_id != expected_terminal_id {
        return Err("Caller ID activation cache belongs to another terminal".into());
    }
    // Never persist a revocation marker around an unverified/tampered lease.
    // The bridge-only transition keeps the signed snapshot intact, so future
    // offline restores can (and do) verify the same JWS again.
    let _ = resolve_snapshot(&cached.config, expected_terminal_id, now, false, false)?;
    cached.revoked_at = Some(now);
    serde_json::to_string(&cached)
        .map_err(|_| "Caller ID activation cache could not be encoded".to_string())
}

fn resolve_snapshot(
    config: &Value,
    expected_terminal_id: &str,
    now: DateTime<Utc>,
    revoked: bool,
    require_unexpired: bool,
) -> Result<ActivationDecision, String> {
    let expected_terminal_id = expected_terminal_id.trim();
    if expected_terminal_id.is_empty() || expected_terminal_id.chars().count() > 200 {
        return Err("Caller ID activation requires a valid local terminal ID".into());
    }
    let wire: SnapshotWire = serde_json::from_value(config.clone())
        .map_err(|_| "Caller ID activation policy has an invalid shape".to_string())?;
    verify_signed_snapshot(config, &wire, expected_terminal_id)?;
    if !wire.enabled
        || wire.activation.caller_id_mode != "enabled"
        || wire.activation.voice_continuity != "always_on"
        || wire.offline_lease.on_expiry != "bridge_only"
    {
        return Err("Caller ID activation policy is unsupported".into());
    }
    if wire.offline_lease.terminal_id != expected_terminal_id {
        return Err("Caller ID activation lease belongs to another terminal".into());
    }
    if wire.offline_lease.issued_at > now + CLOCK_SKEW
        || wire.offline_lease.expires_at <= wire.offline_lease.issued_at
        || wire.offline_lease.expires_at - wire.offline_lease.issued_at > MAX_OFFLINE_LEASE
    {
        return Err("Caller ID activation lease has an invalid lifetime".into());
    }
    if require_unexpired && wire.offline_lease.expires_at <= now {
        return Err("Caller ID activation lease is already expired".into());
    }

    let source_claim_is_consistent = if wire.activation.source_terminal {
        wire.activation
            .source_terminal_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok())
            .is_some()
            && !wire.source_lines.is_empty()
    } else {
        wire.activation.source_terminal_id.is_none() && wire.source_lines.is_empty()
    };
    if !source_claim_is_consistent {
        return Err("Caller ID activation source-terminal claim is inconsistent".into());
    }

    let mode = if !wire.activation.source_terminal {
        RuntimeActivation::InactiveTerminal
    } else if revoked || wire.offline_lease.expires_at <= now {
        RuntimeActivation::BridgeOnly
    } else {
        RuntimeActivation::CallerIdSource
    };
    Ok(ActivationDecision {
        mode,
        config: config.clone(),
        expires_at: wire.offline_lease.expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::json;

    const TERMINAL_ID: &str = "POS-ATHENS-01";
    const TERMINAL_DB_ID: &str = "018f7684-1436-7d3d-a3f8-58b1bf600da0";
    const ORGANIZATION_ID: &str = "018f7684-1436-7d3d-a3f8-58b1bf600da1";
    const BRANCH_ID: &str = "018f7684-1436-7d3d-a3f8-58b1bf600da2";
    const LEASE_ID: &str = "018f7684-1436-7d3d-a3f8-58b1bf600da3";

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 3, 12, 0, 0).single().unwrap()
    }

    fn config(source_terminal: bool) -> Value {
        let issued_at = now();
        let mut snapshot = json!({
            "enabled": true,
            "activation": {
                "sourceTerminal": source_terminal,
                "sourceTerminalId": source_terminal.then_some(TERMINAL_DB_ID),
                "callerIdMode": "enabled",
                "voiceContinuity": "always_on"
            },
            "ipTrustSourcePolicy": "founder_pilot",
            "offlineLease": {
                "terminalId": TERMINAL_ID,
                "issuedAt": issued_at.to_rfc3339(),
                "expiresAt": (issued_at + Duration::hours(72)).to_rfc3339(),
                "onExpiry": "bridge_only"
            },
            "sourceLines": if source_terminal {
                vec![json!({ "id": "line-1" })]
            } else {
                Vec::<Value>::new()
            },
            "receivingLines": []
        });
        snapshot["signedLease"] = sign_snapshot(&snapshot);
        snapshot
    }

    fn sign_snapshot(snapshot: &Value) -> Value {
        let protected = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "alg": "EdDSA",
                "kid": TEST_OFFLINE_LEASE_KEY_ID,
                "typ": OFFLINE_LEASE_MEDIA_TYPE
            }))
            .unwrap(),
        );
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "version": 1,
                "leaseId": LEASE_ID,
                "terminalId": snapshot["offlineLease"]["terminalId"].clone(),
                "terminalDbId": TERMINAL_DB_ID,
                "organizationId": ORGANIZATION_ID,
                "branchId": BRANCH_ID,
                "issuedAt": snapshot["offlineLease"]["issuedAt"].clone(),
                "expiresAt": snapshot["offlineLease"]["expiresAt"].clone(),
                "onExpiry": snapshot["offlineLease"]["onExpiry"].clone(),
                "ipTrustSourcePolicy": snapshot["ipTrustSourcePolicy"].clone(),
                "activation": snapshot["activation"].clone(),
                "config": {
                    "enabled": snapshot["enabled"].clone(),
                    "sourceLines": snapshot["sourceLines"].clone()
                }
            }))
            .unwrap(),
        );
        let pair = Ed25519KeyPair::from_seed_unchecked(&TEST_OFFLINE_LEASE_SEED).unwrap();
        let signature = pair.sign(format!("{protected}.{payload}").as_bytes());
        assert_eq!(pair.public_key().as_ref().len(), 32);
        json!({
            "protected": protected,
            "payload": payload,
            "signature": URL_SAFE_NO_PAD.encode(signature.as_ref())
        })
    }

    #[test]
    fn online_source_snapshot_enables_the_bundled_listener_and_round_trips_cache() {
        let (encoded, online) = encode_online_snapshot(&config(true), TERMINAL_ID, now()).unwrap();
        assert_eq!(online.mode, RuntimeActivation::CallerIdSource);

        let cached =
            resolve_cached_snapshot(&encoded, TERMINAL_ID, now() + Duration::hours(48)).unwrap();
        assert_eq!(cached.mode, RuntimeActivation::CallerIdSource);
    }

    #[test]
    fn signed_lease_requires_the_pinned_key_and_exact_eddsa_header() {
        let snapshot = config(true);
        let wire: SnapshotWire = serde_json::from_value(snapshot.clone()).unwrap();

        let other_pair = Ed25519KeyPair::from_seed_unchecked(&[0x24; 32]).unwrap();
        let wrong_verifier = OfflineLeaseVerifier {
            key_id: TEST_OFFLINE_LEASE_KEY_ID.to_string(),
            public_key: other_pair.public_key().as_ref().try_into().unwrap(),
        };
        assert!(
            verify_signed_snapshot_with(&snapshot, &wire, TERMINAL_ID, &wrong_verifier)
                .unwrap_err()
                .contains("signature is invalid")
        );

        for header in [
            json!({
                "alg": "HS256",
                "kid": TEST_OFFLINE_LEASE_KEY_ID,
                "typ": OFFLINE_LEASE_MEDIA_TYPE
            }),
            json!({
                "alg": "EdDSA",
                "kid": "other-key",
                "typ": OFFLINE_LEASE_MEDIA_TYPE
            }),
            json!({
                "alg": "EdDSA",
                "kid": TEST_OFFLINE_LEASE_KEY_ID,
                "typ": "JWT"
            }),
            json!({
                "alg": "EdDSA",
                "kid": TEST_OFFLINE_LEASE_KEY_ID,
                "typ": OFFLINE_LEASE_MEDIA_TYPE,
                "unexpected": true
            }),
        ] {
            let mut invalid = snapshot.clone();
            invalid["signedLease"]["protected"] =
                json!(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()));
            assert!(encode_online_snapshot(&invalid, TERMINAL_ID, now()).is_err());
        }
    }

    #[test]
    fn signed_lease_must_match_outer_activation_lease_and_source_projection() {
        let original = config(true);

        let mut source_tamper = original.clone();
        source_tamper["sourceLines"][0]["id"] = json!("tampered-line");
        assert!(encode_online_snapshot(&source_tamper, TERMINAL_ID, now())
            .unwrap_err()
            .contains("claims do not match"));

        let mut activation_tamper = original.clone();
        activation_tamper["activation"]["sourceTerminalId"] =
            json!("018f7684-1436-7d3d-a3f8-58b1bf600db0");
        assert!(encode_online_snapshot(&activation_tamper, TERMINAL_ID, now()).is_err());

        let mut lease_tamper = original;
        lease_tamper["offlineLease"]["expiresAt"] =
            json!((now() + Duration::hours(48)).to_rfc3339());
        assert!(encode_online_snapshot(&lease_tamper, TERMINAL_ID, now())
            .unwrap_err()
            .contains("timestamps do not match"));

        let mut policy_tamper = config(true);
        policy_tamper["ipTrustSourcePolicy"] = json!("blocked");
        assert!(encode_online_snapshot(&policy_tamper, TERMINAL_ID, now())
            .unwrap_err()
            .contains("claims do not match"));
    }

    #[test]
    fn offline_restore_reverifies_the_cached_signature() {
        let (encoded, _) = encode_online_snapshot(&config(true), TERMINAL_ID, now()).unwrap();
        let mut cached: Value = serde_json::from_str(&encoded).unwrap();
        cached["config"]["signedLease"]["signature"] = json!("AAAAAAAA");
        let tampered = serde_json::to_string(&cached).unwrap();

        assert!(resolve_cached_snapshot(&tampered, TERMINAL_ID, now())
            .unwrap_err()
            .contains("signature"));
    }

    #[test]
    fn verifier_configuration_fails_closed_when_build_time_pins_are_missing_or_invalid() {
        assert!(verifier_from_config(None, Some(TEST_OFFLINE_LEASE_KEY_ID)).is_err());
        assert!(verifier_from_config(Some("AAAA"), None).is_err());
        assert!(verifier_from_config(Some("AAAA"), Some("bad key id")).is_err());
        assert!(
            verifier_from_config(Some("AAAA"), Some(TEST_OFFLINE_LEASE_KEY_ID))
                .unwrap_err()
                .contains("32 raw bytes")
        );

        let verifier = configured_offline_lease_verifier().unwrap();
        let encoded = URL_SAFE_NO_PAD.encode(verifier.public_key);
        let reparsed = verifier_from_config(Some(&encoded), Some(&verifier.key_id)).unwrap();
        assert_eq!(reparsed.public_key, verifier.public_key);
        assert_eq!(reparsed.key_id, verifier.key_id);
    }

    #[test]
    fn non_source_terminal_never_starts_a_source_listener() {
        let (_, decision) = encode_online_snapshot(&config(false), TERMINAL_ID, now()).unwrap();
        assert_eq!(decision.mode, RuntimeActivation::InactiveTerminal);
    }

    #[test]
    fn offline_expiry_keeps_only_the_voice_bridge() {
        let (encoded, _) = encode_online_snapshot(&config(true), TERMINAL_ID, now()).unwrap();
        let expired =
            resolve_cached_snapshot(&encoded, TERMINAL_ID, now() + Duration::hours(73)).unwrap();

        assert_eq!(expired.mode, RuntimeActivation::BridgeOnly);
        assert!(!expired.config.is_null(), "bridge config must be retained");
    }

    #[test]
    fn online_revocation_survives_an_offline_restart_without_deleting_bridge_config() {
        let (encoded, _) = encode_online_snapshot(&config(true), TERMINAL_ID, now()).unwrap();
        let revoked =
            mark_cached_snapshot_revoked(&encoded, TERMINAL_ID, now() + Duration::minutes(5))
                .unwrap();
        let restarted =
            resolve_cached_snapshot(&revoked, TERMINAL_ID, now() + Duration::minutes(10)).unwrap();

        assert_eq!(restarted.mode, RuntimeActivation::BridgeOnly);
        assert!(
            !restarted.config.is_null(),
            "bridge config must be retained"
        );
    }

    #[test]
    fn cache_is_terminal_bound() {
        let (encoded, _) = encode_online_snapshot(&config(true), TERMINAL_ID, now()).unwrap();
        assert!(resolve_cached_snapshot(&encoded, "POS-OTHER", now()).is_err());
    }

    #[test]
    fn rejects_lease_longer_than_the_server_contract() {
        let mut snapshot = config(true);
        snapshot["offlineLease"]["expiresAt"] = json!((now() + Duration::hours(80)).to_rfc3339());
        assert!(encode_online_snapshot(&snapshot, TERMINAL_ID, now()).is_err());
    }

    #[test]
    fn rejects_cross_terminal_or_inconsistent_source_claims() {
        let mut wrong_terminal = config(true);
        wrong_terminal["offlineLease"]["terminalId"] = json!("POS-OTHER");
        assert!(encode_online_snapshot(&wrong_terminal, TERMINAL_ID, now()).is_err());

        let mut no_source_lines = config(true);
        no_source_lines["sourceLines"] = json!([]);
        assert!(encode_online_snapshot(&no_source_lines, TERMINAL_ID, now()).is_err());
    }

    #[test]
    fn legacy_production_config_enables_only_the_live_online_source() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let legacy = json!({
            "enabled": true,
            "minimumClientVersion": "1.4.0",
            "sourceLines": [{ "id": "line-1" }],
            "receivingLines": []
        });

        let decision = store_online_snapshot(&legacy, TERMINAL_ID, now()).unwrap();

        assert_eq!(decision.mode, RuntimeActivation::CallerIdSource);
        assert_eq!(decision.expires_at, now());
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_CALLERID_ACTIVATION_CACHE_MANIFEST),
            None,
            "an unsigned legacy online response must never become an offline lease"
        );
    }

    #[test]
    fn legacy_production_config_keeps_a_non_source_terminal_inactive() {
        let legacy = json!({
            "enabled": true,
            "sourceLines": [],
            "receivingLines": [{ "id": "line-1" }]
        });

        let decision = store_online_snapshot(&legacy, TERMINAL_ID, now()).unwrap();
        assert_eq!(decision.mode, RuntimeActivation::InactiveTerminal);
    }

    #[test]
    fn partially_modern_activation_response_is_not_downgraded_to_legacy() {
        let mut partial = json!({
            "enabled": true,
            "sourceLines": [{ "id": "line-1" }]
        });
        partial["activation"] = config(true)["activation"].clone();

        assert!(store_online_snapshot(&partial, TERMINAL_ID, now()).is_err());
    }

    #[test]
    fn secure_cache_uses_an_atomic_second_bank_and_survives_offline_restart() {
        let _keyring = crate::tests::fake_keyring::install_empty();

        let first = store_online_snapshot(&config(true), TERMINAL_ID, now()).unwrap();
        assert_eq!(first.mode, RuntimeActivation::CallerIdSource);
        let first_manifest =
            crate::storage::get_credential(crate::storage::KEY_CALLERID_ACTIVATION_CACHE_MANIFEST)
                .unwrap();
        assert!(first_manifest.contains("\"bank\":\"a\""));

        let second =
            store_online_snapshot(&config(false), TERMINAL_ID, now() + Duration::minutes(1))
                .unwrap();
        assert_eq!(second.mode, RuntimeActivation::InactiveTerminal);
        let second_manifest =
            crate::storage::get_credential(crate::storage::KEY_CALLERID_ACTIVATION_CACHE_MANIFEST)
                .unwrap();
        assert!(second_manifest.contains("\"bank\":\"b\""));

        let restarted = load_cached_snapshot(TERMINAL_ID, now() + Duration::hours(1))
            .unwrap()
            .unwrap();
        assert_eq!(restarted.mode, RuntimeActivation::InactiveTerminal);
    }

    #[test]
    fn secure_cache_chunks_unicode_without_splitting_utf8() {
        let encoded = "κ".repeat(CACHE_CHUNK_UTF16_UNITS + 20);
        let chunks = split_cache_chunks(&encoded).unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks.concat(), encoded);
    }
}
