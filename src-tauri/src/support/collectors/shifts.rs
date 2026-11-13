use super::*;
pub fn collect(
    conn: &Connection,
    permit: &super::super::critical_op::SupportPermit,
) -> Result<Value, String> {
    collect_evidence(conn, permit, &super::super::evidence::Policy::default())
}
pub fn collect_evidence(
    conn: &Connection,
    permit: &super::super::critical_op::SupportPermit,
    policy: &super::super::evidence::Policy,
) -> Result<Value, String> {
    let mut shifts=rows(conn,"SELECT id AS shift_id,role_type AS role,check_in_time AS opened_at,'redacted' AS staff FROM staff_shifts WHERE status='active' ORDER BY check_in_time DESC LIMIT 50")?;
    if policy.personal {
        let labels = rows(
            conn,
            "SELECT id,staff_name FROM staff_shifts WHERE status='active' LIMIT 50",
        )?;
        for row in &mut shifts {
            if let Some(label) = labels
                .iter()
                .find(|v| v["id"] == row["shift_id"])
                .and_then(|v| v["staff_name"].as_str())
            {
                row["staff"] = policy.text(label);
            }
        }
    }
    let mut drawers=rows(conn,"SELECT id AS session_id,staff_shift_id AS shift_id,opened_at,closed_at,CASE WHEN closed_at IS NULL THEN 'open' ELSE 'closed' END AS status FROM cash_drawer_sessions ORDER BY opened_at DESC LIMIT 50")?;
    let mut last=rows(conn,"SELECT id AS z_id,report_date,generated_at,sync_state FROM z_reports ORDER BY generated_at DESC LIMIT 1")?;
    shifts.retain_mut(|row| normalize_required(row, "opened_at"));
    drawers.retain_mut(|row| {
        row["closed_at"] = json!(timestamp(&row["closed_at"]));
        normalize_required(row, "opened_at")
    });
    last.retain_mut(|row| normalize_required(row, "generated_at"));
    let readiness = crate::diagnostics::support_closeout_readiness(conn, permit);
    let detail = readiness.as_ref().err().map(|error| {
        super::super::evidence::detail_of(error).unwrap_or("HEALTH_OBSERVATION_MISSING")
    });
    let closeout = closeout_projection(readiness);
    let mut result = json!({"open_shifts":shifts,"drawer_sessions":drawers,"last_z":last.first(),"closeout_readiness":closeout});
    if let Some(detail) = detail {
        result["failure_detail_code"] = json!(detail);
    }
    Ok(result)
}
fn normalize_required(row: &mut Value, field: &str) -> bool {
    let Some(at) = timestamp(&row[field]) else {
        return false;
    };
    row[field] = json!(at);
    true
}
pub(super) fn closeout_projection(readiness: Result<Value, String>) -> Value {
    match readiness {
        Ok(value) => {
            let mut blockers = Vec::new();
            for (field, code) in [
                ("activeStaffBlockers", "ACTIVE_STAFF"),
                ("unsettledPaymentBlockers", "UNSETTLED_PAYMENTS"),
                ("unsyncedSyncQueue", "UNSYNCED_QUEUE"),
                ("giftCloseProof", "GIFT_CLOSE_PROOF_REQUIRED"),
            ] {
                if let Some(count) = value[field]["count"].as_u64().filter(|c| *c > 0) {
                    blockers.push(json!({"code":code,"count":count,"detail":null}));
                }
            }
            let fiscal = &value["fiscalQueueBlockers"];
            let unavailable = fiscal["status"]
                .as_str()
                .is_some_and(|s| s == "unavailable" || s == "not_collected");
            if unavailable || fiscal["wouldBlockClose"] == true {
                blockers.push(json!({"code":if unavailable{"FISCAL_READINESS_UNAVAILABLE"}else{"FISCAL_QUEUE"},"count":fiscal["count"].as_u64().unwrap_or(1),"detail":null}));
            }
            json!({"status":if unavailable{"unavailable"}else{"ok"},"ready":blockers.is_empty(),"blockers":blockers})
        }
        Err(_) => {
            json!({"status":"unavailable","ready":false,"blockers":[{"code":"READINESS_UNAVAILABLE","count":1,"detail":redaction::text("Closeout readiness is unavailable.")}]})
        }
    }
}
