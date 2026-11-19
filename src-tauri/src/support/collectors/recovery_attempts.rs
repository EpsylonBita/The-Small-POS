//! Closed projection of the correction owner's audit. Raw requests remain local.
use crate::support::{clock, contracts, critical_op::SupportPermit, guards::Scope};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(crate) const CAPABILITY: &str = "support.recovery-attempts.v1";

pub(crate) fn owner_refusal(code: &str) -> bool {
    enum_contains("SupportOwnerRefusalCodeSchema", code)
}

fn enum_contains(schema: &str, value: &str) -> bool {
    contracts::shared().other["schemas"][schema]["enum"]
        .as_array()
        .is_some_and(|values| values.iter().any(|known| known == value))
}

fn queue_reference(id: Option<&str>) -> Option<Value> {
    let id = id?;
    if !(1..=200).contains(&id.len()) || !super::super::delivery::recovery_reference(id) {
        return None;
    }
    Some(json!({"kind":"queue","id":id}))
}

fn iso(raw: Option<&str>) -> Option<String> {
    raw.and_then(|raw| clock::parse(raw).ok()).map(clock::iso)
}

pub(crate) fn collect(
    conn: &Connection,
    input: &Value,
    scope: &Scope,
    permit: &SupportPermit,
) -> Result<Value, String> {
    let observed = clock::iso(chrono::Utc::now().timestamp_millis());
    let max = contracts::cap("recoveryAttempts", "maxRows");
    let limit = input["limit"].as_u64().unwrap_or(max).clamp(1, max);
    let order_id = input["order_id"].as_str();
    let read = || {
        let mut stmt = conn.prepare(
            "WITH scoped AS (
                SELECT a.id,a.created_at,a.recipe_id,a.recipe_version,a.order_id,
                    CASE WHEN json_valid(a.payload_json) THEN a.payload_json END AS facts
                FROM recovery_action_log a JOIN orders o ON o.id=a.order_id
                WHERE o.organization_id=?1 AND o.branch_id=?2 AND o.terminal_id=?3
                  AND (?4 IS NULL OR o.id=?4)
                  AND a.recipe_id IN ('order-customer-correction.resend','order-customer-correction.keep-server')
            ), attempts AS (
                SELECT id,created_at AS at,recipe_id,recipe_version,order_id,
                    json_extract(facts,'$.retiredQueueId') AS source,
                    CASE WHEN json_extract(facts,'$.automatic')=1 THEN 'automatic'
                         ELSE COALESCE(json_extract(facts,'$.actor'),'employee') END AS actor,
                    json_extract(facts,'$.outcome') AS outcome,json_extract(facts,'$.reason') AS reason,
                    json_extract(facts,'$.replacementQueueId') AS replacement,json_extract(facts,'$.verifiedAt') AS verified
                FROM scoped WHERE json_extract(facts,'$.nativeOrderCorrection')=1
                UNION ALL
                SELECT id,created_at,recipe_id,recipe_version,order_id,json_extract(facts,'$.retiredQueueId'),
                    'automatic','intent',json_extract(facts,'$.reason'),NULL,NULL
                FROM scoped WHERE json_extract(facts,'$.automaticIntent')=1
                UNION ALL
                SELECT scoped.id,COALESCE(json_extract(failure.value,'$.finishedAt'),created_at),recipe_id,recipe_version,order_id,
                    json_extract(facts,'$.retiredQueueId'),'automatic','failed',json_extract(failure.value,'$.reason'),NULL,NULL
                FROM scoped JOIN json_each(facts,'$.attemptFailures') AS failure
                  WHERE json_extract(facts,'$.automaticIntent')=1 AND failure.type='object'
                UNION ALL
                SELECT id,created_at,recipe_id,recipe_version,order_id,json_extract(facts,'$.retiredQueueId'),
                    'automatic','failed',json_extract(facts,'$.machineReason'),NULL,NULL
                FROM scoped WHERE json_extract(facts,'$.automaticIntent')=1
                  AND json_extract(facts,'$.outcome')='failed' AND COALESCE(json_array_length(facts,'$.attemptFailures'),0)=0
             ) SELECT at,recipe_id,recipe_version,order_id,source,actor,outcome,reason,replacement,verified
               FROM attempts ORDER BY julianday(at) DESC,id,outcome LIMIT ?5",
        )?;
        let mut dropped = 0;
        let mut attempts = Vec::new();
        let mut rows = stmt.query(params![
            scope.organization_id,
            scope.branch_id,
            scope.terminal_id,
            order_id,
            limit + 1
        ])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            count += 1;
            if count > limit {
                break;
            }
            let Some(at) = iso(row.get::<_, Option<String>>(0)?.as_deref()) else {
                dropped += 1;
                continue;
            };
            let recipe_id: String = row.get(1)?;
            let recipe = (row.get::<_, Option<u64>>(2)? == Some(1))
                .then_some(json!({"id":recipe_id,"version":1}));
            let order: String = row.get(3)?;
            let order = uuid::Uuid::parse_str(&order).ok().map(|_| order);
            let source = queue_reference(row.get::<_, Option<String>>(4)?.as_deref());
            let actor: String = row.get(5)?;
            let actor = match actor.as_str() {
                "automatic" | "employee" | "founder_confirmed" => actor.as_str(),
                _ => "unknown",
            };
            let outcome = row.get::<_, Option<String>>(6)?;
            let outcome = match outcome.as_deref() {
                Some(value @ ("intent" | "pending" | "resolved" | "failed" | "set_aside")) => value,
                _ => "unknown",
            };
            let reason = row
                .get::<_, Option<String>>(7)?
                .filter(|code| enum_contains("QueueRefusalCodeSchema", code));
            let replacement = queue_reference(row.get::<_, Option<String>>(8)?.as_deref());
            let verified = iso(row.get::<_, Option<String>>(9)?.as_deref());
            attempts.push(json!({"at":at,"recipe":recipe,"order_id":order,"source":source,"actor":actor,
                "outcome":outcome,"reason_code":reason,"replacement":replacement,"verified_at":verified}));
        }
        Ok::<_, rusqlite::Error>((attempts, count > limit, dropped))
    };
    let result = read();
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    Ok(match result {
        Ok((attempts, truncated, dropped)) => {
            json!({"section":"recovery_attempts","observation_time":observed,
            "collector_status":if truncated || dropped > 0 {"partial"}else{"ok"},
            "truncation":if truncated {json!([{"field":"attempts","reason":"rows"}])}else{json!([])},
            "redaction_dropped":dropped,"content":{"kind":"untrusted_till_data","attempts":attempts}})
        }
        Err(_) => {
            json!({"section":"recovery_attempts","observation_time":observed,"collector_status":"unavailable",
            "truncation":[],"redaction_dropped":0,"content":null})
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_intent_is_distinct_from_attempted_action_and_scope() {
        use crate::commands::recovery::tests::{
            order_notice_tomikro_fixture, TOMIKRO_ORDER, TOMIKRO_QUEUE,
        };
        let _keys = crate::tests::fake_keyring::install_empty();
        let _gate = crate::support::critical_op::install_test_gate();
        let (db, _) = order_notice_tomikro_fixture();
        let conn = db.state.conn.lock().unwrap();
        let put = |id: &str, at: &str, facts: Value| {
            conn.execute(
            "INSERT INTO recovery_action_log(id,action_id,issue_code,issue_id,recipe_id,recipe_version,entity_type,entity_id,order_id,success,created_at,payload_json)
             VALUES(?1,'resendOrderCustomerCorrection','customer_correction_refused',?2,'order-customer-correction.resend',1,'order',?3,?3,0,?4,?5)",
            params![id,TOMIKRO_QUEUE,TOMIKRO_ORDER,at,facts.to_string()],
        ).unwrap()
        };
        put(
            "attempt-intent",
            "2026-11-18T11:11:00.000Z",
            json!({"automaticIntent":true,"automatic":true,
            "retiredQueueId":TOMIKRO_QUEUE,"retiredRequest":"Sentinel private original", "outcome":"pending"}),
        );
        put(
            "attempt-action",
            "2026-11-18T11:12:00.000Z",
            json!({"nativeOrderCorrection":true,"automatic":true,
            "retiredQueueId":TOMIKRO_QUEUE,"replacementQueueId":"your-replacement","outcome":"pending"}),
        );
        let permit = crate::support::critical_op::global()
            .try_begin_support(false, None)
            .unwrap();
        let mut scope = crate::support::identity::local(&conn).unwrap();
        let history = collect(&conn, &json!({"order_id":TOMIKRO_ORDER}), &scope, &permit).unwrap();
        let data = history["content"]["attempts"].as_array().unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(
            (data[0]["actor"].as_str(), data[0]["outcome"].as_str()),
            (Some("automatic"), Some("pending"))
        );
        assert_eq!(data[0]["replacement"]["id"], "your-replacement");
        assert_eq!(
            (data[1]["actor"].as_str(), data[1]["outcome"].as_str()),
            (Some("automatic"), Some("intent"))
        );
        assert!(data[1]["replacement"].is_null());
        assert!(!history.to_string().contains("Sentinel"));
        scope.terminal_id = "unrelated-terminal".into();
        assert_eq!(
            collect(&conn, &json!({}), &scope, &permit).unwrap()["content"]["attempts"],
            json!([])
        );
    }
}
