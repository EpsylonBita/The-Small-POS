//! Native repair cache, encryption, scope and reconciliation boundary.
//!
//! This module is intentionally renderer-opaque: tenant scope, encryption
//! material, queued envelopes and staged paths never cross generic IPC.

use base64::Engine;
use ring::{aead, rand as ring_rand};
use ring_rand::SecureRandom;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ATTACHMENT_BYTES: usize = 15 * 1024 * 1024;
const SCOPE_VERSION: u8 = 1;
const ENTITLEMENT_VERSION: u8 = 1;
const TERMINAL_IDENTITY_ROLLBACK_VERSION: u8 = 1;
const TERMINAL_IDENTITY_ROLLBACK_MAX_SCOPE_BYTES: usize = 64 * 1024;
const TERMINAL_IDENTITY_ROLLBACK_AAD_DOMAIN: &str = "repair-terminal-identity-rollback-v1";

const IDENTITY_KEYS: &[&str] = &["organization_id", "branch_id", "terminal_id"];

#[derive(Default)]
struct LifecycleState {
    blocked: bool,
    reset_latched: bool,
    maintenance_failed: bool,
    active_readers: usize,
    epoch: u64,
    access_decision_generation: u64,
    terminal_identity_rollback_publication_pending: bool,
    terminal_identity_rollback_publication_abandoned: bool,
}

fn transition_mutex() -> &'static Mutex<()> {
    static TRANSITION: OnceLock<Mutex<()>> = OnceLock::new();
    TRANSITION.get_or_init(|| Mutex::new(()))
}

fn renderer_producer_mutex() -> &'static tokio::sync::Mutex<()> {
    static PRODUCER: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    PRODUCER.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Serialize renderer-owned repair producers across the full direct-command
/// await boundary. V1 intentionally uses one process-wide lock: correctness
/// takes precedence over parallelism and it also orders attachment staging
/// against commands for every aggregate.
pub(crate) async fn acquire_renderer_producer_guard() -> tokio::sync::MutexGuard<'static, ()> {
    renderer_producer_mutex().lock().await
}

pub(crate) struct RepairTransitionGuard {
    _guard: MutexGuard<'static, ()>,
    unconfigured: bool,
}

pub(crate) struct OperationalClearPublication {
    replacement: Option<RepairScopeState>,
    unconfigured: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RepairAccessDecision {
    generation: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepairScopeState {
    version: u8,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    scope_token: String,
    scope_epoch: u64,
    transition_pending: bool,
    reset_pending: bool,
    offline_terminal_token: Option<String>,
    offline_sequence_lease_start: Option<u64>,
    offline_sequence_lease_end: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings_cache: Option<StoredCiphertext>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalIdentityRollbackBinding {
    pub(crate) journal_version: u8,
    pub(crate) operation: String,
    pub(crate) operation_id: String,
    pub(crate) old_terminal_id: String,
    pub(crate) old_admin_dashboard_url: String,
    pub(crate) old_organization_id: String,
    pub(crate) old_branch_id: String,
    pub(crate) old_api_key_digest: String,
    pub(crate) target_terminal_id: String,
    pub(crate) target_admin_dashboard_url: String,
    pub(crate) target_organization_id: String,
    pub(crate) target_branch_id: String,
    pub(crate) target_api_key_digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TerminalIdentityRollbackEnvelope {
    pub(crate) version: u8,
    pub(crate) nonce_b64: String,
    pub(crate) ciphertext_b64: String,
}

#[must_use = "rollback publication must be finished to reopen repair access"]
pub(crate) struct TerminalIdentityRollbackPublication {
    _guard: MutexGuard<'static, ()>,
    old_epoch: Option<u64>,
    finished: bool,
}

pub(crate) enum TerminalIdentityIntentDurability {
    Committed,
    DefiniteFailure(String),
    AmbiguousFailure(String),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepairEntitlementState {
    version: u8,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    scope_epoch: u64,
    enabled: bool,
    verified_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCiphertext {
    version: u8,
    scope_epoch: u64,
    nonce_b64: String,
    ciphertext_b64: String,
}

struct EncryptedBlob {
    nonce: [u8; 12],
    ciphertext: Zeroizing<Vec<u8>>,
}

#[derive(Clone, Copy)]
enum CryptoDomain {
    Queue,
    Cache,
    Conflict,
    AttachmentMetadata,
    AttachmentBytes,
}

impl CryptoDomain {
    fn label(self) -> &'static str {
        match self {
            Self::Queue => "repair-queue-v1",
            Self::Cache => "repair-cache-v1",
            Self::Conflict => "repair-conflict-v1",
            Self::AttachmentMetadata => "repair-attachment-metadata-v1",
            Self::AttachmentBytes => "repair-attachment-bytes-v1",
        }
    }
}

fn canonical_uuid(value: &str) -> Option<String> {
    let parsed = Uuid::parse_str(value).ok()?;
    let canonical = parsed.hyphenated().to_string();
    (canonical == value).then_some(canonical)
}

fn validate_terminal_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn validate_scope(scope: &RepairScopeState) -> Result<(), String> {
    if scope.version != SCOPE_VERSION
        || canonical_uuid(&scope.organization_id).is_none()
        || canonical_uuid(&scope.branch_id).is_none()
        || !validate_terminal_id(&scope.terminal_id)
        || canonical_uuid(&scope.scope_token).is_none()
        || scope.scope_epoch == 0
        || scope.scope_epoch > MAX_SAFE_INTEGER
    {
        return Err("REPAIR_SCOPE_CORRUPT".to_string());
    }
    match (
        scope.offline_terminal_token.as_deref(),
        scope.offline_sequence_lease_start,
        scope.offline_sequence_lease_end,
    ) {
        (None, None, None) => {}
        (Some(token), Some(start), Some(end))
            if token.len() == 4
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
                && start > 0
                && start <= end
                && end <= 999_999
                && end - start < 100 => {}
        _ => return Err("REPAIR_OFFLINE_LEASE_CORRUPT".to_string()),
    }
    if scope
        .settings_cache
        .as_ref()
        .is_some_and(|settings| settings.version != 1 || settings.scope_epoch != scope.scope_epoch)
    {
        return Err("REPAIR_SETTINGS_CACHE_CORRUPT".to_string());
    }
    Ok(())
}

fn load_scope_raw() -> Result<Option<RepairScopeState>, String> {
    let Some(raw) = crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)?
    else {
        return Ok(None);
    };
    let scope: RepairScopeState =
        serde_json::from_str(&raw).map_err(|_| "REPAIR_SCOPE_CORRUPT".to_string())?;
    validate_scope(&scope)?;
    Ok(Some(scope))
}

fn persist_scope(scope: &RepairScopeState) -> Result<(), String> {
    validate_scope(scope)?;
    let serialized = Zeroizing::new(
        serde_json::to_string(scope).map_err(|_| "REPAIR_SCOPE_CORRUPT".to_string())?,
    );
    crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, &serialized)
        .map_err(|_| "REPAIR_SCOPE_WRITE_FAILED".to_string())
}

fn validate_terminal_identity_rollback_binding(
    binding: &TerminalIdentityRollbackBinding,
) -> Result<(), String> {
    let canonical_operation = canonical_uuid(&binding.operation_id)
        .filter(|value| value == &binding.operation_id)
        .is_some();
    let digest_valid = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    let target_valid = if binding.operation == "rebind" {
        validate_terminal_id(&binding.target_terminal_id)
            && url::Url::parse(&binding.target_admin_dashboard_url).is_ok()
            && canonical_uuid(&binding.target_organization_id).as_deref()
                == Some(binding.target_organization_id.as_str())
            && canonical_uuid(&binding.target_branch_id).as_deref()
                == Some(binding.target_branch_id.as_str())
    } else if binding.operation == "clear" {
        binding.target_terminal_id.is_empty()
            && binding.target_admin_dashboard_url.is_empty()
            && binding.target_organization_id.is_empty()
            && binding.target_branch_id.is_empty()
            && binding.target_api_key_digest == format!("{:x}", Sha256::digest(b""))
    } else {
        false
    };
    if binding.journal_version != 3
        || !canonical_operation
        || !validate_terminal_id(&binding.old_terminal_id)
        || url::Url::parse(&binding.old_admin_dashboard_url).is_err()
        || canonical_uuid(&binding.old_organization_id).as_deref()
            != Some(binding.old_organization_id.as_str())
        || canonical_uuid(&binding.old_branch_id).as_deref() != Some(binding.old_branch_id.as_str())
        || !digest_valid(&binding.old_api_key_digest)
        || !digest_valid(&binding.target_api_key_digest)
        || !target_valid
    {
        return Err("REPAIR_TERMINAL_ROLLBACK_BINDING_INVALID".to_string());
    }
    Ok(())
}

fn terminal_identity_rollback_aad(
    binding: &TerminalIdentityRollbackBinding,
) -> Result<Zeroizing<Vec<u8>>, String> {
    validate_terminal_identity_rollback_binding(binding)?;
    let encoded = Zeroizing::new(
        serde_json::to_vec(binding)
            .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_BINDING_INVALID".to_string())?,
    );
    let mut aad = Zeroizing::new(Vec::with_capacity(
        TERMINAL_IDENTITY_ROLLBACK_AAD_DOMAIN.len() + encoded.len() + 8,
    ));
    aad.extend_from_slice(TERMINAL_IDENTITY_ROLLBACK_AAD_DOMAIN.as_bytes());
    aad.extend_from_slice(&(encoded.len() as u64).to_be_bytes());
    aad.extend_from_slice(&encoded);
    Ok(aad)
}

fn load_existing_repair_key() -> Result<Zeroizing<Vec<u8>>, String> {
    let raw = crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)?
        .ok_or_else(|| "REPAIR_TERMINAL_ROLLBACK_KEY_REQUIRED".to_string())?;
    decode_key(&raw).map_err(|_| "REPAIR_TERMINAL_ROLLBACK_KEY_INVALID".to_string())
}

fn decrypt_terminal_identity_rollback(
    binding: &TerminalIdentityRollbackBinding,
    envelope: &TerminalIdentityRollbackEnvelope,
) -> Result<(Zeroizing<String>, RepairScopeState), String> {
    validate_terminal_identity_rollback_binding(binding)?;
    if envelope.version != TERMINAL_IDENTITY_ROLLBACK_VERSION {
        return Err("REPAIR_TERMINAL_ROLLBACK_INVALID".to_string());
    }
    let nonce = decode_canonical_rollback_b64(&envelope.nonce_b64, 12)?;
    let nonce: [u8; 12] = nonce
        .try_into()
        .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
    let ciphertext = decode_canonical_rollback_b64(
        &envelope.ciphertext_b64,
        TERMINAL_IDENTITY_ROLLBACK_MAX_SCOPE_BYTES + aead::AES_256_GCM.tag_len(),
    )?;
    // Recovery must never rotate a missing key: doing so would turn an
    // unavailable authenticated snapshot into an unauthenticated guess.
    let key_bytes = load_existing_repair_key()?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes.as_slice())
            .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_KEY_INVALID".to_string())?,
    );
    let aad = terminal_identity_rollback_aad(binding)?;
    let mut plaintext = Zeroizing::new(ciphertext);
    let length = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad.as_slice()),
            &mut plaintext,
        )
        .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?
        .len();
    plaintext.truncate(length);
    let raw = Zeroizing::new(
        String::from_utf8(std::mem::take(&mut *plaintext))
            .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?,
    );
    let scope: RepairScopeState =
        serde_json::from_str(&raw).map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
    validate_scope(&scope).map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
    if scope.transition_pending
        || scope.reset_pending
        || !scope_matches_identity(
            &scope,
            &binding.old_organization_id,
            &binding.old_branch_id,
            &binding.old_terminal_id,
        )
    {
        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_MISMATCH".to_string());
    }
    Ok((raw, scope))
}

fn decode_canonical_rollback_b64(value: &str, max_decoded: usize) -> Result<Vec<u8>, String> {
    let max_encoded = max_decoded.div_ceil(3).saturating_mul(4);
    if value.is_empty() || value.len() > max_encoded || value.len() % 4 != 0 {
        return Err("REPAIR_TERMINAL_ROLLBACK_INVALID".to_string());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
    if decoded.len() > max_decoded
        || base64::engine::general_purpose::STANDARD.encode(&decoded) != value
    {
        return Err("REPAIR_TERMINAL_ROLLBACK_INVALID".to_string());
    }
    Ok(decoded)
}

fn reject_conflicting_repair_transition() -> Result<(), String> {
    if crate::storage::read_repair_transition_journal()?.is_some() {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    let state = lifecycle()
        .0
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || state.maintenance_failed {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    Ok(())
}

fn set_terminal_identity_blocked(blocked: bool) -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    state.blocked = blocked;
    if !blocked {
        condition.notify_all();
    }
    Ok(())
}

fn latch_terminal_identity_preparation_cleanup_failure() {
    if let Ok(mut state) = lifecycle().0.lock() {
        state.blocked = true;
        state.maintenance_failed = true;
        state.terminal_identity_rollback_publication_abandoned = true;
    }
}

fn abort_terminal_identity_preparation(aes_key_created: bool) -> Result<(), String> {
    if aes_key_created {
        let cleanup =
            crate::storage::delete_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)
                .and_then(|()| {
                    crate::storage::get_credential_strict(
                        crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
                    )
                    .map(|value| value.is_none())
                });
        if cleanup != Ok(true) {
            latch_terminal_identity_preparation_cleanup_failure();
            return Err("REPAIR_TERMINAL_ROLLBACK_KEY_CLEANUP_FAILED".to_string());
        }
    }
    set_terminal_identity_blocked(false)
}

/// Owns the repair transition boundary from snapshot capture through durable
/// terminal intent publication and pending-scope arming. The callback must
/// perform only the atomic terminal-journal write and strict readback; it must
/// not acquire keyring, repair lifecycle, HTTP, or event locks.
pub(crate) fn prepare_and_arm_terminal_identity_transition<F>(
    binding: &TerminalIdentityRollbackBinding,
    persist_intent: F,
) -> Result<Option<TerminalIdentityRollbackEnvelope>, String>
where
    F: FnOnce(Option<&TerminalIdentityRollbackEnvelope>) -> TerminalIdentityIntentDurability,
{
    validate_terminal_identity_rollback_binding(binding)?;
    let _guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    reject_conflicting_repair_transition()?;

    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched
        || state.maintenance_failed
        || state.blocked
        || state.terminal_identity_rollback_publication_pending
        || state.terminal_identity_rollback_publication_abandoned
    {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    state.blocked = true;
    while state.active_readers > 0 {
        state = condition
            .wait(state)
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    }
    drop(state);

    let aes_key_created = false;
    let preparation = (|| -> Result<_, String> {
        let scope_snapshot =
            match crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)? {
                Some(raw) => {
                    if raw.len() > TERMINAL_IDENTITY_ROLLBACK_MAX_SCOPE_BYTES {
                        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_TOO_LARGE".to_string());
                    }
                    let raw = Zeroizing::new(raw.to_string());
                    let scope: RepairScopeState = serde_json::from_str(&raw)
                        .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
                    validate_scope(&scope)
                        .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
                    if scope.transition_pending
                        || scope.reset_pending
                        || !scope_matches_identity(
                            &scope,
                            &binding.old_organization_id,
                            &binding.old_branch_id,
                            &binding.old_terminal_id,
                        )
                    {
                        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_MISMATCH".to_string());
                    }
                    Some((raw, scope))
                }
                None => None,
            };

        let envelope = if let Some((raw, _)) = scope_snapshot.as_ref() {
            let key_bytes = load_existing_repair_key()?;
            let key = aead::LessSafeKey::new(
                aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes.as_slice())
                    .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_KEY_INVALID".to_string())?,
            );
            let random = ring_rand::SystemRandom::new();
            let mut nonce = [0_u8; 12];
            random
                .fill(&mut nonce)
                .map_err(|_| "REPAIR_NONCE_GENERATION_FAILED".to_string())?;
            let aad = terminal_identity_rollback_aad(binding)?;
            let mut ciphertext = Zeroizing::new(raw.as_bytes().to_vec());
            key.seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad.as_slice()),
                &mut *ciphertext,
            )
            .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_ENCRYPTION_FAILED".to_string())?;
            Some(TerminalIdentityRollbackEnvelope {
                version: TERMINAL_IDENTITY_ROLLBACK_VERSION,
                nonce_b64: base64::engine::general_purpose::STANDARD.encode(nonce),
                ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(&*ciphertext),
            })
        } else {
            None
        };
        Ok((scope_snapshot, envelope))
    })();
    let (scope_snapshot, envelope) = match preparation {
        Ok(prepared) => prepared,
        Err(error) => {
            abort_terminal_identity_preparation(aes_key_created)?;
            return Err(error);
        }
    };

    match persist_intent(envelope.as_ref()) {
        TerminalIdentityIntentDurability::Committed => {}
        TerminalIdentityIntentDurability::DefiniteFailure(error) => {
            abort_terminal_identity_preparation(aes_key_created)?;
            return Err(error);
        }
        TerminalIdentityIntentDurability::AmbiguousFailure(error) => {
            let mut state = mutex
                .lock()
                .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
            state.blocked = true;
            state.terminal_identity_rollback_publication_pending = true;
            state.terminal_identity_rollback_publication_abandoned = true;
            return Err(error);
        }
    }

    if let Some((_raw, old)) = scope_snapshot {
        let mut pending = old.clone();
        pending.transition_pending = true;
        pending.scope_epoch = old
            .scope_epoch
            .checked_add(1)
            .filter(|epoch| *epoch <= MAX_SAFE_INTEGER)
            .ok_or_else(|| "REPAIR_TERMINAL_ROLLBACK_SCOPE_MISMATCH".to_string())?;
        persist_scope(&pending)?;
        let readback = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
        if !exact_pending_shape(&readback, &old) {
            return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_READBACK_FAILED".to_string());
        }
        let mut state = mutex
            .lock()
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
        state.epoch = pending.scope_epoch;
    }
    Ok(envelope)
}

#[cfg(test)]
pub(crate) fn prepare_terminal_identity_rollback(
    binding: &TerminalIdentityRollbackBinding,
) -> Result<Option<TerminalIdentityRollbackEnvelope>, String> {
    validate_terminal_identity_rollback_binding(binding)?;
    let _guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    reject_conflicting_repair_transition()?;
    let Some(raw) = crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)?
    else {
        return Ok(None);
    };
    if raw.len() > TERMINAL_IDENTITY_ROLLBACK_MAX_SCOPE_BYTES {
        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_TOO_LARGE".to_string());
    }
    let raw = Zeroizing::new(raw.to_string());
    let scope: RepairScopeState =
        serde_json::from_str(&raw).map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
    validate_scope(&scope).map_err(|_| "REPAIR_TERMINAL_ROLLBACK_INVALID".to_string())?;
    if scope.transition_pending
        || scope.reset_pending
        || !scope_matches_identity(
            &scope,
            &binding.old_organization_id,
            &binding.old_branch_id,
            &binding.old_terminal_id,
        )
    {
        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_MISMATCH".to_string());
    }
    // Capture happens before the terminal journal or scope is mutated. A
    // configured scope may not have produced encrypted repair data yet, so it
    // is safe (and necessary) to create the native key at this boundary.
    let key_bytes = load_or_create_key()?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes.as_slice())
            .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_KEY_INVALID".to_string())?,
    );
    let random = ring_rand::SystemRandom::new();
    let mut nonce = [0_u8; 12];
    random
        .fill(&mut nonce)
        .map_err(|_| "REPAIR_NONCE_GENERATION_FAILED".to_string())?;
    let aad = terminal_identity_rollback_aad(binding)?;
    let mut ciphertext = Zeroizing::new(raw.as_bytes().to_vec());
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(aad.as_slice()),
        &mut *ciphertext,
    )
    .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_ENCRYPTION_FAILED".to_string())?;
    Ok(Some(TerminalIdentityRollbackEnvelope {
        version: TERMINAL_IDENTITY_ROLLBACK_VERSION,
        nonce_b64: base64::engine::general_purpose::STANDARD.encode(nonce),
        ciphertext_b64: base64::engine::general_purpose::STANDARD.encode(&*ciphertext),
    }))
}

fn exact_pending_shape(current: &RepairScopeState, old: &RepairScopeState) -> bool {
    let mut expected = old.clone();
    expected.transition_pending = true;
    expected.scope_epoch = old.scope_epoch.saturating_add(1);
    serde_json::to_vec(current).ok() == serde_json::to_vec(&expected).ok()
}

fn persist_raw_scope_checked(raw: &str) -> Result<(), String> {
    crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, raw)
        .map_err(|_| "REPAIR_TERMINAL_ROLLBACK_SCOPE_WRITE_FAILED".to_string())?;
    let readback = crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)?
        .ok_or_else(|| "REPAIR_TERMINAL_ROLLBACK_SCOPE_READBACK_FAILED".to_string())?;
    if readback.as_bytes() != raw.as_bytes() {
        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_READBACK_FAILED".to_string());
    }
    Ok(())
}

pub(crate) fn arm_terminal_identity_transition(
    binding: &TerminalIdentityRollbackBinding,
    envelope: Option<&TerminalIdentityRollbackEnvelope>,
) -> Result<(), String> {
    validate_terminal_identity_rollback_binding(binding)?;
    let _guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    reject_conflicting_repair_transition()?;
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || state.maintenance_failed {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    state.blocked = true;
    while state.active_readers > 0 {
        state = condition
            .wait(state)
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    }
    drop(state);

    // The durable terminal journal already exists when this function is
    // called. Keep repair access blocked even when the envelope/key is
    // corrupt so a failed verification cannot reopen the old scope.
    let Some(envelope) = envelope else {
        if load_scope_raw()?.is_some() {
            return Err("REPAIR_TERMINAL_ROLLBACK_REQUIRED".to_string());
        }
        return Ok(());
    };
    let (_raw, old) = decrypt_terminal_identity_rollback(binding, envelope)?;
    let current = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
    if !exact_pending_shape(&current, &old) {
        let mut pending = old.clone();
        pending.transition_pending = true;
        pending.scope_epoch = old
            .scope_epoch
            .checked_add(1)
            .filter(|epoch| *epoch <= MAX_SAFE_INTEGER)
            .ok_or_else(|| "REPAIR_TERMINAL_ROLLBACK_SCOPE_MISMATCH".to_string())?;
        if serde_json::to_vec(&current).ok() != serde_json::to_vec(&old).ok() {
            return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_MISMATCH".to_string());
        }
        persist_scope(&pending)?;
        let readback = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
        if !exact_pending_shape(&readback, &old) {
            return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_READBACK_FAILED".to_string());
        }
    }
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || state.maintenance_failed || !state.blocked {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    state.epoch = old.scope_epoch.saturating_add(1);
    Ok(())
}

pub(crate) fn restore_terminal_identity_scope_while_blocked(
    binding: &TerminalIdentityRollbackBinding,
    envelope: Option<&TerminalIdentityRollbackEnvelope>,
) -> Result<TerminalIdentityRollbackPublication, String> {
    validate_terminal_identity_rollback_binding(binding)?;
    let guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    reject_conflicting_repair_transition()?;
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || state.maintenance_failed {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    state.blocked = true;
    state.terminal_identity_rollback_publication_pending = true;
    while state.active_readers > 0 {
        state = condition
            .wait(state)
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    }
    drop(state);

    let Some(envelope) = envelope else {
        if load_scope_raw()?.is_some() {
            return Err("REPAIR_TERMINAL_ROLLBACK_REQUIRED".to_string());
        }
        return Ok(TerminalIdentityRollbackPublication {
            _guard: guard,
            old_epoch: None,
            finished: false,
        });
    };
    let (raw, old) = decrypt_terminal_identity_rollback(binding, envelope)?;
    let current = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
    let current_is_old = serde_json::to_vec(&current).ok() == serde_json::to_vec(&old).ok();
    if !current_is_old && !exact_pending_shape(&current, &old) {
        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_MISMATCH".to_string());
    }
    persist_raw_scope_checked(&raw)?;
    let restored = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
    if serde_json::to_vec(&restored).ok() != serde_json::to_vec(&old).ok() {
        return Err("REPAIR_TERMINAL_ROLLBACK_SCOPE_READBACK_FAILED".to_string());
    }
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || state.maintenance_failed || !state.blocked {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    state.epoch = old.scope_epoch;
    drop(state);
    Ok(TerminalIdentityRollbackPublication {
        _guard: guard,
        old_epoch: Some(old.scope_epoch),
        finished: false,
    })
}

pub(crate) fn prepare_legacy_terminal_identity_rollback(
    old_organization_id: &str,
    old_branch_id: &str,
    old_terminal_id: &str,
) -> Result<TerminalIdentityRollbackPublication, String> {
    let guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    reject_conflicting_repair_transition()?;
    let scope = load_scope_raw()?;
    let old_epoch = if let Some(scope) = scope {
        if scope.transition_pending
            || scope.reset_pending
            || !scope_matches_identity(&scope, old_organization_id, old_branch_id, old_terminal_id)
        {
            return Err("REPAIR_TERMINAL_ROLLBACK_LEGACY_UNSAFE".to_string());
        }
        Some(scope.scope_epoch)
    } else {
        None
    };
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || state.maintenance_failed {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    state.blocked = true;
    state.terminal_identity_rollback_publication_pending = true;
    while state.active_readers > 0 {
        state = condition
            .wait(state)
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    }
    Ok(TerminalIdentityRollbackPublication {
        _guard: guard,
        old_epoch,
        finished: false,
    })
}

impl Drop for TerminalIdentityRollbackPublication {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut state) = lifecycle().0.lock() {
            state.blocked = true;
            state.terminal_identity_rollback_publication_pending = true;
            state.terminal_identity_rollback_publication_abandoned = true;
        }
    }
}

pub(crate) fn terminal_identity_rollback_publication_pending() -> Result<bool, String> {
    lifecycle()
        .0
        .lock()
        .map(|state| state.terminal_identity_rollback_publication_pending)
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())
}

pub(crate) fn finish_terminal_identity_rollback(
    mut publication: TerminalIdentityRollbackPublication,
) -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || state.maintenance_failed {
        return Err("REPAIR_TERMINAL_ROLLBACK_CONFLICT".to_string());
    }
    state.terminal_identity_rollback_publication_pending = false;
    state.terminal_identity_rollback_publication_abandoned = false;
    state.blocked = false;
    if let Some(epoch) = publication.old_epoch {
        state.epoch = epoch;
    }
    condition.notify_all();
    publication.finished = true;
    drop(state);
    drop(publication);
    Ok(())
}

fn active_scope() -> Result<RepairScopeState, String> {
    let scope = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
    if scope.transition_pending || scope.reset_pending {
        return Err("REPAIR_SCOPE_TRANSITION_PENDING".to_string());
    }
    Ok(scope)
}

fn key_init_mutex() -> &'static Mutex<()> {
    static KEY_INIT: OnceLock<Mutex<()>> = OnceLock::new();
    KEY_INIT.get_or_init(|| Mutex::new(()))
}

fn decode_key(raw: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let decoded = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|_| "REPAIR_AES_KEY_CORRUPT".to_string())?,
    );
    if decoded.len() != 32 {
        return Err("REPAIR_AES_KEY_CORRUPT".to_string());
    }
    Ok(decoded)
}

fn load_or_create_key_tracked() -> Result<(Zeroizing<Vec<u8>>, bool), String> {
    let _guard = key_init_mutex()
        .lock()
        .map_err(|_| "REPAIR_AES_KEY_UNAVAILABLE".to_string())?;
    if let Some(raw) =
        crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)?
    {
        return decode_key(&raw).map(|key| (key, false));
    }

    let random = ring_rand::SystemRandom::new();
    let mut generated = Zeroizing::new(vec![0_u8; 32]);
    random
        .fill(&mut generated)
        .map_err(|_| "REPAIR_AES_KEY_GENERATION_FAILED".to_string())?;
    let encoded = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&generated));
    crate::storage::set_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1, &encoded)
        .map_err(|_| "REPAIR_AES_KEY_WRITE_FAILED".to_string())?;
    let readback =
        crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)?
            .ok_or_else(|| "REPAIR_AES_KEY_READBACK_FAILED".to_string())?;
    let decoded = decode_key(&readback)?;
    if decoded.as_slice() != generated.as_slice() {
        return Err("REPAIR_AES_KEY_READBACK_FAILED".to_string());
    }
    Ok((decoded, true))
}

fn load_or_create_key() -> Result<Zeroizing<Vec<u8>>, String> {
    load_or_create_key_tracked().map(|(key, _created)| key)
}

fn aad(
    scope: &RepairScopeState,
    domain: CryptoDomain,
    entity_type: &str,
    entity_id: &str,
    operation_id: Option<&str>,
    version: u64,
) -> Zeroizing<Vec<u8>> {
    fn append_field(output: &mut Vec<u8>, value: &[u8]) {
        let length = u32::try_from(value.len()).unwrap_or(u32::MAX);
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(value);
    }

    let mut output = Vec::with_capacity(256);
    for value in [
        domain.label(),
        scope.organization_id.as_str(),
        scope.branch_id.as_str(),
        scope.terminal_id.as_str(),
        scope.scope_token.as_str(),
        entity_type,
        entity_id,
        operation_id.unwrap_or(""),
    ] {
        append_field(&mut output, value.as_bytes());
    }
    // Numeric fields are fixed-width and explicitly separated from the final
    // variable-width field, so no tenant/entity tuple can alias another AAD.
    output.extend_from_slice(&scope.scope_epoch.to_be_bytes());
    output.extend_from_slice(&version.to_be_bytes());
    Zeroizing::new(output)
}

fn attachment_entity_identity(repair_id: &str, attachment_id: &str) -> Result<String, String> {
    if canonical_uuid(repair_id).is_none() || canonical_uuid(attachment_id).is_none() {
        return Err("REPAIR_ATTACHMENT_IDENTITY_INVALID".to_string());
    }
    Ok(format!("{repair_id}/{attachment_id}"))
}

fn encrypt(
    scope: &RepairScopeState,
    domain: CryptoDomain,
    entity_type: &str,
    entity_id: &str,
    operation_id: Option<&str>,
    version: u64,
    plaintext: &[u8],
) -> Result<EncryptedBlob, String> {
    let key_bytes = load_or_create_key()?;
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes.as_slice())
        .map_err(|_| "REPAIR_AES_KEY_CORRUPT".to_string())?;
    let key = aead::LessSafeKey::new(unbound);
    let random = ring_rand::SystemRandom::new();
    let mut nonce = [0_u8; 12];
    random
        .fill(&mut nonce)
        .map_err(|_| "REPAIR_NONCE_GENERATION_FAILED".to_string())?;
    let mut ciphertext = Zeroizing::new(plaintext.to_vec());
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(
            aad(scope, domain, entity_type, entity_id, operation_id, version).as_slice(),
        ),
        &mut *ciphertext,
    )
    .map_err(|_| "REPAIR_ENCRYPTION_FAILED".to_string())?;
    Ok(EncryptedBlob { nonce, ciphertext })
}

fn decrypt(
    scope: &RepairScopeState,
    domain: CryptoDomain,
    entity_type: &str,
    entity_id: &str,
    operation_id: Option<&str>,
    version: u64,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce: [u8; 12] = nonce
        .try_into()
        .map_err(|_| "REPAIR_CIPHERTEXT_INVALID".to_string())?;
    let key_bytes = load_or_create_key()?;
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, key_bytes.as_slice())
        .map_err(|_| "REPAIR_AES_KEY_CORRUPT".to_string())?;
    let key = aead::LessSafeKey::new(unbound);
    let mut plaintext = Zeroizing::new(ciphertext.to_vec());
    let length = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(
                aad(scope, domain, entity_type, entity_id, operation_id, version).as_slice(),
            ),
            &mut plaintext,
        )
        .map_err(|_| "REPAIR_DECRYPTION_FAILED".to_string())?
        .len();
    plaintext.truncate(length);
    Ok(plaintext)
}

fn store_ciphertext(scope: &RepairScopeState, encrypted: &EncryptedBlob) -> Result<String, String> {
    let nonce_b64 =
        Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(encrypted.nonce));
    let ciphertext_b64 =
        Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&encrypted.ciphertext));
    serde_json::to_string(&StoredCiphertext {
        version: 1,
        scope_epoch: scope.scope_epoch,
        nonce_b64: nonce_b64.to_string(),
        ciphertext_b64: ciphertext_b64.to_string(),
    })
    .map_err(|_| "REPAIR_CIPHERTEXT_INVALID".to_string())
}

fn open_stored_ciphertext(
    scope: &RepairScopeState,
    domain: CryptoDomain,
    entity_type: &str,
    entity_id: &str,
    operation_id: Option<&str>,
    version: u64,
    stored: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let stored: StoredCiphertext =
        serde_json::from_str(stored).map_err(|_| "REPAIR_CIPHERTEXT_INVALID".to_string())?;
    if stored.version != 1 || stored.scope_epoch != scope.scope_epoch {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    let nonce = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(stored.nonce_b64)
            .map_err(|_| "REPAIR_CIPHERTEXT_INVALID".to_string())?,
    );
    let ciphertext = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(stored.ciphertext_b64)
            .map_err(|_| "REPAIR_CIPHERTEXT_INVALID".to_string())?,
    );
    decrypt(
        scope,
        domain,
        entity_type,
        entity_id,
        operation_id,
        version,
        &nonce,
        &ciphertext,
    )
}

fn lifecycle() -> &'static (Mutex<LifecycleState>, Condvar) {
    static STATE: OnceLock<(Mutex<LifecycleState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| (Mutex::new(LifecycleState::default()), Condvar::new()))
}

#[cfg(test)]
fn reset_lifecycle_state_for_test() {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *state = LifecycleState::default();
    condition.notify_all();
}

#[cfg(test)]
fn lifecycle_test_mutex() -> &'static Mutex<()> {
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    TEST_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
#[must_use]
pub(crate) struct RepairLifecycleTestIsolation {
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
pub(crate) fn isolate_lifecycle_for_test() -> RepairLifecycleTestIsolation {
    let guard = lifecycle_test_mutex()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset_lifecycle_state_for_test();
    RepairLifecycleTestIsolation { _guard: guard }
}

#[cfg(test)]
impl RepairLifecycleTestIsolation {
    pub(crate) fn reset(&self) {
        reset_lifecycle_state_for_test();
    }
}

#[cfg(test)]
impl Drop for RepairLifecycleTestIsolation {
    fn drop(&mut self) {
        reset_lifecycle_state_for_test();
    }
}

/// Owned read lease held across prepare, HTTP await and final queue/cache
/// transition. It contains no mutex guard, so it is safe to move across an
/// await; `Drop` only decrements the active-reader counter.
#[derive(Debug)]
pub(crate) struct RepairLifecycleLease {}

impl Drop for RepairLifecycleLease {
    fn drop(&mut self) {
        let (mutex, condition) = lifecycle();
        if let Ok(mut state) = mutex.lock() {
            state.active_readers = state.active_readers.saturating_sub(1);
            condition.notify_all();
        }
    }
}

/// Entitlement-independent read lease for generic terminal-bound transports.
///
/// The immutable generation binds a credential snapshot to the same lifecycle
/// epoch that rebind/reset writers advance. Like the repair lease, this guard
/// owns no mutex across await and participates in the existing writer drain.
#[derive(Debug)]
pub(crate) struct TerminalBindingLease {
    generation: u64,
}

impl TerminalBindingLease {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for TerminalBindingLease {
    fn drop(&mut self) {
        let (mutex, condition) = lifecycle();
        if let Ok(mut state) = mutex.lock() {
            state.active_readers = state.active_readers.saturating_sub(1);
            condition.notify_all();
        }
    }
}

pub(crate) fn acquire_terminal_binding_lease() -> Result<TerminalBindingLease, String> {
    let (mutex, _) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if state.maintenance_failed {
        return Err("REPAIR_STAGING_MAINTENANCE_FAILED".to_string());
    }
    if state.blocked {
        return Err("REPAIR_SCOPE_TRANSITION_PENDING".to_string());
    }
    let generation = state.epoch;
    state.active_readers = state.active_readers.saturating_add(1);
    Ok(TerminalBindingLease { generation })
}

pub(crate) fn acquire_transport_lease(
) -> Result<RepairLifecycleLease, crate::repair_transport::RepairHookError> {
    let scope = active_scope().map_err(|_| {
        crate::repair_transport::RepairHookError::unavailable("REPAIR_SCOPE_TRANSITION_PENDING")
    })?;
    require_entitlement(&scope).map_err(|_| {
        crate::repair_transport::RepairHookError::unavailable("REPAIR_MODULE_REQUIRED")
    })?;
    acquire_lifecycle_lease(&scope).map_err(|_| {
        crate::repair_transport::RepairHookError::unavailable("REPAIR_SCOPE_TRANSITION_PENDING")
    })
}

fn acquire_lifecycle_lease(scope: &RepairScopeState) -> Result<RepairLifecycleLease, String> {
    let (mutex, _) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.blocked || state.reset_latched || state.maintenance_failed {
        return Err("REPAIR_SCOPE_TRANSITION_PENDING".to_string());
    }
    let current = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
    if current.scope_epoch != scope.scope_epoch
        || !scope_matches_identity(
            &current,
            &scope.organization_id,
            &scope.branch_id,
            &scope.terminal_id,
        )
        || current.transition_pending
        || current.reset_pending
    {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    require_entitlement(&current)?;
    state.active_readers = state.active_readers.saturating_add(1);
    Ok(RepairLifecycleLease {})
}

fn mark_identity_transition_pending(key: &str, new_value: Option<&str>) -> Result<(), String> {
    if !IDENTITY_KEYS.contains(&key) {
        return Ok(());
    }
    let Some(mut scope) = load_scope_raw()? else {
        return Ok(());
    };
    let existing = match key {
        "organization_id" => Some(scope.organization_id.as_str()),
        "branch_id" => Some(scope.branch_id.as_str()),
        "terminal_id" => Some(scope.terminal_id.as_str()),
        _ => None,
    };
    if existing == new_value {
        return Ok(());
    }
    let (mutex, _) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched || scope.reset_pending {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if state.maintenance_failed {
        return Err("REPAIR_STAGING_MAINTENANCE_FAILED".to_string());
    }
    if scope.transition_pending {
        if state.active_readers > 0 || (state.epoch != 0 && state.epoch != scope.scope_epoch) {
            return Err("REPAIR_SCOPE_TRANSITION_BUSY".to_string());
        }
        state.blocked = true;
        state.epoch = scope.scope_epoch;
        return Ok(());
    }
    if state.active_readers > 0 {
        return Err("REPAIR_SCOPE_TRANSITION_BUSY".to_string());
    }
    if state.epoch != 0 && state.epoch != scope.scope_epoch {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    let next_epoch = scope
        .scope_epoch
        .checked_add(1)
        .filter(|epoch| *epoch <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "REPAIR_SCOPE_EPOCH_EXHAUSTED".to_string())?;
    state.blocked = true;
    scope.transition_pending = true;
    scope.scope_epoch = next_epoch;
    persist_scope(&scope)?;
    state.epoch = scope.scope_epoch;
    Ok(())
}

pub(crate) fn coordinated_identity_credential_write<T>(
    key: &str,
    new_value: Option<&str>,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if !IDENTITY_KEYS.contains(&key) {
        return write();
    }
    let _guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    mark_identity_transition_pending(key, new_value)?;
    write()
}

/// Called centrally by `storage` before any terminal identity credential is
/// mutated, including legacy call sites outside Task 9C's write-set. Once a
/// repair scope exists, a differing identity blocks repair activity until a
/// DB-aware coordinator has purged the old scope.
#[cfg(test)]
pub(crate) fn before_identity_credential_write(
    key: &str,
    new_value: Option<&str>,
) -> Result<(), String> {
    mark_identity_transition_pending(key, new_value)
}

fn runtime_value(connection: &Connection, key: &str) -> Result<String, String> {
    if let Some(value) = crate::storage::get_credential_strict(key)? {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    crate::db::get_setting(connection, "terminal", key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "REPAIR_NATIVE_SCOPE_REQUIRED".to_string())
}

fn runtime_scope_identity(connection: &Connection) -> Result<(String, String, String), String> {
    let organization_id = runtime_value(connection, "organization_id")?;
    let branch_id = runtime_value(connection, "branch_id")?;
    let terminal_id = runtime_value(connection, "terminal_id")?;
    if canonical_uuid(&organization_id).is_none()
        || canonical_uuid(&branch_id).is_none()
        || !validate_terminal_id(&terminal_id)
    {
        return Err("REPAIR_NATIVE_SCOPE_INVALID".to_string());
    }
    Ok((organization_id, branch_id, terminal_id))
}

fn runtime_scope_identity_from_keyring() -> Result<(String, String, String), String> {
    let read = |key: &str| -> Result<String, String> {
        crate::storage::get_credential_strict(key)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "REPAIR_NATIVE_SCOPE_REQUIRED".to_string())
    };
    let identity = (
        read("organization_id")?,
        read("branch_id")?,
        read("terminal_id")?,
    );
    if canonical_uuid(&identity.0).is_none()
        || canonical_uuid(&identity.1).is_none()
        || !validate_terminal_id(&identity.2)
    {
        return Err("REPAIR_NATIVE_SCOPE_INVALID".to_string());
    }
    Ok(identity)
}

fn new_scope(
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    epoch: u64,
) -> RepairScopeState {
    RepairScopeState {
        version: SCOPE_VERSION,
        organization_id,
        branch_id,
        terminal_id,
        scope_token: Uuid::new_v4().to_string(),
        scope_epoch: epoch.max(1),
        transition_pending: false,
        reset_pending: false,
        offline_terminal_token: None,
        offline_sequence_lease_start: None,
        offline_sequence_lease_end: None,
        settings_cache: None,
    }
}

fn scope_matches_identity(
    scope: &RepairScopeState,
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
) -> bool {
    scope.organization_id == organization_id
        && scope.branch_id == branch_id
        && scope.terminal_id == terminal_id
}

#[derive(Clone, Debug)]
pub(crate) struct RepairAccessReconciliation {
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    scope_token: String,
    scope_epoch: u64,
    disabled: bool,
    identity_changed: bool,
    access_decision_generation: u64,
}

impl RepairAccessReconciliation {
    pub(crate) fn is_disabled(&self) -> bool {
        self.disabled
    }

    pub(crate) fn identity_changed(&self) -> bool {
        self.identity_changed
    }

    pub(crate) fn scope_token(&self) -> &str {
        &self.scope_token
    }
}

fn persist_entitlement_for_scope(scope: &RepairScopeState, enabled: bool) -> Result<(), String> {
    let entitlement = RepairEntitlementState {
        version: ENTITLEMENT_VERSION,
        organization_id: scope.organization_id.clone(),
        branch_id: scope.branch_id.clone(),
        terminal_id: scope.terminal_id.clone(),
        scope_epoch: scope.scope_epoch,
        enabled,
        verified_at: chrono::Utc::now().to_rfc3339(),
    };
    let serialized = Zeroizing::new(
        serde_json::to_string(&entitlement)
            .map_err(|_| "REPAIR_ENTITLEMENT_INVALID".to_string())?,
    );
    crate::storage::set_credential(crate::storage::KEY_REPAIR_ENTITLEMENT_V1, &serialized)
        .map_err(|_| "REPAIR_ENTITLEMENT_WRITE_FAILED".to_string())
}

fn next_access_decision(state: &mut LifecycleState) -> Result<RepairAccessDecision, String> {
    state.access_decision_generation = state
        .access_decision_generation
        .checked_add(1)
        .ok_or_else(|| "REPAIR_ACCESS_DECISION_EXHAUSTED".to_string())?;
    Ok(RepairAccessDecision {
        generation: state.access_decision_generation,
    })
}

fn require_current_access_decision(
    state: &LifecycleState,
    decision: RepairAccessDecision,
) -> Result<(), String> {
    if state.access_decision_generation != decision.generation {
        return Err("REPAIR_ACCESS_DECISION_STALE".to_string());
    }
    Ok(())
}

/// Allocate the linearization token for one modules fetch before its network
/// await. A later-started fetch receives a higher generation, so an older
/// response can no longer publish or retain access after the newer decision.
pub(crate) fn start_authoritative_access_decision() -> Result<RepairAccessDecision, String> {
    let _transition = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    let (mutex, _) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    next_access_decision(&mut state)
}

/// Fail closed for a known modules-fetch generation. The compare-and-set is
/// essential: an old invalid response must not block access granted by a
/// later request, just as an old success must not reopen a later denial.
pub(crate) fn latch_authoritative_access_pending(
    decision: RepairAccessDecision,
) -> Result<(), String> {
    let _transition = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    require_current_access_decision(&state, decision)?;
    state.blocked = true;
    condition.notify_all();
    Ok(())
}

fn block_access_reconciliation(
    scope: Option<&mut RepairScopeState>,
    decision: RepairAccessDecision,
) -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    require_current_access_decision(&state, decision)?;
    if state.reset_latched || scope.as_ref().is_some_and(|scope| scope.reset_pending) {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    state.blocked = true;
    state.epoch = state.epoch.saturating_add(1);
    if let Some(scope) = scope {
        scope.transition_pending = true;
        persist_scope(scope)?;
    }
    while state.active_readers > 0 {
        state = condition
            .wait(state)
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    }
    Ok(())
}

fn block_access_decision_in_memory(decision: RepairAccessDecision) -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    require_current_access_decision(&state, decision)?;
    if state.reset_latched {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    state.blocked = true;
    while state.active_readers > 0 {
        state = condition
            .wait(state)
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
        require_current_access_decision(&state, decision)?;
    }
    Ok(())
}

fn persist_runtime_identity(
    connection: &Connection,
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
) -> Result<(), String> {
    let previous = crate::storage::replace_repair_identity_uncoordinated(
        organization_id,
        branch_id,
        terminal_id,
    )?;
    let sqlite_result = (|| {
        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| "REPAIR_IDENTITY_WRITE_FAILED".to_string())?;
        for (key, value) in [
            ("organization_id", organization_id),
            ("branch_id", branch_id),
            ("terminal_id", terminal_id),
        ] {
            crate::db::set_setting(&transaction, "terminal", key, value)
                .map_err(|_| "REPAIR_IDENTITY_WRITE_FAILED".to_string())?;
        }
        transaction
            .commit()
            .map_err(|_| "REPAIR_IDENTITY_WRITE_FAILED".to_string())
    })();

    if let Err(error) = sqlite_result {
        crate::storage::restore_repair_identity_uncoordinated(&previous)?;
        return Err(error);
    }
    Ok(())
}

fn purge_and_persist_runtime_identity(
    connection: &Connection,
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
) -> Result<(), String> {
    let mut previous = None;
    let sqlite_result = (|| {
        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| "REPAIR_OPERATIONAL_PURGE_FAILED".to_string())?;
        purge_repair_rows_in_transaction(&transaction, true)?;
        for (key, value) in [
            ("organization_id", organization_id),
            ("branch_id", branch_id),
            ("terminal_id", terminal_id),
        ] {
            crate::db::set_setting(&transaction, "terminal", key, value)
                .map_err(|_| "REPAIR_IDENTITY_WRITE_FAILED".to_string())?;
        }
        previous = Some(crate::storage::replace_repair_identity_uncoordinated(
            organization_id,
            branch_id,
            terminal_id,
        )?);
        transition_fault("after_identity_write_before_commit")?;
        transaction
            .commit()
            .map_err(|_| "REPAIR_OPERATIONAL_PURGE_FAILED".to_string())
    })();

    if let Err(error) = sqlite_result {
        if let Some(previous) = previous.as_ref() {
            crate::storage::restore_repair_identity_uncoordinated(previous)?;
        }
        return Err(error);
    }
    Ok(())
}

fn verified_delete_repair_credentials() -> Result<(), String> {
    let result = (|| {
        crate::storage::delete_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)
            .map_err(|_| "REPAIR_AES_KEY_DELETE_FAILED".to_string())?;
        crate::storage::delete_credential(crate::storage::KEY_REPAIR_ENTITLEMENT_V1)
            .map_err(|_| "REPAIR_ENTITLEMENT_DELETE_FAILED".to_string())?;
        crate::storage::delete_repair_actor_attestation()
            .map_err(|_| "REPAIR_ACTOR_ATTESTATION_CLEAR_FAILED".to_string())?;
        if crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)?
            .is_some()
            || crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_ENTITLEMENT_V1)?
                .is_some()
            || crate::storage::get_credential_strict(
                crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            )?
            .is_some()
        {
            return Err("REPAIR_ACCESS_REVOCATION_VERIFICATION_FAILED".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        latch_startup_maintenance_failure();
    }
    result
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RepairTransitionJournalPhase {
    Intent,
    Prepared,
    MarkerWritten,
    FilesStaged,
    /// Rollback A has been selected durably. Recovery accepts either the
    /// authenticated staged layout (rename not yet durable) or the restored
    /// original layout (rename completed) and finishes the same operation.
    FilesRestored,
    DatabaseCommitted,
    Finalizing,
    FilesFinalized,
    TargetPublished,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepairTransitionJournal {
    version: u8,
    old_scope: RepairScopeState,
    target_scope: RepairScopeState,
    transition_nonce: String,
    directory_staged: bool,
    #[serde(default)]
    directory_identity_primary: Option<u64>,
    #[serde(default)]
    directory_identity_secondary: Option<u64>,
    target_organization_id: String,
    target_branch_id: String,
    target_terminal_id: String,
    decision_generation: u64,
    enabled: bool,
    phase: RepairTransitionJournalPhase,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepairTransitionMarker {
    version: u8,
    transition_nonce: String,
    old_scope_token: String,
    target_scope_token: String,
    directory_identity_primary: u64,
    directory_identity_secondary: u64,
}

const TRANSITION_MARKER_NAME: &str = ".repair-transition-v3";
const MAX_TRANSITION_MARKER_BYTES: u64 = 1024;

fn transition_marker_temp_name(journal: &RepairTransitionJournal) -> String {
    format!(".repair-transition-v3-{}.tmp", journal.transition_nonce)
}

fn transition_finalizing_path(root: &Path, journal: &RepairTransitionJournal) -> PathBuf {
    root.join(format!(
        ".scope-finalize-v3-{}-{}",
        journal.old_scope.scope_token, journal.transition_nonce
    ))
}

fn transition_completion_path(root: &Path, journal: &RepairTransitionJournal) -> PathBuf {
    root.join(format!(".scope-finalized-v3-{}", journal.transition_nonce))
}

fn transition_completion_temp_path(root: &Path, journal: &RepairTransitionJournal) -> PathBuf {
    root.join(format!(
        ".scope-finalized-v3-{}.tmp",
        journal.transition_nonce
    ))
}

fn is_authenticated_marker_prefix(
    actual: &[u8],
    journal: &RepairTransitionJournal,
) -> Result<bool, String> {
    let expected = transition_marker_bytes(journal)?;
    let nonce = journal.transition_nonce.as_bytes();
    let nonce_end = expected
        .windows(nonce.len())
        .position(|window| window == nonce)
        .map(|start| start + nonce.len())
        .ok_or_else(|| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
    Ok(actual.len() >= nonce_end && expected.starts_with(actual))
}

fn validate_authenticated_transition_file(
    path: &Path,
    journal: &RepairTransitionJournal,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || metadata.len() > MAX_TRANSITION_MARKER_BYTES
    {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let mut actual = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| {
            file.take(MAX_TRANSITION_MARKER_BYTES + 1)
                .read_to_end(&mut actual)
        })
        .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
    if actual.as_slice() != transition_marker_bytes(journal)?.as_slice() {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    Ok(())
}

fn create_completion_sentinel(
    root: &Path,
    journal: &RepairTransitionJournal,
) -> Result<(), String> {
    let path = transition_completion_path(root, journal);
    let temporary = transition_completion_temp_path(root, journal);
    let bytes = transition_marker_bytes(journal)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    fs::hard_link(&temporary, &path)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    sync_directory_metadata(root).map_err(|_| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
    durable_remove_file(&temporary)
        .map_err(|_| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
    validate_authenticated_transition_file(&path, journal)
}

fn sync_directory_metadata(directory: &Path) -> Result<(), String> {
    #[cfg(test)]
    if TRANSITION_DIRECTORY_SYNC_FAILURE.with(|failure| failure.get()) {
        return Err("REPAIR_TRANSITION_DURABILITY_FAILED".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_WRITE_THROUGH: u32 = 0x8000_0000;
        let handle = OpenOptions::new()
            // `File::sync_all` maps to `FlushFileBuffers`, whose Windows
            // contract requires a handle opened with GENERIC_WRITE.
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_WRITE_THROUGH)
            .open(directory)
            .map_err(|_| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
        handle
            .sync_all()
            .map_err(|_| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())
    }
    #[cfg(not(windows))]
    {
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TransitionFileIdentity {
    primary: u64,
    secondary: u64,
}

#[cfg(test)]
thread_local! {
    static TRANSITION_IDENTITY_UNAVAILABLE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static TRANSITION_DIRECTORY_SYNC_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    #[cfg(windows)]
    static TRANSITION_WINDOWS_REPLACEMENT_ATTEMPT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn transition_file_identity(path: &Path) -> Result<TransitionFileIdentity, String> {
    #[cfg(test)]
    if TRANSITION_IDENTITY_UNAVAILABLE.with(|unavailable| unavailable.get()) {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        };

        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
        }
        let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        let read_ok = unsafe { GetFileInformationByHandle(handle, &mut info) } != 0;
        unsafe { CloseHandle(handle) };
        let primary = info.dwVolumeSerialNumber as u64;
        let secondary = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
        if !read_ok
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || primary == 0
            || secondary == 0
        {
            return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
        }
        Ok(TransitionFileIdentity { primary, secondary })
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(TransitionFileIdentity {
            primary: metadata.dev(),
            secondary: metadata.ino(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(TransitionFileIdentity {
            primary: metadata.len(),
            secondary: 0,
        })
    }
}

fn durable_remove_file(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
    fs::remove_file(path).map_err(|_| "REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string())?;
    sync_directory_metadata(parent)
}

fn durable_rename(from: &Path, to: &Path) -> Result<(), String> {
    let from_parent = from
        .parent()
        .ok_or_else(|| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
    let to_parent = to
        .parent()
        .ok_or_else(|| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
    fs::rename(from, to).map_err(|_| "REPAIR_EXTERNAL_CLEANUP_PREPARE_FAILED".to_string())?;
    sync_directory_metadata(from_parent)?;
    if from_parent != to_parent {
        sync_directory_metadata(to_parent)?;
    }
    Ok(())
}

fn atomic_rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let from = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let to = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // Deliberately omit MOVEFILE_REPLACE_EXISTING: this is the native
        // atomic fail-if-exists boundary, not a check followed by rename.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 {
            Ok(())
        } else {
            Err("REPAIR_EXTERNAL_CLEANUP_PREPARE_FAILED".to_string())
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        const AT_FDCWD: i32 = -100;
        const RENAME_NOREPLACE: u32 = 1;
        extern "C" {
            fn renameat2(
                olddirfd: i32,
                oldpath: *const std::os::raw::c_char,
                newdirfd: i32,
                newpath: *const std::os::raw::c_char,
                flags: u32,
            ) -> i32;
        }
        let from = CString::new(from.as_os_str().as_bytes())
            .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
        let to = CString::new(to.as_os_str().as_bytes())
            .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
        if unsafe {
            renameat2(
                AT_FDCWD,
                from.as_ptr(),
                AT_FDCWD,
                to.as_ptr(),
                RENAME_NOREPLACE,
            )
        } == 0
        {
            Ok(())
        } else {
            Err("REPAIR_EXTERNAL_CLEANUP_PREPARE_FAILED".to_string())
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        const RENAME_EXCL: u32 = 0x0000_0004;
        extern "C" {
            fn renamex_np(
                from: *const std::os::raw::c_char,
                to: *const std::os::raw::c_char,
                flags: u32,
            ) -> i32;
        }
        let from = CString::new(from.as_os_str().as_bytes())
            .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
        let to = CString::new(to.as_os_str().as_bytes())
            .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
        if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_EXCL) } == 0 {
            Ok(())
        } else {
            Err("REPAIR_EXTERNAL_CLEANUP_PREPARE_FAILED".to_string())
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (from, to);
        Err("REPAIR_TRANSITION_DURABILITY_UNSUPPORTED".to_string())
    }
}

fn durable_rename_no_replace(from: &Path, to: &Path) -> Result<(), String> {
    let from_parent = from
        .parent()
        .ok_or_else(|| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
    let to_parent = to
        .parent()
        .ok_or_else(|| "REPAIR_TRANSITION_DURABILITY_FAILED".to_string())?;
    atomic_rename_no_replace(from, to)?;
    sync_directory_metadata(from_parent)?;
    if from_parent != to_parent {
        sync_directory_metadata(to_parent)?;
    }
    Ok(())
}

fn remove_owned_transition_temp(
    directory: &Path,
    journal: &RepairTransitionJournal,
) -> Result<(), String> {
    let temporary = directory.join(transition_marker_temp_name(journal));
    match fs::symlink_metadata(&temporary) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && !metadata_is_reparse_point(&metadata)
                && metadata.len() <= MAX_TRANSITION_MARKER_BYTES =>
        {
            let bytes =
                fs::read(&temporary).map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
            if !is_authenticated_marker_prefix(&bytes, journal)? {
                return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
            }
            durable_remove_file(&temporary)
                .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())
        }
        Ok(_) => Err("REPAIR_TRANSITION_MARKER_INVALID".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("REPAIR_TRANSITION_MARKER_INVALID".to_string()),
    }
}

fn transition_marker_bytes(
    journal: &RepairTransitionJournal,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let marker = RepairTransitionMarker {
        version: 3,
        transition_nonce: journal.transition_nonce.clone(),
        old_scope_token: journal.old_scope.scope_token.clone(),
        target_scope_token: journal.target_scope.scope_token.clone(),
        directory_identity_primary: journal.directory_identity_primary.unwrap_or_default(),
        directory_identity_secondary: journal.directory_identity_secondary.unwrap_or_default(),
    };
    serde_json::to_vec(&marker)
        .map(Zeroizing::new)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())
}

fn validate_transition_marker(
    directory: &Path,
    journal: &RepairTransitionJournal,
) -> Result<(), String> {
    let marker_path = directory.join(TRANSITION_MARKER_NAME);
    let metadata = fs::symlink_metadata(&marker_path)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    if metadata.len() > MAX_TRANSITION_MARKER_BYTES {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let mut actual = Vec::with_capacity(metadata.len() as usize);
    File::open(&marker_path)
        .and_then(|file| {
            file.take(MAX_TRANSITION_MARKER_BYTES + 1)
                .read_to_end(&mut actual)
        })
        .map_err(|_| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
    if actual.len() as u64 > MAX_TRANSITION_MARKER_BYTES {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    if actual.as_slice() != transition_marker_bytes(journal)?.as_slice() {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    Ok(())
}

fn create_transition_marker(
    directory: &Path,
    journal: &RepairTransitionJournal,
) -> Result<(), String> {
    let marker_path = directory.join(TRANSITION_MARKER_NAME);
    let temporary_path = directory.join(transition_marker_temp_name(journal));
    let bytes = transition_marker_bytes(journal)?;
    if bytes.len() as u64 > MAX_TRANSITION_MARKER_BYTES {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    marker
        .write_all(&bytes)
        .and_then(|_| marker.sync_all())
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    drop(marker);
    fs::hard_link(&temporary_path, &marker_path)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    sync_directory_metadata(directory)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    durable_remove_file(&temporary_path)
        .map_err(|_| "REPAIR_TRANSITION_MARKER_WRITE_FAILED".to_string())?;
    validate_transition_marker(directory, journal)
}

fn persist_transition_journal(journal: &RepairTransitionJournal) -> Result<(), String> {
    let encoded = Zeroizing::new(
        serde_json::to_string(journal)
            .map_err(|_| "REPAIR_TRANSITION_JOURNAL_INVALID".to_string())?,
    );
    crate::storage::write_repair_transition_journal(&encoded)
}

#[cfg(test)]
thread_local! {
    static TRANSITION_FAULT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_transition_fault(point: Option<&'static str>) {
    TRANSITION_FAULT.with(|fault| *fault.borrow_mut() = point);
}

fn transition_fault(point: &'static str) -> Result<(), String> {
    #[cfg(test)]
    if TRANSITION_FAULT.with(|fault| fault.borrow().as_ref().copied()) == Some(point) {
        return Err("REPAIR_TRANSITION_INTERRUPTED".to_string());
    }
    #[cfg(not(test))]
    let _ = point;
    Ok(())
}

struct PreparedExternalCleanup {
    original_directory: PathBuf,
    staged_directory: PathBuf,
    directory_staged: bool,
}

fn prepare_external_cleanup(
    connection: &Connection,
    journal: &mut RepairTransitionJournal,
) -> Result<PreparedExternalCleanup, String> {
    let root = staging_root(connection)?;
    if root.exists() && !safe_staging_directory_state(&root)? {
        latch_startup_maintenance_failure();
        return Err("REPAIR_STAGING_PATH_UNSAFE".to_string());
    }
    let original_directory = scope_staging_dir(connection, &journal.old_scope)?;
    let staged_directory = root.join(format!(
        ".scope-cleanup-v3-{}",
        journal.old_scope.scope_token
    ));
    if safe_staging_directory_state(&staged_directory)? {
        latch_startup_maintenance_failure();
        return Err("REPAIR_EXTERNAL_CLEANUP_PENDING".to_string());
    }
    let directory_staged = safe_staging_directory_state(&original_directory)?;
    if directory_staged {
        let identity = transition_file_identity(&original_directory)?;
        journal.directory_identity_primary = Some(identity.primary);
        journal.directory_identity_secondary = Some(identity.secondary);
        journal.directory_staged = true;
        journal.phase = RepairTransitionJournalPhase::Prepared;
        persist_transition_journal(journal)?;
        create_transition_marker(&original_directory, journal)?;
        transition_fault("after_marker_create")?;
        journal.phase = RepairTransitionJournalPhase::MarkerWritten;
        persist_transition_journal(journal)?;
        durable_rename(&original_directory, &staged_directory)
            .map_err(|_| "REPAIR_EXTERNAL_CLEANUP_PREPARE_FAILED".to_string())?;
        transition_fault("after_stage_rename")?;
    } else {
        journal.directory_staged = false;
    }
    Ok(PreparedExternalCleanup {
        original_directory,
        staged_directory,
        directory_staged,
    })
}

fn rollback_external_cleanup(
    cleanup: &PreparedExternalCleanup,
    journal: &mut RepairTransitionJournal,
) -> Result<(), String> {
    let directory: Result<(), String> = if cleanup.directory_staged {
        journal.phase = RepairTransitionJournalPhase::FilesRestored;
        persist_transition_journal(journal)?;
        validate_transition_marker(&cleanup.staged_directory, journal)?;
        durable_rename(&cleanup.staged_directory, &cleanup.original_directory)
            .map_err(|_| "REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string())?;
        // Keep the authenticated marker until exact-A scope and identity have
        // both been durably published. Recovery can therefore authenticate
        // the restored directory across every later fallible step.
        Ok(())
    } else {
        Ok(())
    };
    if directory.is_err() {
        latch_startup_maintenance_failure();
        Err("REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string())
    } else {
        Ok(())
    }
}

fn finalize_external_cleanup(
    cleanup: &PreparedExternalCleanup,
    journal: &mut RepairTransitionJournal,
) -> Result<(), String> {
    if cleanup.directory_staged {
        transition_fault("before_finalize_remove")?;
        durable_remove_authenticated_transition_directory(
            &cleanup.staged_directory,
            journal,
            false,
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn capability_remove_transition_directory(
    directory: &Path,
    journal: &RepairTransitionJournal,
    expected: TransitionFileIdentity,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    struct HandleGuard(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    let wide = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let guard = HandleGuard(handle);
    let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(guard.0, &mut info) } == 0
        || info.dwVolumeSerialNumber == 0
    {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let identity = TransitionFileIdentity {
        primary: info.dwVolumeSerialNumber as u64,
        secondary: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    };
    if identity.secondary == 0 || identity != expected {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    validate_transition_marker(directory, journal)?;

    #[cfg(test)]
    if TRANSITION_WINDOWS_REPLACEMENT_ATTEMPT.with(|attempt| attempt.get()) {
        let parent = directory
            .parent()
            .ok_or_else(|| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
        let displaced = parent.join("round2d9-displaced-root");
        if fs::rename(directory, &displaced).is_ok() {
            let _ = fs::rename(&displaced, directory);
            return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
        }
        let foreign = parent.join("round2d9-foreign-child-bytes.bin");
        fs::write(&foreign, b"ROUND2D9_FOREIGN_CHILD_BYTES")
            .map_err(|_| "REPAIR_EXTERNAL_CLEANUP_PENDING".to_string())?;
        let replacement = directory.join("round2d9-replaced-child.bin");
        let _ = fs::remove_file(&replacement);
        fs::hard_link(&foreign, &replacement)
            .map_err(|_| "REPAIR_EXTERNAL_CLEANUP_PENDING".to_string())?;
    }

    // Rust's Windows implementation opens the supplied root and traverses its
    // children relative to that handle. Our no-delete-share guard pins the
    // authenticated root, so only the final root disposition may fail.
    match fs::remove_dir_all(directory) {
        Err(error) if error.raw_os_error() == Some(32) => {}
        _ => return Err("REPAIR_EXTERNAL_CLEANUP_PENDING".to_string()),
    }
    if fs::read_dir(directory)
        .map_err(|_| "REPAIR_EXTERNAL_CLEANUP_PENDING".to_string())?
        .next()
        .is_some()
    {
        return Err("REPAIR_EXTERNAL_CLEANUP_PENDING".to_string());
    }
    let mut after = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileInformationByHandle(guard.0, &mut after) } == 0
        || after.dwVolumeSerialNumber != info.dwVolumeSerialNumber
        || after.nFileIndexHigh != info.nFileIndexHigh
        || after.nFileIndexLow != info.nFileIndexLow
    {
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    if unsafe {
        SetFileInformationByHandle(
            guard.0,
            FileDispositionInfo,
            &disposition as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err("REPAIR_EXTERNAL_CLEANUP_PENDING".to_string());
    }
    drop(guard);
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("REPAIR_EXTERNAL_CLEANUP_PENDING".to_string()),
    }
}

#[cfg(unix)]
fn capability_remove_transition_directory(
    _directory: &Path,
    _journal: &RepairTransitionJournal,
    _expected: TransitionFileIdentity,
) -> Result<(), String> {
    Err("REPAIR_TRANSITION_DURABILITY_UNSUPPORTED".to_string())
}

fn durable_remove_authenticated_transition_directory(
    directory: &Path,
    journal: &mut RepairTransitionJournal,
    already_finalizing: bool,
) -> Result<(), String> {
    if !safe_staging_directory_state(directory)? {
        latch_startup_maintenance_failure();
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let identity = transition_file_identity(directory)?;
    let persisted_identity = TransitionFileIdentity {
        primary: journal.directory_identity_primary.unwrap_or_default(),
        secondary: journal.directory_identity_secondary.unwrap_or_default(),
    };
    if identity.primary == 0 || identity.secondary == 0 || identity != persisted_identity {
        latch_startup_maintenance_failure();
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    validate_transition_marker(directory, journal)?;
    let parent = directory
        .parent()
        .ok_or_else(|| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?;
    let finalizing = transition_finalizing_path(parent, journal);
    if !already_finalizing {
        if fs::symlink_metadata(&finalizing).is_ok() {
            latch_startup_maintenance_failure();
            return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
        }
        journal.phase = RepairTransitionJournalPhase::Finalizing;
        persist_transition_journal(journal)?;
        durable_rename_no_replace(directory, &finalizing).map_err(|_| {
            latch_startup_maintenance_failure();
            "REPAIR_EXTERNAL_CLEANUP_PENDING".to_string()
        })?;
        if transition_file_identity(&finalizing)? != identity {
            let _ = durable_rename(&finalizing, directory);
            latch_startup_maintenance_failure();
            return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
        }
    } else if directory != finalizing || transition_file_identity(&finalizing)? != identity {
        latch_startup_maintenance_failure();
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    if !safe_staging_directory_state(&finalizing).unwrap_or(false)
        || validate_transition_marker(&finalizing, journal).is_err()
        || transition_file_identity(&finalizing).ok() != Some(identity)
    {
        latch_startup_maintenance_failure();
        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
    }
    let completion = transition_completion_path(parent, journal);
    if fs::symlink_metadata(&completion).is_err() {
        create_completion_sentinel(parent, journal)?;
    } else {
        validate_authenticated_transition_file(&completion, journal)?;
    }
    capability_remove_transition_directory(&finalizing, journal, identity).inspect_err(|_| {
        latch_startup_maintenance_failure();
    })?;
    sync_directory_metadata(parent).map_err(|_| {
        latch_startup_maintenance_failure();
        "REPAIR_TRANSITION_DURABILITY_FAILED".to_string()
    })?;
    journal.phase = RepairTransitionJournalPhase::FilesFinalized;
    persist_transition_journal(journal)
}

fn sqlite_runtime_identity(connection: &Connection) -> Result<(String, String, String), String> {
    let read = |key| {
        crate::db::get_setting(connection, "terminal", key)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "REPAIR_NATIVE_SCOPE_REQUIRED".to_string())
    };
    Ok((
        read("organization_id")?,
        read("branch_id")?,
        read("terminal_id")?,
    ))
}

pub(crate) fn recover_interrupted_scope_transition(connection: &Connection) -> Result<(), String> {
    let Some(encoded) = crate::storage::read_repair_transition_journal()? else {
        return Ok(());
    };
    let mut journal: RepairTransitionJournal = serde_json::from_str(&encoded)
        .map_err(|_| "REPAIR_TRANSITION_JOURNAL_INVALID".to_string())?;
    if journal.version != 3
        || canonical_uuid(&journal.target_organization_id).as_deref()
            != Some(journal.target_organization_id.as_str())
        || canonical_uuid(&journal.target_branch_id).as_deref()
            != Some(journal.target_branch_id.as_str())
        || !validate_terminal_id(&journal.target_terminal_id)
        || validate_scope(&journal.old_scope).is_err()
        || validate_scope(&journal.target_scope).is_err()
        || !scope_matches_identity(
            &journal.target_scope,
            &journal.target_organization_id,
            &journal.target_branch_id,
            &journal.target_terminal_id,
        )
        || journal.target_scope.scope_epoch != journal.old_scope.scope_epoch.saturating_add(1)
        || journal.target_scope.scope_epoch == 0
        || journal.target_scope.scope_epoch > MAX_SAFE_INTEGER
        || journal.target_scope.scope_token == journal.old_scope.scope_token
        || journal.target_scope.transition_pending != journal.enabled
        || journal.target_scope.reset_pending
        || journal.target_scope.offline_terminal_token.is_some()
        || journal.target_scope.offline_sequence_lease_start.is_some()
        || journal.target_scope.offline_sequence_lease_end.is_some()
        || journal.target_scope.settings_cache.is_some()
        || canonical_uuid(&journal.transition_nonce).as_deref()
            != Some(journal.transition_nonce.as_str())
        || (journal.directory_staged
            && matches!(journal.phase, RepairTransitionJournalPhase::Intent))
        || (journal.directory_staged
            && (journal.directory_identity_primary.unwrap_or_default() == 0
                || journal.directory_identity_secondary.unwrap_or_default() == 0))
    {
        latch_startup_maintenance_failure();
        return Err("REPAIR_TRANSITION_JOURNAL_INVALID".to_string());
    }
    let original = scope_staging_dir(connection, &journal.old_scope)?;
    let staged = staging_root(connection)?.join(format!(
        ".scope-cleanup-v3-{}",
        journal.old_scope.scope_token
    ));
    let finalizing = transition_finalizing_path(&staging_root(connection)?, &journal);
    let sqlite_identity = sqlite_runtime_identity(connection)?;
    let old_committed = scope_matches_identity(
        &journal.old_scope,
        &sqlite_identity.0,
        &sqlite_identity.1,
        &sqlite_identity.2,
    );
    let target_committed = sqlite_identity
        == (
            journal.target_organization_id.clone(),
            journal.target_branch_id.clone(),
            journal.target_terminal_id.clone(),
        );
    let expected_directory_identity = journal.directory_staged.then(|| TransitionFileIdentity {
        primary: journal.directory_identity_primary.unwrap_or_default(),
        secondary: journal.directory_identity_secondary.unwrap_or_default(),
    });
    if old_committed
        && !matches!(
            journal.phase,
            RepairTransitionJournalPhase::DatabaseCommitted
                | RepairTransitionJournalPhase::Finalizing
                | RepairTransitionJournalPhase::FilesFinalized
                | RepairTransitionJournalPhase::TargetPublished
        )
    {
        let original_exists = safe_staging_directory_state(&original)?;
        let staged_exists = safe_staging_directory_state(&staged)?;
        if let Some(expected) = expected_directory_identity {
            for path in [&original, &staged] {
                if safe_staging_directory_state(path)?
                    && transition_file_identity(path)? != expected
                {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                }
            }
        }
        match journal.phase {
            RepairTransitionJournalPhase::Intent => {
                if journal.directory_staged || staged_exists {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                }
            }
            RepairTransitionJournalPhase::Prepared => {
                if !journal.directory_staged || !original_exists || staged_exists {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                }
                let marker = original.join(TRANSITION_MARKER_NAME);
                match fs::symlink_metadata(&marker) {
                    Ok(_) => {
                        validate_transition_marker(&original, &journal)?;
                        durable_remove_file(&marker).map_err(|_| {
                            latch_startup_maintenance_failure();
                            "REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string()
                        })?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                }
                remove_owned_transition_temp(&original, &journal).inspect_err(|_| {
                    latch_startup_maintenance_failure();
                })?;
            }
            RepairTransitionJournalPhase::MarkerWritten => {
                if !journal.directory_staged || original_exists == staged_exists {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                }
                journal.phase = RepairTransitionJournalPhase::FilesRestored;
                persist_transition_journal(&journal)?;
                if staged_exists {
                    validate_transition_marker(&staged, &journal)?;
                    durable_rename(&staged, &original).map_err(|_| {
                        latch_startup_maintenance_failure();
                        "REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string()
                    })?;
                } else {
                    validate_transition_marker(&original, &journal)?;
                }
            }
            RepairTransitionJournalPhase::FilesStaged => {
                if !journal.directory_staged {
                    if original_exists || staged_exists {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                    persist_scope(&journal.old_scope)?;
                    let _previous = crate::storage::replace_repair_identity_uncoordinated(
                        &journal.old_scope.organization_id,
                        &journal.old_scope.branch_id,
                        &journal.old_scope.terminal_id,
                    )?;
                    crate::storage::delete_repair_transition_journal().map_err(|_| {
                        latch_startup_maintenance_failure();
                        "REPAIR_TRANSITION_JOURNAL_DELETE_FAILED".to_string()
                    })?;
                    clear_maintenance_failure_after_destructive_recovery()?;
                    return Ok(());
                }
                if original_exists || !staged_exists {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                }
                journal.phase = RepairTransitionJournalPhase::FilesRestored;
                persist_transition_journal(&journal)?;
                validate_transition_marker(&staged, &journal)?;
                durable_rename(&staged, &original).map_err(|_| {
                    latch_startup_maintenance_failure();
                    "REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string()
                })?;
            }
            RepairTransitionJournalPhase::FilesRestored => {
                if !journal.directory_staged {
                    if original_exists || staged_exists {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                } else if staged_exists && !original_exists {
                    validate_transition_marker(&staged, &journal)?;
                    durable_rename(&staged, &original).map_err(|_| {
                        latch_startup_maintenance_failure();
                        "REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string()
                    })?;
                } else if original_exists && !staged_exists {
                    let marker = original.join(TRANSITION_MARKER_NAME);
                    if fs::symlink_metadata(&marker).is_ok() {
                        validate_transition_marker(&original, &journal)?;
                    }
                } else {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                }
            }
            RepairTransitionJournalPhase::DatabaseCommitted
            | RepairTransitionJournalPhase::Finalizing
            | RepairTransitionJournalPhase::FilesFinalized
            | RepairTransitionJournalPhase::TargetPublished => unreachable!(),
        }
        persist_scope(&journal.old_scope)?;
        let _previous = crate::storage::replace_repair_identity_uncoordinated(
            &journal.old_scope.organization_id,
            &journal.old_scope.branch_id,
            &journal.old_scope.terminal_id,
        )?;
        if journal.directory_staged {
            let marker = original.join(TRANSITION_MARKER_NAME);
            if fs::symlink_metadata(&marker).is_ok() {
                validate_transition_marker(&original, &journal)?;
                durable_remove_file(&marker).map_err(|_| {
                    latch_startup_maintenance_failure();
                    "REPAIR_EXTERNAL_CLEANUP_COMPENSATION_FAILED".to_string()
                })?;
            }
        }
        crate::storage::delete_repair_transition_journal().map_err(|_| {
            latch_startup_maintenance_failure();
            "REPAIR_TRANSITION_JOURNAL_DELETE_FAILED".to_string()
        })?;
        clear_maintenance_failure_after_destructive_recovery()?;
        return Ok(());
    }
    if target_committed {
        verified_delete_repair_credentials()?;
        let root = staging_root(connection)?;
        let completion = transition_completion_path(&root, &journal);
        if journal.directory_staged {
            let staged_exists = safe_staging_directory_state(&staged)?;
            let finalizing_exists = safe_staging_directory_state(&finalizing)?;
            let expected = expected_directory_identity
                .ok_or_else(|| "REPAIR_TRANSITION_JOURNAL_INVALID".to_string())?;
            for path in [&staged, &finalizing] {
                if safe_staging_directory_state(path)?
                    && transition_file_identity(path)? != expected
                {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                }
            }
            match journal.phase {
                RepairTransitionJournalPhase::FilesStaged => {
                    if !staged_exists || finalizing_exists {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                    match fs::symlink_metadata(&completion) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        _ => {
                            latch_startup_maintenance_failure();
                            return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                        }
                    }
                    validate_transition_marker(&staged, &journal)?;
                    journal.phase = RepairTransitionJournalPhase::DatabaseCommitted;
                    persist_transition_journal(&journal)?;
                    durable_remove_authenticated_transition_directory(
                        &staged,
                        &mut journal,
                        false,
                    )?;
                }
                RepairTransitionJournalPhase::DatabaseCommitted => {
                    if !staged_exists
                        || finalizing_exists
                        || fs::symlink_metadata(&completion).is_ok()
                    {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                    durable_remove_authenticated_transition_directory(
                        &staged,
                        &mut journal,
                        false,
                    )?;
                }
                RepairTransitionJournalPhase::Finalizing => {
                    if staged_exists && !finalizing_exists {
                        durable_remove_authenticated_transition_directory(
                            &staged,
                            &mut journal,
                            false,
                        )?;
                    } else if finalizing_exists && !staged_exists {
                        durable_remove_authenticated_transition_directory(
                            &finalizing,
                            &mut journal,
                            true,
                        )?;
                    } else if !staged_exists && !finalizing_exists {
                        validate_authenticated_transition_file(&completion, &journal)?;
                        journal.phase = RepairTransitionJournalPhase::FilesFinalized;
                        persist_transition_journal(&journal)?;
                    } else {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                }
                RepairTransitionJournalPhase::FilesFinalized => {
                    if staged_exists || finalizing_exists {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                    validate_authenticated_transition_file(&completion, &journal)?;
                }
                RepairTransitionJournalPhase::TargetPublished => {
                    if staged_exists || finalizing_exists {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
                    }
                    if fs::symlink_metadata(&completion).is_ok() {
                        validate_authenticated_transition_file(&completion, &journal)?;
                    }
                }
                _ => {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_TRANSITION_JOURNAL_IDENTITY_MISMATCH".to_string());
                }
            }
        } else if safe_staging_directory_state(&staged)?
            || safe_staging_directory_state(&finalizing)?
        {
            latch_startup_maintenance_failure();
            return Err("REPAIR_TRANSITION_MARKER_INVALID".to_string());
        }
        persist_scope(&journal.target_scope)?;
        journal.phase = RepairTransitionJournalPhase::TargetPublished;
        persist_transition_journal(&journal)?;
        if fs::symlink_metadata(&completion).is_ok() {
            validate_authenticated_transition_file(&completion, &journal)?;
            durable_remove_file(&completion).map_err(|_| {
                latch_startup_maintenance_failure();
                "REPAIR_EXTERNAL_CLEANUP_PENDING".to_string()
            })?;
        }
        crate::storage::delete_repair_transition_journal().map_err(|_| {
            latch_startup_maintenance_failure();
            "REPAIR_TRANSITION_JOURNAL_DELETE_FAILED".to_string()
        })?;
        clear_maintenance_failure_after_destructive_recovery()?;
        return Ok(());
    }
    latch_startup_maintenance_failure();
    Err("REPAIR_TRANSITION_JOURNAL_IDENTITY_MISMATCH".to_string())
}

/// Apply one authenticated `/api/pos/modules/enabled` decision. Enabled access
/// remains durably pending until the server-issued offline lease is persisted;
/// module removal performs a hard repair-only purge and publishes a fresh
/// disabled scope immediately.
pub(crate) fn begin_authoritative_access_reconciliation(
    db: &crate::db::DbState,
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
    enabled: bool,
    decision: RepairAccessDecision,
) -> Result<RepairAccessReconciliation, String> {
    if canonical_uuid(organization_id).as_deref() != Some(organization_id)
        || canonical_uuid(branch_id).as_deref() != Some(branch_id)
        || !validate_terminal_id(terminal_id)
    {
        return Err("REPAIR_AUTHORITATIVE_IDENTITY_INVALID".to_string());
    }

    let _transition = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    if crate::storage::read_repair_transition_journal()?.is_some() {
        latch_startup_maintenance_failure();
        return Err("REPAIR_EXTERNAL_CLEANUP_PENDING".to_string());
    }
    let mut prior = load_scope_raw()?;
    let identity_changed = prior.as_ref().map_or(true, |scope| {
        !scope_matches_identity(scope, organization_id, branch_id, terminal_id)
    });
    #[cfg(unix)]
    if identity_changed {
        if let Some(scope) = prior.as_ref() {
            let connection = db
                .conn
                .lock()
                .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
            let directory = scope_staging_dir(&connection, scope)?;
            match fs::symlink_metadata(&directory) {
                Ok(metadata)
                    if metadata.is_dir()
                        && !metadata.file_type().is_symlink()
                        && !metadata_is_reparse_point(&metadata) =>
                {
                    return Err("REPAIR_TRANSITION_DURABILITY_UNSUPPORTED".to_string());
                }
                Ok(_) => return Err("REPAIR_STAGING_PATH_UNSAFE".to_string()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("REPAIR_STAGING_PATH_UNSAFE".to_string()),
            }
        }
    }
    let mut transition_journal = if identity_changed {
        prior
            .as_ref()
            .map(|scope| {
                let next_epoch = scope.scope_epoch.saturating_add(1);
                if next_epoch == 0 || next_epoch > MAX_SAFE_INTEGER {
                    return Err("REPAIR_SCOPE_EPOCH_EXHAUSTED".to_string());
                }
                let mut target_scope = new_scope(
                    organization_id.to_string(),
                    branch_id.to_string(),
                    terminal_id.to_string(),
                    next_epoch,
                );
                target_scope.transition_pending = enabled;
                Ok(RepairTransitionJournal {
                    version: 3,
                    old_scope: scope.clone(),
                    target_scope,
                    transition_nonce: Uuid::new_v4().to_string(),
                    directory_staged: false,
                    directory_identity_primary: None,
                    directory_identity_secondary: None,
                    target_organization_id: organization_id.to_string(),
                    target_branch_id: branch_id.to_string(),
                    target_terminal_id: terminal_id.to_string(),
                    decision_generation: decision.generation,
                    enabled,
                    phase: RepairTransitionJournalPhase::Intent,
                })
            })
            .transpose()?
    } else {
        None
    };
    if let Some(journal) = transition_journal.as_ref() {
        persist_transition_journal(journal)?;
        transition_fault("after_journal_prepared")?;
    }
    // Lock order invariant: transition -> lifecycle barrier/drain -> SQLite.
    // Native transports hold a lifecycle lease and may then need SQLite, so a
    // reconciliation must never own SQLite while waiting for those leases.
    block_access_reconciliation(prior.as_mut(), decision)?;
    let connection = db
        .conn
        .lock()
        .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
    if identity_changed {
        let external_cleanup = transition_journal
            .as_mut()
            .map(|journal| prepare_external_cleanup(&connection, journal))
            .transpose()?;
        if let Some(journal) = transition_journal.as_mut() {
            journal.phase = RepairTransitionJournalPhase::FilesStaged;
            persist_transition_journal(journal)?;
        }
        if let Err(error) =
            purge_and_persist_runtime_identity(&connection, organization_id, branch_id, terminal_id)
        {
            if error == "REPAIR_IDENTITY_COMPENSATION_FAILED" {
                if let Some(journal) = transition_journal.as_ref() {
                    if persist_scope(&journal.old_scope).is_err() {
                        latch_startup_maintenance_failure();
                        return Err("REPAIR_IDENTITY_COMPENSATION_FAILED".to_string());
                    }
                }
                latch_startup_maintenance_failure();
                return Err("REPAIR_IDENTITY_COMPENSATION_FAILED".to_string());
            }
            if let Some(cleanup) = external_cleanup.as_ref() {
                let journal = transition_journal
                    .as_mut()
                    .ok_or_else(|| "REPAIR_TRANSITION_JOURNAL_INVALID".to_string())?;
                rollback_external_cleanup(cleanup, journal)?;
            }
            if let Some(journal) = transition_journal.as_ref() {
                persist_scope(&journal.old_scope)?;
                if runtime_scope_identity_from_keyring()?
                    != (
                        journal.old_scope.organization_id.clone(),
                        journal.old_scope.branch_id.clone(),
                        journal.old_scope.terminal_id.clone(),
                    )
                {
                    latch_startup_maintenance_failure();
                    return Err("REPAIR_IDENTITY_COMPENSATION_FAILED".to_string());
                }
                if journal.directory_staged {
                    let marker = external_cleanup
                        .as_ref()
                        .ok_or_else(|| "REPAIR_TRANSITION_JOURNAL_INVALID".to_string())?
                        .original_directory
                        .join(TRANSITION_MARKER_NAME);
                    validate_transition_marker(
                        marker
                            .parent()
                            .ok_or_else(|| "REPAIR_TRANSITION_MARKER_INVALID".to_string())?,
                        journal,
                    )?;
                    durable_remove_file(&marker)?;
                }
                crate::storage::delete_repair_transition_journal()?;
            }
            return Err(error);
        }
        if let Some(journal) = transition_journal.as_mut() {
            transition_fault("after_database_commit")?;
            journal.phase = RepairTransitionJournalPhase::DatabaseCommitted;
            persist_transition_journal(journal)?;
        }
        verified_delete_repair_credentials()?;
        if let Some(cleanup) = external_cleanup.as_ref() {
            let journal = transition_journal
                .as_mut()
                .ok_or_else(|| "REPAIR_TRANSITION_JOURNAL_INVALID".to_string())?;
            finalize_external_cleanup(cleanup, journal)?;
        }
    } else if !enabled {
        purge_repair_rows(&connection)?;
        if let Some(scope) = prior.as_ref() {
            delete_scope_files(&connection, scope)?;
        }
        verified_delete_repair_credentials()?;
        persist_runtime_identity(&connection, organization_id, branch_id, terminal_id)?;
    } else {
        persist_runtime_identity(&connection, organization_id, branch_id, terminal_id)?;
    }

    let next_epoch = if identity_changed || !enabled {
        prior
            .as_ref()
            .map(|scope| scope.scope_epoch.saturating_add(1))
            .unwrap_or(1)
    } else {
        prior.as_ref().map(|scope| scope.scope_epoch).unwrap_or(1)
    };
    if next_epoch == 0 || next_epoch > MAX_SAFE_INTEGER {
        return Err("REPAIR_SCOPE_EPOCH_EXHAUSTED".to_string());
    }
    let mut candidate = if identity_changed {
        transition_journal
            .as_ref()
            .map(|journal| journal.target_scope.clone())
            .unwrap_or_else(|| {
                new_scope(
                    organization_id.to_string(),
                    branch_id.to_string(),
                    terminal_id.to_string(),
                    next_epoch,
                )
            })
    } else if !enabled {
        new_scope(
            organization_id.to_string(),
            branch_id.to_string(),
            terminal_id.to_string(),
            next_epoch,
        )
    } else {
        prior
            .take()
            .ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?
    };
    candidate.offline_terminal_token = None;
    candidate.offline_sequence_lease_start = None;
    candidate.offline_sequence_lease_end = None;
    candidate.transition_pending = enabled;
    candidate.reset_pending = false;
    persist_scope(&candidate)?;

    if let Some(journal) = transition_journal.as_mut() {
        journal.phase = RepairTransitionJournalPhase::TargetPublished;
        persist_transition_journal(journal)?;
        let completion = transition_completion_path(&staging_root(&connection)?, journal);
        if fs::symlink_metadata(&completion).is_ok() {
            validate_authenticated_transition_file(&completion, journal)?;
            durable_remove_file(&completion).map_err(|_| {
                latch_startup_maintenance_failure();
                "REPAIR_EXTERNAL_CLEANUP_PENDING".to_string()
            })?;
        }
        transition_fault("after_candidate_scope")?;
        transition_fault("before_journal_delete")?;
        crate::storage::delete_repair_transition_journal().map_err(|_| {
            latch_startup_maintenance_failure();
            "REPAIR_TRANSITION_JOURNAL_DELETE_FAILED".to_string()
        })?;
    }

    let outcome = RepairAccessReconciliation {
        organization_id: organization_id.to_string(),
        branch_id: branch_id.to_string(),
        terminal_id: terminal_id.to_string(),
        scope_token: candidate.scope_token.clone(),
        scope_epoch: candidate.scope_epoch,
        disabled: !enabled,
        identity_changed,
        access_decision_generation: decision.generation,
    };
    if enabled {
        persist_entitlement_for_scope(&candidate, true)?;
    } else {
        clear_maintenance_failure_after_destructive_recovery()?;
        unblock_at_epoch_for_decision(candidate.scope_epoch, decision)?;
    }
    Ok(outcome)
}

pub(crate) fn finalize_authoritative_offline_access(
    db: &crate::db::DbState,
    pending: &RepairAccessReconciliation,
    numbering_lease: &crate::repair_transport::RepairNumberingLease,
) -> Result<(), String> {
    if pending.disabled {
        return Err("REPAIR_MODULE_REQUIRED".to_string());
    }
    let _transition = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    let decision = RepairAccessDecision {
        generation: pending.access_decision_generation,
    };
    {
        let state = lifecycle()
            .0
            .lock()
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
        require_current_access_decision(&state, decision)?;
        if !state.blocked {
            return Err("REPAIR_SCOPE_TRANSITION_NOT_ARMED".to_string());
        }
    }
    let mut scope = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_REQUIRED".to_string())?;
    let runtime = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        runtime_scope_identity(&connection)?
    };
    if !scope.transition_pending
        || scope.reset_pending
        || scope.scope_token != pending.scope_token
        || scope.scope_epoch != pending.scope_epoch
        || !scope_matches_identity(
            &scope,
            &pending.organization_id,
            &pending.branch_id,
            &pending.terminal_id,
        )
        || runtime
            != (
                pending.organization_id.clone(),
                pending.branch_id.clone(),
                pending.terminal_id.clone(),
            )
    {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    require_entitlement(&scope)?;
    if let Some((token, start, end)) = numbering_lease.as_sequence() {
        scope.offline_terminal_token = Some(token.to_string());
        scope.offline_sequence_lease_start = Some(start);
        scope.offline_sequence_lease_end = Some(end);
    } else {
        scope.offline_terminal_token = None;
        scope.offline_sequence_lease_start = None;
        scope.offline_sequence_lease_end = None;
    }
    scope.transition_pending = false;
    validate_scope(&scope).map_err(|_| "REPAIR_OFFLINE_BOOTSTRAP_INVALID".to_string())?;
    persist_scope(&scope)?;
    unblock_at_epoch_for_decision(scope.scope_epoch, decision)
}

pub(crate) fn latch_startup_access_pending() -> Result<RepairAccessDecision, String> {
    let _transition = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    let decision = next_access_decision(&mut state)?;
    state.blocked = true;
    condition.notify_all();
    Ok(decision)
}

pub(crate) fn retain_verified_access_after_network_failure(
    db: &crate::db::DbState,
    decision: RepairAccessDecision,
) -> Result<(), String> {
    let _transition = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    // Drain active native operations before SQLite is acquired. This keeps
    // the same global lock order as authoritative enable/revoke processing.
    block_access_decision_in_memory(decision)?;
    let scope = active_scope()?;
    let runtime = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        runtime_scope_identity(&connection)?
    };
    if !scope_matches_identity(&scope, &runtime.0, &runtime.1, &runtime.2) {
        return Err("REPAIR_OFFLINE_ACCESS_UNAVAILABLE".to_string());
    }
    require_entitlement(&scope)?;
    crate::repair_transport::authorize_any_repair_actor_for_scope(
        &crate::repair_transport::NativeRepairScope {
            organization_id: scope.organization_id.clone(),
            branch_id: scope.branch_id.clone(),
            terminal_id: scope.terminal_id.clone(),
        },
    )
    .map_err(|_| "REPAIR_OFFLINE_ACCESS_UNAVAILABLE".to_string())?;
    unblock_at_epoch_for_decision(scope.scope_epoch, decision)
}

fn staging_root(connection: &Connection) -> Result<PathBuf, String> {
    let db_path: String = connection
        .query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "REPAIR_STAGING_PATH_UNAVAILABLE".to_string())?;
    let parent = Path::new(&db_path)
        .parent()
        .ok_or_else(|| "REPAIR_STAGING_PATH_UNAVAILABLE".to_string())?;
    Ok(parent.join("repair-staging-v1"))
}

fn scope_staging_dir(connection: &Connection, scope: &RepairScopeState) -> Result<PathBuf, String> {
    Ok(staging_root(connection)?.join(&scope.scope_token))
}

fn purge_repair_rows_inner(
    connection: &Connection,
    include_operational_financial_rows: bool,
) -> Result<(), String> {
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|_| "REPAIR_SCOPE_PURGE_FAILED".to_string())?;
    if let Err(error) =
        purge_repair_rows_in_transaction(&transaction, include_operational_financial_rows)
    {
        let _ = transaction.rollback();
        return Err(error);
    }
    transaction
        .commit()
        .map_err(|_| "REPAIR_SCOPE_PURGE_FAILED".to_string())
}

fn purge_repair_rows_in_transaction(
    connection: &Connection,
    include_operational_financial_rows: bool,
) -> Result<(), String> {
    crate::sync_queue::purge_repair_owned_sync_state(
        connection,
        include_operational_financial_rows,
    )?;
    connection
        .execute_batch(
            "DELETE FROM repair_conflicts;
         DELETE FROM repair_attachment_staging;
         DELETE FROM repair_alias_cache;
         DELETE FROM repair_cache;",
        )
        .map_err(|_| "REPAIR_SCOPE_PURGE_FAILED".to_string())
}

fn purge_repair_rows(connection: &Connection) -> Result<(), String> {
    purge_repair_rows_inner(connection, false)
}

fn purge_repair_operational_rows(connection: &Connection) -> Result<(), String> {
    purge_repair_rows_inner(connection, true)
}

fn block_and_wait(mut scope: Option<&mut RepairScopeState>, reset: bool) -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    state.blocked = true;
    state.reset_latched |= reset;
    if let Some(scope) = scope.as_mut() {
        if !scope.transition_pending || (reset && !scope.reset_pending) {
            scope.transition_pending = true;
            scope.reset_pending |= reset;
            scope.scope_epoch = scope
                .scope_epoch
                .checked_add(1)
                .filter(|epoch| *epoch <= MAX_SAFE_INTEGER)
                .ok_or_else(|| "REPAIR_SCOPE_EPOCH_EXHAUSTED".to_string())?;
            persist_scope(scope)?;
        }
        // Startup lifecycle memory begins at epoch zero. Rehydrate it from
        // the checked durable pending scope instead of advancing an unrelated
        // process-local generation.
        state.epoch = scope.scope_epoch;
    } else {
        state.epoch = state
            .epoch
            .checked_add(1)
            .filter(|epoch| *epoch <= MAX_SAFE_INTEGER)
            .ok_or_else(|| "REPAIR_SCOPE_EPOCH_EXHAUSTED".to_string())?;
    }
    while state.active_readers > 0 {
        state = condition
            .wait(state)
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    }
    Ok(())
}

fn unblock_at_epoch(epoch: u64) -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if state.maintenance_failed {
        return Err("REPAIR_STAGING_MAINTENANCE_FAILED".to_string());
    }
    state.blocked = false;
    state.epoch = epoch;
    condition.notify_all();
    Ok(())
}

fn unblock_at_epoch_for_decision(epoch: u64, decision: RepairAccessDecision) -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    require_current_access_decision(&state, decision)?;
    if state.reset_latched {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if state.maintenance_failed {
        return Err("REPAIR_STAGING_MAINTENANCE_FAILED".to_string());
    }
    state.blocked = false;
    state.epoch = epoch;
    condition.notify_all();
    Ok(())
}

fn unblock_without_scope() -> Result<(), String> {
    let (mutex, condition) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.reset_latched {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if state.maintenance_failed {
        return Err("REPAIR_STAGING_MAINTENANCE_FAILED".to_string());
    }
    state.blocked = false;
    condition.notify_all();
    Ok(())
}

fn clear_maintenance_failure_after_destructive_recovery() -> Result<(), String> {
    let (mutex, _) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    state.maintenance_failed = false;
    Ok(())
}

fn delete_scope_files(connection: &Connection, scope: &RepairScopeState) -> Result<(), String> {
    let directory = scope_staging_dir(connection, scope)?;
    if directory.exists() {
        fs::remove_dir_all(directory).map_err(|_| "REPAIR_STAGING_PURGE_FAILED".to_string())?;
    }
    crate::repair_attachment_cache::purge_scope(&scope.scope_token)
}

/// Complete any pending scope rebind after the caller has atomically settled
/// the generic terminal credentials. Old repair rows/files/key/entitlement
/// are removed before a fresh opaque scope is published.
#[cfg(test)]
pub(crate) fn complete_scope_transition(
    connection: &Connection,
    _guard: &RepairTransitionGuard,
) -> Result<(), String> {
    if lifecycle()
        .0
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?
        .reset_latched
    {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    let identity = runtime_scope_identity(connection)?;
    let mut prior = load_scope_raw()?;
    if let Some(scope) = prior.as_mut() {
        if scope.reset_pending {
            return Err("REPAIR_RESET_PENDING".to_string());
        }
        if scope_matches_identity(scope, &identity.0, &identity.1, &identity.2)
            && !scope.transition_pending
        {
            return Ok(());
        }
        if !scope.transition_pending {
            return Err("REPAIR_SCOPE_TRANSITION_NOT_ARMED".to_string());
        }
    }

    purge_repair_rows(connection)?;
    if let Some(scope) = prior.as_ref() {
        delete_scope_files(connection, scope)?;
    }
    crate::storage::delete_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)
        .map_err(|_| "REPAIR_AES_KEY_DELETE_FAILED".to_string())?;
    crate::storage::delete_credential(crate::storage::KEY_REPAIR_ENTITLEMENT_V1)
        .map_err(|_| "REPAIR_ENTITLEMENT_DELETE_FAILED".to_string())?;
    let next_epoch = prior
        .as_ref()
        .map(|scope| scope.scope_epoch.saturating_add(1))
        .unwrap_or(1);
    let scope = new_scope(identity.0, identity.1, identity.2, next_epoch);
    persist_scope(&scope)?;
    clear_maintenance_failure_after_destructive_recovery()?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn arm_scope_transition() -> Result<RepairTransitionGuard, String> {
    let guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    let mut scope = load_scope_raw()?;
    if lifecycle()
        .0
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?
        .reset_latched
    {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if scope.as_ref().is_some_and(|value| value.reset_pending) {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    let needs_transition = match scope.as_ref() {
        None => false,
        Some(scope) if scope.transition_pending => true,
        Some(scope) => runtime_scope_identity_from_keyring()
            .map(|identity| !scope_matches_identity(scope, &identity.0, &identity.1, &identity.2))
            .unwrap_or(true),
    };
    if needs_transition {
        block_and_wait(scope.as_mut(), false)?;
    } else {
        let (mutex, condition) = lifecycle();
        let mut state = mutex
            .lock()
            .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
        state.blocked = true;
        while state.active_readers > 0 {
            state = condition
                .wait(state)
                .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
        }
    }
    Ok(RepairTransitionGuard {
        _guard: guard,
        unconfigured: false,
    })
}

pub(crate) fn arm_operational_clear() -> Result<RepairTransitionGuard, String> {
    let guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    let mut scope = load_scope_raw()?;
    if lifecycle()
        .0
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?
        .reset_latched
        || scope.as_ref().is_some_and(|value| value.reset_pending)
    {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if scope.is_none() && runtime_scope_identity_from_keyring().is_err() {
        return Ok(RepairTransitionGuard {
            _guard: guard,
            unconfigured: true,
        });
    }
    block_and_wait(scope.as_mut(), false)?;
    Ok(RepairTransitionGuard {
        _guard: guard,
        unconfigured: false,
    })
}

pub(crate) fn complete_operational_clear(
    connection: &Connection,
    guard: &RepairTransitionGuard,
) -> Result<(), String> {
    if guard.unconfigured {
        return Ok(());
    }
    let scope = load_scope_raw()?;
    if scope.as_ref().is_some_and(|value| value.reset_pending) {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    if scope
        .as_ref()
        .is_some_and(|value| !value.transition_pending)
    {
        return Err("REPAIR_SCOPE_TRANSITION_NOT_ARMED".to_string());
    }
    purge_repair_operational_rows(connection)?;
    if let Some(scope) = scope.as_ref() {
        delete_scope_files(connection, scope)?;
    }
    verified_delete_repair_credentials()?;

    Ok(())
}

pub(crate) fn finish_operational_clear(
    connection: &Connection,
    guard: &RepairTransitionGuard,
) -> Result<(), String> {
    let mut publication = prepare_operational_clear_publication(connection, guard)?;
    activate_operational_clear_publication(&mut publication)?;
    if let Err(error) = finish_operational_clear_publication(&publication) {
        let _ = reblock_operational_clear_publication(&mut publication);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn prepare_operational_clear_publication(
    connection: &Connection,
    guard: &RepairTransitionGuard,
) -> Result<OperationalClearPublication, String> {
    if guard.unconfigured {
        return Ok(OperationalClearPublication {
            replacement: None,
            unconfigured: true,
        });
    }
    let prior = load_scope_raw()?;
    if prior.as_ref().is_some_and(|value| value.reset_pending) {
        return Err("REPAIR_RESET_PENDING".to_string());
    }
    let (organization_id, branch_id, terminal_id) = match runtime_scope_identity(connection) {
        Ok(identity) => identity,
        Err(_) => {
            crate::storage::delete_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .map_err(|_| "REPAIR_SCOPE_DELETE_FAILED".to_string())?;
            return Ok(OperationalClearPublication {
                replacement: None,
                unconfigured: false,
            });
        }
    };
    let epoch = prior
        .as_ref()
        .map(|value| value.scope_epoch.saturating_add(1))
        .unwrap_or(1);
    let mut replacement = new_scope(organization_id, branch_id, terminal_id, epoch);
    replacement.transition_pending = true;
    persist_scope(&replacement)?;
    Ok(OperationalClearPublication {
        replacement: Some(replacement),
        unconfigured: false,
    })
}

pub(crate) fn activate_operational_clear_publication(
    publication: &mut OperationalClearPublication,
) -> Result<(), String> {
    let Some(replacement) = publication.replacement.as_mut() else {
        return Ok(());
    };
    replacement.transition_pending = false;
    persist_scope(replacement)
}

pub(crate) fn reblock_operational_clear_publication(
    publication: &mut OperationalClearPublication,
) -> Result<(), String> {
    let Some(replacement) = publication.replacement.as_mut() else {
        return Ok(());
    };
    replacement.transition_pending = true;
    persist_scope(replacement)
}

pub(crate) fn finish_operational_clear_publication(
    publication: &OperationalClearPublication,
) -> Result<(), String> {
    clear_maintenance_failure_after_destructive_recovery()?;
    match publication.replacement.as_ref() {
        Some(replacement) => unblock_at_epoch(replacement.scope_epoch),
        None if publication.unconfigured => unblock_without_scope(),
        None => unblock_without_scope(),
    }
}

pub(crate) fn operational_clear_transition_pending() -> Result<bool, String> {
    Ok(load_scope_raw()?.is_some_and(|scope| scope.transition_pending))
}

/// Factory/emergency-reset preflight. On success the barrier deliberately
/// remains both durable and process-global until the asynchronous reset helper
/// terminates the process.
pub(crate) fn arm_process_reset() -> Result<RepairTransitionGuard, String> {
    let guard = transition_mutex()
        .lock()
        .map_err(|_| "REPAIR_SCOPE_TRANSITION_UNAVAILABLE".to_string())?;
    let mut scope = load_scope_raw()?;
    block_and_wait(scope.as_mut(), true)?;
    Ok(RepairTransitionGuard {
        _guard: guard,
        unconfigured: false,
    })
}

#[cfg(test)]
pub(crate) fn persist_verified_entitlement(
    connection: &Connection,
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
    enabled: bool,
    transition: &RepairTransitionGuard,
) -> Result<(), String> {
    let runtime = runtime_scope_identity(connection)?;
    if runtime
        != (
            organization_id.to_string(),
            branch_id.to_string(),
            terminal_id.to_string(),
        )
    {
        return Err("REPAIR_ENTITLEMENT_SCOPE_MISMATCH".to_string());
    }
    complete_scope_transition(connection, transition)?;
    let scope = active_scope()?;
    if !scope_matches_identity(&scope, organization_id, branch_id, terminal_id) {
        return Err("REPAIR_ENTITLEMENT_SCOPE_MISMATCH".to_string());
    }
    let entitlement = RepairEntitlementState {
        version: ENTITLEMENT_VERSION,
        organization_id: organization_id.to_string(),
        branch_id: branch_id.to_string(),
        terminal_id: terminal_id.to_string(),
        scope_epoch: scope.scope_epoch,
        enabled,
        verified_at: chrono::Utc::now().to_rfc3339(),
    };
    let serialized = Zeroizing::new(
        serde_json::to_string(&entitlement)
            .map_err(|_| "REPAIR_ENTITLEMENT_INVALID".to_string())?,
    );
    crate::storage::set_credential(crate::storage::KEY_REPAIR_ENTITLEMENT_V1, &serialized)
        .map_err(|_| "REPAIR_ENTITLEMENT_WRITE_FAILED".to_string())?;
    unblock_at_epoch(scope.scope_epoch)
}

fn require_entitlement(scope: &RepairScopeState) -> Result<(), String> {
    let raw = crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_ENTITLEMENT_V1)?
        .ok_or_else(|| "REPAIR_MODULE_REQUIRED".to_string())?;
    let entitlement: RepairEntitlementState =
        serde_json::from_str(&raw).map_err(|_| "REPAIR_ENTITLEMENT_INVALID".to_string())?;
    if entitlement.version != ENTITLEMENT_VERSION
        || !entitlement.enabled
        || entitlement.organization_id != scope.organization_id
        || entitlement.branch_id != scope.branch_id
        || entitlement.terminal_id != scope.terminal_id
        || entitlement.scope_epoch != scope.scope_epoch
    {
        return Err("REPAIR_MODULE_REQUIRED".to_string());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn persist_offline_bootstrap(
    connection: &Connection,
    response: &serde_json::Value,
    _transition: &RepairTransitionGuard,
) -> Result<(), String> {
    let mut scope = active_scope()?;
    require_entitlement(&scope)?;
    let runtime = runtime_scope_identity(connection)?;
    if !scope_matches_identity(&scope, &runtime.0, &runtime.1, &runtime.2) {
        return Err("REPAIR_NATIVE_SCOPE_MISMATCH".to_string());
    }
    let token = response
        .get("offline_terminal_token")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_INVALID".to_string())?;
    let start = response
        .get("offline_sequence_lease_start")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_INVALID".to_string())?;
    let end = response
        .get("offline_sequence_lease_end")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_INVALID".to_string())?;
    scope.offline_terminal_token = Some(token.to_string());
    scope.offline_sequence_lease_start = Some(start);
    scope.offline_sequence_lease_end = Some(end);
    validate_scope(&scope).map_err(|_| "REPAIR_OFFLINE_BOOTSTRAP_INVALID".to_string())?;
    persist_scope(&scope)?;
    unblock_at_epoch(scope.scope_epoch)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RepairOfflineCommand {
    CreateIntake {
        intake_mode: String,
        is_anonymous: bool,
        customer_id: Option<String>,
        customer_device_id: Option<String>,
        priority: String,
        currency: String,
        title: Option<String>,
        intake_notes: Option<String>,
        due_at: Option<String>,
        offline_alias: Option<String>,
        offline_sequence: Option<u64>,
    },
    AddNote {
        note: String,
        visibility: String,
    },
    AssignRepair {
        assigned_staff_id: Option<String>,
    },
    UpdateDiagnosis {
        diagnosis: Option<String>,
        draft: bool,
    },
    PlanLine {
        line_id: String,
        line_type: String,
        name_snapshot: String,
        sku_snapshot: Option<String>,
        description: Option<String>,
        quantity: String,
        unit_cost_snapshot: Option<String>,
        unit_price_snapshot: String,
        vat_rate_snapshot: String,
        retail_product_id: Option<String>,
        retail_variant_id: Option<String>,
        service_id: Option<String>,
        display_order: u64,
    },
    TransitionStatus {
        target_status: String,
        reason: Option<String>,
        remain_consumed: bool,
    },
}

fn required_permission_for_offline_command(command: &RepairOfflineCommand) -> &'static str {
    match command {
        RepairOfflineCommand::CreateIntake { .. } => "repairs.create",
        RepairOfflineCommand::AddNote { .. }
        | RepairOfflineCommand::AssignRepair { .. }
        | RepairOfflineCommand::UpdateDiagnosis { .. }
        | RepairOfflineCommand::PlanLine { .. }
        | RepairOfflineCommand::TransitionStatus { .. } => "repairs.update",
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairOfflineMutationInput {
    pub(crate) operation_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
    pub(crate) staff_session_id: String,
    pub(crate) occurred_at: String,
    pub(crate) command: RepairOfflineCommand,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairMutationSnapshot {
    pub(crate) scope_token: String,
    pub(crate) repair_id: String,
    pub(crate) display_number: String,
    pub(crate) status: String,
    pub(crate) optimistic_version: u64,
    pub(crate) queued_for_sync: bool,
    pub(crate) customer_notification_state: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairAttachmentStageInput {
    pub(crate) attachment_id: String,
    pub(crate) operation_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
    pub(crate) staff_session_id: String,
    pub(crate) occurred_at: String,
    pub(crate) attachment_type: String,
    pub(crate) filename: String,
    pub(crate) caption: Option<String>,
    pub(crate) mime_type: String,
    pub(crate) bytes: Vec<u8>,
}

impl Zeroize for RepairAttachmentStageInput {
    fn zeroize(&mut self) {
        self.attachment_id.zeroize();
        self.operation_id.zeroize();
        self.repair_id.zeroize();
        self.expected_version = 0;
        self.staff_session_id.zeroize();
        self.occurred_at.zeroize();
        self.attachment_type.zeroize();
        self.filename.zeroize();
        if let Some(caption) = self.caption.as_mut() {
            caption.zeroize();
        }
        self.caption = None;
        self.mime_type.zeroize();
        self.bytes.zeroize();
    }
}

impl Drop for RepairAttachmentStageInput {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepairAttachmentStageSnapshot {
    pub(crate) scope_token: String,
    pub(crate) repair_id: String,
    pub(crate) attachment_id: String,
    pub(crate) optimistic_version: u64,
    pub(crate) queued_for_sync: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachmentPrivateMetadata {
    attachment_id: String,
    operation_id: String,
    staff_session_id: String,
    expected_version: u64,
    occurred_at: String,
    attachment_type: String,
    filename: String,
    caption: Option<String>,
    mime_type: String,
    byte_size: u64,
    sha256_hex: String,
}

impl Drop for AttachmentPrivateMetadata {
    fn drop(&mut self) {
        self.attachment_id.zeroize();
        self.operation_id.zeroize();
        self.staff_session_id.zeroize();
        self.expected_version = 0;
        self.occurred_at.zeroize();
        self.attachment_type.zeroize();
        self.filename.zeroize();
        if let Some(caption) = self.caption.as_mut() {
            caption.zeroize();
        }
        self.caption = None;
        self.mime_type.zeroize();
        self.byte_size = 0;
        self.sha256_hex.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeCommandEnvelope {
    operation_id: String,
    repair_id: String,
    expected_version: u64,
    staff_session_id: String,
    command: String,
    payload: serde_json::Value,
    occurred_at: String,
}

fn zeroize_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(value) => value.zeroize(),
        serde_json::Value::Array(values) => values.iter_mut().for_each(zeroize_json),
        serde_json::Value::Object(values) => values.values_mut().for_each(zeroize_json),
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {}
    }
}

impl Drop for NativeCommandEnvelope {
    fn drop(&mut self) {
        self.operation_id.zeroize();
        self.repair_id.zeroize();
        self.expected_version = 0;
        self.staff_session_id.zeroize();
        self.command.zeroize();
        zeroize_json(&mut self.payload);
        self.occurred_at.zeroize();
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingWorkspace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    authoritative: Option<serde_json::Value>,
    operations: Vec<serde_json::Value>,
}

impl Drop for PendingWorkspace {
    fn drop(&mut self) {
        if let Some(authoritative) = self.authoritative.as_mut() {
            zeroize_json(authoritative);
        }
        self.authoritative = None;
        self.operations.iter_mut().for_each(zeroize_json);
        self.operations.clear();
    }
}

/// Renderer-safe access lease. The opaque token is the only scope material
/// that may cross the typed repair IPC boundary; tenant identity and the
/// monotonic scope epoch remain native-owned.
pub(crate) struct RepairRendererAccess {
    scope_token: String,
    scope_epoch: u64,
    actor: crate::repair_transport::ValidatedRepairSession,
    _lease: RepairLifecycleLease,
}

impl RepairRendererAccess {
    pub(crate) fn scope_token(&self) -> &str {
        &self.scope_token
    }

    fn scope_epoch(&self) -> u64 {
        self.scope_epoch
    }
}

pub(crate) fn acquire_renderer_access(
    connection: &Connection,
) -> Result<RepairRendererAccess, String> {
    let scope = active_scope()?;
    require_entitlement(&scope)?;
    let runtime = runtime_scope_identity(connection)?;
    if !scope_matches_identity(&scope, &runtime.0, &runtime.1, &runtime.2) {
        return Err("REPAIR_NATIVE_SCOPE_MISMATCH".to_string());
    }
    let actor = crate::repair_transport::authorize_any_repair_actor_for_scope(
        &crate::repair_transport::NativeRepairScope {
            organization_id: scope.organization_id.clone(),
            branch_id: scope.branch_id.clone(),
            terminal_id: scope.terminal_id.clone(),
        },
    )
    .map_err(|error| error.code().to_string())?;
    let lease = acquire_lifecycle_lease(&scope)?;
    Ok(RepairRendererAccess {
        scope_token: scope.scope_token,
        scope_epoch: scope.scope_epoch,
        actor,
        _lease: lease,
    })
}

pub(crate) fn validate_renderer_staff_session(
    connection: &Connection,
    access: &RepairRendererAccess,
    staff_session_id: &str,
    required_permission: &str,
) -> Result<(), String> {
    let scope = renderer_scope(connection, access)?;
    if canonical_uuid(staff_session_id).as_deref() != Some(access.actor.staff_session_id())
        || access.actor.organization_id() != scope.organization_id
        || access.actor.branch_id() != scope.branch_id
        || access.actor.terminal_id() != scope.terminal_id
    {
        return Err("REPAIR_ACTOR_MISMATCH".to_string());
    }
    if !access.actor.has_permission(required_permission) {
        return Err("REPAIR_PERMISSION_DENIED".to_string());
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepairCachedListRow {
    pub(crate) repair_id: String,
    pub(crate) display_number: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) status: String,
    pub(crate) priority: String,
    pub(crate) intake_mode: String,
    pub(crate) safe_device_label: Option<String>,
    pub(crate) due_at: Option<String>,
    pub(crate) ready_at: Option<String>,
    pub(crate) authoritative_version: u64,
    pub(crate) optimistic_version: u64,
    pub(crate) dirty: bool,
    pub(crate) has_conflict: bool,
    pub(crate) needs_refetch: bool,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

pub(crate) struct RepairCachedWorkspace {
    pub(crate) row: RepairCachedListRow,
    pub(crate) authoritative: Option<serde_json::Value>,
    pub(crate) pending_operations: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepairConflictRecord {
    pub(crate) conflict_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
    pub(crate) current_version: u64,
    pub(crate) display_number: Option<String>,
    pub(crate) status: String,
    pub(crate) updated_at: String,
    pub(crate) allowed_transitions: Vec<String>,
    pub(crate) created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepairConflictResolutionResult {
    pub(crate) repair_id: String,
    pub(crate) state: &'static str,
    pub(crate) optimistic_version: u64,
    pub(crate) needs_refetch: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RepairCommandPreflight {
    Clean,
    PendingPredecessor,
}

impl Drop for RepairCachedWorkspace {
    fn drop(&mut self) {
        if let Some(authoritative) = self.authoritative.as_mut() {
            zeroize_json(authoritative);
        }
        self.authoritative = None;
        self.pending_operations.iter_mut().for_each(zeroize_json);
        self.pending_operations.clear();
    }
}

/// Resolve aggregate ordering before any direct HTTP command is attempted.
///
/// A dirty cache row or a live same-scope queue row is an authoritative local
/// predecessor. Callers may append another offline-safe command, but must not
/// bypass that predecessor with a direct server request. Open conflicts always
/// fail closed and are resolved only through the typed conflict lifecycle.
pub(crate) fn repair_command_preflight(
    connection: &Connection,
    access: &RepairRendererAccess,
    repair_id: &str,
    expected_version: u64,
) -> Result<RepairCommandPreflight, String> {
    if canonical_uuid(repair_id).as_deref() != Some(repair_id)
        || expected_version > MAX_SAFE_INTEGER
    {
        return Err("REPAIR_OFFLINE_ENVELOPE_INVALID".to_string());
    }
    let scope = renderer_scope(connection, access)?;
    let open_conflict: bool = connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM repair_conflicts
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND state = 'open'
             )",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
            ],
            |row| row.get(0),
        )
        .map_err(|_| "REPAIR_CONFLICT_CHECK_FAILED".to_string())?;
    let cached = connection
        .query_row(
            "SELECT optimistic_version, dirty, has_conflict
               FROM repair_cache
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4 AND scope_generation = ?5",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)? != 0,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    if open_conflict || cached.as_ref().is_some_and(|row| row.2) {
        return Err("REPAIR_CONFLICT_OPEN".to_string());
    }
    let Some((optimistic_version, dirty, _)) = cached else {
        return if expected_version == 0 {
            Ok(RepairCommandPreflight::Clean)
        } else {
            Err("REPAIR_CACHE_REQUIRED".to_string())
        };
    };
    if optimistic_version < 0
        || u64::try_from(optimistic_version).unwrap_or(u64::MAX) != expected_version
    {
        return Err("REPAIR_OFFLINE_VERSION_CONFLICT".to_string());
    }
    let pending_queue: bool = connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM parity_sync_queue
                  WHERE organization_id = ?1
                    AND lower(trim(COALESCE(module_type, ''))) = 'repairs'
                    AND repair_aggregate_id = ?2
                    AND lower(trim(COALESCE(table_name, '')))
                          IN ('repairs', 'repair_attachments')
                    AND status IN ('pending', 'processing', 'failed', 'conflict')
             )",
            params![scope.organization_id, repair_id],
            |row| row.get(0),
        )
        .map_err(|_| "REPAIR_QUEUE_READ_FAILED".to_string())?;
    Ok(if dirty || pending_queue {
        RepairCommandPreflight::PendingPredecessor
    } else {
        RepairCommandPreflight::Clean
    })
}

fn bounded_optional(value: &Option<String>, maximum: usize) -> bool {
    value.as_ref().map_or(true, |value| {
        value.trim() == value && !value.is_empty() && value.encode_utf16().count() <= maximum
    })
}

fn validate_timestamp(value: &str) -> bool {
    value.trim() == value
        && value.len() <= 64
        && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn valid_numeric_text(value: &str) -> bool {
    let (whole, fraction) = value
        .split_once('.')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    !whole.is_empty()
        && whole.len() <= 10
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.map_or(true, |fraction| {
            !fraction.is_empty()
                && fraction.len() <= 4
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn valid_quantity_text(value: &str) -> bool {
    let (whole, fraction) = value
        .split_once('.')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    !whole.is_empty()
        && whole.len() <= 9
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.map_or(true, |fraction| {
            !fraction.is_empty()
                && fraction.len() <= 3
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn command_parts(
    command: &RepairOfflineCommand,
    offline_number: Option<(&str, u64)>,
) -> Result<(&'static str, serde_json::Value), String> {
    let command_name = match command {
        RepairOfflineCommand::CreateIntake { .. } => "create_intake",
        RepairOfflineCommand::AddNote { .. } => "add_note",
        RepairOfflineCommand::AssignRepair { .. } => "assign_repair",
        RepairOfflineCommand::UpdateDiagnosis { .. } => "update_diagnosis",
        RepairOfflineCommand::PlanLine { .. } => "plan_line",
        RepairOfflineCommand::TransitionStatus { .. } => "transition_status",
    };
    let mut payload =
        serde_json::to_value(command).map_err(|_| "REPAIR_OFFLINE_COMMAND_INVALID".to_string())?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "REPAIR_OFFLINE_COMMAND_INVALID".to_string())?;
    object.remove("type");
    if command_name == "create_intake" {
        let (alias, sequence) =
            offline_number.ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_REQUIRED".to_string())?;
        object.insert(
            "offline_alias".to_string(),
            serde_json::Value::String(alias.to_string()),
        );
        object.insert(
            "offline_sequence".to_string(),
            serde_json::Value::from(sequence),
        );
    } else if offline_number.is_some() {
        return Err("REPAIR_OFFLINE_COMMAND_INVALID".to_string());
    }
    Ok((command_name, payload))
}

fn validate_offline_command(
    command: &RepairOfflineCommand,
    current_status: Option<&str>,
) -> Result<(String, String, String, Option<String>, Option<String>), String> {
    match command {
        RepairOfflineCommand::CreateIntake {
            intake_mode,
            is_anonymous,
            customer_id,
            customer_device_id,
            priority,
            currency,
            title,
            intake_notes,
            due_at,
            offline_alias,
            offline_sequence,
        } => {
            if !matches!(intake_mode.as_str(), "standard" | "quick_service")
                || !matches!(priority.as_str(), "low" | "normal" | "high" | "urgent")
                || currency.len() != 3
                || !currency.bytes().all(|byte| byte.is_ascii_uppercase())
                || !bounded_optional(title, 200)
                || !bounded_optional(intake_notes, 5_000)
                || due_at
                    .as_ref()
                    .is_some_and(|value| !validate_timestamp(value))
                || offline_alias.is_some()
                || offline_sequence.is_some()
            {
                return Err("REPAIR_OFFLINE_COMMAND_INVALID".to_string());
            }
            if intake_mode == "standard"
                && (*is_anonymous
                    || customer_id.as_deref().and_then(canonical_uuid).is_none()
                    || customer_device_id
                        .as_deref()
                        .and_then(canonical_uuid)
                        .is_none())
            {
                return Err("REPAIR_STANDARD_CUSTOMER_DEVICE_REQUIRED".to_string());
            }
            if *is_anonymous
                && (intake_mode != "quick_service"
                    || customer_id.is_some()
                    || customer_device_id.is_some())
            {
                return Err("REPAIR_QUICK_SERVICE_IDENTITY_INVALID".to_string());
            }
            if intake_mode == "quick_service"
                && !*is_anonymous
                && (customer_id.as_deref().and_then(canonical_uuid).is_none()
                    || customer_device_id
                        .as_deref()
                        .is_some_and(|value| canonical_uuid(value).is_none()))
            {
                return Err("REPAIR_QUICK_SERVICE_IDENTITY_INVALID".to_string());
            }
            Ok((
                "received".to_string(),
                priority.clone(),
                intake_mode.clone(),
                None,
                due_at.clone(),
            ))
        }
        RepairOfflineCommand::AddNote { note, visibility } => {
            if note.trim() != note
                || note.is_empty()
                || note.encode_utf16().count() > 5_000
                || !matches!(visibility.as_str(), "internal" | "customer")
            {
                return Err("REPAIR_OFFLINE_COMMAND_INVALID".to_string());
            }
            Ok((
                current_status.unwrap_or_default().to_string(),
                String::new(),
                String::new(),
                None,
                None,
            ))
        }
        RepairOfflineCommand::AssignRepair { assigned_staff_id } => {
            if assigned_staff_id
                .as_deref()
                .is_some_and(|value| canonical_uuid(value).is_none())
            {
                return Err("REPAIR_OFFLINE_COMMAND_INVALID".to_string());
            }
            Ok((
                current_status.unwrap_or_default().to_string(),
                String::new(),
                String::new(),
                None,
                None,
            ))
        }
        RepairOfflineCommand::UpdateDiagnosis { diagnosis, draft } => {
            if !*draft
                || diagnosis.as_ref().is_some_and(|diagnosis| {
                    diagnosis.trim() != diagnosis
                        || diagnosis.is_empty()
                        || diagnosis.encode_utf16().count() > 10_000
                })
            {
                return Err("REPAIR_OFFLINE_COMMAND_INVALID".to_string());
            }
            Ok((
                current_status.unwrap_or_default().to_string(),
                String::new(),
                String::new(),
                None,
                None,
            ))
        }
        RepairOfflineCommand::PlanLine {
            line_id,
            line_type,
            name_snapshot,
            sku_snapshot,
            description,
            quantity,
            unit_cost_snapshot,
            unit_price_snapshot,
            vat_rate_snapshot,
            retail_product_id,
            retail_variant_id,
            service_id,
            display_order,
        } => {
            if canonical_uuid(line_id).is_none()
                || !matches!(line_type.as_str(), "part" | "labour" | "charge")
                || name_snapshot.trim() != name_snapshot
                || name_snapshot.is_empty()
                || name_snapshot.encode_utf16().count() > 255
                || !bounded_optional(sku_snapshot, 100)
                || !bounded_optional(description, 1_000)
                || !valid_quantity_text(quantity)
                || unit_cost_snapshot
                    .as_ref()
                    .is_some_and(|value| !valid_numeric_text(value))
                || !valid_numeric_text(unit_price_snapshot)
                || !valid_numeric_text(vat_rate_snapshot)
                || [retail_product_id, retail_variant_id, service_id]
                    .into_iter()
                    .filter_map(|value| value.as_ref())
                    .any(|value| canonical_uuid(value).is_none())
                || *display_order > 10_000
            {
                return Err("REPAIR_PLANNED_LINE_INVALID".to_string());
            }
            Ok((
                current_status.unwrap_or_default().to_string(),
                String::new(),
                String::new(),
                None,
                None,
            ))
        }
        RepairOfflineCommand::TransitionStatus {
            target_status,
            reason,
            remain_consumed: _,
        } => {
            if !bounded_optional(reason, 1_000) {
                return Err("REPAIR_OFFLINE_COMMAND_INVALID".to_string());
            }
            let allowed = matches!(
                (current_status.unwrap_or_default(), target_status.as_str()),
                ("received", "diagnosing")
                    | ("diagnosing", "waiting_customer_approval")
                    | ("approved", "waiting_parts")
                    | ("approved", "repairing")
                    | ("waiting_parts", "repairing")
                    | ("repairing", "waiting_parts")
                    | ("repairing", "quality_check")
                    | ("quality_check", "repairing")
                    | ("quality_check", "ready")
            );
            if !allowed {
                return Err("REPAIR_OFFLINE_TRANSITION_DENIED".to_string());
            }
            if current_status == Some("quality_check")
                && target_status == "repairing"
                && reason.is_none()
            {
                return Err("REPAIR_REWORK_REASON_REQUIRED".to_string());
            }
            Ok((
                target_status.clone(),
                String::new(),
                String::new(),
                None,
                None,
            ))
        }
    }
}

fn validate_trusted_drain_command_shape(command: &RepairOfflineCommand) -> Result<(), String> {
    match command {
        RepairOfflineCommand::TransitionStatus {
            target_status,
            reason,
            remain_consumed: _,
        } => {
            if !matches!(
                target_status.as_str(),
                "diagnosing"
                    | "waiting_customer_approval"
                    | "waiting_parts"
                    | "repairing"
                    | "quality_check"
                    | "ready"
            ) || !bounded_optional(reason, 1_000)
            {
                return Err("REPAIR_OFFLINE_COMMAND_INVALID".to_string());
            }
            Ok(())
        }
        // The AEAD-protected envelope was graph-validated atomically when it
        // was produced. These variants have no source-status dependency, so
        // reuse their strict field validators without consulting today's
        // optimistic cache projection.
        _ => validate_offline_command(command, None).map(|_| ()),
    }
}

fn allocate_offline_alias(
    transaction: &Transaction<'_>,
    scope: &RepairScopeState,
    repair_id: &str,
    created_at: &str,
) -> Result<(String, u64), String> {
    let token = scope
        .offline_terminal_token
        .as_deref()
        .ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_REQUIRED".to_string())?;
    let start = scope
        .offline_sequence_lease_start
        .ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_REQUIRED".to_string())?;
    let end = scope
        .offline_sequence_lease_end
        .ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_REQUIRED".to_string())?;
    let prefix = format!("R-OFF-{token}-");
    let maximum: Option<u64> = transaction
        .query_row(
            "SELECT MAX(CAST(substr(alias, ?1) AS INTEGER))
               FROM repair_alias_cache
              WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                AND length(alias) = ?5
                AND substr(alias, 1, ?6) = ?7
                AND substr(alias, ?1) GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'",
            params![
                i64::try_from(prefix.len() + 1).unwrap_or(i64::MAX),
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                i64::try_from(prefix.len() + 6).unwrap_or(i64::MAX),
                i64::try_from(prefix.len()).unwrap_or(i64::MAX),
                prefix,
            ],
            |row| row.get(0),
        )
        .map_err(|_| "REPAIR_OFFLINE_ALIAS_LOOKUP_FAILED".to_string())?;
    let next = maximum.map_or(start, |value| value.saturating_add(1));
    if next < start || next > end {
        return Err("REPAIR_OFFLINE_LEASE_EXHAUSTED".to_string());
    }
    let alias = format!("{prefix}{next:06}");
    transaction
        .execute(
            "INSERT INTO repair_alias_cache (
                 organization_id, branch_id, terminal_id, alias, repair_id,
                 is_official, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                alias,
                repair_id,
                created_at,
            ],
        )
        .map_err(|_| "REPAIR_OFFLINE_ALIAS_INSERT_FAILED".to_string())?;
    Ok((alias, next))
}

fn renderer_scope(
    connection: &Connection,
    access: &RepairRendererAccess,
) -> Result<RepairScopeState, String> {
    let scope = active_scope()?;
    require_entitlement(&scope)?;
    let runtime = runtime_scope_identity(connection)?;
    if scope.scope_token != access.scope_token
        || scope.scope_epoch != access.scope_epoch()
        || !scope_matches_identity(&scope, &runtime.0, &runtime.1, &runtime.2)
    {
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    Ok(scope)
}

fn load_cached_aliases(
    connection: &Connection,
    scope: &RepairScopeState,
    repair_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT alias FROM repair_alias_cache
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4
              ORDER BY is_official DESC, created_at ASC, alias ASC",
        )
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    let aliases = statement
        .query_map(
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    Ok(aliases)
}

fn cached_list_row(
    connection: &Connection,
    scope: &RepairScopeState,
    repair_id: String,
    display_number: String,
    status: String,
    priority: String,
    intake_mode: String,
    safe_device_label: Option<String>,
    due_at: Option<String>,
    ready_at: Option<String>,
    authoritative_version: i64,
    optimistic_version: i64,
    dirty: i64,
    has_conflict: i64,
    needs_refetch: i64,
    created_at: String,
    updated_at: String,
) -> Result<RepairCachedListRow, String> {
    Ok(RepairCachedListRow {
        aliases: load_cached_aliases(connection, scope, &repair_id)?,
        repair_id,
        display_number,
        status,
        priority,
        intake_mode,
        safe_device_label,
        due_at,
        ready_at,
        authoritative_version: u64::try_from(authoritative_version).unwrap_or(u64::MAX),
        optimistic_version: u64::try_from(optimistic_version).unwrap_or(u64::MAX),
        dirty: dirty != 0,
        has_conflict: has_conflict != 0,
        needs_refetch: needs_refetch != 0,
        created_at,
        updated_at,
    })
}

pub(crate) fn read_cached_list(
    connection: &Connection,
    access: &RepairRendererAccess,
    status: Option<&str>,
    search: Option<&str>,
    limit: u16,
    offset: u32,
) -> Result<(Vec<RepairCachedListRow>, u64), String> {
    let scope = renderer_scope(connection, access)?;
    if limit == 0
        || limit > 50
        || offset > 10_000
        || status.is_some_and(|value| {
            !matches!(
                value,
                "received"
                    | "diagnosing"
                    | "waiting_customer_approval"
                    | "approved"
                    | "waiting_parts"
                    | "repairing"
                    | "quality_check"
                    | "ready"
                    | "delivered"
                    | "cancelled"
                    | "unrepairable"
            )
        })
        || search.is_some_and(|value| value.encode_utf16().count() > 80)
    {
        return Err("REPAIR_LIST_INPUT_INVALID".to_string());
    }
    let normalized_search = search.map(str::trim).filter(|value| !value.is_empty());
    let pattern = normalized_search.map(|value| {
        format!(
            "%{}%",
            value
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    });
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM repair_cache c
              WHERE c.organization_id = ?1 AND c.branch_id = ?2 AND c.terminal_id = ?3
                AND (?4 IS NULL OR c.status = ?4)
                AND (?5 IS NULL OR c.display_number LIKE ?5 ESCAPE '\'
                     OR COALESCE(c.safe_device_label, '') LIKE ?5 ESCAPE '\'
                     OR EXISTS (
                         SELECT 1 FROM repair_alias_cache a
                          WHERE a.organization_id = c.organization_id
                            AND a.branch_id = c.branch_id
                            AND a.terminal_id = c.terminal_id
                            AND a.repair_id = c.repair_id
                            AND a.alias LIKE ?5 ESCAPE '\'
                     ))",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                status,
                pattern,
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT c.repair_id, c.display_number, c.status, c.priority,
                    c.intake_mode, c.safe_device_label, c.due_at, c.ready_at,
                    c.authoritative_version, c.optimistic_version, c.dirty,
                    c.has_conflict, c.needs_refetch, c.created_at, c.updated_at
               FROM repair_cache c
              WHERE c.organization_id = ?1 AND c.branch_id = ?2 AND c.terminal_id = ?3
                AND (?4 IS NULL OR c.status = ?4)
                AND (?5 IS NULL OR c.display_number LIKE ?5 ESCAPE '\'
                     OR COALESCE(c.safe_device_label, '') LIKE ?5 ESCAPE '\'
                     OR EXISTS (
                         SELECT 1 FROM repair_alias_cache a
                          WHERE a.organization_id = c.organization_id
                            AND a.branch_id = c.branch_id
                            AND a.terminal_id = c.terminal_id
                            AND a.repair_id = c.repair_id
                            AND a.alias LIKE ?5 ESCAPE '\'
                     ))
              ORDER BY c.updated_at DESC, c.repair_id ASC
              LIMIT ?6 OFFSET ?7",
        )
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    let raw_rows = statement
        .query_map(
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                status,
                pattern,
                i64::from(limit),
                i64::from(offset),
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    let mut rows = Vec::with_capacity(raw_rows.len());
    for row in raw_rows {
        rows.push(cached_list_row(
            connection, &scope, row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
            row.9, row.10, row.11, row.12, row.13, row.14,
        )?);
    }
    Ok((rows, u64::try_from(count).unwrap_or(0)))
}

pub(crate) fn read_cached_workspace(
    connection: &Connection,
    access: &RepairRendererAccess,
    repair_id: &str,
) -> Result<RepairCachedWorkspace, String> {
    if canonical_uuid(repair_id).as_deref() != Some(repair_id) {
        return Err("REPAIR_ID_INVALID".to_string());
    }
    let scope = renderer_scope(connection, access)?;
    let raw = connection
        .query_row(
            "SELECT repair_id, display_number, status, priority, intake_mode,
                    safe_device_label, due_at, ready_at, authoritative_version,
                    optimistic_version, dirty, has_conflict, needs_refetch,
                    created_at, updated_at, workspace_nonce, workspace_ciphertext
               FROM repair_cache
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4 AND scope_generation = ?5",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, Option<Vec<u8>>>(15)?,
                    row.get::<_, Option<Vec<u8>>>(16)?,
                ))
            },
        )
        .map_err(|_| "REPAIR_NOT_FOUND".to_string())?;
    let row = cached_list_row(
        connection, &scope, raw.0, raw.1, raw.2, raw.3, raw.4, raw.5, raw.6, raw.7, raw.8, raw.9,
        raw.10, raw.11, raw.12, raw.13, raw.14,
    )?;
    let workspace = match (raw.15, raw.16) {
        (Some(nonce), Some(ciphertext)) => {
            let plaintext = decrypt(
                &scope,
                CryptoDomain::Cache,
                "workspace",
                repair_id,
                None,
                row.optimistic_version,
                &nonce,
                &ciphertext,
            )?;
            serde_json::from_slice::<PendingWorkspace>(&plaintext)
                .map_err(|_| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?
        }
        (None, None) => PendingWorkspace::default(),
        _ => return Err("REPAIR_CACHE_CORRUPT".to_string()),
    };
    let mut workspace = workspace;
    let authoritative = workspace.authoritative.take();
    let operations = std::mem::take(&mut workspace.operations);
    Ok(RepairCachedWorkspace {
        row,
        authoritative,
        pending_operations: operations,
    })
}

fn read_authoritative_settings_for_scope(
    scope: &RepairScopeState,
) -> Result<serde_json::Value, String> {
    let stored = scope
        .settings_cache
        .as_ref()
        .ok_or_else(|| "REPAIR_SETTINGS_REQUIRED".to_string())?;
    let serialized = Zeroizing::new(
        serde_json::to_string(stored).map_err(|_| "REPAIR_SETTINGS_CACHE_CORRUPT".to_string())?,
    );
    let plaintext = open_stored_ciphertext(
        scope,
        CryptoDomain::Cache,
        "settings",
        &scope.scope_token,
        None,
        scope.scope_epoch,
        &serialized,
    )?;
    let value = serde_json::from_slice::<serde_json::Value>(&plaintext)
        .map_err(|_| "REPAIR_SETTINGS_CACHE_CORRUPT".to_string())?;
    if !value
        .get("settings")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|settings| {
            settings
                .get("quick_service_enabled")
                .and_then(serde_json::Value::as_bool)
                .is_some()
                && settings
                    .get("currency")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|currency| {
                        currency.len() == 3
                            && currency.bytes().all(|byte| byte.is_ascii_uppercase())
                    })
                && settings
                    .get("attachment_policy")
                    .and_then(serde_json::Value::as_object)
                    .is_some()
        })
    {
        return Err("REPAIR_SETTINGS_CACHE_CORRUPT".to_string());
    }
    Ok(value)
}

pub(crate) fn read_authoritative_settings(
    connection: &Connection,
    access: &RepairRendererAccess,
) -> Result<serde_json::Value, String> {
    let scope = renderer_scope(connection, access)?;
    read_authoritative_settings_for_scope(&scope)
}

pub(crate) fn cache_authoritative_settings(
    connection: &Connection,
    access: &RepairRendererAccess,
    value: &serde_json::Value,
) -> Result<(), String> {
    let mut scope = renderer_scope(connection, access)?;
    let settings = value
        .get("settings")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SETTINGS_INVALID".to_string())?;
    let currency = settings
        .get("currency")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let attachment_policy = settings
        .get("attachment_policy")
        .and_then(serde_json::Value::as_object);
    if settings
        .get("quick_service_enabled")
        .and_then(serde_json::Value::as_bool)
        .is_none()
        || currency.len() != 3
        || !currency.bytes().all(|byte| byte.is_ascii_uppercase())
        || attachment_policy.is_none()
        || value
            .get("capabilities")
            .and_then(serde_json::Value::as_object)
            .is_none()
    {
        return Err("REPAIR_AUTHORITATIVE_SETTINGS_INVALID".to_string());
    }
    let plaintext = Zeroizing::new(
        serde_json::to_vec(value)
            .map_err(|_| "REPAIR_AUTHORITATIVE_SETTINGS_INVALID".to_string())?,
    );
    let encrypted = encrypt(
        &scope,
        CryptoDomain::Cache,
        "settings",
        &scope.scope_token,
        None,
        scope.scope_epoch,
        &plaintext,
    )?;
    let stored = Zeroizing::new(store_ciphertext(&scope, &encrypted)?);
    scope.settings_cache = Some(
        serde_json::from_str(&stored).map_err(|_| "REPAIR_SETTINGS_CACHE_CORRUPT".to_string())?,
    );
    persist_scope(&scope)
}

fn authoritative_object(
    value: &serde_json::Value,
) -> Result<&serde_json::Map<String, serde_json::Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())
}

fn authoritative_string<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())
}

fn authoritative_optional_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match object.get(key) {
        Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
        _ => Err("REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string()),
    }
}

fn authoritative_version(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<u64, String> {
    object
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())
}

fn repair_number_kind(display_number: &str) -> (Option<&str>, Option<&str>) {
    if display_number.starts_with("R-OFF-") {
        (None, Some(display_number))
    } else {
        (Some(display_number), None)
    }
}

fn upsert_authoritative_list_row(
    transaction: &Transaction<'_>,
    scope: &RepairScopeState,
    repair: &serde_json::Value,
) -> Result<bool, String> {
    let object = authoritative_object(repair)?;
    let repair_id = authoritative_string(object, "id")?;
    if canonical_uuid(repair_id).as_deref() != Some(repair_id) {
        return Err("REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string());
    }
    let Some(display_number) = authoritative_optional_string(object, "display_number")? else {
        return Ok(false);
    };
    let status = authoritative_string(object, "status")?;
    let priority = authoritative_string(object, "priority")?;
    let intake_mode = authoritative_string(object, "intake_mode")?;
    let due_at = authoritative_optional_string(object, "due_at")?;
    let version = authoritative_version(object)?;
    let created_at = authoritative_string(object, "created_at")?;
    let updated_at = authoritative_string(object, "updated_at")?;
    let (official, provisional) = repair_number_kind(&display_number);
    let existing = transaction
        .query_row(
            "SELECT optimistic_version, dirty
               FROM repair_cache
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    if existing.as_ref().is_some_and(|(optimistic, dirty)| {
        *dirty && version > u64::try_from(*optimistic).unwrap_or(u64::MAX)
    }) {
        let marked = transaction
            .execute(
                "UPDATE repair_cache
                    SET needs_refetch = 1
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND dirty = 1 AND optimistic_version < ?5",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    repair_id,
                    i64::try_from(version).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| "REPAIR_CACHE_WRITE_FAILED".to_string())?;
        if marked != 1 {
            return Err("REPAIR_CACHE_WRITE_FAILED".to_string());
        }
        return Ok(true);
    }
    transaction
        .execute(
            "INSERT INTO repair_cache (
                 organization_id, branch_id, terminal_id, repair_id,
                 display_number, official_number, provisional_number,
                 status, authoritative_status, priority, intake_mode,
                 due_at, authoritative_version, optimistic_version,
                 scope_generation, dirty, has_conflict, needs_refetch,
                 created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10,
                       ?11, ?12, ?12, ?13, 0, 0, 1, ?14, ?15)
             ON CONFLICT (organization_id, branch_id, terminal_id, repair_id)
             DO UPDATE SET
                 display_number = CASE WHEN repair_cache.dirty = 0
                                       THEN excluded.display_number
                                       ELSE repair_cache.display_number END,
                 official_number = COALESCE(excluded.official_number, repair_cache.official_number),
                 provisional_number = COALESCE(repair_cache.provisional_number, excluded.provisional_number),
                 status = CASE WHEN repair_cache.dirty = 0
                               THEN excluded.status ELSE repair_cache.status END,
                 authoritative_status = excluded.authoritative_status,
                 priority = CASE WHEN repair_cache.dirty = 0
                                 THEN excluded.priority ELSE repair_cache.priority END,
                 intake_mode = CASE WHEN repair_cache.dirty = 0
                                    THEN excluded.intake_mode ELSE repair_cache.intake_mode END,
                 due_at = CASE WHEN repair_cache.dirty = 0
                               THEN excluded.due_at ELSE repair_cache.due_at END,
                 authoritative_version = excluded.authoritative_version,
                 workspace_nonce = CASE
                     WHEN repair_cache.dirty = 0
                      AND repair_cache.optimistic_version <> excluded.optimistic_version
                     THEN NULL ELSE repair_cache.workspace_nonce END,
                 workspace_ciphertext = CASE
                     WHEN repair_cache.dirty = 0
                      AND repair_cache.optimistic_version <> excluded.optimistic_version
                     THEN NULL ELSE repair_cache.workspace_ciphertext END,
                 optimistic_version = CASE WHEN repair_cache.dirty = 0
                                           THEN excluded.optimistic_version
                                           ELSE repair_cache.optimistic_version END,
                 scope_generation = excluded.scope_generation,
                 needs_refetch = 1,
                 updated_at = excluded.updated_at
             WHERE excluded.authoritative_version >= repair_cache.authoritative_version",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
                display_number,
                official,
                provisional,
                status,
                priority,
                intake_mode,
                due_at,
                i64::try_from(version).unwrap_or(i64::MAX),
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                created_at,
                updated_at,
            ],
        )
        .map_err(|_| "REPAIR_CACHE_WRITE_FAILED".to_string())?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO repair_alias_cache (
                 organization_id, branch_id, terminal_id, alias, repair_id,
                 is_official, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                display_number,
                repair_id,
                i64::from(official.is_some()),
                created_at,
            ],
        )
        .map_err(|_| "REPAIR_CACHE_WRITE_FAILED".to_string())?;
    Ok(false)
}

pub(crate) fn cache_authoritative_list(
    connection: &Connection,
    access: &RepairRendererAccess,
    value: &serde_json::Value,
) -> Result<(), String> {
    let scope = renderer_scope(connection, access)?;
    let repairs = value
        .get("repairs")
        .and_then(serde_json::Value::as_array)
        .filter(|rows| rows.len() <= 50)
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())?;
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|_| "REPAIR_CACHE_TRANSACTION_FAILED".to_string())?;
    let mut diverged = false;
    for repair in repairs {
        diverged |= upsert_authoritative_list_row(&transaction, &scope, repair)?;
    }
    transaction
        .commit()
        .map_err(|_| "REPAIR_CACHE_TRANSACTION_FAILED".to_string())?;
    if diverged {
        Err("REPAIR_AUTHORITATIVE_PENDING_DIVERGED".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn cache_authoritative_workspace(
    connection: &Connection,
    access: &RepairRendererAccess,
    repair_id: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let scope = renderer_scope(connection, access)?;
    if canonical_uuid(repair_id).as_deref() != Some(repair_id) {
        return Err("REPAIR_ID_INVALID".to_string());
    }
    let root = authoritative_object(value)?;
    let header = root
        .get("repair")
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())
        .and_then(authoritative_object)?;
    if authoritative_string(header, "id")? != repair_id {
        return Err("REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string());
    }
    let remote_version = authoritative_version(header)?;
    let remote_display = authoritative_optional_string(header, "display_number")?;
    let remote_status = authoritative_string(header, "status")?.to_string();
    let remote_priority = authoritative_string(header, "priority")?.to_string();
    let remote_mode = authoritative_string(header, "intake_mode")?.to_string();
    let remote_due = authoritative_optional_string(header, "due_at")?;
    let created_at = authoritative_string(header, "created_at")?.to_string();
    let updated_at = authoritative_string(header, "updated_at")?.to_string();
    let safe_device_label = root
        .get("device")
        .and_then(serde_json::Value::as_object)
        .and_then(|device| {
            device
                .get("label")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    let parts = ["manufacturer", "model"]
                        .iter()
                        .filter_map(|key| device.get(*key).and_then(serde_json::Value::as_str))
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>();
                    (!parts.is_empty()).then(|| parts.join(" "))
                })
        });
    let existing = connection
        .query_row(
            "SELECT display_number, status, priority, intake_mode, due_at,
                    authoritative_version, optimistic_version, workspace_nonce,
                    workspace_ciphertext, dirty, has_conflict, created_at, ready_at
               FROM repair_cache
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, i64>(9)? != 0,
                    row.get::<_, i64>(10)? != 0,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<String>>(12)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    if existing
        .as_ref()
        .is_some_and(|row| remote_version < u64::try_from(row.5).unwrap_or(u64::MAX))
    {
        return Ok(());
    }
    let mut workspace = if let Some(existing) = existing.as_ref() {
        match (&existing.7, &existing.8) {
            (Some(nonce), Some(ciphertext)) => {
                let plaintext = decrypt(
                    &scope,
                    CryptoDomain::Cache,
                    "workspace",
                    repair_id,
                    None,
                    u64::try_from(existing.6).unwrap_or(u64::MAX),
                    nonce,
                    ciphertext,
                )?;
                serde_json::from_slice::<PendingWorkspace>(&plaintext)
                    .map_err(|_| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?
            }
            (None, None) => PendingWorkspace::default(),
            _ => return Err("REPAIR_CACHE_CORRUPT".to_string()),
        }
    } else {
        PendingWorkspace::default()
    };
    let dirty = !workspace.operations.is_empty() || existing.as_ref().is_some_and(|row| row.9);
    let old_optimistic = existing
        .as_ref()
        .map(|row| u64::try_from(row.6).unwrap_or(u64::MAX))
        .unwrap_or(0);
    if dirty && remote_version > old_optimistic {
        return Err("REPAIR_AUTHORITATIVE_PENDING_DIVERGED".to_string());
    }
    workspace.authoritative = Some(value.clone());
    let optimistic_version = if dirty {
        old_optimistic
    } else {
        remote_version
    };
    let workspace_json = Zeroizing::new(
        serde_json::to_vec(&workspace).map_err(|_| "REPAIR_CACHE_INVALID".to_string())?,
    );
    let encrypted = encrypt(
        &scope,
        CryptoDomain::Cache,
        "workspace",
        repair_id,
        None,
        optimistic_version,
        &workspace_json,
    )?;
    let display_number = remote_display
        .or_else(|| existing.as_ref().map(|row| row.0.clone()))
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())?;
    let (status, priority, intake_mode, due_at, ready_at) = if dirty {
        let old = existing
            .as_ref()
            .ok_or_else(|| "REPAIR_CACHE_STATE_INVALID".to_string())?;
        (
            old.1.clone(),
            old.2.clone(),
            old.3.clone(),
            old.4.clone(),
            old.12.clone(),
        )
    } else {
        (
            remote_status.clone(),
            remote_priority.clone(),
            remote_mode.clone(),
            remote_due,
            (remote_status == "ready").then_some(updated_at.clone()),
        )
    };
    let has_conflict = existing.as_ref().is_some_and(|row| row.10);
    let (official, provisional) = repair_number_kind(&display_number);
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|_| "REPAIR_CACHE_TRANSACTION_FAILED".to_string())?;
    transaction
        .execute(
            "INSERT INTO repair_cache (
                 organization_id, branch_id, terminal_id, repair_id,
                 display_number, official_number, provisional_number,
                 status, authoritative_status, priority, intake_mode,
                 safe_device_label, due_at, ready_at, authoritative_version,
                 optimistic_version, scope_generation, workspace_nonce,
                 workspace_ciphertext, dirty, has_conflict, needs_refetch,
                 created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                       ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                       ?22, ?23, ?24)
             ON CONFLICT (organization_id, branch_id, terminal_id, repair_id)
             DO UPDATE SET display_number = excluded.display_number,
                 official_number = COALESCE(excluded.official_number, repair_cache.official_number),
                 provisional_number = COALESCE(repair_cache.provisional_number, excluded.provisional_number),
                 status = excluded.status,
                 authoritative_status = excluded.authoritative_status,
                 priority = excluded.priority, intake_mode = excluded.intake_mode,
                 safe_device_label = COALESCE(excluded.safe_device_label, repair_cache.safe_device_label),
                 due_at = excluded.due_at, ready_at = excluded.ready_at,
                 authoritative_version = excluded.authoritative_version,
                 optimistic_version = excluded.optimistic_version,
                 scope_generation = excluded.scope_generation,
                 workspace_nonce = excluded.workspace_nonce,
                 workspace_ciphertext = excluded.workspace_ciphertext,
                 dirty = excluded.dirty, has_conflict = excluded.has_conflict,
                 needs_refetch = excluded.needs_refetch, updated_at = excluded.updated_at",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
                display_number,
                official,
                provisional,
                status,
                remote_status,
                priority,
                intake_mode,
                safe_device_label,
                due_at,
                ready_at,
                i64::try_from(remote_version).unwrap_or(i64::MAX),
                i64::try_from(optimistic_version).unwrap_or(i64::MAX),
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                encrypted.nonce.as_slice(),
                encrypted.ciphertext.as_slice(),
                i64::from(dirty),
                i64::from(has_conflict),
                i64::from(has_conflict),
                existing
                    .as_ref()
                    .map_or(created_at.as_str(), |row| row.11.as_str()),
                updated_at,
            ],
        )
        .map_err(|_| "REPAIR_CACHE_WRITE_FAILED".to_string())?;
    let aliases = root
        .get("aliases")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "REPAIR_AUTHORITATIVE_SNAPSHOT_INVALID".to_string())?;
    for alias in aliases
        .iter()
        .filter_map(serde_json::Value::as_str)
        .chain(std::iter::once(display_number.as_str()))
    {
        let (alias_official, _) = repair_number_kind(alias);
        transaction
            .execute(
                "INSERT OR IGNORE INTO repair_alias_cache (
                     organization_id, branch_id, terminal_id, alias, repair_id,
                     is_official, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    alias,
                    repair_id,
                    i64::from(alias_official.is_some()),
                    created_at,
                ],
            )
            .map_err(|_| "REPAIR_CACHE_WRITE_FAILED".to_string())?;
    }
    transaction
        .commit()
        .map_err(|_| "REPAIR_CACHE_TRANSACTION_FAILED".to_string())
}

/// Apply the bounded authoritative signal returned by a direct online command.
///
/// A command signal intentionally carries no workspace body. Existing clean
/// cache rows are advanced atomically and their version-bound workspace cipher
/// is discarded, forcing a typed workspace refetch. A newly-created online
/// repair may not have a list row yet; that is safe because the command result
/// itself is returned and the next typed list/workspace read populates cache.
pub(crate) fn apply_authoritative_command_signal(
    connection: &Connection,
    access: &RepairRendererAccess,
    repair_id: &str,
    expected_version: u64,
    status: &str,
    version: u64,
) -> Result<(), String> {
    if canonical_uuid(repair_id).as_deref() != Some(repair_id)
        || expected_version > MAX_SAFE_INTEGER
        || version <= expected_version
        || version > MAX_SAFE_INTEGER
        || !matches!(
            status,
            "received"
                | "diagnosing"
                | "waiting_customer_approval"
                | "approved"
                | "waiting_parts"
                | "repairing"
                | "quality_check"
                | "ready"
                | "delivered"
                | "cancelled"
                | "unrepairable"
        )
    {
        return Err("REPAIR_AUTHORITATIVE_SIGNAL_INVALID".to_string());
    }
    let scope = renderer_scope(connection, access)?;
    let now = chrono::Utc::now().to_rfc3339();
    let updated = connection
        .execute(
            "UPDATE repair_cache
                SET status = ?1, authoritative_status = ?1,
                    authoritative_version = ?2, optimistic_version = ?2,
                    workspace_nonce = NULL, workspace_ciphertext = NULL,
                    dirty = 0, needs_refetch = 1,
                    ready_at = CASE WHEN ?1 = 'ready'
                                    THEN COALESCE(ready_at, ?3)
                                    ELSE ready_at END,
                    updated_at = ?3
              WHERE organization_id = ?4 AND branch_id = ?5 AND terminal_id = ?6
                AND repair_id = ?7 AND scope_generation = ?8
                AND authoritative_version = ?9 AND optimistic_version = ?9
                AND dirty = 0 AND has_conflict = 0",
            params![
                status,
                i64::try_from(version).unwrap_or(i64::MAX),
                now,
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                i64::try_from(expected_version).unwrap_or(i64::MAX),
            ],
        )
        .map_err(|_| "REPAIR_CACHE_UPDATE_FAILED".to_string())?;
    if updated == 1 {
        return Ok(());
    }
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM repair_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND scope_generation = ?5
             )",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                repair_id,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
            ],
            |row| row.get(0),
        )
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    if exists {
        Err("REPAIR_AUTHORITATIVE_SIGNAL_STALE".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn list_open_conflicts(
    connection: &Connection,
    access: &RepairRendererAccess,
) -> Result<Vec<RepairConflictRecord>, String> {
    let scope = renderer_scope(connection, access)?;
    let mut statement = connection
        .prepare(
            "SELECT conflict_id, repair_id, expected_version, current_version,
                    display_number, status_summary, updated_at_summary,
                    allowed_transitions_json, created_at
               FROM repair_conflicts
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND state = 'open'
              ORDER BY created_at ASC, conflict_id ASC",
        )
        .map_err(|_| "REPAIR_CONFLICT_READ_FAILED".to_string())?;
    let raw = statement
        .query_map(
            params![scope.organization_id, scope.branch_id, scope.terminal_id,],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .map_err(|_| "REPAIR_CONFLICT_READ_FAILED".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "REPAIR_CONFLICT_READ_FAILED".to_string())?;
    let mut conflicts = Vec::with_capacity(raw.len());
    for row in raw {
        let allowed_transitions = serde_json::from_str::<Vec<String>>(&row.7)
            .map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?;
        if canonical_uuid(&row.0).is_none()
            || canonical_uuid(&row.1).is_none()
            || row.2 < 0
            || row.3 <= row.2
            || !matches!(
                row.5.as_str(),
                "received"
                    | "diagnosing"
                    | "waiting_customer_approval"
                    | "approved"
                    | "waiting_parts"
                    | "repairing"
                    | "quality_check"
                    | "ready"
                    | "delivered"
                    | "cancelled"
                    | "unrepairable"
            )
            || !validate_timestamp(&row.6)
            || allowed_transitions.len() > 11
        {
            return Err("REPAIR_CONFLICT_STATE_INVALID".to_string());
        }
        conflicts.push(RepairConflictRecord {
            conflict_id: row.0,
            repair_id: row.1,
            expected_version: u64::try_from(row.2).unwrap_or(u64::MAX),
            current_version: u64::try_from(row.3).unwrap_or(u64::MAX),
            display_number: row.4,
            status: row.5,
            updated_at: row.6,
            allowed_transitions,
            created_at: row.8,
        });
    }
    Ok(conflicts)
}

pub(crate) fn accept_server_conflict(
    connection: &Connection,
    access: &RepairRendererAccess,
    conflict_id: &str,
) -> Result<RepairConflictResolutionResult, String> {
    if canonical_uuid(conflict_id).as_deref() != Some(conflict_id) {
        return Err("REPAIR_CONFLICT_ID_INVALID".to_string());
    }
    let scope = renderer_scope(connection, access)?;
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|_| "REPAIR_CONFLICT_TRANSACTION_FAILED".to_string())?;
    let conflict = transaction
        .query_row(
            "SELECT repair_id, current_version, display_number, status_summary
               FROM repair_conflicts
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND conflict_id = ?4 AND state = 'open'",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict_id,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|_| "REPAIR_CONFLICT_NOT_FOUND".to_string())?;
    let current_version =
        u64::try_from(conflict.1).map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?;
    if canonical_uuid(&conflict.0).is_none()
        || current_version == 0
        || current_version > MAX_SAFE_INTEGER
    {
        return Err("REPAIR_CONFLICT_STATE_INVALID".to_string());
    }
    let file_keys = {
        let mut statement = transaction
            .prepare(
                "SELECT file_key FROM repair_attachment_staging
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND scope_generation = ?5",
            )
            .map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?;
        let keys = statement
            .query_map(
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    conflict.0,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?;
        keys
    };
    transaction
        .execute(
            "DELETE FROM parity_sync_queue
              WHERE organization_id = ?1
                AND COALESCE(module_type, '') = 'repairs'
                AND repair_aggregate_id = ?2
                AND table_name IN ('repairs', 'repair_attachments')
                AND operation = 'INSERT' AND conflict_strategy = 'manual'",
            params![scope.organization_id, conflict.0],
        )
        .map_err(|_| "REPAIR_CONFLICT_RESOLUTION_FAILED".to_string())?;
    transaction
        .execute(
            "DELETE FROM repair_attachment_staging
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4 AND scope_generation = ?5",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict.0,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
            ],
        )
        .map_err(|_| "REPAIR_CONFLICT_RESOLUTION_FAILED".to_string())?;
    let cache_updated = transaction
        .execute(
            "UPDATE repair_cache
                SET display_number = COALESCE(?1, display_number),
                    official_number = COALESCE(?1, official_number),
                    status = ?2, authoritative_status = ?2,
                    authoritative_version = ?3, optimistic_version = ?3,
                    workspace_nonce = NULL, workspace_ciphertext = NULL,
                    dirty = 0, has_conflict = 0, needs_refetch = 1,
                    updated_at = ?4
              WHERE organization_id = ?5 AND branch_id = ?6 AND terminal_id = ?7
                AND repair_id = ?8 AND scope_generation = ?9",
            params![
                conflict.2,
                conflict.3,
                i64::try_from(current_version).unwrap_or(i64::MAX),
                chrono::Utc::now().to_rfc3339(),
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict.0,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
            ],
        )
        .map_err(|_| "REPAIR_CONFLICT_RESOLUTION_FAILED".to_string())?;
    if cache_updated != 1 {
        return Err("REPAIR_CONFLICT_CACHE_MISSING".to_string());
    }
    let resolved = transaction
        .execute(
            "UPDATE repair_conflicts
                SET state = 'accepted_server', resolved_at = ?1
              WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                AND conflict_id = ?5 AND state = 'open'",
            params![
                chrono::Utc::now().to_rfc3339(),
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict_id,
            ],
        )
        .map_err(|_| "REPAIR_CONFLICT_RESOLUTION_FAILED".to_string())?;
    if resolved != 1 {
        return Err("REPAIR_CONFLICT_STATE_INVALID".to_string());
    }
    transaction
        .commit()
        .map_err(|_| "REPAIR_CONFLICT_TRANSACTION_FAILED".to_string())?;
    for file_key in file_keys {
        if let Ok(path) = attachment_final_path(connection, &scope, &file_key) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(RepairConflictResolutionResult {
        repair_id: conflict.0,
        state: "accepted_server",
        optimistic_version: current_version,
        needs_refetch: true,
    })
}

fn offline_command_from_envelope(
    envelope: &NativeCommandEnvelope,
) -> Result<RepairOfflineCommand, String> {
    let mut object = envelope
        .payload
        .as_object()
        .cloned()
        .ok_or_else(|| "REPAIR_CONFLICT_LOCAL_ENVELOPE_INVALID".to_string())?;
    object.insert(
        "type".to_string(),
        serde_json::Value::String(envelope.command.clone()),
    );
    serde_json::from_value(serde_json::Value::Object(object))
        .map_err(|_| "REPAIR_CONFLICT_LOCAL_ENVELOPE_INVALID".to_string())
}

pub(crate) fn rebase_repair_conflict(
    connection: &Connection,
    access: &RepairRendererAccess,
    conflict_id: &str,
) -> Result<RepairConflictResolutionResult, String> {
    if canonical_uuid(conflict_id).as_deref() != Some(conflict_id) {
        return Err("REPAIR_CONFLICT_ID_INVALID".to_string());
    }
    let scope = renderer_scope(connection, access)?;
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|_| "REPAIR_CONFLICT_TRANSACTION_FAILED".to_string())?;
    let conflict = transaction
        .query_row(
            "SELECT repair_id, operation_id, expected_version, current_version,
                    status_summary, local_nonce, local_ciphertext
               FROM repair_conflicts
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND conflict_id = ?4 AND state = 'open'",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict_id,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, Vec<u8>>(6)?,
                ))
            },
        )
        .map_err(|_| "REPAIR_CONFLICT_NOT_FOUND".to_string())?;
    let expected_version =
        u64::try_from(conflict.2).map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?;
    let current_version =
        u64::try_from(conflict.3).map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?;
    if canonical_uuid(&conflict.0).is_none()
        || canonical_uuid(&conflict.1).is_none()
        || current_version <= expected_version
        || current_version >= MAX_SAFE_INTEGER
    {
        return Err("REPAIR_CONFLICT_STATE_INVALID".to_string());
    }
    let source = transaction
        .query_row(
            "SELECT table_name, record_id, status, repair_aggregate_id
               FROM parity_sync_queue
              WHERE id = ?1 AND organization_id = ?2
                AND COALESCE(module_type, '') = 'repairs'
                AND operation = 'INSERT' AND conflict_strategy = 'manual'
                AND version = ?3",
            params![
                conflict.1,
                scope.organization_id,
                i64::try_from(expected_version).unwrap_or(i64::MAX),
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|_| "REPAIR_CONFLICT_SOURCE_MISSING".to_string())?;
    if source.0 != "repairs"
        || source.1 != conflict.0
        || source.2 != "conflict"
        || source.3.as_deref() != Some(conflict.0.as_str())
    {
        return Err(if source.0 == "repair_attachments" {
            "REPAIR_ATTACHMENT_REBASE_RESTAGE_REQUIRED"
        } else {
            "REPAIR_CONFLICT_SOURCE_INVALID"
        }
        .to_string());
    }
    let dependent_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue
              WHERE organization_id = ?1 AND id <> ?2
                AND COALESCE(module_type, '') = 'repairs'
                AND repair_aggregate_id = ?3
                AND table_name IN ('repairs', 'repair_attachments')
                AND operation = 'INSERT' AND conflict_strategy = 'manual'
                AND status IN ('pending', 'processing', 'failed', 'conflict')",
            params![scope.organization_id, conflict.1, conflict.0],
            |row| row.get(0),
        )
        .map_err(|_| "REPAIR_CONFLICT_STATE_INVALID".to_string())?;
    if dependent_count != 0 {
        return Err("REPAIR_REBASE_DEPENDENCIES_REQUIRE_ACCEPT_SERVER".to_string());
    }
    let plaintext = decrypt(
        &scope,
        CryptoDomain::Conflict,
        "repairs",
        &conflict.0,
        Some(&conflict.1),
        current_version,
        &conflict.5,
        &conflict.6,
    )?;
    let old_envelope = serde_json::from_slice::<NativeCommandEnvelope>(&plaintext)
        .map_err(|_| "REPAIR_CONFLICT_LOCAL_ENVELOPE_INVALID".to_string())?;
    if old_envelope.operation_id != conflict.1
        || old_envelope.repair_id != conflict.0
        || old_envelope.expected_version != expected_version
    {
        return Err("REPAIR_CONFLICT_LOCAL_ENVELOPE_INVALID".to_string());
    }
    let command = offline_command_from_envelope(&old_envelope)?;
    if matches!(command, RepairOfflineCommand::CreateIntake { .. }) {
        return Err("REPAIR_CREATE_CONFLICT_REBASE_UNSUPPORTED".to_string());
    }
    let (rebased_status, _, _, _, _) = validate_offline_command(&command, Some(&conflict.4))?;
    let (command_name, payload) = command_parts(&command, None)?;
    let new_operation_id = Uuid::new_v4().to_string();
    let occurred_at = chrono::Utc::now().to_rfc3339();
    let new_envelope = NativeCommandEnvelope {
        operation_id: new_operation_id.clone(),
        repair_id: conflict.0.clone(),
        expected_version: current_version,
        staff_session_id: old_envelope.staff_session_id.clone(),
        command: command_name.to_string(),
        payload,
        occurred_at: occurred_at.clone(),
    };
    let envelope_json = Zeroizing::new(
        serde_json::to_string(&new_envelope)
            .map_err(|_| "REPAIR_CONFLICT_LOCAL_ENVELOPE_INVALID".to_string())?,
    );
    let encrypted_queue = encrypt(
        &scope,
        CryptoDomain::Queue,
        "repairs",
        &conflict.0,
        Some(&new_operation_id),
        current_version,
        envelope_json.as_bytes(),
    )?;
    let stored_queue = Zeroizing::new(store_ciphertext(&scope, &encrypted_queue)?);
    let (optimistic_version, workspace_nonce, workspace_ciphertext) = transaction
        .query_row(
            "SELECT optimistic_version, workspace_nonce, workspace_ciphertext
               FROM repair_cache
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4 AND scope_generation = ?5 AND has_conflict = 1",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict.0,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                    row.get::<_, Option<Vec<u8>>>(2)?,
                ))
            },
        )
        .map_err(|_| "REPAIR_CONFLICT_CACHE_MISSING".to_string())?;
    let mut workspace = match (workspace_nonce, workspace_ciphertext) {
        (Some(nonce), Some(ciphertext)) => {
            let plaintext = decrypt(
                &scope,
                CryptoDomain::Cache,
                "workspace",
                &conflict.0,
                None,
                u64::try_from(optimistic_version).unwrap_or(u64::MAX),
                &nonce,
                &ciphertext,
            )?;
            serde_json::from_slice::<PendingWorkspace>(&plaintext)
                .map_err(|_| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?
        }
        _ => return Err("REPAIR_CACHE_CORRUPT".to_string()),
    };
    let before = workspace.operations.len();
    workspace.operations.retain(|operation| {
        operation
            .get("operation_id")
            .and_then(serde_json::Value::as_str)
            != Some(conflict.1.as_str())
    });
    if workspace.operations.len() + 1 != before {
        return Err("REPAIR_CONFLICT_LOCAL_ENVELOPE_INVALID".to_string());
    }
    workspace.authoritative = None;
    workspace.operations.push(
        serde_json::from_str(&envelope_json)
            .map_err(|_| "REPAIR_CONFLICT_LOCAL_ENVELOPE_INVALID".to_string())?,
    );
    let next_version = current_version + 1;
    let workspace_json = Zeroizing::new(
        serde_json::to_vec(&workspace).map_err(|_| "REPAIR_CACHE_INVALID".to_string())?,
    );
    let encrypted_workspace = encrypt(
        &scope,
        CryptoDomain::Cache,
        "workspace",
        &conflict.0,
        None,
        next_version,
        &workspace_json,
    )?;
    transaction
        .execute(
            "DELETE FROM parity_sync_queue
              WHERE id = ?1 AND organization_id = ?2
                AND COALESCE(module_type, '') = 'repairs'
                AND table_name = 'repairs' AND record_id = ?3
                AND operation = 'INSERT' AND conflict_strategy = 'manual'
                AND version = ?4 AND status = 'conflict'",
            params![
                conflict.1,
                scope.organization_id,
                conflict.0,
                i64::try_from(expected_version).unwrap_or(i64::MAX),
            ],
        )
        .map_err(|_| "REPAIR_CONFLICT_RESOLUTION_FAILED".to_string())?;
    crate::sync_queue::enqueue_repair_with_fixed_id(
        &transaction,
        &new_operation_id,
        &conflict.0,
        &crate::sync_queue::EnqueueInput {
            table_name: "repairs".to_string(),
            record_id: conflict.0.clone(),
            operation: "INSERT".to_string(),
            data: stored_queue.to_string(),
            organization_id: scope.organization_id.clone(),
            priority: Some(100),
            module_type: Some("repairs".to_string()),
            conflict_strategy: Some("manual".to_string()),
            version: Some(i64::try_from(current_version).unwrap_or(i64::MAX)),
        },
    )?;
    let cache_updated = transaction
        .execute(
            "UPDATE repair_cache
                SET status = ?1, authoritative_status = ?2,
                    authoritative_version = ?3, optimistic_version = ?4,
                    workspace_nonce = ?5, workspace_ciphertext = ?6,
                    dirty = 1, has_conflict = 0, needs_refetch = 1,
                    updated_at = ?7
              WHERE organization_id = ?8 AND branch_id = ?9 AND terminal_id = ?10
                AND repair_id = ?11 AND scope_generation = ?12 AND has_conflict = 1",
            params![
                rebased_status,
                conflict.4,
                i64::try_from(current_version).unwrap_or(i64::MAX),
                i64::try_from(next_version).unwrap_or(i64::MAX),
                encrypted_workspace.nonce.as_slice(),
                encrypted_workspace.ciphertext.as_slice(),
                occurred_at,
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict.0,
                i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
            ],
        )
        .map_err(|_| "REPAIR_CONFLICT_RESOLUTION_FAILED".to_string())?;
    if cache_updated != 1 {
        return Err("REPAIR_CONFLICT_CACHE_MISSING".to_string());
    }
    let resolved = transaction
        .execute(
            "UPDATE repair_conflicts
                SET state = 'rebased', rebased_operation_id = ?1, resolved_at = ?2
              WHERE organization_id = ?3 AND branch_id = ?4 AND terminal_id = ?5
                AND conflict_id = ?6 AND state = 'open'",
            params![
                new_operation_id,
                chrono::Utc::now().to_rfc3339(),
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                conflict_id,
            ],
        )
        .map_err(|_| "REPAIR_CONFLICT_RESOLUTION_FAILED".to_string())?;
    if resolved != 1 {
        return Err("REPAIR_CONFLICT_STATE_INVALID".to_string());
    }
    transaction
        .commit()
        .map_err(|_| "REPAIR_CONFLICT_TRANSACTION_FAILED".to_string())?;
    Ok(RepairConflictResolutionResult {
        repair_id: conflict.0,
        state: "rebased",
        optimistic_version: next_version,
        needs_refetch: true,
    })
}

pub(crate) fn apply_offline_mutation(
    connection: &Connection,
    input: &RepairOfflineMutationInput,
) -> Result<RepairMutationSnapshot, String> {
    if canonical_uuid(&input.operation_id).is_none()
        || canonical_uuid(&input.repair_id).is_none()
        || canonical_uuid(&input.staff_session_id).is_none()
        || input.expected_version > MAX_SAFE_INTEGER
        || !validate_timestamp(&input.occurred_at)
    {
        return Err("REPAIR_OFFLINE_ENVELOPE_INVALID".to_string());
    }
    let scope = active_scope()?;
    require_entitlement(&scope)?;
    let required_permission = required_permission_for_offline_command(&input.command);
    crate::repair_transport::authorize_repair_actor(
        &crate::repair_transport::NativeRepairScope {
            organization_id: scope.organization_id.clone(),
            branch_id: scope.branch_id.clone(),
            terminal_id: scope.terminal_id.clone(),
        },
        &input.staff_session_id,
        required_permission,
        chrono::Utc::now(),
    )
    .map_err(|error| error.code().to_string())?;
    if let RepairOfflineCommand::CreateIntake {
        intake_mode,
        currency,
        ..
    } = &input.command
    {
        if intake_mode == "quick_service" {
            let settings = read_authoritative_settings_for_scope(&scope)?;
            let authoritative = settings
                .get("settings")
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| "REPAIR_SETTINGS_CACHE_CORRUPT".to_string())?;
            if authoritative
                .get("quick_service_enabled")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
                || authoritative
                    .get("currency")
                    .and_then(serde_json::Value::as_str)
                    != Some(currency.as_str())
            {
                return Err("REPAIR_QUICK_SERVICE_DISABLED".to_string());
            }
        }
    }
    let runtime = runtime_scope_identity(connection)?;
    if !scope_matches_identity(&scope, &runtime.0, &runtime.1, &runtime.2) {
        return Err("REPAIR_NATIVE_SCOPE_MISMATCH".to_string());
    }
    let _lease = acquire_lifecycle_lease(&scope)?;

    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|_| "REPAIR_OFFLINE_TRANSACTION_FAILED".to_string())?;

    let existing = transaction
        .query_row(
            "SELECT display_number, status, priority, intake_mode,
                    safe_device_label, due_at, optimistic_version,
                    workspace_nonce, workspace_ciphertext, has_conflict
               FROM repair_cache
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND repair_id = ?4",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                input.repair_id,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, Option<Vec<u8>>>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "REPAIR_CACHE_READ_FAILED".to_string())?;
    let open_conflict: bool = transaction
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM repair_conflicts
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND state = 'open'
             )",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                input.repair_id,
            ],
            |row| row.get(0),
        )
        .map_err(|_| "REPAIR_CONFLICT_CHECK_FAILED".to_string())?;
    if open_conflict || existing.as_ref().is_some_and(|row| row.9 != 0) {
        return Err("REPAIR_CONFLICT_OPEN".to_string());
    }
    let is_create = matches!(&input.command, RepairOfflineCommand::CreateIntake { .. });
    if is_create != existing.is_none() {
        return Err(if is_create {
            "REPAIR_ALREADY_EXISTS"
        } else {
            "REPAIR_NOT_FOUND"
        }
        .to_string());
    }

    let current_status = existing.as_ref().map(|value| value.1.as_str());
    let (next_status, create_priority, create_mode, create_label, create_due) =
        validate_offline_command(&input.command, current_status)?;
    let current_version = existing
        .as_ref()
        .map(|value| u64::try_from(value.6).unwrap_or(u64::MAX))
        .unwrap_or(0);
    if current_version != input.expected_version {
        return Err("REPAIR_OFFLINE_VERSION_CONFLICT".to_string());
    }
    let next_version = current_version
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "REPAIR_OFFLINE_VERSION_INVALID".to_string())?;

    // The sequence is derived from committed aliases and reserved inside this
    // same IMMEDIATE transaction before the canonical envelope is built. A
    // later encryption/queue/cache failure rolls the alias back as well.
    let offline_number = if is_create {
        Some(allocate_offline_alias(
            &transaction,
            &scope,
            &input.repair_id,
            &input.occurred_at,
        )?)
    } else {
        None
    };
    let (command_name, payload) = command_parts(
        &input.command,
        offline_number
            .as_ref()
            .map(|(alias, sequence)| (alias.as_str(), *sequence)),
    )?;
    let envelope = NativeCommandEnvelope {
        operation_id: input.operation_id.clone(),
        repair_id: input.repair_id.clone(),
        expected_version: input.expected_version,
        staff_session_id: input.staff_session_id.clone(),
        command: command_name.to_string(),
        payload,
        occurred_at: input.occurred_at.clone(),
    };
    let mut envelope_json = Zeroizing::new(
        serde_json::to_string(&envelope)
            .map_err(|_| "REPAIR_OFFLINE_ENVELOPE_INVALID".to_string())?,
    );
    let encrypted_queue = encrypt(
        &scope,
        CryptoDomain::Queue,
        "repairs",
        &input.repair_id,
        Some(&input.operation_id),
        input.expected_version,
        envelope_json.as_bytes(),
    )?;
    let stored_queue = Zeroizing::new(store_ciphertext(&scope, &encrypted_queue)?);

    let mut workspace = if let Some(existing) = existing.as_ref() {
        match (&existing.7, &existing.8) {
            (Some(nonce), Some(ciphertext)) => {
                let plaintext = decrypt(
                    &scope,
                    CryptoDomain::Cache,
                    "workspace",
                    &input.repair_id,
                    None,
                    current_version,
                    nonce,
                    ciphertext,
                )?;
                serde_json::from_slice::<PendingWorkspace>(&plaintext)
                    .map_err(|_| "REPAIR_CACHE_DECRYPT_FAILED".to_string())?
            }
            (None, None) => PendingWorkspace::default(),
            _ => return Err("REPAIR_CACHE_CORRUPT".to_string()),
        }
    } else {
        PendingWorkspace::default()
    };
    workspace.operations.push(
        serde_json::from_str(&envelope_json)
            .map_err(|_| "REPAIR_OFFLINE_ENVELOPE_INVALID".to_string())?,
    );
    let mut workspace_json = Zeroizing::new(
        serde_json::to_vec(&workspace).map_err(|_| "REPAIR_CACHE_INVALID".to_string())?,
    );
    let encrypted_workspace = encrypt(
        &scope,
        CryptoDomain::Cache,
        "workspace",
        &input.repair_id,
        None,
        next_version,
        &workspace_json,
    )?;

    let display_number = if is_create {
        let alias = offline_number
            .as_ref()
            .map(|value| value.0.clone())
            .ok_or_else(|| "REPAIR_OFFLINE_BOOTSTRAP_REQUIRED".to_string())?;
        transaction
            .execute(
                "INSERT INTO repair_cache (
                     organization_id, branch_id, terminal_id, repair_id,
                     display_number, provisional_number, status, priority,
                     intake_mode, safe_device_label, due_at,
                     authoritative_version, optimistic_version, scope_generation,
                     workspace_nonce, workspace_ciphertext, dirty, has_conflict,
                     needs_refetch, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'received', ?6, ?7, ?8,
                           ?9, 0, ?10, ?11, ?12, ?13, 1, 0, 0, ?14, ?14)",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    input.repair_id,
                    alias,
                    create_priority,
                    create_mode,
                    create_label,
                    create_due,
                    i64::try_from(next_version).unwrap_or(i64::MAX),
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                    encrypted_workspace.nonce.as_slice(),
                    encrypted_workspace.ciphertext.as_slice(),
                    input.occurred_at,
                ],
            )
            .map_err(|_| "REPAIR_CACHE_INSERT_FAILED".to_string())?;
        alias
    } else {
        let existing = existing.as_ref().expect("checked existing repair");
        transaction
            .execute(
                "UPDATE repair_cache
                    SET status = ?1, optimistic_version = ?2,
                        workspace_nonce = ?3, workspace_ciphertext = ?4,
                        dirty = 1, updated_at = ?5
                  WHERE organization_id = ?6 AND branch_id = ?7 AND terminal_id = ?8
                    AND repair_id = ?9 AND optimistic_version = ?10",
                params![
                    next_status,
                    i64::try_from(next_version).unwrap_or(i64::MAX),
                    encrypted_workspace.nonce.as_slice(),
                    encrypted_workspace.ciphertext.as_slice(),
                    input.occurred_at,
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    input.repair_id,
                    i64::try_from(current_version).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| "REPAIR_CACHE_UPDATE_FAILED".to_string())?;
        existing.0.clone()
    };

    crate::sync_queue::enqueue_repair_with_fixed_id(
        &transaction,
        &input.operation_id,
        &input.repair_id,
        &crate::sync_queue::EnqueueInput {
            table_name: "repairs".to_string(),
            record_id: input.repair_id.clone(),
            operation: "INSERT".to_string(),
            data: stored_queue.to_string(),
            organization_id: scope.organization_id.clone(),
            priority: Some(100),
            module_type: Some("repairs".to_string()),
            conflict_strategy: Some("manual".to_string()),
            version: Some(i64::try_from(input.expected_version).unwrap_or(i64::MAX)),
        },
    )?;
    transaction
        .commit()
        .map_err(|_| "REPAIR_OFFLINE_TRANSACTION_FAILED".to_string())?;
    envelope_json.zeroize();
    workspace_json.zeroize();

    Ok(RepairMutationSnapshot {
        scope_token: scope.scope_token,
        repair_id: input.repair_id.clone(),
        display_number,
        status: next_status,
        optimistic_version: next_version,
        queued_for_sync: true,
        customer_notification_state: "queued_after_sync",
    })
}

/// Convert a direct server 409 for an offline-safe command into the same
/// durable encrypted/manual conflict lifecycle used by parity replay.
///
/// The command is first persisted through the normal atomic offline producer,
/// then claimed natively and handed to the queue conflict hook. If conflict
/// persistence fails, the claim is returned to `pending`; the operation ID
/// remains durable and replay-safe instead of being lost after the HTTP 409.
pub(crate) fn park_direct_command_conflict(
    connection: &Connection,
    access: &RepairRendererAccess,
    input: &RepairOfflineMutationInput,
    conflict: &crate::repair_transport::RepairConflictProjection,
) -> Result<RepairConflictRecord, String> {
    let scope = renderer_scope(connection, access)?;
    if conflict.operation_id != input.operation_id
        || conflict.repair_id != input.repair_id
        || conflict.expected_version != input.expected_version
    {
        return Err("REPAIR_CONFLICT_INVALID".to_string());
    }
    apply_offline_mutation(connection, input)?;
    let claimed_at = chrono::Utc::now().to_rfc3339();
    let claim_generation = connection
        .query_row(
            "UPDATE parity_sync_queue
                SET status = 'processing', last_attempt = ?1,
                    claim_generation = claim_generation + 1
              WHERE id = ?2 AND organization_id = ?3
                AND lower(trim(COALESCE(module_type, ''))) = 'repairs'
                AND lower(trim(COALESCE(table_name, ''))) = 'repairs'
                AND record_id = ?4 AND repair_aggregate_id = ?4
                AND operation = 'INSERT' AND conflict_strategy = 'manual'
                AND version = ?5 AND status = 'pending'
              RETURNING claim_generation",
            params![
                claimed_at,
                input.operation_id,
                scope.organization_id,
                input.repair_id,
                i64::try_from(input.expected_version).unwrap_or(i64::MAX),
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "REPAIR_CONFLICT_CLAIM_INVALID".to_string())?;
    let context = crate::repair_transport::RepairQueueContext {
        queue_id: input.operation_id.clone(),
        claim_generation,
        repair_id: input.repair_id.clone(),
        operation_id: input.operation_id.clone(),
        organization_id: scope.organization_id.clone(),
        expected_version: input.expected_version,
    };
    if crate::repair_transport::RepairQueueHooks::park_conflict(
        &NATIVE_REPAIR_QUEUE_HOOKS,
        connection,
        &context,
        conflict,
    )
    .is_err()
    {
        let _ = connection.execute(
            "UPDATE parity_sync_queue
                SET status = 'pending', next_retry_at = NULL,
                    error_message = 'REPAIR_CONFLICT_PERSIST_RETRY',
                    claim_generation = claim_generation + 1
              WHERE id = ?1 AND organization_id = ?2
                AND status = 'processing' AND claim_generation = ?3",
            params![input.operation_id, scope.organization_id, claim_generation],
        );
        return Err("REPAIR_CONFLICT_STORE_FAILED".to_string());
    }
    list_open_conflicts(connection, access)?
        .into_iter()
        .find(|row| row.conflict_id == input.operation_id)
        .ok_or_else(|| "REPAIR_CONFLICT_STORE_FAILED".to_string())
}

fn valid_private_text(value: &str, maximum: usize) -> bool {
    value.trim() == value
        && !value.is_empty()
        && value.encode_utf16().count() <= maximum
        && !value.chars().any(char::is_control)
}

fn attachment_final_path(
    connection: &Connection,
    scope: &RepairScopeState,
    file_key: &str,
) -> Result<PathBuf, String> {
    if canonical_uuid(file_key).is_none() {
        return Err("REPAIR_ATTACHMENT_FILE_KEY_INVALID".to_string());
    }
    Ok(scope_staging_dir(connection, scope)?.join(format!("{file_key}.bin")))
}

#[cfg(unix)]
fn sync_staging_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_staging_directory(_path: &Path) -> std::io::Result<()> {
    // Windows does not expose a portable directory fsync. The rename seam
    // below uses MOVEFILE_WRITE_THROUGH, which is the platform durability
    // primitive for flushing the move before returning.
    Ok(())
}

#[cfg(unix)]
fn durable_staging_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn durable_staging_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 buffers are NUL-terminated and live for the call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn validate_attachment_input(input: &RepairAttachmentStageInput) -> Result<(), String> {
    if canonical_uuid(&input.attachment_id).is_none()
        || canonical_uuid(&input.operation_id).is_none()
        || canonical_uuid(&input.repair_id).is_none()
        || canonical_uuid(&input.staff_session_id).is_none()
        || input.expected_version > MAX_SAFE_INTEGER
        || !validate_timestamp(&input.occurred_at)
        || !matches!(
            input.attachment_type.as_str(),
            "intake" | "diagnostic" | "repair" | "quality_check" | "handover" | "other"
        )
        || !valid_private_text(&input.filename, 255)
        || input
            .caption
            .as_deref()
            .is_some_and(|value| !valid_private_text(value, 1_000))
        || !matches!(
            input.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
        )
        || input.bytes.is_empty()
        || input.bytes.len() > MAX_ATTACHMENT_BYTES
    {
        return Err("REPAIR_ATTACHMENT_METADATA_INVALID".to_string());
    }
    Ok(())
}

pub(crate) fn stage_attachment(
    connection: &Connection,
    input: &RepairAttachmentStageInput,
) -> Result<RepairAttachmentStageSnapshot, String> {
    validate_attachment_input(input)?;
    let scope = active_scope()?;
    require_entitlement(&scope)?;
    crate::repair_transport::authorize_repair_actor(
        &crate::repair_transport::NativeRepairScope {
            organization_id: scope.organization_id.clone(),
            branch_id: scope.branch_id.clone(),
            terminal_id: scope.terminal_id.clone(),
        },
        &input.staff_session_id,
        "repairs.attachments",
        chrono::Utc::now(),
    )
    .map_err(|error| error.code().to_string())?;
    let runtime = runtime_scope_identity(connection)?;
    if !scope_matches_identity(&scope, &runtime.0, &runtime.1, &runtime.2) {
        return Err("REPAIR_NATIVE_SCOPE_MISMATCH".to_string());
    }
    let _lease = acquire_lifecycle_lease(&scope)?;
    let file_key = Uuid::new_v4().to_string();
    let directory = scope_staging_dir(connection, &scope)?;
    let final_path = attachment_final_path(connection, &scope, &file_key)?;
    let part_path = directory.join(format!("{file_key}.part"));
    let db_result = (|| -> Result<u64, String> {
        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| "REPAIR_ATTACHMENT_TRANSACTION_FAILED".to_string())?;
        let (optimistic, workspace_nonce, workspace_ciphertext, has_conflict): (
            i64,
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            i64,
        ) = transaction
            .query_row(
                "SELECT optimistic_version, workspace_nonce, workspace_ciphertext,
                        has_conflict
                   FROM repair_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND scope_generation = ?5",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    input.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| "REPAIR_NOT_FOUND".to_string())?;
        let open_conflict: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM repair_conflicts
                      WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                        AND repair_id = ?4 AND state = 'open'
                 )",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    input.repair_id,
                ],
                |row| row.get(0),
            )
            .map_err(|_| "REPAIR_CONFLICT_CHECK_FAILED".to_string())?;
        if has_conflict != 0 || open_conflict {
            return Err("REPAIR_CONFLICT_OPEN".to_string());
        }
        let optimistic = u64::try_from(optimistic).unwrap_or(u64::MAX);
        if optimistic != input.expected_version {
            return Err("REPAIR_OFFLINE_VERSION_CONFLICT".to_string());
        }
        let next_version = optimistic
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| "REPAIR_OFFLINE_VERSION_INVALID".to_string())?;
        let mut workspace = match (&workspace_nonce, &workspace_ciphertext) {
            (Some(nonce), Some(ciphertext)) => {
                let plaintext = decrypt(
                    &scope,
                    CryptoDomain::Cache,
                    "workspace",
                    &input.repair_id,
                    None,
                    optimistic,
                    nonce,
                    ciphertext,
                )?;
                serde_json::from_slice::<PendingWorkspace>(&plaintext)
                    .map_err(|_| "REPAIR_CACHE_INVALID".to_string())?
            }
            (None, None) => PendingWorkspace::default(),
            _ => return Err("REPAIR_CACHE_CORRUPT".to_string()),
        };
        workspace.operations.push(serde_json::json!({
            "operation_id": input.operation_id,
            "repair_id": input.repair_id,
            "expected_version": input.expected_version,
            "staff_session_id": input.staff_session_id,
            "command": "stage_attachment",
            "payload": { "attachment_id": input.attachment_id },
            "occurred_at": input.occurred_at,
        }));
        let workspace_json = Zeroizing::new(
            serde_json::to_vec(&workspace).map_err(|_| "REPAIR_CACHE_INVALID".to_string())?,
        );
        let encrypted_workspace = encrypt(
            &scope,
            CryptoDomain::Cache,
            "workspace",
            &input.repair_id,
            None,
            next_version,
            &workspace_json,
        )?;

        let sha256_hex = format!("{:x}", Sha256::digest(&input.bytes));
        let metadata = AttachmentPrivateMetadata {
            attachment_id: input.attachment_id.clone(),
            operation_id: input.operation_id.clone(),
            staff_session_id: input.staff_session_id.clone(),
            expected_version: input.expected_version,
            occurred_at: input.occurred_at.clone(),
            attachment_type: input.attachment_type.clone(),
            filename: input.filename.clone(),
            caption: input.caption.clone(),
            mime_type: input.mime_type.clone(),
            byte_size: u64::try_from(input.bytes.len()).unwrap_or(u64::MAX),
            sha256_hex: sha256_hex.clone(),
        };
        let metadata_json = Zeroizing::new(
            serde_json::to_vec(&metadata)
                .map_err(|_| "REPAIR_ATTACHMENT_METADATA_INVALID".to_string())?,
        );
        let attachment_identity =
            attachment_entity_identity(&input.repair_id, &input.attachment_id)?;
        let encrypted_metadata = encrypt(
            &scope,
            CryptoDomain::AttachmentMetadata,
            "repair_attachments",
            &attachment_identity,
            Some(&input.operation_id),
            input.expected_version,
            &metadata_json,
        )?;
        let encrypted_bytes = encrypt(
            &scope,
            CryptoDomain::AttachmentBytes,
            "repair_attachments",
            &attachment_identity,
            Some(&input.operation_id),
            input.expected_version,
            &input.bytes,
        )?;
        fs::create_dir_all(&directory).map_err(|_| "REPAIR_ATTACHMENT_STAGE_FAILED".to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|_| "REPAIR_ATTACHMENT_STAGE_FAILED".to_string())?;
        file.write_all(&encrypted_bytes.nonce)
            .and_then(|_| file.write_all(&encrypted_bytes.ciphertext))
            .map_err(|_| "REPAIR_ATTACHMENT_STAGE_FAILED".to_string())?;
        file.sync_all()
            .map_err(|_| "REPAIR_ATTACHMENT_STAGE_FAILED".to_string())?;
        durable_staging_rename(&part_path, &final_path)
            .map_err(|_| "REPAIR_ATTACHMENT_STAGE_FAILED".to_string())?;
        sync_staging_directory(&directory)
            .map_err(|_| "REPAIR_ATTACHMENT_STAGE_FAILED".to_string())?;

        transaction
            .execute(
                "INSERT INTO repair_attachment_staging (
                     organization_id, branch_id, terminal_id, attachment_id,
                     repair_id, operation_id, queue_id, expected_version,
                     scope_generation, file_key, metadata_nonce,
                     metadata_ciphertext, sha256_hex, mime_type, size_bytes,
                     state, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10,
                           ?11, ?12, ?13, ?14, 'queued', ?15, ?15)",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    input.attachment_id,
                    input.repair_id,
                    input.operation_id,
                    i64::try_from(input.expected_version).unwrap_or(i64::MAX),
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                    file_key,
                    encrypted_metadata.nonce.as_slice(),
                    encrypted_metadata.ciphertext.as_slice(),
                    sha256_hex,
                    input.mime_type,
                    i64::try_from(input.bytes.len()).unwrap_or(i64::MAX),
                    input.occurred_at,
                ],
            )
            .map_err(|_| "REPAIR_ATTACHMENT_STAGE_INSERT_FAILED".to_string())?;
        let stored_metadata = Zeroizing::new(store_ciphertext(&scope, &encrypted_metadata)?);
        crate::sync_queue::enqueue_repair_with_fixed_id(
            &transaction,
            &input.operation_id,
            &input.repair_id,
            &crate::sync_queue::EnqueueInput {
                table_name: "repair_attachments".to_string(),
                record_id: input.attachment_id.clone(),
                operation: "INSERT".to_string(),
                data: stored_metadata.to_string(),
                organization_id: scope.organization_id.clone(),
                priority: Some(90),
                module_type: Some("repairs".to_string()),
                conflict_strategy: Some("manual".to_string()),
                version: Some(i64::try_from(input.expected_version).unwrap_or(i64::MAX)),
            },
        )?;
        let updated = transaction
            .execute(
                "UPDATE repair_cache
                    SET optimistic_version = ?1, workspace_nonce = ?2,
                        workspace_ciphertext = ?3, dirty = 1, updated_at = ?4
                  WHERE organization_id = ?5 AND branch_id = ?6 AND terminal_id = ?7
                    AND repair_id = ?8 AND optimistic_version = ?9",
                params![
                    i64::try_from(next_version).unwrap_or(i64::MAX),
                    encrypted_workspace.nonce.as_slice(),
                    encrypted_workspace.ciphertext.as_slice(),
                    input.occurred_at,
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    input.repair_id,
                    i64::try_from(optimistic).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| "REPAIR_CACHE_UPDATE_FAILED".to_string())?;
        if updated != 1 {
            return Err("REPAIR_CACHE_UPDATE_FAILED".to_string());
        }
        transaction
            .commit()
            .map_err(|_| "REPAIR_ATTACHMENT_TRANSACTION_FAILED".to_string())?;
        Ok(next_version)
    })();
    let optimistic_version = match db_result {
        Ok(version) => version,
        Err(error) => {
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
    };

    Ok(RepairAttachmentStageSnapshot {
        scope_token: scope.scope_token,
        repair_id: input.repair_id.clone(),
        attachment_id: input.attachment_id.clone(),
        optimistic_version,
        queued_for_sync: true,
    })
}

fn hook_unavailable(_error: String) -> crate::repair_transport::RepairHookError {
    crate::repair_transport::RepairHookError::unavailable("REPAIR_NATIVE_STATE_UNAVAILABLE")
}

fn hook_permanent(_error: String) -> crate::repair_transport::RepairHookError {
    crate::repair_transport::RepairHookError::permanent("REPAIR_LOCAL_CIPHERTEXT_INVALID")
}

fn persisted_repair_aggregate(
    connection: &Connection,
    item: &crate::sync_queue::SyncQueueItem,
) -> Result<String, crate::repair_transport::RepairHookError> {
    let stored = connection
        .query_row(
            "SELECT repair_aggregate_id
               FROM parity_sync_queue
              WHERE id = ?1 AND table_name = ?2 AND record_id = ?3
                AND operation = ?4 AND organization_id = ?5
                AND COALESCE(module_type, '') = 'repairs'
                AND conflict_strategy = 'manual' AND version = ?6",
            params![
                item.id,
                item.table_name,
                item.record_id,
                item.operation,
                item.organization_id,
                item.version,
            ],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| hook_unavailable(String::new()))?;
    let aggregate = stored.flatten().ok_or_else(|| {
        crate::repair_transport::RepairHookError::permanent(
            "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID",
        )
    })?;
    canonical_uuid(&aggregate).ok_or_else(|| {
        crate::repair_transport::RepairHookError::permanent(
            "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID",
        )
    })
}

fn decode_queue_envelope(
    connection: &Connection,
    item: &crate::sync_queue::SyncQueueItem,
) -> Result<Zeroizing<String>, crate::repair_transport::RepairHookError> {
    let scope = active_scope().map_err(hook_unavailable)?;
    require_entitlement(&scope).map_err(hook_unavailable)?;
    if item.id != item.record_id && item.table_name == "repair_attachments" {
        // Attachment queue ids bind to attachment operations, not repair ids;
        // their stronger row-level checks live in the attachment decoder.
    }
    if item.module_type != "repairs"
        || item.table_name != "repairs"
        || item.operation != "INSERT"
        || item.conflict_strategy != "manual"
        || item.organization_id != scope.organization_id
        || canonical_uuid(&item.id).is_none()
        || canonical_uuid(&item.record_id).is_none()
        || item.version < 0
        || item.version > i64::try_from(MAX_SAFE_INTEGER).unwrap_or(i64::MAX)
    {
        return Err(crate::repair_transport::RepairHookError::permanent(
            "REPAIR_QUEUE_IDENTITY_INVALID",
        ));
    }
    if persisted_repair_aggregate(connection, item)? != item.record_id {
        return Err(crate::repair_transport::RepairHookError::permanent(
            "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID",
        ));
    }
    let plaintext = open_stored_ciphertext(
        &scope,
        CryptoDomain::Queue,
        "repairs",
        &item.record_id,
        Some(&item.id),
        u64::try_from(item.version).unwrap_or(u64::MAX),
        &item.data,
    )
    .map_err(hook_permanent)?;
    let decoded = std::str::from_utf8(&plaintext)
        .map_err(|_| {
            crate::repair_transport::RepairHookError::permanent("REPAIR_LOCAL_CIPHERTEXT_INVALID")
        })?
        .to_string();
    Ok(Zeroizing::new(decoded))
}

fn parse_and_validate_envelope(
    connection: &Connection,
    scope: &RepairScopeState,
    context: &crate::repair_transport::RepairQueueContext,
    decoded: &str,
) -> Result<(), crate::repair_transport::RepairHookError> {
    if decoded.len() > 256 * 1024 {
        return Err(crate::repair_transport::RepairHookError::permanent(
            "REPAIR_COMMAND_ENVELOPE_INVALID",
        ));
    }
    let mut envelope: NativeCommandEnvelope = serde_json::from_str(decoded).map_err(|_| {
        crate::repair_transport::RepairHookError::permanent("REPAIR_COMMAND_ENVELOPE_INVALID")
    })?;
    if envelope.operation_id != context.operation_id
        || envelope.operation_id != context.queue_id
        || envelope.repair_id != context.repair_id
        || envelope.expected_version != context.expected_version
        || !validate_timestamp(&envelope.occurred_at)
    {
        return Err(crate::repair_transport::RepairHookError::permanent(
            "REPAIR_COMMAND_ENVELOPE_INVALID",
        ));
    }

    let mut tagged = envelope.payload.clone();
    let tagged_object = tagged.as_object_mut().ok_or_else(|| {
        crate::repair_transport::RepairHookError::permanent("REPAIR_COMMAND_ENVELOPE_INVALID")
    })?;
    tagged_object.insert(
        "type".to_string(),
        serde_json::Value::String(envelope.command.clone()),
    );
    let mut command: RepairOfflineCommand = serde_json::from_value(tagged).map_err(|_| {
        crate::repair_transport::RepairHookError::permanent("REPAIR_COMMAND_ENVELOPE_INVALID")
    })?;
    if let RepairOfflineCommand::CreateIntake {
        offline_alias,
        offline_sequence,
        ..
    } = &mut command
    {
        let alias = offline_alias.as_deref().ok_or_else(|| {
            crate::repair_transport::RepairHookError::permanent("REPAIR_COMMAND_ENVELOPE_INVALID")
        })?;
        let sequence = offline_sequence.ok_or_else(|| {
            crate::repair_transport::RepairHookError::permanent("REPAIR_COMMAND_ENVELOPE_INVALID")
        })?;
        let expected_alias = format!(
            "R-OFF-{}-{sequence:06}",
            scope.offline_terminal_token.as_deref().ok_or_else(|| {
                crate::repair_transport::RepairHookError::unavailable(
                    "REPAIR_OFFLINE_BOOTSTRAP_REQUIRED",
                )
            })?
        );
        let alias_matches: bool = connection
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM repair_alias_cache
                      WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                        AND alias = ?4 AND repair_id = ?5
                 )",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    alias,
                    context.repair_id,
                ],
                |row| row.get(0),
            )
            .map_err(|_| {
                crate::repair_transport::RepairHookError::unavailable(
                    "REPAIR_NATIVE_STATE_UNAVAILABLE",
                )
            })?;
        if alias != expected_alias || !alias_matches {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_COMMAND_ENVELOPE_INVALID",
            ));
        }
        *offline_alias = None;
        *offline_sequence = None;
    }
    validate_trusted_drain_command_shape(&command).map_err(|_| {
        crate::repair_transport::RepairHookError::permanent("REPAIR_COMMAND_ENVELOPE_INVALID")
    })?;
    zeroize_json(&mut envelope.payload);
    Ok(())
}

pub(crate) struct NativeRepairQueueHooks;

pub(crate) static NATIVE_REPAIR_QUEUE_HOOKS: NativeRepairQueueHooks = NativeRepairQueueHooks;

struct WorkspaceOperationProjection {
    operation_id: String,
    repair_id: String,
    expected_version: u64,
    target_status: Option<String>,
    attachment_id: Option<String>,
    provisional_alias: Option<String>,
    has_reason: bool,
}

impl Drop for WorkspaceOperationProjection {
    fn drop(&mut self) {
        self.operation_id.zeroize();
        self.repair_id.zeroize();
        if let Some(target_status) = self.target_status.as_mut() {
            target_status.zeroize();
        }
        self.target_status = None;
        if let Some(attachment_id) = self.attachment_id.as_mut() {
            attachment_id.zeroize();
        }
        self.attachment_id = None;
        if let Some(provisional_alias) = self.provisional_alias.as_mut() {
            provisional_alias.zeroize();
        }
        self.provisional_alias = None;
        self.expected_version = 0;
        self.has_reason = false;
    }
}

fn reconciliation_invalid() -> crate::repair_transport::RepairHookError {
    crate::repair_transport::RepairHookError::permanent("REPAIR_RECONCILIATION_INVALID")
}

fn parse_workspace_operation(
    connection: &Connection,
    scope: &RepairScopeState,
    value: &serde_json::Value,
) -> Result<WorkspaceOperationProjection, crate::repair_transport::RepairHookError> {
    let mut envelope: NativeCommandEnvelope =
        serde_json::from_value(value.clone()).map_err(|_| reconciliation_invalid())?;
    if canonical_uuid(&envelope.operation_id).is_none()
        || canonical_uuid(&envelope.repair_id).is_none()
        || canonical_uuid(&envelope.staff_session_id).is_none()
        || envelope.expected_version > MAX_SAFE_INTEGER
        || !validate_timestamp(&envelope.occurred_at)
    {
        return Err(reconciliation_invalid());
    }

    if envelope.command == "stage_attachment" {
        let payload = envelope
            .payload
            .as_object()
            .filter(|payload| payload.len() == 1)
            .ok_or_else(reconciliation_invalid)?;
        let attachment_id = payload
            .get("attachment_id")
            .and_then(serde_json::Value::as_str)
            .and_then(canonical_uuid)
            .ok_or_else(reconciliation_invalid)?;
        return Ok(WorkspaceOperationProjection {
            operation_id: envelope.operation_id.clone(),
            repair_id: envelope.repair_id.clone(),
            expected_version: envelope.expected_version,
            target_status: None,
            attachment_id: Some(attachment_id),
            provisional_alias: None,
            has_reason: false,
        });
    }

    let mut tagged = envelope.payload.clone();
    tagged
        .as_object_mut()
        .ok_or_else(reconciliation_invalid)?
        .insert(
            "type".to_string(),
            serde_json::Value::String(envelope.command.clone()),
        );
    let mut command: RepairOfflineCommand =
        serde_json::from_value(tagged).map_err(|_| reconciliation_invalid())?;
    let mut provisional_alias = None;
    if let RepairOfflineCommand::CreateIntake {
        offline_alias,
        offline_sequence,
        ..
    } = &mut command
    {
        let alias = offline_alias
            .as_deref()
            .ok_or_else(reconciliation_invalid)?;
        let sequence = offline_sequence.ok_or_else(reconciliation_invalid)?;
        let expected_alias = format!(
            "R-OFF-{}-{sequence:06}",
            scope
                .offline_terminal_token
                .as_deref()
                .ok_or_else(reconciliation_invalid)?
        );
        if alias != expected_alias {
            return Err(reconciliation_invalid());
        }
        let alias_owner = connection
            .query_row(
                "SELECT repair_id FROM repair_alias_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND alias = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    alias,
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| hook_unavailable(String::new()))?;
        match alias_owner.as_deref() {
            Some(owner) if owner == envelope.repair_id.as_str() => {}
            Some(_) => {
                return Err(crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_RECONCILIATION_ALIAS_CONFLICT",
                ));
            }
            None => return Err(reconciliation_invalid()),
        }
        provisional_alias = Some(alias.to_string());
        *offline_alias = None;
        *offline_sequence = None;
    }
    validate_trusted_drain_command_shape(&command).map_err(|_| reconciliation_invalid())?;
    let (target_status, has_reason) = match &command {
        RepairOfflineCommand::TransitionStatus {
            target_status,
            reason,
            ..
        } => (Some(target_status.clone()), reason.is_some()),
        _ => (None, false),
    };
    zeroize_json(&mut envelope.payload);
    Ok(WorkspaceOperationProjection {
        operation_id: envelope.operation_id.clone(),
        repair_id: envelope.repair_id.clone(),
        expected_version: envelope.expected_version,
        target_status,
        attachment_id: None,
        provisional_alias,
        has_reason,
    })
}

fn replay_transition_allowed(current: &str, target: &str, has_reason: bool) -> bool {
    let graph_allows = matches!(
        (current, target),
        ("received", "diagnosing")
            | ("diagnosing", "waiting_customer_approval")
            | ("approved", "waiting_parts")
            | ("approved", "repairing")
            | ("waiting_parts", "repairing")
            | ("repairing", "waiting_parts")
            | ("repairing", "quality_check")
            | ("quality_check", "repairing")
            | ("quality_check", "ready")
    );
    graph_allows && (current != "quality_check" || target != "repairing" || has_reason)
}

fn workspace_projections_are_unique(projections: &[WorkspaceOperationProjection]) -> bool {
    let mut operation_ids = HashSet::with_capacity(projections.len());
    let mut expected_versions = HashSet::with_capacity(projections.len());
    let mut attachment_ids = HashSet::with_capacity(projections.len());
    projections.iter().all(|projection| {
        operation_ids.insert(projection.operation_id.as_str())
            && expected_versions.insert(projection.expected_version)
            && projection
                .attachment_id
                .as_deref()
                .map_or(true, |attachment_id| attachment_ids.insert(attachment_id))
    })
}

impl crate::repair_transport::RepairQueueHooks for NativeRepairQueueHooks {
    fn decode_attachment_upload(
        &self,
        connection: &Connection,
        item: &crate::sync_queue::SyncQueueItem,
    ) -> Result<
        crate::repair_transport::RepairRawAttachmentUpload,
        crate::repair_transport::RepairHookError,
    > {
        let scope = active_scope().map_err(hook_unavailable)?;
        require_entitlement(&scope).map_err(hook_unavailable)?;
        if item.module_type != "repairs"
            || item.table_name != "repair_attachments"
            || item.operation != "INSERT"
            || item.conflict_strategy != "manual"
            || item.organization_id != scope.organization_id
            || canonical_uuid(&item.id).is_none()
            || canonical_uuid(&item.record_id).is_none()
            || item.version < 0
            || item.version > i64::try_from(MAX_SAFE_INTEGER).unwrap_or(i64::MAX)
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_QUEUE_INVALID",
            ));
        }
        let persisted_aggregate = persisted_repair_aggregate(connection, item)?;
        let row = connection
            .query_row(
                "SELECT repair_id, operation_id, expected_version, scope_generation,
                        file_key, metadata_nonce, metadata_ciphertext, sha256_hex,
                        mime_type, size_bytes, state
                   FROM repair_attachment_staging
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND attachment_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    item.record_id,
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                        row.get::<_, Vec<u8>>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| hook_unavailable(String::new()))?
            .ok_or_else(|| {
                crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_ATTACHMENT_STAGE_MISSING",
                )
            })?;
        let expected_version = u64::try_from(row.2).unwrap_or(u64::MAX);
        if persisted_aggregate != row.0 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID",
            ));
        }
        if row.1 != item.id
            || expected_version != u64::try_from(item.version).unwrap_or(u64::MAX)
            || row.3 != i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX)
            || row.10 != "queued"
            || row.9 <= 0
            || row.9 > i64::try_from(MAX_ATTACHMENT_BYTES).unwrap_or(i64::MAX)
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_STAGE_INVALID",
            ));
        }
        let attachment_identity =
            attachment_entity_identity(&row.0, &item.record_id).map_err(hook_permanent)?;
        let metadata_plaintext = decrypt(
            &scope,
            CryptoDomain::AttachmentMetadata,
            "repair_attachments",
            &attachment_identity,
            Some(&item.id),
            expected_version,
            &row.5,
            &row.6,
        )
        .map_err(hook_permanent)?;
        let metadata: AttachmentPrivateMetadata = serde_json::from_slice(&metadata_plaintext)
            .map_err(|_| hook_permanent(String::new()))?;
        let path = attachment_final_path(connection, &scope, &row.4).map_err(hook_permanent)?;
        let file_length = fs::metadata(&path)
            .map_err(|_| hook_unavailable(String::new()))?
            .len();
        if file_length != u64::try_from(row.9).unwrap_or(u64::MAX) + 12 + 16 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_STAGE_INVALID",
            ));
        }
        let stored_bytes =
            Zeroizing::new(fs::read(&path).map_err(|_| hook_unavailable(String::new()))?);
        let (nonce, ciphertext) = stored_bytes.split_at(12);
        let bytes = decrypt(
            &scope,
            CryptoDomain::AttachmentBytes,
            "repair_attachments",
            &attachment_identity,
            Some(&item.id),
            expected_version,
            nonce,
            ciphertext,
        )
        .map_err(hook_permanent)?;
        if metadata.attachment_id != item.record_id
            || metadata.operation_id != item.id
            || metadata.expected_version != expected_version
            || metadata.sha256_hex != row.7
            || metadata.mime_type != row.8
            || metadata.byte_size != u64::try_from(row.9).unwrap_or(u64::MAX)
            || format!("{:x}", Sha256::digest(&bytes)) != metadata.sha256_hex
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_STAGE_INVALID",
            ));
        }
        Ok(crate::repair_transport::RepairRawAttachmentUpload {
            repair_id: row.0,
            metadata: crate::repair_transport::RepairRawAttachmentMetadata {
                attachment_id: metadata.attachment_id.clone(),
                operation_id: metadata.operation_id.clone(),
                staff_session_id: metadata.staff_session_id.clone(),
                expected_version: metadata.expected_version,
                occurred_at: metadata.occurred_at.clone(),
                attachment_type: metadata.attachment_type.clone(),
                filename: metadata.filename.clone(),
                caption: metadata.caption.clone(),
                mime_type: metadata.mime_type.clone(),
                byte_size: metadata.byte_size,
                sha256_hex: metadata.sha256_hex.clone(),
            },
            bytes,
        })
    }

    fn decode_command_envelope(
        &self,
        connection: &Connection,
        item: &crate::sync_queue::SyncQueueItem,
    ) -> Result<Zeroizing<String>, crate::repair_transport::RepairHookError> {
        decode_queue_envelope(connection, item)
    }

    fn before_dispatch(
        &self,
        connection: &Connection,
        context: &crate::repair_transport::RepairQueueContext,
    ) -> Result<(), crate::repair_transport::RepairHookError> {
        let scope = active_scope().map_err(hook_unavailable)?;
        require_entitlement(&scope).map_err(hook_unavailable)?;
        if context.organization_id != scope.organization_id
            || context.queue_id != context.operation_id
            || canonical_uuid(&context.repair_id).is_none()
            || context.expected_version > MAX_SAFE_INTEGER
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_QUEUE_IDENTITY_INVALID",
            ));
        }
        let matches_scope: bool = connection
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM repair_cache
                      WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                        AND repair_id = ?4 AND scope_generation = ?5
                 )",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
                |row| row.get(0),
            )
            .map_err(|_| {
                crate::repair_transport::RepairHookError::unavailable(
                    "REPAIR_NATIVE_STATE_UNAVAILABLE",
                )
            })?;
        if !matches_scope {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_SCOPE_EPOCH_MISMATCH",
            ));
        }
        Ok(())
    }

    fn validate_command_envelope(
        &self,
        connection: &Connection,
        context: &crate::repair_transport::RepairQueueContext,
        decoded_envelope: &str,
    ) -> Result<(), crate::repair_transport::RepairHookError> {
        let scope = active_scope().map_err(hook_unavailable)?;
        parse_and_validate_envelope(connection, &scope, context, decoded_envelope)
    }

    fn reconcile_success(
        &self,
        connection: &Connection,
        context: &crate::repair_transport::RepairQueueContext,
        signal: &crate::repair_transport::RepairSyncSuccessSignal,
    ) -> Result<(), crate::repair_transport::RepairHookError> {
        let scope = active_scope().map_err(hook_unavailable)?;
        if context.organization_id != scope.organization_id
            || context.queue_id != context.operation_id
            || canonical_uuid(&context.queue_id).is_none()
            || canonical_uuid(&context.repair_id).is_none()
            || signal.repair_id != context.repair_id
            || signal.version <= context.expected_version
            || signal.version > MAX_SAFE_INTEGER
        {
            return Err(reconciliation_invalid());
        }

        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| hook_unavailable(String::new()))?;
        let row = transaction
            .query_row(
                "SELECT display_number, official_number, status, authoritative_status,
                        authoritative_version, optimistic_version,
                        workspace_nonce, workspace_ciphertext
                   FROM repair_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND scope_generation = ?5",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, Option<Vec<u8>>>(6)?,
                        row.get::<_, Option<Vec<u8>>>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| hook_unavailable(String::new()))?
            .ok_or_else(|| {
                crate::repair_transport::RepairHookError::permanent("REPAIR_RECONCILIATION_MISSING")
            })?;
        let authoritative_version = u64::try_from(row.4).unwrap_or(u64::MAX);
        let optimistic = u64::try_from(row.5).unwrap_or(u64::MAX);
        if authoritative_version > MAX_SAFE_INTEGER
            || optimistic > MAX_SAFE_INTEGER
            || signal.version == authoritative_version && signal.status.as_str() != row.3
        {
            return Err(reconciliation_invalid());
        }
        if signal.display_number.as_deref().is_some_and(|incoming| {
            row.1
                .as_deref()
                .is_some_and(|official| official != incoming)
                || row.1.is_none() && signal.version < authoritative_version
        }) {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_RECONCILIATION_OFFICIAL_MISMATCH",
            ));
        }
        let mut workspace = match (&row.6, &row.7) {
            (Some(nonce), Some(ciphertext)) => {
                let plaintext = decrypt(
                    &scope,
                    CryptoDomain::Cache,
                    "workspace",
                    &context.repair_id,
                    None,
                    optimistic,
                    nonce,
                    ciphertext,
                )
                .map_err(hook_permanent)?;
                serde_json::from_slice::<PendingWorkspace>(&plaintext)
                    .map_err(|_| hook_permanent(String::new()))?
            }
            (None, None) => PendingWorkspace::default(),
            _ => return Err(hook_permanent(String::new())),
        };

        let mut projections = Vec::with_capacity(workspace.operations.len());
        let mut source_index = None;
        for (index, operation) in workspace.operations.iter().enumerate() {
            let projection = parse_workspace_operation(&transaction, &scope, operation)?;
            if projection.repair_id != context.repair_id {
                return Err(reconciliation_invalid());
            }
            if projection.operation_id == context.operation_id
                && (projection.expected_version != context.expected_version
                    || projection.attachment_id.is_some()
                    || source_index.replace(index).is_some())
            {
                return Err(reconciliation_invalid());
            }
            projections.push(projection);
        }
        if !workspace_projections_are_unique(&projections) {
            return Err(reconciliation_invalid());
        }
        let source_index = source_index.ok_or_else(reconciliation_invalid)?;
        if projections[source_index].provisional_alias.as_deref()
            != signal.provisional_alias.as_deref()
        {
            return Err(reconciliation_invalid());
        }
        workspace.operations.remove(source_index);
        projections.remove(source_index);
        projections.sort_by(|left, right| {
            left.expected_version
                .cmp(&right.expected_version)
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });

        let (next_authoritative_status, next_authoritative_version) =
            if signal.version > authoritative_version {
                (signal.status.as_str().to_string(), signal.version)
            } else {
                (row.3.clone(), authoritative_version)
            };
        let mut projected_status = next_authoritative_status.clone();
        for projection in projections
            .iter()
            .filter(|projection| projection.expected_version >= next_authoritative_version)
        {
            if let Some(target_status) = projection.target_status.as_deref() {
                if !replay_transition_allowed(
                    &projected_status,
                    target_status,
                    projection.has_reason,
                ) {
                    return Err(reconciliation_invalid());
                }
                projected_status = target_status.to_string();
            }
        }
        let next_optimistic =
            projections
                .iter()
                .try_fold(next_authoritative_version, |maximum, projection| {
                    projection
                        .expected_version
                        .checked_add(1)
                        .filter(|version| *version <= MAX_SAFE_INTEGER)
                        .map(|version| maximum.max(version))
                        .ok_or_else(reconciliation_invalid)
                })?;
        let workspace_json = Zeroizing::new(
            serde_json::to_vec(&workspace).map_err(|_| hook_permanent(String::new()))?,
        );
        let encrypted = encrypt(
            &scope,
            CryptoDomain::Cache,
            "workspace",
            &context.repair_id,
            None,
            next_optimistic,
            &workspace_json,
        )
        .map_err(hook_unavailable)?;

        let mut aliases = BTreeMap::new();
        if let Some(alias) = signal.display_number.as_deref() {
            aliases.insert(alias, true);
        }
        if let Some(alias) = signal.provisional_alias.as_deref() {
            aliases
                .entry(alias)
                .and_modify(|is_official| {
                    *is_official |= signal.display_number.as_deref() == Some(alias)
                })
                .or_insert(signal.display_number.as_deref() == Some(alias));
        }
        for (alias, is_official) in aliases {
            let existing = transaction
                .query_row(
                    "SELECT repair_id FROM repair_alias_cache
                      WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                        AND alias = ?4",
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        alias,
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|_| hook_unavailable(String::new()))?;
            match existing {
                Some(repair_id) if repair_id != context.repair_id => {
                    return Err(crate::repair_transport::RepairHookError::permanent(
                        "REPAIR_RECONCILIATION_ALIAS_CONFLICT",
                    ));
                }
                Some(_) => {
                    let updated = transaction
                        .execute(
                            "UPDATE repair_alias_cache
                                SET is_official = CASE
                                    WHEN is_official = 1 OR ?1 = 1 THEN 1 ELSE 0 END
                              WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                                AND alias = ?5 AND repair_id = ?6",
                            params![
                                i64::from(is_official),
                                scope.organization_id,
                                scope.branch_id,
                                scope.terminal_id,
                                alias,
                                context.repair_id,
                            ],
                        )
                        .map_err(|_| hook_unavailable(String::new()))?;
                    if updated != 1 {
                        return Err(reconciliation_invalid());
                    }
                }
                None => {
                    let inserted = transaction
                        .execute(
                            "INSERT INTO repair_alias_cache (
                                 organization_id, branch_id, terminal_id, alias, repair_id,
                                 is_official, created_at
                             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            params![
                                scope.organization_id,
                                scope.branch_id,
                                scope.terminal_id,
                                alias,
                                context.repair_id,
                                i64::from(is_official),
                                chrono::Utc::now().to_rfc3339(),
                            ],
                        )
                        .map_err(|_| hook_unavailable(String::new()))?;
                    if inserted != 1 {
                        return Err(reconciliation_invalid());
                    }
                }
            }
        }

        let deleted = transaction
            .execute(
                "DELETE FROM parity_sync_queue
                  WHERE id = ?1 AND organization_id = ?2
                    AND COALESCE(module_type, '') = 'repairs'
                    AND table_name = 'repairs' AND record_id = ?3
                    AND operation = 'INSERT' AND conflict_strategy = 'manual'
                    AND version = ?4 AND status = 'processing' AND claim_generation = ?5",
                params![
                    context.queue_id,
                    scope.organization_id,
                    context.repair_id,
                    i64::try_from(context.expected_version).unwrap_or(i64::MAX),
                    context.claim_generation,
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if deleted != 1 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_RECONCILIATION_SOURCE_MISSING",
            ));
        }

        let remaining_queue_work: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM parity_sync_queue q
                      WHERE q.organization_id = ?1
                        AND COALESCE(q.module_type, '') = 'repairs'
                        AND q.status IN ('pending', 'processing', 'failed', 'conflict')
                        AND (
                            (q.table_name = 'repairs' AND q.record_id = ?2)
                            OR (
                                q.table_name = 'repair_attachments'
                                AND EXISTS (
                                    SELECT 1 FROM repair_attachment_staging s
                                     WHERE s.organization_id = ?1 AND s.branch_id = ?3
                                       AND s.terminal_id = ?4 AND s.repair_id = ?2
                                       AND s.queue_id = q.id AND s.scope_generation = ?5
                                )
                            )
                        )
                 )",
                params![
                    scope.organization_id,
                    context.repair_id,
                    scope.branch_id,
                    scope.terminal_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
                |row| row.get(0),
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        let dirty = !workspace.operations.is_empty() || remaining_queue_work;
        let next_official_number = row.1.clone().or_else(|| signal.display_number.clone());
        let next_display_number = if row.1.is_none() {
            signal
                .display_number
                .clone()
                .unwrap_or_else(|| row.0.clone())
        } else {
            row.0.clone()
        };
        let updated = transaction
            .execute(
                "UPDATE repair_cache
                    SET display_number = ?1, official_number = ?2,
                        status = ?3, authoritative_status = ?4,
                        authoritative_version = ?5, optimistic_version = ?6,
                        workspace_nonce = ?7, workspace_ciphertext = ?8,
                        dirty = ?9, needs_refetch = 1, updated_at = ?10
                  WHERE organization_id = ?11 AND branch_id = ?12 AND terminal_id = ?13
                    AND repair_id = ?14 AND scope_generation = ?15
                    AND authoritative_version = ?16 AND optimistic_version = ?17",
                params![
                    next_display_number,
                    next_official_number,
                    projected_status,
                    next_authoritative_status,
                    i64::try_from(next_authoritative_version).unwrap_or(i64::MAX),
                    i64::try_from(next_optimistic).unwrap_or(i64::MAX),
                    encrypted.nonce.as_slice(),
                    encrypted.ciphertext.as_slice(),
                    i64::from(dirty),
                    chrono::Utc::now().to_rfc3339(),
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                    i64::try_from(authoritative_version).unwrap_or(i64::MAX),
                    i64::try_from(optimistic).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if updated != 1 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_RECONCILIATION_MISSING",
            ));
        }
        transaction
            .commit()
            .map_err(|_| hook_unavailable(String::new()))
    }

    fn reconcile_attachment_success(
        &self,
        connection: &Connection,
        context: &crate::repair_transport::RepairQueueContext,
        result: &crate::repair_transport::RepairAttachmentUploadResult,
    ) -> Result<(), crate::repair_transport::RepairHookError> {
        let scope = active_scope().map_err(hook_unavailable)?;
        if context.organization_id != scope.organization_id
            || context.queue_id != context.operation_id
            || canonical_uuid(&context.queue_id).is_none()
            || canonical_uuid(&context.repair_id).is_none()
            || canonical_uuid(&result.attachment_id).is_none()
            || result.repair_id != context.repair_id
            || result.version <= context.expected_version
            || result.version > MAX_SAFE_INTEGER
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
            ));
        }

        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| hook_unavailable(String::new()))?;
        let row = transaction
            .query_row(
                "SELECT s.attachment_id, s.file_key, s.expected_version,
                        s.queue_id, c.status, c.authoritative_status,
                        c.authoritative_version, c.optimistic_version,
                        c.workspace_nonce, c.workspace_ciphertext
                   FROM repair_attachment_staging s
                   JOIN repair_cache c
                     ON c.organization_id = s.organization_id
                    AND c.branch_id = s.branch_id
                    AND c.terminal_id = s.terminal_id
                    AND c.repair_id = s.repair_id
                  WHERE s.organization_id = ?1 AND s.branch_id = ?2 AND s.terminal_id = ?3
                    AND s.operation_id = ?4 AND s.repair_id = ?5
                    AND s.scope_generation = ?6 AND s.state = 'queued'",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.operation_id,
                    context.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<Vec<u8>>>(8)?,
                        row.get::<_, Option<Vec<u8>>>(9)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| hook_unavailable(String::new()))?
            .ok_or_else(|| {
                crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_ATTACHMENT_RECONCILIATION_MISSING",
                )
            })?;
        if row.0 != result.attachment_id
            || row.3 != context.queue_id
            || u64::try_from(row.2).unwrap_or(u64::MAX) != context.expected_version
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
            ));
        }
        let authoritative_version = u64::try_from(row.6).unwrap_or(u64::MAX);
        let optimistic = u64::try_from(row.7).unwrap_or(u64::MAX);
        if authoritative_version > MAX_SAFE_INTEGER
            || optimistic > MAX_SAFE_INTEGER
            || result.version == authoritative_version && result.status.as_str() != row.5
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
            ));
        }
        let mut workspace = match (&row.8, &row.9) {
            (Some(nonce), Some(ciphertext)) => {
                let plaintext = decrypt(
                    &scope,
                    CryptoDomain::Cache,
                    "workspace",
                    &context.repair_id,
                    None,
                    optimistic,
                    nonce,
                    ciphertext,
                )
                .map_err(hook_permanent)?;
                serde_json::from_slice::<PendingWorkspace>(&plaintext)
                    .map_err(|_| hook_permanent(String::new()))?
            }
            (None, None) => PendingWorkspace::default(),
            _ => return Err(hook_permanent(String::new())),
        };

        let mut projections = Vec::with_capacity(workspace.operations.len());
        let mut source_index = None;
        for (index, operation) in workspace.operations.iter().enumerate() {
            let projection = parse_workspace_operation(&transaction, &scope, operation)?;
            if projection.repair_id != context.repair_id {
                return Err(crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
                ));
            }
            if projection.operation_id == context.operation_id
                && (projection.expected_version != context.expected_version
                    || projection.attachment_id.as_deref() != Some(result.attachment_id.as_str())
                    || source_index.replace(index).is_some())
            {
                return Err(crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
                ));
            }
            projections.push(projection);
        }
        if !workspace_projections_are_unique(&projections) {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
            ));
        }
        let source_index = source_index.ok_or_else(|| {
            crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
            )
        })?;
        workspace.operations.remove(source_index);
        projections.remove(source_index);
        projections.sort_by(|left, right| {
            left.expected_version
                .cmp(&right.expected_version)
                .then_with(|| left.operation_id.cmp(&right.operation_id))
        });

        let (next_authoritative_status, next_authoritative_version) =
            if result.version > authoritative_version {
                (result.status.as_str().to_string(), result.version)
            } else {
                (row.5.clone(), authoritative_version)
            };
        let mut projected_status = next_authoritative_status.clone();
        for projection in projections
            .iter()
            .filter(|projection| projection.expected_version >= next_authoritative_version)
        {
            if let Some(target_status) = projection.target_status.as_deref() {
                if !replay_transition_allowed(
                    &projected_status,
                    target_status,
                    projection.has_reason,
                ) {
                    return Err(crate::repair_transport::RepairHookError::permanent(
                        "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
                    ));
                }
                projected_status = target_status.to_string();
            }
        }
        let next_optimistic =
            projections
                .iter()
                .try_fold(next_authoritative_version, |maximum, projection| {
                    projection
                        .expected_version
                        .checked_add(1)
                        .filter(|version| *version <= MAX_SAFE_INTEGER)
                        .map(|version| maximum.max(version))
                        .ok_or_else(|| {
                            crate::repair_transport::RepairHookError::permanent(
                                "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
                            )
                        })
                })?;
        let workspace_json = Zeroizing::new(
            serde_json::to_vec(&workspace).map_err(|_| hook_permanent(String::new()))?,
        );
        let encrypted_workspace = encrypt(
            &scope,
            CryptoDomain::Cache,
            "workspace",
            &context.repair_id,
            None,
            next_optimistic,
            &workspace_json,
        )
        .map_err(hook_unavailable)?;

        let deleted = transaction
            .execute(
                "DELETE FROM parity_sync_queue
                  WHERE id = ?1 AND organization_id = ?2
                    AND COALESCE(module_type, '') = 'repairs'
                    AND table_name = 'repair_attachments' AND record_id = ?3
                    AND operation = 'INSERT' AND conflict_strategy = 'manual'
                    AND version = ?4 AND status = 'processing' AND claim_generation = ?5",
                params![
                    context.queue_id,
                    scope.organization_id,
                    result.attachment_id,
                    i64::try_from(context.expected_version).unwrap_or(i64::MAX),
                    context.claim_generation,
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if deleted != 1 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_SOURCE_MISSING",
            ));
        }

        let staged = transaction
            .execute(
                "UPDATE repair_attachment_staging
                    SET state = 'confirmed', server_version = ?1,
                        cleanup_error_code = NULL, updated_at = ?2
                  WHERE organization_id = ?3 AND branch_id = ?4 AND terminal_id = ?5
                    AND attachment_id = ?6 AND repair_id = ?7
                    AND operation_id = ?8 AND queue_id = ?8
                    AND expected_version = ?9 AND scope_generation = ?10
                    AND state = 'queued'",
                params![
                    i64::try_from(result.version).unwrap_or(i64::MAX),
                    chrono::Utc::now().to_rfc3339(),
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    result.attachment_id,
                    context.repair_id,
                    context.operation_id,
                    i64::try_from(context.expected_version).unwrap_or(i64::MAX),
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if staged != 1 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_MISSING",
            ));
        }

        let remaining_queue_work: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM parity_sync_queue q
                      WHERE q.organization_id = ?1
                        AND COALESCE(q.module_type, '') = 'repairs'
                        AND q.status IN ('pending', 'processing', 'failed', 'conflict')
                        AND (
                            (q.table_name = 'repairs' AND q.record_id = ?2)
                            OR (
                                q.table_name = 'repair_attachments'
                                AND EXISTS (
                                    SELECT 1 FROM repair_attachment_staging s
                                     WHERE s.organization_id = ?1 AND s.branch_id = ?3
                                       AND s.terminal_id = ?4 AND s.repair_id = ?2
                                       AND s.queue_id = q.id AND s.scope_generation = ?5
                                )
                            )
                        )
                 )",
                params![
                    scope.organization_id,
                    context.repair_id,
                    scope.branch_id,
                    scope.terminal_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
                |row| row.get(0),
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        let dirty = !workspace.operations.is_empty() || remaining_queue_work;
        let cache_updated = transaction
            .execute(
                "UPDATE repair_cache
                    SET status = ?1, authoritative_status = ?2,
                        authoritative_version = ?3, optimistic_version = ?4,
                        workspace_nonce = ?5, workspace_ciphertext = ?6,
                        dirty = ?7, needs_refetch = 1, updated_at = ?8
                  WHERE organization_id = ?9 AND branch_id = ?10 AND terminal_id = ?11
                    AND repair_id = ?12 AND scope_generation = ?13
                    AND authoritative_version = ?14 AND optimistic_version = ?15",
                params![
                    projected_status,
                    next_authoritative_status,
                    i64::try_from(next_authoritative_version).unwrap_or(i64::MAX),
                    i64::try_from(next_optimistic).unwrap_or(i64::MAX),
                    encrypted_workspace.nonce.as_slice(),
                    encrypted_workspace.ciphertext.as_slice(),
                    i64::from(dirty),
                    chrono::Utc::now().to_rfc3339(),
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                    i64::try_from(authoritative_version).unwrap_or(i64::MAX),
                    i64::try_from(optimistic).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if cache_updated != 1 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_ATTACHMENT_RECONCILIATION_MISSING",
            ));
        }
        transaction
            .commit()
            .map_err(|_| hook_unavailable(String::new()))?;

        let cleanup_succeeded = attachment_final_path(connection, &scope, &row.1)
            .ok()
            .is_some_and(|path| match fs::remove_file(path) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(_) => false,
            });
        if cleanup_succeeded {
            if !matches!(
                connection.execute(
                    "DELETE FROM repair_attachment_staging
                      WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                        AND attachment_id = ?4 AND repair_id = ?5
                        AND operation_id = ?6 AND queue_id = ?6
                        AND expected_version = ?7 AND scope_generation = ?8
                        AND state = 'confirmed' AND server_version = ?9",
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        result.attachment_id,
                        context.repair_id,
                        context.operation_id,
                        i64::try_from(context.expected_version).unwrap_or(i64::MAX),
                        i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                        i64::try_from(result.version).unwrap_or(i64::MAX),
                    ],
                ),
                Ok(1)
            ) {
                tracing::warn!("repair attachment post-commit tombstone cleanup deferred");
            }
        } else if !matches!(
            connection.execute(
                "UPDATE repair_attachment_staging
                    SET state = 'cleanup_failed', cleanup_error_code = 'UNLINK_FAILED',
                        updated_at = ?1
                  WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                    AND attachment_id = ?5 AND repair_id = ?6
                    AND operation_id = ?7 AND queue_id = ?7
                    AND expected_version = ?8 AND scope_generation = ?9
                    AND state = 'confirmed' AND server_version = ?10",
                params![
                    chrono::Utc::now().to_rfc3339(),
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    result.attachment_id,
                    context.repair_id,
                    context.operation_id,
                    i64::try_from(context.expected_version).unwrap_or(i64::MAX),
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                    i64::try_from(result.version).unwrap_or(i64::MAX),
                ],
            ),
            Ok(1)
        ) {
            tracing::warn!("repair attachment post-commit unlink failure marker deferred");
        }
        Ok(())
    }

    fn park_conflict(
        &self,
        connection: &Connection,
        context: &crate::repair_transport::RepairQueueContext,
        conflict: &crate::repair_transport::RepairConflictProjection,
    ) -> Result<(), crate::repair_transport::RepairHookError> {
        let scope = active_scope().map_err(hook_unavailable)?;
        if context.queue_id != context.operation_id
            || conflict.operation_id != context.operation_id
            || conflict.repair_id != context.repair_id
            || conflict.expected_version != context.expected_version
            || conflict.current_version <= conflict.expected_version
            || conflict.current_version > MAX_SAFE_INTEGER
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_CONFLICT_INVALID",
            ));
        }
        if conflict.summary.version != conflict.current_version
            || !validate_timestamp(&conflict.summary.updated_at)
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_CONFLICT_INVALID",
            ));
        }
        let allowed = serde_json::to_string(&conflict.allowed_transitions)
            .map_err(|_| hook_permanent(String::new()))?;
        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| hook_unavailable(String::new()))?;
        let queue_row = transaction
            .query_row(
                "SELECT table_name, record_id, data, organization_id, operation,
                        conflict_strategy, version, claim_generation, status,
                        COALESCE(module_type, '')
                   FROM parity_sync_queue WHERE id = ?1",
                [context.queue_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if queue_row.3 != scope.organization_id
            || queue_row.3 != context.organization_id
            || queue_row.4 != "INSERT"
            || queue_row.5 != "manual"
            || queue_row.6 != i64::try_from(context.expected_version).unwrap_or(i64::MAX)
            || queue_row.9 != "repairs"
            || !matches!(queue_row.0.as_str(), "repairs" | "repair_attachments")
        {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_CONFLICT_SOURCE_INVALID",
            ));
        }

        let existing = transaction
            .query_row(
                "SELECT conflict_id, repair_id, expected_version, current_version,
                        display_number, status_summary, updated_at_summary,
                        allowed_transitions_json, local_nonce, local_ciphertext, state
                   FROM repair_conflicts
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND operation_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.operation_id,
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Vec<u8>>(8)?,
                        row.get::<_, Vec<u8>>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| hook_unavailable(String::new()))?;
        if let Some(existing) = existing.as_ref() {
            if existing.0 != context.operation_id
                || existing.1 != context.repair_id
                || existing.2 != i64::try_from(context.expected_version).unwrap_or(i64::MAX)
                || existing.10 != "open"
            {
                return Err(crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_CONFLICT_STATE_INVALID",
                ));
            }
            let existing_version = u64::try_from(existing.3).unwrap_or(u64::MAX);
            if conflict.current_version < existing_version {
                transaction
                    .commit()
                    .map_err(|_| hook_unavailable(String::new()))?;
                return Ok(());
            }
            if conflict.current_version == existing_version {
                if existing.4.as_deref() != conflict.summary.display_number.as_deref()
                    || existing.5 != conflict.summary.status.as_str()
                    || existing.6 != conflict.summary.updated_at
                    || existing.7 != allowed
                {
                    return Err(crate::repair_transport::RepairHookError::permanent(
                        "REPAIR_CONFLICT_REPLAY_MISMATCH",
                    ));
                }
                transaction
                    .commit()
                    .map_err(|_| hook_unavailable(String::new()))?;
                return Ok(());
            }
        } else if queue_row.7 != context.claim_generation || queue_row.8 != "processing" {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_CONFLICT_CLAIM_INVALID",
            ));
        }

        let (conflict_entity_type, conflict_entity_id, plaintext) = if queue_row.0 == "repairs" {
            if queue_row.1 != context.repair_id {
                return Err(crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_CONFLICT_SOURCE_INVALID",
                ));
            }
            let plaintext = if let Some(existing) = existing.as_ref() {
                decrypt(
                    &scope,
                    CryptoDomain::Conflict,
                    "repairs",
                    &context.repair_id,
                    Some(&context.operation_id),
                    u64::try_from(existing.3).unwrap_or(u64::MAX),
                    &existing.8,
                    &existing.9,
                )
                .map_err(hook_permanent)?
            } else {
                open_stored_ciphertext(
                    &scope,
                    CryptoDomain::Queue,
                    "repairs",
                    &context.repair_id,
                    Some(&context.operation_id),
                    context.expected_version,
                    &queue_row.2,
                )
                .map_err(hook_permanent)?
            };
            ("repairs", context.repair_id.clone(), plaintext)
        } else {
            let staging = transaction
                .query_row(
                    "SELECT repair_id, expected_version, scope_generation,
                                metadata_nonce, metadata_ciphertext, state
                           FROM repair_attachment_staging
                          WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                            AND attachment_id = ?4 AND operation_id = ?5 AND queue_id = ?5",
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        queue_row.1,
                        context.operation_id,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Vec<u8>>(3)?,
                            row.get::<_, Vec<u8>>(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    },
                )
                .map_err(|_| hook_permanent(String::new()))?;
            if staging.0 != context.repair_id
                || staging.1 != i64::try_from(context.expected_version).unwrap_or(i64::MAX)
                || staging.2 != i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX)
                || !matches!(staging.5.as_str(), "queued" | "conflict")
            {
                return Err(crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_CONFLICT_SOURCE_INVALID",
                ));
            }
            let entity_id =
                attachment_entity_identity(&staging.0, &queue_row.1).map_err(hook_permanent)?;
            let plaintext = if let Some(existing) = existing.as_ref() {
                decrypt(
                    &scope,
                    CryptoDomain::Conflict,
                    "repair_attachments",
                    &entity_id,
                    Some(&context.operation_id),
                    u64::try_from(existing.3).unwrap_or(u64::MAX),
                    &existing.8,
                    &existing.9,
                )
                .map_err(hook_permanent)?
            } else {
                decrypt(
                    &scope,
                    CryptoDomain::AttachmentMetadata,
                    "repair_attachments",
                    &entity_id,
                    Some(&context.operation_id),
                    context.expected_version,
                    &staging.3,
                    &staging.4,
                )
                .map_err(hook_permanent)?
            };
            ("repair_attachments", entity_id, plaintext)
        };
        let encrypted = encrypt(
            &scope,
            CryptoDomain::Conflict,
            conflict_entity_type,
            &conflict_entity_id,
            Some(&context.operation_id),
            conflict.current_version,
            &plaintext,
        )
        .map_err(hook_unavailable)?;
        if existing.is_some() {
            let updated = transaction
                .execute(
                    "UPDATE repair_conflicts
                        SET current_version = ?1, display_number = ?2,
                            status_summary = ?3, updated_at_summary = ?4,
                            allowed_transitions_json = ?5, local_nonce = ?6,
                            local_ciphertext = ?7
                      WHERE organization_id = ?8 AND branch_id = ?9 AND terminal_id = ?10
                        AND operation_id = ?11 AND state = 'open'",
                    params![
                        i64::try_from(conflict.current_version).unwrap_or(i64::MAX),
                        conflict.summary.display_number.as_deref(),
                        conflict.summary.status.as_str(),
                        conflict.summary.updated_at,
                        allowed,
                        encrypted.nonce.as_slice(),
                        encrypted.ciphertext.as_slice(),
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        context.operation_id,
                    ],
                )
                .map_err(|_| hook_unavailable(String::new()))?;
            if updated != 1 {
                return Err(hook_permanent(String::new()));
            }
        } else {
            transaction
                .execute(
                    "INSERT INTO repair_conflicts (
                     organization_id, branch_id, terminal_id, conflict_id, repair_id,
                     operation_id, expected_version, current_version, display_number,
                     status_summary, updated_at_summary, allowed_transitions_json,
                     local_nonce, local_ciphertext, state, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                           ?12, ?13, ?14, 'open', ?15)",
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        context.operation_id,
                        context.repair_id,
                        context.operation_id,
                        i64::try_from(conflict.expected_version).unwrap_or(i64::MAX),
                        i64::try_from(conflict.current_version).unwrap_or(i64::MAX),
                        conflict.summary.display_number.as_deref(),
                        conflict.summary.status.as_str(),
                        conflict.summary.updated_at,
                        allowed,
                        encrypted.nonce.as_slice(),
                        encrypted.ciphertext.as_slice(),
                        chrono::Utc::now().to_rfc3339(),
                    ],
                )
                .map_err(|_| hook_unavailable(String::new()))?;
        }
        let cache_updated = transaction
            .execute(
                "UPDATE repair_cache SET has_conflict = 1, needs_refetch = 1
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4 AND scope_generation = ?5",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if cache_updated != 1 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_CONFLICT_CACHE_MISSING",
            ));
        }
        if queue_row.0 == "repair_attachments" {
            let staging_updated = transaction
                .execute(
                    "UPDATE repair_attachment_staging
                        SET state = 'conflict', updated_at = ?1
                      WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                        AND attachment_id = ?5 AND operation_id = ?6
                        AND scope_generation = ?7 AND state IN ('queued', 'conflict')",
                    params![
                        chrono::Utc::now().to_rfc3339(),
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        queue_row.1,
                        context.operation_id,
                        i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                    ],
                )
                .map_err(|_| hook_unavailable(String::new()))?;
            if staging_updated != 1 {
                return Err(crate::repair_transport::RepairHookError::permanent(
                    "REPAIR_CONFLICT_ATTACHMENT_MISSING",
                ));
            }
        }
        let source_updated = transaction
            .execute(
                "UPDATE parity_sync_queue
                    SET status = 'conflict', error_message = 'REPAIR_VERSION_CONFLICT',
                        claim_generation = CASE WHEN status = 'processing'
                                                THEN claim_generation + 1
                                                ELSE claim_generation END
                  WHERE id = ?1 AND organization_id = ?2
                    AND COALESCE(module_type, '') = 'repairs'
                    AND table_name = ?3 AND record_id = ?4
                    AND operation = 'INSERT' AND conflict_strategy = 'manual'
                    AND version = ?5
                    AND ((status = 'processing' AND claim_generation = ?6)
                         OR (status = 'conflict' AND claim_generation = ?6 + 1))",
                params![
                    context.queue_id,
                    scope.organization_id,
                    queue_row.0,
                    queue_row.1,
                    i64::try_from(context.expected_version).unwrap_or(i64::MAX),
                    context.claim_generation,
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        if source_updated != 1 {
            return Err(crate::repair_transport::RepairHookError::permanent(
                "REPAIR_CONFLICT_CLAIM_INVALID",
            ));
        }
        transaction
            .execute(
                "UPDATE parity_sync_queue
                    SET status = 'conflict', error_message = 'REPAIR_DEPENDENCY_CONFLICT',
                        claim_generation = CASE WHEN status = 'processing'
                                                THEN claim_generation + 1
                                                ELSE claim_generation END
                  WHERE id <> ?1 AND organization_id = ?2
                    AND COALESCE(module_type, '') = 'repairs'
                    AND status IN ('pending', 'processing', 'failed')
                    AND version > ?3
                    AND (
                         (table_name = 'repairs' AND record_id = ?4)
                         OR (table_name = 'repair_attachments' AND record_id IN (
                              SELECT attachment_id FROM repair_attachment_staging
                               WHERE organization_id = ?2 AND branch_id = ?5
                                 AND terminal_id = ?6 AND repair_id = ?4
                                 AND scope_generation = ?7
                          ))
                     )",
                params![
                    context.queue_id,
                    scope.organization_id,
                    i64::try_from(context.expected_version).unwrap_or(i64::MAX),
                    context.repair_id,
                    scope.branch_id,
                    scope.terminal_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        transaction
            .execute(
                "UPDATE repair_attachment_staging
                    SET state = 'conflict', updated_at = ?1
                  WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                    AND repair_id = ?5 AND scope_generation = ?6 AND state = 'queued'
                    AND operation_id IN (
                        SELECT id FROM parity_sync_queue
                         WHERE organization_id = ?2
                           AND COALESCE(module_type, '') = 'repairs'
                           AND table_name = 'repair_attachments'
                           AND status = 'conflict'
                           AND error_message = 'REPAIR_DEPENDENCY_CONFLICT'
                    )",
                params![
                    chrono::Utc::now().to_rfc3339(),
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    context.repair_id,
                    i64::try_from(scope.scope_epoch).unwrap_or(i64::MAX),
                ],
            )
            .map_err(|_| hook_unavailable(String::new()))?;
        transaction
            .commit()
            .map_err(|_| hook_unavailable(String::new()))
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RepairStagingJanitorReport {
    pub(crate) cleaned_terminal_rows: u64,
    pub(crate) deferred_live_queue_rows: u64,
    pub(crate) cleanup_failures: u64,
    pub(crate) orphan_part_files_removed: u64,
    pub(crate) orphan_bin_files_removed: u64,
}

struct JanitorStagingRow {
    attachment_id: String,
    repair_id: String,
    operation_id: String,
    queue_id: String,
    expected_version: u64,
    scope_generation: u64,
    file_key: String,
    state: String,
    server_version: Option<u64>,
}

fn latch_janitor_failure() {
    let (mutex, condition) = lifecycle();
    if let Ok(mut state) = mutex.lock() {
        state.blocked = true;
        state.maintenance_failed = true;
        condition.notify_all();
    }
}

pub(crate) fn latch_startup_maintenance_failure() {
    latch_janitor_failure();
}

fn acquire_startup_maintenance_lease(
) -> Result<Option<(RepairScopeState, RepairLifecycleLease)>, String> {
    let Some(candidate) = load_scope_raw()? else {
        return Ok(None);
    };
    if candidate.transition_pending || candidate.reset_pending {
        return Err("REPAIR_SCOPE_TRANSITION_PENDING".to_string());
    }
    let first_identity = runtime_scope_identity_from_keyring()?;
    if !scope_matches_identity(
        &candidate,
        &first_identity.0,
        &first_identity.1,
        &first_identity.2,
    ) {
        return Err("REPAIR_NATIVE_SCOPE_MISMATCH".to_string());
    }

    let (mutex, _) = lifecycle();
    let mut state = mutex
        .lock()
        .map_err(|_| "REPAIR_LIFECYCLE_UNAVAILABLE".to_string())?;
    if state.blocked || state.reset_latched || state.maintenance_failed {
        return Err("REPAIR_SCOPE_TRANSITION_PENDING".to_string());
    }
    let current = load_scope_raw()?.ok_or_else(|| "REPAIR_SCOPE_EPOCH_MISMATCH".to_string())?;
    if current.transition_pending || current.reset_pending {
        state.blocked = true;
        return Err("REPAIR_SCOPE_TRANSITION_PENDING".to_string());
    }
    if current.scope_epoch != candidate.scope_epoch
        || current.scope_token != candidate.scope_token
        || !scope_matches_identity(
            &current,
            &candidate.organization_id,
            &candidate.branch_id,
            &candidate.terminal_id,
        )
        || (state.epoch != 0 && state.epoch != current.scope_epoch)
    {
        state.blocked = true;
        return Err("REPAIR_SCOPE_EPOCH_MISMATCH".to_string());
    }
    let current_identity = runtime_scope_identity_from_keyring()?;
    if !scope_matches_identity(
        &current,
        &current_identity.0,
        &current_identity.1,
        &current_identity.2,
    ) {
        state.blocked = true;
        return Err("REPAIR_NATIVE_SCOPE_MISMATCH".to_string());
    }
    state.active_readers = state.active_readers.saturating_add(1);
    Ok(Some((current.clone(), RepairLifecycleLease {})))
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn safe_staging_directory_state(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && !metadata_is_reparse_point(&metadata) =>
        {
            Ok(true)
        }
        Ok(_) => Err("REPAIR_STAGING_PATH_UNSAFE".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("REPAIR_STAGING_PATH_UNSAFE".to_string()),
    }
}

fn load_janitor_staging_rows(
    transaction: &Transaction<'_>,
    scope: &RepairScopeState,
) -> Result<Vec<JanitorStagingRow>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT attachment_id, repair_id, operation_id, queue_id,
                    expected_version, scope_generation, file_key, state, server_version
               FROM repair_attachment_staging
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
              ORDER BY scope_generation, attachment_id",
        )
        .map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?;
    let mapped = statement
        .query_map(
            params![scope.organization_id, scope.branch_id, scope.terminal_id],
            |row| {
                let expected_version: i64 = row.get(4)?;
                let scope_generation: i64 = row.get(5)?;
                let server_version: Option<i64> = row.get(8)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    expected_version,
                    scope_generation,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    server_version,
                ))
            },
        )
        .map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?;
    let mut rows = Vec::new();
    for row in mapped {
        let row = row.map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?;
        rows.push(JanitorStagingRow {
            attachment_id: row.0,
            repair_id: row.1,
            operation_id: row.2,
            queue_id: row.3,
            expected_version: u64::try_from(row.4)
                .map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?,
            scope_generation: u64::try_from(row.5)
                .map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?,
            file_key: row.6,
            state: row.7,
            server_version: row
                .8
                .map(u64::try_from)
                .transpose()
                .map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?,
        });
    }
    Ok(rows)
}

fn janitor_source_queue_is_live(
    transaction: &Transaction<'_>,
    scope: &RepairScopeState,
    row: &JanitorStagingRow,
) -> Result<bool, String> {
    let source = transaction
        .query_row(
            "SELECT table_name, record_id, operation, organization_id,
                    COALESCE(module_type, ''), COALESCE(conflict_strategy, ''), version
               FROM parity_sync_queue WHERE id = ?1",
            [&row.queue_id],
            |source| {
                Ok((
                    source.get::<_, String>(0)?,
                    source.get::<_, String>(1)?,
                    source.get::<_, String>(2)?,
                    source.get::<_, String>(3)?,
                    source.get::<_, String>(4)?,
                    source.get::<_, String>(5)?,
                    source.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?;
    let Some(source) = source else {
        return Ok(false);
    };
    if row.queue_id != row.operation_id
        || source.0 != "repair_attachments"
        || source.1 != row.attachment_id
        || source.2 != "INSERT"
        || source.3 != scope.organization_id
        || source.4 != "repairs"
        || source.5 != "manual"
        || source.6 != i64::try_from(row.expected_version).unwrap_or(i64::MAX)
    {
        return Err("REPAIR_STAGING_QUEUE_SOURCE_INVALID".to_string());
    }
    Ok(true)
}

fn exact_terminal_row_predicate_matches(
    transaction: &Transaction<'_>,
    scope: &RepairScopeState,
    row: &JanitorStagingRow,
    delete: bool,
) -> Result<usize, String> {
    let server_version = row
        .server_version
        .and_then(|version| i64::try_from(version).ok())
        .ok_or_else(|| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?;
    let result = if delete {
        transaction.execute(
            "DELETE FROM repair_attachment_staging
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND attachment_id = ?4 AND repair_id = ?5 AND operation_id = ?6
                AND queue_id = ?7 AND expected_version = ?8 AND scope_generation = ?9
                AND file_key = ?10 AND state = ?11 AND server_version = ?12",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                row.attachment_id,
                row.repair_id,
                row.operation_id,
                row.queue_id,
                i64::try_from(row.expected_version).unwrap_or(i64::MAX),
                i64::try_from(row.scope_generation).unwrap_or(i64::MAX),
                row.file_key,
                row.state,
                server_version,
            ],
        )
    } else {
        transaction.execute(
            "UPDATE repair_attachment_staging
                SET state = 'cleanup_failed', cleanup_error_code = 'REPAIR_STAGING_UNLINK_FAILED',
                    updated_at = ?13
              WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                AND attachment_id = ?4 AND repair_id = ?5 AND operation_id = ?6
                AND queue_id = ?7 AND expected_version = ?8 AND scope_generation = ?9
                AND file_key = ?10 AND state = ?11 AND server_version = ?12",
            params![
                scope.organization_id,
                scope.branch_id,
                scope.terminal_id,
                row.attachment_id,
                row.repair_id,
                row.operation_id,
                row.queue_id,
                i64::try_from(row.expected_version).unwrap_or(i64::MAX),
                i64::try_from(row.scope_generation).unwrap_or(i64::MAX),
                row.file_key,
                row.state,
                server_version,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
    };
    result.map_err(|_| "REPAIR_STAGING_RECONCILIATION_FAILED".to_string())
}

fn run_startup_staging_janitor_inner(
    connection: &Connection,
    scope: &RepairScopeState,
) -> Result<RepairStagingJanitorReport, String> {
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(|_| "REPAIR_STAGING_PREFLIGHT_FAILED".to_string())?;
    let root = staging_root(&transaction)?;
    let directory = root.join(&scope.scope_token);
    let rows = load_janitor_staging_rows(&transaction, scope)?;

    let mut referenced_file_keys = HashSet::with_capacity(rows.len());
    for row in &rows {
        if canonical_uuid(&row.file_key).as_deref() != Some(row.file_key.as_str()) {
            return Err("REPAIR_STAGING_FILE_KEY_INVALID".to_string());
        }
        if !referenced_file_keys.insert(row.file_key.clone()) {
            return Err("REPAIR_STAGING_FILE_KEY_CONFLICT".to_string());
        }
    }

    let mut terminal_live = HashSet::new();
    for row in rows.iter().filter(|row| {
        row.scope_generation == scope.scope_epoch
            && matches!(row.state.as_str(), "confirmed" | "cleanup_failed")
    }) {
        if janitor_source_queue_is_live(&transaction, scope, row)? {
            terminal_live.insert(row.attachment_id.clone());
        }
    }

    let root_exists = safe_staging_directory_state(&root)?;
    let directory_exists = if root_exists {
        safe_staging_directory_state(&directory)?
    } else {
        false
    };
    let mut report = RepairStagingJanitorReport::default();

    for row in rows.iter().filter(|row| {
        row.scope_generation == scope.scope_epoch
            && matches!(row.state.as_str(), "confirmed" | "cleanup_failed")
    }) {
        if terminal_live.contains(&row.attachment_id) {
            report.deferred_live_queue_rows = report.deferred_live_queue_rows.saturating_add(1);
            continue;
        }
        let path = directory.join(format!("{}.bin", row.file_key));
        let removed_or_missing = if !directory_exists {
            true
        } else {
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Ok(metadata)
                    if metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && !metadata_is_reparse_point(&metadata) =>
                {
                    match fs::remove_file(&path) {
                        Ok(()) => true,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                        Err(_) => false,
                    }
                }
                _ => false,
            }
        };
        if removed_or_missing {
            if exact_terminal_row_predicate_matches(&transaction, scope, row, true)? != 1 {
                return Err("REPAIR_STAGING_RECONCILIATION_FAILED".to_string());
            }
            report.cleaned_terminal_rows = report.cleaned_terminal_rows.saturating_add(1);
        } else {
            if exact_terminal_row_predicate_matches(&transaction, scope, row, false)? != 1 {
                return Err("REPAIR_STAGING_RECONCILIATION_FAILED".to_string());
            }
            report.cleanup_failures = report.cleanup_failures.saturating_add(1);
        }
    }

    if directory_exists {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("REPAIR_STAGING_PATH_UNSAFE".to_string()),
        };
        for entry in entries.into_iter().flatten() {
            let Ok(entry) = entry else {
                report.cleanup_failures = report.cleanup_failures.saturating_add(1);
                continue;
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    report.cleanup_failures = report.cleanup_failures.saturating_add(1);
                    continue;
                }
            };
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata_is_reparse_point(&metadata)
            {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let (stem, part) = if let Some(stem) = name.strip_suffix(".part") {
                (stem, true)
            } else if let Some(stem) = name.strip_suffix(".bin") {
                (stem, false)
            } else {
                continue;
            };
            if canonical_uuid(stem).as_deref() != Some(stem) || referenced_file_keys.contains(stem)
            {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => {
                    if part {
                        report.orphan_part_files_removed =
                            report.orphan_part_files_removed.saturating_add(1);
                    } else {
                        report.orphan_bin_files_removed =
                            report.orphan_bin_files_removed.saturating_add(1);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    report.cleanup_failures = report.cleanup_failures.saturating_add(1);
                }
            }
        }
    }

    transaction
        .commit()
        .map_err(|_| "REPAIR_STAGING_RECONCILIATION_FAILED".to_string())?;
    Ok(report)
}

pub(crate) fn run_startup_staging_janitor(
    connection: &Connection,
) -> Result<RepairStagingJanitorReport, String> {
    recover_interrupted_scope_transition(connection)?;
    let scope_and_lease = match acquire_startup_maintenance_lease() {
        Ok(value) => value,
        Err(error) => {
            latch_janitor_failure();
            return Err(error);
        }
    };
    let Some((scope, lease)) = scope_and_lease else {
        return Ok(RepairStagingJanitorReport::default());
    };
    let result = run_startup_staging_janitor_inner(connection, &scope);
    drop(lease);
    if result.is_err() {
        latch_janitor_failure();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repair_transport::RepairQueueHooks;
    use std::sync::OnceLock;

    #[derive(Clone, Default)]
    struct Round2dCapturedLogs(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    struct Round2dCapturedLogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Round2dCapturedLogWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("lock captured Round2D logs")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for Round2dCapturedLogs {
        type Writer = Round2dCapturedLogWriter;

        fn make_writer(&'writer self) -> Self::Writer {
            Round2dCapturedLogWriter(self.0.clone())
        }
    }

    impl Round2dCapturedLogs {
        fn contents(&self) -> String {
            String::from_utf8(
                self.0
                    .lock()
                    .expect("lock captured Round2D log contents")
                    .clone(),
            )
            .expect("captured Round2D logs are UTF-8")
        }
    }

    const TEST_REPAIR_ID: &str = "44444444-4444-4444-8444-444444444444";
    const TEST_OTHER_REPAIR_ID: &str = "55555555-5555-4555-8555-555555555555";
    const TEST_OPERATION_ID: &str = "66666666-6666-4666-8666-666666666666";
    const TEST_ATTACHMENT_ID: &str = "77777777-7777-4777-8777-777777777777";
    const TEST_ATTACHMENT_OPERATION_ID: &str = "88888888-8888-4888-8888-888888888888";
    const TEST_SESSION_ID: &str = "99999999-9999-4999-8999-999999999999";

    fn test_state_lock() -> RepairLifecycleTestIsolation {
        isolate_lifecycle_for_test()
    }

    fn reset_test_lifecycle() {
        reset_lifecycle_state_for_test();
    }

    fn scope() -> RepairScopeState {
        RepairScopeState {
            version: 1,
            organization_id: "11111111-1111-4111-8111-111111111111".to_string(),
            branch_id: "22222222-2222-4222-8222-222222222222".to_string(),
            terminal_id: "terminal-alpha".to_string(),
            scope_token: "33333333-3333-4333-8333-333333333333".to_string(),
            scope_epoch: 7,
            transition_pending: false,
            reset_pending: false,
            offline_terminal_token: Some("A19F".to_string()),
            offline_sequence_lease_start: Some(1),
            offline_sequence_lease_end: Some(100),
            settings_cache: None,
        }
    }

    fn install_native_state(scope: &RepairScopeState) -> crate::tests::fake_keyring::Guard {
        let entitlement = RepairEntitlementState {
            version: ENTITLEMENT_VERSION,
            organization_id: scope.organization_id.clone(),
            branch_id: scope.branch_id.clone(),
            terminal_id: scope.terminal_id.clone(),
            scope_epoch: scope.scope_epoch,
            enabled: true,
            verified_at: "2026-08-26T00:00:00Z".to_string(),
        };
        let session = serde_json::json!({
            "sessionId": TEST_SESSION_ID,
            "staffId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "branchId": scope.branch_id,
            "organizationId": scope.organization_id,
            "terminalId": scope.terminal_id,
            "staffName": "Repair Technician",
            "role": { "name": "technician" }
        });
        let issued_at = chrono::Utc::now() - chrono::Duration::minutes(1);
        let expires_at = chrono::Utc::now() + chrono::Duration::hours(1);
        let mut permissions = crate::repair_transport::REPAIR_PERMISSIONS
            .iter()
            .map(|permission| (*permission).to_string())
            .collect::<Vec<_>>();
        permissions.sort();
        let actor = serde_json::json!({
            "version": 1,
            "organization_id": scope.organization_id,
            "branch_id": scope.branch_id,
            "terminal_public_id": scope.terminal_id,
            "staff_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "staff_session_id": TEST_SESSION_ID,
            "issued_at": issued_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "session_expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "offline_expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "permissions": permissions,
        });
        crate::tests::fake_keyring::install_seeded([
            ("organization_id", scope.organization_id.clone()),
            ("branch_id", scope.branch_id.clone()),
            ("terminal_id", scope.terminal_id.clone()),
            (
                crate::storage::KEY_REPAIR_SCOPE_V1,
                serde_json::to_string(scope).expect("serialize repair scope"),
            ),
            (
                crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
                serde_json::to_string(&entitlement).expect("serialize repair entitlement"),
            ),
            (
                crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
                actor.to_string(),
            ),
            ("pos_session", session.to_string()),
        ])
    }

    fn seed_valid_repair_queue_aes_key() {
        crate::storage::set_credential(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            &base64::engine::general_purpose::STANDARD.encode([7_u8; 32]),
        )
        .expect("seed valid repair queue AES key");
    }

    fn authoritative_settings(quick_service_enabled: bool) -> serde_json::Value {
        serde_json::json!({
            "settings": {
                "source": "organization",
                "number_prefix": "R",
                "currency": "EUR",
                "quick_service_enabled": quick_service_enabled,
                "default_priority": "normal",
                "default_sla_hours": 48,
                "ready_collection_days": 14,
                "delivery_balance_policy": "require_zero_balance",
                "repair_deposit_supported": false,
                "attachment_policy": {
                    "max_bytes": 15 * 1024 * 1024,
                    "allowed_mime_types": ["image/jpeg", "image/png", "image/webp", "application/pdf"]
                },
                "updated_at": "2026-08-26T00:00:00Z"
            },
            "capabilities": {
                "read": true,
                "create": true,
                "update": true,
                "assign": true,
                "approve": true,
                "overrideApproval": false,
                "planParts": true,
                "consumeParts": false,
                "transfer": false,
                "cancel": false,
                "manageAttachments": true,
                "collectPayments": false,
                "refundPayments": false,
                "fiscalize": false,
                "overrideDeliveryBalance": false
            }
        })
    }

    fn cache_test_settings(connection: &Connection, quick_service_enabled: bool) {
        let access = acquire_renderer_access(connection).expect("acquire renderer settings access");
        cache_authoritative_settings(
            connection,
            &access,
            &authoritative_settings(quick_service_enabled),
        )
        .expect("cache authoritative repair settings");
    }

    fn seed_repair_settlement_ledger(connection: &Connection) {
        connection
            .execute_batch(
                "INSERT INTO orders (
                     id, items, total_amount, total_amount_cents, status,
                     order_context, sync_status, created_at, updated_at
                 ) VALUES (
                     'repair-settlement-order', '[]', 13.0, 1300, 'pending',
                     ' RePaIr_SeTtLeMeNt ', 'pending', datetime('now'), datetime('now')
                 );
                 INSERT INTO orders (
                     id, items, total_amount, total_amount_cents, status,
                     order_context, sync_status, created_at, updated_at
                 ) VALUES (
                     'ordinary-order', '[]', 8.0, 800, 'pending',
                     'sale', 'pending', datetime('now'), datetime('now')
                 );
                 INSERT INTO order_payments (
                     id, order_id, method, amount, amount_cents, status,
                     sync_status, created_at, updated_at
                 ) VALUES (
                     'repair-payment', 'repair-settlement-order', 'cash', 5.0, 500,
                     'completed', 'pending', datetime('now'), datetime('now')
                 );
                 INSERT INTO payment_adjustments (
                     id, payment_id, order_id, adjustment_type, amount, amount_cents,
                     reason, sync_state, created_at, updated_at
                 ) VALUES (
                     'repair-adjustment', 'repair-payment', 'repair-settlement-order',
                     'refund', 1.0, 100, 'repair correction', 'pending',
                     datetime('now'), datetime('now')
                 );
                 INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, retry_delay_ms, module_type, conflict_strategy,
                     version, status
                 ) VALUES
                     ('repair-order-queue', ' OrDeRs ', 'repair-settlement-order', 'INSERT',
                      '{}', '11111111-1111-4111-8111-111111111111', datetime('now'),
                      1000, 'orders', 'server-wins', 1, 'pending'),
                     ('repair-payment-queue', ' OrDeR_PaYmEnTs ', 'repair-payment', 'INSERT',
                      '{}', '11111111-1111-4111-8111-111111111111', datetime('now'),
                      1000, 'payment', 'server-wins', 1, 'pending'),
                     ('repair-adjustment-queue', ' PaYmEnT_AdJuStMeNtS ',
                      'repair-adjustment', 'INSERT', '{}',
                      '11111111-1111-4111-8111-111111111111', datetime('now'),
                      1000, 'payment_adjustment', 'server-wins', 1, 'pending'),
                     ('legacy-repair-table-queue', ' RePaIrS ', 'legacy-repair', 'INSERT',
                      '{}', '11111111-1111-4111-8111-111111111111', datetime('now'),
                      1000, 'generic', 'manual', 1, 'pending'),
                     ('legacy-repair-module-queue', 'legacy_shadow', 'legacy-shadow', 'INSERT',
                      '{}', '11111111-1111-4111-8111-111111111111', datetime('now'),
                      1000, ' RePaIrS ', 'manual', 1, 'pending'),
                     ('ordinary-order-queue', 'orders', 'ordinary-order', 'INSERT',
                      '{}', '11111111-1111-4111-8111-111111111111', datetime('now'),
                      1000, 'orders', 'server-wins', 1, 'pending');
                 INSERT INTO conflict_audit_log (
                     id, operation_type, entity_id, entity_type, local_version,
                     server_version, discarded_payload, resolution
                 ) VALUES
                     ('repair-audit', 'UPDATE', 'repair-entity', ' RePaIrS ', 1, 2,
                      '{}', 'manual_review'),
                     ('repair-attachment-audit', 'INSERT', 'repair-attachment',
                      ' RePaIr_AtTaChMeNtS ', 1, 2, '{}', 'manual_review'),
                     ('ordinary-audit', 'UPDATE', 'ordinary-order', 'orders', 1, 2,
                      '{}', 'server_wins');",
            )
            .expect("seed repair settlement ledger");
    }

    fn seed_unicode_scope_purge_matrix(connection: &Connection) {
        let variants = [
            (
                "repair_settlement",
                "repairs",
                "orders",
                "payments",
                "order_payments",
                "payment_adjustments",
            ),
            (
                "REPAIR_SETTLEMENT",
                "REPAIRS",
                "ORDERS",
                "PAYMENTS",
                "ORDER_PAYMENTS",
                "PAYMENT_ADJUSTMENTS",
            ),
            (
                " repair_settlement ",
                " repairs ",
                " orders ",
                " payments ",
                " order_payments ",
                " payment_adjustments ",
            ),
            (
                "\trepair_settlement\t",
                "\trepairs\t",
                "\torders\t",
                "\tpayments\t",
                "\torder_payments\t",
                "\tpayment_adjustments\t",
            ),
            (
                "\u{00a0}repair_settlement\u{00a0}",
                "\u{00a0}repairs\u{00a0}",
                "\u{00a0}orders\u{00a0}",
                "\u{00a0}payments\u{00a0}",
                "\u{00a0}order_payments\u{00a0}",
                "\u{00a0}payment_adjustments\u{00a0}",
            ),
            (
                "\u{2003}repair_settlement\u{2003}",
                "\u{2003}repairs\u{2003}",
                "\u{2003}orders\u{2003}",
                "\u{2003}payments\u{2003}",
                "\u{2003}order_payments\u{2003}",
                "\u{2003}payment_adjustments\u{2003}",
            ),
        ];
        for (index, (context, repairs, orders, payments, order_payments, adjustments)) in
            variants.iter().enumerate()
        {
            let repair_attachments = match index {
                0 => "repair_attachments",
                1 => "REPAIR_ATTACHMENTS",
                2 => " repair_attachments ",
                3 => "\trepair_attachments\t",
                4 => "\u{00a0}repair_attachments\u{00a0}",
                _ => "\u{2003}repair_attachments\u{2003}",
            };
            let order_id = format!("round2d-order-{index}");
            let payment_id = format!("round2d-payment-{index}");
            let adjustment_id = format!("round2d-adjustment-{index}");
            connection
                .execute(
                    "INSERT INTO orders (
                         id, items, total_amount, total_amount_cents, status,
                         order_context, sync_status, created_at, updated_at
                     ) VALUES (?1, '[]', 13.0, 1300, 'pending', ?2, 'pending',
                               datetime('now'), datetime('now'))",
                    params![order_id, *context],
                )
                .expect("seed semantic repair settlement order");
            connection
                .execute(
                    "INSERT INTO order_payments (
                         id, order_id, method, amount, amount_cents, status,
                         sync_status, created_at, updated_at
                     ) VALUES (?1, ?2, 'cash', 5.0, 500, 'completed', 'pending',
                               datetime('now'), datetime('now'))",
                    params![payment_id, order_id],
                )
                .expect("seed semantic repair settlement payment");
            connection
                .execute(
                    "INSERT INTO payment_adjustments (
                         id, payment_id, order_id, adjustment_type, amount,
                         amount_cents, reason, sync_state, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 'refund', 1.0, 100, 'round2d', 'pending',
                               datetime('now'), datetime('now'))",
                    params![adjustment_id, payment_id, order_id],
                )
                .expect("seed semantic repair settlement adjustment");

            for (suffix, table_name, record_id) in [
                ("order", *orders, order_id.as_str()),
                ("payment", *payments, payment_id.as_str()),
                ("order-payment", *order_payments, payment_id.as_str()),
                ("adjustment", *adjustments, adjustment_id.as_str()),
            ] {
                connection
                    .execute(
                        "INSERT INTO parity_sync_queue (
                             id, table_name, record_id, operation, data, organization_id,
                             created_at, retry_delay_ms, module_type, conflict_strategy,
                             version, status
                         ) VALUES (?1, ?2, ?3, 'INSERT', ?4,
                                   '11111111-1111-4111-8111-111111111111', datetime('now'),
                                   1000, 'financial', 'server-wins', 1, 'pending')",
                        params![
                            format!("round2d-queue-{index}-{suffix}"),
                            table_name,
                            record_id,
                            format!("{{\"private\":\"ROUND2D_PAYLOAD_SENTINEL_{index}\"}}")
                        ],
                    )
                    .expect("seed linked semantic financial queue row");
            }
            for (suffix, table_name, module_type) in [
                ("direct-table", *repairs, "generic"),
                ("direct-module", "generic_shadow", *repairs),
                ("direct-attachment", repair_attachments, "generic"),
            ] {
                connection
                    .execute(
                        "INSERT INTO parity_sync_queue (
                             id, table_name, record_id, operation, data, organization_id,
                             created_at, retry_delay_ms, module_type, conflict_strategy,
                             version, status
                         ) VALUES (?1, ?2, ?3, 'INSERT', ?4,
                                   '11111111-1111-4111-8111-111111111111', datetime('now'),
                                   1000, ?5, 'manual', 1, 'pending')",
                        params![
                            format!("round2d-queue-{index}-{suffix}"),
                            table_name,
                            format!("round2d-direct-{index}-{suffix}"),
                            format!("ROUND2D_DIRECT_PAYLOAD_SENTINEL_{index}"),
                            module_type,
                        ],
                    )
                    .expect("seed direct semantic repair queue row");
            }

            for (suffix, entity_type, entity_id) in [
                ("direct", (*repairs).to_string(), order_id.as_str()),
                (
                    "direct-attachment",
                    repair_attachments.to_string(),
                    order_id.as_str(),
                ),
                ("order", (*orders).to_string(), order_id.as_str()),
                (
                    "legacy-payment",
                    (*payments).to_string(),
                    payment_id.as_str(),
                ),
                (
                    "payment",
                    (*order_payments).to_string(),
                    payment_id.as_str(),
                ),
                (
                    "adjustment",
                    (*adjustments).to_string(),
                    adjustment_id.as_str(),
                ),
            ] {
                connection
                    .execute(
                        "INSERT INTO conflict_audit_log (
                             id, operation_type, entity_id, entity_type, local_version,
                             server_version, discarded_payload, resolution
                         ) VALUES (?1, 'UPDATE', ?2, ?3, 1, 2, ?4, 'manual_review')",
                        params![
                            format!("round2d-audit-{index}-{suffix}"),
                            entity_id,
                            entity_type,
                            format!("ROUND2D_AUDIT_SENTINEL_{index}")
                        ],
                    )
                    .expect("seed direct or linked semantic audit row");
            }
        }

        connection
            .execute_batch(
                "INSERT INTO orders (
                     id, items, total_amount, total_amount_cents, status,
                     order_context, sync_status, created_at, updated_at
                 ) VALUES ('round2d-generic-order', '[]', 8.0, 800, 'pending',
                           'repair_settlem\u{0435}nt', 'pending', datetime('now'), datetime('now'));
                 INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, retry_delay_ms, module_type, conflict_strategy,
                     version, status
                 ) VALUES ('round2d-generic-queue', 'r\u{0435}pairs', 'generic-record',
                           'INSERT', 'ROUND2D_GENERIC_PAYLOAD_SENTINEL',
                           '11111111-1111-4111-8111-111111111111', datetime('now'),
                           1000, 'r\u{0435}pairs', 'server-wins', 1, 'pending');
                 INSERT INTO conflict_audit_log (
                     id, operation_type, entity_id, entity_type, local_version,
                     server_version, discarded_payload, resolution
                 ) VALUES ('round2d-generic-audit', 'UPDATE', 'generic-record',
                           'r\u{0435}pairs', 1, 2, 'ROUND2D_GENERIC_AUDIT_SENTINEL',
                           'manual_review');",
            )
            .expect("seed Unicode lookalike generic controls");
    }

    fn round2d_owned_graph_fingerprint(connection: &Connection) -> String {
        connection
            .query_row(
                "SELECT COALESCE(group_concat(line, char(10)), '')
                   FROM (
                     SELECT line FROM (
                       SELECT 'orders|' || quote(id) || '|' || quote(order_context) AS line
                         FROM orders
                       UNION ALL
                       SELECT 'payments|' || quote(id) || '|' || quote(order_id) || '|' || quote(amount_cents)
                         FROM order_payments
                       UNION ALL
                       SELECT 'adjustments|' || quote(id) || '|' || quote(payment_id) || '|' || quote(order_id)
                         FROM payment_adjustments
                       UNION ALL
                       SELECT 'queue|' || quote(id) || '|' || quote(table_name) || '|' ||
                              quote(record_id) || '|' || quote(module_type) || '|' || quote(data)
                         FROM parity_sync_queue
                       UNION ALL
                       SELECT 'audit|' || quote(id) || '|' || quote(entity_type) || '|' ||
                              quote(entity_id) || '|' || quote(discarded_payload)
                         FROM conflict_audit_log
                     ) ORDER BY line
                   )",
                [],
                |row| row.get(0),
            )
            .expect("fingerprint full repair ownership graph")
    }

    fn install_janitor_state_without_entitlement_or_key(
        scope: &RepairScopeState,
    ) -> crate::tests::fake_keyring::Guard {
        crate::tests::fake_keyring::install_seeded([
            ("organization_id", scope.organization_id.clone()),
            ("branch_id", scope.branch_id.clone()),
            ("terminal_id", scope.terminal_id.clone()),
            (
                crate::storage::KEY_REPAIR_SCOPE_V1,
                serde_json::to_string(scope).expect("serialize janitor repair scope"),
            ),
        ])
    }

    #[allow(clippy::too_many_arguments)]
    fn seed_janitor_staging_row(
        connection: &Connection,
        scope: &RepairScopeState,
        attachment_id: &str,
        operation_id: &str,
        repair_id: &str,
        file_key: &str,
        scope_generation: u64,
        state: &str,
    ) {
        let terminal = matches!(state, "confirmed" | "cleanup_failed");
        let cleanup_error = (state == "cleanup_failed").then_some("PREVIOUS_UNLINK_FAILED");
        connection
            .execute(
                "INSERT INTO repair_attachment_staging (
                     organization_id, branch_id, terminal_id, attachment_id, repair_id,
                     operation_id, queue_id, expected_version, scope_generation, file_key,
                     metadata_nonce, metadata_ciphertext, sha256_hex, mime_type, size_bytes,
                     state, server_version, cleanup_error_code, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, ?8, zeroblob(12),
                           zeroblob(16), ?9, 'image/jpeg', 1, ?10, ?11, ?12,
                           '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z')",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    attachment_id,
                    repair_id,
                    operation_id,
                    i64::try_from(scope_generation).unwrap(),
                    file_key,
                    "0".repeat(64),
                    state,
                    terminal.then_some(2_i64),
                    cleanup_error,
                ],
            )
            .expect("seed janitor attachment staging row");
    }

    fn seed_live_attachment_queue(
        connection: &Connection,
        scope: &RepairScopeState,
        operation_id: &str,
        attachment_id: &str,
    ) {
        connection
            .execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, claim_generation, status
                 ) VALUES (?1, 'repair_attachments', ?2, 'INSERT', 'opaque', ?3,
                           '2026-08-26T00:00:00Z', 0, 1000, 90, 'repairs', 'manual',
                           1, 4, 'processing')",
                params![operation_id, attachment_id, scope.organization_id],
            )
            .expect("seed live repair attachment source queue");
    }

    fn write_test_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create janitor test directory");
        }
        fs::write(path, bytes).expect("write janitor test file");
    }

    fn try_create_directory_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = (target, link);
            false
        }
    }

    fn janitor_db_fingerprint(connection: &Connection) -> Vec<String> {
        let mut rows = Vec::new();
        let mut statement = connection
            .prepare(
                "SELECT 's|' || organization_id || '|' || branch_id || '|' || terminal_id
                        || '|' || attachment_id || '|' || repair_id || '|' || operation_id
                        || '|' || queue_id || '|' || expected_version || '|' || scope_generation
                        || '|' || file_key || '|' || state || '|'
                        || COALESCE(server_version, -1) || '|'
                        || COALESCE(cleanup_error_code, '')
                   FROM repair_attachment_staging
                 UNION ALL
                 SELECT 'q|' || organization_id || '|' || id || '|' || table_name || '|'
                        || record_id || '|' || operation || '|' || version || '|' || status
                        || '|' || claim_generation
                   FROM parity_sync_queue
                  WHERE COALESCE(module_type, '') = 'repairs'
                     OR table_name IN ('repairs', 'repair_attachments')
                 ORDER BY 1",
            )
            .unwrap();
        rows.extend(
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        );
        rows
    }

    fn janitor_filesystem_fingerprint(root: &Path) -> Vec<String> {
        fn visit(base: &Path, directory: &Path, output: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(directory) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                let relative = path
                    .strip_prefix(base)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if metadata.file_type().is_symlink() {
                    output.push(format!("l|{relative}"));
                } else if metadata.is_dir() {
                    output.push(format!("d|{relative}"));
                    visit(base, &path, output);
                } else if metadata.is_file() {
                    output.push(format!(
                        "f|{relative}|{}",
                        base64::engine::general_purpose::STANDARD
                            .encode(fs::read(&path).unwrap_or_default())
                    ));
                } else {
                    output.push(format!("o|{relative}"));
                }
            }
        }

        let mut output = Vec::new();
        visit(root, root, &mut output);
        output.sort();
        output
    }

    #[test]
    fn startup_staging_janitor_no_scope_is_noop_and_never_creates_repair_keys() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let _keyring = crate::tests::fake_keyring::install_empty();
        let database = crate::tests::harness::TestDb::open();
        let foreign = database
            .dir()
            .join("repair-staging-v1")
            .join("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            .join("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.bin");
        write_test_file(&foreign, b"foreign-scope-sentinel");

        let mut connection = database.state.conn.lock().expect("lock repair database");
        JANITOR_SQL_TRACE
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        connection.trace(Some(capture_janitor_sql));
        let report = run_startup_staging_janitor(&connection)
            .expect("an unconfigured terminal must be a janitor no-op");
        connection.trace(None);

        assert_eq!(report, RepairStagingJanitorReport::default());
        assert!(
            foreign.exists(),
            "no-scope startup must not inspect another directory"
        );
        assert!(crate::tests::fake_keyring::is_empty());
        assert!(
            JANITOR_SQL_TRACE
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty(),
            "no-scope janitor must return before SQLite path/staging reads"
        );
    }

    #[test]
    fn startup_staging_janitor_restarts_without_entitlement_or_aes_and_cleans_terminal_rows() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_janitor_state_without_entitlement_or_key(&scope);
        let database = crate::tests::harness::TestDb::open();
        let directory = {
            let connection = database.state.conn.lock().expect("lock repair database");
            let directory = scope_staging_dir(&connection, &scope).unwrap();
            fs::create_dir_all(&directory).unwrap();

            seed_janitor_staging_row(
                &connection,
                &scope,
                "10000000-0000-4000-8000-000000000001",
                "20000000-0000-4000-8000-000000000001",
                TEST_REPAIR_ID,
                "30000000-0000-4000-8000-000000000001",
                scope.scope_epoch,
                "confirmed",
            );
            write_test_file(
                &directory.join("30000000-0000-4000-8000-000000000001.bin"),
                b"confirmed",
            );

            seed_janitor_staging_row(
                &connection,
                &scope,
                "10000000-0000-4000-8000-000000000002",
                "20000000-0000-4000-8000-000000000002",
                TEST_REPAIR_ID,
                "30000000-0000-4000-8000-000000000002",
                scope.scope_epoch,
                "cleanup_failed",
            );

            seed_janitor_staging_row(
                &connection,
                &scope,
                "10000000-0000-4000-8000-000000000003",
                "20000000-0000-4000-8000-000000000003",
                TEST_REPAIR_ID,
                "30000000-0000-4000-8000-000000000003",
                scope.scope_epoch,
                "confirmed",
            );
            fs::create_dir_all(directory.join("30000000-0000-4000-8000-000000000003.bin")).unwrap();

            seed_janitor_staging_row(
                &connection,
                &scope,
                "10000000-0000-4000-8000-000000000004",
                "20000000-0000-4000-8000-000000000004",
                TEST_REPAIR_ID,
                "30000000-0000-4000-8000-000000000004",
                scope.scope_epoch,
                "confirmed",
            );
            write_test_file(
                &directory.join("30000000-0000-4000-8000-000000000004.bin"),
                b"live-source",
            );
            seed_live_attachment_queue(
                &connection,
                &scope,
                "20000000-0000-4000-8000-000000000004",
                "10000000-0000-4000-8000-000000000004",
            );

            seed_janitor_staging_row(
                &connection,
                &scope,
                "10000000-0000-4000-8000-000000000005",
                "20000000-0000-4000-8000-000000000005",
                TEST_REPAIR_ID,
                "30000000-0000-4000-8000-000000000005",
                scope.scope_epoch - 1,
                "confirmed",
            );
            write_test_file(
                &directory.join("30000000-0000-4000-8000-000000000005.bin"),
                b"old-generation-terminal",
            );
            seed_janitor_staging_row(
                &connection,
                &scope,
                "10000000-0000-4000-8000-000000000006",
                "20000000-0000-4000-8000-000000000006",
                TEST_REPAIR_ID,
                "30000000-0000-4000-8000-000000000006",
                scope.scope_epoch - 1,
                "cleanup_failed",
            );
            directory
        };
        let database = database.restart();
        let connection = database
            .state
            .conn
            .lock()
            .expect("lock restarted repair database");

        let report = run_startup_staging_janitor(&connection)
            .expect("restart cleanup must not require entitlement or AES material");

        assert_eq!(report.cleaned_terminal_rows, 2);
        assert_eq!(report.deferred_live_queue_rows, 1);
        assert_eq!(report.cleanup_failures, 1);
        assert!(!directory
            .join("30000000-0000-4000-8000-000000000001.bin")
            .exists());
        assert!(!directory
            .join("30000000-0000-4000-8000-000000000002.bin")
            .exists());
        assert!(directory
            .join("30000000-0000-4000-8000-000000000003.bin")
            .is_dir());
        assert!(directory
            .join("30000000-0000-4000-8000-000000000004.bin")
            .exists());
        assert!(directory
            .join("30000000-0000-4000-8000-000000000005.bin")
            .exists());
        let rows: Vec<(String, String, Option<String>)> = {
            let mut statement = connection
                .prepare(
                    "SELECT attachment_id, state, cleanup_error_code
                       FROM repair_attachment_staging ORDER BY attachment_id",
                )
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            rows,
            vec![
                (
                    "10000000-0000-4000-8000-000000000003".to_string(),
                    "cleanup_failed".to_string(),
                    Some("REPAIR_STAGING_UNLINK_FAILED".to_string()),
                ),
                (
                    "10000000-0000-4000-8000-000000000004".to_string(),
                    "confirmed".to_string(),
                    None,
                ),
                (
                    "10000000-0000-4000-8000-000000000005".to_string(),
                    "confirmed".to_string(),
                    None,
                ),
                (
                    "10000000-0000-4000-8000-000000000006".to_string(),
                    "cleanup_failed".to_string(),
                    Some("PREVIOUS_UNLINK_FAILED".to_string()),
                ),
            ]
        );
        let keys = crate::tests::fake_keyring::all_keys();
        assert!(!keys.contains(&crate::storage::KEY_REPAIR_ENTITLEMENT_V1.to_string()));
        assert!(!keys.contains(&crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1.to_string()));
    }

    #[test]
    fn startup_staging_janitor_sweeps_only_active_scope_regular_orphans() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_janitor_state_without_entitlement_or_key(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        let directory = scope_staging_dir(&connection, &scope).unwrap();
        fs::create_dir_all(&directory).unwrap();
        let current_reference = "31000000-0000-4000-8000-000000000001";
        let old_reference = "31000000-0000-4000-8000-000000000002";
        seed_janitor_staging_row(
            &connection,
            &scope,
            "11000000-0000-4000-8000-000000000001",
            "21000000-0000-4000-8000-000000000001",
            TEST_REPAIR_ID,
            current_reference,
            scope.scope_epoch,
            "queued",
        );
        seed_janitor_staging_row(
            &connection,
            &scope,
            "11000000-0000-4000-8000-000000000002",
            "21000000-0000-4000-8000-000000000002",
            TEST_REPAIR_ID,
            old_reference,
            scope.scope_epoch - 1,
            "conflict",
        );
        let orphan_bin = directory.join("31000000-0000-4000-8000-000000000003.bin");
        let orphan_part = directory.join("31000000-0000-4000-8000-000000000004.part");
        let invalid_name = directory.join("not-a-canonical-uuid.bin");
        let unexpected_extension = directory.join("31000000-0000-4000-8000-000000000005.tmp");
        let named_directory = directory.join("31000000-0000-4000-8000-000000000006.bin");
        for path in [
            directory.join(format!("{current_reference}.bin")),
            directory.join(format!("{current_reference}.part")),
            directory.join(format!("{old_reference}.bin")),
            directory.join(format!("{old_reference}.part")),
            orphan_bin.clone(),
            orphan_part.clone(),
            invalid_name.clone(),
            unexpected_extension.clone(),
        ] {
            write_test_file(&path, b"janitor-sentinel");
        }
        fs::create_dir_all(&named_directory).unwrap();
        let foreign = staging_root(&connection)
            .unwrap()
            .join("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            .join("31000000-0000-4000-8000-000000000007.bin");
        write_test_file(&foreign, b"foreign");
        let outside = database.dir().join("outside-janitor-sentinel.bin");
        write_test_file(&outside, b"outside");
        let symlink = directory.join("31000000-0000-4000-8000-000000000008.bin");
        #[cfg(windows)]
        let symlink_created = std::os::windows::fs::symlink_file(&outside, &symlink).is_ok();
        #[cfg(unix)]
        let symlink_created = std::os::unix::fs::symlink(&outside, &symlink).is_ok();
        #[cfg(not(any(windows, unix)))]
        let symlink_created = false;

        let report = run_startup_staging_janitor(&connection).expect("sweep active repair scope");

        assert_eq!(report.orphan_bin_files_removed, 1);
        assert_eq!(report.orphan_part_files_removed, 1);
        assert!(!orphan_bin.exists());
        assert!(!orphan_part.exists());
        for preserved in [
            directory.join(format!("{current_reference}.bin")),
            directory.join(format!("{current_reference}.part")),
            directory.join(format!("{old_reference}.bin")),
            directory.join(format!("{old_reference}.part")),
            invalid_name,
            unexpected_extension,
            named_directory,
            foreign,
            outside.clone(),
        ] {
            assert!(
                preserved.exists(),
                "janitor crossed a containment/reference boundary"
            );
        }
        if symlink_created {
            assert!(
                fs::symlink_metadata(&symlink).is_ok(),
                "symlink/reparse entry was removed"
            );
            assert_eq!(fs::read(&outside).unwrap(), b"outside");
        }
    }

    #[test]
    fn startup_staging_janitor_fails_closed_before_io_for_pending_mismatch_invalid_or_shared_keys()
    {
        let _serial = test_state_lock();
        reset_test_lifecycle();

        for case in [
            "pending",
            "reset_pending",
            "identity_missing",
            "identity_mismatch",
            "epoch_overflow",
            "invalid_key",
            "shared_key",
            "malformed_live_queue",
            "blocked",
        ] {
            reset_test_lifecycle();
            let mut scope = scope();
            if case == "pending" {
                scope.transition_pending = true;
            } else if case == "reset_pending" {
                scope.reset_pending = true;
            } else if case == "epoch_overflow" {
                scope.scope_epoch = MAX_SAFE_INTEGER + 1;
            }
            let terminal = if case == "identity_mismatch" {
                "terminal-other".to_string()
            } else {
                scope.terminal_id.clone()
            };
            let mut keyring_entries = vec![(
                crate::storage::KEY_REPAIR_SCOPE_V1.to_string(),
                serde_json::to_string(&scope).unwrap(),
            )];
            if case != "identity_missing" {
                keyring_entries.extend([
                    ("organization_id".to_string(), scope.organization_id.clone()),
                    ("branch_id".to_string(), scope.branch_id.clone()),
                    ("terminal_id".to_string(), terminal),
                ]);
            }
            let _keyring = crate::tests::fake_keyring::install_seeded(keyring_entries);
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            if case == "identity_missing" {
                for (key, value) in [
                    ("organization_id", scope.organization_id.as_str()),
                    ("branch_id", scope.branch_id.as_str()),
                    ("terminal_id", scope.terminal_id.as_str()),
                ] {
                    connection
                        .execute(
                            "INSERT INTO local_settings (
                                 setting_category, setting_key, setting_value, updated_at
                             ) VALUES ('terminal', ?1, ?2, '2026-08-26T00:00:00Z')
                             ON CONFLICT(setting_category, setting_key)
                             DO UPDATE SET setting_value = excluded.setting_value",
                            params![key, value],
                        )
                        .unwrap();
                }
            }
            let directory = scope_staging_dir(&connection, &scope).unwrap();
            let orphan = directory.join("32000000-0000-4000-8000-000000000001.part");
            write_test_file(&orphan, b"must-survive-preflight");
            if case == "invalid_key" {
                seed_janitor_staging_row(
                    &connection,
                    &scope,
                    "12000000-0000-4000-8000-000000000001",
                    "22000000-0000-4000-8000-000000000001",
                    TEST_REPAIR_ID,
                    "../not-a-uuid",
                    scope.scope_epoch,
                    "queued",
                );
            } else if case == "shared_key" {
                for (suffix, generation) in [(1_u8, scope.scope_epoch), (2, scope.scope_epoch - 1)]
                {
                    seed_janitor_staging_row(
                        &connection,
                        &scope,
                        &format!("12000000-0000-4000-8000-00000000000{suffix}"),
                        &format!("22000000-0000-4000-8000-00000000000{suffix}"),
                        TEST_REPAIR_ID,
                        "32000000-0000-4000-8000-000000000002",
                        generation,
                        "queued",
                    );
                }
            } else if case == "malformed_live_queue" {
                seed_janitor_staging_row(
                    &connection,
                    &scope,
                    "12000000-0000-4000-8000-000000000003",
                    "22000000-0000-4000-8000-000000000003",
                    TEST_REPAIR_ID,
                    "32000000-0000-4000-8000-000000000003",
                    scope.scope_epoch,
                    "confirmed",
                );
                write_test_file(
                    &directory.join("32000000-0000-4000-8000-000000000003.bin"),
                    b"malformed-live-source-must-survive",
                );
                seed_live_attachment_queue(
                    &connection,
                    &scope,
                    "22000000-0000-4000-8000-000000000003",
                    "12000000-0000-4000-8000-000000000003",
                );
                connection
                    .execute(
                        "UPDATE parity_sync_queue SET record_id = ?1 WHERE id = ?2",
                        params![TEST_OTHER_REPAIR_ID, "22000000-0000-4000-8000-000000000003"],
                    )
                    .unwrap();
            }
            if case == "blocked" {
                lifecycle()
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .blocked = true;
            }

            let staging_root = staging_root(&connection).unwrap();
            let db_before = janitor_db_fingerprint(&connection);
            let files_before = janitor_filesystem_fingerprint(&staging_root);

            let error = run_startup_staging_janitor(&connection)
                .expect_err("unsafe janitor precondition must fail closed");
            let expected = match case {
                "pending" | "reset_pending" | "blocked" => "REPAIR_SCOPE_TRANSITION_PENDING",
                "identity_missing" => "REPAIR_NATIVE_SCOPE_REQUIRED",
                "identity_mismatch" => "REPAIR_NATIVE_SCOPE_MISMATCH",
                "epoch_overflow" => "REPAIR_SCOPE_CORRUPT",
                "invalid_key" => "REPAIR_STAGING_FILE_KEY_INVALID",
                "shared_key" => "REPAIR_STAGING_FILE_KEY_CONFLICT",
                "malformed_live_queue" => "REPAIR_STAGING_QUEUE_SOURCE_INVALID",
                _ => unreachable!(),
            };
            assert_eq!(error, expected, "wrong fail-closed code for {case}");
            assert!(
                orphan.exists(),
                "case {case} performed filesystem IO before preflight"
            );
            assert_eq!(
                janitor_db_fingerprint(&connection),
                db_before,
                "case {case} mutated DB"
            );
            assert_eq!(
                janitor_filesystem_fingerprint(&staging_root),
                files_before,
                "case {case} mutated the staging filesystem"
            );
            assert!(
                lifecycle()
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .blocked,
                "fatal janitor case {case} must keep repair replay fail-closed"
            );
        }
        reset_test_lifecycle();
    }

    #[test]
    fn startup_staging_janitor_rejects_symlinked_root_or_scope_directory() {
        let _serial = test_state_lock();
        let mut exercised = 0_u8;
        for case in ["root", "scope"] {
            reset_test_lifecycle();
            let scope = scope();
            let _keyring = install_janitor_state_without_entitlement_or_key(&scope);
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            let root = staging_root(&connection).unwrap();
            let outside = database.dir().join(format!("outside-{case}"));
            let sentinel = outside.join("34000000-0000-4000-8000-000000000001.bin");
            write_test_file(&sentinel, b"outside-symlink-target");
            let link = if case == "root" {
                root.clone()
            } else {
                fs::create_dir_all(&root).unwrap();
                root.join(&scope.scope_token)
            };
            if !try_create_directory_symlink(&outside, &link) {
                continue;
            }
            exercised += 1;
            let before = fs::read(&sentinel).unwrap();

            let error = run_startup_staging_janitor(&connection)
                .expect_err("symlinked staging container must fail closed");

            assert_eq!(error, "REPAIR_STAGING_PATH_UNSAFE");
            assert_eq!(fs::read(&sentinel).unwrap(), before);
            assert!(
                lifecycle()
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .blocked
            );
        }
        #[cfg(unix)]
        assert_eq!(
            exercised, 2,
            "Unix test hosts must exercise both symlink boundaries"
        );
        #[cfg(not(unix))]
        let _ = exercised;
        reset_test_lifecycle();
    }

    type JanitorLeaseGate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    static JANITOR_LEASE_GATE: OnceLock<Mutex<Option<JanitorLeaseGate>>> = OnceLock::new();

    fn pause_with_janitor_lease_held(sql: &str) {
        if !sql.contains("FROM repair_attachment_staging") {
            return;
        }
        let gate = JANITOR_LEASE_GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some((reached, release)) = gate {
            let _ = reached.send(());
            let _ = release.recv_timeout(std::time::Duration::from_secs(5));
        }
    }

    #[test]
    fn startup_staging_janitor_holds_current_scope_maintenance_lease_without_entitlement() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_janitor_state_without_entitlement_or_key(&scope);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("lock repair database");
            seed_janitor_staging_row(
                &connection,
                &scope,
                "14000000-0000-4000-8000-000000000001",
                "24000000-0000-4000-8000-000000000001",
                TEST_REPAIR_ID,
                "34000000-0000-4000-8000-000000000001",
                scope.scope_epoch,
                "queued",
            );
        }
        let worker_keyring: Vec<(String, String)> = [
            "organization_id",
            "branch_id",
            "terminal_id",
            crate::storage::KEY_REPAIR_SCOPE_V1,
        ]
        .into_iter()
        .map(|key| {
            (
                key.to_string(),
                crate::storage::get_credential(key).expect("copy janitor keyring value"),
            )
        })
        .collect();
        let (reached_tx, reached_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *JANITOR_LEASE_GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((reached_tx, release_rx));
        let mut worker_connection = Connection::open(database.db_path()).unwrap();
        worker_connection.trace(Some(pause_with_janitor_lease_held));
        let worker = std::thread::spawn(move || {
            let _worker_keyring = crate::tests::fake_keyring::install_seeded(worker_keyring);
            run_startup_staging_janitor(&worker_connection)
        });
        reached_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("janitor must reach scoped staging preflight with its lease held");
        let scope_before = crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
            .expect("scope before competing identity write");

        let error = before_identity_credential_write(
            "organization_id",
            Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        )
        .expect_err("identity mutation must not cross an active maintenance lease");
        assert_eq!(error, "REPAIR_SCOPE_TRANSITION_BUSY");
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1),
            Some(scope_before)
        );
        release_tx.send(()).unwrap();
        worker
            .join()
            .expect("join startup janitor")
            .expect("janitor completes after identity writer backs off");
        assert_eq!(
            lifecycle()
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active_readers,
            0
        );
    }

    #[test]
    fn startup_staging_janitor_explicit_lock_failure_latch_blocks_repair_lifecycle() {
        let _serial = test_state_lock();
        reset_test_lifecycle();

        latch_startup_maintenance_failure();
        latch_startup_maintenance_failure();

        let state = lifecycle()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(
            state.blocked,
            "startup DB lock failure must block repair replay"
        );
        assert!(state.maintenance_failed);
        assert_eq!(state.active_readers, 0);
    }

    #[test]
    fn startup_staging_janitor_fatal_latch_survives_entitlement_and_bootstrap_refresh() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        latch_startup_maintenance_failure();
        let transition = arm_scope_transition().expect("arm same-scope refresh while latched");

        let entitlement_error = persist_verified_entitlement(
            &connection,
            &scope.organization_id,
            &scope.branch_id,
            &scope.terminal_id,
            true,
            &transition,
        )
        .expect_err("same-scope entitlement refresh must not clear fatal maintenance latch");
        assert_eq!(entitlement_error, "REPAIR_STAGING_MAINTENANCE_FAILED");

        let bootstrap_error = persist_offline_bootstrap(
            &connection,
            &serde_json::json!({
                "offline_terminal_token": "A19F",
                "offline_sequence_lease_start": 101,
                "offline_sequence_lease_end": 200,
            }),
            &transition,
        )
        .expect_err("same-scope bootstrap refresh must not clear fatal maintenance latch");
        assert_eq!(bootstrap_error, "REPAIR_STAGING_MAINTENANCE_FAILED");
        let state = lifecycle()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(state.blocked);
        assert!(state.maintenance_failed);
    }

    #[test]
    fn startup_staging_janitor_fatal_latch_clears_only_after_destructive_scope_rebind() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let mut old_scope = scope();
        old_scope.transition_pending = true;
        let new_organization = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let new_branch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let new_terminal = "terminal-rebound";
        let old_entitlement = RepairEntitlementState {
            version: ENTITLEMENT_VERSION,
            organization_id: old_scope.organization_id.clone(),
            branch_id: old_scope.branch_id.clone(),
            terminal_id: old_scope.terminal_id.clone(),
            scope_epoch: old_scope.scope_epoch,
            enabled: true,
            verified_at: "2026-08-26T00:00:00Z".to_string(),
        };
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("organization_id", new_organization.to_string()),
            ("branch_id", new_branch.to_string()),
            ("terminal_id", new_terminal.to_string()),
            (
                crate::storage::KEY_REPAIR_SCOPE_V1,
                serde_json::to_string(&old_scope).unwrap(),
            ),
            (
                crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
                serde_json::to_string(&old_entitlement).unwrap(),
            ),
        ]);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        seed_janitor_staging_row(
            &connection,
            &old_scope,
            "15000000-0000-4000-8000-000000000001",
            "25000000-0000-4000-8000-000000000001",
            TEST_REPAIR_ID,
            "35000000-0000-4000-8000-000000000001",
            old_scope.scope_epoch,
            "queued",
        );
        let old_file = scope_staging_dir(&connection, &old_scope)
            .unwrap()
            .join("35000000-0000-4000-8000-000000000001.bin");
        write_test_file(&old_file, b"old-scope-private-staging");
        latch_startup_maintenance_failure();
        let transition = arm_scope_transition().expect("arm destructive scope rebind");

        persist_verified_entitlement(
            &connection,
            new_organization,
            new_branch,
            new_terminal,
            true,
            &transition,
        )
        .expect("destructive scope replacement may clear the maintenance latch");

        let replacement = active_scope().expect("load replacement repair scope");
        assert!(scope_matches_identity(
            &replacement,
            new_organization,
            new_branch,
            new_terminal,
        ));
        assert_ne!(replacement.scope_token, old_scope.scope_token);
        assert!(!old_file.exists());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM repair_attachment_staging",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .unwrap(),
            0
        );
        let state = lifecycle()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(!state.blocked);
        assert!(!state.maintenance_failed);
    }

    static JANITOR_SQL_TRACE: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

    fn capture_janitor_sql(sql: &str) {
        if sql.starts_with("BEGIN")
            || sql.contains("pragma_database_list")
            || sql.contains("repair_attachment_staging")
            || sql.contains("parity_sync_queue")
        {
            JANITOR_SQL_TRACE
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(sql.to_string());
        }
    }

    #[test]
    fn startup_staging_janitor_begins_immediate_before_any_staging_read_or_sweep() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_janitor_state_without_entitlement_or_key(&scope);
        let database = crate::tests::harness::TestDb::open();
        let mut connection = database.state.conn.lock().expect("lock repair database");
        seed_janitor_staging_row(
            &connection,
            &scope,
            "13000000-0000-4000-8000-000000000001",
            "23000000-0000-4000-8000-000000000001",
            TEST_REPAIR_ID,
            "33000000-0000-4000-8000-000000000001",
            scope.scope_epoch,
            "queued",
        );
        let directory = scope_staging_dir(&connection, &scope).unwrap();
        write_test_file(
            &directory.join("33000000-0000-4000-8000-000000000002.part"),
            b"orphan",
        );
        JANITOR_SQL_TRACE
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        connection.trace(Some(capture_janitor_sql));

        run_startup_staging_janitor(&connection).expect("run traced startup janitor");
        connection.trace(None);
        let trace = JANITOR_SQL_TRACE
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let begin = trace
            .iter()
            .position(|sql| sql.starts_with("BEGIN IMMEDIATE"))
            .expect("janitor must begin an immediate transaction");
        let first_read = trace
            .iter()
            .position(|sql| {
                sql.contains("pragma_database_list")
                    || sql.contains("FROM repair_attachment_staging")
                    || sql.contains("FROM parity_sync_queue")
            })
            .expect("janitor must preflight its SQLite path and scoped staging rows");
        assert!(
            begin < first_read,
            "staging read occurred before BEGIN IMMEDIATE: {trace:?}"
        );
    }

    fn create_standard_input() -> RepairOfflineMutationInput {
        RepairOfflineMutationInput {
            operation_id: TEST_OPERATION_ID.to_string(),
            repair_id: TEST_REPAIR_ID.to_string(),
            expected_version: 0,
            staff_session_id: TEST_SESSION_ID.to_string(),
            occurred_at: "2026-08-26T10:00:00Z".to_string(),
            command: RepairOfflineCommand::CreateIntake {
                intake_mode: "standard".to_string(),
                is_anonymous: false,
                customer_id: Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string()),
                customer_device_id: Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string()),
                priority: "normal".to_string(),
                currency: "EUR".to_string(),
                title: Some("Screen replacement".to_string()),
                intake_notes: Some("Private intake note".to_string()),
                due_at: None,
                offline_alias: None,
                offline_sequence: None,
            },
        }
    }

    fn cache_clean_authoritative_repair(
        connection: &Connection,
        access: &RepairRendererAccess,
        repair_id: &str,
        version: u64,
    ) {
        cache_authoritative_workspace(
            connection,
            access,
            repair_id,
            &serde_json::json!({
                "repair": {
                    "id": repair_id,
                    "display_number": "R-ATH-26-000001",
                    "status": "received",
                    "priority": "normal",
                    "intake_mode": "standard",
                    "due_at": null,
                    "version": version,
                    "created_at": "2026-08-26T09:00:00Z",
                    "updated_at": "2026-08-26T09:00:00Z"
                },
                "aliases": ["R-ATH-26-000001"],
                "device": null
            }),
        )
        .expect("cache clean authoritative repair");
    }

    fn queue_item(connection: &Connection, id: &str) -> crate::sync_queue::SyncQueueItem {
        connection
            .query_row(
                "SELECT id, table_name, record_id, operation, data, organization_id,
                        created_at, attempts, last_attempt, error_message, next_retry_at,
                        retry_delay_ms, priority, module_type, conflict_strategy, version,
                        claim_generation, status
                   FROM parity_sync_queue WHERE id = ?1",
                [id],
                |row| {
                    Ok(crate::sync_queue::SyncQueueItem {
                        id: row.get(0)?,
                        table_name: row.get(1)?,
                        record_id: row.get(2)?,
                        operation: row.get(3)?,
                        data: row.get(4)?,
                        organization_id: row.get(5)?,
                        created_at: row.get(6)?,
                        attempts: row.get(7)?,
                        last_attempt: row.get(8)?,
                        error_message: row.get(9)?,
                        next_retry_at: row.get(10)?,
                        retry_delay_ms: row.get(11)?,
                        priority: row.get(12)?,
                        module_type: row.get(13)?,
                        conflict_strategy: row.get(14)?,
                        version: row.get(15)?,
                        claim_generation: row.get(16)?,
                        status: row.get(17)?,
                    })
                },
            )
            .expect("read queued repair item")
    }

    fn decrypt_queued_envelope(
        connection: &Connection,
        scope: &RepairScopeState,
        operation_id: &str,
        repair_id: &str,
        expected_version: u64,
    ) -> serde_json::Value {
        let item = queue_item(connection, operation_id);
        let plaintext = open_stored_ciphertext(
            scope,
            CryptoDomain::Queue,
            "repairs",
            repair_id,
            Some(operation_id),
            expected_version,
            &item.data,
        )
        .expect("decrypt native queue envelope");
        serde_json::from_slice(&plaintext).expect("parse native queue envelope")
    }

    fn conflict_projection(
        operation_id: &str,
        repair_id: &str,
        expected_version: u64,
        current_version: u64,
        display_number: Option<&str>,
    ) -> crate::repair_transport::RepairConflictProjection {
        crate::repair_transport::RepairConflictProjection {
            operation_id: operation_id.to_string(),
            repair_id: repair_id.to_string(),
            expected_version,
            current_version,
            allowed_transitions: vec!["diagnosing".to_string()],
            summary: crate::repair_transport::RepairSafeSummary {
                display_number: display_number.map(str::to_string),
                status: crate::repair_transport::RepairStatus::Received,
                version: current_version,
                updated_at: "2026-08-26T14:00:00Z".to_string(),
            },
        }
    }

    fn seed_open_conflict(
        connection: &Connection,
        scope: &RepairScopeState,
        repair_id: &str,
        conflict_id: &str,
        operation_id: &str,
    ) {
        connection
            .execute(
                "INSERT INTO repair_conflicts (
                     organization_id, branch_id, terminal_id, conflict_id, repair_id,
                     operation_id, expected_version, current_version, display_number,
                     status_summary, updated_at_summary, allowed_transitions_json,
                     local_nonce, local_ciphertext, state, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 1, 'R-OFF-A19F-000001',
                           'received', '2026-08-26T14:00:00Z', '[]', zeroblob(12),
                           zeroblob(16), 'open', '2026-08-26T14:00:00Z')",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    conflict_id,
                    repair_id,
                    operation_id,
                ],
            )
            .expect("seed open repair conflict");
        connection
            .execute(
                "UPDATE repair_cache SET has_conflict = 1 WHERE organization_id = ?1
                  AND branch_id = ?2 AND terminal_id = ?3 AND repair_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    repair_id,
                ],
            )
            .expect("mark repair cache conflict");
    }

    #[test]
    fn aes_restart_round_trip_uses_random_nonce_and_hides_plaintext() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let scope = scope();
        persist_scope(&scope).unwrap();
        let plaintext =
            Zeroizing::new(b"PII_SENTINEL customer note diagnosis filename-secret.jpg".to_vec());
        let first = encrypt(
            &scope,
            CryptoDomain::Queue,
            "repairs",
            "44444444-4444-4444-8444-444444444444",
            Some("55555555-5555-4555-8555-555555555555"),
            3,
            &plaintext,
        )
        .unwrap();
        let second = encrypt(
            &scope,
            CryptoDomain::Queue,
            "repairs",
            "44444444-4444-4444-8444-444444444444",
            Some("55555555-5555-4555-8555-555555555555"),
            3,
            &plaintext,
        )
        .unwrap();
        assert_ne!(first.nonce, second.nonce);
        assert_ne!(first.ciphertext.as_slice(), second.ciphertext.as_slice());
        let stored = store_ciphertext(&scope, &first).unwrap();
        assert!(!stored.contains("PII_SENTINEL"));
        let opened = open_stored_ciphertext(
            &scope,
            CryptoDomain::Queue,
            "repairs",
            "44444444-4444-4444-8444-444444444444",
            Some("55555555-5555-4555-8555-555555555555"),
            3,
            &stored,
        )
        .unwrap();
        assert_eq!(opened.as_slice(), plaintext.as_slice());
    }

    #[test]
    fn aes_aad_rejects_wrong_scope_entity_operation_and_version() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let scope = scope();
        let encrypted = encrypt(
            &scope,
            CryptoDomain::Cache,
            "workspace",
            "44444444-4444-4444-8444-444444444444",
            None,
            9,
            b"private",
        )
        .unwrap();
        for (entity_id, version) in [
            ("66666666-6666-4666-8666-666666666666", 9),
            ("44444444-4444-4444-8444-444444444444", 10),
        ] {
            assert!(decrypt(
                &scope,
                CryptoDomain::Cache,
                "workspace",
                entity_id,
                None,
                version,
                &encrypted.nonce,
                &encrypted.ciphertext,
            )
            .is_err());
        }
        let mut wrong_scope = scope.clone();
        wrong_scope.branch_id = "77777777-7777-4777-8777-777777777777".to_string();
        assert!(decrypt(
            &wrong_scope,
            CryptoDomain::Cache,
            "workspace",
            "44444444-4444-4444-8444-444444444444",
            None,
            9,
            &encrypted.nonce,
            &encrypted.ciphertext,
        )
        .is_err());
    }

    #[test]
    fn attachment_ciphertext_is_bound_to_parent_repair_and_js_safe_version() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");

        apply_offline_mutation(&connection, &create_standard_input())
            .expect("create offline repair");
        stage_attachment(
            &connection,
            &RepairAttachmentStageInput {
                attachment_id: TEST_ATTACHMENT_ID.to_string(),
                operation_id: TEST_ATTACHMENT_OPERATION_ID.to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 1,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T10:01:00Z".to_string(),
                attachment_type: "intake".to_string(),
                filename: "private-photo.jpg".to_string(),
                caption: Some("Private caption".to_string()),
                mime_type: "image/jpeg".to_string(),
                bytes: b"private image bytes".to_vec(),
            },
        )
        .expect("stage encrypted attachment");

        connection
            .execute(
                "UPDATE repair_attachment_staging SET repair_id = ?1
                  WHERE operation_id = ?2",
                params![TEST_OTHER_REPAIR_ID, TEST_ATTACHMENT_OPERATION_ID],
            )
            .expect("simulate tampered parent repair id");
        connection
            .execute(
                "UPDATE parity_sync_queue SET repair_aggregate_id = ?1 WHERE id = ?2",
                params![TEST_OTHER_REPAIR_ID, TEST_ATTACHMENT_OPERATION_ID],
            )
            .expect("keep aggregate binding coherent while testing parent-bound AAD");
        let item = queue_item(&connection, TEST_ATTACHMENT_OPERATION_ID);
        let error = match NATIVE_REPAIR_QUEUE_HOOKS.decode_attachment_upload(&connection, &item) {
            Ok(_) => panic!("parent repair substitution must invalidate attachment ciphertext"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "REPAIR_LOCAL_CIPHERTEXT_INVALID");

        connection
            .execute(
                "UPDATE repair_attachment_staging
                    SET repair_id = ?1, expected_version = 9007199254740992
                  WHERE operation_id = ?2",
                params![TEST_REPAIR_ID, TEST_ATTACHMENT_OPERATION_ID],
            )
            .expect("seed non-JS-safe staged version");
        connection
            .execute(
                "UPDATE parity_sync_queue
                    SET version = 9007199254740992, repair_aggregate_id = ?1
                  WHERE id = ?2",
                params![TEST_REPAIR_ID, TEST_ATTACHMENT_OPERATION_ID],
            )
            .expect("seed non-JS-safe queue version");
        let item = queue_item(&connection, TEST_ATTACHMENT_OPERATION_ID);
        let error = match NATIVE_REPAIR_QUEUE_HOOKS.decode_attachment_upload(&connection, &item) {
            Ok(_) => panic!("non-JS-safe attachment version must fail at the queue boundary"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "REPAIR_ATTACHMENT_QUEUE_INVALID");
    }

    #[test]
    fn stored_prepare_rejects_tampered_command_and_attachment_aggregate_before_io() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");

        apply_offline_mutation(&connection, &create_standard_input())
            .expect("create offline repair");
        connection
            .execute(
                "UPDATE parity_sync_queue SET repair_aggregate_id = ?1 WHERE id = ?2",
                params![TEST_OTHER_REPAIR_ID, TEST_OPERATION_ID],
            )
            .expect("tamper command aggregate binding");
        let command_item = queue_item(&connection, TEST_OPERATION_ID);
        let command_error = NATIVE_REPAIR_QUEUE_HOOKS
            .decode_command_envelope(&connection, &command_item)
            .expect_err("tampered command aggregate must fail before decrypt/dispatch");
        assert_eq!(
            command_error.code(),
            "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID"
        );
        connection
            .execute(
                "UPDATE parity_sync_queue SET repair_aggregate_id = ?1 WHERE id = ?2",
                params![TEST_REPAIR_ID, TEST_OPERATION_ID],
            )
            .expect("restore command aggregate binding");

        stage_attachment(&connection, &attachment_input()).expect("stage encrypted attachment");
        let file_key: String = connection
            .query_row(
                "SELECT file_key FROM repair_attachment_staging
                  WHERE operation_id = ?1",
                [TEST_ATTACHMENT_OPERATION_ID],
                |row| row.get(0),
            )
            .expect("read staged file key");
        let path = attachment_final_path(&connection, &scope, &file_key)
            .expect("resolve staged attachment path");
        fs::remove_file(&path).expect("remove staged bytes to prove aggregate guard precedes IO");
        connection
            .execute(
                "UPDATE parity_sync_queue SET repair_aggregate_id = ?1 WHERE id = ?2",
                params![TEST_OTHER_REPAIR_ID, TEST_ATTACHMENT_OPERATION_ID],
            )
            .expect("tamper attachment aggregate binding");
        let attachment_item = queue_item(&connection, TEST_ATTACHMENT_OPERATION_ID);
        let attachment_error = match NATIVE_REPAIR_QUEUE_HOOKS
            .decode_attachment_upload(&connection, &attachment_item)
        {
            Ok(_) => panic!("tampered attachment aggregate must fail before file IO"),
            Err(error) => error,
        };
        assert_eq!(
            attachment_error.code(),
            "REPAIR_QUEUE_AGGREGATE_BINDING_INVALID"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT state FROM repair_attachment_staging WHERE operation_id = ?1",
                    [TEST_ATTACHMENT_OPERATION_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("read untouched staging state"),
            "queued"
        );
    }

    #[test]
    fn offline_text_bounds_match_utf16_and_rework_requires_reason() {
        let mut create = create_standard_input().command;
        if let RepairOfflineCommand::CreateIntake { title, .. } = &mut create {
            *title = Some("😀".repeat(101));
        }
        assert_eq!(
            validate_offline_command(&create, None).unwrap_err(),
            "REPAIR_OFFLINE_COMMAND_INVALID",
            "101 astral characters are 202 JavaScript UTF-16 units and exceed max(200)"
        );

        if let RepairOfflineCommand::CreateIntake { title, .. } = &mut create {
            *title = Some("x".repeat(200));
        }
        validate_offline_command(&create, None).expect("ASCII exactly at max(200) is valid");

        let rework_without_reason = RepairOfflineCommand::TransitionStatus {
            target_status: "repairing".to_string(),
            reason: None,
            remain_consumed: false,
        };
        assert_eq!(
            validate_offline_command(&rework_without_reason, Some("quality_check")).unwrap_err(),
            "REPAIR_REWORK_REASON_REQUIRED"
        );
        let rework_with_reason = RepairOfflineCommand::TransitionStatus {
            target_status: "repairing".to_string(),
            reason: Some("Quality check found an intermittent fault".to_string()),
            remain_consumed: false,
        };
        validate_offline_command(&rework_with_reason, Some("quality_check"))
            .expect("audited rework transition is valid");
    }

    #[test]
    fn quick_service_offline_intake_requires_authoritative_same_scope_settings() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        let input = RepairOfflineMutationInput {
            operation_id: TEST_OPERATION_ID.to_string(),
            repair_id: TEST_REPAIR_ID.to_string(),
            expected_version: 0,
            staff_session_id: TEST_SESSION_ID.to_string(),
            occurred_at: "2026-08-26T10:00:00Z".to_string(),
            command: RepairOfflineCommand::CreateIntake {
                intake_mode: "quick_service".to_string(),
                is_anonymous: true,
                customer_id: None,
                customer_device_id: None,
                priority: "normal".to_string(),
                currency: "EUR".to_string(),
                title: None,
                intake_notes: None,
                due_at: None,
                offline_alias: None,
                offline_sequence: None,
            },
        };

        assert_eq!(
            apply_offline_mutation(&connection, &input)
                .err()
                .expect("missing authoritative settings must fail closed"),
            "REPAIR_SETTINGS_REQUIRED"
        );
        cache_test_settings(&connection, false);
        assert_eq!(
            apply_offline_mutation(&connection, &input)
                .err()
                .expect("disabled Quick Service must fail closed"),
            "REPAIR_QUICK_SERVICE_DISABLED"
        );
        cache_test_settings(&connection, true);
        let accepted = apply_offline_mutation(&connection, &input)
            .expect("same-scope authoritative enablement permits Quick Service");
        assert_eq!(accepted.status, "received");
        assert!(accepted.display_number.starts_with("R-OFF-A19F-"));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue WHERE module_type = 'repairs'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair queue rows"),
            1,
            "failed settings checks must not leave queue side effects"
        );
    }

    #[test]
    fn authoritative_list_divergence_never_rebinds_dirty_workspace_ciphertext() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");

        let created = apply_offline_mutation(&connection, &create_standard_input())
            .expect("create dirty cached repair");
        apply_offline_mutation(
            &connection,
            &RepairOfflineMutationInput {
                operation_id: "34343434-3434-4434-8434-343434343434".to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 1,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T10:01:00Z".to_string(),
                command: RepairOfflineCommand::AddNote {
                    note: "Pending local note".to_string(),
                    visibility: "internal".to_string(),
                },
            },
        )
        .expect("append second optimistic operation");
        let before: (i64, i64, Vec<u8>, Vec<u8>) = connection
            .query_row(
                "SELECT authoritative_version, optimistic_version,
                        workspace_nonce, workspace_ciphertext
                   FROM repair_cache WHERE repair_id = ?1",
                [TEST_REPAIR_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read dirty workspace before list refresh");
        assert_eq!((before.0, before.1), (0, 2));

        let access = acquire_renderer_access(&connection).expect("acquire renderer access");
        let error = cache_authoritative_list(
            &connection,
            &access,
            &serde_json::json!({
                "repairs": [{
                    "id": TEST_REPAIR_ID,
                    "display_number": created.display_number,
                    "status": "diagnosing",
                    "priority": "normal",
                    "intake_mode": "standard",
                    "due_at": null,
                    "version": 3,
                    "created_at": "2026-08-26T10:00:00Z",
                    "updated_at": "2026-08-26T10:02:00Z"
                }],
                "pagination": { "count": 1, "limit": 25, "offset": 0 }
            }),
        )
        .expect_err("newer remote list version must surface pending divergence");
        assert_eq!(error, "REPAIR_AUTHORITATIVE_PENDING_DIVERGED");

        let after: (i64, i64, Vec<u8>, Vec<u8>, i64, i64) = connection
            .query_row(
                "SELECT authoritative_version, optimistic_version,
                        workspace_nonce, workspace_ciphertext,
                        has_conflict, needs_refetch
                   FROM repair_cache WHERE repair_id = ?1",
                [TEST_REPAIR_ID],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("read dirty workspace after list divergence");
        assert_eq!((after.0, after.1), (0, 2));
        assert_eq!(
            (after.4, after.5),
            (0, 1),
            "list-only evidence must not create an unresolvable conflict latch"
        );
        assert!(list_open_conflicts(&connection, &access)
            .unwrap()
            .is_empty());
        assert_eq!(
            repair_command_preflight(&connection, &access, TEST_REPAIR_ID, 2)
                .expect("queued head remains routable after list divergence"),
            RepairCommandPreflight::PendingPredecessor
        );
        assert_eq!(after.2, before.2, "AAD nonce must remain version-2 bound");
        assert_eq!(
            after.3, before.3,
            "dirty workspace ciphertext must never be rebound without encryption"
        );
        let plaintext = decrypt(
            &scope,
            CryptoDomain::Cache,
            "workspace",
            TEST_REPAIR_ID,
            None,
            2,
            &after.2,
            &after.3,
        )
        .expect("unchanged workspace remains decryptable at optimistic version 2");
        let workspace: PendingWorkspace =
            serde_json::from_slice(&plaintext).expect("parse preserved pending workspace");
        assert_eq!(workspace.operations.len(), 2);
    }

    #[test]
    fn pending_predecessor_is_detected_before_any_direct_command_route() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        let access = acquire_renderer_access(&connection).expect("acquire renderer access");
        cache_clean_authoritative_repair(&connection, &access, TEST_REPAIR_ID, 1);
        assert_eq!(
            repair_command_preflight(&connection, &access, TEST_REPAIR_ID, 1)
                .expect("clean repair preflight"),
            RepairCommandPreflight::Clean
        );

        apply_offline_mutation(
            &connection,
            &RepairOfflineMutationInput {
                operation_id: TEST_OPERATION_ID.to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 1,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T10:00:00Z".to_string(),
                command: RepairOfflineCommand::AddNote {
                    note: "First offline predecessor".to_string(),
                    visibility: "internal".to_string(),
                },
            },
        )
        .expect("append offline predecessor");
        assert_eq!(
            repair_command_preflight(&connection, &access, TEST_REPAIR_ID, 2)
                .expect("pending repair preflight"),
            RepairCommandPreflight::PendingPredecessor,
            "a network-available caller must enqueue behind this predecessor, never send direct"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn renderer_producer_guard_serializes_preflight_through_local_commit() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        let access = acquire_renderer_access(&connection).expect("acquire renderer access");
        cache_clean_authoritative_repair(&connection, &access, TEST_REPAIR_ID, 1);

        let first_guard = acquire_renderer_producer_guard().await;
        let waiting = Arc::new(tokio::sync::Barrier::new(2));
        let second_acquired = Arc::new(AtomicBool::new(false));
        let waiting_in_task = waiting.clone();
        let acquired_in_task = second_acquired.clone();
        let second = tokio::spawn(async move {
            waiting_in_task.wait().await;
            let _second_guard = acquire_renderer_producer_guard().await;
            acquired_in_task.store(true, Ordering::SeqCst);
        });
        waiting.wait().await;
        tokio::task::yield_now().await;
        assert!(
            !second_acquired.load(Ordering::SeqCst),
            "a second renderer producer entered during the first direct-command window"
        );

        apply_offline_mutation(
            &connection,
            &RepairOfflineMutationInput {
                operation_id: TEST_OPERATION_ID.to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 1,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T10:00:00Z".to_string(),
                command: RepairOfflineCommand::AddNote {
                    note: "Serialized first command".to_string(),
                    visibility: "internal".to_string(),
                },
            },
        )
        .expect("commit first producer while the second remains blocked");
        drop(first_guard);
        second.await.expect("join serialized second producer");
        assert!(second_acquired.load(Ordering::SeqCst));
        assert_eq!(
            repair_command_preflight(&connection, &access, TEST_REPAIR_ID, 2)
                .expect("second preflight after serialized commit"),
            RepairCommandPreflight::PendingPredecessor
        );
    }

    fn direct_conflict_fixture(
        connection: &Connection,
        access: &RepairRendererAccess,
        operation_id: &str,
    ) -> RepairConflictRecord {
        cache_clean_authoritative_repair(connection, access, TEST_REPAIR_ID, 1);
        let input = RepairOfflineMutationInput {
            operation_id: operation_id.to_string(),
            repair_id: TEST_REPAIR_ID.to_string(),
            expected_version: 1,
            staff_session_id: TEST_SESSION_ID.to_string(),
            occurred_at: "2026-08-26T10:00:00Z".to_string(),
            command: RepairOfflineCommand::AddNote {
                note: "Direct command private note".to_string(),
                visibility: "internal".to_string(),
            },
        };
        park_direct_command_conflict(
            connection,
            access,
            &input,
            &conflict_projection(operation_id, TEST_REPAIR_ID, 1, 2, None),
        )
        .expect("persist direct 409 through encrypted manual conflict boundary")
    }

    #[test]
    fn direct_command_409_is_durable_and_rebase_creates_a_new_operation() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        let access = acquire_renderer_access(&connection).expect("acquire renderer access");
        let conflict = direct_conflict_fixture(&connection, &access, TEST_OPERATION_ID);
        assert_eq!(conflict.conflict_id, TEST_OPERATION_ID);
        assert_eq!(list_open_conflicts(&connection, &access).unwrap().len(), 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM parity_sync_queue WHERE id = ?1",
                    [TEST_OPERATION_ID],
                    |row| row.get::<_, String>(0),
                )
                .expect("read durable direct conflict source"),
            "conflict"
        );
        let sqlite_dump = connection
            .query_row(
                "SELECT data || hex(local_ciphertext)
                   FROM parity_sync_queue JOIN repair_conflicts
                     ON repair_conflicts.operation_id = parity_sync_queue.id
                  WHERE parity_sync_queue.id = ?1",
                [TEST_OPERATION_ID],
                |row| row.get::<_, String>(0),
            )
            .expect("inspect encrypted conflict persistence");
        assert!(!sqlite_dump.contains("Direct command private note"));

        let resolution = rebase_repair_conflict(&connection, &access, TEST_OPERATION_ID)
            .expect("rebase direct conflict");
        assert_eq!(resolution.state, "rebased");
        assert_eq!(resolution.optimistic_version, 3);
        assert!(list_open_conflicts(&connection, &access)
            .unwrap()
            .is_empty());
        let rebased: (String, i64, String) = connection
            .query_row(
                "SELECT id, version, status FROM parity_sync_queue
                  WHERE repair_aggregate_id = ?1 AND id <> ?2",
                params![TEST_REPAIR_ID, TEST_OPERATION_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read newly rebased operation");
        assert_ne!(rebased.0, TEST_OPERATION_ID);
        assert_eq!((rebased.1, rebased.2.as_str()), (2, "pending"));
    }

    #[test]
    fn direct_command_409_can_accept_server_without_replaying_local_payload() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        let access = acquire_renderer_access(&connection).expect("acquire renderer access");
        direct_conflict_fixture(&connection, &access, TEST_OPERATION_ID);

        let resolution = accept_server_conflict(&connection, &access, TEST_OPERATION_ID)
            .expect("accept authoritative server state");
        assert_eq!(resolution.state, "accepted_server");
        assert_eq!(resolution.optimistic_version, 2);
        assert!(list_open_conflicts(&connection, &access)
            .unwrap()
            .is_empty());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE repair_aggregate_id = ?1",
                    [TEST_REPAIR_ID],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count discarded local repair operations"),
            0
        );
    }

    #[test]
    fn operational_clear_purges_repair_settlement_ownership_but_scope_purge_preserves_money() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        seed_repair_settlement_ledger(&connection);

        purge_repair_rows(&connection).expect("ordinary scope repair purge");
        for table in ["orders", "order_payments", "payment_adjustments"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count settlement table after ordinary scope purge");
            assert!(count > 0, "ordinary scope/module revoke removed {table}");
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE record_id IN (
                          'repair-settlement-order', 'repair-payment', 'repair-adjustment'
                      )",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair settlement queue rows"),
            3,
            "ordinary scope/module revoke must preserve settlement replay"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE id IN (
                          'legacy-repair-table-queue', 'legacy-repair-module-queue'
                      )",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count normalized legacy repair queue rows"),
            0,
            "ordinary repair cache purge must normalize legacy repair ownership"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM conflict_audit_log
                      WHERE lower(trim(COALESCE(entity_type, '')))
                            IN ('repairs', 'repair_attachments')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair audit rows before operational clear"),
            2,
            "ordinary scope/module revoke must preserve repair audit history"
        );

        let transition = arm_operational_clear().expect("arm operational clear");
        complete_operational_clear(&connection, &transition)
            .expect("purge repair-owned operational ledger");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM orders
                      WHERE lower(trim(COALESCE(order_context, ''))) = 'repair_settlement'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair settlement orders"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM order_payments
                      WHERE order_id = 'repair-settlement-order'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair settlement payments"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM payment_adjustments
                      WHERE order_id = 'repair-settlement-order'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair settlement adjustments"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE record_id IN (
                          'repair-settlement-order', 'repair-payment', 'repair-adjustment'
                      )",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair settlement queue rows after clear"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM conflict_audit_log
                      WHERE lower(trim(COALESCE(entity_type, '')))
                            IN ('repairs', 'repair_attachments')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count repair conflict audit after clear"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM orders WHERE id = 'ordinary-order'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count ordinary order after repair pre-clear"),
            1,
            "repair pre-clear must leave generic rows for the generic clear phase"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM conflict_audit_log WHERE id = 'ordinary-audit'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count ordinary audit after repair pre-clear"),
            1
        );
        drop(transition);
        reset_test_lifecycle();
    }

    #[test]
    fn identity_change_purges_old_repair_settlement_graph_before_publishing_new_identity() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("lock repair database");
            persist_runtime_identity(
                &connection,
                &initial.organization_id,
                &initial.branch_id,
                &initial.terminal_id,
            )
            .expect("persist initial runtime identity");
            seed_repair_settlement_ledger(&connection);
        }

        let decision = start_authoritative_access_decision().expect("start identity change");
        let outcome = begin_authoritative_access_reconciliation(
            &database.state,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "terminal-beta",
            true,
            decision,
        )
        .expect("authoritative identity change");
        assert!(outcome.identity_changed());

        let connection = database.state.conn.lock().expect("lock repair database");
        assert_eq!(
            runtime_scope_identity(&connection).expect("read published runtime identity"),
            (
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
                "terminal-beta".to_string(),
            )
        );
        for (table, predicate) in [
            ("orders", "id = 'repair-settlement-order'"),
            ("order_payments", "id = 'repair-payment'"),
            ("payment_adjustments", "id = 'repair-adjustment'"),
            (
                "parity_sync_queue",
                "record_id IN ('repair-settlement-order', 'repair-payment', 'repair-adjustment')",
            ),
        ] {
            let count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {predicate}"),
                    [],
                    |row| row.get(0),
                )
                .expect("count old-scope settlement ownership after identity change");
            assert_eq!(
                count, 0,
                "old identity retained repair ownership in {table}"
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM orders WHERE id = 'ordinary-order'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count generic order control"),
            1
        );
        reset_test_lifecycle();
    }

    #[test]
    fn same_identity_module_revoke_preserves_money_but_removes_operational_repair_state() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("lock repair database");
            seed_repair_settlement_ledger(&connection);
            connection
                .execute(
                    "INSERT INTO repair_cache (
                         organization_id, branch_id, terminal_id, repair_id, scope_generation,
                         display_number, status, authoritative_status, priority, intake_mode,
                         authoritative_version, optimistic_version, dirty, has_conflict,
                         needs_refetch, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 'R-OFF-A19F-000099', 'received',
                               'received', 'normal', 'standard', 0, 0, 0, 0, 0,
                               datetime('now'), datetime('now'))",
                    params![
                        initial.organization_id,
                        initial.branch_id,
                        initial.terminal_id,
                        TEST_REPAIR_ID,
                        initial.scope_epoch as i64
                    ],
                )
                .expect("seed operational repair cache");
        }

        let decision = start_authoritative_access_decision().expect("start module revoke");
        begin_authoritative_access_reconciliation(
            &database.state,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
            false,
            decision,
        )
        .expect("same-identity module revoke");

        let connection = database.state.conn.lock().expect("lock repair database");
        for (table, id) in [
            ("orders", "repair-settlement-order"),
            ("order_payments", "repair-payment"),
            ("payment_adjustments", "repair-adjustment"),
        ] {
            assert_eq!(
                connection
                    .query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                        [id],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("count retained canonical money row"),
                1,
                "same-identity entitlement revoke removed canonical {table}"
            );
        }
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM repair_cache", [], |row| row
                    .get::<_, i64>(0))
                .expect("count purged repair cache"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE id IN ('legacy-repair-table-queue', 'legacy-repair-module-queue')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count purged direct repair queue"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE record_id IN ('repair-settlement-order', 'repair-payment', 'repair-adjustment')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count retained financial replay queue"),
            3
        );
        reset_test_lifecycle();
    }

    #[test]
    fn operational_purge_uses_unicode_semantics_for_direct_linked_financial_and_audit_ownership() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        seed_unicode_scope_purge_matrix(&connection);

        purge_repair_operational_rows(&connection).expect("semantic operational repair purge");
        purge_repair_operational_rows(&connection).expect("idempotent semantic repair purge");

        for (table, prefix) in [
            ("orders", "round2d-order-%"),
            ("order_payments", "round2d-payment-%"),
            ("payment_adjustments", "round2d-adjustment-%"),
            ("parity_sync_queue", "round2d-queue-%"),
            ("conflict_audit_log", "round2d-audit-%"),
        ] {
            let count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id LIKE ?1"),
                    [prefix],
                    |row| row.get(0),
                )
                .expect("count semantically repair-owned rows");
            assert_eq!(count, 0, "semantic repair ownership survived in {table}");
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT order_context FROM orders WHERE id = 'round2d-generic-order'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("read generic Unicode order control"),
            "repair_settlem\u{0435}nt"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT table_name, module_type, data FROM parity_sync_queue
                      WHERE id = 'round2d-generic-queue'",
                    [],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?
                    )),
                )
                .expect("read generic Unicode queue control"),
            (
                "r\u{0435}pairs".to_string(),
                "r\u{0435}pairs".to_string(),
                "ROUND2D_GENERIC_PAYLOAD_SENTINEL".to_string(),
            )
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT entity_type, discarded_payload FROM conflict_audit_log
                      WHERE id = 'round2d-generic-audit'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .expect("read generic Unicode audit control"),
            (
                "r\u{0435}pairs".to_string(),
                "ROUND2D_GENERIC_AUDIT_SENTINEL".to_string(),
            )
        );
        reset_test_lifecycle();
    }

    #[test]
    fn failed_identity_purge_rolls_back_graph_and_never_leaks_payload_or_publishes_new_identity() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        crate::storage::set_credential(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "ROUND2D2_AES_SENTINEL_BYTES",
        )
        .expect("seed old-scope AES credential");
        let protected_keys = [
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
            crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            crate::storage::KEY_REPAIR_SCOPE_V1,
        ];
        let credentials_before = protected_keys.map(|key| {
            crate::storage::get_credential_strict(key)
                .expect("snapshot old-scope credential")
                .map(|value| value.to_string())
        });
        let database = crate::tests::harness::TestDb::open();
        let (graph_before, staging_root_path, files_before) = {
            let connection = database.state.conn.lock().expect("lock repair database");
            persist_runtime_identity(
                &connection,
                &initial.organization_id,
                &initial.branch_id,
                &initial.terminal_id,
            )
            .expect("persist initial runtime identity");
            seed_repair_settlement_ledger(&connection);
            connection
                .execute_batch(
                    "CREATE TRIGGER round2d_fail_identity_purge
                     BEFORE DELETE ON orders
                     WHEN OLD.id = 'repair-settlement-order'
                     BEGIN
                       SELECT RAISE(ABORT, 'ROUND2D_PAYLOAD_SENTINEL_MUST_NOT_LEAK');
                     END;",
                )
                .expect("install deterministic purge failure");
            let root = staging_root(&connection).expect("resolve trusted staging root");
            let scope_directory = scope_staging_dir(&connection, &initial)
                .expect("resolve trusted old-scope staging directory");
            write_test_file(
                &scope_directory.join("nested/first.bin"),
                b"ROUND2D2_OLD_SCOPE_FILE_ONE",
            );
            write_test_file(
                &scope_directory.join("nested/deeper/second.part"),
                b"ROUND2D2_OLD_SCOPE_FILE_TWO",
            );
            write_test_file(
                &root.join("unrelated-generic/control.bin"),
                b"ROUND2D2_GENERIC_FILE_CONTROL",
            );
            (
                round2d_owned_graph_fingerprint(&connection),
                root.clone(),
                janitor_filesystem_fingerprint(&root),
            )
        };

        let decision = start_authoritative_access_decision().expect("start identity change");
        let captured_logs = Round2dCapturedLogs::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(captured_logs.clone())
            .without_time()
            .finish();
        let error = tracing::subscriber::with_default(subscriber, || {
            begin_authoritative_access_reconciliation(
                &database.state,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "terminal-beta",
                true,
                decision,
            )
        })
        .expect_err("identity publication must fail when repair ledger purge rolls back");
        assert_eq!(error, "REPAIR_OPERATIONAL_PURGE_FAILED");
        assert!(!error.contains("ROUND2D_PAYLOAD_SENTINEL_MUST_NOT_LEAK"));
        assert!(!captured_logs
            .contents()
            .contains("ROUND2D_PAYLOAD_SENTINEL_MUST_NOT_LEAK"));
        assert_eq!(
            janitor_filesystem_fingerprint(&staging_root_path),
            files_before,
            "failed identity purge must restore every old-scope staged byte"
        );
        for (index, key) in protected_keys.iter().enumerate() {
            assert_eq!(
                crate::storage::get_credential_strict(key)
                    .expect("read restored old-scope credential")
                    .map(|value| value.to_string()),
                credentials_before[index],
                "failed identity purge did not restore protected credential index {index}"
            );
        }

        let connection = database.state.conn.lock().expect("lock repair database");
        assert_eq!(
            round2d_owned_graph_fingerprint(&connection),
            graph_before,
            "failed identity purge must roll back the graph byte-for-byte"
        );
        assert_eq!(
            runtime_scope_identity(&connection).expect("read retained old runtime identity"),
            (
                initial.organization_id.clone(),
                initial.branch_id.clone(),
                initial.terminal_id.clone(),
            )
        );
        for (table, id) in [
            ("orders", "repair-settlement-order"),
            ("order_payments", "repair-payment"),
            ("payment_adjustments", "repair-adjustment"),
        ] {
            assert_eq!(
                connection
                    .query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                        [id],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("count rolled-back repair graph row"),
                1,
                "failed identity purge partially removed {table}"
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE id IN ('legacy-repair-table-queue', 'legacy-repair-module-queue')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count rolled-back direct repair queue"),
            2
        );
        reset_test_lifecycle();
    }

    #[test]
    fn terminal_identity_compensation_failures_are_distinct_latched_redacted_and_recoverable() {
        let _serial = test_state_lock();
        const ORGANIZATION_ID_KEY: &str = "organization_id";
        const BRANCH_ID_KEY: &str = "branch_id";
        const TERMINAL_ID_KEY: &str = "terminal_id";
        let fields = [ORGANIZATION_ID_KEY, BRANCH_ID_KEY, TERMINAL_ID_KEY];
        for failed_field in fields {
            for failure_mode in ["restore_write", "restore_readback"] {
                reset_test_lifecycle();
                let initial = scope();
                let _keyring = install_native_state(&initial);
                let old_values = [
                    initial.organization_id.clone(),
                    initial.branch_id.clone(),
                    initial.terminal_id.clone(),
                ];
                crate::tests::fake_keyring::replace_next_write_with(
                    failed_field,
                    "ROUND2D2_MIXED_IDENTITY_SENTINEL",
                );
                crate::tests::fake_keyring::after_next_write(TERMINAL_ID_KEY, move || {
                    match failure_mode {
                        "restore_write" => crate::tests::fake_keyring::fail_writes_for(
                            failed_field,
                            "ROUND2D2_RESTORE_WRITE_SENTINEL",
                        ),
                        "restore_readback" => crate::tests::fake_keyring::fail_read_after(
                            failed_field,
                            1,
                            "ROUND2D2_RESTORE_READ_SENTINEL",
                        ),
                        _ => unreachable!(),
                    }
                });

                let error = crate::storage::replace_repair_identity_uncoordinated(
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "terminal-beta",
                )
                .expect_err("unverified identity compensation must fail closed");
                assert_eq!(error, "REPAIR_IDENTITY_COMPENSATION_FAILED");
                for sentinel in [
                    "ROUND2D2_MIXED_IDENTITY_SENTINEL",
                    "ROUND2D2_RESTORE_WRITE_SENTINEL",
                    "ROUND2D2_RESTORE_READ_SENTINEL",
                ] {
                    assert!(!error.contains(sentinel));
                }
                let lifecycle_state = lifecycle().0.lock().expect("inspect fail-closed latch");
                assert!(lifecycle_state.blocked);
                assert!(lifecycle_state.maintenance_failed);
                drop(lifecycle_state);
                assert!(acquire_terminal_binding_lease().is_err());

                crate::tests::fake_keyring::clear_failures_for(failed_field);
                crate::storage::replace_repair_identity_uncoordinated(
                    &old_values[0],
                    &old_values[1],
                    &old_values[2],
                )
                .expect("retry restores one coherent canonical A identity");
                assert_eq!(
                    runtime_scope_identity_from_keyring()
                        .expect("read coherent recovered identity"),
                    (
                        old_values[0].clone(),
                        old_values[1].clone(),
                        old_values[2].clone(),
                    )
                );
            }
        }
        reset_test_lifecycle();
    }

    #[cfg(windows)]
    #[test]
    fn failed_old_scope_rewrite_retains_files_staged_recovery_and_restart_converges_to_a() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let (original, staged) = {
            let connection = database.state.conn.lock().unwrap();
            persist_runtime_identity(
                &connection,
                &initial.organization_id,
                &initial.branch_id,
                &initial.terminal_id,
            )
            .unwrap();
            let original = scope_staging_dir(&connection, &initial).unwrap();
            write_test_file(
                &original.join("owned/restart.bin"),
                b"ROUND2D_PRECOMMIT_RESTART_BYTES",
            );
            let staged = staging_root(&connection)
                .unwrap()
                .join(format!(".scope-cleanup-v3-{}", initial.scope_token));
            (original, staged)
        };
        crate::tests::fake_keyring::replace_next_write_with(
            "organization_id",
            "ROUND2D_MIXED_IDENTITY_SENTINEL",
        );
        crate::tests::fake_keyring::after_next_write("terminal_id", || {
            crate::tests::fake_keyring::fail_writes_for(
                "organization_id",
                "ROUND2D_IDENTITY_RESTORE_WRITE_SENTINEL",
            );
            crate::tests::fake_keyring::fail_writes_for(
                crate::storage::KEY_REPAIR_SCOPE_V1,
                "ROUND2D_SCOPE_RESTORE_WRITE_SENTINEL",
            );
        });

        let decision = start_authoritative_access_decision().unwrap();
        let error = begin_authoritative_access_reconciliation(
            &database.state,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "terminal-beta",
            true,
            decision,
        )
        .expect_err("identity and old-scope compensation must remain recoverable");

        assert_eq!(error, "REPAIR_IDENTITY_COMPENSATION_FAILED");
        let pending = load_scope_raw().unwrap().unwrap();
        assert!(pending.transition_pending);
        let raw_journal = crate::storage::read_repair_transition_journal()
            .unwrap()
            .expect("FilesStaged recovery journal remains durable");
        let journal: RepairTransitionJournal =
            serde_json::from_str(raw_journal.as_str()).expect("parse durable transition journal");
        assert_eq!(journal.phase, RepairTransitionJournalPhase::FilesStaged);
        assert!(!original.exists());
        assert_eq!(
            fs::read(staged.join("owned/restart.bin")).unwrap(),
            b"ROUND2D_PRECOMMIT_RESTART_BYTES"
        );
        validate_transition_marker(&staged, &journal).unwrap();

        crate::tests::fake_keyring::clear_failures_for("organization_id");
        crate::tests::fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_SCOPE_V1);
        {
            let connection = database.state.conn.lock().unwrap();
            recover_interrupted_scope_transition(&connection).unwrap();
            recover_interrupted_scope_transition(&connection).unwrap();
        }
        assert_eq!(
            load_scope_raw().unwrap().unwrap().scope_token,
            initial.scope_token
        );
        assert_eq!(
            runtime_scope_identity_from_keyring().unwrap(),
            (
                initial.organization_id,
                initial.branch_id,
                initial.terminal_id
            )
        );
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_none());
        assert_eq!(
            fs::read(original.join("owned/restart.bin")).unwrap(),
            b"ROUND2D_PRECOMMIT_RESTART_BYTES"
        );
        reset_test_lifecycle();
    }

    #[test]
    fn transition_journal_recovers_each_precommit_and_postcommit_interruption_idempotently() {
        let _serial = test_state_lock();
        for (fault, committed_b) in [
            ("after_journal_prepared", false),
            ("after_marker_create", false),
            ("after_stage_rename", false),
            ("after_database_commit", true),
            ("before_finalize_remove", true),
            ("after_candidate_scope", true),
            ("before_journal_delete", true),
        ] {
            reset_test_lifecycle();
            let initial = scope();
            let initial_scope_bytes = serde_json::to_vec(&initial).unwrap();
            let _keyring = install_native_state(&initial);
            crate::storage::set_credential(
                crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
                "ROUND2D3_AES_SECRET_SENTINEL",
            )
            .unwrap();
            let database = crate::tests::harness::TestDb::open();
            let (root, files_before) = {
                let connection = database.state.conn.lock().unwrap();
                persist_runtime_identity(
                    &connection,
                    &initial.organization_id,
                    &initial.branch_id,
                    &initial.terminal_id,
                )
                .unwrap();
                seed_repair_settlement_ledger(&connection);
                let root = staging_root(&connection).unwrap();
                let old = scope_staging_dir(&connection, &initial).unwrap();
                write_test_file(
                    &old.join("nested/interrupted.bin"),
                    b"ROUND2D3_STAGED_SECRET_SENTINEL",
                );
                let fingerprint = janitor_filesystem_fingerprint(&root);
                (root, fingerprint)
            };

            set_transition_fault(Some(fault));
            let decision = start_authoritative_access_decision().unwrap();
            let error = begin_authoritative_access_reconciliation(
                &database.state,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "terminal-beta",
                true,
                decision,
            )
            .expect_err("fault point must interrupt transition");
            assert_eq!(error, "REPAIR_TRANSITION_INTERRUPTED");
            assert!(!error.contains("SECRET_SENTINEL"));
            assert!(crate::storage::managed_keys()
                .contains(&crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1));
            let encoded_journal = crate::storage::read_repair_transition_journal()
                .unwrap()
                .expect("interrupted transition must retain its durable journal");
            let decoded_journal: RepairTransitionJournal =
                serde_json::from_str(&encoded_journal).unwrap();
            let expected_phase = match fault {
                "after_journal_prepared" => RepairTransitionJournalPhase::Intent,
                "after_marker_create" => RepairTransitionJournalPhase::Prepared,
                "after_stage_rename" => RepairTransitionJournalPhase::MarkerWritten,
                "after_database_commit" => RepairTransitionJournalPhase::FilesStaged,
                "before_finalize_remove" => RepairTransitionJournalPhase::DatabaseCommitted,
                _ => RepairTransitionJournalPhase::TargetPublished,
            };
            assert_eq!(decoded_journal.phase, expected_phase);
            if fault == "after_journal_prepared" {
                assert_eq!(
                    serde_json::to_vec(&load_scope_raw().unwrap().unwrap()).unwrap(),
                    initial_scope_bytes,
                    "journal was not durable before pending-scope mutation"
                );
            }
            set_transition_fault(None);

            let connection = database.state.conn.lock().unwrap();
            let published_scope_before_recovery =
                matches!(fault, "after_candidate_scope" | "before_journal_delete").then(|| {
                    let scope = load_scope_raw().unwrap().unwrap();
                    (scope.scope_token, scope.scope_epoch)
                });
            if committed_b {
                connection
                    .execute(
                        "INSERT INTO orders (
                             id, items, total_amount, total_amount_cents, status,
                             order_context, sync_status, created_at, updated_at
                         ) VALUES ('round2d3-b-sentinel', '[]', 1.0, 100, 'pending',
                                   'repair_settlement', 'pending', datetime('now'), datetime('now'))",
                        [],
                    )
                    .unwrap();
            }
            recover_interrupted_scope_transition(&connection)
                .expect("restart recovery converges deterministically");
            let recovered_once = load_scope_raw().unwrap().unwrap();
            recover_interrupted_scope_transition(&connection)
                .expect("repeated recovery is idempotent");
            let recovered_twice = load_scope_raw().unwrap().unwrap();
            assert_eq!(
                (&recovered_once.scope_token, recovered_once.scope_epoch),
                (&recovered_twice.scope_token, recovered_twice.scope_epoch),
                "recovery changed target scope identity on replay at {fault}"
            );
            if let Some(published) = published_scope_before_recovery {
                assert_eq!(
                    (
                        recovered_twice.scope_token.clone(),
                        recovered_twice.scope_epoch
                    ),
                    published,
                    "recovery replaced an already-published target scope at {fault}"
                );
            }
            assert!(crate::storage::read_repair_transition_journal()
                .unwrap()
                .is_none());
            if committed_b {
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT COUNT(*) FROM orders WHERE id='round2d3-b-sentinel'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap(),
                    1,
                    "B recovery repeated the old graph purge at {fault}"
                );
                assert!(!scope_matches_identity(
                    &recovered_twice,
                    &initial.organization_id,
                    &initial.branch_id,
                    &initial.terminal_id,
                ));
            } else {
                assert_eq!(
                    serde_json::to_vec(&recovered_twice).unwrap(),
                    initial_scope_bytes
                );
                assert_eq!(janitor_filesystem_fingerprint(&root), files_before);
                assert_eq!(
                    crate::storage::get_credential_strict(
                        crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1
                    )
                    .unwrap()
                    .as_ref()
                    .map(|value| value.as_str()),
                    Some("ROUND2D3_AES_SECRET_SENTINEL")
                );
            }
        }
        set_transition_fault(None);
        reset_test_lifecycle();
    }

    #[test]
    fn transition_journal_is_reset_managed_and_renderer_opaque() {
        let _serial = test_state_lock();
        let _keyring = crate::tests::fake_keyring::install_seeded([(
            crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1,
            "ROUND2D3_PRIVATE_JOURNAL_SENTINEL",
        )]);
        assert!(crate::storage::managed_keys()
            .contains(&crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1));
        assert_eq!(
            crate::storage::get_setting(
                Some("terminal"),
                Some(crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1),
            ),
            serde_json::Value::Null
        );
        assert_eq!(
            crate::storage::settings_get(Some(
                crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1
            )),
            serde_json::Value::Null
        );
        assert_eq!(
            crate::storage::set_credential(
                crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1,
                "renderer-overwrite",
            )
            .unwrap_err(),
            "REPAIR_TRANSITION_JOURNAL_NATIVE_ONLY"
        );
        assert_eq!(
            crate::storage::delete_credential(
                crate::storage::KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1
            )
            .unwrap_err(),
            "REPAIR_TRANSITION_JOURNAL_NATIVE_ONLY"
        );
    }

    #[test]
    fn transition_marker_collision_and_symlink_fail_closed_without_path_leakage() {
        let _serial = test_state_lock();
        for symlink in [false, true] {
            reset_test_lifecycle();
            let initial = scope();
            let _keyring = install_native_state(&initial);
            let database = crate::tests::harness::TestDb::open();
            let marker = {
                let connection = database.state.conn.lock().unwrap();
                persist_runtime_identity(
                    &connection,
                    &initial.organization_id,
                    &initial.branch_id,
                    &initial.terminal_id,
                )
                .unwrap();
                let root = staging_root(&connection).unwrap();
                fs::create_dir_all(&root).unwrap();
                let marker = root.join(format!(".scope-cleanup-v3-{}", initial.scope_token));
                if symlink {
                    let target = root.join("foreign-target");
                    fs::create_dir_all(&target).unwrap();
                    if !try_create_directory_symlink(&target, &marker) {
                        continue;
                    }
                } else {
                    fs::write(&marker, b"ROUND2D3_FOREIGN_MARKER_SECRET").unwrap();
                }
                marker
            };
            let decision = start_authoritative_access_decision().unwrap();
            let error = begin_authoritative_access_reconciliation(
                &database.state,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "terminal-beta",
                true,
                decision,
            )
            .expect_err("foreign marker must fail closed");
            assert_eq!(error, "REPAIR_STAGING_PATH_UNSAFE");
            assert!(!error.contains("FOREIGN_MARKER_SECRET"));
            assert!(!error.contains(marker.to_string_lossy().as_ref()));
            assert!(crate::storage::read_repair_transition_journal()
                .unwrap()
                .is_some());
        }
        reset_test_lifecycle();
    }

    #[test]
    fn committed_target_retries_partial_protected_credential_cleanup_from_journal() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        crate::storage::set_credential(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "ROUND2D4_AES_DELETE_SENTINEL",
        )
        .unwrap();
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().unwrap();
            persist_runtime_identity(
                &connection,
                &initial.organization_id,
                &initial.branch_id,
                &initial.terminal_id,
            )
            .unwrap();
        }
        crate::tests::fake_keyring::fail_deletes_for(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "ROUND2D4_DELETE_BACKEND_SENTINEL",
        );
        let decision = start_authoritative_access_decision().unwrap();
        let error = begin_authoritative_access_reconciliation(
            &database.state,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "terminal-beta",
            true,
            decision,
        )
        .expect_err("partial protected credential deletion must stay journaled");
        assert_eq!(error, "REPAIR_AES_KEY_DELETE_FAILED");
        assert!(!error.contains("BACKEND_SENTINEL"));
        let journal: RepairTransitionJournal = serde_json::from_str(
            &crate::storage::read_repair_transition_journal()
                .unwrap()
                .expect("committed cleanup failure journal"),
        )
        .unwrap();
        assert_eq!(
            journal.phase,
            RepairTransitionJournalPhase::DatabaseCommitted
        );

        crate::tests::fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1);
        let connection = database.state.conn.lock().unwrap();
        recover_interrupted_scope_transition(&connection).unwrap();
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_none());
        assert!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)
                .unwrap()
                .is_none()
        );
        reset_test_lifecycle();
    }

    #[test]
    fn old_scope_recovery_identity_restore_failure_stays_journaled_latched_and_retryable() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        persist_runtime_identity(
            &connection,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
        )
        .unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        persist_transition_journal(&RepairTransitionJournal {
            version: 3,
            old_scope: initial.clone(),
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: false,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 41,
            enabled: true,
            phase: RepairTransitionJournalPhase::Intent,
        })
        .unwrap();
        crate::tests::fake_keyring::fail_writes_for(
            "organization_id",
            "ROUND2D4_RESTORE_SECRET_SENTINEL",
        );
        let error = recover_interrupted_scope_transition(&connection)
            .expect_err("old identity restore failure must remain recoverable");
        assert_eq!(error, "REPAIR_IDENTITY_COMPENSATION_FAILED");
        assert!(!error.contains("SECRET_SENTINEL"));
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_some());
        let state = lifecycle().0.lock().unwrap();
        assert!(state.blocked && state.maintenance_failed);
        drop(state);

        crate::tests::fake_keyring::clear_failures_for("organization_id");
        recover_interrupted_scope_transition(&connection).unwrap();
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_none());
        assert_eq!(
            runtime_scope_identity_from_keyring().unwrap(),
            (
                initial.organization_id,
                initial.branch_id,
                initial.terminal_id,
            )
        );
        reset_test_lifecycle();
    }

    #[test]
    fn purge_failure_identity_compensation_keeps_journal_latched_until_verified_recovery() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let initial_scope_bytes = serde_json::to_vec(&initial).unwrap();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let (root, files_before) = {
            let connection = database.state.conn.lock().unwrap();
            persist_runtime_identity(
                &connection,
                &initial.organization_id,
                &initial.branch_id,
                &initial.terminal_id,
            )
            .unwrap();
            let root = staging_root(&connection).unwrap();
            let old = scope_staging_dir(&connection, &initial).unwrap();
            write_test_file(
                &old.join("nested/compensation.bin"),
                b"ROUND2D5_SCOPE_SECRET_SENTINEL",
            );
            let fingerprint = janitor_filesystem_fingerprint(&root);
            (root, fingerprint)
        };
        crate::tests::fake_keyring::after_next_write("terminal_id", || {
            crate::tests::fake_keyring::fail_writes_for(
                "organization_id",
                "ROUND2D5_RESTORE_BACKEND_SENTINEL",
            );
        });
        set_transition_fault(Some("after_identity_write_before_commit"));
        let decision = start_authoritative_access_decision().unwrap();
        let error = begin_authoritative_access_reconciliation(
            &database.state,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "terminal-beta",
            true,
            decision,
        )
        .expect_err("failed identity compensation must not consume recovery authority");
        assert_eq!(error, "REPAIR_IDENTITY_COMPENSATION_FAILED");
        assert!(!error.contains("BACKEND_SENTINEL"));
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_some());
        let encoded_journal = crate::storage::read_repair_transition_journal()
            .unwrap()
            .expect("failed compensation must retain recovery authority");
        let journal: RepairTransitionJournal = serde_json::from_str(&encoded_journal).unwrap();
        assert_eq!(journal.phase, RepairTransitionJournalPhase::FilesStaged);
        assert!(journal.directory_staged);
        let staged = root.join(format!(".scope-cleanup-v3-{}", initial.scope_token));
        assert!(
            !scope_staging_dir(&database.state.conn.lock().unwrap(), &initial)
                .unwrap()
                .exists()
        );
        validate_transition_marker(&staged, &journal).unwrap();
        assert_eq!(
            serde_json::to_vec(&load_scope_raw().unwrap().unwrap()).unwrap(),
            initial_scope_bytes
        );
        let state = lifecycle().0.lock().unwrap();
        assert!(state.blocked && state.maintenance_failed);
        drop(state);

        set_transition_fault(None);
        crate::tests::fake_keyring::clear_failures_for("organization_id");
        let connection = database.state.conn.lock().unwrap();
        recover_interrupted_scope_transition(&connection).unwrap();
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_none());
        assert_eq!(
            runtime_scope_identity_from_keyring().unwrap(),
            (
                initial.organization_id,
                initial.branch_id,
                initial.terminal_id,
            )
        );
        assert_eq!(janitor_filesystem_fingerprint(&root), files_before);
        reset_test_lifecycle();
    }

    #[test]
    fn prepared_journal_never_adopts_foreign_real_staged_directory() {
        let _serial = test_state_lock();
        for original_present in [false, true] {
            reset_test_lifecycle();
            let initial = scope();
            let _keyring = install_native_state(&initial);
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().unwrap();
            persist_runtime_identity(
                &connection,
                &initial.organization_id,
                &initial.branch_id,
                &initial.terminal_id,
            )
            .unwrap();
            let mut target_scope = new_scope(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
                "terminal-beta".to_string(),
                initial.scope_epoch + 1,
            );
            target_scope.transition_pending = true;
            let root = staging_root(&connection).unwrap();
            let original = scope_staging_dir(&connection, &initial).unwrap();
            let staged = root.join(format!(".scope-cleanup-v3-{}", initial.scope_token));
            write_test_file(
                &staged.join("foreign/marker.bin"),
                b"ROUND2D5_FOREIGN_DIRECTORY_SENTINEL",
            );
            if original_present {
                write_test_file(
                    &original.join("owned/original.bin"),
                    b"ROUND2D5_ORIGINAL_DIRECTORY_SENTINEL",
                );
            }
            let identity = transition_file_identity(&staged).unwrap();
            persist_transition_journal(&RepairTransitionJournal {
                version: 3,
                old_scope: initial.clone(),
                target_scope,
                transition_nonce: Uuid::new_v4().to_string(),
                directory_staged: true,
                directory_identity_primary: Some(identity.primary),
                directory_identity_secondary: Some(identity.secondary),
                target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
                target_terminal_id: "terminal-beta".to_string(),
                decision_generation: 51,
                enabled: true,
                phase: RepairTransitionJournalPhase::Prepared,
            })
            .unwrap();
            let before = janitor_filesystem_fingerprint(&root);
            let error = recover_interrupted_scope_transition(&connection)
                .expect_err("Prepared journal cannot authenticate a foreign directory");
            assert_eq!(error, "REPAIR_TRANSITION_MARKER_INVALID");
            assert!(!error.contains("SENTINEL"));
            assert_eq!(janitor_filesystem_fingerprint(&root), before);
            assert!(crate::storage::read_repair_transition_journal()
                .unwrap()
                .is_some());
        }
        reset_test_lifecycle();
    }

    #[test]
    fn files_restored_phase_retries_identity_failure_without_requiring_staged_tree() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        persist_runtime_identity(
            &connection,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
        )
        .unwrap();
        let original = scope_staging_dir(&connection, &initial).unwrap();
        write_test_file(&original.join("owned/a.bin"), b"ROUND2D6_A_BYTES");
        let identity = transition_file_identity(&original).unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        persist_transition_journal(&RepairTransitionJournal {
            version: 3,
            old_scope: initial.clone(),
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: Some(identity.primary),
            directory_identity_secondary: Some(identity.secondary),
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 61,
            enabled: true,
            phase: RepairTransitionJournalPhase::FilesRestored,
        })
        .unwrap();
        crate::tests::fake_keyring::fail_writes_for(
            "organization_id",
            "ROUND2D6_RESTORE_FAILURE_SENTINEL",
        );
        let error = recover_interrupted_scope_transition(&connection)
            .expect_err("restored filesystem must retain retry authority on identity failure");
        assert_eq!(error, "REPAIR_IDENTITY_COMPENSATION_FAILED");
        assert!(original.join("owned/a.bin").exists());
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_some());
        crate::tests::fake_keyring::clear_failures_for("organization_id");
        recover_interrupted_scope_transition(&connection).unwrap();
        recover_interrupted_scope_transition(&connection).unwrap();
        assert!(original.join("owned/a.bin").exists());
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_none());
        reset_test_lifecycle();
    }

    #[test]
    fn markerless_files_restored_rejects_replacement_directory_identity() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        persist_runtime_identity(
            &connection,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
        )
        .unwrap();
        let original = scope_staging_dir(&connection, &initial).unwrap();
        write_test_file(&original.join("owned/a.bin"), b"ROUND2D8_ORIGINAL_BYTES");
        let identity = transition_file_identity(&original).unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        persist_transition_journal(&RepairTransitionJournal {
            version: 3,
            old_scope: initial,
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: Some(identity.primary),
            directory_identity_secondary: Some(identity.secondary),
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 70,
            enabled: true,
            phase: RepairTransitionJournalPhase::FilesRestored,
        })
        .unwrap();
        fs::remove_dir_all(&original).unwrap();
        write_test_file(
            &original.join("foreign/keep.bin"),
            b"ROUND2D8_FOREIGN_BYTES",
        );
        let before = janitor_filesystem_fingerprint(&staging_root(&connection).unwrap());
        assert_eq!(
            recover_interrupted_scope_transition(&connection).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_INVALID"
        );
        assert_eq!(
            janitor_filesystem_fingerprint(&staging_root(&connection).unwrap()),
            before
        );
        reset_test_lifecycle();
    }

    #[test]
    fn files_staged_startup_persists_files_restored_before_each_identity_failure() {
        let _serial = test_state_lock();
        for identity_key in ["organization_id", "branch_id", "terminal_id"] {
            reset_test_lifecycle();
            let initial = scope();
            let _keyring = install_native_state(&initial);
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().unwrap();
            persist_runtime_identity(
                &connection,
                &initial.organization_id,
                &initial.branch_id,
                &initial.terminal_id,
            )
            .unwrap();
            let root = staging_root(&connection).unwrap();
            let staged = root.join(format!(".scope-cleanup-v3-{}", initial.scope_token));
            write_test_file(&staged.join("owned/a.bin"), b"ROUND2D7_A_BYTES");
            let mut target_scope = new_scope(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
                "terminal-beta".to_string(),
                initial.scope_epoch + 1,
            );
            target_scope.transition_pending = true;
            let mut journal = RepairTransitionJournal {
                version: 3,
                old_scope: initial.clone(),
                target_scope,
                transition_nonce: Uuid::new_v4().to_string(),
                directory_staged: true,
                directory_identity_primary: None,
                directory_identity_secondary: None,
                target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
                target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
                target_terminal_id: "terminal-beta".to_string(),
                decision_generation: 68,
                enabled: true,
                phase: RepairTransitionJournalPhase::FilesStaged,
            };
            let identity = transition_file_identity(&staged).unwrap();
            journal.directory_identity_primary = Some(identity.primary);
            journal.directory_identity_secondary = Some(identity.secondary);
            create_transition_marker(&staged, &journal).unwrap();
            persist_transition_journal(&journal).unwrap();
            crate::tests::fake_keyring::fail_writes_for(
                identity_key,
                "ROUND2D7_IDENTITY_FAILURE_SENTINEL",
            );
            let error = recover_interrupted_scope_transition(&connection).unwrap_err();
            assert!(
                error.starts_with("REPAIR_IDENTITY_") || error == "REPAIR_NATIVE_STATE_UNAVAILABLE"
            );
            assert!(!error.contains("SENTINEL"));
            let retained: RepairTransitionJournal = serde_json::from_str(
                &crate::storage::read_repair_transition_journal()
                    .unwrap()
                    .expect("retained rollback journal"),
            )
            .unwrap();
            assert_eq!(retained.phase, RepairTransitionJournalPhase::FilesRestored);
            let original = scope_staging_dir(&connection, &initial).unwrap();
            validate_transition_marker(&original, &retained).unwrap();
            crate::tests::fake_keyring::clear_failures_for(identity_key);
            recover_interrupted_scope_transition(&connection).unwrap();
            recover_interrupted_scope_transition(&connection).unwrap();
            assert_eq!(
                fs::read(original.join("owned/a.bin")).unwrap(),
                b"ROUND2D7_A_BYTES"
            );
        }
        reset_test_lifecycle();
    }

    #[test]
    fn prepared_ambiguous_partial_temp_is_preserved_and_latched() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        persist_runtime_identity(
            &connection,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
        )
        .unwrap();
        let original = scope_staging_dir(&connection, &initial).unwrap();
        write_test_file(&original.join("owned/a.bin"), b"ROUND2D6_OWNED_BYTES");
        let identity = transition_file_identity(&original).unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial,
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: Some(identity.primary),
            directory_identity_secondary: Some(identity.secondary),
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 62,
            enabled: true,
            phase: RepairTransitionJournalPhase::Prepared,
        };
        persist_transition_journal(&journal).unwrap();
        let temporary = original.join(transition_marker_temp_name(&journal));
        fs::write(&temporary, b"partial").unwrap();
        assert_eq!(
            recover_interrupted_scope_transition(&connection).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_INVALID"
        );
        assert_eq!(fs::read(&temporary).unwrap(), b"partial");
        assert_eq!(
            fs::read(original.join("owned/a.bin")).unwrap(),
            b"ROUND2D6_OWNED_BYTES"
        );
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_some());
        reset_test_lifecycle();
    }

    #[test]
    fn prepared_authenticated_partial_temp_is_removed_but_arbitrary_prefix_is_not() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let original = scope_staging_dir(&connection, &initial).unwrap();
        fs::create_dir_all(&original).unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial,
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 69,
            enabled: true,
            phase: RepairTransitionJournalPhase::Prepared,
        };
        let expected = transition_marker_bytes(&journal).unwrap();
        let nonce_end = expected
            .windows(journal.transition_nonce.len())
            .position(|window| window == journal.transition_nonce.as_bytes())
            .unwrap()
            + journal.transition_nonce.len();
        let temporary = original.join(transition_marker_temp_name(&journal));
        fs::write(&temporary, &expected[..nonce_end]).unwrap();
        remove_owned_transition_temp(&original, &journal).unwrap();
        assert!(!temporary.exists());
        fs::write(&temporary, b"{\"version\":3}").unwrap();
        assert_eq!(
            remove_owned_transition_temp(&original, &journal).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_INVALID"
        );
        assert_eq!(fs::read(&temporary).unwrap(), b"{\"version\":3}");
        reset_test_lifecycle();
    }

    #[test]
    fn oversized_transition_marker_is_bounded_and_rejected() {
        let _serial = test_state_lock();
        let initial = scope();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let original = scope_staging_dir(&connection, &initial).unwrap();
        fs::create_dir_all(&original).unwrap();
        fs::write(
            original.join(TRANSITION_MARKER_NAME),
            vec![b'x'; MAX_TRANSITION_MARKER_BYTES as usize + 1],
        )
        .unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial,
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 63,
            enabled: true,
            phase: RepairTransitionJournalPhase::Prepared,
        };
        assert_eq!(
            validate_transition_marker(&original, &journal).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_INVALID"
        );
    }

    #[test]
    fn marker_publication_is_no_clobber_and_preserves_foreign_marker() {
        let _serial = test_state_lock();
        let initial = scope();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let original = scope_staging_dir(&connection, &initial).unwrap();
        fs::create_dir_all(&original).unwrap();
        let foreign = b"ROUND2D6_FOREIGN_MARKER_BYTES";
        fs::write(original.join(TRANSITION_MARKER_NAME), foreign).unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial,
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 65,
            enabled: true,
            phase: RepairTransitionJournalPhase::Prepared,
        };
        assert_eq!(
            create_transition_marker(&original, &journal).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_WRITE_FAILED"
        );
        assert_eq!(
            fs::read(original.join(TRANSITION_MARKER_NAME)).unwrap(),
            foreign
        );
    }

    #[test]
    fn final_directory_move_is_atomic_no_replace_and_preserves_both_trees() {
        let _serial = test_state_lock();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let root = staging_root(&connection).unwrap();
        let source = root.join("round2d8-source");
        let destination = root.join("round2d8-foreign-destination");
        write_test_file(&source.join("owned.bin"), b"ROUND2D8_SOURCE_BYTES");
        write_test_file(
            &destination.join("foreign.bin"),
            b"ROUND2D8_FOREIGN_DESTINATION_BYTES",
        );
        assert_eq!(
            atomic_rename_no_replace(&source, &destination).unwrap_err(),
            "REPAIR_EXTERNAL_CLEANUP_PREPARE_FAILED"
        );
        assert_eq!(
            fs::read(source.join("owned.bin")).unwrap(),
            b"ROUND2D8_SOURCE_BYTES"
        );
        assert_eq!(
            fs::read(destination.join("foreign.bin")).unwrap(),
            b"ROUND2D8_FOREIGN_DESTINATION_BYTES"
        );
    }

    #[cfg(windows)]
    #[test]
    fn pinned_windows_root_blocks_root_replacement_and_child_link_cannot_delete_foreign_bytes() {
        let _serial = test_state_lock();
        let initial = scope();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let root = staging_root(&connection).unwrap();
        let directory = root.join("round2d9-capability-root");
        write_test_file(
            &directory.join("round2d9-replaced-child.bin"),
            b"ROUND2D9_OLD_CHILD_BYTES",
        );
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let mut journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial,
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 69,
            enabled: true,
            phase: RepairTransitionJournalPhase::Finalizing,
        };
        let identity = transition_file_identity(&directory).unwrap();
        journal.directory_identity_primary = Some(identity.primary);
        journal.directory_identity_secondary = Some(identity.secondary);
        create_transition_marker(&directory, &journal).unwrap();

        TRANSITION_WINDOWS_REPLACEMENT_ATTEMPT.with(|attempt| attempt.set(true));
        let result = capability_remove_transition_directory(&directory, &journal, identity);
        TRANSITION_WINDOWS_REPLACEMENT_ATTEMPT.with(|attempt| attempt.set(false));

        result.expect("the authenticated pinned root is removed through its exact handle");
        assert!(!directory.exists());
        assert!(!root.join("round2d9-displaced-root").exists());
        assert_eq!(
            fs::read(root.join("round2d9-foreign-child-bytes.bin")).unwrap(),
            b"ROUND2D9_FOREIGN_CHILD_BYTES"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_identity_change_with_existing_directory_fails_before_transition_mutation() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let directory = {
            let connection = database.state.conn.lock().unwrap();
            let directory = scope_staging_dir(&connection, &initial).unwrap();
            write_test_file(&directory.join("owned/bytes.bin"), b"ROUND2D9_OWNED_BYTES");
            directory
        };
        let before_files = janitor_filesystem_fingerprint(&directory);
        let before_scope = serde_json::to_value(load_scope_raw().unwrap()).unwrap();
        let before_identity = runtime_scope_identity_from_keyring().unwrap();
        let decision = start_authoritative_access_decision().unwrap();

        let error = begin_authoritative_access_reconciliation(
            &database.state,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "terminal-beta",
            true,
            decision,
        )
        .expect_err("Unix private beta must reject destructive directory transitions");

        assert_eq!(error, "REPAIR_TRANSITION_DURABILITY_UNSUPPORTED");
        assert_eq!(janitor_filesystem_fingerprint(&directory), before_files);
        assert_eq!(
            serde_json::to_value(load_scope_raw().unwrap()).unwrap(),
            before_scope
        );
        assert_eq!(
            runtime_scope_identity_from_keyring().unwrap(),
            before_identity
        );
        assert!(crate::storage::read_repair_transition_journal()
            .unwrap()
            .is_none());
        reset_test_lifecycle();
    }

    #[test]
    fn live_finalize_rejects_foreign_replacement_without_touching_bytes() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let root = staging_root(&connection).unwrap();
        let original = scope_staging_dir(&connection, &initial).unwrap();
        let staged = root.join(format!(".scope-cleanup-v3-{}", initial.scope_token));
        write_test_file(&staged.join("foreign/keep.bin"), b"ROUND2D6_FOREIGN_BYTES");
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let mut journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial,
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 64,
            enabled: true,
            phase: RepairTransitionJournalPhase::DatabaseCommitted,
        };
        let cleanup = PreparedExternalCleanup {
            original_directory: original,
            staged_directory: staged.clone(),
            directory_staged: true,
        };
        assert_eq!(
            finalize_external_cleanup(&cleanup, &mut journal).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_INVALID"
        );
        assert_eq!(
            fs::read(staged.join("foreign/keep.bin")).unwrap(),
            b"ROUND2D6_FOREIGN_BYTES"
        );
        assert!(staged.exists());
        assert!(!transition_finalizing_path(&root, &journal).exists());
        reset_test_lifecycle();
    }

    #[test]
    fn live_finalize_absent_staged_path_is_fail_closed() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let root = staging_root(&connection).unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let mut journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial.clone(),
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 66,
            enabled: true,
            phase: RepairTransitionJournalPhase::DatabaseCommitted,
        };
        let cleanup = PreparedExternalCleanup {
            original_directory: scope_staging_dir(&connection, &initial).unwrap(),
            staged_directory: root.join(format!(".scope-cleanup-v3-{}", initial.scope_token)),
            directory_staged: true,
        };
        assert_eq!(
            finalize_external_cleanup(&cleanup, &mut journal).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_INVALID"
        );
        reset_test_lifecycle();
    }

    #[test]
    fn missing_platform_file_identity_fails_closed_before_finalize_move() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().unwrap();
        let root = staging_root(&connection).unwrap();
        let staged = root.join(format!(".scope-cleanup-v3-{}", initial.scope_token));
        fs::create_dir_all(&staged).unwrap();
        let mut target_scope = new_scope(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            "terminal-beta".to_string(),
            initial.scope_epoch + 1,
        );
        target_scope.transition_pending = true;
        let mut journal = RepairTransitionJournal {
            version: 3,
            old_scope: initial.clone(),
            target_scope,
            transition_nonce: Uuid::new_v4().to_string(),
            directory_staged: true,
            directory_identity_primary: None,
            directory_identity_secondary: None,
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_terminal_id: "terminal-beta".to_string(),
            decision_generation: 67,
            enabled: true,
            phase: RepairTransitionJournalPhase::DatabaseCommitted,
        };
        create_transition_marker(&staged, &journal).unwrap();
        TRANSITION_IDENTITY_UNAVAILABLE.with(|unavailable| unavailable.set(true));
        let cleanup = PreparedExternalCleanup {
            original_directory: scope_staging_dir(&connection, &initial).unwrap(),
            staged_directory: staged.clone(),
            directory_staged: true,
        };
        assert_eq!(
            finalize_external_cleanup(&cleanup, &mut journal).unwrap_err(),
            "REPAIR_TRANSITION_MARKER_INVALID"
        );
        TRANSITION_IDENTITY_UNAVAILABLE.with(|unavailable| unavailable.set(false));
        assert!(staged.exists());
        reset_test_lifecycle();
    }

    #[test]
    fn strict_identity_restore_readback_failure_is_bounded_and_latched() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        crate::tests::fake_keyring::replace_next_write_with(
            "branch_id",
            "ROUND2D5_MIXED_IDENTITY_SENTINEL",
        );
        crate::tests::fake_keyring::after_next_write("terminal_id", || {
            crate::tests::fake_keyring::fail_read_after(
                "branch_id",
                1,
                "ROUND2D5_READBACK_BACKEND_SENTINEL",
            );
        });
        let error = crate::storage::replace_repair_identity_uncoordinated(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "terminal-beta",
        )
        .expect_err("strict restore readback failure must be distinct");
        assert_eq!(error, "REPAIR_IDENTITY_COMPENSATION_FAILED");
        assert!(!error.contains("SENTINEL"));
        let state = lifecycle().0.lock().unwrap();
        assert!(state.blocked && state.maintenance_failed);
        drop(state);
        reset_test_lifecycle();
    }

    #[test]
    fn producer_encrypts_exact_shared_offline_envelopes_and_allocates_aliases_atomically() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        cache_test_settings(&connection, true);

        let second_repair = TEST_OTHER_REPAIR_ID;
        let third_repair = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let create_cases = [
            (
                TEST_REPAIR_ID,
                TEST_OPERATION_ID,
                RepairOfflineCommand::CreateIntake {
                    intake_mode: "standard".to_string(),
                    is_anonymous: false,
                    customer_id: Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string()),
                    customer_device_id: Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string()),
                    priority: "normal".to_string(),
                    currency: "EUR".to_string(),
                    title: Some("Standard repair".to_string()),
                    intake_notes: Some("Private standard note".to_string()),
                    due_at: None,
                    offline_alias: None,
                    offline_sequence: None,
                },
            ),
            (
                second_repair,
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                RepairOfflineCommand::CreateIntake {
                    intake_mode: "quick_service".to_string(),
                    is_anonymous: true,
                    customer_id: None,
                    customer_device_id: None,
                    priority: "low".to_string(),
                    currency: "EUR".to_string(),
                    title: None,
                    intake_notes: None,
                    due_at: None,
                    offline_alias: None,
                    offline_sequence: None,
                },
            ),
            (
                third_repair,
                "ffffffff-ffff-4fff-8fff-ffffffffffff",
                RepairOfflineCommand::CreateIntake {
                    intake_mode: "quick_service".to_string(),
                    is_anonymous: false,
                    customer_id: Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string()),
                    customer_device_id: None,
                    priority: "high".to_string(),
                    currency: "EUR".to_string(),
                    title: Some("Linked quick service".to_string()),
                    intake_notes: None,
                    due_at: Some("2026-08-27T10:00:00Z".to_string()),
                    offline_alias: None,
                    offline_sequence: None,
                },
            ),
        ];
        for (index, (repair_id, operation_id, command)) in create_cases.into_iter().enumerate() {
            apply_offline_mutation(
                &connection,
                &RepairOfflineMutationInput {
                    operation_id: operation_id.to_string(),
                    repair_id: repair_id.to_string(),
                    expected_version: 0,
                    staff_session_id: TEST_SESSION_ID.to_string(),
                    occurred_at: format!("2026-08-26T10:0{index}:00Z"),
                    command,
                },
            )
            .expect("create an offline intake variant");
            let envelope = decrypt_queued_envelope(&connection, &scope, operation_id, repair_id, 0);
            assert_eq!(envelope["operation_id"], operation_id);
            assert_eq!(envelope["repair_id"], repair_id);
            assert_eq!(envelope["expected_version"], 0);
            assert_eq!(envelope["staff_session_id"], TEST_SESSION_ID);
            assert_eq!(envelope["command"], "create_intake");
            assert_eq!(
                envelope["payload"]["offline_alias"],
                format!("R-OFF-A19F-{:06}", index + 1)
            );
            assert_eq!(envelope["payload"]["offline_sequence"], index + 1);
            assert_eq!(envelope["payload"].as_object().unwrap().len(), 11);
        }

        let followups = [
            (
                "12121212-1212-4212-8212-121212121212",
                RepairOfflineCommand::AddNote {
                    note: "Private follow-up note".to_string(),
                    visibility: "internal".to_string(),
                },
                "add_note",
            ),
            (
                "13131313-1313-4313-8313-131313131313",
                RepairOfflineCommand::AssignRepair {
                    assigned_staff_id: Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string()),
                },
                "assign_repair",
            ),
            (
                "14141414-1414-4414-8414-141414141414",
                RepairOfflineCommand::UpdateDiagnosis {
                    diagnosis: Some("Private diagnosis draft".to_string()),
                    draft: true,
                },
                "update_diagnosis",
            ),
            (
                "15151515-1515-4515-8515-151515151515",
                RepairOfflineCommand::PlanLine {
                    line_id: "16161616-1616-4616-8616-161616161616".to_string(),
                    line_type: "part".to_string(),
                    name_snapshot: "Display assembly".to_string(),
                    sku_snapshot: Some("SKU-100".to_string()),
                    description: Some("Black assembly".to_string()),
                    quantity: "1.000".to_string(),
                    unit_cost_snapshot: Some("40.00".to_string()),
                    unit_price_snapshot: "75.00".to_string(),
                    vat_rate_snapshot: "24.00".to_string(),
                    retail_product_id: Some("17171717-1717-4717-8717-171717171717".to_string()),
                    retail_variant_id: None,
                    service_id: None,
                    display_order: 0,
                },
                "plan_line",
            ),
            (
                "18181818-1818-4818-8818-181818181818",
                RepairOfflineCommand::TransitionStatus {
                    target_status: "diagnosing".to_string(),
                    reason: None,
                    remain_consumed: false,
                },
                "transition_status",
            ),
        ];
        for (offset, (operation_id, command, expected_command)) in followups.into_iter().enumerate()
        {
            let expected_version = u64::try_from(offset + 1).unwrap();
            apply_offline_mutation(
                &connection,
                &RepairOfflineMutationInput {
                    operation_id: operation_id.to_string(),
                    repair_id: TEST_REPAIR_ID.to_string(),
                    expected_version,
                    staff_session_id: TEST_SESSION_ID.to_string(),
                    occurred_at: format!("2026-08-26T11:0{offset}:00Z"),
                    command,
                },
            )
            .expect("append exact offline command");
            let envelope = decrypt_queued_envelope(
                &connection,
                &scope,
                operation_id,
                TEST_REPAIR_ID,
                expected_version,
            );
            assert_eq!(envelope["command"], expected_command);
            assert_eq!(envelope["expected_version"], expected_version);
            assert!(envelope["payload"].get("type").is_none());
        }

        let plaintext_sentinels = [
            "Private standard note",
            "Private follow-up note",
            "Private diagnosis draft",
            "Display assembly",
        ];
        for sentinel in plaintext_sentinels {
            let leaked: bool = connection
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM parity_sync_queue
                          WHERE instr(CAST(data AS TEXT), ?1) > 0
                         UNION ALL
                         SELECT 1 FROM repair_cache
                          WHERE instr(CAST(workspace_ciphertext AS TEXT), ?1) > 0
                     )",
                    [sentinel],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            assert!(!leaked, "private repair text leaked in SQLite: {sentinel}");
        }

        let rollback_repair = "19191919-1919-4919-8919-191919191919";
        let mut colliding = create_standard_input();
        colliding.repair_id = rollback_repair.to_string();
        colliding.operation_id = TEST_OPERATION_ID.to_string();
        colliding.occurred_at = "2026-08-26T12:00:00Z".to_string();
        let collision_error = match apply_offline_mutation(&connection, &colliding) {
            Ok(_) => panic!("colliding operation id must fail the full producer transaction"),
            Err(error) => error,
        };
        assert_eq!(collision_error, "REPAIR_QUEUE_INSERT_FAILED");
        let rollback_counts = connection
            .query_row(
                "SELECT
                     (SELECT COUNT(*) FROM repair_alias_cache
                       WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3),
                     (SELECT COUNT(*) FROM repair_cache WHERE repair_id = ?4),
                     (SELECT COUNT(*) FROM parity_sync_queue WHERE record_id = ?4)",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    rollback_repair,
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .expect("inspect producer rollback");
        assert_eq!(
            rollback_counts,
            (3, 0, 0),
            "a late queue failure must roll back alias, cache, workspace and queue atomically"
        );
    }

    #[test]
    fn drain_validates_historical_transition_shape_without_latest_status_revalidation() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        apply_offline_mutation(&connection, &create_standard_input())
            .expect("create offline repair");

        let first_operation = "20202020-2020-4020-8020-202020202020";
        let second_operation = "21212121-2121-4121-8121-212121212121";
        for (operation_id, expected_version, target_status) in [
            (first_operation, 1, "diagnosing"),
            (second_operation, 2, "waiting_customer_approval"),
        ] {
            apply_offline_mutation(
                &connection,
                &RepairOfflineMutationInput {
                    operation_id: operation_id.to_string(),
                    repair_id: TEST_REPAIR_ID.to_string(),
                    expected_version,
                    staff_session_id: TEST_SESSION_ID.to_string(),
                    occurred_at: format!("2026-08-26T13:0{expected_version}:00Z"),
                    command: RepairOfflineCommand::TransitionStatus {
                        target_status: target_status.to_string(),
                        reason: None,
                        remain_consumed: false,
                    },
                },
            )
            .expect("queue sequential offline transition");
        }

        let first = queue_item(&connection, first_operation);
        let decoded = NATIVE_REPAIR_QUEUE_HOOKS
            .decode_command_envelope(&connection, &first)
            .expect("decrypt first queued transition");
        let context = crate::repair_transport::RepairQueueContext {
            queue_id: first.id.clone(),
            claim_generation: first.claim_generation,
            repair_id: first.record_id.clone(),
            operation_id: first.id.clone(),
            organization_id: first.organization_id.clone(),
            expected_version: u64::try_from(first.version).unwrap(),
        };
        NATIVE_REPAIR_QUEUE_HOOKS
            .validate_command_envelope(&connection, &context, &decoded)
            .expect("trusted historical transition must remain dispatchable after later optimism");

        let mut malformed: serde_json::Value =
            serde_json::from_str(&decoded).expect("parse decrypted transition");
        malformed["payload"]["target_status"] = serde_json::Value::String("delivered".into());
        assert!(NATIVE_REPAIR_QUEUE_HOOKS
            .validate_command_envelope(&connection, &context, &malformed.to_string())
            .is_err());
        malformed["payload"]["target_status"] = serde_json::Value::String("diagnosing".into());
        malformed["payload"]["reason"] = serde_json::Value::String("😀".repeat(501));
        assert!(NATIVE_REPAIR_QUEUE_HOOKS
            .validate_command_envelope(&connection, &context, &malformed.to_string())
            .is_err());
        malformed["payload"]
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_string(), serde_json::Value::Bool(true));
        assert!(NATIVE_REPAIR_QUEUE_HOOKS
            .validate_command_envelope(&connection, &context, &malformed.to_string())
            .is_err());
    }

    #[test]
    fn open_conflict_blocks_new_command_and_attachment_without_any_local_mutation() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");

        apply_offline_mutation(&connection, &create_standard_input())
            .expect("create command-conflict repair");
        let attachment_repair = TEST_OTHER_REPAIR_ID;
        let mut second_create = create_standard_input();
        second_create.repair_id = attachment_repair.to_string();
        second_create.operation_id = "22222222-aaaa-4222-8222-222222222222".to_string();
        second_create.occurred_at = "2026-08-26T14:01:00Z".to_string();
        apply_offline_mutation(&connection, &second_create)
            .expect("create attachment-conflict repair");
        seed_open_conflict(
            &connection,
            &scope,
            TEST_REPAIR_ID,
            "23232323-2323-4323-8323-232323232323",
            "24242424-2424-4424-8424-242424242424",
        );
        connection
            .execute(
                "UPDATE repair_cache SET has_conflict = 0 WHERE repair_id = ?1",
                [TEST_REPAIR_ID],
            )
            .expect("simulate open row with stale flag zero");
        seed_open_conflict(
            &connection,
            &scope,
            attachment_repair,
            "25252525-2525-4525-8525-252525252525",
            "26262626-2626-4626-8626-262626262626",
        );
        connection
            .execute(
                "DELETE FROM repair_conflicts WHERE repair_id = ?1",
                [attachment_repair],
            )
            .expect("simulate conflict flag one with missing row");
        let queue_before: i64 = connection
            .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
                row.get(0)
            })
            .unwrap();

        let command_result = apply_offline_mutation(
            &connection,
            &RepairOfflineMutationInput {
                operation_id: "27272727-2727-4727-8727-272727272727".to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 1,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T14:02:00Z".to_string(),
                command: RepairOfflineCommand::AddNote {
                    note: "Must never be written".to_string(),
                    visibility: "internal".to_string(),
                },
            },
        );
        let attachment_result = stage_attachment(
            &connection,
            &RepairAttachmentStageInput {
                attachment_id: "28282828-2828-4828-8828-282828282828".to_string(),
                operation_id: "29292929-2929-4929-8929-292929292929".to_string(),
                repair_id: attachment_repair.to_string(),
                expected_version: 1,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T14:03:00Z".to_string(),
                attachment_type: "diagnostic".to_string(),
                filename: "must-not-stage.jpg".to_string(),
                caption: Some("must not persist".to_string()),
                mime_type: "image/jpeg".to_string(),
                bytes: b"must-not-persist".to_vec(),
            },
        );
        assert_eq!(
            command_result.err().as_deref(),
            Some("REPAIR_CONFLICT_OPEN")
        );
        assert_eq!(
            attachment_result.err().as_deref(),
            Some("REPAIR_CONFLICT_OPEN")
        );
        let state = connection
            .query_row(
                "SELECT
                     (SELECT COUNT(*) FROM parity_sync_queue),
                     (SELECT COUNT(*) FROM repair_attachment_staging),
                     (SELECT SUM(optimistic_version) FROM repair_cache
                       WHERE repair_id IN (?1, ?2))",
                params![TEST_REPAIR_ID, attachment_repair],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(state, (queue_before, 0, 2));
        let staged_files = scope_staging_dir(&connection, &scope)
            .ok()
            .and_then(|path| fs::read_dir(path).ok())
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or(0);
        assert_eq!(
            staged_files, 0,
            "conflicted intake must not write attachment bytes"
        );
    }

    #[test]
    fn conflict_projection_display_number_is_nullable_in_v77() {
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        connection
            .execute(
                "INSERT INTO repair_conflicts (
                     organization_id, branch_id, terminal_id, conflict_id, repair_id,
                     operation_id, expected_version, current_version, display_number,
                     status_summary, updated_at_summary, allowed_transitions_json,
                     local_nonce, local_ciphertext, state, created_at
                 ) VALUES ('org', 'branch', 'terminal', 'conflict', 'repair', 'operation',
                           0, 1, NULL, 'received', '2026-08-26T14:00:00Z', '[]',
                           zeroblob(12), zeroblob(16), 'open', '2026-08-26T14:00:00Z')",
                [],
            )
            .expect("server may omit a safe display number");
    }

    #[test]
    fn command_conflict_parking_is_idempotent_and_parks_only_strict_later_same_scope_rows() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        apply_offline_mutation(&connection, &create_standard_input())
            .expect("create conflict repair");

        let operations = [
            (
                "30303030-3030-4030-8030-303030303030",
                RepairOfflineCommand::AddNote {
                    note: "predecessor".to_string(),
                    visibility: "internal".to_string(),
                },
            ),
            (
                "31313131-3131-4131-8131-313131313131",
                RepairOfflineCommand::AssignRepair {
                    assigned_staff_id: None,
                },
            ),
            (
                "32323232-3232-4232-8232-323232323232",
                RepairOfflineCommand::UpdateDiagnosis {
                    diagnosis: Some("later operation".to_string()),
                    draft: true,
                },
            ),
        ];
        for (offset, (operation_id, command)) in operations.iter().enumerate() {
            apply_offline_mutation(
                &connection,
                &RepairOfflineMutationInput {
                    operation_id: (*operation_id).to_string(),
                    repair_id: TEST_REPAIR_ID.to_string(),
                    expected_version: u64::try_from(offset + 1).unwrap(),
                    staff_session_id: TEST_SESSION_ID.to_string(),
                    occurred_at: format!("2026-08-26T15:0{offset}:00Z"),
                    command: command.clone(),
                },
            )
            .expect("append conflict dependency chain");
        }
        let failed_attachment_id = "35353535-3535-4535-8535-353535353535";
        let failed_attachment_operation = "36363636-3636-4636-8636-363636363636";
        stage_attachment(
            &connection,
            &RepairAttachmentStageInput {
                attachment_id: failed_attachment_id.to_string(),
                operation_id: failed_attachment_operation.to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 4,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T15:04:00Z".to_string(),
                attachment_type: "diagnostic".to_string(),
                filename: "failed-dependent.jpg".to_string(),
                caption: None,
                mime_type: "image/jpeg".to_string(),
                bytes: b"failed dependent attachment".to_vec(),
            },
        )
        .expect("stage later attachment dependency");
        let failed_command = "37373737-3737-4737-8737-373737373737";
        apply_offline_mutation(
            &connection,
            &RepairOfflineMutationInput {
                operation_id: failed_command.to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 5,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T15:05:00Z".to_string(),
                command: RepairOfflineCommand::AddNote {
                    note: "failed later command".to_string(),
                    visibility: "internal".to_string(),
                },
            },
        )
        .expect("append later failed command dependency");
        let source_operation = operations[1].0;
        let later_operation = operations[2].0;
        connection
            .execute(
                "UPDATE parity_sync_queue SET status = 'processing', claim_generation = 7
                  WHERE id = ?1",
                [source_operation],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE parity_sync_queue SET status = 'failed', error_message = 'OLD_ERROR'
                  WHERE id IN (?1, ?2)",
                params![failed_attachment_operation, failed_command],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE parity_sync_queue SET status = 'processing', claim_generation = 4
                  WHERE id = ?1",
                [later_operation],
            )
            .unwrap();
        let foreign_operation = "33333333-aaaa-4333-8333-333333333333";
        connection
            .execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, attempts, retry_delay_ms, priority, module_type,
                     conflict_strategy, version, claim_generation, status
                 ) VALUES (?1, 'repairs', ?2, 'INSERT', '{}', ?3,
                           '2026-08-26T15:10:00Z', 0, 1000, 100, 'repairs',
                           'manual', 3, 0, 'pending')",
                params![
                    foreign_operation,
                    TEST_REPAIR_ID,
                    "34343434-3434-4434-8434-343434343434",
                ],
            )
            .expect("seed same UUID in foreign tenant queue");

        let context = crate::repair_transport::RepairQueueContext {
            queue_id: source_operation.to_string(),
            claim_generation: 7,
            repair_id: TEST_REPAIR_ID.to_string(),
            operation_id: source_operation.to_string(),
            organization_id: scope.organization_id.clone(),
            expected_version: 2,
        };
        let projection = conflict_projection(source_operation, TEST_REPAIR_ID, 2, 5, None);
        NATIVE_REPAIR_QUEUE_HOOKS
            .park_conflict(&connection, &context, &projection)
            .expect("park first server conflict");
        NATIVE_REPAIR_QUEUE_HOOKS
            .park_conflict(&connection, &context, &projection)
            .expect("replay after hook commit is idempotent");
        let mut newer_projection = conflict_projection(
            source_operation,
            TEST_REPAIR_ID,
            2,
            7,
            Some("R-BR-26-000007"),
        );
        newer_projection.summary.status = crate::repair_transport::RepairStatus::Diagnosing;
        NATIVE_REPAIR_QUEUE_HOOKS
            .park_conflict(&connection, &context, &newer_projection)
            .expect("newer monotonic projection updates the existing open conflict");
        NATIVE_REPAIR_QUEUE_HOOKS
            .park_conflict(&connection, &context, &projection)
            .expect("late older projection is an idempotent no-op");

        let conflict_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM repair_conflicts WHERE operation_id = ?1",
                [source_operation],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(conflict_count, 1);
        let (display, current_version, status_summary, nonce, ciphertext): (
            Option<String>,
            i64,
            String,
            Vec<u8>,
            Vec<u8>,
        ) = connection
            .query_row(
                "SELECT display_number, current_version, status_summary,
                        local_nonce, local_ciphertext
                   FROM repair_conflicts WHERE operation_id = ?1",
                [source_operation],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(display.as_deref(), Some("R-BR-26-000007"));
        assert_eq!(current_version, 7);
        assert_eq!(status_summary, "diagnosing");
        let conflict_plaintext = decrypt(
            &scope,
            CryptoDomain::Conflict,
            "repairs",
            TEST_REPAIR_ID,
            Some(source_operation),
            7,
            &nonce,
            &ciphertext,
        )
        .expect("newest conflict ciphertext uses newest conflict AAD");
        let conflict_envelope: serde_json::Value =
            serde_json::from_slice(&conflict_plaintext).expect("parse conflict envelope");
        assert_eq!(conflict_envelope["operation_id"], source_operation);
        let statuses = [
            TEST_OPERATION_ID,
            operations[0].0,
            source_operation,
            later_operation,
            failed_attachment_operation,
            failed_command,
            foreign_operation,
        ]
        .map(|operation_id| {
            connection
                .query_row(
                    "SELECT status, claim_generation FROM parity_sync_queue WHERE id = ?1",
                    [operation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap()
        });
        assert_eq!(
            statuses,
            [
                ("pending".to_string(), 0),
                ("pending".to_string(), 0),
                ("conflict".to_string(), 8),
                ("conflict".to_string(), 5),
                ("conflict".to_string(), 0),
                ("conflict".to_string(), 0),
                ("pending".to_string(), 0),
            ],
            "source and strict-later same-scope rows park atomically; predecessors and foreign tenant stay untouched"
        );
        for operation_id in [failed_attachment_operation, failed_command] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT error_message FROM parity_sync_queue WHERE id = ?1",
                        [operation_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .unwrap()
                    .as_deref(),
                Some("REPAIR_DEPENDENCY_CONFLICT")
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT state FROM repair_attachment_staging WHERE attachment_id = ?1",
                    [failed_attachment_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "conflict"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT has_conflict FROM repair_cache WHERE repair_id = ?1",
                    [TEST_REPAIR_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        connection
            .execute(
                "UPDATE repair_conflicts
                    SET state = 'accepted_server', resolved_at = '2026-08-26T15:20:00Z'
                  WHERE operation_id = ?1",
                [source_operation],
            )
            .unwrap();
        let reopen = conflict_projection(source_operation, TEST_REPAIR_ID, 2, 8, None);
        assert!(NATIVE_REPAIR_QUEUE_HOOKS
            .park_conflict(&connection, &context, &reopen)
            .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT state, current_version FROM repair_conflicts WHERE operation_id = ?1",
                    [source_operation],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap(),
            ("accepted_server".to_string(), 7)
        );
    }

    #[test]
    fn conflict_hook_requires_exact_cache_row_and_rolls_back_every_side_effect() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        apply_offline_mutation(&connection, &create_standard_input())
            .expect("create conflict repair");
        connection
            .execute(
                "UPDATE parity_sync_queue SET status = 'processing', claim_generation = 2
                  WHERE id = ?1",
                [TEST_OPERATION_ID],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM repair_cache WHERE repair_id = ?1",
                [TEST_REPAIR_ID],
            )
            .unwrap();
        let context = crate::repair_transport::RepairQueueContext {
            queue_id: TEST_OPERATION_ID.to_string(),
            claim_generation: 2,
            repair_id: TEST_REPAIR_ID.to_string(),
            operation_id: TEST_OPERATION_ID.to_string(),
            organization_id: scope.organization_id.clone(),
            expected_version: 0,
        };
        assert!(NATIVE_REPAIR_QUEUE_HOOKS
            .park_conflict(
                &connection,
                &context,
                &conflict_projection(TEST_OPERATION_ID, TEST_REPAIR_ID, 0, 1, None),
            )
            .is_err());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM repair_conflicts", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status, claim_generation FROM parity_sync_queue WHERE id = ?1",
                    [TEST_OPERATION_ID],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap(),
            ("processing".to_string(), 2)
        );
    }

    #[test]
    fn attachment_conflict_uses_parent_bound_metadata_and_retains_staged_file() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        apply_offline_mutation(&connection, &create_standard_input())
            .expect("create attachment repair");
        stage_attachment(
            &connection,
            &RepairAttachmentStageInput {
                attachment_id: TEST_ATTACHMENT_ID.to_string(),
                operation_id: TEST_ATTACHMENT_OPERATION_ID.to_string(),
                repair_id: TEST_REPAIR_ID.to_string(),
                expected_version: 1,
                staff_session_id: TEST_SESSION_ID.to_string(),
                occurred_at: "2026-08-26T16:00:00Z".to_string(),
                attachment_type: "diagnostic".to_string(),
                filename: "conflict-photo.jpg".to_string(),
                caption: None,
                mime_type: "image/jpeg".to_string(),
                bytes: b"retain encrypted attachment".to_vec(),
            },
        )
        .expect("stage conflict attachment");
        let file_key: String = connection
            .query_row(
                "SELECT file_key FROM repair_attachment_staging WHERE attachment_id = ?1",
                [TEST_ATTACHMENT_ID],
                |row| row.get(0),
            )
            .unwrap();
        let path = attachment_final_path(&connection, &scope, &file_key).unwrap();
        connection
            .execute(
                "UPDATE parity_sync_queue SET status = 'processing', claim_generation = 3
                  WHERE id = ?1",
                [TEST_ATTACHMENT_OPERATION_ID],
            )
            .unwrap();
        let context = crate::repair_transport::RepairQueueContext {
            queue_id: TEST_ATTACHMENT_OPERATION_ID.to_string(),
            claim_generation: 3,
            repair_id: TEST_REPAIR_ID.to_string(),
            operation_id: TEST_ATTACHMENT_OPERATION_ID.to_string(),
            organization_id: scope.organization_id.clone(),
            expected_version: 1,
        };
        NATIVE_REPAIR_QUEUE_HOOKS
            .park_conflict(
                &connection,
                &context,
                &conflict_projection(TEST_ATTACHMENT_OPERATION_ID, TEST_REPAIR_ID, 1, 3, None),
            )
            .expect("park attachment conflict");
        assert!(
            path.exists(),
            "attachment conflict must retain encrypted bytes"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT state FROM repair_attachment_staging WHERE attachment_id = ?1",
                    [TEST_ATTACHMENT_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "conflict"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM parity_sync_queue WHERE id = ?1",
                    [TEST_ATTACHMENT_OPERATION_ID],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "conflict"
        );
    }

    const TEST_OPERATION_2: &str = "12121212-1212-4212-8212-121212121212";
    const TEST_OPERATION_3: &str = "13131313-1313-4313-8313-131313131313";

    fn transition_input(
        operation_id: &str,
        expected_version: u64,
        target_status: &str,
        occurred_at: &str,
    ) -> RepairOfflineMutationInput {
        RepairOfflineMutationInput {
            operation_id: operation_id.to_string(),
            repair_id: TEST_REPAIR_ID.to_string(),
            expected_version,
            staff_session_id: TEST_SESSION_ID.to_string(),
            occurred_at: occurred_at.to_string(),
            command: RepairOfflineCommand::TransitionStatus {
                target_status: target_status.to_string(),
                reason: None,
                remain_consumed: false,
            },
        }
    }

    fn processing_context(
        connection: &Connection,
        scope: &RepairScopeState,
        operation_id: &str,
        expected_version: u64,
        claim_generation: i64,
    ) -> crate::repair_transport::RepairQueueContext {
        assert_eq!(
            connection
                .execute(
                    "UPDATE parity_sync_queue
                        SET status = 'processing', claim_generation = ?1
                      WHERE id = ?2 AND organization_id = ?3",
                    params![claim_generation, operation_id, scope.organization_id],
                )
                .expect("claim repair source row"),
            1
        );
        crate::repair_transport::RepairQueueContext {
            queue_id: operation_id.to_string(),
            claim_generation,
            repair_id: TEST_REPAIR_ID.to_string(),
            operation_id: operation_id.to_string(),
            organization_id: scope.organization_id.clone(),
            expected_version,
        }
    }

    fn success_signal(
        status: crate::repair_transport::RepairStatus,
        version: u64,
        display_number: Option<&str>,
        provisional_alias: Option<&str>,
    ) -> crate::repair_transport::RepairSyncSuccessSignal {
        crate::repair_transport::RepairSyncSuccessSignal {
            repair_id: TEST_REPAIR_ID.to_string(),
            status,
            version,
            display_number: display_number.map(str::to_string),
            provisional_alias: provisional_alias.map(str::to_string),
        }
    }

    fn decrypt_workspace_json(
        connection: &Connection,
        scope: &RepairScopeState,
    ) -> serde_json::Value {
        let (optimistic_version, nonce, ciphertext) = connection
            .query_row(
                "SELECT optimistic_version, workspace_nonce, workspace_ciphertext
                   FROM repair_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    TEST_REPAIR_ID,
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .expect("read encrypted repair workspace");
        let plaintext = decrypt(
            scope,
            CryptoDomain::Cache,
            "workspace",
            TEST_REPAIR_ID,
            None,
            u64::try_from(optimistic_version).expect("valid optimistic version"),
            &nonce,
            &ciphertext,
        )
        .expect("decrypt repair workspace");
        serde_json::from_slice(&plaintext).expect("parse repair workspace")
    }

    fn replace_workspace_operations(
        connection: &Connection,
        scope: &RepairScopeState,
        operations: Vec<serde_json::Value>,
    ) {
        let optimistic_version: i64 = connection
            .query_row(
                "SELECT optimistic_version FROM repair_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    TEST_REPAIR_ID,
                ],
                |row| row.get(0),
            )
            .expect("read optimistic version");
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&serde_json::json!({ "operations": operations }))
                .expect("serialize replacement workspace"),
        );
        let encrypted = encrypt(
            scope,
            CryptoDomain::Cache,
            "workspace",
            TEST_REPAIR_ID,
            None,
            u64::try_from(optimistic_version).expect("valid optimistic version"),
            &plaintext,
        )
        .expect("encrypt replacement workspace");
        assert_eq!(
            connection
                .execute(
                    "UPDATE repair_cache SET workspace_nonce = ?1, workspace_ciphertext = ?2
                      WHERE organization_id = ?3 AND branch_id = ?4 AND terminal_id = ?5
                        AND repair_id = ?6",
                    params![
                        encrypted.nonce.as_slice(),
                        encrypted.ciphertext.as_slice(),
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        TEST_REPAIR_ID,
                    ],
                )
                .expect("replace repair workspace"),
            1
        );
    }

    fn repair_state_fingerprint(connection: &Connection, scope: &RepairScopeState) -> String {
        let cache = connection
            .query_row(
                "SELECT display_number, COALESCE(official_number, ''),
                        COALESCE(provisional_number, ''), status, authoritative_status,
                        authoritative_version, optimistic_version, scope_generation,
                        hex(workspace_nonce), hex(workspace_ciphertext), dirty,
                        has_conflict, needs_refetch, updated_at
                   FROM repair_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND repair_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    TEST_REPAIR_ID,
                ],
                |row| {
                    Ok(format!(
                        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, i64>(12)?,
                        row.get::<_, String>(13)?,
                    ))
                },
            )
            .expect("fingerprint repair cache");
        let mut aliases = Vec::new();
        let mut statement = connection
            .prepare(
                "SELECT alias, repair_id, is_official, created_at
                   FROM repair_alias_cache
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                  ORDER BY alias",
            )
            .expect("prepare alias fingerprint");
        let rows = statement
            .query_map(
                params![scope.organization_id, scope.branch_id, scope.terminal_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .expect("query alias fingerprint");
        for row in rows {
            aliases.push(row.expect("read alias fingerprint"));
        }
        drop(statement);
        let mut queue = Vec::new();
        let mut statement = connection
            .prepare(
                "SELECT id, record_id, data, version, status, claim_generation,
                        COALESCE(error_message, '')
                   FROM parity_sync_queue
                  WHERE organization_id = ?1 AND record_id = ?2
                  ORDER BY id",
            )
            .expect("prepare queue fingerprint");
        let rows = statement
            .query_map(params![scope.organization_id, TEST_REPAIR_ID], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .expect("query queue fingerprint");
        for row in rows {
            queue.push(row.expect("read queue fingerprint"));
        }
        format!("{cache:?}|{aliases:?}|{queue:?}")
    }

    #[test]
    fn command_success_removes_exact_source_and_replays_later_workspace_atomically() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        apply_offline_mutation(&connection, &create_standard_input()).unwrap();
        apply_offline_mutation(
            &connection,
            &transition_input(TEST_OPERATION_2, 1, "diagnosing", "2026-08-26T10:01:00Z"),
        )
        .unwrap();
        let later_ciphertext: String = connection
            .query_row(
                "SELECT data FROM parity_sync_queue WHERE id = ?1",
                [TEST_OPERATION_2],
                |row| row.get(0),
            )
            .unwrap();
        let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 4);

        NATIVE_REPAIR_QUEUE_HOOKS
            .reconcile_success(
                &connection,
                &context,
                &success_signal(
                    crate::repair_transport::RepairStatus::Received,
                    1,
                    Some("R-ATH-26-000001"),
                    Some("R-OFF-A19F-000001"),
                ),
            )
            .expect("reconcile acknowledged create");

        assert_eq!(
            connection
                .query_row(
                    "SELECT status, authoritative_status, authoritative_version,
                            optimistic_version, dirty
                       FROM repair_cache WHERE repair_id = ?1",
                    [TEST_REPAIR_ID],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?
                    )),
                )
                .unwrap(),
            ("diagnosing".to_string(), "received".to_string(), 1, 2, 1),
            "authoritative create must be the base for replaying the later transition"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                    [TEST_OPERATION_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "the hook owns crash-safe deletion of the exact claimed source row"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT data FROM parity_sync_queue WHERE id = ?1",
                    [TEST_OPERATION_2],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            later_ciphertext,
            "later queue ciphertext must remain byte-for-byte intact"
        );
        let workspace = decrypt_workspace_json(&connection, &scope);
        let operations = workspace["operations"].as_array().unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0]["operation_id"], TEST_OPERATION_2);
    }

    #[test]
    fn command_success_rejects_missing_or_duplicate_source_without_any_state_change() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);

        for case in [
            "missing",
            "duplicate_source",
            "phantom_source_version",
            "nonadjacent_duplicate_operation",
        ] {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            apply_offline_mutation(
                &connection,
                &RepairOfflineMutationInput {
                    operation_id: TEST_OPERATION_2.to_string(),
                    repair_id: TEST_REPAIR_ID.to_string(),
                    expected_version: 1,
                    staff_session_id: TEST_SESSION_ID.to_string(),
                    occurred_at: "2026-08-26T10:01:00Z".to_string(),
                    command: RepairOfflineCommand::AddNote {
                        note: "Later encrypted note".to_string(),
                        visibility: "internal".to_string(),
                    },
                },
            )
            .unwrap();
            let source =
                decrypt_queued_envelope(&connection, &scope, TEST_OPERATION_ID, TEST_REPAIR_ID, 0);
            let later =
                decrypt_queued_envelope(&connection, &scope, TEST_OPERATION_2, TEST_REPAIR_ID, 1);
            let operations = match case {
                "missing" => vec![later],
                "duplicate_source" => vec![source.clone(), source, later],
                "phantom_source_version" => {
                    let mut phantom = source.clone();
                    phantom["expected_version"] = serde_json::json!(2);
                    vec![source, later, phantom]
                }
                "nonadjacent_duplicate_operation" => {
                    let mut separator = serde_json::json!({
                        "operation_id": TEST_OPERATION_3,
                        "repair_id": TEST_REPAIR_ID,
                        "expected_version": 2,
                        "staff_session_id": TEST_SESSION_ID,
                        "command": "stage_attachment",
                        "payload": { "attachment_id": TEST_OTHER_REPAIR_ID },
                        "occurred_at": "2026-08-26T10:02:00Z"
                    });
                    let mut duplicate_later = later.clone();
                    duplicate_later["expected_version"] = serde_json::json!(3);
                    vec![
                        source,
                        later,
                        std::mem::take(&mut separator),
                        duplicate_later,
                    ]
                }
                _ => unreachable!(),
            };
            replace_workspace_operations(&connection, &scope, operations);
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 9);
            let before = repair_state_fingerprint(&connection, &scope);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        None,
                        None,
                    ),
                )
                .expect_err("workspace must contain exactly one source operation");
            assert_eq!(error.code(), "REPAIR_RECONCILIATION_INVALID");
            assert_eq!(
                repair_state_fingerprint(&connection, &scope),
                before,
                "case {case}"
            );
        }
    }

    #[test]
    fn command_success_alias_collision_rolls_back_and_same_repair_alias_promotes_once() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        const OFFICIAL: &str = "R-ATH-26-000777";

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 2);
            connection
                .execute(
                    "INSERT INTO repair_alias_cache (
                         organization_id, branch_id, terminal_id, alias, repair_id,
                         is_official, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, '2026-08-26T09:00:00Z')",
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        OFFICIAL,
                        TEST_OTHER_REPAIR_ID,
                    ],
                )
                .unwrap();
            let before = repair_state_fingerprint(&connection, &scope);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some(OFFICIAL),
                        Some("R-OFF-A19F-000001"),
                    ),
                )
                .expect_err("cross-repair alias collision must fail closed");
            assert_eq!(error.code(), "REPAIR_RECONCILIATION_ALIAS_CONFLICT");
            assert_eq!(repair_state_fingerprint(&connection, &scope), before);
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 2);
            connection
                .execute(
                    "INSERT INTO repair_alias_cache (
                         organization_id, branch_id, terminal_id, alias, repair_id,
                         is_official, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 0, '2026-08-26T09:00:00Z')",
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        OFFICIAL,
                        TEST_REPAIR_ID,
                    ],
                )
                .unwrap();
            NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some(OFFICIAL),
                        Some("R-OFF-A19F-000001"),
                    ),
                )
                .expect("promote same-repair aliases deterministically");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*), MAX(is_official) FROM repair_alias_cache
                          WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                            AND alias = ?4 AND repair_id = ?5",
                        params![
                            scope.organization_id,
                            scope.branch_id,
                            scope.terminal_id,
                            OFFICIAL,
                            TEST_REPAIR_ID,
                        ],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .unwrap(),
                (1, 1)
            );
        }
    }

    fn seed_cache_official_number(
        connection: &Connection,
        scope: &RepairScopeState,
        official_number: &str,
    ) {
        assert_eq!(
            connection
                .execute(
                    "UPDATE repair_cache
                        SET display_number = ?1, official_number = ?1
                      WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                        AND repair_id = ?5",
                    params![
                        official_number,
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        TEST_REPAIR_ID,
                    ],
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .execute(
                    "INSERT INTO repair_alias_cache (
                         organization_id, branch_id, terminal_id, alias, repair_id,
                         is_official, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, '2026-08-26T09:00:00Z')",
                    params![
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        official_number,
                        TEST_REPAIR_ID,
                    ],
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn command_success_enforces_immutable_official_number_before_any_reconciliation_mutation() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        const OFFICIAL_X: &str = "R-ATH-26-000321";
        const OFFICIAL_Y: &str = "R-ATH-26-000654";
        const PROVISIONAL: &str = "R-OFF-A19F-000001";

        for ordering in ["newer", "equal", "stale"] {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            seed_cache_official_number(&connection, &scope, OFFICIAL_X);
            match ordering {
                "newer" => {}
                "equal" => {
                    rewrite_cache_authority(&connection, &scope, "received", 1, "received", 1)
                }
                "stale" => {
                    rewrite_cache_authority(&connection, &scope, "diagnosing", 2, "diagnosing", 2)
                }
                _ => unreachable!(),
            }
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 30);
            let before = repair_state_fingerprint(&connection, &scope);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some(OFFICIAL_Y),
                        Some(PROVISIONAL),
                    ),
                )
                .expect_err("a server signal cannot replace an immutable official number");
            assert_eq!(
                error.code(),
                "REPAIR_RECONCILIATION_OFFICIAL_MISMATCH",
                "ordering {ordering}"
            );
            assert_eq!(
                repair_state_fingerprint(&connection, &scope),
                before,
                "official mismatch must roll back aliases, cache, workspace and source queue"
            );
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            seed_cache_official_number(&connection, &scope, OFFICIAL_X);
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 31);
            NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some(OFFICIAL_X),
                        Some(PROVISIONAL),
                    ),
                )
                .expect("the same official number must reconcile idempotently");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*), MAX(is_official) FROM repair_alias_cache
                          WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                            AND alias = ?4 AND repair_id = ?5",
                        params![
                            scope.organization_id,
                            scope.branch_id,
                            scope.terminal_id,
                            OFFICIAL_X,
                            TEST_REPAIR_ID,
                        ],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .unwrap(),
                (1, 1)
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT is_official FROM repair_alias_cache
                          WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                            AND alias = ?4 AND repair_id = ?5",
                        params![
                            scope.organization_id,
                            scope.branch_id,
                            scope.terminal_id,
                            PROVISIONAL,
                            TEST_REPAIR_ID,
                        ],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0,
                "provisional aliases remain independent from the official number"
            );
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 32);
            NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some(OFFICIAL_Y),
                        Some(PROVISIONAL),
                    ),
                )
                .expect("a non-stale signal may install the first official number");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT official_number FROM repair_cache WHERE repair_id = ?1",
                        [TEST_REPAIR_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
                OFFICIAL_Y
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM repair_alias_cache
                          WHERE alias = ?1 AND repair_id = ?2 AND is_official = 1",
                        params![OFFICIAL_Y, TEST_REPAIR_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1
            );
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            rewrite_cache_authority(&connection, &scope, "diagnosing", 2, "diagnosing", 2);
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 33);
            let before = repair_state_fingerprint(&connection, &scope);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some(OFFICIAL_Y),
                        Some(PROVISIONAL),
                    ),
                )
                .expect_err("a stale signal cannot install a previously absent official number");
            assert_eq!(error.code(), "REPAIR_RECONCILIATION_OFFICIAL_MISMATCH");
            assert_eq!(repair_state_fingerprint(&connection, &scope), before);
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            seed_cache_official_number(&connection, &scope, OFFICIAL_X);
            assert_eq!(
                connection
                    .execute(
                        "UPDATE repair_alias_cache SET repair_id = ?1
                          WHERE organization_id = ?2 AND branch_id = ?3 AND terminal_id = ?4
                            AND alias = ?5",
                        params![
                            TEST_OTHER_REPAIR_ID,
                            scope.organization_id,
                            scope.branch_id,
                            scope.terminal_id,
                            PROVISIONAL,
                        ],
                    )
                    .unwrap(),
                1
            );
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 34);
            let before = repair_state_fingerprint(&connection, &scope);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some(OFFICIAL_X),
                        Some(PROVISIONAL),
                    ),
                )
                .expect_err("provisional alias collision remains independently fail-closed");
            assert_eq!(error.code(), "REPAIR_RECONCILIATION_ALIAS_CONFLICT");
            assert_eq!(repair_state_fingerprint(&connection, &scope), before);
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 35);
            let before = repair_state_fingerprint(&connection, &scope);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        None,
                        Some("R-OFF-A19F-000099"),
                    ),
                )
                .expect_err("create acknowledgement must echo its exact offline alias");
            assert_eq!(error.code(), "REPAIR_RECONCILIATION_INVALID");
            assert_eq!(repair_state_fingerprint(&connection, &scope), before);
        }

        for provisional_alias in [Some(PROVISIONAL), None] {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            apply_offline_mutation(
                &connection,
                &RepairOfflineMutationInput {
                    operation_id: TEST_OPERATION_2.to_string(),
                    repair_id: TEST_REPAIR_ID.to_string(),
                    expected_version: 1,
                    staff_session_id: TEST_SESSION_ID.to_string(),
                    occurred_at: "2026-08-26T10:01:00Z".to_string(),
                    command: RepairOfflineCommand::AddNote {
                        note: "Non-create acknowledgement".to_string(),
                        visibility: "internal".to_string(),
                    },
                },
            )
            .unwrap();
            let context = processing_context(&connection, &scope, TEST_OPERATION_2, 1, 36);
            let before = repair_state_fingerprint(&connection, &scope);
            let outcome = NATIVE_REPAIR_QUEUE_HOOKS.reconcile_success(
                &connection,
                &context,
                &success_signal(
                    crate::repair_transport::RepairStatus::Received,
                    2,
                    None,
                    provisional_alias,
                ),
            );
            if provisional_alias.is_some() {
                let error = outcome
                    .expect_err("non-create acknowledgement must not carry provisional alias");
                assert_eq!(error.code(), "REPAIR_RECONCILIATION_INVALID");
                assert_eq!(repair_state_fingerprint(&connection, &scope), before);
            } else {
                outcome.expect("non-create acknowledgement with null provisional alias is valid");
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                            [TEST_OPERATION_2],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap(),
                    0
                );
            }
        }
    }

    #[test]
    fn command_success_rejects_provisional_alias_not_bound_to_exact_source_command() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        apply_offline_mutation(&connection, &create_standard_input()).unwrap();
        let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 37);
        let before = repair_state_fingerprint(&connection, &scope);
        let error = NATIVE_REPAIR_QUEUE_HOOKS
            .reconcile_success(
                &connection,
                &context,
                &success_signal(
                    crate::repair_transport::RepairStatus::Received,
                    1,
                    None,
                    Some("R-OFF-A19F-000099"),
                ),
            )
            .expect_err("create success must echo the source envelope offline alias");
        assert_eq!(error.code(), "REPAIR_RECONCILIATION_INVALID");
        assert_eq!(repair_state_fingerprint(&connection, &scope), before);
    }

    #[test]
    fn command_success_replays_only_future_status_and_never_regresses_stale_authority() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            apply_offline_mutation(
                &connection,
                &transition_input(TEST_OPERATION_2, 1, "diagnosing", "2026-08-26T10:01:00Z"),
            )
            .unwrap();
            apply_offline_mutation(
                &connection,
                &transition_input(
                    TEST_OPERATION_3,
                    2,
                    "waiting_customer_approval",
                    "2026-08-26T10:02:00Z",
                ),
            )
            .unwrap();
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 5);
            NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Diagnosing,
                        2,
                        Some("R-ATH-26-000009"),
                        Some("R-OFF-A19F-000001"),
                    ),
                )
                .expect("reconcile jumping authoritative version");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT status, authoritative_status, authoritative_version,
                                optimistic_version, dirty
                           FROM repair_cache WHERE repair_id = ?1",
                        [TEST_REPAIR_ID],
                        |row| Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?
                        )),
                    )
                    .unwrap(),
                (
                    "waiting_customer_approval".to_string(),
                    "diagnosing".to_string(),
                    2,
                    3,
                    1,
                ),
                "only expected_version >= authoritative signal may project over its status"
            );
            let workspace = decrypt_workspace_json(&connection, &scope);
            assert_eq!(workspace["operations"].as_array().unwrap().len(), 2);
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            apply_offline_mutation(
                &connection,
                &transition_input(TEST_OPERATION_2, 1, "diagnosing", "2026-08-26T10:01:00Z"),
            )
            .unwrap();
            assert_eq!(
                connection
                    .execute(
                        "UPDATE repair_cache
                            SET display_number = 'R-ATH-26-OLD', official_number = 'R-ATH-26-OLD',
                                status = 'ready', authoritative_status = 'ready',
                                authoritative_version = 2
                          WHERE repair_id = ?1",
                        [TEST_REPAIR_ID],
                    )
                    .unwrap(),
                1
            );
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 6);
            NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some("R-ATH-26-OLD"),
                        Some("R-OFF-A19F-000001"),
                    ),
                )
                .expect("remove stale acknowledged operation without authority regression");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT display_number, official_number, status, authoritative_status,
                                authoritative_version, optimistic_version, dirty
                           FROM repair_cache WHERE repair_id = ?1",
                        [TEST_REPAIR_ID],
                        |row| Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?
                        )),
                    )
                    .unwrap(),
                (
                    "R-ATH-26-OLD".to_string(),
                    "R-ATH-26-OLD".to_string(),
                    "ready".to_string(),
                    "ready".to_string(),
                    2,
                    2,
                    1,
                )
            );
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            apply_offline_mutation(&connection, &create_standard_input()).unwrap();
            apply_offline_mutation(
                &connection,
                &transition_input(TEST_OPERATION_2, 1, "diagnosing", "2026-08-26T10:01:00Z"),
            )
            .unwrap();
            assert_eq!(
                connection
                    .execute(
                        "UPDATE repair_cache
                            SET authoritative_status = 'diagnosing', authoritative_version = 1
                          WHERE repair_id = ?1",
                        [TEST_REPAIR_ID],
                    )
                    .unwrap(),
                1
            );
            let context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 8);
            let before = repair_state_fingerprint(&connection, &scope);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_success(
                    &connection,
                    &context,
                    &success_signal(
                        crate::repair_transport::RepairStatus::Received,
                        1,
                        Some("R-ATH-26-EQUAL-MISMATCH"),
                        Some("R-OFF-A19F-000001"),
                    ),
                )
                .expect_err("equal authoritative version with another status must fail closed");
            assert_eq!(error.code(), "REPAIR_RECONCILIATION_INVALID");
            assert_eq!(repair_state_fingerprint(&connection, &scope), before);
        }
    }

    #[test]
    fn command_success_requires_exact_claimed_source_row_and_rolls_back_on_zero_match() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        apply_offline_mutation(&connection, &create_standard_input()).unwrap();
        let mut context = processing_context(&connection, &scope, TEST_OPERATION_ID, 0, 11);
        context.claim_generation = 10;
        let before = repair_state_fingerprint(&connection, &scope);
        let error = NATIVE_REPAIR_QUEUE_HOOKS
            .reconcile_success(
                &connection,
                &context,
                &success_signal(
                    crate::repair_transport::RepairStatus::Received,
                    1,
                    None,
                    Some("R-OFF-A19F-000001"),
                ),
            )
            .expect_err("stale claim generation must not reconcile or delete source");
        assert_eq!(error.code(), "REPAIR_RECONCILIATION_SOURCE_MISSING");
        assert_eq!(repair_state_fingerprint(&connection, &scope), before);
    }

    fn attachment_input() -> RepairAttachmentStageInput {
        RepairAttachmentStageInput {
            attachment_id: TEST_ATTACHMENT_ID.to_string(),
            operation_id: TEST_ATTACHMENT_OPERATION_ID.to_string(),
            repair_id: TEST_REPAIR_ID.to_string(),
            expected_version: 1,
            staff_session_id: TEST_SESSION_ID.to_string(),
            occurred_at: "2026-08-26T11:00:00Z".to_string(),
            attachment_type: "diagnostic".to_string(),
            filename: "repair-proof.jpg".to_string(),
            caption: Some("Encrypted diagnostic photo".to_string()),
            mime_type: "image/jpeg".to_string(),
            bytes: b"attachment-success-fixture".to_vec(),
        }
    }

    fn stage_attachment_fixture(connection: &Connection, scope: &RepairScopeState) -> PathBuf {
        apply_offline_mutation(connection, &create_standard_input()).unwrap();
        stage_attachment(connection, &attachment_input()).unwrap();
        let file_key: String = connection
            .query_row(
                "SELECT file_key FROM repair_attachment_staging
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND attachment_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    TEST_ATTACHMENT_ID,
                ],
                |row| row.get(0),
            )
            .unwrap();
        attachment_final_path(connection, scope, &file_key).unwrap()
    }

    fn attachment_result(
        status: crate::repair_transport::RepairStatus,
        version: u64,
    ) -> crate::repair_transport::RepairAttachmentUploadResult {
        crate::repair_transport::RepairAttachmentUploadResult {
            attachment_id: TEST_ATTACHMENT_ID.to_string(),
            repair_id: TEST_REPAIR_ID.to_string(),
            status,
            version,
        }
    }

    fn attachment_state_fingerprint(
        connection: &Connection,
        scope: &RepairScopeState,
        path: &Path,
    ) -> String {
        let staging = connection
            .query_row(
                "SELECT attachment_id, repair_id, operation_id, queue_id,
                        expected_version, scope_generation, file_key,
                        hex(metadata_nonce), hex(metadata_ciphertext), sha256_hex,
                        mime_type, size_bytes, state, COALESCE(server_version, -1),
                        COALESCE(cleanup_error_code, ''), created_at, updated_at
                   FROM repair_attachment_staging
                  WHERE organization_id = ?1 AND branch_id = ?2 AND terminal_id = ?3
                    AND attachment_id = ?4",
                params![
                    scope.organization_id,
                    scope.branch_id,
                    scope.terminal_id,
                    TEST_ATTACHMENT_ID,
                ],
                |row| {
                    let mut values = Vec::with_capacity(17);
                    for index in [0, 1, 2, 3, 6, 7, 8, 9, 10, 12, 14, 15, 16] {
                        values.push(row.get::<_, String>(index)?);
                    }
                    values.push(row.get::<_, i64>(4)?.to_string());
                    values.push(row.get::<_, i64>(5)?.to_string());
                    values.push(row.get::<_, i64>(11)?.to_string());
                    values.push(row.get::<_, i64>(13)?.to_string());
                    Ok(values.join("|"))
                },
            )
            .optional()
            .expect("fingerprint attachment staging");
        let source_queue = connection
            .query_row(
                "SELECT id, table_name, record_id, operation, data, organization_id,
                        status, version, claim_generation, COALESCE(module_type, ''),
                        conflict_strategy, COALESCE(error_message, '')
                   FROM parity_sync_queue WHERE id = ?1",
                [TEST_ATTACHMENT_OPERATION_ID],
                |row| {
                    Ok(format!(
                        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                    ))
                },
            )
            .optional()
            .expect("fingerprint attachment source queue");
        let file = if path.is_dir() {
            "DIRECTORY".to_string()
        } else if path.exists() {
            format!("FILE:{:x}", Sha256::digest(fs::read(path).unwrap()))
        } else {
            "MISSING".to_string()
        };
        format!(
            "{}|{:?}|{:?}|{}",
            repair_state_fingerprint(connection, scope),
            staging,
            source_queue,
            file
        )
    }

    fn rewrite_cache_authority(
        connection: &Connection,
        scope: &RepairScopeState,
        authoritative_status: &str,
        authoritative_version: u64,
        optimistic_status: &str,
        optimistic_version: u64,
    ) {
        let workspace = Zeroizing::new(
            serde_json::to_vec(&decrypt_workspace_json(connection, scope))
                .expect("serialize authority workspace"),
        );
        let encrypted = encrypt(
            scope,
            CryptoDomain::Cache,
            "workspace",
            TEST_REPAIR_ID,
            None,
            optimistic_version,
            &workspace,
        )
        .expect("reencrypt authority workspace");
        assert_eq!(
            connection
                .execute(
                    "UPDATE repair_cache
                        SET authoritative_status = ?1, authoritative_version = ?2,
                            status = ?3, optimistic_version = ?4,
                            workspace_nonce = ?5, workspace_ciphertext = ?6
                      WHERE organization_id = ?7 AND branch_id = ?8 AND terminal_id = ?9
                        AND repair_id = ?10",
                    params![
                        authoritative_status,
                        i64::try_from(authoritative_version).unwrap(),
                        optimistic_status,
                        i64::try_from(optimistic_version).unwrap(),
                        encrypted.nonce.as_slice(),
                        encrypted.ciphertext.as_slice(),
                        scope.organization_id,
                        scope.branch_id,
                        scope.terminal_id,
                        TEST_REPAIR_ID,
                    ],
                )
                .unwrap(),
            1
        );
    }

    type AttachmentReadGate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    static ATTACHMENT_READ_GATE: OnceLock<Mutex<Option<AttachmentReadGate>>> = OnceLock::new();

    fn pause_before_attachment_reconciliation_read(sql: &str) {
        if !sql.contains("FROM repair_attachment_staging s") {
            return;
        }
        let gate = ATTACHMENT_READ_GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some((reached, release)) = gate {
            let _ = reached.send(());
            let _ = release.recv_timeout(std::time::Duration::from_secs(5));
        }
    }

    #[test]
    fn attachment_success_opens_immediate_transaction_before_reading_staging_or_cache() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("lock repair database");
            stage_attachment_fixture(&connection, &scope);
            processing_context(&connection, &scope, TEST_ATTACHMENT_OPERATION_ID, 1, 3);
        }

        let (reached_tx, reached_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *ATTACHMENT_READ_GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((reached_tx, release_rx));
        let mut hook_connection = Connection::open(database.db_path()).unwrap();
        hook_connection.trace(Some(pause_before_attachment_reconciliation_read));
        let context = crate::repair_transport::RepairQueueContext {
            queue_id: TEST_ATTACHMENT_OPERATION_ID.to_string(),
            claim_generation: 3,
            repair_id: TEST_REPAIR_ID.to_string(),
            operation_id: TEST_ATTACHMENT_OPERATION_ID.to_string(),
            organization_id: scope.organization_id.clone(),
            expected_version: 1,
        };
        let result = attachment_result(crate::repair_transport::RepairStatus::Received, 2);
        let worker_keyring: Vec<(String, String)> = [
            "organization_id",
            "branch_id",
            "terminal_id",
            crate::storage::KEY_REPAIR_SCOPE_V1,
            crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "pos_session",
        ]
        .into_iter()
        .map(|key| {
            (
                key.to_string(),
                crate::storage::get_credential(key).expect("copy worker fake keyring value"),
            )
        })
        .collect();
        let worker = std::thread::spawn(move || {
            let _worker_keyring = crate::tests::fake_keyring::install_seeded(worker_keyring);
            NATIVE_REPAIR_QUEUE_HOOKS.reconcile_attachment_success(
                &hook_connection,
                &context,
                &result,
            )
        });
        reached_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("attachment reconciliation must reach its scoped SELECT");

        let contender = Connection::open(database.db_path()).unwrap();
        contender
            .busy_timeout(std::time::Duration::from_millis(100))
            .unwrap();
        let competing_writer_acquired = contender.execute_batch("BEGIN IMMEDIATE").is_ok();
        if competing_writer_acquired {
            contender.execute_batch("ROLLBACK").unwrap();
        }
        release_tx.send(()).unwrap();
        let hook_result = worker.join().expect("join attachment reconciler");
        assert!(
            !competing_writer_acquired,
            "the hook must hold BEGIN IMMEDIATE before its first staging/cache read"
        );
        hook_result.expect("attachment reconciliation should finish after releasing trace gate");
    }

    #[test]
    fn attachment_success_atomically_removes_exact_workspace_and_queue_source_then_replays_later() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock repair database");
        let path = stage_attachment_fixture(&connection, &scope);
        apply_offline_mutation(
            &connection,
            &transition_input(TEST_OPERATION_3, 2, "diagnosing", "2026-08-26T11:01:00Z"),
        )
        .unwrap();
        let later_ciphertext: String = connection
            .query_row(
                "SELECT data FROM parity_sync_queue WHERE id = ?1",
                [TEST_OPERATION_3],
                |row| row.get(0),
            )
            .unwrap();
        let context = processing_context(&connection, &scope, TEST_ATTACHMENT_OPERATION_ID, 1, 7);

        NATIVE_REPAIR_QUEUE_HOOKS
            .reconcile_attachment_success(
                &connection,
                &context,
                &attachment_result(crate::repair_transport::RepairStatus::Received, 2),
            )
            .expect("reconcile uploaded attachment");

        assert_eq!(
            connection
                .query_row(
                    "SELECT status, authoritative_status, authoritative_version,
                            optimistic_version, dirty
                       FROM repair_cache WHERE repair_id = ?1",
                    [TEST_REPAIR_ID],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?
                    )),
                )
                .unwrap(),
            ("diagnosing".to_string(), "received".to_string(), 2, 3, 1,)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                    [TEST_ATTACHMENT_OPERATION_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM repair_attachment_staging
                      WHERE attachment_id = ?1",
                    [TEST_ATTACHMENT_ID],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "successful post-commit unlink must remove the exact confirmed tombstone"
        );
        assert!(!path.exists());
        assert_eq!(
            connection
                .query_row(
                    "SELECT data FROM parity_sync_queue WHERE id = ?1",
                    [TEST_OPERATION_3],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            later_ciphertext
        );
        let workspace = decrypt_workspace_json(&connection, &scope);
        let operations = workspace["operations"].as_array().unwrap();
        assert_eq!(operations.len(), 2);
        assert!(operations
            .iter()
            .all(|operation| { operation["operation_id"] != TEST_ATTACHMENT_OPERATION_ID }));
        assert!(operations
            .iter()
            .any(|operation| { operation["operation_id"] == TEST_OPERATION_3 }));
    }

    #[test]
    fn attachment_success_rejects_missing_duplicate_or_mismatched_identity_with_full_rollback() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);

        for case in [
            "missing",
            "duplicate",
            "wrong_attachment",
            "stale_claim",
            "not_queued",
            "wrong_table",
            "wrong_record",
            "wrong_version",
            "wrong_status",
            "phantom_source_version",
            "duplicate_attachment_identity",
            "nonadjacent_duplicate_operation",
        ] {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            let path = stage_attachment_fixture(&connection, &scope);
            let workspace = decrypt_workspace_json(&connection, &scope);
            let mut operations = workspace["operations"].as_array().unwrap().clone();
            let stage_index = operations
                .iter()
                .position(|operation| operation["operation_id"] == TEST_ATTACHMENT_OPERATION_ID)
                .unwrap();
            match case {
                "missing" => {
                    operations.remove(stage_index);
                    replace_workspace_operations(&connection, &scope, operations);
                }
                "duplicate" => {
                    let duplicate = operations[stage_index].clone();
                    operations.push(duplicate);
                    replace_workspace_operations(&connection, &scope, operations);
                }
                "wrong_attachment" => {
                    operations[stage_index]["payload"]["attachment_id"] =
                        serde_json::Value::String(TEST_OTHER_REPAIR_ID.to_string());
                    replace_workspace_operations(&connection, &scope, operations);
                }
                "phantom_source_version" => {
                    let mut phantom = operations[stage_index].clone();
                    phantom["expected_version"] = serde_json::json!(2);
                    operations.push(phantom);
                    replace_workspace_operations(&connection, &scope, operations);
                }
                "duplicate_attachment_identity" => {
                    let mut duplicate_attachment = operations[stage_index].clone();
                    duplicate_attachment["operation_id"] =
                        serde_json::Value::String(TEST_OPERATION_3.to_string());
                    duplicate_attachment["expected_version"] = serde_json::json!(2);
                    operations.push(duplicate_attachment);
                    replace_workspace_operations(&connection, &scope, operations);
                }
                "nonadjacent_duplicate_operation" => {
                    let mut separator = operations[stage_index].clone();
                    separator["operation_id"] =
                        serde_json::Value::String(TEST_OPERATION_3.to_string());
                    separator["expected_version"] = serde_json::json!(2);
                    separator["payload"]["attachment_id"] =
                        serde_json::Value::String(TEST_OTHER_REPAIR_ID.to_string());
                    let mut duplicate_create = operations[0].clone();
                    duplicate_create["expected_version"] = serde_json::json!(3);
                    operations.push(separator);
                    operations.push(duplicate_create);
                    replace_workspace_operations(&connection, &scope, operations);
                }
                "not_queued" => {
                    assert_eq!(
                        connection
                            .execute(
                                "UPDATE repair_attachment_staging SET state = 'conflict'
                                  WHERE attachment_id = ?1",
                                [TEST_ATTACHMENT_ID],
                            )
                            .unwrap(),
                        1
                    );
                }
                "stale_claim" | "wrong_table" | "wrong_record" | "wrong_version"
                | "wrong_status" => {}
                _ => unreachable!(),
            }
            let mut context =
                processing_context(&connection, &scope, TEST_ATTACHMENT_OPERATION_ID, 1, 12);
            if case == "stale_claim" {
                context.claim_generation = 11;
            }
            let queue_mutation = match case {
                "wrong_table" => Some(("table_name", "repairs")),
                "wrong_record" => Some(("record_id", TEST_OTHER_REPAIR_ID)),
                "wrong_status" => Some(("status", "failed")),
                _ => None,
            };
            if let Some((column, value)) = queue_mutation {
                let sql = format!("UPDATE parity_sync_queue SET {column} = ?1 WHERE id = ?2");
                assert_eq!(
                    connection
                        .execute(&sql, params![value, TEST_ATTACHMENT_OPERATION_ID])
                        .unwrap(),
                    1
                );
            }
            if case == "wrong_version" {
                assert_eq!(
                    connection
                        .execute(
                            "UPDATE parity_sync_queue SET version = 99 WHERE id = ?1",
                            [TEST_ATTACHMENT_OPERATION_ID],
                        )
                        .unwrap(),
                    1
                );
            }
            let before = attachment_state_fingerprint(&connection, &scope, &path);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_attachment_success(
                    &connection,
                    &context,
                    &attachment_result(crate::repair_transport::RepairStatus::Received, 2),
                )
                .expect_err("invalid attachment reconciliation identity must fail closed");
            let expected = match case {
                "stale_claim" | "wrong_table" | "wrong_record" | "wrong_version"
                | "wrong_status" => "REPAIR_ATTACHMENT_RECONCILIATION_SOURCE_MISSING",
                "not_queued" => "REPAIR_ATTACHMENT_RECONCILIATION_MISSING",
                _ => "REPAIR_ATTACHMENT_RECONCILIATION_INVALID",
            };
            assert_eq!(error.code(), expected, "case {case}");
            assert_eq!(
                attachment_state_fingerprint(&connection, &scope, &path),
                before,
                "case {case} must roll back cache, staging, queue, workspace and file"
            );
        }
    }

    #[test]
    fn attachment_success_preserves_monotonic_authority_for_equal_and_stale_results() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            let path = stage_attachment_fixture(&connection, &scope);
            rewrite_cache_authority(&connection, &scope, "diagnosing", 2, "diagnosing", 2);
            let context =
                processing_context(&connection, &scope, TEST_ATTACHMENT_OPERATION_ID, 1, 15);
            let before = attachment_state_fingerprint(&connection, &scope, &path);
            let error = NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_attachment_success(
                    &connection,
                    &context,
                    &attachment_result(crate::repair_transport::RepairStatus::Received, 2),
                )
                .expect_err("equal version with another authoritative status must fail closed");
            assert_eq!(error.code(), "REPAIR_ATTACHMENT_RECONCILIATION_INVALID");
            assert_eq!(
                attachment_state_fingerprint(&connection, &scope, &path),
                before
            );
        }

        {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            let path = stage_attachment_fixture(&connection, &scope);
            rewrite_cache_authority(&connection, &scope, "ready", 3, "ready", 3);
            let context =
                processing_context(&connection, &scope, TEST_ATTACHMENT_OPERATION_ID, 1, 16);
            NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_attachment_success(
                    &connection,
                    &context,
                    &attachment_result(crate::repair_transport::RepairStatus::Received, 2),
                )
                .expect("stale attachment response removes only its local source");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT status, authoritative_status, authoritative_version,
                                optimistic_version
                           FROM repair_cache WHERE repair_id = ?1",
                        [TEST_REPAIR_ID],
                        |row| Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?
                        )),
                    )
                    .unwrap(),
                ("ready".to_string(), "ready".to_string(), 3, 3)
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn attachment_success_cleanup_is_non_resending_for_missing_unlink_failure_and_db_error() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let scope = scope();
        let _keyring = install_native_state(&scope);

        for cleanup_case in ["already_missing", "unlink_failed", "cleanup_db_error"] {
            let database = crate::tests::harness::TestDb::open();
            let connection = database.state.conn.lock().expect("lock repair database");
            let path = stage_attachment_fixture(&connection, &scope);
            let context =
                processing_context(&connection, &scope, TEST_ATTACHMENT_OPERATION_ID, 1, 20);
            fs::remove_file(&path).unwrap();
            if cleanup_case != "already_missing" {
                fs::create_dir(&path).unwrap();
            }
            if cleanup_case == "cleanup_db_error" {
                connection
                    .execute_batch(
                        "CREATE TRIGGER fail_attachment_cleanup_update
                         BEFORE UPDATE OF state ON repair_attachment_staging
                         WHEN NEW.state = 'cleanup_failed'
                         BEGIN SELECT RAISE(ABORT, 'forced cleanup marker failure'); END;",
                    )
                    .unwrap();
            }
            NATIVE_REPAIR_QUEUE_HOOKS
                .reconcile_attachment_success(
                    &connection,
                    &context,
                    &attachment_result(crate::repair_transport::RepairStatus::Received, 2),
                )
                .expect("post-commit cleanup outcome must never resurrect an upload");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                        [TEST_ATTACHMENT_OPERATION_ID],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                0,
                "source queue must already be durably gone before cleanup"
            );
            match cleanup_case {
                "already_missing" => assert_eq!(
                    connection
                        .query_row(
                            "SELECT COUNT(*) FROM repair_attachment_staging
                              WHERE attachment_id = ?1",
                            [TEST_ATTACHMENT_ID],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap(),
                    0
                ),
                "unlink_failed" => assert_eq!(
                    connection
                        .query_row(
                            "SELECT state, server_version, cleanup_error_code
                               FROM repair_attachment_staging WHERE attachment_id = ?1",
                            [TEST_ATTACHMENT_ID],
                            |row| Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, String>(2)?
                            )),
                        )
                        .unwrap(),
                    ("cleanup_failed".to_string(), 2, "UNLINK_FAILED".to_string())
                ),
                "cleanup_db_error" => assert_eq!(
                    connection
                        .query_row(
                            "SELECT state, server_version FROM repair_attachment_staging
                              WHERE attachment_id = ?1",
                            [TEST_ATTACHMENT_ID],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                        )
                        .unwrap(),
                    ("confirmed".to_string(), 2)
                ),
                _ => unreachable!(),
            }
            if path.is_dir() {
                fs::remove_dir(&path).unwrap();
            }
        }
    }

    #[test]
    fn corrupt_existing_aes_key_fails_closed_without_replacement() {
        let _keyring = crate::tests::fake_keyring::install_seeded([(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "not-base64-or-a-key",
        )]);
        assert_eq!(load_or_create_key().unwrap_err(), "REPAIR_AES_KEY_CORRUPT");
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1).as_deref(),
            Some("not-base64-or-a-key")
        );
    }

    #[test]
    fn authoritative_enabled_access_publishes_only_after_bootstrap_is_durable() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let mut initial = scope();
        initial.offline_terminal_token = None;
        initial.offline_sequence_lease_start = None;
        initial.offline_sequence_lease_end = None;
        let _keyring = install_janitor_state_without_entitlement_or_key(&initial);
        let database = crate::tests::harness::TestDb::open();
        let decision = start_authoritative_access_decision().expect("start access decision");

        let pending = begin_authoritative_access_reconciliation(
            &database.state,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
            true,
            decision,
        )
        .expect("authoritative enabled module enters durable pending state");
        let pending_scope = load_scope_raw().unwrap().unwrap();
        assert!(pending_scope.transition_pending);
        assert!(pending_scope.offline_terminal_token.is_none());
        assert_eq!(
            acquire_transport_lease().unwrap_err().code(),
            "REPAIR_SCOPE_TRANSITION_PENDING"
        );

        finalize_authoritative_offline_access(
            &database.state,
            &pending,
            &crate::repair_transport::RepairNumberingLease::Sequence {
                offline_terminal_token: "A19F".to_string(),
                offline_sequence_lease_start: 101,
                offline_sequence_lease_end: 200,
            },
        )
        .expect("bootstrap and entitlement publish together behind the barrier");
        let published = load_scope_raw().unwrap().unwrap();
        assert!(!published.transition_pending);
        assert_eq!(published.offline_terminal_token.as_deref(), Some("A19F"));
        drop(acquire_transport_lease().expect("fully published access is usable"));
    }

    #[test]
    fn terminal_binding_lease_is_independent_of_repair_entitlement_and_releases_on_drop() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_janitor_state_without_entitlement_or_key(&initial);
        let lifecycle_generation = lifecycle()
            .0
            .lock()
            .expect("read current terminal binding generation")
            .epoch;

        let lease = acquire_terminal_binding_lease()
            .expect("generic terminal binding must not require repair entitlement");
        assert_eq!(lease.generation(), lifecycle_generation);
        assert_eq!(
            lifecycle()
                .0
                .lock()
                .expect("inspect active terminal binding reader")
                .active_readers,
            1
        );

        drop(lease);
        assert_eq!(
            lifecycle()
                .0
                .lock()
                .expect("inspect released terminal binding reader")
                .active_readers,
            0
        );
    }

    #[test]
    fn terminal_binding_writer_waits_for_lease_drop() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let lease = acquire_terminal_binding_lease().expect("acquire shared terminal binding");
        let (writer_finished_tx, writer_finished_rx) = std::sync::mpsc::sync_channel(1);
        let writer_scope = initial.clone();

        std::thread::spawn(move || {
            let _thread_keyring = install_native_state(&writer_scope);
            let result = arm_scope_transition();
            let _ = writer_finished_tx.send(result.map(|guard| drop(guard)));
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if lifecycle().0.lock().expect("inspect lifecycle").blocked {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "terminal binding writer must publish its barrier before waiting"
            );
            std::thread::yield_now();
        }
        assert!(
            writer_finished_rx.try_recv().is_err(),
            "writer must remain blocked while the terminal binding lease is alive"
        );

        drop(lease);
        writer_finished_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("writer unblocks after terminal binding lease drop")
            .expect("terminal binding writer completes");
        reset_test_lifecycle();
    }

    #[test]
    fn terminal_binding_generation_changes_across_a_completed_writer_epoch() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_janitor_state_without_entitlement_or_key(&initial);

        let before = acquire_terminal_binding_lease().expect("capture initial binding");
        let before_generation = before.generation();
        drop(before);

        let mut transitioning = load_scope_raw()
            .expect("load terminal scope")
            .expect("terminal scope exists");
        block_and_wait(Some(&mut transitioning), false).expect("arm terminal binding writer");
        unblock_at_epoch(transitioning.scope_epoch).expect("publish newer terminal binding");

        let after = acquire_terminal_binding_lease().expect("capture published binding");
        assert_ne!(after.generation(), before_generation);
        assert_eq!(after.generation(), transitioning.scope_epoch);
    }

    #[test]
    fn authoritative_enabled_without_session_stays_pending_without_half_active_access() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        crate::storage::session_clear().unwrap();
        let database = crate::tests::harness::TestDb::open();
        let decision = start_authoritative_access_decision().expect("start access decision");

        begin_authoritative_access_reconciliation(
            &database.state,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
            true,
            decision,
        )
        .expect("module entitlement can be recorded while staff sign-in is pending");

        assert!(load_scope_raw().unwrap().unwrap().transition_pending);
        assert!(crate::storage::session_get_strict().unwrap().is_none());
        assert_eq!(
            acquire_transport_lease().unwrap_err().code(),
            "REPAIR_SCOPE_TRANSITION_PENDING"
        );
    }

    #[test]
    fn authoritative_no_repairs_hard_revokes_only_repair_state() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("lock database");
            connection
                .execute(
                    "INSERT INTO repair_cache (
                 organization_id, branch_id, terminal_id, repair_id, scope_generation,
                 display_number, status, authoritative_status, priority, intake_mode,
                 authoritative_version, optimistic_version, dirty, has_conflict,
                 needs_refetch, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'R-OFF-A19F-000001', 'received',
                       'received', 'normal', 'standard', 0, 0, 0, 0, 0, ?6, ?6)",
                    params![
                        initial.organization_id,
                        initial.branch_id,
                        initial.terminal_id,
                        TEST_REPAIR_ID,
                        initial.scope_epoch as i64,
                        "2026-08-26T00:00:00Z"
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO parity_sync_queue (
                 id, table_name, record_id, operation, data, organization_id, created_at,
                 module_type, conflict_strategy, version, status
             ) VALUES ('generic-access-row', 'orders', 'order-1', 'INSERT', '{}', ?1,
                       '2026-08-26T00:00:00Z', 'orders', 'server-wins', 1, 'pending')",
                    [&initial.organization_id],
                )
                .unwrap();
        }
        crate::storage::set_credential(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            &base64::engine::general_purpose::STANDARD.encode([7_u8; 32]),
        )
        .unwrap();

        let decision = start_authoritative_access_decision().expect("start access decision");
        let outcome = begin_authoritative_access_reconciliation(
            &database.state,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
            false,
            decision,
        )
        .expect("authoritative module removal hard revokes repairs");
        assert!(outcome.is_disabled());
        let connection = database.state.conn.lock().expect("lock database");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM repair_cache", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue WHERE id = 'generic-access-row'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1).is_none()
        );
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ENTITLEMENT_V1).is_none()
        );
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,)
                .is_none()
        );
        let disabled_scope = load_scope_raw().unwrap().unwrap();
        assert!(!disabled_scope.transition_pending);
        assert!(disabled_scope.offline_terminal_token.is_none());
        assert_eq!(
            acquire_transport_lease().unwrap_err().code(),
            "REPAIR_MODULE_REQUIRED"
        );
    }

    #[test]
    fn stale_bootstrap_finalize_after_newer_invalid_decision_stays_denied() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let mut initial = scope();
        initial.offline_terminal_token = None;
        initial.offline_sequence_lease_start = None;
        initial.offline_sequence_lease_end = None;
        let _keyring = install_janitor_state_without_entitlement_or_key(&initial);
        let database = crate::tests::harness::TestDb::open();
        let stale_decision =
            start_authoritative_access_decision().expect("start stale access decision");

        let stale = begin_authoritative_access_reconciliation(
            &database.state,
            &initial.organization_id,
            &initial.branch_id,
            &initial.terminal_id,
            true,
            stale_decision,
        )
        .expect("first enabled decision enters pending bootstrap");
        latch_startup_access_pending().expect("newer invalid response latches access");

        assert_eq!(
            finalize_authoritative_offline_access(
                &database.state,
                &stale,
                &crate::repair_transport::RepairNumberingLease::Sequence {
                    offline_terminal_token: "A19F".to_string(),
                    offline_sequence_lease_start: 101,
                    offline_sequence_lease_end: 200,
                },
            )
            .expect_err("newer invalid decision must fence stale bootstrap completion"),
            "REPAIR_ACCESS_DECISION_STALE"
        );
        assert_eq!(
            acquire_transport_lease().unwrap_err().code(),
            "REPAIR_SCOPE_TRANSITION_PENDING"
        );
    }

    #[test]
    fn reconciliation_does_not_deadlock_transport_lease_waiting_for_database() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = std::sync::Arc::new(crate::tests::harness::TestDb::open());
        let lease = acquire_transport_lease().expect("active native transport lease");
        let (database_locked_tx, database_locked_rx) = std::sync::mpsc::sync_channel(1);
        let (reconciled_tx, reconciled_rx) = std::sync::mpsc::sync_channel(1);
        let reconcile_database = std::sync::Arc::clone(&database);
        let reconcile_scope = initial.clone();

        std::thread::spawn(move || {
            let _thread_keyring = install_native_state(&reconcile_scope);
            let decision = start_authoritative_access_decision().expect("start revoke decision");
            let result = begin_authoritative_access_reconciliation(
                &reconcile_database.state,
                &reconcile_scope.organization_id,
                &reconcile_scope.branch_id,
                &reconcile_scope.terminal_id,
                false,
                decision,
            );
            let _ = reconciled_tx.send(result.map(|_| ()));
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if lifecycle().0.lock().expect("inspect lifecycle").blocked {
                database_locked_tx
                    .send(())
                    .expect("announce reconciliation barrier");
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "reconciliation must block new leases before waiting"
            );
            std::thread::yield_now();
        }
        database_locked_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("observe reconciliation barrier before transport asks for database");

        let (transport_finished_tx, transport_finished_rx) = std::sync::mpsc::sync_channel(1);
        let transport_database = std::sync::Arc::clone(&database);
        std::thread::spawn(move || {
            let _lease = lease;
            let _connection = transport_database
                .state
                .conn
                .lock()
                .expect("transport eventually acquires database");
            let _ = transport_finished_tx.send(());
        });

        transport_finished_rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .expect("transport must not wait behind reconciliation while holding its lease");
        reconciled_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("reconciliation completes after active transport drains")
            .expect("authoritative revoke succeeds");
    }

    #[test]
    fn network_failure_retains_only_an_already_valid_same_scope_offline_state() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let decision = start_authoritative_access_decision().expect("start refresh decision");

        retain_verified_access_after_network_failure(&database.state, decision)
            .expect("same-scope verified offline lease may be retained");
        drop(acquire_transport_lease().expect("retained access is unblocked explicitly"));

        crate::storage::replace_repair_identity_uncoordinated(
            &initial.organization_id,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            &initial.terminal_id,
        )
        .unwrap();
        let mismatched_decision =
            start_authoritative_access_decision().expect("start mismatched refresh");
        assert!(
            retain_verified_access_after_network_failure(&database.state, mismatched_decision)
                .is_err()
        );
    }

    #[test]
    fn stale_network_retention_cannot_undo_newer_invalid_decision() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let stale = start_authoritative_access_decision().expect("start stale request");
        latch_startup_access_pending().expect("newer invalid response latches access");

        assert_eq!(
            retain_verified_access_after_network_failure(&database.state, stale)
                .expect_err("stale network completion must not reopen access"),
            "REPAIR_ACCESS_DECISION_STALE"
        );
        assert_eq!(
            acquire_transport_lease().unwrap_err().code(),
            "REPAIR_SCOPE_TRANSITION_PENDING"
        );
    }

    #[test]
    fn sqlite_identity_failure_restores_previous_keyring_identity() {
        let _state = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let database = crate::tests::harness::TestDb::open();
        let connection = database.state.conn.lock().expect("lock database");
        connection
            .execute_batch(
                "CREATE TRIGGER fail_repair_identity_settings
                 BEFORE INSERT ON local_settings
                 BEGIN
                   SELECT RAISE(ABORT, 'identity sqlite failure');
                 END;",
            )
            .expect("install deterministic SQLite failure");

        assert_eq!(
            persist_runtime_identity(
                &connection,
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "terminal-replacement",
            )
            .expect_err("SQLite failure must fail the combined identity write"),
            "REPAIR_IDENTITY_WRITE_FAILED"
        );
        assert_eq!(
            runtime_scope_identity_from_keyring().expect("read compensated identity"),
            (
                initial.organization_id,
                initial.branch_id,
                initial.terminal_id,
            ),
            "keyring must be compensated when the SQLite half rolls back"
        );
    }

    fn terminal_rollback_binding() -> TerminalIdentityRollbackBinding {
        TerminalIdentityRollbackBinding {
            journal_version: 3,
            operation: "rebind".to_string(),
            operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab".to_string(),
            old_terminal_id: "terminal-alpha".to_string(),
            old_admin_dashboard_url: "https://old.example.com".to_string(),
            old_organization_id: "11111111-1111-4111-8111-111111111111".to_string(),
            old_branch_id: "22222222-2222-4222-8222-222222222222".to_string(),
            old_api_key_digest: format!("{:x}", Sha256::digest(b"old-key")),
            target_terminal_id: "terminal-beta".to_string(),
            target_admin_dashboard_url: "https://new.example.com".to_string(),
            target_organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string(),
            target_branch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
            target_api_key_digest: format!("{:x}", Sha256::digest(b"new-key")),
        }
    }

    #[test]
    fn repair_owned_terminal_intent_holds_transition_boundary_through_durable_callback() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        seed_valid_repair_queue_aes_key();
        let binding = terminal_rollback_binding();
        let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);

        let envelope = prepare_and_arm_terminal_identity_transition(&binding, |envelope| {
            assert!(envelope.is_some());
            assert!(lifecycle().0.lock().unwrap().blocked);
            std::thread::spawn(move || {
                let result = arm_scope_transition().map(|_guard| ());
                let _ = finished_tx.send(result);
            });
            assert!(finished_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err());
            TerminalIdentityIntentDurability::Committed
        })
        .expect("durable intent arms while retaining transition ownership")
        .expect("configured scope has an authenticated rollback envelope");

        assert!(!envelope.ciphertext_b64.contains(&initial.scope_token));
        let pending = load_scope_raw().unwrap().unwrap();
        assert!(pending.transition_pending);
        assert_eq!(pending.scope_epoch, initial.scope_epoch + 1);
        finished_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("competing transition proceeds only after intent is armed")
            .expect("competing transition observes the already-pending scope safely");
        reset_test_lifecycle();
    }

    #[test]
    fn definite_intent_failure_unblocks_and_preserves_existing_aes_key() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let exact_raw = serde_json::to_string_pretty(&initial).unwrap();
        let _keyring = install_native_state(&initial);
        seed_valid_repair_queue_aes_key();
        crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, &exact_raw).unwrap();
        let aes_before =
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)
                .unwrap();

        assert_eq!(
            prepare_and_arm_terminal_identity_transition(
                &terminal_rollback_binding(),
                |_envelope| TerminalIdentityIntentDurability::DefiniteFailure(
                    "TEST_INTENT_NOT_WRITTEN".to_string(),
                ),
            )
            .expect_err("definite no-journal result is returned"),
            "TEST_INTENT_NOT_WRITTEN"
        );
        assert!(!lifecycle().0.lock().unwrap().blocked);
        assert_eq!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)
                .unwrap(),
            aes_before
        );
        assert_eq!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)
                .unwrap()
                .unwrap()
                .as_bytes(),
            exact_raw.as_bytes()
        );
    }

    #[test]
    fn pre_callback_scope_validation_failure_preserves_exact_scope_and_unblocks() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        let corrupt_raw = "{not-valid-repair-scope";
        crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, corrupt_raw).unwrap();
        let callback_called = std::cell::Cell::new(false);

        assert_eq!(
            prepare_and_arm_terminal_identity_transition(&terminal_rollback_binding(), |_| {
                callback_called.set(true);
                TerminalIdentityIntentDurability::Committed
            })
            .expect_err("invalid scope fails before durable callback"),
            "REPAIR_TERMINAL_ROLLBACK_INVALID"
        );
        assert!(!callback_called.get());
        assert!(!lifecycle().0.lock().unwrap().blocked);
        assert_eq!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)
                .unwrap()
                .unwrap()
                .as_str(),
            corrupt_raw
        );
    }

    #[test]
    fn pre_callback_missing_aes_key_never_creates_one_and_unblocks() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let exact_raw = serde_json::to_string_pretty(&initial).unwrap();
        let _keyring = install_native_state(&initial);
        crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, &exact_raw).unwrap();
        crate::storage::delete_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1).unwrap();
        let callback_called = std::cell::Cell::new(false);

        assert_eq!(
            prepare_and_arm_terminal_identity_transition(&terminal_rollback_binding(), |_| {
                callback_called.set(true);
                TerminalIdentityIntentDurability::Committed
            })
            .expect_err("missing existing AES key fails before callback"),
            "REPAIR_TERMINAL_ROLLBACK_KEY_REQUIRED"
        );
        assert!(!callback_called.get());
        assert!(!lifecycle().0.lock().unwrap().blocked);
        assert!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)
                .unwrap()
                .unwrap()
                .as_bytes(),
            exact_raw.as_bytes()
        );
    }

    #[test]
    fn pre_callback_corrupt_existing_aes_key_preserves_scope_and_unblocks() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let exact_raw = serde_json::to_string_pretty(&initial).unwrap();
        let _keyring = install_native_state(&initial);
        crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, &exact_raw).unwrap();
        crate::storage::set_credential(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "not-a-valid-aes-key",
        )
        .unwrap();
        let callback_called = std::cell::Cell::new(false);

        assert_eq!(
            prepare_and_arm_terminal_identity_transition(&terminal_rollback_binding(), |_| {
                callback_called.set(true);
                TerminalIdentityIntentDurability::Committed
            })
            .expect_err("corrupt existing AES key fails before callback"),
            "REPAIR_TERMINAL_ROLLBACK_KEY_INVALID"
        );
        assert!(!callback_called.get());
        assert!(!lifecycle().0.lock().unwrap().blocked);
        assert_eq!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)
                .unwrap()
                .unwrap()
                .as_bytes(),
            exact_raw.as_bytes()
        );
    }

    #[test]
    fn ambiguous_intent_failure_keeps_repair_access_fail_closed_and_key_recoverable() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        seed_valid_repair_queue_aes_key();
        assert_eq!(
            prepare_and_arm_terminal_identity_transition(
                &terminal_rollback_binding(),
                |_envelope| TerminalIdentityIntentDurability::AmbiguousFailure(
                    "TEST_INTENT_COMMIT_UNKNOWN".to_string(),
                ),
            )
            .expect_err("ambiguous durability must fail closed"),
            "TEST_INTENT_COMMIT_UNKNOWN"
        );
        let state = lifecycle().0.lock().unwrap();
        assert!(state.blocked);
        assert!(state.terminal_identity_rollback_publication_pending);
        assert!(state.terminal_identity_rollback_publication_abandoned);
        drop(state);
        assert!(terminal_identity_rollback_publication_pending().unwrap());
        assert!(!load_scope_raw().unwrap().unwrap().transition_pending);
        reset_test_lifecycle();
    }

    #[test]
    fn preblocked_lifecycle_rejects_new_intent_without_stealing_the_block() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        lifecycle().0.lock().unwrap().blocked = true;
        let callback_called = std::cell::Cell::new(false);

        assert_eq!(
            prepare_and_arm_terminal_identity_transition(&terminal_rollback_binding(), |_| {
                callback_called.set(true);
                TerminalIdentityIntentDurability::DefiniteFailure("UNREACHABLE".to_string())
            })
            .expect_err("pre-existing block rejects new ownership"),
            "REPAIR_TERMINAL_ROLLBACK_CONFLICT"
        );
        assert!(!callback_called.get());
        assert!(lifecycle().0.lock().unwrap().blocked);
        assert!(!load_scope_raw().unwrap().unwrap().transition_pending);
        reset_test_lifecycle();
    }

    #[test]
    fn rollback_envelope_rejects_oversized_and_noncanonical_base64_before_key_access() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        seed_valid_repair_queue_aes_key();
        let binding = terminal_rollback_binding();
        let envelope = prepare_terminal_identity_rollback(&binding)
            .unwrap()
            .expect("capture valid envelope");
        crate::tests::fake_keyring::fail_reads_for(
            crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1,
            "TEST_KEY_MUST_NOT_BE_READ",
        );

        let mut noncanonical_nonce = envelope.clone();
        noncanonical_nonce.nonce_b64 = "AB==".to_string();
        assert_eq!(
            decrypt_terminal_identity_rollback(&binding, &noncanonical_nonce)
                .err()
                .expect("noncanonical nonce rejected before key access"),
            "REPAIR_TERMINAL_ROLLBACK_INVALID"
        );

        let mut oversized_ciphertext = envelope;
        let max_decoded = TERMINAL_IDENTITY_ROLLBACK_MAX_SCOPE_BYTES + aead::AES_256_GCM.tag_len();
        let max_encoded = max_decoded.div_ceil(3) * 4;
        oversized_ciphertext.ciphertext_b64 = "A".repeat(max_encoded + 4);
        assert_eq!(
            decrypt_terminal_identity_rollback(&binding, &oversized_ciphertext)
                .err()
                .expect("oversized ciphertext rejected before key access"),
            "REPAIR_TERMINAL_ROLLBACK_INVALID"
        );
        crate::tests::fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1);
    }

    #[test]
    fn restart_epoch_zero_operational_block_rehydrates_the_durable_pending_epoch() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let mut initial = scope();
        initial.scope_epoch = 7;
        let _keyring = install_native_state(&initial);

        block_and_wait(Some(&mut initial), false).expect("operational clear enters pending state");

        assert!(initial.transition_pending);
        assert_eq!(initial.scope_epoch, 8);
        assert_eq!(lifecycle().0.lock().unwrap().epoch, 8);
        assert_eq!(load_scope_raw().unwrap().unwrap().scope_epoch, 8);
        reset_test_lifecycle();
    }

    #[test]
    fn terminal_identity_rollback_capture_arm_restore_finish_preserves_exact_raw_scope() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let exact_raw = serde_json::to_string_pretty(&initial).unwrap();
        let _keyring = install_native_state(&initial);
        seed_valid_repair_queue_aes_key();
        crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, &exact_raw).unwrap();
        let binding = terminal_rollback_binding();
        let envelope = prepare_terminal_identity_rollback(&binding)
            .unwrap()
            .expect("configured repair scope has rollback envelope");
        assert!(!envelope.ciphertext_b64.contains(&initial.scope_token));

        arm_terminal_identity_transition(&binding, Some(&envelope)).unwrap();
        let pending = load_scope_raw().unwrap().unwrap();
        assert!(pending.transition_pending);
        assert_eq!(pending.scope_epoch, initial.scope_epoch + 1);
        arm_terminal_identity_transition(&binding, Some(&envelope)).unwrap();

        let publication =
            restore_terminal_identity_scope_while_blocked(&binding, Some(&envelope)).unwrap();
        assert!(terminal_identity_rollback_publication_pending().unwrap());
        assert_eq!(
            crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)
                .unwrap()
                .unwrap()
                .as_bytes(),
            exact_raw.as_bytes()
        );
        drop(publication);
        assert!(terminal_identity_rollback_publication_pending().unwrap());
        {
            let state = lifecycle().0.lock().unwrap();
            assert!(state.blocked);
            assert!(state.terminal_identity_rollback_publication_abandoned);
        }
        let publication =
            restore_terminal_identity_scope_while_blocked(&binding, Some(&envelope)).unwrap();
        finish_terminal_identity_rollback(publication).unwrap();
        assert!(!terminal_identity_rollback_publication_pending().unwrap());
        assert!(!lifecycle().0.lock().unwrap().blocked);
        reset_test_lifecycle();
    }

    #[test]
    fn terminal_identity_rollback_rejects_tamper_wrong_binding_and_legacy_pending() {
        let _serial = test_state_lock();
        reset_test_lifecycle();
        let initial = scope();
        let _keyring = install_native_state(&initial);
        seed_valid_repair_queue_aes_key();
        let binding = terminal_rollback_binding();
        let envelope = prepare_terminal_identity_rollback(&binding)
            .unwrap()
            .unwrap();

        let mut tampered = envelope.clone();
        tampered.ciphertext_b64.push('A');
        assert!(arm_terminal_identity_transition(&binding, Some(&tampered)).is_err());
        let mut wrong = binding.clone();
        wrong.target_terminal_id = "terminal-other".to_string();
        assert!(arm_terminal_identity_transition(&wrong, Some(&envelope)).is_err());

        arm_terminal_identity_transition(&binding, Some(&envelope)).unwrap();
        assert!(prepare_legacy_terminal_identity_rollback(
            &binding.old_organization_id,
            &binding.old_branch_id,
            &binding.old_terminal_id,
        )
        .is_err());
        reset_test_lifecycle();
    }
}
