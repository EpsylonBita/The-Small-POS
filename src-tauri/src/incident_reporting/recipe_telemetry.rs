//! Privacy-limited durable recipe events on the incident transport.
use crate::db::DbState;
use serde_json::Value;
use std::{future::Future, sync::Arc};

pub async fn flush_recipe_telemetry(db: Arc<DbState>, online: bool) -> Result<(), String> {
    // This lifecycle lease owns no mutex and reads no credentials. Rebinding
    // cannot change the authenticated till between scope checking and send.
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    flush_with(db.clone(), online, |event| {
        let db = db.clone();
        async move {
            crate::admin_fetch(Some(&db), "/api/pos/incidents/report", "POST", Some(event))
                .await
                .map(|value| value["success"] != false)
        }
    })
    .await
}
use crate::support::{contracts, identity, remedies};
use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

const HOUR_MS: i64 = 3_600_000;
const STATE_CATEGORY: &str = "diagnostics";
// Drift-tested against each shared Windows matcher. These codes describe the
// match, never an actor or target, and follow Android's fingerprintOf encoding.
const RECIPE_ISSUES: &[(&str, &str)] = &[
    (
        "printer.restore_last_known_brand",
        "printer.brand_probe_unanswered",
    ),
    (
        "checkout-payment-blocker.open-payment",
        "checkout_payment_blocker",
    ),
    ("payment-total-conflict.repair", "payment_total_conflict"),
    (
        "invalid-driver-order-update.repair",
        "order_invalid_driver_update",
    ),
    (
        "order-update-replay-blockers.repair",
        "order_update_replay_blocked",
    ),
    ("catalog-availability.retry", "catalog_availability_retry"),
    (
        "legacy-financial-parity-orphans.bulk-clear",
        "legacy_financial_parity_orphans_bulk",
    ),
    (
        "platform-settlement-mismatch.void-drawer-and-settle",
        "platform_settlement_mismatch",
    ),
    (
        "platform-settlement-missing.settle-from-disposition",
        "platform_settlement_missing",
    ),
    (
        "duplicate-customer-conflict.adopt-server-record",
        "duplicate_customer_conflict",
    ),
    (
        "customer-address-default-conflict.repair",
        "customer_address_default_conflict",
    ),
    (
        "customer-address-default.retry",
        "CUSTOMER_ADDRESS_DEFAULT_CONFLICT",
    ),
    ("syncNow", "sync_stuck"),
    ("printerReprobe", "printer_unavailable"),
    ("testPrint", "printer_unavailable"),
];
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Outbox {
    cursor: i64,
    entries: Vec<Queued>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Queued {
    event: Value,
    hour: i64,
    audit_rowid: i64,
    sent: bool,
    failures: u32,
    next: i64,
}
fn scope_key(conn: &Connection) -> Result<String, String> {
    let scope = identity::local(conn)?;
    Ok(format!(
        "recipe_telemetry.{}",
        contracts::payload_hash(&json!([
            scope.organization_id,
            scope.branch_id,
            scope.terminal_id
        ]))
    ))
}
fn read_outbox(conn: &Connection, key: &str) -> Result<Outbox, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT setting_value FROM local_settings WHERE setting_category=?1 AND setting_key=?2",
            [STATE_CATEGORY, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?;
    // Malformed storage never erases an offline buffer or deduplication claim.
    let state: Outbox = raw
        .map(|value| serde_json::from_str(&value).map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE"))
        .transpose()?
        .unwrap_or_default();
    for entry in &state.entries {
        validate_event(&entry.event)?;
        if entry.audit_rowid < 1 || entry.next < 0 || state.cursor < 0 {
            return Err("RECIPE_OUTBOX_UNAVAILABLE".into());
        }
    }
    Ok(state)
}
fn validate_event(event: &Value) -> Result<(), String> {
    const FIELDS: [&str; 9] = [
        "event",
        "recipe_id",
        "recipe_version",
        "platform",
        "app_version",
        "mode",
        "outcome",
        "match_fingerprint",
        "occurred_at",
    ];
    let object = event.as_object().ok_or("RECIPE_OUTBOX_UNAVAILABLE")?;
    let id = event["recipe_id"].as_str().unwrap_or("");
    let fingerprint = event["match_fingerprint"].as_str().unwrap_or("");
    let app = event["app_version"].as_str().unwrap_or("");
    if object.len() != FIELDS.len()
        || !FIELDS.iter().all(|key| object.contains_key(*key))
        || event["event"] != "recipe_applied"
        || event["platform"] != "windows"
        || id.is_empty()
        || id.len() > 200
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        || !event["recipe_version"].as_u64().is_some_and(|v| v > 0)
        || app.is_empty()
        || app.len() > 120
        || !matches!(event["mode"].as_str(), Some("auto" | "one_tap"))
        || !matches!(
            event["outcome"].as_str(),
            Some("resolved" | "failed" | "pending" | "unknown")
        )
        || fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !event["occurred_at"]
            .as_str()
            .is_some_and(|at| DateTime::parse_from_rfc3339(at).is_ok())
    {
        return Err("RECIPE_OUTBOX_UNAVAILABLE".into());
    }
    Ok(())
}
fn write_outbox(conn: &Connection, key: &str, state: &Outbox) -> Result<(), String> {
    crate::db::set_setting(
        conn,
        STATE_CATEGORY,
        key,
        &serde_json::to_string(state).map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?,
    )
}
fn event_time(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|at| at.and_utc())
        })
}
fn collect(conn: &Connection, key: &str) -> Result<Outbox, String> {
    let scope = identity::local(conn)?;
    if scope_key(conn)? != key {
        return Err("PAYLOAD_DRIFT".into());
    }
    let mut state = read_outbox(conn, key)?;
    // New rows are bounded per tick. Retain each unsent aggregate's latest audit
    // row too: the native automatic recipe verifies by updating its own audit.
    let mut rowids: std::collections::BTreeSet<i64> = state
        .entries
        .iter()
        .filter(|e| !e.sent || matches!(e.event["outcome"].as_str(), Some("pending" | "unknown")))
        .map(|e| e.audit_rowid)
        .collect();
    let mut ids = conn
        .prepare("SELECT rowid FROM recovery_action_log WHERE rowid>?1 ORDER BY rowid LIMIT 500")
        .map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?;
    let new = ids
        .query_map([state.cursor], |row| row.get::<_, i64>(0))
        .map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?;
    if let Some(last) = new.last() {
        state.cursor = *last;
    }
    rowids.extend(new);
    for rowid in rowids {
        let previously_scoped = state.entries.iter().any(|entry| entry.audit_rowid == rowid);
        let row: Option<(String, u32, String, String, String)> = conn.query_row(
            "SELECT recipe_id,recipe_version,action_id,json_extract(payload_json,'$.outcome'),COALESCE(json_extract(payload_json,'$.verifiedAt'),created_at) FROM recovery_action_log a WHERE rowid=?1 AND recipe_id IS NOT NULL AND recipe_version IS NOT NULL AND json_valid(payload_json) AND json_extract(payload_json,'$.outcome') IN ('resolved','failed','pending','unknown') AND (json_extract(payload_json,'$.organizationId')=?2 OR EXISTS(SELECT 1 FROM parity_sync_queue q WHERE q.organization_id=?2 AND q.id=a.entity_id) OR ?5) AND (json_extract(payload_json,'$.branchId') IS NULL OR json_extract(payload_json,'$.branchId')=?3) AND (json_extract(payload_json,'$.terminalId') IS NULL OR json_extract(payload_json,'$.terminalId')=?4)",
            rusqlite::params![rowid,scope.organization_id,scope.branch_id,scope.terminal_id,previously_scoped],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional().map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?;
        let Some((id, version, action, outcome, raw_at)) = row else {
            continue;
        };
        let Some(recipe) = remedies::shipped()
            .iter()
            .find(|recipe| recipe.id == id && recipe.version == version)
        else {
            continue;
        };
        let Some((_, issue_code)) = RECIPE_ISSUES.iter().find(|(recipe_id, _)| *recipe_id == id)
        else {
            continue;
        };
        let Some(at) = event_time(&raw_at) else {
            continue;
        };
        let hour = at.timestamp_millis().div_euclid(HOUR_MS);
        let event = json!({"event":"recipe_applied","recipe_id":recipe.id,"recipe_version":version,"platform":"windows",
            "app_version":env!("CARGO_PKG_VERSION"),"mode":if action == "auto_retry" {"auto"} else {"one_tap"},"outcome":outcome,
            "match_fingerprint":contracts::sha256(format!("windows|{}|[]|[]|[]", json!([issue_code])).as_bytes()),
            "occurred_at":at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        if let Some(existing) = state
            .entries
            .iter_mut()
            .find(|entry| entry.hour == hour && entry.event["recipe_id"] == id)
        {
            let latest = existing.event["occurred_at"].as_str().and_then(event_time);
            if !existing.sent && latest.is_some_and(|previous| at >= previous) {
                existing.event = event;
                existing.audit_rowid = rowid;
            }
        } else {
            state.entries.push(Queued {
                event,
                hour,
                audit_rowid: rowid,
                sent: false,
                failures: 0,
                next: 0,
            });
        }
    }
    write_outbox(conn, key, &state)?;
    Ok(state)
}
fn retry_delay(failures: u32) -> i64 {
    (300_000_i64 * (1_i64 << failures.saturating_sub(1).min(10))).min(HOUR_MS)
}
fn finish_send(
    conn: &Connection,
    key: &str,
    queued: &Queued,
    sent: bool,
    now: i64,
) -> Result<(), String> {
    if scope_key(conn)? != key {
        return Err("PAYLOAD_DRIFT".into());
    }
    let mut state = read_outbox(conn, key)?;
    if let Some(entry) = state.entries.iter_mut().find(|entry| {
        entry.hour == queued.hour && entry.event["recipe_id"] == queued.event["recipe_id"]
    }) {
        if sent {
            entry.sent = true;
        } else {
            entry.failures = entry.failures.saturating_add(1);
            entry.next = now + retry_delay(entry.failures);
        }
    }
    write_outbox(conn, key, &state)
}
async fn flush_with<F, Fut>(db: Arc<DbState>, online: bool, mut send: F) -> Result<(), String>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    static FLUSH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _flush = FLUSH.lock().await;
    let local = db.clone();
    let (key, state) = crate::database_lock::run_blocking_command(
        "recipe_telemetry_collect",
        move || -> Result<_, String> {
            let conn = local.conn.lock().map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?;
            let key = scope_key(&conn)?;
            let state = collect(&conn, &key)?;
            Ok((key, state))
        },
    )
    .await?;
    if !online {
        return Ok(());
    }
    let now = Utc::now().timestamp_millis();
    for entry in state
        .entries
        .into_iter()
        .filter(|entry| !entry.sent && entry.next <= now && entry.hour < now.div_euclid(HOUR_MS))
        .take(5)
    {
        let local = db.clone();
        let expected = key.clone();
        crate::database_lock::run_blocking_command(
            "recipe_telemetry_identity",
            move || -> Result<(), String> {
                let conn = local.conn.lock().map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?;
                if scope_key(&conn)? != expected {
                    return Err("PAYLOAD_DRIFT".into());
                }
                Ok(())
            },
        )
        .await?;
        // Only the nine allowlisted event fields cross the existing authenticated
        // transport. No database guard survives this await.
        let sent = send(entry.event.clone()).await.unwrap_or(false);
        let local = db.clone();
        let key = key.clone();
        crate::database_lock::run_blocking_command(
            "recipe_telemetry_complete",
            move || -> Result<(), String> {
                let conn = local.conn.lock().map_err(|_| "RECIPE_OUTBOX_UNAVAILABLE")?;
                finish_send(&conn, &key, &entry, sent, Utc::now().timestamp_millis())
            },
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixture() -> (crate::tests::harness::TestDb, Arc<DbState>) {
        let db = crate::tests::harness::TestDb::open();
        {
            let conn = db.state.conn.lock().unwrap();
            for (key, value) in [
                ("organization_id", "your-org"),
                ("branch_id", "your-branch"),
                ("terminal_id", "your-terminal"),
            ] {
                crate::db::set_setting(&conn, "terminal", key, value).unwrap();
            }
        }
        let reopened = crate::db::init(db.state.db_path.parent().unwrap()).unwrap();
        (db, Arc::new(reopened))
    }
    fn action(db: &DbState, id: &str, at: chrono::DateTime<chrono::Utc>, outcome: &str) {
        let conn = db.conn.lock().unwrap();
        let org = crate::db::get_setting(&conn, "terminal", "organization_id").unwrap();
        let payload = json!({"organizationId":org,"branchId":"your-branch","terminalId":"your-terminal","outcome":outcome,"actor":{"staffName":"private"},"targetRefs":{"customerId":"private"},"message":"private"});
        conn.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,recipe_id,recipe_version,success,payload_json,created_at) VALUES(?1,'restoreLastKnownPrinterBrand','printer.brand_probe_unanswered','printer.restore_last_known_brand',1,1,?2,?3)", rusqlite::params![id,payload.to_string(),at.to_rfc3339()]).unwrap();
    }

    #[tokio::test]
    async fn recipe_telemetry_fast_native_success_retains_scope_after_queue_deletion() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (_files, db) = fixture();
        let at = DateTime::from_timestamp_millis(
            (Utc::now().timestamp_millis().div_euclid(HOUR_MS) - 1) * HOUR_MS + 60_000,
        )
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            crate::sync_queue::tests::complete_automatic_address_retry_for_test(&conn);
            // Simulate this fast confirmation in a closed hour, before the
            // reporter has ever observed the intent or its now-deleted row.
            conn.execute("UPDATE recovery_action_log SET created_at=?1,payload_json=json_set(payload_json,'$.verifiedAt',?1)", [at.to_rfc3339()]).unwrap();
            let payload: String = conn
                .query_row(
                    "SELECT payload_json FROM recovery_action_log WHERE action_id='auto_retry'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let payload: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["organizationId"], "org-1");
            assert_eq!(payload["terminalId"], "terminal-test");
            assert_eq!(payload["outcome"], "resolved");
        }
        let sent = AtomicUsize::new(0);
        for _ in 0..2 {
            flush_with(db.clone(), true, |event| {
                assert!(db.conn.try_lock().is_ok());
                validate_event(&event).unwrap();
                assert_eq!(event["event"], "recipe_applied");
                assert_eq!(event["recipe_id"], "customer-address-default.retry");
                assert_eq!(event["recipe_version"], 1);
                assert_eq!(event["mode"], "auto");
                assert_eq!(event["outcome"], "resolved");
                assert_eq!(
                    event_time(event["occurred_at"].as_str().unwrap()).unwrap(),
                    at
                );
                assert_eq!(
                    event["match_fingerprint"],
                    contracts::sha256(b"windows|[\"CUSTOMER_ADDRESS_DEFAULT_CONFLICT\"]|[]|[]|[]")
                );
                for private in [
                    "org-1",
                    "terminal-test",
                    "Main St",
                    "cust-1",
                    "your-private-address",
                ] {
                    assert!(!event.to_string().contains(private));
                }
                sent.fetch_add(1, Ordering::Relaxed);
                async { Ok(true) }
            })
            .await
            .unwrap();
        }
        assert_eq!(sent.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn recipe_telemetry_replays_offline_closed_hours_once_without_writer_or_personal_data() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (_files, db) = fixture();
        let at = DateTime::from_timestamp_millis(
            (Utc::now().timestamp_millis().div_euclid(HOUR_MS) - 2) * HOUR_MS + 60_000,
        )
        .unwrap();
        action(&db, "your-first", at, "pending");
        action(
            &db,
            "your-verified",
            at + chrono::Duration::seconds(1),
            "resolved",
        );
        action(
            &db,
            "your-late-old-pending",
            at - chrono::Duration::seconds(1),
            "pending",
        );
        flush_with(db.clone(), false, |_| async {
            panic!("offline must buffer")
        })
        .await
        .unwrap();
        // Drop/reopen every connection: replay relies on SQLite, not a process map.
        let reopened = Arc::new(crate::db::init(db.db_path.parent().unwrap()).unwrap());
        let sent = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            flush_with(reopened.clone(), true, |event| {
                assert!(
                    reopened.conn.try_lock().is_ok(),
                    "business writer held while sending"
                );
                let fields = event.as_object().unwrap();
                assert_eq!(fields.len(), 9);
                for key in [
                    "event",
                    "recipe_id",
                    "recipe_version",
                    "platform",
                    "app_version",
                    "mode",
                    "outcome",
                    "match_fingerprint",
                    "occurred_at",
                ] {
                    assert!(fields.contains_key(key));
                }
                assert_eq!(event["outcome"], "resolved");
                assert_eq!(event["platform"], "windows");
                assert!(!event.to_string().contains("private"));
                assert_eq!(event["match_fingerprint"].as_str().unwrap().len(), 64);
                assert_eq!(
                    event["match_fingerprint"],
                    contracts::sha256(b"windows|[\"printer.brand_probe_unanswered\"]|[]|[]|[]")
                );
                sent.fetch_add(1, Ordering::Relaxed);
                async { Ok(true) }
            })
            .await
            .unwrap();
        }
        assert_eq!(sent.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn recipe_telemetry_backoff_doubles_and_corruption_preserves_claims() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (_files, db) = fixture();
        action(
            &db,
            "your-failed",
            Utc::now() - chrono::Duration::hours(2),
            "failed",
        );
        let conn = db.conn.lock().unwrap();
        let key = scope_key(&conn).unwrap();
        let state = collect(&conn, &key).unwrap();
        let queued = &state.entries[0];
        let mut contaminated = queued.event.clone();
        contaminated["actor"] = json!("private");
        assert!(validate_event(&contaminated).is_err());
        contaminated = queued.event.clone();
        contaminated["outcome"] = json!({"customer":"private"});
        assert!(validate_event(&contaminated).is_err());
        for (failures, delay) in [
            (1, 300_000),
            (2, 600_000),
            (3, 1_200_000),
            (4, 2_400_000),
            (5, 3_600_000),
            (6, 3_600_000),
        ] {
            finish_send(&conn, &key, queued, false, 1000).unwrap();
            let stored = read_outbox(&conn, &key).unwrap();
            assert_eq!(stored.entries[0].failures, failures);
            assert_eq!(stored.entries[0].next, 1000 + delay);
        }
        crate::db::set_setting(&conn, STATE_CATEGORY, &key, "invalid").unwrap();
        assert!(collect(&conn, &key).is_err());
        assert_eq!(
            crate::db::get_setting(&conn, STATE_CATEGORY, &key).as_deref(),
            Some("invalid")
        );
    }
    #[tokio::test]
    async fn recipe_telemetry_tracks_native_verification_and_never_sends_another_tills_buffer() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (_files, db) = fixture();
        action(
            &db,
            "your-pending",
            Utc::now() - chrono::Duration::hours(2),
            "pending",
        );
        flush_with(db.clone(), false, |_| async { panic!("offline") })
            .await
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.outcome','resolved') WHERE id='your-pending'", []).unwrap();
        }
        let sent = AtomicUsize::new(0);
        flush_with(db.clone(), true, |event| {
            assert_eq!(event["outcome"], "resolved");
            sent.fetch_add(1, Ordering::Relaxed);
            async { Ok(false) }
        })
        .await
        .unwrap();
        // Failure keeps the closed event and its doubling backoff after restart.
        flush_with(db.clone(), true, |_| async { panic!("backoff") })
            .await
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            crate::db::set_setting(&conn, "terminal", "terminal_id", "your-other-terminal")
                .unwrap();
        }
        flush_with(db.clone(), true, |_| async { panic!("another till") })
            .await
            .unwrap();
        assert_eq!(sent.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn recipe_telemetry_open_hour_never_sends() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (_files, db) = fixture();
        action(&db, "your-open", chrono::Utc::now(), "pending");
        flush_with(db, true, |_| async { panic!("open hour") })
            .await
            .unwrap();
    }

    #[test]
    fn recipe_telemetry_late_native_confirmation_uses_its_verification_hour() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (_files, db) = fixture();
        let now = Utc::now();
        action(
            &db,
            "your-late-verification",
            now - chrono::Duration::hours(4),
            "pending",
        );
        let conn = db.conn.lock().unwrap();
        let key = scope_key(&conn).unwrap();
        let state = collect(&conn, &key).unwrap();
        finish_send(&conn, &key, &state.entries[0], true, now.timestamp_millis()).unwrap();
        // The queue row may be gone by now. Its earlier durable claim already
        // established scope; no target data needs to be retained or transmitted.
        conn.execute("UPDATE recovery_action_log SET payload_json=json_set(json_remove(payload_json,'$.organizationId'),'$.outcome','resolved','$.verifiedAt',?1) WHERE id='your-late-verification'",
            [(now - chrono::Duration::hours(2)).to_rfc3339()]).unwrap();
        let state = collect(&conn, &key).unwrap();
        assert_eq!(state.entries.len(), 2);
        assert!(state.entries[0].sent);
        assert_eq!(state.entries[1].event["outcome"], "resolved");
        assert!(!state.entries[1].sent);
    }
}
