//! A staff check-in this till made without the server (founder decision
//! 13/10/2026: the desktop follows the Android rules of PR #356).
//!
//! Online, the server checks the PIN (`/api/pos/staff-auth/check-in`) and its
//! answer stands. Only on a transport failure (no answer, or a 502, 503 or 504
//! from its gateway) does the till check the PIN against the hash it holds
//! (`staff_pin_vault.rs`). That check leaves a short-lived grant here, which
//! the native shift open reads, so neither the rules nor the marker depend on
//! the renderer:
//! - every role opens a shift this way (founder, 15/10/2026: anyone whose PIN
//!   this till holds), under the local rules that hold online too: the first
//!   check-in of the business day is a cashier;
//! - in a gift-card store a cashier's opening needs the server (the original
//!   drawer opening is hosted), as on Android;
//! - a waiter phone never checks staff in this way;
//! - the queued `shift_open` carries `offline_check_in: true`, which the
//!   server re-checks when it arrives (`offline-check-in.ts`).

use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::api::AdminFetchError;

/// How long a PIN checked on this till admits the shift opening it started
/// (role choice and the cash count happen in between).
const GRANT_TTL_MINUTES: i64 = 15;

pub(crate) const OFFLINE_CHECK_IN_GIFT_CARDS_NEED_SERVER: &str =
    "OFFLINE_CHECK_IN_GIFT_CARDS_NEED_SERVER";
pub(crate) const OFFLINE_CHECK_IN_WAITER_TERMINAL: &str = "OFFLINE_CHECK_IN_WAITER_TERMINAL";

/// How a shift opening was admitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CheckInAdmission {
    /// The server checked the PIN (or no check-in preceded the opening).
    Ordinary,
    /// This till checked the PIN itself.
    Offline,
}

struct Grant {
    expires_at: DateTime<Utc>,
}

fn grants() -> MutexGuard<'static, HashMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();
    GRANTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The server could not be reached: no answer came back, or its gateway
/// answered that it is down. Any other answer, a refusal or a rate limit
/// included, is the server's and stands.
pub(crate) fn is_transport_failure(error: &AdminFetchError) -> bool {
    error.is_transport_failure() || matches!(error.status(), Some(502 | 503 | 504))
}

/// The server checked this person's PIN: an earlier offline check stops
/// counting.
pub(crate) fn record_server_check_in(staff_id: &str) {
    grants().remove(staff_id.trim());
}

/// This till checked this person's PIN itself.
pub(crate) fn record_offline_check_in(staff_id: &str, now: DateTime<Utc>) {
    grants().insert(
        staff_id.trim().to_string(),
        Grant {
            expires_at: now + Duration::minutes(GRANT_TTL_MINUTES),
        },
    );
}

/// How a shift opening for `staff_id` is admitted now. The grant stays until
/// the opening succeeds, so a refused opening can be corrected.
pub(crate) fn admission_for(staff_id: &str, now: DateTime<Utc>) -> CheckInAdmission {
    let mut grants = grants();
    grants.retain(|_, grant| grant.expires_at > now);
    if grants.contains_key(staff_id.trim()) {
        CheckInAdmission::Offline
    } else {
        CheckInAdmission::Ordinary
    }
}

/// The shift the grant admitted is open.
pub(crate) fn complete(staff_id: &str) {
    grants().remove(staff_id.trim());
}

/// The rules of an opening whose PIN this till checked: never on a waiter
/// phone, and a gift-card store's cashier opening goes through the server.
/// Any role opens otherwise (founder, 15/10/2026).
pub(crate) fn check_offline_opening(
    role_type: &str,
    gift_cards_store: bool,
    waiter_terminal: bool,
) -> Result<(), String> {
    if waiter_terminal {
        return Err(OFFLINE_CHECK_IN_WAITER_TERMINAL.to_string());
    }
    if gift_cards_store && role_type.trim().eq_ignore_ascii_case("cashier") {
        return Err(OFFLINE_CHECK_IN_GIFT_CARDS_NEED_SERVER.to_string());
    }
    Ok(())
}

/// Whether the store sells gift cards, from the module list this till cached
/// (Android: `ModuleSyncService.isModuleEnabled('gift_cards')`). Unknown is
/// "no", as there.
pub(crate) fn gift_cards_store(db: &crate::db::DbState) -> bool {
    crate::core_helpers::read_module_cache(db)
        .ok()
        .and_then(|cache| {
            cache
                .get("apiModules")
                .and_then(|value| value.as_array())
                .cloned()
        })
        .is_some_and(|modules| {
            modules.iter().any(|module| {
                module.get("module_id").and_then(|value| value.as_str()) == Some("gift_cards")
            })
        })
}

/// A waiter phone never checks staff in without the server. A till without
/// a stored type is a main till, as elsewhere on the desktop.
pub(crate) fn waiter_terminal(conn: &rusqlite::Connection) -> bool {
    crate::db::get_setting(conn, "terminal", "terminal_type")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("mobile_waiter"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_no_answer_or_a_gateway_down_counts_as_a_transport_failure() {
        assert!(is_transport_failure(&AdminFetchError::transport(
            "Cannot reach admin"
        )));
        for status in [502, 503, 504] {
            assert!(is_transport_failure(&AdminFetchError::with_status(
                "down", status
            )));
        }
        for status in [400, 401, 403, 404, 409, 423, 429, 500] {
            assert!(
                !is_transport_failure(&AdminFetchError::with_status("answer", status)),
                "{status} is the server's answer"
            );
        }
        assert!(!is_transport_failure(&AdminFetchError::statusless(
            "Terminal not configured: missing API key"
        )));
    }

    #[test]
    fn a_grant_admits_the_offline_opening_until_it_expires_or_the_server_checks() {
        let now = Utc::now();
        let staff = "grant-test-staff-1";
        assert_eq!(admission_for(staff, now), CheckInAdmission::Ordinary);
        record_offline_check_in(staff, now);
        assert_eq!(
            admission_for(staff, now + Duration::minutes(5)),
            CheckInAdmission::Offline
        );
        assert_eq!(
            admission_for(staff, now + Duration::minutes(GRANT_TTL_MINUTES + 1)),
            CheckInAdmission::Ordinary
        );

        record_offline_check_in(staff, now);
        record_server_check_in(staff);
        assert_eq!(admission_for(staff, now), CheckInAdmission::Ordinary);
    }

    #[test]
    fn every_role_opens_offline_under_the_gift_card_and_waiter_phone_rules() {
        // Founder, 15/10/2026: every role checks in offline, not only a
        // cashier, manager or driver.
        for role in ["cashier", "manager", "driver", "kitchen", "server"] {
            assert!(check_offline_opening(role, false, false).is_ok(), "{role}");
        }
        for role in ["manager", "driver", "kitchen", "server"] {
            assert!(check_offline_opening(role, true, false).is_ok(), "{role}");
        }
        assert_eq!(
            check_offline_opening("cashier", true, false).unwrap_err(),
            OFFLINE_CHECK_IN_GIFT_CARDS_NEED_SERVER
        );
        for role in ["cashier", "kitchen"] {
            assert_eq!(
                check_offline_opening(role, false, true).unwrap_err(),
                OFFLINE_CHECK_IN_WAITER_TERMINAL,
                "{role}"
            );
        }
    }
}
