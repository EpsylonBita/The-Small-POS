//! Native-owned transport boundary for repair-management API traffic.
//!
//! The renderer never owns terminal credentials or repair request headers.
//! This module begins the boundary by resolving the persisted native staff
//! session and cross-checking every identity claim before an HTTP request can
//! be built. Response classification and raw uploads are layered on this same
//! validated claim below.

use base64::Engine;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::sync_queue::SyncQueueItem;
use rusqlite::Connection;

pub(crate) const MAX_REPAIR_RESPONSE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_REPAIR_COLLECTION_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_REPAIR_RETRY_AFTER_SECONDS: i64 = 15 * 60;
const DEFAULT_REPAIR_RETRY_AFTER_SECONDS: i64 = 60;
const MAX_PERSISTED_REPAIR_SESSION_BYTES: usize = 32 * 1024;
const MAX_REPAIR_COMMAND_ENVELOPE_BYTES: usize = 256 * 1024;
const MAX_REPAIR_ATTACHMENT_BYTES: usize = 15 * 1024 * 1024;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const REPAIR_ACTOR_ATTESTATION_VERSION: u8 = 1;
const MAX_REPAIR_ACTOR_OFFLINE_TTL_SECONDS: i64 = 2 * 60 * 60;
const MAX_REPAIR_ACTOR_CLOCK_SKEW_SECONDS: i64 = 5 * 60;

pub(crate) const REPAIR_PERMISSIONS: [&str; 13] = [
    "repairs.read",
    "repairs.create",
    "repairs.update",
    "repairs.approve",
    "repairs.override",
    "repairs.stock",
    "repairs.cancel",
    "repairs.transfer",
    "repairs.attachments",
    "repairs.payments.collect",
    "repairs.payments.refund",
    "repairs.fiscalize",
    "repairs.delivery.override_balance",
];

#[derive(Clone, Serialize, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct RepairActorAttestation {
    version: u8,
    organization_id: String,
    branch_id: String,
    terminal_public_id: String,
    staff_id: String,
    staff_session_id: String,
    issued_at: String,
    session_expires_at: String,
    offline_expires_at: String,
    permissions: Vec<String>,
}

impl Drop for RepairActorAttestation {
    fn drop(&mut self) {
        self.organization_id.zeroize();
        self.branch_id.zeroize();
        self.terminal_public_id.zeroize();
        self.staff_id.zeroize();
        self.staff_session_id.zeroize();
        self.issued_at.zeroize();
        self.session_expires_at.zeroize();
        self.offline_expires_at.zeroize();
        self.permissions
            .iter_mut()
            .for_each(|permission| permission.zeroize());
        self.permissions.clear();
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RepairNumberingLease {
    None {},
    Sequence {
        offline_terminal_token: String,
        offline_sequence_lease_start: u64,
        offline_sequence_lease_end: u64,
    },
}

impl RepairNumberingLease {
    pub(crate) fn as_sequence(&self) -> Option<(&str, u64, u64)> {
        match self {
            Self::None {} => None,
            Self::Sequence {
                offline_terminal_token,
                offline_sequence_lease_start,
                offline_sequence_lease_end,
            } => Some((
                offline_terminal_token,
                *offline_sequence_lease_start,
                *offline_sequence_lease_end,
            )),
        }
    }
}

impl Drop for RepairNumberingLease {
    fn drop(&mut self) {
        if let Self::Sequence {
            offline_terminal_token,
            ..
        } = self
        {
            offline_terminal_token.zeroize();
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairActorBootstrap {
    actor_attestation: RepairActorAttestation,
    numbering_lease: RepairNumberingLease,
}

pub(crate) struct RepairActorBootstrap {
    pub(crate) numbering_lease: RepairNumberingLease,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RepairHookErrorKind {
    SignInRequired,
    Unavailable,
    Retryable,
    Permanent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairHookError {
    kind: RepairHookErrorKind,
    code: &'static str,
}

impl RepairHookError {
    pub(crate) fn sign_in(code: &'static str) -> Self {
        Self {
            kind: RepairHookErrorKind::SignInRequired,
            code,
        }
    }

    pub(crate) fn unavailable(code: &'static str) -> Self {
        Self {
            kind: RepairHookErrorKind::Unavailable,
            code,
        }
    }

    pub(crate) fn retryable(code: &'static str) -> Self {
        Self {
            kind: RepairHookErrorKind::Retryable,
            code,
        }
    }

    pub(crate) fn permanent(code: &'static str) -> Self {
        Self {
            kind: RepairHookErrorKind::Permanent,
            code,
        }
    }

    pub(crate) fn kind(&self) -> RepairHookErrorKind {
        self.kind
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for RepairHookError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for RepairHookError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairQueueContext {
    pub(crate) queue_id: String,
    pub(crate) claim_generation: i64,
    pub(crate) repair_id: String,
    pub(crate) operation_id: String,
    pub(crate) organization_id: String,
    pub(crate) expected_version: u64,
}

/// Cache/encryption seam implemented by Task 9C.
///
/// Hook calls happen under the SQLite connection lock. A conflict hook must
/// persist the bounded conflict and park dependent same-repair operations
/// before returning. Success hooks must make their local state idempotent;
/// queue deletion happens only after the hook returns `Ok(())`.
pub(crate) trait RepairQueueHooks: Send + Sync {
    /// Decrypt and materialize one staged attachment without mutating local
    /// confirmation/cleanup state. The queue owns dispatch and will invoke
    /// reconciliation only after an authoritative server response.
    fn decode_attachment_upload(
        &self,
        _connection: &Connection,
        _item: &SyncQueueItem,
    ) -> Result<RepairRawAttachmentUpload, RepairHookError> {
        Err(RepairHookError::unavailable(
            "REPAIR_ATTACHMENT_DECODER_UNAVAILABLE",
        ))
    }

    fn decode_command_envelope(
        &self,
        _connection: &Connection,
        _item: &SyncQueueItem,
    ) -> Result<Zeroizing<String>, RepairHookError> {
        Err(RepairHookError::unavailable(
            "REPAIR_COMMAND_DECODER_UNAVAILABLE",
        ))
    }

    fn before_dispatch(
        &self,
        _connection: &Connection,
        _context: &RepairQueueContext,
    ) -> Result<(), RepairHookError> {
        Ok(())
    }

    /// Full parity with the shared offline-command schema belongs to the
    /// cache/producer slice. Until that validator is installed the request
    /// stays parked rather than relying on the partial transport checks below.
    fn validate_command_envelope(
        &self,
        _connection: &Connection,
        _context: &RepairQueueContext,
        _decoded_envelope: &str,
    ) -> Result<(), RepairHookError> {
        Err(RepairHookError::unavailable(
            "REPAIR_COMMAND_VALIDATOR_UNAVAILABLE",
        ))
    }

    fn reconcile_success(
        &self,
        _connection: &Connection,
        _context: &RepairQueueContext,
        _signal: &RepairSyncSuccessSignal,
    ) -> Result<(), RepairHookError> {
        Err(RepairHookError::unavailable(
            "REPAIR_RECONCILIATION_UNAVAILABLE",
        ))
    }

    /// Confirm the server attachment identity/version in the local cache.
    /// Implementations must persist any deferred file-cleanup marker before
    /// returning `Ok`; physical unlink failure must not cause a re-upload.
    fn reconcile_attachment_success(
        &self,
        _connection: &Connection,
        _context: &RepairQueueContext,
        _result: &RepairAttachmentUploadResult,
    ) -> Result<(), RepairHookError> {
        Err(RepairHookError::unavailable(
            "REPAIR_ATTACHMENT_RECONCILIATION_UNAVAILABLE",
        ))
    }

    fn park_conflict(
        &self,
        _connection: &Connection,
        _context: &RepairQueueContext,
        _conflict: &RepairConflictProjection,
    ) -> Result<(), RepairHookError> {
        Err(RepairHookError::unavailable(
            "REPAIR_CONFLICT_STORE_UNAVAILABLE",
        ))
    }
}

#[derive(Default)]
pub(crate) struct UnavailableRepairQueueHooks;

impl RepairQueueHooks for UnavailableRepairQueueHooks {}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RepairSessionErrorCode {
    SessionRequired,
    SessionInvalid,
    SessionMismatch,
    ScopeMismatch,
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairSessionError {
    code: RepairSessionErrorCode,
    message: &'static str,
}

#[cfg(test)]
impl RepairSessionError {
    fn new(code: RepairSessionErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    pub(crate) fn code(&self) -> RepairSessionErrorCode {
        self.code
    }
}

#[cfg(test)]
impl std::fmt::Display for RepairSessionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

#[cfg(test)]
impl std::error::Error for RepairSessionError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeRepairScope {
    pub(crate) organization_id: String,
    pub(crate) branch_id: String,
    pub(crate) terminal_id: String,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ValidatedRepairSession {
    staff_session_id: String,
    staff_id: String,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    permissions: Vec<String>,
    offline_expires_at: chrono::DateTime<chrono::Utc>,
}

impl std::fmt::Debug for ValidatedRepairSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ValidatedRepairSession")
            .field("redacted", &true)
            .finish()
    }
}

impl ValidatedRepairSession {
    pub(crate) fn staff_session_id(&self) -> &str {
        &self.staff_session_id
    }

    #[cfg(test)]
    pub(crate) fn staff_id(&self) -> &str {
        &self.staff_id
    }

    pub(crate) fn organization_id(&self) -> &str {
        &self.organization_id
    }

    pub(crate) fn branch_id(&self) -> &str {
        &self.branch_id
    }

    pub(crate) fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    pub(crate) fn has_permission(&self, permission: &str) -> bool {
        self.permissions
            .binary_search_by(|candidate| candidate.as_str().cmp(permission))
            .is_ok()
    }

    #[cfg(test)]
    pub(crate) fn offline_expires_at(&self) -> chrono::DateTime<chrono::Utc> {
        self.offline_expires_at
    }
}

fn canonical_uuid(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let parsed = Uuid::parse_str(trimmed).ok()?;
    let canonical = parsed.hyphenated().to_string();
    (trimmed == canonical).then_some(canonical)
}

fn required_string<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn validate_native_terminal_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn parse_canonical_actor_timestamp(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    let utc = parsed.with_timezone(&chrono::Utc);
    (utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) == value).then_some(utc)
}

fn repair_permission_is_canonical(permission: &str) -> bool {
    REPAIR_PERMISSIONS.contains(&permission)
}

fn validate_repair_actor_attestation(
    attestation: &RepairActorAttestation,
    native_scope: &NativeRepairScope,
    expected_staff_session_id: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<ValidatedRepairSession, RepairHookError> {
    let organization_id = canonical_uuid(&attestation.organization_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?;
    let branch_id = canonical_uuid(&attestation.branch_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?;
    let staff_id = canonical_uuid(&attestation.staff_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?;
    let staff_session_id = canonical_uuid(&attestation.staff_session_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?;
    let native_organization_id = canonical_uuid(&native_scope.organization_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_NATIVE_SCOPE_MISMATCH"))?;
    let native_branch_id = canonical_uuid(&native_scope.branch_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_NATIVE_SCOPE_MISMATCH"))?;
    if attestation.version != REPAIR_ACTOR_ATTESTATION_VERSION
        || !validate_native_terminal_id(&attestation.terminal_public_id)
        || !validate_native_terminal_id(&native_scope.terminal_id)
        || organization_id != native_organization_id
        || branch_id != native_branch_id
        || attestation.terminal_public_id != native_scope.terminal_id
    {
        return Err(RepairHookError::permanent("REPAIR_ACTOR_MISMATCH"));
    }
    if let Some(expected) = expected_staff_session_id {
        let expected = canonical_uuid(expected)
            .ok_or_else(|| RepairHookError::sign_in("REPAIR_ACTOR_MISMATCH"))?;
        if expected != staff_session_id {
            return Err(RepairHookError::sign_in("REPAIR_ACTOR_MISMATCH"));
        }
    }

    let issued_at = parse_canonical_actor_timestamp(&attestation.issued_at)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?;
    let session_expires_at = parse_canonical_actor_timestamp(&attestation.session_expires_at)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?;
    let offline_expires_at = parse_canonical_actor_timestamp(&attestation.offline_expires_at)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?;
    if issued_at > now + chrono::Duration::seconds(MAX_REPAIR_ACTOR_CLOCK_SKEW_SECONDS)
        || offline_expires_at <= issued_at
        || offline_expires_at > session_expires_at
        || offline_expires_at - issued_at
            > chrono::Duration::seconds(MAX_REPAIR_ACTOR_OFFLINE_TTL_SECONDS)
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ACTOR_ATTESTATION_INVALID",
        ));
    }
    if now >= offline_expires_at || now >= session_expires_at {
        return Err(RepairHookError::sign_in("REPAIR_ACTOR_EXPIRED"));
    }
    if attestation.permissions.is_empty()
        || attestation.permissions.len() > REPAIR_PERMISSIONS.len()
        || attestation
            .permissions
            .iter()
            .any(|permission| !repair_permission_is_canonical(permission))
        || !attestation
            .permissions
            .windows(2)
            .all(|pair| pair[0] < pair[1])
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ACTOR_ATTESTATION_INVALID",
        ));
    }

    Ok(ValidatedRepairSession {
        staff_session_id,
        staff_id,
        organization_id,
        branch_id,
        terminal_id: attestation.terminal_public_id.clone(),
        permissions: attestation.permissions.clone(),
        offline_expires_at,
    })
}

fn load_repair_actor_attestation() -> Result<RepairActorAttestation, RepairHookError> {
    let raw =
        crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
            .map_err(|_| RepairHookError::unavailable("REPAIR_ACTOR_ATTESTATION_UNAVAILABLE"))?
            .ok_or_else(|| RepairHookError::sign_in("REPAIR_ACTOR_ATTESTATION_REQUIRED"))?;
    serde_json::from_str(&raw)
        .map_err(|_| RepairHookError::sign_in("REPAIR_ACTOR_ATTESTATION_INVALID"))
}

fn authorize_repair_actor_inner(
    native_scope: &NativeRepairScope,
    claimed_staff_session_id: Option<&str>,
    required_permission: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<ValidatedRepairSession, RepairHookError> {
    if required_permission.is_some_and(|permission| !repair_permission_is_canonical(permission)) {
        return Err(RepairHookError::permanent("REPAIR_PERMISSION_INVALID"));
    }
    let attestation = load_repair_actor_attestation()?;
    let actor = validate_repair_actor_attestation(
        &attestation,
        native_scope,
        claimed_staff_session_id,
        now,
    )?;
    if required_permission.is_some_and(|permission| !actor.has_permission(permission)) {
        return Err(RepairHookError::permanent("REPAIR_PERMISSION_DENIED"));
    }
    Ok(actor)
}

pub(crate) fn authorize_repair_actor(
    native_scope: &NativeRepairScope,
    claimed_staff_session_id: &str,
    required_permission: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<ValidatedRepairSession, RepairHookError> {
    authorize_repair_actor_inner(
        native_scope,
        Some(claimed_staff_session_id),
        Some(required_permission),
        now,
    )
}

pub(crate) fn authorize_any_repair_actor_for_scope(
    native_scope: &NativeRepairScope,
) -> Result<ValidatedRepairSession, RepairHookError> {
    authorize_repair_actor_inner(native_scope, None, None, chrono::Utc::now())
}

fn validate_numbering_lease(
    lease: &RepairNumberingLease,
    actor: &ValidatedRepairSession,
) -> Result<(), RepairHookError> {
    match lease {
        RepairNumberingLease::None {} if !actor.has_permission("repairs.create") => Ok(()),
        RepairNumberingLease::Sequence {
            offline_terminal_token,
            offline_sequence_lease_start,
            offline_sequence_lease_end,
        } if actor.has_permission("repairs.create")
            && offline_terminal_token.len() == 4
            && offline_terminal_token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
            && *offline_sequence_lease_start > 0
            && *offline_sequence_lease_start <= *offline_sequence_lease_end
            && *offline_sequence_lease_end <= 999_999
            && *offline_sequence_lease_end - *offline_sequence_lease_start < 100 =>
        {
            Ok(())
        }
        _ => Err(RepairHookError::permanent(
            "REPAIR_OFFLINE_BOOTSTRAP_INVALID",
        )),
    }
}

fn persist_repair_actor_attestation(
    attestation: &RepairActorAttestation,
) -> Result<(), RepairHookError> {
    let serialized = Zeroizing::new(
        serde_json::to_string(attestation)
            .map_err(|_| RepairHookError::permanent("REPAIR_ACTOR_ATTESTATION_INVALID"))?,
    );
    crate::storage::set_repair_actor_attestation(&serialized)
        .map_err(|_| RepairHookError::unavailable("REPAIR_ACTOR_ATTESTATION_WRITE_FAILED"))?;
    let readback =
        crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
            .map_err(|_| RepairHookError::unavailable("REPAIR_ACTOR_ATTESTATION_WRITE_FAILED"))?
            .ok_or_else(|| RepairHookError::unavailable("REPAIR_ACTOR_ATTESTATION_WRITE_FAILED"))?;
    let verified: RepairActorAttestation = serde_json::from_str(&readback)
        .map_err(|_| RepairHookError::unavailable("REPAIR_ACTOR_ATTESTATION_WRITE_FAILED"))?;
    if &verified != attestation {
        let _ = crate::storage::delete_repair_actor_attestation();
        return Err(RepairHookError::unavailable(
            "REPAIR_ACTOR_ATTESTATION_WRITE_FAILED",
        ));
    }
    Ok(())
}

fn validate_and_persist_repair_actor_bootstrap(
    body: &[u8],
    native_scope: &NativeRepairScope,
    claimed_staff_session_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<RepairActorBootstrap, RepairHookError> {
    if body.is_empty() || body.len() > MAX_REPAIR_RESPONSE_BYTES {
        return Err(RepairHookError::permanent(
            "REPAIR_OFFLINE_BOOTSTRAP_INVALID",
        ));
    }
    let raw: RawRepairActorBootstrap = serde_json::from_slice(body)
        .map_err(|_| RepairHookError::permanent("REPAIR_OFFLINE_BOOTSTRAP_INVALID"))?;
    let actor = validate_repair_actor_attestation(
        &raw.actor_attestation,
        native_scope,
        Some(claimed_staff_session_id),
        now,
    )?;
    validate_numbering_lease(&raw.numbering_lease, &actor)?;
    persist_repair_actor_attestation(&raw.actor_attestation)?;
    Ok(RepairActorBootstrap {
        numbering_lease: raw.numbering_lease,
    })
}

pub(crate) fn clear_repair_actor_attestation() -> Result<(), String> {
    let actor_result = (|| {
        crate::storage::delete_repair_actor_attestation()
            .map_err(|_| "REPAIR_ACTOR_ATTESTATION_CLEAR_FAILED".to_string())?;
        if crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
            .map_err(|_| "REPAIR_ACTOR_ATTESTATION_CLEAR_FAILED".to_string())?
            .is_some()
        {
            return Err("REPAIR_ACTOR_ATTESTATION_CLEAR_FAILED".to_string());
        }
        Ok(())
    })();
    let cache_result = crate::repair_attachment_cache::purge_all();
    if actor_result.is_err() || cache_result.is_err() {
        let _ = crate::repairs::latch_startup_access_pending();
    }
    actor_result?;
    cache_result
}

pub(crate) fn invalidate_repair_actor_for_session_claim(next_session: &str) -> Result<(), String> {
    let Some(raw) =
        crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
            .map_err(|_| "REPAIR_ACTOR_ATTESTATION_UNAVAILABLE".to_string())?
    else {
        return Ok(());
    };
    let actor_session_id = serde_json::from_str::<RepairActorAttestation>(&raw)
        .ok()
        .and_then(|actor| canonical_uuid(&actor.staff_session_id));
    let next_session_id = serde_json::from_str::<Value>(next_session)
        .ok()
        .and_then(|value| {
            value
                .as_object()
                .and_then(|object| required_string(object, "sessionId"))
                .and_then(canonical_uuid)
        });
    if actor_session_id.is_none() || actor_session_id != next_session_id {
        clear_repair_actor_attestation()?;
    }
    Ok(())
}

/// Resolve the sole staff-session header repair traffic may use.
///
/// Partial renderer hand-off blobs and local-simple-PIN identities are valid
/// for some legacy screens but are not remote repair credentials. Repair
/// transport therefore requires the complete canonical server identity and
/// checks the queue/envelope claims plus native tenant scope before returning
/// a header value.
#[cfg(test)]
pub(crate) fn resolve_repair_session(
    persisted_session: Option<&str>,
    claimed_staff_session_id: &str,
    envelope_staff_session_id: &str,
    queue_organization_id: &str,
    native_scope: &NativeRepairScope,
) -> Result<ValidatedRepairSession, RepairSessionError> {
    let persisted_session = persisted_session.ok_or_else(|| {
        RepairSessionError::new(
            RepairSessionErrorCode::SessionRequired,
            "A signed-in staff session is required for repair traffic",
        )
    })?;
    if persisted_session.len() > MAX_PERSISTED_REPAIR_SESSION_BYTES {
        return Err(RepairSessionError::new(
            RepairSessionErrorCode::SessionInvalid,
            "The persisted staff session is invalid",
        ));
    }
    let parsed: Value = serde_json::from_str(persisted_session).map_err(|_| {
        RepairSessionError::new(
            RepairSessionErrorCode::SessionInvalid,
            "The persisted staff session is invalid",
        )
    })?;
    let object = parsed.as_object().ok_or_else(|| {
        RepairSessionError::new(
            RepairSessionErrorCode::SessionInvalid,
            "The persisted staff session is invalid",
        )
    })?;

    let stored_session_id = required_string(object, "sessionId")
        .and_then(canonical_uuid)
        .ok_or_else(|| {
            RepairSessionError::new(
                RepairSessionErrorCode::SessionInvalid,
                "The persisted staff session is incomplete",
            )
        })?;
    let staff_id = required_string(object, "staffId")
        .and_then(canonical_uuid)
        .ok_or_else(|| {
            RepairSessionError::new(
                RepairSessionErrorCode::SessionInvalid,
                "The persisted staff session is incomplete",
            )
        })?;
    let branch_id = required_string(object, "branchId")
        .and_then(canonical_uuid)
        .ok_or_else(|| {
            RepairSessionError::new(
                RepairSessionErrorCode::SessionInvalid,
                "The persisted staff session is incomplete",
            )
        })?;
    let organization_id = required_string(object, "organizationId")
        .and_then(canonical_uuid)
        .ok_or_else(|| {
            RepairSessionError::new(
                RepairSessionErrorCode::SessionInvalid,
                "The persisted staff session is incomplete",
            )
        })?;
    let terminal_id = required_string(object, "terminalId")
        .filter(|value| value.len() <= 255)
        .ok_or_else(|| {
            RepairSessionError::new(
                RepairSessionErrorCode::SessionInvalid,
                "The persisted staff session is incomplete",
            )
        })?;

    let claimed = canonical_uuid(claimed_staff_session_id).ok_or_else(|| {
        RepairSessionError::new(
            RepairSessionErrorCode::SessionInvalid,
            "The claimed staff session is invalid",
        )
    })?;
    let envelope = canonical_uuid(envelope_staff_session_id).ok_or_else(|| {
        RepairSessionError::new(
            RepairSessionErrorCode::SessionInvalid,
            "The repair envelope staff session is invalid",
        )
    })?;
    if claimed != stored_session_id || envelope != stored_session_id {
        return Err(RepairSessionError::new(
            RepairSessionErrorCode::SessionMismatch,
            "The repair staff-session claims do not match",
        ));
    }

    let native_organization_id =
        canonical_uuid(&native_scope.organization_id).ok_or_else(|| {
            RepairSessionError::new(
                RepairSessionErrorCode::ScopeMismatch,
                "The native repair tenant scope is unavailable",
            )
        })?;
    let native_branch_id = canonical_uuid(&native_scope.branch_id).ok_or_else(|| {
        RepairSessionError::new(
            RepairSessionErrorCode::ScopeMismatch,
            "The native repair branch scope is unavailable",
        )
    })?;
    let queue_organization_id = canonical_uuid(queue_organization_id).ok_or_else(|| {
        RepairSessionError::new(
            RepairSessionErrorCode::ScopeMismatch,
            "The queued repair tenant scope is invalid",
        )
    })?;
    let native_terminal_id = native_scope.terminal_id.trim();
    if native_terminal_id.is_empty()
        || native_terminal_id.len() > 255
        || organization_id != native_organization_id
        || organization_id != queue_organization_id
        || branch_id != native_branch_id
        || terminal_id != native_terminal_id
    {
        return Err(RepairSessionError::new(
            RepairSessionErrorCode::ScopeMismatch,
            "The repair session does not match the native terminal scope",
        ));
    }

    Ok(ValidatedRepairSession {
        staff_session_id: stored_session_id,
        staff_id,
        organization_id,
        branch_id,
        terminal_id: terminal_id.to_string(),
        permissions: {
            let mut permissions = REPAIR_PERMISSIONS
                .iter()
                .map(|permission| (*permission).to_string())
                .collect::<Vec<_>>();
            permissions.sort();
            permissions
        },
        offline_expires_at: chrono::Utc::now() + chrono::Duration::hours(2),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairSyncExpectedIdentity {
    pub(crate) operation_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
}

pub(crate) struct PreparedRepairCommandRequest {
    pub(crate) context: RepairQueueContext,
    pub(crate) expected_identity: RepairSyncExpectedIdentity,
    pub(crate) terminal_id: String,
    pub(crate) staff_session_id: String,
    pub(crate) body: Zeroizing<String>,
}

pub(crate) struct PreparedRepairAttachmentRequest {
    pub(crate) context: RepairQueueContext,
    pub(crate) session: ValidatedRepairSession,
    pub(crate) upload: RepairRawAttachmentUpload,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairCommandEnvelope {
    operation_id: String,
    repair_id: String,
    expected_version: u64,
    staff_session_id: String,
    command: String,
    payload: Value,
    occurred_at: String,
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json_value),
        Value::Object(values) => values.values_mut().for_each(zeroize_json_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    *value = Value::Null;
}

impl Drop for RawRepairCommandEnvelope {
    fn drop(&mut self) {
        self.operation_id.zeroize();
        self.repair_id.zeroize();
        self.staff_session_id.zeroize();
        self.command.zeroize();
        zeroize_json_value(&mut self.payload);
        self.occurred_at.zeroize();
    }
}

fn resolve_native_repair_scope(
    connection: &Connection,
) -> Result<NativeRepairScope, RepairHookError> {
    fn native_value(connection: &Connection, key: &str) -> Option<String> {
        crate::storage::get_credential(key)
            .or_else(|| crate::db::get_setting(connection, "terminal", key))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    Ok(NativeRepairScope {
        organization_id: native_value(connection, "organization_id").ok_or_else(|| {
            RepairHookError::unavailable("REPAIR_NATIVE_ORGANIZATION_UNAVAILABLE")
        })?,
        branch_id: native_value(connection, "branch_id")
            .ok_or_else(|| RepairHookError::unavailable("REPAIR_NATIVE_BRANCH_UNAVAILABLE"))?,
        terminal_id: native_value(connection, "terminal_id")
            .ok_or_else(|| RepairHookError::unavailable("REPAIR_NATIVE_TERMINAL_UNAVAILABLE"))?,
    })
}

fn valid_offline_command(envelope: &RawRepairCommandEnvelope) -> bool {
    match envelope.command.as_str() {
        "create_intake" | "add_note" | "assign_repair" | "plan_line" => true,
        "update_diagnosis" => envelope.payload.get("draft").and_then(Value::as_bool) == Some(true),
        "transition_status" => matches!(
            envelope
                .payload
                .get("target_status")
                .and_then(Value::as_str),
            Some(
                "diagnosing"
                    | "waiting_customer_approval"
                    | "waiting_parts"
                    | "repairing"
                    | "quality_check"
                    | "ready"
            )
        ),
        _ => false,
    }
}

pub(crate) fn prepare_repair_command_request(
    connection: &Connection,
    item: &SyncQueueItem,
    hooks: &dyn RepairQueueHooks,
) -> Result<PreparedRepairCommandRequest, RepairHookError> {
    let native_scope = resolve_native_repair_scope(connection)?;
    let validated_session = authorize_any_repair_actor_for_scope(&native_scope)?;
    if canonical_uuid(&item.organization_id).as_deref() != Some(validated_session.organization_id())
    {
        return Err(RepairHookError::permanent("REPAIR_NATIVE_SCOPE_MISMATCH"));
    }
    let decoded = hooks.decode_command_envelope(connection, item)?;
    if decoded.len() > MAX_REPAIR_COMMAND_ENVELOPE_BYTES {
        return Err(RepairHookError::permanent(
            "REPAIR_COMMAND_ENVELOPE_TOO_LARGE",
        ));
    }
    let envelope: RawRepairCommandEnvelope = serde_json::from_str(&decoded)
        .map_err(|_| RepairHookError::permanent("REPAIR_COMMAND_ENVELOPE_INVALID"))?;

    let operation_id = canonical_uuid(&envelope.operation_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_OPERATION_ID_INVALID"))?;
    let repair_id = canonical_uuid(&envelope.repair_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ID_INVALID"))?;
    let staff_session_id = canonical_uuid(&envelope.staff_session_id)
        .ok_or_else(|| RepairHookError::sign_in("STAFF_SESSION_INVALID"))?;
    if repair_id != item.record_id
        || item.id != operation_id
        || item.table_name != "repairs"
        || item.operation != "INSERT"
        || item.module_type != "repairs"
        || item.conflict_strategy != "manual"
        || envelope.expected_version > MAX_JAVASCRIPT_SAFE_INTEGER
        || u64::try_from(item.version).ok() != Some(envelope.expected_version)
        || !envelope.payload.is_object()
        || chrono::DateTime::parse_from_rfc3339(&envelope.occurred_at).is_err()
        || !valid_offline_command(&envelope)
    {
        return Err(RepairHookError::permanent(
            "REPAIR_COMMAND_ENVELOPE_MISMATCH",
        ));
    }
    let required_permission =
        required_permission_for_offline_command_name(&envelope.command, &envelope.payload)?;
    if staff_session_id != validated_session.staff_session_id() {
        return Err(RepairHookError::sign_in("REPAIR_ACTOR_MISMATCH"));
    }
    if !validated_session.has_permission(required_permission) {
        return Err(RepairHookError::permanent("REPAIR_PERMISSION_DENIED"));
    }

    let context = RepairQueueContext {
        queue_id: item.id.clone(),
        claim_generation: item.claim_generation,
        repair_id: repair_id.clone(),
        operation_id: operation_id.clone(),
        organization_id: item.organization_id.clone(),
        expected_version: envelope.expected_version,
    };

    hooks.validate_command_envelope(connection, &context, &decoded)?;
    hooks.before_dispatch(connection, &context)?;

    let mut body = Zeroizing::new(String::with_capacity(decoded.len().saturating_add(12)));
    body.push_str("{\"items\":[");
    body.push_str(&decoded);
    body.push_str("]}");
    Ok(PreparedRepairCommandRequest {
        context,
        expected_identity: RepairSyncExpectedIdentity {
            operation_id,
            repair_id,
            expected_version: envelope.expected_version,
        },
        terminal_id: validated_session.terminal_id().to_string(),
        staff_session_id: validated_session.staff_session_id().to_string(),
        body,
    })
}

pub(crate) fn prepare_repair_attachment_request(
    connection: &Connection,
    item: &SyncQueueItem,
    hooks: &dyn RepairQueueHooks,
) -> Result<PreparedRepairAttachmentRequest, RepairHookError> {
    if item.table_name != "repair_attachments"
        || item.operation != "INSERT"
        || item.module_type != "repairs"
        || item.conflict_strategy != "manual"
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_QUEUE_MISMATCH",
        ));
    }
    let native_scope = resolve_native_repair_scope(connection)?;
    let session = authorize_repair_actor_inner(
        &native_scope,
        None,
        Some("repairs.attachments"),
        chrono::Utc::now(),
    )?;
    if canonical_uuid(&item.organization_id).as_deref() != Some(session.organization_id()) {
        return Err(RepairHookError::permanent("REPAIR_NATIVE_SCOPE_MISMATCH"));
    }
    let upload = hooks.decode_attachment_upload(connection, item)?;
    let repair_id = canonical_uuid(&upload.repair_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ATTACHMENT_IDENTITY_INVALID"))?;
    let attachment_id = canonical_uuid(&upload.metadata.attachment_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ATTACHMENT_IDENTITY_INVALID"))?;
    let operation_id = canonical_uuid(&upload.metadata.operation_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ATTACHMENT_IDENTITY_INVALID"))?;
    let staff_session_id = canonical_uuid(&upload.metadata.staff_session_id)
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    if repair_id != upload.repair_id
        || attachment_id != upload.metadata.attachment_id
        || operation_id != upload.metadata.operation_id
        || staff_session_id != upload.metadata.staff_session_id
        || item.table_name != "repair_attachments"
        || item.id != operation_id
        || item.record_id != attachment_id
        || item.operation != "INSERT"
        || item.module_type != "repairs"
        || item.conflict_strategy != "manual"
        || u64::try_from(item.version).ok() != Some(upload.metadata.expected_version)
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_QUEUE_MISMATCH",
        ));
    }
    if staff_session_id != session.staff_session_id() {
        return Err(RepairHookError::sign_in("REPAIR_ACTOR_MISMATCH"));
    }

    let context = RepairQueueContext {
        queue_id: item.id.clone(),
        claim_generation: item.claim_generation,
        repair_id,
        operation_id,
        organization_id: item.organization_id.clone(),
        expected_version: upload.metadata.expected_version,
    };
    validate_repair_attachment_upload(&session, &upload)?;
    hooks.before_dispatch(connection, &context)?;

    Ok(PreparedRepairAttachmentRequest {
        context,
        session,
        upload,
    })
}

pub(crate) struct BoundedRepairHttpResponse {
    pub(crate) status: u16,
    pub(crate) retry_after: Option<String>,
    pub(crate) body: Vec<u8>,
    pub(crate) exceeded_limit: bool,
}

impl std::fmt::Debug for BoundedRepairHttpResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundedRepairHttpResponse")
            .field("status", &self.status)
            .field("has_retry_after", &self.retry_after.is_some())
            .field("body_len", &self.body.len())
            .field("exceeded_limit", &self.exceeded_limit)
            .finish()
    }
}

pub(crate) async fn read_bounded_repair_response(
    response: reqwest::Response,
) -> Result<BoundedRepairHttpResponse, RepairHookError> {
    read_bounded_repair_response_with_limit(response, MAX_REPAIR_RESPONSE_BYTES).await
}

async fn read_bounded_repair_response_with_limit(
    mut response: reqwest::Response,
    maximum_bytes: usize,
) -> Result<BoundedRepairHttpResponse, RepairHookError> {
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut body = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|_| RepairHookError::retryable("REPAIR_RESPONSE_READ_FAILED"))?;
        let Some(chunk) = chunk else {
            break;
        };
        if body.len().saturating_add(chunk.len()) > maximum_bytes {
            return Ok(BoundedRepairHttpResponse {
                status,
                retry_after,
                body: Vec::new(),
                exceeded_limit: true,
            });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(BoundedRepairHttpResponse {
        status,
        retry_after,
        body,
        exceeded_limit: false,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RepairStatus {
    Received,
    Diagnosing,
    WaitingCustomerApproval,
    Approved,
    WaitingParts,
    Repairing,
    QualityCheck,
    Ready,
    Delivered,
    Cancelled,
    Unrepairable,
}

impl RepairStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Diagnosing => "diagnosing",
            Self::WaitingCustomerApproval => "waiting_customer_approval",
            Self::Approved => "approved",
            Self::WaitingParts => "waiting_parts",
            Self::Repairing => "repairing",
            Self::QualityCheck => "quality_check",
            Self::Ready => "ready",
            Self::Delivered => "delivered",
            Self::Cancelled => "cancelled",
            Self::Unrepairable => "unrepairable",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairSyncSuccessSignal {
    pub(crate) repair_id: String,
    pub(crate) status: RepairStatus,
    pub(crate) version: u64,
    pub(crate) display_number: Option<String>,
    pub(crate) provisional_alias: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairSafeSummary {
    pub(crate) display_number: Option<String>,
    pub(crate) status: RepairStatus,
    pub(crate) version: u64,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairConflictProjection {
    pub(crate) operation_id: String,
    pub(crate) repair_id: String,
    pub(crate) expected_version: u64,
    pub(crate) current_version: u64,
    pub(crate) allowed_transitions: Vec<String>,
    pub(crate) summary: RepairSafeSummary,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub(crate) struct RepairBoundedError {
    pub(crate) code: String,
    pub(crate) message: Option<String>,
}

impl std::fmt::Debug for RepairBoundedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RepairBoundedError")
            .field("code", &self.code)
            .field("has_message", &self.message.is_some())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ParityTerminalAuthCode {
    MissingTerminalId,
    TerminalNotFound,
    TerminalLookupError,
    TerminalInactive,
    OrganizationInactive,
    OrganizationLookupError,
    OrganizationPendingDeletion,
    InvalidTerminalApiKey,
    TerminalIdentityMismatch,
    AuthenticationError,
    Unauthorized,
    PerTerminalAuthRequired,
}

impl ParityTerminalAuthCode {
    pub(crate) fn from_wire(value: &str) -> Option<Self> {
        match value {
            "missing_terminal_id" => Some(Self::MissingTerminalId),
            "terminal_not_found" => Some(Self::TerminalNotFound),
            "terminal_lookup_error" => Some(Self::TerminalLookupError),
            "terminal_inactive" => Some(Self::TerminalInactive),
            "organization_inactive" => Some(Self::OrganizationInactive),
            "organization_lookup_error" => Some(Self::OrganizationLookupError),
            "organization_pending_deletion" => Some(Self::OrganizationPendingDeletion),
            "invalid_terminal_api_key" => Some(Self::InvalidTerminalApiKey),
            "terminal_identity_mismatch" => Some(Self::TerminalIdentityMismatch),
            "authentication_error" => Some(Self::AuthenticationError),
            "unauthorized" => Some(Self::Unauthorized),
            "per_terminal_auth_required" => Some(Self::PerTerminalAuthRequired),
            _ => None,
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::MissingTerminalId => "missing_terminal_id",
            Self::TerminalNotFound => "terminal_not_found",
            Self::TerminalLookupError => "terminal_lookup_error",
            Self::TerminalInactive => "terminal_inactive",
            Self::OrganizationInactive => "organization_inactive",
            Self::OrganizationLookupError => "organization_lookup_error",
            Self::OrganizationPendingDeletion => "organization_pending_deletion",
            Self::InvalidTerminalApiKey => "invalid_terminal_api_key",
            Self::TerminalIdentityMismatch => "terminal_identity_mismatch",
            Self::AuthenticationError => "authentication_error",
            Self::Unauthorized => "unauthorized",
            Self::PerTerminalAuthRequired => "per_terminal_auth_required",
        }
    }

    pub(crate) const fn is_hard(self) -> bool {
        matches!(self, Self::TerminalInactive | Self::InvalidTerminalApiKey)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) struct ParityTerminalAuthFailure {
    pub(crate) code: ParityTerminalAuthCode,
    pub(crate) terminal_active: Option<bool>,
}

enum BoundedTopLevelFailure {
    Error(RepairBoundedError),
    TerminalAuth(ParityTerminalAuthFailure),
}

fn generic_terminal_auth_prerequisite() -> RepairBoundedError {
    RepairBoundedError {
        code: "POS_TERMINAL_AUTH_REQUIRED".to_string(),
        message: None,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RepairSyncDisposition {
    Success(RepairSyncSuccessSignal),
    Conflict(RepairConflictProjection),
    SessionRequired(RepairBoundedError),
    TerminalAuth(ParityTerminalAuthFailure),
    ModuleRequired(RepairBoundedError),
    RateLimited { retry_after_seconds: i64 },
    PermanentFailure(RepairBoundedError),
    RetryableFailure(RepairBoundedError),
    MalformedResponse,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairSyncResponse {
    results: Vec<RawRepairSyncItem>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairSyncItem {
    operation_id: String,
    repair_id: String,
    ok: bool,
    status: u16,
    replayed: Option<bool>,
    signal: Option<RawRepairSyncSuccessSignal>,
    error: Option<RawRepairSyncError>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairSyncSuccessSignal {
    repair_id: String,
    status: RepairStatus,
    version: u64,
    display_number: Option<String>,
    provisional_alias: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairSyncError {
    code: String,
    message: Option<String>,
    current_version: Option<u64>,
    allowed_transitions: Option<Vec<RepairStatus>>,
    summary: Option<RawRepairSafeSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairSafeSummary {
    display_number: Option<String>,
    status: RepairStatus,
    version: u64,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawTopLevelError {
    Code(RawTopLevelCodeError),
    Named(RawTopLevelNamedError),
    Auth(RawTopLevelAuthError),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTopLevelCodeError {
    code: String,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawTopLevelNamedError {
    success: bool,
    error: String,
    message: Option<String>,
    missing_modules: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawTopLevelAuthError {
    success: bool,
    error: String,
    code: String,
    auth_source: Option<String>,
    terminal_active: Option<bool>,
    terminal_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOperationScopedError {
    code: String,
    message: String,
    operation_id: String,
    repair_id: String,
}

fn valid_display_number(value: &Option<String>) -> bool {
    value.as_ref().map_or(true, |candidate| {
        let trimmed = candidate.trim();
        !trimmed.is_empty() && trimmed == candidate && candidate.chars().count() <= 80
    })
}

fn valid_provisional_alias(value: &Option<String>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let segments: Vec<&str> = value.split('-').collect();
    segments.len() == 4
        && segments[0] == "R"
        && segments[1] == "OFF"
        && segments[2].len() == 4
        && segments[2]
            .chars()
            .all(|character| character.is_ascii_digit() || ('A'..='F').contains(&character))
        && segments[3].len() == 6
        && segments[3]
            .chars()
            .all(|character| character.is_ascii_digit())
}

fn valid_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 120
        && bytes[0].is_ascii_uppercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn bounded_error(raw: &RawRepairSyncError) -> Option<RepairBoundedError> {
    if !valid_error_code(&raw.code) {
        return None;
    }
    let message = match raw.message.as_ref() {
        Some(message) => {
            let trimmed = message.trim();
            if trimmed.is_empty() || trimmed != message || message.chars().count() > 1_000 {
                return None;
            }
            Some(message.clone())
        }
        None => None,
    };
    Some(RepairBoundedError {
        code: raw.code.clone(),
        message,
    })
}

fn valid_response_identity(
    item: &RawRepairSyncItem,
    expected: &RepairSyncExpectedIdentity,
) -> bool {
    canonical_uuid(&item.operation_id).as_deref() == Some(expected.operation_id.as_str())
        && canonical_uuid(&item.repair_id).as_deref() == Some(expected.repair_id.as_str())
        && canonical_uuid(&expected.operation_id).is_some()
        && canonical_uuid(&expected.repair_id).is_some()
}

fn classify_success_item(
    item: RawRepairSyncItem,
    expected: &RepairSyncExpectedIdentity,
) -> RepairSyncDisposition {
    if !(200..300).contains(&item.status) || item.error.is_some() {
        return RepairSyncDisposition::MalformedResponse;
    }
    let Some(signal) = item.signal else {
        return RepairSyncDisposition::MalformedResponse;
    };
    if canonical_uuid(&signal.repair_id).as_deref() != Some(expected.repair_id.as_str())
        || signal.version <= expected.expected_version
        || signal.version > MAX_JAVASCRIPT_SAFE_INTEGER
        || !valid_display_number(&signal.display_number)
        || !valid_provisional_alias(&signal.provisional_alias)
    {
        return RepairSyncDisposition::MalformedResponse;
    }
    RepairSyncDisposition::Success(RepairSyncSuccessSignal {
        repair_id: signal.repair_id,
        status: signal.status,
        version: signal.version,
        display_number: signal.display_number,
        provisional_alias: signal.provisional_alias,
    })
}

fn classify_conflict(
    item: &RawRepairSyncItem,
    error: &RawRepairSyncError,
    expected: &RepairSyncExpectedIdentity,
) -> RepairSyncDisposition {
    let (Some(current_version), Some(allowed_transitions), Some(summary)) = (
        error.current_version,
        error.allowed_transitions.as_ref(),
        error.summary.as_ref(),
    ) else {
        return RepairSyncDisposition::MalformedResponse;
    };
    let unique_transitions: HashSet<RepairStatus> = allowed_transitions.iter().copied().collect();
    if current_version == 0
        || current_version > MAX_JAVASCRIPT_SAFE_INTEGER
        || summary.version != current_version
        || summary.version == 0
        || allowed_transitions.len() > 11
        || unique_transitions.len() != allowed_transitions.len()
        || !valid_display_number(&summary.display_number)
        || chrono::DateTime::parse_from_rfc3339(&summary.updated_at).is_err()
    {
        return RepairSyncDisposition::MalformedResponse;
    }
    RepairSyncDisposition::Conflict(RepairConflictProjection {
        operation_id: item.operation_id.clone(),
        repair_id: item.repair_id.clone(),
        expected_version: expected.expected_version,
        current_version,
        allowed_transitions: allowed_transitions
            .iter()
            .map(|status| status.as_str().to_string())
            .collect(),
        summary: RepairSafeSummary {
            display_number: summary.display_number.clone(),
            status: summary.status,
            version: summary.version,
            updated_at: summary.updated_at.clone(),
        },
    })
}

fn bounded_retry_after(value: Option<&str>) -> i64 {
    value
        .and_then(|candidate| candidate.trim().parse::<i64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_REPAIR_RETRY_AFTER_SECONDS)
        .clamp(1, MAX_REPAIR_RETRY_AFTER_SECONDS)
}

fn session_error_code(code: &str) -> bool {
    matches!(
        code,
        "STAFF_SESSION_REQUIRED"
            | "STAFF_SESSION_INVALID"
            | "STAFF_SESSION_MISMATCH"
            | "REPAIR_EXPIRED_SESSION"
            | "POS_TERMINAL_REQUIRED"
            | "POS_TERMINAL_AUTH_REQUIRED"
    )
}

fn classify_error_item(
    item: RawRepairSyncItem,
    expected: &RepairSyncExpectedIdentity,
    retry_after: Option<&str>,
) -> RepairSyncDisposition {
    if !(400..600).contains(&item.status) || item.replayed.is_some() || item.signal.is_some() {
        return RepairSyncDisposition::MalformedResponse;
    }
    let Some(error) = item.error.as_ref() else {
        return RepairSyncDisposition::MalformedResponse;
    };
    let Some(bounded) = bounded_error(error) else {
        return RepairSyncDisposition::MalformedResponse;
    };

    if item.status == 409 && error.code == "REPAIR_VERSION_CONFLICT" {
        return classify_conflict(&item, error, expected);
    }
    if session_error_code(&error.code) {
        return RepairSyncDisposition::SessionRequired(bounded);
    }
    if error.code == "MODULE_REQUIRED" {
        return RepairSyncDisposition::ModuleRequired(bounded);
    }
    if item.status == 429 {
        return RepairSyncDisposition::RateLimited {
            retry_after_seconds: bounded_retry_after(retry_after),
        };
    }
    if item.status < 500 {
        RepairSyncDisposition::PermanentFailure(bounded)
    } else {
        RepairSyncDisposition::RetryableFailure(bounded)
    }
}

/// Parse the one-item repair batch response into a bounded native outcome.
///
/// No arbitrary JSON or response text is retained. Any size, shape, field, or
/// identity mismatch collapses to the same non-sensitive retryable marker.
#[cfg(test)]
pub(crate) fn classify_repair_sync_response(
    http_status: u16,
    response_body: &[u8],
    expected: &RepairSyncExpectedIdentity,
) -> RepairSyncDisposition {
    classify_repair_http_response(http_status, response_body, None, expected)
}

fn bounded_top_level_failure(raw: RawTopLevelError) -> Option<BoundedTopLevelFailure> {
    let (code, message, missing_modules) = match raw {
        RawTopLevelError::Code(error) => (error.code, error.message, None),
        RawTopLevelError::Named(error) => {
            if error.success {
                return None;
            }
            (error.error, error.message, error.missing_modules)
        }
        RawTopLevelError::Auth(error) => {
            let auth_code = ParityTerminalAuthCode::from_wire(&error.code)?;
            let valid_source = error
                .auth_source
                .as_deref()
                .map_or(true, |source| matches!(source, "cache" | "db" | "bearer"));
            let valid_terminal_id = error.terminal_id.as_deref().map_or(true, |terminal_id| {
                let trimmed = terminal_id.trim();
                !trimmed.is_empty() && trimmed == terminal_id && terminal_id.chars().count() <= 128
            });
            let trimmed_error = error.error.trim();
            if error.success
                || !valid_source
                || !valid_terminal_id
                || trimmed_error.is_empty()
                || trimmed_error != error.error
                || error.error.chars().count() > 1_000
            {
                return None;
            }
            return Some(BoundedTopLevelFailure::TerminalAuth(
                ParityTerminalAuthFailure {
                    code: auth_code,
                    terminal_active: error.terminal_active,
                },
            ));
        }
    };
    if !valid_error_code(&code) {
        return None;
    }
    if code == "MODULE_REQUIRED" {
        if !matches!(missing_modules.as_deref(), Some([module]) if module == "repairs") {
            return None;
        }
    } else if missing_modules.is_some() {
        return None;
    }
    let message = match message {
        Some(message) => {
            let trimmed = message.trim();
            if trimmed.is_empty() || trimmed != message || message.chars().count() > 1_000 {
                return None;
            }
            Some(message)
        }
        None => None,
    };
    Some(BoundedTopLevelFailure::Error(RepairBoundedError {
        code,
        message,
    }))
}

/// Classify both transport-level status responses and the HTTP-200 repair
/// batch envelope. `Retry-After` is parsed from the trusted response header
/// and clamped so a hostile value cannot indefinitely park the terminal.
pub(crate) fn classify_repair_http_response(
    http_status: u16,
    response_body: &[u8],
    retry_after: Option<&str>,
    expected: &RepairSyncExpectedIdentity,
) -> RepairSyncDisposition {
    if response_body.len() > MAX_REPAIR_RESPONSE_BYTES {
        return RepairSyncDisposition::MalformedResponse;
    }

    if http_status == 429 {
        return RepairSyncDisposition::RateLimited {
            retry_after_seconds: bounded_retry_after(retry_after),
        };
    }
    if http_status >= 500 {
        return RepairSyncDisposition::RetryableFailure(RepairBoundedError {
            code: "HTTP_SERVER_ERROR".to_string(),
            message: None,
        });
    }
    if (400..500).contains(&http_status) {
        let Ok(raw) = serde_json::from_slice::<RawTopLevelError>(response_body) else {
            return RepairSyncDisposition::MalformedResponse;
        };
        let Some(failure) = bounded_top_level_failure(raw) else {
            return RepairSyncDisposition::MalformedResponse;
        };
        let error = match failure {
            BoundedTopLevelFailure::TerminalAuth(failure) => {
                return RepairSyncDisposition::TerminalAuth(failure);
            }
            BoundedTopLevelFailure::Error(error) => error,
        };
        if session_error_code(&error.code) {
            return RepairSyncDisposition::SessionRequired(error);
        }
        if error.code == "MODULE_REQUIRED" {
            return RepairSyncDisposition::ModuleRequired(error);
        }
        return RepairSyncDisposition::PermanentFailure(error);
    }
    if http_status != 200 {
        return RepairSyncDisposition::MalformedResponse;
    }

    let Ok(mut response) = serde_json::from_slice::<RawRepairSyncResponse>(response_body) else {
        return RepairSyncDisposition::MalformedResponse;
    };
    if response.results.len() != 1 {
        return RepairSyncDisposition::MalformedResponse;
    }
    let item = response.results.remove(0);
    if !valid_response_identity(&item, expected) {
        return RepairSyncDisposition::MalformedResponse;
    }
    if item.ok {
        classify_success_item(item, expected)
    } else {
        classify_error_item(item, expected, retry_after)
    }
}

#[derive(Eq, PartialEq)]
pub(crate) struct RepairRawAttachmentMetadata {
    pub(crate) attachment_id: String,
    pub(crate) operation_id: String,
    pub(crate) staff_session_id: String,
    pub(crate) expected_version: u64,
    pub(crate) occurred_at: String,
    pub(crate) attachment_type: String,
    pub(crate) filename: String,
    pub(crate) caption: Option<String>,
    pub(crate) mime_type: String,
    pub(crate) byte_size: u64,
    pub(crate) sha256_hex: String,
}

impl Zeroize for RepairRawAttachmentMetadata {
    fn zeroize(&mut self) {
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

impl Drop for RepairRawAttachmentMetadata {
    fn drop(&mut self) {
        self.zeroize();
    }
}

pub(crate) struct RepairRawAttachmentUpload {
    pub(crate) repair_id: String,
    pub(crate) metadata: RepairRawAttachmentMetadata,
    pub(crate) bytes: Zeroizing<Vec<u8>>,
}

impl Zeroize for RepairRawAttachmentUpload {
    fn zeroize(&mut self) {
        self.repair_id.zeroize();
        self.metadata.zeroize();
        self.bytes.zeroize();
    }
}

impl Drop for RepairRawAttachmentUpload {
    fn drop(&mut self) {
        self.zeroize();
    }
}

// Native binding seam consumed by Task 9C's staged-attachment dispatcher.
// It intentionally has no production caller until that cache slice lands.
#[allow(dead_code)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairAttachmentUploadResult {
    pub(crate) attachment_id: String,
    pub(crate) repair_id: String,
    pub(crate) status: RepairStatus,
    pub(crate) version: u64,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RepairAttachmentDisposition {
    Uploaded(RepairAttachmentUploadResult),
    Conflict(RepairConflictProjection),
    SessionRequired(RepairBoundedError),
    TerminalAuth(ParityTerminalAuthFailure),
    ModuleRequired(RepairBoundedError),
    RateLimited { retry_after_seconds: i64 },
    PermanentFailure(RepairBoundedError),
    RetryableFailure(RepairBoundedError),
    MalformedResponse,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairAttachmentUploadResponse {
    attachment_id: String,
    repair_id: String,
    status: RepairStatus,
    version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRepairAttachmentConflictResponse {
    code: String,
    message: String,
    operation_id: String,
    repair_id: String,
    expected_version: u64,
    current_version: u64,
    allowed_transitions: Vec<RepairStatus>,
    summary: RawRepairSafeSummary,
}

fn valid_utf16_length(value: &str, maximum: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed == value && value.encode_utf16().count() <= maximum
}

#[allow(dead_code)]
fn validate_repair_attachment_upload(
    session: &ValidatedRepairSession,
    upload: &RepairRawAttachmentUpload,
) -> Result<(), RepairHookError> {
    if canonical_uuid(&upload.repair_id).as_deref() != Some(upload.repair_id.as_str())
        || canonical_uuid(&upload.metadata.attachment_id).as_deref()
            != Some(upload.metadata.attachment_id.as_str())
        || canonical_uuid(&upload.metadata.operation_id).as_deref()
            != Some(upload.metadata.operation_id.as_str())
        || canonical_uuid(&upload.metadata.staff_session_id).as_deref()
            != Some(session.staff_session_id())
        || upload.metadata.expected_version > MAX_JAVASCRIPT_SAFE_INTEGER
        || upload.metadata.occurred_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&upload.metadata.occurred_at).is_err()
        || !matches!(
            upload.metadata.attachment_type.as_str(),
            "intake" | "diagnostic" | "repair" | "quality_check" | "handover" | "other"
        )
        || !valid_utf16_length(&upload.metadata.filename, 255)
        || upload
            .metadata
            .caption
            .as_deref()
            .is_some_and(|caption| !valid_utf16_length(caption, 1_000))
        || !matches!(
            upload.metadata.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
        )
        || upload.bytes.is_empty()
        || upload.bytes.len() > MAX_REPAIR_ATTACHMENT_BYTES
        || upload.metadata.byte_size != u64::try_from(upload.bytes.len()).unwrap_or(u64::MAX)
        || upload.metadata.sha256_hex.len() != 64
        || !upload
            .metadata
            .sha256_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_METADATA_INVALID",
        ));
    }

    if canonical_uuid(session.staff_session_id()).as_deref() != Some(session.staff_session_id())
        || canonical_uuid(&session.staff_id).as_deref() != Some(session.staff_id.as_str())
        || canonical_uuid(session.organization_id()).as_deref() != Some(session.organization_id())
        || canonical_uuid(&session.branch_id).as_deref() != Some(session.branch_id.as_str())
        || session.terminal_id().trim().is_empty()
        || session.terminal_id().len() > 255
    {
        return Err(RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"));
    }

    let actual_hash = format!("{:x}", Sha256::digest(&upload.bytes));
    if actual_hash != upload.metadata.sha256_hex {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_HASH_MISMATCH",
        ));
    }
    Ok(())
}

fn attachment_conflict_projection(
    raw: RawRepairAttachmentConflictResponse,
    upload: &RepairRawAttachmentUpload,
) -> Option<RepairConflictProjection> {
    let unique_transitions: HashSet<RepairStatus> =
        raw.allowed_transitions.iter().copied().collect();
    if raw.code != "REPAIR_VERSION_CONFLICT"
        || !valid_utf16_length(&raw.message, 1_000)
        || canonical_uuid(&raw.operation_id).as_deref()
            != Some(upload.metadata.operation_id.as_str())
        || canonical_uuid(&raw.repair_id).as_deref() != Some(upload.repair_id.as_str())
        || raw.expected_version != upload.metadata.expected_version
        || raw.current_version == 0
        || raw.current_version > MAX_JAVASCRIPT_SAFE_INTEGER
        || raw.summary.version != raw.current_version
        || raw.allowed_transitions.len() > 11
        || unique_transitions.len() != raw.allowed_transitions.len()
        || !valid_display_number(&raw.summary.display_number)
        || chrono::DateTime::parse_from_rfc3339(&raw.summary.updated_at).is_err()
    {
        return None;
    }
    Some(RepairConflictProjection {
        operation_id: raw.operation_id,
        repair_id: raw.repair_id,
        expected_version: raw.expected_version,
        current_version: raw.current_version,
        allowed_transitions: raw
            .allowed_transitions
            .into_iter()
            .map(|status| status.as_str().to_string())
            .collect(),
        summary: RepairSafeSummary {
            display_number: raw.summary.display_number,
            status: raw.summary.status,
            version: raw.summary.version,
            updated_at: raw.summary.updated_at,
        },
    })
}

#[allow(dead_code)]
fn classify_repair_attachment_response(
    response: BoundedRepairHttpResponse,
    upload: &RepairRawAttachmentUpload,
) -> RepairAttachmentDisposition {
    if response.exceeded_limit {
        return RepairAttachmentDisposition::MalformedResponse;
    }
    if response.status == 201 {
        let Ok(raw) = serde_json::from_slice::<RawRepairAttachmentUploadResponse>(&response.body)
        else {
            return RepairAttachmentDisposition::MalformedResponse;
        };
        if canonical_uuid(&raw.attachment_id).as_deref()
            != Some(upload.metadata.attachment_id.as_str())
            || canonical_uuid(&raw.repair_id).as_deref() != Some(upload.repair_id.as_str())
            || raw.version <= upload.metadata.expected_version
            || raw.version > MAX_JAVASCRIPT_SAFE_INTEGER
        {
            return RepairAttachmentDisposition::MalformedResponse;
        }
        return RepairAttachmentDisposition::Uploaded(RepairAttachmentUploadResult {
            attachment_id: raw.attachment_id,
            repair_id: raw.repair_id,
            status: raw.status,
            version: raw.version,
        });
    }
    if response.status == 409 {
        if let Ok(raw) =
            serde_json::from_slice::<RawRepairAttachmentConflictResponse>(&response.body)
        {
            return attachment_conflict_projection(raw, upload)
                .map(RepairAttachmentDisposition::Conflict)
                .unwrap_or(RepairAttachmentDisposition::MalformedResponse);
        }
    }
    if response.status == 429 {
        return RepairAttachmentDisposition::RateLimited {
            retry_after_seconds: bounded_retry_after(response.retry_after.as_deref()),
        };
    }
    if response.status >= 500 {
        return RepairAttachmentDisposition::RetryableFailure(RepairBoundedError {
            code: "HTTP_SERVER_ERROR".to_string(),
            message: None,
        });
    }
    if (400..500).contains(&response.status) {
        let Ok(raw) = serde_json::from_slice::<RawTopLevelError>(&response.body) else {
            return RepairAttachmentDisposition::MalformedResponse;
        };
        let Some(failure) = bounded_top_level_failure(raw) else {
            return RepairAttachmentDisposition::MalformedResponse;
        };
        let error = match failure {
            BoundedTopLevelFailure::TerminalAuth(failure) => {
                return RepairAttachmentDisposition::TerminalAuth(failure);
            }
            BoundedTopLevelFailure::Error(error) => error,
        };
        if response.status == 409 && error.code == "REPAIR_VERSION_CONFLICT" {
            return RepairAttachmentDisposition::MalformedResponse;
        }
        if session_error_code(&error.code) {
            return RepairAttachmentDisposition::SessionRequired(error);
        }
        if error.code == "MODULE_REQUIRED" {
            return RepairAttachmentDisposition::ModuleRequired(error);
        }
        return RepairAttachmentDisposition::PermanentFailure(error);
    }
    RepairAttachmentDisposition::MalformedResponse
}

/// Upload staged repair bytes through a fixed native route and header set.
///
/// Every caller-supplied field is validated before the client is created, and
/// redirects are disabled so terminal credentials cannot cross an origin.
#[allow(dead_code)]
pub(crate) async fn send_repair_raw_attachment(
    base_url: &str,
    api_key: &str,
    session: &ValidatedRepairSession,
    mut upload: RepairRawAttachmentUpload,
) -> Result<RepairAttachmentDisposition, RepairHookError> {
    validate_repair_attachment_upload(session, &upload)?;
    if api_key.trim().is_empty() || api_key.len() > 4_096 {
        return Err(RepairHookError::unavailable(
            "REPAIR_NATIVE_API_KEY_UNAVAILABLE",
        ));
    }
    let safe_base = crate::api::resolve_admin_base(base_url)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    let mut endpoint = url::Url::parse(&safe_base)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    endpoint.set_path(&format!(
        "/api/pos/repairs/{}/attachments/raw",
        upload.repair_id
    ));

    let filename = Zeroizing::new(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(upload.metadata.filename.as_bytes()),
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RepairHookError::unavailable("REPAIR_HTTP_CLIENT_UNAVAILABLE"))?;
    let mut request = client
        .post(endpoint)
        .header("content-type", "application/octet-stream")
        .header("content-length", upload.bytes.len().to_string())
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", session.terminal_id())
        .header("x-staff-session-id", session.staff_session_id())
        .header("x-pos-client-version", env!("CARGO_PKG_VERSION"))
        .header("x-repair-content-type", &upload.metadata.mime_type)
        .header("x-repair-content-hash", &upload.metadata.sha256_hex)
        .header("x-repair-attachment-id", &upload.metadata.attachment_id)
        .header("x-repair-operation-id", &upload.metadata.operation_id)
        .header(
            "x-repair-expected-version",
            upload.metadata.expected_version.to_string(),
        )
        .header("x-repair-occurred-at", &upload.metadata.occurred_at)
        .header("x-repair-attachment-type", &upload.metadata.attachment_type)
        .header("x-repair-filename-b64url", filename.as_str());
    if let Some(caption) = upload.metadata.caption.as_ref() {
        let encoded_caption = Zeroizing::new(
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(caption.as_bytes()),
        );
        request = request.header("x-repair-caption-b64url", encoded_caption.as_str());
    }
    let response = request
        // Transfer the sole plaintext allocation into reqwest. The staging
        // hook hands native a Zeroizing buffer and this boundary never clones
        // it; after the move, no second app-owned plaintext allocation remains.
        .body(std::mem::take(&mut *upload.bytes))
        .send()
        .await
        .map_err(|_| RepairHookError::retryable("REPAIR_ATTACHMENT_UPLOAD_FAILED"))?;
    let bounded = read_bounded_repair_response(response).await?;
    Ok(classify_repair_attachment_response(bounded, &upload))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RepairEstimateLineInput {
    pub(crate) id: String,
    pub(crate) repair_line_id: Option<String>,
    pub(crate) line_type: String,
    pub(crate) description: String,
    pub(crate) quantity: String,
    pub(crate) unit_price: String,
    pub(crate) tax_rate: String,
    pub(crate) display_order: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "command",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum RepairTypedCommand {
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
        offline_sequence: Option<u32>,
    },
    ReopenRepair {
        source_repair_id: String,
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
        display_order: u32,
    },
    ConsumeNonstockPart {
        line_id: String,
    },
    ReverseNonstockPart {
        line_id: String,
        reason: String,
    },
    ConsumeRepairPart {
        line_id: String,
    },
    ReverseRepairPart {
        line_id: String,
        original_movement_id: String,
    },
    CreateEstimate {
        estimate_id: String,
        currency: String,
        discount_amount: String,
        valid_until: Option<String>,
        note: Option<String>,
        lines: Vec<RepairEstimateLineInput>,
    },
    RecordApproval {
        approval_id: String,
        estimate_id: Option<String>,
        decision: String,
        decision_source: String,
        reason: Option<String>,
    },
    TransitionStatus {
        target_status: String,
        reason: Option<String>,
        remain_consumed: bool,
    },
    TransferBranch {
        destination_branch_id: String,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RepairJsonRequest {
    List {
        status: Option<String>,
        search: Option<String>,
        limit: u16,
        offset: u32,
    },
    Workspace {
        repair_id: String,
    },
    Settings,
    OfflineBootstrap {},
    Customers {
        search: String,
        limit: u16,
        offset: u32,
    },
    CustomerDevices {
        customer_id: String,
    },
    CreateCustomerDevice {
        customer_id: String,
        device_id: String,
        label: Option<String>,
        device_type: String,
        manufacturer: Option<String>,
        model: Option<String>,
        variant: Option<String>,
        storage_capacity: Option<String>,
        color: Option<String>,
    },
    Attachments {
        repair_id: String,
    },
    PrintProjection {
        repair_id: String,
    },
    FinancialProjection {
        repair_id: String,
    },
    Command {
        repair_id: String,
        operation_id: String,
        expected_version: u64,
        occurred_at: String,
        command: RepairTypedCommand,
    },
    Settlement {
        repair_id: String,
        operation_id: String,
        expected_version: u64,
        occurred_at: String,
    },
    Payment {
        repair_id: String,
        operation_id: String,
        expected_version: u64,
        occurred_at: String,
        amount_minor: u64,
        payment_method: String,
        provider_reference: Option<String>,
    },
    Refund {
        repair_id: String,
        operation_id: String,
        expected_version: u64,
        occurred_at: String,
        payment_id: String,
        amount_minor: u64,
        refund_method: String,
        reason: String,
    },
    Fiscalize {
        repair_id: String,
        operation_id: String,
        expected_version: u64,
        occurred_at: String,
    },
    Delivery {
        repair_id: String,
        operation_id: String,
        expected_version: u64,
        occurred_at: String,
        reason: Option<String>,
    },
}

pub(crate) fn required_permission_for_typed_command(command: &RepairTypedCommand) -> &'static str {
    match command {
        RepairTypedCommand::CreateIntake { .. } | RepairTypedCommand::ReopenRepair { .. } => {
            "repairs.create"
        }
        RepairTypedCommand::RecordApproval { .. } => "repairs.approve",
        RepairTypedCommand::ConsumeNonstockPart { .. }
        | RepairTypedCommand::ReverseNonstockPart { .. }
        | RepairTypedCommand::ConsumeRepairPart { .. }
        | RepairTypedCommand::ReverseRepairPart { .. } => "repairs.stock",
        RepairTypedCommand::TransitionStatus { target_status, .. }
            if target_status == "cancelled" =>
        {
            "repairs.cancel"
        }
        RepairTypedCommand::TransferBranch { .. } => "repairs.transfer",
        RepairTypedCommand::AddNote { .. }
        | RepairTypedCommand::AssignRepair { .. }
        | RepairTypedCommand::UpdateDiagnosis { .. }
        | RepairTypedCommand::PlanLine { .. }
        | RepairTypedCommand::CreateEstimate { .. }
        | RepairTypedCommand::TransitionStatus { .. } => "repairs.update",
    }
}

fn required_permission_for_offline_command_name(
    command: &str,
    payload: &Value,
) -> Result<&'static str, RepairHookError> {
    match command {
        "create_intake" => Ok("repairs.create"),
        "add_note" | "assign_repair" | "update_diagnosis" | "plan_line" => Ok("repairs.update"),
        "transition_status"
            if payload.get("target_status").and_then(Value::as_str) == Some("cancelled") =>
        {
            Ok("repairs.cancel")
        }
        "transition_status" => Ok("repairs.update"),
        _ => Err(RepairHookError::permanent(
            "REPAIR_COMMAND_ENVELOPE_MISMATCH",
        )),
    }
}

pub(crate) fn required_permission_for_json_request(
    request: &RepairJsonRequest,
) -> Result<&'static str, RepairHookError> {
    match request {
        RepairJsonRequest::List { .. }
        | RepairJsonRequest::Workspace { .. }
        | RepairJsonRequest::Settings
        | RepairJsonRequest::Customers { .. }
        | RepairJsonRequest::CustomerDevices { .. }
        | RepairJsonRequest::PrintProjection { .. }
        | RepairJsonRequest::FinancialProjection { .. } => Ok("repairs.read"),
        RepairJsonRequest::Attachments { .. } => Ok("repairs.attachments"),
        RepairJsonRequest::CreateCustomerDevice { .. } => Ok("repairs.create"),
        RepairJsonRequest::Command { command, .. } => {
            Ok(required_permission_for_typed_command(command))
        }
        RepairJsonRequest::Settlement { .. } | RepairJsonRequest::Delivery { .. } => {
            Ok("repairs.update")
        }
        RepairJsonRequest::Payment { .. } => Ok("repairs.payments.collect"),
        RepairJsonRequest::Refund { .. } => Ok("repairs.payments.refund"),
        RepairJsonRequest::Fiscalize { .. } => Ok("repairs.fiscalize"),
        RepairJsonRequest::OfflineBootstrap {} => Err(RepairHookError::permanent(
            "REPAIR_OFFLINE_BOOTSTRAP_NATIVE_ONLY",
        )),
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairJsonTransportInput {
    pub(crate) staff_session_id: String,
    pub(crate) request: RepairJsonRequest,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum RepairJsonDisposition {
    Success {
        status: u16,
        data: Value,
    },
    Conflict {
        conflict: RepairConflictProjection,
    },
    SessionRequired {
        error: RepairBoundedError,
    },
    ModuleRequired {
        error: RepairBoundedError,
    },
    RateLimited {
        retry_after_seconds: i64,
    },
    PermanentFailure {
        status: u16,
        error: RepairBoundedError,
    },
    RetryableFailure {
        status: u16,
        error: RepairBoundedError,
    },
    MalformedResponse,
}

impl std::fmt::Debug for RepairJsonDisposition {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (kind, status) = match self {
            Self::Success { status, .. } => ("success", Some(*status)),
            Self::Conflict { .. } => ("conflict", Some(409)),
            Self::SessionRequired { .. } => ("session_required", None),
            Self::ModuleRequired { .. } => ("module_required", None),
            Self::RateLimited { .. } => ("rate_limited", Some(429)),
            Self::PermanentFailure { status, .. } => ("permanent_failure", Some(*status)),
            Self::RetryableFailure { status, .. } => ("retryable_failure", Some(*status)),
            Self::MalformedResponse => ("malformed_response", None),
        };
        formatter
            .debug_struct("RepairJsonDisposition")
            .field("kind", &kind)
            .field("status", &status)
            .finish()
    }
}

impl Serialize for RepairConflictProjection {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("RepairConflictProjection", 7)?;
        state.serialize_field("operation_id", &self.operation_id)?;
        state.serialize_field("repair_id", &self.repair_id)?;
        state.serialize_field("expected_version", &self.expected_version)?;
        state.serialize_field("current_version", &self.current_version)?;
        state.serialize_field("allowed_transitions", &self.allowed_transitions)?;
        state.serialize_field("summary", &RepairSafeSummarySerialize(&self.summary))?;
        state.end()
    }
}

struct RepairSafeSummarySerialize<'a>(&'a RepairSafeSummary);

impl Serialize for RepairSafeSummarySerialize<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("RepairSafeSummary", 4)?;
        state.serialize_field("display_number", &self.0.display_number)?;
        state.serialize_field("status", &self.0.status)?;
        state.serialize_field("version", &self.0.version)?;
        state.serialize_field("updated_at", &self.0.updated_at)?;
        state.end()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RepairJsonResponseShape {
    List,
    Workspace,
    Settings,
    OfflineBootstrap,
    Customers,
    CustomerDevices,
    CustomerDevice,
    Attachments,
    PrintProjection,
    FinancialProjection,
    CommandSignal,
    Settlement,
    Payment,
    Refund,
    Fiscalize,
    Delivery,
}

impl RepairJsonResponseShape {
    fn maximum_response_bytes(self) -> usize {
        if matches!(
            self,
            Self::Workspace | Self::CustomerDevices | Self::Attachments | Self::FinancialProjection
        ) {
            MAX_REPAIR_COLLECTION_RESPONSE_BYTES
        } else {
            MAX_REPAIR_RESPONSE_BYTES
        }
    }
}

#[derive(Clone)]
pub(crate) struct PreparedRepairJsonRequest {
    pub(crate) method: &'static str,
    pub(crate) path: String,
    pub(crate) body: Option<String>,
    pub(crate) expected_success_status: u16,
    response_shape: RepairJsonResponseShape,
    expected_repair_id: Option<String>,
    expected_customer_id: Option<String>,
    expected_device_id: Option<String>,
    expected_organization_id: String,
    expected_operation_id: Option<String>,
    expected_version: Option<u64>,
    expected_amount_minor: Option<u64>,
    expected_payment_id: Option<String>,
}

fn validate_online_identity(
    repair_id: &str,
    operation_id: &str,
    expected_version: u64,
    occurred_at: &str,
) -> Result<(), RepairHookError> {
    if canonical_uuid(repair_id).as_deref() != Some(repair_id)
        || canonical_uuid(operation_id).as_deref() != Some(operation_id)
        || expected_version > MAX_JAVASCRIPT_SAFE_INTEGER
        || occurred_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(occurred_at).is_err()
    {
        return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
    }
    Ok(())
}

fn valid_optional_trimmed(value: &Option<String>, maximum: usize) -> bool {
    value
        .as_deref()
        .map_or(true, |candidate| valid_utf16_length(candidate, maximum))
}

fn normalized_optional_text(
    value: &Option<String>,
    maximum: usize,
    empty_as_none: bool,
) -> Option<Option<String>> {
    let Some(value) = value.as_deref() else {
        return Some(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return empty_as_none.then_some(None);
    }
    (trimmed.encode_utf16().count() <= maximum).then(|| Some(trimmed.to_string()))
}

fn normalized_required_text(value: &str, maximum: usize) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed.encode_utf16().count() <= maximum).then(|| trimmed.to_string())
}

fn json_body(value: Value) -> Result<Option<String>, RepairHookError> {
    let body = serde_json::to_string(&value)
        .map_err(|_| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
    if body.len() > MAX_REPAIR_COMMAND_ENVELOPE_BYTES {
        return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_TOO_LARGE"));
    }
    Ok(Some(body))
}

fn money_body(
    session: &ValidatedRepairSession,
    repair_id: &str,
    operation_id: &str,
    expected_version: u64,
    occurred_at: &str,
    payload: Value,
) -> Result<Option<String>, RepairHookError> {
    validate_online_identity(repair_id, operation_id, expected_version, occurred_at)?;
    json_body(serde_json::json!({
        "operation_id": operation_id,
        "repair_id": repair_id,
        "expected_version": expected_version,
        "staff_session_id": session.staff_session_id(),
        "occurred_at": occurred_at,
        "payload": payload,
    }))
}

fn valid_repair_status_text(value: &str) -> bool {
    matches!(
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
}

fn valid_optional_uuid(value: &Option<String>) -> bool {
    value.as_deref().map_or(true, |candidate| {
        canonical_uuid(candidate).as_deref() == Some(candidate)
    })
}

fn valid_currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase())
}

fn valid_unsigned_decimal(value: &str, integer_digits: usize, decimal_digits: usize) -> bool {
    let mut parts = value.split('.');
    let integer = parts.next().unwrap_or_default();
    let decimal = parts.next();
    !integer.is_empty()
        && integer.len() <= integer_digits
        && integer.bytes().all(|byte| byte.is_ascii_digit())
        && parts.next().is_none()
        && decimal.map_or(true, |fraction| {
            !fraction.is_empty()
                && fraction.len() <= decimal_digits
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn valid_optional_timestamp(value: &Option<String>) -> bool {
    value.as_deref().map_or(true, |timestamp| {
        timestamp.len() <= 64 && chrono::DateTime::parse_from_rfc3339(timestamp).is_ok()
    })
}

fn valid_masked_offline_alias(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 4
        && parts[0] == "R"
        && parts[1] == "OFF"
        && parts[2].len() == 4
        && parts[2]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
        && parts[3].len() == 6
        && parts[3].bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_estimate_line(line: &RepairEstimateLineInput) -> bool {
    canonical_uuid(&line.id).as_deref() == Some(line.id.as_str())
        && valid_optional_uuid(&line.repair_line_id)
        && matches!(line.line_type.as_str(), "part" | "labour" | "charge")
        && valid_utf16_length(&line.description, 1_000)
        && valid_unsigned_decimal(&line.quantity, 9, 3)
        && valid_unsigned_decimal(&line.unit_price, 10, 4)
        && valid_unsigned_decimal(&line.tax_rate, 10, 4)
        && line.display_order <= 10_000
}

fn validate_typed_command(command: &RepairTypedCommand) -> bool {
    match command {
        RepairTypedCommand::CreateIntake {
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
            let standard = intake_mode == "standard";
            let valid_identity = if standard {
                !*is_anonymous && customer_id.is_some() && customer_device_id.is_some()
            } else if intake_mode == "quick_service" && *is_anonymous {
                customer_id.is_none() && customer_device_id.is_none()
            } else {
                intake_mode == "quick_service" && !*is_anonymous && customer_id.is_some()
            };
            valid_identity
                && valid_optional_uuid(customer_id)
                && valid_optional_uuid(customer_device_id)
                && matches!(priority.as_str(), "low" | "normal" | "high" | "urgent")
                && valid_currency(currency)
                && valid_optional_trimmed(title, 200)
                && valid_optional_trimmed(intake_notes, 5_000)
                && valid_optional_timestamp(due_at)
                && (offline_alias.is_some() == offline_sequence.is_some())
                && offline_alias
                    .as_deref()
                    .map_or(true, valid_masked_offline_alias)
                && offline_sequence.map_or(true, |sequence| (1..=999_999).contains(&sequence))
        }
        RepairTypedCommand::ReopenRepair { source_repair_id } => {
            canonical_uuid(source_repair_id).as_deref() == Some(source_repair_id)
        }
        RepairTypedCommand::AddNote { note, visibility } => {
            valid_utf16_length(note, 5_000)
                && matches!(visibility.as_str(), "internal" | "customer")
        }
        RepairTypedCommand::AssignRepair { assigned_staff_id } => {
            valid_optional_uuid(assigned_staff_id)
        }
        RepairTypedCommand::UpdateDiagnosis { diagnosis, .. } => {
            valid_optional_trimmed(diagnosis, 10_000)
        }
        RepairTypedCommand::PlanLine {
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
            canonical_uuid(line_id).as_deref() == Some(line_id)
                && matches!(line_type.as_str(), "part" | "labour" | "charge")
                && valid_utf16_length(name_snapshot, 255)
                && valid_optional_trimmed(sku_snapshot, 100)
                && valid_optional_trimmed(description, 1_000)
                && valid_unsigned_decimal(quantity, 9, 3)
                && unit_cost_snapshot
                    .as_deref()
                    .map_or(true, |value| valid_unsigned_decimal(value, 10, 4))
                && valid_unsigned_decimal(unit_price_snapshot, 10, 4)
                && valid_unsigned_decimal(vat_rate_snapshot, 10, 4)
                && valid_optional_uuid(retail_product_id)
                && valid_optional_uuid(retail_variant_id)
                && valid_optional_uuid(service_id)
                && *display_order <= 10_000
        }
        RepairTypedCommand::ConsumeNonstockPart { line_id }
        | RepairTypedCommand::ConsumeRepairPart { line_id } => {
            canonical_uuid(line_id).as_deref() == Some(line_id)
        }
        RepairTypedCommand::ReverseNonstockPart { line_id, reason } => {
            canonical_uuid(line_id).as_deref() == Some(line_id) && valid_utf16_length(reason, 1_000)
        }
        RepairTypedCommand::ReverseRepairPart {
            line_id,
            original_movement_id,
        } => {
            canonical_uuid(line_id).as_deref() == Some(line_id)
                && canonical_uuid(original_movement_id).as_deref() == Some(original_movement_id)
        }
        RepairTypedCommand::CreateEstimate {
            estimate_id,
            currency,
            discount_amount,
            valid_until,
            note,
            lines,
        } => {
            canonical_uuid(estimate_id).as_deref() == Some(estimate_id)
                && valid_currency(currency)
                && valid_unsigned_decimal(discount_amount, 10, 4)
                && valid_optional_timestamp(valid_until)
                && valid_optional_trimmed(note, 2_000)
                && !lines.is_empty()
                && lines.len() <= 100
                && lines.iter().all(valid_estimate_line)
        }
        RepairTypedCommand::RecordApproval {
            approval_id,
            estimate_id,
            decision,
            decision_source,
            reason,
        } => {
            let source_valid = matches!(
                decision_source.as_str(),
                "in_person"
                    | "phone"
                    | "email"
                    | "sms"
                    | "web"
                    | "external_message"
                    | "not_required"
            );
            let cross_fields = if decision_source == "not_required" {
                decision == "accepted" && estimate_id.is_none() && reason.is_some()
            } else {
                estimate_id.is_some()
            };
            canonical_uuid(approval_id).as_deref() == Some(approval_id)
                && valid_optional_uuid(estimate_id)
                && matches!(decision.as_str(), "accepted" | "rejected")
                && source_valid
                && valid_optional_trimmed(reason, 1_000)
                && cross_fields
        }
        RepairTypedCommand::TransitionStatus {
            target_status,
            reason,
            ..
        } => valid_repair_status_text(target_status) && valid_optional_trimmed(reason, 1_000),
        RepairTypedCommand::TransferBranch {
            destination_branch_id,
        } => canonical_uuid(destination_branch_id).as_deref() == Some(destination_branch_id),
    }
}

fn typed_command_parts(command: &RepairTypedCommand) -> Option<(&'static str, Value)> {
    if !validate_typed_command(command) {
        return None;
    }
    let value = serde_json::to_value(command).ok()?;
    let object = value.as_object()?;
    let name = object.get("command")?.as_str()?;
    let name = match name {
        "create_intake" => "create_intake",
        "reopen_repair" => "reopen_repair",
        "add_note" => "add_note",
        "assign_repair" => "assign_repair",
        "update_diagnosis" => "update_diagnosis",
        "plan_line" => "plan_line",
        "consume_nonstock_part" => "consume_nonstock_part",
        "reverse_nonstock_part" => "reverse_nonstock_part",
        "consume_repair_part" => "consume_repair_part",
        "reverse_repair_part" => "reverse_repair_part",
        "create_estimate" => "create_estimate",
        "record_approval" => "record_approval",
        "transition_status" => "transition_status",
        "transfer_branch" => "transfer_branch",
        _ => return None,
    };
    Some((name, object.get("payload")?.clone()))
}

pub(crate) fn prepare_repair_json_request(
    session: &ValidatedRepairSession,
    request: &RepairJsonRequest,
) -> Result<PreparedRepairJsonRequest, RepairHookError> {
    let required_permission = required_permission_for_json_request(request)?;
    if !session.has_permission(required_permission) {
        return Err(RepairHookError::permanent("REPAIR_PERMISSION_DENIED"));
    }
    let mut expected_repair_id = None;
    let mut expected_customer_id = None;
    let mut expected_device_id = None;
    let mut expected_operation_id = None;
    let mut expected_version = None;
    let mut expected_amount_minor = None;
    let mut expected_payment_id = None;
    let mut expected_success_status = 200;
    let (method, path, body, response_shape) = match request {
        RepairJsonRequest::List {
            status,
            search,
            limit,
            offset,
        } => {
            if *limit == 0
                || *limit > 50
                || *offset > 10_000
                || status
                    .as_deref()
                    .is_some_and(|value| !valid_repair_status_text(value))
                || search
                    .as_deref()
                    .is_some_and(|value| !valid_utf16_length(value, 80))
            {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            }
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            if let Some(status) = status {
                query.append_pair("status", status);
            }
            if let Some(search) = search {
                query.append_pair("search", search);
            }
            query.append_pair("limit", &limit.to_string());
            query.append_pair("offset", &offset.to_string());
            (
                "GET",
                format!("/api/pos/repairs?{}", query.finish()),
                None,
                RepairJsonResponseShape::List,
            )
        }
        RepairJsonRequest::Workspace { repair_id } => {
            let repair_id = canonical_uuid(repair_id)
                .filter(|canonical| canonical == repair_id)
                .ok_or_else(|| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
            expected_repair_id = Some(repair_id.clone());
            (
                "GET",
                format!("/api/pos/repairs/{repair_id}"),
                None,
                RepairJsonResponseShape::Workspace,
            )
        }
        RepairJsonRequest::Settings => (
            "GET",
            "/api/pos/repairs/settings".to_string(),
            None,
            RepairJsonResponseShape::Settings,
        ),
        RepairJsonRequest::OfflineBootstrap {} => (
            "POST",
            "/api/pos/repairs/offline-bootstrap".to_string(),
            json_body(serde_json::json!({}))?,
            RepairJsonResponseShape::OfflineBootstrap,
        ),
        RepairJsonRequest::Customers {
            search,
            limit,
            offset,
        } => {
            if search.encode_utf16().count() > 200
                || *limit == 0
                || *limit > 50
                || *offset > 100_000
            {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            }
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("search", search.trim());
            query.append_pair("limit", &limit.to_string());
            query.append_pair("offset", &offset.to_string());
            (
                "GET",
                format!("/api/pos/repairs/customers?{}", query.finish()),
                None,
                RepairJsonResponseShape::Customers,
            )
        }
        RepairJsonRequest::CustomerDevices { customer_id } => {
            let customer_id = canonical_uuid(customer_id)
                .filter(|canonical| canonical == customer_id)
                .ok_or_else(|| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
            expected_customer_id = Some(customer_id.clone());
            (
                "GET",
                format!("/api/pos/repairs/customers/{customer_id}/devices"),
                None,
                RepairJsonResponseShape::CustomerDevices,
            )
        }
        RepairJsonRequest::CreateCustomerDevice {
            customer_id,
            device_id,
            label,
            device_type,
            manufacturer,
            model,
            variant,
            storage_capacity,
            color,
        } => {
            let customer_id = canonical_uuid(customer_id)
                .filter(|canonical| canonical == customer_id)
                .ok_or_else(|| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
            expected_customer_id = Some(customer_id.clone());
            let Some(device_type) = normalized_required_text(device_type, 80) else {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            };
            let (
                Some(label),
                Some(manufacturer),
                Some(model),
                Some(variant),
                Some(storage_capacity),
                Some(color),
            ) = (
                normalized_optional_text(label, 120, false),
                normalized_optional_text(manufacturer, 120, true),
                normalized_optional_text(model, 120, true),
                normalized_optional_text(variant, 120, true),
                normalized_optional_text(storage_capacity, 80, true),
                normalized_optional_text(color, 80, true),
            )
            else {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            };
            if canonical_uuid(device_id).as_deref() != Some(device_id) {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            }
            expected_device_id = Some(device_id.clone());
            let body = json_body(serde_json::json!({
                "device_id": device_id,
                "label": label,
                "device_type": device_type,
                "manufacturer": manufacturer,
                "model": model,
                "variant": variant,
                "storage_capacity": storage_capacity,
                "color": color,
            }))?;
            expected_success_status = 201;
            (
                "POST",
                format!("/api/pos/repairs/customers/{customer_id}/devices"),
                body,
                RepairJsonResponseShape::CustomerDevice,
            )
        }
        RepairJsonRequest::Attachments { repair_id }
        | RepairJsonRequest::PrintProjection { repair_id } => {
            let repair_id = canonical_uuid(repair_id)
                .filter(|canonical| canonical == repair_id)
                .ok_or_else(|| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
            expected_repair_id = Some(repair_id.clone());
            let (suffix, shape) = if matches!(request, RepairJsonRequest::Attachments { .. }) {
                ("attachments", RepairJsonResponseShape::Attachments)
            } else {
                ("print-projection", RepairJsonResponseShape::PrintProjection)
            };
            (
                "GET",
                format!("/api/pos/repairs/{repair_id}/{suffix}"),
                None,
                shape,
            )
        }
        RepairJsonRequest::FinancialProjection { repair_id } => {
            let repair_id = canonical_uuid(repair_id)
                .filter(|canonical| canonical == repair_id)
                .ok_or_else(|| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
            expected_repair_id = Some(repair_id.clone());
            (
                "GET",
                format!("/api/pos/repairs/{repair_id}/settlement"),
                None,
                RepairJsonResponseShape::FinancialProjection,
            )
        }
        RepairJsonRequest::Command {
            repair_id,
            operation_id,
            expected_version: version,
            occurred_at,
            command,
        } => {
            validate_online_identity(repair_id, operation_id, *version, occurred_at)?;
            let (command_name, payload) = typed_command_parts(command)
                .ok_or_else(|| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
            expected_repair_id = Some(repair_id.clone());
            expected_operation_id = Some(operation_id.clone());
            expected_version = Some(*version);
            let body = json_body(serde_json::json!({
                "operation_id": operation_id,
                "repair_id": repair_id,
                "expected_version": version,
                "staff_session_id": session.staff_session_id(),
                "command": command_name,
                "payload": payload,
                "occurred_at": occurred_at,
            }))?;
            let root_command = matches!(
                command,
                RepairTypedCommand::CreateIntake { .. } | RepairTypedCommand::ReopenRepair { .. }
            );
            if root_command {
                expected_success_status = 201;
            }
            (
                "POST",
                if root_command {
                    "/api/pos/repairs".to_string()
                } else {
                    format!("/api/pos/repairs/{repair_id}/commands")
                },
                body,
                RepairJsonResponseShape::CommandSignal,
            )
        }
        RepairJsonRequest::Settlement {
            repair_id,
            operation_id,
            expected_version: version,
            occurred_at,
        }
        | RepairJsonRequest::Fiscalize {
            repair_id,
            operation_id,
            expected_version: version,
            occurred_at,
        } => {
            expected_repair_id = Some(repair_id.clone());
            expected_operation_id = Some(operation_id.clone());
            expected_version = Some(*version);
            let (suffix, shape) = if matches!(request, RepairJsonRequest::Settlement { .. }) {
                ("settlement", RepairJsonResponseShape::Settlement)
            } else {
                ("fiscalize", RepairJsonResponseShape::Fiscalize)
            };
            (
                "POST",
                format!("/api/pos/repairs/{repair_id}/{suffix}"),
                money_body(
                    session,
                    repair_id,
                    operation_id,
                    *version,
                    occurred_at,
                    serde_json::json!({}),
                )?,
                shape,
            )
        }
        RepairJsonRequest::Payment {
            repair_id,
            operation_id,
            expected_version: version,
            occurred_at,
            amount_minor,
            payment_method,
            provider_reference,
        } => {
            if *amount_minor == 0
                || *amount_minor > 999_999_999_999
                || !matches!(
                    payment_method.as_str(),
                    "cash" | "card" | "digital_wallet" | "other"
                )
                || provider_reference.as_deref().is_some_and(|reference| {
                    !valid_utf16_length(reference, 200)
                        || !reference
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
                })
            {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            }
            expected_repair_id = Some(repair_id.clone());
            expected_operation_id = Some(operation_id.clone());
            expected_version = Some(*version);
            expected_amount_minor = Some(*amount_minor);
            (
                "POST",
                format!("/api/pos/repairs/{repair_id}/payments"),
                money_body(
                    session,
                    repair_id,
                    operation_id,
                    *version,
                    occurred_at,
                    serde_json::json!({
                        "amount_minor": amount_minor,
                        "payment_method": payment_method,
                        "provider_reference": provider_reference,
                    }),
                )?,
                RepairJsonResponseShape::Payment,
            )
        }
        RepairJsonRequest::Refund {
            repair_id,
            operation_id,
            expected_version: version,
            occurred_at,
            payment_id,
            amount_minor,
            refund_method,
            reason,
        } => {
            if canonical_uuid(payment_id).as_deref() != Some(payment_id)
                || *amount_minor == 0
                || *amount_minor > 999_999_999_999
                || !matches!(refund_method.as_str(), "cash" | "card")
                || !valid_utf16_length(reason, 1_000)
            {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            }
            expected_repair_id = Some(repair_id.clone());
            expected_operation_id = Some(operation_id.clone());
            expected_version = Some(*version);
            expected_amount_minor = Some(*amount_minor);
            expected_payment_id = Some(payment_id.clone());
            (
                "POST",
                format!("/api/pos/repairs/{repair_id}/refunds"),
                money_body(
                    session,
                    repair_id,
                    operation_id,
                    *version,
                    occurred_at,
                    serde_json::json!({
                        "payment_id": payment_id,
                        "amount_minor": amount_minor,
                        "refund_method": refund_method,
                        "reason": reason,
                    }),
                )?,
                RepairJsonResponseShape::Refund,
            )
        }
        RepairJsonRequest::Delivery {
            repair_id,
            operation_id,
            expected_version: version,
            occurred_at,
            reason,
        } => {
            if !valid_optional_trimmed(reason, 1_000) {
                return Err(RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"));
            }
            expected_repair_id = Some(repair_id.clone());
            expected_operation_id = Some(operation_id.clone());
            expected_version = Some(*version);
            (
                "POST",
                format!("/api/pos/repairs/{repair_id}/delivery"),
                money_body(
                    session,
                    repair_id,
                    operation_id,
                    *version,
                    occurred_at,
                    serde_json::json!({ "reason": reason }),
                )?,
                RepairJsonResponseShape::Delivery,
            )
        }
    };
    Ok(PreparedRepairJsonRequest {
        method,
        path,
        body,
        expected_success_status,
        response_shape,
        expected_repair_id,
        expected_customer_id,
        expected_device_id,
        expected_organization_id: session.organization_id().to_string(),
        expected_operation_id,
        expected_version,
        expected_amount_minor,
        expected_payment_id,
    })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairJsonSignal {
    repair_id: String,
    status: RepairStatus,
    version: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairOfflineBootstrapResponse {
    offline_terminal_token: String,
    offline_sequence_lease_start: u64,
    offline_sequence_lease_end: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairReportingProjection {
    source: String,
    staff_shift_id: String,
    projection_version: u64,
    projected_at: String,
    overall_tender: f64,
    overall_cash: f64,
    overall_card: f64,
    overall_orders_count: u64,
    repair_tender: f64,
    repair_cash: f64,
    repair_card: f64,
    repair_orders_count: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairPaymentResponse {
    repair_id: String,
    order_id: String,
    payment_id: String,
    amount_minor: u64,
    balance_minor: u64,
    payment_status: String,
    fiscal_purpose: Option<String>,
    event_id: String,
    resulting_version: u64,
    was_replay: bool,
    reporting_shift_id: Option<String>,
    reporting_projection: Option<RawRepairReportingProjection>,
    repair: RawRepairJsonSignal,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairSettlementResponse {
    repair_id: String,
    order_id: String,
    settlement_role: String,
    estimate_id: String,
    estimate_version: u64,
    total_minor: i64,
    currency: String,
    fiscal_state: String,
    event_id: String,
    resulting_version: u64,
    was_replay: bool,
    repair: RawRepairJsonSignal,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairRefundResponse {
    repair_id: String,
    order_id: String,
    payment_id: String,
    adjustment_id: String,
    amount_minor: u64,
    balance_minor: u64,
    fiscal_purpose: Option<String>,
    event_id: String,
    resulting_version: u64,
    was_replay: bool,
    reporting_shift_id: Option<String>,
    reporting_projection: Option<RawRepairReportingProjection>,
    repair: RawRepairJsonSignal,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairFiscalizeResponse {
    repair_id: String,
    order_id: String,
    fiscal_command_id: String,
    fiscal_state: String,
    event_id: String,
    resulting_version: u64,
    was_replay: bool,
    repair: RawRepairJsonSignal,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairDeliveryResponse {
    repair_id: String,
    status: RepairStatus,
    balance_minor: u64,
    #[serde(rename = "override")]
    balance_override: bool,
    event_id: String,
    resulting_version: u64,
    was_replay: bool,
    repair: RawRepairJsonSignal,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairFinancialOrder {
    id: String,
    order_number: Option<String>,
    role: String,
    fiscal_state: String,
    payment_status: String,
    total_minor: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairFinancialPayment {
    id: String,
    order_id: String,
    payment_method: String,
    amount_minor: u64,
    refunded_minor: u64,
    refundable_minor: u64,
    status: String,
    created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairFinancialAdjustment {
    id: String,
    order_id: String,
    payment_id: String,
    adjustment_type: String,
    amount_minor: u64,
    refund_method: String,
    created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairFinancialFiscalCommand {
    id: String,
    order_id: String,
    purpose: String,
    amount_minor: u64,
    status: String,
    attempt_count: u64,
    occurred_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawRepairFinancialProjection {
    repair_id: String,
    currency: String,
    total_minor: u64,
    paid_minor: u64,
    refunded_minor: u64,
    balance_minor: u64,
    orders: Vec<RawRepairFinancialOrder>,
    payments: Vec<RawRepairFinancialPayment>,
    adjustments: Vec<RawRepairFinancialAdjustment>,
    fiscal_commands: Vec<RawRepairFinancialFiscalCommand>,
}

fn bounded_financial_text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= maximum
}

fn classify_financial_projection_success(
    body: &[u8],
    prepared: &PreparedRepairJsonRequest,
) -> Option<Value> {
    let response: RawRepairFinancialProjection = serde_json::from_slice(body).ok()?;
    let expected_repair_id = prepared.expected_repair_id.as_deref()?;
    if canonical_uuid(&response.repair_id).as_deref() != Some(expected_repair_id)
        || !valid_currency(&response.currency)
        || response.total_minor > MAX_JAVASCRIPT_SAFE_INTEGER
        || response.paid_minor > MAX_JAVASCRIPT_SAFE_INTEGER
        || response.refunded_minor > MAX_JAVASCRIPT_SAFE_INTEGER
        || response.balance_minor > MAX_JAVASCRIPT_SAFE_INTEGER
        || response.orders.len() > 100
        || response.payments.len() > 500
        || response.adjustments.len() > 500
        || response.fiscal_commands.len() > 500
    {
        return None;
    }

    let mut order_ids = HashSet::with_capacity(response.orders.len());
    let mut signed_total: i128 = 0;
    for order in &response.orders {
        if canonical_uuid(&order.id).as_deref() != Some(order.id.as_str())
            || !order_ids.insert(order.id.as_str())
            || order
                .order_number
                .as_deref()
                .is_some_and(|value| !bounded_financial_text(value, 128))
            || !matches!(order.role.as_str(), "primary" | "supplement" | "credit")
            || !matches!(
                order.fiscal_state.as_str(),
                "deferred"
                    | "issue_pending"
                    | "issued"
                    | "unknown"
                    | "issue_failed"
                    | "correction_pending"
                    | "cancelled"
                    | "recognized_non_fiscal"
            )
            || !bounded_financial_text(&order.payment_status, 48)
            || order.total_minor > MAX_JAVASCRIPT_SAFE_INTEGER
        {
            return None;
        }
        let amount = i128::from(order.total_minor);
        signed_total = if order.role == "credit" {
            signed_total.checked_sub(amount)?
        } else {
            signed_total.checked_add(amount)?
        };
    }

    let mut payments = HashMap::with_capacity(response.payments.len());
    let mut paid_total: u128 = 0;
    for payment in &response.payments {
        if canonical_uuid(&payment.id).as_deref() != Some(payment.id.as_str())
            || canonical_uuid(&payment.order_id).as_deref() != Some(payment.order_id.as_str())
            || !order_ids.contains(payment.order_id.as_str())
            || payments
                .insert(
                    payment.id.as_str(),
                    (payment.order_id.as_str(), payment.refunded_minor),
                )
                .is_some()
            || !bounded_financial_text(&payment.payment_method, 48)
            || payment.amount_minor == 0
            || payment.amount_minor > MAX_JAVASCRIPT_SAFE_INTEGER
            || payment.refunded_minor > payment.amount_minor
            || payment.refundable_minor > MAX_JAVASCRIPT_SAFE_INTEGER
            || !bounded_financial_text(&payment.status, 48)
            || chrono::DateTime::parse_from_rfc3339(&payment.created_at).is_err()
        {
            return None;
        }
        let expected_refundable = if payment.status == "completed" {
            payment.amount_minor - payment.refunded_minor
        } else {
            0
        };
        if payment.refundable_minor != expected_refundable {
            return None;
        }
        if payment.status == "completed" {
            paid_total = paid_total.checked_add(u128::from(payment.amount_minor))?;
        }
    }

    let mut adjustment_ids = HashSet::with_capacity(response.adjustments.len());
    let mut refunded_by_payment: HashMap<&str, u128> = HashMap::new();
    let mut refunded_total: u128 = 0;
    for adjustment in &response.adjustments {
        let (payment_order_id, _) = payments.get(adjustment.payment_id.as_str())?;
        if canonical_uuid(&adjustment.id).as_deref() != Some(adjustment.id.as_str())
            || canonical_uuid(&adjustment.order_id).as_deref() != Some(adjustment.order_id.as_str())
            || canonical_uuid(&adjustment.payment_id).as_deref()
                != Some(adjustment.payment_id.as_str())
            || !adjustment_ids.insert(adjustment.id.as_str())
            || *payment_order_id != adjustment.order_id
            || !matches!(adjustment.adjustment_type.as_str(), "void" | "refund")
            || adjustment.amount_minor == 0
            || adjustment.amount_minor > MAX_JAVASCRIPT_SAFE_INTEGER
            || !matches!(adjustment.refund_method.as_str(), "cash" | "card")
            || chrono::DateTime::parse_from_rfc3339(&adjustment.created_at).is_err()
        {
            return None;
        }
        let entry = refunded_by_payment
            .entry(adjustment.payment_id.as_str())
            .or_default();
        *entry = entry.checked_add(u128::from(adjustment.amount_minor))?;
        refunded_total = refunded_total.checked_add(u128::from(adjustment.amount_minor))?;
    }
    if payments.iter().any(|(payment_id, (_, refunded_minor))| {
        refunded_by_payment.get(payment_id).copied().unwrap_or(0) != u128::from(*refunded_minor)
    }) {
        return None;
    }

    let mut fiscal_command_ids = HashSet::with_capacity(response.fiscal_commands.len());
    for command in &response.fiscal_commands {
        if canonical_uuid(&command.id).as_deref() != Some(command.id.as_str())
            || canonical_uuid(&command.order_id).as_deref() != Some(command.order_id.as_str())
            || !order_ids.contains(command.order_id.as_str())
            || !fiscal_command_ids.insert(command.id.as_str())
            || !matches!(
                command.purpose.as_str(),
                "sale" | "deposit" | "supplement" | "credit" | "cancel"
            )
            || command.amount_minor == 0
            || command.amount_minor > MAX_JAVASCRIPT_SAFE_INTEGER
            || !bounded_financial_text(&command.status, 48)
            || command.attempt_count > 1_000_000
            || chrono::DateTime::parse_from_rfc3339(&command.occurred_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&command.updated_at).is_err()
        {
            return None;
        }
    }

    if signed_total < 0
        || signed_total > i128::from(MAX_JAVASCRIPT_SAFE_INTEGER)
        || paid_total > u128::from(MAX_JAVASCRIPT_SAFE_INTEGER)
        || refunded_total > u128::from(MAX_JAVASCRIPT_SAFE_INTEGER)
    {
        return None;
    }
    let balance = signed_total
        .checked_sub(i128::try_from(paid_total).ok()?)?
        .checked_add(i128::try_from(refunded_total).ok()?)?
        .max(0);
    let signed_total = u128::try_from(signed_total).ok()?;
    if response.total_minor != u64::try_from(signed_total).ok()?
        || response.paid_minor != u64::try_from(paid_total).ok()?
        || response.refunded_minor != u64::try_from(refunded_total).ok()?
        || response.balance_minor != u64::try_from(balance).ok()?
    {
        return None;
    }
    serde_json::to_value(response).ok()
}

fn valid_reporting_projection(
    projection: &RawRepairReportingProjection,
    shift_id: Option<&str>,
) -> bool {
    projection.source == "repair_canonical_tender_projection_v1"
        && canonical_uuid(&projection.staff_shift_id).as_deref()
            == Some(projection.staff_shift_id.as_str())
        && shift_id == Some(projection.staff_shift_id.as_str())
        && projection.projection_version > 0
        && projection.projection_version <= MAX_JAVASCRIPT_SAFE_INTEGER
        && chrono::DateTime::parse_from_rfc3339(&projection.projected_at).is_ok()
        && [
            projection.overall_tender,
            projection.overall_cash,
            projection.overall_card,
            projection.repair_tender,
            projection.repair_cash,
            projection.repair_card,
        ]
        .iter()
        .all(|value| value.is_finite())
        && projection.overall_orders_count <= MAX_JAVASCRIPT_SAFE_INTEGER
        && projection.repair_orders_count <= MAX_JAVASCRIPT_SAFE_INTEGER
}

fn classify_payment_success(body: &[u8], prepared: &PreparedRepairJsonRequest) -> Option<Value> {
    let object = serde_json::from_slice::<Value>(body).ok()?;
    let keys = object.as_object()?;
    if !keys.contains_key("reporting_shift_id")
        || !keys.contains_key("reporting_projection")
        || !keys.contains_key("fiscal_purpose")
    {
        return None;
    }
    let response: RawRepairPaymentResponse = serde_json::from_value(object).ok()?;
    let shift_id = response.reporting_shift_id.as_deref();
    if !validate_money_common(
        &response.repair_id,
        &response.event_id,
        response.resulting_version,
        &response.repair,
        prepared,
    ) || canonical_uuid(&response.order_id).as_deref() != Some(response.order_id.as_str())
        || canonical_uuid(&response.payment_id).as_deref() != Some(response.payment_id.as_str())
        || Some(response.amount_minor) != prepared.expected_amount_minor
        || response.amount_minor == 0
        || response.amount_minor > 999_999_999_999
        || response.balance_minor > 999_999_999_999
        || !matches!(response.payment_status.as_str(), "paid" | "partially_paid")
        || response
            .fiscal_purpose
            .as_deref()
            .is_some_and(|purpose| !matches!(purpose, "deposit" | "sale"))
        || shift_id.is_some_and(|id| canonical_uuid(id).as_deref() != Some(id))
        || response
            .reporting_projection
            .as_ref()
            .is_some_and(|projection| !valid_reporting_projection(projection, shift_id))
    {
        return None;
    }
    serde_json::to_value(response).ok()
}

fn validate_money_common(
    repair_id: &str,
    event_id: &str,
    resulting_version: u64,
    signal: &RawRepairJsonSignal,
    prepared: &PreparedRepairJsonRequest,
) -> bool {
    let Some(expected_repair_id) = prepared.expected_repair_id.as_deref() else {
        return false;
    };
    let Some(expected_version) = prepared.expected_version else {
        return false;
    };
    canonical_uuid(repair_id).as_deref() == Some(expected_repair_id)
        && canonical_uuid(event_id).is_some()
        && expected_version.checked_add(1) == Some(resulting_version)
        && resulting_version > 0
        && resulting_version <= MAX_JAVASCRIPT_SAFE_INTEGER
        && canonical_uuid(&signal.repair_id).as_deref() == Some(expected_repair_id)
        && signal.version >= resulting_version
        && signal.version <= MAX_JAVASCRIPT_SAFE_INTEGER
}

fn classify_settlement_success(body: &[u8], prepared: &PreparedRepairJsonRequest) -> Option<Value> {
    let response: RawRepairSettlementResponse = serde_json::from_slice(body).ok()?;
    if !validate_money_common(
        &response.repair_id,
        &response.event_id,
        response.resulting_version,
        &response.repair,
        prepared,
    ) || canonical_uuid(&response.order_id).is_none()
        || canonical_uuid(&response.estimate_id).is_none()
        || response.estimate_version == 0
        || response.estimate_version > MAX_JAVASCRIPT_SAFE_INTEGER
        || response.total_minor.unsigned_abs() > 999_999_999_999
        || !matches!(
            response.settlement_role.as_str(),
            "primary" | "supplement" | "credit"
        )
        || (response.settlement_role == "credit" && response.total_minor > 0)
        || (response.settlement_role != "credit" && response.total_minor < 0)
        || !valid_currency(&response.currency)
        || !matches!(
            response.fiscal_state.as_str(),
            "deferred" | "correction_pending"
        )
    {
        return None;
    }
    serde_json::to_value(response).ok()
}

fn classify_refund_success(body: &[u8], prepared: &PreparedRepairJsonRequest) -> Option<Value> {
    let raw: Value = serde_json::from_slice(body).ok()?;
    let object = raw.as_object()?;
    if !object.contains_key("fiscal_purpose")
        || !object.contains_key("reporting_shift_id")
        || !object.contains_key("reporting_projection")
    {
        return None;
    }
    let response: RawRepairRefundResponse = serde_json::from_value(raw).ok()?;
    let shift_id = response.reporting_shift_id.as_deref();
    if !validate_money_common(
        &response.repair_id,
        &response.event_id,
        response.resulting_version,
        &response.repair,
        prepared,
    ) || canonical_uuid(&response.order_id).is_none()
        || canonical_uuid(&response.payment_id).is_none()
        || prepared.expected_payment_id.as_deref() != Some(response.payment_id.as_str())
        || canonical_uuid(&response.adjustment_id).is_none()
        || Some(response.amount_minor) != prepared.expected_amount_minor
        || response.amount_minor == 0
        || response.amount_minor > 999_999_999_999
        || response.balance_minor > 999_999_999_999
        || response
            .fiscal_purpose
            .as_deref()
            .is_some_and(|purpose| !matches!(purpose, "cancel" | "credit"))
        || shift_id.is_some_and(|id| canonical_uuid(id).as_deref() != Some(id))
        || response
            .reporting_projection
            .as_ref()
            .is_some_and(|projection| !valid_reporting_projection(projection, shift_id))
    {
        return None;
    }
    serde_json::to_value(response).ok()
}

fn classify_fiscalize_success(body: &[u8], prepared: &PreparedRepairJsonRequest) -> Option<Value> {
    let response: RawRepairFiscalizeResponse = serde_json::from_slice(body).ok()?;
    if !validate_money_common(
        &response.repair_id,
        &response.event_id,
        response.resulting_version,
        &response.repair,
        prepared,
    ) || canonical_uuid(&response.order_id).is_none()
        || canonical_uuid(&response.fiscal_command_id).is_none()
        || response.fiscal_state != "issue_pending"
    {
        return None;
    }
    serde_json::to_value(response).ok()
}

fn classify_delivery_success(body: &[u8], prepared: &PreparedRepairJsonRequest) -> Option<Value> {
    let response: RawRepairDeliveryResponse = serde_json::from_slice(body).ok()?;
    if !validate_money_common(
        &response.repair_id,
        &response.event_id,
        response.resulting_version,
        &response.repair,
        prepared,
    ) || response.status != RepairStatus::Delivered
        || response.repair.status != RepairStatus::Delivered
        || response.balance_minor > 999_999_999_999
    {
        return None;
    }
    serde_json::to_value(response).ok()
}

fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    let object = value.as_object()?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return None;
    }
    Some(object)
}

fn json_string(value: Option<&Value>, minimum: usize, maximum: usize, trimmed: bool) -> bool {
    let Some(value) = value.and_then(Value::as_str) else {
        return false;
    };
    let length = value.encode_utf16().count();
    length >= minimum
        && length <= maximum
        && (!trimmed || value.trim() == value)
        && (!trimmed || minimum == 0 || !value.is_empty())
}

fn json_nullable_string(
    value: Option<&Value>,
    minimum: usize,
    maximum: usize,
    trimmed: bool,
) -> bool {
    value
        .is_some_and(|value| value.is_null() || json_string(Some(value), minimum, maximum, trimmed))
}

fn json_uuid(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| canonical_uuid(value).as_deref() == Some(value))
}

fn json_nullable_uuid(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.is_null() || json_uuid(Some(value)))
}

fn json_timestamp(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        value.len() <= 64 && chrono::DateTime::parse_from_rfc3339(value).is_ok()
    })
}

fn json_nullable_timestamp(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.is_null() || json_timestamp(Some(value)))
}

fn json_u64(value: Option<&Value>, minimum: u64, maximum: u64) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|number| (minimum..=maximum).contains(&number))
}

fn json_finite(value: Option<&Value>, minimum: f64, maximum: f64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number.is_finite() && number >= minimum && number <= maximum)
}

fn json_bool(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).is_some()
}

fn json_enum(value: Option<&Value>, allowed: &[&str]) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|candidate| allowed.contains(&candidate))
}

fn validate_pagination(value: &Value, maximum_limit: u64, maximum_offset: u64) -> bool {
    let Some(object) = exact_object(value, &["count", "limit", "offset"], &[]) else {
        return false;
    };
    json_u64(object.get("count"), 0, MAX_JAVASCRIPT_SAFE_INTEGER)
        && json_u64(object.get("limit"), 1, maximum_limit)
        && json_u64(object.get("offset"), 0, maximum_offset)
}

fn validate_capabilities(value: &Value) -> bool {
    const KEYS: &[&str] = &[
        "read",
        "create",
        "update",
        "assign",
        "approve",
        "overrideApproval",
        "planParts",
        "consumeParts",
        "transfer",
        "cancel",
        "manageAttachments",
        "collectPayments",
        "refundPayments",
        "fiscalize",
        "overrideDeliveryBalance",
    ];
    exact_object(value, KEYS, &[])
        .is_some_and(|object| KEYS.iter().all(|key| json_bool(object.get(*key))))
}

fn validate_list_repair(value: &Value) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "display_number",
            "status",
            "priority",
            "title",
            "intake_mode",
            "is_anonymous",
            "assigned_staff_id",
            "due_at",
            "completed_at",
            "version",
            "created_at",
            "updated_at",
        ],
        &[],
    ) else {
        return false;
    };
    json_uuid(object.get("id"))
        && json_nullable_string(object.get("display_number"), 1, 80, true)
        && json_enum(
            object.get("status"),
            &[
                "received",
                "diagnosing",
                "waiting_customer_approval",
                "approved",
                "waiting_parts",
                "repairing",
                "quality_check",
                "ready",
                "delivered",
                "cancelled",
                "unrepairable",
            ],
        )
        && json_enum(object.get("priority"), &["low", "normal", "high", "urgent"])
        && json_nullable_string(object.get("title"), 1, 200, true)
        && json_enum(object.get("intake_mode"), &["standard", "quick_service"])
        && json_bool(object.get("is_anonymous"))
        && json_nullable_uuid(object.get("assigned_staff_id"))
        && json_nullable_timestamp(object.get("due_at"))
        && json_nullable_timestamp(object.get("completed_at"))
        && json_u64(object.get("version"), 1, MAX_JAVASCRIPT_SAFE_INTEGER)
        && json_timestamp(object.get("created_at"))
        && json_timestamp(object.get("updated_at"))
}

fn validate_list_success(body: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let object = exact_object(&value, &["repairs", "pagination"], &[])?;
    let repairs = object.get("repairs")?.as_array()?;
    if repairs.len() > 50
        || !repairs.iter().all(validate_list_repair)
        || !validate_pagination(object.get("pagination")?, 50, 10_000)
    {
        return None;
    }
    Some(value)
}

fn validate_device(value: &Value, organization_id: &str, customer_id: Option<&str>) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "organization_id",
            "customer_id",
            "label",
            "device_type",
            "manufacturer",
            "model",
            "variant",
            "storage_capacity",
            "color",
            "serial_masked",
            "imei_masked",
            "created_at",
            "updated_at",
        ],
        &[],
    ) else {
        return false;
    };
    let masked = |field: Option<&Value>| {
        field.is_some_and(|value| {
            value.is_null()
                || value.as_str().is_some_and(|masked| {
                    let suffix = masked.strip_prefix("•••• ");
                    (2..=4).contains(&suffix.map(str::len).unwrap_or_default())
                        && suffix.is_some_and(|suffix| {
                            suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
                        })
                })
        })
    };
    json_uuid(object.get("id"))
        && object.get("organization_id").and_then(Value::as_str) == Some(organization_id)
        && json_uuid(object.get("organization_id"))
        && json_uuid(object.get("customer_id"))
        && customer_id.map_or(true, |expected| {
            object.get("customer_id").and_then(Value::as_str) == Some(expected)
        })
        && json_nullable_string(object.get("label"), 1, 120, true)
        && json_string(object.get("device_type"), 1, 80, true)
        && json_nullable_string(object.get("manufacturer"), 0, 120, true)
        && json_nullable_string(object.get("model"), 0, 120, true)
        && json_nullable_string(object.get("variant"), 0, 120, true)
        && json_nullable_string(object.get("storage_capacity"), 0, 80, true)
        && json_nullable_string(object.get("color"), 0, 80, true)
        && masked(object.get("serial_masked"))
        && masked(object.get("imei_masked"))
        && json_timestamp(object.get("created_at"))
        && json_timestamp(object.get("updated_at"))
}

fn validate_workspace_header(value: &Value, expected_repair_id: &str) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "display_number",
            "status",
            "priority",
            "title",
            "intake_mode",
            "is_anonymous",
            "assigned_staff_id",
            "due_at",
            "completed_at",
            "delivered_at",
            "version",
            "created_at",
            "updated_at",
            "customer_id",
            "customer_device_id",
            "intake_notes",
            "diagnosis",
            "currency",
            "origin_branch_id",
            "reopened_from_repair_id",
        ],
        &[],
    ) else {
        return false;
    };
    object.get("id").and_then(Value::as_str) == Some(expected_repair_id)
        && validate_list_repair(&serde_json::json!({
            "id": object.get("id"),
            "display_number": object.get("display_number"),
            "status": object.get("status"),
            "priority": object.get("priority"),
            "title": object.get("title"),
            "intake_mode": object.get("intake_mode"),
            "is_anonymous": object.get("is_anonymous"),
            "assigned_staff_id": object.get("assigned_staff_id"),
            "due_at": object.get("due_at"),
            "completed_at": object.get("completed_at"),
            "version": object.get("version"),
            "created_at": object.get("created_at"),
            "updated_at": object.get("updated_at"),
        }))
        && json_nullable_timestamp(object.get("delivered_at"))
        && json_nullable_uuid(object.get("customer_id"))
        && json_nullable_uuid(object.get("customer_device_id"))
        && json_nullable_string(object.get("intake_notes"), 0, 5_000, false)
        && json_nullable_string(object.get("diagnosis"), 0, 10_000, false)
        && object
            .get("currency")
            .and_then(Value::as_str)
            .is_some_and(valid_currency)
        && json_uuid(object.get("origin_branch_id"))
        && json_nullable_uuid(object.get("reopened_from_repair_id"))
}

fn validate_workspace_line(value: &Value) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "line_type",
            "name_snapshot",
            "sku_snapshot",
            "description",
            "quantity",
            "unit_price_snapshot",
            "vat_rate_snapshot",
            "retail_product_id",
            "retail_variant_id",
            "service_id",
            "part_state",
            "display_order",
            "aggregate_version",
            "created_at",
            "updated_at",
        ],
        &[],
    ) else {
        return false;
    };
    json_uuid(object.get("id"))
        && json_enum(object.get("line_type"), &["part", "labour", "charge"])
        && json_string(object.get("name_snapshot"), 1, 255, true)
        && json_nullable_string(object.get("sku_snapshot"), 1, 100, true)
        && json_nullable_string(object.get("description"), 1, 1_000, true)
        && json_finite(object.get("quantity"), f64::MIN_POSITIVE, f64::MAX)
        && json_finite(object.get("unit_price_snapshot"), 0.0, f64::MAX)
        && json_finite(object.get("vat_rate_snapshot"), 0.0, 100.0)
        && json_nullable_uuid(object.get("retail_product_id"))
        && json_nullable_uuid(object.get("retail_variant_id"))
        && json_nullable_uuid(object.get("service_id"))
        && object.get("part_state").is_some_and(|state| {
            state.is_null() || json_enum(Some(state), &["planned", "consumed", "reversed"])
        })
        && json_u64(object.get("display_order"), 0, MAX_JAVASCRIPT_SAFE_INTEGER)
        && json_u64(
            object.get("aggregate_version"),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
        )
        && json_timestamp(object.get("created_at"))
        && json_timestamp(object.get("updated_at"))
}

fn event_payload_keys(event_type: &str) -> Option<&'static [&'static str]> {
    Some(match event_type {
        "created" => &[
            "repair_id",
            "intake_mode",
            "status",
            "number_branch_id",
            "official_number",
            "number_reservation_id",
        ],
        "reopened" => &[
            "repair_id",
            "intake_mode",
            "status",
            "source_repair_id",
            "official_number",
            "number_reservation_id",
        ],
        "note_added" => &[
            "note",
            "visibility",
            "official_number",
            "alias_number",
            "number_branch_id",
        ],
        "assignment_changed" => &["assigned_staff_id"],
        "diagnosis_updated" => &["diagnosis", "draft"],
        "line_changed" => &["line_id", "part_state"],
        "part_consumed" => &["repair_line_id", "movement_id"],
        "part_reversed" => &[
            "repair_line_id",
            "original_movement_id",
            "movement_id",
            "reason",
        ],
        "estimate_created" => &["estimate_id"],
        "approval_recorded" => &[
            "approval_id",
            "estimate_id",
            "estimate_version",
            "decision",
            "decision_source",
            "reason",
            "currency",
            "approved_total_amount",
        ],
        "attachment_added" => &["attachment_id"],
        "attachment_retention_changed" => &[
            "attachment_id",
            "from_retention_state",
            "to_retention_state",
        ],
        "settlement_linked" => &[
            "kind",
            "order_id",
            "estimate_id",
            "estimate_version",
            "role",
            "payment_id",
            "adjustment_id",
            "amount_minor",
            "net_paid_after_minor",
            "fiscal_purpose",
            "command_id",
            "purpose",
        ],
        "status_changed" => &[
            "from_status",
            "to_status",
            "reason",
            "remain_consumed",
            "consumed_line_ids",
            "consumed_line_count",
            "balance_minor",
            "override",
            "override_reason",
        ],
        "branch_transferred" => &["from_branch_id", "to_branch_id"],
        _ => return None,
    })
}

fn event_text(value: &Value, maximum: usize, nullable: bool) -> bool {
    if value.is_null() {
        return nullable;
    }
    value
        .as_str()
        .is_some_and(|text| !text.contains('\0') && text.encode_utf16().count() <= maximum)
}

fn event_uuid(value: &Value, nullable: bool) -> bool {
    if value.is_null() {
        return nullable;
    }
    value
        .as_str()
        .is_some_and(|id| canonical_uuid(id).as_deref() == Some(id))
}

fn event_finite_number(value: &Value, nullable: bool) -> bool {
    if value.is_null() {
        return nullable;
    }
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number.abs() <= 999_999_999_999.0)
}

fn validate_event_payload_value(event_type: &str, key: &str, value: &Value) -> bool {
    match (event_type, key) {
        ("created" | "reopened", "repair_id" | "number_branch_id" | "number_reservation_id")
        | ("reopened", "source_repair_id")
        | ("note_added", "number_branch_id")
        | ("line_changed", "line_id")
        | ("part_consumed", "repair_line_id" | "movement_id")
        | ("part_reversed", "repair_line_id" | "original_movement_id" | "movement_id")
        | ("estimate_created", "estimate_id")
        | ("approval_recorded", "approval_id")
        | ("attachment_added" | "attachment_retention_changed", "attachment_id")
        | ("settlement_linked", "order_id" | "payment_id" | "adjustment_id" | "command_id")
        | ("branch_transferred", "from_branch_id" | "to_branch_id") => event_uuid(value, false),
        ("assignment_changed", "assigned_staff_id") | ("approval_recorded", "estimate_id") => {
            event_uuid(value, true)
        }
        ("settlement_linked", "estimate_id") => event_uuid(value, false),

        ("created" | "reopened", "intake_mode") => value
            .as_str()
            .is_some_and(|mode| matches!(mode, "standard" | "quick_service")),
        ("created" | "reopened", "status") | ("status_changed", "from_status" | "to_status") => {
            value.as_str().is_some_and(valid_repair_status_text)
        }
        ("created" | "reopened", "official_number")
        | ("note_added", "official_number" | "alias_number") => event_text(value, 80, false),
        ("note_added", "note") => event_text(value, 5_000, false),
        ("note_added", "visibility") => value
            .as_str()
            .is_some_and(|visibility| matches!(visibility, "internal" | "customer")),
        ("diagnosis_updated", "diagnosis") => event_text(value, 10_000, true),
        ("diagnosis_updated", "draft") | ("status_changed", "remain_consumed" | "override") => {
            value.is_boolean()
        }
        ("line_changed", "part_state") => {
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|state| matches!(state, "planned" | "consumed" | "reversed"))
        }
        ("part_reversed", "reason")
        | ("approval_recorded", "reason")
        | ("status_changed", "reason" | "override_reason") => event_text(value, 1_000, true),
        ("approval_recorded", "estimate_version") => {
            value.is_null()
                || value
                    .as_u64()
                    .is_some_and(|version| version > 0 && version <= MAX_JAVASCRIPT_SAFE_INTEGER)
        }
        ("settlement_linked", "estimate_version") => value
            .as_u64()
            .is_some_and(|version| version > 0 && version <= MAX_JAVASCRIPT_SAFE_INTEGER),
        ("approval_recorded", "decision") => value
            .as_str()
            .is_some_and(|decision| matches!(decision, "accepted" | "rejected")),
        ("approval_recorded", "decision_source") => value.as_str().is_some_and(|source| {
            matches!(
                source,
                "in_person"
                    | "phone"
                    | "external_message"
                    | "not_required"
                    | "email"
                    | "sms"
                    | "web"
            )
        }),
        ("approval_recorded", "currency") => value.as_str().is_some_and(valid_currency),
        ("approval_recorded", "approved_total_amount")
        | ("settlement_linked", "amount_minor" | "net_paid_after_minor")
        | ("status_changed", "balance_minor") => event_finite_number(value, false),
        ("attachment_retention_changed", "from_retention_state" | "to_retention_state") => value
            .as_str()
            .is_some_and(|state| matches!(state, "active" | "pending_delete" | "legal_hold")),
        ("settlement_linked", "kind" | "role" | "purpose") => event_text(value, 120, false),
        ("settlement_linked", "fiscal_purpose") => event_text(value, 120, true),
        ("status_changed", "consumed_line_ids") => value
            .as_array()
            .is_some_and(|ids| ids.iter().all(|id| event_uuid(id, false))),
        ("status_changed", "consumed_line_count") => value
            .as_u64()
            .is_some_and(|count| count <= MAX_JAVASCRIPT_SAFE_INTEGER),
        _ => false,
    }
}

fn validate_workspace_event(value: &Value) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "aggregate_version",
            "event_type",
            "payload",
            "occurred_at",
            "created_at",
        ],
        &[],
    ) else {
        return false;
    };
    let Some(event_type) = object.get("event_type").and_then(Value::as_str) else {
        return false;
    };
    let Some(allowed) = event_payload_keys(event_type) else {
        return false;
    };
    let Some(payload) = object.get("payload").and_then(Value::as_object) else {
        return false;
    };
    json_uuid(object.get("id"))
        && json_u64(
            object.get("aggregate_version"),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
        )
        && payload.len() <= allowed.len()
        && payload.iter().all(|(key, value)| {
            allowed.contains(&key.as_str()) && validate_event_payload_value(event_type, key, value)
        })
        && json_timestamp(object.get("occurred_at"))
        && json_timestamp(object.get("created_at"))
}

fn validate_workspace_estimate(value: &Value) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "version",
            "supersedes_estimate_id",
            "currency",
            "subtotal_amount",
            "discount_amount",
            "tax_amount",
            "total_amount",
            "valid_until",
            "note",
            "aggregate_version",
            "issued_at",
            "created_at",
        ],
        &[],
    ) else {
        return false;
    };
    json_uuid(object.get("id"))
        && json_u64(object.get("version"), 1, MAX_JAVASCRIPT_SAFE_INTEGER)
        && json_nullable_uuid(object.get("supersedes_estimate_id"))
        && object
            .get("currency")
            .and_then(Value::as_str)
            .is_some_and(valid_currency)
        && [
            "subtotal_amount",
            "discount_amount",
            "tax_amount",
            "total_amount",
        ]
        .iter()
        .all(|key| json_finite(object.get(*key), 0.0, f64::MAX))
        && json_nullable_timestamp(object.get("valid_until"))
        && json_nullable_string(object.get("note"), 0, 2_000, false)
        && json_u64(
            object.get("aggregate_version"),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
        )
        && json_timestamp(object.get("issued_at"))
        && json_timestamp(object.get("created_at"))
}

fn validate_workspace_estimate_line(value: &Value) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "estimate_id",
            "estimate_version",
            "repair_line_id",
            "line_type",
            "description",
            "quantity",
            "unit_price",
            "tax_rate",
            "subtotal_amount",
            "tax_amount",
            "total_amount",
            "display_order",
            "aggregate_version",
            "created_at",
        ],
        &[],
    ) else {
        return false;
    };
    json_uuid(object.get("id"))
        && json_uuid(object.get("estimate_id"))
        && json_u64(
            object.get("estimate_version"),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
        )
        && json_nullable_uuid(object.get("repair_line_id"))
        && json_enum(object.get("line_type"), &["part", "labour", "charge"])
        && json_string(object.get("description"), 1, 1_000, true)
        && json_finite(object.get("quantity"), f64::MIN_POSITIVE, f64::MAX)
        && [
            "unit_price",
            "subtotal_amount",
            "tax_amount",
            "total_amount",
        ]
        .iter()
        .all(|key| json_finite(object.get(*key), 0.0, f64::MAX))
        && json_finite(object.get("tax_rate"), 0.0, 100.0)
        && json_u64(object.get("display_order"), 0, MAX_JAVASCRIPT_SAFE_INTEGER)
        && json_u64(
            object.get("aggregate_version"),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
        )
        && json_timestamp(object.get("created_at"))
}

fn validate_workspace_approval(value: &Value) -> bool {
    let Some(object) = exact_object(
        value,
        &[
            "id",
            "estimate_id",
            "estimate_version",
            "decision",
            "decision_source",
            "customer_id",
            "currency",
            "approved_total_amount",
            "note",
            "decided_at",
            "aggregate_version",
            "created_at",
        ],
        &[],
    ) else {
        return false;
    };
    json_uuid(object.get("id"))
        && json_nullable_uuid(object.get("estimate_id"))
        && object.get("estimate_version").is_some_and(|version| {
            version.is_null() || json_u64(Some(version), 1, MAX_JAVASCRIPT_SAFE_INTEGER)
        })
        && json_enum(object.get("decision"), &["accepted", "rejected"])
        && json_enum(
            object.get("decision_source"),
            &[
                "in_person",
                "phone",
                "email",
                "sms",
                "web",
                "external_message",
                "not_required",
            ],
        )
        && json_nullable_uuid(object.get("customer_id"))
        && object
            .get("currency")
            .and_then(Value::as_str)
            .is_some_and(valid_currency)
        && json_finite(object.get("approved_total_amount"), 0.0, f64::MAX)
        && json_nullable_string(object.get("note"), 0, 1_000, false)
        && json_timestamp(object.get("decided_at"))
        && json_u64(
            object.get("aggregate_version"),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
        )
        && json_timestamp(object.get("created_at"))
}

fn workspace_child_version_at_most(value: &Value, header_version: u64) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("aggregate_version"))
        .and_then(Value::as_u64)
        .is_some_and(|aggregate_version| aggregate_version <= header_version)
}

fn validate_workspace_success(body: &[u8], prepared: &PreparedRepairJsonRequest) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let object = exact_object(
        &value,
        &[
            "repair",
            "aliases",
            "customer",
            "device",
            "lines",
            "events",
            "estimates",
            "estimate_lines",
            "approvals",
            "capabilities",
            "allowed_transitions",
        ],
        &[],
    )?;
    let expected_repair_id = prepared.expected_repair_id.as_deref()?;
    if !validate_workspace_header(object.get("repair")?, expected_repair_id) {
        return None;
    }
    let header = object.get("repair")?.as_object()?;
    let header_version = header.get("version")?.as_u64()?;
    let customer_id = header.get("customer_id").and_then(Value::as_str);
    let device_id = header.get("customer_device_id").and_then(Value::as_str);
    let aliases = object.get("aliases")?.as_array()?;
    let customer_valid = object.get("customer").is_some_and(|customer| {
        if customer.is_null() {
            true
        } else {
            exact_object(customer, &["id", "display_name"], &[]).is_some_and(|customer| {
                json_uuid(customer.get("id"))
                    && customer.get("id").and_then(Value::as_str) == customer_id
                    && json_string(customer.get("display_name"), 1, 500, true)
            })
        }
    });
    let device_valid = object.get("device").is_some_and(|device| {
        if device.is_null() {
            true
        } else {
            device
                .as_object()
                .and_then(|device| device.get("id"))
                .and_then(Value::as_str)
                == device_id
                && validate_device(device, &prepared.expected_organization_id, customer_id)
        }
    });
    let lines = object.get("lines")?.as_array()?;
    let events = object.get("events")?.as_array()?;
    let estimates = object.get("estimates")?.as_array()?;
    let estimate_lines = object.get("estimate_lines")?.as_array()?;
    let approvals = object.get("approvals")?.as_array()?;
    let allowed = object.get("allowed_transitions")?.as_array()?;
    if aliases
        .iter()
        .any(|alias| !json_string(Some(alias), 1, 80, true))
        || !customer_valid
        || !device_valid
        || !lines.iter().all(|line| {
            validate_workspace_line(line) && workspace_child_version_at_most(line, header_version)
        })
        || !events.iter().all(|event| {
            validate_workspace_event(event)
                && workspace_child_version_at_most(event, header_version)
        })
        || !estimates.iter().all(|estimate| {
            validate_workspace_estimate(estimate)
                && workspace_child_version_at_most(estimate, header_version)
        })
        || !estimate_lines.iter().all(|line| {
            validate_workspace_estimate_line(line)
                && workspace_child_version_at_most(line, header_version)
        })
        || !approvals.iter().all(|approval| {
            validate_workspace_approval(approval)
                && workspace_child_version_at_most(approval, header_version)
        })
        || !validate_capabilities(object.get("capabilities")?)
        || allowed.len() > 11
        || allowed
            .iter()
            .any(|status| !status.as_str().is_some_and(valid_repair_status_text))
    {
        return None;
    }
    Some(value)
}

fn validate_settings_success(body: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let object = exact_object(&value, &["settings", "capabilities"], &[])?;
    let settings = exact_object(
        object.get("settings")?,
        &[
            "source",
            "number_prefix",
            "currency",
            "quick_service_enabled",
            "default_priority",
            "default_sla_hours",
            "ready_collection_days",
            "delivery_balance_policy",
            "repair_deposit_supported",
            "attachment_policy",
            "updated_at",
        ],
        &[],
    )?;
    let policy = exact_object(
        settings.get("attachment_policy")?,
        &["max_bytes", "allowed_mime_types"],
        &[],
    )?;
    let mime_types = policy.get("allowed_mime_types")?.as_array()?;
    if !json_enum(
        settings.get("source"),
        &["branch", "organization", "system_default"],
    ) || settings.get("number_prefix").and_then(Value::as_str) != Some("R")
        || !settings
            .get("currency")
            .and_then(Value::as_str)
            .is_some_and(valid_currency)
        || !json_bool(settings.get("quick_service_enabled"))
        || !json_enum(
            settings.get("default_priority"),
            &["low", "normal", "high", "urgent"],
        )
        || !settings
            .get("default_sla_hours")
            .is_some_and(|value| value.is_null() || json_u64(Some(value), 1, 8_760))
        || !json_u64(settings.get("ready_collection_days"), 1, 3_650)
        || !json_enum(
            settings.get("delivery_balance_policy"),
            &["require_zero_balance", "manager_override"],
        )
        || !json_bool(settings.get("repair_deposit_supported"))
        || !json_u64(
            policy.get("max_bytes"),
            1,
            MAX_REPAIR_ATTACHMENT_BYTES as u64,
        )
        || mime_types.len() > 4
        || mime_types.iter().any(|mime| {
            !json_enum(
                Some(mime),
                &["image/jpeg", "image/png", "image/webp", "application/pdf"],
            )
        })
        || !json_nullable_timestamp(settings.get("updated_at"))
        || !validate_capabilities(object.get("capabilities")?)
    {
        return None;
    }
    Some(value)
}

fn validate_customers_success(body: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let object = exact_object(&value, &["customers", "pagination"], &[])?;
    let customers = object.get("customers")?.as_array()?;
    if customers.len() > 50
        || customers.iter().any(|customer| {
            !exact_object(customer, &["id", "name"], &[]).is_some_and(|customer| {
                json_uuid(customer.get("id")) && json_string(customer.get("name"), 1, 200, true)
            })
        })
        || !validate_pagination(object.get("pagination")?, 50, 100_000)
    {
        return None;
    }
    Some(value)
}

fn validate_devices_success(
    body: &[u8],
    prepared: &PreparedRepairJsonRequest,
    single: bool,
) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    if single {
        let object = exact_object(&value, &["device"], &[])?;
        let device = object.get("device")?;
        if !validate_device(
            device,
            &prepared.expected_organization_id,
            prepared.expected_customer_id.as_deref(),
        ) || device.get("id").and_then(Value::as_str) != prepared.expected_device_id.as_deref()
        {
            return None;
        }
    } else {
        let object = exact_object(&value, &["devices"], &[])?;
        let devices = object.get("devices")?.as_array()?;
        if !devices.iter().all(|device| {
            validate_device(
                device,
                &prepared.expected_organization_id,
                prepared.expected_customer_id.as_deref(),
            )
        }) {
            return None;
        }
    }
    Some(value)
}

fn validate_attachments_success(body: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let object = exact_object(&value, &["attachments"], &[])?;
    let attachments = object.get("attachments")?.as_array()?;
    if attachments.len() > 250 {
        return None;
    }
    let mut safe = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let attachment = exact_object(
            attachment,
            &[
                "id",
                "attachment_type",
                "retention_state",
                "mime_type",
                "byte_size",
                "created_at",
            ],
            &[],
        )?;
        if !json_uuid(attachment.get("id"))
            || !json_enum(
                attachment.get("attachment_type"),
                &[
                    "intake",
                    "diagnostic",
                    "repair",
                    "quality_check",
                    "handover",
                    "other",
                ],
            )
            || !json_enum(attachment.get("retention_state"), &["active", "legal_hold"])
            || !json_enum(
                attachment.get("mime_type"),
                &["image/jpeg", "image/png", "image/webp", "application/pdf"],
            )
            || !json_u64(
                attachment.get("byte_size"),
                1,
                MAX_REPAIR_ATTACHMENT_BYTES as u64,
            )
            || !json_timestamp(attachment.get("created_at"))
        {
            return None;
        }
        safe.push(serde_json::json!({
            "id": attachment.get("id")?,
            "attachment_type": attachment.get("attachment_type")?,
            "retention_state": attachment.get("retention_state")?,
            "mime_type": attachment.get("mime_type")?,
            "byte_size": attachment.get("byte_size")?,
            "created_at": attachment.get("created_at")?,
        }));
    }
    Some(serde_json::json!({ "attachments": safe }))
}

fn valid_print_repair_number(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 4 || parts[0] != "R" {
        return false;
    }
    let upper_alphanumeric = |segment: &str| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
    };
    if parts[1] == "OFF" {
        parts[2].len() == 4
            && parts[3].len() == 6
            && upper_alphanumeric(parts[2])
            && upper_alphanumeric(parts[3])
    } else {
        (1..=12).contains(&parts[1].len())
            && upper_alphanumeric(parts[1])
            && parts[2].len() == 2
            && parts[2].bytes().all(|byte| byte.is_ascii_digit())
            && parts[3].len() == 6
            && parts[3].bytes().all(|byte| byte.is_ascii_digit())
    }
}

fn validate_print_success(body: &[u8], expected_repair_id: Option<&str>) -> Option<Value> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let object = exact_object(&value, &["projection"], &[])?;
    let projection = exact_object(
        object.get("projection")?,
        &[
            "projectionSource",
            "projectionVersion",
            "projectedAt",
            "repairId",
            "repairNumber",
            "safeDeviceLabel",
            "receivedAt",
            "branchName",
        ],
        &[
            "customerDisplayName",
            "maskedIdentifier",
            "dueAt",
            "branchContact",
        ],
    )?;
    if projection.get("projectionSource").and_then(Value::as_str)
        != Some("repair_authorized_projection_v1")
        || !json_u64(
            projection.get("projectionVersion"),
            1,
            MAX_JAVASCRIPT_SAFE_INTEGER,
        )
        || !json_timestamp(projection.get("projectedAt"))
        || !json_uuid(projection.get("repairId"))
        || projection.get("repairId").and_then(Value::as_str) != expected_repair_id
        || !projection
            .get("repairNumber")
            .and_then(Value::as_str)
            .is_some_and(valid_print_repair_number)
        || !json_string(projection.get("safeDeviceLabel"), 1, 160, true)
        || !json_timestamp(projection.get("receivedAt"))
        || !json_string(projection.get("branchName"), 1, 120, true)
        || projection
            .get("customerDisplayName")
            .is_some_and(|value| !json_string(Some(value), 1, 120, true))
        || projection.get("maskedIdentifier").is_some_and(|value| {
            let Some(masked) = value.as_str() else {
                return true;
            };
            let suffix = masked
                .strip_prefix("IMEI •••• ")
                .or_else(|| masked.strip_prefix("SERIAL •••• "));
            suffix.map_or(true, |suffix| {
                !(2..=4).contains(&suffix.len())
                    || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        })
        || projection
            .get("dueAt")
            .is_some_and(|value| !json_timestamp(Some(value)))
        || projection
            .get("branchContact")
            .is_some_and(|value| !json_string(Some(value), 1, 80, true))
    {
        return None;
    }
    Some(value)
}

fn validate_command_signal_success(
    body: &[u8],
    prepared: &PreparedRepairJsonRequest,
) -> Option<Value> {
    let signal: RawRepairJsonSignal = serde_json::from_slice(body).ok()?;
    let expected_repair_id = prepared.expected_repair_id.as_deref()?;
    let expected_version = prepared.expected_version?;
    if canonical_uuid(&signal.repair_id).as_deref() != Some(expected_repair_id)
        || signal.version <= expected_version
        || signal.version > MAX_JAVASCRIPT_SAFE_INTEGER
    {
        return None;
    }
    serde_json::to_value(signal).ok()
}

fn is_money_response_shape(shape: RepairJsonResponseShape) -> bool {
    matches!(
        shape,
        RepairJsonResponseShape::Settlement
            | RepairJsonResponseShape::Payment
            | RepairJsonResponseShape::Refund
            | RepairJsonResponseShape::Fiscalize
            | RepairJsonResponseShape::Delivery
    )
}

fn bounded_operation_scoped_error(
    body: &[u8],
    prepared: &PreparedRepairJsonRequest,
) -> Option<RepairBoundedError> {
    if !is_money_response_shape(prepared.response_shape) {
        return None;
    }
    let raw: RawOperationScopedError = serde_json::from_slice(body).ok()?;
    let expected_operation_id = prepared.expected_operation_id.as_deref()?;
    let expected_repair_id = prepared.expected_repair_id.as_deref()?;
    let message = raw.message.trim();
    if !valid_error_code(&raw.code)
        || message.is_empty()
        || message != raw.message
        || raw.message.chars().count() > 1_000
        || canonical_uuid(&raw.operation_id).as_deref() != Some(expected_operation_id)
        || canonical_uuid(&raw.repair_id).as_deref() != Some(expected_repair_id)
    {
        return None;
    }
    Some(RepairBoundedError {
        code: raw.code,
        message: Some(raw.message),
    })
}

fn validate_offline_bootstrap_success(body: &[u8]) -> Option<Value> {
    let response: RawRepairOfflineBootstrapResponse = serde_json::from_slice(body).ok()?;
    if response.offline_terminal_token.len() != 4
        || !response
            .offline_terminal_token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
        || response.offline_sequence_lease_start == 0
        || response.offline_sequence_lease_start > response.offline_sequence_lease_end
        || response.offline_sequence_lease_end > 999_999
        || response.offline_sequence_lease_end - response.offline_sequence_lease_start + 1 > 100
    {
        return None;
    }
    serde_json::to_value(response).ok()
}

fn classify_repair_json_response(
    response: BoundedRepairHttpResponse,
    prepared: &PreparedRepairJsonRequest,
) -> RepairJsonDisposition {
    if response.exceeded_limit {
        return RepairJsonDisposition::MalformedResponse;
    }
    if response.status == prepared.expected_success_status {
        let data = match prepared.response_shape {
            RepairJsonResponseShape::List => validate_list_success(&response.body),
            RepairJsonResponseShape::Workspace => {
                validate_workspace_success(&response.body, prepared)
            }
            RepairJsonResponseShape::Settings => validate_settings_success(&response.body),
            RepairJsonResponseShape::OfflineBootstrap => {
                validate_offline_bootstrap_success(&response.body)
            }
            RepairJsonResponseShape::Customers => validate_customers_success(&response.body),
            RepairJsonResponseShape::CustomerDevices => {
                validate_devices_success(&response.body, prepared, false)
            }
            RepairJsonResponseShape::CustomerDevice => {
                validate_devices_success(&response.body, prepared, true)
            }
            RepairJsonResponseShape::Attachments => validate_attachments_success(&response.body),
            RepairJsonResponseShape::PrintProjection => {
                validate_print_success(&response.body, prepared.expected_repair_id.as_deref())
            }
            RepairJsonResponseShape::FinancialProjection => {
                classify_financial_projection_success(&response.body, prepared)
            }
            RepairJsonResponseShape::CommandSignal => {
                validate_command_signal_success(&response.body, prepared)
            }
            RepairJsonResponseShape::Settlement => {
                classify_settlement_success(&response.body, prepared)
            }
            RepairJsonResponseShape::Payment => classify_payment_success(&response.body, prepared),
            RepairJsonResponseShape::Refund => classify_refund_success(&response.body, prepared),
            RepairJsonResponseShape::Fiscalize => {
                classify_fiscalize_success(&response.body, prepared)
            }
            RepairJsonResponseShape::Delivery => {
                classify_delivery_success(&response.body, prepared)
            }
        };
        return data
            .map(|data| RepairJsonDisposition::Success {
                status: response.status,
                data,
            })
            .unwrap_or(RepairJsonDisposition::MalformedResponse);
    }
    if response.status == 429 {
        return RepairJsonDisposition::RateLimited {
            retry_after_seconds: bounded_retry_after(response.retry_after.as_deref()),
        };
    }
    if response.status >= 500 {
        return RepairJsonDisposition::RetryableFailure {
            status: response.status,
            error: RepairBoundedError {
                code: "HTTP_SERVER_ERROR".to_string(),
                message: None,
            },
        };
    }
    if response.status == 409 {
        if let (
            Some(expected_repair_id),
            Some(expected_operation_id),
            Some(expected_version),
            Ok(raw),
        ) = (
            prepared.expected_repair_id.as_deref(),
            prepared.expected_operation_id.as_deref(),
            prepared.expected_version,
            serde_json::from_slice::<RawRepairAttachmentConflictResponse>(&response.body),
        ) {
            let upload = RepairRawAttachmentUpload {
                repair_id: expected_repair_id.to_string(),
                metadata: RepairRawAttachmentMetadata {
                    attachment_id: "00000000-0000-4000-8000-000000000000".to_string(),
                    operation_id: expected_operation_id.to_string(),
                    staff_session_id: "00000000-0000-4000-8000-000000000000".to_string(),
                    expected_version,
                    occurred_at: "1970-01-01T00:00:00Z".to_string(),
                    attachment_type: "other".to_string(),
                    filename: "bounded".to_string(),
                    caption: None,
                    mime_type: "application/pdf".to_string(),
                    byte_size: 1,
                    sha256_hex: "0".repeat(64),
                },
                bytes: Zeroizing::new(vec![0]),
            };
            if let Some(conflict) = attachment_conflict_projection(raw, &upload) {
                return RepairJsonDisposition::Conflict { conflict };
            }
        }
    }
    if (400..500).contains(&response.status) {
        if is_money_response_shape(prepared.response_shape) {
            if let Some(error) = bounded_operation_scoped_error(&response.body, prepared) {
                // Money RPC conflicts intentionally carry only operation-bound
                // identities, not an authorized repair projection. Surface a
                // bounded failure and require the caller to refetch through the
                // typed workspace route; never fabricate conflict state here.
                if session_error_code(&error.code) {
                    return RepairJsonDisposition::SessionRequired { error };
                }
                if error.code == "MODULE_REQUIRED" {
                    return RepairJsonDisposition::ModuleRequired { error };
                }
                return RepairJsonDisposition::PermanentFailure {
                    status: response.status,
                    error,
                };
            }
        }
        let Ok(raw) = serde_json::from_slice::<RawTopLevelError>(&response.body) else {
            return RepairJsonDisposition::MalformedResponse;
        };
        let Some(failure) = bounded_top_level_failure(raw) else {
            return RepairJsonDisposition::MalformedResponse;
        };
        let error = match failure {
            BoundedTopLevelFailure::TerminalAuth(_) => generic_terminal_auth_prerequisite(),
            BoundedTopLevelFailure::Error(error) => error,
        };
        if session_error_code(&error.code) {
            return RepairJsonDisposition::SessionRequired { error };
        }
        if error.code == "MODULE_REQUIRED" {
            return RepairJsonDisposition::ModuleRequired { error };
        }
        return RepairJsonDisposition::PermanentFailure {
            status: response.status,
            error,
        };
    }
    RepairJsonDisposition::MalformedResponse
}

#[cfg(test)]
pub(crate) fn classify_repair_json_response_body(
    http_status: u16,
    response_body: &[u8],
    retry_after: Option<&str>,
    prepared: &PreparedRepairJsonRequest,
) -> RepairJsonDisposition {
    if response_body.len() > prepared.response_shape.maximum_response_bytes() {
        return RepairJsonDisposition::MalformedResponse;
    }
    classify_repair_json_response(
        BoundedRepairHttpResponse {
            status: http_status,
            retry_after: retry_after.map(str::to_string),
            body: response_body.to_vec(),
            exceeded_limit: false,
        },
        prepared,
    )
}

pub(crate) async fn send_repair_json_request(
    base_url: &str,
    api_key: &str,
    _bootstrap_claim: Option<&str>,
    native_scope: &NativeRepairScope,
    input: &RepairJsonTransportInput,
) -> Result<RepairJsonDisposition, RepairHookError> {
    let required_permission = required_permission_for_json_request(&input.request)?;
    let session = authorize_repair_actor(
        native_scope,
        &input.staff_session_id,
        required_permission,
        chrono::Utc::now(),
    )?;
    let prepared = prepare_repair_json_request(&session, &input.request)?;
    if api_key.trim().is_empty() || api_key.len() > 4_096 {
        return Err(RepairHookError::unavailable(
            "REPAIR_NATIVE_API_KEY_UNAVAILABLE",
        ));
    }
    let safe_base = crate::api::resolve_admin_base(base_url)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    let mut endpoint = url::Url::parse(&safe_base)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    let (path, query) = prepared
        .path
        .split_once('?')
        .map_or((prepared.path.as_str(), None), |(path, query)| {
            (path, Some(query))
        });
    endpoint.set_path(path);
    endpoint.set_query(query);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RepairHookError::unavailable("REPAIR_HTTP_CLIENT_UNAVAILABLE"))?;
    let method = reqwest::Method::from_bytes(prepared.method.as_bytes())
        .map_err(|_| RepairHookError::permanent("REPAIR_ONLINE_INPUT_INVALID"))?;
    let mut request = client
        .request(method, endpoint)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", session.terminal_id())
        .header("x-staff-session-id", session.staff_session_id())
        .header("x-pos-client-version", env!("CARGO_PKG_VERSION"));
    if let Some(body) = prepared.body.as_ref() {
        request = request
            .header("content-type", "application/json")
            .body(body.clone());
    }
    let response = request
        .send()
        .await
        .map_err(|_| RepairHookError::retryable("REPAIR_ONLINE_REQUEST_FAILED"))?;
    let bounded = read_bounded_repair_response_with_limit(
        response,
        prepared.response_shape.maximum_response_bytes(),
    )
    .await?;
    Ok(classify_repair_json_response(bounded, &prepared))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RepairBinaryRequest {
    Attachment {
        repair_id: String,
        attachment_id: String,
        mime_type: String,
        byte_size: u64,
    },
}

pub(crate) struct RepairBinaryTransportInput {
    pub(crate) staff_session_id: String,
    pub(crate) request: RepairBinaryRequest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RepairAttachmentContentExpectation {
    pub(crate) repair_id: String,
    pub(crate) attachment_id: String,
    pub(crate) mime_type: String,
    pub(crate) byte_size: u64,
}

pub(crate) struct RepairDownloadedAttachment {
    pub(crate) mime_type: String,
    pub(crate) bytes: Zeroizing<Vec<u8>>,
}

impl std::fmt::Debug for RepairDownloadedAttachment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RepairDownloadedAttachment")
            .field("mime_type", &self.mime_type)
            .field("byte_size", &self.bytes.len())
            .finish()
    }
}

#[derive(Debug)]
struct RepairAttachmentContentHeaders {
    content_type: String,
    content_length: String,
    sha256_hex: String,
    cache_control: String,
    content_type_options: String,
    cross_origin_resource_policy: String,
    content_security_policy: String,
    has_location: bool,
    has_content_disposition: bool,
}

fn allowed_repair_attachment_mime(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/jpeg" | "image/png" | "image/webp" | "application/pdf"
    )
}

fn validate_repair_attachment_expectation(
    expectation: &RepairAttachmentContentExpectation,
) -> Result<(), RepairHookError> {
    if canonical_uuid(&expectation.repair_id).as_deref() != Some(&expectation.repair_id)
        || canonical_uuid(&expectation.attachment_id).as_deref() != Some(&expectation.attachment_id)
        || !allowed_repair_attachment_mime(&expectation.mime_type)
        || expectation.byte_size == 0
        || expectation.byte_size > MAX_REPAIR_ATTACHMENT_BYTES as u64
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_INPUT_INVALID",
        ));
    }
    Ok(())
}

fn classify_repair_attachment_content_status(status: u16) -> Result<(), RepairHookError> {
    match status {
        200 => Ok(()),
        401 | 409 => Err(RepairHookError::sign_in("REPAIR_EXPIRED_SESSION")),
        403 => Err(RepairHookError::permanent("REPAIR_PERMISSION_DENIED")),
        404 | 410 => Err(RepairHookError::permanent("REPAIR_ATTACHMENT_NOT_FOUND")),
        429 => Err(RepairHookError::retryable("REPAIR_ATTACHMENT_RATE_LIMITED")),
        500..=599 => Err(RepairHookError::retryable(
            "REPAIR_ATTACHMENT_DOWNLOAD_FAILED",
        )),
        _ => Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_RESPONSE_INVALID",
        )),
    }
}

fn validate_repair_attachment_content_headers(
    headers: &RepairAttachmentContentHeaders,
    expectation: &RepairAttachmentContentExpectation,
) -> Result<(), RepairHookError> {
    validate_repair_attachment_expectation(expectation)?;
    let content_length = headers
        .content_length
        .parse::<u64>()
        .ok()
        .filter(|value| value.to_string() == headers.content_length);
    if headers.content_type != expectation.mime_type
        || content_length != Some(expectation.byte_size)
        || headers.sha256_hex.len() != 64
        || !headers
            .sha256_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || headers.cache_control != "no-store"
        || headers.content_type_options != "nosniff"
        || headers.cross_origin_resource_policy != "same-origin"
        || headers.content_security_policy != "sandbox"
        || headers.has_location
        || headers.has_content_disposition
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_INTEGRITY_FAILED",
        ));
    }
    Ok(())
}

fn validate_repair_attachment_content_body(
    headers: &RepairAttachmentContentHeaders,
    bytes: Zeroizing<Vec<u8>>,
    expectation: &RepairAttachmentContentExpectation,
) -> Result<RepairDownloadedAttachment, RepairHookError> {
    if bytes.len() != expectation.byte_size as usize
        || bytes.len() > MAX_REPAIR_ATTACHMENT_BYTES
        || format!("{:x}", Sha256::digest(&*bytes)) != headers.sha256_hex
    {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_INTEGRITY_FAILED",
        ));
    }
    Ok(RepairDownloadedAttachment {
        mime_type: expectation.mime_type.clone(),
        bytes,
    })
}

fn single_utf8_header(
    headers: &reqwest::header::HeaderMap,
    name: &'static str,
) -> Result<String, RepairHookError> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_ATTACHMENT_INTEGRITY_FAILED"))?;
    if values.next().is_some() || value.trim() != value {
        return Err(RepairHookError::permanent(
            "REPAIR_ATTACHMENT_INTEGRITY_FAILED",
        ));
    }
    Ok(value)
}

fn attachment_content_headers(
    headers: &reqwest::header::HeaderMap,
) -> Result<RepairAttachmentContentHeaders, RepairHookError> {
    Ok(RepairAttachmentContentHeaders {
        content_type: single_utf8_header(headers, "content-type")?.to_ascii_lowercase(),
        content_length: single_utf8_header(headers, "content-length")?,
        sha256_hex: single_utf8_header(headers, "x-repair-content-sha256")?,
        cache_control: single_utf8_header(headers, "cache-control")?.to_ascii_lowercase(),
        content_type_options: single_utf8_header(headers, "x-content-type-options")?
            .to_ascii_lowercase(),
        cross_origin_resource_policy: single_utf8_header(headers, "cross-origin-resource-policy")?
            .to_ascii_lowercase(),
        content_security_policy: single_utf8_header(headers, "content-security-policy")?
            .to_ascii_lowercase(),
        has_location: headers.contains_key("location"),
        has_content_disposition: headers.contains_key("content-disposition"),
    })
}

#[cfg(test)]
fn validate_repair_attachment_content_for_test(
    status: u16,
    headers: &[(&str, &str)],
    body: &[u8],
    expectation: &RepairAttachmentContentExpectation,
) -> Result<RepairDownloadedAttachment, RepairHookError> {
    classify_repair_attachment_content_status(status)?;
    let value = |name: &str| {
        headers
            .iter()
            .find_map(|(candidate, value)| candidate.eq_ignore_ascii_case(name).then_some(*value))
            .unwrap_or_default()
            .to_string()
    };
    let parsed = RepairAttachmentContentHeaders {
        content_type: value("content-type").to_ascii_lowercase(),
        content_length: value("content-length"),
        sha256_hex: value("x-repair-content-sha256"),
        cache_control: value("cache-control").to_ascii_lowercase(),
        content_type_options: value("x-content-type-options").to_ascii_lowercase(),
        cross_origin_resource_policy: value("cross-origin-resource-policy").to_ascii_lowercase(),
        content_security_policy: value("content-security-policy").to_ascii_lowercase(),
        has_location: headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("location")),
        has_content_disposition: headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-disposition")),
    };
    validate_repair_attachment_content_headers(&parsed, expectation)?;
    validate_repair_attachment_content_body(&parsed, Zeroizing::new(body.to_vec()), expectation)
}

async fn send_repair_attachment_content_request(
    base_url: &str,
    api_key: &str,
    native_scope: &NativeRepairScope,
    staff_session_id: &str,
    expectation: &RepairAttachmentContentExpectation,
) -> Result<RepairDownloadedAttachment, RepairHookError> {
    validate_repair_attachment_expectation(expectation)?;
    let session = authorize_repair_actor(
        native_scope,
        staff_session_id,
        "repairs.attachments",
        chrono::Utc::now(),
    )?;
    if api_key.trim().is_empty() || api_key.len() > 4_096 {
        return Err(RepairHookError::unavailable(
            "REPAIR_NATIVE_API_KEY_UNAVAILABLE",
        ));
    }
    let safe_base = crate::api::resolve_admin_base(base_url)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    let mut endpoint = url::Url::parse(&safe_base)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    endpoint.set_path(&format!(
        "/api/pos/repairs/{}/attachments/{}/content",
        expectation.repair_id, expectation.attachment_id
    ));
    endpoint.set_query(None);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RepairHookError::unavailable("REPAIR_HTTP_CLIENT_UNAVAILABLE"))?;
    let mut response = client
        .get(endpoint)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", session.terminal_id())
        .header("x-staff-session-id", session.staff_session_id())
        .header("x-pos-client-version", env!("CARGO_PKG_VERSION"))
        .send()
        .await
        .map_err(|_| RepairHookError::retryable("REPAIR_ATTACHMENT_DOWNLOAD_FAILED"))?;
    classify_repair_attachment_content_status(response.status().as_u16())?;
    let headers = attachment_content_headers(response.headers())?;
    validate_repair_attachment_content_headers(&headers, expectation)?;

    let mut bytes = Zeroizing::new(Vec::with_capacity(expectation.byte_size as usize));
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|_| RepairHookError::retryable("REPAIR_ATTACHMENT_DOWNLOAD_FAILED"))?;
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > MAX_REPAIR_ATTACHMENT_BYTES
            || bytes.len().saturating_add(chunk.len()) > expectation.byte_size as usize
        {
            return Err(RepairHookError::permanent(
                "REPAIR_ATTACHMENT_INTEGRITY_FAILED",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    validate_repair_attachment_content_body(&headers, bytes, expectation)
}

pub(crate) async fn repair_binary_request(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairBinaryTransportInput,
) -> Result<RepairDownloadedAttachment, String> {
    let _lifecycle_lease =
        crate::repairs::acquire_transport_lease().map_err(|error| error.code().to_string())?;
    let native_scope = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        resolve_native_repair_scope(&connection).map_err(|error| error.code().to_string())?
    };
    let expectation = match input.request {
        RepairBinaryRequest::Attachment {
            repair_id,
            attachment_id,
            mime_type,
            byte_size,
        } => RepairAttachmentContentExpectation {
            repair_id,
            attachment_id,
            mime_type,
            byte_size,
        },
    };
    let (base_url, api_key) = crate::resolve_admin_endpoint(Some(&db))
        .await
        .map_err(|_| "REPAIR_NATIVE_ENDPOINT_UNAVAILABLE".to_string())?;
    send_repair_attachment_content_request(
        &base_url,
        &api_key,
        &native_scope,
        &input.staff_session_id,
        &expectation,
    )
    .await
    .map_err(|error| error.code().to_string())
}

fn validate_bootstrap_candidate(
    persisted_session: Option<&str>,
    claimed_staff_session_id: &str,
    native_scope: &NativeRepairScope,
) -> Result<String, RepairHookError> {
    let persisted_session = persisted_session
        .filter(|raw| !raw.is_empty() && raw.len() <= MAX_PERSISTED_REPAIR_SESSION_BYTES)
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let parsed: Value = serde_json::from_str(persisted_session)
        .map_err(|_| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let stored_session_id = required_string(object, "sessionId")
        .and_then(canonical_uuid)
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let claimed_session_id = canonical_uuid(claimed_staff_session_id)
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let organization_id = required_string(object, "organizationId")
        .and_then(canonical_uuid)
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let branch_id = required_string(object, "branchId")
        .and_then(canonical_uuid)
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let staff_id = required_string(object, "staffId")
        .and_then(canonical_uuid)
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let terminal_id = required_string(object, "terminalId")
        .filter(|value| validate_native_terminal_id(value))
        .ok_or_else(|| RepairHookError::sign_in("REPAIR_STAFF_SESSION_REQUIRED"))?;
    let native_organization_id = canonical_uuid(&native_scope.organization_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_NATIVE_SCOPE_MISMATCH"))?;
    let native_branch_id = canonical_uuid(&native_scope.branch_id)
        .ok_or_else(|| RepairHookError::permanent("REPAIR_NATIVE_SCOPE_MISMATCH"))?;
    let _ = staff_id;
    if stored_session_id != claimed_session_id
        || organization_id != native_organization_id
        || branch_id != native_branch_id
        || terminal_id != native_scope.terminal_id
    {
        return Err(RepairHookError::permanent("REPAIR_NATIVE_SCOPE_MISMATCH"));
    }
    Ok(stored_session_id)
}

pub(crate) async fn send_repair_actor_bootstrap_request(
    base_url: &str,
    api_key: &str,
    persisted_session: Option<&str>,
    native_scope: &NativeRepairScope,
    claimed_staff_session_id: &str,
) -> Result<RepairActorBootstrap, RepairHookError> {
    let staff_session_id =
        validate_bootstrap_candidate(persisted_session, claimed_staff_session_id, native_scope)?;
    if api_key.trim().is_empty() || api_key.len() > 4_096 {
        return Err(RepairHookError::unavailable(
            "REPAIR_NATIVE_API_KEY_UNAVAILABLE",
        ));
    }
    let safe_base = crate::api::resolve_admin_base(base_url)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    let mut endpoint = url::Url::parse(&safe_base)
        .map_err(|_| RepairHookError::unavailable("REPAIR_API_ORIGIN_INVALID"))?;
    endpoint.set_path("/api/pos/repairs/offline-bootstrap");
    endpoint.set_query(None);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RepairHookError::unavailable("REPAIR_HTTP_CLIENT_UNAVAILABLE"))?;
    let response = client
        .post(endpoint)
        .header("content-type", "application/json")
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", &native_scope.terminal_id)
        .header("x-staff-session-id", &staff_session_id)
        .header("x-pos-client-version", env!("CARGO_PKG_VERSION"))
        .body("{}")
        .send()
        .await
        .map_err(|_| RepairHookError::retryable("REPAIR_ONLINE_REQUEST_FAILED"))?;
    let bounded =
        read_bounded_repair_response_with_limit(response, MAX_REPAIR_RESPONSE_BYTES).await?;
    if bounded.exceeded_limit {
        return Err(RepairHookError::permanent(
            "REPAIR_OFFLINE_BOOTSTRAP_INVALID",
        ));
    }
    match bounded.status {
        200 => validate_and_persist_repair_actor_bootstrap(
            &bounded.body,
            native_scope,
            &staff_session_id,
            chrono::Utc::now(),
        ),
        403 => Err(RepairHookError::permanent("REPAIR_PERMISSION_DENIED")),
        409 => Err(RepairHookError::sign_in("REPAIR_EXPIRED_SESSION")),
        429 => Err(RepairHookError::retryable(
            "REPAIR_OFFLINE_BOOTSTRAP_RATE_LIMITED",
        )),
        500..=599 => Err(RepairHookError::retryable(
            "REPAIR_OFFLINE_BOOTSTRAP_RETRYABLE",
        )),
        _ => Err(RepairHookError::permanent(
            "REPAIR_OFFLINE_BOOTSTRAP_INVALID",
        )),
    }
}

/// Sole native repair HTTP execution entrypoint.
///
/// Renderer-facing IPC is limited to the named typed wrappers in
/// `commands::repairs`; those wrappers supply a tagged repair action and a
/// staff-session claim here. Endpoint origin, terminal API key, tenant scope,
/// persisted session, route, method, framing, and headers remain native-owned.
pub(crate) async fn repair_json_request(
    db: tauri::State<'_, crate::db::DbState>,
    input: RepairJsonTransportInput,
) -> Result<RepairJsonDisposition, String> {
    let _lifecycle_lease =
        crate::repairs::acquire_transport_lease().map_err(|error| error.code().to_string())?;
    let native_scope = {
        let connection = db
            .conn
            .lock()
            .map_err(|_| "REPAIR_NATIVE_STATE_UNAVAILABLE".to_string())?;
        resolve_native_repair_scope(&connection).map_err(|error| error.code().to_string())?
    };

    let (base_url, api_key) = crate::resolve_admin_endpoint(Some(&db))
        .await
        .map_err(|_| "REPAIR_NATIVE_ENDPOINT_UNAVAILABLE".to_string())?;
    send_repair_json_request(&base_url, &api_key, None, &native_scope, &input)
        .await
        .map_err(|error| error.code().to_string())
}

#[cfg(test)]
mod financial_projection_tests {
    use super::*;

    const REPAIR_ID: &str = "20000000-0000-4000-8000-000000000001";
    const ORDER_ID: &str = "20000000-0000-4000-8000-000000000002";
    const PAYMENT_ID: &str = "20000000-0000-4000-8000-000000000003";
    const ADJUSTMENT_ID: &str = "20000000-0000-4000-8000-000000000004";

    fn prepared() -> PreparedRepairJsonRequest {
        PreparedRepairJsonRequest {
            method: "GET",
            path: format!("/api/pos/repairs/{REPAIR_ID}/settlement"),
            body: None,
            expected_success_status: 200,
            response_shape: RepairJsonResponseShape::FinancialProjection,
            expected_repair_id: Some(REPAIR_ID.to_string()),
            expected_customer_id: None,
            expected_device_id: None,
            expected_organization_id: "20000000-0000-4000-8000-000000000005".to_string(),
            expected_operation_id: None,
            expected_version: None,
            expected_amount_minor: None,
            expected_payment_id: None,
        }
    }

    fn projection() -> Value {
        serde_json::json!({
            "repair_id": REPAIR_ID,
            "currency": "EUR",
            "total_minor": 12400,
            "paid_minor": 5000,
            "refunded_minor": 1000,
            "balance_minor": 8400,
            "orders": [{
                "id": ORDER_ID,
                "order_number": "ORD-100",
                "role": "primary",
                "fiscal_state": "deferred",
                "payment_status": "partial",
                "total_minor": 12400
            }],
            "payments": [{
                "id": PAYMENT_ID,
                "order_id": ORDER_ID,
                "payment_method": "cash",
                "amount_minor": 5000,
                "refunded_minor": 1000,
                "refundable_minor": 4000,
                "status": "completed",
                "created_at": "2026-08-31T10:00:00.000Z"
            }],
            "adjustments": [{
                "id": ADJUSTMENT_ID,
                "order_id": ORDER_ID,
                "payment_id": PAYMENT_ID,
                "adjustment_type": "refund",
                "amount_minor": 1000,
                "refund_method": "cash",
                "created_at": "2026-08-31T10:01:00.000Z"
            }],
            "fiscal_commands": []
        })
    }

    #[test]
    fn financial_projection_requires_read_permission_and_exact_safe_shape() {
        assert_eq!(
            required_permission_for_json_request(&RepairJsonRequest::FinancialProjection {
                repair_id: REPAIR_ID.to_string(),
            })
            .unwrap(),
            "repairs.read"
        );
        let safe = projection();
        assert!(
            classify_financial_projection_success(safe.to_string().as_bytes(), &prepared(),)
                .is_some()
        );

        let mut unsafe_value = safe;
        unsafe_value["payments"][0]["provider_reference"] =
            Value::String("provider-secret".to_string());
        assert!(classify_financial_projection_success(
            unsafe_value.to_string().as_bytes(),
            &prepared(),
        )
        .is_none());
    }

    #[test]
    fn financial_projection_rejects_cross_order_and_unreconciled_refs() {
        let mut cross_order = projection();
        cross_order["payments"][0]["order_id"] =
            Value::String("20000000-0000-4000-8000-000000000099".to_string());
        assert!(classify_financial_projection_success(
            cross_order.to_string().as_bytes(),
            &prepared(),
        )
        .is_none());

        let mut unreconciled = projection();
        unreconciled["balance_minor"] = Value::from(8_399_u64);
        assert!(classify_financial_projection_success(
            unreconciled.to_string().as_bytes(),
            &prepared(),
        )
        .is_none());
    }
}

#[cfg(test)]
mod attachment_binary_tests {
    use super::*;

    const REPAIR_ID: &str = "10000000-0000-4000-8000-000000000003";
    const ATTACHMENT_ID: &str = "10000000-0000-4000-8000-000000000004";

    fn expected(byte_size: u64) -> RepairAttachmentContentExpectation {
        RepairAttachmentContentExpectation {
            repair_id: REPAIR_ID.to_string(),
            attachment_id: ATTACHMENT_ID.to_string(),
            mime_type: "image/jpeg".to_string(),
            byte_size,
        }
    }

    #[test]
    fn attachment_list_accepts_only_the_renderer_safe_projection() {
        let safe = serde_json::json!({ "attachments": [{
            "id": ATTACHMENT_ID,
            "attachment_type": "diagnostic",
            "retention_state": "active",
            "mime_type": "image/jpeg",
            "byte_size": 12,
            "created_at": "2026-08-19T08:20:00.000Z"
        }] });
        assert!(validate_attachments_success(safe.to_string().as_bytes()).is_some());

        let mut unsafe_value = safe;
        unsafe_value["attachments"][0]["original_filename"] =
            Value::String("customer-device.jpg".to_string());
        assert!(validate_attachments_success(unsafe_value.to_string().as_bytes()).is_none());
    }

    #[test]
    fn attachment_binary_requires_exact_security_headers_length_and_hash() {
        let body = b"safe payload";
        let hash = format!("{:x}", Sha256::digest(body));
        let headers = [
            ("content-type", "image/jpeg"),
            ("content-length", "12"),
            ("x-repair-content-sha256", hash.as_str()),
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
            ("cross-origin-resource-policy", "same-origin"),
            ("content-security-policy", "sandbox"),
        ];
        let content = validate_repair_attachment_content_for_test(
            200,
            &headers,
            body,
            &expected(body.len() as u64),
        )
        .expect("valid bounded attachment");
        assert_eq!(&*content.bytes, body);

        let bad_hash = "0".repeat(64);
        let changed = [
            ("content-type", "image/jpeg"),
            ("content-length", "12"),
            ("x-repair-content-sha256", bad_hash.as_str()),
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
            ("cross-origin-resource-policy", "same-origin"),
            ("content-security-policy", "sandbox"),
        ];
        assert_eq!(
            validate_repair_attachment_content_for_test(
                200,
                &changed,
                body,
                &expected(body.len() as u64),
            )
            .unwrap_err()
            .code(),
            "REPAIR_ATTACHMENT_INTEGRITY_FAILED"
        );
    }

    #[test]
    fn attachment_binary_rejects_redirect_and_disposition_surfaces() {
        let body = b"safe payload";
        for forbidden in ["location", "content-disposition"] {
            let hash = format!("{:x}", Sha256::digest(body));
            let mut headers = vec![
                ("content-type", "image/jpeg"),
                ("content-length", "12"),
                ("x-repair-content-sha256", hash.as_str()),
                ("cache-control", "no-store"),
                ("x-content-type-options", "nosniff"),
                ("cross-origin-resource-policy", "same-origin"),
                ("content-security-policy", "sandbox"),
            ];
            headers.push((forbidden, "attacker-controlled"));
            assert_eq!(
                validate_repair_attachment_content_for_test(
                    200,
                    &headers,
                    body,
                    &expected(body.len() as u64),
                )
                .unwrap_err()
                .code(),
                "REPAIR_ATTACHMENT_INTEGRITY_FAILED"
            );
        }
    }
}

#[cfg(test)]
mod actor_attestation_tests {
    use super::*;
    use crate::tests::fake_keyring;

    const ORGANIZATION_ID: &str = "44444444-4444-4444-8444-444444444444";
    const BRANCH_ID: &str = "33333333-3333-4333-8333-333333333333";
    const TERMINAL_ID: &str = "terminal-repairs-a";
    const STAFF_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SESSION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_SESSION_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn scope() -> NativeRepairScope {
        NativeRepairScope {
            organization_id: ORGANIZATION_ID.to_string(),
            branch_id: BRANCH_ID.to_string(),
            terminal_id: TERMINAL_ID.to_string(),
        }
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-08-26T10:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn bootstrap(
        session_id: &str,
        permissions: &[&str],
        lease: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "actor_attestation": {
                "version": 1,
                "organization_id": ORGANIZATION_ID,
                "branch_id": BRANCH_ID,
                "terminal_public_id": TERMINAL_ID,
                "staff_id": STAFF_ID,
                "staff_session_id": session_id,
                "issued_at": "2026-08-26T10:00:00.000Z",
                "session_expires_at": "2026-08-26T18:00:00.000Z",
                "offline_expires_at": "2026-08-26T12:00:00.000Z",
                "permissions": permissions
            },
            "numbering_lease": lease
        })
    }

    fn persist(value: serde_json::Value, session_id: &str) -> RepairActorBootstrap {
        validate_and_persist_repair_actor_bootstrap(
            value.to_string().as_bytes(),
            &scope(),
            session_id,
            now(),
        )
        .expect("strict native bootstrap")
    }

    #[test]
    fn renderer_session_blob_cannot_mint_repair_actor_authority() {
        let _keyring = fake_keyring::install_empty();
        crate::storage::session_set(
            &serde_json::json!({
                "sessionId": SESSION_ID,
                "staffId": STAFF_ID,
                "branchId": BRANCH_ID,
                "organizationId": ORGANIZATION_ID,
                "terminalId": TERMINAL_ID,
                "permissions": REPAIR_PERMISSIONS
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            authorize_repair_actor(&scope(), SESSION_ID, "repairs.read", now())
                .unwrap_err()
                .code(),
            "REPAIR_ACTOR_ATTESTATION_REQUIRED"
        );
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_none()
        );
    }

    #[test]
    fn strict_native_bootstrap_rejects_invalid_attestations_without_publishing() {
        let invalid = vec![
            {
                let mut value = bootstrap(
                    SESSION_ID,
                    &["repairs.read"],
                    serde_json::json!({ "kind": "none" }),
                );
                value["unexpected"] = serde_json::json!(true);
                value
            },
            {
                let mut value = bootstrap(
                    SESSION_ID,
                    &["repairs.read"],
                    serde_json::json!({ "kind": "none" }),
                );
                value["actor_attestation"]["organization_id"] =
                    serde_json::json!("55555555-5555-4555-8555-555555555555");
                value
            },
            {
                let mut value = bootstrap(
                    SESSION_ID,
                    &["repairs.read"],
                    serde_json::json!({ "kind": "none" }),
                );
                value["actor_attestation"]["terminal_public_id"] =
                    serde_json::json!(" terminal-repairs-a");
                value
            },
            bootstrap(
                SESSION_ID,
                &["repairs.read", "repairs.read"],
                serde_json::json!({ "kind": "none" }),
            ),
            {
                let mut value = bootstrap(
                    SESSION_ID,
                    &["repairs.read"],
                    serde_json::json!({ "kind": "none" }),
                );
                value["actor_attestation"]["offline_expires_at"] =
                    serde_json::json!("2026-08-26T12:00:01.000Z");
                value
            },
            bootstrap(
                SESSION_ID,
                &["repairs.create"],
                serde_json::json!({
                    "kind": "sequence",
                    "offline_terminal_token": "A9F0",
                    "offline_sequence_lease_start": 1
                }),
            ),
        ];

        for value in invalid {
            let _keyring = fake_keyring::install_empty();
            assert!(validate_and_persist_repair_actor_bootstrap(
                value.to_string().as_bytes(),
                &scope(),
                SESSION_ID,
                now(),
            )
            .is_err());
            assert!(crate::storage::get_credential(
                crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1
            )
            .is_none());
        }
    }

    #[test]
    fn actor_permissions_are_exact_and_sequence_lease_is_create_only() {
        let _keyring = fake_keyring::install_empty();
        let read = persist(
            bootstrap(
                SESSION_ID,
                &["repairs.read"],
                serde_json::json!({ "kind": "none" }),
            ),
            SESSION_ID,
        );
        assert!(matches!(
            read.numbering_lease,
            RepairNumberingLease::None {}
        ));
        authorize_repair_actor(&scope(), SESSION_ID, "repairs.read", now()).unwrap();
        for denied in [
            "repairs.create",
            "repairs.update",
            "repairs.attachments",
            "repairs.transfer",
        ] {
            assert_eq!(
                authorize_repair_actor(&scope(), SESSION_ID, denied, now())
                    .unwrap_err()
                    .code(),
                "REPAIR_PERMISSION_DENIED"
            );
        }

        let create = persist(
            bootstrap(
                OTHER_SESSION_ID,
                &["repairs.create"],
                serde_json::json!({
                    "kind": "sequence",
                    "offline_terminal_token": "A9F0",
                    "offline_sequence_lease_start": 1,
                    "offline_sequence_lease_end": 100
                }),
            ),
            OTHER_SESSION_ID,
        );
        assert!(matches!(
            create.numbering_lease,
            RepairNumberingLease::Sequence { .. }
        ));
        authorize_repair_actor(&scope(), OTHER_SESSION_ID, "repairs.create", now()).unwrap();
        assert_eq!(
            authorize_repair_actor(&scope(), OTHER_SESSION_ID, "repairs.read", now())
                .unwrap_err()
                .code(),
            "REPAIR_PERMISSION_DENIED"
        );
    }

    #[test]
    fn actor_expiry_and_actor_switch_fail_closed() {
        let _keyring = fake_keyring::install_empty();
        persist(
            bootstrap(
                SESSION_ID,
                &["repairs.read"],
                serde_json::json!({ "kind": "none" }),
            ),
            SESSION_ID,
        );
        assert_eq!(
            authorize_repair_actor(&scope(), OTHER_SESSION_ID, "repairs.read", now())
                .unwrap_err()
                .code(),
            "REPAIR_ACTOR_MISMATCH"
        );
        assert_eq!(
            authorize_repair_actor(
                &scope(),
                SESSION_ID,
                "repairs.read",
                now() + chrono::Duration::hours(2),
            )
            .unwrap_err()
            .code(),
            "REPAIR_ACTOR_EXPIRED"
        );

        persist(
            bootstrap(
                OTHER_SESSION_ID,
                &["repairs.update"],
                serde_json::json!({ "kind": "none" }),
            ),
            OTHER_SESSION_ID,
        );
        assert_eq!(
            authorize_repair_actor(&scope(), SESSION_ID, "repairs.read", now())
                .unwrap_err()
                .code(),
            "REPAIR_ACTOR_MISMATCH"
        );
        authorize_repair_actor(&scope(), OTHER_SESSION_ID, "repairs.update", now()).unwrap();
    }

    #[test]
    fn actor_clear_and_reset_managed_key_invalidation_are_complete() {
        let _keyring = fake_keyring::install_empty();
        persist(
            bootstrap(
                SESSION_ID,
                &["repairs.read"],
                serde_json::json!({ "kind": "none" }),
            ),
            SESSION_ID,
        );
        assert!(crate::storage::managed_keys()
            .contains(&crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1));
        clear_repair_actor_attestation().unwrap();
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_none()
        );
    }

    #[test]
    fn secure_session_replacement_retains_only_the_same_canonical_actor() {
        let _keyring = fake_keyring::install_empty();
        persist(
            bootstrap(
                SESSION_ID,
                &["repairs.read"],
                serde_json::json!({ "kind": "none" }),
            ),
            SESSION_ID,
        );
        invalidate_repair_actor_for_session_claim(
            &serde_json::json!({ "sessionId": SESSION_ID }).to_string(),
        )
        .unwrap();
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_some()
        );

        invalidate_repair_actor_for_session_claim(
            &serde_json::json!({ "sessionId": OTHER_SESSION_ID }).to_string(),
        )
        .unwrap();
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_none()
        );

        persist(
            bootstrap(
                SESSION_ID,
                &["repairs.read"],
                serde_json::json!({ "kind": "none" }),
            ),
            SESSION_ID,
        );
        invalidate_repair_actor_for_session_claim("malformed-renderer-session").unwrap();
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_none()
        );
    }

    #[test]
    fn native_permission_map_is_exact_for_commands_and_transport() {
        let transfer = RepairTypedCommand::TransferBranch {
            destination_branch_id: BRANCH_ID.to_string(),
        };
        assert_eq!(
            required_permission_for_typed_command(&transfer),
            "repairs.transfer"
        );
        assert_eq!(
            required_permission_for_typed_command(&RepairTypedCommand::RecordApproval {
                approval_id: STAFF_ID.to_string(),
                estimate_id: None,
                decision: "accepted".to_string(),
                decision_source: "in_person".to_string(),
                reason: None,
            }),
            "repairs.approve"
        );
        assert_eq!(
            required_permission_for_json_request(&RepairJsonRequest::Payment {
                repair_id: STAFF_ID.to_string(),
                operation_id: SESSION_ID.to_string(),
                expected_version: 1,
                occurred_at: "2026-08-26T10:00:00.000Z".to_string(),
                amount_minor: 1,
                payment_method: "cash".to_string(),
                provider_reference: None,
            })
            .unwrap(),
            "repairs.payments.collect"
        );
        assert!(
            required_permission_for_json_request(&RepairJsonRequest::OfflineBootstrap {}).is_err()
        );
    }

    #[test]
    fn actor_debug_and_renderer_snapshots_never_expose_attestation() {
        let _keyring = fake_keyring::install_empty();
        persist(
            bootstrap(
                SESSION_ID,
                &["repairs.read"],
                serde_json::json!({ "kind": "none" }),
            ),
            SESSION_ID,
        );
        let actor = authorize_repair_actor(&scope(), SESSION_ID, "repairs.read", now()).unwrap();
        let debug = format!("{actor:?}");
        for forbidden in [
            SESSION_ID,
            STAFF_ID,
            ORGANIZATION_ID,
            BRANCH_ID,
            TERMINAL_ID,
        ] {
            assert!(!debug.contains(forbidden));
        }
    }
}
