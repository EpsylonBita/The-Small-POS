//! The staff PIN hashes a main till checks a check-in against when the server
//! cannot be reached (founder decision 13/10/2026: the desktop follows the
//! Android rules of PR #356, `StaffPinHashVault`).
//!
//! The hashes are the server's own bcrypt hashes from the staff directory of
//! this till's branch, for everyone it lists with a PIN, whatever their role:
//! every role checks in offline (founder, 15/10/2026). They live in the OS credential store only (Windows
//! Credential Manager through `storage.rs`), never in SQLite and never where
//! the renderer can read them: the vault keys are native-only, and the
//! directory cache, the cached admin responses and the settings reads are
//! stripped of `pinHash`/`pin_hash` ([`redact_pin_hashes`]).
//!
//! No server counts wrong PINs offline, so five wrong PINs lock that person
//! out of offline check-in for 15 minutes. The count is kept with the hashes,
//! so a restart does not reset it.
//!
//! Storage: one JSON document split into chunks below the Windows credential
//! blob bound, written to the inactive of two banks before the manifest names
//! it, as `callerid/activation.rs` does. A crash can only lose the new copy.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};
use tracing::warn;
use zeroize::Zeroizing;

use crate::storage::{
    KEY_STAFF_PIN_VAULT_MANIFEST, STAFF_PIN_VAULT_BANK_A_KEYS, STAFF_PIN_VAULT_BANK_B_KEYS,
};

pub(crate) const OFFLINE_PIN_MAX_FAILURES: u32 = 5;
pub(crate) const OFFLINE_PIN_LOCKOUT_MINUTES: i64 = 15;
const VAULT_VERSION: u8 = 1;
// Windows Credential Manager accepts at most 2560 bytes per generic
// credential; 900 UTF-16 code units leave room for the platform encoding.
const CHUNK_UTF16_UNITS: usize = 900;

/// One person as the vault holds them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct VaultEntry {
    #[serde(rename = "h")]
    pub hash: String,
    #[serde(rename = "a", default)]
    pub active: bool,
    #[serde(rename = "l", default)]
    pub can_login_pos: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FailureState {
    #[serde(rename = "c")]
    pub count: u32,
    #[serde(rename = "u", default, skip_serializing_if = "Option::is_none")]
    pub locked_until: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct VaultDoc {
    pub v: u8,
    pub branch_id: String,
    pub saved_at: String,
    pub staff: BTreeMap<String, VaultEntry>,
    #[serde(default)]
    pub failures: BTreeMap<String, FailureState>,
}

/// A directory entry as far as the vault is concerned (parsed by `auth.rs`,
/// which owns the directory's field aliases).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DirectoryPinEntry {
    pub id: String,
    /// The hash the directory sent, if any.
    pub hash: Option<String>,
    /// The directory says the person has no PIN (any held hash is dropped).
    pub pin_removed: bool,
    pub active: bool,
    pub can_login_pos: bool,
}

/// The outcome of a PIN this till checked itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OfflinePinCheck {
    Accepted,
    /// No usable hash for this person on this till (or the vault cannot be
    /// read or written): the server is needed.
    Unavailable,
    /// The directory says this person may not log in to the POS.
    NotAllowed,
    Locked {
        until: DateTime<Utc>,
    },
    Mismatch {
        locked_until: Option<DateTime<Utc>>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Bank {
    A,
    B,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    v: u8,
    bank: Bank,
    chunks: usize,
}

fn bank_keys(bank: Bank) -> &'static [&'static str; 16] {
    match bank {
        Bank::A => &STAFF_PIN_VAULT_BANK_A_KEYS,
        Bank::B => &STAFF_PIN_VAULT_BANK_B_KEYS,
    }
}

/// One process-wide owner for read-modify-write of the vault.
fn vault_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn is_bcrypt_hash(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 60
        && value.starts_with("$2")
        && matches!(bytes[2], b'a' | b'b' | b'y')
        && bytes[3] == b'$'
        && bytes[4].is_ascii_digit()
        && bytes[5].is_ascii_digit()
        && bytes[6] == b'$'
}

// ---------------------------------------------------------------------------
// Backend: the OS credential store. Unit tests that do not install the fake
// keyring get a per-thread store, so parallel tests never share the fixed
// vault keys (nor touch the developer's real credential store).
// ---------------------------------------------------------------------------

#[cfg(test)]
thread_local! {
    static TEST_STORE: std::cell::RefCell<std::collections::HashMap<String, String>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(test)]
fn use_test_store() -> bool {
    !crate::tests::fake_keyring::is_installed()
}

fn backend_read(key: &str) -> Result<Option<Zeroizing<String>>, String> {
    #[cfg(test)]
    if use_test_store() {
        return Ok(TEST_STORE.with(|store| store.borrow().get(key).cloned().map(Zeroizing::new)));
    }
    crate::storage::staff_pin_vault_read(key)
}

fn backend_write(key: &str, value: &str) -> Result<(), String> {
    #[cfg(test)]
    if use_test_store() {
        TEST_STORE.with(|store| {
            store
                .borrow_mut()
                .insert(key.to_string(), value.to_string());
        });
        return Ok(());
    }
    crate::storage::staff_pin_vault_write(key, value)
}

fn backend_delete(key: &str) -> Result<(), String> {
    #[cfg(test)]
    if use_test_store() {
        TEST_STORE.with(|store| {
            store.borrow_mut().remove(key);
        });
        return Ok(());
    }
    crate::storage::staff_pin_vault_delete(key)
}

// ---------------------------------------------------------------------------
// Load / store
// ---------------------------------------------------------------------------

fn read_manifest() -> Result<Option<Manifest>, String> {
    let Some(raw) = backend_read(KEY_STAFF_PIN_VAULT_MANIFEST)? else {
        return Ok(None);
    };
    let manifest: Manifest =
        serde_json::from_str(&raw).map_err(|_| "STAFF_PIN_VAULT_INVALID".to_string())?;
    if manifest.v != VAULT_VERSION || manifest.chunks == 0 || manifest.chunks > 16 {
        return Err("STAFF_PIN_VAULT_INVALID".to_string());
    }
    Ok(Some(manifest))
}

/// The vault, or `None` when this till holds none. A store that cannot be
/// read is an error, never "no hashes".
fn load_unlocked() -> Result<Option<VaultDoc>, String> {
    let Some(manifest) = read_manifest()? else {
        return Ok(None);
    };
    let mut encoded = Zeroizing::new(String::new());
    for key in bank_keys(manifest.bank).iter().take(manifest.chunks) {
        let chunk = backend_read(key)?.ok_or_else(|| "STAFF_PIN_VAULT_INCOMPLETE".to_string())?;
        encoded.push_str(&chunk);
    }
    let mut doc: VaultDoc =
        serde_json::from_str(&encoded).map_err(|_| "STAFF_PIN_VAULT_INVALID".to_string())?;
    if doc.v != VAULT_VERSION {
        return Err("STAFF_PIN_VAULT_INVALID".to_string());
    }
    doc.staff.retain(|_, entry| is_bcrypt_hash(&entry.hash));
    Ok(Some(doc))
}

fn split_chunks(encoded: &str) -> Option<Vec<String>> {
    let mut chunks = Vec::<String>::new();
    let mut current = String::new();
    let mut units = 0usize;
    for character in encoded.chars() {
        let width = character.len_utf16();
        if units + width > CHUNK_UTF16_UNITS && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(character);
        units += width;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    (!chunks.is_empty() && chunks.len() <= STAFF_PIN_VAULT_BANK_A_KEYS.len()).then_some(chunks)
}

/// A vault that does not fit keeps the people who can use it: active, with
/// POS login allowed. Their role does not matter: every role checks in.
fn fit_to_capacity(doc: &mut VaultDoc) -> Result<Vec<String>, String> {
    for pass in 0..2 {
        if pass == 1 {
            doc.staff
                .retain(|_, entry| entry.active && entry.can_login_pos);
        }
        let staff = &doc.staff;
        doc.failures
            .retain(|staff_id, _| staff.contains_key(staff_id));
        let encoded = Zeroizing::new(
            serde_json::to_string(&*doc).map_err(|_| "STAFF_PIN_VAULT_INVALID".to_string())?,
        );
        if let Some(chunks) = split_chunks(&encoded) {
            if pass > 0 {
                warn!(
                    kept = doc.staff.len(),
                    "Staff PIN vault is over capacity; keeping the staff who can check in offline"
                );
            }
            return Ok(chunks);
        }
    }
    Err("STAFF_PIN_VAULT_CAPACITY".to_string())
}

fn store_unlocked(doc: &VaultDoc) -> Result<(), String> {
    let mut doc = doc.clone();
    let chunks = Zeroizing::new(fit_to_capacity(&mut doc)?);
    let current = read_manifest().ok().flatten().map(|manifest| manifest.bank);
    let target = match current {
        Some(Bank::A) => Bank::B,
        Some(Bank::B) | None => Bank::A,
    };
    let keys = bank_keys(target);
    for (index, chunk) in chunks.iter().enumerate() {
        backend_write(keys[index], chunk)?;
    }
    for key in keys.iter().skip(chunks.len()) {
        backend_delete(key)?;
    }
    let manifest = serde_json::to_string(&Manifest {
        v: VAULT_VERSION,
        bank: target,
        chunks: chunks.len(),
    })
    .map_err(|_| "STAFF_PIN_VAULT_INVALID".to_string())?;
    backend_write(KEY_STAFF_PIN_VAULT_MANIFEST, &manifest)?;
    // The previous copy still holds hashes of people the new one may have
    // dropped: remove it once the new one is live.
    if let Some(previous) = current {
        for key in bank_keys(previous) {
            if let Err(error) = backend_delete(key) {
                warn!(%error, "Previous staff PIN vault chunk could not be removed");
            }
        }
    }
    Ok(())
}

/// The vault this till holds, if any (tests). The terminal reset removes it
/// with every other managed credential (`storage::ALL_KEYS`); a new branch's
/// directory replaces it.
#[cfg(test)]
pub(crate) fn load() -> Result<Option<VaultDoc>, String> {
    let _guard = vault_lock();
    load_unlocked()
}

// ---------------------------------------------------------------------------
// Writes from the staff directory
// ---------------------------------------------------------------------------

/// The vault a fresh directory of `branch_id` gives. A person the directory
/// lists without a hash keeps the one already held, unless it says the PIN is
/// gone; a person no longer listed is dropped, with their wrong-PIN count.
pub(crate) fn vault_from_directory(
    branch_id: &str,
    directory: &[DirectoryPinEntry],
    previous: Option<&VaultDoc>,
    now: DateTime<Utc>,
) -> VaultDoc {
    let branch_id = branch_id.trim();
    let previous = previous.filter(|doc| doc.branch_id == branch_id);
    let mut staff = BTreeMap::new();
    let mut failures = BTreeMap::new();
    for entry in directory {
        let staff_id = entry.id.trim();
        if staff_id.is_empty() {
            continue;
        }
        let held = previous.and_then(|doc| doc.staff.get(staff_id));
        let hash = match entry.hash.as_deref().map(str::trim) {
            Some(hash) if is_bcrypt_hash(hash) => Some(hash.to_string()),
            _ if entry.pin_removed => None,
            _ => held.map(|held| held.hash.clone()),
        };
        let Some(hash) = hash else {
            continue;
        };
        staff.insert(
            staff_id.to_string(),
            VaultEntry {
                hash,
                active: entry.active,
                can_login_pos: entry.can_login_pos,
            },
        );
        if let Some(failure) = previous.and_then(|doc| doc.failures.get(staff_id)) {
            failures.insert(staff_id.to_string(), failure.clone());
        }
    }
    VaultDoc {
        v: VAULT_VERSION,
        branch_id: branch_id.to_string(),
        saved_at: now.to_rfc3339(),
        staff,
        failures,
    }
}

/// Replace the held hashes with those of a fresh directory of `branch_id`.
/// Unchanged content is not rewritten.
pub(crate) fn save_directory(
    branch_id: &str,
    directory: &[DirectoryPinEntry],
    now: DateTime<Utc>,
) -> Result<(), String> {
    let _guard = vault_lock();
    // An unreadable vault is replaced; its wrong-PIN counts cannot be kept.
    let previous = load_unlocked().unwrap_or_else(|error| {
        warn!(%error, "Staff PIN vault unreadable; replacing it from the directory");
        None
    });
    let next = vault_from_directory(branch_id, directory, previous.as_ref(), now);
    if let Some(previous) = previous.as_ref() {
        if previous.branch_id == next.branch_id
            && previous.staff == next.staff
            && previous.failures == next.failures
        {
            return Ok(());
        }
    }
    store_unlocked(&next)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// The hash of a person of `branch_id` who may log in to the POS, for a
/// manager's own-PIN approval. `None` when this till holds none.
pub(crate) fn hash_for(branch_id: &str, staff_id: &str) -> Option<String> {
    let _guard = vault_lock();
    let doc = match load_unlocked() {
        Ok(Some(doc)) if doc.branch_id == branch_id.trim() => doc,
        Ok(_) => return None,
        Err(error) => {
            warn!(%error, "Staff PIN vault unreadable");
            return None;
        }
    };
    doc.staff
        .get(staff_id.trim())
        .filter(|entry| entry.active && entry.can_login_pos)
        .map(|entry| entry.hash.clone())
}

fn parse_instant(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|instant| instant.with_timezone(&Utc))
}

/// Check `pin` against the hash this till holds for `staff_id`, counting
/// wrong tries. The PIN is never stored. A wrong PIN whose count cannot be
/// saved answers `Unavailable`: the lock must hold across a restart.
pub(crate) fn verify_offline(
    branch_id: &str,
    staff_id: &str,
    pin: &str,
    now: DateTime<Utc>,
) -> OfflinePinCheck {
    let _guard = vault_lock();
    let mut doc = match load_unlocked() {
        Ok(Some(doc)) if doc.branch_id == branch_id.trim() => doc,
        Ok(_) => return OfflinePinCheck::Unavailable,
        Err(error) => {
            warn!(%error, "Staff PIN vault unreadable; offline check-in unavailable");
            return OfflinePinCheck::Unavailable;
        }
    };
    let staff_id = staff_id.trim();
    let Some(entry) = doc.staff.get(staff_id).cloned() else {
        return OfflinePinCheck::Unavailable;
    };
    if !entry.active || !entry.can_login_pos {
        return OfflinePinCheck::NotAllowed;
    }

    let failure = doc.failures.get(staff_id).cloned();
    let locked_until = failure
        .as_ref()
        .and_then(|failure| failure.locked_until.as_deref())
        .and_then(parse_instant);
    if let Some(until) = locked_until.filter(|until| *until > now) {
        return OfflinePinCheck::Locked { until };
    }

    let matched = bcrypt::verify(pin, &entry.hash).unwrap_or(false);
    if matched {
        if failure.is_some() {
            doc.failures.remove(staff_id);
            if let Err(error) = store_unlocked(&doc) {
                warn!(%error, "Cleared wrong-PIN count could not be saved");
            }
        }
        return OfflinePinCheck::Accepted;
    }

    // A lock that ran out starts a fresh count.
    let count = if locked_until.is_some() {
        1
    } else {
        failure.map(|failure| failure.count).unwrap_or(0) + 1
    };
    let lock = (count >= OFFLINE_PIN_MAX_FAILURES)
        .then(|| now + Duration::minutes(OFFLINE_PIN_LOCKOUT_MINUTES));
    doc.failures.insert(
        staff_id.to_string(),
        FailureState {
            count,
            locked_until: lock.map(|until| until.to_rfc3339()),
        },
    );
    if let Err(error) = store_unlocked(&doc) {
        warn!(%error, "Wrong-PIN count could not be saved; offline check-in unavailable");
        return OfflinePinCheck::Unavailable;
    }
    OfflinePinCheck::Mismatch { locked_until: lock }
}

// ---------------------------------------------------------------------------
// Redaction: no copy of a hash reaches SQLite caches or the renderer
// ---------------------------------------------------------------------------

const HASH_KEYS: [&str; 2] = ["pin_hash", "pinHash"];

/// Remove every `pin_hash` / `pinHash` field, at any depth. Answers whether
/// anything was removed.
pub(crate) fn redact_pin_hashes(value: &mut Value) -> bool {
    match value {
        Value::Object(map) => {
            let mut removed = false;
            for key in HASH_KEYS {
                removed |= map.remove(key).is_some();
            }
            for child in map.values_mut() {
                removed |= redact_pin_hashes(child);
            }
            removed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |removed, item| redact_pin_hashes(item) | removed),
        _ => false,
    }
}

/// Cheap pre-check before parsing stored JSON text.
pub(crate) fn text_may_hold_pin_hash(raw: &str) -> bool {
    HASH_KEYS.iter().any(|key| raw.contains(key))
}

/// `raw` JSON text without its PIN hashes, or `None` when it holds none (or
/// is not JSON).
pub(crate) fn redact_pin_hashes_in_text(raw: &str) -> Option<String> {
    if !text_may_hold_pin_hash(raw) {
        return None;
    }
    let mut value = serde_json::from_str::<Value>(raw).ok()?;
    redact_pin_hashes(&mut value).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRANCH: &str = "branch-1";

    fn hash(pin: &str) -> String {
        bcrypt::hash(pin, 4).expect("hash test pin")
    }

    fn person(id: &str, pin_hash: Option<String>) -> DirectoryPinEntry {
        DirectoryPinEntry {
            id: id.to_string(),
            hash: pin_hash,
            pin_removed: false,
            active: true,
            can_login_pos: true,
        }
    }

    #[test]
    fn hashes_live_in_the_credential_store_and_survive_a_reload() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        save_directory(BRANCH, &[person("staff-1", Some(hash("4321")))], now).expect("save");

        assert!(crate::tests::fake_keyring::get(KEY_STAFF_PIN_VAULT_MANIFEST).is_some());
        // Native-only: the generic credential surface never hands them out.
        assert!(crate::storage::get_credential(KEY_STAFF_PIN_VAULT_MANIFEST).is_none());
        assert!(crate::storage::get_credential(STAFF_PIN_VAULT_BANK_A_KEYS[0]).is_none());
        assert_eq!(
            crate::storage::set_credential(STAFF_PIN_VAULT_BANK_A_KEYS[0], "x").unwrap_err(),
            "STAFF_PIN_VAULT_NATIVE_ONLY"
        );
        assert!(crate::storage::managed_keys().contains(&KEY_STAFF_PIN_VAULT_MANIFEST));

        let doc = load().expect("read").expect("vault");
        assert_eq!(doc.branch_id, BRANCH);
        assert!(doc.staff.contains_key("staff-1"));
        assert_eq!(
            verify_offline(BRANCH, "staff-1", "4321", now),
            OfflinePinCheck::Accepted
        );
        assert_eq!(
            verify_offline("branch-2", "staff-1", "4321", now),
            OfflinePinCheck::Unavailable
        );
    }

    #[test]
    fn five_wrong_pins_lock_the_person_for_fifteen_minutes_across_a_restart() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        save_directory(
            BRANCH,
            &[
                person("staff-1", Some(hash("4321"))),
                person("staff-2", Some(hash("1111"))),
            ],
            now,
        )
        .expect("save");

        for attempt in 1..OFFLINE_PIN_MAX_FAILURES {
            assert_eq!(
                verify_offline(BRANCH, "staff-1", "0000", now),
                OfflinePinCheck::Mismatch { locked_until: None },
                "attempt {attempt}"
            );
        }
        let until = now + Duration::minutes(OFFLINE_PIN_LOCKOUT_MINUTES);
        assert_eq!(
            verify_offline(BRANCH, "staff-1", "0000", now),
            OfflinePinCheck::Mismatch {
                locked_until: Some(until)
            }
        );
        // The right PIN does not open a lock; the count is in the
        // credential store, which is all a restart keeps.
        assert_eq!(
            verify_offline(BRANCH, "staff-1", "4321", now + Duration::minutes(14)),
            OfflinePinCheck::Locked { until }
        );
        assert_eq!(
            load().unwrap().unwrap().failures["staff-1"].count,
            OFFLINE_PIN_MAX_FAILURES
        );
        // Another person is not locked.
        assert!(matches!(
            verify_offline(BRANCH, "staff-2", "1111", now),
            OfflinePinCheck::Accepted { .. }
        ));
        // A directory refresh keeps the count of a person still listed.
        save_directory(BRANCH, &[person("staff-1", Some(hash("4321")))], now).unwrap();
        assert!(matches!(
            verify_offline(BRANCH, "staff-1", "4321", now + Duration::minutes(1)),
            OfflinePinCheck::Locked { .. }
        ));
        // Once the 15 minutes pass the right PIN works and clears the count.
        assert!(matches!(
            verify_offline(BRANCH, "staff-1", "4321", now + Duration::minutes(16)),
            OfflinePinCheck::Accepted { .. }
        ));
        assert!(load().unwrap().unwrap().failures.is_empty());
    }

    #[test]
    fn a_wrong_pin_whose_count_cannot_be_saved_closes_offline_check_in() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        save_directory(BRANCH, &[person("staff-1", Some(hash("4321")))], now).unwrap();
        crate::tests::fake_keyring::fail_writes_for(
            KEY_STAFF_PIN_VAULT_MANIFEST,
            "KEYRING_WRITE_FAILED",
        );

        assert_eq!(
            verify_offline(BRANCH, "staff-1", "0000", now),
            OfflinePinCheck::Unavailable
        );
    }

    #[test]
    fn a_directory_keeps_held_hashes_drops_removed_pins_and_unlisted_people() {
        let now = Utc::now();
        let previous = vault_from_directory(
            BRANCH,
            &[
                person("kept", Some(hash("1111"))),
                person("removed", Some(hash("2222"))),
                person("gone", Some(hash("3333"))),
            ],
            None,
            now,
        );
        let mut removed = person("removed", None);
        removed.pin_removed = true;
        let next = vault_from_directory(
            BRANCH,
            &[person("kept", None), removed],
            Some(&previous),
            now,
        );
        assert_eq!(next.staff.keys().collect::<Vec<_>>(), vec!["kept"]);
        assert_eq!(next.staff["kept"].hash, previous.staff["kept"].hash);

        // Another branch's vault never lends its hashes.
        let other = vault_from_directory("branch-2", &[person("kept", None)], Some(&previous), now);
        assert!(other.staff.is_empty());
    }

    #[test]
    fn a_non_bcrypt_hash_is_never_used() {
        let now = Utc::now();
        let doc = vault_from_directory(
            BRANCH,
            &[person(
                "staff-1",
                Some("5f4dcc3b5aa765d61d8327deb882cf99".into()),
            )],
            None,
            now,
        );
        assert!(doc.staff.is_empty());
    }

    #[test]
    fn a_large_directory_is_chunked_and_read_back_whole() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        let shared = hash("4321");
        let directory: Vec<_> = (0..40)
            .map(|index| {
                person(
                    &format!("00000000-0000-4000-8000-{index:012}"),
                    Some(shared.clone()),
                )
            })
            .collect();
        save_directory(BRANCH, &directory, now).expect("save");
        assert!(crate::tests::fake_keyring::get(STAFF_PIN_VAULT_BANK_A_KEYS[1]).is_some());
        assert_eq!(load().unwrap().unwrap().staff.len(), 40);

        // A rewrite moves to the other bank and removes the old copy.
        save_directory(BRANCH, &directory[..2], now).expect("save");
        assert!(crate::tests::fake_keyring::get(STAFF_PIN_VAULT_BANK_A_KEYS[0]).is_none());
        assert_eq!(load().unwrap().unwrap().staff.len(), 2);

        // Every key the vault wrote is a managed key, so the terminal reset
        // (which deletes exactly `managed_keys()`) leaves no hash behind.
        for key in crate::storage::managed_keys() {
            if crate::storage::is_staff_pin_vault_key(key) {
                crate::tests::fake_keyring::delete(key);
            }
        }
        assert!(load().unwrap().is_none());
        assert!(crate::tests::fake_keyring::is_empty());
    }

    /// A vault saved by 1.4.130/1.4.131 carries each person's role list
    /// (`"r"`). It still reads, and its hashes still check a PIN.
    #[test]
    fn a_vault_saved_with_role_lists_still_reads() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        let hash = hash("4321");
        let saved = serde_json::json!({
            "v": 1, "branch_id": BRANCH, "saved_at": now.to_rfc3339(),
            "staff": { "staff-1": { "h": hash, "a": true, "l": true, "r": ["kitchen"] } },
            "failures": {},
        });
        backend_write(STAFF_PIN_VAULT_BANK_A_KEYS[0], &saved.to_string()).expect("chunk");
        backend_write(
            KEY_STAFF_PIN_VAULT_MANIFEST,
            r#"{"v":1,"bank":"A","chunks":1}"#,
        )
        .expect("manifest");

        assert!(load()
            .expect("read")
            .expect("vault")
            .staff
            .contains_key("staff-1"));
        assert_eq!(
            verify_offline(BRANCH, "staff-1", "4321", now),
            OfflinePinCheck::Accepted
        );
    }

    /// Every role checks in offline (founder, 15/10/2026), so a vault over
    /// capacity drops only the people who cannot log in to the POS at all.
    #[test]
    fn a_vault_over_capacity_keeps_everyone_who_can_log_in() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        let shared = hash("4321");
        let directory: Vec<_> = (0..160)
            .map(|index| {
                let mut entry = person(
                    &format!("00000000-0000-4000-8000-{index:012}"),
                    Some(shared.clone()),
                );
                entry.can_login_pos = index % 2 == 0;
                entry
            })
            .collect();
        save_directory(BRANCH, &directory, now).expect("save");

        let doc = load().unwrap().unwrap();
        assert_eq!(doc.staff.len(), 80);
        assert!(doc.staff.values().all(|entry| entry.can_login_pos));
        assert_eq!(
            verify_offline(BRANCH, "00000000-0000-4000-8000-000000000158", "4321", now),
            OfflinePinCheck::Accepted
        );
    }

    #[test]
    fn redaction_removes_hashes_at_any_depth() {
        let mut value = serde_json::json!({
            "success": true,
            "staff": [{ "id": "a", "pinHash": "x", "pin_hash": "y", "hasPin": true,
                        "nested": { "pin_hash": "z" } }],
        });
        assert!(redact_pin_hashes(&mut value));
        assert_eq!(
            value,
            serde_json::json!({ "success": true,
                "staff": [{ "id": "a", "hasPin": true, "nested": {} }] })
        );
        assert_eq!(redact_pin_hashes_in_text(r#"{"staff":[]}"#), None);
        assert_eq!(
            redact_pin_hashes_in_text(r#"{"staff":[{"pinHash":"x"}]}"#).as_deref(),
            Some(r#"{"staff":[{}]}"#)
        );
    }
}
