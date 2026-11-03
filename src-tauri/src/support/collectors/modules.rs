use super::*;
use std::path::Path;
pub fn collect(conn: &Connection) -> Result<Value, String> {
    let live = conn.path().ok_or("INTERNAL_ERROR")?;
    let path = Path::new(live)
        .parent()
        .ok_or("INTERNAL_ERROR")?
        .join("module-cache.json");
    if std::fs::metadata(&path)
        .map_err(|_| "INTERNAL_ERROR")?
        .len()
        > 256 * 1024
    {
        return Err("RESULT_TOO_LARGE".into());
    }
    let cache: Value = serde_json::from_slice(&std::fs::read(path).map_err(|_| "INTERNAL_ERROR")?)
        .map_err(|_| "INTERNAL_ERROR")?;
    let org = setting(conn, "terminal", "organization_id")
        .or_else(|| setting(conn, "organization", "id"))
        .ok_or("INTERNAL_ERROR")?;
    if cache["organizationId"] != org {
        return Err("POLICY_REFUSED".into());
    }
    let list = cache["apiModules"].as_array().ok_or("INTERNAL_ERROR")?;
    let enabled = list
        .iter()
        .map(|v| {
            let id = v["module_id"]
                .as_str()
                .or_else(|| v["id"].as_str())
                .ok_or("POLICY_REFUSED")?;
            if !v["version"].is_null() && !v["version"].is_string() {
                return Err("POLICY_REFUSED");
            }
            Ok(json!({"id":id,"version":v["version"]}))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let filter = setting(conn, "terminal", "terminal_settings_snapshot")
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("enabled_modules")
                .or_else(|| v["settings"].get("enabled_modules"))
                .cloned()
        });
    if filter.as_ref().is_some_and(|v| {
        !v.is_null() && !v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
    }) {
        return Err("POLICY_REFUSED".into());
    }
    Ok(
        json!({"enabled_modules":enabled,"terminal_filter":filter,"last_module_sync_at":timestamp(&cache["apiTimestamp"]),"source":"cache"}),
    )
}
