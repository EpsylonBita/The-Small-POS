//! Local matcher inputs only. Never borrow the application's business connection.
use super::{critical_op, replica};
use crate::db::DbState;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;

const MAX_AGE_MS: i64 = 300_000;

fn observation(content: Value, at: Option<&str>, failed: bool) -> Value {
    let age = at
        .and_then(|at| super::clock::parse(at).ok())
        .map(|at| chrono::Utc::now().timestamp_millis() - at);
    let status = if content.is_null() || age.is_none_or(|age| age < 0) {
        "unavailable"
    } else if failed || age.is_some_and(|age| age > MAX_AGE_MS) {
        "stale"
    } else {
        "fresh"
    };
    json!({"status":status,"at":at,"age_ms":age,"content":content})
}

fn unavailable() -> Value {
    observation(Value::Null, None, false)
}

/// This mutex belongs exclusively to this evaluation's READ_ONLY handle. The
/// existing query owners may lock it, but checkout never uses or waits for it.
pub(super) struct MatcherRead {
    pub(super) db: DbState,
    pub(super) permit: critical_op::SupportPermit,
    deadline: Instant,
}
impl MatcherRead {
    pub(super) fn open(path: &Path) -> Result<Self, String> {
        let permit = critical_op::global()
            .try_begin_support(false, None)
            .map_err(str::to_string)?;
        let deadline = Instant::now() + Duration::from_millis(500);
        let conn = replica::read_connection(path, &permit, deadline)?;
        conn.execute_batch("PRAGMA query_only=ON")
            .map_err(replica::sql_error)?;
        Ok(Self {
            db: DbState {
                conn: Mutex::new(conn),
                db_path: path.into(),
            },
            permit,
            deadline,
        })
    }

    fn checked(&self, value: Result<Value, String>) -> Value {
        if self.permit.is_cancelled() || Instant::now() >= self.deadline {
            return unavailable();
        }
        value
            .map(|content| observation(content, Some(&chrono::Utc::now().to_rfc3339()), false))
            .unwrap_or_else(|_| unavailable())
    }

    pub(super) fn collect(&self) -> Value {
        let (health, integrity) = {
            let conn = self.db.conn.lock().expect("private matcher connection");
            let retained = crate::diagnostics::support_health_observation(&conn);
            let content = &retained["content"];
            let complete = content["readFailures"]
                .as_array()
                .is_some_and(|v| v.is_empty())
                && content["syncBacklogStatus"] == "ok";
            let health = observation(
                content.clone(),
                retained["at"].as_str(),
                retained["failed"] == true || !complete,
            );
            // Integrity scans are expensive. Read only the diagnostics owner's
            // retained export; listing remedies never starts another scan.
            let retained = crate::diagnostics::support_bundle_section(
                &conn,
                "financial_integrity",
                &self.permit,
            )
            .ok();
            let integrity = retained
                .map(|value| {
                    let complete = value["collector_status"] == "ok"
                        && value["truncation"].as_array().is_some_and(|v| v.is_empty())
                        && value["content"]["issues"].as_array().is_some_and(|issues| {
                            issues
                                .iter()
                                .all(|issue| issue["reasonCode"] != "courier_cash_check_incomplete")
                        })
                        && matches!(
                            value["content"]["courierCash"]["status"].as_str(),
                            Some("ok" | "not_applicable")
                        )
                        && value["content"]["courierCash"]["truncated"] != true;
                    observation(
                        if complete {
                            value["content"].clone()
                        } else {
                            Value::Null
                        },
                        value["last_observation_at"].as_str(),
                        false,
                    )
                })
                .unwrap_or_else(unavailable);
            (health, integrity)
        };
        let financial = self.checked(
            crate::commands::sync::query_financial_queue_items(251, &self.db).and_then(|value| {
                let items = value["items"].as_array().ok_or("unavailable")?;
                // The owners cap lists. A truncated list cannot prove no match.
                if items.len() > 250 {
                    return Err("unavailable".into());
                }
                Ok(json!(items))
            }),
        );
        let parity = self.checked((|| {
            let conn = self.db.conn.lock().map_err(|_| "unavailable")?;
            let org = super::collectors::setting(&conn, "terminal", "organization_id")
                .or_else(|| super::collectors::setting(&conn, "organization", "id"))
                .filter(|org| !org.is_empty()).ok_or("unavailable")?;
            // Reuse the renderer owner's domain exclusions, but fail closed on
            // a mixed-organization local file rather than match foreign rows.
            let foreign: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE organization_id<>?1 OR organization_id IS NULL)", [&org], |r| r.get(0)).map_err(replica::sql_error)?;
            if foreign { return Err("unavailable".into()); }
            let items = crate::sync_queue::renderer_list_actionable_items(&conn, &crate::sync_queue::QueueListQuery { limit: Some(251), module_type: None })?;
            if items.len() > 250 || items.iter().any(|item| item.organization_id != org) { return Err("unavailable".into()); }
            serde_json::to_value(items).map_err(|_| "unavailable".into())
        })());
        if self.permit.is_cancelled() || Instant::now() >= self.deadline {
            return json!({"systemHealth":unavailable(),"integrity":unavailable(),"financialItems":unavailable(),"parityItems":unavailable()});
        }
        json!({"systemHealth":health,"integrity":integrity,"financialItems":financial,"parityItems":parity})
    }
}

#[tauri::command]
pub async fn support_matcher_inputs(app: tauri::AppHandle) -> Result<Value, String> {
    crate::database_lock::run_blocking_command("support_matcher_inputs", move || {
        let db = app.state::<DbState>();
        Ok(MatcherRead::open(&db.db_path)?.collect())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_inputs_keep_their_age_and_missing_never_means_healthy() {
        let old = (chrono::Utc::now() - chrono::Duration::minutes(6)).to_rfc3339();
        let stale = observation(json!({"issues":[]}), Some(&old), false);
        assert_eq!(stale["status"], "stale");
        assert!(stale["age_ms"].as_i64().unwrap() >= 360_000);
        assert_eq!(unavailable()["status"], "unavailable");
        assert_eq!(observation(json!({}), Some(&old), true)["status"], "stale");
    }

    #[test]
    fn matcher_reads_retained_integrity_and_queues_while_business_mutex_is_held() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let fixture = crate::tests::harness::TestDb::open();
        {
            let conn = fixture.state.conn.lock().unwrap();
            crate::db::set_setting(&conn, "terminal", "organization_id", "your_org").unwrap();
            crate::db::set_setting(&conn, "terminal", "branch_id", "your_branch").unwrap();
        }
        crate::diagnostics::get_system_health(&fixture.state).unwrap();
        let expected = crate::commands::sync::collect_financial_integrity(&fixture.state).unwrap();
        crate::diagnostics::export_diagnostics(&fixture.state, fixture.dir()).unwrap();
        let matcher = MatcherRead::open(fixture.db_path()).unwrap();
        let _business = fixture.state.conn.lock().unwrap();
        assert!(matcher
            .db
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM orders", [])
            .is_err());
        let inputs = matcher.collect();
        for name in ["systemHealth", "integrity", "financialItems", "parityItems"] {
            assert_eq!(inputs[name]["status"], "fresh", "{name}: {}", inputs[name]);
            assert!(inputs[name]["age_ms"].as_i64().unwrap() >= 0);
        }
        assert_eq!(inputs["integrity"]["content"]["issues"], expected["issues"]);
    }

    #[test]
    fn incomplete_retained_integrity_is_unavailable_even_with_an_issues_array() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let _gate = critical_op::install_test_gate();
        let fixture = crate::tests::harness::TestDb::open();
        // No branch observation: the owner's courier check is unavailable.
        crate::diagnostics::export_diagnostics(&fixture.state, fixture.dir()).unwrap();
        let inputs = MatcherRead::open(fixture.db_path()).unwrap().collect();
        assert_eq!(inputs["integrity"]["status"], "unavailable");
        assert!(inputs["integrity"]["age_ms"].as_i64().is_some());
    }
}
