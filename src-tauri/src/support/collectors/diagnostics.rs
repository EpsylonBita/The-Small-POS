use super::super::critical_op::SupportPermit;
use super::*;
pub fn collect(conn: &Connection, input: &Value, permit: &SupportPermit) -> Result<Value, String> {
    let mut result = collect_evidence(conn, input, permit)?;
    private_details(&mut result["content"]);
    Ok(result)
}
pub fn collect_evidence(
    conn: &Connection,
    input: &Value,
    permit: &SupportPermit,
) -> Result<Value, String> {
    let section = input["section"].as_str().ok_or("INVALID_INPUT")?;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let mut value = crate::diagnostics::support_bundle_section_evidence(conn, section, permit).unwrap_or_else(|error| {
        json!({"section":section,"collector_status":"unavailable","failure_detail_code":super::super::evidence::detail_of(&error).unwrap_or("HEALTH_OBSERVATION_MISSING"),"content":null,"truncation":[],"redaction_dropped":0})
    });
    if section == "closeout_readiness" && value["collector_status"] != "unavailable" {
        value["content"] = super::shifts::closeout_projection(Ok(value["content"].take()));
    }
    if section == "terminal_settings_snapshot" && value["collector_status"] != "unavailable" {
        value["content"] = super::settings::collect(conn)?;
    }
    // Owner diagnostics prose can contain names/IDs without a labelled PII key.
    // Keep operational counts/statuses; do not export arbitrary error prose.
    // Field/value privacy is applied once by the evidence policy at the tool boundary.
    Ok(value)
}
fn private_details(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                let key = key.replace('_', "").to_ascii_lowercase();
                if !value.is_null()
                    && [
                        "staffid",
                        "staffname",
                        "cashierid",
                        "driverid",
                        "customerid",
                        "lasterror",
                        "errormessage",
                        "error",
                        "notes",
                        "reconciliationnotes",
                        "blockerssummary",
                    ]
                    .contains(&key.as_str())
                {
                    *value = redaction::text(redaction::MARKER);
                } else {
                    private_details(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                private_details(value);
            }
        }
        _ => (),
    }
}
