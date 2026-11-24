//! A small local record of the calls a Caller ID source reported.
//!
//! Founder, 23/11/2026: nobody could say how many calls the store receives,
//! because the till showed each call and kept nothing. Every call the local
//! source accepts now leaves one row in `caller_id_log` (desktop schema v42,
//! `organization_id` since v48; no schema change here).
//!
//! The record never stands between a call and its popup:
//! - the publisher hands the row to a bounded queue after it has emitted the
//!   popup event, and does not wait for it;
//! - one writer drains the queue off the async threads, so a held database
//!   mutex delays rows, never calls; a full queue drops the row with a warning;
//! - a failed write is logged and forgotten.
//!
//! Nothing here leaves the till: no request, no sync row, no upload. Rows are
//! deleted after [`CALL_LOG_RETENTION_DAYS`] days, with the till's data on a
//! reset or re-pair, and for a customer whose erasure the till applies.
//!
//! Staff read the record in the till's «Πρόσφατες κλήσεις» list
//! ([`recent_calls`]). The one thing staff do that is written back is going on
//! from a call's customer search to an order ([`mark_order_started`]).

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::Manager;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::grandstream_fxo::Presentation;
use crate::db::{self, DbState};

/// How long a call stays on the till.
pub(crate) const CALL_LOG_RETENTION_DAYS: i64 = 30;
/// How often expired rows are deleted. The first pass runs at start.
const CALL_LOG_PURGE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Rows waiting for the writer. A store's phone cannot fill this; a database
/// held for minutes can, and then rows are dropped, never calls.
const CALL_LOG_QUEUE_CAPACITY: usize = 64;

/// `caller_number` of a call whose number the caller withheld. The column is
/// NOT NULL and holds digits for every other call, so the word cannot be
/// taken for a number.
pub(crate) const RESTRICTED_NUMBER: &str = "restricted";
/// `caller_number` of a call the device reported with no number and no
/// privacy flag.
pub(crate) const UNKNOWN_NUMBER: &str = "unknown";
/// `action_taken` of a new row: the till saw the call.
pub(crate) const ACTION_DETECTED: &str = "detected";
/// `action_taken` once staff went on from the call's customer search to an
/// order. Closing the search, or never opening it, leaves `detected`: the
/// till does not guess what a call was about.
pub(crate) const ACTION_ORDER_STARTED: &str = "order_started";
/// Calls the staff list shows when the till does not ask for a number.
pub(crate) const RECENT_CALLS_DEFAULT_LIMIT: usize = 50;
/// The most calls one read of the staff list returns.
pub(crate) const RECENT_CALLS_MAX_LIMIT: usize = 200;
/// How far a recorded call's time may be from the time the popup reports for
/// it. Both come from the same event, so this only absorbs rounding.
const SAME_CALL_TOLERANCE_SECONDS: f64 = 1.0;
/// Longest row or customer id a renderer may name. Ids are UUIDs.
const MAX_REFERENCE_LENGTH: usize = 128;

/// One accepted call, as the publisher saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallLogEntry {
    pub provider_event_id: String,
    pub caller_number: Option<String>,
    pub presentation: Presentation,
    pub occurred_at: DateTime<Utc>,
}

impl CallLogEntry {
    /// The row key. Support tools read `sip_call_id` as a safe column, and a
    /// device chooses its own SIP Call-ID, which could carry the number. A
    /// digest keeps one call on one row without storing the device's text.
    fn row_key(&self) -> String {
        let digest = crate::capture::files::sha256_hex(self.provider_event_id.as_bytes());
        format!("call-{}", &digest[..32])
    }

    fn stored_number(&self) -> &str {
        match (self.presentation, self.caller_number.as_deref()) {
            (Presentation::Allowed, Some(number)) if !number.trim().is_empty() => number,
            (Presentation::Restricted, _) => RESTRICTED_NUMBER,
            _ => UNKNOWN_NUMBER,
        }
    }
}

/// The publisher's end of the queue.
#[derive(Clone)]
pub(crate) struct CallLogSink {
    sender: mpsc::Sender<CallLogEntry>,
}

impl CallLogSink {
    /// Never waits. A full or closed queue costs this one row.
    pub(crate) fn offer(&self, entry: CallLogEntry) {
        if self.sender.try_send(entry).is_err() {
            warn!(
                "Caller ID call record queue is unavailable; one call was shown but not recorded"
            );
        }
    }
}

/// A queue of `capacity` rows and the future that writes them one at a time.
/// `write` runs on a blocking thread: it may wait for the database mutex.
pub(crate) fn call_log_queue<W>(
    capacity: usize,
    write: W,
) -> (CallLogSink, impl std::future::Future<Output = ()>)
where
    W: Fn(CallLogEntry) + Send + Sync + 'static,
{
    let (sender, mut receiver) = mpsc::channel::<CallLogEntry>(capacity);
    let write = Arc::new(write);
    let writer = async move {
        while let Some(entry) = receiver.recv().await {
            let write = Arc::clone(&write);
            if tokio::task::spawn_blocking(move || write(entry))
                .await
                .is_err()
            {
                warn!("Caller ID call record writer stopped on one row");
            }
        }
    };
    (CallLogSink { sender }, writer)
}

static CALL_LOG_SINK: OnceLock<CallLogSink> = OnceLock::new();

/// The till's one call record queue, started on first use.
pub(crate) fn sink(app_handle: &tauri::AppHandle) -> CallLogSink {
    CALL_LOG_SINK
        .get_or_init(|| {
            let app = app_handle.clone();
            let (sink, writer) = call_log_queue(CALL_LOG_QUEUE_CAPACITY, move |entry| {
                // `state` panics when the database is not managed yet, and a
                // panic here would only be a quiet warning per call.
                let Some(db) = app.try_state::<DbState>() else {
                    warn!("Caller ID call could not be recorded: the database is not ready");
                    return;
                };
                if let Err(error) = record_call(&db, &entry) {
                    // The error text is SQLite's; it carries no caller data.
                    warn!(error = %error, "Caller ID call could not be recorded");
                }
            });
            tauri::async_runtime::spawn(writer);
            sink
        })
        .clone()
}

/// Writes one call. The customer match and the organisation are read first,
/// each in its own short hold of the database mutex; the insert is the only
/// statement of its own hold. The popup's lookup takes the same mutex a
/// moment after the call arrives.
pub(crate) fn record_call(db: &DbState, entry: &CallLogEntry) -> Result<(), String> {
    let customer_id = match (entry.presentation, entry.caller_number.as_deref()) {
        (Presentation::Allowed, Some(number)) => {
            crate::commands::customers::cached_customer_id_for_caller_id(db, number)
        }
        _ => None,
    };
    let organization_id = current_organization_id(db);
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    db::upsert_caller_id_log(
        &conn,
        entry.stored_number(),
        None,
        customer_id.as_deref(),
        // The name stays in the customer directory; the row keeps the id only.
        None,
        &entry.row_key(),
        ACTION_DETECTED,
        organization_id.as_deref(),
        &entry
            .occurred_at
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

fn current_organization_id(db: &DbState) -> Option<String> {
    crate::storage::get_credential("organization_id")
        .or_else(|| {
            let conn = db.conn.lock().ok()?;
            db::get_setting(&conn, "terminal", "organization_id")
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Deletes the rows older than the retention, measured by the instant: the
/// column has held two text formats (`datetime('now')` and RFC 3339). A row
/// whose time cannot be read counts as expired, so a damaged row cannot stay
/// for ever.
pub(crate) fn purge_expired(conn: &Connection, now: DateTime<Utc>) -> Result<usize, String> {
    let cutoff = (now - chrono::Duration::days(CALL_LOG_RETENTION_DAYS))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    conn.execute(
        "DELETE FROM caller_id_log
          WHERE julianday(created_at) IS NULL OR julianday(created_at) < julianday(?1)",
        params![cutoff],
    )
    .map_err(|e| format!("purge caller_id_log: {e}"))
}

/// Deletes an erased customer's calls: the rows matched to the customer, and
/// the rows of the customer's own numbers (a call can precede the customer
/// card). `phone_keys` are the directory's national lookup keys.
pub(crate) fn forget_customer(
    conn: &Connection,
    customer_id: &str,
    phone_keys: &[String],
    phone_key_of: impl Fn(&str) -> String,
) -> Result<usize, String> {
    let mut deleted = conn
        .execute(
            "DELETE FROM caller_id_log WHERE customer_id = ?1",
            params![customer_id],
        )
        .map_err(|e| format!("forget caller_id_log customer: {e}"))?;
    let keys: Vec<&String> = phone_keys.iter().filter(|key| key.len() >= 3).collect();
    if keys.is_empty() {
        return Ok(deleted);
    }
    let rows: Vec<(String, String)> = {
        let mut statement = conn
            .prepare("SELECT id, caller_number FROM caller_id_log")
            .map_err(|e| format!("read caller_id_log numbers: {e}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("read caller_id_log numbers: {e}"))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("read caller_id_log numbers: {e}"))?
    };
    for (id, number) in rows {
        let key = phone_key_of(&number);
        if keys.iter().any(|known| **known == key) {
            deleted += conn
                .execute("DELETE FROM caller_id_log WHERE id = ?1", params![id])
                .map_err(|e| format!("forget caller_id_log number: {e}"))?;
        }
    }
    Ok(deleted)
}

/// One call of the staff list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentCall {
    /// The row's id: what a search opened from the list names when staff go
    /// on to an order.
    pub id: String,
    /// RFC 3339 UTC.
    pub occurred_at: String,
    /// `allowed`, `restricted` (the caller withheld the number) or `unknown`
    /// (the device reported none).
    pub presentation: &'static str,
    pub number: Option<String>,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub order_started: bool,
}

/// The newest calls of the retention window for the staff list, newest first.
/// The rows are read in one short hold of the database mutex and the customer
/// directory in another; names come from the directory as it is now.
pub(crate) fn recent_calls(
    db: &DbState,
    limit: usize,
    now: DateTime<Utc>,
) -> Result<Vec<RecentCall>, String> {
    let organization_id = current_organization_id(db);
    let rows = {
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        recent_call_rows(&conn, organization_id.as_deref(), limit, now)?
    };
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let directory = crate::commands::customers::CallerIdDirectory::load(db);
    Ok(rows
        .into_iter()
        .map(|row| {
            let presentation = match row.caller_number.as_str() {
                RESTRICTED_NUMBER => "restricted",
                UNKNOWN_NUMBER => "unknown",
                number if number.trim().is_empty() => "unknown",
                _ => "allowed",
            };
            let number = (presentation == "allowed").then(|| row.caller_number.clone());
            // The customer staff chose for the order, else the one the number
            // belongs to today.
            let customer = row
                .customer_id
                .as_deref()
                .and_then(|id| directory.by_id(id))
                .or_else(|| number.as_deref().and_then(|n| directory.by_number(n)));
            RecentCall {
                id: row.id,
                occurred_at: row.occurred_at,
                presentation,
                number,
                customer_id: customer.map(|customer| customer.id.clone()),
                customer_name: customer.and_then(|customer| customer.name.clone()),
                order_started: row.action_taken.as_deref() == Some(ACTION_ORDER_STARTED),
            }
        })
        .collect())
}

struct RecentCallRow {
    id: String,
    caller_number: String,
    customer_id: Option<String>,
    action_taken: Option<String>,
    occurred_at: String,
}

fn recent_call_rows(
    conn: &Connection,
    organization_id: Option<&str>,
    limit: usize,
    now: DateTime<Utc>,
) -> Result<Vec<RecentCallRow>, String> {
    let cutoff = (now - chrono::Duration::days(CALL_LOG_RETENTION_DAYS))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let limit = limit.clamp(1, RECENT_CALLS_MAX_LIMIT) as i64;
    // A row past the retention is not shown even before the daily pass has
    // deleted it. `strftime` reads both time formats the column has held.
    let mut statement = conn
        .prepare(
            "SELECT id, caller_number, customer_id, action_taken,
                    strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
               FROM caller_id_log
              WHERE julianday(created_at) >= julianday(?1)
                AND (?2 IS NULL OR organization_id IS NULL OR organization_id = ?2)
              ORDER BY julianday(created_at) DESC, rowid DESC
              LIMIT ?3",
        )
        .map_err(|e| format!("read caller_id_log: {e}"))?;
    let rows = statement
        .query_map(params![cutoff, organization_id, limit], |row| {
            Ok(RecentCallRow {
                id: row.get(0)?,
                caller_number: row.get(1)?,
                customer_id: row.get(2)?,
                action_taken: row.get(3)?,
                occurred_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("read caller_id_log: {e}"))?;
    rows.collect::<Result<_, _>>()
        .map_err(|e| format!("read caller_id_log: {e}"))
}

/// The call a customer search belonged to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallRef<'a> {
    /// A search opened from the staff list names the row.
    Row(&'a str),
    /// A search the popup opened names the call as the event did.
    Call {
        number: &'a str,
        occurred_at: DateTime<Utc>,
    },
}

/// Marks one call as having led to an order, and keeps the customer staff
/// chose. `false` when the till holds no such call: the call was never
/// recorded, or its row has expired. Nothing else in the row changes.
pub(crate) fn mark_order_started(
    conn: &Connection,
    call: CallRef<'_>,
    customer_id: Option<&str>,
) -> Result<bool, String> {
    let row_id = match call {
        CallRef::Row(id) => Some(id.to_string()),
        CallRef::Call {
            number,
            occurred_at,
        } => {
            let key = crate::commands::customers::caller_id_phone_key(number);
            if key.len() < 3 {
                return Ok(false);
            }
            let mut statement = conn
                .prepare(
                    "SELECT id, caller_number FROM caller_id_log
                      WHERE abs(julianday(created_at) - julianday(?1)) * 86400.0 <= ?2
                      ORDER BY rowid DESC",
                )
                .map_err(|e| format!("read caller_id_log call: {e}"))?;
            let candidates = statement
                .query_map(
                    params![
                        occurred_at.to_rfc3339_opts(SecondsFormat::Millis, true),
                        SAME_CALL_TOLERANCE_SECONDS
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(|e| format!("read caller_id_log call: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("read caller_id_log call: {e}"))?;
            candidates
                .into_iter()
                .find(|(_, stored)| crate::commands::customers::caller_id_phone_key(stored) == key)
                .map(|(id, _)| id)
        }
    };
    let Some(row_id) = row_id else {
        return Ok(false);
    };
    let changed = conn
        .execute(
            "UPDATE caller_id_log
                SET action_taken = ?2,
                    customer_id = COALESCE(?3, customer_id)
              WHERE id = ?1",
            params![row_id, ACTION_ORDER_STARTED, customer_id],
        )
        .map_err(|e| format!("mark caller_id_log order: {e}"))?;
    Ok(changed > 0)
}

/// [`mark_order_started`] for what the renderer sends: `callId` for a search
/// opened from the list, or `number` with `occurredAt` for a popup's search,
/// and the chosen `customerId` when there is one. A payload that names no
/// call marks nothing.
pub(crate) fn record_order_started(
    db: &DbState,
    payload: &serde_json::Value,
) -> Result<bool, String> {
    let text = |key: &str| {
        payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= MAX_REFERENCE_LENGTH)
    };
    let occurred_at = text("occurredAt")
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let call = match (text("callId"), text("number"), occurred_at) {
        (Some(id), _, _) => CallRef::Row(id),
        (None, Some(number), Some(occurred_at)) => CallRef::Call {
            number,
            occurred_at,
        },
        _ => return Ok(false),
    };
    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
    mark_order_started(&conn, call, text("customerId"))
}

/// Starts the daily purge. It runs whether or not Caller ID is active: rows
/// must expire after the plugin is switched off too.
pub(crate) fn start_purge_worker(app_handle: tauri::AppHandle, cancel: CancellationToken) {
    tauri::async_runtime::spawn(run_purge_loop(
        move || {
            let app = app_handle.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    let Some(db) = app.try_state::<DbState>() else {
                        return Err("the database is not ready".to_string());
                    };
                    let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                    purge_expired(&conn, Utc::now())
                })
                .await
                .map_err(|e| format!("purge task: {e}"))?
            }
        },
        CALL_LOG_PURGE_INTERVAL,
        cancel,
    ));
}

async fn run_purge_loop<P, F>(purge: P, period: Duration, cancel: CancellationToken)
where
    P: Fn() -> F,
    F: std::future::Future<Output = Result<usize, String>>,
{
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = ticker.tick() => match purge().await {
                Ok(0) => {}
                Ok(rows_deleted) => info!(rows_deleted, "Expired Caller ID call records deleted"),
                Err(error) => warn!(error = %error, "Caller ID call record purge failed"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::harness::TestDb;
    use serde_json::json;

    fn call(id: &str, number: Option<&str>, presentation: Presentation) -> CallLogEntry {
        CallLogEntry {
            provider_event_id: id.into(),
            caller_number: number.map(str::to_string),
            presentation,
            occurred_at: DateTime::parse_from_rfc3339("2026-11-23T18:40:00.250Z")
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        String,
    );

    fn rows(db: &TestDb) -> Vec<Row> {
        let conn = db.state.conn.lock().unwrap();
        let mut statement = conn
            .prepare(
                "SELECT caller_number, caller_name, customer_id, customer_name, sip_call_id,
                        action_taken, organization_id, created_at
                   FROM caller_id_log ORDER BY rowid",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .unwrap();
        rows.collect::<Result<_, _>>().unwrap()
    }

    fn seed_store(db: &TestDb) {
        let conn = db.state.conn.lock().unwrap();
        db::set_setting(&conn, "terminal", "organization_id", "your-test-org").unwrap();
        db::set_setting(
            &conn,
            "local",
            "customer_cache_v1",
            &json!([
                {"id": "customer-1", "name": "PrivCustomerQuokka", "phone": "+30 210 123 4567"},
                {"id": "customer-2", "name": "Other", "phone": "6971234567"}
            ])
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    #[serial_test::serial]
    fn a_call_leaves_one_row_with_its_time_number_customer_and_organisation() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = TestDb::open();
        seed_store(&db);

        record_call(
            &db.state,
            &call("known@ht813", Some("2101234567"), Presentation::Allowed),
        )
        .unwrap();
        record_call(
            &db.state,
            &call("stranger@ht813", Some("2310555000"), Presentation::Allowed),
        )
        .unwrap();
        record_call(
            &db.state,
            &call("private@ht813", None, Presentation::Restricted),
        )
        .unwrap();
        record_call(
            &db.state,
            &call("silent@ht813", None, Presentation::Unknown),
        )
        .unwrap();
        // The same event again is the same row, not a second call.
        record_call(
            &db.state,
            &call("known@ht813", Some("2101234567"), Presentation::Allowed),
        )
        .unwrap();

        let rows = rows(&db);
        assert_eq!(rows.len(), 4);
        let (number, name, customer_id, customer_name, key, action, organization, at) = &rows[0];
        assert_eq!(number, "2101234567");
        assert_eq!(customer_id.as_deref(), Some("customer-1"));
        // No copy of a name, the caller's or the customer's.
        assert_eq!((name, customer_name), (&None, &None));
        assert_eq!(action, ACTION_DETECTED);
        assert_eq!(organization.as_deref(), Some("your-test-org"));
        assert_eq!(at, "2026-11-23T18:40:00.250Z");
        // The key is a digest: the device's own Call-ID text is not stored.
        assert!(key.starts_with("call-") && key.len() == 37, "{key}");
        assert!(!key.contains("ht813") && !key.contains("known"));

        assert_eq!((rows[1].0.as_str(), &rows[1].2), ("2310555000", &None));
        assert_eq!((rows[2].0.as_str(), &rows[2].2), (RESTRICTED_NUMBER, &None));
        assert_eq!((rows[3].0.as_str(), &rows[3].2), (UNKNOWN_NUMBER, &None));
        let keys: std::collections::HashSet<_> = rows.iter().map(|row| row.4.clone()).collect();
        assert_eq!(keys.len(), 4);
    }

    fn utc(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn call_at(
        id: &str,
        number: Option<&str>,
        presentation: Presentation,
        at: &str,
    ) -> CallLogEntry {
        CallLogEntry {
            occurred_at: utc(at),
            ..call(id, number, presentation)
        }
    }

    fn set_directory(db: &TestDb, customers: serde_json::Value) {
        let conn = db.state.conn.lock().unwrap();
        db::set_setting(&conn, "local", "customer_cache_v1", &customers.to_string()).unwrap();
    }

    #[test]
    #[serial_test::serial]
    fn the_staff_list_reads_the_newest_calls_and_names_them_from_the_directory_as_it_is_now() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = TestDb::open();
        seed_store(&db);
        let now = utc("2026-11-23T20:00:00Z");
        for entry in [
            call_at(
                "a@ht813",
                Some("2101234567"),
                Presentation::Allowed,
                "2026-11-23T19:47:00.000Z",
            ),
            call_at(
                "b@ht813",
                Some("2310555000"),
                Presentation::Allowed,
                "2026-11-23T19:50:00.000Z",
            ),
            call_at(
                "c@ht813",
                None,
                Presentation::Restricted,
                "2026-11-23T19:55:00.000Z",
            ),
            call_at(
                "d@ht813",
                None,
                Presentation::Unknown,
                "2026-11-22T12:00:00.000Z",
            ),
        ] {
            record_call(&db.state, &entry).unwrap();
        }
        {
            let conn = db.state.conn.lock().unwrap();
            for (id, created_at, organization) in [
                // Past the retention, not yet deleted by the daily pass.
                ("expired", "2026-10-01T10:00:00.000Z", Some("your-test-org")),
                // Another organisation's row cannot be on this till's list.
                ("foreign", "2026-11-23T19:59:00.000Z", Some("another-org")),
                // The column default and the older writer used this text.
                ("legacy", "2026-11-23 19:58:00", None),
            ] {
                conn.execute(
                    "INSERT INTO caller_id_log
                        (id, caller_number, sip_call_id, organization_id, created_at)
                     VALUES (?1, '6971234567', ?1, ?3, ?2)",
                    params![id, created_at, organization],
                )
                .unwrap();
            }
        }

        let calls = recent_calls(&db.state, 50, now).unwrap();
        let shown: Vec<(&str, &str, Option<&str>, Option<&str>)> = calls
            .iter()
            .map(|call| {
                (
                    call.occurred_at.as_str(),
                    call.presentation,
                    call.number.as_deref(),
                    call.customer_name.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            [
                (
                    "2026-11-23T19:58:00.000Z",
                    "allowed",
                    Some("6971234567"),
                    Some("Other")
                ),
                ("2026-11-23T19:55:00.000Z", "restricted", None, None),
                (
                    "2026-11-23T19:50:00.000Z",
                    "allowed",
                    Some("2310555000"),
                    None
                ),
                (
                    "2026-11-23T19:47:00.000Z",
                    "allowed",
                    Some("2101234567"),
                    Some("PrivCustomerQuokka")
                ),
                ("2026-11-22T12:00:00.000Z", "unknown", None, None),
            ]
        );
        assert_eq!(calls[3].customer_id.as_deref(), Some("customer-1"));
        assert!(calls.iter().all(|call| !call.order_started));
        // The newest only, when the list asks for fewer.
        assert_eq!(recent_calls(&db.state, 2, now).unwrap(), calls[..2]);

        // The row holds no name: a renamed customer reads with the new name,
        // and one who left the directory reads as a number.
        let named_rows: i64 = db
            .state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM caller_id_log
                  WHERE caller_name IS NOT NULL OR customer_name IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(named_rows, 0);
        set_directory(
            &db,
            json!([{"id": "customer-1", "name": "Νέο Όνομα", "phone": "2101234567"}]),
        );
        let renamed = recent_calls(&db.state, 50, now).unwrap();
        assert_eq!(renamed[3].customer_name.as_deref(), Some("Νέο Όνομα"));
        assert_eq!(
            (
                renamed[0].customer_id.as_deref(),
                renamed[0].customer_name.as_deref()
            ),
            (None, None)
        );
        set_directory(&db, json!([]));
        let emptied = recent_calls(&db.state, 50, now).unwrap();
        assert!(emptied
            .iter()
            .all(|call| call.customer_id.is_none() && call.customer_name.is_none()));
        assert_eq!(emptied[3].number.as_deref(), Some("2101234567"));

        // What the renderer receives.
        let wire = serde_json::to_value(&calls[3]).unwrap();
        let mut keys: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "customerId",
                "customerName",
                "id",
                "number",
                "occurredAt",
                "orderStarted",
                "presentation"
            ]
        );
    }

    #[test]
    #[serial_test::serial]
    fn going_on_to_an_order_marks_that_call_and_nothing_else() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = TestDb::open();
        seed_store(&db);
        let now = utc("2026-11-23T20:00:00Z");
        let first = call_at(
            "first@ht813",
            Some("2101234567"),
            Presentation::Allowed,
            "2026-11-23T18:40:00.250Z",
        );
        let second = call_at(
            "second@ht813",
            Some("2101234567"),
            Presentation::Allowed,
            "2026-11-23T19:10:00.000Z",
        );
        let stranger = call_at(
            "stranger@ht813",
            Some("2310555000"),
            Presentation::Allowed,
            "2026-11-23T19:10:00.300Z",
        );
        for entry in [&first, &second, &stranger] {
            record_call(&db.state, entry).unwrap();
        }
        let started = |db: &TestDb| -> Vec<(String, Option<String>, bool)> {
            let mut calls = recent_calls(&db.state, 50, now).unwrap();
            calls.reverse();
            calls
                .into_iter()
                .map(|call| (call.number.unwrap(), call.customer_id, call.order_started))
                .collect()
        };

        // The popup's search names the call by its number, as the device or
        // the staff wrote it, and by the event's own time.
        assert!(record_order_started(
            &db.state,
            &json!({"number": "+30 210 123 4567", "occurredAt": "2026-11-23T19:10:00.000Z", "customerId": "customer-2"}),
        )
        .unwrap());
        assert_eq!(
            started(&db),
            [
                (
                    "2101234567".to_string(),
                    Some("customer-1".to_string()),
                    false
                ),
                // The customer staff chose, not the one the number matched.
                (
                    "2101234567".to_string(),
                    Some("customer-2".to_string()),
                    true
                ),
                ("2310555000".to_string(), None, false),
            ]
        );

        // The same call reported again does not undo the mark or the choice.
        record_call(&db.state, &second).unwrap();
        assert_eq!(
            started(&db)[1],
            (
                "2101234567".to_string(),
                Some("customer-2".to_string()),
                true
            )
        );
        assert_eq!(rows(&db).len(), 3);

        // A search opened from the list names the row. No customer chosen:
        // the row keeps what it had.
        let first_row = recent_calls(&db.state, 50, now).unwrap()[2].id.clone();
        assert!(record_order_started(&db.state, &json!({"callId": first_row})).unwrap());
        assert_eq!(
            started(&db)[0],
            (
                "2101234567".to_string(),
                Some("customer-1".to_string()),
                true
            )
        );

        // Nothing the till does not hold is marked, and nothing is an error.
        for payload in [
            json!({"callId": "no-such-row"}),
            json!({"number": "2101234567", "occurredAt": "2026-11-23T19:10:05.000Z"}),
            json!({"number": "6999999999", "occurredAt": "2026-11-23T19:10:00.000Z"}),
            json!({"number": "21", "occurredAt": "2026-11-23T19:10:00.000Z"}),
            json!({"number": "2310555000"}),
            json!({"number": "2310555000", "occurredAt": "yesterday"}),
            json!({"callId": "x".repeat(MAX_REFERENCE_LENGTH + 1)}),
            json!({"customerId": "customer-1"}),
            json!({}),
            serde_json::Value::Null,
            json!("2310555000"),
        ] {
            assert!(
                !record_order_started(&db.state, &payload).unwrap(),
                "{payload}"
            );
        }
        assert_eq!(started(&db)[2], ("2310555000".to_string(), None, false));
        // Time, number and key of every row are as they were written.
        let rows = rows(&db);
        assert_eq!(rows[0].7, "2026-11-23T18:40:00.250Z");
        assert_eq!(rows[1].0, "2101234567");
        assert_eq!(rows[1].5, ACTION_ORDER_STARTED);
        assert_eq!(rows[2].5, ACTION_DETECTED);
    }

    #[test]
    #[serial_test::serial]
    fn a_failed_write_is_an_error_for_the_caller_to_log_never_a_panic() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = TestDb::open();
        db.state
            .conn
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE caller_id_log")
            .unwrap();
        let error = record_call(
            &db.state,
            &call("lost@ht813", Some("2101234567"), Presentation::Allowed),
        )
        .unwrap_err();
        assert!(error.contains("caller_id_log"), "{error}");
        // SQLite's text only: the number is not in the warning the till logs.
        assert!(!error.contains("2101234567"));
    }

    #[test]
    fn rows_expire_after_thirty_days_whatever_their_time_format() {
        let db = TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let now = DateTime::parse_from_rfc3339("2026-11-23T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        for (id, created_at) in [
            ("fresh", "2026-11-23T11:59:00.000Z"),
            ("day-29", "2026-10-25T13:00:00.000Z"),
            ("day-30-kept", "2026-10-24T12:00:00.001Z"),
            ("day-30-gone", "2026-10-24T11:59:59.000Z"),
            // The column default and the older SIP writer used this text.
            ("legacy-kept", "2026-11-01 08:00:00"),
            ("legacy-gone", "2026-10-01 08:00:00"),
            ("damaged", "not a time"),
        ] {
            conn.execute(
                "INSERT INTO caller_id_log (id, caller_number, sip_call_id, created_at)
                 VALUES (?1, '2101234567', ?1, ?2)",
                params![id, created_at],
            )
            .unwrap();
        }
        assert_eq!(purge_expired(&conn, now).unwrap(), 3);
        let mut statement = conn
            .prepare("SELECT id FROM caller_id_log ORDER BY id")
            .unwrap();
        let kept: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(kept, ["day-29", "day-30-kept", "fresh", "legacy-kept"]);
        assert_eq!(purge_expired(&conn, now).unwrap(), 0);
    }

    #[test]
    fn an_erased_customer_takes_their_calls_with_them() {
        let db = TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        for (id, number, customer) in [
            ("matched", "2101234567", Some("customer-1")),
            ("same-number-before-the-card", "+302101234567", None),
            ("second-number", "6971234567", None),
            ("someone-else", "2310555000", Some("customer-2")),
            ("private", RESTRICTED_NUMBER, None),
        ] {
            conn.execute(
                "INSERT INTO caller_id_log (id, caller_number, customer_id, sip_call_id, created_at)
                 VALUES (?1, ?2, ?3, ?1, '2026-11-23T10:00:00.000Z')",
                params![id, number, customer],
            )
            .unwrap();
        }
        let national = |value: &str| {
            let digits: String = value.chars().filter(char::is_ascii_digit).collect();
            digits.strip_prefix("30").unwrap_or(&digits).to_string()
        };
        let deleted = forget_customer(
            &conn,
            "customer-1",
            &[
                "2101234567".to_string(),
                "6971234567".to_string(),
                "".to_string(),
            ],
            national,
        )
        .unwrap();
        assert_eq!(deleted, 3);
        let mut statement = conn
            .prepare("SELECT id FROM caller_id_log ORDER BY id")
            .unwrap();
        let kept: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(kept, ["private", "someone-else"]);
    }

    #[tokio::test]
    async fn the_queue_never_waits_and_a_full_queue_costs_rows_only() {
        let written = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let gate = Arc::new(std::sync::Mutex::new(()));
        let held = gate.lock().unwrap();
        let (sink, writer) = call_log_queue(2, {
            let written = Arc::clone(&written);
            let gate = Arc::clone(&gate);
            move |entry: CallLogEntry| {
                // Stands for a database mutex someone else holds.
                let _wait = gate.lock().unwrap();
                written.lock().unwrap().push(entry.provider_event_id);
            }
        });
        let writer = tokio::spawn(writer);

        // The writer is stuck on the first row; offering never blocks.
        let started = std::time::Instant::now();
        for index in 0..10 {
            sink.offer(call(&format!("call-{index}"), None, Presentation::Unknown));
            tokio::task::yield_now().await;
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(written.lock().unwrap().is_empty());

        drop(held);
        drop(sink);
        writer.await.unwrap();
        let written = written.lock().unwrap();
        // In order, the first always, and never more than the queue held.
        assert_eq!(written.first().map(String::as_str), Some("call-0"));
        assert!(written.len() >= 2 && written.len() <= 4, "{written:?}");
        let mut sorted = written.clone();
        sorted.sort_by_key(|id| id["call-".len()..].parse::<usize>().unwrap());
        assert_eq!(*written, sorted);
    }

    #[tokio::test]
    async fn the_purge_runs_at_start_then_every_period_until_cancelled() {
        assert_eq!(CALL_LOG_PURGE_INTERVAL, Duration::from_secs(24 * 60 * 60));
        assert_eq!(CALL_LOG_RETENTION_DAYS, 30);

        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let worker = tokio::spawn(run_purge_loop(
            {
                let runs = Arc::clone(&runs);
                move || {
                    let run = runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // A failed pass does not end the worker.
                    async move {
                        if run == 1 {
                            Err("database is locked".to_string())
                        } else {
                            Ok(run)
                        }
                    }
                }
            },
            Duration::from_millis(10),
            cancel.clone(),
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while runs.load(std::sync::atomic::Ordering::SeqCst) < 4 {
            assert!(std::time::Instant::now() < deadline, "the purge stopped");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(10), worker)
            .await
            .expect("the purge worker ends when cancelled")
            .unwrap();
    }
}
