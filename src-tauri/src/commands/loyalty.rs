use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use std::time::Duration;
use tauri::Manager;
use tracing::info;
use uuid::Uuid;

use crate::database_lock::run_blocking_command;
use crate::{db, read_local_json_array, storage, sync_queue, value_f64, value_i64, value_str};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve the terminal's organization_id from secure storage or local settings.
fn get_organization_id(db: &db::DbState) -> Option<String> {
    storage::get_credential("organization_id")
        .or_else(|| crate::read_local_setting(db, "terminal", "organization_id"))
}

/// Determine the loyalty tier based on lifetime points earned.
fn calculate_tier(
    total_earned: i64,
    bronze: i64,
    silver: i64,
    gold: i64,
    platinum: i64,
) -> &'static str {
    if total_earned >= platinum {
        "platinum"
    } else if total_earned >= gold {
        "gold"
    } else if total_earned >= silver {
        "silver"
    } else if total_earned >= bronze {
        "bronze"
    } else {
        "none"
    }
}

/// Build a JSON object from a loyalty_settings row.
fn settings_row_to_json(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id":                     row.get::<_, String>(0)?,
        "organization_id":        row.get::<_, String>(1)?,
        "is_active":              row.get::<_, i64>(2)? != 0,
        "points_per_euro":        row.get::<_, f64>(3)?,
        "redemption_rate":        row.get::<_, f64>(4)?,
        "min_redemption_points":  row.get::<_, i64>(5)?,
        "tier_bronze_threshold":  row.get::<_, Option<i64>>(6)?.unwrap_or(0),
        "tier_silver_threshold":  row.get::<_, Option<i64>>(7)?.unwrap_or(500),
        "tier_gold_threshold":    row.get::<_, Option<i64>>(8)?.unwrap_or(2000),
        "tier_platinum_threshold":row.get::<_, Option<i64>>(9)?.unwrap_or(5000),
        "welcome_bonus_points":   row.get::<_, Option<i64>>(10)?.unwrap_or(0),
        "birthday_bonus_points":  row.get::<_, Option<i64>>(11)?.unwrap_or(0),
        "referral_bonus_points":  row.get::<_, Option<i64>>(12)?.unwrap_or(0),
        "last_synced_at":         row.get::<_, Option<String>>(13)?,
    }))
}

/// Build a JSON object from a loyalty_customers row.
fn customer_row_to_json(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id":               row.get::<_, String>(0)?,
        "user_profile_id":  row.get::<_, Option<String>>(1)?,
        "customer_id":      row.get::<_, Option<String>>(2)?,
        "organization_id":  row.get::<_, String>(3)?,
        "points_balance":   row.get::<_, i64>(4)?,
        "total_earned":     row.get::<_, i64>(5)?,
        "total_redeemed":   row.get::<_, i64>(6)?,
        "tier":             row.get::<_, String>(7)?,
        "customer_name":    row.get::<_, Option<String>>(8)?,
        "customer_email":   row.get::<_, Option<String>>(9)?,
        "customer_phone":   row.get::<_, Option<String>>(10)?,
        "loyalty_card_uid": row.get::<_, Option<String>>(11)?,
        "last_synced_at":   row.get::<_, Option<String>>(12)?,
        "created_at":       row.get::<_, String>(13)?,
        "updated_at":       row.get::<_, String>(14)?,
    }))
}

fn loyalty_customer_select_clause() -> &'static str {
    "SELECT id, user_profile_id, customer_id, organization_id, points_balance, total_earned,
            total_redeemed, tier, customer_name, customer_email, customer_phone,
            loyalty_card_uid, last_synced_at, created_at, updated_at
     FROM loyalty_customers"
}

fn legacy_loyalty_customer_from_customer(customer: &Value, org_id: &str) -> Option<Value> {
    let points = value_i64(customer, &["loyalty_points", "loyaltyPoints"])?;
    if points <= 0 {
        return None;
    }

    let customer_id = value_str(customer, &["id", "customerId", "customer_id"])?;
    Some(serde_json::json!({
        "id": customer_id,
        "user_profile_id": null,
        "customer_id": customer_id,
        "organization_id": org_id,
        "points_balance": points,
        "total_earned": points,
        "total_redeemed": 0,
        "tier": "none",
        "customer_name": value_str(customer, &["name", "fullName", "customer_name"]),
        "customer_email": value_str(customer, &["email", "customerEmail", "customer_email"]),
        "customer_phone": value_str(customer, &["phone", "customerPhone", "customer_phone", "mobile", "telephone"]),
        "loyalty_card_uid": value_str(customer, &["loyalty_card_uid", "loyaltyCardUid"]),
        "created_at": value_str(customer, &["created_at", "createdAt"]),
        "updated_at": value_str(customer, &["updated_at", "updatedAt"]),
    }))
}

fn legacy_loyalty_customers_from_local_cache(
    db: &db::DbState,
    org_id: &str,
    search: &str,
) -> Result<Vec<Value>, String> {
    let needle = search.trim().to_lowercase();
    let mut rows: Vec<Value> = read_local_json_array(db, "customer_cache_v1")?
        .into_iter()
        .filter_map(|customer| legacy_loyalty_customer_from_customer(&customer, org_id))
        .filter(|customer| {
            if needle.is_empty() {
                return true;
            }
            let haystack = [
                value_str(customer, &["customer_name"]),
                value_str(customer, &["customer_email"]),
                value_str(customer, &["customer_phone"]),
                value_str(customer, &["customer_id"]),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
            haystack.contains(&needle)
        })
        .collect();

    rows.sort_by(|a, b| {
        value_i64(b, &["points_balance"])
            .unwrap_or(0)
            .cmp(&value_i64(a, &["points_balance"]).unwrap_or(0))
    });

    Ok(rows)
}

fn find_loyalty_customer_row(
    conn: &rusqlite::Connection,
    org_id: &str,
    customer_key: &str,
) -> Result<Option<Value>, String> {
    let resolved_customer_id = resolve_loyalty_customer_lookup_key(conn, org_id, customer_key)?;
    let sql = format!(
        "{} WHERE organization_id = ?1
           AND (
             customer_id = ?2
             OR (?3 IS NOT NULL AND user_profile_id = ?3)
           )
         LIMIT 1",
        loyalty_customer_select_clause()
    );

    conn.query_row(
        &sql,
        params![org_id, resolved_customer_id, Some(customer_key)],
        customer_row_to_json,
    )
    .optional()
    .map_err(|e| format!("find loyalty customer row: {e}"))
}

fn ensure_local_loyalty_customer_row(
    conn: &rusqlite::Connection,
    org_id: &str,
    customer_id: &str,
    now: &str,
) -> Result<(), String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id
             FROM loyalty_customers
             WHERE organization_id = ?1
               AND customer_id = ?2
             LIMIT 1",
            params![org_id, customer_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("ensure loyalty customer lookup: {e}"))?;

    if existing.is_some() {
        return Ok(());
    }

    conn.execute(
        "INSERT INTO loyalty_customers (
            id, user_profile_id, customer_id, organization_id, points_balance,
            total_earned, total_redeemed, tier, customer_name, customer_email,
            customer_phone, loyalty_card_uid, last_synced_at, created_at, updated_at
        ) VALUES (?1, NULL, ?2, ?3, 0, 0, 0, 'none', NULL, NULL, NULL, NULL, NULL, ?4, ?4)",
        params![Uuid::new_v4().to_string(), customer_id, org_id, now],
    )
    .map_err(|e| format!("ensure loyalty customer insert: {e}"))?;

    Ok(())
}

fn resolve_loyalty_customer_lookup_key(
    conn: &rusqlite::Connection,
    org_id: &str,
    customer_key: &str,
) -> Result<String, String> {
    let customer_id = customer_key.trim();
    if customer_id.is_empty() {
        return Err("Missing customerId or customer_id".to_string());
    }

    let existing_customer_id: Option<String> = conn
        .query_row(
            "SELECT customer_id
             FROM loyalty_customers
             WHERE organization_id = ?1
               AND customer_id = ?2
             LIMIT 1",
            params![org_id, customer_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(|e| format!("resolve loyalty customer by customer_id: {e}"))?;

    if let Some(found_customer_id) = existing_customer_id {
        return Ok(found_customer_id);
    }

    let legacy_customer_id: Option<String> = conn
        .query_row(
            "SELECT customer_id
             FROM loyalty_customers
             WHERE organization_id = ?1
               AND user_profile_id = ?2
             LIMIT 1",
            params![org_id, customer_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(|e| format!("resolve loyalty customer by user_profile_id: {e}"))?;

    Ok(legacy_customer_id.unwrap_or_else(|| customer_id.to_string()))
}

/// Build a JSON object from a loyalty_transactions row.
fn transaction_row_to_json(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id":               row.get::<_, String>(0)?,
        "customer_id":      row.get::<_, String>(1)?,
        "organization_id":  row.get::<_, String>(2)?,
        "points":           row.get::<_, i64>(3)?,
        "transaction_type": row.get::<_, String>(4)?,
        "order_id":         row.get::<_, Option<String>>(5)?,
        "description":      row.get::<_, Option<String>>(6)?,
        "sync_state":       row.get::<_, String>(7)?,
        "created_at":       row.get::<_, String>(8)?,
    }))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read cached loyalty settings for this terminal's organization from SQLite.
#[tauri::command]
pub async fn loyalty_get_settings(app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("loyalty_get_settings", move || {
        let db = app.state::<db::DbState>();
        let org_id = match get_organization_id(&db) {
            Some(id) => id,
            None => return Ok(serde_json::json!({ "settings": null })),
        };

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let row: Option<Value> = conn
            .query_row(
                "SELECT id, organization_id, is_active, points_per_euro, redemption_rate,
                    min_redemption_points, tier_bronze_threshold, tier_silver_threshold,
                    tier_gold_threshold, tier_platinum_threshold, welcome_bonus_points,
                    birthday_bonus_points, referral_bonus_points, last_synced_at
             FROM loyalty_settings
             WHERE organization_id = ?1
             LIMIT 1",
                params![org_id],
                settings_row_to_json,
            )
            .optional()
            .map_err(|e| format!("loyalty_get_settings query: {e}"))?;

        Ok(serde_json::json!({ "settings": row }))
    })
    .await
}

/// Fetch loyalty settings from the admin API and cache locally.
#[tauri::command]
pub async fn loyalty_sync_settings(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let org_id =
        get_organization_id(&db).ok_or_else(|| "Organization not configured".to_string())?;

    let resp = crate::admin_fetch(Some(&db), "/api/pos/loyalty/settings", "GET", None).await?;

    let settings = resp.get("settings").cloned().unwrap_or(Value::Null);

    if settings.is_null() {
        info!("loyalty_sync_settings: no settings returned from admin");
        return Ok(serde_json::json!({ "settings": null }));
    }

    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Upsert: delete existing for this org, then insert fresh
    conn.execute(
        "DELETE FROM loyalty_settings WHERE organization_id = ?1",
        params![org_id],
    )
    .map_err(|e| format!("loyalty_sync_settings delete: {e}"))?;

    let s = &settings;
    conn.execute(
        "INSERT INTO loyalty_settings (
            id, organization_id, is_active, points_per_euro, redemption_rate,
            min_redemption_points, tier_bronze_threshold, tier_silver_threshold,
            tier_gold_threshold, tier_platinum_threshold, welcome_bonus_points,
            birthday_bonus_points, referral_bonus_points, last_synced_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            s.get("id").and_then(|v| v.as_str()).unwrap_or("default"),
            org_id,
            if s.get("is_active")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                1
            } else {
                0
            },
            s.get("points_per_euro")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0),
            s.get("redemption_rate")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.01),
            s.get("min_redemption_points")
                .and_then(|v| v.as_i64())
                .unwrap_or(100),
            s.get("tier_bronze_threshold")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            s.get("tier_silver_threshold")
                .and_then(|v| v.as_i64())
                .unwrap_or(500),
            s.get("tier_gold_threshold")
                .and_then(|v| v.as_i64())
                .unwrap_or(2000),
            s.get("tier_platinum_threshold")
                .and_then(|v| v.as_i64())
                .unwrap_or(5000),
            s.get("welcome_bonus_points")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            s.get("birthday_bonus_points")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            s.get("referral_bonus_points")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            now,
        ],
    )
    .map_err(|e| format!("loyalty_sync_settings insert: {e}"))?;

    info!(org_id = %org_id, "Synced loyalty settings from admin");

    // Re-read the row to return a consistent shape
    let row: Option<Value> = conn
        .query_row(
            "SELECT id, organization_id, is_active, points_per_euro, redemption_rate,
                    min_redemption_points, tier_bronze_threshold, tier_silver_threshold,
                    tier_gold_threshold, tier_platinum_threshold, welcome_bonus_points,
                    birthday_bonus_points, referral_bonus_points, last_synced_at
             FROM loyalty_settings
             WHERE organization_id = ?1
             LIMIT 1",
            params![org_id],
            settings_row_to_json,
        )
        .optional()
        .map_err(|e| format!("loyalty_sync_settings re-read: {e}"))?;

    Ok(serde_json::json!({ "settings": row }))
}

const CUSTOMER_SNAPSHOT_KEY: &str = "loyalty_customers_snapshot_v1";
static CUSTOMER_SNAPSHOT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn loyalty_snapshot_scope(db: &db::DbState) -> Value {
    let identity = |key| {
        storage::get_credential(key).or_else(|| crate::read_local_setting(db, "terminal", key))
    };
    serde_json::json!([
        identity("organization_id"),
        identity("branch_id"),
        identity("terminal_id")
    ])
}

async fn loyalty_snapshot_version(db: &db::DbState) -> Result<Option<String>, String> {
    match crate::admin_fetch_detailed(
        Some(db),
        "/api/pos/sync-version?module=loyalty",
        "GET",
        None,
    )
    .await
    {
        Ok(value) => Ok(value
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string)),
        Err(error) if matches!(error.status(), Some(401 | 403)) => {
            crate::write_local_json(db, CUSTOMER_SNAPSHOT_KEY, &Value::Null)?;
            Err(error.to_string())
        }
        Err(_) => Ok(None), // Migration absent/offline: never treat as unchanged.
    }
}

fn has_pending_loyalty(conn: &rusqlite::Connection, org: &str) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM loyalty_transactions WHERE organization_id = ?1 AND sync_state NOT IN ('applied', 'synced'))", params![org], |row| row.get(0)).map_err(|e| e.to_string())
}

fn loyalty_snapshot_revision_confirmed(before: &Option<String>, after: &Option<String>) -> bool {
    // Unversioned legacy fallback is allowed only when the initial check was unavailable.
    before.is_none() || before == after
}

fn replace_loyalty_snapshot(
    connection: &mut rusqlite::Connection,
    org_id: &str,
    customers: &[Value],
) -> Result<usize, String> {
    let now = Utc::now().to_rfc3339();
    let conn = connection.transaction().map_err(|e| e.to_string())?;
    if has_pending_loyalty(&conn, &org_id)? {
        return Err("Loyalty changes pending during snapshot".into());
    }
    conn.execute(
        "DELETE FROM loyalty_customers WHERE organization_id = ?1",
        params![org_id],
    )
    .map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for c in customers {
        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if id.is_empty() {
            return Err("Invalid customer in loyalty snapshot".into());
        }
        let customer_id = c
            .get("customer_id")
            .and_then(|v| v.as_str())
            .or_else(|| c.get("user_profile_id").and_then(|v| v.as_str()))
            .unwrap_or(id);
        let user_profile_id = c
            .get("user_profile_id")
            .and_then(|v| v.as_str())
            .unwrap_or(customer_id);
        conn.execute(
            "INSERT OR REPLACE INTO loyalty_customers (
                id, user_profile_id, customer_id, organization_id, points_balance,
                total_earned, total_redeemed, tier, customer_name, customer_email,
                customer_phone, loyalty_card_uid, last_synced_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                      COALESCE(?14, datetime('now')), ?15)",
            params![
                id,
                user_profile_id,
                customer_id,
                org_id,
                c.get("points_balance")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                c.get("total_earned").and_then(|v| v.as_i64()).unwrap_or(0),
                c.get("total_redeemed")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                c.get("tier").and_then(|v| v.as_str()).unwrap_or("none"),
                c.get("customer_name").and_then(|v| v.as_str()),
                c.get("customer_email").and_then(|v| v.as_str()),
                c.get("customer_phone").and_then(|v| v.as_str()),
                c.get("loyalty_card_uid").and_then(|v| v.as_str()),
                now,
                c.get("created_at").and_then(|v| v.as_str()),
                now,
            ],
        )
        .map_err(|e| format!("loyalty_sync_customers upsert: {e}"))?;
        count += 1;
    }

    conn.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

/// Pull all pages before replacing the local snapshot, never overwriting pending points.
#[tauri::command]
pub async fn loyalty_sync_customers(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let _guard = CUSTOMER_SNAPSHOT_LOCK.lock().await;
    let org_id =
        get_organization_id(&db).ok_or_else(|| "Organization not configured".to_string())?;
    let scope = loyalty_snapshot_scope(&db);
    let access = super::modules::modules_get_cached(app).await?;
    let entitled = access.get("identityMatch").and_then(Value::as_bool) == Some(true)
        && access
            .pointer("/modules/modules")
            .and_then(Value::as_array)
            .is_some_and(|modules| {
                modules.iter().any(|module| {
                    module.get("module_id").and_then(Value::as_str) == Some("loyalty")
                        && module.get("is_purchased").and_then(Value::as_bool) == Some(true)
                        && module.get("pos_enabled").and_then(Value::as_bool) == Some(true)
                        && module.get("is_enabled").and_then(Value::as_bool) != Some(false)
                        && module.get("is_locked").and_then(Value::as_bool) != Some(true)
                })
            });
    if !entitled {
        crate::write_local_json(&db, CUSTOMER_SNAPSHOT_KEY, &Value::Null)?;
        return Err("Loyalty unavailable for current terminal".into());
    }
    let version = loyalty_snapshot_version(&db).await?;
    let marker = crate::read_local_json(&db, CUSTOMER_SNAPSHOT_KEY)?;
    let force = arg0
        .as_ref()
        .and_then(|v| v.get("force"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if has_pending_loyalty(&conn, &org_id)? {
            drop(conn);
            crate::write_local_json(&db, CUSTOMER_SNAPSHOT_KEY, &Value::Null)?;
            return Ok(serde_json::json!({"success": true, "pendingLocalChanges": true}));
        }
    }
    if !force
        && version.is_some()
        && marker.get("scope") == Some(&scope)
        && marker.get("version").and_then(Value::as_str) == version.as_deref()
    {
        return Ok(serde_json::json!({"success": true, "unchanged": true}));
    }
    let mut customers = Vec::new();
    let mut offset = 0u64;
    loop {
        let path = format!("/api/pos/loyalty/customers?limit=200&offset={offset}");
        let response = crate::admin_fetch(Some(&db), &path, "GET", None).await?;
        let page = response
            .get("customers")
            .and_then(Value::as_array)
            .ok_or("Incomplete loyalty snapshot")?;
        let more = response
            .pointer("/pagination/hasMore")
            .and_then(Value::as_bool)
            .ok_or("Missing loyalty pagination")?;
        customers.extend(page.iter().cloned());
        if !more {
            break;
        }
        let next = response
            .pointer("/pagination/nextOffset")
            .and_then(Value::as_u64)
            .ok_or("Missing loyalty cursor")?;
        if page.is_empty() || next <= offset {
            return Err("Invalid loyalty cursor".into());
        }
        offset = next;
    }
    let after = loyalty_snapshot_version(&db).await?;
    if scope != loyalty_snapshot_scope(&db) {
        return Err("Loyalty snapshot identity changed".into());
    }
    if !loyalty_snapshot_revision_confirmed(&version, &after) {
        return Err("Loyalty revision could not be confirmed after snapshot".into());
    }
    let count = {
        let mut connection = db.conn.lock().map_err(|e| e.to_string())?;
        replace_loyalty_snapshot(&mut connection, &org_id, &customers)?
    };
    crate::write_local_json(
        &db,
        CUSTOMER_SNAPSHOT_KEY,
        &serde_json::json!({
            "scope": scope, "version": if version == after { after } else { None }, "complete": true
        }),
    )?;
    info!(count = count, org_id = %org_id, "Synced loyalty customers from admin");
    Ok(serde_json::json!({ "success": true, "count": count }))
}

/// Query locally cached loyalty customers with optional search filter.
#[tauri::command]
pub async fn loyalty_get_customers(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("loyalty_get_customers", move || {
        let db = app.state::<db::DbState>();
        let org_id = match get_organization_id(&db) {
            Some(id) => id,
            None => return Ok(serde_json::json!({ "customers": [] })),
        };

        let search = arg0
            .as_ref()
            .and_then(|v| value_str(v, &["search", "q", "query"]))
            .unwrap_or_default();

        let conn = db.conn.lock().map_err(|e| e.to_string())?;

        let customers: Vec<Value> = if search.is_empty() {
            let sql = format!(
                "{} WHERE organization_id = ?1
             ORDER BY points_balance DESC
",
                loyalty_customer_select_clause()
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("loyalty_get_customers prepare: {e}"))?;

            let rows = stmt
                .query_map(params![org_id], customer_row_to_json)
                .map_err(|e| format!("loyalty_get_customers query: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        } else {
            let pattern = format!("%{search}%");
            let sql = format!(
                "{} WHERE organization_id = ?1
               AND (customer_name LIKE ?2 OR customer_email LIKE ?2 OR customer_phone LIKE ?2)
             ORDER BY points_balance DESC
",
                loyalty_customer_select_clause()
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("loyalty_get_customers prepare: {e}"))?;

            let rows = stmt
                .query_map(params![org_id, pattern], customer_row_to_json)
                .map_err(|e| format!("loyalty_get_customers query: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };

        let complete = crate::db::get_setting(&conn, "local", CUSTOMER_SNAPSHOT_KEY)
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .is_some_and(|marker| {
                marker.pointer("/scope/0").and_then(Value::as_str) == Some(org_id.as_str())
                    && marker.get("complete") == Some(&Value::Bool(true))
            });
        if customers.is_empty() && !complete {
            let legacy_customers =
                legacy_loyalty_customers_from_local_cache(&db, &org_id, &search)?;
            if !legacy_customers.is_empty() {
                return Ok(serde_json::json!({ "customers": legacy_customers }));
            }
        }

        Ok(serde_json::json!({ "customers": customers }))
    })
    .await
}

/// Look up a single loyalty customer by canonical customer_id, with legacy
/// user_profile_id accepted as a compatibility alias.
#[tauri::command]
pub async fn loyalty_get_customer_balance(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("loyalty_get_customer_balance", move || {
        let db = app.state::<db::DbState>();
        let payload = arg0.unwrap_or(serde_json::json!({}));
        let customer_key = value_str(
            &payload,
            &["customerId", "customer_id", "user_profile_id", "id"],
        )
        .ok_or_else(|| "Missing customerId or user_profile_id".to_string())?;

        let org_id = match get_organization_id(&db) {
            Some(id) => id,
            None => return Ok(serde_json::json!({ "customer": null })),
        };

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let row = find_loyalty_customer_row(&conn, &org_id, &customer_key)?;

        Ok(serde_json::json!({ "customer": row }))
    })
    .await
}

/// Look up a loyalty customer by phone number.
#[tauri::command]
pub async fn loyalty_lookup_by_phone(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("loyalty_lookup_by_phone", move || {
        let db = app.state::<db::DbState>();
        let payload = arg0.unwrap_or(serde_json::json!({}));
        let phone = value_str(&payload, &["phone", "customerPhone", "mobile"])
            .ok_or_else(|| "Missing phone".to_string())?;

        let org_id = match get_organization_id(&db) {
            Some(id) => id,
            None => return Ok(serde_json::json!({ "customer": null })),
        };

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let sql = format!(
            "{} WHERE customer_phone = ?1 AND organization_id = ?2 LIMIT 1",
            loyalty_customer_select_clause()
        );
        let row: Option<Value> = conn
            .query_row(&sql, params![phone, org_id], customer_row_to_json)
            .optional()
            .map_err(|e| format!("loyalty_lookup_by_phone query: {e}"))?;

        Ok(serde_json::json!({ "customer": row }))
    })
    .await
}

/// Look up a loyalty customer by NFC/RFID card UID.
#[tauri::command]
pub async fn loyalty_lookup_by_card(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("loyalty_lookup_by_card", move || {
        let db = app.state::<db::DbState>();
        let payload = arg0.unwrap_or(serde_json::json!({}));
        let uid = value_str(
            &payload,
            &["uid", "card_uid", "cardUid", "loyalty_card_uid"],
        )
        .ok_or_else(|| "Missing uid or card_uid".to_string())?;

        let org_id = match get_organization_id(&db) {
            Some(id) => id,
            None => return Ok(serde_json::json!({ "success": false, "customer": null })),
        };

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let sql = format!(
            "{} WHERE loyalty_card_uid = ?1 AND organization_id = ?2 LIMIT 1",
            loyalty_customer_select_clause()
        );
        let row: Option<Value> = conn
            .query_row(&sql, params![uid, org_id], customer_row_to_json)
            .optional()
            .map_err(|e| format!("loyalty_lookup_by_card query: {e}"))?;

        let found = row.is_some();
        Ok(serde_json::json!({ "success": found, "customer": row }))
    })
    .await
}

/// Award points to a customer for an order. Creates a pending transaction
/// in loyalty_transactions and enqueues it for sync.
#[tauri::command]
pub async fn loyalty_earn_points(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("loyalty_earn_points", move || {
        let db = app.state::<db::DbState>();
        let payload = arg0.unwrap_or(serde_json::json!({}));
        let customer_key = value_str(&payload, &["customerId", "customer_id", "id"])
            .ok_or_else(|| "Missing customerId".to_string())?;
        let order_id = value_str(&payload, &["orderId", "order_id"]);
        let amount = value_f64(&payload, &["amount", "total", "orderTotal"])
            .ok_or_else(|| "Missing amount".to_string())?;

        let org_id =
            get_organization_id(&db).ok_or_else(|| "Organization not configured".to_string())?;

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let canonical_customer_id = resolve_loyalty_customer_lookup_key(&conn, &org_id, &customer_key)?;

        // Read loyalty settings to determine points_per_euro
        let points_per_euro: f64 = conn
            .query_row(
                "SELECT points_per_euro FROM loyalty_settings
             WHERE organization_id = ?1 LIMIT 1",
                params![org_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("loyalty_earn_points settings: {e}"))?
            .unwrap_or(1.0);

        let points_earned = (amount * points_per_euro).floor() as i64;
        if points_earned <= 0 {
            return Ok(serde_json::json!({
                "success": true,
                "pointsEarned": 0,
                "newBalance": 0
            }));
        }

        let tx_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let description = format!("Earned {} points for order", points_earned);
        // A full queue refuses the award before the ledger or the balance
        // changes (offline-week audit #3: its sync row used to be dropped, so
        // the server never heard of points the till had already credited).
        sync_queue::ensure_enqueue_capacity(&conn, 1)?;
        ensure_local_loyalty_customer_row(&conn, &org_id, &canonical_customer_id, &now)?;

        // Insert loyalty transaction
        conn.execute(
            "INSERT INTO loyalty_transactions (
            id, customer_id, organization_id, points, transaction_type,
            order_id, description, sync_state, created_at
        ) VALUES (?1, ?2, ?3, ?4, 'earn', ?5, ?6, 'pending', ?7)",
            params![
                tx_id,
                canonical_customer_id,
                org_id,
                points_earned,
                order_id,
                description,
                now
            ],
        )
        .map_err(|e| format!("loyalty_earn_points insert tx: {e}"))?;

        // Read tier thresholds for recalculation
        let (bronze, silver, gold, platinum) = conn
            .query_row(
                "SELECT tier_bronze_threshold, tier_silver_threshold,
                    tier_gold_threshold, tier_platinum_threshold
             FROM loyalty_settings WHERE organization_id = ?1 LIMIT 1",
                params![org_id],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(1)?.unwrap_or(500),
                        row.get::<_, Option<i64>>(2)?.unwrap_or(2000),
                        row.get::<_, Option<i64>>(3)?.unwrap_or(5000),
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("loyalty_earn_points thresholds: {e}"))?
            .unwrap_or((0, 500, 2000, 5000));

        // Update customer balance and recalculate tier
        conn.execute(
            "UPDATE loyalty_customers
         SET points_balance = points_balance + ?1,
             total_earned = total_earned + ?1,
             updated_at = ?2
         WHERE customer_id = ?3 AND organization_id = ?4",
            params![points_earned, now, canonical_customer_id, org_id],
        )
        .map_err(|e| format!("loyalty_earn_points update balance: {e}"))?;

        // Read new totals and recalculate tier
        let (new_balance, new_total_earned): (i64, i64) = conn
            .query_row(
                "SELECT points_balance, total_earned FROM loyalty_customers
             WHERE customer_id = ?1 AND organization_id = ?2",
                params![canonical_customer_id, org_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("loyalty_earn_points read balance: {e}"))?;

        let new_tier = calculate_tier(new_total_earned, bronze, silver, gold, platinum);
        conn.execute(
            "UPDATE loyalty_customers SET tier = ?1 WHERE customer_id = ?2 AND organization_id = ?3",
            params![new_tier, canonical_customer_id, org_id],
        )
        .map_err(|e| format!("loyalty_earn_points update tier: {e}"))?;

        // Wave 5 Session 6: enqueue via canonical parity queue. The parity
        // dispatcher's `prepare_loyalty_request` reads `transaction_type` from
        // this payload to route between `/api/pos/loyalty/earn` and
        // `/api/pos/loyalty/redeem` and reshapes the body accordingly —
        // wire-identical to the legacy `sync_loyalty_transaction` drain.
        // `loyalty_transactions` is NOT in v47, so idempotency falls back to
        // the deterministic synthetic `entity:loyalty_transactions:{tx_id}`.
        let sync_payload = serde_json::json!({
            "id": tx_id,
            "customer_id": canonical_customer_id,
            "organization_id": org_id,
            "points": points_earned,
            "amount": amount,
            "transaction_type": "earn",
            "order_id": order_id,
            "description": description,
            "created_at": now,
        });
        sync_queue::enqueue_payload_item(
            &conn,
            "loyalty_transactions",
            &tx_id,
            "INSERT",
            &sync_payload,
            Some(1),
            Some("loyalty"),
            Some("manual"),
            Some(1),
        )
        .map_err(|e| format!("loyalty_earn_points enqueue: {e}"))?;

        info!(
            customer_id = %canonical_customer_id,
            points_earned = points_earned,
            new_balance = new_balance,
            "Loyalty points earned"
        );

        Ok(serde_json::json!({
            "success": true,
            "pointsEarned": points_earned,
            "newBalance": new_balance
        }))
    })
    .await
}

/// Debit a local loyalty balance only while it still covers the redemption. Returns
/// `false` (and changes nothing) when the balance is insufficient, so a concurrent or
/// replayed redemption can never drive the balance negative.
fn debit_local_loyalty_balance(
    conn: &rusqlite::Connection,
    org_id: &str,
    customer_id: &str,
    points: i64,
    now: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE loyalty_customers
             SET points_balance = points_balance - ?1,
                 total_redeemed = total_redeemed + ?1,
                 updated_at = ?2
             WHERE customer_id = ?3
               AND organization_id = ?4
               AND points_balance >= ?1",
            params![points, now, customer_id, org_id],
        )
        .map_err(|e| format!("loyalty_redeem_points update balance: {e}"))?;
    Ok(changed == 1)
}

/// Called inside the owning transaction. The marker makes balance compensation
/// idempotent while retaining the original local ledger evidence.
pub(crate) fn reverse_local_loyalty_transaction(
    conn: &rusqlite::Connection,
    org_id: &str,
    tx_id: &str,
) -> Result<bool, String> {
    let original: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT customer_id, points, transaction_type FROM loyalty_transactions
         WHERE id = ?1 AND organization_id = ?2
           AND COALESCE(sync_last_error, '') != 'LOYALTY_LOCAL_REVERSED'",
            params![tx_id, org_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("loyalty reversal read: {e}"))?;
    let Some((customer_id, points, tx_type)) = original else {
        return Ok(false);
    };
    let changed = conn
        .execute(
            "UPDATE loyalty_customers SET points_balance = points_balance - ?1,
         total_redeemed = MAX(0, total_redeemed - ?2),
         total_earned = MAX(0, total_earned - ?3), updated_at = ?4
         WHERE customer_id = ?5 AND organization_id = ?6",
            params![
                points,
                if tx_type == "redeem" { -points } else { 0 },
                if tx_type == "earn" { points } else { 0 },
                Utc::now().to_rfc3339(),
                customer_id,
                org_id
            ],
        )
        .map_err(|e| format!("loyalty reversal balance: {e}"))?;
    if changed != 1 {
        return Err("Loyalty reversal customer missing".into());
    }
    if tx_type == "earn" {
        conn.execute(
            "UPDATE loyalty_customers SET tier = CASE
             WHEN total_earned >= COALESCE((SELECT tier_platinum_threshold FROM loyalty_settings WHERE organization_id = ?1), 5000) THEN 'platinum'
             WHEN total_earned >= COALESCE((SELECT tier_gold_threshold FROM loyalty_settings WHERE organization_id = ?1), 2000) THEN 'gold'
             WHEN total_earned >= COALESCE((SELECT tier_silver_threshold FROM loyalty_settings WHERE organization_id = ?1), 500) THEN 'silver'
             WHEN total_earned >= COALESCE((SELECT tier_bronze_threshold FROM loyalty_settings WHERE organization_id = ?1), 0) THEN 'bronze'
             ELSE 'none' END WHERE organization_id = ?1 AND customer_id = ?2",
            params![org_id, customer_id],
        ).map_err(|e| format!("loyalty reversal tier: {e}"))?;
    }
    conn.execute(
        "UPDATE loyalty_transactions SET sync_state = 'applied', sync_last_error = 'LOYALTY_LOCAL_REVERSED'
         WHERE id = ?1 AND organization_id = ?2", params![tx_id, org_id],
    ).map_err(|e| format!("loyalty reversal ledger: {e}"))?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Checkout redemption: debited live on the server (Ω11, 22/10/2026)
//
// Founder rule: points are EARNED offline (queued, above) but REDEEMED only
// with a live server answer. Before, the desktop debited its cached balance,
// queued the debit and answered success with no server contact, so a customer
// could spend the same points on two offline tills for days (Android already
// refused). Now the attempt is written down, the debit is POSTed outside any
// database lock, and its outcome is recorded:
// - confirmed: the row is `applied` and the cached balance follows;
// - not sent (no connection, terminal not configured): `LOYALTY_REDEEM_OFFLINE`;
// - refused by the server: `LOYALTY_REDEEM_REFUSED`;
// - sent with no definitive answer: `LOYALTY_REDEEM_UNCONFIRMED`. The attempt
//   stays `syncing`; Retry sends the same checkout key and the server's replay
//   tells the truth. Only removing the points releases it.
// The sale is never blocked: without points it continues as a normal sale.
// ---------------------------------------------------------------------------

/// Not sent: no connection, or the terminal cannot reach its server. Nothing
/// was debited; the sale continues without the discount.
pub(crate) const LOYALTY_REDEEM_OFFLINE: &str = "LOYALTY_REDEEM_OFFLINE";
/// Refused (by the server, or because this checkout's redemption was already
/// released). Nothing was debited.
pub(crate) const LOYALTY_REDEEM_REFUSED: &str = "LOYALTY_REDEEM_REFUSED";
/// Sent without a definitive answer. The attempt is kept for Retry.
pub(crate) const LOYALTY_REDEEM_UNCONFIRMED: &str = "LOYALTY_REDEEM_UNCONFIRMED";
/// Server (and local) reason: this checkout's redemption was released, so the
/// same checkout cannot redeem again; a new sale can.
pub(crate) const LOYALTY_REDEMPTION_RELEASED: &str = "LOYALTY_REDEMPTION_RELEASED";
/// Server reason: an order owns this checkout's redemption, so it is not
/// released; cancelling the order returns the points.
pub(crate) const LOYALTY_ORDER_EXISTS: &str = "LOYALTY_ORDER_EXISTS";
/// Server reason: the checkout's redemption belongs to another customer.
pub(crate) const LOYALTY_RELEASE_CUSTOMER_MISMATCH: &str = "LOYALTY_RELEASE_CUSTOMER_MISMATCH";
const REDEEM_PATH: &str = "/api/pos/loyalty/redeem";
/// Returns a checkout's live redemption that never became an order.
pub(crate) const REDEEM_RELEASE_PATH: &str = "/api/pos/loyalty/redeem/release";
/// The cashier waits on this answer at the till.
const LIVE_REDEEM_TIMEOUT: Duration = Duration::from_secs(15);

/// One redemption request from the renderer.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RedeemRequest {
    customer_key: String,
    points: i64,
    /// The checkout identity (`clientRequestId`), the server's per-order key.
    order_id: Option<String>,
}

fn parse_redeem_request(payload: &Value) -> Result<RedeemRequest, String> {
    let customer_key = value_str(payload, &["customerId", "customer_id", "id"])
        .ok_or_else(|| "Missing customerId".to_string())?;
    let points = payload
        .get("points")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "Missing points".to_string())?;
    let order_id = value_str(payload, &["orderId", "order_id"])
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let checkout_reservation = payload
        .get("checkoutReservation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if checkout_reservation && order_id.is_none() {
        return Err("Missing checkout identity".into());
    }
    if points <= 0 {
        return Err("Points to redeem must be positive".into());
    }
    Ok(RedeemRequest {
        customer_key,
        points,
        order_id,
    })
}

/// A live redemption, written down (`syncing`) before it is sent.
#[derive(Clone, Debug, PartialEq)]
struct RedeemAttempt {
    tx_id: String,
    org_id: String,
    customer_id: String,
    points: i64,
    order_id: Option<String>,
    description: String,
    discount_value: f64,
}

impl RedeemAttempt {
    /// The `/api/pos/loyalty/redeem` body. The server keys the debit on
    /// `order_redeem:<order_id>`, so a Retry replays instead of debiting again;
    /// the row key only anchors an order-less redemption.
    fn body(&self) -> Value {
        let mut body = serde_json::json!({
            "customer_id": self.customer_id,
            "points": self.points,
            "description": self.description,
            "idempotency_key": format!("loyalty:{}", self.tx_id),
        });
        if let Some(order_id) = &self.order_id {
            body["order_id"] = Value::String(order_id.clone());
        }
        body
    }
}

#[derive(Clone, Debug, PartialEq)]
enum RedeemPreparation {
    /// Answered here: a confirmed redemption replayed, or a typed refusal.
    Answered(Value),
    Send(RedeemAttempt),
}

/// What the live POST proved.
#[derive(Clone, Debug, PartialEq, Eq)]
enum LiveRedeemOutcome {
    Confirmed {
        already_redeemed: bool,
    },
    /// A definitive refusal; `reason` is the server's code or `HTTP_<status>`.
    Refused {
        reason: String,
    },
    /// The request never left this till.
    NotSent,
    /// Sent, and no definitive answer came back.
    Unconfirmed,
}

/// A typed `{success:false}` answer the renderer turns into its own message.
fn redeem_answer(code: &str, reason: Option<&str>, message: &str) -> Value {
    serde_json::json!({
        "success": false,
        "errorCode": code,
        "reason": reason,
        "error": message,
    })
}

fn redeem_offline_answer() -> Value {
    redeem_answer(
        LOYALTY_REDEEM_OFFLINE,
        None,
        "Points can only be redeemed with an internet connection",
    )
}

fn redeem_released_answer() -> Value {
    redeem_answer(
        LOYALTY_REDEEM_REFUSED,
        Some(LOYALTY_REDEMPTION_RELEASED),
        "This checkout's points redemption was released; start a new sale to redeem again",
    )
}

/// Local checks (a fast pre-check, not the guard: the server's row lock is),
/// then the attempt row. A confirmed redemption of this checkout is answered
/// without a second debit; an unanswered one is sent again under its key.
fn prepare_live_redemption(
    conn: &rusqlite::Connection,
    org_id: &str,
    request: &RedeemRequest,
    now: &str,
) -> Result<RedeemPreparation, String> {
    let points = request.points;
    let canonical_customer_id =
        resolve_loyalty_customer_lookup_key(conn, org_id, &request.customer_key)?;

    let (is_active, min_redemption, redemption_rate): (bool, i64, f64) = conn
        .query_row(
            "SELECT is_active, min_redemption_points, redemption_rate
             FROM loyalty_settings WHERE organization_id = ?1 LIMIT 1",
            params![org_id],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("loyalty_redeem_points settings: {e}"))?
        .unwrap_or((false, 100, 0.01));
    if !is_active {
        return Err("Loyalty program is not active".into());
    }
    if points < min_redemption {
        return Err(format!(
            "Minimum redemption is {min_redemption} points, requested {points}"
        ));
    }

    let current_balance: i64 = conn
        .query_row(
            "SELECT points_balance FROM loyalty_customers
             WHERE customer_id = ?1 AND organization_id = ?2",
            params![canonical_customer_id, org_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("loyalty_redeem_points balance: {e}"))?
        .ok_or_else(|| "Customer not found".to_string())?;

    let mut retry_tx_id = None;
    if let Some(order_id) = request.order_id.as_deref() {
        // A released checkout never redeems again: the server refuses it, and
        // a release still queued would return the new debit too.
        let released: bool = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM loyalty_transactions
                     WHERE customer_id = ?1 AND organization_id = ?2 AND order_id = ?3
                       AND transaction_type = 'redeem'
                       AND COALESCE(sync_last_error, '') = 'LOYALTY_LOCAL_REVERSED')",
                params![canonical_customer_id, org_id, order_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("loyalty_redeem_points released tx: {e}"))?;
        if released {
            return Ok(RedeemPreparation::Answered(redeem_released_answer()));
        }

        let existing: Option<(i64, String, String)> = conn
            .query_row(
                "SELECT ABS(points), id, sync_state
                 FROM loyalty_transactions
                 WHERE customer_id = ?1
                   AND organization_id = ?2
                   AND order_id = ?3
                   AND transaction_type = 'redeem'
                   AND COALESCE(sync_last_error, '') != 'LOYALTY_LOCAL_REVERSED'
                 ORDER BY created_at ASC
                 LIMIT 1",
                params![canonical_customer_id, org_id, order_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("loyalty_redeem_points existing tx: {e}"))?;
        if let Some((existing_points, existing_tx_id, sync_state)) = existing {
            if existing_points != points {
                return Err(format!(
                    "Loyalty redemption already exists for this order with {existing_points} points"
                ));
            }
            if sync_state != "syncing" {
                // Confirmed by the server, or a reservation queued before
                // 22/10/2026 that its own queue row still sends.
                return Ok(RedeemPreparation::Answered(serde_json::json!({
                    "success": true,
                    "alreadyRedeemed": true,
                    "transactionId": existing_tx_id,
                    "pointsRedeemed": existing_points,
                    "discountValue": (existing_points as f64) * redemption_rate,
                    "newBalance": current_balance
                })));
            }
            retry_tx_id = Some(existing_tx_id);
        }
    }

    if current_balance < points {
        return Err(format!(
            "Insufficient balance: have {current_balance}, need {points}"
        ));
    }

    let discount_value = (points as f64) * redemption_rate;
    let description = format!(
        "Redeemed {} points for {:.2} discount",
        points, discount_value
    );
    let tx_id = match retry_tx_id {
        Some(tx_id) => {
            conn.execute(
                "UPDATE loyalty_transactions SET sync_retry_count = sync_retry_count + 1
                 WHERE id = ?1 AND organization_id = ?2",
                params![tx_id, org_id],
            )
            .map_err(|e| format!("loyalty_redeem_points retry tx: {e}"))?;
            tx_id
        }
        None => {
            let tx_id = Uuid::new_v4().to_string();
            // No balance debit and no queue row: only the server's answer
            // turns this attempt into a redemption.
            conn.execute(
                "INSERT INTO loyalty_transactions (
                    id, customer_id, organization_id, points, transaction_type,
                    order_id, description, sync_state, created_at
                ) VALUES (?1, ?2, ?3, ?4, 'redeem', ?5, ?6, 'syncing', ?7)",
                params![
                    tx_id,
                    canonical_customer_id,
                    org_id,
                    -points,
                    request.order_id,
                    description,
                    now
                ],
            )
            .map_err(|e| format!("loyalty_redeem_points insert tx: {e}"))?;
            tx_id
        }
    };

    Ok(RedeemPreparation::Send(RedeemAttempt {
        tx_id,
        org_id: org_id.to_string(),
        customer_id: canonical_customer_id,
        points,
        order_id: request.order_id.clone(),
        description,
        discount_value,
    }))
}

/// A 2xx with `success:true` confirms; anything else is classified by what
/// it proves about the debit, never by its display text.
fn classify_live_redeem(result: Result<Value, crate::api::AdminFetchError>) -> LiveRedeemOutcome {
    match result {
        Ok(body) if body.get("success").and_then(Value::as_bool) == Some(true) => {
            LiveRedeemOutcome::Confirmed {
                already_redeemed: body
                    .get("already_redeemed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        }
        Ok(_) => LiveRedeemOutcome::Unconfirmed,
        Err(error) => classify_redeem_error(&error),
    }
}

fn classify_redeem_error(error: &crate::api::AdminFetchError) -> LiveRedeemOutcome {
    // Never sent: the connection could not be opened, or the terminal's
    // endpoint could not be resolved.
    if error.is_connect_failure() || error.renderer_endpoint_error_code().is_some() {
        return LiveRedeemOutcome::NotSent;
    }
    match error.status() {
        // A timeout or a rate limit: Retry, the server's replay decides.
        Some(408 | 429) => LiveRedeemOutcome::Unconfirmed,
        // Validation, balance, a different or released redemption, an ended
        // order, an unknown customer, refused credentials or module: the RPC
        // never committed a debit.
        Some(status) if (400..500).contains(&status) => LiveRedeemOutcome::Refused {
            reason: error
                .code()
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP_{status}")),
        },
        // 5xx, a timeout, a lost reply or an unreadable answer.
        _ => LiveRedeemOutcome::Unconfirmed,
    }
}

async fn send_live_redemption(attempt: &RedeemAttempt) -> LiveRedeemOutcome {
    classify_live_redeem(
        crate::admin_fetch_detailed_with_timeout(
            None,
            REDEEM_PATH,
            "POST",
            Some(attempt.body()),
            LIVE_REDEEM_TIMEOUT,
        )
        .await,
    )
}

/// The success answer for a confirmed attempt, with the cached balance.
fn confirmed_redeem_answer(
    conn: &rusqlite::Connection,
    attempt: &RedeemAttempt,
    already_redeemed: bool,
) -> Result<Value, String> {
    let new_balance: i64 = conn
        .query_row(
            "SELECT points_balance FROM loyalty_customers
             WHERE customer_id = ?1 AND organization_id = ?2",
            params![attempt.customer_id, attempt.org_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("loyalty_redeem_points read balance: {e}"))?
        .unwrap_or(0);
    Ok(serde_json::json!({
        "success": true,
        "alreadyRedeemed": already_redeemed,
        "transactionId": attempt.tx_id,
        "pointsRedeemed": attempt.points,
        "discountValue": attempt.discount_value,
        "newBalance": new_balance
    }))
}

/// Record the server's answer on the attempt row, in one transaction. The
/// answer follows the ledger: a checkout released meanwhile answers released,
/// one another request confirmed meanwhile answers confirmed.
fn record_live_redemption(
    conn: &rusqlite::Connection,
    attempt: &RedeemAttempt,
    outcome: &LiveRedeemOutcome,
    now: &str,
) -> Result<Value, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("loyalty_redeem_points begin: {e}"))?;
    let recorded = (|| -> Result<Value, String> {
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT sync_state, sync_last_error FROM loyalty_transactions
                 WHERE id = ?1 AND organization_id = ?2",
                params![attempt.tx_id, attempt.org_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("loyalty_redeem_points attempt: {e}"))?;
        let reversed = matches!(&row, Some((_, error))
            if error.as_deref() == Some("LOYALTY_LOCAL_REVERSED"));
        if reversed {
            // Released while the request was in flight and the server still
            // debited it: one more release makes sure it is returned (the
            // server answers a repeated release as already released).
            if matches!(outcome, LiveRedeemOutcome::Confirmed { .. }) {
                enqueue_redemption_release(conn, &CheckoutRelease::of(attempt), now)?;
            }
            return Ok(redeem_released_answer());
        }
        if matches!(&row, Some((state, _)) if state == "applied") {
            return confirmed_redeem_answer(conn, attempt, true);
        }
        let open = row.is_some();
        match outcome {
            LiveRedeemOutcome::Confirmed { already_redeemed } => {
                if !open {
                    // The server holds the debit, so the ledger must say so.
                    conn.execute(
                        "INSERT INTO loyalty_transactions (
                            id, customer_id, organization_id, points, transaction_type,
                            order_id, description, sync_state, created_at
                        ) VALUES (?1, ?2, ?3, ?4, 'redeem', ?5, ?6, 'syncing', ?7)",
                        params![
                            attempt.tx_id,
                            attempt.customer_id,
                            attempt.org_id,
                            -attempt.points,
                            attempt.order_id,
                            attempt.description,
                            now
                        ],
                    )
                    .map_err(|e| format!("loyalty_redeem_points restore attempt: {e}"))?;
                }
                conn.execute(
                    "UPDATE loyalty_transactions SET sync_state = 'applied', sync_last_error = NULL
                     WHERE id = ?1 AND organization_id = ?2",
                    params![attempt.tx_id, attempt.org_id],
                )
                .map_err(|e| format!("loyalty_redeem_points applied: {e}"))?;
                // The cached balance follows the server's debit. A stale cache
                // lower than the debit stops at zero; the next snapshot corrects it.
                if !debit_local_loyalty_balance(
                    conn,
                    &attempt.org_id,
                    &attempt.customer_id,
                    attempt.points,
                    now,
                )? {
                    conn.execute(
                        "UPDATE loyalty_customers
                         SET points_balance = MAX(0, points_balance - ?1),
                             total_redeemed = total_redeemed + ?1,
                             updated_at = ?2
                         WHERE customer_id = ?3 AND organization_id = ?4",
                        params![attempt.points, now, attempt.customer_id, attempt.org_id],
                    )
                    .map_err(|e| format!("loyalty_redeem_points update balance: {e}"))?;
                }
                confirmed_redeem_answer(conn, attempt, *already_redeemed)
            }
            LiveRedeemOutcome::Refused { reason } => {
                // Nothing was debited, a released checkout included (the
                // server's tombstone answers every later attempt).
                if open {
                    delete_redeem_attempt(conn, attempt)?;
                }
                if reason == LOYALTY_REDEMPTION_RELEASED {
                    return Ok(redeem_released_answer());
                }
                Ok(redeem_answer(
                    LOYALTY_REDEEM_REFUSED,
                    Some(reason.as_str()),
                    "The server refused the points redemption; no discount was applied",
                ))
            }
            LiveRedeemOutcome::NotSent => {
                if open {
                    delete_redeem_attempt(conn, attempt)?;
                }
                Ok(redeem_offline_answer())
            }
            LiveRedeemOutcome::Unconfirmed => {
                if open {
                    conn.execute(
                        "UPDATE loyalty_transactions SET sync_last_error = ?3
                         WHERE id = ?1 AND organization_id = ?2",
                        params![attempt.tx_id, attempt.org_id, LOYALTY_REDEEM_UNCONFIRMED],
                    )
                    .map_err(|e| format!("loyalty_redeem_points unconfirmed: {e}"))?;
                }
                Ok(redeem_answer(
                    LOYALTY_REDEEM_UNCONFIRMED,
                    None,
                    "The server did not confirm the points redemption; retry or remove the points",
                ))
            }
        }
    })();
    match recorded {
        Ok(answer) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("loyalty_redeem_points commit: {e}"))?;
            Ok(answer)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// An attempt the server never debited leaves no ledger row.
fn delete_redeem_attempt(
    conn: &rusqlite::Connection,
    attempt: &RedeemAttempt,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM loyalty_transactions
         WHERE id = ?1 AND organization_id = ?2 AND sync_state = 'syncing'",
        params![attempt.tx_id, attempt.org_id],
    )
    .map(|_| ())
    .map_err(|e| format!("loyalty_redeem_points delete attempt: {e}"))
}

/// A checkout's live redemption to return on the server.
#[derive(Clone, Debug, PartialEq, Eq)]
struct CheckoutRelease {
    tx_id: String,
    org_id: String,
    customer_id: String,
    order_id: String,
    points: i64,
}

impl CheckoutRelease {
    fn of(attempt: &RedeemAttempt) -> Self {
        Self {
            tx_id: attempt.tx_id.clone(),
            org_id: attempt.org_id.clone(),
            customer_id: attempt.customer_id.clone(),
            order_id: attempt.order_id.clone().unwrap_or_default(),
            points: attempt.points,
        }
    }

    /// The `/api/pos/loyalty/redeem/release` body.
    fn body(&self) -> Value {
        serde_json::json!({
            "order_id": self.order_id,
            "customer_id": self.customer_id,
        })
    }
}

/// Server answers that settle a release for good: an order owns the
/// redemption (its cancellation returns the points), or the checkout's
/// redemption belongs to another customer (it cannot be this one's).
fn release_refusal_is_final(code: Option<&str>) -> bool {
    matches!(
        code,
        Some(LOYALTY_ORDER_EXISTS | LOYALTY_RELEASE_CUSTOMER_MISMATCH)
    )
}

/// The durable RELEASE op (`transaction_type: release`) the parity queue
/// sends to [`REDEEM_RELEASE_PATH`] (`sync_queue::prepare_loyalty_request`).
/// `DELETE` is the queue's operation for a retraction. Priority 2 sends it
/// ahead of an order saved later under the same checkout: once that order
/// reached the server, the server would keep the debit with it.
fn enqueue_redemption_release(
    conn: &rusqlite::Connection,
    release: &CheckoutRelease,
    now: &str,
) -> Result<String, String> {
    let payload = serde_json::json!({
        "id": release.tx_id,
        "transaction_type": "release",
        "customer_id": release.customer_id,
        "organization_id": release.org_id,
        "order_id": release.order_id,
        "points": -release.points,
        "created_at": now,
    });
    sync_queue::enqueue_payload_item(
        conn,
        "loyalty_transactions",
        &release.tx_id,
        "DELETE",
        &payload,
        Some(2),
        Some("loyalty"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("loyalty release enqueue: {e}"))
}

/// Release the checkout's redemption on this till, in one transaction, and
/// answer what the server must still return. A reservation queued before
/// 22/10/2026 never reached the server: reversing it and removing its queue
/// row is the whole release. A live redemption (`applied`, or `syncing` with
/// no answer) gets its cached balance back at once (only an `applied` one was
/// ever debited here) and a durable RELEASE op; the caller then tries the
/// server live. An order saved under the checkout keeps its debit.
fn release_checkout_redemption(
    conn: &rusqlite::Connection,
    org_id: &str,
    checkout_id: &str,
) -> Result<Vec<CheckoutRelease>, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<Vec<CheckoutRelease>, String> {
        // A lost save acknowledgement must never release a persisted sale's debit.
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM orders WHERE organization_id = ?1 AND (id = ?2 OR client_request_id = ?2))",
            params![org_id, checkout_id], |row| row.get(0),
        ).map_err(|e| format!("loyalty release order: {e}"))?;
        if exists {
            return Ok(Vec::new());
        }
        let mut stmt = conn
            .prepare(
                "SELECT id FROM loyalty_transactions WHERE organization_id = ?1 AND order_id = ?2
             AND transaction_type = 'redeem' AND sync_state = 'pending'
             AND COALESCE(sync_last_error, '') != 'LOYALTY_LOCAL_REVERSED'",
            )
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params![org_id, checkout_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for id in ids {
            // Only checkout reservations wait locally before an order exists.
            let reserved: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE table_name = 'loyalty_transactions'
                 AND record_id = ?1 AND organization_id = ?2 AND json_extract(data, '$.checkout_reservation') = 1)",
                params![id, org_id], |row| row.get(0),
            ).map_err(|e| e.to_string())?;
            if !reserved {
                return Err("Loyalty redemption is not a checkout reservation".into());
            }
            reverse_local_loyalty_transaction(conn, org_id, &id)?;
            conn.execute("DELETE FROM parity_sync_queue WHERE table_name = 'loyalty_transactions' AND record_id = ?1 AND organization_id = ?2", params![id, org_id])
                .map_err(|e| e.to_string())?;
        }

        let mut live = conn
            .prepare(
                "SELECT id, customer_id, sync_state, ABS(points) FROM loyalty_transactions
                 WHERE organization_id = ?1 AND order_id = ?2 AND transaction_type = 'redeem'
                   AND sync_state IN ('applied', 'syncing')
                   AND COALESCE(sync_last_error, '') != 'LOYALTY_LOCAL_REVERSED'",
            )
            .map_err(|e| e.to_string())?;
        let rows = live
            .query_map(params![org_id, checkout_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        let mut releases = Vec::new();
        // An unanswered request that reaches the server after its release
        // meets the release's tombstone and debits nothing (W7b, 409
        // `LOYALTY_REDEMPTION_RELEASED`), so both kinds are released at once.
        for (tx_id, customer_id, sync_state, points) in rows {
            if sync_state == "applied" {
                reverse_local_loyalty_transaction(conn, org_id, &tx_id)?;
            }
            // `pending` until the server returns the points (the RELEASE op's
            // success marks it applied); a loyalty snapshot waits meanwhile.
            conn.execute(
                "UPDATE loyalty_transactions
                 SET sync_state = 'pending', sync_last_error = 'LOYALTY_LOCAL_REVERSED'
                 WHERE id = ?1 AND organization_id = ?2",
                params![tx_id, org_id],
            )
            .map_err(|e| format!("loyalty release ledger: {e}"))?;
            let release = CheckoutRelease {
                tx_id,
                org_id: org_id.to_string(),
                customer_id,
                order_id: checkout_id.to_string(),
                points,
            };
            enqueue_redemption_release(conn, &release, &now)?;
            releases.push(release);
        }
        Ok(releases)
    })();
    match result {
        Ok(releases) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(releases)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Did the server settle this release? Any 200 (returned, already returned,
/// nothing to return) or a final refusal ([`release_refusal_is_final`]).
/// Anything else leaves the queued op to send it again.
async fn send_live_release(release: &CheckoutRelease) -> bool {
    match crate::admin_fetch_detailed_with_timeout(
        None,
        REDEEM_RELEASE_PATH,
        "POST",
        Some(release.body()),
        LIVE_REDEEM_TIMEOUT,
    )
    .await
    {
        Ok(_) => true,
        Err(error) => error.status() == Some(409) && release_refusal_is_final(error.code()),
    }
}

/// The server answered the live release: its queued op is no longer needed.
/// An op the queue has already claimed is left to finish and mark the row.
fn settle_live_release(
    conn: &rusqlite::Connection,
    release: &CheckoutRelease,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        // Only this redemption's RELEASE ops that no worker has claimed and no
        // manager set aside.
        conn.execute(
            &format!(
                "DELETE FROM parity_sync_queue
                 WHERE table_name = 'loyalty_transactions' AND record_id = ?1
                   AND organization_id = ?2 AND operation = 'DELETE'
                   AND status IN ('pending', 'failed')
                   AND {}",
                sync_queue::set_aside_exclusion_sql("parity_sync_queue")
            ),
            params![release.tx_id, release.org_id],
        )
        .map_err(|e| format!("loyalty release queue: {e}"))?;
        let queued: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM parity_sync_queue
                 WHERE table_name = 'loyalty_transactions' AND record_id = ?1)",
                params![release.tx_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("loyalty release queue: {e}"))?;
        if !queued {
            conn.execute(
                "UPDATE loyalty_transactions SET sync_state = 'applied'
                 WHERE id = ?1 AND organization_id = ?2
                   AND sync_last_error = 'LOYALTY_LOCAL_REVERSED'",
                params![release.tx_id, release.org_id],
            )
            .map_err(|e| format!("loyalty release settled: {e}"))?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Release a checkout's points redemption (remove the points, leave payment,
/// discard the cart). The local balance returns at once; the server release
/// is tried live and otherwise stays queued. Answers `{success}` as before.
#[tauri::command]
pub async fn loyalty_release_redemption(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let order_id = value_str(&payload, &["orderId", "order_id"]).ok_or("Missing orderId")?;
    let release_app = app.clone();
    let (releases, rebind_pending) = run_blocking_command(
        "loyalty_release_redemption",
        move || -> Result<(Vec<CheckoutRelease>, bool), String> {
            let db = release_app.state::<db::DbState>();
            let org_id = get_organization_id(&db).ok_or("Organization not configured")?;
            let rebind_pending =
                crate::commands::settings::terminal_connection_rebind_pending_fail_closed_public(
                    &db,
                );
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            Ok((
                release_checkout_redemption(&conn, &org_id, &order_id)?,
                rebind_pending,
            ))
        },
    )
    .await?;

    // The server call runs with no database lock held.
    let mut queued = false;
    for release in releases {
        if rebind_pending || !send_live_release(&release).await {
            queued = true;
            continue;
        }
        let settle_app = app.clone();
        run_blocking_command(
            "loyalty_release_redemption",
            move || -> Result<(), String> {
                let db = settle_app.state::<db::DbState>();
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                settle_live_release(&conn, &release)
            },
        )
        .await?;
    }
    Ok(serde_json::json!({ "success": true, "releaseQueued": queued }))
}

/// Redeem points for a checkout discount, with a live server answer (Ω11).
/// Answers `{success:true, ...}`, or `{success:false, errorCode}` with one of
/// the typed codes above; a malformed request or a failed local check is an
/// error as before.
#[tauri::command]
pub async fn loyalty_redeem_points(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let request = parse_redeem_request(&payload)?;

    // 1. Local checks and the attempt row.
    let prepare_app = app.clone();
    let prepared = run_blocking_command(
        "loyalty_redeem_points",
        move || -> Result<RedeemPreparation, String> {
            let db = prepare_app.state::<db::DbState>();
            let org_id = get_organization_id(&db)
                .ok_or_else(|| "Organization not configured".to_string())?;
            if crate::commands::settings::terminal_connection_rebind_pending_fail_closed_public(&db)
            {
                return Ok(RedeemPreparation::Answered(redeem_offline_answer()));
            }
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            prepare_live_redemption(&conn, &org_id, &request, &Utc::now().to_rfc3339())
        },
    )
    .await?;
    let attempt = match prepared {
        RedeemPreparation::Answered(answer) => return Ok(answer),
        RedeemPreparation::Send(attempt) => attempt,
    };

    // 2. The live debit, awaited with no database lock held.
    let outcome = send_live_redemption(&attempt).await;

    // 3. The outcome.
    run_blocking_command("loyalty_redeem_points", move || -> Result<Value, String> {
        let db = app.state::<db::DbState>();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let answer = record_live_redemption(&conn, &attempt, &outcome, &Utc::now().to_rfc3339())?;
        info!(
            customer_id = %attempt.customer_id,
            points = attempt.points,
            outcome = ?outcome,
            "Loyalty checkout redemption answered"
        );
        Ok(answer)
    })
    .await
}

/// List recent loyalty transactions for a specific customer.
#[tauri::command]
pub async fn loyalty_get_transactions(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("loyalty_get_transactions", move || {
        let db = app.state::<db::DbState>();
        let payload = arg0.unwrap_or(serde_json::json!({}));
        let customer_key = value_str(&payload, &["customerId", "customer_id", "id"])
            .ok_or_else(|| "Missing customerId or customer_id".to_string())?;
        let org_id = match get_organization_id(&db) {
            Some(id) => id,
            None => return Ok(serde_json::json!({ "transactions": [] })),
        };

        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let canonical_customer_id =
            resolve_loyalty_customer_lookup_key(&conn, &org_id, &customer_key)?;

        let mut stmt = conn
            .prepare(
                "SELECT id, customer_id, organization_id, points, transaction_type,
                    order_id, description, sync_state, created_at
             FROM loyalty_transactions
             WHERE organization_id = ?1
               AND (
                 customer_id = ?2
                 OR (?3 IS NOT NULL AND customer_id = ?3)
               )
             ORDER BY created_at DESC
             LIMIT 50",
            )
            .map_err(|e| format!("loyalty_get_transactions prepare: {e}"))?;

        let transactions: Vec<Value> = stmt
            .query_map(
                params![org_id, canonical_customer_id, Some(customer_key)],
                transaction_row_to_json,
            )
            .map_err(|e| format!("loyalty_get_transactions query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(serde_json::json!({ "transactions": transactions }))
    })
    .await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn snapshot_known_revision_requires_post_fetch_confirmation() {
        let known = Some("1".to_string());
        assert!(loyalty_snapshot_revision_confirmed(&known, &known));
        assert!(!loyalty_snapshot_revision_confirmed(&known, &None));
        assert!(!loyalty_snapshot_revision_confirmed(
            &known,
            &Some("2".to_string())
        ));
        assert!(loyalty_snapshot_revision_confirmed(&None, &None));
    }

    fn checkout_redemption_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        sync_queue::create_tables(&conn).unwrap();
        conn.execute_batch("INSERT INTO loyalty_customers (id, user_profile_id, customer_id, organization_id, points_balance, total_redeemed)
            VALUES ('balance', 'profile-1', 'customer-1', 'org-1', 20, 100);
            INSERT INTO loyalty_transactions (id, customer_id, organization_id, points, transaction_type, order_id)
            VALUES ('redemption', 'customer-1', 'org-1', -100, 'redeem', 'checkout-1');
            INSERT INTO parity_sync_queue (id, table_name, record_id, operation, data, organization_id)
            VALUES ('redemption-queue', 'loyalty_transactions', 'redemption', 'INSERT',
                '{\"checkout_reservation\":true}', 'org-1');").unwrap();
        conn
    }

    #[test]
    fn checkout_redemption_release_is_idempotent_and_org_scoped() {
        let conn = checkout_redemption_connection();
        release_checkout_redemption(&conn, "other-org", "checkout-1").unwrap();
        assert_eq!(
            conn.query_row("SELECT points_balance FROM loyalty_customers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            20
        );
        release_checkout_redemption(&conn, "org-1", "checkout-1").unwrap();
        release_checkout_redemption(&conn, "org-1", "checkout-1").unwrap();
        assert_eq!(
            conn.query_row("SELECT points_balance FROM loyalty_customers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            120
        );
        assert_eq!(
            conn.query_row("SELECT total_redeemed FROM loyalty_customers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn checkout_redemption_release_keeps_a_persisted_orders_debit() {
        let conn = checkout_redemption_connection();
        conn.execute("INSERT INTO orders (id, organization_id, client_request_id, items, total_amount) VALUES ('order-1', 'org-1', 'checkout-1', '[]', 10)", []).unwrap();
        release_checkout_redemption(&conn, "org-1", "checkout-1").unwrap();
        assert_eq!(
            conn.query_row("SELECT points_balance FROM loyalty_customers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            20
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM parity_sync_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn checkout_redemption_release_rolls_back_if_queue_removal_fails() {
        let conn = checkout_redemption_connection();
        conn.execute_batch("CREATE TRIGGER refuse_queue_delete BEFORE DELETE ON parity_sync_queue BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(release_checkout_redemption(&conn, "org-1", "checkout-1").is_err());
        assert_eq!(
            conn.query_row("SELECT points_balance FROM loyalty_customers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            20
        );
        assert_eq!(
            conn.query_row("SELECT sync_state FROM loyalty_transactions", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "pending"
        );
    }

    #[test]
    fn ended_earn_reversal_removes_cached_credit_and_recalculates_tier_once() {
        let conn = checkout_redemption_connection();
        conn.execute_batch("UPDATE loyalty_transactions SET points = 100, transaction_type = 'earn';
            UPDATE loyalty_customers SET points_balance = 120, total_earned = 550, total_redeemed = 0, tier = 'silver';").unwrap();
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        reverse_local_loyalty_transaction(&conn, "org-1", "redemption").unwrap();
        assert!(!reverse_local_loyalty_transaction(&conn, "org-1", "redemption").unwrap());
        conn.execute_batch("COMMIT").unwrap();
        let cached = conn
            .query_row(
                "SELECT points_balance, total_earned, tier FROM loyalty_customers",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(cached, (20, 450, "bronze".into()));
    }

    fn setup_loyalty_customers_table(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE loyalty_customers (
                id TEXT PRIMARY KEY,
                user_profile_id TEXT,
                customer_id TEXT,
                organization_id TEXT NOT NULL,
                points_balance INTEGER NOT NULL DEFAULT 0,
                total_earned INTEGER NOT NULL DEFAULT 0,
                total_redeemed INTEGER NOT NULL DEFAULT 0,
                tier TEXT NOT NULL DEFAULT 'none',
                customer_name TEXT,
                customer_email TEXT,
                customer_phone TEXT,
                loyalty_card_uid TEXT,
                last_synced_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )
        .unwrap();
    }

    #[test]
    fn snapshot_replacement_is_atomic_and_preserves_pending_points() {
        let mut conn = Connection::open_in_memory().unwrap();
        setup_loyalty_customers_table(&conn);
        conn.execute_batch(
            "CREATE TABLE loyalty_transactions (organization_id TEXT, sync_state TEXT);",
        )
        .unwrap();
        let old = serde_json::json!({"id":"old", "points_balance":42});
        replace_loyalty_snapshot(&mut conn, "org", &[old]).unwrap();
        let broken = vec![serde_json::json!({"id":"new"}), serde_json::json!({})];
        assert!(replace_loyalty_snapshot(&mut conn, "org", &broken).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT points_balance FROM loyalty_customers WHERE id='old'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            42
        );
        conn.execute(
            "INSERT INTO loyalty_transactions VALUES ('org','pending')",
            [],
        )
        .unwrap();
        assert!(replace_loyalty_snapshot(&mut conn, "org", &[]).is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM loyalty_customers", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        conn.execute("UPDATE loyalty_transactions SET sync_state='applied'", [])
            .unwrap();
        let customers: Vec<Value> = (0..401)
            .map(|n| serde_json::json!({"id": format!("customer-{n}")}))
            .collect();
        assert_eq!(
            replace_loyalty_snapshot(&mut conn, "org", &customers).unwrap(),
            401
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM loyalty_customers WHERE id='old'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        replace_loyalty_snapshot(&mut conn, "other-org", &[serde_json::json!({"id":"other"})])
            .unwrap();
        replace_loyalty_snapshot(&mut conn, "org", &[]).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM loyalty_customers", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn test_calculate_tier_none() {
        assert_eq!(calculate_tier(0, 0, 500, 2000, 5000), "bronze");
        assert_eq!(calculate_tier(-1, 0, 500, 2000, 5000), "none");
    }

    #[test]
    fn test_calculate_tier_bronze() {
        assert_eq!(calculate_tier(100, 0, 500, 2000, 5000), "bronze");
        assert_eq!(calculate_tier(499, 0, 500, 2000, 5000), "bronze");
    }

    #[test]
    fn test_calculate_tier_silver() {
        assert_eq!(calculate_tier(500, 0, 500, 2000, 5000), "silver");
        assert_eq!(calculate_tier(1999, 0, 500, 2000, 5000), "silver");
    }

    #[test]
    fn test_calculate_tier_gold() {
        assert_eq!(calculate_tier(2000, 0, 500, 2000, 5000), "gold");
        assert_eq!(calculate_tier(4999, 0, 500, 2000, 5000), "gold");
    }

    #[test]
    fn test_calculate_tier_platinum() {
        assert_eq!(calculate_tier(5000, 0, 500, 2000, 5000), "platinum");
        assert_eq!(calculate_tier(99999, 0, 500, 2000, 5000), "platinum");
    }

    #[test]
    fn test_get_organization_id_returns_none_when_unconfigured() {
        // storage::get_credential requires keyring; this test just validates
        // the function compiles and the None path works in isolation.
        // In a real environment, this would require a mock.
    }

    #[test]
    fn resolve_loyalty_customer_lookup_key_prefers_canonical_customer_id() {
        let conn = Connection::open_in_memory().unwrap();
        setup_loyalty_customers_table(&conn);
        conn.execute(
            "INSERT INTO loyalty_customers (
                id, user_profile_id, customer_id, organization_id, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                "row-1",
                "user-profile-1",
                "customer-1",
                "org-1",
                "2026-04-05T00:00:00Z"
            ],
        )
        .unwrap();

        let resolved = resolve_loyalty_customer_lookup_key(&conn, "org-1", "user-profile-1")
            .expect("legacy id should resolve");

        assert_eq!(resolved, "customer-1");
    }

    #[test]
    fn ensure_local_loyalty_customer_row_creates_placeholder_balance_row() {
        let conn = Connection::open_in_memory().unwrap();
        setup_loyalty_customers_table(&conn);

        ensure_local_loyalty_customer_row(&conn, "org-1", "customer-123", "2026-04-05T00:00:00Z")
            .expect("placeholder row should insert");

        let inserted: (Option<String>, String, i64) = conn
            .query_row(
                "SELECT user_profile_id, customer_id, points_balance
                 FROM loyalty_customers
                 WHERE organization_id = ?1 AND customer_id = ?2",
                params!["org-1", "customer-123"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(inserted.0, None);
        assert_eq!(inserted.1, "customer-123");
        assert_eq!(inserted.2, 0);
    }

    #[test]
    fn debit_local_loyalty_balance_refuses_an_insufficient_balance() {
        let conn = Connection::open_in_memory().unwrap();
        setup_loyalty_customers_table(&conn);
        conn.execute(
            "INSERT INTO loyalty_customers (
                id, customer_id, organization_id, points_balance, created_at, updated_at
            ) VALUES ('row-1', 'customer-1', 'org-1', 120, ?1, ?1)",
            params!["2026-09-16T00:00:00Z"],
        )
        .unwrap();

        assert!(!debit_local_loyalty_balance(
            &conn,
            "org-1",
            "customer-1",
            150,
            "2026-09-16T00:00:01Z"
        )
        .unwrap());
        assert!(debit_local_loyalty_balance(
            &conn,
            "org-1",
            "customer-1",
            100,
            "2026-09-16T00:00:01Z"
        )
        .unwrap());

        let (balance, redeemed): (i64, i64) = conn
            .query_row(
                "SELECT points_balance, total_redeemed FROM loyalty_customers WHERE customer_id = 'customer-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((balance, redeemed), (20, 100));
        assert!(!debit_local_loyalty_balance(
            &conn,
            "org-1",
            "customer-1",
            21,
            "2026-09-16T00:00:02Z"
        )
        .unwrap());
        assert!(!debit_local_loyalty_balance(
            &conn,
            "org-2",
            "customer-1",
            1,
            "2026-09-16T00:00:02Z"
        )
        .unwrap());
    }

    // -----------------------------------------------------------------------
    // Ω11 (22/10/2026): a checkout redemption needs a live server answer.
    // -----------------------------------------------------------------------

    const CHECKOUT: &str = "11111111-1111-4111-8111-111111111111";
    const CUSTOMER: &str = "22222222-2222-4222-8222-222222222222";
    const NOW: &str = "2026-10-22T10:00:00Z";

    /// An active programme (100 points minimum, 0.01 per point) and a
    /// customer holding 500 points, with no legacy reservation.
    fn live_redemption_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        sync_queue::create_tables(&conn).unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO loyalty_settings (id, organization_id, is_active, redemption_rate, min_redemption_points)
             VALUES ('settings', 'org-1', 1, 0.01, 100);
             INSERT INTO loyalty_customers (id, user_profile_id, customer_id, organization_id, points_balance, total_redeemed)
             VALUES ('balance', 'profile-1', '{CUSTOMER}', 'org-1', 500, 0);"
        ))
        .unwrap();
        conn
    }

    fn redeem_request(points: i64) -> RedeemRequest {
        parse_redeem_request(&serde_json::json!({
            "customerId": CUSTOMER, "points": points, "orderId": CHECKOUT, "checkoutReservation": true
        }))
        .unwrap()
    }

    fn balance(conn: &Connection) -> i64 {
        conn.query_row("SELECT points_balance FROM loyalty_customers", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn queued(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare("SELECT operation, data FROM parity_sync_queue ORDER BY created_at, id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn rows(conn: &Connection) -> Vec<(String, Option<String>)> {
        let mut stmt = conn
            .prepare("SELECT sync_state, sync_last_error FROM loyalty_transactions ORDER BY created_at, id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn send(conn: &Connection, points: i64) -> RedeemAttempt {
        match prepare_live_redemption(conn, "org-1", &redeem_request(points), NOW).unwrap() {
            RedeemPreparation::Send(attempt) => attempt,
            other => panic!("expected a live attempt, got {other:?}"),
        }
    }

    fn confirmed() -> LiveRedeemOutcome {
        LiveRedeemOutcome::Confirmed {
            already_redeemed: false,
        }
    }

    #[test]
    fn a_redemption_request_needs_its_checkout_and_positive_points() {
        let request = redeem_request(150);
        assert_eq!(request.order_id.as_deref(), Some(CHECKOUT));
        assert!(parse_redeem_request(&serde_json::json!({
            "customerId": CUSTOMER, "points": 150, "orderId": " ", "checkoutReservation": true
        }))
        .is_err());
        assert!(parse_redeem_request(&serde_json::json!({
            "customerId": CUSTOMER, "points": 0, "orderId": CHECKOUT
        }))
        .is_err());
    }

    /// Before: the desktop debited its cache, queued the debit and answered
    /// success with no server contact. Now only an attempt is written down:
    /// no debit, no queue row, and the body carries the checkout key.
    #[test]
    fn a_checkout_redemption_writes_only_an_attempt_and_never_queues() {
        let conn = live_redemption_connection();
        let attempt = send(&conn, 150);
        assert_eq!(balance(&conn), 500);
        assert!(queued(&conn).is_empty());
        assert_eq!(rows(&conn), vec![("syncing".to_string(), None)]);
        assert_eq!(
            attempt.body(),
            serde_json::json!({
                "customer_id": CUSTOMER, "points": 150, "order_id": CHECKOUT,
                "description": "Redeemed 150 points for 1.50 discount",
                "idempotency_key": format!("loyalty:{}", attempt.tx_id),
            })
        );
        // The local balance is a fast pre-check only.
        let refused = prepare_live_redemption(
            &live_redemption_connection(),
            "org-1",
            &redeem_request(600),
            NOW,
        );
        assert!(refused.unwrap_err().contains("Insufficient balance"));
    }

    #[test]
    fn a_confirmed_redemption_debits_the_cache_once_and_replays_locally() {
        let conn = live_redemption_connection();
        let attempt = send(&conn, 150);
        let answer = record_live_redemption(&conn, &attempt, &confirmed(), NOW).unwrap();
        assert_eq!(answer["success"], true);
        assert_eq!(answer["pointsRedeemed"], 150);
        assert_eq!(answer["newBalance"], 350);
        assert_eq!(rows(&conn), vec![("applied".to_string(), None)]);
        assert!(queued(&conn).is_empty());
        // Paying again under the same checkout spends nothing twice.
        let RedeemPreparation::Answered(replay) =
            prepare_live_redemption(&conn, "org-1", &redeem_request(150), NOW).unwrap()
        else {
            panic!("a confirmed checkout answers locally");
        };
        assert_eq!(replay["alreadyRedeemed"], true);
        assert_eq!(balance(&conn), 350);
    }

    /// Offline or refused: the sale continues without points and nothing of
    /// the attempt remains.
    #[test]
    fn offline_and_refused_redemptions_leave_no_row_and_answer_typed_codes() {
        for (outcome, code, reason) in [
            (
                LiveRedeemOutcome::NotSent,
                LOYALTY_REDEEM_OFFLINE,
                Value::Null,
            ),
            (
                LiveRedeemOutcome::Refused {
                    reason: "HTTP_400".into(),
                },
                LOYALTY_REDEEM_REFUSED,
                Value::String("HTTP_400".into()),
            ),
            // The first attempt of a checkout released earlier: the server's
            // tombstone refuses it and nothing was debited.
            (
                LiveRedeemOutcome::Refused {
                    reason: LOYALTY_REDEMPTION_RELEASED.into(),
                },
                LOYALTY_REDEEM_REFUSED,
                Value::String(LOYALTY_REDEMPTION_RELEASED.into()),
            ),
        ] {
            let conn = live_redemption_connection();
            let attempt = send(&conn, 150);
            let answer = record_live_redemption(&conn, &attempt, &outcome, NOW).unwrap();
            assert_eq!(answer["success"], false);
            assert_eq!(answer["errorCode"], code);
            assert_eq!(answer["reason"], reason);
            assert!(rows(&conn).is_empty());
            assert!(queued(&conn).is_empty());
            assert_eq!(balance(&conn), 500);
        }
    }

    /// Sent without an answer: the attempt stays, Retry sends the same key,
    /// and the server's replay confirms it once.
    #[test]
    fn an_unconfirmed_redemption_is_retried_under_the_same_key() {
        let conn = live_redemption_connection();
        let attempt = send(&conn, 150);
        let answer =
            record_live_redemption(&conn, &attempt, &LiveRedeemOutcome::Unconfirmed, NOW).unwrap();
        assert_eq!(answer["errorCode"], LOYALTY_REDEEM_UNCONFIRMED);
        assert_eq!(
            rows(&conn),
            vec![(
                "syncing".to_string(),
                Some(LOYALTY_REDEEM_UNCONFIRMED.to_string())
            )]
        );
        assert_eq!(balance(&conn), 500);
        let retry = send(&conn, 150);
        assert_eq!(retry.tx_id, attempt.tx_id);
        assert_eq!(retry.body(), attempt.body());
        let replayed = LiveRedeemOutcome::Confirmed {
            already_redeemed: true,
        };
        let answer = record_live_redemption(&conn, &retry, &replayed, NOW).unwrap();
        assert_eq!(answer["alreadyRedeemed"], true);
        assert_eq!(balance(&conn), 350);
        assert_eq!(rows(&conn), vec![("applied".to_string(), None)]);
    }

    /// Removing confirmed points: the cache gets them back at once and a
    /// durable RELEASE op waits for the server; the checkout never redeems
    /// again (a new sale does).
    #[test]
    fn releasing_a_confirmed_redemption_restores_the_cache_and_queues_the_release() {
        let conn = live_redemption_connection();
        let attempt = send(&conn, 150);
        record_live_redemption(&conn, &attempt, &confirmed(), NOW).unwrap();
        let releases = release_checkout_redemption(&conn, "org-1", CHECKOUT).unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(
            releases[0].body(),
            serde_json::json!({"order_id": CHECKOUT, "customer_id": CUSTOMER})
        );
        assert_eq!(balance(&conn), 500);
        assert_eq!(
            rows(&conn),
            vec![(
                "pending".to_string(),
                Some("LOYALTY_LOCAL_REVERSED".to_string())
            )]
        );
        let ops = queued(&conn);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].0, "DELETE");
        let op: Value = serde_json::from_str(&ops[0].1).unwrap();
        assert_eq!(op["transaction_type"], "release");
        assert_eq!(op["order_id"], CHECKOUT);
        // Idempotent: a second release changes nothing and queues nothing.
        assert!(release_checkout_redemption(&conn, "org-1", CHECKOUT)
            .unwrap()
            .is_empty());
        assert_eq!(balance(&conn), 500);
        assert_eq!(queued(&conn).len(), 1);
        // The same checkout is refused locally from now on.
        let RedeemPreparation::Answered(again) =
            prepare_live_redemption(&conn, "org-1", &redeem_request(150), NOW).unwrap()
        else {
            panic!("a released checkout answers locally");
        };
        assert_eq!(again["errorCode"], LOYALTY_REDEEM_REFUSED);
        assert_eq!(again["reason"], LOYALTY_REDEMPTION_RELEASED);
        // The server confirmed the live release: its op is no longer needed.
        settle_live_release(&conn, &releases[0]).unwrap();
        assert!(queued(&conn).is_empty());
        assert_eq!(rows(&conn)[0].0, "applied");
    }

    /// An unanswered attempt was never debited here: its release returns no
    /// cached points, but still asks the server to return any debit.
    #[test]
    fn releasing_an_unanswered_attempt_never_credits_the_cache() {
        let conn = live_redemption_connection();
        let attempt = send(&conn, 150);
        record_live_redemption(&conn, &attempt, &LiveRedeemOutcome::Unconfirmed, NOW).unwrap();
        let releases = release_checkout_redemption(&conn, "org-1", CHECKOUT).unwrap();
        assert_eq!(releases, vec![CheckoutRelease::of(&attempt)]);
        assert_eq!(balance(&conn), 500);
        assert_eq!(queued(&conn).len(), 1);
        // A confirmation arriving after the release queues the release again.
        let answer = record_live_redemption(&conn, &attempt, &confirmed(), NOW).unwrap();
        assert_eq!(answer["reason"], LOYALTY_REDEMPTION_RELEASED);
        assert_eq!(balance(&conn), 500);
        assert_eq!(queued(&conn).len(), 2);
    }

    #[test]
    fn a_saved_order_keeps_its_live_redemption() {
        let conn = live_redemption_connection();
        let attempt = send(&conn, 150);
        record_live_redemption(&conn, &attempt, &confirmed(), NOW).unwrap();
        conn.execute(
            "INSERT INTO orders (id, organization_id, client_request_id, items, total_amount)
             VALUES ('order-1', 'org-1', ?1, '[]', 10)",
            [CHECKOUT],
        )
        .unwrap();
        assert!(release_checkout_redemption(&conn, "org-1", CHECKOUT)
            .unwrap()
            .is_empty());
        assert_eq!(balance(&conn), 350);
        assert!(queued(&conn).is_empty());
    }

    #[test]
    fn redeem_answers_are_classified_by_what_they_prove() {
        use crate::api::AdminFetchError;
        let http = AdminFetchError::from_http_response_for_test;
        assert_eq!(
            classify_live_redeem(Ok(
                serde_json::json!({"success": true, "already_redeemed": true})
            )),
            LiveRedeemOutcome::Confirmed {
                already_redeemed: true
            }
        );
        assert_eq!(
            classify_live_redeem(Ok(serde_json::json!({"success": false}))),
            LiveRedeemOutcome::Unconfirmed
        );
        for not_sent in [
            AdminFetchError::connect_failed_for_test("Cannot reach admin dashboard"),
            AdminFetchError::statusless("Terminal not configured: missing API key"),
            AdminFetchError::statusless("TERMINAL_REBIND_PENDING"),
        ] {
            assert_eq!(classify_redeem_error(&not_sent), LiveRedeemOutcome::NotSent);
        }
        for unknown in [
            AdminFetchError::transport("Connection timed out"),
            AdminFetchError::statusless("Invalid JSON from admin dashboard: eof"),
            http(500, r#"{"success":false,"error":"boom"}"#),
            http(504, "<html>gateway</html>"),
            http(408, ""),
            http(429, r#"{"success":false,"error":"slow down"}"#),
        ] {
            assert_eq!(
                classify_redeem_error(&unknown),
                LiveRedeemOutcome::Unconfirmed,
                "{unknown:?}"
            );
        }
        assert_eq!(
            classify_redeem_error(&http(
                409,
                r#"{"success":false,"code":"LOYALTY_REDEMPTION_RELEASED"}"#
            )),
            LiveRedeemOutcome::Refused {
                reason: LOYALTY_REDEMPTION_RELEASED.into()
            }
        );
        assert_eq!(
            classify_redeem_error(&http(
                400,
                r#"{"success":false,"error":"Insufficient points balance"}"#
            )),
            LiveRedeemOutcome::Refused {
                reason: "HTTP_400".into()
            }
        );
        // A release is settled by any 200 or by these two final refusals.
        assert!(release_refusal_is_final(Some(LOYALTY_ORDER_EXISTS)));
        assert!(release_refusal_is_final(Some(
            LOYALTY_RELEASE_CUSTOMER_MISMATCH
        )));
        assert!(!release_refusal_is_final(Some("MODULE_REQUIRED")));
        assert!(!release_refusal_is_final(None));
    }

    /// One scripted `(status, body)` answer per request; keeps each request.
    fn spawn_answer_server(
        answers: Vec<(u16, &'static str)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = std::sync::Arc::clone(&requests);
        std::thread::spawn(move || {
            for (stream, (status, body)) in listener.incoming().zip(answers) {
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                // Headers, then the whole Content-Length body.
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let read = stream.read(&mut chunk).unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    let Some((head, received)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if received.len() >= length {
                        break;
                    }
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request).to_string());
                let response = format!(
                    "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://{addr}"), requests)
    }

    /// End to end through the real transport: the checkout key reaches the
    /// redeem route, each answer is recorded as typed, and a till that cannot
    /// open a connection answers offline with no row left behind.
    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn live_redemption_reaches_the_server_and_records_each_answer() {
        let (url, requests) = spawn_answer_server(vec![
            (
                200,
                r#"{"success":true,"already_redeemed":false,"transaction":{"points_redeemed":150}}"#,
            ),
            (
                409,
                r#"{"success":false,"code":"LOYALTY_REDEMPTION_RELEASED"}"#,
            ),
            (200, r#"{"success":true,"released":true}"#),
        ]);
        {
            let _keyring = crate::tests::fake_keyring::install_seeded([
                ("pos_api_key", "plain-api-key"),
                ("terminal_id", "terminal-a"),
                ("admin_dashboard_url", url.as_str()),
            ]);
            let conn = live_redemption_connection();
            let attempt = send(&conn, 150);
            let outcome = send_live_redemption(&attempt).await;
            assert_eq!(outcome, confirmed());
            record_live_redemption(&conn, &attempt, &outcome, NOW).unwrap();
            assert_eq!(balance(&conn), 350);

            let other = live_redemption_connection();
            let refused = send(&other, 150);
            assert_eq!(
                send_live_redemption(&refused).await,
                LiveRedeemOutcome::Refused {
                    reason: LOYALTY_REDEMPTION_RELEASED.into()
                }
            );

            let releases = release_checkout_redemption(&conn, "org-1", CHECKOUT).unwrap();
            assert!(send_live_release(&releases[0]).await);

            let seen = requests.lock().unwrap().clone();
            assert_eq!(seen.len(), 3);
            assert!(seen[0].starts_with("POST /api/pos/loyalty/redeem "));
            assert!(seen[0].contains(&format!("\"order_id\":\"{CHECKOUT}\"")));
            assert!(seen[2].starts_with("POST /api/pos/loyalty/redeem/release "));
            assert!(seen[2].contains(&format!("\"customer_id\":\"{CUSTOMER}\"")));
        }

        // Nothing listens on this port: the connection is never opened.
        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("pos_api_key", "plain-api-key"),
            ("terminal_id", "terminal-a"),
            ("admin_dashboard_url", closed.as_str()),
        ]);
        let conn = live_redemption_connection();
        let attempt = send(&conn, 150);
        let outcome = send_live_redemption(&attempt).await;
        assert_eq!(outcome, LiveRedeemOutcome::NotSent);
        let answer = record_live_redemption(&conn, &attempt, &outcome, NOW).unwrap();
        assert_eq!(answer["errorCode"], LOYALTY_REDEEM_OFFLINE);
        assert!(rows(&conn).is_empty());
        assert_eq!(balance(&conn), 500);
    }
}
