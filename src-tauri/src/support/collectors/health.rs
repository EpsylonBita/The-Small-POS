use super::*;
pub fn collect(conn: &Connection) -> Result<Value, String> {
    let observation = crate::diagnostics::support_health_observation(conn);
    let at = observation["at"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
    let stale = observation["failed"] == true
        || at.is_some_and(|t| {
            (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds() > 300
        });
    let content = &observation["content"];
    let available = content.is_object();
    let complete = at.is_some()
        && available
        && content["readFailures"]
            .as_array()
            .is_some_and(|v| v.is_empty());
    let mut issues = Vec::new();
    let failed_queue = content["parityQueueStatus"]["failed"].as_i64().unwrap_or(0)
        + content["parityQueueStatus"]["conflicts"]
            .as_i64()
            .unwrap_or(0);
    let failed_prints = content["printerStatus"]["recentJobs"]
        .as_array()
        .map(|jobs| jobs.iter().filter(|j| j["status"] == "failed").count() as i64)
        .unwrap_or(0);
    let legacy_failed = content["syncBacklog"]
        .as_object()
        .map(|tables| {
            tables
                .values()
                .map(|v| v["failed"].as_i64().unwrap_or(0) + v["conflict"].as_i64().unwrap_or(0))
                .sum::<i64>()
        })
        .unwrap_or(0);
    for (count, code, area) in [
        (failed_queue + legacy_failed, "sync.queue_failed", "sync"),
        (failed_prints, "printer.jobs_failed", "printing"),
        (
            content["invalidOrders"]["count"].as_i64().unwrap_or(0),
            "sync.invalid_orders",
            "sync",
        ),
        (
            content["checkoutPaymentBlockers"]["count"]
                .as_i64()
                .unwrap_or(0),
            "checkout.payment_blocked",
            "checkout",
        ),
    ] {
        if count > 0 {
            issues.push(json!({"code":code,"severity":"warning","area":area,"recommended_action_id":"open_health","recommended_action":redaction::text("Open Health to review the observation."),"observed_at":observation["at"],"stale":stale}));
        }
    }
    Ok(
        json!({"health_state":if !available {"unavailable"} else if stale {"stale"} else if !complete {"unavailable"} else if issues.is_empty() {"healthy"} else {"issues"},"last_observation_ok":complete && !stale,"last_observation_at":observation["at"],"issues":issues}),
    )
}
