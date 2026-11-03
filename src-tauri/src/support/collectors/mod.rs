pub mod diagnostics;
pub mod error_codes;
pub mod health;
pub mod logs;
pub mod modules;
pub mod printers;
pub mod settings;
pub mod shifts;
pub mod sync_queue;
use super::{redaction, replica};
use rusqlite::Connection;
use serde_json::{json, Value};
pub fn rows(conn: &Connection, sql: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(replica::sql_error)?;
    let cols = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let mut cursor = stmt.query([]).map_err(replica::sql_error)?;
    let mut result = Vec::new();
    while let Some(row) = cursor.next().map_err(replica::sql_error)? {
        if result.len() >= 500 {
            break;
        }
        let mut obj = serde_json::Map::new();
        for (i, name) in cols.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let v = match row.get_ref(i).map_err(replica::sql_error)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                ValueRef::Blob(_) => json!(redaction::MARKER),
            };
            obj.insert(name.clone(), v);
        }
        result.push(Value::Object(obj));
    }
    Ok(result)
}
pub fn setting(conn: &Connection, category: &str, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT setting_value FROM local_settings WHERE setting_category=?1 AND setting_key=?2",
        [category, key],
        |r| r.get(0),
    )
    .ok()
}
pub fn meta(mut value: Value) -> Result<Value, String> {
    value["observation_time"] = json!(chrono::Utc::now().to_rfc3339());
    value["app_version"] = json!(env!("CARGO_PKG_VERSION"));
    let mut redacted = redaction::record(value.clone()).ok_or("INTERNAL_ERROR")?;
    // Classification is protocol metadata, not credential prose. The generic
    // privacy pass masks the literal "secret"; restore only the closed enum at
    // SQL schema column paths, never a table/column name or arbitrary value.
    if let (Some(tables), Some(out)) = (
        value["tables"].as_array(),
        redacted.get_mut("tables").and_then(Value::as_array_mut),
    ) {
        for (table, out) in tables.iter().zip(out) {
            if let (Some(columns), Some(out)) =
                (table["columns"].as_array(), out["columns"].as_array_mut())
            {
                for (column, out) in columns.iter().zip(out) {
                    if let Some(class) = column["classification"]
                        .as_str()
                        .filter(|c| matches!(*c, "safe" | "pii" | "free_text" | "secret"))
                    {
                        out["classification"] = json!(class);
                    }
                }
            }
        }
    }
    Ok(redacted)
}

/// SQLite datetime() stores UTC without an offset. Never forward malformed
/// persisted dates across the support protocol's RFC 3339 boundary.
pub(super) fn timestamp(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|at| at.to_rfc3339())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|at| at.and_utc().to_rfc3339())
        })
}
