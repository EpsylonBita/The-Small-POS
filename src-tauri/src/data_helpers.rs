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

/// SQL expression (correlated on `orders.id`) that derives an order's payment
/// method from its completed payment rows: `cash` / `card` / … / `split` when
/// more than one method settled it, `pending` when nothing completed. W6 (v55)
/// dropped the stored `orders.payment_method`; every report loader must use
/// this instead of the column (same rule as `sync::get_all_orders`).
pub(crate) const DERIVED_PAYMENT_METHOD_SQL: &str = "COALESCE((
    SELECT CASE
        WHEN COUNT(DISTINCT LOWER(TRIM(method))) > 1 THEN 'split'
        ELSE LOWER(TRIM(MIN(method)))
    END
    FROM order_payments op
    WHERE op.order_id = orders.id
      AND op.status = 'completed'
      AND TRIM(COALESCE(op.method, '')) != ''
), 'pending')";

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
    // W6 (v55) dropped the stored `orders.payment_method`; derive it from the
    // completed payment rows exactly like `sync::get_all_orders` does. Reading
    // the dropped column made this helper fail on every till at schema ≥ v55,
    // which silently emptied the Featured («Συχνές επιλογές») ranking and the
    // day reports built on it (live 06/09/2026, Το Μικρό Παρίσι).
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, status, created_at, items, staff_id, {DERIVED_PAYMENT_METHOD_SQL}
             FROM orders
             WHERE (
                    ?1 = ''
                    OR branch_id = ?1
                    OR TRIM(COALESCE(branch_id, '')) = ''
                   )
               AND COALESCE(is_ghost, 0) = 0
               AND COALESCE(is_test, 0) = 0
               AND substr(created_at, 1, 10) >= ?2
               AND substr(created_at, 1, 10) <= ?3"
        ))
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

#[cfg(test)]
mod tests {
    use super::*;

    // The fixture runs the REAL migrations: a hand-written `orders` table
    // with a `payment_method` column kept this test green after v55 dropped
    // that column in production, so the helper's `SELECT … payment_method`
    // failed on every till and nobody noticed (Featured ranking, today's
    // statistics, sales trend and staff performance all read empty).
    fn seed_order(
        conn: &rusqlite::Connection,
        id: &str,
        created_at: &str,
        branch_id: Option<&str>,
        is_test: i64,
    ) {
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, total_amount_cents,
                status, payment_status, is_test, created_at, updated_at
             ) VALUES (?1, ?1, ?2, '[]', 5.0, 500, 'completed', 'paid', ?3, ?4, ?4)",
            rusqlite::params![id, branch_id, is_test, created_at],
        )
        .expect("seed order");
    }

    #[test]
    fn branch_period_load_includes_legacy_unscoped_rows_but_excludes_other_branches() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory database");
        crate::db::run_migrations_for_test(&conn);
        seed_order(
            &conn,
            "matching",
            "2026-07-29T10:00:00Z",
            Some("branch-A"),
            0,
        );
        seed_order(&conn, "legacy-blank", "2026-07-29T11:00:00Z", Some(""), 0);
        seed_order(&conn, "legacy-null", "2026-07-29T12:00:00Z", None, 0);
        seed_order(&conn, "other", "2026-07-29T13:00:00Z", Some("branch-B"), 0);
        seed_order(
            &conn,
            "sandbox",
            "2026-07-29T14:00:00Z",
            Some("branch-A"),
            1,
        );

        let rows = load_orders_for_period(&conn, "branch-A", "2026-07-29", "2026-07-29")
            .expect("load period");
        let ids: std::collections::HashSet<_> = rows.into_iter().map(|row| row.0).collect();

        assert!(ids.contains("matching"));
        assert!(ids.contains("legacy-blank"));
        assert!(ids.contains("legacy-null"));
        assert!(!ids.contains("other"));
        assert!(
            !ids.contains("sandbox"),
            "sandbox/test orders must never reach report aggregations"
        );
    }

    #[test]
    fn branch_period_load_derives_payment_method_from_completed_payments_after_v55() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory database");
        crate::db::run_migrations_for_test(&conn);
        assert!(
            !crate::db::column_exists(&conn, "orders", "payment_method").unwrap(),
            "v55 must have dropped orders.payment_method — otherwise this test proves nothing"
        );
        seed_order(
            &conn,
            "cash-order",
            "2026-09-05T18:00:00Z",
            Some("branch-A"),
            0,
        );
        seed_order(
            &conn,
            "split-order",
            "2026-09-05T18:30:00Z",
            Some("branch-A"),
            0,
        );
        seed_order(
            &conn,
            "unpaid-order",
            "2026-09-05T19:00:00Z",
            Some("branch-A"),
            0,
        );
        let mut seed_payment = |id: &str, order_id: &str, method: &str| {
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, sync_status, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 2.5, 250, 'completed', 'synced', datetime('now'), datetime('now'))",
                rusqlite::params![id, order_id, method],
            )
            .expect("seed payment");
        };
        seed_payment("p1", "cash-order", "cash");
        seed_payment("p2", "split-order", "cash");
        seed_payment("p3", "split-order", "card");

        let rows = load_orders_for_period(&conn, "branch-A", "2026-09-05", "2026-09-05")
            .expect("load period must not read the dropped column");
        let method_by_id: std::collections::HashMap<String, Option<String>> =
            rows.into_iter().map(|row| (row.0, row.5)).collect();
        assert_eq!(method_by_id["cash-order"].as_deref(), Some("cash"));
        assert_eq!(method_by_id["split-order"].as_deref(), Some("split"));
        assert_eq!(method_by_id["unpaid-order"].as_deref(), Some("pending"));
    }
}
