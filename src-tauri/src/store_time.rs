//! The store's own clock for printed times (POS audit P-03).
//!
//! Every store prints in its location's IANA zone. The server resolves that
//! zone per branch and the settings sync retains it as
//! `terminal.hotel_timezone` (the key predates its use beyond hotels; it is
//! the store zone) with the branch it was resolved for. When the retained zone
//! is missing, belongs to another branch or does not parse, prints keep the
//! device's zone, which is what they did before.

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, Utc};
use chrono_tz::Tz;
use rusqlite::Connection;
use tracing::warn;

use crate::db;

/// Retained zone of the store, written by the authenticated settings sync.
pub(crate) const STORE_TIME_ZONE_SETTING_CATEGORY: &str = "terminal";
pub(crate) const STORE_TIME_ZONE_SETTING_KEY: &str = "hotel_timezone";
pub(crate) const STORE_TIME_ZONE_BRANCH_SETTING_KEY: &str = "hotel_timezone_branch_id";

static UNRESOLVED_WARNED: AtomicBool = AtomicBool::new(false);

/// The store's zone, or `None` for the device zone.
///
/// The retained value counts only for the branch it was resolved for, so a
/// till moved to another branch never prints in the old store's time. Callers
/// hold the database lock, so the branch comes from the terminal setting only:
/// the OS keyring is never read here (a slow credential store would stall
/// every command waiting on the connection).
pub(crate) fn resolve_store_time_zone(conn: &Connection) -> Option<Tz> {
    let setting = |key: &str| {
        db::get_setting(conn, STORE_TIME_ZONE_SETTING_CATEGORY, key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let resolved = match setting(STORE_TIME_ZONE_SETTING_KEY) {
        None => Err("zone_missing"),
        Some(zone) => {
            let zone_branch = setting(STORE_TIME_ZONE_BRANCH_SETTING_KEY);
            match (zone_branch, setting("branch_id")) {
                (Some(zone_branch), Some(branch)) if zone_branch == branch => {
                    zone.parse::<Tz>().map_err(|_| "zone_invalid")
                }
                (_, None) => Err("branch_unknown"),
                _ => Err("branch_mismatch"),
            }
        }
    };
    match resolved {
        Ok(zone) => Some(zone),
        Err(reason) => {
            if !UNRESOLVED_WARNED.swap(true, Ordering::Relaxed) {
                warn!(
                    reason,
                    "store_timezone_unresolved: prints use the device time zone"
                );
            }
            None
        }
    }
}

/// A stored timestamp as an instant. RFC 3339 and Postgres text keep their
/// offset; text without one is SQLite's `datetime('now')`, which is UTC.
pub(crate) fn parse_stored_instant(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f%#z", "%Y-%m-%dT%H:%M:%S%.f%#z"] {
        if let Ok(parsed) = DateTime::parse_from_str(value, format) {
            return Some(parsed.with_timezone(&Utc));
        }
    }
    [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
    .map(|naive| naive.and_utc())
}

/// `instant` on the store's clock (`None`: the device's) with a chrono format.
pub(crate) fn format_instant(instant: DateTime<Utc>, zone: Option<Tz>, format: &str) -> String {
    match zone {
        Some(zone) => instant.with_timezone(&zone).format(format).to_string(),
        None => instant.with_timezone(&Local).format(format).to_string(),
    }
}

/// A stored timestamp on the store's clock, or `None` when it does not parse.
pub(crate) fn format_stored(value: &str, zone: Option<Tz>, format: &str) -> Option<String> {
    parse_stored_instant(value).map(|instant| format_instant(instant, zone, format))
}

/// The calendar day of a stored timestamp on the store's clock.
pub(crate) fn stored_local_date(value: &str, zone: Option<Tz>) -> Option<NaiveDate> {
    parse_stored_instant(value).map(|instant| match zone {
        Some(zone) => instant.with_timezone(&zone).date_naive(),
        None => instant.with_timezone(&Local).date_naive(),
    })
}

/// The current time on the store's clock.
pub(crate) fn format_now(zone: Option<Tz>, format: &str) -> String {
    format_instant(Utc::now(), zone, format)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_db(rows: &[(&str, &str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE local_settings (
                setting_category TEXT NOT NULL,
                setting_key TEXT NOT NULL,
                setting_value TEXT,
                updated_at TEXT,
                UNIQUE(setting_category, setting_key)
            );",
        )
        .unwrap();
        for (category, key, value) in rows {
            db::set_setting(&conn, category, key, value).unwrap();
        }
        conn
    }

    #[test]
    fn resolver_uses_the_retained_zone_of_the_terminals_branch() {
        let conn = settings_db(&[
            ("terminal", "branch_id", "branch-ch"),
            ("terminal", "hotel_timezone", "Europe/Zurich"),
            ("terminal", "hotel_timezone_branch_id", "branch-ch"),
        ]);
        assert_eq!(
            resolve_store_time_zone(&conn),
            Some(chrono_tz::Europe::Zurich)
        );
    }

    #[test]
    fn resolver_falls_back_to_the_device_zone_without_a_valid_same_branch_zone() {
        let other_branch = settings_db(&[
            ("terminal", "branch_id", "branch-new"),
            ("terminal", "hotel_timezone", "Europe/Zurich"),
            ("terminal", "hotel_timezone_branch_id", "branch-old"),
        ]);
        assert_eq!(resolve_store_time_zone(&other_branch), None);

        let cleared = settings_db(&[
            ("terminal", "branch_id", "branch-ch"),
            ("terminal", "hotel_timezone", ""),
            ("terminal", "hotel_timezone_branch_id", "branch-ch"),
        ]);
        assert_eq!(resolve_store_time_zone(&cleared), None);

        let invalid = settings_db(&[
            ("terminal", "branch_id", "branch-ch"),
            ("terminal", "hotel_timezone", "Mars/Olympus"),
            ("terminal", "hotel_timezone_branch_id", "branch-ch"),
        ]);
        assert_eq!(resolve_store_time_zone(&invalid), None);

        let unscoped = settings_db(&[
            ("terminal", "branch_id", "branch-ch"),
            ("terminal", "hotel_timezone", "Europe/Zurich"),
        ]);
        assert_eq!(resolve_store_time_zone(&unscoped), None);
    }

    #[test]
    fn fixed_zones_print_their_own_wall_clock() {
        let stored = "2026-10-20T22:30:00Z";
        let format = "%d/%m/%Y %H:%M";
        assert_eq!(
            format_stored(stored, Some(chrono_tz::Europe::Zurich), format).as_deref(),
            Some("21/10/2026 00:30")
        );
        assert_eq!(
            format_stored(stored, Some(chrono_tz::Europe::Athens), format).as_deref(),
            Some("21/10/2026 01:30")
        );
        assert_eq!(
            format_stored(stored, Some(chrono_tz::America::New_York), format).as_deref(),
            Some("20/10/2026 18:30")
        );
    }

    #[test]
    fn daylight_saving_boundary_follows_the_zone_rules() {
        // Europe switches back at 01:00 UTC on 25/10/2026: Athens goes from
        // UTC+3 to UTC+2, so 00:30 and 01:30 UTC both read 03:30 locally.
        let athens = Some(chrono_tz::Europe::Athens);
        assert_eq!(
            format_stored("2026-10-25T00:30:00Z", athens, "%H:%M").as_deref(),
            Some("03:30")
        );
        assert_eq!(
            format_stored("2026-10-25T01:30:00Z", athens, "%H:%M").as_deref(),
            Some("03:30")
        );
        // New York springs forward on 08/03/2026 at 07:00 UTC.
        let new_york = Some(chrono_tz::America::New_York);
        assert_eq!(
            format_stored("2026-03-08T06:59:00Z", new_york, "%H:%M").as_deref(),
            Some("01:59")
        );
        assert_eq!(
            format_stored("2026-03-08T07:00:00Z", new_york, "%H:%M").as_deref(),
            Some("03:00")
        );
    }

    #[test]
    fn text_without_an_offset_is_utc() {
        let zurich = Some(chrono_tz::Europe::Zurich);
        for stored in [
            "2026-10-06 16:07:12",
            "2026-10-06T16:07:12",
            "2026-10-06 16:07:12.689",
            "2026-10-06 16:07",
            " 2026-10-06T16:07:12Z ",
        ] {
            assert_eq!(
                format_stored(stored, zurich, "%H:%M").as_deref(),
                Some("18:07"),
                "{stored}"
            );
        }
        assert_eq!(
            format_stored("2026-10-06T19:07:12.689+03:00", zurich, "%H:%M").as_deref(),
            Some("18:07")
        );
        assert_eq!(
            format_stored("2026-10-06 16:07:12.689+00", zurich, "%H:%M").as_deref(),
            Some("18:07")
        );
        assert_eq!(format_stored("not a time", zurich, "%H:%M"), None);
        assert_eq!(format_stored("", zurich, "%H:%M"), None);
    }

    #[test]
    fn no_zone_uses_the_device_clock() {
        let stored = "2026-10-06T16:07:12Z";
        let device = DateTime::parse_from_rfc3339(stored)
            .unwrap()
            .with_timezone(&Local);
        assert_eq!(
            format_stored(stored, None, "%d/%m/%Y %H:%M"),
            Some(device.format("%d/%m/%Y %H:%M").to_string())
        );
        assert_eq!(stored_local_date(stored, None), Some(device.date_naive()));
    }

    #[test]
    fn local_date_is_the_stores_calendar_day() {
        let late_utc = "2026-08-26T22:30:00Z";
        assert_eq!(
            stored_local_date(late_utc, Some(chrono_tz::Europe::Athens)),
            NaiveDate::from_ymd_opt(2026, 8, 27)
        );
        assert_eq!(
            stored_local_date(late_utc, Some(chrono_tz::America::New_York)),
            NaiveDate::from_ymd_opt(2026, 8, 26)
        );
    }
}
