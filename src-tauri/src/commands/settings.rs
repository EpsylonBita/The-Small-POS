use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use zeroize::Zeroizing;

use crate::terminal_helpers::{
    extract_enabled_features_from_terminal_settings_response,
    extract_owner_terminal_db_id_from_terminal_settings_response,
    extract_owner_terminal_id_from_terminal_settings_response,
    extract_parent_terminal_id_from_terminal_settings_response,
    extract_pos_operating_mode_from_terminal_settings_response,
    extract_source_terminal_db_id_from_terminal_settings_response,
    extract_source_terminal_id_from_terminal_settings_response,
    extract_terminal_type_from_terminal_settings_response, resolve_managed_terminal_identity,
    scrub_sensitive_local_settings_checked,
};
use crate::{api, auth, db, menu, reset, storage};

const TERMINAL_RUNTIME_STALE_AFTER_MS: i64 = 15 * 60 * 1000;
pub(crate) const TERMINAL_CONNECTION_REBIND_PENDING_KEY: &str =
    "terminal_connection_rebind_pending";
pub(crate) const TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY: &str =
    "terminal_connection_rebind_candidate_v1";
static LAST_TERMINAL_RUNTIME_EMIT_SIGNATURE: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
static SETTINGS_DURABILITY_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) struct TerminalCredentialOwner {
    _private: (),
}

fn set_terminal_credential_under_owner(key: &str, value: &str) -> Result<(), String> {
    storage::set_terminal_credential(&TerminalCredentialOwner { _private: () }, key, value)
}

fn delete_terminal_credential_under_owner(key: &str) -> Result<(), String> {
    storage::delete_terminal_credential(&TerminalCredentialOwner { _private: () }, key)
}
#[cfg(test)]
static SETTINGS_DURABILITY_PAUSE: OnceLock<
    Mutex<
        Option<(
            std::sync::Arc<std::sync::Barrier>,
            std::sync::Arc<std::sync::Barrier>,
        )>,
    >,
> = OnceLock::new();

#[cfg(test)]
fn install_settings_durability_pause(
    entered: std::sync::Arc<std::sync::Barrier>,
    release: std::sync::Arc<std::sync::Barrier>,
) {
    *SETTINGS_DURABILITY_PAUSE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("install durability pause") = Some((entered, release));
}

#[cfg(test)]
fn pause_settings_durability_owner_for_test() {
    let pause = SETTINGS_DURABILITY_PAUSE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("read durability pause")
        .take();
    if let Some((entered, release)) = pause {
        entered.wait();
        release.wait();
    }
}

#[cfg(not(test))]
fn pause_settings_durability_owner_for_test() {}

fn with_settings_durability_owner<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _durability = SETTINGS_DURABILITY_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "SETTINGS_DURABILITY_UNAVAILABLE".to_string())?;
    operation()
}

#[cfg(test)]
pub(crate) fn factory_reset_with_settings_owner_for_test() -> Result<Value, String> {
    crate::reset::factory_reset_with_authorized_owner_for_test()
}

#[derive(Debug, PartialEq)]
struct SettingsSetPayload {
    category: String,
    key: String,
    value_node: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TerminalBindingTuple {
    admin_dashboard_url: String,
    terminal_id: String,
    organization_id: String,
    branch_id: String,
}

#[derive(Clone, Debug)]
struct StrictTerminalAuthority {
    api_key: Zeroizing<String>,
    binding: TerminalBindingTuple,
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
enum TerminalBindingMirrorState {
    Missing,
    Coherent(TerminalBindingTuple),
    Conflicting {
        keyring: [Option<String>; 4],
        sqlite: [Option<String>; 4],
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct TerminalRebindCandidateJournal {
    version: u8,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    repair_scope_rollback: Option<crate::repairs::TerminalIdentityRollbackEnvelope>,
    #[serde(default)]
    operation: TerminalTransitionOperation,
    #[serde(default)]
    phase: TerminalTransitionPhase,
    organization_id: String,
    branch_id: String,
    terminal_id: String,
    admin_dashboard_url: String,
    api_key_digest: String,
    #[serde(default)]
    old_terminal_id: Option<String>,
    #[serde(default)]
    old_admin_dashboard_url: Option<String>,
    #[serde(default)]
    old_organization_id: Option<String>,
    #[serde(default)]
    old_branch_id: Option<String>,
    #[serde(default)]
    old_api_key_digest: Option<String>,
    #[serde(default)]
    old_api_key_present: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TerminalTransitionOperation {
    #[default]
    Rebind,
    Clear,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TerminalTransitionPhase {
    #[default]
    Intent,
    CredentialsCommitted,
    MirrorsCommitted,
    OperationalPrepared,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryGeneration {
    Old,
    Target,
    FailClosed,
}

fn choose_rebind_recovery_generation(
    journal: &TerminalRebindCandidateJournal,
    current_digest: Option<&str>,
    current_matches_target: bool,
) -> RecoveryGeneration {
    let matches_old =
        journal.old_api_key_present && current_digest == journal.old_api_key_digest.as_deref();
    let matches_target = current_digest == Some(journal.api_key_digest.as_str());
    let equal_digest =
        journal.old_api_key_digest.as_deref() == Some(journal.api_key_digest.as_str());
    if matches_old && journal.phase == TerminalTransitionPhase::Intent {
        return RecoveryGeneration::Old;
    }
    if matches_target
        && (!equal_digest
            || (journal.phase.ordinal() >= TerminalTransitionPhase::CredentialsCommitted.ordinal()
                && current_matches_target))
    {
        return RecoveryGeneration::Target;
    }
    RecoveryGeneration::FailClosed
}

impl TerminalTransitionPhase {
    fn ordinal(self) -> u8 {
        match self {
            Self::Intent => 0,
            Self::CredentialsCommitted => 1,
            Self::MirrorsCommitted => 2,
            Self::OperationalPrepared => 3,
        }
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_terminal_transition_journal(
    journal: TerminalRebindCandidateJournal,
) -> Result<TerminalRebindCandidateJournal, String> {
    let version_valid = match journal.version {
        2 => journal.operation_id.is_none() && journal.repair_scope_rollback.is_none(),
        3 => journal.operation_id.as_deref().is_some_and(|operation_id| {
            uuid::Uuid::parse_str(operation_id)
                .map(|parsed| parsed.hyphenated().to_string() == operation_id)
                .unwrap_or(false)
        }),
        _ => false,
    };
    if !version_valid
        || !is_sha256_hex(&journal.api_key_digest)
        || journal
            .old_api_key_digest
            .as_deref()
            .is_some_and(|digest| !is_sha256_hex(digest))
    {
        return Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string());
    }
    let old_fields = [
        journal.old_terminal_id.as_deref(),
        journal.old_admin_dashboard_url.as_deref(),
        journal.old_organization_id.as_deref(),
        journal.old_branch_id.as_deref(),
    ];
    if journal.old_api_key_present
        != (journal.old_api_key_digest.is_some() && old_fields.iter().all(|value| value.is_some()))
        || (!journal.old_api_key_present
            && (journal.old_api_key_digest.is_some()
                || old_fields.iter().any(|value| value.is_some())
                || journal.repair_scope_rollback.is_some()))
    {
        return Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string());
    }
    if journal.old_api_key_present
        && (journal
            .old_terminal_id
            .as_deref()
            .map_or(true, |value| value.trim().is_empty())
            || journal
                .old_admin_dashboard_url
                .as_deref()
                .map_or(true, |value| url::Url::parse(value).is_err())
            || journal
                .old_organization_id
                .as_deref()
                .map_or(true, |value| uuid::Uuid::parse_str(value).is_err())
            || journal
                .old_branch_id
                .as_deref()
                .map_or(true, |value| uuid::Uuid::parse_str(value).is_err()))
    {
        return Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string());
    }
    match journal.operation {
        TerminalTransitionOperation::Rebind => {
            if journal.terminal_id.trim().is_empty()
                || url::Url::parse(&journal.admin_dashboard_url).is_err()
                || uuid::Uuid::parse_str(&journal.organization_id).is_err()
                || uuid::Uuid::parse_str(&journal.branch_id).is_err()
            {
                return Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string());
            }
        }
        TerminalTransitionOperation::Clear => {
            if !journal.terminal_id.is_empty()
                || !journal.admin_dashboard_url.is_empty()
                || !journal.organization_id.is_empty()
                || !journal.branch_id.is_empty()
                || journal.api_key_digest != api_key_digest("")
                || !journal.old_api_key_present
            {
                return Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string());
            }
        }
    }
    Ok(journal)
}

fn api_key_digest(api_key: &str) -> String {
    let canonical = api::extract_api_key_from_connection_string(api_key)
        .unwrap_or_else(|| api_key.trim().to_string());
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn terminal_identity_rollback_binding(
    journal: &TerminalRebindCandidateJournal,
) -> Result<crate::repairs::TerminalIdentityRollbackBinding, String> {
    if journal.version != 3 || !journal.old_api_key_present {
        return Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string());
    }
    Ok(crate::repairs::TerminalIdentityRollbackBinding {
        journal_version: journal.version,
        operation: match journal.operation {
            TerminalTransitionOperation::Rebind => "rebind",
            TerminalTransitionOperation::Clear => "clear",
        }
        .to_string(),
        operation_id: journal
            .operation_id
            .clone()
            .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
        old_terminal_id: journal
            .old_terminal_id
            .clone()
            .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
        old_admin_dashboard_url: journal
            .old_admin_dashboard_url
            .clone()
            .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
        old_organization_id: journal
            .old_organization_id
            .clone()
            .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
        old_branch_id: journal
            .old_branch_id
            .clone()
            .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
        old_api_key_digest: journal
            .old_api_key_digest
            .clone()
            .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
        target_terminal_id: journal.terminal_id.clone(),
        target_admin_dashboard_url: journal.admin_dashboard_url.clone(),
        target_organization_id: journal.organization_id.clone(),
        target_branch_id: journal.branch_id.clone(),
        target_api_key_digest: journal.api_key_digest.clone(),
    })
}

fn validate_generic_setting_update(category: &str, key: &str) -> Result<(), String> {
    if crate::is_sensitive_setting_path(category, key) {
        Err("PROTECTED_TERMINAL_SETTING".to_string())
    } else {
        Ok(())
    }
}

fn normalize_dotted_settings_updates(
    payload: &Value,
) -> Result<Vec<(String, String, String)>, String> {
    let map = payload
        .as_object()
        .ok_or("update-settings expects an object payload")?;
    map.iter()
        .map(|(full_key, value)| {
            let (category, key) = full_key
                .split_once('.')
                .map(|(category, key)| (category.to_string(), key.to_string()))
                .unwrap_or_else(|| ("general".to_string(), full_key.to_string()));
            validate_generic_setting_update(&category, &key)?;
            let value = value
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| value.to_string());
            Ok((category, key, value))
        })
        .collect()
}

#[cfg(test)]
fn apply_generic_settings_updates_checked(
    db: &db::DbState,
    updates: &[(String, String, String)],
) -> Result<(), String> {
    for (category, key, _) in updates {
        validate_generic_setting_update(category, key)?;
    }
    let mut conn = db.conn.lock().map_err(|error| error.to_string())?;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("settings update: {error}"))?;
    for (category, key, value) in updates {
        db::set_setting(&transaction, category, key, value)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("settings update: {error}"))
}

fn mapped_generic_credential(category: &str, key: &str) -> Option<&'static str> {
    if !category.trim().eq_ignore_ascii_case("terminal") {
        return None;
    }
    match key.trim().to_ascii_lowercase().as_str() {
        "business_type" => Some("business_type"),
        "supabase_url" => Some("supabase_url"),
        "ghost_mode_feature_enabled" => Some("ghost_mode_feature_enabled"),
        _ => None,
    }
}

fn restore_generic_credential_snapshot(
    snapshot: &std::collections::BTreeMap<&'static str, Option<String>>,
) -> Result<(), String> {
    for (key, value) in snapshot {
        let _ = match value {
            Some(value) => storage::set_credential(key, value),
            None => storage::delete_credential(key),
        };
    }
    for (key, expected) in snapshot {
        let actual = storage::get_credential_strict(key)?.map(|value| value.to_string());
        if &actual != expected {
            return Err("SETTINGS_DURABLE_COMPENSATION_FAILED".to_string());
        }
    }
    Ok(())
}

fn restore_generic_sqlite_snapshot(
    db: &db::DbState,
    snapshot: &[(String, String, Option<String>)],
) -> Result<(), String> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|_| "SETTINGS_DURABLE_COMPENSATION_FAILED".to_string())?;
    let transaction = conn
        .transaction()
        .map_err(|_| "SETTINGS_DURABLE_COMPENSATION_FAILED".to_string())?;
    for (category, key, value) in snapshot {
        match value {
            Some(value) => db::set_setting(&transaction, category, key, value),
            None => db::delete_setting(&transaction, category, key).map(|_| ()),
        }
        .map_err(|_| "SETTINGS_DURABLE_COMPENSATION_FAILED".to_string())?;
    }
    transaction
        .commit()
        .map_err(|_| "SETTINGS_DURABLE_COMPENSATION_FAILED".to_string())
}

fn apply_generic_settings_and_credentials_checked(
    db: &db::DbState,
    updates: &[(String, String, String)],
) -> Result<(), String> {
    let _durability = SETTINGS_DURABILITY_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "SETTINGS_DURABILITY_UNAVAILABLE".to_string())?;
    apply_generic_settings_and_credentials_under_lock(db, updates)
}

fn apply_generic_settings_and_credentials_under_lock(
    db: &db::DbState,
    updates: &[(String, String, String)],
) -> Result<(), String> {
    for (category, key, _) in updates {
        validate_generic_setting_update(category, key)?;
    }

    let sqlite_snapshot = {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?;
        updates
            .iter()
            .map(|(category, key, _)| {
                (
                    category.clone(),
                    key.clone(),
                    db::get_setting(&conn, category, key),
                )
            })
            .collect::<Vec<_>>()
    };
    let mut credential_snapshot = std::collections::BTreeMap::new();
    let mut credential_updates = std::collections::BTreeMap::new();
    for (category, key, value) in updates {
        if let Some(credential_key) = mapped_generic_credential(category, key) {
            if !credential_snapshot.contains_key(credential_key) {
                let previous = storage::get_credential_strict(credential_key)
                    .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?
                    .map(|value| value.to_string());
                credential_snapshot.insert(credential_key, previous);
            }
            credential_updates.insert(credential_key, value.trim().to_string());
        }
    }

    for (key, value) in &credential_updates {
        let result = if value.is_empty() {
            storage::delete_credential(key)
        } else {
            storage::set_credential(key, value)
        };
        if result.is_err() {
            return match restore_generic_credential_snapshot(&credential_snapshot) {
                Ok(()) => Err("SETTINGS_DURABLE_WRITE_FAILED".to_string()),
                Err(error) => Err(error),
            };
        }
    }

    let sqlite_result = (|| {
        let mut conn = db
            .conn
            .lock()
            .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?;
        let transaction = conn
            .transaction()
            .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?;
        for (category, key, value) in updates {
            db::set_setting(&transaction, category, key, value)
                .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?;
        }
        transaction
            .commit()
            .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())
    })();
    if sqlite_result.is_err() {
        return match restore_generic_credential_snapshot(&credential_snapshot) {
            Ok(()) => Err("SETTINGS_DURABLE_WRITE_FAILED".to_string()),
            Err(error) => Err(error),
        };
    }

    let sqlite_matches = {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?;
        updates.iter().all(|(category, key, value)| {
            db::get_setting(&conn, category, key).as_deref() == Some(value)
        })
    };
    let credential_matches = credential_updates.iter().all(|(key, expected)| {
        let actual = storage::get_credential_strict(key)
            .ok()
            .flatten()
            .map(|value| value.to_string());
        if expected.is_empty() {
            actual.is_none()
        } else {
            actual.as_deref() == Some(expected.as_str())
        }
    });
    if !sqlite_matches || !credential_matches {
        let sqlite_restore = restore_generic_sqlite_snapshot(db, &sqlite_snapshot);
        let credential_restore = restore_generic_credential_snapshot(&credential_snapshot);
        return if sqlite_restore.is_ok() && credential_restore.is_ok() {
            Err("SETTINGS_DURABLE_WRITE_FAILED".to_string())
        } else {
            Err("SETTINGS_DURABLE_COMPENSATION_FAILED".to_string())
        };
    }
    Ok(())
}

#[cfg(test)]
fn apply_refresh_secondary_settings_checked(
    db: &db::DbState,
    updates: &[(String, String, String)],
    supabase_anon_key: Option<&str>,
) -> Result<(), String> {
    let _durability = SETTINGS_DURABILITY_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "SETTINGS_DURABILITY_UNAVAILABLE".to_string())?;
    apply_refresh_secondary_settings_under_lock(db, updates, supabase_anon_key)
}

fn apply_refresh_secondary_settings_under_lock(
    db: &db::DbState,
    updates: &[(String, String, String)],
    supabase_anon_key: Option<&str>,
) -> Result<(), String> {
    let previous_anon = storage::get_credential_strict("supabase_anon_key")
        .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?
        .map(|value| value.to_string());
    let desired_anon = supabase_anon_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|_| previous_anon.is_none());
    if let Some(value) = desired_anon {
        if storage::set_credential("supabase_anon_key", value).is_err() {
            return match restore_single_credential("supabase_anon_key", previous_anon.as_deref()) {
                Ok(()) => Err("SETTINGS_DURABLE_WRITE_FAILED".to_string()),
                Err(error) => Err(error),
            };
        }
        let readback = storage::get_credential_strict("supabase_anon_key");
        if !matches!(
            readback.as_ref(),
            Ok(Some(stored)) if stored.as_str() == value
        ) {
            return match restore_single_credential("supabase_anon_key", previous_anon.as_deref()) {
                Ok(()) => Err("SETTINGS_DURABLE_WRITE_FAILED".to_string()),
                Err(_) => Err("SETTINGS_DURABLE_COMPENSATION_FAILED".to_string()),
            };
        }
    }
    if let Err(error) = apply_generic_settings_and_credentials_under_lock(db, updates) {
        if desired_anon.is_some()
            && restore_single_credential("supabase_anon_key", previous_anon.as_deref()).is_err()
        {
            return Err("SETTINGS_DURABLE_COMPENSATION_FAILED".to_string());
        }
        return Err(error);
    }
    Ok(())
}

fn restore_single_credential(key: &str, value: Option<&str>) -> Result<(), String> {
    let _ = match value {
        Some(value) => storage::set_credential(key, value),
        None => storage::delete_credential(key),
    };
    let actual = storage::get_credential_strict(key)
        .map_err(|_| "SETTINGS_DURABLE_COMPENSATION_FAILED".to_string())?;
    if actual.as_ref().map(|stored| stored.as_str()) == value {
        Ok(())
    } else {
        Err("SETTINGS_DURABLE_COMPENSATION_FAILED".to_string())
    }
}

fn renderer_settings_snapshot(db: &db::DbState) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let mut all = db::get_all_settings(&conn);
    drop(conn);
    if let Some(categories) = all.as_object_mut() {
        for (category, value) in categories.iter_mut() {
            if let Some(settings) = value.as_object_mut() {
                settings.retain(|key, _| !crate::is_sensitive_setting_path(category, key));
            }
        }
        categories.retain(|key, _| {
            key.split_once('.')
                .map(|(category, setting_key)| {
                    !crate::is_sensitive_setting_path(category, setting_key)
                })
                .unwrap_or(true)
        });
    }
    Ok(all)
}

fn value_to_settings_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn normalize_non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn response_string_at_paths(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
    })
}

fn normalized_admin_url_for_switch(value: Option<String>) -> Option<String> {
    normalize_non_empty(value)
        .map(|item| api::normalize_admin_url(&item))
        .filter(|item| !item.is_empty())
}

fn resolve_strict_terminal_authority(
    db: &db::DbState,
) -> Result<Option<StrictTerminalAuthority>, String> {
    let read = |key: &str| {
        storage::get_credential_strict(key)
            .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())
            .map(|value| {
                value
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
    };
    let raw_api_key = read("pos_api_key")?;
    let terminal_id = read("terminal_id")?;
    let admin_dashboard_url =
        read("admin_dashboard_url")?.and_then(|value| normalized_admin_url_for_switch(Some(value)));
    let organization_id = read("organization_id")?;
    let branch_id = read("branch_id")?;
    let present = [
        raw_api_key.is_some(),
        terminal_id.is_some(),
        admin_dashboard_url.is_some(),
        organization_id.is_some(),
        branch_id.is_some(),
    ];
    if present.iter().all(|present| !present) {
        let sqlite_binding_present = db
            .conn
            .lock()
            .map_err(|_| "TERMINAL_BINDING_MIRROR_READ_FAILED".to_string())?
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM local_settings
                    WHERE setting_category = 'terminal'
                      AND setting_key IN (
                        'pos_api_key', 'api_key', 'terminal_id', 'admin_dashboard_url',
                        'admin_url', 'organization_id', 'branch_id'
                      )
                )",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| "TERMINAL_BINDING_MIRROR_READ_FAILED".to_string())?;
        return if has_terminal_operational_state(db) || sqlite_binding_present {
            Err("TERMINAL_MANAGED_TUPLE_MISSING".to_string())
        } else {
            Ok(None)
        };
    }
    if !present.iter().all(|present| *present) {
        return Err("TERMINAL_MANAGED_TUPLE_MISSING".to_string());
    }
    let raw_api_key = raw_api_key.expect("checked strict API key");
    let terminal_id = terminal_id.expect("checked strict terminal");
    let admin_dashboard_url = admin_dashboard_url.expect("checked strict Admin URL");
    let decoded_terminal = api::extract_terminal_id_from_connection_string(&raw_api_key);
    let decoded_admin = api::extract_admin_url_from_connection_string(&raw_api_key)
        .and_then(|value| normalized_admin_url_for_switch(Some(value)));
    if decoded_terminal
        .as_deref()
        .is_some_and(|decoded| decoded != terminal_id.as_str())
        || decoded_admin
            .as_deref()
            .is_some_and(|decoded| decoded != admin_dashboard_url.as_str())
    {
        return Err("TERMINAL_MANAGED_TUPLE_CONFLICT".to_string());
    }
    let api_key = api::extract_api_key_from_connection_string(&raw_api_key).unwrap_or(raw_api_key);
    Ok(Some(StrictTerminalAuthority {
        api_key: Zeroizing::new(api_key),
        binding: TerminalBindingTuple {
            terminal_id,
            admin_dashboard_url,
            organization_id: organization_id.expect("checked strict organization"),
            branch_id: branch_id.expect("checked strict branch"),
        },
    }))
}

fn verify_sqlite_binding_mirror(
    db: &db::DbState,
    authority: &StrictTerminalAuthority,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "TERMINAL_BINDING_MIRROR_READ_FAILED".to_string())?;
    for (key, expected) in [
        ("terminal_id", authority.binding.terminal_id.as_str()),
        (
            "admin_dashboard_url",
            authority.binding.admin_dashboard_url.as_str(),
        ),
        (
            "organization_id",
            authority.binding.organization_id.as_str(),
        ),
        ("branch_id", authority.binding.branch_id.as_str()),
    ] {
        if let Some(actual) = db::get_setting(&conn, "terminal", key) {
            let actual = if key == "admin_dashboard_url" {
                api::normalize_admin_url(actual.trim())
            } else {
                actual.trim().to_string()
            };
            if actual != expected {
                return Err("TERMINAL_BINDING_MIRRORS_CONFLICT".to_string());
            }
        }
    }
    Ok(())
}

fn verify_complete_sqlite_binding_mirror(
    db: &db::DbState,
    binding: &TerminalBindingTuple,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "TERMINAL_BINDING_MIRROR_READ_FAILED".to_string())?;
    for (key, expected) in [
        ("terminal_id", binding.terminal_id.as_str()),
        ("admin_dashboard_url", binding.admin_dashboard_url.as_str()),
        ("organization_id", binding.organization_id.as_str()),
        ("branch_id", binding.branch_id.as_str()),
    ] {
        let actual = db::get_setting(&conn, "terminal", key)
            .ok_or_else(|| "TERMINAL_BINDING_MIRRORS_INCOMPLETE".to_string())?;
        let actual = if key == "admin_dashboard_url" {
            api::normalize_admin_url(actual.trim())
        } else {
            actual.trim().to_string()
        };
        if actual != expected {
            return Err("TERMINAL_BINDING_MIRRORS_CONFLICT".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
fn read_terminal_binding_mirror_state(
    db: &db::DbState,
) -> Result<TerminalBindingMirrorState, String> {
    let keys = [
        "admin_dashboard_url",
        "terminal_id",
        "organization_id",
        "branch_id",
    ];
    let mut keyring: [Option<String>; 4] = Default::default();
    for (index, key) in keys.iter().enumerate() {
        keyring[index] = storage::get_credential_strict(key)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if *key == "admin_dashboard_url" {
            keyring[index] = normalized_admin_url_for_switch(keyring[index].take());
        }
    }
    let sqlite = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        let mut values: [Option<String>; 4] = Default::default();
        for (index, key) in keys.iter().enumerate() {
            values[index] = db::get_setting(&conn, "terminal", key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            if *key == "admin_dashboard_url" {
                values[index] = normalized_admin_url_for_switch(values[index].take());
            }
        }
        values
    };
    if keyring
        .iter()
        .zip(sqlite.iter())
        .any(|(left, right)| left.is_some() && right.is_some() && left != right)
    {
        return Ok(TerminalBindingMirrorState::Conflicting { keyring, sqlite });
    }
    let keyring_complete = keyring.iter().all(Option::is_some);
    if !keyring_complete {
        return Ok(TerminalBindingMirrorState::Missing);
    }
    let resolved = &keyring;
    Ok(TerminalBindingMirrorState::Coherent(TerminalBindingTuple {
        admin_dashboard_url: resolved[0].clone().expect("checked complete binding"),
        terminal_id: resolved[1].clone().expect("checked complete binding"),
        organization_id: resolved[2].clone().expect("checked complete binding"),
        branch_id: resolved[3].clone().expect("checked complete binding"),
    }))
}

fn candidate_journal_from_payload(
    payload: &Value,
    previous: Option<&StrictTerminalAuthority>,
) -> Result<TerminalRebindCandidateJournal, String> {
    let terminal_id =
        payload_terminal_id_for_switch(payload).ok_or("TERMINAL_REBIND_CANDIDATE_INVALID")?;
    let organization_id =
        payload_scope_value_for_switch(payload, "organizationId", "organization_id")
            .filter(|value| uuid::Uuid::parse_str(value).is_ok())
            .ok_or("TERMINAL_REBIND_CANDIDATE_INVALID")?;
    let branch_id = payload_scope_value_for_switch(payload, "branchId", "branch_id")
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or("TERMINAL_REBIND_CANDIDATE_INVALID")?;
    let admin_dashboard_url = payload_admin_url_for_switch(payload)
        .filter(|value| url::Url::parse(value).is_ok())
        .ok_or("TERMINAL_REBIND_CANDIDATE_INVALID")?;
    let api_key = payload_api_key_for_switch(payload)
        .filter(|value| !value.trim().is_empty())
        .ok_or("TERMINAL_REBIND_CANDIDATE_INVALID")?;
    let canonical_api_key = api::extract_api_key_from_connection_string(&api_key)
        .unwrap_or_else(|| api_key.trim().to_string());
    Ok(TerminalRebindCandidateJournal {
        version: 3,
        operation_id: Some(uuid::Uuid::new_v4().to_string()),
        repair_scope_rollback: None,
        operation: TerminalTransitionOperation::Rebind,
        phase: TerminalTransitionPhase::Intent,
        organization_id,
        branch_id,
        terminal_id,
        admin_dashboard_url,
        api_key_digest: api_key_digest(&canonical_api_key),
        old_terminal_id: previous.map(|value| value.binding.terminal_id.clone()),
        old_admin_dashboard_url: previous.map(|value| value.binding.admin_dashboard_url.clone()),
        old_organization_id: previous.map(|value| value.binding.organization_id.clone()),
        old_branch_id: previous.map(|value| value.binding.branch_id.clone()),
        old_api_key_digest: previous.map(|value| api_key_digest(value.api_key.as_str())),
        old_api_key_present: previous.is_some(),
    })
}

fn persist_terminal_transition_intent(
    db: &db::DbState,
    candidate: &TerminalRebindCandidateJournal,
    error_code: &str,
) -> crate::repairs::TerminalIdentityIntentDurability {
    use crate::repairs::TerminalIdentityIntentDurability::{
        AmbiguousFailure, Committed, DefiniteFailure,
    };

    let encoded = match serde_json::to_string(candidate) {
        Ok(encoded) => encoded,
        Err(_) => {
            return DefiniteFailure(error_code.to_string());
        }
    };
    let mut conn = match db.conn.lock() {
        Ok(conn) => conn,
        Err(_) => {
            return DefiniteFailure(error_code.to_string());
        }
    };
    let transaction = match conn.transaction() {
        Ok(transaction) => transaction,
        Err(_) => {
            return DefiniteFailure(error_code.to_string());
        }
    };
    if db::set_setting(
        &transaction,
        "sync",
        TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
        &encoded,
    )
    .is_err()
        || db::set_setting(
            &transaction,
            "sync",
            TERMINAL_CONNECTION_REBIND_PENDING_KEY,
            "1",
        )
        .is_err()
    {
        return DefiniteFailure(error_code.to_string());
    }
    if transaction.commit().is_err() {
        return AmbiguousFailure(error_code.to_string());
    }

    let Some(readback) = db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY)
    else {
        return AmbiguousFailure(error_code.to_string());
    };
    let parsed: TerminalRebindCandidateJournal = match serde_json::from_str(&readback) {
        Ok(parsed) => parsed,
        Err(_) => {
            return AmbiguousFailure(error_code.to_string());
        }
    };
    let parsed = match validate_terminal_transition_journal(parsed) {
        Ok(parsed) => parsed,
        Err(_) => {
            return AmbiguousFailure(error_code.to_string());
        }
    };
    if parsed != *candidate
        || db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_PENDING_KEY).as_deref()
            != Some("1")
    {
        return AmbiguousFailure(error_code.to_string());
    }
    Committed
}

fn persist_terminal_rebind_candidate(
    db: &db::DbState,
    payload: &Value,
    previous: Option<&StrictTerminalAuthority>,
) -> Result<TerminalRebindCandidateJournal, String> {
    let mut candidate = candidate_journal_from_payload(payload, previous)?;
    if previous.is_some() {
        let binding = terminal_identity_rollback_binding(&candidate)?;
        crate::repairs::prepare_and_arm_terminal_identity_transition(&binding, |envelope| {
            candidate.repair_scope_rollback = envelope.cloned();
            persist_terminal_transition_intent(
                db,
                &candidate,
                "TERMINAL_REBIND_CANDIDATE_WRITE_FAILED",
            )
        })?;
    } else {
        match persist_terminal_transition_intent(
            db,
            &candidate,
            "TERMINAL_REBIND_CANDIDATE_WRITE_FAILED",
        ) {
            crate::repairs::TerminalIdentityIntentDurability::Committed => {}
            crate::repairs::TerminalIdentityIntentDurability::DefiniteFailure(error)
            | crate::repairs::TerminalIdentityIntentDurability::AmbiguousFailure(error) => {
                return Err(error);
            }
        }
    }
    Ok(candidate)
}

fn rollback_pre_destructive_rebind_candidate(db: &db::DbState) -> Result<(), String> {
    clear_terminal_transition_journal_verified(db)
}

fn clear_terminal_transition_journal_verified(db: &db::DbState) -> Result<(), String> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|_| "TERMINAL_TRANSITION_FINALIZE_FAILED".to_string())?;
    let transaction = conn
        .transaction()
        .map_err(|_| "TERMINAL_TRANSITION_FINALIZE_FAILED".to_string())?;
    db::delete_setting(
        &transaction,
        "sync",
        TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
    )
    .map_err(|_| "TERMINAL_TRANSITION_FINALIZE_FAILED".to_string())?;
    db::delete_setting(&transaction, "sync", TERMINAL_CONNECTION_REBIND_PENDING_KEY)
        .map_err(|_| "TERMINAL_TRANSITION_FINALIZE_FAILED".to_string())?;
    transaction
        .commit()
        .map_err(|_| "TERMINAL_TRANSITION_FINALIZE_FAILED".to_string())?;
    if db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY).is_some()
        || db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_PENDING_KEY).is_some()
    {
        return Err("TERMINAL_TRANSITION_FINALIZE_FAILED".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn read_terminal_rebind_candidate(
    db: &db::DbState,
    api_key: &str,
) -> Result<TerminalRebindCandidateJournal, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let raw = db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY)
        .ok_or("TERMINAL_REBIND_CANDIDATE_REQUIRED")?;
    let parsed: TerminalRebindCandidateJournal = serde_json::from_str(&raw)
        .map_err(|_| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?;
    let parsed = validate_terminal_transition_journal(parsed)?;
    if parsed.operation != TerminalTransitionOperation::Rebind
        || parsed.api_key_digest != api_key_digest(api_key)
    {
        return Err("TERMINAL_REBIND_CANDIDATE_INVALID".to_string());
    }
    if uuid::Uuid::parse_str(&parsed.organization_id).is_err()
        || uuid::Uuid::parse_str(&parsed.branch_id).is_err()
        || parsed.terminal_id.trim().is_empty()
        || url::Url::parse(&parsed.admin_dashboard_url).is_err()
    {
        return Err("TERMINAL_REBIND_CANDIDATE_INVALID".to_string());
    }
    Ok(parsed)
}

fn read_terminal_transition_journal(
    db: &db::DbState,
) -> Result<TerminalRebindCandidateJournal, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "TERMINAL_TRANSITION_READ_FAILED".to_string())?;
    let raw = db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY)
        .ok_or("TERMINAL_REBIND_CANDIDATE_REQUIRED")?;
    let parsed = serde_json::from_str(&raw)
        .map_err(|_| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?;
    validate_terminal_transition_journal(parsed)
}

fn update_terminal_transition_phase(
    db: &db::DbState,
    phase: TerminalTransitionPhase,
) -> Result<(), String> {
    let mut journal = read_terminal_transition_journal(db)?;
    let previous = journal.phase;
    if phase.ordinal() < previous.ordinal() || phase.ordinal() > previous.ordinal() + 1 {
        return Err("TERMINAL_TRANSITION_PHASE_INVALID".to_string());
    }
    if phase == previous {
        return Ok(());
    }
    journal.phase = phase;
    let encoded = serde_json::to_string(&journal)
        .map_err(|_| "TERMINAL_TRANSITION_PHASE_FAILED".to_string())?;
    let conn = db
        .conn
        .lock()
        .map_err(|_| "TERMINAL_TRANSITION_PHASE_FAILED".to_string())?;
    db::set_setting(
        &conn,
        "sync",
        TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
        &encoded,
    )
    .map_err(|_| "TERMINAL_TRANSITION_PHASE_FAILED".to_string())?;
    let readback = db::get_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY)
        .ok_or_else(|| "TERMINAL_TRANSITION_PHASE_FAILED".to_string())?;
    let parsed: TerminalRebindCandidateJournal = serde_json::from_str(&readback)
        .map_err(|_| "TERMINAL_TRANSITION_PHASE_FAILED".to_string())?;
    let parsed = validate_terminal_transition_journal(parsed)?;
    if parsed != journal || parsed.phase != phase {
        return Err("TERMINAL_TRANSITION_PHASE_FAILED".to_string());
    }
    Ok(())
}

fn advance_terminal_transition_phase(
    db: &db::DbState,
    phase: TerminalTransitionPhase,
) -> Result<(), String> {
    let current = read_terminal_transition_journal(db)?.phase;
    if current.ordinal() >= phase.ordinal() {
        return Ok(());
    }
    update_terminal_transition_phase(db, phase)
}

fn restore_old_authority_from_journal(
    journal: &TerminalRebindCandidateJournal,
    current_api_key: Option<&str>,
) -> Result<(), String> {
    let current_api_key = current_api_key
        .filter(|_| journal.old_api_key_present)
        .ok_or_else(|| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?;
    let current_digest = api_key_digest(current_api_key);
    if journal.old_api_key_digest.as_deref() != Some(current_digest.as_str()) {
        return Err("TERMINAL_TRANSITION_RECOVERY_FAILED".to_string());
    }
    let values = [
        ("terminal_id", journal.old_terminal_id.as_deref()),
        (
            "admin_dashboard_url",
            journal.old_admin_dashboard_url.as_deref(),
        ),
        ("organization_id", journal.old_organization_id.as_deref()),
        ("branch_id", journal.old_branch_id.as_deref()),
        ("pos_api_key", Some(current_api_key)),
    ];
    for (key, value) in values {
        let value = value.ok_or_else(|| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?;
        set_terminal_credential_under_owner(key, value)
            .map_err(|_| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?;
    }
    for (key, expected) in values {
        let actual = storage::get_credential_strict(key)
            .map_err(|_| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?;
        if actual.as_ref().map(|value| value.as_str()) != expected {
            return Err("TERMINAL_TRANSITION_RECOVERY_FAILED".to_string());
        }
    }
    Ok(())
}

fn verify_old_authority_and_mirrors(
    db: &db::DbState,
    journal: &TerminalRebindCandidateJournal,
) -> Result<(), String> {
    let authority = resolve_strict_terminal_authority(db)?
        .ok_or_else(|| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?;
    let authority_api_digest = api_key_digest(authority.api_key.as_str());
    let matches_journal = journal.old_api_key_present
        && journal.old_terminal_id.as_deref() == Some(authority.binding.terminal_id.as_str())
        && journal.old_admin_dashboard_url.as_deref()
            == Some(authority.binding.admin_dashboard_url.as_str())
        && journal.old_organization_id.as_deref()
            == Some(authority.binding.organization_id.as_str())
        && journal.old_branch_id.as_deref() == Some(authority.binding.branch_id.as_str())
        && journal.old_api_key_digest.as_deref() == Some(authority_api_digest.as_str());
    if !matches_journal {
        return Err("TERMINAL_TRANSITION_RECOVERY_FAILED".to_string());
    }
    verify_sqlite_binding_mirror(db, &authority)
        .map_err(|_| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())
}

fn arm_terminal_identity_rollback_if_needed(
    journal: &TerminalRebindCandidateJournal,
) -> Result<(), String> {
    if journal.version != 3
        || !journal.old_api_key_present
        || journal.phase != TerminalTransitionPhase::Intent
    {
        return Ok(());
    }
    let binding = terminal_identity_rollback_binding(journal)?;
    crate::repairs::arm_terminal_identity_transition(
        &binding,
        journal.repair_scope_rollback.as_ref(),
    )
}

fn prepare_terminal_identity_rollback_publication(
    journal: &TerminalRebindCandidateJournal,
) -> Result<crate::repairs::TerminalIdentityRollbackPublication, String> {
    match journal.version {
        3 => {
            let binding = terminal_identity_rollback_binding(journal)?;
            crate::repairs::restore_terminal_identity_scope_while_blocked(
                &binding,
                journal.repair_scope_rollback.as_ref(),
            )
        }
        2 => crate::repairs::prepare_legacy_terminal_identity_rollback(
            journal
                .old_organization_id
                .as_deref()
                .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
            journal
                .old_branch_id
                .as_deref()
                .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
            journal
                .old_terminal_id
                .as_deref()
                .ok_or_else(|| "TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())?,
        ),
        _ => Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string()),
    }
}

fn rollback_terminal_transition_to_old(
    db: &db::DbState,
    journal: &TerminalRebindCandidateJournal,
) -> Result<(), String> {
    verify_old_authority_and_mirrors(db, journal)?;
    let publication = prepare_terminal_identity_rollback_publication(journal)?;
    clear_terminal_transition_journal_verified(db)?;
    crate::repairs::finish_terminal_identity_rollback(publication)
}

fn rollback_clear_before_api_commit(
    db: &db::DbState,
    journal: &TerminalRebindCandidateJournal,
    api_key: &str,
    code: &str,
) -> Result<(), String> {
    restore_old_authority_from_journal(journal, Some(api_key))?;
    rollback_terminal_transition_to_old(db, journal)?;
    Err(code.to_string())
}

fn payload_api_key_for_switch(payload: &Value) -> Option<String> {
    crate::value_str(payload, &["apiKey", "pos_api_key", "api_key"])
}

fn payload_terminal_id_for_switch(payload: &Value) -> Option<String> {
    payload_api_key_for_switch(payload)
        .and_then(|raw| api::extract_terminal_id_from_connection_string(raw.trim()))
        .or_else(|| crate::value_str(payload, &["terminalId", "terminal_id"]))
        .and_then(|value| normalize_non_empty(Some(value)))
}

fn payload_admin_url_for_switch(payload: &Value) -> Option<String> {
    payload_api_key_for_switch(payload)
        .and_then(|raw| api::extract_admin_url_from_connection_string(raw.trim()))
        .or_else(|| {
            crate::value_str(
                payload,
                &["adminDashboardUrl", "adminUrl", "admin_dashboard_url"],
            )
        })
        .and_then(|value| normalized_admin_url_for_switch(Some(value)))
}

fn payload_scope_value_for_switch(payload: &Value, camel: &str, snake: &str) -> Option<String> {
    crate::value_str(payload, &[camel, snake]).and_then(|value| normalize_non_empty(Some(value)))
}

fn terminal_connection_changed(
    previous_terminal_id: Option<&str>,
    next_terminal_id: Option<&str>,
    previous_admin_url: Option<&str>,
    next_admin_url: Option<&str>,
) -> bool {
    let terminal_changed = matches!(
        (previous_terminal_id, next_terminal_id),
        (Some(previous), Some(next)) if previous != next
    );
    let admin_url_changed = matches!(
        (previous_admin_url, next_admin_url),
        (Some(previous), Some(next)) if previous != next
    );

    terminal_changed || admin_url_changed
}

fn scoped_identity_changed(previous: Option<&str>, next: Option<&str>) -> bool {
    matches!((previous, next), (Some(previous), Some(next)) if previous != next)
}

fn has_terminal_operational_state(db: &db::DbState) -> bool {
    let Ok(conn) = db.conn.lock() else {
        return true;
    };
    conn.query_row(
        "SELECT
             EXISTS(SELECT 1 FROM orders LIMIT 1)
             OR EXISTS(SELECT 1 FROM order_payments LIMIT 1)
             OR EXISTS(SELECT 1 FROM payment_adjustments LIMIT 1)
             OR EXISTS(SELECT 1 FROM staff_shifts LIMIT 1)
             OR EXISTS(SELECT 1 FROM cash_drawer_sessions LIMIT 1)
             OR EXISTS(SELECT 1 FROM parity_sync_queue LIMIT 1)
             OR EXISTS(SELECT 1 FROM sync_queue LIMIT 1)
             OR EXISTS(SELECT 1 FROM repair_cache LIMIT 1)
             OR EXISTS(SELECT 1 FROM repair_alias_cache LIMIT 1)
             OR EXISTS(SELECT 1 FROM repair_attachment_staging LIMIT 1)
             OR EXISTS(SELECT 1 FROM repair_conflicts LIMIT 1)",
        [],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(true)
}

#[cfg(test)]
fn missing_identity_binding_with_existing_state(
    has_operational_state: bool,
    previous: &[Option<&str>],
    next: &[Option<&str>],
) -> bool {
    has_operational_state
        && previous
            .iter()
            .zip(next.iter())
            .any(|(previous, next)| previous.is_none() && next.is_some())
}

pub(crate) fn terminal_connection_rebind_pending(db: &db::DbState) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let marker: Option<String> = conn
        .query_row(
            "SELECT setting_value FROM local_settings
             WHERE setting_category = 'sync' AND setting_key = ?1",
            [TERMINAL_CONNECTION_REBIND_PENDING_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read terminal rebind marker: {error}"))?;
    let candidate_present: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM local_settings
                WHERE setting_category = 'sync' AND setting_key = ?1
             )",
            [TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY],
            |row| row.get(0),
        )
        .map_err(|error| format!("read terminal rebind candidate marker: {error}"))?;
    let marker_pending = marker.as_deref() == Some("1");
    drop(conn);
    Ok(marker_pending
        || candidate_present
        || crate::repairs::operational_clear_transition_pending()?
        || crate::repairs::terminal_identity_rollback_publication_pending()?)
}

fn terminal_connection_rebind_pending_fail_closed(db: &db::DbState) -> bool {
    terminal_connection_rebind_pending(db).unwrap_or(true)
}

pub(crate) fn terminal_connection_rebind_pending_fail_closed_public(db: &db::DbState) -> bool {
    terminal_connection_rebind_pending_fail_closed(db)
}

fn set_terminal_connection_rebind_pending(db: &db::DbState, pending: bool) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    if pending {
        db::set_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_PENDING_KEY, "1")
    } else {
        db::delete_setting(&conn, "sync", TERMINAL_CONNECTION_REBIND_PENDING_KEY).map(|_| ())
    }
}

fn prepare_terminal_connection_rebind(
    db: &db::DbState,
) -> Result<crate::recovery::DestructiveSnapshotDecision, String> {
    set_terminal_connection_rebind_pending(db, true)?;
    let (repair_transition, recovery_decision) = crate::prepare_operational_clear(db)?;
    crate::clear_operational_data_while_repair_blocked(db, &repair_transition)?;
    storage::invalidate_terminal_authority()?;
    // Releasing the transition mutex does not reopen repair access: the
    // lifecycle and durable scope stay transition_pending until finish below.
    drop(repair_transition);
    Ok(recovery_decision)
}

#[cfg(test)]
fn prepare_terminal_connection_rebind_with_recovery<F>(
    db: &db::DbState,
    recovery_preflight: F,
) -> Result<crate::recovery::DestructiveSnapshotDecision, String>
where
    F: FnOnce(
        &db::DbState,
        crate::recovery::RecoveryPointKind,
    ) -> Result<crate::recovery::DestructiveSnapshotDecision, String>,
{
    set_terminal_connection_rebind_pending(db, true)?;
    let (repair_transition, recovery_decision) =
        crate::core_helpers::prepare_operational_clear_with_recovery(
            db,
            crate::recovery::RecoveryPointKind::PreClearOperationalData,
            recovery_preflight,
        )?;
    crate::clear_operational_data_while_repair_blocked(db, &repair_transition)?;
    storage::invalidate_terminal_authority()?;
    // Releasing the transition mutex does not reopen repair access: the
    // lifecycle and durable scope stay transition_pending until finish below.
    drop(repair_transition);
    Ok(recovery_decision)
}

fn finish_terminal_connection_rebind(db: &db::DbState) -> Result<(), String> {
    finish_terminal_connection_rebind_with_window_hook(db, || {})
}

fn finish_terminal_connection_rebind_with_window_hook<F>(
    db: &db::DbState,
    after_clear_before_scope_publication: F,
) -> Result<(), String>
where
    F: FnOnce(),
{
    let repair_transition = crate::repairs::arm_operational_clear()?;
    crate::core_helpers::finalize_operational_rebind(
        db,
        &repair_transition,
        "sync",
        TERMINAL_CONNECTION_REBIND_PENDING_KEY,
        TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
        after_clear_before_scope_publication,
    )
}

pub(crate) fn publish_terminal_binding_checked(
    db: &db::DbState,
    payload: &Value,
) -> Result<(Value, bool), String> {
    let _durability = SETTINGS_DURABILITY_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "SETTINGS_DURABILITY_UNAVAILABLE".to_string())?;
    pause_settings_durability_owner_for_test();
    publish_terminal_binding_under_lock(db, payload, true)
}

fn restore_binding_credentials(snapshot: &[(&str, Option<String>)]) -> Result<(), String> {
    let mut failed = false;
    for (key, value) in snapshot
        .iter()
        .filter(|(key, _)| *key != "pos_api_key")
        .chain(snapshot.iter().filter(|(key, _)| *key == "pos_api_key"))
    {
        let result = match value {
            Some(value) => set_terminal_credential_under_owner(key, value),
            None => delete_terminal_credential_under_owner(key),
        };
        if result.is_err() {
            failed = true;
        }
    }
    for (key, expected) in snapshot {
        match storage::get_credential_strict(key) {
            Ok(actual) if actual.as_ref().map(|value| value.as_str()) == expected.as_deref() => {}
            Ok(_) | Err(_) => failed = true,
        }
    }
    if failed {
        Err("TERMINAL_BINDING_COMPENSATION_FAILED".to_string())
    } else {
        Ok(())
    }
}

fn write_binding_credentials_checked(payload: &Value) -> Result<Value, String> {
    let keys = [
        "pos_api_key",
        "terminal_id",
        "admin_dashboard_url",
        "organization_id",
        "branch_id",
    ];
    let snapshot = keys
        .iter()
        .map(|key| {
            storage::get_credential_strict(key)
                .map(|value| (*key, value.map(|value| value.to_string())))
                .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let raw_api_key =
        payload_api_key_for_switch(payload).ok_or("Terminal binding is incomplete")?;
    let expected_api_key = api::extract_api_key_from_connection_string(&raw_api_key)
        .unwrap_or_else(|| raw_api_key.trim().to_string());
    let expected = [
        ("pos_api_key", expected_api_key),
        (
            "terminal_id",
            payload_terminal_id_for_switch(payload).ok_or("Terminal binding is incomplete")?,
        ),
        (
            "admin_dashboard_url",
            payload_admin_url_for_switch(payload).ok_or("Terminal binding is incomplete")?,
        ),
        (
            "organization_id",
            payload_scope_value_for_switch(payload, "organizationId", "organization_id")
                .ok_or("Terminal binding is incomplete")?,
        ),
        (
            "branch_id",
            payload_scope_value_for_switch(payload, "branchId", "branch_id")
                .ok_or("Terminal binding is incomplete")?,
        ),
    ];
    let write_result = expected
        .iter()
        .filter(|(key, _)| *key != "pos_api_key")
        .chain(expected.iter().filter(|(key, _)| *key == "pos_api_key"))
        .try_for_each(|(key, value)| {
            set_terminal_credential_under_owner(key, value)
                .map_err(|_| "TERMINAL_BINDING_WRITE_FAILED".to_string())?;
            let readback = storage::get_credential_strict(key)
                .map_err(|_| "TERMINAL_BINDING_READBACK_FAILED".to_string())?;
            if readback.as_ref().map(|stored| stored.as_str()) == Some(value.as_str()) {
                Ok(())
            } else {
                Err("TERMINAL_BINDING_READBACK_FAILED".to_string())
            }
        });
    if write_result.is_err() {
        return match restore_binding_credentials(&snapshot) {
            Ok(()) => Err("TERMINAL_BINDING_WRITE_FAILED".to_string()),
            Err(error) => Err(error),
        };
    }
    let verification = expected.iter().try_for_each(|(key, expected)| {
        let actual = storage::get_credential_strict(key)
            .map_err(|_| "TERMINAL_BINDING_READBACK_FAILED".to_string())?
            .map(|value| value.to_string());
        if actual.as_deref() == Some(expected.as_str()) {
            Ok(())
        } else {
            Err("TERMINAL_BINDING_READBACK_FAILED".to_string())
        }
    });
    if verification.is_err() {
        return match restore_binding_credentials(&snapshot) {
            Ok(()) => Err("TERMINAL_BINDING_WRITE_FAILED".to_string()),
            Err(_) => Err("TERMINAL_BINDING_COMPENSATION_FAILED".to_string()),
        };
    }
    Ok(serde_json::json!({ "success": true }))
}

fn publish_terminal_binding_under_lock(
    db: &db::DbState,
    payload: &Value,
    finalize: bool,
) -> Result<(Value, bool), String> {
    let pending_before = terminal_connection_rebind_pending_fail_closed(db);
    let previous = resolve_strict_terminal_authority(db)?;
    if !pending_before {
        if let Some(previous) = previous.as_ref() {
            verify_sqlite_binding_mirror(db, previous)?;
        }
    }
    let next_terminal_id = payload_terminal_id_for_switch(payload);
    let next_admin_url = payload_admin_url_for_switch(payload);
    let next_organization_id =
        payload_scope_value_for_switch(payload, "organizationId", "organization_id");
    let next_branch_id = payload_scope_value_for_switch(payload, "branchId", "branch_id");
    let next_api_key = payload_api_key_for_switch(payload)
        .map(|value| api::extract_api_key_from_connection_string(&value).unwrap_or(value));

    if next_terminal_id.is_none()
        || next_admin_url.is_none()
        || next_organization_id.is_none()
        || next_branch_id.is_none()
        || next_api_key.is_none()
    {
        return Err("Terminal binding is incomplete".to_string());
    }
    let target_binding = TerminalBindingTuple {
        terminal_id: next_terminal_id.clone().expect("checked terminal ID"),
        admin_dashboard_url: next_admin_url.clone().expect("checked Admin URL"),
        organization_id: next_organization_id
            .clone()
            .expect("checked organization ID"),
        branch_id: next_branch_id.clone().expect("checked branch ID"),
    };

    let recovering_existing = if pending_before {
        let journal = read_terminal_transition_journal(db)?;
        journal.operation == TerminalTransitionOperation::Rebind
            && journal.terminal_id == target_binding.terminal_id
            && journal.admin_dashboard_url == target_binding.admin_dashboard_url
            && journal.organization_id == target_binding.organization_id
            && journal.branch_id == target_binding.branch_id
            && next_api_key
                .as_deref()
                .is_some_and(|value| api_key_digest(value) == journal.api_key_digest)
    } else {
        false
    };
    if pending_before && !recovering_existing {
        return Err("TERMINAL_TRANSITION_CONFLICT".to_string());
    }
    let current_matches_target = previous.as_ref().is_some_and(|authority| {
        authority.binding == target_binding
            && next_api_key.as_deref().is_some_and(|value| {
                api_key_digest(value) == api_key_digest(authority.api_key.as_str())
            })
    });
    let binding_changed = previous.as_ref().map_or(true, |previous| {
        terminal_connection_changed(
            Some(previous.binding.terminal_id.as_str()),
            next_terminal_id.as_deref(),
            Some(previous.binding.admin_dashboard_url.as_str()),
            next_admin_url.as_deref(),
        ) || scoped_identity_changed(
            Some(previous.binding.organization_id.as_str()),
            next_organization_id.as_deref(),
        ) || scoped_identity_changed(
            Some(previous.binding.branch_id.as_str()),
            next_branch_id.as_deref(),
        )
    }) || pending_before;

    let transition_journal = if binding_changed {
        let journal = if recovering_existing {
            let journal = read_terminal_transition_journal(db)?;
            arm_terminal_identity_rollback_if_needed(&journal)?;
            journal
        } else {
            persist_terminal_rebind_candidate(db, payload, previous.as_ref())?
        };
        Some(journal)
    } else {
        None
    };
    let recovered_phase = transition_journal
        .as_ref()
        .filter(|_| recovering_existing)
        .map(|journal| journal.phase);
    let credentials_already_committed = recovered_phase.is_some_and(|phase| {
        phase.ordinal() >= TerminalTransitionPhase::CredentialsCommitted.ordinal()
    });
    if credentials_already_committed && !current_matches_target {
        return Err("TERMINAL_TRANSITION_RECOVERY_FAILED".to_string());
    }

    let result = if credentials_already_committed {
        serde_json::json!({ "success": true })
    } else {
        match write_binding_credentials_checked(payload) {
            Ok(result) => result,
            Err(error) => {
                if binding_changed && error == "TERMINAL_BINDING_WRITE_FAILED" {
                    let journal = transition_journal
                        .as_ref()
                        .ok_or_else(|| "TERMINAL_BINDING_COMPENSATION_FAILED".to_string())?;
                    let rollback = if journal.old_api_key_present {
                        rollback_terminal_transition_to_old(db, journal)
                    } else {
                        rollback_pre_destructive_rebind_candidate(db)
                    };
                    if rollback.is_err() {
                        return Err("TERMINAL_BINDING_COMPENSATION_FAILED".to_string());
                    }
                }
                return Err(error);
            }
        }
    };
    if binding_changed {
        advance_terminal_transition_phase(db, TerminalTransitionPhase::CredentialsCommitted)?;
    }
    let mirrors_already_committed = recovered_phase.is_some_and(|phase| {
        phase.ordinal() >= TerminalTransitionPhase::MirrorsCommitted.ordinal()
    });
    if mirrors_already_committed {
        verify_complete_sqlite_binding_mirror(db, &target_binding)
            .map_err(|_| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?;
    } else {
        {
            let mut conn = db.conn.lock().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction()
                .map_err(|_| "TERMINAL_BINDING_SQLITE_FAILED".to_string())?;
            for (key, value) in [
                ("terminal_id", target_binding.terminal_id.as_str()),
                (
                    "admin_dashboard_url",
                    target_binding.admin_dashboard_url.as_str(),
                ),
                ("organization_id", target_binding.organization_id.as_str()),
                ("branch_id", target_binding.branch_id.as_str()),
            ] {
                db::set_setting(&tx, "terminal", key, value)?;
            }
            tx.commit()
                .map_err(|_| "TERMINAL_BINDING_SQLITE_FAILED".to_string())?;
        }
        verify_complete_sqlite_binding_mirror(db, &target_binding)
            .map_err(|_| "TERMINAL_BINDING_SQLITE_FAILED".to_string())?;
    }
    if binding_changed {
        advance_terminal_transition_phase(db, TerminalTransitionPhase::MirrorsCommitted)?;
    }

    if binding_changed && finalize {
        prepare_terminal_connection_rebind(db)?;
        advance_terminal_transition_phase(db, TerminalTransitionPhase::OperationalPrepared)?;
        finish_terminal_connection_rebind(db)?;
    }
    Ok((result, binding_changed))
}

pub(crate) fn reconcile_startup_terminal_binding(
    db: &db::DbState,
) -> Result<Option<String>, String> {
    with_settings_durability_owner(|| reconcile_startup_terminal_binding_under_lock(db))
}

fn reconcile_startup_terminal_binding_under_lock(
    db: &db::DbState,
) -> Result<Option<String>, String> {
    if terminal_connection_rebind_pending_fail_closed(db) {
        let journal = read_terminal_transition_journal(db)?;
        let current_api_key = storage::get_credential_strict("pos_api_key")
            .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
            .map(|value| value.to_string());
        let current_digest = current_api_key.as_deref().map(api_key_digest);
        let digest_matches_old = journal.old_api_key_present
            && current_digest.as_deref() == journal.old_api_key_digest.as_deref();
        let current_matches_target = if journal.operation == TerminalTransitionOperation::Rebind {
            let read = |key: &str| {
                storage::get_credential_strict(key)
                    .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())
                    .map(|value| value.map(|value| value.trim().to_string()))
            };
            read("terminal_id")?.as_deref() == Some(journal.terminal_id.as_str())
                && read("admin_dashboard_url")?.as_deref()
                    == Some(journal.admin_dashboard_url.as_str())
                && read("organization_id")?.as_deref() == Some(journal.organization_id.as_str())
                && read("branch_id")?.as_deref() == Some(journal.branch_id.as_str())
        } else {
            false
        };
        let recovery_generation = choose_rebind_recovery_generation(
            &journal,
            current_digest.as_deref(),
            current_matches_target,
        );
        match journal.operation {
            TerminalTransitionOperation::Rebind
                if !journal.old_api_key_present && current_api_key.is_none() =>
            {
                for key in [
                    "terminal_id",
                    "admin_dashboard_url",
                    "organization_id",
                    "branch_id",
                ] {
                    delete_terminal_credential_under_owner(key)
                        .map_err(|_| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?;
                    if storage::get_credential_strict(key)
                        .map_err(|_| "TERMINAL_TRANSITION_RECOVERY_FAILED".to_string())?
                        .is_some()
                    {
                        return Err("TERMINAL_TRANSITION_RECOVERY_FAILED".to_string());
                    }
                }
                rollback_pre_destructive_rebind_candidate(db)?;
                return Ok(None);
            }
            TerminalTransitionOperation::Rebind
                if recovery_generation == RecoveryGeneration::Old =>
            {
                restore_old_authority_from_journal(&journal, current_api_key.as_deref())?;
                rollback_terminal_transition_to_old(db, &journal)?;
                return Ok(journal.old_terminal_id);
            }
            TerminalTransitionOperation::Rebind
                if recovery_generation == RecoveryGeneration::Target =>
            {
                let payload = serde_json::json!({
                    "terminalId": journal.terminal_id,
                    "organizationId": journal.organization_id,
                    "branchId": journal.branch_id,
                    "adminDashboardUrl": journal.admin_dashboard_url,
                    "apiKey": current_api_key.expect("checked candidate API key"),
                });
                publish_terminal_binding_under_lock(db, &payload, true)?;
                return Ok(payload_terminal_id_for_switch(&payload));
            }
            TerminalTransitionOperation::Clear if digest_matches_old => {
                restore_old_authority_from_journal(&journal, current_api_key.as_deref())?;
                rollback_terminal_transition_to_old(db, &journal)?;
                return Ok(journal.old_terminal_id);
            }
            TerminalTransitionOperation::Clear if current_api_key.is_none() => {
                clear_terminal_connection_lifecycle_under_lock(db)?;
                return Ok(None);
            }
            _ => return Err("TERMINAL_TRANSITION_RECOVERY_FAILED".to_string()),
        }
    }
    let authority = match resolve_strict_terminal_authority(db) {
        Ok(authority) => authority,
        Err(error)
            if error == "TERMINAL_MANAGED_TUPLE_MISSING" && has_terminal_operational_state(db) =>
        {
            set_terminal_connection_rebind_pending(db, true)?;
            return Err(
                "Terminal operational state requires a complete durable binding".to_string(),
            );
        }
        Err(error) => return Err(error),
    };
    let Some(authority) = authority else {
        return Ok(None);
    };
    verify_sqlite_binding_mirror(db, &authority)?;
    let payload = serde_json::json!({
        "terminalId": authority.binding.terminal_id,
        "organizationId": authority.binding.organization_id,
        "branchId": authority.binding.branch_id,
        "adminDashboardUrl": authority.binding.admin_dashboard_url,
        "apiKey": authority.api_key.as_str(),
    });
    publish_terminal_binding_under_lock(db, &payload, true)?;
    Ok(payload_terminal_id_for_switch(&payload))
}

async fn validate_terminal_binding_candidate(payload: &Value) -> Result<Value, String> {
    if !payload.is_object() {
        return Err("Terminal credentials payload must be an object".to_string());
    }
    let raw_api_key = payload_api_key_for_switch(payload).ok_or("Missing terminal API key")?;
    let decoded_terminal = api::extract_terminal_id_from_connection_string(&raw_api_key);
    let decoded_admin = api::extract_admin_url_from_connection_string(&raw_api_key)
        .and_then(|value| normalized_admin_url_for_switch(Some(value)));
    let explicit_terminal = crate::value_str(payload, &["terminalId", "terminal_id"])
        .and_then(|value| normalize_non_empty(Some(value)));
    let explicit_admin = crate::value_str(
        payload,
        &["adminDashboardUrl", "adminUrl", "admin_dashboard_url"],
    )
    .and_then(|value| normalized_admin_url_for_switch(Some(value)));
    if decoded_terminal
        .as_deref()
        .zip(explicit_terminal.as_deref())
        .is_some_and(|(decoded, explicit)| decoded != explicit)
        || decoded_admin
            .as_deref()
            .zip(explicit_admin.as_deref())
            .is_some_and(|(decoded, explicit)| decoded != explicit)
    {
        return Err("TERMINAL_CANDIDATE_TUPLE_CONFLICT".to_string());
    }
    let api_key = api::extract_api_key_from_connection_string(&raw_api_key)
        .unwrap_or_else(|| raw_api_key.trim().to_string());
    if api_key.is_empty() {
        return Err("Missing terminal API key".to_string());
    }
    let requested_terminal_id =
        payload_terminal_id_for_switch(payload).ok_or("Missing terminal ID")?;
    let admin_url = payload_admin_url_for_switch(payload).ok_or("Missing Admin Dashboard URL")?;
    let path = format!("/api/pos/settings/{requested_terminal_id}");
    let response = api::fetch_from_admin(&admin_url, &api_key, &path, "GET", None).await?;
    let organization_id = crate::extract_org_id_from_terminal_settings_response(&response)
        .ok_or("Admin terminal settings missing authoritative organization binding")?;
    let branch_id = crate::extract_branch_id_from_terminal_settings_response(&response)
        .ok_or("Admin terminal settings missing authoritative branch binding")?;
    if uuid::Uuid::parse_str(&organization_id).is_err()
        || uuid::Uuid::parse_str(&branch_id).is_err()
    {
        return Err("Admin terminal settings returned invalid tenant binding".to_string());
    }
    let terminal_type = extract_terminal_type_from_terminal_settings_response(&response);
    let operating_mode = extract_pos_operating_mode_from_terminal_settings_response(&response);
    let owner_terminal = extract_owner_terminal_id_from_terminal_settings_response(&response);
    let source_terminal = extract_source_terminal_id_from_terminal_settings_response(&response);
    let response_terminal_id =
        response_string_at_paths(&response, &["/terminal/id", "/terminal_id", "/id"]);
    let authenticated_terminal_id = source_terminal
        .as_deref()
        .or(response_terminal_id.as_deref())
        .unwrap_or(requested_terminal_id.as_str());
    if authenticated_terminal_id != requested_terminal_id {
        return Err("Admin terminal settings returned mismatched terminal binding".to_string());
    }
    let terminal_id = resolve_managed_terminal_identity(
        terminal_type.as_deref(),
        operating_mode.as_deref(),
        owner_terminal.as_deref(),
        source_terminal.as_deref(),
    )
    .unwrap_or(requested_terminal_id);
    let mut candidate = payload.clone();
    let object = candidate
        .as_object_mut()
        .ok_or("Terminal credentials payload must be an object")?;
    object.insert("terminalId".to_string(), Value::String(terminal_id));
    object.insert("organizationId".to_string(), Value::String(organization_id));
    object.insert("branchId".to_string(), Value::String(branch_id));
    object.insert("adminDashboardUrl".to_string(), Value::String(admin_url));
    object.insert("apiKey".to_string(), Value::String(api_key));
    Ok(candidate)
}

fn restart_required_reason_for_setting(full_key: &str) -> Option<&'static str> {
    let normalized = full_key.trim().to_ascii_lowercase();
    if normalized.starts_with("printer.")
        || normalized.starts_with("hardware.")
        || normalized.starts_with("display.")
        || normalized.starts_with("scanner.")
        || normalized.starts_with("scale.")
        || normalized.starts_with("ecr.")
        || normalized.starts_with("payment_terminal.")
        || normalized.starts_with("peripherals.")
    {
        return Some("hardware_config_changed");
    }

    if normalized.starts_with("terminal.admin_dashboard_url")
        || normalized.starts_with("terminal.terminal_id")
    {
        return Some("terminal_connection_changed");
    }

    None
}

fn is_hardware_settings_update(full_key: &str) -> bool {
    let normalized = full_key.trim().to_ascii_lowercase();
    normalized.starts_with("hardware.")
        || normalized.starts_with("display.")
        || normalized.starts_with("scanner.")
        || normalized.starts_with("scale.")
        || normalized.starts_with("printer.")
        || normalized.starts_with("payment_terminal.")
        || normalized.starts_with("peripherals.")
}

fn parse_settings_set_payload(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<SettingsSetPayload, String> {
    let mut category = "general".to_string();
    let mut key: Option<String> = None;
    let mut value_node = arg1.unwrap_or(Value::Null);

    if let Some(Value::Object(obj)) = arg0.as_ref() {
        if let Some(cat) = obj
            .get("category")
            .or_else(|| obj.get("settingType"))
            .and_then(|v| v.as_str())
        {
            if !cat.trim().is_empty() {
                category = cat.trim().to_string();
            }
        }
        key = obj
            .get("key")
            .or_else(|| obj.get("settingKey"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string());
        if value_node.is_null() {
            value_node = obj
                .get("value")
                .or_else(|| obj.get("settingValue"))
                .cloned()
                .unwrap_or(Value::Null);
        }
    }

    if key.is_none() {
        if let Some(Value::String(raw)) = arg0.as_ref() {
            let trimmed = raw.trim();
            if let Some((cat, k)) = trimmed.split_once('.') {
                category = cat.to_string();
                key = Some(k.to_string());
            } else if !trimmed.is_empty() {
                key = Some(trimmed.to_string());
            }
        }
    }

    let key = key.ok_or("Missing setting key")?;
    Ok(SettingsSetPayload {
        category,
        key,
        value_node,
    })
}

fn parse_settings_update_local_payload(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<Vec<(String, String, String)>, String> {
    let mut updates: Vec<(String, String, String)> = Vec::new();

    if let Some(Value::Object(obj)) = arg0.as_ref() {
        if let Some(setting_type) = obj.get("settingType").and_then(|v| v.as_str()) {
            if let Some(settings_obj) = obj.get("settings").and_then(|v| v.as_object()) {
                for (key, value) in settings_obj {
                    updates.push((
                        setting_type.to_string(),
                        key.clone(),
                        value_to_settings_string(value),
                    ));
                }
            }
        }
    }

    if updates.is_empty() {
        match (arg0.as_ref(), arg1.as_ref()) {
            // Bridge form: settings:update-local('terminal', { branch_id: '...' })
            (Some(Value::String(category)), Some(Value::Object(settings_obj))) => {
                for (key, value) in settings_obj {
                    updates.push((
                        category.clone(),
                        key.clone(),
                        value_to_settings_string(value),
                    ));
                }
            }
            // Legacy/flat form: settings:update-local('terminal.branch_id', '...')
            (Some(Value::String(full_key)), Some(value)) => {
                let value = value_to_settings_string(value);
                if let Some((category, key)) = full_key.split_once('.') {
                    updates.push((category.to_string(), key.to_string(), value));
                } else {
                    updates.push(("general".to_string(), full_key.clone(), value));
                }
            }
            _ => {}
        }
    }

    if updates.is_empty() {
        return Err(
            "settings:update-local expects { settingType, settings } or (category, settings)"
                .to_string(),
        );
    }

    Ok(updates)
}

fn parse_terminal_config_get_setting_payload(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> (Option<String>, Option<String>) {
    let mut category: Option<String> = None;
    let mut key: Option<String> = None;

    if let Some(Value::Object(obj)) = arg0.as_ref() {
        category = obj
            .get("category")
            .or_else(|| obj.get("settingType"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        key = obj
            .get("key")
            .or_else(|| obj.get("settingKey"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        if key.is_none() {
            if let Some(Value::String(full_key)) = obj
                .get("fullKey")
                .or_else(|| obj.get("setting"))
                .or_else(|| obj.get("name"))
            {
                if let Some((cat, k)) = full_key.split_once('.') {
                    category = Some(cat.to_string());
                    key = Some(k.to_string());
                } else if !full_key.trim().is_empty() {
                    key = Some(full_key.trim().to_string());
                }
            }
        }
    }

    if category.is_none() || key.is_none() {
        if let (Some(Value::String(cat)), Some(Value::String(k))) = (arg0.as_ref(), arg1.as_ref()) {
            if category.is_none() && !cat.trim().is_empty() {
                category = Some(cat.trim().to_string());
            }
            if key.is_none() && !k.trim().is_empty() {
                key = Some(k.trim().to_string());
            }
        }
    }

    if key.is_none() {
        if let Some(Value::String(single)) = arg0.as_ref() {
            let trimmed = single.trim();
            if let Some((cat, k)) = trimmed.split_once('.') {
                category = Some(cat.to_string());
                key = Some(k.to_string());
            } else if !trimmed.is_empty() {
                key = Some(trimmed.to_string());
            }
        }
    }

    (category, key)
}

fn parse_json_string(value: &str) -> Value {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Value::Null;
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return parsed;
    }

    match trimmed.to_ascii_lowercase().as_str() {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => Value::String(trimmed.to_string()),
    }
}

fn read_runtime_setting(db: &db::DbState, category: &str, key: &str) -> Option<String> {
    let conn = db.conn.lock().ok()?;
    db::get_setting(&conn, category, key)
}

pub(crate) fn build_terminal_runtime_config(db: &db::DbState) -> Value {
    let strict_terminal = storage::get_credential_strict("terminal_id");
    let strict_admin = storage::get_credential_strict("admin_dashboard_url");
    let strict_branch = storage::get_credential_strict("branch_id");
    let strict_org = storage::get_credential_strict("organization_id");
    let credential_unavailable = strict_terminal.is_err()
        || strict_admin.is_err()
        || strict_branch.is_err()
        || strict_org.is_err();
    let terminal_id = strict_terminal
        .ok()
        .flatten()
        .map(|value| value.to_string());
    let branch_id = strict_branch.ok().flatten().map(|value| value.to_string());
    let organization_id = strict_org.ok().flatten().map(|value| value.to_string());
    let admin_dashboard_url = strict_admin.ok().flatten().map(|value| value.to_string());
    let business_type = storage::get_credential_strict("business_type")
        .ok()
        .flatten()
        .map(|value| value.to_string())
        .or_else(|| read_runtime_setting(db, "general", "business_type"))
        .unwrap_or_else(|| "food".to_string());
    let terminal_type = read_runtime_setting(db, "terminal", "terminal_type");
    let parent_terminal_id = read_runtime_setting(db, "terminal", "parent_terminal_id");
    let owner_terminal_id = read_runtime_setting(db, "terminal", "owner_terminal_id");
    let owner_terminal_db_id = read_runtime_setting(db, "terminal", "owner_terminal_db_id");
    let source_terminal_id = read_runtime_setting(db, "terminal", "source_terminal_id");
    let source_terminal_db_id = read_runtime_setting(db, "terminal", "source_terminal_db_id");
    let pos_operating_mode = read_runtime_setting(db, "terminal", "pos_operating_mode");
    let enabled_features = read_runtime_setting(db, "terminal", "enabled_features")
        .map(|raw| parse_json_string(&raw))
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let last_config_sync_at = read_runtime_setting(db, "terminal", "last_config_sync_at");
    let ghost_mode_feature_enabled = storage::get_credential_strict("ghost_mode_feature_enabled")
        .ok()
        .flatten()
        .map(|value| value.to_string());

    let sync_health = if credential_unavailable {
        "unavailable"
    } else if terminal_id.as_deref().unwrap_or("").trim().is_empty()
        || admin_dashboard_url
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        "offline"
    } else if let Some(last_sync) = last_config_sync_at.as_deref() {
        let age_ms = chrono::DateTime::parse_from_rfc3339(last_sync)
            .ok()
            .map(|parsed| {
                Utc::now()
                    .signed_duration_since(parsed.with_timezone(&Utc))
                    .num_milliseconds()
                    .max(0)
            })
            .unwrap_or(TERMINAL_RUNTIME_STALE_AFTER_MS + 1);
        if age_ms > TERMINAL_RUNTIME_STALE_AFTER_MS {
            "stale"
        } else {
            "polling"
        }
    } else {
        "offline"
    };

    serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "organization_id": organization_id,
        "admin_dashboard_url": admin_dashboard_url,
        "admin_url": admin_dashboard_url,
        "business_type": business_type,
        "terminal_type": terminal_type,
        "parent_terminal_id": parent_terminal_id,
        "owner_terminal_id": owner_terminal_id,
        "owner_terminal_db_id": owner_terminal_db_id,
        "source_terminal_id": source_terminal_id,
        "source_terminal_db_id": source_terminal_db_id,
        "pos_operating_mode": pos_operating_mode,
        "enabled_features": enabled_features,
        "last_config_sync_at": last_config_sync_at,
        "ghost_mode_feature_enabled": ghost_mode_feature_enabled,
        "credential_state": if credential_unavailable { "unavailable" } else { "available" },
        "sync_health": sync_health,
        // Compatibility aliases while renderer migrates to the new DTO.
        "terminalType": terminal_type,
        "parentTerminalId": parent_terminal_id,
        "ownerTerminalId": owner_terminal_id,
        "ownerTerminalDbId": owner_terminal_db_id,
        "sourceTerminalId": source_terminal_id,
        "sourceTerminalDbId": source_terminal_db_id,
        "posOperatingMode": pos_operating_mode,
        "features": enabled_features,
    })
}

fn terminal_runtime_emit_signature(config: &Value) -> Value {
    serde_json::json!({
        "terminal_id": config.get("terminal_id").cloned().unwrap_or(Value::Null),
        "branch_id": config.get("branch_id").cloned().unwrap_or(Value::Null),
        "organization_id": config.get("organization_id").cloned().unwrap_or(Value::Null),
        "admin_dashboard_url": config.get("admin_dashboard_url").cloned().unwrap_or(Value::Null),
        "business_type": config.get("business_type").cloned().unwrap_or(Value::Null),
        "terminal_type": config.get("terminal_type").cloned().unwrap_or(Value::Null),
        "parent_terminal_id": config.get("parent_terminal_id").cloned().unwrap_or(Value::Null),
        "owner_terminal_id": config.get("owner_terminal_id").cloned().unwrap_or(Value::Null),
        "owner_terminal_db_id": config.get("owner_terminal_db_id").cloned().unwrap_or(Value::Null),
        "source_terminal_id": config.get("source_terminal_id").cloned().unwrap_or(Value::Null),
        "source_terminal_db_id": config.get("source_terminal_db_id").cloned().unwrap_or(Value::Null),
        "pos_operating_mode": config.get("pos_operating_mode").cloned().unwrap_or(Value::Null),
        "enabled_features": config.get("enabled_features").cloned().unwrap_or_else(|| serde_json::json!({})),
        "ghost_mode_feature_enabled": config.get("ghost_mode_feature_enabled").cloned().unwrap_or(Value::Null),
        "sync_health": config.get("sync_health").cloned().unwrap_or(Value::Null),
    })
}

fn should_emit_terminal_runtime_update(config: &Value) -> bool {
    let signature = terminal_runtime_emit_signature(config);
    let state = LAST_TERMINAL_RUNTIME_EMIT_SIGNATURE.get_or_init(|| Mutex::new(None));
    let mut last_signature = state.lock().expect("lock terminal runtime emit signature");
    if last_signature.as_ref() == Some(&signature) {
        return false;
    }
    *last_signature = Some(signature);
    true
}

fn emit_terminal_runtime_update(
    app: &tauri::AppHandle,
    db: &db::DbState,
    source: &str,
    updated: Option<Vec<String>>,
) {
    let mut payload = build_terminal_runtime_config(db);
    if !should_emit_terminal_runtime_update(&payload) {
        return;
    }
    if let Some(map) = payload.as_object_mut() {
        map.insert("source".to_string(), serde_json::json!(source));
        if let Some(updated_keys) = updated {
            map.insert("updated".to_string(), serde_json::json!(updated_keys));
        }
    }

    let _ = app.emit("terminal_config_updated", payload.clone());
    let _ = app.emit("terminal_settings_updated", payload);
}

pub(crate) async fn refresh_terminal_context_from_admin(db: &db::DbState) -> Result<(), String> {
    refresh_terminal_context_from_admin_with_completion(db, || Ok(())).await
}

pub(crate) async fn refresh_terminal_context_from_admin_with_completion<F>(
    db: &db::DbState,
    completion: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    let raw_api_key = storage::get_credential_strict("pos_api_key")
        .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
        .ok_or("Terminal not configured: missing API key")?;
    let (normalized_admin_url, api_key) = crate::resolve_admin_endpoint(Some(db))
        .await
        .map_err(|error| error.to_string())?;
    let terminal_id = storage::get_credential_strict("terminal_id")
        .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
        .map(|value| value.to_string())
        .or_else(|| crate::read_local_setting(db, "terminal", "terminal_id"))
        .or_else(|| api::extract_terminal_id_from_connection_string(&raw_api_key))
        .ok_or("Terminal not configured: missing terminal ID")?;
    let terminal_id = terminal_id.trim().to_string();
    if terminal_id.is_empty() {
        return Err("Terminal not configured: missing terminal ID".into());
    }

    let path = format!("/api/pos/settings/{terminal_id}");
    let resp = api::fetch_from_admin(&normalized_admin_url, &api_key, &path, "GET", None).await?;

    let branch_id = crate::extract_branch_id_from_terminal_settings_response(&resp)
        .ok_or("Admin terminal settings missing authoritative branch binding")?;
    let organization_id = crate::extract_org_id_from_terminal_settings_response(&resp)
        .ok_or("Admin terminal settings missing authoritative organization binding")?;
    if uuid::Uuid::parse_str(&branch_id).is_err()
        || uuid::Uuid::parse_str(&organization_id).is_err()
    {
        return Err("Admin terminal settings returned invalid tenant binding".to_string());
    }
    let response_terminal_type = extract_terminal_type_from_terminal_settings_response(&resp);
    let response_operating_mode = extract_pos_operating_mode_from_terminal_settings_response(&resp);
    let response_owner_terminal = extract_owner_terminal_id_from_terminal_settings_response(&resp);
    let response_source_terminal =
        extract_source_terminal_id_from_terminal_settings_response(&resp);
    let response_terminal_id =
        response_string_at_paths(&resp, &["/terminal/id", "/terminal_id", "/id"]);
    let authenticated_terminal_id = response_source_terminal
        .as_deref()
        .or(response_terminal_id.as_deref())
        .unwrap_or(terminal_id.as_str());
    if authenticated_terminal_id != terminal_id {
        return Err("Admin terminal settings returned mismatched terminal binding".to_string());
    }
    let authoritative_terminal_id = resolve_managed_terminal_identity(
        response_terminal_type.as_deref(),
        response_operating_mode.as_deref(),
        response_owner_terminal.as_deref(),
        response_source_terminal.as_deref(),
    )
    .unwrap_or_else(|| terminal_id.clone());
    let candidate = serde_json::json!({
        "terminalId": authoritative_terminal_id,
        "organizationId": organization_id,
        "branchId": branch_id,
        "adminDashboardUrl": normalized_admin_url,
        "apiKey": api_key.trim(),
    });
    let _durability = SETTINGS_DURABILITY_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "SETTINGS_DURABILITY_UNAVAILABLE".to_string())?;
    let (_, binding_changed) = publish_terminal_binding_under_lock(db, &candidate, false)?;
    let mut secondary_updates = Vec::new();
    let mut push_terminal = |key: &str, value: Option<String>| {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            secondary_updates.push(("terminal".to_string(), key.to_string(), value));
        }
    };
    push_terminal(
        "ghost_mode_feature_enabled",
        crate::extract_ghost_mode_feature_from_terminal_settings_response(&resp)
            .map(|enabled| if enabled { "true" } else { "false" }.to_string()),
    );
    push_terminal("terminal_type", response_terminal_type.clone());
    push_terminal(
        "parent_terminal_id",
        extract_parent_terminal_id_from_terminal_settings_response(&resp),
    );
    push_terminal("owner_terminal_id", response_owner_terminal.clone());
    push_terminal(
        "owner_terminal_db_id",
        extract_owner_terminal_db_id_from_terminal_settings_response(&resp),
    );
    push_terminal("source_terminal_id", response_source_terminal.clone());
    push_terminal(
        "source_terminal_db_id",
        extract_source_terminal_db_id_from_terminal_settings_response(&resp),
    );
    push_terminal("pos_operating_mode", response_operating_mode.clone());
    if let Some(features) = extract_enabled_features_from_terminal_settings_response(&resp) {
        push_terminal(
            "enabled_features",
            Some(
                serde_json::to_string(&features)
                    .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?,
            ),
        );
    }
    let supabase = resp.get("supabase");
    let supabase_url = supabase
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if storage::get_credential_strict("supabase_url")
        .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?
        .is_none()
    {
        push_terminal("supabase_url", supabase_url.map(ToString::to_string));
    }
    push_terminal("last_config_sync_at", Some(Utc::now().to_rfc3339()));
    let supabase_anon_key = supabase
        .and_then(|value| value.get("anon_key"))
        .and_then(Value::as_str);
    apply_refresh_secondary_settings_under_lock(db, &secondary_updates, supabase_anon_key)?;

    crate::cache_terminal_settings_snapshot(db, &resp)
        .map_err(|_| "SETTINGS_DURABLE_WRITE_FAILED".to_string())?;
    if binding_changed {
        prepare_terminal_connection_rebind(db)?;
        finish_terminal_connection_rebind(db)?;
    }
    completion()?;

    Ok(())
}

fn build_terminal_auth_failure_response(
    db: &db::DbState,
    sync_state: &crate::sync::SyncState,
    app: &tauri::AppHandle,
    source: &str,
    error: &str,
) -> Result<Value, String> {
    if crate::sync::terminal_auth_failure_requires_reset(error) {
        crate::terminal_helpers::handle_invalid_terminal_credentials_checked(
            Some(db),
            app,
            source,
            error,
        )?;
        Ok(serde_json::json!({
            "success": false,
            "errorCode": "invalid_terminal_credentials",
            "reason": "terminal_credentials_rejected",
            "source": source
        }))
    } else {
        crate::sync::handle_soft_terminal_auth_failure(db, sync_state, app, source, error);
        Ok(serde_json::json!({
            "success": false,
            "errorCode": "terminal_auth_paused",
            "reason": "terminal_auth_paused",
            "source": source
        }))
    }
}

#[tauri::command]
pub async fn settings_is_configured(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let configured = !terminal_connection_rebind_pending_fail_closed(&db)
        && resolve_strict_terminal_authority(&db)?.is_some();
    let reason = if configured {
        "all_credentials_present"
    } else {
        "missing_credentials"
    };
    Ok(serde_json::json!({ "configured": configured, "reason": reason }))
}

#[tauri::command]
pub async fn settings_get_reset_status() -> Result<Value, String> {
    match reset::get_reset_status()? {
        Some(status) => {
            serde_json::to_value(status).map_err(|e| format!("serialize reset status: {e}"))
        }
        None => Ok(Value::Null),
    }
}

#[tauri::command]
pub async fn settings_get(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = crate::parse_channel_payload(arg0.clone(), arg1.clone());
    let mut category = crate::value_str(&payload, &["category", "settingType"]);
    let mut key = crate::value_str(&payload, &["key", "settingKey"]);
    let default_value = payload
        .get("defaultValue")
        .cloned()
        .or_else(|| payload.get("default").cloned())
        .or(arg2)
        .unwrap_or(serde_json::Value::Null);

    if category.is_none() || key.is_none() {
        if let (Some(serde_json::Value::String(cat)), Some(serde_json::Value::String(k))) =
            (arg0.as_ref(), arg1.as_ref())
        {
            category = Some(cat.clone());
            key = Some(k.clone());
        }
    }

    if key.is_none() {
        if let Some(serde_json::Value::String(single)) = arg0.as_ref() {
            if let Some((cat, k)) = single.split_once('.') {
                category = Some(cat.to_string());
                key = Some(k.to_string());
            } else {
                key = Some(single.clone());
            }
        }
    }

    if let (Some(cat), Some(k)) = (category.clone(), key.clone()) {
        if crate::is_sensitive_setting_path(&cat, &k) {
            if !default_value.is_null() {
                return Ok(default_value);
            }
            return Ok(serde_json::Value::Null);
        }

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if let Some(v) = db::get_setting(&conn, &cat, &k) {
            return Ok(serde_json::Value::String(v));
        }
        drop(conn);

        if cat == "terminal" {
            if let Some(credential_key) = crate::credential_key_for_terminal_setting(&k) {
                if let Some(v) = storage::get_credential(credential_key) {
                    return Ok(serde_json::Value::String(v));
                }
            }
        }

        if !default_value.is_null() {
            return Ok(default_value);
        }
        return Ok(serde_json::Value::Null);
    }

    if let Some(k) = key {
        // Legacy one-arg form: settings:get('terminal_id')
        if crate::is_sensitive_setting_path("general", &k) {
            if !default_value.is_null() {
                return Ok(default_value);
            }
            return Ok(serde_json::Value::Null);
        }
        return Ok(storage::settings_get(Some(&k)));
    }

    get_settings(db).await
}

#[tauri::command]
pub async fn settings_get_local(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    if arg0.is_none() {
        return get_settings(db).await;
    }

    if let Some(serde_json::Value::String(key)) = arg0 {
        if let Some((category, setting_key)) = key.split_once('.') {
            if crate::is_sensitive_setting_path(category, setting_key) {
                return Ok(serde_json::Value::Null);
            }

            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            if let Some(v) = db::get_setting(&conn, category, setting_key) {
                return Ok(serde_json::Value::String(v));
            }
            drop(conn);

            if category == "terminal" {
                if let Some(credential_key) =
                    crate::credential_key_for_terminal_setting(setting_key)
                {
                    if let Some(v) = storage::get_credential(credential_key) {
                        return Ok(serde_json::Value::String(v));
                    }
                }
            }
            return Ok(serde_json::Value::Null);
        }
        if crate::is_sensitive_setting_path("general", &key) {
            return Ok(serde_json::Value::Null);
        }
        return Ok(storage::settings_get(Some(&key)));
    }

    get_settings(db).await
}

fn prepare_repair_process_reset(
    _db: &db::DbState,
) -> Result<crate::repairs::RepairTransitionGuard, String> {
    crate::repairs::arm_process_reset()
}

fn run_process_reset_with_recovery<D, L>(
    db: &db::DbState,
    kind: crate::recovery::RecoveryPointKind,
    recovery_preflight: D,
    launch_helper: L,
) -> Result<Value, String>
where
    D: FnOnce(
        &db::DbState,
        crate::recovery::RecoveryPointKind,
    ) -> Result<crate::recovery::DestructiveSnapshotDecision, String>,
    L: FnOnce() -> reset::ResetLaunchOutcome,
{
    let _reset_orchestration = reset::acquire_reset_orchestration()?;
    if let Some(existing) = reset::existing_accepted_reset_ownership()? {
        return existing.into_command_result();
    }
    let _repair_reset_transition = prepare_repair_process_reset(db)?;
    let _recovery_decision = recovery_preflight(db, kind)?;
    reset::clear_reset_status()?;
    let outcome = launch_helper();
    if let Err(error) = reset::persist_reset_launch_outcome(&outcome) {
        match &outcome {
            reset::ResetLaunchOutcome::Accepted { .. } => tracing::warn!(
                error = %error,
                "Accepted reset ownership metadata update failed; returning accepted ownership"
            ),
            reset::ResetLaunchOutcome::NotStarted { .. } => {
                return Err(format!("{error}; reset helper was not started"));
            }
        }
    }
    outcome.into_command_result()
}

#[tauri::command]
pub async fn settings_factory_reset(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, auth::AuthState>,
    cancel_token: tauri::State<'_, tokio_util::sync::CancellationToken>,
    device_manager: tauri::State<'_, crate::ecr::DeviceManager>,
) -> Result<Value, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    run_process_reset_with_recovery(
        &db,
        crate::recovery::RecoveryPointKind::PreFactoryReset,
        crate::recovery::preflight_snapshot_before_destructive_action,
        || {
            reset::launch_reset(
                &app,
                reset::ResetMode::FactoryReset,
                cancel_token.inner(),
                device_manager.inner(),
            )
        },
    )
    .map_err(Into::into)
}

#[tauri::command]
pub async fn settings_update_terminal_credentials(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    sync_state: tauri::State<'_, std::sync::Arc<crate::sync::SyncState>>,
) -> Result<Value, String> {
    let payload = arg0.ok_or("Missing credentials payload")?;
    let validated_payload = validate_terminal_binding_candidate(&payload).await?;
    let (result, _binding_changed) = publish_terminal_binding_checked(&db, &validated_payload)?;

    // After saving credentials, fetch terminal config from admin API
    // to populate branch_id, organization_id, and feature flags.
    match refresh_terminal_context_from_admin(&db).await {
        Ok(()) => {
            sync_state.clear_remote_auth_pause();
        }
        Err(e) => {
            tracing::warn!(error = %e, "Failed to fetch terminal config from admin");
            if crate::is_terminal_auth_failure(&e) {
                let failure = build_terminal_auth_failure_response(
                    &db,
                    sync_state.inner().as_ref(),
                    &app,
                    "settings_update_terminal_credentials",
                    &e,
                )?;
                let message = failure
                    .get("errorCode")
                    .and_then(Value::as_str)
                    .unwrap_or("terminal_auth_failed")
                    .to_string();
                return Err(message);
            }
            return Err(e);
        }
    }

    let mut credentials_payload = build_terminal_runtime_config(&db);
    if let Some(map) = credentials_payload.as_object_mut() {
        map.insert("success".to_string(), serde_json::json!(true));
    }
    let _ = app.emit("terminal_credentials_updated", credentials_payload);
    let _ = app.emit("terminal_enabled", serde_json::json!({ "success": true }));
    emit_terminal_runtime_update(&app, &db, "settings_update_terminal_credentials", None);
    crate::scrub_sensitive_local_settings(&db);

    Ok(result)
}

#[tauri::command]
pub async fn settings_get_admin_url(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    if terminal_connection_rebind_pending_fail_closed(&db) {
        return Err("TERMINAL_TRANSITION_PENDING".to_string());
    }
    Ok(resolve_strict_terminal_authority(&db)?
        .map(|authority| Value::String(authority.binding.admin_dashboard_url))
        .unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn settings_get_pos_api_key(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let _ = db;
    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub async fn settings_get_credential_status(
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    credential_status_projection(&db)
}

fn credential_status_projection(db: &db::DbState) -> Result<Value, String> {
    if terminal_connection_rebind_pending_fail_closed(db) {
        return Ok(serde_json::json!({
            "hasAdminUrl": false,
            "hasApiKey": false,
            "hasTerminalId": false,
            "reason": "terminal_transition_pending",
        }));
    }
    let configured = resolve_strict_terminal_authority(db)?.is_some();

    Ok(serde_json::json!({
        "hasAdminUrl": configured,
        "hasApiKey": configured,
        "hasTerminalId": configured,
        "reason": if configured { "strict_managed_tuple" } else { "managed_tuple_unavailable" },
    }))
}

/// Returns all settings merged: local_settings DB + terminal credential store.
/// The StaffShiftModal uses this to look up `terminal.branch_id`.
#[tauri::command]
pub async fn get_settings(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let mut all = renderer_settings_snapshot(&db)?;

    // Merge credential store values into terminal.*
    let map = all.as_object_mut().ok_or("internal")?;
    let terminal = map
        .entry("terminal")
        .or_insert_with(|| serde_json::json!({}));
    if let serde_json::Value::Object(ref mut t) = terminal {
        if let Some(bid) = storage::get_credential("branch_id") {
            t.entry("branch_id")
                .or_insert(serde_json::Value::String(bid));
        }
        if let Some(oid) = storage::get_credential("organization_id") {
            t.entry("organization_id")
                .or_insert(serde_json::Value::String(oid));
        }
        if let Some(tid) = storage::get_credential("terminal_id") {
            t.entry("terminal_id")
                .or_insert(serde_json::Value::String(tid));
        }
        if let Some(admin) = storage::get_credential("admin_dashboard_url") {
            t.entry("admin_dashboard_url")
                .or_insert(serde_json::Value::String(admin));
        }
        if let Some(bt) = storage::get_credential("business_type") {
            t.entry("business_type")
                .or_insert(serde_json::Value::String(bt));
        }
        if let Some(ghost_feature) = storage::get_credential("ghost_mode_feature_enabled") {
            t.entry("ghost_mode_feature_enabled")
                .or_insert(serde_json::Value::String(ghost_feature));
        }
    }

    // Also add flat keys for legacy lookups (e.g. `terminal.branch_id`)
    let bid_flat = storage::get_credential("branch_id");
    if let Some(bid) = bid_flat {
        map.insert("terminal.branch_id".into(), serde_json::Value::String(bid));
    }
    if let Some(oid) = storage::get_credential("organization_id") {
        map.insert(
            "terminal.organization_id".into(),
            serde_json::Value::String(oid),
        );
    }
    if let Some(tid) = storage::get_credential("terminal_id") {
        map.insert(
            "terminal.terminal_id".into(),
            serde_json::Value::String(tid),
        );
    }
    if let Some(admin) = storage::get_credential("admin_dashboard_url") {
        map.insert(
            "terminal.admin_dashboard_url".into(),
            serde_json::Value::String(admin),
        );
    }
    if let Some(ghost_feature) = storage::get_credential("ghost_mode_feature_enabled") {
        map.insert(
            "terminal.ghost_mode_feature_enabled".into(),
            serde_json::Value::String(ghost_feature),
        );
    }

    Ok(all)
}

#[tauri::command]
pub async fn settings_clear_connection(
    app: tauri::AppHandle,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, auth::GuardedCommandError> {
    settings_clear_connection_checked(&db, &auth_state)?;
    app.emit(
        "terminal_disabled",
        serde_json::json!({ "reason": "connection_cleared" }),
    )
    .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

fn settings_clear_connection_checked(
    db: &db::DbState,
    auth_state: &auth::AuthState,
) -> Result<(), auth::GuardedCommandError> {
    auth::authorize_privileged_action(auth::PrivilegedActionScope::SystemControl, db, auth_state)?;
    clear_terminal_connection_lifecycle(db).map_err(Into::into)
}

pub(crate) fn clear_terminal_connection_lifecycle(db: &db::DbState) -> Result<(), String> {
    with_settings_durability_owner(|| clear_terminal_connection_lifecycle_under_lock(db))
}

fn clear_terminal_connection_lifecycle_under_lock(db: &db::DbState) -> Result<(), String> {
    let existing_journal = match read_terminal_transition_journal(db) {
        Ok(journal) => Some(journal),
        Err(error) if error == "TERMINAL_REBIND_CANDIDATE_REQUIRED" => None,
        Err(error) => return Err(error),
    };
    let previous = if existing_journal
        .as_ref()
        .is_some_and(|journal| journal.operation == TerminalTransitionOperation::Clear)
    {
        None
    } else {
        resolve_strict_terminal_authority(db)?
    };
    if existing_journal.is_none() {
        let previous = previous
            .as_ref()
            .ok_or_else(|| "TERMINAL_MANAGED_TUPLE_MISSING".to_string())?;
        let mut journal = TerminalRebindCandidateJournal {
            version: 3,
            operation_id: Some(uuid::Uuid::new_v4().to_string()),
            repair_scope_rollback: None,
            operation: TerminalTransitionOperation::Clear,
            phase: TerminalTransitionPhase::Intent,
            organization_id: String::new(),
            branch_id: String::new(),
            terminal_id: String::new(),
            admin_dashboard_url: String::new(),
            api_key_digest: api_key_digest(""),
            old_terminal_id: Some(previous.binding.terminal_id.clone()),
            old_admin_dashboard_url: Some(previous.binding.admin_dashboard_url.clone()),
            old_organization_id: Some(previous.binding.organization_id.clone()),
            old_branch_id: Some(previous.binding.branch_id.clone()),
            old_api_key_digest: Some(api_key_digest(previous.api_key.as_str())),
            old_api_key_present: true,
        };
        let binding = terminal_identity_rollback_binding(&journal)?;
        crate::repairs::prepare_and_arm_terminal_identity_transition(&binding, |envelope| {
            journal.repair_scope_rollback = envelope.cloned();
            persist_terminal_transition_intent(db, &journal, "TERMINAL_CLEAR_JOURNAL_FAILED")
        })?;
    }
    let journal = read_terminal_transition_journal(db)?;
    if journal.operation != TerminalTransitionOperation::Clear {
        return Err("TERMINAL_TRANSITION_CONFLICT".to_string());
    }
    if existing_journal.is_some() {
        arm_terminal_identity_rollback_if_needed(&journal)?;
    }
    let api_before = storage::get_credential_strict("pos_api_key")
        .map_err(|_| "TERMINAL_CLEAR_READ_FAILED".to_string())?
        .map(|value| value.to_string());
    let api_committed = api_before.is_none();
    for key in [
        "terminal_id",
        "admin_dashboard_url",
        "organization_id",
        "branch_id",
    ] {
        if let Err(_error) = delete_terminal_credential_under_owner(key) {
            if !api_committed {
                return rollback_clear_before_api_commit(
                    db,
                    &journal,
                    api_before.as_deref().expect("checked old API key"),
                    "TERMINAL_CLEAR_WRITE_FAILED",
                );
            }
            return Err("TERMINAL_CLEAR_WRITE_FAILED".to_string());
        }
        match storage::get_credential_strict(key) {
            Ok(None) => {}
            _ if !api_committed => {
                return rollback_clear_before_api_commit(
                    db,
                    &journal,
                    api_before.as_deref().expect("checked old API key"),
                    "TERMINAL_CLEAR_READBACK_FAILED",
                );
            }
            _ => return Err("TERMINAL_CLEAR_READBACK_FAILED".to_string()),
        }
    }
    if !api_committed && delete_terminal_credential_under_owner("pos_api_key").is_err() {
        return rollback_clear_before_api_commit(
            db,
            &journal,
            api_before.as_deref().expect("checked old API key"),
            "TERMINAL_CLEAR_WRITE_FAILED",
        );
    }
    if storage::get_credential_strict("pos_api_key")
        .map_err(|_| "TERMINAL_CLEAR_READBACK_FAILED".to_string())?
        .is_some()
    {
        return Err("TERMINAL_CLEAR_READBACK_FAILED".to_string());
    }
    advance_terminal_transition_phase(db, TerminalTransitionPhase::CredentialsCommitted)?;
    {
        let mut conn = db
            .conn
            .lock()
            .map_err(|_| "TERMINAL_CLEAR_SQLITE_FAILED".to_string())?;
        let transaction = conn
            .transaction()
            .map_err(|_| "TERMINAL_CLEAR_SQLITE_FAILED".to_string())?;
        for key in [
            "pos_api_key",
            "api_key",
            "terminal_id",
            "admin_dashboard_url",
            "admin_url",
            "organization_id",
            "branch_id",
        ] {
            db::delete_setting(&transaction, "terminal", key)
                .map_err(|_| "TERMINAL_CLEAR_SQLITE_FAILED".to_string())?;
        }
        transaction
            .commit()
            .map_err(|_| "TERMINAL_CLEAR_SQLITE_FAILED".to_string())?;
        for key in [
            "pos_api_key",
            "api_key",
            "terminal_id",
            "admin_dashboard_url",
            "admin_url",
            "organization_id",
            "branch_id",
        ] {
            if db::get_setting(&conn, "terminal", key).is_some() {
                return Err("TERMINAL_CLEAR_SQLITE_FAILED".to_string());
            }
        }
    }
    advance_terminal_transition_phase(db, TerminalTransitionPhase::MirrorsCommitted)?;
    let (repair_transition, _recovery) = crate::prepare_operational_clear(db)?;
    crate::clear_operational_data_while_repair_blocked(db, &repair_transition)?;
    storage::invalidate_terminal_authority()?;
    storage::delete_repair_identity_uncoordinated()?;
    for key in [
        "business_type",
        "supabase_url",
        "supabase_anon_key",
        "ghost_mode_feature_enabled",
    ] {
        storage::delete_credential(key)?;
    }
    {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        for key in [
            "admin_dashboard_url",
            "admin_url",
            "pos_api_key",
            "api_key",
            "terminal_id",
            "organization_id",
            "branch_id",
            "business_type",
            "supabase_url",
            "supabase_anon_key",
            "ghost_mode_feature_enabled",
            "terminal_type",
            "parent_terminal_id",
            "parent_terminal_db_id",
            "owner_terminal_id",
            "owner_terminal_db_id",
            "source_terminal_id",
            "source_terminal_db_id",
            "pos_operating_mode",
            "enabled_features",
            storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
        ] {
            db::delete_setting(&conn, "terminal", key)?;
        }
    }
    scrub_sensitive_local_settings_checked(db)?;
    {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        crate::repairs::finish_operational_clear(&conn, &repair_transition)?;
    }
    advance_terminal_transition_phase(db, TerminalTransitionPhase::OperationalPrepared)?;
    clear_terminal_transition_journal_verified(db)
}

#[tauri::command]
pub async fn settings_set(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let parsed = parse_settings_set_payload(arg0, arg1)?;
    let category = parsed.category;
    let key = parsed.key;
    validate_generic_setting_update(&category, &key)?;
    let value = match parsed.value_node {
        serde_json::Value::String(s) => s,
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    };
    apply_generic_settings_and_credentials_checked(
        &db,
        &[(category.clone(), key.clone(), value.clone())],
    )?;

    let full_key = format!("{category}.{key}");
    app.emit("settings_update", serde_json::json!({ "key": full_key }))
        .map_err(|error| error.to_string())?;
    app.emit(
        "terminal_settings_updated",
        serde_json::json!({ "key": full_key }),
    )
    .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_update_local(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let updates = parse_settings_update_local_payload(arg0, arg1)?;

    let normalized_updates = updates;
    apply_generic_settings_and_credentials_checked(&db, &normalized_updates)?;

    let updated_keys: Vec<String> = normalized_updates
        .iter()
        .map(|(cat, key, _)| format!("{cat}.{key}"))
        .collect();
    app.emit(
        "settings_update",
        serde_json::json!({ "updated": updated_keys.clone() }),
    )
    .map_err(|error| error.to_string())?;
    app.emit(
        "terminal_settings_updated",
        serde_json::json!({ "updated": updated_keys.clone() }),
    )
    .map_err(|error| error.to_string())?;
    if updated_keys
        .iter()
        .any(|full_key| is_hardware_settings_update(full_key))
    {
        app.emit(
            "hardware_config_update",
            serde_json::json!({
                "source": "settings_update_local",
                "updated": updated_keys.clone(),
            }),
        )
        .map_err(|error| error.to_string())?;
    }
    if let Some(reason) = updated_keys
        .iter()
        .find_map(|full_key| restart_required_reason_for_setting(full_key))
    {
        app.emit(
            "app_restart_required",
            serde_json::json!({
                "reason": reason,
                "hardware_type": "configuration",
                "updated": updated_keys.clone(),
            }),
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_get_discount_max(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "discount_max");
    Ok(match val {
        Some(v) => serde_json::json!(v.parse::<f64>().unwrap_or(100.0)),
        None => serde_json::json!(100.0),
    })
}

#[tauri::command]
pub async fn settings_set_discount_max(
    arg0: Option<f64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let pct = arg0.unwrap_or(100.0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "discount_max", &pct.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_get_tax_rate(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "tax_rate");
    Ok(match val {
        Some(v) => serde_json::json!(v.parse::<f64>().unwrap_or(0.0)),
        None => serde_json::json!(0.0),
    })
}

#[tauri::command]
pub async fn settings_set_tax_rate(
    arg0: Option<f64>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let pct = arg0.unwrap_or(0.0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "tax_rate", &pct.to_string())?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn settings_get_language(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let val = db::get_setting(&conn, "general", "language");
    Ok(serde_json::Value::String(
        val.unwrap_or_else(|| "en".into()),
    ))
}

#[tauri::command]
pub async fn settings_set_language(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let lang = arg0.unwrap_or_else(|| "en".into());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "general", "language", &lang)?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn update_settings(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let updates = normalize_dotted_settings_updates(&payload)?;
    apply_generic_settings_and_credentials_checked(&db, &updates)?;
    let updated = updates.len();
    app.emit("settings_update", serde_json::json!({ "updated": updated }))
        .map_err(|error| error.to_string())?;
    if updates.iter().any(|(_, key, _)| key.contains("permission")) {
        app.emit(
            "staff_permission_update",
            serde_json::json!({ "updated": true }),
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(serde_json::json!({ "success": true, "updated": updated }))
}

#[tauri::command]
pub async fn terminal_config_get_settings(
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    // Keep this endpoint aligned with renderer expectations by returning the
    // merged local settings map (nested + flat terminal keys).
    get_settings(db).await
}

#[tauri::command]
pub async fn terminal_config_get_setting(
    arg0: Option<Value>,
    arg1: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let (category, key) = parse_terminal_config_get_setting_payload(arg0, arg1);
    if let Some(ref terminal_key) = key {
        let cat = category.as_deref().unwrap_or("terminal");
        if crate::is_sensitive_setting_path(cat, terminal_key) {
            return Ok(serde_json::Value::Null);
        }
        if let Some(local) = read_runtime_setting(&db, cat, terminal_key) {
            return Ok(parse_json_string(&local));
        }
    }
    Ok(storage::get_setting(category.as_deref(), key.as_deref()))
}

#[tauri::command]
pub async fn terminal_config_get_branch_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("branch_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "branch_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
pub async fn terminal_config_get_terminal_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("terminal_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "terminal_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
pub async fn terminal_config_get_organization_id(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    storage::get_credential("organization_id")
        .or_else(|| crate::read_local_setting(&db, "terminal", "organization_id"))
        .ok_or_else(|| "Terminal not configured".into())
}

#[tauri::command]
pub async fn terminal_config_get_business_type(
    db: tauri::State<'_, db::DbState>,
) -> Result<String, String> {
    Ok(storage::get_credential("business_type")
        .or_else(|| crate::read_local_setting(&db, "terminal", "business_type"))
        .or_else(|| crate::read_local_setting(&db, "general", "business_type"))
        .unwrap_or_else(|| "food".into()))
}

#[tauri::command]
pub async fn terminal_config_get_full_config(
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    Ok(build_terminal_runtime_config(&db))
}

#[tauri::command]
pub async fn terminal_config_sync_from_admin(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    sync_state: tauri::State<'_, std::sync::Arc<crate::sync::SyncState>>,
) -> Result<Value, String> {
    if let Err(error) = refresh_terminal_context_from_admin(&db).await {
        if crate::is_terminal_auth_failure(&error) {
            return build_terminal_auth_failure_response(
                &db,
                sync_state.inner().as_ref(),
                &app,
                "terminal_config_sync_from_admin",
                &error,
            );
        }
        return Err(error);
    }
    sync_state.clear_remote_auth_pause();
    let config = build_terminal_runtime_config(&db);
    emit_terminal_runtime_update(&app, &db, "terminal_config_sync_from_admin", None);
    Ok(serde_json::json!({
        "success": true,
        "config": config
    }))
}

#[tauri::command]
pub async fn terminal_config_refresh(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
    sync_state: tauri::State<'_, std::sync::Arc<crate::sync::SyncState>>,
) -> Result<Value, String> {
    match refresh_terminal_context_from_admin(&db).await {
        Ok(()) => {
            sync_state.clear_remote_auth_pause();
        }
        Err(error) => {
            if crate::is_terminal_auth_failure(&error) {
                return build_terminal_auth_failure_response(
                    &db,
                    sync_state.inner().as_ref(),
                    &app,
                    "terminal_config_refresh",
                    &error,
                );
            }
            return Err(error);
        }
    }
    let result = match menu::sync_menu(&db).await {
        Ok(value) => value,
        Err(error) => {
            if crate::is_terminal_auth_failure(&error) {
                return build_terminal_auth_failure_response(
                    &db,
                    sync_state.inner().as_ref(),
                    &app,
                    "terminal_config_refresh",
                    &error,
                );
            }
            return Err(error);
        }
    };

    emit_terminal_runtime_update(&app, &db, "terminal_config_refresh", None);
    let _ = app.emit(
        "hardware_config_update",
        serde_json::json!({ "source": "terminal_config_refresh" }),
    );
    Ok(result)
}

#[cfg(test)]
mod dto_tests {
    use super::{
        api_key_digest, choose_rebind_recovery_generation, clear_terminal_connection_lifecycle,
        credential_status_projection, finish_terminal_connection_rebind,
        missing_identity_binding_with_existing_state, normalized_admin_url_for_switch,
        parse_settings_set_payload, parse_settings_update_local_payload,
        parse_terminal_config_get_setting_payload, payload_admin_url_for_switch,
        payload_terminal_id_for_switch, persist_terminal_rebind_candidate,
        prepare_terminal_connection_rebind, prepare_terminal_connection_rebind_with_recovery,
        publish_terminal_binding_checked, read_terminal_transition_journal,
        reconcile_startup_terminal_binding, resolve_strict_terminal_authority,
        run_process_reset_with_recovery, scoped_identity_changed, terminal_connection_changed,
        terminal_connection_rebind_pending, terminal_runtime_emit_signature,
        update_terminal_transition_phase, validate_terminal_binding_candidate, RecoveryGeneration,
        SettingsSetPayload, TerminalRebindCandidateJournal, TerminalTransitionOperation,
        TerminalTransitionPhase, TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
        TERMINAL_CONNECTION_REBIND_PENDING_KEY,
    };

    const REPAIR_ORG: &str = "11111111-1111-4111-8111-111111111111";
    const REPAIR_BRANCH: &str = "22222222-2222-4222-8222-222222222222";
    const REPAIR_TERMINAL: &str = "terminal-recovery-ordering";
    const REPAIR_SCOPE_TOKEN: &str = "33333333-3333-4333-8333-333333333333";
    const REPAIR_ID: &str = "44444444-4444-4444-8444-444444444444";
    const REPAIR_OPERATION_ID: &str = "55555555-5555-4555-8555-555555555555";
    const REPAIR_ATTACHMENT_ID: &str = "66666666-6666-4666-8666-666666666666";
    const REPAIR_FILE_KEY: &str = "77777777-7777-4777-8777-777777777777";
    const REPAIR_AES_KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const REPAIR_ENTITLEMENT: &str = "preserved-managed-entitlement";
    const REBIND_NEW_ORG: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const REBIND_NEW_BRANCH: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const REBIND_NEW_TERMINAL: &str = "replacement-terminal";
    const RESET_TEST_OPERATION_ID: &str = "99999999-9999-4999-8999-999999999999";
    const PRIVATE_SENTINEL: &str = "round3-private-shadow-sentinel";

    struct ResetTrackingGuard;

    impl Drop for ResetTrackingGuard {
        fn drop(&mut self) {
            let _ = crate::reset::clear_reset_status();
        }
    }

    fn reset_tracking_guard() -> ResetTrackingGuard {
        crate::reset::clear_reset_status().expect("clear prior reset tracking");
        ResetTrackingGuard
    }

    struct NativeRepairFixtureGuard {
        _keyring: crate::tests::fake_keyring::Guard,
        _lifecycle: crate::repairs::RepairLifecycleTestIsolation,
    }

    fn install_native_repair_fixture() -> (
        NativeRepairFixtureGuard,
        crate::tests::harness::TestDb,
        std::path::PathBuf,
    ) {
        let lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let scope = serde_json::json!({
            "version": 1,
            "organization_id": REPAIR_ORG,
            "branch_id": REPAIR_BRANCH,
            "terminal_id": REPAIR_TERMINAL,
            "scope_token": REPAIR_SCOPE_TOKEN,
            "scope_epoch": 7,
            "transition_pending": false,
            "reset_pending": false,
            "offline_terminal_token": null,
            "offline_sequence_lease_start": null,
            "offline_sequence_lease_end": null
        });
        let keyring = crate::tests::fake_keyring::install_seeded([
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("terminal_id", REPAIR_TERMINAL),
            (
                crate::storage::KEY_REPAIR_SCOPE_V1,
                scope.to_string().as_str(),
            ),
            (crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1, REPAIR_AES_KEY),
            (
                crate::storage::KEY_REPAIR_ENTITLEMENT_V1,
                REPAIR_ENTITLEMENT,
            ),
            (crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1, "actor-v1"),
            ("pos_session", "staff-session-v1"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("lock repair fixture db");
            connection
                .execute(
                    "INSERT INTO repair_cache (
                         organization_id, branch_id, terminal_id, repair_id, display_number,
                         status, authoritative_status, priority, intake_mode,
                         authoritative_version, optimistic_version, scope_generation,
                         workspace_nonce, workspace_ciphertext, dirty, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, 'R-RECOVERY', 'received', 'received',
                               'normal', 'standard', 0, 1, 7, zeroblob(12), zeroblob(24),
                               1, datetime('now'), datetime('now'))",
                    rusqlite::params![REPAIR_ORG, REPAIR_BRANCH, REPAIR_TERMINAL, REPAIR_ID],
                )
                .expect("seed repair cache row");
            connection
                .execute(
                    "INSERT INTO parity_sync_queue (
                         id, table_name, record_id, operation, data, organization_id,
                         created_at, retry_delay_ms, module_type, conflict_strategy,
                         version, repair_aggregate_id, status
                     ) VALUES (?1, 'repairs', ?2, 'INSERT', 'opaque', ?3,
                               datetime('now'), 1000, 'repairs', 'manual', 0, ?2, 'pending')",
                    rusqlite::params![REPAIR_OPERATION_ID, REPAIR_ID, REPAIR_ORG],
                )
                .expect("seed repair queue row");
            connection
                .execute(
                    "INSERT INTO repair_attachment_staging (
                         organization_id, branch_id, terminal_id, attachment_id, repair_id,
                         operation_id, queue_id, expected_version, scope_generation, file_key,
                         metadata_nonce, metadata_ciphertext, sha256_hex, mime_type, size_bytes,
                         state, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, 7, ?7, zeroblob(12),
                               zeroblob(24), ?8, 'image/jpeg', 23, 'queued',
                               datetime('now'), datetime('now'))",
                    rusqlite::params![
                        REPAIR_ORG,
                        REPAIR_BRANCH,
                        REPAIR_TERMINAL,
                        REPAIR_ATTACHMENT_ID,
                        REPAIR_ID,
                        REPAIR_OPERATION_ID,
                        REPAIR_FILE_KEY,
                        "0".repeat(64),
                    ],
                )
                .expect("seed repair attachment metadata");
        }
        let staged_path = database
            .dir()
            .join("repair-staging-v1")
            .join(REPAIR_SCOPE_TOKEN)
            .join(format!("{REPAIR_FILE_KEY}.bin"));
        std::fs::create_dir_all(staged_path.parent().expect("staging parent"))
            .expect("create staging directory");
        std::fs::write(&staged_path, b"staged encrypted bytes").expect("seed staged ciphertext");
        (
            NativeRepairFixtureGuard {
                _keyring: keyring,
                _lifecycle: lifecycle,
            },
            database,
            staged_path,
        )
    }

    #[test]
    fn generic_settings_reject_binding_and_sensitive_keys_in_every_category() {
        for (category, key) in [
            ("terminal", "terminal_id"),
            ("terminal", "organization_id"),
            ("terminal", "branch_id"),
            ("terminal", "admin_dashboard_url"),
            ("terminal", "admin_url"),
            ("terminal", "pos_api_key"),
            ("terminal", "api_key"),
            ("terminal", crate::storage::KEY_REPAIR_SCOPE_V1),
            ("terminal", crate::storage::KEY_REPAIR_ENTITLEMENT_V1),
            ("terminal", crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1),
            ("terminal", crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1),
            ("legacy", crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1),
            ("diagnostics", crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1),
        ] {
            assert_eq!(
                super::validate_generic_setting_update(category, key),
                Err("PROTECTED_TERMINAL_SETTING".to_string()),
                "generic writer accepted {category}.{key}"
            );
        }
        assert_eq!(
            super::validate_generic_setting_update("printer", "paper_width"),
            Ok(())
        );
    }

    #[test]
    fn path_classifier_rejects_qualified_nested_case_and_whitespace_aliases() {
        for (category, key) in [
            ("legacy", "terminal.pos_api_key"),
            ("terminal", "shadow.repair_actor_attestation_v1"),
            ("legacy", "terminal.pos_session"),
            ("  LeGaCy  ", " TERMINAL.POS_API_KEY "),
            ("diagnostics", "cache.supabase_anon_key"),
            ("general", "nested.connection_string"),
        ] {
            assert!(
                crate::is_sensitive_setting_path(category, key),
                "qualified private alias escaped: {category}.{key}"
            );
            assert_eq!(
                super::validate_generic_setting_update(category, key),
                Err("PROTECTED_TERMINAL_SETTING".to_string())
            );
        }
        for (category, key) in [
            ("printer", "profile.paper_width"),
            ("device", "scanner.enabled"),
            ("general", "locale"),
        ] {
            assert!(!crate::is_sensitive_setting_path(category, key));
            assert!(super::validate_generic_setting_update(category, key).is_ok());
        }
    }

    #[test]
    fn dotted_sensitive_aliases_are_redacted_and_physically_scrubbed() {
        let database = crate::tests::harness::TestDb::open();
        let aliases = [
            ("legacy", "terminal.pos_api_key"),
            ("terminal", "shadow.repair_actor_attestation_v1"),
            (" diagnostics ", " Cache.SUPABASE_ANON_KEY "),
        ];
        {
            let connection = database.state.conn.lock().expect("seed dotted shadows");
            for (category, key) in aliases {
                crate::db::set_setting(&connection, category, key, PRIVATE_SENTINEL)
                    .expect("seed dotted private shadow");
            }
            crate::db::set_setting(&connection, "printer", "profile.paper_width", "80")
                .expect("seed printer preference");
        }

        let projected = super::renderer_settings_snapshot(&database.state)
            .expect("render category/path-safe projection");
        assert!(!serde_json::to_string(&projected)
            .expect("encode projection")
            .contains(PRIVATE_SENTINEL));
        crate::scrub_sensitive_local_settings_checked(&database.state)
            .expect("physically scrub dotted shadows");
        let remaining = {
            let connection = database.state.conn.lock().expect("read scrubbed rows");
            crate::db::get_all_settings(&connection)
        };
        let encoded = serde_json::to_string(&remaining).expect("encode remaining settings");
        assert!(!encoded.contains(PRIVATE_SENTINEL));
        assert_eq!(
            remaining["printer"]["profile.paper_width"],
            serde_json::json!("80")
        );
    }

    #[test]
    #[serial_test::serial]
    fn allowed_mixed_batch_keyring_failure_rolls_back_both_stores() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("business_type", "food"),
            ("ghost_mode_feature_enabled", "false"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed allowed mirrors");
            crate::db::set_setting(&connection, "terminal", "business_type", "food")
                .expect("seed business type");
            crate::db::set_setting(
                &connection,
                "terminal",
                "ghost_mode_feature_enabled",
                "false",
            )
            .expect("seed ghost flag");
            crate::db::set_setting(&connection, "printer", "paper_width", "80")
                .expect("seed printer");
        }
        let before = {
            let connection = database
                .state
                .conn
                .lock()
                .expect("snapshot allowed mirrors");
            crate::db::get_all_settings(&connection)
        };
        crate::tests::fake_keyring::fail_writes_for(
            "ghost_mode_feature_enabled",
            "injected allowed credential failure",
        );

        let error = super::apply_generic_settings_and_credentials_checked(
            &database.state,
            &[
                (
                    "terminal".to_string(),
                    "business_type".to_string(),
                    "retail".to_string(),
                ),
                (
                    "printer".to_string(),
                    "paper_width".to_string(),
                    "58".to_string(),
                ),
                (
                    "terminal".to_string(),
                    "ghost_mode_feature_enabled".to_string(),
                    "true".to_string(),
                ),
            ],
        )
        .expect_err("allowed keyring failure must compensate all durable work");
        assert_eq!(error, "SETTINGS_DURABLE_WRITE_FAILED");
        let after = {
            let connection = database.state.conn.lock().expect("verify SQLite rollback");
            crate::db::get_all_settings(&connection)
        };
        assert_eq!(after, before);
        assert_eq!(
            crate::storage::get_credential("business_type").as_deref(),
            Some("food")
        );
        assert_eq!(
            crate::storage::get_credential("ghost_mode_feature_enabled").as_deref(),
            Some("false")
        );
    }

    #[test]
    fn multi_store_writer_serializes_snapshot_through_compensation() {
        let source = include_str!("settings.rs");
        let mutex = source
            .find("SETTINGS_DURABILITY_MUTEX")
            .expect("multi-store settings boundary needs a process-wide mutex");
        let function = source
            .find("fn apply_generic_settings_and_credentials_checked")
            .expect("checked multi-store writer exists");
        let body = &source[function..];
        let lock = body
            .find("SETTINGS_DURABILITY_MUTEX")
            .expect("checked writer acquires durability ownership");
        let sqlite_snapshot = body
            .find("sqlite_snapshot")
            .expect("checked writer snapshots SQLite");
        let compensation = body
            .find("restore_generic_credential_snapshot")
            .expect("checked writer compensates while ownership is held");
        assert!(mutex < function);
        assert!(lock < sqlite_snapshot);
        assert!(lock < compensation);
    }

    #[test]
    #[serial_test::serial]
    fn explicit_clear_blocks_while_checked_publisher_owns_durability() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let temp = crate::tests::harness::TempDir::new();
        let database = std::sync::Arc::new(crate::db::init(temp.path()).expect("open shared db"));
        let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
        let release = std::sync::Arc::new(std::sync::Barrier::new(2));
        super::install_settings_durability_pause(
            std::sync::Arc::clone(&entered),
            std::sync::Arc::clone(&release),
        );
        let publisher_db = std::sync::Arc::clone(&database);
        let publisher = std::thread::spawn(move || {
            let _keyring = crate::tests::fake_keyring::install_seeded([
                ("terminal_id", REPAIR_TERMINAL),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
                ("admin_dashboard_url", "https://old.example.com"),
                ("pos_api_key", "old-key"),
            ]);
            let candidate = serde_json::json!({
                "terminalId": REBIND_NEW_TERMINAL,
                "organizationId": REBIND_NEW_ORG,
                "branchId": REBIND_NEW_BRANCH,
                "adminDashboardUrl": "https://replacement.example.com",
                "apiKey": "replacement-key",
            });
            let _ = super::publish_terminal_binding_checked(&publisher_db, &candidate);
        });
        entered.wait();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let clear_db = std::sync::Arc::clone(&database);
        let clearer = std::thread::spawn(move || {
            let _keyring = crate::tests::fake_keyring::install_seeded([
                ("terminal_id", REPAIR_TERMINAL),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
                ("admin_dashboard_url", "https://old.example.com"),
                ("pos_api_key", "old-key"),
            ]);
            let result = super::clear_terminal_connection_lifecycle(&clear_db);
            let _ = done_tx.send(result);
        });
        let completed_while_owned = done_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_ok();
        release.wait();
        publisher.join().expect("publisher worker");
        clearer.join().expect("clear worker");
        assert!(
            !completed_while_owned,
            "explicit clear bypassed the process-wide durability owner"
        );
    }

    #[test]
    #[serial_test::serial]
    fn hard_auth_reset_blocks_and_emits_nothing_while_publisher_owns_durability() {
        struct Sink(std::sync::Arc<std::sync::atomic::AtomicUsize>);
        impl crate::terminal_helpers::TerminalEventSink for Sink {
            fn emit_json(&self, _event: &str, _payload: serde_json::Value) {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let temp = crate::tests::harness::TempDir::new();
        let database = std::sync::Arc::new(crate::db::init(temp.path()).expect("open shared db"));
        let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
        let release = std::sync::Arc::new(std::sync::Barrier::new(2));
        super::install_settings_durability_pause(
            std::sync::Arc::clone(&entered),
            std::sync::Arc::clone(&release),
        );
        let publisher_db = std::sync::Arc::clone(&database);
        let publisher = std::thread::spawn(move || {
            let _keyring = crate::tests::fake_keyring::install_seeded([
                ("terminal_id", REPAIR_TERMINAL),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
                ("admin_dashboard_url", "https://old.example.com"),
                ("pos_api_key", "old-key"),
            ]);
            let candidate = serde_json::json!({
                "terminalId": REBIND_NEW_TERMINAL,
                "organizationId": REBIND_NEW_ORG,
                "branchId": REBIND_NEW_BRANCH,
                "adminDashboardUrl": "https://replacement.example.com",
                "apiKey": "replacement-key",
            });
            let _ = super::publish_terminal_binding_checked(&publisher_db, &candidate);
        });
        entered.wait();
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reset_db = std::sync::Arc::clone(&database);
        let reset_emitted = std::sync::Arc::clone(&emitted);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let resetter = std::thread::spawn(move || {
            let _keyring = crate::tests::fake_keyring::install_seeded([("pos_api_key", "old-key")]);
            let sink = Sink(reset_emitted);
            crate::handle_invalid_terminal_credentials(
                Some(&reset_db),
                &sink,
                "round7",
                "API key is invalid or expired",
            );
            let _ = done_tx.send(());
        });
        let completed_while_owned = done_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_ok();
        let premature_events = emitted.load(std::sync::atomic::Ordering::SeqCst);
        release.wait();
        publisher.join().expect("publisher worker");
        resetter.join().expect("reset worker");
        assert!(
            !completed_while_owned,
            "hard auth reset bypassed durability owner"
        );
        assert_eq!(
            premature_events, 0,
            "hard auth reset emitted before ownership"
        );
    }

    #[test]
    #[serial_test::serial]
    fn checked_writer_cannot_be_clobbered_by_runtime_legacy_hydration() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("business_type", "food"),
            ("ghost_mode_feature_enabled", "false"),
        ]);
        let database = std::sync::Arc::new(crate::tests::harness::TestDb::open().state);
        {
            let connection = database.conn.lock().expect("seed legacy mirrors");
            crate::db::set_setting(&connection, "terminal", "business_type", "legacy")
                .expect("seed legacy business type");
            crate::db::set_setting(
                &connection,
                "terminal",
                "ghost_mode_feature_enabled",
                "false",
            )
            .expect("seed legacy ghost flag");
        }
        let hydration_db = std::sync::Arc::clone(&database);
        crate::tests::fake_keyring::after_next_write("business_type", move || {
            crate::hydrate_terminal_credentials_from_local_settings(&hydration_db);
        });

        super::apply_generic_settings_and_credentials_checked(
            &database,
            &[
                (
                    "terminal".to_string(),
                    "business_type".to_string(),
                    "retail".to_string(),
                ),
                (
                    "terminal".to_string(),
                    "ghost_mode_feature_enabled".to_string(),
                    "true".to_string(),
                ),
            ],
        )
        .expect("ordinary hydration must not mutate during a checked writer");
        assert_eq!(
            crate::storage::get_credential("business_type").as_deref(),
            Some("retail")
        );
        assert_eq!(
            crate::read_local_setting(&database, "terminal", "business_type").as_deref(),
            Some("retail")
        );
    }

    #[test]
    fn checked_refresh_has_no_ignored_secondary_durability_failure() {
        let source = include_str!("settings.rs");
        let start = source
            .find("pub(crate) async fn refresh_terminal_context_from_admin_with_completion")
            .expect("checked refresh exists");
        let end = source[start..]
            .find("\n#[tauri::command]")
            .map(|offset| start + offset)
            .expect("checked refresh boundary");
        let refresh = &source[start..end];
        assert!(
            refresh.contains("apply_refresh_secondary_settings_under_lock"),
            "secondary mirrored settings must use the checked durability boundary"
        );
        assert!(!refresh.contains("let _ = storage::"));
        assert!(!refresh.contains("let _ = db::"));
        assert!(!refresh.contains("if let Ok(conn) = db.conn.lock()"));

        let public_start = source
            .find("pub async fn terminal_config_refresh")
            .expect("public refresh exists");
        let public_refresh = &source[public_start..];
        let checked = public_refresh
            .find("refresh_terminal_context_from_admin(&db).await")
            .expect("public refresh invokes checked refresh");
        let menu = public_refresh
            .find("menu::sync_menu(&db).await")
            .expect("public refresh invokes menu after checked durability");
        let success_event = public_refresh
            .find("emit_terminal_runtime_update")
            .expect("public refresh success event");
        assert!(checked < menu && menu < success_event);
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn checked_refresh_secondary_keyring_failure_stops_before_menu_and_is_recoverable() {
        let response = serde_json::json!({
            "terminal_id": REPAIR_TERMINAL,
            "organization_id": REPAIR_ORG,
            "branch_id": REPAIR_BRANCH,
            "ghost_mode_feature_enabled": true,
            "settings": {
                "general": { "locale": "el" }
            }
        });
        let server = crate::tests::fake_http::MockServer::new(response.to_string());
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", REPAIR_TERMINAL),
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("admin_dashboard_url", server.url.as_str()),
            ("pos_api_key", "refresh-api-key"),
            ("ghost_mode_feature_enabled", "false"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("seed coherent refresh tuple");
            for (key, value) in [
                ("terminal_id", REPAIR_TERMINAL),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
                ("admin_dashboard_url", server.url.as_str()),
                ("ghost_mode_feature_enabled", "false"),
            ] {
                crate::db::set_setting(&connection, "terminal", key, value)
                    .expect("seed coherent refresh mirror");
            }
        }
        crate::tests::fake_keyring::fail_writes_for(
            "ghost_mode_feature_enabled",
            "private injected secondary failure",
        );

        let error = super::refresh_terminal_context_from_admin(&database.state)
            .await
            .expect_err("secondary durability failure must stop checked refresh");
        assert_eq!(error, "SETTINGS_DURABLE_WRITE_FAILED");
        assert_eq!(
            server.count(),
            1,
            "menu/config success request ran after failure"
        );
        assert_eq!(
            crate::storage::get_credential("ghost_mode_feature_enabled").as_deref(),
            Some("false")
        );
        assert_eq!(
            crate::read_local_setting(&database.state, "terminal", "ghost_mode_feature_enabled")
                .as_deref(),
            Some("false")
        );
        assert!(crate::read_local_setting(&database.state, "general", "locale").is_none());
        assert!(!error.contains("private injected secondary failure"));
    }

    fn refresh_secondary_updates() -> Vec<(String, String, String)> {
        vec![(
            "terminal".to_string(),
            "ghost_mode_feature_enabled".to_string(),
            "true".to_string(),
        )]
    }

    #[test]
    #[serial_test::serial]
    fn anon_post_write_read_error_compensates_before_secondary_mutation_and_retry_succeeds() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let database = crate::tests::harness::TestDb::open();
        crate::tests::fake_keyring::fail_read_after(
            "supabase_anon_key",
            1,
            "private post-write read failure",
        );

        let error = super::apply_refresh_secondary_settings_checked(
            &database.state,
            &refresh_secondary_updates(),
            Some("server-anon-key"),
        )
        .expect_err("post-write strict read failure must compensate");
        assert_eq!(error, "SETTINGS_DURABLE_WRITE_FAILED");
        assert!(crate::storage::get_credential("supabase_anon_key").is_none());
        assert!(crate::read_local_setting(
            &database.state,
            "terminal",
            "ghost_mode_feature_enabled"
        )
        .is_none());

        super::apply_refresh_secondary_settings_checked(
            &database.state,
            &refresh_secondary_updates(),
            Some("server-anon-key"),
        )
        .expect("retry from compensated state");
        assert_eq!(
            crate::storage::get_credential("supabase_anon_key").as_deref(),
            Some("server-anon-key")
        );
    }

    #[test]
    #[serial_test::serial]
    fn anon_post_write_mismatch_compensates_before_secondary_mutation() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let database = crate::tests::harness::TestDb::open();
        crate::tests::fake_keyring::replace_next_write_with(
            "supabase_anon_key",
            "backend-mismatch",
        );

        let error = super::apply_refresh_secondary_settings_checked(
            &database.state,
            &refresh_secondary_updates(),
            Some("server-anon-key"),
        )
        .expect_err("mismatched strict readback must compensate");
        assert_eq!(error, "SETTINGS_DURABLE_WRITE_FAILED");
        assert!(crate::storage::get_credential("supabase_anon_key").is_none());
        assert!(crate::read_local_setting(
            &database.state,
            "terminal",
            "ghost_mode_feature_enabled"
        )
        .is_none());
    }

    #[test]
    #[serial_test::serial]
    fn anon_mismatch_restore_delete_failure_is_distinct_and_retryable() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let database = crate::tests::harness::TestDb::open();
        crate::tests::fake_keyring::replace_next_write_with(
            "supabase_anon_key",
            "backend-mismatch",
        );
        crate::tests::fake_keyring::fail_deletes_for(
            "supabase_anon_key",
            "private restore delete failure",
        );

        let error = super::apply_refresh_secondary_settings_checked(
            &database.state,
            &refresh_secondary_updates(),
            Some("server-anon-key"),
        )
        .expect_err("failed compensation must be distinct");
        assert_eq!(error, "SETTINGS_DURABLE_COMPENSATION_FAILED");
        assert!(crate::read_local_setting(
            &database.state,
            "terminal",
            "ghost_mode_feature_enabled"
        )
        .is_none());
    }

    #[test]
    #[serial_test::serial]
    fn anon_mismatch_restore_read_failure_is_distinct_and_stops_secondary_writes() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let database = crate::tests::harness::TestDb::open();
        crate::tests::fake_keyring::replace_next_write_with(
            "supabase_anon_key",
            "backend-mismatch",
        );
        crate::tests::fake_keyring::fail_read_after(
            "supabase_anon_key",
            2,
            "private restore read failure",
        );

        let error = super::apply_refresh_secondary_settings_checked(
            &database.state,
            &refresh_secondary_updates(),
            Some("server-anon-key"),
        )
        .expect_err("restore read failure must be distinct");
        assert_eq!(error, "SETTINGS_DURABLE_COMPENSATION_FAILED");
        assert!(crate::read_local_setting(
            &database.state,
            "terminal",
            "ghost_mode_feature_enabled"
        )
        .is_none());
    }

    #[test]
    fn checked_generic_batch_rejection_has_byte_for_byte_zero_mutation() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("terminal_id", REPAIR_TERMINAL),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed settings");
            crate::db::set_setting(&connection, "printer", "paper_width", "80")
                .expect("seed printer control");
            crate::db::set_setting(&connection, "terminal", "organization_id", REPAIR_ORG)
                .expect("seed identity mirror");
        }
        let before = {
            let connection = database.state.conn.lock().expect("read before image");
            crate::db::get_all_settings(&connection)
        };

        let error = super::apply_generic_settings_updates_checked(
            &database.state,
            &[
                (
                    "printer".to_string(),
                    "paper_width".to_string(),
                    "58".to_string(),
                ),
                (
                    "legacy".to_string(),
                    crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1.to_string(),
                    PRIVATE_SENTINEL.to_string(),
                ),
            ],
        )
        .expect_err("mixed generic batch must reject before its first mutation");
        assert_eq!(error, "PROTECTED_TERMINAL_SETTING");

        let after = {
            let connection = database.state.conn.lock().expect("read after image");
            crate::db::get_all_settings(&connection)
        };
        assert_eq!(after, before);
        assert_eq!(
            crate::storage::get_credential("organization_id").as_deref(),
            Some(REPAIR_ORG)
        );
    }

    #[test]
    #[serial_test::serial]
    fn generic_writer_has_no_db_to_transition_lock_order_edge() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let database = crate::tests::harness::TestDb::open();
        let db_lock = database
            .state
            .conn
            .lock()
            .expect("hold SQLite writer mutex");
        let (transition_ready_tx, transition_ready_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();

        std::thread::scope(|scope| {
            let state = &database.state;
            let worker = scope.spawn(move || {
                let transition = crate::repairs::arm_process_reset()
                    .expect("worker owns canonical transition mutex");
                transition_ready_tx
                    .send(())
                    .expect("signal transition lock");
                continue_rx.recv().expect("continue worker");
                drop(transition);
                super::apply_generic_settings_updates_checked(
                    state,
                    &[(
                        "printer".to_string(),
                        "paper_width".to_string(),
                        "80".to_string(),
                    )],
                )
                .expect("allowed writer completes after SQLite lock release");
            });

            transition_ready_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .expect("transition mutex acquired");
            assert_eq!(
                super::apply_generic_settings_updates_checked(
                    &database.state,
                    &[(
                        "terminal".to_string(),
                        "organization_id".to_string(),
                        REBIND_NEW_ORG.to_string(),
                    )],
                ),
                Err("PROTECTED_TERMINAL_SETTING".to_string()),
                "protected writer must reject before waiting on transition or SQLite"
            );
            drop(db_lock);
            continue_tx.send(()).expect("release worker");
            worker.join().expect("lock-order worker");
        });
    }

    #[test]
    #[serial_test::serial]
    fn every_binding_key_requires_post_write_strict_readback_before_commit() {
        for key in [
            "pos_api_key",
            "admin_dashboard_url",
            "terminal_id",
            "organization_id",
            "branch_id",
        ] {
            let (_keyring, database, _staged_path) = install_native_repair_fixture();
            super::set_terminal_credential_under_owner(
                "admin_dashboard_url",
                "https://old.example.com",
            )
            .expect("seed old admin URL");
            super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
                .expect("seed old API key");
            crate::tests::fake_keyring::after_next_write(key, move || {
                crate::tests::fake_keyring::fail_read_after(
                    key,
                    0,
                    "private post-publication readback fault",
                );
            });
            let candidate = serde_json::json!({
                "terminalId": REBIND_NEW_TERMINAL,
                "organizationId": REBIND_NEW_ORG,
                "branchId": REBIND_NEW_BRANCH,
                "adminDashboardUrl": "https://replacement.example.com",
                "apiKey": "replacement-key",
            });

            let error = publish_terminal_binding_checked(&database.state, &candidate)
                .expect_err("every binding key needs strict post-write readback");
            assert!(!error.contains("private post-publication readback fault"));
            crate::tests::fake_keyring::clear_failures_for(key);
            assert!(!terminal_connection_rebind_pending(&database.state)
                .expect("compensated pre-destructive failure rolls back marker"));
            assert_eq!(
                crate::storage::get_credential("pos_api_key").as_deref(),
                Some("old-api-key")
            );
            assert_eq!(
                crate::storage::get_credential("organization_id").as_deref(),
                Some(REPAIR_ORG)
            );
            assert_eq!(
                crate::storage::get_credential("branch_id").as_deref(),
                Some(REPAIR_BRANCH)
            );
            assert_eq!(
                crate::storage::get_credential("terminal_id").as_deref(),
                Some(REPAIR_TERMINAL)
            );
            assert_eq!(
                crate::storage::get_credential("admin_dashboard_url").as_deref(),
                Some("https://old.example.com")
            );
            _keyring._lifecycle.reset();
        }
    }

    #[test]
    #[serial_test::serial]
    fn lossy_runtime_projection_never_marks_hostile_sqlite_fallback_healthy() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", REPAIR_TERMINAL),
            ("admin_dashboard_url", "https://managed.example.com"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed stale projection");
            crate::db::set_setting(&connection, "terminal", "terminal_id", "hostile-sqlite")
                .expect("seed hostile terminal");
            crate::db::set_setting(
                &connection,
                "terminal",
                "admin_dashboard_url",
                "https://hostile.invalid",
            )
            .expect("seed hostile URL");
            crate::db::set_setting(
                &connection,
                "terminal",
                "last_config_sync_at",
                &chrono::Utc::now().to_rfc3339(),
            )
            .expect("seed fresh timestamp");
        }
        crate::tests::fake_keyring::fail_reads_for(
            "terminal_id",
            "private projection backend fault",
        );

        let projected = super::build_terminal_runtime_config(&database.state);
        assert_ne!(projected["sync_health"], serde_json::json!("online"));
        assert_ne!(
            projected["terminal_id"],
            serde_json::json!("hostile-sqlite")
        );
        assert!(
            projected["credential_state"] == serde_json::json!("unavailable")
                || projected["sync_health"] == serde_json::json!("stale")
                || projected["sync_health"] == serde_json::json!("offline")
        );
    }

    #[test]
    #[serial_test::serial]
    fn startup_missing_managed_url_with_matching_sqlite_is_zero_mutation_failure() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", REPAIR_TERMINAL),
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("pos_api_key", "plain-api-key"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed matching mirrors");
            for (key, value) in [
                ("terminal_id", REPAIR_TERMINAL),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
                ("admin_dashboard_url", "https://hostile-sqlite.invalid"),
            ] {
                crate::db::set_setting(&connection, "terminal", key, value)
                    .expect("seed startup mirror");
            }
        }
        let before = {
            let connection = database.state.conn.lock().expect("snapshot startup state");
            crate::db::get_all_settings(&connection)
        };

        reconcile_startup_terminal_binding(&database.state)
            .expect_err("startup must not adopt a missing managed URL from SQLite");

        let after = {
            let connection = database.state.conn.lock().expect("verify startup state");
            crate::db::get_all_settings(&connection)
        };
        assert_eq!(after, before, "failed startup mutated durable state");
        assert!(crate::storage::get_credential("admin_dashboard_url").is_none());
    }

    #[test]
    fn every_public_generic_writer_routes_protected_inputs_to_the_same_rejection() {
        let set = super::parse_settings_set_payload(
            Some(serde_json::json!({
                "category": "terminal",
                "key": "organization_id",
                "value": REBIND_NEW_ORG,
            })),
            None,
        )
        .expect("parse settings_set payload");
        assert_eq!(
            super::validate_generic_setting_update(&set.category, &set.key),
            Err("PROTECTED_TERMINAL_SETTING".to_string())
        );

        let local = super::parse_settings_update_local_payload(
            Some(serde_json::json!({
                "settingType": "legacy",
                "settings": {
                    crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1: PRIVATE_SENTINEL,
                }
            })),
            None,
        )
        .expect("parse settings_update_local payload");
        assert_eq!(
            super::validate_generic_setting_update(&local[0].0, &local[0].1),
            Err("PROTECTED_TERMINAL_SETTING".to_string())
        );

        assert_eq!(
            super::normalize_dotted_settings_updates(&serde_json::json!({
                "terminal.branch_id": REBIND_NEW_BRANCH,
            })),
            Err("PROTECTED_TERMINAL_SETTING".to_string())
        );
    }

    #[test]
    fn renderer_settings_projection_redacts_sensitive_shadows_across_categories() {
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed shadows");
            for (category, key) in [
                ("terminal", crate::storage::KEY_REPAIR_SCOPE_V1),
                ("legacy", crate::storage::KEY_REPAIR_ENTITLEMENT_V1),
                ("diagnostics", crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1),
                (
                    "staff-cache",
                    crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
                ),
            ] {
                crate::db::set_setting(&connection, category, key, PRIVATE_SENTINEL)
                    .expect("seed private shadow");
            }
            crate::db::set_setting(&connection, "printer", "paper_width", "80")
                .expect("seed public control");
        }

        let projected = super::renderer_settings_snapshot(&database.state)
            .expect("build renderer-safe settings projection");
        let encoded = serde_json::to_string(&projected).expect("encode projection");
        assert!(!encoded.contains(PRIVATE_SENTINEL));
        assert_eq!(projected["printer"]["paper_width"], serde_json::json!("80"));
    }

    #[test]
    fn conflicting_identity_mirrors_are_explicit_and_never_precedence_collapsed() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("terminal_id", REPAIR_TERMINAL),
            ("admin_dashboard_url", "https://keyring.example.com"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed conflict");
            for (key, value) in [
                ("organization_id", REBIND_NEW_ORG),
                ("branch_id", REBIND_NEW_BRANCH),
                ("terminal_id", REBIND_NEW_TERMINAL),
                ("admin_dashboard_url", "https://sqlite.example.com"),
            ] {
                crate::db::set_setting(&connection, "terminal", key, value)
                    .expect("seed conflicting mirror");
            }
        }

        let state = super::read_terminal_binding_mirror_state(&database.state)
            .expect("read explicit mirror state");
        assert!(matches!(
            state,
            super::TerminalBindingMirrorState::Conflicting { .. }
        ));
        assert!(crate::storage::get_credential("organization_id").as_deref() == Some(REPAIR_ORG));
    }

    #[test]
    fn durable_candidate_journal_is_complete_versioned_and_secret_free() {
        let database = crate::tests::harness::TestDb::open();
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "fixture-a",
        });

        super::persist_terminal_rebind_candidate(&database.state, &candidate, None)
            .expect("persist candidate journal");
        let raw = {
            let connection = database.state.conn.lock().expect("read journal");
            crate::db::get_setting(
                &connection,
                "sync",
                super::TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
            )
            .expect("candidate journal row")
        };
        assert!(!raw.contains("fixture-a"));
        let journal: serde_json::Value = serde_json::from_str(&raw).expect("strict JSON journal");
        assert_eq!(journal["version"], serde_json::json!(3));
        assert!(journal["operation_id"]
            .as_str()
            .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok()));
        assert!(journal["repair_scope_rollback"].is_null());
        assert_eq!(
            journal["organization_id"],
            serde_json::json!(REBIND_NEW_ORG)
        );
        assert_eq!(journal["branch_id"], serde_json::json!(REBIND_NEW_BRANCH));
        assert_eq!(
            journal["terminal_id"],
            serde_json::json!(REBIND_NEW_TERMINAL)
        );
        assert_eq!(
            journal["admin_dashboard_url"],
            serde_json::json!("https://replacement.example.com")
        );
        assert!(journal["api_key_digest"]
            .as_str()
            .is_some_and(|digest| digest.len() == 64));
        super::read_terminal_rebind_candidate(&database.state, "fixture-a")
            .expect("matching secret validates journal");
        assert!(super::read_terminal_rebind_candidate(&database.state, "wrong-secret").is_err());
    }

    #[test]
    fn corrupt_or_incomplete_candidate_journal_is_never_used_for_restart_recovery() {
        let database = crate::tests::harness::TestDb::open();
        for corrupt in [
            "not-json",
            r#"{"version":1}"#,
            r#"{"version":99,"organization_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","branch_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","terminal_id":"replacement-terminal","admin_dashboard_url":"https://replacement.example.com","api_key_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        ] {
            {
                let connection = database.state.conn.lock().expect("seed corrupt journal");
                crate::db::set_setting(
                    &connection,
                    "sync",
                    super::TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
                    corrupt,
                )
                .expect("persist corrupt fixture");
            }
            assert!(super::read_terminal_rebind_candidate(&database.state, "api-key").is_err());
            assert!(super::terminal_connection_rebind_pending(&database.state)
                .expect("orphan candidate is a durable fail-closed transition"));
        }
    }

    #[test]
    fn legacy_hydration_never_mutates_protected_identity_before_canonical_decision() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("terminal_id", REPAIR_TERMINAL),
            ("admin_dashboard_url", "https://keyring.example.com"),
            ("pos_api_key", "keyring-api-key"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed legacy mirrors");
            for (key, value) in [
                ("organization_id", REBIND_NEW_ORG),
                ("branch_id", REBIND_NEW_BRANCH),
                ("terminal_id", REBIND_NEW_TERMINAL),
                ("admin_dashboard_url", "https://sqlite.example.com"),
                ("pos_api_key", "sqlite-api-key"),
            ] {
                crate::db::set_setting(&connection, "terminal", key, value)
                    .expect("seed legacy mirror");
            }
        }

        crate::hydrate_terminal_credentials_from_local_settings(&database.state);

        for (key, expected) in [
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("terminal_id", REPAIR_TERMINAL),
            ("admin_dashboard_url", "https://keyring.example.com"),
            ("pos_api_key", "keyring-api-key"),
        ] {
            assert_eq!(
                crate::storage::get_credential(key).as_deref(),
                Some(expected),
                "legacy hydration mutated protected {key}"
            );
        }
    }

    #[test]
    fn sensitive_shadow_scrub_is_category_independent_and_preserves_device_controls() {
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed shadows");
            for (category, key) in [
                ("terminal", crate::storage::KEY_REPAIR_SCOPE_V1),
                ("legacy", crate::storage::KEY_REPAIR_ENTITLEMENT_V1),
                ("diagnostics", crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1),
                (
                    "staff-cache",
                    crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
                ),
            ] {
                crate::db::set_setting(&connection, category, key, PRIVATE_SENTINEL)
                    .expect("seed private shadow");
            }
            crate::db::set_setting(&connection, "printer", "paper_width", "80")
                .expect("seed printer control");
            crate::db::set_setting(&connection, "device", "scanner_enabled", "true")
                .expect("seed device control");
        }

        crate::scrub_sensitive_local_settings(&database.state);

        let all = {
            let connection = database
                .state
                .conn
                .lock()
                .expect("inspect scrubbed settings");
            crate::db::get_all_settings(&connection)
        };
        let encoded = serde_json::to_string(&all).expect("encode scrubbed settings");
        assert!(!encoded.contains(PRIVATE_SENTINEL));
        assert_eq!(all["printer"]["paper_width"], serde_json::json!("80"));
        assert_eq!(all["device"]["scanner_enabled"], serde_json::json!("true"));
    }

    #[test]
    #[serial_test::serial]
    fn unauthenticated_public_connection_clear_has_zero_mutation() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        let auth = crate::auth::AuthState::new();
        let before = {
            let connection = database.state.conn.lock().expect("read pre-clear state");
            crate::db::get_all_settings(&connection)
        };

        super::settings_clear_connection_checked(&database.state, &auth)
            .expect_err("missing SystemControl authority must reject clear");

        let after = {
            let connection = database.state.conn.lock().expect("read post-denial state");
            crate::db::get_all_settings(&connection)
        };
        assert_eq!(after, before);
        assert_native_repair_fixture_intact(&database, &staged_path);
        _keyring._lifecycle.reset();
    }

    fn assert_native_repair_fixture_intact(
        database: &crate::tests::harness::TestDb,
        staged_path: &std::path::Path,
    ) {
        let connection = database
            .state
            .conn
            .lock()
            .expect("inspect repair fixture db");
        for (table, expected) in [
            ("repair_cache", 1_i64),
            ("repair_attachment_staging", 1_i64),
            ("parity_sync_queue", 1_i64),
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count preserved repair rows");
            assert_eq!(
                count, expected,
                "{table} was modified before reset ownership"
            );
        }
        drop(connection);
        assert_eq!(
            std::fs::read(staged_path).expect("read preserved staged ciphertext"),
            b"staged encrypted bytes"
        );
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1).as_deref(),
            Some(REPAIR_AES_KEY)
        );
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ENTITLEMENT_V1).as_deref(),
            Some(REPAIR_ENTITLEMENT)
        );
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .as_deref(),
            Some("actor-v1")
        );
        assert_eq!(
            crate::storage::session_get().as_deref(),
            Some("staff-session-v1")
        );
    }

    fn seed_interleaved_old_scope_generic_rows(database: &crate::tests::harness::TestDb) {
        let connection = database
            .state
            .conn
            .lock()
            .expect("seed interleaved old-scope rows");
        connection
            .execute_batch(&format!(
                "INSERT INTO orders (
                     id, items, total_amount, total_amount_cents, status,
                     sync_status, created_at, updated_at
                 ) VALUES (
                     'interleaved-old-order', '[]', 4.0, 400, 'pending', 'pending',
                     datetime('now'), datetime('now')
                 );
                 INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, retry_delay_ms, module_type, conflict_strategy,
                     version, status
                 ) VALUES (
                     'interleaved-old-parity', 'orders', 'interleaved-old-order',
                     'INSERT', '{{}}', '{REPAIR_ORG}', datetime('now'), 1000,
                     'orders', 'server-wins', 1, 'pending'
                 );"
            ))
            .expect("seed interleaved old-scope generic state");
    }

    fn publish_replacement_credentials() {
        for (key, value) in [
            ("terminal_id", REBIND_NEW_TERMINAL),
            ("admin_dashboard_url", "https://replacement.example.com"),
            ("organization_id", REBIND_NEW_ORG),
            ("branch_id", REBIND_NEW_BRANCH),
            ("pos_api_key", "replacement-key"),
        ] {
            super::set_terminal_credential_under_owner(key, value)
                .expect("publish replacement credential");
        }
    }

    fn seed_legacy_v2_rebind_intent(database: &crate::tests::harness::TestDb) {
        let journal = TerminalRebindCandidateJournal {
            version: 2,
            operation_id: None,
            repair_scope_rollback: None,
            operation: TerminalTransitionOperation::Rebind,
            phase: TerminalTransitionPhase::Intent,
            organization_id: REBIND_NEW_ORG.to_string(),
            branch_id: REBIND_NEW_BRANCH.to_string(),
            terminal_id: REBIND_NEW_TERMINAL.to_string(),
            admin_dashboard_url: "https://replacement.example.com".to_string(),
            api_key_digest: api_key_digest("replacement-key"),
            old_terminal_id: Some(REPAIR_TERMINAL.to_string()),
            old_admin_dashboard_url: Some("https://old.example.com".to_string()),
            old_organization_id: Some(REPAIR_ORG.to_string()),
            old_branch_id: Some(REPAIR_BRANCH.to_string()),
            old_api_key_digest: Some(api_key_digest("old-api-key")),
            old_api_key_present: true,
        };
        let encoded = serde_json::to_string(&journal).expect("encode legacy v2 journal");
        let connection = database.state.conn.lock().expect("seed legacy v2 intent");
        crate::db::set_setting(
            &connection,
            "sync",
            TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
            &encoded,
        )
        .expect("seed legacy journal");
        crate::db::set_setting(
            &connection,
            "sync",
            TERMINAL_CONNECTION_REBIND_PENDING_KEY,
            "1",
        )
        .expect("seed legacy pending marker");
    }

    fn assert_rebind_finished_without_interleaved_rows(database: &crate::tests::harness::TestDb) {
        let connection = database
            .state
            .conn
            .lock()
            .expect("inspect finished terminal rebind");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM orders WHERE id = 'interleaved-old-order'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count interleaved old order"),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                      WHERE id = 'interleaved-old-parity'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count interleaved old parity row"),
            0
        );
        drop(connection);
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        let scope: serde_json::Value = serde_json::from_str(
            &crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .expect("replacement repair scope"),
        )
        .expect("parse replacement repair scope");
        assert_eq!(
            scope
                .get("organization_id")
                .and_then(serde_json::Value::as_str),
            Some(REBIND_NEW_ORG)
        );
        assert_eq!(
            scope.get("branch_id").and_then(serde_json::Value::as_str),
            Some(REBIND_NEW_BRANCH)
        );
        assert_eq!(
            scope.get("terminal_id").and_then(serde_json::Value::as_str),
            Some(REBIND_NEW_TERMINAL)
        );
        assert_eq!(
            scope
                .get("transition_pending")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
    }

    #[test]
    #[serial_test::serial]
    fn durable_terminal_rebind_marker_is_read_only_and_fail_closed() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let database = crate::tests::harness::TestDb::open();

        assert!(!terminal_connection_rebind_pending(&database.state).expect("read absent marker"));
        super::set_terminal_connection_rebind_pending(&database.state, true).expect("set marker");
        assert!(terminal_connection_rebind_pending(&database.state).expect("read present marker"));

        {
            let connection = database.state.conn.lock().expect("lock marker db");
            connection
                .execute("DROP TABLE local_settings", [])
                .expect("inject marker read failure");
        }
        assert!(terminal_connection_rebind_pending(&database.state).is_err());
        assert!(super::terminal_connection_rebind_pending_fail_closed(
            &database.state
        ));
    }

    #[test]
    fn terminal_connection_changed_ignores_same_terminal_key_rotation() {
        assert!(!terminal_connection_changed(
            Some("terminal-1"),
            Some("terminal-1"),
            Some("https://admin.example.com"),
            Some("https://admin.example.com"),
        ));
    }

    #[test]
    fn terminal_connection_changed_detects_terminal_or_admin_switch() {
        assert!(terminal_connection_changed(
            Some("terminal-1"),
            Some("terminal-2"),
            Some("https://admin.example.com"),
            Some("https://admin.example.com"),
        ));
        assert!(terminal_connection_changed(
            Some("terminal-1"),
            Some("terminal-1"),
            Some("https://preview.example.com"),
            Some("https://admin.example.com"),
        ));
    }

    #[test]
    fn terminal_connection_changed_does_not_wipe_first_install() {
        assert!(!terminal_connection_changed(
            None,
            Some("terminal-1"),
            None,
            Some("https://admin.example.com"),
        ));
    }

    #[test]
    fn branch_or_organization_only_change_requires_scoped_rebind() {
        assert!(scoped_identity_changed(Some("org-a"), Some("org-b")));
        assert!(scoped_identity_changed(Some("branch-a"), Some("branch-b")));
        assert!(!scoped_identity_changed(Some("org-a"), None));
        assert!(!scoped_identity_changed(None, Some("org-a")));
    }

    #[test]
    fn introducing_missing_identity_fails_closed_only_when_operational_state_exists() {
        let previous = [None, Some("branch-a"), Some("terminal-a")];
        let next = [Some("org-a"), Some("branch-a"), Some("terminal-a")];
        assert!(missing_identity_binding_with_existing_state(
            true, &previous, &next
        ));
        assert!(!missing_identity_binding_with_existing_state(
            false, &previous, &next
        ));
    }

    #[test]
    fn terminal_connection_changed_does_not_wipe_same_terminal_when_repairing_invalid_url() {
        let poisoned_url = normalized_admin_url_for_switch(Some("https://https:".to_string()));
        assert!(poisoned_url.is_none());
        assert!(!terminal_connection_changed(
            Some("terminal-1"),
            Some("terminal-1"),
            poisoned_url.as_deref(),
            Some("https://admin.example.com"),
        ));
    }

    #[test]
    fn switch_identity_helpers_decode_connection_code_payload() {
        let payload = serde_json::json!({
            "terminalId": "stale-terminal",
            "adminUrl": "https://stale.example.com",
            "apiKey": "{\"key\":\"decoded-key\",\"tid\":\"terminal-new\",\"url\":\"admin.example.com/api\"}"
        });

        assert_eq!(
            payload_terminal_id_for_switch(&payload).as_deref(),
            Some("terminal-new")
        );
        assert_eq!(
            payload_admin_url_for_switch(&payload).as_deref(),
            Some("https://admin.example.com")
        );
    }

    #[test]
    #[serial_test::serial]
    fn terminal_rebind_removes_old_operational_state_before_identity_changes() {
        const OLD_ORG: &str = "11111111-1111-4111-8111-111111111111";
        const OLD_BRANCH: &str = "22222222-2222-4222-8222-222222222222";
        const OLD_TERMINAL: &str = "33333333-3333-4333-8333-333333333333";
        const NEW_ORG: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const NEW_BRANCH: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const NEW_TERMINAL: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("organization_id", OLD_ORG),
            ("branch_id", OLD_BRANCH),
            ("terminal_id", OLD_TERMINAL),
            ("admin_dashboard_url", "https://old.example.com"),
            ("pos_api_key", "old-key"),
        ]);
        let directory = crate::tests::harness::TempDir::new();
        let state = crate::db::init(directory.path()).expect("initialize terminal rebind db");
        {
            let conn = state.conn.lock().expect("lock terminal rebind db");
            conn.execute(
                "INSERT INTO orders (
                     id, items, total_amount, total_amount_cents, status,
                     sync_status, created_at, updated_at
                 ) VALUES (
                     'old-tenant-order', '[]', 5.0, 500, 'pending', 'pending',
                     datetime('now'), datetime('now')
                 )",
                [],
            )
            .expect("seed old generic order");
            conn.execute(
                "INSERT INTO parity_sync_queue (
                     id, table_name, record_id, operation, data, organization_id,
                     created_at, retry_delay_ms, module_type, conflict_strategy,
                     version, repair_aggregate_id, status
                 ) VALUES (
                     '44444444-4444-4444-8444-444444444444', 'repairs',
                     '55555555-5555-4555-8555-555555555555', 'INSERT', 'opaque',
                     ?1, datetime('now'), 1000, 'repairs', 'manual', 0,
                     '55555555-5555-4555-8555-555555555555', 'pending'
                 )",
                [OLD_ORG],
            )
            .expect("seed old native repair row");
        }

        prepare_terminal_connection_rebind(&state).expect("prepare privacy-safe rebind");
        assert!(terminal_connection_rebind_pending(&state).expect("read marker"));
        assert_eq!(
            crate::storage::get_credential("terminal_id").as_deref(),
            Some(OLD_TERMINAL),
            "the old identity must remain authoritative until its data is gone",
        );
        {
            let conn = state.conn.lock().expect("inspect cleared old tenant data");
            let orders: i64 = conn
                .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
                .expect("count old orders");
            let repairs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM parity_sync_queue
                     WHERE module_type = 'repairs'
                        OR table_name IN ('repairs', 'repair_attachments')",
                    [],
                    |row| row.get(0),
                )
                .expect("count old repair rows");
            assert_eq!((orders, repairs), (0, 0));
        }

        crate::clear_derived_terminal_context(&state);
        for (key, value) in [
            ("terminal_id", NEW_TERMINAL),
            ("admin_dashboard_url", "https://new.example.com"),
            ("organization_id", NEW_ORG),
            ("branch_id", NEW_BRANCH),
            ("pos_api_key", "new-key"),
        ] {
            super::set_terminal_credential_under_owner(key, value)
                .expect("write replacement credentials only after clear");
        }
        finish_terminal_connection_rebind(&state).expect("publish replacement repair scope");

        assert!(!terminal_connection_rebind_pending(&state).expect("read marker"));
        assert_eq!(
            crate::storage::get_credential("terminal_id").as_deref(),
            Some(NEW_TERMINAL)
        );
        assert_eq!(
            crate::storage::get_credential("organization_id").as_deref(),
            Some(NEW_ORG)
        );
        assert_eq!(
            crate::storage::get_credential("branch_id").as_deref(),
            Some(NEW_BRANCH)
        );
    }

    #[test]
    fn parse_settings_set_payload_supports_object_and_flat_key() {
        let object_payload = parse_settings_set_payload(
            Some(serde_json::json!({
                "category": "terminal",
                "key": "branch_id",
                "value": "branch-1"
            })),
            None,
        )
        .expect("object payload should parse");

        let flat_payload = parse_settings_set_payload(
            Some(serde_json::json!("terminal.admin_dashboard_url")),
            Some(serde_json::json!("https://admin.example.com")),
        )
        .expect("flat payload should parse");

        assert_eq!(
            object_payload,
            SettingsSetPayload {
                category: "terminal".to_string(),
                key: "branch_id".to_string(),
                value_node: serde_json::json!("branch-1"),
            }
        );
        assert_eq!(flat_payload.category, "terminal");
        assert_eq!(flat_payload.key, "admin_dashboard_url");
        assert_eq!(
            flat_payload.value_node,
            serde_json::json!("https://admin.example.com")
        );
    }

    #[test]
    fn parse_settings_set_payload_rejects_missing_key() {
        let err = parse_settings_set_payload(Some(serde_json::json!({ "value": "x" })), None)
            .expect_err("missing key should be rejected");
        assert!(err.contains("Missing setting key"), "unexpected err: {err}");
    }

    #[test]
    fn parse_settings_update_local_payload_supports_object_bridge_and_flat_forms() {
        let object_form = parse_settings_update_local_payload(
            Some(serde_json::json!({
                "settingType": "terminal",
                "settings": {
                    "branch_id": "branch-2",
                    "organization_id": "org-2"
                }
            })),
            None,
        )
        .expect("object form should parse");

        let bridge_form = parse_settings_update_local_payload(
            Some(serde_json::json!("terminal")),
            Some(serde_json::json!({ "terminal_id": "term-2" })),
        )
        .expect("bridge form should parse");

        let flat_form = parse_settings_update_local_payload(
            Some(serde_json::json!("general.language")),
            Some(serde_json::json!("el")),
        )
        .expect("flat form should parse");

        assert_eq!(
            object_form,
            vec![
                (
                    "terminal".to_string(),
                    "branch_id".to_string(),
                    "branch-2".to_string()
                ),
                (
                    "terminal".to_string(),
                    "organization_id".to_string(),
                    "org-2".to_string()
                )
            ]
        );
        assert_eq!(
            bridge_form,
            vec![(
                "terminal".to_string(),
                "terminal_id".to_string(),
                "term-2".to_string()
            )]
        );
        assert_eq!(
            flat_form,
            vec![(
                "general".to_string(),
                "language".to_string(),
                "el".to_string()
            )]
        );
    }

    #[test]
    fn parse_settings_update_local_payload_rejects_invalid_shape() {
        let err = parse_settings_update_local_payload(Some(serde_json::json!({})), None)
            .expect_err("invalid payload should be rejected");
        assert!(
            err.contains("settings:update-local expects"),
            "unexpected err: {err}"
        );
    }

    #[test]
    fn parse_terminal_config_get_setting_payload_supports_object_tuple_and_flat_key() {
        let object_form = parse_terminal_config_get_setting_payload(
            Some(serde_json::json!({
                "category": "terminal",
                "key": "branch_id"
            })),
            None,
        );
        let tuple_form = parse_terminal_config_get_setting_payload(
            Some(serde_json::json!("terminal")),
            Some(serde_json::json!("terminal_id")),
        );
        let flat_form = parse_terminal_config_get_setting_payload(
            Some(serde_json::json!("terminal.organization_id")),
            None,
        );

        assert_eq!(
            object_form,
            (Some("terminal".to_string()), Some("branch_id".to_string()))
        );
        assert_eq!(
            tuple_form,
            (
                Some("terminal".to_string()),
                Some("terminal_id".to_string())
            )
        );
        assert_eq!(
            flat_form,
            (
                Some("terminal".to_string()),
                Some("organization_id".to_string())
            )
        );
    }

    #[test]
    fn terminal_runtime_emit_signature_ignores_last_config_sync_at() {
        let config_a = serde_json::json!({
            "terminal_id": "terminal-1",
            "branch_id": "branch-1",
            "organization_id": "org-1",
            "admin_dashboard_url": "https://admin.example.com",
            "business_type": "food",
            "terminal_type": "main",
            "parent_terminal_id": null,
            "owner_terminal_id": "terminal-1",
            "owner_terminal_db_id": "db-terminal-1",
            "source_terminal_id": "terminal-1",
            "source_terminal_db_id": "db-terminal-1",
            "pos_operating_mode": "main_isolated",
            "enabled_features": { "delivery": true },
            "ghost_mode_feature_enabled": "false",
            "sync_health": "polling",
            "last_config_sync_at": "2026-04-18T08:00:00Z",
        });
        let mut config_b = config_a.clone();
        config_b["last_config_sync_at"] = serde_json::json!("2026-04-18T08:00:30Z");

        assert_eq!(
            terminal_runtime_emit_signature(&config_a),
            terminal_runtime_emit_signature(&config_b),
        );
    }

    #[test]
    #[serial_test::serial]
    fn unchanged_complete_binding_is_published_without_destructive_rebind() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://admin.example.com",
        )
        .expect("seed admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "same-api-key")
            .expect("seed API key");

        let (_, changed) = publish_terminal_binding_checked(
            &database.state,
            &serde_json::json!({
                "terminalId": REPAIR_TERMINAL,
                "organizationId": REPAIR_ORG,
                "branchId": REPAIR_BRANCH,
                "adminDashboardUrl": "https://admin.example.com",
                "apiKey": "same-api-key",
            }),
        )
        .expect("publish unchanged binding");

        assert!(!changed);
        assert_native_repair_fixture_intact(&database, &staged_path);
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn changed_complete_binding_purges_old_scope_and_invalidates_authority() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");

        let (_, changed) = publish_terminal_binding_checked(
            &database.state,
            &serde_json::json!({
                "terminalId": REBIND_NEW_TERMINAL,
                "organizationId": REBIND_NEW_ORG,
                "branchId": REBIND_NEW_BRANCH,
                "adminDashboardUrl": "https://replacement.example.com",
                "apiKey": "replacement-key",
            }),
        )
        .expect("publish replacement binding");

        assert!(changed);
        assert!(!staged_path.exists());
        assert!(crate::storage::session_get().is_none());
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_none()
        );
        assert_rebind_finished_without_interleaved_rows(&database);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn every_keyring_publication_position_stays_journaled_and_restart_converges() {
        for failed_key in [
            "terminal_id",
            "pos_api_key",
            "admin_dashboard_url",
            "branch_id",
            "organization_id",
        ] {
            let (_keyring, database, staged_path) = install_native_repair_fixture();
            super::set_terminal_credential_under_owner(
                "admin_dashboard_url",
                "https://old.example.com",
            )
            .expect("seed old admin URL");
            super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
                .expect("seed old API key");
            {
                let connection = database
                    .state
                    .conn
                    .lock()
                    .expect("seed old SQLite binding mirrors");
                for (key, value) in [
                    ("terminal_id", REPAIR_TERMINAL),
                    ("admin_dashboard_url", "https://old.example.com"),
                    ("organization_id", REPAIR_ORG),
                    ("branch_id", REPAIR_BRANCH),
                ] {
                    crate::db::set_setting(&connection, "terminal", key, value)
                        .expect("seed old SQLite binding mirror");
                }
            }
            let exact_old_repair_scope =
                crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)
                    .expect("read exact old repair scope")
                    .expect("configured repair scope")
                    .to_string();
            let old_scope_token =
                serde_json::from_str::<serde_json::Value>(&exact_old_repair_scope)
                    .expect("parse exact old repair scope")
                    .get("scope_token")
                    .and_then(serde_json::Value::as_str)
                    .expect("old scope token")
                    .to_string();
            crate::tests::fake_keyring::fail_writes_for(
                failed_key,
                "injected terminal identity write failure",
            );
            let candidate = serde_json::json!({
                "terminalId": REBIND_NEW_TERMINAL,
                "organizationId": REBIND_NEW_ORG,
                "branchId": REBIND_NEW_BRANCH,
                "adminDashboardUrl": "https://replacement.example.com",
                "apiKey": "replacement-key",
            });

            let publication_error = publish_terminal_binding_checked(&database.state, &candidate)
                .expect_err("keyring publication failure must fail closed");
            assert!(
                terminal_connection_rebind_pending(&database.state).expect("read marker"),
                "terminal transition was not retained after {failed_key}: {publication_error}"
            );
            let serialized_journal = {
                let connection = database.state.conn.lock().expect("read retry journal");
                crate::db::get_setting(
                    &connection,
                    "sync",
                    super::TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
                )
                .expect("candidate retained for restart")
            };
            let journal: TerminalRebindCandidateJournal =
                serde_json::from_str(&serialized_journal).expect("decode retained v3 journal");
            assert_eq!(journal.version, 3);
            assert!(journal.operation_id.is_some());
            assert!(journal.repair_scope_rollback.is_some());
            assert_eq!(journal.operation, TerminalTransitionOperation::Rebind);
            assert_eq!(journal.phase, TerminalTransitionPhase::Intent);
            assert_eq!(journal.old_terminal_id.as_deref(), Some(REPAIR_TERMINAL));
            assert_eq!(
                journal.old_admin_dashboard_url.as_deref(),
                Some("https://old.example.com")
            );
            assert_eq!(journal.old_organization_id.as_deref(), Some(REPAIR_ORG));
            assert_eq!(journal.old_branch_id.as_deref(), Some(REPAIR_BRANCH));
            assert_eq!(
                journal.old_api_key_digest,
                Some(api_key_digest("old-api-key"))
            );
            assert!(journal.old_api_key_present);
            assert_eq!(journal.terminal_id, REBIND_NEW_TERMINAL);
            assert_eq!(journal.organization_id, REBIND_NEW_ORG);
            assert_eq!(journal.branch_id, REBIND_NEW_BRANCH);
            assert_eq!(
                journal.admin_dashboard_url,
                "https://replacement.example.com"
            );
            assert_eq!(journal.api_key_digest, api_key_digest("replacement-key"));
            assert!(!serialized_journal.contains("old-api-key"));
            assert!(!serialized_journal.contains("replacement-key"));
            assert!(!serialized_journal.contains(&old_scope_token));
            for (key, expected) in [
                ("pos_api_key", "old-api-key"),
                ("terminal_id", REPAIR_TERMINAL),
                ("admin_dashboard_url", "https://old.example.com"),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
            ] {
                assert_eq!(
                    crate::storage::get_credential_strict(key)
                        .expect("strict-read compensated credential")
                        .as_ref()
                        .map(|value| value.as_str()),
                    Some(expected),
                    "failed publication did not compensate {key} to exact A"
                );
            }
            {
                let connection = database.state.conn.lock().expect("inspect barrier");
                for (key, expected) in [
                    ("terminal_id", REPAIR_TERMINAL),
                    ("admin_dashboard_url", "https://old.example.com"),
                    ("organization_id", REPAIR_ORG),
                    ("branch_id", REPAIR_BRANCH),
                ] {
                    assert_eq!(
                        crate::db::get_setting(&connection, "terminal", key).as_deref(),
                        Some(expected),
                        "failed publication changed SQLite mirror {key}"
                    );
                }
                let access_error = crate::repairs::acquire_renderer_access(&connection)
                    .err()
                    .expect("repair access must remain blocked");
                assert_eq!(access_error, "REPAIR_SCOPE_TRANSITION_PENDING");
            }
            assert_native_repair_fixture_intact(&database, &staged_path);

            crate::tests::fake_keyring::clear_failures_for(failed_key);
            reconcile_startup_terminal_binding(&database.state)
                .expect("Intent restart safely restores exact A");
            assert_eq!(
                crate::storage::get_credential_strict("terminal_id")
                    .expect("read startup terminal")
                    .as_ref()
                    .map(|value| value.as_str()),
                Some(REPAIR_TERMINAL)
            );
            assert!(!terminal_connection_rebind_pending(&database.state).expect("marker cleared"));
            assert!(read_terminal_transition_journal(&database.state).is_err());
            assert_eq!(
                crate::storage::get_credential_strict(crate::storage::KEY_REPAIR_SCOPE_V1)
                    .expect("read restored repair scope")
                    .expect("restored repair scope")
                    .as_str(),
                exact_old_repair_scope,
                "startup rollback did not restore the exact old repair scope"
            );
            for (key, expected) in [
                ("pos_api_key", "old-api-key"),
                ("terminal_id", REPAIR_TERMINAL),
                ("admin_dashboard_url", "https://old.example.com"),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
            ] {
                assert_eq!(
                    crate::storage::get_credential_strict(key)
                        .expect("strict-read startup-restored credential")
                        .as_ref()
                        .map(|value| value.as_str()),
                    Some(expected)
                );
            }
            {
                let connection = database.state.conn.lock().expect("inspect restored A");
                for (key, expected) in [
                    ("terminal_id", REPAIR_TERMINAL),
                    ("admin_dashboard_url", "https://old.example.com"),
                    ("organization_id", REPAIR_ORG),
                    ("branch_id", REPAIR_BRANCH),
                ] {
                    assert_eq!(
                        crate::db::get_setting(&connection, "terminal", key).as_deref(),
                        Some(expected),
                        "startup did not restore SQLite mirror {key} to exact A"
                    );
                }
            }
            assert_native_repair_fixture_intact(&database, &staged_path);

            publish_terminal_binding_checked(&database.state, &candidate)
                .expect("fresh validated candidate publishes B after safe rollback");
            assert_rebind_finished_without_interleaved_rows(&database);
            _keyring._lifecycle.reset();
        }
    }

    #[test]
    #[serial_test::serial]
    fn sqlite_mirror_failure_retains_exact_journal_and_restart_converges() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");
        {
            let connection = database.state.conn.lock().expect("install mirror failure");
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_branch_mirror_insert
                     BEFORE INSERT ON local_settings
                     WHEN NEW.setting_category = 'terminal'
                      AND NEW.setting_key = 'branch_id'
                      AND NEW.setting_value = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
                     BEGIN
                       SELECT RAISE(ABORT, 'injected branch mirror failure');
                     END;
                     CREATE TRIGGER fail_branch_mirror_update
                     BEFORE UPDATE ON local_settings
                     WHEN NEW.setting_category = 'terminal'
                      AND NEW.setting_key = 'branch_id'
                       AND NEW.setting_value = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
                     BEGIN
                       SELECT RAISE(ABORT, 'injected branch mirror failure');
                     END;",
                )
                .expect("install branch mirror failure trigger");
        }
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "replacement-key",
        });

        publish_terminal_binding_checked(&database.state, &candidate)
            .expect_err("partial SQLite mirror publication must fail closed");
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        super::read_terminal_rebind_candidate(&database.state, "replacement-key")
            .expect("exact candidate remains restart-authoritative");
        {
            let connection = database.state.conn.lock().expect("remove mirror failure");
            connection
                .execute_batch(
                    "DROP TRIGGER fail_branch_mirror_insert;
                     DROP TRIGGER fail_branch_mirror_update;",
                )
                .expect("remove branch mirror failure trigger");
        }
        reconcile_startup_terminal_binding(&database.state)
            .expect("restart retry converges from exact candidate");
        assert_rebind_finished_without_interleaved_rows(&database);
        let replacement_scope: serde_json::Value = serde_json::from_str(
            &crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .expect("replacement repair scope is present"),
        )
        .expect("replacement repair scope is valid JSON");
        assert_eq!(replacement_scope["organization_id"], REBIND_NEW_ORG);
        assert_eq!(replacement_scope["branch_id"], REBIND_NEW_BRANCH);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn authority_delete_failure_stays_blocked_and_retry_converges() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");
        crate::tests::fake_keyring::fail_deletes_for(
            crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
            "injected actor deletion failure",
        );
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "replacement-key",
        });

        let error = publish_terminal_binding_checked(&database.state, &candidate)
            .expect_err("actor deletion failure must fail closed");
        assert!(
            error.contains("injected actor deletion failure")
                || error.contains("REPAIR_ACTOR_ATTESTATION_CLEAR_FAILED")
        );
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        {
            let connection = database.state.conn.lock().expect("inspect barrier");
            assert!(crate::repairs::acquire_renderer_access(&connection).is_err());
        }

        crate::tests::fake_keyring::clear_failures_for(
            crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
        );
        publish_terminal_binding_checked(&database.state, &candidate)
            .expect("retry replacement publication");
        assert_rebind_finished_without_interleaved_rows(&database);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn startup_incomplete_binding_with_operational_state_latches_durable_marker() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();

        let error = reconcile_startup_terminal_binding(&database.state)
            .expect_err("incomplete startup binding must fail closed");

        assert!(error.contains("complete durable binding"));
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert_native_repair_fixture_intact(&database, &staged_path);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn terminal_rebind_snapshot_failure_preserves_all_native_repair_state() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();

        let error = prepare_terminal_connection_rebind_with_recovery(&database.state, |_, _| {
            Err("injected generic snapshot failure".to_string())
        })
        .expect_err("snapshot failure must stop terminal rebind before purge");

        assert!(error.contains("injected generic snapshot failure"));
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert_native_repair_fixture_intact(&database, &staged_path);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn native_repair_rebind_skips_generic_artifact_then_purges_and_waits_for_finish() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();

        let decision = prepare_terminal_connection_rebind(&database.state)
            .expect("native repair rebind should explicitly skip generic snapshot");

        assert!(matches!(
            decision,
            crate::recovery::DestructiveSnapshotDecision::SkippedNativeRepairState
        ));
        assert!(
            crate::recovery::list_recovery_points(&database.state)
                .expect("list recovery points")
                .is_empty(),
            "native repair rebind manufactured a generic recovery artifact"
        );
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("inspect purged repair db");
            for table in [
                "repair_cache",
                "repair_attachment_staging",
                "parity_sync_queue",
            ] {
                assert_eq!(
                    connection
                        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .expect("count purged repair rows"),
                    0,
                    "{table} survived the authorized old-scope purge"
                );
            }
        }
        assert!(!staged_path.exists());
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1).is_none()
        );
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ENTITLEMENT_V1).is_none()
        );
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1)
                .is_none()
        );
        assert!(crate::storage::session_get().is_none());

        finish_terminal_connection_rebind(&database.state)
            .expect("durable pending rebind should finish retryably");
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn canonical_connection_clear_invalidates_authority_and_removes_repair_scope() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed API key");

        clear_terminal_connection_lifecycle(&database.state)
            .expect("clear terminal connection lifecycle");

        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert!(!staged_path.exists());
        for key in [
            "admin_dashboard_url",
            "pos_api_key",
            "terminal_id",
            "organization_id",
            "branch_id",
            crate::storage::KEY_REPAIR_ACTOR_ATTESTATION_V1,
        ] {
            assert!(
                crate::storage::get_credential(key).is_none(),
                "credential {key} survived clear"
            );
        }
        assert!(crate::storage::session_get().is_none());
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).is_none(),
            "unconfigured terminal retained an impossible repair scope"
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn connection_clear_pre_api_identity_delete_failure_rolls_back_exactly_and_retry_converges() {
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed API key");
        crate::tests::fake_keyring::fail_deletes_for(
            "terminal_id",
            "injected identity deletion failure",
        );

        let error = clear_terminal_connection_lifecycle(&database.state)
            .expect_err("pre-API identity delete failure must compensate to exact Old");
        assert_eq!(error, "TERMINAL_CLEAR_WRITE_FAILED");
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert_native_repair_fixture_intact(&database, &staged_path);
        for (key, expected) in [
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("terminal_id", REPAIR_TERMINAL),
            ("admin_dashboard_url", "https://old.example.com"),
            ("pos_api_key", "old-api-key"),
        ] {
            assert_eq!(
                crate::storage::get_credential(key).as_deref(),
                Some(expected),
                "credential {key} was not restored exactly"
            );
        }
        let restored_scope: serde_json::Value = serde_json::from_str(
            &crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .expect("restored repair scope"),
        )
        .expect("parse restored repair scope");
        assert_eq!(
            restored_scope
                .get("transition_pending")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert_eq!(
            restored_scope
                .get("scope_epoch")
                .and_then(serde_json::Value::as_u64),
            Some(7)
        );
        crate::tests::fake_keyring::clear_failures_for("terminal_id");
        clear_terminal_connection_lifecycle(&database.state)
            .expect("retry connection clear lifecycle");
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        for key in ["organization_id", "branch_id", "terminal_id"] {
            assert!(crate::storage::get_credential(key).is_none());
        }
        assert!(crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).is_none());
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn terminal_rebind_finish_clears_old_scope_rows_inserted_after_first_clear() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();

        prepare_terminal_connection_rebind(&database.state)
            .expect("complete first recovery-safe clear");
        seed_interleaved_old_scope_generic_rows(&database);
        publish_replacement_credentials();

        finish_terminal_connection_rebind(&database.state)
            .expect("second clear and replacement scope publication");

        assert_rebind_finished_without_interleaved_rows(&database);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn terminal_rebind_final_clear_holds_sqlite_writer_barrier_through_scope_publication() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();

        prepare_terminal_connection_rebind(&database.state)
            .expect("complete first recovery-safe clear");
        seed_interleaved_old_scope_generic_rows(&database);
        publish_replacement_credentials();

        let (open_window_tx, open_window_rx) = std::sync::mpsc::channel();
        let (writer_attempting_tx, writer_attempting_rx) = std::sync::mpsc::channel();
        let (writer_acquired_tx, writer_acquired_rx) = std::sync::mpsc::channel();

        std::thread::scope(|scope| {
            let database_ref = &database;
            let writer = scope.spawn(move || {
                open_window_rx
                    .recv()
                    .expect("wait for final clear→publish window");
                writer_attempting_tx
                    .send(())
                    .expect("announce competing writer attempt");
                let connection = database_ref
                    .state
                    .conn
                    .lock()
                    .expect("competing generic writer acquires database");
                let marker_was_pending = crate::db::get_setting(
                    &connection,
                    "sync",
                    super::TERMINAL_CONNECTION_REBIND_PENDING_KEY,
                )
                .as_deref()
                    == Some("1");
                connection
                    .execute(
                        "INSERT INTO orders (
                             id, items, total_amount, total_amount_cents, status,
                             sync_status, created_at, updated_at
                         ) VALUES (
                             'writer-after-rebind-publication', '[]', 1.0, 100,
                             'pending', 'pending', datetime('now'), datetime('now')
                         )",
                        [],
                    )
                    .expect("competing writer inserts after publication boundary");
                writer_acquired_tx
                    .send(marker_was_pending)
                    .expect("report writer acquisition state");
            });

            super::finish_terminal_connection_rebind_with_window_hook(&database.state, || {
                open_window_tx
                    .send(())
                    .expect("open deterministic finalization window");
                writer_attempting_rx
                    .recv()
                    .expect("competing writer reached SQLite mutex");
                assert!(
                    writer_acquired_rx
                        .recv_timeout(std::time::Duration::from_millis(150))
                        .is_err(),
                    "competing generic writer acquired SQLite inside final clear→publish window"
                );
            })
            .expect("finish producer-safe rebind boundary");
            writer.join().expect("join competing generic writer");
        });

        assert_eq!(
            writer_acquired_rx
                .recv()
                .expect("read writer acquisition state"),
            false,
            "writer acquired before durable rebind marker was cleared"
        );
        assert_rebind_finished_without_interleaved_rows(&database);
        assert_eq!(
            database
                .state
                .conn
                .lock()
                .expect("inspect post-publication writer row")
                .query_row(
                    "SELECT COUNT(*) FROM orders WHERE id = 'writer-after-rebind-publication'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count post-publication writer row"),
            1
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn terminal_rebind_marker_clear_failure_reblocks_scope_and_retries() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();

        prepare_terminal_connection_rebind(&database.state)
            .expect("complete first recovery-safe clear");
        seed_interleaved_old_scope_generic_rows(&database);
        publish_replacement_credentials();
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("install marker-clear failure");
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_rebind_marker_clear
                       BEFORE DELETE ON local_settings
                       WHEN OLD.setting_category = 'sync'
                        AND OLD.setting_key = 'terminal_connection_rebind_pending'
                       BEGIN SELECT RAISE(ABORT, 'injected marker clear failure'); END;",
                )
                .expect("install marker-clear failure trigger");
        }

        let error = finish_terminal_connection_rebind(&database.state)
            .expect_err("marker clear failure must keep rebind fail-closed");

        assert!(error.contains("injected marker clear failure"), "{error}");
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        let pending_scope: serde_json::Value = serde_json::from_str(
            &crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .expect("replacement repair scope remains durable"),
        )
        .expect("parse replacement repair scope");
        assert_eq!(
            pending_scope
                .get("organization_id")
                .and_then(serde_json::Value::as_str),
            Some(REBIND_NEW_ORG)
        );
        assert_eq!(
            pending_scope
                .get("transition_pending")
                .and_then(serde_json::Value::as_bool),
            Some(true),
            "marker failure reopened repair access"
        );
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("remove marker-clear failure");
            connection
                .execute_batch("DROP TRIGGER fail_rebind_marker_clear;")
                .expect("remove marker-clear failure trigger");
        }
        seed_interleaved_old_scope_generic_rows(&database);

        finish_terminal_connection_rebind(&database.state)
            .expect("retry marker clear and scope publication");
        assert_rebind_finished_without_interleaved_rows(&database);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn old_rollback_marker_clear_failure_keeps_exact_old_scope_blocked_until_retry() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old Admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");
        let exact_old_scope = crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
            .expect("exact old scope");
        let previous = resolve_strict_terminal_authority(&database.state)
            .expect("read strict A")
            .expect("configured A");
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "replacement-key",
        });
        persist_terminal_rebind_candidate(&database.state, &candidate, Some(&previous))
            .expect("persist and arm v3 intent");
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("install Old rollback marker failure");
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_old_rollback_journal_clear
                       BEFORE DELETE ON local_settings
                       WHEN OLD.setting_category = 'sync'
                        AND OLD.setting_key = 'terminal_connection_rebind_candidate_v1'
                       BEGIN SELECT RAISE(ABORT, 'injected Old journal clear failure'); END;",
                )
                .expect("install Old rollback trigger");
        }
        crate::tests::fake_keyring::replace_next_write_with(
            "terminal_id",
            "mismatched-target-terminal",
        );

        assert_eq!(
            publish_terminal_binding_checked(&database.state, &candidate),
            Err("TERMINAL_BINDING_COMPENSATION_FAILED".to_string())
        );
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert!(
            crate::repairs::terminal_identity_rollback_publication_pending()
                .expect("read publication latch")
        );
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).as_deref(),
            Some(exact_old_scope.as_str()),
            "failed journal clear lost the exact restored A scope"
        );
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("remove Old rollback marker failure");
            connection
                .execute_batch("DROP TRIGGER fail_old_rollback_journal_clear;")
                .expect("remove Old rollback trigger");
        }

        assert_eq!(
            reconcile_startup_terminal_binding(&database.state).expect("retry exact Old rollback"),
            Some(REPAIR_TERMINAL.to_string())
        );
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert!(
            !crate::repairs::terminal_identity_rollback_publication_pending()
                .expect("read cleared publication latch")
        );
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).as_deref(),
            Some(exact_old_scope.as_str())
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn old_scope_restore_readback_failure_retains_journal_and_retry_converges() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old Admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");
        let exact_old_scope = crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
            .expect("exact old scope");
        let previous = resolve_strict_terminal_authority(&database.state)
            .expect("read strict A")
            .expect("configured A");
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "replacement-key",
        });
        persist_terminal_rebind_candidate(&database.state, &candidate, Some(&previous))
            .expect("persist and arm v3 intent");
        crate::tests::fake_keyring::after_next_write(crate::storage::KEY_REPAIR_SCOPE_V1, || {
            crate::tests::fake_keyring::fail_reads_for(
                crate::storage::KEY_REPAIR_SCOPE_V1,
                "injected restored-scope readback failure",
            );
        });
        crate::tests::fake_keyring::replace_next_write_with(
            "terminal_id",
            "mismatched-target-terminal",
        );

        assert_eq!(
            publish_terminal_binding_checked(&database.state, &candidate),
            Err("TERMINAL_BINDING_COMPENSATION_FAILED".to_string())
        );
        crate::tests::fake_keyring::clear_failures_for(crate::storage::KEY_REPAIR_SCOPE_V1);
        assert!(terminal_connection_rebind_pending(&database.state).expect("read retained marker"));
        assert!(
            crate::repairs::terminal_identity_rollback_publication_pending()
                .expect("read retained publication latch")
        );
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).as_deref(),
            Some(exact_old_scope.as_str()),
            "scope write succeeded but the retryable readback failure changed exact A"
        );

        assert_eq!(
            reconcile_startup_terminal_binding(&database.state)
                .expect("retry exact Old after readback recovery"),
            Some(REPAIR_TERMINAL.to_string())
        );
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert!(
            !crate::repairs::terminal_identity_rollback_publication_pending()
                .expect("read cleared publication latch")
        );
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).as_deref(),
            Some(exact_old_scope.as_str())
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn terminal_rebind_second_clear_failure_keeps_marker_and_scope_blocked_for_retry() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();

        prepare_terminal_connection_rebind(&database.state)
            .expect("complete first recovery-safe clear");
        seed_interleaved_old_scope_generic_rows(&database);
        publish_replacement_credentials();
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("install second-clear failure");
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_rebind_second_clear
                       BEFORE DELETE ON orders
                       BEGIN SELECT RAISE(ABORT, 'injected second clear failure'); END;",
                )
                .expect("install second-clear failure trigger");
        }

        let error = finish_terminal_connection_rebind(&database.state)
            .expect_err("failed second clear must not publish replacement repair scope");

        assert!(error.contains("injected second clear failure"), "{error}");
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        let pending_scope: serde_json::Value = serde_json::from_str(
            &crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .expect("pending old repair scope"),
        )
        .expect("parse pending old repair scope");
        assert_eq!(
            pending_scope
                .get("organization_id")
                .and_then(serde_json::Value::as_str),
            Some(REPAIR_ORG)
        );
        assert_eq!(
            pending_scope
                .get("transition_pending")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("remove second-clear failure");
            connection
                .execute_batch("DROP TRIGGER fail_rebind_second_clear;")
                .expect("remove second-clear failure trigger");
        }

        finish_terminal_connection_rebind(&database.state)
            .expect("retry second clear and scope publication");
        assert_rebind_finished_without_interleaved_rows(&database);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn accepted_reset_ownership_is_idempotent_across_two_orchestrations() {
        let _reset_tracking = reset_tracking_guard();
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        let preflights = std::cell::Cell::new(0_u32);
        let launches = std::cell::Cell::new(0_u32);
        let handoffs = std::cell::Cell::new(0_u32);

        let invoke = || {
            run_process_reset_with_recovery(
                &database.state,
                crate::recovery::RecoveryPointKind::PreFactoryReset,
                |_, _| {
                    preflights.set(preflights.get() + 1);
                    Ok(crate::recovery::DestructiveSnapshotDecision::SkippedNativeRepairState)
                },
                || {
                    launches.set(launches.get() + 1);
                    handoffs.set(handoffs.get() + 1);
                    crate::reset::ResetLaunchOutcome::Accepted {
                        operation_id: RESET_TEST_OPERATION_ID.to_string(),
                        response: serde_json::json!({
                            "success": true,
                            "started": true,
                            "operationId": RESET_TEST_OPERATION_ID,
                            "mode": "factory_reset"
                        }),
                        post_spawn_warning: Some(
                            "injected waiting-for-shutdown status failure".to_string(),
                        ),
                    }
                },
            )
        };

        let first = invoke().expect("first reset helper ownership accepted");
        let second = invoke().expect("duplicate reset returns accepted ownership");

        assert_eq!(preflights.get(), 1, "duplicate reset reran preflight");
        assert_eq!(launches.get(), 1, "duplicate reset spawned another helper");
        assert_eq!(
            handoffs.get(),
            1,
            "duplicate reset repeated shutdown handoff"
        );
        assert_eq!(second, first, "duplicate reset changed accepted result");
        assert_eq!(
            second
                .get("operationId")
                .and_then(serde_json::Value::as_str),
            Some(RESET_TEST_OPERATION_ID)
        );
        assert_native_repair_fixture_intact(&database, &staged_path);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn accepted_reset_warning_returns_success_without_second_helper_launch() {
        let _reset_tracking = reset_tracking_guard();
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        let launches = std::cell::Cell::new(0_u32);

        let response = run_process_reset_with_recovery(
            &database.state,
            crate::recovery::RecoveryPointKind::PreFactoryReset,
            crate::recovery::preflight_snapshot_before_destructive_action,
            || {
                launches.set(launches.get() + 1);
                crate::reset::ResetLaunchOutcome::Accepted {
                    operation_id: RESET_TEST_OPERATION_ID.to_string(),
                    response: serde_json::json!({
                        "success": true,
                        "started": true,
                        "operationId": RESET_TEST_OPERATION_ID,
                        "mode": "factory_reset"
                    }),
                    post_spawn_warning: Some("injected waiting status warning".to_string()),
                }
            },
        )
        .expect("accepted helper ownership must remain successful");

        assert_eq!(launches.get(), 1);
        assert_eq!(
            response.get("started").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            response
                .get("postSpawnWarning")
                .and_then(serde_json::Value::as_str),
            Some("injected waiting status warning")
        );
        assert_native_repair_fixture_intact(&database, &staged_path);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn reset_preflight_with_native_repairs_leaves_deletion_to_the_helper() {
        let _reset_tracking = reset_tracking_guard();
        let (_keyring, database, staged_path) = install_native_repair_fixture();

        let result = run_process_reset_with_recovery(
            &database.state,
            crate::recovery::RecoveryPointKind::PreFactoryReset,
            crate::recovery::preflight_snapshot_before_destructive_action,
            || crate::reset::ResetLaunchOutcome::Accepted {
                operation_id: RESET_TEST_OPERATION_ID.to_string(),
                response: serde_json::json!({
                    "success": true,
                    "started": true,
                    "operationId": RESET_TEST_OPERATION_ID,
                    "mode": "factory_reset"
                }),
                post_spawn_warning: None,
            },
        )
        .expect("simulated helper accepts reset");

        assert_eq!(
            result.get("started").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_native_repair_fixture_intact(&database, &staged_path);
        assert!(crate::recovery::list_recovery_points(&database.state)
            .expect("list recovery points")
            .is_empty());
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn reset_snapshot_failure_preserves_native_repairs_and_never_launches_helper() {
        let _reset_tracking = reset_tracking_guard();
        let (_keyring, database, staged_path) = install_native_repair_fixture();
        let launched = std::cell::Cell::new(false);

        let error = run_process_reset_with_recovery(
            &database.state,
            crate::recovery::RecoveryPointKind::PreEmergencyReset,
            |_, _| Err("injected reset snapshot failure".to_string()),
            || {
                launched.set(true);
                crate::reset::ResetLaunchOutcome::Accepted {
                    operation_id: RESET_TEST_OPERATION_ID.to_string(),
                    response: serde_json::json!({
                        "success": true,
                        "operationId": RESET_TEST_OPERATION_ID,
                        "mode": "emergency_reset"
                    }),
                    post_spawn_warning: None,
                }
            },
        )
        .expect_err("snapshot failure must block helper launch");

        assert!(error.contains("injected reset snapshot failure"));
        assert!(!launched.get());
        assert_native_repair_fixture_intact(&database, &staged_path);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn reset_helper_launch_failure_is_fail_closed_without_parent_side_purge() {
        let _reset_tracking = reset_tracking_guard();
        let (_keyring, database, staged_path) = install_native_repair_fixture();

        let error = run_process_reset_with_recovery(
            &database.state,
            crate::recovery::RecoveryPointKind::PreFactoryReset,
            crate::recovery::preflight_snapshot_before_destructive_action,
            || crate::reset::ResetLaunchOutcome::NotStarted {
                error: "injected reset helper launch failure".to_string(),
            },
        )
        .expect_err("helper launch failure must be reported");

        assert!(error.contains("injected reset helper launch failure"));
        assert_native_repair_fixture_intact(&database, &staged_path);
        {
            let connection = database
                .state
                .conn
                .lock()
                .expect("inspect failed reset barrier");
            let access_error = crate::repairs::acquire_renderer_access(&connection)
                .err()
                .expect("failed reset must keep repair IPC fail-closed");
            assert_eq!(access_error, "REPAIR_SCOPE_TRANSITION_PENDING");
        }

        run_process_reset_with_recovery(
            &database.state,
            crate::recovery::RecoveryPointKind::PreFactoryReset,
            crate::recovery::preflight_snapshot_before_destructive_action,
            || crate::reset::ResetLaunchOutcome::Accepted {
                operation_id: RESET_TEST_OPERATION_ID.to_string(),
                response: serde_json::json!({
                    "success": true,
                    "started": true,
                    "operationId": RESET_TEST_OPERATION_ID,
                    "mode": "factory_reset"
                }),
                post_spawn_warning: None,
            },
        )
        .expect("durably latched reset should remain retryable");
        assert_native_repair_fixture_intact(&database, &staged_path);
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn clean_process_reset_still_snapshots_before_helper_launch() {
        let _reset_tracking = reset_tracking_guard();
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let _keyring = crate::tests::fake_keyring::install_empty();
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed clean reset db");
            connection
                .execute(
                    "INSERT INTO orders (
                         id, items, total_amount, total_amount_cents, status,
                         sync_status, created_at, updated_at
                     ) VALUES ('clean-reset-order', '[]', 1.0, 100, 'pending', 'pending',
                               datetime('now'), datetime('now'))",
                    [],
                )
                .expect("seed generic reset row");
        }

        let error = run_process_reset_with_recovery(
            &database.state,
            crate::recovery::RecoveryPointKind::PreFactoryReset,
            crate::recovery::preflight_snapshot_before_destructive_action,
            || crate::reset::ResetLaunchOutcome::NotStarted {
                error: "injected launch after snapshot".to_string(),
            },
        )
        .expect_err("helper injection should stop after successful snapshot");

        assert!(error.contains("injected launch after snapshot"));
        let points = crate::recovery::list_recovery_points(&database.state)
            .expect("list clean reset recovery points");
        assert_eq!(points.len(), 1);
        assert_eq!(
            points[0].kind,
            crate::recovery::RecoveryPointKind::PreFactoryReset
        );
        assert_eq!(
            database
                .state
                .conn
                .lock()
                .expect("inspect clean reset db")
                .query_row(
                    "SELECT COUNT(*) FROM orders WHERE id = 'clean-reset-order'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count preserved clean reset row"),
            1
        );
    }

    #[test]
    #[serial_test::serial]
    fn strict_authority_rejects_hostile_connection_string_conflict_without_mutation() {
        let connection = serde_json::json!({
            "key": "api-A",
            "tid": REPAIR_TERMINAL,
            "url": "https://admin-a.example.com"
        })
        .to_string();
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("pos_api_key", connection.as_str()),
            ("terminal_id", REBIND_NEW_TERMINAL),
            ("admin_dashboard_url", "https://admin-b.example.com"),
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
        ]);
        let database = crate::tests::harness::TestDb::open();
        let error = publish_terminal_binding_checked(
            &database.state,
            &serde_json::json!({
                "apiKey": "replacement",
                "terminalId": REBIND_NEW_TERMINAL,
                "adminDashboardUrl": "https://admin-b.example.com",
                "organizationId": REBIND_NEW_ORG,
                "branchId": REBIND_NEW_BRANCH,
            }),
        )
        .expect_err("mixed connection-string authority must fail closed");
        assert_eq!(error, "TERMINAL_MANAGED_TUPLE_CONFLICT");
        for (key, expected) in [
            ("pos_api_key", connection.as_str()),
            ("terminal_id", REBIND_NEW_TERMINAL),
            ("admin_dashboard_url", "https://admin-b.example.com"),
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
        ] {
            assert_eq!(
                crate::storage::get_credential(key).as_deref(),
                Some(expected),
                "strict failure mutated {key}"
            );
        }
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
    }

    #[test]
    fn transition_intent_persists_candidate_and_pending_as_one_sqlite_generation() {
        let database = crate::tests::harness::TestDb::open();
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "fixture-b",
        });
        persist_terminal_rebind_candidate(&database.state, &candidate, None)
            .expect("persist atomic intent");
        let connection = database.state.conn.lock().expect("inspect atomic intent");
        let journal = crate::db::get_setting(
            &connection,
            "sync",
            TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
        )
        .expect("journal");
        assert_eq!(
            crate::db::get_setting(&connection, "sync", TERMINAL_CONNECTION_REBIND_PENDING_KEY)
                .as_deref(),
            Some("1")
        );
        assert!(!journal.contains("fixture-b"));
    }

    #[test]
    #[serial_test::serial]
    fn complete_old_authority_without_repair_scope_uses_none_envelope_and_rolls_back_exactly() {
        let _lifecycle = crate::repairs::isolate_lifecycle_for_test();
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", REPAIR_TERMINAL),
            ("admin_dashboard_url", "https://old.example.com"),
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("pos_api_key", "old-api-key"),
        ]);
        let database = crate::tests::harness::TestDb::open();
        let previous = resolve_strict_terminal_authority(&database.state)
            .expect("read complete authority A")
            .expect("authority A exists");
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "replacement-key",
        });

        let journal =
            persist_terminal_rebind_candidate(&database.state, &candidate, Some(&previous))
                .expect("persist v3 intent without a repair scope");
        assert!(journal.repair_scope_rollback.is_none());
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1).is_none(),
            "scope-less authority manufactured a repair AES key"
        );

        crate::tests::fake_keyring::replace_next_write_with(
            "terminal_id",
            "mismatched-target-terminal",
        );
        assert_eq!(
            publish_terminal_binding_checked(&database.state, &candidate),
            Err("TERMINAL_BINDING_WRITE_FAILED".to_string())
        );
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        for (key, expected) in [
            ("terminal_id", REPAIR_TERMINAL),
            ("admin_dashboard_url", "https://old.example.com"),
            ("organization_id", REPAIR_ORG),
            ("branch_id", REPAIR_BRANCH),
            ("pos_api_key", "old-api-key"),
        ] {
            assert_eq!(
                crate::storage::get_credential(key).as_deref(),
                Some(expected)
            );
        }
        assert!(crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).is_none());
        assert!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_QUEUE_AES_KEY_V1).is_none()
        );
    }

    #[test]
    #[serial_test::serial]
    fn same_pending_v3_intent_retry_preserves_operation_envelope_and_scope_epoch() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old Admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");
        let previous = resolve_strict_terminal_authority(&database.state)
            .expect("read strict A")
            .expect("configured A");
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "replacement-key",
        });

        let before =
            persist_terminal_rebind_candidate(&database.state, &candidate, Some(&previous))
                .expect("persist first v3 intent");
        let pending_scope_before =
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .expect("pending repair scope");

        super::with_settings_durability_owner(|| {
            super::publish_terminal_binding_under_lock(&database.state, &candidate, false)
        })
        .expect("retry the same durable intent without finalizing");

        let after = read_terminal_transition_journal(&database.state).expect("retained journal");
        assert_eq!(after.operation_id, before.operation_id);
        assert_eq!(after.repair_scope_rollback, before.repair_scope_rollback);
        assert_eq!(after.phase, TerminalTransitionPhase::MirrorsCommitted);
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).as_deref(),
            Some(pending_scope_before.as_str()),
            "retry incremented or rewrote the already-pending repair scope"
        );
        let scope: serde_json::Value =
            serde_json::from_str(&pending_scope_before).expect("parse pending scope");
        assert_eq!(
            scope.get("scope_epoch").and_then(serde_json::Value::as_u64),
            Some(8)
        );
        assert_eq!(
            scope
                .get("transition_pending")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    fn production_storage_has_no_unjournalled_terminal_batch_writer() {
        let storage_source = include_str!("../storage.rs");
        assert!(!storage_source.contains("fn update_terminal_credentials"));
    }

    #[test]
    #[serial_test::serial]
    fn ownerless_generic_terminal_writes_and_deletes_are_rejected_for_every_binding_key() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        for key in [
            "pos_api_key",
            "terminal_id",
            "admin_dashboard_url",
            "organization_id",
            "branch_id",
        ] {
            assert_eq!(
                crate::storage::set_credential(key, "hostile"),
                Err("TERMINAL_CREDENTIAL_OWNER_REQUIRED".to_string())
            );
            assert_eq!(
                crate::storage::delete_credential(key),
                Err("TERMINAL_CREDENTIAL_OWNER_REQUIRED".to_string())
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn equal_api_digest_credentials_committed_restart_converges_target_generation() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old Admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "shared-key")
            .expect("seed shared API key");
        let previous = resolve_strict_terminal_authority(&database.state)
            .expect("read strict A")
            .expect("configured A");
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "shared-key",
        });
        persist_terminal_rebind_candidate(&database.state, &candidate, Some(&previous))
            .expect("persist same-key intent");
        for (key, value) in [
            ("terminal_id", REBIND_NEW_TERMINAL),
            ("admin_dashboard_url", "https://replacement.example.com"),
            ("organization_id", REBIND_NEW_ORG),
            ("branch_id", REBIND_NEW_BRANCH),
            ("pos_api_key", "shared-key"),
        ] {
            super::set_terminal_credential_under_owner(key, value).expect("stage B credential");
        }
        update_terminal_transition_phase(
            &database.state,
            TerminalTransitionPhase::CredentialsCommitted,
        )
        .expect("durably commit B phase");

        reconcile_startup_terminal_binding(&database.state).expect("same-key restart converges B");

        assert_eq!(
            crate::storage::get_credential("terminal_id").as_deref(),
            Some(REBIND_NEW_TERMINAL)
        );
        assert_eq!(
            crate::storage::get_credential("organization_id").as_deref(),
            Some(REBIND_NEW_ORG)
        );
        assert_eq!(
            crate::storage::get_credential("branch_id").as_deref(),
            Some(REBIND_NEW_BRANCH)
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    fn journal_decoder_rejects_unknown_version_invalid_digest_and_phase_skip() {
        let database = crate::tests::harness::TestDb::open();
        let candidate = serde_json::json!({
            "terminalId": REBIND_NEW_TERMINAL,
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
            "adminDashboardUrl": "https://replacement.example.com",
            "apiKey": "candidate-key",
        });
        persist_terminal_rebind_candidate(&database.state, &candidate, None)
            .expect("persist valid journal");
        assert_eq!(
            update_terminal_transition_phase(
                &database.state,
                TerminalTransitionPhase::MirrorsCommitted
            ),
            Err("TERMINAL_TRANSITION_PHASE_INVALID".to_string())
        );
        assert_eq!(
            read_terminal_transition_journal(&database.state)
                .expect("skip rejection retains journal")
                .phase,
            TerminalTransitionPhase::Intent
        );
        update_terminal_transition_phase(
            &database.state,
            TerminalTransitionPhase::CredentialsCommitted,
        )
        .expect("exact next phase");
        update_terminal_transition_phase(
            &database.state,
            TerminalTransitionPhase::CredentialsCommitted,
        )
        .expect("same phase replay is idempotent");
        assert_eq!(
            update_terminal_transition_phase(&database.state, TerminalTransitionPhase::Intent),
            Err("TERMINAL_TRANSITION_PHASE_INVALID".to_string())
        );
        {
            let connection = database.state.conn.lock().expect("corrupt journal");
            let mut journal: serde_json::Value = serde_json::from_str(
                &crate::db::get_setting(
                    &connection,
                    "sync",
                    TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
                )
                .expect("journal row"),
            )
            .expect("journal JSON");
            journal["version"] = serde_json::json!(99);
            journal["api_key_digest"] = serde_json::json!("not-a-digest");
            crate::db::set_setting(
                &connection,
                "sync",
                TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
                &journal.to_string(),
            )
            .expect("write corrupt journal");
        }
        assert_eq!(
            read_terminal_transition_journal(&database.state),
            Err("TERMINAL_TRANSITION_JOURNAL_INVALID".to_string())
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn incoming_connection_string_conflict_fails_before_validation_http_or_journal() {
        let database = crate::tests::harness::TestDb::open();
        let connection = serde_json::json!({
            "key": "candidate-key",
            "tid": REPAIR_TERMINAL,
            "url": "https://tuple-a.example.com"
        })
        .to_string();
        let error = validate_terminal_binding_candidate(&serde_json::json!({
            "apiKey": connection,
            "terminalId": REBIND_NEW_TERMINAL,
            "adminDashboardUrl": "https://tuple-b.example.com",
            "organizationId": REBIND_NEW_ORG,
            "branchId": REBIND_NEW_BRANCH,
        }))
        .await
        .expect_err("conflicting explicit tuple must fail before HTTP");
        assert_eq!(error, "TERMINAL_CANDIDATE_TUPLE_CONFLICT");
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
    }

    #[test]
    fn equal_digest_phase_and_tuple_matrix_never_restores_old_after_commit() {
        let digest = api_key_digest("shared-key");
        let mut journal = TerminalRebindCandidateJournal {
            version: 2,
            operation_id: None,
            repair_scope_rollback: None,
            operation: TerminalTransitionOperation::Rebind,
            phase: TerminalTransitionPhase::Intent,
            organization_id: REBIND_NEW_ORG.to_string(),
            branch_id: REBIND_NEW_BRANCH.to_string(),
            terminal_id: REBIND_NEW_TERMINAL.to_string(),
            admin_dashboard_url: "https://replacement.example.com".to_string(),
            api_key_digest: digest.clone(),
            old_terminal_id: Some(REPAIR_TERMINAL.to_string()),
            old_admin_dashboard_url: Some("https://old.example.com".to_string()),
            old_organization_id: Some(REPAIR_ORG.to_string()),
            old_branch_id: Some(REPAIR_BRANCH.to_string()),
            old_api_key_digest: Some(digest.clone()),
            old_api_key_present: true,
        };
        for current_matches_target in [false, true] {
            assert_eq!(
                choose_rebind_recovery_generation(
                    &journal,
                    Some(digest.as_str()),
                    current_matches_target,
                ),
                RecoveryGeneration::Old,
                "Intent must restore exact A for A/B/mixed/missing non-secret tuples"
            );
        }
        let other_digest = api_key_digest("other");
        for phase in [
            TerminalTransitionPhase::CredentialsCommitted,
            TerminalTransitionPhase::MirrorsCommitted,
            TerminalTransitionPhase::OperationalPrepared,
        ] {
            journal.phase = phase;
            assert_eq!(
                choose_rebind_recovery_generation(&journal, Some(digest.as_str()), true),
                RecoveryGeneration::Target,
                "committed exact B must converge B at {phase:?}"
            );
            assert_eq!(
                choose_rebind_recovery_generation(&journal, Some(digest.as_str()), false),
                RecoveryGeneration::FailClosed,
                "committed A/mixed/missing tuple must never restore A at {phase:?}"
            );
            assert_eq!(
                choose_rebind_recovery_generation(&journal, None, false),
                RecoveryGeneration::FailClosed,
                "missing API key must remain blocked at {phase:?}"
            );
            assert_eq!(
                choose_rebind_recovery_generation(&journal, Some(other_digest.as_str()), false),
                RecoveryGeneration::FailClosed,
                "unknown API generation must remain blocked at {phase:?}"
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn startup_rejects_legacy_v2_intent_when_old_repair_scope_is_already_pending() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old Admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");
        let mut scope: serde_json::Value = serde_json::from_str(
            &crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
                .expect("old scope"),
        )
        .expect("parse old scope");
        scope["transition_pending"] = serde_json::json!(true);
        scope["scope_epoch"] = serde_json::json!(8);
        crate::storage::set_credential(crate::storage::KEY_REPAIR_SCOPE_V1, &scope.to_string())
            .expect("seed proofless pending legacy scope");
        seed_legacy_v2_rebind_intent(&database);

        assert_eq!(
            reconcile_startup_terminal_binding(&database.state),
            Err("REPAIR_TERMINAL_ROLLBACK_LEGACY_UNSAFE".to_string())
        );
        assert!(terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert_eq!(
            read_terminal_transition_journal(&database.state)
                .expect("legacy journal retained")
                .version,
            2
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn startup_allows_legacy_v2_intent_only_for_exact_nonpending_old_scope() {
        let (_keyring, database, _staged_path) = install_native_repair_fixture();
        super::set_terminal_credential_under_owner(
            "admin_dashboard_url",
            "https://old.example.com",
        )
        .expect("seed old Admin URL");
        super::set_terminal_credential_under_owner("pos_api_key", "old-api-key")
            .expect("seed old API key");
        let exact_old_scope = crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1)
            .expect("exact old scope");
        seed_legacy_v2_rebind_intent(&database);

        assert_eq!(
            reconcile_startup_terminal_binding(&database.state).expect("safe v2 rollback"),
            Some(REPAIR_TERMINAL.to_string())
        );
        assert!(!terminal_connection_rebind_pending(&database.state).expect("read marker"));
        assert_eq!(
            crate::storage::get_credential(crate::storage::KEY_REPAIR_SCOPE_V1).as_deref(),
            Some(exact_old_scope.as_str())
        );
        _keyring._lifecycle.reset();
    }

    #[test]
    #[serial_test::serial]
    fn actual_startup_rejects_corrupt_journal_matrix_without_credential_mutation() {
        let base = serde_json::json!({
            "version": 2,
            "operation": "rebind",
            "phase": "intent",
            "organization_id": REBIND_NEW_ORG,
            "branch_id": REBIND_NEW_BRANCH,
            "terminal_id": REBIND_NEW_TERMINAL,
            "admin_dashboard_url": "https://replacement.example.com",
            "api_key_digest": api_key_digest("new-key"),
            "old_terminal_id": REPAIR_TERMINAL,
            "old_admin_dashboard_url": "https://old.example.com",
            "old_organization_id": REPAIR_ORG,
            "old_branch_id": REPAIR_BRANCH,
            "old_api_key_digest": api_key_digest("old-key"),
            "old_api_key_present": true
        });
        let mut cases = Vec::new();
        for version in [0, 1, 99] {
            let mut value = base.clone();
            value["version"] = serde_json::json!(version);
            cases.push(value);
        }
        for (field, invalid) in [
            ("api_key_digest", serde_json::json!("short")),
            ("organization_id", serde_json::json!("not-a-uuid")),
            ("branch_id", serde_json::json!("not-a-uuid")),
            ("admin_dashboard_url", serde_json::json!("not-a-url")),
            ("phase", serde_json::json!("future_phase")),
            ("operation", serde_json::json!("unknown")),
        ] {
            let mut value = base.clone();
            value[field] = invalid;
            cases.push(value);
        }
        let mut contradictory = base.clone();
        contradictory["old_api_key_present"] = serde_json::json!(false);
        cases.push(contradictory);
        let mut missing_old = base.clone();
        missing_old
            .as_object_mut()
            .expect("journal object")
            .remove("old_branch_id");
        cases.push(missing_old);
        let mut impossible_clear = base.clone();
        impossible_clear["operation"] = serde_json::json!("clear");
        cases.push(impossible_clear);
        let mut unknown = base;
        unknown["unexpected"] = serde_json::json!(true);
        cases.push(unknown);

        for raw in cases {
            let _keyring = crate::tests::fake_keyring::install_seeded([
                ("pos_api_key", "old-key"),
                ("terminal_id", REPAIR_TERMINAL),
                ("admin_dashboard_url", "https://old.example.com"),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
            ]);
            let database = crate::tests::harness::TestDb::open();
            {
                let connection = database.state.conn.lock().expect("seed corrupt journal");
                crate::db::set_setting(
                    &connection,
                    "sync",
                    TERMINAL_CONNECTION_REBIND_CANDIDATE_KEY,
                    &raw.to_string(),
                )
                .expect("candidate row");
                crate::db::set_setting(
                    &connection,
                    "sync",
                    TERMINAL_CONNECTION_REBIND_PENDING_KEY,
                    "1",
                )
                .expect("pending row");
            }
            reconcile_startup_terminal_binding(&database.state)
                .expect_err("actual startup must reject corrupt journal");
            for (key, expected) in [
                ("pos_api_key", "old-key"),
                ("terminal_id", REPAIR_TERMINAL),
                ("admin_dashboard_url", "https://old.example.com"),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
            ] {
                assert_eq!(
                    crate::storage::get_credential(key).as_deref(),
                    Some(expected)
                );
            }
            assert!(terminal_connection_rebind_pending(&database.state).expect("marker retained"));
        }
    }

    #[test]
    #[serial_test::serial]
    fn credential_status_never_synthesizes_health_from_pending_or_hostile_sqlite() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let database = crate::tests::harness::TestDb::open();
        {
            let connection = database.state.conn.lock().expect("seed hostile mirrors");
            for (key, value) in [
                ("pos_api_key", "hostile-key"),
                ("terminal_id", REPAIR_TERMINAL),
                ("admin_dashboard_url", "https://hostile.example.com"),
                ("organization_id", REPAIR_ORG),
                ("branch_id", REPAIR_BRANCH),
            ] {
                crate::db::set_setting(&connection, "terminal", key, value)
                    .expect("hostile mirror");
            }
        }
        assert!(credential_status_projection(&database.state).is_err());
        {
            let connection = database.state.conn.lock().expect("seed pending marker");
            crate::db::set_setting(
                &connection,
                "sync",
                TERMINAL_CONNECTION_REBIND_PENDING_KEY,
                "1",
            )
            .expect("pending marker");
        }
        let pending = credential_status_projection(&database.state)
            .expect("pending status is a bounded unavailable projection");
        assert_eq!(pending["hasAdminUrl"], serde_json::json!(false));
        assert_eq!(pending["hasApiKey"], serde_json::json!(false));
        assert_eq!(pending["hasTerminalId"], serde_json::json!(false));
        assert_eq!(
            pending["reason"],
            serde_json::json!("terminal_transition_pending")
        );
    }
}
