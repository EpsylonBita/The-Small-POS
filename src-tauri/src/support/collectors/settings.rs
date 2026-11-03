use super::*;
pub fn collect(conn: &Connection) -> Result<Value, String> {
    let rows=rows(conn,"SELECT setting_category,setting_key,CASE WHEN lower(setting_key) LIKE '%pin%' OR lower(setting_key) LIKE '%token%' OR lower(setting_key) LIKE '%password%' OR lower(setting_key) LIKE '%secret%' OR lower(setting_key) LIKE '%api%key%' THEN CASE WHEN setting_value IS NULL OR setting_value='' THEN 'false' ELSE 'true' END ELSE setting_value END AS setting_value FROM local_settings LIMIT 501")?;
    let mut result = json!({"terminal":{},"branch":{},"organization":{},"credentials":{},"truncation":[],"redaction_dropped":0});
    let capped = rows.len() >= 500;
    for row in rows {
        let key = row["setting_key"].as_str().ok_or("INTERNAL_ERROR")?;
        let lower = key.to_ascii_lowercase();
        let secret = ["pin", "token", "password", "secret"]
            .iter()
            .any(|s| lower.contains(s))
            || (lower.contains("api") && lower.contains("key"));
        if secret {
            result["credentials"][key] = json!(row["setting_value"] == "true");
            continue;
        }
        let category = row["setting_category"].as_str().unwrap_or("terminal");
        let group = match category {
            "branch" => "branch",
            "organization" => "organization",
            _ => "terminal",
        };
        let key = format!("{category}/{key}");
        // Settings can embed entire customer or credential objects. Only the
        // shared operational keys are readable; arbitrary settings are masked.
        let text = row["setting_value"].as_str().unwrap_or("");
        let plain = row["setting_key"].as_str().unwrap_or("");
        result[group][&key] = if super::super::replica::safe_key(category, plain)
            || [
                "currency",
                "language",
                "timezone",
                "receipt_template",
                "paper_width_mm",
                "emulation",
                "code_page",
            ]
            .contains(&plain)
        {
            redaction::text(text)
        } else {
            json!(redaction::MARKER)
        };
    }
    if capped {
        result["truncation"] = json!([{"field":"settings","reason":"rows"}]);
    }
    Ok(result)
}
