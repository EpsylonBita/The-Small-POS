//! Durable intent to admit a receipt to the fiscal queue, independent of order success.

use rusqlite::{params, Connection};
use serde_json::json;

use super::close_day_guard::FiscalCloseScope;

const CATEGORY: &str = "fiscal_admission_owed";
pub const RETRY_LIMIT: i64 = 25;

pub fn mark_owed(conn: &Connection, order_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO local_settings (setting_category, setting_key, setting_value)
         VALUES (?1, ?2, ?3) ON CONFLICT(setting_category, setting_key) DO NOTHING",
        params![
            CATEGORY,
            order_id,
            json!({"since": chrono::Utc::now().to_rfc3339(),
            "attempts": 0, "lastError": null})
            .to_string()
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("mark fiscal admission owed: {e}"))
}

pub fn clear(conn: &Connection, order_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM local_settings WHERE setting_category = ?1 AND setting_key = ?2",
        params![CATEGORY, order_id],
    )
    .map(|_| ())
    .map_err(|e| format!("clear fiscal admission owed: {e}"))
}

pub fn note_failure(conn: &Connection, order_id: &str, error: &str) -> Result<(), String> {
    let error = crate::print::safe_operational_error(Some(error.to_string()), 256);
    conn.execute(
        "UPDATE local_settings SET setting_value = json_set(setting_value,
             '$.attempts', COALESCE(json_extract(setting_value, '$.attempts'), 0) + 1,
             '$.lastError', ?3), updated_at = datetime('now')
         WHERE setting_category = ?1 AND setting_key = ?2",
        params![CATEGORY, order_id, error],
    )
    .map(|_| ())
    .map_err(|e| format!("note fiscal admission failure: {e}"))
}

/// Fewest attempts first, then oldest: a receipt that can never be built must
/// not starve the others out of the bounded retry.
pub fn list_owed(conn: &Connection, limit: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT setting_key FROM local_settings WHERE setting_category = ?1
         ORDER BY COALESCE(json_extract(setting_value, '$.attempts'), 0),
                  julianday(json_extract(setting_value, '$.since')), setting_key LIMIT ?2",
        )
        .map_err(|e| format!("list fiscal admissions owed: {e}"))?;
    let rows = stmt
        .query_map(params![CATEGORY, limit.clamp(1, RETRY_LIMIT)], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn count_owed_in_window(conn: &Connection, scope: &FiscalCloseScope) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM local_settings s JOIN orders o ON o.id = s.setting_key
         WHERE s.setting_category = ?1 AND o.branch_id = ?2
           AND ((?5 = 1 AND julianday(o.created_at) >= julianday(?3))
             OR (?5 = 0 AND julianday(o.created_at) > julianday(?3)))
           AND (?4 IS NULL OR julianday(o.created_at) <= julianday(?4))",
        params![
            CATEGORY,
            scope.branch_id,
            scope.period_start_at,
            scope.cutoff_at,
            i64::from(scope.lower_bound_inclusive)
        ],
        |row| row.get(0),
    )
    .map_err(|e| format!("count fiscal admissions owed: {e}"))
}

/// One local attempt per oldest mark. No network or error escapes into sync.
pub fn retry_owed(conn: &Connection) {
    let result = (|| -> Result<(), String> {
        for order_id in list_owed(conn, RETRY_LIMIT)? {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM orders WHERE id = ?1)",
                    [&order_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            let attempt = if exists {
                retry_one(conn, &order_id)
            } else {
                clear(conn, &order_id)
            };
            if let Err(error) = attempt {
                tracing::warn!(%order_id, %error, "Fiscal admission retry failed");
                if let Err(error) = note_failure(conn, &order_id, &error) {
                    tracing::warn!(%order_id, %error, "Could not retain fiscal admission failure");
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(%error, "Could not retry fiscal admissions owed");
    }
}

fn retry_one(conn: &Connection, order_id: &str) -> Result<(), String> {
    // Queue admission and intent removal must commit together. Retain the
    // order's window even when recovery happens after a frozen Z cutoff.
    conn.execute_batch("SAVEPOINT fiscal_admission_retry")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        super::dispatcher::enqueue_for_order(conn, order_id)?;
        conn.execute(
            "UPDATE parity_sync_queue SET created_at = (SELECT created_at FROM orders WHERE id = ?1)
             WHERE module_type = 'fiscal' AND table_name = 'fiscal_submission' AND record_id = ?1",
            [order_id],
        ).map_err(|e| e.to_string())?;
        clear(conn, order_id)
    })()
    .and_then(|()| {
        conn.execute_batch("RELEASE fiscal_admission_retry")
            .map_err(|e| e.to_string())
    });
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            conn.execute_batch(
                "ROLLBACK TO fiscal_admission_retry; RELEASE fiscal_admission_retry",
            )
            .map_err(|e| format!("{error}; rollback fiscal admission retry: {e}"))?;
            Err(error)
        }
    }
}
