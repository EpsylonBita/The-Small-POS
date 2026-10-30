use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::warn;

use crate::{db, diagnostics};

const SETTINGS_CATEGORY: &str = "diagnostics";
const CRITICAL_SUPPRESS_MINUTES: i64 = 15;
const HIGH_SUPPRESS_MINUTES: i64 = 30;

// Network outages and incident clearance: the Rust copy of
// shared/pos/health/network-outage.ts, pinned to the same vectors
// (shared/pos/health/__fixtures__/network-outage-vectors.json) so both POS apps
// decide the same way.
//
// Tomikro, 14/10/2026: this till paged HIGH network.offline_with_backlog
// (2 items waiting) while the server answered its order sync every 16 seconds;
// the report itself reached the server. Any two failed `/api/health` probes,
// even days apart (the consecutive counter never reset), were enough, and the
// server kept the incident open for ever.

/// network.offline_with_backlog pages only after a continuous outage this long.
pub(crate) const OFFLINE_INCIDENT_MIN_OUTAGE_MS: i64 = 10 * 60 * 1000;
/// Two failed probes further apart than this are not one outage: the till was
/// not watching in between (closed, asleep). A restart takes well under it.
const OUTAGE_EPISODE_MAX_SAMPLE_GAP_MS: i64 = 15 * 60 * 1000;
/// A reported fingerprint absent this many observations in a row has cleared.
const INCIDENT_CLEAR_OBSERVATIONS: i64 = 2;
/// After a failed clearance report, wait this long before the next attempt.
const INCIDENT_CLEAR_RETRY_MS: i64 = 5 * 60 * 1000;
/// A clearance the server never confirmed is given up after this.
const INCIDENT_CLEAR_GIVE_UP_MS: i64 = 24 * 60 * 60 * 1000;

const NETWORK_OFFLINE_ISSUE_CODE: &str = "network.offline_with_backlog";
const NETWORK_UNSTABLE_ISSUE_CODE: &str = "network.connection_unstable";

const NETWORK_OUTAGE_KEY: &str = "network_outage_episode";
const PENDING_OUTAGE_REPORT_KEY: &str = "network_outage_report_pending";
const OPEN_REPORTS_KEY: &str = "incident_open_reports";
const ACTIVE_FINGERPRINTS_KEY: &str = "incident_active_fingerprints";
const CONSECUTIVE_KEY_PREFIX: &str = "incident_consecutive.";
/// The fingerprint prefix used when the terminal id could not be read.
const UNKNOWN_TERMINAL_ID: &str = "unknown-terminal";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PosIncidentSeverity {
    Info,
    Warning,
    High,
    Critical,
}

impl PosIncidentSeverity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PosIncidentCandidate {
    pub issue_code: String,
    pub severity: PosIncidentSeverity,
    pub fingerprint: String,
    pub summary: String,
    pub evidence: Value,
    pub should_report: bool,
}

fn terminal_id_from_health(health: &Value) -> String {
    string_path(health, &["terminalContext", "terminalId"])
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| UNKNOWN_TERMINAL_ID.to_string())
}

pub fn manual_incident_candidate(health: &Value) -> PosIncidentCandidate {
    let terminal_id = terminal_id_from_health(health);
    let bucket = Utc::now().format("%Y%m%d%H").to_string();
    PosIncidentCandidate {
        issue_code: "manual.diagnostics_sent".to_string(),
        severity: PosIncidentSeverity::Warning,
        fingerprint: format!("{terminal_id}:manual.diagnostics_sent:{bucket}"),
        summary: "Manual diagnostics sent from the POS support screen.".to_string(),
        evidence: json!({
            "source": "operator_action",
            "remoteSafe": true,
        }),
        should_report: true,
    }
}

pub fn health_monitor_failed_candidate(
    terminal_id: Option<String>,
    error: &str,
) -> PosIncidentCandidate {
    let terminal_id = terminal_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown-terminal".to_string());
    PosIncidentCandidate {
        issue_code: "system.health_monitor_failed".to_string(),
        severity: PosIncidentSeverity::High,
        fingerprint: format!(
            "{}:system.health_monitor_failed:{}",
            terminal_id,
            normalize_error_class(error)
        ),
        summary: "The POS could not complete its local health check.".to_string(),
        evidence: json!({
            "errorClass": normalize_error_class(error),
        }),
        should_report: true,
    }
}

pub fn classify_incidents(health: &Value) -> Vec<PosIncidentCandidate> {
    let terminal_id = terminal_id_from_health(health);
    let mut incidents = Vec::new();

    let financial_failed =
        i64_path(health, &["financialQueueStatus", "totalFailed"]).max(i64_path(
            health,
            &["syncStatusSummary", "financialStats", "totalFailed"],
        ));
    let failed_payment_items = i64_path(health, &["financialQueueStatus", "failedPaymentItems"])
        .max(i64_path(
            health,
            &["syncStatusSummary", "financialStats", "failedPaymentItems"],
        ));
    if financial_failed > 0 {
        let error_class = string_path(
            health,
            &["syncStatusSummary", "lastQueueFailure", "classification"],
        )
        .or_else(|| string_path(health, &["syncStatusSummary", "lastQueueFailure", "error"]))
        .map(|value| normalize_error_class(&value))
        .unwrap_or_else(|| "financial_queue_failed".to_string());
        incidents.push(PosIncidentCandidate {
            issue_code: "sync.failed_financial_queue".to_string(),
            severity: PosIncidentSeverity::Critical,
            fingerprint: format!("{terminal_id}:sync.failed_financial_queue:{error_class}"),
            summary: format!(
                "Financial sync failed with {financial_failed} failed item{}.",
                if financial_failed == 1 { "" } else { "s" }
            ),
            evidence: json!({
                "totalFailed": financial_failed,
                "failedPaymentItems": failed_payment_items,
                "errorClass": error_class,
            }),
            should_report: true,
        });
    }

    let sync_errors = i64_path(health, &["syncStatusSummary", "syncErrors"]);
    let sync_error_text = string_path(health, &["syncStatusSummary", "error"]);
    if sync_errors > 0
        || sync_error_text
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        let error_class = sync_error_text
            .as_deref()
            .map(normalize_error_class)
            .unwrap_or_else(|| "sync_queue_failed_items".to_string());
        incidents.push(PosIncidentCandidate {
            issue_code: "sync.active_error".to_string(),
            severity: PosIncidentSeverity::High,
            fingerprint: format!("{terminal_id}:sync.active_error:{error_class}"),
            summary: "The POS has sync errors that need support review.".to_string(),
            evidence: json!({
                "syncErrors": sync_errors,
                "errorClass": error_class,
            }),
            should_report: true,
        });
    }

    let blocker_count = array_len_path(health, &["syncBlockerDetails"]);
    let parity_failed = i64_path(health, &["parityQueueStatus", "failed"]);
    let parity_conflicts = i64_path(health, &["parityQueueStatus", "conflicts"]);
    let pending_backlog = backlog_total(health);
    if blocker_count > 0 || parity_failed > 0 || parity_conflicts > 0 || pending_backlog >= 50 {
        let error_class = if blocker_count > 0 {
            "sync_blocker_details"
        } else if parity_conflicts > 0 {
            "parity_conflicts"
        } else if parity_failed > 0 {
            "parity_failed"
        } else {
            "large_backlog"
        };
        incidents.push(PosIncidentCandidate {
            issue_code: "sync.blocked_backlog".to_string(),
            severity: PosIncidentSeverity::High,
            fingerprint: format!("{terminal_id}:sync.blocked_backlog:{error_class}"),
            summary: "Some saved POS data is waiting and may need support review.".to_string(),
            evidence: json!({
                "blockerCount": blocker_count,
                "parityFailed": parity_failed,
                "parityConflicts": parity_conflicts,
                "pendingBacklog": pending_backlog,
                "errorClass": error_class,
            }),
            should_report: true,
        });
    }

    let invalid_orders = i64_path(health, &["invalidOrders", "count"]);
    if invalid_orders > 0 {
        incidents.push(PosIncidentCandidate {
            issue_code: "sync.invalid_orders".to_string(),
            severity: PosIncidentSeverity::Critical,
            fingerprint: format!("{terminal_id}:sync.invalid_orders:pending_order_validation"),
            summary: format!(
                "{invalid_orders} saved order{} need support review before syncing.",
                if invalid_orders == 1 { "" } else { "s" }
            ),
            evidence: json!({
                "invalidOrderCount": invalid_orders,
            }),
            should_report: true,
        });
    }

    let remote_auth_paused = bool_path(health, &["syncStatusSummary", "remoteAuthPaused"])
        || bool_path(health, &["lastParitySync", "remoteAuthPaused"]);
    if remote_auth_paused {
        let auth_class = string_path(health, &["syncStatusSummary", "remoteAuthCode"])
            .or_else(|| string_path(health, &["syncStatusSummary", "remoteAuthReason"]))
            .map(|value| normalize_error_class(&value))
            .unwrap_or_else(|| "remote_auth_paused".to_string());
        incidents.push(PosIncidentCandidate {
            issue_code: "sync.remote_auth_paused".to_string(),
            severity: PosIncidentSeverity::High,
            fingerprint: format!("{terminal_id}:sync.remote_auth_paused:{auth_class}"),
            summary:
                "The POS paused remote sync because terminal authentication needs support review."
                    .to_string(),
            evidence: json!({
                "remoteAuthPaused": true,
                "authClass": auth_class,
            }),
            should_report: true,
        });
    }

    let panic_count = i64_path(health, &["panicCount"]);
    if panic_count > 0 {
        incidents.push(PosIncidentCandidate {
            issue_code: "system.panic_detected".to_string(),
            severity: PosIncidentSeverity::Critical,
            fingerprint: format!("{terminal_id}:system.panic_detected:panic_count_present"),
            summary: "The POS detected a recent app crash.".to_string(),
            evidence: json!({
                "panicCount": panic_count,
            }),
            should_report: true,
        });
    }

    let failed_printer_jobs = printer_failed_job_count(health);
    if failed_printer_jobs >= 3 {
        incidents.push(PosIncidentCandidate {
            issue_code: "printer.critical_failure".to_string(),
            severity: PosIncidentSeverity::High,
            fingerprint: format!("{terminal_id}:printer.critical_failure:recent_jobs_failed"),
            summary: "The receipt printer is not responding after several attempts.".to_string(),
            evidence: json!({
                "failedRecentJobs": failed_printer_jobs,
                "configured": bool_path(health, &["printerStatus", "configured"]),
            }),
            should_report: true,
        });
    }

    // A print queue can be broken WITHOUT anything failing. If a lane is wedged,
    // jobs are never even attempted: no attempt row, no error, status stays
    // 'pending' forever — so `printer.critical_failure` above, which counts
    // FAILED jobs, stays silent. A till printed nothing for fifteen hours while
    // this file reported it healthy. Age of the oldest pending job is the signal
    // that actually catches it.
    if let Some(stalled_minutes) = oldest_pending_print_job_age_minutes(health, Utc::now()) {
        if stalled_minutes >= PRINT_JOB_STALL_ALERT_MINUTES {
            incidents.push(PosIncidentCandidate {
                issue_code: "printer.jobs_not_printing".to_string(),
                severity: PosIncidentSeverity::High,
                fingerprint: format!("{terminal_id}:printer.jobs_not_printing:stalled_pending"),
                summary: "Receipts have been waiting to print and are not coming out.".to_string(),
                evidence: json!({
                    "oldestPendingMinutes": stalled_minutes,
                    "thresholdMinutes": PRINT_JOB_STALL_ALERT_MINUTES,
                    "configured": bool_path(health, &["printerStatus", "configured"]),
                }),
                should_report: true,
            });
        }
    }

    // A continuous 10-minute outage (`track_network_outage` measures it into
    // `networkOutage`) is HIGH, a shorter one a warning. Both stay on the till
    // while the outage lasts: a report that reached the server would prove it
    // over. A real one is reported once, after it (`recovered_outage_candidate`).
    // `backlog_total` already counts `pendingOrders`.
    let is_online = bool_path(health, &["isOnline"]);
    let offline_ms = i64_path(health, &["networkOutage", "offlineMs"]);
    let offline_evidence = json!({
        "pendingBacklog": pending_backlog,
        "pendingOrders": i64_path(health, &["pendingOrders"]),
        "offlineMinutes": offline_ms / 60_000,
        "thresholdMinutes": OFFLINE_INCIDENT_MIN_OUTAGE_MS / 60_000,
    });
    match network_outage_level(is_online, offline_ms, pending_backlog) {
        NetworkOutageLevel::Sustained => incidents.push(PosIncidentCandidate {
            issue_code: NETWORK_OFFLINE_ISSUE_CODE.to_string(),
            severity: PosIncidentSeverity::High,
            fingerprint: format!("{terminal_id}:{NETWORK_OFFLINE_ISSUE_CODE}:pending_sync_items"),
            summary: format!(
                "The POS has been offline for {} minutes while saved data is waiting to sync.",
                offline_ms / 60_000
            ),
            evidence: offline_evidence,
            should_report: false,
        }),
        NetworkOutageLevel::Unstable => incidents.push(PosIncidentCandidate {
            issue_code: NETWORK_UNSTABLE_ISSUE_CODE.to_string(),
            severity: PosIncidentSeverity::Warning,
            fingerprint: format!("{terminal_id}:{NETWORK_UNSTABLE_ISSUE_CODE}:pending_sync_items"),
            summary: "The connection dropped briefly while saved data was waiting to sync."
                .to_string(),
            evidence: offline_evidence,
            should_report: false,
        }),
        NetworkOutageLevel::None => {}
    }

    incidents
}

// ---------------------------------------------------------------------------
// Network outage episodes
// ---------------------------------------------------------------------------

/// The persisted outage. Both time fields `None` while online.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOutageEpisode {
    /// First failed observation of the current outage (RFC 3339).
    pub offline_since: Option<String>,
    /// Latest failed observation (RFC 3339).
    pub last_offline_at: Option<String>,
    /// Most data seen waiting during the outage.
    #[serde(default)]
    pub max_backlog: i64,
}

/// An outage that an observation, a server reply or a report proved over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndedNetworkOutage {
    pub offline_since: String,
    /// When the till was proven online again.
    pub reconnected_at: String,
    /// First to last failed observation (a measured lower bound).
    pub offline_ms: i64,
    pub max_backlog: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkOutageLevel {
    None,
    Unstable,
    Sustained,
}

fn iso_millis(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_utc(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
}

impl NetworkOutageEpisode {
    /// A missing or damaged stored episode reads as online, never as a long outage.
    fn parse(raw: Option<&str>) -> Self {
        let parsed = raw
            .and_then(|raw| serde_json::from_str::<NetworkOutageEpisode>(raw).ok())
            .unwrap_or_default();
        if parse_utc(parsed.offline_since.as_deref()).is_some()
            && parse_utc(parsed.last_offline_at.as_deref()).is_some()
        {
            NetworkOutageEpisode {
                max_backlog: parsed.max_backlog.max(0),
                ..parsed
            }
        } else {
            Self::default()
        }
    }

    pub fn since(&self) -> Option<DateTime<Utc>> {
        parse_utc(self.offline_since.as_deref())
    }
}

/// The stored outage is over at `reconnected_at`: what it measured, if any.
pub fn end_of_outage(
    episode: &NetworkOutageEpisode,
    reconnected_at: DateTime<Utc>,
) -> Option<EndedNetworkOutage> {
    let since = parse_utc(episode.offline_since.as_deref())?;
    let last = parse_utc(episode.last_offline_at.as_deref())?;
    Some(EndedNetworkOutage {
        offline_since: iso_millis(since),
        reconnected_at: iso_millis(reconnected_at),
        offline_ms: (last - since).num_milliseconds().max(0),
        max_backlog: episode.max_backlog.max(0),
    })
}

/// The outage after one observation, how long (ms) the till has been offline,
/// and the outage this observation proved over, if any (an online
/// observation, or a server reply after the outage began). A reply from the
/// admin server proves the till was online at that moment, so the outage can
/// only have started after it. An outage left behind by a gap (the till was
/// not watching) is not "ended": nobody saw it end.
pub fn advance_network_outage(
    previous: &NetworkOutageEpisode,
    online: bool,
    last_server_reply_at: Option<DateTime<Utc>>,
    backlog: i64,
    now: DateTime<Utc>,
) -> (NetworkOutageEpisode, i64, Option<EndedNetworkOutage>) {
    let backlog = backlog.max(0);
    let previous_since = parse_utc(previous.offline_since.as_deref());
    let previous_last = parse_utc(previous.last_offline_at.as_deref());
    let previous_open =
        matches!((previous_since, previous_last), (Some(since), Some(_)) if since <= now);
    if online {
        let ended = if previous_open {
            end_of_outage(previous, now)
        } else {
            None
        };
        return (NetworkOutageEpisode::default(), 0, ended);
    }
    let continues = previous_open
        && previous_last.is_some_and(|last| {
            (now - last).num_milliseconds() <= OUTAGE_EPISODE_MAX_SAMPLE_GAP_MS
        });
    let (mut since, mut max_backlog) = match previous_since {
        Some(since) if continues => (since, previous.max_backlog.max(backlog)),
        _ => (now, backlog),
    };
    let mut ended = None;
    if let Some(reply) = last_server_reply_at {
        if reply > since {
            if let (true, Some(last)) = (continues, previous_last) {
                ended = Some(EndedNetworkOutage {
                    offline_since: iso_millis(since),
                    reconnected_at: iso_millis(reply.min(now)),
                    offline_ms: (last.min(reply) - since).num_milliseconds().max(0),
                    max_backlog: previous.max_backlog.max(0),
                });
            }
            since = reply.min(now);
            max_backlog = backlog;
        }
    }
    (
        NetworkOutageEpisode {
            offline_since: Some(iso_millis(since)),
            last_offline_at: Some(iso_millis(now)),
            max_backlog,
        },
        (now - since).num_milliseconds(),
        ended,
    )
}

/// An ended outage worth one report: 10 minutes or more, with data waiting.
pub fn is_reportable_outage(ended: &EndedNetworkOutage) -> bool {
    ended.offline_ms >= OFFLINE_INCIDENT_MIN_OUTAGE_MS && ended.max_backlog > 0
}

/// The one report of a real outage, sent after it; the server stores it
/// already resolved (`recovered: true`).
pub fn recovered_outage_candidate(
    terminal_id: &str,
    ended: &EndedNetworkOutage,
) -> PosIncidentCandidate {
    let offline_minutes = ended.offline_ms / 60_000;
    PosIncidentCandidate {
        issue_code: NETWORK_OFFLINE_ISSUE_CODE.to_string(),
        severity: PosIncidentSeverity::High,
        fingerprint: format!("{terminal_id}:{NETWORK_OFFLINE_ISSUE_CODE}:pending_sync_items"),
        summary: format!(
            "The POS was offline for {offline_minutes} minutes with saved data waiting; it has reconnected and is syncing."
        ),
        evidence: json!({
            "pendingBacklog": ended.max_backlog,
            "offlineMinutes": offline_minutes,
            "thresholdMinutes": OFFLINE_INCIDENT_MIN_OUTAGE_MS / 60_000,
            "offlineSince": ended.offline_since,
            "reconnectedAt": ended.reconnected_at,
            "recovered": true,
        }),
        should_report: true,
    }
}

pub fn network_outage_level(online: bool, offline_ms: i64, backlog: i64) -> NetworkOutageLevel {
    if online || backlog <= 0 {
        NetworkOutageLevel::None
    } else if offline_ms >= OFFLINE_INCIDENT_MIN_OUTAGE_MS {
        NetworkOutageLevel::Sustained
    } else {
        NetworkOutageLevel::Unstable
    }
}

/// Advance the stored outage with this observation's probe and write the
/// result into the health payload as `networkOutage`, which
/// [`classify_incidents`] reads. A real outage this observation proved over
/// is queued for its one report. Only the incident reporter calls this, so
/// the stored episode has one writer.
pub fn track_network_outage(
    db: &db::DbState,
    health: &mut Value,
    last_server_reply_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> NetworkOutageEpisode {
    let online = bool_path(health, &["isOnline"]);
    let previous = NetworkOutageEpisode::parse(read_setting(db, NETWORK_OUTAGE_KEY).as_deref());
    let (episode, offline_ms, ended) = advance_network_outage(
        &previous,
        online,
        last_server_reply_at,
        backlog_total(health),
        now,
    );
    if let Some(ended) = ended.filter(is_reportable_outage) {
        queue_outage_report(db, &ended);
    }
    if episode != previous {
        store_network_outage(db, &episode);
    }
    if let Some(object) = health.as_object_mut() {
        object.insert(
            "networkOutage".into(),
            json!({
                "offlineSince": episode.offline_since,
                "offlineMs": offline_ms,
                "lastServerReplyAt": last_server_reply_at.map(iso_millis),
            }),
        );
    }
    episode
}

/// A report reached the server: whatever the probe said, the till is online
/// and an outage it was in is over (and, if real, queued for its report).
pub fn note_reached_server(db: &db::DbState, at: DateTime<Utc>) {
    let episode = NetworkOutageEpisode::parse(read_setting(db, NETWORK_OUTAGE_KEY).as_deref());
    if episode.since().is_none() {
        return;
    }
    if let Some(ended) = end_of_outage(&episode, at).filter(is_reportable_outage) {
        queue_outage_report(db, &ended);
    }
    store_network_outage(db, &NetworkOutageEpisode::default());
}

fn store_network_outage(db: &db::DbState, episode: &NetworkOutageEpisode) {
    match serde_json::to_string(episode) {
        Ok(raw) => write_setting(db, NETWORK_OUTAGE_KEY, &raw),
        Err(error) => warn!(error = %error, "Failed to serialize the network outage episode"),
    }
}

/// A real outage that ended and is still to be reported, once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingOutageReport {
    #[serde(flatten)]
    ended: EndedNetworkOutage,
    /// After a failed send: not before this.
    #[serde(default)]
    next_attempt_at: Option<String>,
}

fn read_pending_outage_report(db: &db::DbState) -> Option<PendingOutageReport> {
    read_setting(db, PENDING_OUTAGE_REPORT_KEY).and_then(|raw| serde_json::from_str(&raw).ok())
}

fn write_pending_outage_report(db: &db::DbState, pending: Option<&PendingOutageReport>) {
    let raw = pending
        .and_then(|pending| serde_json::to_string(pending).ok())
        .unwrap_or_else(|| "null".to_string());
    write_setting(db, PENDING_OUTAGE_REPORT_KEY, &raw);
}

fn queue_outage_report(db: &db::DbState, ended: &EndedNetworkOutage) {
    write_pending_outage_report(
        db,
        Some(&PendingOutageReport {
            ended: ended.clone(),
            next_attempt_at: None,
        }),
    );
}

/// The post-outage report to send now, if one is due. No "online now" check
/// applies: it describes an outage that is over. One the server never took
/// within a day is given up.
pub fn due_outage_report(
    db: &db::DbState,
    terminal_id: &str,
    now: DateTime<Utc>,
) -> Option<PosIncidentCandidate> {
    let pending = read_pending_outage_report(db)?;
    let reconnected_at = parse_utc(Some(&pending.ended.reconnected_at)).unwrap_or(now);
    if (now - reconnected_at).num_milliseconds() > INCIDENT_CLEAR_GIVE_UP_MS {
        write_pending_outage_report(db, None);
        return None;
    }
    if parse_utc(pending.next_attempt_at.as_deref()).is_some_and(|next| next > now) {
        return None;
    }
    Some(recovered_outage_candidate(terminal_id, &pending.ended))
}

/// Sent: forgotten (the server stores it resolved, nothing to clear later).
/// Not sent: retried after [`INCIDENT_CLEAR_RETRY_MS`].
pub fn record_outage_report_outcome(db: &db::DbState, sent: bool, now: DateTime<Utc>) {
    if sent {
        write_pending_outage_report(db, None);
        return;
    }
    if let Some(mut pending) = read_pending_outage_report(db) {
        pending.next_attempt_at = Some(iso_millis(
            now + ChronoDuration::milliseconds(INCIDENT_CLEAR_RETRY_MS),
        ));
        write_pending_outage_report(db, Some(&pending));
    }
}

// ---------------------------------------------------------------------------
// Clearance: reported fingerprints that are no longer observed
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenIncidentReport {
    /// When the till last reported it (RFC 3339).
    pub reported_at: String,
    /// Observations in a row without it.
    #[serde(default)]
    pub clear_observations: i64,
    /// When it was first found cleared; `None` while still observed.
    #[serde(default)]
    pub cleared_at: Option<String>,
    /// After a failed clearance report: not before this.
    #[serde(default)]
    pub next_attempt_at: Option<String>,
}

pub type OpenIncidentReports = BTreeMap<String, OpenIncidentReport>;

pub fn parse_open_incident_reports(raw: Option<&str>) -> OpenIncidentReports {
    let Some(entries) =
        raw.and_then(|raw| serde_json::from_str::<BTreeMap<String, Value>>(raw).ok())
    else {
        return OpenIncidentReports::new();
    };
    entries
        .into_iter()
        .filter_map(|(fingerprint, value)| {
            serde_json::from_value::<OpenIncidentReport>(value)
                .ok()
                .map(|entry| (fingerprint, entry))
        })
        .collect()
}

/// A fingerprint the server accepted: open until it is observed clear.
pub fn mark_incident_reported(
    open: &mut OpenIncidentReports,
    fingerprint: &str,
    now: DateTime<Utc>,
) {
    open.insert(
        fingerprint.to_string(),
        OpenIncidentReport {
            reported_at: iso_millis(now),
            clear_observations: 0,
            cleared_at: None,
            next_attempt_at: None,
        },
    );
}

/// One successful observation: count the reported fingerprints it no longer
/// shows, and return those to report cleared now (sorted). Call only when the
/// observation itself succeeded; a failed read proves nothing cleared, and
/// `unreadable` names the fingerprints whose source this observation could
/// not read: they count as still observed.
pub fn advance_incident_clearance(
    open: &mut OpenIncidentReports,
    observed: &BTreeSet<String>,
    unreadable: &dyn Fn(&str) -> bool,
    now: DateTime<Utc>,
) -> Vec<String> {
    let mut to_resolve = Vec::new();
    let mut give_up = Vec::new();
    for (fingerprint, entry) in open.iter_mut() {
        // Its source could not be read: not seeing it proves nothing.
        if observed.contains(fingerprint) || unreadable(fingerprint) {
            entry.clear_observations = 0;
            entry.cleared_at = None;
            entry.next_attempt_at = None;
            continue;
        }
        entry.clear_observations += 1;
        if entry.clear_observations < INCIDENT_CLEAR_OBSERVATIONS {
            continue;
        }
        if entry.cleared_at.is_none() {
            entry.cleared_at = Some(iso_millis(now));
        }
        let cleared_at = parse_utc(entry.cleared_at.as_deref()).unwrap_or(now);
        if (now - cleared_at).num_milliseconds() > INCIDENT_CLEAR_GIVE_UP_MS {
            give_up.push(fingerprint.clone());
            continue;
        }
        if parse_utc(entry.next_attempt_at.as_deref()).is_some_and(|next| next > now) {
            continue;
        }
        to_resolve.push(fingerprint.clone());
    }
    for fingerprint in give_up {
        open.remove(&fingerprint);
    }
    to_resolve
}

pub fn record_clearance_outcome(
    open: &mut OpenIncidentReports,
    fingerprints: &[String],
    confirmed: bool,
    now: DateTime<Utc>,
) {
    for fingerprint in fingerprints {
        if confirmed {
            open.remove(fingerprint);
        } else if let Some(entry) = open.get_mut(fingerprint) {
            entry.next_attempt_at = Some(iso_millis(
                now + ChronoDuration::milliseconds(INCIDENT_CLEAR_RETRY_MS),
            ));
        }
    }
}

fn read_open_reports(db: &db::DbState) -> OpenIncidentReports {
    parse_open_incident_reports(read_setting(db, OPEN_REPORTS_KEY).as_deref())
}

fn write_open_reports(db: &db::DbState, open: &OpenIncidentReports) {
    match serde_json::to_string(open) {
        Ok(raw) => write_setting(db, OPEN_REPORTS_KEY, &raw),
        Err(error) => warn!(error = %error, "Failed to serialize open incident reports"),
    }
}

/// Where each automatic incident is read from in the system-health payload,
/// whose `readFailures` names the reads that failed. `None`: an unknown code.
fn incident_sources(issue_code: &str) -> Option<&'static [&'static str]> {
    Some(match issue_code {
        "sync.failed_financial_queue" => &["financialQueueStatus", "syncStatusSummary"],
        "sync.active_error" | "sync.remote_auth_paused" => &["syncStatusSummary"],
        "sync.blocked_backlog" => &[
            "syncBlockerDetails",
            "parityQueueStatus",
            "syncStatusSummary",
            "syncBacklog",
            "pendingOrders",
        ],
        "sync.invalid_orders" => &["invalidOrders"],
        "printer.critical_failure" | "printer.jobs_not_printing" => &["printerStatus"],
        NETWORK_OFFLINE_ISSUE_CODE | NETWORK_UNSTABLE_ISSUE_CODE => {
            &["syncBacklog", "syncStatusSummary", "pendingOrders"]
        }
        "system.panic_detected" | "system.health_monitor_failed" => &[],
        _ => return None,
    })
}

/// `{terminal}:{issueCode}:{class}` -> the issue code; "" for any other shape.
fn incident_issue_code(fingerprint: &str) -> &str {
    let mut parts = fingerprint.split(':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(_), Some(code), Some(_)) => code,
        _ => "",
    }
}

fn is_unknown_terminal_fingerprint(fingerprint: &str) -> bool {
    fingerprint
        .strip_prefix(UNKNOWN_TERMINAL_ID)
        .is_some_and(|rest| rest.starts_with(':'))
}

/// The fingerprints this observation cannot speak for: everything while the
/// terminal id is the `unknown-terminal` fallback (every fingerprint changes),
/// the incidents of a read that failed (`readFailures`), and an unknown code
/// whenever any read failed. A failed read is not "nothing wrong" (review of
/// PR #367, 15/10/2026: a failed financial-queue read could have auto-resolved
/// a critical incident).
pub fn unreadable_fingerprints(health: &Value) -> impl Fn(&str) -> bool {
    let failures: BTreeSet<String> = health
        .get("readFailures")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let terminal_known = terminal_id_from_health(health) != UNKNOWN_TERMINAL_ID;
    move |fingerprint: &str| {
        if !terminal_known || is_unknown_terminal_fingerprint(fingerprint) {
            return true;
        }
        match incident_sources(incident_issue_code(fingerprint)) {
            Some(sources) => sources.iter().any(|source| failures.contains(*source)),
            None => !failures.is_empty(),
        }
    }
}

/// Book-keeping for one successful observation, before any send:
/// - "two in a row" starts again for every reportable fingerprint no longer
///   observed (as on Android). The counter used to live for ever, so one
///   failed probe today plus one a week ago counted as two in a row;
/// - reported fingerprints that stayed away long enough are returned, to be
///   reported cleared ([`report_cleared_incidents`]).
///
/// Neither happens to a fingerprint whose source the observation could not
/// read ([`unreadable_fingerprints`]).
pub fn note_observation(
    db: &db::DbState,
    health: &Value,
    candidates: &[PosIncidentCandidate],
    now: DateTime<Utc>,
) -> Vec<String> {
    let unreadable = unreadable_fingerprints(health);
    let observed: BTreeSet<String> = candidates
        .iter()
        .filter(|candidate| candidate.should_report)
        .map(|candidate| candidate.fingerprint.clone())
        .collect();
    reset_unobserved_counters(db, &observed, &unreadable);

    let mut open = read_open_reports(db);
    if open.is_empty() {
        return Vec::new();
    }
    let to_resolve = advance_incident_clearance(&mut open, &observed, &unreadable, now);
    write_open_reports(db, &open);
    to_resolve
}

/// A failed observation still saw this fingerprint (the health monitor
/// failure): count it as observed, so the next successful observation starts
/// its "two in a row" again and can report it cleared.
pub fn note_failed_observation(db: &db::DbState, fingerprint: &str) {
    // Before the first successful observation there is no list yet; that
    // observation clears every older counter anyway.
    let Some(mut active) = read_active_fingerprints(db) else {
        return;
    };
    if active.insert(fingerprint.to_string()) {
        write_active_fingerprints(db, &active);
    }
}

/// The automatic reporter's send reached the server. A fingerprint built
/// without a terminal id is never tracked: nothing could later tell whether
/// its condition cleared.
pub fn note_reported(db: &db::DbState, fingerprint: &str, now: DateTime<Utc>) {
    if is_unknown_terminal_fingerprint(fingerprint) {
        return;
    }
    let mut open = read_open_reports(db);
    mark_incident_reported(&mut open, fingerprint, now);
    write_open_reports(db, &open);
}

fn read_active_fingerprints(db: &db::DbState) -> Option<BTreeSet<String>> {
    read_setting(db, ACTIVE_FINGERPRINTS_KEY).and_then(|raw| serde_json::from_str(&raw).ok())
}

fn write_active_fingerprints(db: &db::DbState, active: &BTreeSet<String>) {
    if let Ok(raw) = serde_json::to_string(active) {
        write_setting(db, ACTIVE_FINGERPRINTS_KEY, &raw);
    }
}

fn reset_unobserved_counters(
    db: &db::DbState,
    observed: &BTreeSet<String>,
    unreadable: &dyn Fn(&str) -> bool,
) {
    let previous = read_active_fingerprints(db);
    // Unreadable now: kept as observed, so a later readable check decides.
    let mut active = observed.clone();
    if let Some(previous) = &previous {
        active.extend(
            previous
                .iter()
                .filter(|fingerprint| unreadable(fingerprint))
                .cloned(),
        );
    }
    match &previous {
        Some(previous) => {
            for fingerprint in previous.difference(&active) {
                write_setting(
                    db,
                    &format!("{CONSECUTIVE_KEY_PREFIX}{}", fingerprint_hash(fingerprint)),
                    "0",
                );
            }
        }
        // First observation with this book-keeping: the counters written by
        // earlier versions never reset, so none of them means "in a row".
        None => match db.conn.lock() {
            Ok(conn) => {
                if let Err(error) = conn.execute(
                    "DELETE FROM local_settings WHERE setting_category = ?1 AND setting_key LIKE ?2",
                    rusqlite::params![SETTINGS_CATEGORY, format!("{CONSECUTIVE_KEY_PREFIX}%")],
                ) {
                    warn!(error = %error, "Failed to clear stale incident counters");
                }
            }
            Err(error) => warn!(error = %error, "Failed to lock DB to clear incident counters"),
        },
    }
    if previous.as_ref() != Some(&active) {
        write_active_fingerprints(db, &active);
    }
}

/// Tell the server these reported fingerprints are gone
/// (`POST /api/pos/incidents/resolve`); it resolves this terminal's open rows.
/// Forgotten once confirmed; retried after [`INCIDENT_CLEAR_RETRY_MS`] if not.
pub async fn report_cleared_incidents(
    db: &db::DbState,
    fingerprints: &[String],
) -> Result<Value, String> {
    let body = json!({
        "fingerprints": fingerprints,
        "observedAt": Utc::now().to_rfc3339(),
    });
    let result = crate::admin_fetch(Some(db), "/api/pos/incidents/resolve", "POST", Some(body))
        .await
        .and_then(|response| {
            if response.get("success").and_then(Value::as_bool) == Some(true) {
                Ok(response)
            } else {
                Err("Incident clearance was not confirmed".to_string())
            }
        });
    let mut open = read_open_reports(db);
    record_clearance_outcome(&mut open, fingerprints, result.is_ok(), Utc::now());
    write_open_reports(db, &open);
    result
}

pub fn should_send_candidate(
    db: &db::DbState,
    candidate: &PosIncidentCandidate,
    manual: bool,
) -> bool {
    if manual {
        return true;
    }

    if !candidate.should_report {
        return false;
    }

    match candidate.severity {
        PosIncidentSeverity::Critical => {
            if is_suppressed(db, &candidate.fingerprint, CRITICAL_SUPPRESS_MINUTES) {
                store_status(db, &candidate.fingerprint, "suppressed");
                false
            } else {
                true
            }
        }
        PosIncidentSeverity::High => {
            let count = increment_consecutive_count(db, &candidate.fingerprint);
            if count < 2 {
                store_status(db, &candidate.fingerprint, "waiting");
                return false;
            }
            if is_suppressed(db, &candidate.fingerprint, HIGH_SUPPRESS_MINUTES) {
                store_status(db, &candidate.fingerprint, "suppressed");
                false
            } else {
                true
            }
        }
        PosIncidentSeverity::Warning => {
            if read_setting(db, "incident_auto_send_warnings").as_deref() != Some("true") {
                return false;
            }
            !is_suppressed(db, &candidate.fingerprint, 60)
        }
        PosIncidentSeverity::Info => false,
    }
}

pub async fn send_candidate_report(
    db: &db::DbState,
    candidate: &PosIncidentCandidate,
    health: &Value,
) -> Result<Value, String> {
    send_candidate_report_with_bundle(db, candidate, health, None).await
}

pub async fn send_candidate_report_with_bundle(
    db: &db::DbState,
    candidate: &PosIncidentCandidate,
    health: &Value,
    bundle_path: Option<&str>,
) -> Result<Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let about = diagnostics::get_about_info();
    let redacted_health = diagnostics::redact_remote_diagnostics_value(health.clone());
    let mut body = json!({
        "severity": candidate.severity.as_str(),
        "issueCode": candidate.issue_code,
        "fingerprint": candidate.fingerprint,
        "summary": candidate.summary,
        "evidence": diagnostics::redact_remote_diagnostics_value(candidate.evidence.clone()),
        "redactedHealth": redacted_health,
        "appVersion": about.get("version").and_then(Value::as_str),
        "gitSha": about.get("gitSha").and_then(Value::as_str),
        "platform": about.get("platform").and_then(Value::as_str),
        "occurredAt": Utc::now().to_rfc3339(),
    });

    let mut bundle_hash = None;
    if let Some(path) = bundle_path {
        // Same 2 MiB limit as shared/pos/health/incident-transfer.ts.
        if std::fs::metadata(path)
            .map_err(|_| "Diagnostics ZIP unavailable")?
            .len()
            > 2 * 1024 * 1024
        {
            return Err("Diagnostics ZIP exceeds the 2 MiB upload limit".into());
        }
        let bytes = std::fs::read(path).map_err(|_| "Diagnostics ZIP could not be read")?;
        bundle_hash = Some(crate::core_helpers::lower_hex(&Sha256::digest(&bytes)));
        body["diagnosticBundle"] = json!({
            "fileName": std::path::Path::new(path).file_name().and_then(|name| name.to_str()),
            "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "redacted": true,
        });
    }

    match crate::admin_fetch(Some(db), "/api/pos/incidents/report", "POST", Some(body)).await {
        Ok(response) => {
            if let Some(hash) = bundle_hash {
                if response.get("bundleStored").and_then(Value::as_bool) != Some(true)
                    || response.get("bundleSha256").and_then(Value::as_str) != Some(hash.as_str())
                    || response.get("incidentId").and_then(Value::as_str).is_none()
                {
                    record_send_failure(
                        db,
                        &candidate.fingerprint,
                        "diagnostics_zip_not_confirmed",
                    );
                    return Err("Diagnostics ZIP delivery was not confirmed".into());
                }
            }
            record_send_success(db, &candidate.fingerprint, &response);
            Ok(response)
        }
        Err(error) => {
            record_send_failure(db, &candidate.fingerprint, &error);
            Err(error)
        }
    }
}

fn record_send_success(db: &db::DbState, fingerprint: &str, response: &Value) {
    let now = Utc::now().to_rfc3339();
    let key_hash = fingerprint_hash(fingerprint);
    let incident_id = response
        .get("incidentId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let status = json!({
        "state": "sent",
        "incidentId": incident_id,
        "sentAt": now,
        "deduped": response.get("deduped").and_then(Value::as_bool).unwrap_or(false),
        "alertSent": response.get("alertSent").and_then(Value::as_bool).unwrap_or(false),
    });
    write_setting(db, &format!("incident_last_sent.{key_hash}"), &now);
    write_setting(
        db,
        &format!("incident_last_status.{key_hash}"),
        &status.to_string(),
    );
    write_setting(db, "incident_last_sent_global", &status.to_string());
}

fn record_send_failure(db: &db::DbState, fingerprint: &str, error: &str) {
    let key_hash = fingerprint_hash(fingerprint);
    let status = json!({
        "state": "failed",
        "failedAt": Utc::now().to_rfc3339(),
        "errorClass": normalize_error_class(error),
    });
    write_setting(
        db,
        &format!("incident_last_status.{key_hash}"),
        &status.to_string(),
    );
    write_setting(db, "incident_last_sent_global", &status.to_string());
}

fn store_status(db: &db::DbState, fingerprint: &str, status: &str) {
    let key_hash = fingerprint_hash(fingerprint);
    let payload = json!({
        "state": status,
        "updatedAt": Utc::now().to_rfc3339(),
    });
    write_setting(
        db,
        &format!("incident_last_status.{key_hash}"),
        &payload.to_string(),
    );
}

fn is_suppressed(db: &db::DbState, fingerprint: &str, minutes: i64) -> bool {
    let key_hash = fingerprint_hash(fingerprint);
    let Some(last_sent) = read_setting(db, &format!("incident_last_sent.{key_hash}")) else {
        return false;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(&last_sent) else {
        return false;
    };
    Utc::now().signed_duration_since(parsed.with_timezone(&Utc)) < ChronoDuration::minutes(minutes)
}

fn increment_consecutive_count(db: &db::DbState, fingerprint: &str) -> i64 {
    let key_hash = fingerprint_hash(fingerprint);
    let key = format!("incident_consecutive.{key_hash}");
    let count = read_setting(db, &key)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        + 1;
    write_setting(db, &key, &count.to_string());
    count
}

fn read_setting(db: &db::DbState, key: &str) -> Option<String> {
    let conn = db.conn.lock().ok()?;
    db::get_setting(&conn, SETTINGS_CATEGORY, key)
}

fn write_setting(db: &db::DbState, key: &str, value: &str) {
    match db.conn.lock() {
        Ok(conn) => {
            if let Err(error) = db::set_setting(&conn, SETTINGS_CATEGORY, key, value) {
                warn!(error = %error, key, "Failed to store incident reporting setting");
            }
        }
        Err(error) => {
            warn!(error = %error, key, "Failed to lock DB for incident reporting setting");
        }
    }
}

fn fingerprint_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn normalize_error_class(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_separator = false;
    for ch in value.to_ascii_lowercase().chars() {
        let mapped = if ch.is_ascii_alphabetic() {
            ch
        } else if ch.is_ascii_digit() {
            'n'
        } else {
            '_'
        };
        if mapped == '_' {
            if !last_was_separator && !output.is_empty() {
                output.push('_');
            }
            last_was_separator = true;
        } else {
            output.push(mapped);
            last_was_separator = false;
        }
        if output.len() >= 80 {
            break;
        }
    }
    let normalized = output.trim_matches('_').to_string();
    if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    }
}

fn value_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_path(value: &Value, path: &[&str]) -> Option<String> {
    value_path(value, path)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

fn i64_path(value: &Value, path: &[&str]) -> i64 {
    value_path(value, path).and_then(Value::as_i64).unwrap_or(0)
}

fn bool_path(value: &Value, path: &[&str]) -> bool {
    value_path(value, path)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn array_len_path(value: &Value, path: &[&str]) -> i64 {
    value_path(value, path)
        .and_then(Value::as_array)
        .map(|items| items.len() as i64)
        .unwrap_or(0)
}

fn backlog_total(health: &Value) -> i64 {
    let mut total = i64_path(health, &["syncStatusSummary", "pendingItems"])
        .max(i64_path(health, &["syncStatusSummary", "pendingChanges"]))
        .max(i64_path(health, &["pendingOrders"]));

    if let Some(map) = health.get("syncBacklog").and_then(Value::as_object) {
        for entity in map.values() {
            if let Some(status_counts) = entity.as_object() {
                for (status, count) in status_counts {
                    if matches!(
                        status.as_str(),
                        "pending" | "in_progress" | "queued_remote" | "deferred"
                    ) {
                        total += count.as_i64().unwrap_or(0);
                    }
                }
            }
        }
    }

    total
}

/// How long a receipt may sit unprinted before it is worth an alert.
///
/// Printing is a seconds-scale operation, so anything still pending after this
/// is not slow — it is stuck. Kept generous so an operator who deliberately
/// pauses the queue for a few minutes does not raise an incident.
const PRINT_JOB_STALL_ALERT_MINUTES: i64 = 20;

/// Age in minutes of the oldest job still waiting, or `None` when nothing is
/// waiting.
///
/// Prefers `printerStatus.pendingJobs.oldestCreatedAt`, an aggregate over the
/// WHOLE queue (jobs `pending`, or `printing` and not finished; jobs held by a
/// paused queue or printer are left out, see `diagnostics::read_print_queue_waiting`),
/// and falls back to scanning the five-row `recentJobs` window only
/// for terminals still sending the older payload. Timestamps that will not parse
/// are skipped rather than treated as infinitely old — a malformed row must not
/// manufacture an alert.
fn oldest_pending_print_job_age_minutes(health: &Value, now: DateTime<Utc>) -> Option<i64> {
    // Preferred source: the unrestricted pending aggregate. `recentJobs` holds
    // only the five NEWEST jobs, so on a till with two printers a job stuck on
    // one slides out of that window while jobs keep completing through the
    // other — and the alert would fall silent exactly when it matters most.
    //
    // When the `pendingJobs` key is present at all, the aggregate is the whole
    // answer. It already leaves out jobs held by a global or per-printer pause,
    // so `oldestCreatedAt: null` means nothing un-paused is waiting, and a null
    // aggregate means the queue read failed (unknown — never page on unknown).
    // Rescanning `recentJobs` there would count the very paused rows the
    // aggregate excluded and page support for a queue staff paused on purpose.
    if let Some(aggregate) = value_path(health, &["printerStatus", "pendingJobs"]) {
        return string_path(aggregate, &["oldestCreatedAt"])
            .and_then(|created| DateTime::parse_from_rfc3339(&created).ok())
            .map(|created| (now - created.with_timezone(&Utc)).num_minutes());
    }

    // Fallback only for a terminal still reporting the older payload shape,
    // which has no `pendingJobs` key.
    let jobs = value_path(health, &["printerStatus", "recentJobs"]).and_then(Value::as_array)?;

    jobs.iter()
        .filter(|job| {
            string_path(job, &["status"])
                .map(|status| status.eq_ignore_ascii_case("pending"))
                .unwrap_or(false)
        })
        .filter_map(|job| string_path(job, &["createdAt"]))
        .filter_map(|created| DateTime::parse_from_rfc3339(&created).ok())
        .map(|created| (now - created.with_timezone(&Utc)).num_minutes())
        .max()
}

fn printer_failed_job_count(health: &Value) -> i64 {
    let Some(jobs) = value_path(health, &["printerStatus", "recentJobs"]).and_then(Value::as_array)
    else {
        return 0;
    };

    jobs.iter()
        .filter(|job| {
            string_path(job, &["status"])
                .map(|status| status.to_ascii_lowercase().contains("fail"))
                .unwrap_or(false)
        })
        .count() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The failure counter above cannot see this: a wedged print lane never
    /// FAILS a job, it just never attempts one. Age of the oldest pending job is
    /// the only signal that catches it, and its absence is why a till printed
    /// nothing for fifteen hours while telemetry called it healthy.
    #[test]
    fn classifier_detects_receipts_that_are_waiting_but_never_failing() {
        let stalled = (Utc::now() - ChronoDuration::minutes(90)).to_rfc3339();
        let health = json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": {
                "configured": true,
                "recentJobs": [
                    { "id": "j1", "status": "pending", "createdAt": stalled },
                    { "id": "j2", "status": "printed", "createdAt": stalled }
                ]
            }
        });

        let incidents = classify_incidents(&health);
        let incident = incidents
            .iter()
            .find(|candidate| candidate.issue_code == "printer.jobs_not_printing")
            .expect("a receipt stuck for 90 minutes must raise an incident");

        assert_eq!(incident.severity, PosIncidentSeverity::High);
        assert!(
            incidents
                .iter()
                .all(|candidate| candidate.issue_code != "printer.critical_failure"),
            "nothing failed, so the failure detector must stay quiet - that is the whole point"
        );
    }

    /// The five-row `recentJobs` window is not enough on a till with two
    /// printers: a job stuck on one slides out of it while jobs keep completing
    /// through the other. Reading only that window would go silent exactly when
    /// the shop most needs telling.
    #[test]
    fn classifier_sees_a_stall_that_has_scrolled_out_of_the_recent_window() {
        let stalled = (Utc::now() - ChronoDuration::minutes(180)).to_rfc3339();
        let fresh = Utc::now().to_rfc3339();
        let health = json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": {
                "configured": true,
                // Not one pending row here — the stalled job is long gone from
                // the newest five, pushed out by the second printer's traffic.
                "recentJobs": [
                    { "id": "a", "status": "printed", "createdAt": fresh },
                    { "id": "b", "status": "printed", "createdAt": fresh },
                    { "id": "c", "status": "printed", "createdAt": fresh },
                    { "id": "d", "status": "printed", "createdAt": fresh },
                    { "id": "e", "status": "printed", "createdAt": fresh }
                ],
                "pendingJobs": { "count": 1, "oldestCreatedAt": stalled }
            }
        });

        let incident = classify_incidents(&health)
            .into_iter()
            .find(|candidate| candidate.issue_code == "printer.jobs_not_printing")
            .expect("the whole-queue aggregate must still see the stalled job");

        assert_eq!(incident.severity, PosIncidentSeverity::High);
    }

    /// An empty queue must not alert, even though the aggregate key is present.
    #[test]
    fn classifier_ignores_an_empty_pending_aggregate() {
        let health = json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": {
                "configured": true,
                "recentJobs": [],
                "pendingJobs": { "count": 0, "oldestCreatedAt": null }
            }
        });

        assert!(
            classify_incidents(&health)
                .iter()
                .all(|candidate| candidate.issue_code != "printer.jobs_not_printing"),
            "nothing is waiting, so nothing is stuck"
        );
    }

    #[test]
    fn classifier_ignores_a_freshly_queued_receipt() {
        let health = json!({
            "terminalContext": { "terminalId": "term-1" },
            "printerStatus": {
                "configured": true,
                "recentJobs": [
                    { "id": "j1", "status": "pending", "createdAt": Utc::now().to_rfc3339() }
                ]
            }
        });

        assert!(
            classify_incidents(&health)
                .iter()
                .all(|candidate| candidate.issue_code != "printer.jobs_not_printing"),
            "a receipt queued seconds ago is not stuck"
        );
    }

    #[test]
    fn classifier_detects_failed_financial_queue_without_raw_payload() {
        let health = json!({
            "terminalContext": { "terminalId": "term-1" },
            "financialQueueStatus": {
                "totalFailed": 3,
                "failedPaymentItems": 2,
                "raw_payload": { "customer_email": "person@example.com" }
            }
        });

        let incidents = classify_incidents(&health);
        let incident = incidents
            .iter()
            .find(|candidate| candidate.issue_code == "sync.failed_financial_queue")
            .expect("financial incident");

        assert_eq!(incident.severity, PosIncidentSeverity::Critical);
        assert!(incident
            .fingerprint
            .starts_with("term-1:sync.failed_financial_queue:"));
        assert!(!incident.fingerprint.contains("person@example.com"));
        assert_eq!(incident.evidence["totalFailed"], json!(3));
    }

    #[test]
    fn classifier_uses_stable_normalized_fingerprint() {
        let a = health_monitor_failed_candidate(
            Some("t1".to_string()),
            "HTTP 401 token expired for order 123",
        );
        let b = health_monitor_failed_candidate(
            Some("t1".to_string()),
            "HTTP 999 token expired for order 456",
        );

        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(
            a.fingerprint,
            "t1:system.health_monitor_failed:http_nnn_token_expired_for_order_nnn"
        );
    }

    #[test]
    fn classifier_pages_offline_only_after_a_measured_outage() {
        let mut health = json!({
            "terminalContext": { "terminalId": "term-2" },
            "isOnline": false,
            "syncStatusSummary": { "pendingItems": 4 }
        });

        // A failed probe alone (no measured outage) is a warning kept on the till.
        let incidents = classify_incidents(&health);
        assert_eq!(incidents.len(), 1);
        assert_eq!(incidents[0].issue_code, "network.connection_unstable");
        assert_eq!(incidents[0].severity, PosIncidentSeverity::Warning);
        assert!(!incidents[0].should_report);

        // Ten minutes is HIGH, and still kept on the till while it lasts: it is
        // reported once, after it (`recovered_outage_candidate`).
        health["networkOutage"] = json!({ "offlineMs": OFFLINE_INCIDENT_MIN_OUTAGE_MS });
        let incidents = classify_incidents(&health);
        assert_eq!(incidents.len(), 1);
        assert_eq!(incidents[0].issue_code, NETWORK_OFFLINE_ISSUE_CODE);
        assert_eq!(incidents[0].severity, PosIncidentSeverity::High);
        assert!(!incidents[0].should_report);
        assert_eq!(incidents[0].evidence["offlineMinutes"], json!(10));
    }

    // -- Network outages: the shared vectors (Android runs the same file) -----

    const OUTAGE_VECTORS: &str =
        include_str!("../../../shared/pos/health/__fixtures__/network-outage-vectors.json");

    fn outage_vectors() -> Value {
        serde_json::from_str(OUTAGE_VECTORS).expect("network outage vectors parse")
    }

    fn vector_time(vectors: &Value, sec: i64) -> DateTime<Utc> {
        let base = DateTime::parse_from_rfc3339(vectors["baseIso"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        base + ChronoDuration::seconds(sec)
    }

    fn optional_time(vectors: &Value, sec: &Value) -> Option<DateTime<Utc>> {
        sec.as_i64().map(|sec| vector_time(vectors, sec))
    }

    fn test_db() -> db::DbState {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn till_health(online: bool, backlog: i64) -> Value {
        json!({
            "terminalContext": { "terminalId": "term-1" },
            "isOnline": online,
            "syncStatusSummary": { "pendingItems": backlog }
        })
    }

    #[test]
    fn outage_contract_matches_the_shared_constants() {
        let contract = &outage_vectors()["contract"];
        assert_eq!(
            OFFLINE_INCIDENT_MIN_OUTAGE_MS,
            contract["incidentMinOutageSeconds"].as_i64().unwrap() * 1000
        );
        assert_eq!(
            OUTAGE_EPISODE_MAX_SAMPLE_GAP_MS,
            contract["episodeMaxSampleGapSeconds"].as_i64().unwrap() * 1000
        );
        assert_eq!(
            INCIDENT_CLEAR_OBSERVATIONS,
            contract["clearObservations"].as_i64().unwrap()
        );
        assert_eq!(
            INCIDENT_CLEAR_RETRY_MS,
            contract["clearRetrySeconds"].as_i64().unwrap() * 1000
        );
        assert_eq!(
            INCIDENT_CLEAR_GIVE_UP_MS,
            contract["clearGiveUpSeconds"].as_i64().unwrap() * 1000
        );
    }

    /// Every shared outage scenario, through the stored episode (a fresh read
    /// from the local database each step, as after an app restart), the
    /// classifier, and the one post-outage report it queues.
    #[test]
    fn outage_vectors_decide_the_same_on_the_desktop() {
        let vectors = outage_vectors();
        for episode in vectors["episodes"].as_array().unwrap() {
            let name = episode["name"].as_str().unwrap();
            let db = test_db();
            for step in episode["steps"].as_array().unwrap() {
                let at_sec = step["atSec"].as_i64().unwrap();
                let online = step["online"].as_bool().unwrap();
                let now = vector_time(&vectors, at_sec);
                let mut health = till_health(online, step["backlog"].as_i64().unwrap());
                track_network_outage(
                    &db,
                    &mut health,
                    optional_time(&vectors, &step["lastServerReplyAtSec"]),
                    now,
                );
                assert_eq!(
                    health["networkOutage"]["offlineMs"].as_i64().unwrap(),
                    step["expectOfflineSec"].as_i64().unwrap() * 1000,
                    "{name} at {at_sec}s: offline duration"
                );
                let codes: Vec<(String, bool)> = classify_incidents(&health)
                    .into_iter()
                    .map(|candidate| (candidate.issue_code, candidate.should_report))
                    .collect();
                // Nothing about an ongoing outage is ever sent.
                let expected: Vec<(String, bool)> = match step["expectLevel"].as_str().unwrap() {
                    "sustained" => vec![(NETWORK_OFFLINE_ISSUE_CODE.to_string(), false)],
                    "unstable" => vec![(NETWORK_UNSTABLE_ISSUE_CODE.to_string(), false)],
                    _ => vec![],
                };
                assert_eq!(codes, expected, "{name} at {at_sec}s: classification");
                let report = due_outage_report(&db, "term-1", now);
                assert_eq!(
                    report
                        .as_ref()
                        .map(|report| report.evidence["offlineMinutes"].clone()),
                    step["expectReportOutageSec"]
                        .as_i64()
                        .map(|sec| json!(sec * 1000 / 60_000)),
                    "{name} at {at_sec}s: post-outage report"
                );
                if report.is_some() {
                    record_outage_report_outcome(&db, true, now);
                }
            }
        }
    }

    #[test]
    fn clearance_vectors() {
        let vectors = outage_vectors();
        for scenario in vectors["clearance"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let mut stored = "{}".to_string();
            for step in scenario["steps"].as_array().unwrap() {
                let at_sec = step["atSec"].as_i64().unwrap();
                let now = vector_time(&vectors, at_sec);
                let strings = |key: &str| -> Vec<String> {
                    step[key]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .map(|item| item.as_str().unwrap().to_string())
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let observed: BTreeSet<String> = strings("observed").into_iter().collect();
                let unreadable: BTreeSet<String> = strings("unreadable").into_iter().collect();
                let mut open = parse_open_incident_reports(Some(&stored));
                let to_resolve = advance_incident_clearance(
                    &mut open,
                    &observed,
                    &|fingerprint: &str| unreadable.contains(fingerprint),
                    now,
                );
                for fingerprint in strings("reported") {
                    mark_incident_reported(&mut open, &fingerprint, now);
                }
                assert_eq!(to_resolve, strings("expectResolve"), "{name} at {at_sec}s");
                if !to_resolve.is_empty() {
                    let confirmed = step["confirm"].as_bool().unwrap_or(false);
                    record_clearance_outcome(&mut open, &to_resolve, confirmed, now);
                }
                stored = serde_json::to_string(&open).unwrap();
            }
        }
    }

    /// Tomikro, 14/10/2026 (terminal-d80762ac, 1.4.130): two failed probes at
    /// 22:17:45 and 22:18:30 while the order sync was answered every 16 s.
    /// The old rule paged HIGH on the second; now nothing is even a candidate
    /// to send, before or after.
    #[test]
    fn the_tomikro_blip_never_becomes_a_page() {
        let vectors = outage_vectors();
        let tomikro = vectors["episodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|episode| episode["name"] == "tomikro_blip_14_10_2026")
            .unwrap();
        let db = test_db();
        for step in tomikro["steps"].as_array().unwrap() {
            let now = vector_time(&vectors, step["atSec"].as_i64().unwrap());
            let mut health = till_health(step["online"].as_bool().unwrap(), 2);
            track_network_outage(
                &db,
                &mut health,
                optional_time(&vectors, &step["lastServerReplyAtSec"]),
                now,
            );
            let candidates = classify_incidents(&health);
            note_observation(&db, &health, &candidates, now);
            for candidate in &candidates {
                assert!(
                    !should_send_candidate(&db, candidate, false),
                    "{} must not leave the till",
                    candidate.issue_code
                );
            }
            assert!(due_outage_report(&db, "term-1", now).is_none());
        }
        // Even with warnings switched on, connection_unstable stays local.
        write_setting(&db, "incident_auto_send_warnings", "true");
        let mut health = till_health(false, 2);
        health["networkOutage"] = json!({ "offlineMs": 60_000 });
        let unstable = classify_incidents(&health);
        assert!(!should_send_candidate(&db, &unstable[0], false));
    }

    /// A real outage pages once, after it: while it lasts nothing can leave the
    /// till (and nothing tries), and once it reconnects one HIGH report goes
    /// out saying how long it lasted, which the server stores resolved.
    #[test]
    fn a_real_outage_is_reported_once_after_it_reconnects() {
        let db = test_db();
        let start = Utc::now() - ChronoDuration::hours(1);
        // The reporter's 45-second cadence, 20 minutes without any reply.
        for tick in 0..=26 {
            let now = start + ChronoDuration::seconds(45 * tick);
            let mut health = till_health(false, 3);
            track_network_outage(&db, &mut health, None, now);
            let candidates = classify_incidents(&health);
            note_observation(&db, &health, &candidates, now);
            assert!(candidates
                .iter()
                .all(|candidate| !should_send_candidate(&db, candidate, false)));
            assert!(due_outage_report(&db, "term-1", now).is_none());
        }
        let reconnected = start + ChronoDuration::seconds(45 * 27);
        let mut health = till_health(true, 3);
        track_network_outage(&db, &mut health, None, reconnected);
        let report = due_outage_report(&db, "term-1", reconnected).expect("one report after it");
        assert_eq!(report.issue_code, NETWORK_OFFLINE_ISSUE_CODE);
        assert_eq!(report.severity, PosIncidentSeverity::High);
        assert!(report.should_report);
        assert_eq!(
            report.summary,
            "The POS was offline for 19 minutes with saved data waiting; it has reconnected and is syncing."
        );
        assert_eq!(report.evidence["recovered"], json!(true));
        assert_eq!(report.evidence["offlineMinutes"], json!(19));
        assert_eq!(report.evidence["pendingBacklog"], json!(3));
        assert_eq!(
            report.evidence["reconnectedAt"],
            json!(iso_millis(reconnected))
        );

        // A failed send waits five minutes; a sent one is forgotten.
        record_outage_report_outcome(&db, false, reconnected);
        assert!(
            due_outage_report(&db, "term-1", reconnected + ChronoDuration::minutes(4)).is_none()
        );
        let retry = reconnected + ChronoDuration::minutes(6);
        assert!(due_outage_report(&db, "term-1", retry).is_some());
        record_outage_report_outcome(&db, true, retry);
        assert!(due_outage_report(&db, "term-1", retry + ChronoDuration::hours(1)).is_none());
    }

    #[test]
    fn a_report_that_gets_through_ends_the_outage_and_queues_its_report() {
        let db = test_db();
        let start = Utc::now() - ChronoDuration::hours(1);
        for tick in 0..=16 {
            let mut health = till_health(false, 2);
            track_network_outage(
                &db,
                &mut health,
                None,
                start + ChronoDuration::seconds(45 * tick),
            );
        }
        let at = start + ChronoDuration::seconds(45 * 17);
        note_reached_server(&db, at);
        let report = due_outage_report(&db, "term-1", at).expect("the outage was 12 minutes");
        assert_eq!(report.evidence["offlineMinutes"], json!(12));
        // The till is online now: the next failed probe starts a new outage.
        let mut health = till_health(false, 2);
        track_network_outage(&db, &mut health, None, at + ChronoDuration::seconds(45));
        assert_eq!(health["networkOutage"]["offlineMs"], json!(0));
    }

    #[test]
    fn an_unsent_post_outage_report_is_given_up_after_a_day() {
        let db = test_db();
        let ended = EndedNetworkOutage {
            offline_since: iso_millis(Utc::now() - ChronoDuration::hours(30)),
            reconnected_at: iso_millis(Utc::now() - ChronoDuration::hours(25)),
            offline_ms: 60 * 60 * 1000,
            max_backlog: 4,
        };
        queue_outage_report(&db, &ended);
        assert!(due_outage_report(&db, "term-1", Utc::now()).is_none());
        assert!(read_pending_outage_report(&db).is_none());
    }

    /// The server pages an offline report only when its evidence carries
    /// `offlineMinutes` of at least 10 (`incidentReportMayAlert`) and stores it
    /// resolved when it says `recovered`: both must leave the till through the
    /// remote redaction unchanged.
    #[test]
    fn the_post_outage_evidence_survives_redaction_for_the_server() {
        let ended = EndedNetworkOutage {
            offline_since: "2026-10-14T22:15:00.000Z".into(),
            reconnected_at: "2026-10-14T22:27:00.000Z".into(),
            offline_ms: 12 * 60_000,
            max_backlog: 2,
        };
        let candidate = recovered_outage_candidate("term-1", &ended);
        let redacted = diagnostics::redact_remote_diagnostics_value(candidate.evidence);
        assert_eq!(redacted["offlineMinutes"], json!(12));
        assert_eq!(redacted["thresholdMinutes"], json!(10));
        assert_eq!(redacted["pendingBacklog"], json!(2));
        assert_eq!(redacted["recovered"], json!(true));
        assert_eq!(redacted["offlineSince"], json!("2026-10-14T22:15:00.000Z"));
    }

    fn term_health() -> Value {
        json!({ "terminalContext": { "terminalId": "term-1" } })
    }

    /// The counter used to live for ever: one failed probe on 07/10 and one on
    /// 14/10 counted as "two in a row". It now starts again when a check no
    /// longer sees the condition, as on Android.
    #[test]
    fn two_in_a_row_starts_again_when_the_condition_clears() {
        let db = test_db();
        let health = term_health();
        let high = classify_incidents(&json!({
            "terminalContext": { "terminalId": "term-1" },
            "syncStatusSummary": { "remoteAuthPaused": true }
        }));
        assert_eq!(high[0].severity, PosIncidentSeverity::High);
        let now = Utc::now();

        note_observation(&db, &health, &high, now);
        assert!(!should_send_candidate(&db, &high[0], false));
        note_observation(&db, &health, &[], now);
        note_observation(&db, &health, &high, now);
        assert!(
            !should_send_candidate(&db, &high[0], false),
            "a sighting after a clear check is the first one again"
        );
        note_observation(&db, &health, &high, now);
        assert!(should_send_candidate(&db, &high[0], false));
    }

    #[test]
    fn counters_from_older_versions_are_not_two_in_a_row() {
        let db = test_db();
        let high = classify_incidents(&json!({
            "terminalContext": { "terminalId": "term-1" },
            "syncStatusSummary": { "remoteAuthPaused": true }
        }));
        write_setting(
            &db,
            &format!(
                "{CONSECUTIVE_KEY_PREFIX}{}",
                fingerprint_hash(&high[0].fingerprint)
            ),
            "7",
        );
        note_observation(&db, &term_health(), &high, Utc::now());
        assert!(!should_send_candidate(&db, &high[0], false));
    }

    #[test]
    fn a_reported_incident_is_reported_cleared_after_two_clean_checks() {
        let db = test_db();
        let health = term_health();
        let now = Utc::now();
        let fingerprint = "term-1:sync.remote_auth_paused:remote_auth_paused".to_string();
        note_reported(&db, &fingerprint, now);
        assert_eq!(
            note_observation(&db, &health, &[], now),
            Vec::<String>::new()
        );
        assert_eq!(
            note_observation(&db, &health, &[], now),
            vec![fingerprint.clone()]
        );

        // Not confirmed: kept, and retried no sooner than five minutes later.
        let mut open = read_open_reports(&db);
        record_clearance_outcome(&mut open, &[fingerprint.clone()], false, now);
        write_open_reports(&db, &open);
        assert!(note_observation(&db, &health, &[], now + ChronoDuration::minutes(1)).is_empty());
        assert_eq!(
            note_observation(&db, &health, &[], now + ChronoDuration::minutes(6)),
            vec![fingerprint.clone()]
        );
        let mut open = read_open_reports(&db);
        record_clearance_outcome(&mut open, &[fingerprint], true, now);
        assert!(open.is_empty());
    }

    // -- A failed read is not "nothing wrong" (review of PR #367) -------------

    /// A critical `sync.failed_financial_queue` must not be auto-resolved (a ✅
    /// Telegram message) because the financial queue could not be read.
    #[test]
    fn a_failed_read_clears_nothing_and_keeps_two_in_a_row() {
        for (source, fingerprint) in [
            (
                "financialQueueStatus",
                "term-1:sync.failed_financial_queue:http_nnn",
            ),
            ("syncStatusSummary", "term-1:sync.active_error:boom"),
            (
                "syncBlockerDetails",
                "term-1:sync.blocked_backlog:sync_blocker_details",
            ),
            (
                "invalidOrders",
                "term-1:sync.invalid_orders:pending_order_validation",
            ),
            (
                "printerStatus",
                "term-1:printer.jobs_not_printing:stalled_pending",
            ),
        ] {
            let db = test_db();
            let now = Utc::now();
            let candidate = PosIncidentCandidate {
                issue_code: incident_issue_code(fingerprint).to_string(),
                severity: PosIncidentSeverity::High,
                fingerprint: fingerprint.to_string(),
                summary: String::new(),
                evidence: json!({}),
                should_report: true,
            };
            note_observation(&db, &term_health(), &[candidate.clone()], now);
            assert!(!should_send_candidate(&db, &candidate, false));
            note_observation(&db, &term_health(), &[candidate.clone()], now);
            assert!(should_send_candidate(&db, &candidate, false));
            note_reported(&db, fingerprint, now);

            let unread = json!({
                "terminalContext": { "terminalId": "term-1" },
                "readFailures": [source],
            });
            for minute in 1..=4 {
                assert!(
                    note_observation(&db, &unread, &[], now + ChronoDuration::minutes(minute))
                        .is_empty(),
                    "{source}: a failed read must not clear {fingerprint}"
                );
            }
            assert_eq!(
                read_setting(
                    &db,
                    &format!("{CONSECUTIVE_KEY_PREFIX}{}", fingerprint_hash(fingerprint))
                )
                .as_deref(),
                Some("2"),
                "{source}: a failed read must not restart two in a row"
            );
            // Two readable checks without it: now it has cleared.
            assert!(note_observation(&db, &term_health(), &[], now).is_empty());
            assert_eq!(
                note_observation(&db, &term_health(), &[], now),
                vec![fingerprint.to_string()]
            );
        }
    }

    #[test]
    fn nothing_clears_while_the_terminal_id_is_unknown() {
        let db = test_db();
        let now = Utc::now();
        let fingerprint = "term-1:sync.remote_auth_paused:remote_auth_paused";
        note_reported(&db, fingerprint, now);
        let anonymous = json!({ "syncStatusSummary": { "remoteAuthPaused": true } });
        let candidates = classify_incidents(&anonymous);
        assert!(candidates[0].fingerprint.starts_with("unknown-terminal:"));
        for _ in 0..4 {
            assert!(note_observation(&db, &anonymous, &candidates, now).is_empty());
        }
        // A report made under the fallback is never tracked for clearance.
        note_reported(&db, &candidates[0].fingerprint, now);
        assert_eq!(
            read_open_reports(&db).keys().cloned().collect::<Vec<_>>(),
            vec![fingerprint.to_string()]
        );
    }

    #[test]
    fn unreadable_fingerprints_cover_each_failed_read() {
        let health = json!({
            "terminalContext": { "terminalId": "term-1" },
            "readFailures": ["printerStatus"],
        });
        let unreadable = unreadable_fingerprints(&health);
        assert!(unreadable(
            "term-1:printer.critical_failure:recent_jobs_failed"
        ));
        assert!(!unreadable(
            "term-1:sync.remote_auth_paused:remote_auth_paused"
        ));
        assert!(
            unreadable("term-1:some.future_code:x"),
            "unknown code while a read failed"
        );
        assert!(!unreadable_fingerprints(&term_health())(
            "term-1:some.future_code:x"
        ));
        assert!(unreadable_fingerprints(&json!({}))(
            "term-1:sync.active_error:x"
        ));
    }

    /// The system-health payload names a read that failed instead of passing
    /// its empty fallback off as "nothing wrong".
    #[test]
    fn system_health_names_the_reads_that_failed() {
        let db = test_db();
        let failures = |health: &Value| -> Vec<String> {
            health["readFailures"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect()
        };
        let health = diagnostics::get_system_health(&db).expect("system health");
        assert!(!failures(&health).contains(&"printerStatus".to_string()));
        assert!(!failures(&health).contains(&"syncBacklog".to_string()));

        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE print_jobs; DROP TABLE sync_queue;")
            .expect("drop tables");
        let health = diagnostics::get_system_health(&db).expect("system health");
        let failed = failures(&health);
        for source in ["printerStatus", "syncBacklog", "pendingOrders"] {
            assert!(
                failed.contains(&source.to_string()),
                "{source} in {failed:?}"
            );
        }
        let unreadable = unreadable_fingerprints(&health);
        assert!(unreadable(
            "term-1:printer.jobs_not_printing:stalled_pending"
        ));
        assert!(unreadable("term-1:sync.blocked_backlog:large_backlog"));
    }
}
