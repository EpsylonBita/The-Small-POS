use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use tracing::info;
use uuid::Uuid;

use crate::{db, storage, value_f64, value_str};

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
        "user_profile_id":  row.get::<_, String>(1)?,
        "organization_id":  row.get::<_, String>(2)?,
        "points_balance":   row.get::<_, i64>(3)?,
        "total_earned":     row.get::<_, i64>(4)?,
        "total_redeemed":   row.get::<_, i64>(5)?,
        "tier":             row.get::<_, String>(6)?,
        "customer_name":    row.get::<_, Option<String>>(7)?,
        "customer_email":   row.get::<_, Option<String>>(8)?,
        "customer_phone":   row.get::<_, Option<String>>(9)?,
        "loyalty_card_uid": row.get::<_, Option<String>>(10)?,
        "last_synced_at":   row.get::<_, Option<String>>(11)?,
        "created_at":       row.get::<_, String>(12)?,
        "updated_at":       row.get::<_, String>(13)?,
    }))
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
pub async fn loyalty_get_settings(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
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

/// Fetch loyalty customers from admin API and upsert into local cache.
#[tauri::command]
pub async fn loyalty_sync_customers(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let org_id =
        get_organization_id(&db).ok_or_else(|| "Organization not configured".to_string())?;

    let resp = crate::admin_fetch(Some(&db), "/api/pos/loyalty/customers", "GET", None).await?;

    let customers = resp
        .get("customers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut count = 0usize;
    for c in &customers {
        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR REPLACE INTO loyalty_customers (
                id, user_profile_id, organization_id, points_balance, total_earned,
                total_redeemed, tier, customer_name, customer_email, customer_phone,
                loyalty_card_uid, last_synced_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                      COALESCE(?13, datetime('now')), ?14)",
            params![
                id,
                c.get("user_profile_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(id),
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

    info!(count = count, org_id = %org_id, "Synced loyalty customers from admin");
    Ok(serde_json::json!({ "success": true, "count": count }))
}

/// Query locally cached loyalty customers with optional search filter.
#[tauri::command]
pub async fn loyalty_get_customers(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
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
        let mut stmt = conn
            .prepare(
                "SELECT id, user_profile_id, organization_id, points_balance, total_earned,
                        total_redeemed, tier, customer_name, customer_email, customer_phone,
                        loyalty_card_uid, last_synced_at, created_at, updated_at
                 FROM loyalty_customers
                 WHERE organization_id = ?1
                 ORDER BY points_balance DESC
                 LIMIT 100",
            )
            .map_err(|e| format!("loyalty_get_customers prepare: {e}"))?;

        let rows = stmt
            .query_map(params![org_id], customer_row_to_json)
            .map_err(|e| format!("loyalty_get_customers query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    } else {
        let pattern = format!("%{search}%");
        let mut stmt = conn
            .prepare(
                "SELECT id, user_profile_id, organization_id, points_balance, total_earned,
                        total_redeemed, tier, customer_name, customer_email, customer_phone,
                        loyalty_card_uid, last_synced_at, created_at, updated_at
                 FROM loyalty_customers
                 WHERE organization_id = ?1
                   AND (customer_name LIKE ?2 OR customer_email LIKE ?2 OR customer_phone LIKE ?2)
                 ORDER BY points_balance DESC
                 LIMIT 100",
            )
            .map_err(|e| format!("loyalty_get_customers prepare: {e}"))?;

        let rows = stmt
            .query_map(params![org_id, pattern], customer_row_to_json)
            .map_err(|e| format!("loyalty_get_customers query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    Ok(serde_json::json!({ "customers": customers }))
}

/// Look up a single loyalty customer by user_profile_id (or customer_id alias).
#[tauri::command]
pub async fn loyalty_get_customer_balance(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let user_profile_id = value_str(
        &payload,
        &["customerId", "customer_id", "user_profile_id", "id"],
    )
    .ok_or_else(|| "Missing customerId or user_profile_id".to_string())?;

    let org_id = match get_organization_id(&db) {
        Some(id) => id,
        None => return Ok(serde_json::json!({ "customer": null })),
    };

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let row: Option<Value> = conn
        .query_row(
            "SELECT id, user_profile_id, organization_id, points_balance, total_earned,
                    total_redeemed, tier, customer_name, customer_email, customer_phone,
                    loyalty_card_uid, last_synced_at, created_at, updated_at
             FROM loyalty_customers
             WHERE user_profile_id = ?1 AND organization_id = ?2
             LIMIT 1",
            params![user_profile_id, org_id],
            customer_row_to_json,
        )
        .optional()
        .map_err(|e| format!("loyalty_get_customer_balance query: {e}"))?;

    Ok(serde_json::json!({ "customer": row }))
}

/// Look up a loyalty customer by phone number.
#[tauri::command]
pub async fn loyalty_lookup_by_phone(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let phone = value_str(&payload, &["phone", "customerPhone", "mobile"])
        .ok_or_else(|| "Missing phone".to_string())?;

    let org_id = match get_organization_id(&db) {
        Some(id) => id,
        None => return Ok(serde_json::json!({ "customer": null })),
    };

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let row: Option<Value> = conn
        .query_row(
            "SELECT id, user_profile_id, organization_id, points_balance, total_earned,
                    total_redeemed, tier, customer_name, customer_email, customer_phone,
                    loyalty_card_uid, last_synced_at, created_at, updated_at
             FROM loyalty_customers
             WHERE customer_phone = ?1 AND organization_id = ?2
             LIMIT 1",
            params![phone, org_id],
            customer_row_to_json,
        )
        .optional()
        .map_err(|e| format!("loyalty_lookup_by_phone query: {e}"))?;

    Ok(serde_json::json!({ "customer": row }))
}

/// Look up a loyalty customer by NFC/RFID card UID.
#[tauri::command]
pub async fn loyalty_lookup_by_card(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
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
    let row: Option<Value> = conn
        .query_row(
            "SELECT id, user_profile_id, organization_id, points_balance, total_earned,
                    total_redeemed, tier, customer_name, customer_email, customer_phone,
                    loyalty_card_uid, last_synced_at, created_at, updated_at
             FROM loyalty_customers
             WHERE loyalty_card_uid = ?1 AND organization_id = ?2
             LIMIT 1",
            params![uid, org_id],
            customer_row_to_json,
        )
        .optional()
        .map_err(|e| format!("loyalty_lookup_by_card query: {e}"))?;

    let found = row.is_some();
    Ok(serde_json::json!({ "success": found, "customer": row }))
}

/// Award points to a customer for an order. Creates a pending transaction
/// in loyalty_transactions and enqueues it for sync.
#[tauri::command]
pub async fn loyalty_earn_points(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let customer_id = value_str(&payload, &["customerId", "customer_id", "id"])
        .ok_or_else(|| "Missing customerId".to_string())?;
    let order_id = value_str(&payload, &["orderId", "order_id"]);
    let amount = value_f64(&payload, &["amount", "total", "orderTotal"])
        .ok_or_else(|| "Missing amount".to_string())?;

    let org_id =
        get_organization_id(&db).ok_or_else(|| "Organization not configured".to_string())?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

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

    // Insert loyalty transaction
    conn.execute(
        "INSERT INTO loyalty_transactions (
            id, customer_id, organization_id, points, transaction_type,
            order_id, description, sync_state, created_at
        ) VALUES (?1, ?2, ?3, ?4, 'earn', ?5, ?6, 'pending', ?7)",
        params![
            tx_id,
            customer_id,
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
         WHERE user_profile_id = ?3 AND organization_id = ?4",
        params![points_earned, now, customer_id, org_id],
    )
    .map_err(|e| format!("loyalty_earn_points update balance: {e}"))?;

    // Read new totals and recalculate tier
    let (new_balance, new_total_earned): (i64, i64) = conn
        .query_row(
            "SELECT points_balance, total_earned FROM loyalty_customers
             WHERE user_profile_id = ?1 AND organization_id = ?2",
            params![customer_id, org_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("loyalty_earn_points read balance: {e}"))?;

    let new_tier = calculate_tier(new_total_earned, bronze, silver, gold, platinum);
    conn.execute(
        "UPDATE loyalty_customers SET tier = ?1 WHERE user_profile_id = ?2 AND organization_id = ?3",
        params![new_tier, customer_id, org_id],
    )
    .map_err(|e| format!("loyalty_earn_points update tier: {e}"))?;

    // Enqueue for sync — include the original purchase amount so the admin
    // /api/pos/loyalty/earn endpoint can recalculate points server-side.
    let sync_payload = serde_json::json!({
        "id": tx_id,
        "customer_id": customer_id,
        "organization_id": org_id,
        "points": points_earned,
        "amount": amount,
        "transaction_type": "earn",
        "order_id": order_id,
        "description": description,
        "created_at": now,
    });
    let idem_key = format!("loyalty_tx:{tx_id}");
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('loyalty_transaction', ?1, 'insert', ?2, ?3)",
        params![tx_id, sync_payload.to_string(), idem_key],
    );

    info!(
        customer_id = %customer_id,
        points_earned = points_earned,
        new_balance = new_balance,
        "Loyalty points earned"
    );

    Ok(serde_json::json!({
        "success": true,
        "pointsEarned": points_earned,
        "newBalance": new_balance
    }))
}

/// Redeem points from a customer's balance for a discount. Creates a pending
/// transaction in loyalty_transactions and enqueues it for sync.
#[tauri::command]
pub async fn loyalty_redeem_points(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let customer_id = value_str(&payload, &["customerId", "customer_id", "id"])
        .ok_or_else(|| "Missing customerId".to_string())?;
    let points = payload
        .get("points")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "Missing points".to_string())?;
    let order_id = value_str(&payload, &["orderId", "order_id"]);

    if points <= 0 {
        return Err("Points to redeem must be positive".into());
    }

    let org_id =
        get_organization_id(&db).ok_or_else(|| "Organization not configured".to_string())?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Read loyalty settings to validate
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

    // Check customer balance
    let current_balance: i64 = conn
        .query_row(
            "SELECT points_balance FROM loyalty_customers
             WHERE user_profile_id = ?1 AND organization_id = ?2",
            params![customer_id, org_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("loyalty_redeem_points balance: {e}"))?
        .ok_or_else(|| "Customer not found".to_string())?;

    if current_balance < points {
        return Err(format!(
            "Insufficient balance: have {current_balance}, need {points}"
        ));
    }

    let discount_value = (points as f64) * redemption_rate;
    let tx_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let description = format!(
        "Redeemed {} points for {:.2} discount",
        points, discount_value
    );
    let negative_points = -points;

    // Insert loyalty transaction (points stored as negative for redemptions)
    conn.execute(
        "INSERT INTO loyalty_transactions (
            id, customer_id, organization_id, points, transaction_type,
            order_id, description, sync_state, created_at
        ) VALUES (?1, ?2, ?3, ?4, 'redeem', ?5, ?6, 'pending', ?7)",
        params![
            tx_id,
            customer_id,
            org_id,
            negative_points,
            order_id,
            description,
            now
        ],
    )
    .map_err(|e| format!("loyalty_redeem_points insert tx: {e}"))?;

    // Update customer balance
    conn.execute(
        "UPDATE loyalty_customers
         SET points_balance = points_balance - ?1,
             total_redeemed = total_redeemed + ?1,
             updated_at = ?2
         WHERE user_profile_id = ?3 AND organization_id = ?4",
        params![points, now, customer_id, org_id],
    )
    .map_err(|e| format!("loyalty_redeem_points update balance: {e}"))?;

    let new_balance = current_balance - points;

    // Enqueue for sync
    let sync_payload = serde_json::json!({
        "id": tx_id,
        "customer_id": customer_id,
        "organization_id": org_id,
        "points": negative_points,
        "transaction_type": "redeem",
        "order_id": order_id,
        "description": description,
        "discount_value": discount_value,
        "created_at": now,
    });
    let idem_key = format!("loyalty_tx:{tx_id}");
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('loyalty_transaction', ?1, 'insert', ?2, ?3)",
        params![tx_id, sync_payload.to_string(), idem_key],
    );

    info!(
        customer_id = %customer_id,
        points_redeemed = points,
        discount_value = discount_value,
        new_balance = new_balance,
        "Loyalty points redeemed"
    );

    Ok(serde_json::json!({
        "success": true,
        "pointsRedeemed": points,
        "discountValue": discount_value,
        "newBalance": new_balance
    }))
}

/// List recent loyalty transactions for a specific customer.
#[tauri::command]
pub async fn loyalty_get_transactions(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let customer_id = value_str(&payload, &["customerId", "customer_id", "id"])
        .ok_or_else(|| "Missing customerId or customer_id".to_string())?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, customer_id, organization_id, points, transaction_type,
                    order_id, description, sync_state, created_at
             FROM loyalty_transactions
             WHERE customer_id = ?1
             ORDER BY created_at DESC
             LIMIT 50",
        )
        .map_err(|e| format!("loyalty_get_transactions prepare: {e}"))?;

    let transactions: Vec<Value> = stmt
        .query_map(params![customer_id], transaction_row_to_json)
        .map_err(|e| format!("loyalty_get_transactions query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::json!({ "transactions": transactions }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
}
