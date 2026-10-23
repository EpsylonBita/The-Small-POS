//! Menu cache layer for The Small POS.
//!
//! Reads cached menu data (categories, subcategories, ingredients, combos)
//! from the local SQLite `menu_cache` table, and provides a sync function
//! that fetches fresh data from the admin dashboard API.

use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use tracing::{debug, error, trace, warn};
use zeroize::Zeroizing;

use crate::api;
use crate::db::DbState;
use crate::storage;

/// The menu sections the till caches, one `menu_cache` row each.
const MENU_SECTIONS: [&str; 4] = ["categories", "subcategories", "ingredients", "combos"];

/// Error prefix of a payload that lacks a section (see `validate_menu_sections`).
pub(crate) const MENU_PAYLOAD_INCOMPLETE: &str = "Menu sync payload is missing menu sections";

/// Code of the admin's 503 for a menu it could not read whole (POS audit
/// S-D-05). The till keeps its cached menu and retries on the next tick.
pub(crate) const POS_MENU_SYNC_UNAVAILABLE: &str = "POS_MENU_SYNC_UNAVAILABLE";

/// A failed menu sync. `code` and `retry_after_secs` come from the admin's
/// typed reply fields, never its display text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MenuSyncFailure {
    pub message: String,
    pub code: Option<String>,
    pub retry_after_secs: Option<i64>,
}

impl MenuSyncFailure {
    /// The admin could not read the whole menu; nothing was written here.
    pub(crate) fn is_menu_unavailable(&self) -> bool {
        self.code.as_deref() == Some(POS_MENU_SYNC_UNAVAILABLE)
    }
}

impl From<String> for MenuSyncFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            code: None,
            retry_after_secs: None,
        }
    }
}

impl From<&str> for MenuSyncFailure {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

impl From<api::AdminFetchError> for MenuSyncFailure {
    fn from(error: api::AdminFetchError) -> Self {
        Self {
            message: error.to_string(),
            code: error.code().map(ToOwned::to_owned),
            retry_after_secs: error.retry_after_seconds(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MenuVersionDigest {
    pub token: String,
    pub latest_updated_at: Option<String>,
    pub counts: Value,
    #[allow(dead_code)]
    pub timestamp: String,
}

#[derive(Debug, Clone)]
struct MenuSyncCredentials {
    api_key: Zeroizing<String>,
    terminal_id: String,
    admin_url: String,
}

// ---------------------------------------------------------------------------
// Cache readers
// ---------------------------------------------------------------------------

/// Read a cached menu array by key. Returns an empty array on miss or error.
fn read_cache(db: &DbState, cache_key: &str) -> Vec<Value> {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(e) => {
            error!("menu cache lock failed: {e}");
            return vec![];
        }
    };
    read_cache_rows(&conn, cache_key)
}

fn read_cache_rows(conn: &Connection, cache_key: &str) -> Vec<Value> {
    let json_str: Option<String> = conn
        .query_row(
            "SELECT data FROM menu_cache WHERE cache_key = ?1",
            params![cache_key],
            |row| row.get(0),
        )
        .ok();

    match json_str {
        Some(s) => match serde_json::from_str::<Value>(&s) {
            Ok(Value::Array(arr)) => arr,
            Ok(other) => {
                warn!("menu_cache[{cache_key}] is not an array, wrapping");
                vec![other]
            }
            Err(e) => {
                error!("menu_cache[{cache_key}] JSON parse error: {e}");
                vec![]
            }
        },
        None => vec![],
    }
}

/// Get cached categories.
pub fn get_categories(db: &DbState) -> Vec<Value> {
    read_cache(db, "categories")
}

/// Get cached subcategories.
pub fn get_subcategories(db: &DbState) -> Vec<Value> {
    read_cache(db, "subcategories")
        .into_iter()
        .map(|mut item| {
            let class = item
                .get("vat_class")
                .or_else(|| item.get("vatClass"))
                .and_then(Value::as_str)
                .unwrap_or("standard")
                .to_string();
            if let Some(object) = item.as_object_mut() {
                object.insert("vat_class".into(), Value::String(class));
            }
            item
        })
        .collect()
}

/// Get cached ingredients (menu items).
pub fn get_ingredients(db: &DbState) -> Vec<Value> {
    read_cache(db, "ingredients")
}

/// Get cached combos.
pub fn get_combos(db: &DbState) -> Vec<Value> {
    read_cache(db, "combos")
}

// ---------------------------------------------------------------------------
// Branch overrides (POS audit K4)
// ---------------------------------------------------------------------------
//
// An admin can set, per branch, a price and an availability for a menu item
// (subcategory), an ingredient or a retail product (`menu_synchronization`).
// The server order editor already prices and refuses lines by them; the till
// showed and sold the catalog row. menu-sync now sends the branch's whole set
// (`branch_overrides` + `branch_overrides_complete: true`), which is cached
// next to the menu and applied when the renderer reads menu rows, so the menu,
// the cart and the receipts all carry the effective price and availability.
// The cached catalog rows stay as they are: removing an override restores the
// catalog price. Retail products come from `/api/pos/products`, which the
// server already prices per branch, so only menu items and ingredients merge
// here.
//
// Rules (shared/pos/menu/effectiveMenuPrice.ts, mirrored below and pinned by
// its fixture): (b) unavailable wins (`is_active` false, `is_available` false
// or `availability_override` false); (c) one override price for every
// channel; (d) one override per resource, the one updated last (ties: the
// greater id).

/// `menu_cache` key of the branch override set.
const BRANCH_OVERRIDES_CACHE_KEY: &str = "branch_overrides";

/// The catalog price fields an override price replaces, in the shared order.
const MENU_PRICE_FIELDS: [&str; 6] = [
    "price",
    "base_price",
    "pickup_price",
    "delivery_price",
    "dine_in_price",
    "instore_price",
];

/// A price as the server reads it (JavaScript `Number`): a finite number, or
/// none for null, an empty string or garbage. Whitespace-only text reads 0.
fn price_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64().filter(|price| price.is_finite()),
        Value::String(text) if text.is_empty() => None,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            trimmed
                .parse::<f64>()
                .ok()
                .filter(|price| price.is_finite())
        }
        _ => None,
    }
}

/// Only an explicit `false` counts, as `!== false` in the shared rule: an
/// absent flag (an older server without `is_active`) is no information.
fn not_false(value: Option<&Value>) -> bool {
    value != Some(&Value::Bool(false))
}

/// A catalog row's prices and availability under its branch override.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EffectiveMenuPrice {
    /// One per `MENU_PRICE_FIELDS` entry.
    pub prices: [Option<f64>; 6],
    pub is_available: bool,
    /// Whether a branch price replaced the row's own prices.
    pub price_overridden: bool,
}

/// Mirror of `effectiveMenuPrice`.
pub(crate) fn effective_menu_price(
    row: &Value,
    override_row: Option<&Value>,
) -> EffectiveMenuPrice {
    let override_price = override_row.and_then(|row| price_of(row.get("price_override")));
    EffectiveMenuPrice {
        prices: MENU_PRICE_FIELDS.map(|field| override_price.or_else(|| price_of(row.get(field)))),
        is_available: not_false(row.get("is_active"))
            && not_false(row.get("is_available"))
            && not_false(override_row.and_then(|row| row.get("availability_override"))),
        price_overridden: override_price.is_some(),
    }
}

/// Mirror of `effectiveChannelPrice`: what one order type sells for, as the
/// server order editor resolves it. The renderer's pricing resolves merged
/// rows the same way; this copy pins that parity against the fixture.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn effective_channel_price(
    row: &Value,
    override_row: Option<&Value>,
    order_type: &str,
) -> f64 {
    if let Some(price) = override_row.and_then(|row| price_of(row.get("price_override"))) {
        return price;
    }
    // Nullish mapping happens before parsing: 0 or invalid text masks the fallback field.
    let nullish = |primary: &str, fallback: &str| match row.get(primary) {
        Some(value) if !value.is_null() => Some(value),
        _ => row.get(fallback),
    };
    let base = price_of(nullish("price", "base_price"));
    let pickup = price_of(row.get("pickup_price"));
    let candidates = match order_type {
        "delivery" => [price_of(row.get("delivery_price")), pickup, base],
        "dine-in" => [
            price_of(nullish("instore_price", "dine_in_price")),
            pickup,
            base,
        ],
        _ => [pickup, base, None],
    };
    let numeric: Vec<f64> = candidates.into_iter().flatten().collect();
    numeric
        .iter()
        .copied()
        .find(|price| *price > 0.0)
        .or_else(|| numeric.first().copied())
        .unwrap_or(0.0)
}

/// The catalog row an override names.
fn branch_override_resource_id(override_row: &Value) -> Option<String> {
    ["subcategory_id", "ingredient_id", "product_id"]
        .into_iter()
        .find_map(|key| {
            override_row
                .get(key)
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        })
        .map(ToString::to_string)
}

/// `updated_at` as UTC text with six fractional digits, comparable as text
/// at full microsecond precision; `None` when absent or not a timestamp.
fn branch_override_updated_at(override_row: &Value) -> Option<String> {
    let text = override_row.get("updated_at")?.as_str()?;
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    if bytes.len() < 20
        || !digits(0..4)
        || bytes[4] != b'-'
        || !digits(5..7)
        || bytes[7] != b'-'
        || !digits(8..10)
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || !digits(11..13)
        || bytes[13] != b':'
        || !digits(14..16)
        || bytes[16] != b':'
        || !digits(17..19)
    {
        return None;
    }
    let mut rest = &text[19..];
    let mut fraction = "";
    if let Some(after_dot) = rest.strip_prefix('.') {
        let length = after_dot.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=6).contains(&length) {
            return None;
        }
        fraction = &after_dot[..length];
        rest = &after_dot[length..];
    }
    let zone = match rest {
        "Z" | "z" => "Z".to_string(),
        offset => {
            let sign = offset
                .chars()
                .next()
                .filter(|sign| matches!(sign, '+' | '-'))?;
            let body = &offset[1..];
            let (hours, minutes) = match body.len() {
                2 => (body, "00"),
                4 => (&body[..2], &body[2..]),
                5 if body.as_bytes()[2] == b':' => (&body[..2], &body[3..]),
                _ => return None,
            };
            if !hours
                .bytes()
                .chain(minutes.bytes())
                .all(|b| b.is_ascii_digit())
            {
                return None;
            }
            format!("{sign}{hours}:{minutes}")
        }
    };
    let seconds =
        chrono::DateTime::parse_from_rfc3339(&format!("{}T{}{zone}", &text[..10], &text[11..19]))
            .ok()?
            .with_timezone(&Utc);
    Some(format!(
        "{}.{fraction:0<6}Z",
        seconds.format("%Y-%m-%dT%H:%M:%S")
    ))
}

/// Mirror of `indexBranchOverrides`: one override per catalog row, the one
/// updated last; of rows updated at the same instant, the greater id. A NULL
/// timestamp sorts last, as in the editor's ascending query and Map fill.
pub(crate) fn index_branch_overrides(overrides: &[Value]) -> HashMap<String, Value> {
    let id_of = |row: &Value| match row.get("id") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(id)) => id.clone(),
        Some(other) => other.to_string(),
    };
    let mut index: HashMap<String, Value> = HashMap::new();
    for override_row in overrides {
        let Some(resource_id) = branch_override_resource_id(override_row) else {
            continue;
        };
        let replaces = match index.get(&resource_id) {
            None => true,
            Some(current) => {
                let updated_at = branch_override_updated_at(override_row);
                let current_updated_at = branch_override_updated_at(current);
                let newer = updated_at != current_updated_at
                    && (updated_at.is_none()
                        || (current_updated_at.is_some() && updated_at > current_updated_at));
                newer || (updated_at == current_updated_at && id_of(override_row) > id_of(current))
            }
        };
        if replaces {
            index.insert(resource_id, override_row.clone());
        }
    }
    index
}

/// The override set of a payload, when the server marked it complete. An
/// older server sends no flag (and at most a partial list): `None`, and the
/// till keeps the set it has.
fn complete_branch_overrides(data: &Value) -> Result<Option<&Vec<Value>>, String> {
    if data
        .get("branch_overrides_complete")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(None);
    }
    data.get("branch_overrides")
        .and_then(Value::as_array)
        .map(Some)
        .ok_or_else(|| format!("{MENU_PAYLOAD_INCOMPLETE}: branch_overrides"))
}

/// The terminal's branch: the managed credential, else its local mirror.
fn current_branch_id(db: &DbState) -> Option<String> {
    let clean = |value: String| Some(value.trim().to_string()).filter(|value| !value.is_empty());
    storage::get_credential("branch_id")
        .and_then(clean)
        .or_else(|| {
            let conn = db.conn.lock().ok()?;
            crate::db::get_setting(&conn, "terminal", "branch_id").and_then(clean)
        })
}

/// The cached override set, indexed, when it was stored for `branch_id`. A
/// set of another branch (the till moved) or of no branch is ignored.
fn load_branch_override_index(
    conn: &Connection,
    branch_id: Option<&str>,
) -> HashMap<String, Value> {
    let Some(branch_id) = branch_id.filter(|branch| !branch.is_empty()) else {
        return HashMap::new();
    };
    let stored: Option<Value> = conn
        .query_row(
            "SELECT data FROM menu_cache WHERE cache_key = ?1",
            params![BRANCH_OVERRIDES_CACHE_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let Some(stored) = stored else {
        return HashMap::new();
    };
    if stored.get("branch_id").and_then(Value::as_str) != Some(branch_id) {
        return HashMap::new();
    }
    let rows: Vec<Value> = stored
        .get("overrides")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|row| {
                    row.get("branch_id")
                        .and_then(Value::as_str)
                        .is_none_or(|row_branch| row_branch == branch_id)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    index_branch_overrides(&rows)
}

/// A catalog row under its override: the effective availability, and every
/// price field set to the override price when there is one. The catalog
/// prices ride along in `catalog_prices`; the cache keeps the row unchanged.
fn apply_branch_override(row: &Value, override_row: &Value) -> Value {
    let Some(fields) = row.as_object() else {
        return row.clone();
    };
    let effective = effective_menu_price(row, Some(override_row));
    let mut merged = fields.clone();
    if effective.price_overridden {
        let mut catalog_prices = serde_json::Map::new();
        for (field, price) in MENU_PRICE_FIELDS.iter().zip(effective.prices) {
            catalog_prices.insert(
                field.to_string(),
                fields.get(*field).cloned().unwrap_or(Value::Null),
            );
            merged.insert(
                field.to_string(),
                price
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            );
        }
        merged.insert("catalog_prices".to_string(), Value::Object(catalog_prices));
    }
    merged.insert(
        "is_available".to_string(),
        Value::Bool(effective.is_available),
    );
    merged.insert(
        "price_overridden".to_string(),
        Value::Bool(effective.price_overridden),
    );
    Value::Object(merged)
}

/// A catalog row with no override: unavailable wins all the same, so an
/// inactive row (`is_active: false`) is never served as available. An absent
/// flag is no information; an available row is returned unchanged.
fn apply_base_availability(row: Value) -> Value {
    let unavailable = !effective_menu_price(&row, None).is_available;
    match row {
        Value::Object(mut fields)
            if unavailable && fields.get("is_available") != Some(&Value::Bool(false)) =>
        {
            fields.insert("is_available".to_string(), Value::Bool(false));
            Value::Object(fields)
        }
        row => row,
    }
}

/// Apply the override naming each row through `resource_column`, and the
/// unavailable-wins rule to every row.
fn merge_branch_overrides(
    rows: Vec<Value>,
    index: &HashMap<String, Value>,
    resource_column: &str,
) -> Vec<Value> {
    rows.into_iter()
        .map(|row| {
            let id = row.get("id").and_then(Value::as_str);
            match id.and_then(|id| index.get(id)).filter(|override_row| {
                override_row.get(resource_column).and_then(Value::as_str) == id
            }) {
                Some(override_row) => apply_branch_override(&row, override_row),
                None => apply_base_availability(row),
            }
        })
        .collect()
}

fn read_effective_rows(db: &DbState, section: &str, resource_column: &str) -> Vec<Value> {
    let branch_id = current_branch_id(db);
    let conn = match db.conn.lock() {
        Ok(conn) => conn,
        Err(e) => {
            error!("menu cache lock failed: {e}");
            return vec![];
        }
    };
    let rows = read_cache_rows(&conn, section);
    let index = load_branch_override_index(&conn, branch_id.as_deref());
    merge_branch_overrides(rows, &index, resource_column)
}

/// Menu items (subcategories) as this branch sells them (K4).
pub fn get_effective_subcategories(db: &DbState) -> Vec<Value> {
    read_effective_rows(db, "subcategories", "subcategory_id")
}

/// Ingredients as this branch sells them (K4).
pub fn get_effective_ingredients(db: &DbState) -> Vec<Value> {
    read_effective_rows(db, "ingredients", "ingredient_id")
}

/// Ingredient rows from elsewhere (a menu item's nested list) under this
/// branch's ingredient overrides.
pub(crate) fn apply_ingredient_overrides(db: &DbState, rows: Vec<Value>) -> Vec<Value> {
    let branch_id = current_branch_id(db);
    let index = match db.conn.lock() {
        Ok(conn) => load_branch_override_index(&conn, branch_id.as_deref()),
        Err(_) => return rows,
    };
    merge_branch_overrides(rows, &index, "ingredient_id")
}

fn section_count(data: &Value, key: &str) -> usize {
    data.get(key)
        .and_then(Value::as_array)
        .map(|arr| arr.len())
        .unwrap_or(0)
}

fn section_or_empty(data: &Value, key: &str) -> Value {
    data.get(key)
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

/// POS audit S-D-05: a section the admin did not send (or sent as something
/// other than an array) is never cached as an empty menu section. The whole
/// payload is refused and the cached menu stays as it is.
fn validate_menu_sections(data: &Value) -> Result<(), String> {
    let missing: Vec<&str> = MENU_SECTIONS
        .into_iter()
        .filter(|section| !data.get(*section).is_some_and(Value::is_array))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("{MENU_PAYLOAD_INCOMPLETE}: {}", missing.join(", ")))
    }
}

/// Write a fetched menu into `menu_cache` (POS audit S-D-04).
///
/// The version check and all four section upserts run in ONE transaction on
/// the caller's locked connection, so a failed write leaves the previous menu
/// whole. The cache counts as current only when all four rows carry
/// `version`: a mixed cache from an older interrupted save, or a section an
/// offline toggle restamped `offline:<uuid>`, is rewritten.
///
/// A complete branch override set (K4) is stored in the same transaction as
/// `branch_overrides`, with `overrides_branch`, the branch the terminal synced
/// for, and counts toward "current". Without one the stored set stays.
///
/// Returns `Ok(true)` when the cache was rewritten, `Ok(false)` when it was
/// already current.
pub(crate) fn apply_menu_payload(
    conn: &Connection,
    data: &Value,
    version: &str,
    overrides_branch: Option<&str>,
) -> Result<bool, String> {
    validate_menu_sections(data)?;
    let overrides = complete_branch_overrides(data)?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin menu_cache write: {e}"))?;
    let current_rows: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM menu_cache
             WHERE (cache_key IN ('categories', 'subcategories', 'ingredients', 'combos')
                    OR (?2 AND cache_key = ?3))
               AND version = ?1",
            params![version, overrides.is_some(), BRANCH_OVERRIDES_CACHE_KEY],
            |row| row.get(0),
        )
        .map_err(|e| format!("read menu_cache version: {e}"))?;
    let expected_rows = MENU_SECTIONS.len() + usize::from(overrides.is_some());
    if current_rows == expected_rows as i64 {
        return Ok(false);
    }

    for section in MENU_SECTIONS {
        let section_data = data
            .get(section)
            .ok_or_else(|| format!("{MENU_PAYLOAD_INCOMPLETE}: {section}"))?;
        let json_str =
            serde_json::to_string(section_data).map_err(|e| format!("serialize {section}: {e}"))?;
        tx.execute(
            "INSERT INTO menu_cache (id, cache_key, data, version, updated_at)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, datetime('now'))
             ON CONFLICT(cache_key) DO UPDATE SET
                data = excluded.data,
                version = excluded.version,
                updated_at = excluded.updated_at",
            params![section, json_str, version],
        )
        .map_err(|e| format!("upsert menu_cache[{section}]: {e}"))?;
    }
    if let Some(overrides) = overrides {
        let stored = serde_json::json!({
            "branch_id": overrides_branch,
            "overrides": overrides,
        });
        tx.execute(
            "INSERT INTO menu_cache (id, cache_key, data, version, updated_at)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, datetime('now'))
             ON CONFLICT(cache_key) DO UPDATE SET
                data = excluded.data,
                version = excluded.version,
                updated_at = excluded.updated_at",
            params![BRANCH_OVERRIDES_CACHE_KEY, stored.to_string(), version],
        )
        .map_err(|e| format!("upsert menu_cache[{BRANCH_OVERRIDES_CACHE_KEY}]: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("commit menu_cache write: {e}"))?;
    Ok(true)
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            let mut normalized = serde_json::Map::new();
            for key in keys {
                if let Some(entry) = map.get(key) {
                    normalized.insert(key.clone(), canonicalize_json(entry));
                }
            }
            Value::Object(normalized)
        }
        Value::Array(arr) => {
            let mut normalized_items: Vec<(String, Value)> = arr
                .iter()
                .map(|item| {
                    let normalized = canonicalize_json(item);
                    let as_string =
                        serde_json::to_string(&normalized).unwrap_or_else(|_| "null".to_string());
                    (as_string, normalized)
                })
                .collect();
            normalized_items.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Array(
                normalized_items
                    .into_iter()
                    .map(|(_, normalized)| normalized)
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn hash_canonical_json(value: &Value) -> String {
    let normalized = canonicalize_json(value);
    let serialized = serde_json::to_string(&normalized).unwrap_or_else(|_| "{}".to_string());
    let mut hasher = DefaultHasher::new();
    serialized.hash(&mut hasher);
    format!("digest:{:016x}", hasher.finish())
}

/// Compute a stable local version from the actual menu sections we cache.
/// This avoids treating response timestamps as menu-version changes. A
/// complete branch override set is part of it, so an override-only change
/// rewrites the cache.
fn compute_menu_payload_version(data: &Value) -> String {
    let mut snapshot = serde_json::json!({
        "categories": section_or_empty(data, "categories"),
        "subcategories": section_or_empty(data, "subcategories"),
        "ingredients": section_or_empty(data, "ingredients"),
        "combos": section_or_empty(data, "combos"),
    });
    if let Ok(Some(overrides)) = complete_branch_overrides(data) {
        snapshot["branch_overrides"] = Value::Array(overrides.clone());
    }

    hash_canonical_json(&snapshot)
}

fn normalize_non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn parse_count(value: Option<&Value>) -> u64 {
    let Some(raw) = value else {
        return 0;
    };

    if let Some(parsed) = raw.as_u64() {
        return parsed;
    }
    if let Some(parsed) = raw.as_i64().filter(|n| *n >= 0) {
        return parsed as u64;
    }
    if let Some(parsed) = raw.as_f64().filter(|n| *n >= 0.0) {
        return parsed as u64;
    }
    if let Some(parsed) = raw
        .as_str()
        .and_then(|text| text.trim().parse::<u64>().ok())
    {
        return parsed;
    }
    0
}

fn normalize_digest_counts(payload: &Value) -> Value {
    let counts = payload.get("counts");
    let categories = parse_count(
        counts
            .and_then(|c| c.get("categories"))
            .or_else(|| counts.and_then(|c| c.get("menu_categories"))),
    );
    let subcategories = parse_count(
        counts
            .and_then(|c| c.get("subcategories"))
            .or_else(|| counts.and_then(|c| c.get("menu_subcategories"))),
    );
    let ingredients = parse_count(
        counts
            .and_then(|c| c.get("ingredients"))
            .or_else(|| counts.and_then(|c| c.get("menu_ingredients"))),
    );
    let combos = parse_count(
        counts
            .and_then(|c| c.get("combos"))
            .or_else(|| counts.and_then(|c| c.get("menu_combos"))),
    );

    serde_json::json!({
        "categories": categories,
        "subcategories": subcategories,
        "ingredients": ingredients,
        "combos": combos
    })
}

fn build_menu_version_token(
    payload: &Value,
    latest_updated_at: Option<&str>,
    counts: &Value,
) -> String {
    let snapshot = serde_json::json!({
        "latest_updated_at": latest_updated_at,
        "last_updated": payload.get("last_updated").cloned().unwrap_or(Value::Null),
        "counts": counts
    });
    hash_canonical_json(&snapshot)
}

fn resolve_menu_sync_credentials() -> Result<MenuSyncCredentials, String> {
    let raw_api_key = Zeroizing::new(
        storage::get_credential_strict("pos_api_key")
            .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
            .map(|value| value.to_string())
            .ok_or("Terminal not configured: missing API key")?,
    );
    let api_key = Zeroizing::new(
        api::extract_api_key_from_connection_string(&raw_api_key)
            .unwrap_or_else(|| (*raw_api_key).clone()),
    );
    let terminal_id = storage::get_credential_strict("terminal_id")
        .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
        .map(|value| value.to_string())
        .ok_or("Terminal not configured: missing terminal ID")?;
    let admin_url = storage::get_credential_strict("admin_dashboard_url")
        .map_err(|_| "TERMINAL_CREDENTIAL_READ_FAILED".to_string())?
        .map(|value| value.to_string())
        .ok_or("Terminal not configured: missing admin URL")?;

    if let Some(decoded_terminal) = api::extract_terminal_id_from_connection_string(&raw_api_key) {
        if decoded_terminal.trim() != terminal_id.trim() {
            return Err("TERMINAL_CONNECTION_TUPLE_CONFLICT".to_string());
        }
    }
    if let Some(decoded_url) = api::extract_admin_url_from_connection_string(&raw_api_key) {
        if api::normalize_admin_url(&decoded_url) != api::normalize_admin_url(&admin_url) {
            return Err("TERMINAL_CONNECTION_TUPLE_CONFLICT".to_string());
        }
    }

    Ok(MenuSyncCredentials {
        api_key,
        terminal_id,
        admin_url,
    })
}

pub async fn fetch_menu_version_digest(_db: &DbState) -> Result<MenuVersionDigest, String> {
    let credentials = resolve_menu_sync_credentials()?;
    let terminal_id_for_query = validate_terminal_id_for_query(&credentials.terminal_id)?;
    let path = format!("/api/pos/menu-version?terminal_id={terminal_id_for_query}");
    let masked_terminal_id = mask_terminal_id(&credentials.terminal_id);
    trace!(
        terminal_id = %masked_terminal_id,
        path = %path,
        "menu_version_digest: requesting digest from admin"
    );

    let payload = match api::fetch_from_admin(
        &credentials.admin_url,
        &credentials.api_key,
        &path,
        "GET",
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            if !is_menu_connectivity_error(&error) {
                warn!(
                    terminal_id = %masked_terminal_id,
                    path = %path,
                    error = %error,
                    "menu_version_digest: admin request failed"
                );
            }
            return Err(error);
        }
    };

    if payload
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|success| !success)
    {
        let message = normalize_non_empty_string(payload.get("error"))
            .unwrap_or_else(|| "Menu version digest request failed".to_string());
        return Err(message);
    }

    let counts = normalize_digest_counts(&payload);
    let latest_updated_at = normalize_non_empty_string(payload.get("latest_updated_at"));
    let timestamp = normalize_non_empty_string(payload.get("timestamp"))
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let token = build_menu_version_token(&payload, latest_updated_at.as_deref(), &counts);

    Ok(MenuVersionDigest {
        token,
        latest_updated_at,
        counts,
        timestamp,
    })
}

fn mask_terminal_id(terminal_id: &str) -> String {
    let trimmed = terminal_id.trim();
    if trimmed.is_empty() {
        return "unknown".to_string();
    }
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    format!("***{suffix}")
}

fn validate_terminal_id_for_query(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Terminal not configured: missing terminal ID".to_string());
    }
    if trimmed.len() > 128 {
        return Err("Terminal ID is too long".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Terminal ID contains unsupported characters".to_string());
    }
    Ok(trimmed)
}

fn is_menu_connectivity_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("cannot reach admin dashboard")
        || lower.contains("network error")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("failed to lookup address")
        || lower.contains("dns")
}

// ---------------------------------------------------------------------------
// Sync from admin dashboard
// ---------------------------------------------------------------------------

/// Fetch menu data from the admin dashboard and update the local cache.
///
/// Calls `GET /api/pos/menu-sync` with the terminal's API key, then
/// writes the four menu sections into the `menu_cache` table at once.
pub async fn sync_menu(db: &DbState) -> Result<Value, String> {
    sync_menu_detailed(db)
        .await
        .map_err(|failure| failure.message)
}

/// [`sync_menu`] with the admin's typed failure fields, for the version
/// monitor's retry timing.
pub(crate) async fn sync_menu_detailed(db: &DbState) -> Result<Value, MenuSyncFailure> {
    let credentials = resolve_menu_sync_credentials()?;

    let terminal_id_for_query = validate_terminal_id_for_query(&credentials.terminal_id)?;
    let path = format!(
        "/api/pos/menu-sync?terminal_id={terminal_id_for_query}&last_sync=1970-01-01T00%3A00%3A00.000Z&include_inactive=true"
    );
    let masked_terminal_id = mask_terminal_id(&credentials.terminal_id);
    trace!(
        terminal_id = %masked_terminal_id,
        path = %path,
        "menu_sync: requesting menu payload from admin"
    );
    let resp = match api::fetch_from_admin_detailed(
        &credentials.admin_url,
        &credentials.api_key,
        &path,
        "GET",
        None,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            let failure = MenuSyncFailure::from(error);
            if failure.is_menu_unavailable() {
                // A partial menu on the admin side; the callers keep the
                // cached menu and log it.
                debug!(
                    terminal_id = %masked_terminal_id,
                    retry_after_secs = ?failure.retry_after_secs,
                    "menu_sync: admin menu temporarily unavailable"
                );
            } else if !is_menu_connectivity_error(&failure.message) {
                warn!(
                    terminal_id = %masked_terminal_id,
                    path = %path,
                    error = %failure.message,
                    "menu_sync: admin request failed"
                );
            }
            return Err(failure);
        }
    };

    // Admin contract shape:
    // { success, menu_data: { categories, subcategories, ingredients, combos, ... }, timestamp, ... }
    // Keep compatibility with legacy wrappers that returned { data: ... }.
    let data = resp
        .get("menu_data")
        .or_else(|| resp.get("data").and_then(|d| d.get("menu_data")))
        .or_else(|| resp.get("data"))
        .or_else(|| {
            if resp.get("categories").is_some()
                || resp.get("subcategories").is_some()
                || resp.get("ingredients").is_some()
                || resp.get("combos").is_some()
            {
                Some(&resp)
            } else {
                None
            }
        })
        .ok_or("Menu sync response missing menu payload")?;

    validate_menu_sections(data)?;
    complete_branch_overrides(data)?;

    let category_count = section_count(data, "categories");
    let subcategory_count = section_count(data, "subcategories");
    let ingredient_count = section_count(data, "ingredients");
    let combo_count = section_count(data, "combos");
    let counts = serde_json::json!({
        "categories": category_count,
        "subcategories": subcategory_count,
        "ingredients": ingredient_count,
        "combos": combo_count
    });

    let version = compute_menu_payload_version(data);
    let timestamp = resp
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    // Read before the lock: the branch may come from the credential store.
    let overrides_branch = current_branch_id(db);
    let updated = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        apply_menu_payload(&conn, data, &version, overrides_branch.as_deref())?
    };
    if !updated {
        trace!(
            terminal_id = %masked_terminal_id,
            version = %version,
            categories = category_count,
            subcategories = subcategory_count,
            ingredients = ingredient_count,
            combos = combo_count,
            "menu_sync: cache already at latest version"
        );
        return Ok(serde_json::json!({
            "success": true,
            "updated": false,
            "version": version,
            "counts": counts,
            "timestamp": timestamp
        }));
    }

    trace!(
        terminal_id = %masked_terminal_id,
        version = %version,
        categories = category_count,
        subcategories = subcategory_count,
        ingredients = ingredient_count,
        combos = combo_count,
        "menu_sync: cache updated"
    );

    Ok(serde_json::json!({
        "success": true,
        "updated": true,
        "version": version,
        "counts": counts,
        "timestamp": if timestamp.trim().is_empty() { Utc::now().to_rfc3339() } else { timestamp }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_version_is_order_invariant() {
        let first = serde_json::json!({
            "categories": [
                { "id": "c2", "display_order": 2 },
                { "id": "c1", "display_order": 1 }
            ],
            "subcategories": [
                { "id": "s2", "name": "B" },
                { "id": "s1", "name": "A" }
            ],
            "ingredients": [],
            "combos": []
        });
        let second = serde_json::json!({
            "categories": [
                { "display_order": 1, "id": "c1" },
                { "display_order": 2, "id": "c2" }
            ],
            "subcategories": [
                { "name": "A", "id": "s1" },
                { "name": "B", "id": "s2" }
            ],
            "ingredients": [],
            "combos": []
        });

        assert_eq!(
            compute_menu_payload_version(&first),
            compute_menu_payload_version(&second)
        );
    }

    #[test]
    fn payload_version_changes_when_content_changes() {
        let base = serde_json::json!({
            "categories": [{ "id": "c1", "name": "Savory" }],
            "subcategories": [],
            "ingredients": [],
            "combos": []
        });
        let changed = serde_json::json!({
            "categories": [{ "id": "c1", "name": "Sweet" }],
            "subcategories": [],
            "ingredients": [],
            "combos": []
        });

        assert_ne!(
            compute_menu_payload_version(&base),
            compute_menu_payload_version(&changed)
        );
    }

    #[test]
    fn menu_version_token_is_stable_for_equivalent_payloads() {
        let first = serde_json::json!({
            "latest_updated_at": "2026-02-25T10:00:00Z",
            "last_updated": {
                "subcategories": "2026-02-25T09:00:00Z",
                "menu_categories": "2026-02-25T08:00:00Z",
                "ingredients": "2026-02-25T09:30:00Z",
                "menu_combos": "2026-02-25T07:00:00Z"
            },
            "counts": {
                "menu_categories": 4,
                "subcategories": 12,
                "ingredients": 33,
                "menu_combos": 2
            }
        });
        let second = serde_json::json!({
            "counts": {
                "ingredients": 33,
                "menu_combos": 2,
                "subcategories": 12,
                "menu_categories": 4
            },
            "last_updated": {
                "menu_combos": "2026-02-25T07:00:00Z",
                "ingredients": "2026-02-25T09:30:00Z",
                "menu_categories": "2026-02-25T08:00:00Z",
                "subcategories": "2026-02-25T09:00:00Z"
            },
            "latest_updated_at": "2026-02-25T10:00:00Z"
        });

        let first_counts = normalize_digest_counts(&first);
        let second_counts = normalize_digest_counts(&second);
        let first_token = build_menu_version_token(
            &first,
            first.get("latest_updated_at").and_then(Value::as_str),
            &first_counts,
        );
        let second_token = build_menu_version_token(
            &second,
            second.get("latest_updated_at").and_then(Value::as_str),
            &second_counts,
        );
        assert_eq!(first_token, second_token);
    }

    fn menu_cache_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        // Same table as db.rs creates.
        conn.execute_batch(
            "CREATE TABLE menu_cache (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                cache_key TEXT UNIQUE NOT NULL,
                data TEXT NOT NULL,
                version TEXT,
                updated_at TEXT DEFAULT (datetime('now'))
            );",
        )
        .expect("create menu_cache");
        conn
    }

    fn menu_payload(category_name: &str) -> Value {
        serde_json::json!({
            "categories": [{ "id": "c1", "name": category_name }],
            "subcategories": [{ "id": "s1", "category_id": "c1", "name": "Espresso" }],
            "ingredients": [{ "id": "i1", "name": "Milk" }],
            "combos": [{ "id": "k1", "name": "Breakfast" }]
        })
    }

    fn cached_rows(conn: &Connection) -> Vec<(String, String, Option<String>)> {
        let mut stmt = conn
            .prepare("SELECT cache_key, data, version FROM menu_cache ORDER BY cache_key")
            .unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn apply(conn: &Connection, payload: &Value) -> Result<bool, String> {
        apply_menu_payload(
            conn,
            payload,
            &compute_menu_payload_version(payload),
            Some("branch-k4"),
        )
    }

    #[test]
    fn interrupted_menu_write_keeps_the_previous_menu_and_version() {
        let conn = menu_cache_conn();
        let old_payload = menu_payload("Savory");
        assert_eq!(apply(&conn, &old_payload), Ok(true));
        let before = cached_rows(&conn);

        // The third section's write fails, as on a full disk or a crash.
        conn.execute_batch(
            "CREATE TRIGGER fail_ingredients_insert BEFORE INSERT ON menu_cache
             WHEN NEW.cache_key = 'ingredients'
             BEGIN SELECT RAISE(ABORT, 'simulated ingredients write failure'); END;
             CREATE TRIGGER fail_ingredients_update BEFORE UPDATE ON menu_cache
             WHEN NEW.cache_key = 'ingredients'
             BEGIN SELECT RAISE(ABORT, 'simulated ingredients write failure'); END;",
        )
        .unwrap();
        let error = apply(&conn, &menu_payload("Sweet")).expect_err("the write fails");
        assert!(error.contains("upsert menu_cache[ingredients]"), "{error}");

        // Categories and subcategories were written before the failure and
        // rolled back with it.
        assert_eq!(cached_rows(&conn), before);
        assert!(conn.is_autocommit(), "no transaction is left open");
    }

    #[test]
    fn a_mixed_version_cache_is_rewritten_and_then_current() {
        let conn = menu_cache_conn();
        let payload = menu_payload("Savory");
        let version = compute_menu_payload_version(&payload);
        assert_eq!(apply(&conn, &payload), Ok(true));
        assert_eq!(apply(&conn, &payload), Ok(false), "all four rows current");

        // An older interrupted save left categories on the new version and
        // the other sections on the previous one.
        conn.execute(
            "UPDATE menu_cache SET version = 'digest:previous', data = '[]'
             WHERE cache_key <> 'categories'",
            [],
        )
        .unwrap();
        assert_eq!(apply(&conn, &payload), Ok(true));
        for (cache_key, data, row_version) in cached_rows(&conn) {
            assert_eq!(
                row_version.as_deref(),
                Some(version.as_str()),
                "{cache_key}"
            );
            assert_ne!(data, "[]", "{cache_key}");
        }
        assert_eq!(apply(&conn, &payload), Ok(false));
    }

    #[test]
    fn an_offline_stamped_section_is_rewritten() {
        let conn = menu_cache_conn();
        let payload = menu_payload("Savory");
        assert_eq!(apply(&conn, &payload), Ok(true));
        // An offline availability toggle restamps the one section it changed.
        conn.execute(
            "UPDATE menu_cache
             SET version = 'offline:00000000-0000-4000-8000-000000000000',
                 data = '[{\"id\":\"k1\",\"name\":\"Breakfast\",\"is_active\":false}]'
             WHERE cache_key = 'combos'",
            [],
        )
        .unwrap();

        assert_eq!(apply(&conn, &payload), Ok(true));
        let combos = cached_rows(&conn)
            .into_iter()
            .find(|(cache_key, _, _)| cache_key == "combos")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&combos.1).unwrap(),
            payload["combos"]
        );
        assert_eq!(
            combos.2.as_deref(),
            Some(compute_menu_payload_version(&payload).as_str())
        );
    }

    #[test]
    fn a_payload_missing_a_section_is_refused_and_writes_nothing() {
        let conn = menu_cache_conn();
        assert_eq!(apply(&conn, &menu_payload("Savory")), Ok(true));
        let before = cached_rows(&conn);

        let mut missing = menu_payload("Sweet");
        missing.as_object_mut().unwrap().remove("combos");
        let error = apply(&conn, &missing).expect_err("missing combos");
        assert!(error.starts_with(MENU_PAYLOAD_INCOMPLETE), "{error}");
        assert!(error.contains("combos"), "{error}");

        let mut not_an_array = menu_payload("Sweet");
        not_an_array["ingredients"] = serde_json::json!({ "error": "unavailable" });
        let error = apply(&conn, &not_an_array).expect_err("ingredients not an array");
        assert!(error.contains("ingredients"), "{error}");

        let mut null_section = menu_payload("Sweet");
        null_section["subcategories"] = Value::Null;
        assert!(apply(&conn, &null_section).is_err());

        assert_eq!(cached_rows(&conn), before);
        // An empty section the admin did send stays a real, empty section.
        let mut empty_combos = menu_payload("Sweet");
        empty_combos["combos"] = serde_json::json!([]);
        assert_eq!(apply(&conn, &empty_combos), Ok(true));
    }

    /// One-request admin that answers `status` with `body` and `Retry-After`.
    fn spawn_menu_admin(status: u16, retry_after: &'static str, body: &'static str) -> String {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind menu admin");
        let addr = listener.local_addr().expect("menu admin address");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept menu sync request");
            let mut buffer = vec![0u8; 16 * 1024];
            let read = stream.read(&mut buffer).expect("read menu sync request");
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            assert!(request.starts_with("GET /api/pos/menu-sync?"), "{request}");
            let response = format!(
                "HTTP/1.1 {status} Mock\r\nRetry-After: {retry_after}\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write menu sync reply");
        });
        format!("http://{addr}")
    }

    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn a_partial_menu_503_is_an_error_with_its_retry_after_and_keeps_the_cache() {
        let admin_url = spawn_menu_admin(
            503,
            "5",
            r#"{"success":false,"error":"POS menu temporarily unavailable","code":"POS_MENU_SYNC_UNAVAILABLE"}"#,
        );
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("pos_api_key", "menu-test-api-key"),
            ("terminal_id", "terminal-menu-test"),
            ("admin_dashboard_url", admin_url.as_str()),
        ]);
        let conn = menu_cache_conn();
        assert_eq!(apply(&conn, &menu_payload("Savory")), Ok(true));
        let before = cached_rows(&conn);
        let db = DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        let failure = sync_menu_detailed(&db)
            .await
            .expect_err("a partial menu is never a successful sync");
        assert!(failure.is_menu_unavailable(), "{failure:?}");
        assert_eq!(failure.retry_after_secs, Some(5));
        assert_eq!(cached_rows(&db.conn.lock().unwrap()), before);
    }

    // -- POS audit K4: branch overrides -------------------------------------

    const EFFECTIVE_MENU_PRICE_FIXTURE: &str =
        include_str!("../../../shared/pos/menu/__fixtures__/effective-menu-price.json");

    fn fixture() -> Value {
        serde_json::from_str(EFFECTIVE_MENU_PRICE_FIXTURE).expect("shared fixture is JSON")
    }

    fn fixture_override(entry: &Value) -> Option<&Value> {
        entry.get("override").filter(|value| !value.is_null())
    }

    #[test]
    fn effective_menu_price_matches_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["price_cases"].as_array().expect("price cases");
        assert!(!cases.is_empty());
        for entry in cases {
            let name = entry["name"].as_str().unwrap_or_default();
            let effective = effective_menu_price(&entry["row"], fixture_override(entry));
            let expected = &entry["expected"];
            for (field, price) in MENU_PRICE_FIELDS.iter().zip(effective.prices) {
                assert_eq!(price, expected[*field].as_f64(), "{name}: {field}");
            }
            assert_eq!(
                Some(effective.is_available),
                expected["is_available"].as_bool(),
                "{name}"
            );
            assert_eq!(
                Some(effective.price_overridden),
                expected["price_overridden"].as_bool(),
                "{name}"
            );
        }
    }

    #[test]
    fn effective_channel_price_matches_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["channel_cases"].as_array().expect("channel cases");
        assert!(!cases.is_empty());
        for entry in cases {
            let name = entry["name"].as_str().unwrap_or_default();
            for (order_type, expected) in entry["expected"].as_object().expect("expected") {
                assert_eq!(
                    Some(effective_channel_price(
                        &entry["row"],
                        fixture_override(entry),
                        order_type
                    )),
                    expected.as_f64(),
                    "{name}: {order_type}"
                );
            }
        }
        // Other order types price as pickup, as in the editor.
        assert_eq!(
            effective_channel_price(
                &serde_json::json!({ "price": 5, "pickup_price": 6, "instore_price": 8 }),
                None,
                "takeaway"
            ),
            6.0
        );
    }

    #[test]
    fn index_branch_overrides_matches_the_shared_fixture_in_any_order() {
        let fixture = fixture();
        let cases = fixture["index_cases"].as_array().expect("index cases");
        assert!(!cases.is_empty());
        for entry in cases {
            let name = entry["name"].as_str().unwrap_or_default();
            let mut overrides = entry["overrides"].as_array().expect("overrides").clone();
            let expected: HashMap<String, String> = entry["expected"]
                .as_object()
                .expect("expected")
                .iter()
                .map(|(resource, id)| (resource.clone(), id.as_str().unwrap().to_string()))
                .collect();
            for _ in 0..2 {
                let picked: HashMap<String, String> = index_branch_overrides(&overrides)
                    .into_iter()
                    .map(|(resource, row)| {
                        (resource, row["id"].as_str().unwrap_or_default().to_string())
                    })
                    .collect();
                assert_eq!(picked, expected, "{name}");
                overrides.reverse();
            }
        }
    }

    fn override_row(id: &str, column: &str, resource: &str, extra: Value) -> Value {
        let mut row = serde_json::json!({
            "id": id,
            "branch_id": "branch-k4",
            "app_name": "pos-tauri",
            "price_override": null,
            "availability_override": null,
            "updated_at": "2026-10-21T08:00:00.000Z",
        });
        row[column] = Value::String(resource.to_string());
        for (key, value) in extra.as_object().unwrap() {
            row[key] = value.clone();
        }
        row
    }

    fn menu_with_overrides(overrides: Value) -> Value {
        let mut payload = serde_json::json!({
            "categories": [{ "id": "c1", "name": "Coffee" }],
            "subcategories": [
                { "id": "s1", "category_id": "c1", "name": "Espresso", "price": 3, "base_price": 3,
                  "pickup_price": 3, "delivery_price": 3.5, "dine_in_price": 3.2,
                  "is_active": true, "is_available": true },
                { "id": "s2", "category_id": "c1", "name": "Latte", "price": 4, "is_available": true }
            ],
            "ingredients": [
                { "id": "i1", "name": "Oat milk", "price": 0.5, "is_available": true },
                { "id": "i2", "name": "Syrup", "price": 0.3, "is_active": false, "is_available": true },
                { "id": "i3", "name": "Cream", "price": 0.4, "is_available": true }
            ],
            "combos": []
        });
        if !overrides.is_null() {
            payload["branch_overrides"] = overrides;
            payload["branch_overrides_complete"] = Value::Bool(true);
        }
        payload
    }

    fn effective(conn: &Connection, section: &str, column: &str, branch: &str) -> Vec<Value> {
        let index = load_branch_override_index(conn, Some(branch));
        merge_branch_overrides(read_cache_rows(conn, section), &index, column)
    }

    fn by_id<'a>(rows: &'a [Value], id: &str) -> &'a Value {
        rows.iter().find(|row| row["id"] == id).expect("row")
    }

    #[test]
    fn a_branch_price_override_prices_every_channel_and_its_removal_restores_the_catalog() {
        let conn = menu_cache_conn();
        let overrides = serde_json::json!([
            override_row(
                "ov-1",
                "subcategory_id",
                "s1",
                serde_json::json!({ "price_override": 2.5 })
            ),
            override_row(
                "ov-2",
                "ingredient_id",
                "i1",
                serde_json::json!({ "price_override": "0" })
            ),
        ]);
        assert_eq!(apply(&conn, &menu_with_overrides(overrides)), Ok(true));

        let items = effective(&conn, "subcategories", "subcategory_id", "branch-k4");
        let espresso = by_id(&items, "s1");
        for field in MENU_PRICE_FIELDS {
            assert_eq!(espresso[field].as_f64(), Some(2.5), "{field}");
        }
        assert_eq!(espresso["price_overridden"], true);
        assert_eq!(espresso["catalog_prices"]["delivery_price"], 3.5);
        assert_eq!(espresso["is_available"], true);
        // A row without an override is the catalog row.
        assert_eq!(
            by_id(&items, "s2"),
            &read_cache_rows(&conn, "subcategories")[1]
        );
        // A zero override is a price.
        let ingredients = effective(&conn, "ingredients", "ingredient_id", "branch-k4");
        assert_eq!(
            by_id(&ingredients, "i1")["pickup_price"].as_f64(),
            Some(0.0)
        );
        // The cache keeps the catalog rows.
        assert_eq!(read_cache_rows(&conn, "subcategories")[0]["price"], 3);

        // The admin deleted the override: the next complete set has none.
        assert_eq!(
            apply(&conn, &menu_with_overrides(serde_json::json!([]))),
            Ok(true),
            "an override-only change rewrites the cache"
        );
        let items = effective(&conn, "subcategories", "subcategory_id", "branch-k4");
        assert_eq!(
            by_id(&items, "s1"),
            &read_cache_rows(&conn, "subcategories")[0]
        );
        assert_eq!(by_id(&items, "s1")["delivery_price"], 3.5);
    }

    #[test]
    fn unavailable_wins_over_any_override() {
        let conn = menu_cache_conn();
        let overrides = serde_json::json!([
            override_row(
                "ov-1",
                "subcategory_id",
                "s1",
                serde_json::json!({ "availability_override": false })
            ),
            override_row(
                "ov-2",
                "ingredient_id",
                "i2",
                serde_json::json!({ "availability_override": true })
            ),
            override_row(
                "ov-3",
                "ingredient_id",
                "i3",
                serde_json::json!({ "availability_override": true })
            ),
        ]);
        assert_eq!(apply(&conn, &menu_with_overrides(overrides)), Ok(true));

        let items = effective(&conn, "subcategories", "subcategory_id", "branch-k4");
        assert_eq!(by_id(&items, "s1")["is_available"], false);
        assert_eq!(
            by_id(&items, "s1")["price"],
            3,
            "no price override, no price change"
        );
        let ingredients = effective(&conn, "ingredients", "ingredient_id", "branch-k4");
        // An inactive ingredient stays unavailable whatever the override says.
        assert_eq!(by_id(&ingredients, "i2")["is_available"], false);
        // No is_active (an older server) is no information.
        assert_eq!(by_id(&ingredients, "i3")["is_available"], true);
    }

    /// Review 21/10/2026: unavailable wins on rows with no override too. An
    /// inactive row is never served as available; a row without flags, or
    /// without `is_active` (an older server), is served as it is.
    #[test]
    fn an_inactive_row_without_an_override_is_served_unavailable() {
        let conn = menu_cache_conn();
        // No override set at all, then a set that names none of these rows.
        for overrides in [Value::Null, serde_json::json!([])] {
            let mut payload = menu_with_overrides(overrides);
            payload["subcategories"][1]["is_active"] = Value::Bool(false);
            assert_eq!(apply(&conn, &payload), Ok(true));

            let items = effective(&conn, "subcategories", "subcategory_id", "branch-k4");
            assert_eq!(by_id(&items, "s2")["is_available"], false);
            assert_eq!(by_id(&items, "s2")["price"], 4, "only availability changes");
            assert_eq!(
                by_id(&items, "s1"),
                &read_cache_rows(&conn, "subcategories")[0],
                "an available row is served unchanged"
            );
            let ingredients = effective(&conn, "ingredients", "ingredient_id", "branch-k4");
            assert_eq!(by_id(&ingredients, "i2")["is_available"], false);
            assert_eq!(
                by_id(&ingredients, "i3"),
                &read_cache_rows(&conn, "ingredients")[2],
                "no is_active is no information"
            );
        }
        // The cache keeps the catalog flags.
        assert_eq!(
            read_cache_rows(&conn, "subcategories")[1]["is_available"],
            true
        );
    }

    #[test]
    fn overrides_apply_only_to_their_resource_and_their_branch() {
        let conn = menu_cache_conn();
        // An ingredient override whose id equals a menu item id.
        let overrides = serde_json::json!([override_row(
            "ov-1",
            "ingredient_id",
            "s2",
            serde_json::json!({ "price_override": 1 })
        )]);
        assert_eq!(apply(&conn, &menu_with_overrides(overrides)), Ok(true));
        let items = effective(&conn, "subcategories", "subcategory_id", "branch-k4");
        assert_eq!(by_id(&items, "s2")["price"], 4);

        let overrides = serde_json::json!([override_row(
            "ov-2",
            "subcategory_id",
            "s1",
            serde_json::json!({ "price_override": 1 })
        )]);
        assert_eq!(apply(&conn, &menu_with_overrides(overrides)), Ok(true));
        // The till moved to another branch: the stored set is not its own.
        let items = effective(&conn, "subcategories", "subcategory_id", "branch-other");
        assert_eq!(by_id(&items, "s1")["price"], 3);
        assert!(load_branch_override_index(&conn, None).is_empty());
    }

    #[test]
    fn an_older_server_without_a_complete_set_keeps_the_stored_set() {
        let conn = menu_cache_conn();
        let overrides = serde_json::json!([override_row(
            "ov-1",
            "subcategory_id",
            "s1",
            serde_json::json!({ "price_override": 2 })
        )]);
        assert_eq!(apply(&conn, &menu_with_overrides(overrides)), Ok(true));
        let stored = |conn: &Connection| -> String {
            conn.query_row(
                "SELECT data FROM menu_cache WHERE cache_key = 'branch_overrides'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        let before = stored(&conn);

        let mut old_server = menu_with_overrides(Value::Null);
        old_server["branch_overrides"] = serde_json::json!([]);
        assert_eq!(apply(&conn, &old_server), Ok(true));
        assert_eq!(
            stored(&conn),
            before,
            "no complete set: the stored one stays"
        );
        assert_eq!(apply(&conn, &old_server), Ok(false), "and nothing loops");
        let items = effective(&conn, "subcategories", "subcategory_id", "branch-k4");
        assert_eq!(by_id(&items, "s1")["price"].as_f64(), Some(2.0));

        // A set marked complete but not a list is refused, like a missing section.
        let mut broken = menu_with_overrides(serde_json::json!([]));
        broken["branch_overrides"] = Value::Null;
        let error = apply(&conn, &broken).expect_err("malformed set");
        assert!(error.contains("branch_overrides"), "{error}");
        assert_eq!(stored(&conn), before);
    }

    #[test]
    fn a_failed_override_write_keeps_the_whole_previous_menu() {
        let conn = menu_cache_conn();
        assert_eq!(
            apply(&conn, &menu_with_overrides(serde_json::json!([]))),
            Ok(true)
        );
        let before = cached_rows(&conn);
        conn.execute_batch(
            "CREATE TRIGGER fail_overrides BEFORE UPDATE ON menu_cache
             WHEN NEW.cache_key = 'branch_overrides'
             BEGIN SELECT RAISE(ABORT, 'simulated override write failure'); END;",
        )
        .unwrap();
        let overrides = serde_json::json!([override_row(
            "ov-1",
            "subcategory_id",
            "s1",
            serde_json::json!({ "price_override": 2 })
        )]);
        let mut changed = menu_with_overrides(overrides);
        changed["categories"][0]["name"] = Value::String("Tea".into());
        assert!(apply(&conn, &changed).is_err());
        assert_eq!(cached_rows(&conn), before);
    }

    #[test]
    fn the_read_commands_serve_rows_under_the_terminals_branch_overrides() {
        let _keyring = crate::tests::fake_keyring::install_seeded([("branch_id", "branch-k4")]);
        let conn = menu_cache_conn();
        let overrides = serde_json::json!([
            override_row(
                "ov-1",
                "subcategory_id",
                "s1",
                serde_json::json!({ "price_override": 2.5 })
            ),
            override_row(
                "ov-2",
                "ingredient_id",
                "i1",
                serde_json::json!({ "availability_override": false })
            ),
        ]);
        assert_eq!(apply(&conn, &menu_with_overrides(overrides)), Ok(true));
        let db = DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };

        assert_eq!(by_id(&get_effective_subcategories(&db), "s1")["price"], 2.5);
        assert_eq!(
            get_subcategories(&db)[0]["price"],
            3,
            "internal readers see the catalog"
        );
        assert_eq!(
            by_id(&get_effective_ingredients(&db), "i1")["is_available"],
            false
        );
        let nested = apply_ingredient_overrides(&db, get_ingredients(&db));
        assert_eq!(by_id(&nested, "i1")["is_available"], false);
    }
}
