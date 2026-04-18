//! Offline sync queue backed by local SQLite.
//!
//! Provides a durable, priority-aware FIFO queue for offline POS operations.
//! Items are persisted to SQLite so they survive renderer crashes and app
//! restarts. Processing uses exponential backoff for transient failures.
//!
//! # Tables
//!
//! - `parity_sync_queue` -- queued operations awaiting sync to the admin API.
//! - `conflict_audit_log` -- audit trail for conflicts detected during sync.
//!
//! # Queue Semantics
//!
//! - FIFO within priority bands (higher priority processed first).
//! - Max queue size: 500 items (configurable via `MAX_QUEUE_SIZE`).
//! - Exponential backoff: initial 1s, doubles per attempt, capped at 60s.
//! - Max retries: 10 (item marked `failed` after exhaustion).
//! - Age warning threshold: 24 hours (logged, not blocking).

use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Method;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::time::Duration;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{db, storage, sync};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of items allowed in the queue before rejecting new entries.
pub const MAX_QUEUE_SIZE: i64 = 500;

/// Default initial retry delay in milliseconds.
const DEFAULT_INITIAL_RETRY_DELAY_MS: i64 = 1000;

/// Maximum retry delay in milliseconds (cap for exponential backoff).
const MAX_RETRY_DELAY_MS: i64 = 60_000;

/// Maximum number of retry attempts before marking an item as permanently failed.
pub const MAX_RETRY_ATTEMPTS: i64 = 10;

/// Age threshold in milliseconds for old-item warnings (24 hours).
const AGE_WARNING_THRESHOLD_MS: i64 = 24 * 60 * 60 * 1000;

/// Cap automatic failed-row recovery per cycle so backlog repair does not flood admin.
const MAX_AUTO_REQUEUE_ITEMS_PER_CYCLE: usize = 3;

/// Recovery lease for parity rows claimed as `processing`.
const PROCESSING_LEASE_SECS: i64 = 120;

/// Hard timeout for parity HTTP calls so abandoned requests do not pin rows.
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Default cooldown when the admin API responds with rate limiting.
const DEFAULT_RATE_LIMIT_RETRY_SECS: i64 = 60;

// ---------------------------------------------------------------------------
// Data structures (mirror shared/pos/sync-queue-types.ts)
// ---------------------------------------------------------------------------

/// A single queued sync operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncQueueItem {
    pub id: String,
    pub table_name: String,
    pub record_id: String,
    pub operation: String,
    pub data: String,
    pub organization_id: String,
    pub created_at: String,
    pub attempts: i64,
    pub last_attempt: Option<String>,
    pub error_message: Option<String>,
    pub next_retry_at: Option<String>,
    pub retry_delay_ms: i64,
    pub priority: i64,
    pub module_type: String,
    pub conflict_strategy: String,
    pub version: i64,
    pub status: String,
}

/// Input for enqueueing a new item (fields auto-populated by the queue).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueInput {
    pub table_name: String,
    pub record_id: String,
    pub operation: String,
    pub data: String,
    pub organization_id: String,
    pub priority: Option<i64>,
    pub module_type: Option<String>,
    pub conflict_strategy: Option<String>,
    pub version: Option<i64>,
}

/// Result of a queue processing batch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub success: bool,
    pub processed: i64,
    pub failed: i64,
    pub conflicts: i64,
    pub errors: Vec<SyncError>,
}

/// Individual error from queue processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    pub item_id: String,
    pub table_name: String,
    pub record_id: String,
    pub error: String,
    pub http_status: Option<u16>,
}

/// Summary status of the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub total: i64,
    pub pending: i64,
    pub failed: i64,
    pub conflicts: i64,
    pub oldest_item_age: Option<i64>,
}

/// Query options for listing actionable parity queue items.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueListQuery {
    pub limit: Option<i64>,
    pub module_type: Option<String>,
}

/// Result of retrying parity queue items.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryItemsResult {
    pub retried: i64,
}

/// Conflict audit entry returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAuditEntry {
    pub id: String,
    pub operation_type: String,
    pub entity_id: String,
    pub entity_type: String,
    pub local_version: i64,
    pub server_version: i64,
    pub timestamp: String,
    pub discarded_payload: String,
    pub resolution: String,
    pub is_monetary: bool,
    pub reviewed_by_operator: bool,
}

#[derive(Debug)]
enum RequestPreparation {
    Ready(RequestSpec),
    Deferred { reason: String },
    Failed { reason: String },
}

#[derive(Debug)]
struct RequestSpec {
    endpoint: String,
    method: Method,
    body: Option<String>,
    terminal_id: String,
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/// Create the `parity_sync_queue` and `conflict_audit_log` tables if they do
/// not already exist. Called during database migration.
pub fn create_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS parity_sync_queue (
            id              TEXT PRIMARY KEY,
            table_name      TEXT NOT NULL,
            record_id       TEXT NOT NULL,
            operation       TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
            data            TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            attempts        INTEGER NOT NULL DEFAULT 0,
            last_attempt    TEXT,
            error_message   TEXT,
            next_retry_at   TEXT,
            retry_delay_ms  INTEGER NOT NULL DEFAULT 1000,
            priority        INTEGER NOT NULL DEFAULT 0,
            module_type     TEXT NOT NULL DEFAULT 'orders',
            conflict_strategy TEXT NOT NULL DEFAULT 'server-wins',
            version         INTEGER NOT NULL DEFAULT 1,
            status          TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'failed', 'conflict'))
        );

        CREATE INDEX IF NOT EXISTS idx_parity_sq_priority_created
            ON parity_sync_queue (priority DESC, created_at ASC);

        CREATE INDEX IF NOT EXISTS idx_parity_sq_next_retry
            ON parity_sync_queue (next_retry_at ASC)
            WHERE next_retry_at IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_parity_sq_org
            ON parity_sync_queue (organization_id);

        CREATE TABLE IF NOT EXISTS conflict_audit_log (
            id                    TEXT PRIMARY KEY,
            operation_type        TEXT NOT NULL,
            entity_id             TEXT NOT NULL,
            entity_type           TEXT NOT NULL,
            local_version         INTEGER NOT NULL,
            server_version        INTEGER NOT NULL,
            timestamp             TEXT NOT NULL DEFAULT (datetime('now')),
            discarded_payload     TEXT NOT NULL,
            resolution            TEXT NOT NULL,
            is_monetary           INTEGER NOT NULL DEFAULT 0,
            reviewed_by_operator  INTEGER NOT NULL DEFAULT 0
        );
        ",
    )
    .map_err(|e| format!("sync_queue create_tables: {e}"))?;

    info!("Parity sync queue tables initialized");
    Ok(())
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/// Enqueue a new sync item. Returns the generated UUID.
///
/// Rejects if the queue has reached `MAX_QUEUE_SIZE`.
pub fn enqueue(conn: &Connection, input: &EnqueueInput) -> Result<String, String> {
    // Check queue capacity
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("sync_queue count: {e}"))?;

    if count >= MAX_QUEUE_SIZE {
        return Err(format!(
            "Sync queue is full ({count}/{MAX_QUEUE_SIZE}). \
             Clear or process pending items before enqueuing more."
        ));
    }

    // Validate operation
    let op = input.operation.to_uppercase();
    if op != "INSERT" && op != "UPDATE" && op != "DELETE" {
        return Err(format!(
            "Invalid sync operation '{}'. Expected INSERT, UPDATE, or DELETE.",
            input.operation
        ));
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let priority = input.priority.unwrap_or(0);
    let module_type = input.module_type.as_deref().unwrap_or("orders");
    let conflict_strategy = input.conflict_strategy.as_deref().unwrap_or("server-wins");
    let version = input.version.unwrap_or(1);

    conn.execute(
        "INSERT INTO parity_sync_queue
            (id, table_name, record_id, operation, data, organization_id,
             created_at, attempts, retry_delay_ms, priority, module_type,
             conflict_strategy, version, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?12, 'pending')",
        params![
            id,
            input.table_name,
            input.record_id,
            op,
            input.data,
            input.organization_id,
            now,
            DEFAULT_INITIAL_RETRY_DELAY_MS,
            priority,
            module_type,
            conflict_strategy,
            version,
        ],
    )
    .map_err(|e| format!("sync_queue enqueue: {e}"))?;

    info!(
        id = %id,
        table = %input.table_name,
        record = %input.record_id,
        op = %op,
        org = %input.organization_id,
        "Enqueued sync item"
    );

    Ok(id)
}

fn string_field(payload: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn infer_organization_id(conn: &Connection, payload: &Value) -> String {
    string_field(payload, &["organizationId", "organization_id"])
        .or_else(|| db::get_setting(conn, "terminal", "organization_id"))
        .or_else(|| storage::get_credential("organization_id"))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "pending-org".to_string())
}

fn resolve_runtime_context(conn: &Connection, payload: &Value) -> (String, String, String) {
    // Keyring-first after the inline payload: OS credential store is
    // authoritative; plaintext `local_settings` is backward-compat fallback.
    let terminal_id = string_field(payload, &["terminalId", "terminal_id"])
        .or_else(|| runtime_credential(conn, "terminal_id"))
        .unwrap_or_default();
    let branch_id = string_field(payload, &["branchId", "branch_id"])
        .or_else(|| runtime_credential(conn, "branch_id"))
        .unwrap_or_default();
    let organization_id = infer_organization_id(conn, payload);

    (terminal_id, branch_id, organization_id)
}

fn runtime_credential(conn: &Connection, key: &str) -> Option<String> {
    #[cfg(test)]
    if db::get_setting(conn, "terminal", "__ignore_keyring").as_deref() == Some("1") {
        return db::get_setting(conn, "terminal", key);
    }

    storage::get_credential(key).or_else(|| db::get_setting(conn, "terminal", key))
}

fn resolve_request_terminal_id(conn: &Connection, payload: &Value) -> Option<String> {
    let (terminal_id, _, _) = resolve_runtime_context(conn, payload);
    let trimmed = terminal_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_local_placeholder_id(record_id: &str) -> bool {
    let normalized = record_id.trim().to_ascii_lowercase();
    normalized == "local-new" || normalized.starts_with("local-")
}

fn read_local_json_array_setting(conn: &Connection, key: &str) -> Vec<Value> {
    db::get_setting(conn, "local", key)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|parsed| parsed.as_array().cloned())
        .unwrap_or_default()
}

fn write_local_json_array_setting(
    conn: &Connection,
    key: &str,
    values: &[Value],
) -> Result<(), String> {
    db::set_setting(
        conn,
        "local",
        key,
        &Value::Array(values.to_vec()).to_string(),
    )
}

fn customer_address_coordinates(value: &Value) -> Option<(f64, f64)> {
    let lat = nested_value(value, &["coordinates", "lat"])
        .and_then(number_from_value)
        .or_else(|| value.get("latitude").and_then(number_from_value));
    let lng = nested_value(value, &["coordinates", "lng"])
        .and_then(number_from_value)
        .or_else(|| value.get("longitude").and_then(number_from_value));

    match (lat, lng) {
        (Some(lat), Some(lng)) => Some((lat, lng)),
        _ => None,
    }
}

fn same_customer_address_coordinates(left: &Value, right: &Value) -> bool {
    match (
        customer_address_coordinates(left),
        customer_address_coordinates(right),
    ) {
        (Some((left_lat, left_lng)), Some((right_lat, right_lng))) => {
            (left_lat - right_lat).abs() < 0.000_001 && (left_lng - right_lng).abs() < 0.000_001
        }
        _ => false,
    }
}

fn customer_address_cache_matches_payload(candidate: &Value, payload: &Value) -> bool {
    if same_customer_address_coordinates(candidate, payload) {
        return true;
    }

    let candidate_street = string_field(candidate, &["street_address", "street", "address"])
        .map(|value| value.to_ascii_lowercase());
    let payload_street = string_field(payload, &["street_address", "street", "address"])
        .map(|value| value.to_ascii_lowercase());

    if let (Some(candidate_street), Some(payload_street)) = (candidate_street, payload_street) {
        if candidate_street == payload_street {
            return true;
        }
    }

    let candidate_formatted =
        string_field(candidate, &["formatted_address"]).map(|value| value.to_ascii_lowercase());
    let payload_formatted =
        string_field(payload, &["formatted_address"]).map(|value| value.to_ascii_lowercase());

    matches!(
        (candidate_formatted, payload_formatted),
        (Some(candidate_formatted), Some(payload_formatted)) if candidate_formatted == payload_formatted
    )
}

fn find_cached_customer_address(
    conn: &Connection,
    customer_id: &str,
    address_id: &str,
    payload: &Value,
) -> Option<Value> {
    let cache = read_local_json_array_setting(conn, "customer_cache_v1");

    cache
        .into_iter()
        .find(|customer| {
            string_field(customer, &["id", "customerId"])
                .is_some_and(|candidate| candidate == customer_id)
        })
        .and_then(|customer| customer.get("addresses").and_then(Value::as_array).cloned())
        .and_then(|addresses| {
            addresses
                .iter()
                .find(|address| {
                    string_field(address, &["id", "addressId"])
                        .is_some_and(|candidate| candidate == address_id)
                })
                .cloned()
                .or_else(|| {
                    if is_local_placeholder_id(address_id) {
                        addresses
                            .iter()
                            .find(|address| {
                                customer_address_cache_matches_payload(address, payload)
                            })
                            .cloned()
                    } else {
                        None
                    }
                })
        })
}

fn merge_customer_address_payload_from_cache(
    conn: &Connection,
    customer_id: &str,
    address_id: &str,
    payload: &Value,
) -> Value {
    let Some(cached_address) = find_cached_customer_address(conn, customer_id, address_id, payload)
    else {
        return payload.clone();
    };

    let mut merged = cached_address.as_object().cloned().unwrap_or_default();
    if let Some(payload_object) = payload.as_object() {
        for (key, value) in payload_object {
            if !value.is_null() {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    merged.insert(
        "customer_id".to_string(),
        Value::String(customer_id.to_string()),
    );

    Value::Object(merged)
}

fn load_recent_order_address_fallback(conn: &Connection, customer_id: &str) -> Option<Value> {
    conn.query_row(
        "SELECT
             delivery_address,
             delivery_city,
             delivery_postal_code,
             delivery_floor,
             delivery_notes,
             name_on_ringer
         FROM orders
         WHERE customer_id = ?1
           AND COALESCE(TRIM(delivery_address), '') != ''
         ORDER BY COALESCE(updated_at, created_at, '') DESC
         LIMIT 1",
        params![customer_id],
        |row| {
            let street_address: Option<String> = row.get(0)?;
            let city: Option<String> = row.get(1)?;
            let postal_code: Option<String> = row.get(2)?;
            let floor_number: Option<String> = row.get(3)?;
            let notes: Option<String> = row.get(4)?;
            let name_on_ringer: Option<String> = row.get(5)?;

            Ok(serde_json::json!({
                "street_address": street_address.clone(),
                "street": street_address,
                "city": city,
                "postal_code": postal_code,
                "floor_number": floor_number,
                "notes": notes,
                "delivery_notes": notes,
                "name_on_ringer": name_on_ringer,
            }))
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn merge_customer_address_payload_for_recreate(
    conn: &Connection,
    customer_id: &str,
    address_id: &str,
    payload: &Value,
) -> Value {
    let merged = merge_customer_address_payload_from_cache(conn, customer_id, address_id, payload);
    if has_customer_address_street(&merged) {
        return merged;
    }

    let Some(order_fallback) = load_recent_order_address_fallback(conn, customer_id) else {
        return merged;
    };

    let mut hydrated = order_fallback.as_object().cloned().unwrap_or_default();
    if let Some(merged_object) = merged.as_object() {
        for (key, value) in merged_object {
            if !value.is_null() {
                hydrated.insert(key.clone(), value.clone());
            }
        }
    }
    hydrated.insert(
        "customer_id".to_string(),
        Value::String(customer_id.to_string()),
    );

    Value::Object(hydrated)
}

fn has_customer_address_street(payload: &Value) -> bool {
    string_field(payload, &["street_address", "street", "address"]).is_some()
}

fn normalize_customer_address_for_cache(mut address: Value) -> Value {
    let now = Utc::now().to_rfc3339();
    let street = string_field(&address, &["street_address", "street", "address"]);
    let notes = address
        .get("notes")
        .cloned()
        .or_else(|| address.get("delivery_notes").cloned())
        .unwrap_or(Value::Null);
    let coordinates = customer_address_coordinates(&address);

    if let Some(obj) = address.as_object_mut() {
        if let Some(street) = street.clone() {
            obj.entry("street_address".to_string())
                .or_insert_with(|| Value::String(street.clone()));
            obj.entry("street".to_string())
                .or_insert_with(|| Value::String(street));
        }

        obj.insert("notes".to_string(), notes.clone());
        obj.insert("delivery_notes".to_string(), notes);

        if !obj.contains_key("createdAt") {
            let created_at = obj
                .get("created_at")
                .cloned()
                .unwrap_or_else(|| Value::String(now.clone()));
            obj.insert("createdAt".to_string(), created_at);
        }
        if !obj.contains_key("updatedAt") {
            let updated_at = obj
                .get("updated_at")
                .cloned()
                .unwrap_or_else(|| Value::String(now.clone()));
            obj.insert("updatedAt".to_string(), updated_at);
        }
        if !obj.contains_key("version") {
            obj.insert("version".to_string(), Value::from(1));
        }
        if let Some((lat, lng)) = coordinates {
            obj.entry("latitude".to_string())
                .or_insert(Value::from(lat));
            obj.entry("longitude".to_string())
                .or_insert(Value::from(lng));
            obj.entry("coordinates".to_string())
                .or_insert_with(|| serde_json::json!({ "lat": lat, "lng": lng }));
        }
    }

    address
}

fn find_cached_customer_address_index(
    addresses: &[Value],
    item_record_id: &str,
    remote_id: Option<&str>,
    payload: &Value,
) -> Option<usize> {
    if let Some(remote_id) = remote_id {
        if let Some(index) = addresses.iter().position(|address| {
            string_field(address, &["id", "addressId"])
                .is_some_and(|candidate| candidate == remote_id)
        }) {
            return Some(index);
        }
    }

    if let Some(index) = addresses.iter().position(|address| {
        string_field(address, &["id", "addressId"])
            .is_some_and(|candidate| candidate == item_record_id)
    }) {
        return Some(index);
    }

    if is_local_placeholder_id(item_record_id) {
        return addresses
            .iter()
            .position(|address| customer_address_cache_matches_payload(address, payload));
    }

    None
}

fn update_customer_address_cache_after_sync(
    conn: &Connection,
    item: &SyncQueueItem,
    response: Option<&Value>,
) -> Result<(), String> {
    let payload = serde_json::from_str::<Value>(&item.data).unwrap_or_else(|_| Value::Null);
    let response_address = response.and_then(|value| {
        value
            .get("address")
            .cloned()
            .or_else(|| value.get("data").cloned())
    });
    let customer_id = response_address
        .as_ref()
        .and_then(|address| string_field(address, &["customer_id", "customerId"]))
        .or_else(|| extract_customer_id_from_sync_payload(item));

    let Some(customer_id) = customer_id else {
        return Ok(());
    };

    let mut customers = read_local_json_array_setting(conn, "customer_cache_v1");
    let Some(customer) = customers.iter_mut().find(|entry| {
        string_field(entry, &["id", "customerId"]).is_some_and(|candidate| candidate == customer_id)
    }) else {
        return Ok(());
    };

    let Some(customer_object) = customer.as_object_mut() else {
        return Ok(());
    };

    let addresses_value = customer_object
        .entry("addresses".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(addresses) = addresses_value.as_array_mut() else {
        return Ok(());
    };

    if item.operation == "DELETE" {
        addresses.retain(|address| {
            !find_cached_customer_address_index(
                std::slice::from_ref(address),
                item.record_id.as_str(),
                None,
                &payload,
            )
            .is_some()
        });
    } else if let Some(response_address) = response_address {
        let normalized_address = normalize_customer_address_for_cache(response_address);
        let remote_id = string_field(&normalized_address, &["id", "addressId"]);
        if let Some(index) = find_cached_customer_address_index(
            addresses,
            item.record_id.as_str(),
            remote_id.as_deref(),
            &payload,
        ) {
            addresses[index] = normalized_address;
        } else {
            addresses.push(normalized_address);
        }
    }

    customer_object.insert(
        "updatedAt".to_string(),
        Value::String(Utc::now().to_rfc3339()),
    );

    write_local_json_array_setting(conn, "customer_cache_v1", &customers)
}

fn nested_value<'a>(payload: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = payload;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn number_from_value(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|candidate| candidate as f64))
        .or_else(|| value.as_u64().map(|candidate| candidate as f64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|candidate| candidate.trim().parse::<f64>().ok())
        })
}

fn integer_from_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| {
            value
                .as_u64()
                .and_then(|candidate| i64::try_from(candidate).ok())
        })
        .or_else(|| {
            value
                .as_str()
                .and_then(|candidate| candidate.trim().parse::<i64>().ok())
        })
        .or_else(|| number_from_value(value).map(|candidate| candidate.round() as i64))
}

fn bool_from_value(value: &Value) -> Option<bool> {
    value
        .as_bool()
        .or_else(|| {
            value.as_i64().and_then(|candidate| match candidate {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            })
        })
        .or_else(|| {
            value.as_str().and_then(|candidate| {
                let normalized = candidate.trim().to_ascii_lowercase();
                match normalized.as_str() {
                    "true" | "1" | "yes" | "on" => Some(true),
                    "false" | "0" | "no" | "off" => Some(false),
                    _ => None,
                }
            })
        })
}

fn jsonish_value(value: &Value) -> Value {
    if let Some(raw) = value.as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            return parsed;
        }
    }
    value.clone()
}

fn string_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<String> {
    for source in sources {
        if let Some(value) = string_field(source, keys) {
            return Some(value);
        }
    }
    None
}

fn nested_string_field_from_sources(sources: &[&Value], paths: &[&[&str]]) -> Option<String> {
    for source in sources {
        for path in paths {
            if let Some(value) = nested_value(source, path).and_then(string_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn number_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<f64> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key).and_then(number_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn integer_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<i64> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key).and_then(integer_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn bool_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<bool> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key).and_then(bool_from_value) {
                return Some(value);
            }
        }
    }
    None
}

fn json_field_from_sources(sources: &[&Value], keys: &[&str]) -> Option<Value> {
    for source in sources {
        for key in keys {
            if let Some(value) = source.get(*key) {
                if !value.is_null() {
                    return Some(jsonish_value(value));
                }
            }
        }
    }
    None
}

fn parse_json_array(value: &Value) -> Vec<Value> {
    match jsonish_value(value) {
        Value::Array(values) => values,
        _ => Vec::new(),
    }
}

fn normalize_order_type_for_insert(raw_type: Option<&str>) -> String {
    match raw_type
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "pickup".to_string())
        .as_str()
    {
        "dine-in" | "dine_in" | "dinein" => "dine-in".to_string(),
        "delivery" => "delivery".to_string(),
        "drive-through" | "drive_through" | "drivethrough" => "drive-through".to_string(),
        "takeaway" => "takeaway".to_string(),
        "take-away" | "take_away" | "takeout" | "pickup" => "pickup".to_string(),
        _ => "pickup".to_string(),
    }
}

fn normalize_payment_status_for_insert(raw_status: Option<&str>) -> String {
    match raw_status
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "pending".to_string())
        .as_str()
    {
        "completed" | "paid" => "paid".to_string(),
        "partially_paid" => "partially_paid".to_string(),
        "refunded" => "refunded".to_string(),
        "failed" => "failed".to_string(),
        _ => "pending".to_string(),
    }
}

fn normalize_payment_method_for_insert(raw_method: Option<&str>) -> String {
    match raw_method
        .map(|candidate| candidate.trim().to_ascii_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "" | "pending" => "cash".to_string(),
        "cash" => "cash".to_string(),
        "card" => "card".to_string(),
        "digital_wallet" | "digital-wallet" | "wallet" => "digital_wallet".to_string(),
        _ => "other".to_string(),
    }
}

fn customization_key(value: &Value, index: usize) -> String {
    string_from_value(&value["customizationId"])
        .or_else(|| string_from_value(&value["optionId"]))
        .or_else(|| string_from_value(&value["name"]))
        .or_else(|| nested_value(value, &["ingredient", "id"]).and_then(string_from_value))
        .or_else(|| nested_value(value, &["ingredient", "name"]).and_then(string_from_value))
        .unwrap_or_else(|| format!("item-{index}"))
}

fn normalize_customizations_for_insert(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };

    match jsonish_value(value) {
        Value::Null => Value::Null,
        Value::Object(object) => Value::Object(object),
        Value::Array(items) => {
            let mut normalized = Map::new();
            for (index, item) in items.into_iter().enumerate() {
                normalized.insert(customization_key(&item, index), item);
            }
            Value::Object(normalized)
        }
        _ => Value::Null,
    }
}

fn normalize_order_insert_items(raw_items: &Value) -> Vec<Value> {
    let mut normalized = Vec::new();

    for item in parse_json_array(raw_items) {
        let menu_item_id = string_field(&item, &["menu_item_id", "menuItemId"])
            .filter(|candidate| Uuid::parse_str(candidate).is_ok());
        let name = string_field(&item, &["name", "menu_item_name", "menuItemName"]);
        let quantity = number_field_from_sources(&[&item], &["quantity"])
            .unwrap_or(1.0)
            .max(1.0)
            .round() as i64;
        let raw_total = number_field_from_sources(&[&item], &["total_price", "totalPrice"])
            .unwrap_or_default()
            .max(0.0);
        let unit_price = number_field_from_sources(&[&item], &["unit_price", "unitPrice", "price"])
            .or_else(|| {
                if raw_total > 0.0 && quantity > 0 {
                    Some(raw_total / quantity as f64)
                } else {
                    None
                }
            })
            .unwrap_or_default()
            .max(0.0);
        let total_price = if raw_total > 0.0 {
            raw_total
        } else {
            (unit_price * quantity as f64).max(0.0)
        };

        normalized.push(serde_json::json!({
            "menu_item_id": menu_item_id,
            "quantity": quantity,
            "unit_price": unit_price,
            "total_price": total_price,
            "name": name,
            "notes": string_field(&item, &["notes", "specialInstructions", "special_instructions"]),
            "customizations": normalize_customizations_for_insert(item.get("customizations")),
        }));
    }

    normalized
}

fn load_local_order_insert_fallback(
    conn: &Connection,
    order_id: &str,
) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT
            order_number,
            customer_name,
            customer_phone,
            customer_email,
            customer_id,
            items,
            total_amount,
            tax_amount,
            subtotal,
            status,
            order_type,
            table_number,
            delivery_address,
            delivery_city,
            delivery_postal_code,
            delivery_floor,
            delivery_notes,
            name_on_ringer,
            special_instructions,
            estimated_time,
            payment_status,
            payment_method,
            driver_id,
            driver_name,
            discount_percentage,
            discount_amount,
            tip_amount,
            terminal_id,
            branch_id,
            tax_rate,
            delivery_fee,
            client_request_id,
            is_ghost,
            ghost_source,
            ghost_metadata
         FROM orders
         WHERE id = ?1
         LIMIT 1",
        params![order_id],
        |row| {
            let mut object = Map::new();

            let insert_string =
                |object: &mut Map<String, Value>, key: &str, value: Option<String>| {
                    if let Some(value) = value {
                        object.insert(key.to_string(), Value::String(value));
                    }
                };
            let insert_number = |object: &mut Map<String, Value>, key: &str, value: Option<f64>| {
                if let Some(value) = value {
                    object.insert(key.to_string(), serde_json::json!(value));
                }
            };
            let insert_integer =
                |object: &mut Map<String, Value>, key: &str, value: Option<i64>| {
                    if let Some(value) = value {
                        object.insert(key.to_string(), Value::from(value));
                    }
                };

            insert_string(
                &mut object,
                "order_number",
                row.get::<_, Option<String>>("order_number")?,
            );
            insert_string(
                &mut object,
                "customer_name",
                row.get::<_, Option<String>>("customer_name")?,
            );
            insert_string(
                &mut object,
                "customer_phone",
                row.get::<_, Option<String>>("customer_phone")?,
            );
            insert_string(
                &mut object,
                "customer_email",
                row.get::<_, Option<String>>("customer_email")?,
            );
            insert_string(
                &mut object,
                "customer_id",
                row.get::<_, Option<String>>("customer_id")?,
            );
            insert_number(
                &mut object,
                "total_amount",
                row.get::<_, Option<f64>>("total_amount")?,
            );
            insert_number(
                &mut object,
                "tax_amount",
                row.get::<_, Option<f64>>("tax_amount")?,
            );
            insert_number(
                &mut object,
                "subtotal",
                row.get::<_, Option<f64>>("subtotal")?,
            );
            insert_string(
                &mut object,
                "status",
                row.get::<_, Option<String>>("status")?,
            );
            insert_string(
                &mut object,
                "order_type",
                row.get::<_, Option<String>>("order_type")?,
            );
            insert_integer(
                &mut object,
                "table_number",
                row.get::<_, Option<i64>>("table_number")?,
            );
            insert_string(
                &mut object,
                "delivery_address",
                row.get::<_, Option<String>>("delivery_address")?,
            );
            insert_string(
                &mut object,
                "delivery_city",
                row.get::<_, Option<String>>("delivery_city")?,
            );
            insert_string(
                &mut object,
                "delivery_postal_code",
                row.get::<_, Option<String>>("delivery_postal_code")?,
            );
            insert_string(
                &mut object,
                "delivery_floor",
                row.get::<_, Option<String>>("delivery_floor")?,
            );
            insert_string(
                &mut object,
                "delivery_notes",
                row.get::<_, Option<String>>("delivery_notes")?,
            );
            insert_string(
                &mut object,
                "name_on_ringer",
                row.get::<_, Option<String>>("name_on_ringer")?,
            );
            insert_string(
                &mut object,
                "special_instructions",
                row.get::<_, Option<String>>("special_instructions")?,
            );
            insert_integer(
                &mut object,
                "estimated_time",
                row.get::<_, Option<i64>>("estimated_time")?,
            );
            insert_string(
                &mut object,
                "payment_status",
                row.get::<_, Option<String>>("payment_status")?,
            );
            insert_string(
                &mut object,
                "payment_method",
                row.get::<_, Option<String>>("payment_method")?,
            );
            insert_string(
                &mut object,
                "driver_id",
                row.get::<_, Option<String>>("driver_id")?,
            );
            insert_string(
                &mut object,
                "driver_name",
                row.get::<_, Option<String>>("driver_name")?,
            );
            insert_number(
                &mut object,
                "discount_percentage",
                row.get::<_, Option<f64>>("discount_percentage")?,
            );
            insert_number(
                &mut object,
                "discount_amount",
                row.get::<_, Option<f64>>("discount_amount")?,
            );
            insert_number(
                &mut object,
                "tip_amount",
                row.get::<_, Option<f64>>("tip_amount")?,
            );
            insert_string(
                &mut object,
                "terminal_id",
                row.get::<_, Option<String>>("terminal_id")?,
            );
            insert_string(
                &mut object,
                "branch_id",
                row.get::<_, Option<String>>("branch_id")?,
            );
            insert_number(
                &mut object,
                "tax_rate",
                row.get::<_, Option<f64>>("tax_rate")?,
            );
            insert_number(
                &mut object,
                "delivery_fee",
                row.get::<_, Option<f64>>("delivery_fee")?,
            );
            insert_string(
                &mut object,
                "client_request_id",
                row.get::<_, Option<String>>("client_request_id")?,
            );
            insert_string(
                &mut object,
                "ghost_source",
                row.get::<_, Option<String>>("ghost_source")?,
            );

            if let Some(items_json) = row.get::<_, Option<String>>("items")? {
                if let Ok(items) = serde_json::from_str::<Value>(&items_json) {
                    object.insert("items".to_string(), items);
                }
            }

            if let Some(is_ghost) = row.get::<_, Option<i64>>("is_ghost")? {
                object.insert("is_ghost".to_string(), Value::Bool(is_ghost != 0));
            }

            if let Some(ghost_metadata) = row.get::<_, Option<String>>("ghost_metadata")? {
                if let Ok(parsed) = serde_json::from_str::<Value>(&ghost_metadata) {
                    object.insert("ghost_metadata".to_string(), parsed);
                }
            }

            Ok(Value::Object(object))
        },
    )
    .optional()
    .map_err(|e| format!("sync_queue load_local_order_insert_fallback: {e}"))
}

fn build_order_insert_body(
    conn: &Connection,
    record_id: &str,
    payload: &Value,
) -> Result<Value, String> {
    let local_order = load_local_order_insert_fallback(conn, record_id)?;
    let payload_root = payload.get("orderData").unwrap_or(payload);
    let mut sources = vec![payload_root, payload];
    if let Some(local_order) = local_order.as_ref() {
        sources.push(local_order);
    }

    let (_, runtime_branch_id, _) = resolve_runtime_context(conn, payload);
    let items_raw =
        json_field_from_sources(&sources, &["items"]).unwrap_or_else(|| Value::Array(vec![]));
    let items = normalize_order_insert_items(&items_raw);
    if items.is_empty() {
        return Err("Order insert payload is missing items".to_string());
    }

    let items_subtotal = items
        .iter()
        .map(|item| {
            item.get("total_price")
                .and_then(Value::as_f64)
                .unwrap_or_default()
        })
        .sum::<f64>();
    let subtotal = number_field_from_sources(&sources, &["subtotal"])
        .unwrap_or(items_subtotal)
        .max(0.0);
    let tax_amount = number_field_from_sources(&sources, &["tax_amount", "taxAmount"])
        .unwrap_or_default()
        .max(0.0);
    let delivery_fee = number_field_from_sources(&sources, &["delivery_fee", "deliveryFee"])
        .unwrap_or_default()
        .max(0.0);
    let manual_discount_mode =
        string_field_from_sources(&sources, &["manual_discount_mode", "manualDiscountMode"])
            .filter(|mode| matches!(mode.as_str(), "percentage" | "fixed"));
    let manual_discount_value =
        number_field_from_sources(&sources, &["manual_discount_value", "manualDiscountValue"])
            .map(|value| value.max(0.0));
    let discount_percentage =
        number_field_from_sources(&sources, &["discount_percentage", "discountPercentage"])
            .or_else(|| {
                if manual_discount_mode.as_deref() == Some("percentage") {
                    manual_discount_value
                } else {
                    None
                }
            })
            .unwrap_or_default()
            .max(0.0);
    let discount_amount =
        number_field_from_sources(&sources, &["discount_amount", "discountAmount"])
            .or_else(|| {
                if manual_discount_mode.as_deref() == Some("fixed") {
                    manual_discount_value
                } else if discount_percentage > 0.0 {
                    Some((subtotal * (discount_percentage / 100.0)).max(0.0))
                } else {
                    None
                }
            })
            .unwrap_or_default()
            .max(0.0);
    let coupon_discount_amount = number_field_from_sources(
        &sources,
        &["coupon_discount_amount", "couponDiscountAmount"],
    )
    .unwrap_or_default()
    .max(0.0);

    let total_amount =
        number_field_from_sources(&sources, &["total_amount", "totalAmount", "total"])
            .unwrap_or_else(|| {
                (subtotal + tax_amount + delivery_fee - discount_amount - coupon_discount_amount)
                    .max(0.0)
            })
            .max(0.0);

    let branch_id = string_field_from_sources(&sources, &["branch_id", "branchId"])
        .or_else(|| {
            let trimmed = runtime_branch_id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .filter(|candidate| Uuid::parse_str(candidate).is_ok())
        .ok_or_else(|| "Order insert payload is missing valid branch_id".to_string())?;

    let payment_method_raw =
        string_field_from_sources(&sources, &["payment_method", "paymentMethod"])
            .or_else(|| nested_string_field_from_sources(&sources, &[&["paymentData", "method"]]));
    let payment_method = normalize_payment_method_for_insert(payment_method_raw.as_deref());
    let payment_status = normalize_payment_status_for_insert(
        string_field_from_sources(&sources, &["payment_status", "paymentStatus"]).as_deref(),
    );
    let order_type = normalize_order_type_for_insert(
        string_field_from_sources(&sources, &["order_type", "orderType"]).as_deref(),
    );

    let customer_id = string_field_from_sources(&sources, &["customer_id", "customerId"])
        .or_else(|| nested_string_field_from_sources(&sources, &[&["customer", "id"]]))
        .filter(|candidate| Uuid::parse_str(candidate).is_ok());
    let customer_name = string_field_from_sources(&sources, &["customer_name", "customerName"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["customer", "name"], &["customer", "full_name"]],
            )
        });
    let customer_phone = string_field_from_sources(&sources, &["customer_phone", "customerPhone"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["customer", "phone_number"], &["customer", "phone"]],
            )
        });
    let customer_email = string_field_from_sources(&sources, &["customer_email", "customerEmail"])
        .or_else(|| nested_string_field_from_sources(&sources, &[&["customer", "email"]]));
    let delivery_address =
        string_field_from_sources(&sources, &["delivery_address", "deliveryAddress"]).or_else(
            || {
                nested_string_field_from_sources(
                    &sources,
                    &[
                        &["address", "street_address"],
                        &["address", "street"],
                        &["address", "address"],
                    ],
                )
            },
        );
    let delivery_city = string_field_from_sources(&sources, &["delivery_city", "deliveryCity"])
        .or_else(|| nested_string_field_from_sources(&sources, &[&["address", "city"]]));
    let delivery_postal_code =
        string_field_from_sources(&sources, &["delivery_postal_code", "deliveryPostalCode"])
            .or_else(|| {
                nested_string_field_from_sources(
                    &sources,
                    &[
                        &["address", "postal_code"],
                        &["address", "postalCode"],
                        &["address", "zip"],
                    ],
                )
            });
    let delivery_floor = string_field_from_sources(&sources, &["delivery_floor", "deliveryFloor"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["address", "floor_number"], &["address", "floor"]],
            )
        });
    let delivery_notes = string_field_from_sources(&sources, &["delivery_notes", "deliveryNotes"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["address", "delivery_notes"], &["address", "notes"]],
            )
        });
    let name_on_ringer = string_field_from_sources(&sources, &["name_on_ringer", "nameOnRinger"])
        .or_else(|| {
            nested_string_field_from_sources(
                &sources,
                &[&["address", "name_on_ringer"], &["address", "nameOnRinger"]],
            )
        });
    let ghost_metadata = json_field_from_sources(&sources, &["ghost_metadata", "ghostMetadata"])
        .and_then(|value| match value {
            Value::Object(_) => Some(value),
            _ => None,
        });

    Ok(serde_json::json!({
        "client_order_id": string_field_from_sources(&sources, &["client_order_id", "clientOrderId"])
            .unwrap_or_else(|| record_id.to_string()),
        "branch_id": branch_id,
        "items": items,
        "order_type": order_type,
        "payment_status": payment_status,
        "payment_method": payment_method,
        "total_amount": total_amount,
        "subtotal": subtotal,
        "tax_amount": tax_amount,
        "tax_rate": number_field_from_sources(&sources, &["tax_rate", "taxRate"]),
        "delivery_fee": delivery_fee,
        "discount_percentage": discount_percentage,
        "discount_amount": discount_amount,
        "manual_discount_mode": manual_discount_mode,
        "manual_discount_value": manual_discount_value,
        "coupon_id": string_field_from_sources(&sources, &["coupon_id", "couponId"]),
        "coupon_code": string_field_from_sources(&sources, &["coupon_code", "couponCode"]),
        "coupon_discount_amount": coupon_discount_amount,
        "tip_amount": number_field_from_sources(&sources, &["tip_amount", "tipAmount"])
            .unwrap_or(0.0),
        "country_code": string_field_from_sources(&sources, &["country_code", "countryCode"])
            .map(|value| value.trim().to_ascii_uppercase()),
        "pricing_mode": string_field_from_sources(&sources, &["pricing_mode", "pricingMode"]),
        "customer_id": customer_id,
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "customer_email": customer_email,
        "order_number": string_field_from_sources(&sources, &["order_number", "orderNumber"]),
        "status": string_field_from_sources(&sources, &["status"])
            .unwrap_or_else(|| "pending".to_string()),
        "table_number": integer_field_from_sources(&sources, &["table_number", "tableNumber"]),
        "delivery_address": delivery_address,
        "delivery_city": delivery_city,
        "delivery_postal_code": delivery_postal_code,
        "delivery_floor": delivery_floor,
        "delivery_notes": delivery_notes,
        "name_on_ringer": name_on_ringer,
        "notes": string_field_from_sources(&sources, &["notes", "orderNotes", "order_notes"])
            .or_else(|| string_field_from_sources(&sources, &["special_instructions", "specialInstructions"])),
        "is_ghost": bool_field_from_sources(&sources, &["is_ghost", "isGhost"]).unwrap_or(false),
        "ghost_source": string_field_from_sources(&sources, &["ghost_source", "ghostSource"]),
        "ghost_metadata": ghost_metadata,
    }))
}

fn is_retryable_legacy_order_insert_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    let legacy_shape_error = lower.contains("validation failed")
        && lower.contains("expected object, received array")
        && lower.contains("customizations")
        && lower.contains("order_type")
        && lower.contains("payment_method")
        && lower.contains("total_amount");
    let missing_tip_error = lower.contains("validation failed")
        && lower.contains("tip_amount")
        && lower.contains("expected number, received null");
    let stale_schema_cache_error = lower.contains("schema cache")
        && lower.contains("orders")
        && lower.contains("could not find the '");

    legacy_shape_error || missing_tip_error || stale_schema_cache_error
}

fn is_rate_limit_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("http 429") || lower.contains("rate limit exceeded")
}

fn is_payment_total_conflict_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("payment exceeds order total")
        || (lower.contains("http 422") && lower.contains("existing completed"))
}

fn is_customer_address_not_found_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("http 404") && lower.contains("address not found")
}

fn is_customer_address_missing_street_error(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("customer address recreate is missing street_address details")
}

fn requeue_failed_items(
    conn: &Connection,
    queue_ids: &[String],
    log_message: &str,
) -> Result<RetryItemsResult, String> {
    let mut retried = 0_i64;

    for queue_id in queue_ids {
        retried += conn
            .execute(
                "UPDATE parity_sync_queue
                 SET status = 'pending',
                     attempts = 0,
                     error_message = NULL,
                     next_retry_at = NULL,
                     last_attempt = NULL,
                     retry_delay_ms = ?1
                 WHERE id = ?2",
                params![DEFAULT_INITIAL_RETRY_DELAY_MS, queue_id],
            )
            .map_err(|e| format!("sync_queue requeue_failed_items update: {e}"))?
            as i64;
    }

    if retried > 0 {
        info!(retried = retried, "{log_message}");
    }

    Ok(RetryItemsResult { retried })
}

fn retry_failed_terminal_context_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let mut stmt = conn
        .prepare(
            "SELECT id
             FROM parity_sync_queue
             WHERE status = 'failed'
               AND error_message IS NOT NULL
               AND (
                   lower(error_message) LIKE '%missing terminal_id%'
                   OR lower(error_message) LIKE '%missing terminal id%'
                   OR lower(error_message) LIKE '%missing_terminal_id%'
                   OR lower(error_message) LIKE '%terminal_id context%'
               )
             ORDER BY created_at ASC
             LIMIT ?1",
        )
        .map_err(|e| format!("sync_queue retry_failed_terminal_context_items prepare: {e}"))?;

    let queue_ids: Vec<String> = stmt
        .query_map(params![limit as i64], |row| row.get(0))
        .map_err(|e| format!("sync_queue retry_failed_terminal_context_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued historical parity items that failed due to missing terminal identity context",
    )
}

fn retry_failed_rate_limited_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, error_message
             FROM parity_sync_queue
             WHERE status = 'failed'
               AND error_message IS NOT NULL
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("sync_queue retry_failed_rate_limited_items prepare: {e}"))?;

    let queue_ids: Vec<String> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("sync_queue retry_failed_rate_limited_items query: {e}"))?
        .filter_map(|row| row.ok())
        .filter(|(_, error_message)| is_rate_limit_error(error_message))
        .take(limit)
        .map(|(queue_id, _)| queue_id)
        .collect();

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued parity items that previously failed due to admin rate limiting",
    )
}

fn retry_failed_legacy_order_insert_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, record_id, data, error_message
             FROM parity_sync_queue
             WHERE table_name = 'orders'
               AND operation = 'INSERT'
               AND status = 'failed'
               AND error_message IS NOT NULL",
        )
        .map_err(|e| format!("sync_queue retry_failed_legacy_order_insert_items prepare: {e}"))?;
    let candidates: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("sync_queue retry_failed_legacy_order_insert_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    let mut queue_ids = Vec::new();
    for (queue_id, record_id, payload_raw, error_message) in candidates {
        if queue_ids.len() >= limit {
            break;
        }
        if !is_retryable_legacy_order_insert_error(&error_message) {
            continue;
        }

        let payload = serde_json::from_str::<Value>(&payload_raw)
            .unwrap_or_else(|_| Value::Object(Map::new()));
        if build_order_insert_body(conn, record_id.as_str(), &payload).is_err() {
            continue;
        }

        queue_ids.push(queue_id);
    }

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued legacy order insert parity rows after canonical request auto-heal",
    )
}

fn resolve_failed_payment_total_conflict_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, record_id, error_message
             FROM parity_sync_queue
             WHERE table_name = 'payments'
               AND operation = 'INSERT'
               AND status = 'failed'
               AND error_message IS NOT NULL
             ORDER BY created_at ASC",
        )
        .map_err(|e| {
            format!("sync_queue resolve_failed_payment_total_conflict_items prepare: {e}")
        })?;

    let candidates: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| format!("sync_queue resolve_failed_payment_total_conflict_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    let mut resolved = 0_i64;
    let resolved_at = Utc::now().to_rfc3339();

    for (queue_id, payment_id, error_message) in candidates {
        if resolved as usize >= limit {
            break;
        }
        if !is_payment_total_conflict_error(&error_message) {
            continue;
        }

        if sync::resolve_payment_total_conflict_with_server_hint_with_conn(
            conn,
            payment_id.as_str(),
            error_message.as_str(),
            resolved_at.as_str(),
        )?
        .is_some()
        {
            mark_success(conn, queue_id.as_str())?;
            resolved += 1;
        }
    }

    if resolved > 0 {
        info!(
            retried = resolved,
            "Resolved stale parity payment rows blocked by payment total conflicts"
        );
    }

    Ok(RetryItemsResult { retried: resolved })
}

fn retry_failed_customer_address_not_found_items_limited(
    conn: &Connection,
    limit: usize,
) -> Result<RetryItemsResult, String> {
    if limit == 0 {
        return Ok(RetryItemsResult { retried: 0 });
    }

    if resolve_request_terminal_id(conn, &Value::Object(Map::new())).is_none() {
        return Ok(RetryItemsResult { retried: 0 });
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, record_id, data, error_message
             FROM parity_sync_queue
             WHERE table_name = 'customer_addresses'
               AND operation = 'UPDATE'
               AND status = 'failed'
               AND error_message IS NOT NULL
             ORDER BY created_at ASC",
        )
        .map_err(|e| {
            format!("sync_queue retry_failed_customer_address_not_found_items prepare: {e}")
        })?;

    let candidates: Vec<(String, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| {
            format!("sync_queue retry_failed_customer_address_not_found_items query: {e}")
        })?
        .filter_map(|row| row.ok())
        .collect();

    let mut queue_ids = Vec::new();
    for (queue_id, record_id, payload_raw, error_message) in candidates {
        if queue_ids.len() >= limit {
            break;
        }
        if !(is_customer_address_not_found_error(&error_message)
            || is_customer_address_missing_street_error(&error_message))
            || !is_local_placeholder_id(record_id.as_str())
        {
            continue;
        }

        let payload = serde_json::from_str::<Value>(&payload_raw)
            .unwrap_or_else(|_| Value::Object(Map::new()));
        let Some(customer_id) = payload
            .get("customer_id")
            .or_else(|| payload.get("customerId"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        let hydrated_payload = merge_customer_address_payload_for_recreate(
            conn,
            customer_id.as_str(),
            record_id.as_str(),
            &payload,
        );
        if !has_customer_address_street(&hydrated_payload) {
            continue;
        }

        conn.execute(
            "UPDATE parity_sync_queue
             SET data = ?1
             WHERE id = ?2",
            params![hydrated_payload.to_string(), queue_id.as_str()],
        )
        .map_err(|e| {
            format!("sync_queue retry_failed_customer_address_not_found_items hydrate: {e}")
        })?;
        queue_ids.push(queue_id);
    }

    requeue_failed_items(
        conn,
        &queue_ids,
        "Requeued stale customer address parity rows after cache-backed recreate auto-heal",
    )
}

pub fn enqueue_payload_item(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
    operation: &str,
    payload: &Value,
    priority: Option<i64>,
    module_type: Option<&str>,
    conflict_strategy: Option<&str>,
    version: Option<i64>,
) -> Result<String, String> {
    let organization_id = infer_organization_id(conn, payload);

    enqueue(
        conn,
        &EnqueueInput {
            table_name: table_name.to_string(),
            record_id: record_id.to_string(),
            operation: operation.to_string(),
            data: payload.to_string(),
            organization_id,
            priority,
            module_type: module_type.map(ToString::to_string),
            conflict_strategy: conflict_strategy.map(ToString::to_string),
            version,
        },
    )
}

pub fn clear_unsynced_items(
    conn: &Connection,
    table_name: &str,
    record_id: &str,
) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM parity_sync_queue
         WHERE table_name = ?1
           AND record_id = ?2
           AND status IN ('pending', 'failed', 'conflict')",
        params![table_name, record_id],
    )
    .map_err(|e| format!("sync_queue clear_unsynced_items: {e}"))
}

/// Dequeue the next item to process (highest priority first, then oldest).
///
/// Returns `None` if the queue is empty or all items are scheduled for later.
/// Only considers items with status `pending` whose `next_retry_at` has passed.
pub fn dequeue(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    let now = Utc::now().to_rfc3339();

    let item = conn
        .query_row(
            "SELECT id, table_name, record_id, operation, data, organization_id,
                    created_at, attempts, last_attempt, error_message, next_retry_at,
                    retry_delay_ms, priority, module_type, conflict_strategy, version, status
             FROM parity_sync_queue
             WHERE status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= ?1)
             ORDER BY priority DESC, created_at ASC
             LIMIT 1",
            params![now],
            |row| {
                Ok(SyncQueueItem {
                    id: row.get(0)?,
                    table_name: row.get(1)?,
                    record_id: row.get(2)?,
                    operation: row.get(3)?,
                    data: row.get(4)?,
                    organization_id: row.get(5)?,
                    created_at: row.get(6)?,
                    attempts: row.get(7)?,
                    last_attempt: row.get(8)?,
                    error_message: row.get(9)?,
                    next_retry_at: row.get(10)?,
                    retry_delay_ms: row.get(11)?,
                    priority: row.get(12)?,
                    module_type: row.get(13)?,
                    conflict_strategy: row.get(14)?,
                    version: row.get(15)?,
                    status: row.get(16)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("sync_queue dequeue: {e}"))?;

    if let Some(ref item) = item {
        // Mark as processing and stamp the claim time so abandoned rows can be recovered.
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'processing',
                 last_attempt = ?1
             WHERE id = ?2",
            params![now, item.id],
        )
        .map_err(|e| format!("sync_queue mark processing: {e}"))?;
    }

    Ok(item)
}

fn recover_stale_processing_items(conn: &Connection) -> Result<i64, String> {
    let lease_modifier = format!("-{} seconds", PROCESSING_LEASE_SECS);
    let mut stmt = conn
        .prepare(
            "SELECT id, table_name, record_id
             FROM parity_sync_queue
             WHERE status = 'processing'
               AND julianday(COALESCE(last_attempt, created_at))
                   <= julianday('now', ?1)",
        )
        .map_err(|e| format!("sync_queue recover_stale_processing_items prepare: {e}"))?;

    let stale_rows: Vec<(String, String, String)> = stmt
        .query_map(params![lease_modifier.as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| format!("sync_queue recover_stale_processing_items query: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    if stale_rows.is_empty() {
        return Ok(0);
    }

    let recovered = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 next_retry_at = NULL
             WHERE status = 'processing'
               AND julianday(COALESCE(last_attempt, created_at))
                   <= julianday('now', ?1)",
            params![lease_modifier.as_str()],
        )
        .map_err(|e| format!("sync_queue recover_stale_processing_items update: {e}"))?
        as i64;

    for (_, table_name, record_id) in stale_rows.into_iter().take(5) {
        warn!(
            table_name = %table_name,
            record_id = %record_id,
            lease_secs = PROCESSING_LEASE_SECS,
            "Recovered stale parity processing row"
        );
    }

    Ok(recovered)
}

/// Peek at the next item without removing or marking it.
pub fn peek(conn: &Connection) -> Result<Option<SyncQueueItem>, String> {
    let now = Utc::now().to_rfc3339();

    conn.query_row(
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version, status
         FROM parity_sync_queue
         WHERE status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= ?1)
         ORDER BY priority DESC, created_at ASC
         LIMIT 1",
        params![now],
        |row| {
            Ok(SyncQueueItem {
                id: row.get(0)?,
                table_name: row.get(1)?,
                record_id: row.get(2)?,
                operation: row.get(3)?,
                data: row.get(4)?,
                organization_id: row.get(5)?,
                created_at: row.get(6)?,
                attempts: row.get(7)?,
                last_attempt: row.get(8)?,
                error_message: row.get(9)?,
                next_retry_at: row.get(10)?,
                retry_delay_ms: row.get(11)?,
                priority: row.get(12)?,
                module_type: row.get(13)?,
                conflict_strategy: row.get(14)?,
                version: row.get(15)?,
                status: row.get(16)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("sync_queue peek: {e}"))
}

/// Clear all items from the queue.
pub fn clear(conn: &Connection) -> Result<(), String> {
    let deleted: usize = conn
        .execute("DELETE FROM parity_sync_queue", [])
        .map_err(|e| format!("sync_queue clear: {e}"))?;

    info!(deleted = deleted, "Cleared parity sync queue");
    Ok(())
}

/// Get the current number of items in the queue.
pub fn get_length(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
        row.get(0)
    })
    .map_err(|e| format!("sync_queue length: {e}"))
}

/// Get detailed queue status including counts by status and oldest item age.
pub fn get_status(conn: &Connection) -> Result<QueueStatus, String> {
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("sync_queue status total: {e}"))?;

    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status pending: {e}"))?;

    let failed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status failed: {e}"))?;

    let conflicts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'conflict'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("sync_queue status conflicts: {e}"))?;

    // Calculate oldest item age in milliseconds
    let oldest_created: Option<String> = conn
        .query_row("SELECT MIN(created_at) FROM parity_sync_queue", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("sync_queue status oldest: {e}"))?;

    let oldest_item_age = oldest_created.and_then(|ts| {
        chrono::DateTime::parse_from_rfc3339(&ts)
            .ok()
            .map(|dt| Utc::now().signed_duration_since(dt).num_milliseconds())
    });

    Ok(QueueStatus {
        total,
        pending,
        failed,
        conflicts,
        oldest_item_age,
    })
}

pub fn list_actionable_items(
    conn: &Connection,
    query: &QueueListQuery,
) -> Result<Vec<SyncQueueItem>, String> {
    let limit = query.limit.unwrap_or(200).clamp(1, 500);

    let sql = if query
        .module_type
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
           AND module_type = ?1
         ORDER BY
            CASE status
                WHEN 'conflict' THEN 0
                WHEN 'failed' THEN 1
                WHEN 'pending' THEN 2
                ELSE 3
            END,
            priority DESC,
            created_at ASC
         LIMIT ?2"
    } else {
        "SELECT id, table_name, record_id, operation, data, organization_id,
                created_at, attempts, last_attempt, error_message, next_retry_at,
                retry_delay_ms, priority, module_type, conflict_strategy, version, status
         FROM parity_sync_queue
         WHERE status IN ('pending', 'processing', 'failed', 'conflict')
         ORDER BY
            CASE status
                WHEN 'conflict' THEN 0
                WHEN 'failed' THEN 1
                WHEN 'pending' THEN 2
                ELSE 3
            END,
            priority DESC,
            created_at ASC
         LIMIT ?1"
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("sync_queue list_actionable_items prepare: {e}"))?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SyncQueueItem> {
        Ok(SyncQueueItem {
            id: row.get(0)?,
            table_name: row.get(1)?,
            record_id: row.get(2)?,
            operation: row.get(3)?,
            data: row.get(4)?,
            organization_id: row.get(5)?,
            created_at: row.get(6)?,
            attempts: row.get(7)?,
            last_attempt: row.get(8)?,
            error_message: row.get(9)?,
            next_retry_at: row.get(10)?,
            retry_delay_ms: row.get(11)?,
            priority: row.get(12)?,
            module_type: row.get(13)?,
            conflict_strategy: row.get(14)?,
            version: row.get(15)?,
            status: row.get(16)?,
        })
    };

    let rows = if let Some(module_type) = query
        .module_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        stmt.query_map(params![module_type, limit], map_row)
            .map_err(|e| format!("sync_queue list_actionable_items query: {e}"))?
    } else {
        stmt.query_map(params![limit], map_row)
            .map_err(|e| format!("sync_queue list_actionable_items query: {e}"))?
    };

    Ok(rows.filter_map(Result::ok).collect())
}

pub fn retry_item(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE parity_sync_queue
         SET status = 'pending',
             attempts = 0,
             error_message = NULL,
             next_retry_at = NULL,
             last_attempt = NULL,
             retry_delay_ms = ?1
         WHERE id = ?2",
        params![DEFAULT_INITIAL_RETRY_DELAY_MS, item_id],
    )
    .map_err(|e| format!("sync_queue retry_item: {e}"))?;

    Ok(())
}

pub fn retry_items_by_module(
    conn: &Connection,
    module_type: &str,
) -> Result<RetryItemsResult, String> {
    let retried = conn
        .execute(
            "UPDATE parity_sync_queue
             SET status = 'pending',
                 attempts = 0,
                 error_message = NULL,
                 next_retry_at = NULL,
                 last_attempt = NULL,
                 retry_delay_ms = ?1
             WHERE module_type = ?2
               AND status IN ('pending', 'failed', 'conflict')",
            params![DEFAULT_INITIAL_RETRY_DELAY_MS, module_type],
        )
        .map_err(|e| format!("sync_queue retry_items_by_module: {e}"))?;

    Ok(RetryItemsResult {
        retried: retried as i64,
    })
}

pub fn list_conflict_audit_entries(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<ConflictAuditEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, operation_type, entity_id, entity_type, local_version,
                    server_version, timestamp, discarded_payload, resolution,
                    is_monetary, reviewed_by_operator
             FROM conflict_audit_log
             ORDER BY timestamp DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("sync_queue list_conflict_audit_entries prepare: {e}"))?;

    let rows = stmt
        .query_map(params![limit.clamp(1, 500)], |row| {
            Ok(ConflictAuditEntry {
                id: row.get(0)?,
                operation_type: row.get(1)?,
                entity_id: row.get(2)?,
                entity_type: row.get(3)?,
                local_version: row.get(4)?,
                server_version: row.get(5)?,
                timestamp: row.get(6)?,
                discarded_payload: row.get(7)?,
                resolution: row.get(8)?,
                is_monetary: row.get::<_, i64>(9)? != 0,
                reviewed_by_operator: row.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|e| format!("sync_queue list_conflict_audit_entries query: {e}"))?;

    Ok(rows.filter_map(Result::ok).collect())
}

/// Mark an item as successfully processed and remove it from the queue.
pub fn mark_success(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM parity_sync_queue WHERE id = ?1",
        params![item_id],
    )
    .map_err(|e| format!("sync_queue mark_success: {e}"))?;

    Ok(())
}

/// Mark an item as failed with exponential backoff for retry.
///
/// If max retries are exhausted, the item status changes to `failed`.
pub fn mark_failure(conn: &Connection, item_id: &str, error_message: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    // Get current attempts and retry delay
    let (attempts, retry_delay_ms): (i64, i64) = conn
        .query_row(
            "SELECT attempts, retry_delay_ms FROM parity_sync_queue WHERE id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("sync_queue mark_failure read: {e}"))?;

    let new_attempts = attempts + 1;

    if new_attempts >= MAX_RETRY_ATTEMPTS {
        // Max retries exhausted -- mark as permanently failed
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed', attempts = ?1, last_attempt = ?2,
                 error_message = ?3
             WHERE id = ?4",
            params![new_attempts, now, error_message, item_id],
        )
        .map_err(|e| format!("sync_queue mark_failed: {e}"))?;

        warn!(
            id = %item_id,
            attempts = new_attempts,
            "Sync queue item exhausted max retries, marked as failed"
        );
    } else {
        // Schedule retry with exponential backoff
        let new_delay = (retry_delay_ms * 2).min(MAX_RETRY_DELAY_MS);
        let next_retry = Utc::now() + ChronoDuration::milliseconds(new_delay);

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'pending', attempts = ?1, last_attempt = ?2,
                 error_message = ?3, retry_delay_ms = ?4,
                 next_retry_at = ?5
             WHERE id = ?6",
            params![
                new_attempts,
                now,
                error_message,
                new_delay,
                next_retry.to_rfc3339(),
                item_id,
            ],
        )
        .map_err(|e| format!("sync_queue schedule_retry: {e}"))?;
    }

    Ok(())
}

pub fn mark_rate_limited(
    conn: &Connection,
    item_id: &str,
    error_message: &str,
    retry_after_secs: i64,
) -> Result<(), String> {
    let now = Utc::now();
    let retry_after_secs = retry_after_secs.max(1);
    let retry_delay_ms = (retry_after_secs * 1000)
        .max(DEFAULT_INITIAL_RETRY_DELAY_MS)
        .min(MAX_RETRY_DELAY_MS);
    let next_retry = now + ChronoDuration::seconds(retry_after_secs);

    conn.execute(
        "UPDATE parity_sync_queue
         SET status = 'pending',
             last_attempt = ?1,
             error_message = ?2,
             retry_delay_ms = ?3,
             next_retry_at = ?4
         WHERE id = ?5",
        params![
            now.to_rfc3339(),
            error_message,
            retry_delay_ms,
            next_retry.to_rfc3339(),
            item_id,
        ],
    )
    .map_err(|e| format!("sync_queue mark_rate_limited: {e}"))?;

    Ok(())
}

pub fn mark_deferred(conn: &Connection, item_id: &str, reason: &str) -> Result<(), String> {
    let next_retry = Utc::now() + ChronoDuration::seconds(5);
    conn.execute(
        "UPDATE parity_sync_queue
         SET status = 'pending',
             error_message = ?1,
             next_retry_at = ?2
         WHERE id = ?3",
        params![reason, next_retry.to_rfc3339(), item_id],
    )
    .map_err(|e| format!("sync_queue mark_deferred: {e}"))?;

    Ok(())
}

/// Mark an item as having a conflict.
pub fn mark_conflict(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE parity_sync_queue SET status = 'conflict' WHERE id = ?1",
        params![item_id],
    )
    .map_err(|e| format!("sync_queue mark_conflict: {e}"))?;

    Ok(())
}

/// Log a conflict to the audit trail.
pub fn log_conflict(
    conn: &Connection,
    operation_type: &str,
    entity_id: &str,
    entity_type: &str,
    local_version: i64,
    server_version: i64,
    discarded_payload: &str,
    resolution: &str,
    is_monetary: bool,
    reviewed: bool,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO conflict_audit_log
            (id, operation_type, entity_id, entity_type, local_version,
             server_version, timestamp, discarded_payload, resolution,
             is_monetary, reviewed_by_operator)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            operation_type,
            entity_id,
            entity_type,
            local_version,
            server_version,
            now,
            discarded_payload,
            resolution,
            is_monetary as i32,
            reviewed as i32,
        ],
    )
    .map_err(|e| format!("sync_queue log_conflict: {e}"))?;

    info!(
        id = %id,
        entity = %entity_id,
        entity_type = %entity_type,
        resolution = %resolution,
        is_monetary = is_monetary,
        "Logged conflict to audit trail"
    );

    Ok(id)
}

/// Check for items older than the age warning threshold and log warnings.
pub fn check_age_warnings(conn: &Connection) -> Result<Vec<String>, String> {
    let threshold = Utc::now() - ChronoDuration::milliseconds(AGE_WARNING_THRESHOLD_MS);
    let threshold_str = threshold.to_rfc3339();

    let mut stmt = conn
        .prepare(
            "SELECT id, table_name, record_id, created_at
             FROM parity_sync_queue
             WHERE created_at <= ?1",
        )
        .map_err(|e| format!("sync_queue age_warnings prepare: {e}"))?;

    let warnings: Vec<String> = stmt
        .query_map(params![threshold_str], |row| {
            let id: String = row.get(0)?;
            let table: String = row.get(1)?;
            let record: String = row.get(2)?;
            let created: String = row.get(3)?;
            Ok(format!(
                "Item {id} ({table}/{record}) enqueued at {created} exceeds age threshold"
            ))
        })
        .map_err(|e| format!("sync_queue age_warnings query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    for warning in &warnings {
        warn!("{}", warning);
    }

    Ok(warnings)
}

fn prepare_request(conn: &Connection, item: &SyncQueueItem) -> Result<RequestPreparation, String> {
    let payload =
        serde_json::from_str::<Value>(&item.data).unwrap_or_else(|_| Value::Object(Map::new()));
    let terminal_id = match resolve_request_terminal_id(conn, &payload) {
        Some(value) => value,
        None => {
            return Ok(RequestPreparation::Failed {
                reason: "Parity sync request is missing terminal_id context".to_string(),
            })
        }
    };

    match item.table_name.as_str() {
        "orders" => prepare_order_request(conn, item, &payload, terminal_id.as_str()),
        "payments" => prepare_payment_request(conn, item, &payload, terminal_id.as_str()),
        "payment_adjustments" => {
            prepare_adjustment_request(conn, item, &payload, terminal_id.as_str())
        }
        "driver_earnings" | "driver_earning" | "shift_expenses" | "staff_payments" => {
            prepare_financial_request(conn, item, &payload, terminal_id.as_str())
        }
        "housekeeping_tasks" => prepare_housekeeping_request(item, &payload, terminal_id.as_str()),
        "customer_addresses" => {
            prepare_customer_address_request(conn, item, &payload, terminal_id.as_str())
        }
        _ => Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: resolve_endpoint(item),
            method: resolve_http_method(item),
            body: if resolve_http_method(item) == Method::DELETE {
                None
            } else {
                Some(item.data.clone())
            },
            terminal_id,
        })),
    }
}

fn prepare_customer_address_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let Some(customer_id) = extract_customer_id_from_sync_payload(item) else {
        return Ok(RequestPreparation::Failed {
            reason: "Customer address sync payload is missing customer_id".to_string(),
        });
    };

    let should_create = item.operation == "INSERT"
        || (item.operation == "UPDATE" && is_local_placeholder_id(item.record_id.as_str()));
    let method = if item.operation == "DELETE" && !should_create {
        Method::DELETE
    } else if should_create {
        Method::POST
    } else {
        Method::PATCH
    };
    let endpoint = if should_create {
        format!("/api/pos/customers/{customer_id}/addresses")
    } else {
        format!(
            "/api/pos/customers/{customer_id}/addresses/{}",
            item.record_id
        )
    };

    let body = if method == Method::DELETE {
        None
    } else {
        let mut request_payload = if should_create {
            merge_customer_address_payload_for_recreate(
                conn,
                customer_id.as_str(),
                item.record_id.as_str(),
                payload,
            )
        } else {
            merge_customer_address_payload_from_cache(
                conn,
                customer_id.as_str(),
                item.record_id.as_str(),
                payload,
            )
        };

        if should_create && !has_customer_address_street(&request_payload) {
            return Ok(RequestPreparation::Failed {
                reason: "Customer address recreate is missing street_address details".to_string(),
            });
        }

        if let Some(object) = request_payload.as_object_mut() {
            object.insert(
                "customer_id".to_string(),
                Value::String(customer_id.clone()),
            );
            if should_create {
                object.remove("id");
                object.remove("addressId");
                object.remove("version");
                object.remove("expected_version");
            }
        }

        Some(request_payload.to_string())
    };

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint,
        method,
        body,
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_order_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    if item.operation == "INSERT" {
        let body = match build_order_insert_body(conn, item.record_id.as_str(), payload) {
            Ok(body) => body,
            Err(reason) => return Ok(RequestPreparation::Failed { reason }),
        };

        return Ok(RequestPreparation::Ready(RequestSpec {
            endpoint: "/api/pos/orders".to_string(),
            method: Method::POST,
            body: Some(body.to_string()),
            terminal_id: terminal_id.to_string(),
        }));
    }

    let remote_id: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(supabase_id, '')), '')
             FROM orders
             WHERE id = ?1",
            params![item.record_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_order_request remote id: {e}"))?
        .flatten();

    let Some(remote_id) = remote_id else {
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent order sync".to_string(),
        });
    };

    let mut status = string_field(payload, &["status"]).unwrap_or_default();
    if status.is_empty() {
        status = conn
            .query_row(
                "SELECT COALESCE(status, '') FROM orders WHERE id = ?1",
                params![item.record_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("sync_queue prepare_order_request status: {e}"))?
            .unwrap_or_default();
    }
    if status.trim().is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Order update payload is missing status".to_string(),
        });
    }

    let mut body = Map::new();
    body.insert("id".to_string(), Value::String(remote_id));
    body.insert("status".to_string(), Value::String(status));

    if let Some(value) = payload
        .get("estimatedTime")
        .or_else(|| payload.get("estimated_time"))
    {
        if !value.is_null() {
            body.insert("estimated_time".to_string(), value.clone());
        }
    }
    if let Some(value) = payload
        .get("notes")
        .or_else(|| payload.get("reason"))
        .or_else(|| payload.get("orderNotes"))
        .or_else(|| payload.get("order_notes"))
    {
        if !value.is_null() {
            body.insert("notes".to_string(), value.clone());
        }
    }
    for (camel, snake) in [
        ("totalAmount", "total_amount"),
        ("subtotal", "subtotal"),
        ("discountAmount", "discount_amount"),
        ("discountPercentage", "discount_percentage"),
        ("taxAmount", "tax_amount"),
        ("deliveryFee", "delivery_fee"),
        ("tipAmount", "tip_amount"),
        ("paymentStatus", "payment_status"),
        ("paymentMethod", "payment_method"),
    ] {
        if let Some(value) = payload.get(camel).or_else(|| payload.get(snake)) {
            if !value.is_null() {
                body.insert(snake.to_string(), value.clone());
            }
        }
    }
    if let Some(items) = payload.get("items") {
        if !items.is_null() {
            body.insert("items".to_string(), items.clone());
        }
    }
    if let Some(order_notes) = payload
        .get("orderNotes")
        .or_else(|| payload.get("order_notes"))
    {
        if !order_notes.is_null() {
            body.insert("order_notes".to_string(), order_notes.clone());
        }
    }

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/orders".to_string(),
        method: Method::PATCH,
        body: Some(Value::Object(body).to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_payment_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let local_order_id = string_field(payload, &["orderId", "order_id"]).unwrap_or_default();
    if local_order_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Payment sync payload is missing orderId".to_string(),
        });
    }

    let remote_order_id: Option<String> = conn
        .query_row(
            "SELECT NULLIF(TRIM(COALESCE(supabase_id, '')), '')
             FROM orders
             WHERE id = ?1 OR supabase_id = ?1
             LIMIT 1",
            params![local_order_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_payment_request remote order: {e}"))?
        .flatten();

    let Some(remote_order_id) = remote_order_id else {
        let _ = conn.execute(
            "UPDATE order_payments
             SET sync_state = 'waiting_parent',
                 sync_status = 'pending',
                 updated_at = datetime('now')
             WHERE id = ?1",
            params![item.record_id.as_str()],
        );
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent order sync".to_string(),
        });
    };

    let amount = payload
        .get("amount")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    if amount <= 0.0 {
        return Ok(RequestPreparation::Failed {
            reason: "Payment sync payload has invalid amount".to_string(),
        });
    }
    let payment_method = string_field(payload, &["method", "paymentMethod", "payment_method"])
        .unwrap_or_else(|| "other".to_string());

    let mut body = serde_json::json!({
        "order_id": remote_order_id,
        "amount": amount,
        "payment_method": payment_method,
        "idempotency_key": format!("payment:{}", item.record_id),
        "metadata": {
            "terminal_id": terminal_id,
            "local_payment_id": item.record_id,
            "payment_origin": string_field(payload, &["paymentOrigin", "payment_origin"]),
        }
    });
    if let Some(value) = string_field(payload, &["transactionRef", "transaction_ref"]) {
        body["external_transaction_id"] = Value::String(value);
    }
    if let Some(value) = payload.get("tipAmount").and_then(Value::as_f64) {
        body["tip_amount"] = Value::from(value);
    }
    if let Some(value) = string_field(payload, &["currency"]) {
        body["currency"] = Value::String(value);
    }
    if let Some(items) = payload.get("items") {
        if items
            .as_array()
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        {
            body["items"] = items.clone();
        }
    }

    let _ = conn.execute(
        "UPDATE order_payments
         SET sync_state = 'syncing',
             updated_at = datetime('now')
         WHERE id = ?1",
        params![item.record_id.as_str()],
    );

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/payments".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_adjustment_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let payment_id = string_field(payload, &["paymentId", "payment_id"]).unwrap_or_default();
    if payment_id.is_empty() {
        return Ok(RequestPreparation::Failed {
            reason: "Adjustment sync payload is missing paymentId".to_string(),
        });
    }

    let payment_context: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT COALESCE(sync_state, ''), remote_payment_id, order_id
             FROM order_payments
             WHERE id = ?1",
            params![payment_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("sync_queue prepare_adjustment_request payment context: {e}"))?;

    let Some((payment_sync_state, remote_payment_id, order_id)) = payment_context else {
        return Ok(RequestPreparation::Failed {
            reason: "Adjustment parent payment was not found locally".to_string(),
        });
    };

    let canonical_payment_id = remote_payment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if payment_sync_state != "applied" || canonical_payment_id.is_none() {
        let _ = conn.execute(
            "UPDATE payment_adjustments
             SET sync_state = 'waiting_parent',
                 sync_last_error = NULL,
                 updated_at = datetime('now')
             WHERE id = ?1",
            params![item.record_id.as_str()],
        );
        return Ok(RequestPreparation::Deferred {
            reason: "Waiting for parent payment sync".to_string(),
        });
    }

    let (_, branch_id, _) = resolve_runtime_context(conn, payload);
    let adjustment_type =
        string_field(payload, &["adjustmentType", "adjustment_type"]).unwrap_or_default();
    let order_id_for_sync =
        string_field(payload, &["orderId", "order_id"]).or_else(|| order_id.clone());
    let client_order_id_for_sync =
        string_field(payload, &["clientOrderId", "client_order_id"]).or_else(|| order_id.clone());
    let idempotency_key = format!("adjustment:{}", item.record_id);
    let body = sync::build_adjustment_sync_body(
        item.record_id.as_str(),
        payment_id.as_str(),
        order_id_for_sync.as_deref(),
        client_order_id_for_sync.as_deref(),
        if adjustment_type.is_empty() {
            None
        } else {
            Some(adjustment_type.as_str())
        },
        payload.get("amount").and_then(Value::as_f64),
        string_field(payload, &["reason"]).as_deref(),
        string_field(payload, &["staffId", "staff_id"]).as_deref(),
        string_field(payload, &["staffShiftId", "staff_shift_id"]).as_deref(),
        terminal_id,
        branch_id.as_str(),
        idempotency_key.as_str(),
        string_field(payload, &["refundMethod", "refund_method"]).as_deref(),
        string_field(payload, &["cashHandler", "cash_handler"]).as_deref(),
        string_field(payload, &["adjustmentContext", "adjustment_context"]).as_deref(),
        canonical_payment_id.as_deref(),
        canonical_payment_id.as_deref(),
    );

    let _ = conn.execute(
        "UPDATE payment_adjustments
         SET sync_state = 'syncing',
             updated_at = datetime('now')
         WHERE id = ?1",
        params![item.record_id.as_str()],
    );

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/payments/adjustments/sync".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn financial_entity_type(table_name: &str) -> &str {
    match table_name {
        "driver_earnings" => "driver_earning",
        "shift_expenses" => "shift_expense",
        "staff_payments" => "staff_payment",
        other => other,
    }
}

fn financial_operation(operation: &str) -> &str {
    match operation {
        "DELETE" => "delete",
        _ => "create",
    }
}

fn prepare_financial_request(
    conn: &Connection,
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let (_, branch_id, _) = resolve_runtime_context(conn, payload);
    let body = serde_json::json!({
        "terminal_id": terminal_id,
        "branch_id": branch_id,
        "items": [{
            "entity_type": financial_entity_type(item.table_name.as_str()),
            "entity_id": item.record_id,
            "operation": financial_operation(item.operation.as_str()),
            "idempotency_key": format!("parity:{}", item.id),
            "payload": payload,
        }],
    });

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint: "/api/pos/financial/sync".to_string(),
        method: Method::POST,
        body: Some(body.to_string()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn prepare_housekeeping_request(
    item: &SyncQueueItem,
    payload: &Value,
    terminal_id: &str,
) -> Result<RequestPreparation, String> {
    let endpoint = if payload.get("status").is_some() {
        "/api/pos/housekeeping".to_string()
    } else {
        format!("/api/pos/housekeeping/{}", item.record_id)
    };

    Ok(RequestPreparation::Ready(RequestSpec {
        endpoint,
        method: Method::PATCH,
        body: Some(item.data.clone()),
        terminal_id: terminal_id.to_string(),
    }))
}

fn extract_response_string(response: Option<&Value>, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = response?;
        let mut found = true;
        for segment in path.split('.') {
            current = match current.get(segment) {
                Some(value) => value,
                None => {
                    found = false;
                    break;
                }
            };
        }

        if found {
            if let Some(value) = current.as_str() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

fn apply_success(
    conn: &Connection,
    item: &SyncQueueItem,
    response: Option<&Value>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    match item.table_name.as_str() {
        "orders" => {
            if item.operation == "INSERT" {
                let remote_id = extract_response_string(
                    response,
                    &["data.id", "data.order_id", "order_id", "id"],
                );
                conn.execute(
                    "UPDATE orders
                     SET sync_status = 'synced',
                         last_synced_at = ?1,
                         supabase_id = COALESCE(NULLIF(supabase_id, ''), ?2),
                         updated_at = ?1
                     WHERE id = ?3",
                    params![now, remote_id, item.record_id.as_str()],
                )
                .map_err(|e| format!("sync_queue apply_success order insert: {e}"))?;
                sync::promote_payments_for_order(conn, item.record_id.as_str());
            } else {
                conn.execute(
                    "UPDATE orders
                     SET sync_status = 'synced',
                         last_synced_at = ?1,
                         updated_at = ?1
                     WHERE id = ?2",
                    params![now, item.record_id.as_str()],
                )
                .map_err(|e| format!("sync_queue apply_success order update: {e}"))?;
            }
        }
        "payments" => {
            let remote_payment_id =
                extract_response_string(response, &["payment_id", "id", "data.id"]);
            sync::mark_local_payment_applied(
                conn,
                item.record_id.as_str(),
                now.as_str(),
                remote_payment_id.as_deref(),
            )?;
        }
        "payment_adjustments" => {
            conn.execute(
                "UPDATE payment_adjustments
                 SET sync_state = 'applied',
                     sync_retry_count = 0,
                     sync_last_error = NULL,
                     sync_next_retry_at = NULL,
                     updated_at = ?1
                 WHERE id = ?2",
                params![now, item.record_id.as_str()],
            )
            .map_err(|e| format!("sync_queue apply_success adjustment: {e}"))?;

            let payload = serde_json::from_str::<Value>(&item.data)
                .unwrap_or_else(|_| Value::Object(Map::new()));
            let adjustment_type =
                string_field(&payload, &["adjustmentType", "adjustment_type"]).unwrap_or_default();
            if adjustment_type.eq_ignore_ascii_case("void") {
                if let Some(payment_id) = string_field(&payload, &["paymentId", "payment_id"]) {
                    let _ = conn.execute(
                        "UPDATE order_payments
                         SET sync_status = 'synced',
                             sync_retry_count = 0,
                             sync_last_error = NULL,
                             sync_next_retry_at = NULL,
                             updated_at = ?1
                         WHERE id = ?2",
                        params![now, payment_id],
                    );
                }
            }
        }
        "customer_addresses" => {
            update_customer_address_cache_after_sync(conn, item, response)?;
        }
        "driver_earnings" | "driver_earning" => {
            if item.operation != "DELETE" {
                let remote_id = response
                    .and_then(|value| value.get("results"))
                    .and_then(Value::as_array)
                    .and_then(|rows| rows.first())
                    .and_then(|result| {
                        result
                            .get("server_id")
                            .or_else(|| result.get("supabase_id"))
                            .and_then(Value::as_str)
                    })
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| item.record_id.clone());
                let _ = conn.execute(
                    "UPDATE driver_earnings
                     SET supabase_id = ?1,
                         updated_at = ?2
                     WHERE id = ?3",
                    params![remote_id, now, item.record_id.as_str()],
                );
            }
        }
        _ => {}
    }

    Ok(())
}

/// Process all pending items in the queue by sending them to the admin API.
///
/// Items are processed FIFO within priority bands. On success, items are
/// removed. On transient failure (5xx / network), items are rescheduled
/// with exponential backoff. On conflict (409), items are marked as
/// `conflict`. On client error (4xx != 409), items are marked as `failed`.
pub async fn process_queue(
    conn: &std::sync::Mutex<Connection>,
    api_base_url: &str,
    api_key: &str,
) -> Result<SyncResult, String> {
    // Check for age warnings before processing
    {
        let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
        let _ = check_age_warnings(&db);
        let _ = recover_stale_processing_items(&db)?;
        let mut remaining_requeue_budget = MAX_AUTO_REQUEUE_ITEMS_PER_CYCLE;

        let terminal_context_retries =
            retry_failed_terminal_context_items_limited(&db, remaining_requeue_budget)?;
        remaining_requeue_budget =
            remaining_requeue_budget.saturating_sub(terminal_context_retries.retried as usize);

        let rate_limited_retries =
            retry_failed_rate_limited_items_limited(&db, remaining_requeue_budget)?;
        remaining_requeue_budget =
            remaining_requeue_budget.saturating_sub(rate_limited_retries.retried as usize);

        let legacy_order_retries =
            retry_failed_legacy_order_insert_items_limited(&db, remaining_requeue_budget)?;
        remaining_requeue_budget =
            remaining_requeue_budget.saturating_sub(legacy_order_retries.retried as usize);

        let payment_conflict_resolutions =
            resolve_failed_payment_total_conflict_items_limited(&db, remaining_requeue_budget)?;
        remaining_requeue_budget =
            remaining_requeue_budget.saturating_sub(payment_conflict_resolutions.retried as usize);

        let _ =
            retry_failed_customer_address_not_found_items_limited(&db, remaining_requeue_budget)?;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("sync_queue client build: {e}"))?;
    let mut processed: i64 = 0;
    let mut failed: i64 = 0;
    let mut conflicts: i64 = 0;
    let mut errors: Vec<SyncError> = Vec::new();

    loop {
        // Dequeue next item under lock, then release lock before HTTP call
        let item = {
            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
            dequeue(&db)?
        };

        let item = match item {
            Some(i) => i,
            None => break,
        };

        let request_spec = {
            let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
            prepare_request(&db, &item)?
        };

        let request_spec = match request_spec {
            RequestPreparation::Ready(spec) => spec,
            RequestPreparation::Deferred { reason } => {
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                mark_deferred(&db, &item.id, &reason)?;
                continue;
            }
            RequestPreparation::Failed { reason } => {
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                mark_failure(&db, &item.id, &reason)?;
                db.execute(
                    "UPDATE parity_sync_queue SET status = 'failed' WHERE id = ?1",
                    params![item.id],
                )
                .map_err(|e| format!("mark parity item permanently failed: {e}"))?;
                failed += 1;
                errors.push(SyncError {
                    item_id: item.id.clone(),
                    table_name: item.table_name.clone(),
                    record_id: item.record_id.clone(),
                    error: reason,
                    http_status: None,
                });
                continue;
            }
        };

        let url = format!(
            "{}{}",
            api_base_url.trim_end_matches('/'),
            request_spec.endpoint
        );

        let mut request = client
            .request(request_spec.method.clone(), &url)
            .header("x-pos-api-key", api_key)
            .header("x-terminal-id", request_spec.terminal_id.as_str())
            .header("Content-Type", "application/json");

        if let Some(body) = request_spec.body.as_ref() {
            request = request.body(body.clone());
        }

        let response = request.send().await;

        match response {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let is_success = resp.status().is_success();
                let retry_after_secs = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.trim().parse::<i64>().ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(DEFAULT_RATE_LIMIT_RETRY_SECS);
                let response_body = resp.text().await.unwrap_or_default();
                let response_json = serde_json::from_str::<Value>(&response_body).ok();
                if is_success {
                    // Success -- remove from queue
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    apply_success(&db, &item, response_json.as_ref())?;
                    mark_success(&db, &item.id)?;
                    processed += 1;
                } else if status == 409 {
                    let server_record = fetch_server_record(
                        &client,
                        api_base_url,
                        api_key,
                        request_spec.terminal_id.as_str(),
                        &item,
                    )
                    .await;
                    let server_version =
                        derive_server_version(server_record.as_ref(), &response_body, item.version);
                    let is_monetary = is_monetary_item(&item);
                    let resolution = match item.conflict_strategy.as_str() {
                        "manual" => "manual",
                        "client-wins" => "client-wins",
                        _ if is_monetary => "server-wins",
                        _ => "auto-server-wins",
                    };
                    let requires_operator_review =
                        resolution == "manual" || resolution == "client-wins" || is_monetary;

                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    log_conflict(
                        &db,
                        &item.operation,
                        &item.record_id,
                        &item.table_name,
                        item.version,
                        server_version,
                        &item.data,
                        resolution,
                        is_monetary,
                        false,
                    )?;

                    if requires_operator_review {
                        mark_conflict(&db, &item.id)?;
                        conflicts += 1;
                        errors.push(SyncError {
                            item_id: item.id.clone(),
                            table_name: item.table_name.clone(),
                            record_id: item.record_id.clone(),
                            error: format!(
                                "Conflict detected (HTTP 409) requiring review: {}",
                                resolution
                            ),
                            http_status: Some(status),
                        });
                    } else {
                        mark_success(&db, &item.id)?;
                        processed += 1;
                    }
                } else if status == 429 {
                    let error_message = format!("HTTP {status}: {response_body}");
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    mark_rate_limited(&db, &item.id, &error_message, retry_after_secs)?;
                    failed += 1;
                    errors.push(SyncError {
                        item_id: item.id.clone(),
                        table_name: item.table_name.clone(),
                        record_id: item.record_id.clone(),
                        error: error_message,
                        http_status: Some(status),
                    });
                    warn!(
                        item_id = %item.id,
                        table_name = %item.table_name,
                        record_id = %item.record_id,
                        retry_after_secs = retry_after_secs,
                        "Parity sync hit admin rate limiting; pausing the batch"
                    );
                    break;
                } else if status >= 400 && status < 500 {
                    // Client error (not retriable)
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    let error_message = format!("HTTP {status}: {response_body}");
                    let resolved_at = Utc::now().to_rfc3339();
                    if item.table_name == "payments"
                        && is_payment_total_conflict_error(&error_message)
                        && sync::resolve_payment_total_conflict_with_server_hint_with_conn(
                            &db,
                            item.record_id.as_str(),
                            error_message.as_str(),
                            resolved_at.as_str(),
                        )?
                        .is_some()
                    {
                        mark_success(&db, &item.id)?;
                        processed += 1;
                        continue;
                    }
                    mark_failure(&db, &item.id, &error_message)?;
                    // Force to failed status since client errors won't recover
                    db.execute(
                        "UPDATE parity_sync_queue SET status = 'failed' WHERE id = ?1",
                        params![item.id],
                    )
                    .map_err(|e| format!("mark client error failed: {e}"))?;
                    failed += 1;
                    errors.push(SyncError {
                        item_id: item.id.clone(),
                        table_name: item.table_name.clone(),
                        record_id: item.record_id.clone(),
                        error: error_message,
                        http_status: Some(status),
                    });
                } else {
                    // Server error (retriable)
                    let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                    mark_failure(&db, &item.id, &format!("HTTP {status}: {response_body}"))?;
                    failed += 1;
                    errors.push(SyncError {
                        item_id: item.id.clone(),
                        table_name: item.table_name.clone(),
                        record_id: item.record_id.clone(),
                        error: format!("HTTP {status}: {response_body}"),
                        http_status: Some(status),
                    });
                }
            }
            Err(e) => {
                // Network error (retriable)
                let db = conn.lock().map_err(|e| format!("lock: {e}"))?;
                mark_failure(&db, &item.id, &format!("Network error: {e}"))?;
                failed += 1;
                errors.push(SyncError {
                    item_id: item.id.clone(),
                    table_name: item.table_name.clone(),
                    record_id: item.record_id.clone(),
                    error: format!("Network error: {e}"),
                    http_status: None,
                });
            }
        }
    }

    let success = failed == 0 && conflicts == 0;

    Ok(SyncResult {
        success,
        processed,
        failed,
        conflicts,
        errors,
    })
}

/// Map a queue item's module type to the appropriate admin API endpoint.
fn resolve_endpoint(item: &SyncQueueItem) -> String {
    if matches!(item.table_name.as_str(), "payments" | "payment_adjustments") {
        return resolve_financial_endpoint(item);
    }

    if let Some(endpoint) = resolve_special_entity_endpoint(item) {
        return endpoint;
    }

    match item.module_type.as_str() {
        "orders" => resolve_orders_endpoint(item),
        "customers" => resolve_customers_endpoint(item),
        "shifts" => "/api/pos/shifts/sync".to_string(),
        "financial" => "/api/pos/financial/sync".to_string(),
        "z_report" => "/api/pos/z-report/submit".to_string(),
        "loyalty" => "/api/pos/loyalty/sync".to_string(),
        _ => resolve_generic_endpoint(item),
    }
}

fn resolve_special_entity_endpoint(item: &SyncQueueItem) -> Option<String> {
    match item.table_name.as_str() {
        "inventory_adjustments" => Some("/api/pos/inventory".to_string()),
        "coupons" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/coupons".to_string(),
            _ => format!("/api/pos/coupons/{}", item.record_id),
        }),
        "menu_categories" => Some(format!("/api/pos/sync/menu_categories/{}", item.record_id)),
        "menu_subcategories" => Some(format!("/api/pos/sync/subcategories/{}", item.record_id)),
        "menu_ingredients" => Some(format!("/api/pos/sync/ingredients/{}", item.record_id)),
        "menu_combos" => Some(format!("/api/menu/combos/{}", item.record_id)),
        "reservations" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/reservations".to_string(),
            _ => format!("/api/pos/reservations/{}", item.record_id),
        }),
        "appointments" => Some(match item.operation.as_str() {
            "INSERT" => "/api/pos/appointments".to_string(),
            _ => format!("/api/pos/appointments/{}/status", item.record_id),
        }),
        "salon_staff_shifts" => Some("/api/pos/staff-schedule".to_string()),
        "drive_thru_orders" => Some("/api/pos/drive-through".to_string()),
        "rooms" => Some(format!("/api/pos/rooms/{}", item.record_id)),
        "products" => Some(format!("/api/pos/products/{}", item.record_id)),
        _ => None,
    }
}

fn resolve_http_method(item: &SyncQueueItem) -> Method {
    match item.operation.as_str() {
        "UPDATE" => Method::PATCH,
        "DELETE" => Method::DELETE,
        _ => Method::POST,
    }
}

fn resolve_orders_endpoint(item: &SyncQueueItem) -> String {
    match item.operation.as_str() {
        "INSERT" => "/api/pos/orders".to_string(),
        _ => "/api/pos/orders".to_string(),
    }
}

fn resolve_financial_endpoint(item: &SyncQueueItem) -> String {
    match item.table_name.as_str() {
        "payments" => "/api/pos/payments".to_string(),
        "payment_adjustments" => "/api/pos/payments/adjustments/sync".to_string(),
        "driver_earnings" | "driver_earning" | "shift_expenses" | "staff_payments" => {
            "/api/pos/financial/sync".to_string()
        }
        _ => "/api/pos/financial/sync".to_string(),
    }
}

fn extract_customer_id_from_sync_payload(item: &SyncQueueItem) -> Option<String> {
    serde_json::from_str::<Value>(&item.data)
        .ok()
        .and_then(|payload| {
            payload
                .get("customer_id")
                .or_else(|| payload.get("customerId"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

fn resolve_customers_endpoint(item: &SyncQueueItem) -> String {
    match item.table_name.as_str() {
        "customers" => match item.operation.as_str() {
            "INSERT" => "/api/pos/customers".to_string(),
            _ => format!("/api/pos/customers/{}", item.record_id),
        },
        "customer_addresses" => {
            if let Some(customer_id) = extract_customer_id_from_sync_payload(item) {
                match item.operation.as_str() {
                    "INSERT" => format!("/api/pos/customers/{customer_id}/addresses"),
                    _ => format!(
                        "/api/pos/customers/{customer_id}/addresses/{}",
                        item.record_id
                    ),
                }
            } else {
                resolve_generic_endpoint(item)
            }
        }
        _ => resolve_generic_endpoint(item),
    }
}

fn resolve_generic_endpoint(item: &SyncQueueItem) -> String {
    match item.operation.as_str() {
        "UPDATE" | "DELETE" => format!("/api/pos/sync/{}/{}", item.table_name, item.record_id),
        _ => format!("/api/pos/sync/{}", item.table_name),
    }
}

fn is_monetary_item(item: &SyncQueueItem) -> bool {
    let monetary_tables = [
        "payments",
        "payment_adjustments",
        "payment_transactions",
        "refund_transactions",
        "driver_earnings",
        "driver_earning",
    ];
    if monetary_tables.contains(&item.table_name.as_str()) {
        return true;
    }

    let monetary_fields = [
        "total",
        "subtotal",
        "tax",
        "discount_amount",
        "payment_amount",
        "refund_amount",
        "amount",
        "price",
        "unit_price",
        "order_total",
        "grand_total",
        "tip",
        "tip_amount",
    ];

    serde_json::from_str::<Value>(&item.data)
        .ok()
        .and_then(|payload| payload.as_object().cloned())
        .map(|payload| {
            payload
                .keys()
                .any(|key| monetary_fields.contains(&key.as_str()))
        })
        .unwrap_or(false)
}

async fn fetch_server_record(
    client: &reqwest::Client,
    api_base_url: &str,
    api_key: &str,
    terminal_id: &str,
    item: &SyncQueueItem,
) -> Option<Value> {
    let endpoint = format!(
        "{}/api/pos/sync/{}/{}",
        api_base_url.trim_end_matches('/'),
        item.table_name,
        item.record_id
    );

    let response = client
        .get(&endpoint)
        .header("x-pos-api-key", api_key)
        .header("x-terminal-id", terminal_id)
        .header("Content-Type", "application/json")
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body = response.json::<Value>().await.ok()?;
    body.get("data").cloned().or(Some(body))
}

fn derive_server_version(
    server_record: Option<&Value>,
    conflict_body: &str,
    local_version: i64,
) -> i64 {
    let read_version = |value: &Value| -> Option<i64> {
        value
            .get("version")
            .and_then(|candidate| candidate.as_i64())
            .or_else(|| {
                value
                    .get("server_version")
                    .and_then(|candidate| candidate.as_i64())
            })
            .or_else(|| {
                value
                    .get("row_version")
                    .and_then(|candidate| candidate.as_i64())
            })
    };

    if let Some(record) = server_record {
        if let Some(version) = read_version(record) {
            return version;
        }
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(conflict_body) {
        if let Some(version) = read_version(&parsed) {
            return version;
        }
    }

    local_version + 1
}

// ---------------------------------------------------------------------------
// Use rusqlite::OptionalExtension for query_row returning Option
// ---------------------------------------------------------------------------
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    fn clear_terminal_identity() {
        // Tests must not mutate the shared OS keyring used by the live POS app.
    }

    const TEST_TERMINAL_ID: &str = "terminal-test";
    const TEST_BRANCH_ID: &str = "11111111-1111-1111-1111-111111111111";
    const TEST_MENU_ITEM_ID: &str = "22222222-2222-2222-2222-222222222222";

    fn seed_terminal_context(conn: &Connection) {
        crate::db::set_setting(conn, "terminal", "terminal_id", TEST_TERMINAL_ID)
            .expect("store terminal id");
        crate::db::set_setting(conn, "terminal", "branch_id", TEST_BRANCH_ID)
            .expect("store branch id");
    }

    fn seed_customer_cache(conn: &Connection, customer_id: &str, address: Value) {
        crate::db::set_setting(
            conn,
            "local",
            "customer_cache_v1",
            &json!([
                {
                    "id": customer_id,
                    "name": "Test Customer",
                    "addresses": [address]
                }
            ])
            .to_string(),
        )
        .expect("seed customer cache");
    }

    fn queue_item(
        table_name: &str,
        operation: &str,
        record_id: &str,
        data: Value,
    ) -> SyncQueueItem {
        SyncQueueItem {
            id: "queue-1".to_string(),
            table_name: table_name.to_string(),
            record_id: record_id.to_string(),
            operation: operation.to_string(),
            data: data.to_string(),
            organization_id: "org-1".to_string(),
            created_at: Utc::now().to_rfc3339(),
            attempts: 0,
            last_attempt: None,
            error_message: None,
            next_retry_at: None,
            retry_delay_ms: 1000,
            priority: 0,
            module_type: "customers".to_string(),
            conflict_strategy: "manual".to_string(),
            version: 1,
            status: "pending".to_string(),
        }
    }

    #[derive(Debug)]
    struct CapturedRequest {
        request_line: String,
        headers: HashMap<String, String>,
        body: String,
    }

    #[derive(Debug, Clone)]
    struct MockResponse {
        status_code: u16,
        body: String,
    }

    impl MockResponse {
        fn json(status_code: u16, body: impl Into<String>) -> Self {
            Self {
                status_code,
                body: body.into(),
            }
        }
    }

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::run_migrations_for_test(&conn);
        create_tables(&conn).expect("create sync queue tables");
        crate::db::set_setting(&conn, "terminal", "__ignore_keyring", "1")
            .expect("disable keyring reads for sync_queue tests");
        conn
    }

    fn enqueue_test_item(
        conn: &Connection,
        table_name: &str,
        operation: &str,
        record_id: &str,
        data: Value,
    ) -> String {
        enqueue(
            conn,
            &EnqueueInput {
                table_name: table_name.to_string(),
                record_id: record_id.to_string(),
                operation: operation.to_string(),
                data: data.to_string(),
                organization_id: "org-1".to_string(),
                priority: None,
                module_type: Some("customers".to_string()),
                conflict_strategy: Some("manual".to_string()),
                version: Some(1),
            },
        )
        .expect("enqueue test item")
    }

    async fn spawn_mock_http_server(
        responses: Vec<MockResponse>,
    ) -> (
        String,
        mpsc::UnboundedReceiver<CapturedRequest>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let captured = read_http_request(&mut stream).await;
                tx.send(captured).expect("send captured request");
                write_http_response(&mut stream, &response)
                    .await
                    .expect("write mock response");
            }
        });

        (format!("http://{}", address), rx, handle)
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> CapturedRequest {
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 4096];
        let mut header_end = None;
        let mut content_length = 0_usize;

        loop {
            let read = stream.read(&mut chunk).await.expect("read request");
            assert!(read > 0, "request closed before mock server read completed");
            buffer.extend_from_slice(&chunk[..read]);

            if header_end.is_none() {
                header_end = find_bytes(&buffer, b"\r\n\r\n");
                if let Some(index) = header_end {
                    let headers_text = String::from_utf8_lossy(&buffer[..index + 4]).to_string();
                    content_length = parse_content_length(&headers_text);
                }
            }

            if let Some(index) = header_end {
                let total_length = index + 4 + content_length;
                if buffer.len() >= total_length {
                    let request_text =
                        String::from_utf8(buffer[..total_length].to_vec()).expect("utf8 request");
                    return parse_request_text(&request_text);
                }
            }
        }
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn parse_content_length(headers_text: &str) -> usize {
        headers_text
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0)
    }

    fn parse_request_text(request_text: &str) -> CapturedRequest {
        let mut sections = request_text.splitn(2, "\r\n\r\n");
        let header_block = sections.next().unwrap_or_default();
        let body = sections.next().unwrap_or_default().to_string();
        let mut header_lines = header_block.lines();
        let request_line = header_lines.next().unwrap_or_default().to_string();
        let headers = header_lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect::<HashMap<_, _>>();

        CapturedRequest {
            request_line,
            headers,
            body,
        }
    }

    async fn write_http_response(
        stream: &mut tokio::net::TcpStream,
        response: &MockResponse,
    ) -> Result<(), std::io::Error> {
        let reason = match response.status_code {
            200 => "OK",
            401 => "Unauthorized",
            409 => "Conflict",
            _ => "OK",
        };
        let response_text = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response.status_code,
            reason,
            response.body.len(),
            response.body
        );
        stream.write_all(response_text.as_bytes()).await?;
        stream.flush().await
    }

    #[test]
    fn resolve_customers_endpoint_uses_customer_routes() {
        let insert_customer = queue_item(
            "customers",
            "INSERT",
            "cust-1",
            serde_json::json!({ "name": "Ada", "phone": "1234" }),
        );
        let update_customer = queue_item(
            "customers",
            "UPDATE",
            "cust-1",
            serde_json::json!({ "name": "Ada Lovelace" }),
        );
        let insert_address = queue_item(
            "customer_addresses",
            "INSERT",
            "addr-1",
            serde_json::json!({
                "customer_id": "cust-1",
                "street_address": "Main St 42"
            }),
        );
        let update_address = queue_item(
            "customer_addresses",
            "UPDATE",
            "addr-1",
            serde_json::json!({
                "customer_id": "cust-1",
                "notes": "Ring once"
            }),
        );

        assert_eq!(resolve_endpoint(&insert_customer), "/api/pos/customers");
        assert_eq!(
            resolve_endpoint(&update_customer),
            "/api/pos/customers/cust-1"
        );
        assert_eq!(
            resolve_endpoint(&insert_address),
            "/api/pos/customers/cust-1/addresses"
        );
        assert_eq!(
            resolve_endpoint(&update_address),
            "/api/pos/customers/cust-1/addresses/addr-1"
        );
    }

    #[test]
    fn resolve_customers_endpoint_falls_back_when_customer_id_missing() {
        let address_item = queue_item(
            "customer_addresses",
            "UPDATE",
            "addr-1",
            serde_json::json!({ "notes": "Ring once" }),
        );

        assert_eq!(
            resolve_endpoint(&address_item),
            "/api/pos/sync/customer_addresses/addr-1"
        );
    }

    #[test]
    fn prepare_customer_address_request_recreates_placeholder_updates_from_cache() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-1",
            json!({
                "id": "local-new",
                "street_address": "Main St 42",
                "city": "Athens",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        let item = queue_item(
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-1",
                "coordinates": { "lat": 40.61, "lng": 22.95 },
                "latitude": 40.61,
                "longitude": 22.95
            }),
        );

        let request = match prepare_request(&conn, &item).expect("prepare request") {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/customers/cust-1/addresses");
        assert_eq!(request.method, Method::POST);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("street_address").and_then(Value::as_str),
            Some("Main St 42")
        );
        assert_eq!(body.get("id"), None);
        assert_eq!(
            body.get("customer_id").and_then(Value::as_str),
            Some("cust-1")
        );
    }

    #[test]
    fn retry_failed_customer_address_not_found_items_requeues_placeholder_updates() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-1",
            json!({
                "id": "local-new",
                "street_address": "Main St 42",
                "city": "Athens",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        let queue_id = enqueue_test_item(
            &conn,
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-1",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = ?1
             WHERE id = ?2",
            params![
                "HTTP 404: {\"success\":false,\"error\":\"Address not found\"}",
                queue_id.as_str()
            ],
        )
        .expect("seed failed customer address parity row");

        let result = retry_failed_customer_address_not_found_items_limited(&conn, 1)
            .expect("retry failed customer address rows");

        assert_eq!(result.retried, 1);

        let (status, payload): (String, String) = conn
            .query_row(
                "SELECT status, data FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load updated queue row");
        assert_eq!(status, "pending");

        let payload = serde_json::from_str::<Value>(&payload).expect("parse updated payload");
        assert_eq!(
            payload.get("street_address").and_then(Value::as_str),
            Some("Main St 42")
        );
    }

    #[test]
    fn prepare_customer_address_request_recreates_placeholder_updates_from_recent_order_fallback() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-order-fallback",
            json!({
                "id": "local-new",
                "city": "Athens"
            }),
        );
        conn.execute(
            "INSERT INTO orders (
                id, customer_id, items, total_amount, status, sync_status,
                delivery_address, delivery_city, delivery_postal_code, delivery_floor,
                delivery_notes, name_on_ringer, created_at, updated_at
             ) VALUES (
                'ord-address-fallback', 'cust-order-fallback', '[]', 12.5, 'completed', 'synced',
                'Order Street 9', 'Athens', '11742', '2', 'Use side door', 'Papadopoulos',
                datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed recent order address fallback");

        let item = queue_item(
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-order-fallback",
                "city": "Athens"
            }),
        );

        let request = match prepare_request(&conn, &item).expect("prepare request") {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(
            request.endpoint,
            "/api/pos/customers/cust-order-fallback/addresses"
        );
        assert_eq!(request.method, Method::POST);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("street_address").and_then(Value::as_str),
            Some("Order Street 9")
        );
        assert_eq!(body.get("city").and_then(Value::as_str), Some("Athens"));
        assert_eq!(
            body.get("postal_code").and_then(Value::as_str),
            Some("11742")
        );
        assert_eq!(
            body.get("name_on_ringer").and_then(Value::as_str),
            Some("Papadopoulos")
        );
    }

    #[test]
    fn retry_failed_customer_address_missing_street_items_requeues_from_recent_order_fallback() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        seed_customer_cache(
            &conn,
            "cust-order-fallback",
            json!({
                "id": "local-new",
                "city": "Athens"
            }),
        );
        conn.execute(
            "INSERT INTO orders (
                id, customer_id, items, total_amount, status, sync_status,
                delivery_address, delivery_city, delivery_postal_code, created_at, updated_at
             ) VALUES (
                'ord-address-fallback-2', 'cust-order-fallback', '[]', 8.4, 'completed', 'synced',
                'Retry Street 5', 'Athens', '11743', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order fallback");

        let queue_id = enqueue_test_item(
            &conn,
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-order-fallback",
                "city": "Athens"
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = ?1
             WHERE id = ?2",
            params![
                "Customer address recreate is missing street_address details",
                queue_id.as_str()
            ],
        )
        .expect("seed failed customer address recreate row");

        let result = retry_failed_customer_address_not_found_items_limited(&conn, 1)
            .expect("retry failed customer address rows");

        assert_eq!(result.retried, 1);

        let (status, payload): (String, String) = conn
            .query_row(
                "SELECT status, data FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load updated queue row");
        assert_eq!(status, "pending");

        let payload = serde_json::from_str::<Value>(&payload).expect("parse updated payload");
        assert_eq!(
            payload.get("street_address").and_then(Value::as_str),
            Some("Retry Street 5")
        );
    }

    #[test]
    fn apply_success_updates_customer_address_cache_with_remote_id() {
        let conn = test_connection();
        seed_customer_cache(
            &conn,
            "cust-1",
            json!({
                "id": "local-new",
                "street_address": "Main St 42",
                "city": "Athens",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        let item = queue_item(
            "customer_addresses",
            "UPDATE",
            "local-new",
            json!({
                "customer_id": "cust-1",
                "coordinates": { "lat": 40.61, "lng": 22.95 }
            }),
        );

        apply_success(
            &conn,
            &item,
            Some(&json!({
                "address": {
                    "id": "addr-remote-1",
                    "customer_id": "cust-1",
                    "street_address": "Main St 42",
                    "city": "Athens",
                    "coordinates": { "lat": 40.61, "lng": 22.95 },
                    "version": 2
                }
            })),
        )
        .expect("apply customer address success");

        let cache = crate::db::get_setting(&conn, "local", "customer_cache_v1")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .expect("customer cache");
        let address_id = cache
            .get(0)
            .and_then(|customer| customer.get("addresses"))
            .and_then(Value::as_array)
            .and_then(|addresses| addresses.first())
            .and_then(|address| address.get("id"))
            .and_then(Value::as_str);

        assert_eq!(address_id, Some("addr-remote-1"));
    }

    #[test]
    fn resolve_financial_endpoints_use_live_pos_routes() {
        let mut payment_item = queue_item(
            "payments",
            "INSERT",
            "payment-1",
            serde_json::json!({ "paymentId": "payment-1" }),
        );
        payment_item.module_type = "financial".to_string();

        let mut adjustment_item = queue_item(
            "payment_adjustments",
            "INSERT",
            "adj-1",
            serde_json::json!({ "adjustmentId": "adj-1" }),
        );
        adjustment_item.module_type = "financial".to_string();

        let mut driver_item = queue_item(
            "driver_earnings",
            "INSERT",
            "earning-1",
            serde_json::json!({ "id": "earning-1" }),
        );
        driver_item.module_type = "financial".to_string();

        assert_eq!(resolve_endpoint(&payment_item), "/api/pos/payments");
        assert_eq!(
            resolve_endpoint(&adjustment_item),
            "/api/pos/payments/adjustments/sync"
        );
        assert_eq!(resolve_endpoint(&driver_item), "/api/pos/financial/sync");
    }

    #[test]
    fn resolve_special_entity_endpoints_use_live_routes() {
        let inventory_item = queue_item(
            "inventory_adjustments",
            "INSERT",
            "prod-1",
            serde_json::json!({ "product_id": "prod-1", "adjustment": 5 }),
        );
        let coupon_insert = queue_item(
            "coupons",
            "INSERT",
            "coupon-1",
            serde_json::json!({ "id": "coupon-1", "code": "SAVE10" }),
        );
        let coupon_update = queue_item(
            "coupons",
            "UPDATE",
            "coupon-1",
            serde_json::json!({ "id": "coupon-1", "is_active": false }),
        );
        let reservation_item = queue_item(
            "reservations",
            "UPDATE",
            "reservation-1",
            serde_json::json!({ "status": "confirmed" }),
        );
        let appointment_item = queue_item(
            "appointments",
            "UPDATE",
            "appointment-1",
            serde_json::json!({ "status": "completed" }),
        );
        let staff_shift_item = queue_item(
            "salon_staff_shifts",
            "INSERT",
            "shift-1",
            serde_json::json!({ "staff_id": "staff-1" }),
        );
        let drive_thru_item = queue_item(
            "drive_thru_orders",
            "UPDATE",
            "dto-1",
            serde_json::json!({ "status": "serving" }),
        );
        let room_item = queue_item(
            "rooms",
            "UPDATE",
            "room-101",
            serde_json::json!({ "status": "occupied" }),
        );
        let product_item = queue_item(
            "products",
            "UPDATE",
            "product-1",
            serde_json::json!({ "quantity": 9 }),
        );

        assert_eq!(resolve_endpoint(&inventory_item), "/api/pos/inventory");
        assert_eq!(resolve_endpoint(&coupon_insert), "/api/pos/coupons");
        assert_eq!(
            resolve_endpoint(&coupon_update),
            "/api/pos/coupons/coupon-1"
        );
        assert_eq!(
            resolve_endpoint(&reservation_item),
            "/api/pos/reservations/reservation-1"
        );
        assert_eq!(
            resolve_endpoint(&appointment_item),
            "/api/pos/appointments/appointment-1/status"
        );
        assert_eq!(
            resolve_endpoint(&staff_shift_item),
            "/api/pos/staff-schedule"
        );
        assert_eq!(resolve_endpoint(&drive_thru_item), "/api/pos/drive-through");
        assert_eq!(resolve_endpoint(&room_item), "/api/pos/rooms/room-101");
        assert_eq!(
            resolve_endpoint(&product_item),
            "/api/pos/products/product-1"
        );
    }

    #[test]
    fn prepare_order_request_normalizes_legacy_insert_payloads() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-1",
            json!({
                "clientOrderId": "client-order-1",
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentData": {
                    "method": "wallet"
                },
                "paymentStatus": "paid",
                "total": 15.75,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 2,
                    "price": 7.5,
                    "name": "Club Sandwich",
                    "notes": "No onions",
                    "customizations": [
                        {
                            "customizationId": "extra-cheese",
                            "name": "Extra Cheese"
                        }
                    ]
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        assert_eq!(request.endpoint, "/api/pos/orders");
        assert_eq!(request.method, Method::POST);
        assert_eq!(request.terminal_id, TEST_TERMINAL_ID);

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("client_order_id").and_then(Value::as_str),
            Some("client-order-1")
        );
        assert_eq!(
            body.get("branch_id").and_then(Value::as_str),
            Some(TEST_BRANCH_ID)
        );
        assert_eq!(
            body.get("order_type").and_then(Value::as_str),
            Some("pickup")
        );
        assert_eq!(
            body.get("payment_method").and_then(Value::as_str),
            Some("digital_wallet")
        );
        assert_eq!(
            body.get("payment_status").and_then(Value::as_str),
            Some("paid")
        );
        assert_eq!(
            body.get("total_amount").and_then(Value::as_f64),
            Some(15.75)
        );

        let items = body
            .get("items")
            .and_then(Value::as_array)
            .expect("items array");
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].get("menu_item_id").and_then(Value::as_str),
            Some(TEST_MENU_ITEM_ID)
        );
        assert_eq!(items[0].get("quantity").and_then(Value::as_i64), Some(2));
        assert_eq!(
            items[0].get("unit_price").and_then(Value::as_f64),
            Some(7.5)
        );
        assert_eq!(
            items[0].get("total_price").and_then(Value::as_f64),
            Some(15.0)
        );
        let customizations = items[0]
            .get("customizations")
            .and_then(Value::as_object)
            .expect("customizations object");
        assert_eq!(
            customizations.get("extra-cheese"),
            Some(&json!({
                "customizationId": "extra-cheese",
                "name": "Extra Cheese"
            }))
        );
    }

    #[test]
    fn prepare_order_request_defaults_payment_method_and_recomputes_total_amount() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-2",
            json!({
                "branchId": TEST_BRANCH_ID,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 2,
                    "price": 6.5,
                    "name": "Fries"
                }],
                "taxAmount": 1.2,
                "deliveryFee": 0.5,
                "discountAmount": 0.7
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(
            body.get("payment_method").and_then(Value::as_str),
            Some("cash")
        );
        assert_eq!(body.get("subtotal").and_then(Value::as_f64), Some(13.0));
        assert_eq!(body.get("tax_amount").and_then(Value::as_f64), Some(1.2));
        assert_eq!(body.get("delivery_fee").and_then(Value::as_f64), Some(0.5));
        assert_eq!(
            body.get("discount_amount").and_then(Value::as_f64),
            Some(0.7)
        );
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(14.0));
        assert_eq!(
            body.get("client_order_id").and_then(Value::as_str),
            Some("order-legacy-2")
        );

        let items = body
            .get("items")
            .and_then(Value::as_array)
            .expect("items array");
        assert_eq!(items[0].get("customizations"), Some(&Value::Null));
    }

    #[test]
    fn prepare_order_request_defaults_tip_amount_to_zero() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-tip-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "tipAmount": Value::Null,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 5.0,
                    "name": "Coffee"
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };

        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");
        assert_eq!(body.get("tip_amount").and_then(Value::as_f64), Some(0.0));
    }

    #[test]
    fn prepare_order_request_uses_record_id_when_client_order_id_missing() {
        let conn = test_connection();
        let item = queue_item(
            "orders",
            "INSERT",
            "order-legacy-3",
            json!({
                "branchId": TEST_BRANCH_ID,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 8.0,
                    "name": "Soup"
                }]
            }),
        );
        let payload = serde_json::from_str::<Value>(&item.data).expect("parse payload");

        let request = match prepare_order_request(&conn, &item, &payload, TEST_TERMINAL_ID)
            .expect("prepare request")
        {
            RequestPreparation::Ready(spec) => spec,
            other => panic!("expected ready request, got {other:?}"),
        };
        let body = serde_json::from_str::<Value>(request.body.as_deref().expect("request body"))
            .expect("parse request body");

        assert_eq!(
            body.get("client_order_id").and_then(Value::as_str),
            Some("order-legacy-3")
        );
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_known_validation_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-4",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentData": {
                    "method": "cash"
                },
                "total": 9.5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 9.5,
                    "name": "Burger",
                    "customizations": [{
                        "optionId": "well-done",
                        "name": "Well Done"
                    }]
                }]
            }),
        );
        let unrelated_queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-5",
            json!({
                "branchId": TEST_BRANCH_ID,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 4.0,
                    "name": "Tea"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 3,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                r#"HTTP 400: {"success":false,"error":"Validation failed","details":[{"field":"items.0.customizations","message":"Expected object, received array"},{"field":"order_type","message":"Required"},{"field":"payment_method","message":"Required"},{"field":"total_amount","message":"Required"}]}"#
            ],
        )
        .expect("seed failed legacy validation error");
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 2,
                 error_message = ?2
             WHERE id = ?1",
            params![
                unrelated_queue_id,
                "HTTP 400: some other validation failure"
            ],
        )
        .expect("seed unrelated failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed legacy order rows");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);

        let unrelated_status: String = conn
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                params![unrelated_queue_id],
                |row| row.get(0),
            )
            .expect("read unrelated queue row");
        assert_eq!(unrelated_status, "failed");
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_tip_amount_validation_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-tip-2",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "tipAmount": Value::Null,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 3.5,
                    "name": "Tea"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 2,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                r#"HTTP 400: {"success":false,"error":"Validation failed","details":[{"field":"tip_amount","message":"Expected number, received null"}]}"#
            ],
        )
        .expect("seed tip amount validation failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed legacy order rows");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);
    }

    #[test]
    fn retry_failed_legacy_order_insert_items_requeues_schema_cache_failures() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-schema-cache-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "delivery",
                "paymentMethod": "cash",
                "countryCode": "gr",
                "pricingMode": "gross",
                "totalAmount": 4.79,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 4.79,
                    "name": "Crepe"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 4,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                "HTTP 500: {\"success\":false,\"error\":\"Failed to create order\",\"details\":\"Failed to create order: Could not find the 'country_code' column of 'orders' in the schema cache\"}"
            ],
        )
        .expect("seed schema cache validation failure");

        let result = retry_failed_legacy_order_insert_items_limited(&conn, 1)
            .expect("retry failed legacy order rows");
        assert_eq!(result.retried, 1);

        let retried_row: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempts, error_message
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retried queue row");
        assert_eq!(retried_row.0, "pending");
        assert_eq!(retried_row.1, 0);
        assert_eq!(retried_row.2, None);
    }

    #[test]
    fn retry_failed_rate_limited_items_requeues_a_bounded_batch() {
        let conn = test_connection();
        seed_terminal_context(&conn);

        let queue_ids: Vec<String> = (0..4)
            .map(|index| {
                enqueue_test_item(
                    &conn,
                    "orders",
                    "INSERT",
                    &format!("order-rate-limit-{index}"),
                    json!({
                        "branchId": TEST_BRANCH_ID,
                        "orderType": "pickup",
                        "paymentMethod": "cash",
                        "totalAmount": 5.0 + index as f64,
                        "items": [{
                            "menuItemId": TEST_MENU_ITEM_ID,
                            "quantity": 1,
                            "price": 5.0 + index as f64,
                            "name": format!("Item {index}"),
                            "customizations": {}
                        }]
                    }),
                )
            })
            .collect();

        for queue_id in &queue_ids {
            conn.execute(
                "UPDATE parity_sync_queue
                 SET status = 'failed',
                     error_message = ?2
                 WHERE id = ?1",
                params![
                    queue_id,
                    r#"HTTP 429: {"success":false,"error":"Rate limit exceeded. Maximum 20 requests per 60 seconds."}"#
                ],
            )
            .expect("seed rate-limited failure");
        }

        let result =
            retry_failed_rate_limited_items_limited(&conn, 2).expect("requeue rate-limited rows");
        assert_eq!(result.retried, 2);

        let pending_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("count pending rows");
        let failed_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE status = 'failed'",
                [],
                |row| row.get(0),
            )
            .expect("count failed rows");

        assert_eq!(pending_count, 2);
        assert_eq!(failed_count, 2);
    }

    #[test]
    fn resolve_failed_payment_total_conflict_items_limited_voids_stale_overpay_rows_using_server_hint(
    ) {
        let conn = test_connection();
        seed_terminal_context(&conn);

        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, payment_status, payment_method,
                payment_transaction_id, sync_status, created_at, updated_at
             ) VALUES (
                'ord-payment-stale', '[]', 9.50, 'completed', 'paid', 'cash',
                'pay-valid', 'synced', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed order");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                remote_payment_id, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-valid', 'ord-payment-stale', 'cash', 4.79, 'EUR', 'completed',
                'remote-pay-valid', 'synced', 'applied', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed canonical payment");
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, currency, status,
                sync_status, sync_state, created_at, updated_at
             ) VALUES (
                'pay-stale', 'ord-payment-stale', 'cash', 0.55, 'EUR', 'completed',
                'failed', 'failed', datetime('now'), datetime('now')
             )",
            [],
        )
        .expect("seed stale overpay");

        let queue_id = enqueue_test_item(
            &conn,
            "payments",
            "INSERT",
            "pay-stale",
            json!({
                "paymentId": "pay-stale",
                "orderId": "ord-payment-stale",
                "amount": 0.55
            }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 error_message = ?1
             WHERE id = ?2",
            params![
                "HTTP 422: {\"success\":false,\"error\":\"Payment exceeds order total\",\"details\":\"Order total: 4.79, tip: 0, existing completed: 4.79, payment: 0.55\"}",
                queue_id.as_str()
            ],
        )
        .expect("seed failed payment total conflict");

        let result = resolve_failed_payment_total_conflict_items_limited(&conn, 1)
            .expect("resolve payment total conflicts");
        assert_eq!(result.retried, 1);

        let (status, sync_status, sync_state): (String, String, String) = conn
            .query_row(
                "SELECT status, sync_status, sync_state
                 FROM order_payments
                 WHERE id = 'pay-stale'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read stale payment row");
        assert_eq!(status, "voided");
        assert_eq!(sync_status, "synced");
        assert_eq!(sync_state, "applied");

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id.as_str()],
                |row| row.get(0),
            )
            .expect("count payment parity rows");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn dequeue_marks_item_processing_and_records_last_attempt() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-processing-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 5,
                    "name": "Espresso"
                }]
            }),
        );

        let dequeued = dequeue(&conn).expect("dequeue item");
        let item = dequeued.expect("expected queued item");
        assert_eq!(item.id, item_id);

        let (status, last_attempt): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_attempt
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query dequeued item");

        assert_eq!(status, "processing");
        assert!(last_attempt.is_some());
    }

    #[test]
    fn recover_stale_processing_items_requeues_abandoned_rows() {
        let conn = test_connection();
        seed_terminal_context(&conn);
        let item_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-stale-processing-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 5,
                    "name": "Espresso"
                }]
            }),
        );

        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'processing',
                 created_at = '2000-01-01T00:00:00Z',
                 last_attempt = NULL
             WHERE id = ?1",
            params![item_id],
        )
        .expect("mark stale processing row");

        let recovered =
            recover_stale_processing_items(&conn).expect("recover stale processing rows");
        assert_eq!(recovered, 1);

        let (status, last_attempt): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_attempt
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query recovered row");

        assert_eq!(status, "pending");
        assert!(last_attempt.is_none());
    }

    async fn spawn_strict_order_insert_server() -> (
        String,
        mpsc::UnboundedReceiver<CapturedRequest>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind strict mock server");
        let address = listener.local_addr().expect("strict mock server address");
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let captured = read_http_request(&mut stream).await;
            tx.send(CapturedRequest {
                request_line: captured.request_line.clone(),
                headers: captured.headers.clone(),
                body: captured.body.clone(),
            })
            .expect("send captured request");

            let response = match serde_json::from_str::<Value>(&captured.body) {
                Ok(body)
                    if captured.request_line == "POST /api/pos/orders HTTP/1.1"
                        && body.get("branch_id").and_then(Value::as_str)
                            == Some(TEST_BRANCH_ID)
                        && body.get("order_type").and_then(Value::as_str).is_some()
                        && body.get("payment_method").and_then(Value::as_str).is_some()
                        && body.get("total_amount").and_then(Value::as_f64).is_some()
                        && body
                            .get("items")
                            .and_then(Value::as_array)
                            .and_then(|items| items.first())
                            .and_then(|item| item.get("customizations"))
                            .and_then(Value::as_object)
                            .is_some() =>
                {
                    MockResponse::json(200, r#"{"success":true,"data":{"id":"remote-order-1"}}"#)
                }
                _ => MockResponse::json(
                    400,
                    r#"{"success":false,"error":"Validation failed","details":[{"field":"items.0.customizations","message":"Expected object, received array"},{"field":"order_type","message":"Required"},{"field":"payment_method","message":"Required"},{"field":"total_amount","message":"Required"}]}"#,
                ),
            };

            write_http_response(&mut stream, &response)
                .await
                .expect("write strict mock response");
        });

        (format!("http://{}", address), rx, handle)
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_sends_terminal_id_header_on_parity_requests() {
        clear_terminal_identity();
        let conn = test_connection();
        crate::db::set_setting(&conn, "terminal", "terminal_id", "terminal-test")
            .expect("store terminal id");
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) =
            spawn_mock_http_server(vec![MockResponse::json(200, r#"{"success":true}"#)]).await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests.recv().await.expect("captured parity request");
        assert_eq!(request.request_line, "POST /api/pos/customers HTTP/1.1");
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );
        assert_eq!(
            request.headers.get("x-pos-api-key").map(String::as_str),
            Some("api-key")
        );
        assert!(
            request.body.contains("\"name\":\"Ada Lovelace\""),
            "request body should preserve the queued payload"
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    async fn fetch_server_record_sends_terminal_id_header() {
        let item = queue_item(
            "customers",
            "UPDATE",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let client = reqwest::Client::new();
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            200,
            r#"{"data":{"id":"cust-remote-1"}}"#,
        )])
        .await;

        let server_record =
            fetch_server_record(&client, &base_url, "api-key", "terminal-test", &item).await;

        assert_eq!(
            server_record
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str),
            Some("cust-remote-1")
        );

        let request = requests.recv().await.expect("captured fetch request");
        assert_eq!(
            request.request_line,
            "GET /api/pos/sync/customers/cust-1 HTTP/1.1"
        );
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );
        assert_eq!(
            request.headers.get("x-pos-api-key").map(String::as_str),
            Some("api-key")
        );

        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_marks_items_failed_when_terminal_context_is_missing() {
        clear_terminal_identity();
        let conn = test_connection();
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        let conn = std::sync::Mutex::new(conn);

        let result = process_queue(&conn, "http://127.0.0.1:9", "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 1);
        assert!(result.errors.iter().any(|error| {
            error
                .error
                .contains("Parity sync request is missing terminal_id context")
        }));

        let (status, error_message): (String, Option<String>) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, error_message FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read failed queue item");
        assert_eq!(status, "failed");
        assert_eq!(
            error_message.as_deref(),
            Some("Parity sync request is missing terminal_id context")
        );

        clear_terminal_identity();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_retries_failed_missing_terminal_context_items_after_fix() {
        clear_terminal_identity();
        let conn = test_connection();
        crate::db::set_setting(&conn, "terminal", "terminal_id", "terminal-test")
            .expect("store terminal id");
        let queue_id = enqueue_test_item(
            &conn,
            "customers",
            "INSERT",
            "cust-1",
            json!({ "name": "Ada Lovelace" }),
        );
        conn.execute(
            "UPDATE parity_sync_queue
             SET status = 'failed',
                 attempts = 3,
                 error_message = ?2
             WHERE id = ?1",
            params![
                queue_id,
                r#"HTTP 401: {"success":false,"error":"Missing terminal_id","code":"missing_terminal_id"}"#
            ],
        )
        .expect("seed failed terminal context error");

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) =
            spawn_mock_http_server(vec![MockResponse::json(200, r#"{"success":true}"#)]).await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests.recv().await.expect("captured parity request");
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some("terminal-test")
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_normalizes_legacy_order_insert_payloads_for_pos_orders() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);
        let queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-legacy-6",
            json!({
                "orderType": "pickup",
                "paymentData": {
                    "method": "wallet"
                },
                "total": 18.0,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 2,
                    "price": 9.0,
                    "name": "Pasta",
                    "customizations": [{
                        "ingredient": {
                            "name": "Parmesan"
                        },
                        "amount": "extra"
                    }]
                }]
            }),
        );
        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_strict_order_insert_server().await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 1);
        assert_eq!(result.failed, 0);

        let request = requests
            .recv()
            .await
            .expect("captured order insert request");
        assert_eq!(request.request_line, "POST /api/pos/orders HTTP/1.1");
        assert_eq!(
            request.headers.get("x-terminal-id").map(String::as_str),
            Some(TEST_TERMINAL_ID)
        );
        let body = serde_json::from_str::<Value>(&request.body).expect("parse request body");
        assert_eq!(
            body.get("branch_id").and_then(Value::as_str),
            Some(TEST_BRANCH_ID)
        );
        assert_eq!(
            body.get("order_type").and_then(Value::as_str),
            Some("pickup")
        );
        assert_eq!(
            body.get("payment_method").and_then(Value::as_str),
            Some("digital_wallet")
        );
        assert_eq!(body.get("total_amount").and_then(Value::as_f64), Some(18.0));
        assert_eq!(body.get("tip_amount").and_then(Value::as_f64), Some(0.0));
        assert!(
            body.get("items")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("customizations"))
                .and_then(Value::as_object)
                .is_some(),
            "strict server should receive object customizations"
        );

        let remaining: i64 = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT COUNT(*) FROM parity_sync_queue WHERE id = ?1",
                params![queue_id],
                |row| row.get(0),
            )
            .expect("read queue state");
        assert_eq!(remaining, 0);

        clear_terminal_identity();
        server.await.expect("strict mock server task");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn process_queue_keeps_429_rows_pending_and_stops_the_batch() {
        clear_terminal_identity();
        let conn = test_connection();
        seed_terminal_context(&conn);

        let first_queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-rate-limited-1",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 7.5,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 7.5,
                    "name": "Americano",
                    "customizations": {}
                }]
            }),
        );
        let second_queue_id = enqueue_test_item(
            &conn,
            "orders",
            "INSERT",
            "order-rate-limited-2",
            json!({
                "branchId": TEST_BRANCH_ID,
                "orderType": "pickup",
                "paymentMethod": "cash",
                "totalAmount": 8.0,
                "items": [{
                    "menuItemId": TEST_MENU_ITEM_ID,
                    "quantity": 1,
                    "price": 8.0,
                    "name": "Latte",
                    "customizations": {}
                }]
            }),
        );

        let conn = std::sync::Mutex::new(conn);
        let (base_url, mut requests, server) = spawn_mock_http_server(vec![MockResponse::json(
            429,
            r#"{"success":false,"error":"Rate limit exceeded. Maximum 20 requests per 60 seconds."}"#,
        )])
        .await;

        let result = process_queue(&conn, &base_url, "api-key")
            .await
            .expect("process queue");

        assert_eq!(result.processed, 0);
        assert_eq!(result.failed, 1);

        let request = requests
            .recv()
            .await
            .expect("captured rate-limited request");
        assert_eq!(request.request_line, "POST /api/pos/orders HTTP/1.1");

        let first_row: (String, i64, Option<String>, Option<String>) = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status, attempts, error_message, next_retry_at
                 FROM parity_sync_queue
                 WHERE id = ?1",
                params![first_queue_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read first row");
        assert_eq!(first_row.0, "pending");
        assert_eq!(first_row.1, 0);
        assert!(
            first_row
                .2
                .as_deref()
                .unwrap_or_default()
                .contains("Rate limit exceeded"),
            "first row should preserve the rate-limit error"
        );
        assert!(
            first_row.3.is_some(),
            "first row should have a retry schedule"
        );

        let second_status: String = conn
            .lock()
            .expect("lock db")
            .query_row(
                "SELECT status FROM parity_sync_queue WHERE id = ?1",
                params![second_queue_id],
                |row| row.get(0),
            )
            .expect("read second row");
        assert_eq!(second_status, "pending");

        clear_terminal_identity();
        server.await.expect("mock server task");
    }
}
