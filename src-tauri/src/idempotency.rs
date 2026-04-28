//! Idempotency key construction for sync-queue entries.
//!
//! This module owns the one "how do I build a key for this entity?"
//! decision. Call sites that enqueue a sync-queue row MUST go through
//! [`make_entity_key`] rather than building ad-hoc strings.
//!
//! # Why this exists
//!
//! Finding C17 in the review (`now-create-a-plan-vivid-sutton.md`) flagged
//! that `sync_queue.rs:3225` was using `format!("parity:{}", item.id)` —
//! where `item.id` is the queue-row UUID regenerated on every re-enqueue.
//! Two logically-identical submissions of the same entity could therefore
//! be emitted with two different idempotency keys, and the server-side
//! dedup would happily accept both. For monetary entities (payments,
//! refunds, shift events, z-reports) this breaks exactly-once semantics.
//!
//! The fix is to key off the *entity's* stable id, not the queue row's
//! transient id. Migration v47 added `idempotency_key` columns to the
//! entity tables (`order_payments`, `payment_adjustments`, `staff_shifts`,
//! `shift_expenses`, `driver_earnings`) and migration v49 added a trigger
//! that backfills them on INSERT. [`make_entity_key`] reads that column
//! first and falls back to a deterministic synthetic only when a pre-v47
//! row is still in flight.
//!
//! # Wave 0 status
//!
//! Wave 0 introduces the helper only. No call site consumes it yet —
//! `db::get_entity_idempotency_key` is still `#[allow(dead_code)]`. Wave 5
//! (`sync_queue.rs::prepare_financial_request` et al) removes that
//! annotation and replaces the `parity:{row_uuid}` call site.

use rusqlite::Connection;

use crate::db;

/// Build a stable idempotency key for an entity-scoped sync-queue row.
///
/// The preferred form is whatever `db::get_entity_idempotency_key` returns
/// from the entity's `idempotency_key` column (populated by the v49 trigger
/// and, for newer entities, also by application code on INSERT). When that
/// column is absent or NULL — a pre-v47 row, or any entity type outside
/// the five tables covered by the trigger — we fall back to a deterministic
/// synthetic so two calls with the same `(table, record_id)` still produce
/// the same key.
///
/// `table` should be the canonical DB table name (e.g. `"order_payments"`).
/// `record_id` should be the entity's primary key (typically a UUID).
///
/// # Invariants
///
/// - Deterministic: `make_entity_key(_, T, R) == make_entity_key(_, T, R)`
///   across calls, processes, and restarts, as long as the underlying
///   `idempotency_key` column has not changed. Pre-v47 synthetic fallbacks
///   are stable too.
/// - No randomness. Nothing in this function calls `Uuid::new_v4()` or
///   reads the current time.
///
/// # Example
///
/// ```ignore
/// # use rusqlite::Connection;
/// # let conn: Connection = unreachable!();
/// let key = crate::idempotency::make_entity_key(
///     &conn,
///     "order_payments",
///     "c7b1a8c0-5e53-4c1f-8e7a-1a8f9b2d3c4e",
/// );
/// // e.g. "rnd-f17c..." (from v49 trigger) or the synthetic fallback:
/// //      "entity:order_payments:c7b1a8c0-5e53-4c1f-8e7a-1a8f9b2d3c4e"
/// ```
// Wave 5 C17: consumer wired in `sync_queue.rs::prepare_financial_request`.
pub fn make_entity_key(conn: &Connection, table: &str, record_id: &str) -> String {
    db::get_entity_idempotency_key(conn, table, record_id)
        .unwrap_or_else(|| synthetic_key(table, record_id))
}

/// Deterministic fallback key used when no persisted `idempotency_key` is
/// available. Exposed `pub(crate)` so tests and the eventual queue-migration
/// tooling (Wave 5) can assert against the exact format.
pub(crate) fn synthetic_key(table: &str, record_id: &str) -> String {
    format!("entity:{table}:{record_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn open_with_order_payments_table() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        // Minimal shape: just the columns get_entity_idempotency_key reads.
        conn.execute_batch(
            "CREATE TABLE order_payments (
                id TEXT PRIMARY KEY,
                idempotency_key TEXT
            );",
        )
        .expect("create table");
        conn
    }

    #[test]
    fn synthetic_key_is_deterministic_format() {
        assert_eq!(
            synthetic_key("order_payments", "abc"),
            "entity:order_payments:abc"
        );
    }

    #[test]
    fn make_entity_key_prefers_persisted_value_when_present() {
        let conn = open_with_order_payments_table();
        conn.execute(
            "INSERT INTO order_payments (id, idempotency_key) VALUES (?1, ?2)",
            rusqlite::params!["p1", "rnd-abcd1234"],
        )
        .unwrap();

        let k = make_entity_key(&conn, "order_payments", "p1");
        assert_eq!(k, "rnd-abcd1234");
    }

    #[test]
    fn make_entity_key_falls_back_to_synthetic_when_column_is_null() {
        let conn = open_with_order_payments_table();
        conn.execute(
            "INSERT INTO order_payments (id, idempotency_key) VALUES (?1, NULL)",
            rusqlite::params!["p-null"],
        )
        .unwrap();

        let k = make_entity_key(&conn, "order_payments", "p-null");
        assert_eq!(k, "entity:order_payments:p-null");
    }

    #[test]
    fn make_entity_key_falls_back_when_row_missing() {
        let conn = open_with_order_payments_table();
        let k = make_entity_key(&conn, "order_payments", "does-not-exist");
        assert_eq!(k, "entity:order_payments:does-not-exist");
    }

    #[test]
    fn make_entity_key_is_deterministic_across_calls() {
        let conn = open_with_order_payments_table();
        let a = make_entity_key(&conn, "order_payments", "same");
        let b = make_entity_key(&conn, "order_payments", "same");
        assert_eq!(a, b);
    }
}
