use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::warn;

use crate::{db, diagnostics};

const SETTINGS_CATEGORY: &str = "diagnostics";
const CRITICAL_SUPPRESS_MINUTES: i64 = 15;
const HIGH_SUPPRESS_MINUTES: i64 = 30;

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
        .unwrap_or_else(|| "unknown-terminal".to_string())
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

    let is_online = bool_path(health, &["isOnline"]);
    if !is_online && (pending_backlog > 0 || i64_path(health, &["pendingOrders"]) > 0) {
        incidents.push(PosIncidentCandidate {
            issue_code: "network.offline_with_backlog".to_string(),
            severity: PosIncidentSeverity::High,
            fingerprint: format!("{terminal_id}:network.offline_with_backlog:pending_sync_items"),
            summary: "The POS is offline while saved data is waiting to sync.".to_string(),
            evidence: json!({
                "pendingBacklog": pending_backlog,
                "pendingOrders": i64_path(health, &["pendingOrders"]),
            }),
            should_report: true,
        });
    }

    incidents
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
    let about = diagnostics::get_about_info();
    let redacted_health = diagnostics::redact_remote_diagnostics_value(health.clone());
    let body = json!({
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

    match crate::admin_fetch(Some(db), "/api/pos/incidents/report", "POST", Some(body)).await {
        Ok(response) => {
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
    fn classifier_detects_offline_with_backlog() {
        let health = json!({
            "terminalContext": { "terminalId": "term-2" },
            "isOnline": false,
            "syncStatusSummary": { "pendingItems": 4 }
        });

        let incidents = classify_incidents(&health);
        assert!(incidents
            .iter()
            .any(|candidate| candidate.issue_code == "network.offline_with_backlog"));
    }
}
