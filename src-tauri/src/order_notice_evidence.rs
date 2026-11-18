//! Closed, value-free evidence for open order issues. Never serialize a queue
//! payload, raw exception, order identity, customer data or request contents.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn employee_attempt(conn: &Connection, request: &Value) -> Result<Value, String> {
    if let Some(id) = request["attemptId"].as_str() {
        let outcome = match request["outcome"].as_str() {
            Some("pending") => "pending",
            Some("resolved") => "resolved",
            _ => "failed",
        };
        conn.execute("UPDATE recovery_action_log SET payload_json=json_set(payload_json,'$.outcome',?2,'$.machineReason',?3) WHERE id=?1 AND json_extract(payload_json,'$.employeeOrderAttempt')=1", params![id,outcome,request["code"].as_str().map(machine_code)]).map_err(|e|e.to_string())?;
        return Ok(Value::Null);
    }
    let queue = request["queueId"]
        .as_str()
        .ok_or("ORDER_NOTICE_READ_FAILED")?;
    let notices = crate::order_notice_recovery::notices(conn, None)?;
    let notice = notices
        .as_array()
        .and_then(|rows| rows.iter().find(|n| n["queueId"] == queue))
        .ok_or("REMEDY_NOT_APPLICABLE")?;
    let id = uuid::Uuid::new_v4().to_string();
    let refusal: Option<String> = if let Some(id) = queue.strip_prefix("financial:") {
        conn.query_row(
            "SELECT last_error FROM sync_queue WHERE CAST(id AS TEXT)=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten()
    } else {
        conn.query_row(
            "SELECT error_message FROM parity_sync_queue WHERE id=?1",
            [queue],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten()
    };
    conn.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,issue_id,entity_type,entity_id,order_id,success,created_at,payload_json) VALUES (?1,'employeeOrderAttempt',?2,?3,'order',?3,?4,0,?5,?6)", params![id,notice["kind"].as_str(),queue,notice["orderId"].as_str(),chrono::Utc::now().to_rfc3339(),json!({"employeeOrderAttempt":true,"outcome":"running","reason":refusal.as_deref().map(machine_code),"openedAt":notice["since"]}).to_string()]).map_err(|e|e.to_string())?;
    Ok(json!(id))
}

pub(crate) fn machine_code(error: &str) -> String {
    if matches!(error, "UNCLASSIFIED_REFUSAL" | "AWAITING_CONFIRMATION") {
        return error.into();
    }
    // Only the leading machine-code envelope, never tokens from the message
    // or its quoted payload values. Prefer the precise code after HTTP_xxx.
    let head: String = error
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_' || *c == ':')
        .take(192)
        .collect();
    head.split(':')
        .rev()
        .find(|word| {
            word.len() <= 96
                && word.contains('_')
                && [
                    "ORDER_",
                    "PAYMENT_",
                    "EDIT_",
                    "AUTOMATIC_",
                    "CONCURRENT_",
                    "UNKNOWN_",
                    "INVALID_",
                    "PLATFORM_",
                    "MISSING_",
                    "REMOTE_",
                    "FINANCIAL_",
                    "PARENT_",
                    "REMEDY_",
                    "POS_",
                    "HTTP_",
                    "TABLE_",
                    "FISCAL_",
                ]
                .iter()
                .any(|prefix| word.starts_with(prefix))
        })
        .unwrap_or("UNCLASSIFIED_REFUSAL")
        .to_string()
}

fn attempt(
    conn: &Connection,
    id: &str,
    automatic: bool,
    state: &str,
    refusal: &str,
) -> Result<Value, String> {
    let raw: Option<String> = conn.query_row("SELECT payload_json FROM recovery_action_log WHERE (issue_id=?1 OR entity_id=?1 OR json_extract(payload_json,'$.retiredQueueId')=?1 OR json_extract(payload_json,'$.replacementQueueId')=?1 OR json_extract(payload_json,'$.params.queueId')=?1 OR json_extract(payload_json,'$.noticeQueueId')=?1) AND COALESCE(json_extract(payload_json,'$.automatic'),0)=?2 ORDER BY created_at DESC LIMIT 1", params![id, automatic], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let Some(raw) = raw else {
        return Ok(json!({"ran":false,"outcome":"not_run","reason":"NOT_ATTEMPTED"}));
    };
    let data: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let replacement_refused =
        state == "refused" && (data["outcome"] == "pending" || data["replacementQueueId"] == id);
    let outcome = if replacement_refused {
        "failed"
    } else {
        match data["outcome"].as_str() {
            Some("running" | "pending") => "pending",
            Some("resolved" | "verified" | "succeeded" | "confirmed") => "confirmed",
            Some("failed") => "failed",
            Some("set_aside") => "set_aside",
            _ => "unknown",
        }
    };
    let reason = if replacement_refused {
        if refusal == "UNCLASSIFIED_REFUSAL" {
            "REPLACEMENT_REFUSED".into()
        } else {
            refusal.to_string()
        }
    } else {
        data["machineReason"]
            .as_str()
            .or_else(|| data["errorMessage"].as_str())
            .map(machine_code)
            .unwrap_or_else(|| "ATTEMPT_REASON_UNAVAILABLE".into())
    };
    Ok(json!({"ran":true,"outcome":outcome,"reason":reason}))
}

pub(crate) fn collect(conn: &Connection) -> Result<Value, String> {
    let notices = crate::order_notice_recovery::notices(conn, None)?;
    let mut evidence = Vec::new();
    for notice in notices.as_array().ok_or("ORDER_NOTICE_READ_FAILED")? {
        let age: i64 = conn
            .query_row(
                "SELECT MAX(0,CAST(COALESCE((julianday('now')-julianday(?1))*86400000,0) AS INTEGER))",
                [notice["since"].as_str()],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let id = notice["queueId"]
            .as_str()
            .ok_or("ORDER_NOTICE_READ_FAILED")?;
        let row: Option<(String,String,String,String)> = if let Some(financial) = id.strip_prefix("financial:") {
            conn.query_row("SELECT entity_type,operation,COALESCE(last_error,''),payload FROM sync_queue WHERE CAST(id AS TEXT)=?1", [financial], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()
        } else {
            conn.query_row("SELECT table_name,operation,COALESCE(error_message,''),data FROM parity_sync_queue WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()
        }.map_err(|e| e.to_string())?;
        let (table, operation, mut error, raw) =
            row.unwrap_or_else(|| ("orders".into(), "UPDATE".into(), String::new(), "{}".into()));
        let previous: Option<String> = conn.query_row("SELECT payload_json FROM recovery_action_log WHERE json_extract(payload_json,'$.replacementQueueId')=?1 OR id=?2 OR (issue_id=?1 AND json_extract(payload_json,'$.employeeOrderAttempt')=1) ORDER BY created_at DESC LIMIT 1", params![id,format!("automatic-order-header:{id}")], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
        let previous = previous
            .and_then(|data| serde_json::from_str::<Value>(&data).ok())
            .unwrap_or(Value::Null);
        if notice["state"] == "pending" {
            if let Some(reason) = previous["reason"].as_str() {
                error = reason.into();
            }
        }
        let original_age: i64 = conn
            .query_row(
                "SELECT MAX(0,CAST(COALESCE((julianday('now')-julianday(?1))*86400000,0) AS INTEGER))",
                [previous["openedAt"].as_str()],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let age = age.max(original_age);
        let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let shape = if table != "orders" {
            "money"
        } else if crate::sync_queue::has_only_order_header_keys(&payload) {
            "header-only"
        } else if payload.get("items").is_some() {
            "items"
        } else if payload.get("settlement").is_some()
            || payload.get("settlement_context").is_some()
            || payload.get("payment_status").is_some()
            || payload.get("paymentStatus").is_some()
        {
            "settlement"
        } else if [
            "total_amount",
            "totalAmount",
            "payment_method",
            "paymentMethod",
            "discount_amount",
            "discountAmount",
            "tip_amount",
            "tipAmount",
        ]
        .iter()
        .any(|key| payload.get(key).is_some())
        {
            "money"
        } else {
            "other"
        };
        let state = notice["state"].as_str().unwrap_or("refused");
        let refusal_code = refusal_code(&error, state, previous["reason"].as_str());
        let mut automatic = attempt(conn, id, true, state, &refusal_code)?;
        if automatic["ran"] == false {
            automatic["reason"] = json!(if notice["kind"] != "customer_correction_refused" {
                "AUTOMATIC_NOT_SUPPORTED"
            } else if notice["unavailableReason"] == "offline" {
                "AUTOMATIC_OFFLINE"
            } else if notice["unavailableReason"] == "busy" {
                "CONCURRENT_OPERATION"
            } else if crate::order_notice_auto::editing(
                notice["orderId"].as_str().unwrap_or_default()
            ) {
                "ORDER_BEING_EDITED"
            } else {
                "AUTOMATIC_NOT_ELIGIBLE"
            });
        }
        if automatic["ran"] == false {
            if let Some(reason) = crate::order_notice_auto::deferred_reason(id) {
                automatic["reason"] = json!(reason);
            }
        }
        let employee = attempt(conn, id, false, state, &refusal_code)?;
        evidence.push(json!({"issue_kind":notice["kind"],"refusal_code":refusal_code,"table_name":table_name(&table),"operation":operation_name(&operation),"shape_class":shape,
            "automatic_attempt":automatic,"employee_attempt":employee,"open_for_ms":age,"app_version":env!("CARGO_PKG_VERSION")}));
    }
    Ok(json!(evidence))
}

fn refusal_code(error: &str, state: &str, retained_reason: Option<&str>) -> String {
    let code = machine_code(error);
    if code == "UNCLASSIFIED_REFUSAL"
        && state != "refused"
        && retained_reason.is_none_or(|reason| reason.is_empty())
    {
        "AWAITING_CONFIRMATION".into()
    } else {
        code
    }
}

fn table_name(table: &str) -> &str {
    match table {
        "payment" | "payments" | "order_payments" => "order_payments",
        "payment_adjustment" | "payment_adjustments" => "payment_adjustments",
        _ => "orders",
    }
}

fn operation_name(operation: &str) -> &'static str {
    match operation.to_ascii_lowercase().as_str() {
        "insert" => "insert",
        "delete" => "delete",
        _ => "update",
    }
}

/// Android's wire layout: no array exceeds the incident sanitizer's 50-item
/// limit, including the list of overflow pages itself.
pub(crate) fn report_payload(issues: &[Value]) -> Value {
    let mut evidence =
        json!({"order_issue_count":issues.len(),"order_issues":&issues[..issues.len().min(50)]});
    if issues.len() > 50 {
        let mut pages: Vec<Value> = issues[50..].chunks(50).map(|page| json!(page)).collect();
        while pages.len() > 50 {
            pages = pages.chunks(50).map(|page| json!(page)).collect();
        }
        evidence["order_issue_pages"] = json!(pages);
    }
    evidence
}

/// Used for lifecycle decisions too: a failed attempt on an overflow page
/// must not be mistaken for a group in which every automatic attempt waits.
pub(crate) fn report_entries(evidence: &Value) -> Vec<&Value> {
    let mut result = Vec::new();
    let mut stack: Vec<&Value> = ["order_issue_pages", "order_issues"]
        .iter()
        .filter_map(|key| evidence.get(*key))
        .collect();
    while let Some(value) = stack.pop() {
        if let Some(page) = value.as_array() {
            stack.extend(page.iter().rev());
        } else if value.is_object() {
            result.push(value);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Landing reader's documented fixture, copied as values only. No
    // cross-app import: this test pins exactly what the desktop sends.
    fn admin_fixture() -> Value {
        json!({"issue_kind":"change_refused","refusal_code":"ORDER_VERSION_CONFLICT","table_name":"orders",
            "operation":"update","shape_class":"items","open_for_ms":60000,"app_version":"1.2.3",
            "automatic_attempt":{"ran":true,"outcome":"failed","reason":"ORDER_VERSION_CONFLICT"},
            "employee_attempt":{"ran":false,"outcome":"not_run","reason":"NO_ACTION"}})
    }

    // Independent consumer expectations: recursively append pages, require
    // real booleans/numeric ages and preserve machine-token case/spelling.
    fn admin_entries<'a>(value: &'a Value, entries: &mut Vec<&'a Value>) {
        if let Some(page) = value.as_array() {
            assert!(page.len() <= 50);
            for child in page {
                admin_entries(child, entries);
            }
        } else {
            let entry = value.as_object().expect("admin entry object");
            let expected = [
                "issue_kind",
                "refusal_code",
                "table_name",
                "operation",
                "shape_class",
                "automatic_attempt",
                "employee_attempt",
                "open_for_ms",
                "app_version",
            ];
            assert_eq!(entry.len(), expected.len());
            assert!(expected.iter().all(|key| entry.contains_key(*key)));
            assert!(value["open_for_ms"].as_u64().is_some());
            assert!(value["app_version"].is_string() || value["app_version"].is_null());
            for field in ["automatic_attempt", "employee_attempt"] {
                assert_eq!(value[field].as_object().unwrap().len(), 3);
                assert!(value[field]["ran"].is_boolean());
                assert!([
                    "not_run",
                    "pending",
                    "failed",
                    "confirmed",
                    "set_aside",
                    "unknown"
                ]
                .contains(&value[field]["outcome"].as_str().unwrap()));
                assert!(value[field]["reason"].is_string() || value[field]["reason"].is_null());
            }
            entries.push(value);
        }
    }

    #[test]
    fn evidence_matches_admin_reader_53_entry_aggregation_contract() {
        let mut issues = vec![admin_fixture(); 53];
        issues[50]["open_for_ms"] = json!(123456);
        issues[50]["app_version"] = json!("1.2.4");
        issues[52]["operation"] = json!("insert");
        let wire = crate::diagnostics::redact_remote_diagnostics_value(report_payload(&issues));
        assert_eq!(wire.as_object().unwrap().len(), 3);
        assert_eq!(wire["order_issue_count"], 53);
        assert_eq!(wire["order_issues"].as_array().unwrap().len(), 50);
        let mut parsed = Vec::new();
        admin_entries(&wire["order_issues"], &mut parsed);
        admin_entries(&wire["order_issue_pages"], &mut parsed);
        assert_eq!(parsed.len(), 53);
        assert!(parsed
            .iter()
            .all(|entry| entry["issue_kind"] == "change_refused"
                && entry["refusal_code"] == "ORDER_VERSION_CONFLICT"));
        let updates: Vec<_> = parsed
            .iter()
            .filter(|entry| entry["operation"] == "update")
            .collect();
        assert_eq!(updates.len(), 52);
        assert_eq!(
            updates
                .iter()
                .map(|entry| entry["open_for_ms"].as_u64().unwrap())
                .max(),
            Some(123456)
        );
        assert_eq!(
            updates
                .iter()
                .map(|entry| entry["app_version"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>(),
            ["1.2.3", "1.2.4"].into_iter().collect()
        );
        assert!(updates.iter().all(|entry| entry["automatic_attempt"]
            == admin_fixture()["automatic_attempt"]
            && entry["employee_attempt"]["ran"] == false));
        assert_eq!(parsed[52]["operation"], "insert");
    }

    #[test]
    fn evidence_pages_keep_every_array_within_the_server_limit() {
        for count in [0, 1, 50, 51, 2551, 5003] {
            let wire = report_payload(&vec![admin_fixture(); count]);
            assert_eq!(wire["order_issue_count"], count);
            let mut entries = Vec::new();
            admin_entries(&wire["order_issues"], &mut entries);
            if count > 50 {
                admin_entries(&wire["order_issue_pages"], &mut entries);
            } else {
                assert!(wire.get("order_issue_pages").is_none());
            }
            assert_eq!(entries.len(), count);
            assert_eq!(report_entries(&wire).len(), count);
        }
    }

    #[test]
    fn evidence_normalizes_table_operation_and_unknown_wait_markers() {
        for (source, expected) in [
            ("payment", "order_payments"),
            ("payments", "order_payments"),
            ("order_payments", "order_payments"),
            ("payment_adjustment", "payment_adjustments"),
            ("payment_adjustments", "payment_adjustments"),
            ("orders", "orders"),
        ] {
            assert_eq!(table_name(source), expected);
        }
        for (source, expected) in [
            ("INSERT", "insert"),
            ("Update", "update"),
            ("delete", "delete"),
        ] {
            assert_eq!(operation_name(source), expected);
        }
        assert_eq!(refusal_code("", "waiting", None), "AWAITING_CONFIRMATION");
        assert_eq!(refusal_code("", "refused", None), "UNCLASSIFIED_REFUSAL");
        assert_eq!(
            refusal_code("legacy text", "pending", Some("legacy text")),
            "UNCLASSIFIED_REFUSAL"
        );
        assert_eq!(
            refusal_code("ORDER_EDIT_CONFLICT", "pending", None),
            "ORDER_EDIT_CONFLICT"
        );
        assert_eq!(
            machine_code("AWAITING_CONFIRMATION"),
            "AWAITING_CONFIRMATION"
        );
    }

    #[test]
    fn evidence_maps_local_attempts_to_only_admin_outcomes_and_reasons() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE recovery_action_log(issue_id TEXT,entity_id TEXT,created_at TEXT,payload_json TEXT);").unwrap();
        assert_eq!(
            attempt(&conn, "q", false, "waiting", "AWAITING_CONFIRMATION").unwrap(),
            json!({"ran":false,"outcome":"not_run","reason":"NOT_ATTEMPTED"})
        );
        for (local, expected) in [
            ("running", "pending"),
            ("pending", "pending"),
            ("failed", "failed"),
            ("resolved", "confirmed"),
            ("verified", "confirmed"),
            ("succeeded", "confirmed"),
            ("set_aside", "set_aside"),
            ("unrecognized", "unknown"),
        ] {
            conn.execute("DELETE FROM recovery_action_log", []).unwrap();
            conn.execute(
                "INSERT INTO recovery_action_log VALUES ('q','q','now',?1)",
                [json!({"outcome":local,"machineReason":"ORDER_VERSION_CONFLICT"}).to_string()],
            )
            .unwrap();
            assert_eq!(
                attempt(&conn, "q", false, "waiting", "AWAITING_CONFIRMATION").unwrap(),
                json!({"ran":true,"outcome":expected,"reason":"ORDER_VERSION_CONFLICT"})
            );
        }
        conn.execute(
            "UPDATE recovery_action_log SET payload_json=?1",
            [json!({"outcome":"pending","machineReason":"ORDER_OLD_REASON"}).to_string()],
        )
        .unwrap();
        assert_eq!(
            attempt(&conn, "q", false, "refused", "ORDER_EDIT_CONFLICT").unwrap(),
            json!({"ran":true,"outcome":"failed","reason":"ORDER_EDIT_CONFLICT"})
        );
    }
}
