use reqwest::Url;

use crate::{
    db, value_f64, value_str, ALLOWED_EXTERNAL_HOSTS, ALLOWED_EXTERNAL_HOST_SUFFIXES,
    EXTERNAL_URL_MAX_LEN,
};

pub(crate) fn read_local_json(db: &db::DbState, key: &str) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let raw = db::get_setting(&conn, "local", key);
    if let Some(raw) = raw {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(parsed);
        }
    }
    Ok(serde_json::Value::Null)
}

pub(crate) fn read_local_json_array(
    db: &db::DbState,
    key: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let parsed = read_local_json(db, key)?;
    Ok(parsed.as_array().cloned().unwrap_or_default())
}

pub(crate) fn write_local_json(
    db: &db::DbState,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "local", key, &value.to_string())
}

pub(crate) fn normalize_phone(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
}

pub(crate) fn resolve_order_id(conn: &rusqlite::Connection, order_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
        rusqlite::params![order_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

#[allow(clippy::type_complexity)]
pub(crate) fn load_orders_for_period(
    conn: &rusqlite::Connection,
    branch_id: &str,
    date_from: &str,
    date_to: &str,
) -> Result<
    Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    )>,
    String,
> {
    let mut stmt = conn
        .prepare(
            "SELECT id, status, created_at, items, staff_id, payment_method
             FROM orders
             WHERE (?1 = '' OR branch_id = ?1)
               AND COALESCE(is_ghost, 0) = 0
               AND substr(created_at, 1, 10) >= ?2
               AND substr(created_at, 1, 10) <= ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![branch_id, date_from, date_to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub(crate) fn parse_item_totals(items_json: &str) -> (f64, std::collections::HashMap<String, f64>) {
    let mut total = 0.0;
    let mut by_name: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let parsed =
        serde_json::from_str::<serde_json::Value>(items_json).unwrap_or(serde_json::json!([]));
    if let Some(items) = parsed.as_array() {
        for item in items {
            let qty = value_f64(item, &["quantity"]).unwrap_or(1.0).max(0.0);
            let line_total = value_f64(item, &["total_price", "totalPrice"]).unwrap_or_else(|| {
                value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0) * qty
            });
            total += line_total;
            let name = value_str(item, &["name", "item_name", "title"])
                .unwrap_or_else(|| "Item".to_string());
            *by_name.entry(name).or_insert(0.0) += qty.max(1.0);
        }
    }
    (total, by_name)
}

pub(crate) fn validate_external_url(
    url_raw: &str,
    db: Option<&db::DbState>,
) -> Result<Url, String> {
    let trimmed = url_raw.trim();
    if trimmed.is_empty() {
        return Err("External URL cannot be empty".into());
    }
    if trimmed.len() > EXTERNAL_URL_MAX_LEN {
        return Err("External URL is too long".into());
    }

    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid external URL: {e}"))?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err("Only http/https URLs are allowed".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Credentialed URLs are not allowed".into());
    }

    let host = parsed
        .host_str()
        .ok_or("External URL is missing a host")?
        .to_ascii_lowercase();
    let localhost_http = scheme == "http" && matches!(host.as_str(), "localhost" | "127.0.0.1");

    if !localhost_http {
        let mut custom_hosts: Vec<String> = Vec::new();
        if let Some(db_state) = db {
            if let Ok(conn) = db_state.conn.lock() {
                let raw = db::get_setting(&conn, "security", "allowed_external_hosts")
                    .or_else(|| db::get_setting(&conn, "system", "allowed_external_hosts"))
                    .unwrap_or_default();
                if let Ok(arr) = serde_json::from_str::<Vec<String>>(&raw) {
                    custom_hosts = arr
                        .into_iter()
                        .map(|s| s.trim().to_ascii_lowercase())
                        .filter(|s| !s.is_empty())
                        .collect();
                } else if !raw.trim().is_empty() {
                    custom_hosts = raw
                        .split(',')
                        .map(|s| s.trim().to_ascii_lowercase())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
        }

        let exact_allowed =
            ALLOWED_EXTERNAL_HOSTS.iter().any(|h| host == *h) || custom_hosts.contains(&host);
        let suffix_allowed = ALLOWED_EXTERNAL_HOST_SUFFIXES
            .iter()
            .any(|suffix| host.ends_with(suffix))
            || custom_hosts
                .iter()
                .any(|base| host.ends_with(&format!(".{base}")));
        if !exact_allowed && !suffix_allowed {
            return Err(format!("External host is not allowlisted: {host}"));
        }
    }

    Ok(parsed)
}
