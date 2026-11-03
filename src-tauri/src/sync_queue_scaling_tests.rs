//! Health's queue counts and the per-enqueue look-alike quarantine stay cheap
//! as the queue grows, with the same rows and counts as before (02/11/2026).
//!
//! At 5,000 queued rows Health counted the renderer's queue eight times, one
//! scan per count through the repair-owner filter, 11–35 ms each; and every
//! enqueue scanned the whole queue for repair look-alikes, 11 ms, which is
//! why `record_payment` grew from 3 to 16 ms while the queue was long.

use super::*;
use rusqlite::{params, Connection};

fn connection() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::db::run_migrations_for_test(&conn);
    create_tables(&conn).expect("create sync queue tables");
    crate::db::set_setting(&conn, "terminal", "__ignore_keyring", "1").expect("no keyring");
    conn
}

fn plan(conn: &Connection, sql: &str) -> String {
    let mut statement = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("explain");
    let plan = statement
        .query_map([], |row| row.get::<_, String>(3))
        .expect("plan rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("plan");
    plan.join(" | ")
}

#[allow(clippy::too_many_arguments)]
fn queue_row(
    conn: &Connection,
    id: &str,
    module: &str,
    table: &str,
    record: &str,
    status: &str,
    attempts: i64,
    error: Option<&str>,
    created_at: &str,
) {
    conn.execute(
        "INSERT INTO parity_sync_queue (id, table_name, record_id, operation, data,
             organization_id, created_at, attempts, retry_delay_ms, priority,
             module_type, conflict_strategy, version, status, error_message)
         VALUES (?1, ?2, ?3, 'INSERT', '{}', 'org-1', ?4, ?5, 1000, 0,
                 ?6, 'server-wins', 1, ?7, ?8)",
        params![id, table, record, created_at, attempts, module, status, error],
    )
    .expect("queue row");
}

/// Every status and owner shape the counts tell apart: generic rows of each
/// status, dead letters, a quarantined look-alike, a canonical repair row and
/// rows naming the repair settlement's order, payment and adjustment.
fn seed_queue(conn: &Connection) {
    let rows: [(&str, &str, &str, &str, &str, i64, Option<&str>, &str); 14] = [
        (
            "q-01",
            "orders",
            "orders",
            "plain-order",
            "pending",
            0,
            None,
            "2026-11-02T08:00:00Z",
        ),
        (
            "q-02",
            "orders",
            "payments",
            "plain-pay",
            "pending",
            2,
            Some("HTTP 503"),
            "2026-11-02T08:01:00Z",
        ),
        (
            "q-03",
            "orders",
            "orders",
            "plain-order",
            "processing",
            1,
            None,
            "2026-11-02T07:00:00Z",
        ),
        (
            "q-04",
            "orders",
            "payments",
            "plain-pay",
            "failed",
            3,
            Some("HTTP 500"),
            "2026-11-02T08:02:00Z",
        ),
        (
            "q-05",
            "orders",
            "payments",
            "plain-pay",
            "failed",
            10,
            Some("HTTP 422"),
            "2026-11-02T08:03:00Z",
        ),
        (
            "q-06",
            "orders",
            "orders",
            "plain-order",
            "conflict",
            1,
            Some("SERVER_CONFLICT"),
            "2026-11-02T08:04:00Z",
        ),
        (
            "q-07",
            " Repairs ",
            "repairs",
            "repair-1",
            "failed",
            0,
            Some("REPAIR_RESERVED_OWNER_QUARANTINED"),
            "2026-11-01T08:00:00Z",
        ),
        (
            "q-08",
            "repairs",
            "repairs",
            "repair-1",
            "pending",
            0,
            None,
            "2026-11-01T07:00:00Z",
        ),
        (
            "q-09",
            "orders",
            "orders",
            "repair-order",
            "pending",
            0,
            None,
            "2026-11-02T06:00:00Z",
        ),
        (
            "q-10",
            "orders",
            " ORDERS ",
            "repair-remote",
            "failed",
            10,
            Some("HTTP 500"),
            "2026-11-02T06:01:00Z",
        ),
        (
            "q-11",
            "orders",
            "Order_Payments",
            "repair-pay",
            "pending",
            0,
            None,
            "2026-11-02T06:02:00Z",
        ),
        (
            "q-12",
            "orders",
            "payment_adjustments",
            "repair-adj",
            "conflict",
            1,
            None,
            "2026-11-02T06:03:00Z",
        ),
        (
            "q-13",
            "orders",
            "payments",
            "missing-pay",
            "failed",
            10,
            Some("REPAIR_RESERVED_OWNER_QUARANTINED"),
            "2026-11-02T08:05:00Z",
        ),
        (
            "q-14",
            "customers",
            "customers",
            "customer-1",
            "pending",
            0,
            None,
            "2026-11-02T08:06:00Z",
        ),
    ];
    for (id, module, table, record, status, attempts, error, created_at) in rows {
        queue_row(
            conn, id, module, table, record, status, attempts, error, created_at,
        );
    }
}

/// A repair settlement with its payment and adjustment, plus a plain order.
fn seed_orders(conn: &Connection, repair_context: Option<&str>) {
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute(
        "INSERT INTO orders (id, supabase_id, items, total_amount, status, order_context, created_at, updated_at)
         VALUES ('repair-order', 'repair-remote', '[]', 10, 'completed', ?1, 'now', 'now'),
                ('plain-order', 'plain-remote', '[]', 10, 'completed', NULL, 'now', 'now')",
        params![repair_context],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO order_payments (id, order_id, method, amount, status, created_at, updated_at)
         VALUES ('repair-pay', 'repair-order', 'cash', 10, 'completed', 'now', 'now'),
                ('plain-pay', 'plain-order', 'cash', 10, 'completed', 'now', 'now');
         INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, created_at, updated_at)
         VALUES ('repair-adj', 'repair-pay', '', 'refund', 1, 'r', 'now', 'now');",
    )
    .unwrap();
}

/// [`renderer_get_status`] before 02/11/2026, verbatim: one query per count.
fn renderer_get_status_per_count(conn: &Connection) -> QueueStatus {
    let generic_owner = renderer_generic_owner_predicate("parity_sync_queue");
    let ownership_exclusion = renderer_non_repair_owned_predicate("parity_sync_queue");
    let predicate = format!(
        "{generic_owner}
         AND {ownership_exclusion}"
    );
    let count = |status: Option<&str>| -> i64 {
        match status {
            Some(status) => conn.query_row(
                &format!(
                    "SELECT COUNT(*) FROM parity_sync_queue WHERE {predicate} AND status = ?1"
                ),
                [status],
                |row| row.get(0),
            ),
            None => conn.query_row(
                &format!("SELECT COUNT(*) FROM parity_sync_queue WHERE {predicate}"),
                [],
                |row| row.get(0),
            ),
        }
        .unwrap()
    };
    QueueStatus {
        total: count(None),
        pending: count(Some("pending")),
        in_progress: count(Some("processing")),
        failed: count(Some("failed")),
        conflicts: count(Some("conflict")),
        quarantined: conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM parity_sync_queue
                     WHERE {predicate} AND status = 'failed' AND error_message = ?1"
                ),
                [REPAIR_RESERVED_OWNER_QUARANTINED],
                |row| row.get(0),
            )
            .unwrap(),
        dead_lettered: conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM parity_sync_queue
                     WHERE {predicate} AND status = 'failed' AND attempts >= ?1
                       AND COALESCE(error_message, '') <> ?2"
                ),
                params![MAX_RETRY_ATTEMPTS, REPAIR_RESERVED_OWNER_QUARANTINED],
                |row| row.get(0),
            )
            .unwrap(),
        oldest_item_age: oldest_queue_item_age_ms(conn, Some(&predicate)).unwrap(),
    }
}

fn assert_same_counts(conn: &Connection) -> QueueStatus {
    let before = renderer_get_status_per_count(conn);
    let after = renderer_get_status(conn).expect("one-pass status");
    let age = |status: &QueueStatus| status.oldest_item_age;
    let mut before_counts = serde_json::to_value(&before).unwrap();
    let mut after_counts = serde_json::to_value(&after).unwrap();
    before_counts["oldestItemAge"] = serde_json::Value::Null;
    after_counts["oldestItemAge"] = serde_json::Value::Null;
    assert_eq!(after_counts, before_counts);
    // The two reads are microseconds apart; `julianday('now')` moves with them.
    match (age(&before), age(&after)) {
        (Some(before), Some(after)) => assert!((after - before).abs() < 1_000, "{before} {after}"),
        (before, after) => assert_eq!(after, before),
    }
    after
}

#[test]
fn one_pass_queue_counts_match_the_per_count_queries() {
    let conn = connection();
    assert_same_counts(&conn);

    // No repair settlement on this till: the owner filter excludes nothing.
    seed_orders(&conn, None);
    seed_queue(&conn);
    let without_repairs = assert_same_counts(&conn);
    assert_eq!(without_repairs.total, 12, "{without_repairs:?}");

    // A repair settlement (any spelling): its order, payment and adjustment
    // rows leave the renderer's counts.
    conn.execute(
        "UPDATE orders SET order_context = '  Repair_Settlement ' WHERE id = 'repair-order'",
        [],
    )
    .unwrap();
    let with_repairs = assert_same_counts(&conn);
    assert_eq!(with_repairs.total, 8, "{with_repairs:?}");
    assert_eq!(with_repairs.dead_lettered, 1, "{with_repairs:?}");
    assert_eq!(with_repairs.quarantined, 1, "{with_repairs:?}");
}

/// The repair-settlement owner filter before 02/11/2026, verbatim: the same
/// branches without the once-per-statement guard.
fn owner_predicate_before_guard(alias: &str) -> String {
    let order_context = semantic_sql_value("repair_owner.order_context");
    let table = semantic_sql_value(&format!("{alias}.table_name"));
    format!(
        "(
             ({table} = 'orders'
              AND (
                   EXISTS (
                       SELECT 1
                       FROM orders repair_owner
                       WHERE repair_owner.id = {alias}.record_id
                         AND {order_context} = 'repair_settlement'
                   )
                   OR EXISTS (
                       SELECT 1
                       FROM orders repair_owner
                       WHERE repair_owner.supabase_id = {alias}.record_id
                         AND {order_context} = 'repair_settlement'
                   )
              ))
             OR ({table} IN ('payments', 'order_payments')
                 AND EXISTS (
                     SELECT 1
                     FROM order_payments repair_payment
                     JOIN orders repair_owner ON repair_owner.id = repair_payment.order_id
                     WHERE repair_payment.id = {alias}.record_id
                       AND {order_context} = 'repair_settlement'
                 ))
             OR ({table} = 'payment_adjustments'
                 AND EXISTS (
                     SELECT 1
                     FROM payment_adjustments repair_adjustment
                     LEFT JOIN order_payments repair_adjustment_payment
                       ON repair_adjustment_payment.id = repair_adjustment.payment_id
                     JOIN orders repair_owner
                       ON repair_owner.id = COALESCE(
                            NULLIF(repair_adjustment.order_id, ''),
                            repair_adjustment_payment.order_id
                          )
                     WHERE repair_adjustment.id = {alias}.record_id
                       AND {order_context} = 'repair_settlement'
                 ))
         )"
    )
}

#[test]
fn the_owner_filter_guard_keeps_its_meaning_and_asks_once() {
    for context in [
        None,
        Some("repair_settlement"),
        Some(" REPAIR_settlement\t"),
    ] {
        let conn = connection();
        seed_orders(&conn, context);
        seed_queue(&conn);
        let select = |predicate: String| -> Vec<String> {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT q.id FROM parity_sync_queue q WHERE {predicate} ORDER BY q.id"
                ))
                .unwrap();
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            ids
        };
        let before = select(owner_predicate_before_guard("q"));
        assert_eq!(
            select(semantic_repair_financial_queue_owner_predicate("q")),
            before,
            "{context:?}"
        );
        let expected: &[&str] = if context.is_some() {
            &["q-09", "q-10", "q-11", "q-12"]
        } else {
            &[]
        };
        assert_eq!(before, expected, "{context:?}");
    }

    // The guard does not depend on the queue row, and v107 indexes it.
    let conn = connection();
    let plan = plan(
        &conn,
        &format!(
            "SELECT q.id FROM parity_sync_queue q WHERE {}",
            semantic_repair_financial_queue_owner_predicate("q")
        ),
    );
    let steps: Vec<&str> = plan.split(" | ").collect();
    let guard = steps
        .iter()
        .position(|step| step.contains("repair_settlement_guard"))
        .unwrap_or_else(|| panic!("no guard step: {plan}"));
    assert!(
        steps[guard].contains("idx_orders_repair_settlement"),
        "{plan}"
    );
    assert!(
        guard > 0 && steps[guard - 1].starts_with("SCALAR SUBQUERY"),
        "the guard must be an uncorrelated subquery: {plan}"
    );
    assert!(!plan.contains("SCAN repair_owner"), "{plan}");
}

thread_local! {
    static TRACED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn trace_statement(sql: &str) {
    TRACED.with(|traced| traced.borrow_mut().push(sql.to_string()));
}

/// The quarantine that runs on every enqueue reads v107's partial index, not
/// the whole queue, and still parks exactly the look-alikes.
#[test]
fn the_lookalike_quarantine_reads_its_partial_index() {
    let mut conn = connection();
    seed_orders(&conn, None);
    seed_queue(&conn);
    queue_row(
        &conn,
        "q-15",
        "orders",
        "Repair_Attachments",
        "attachment-1",
        "pending",
        0,
        None,
        "now",
    );
    TRACED.with(|traced| traced.borrow_mut().clear());
    conn.trace(Some(trace_statement));
    let parked = quarantine_reserved_repair_lookalikes(&conn).expect("quarantine");
    conn.trace(None);
    assert_eq!(parked, 1, "only the new look-alike; q-07 is already parked");
    let status: (String, Option<String>) = conn
        .query_row(
            "SELECT status, error_message FROM parity_sync_queue WHERE id = 'q-15'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        status,
        (
            "failed".to_string(),
            Some(REPAIR_RESERVED_OWNER_QUARANTINED.to_string())
        )
    );
    let quarantine_sql = TRACED.with(|traced| {
        traced
            .borrow()
            .iter()
            .find(|sql| sql.trim_start().starts_with("UPDATE parity_sync_queue"))
            .cloned()
            .expect("the quarantine statement")
    });
    let plan = plan(&conn, &quarantine_sql);
    assert!(
        plan.contains("idx_parity_sync_queue_repair_lookalike"),
        "{plan}"
    );
    assert!(!plan.contains("SCAN parity_sync_queue"), "{plan}");
}
