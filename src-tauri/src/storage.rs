//! Secure terminal config storage using the OS credential store.
//!
//! On Windows this uses DPAPI (via the `keyring` crate), on macOS Keychain,
//! and on Linux the Secret Service API. This replaces Electron's
//! `safeStorage` + flat-file approach.

use keyring::Entry;
use serde_json::Value;
use tracing::warn;
use zeroize::Zeroizing;

// Keyring service name. Production reads/writes `the-small-pos`. Tests
// that seed/clean credentials via `storage::set_credential` /
// `storage::delete_credential` (notably `credential_guard()` in
// `terminal_helpers::tests`) would otherwise overwrite and later wipe the
// operator's real onboarded credentials — every `cargo test` run would
// silently kick the live POS back into onboarding. Using a separate
// `the-small-pos-test` namespace under `#[cfg(test)]` isolates test
// state completely so production keyring entries survive any number of
// test runs.
#[cfg(not(test))]
const SERVICE_NAME: &str = "the-small-pos";
#[cfg(test)]
const SERVICE_NAME: &str = "the-small-pos-test";

// Credential keys
const KEY_ADMIN_URL: &str = "admin_dashboard_url";
const KEY_TERMINAL_ID: &str = "terminal_id";
const KEY_API_KEY: &str = "pos_api_key";
const KEY_BRANCH_ID: &str = "branch_id";
const KEY_ORG_ID: &str = "organization_id";
const KEY_BUSINESS_TYPE: &str = "business_type";
const KEY_SUPABASE_URL: &str = "supabase_url";
const KEY_SUPABASE_ANON_KEY: &str = "supabase_anon_key";
const KEY_GHOST_MODE_FEATURE_ENABLED: &str = "ghost_mode_feature_enabled";
pub const KEY_REPAIR_QUEUE_AES_KEY_V1: &str = "repair_queue_aes_key_v1";
pub const KEY_REPAIR_SCOPE_V1: &str = "repair_scope_v1";
pub const KEY_REPAIR_ENTITLEMENT_V1: &str = "repair_entitlement_v1";
pub const KEY_REPAIR_ACTOR_ATTESTATION_V1: &str = "repair_actor_attestation_v1";
pub const KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1: &str = "repair_scope_transition_journal_v1";
pub const KEY_CALLERID_SIP_PASSWORD: &str = "callerid_sip_password";
pub const KEY_CALLERID_ACTIVATION_CACHE_MANIFEST: &str = "callerid_activation_cache_manifest_v1";
pub const CALLERID_ACTIVATION_CACHE_BANK_A_KEYS: [&str; 8] = [
    "callerid_activation_cache_a0_v1",
    "callerid_activation_cache_a1_v1",
    "callerid_activation_cache_a2_v1",
    "callerid_activation_cache_a3_v1",
    "callerid_activation_cache_a4_v1",
    "callerid_activation_cache_a5_v1",
    "callerid_activation_cache_a6_v1",
    "callerid_activation_cache_a7_v1",
];
pub const CALLERID_ACTIVATION_CACHE_BANK_B_KEYS: [&str; 8] = [
    "callerid_activation_cache_b0_v1",
    "callerid_activation_cache_b1_v1",
    "callerid_activation_cache_b2_v1",
    "callerid_activation_cache_b3_v1",
    "callerid_activation_cache_b4_v1",
    "callerid_activation_cache_b5_v1",
    "callerid_activation_cache_b6_v1",
    "callerid_activation_cache_b7_v1",
];
/// Renderer-side authenticated session blob. Wave 1 C6 moved this out of
/// renderer-accessible `localStorage` because the stored object includes
/// `sessionId`, `staffId`, `branchId`, and `organizationId` — all of which
/// amount to live credentials. The OS keyring keeps the blob out of the
/// JavaScript heap except for the moment it is fetched over the IPC.
const KEY_POS_SESSION: &str = "pos_session";
const KEY_LAN_PAIRS_V1: &str = "cafe_lan_pairs_v1";

/// All credential keys managed by this module.
const ALL_KEYS: &[&str] = &[
    // Reset helpers must remove the durable repair barrier before generic
    // terminal identity keys; otherwise the identity-write interceptor would
    // correctly reject those deletes while reset_pending is latched.
    KEY_REPAIR_SCOPE_V1,
    KEY_REPAIR_QUEUE_AES_KEY_V1,
    KEY_REPAIR_ENTITLEMENT_V1,
    KEY_REPAIR_ACTOR_ATTESTATION_V1,
    KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1,
    KEY_LAN_PAIRS_V1,
    KEY_ADMIN_URL,
    KEY_TERMINAL_ID,
    KEY_API_KEY,
    KEY_BRANCH_ID,
    KEY_ORG_ID,
    KEY_BUSINESS_TYPE,
    KEY_SUPABASE_URL,
    KEY_SUPABASE_ANON_KEY,
    KEY_GHOST_MODE_FEATURE_ENABLED,
    KEY_CALLERID_SIP_PASSWORD,
    KEY_CALLERID_ACTIVATION_CACHE_MANIFEST,
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[0],
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[1],
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[2],
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[3],
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[4],
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[5],
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[6],
    CALLERID_ACTIVATION_CACHE_BANK_A_KEYS[7],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[0],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[1],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[2],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[3],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[4],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[5],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[6],
    CALLERID_ACTIVATION_CACHE_BANK_B_KEYS[7],
    KEY_POS_SESSION,
];

fn is_native_repair_private_key(key: &str) -> bool {
    matches!(
        key.trim().to_ascii_lowercase().as_str(),
        KEY_REPAIR_QUEUE_AES_KEY_V1
            | KEY_REPAIR_SCOPE_V1
            | KEY_REPAIR_ENTITLEMENT_V1
            | KEY_REPAIR_ACTOR_ATTESTATION_V1
            | KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1
    )
}

fn is_native_repair_actor_key(key: &str) -> bool {
    key.trim()
        .eq_ignore_ascii_case(KEY_REPAIR_ACTOR_ATTESTATION_V1)
}

fn is_lan_pair_private_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    normalized == KEY_LAN_PAIRS_V1 || normalized.starts_with("cafe_lan_pair_v1:")
}

fn lan_pair_store_mutex() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}

fn validate_lan_pair_key(key: &str) -> Result<(), String> {
    if !key.starts_with("cafe_lan_pair_v1:")
        || key.len() <= "cafe_lan_pair_v1:".len()
        || key.len() > 280
        || key.chars().any(char::is_control)
    {
        return Err("LAN_PAIR_CREDENTIAL_INVALID".into());
    }
    Ok(())
}

fn validate_lan_pair_record(key: &str, record: &Value) -> Result<(), String> {
    validate_lan_pair_key(key)?;
    let fields = record.as_object().ok_or("LAN_PAIR_CREDENTIAL_INVALID")?;
    let expected = [
        "organization_id",
        "branch_id",
        "parent_terminal_id",
        "source_terminal_id",
        "secret_hex",
    ];
    if fields.len() != expected.len() || expected.iter().any(|field| !fields.contains_key(*field)) {
        return Err("LAN_PAIR_CREDENTIAL_INVALID".to_string());
    }
    for field in &expected[..4] {
        let id = record[*field]
            .as_str()
            .ok_or("LAN_PAIR_CREDENTIAL_INVALID")?;
        if id.is_empty() || id.len() > 255 || id.chars().any(char::is_control) {
            return Err("LAN_PAIR_CREDENTIAL_INVALID".to_string());
        }
    }
    for field in ["organization_id", "branch_id"] {
        uuid::Uuid::parse_str(record[field].as_str().unwrap())
            .map_err(|_| "LAN_PAIR_CREDENTIAL_INVALID")?;
    }
    let source = record["source_terminal_id"].as_str().unwrap();
    if key != format!("cafe_lan_pair_v1:{source}") || key.len() > 280 {
        return Err("LAN_PAIR_CREDENTIAL_INVALID".to_string());
    }
    let secret = record["secret_hex"]
        .as_str()
        .ok_or("LAN_PAIR_CREDENTIAL_INVALID")?;
    if secret.len() != 64 || !secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("LAN_PAIR_CREDENTIAL_INVALID".to_string());
    }
    Ok(())
}

fn read_lan_pair_store() -> Result<serde_json::Map<String, Value>, String> {
    let Some(encoded) = get_credential_strict(KEY_LAN_PAIRS_V1)? else {
        return Ok(serde_json::Map::new());
    };
    if encoded.len() > 2048 {
        return Err("LAN_PAIR_STORE_INVALID".into());
    }
    let value: Value = serde_json::from_str(&encoded).map_err(|_| "LAN_PAIR_STORE_INVALID")?;
    let pairs = value.as_object().ok_or("LAN_PAIR_STORE_INVALID")?;
    if pairs.len() > 2 {
        return Err("LAN_PAIR_STORE_INVALID".into());
    }
    for (key, record) in pairs {
        validate_lan_pair_record(key, record).map_err(|_| "LAN_PAIR_STORE_INVALID")?;
    }
    Ok(pairs.clone())
}

fn write_lan_pair_store(pairs: &serde_json::Map<String, Value>) -> Result<(), String> {
    if pairs.is_empty() {
        delete_credential_uncoordinated(KEY_LAN_PAIRS_V1)?;
        if get_credential_strict(KEY_LAN_PAIRS_V1)?.is_some() {
            return Err("LAN_PAIR_STORE_VERIFY_FAILED".into());
        }
        return Ok(());
    }
    if pairs.len() > 2 {
        return Err("LAN_PAIR_CAPACITY_EXCEEDED".into());
    }
    let encoded =
        Zeroizing::new(serde_json::to_string(pairs).map_err(|_| "LAN_PAIR_STORE_INVALID")?);
    // One managed credential also fits Windows' credential blob bound and
    // ensures reset can remove every pair without an unreliable key index.
    if encoded.len() > 2048 {
        return Err("LAN_PAIR_CAPACITY_EXCEEDED".into());
    }
    set_credential_uncoordinated(KEY_LAN_PAIRS_V1, &encoded)?;
    if get_credential_strict(KEY_LAN_PAIRS_V1)?
        .as_deref()
        .map(String::as_str)
        != Some(encoded.as_str())
    {
        return Err("LAN_PAIR_STORE_VERIFY_FAILED".into());
    }
    Ok(())
}

pub(crate) fn get_lan_pair_record(key: &str) -> Result<Option<Zeroizing<String>>, String> {
    validate_lan_pair_key(key)?;
    read_lan_pair_store()?
        .get(key)
        .map(|record| {
            serde_json::to_string(record)
                .map(Zeroizing::new)
                .map_err(|_| "LAN_PAIR_STORE_INVALID".into())
        })
        .transpose()
}

pub(crate) fn set_lan_pair_record(key: &str, record_json: &str) -> Result<(), String> {
    let record: Value =
        serde_json::from_str(record_json).map_err(|_| "LAN_PAIR_CREDENTIAL_INVALID")?;
    validate_lan_pair_record(key, &record)?;
    let _guard = lan_pair_store_mutex()
        .lock()
        .map_err(|_| "LAN_PAIR_STORE_UNAVAILABLE")?;
    let mut pairs = read_lan_pair_store()?;
    pairs.insert(key.to_string(), record);
    write_lan_pair_store(&pairs)
}

pub(crate) fn delete_lan_pair_credential(key: &str) -> Result<(), String> {
    validate_lan_pair_key(key)?;
    let _guard = lan_pair_store_mutex()
        .lock()
        .map_err(|_| "LAN_PAIR_STORE_UNAVAILABLE")?;
    let mut pairs = read_lan_pair_store()?;
    pairs.remove(key);
    write_lan_pair_store(&pairs)
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/// Retrieve a single credential from the OS keyring. Returns `None` when the
/// entry does not exist (or the platform returns a "not found" error).
///
/// Under `#[cfg(test)]`, if a `tests::fake_keyring` is installed on the
/// current thread this delegates to the fake — tests that opt in get
/// hermetic, parallel-safe credential storage. Tests that do not install
/// a fake see the existing real-OS-keyring behaviour (namespaced to
/// `the-small-pos-test`).
pub fn get_credential(key: &str) -> Option<String> {
    if is_lan_pair_private_key(key) {
        return None;
    }
    match get_credential_strict(key) {
        Ok(value) => value.map(|value| value.to_string()),
        Err(error) => {
            warn!(key, error = %error, "keyring: failed to read credential");
            None
        }
    }
}

/// Strict keyring read used by native repair security state. Only an actual
/// `NoEntry` becomes `Ok(None)`; backend/entry errors remain distinguishable
/// so callers never rotate a key merely because the credential store failed.
pub(crate) fn get_credential_strict(key: &str) -> Result<Option<Zeroizing<String>>, String> {
    #[cfg(test)]
    if crate::tests::fake_keyring::is_installed() {
        return crate::tests::fake_keyring::get_strict(key).map(|value| value.map(Zeroizing::new));
    }

    let entry =
        Entry::new(SERVICE_NAME, key).map_err(|_| "KEYRING_ENTRY_UNAVAILABLE".to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(Some(Zeroizing::new(password))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("KEYRING_READ_FAILED".to_string()),
    }
}

/// Store a credential in the OS keyring.
///
/// Honours an installed `tests::fake_keyring` under `#[cfg(test)]`
/// (see [`get_credential`] for the rationale).
pub fn set_credential(key: &str, value: &str) -> Result<(), String> {
    if is_lan_pair_private_key(key) {
        return Err("LAN_PAIR_NATIVE_ONLY".to_string());
    }
    if is_terminal_binding_key(key) {
        return Err("TERMINAL_CREDENTIAL_OWNER_REQUIRED".to_string());
    }
    if key
        .trim()
        .eq_ignore_ascii_case(KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1)
    {
        return Err("REPAIR_TRANSITION_JOURNAL_NATIVE_ONLY".to_string());
    }
    if is_native_repair_actor_key(key) {
        return Err("REPAIR_ACTOR_ATTESTATION_NATIVE_ONLY".to_string());
    }
    crate::repairs::coordinated_identity_credential_write(key, Some(value), || {
        set_credential_uncoordinated(key, value)
    })
}

fn is_terminal_binding_key(key: &str) -> bool {
    matches!(
        key.trim().to_ascii_lowercase().as_str(),
        KEY_API_KEY | KEY_TERMINAL_ID | KEY_ADMIN_URL | KEY_ORG_ID | KEY_BRANCH_ID
    )
}

pub(crate) fn set_terminal_credential(
    _owner: &crate::commands::settings::TerminalCredentialOwner,
    key: &str,
    value: &str,
) -> Result<(), String> {
    if !is_terminal_binding_key(key) {
        return Err("TERMINAL_CREDENTIAL_KEY_REQUIRED".to_string());
    }
    crate::repairs::coordinated_identity_credential_write(key, Some(value), || {
        set_credential_uncoordinated(key, value)
    })
}

#[cfg(test)]
pub(crate) fn seed_terminal_credential_for_test(key: &str, value: &str) -> Result<(), String> {
    if !is_terminal_binding_key(key) {
        return Err("TERMINAL_CREDENTIAL_KEY_REQUIRED".to_string());
    }
    set_credential_uncoordinated(key, value)
}

/// Persist the server-issued repair actor from the strict native bootstrap
/// path. Keeping this seam crate-private prevents renderer-facing generic
/// settings commands from minting or replacing offline repair authority.
pub(crate) fn set_repair_actor_attestation(value: &str) -> Result<(), String> {
    set_credential_uncoordinated(KEY_REPAIR_ACTOR_ATTESTATION_V1, value)
}

pub(crate) fn read_repair_transition_journal() -> Result<Option<Zeroizing<String>>, String> {
    get_credential_strict(KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1)
        .map_err(|_| "REPAIR_TRANSITION_JOURNAL_UNAVAILABLE".to_string())
}

pub(crate) fn write_repair_transition_journal(value: &str) -> Result<(), String> {
    set_credential_uncoordinated(KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1, value)
        .map_err(|_| "REPAIR_TRANSITION_JOURNAL_WRITE_FAILED".to_string())?;
    let stored = get_credential_strict(KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1)
        .map_err(|_| "REPAIR_TRANSITION_JOURNAL_WRITE_FAILED".to_string())?;
    if stored.as_ref().map(|stored| stored.as_str()) != Some(value) {
        return Err("REPAIR_TRANSITION_JOURNAL_WRITE_FAILED".to_string());
    }
    Ok(())
}

pub(crate) fn delete_repair_transition_journal() -> Result<(), String> {
    delete_credential_uncoordinated(KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1)
        .map_err(|_| "REPAIR_TRANSITION_JOURNAL_DELETE_FAILED".to_string())?;
    if get_credential_strict(KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1)
        .map_err(|_| "REPAIR_TRANSITION_JOURNAL_DELETE_FAILED".to_string())?
        .is_some()
    {
        return Err("REPAIR_TRANSITION_JOURNAL_DELETE_FAILED".to_string());
    }
    Ok(())
}

fn set_credential_uncoordinated(key: &str, value: &str) -> Result<(), String> {
    #[cfg(test)]
    if crate::tests::fake_keyring::is_installed() {
        crate::tests::fake_keyring::set_checked(key, value)?;
        return Ok(());
    }

    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a credential from the OS keyring. Silently succeeds if the entry
/// does not exist.
///
/// Honours an installed `tests::fake_keyring` under `#[cfg(test)]`.
pub fn delete_credential(key: &str) -> Result<(), String> {
    if is_lan_pair_private_key(key) {
        return Err("LAN_PAIR_NATIVE_ONLY".to_string());
    }
    if is_terminal_binding_key(key) {
        return Err("TERMINAL_CREDENTIAL_OWNER_REQUIRED".to_string());
    }
    if key
        .trim()
        .eq_ignore_ascii_case(KEY_REPAIR_SCOPE_TRANSITION_JOURNAL_V1)
    {
        return Err("REPAIR_TRANSITION_JOURNAL_NATIVE_ONLY".to_string());
    }
    if is_native_repair_actor_key(key) {
        return Err("REPAIR_ACTOR_ATTESTATION_NATIVE_ONLY".to_string());
    }
    crate::repairs::coordinated_identity_credential_write(key, None, || {
        delete_credential_uncoordinated(key)
    })
}

pub(crate) fn delete_terminal_credential(
    _owner: &crate::commands::settings::TerminalCredentialOwner,
    key: &str,
) -> Result<(), String> {
    if !is_terminal_binding_key(key) {
        return Err("TERMINAL_CREDENTIAL_KEY_REQUIRED".to_string());
    }
    crate::repairs::coordinated_identity_credential_write(key, None, || {
        delete_credential_uncoordinated(key)
    })
}

/// Remove the managed repair actor only from native authentication/lifecycle
/// code. Factory/emergency reset still owns the key through `managed_keys()`.
pub(crate) fn delete_repair_actor_attestation() -> Result<(), String> {
    delete_credential_uncoordinated(KEY_REPAIR_ACTOR_ATTESTATION_V1)
}

fn delete_credential_uncoordinated(key: &str) -> Result<(), String> {
    #[cfg(test)]
    if crate::tests::fake_keyring::is_installed() {
        crate::tests::fake_keyring::delete_checked(key)?;
        return Ok(());
    }

    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete one exact reset-manifest credential after the reset helper has
/// passed its native authorization, immutable ownership and claim-once gates.
pub(crate) fn delete_managed_credential_for_reset(
    owner: &crate::reset::ResetCredentialOwner,
    key: &str,
) -> Result<(), String> {
    if !owner.authorizes(key) || !ALL_KEYS.contains(&key) {
        return Err("RESET_CREDENTIAL_KEY_NOT_AUTHORIZED".to_string());
    }
    delete_credential_uncoordinated(key)
        .map_err(|_| "RESET_CREDENTIAL_DELETE_FAILED".to_string())?;
    match get_credential_strict(key) {
        Ok(None) => Ok(()),
        Ok(Some(_)) | Err(_) => Err("RESET_CREDENTIAL_DELETE_VERIFY_FAILED".to_string()),
    }
}

/// Clear the complete native repair identity while the caller already owns
/// `RepairTransitionGuard`. This deliberately bypasses the public identity
/// coordinator, whose non-reentrant transition mutex is already held.
pub(crate) fn delete_repair_identity_uncoordinated() -> Result<(), String> {
    let keys = [KEY_ORG_ID, KEY_BRANCH_ID, KEY_TERMINAL_ID];
    let mut failed = false;
    for key in keys {
        failed |= delete_credential_uncoordinated(key).is_err();
    }
    for key in keys {
        match get_credential_strict(key) {
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => failed = true,
        }
    }
    if failed {
        Err("REPAIR_IDENTITY_CLEAR_FAILED".to_string())
    } else {
        Ok(())
    }
}

/// Replace the three native repair scope identities while the repair lifecycle
/// coordinator already owns its non-reentrant transition mutex. Calling the
/// public `set_credential` functions here would attempt to acquire that mutex a
/// second time and deadlock. This seam is intentionally narrow and verifies a
/// complete read-back before returning.
#[derive(Clone, Debug)]
pub(crate) struct RepairIdentityCredentialSnapshot {
    values: [Option<String>; 3],
}

fn restore_identity_values_uncoordinated(values: &[Option<String>; 3]) -> Result<(), String> {
    let keys = [KEY_ORG_ID, KEY_BRANCH_ID, KEY_TERMINAL_ID];
    let mut write_failed = false;

    // Attempt every field even after one failure so compensation has the best
    // possible chance of restoring a coherent identity rather than stopping
    // with a deliberately mixed tenant scope.
    for (key, value) in keys.iter().zip(values.iter()) {
        let result = match value.as_deref() {
            Some(value) => set_credential_uncoordinated(key, value),
            None => delete_credential_uncoordinated(key),
        };
        write_failed |= result.is_err();
    }

    let readback = keys
        .iter()
        .map(|key| get_credential_strict(key).map(|value| value.map(|value| value.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    if write_failed || readback.as_slice() != values.as_slice() {
        return Err("REPAIR_IDENTITY_COMPENSATION_FAILED".to_string());
    }
    Ok(())
}

pub(crate) fn restore_repair_identity_uncoordinated(
    snapshot: &RepairIdentityCredentialSnapshot,
) -> Result<(), String> {
    restore_identity_values_uncoordinated(&snapshot.values)
}

pub(crate) fn replace_repair_identity_uncoordinated(
    organization_id: &str,
    branch_id: &str,
    terminal_id: &str,
) -> Result<RepairIdentityCredentialSnapshot, String> {
    let replacements = [
        (KEY_ORG_ID, organization_id),
        (KEY_BRANCH_ID, branch_id),
        (KEY_TERMINAL_ID, terminal_id),
    ];
    let previous = replacements
        .iter()
        .map(|(key, _)| {
            get_credential_strict(key).map(|value| value.map(|value| value.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let snapshot = RepairIdentityCredentialSnapshot {
        values: previous
            .try_into()
            .map_err(|_| "REPAIR_IDENTITY_READBACK_FAILED".to_string())?,
    };

    for (key, value) in replacements.iter() {
        if set_credential_uncoordinated(key, value).is_err() {
            if restore_identity_values_uncoordinated(&snapshot.values).is_err() {
                crate::repairs::latch_startup_maintenance_failure();
                return Err("REPAIR_IDENTITY_COMPENSATION_FAILED".to_string());
            }
            return Err("REPAIR_IDENTITY_WRITE_FAILED".to_string());
        }
    }
    for (key, expected) in replacements.iter().copied() {
        let actual = match get_credential_strict(key) {
            Ok(value) => value,
            Err(_) => {
                if restore_identity_values_uncoordinated(&snapshot.values).is_err() {
                    crate::repairs::latch_startup_maintenance_failure();
                    return Err("REPAIR_IDENTITY_COMPENSATION_FAILED".to_string());
                }
                return Err("REPAIR_IDENTITY_READBACK_FAILED".to_string());
            }
        };
        if actual.as_ref().map(|value| value.as_str()) != Some(expected) {
            if restore_identity_values_uncoordinated(&snapshot.values).is_err() {
                crate::repairs::latch_startup_maintenance_failure();
                return Err("REPAIR_IDENTITY_COMPENSATION_FAILED".to_string());
            }
            return Err("REPAIR_IDENTITY_READBACK_FAILED".to_string());
        }
    }
    Ok(snapshot)
}

/// Returns `true` when the three mandatory credentials exist.
pub fn has_credential(key: &str) -> bool {
    get_credential(key).is_some()
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/// The terminal is considered configured when admin URL, terminal ID, and API
/// key are all present in the credential store.
pub fn is_configured() -> bool {
    has_credential(KEY_ADMIN_URL) && has_credential(KEY_TERMINAL_ID) && has_credential(KEY_API_KEY)
}

/// Return all stored terminal config as a JSON value that matches the shape
/// the React frontend expects.
#[allow(dead_code)]
pub fn get_full_config() -> Value {
    serde_json::json!({
        "terminal_id":     get_credential(KEY_TERMINAL_ID),
        "branch_id":       get_credential(KEY_BRANCH_ID),
        "organization_id": get_credential(KEY_ORG_ID),
        "admin_dashboard_url": get_credential(KEY_ADMIN_URL),
        "admin_url":       get_credential(KEY_ADMIN_URL),
        "business_type":   get_credential(KEY_BUSINESS_TYPE).unwrap_or_else(|| "food".to_string()),
        "ghost_mode_feature_enabled": get_credential(KEY_GHOST_MODE_FEATURE_ENABLED),
    })
}

// Store terminal credentials received during onboarding.
// ---------------------------------------------------------------------------
// POS session blob (Wave 1 C6)
// ---------------------------------------------------------------------------

/// Retrieve the persisted authenticated session blob, if any.
///
/// The blob is opaque to Rust — the renderer serialised it as JSON before
/// storing. We intentionally do not parse or schema-check it here: that
/// would couple the Rust keyring wrapper to the renderer's session shape,
/// which changes independently (e.g. when new fields are added on the JS
/// side). The renderer revalidates the blob on boot via its normal
/// session-validation flow, so a malformed blob is merely discarded.
pub fn session_get() -> Option<String> {
    get_credential(KEY_POS_SESSION)
}

/// Strict native repair session read. A missing staff session is an ordinary
/// `Ok(None)` sign-in prerequisite; an unavailable OS credential backend is a
/// distinct fail-closed result and must never be downgraded to "signed out".
pub(crate) fn session_get_strict() -> Result<Option<Zeroizing<String>>, String> {
    get_credential_strict(KEY_POS_SESSION)
        .map_err(|_| "REPAIR_SESSION_KEYRING_UNAVAILABLE".to_string())
}

/// Persist the authenticated session blob. `payload` must be pre-serialised
/// by the caller (the renderer uses `JSON.stringify`).
pub fn session_set(payload: &str) -> Result<(), String> {
    set_credential(KEY_POS_SESSION, payload)
}

/// Clear the persisted session blob. Silently succeeds if no session is
/// stored (matches `delete_credential`'s no-op-on-missing semantics).
pub fn session_clear() -> Result<(), String> {
    delete_credential(KEY_POS_SESSION)
}

/// Invalidate both legacy renderer session state and native repair authority.
/// Both deletes are attempted so a retry can converge even after one backend
/// operation fails; any failure keeps the lifecycle marker fail-closed.
pub(crate) fn invalidate_terminal_authority() -> Result<(), String> {
    let actor = delete_repair_actor_attestation();
    let session = session_clear();
    match (actor, session) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(actor), Ok(())) => Err(actor),
        (Ok(()), Err(session)) => Err(session),
        (Err(actor), Err(session)) => Err(format!(
            "terminal authority invalidation failed: actor={actor}; session={session}"
        )),
    }
}

#[allow(dead_code)]
/// Delete every stored credential (factory reset).
///
/// The generic surface is deliberately fail-closed. Only the reset helper's
/// manifest-bound `ResetCredentialOwner` may delete the complete managed set.
pub fn factory_reset() -> Result<Value, String> {
    Err("TERMINAL_CREDENTIAL_OWNER_REQUIRED".to_string())
}

/// Returns the full set of credential keys managed by this module.
pub fn managed_keys() -> &'static [&'static str] {
    ALL_KEYS
}

/// Read a single terminal config value by key name.
///
/// The `category` parameter is accepted for compatibility with the existing
/// `terminal_config_get_setting(category, key)` stub but is currently unused.
pub fn get_setting(category: Option<&str>, key: Option<&str>) -> Value {
    match key {
        Some(k)
            if is_native_repair_private_key(k)
                || crate::is_sensitive_setting_path(category.unwrap_or("terminal"), k) =>
        {
            Value::Null
        }
        Some(k) => match get_credential(k) {
            Some(v) => Value::String(v),
            None => Value::Null,
        },
        None => Value::Null,
    }
}

/// Generic settings getter. For now we read from the credential store; once
/// the SQLite database (M4) is available, `settings_get` / `settings_get_local`
/// will read from the `local_settings` table instead.
pub fn settings_get(key: Option<&str>) -> Value {
    match key {
        Some(k)
            if is_native_repair_private_key(k)
                || crate::is_sensitive_setting_path("general", k) =>
        {
            Value::Null
        }
        Some(k) => match get_credential(k) {
            Some(v) => Value::String(v),
            None => Value::Null,
        },
        None => Value::Null,
    }
}

#[cfg(test)]
mod lan_pair_credential_tests {
    use super::*;

    fn record(child: &str) -> String {
        serde_json::json!({
            "organization_id":"00000000-0000-4000-8000-000000000001",
            "branch_id":"00000000-0000-4000-8000-000000000002",
            "parent_terminal_id":"main-a",
            "source_terminal_id":child,
            "secret_hex":"ab".repeat(32)
        })
        .to_string()
    }

    #[test]
    fn lan_pair_secrets_are_native_only() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let key = "cafe_lan_pair_v1:waiter-a";
        let secret = record("waiter-a");
        set_lan_pair_record(key, &secret).unwrap();
        assert_eq!(
            get_lan_pair_record(key)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some(secret.as_str())
        );
        // No unindexed per-child credential remains after pairing.
        assert!(get_credential_strict(key).unwrap().is_none());
        for private in [key, KEY_LAN_PAIRS_V1] {
            assert!(get_credential(private).is_none());
            assert!(get_setting(Some("terminal"), Some(private)).is_null());
            assert!(settings_get(Some(private)).is_null());
            assert_eq!(
                set_credential(private, &secret),
                Err("LAN_PAIR_NATIVE_ONLY".to_string())
            );
            assert_eq!(
                delete_credential(private),
                Err("LAN_PAIR_NATIVE_ONLY".to_string())
            );
        }
        delete_lan_pair_credential(key).unwrap();
        assert!(get_lan_pair_record(key).unwrap().is_none());
        assert!(get_credential_strict(KEY_LAN_PAIRS_V1).unwrap().is_none());
        assert!(set_lan_pair_record("api_key", &secret).is_err());
    }

    #[test]
    fn pair_capacity_rotation_revocation_and_reset_are_durable() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        for child in ["waiter-a", "waiter-b"] {
            set_lan_pair_record(&format!("cafe_lan_pair_v1:{child}"), &record(child)).unwrap();
        }
        assert_eq!(
            set_lan_pair_record("cafe_lan_pair_v1:waiter-c", &record("waiter-c")),
            Err("LAN_PAIR_CAPACITY_EXCEEDED".into())
        );
        let rotated = record("waiter-a").replace(&"ab".repeat(32), &"cd".repeat(32));
        set_lan_pair_record("cafe_lan_pair_v1:waiter-a", &rotated).unwrap();
        assert_eq!(
            get_lan_pair_record("cafe_lan_pair_v1:waiter-a")
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some(rotated.as_str())
        );
        delete_lan_pair_credential("cafe_lan_pair_v1:waiter-a").unwrap();
        assert!(get_lan_pair_record("cafe_lan_pair_v1:waiter-b")
            .unwrap()
            .is_some());
        crate::reset::factory_reset_with_authorized_owner_for_test().unwrap();
        assert!(get_lan_pair_record("cafe_lan_pair_v1:waiter-b")
            .unwrap()
            .is_none());
    }

    #[test]
    fn corrupt_pair_map_cannot_rotate_but_reset_still_removes_it() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        set_credential_uncoordinated(KEY_LAN_PAIRS_V1, "corrupt").unwrap();
        assert!(get_lan_pair_record("cafe_lan_pair_v1:waiter-a").is_err());
        assert!(set_lan_pair_record("cafe_lan_pair_v1:waiter-a", &record("waiter-a")).is_err());
        crate::reset::factory_reset_with_authorized_owner_for_test().unwrap();
        assert!(get_credential_strict(KEY_LAN_PAIRS_V1).unwrap().is_none());
    }
}
