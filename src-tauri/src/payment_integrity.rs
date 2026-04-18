use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};

use crate::business_day;

pub const UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE: &str = "UNSETTLED_PAYMENT_BLOCKER";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsettledPaymentBlocker {
    pub order_id: String,
    pub order_number: String,
    pub total_amount: f64,
    pub settled_amount: f64,
    pub payment_status: String,
    pub payment_method: String,
    pub reason_code: String,
    pub reason_text: String,
    pub suggested_fix: String,
}

#[derive(Clone, Debug)]
struct RawBlockerRow {
    order_id: String,
    order_number: String,
    total_amount: f64,
    settled_amount: f64,
    payment_status: String,
    payment_method: String,
    completed_payment_count: i64,
    invalid_completed_method_count: i64,
}

impl UnsettledPaymentBlocker {
    pub fn missing_local_payment_row(&self) -> bool {
        self.reason_code == "missing_local_payment_row"
    }
}

fn normalize_payment_status(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        "pending".to_string()
    } else {
        normalized
    }
}

fn normalize_payment_method(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        "pending".to_string()
    } else {
        normalized
    }
}

fn format_money(amount: f64) -> String {
    format!("EUR {:.2}", amount.max(0.0))
}

fn build_blocker(
    row: &RawBlockerRow,
    reason_code: &str,
    reason_text: String,
    suggested_fix: String,
) -> UnsettledPaymentBlocker {
    UnsettledPaymentBlocker {
        order_id: row.order_id.clone(),
        order_number: row.order_number.clone(),
        total_amount: row.total_amount,
        settled_amount: row.settled_amount,
        payment_status: row.payment_status.clone(),
        payment_method: row.payment_method.clone(),
        reason_code: reason_code.to_string(),
        reason_text,
        suggested_fix,
    }
}

fn classify_blocker_row(row: RawBlockerRow) -> Option<UnsettledPaymentBlocker> {
    if row.total_amount <= 0.009 {
        return None;
    }

    let remaining = (row.total_amount - row.settled_amount).max(0.0);

    if row.invalid_completed_method_count > 0 {
        let reason_text = if remaining <= 0.009 {
            "Completed payment rows contain an unsupported payment method.".to_string()
        } else {
            format!(
                "Completed payment rows contain an unsupported payment method and only {} of {} is recorded.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            )
        };
        return Some(build_blocker(
            &row,
            "unsupported_payment_method",
            reason_text,
            "Void the unsupported payment row and recollect the payment as cash or card."
                .to_string(),
        ));
    }

    if remaining <= 0.009 {
        return None;
    }

    if row.completed_payment_count <= 0 && row.payment_status == "paid" {
        return Some(build_blocker(
            &row,
            "missing_local_payment_row",
            "Order is marked paid but its local payment record is missing.".to_string(),
            "Refresh payment mirrors or recreate the missing payment record.".to_string(),
        ));
    }

    if row.completed_payment_count <= 0 {
        return Some(match row.payment_method.as_str() {
            "cash" => build_blocker(
                &row,
                "missing_cash_payment",
                "Order is missing its recorded cash payment.".to_string(),
                "Record or confirm the missing cash payment.".to_string(),
            ),
            "card" => build_blocker(
                &row,
                "missing_card_payment",
                "Order is missing its recorded card payment.".to_string(),
                "Record or confirm the missing card payment.".to_string(),
            ),
            "split" | "mixed" => build_blocker(
                &row,
                "split_payment_incomplete",
                format!(
                    "Split payment did not finish. {} of {} is still missing.",
                    format_money(remaining),
                    format_money(row.total_amount)
                ),
                "Resume split payment and finish the remaining balance.".to_string(),
            ),
            _ => build_blocker(
                &row,
                "no_persisted_payment",
                "Order was completed without a persisted cash/card payment.".to_string(),
                "Record the missing cash or card payment.".to_string(),
            ),
        });
    }

    if row.payment_method == "split"
        || row.payment_method == "mixed"
        || row.completed_payment_count > 1
    {
        return Some(build_blocker(
            &row,
            "split_payment_incomplete",
            format!(
                "Split payment is incomplete. Only {} of {} is recorded.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Resume split payment and finish the remaining balance.".to_string(),
        ));
    }

    Some(match row.payment_method.as_str() {
        "cash" => build_blocker(
            &row,
            "partial_cash_payment",
            format!(
                "Cash payments only cover {} of {}.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Record the remaining cash payment to continue.".to_string(),
        ),
        "card" => build_blocker(
            &row,
            "partial_card_payment",
            format!(
                "Card payments only cover {} of {}.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Record the remaining card payment to continue.".to_string(),
        ),
        _ => build_blocker(
            &row,
            "partial_payment_remaining",
            format!(
                "Only {} of {} is recorded.",
                format_money(row.settled_amount),
                format_money(row.total_amount)
            ),
            "Record the remaining balance as cash or card.".to_string(),
        ),
    })
}

fn order_blocker_row_select() -> String {
    "SELECT
        o.id,
        COALESCE(NULLIF(TRIM(o.order_number), ''), o.id),
        COALESCE(o.total_amount, 0),
        COALESCE((
            SELECT SUM(op.amount)
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
        ), 0),
        LOWER(TRIM(COALESCE(o.payment_status, 'pending'))),
        LOWER(TRIM(COALESCE(o.payment_method, 'pending'))),
        COALESCE((
            SELECT COUNT(*)
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
        ), 0),
        COALESCE((
            SELECT COUNT(*)
            FROM order_payments op
            WHERE op.order_id = o.id
              AND op.status = 'completed'
              AND LOWER(TRIM(COALESCE(op.method, ''))) NOT IN ('cash', 'card')
        ), 0)"
        .to_string()
}

fn map_blocker_rows<F>(
    rows: rusqlite::MappedRows<'_, F>,
) -> Result<Vec<UnsettledPaymentBlocker>, String>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<RawBlockerRow>,
{
    let mut blockers = Vec::new();
    for row in rows {
        let mut raw = row.map_err(|e| format!("collect payment blocker row: {e}"))?;
        raw.payment_status = normalize_payment_status(raw.payment_status.as_str());
        raw.payment_method = normalize_payment_method(raw.payment_method.as_str());
        if let Some(blocker) = classify_blocker_row(raw) {
            blockers.push(blocker);
        }
    }
    Ok(blockers)
}

pub fn load_order_payment_blockers(
    conn: &Connection,
    order_id: &str,
) -> Result<Vec<UnsettledPaymentBlocker>, String> {
    let sql = format!(
        "{} FROM orders o
         WHERE o.id = ?1
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')",
        order_blocker_row_select()
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare order payment blocker lookup: {e}"))?;
    let rows = stmt
        .query_map(params![order_id], |row| {
            Ok(RawBlockerRow {
                order_id: row.get(0)?,
                order_number: row.get(1)?,
                total_amount: row.get(2)?,
                settled_amount: row.get(3)?,
                payment_status: row.get(4)?,
                payment_method: row.get(5)?,
                completed_payment_count: row.get(6)?,
                invalid_completed_method_count: row.get(7)?,
            })
        })
        .map_err(|e| format!("query order payment blocker lookup: {e}"))?;

    map_blocker_rows(rows)
}

pub fn load_branch_window_payment_blockers(
    conn: &Connection,
    branch_id: &str,
    period_start_at: &str,
    cutoff_at: Option<&str>,
    lower_bound_inclusive: bool,
) -> Result<Vec<UnsettledPaymentBlocker>, String> {
    let operator = if lower_bound_inclusive { ">=" } else { ">" };
    let order_financial_expr = business_day::order_financial_timestamp_expr("o");
    let sql = format!(
        "{} FROM orders o
         WHERE {order_financial_expr} {operator} ?1
           AND (?2 IS NULL OR {order_financial_expr} <= ?2)
           AND (?3 = '' OR o.branch_id = ?3 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
         ORDER BY COALESCE(o.updated_at, o.created_at) ASC, o.id ASC",
        order_blocker_row_select()
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare branch payment blocker lookup: {e}"))?;
    let rows = stmt
        .query_map(params![period_start_at, cutoff_at, branch_id], |row| {
            Ok(RawBlockerRow {
                order_id: row.get(0)?,
                order_number: row.get(1)?,
                total_amount: row.get(2)?,
                settled_amount: row.get(3)?,
                payment_status: row.get(4)?,
                payment_method: row.get(5)?,
                completed_payment_count: row.get(6)?,
                invalid_completed_method_count: row.get(7)?,
            })
        })
        .map_err(|e| format!("query branch payment blocker lookup: {e}"))?;

    map_blocker_rows(rows)
}

pub fn build_unsettled_payment_blocker_message(
    action_label: &str,
    blockers: &[UnsettledPaymentBlocker],
) -> Option<String> {
    if blockers.is_empty() {
        return None;
    }

    let prefix = if action_label.ends_with(':') {
        action_label.to_string()
    } else {
        format!("{action_label}:")
    };

    if blockers.len() == 1 {
        let blocker = &blockers[0];
        return Some(format!(
            "{prefix} {} {} {}",
            blocker.order_number, blocker.reason_text, blocker.suggested_fix
        ));
    }

    let first = &blockers[0];
    Some(format!(
        "{prefix} {} orders are blocked by payment integrity. First blocker {}: {} {}",
        blockers.len(),
        first.order_number,
        first.reason_text,
        first.suggested_fix
    ))
}

pub fn build_unsettled_payment_blocker_response(
    action_label: &str,
    blockers: &[UnsettledPaymentBlocker],
) -> Value {
    let error = build_unsettled_payment_blocker_message(action_label, blockers)
        .unwrap_or_else(|| format!("{action_label}: unresolved payment blockers"));
    json!({
        "success": false,
        "errorCode": UNSETTLED_PAYMENT_BLOCKER_ERROR_CODE,
        "error": error,
        "message": error,
        "blockers": blockers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn test_db() -> crate::db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        crate::db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn branch_window_blockers_classify_missing_local_payment_row() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, status, payment_status,
                payment_method, created_at, updated_at
            ) VALUES (
                'ord-missing-local', 'ORD-1', 'branch-1', '[]', 13.7, 'completed', 'paid',
                'split', '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z'
            )",
            [],
        )
        .unwrap();

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].reason_code, "missing_local_payment_row");
        assert_eq!(blockers[0].order_number, "ORD-1");
    }

    #[test]
    fn branch_window_blockers_classify_partial_split_payment() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, branch_id, items, total_amount, status, payment_status,
                payment_method, created_at, updated_at
            ) VALUES (
                'ord-split', 'ORD-2', 'branch-1', '[]', 20.0, 'completed', 'partially_paid',
                'split', '2026-03-26T16:53:37Z', '2026-03-26T17:19:54Z'
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, created_at, updated_at
            ) VALUES (
                'pay-split', 'ord-split', 'cash', 8.0, 'completed',
                '2026-03-26T16:55:00Z', '2026-03-26T16:55:00Z'
            )",
            [],
        )
        .unwrap();

        let blockers = load_branch_window_payment_blockers(
            &conn,
            "branch-1",
            "2026-03-26T00:00:00Z",
            Some("2026-03-27T00:00:00Z"),
            true,
        )
        .expect("branch blockers");

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].reason_code, "split_payment_incomplete");
        assert!(
            blockers[0].suggested_fix.contains("Resume split payment"),
            "split payments should suggest resuming the split flow"
        );
    }
}
