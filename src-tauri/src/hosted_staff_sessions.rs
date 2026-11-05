//! Hosted staff sessions recorded at a server check-in (founder, 03/11/2026).
//!
//! The till's own login is a PIN for a pseudo user ("admin-user" or
//! "staff-user"), which never names a real person. Remote support must act for
//! the staff member checked in on this terminal, with the hosted staff session
//! the server issued at that check-in. Before 1.4.143 the check-in reply's
//! session was dropped, so support refused on every desktop till.
//!
//! One OS-keyring entry per staff member, native only: the session id is a
//! header value the renderer never sees. A newer check-in replaces it; a
//! check-out or the till's logout removes it; it is unusable once expired.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub(crate) const KEY_PREFIX: &str = "hosted_staff_session_v1_";
pub(crate) const SUPPORT_CONNECT: &str = "pos.support.connect";

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct HostedStaffSession {
    pub staff_id: String,
    pub session_id: String,
    /// The server's base role name for this person (`role_name`).
    pub role_name: String,
    /// Every base role this person holds here (`staff.roles`), the primary
    /// first. The server accepts consent from any of them, so the till must
    /// not judge by the primary role alone.
    #[serde(default)]
    pub base_roles: Vec<String>,
    pub terminal_id: String,
    pub support_connect: bool,
    pub expires_at: DateTime<Utc>,
    pub checked_in_at: DateTime<Utc>,
}

impl fmt::Debug for HostedStaffSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostedStaffSession")
            .field("staff_id", &self.staff_id)
            .field("role_name", &self.role_name)
            .field("base_roles", &self.base_roles)
            .field("terminal_id", &self.terminal_id)
            .field("support_connect", &self.support_connect)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

fn uuid(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value.trim())
        .ok()
        .map(|id| id.to_string())
}

/// Tests reach the keyring only through the fake: a check-in test that did not
/// install one must never write the real OS keyring.
fn key(staff_id: &str) -> Option<String> {
    #[cfg(test)]
    if !crate::tests::fake_keyring::is_installed() {
        return None;
    }
    uuid(staff_id).map(|id| format!("{KEY_PREFIX}{id}"))
}

fn text<'a>(object: &'a Value, field: &str) -> Option<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// The primary role, then every other base role the reply names, once each.
fn base_roles(body: &Value, primary: &str) -> Vec<String> {
    let others = body
        .get("staff")
        .and_then(|staff| staff.get("roles"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|role| text(role, "name"));
    let mut roles: Vec<String> = Vec::new();
    for role in std::iter::once(primary).chain(others) {
        let role = role.trim().to_ascii_lowercase();
        if !role.is_empty() && !roles.contains(&role) {
            roles.push(role);
        }
    }
    roles
}

/// The server's check-in reply, read exactly: one session for this person.
pub(crate) fn from_check_in(
    body: &Value,
    staff_id: &str,
    now: DateTime<Utc>,
) -> Option<HostedStaffSession> {
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let staff = uuid(staff_id)?;
    let session_id = uuid(text(body, "session_id")?)?;
    let session = body.get("session")?;
    if uuid(text(session, "id")?)? != session_id {
        return None;
    }
    for answered in [text(body, "staff_id"), text(session, "staff_id")] {
        if uuid(answered?)? != staff {
            return None;
        }
    }
    let expires_at = DateTime::parse_from_rfc3339(text(session, "expires_at")?)
        .ok()?
        .with_timezone(&Utc);
    if expires_at <= now {
        return None;
    }
    let support_connect = body
        .get("permissions")
        .and_then(Value::as_array)
        .is_some_and(|names| {
            names
                .iter()
                .any(|name| name.as_str() == Some(SUPPORT_CONNECT))
        });
    let role_name = text(body, "role_name")
        .unwrap_or_default()
        .to_ascii_lowercase();
    Some(HostedStaffSession {
        staff_id: staff,
        session_id,
        base_roles: base_roles(body, &role_name),
        role_name,
        terminal_id: text(session, "terminal_id")?.to_string(),
        support_connect,
        expires_at,
        checked_in_at: now,
    })
}

/// Keeps the session of an accepted server check-in. A reply without a usable
/// session clears any older one, so a stale session never outlives a newer
/// check-in of the same person.
pub(crate) fn record_check_in(body: &Value, staff_id: &str, now: DateTime<Utc>) {
    let Some(key) = key(staff_id) else { return };
    let stored = from_check_in(body, staff_id, now).and_then(|session| {
        serde_json::to_string(&session)
            .ok()
            .and_then(|raw| crate::storage::hosted_staff_session_write(&key, &raw).ok())
    });
    if stored.is_none() {
        let _ = crate::storage::hosted_staff_session_delete(&key);
    }
}

/// The recorded session of this person, while it lasts.
pub(crate) fn usable(staff_id: &str, now: DateTime<Utc>) -> Option<HostedStaffSession> {
    let raw = crate::storage::hosted_staff_session_read(&key(staff_id)?).ok()??;
    serde_json::from_str::<HostedStaffSession>(&raw)
        .ok()
        .filter(|session| session.expires_at > now)
}

pub(crate) fn forget(staff_id: &str) {
    if let Some(key) = key(staff_id) {
        let _ = crate::storage::hosted_staff_session_delete(&key);
    }
}

/// The till's logout: forget everyone on shift here. A person with no active
/// shift can never act for support, so nothing else needs listing.
pub(crate) fn forget_on_shift(conn: &rusqlite::Connection) {
    let staff: Vec<String> = conn
        .prepare("SELECT DISTINCT staff_id FROM staff_shifts WHERE status = 'active'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap_or_default();
    for staff_id in staff {
        forget(&staff_id);
    }
}

#[cfg(test)]
pub(crate) fn check_in_reply(
    staff_id: &str,
    session_id: &str,
    terminal_id: &str,
    role_name: &str,
    permissions: &[&str],
    expires_at: DateTime<Utc>,
) -> Value {
    serde_json::json!({
        "success": true,
        "session_id": session_id,
        "staff_id": staff_id,
        "role_name": role_name,
        "branch_id": "branch-1",
        "organization_id": "org-1",
        "permissions": permissions,
        "session": {
            "id": session_id,
            "staff_id": staff_id,
            "terminal_id": terminal_id,
            "expires_at": expires_at.to_rfc3339(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    const STAFF: &str = "11111111-1111-4111-8111-111111111111";
    const SESSION: &str = "22222222-2222-4222-8222-222222222222";

    #[test]
    fn records_reads_replaces_and_forgets_one_session_per_person() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        let reply = check_in_reply(
            STAFF,
            SESSION,
            "terminal-1",
            "Cashier",
            &[SUPPORT_CONNECT],
            now + Duration::hours(8),
        );
        record_check_in(&reply, STAFF, now);
        let session = usable(&STAFF.to_uppercase(), now).expect("recorded");
        assert_eq!(
            (
                session.session_id.as_str(),
                session.role_name.as_str(),
                session.terminal_id.as_str()
            ),
            (SESSION, "cashier", "terminal-1")
        );
        assert!(session.support_connect);
        assert!(
            !format!("{session:?}").contains(SESSION),
            "Debug never shows the header value"
        );
        assert!(
            usable(STAFF, now + Duration::hours(9)).is_none(),
            "expired sessions are unusable"
        );

        // A newer check-in without a usable session clears the older one.
        record_check_in(
            &serde_json::json!({"success": true, "staff_id": STAFF}),
            STAFF,
            now,
        );
        assert!(usable(STAFF, now).is_none());

        record_check_in(&reply, STAFF, now);
        forget(STAFF);
        assert!(usable(STAFF, now).is_none());
    }

    #[test]
    fn refuses_a_reply_for_someone_else_or_with_a_mismatched_session() {
        let now = Utc::now();
        let later = now + Duration::hours(8);
        let other = "33333333-3333-4333-8333-333333333333";
        assert!(from_check_in(
            &check_in_reply(other, SESSION, "t", "cashier", &[], later),
            STAFF,
            now
        )
        .is_none());
        let mut mismatched = check_in_reply(STAFF, SESSION, "t", "cashier", &[], later);
        mismatched["session"]["id"] = Value::String(other.into());
        assert!(from_check_in(&mismatched, STAFF, now).is_none());
        assert!(from_check_in(
            &check_in_reply(STAFF, SESSION, "t", "cashier", &[], now),
            STAFF,
            now
        )
        .is_none());
        assert!(from_check_in(
            &check_in_reply("admin-user", SESSION, "t", "admin", &[], later),
            "admin-user",
            now
        )
        .is_none());
        let plain = from_check_in(
            &check_in_reply(STAFF, SESSION, "t", "waiter", &["pos.orders"], later),
            STAFF,
            now,
        )
        .unwrap();
        assert!(!plain.support_connect);
    }

    #[test]
    fn keeps_every_base_role_the_reply_names_primary_first() {
        let now = Utc::now();
        let mut reply = check_in_reply(
            STAFF,
            SESSION,
            "t",
            "Waiter",
            &[SUPPORT_CONNECT],
            now + Duration::hours(8),
        );
        reply["staff"] = serde_json::json!({"roles": [
            {"name": "waiter", "is_primary": true},
            {"name": "Cashier"},
            {"name": " "},
            {"display_name": "no name"},
        ]});
        let session = from_check_in(&reply, STAFF, now).unwrap();
        assert_eq!(session.role_name, "waiter");
        assert_eq!(session.base_roles, ["waiter", "cashier"]);

        // A record kept before base roles existed still reads.
        let mut older = serde_json::to_value(&session).unwrap();
        older.as_object_mut().unwrap().remove("base_roles");
        let older: HostedStaffSession = serde_json::from_value(older).unwrap();
        assert!(older.base_roles.is_empty());
    }

    /// Codex review of #411: `settings_get_local("hosted_staff_session_v1_<id>")`
    /// fell through to the generic credential read and handed any renderer
    /// script the session id. Only this module reads or writes the entry.
    #[test]
    fn no_generic_settings_or_credential_call_reaches_a_session() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let now = Utc::now();
        let reply = check_in_reply(
            STAFF,
            SESSION,
            "terminal-1",
            "cashier",
            &[SUPPORT_CONNECT],
            now + Duration::hours(8),
        );
        record_check_in(&reply, STAFF, now);
        let stored = format!("{KEY_PREFIX}{STAFF}");
        for key in [stored.clone(), stored.to_uppercase(), format!(" {stored}")] {
            assert!(crate::storage::get_credential(&key).is_none());
            assert!(crate::storage::settings_get(Some(&key)).is_null());
            assert!(crate::storage::get_setting(Some("terminal"), Some(&key)).is_null());
            assert!(crate::is_sensitive_setting_path("general", &key));
            assert!(crate::is_sensitive_setting_path(&key, "value"));
            assert_eq!(
                crate::storage::set_credential(&key, "{}"),
                Err("HOSTED_STAFF_SESSION_NATIVE_ONLY".to_string())
            );
            assert_eq!(
                crate::storage::delete_credential(&key),
                Err("HOSTED_STAFF_SESSION_NATIVE_ONLY".to_string())
            );
        }
        assert_eq!(
            usable(STAFF, now).map(|session| session.session_id),
            Some(SESSION.to_string()),
            "the native reader still has it"
        );
        assert_eq!(
            crate::storage::hosted_staff_session_read("pos_api_key"),
            Err("HOSTED_STAFF_SESSION_KEY_REQUIRED".to_string())
        );
    }
}
