//! This till's own retail sales that have not reached the server yet
//! (`retail.block_overselling`, vertical salon follow-ups 21/10/2026).
//!
//! The product snapshot only knows what the server has deducted. An order this
//! till sold offline, or one still waiting in its queue, is invisible to it, so
//! an offline till could sell the last unit again and again. The renderer adds
//! these quantities to the shared rule (`shared/retail-stock.ts`). Other tills'
//! offline sales stay invisible; the server caps the deduction for those.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::Manager;

use crate::database_lock::run_blocking_command;
use crate::{db, read_local_setting, storage};

/// Statuses whose goods never left the shop.
const NOT_SOLD_STATUSES: &str = "'cancelled', 'canceled', 'voided', 'void'";

fn text_field<'a>(line: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .filter_map(|key| line.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
}

fn quantity_field(line: &Value) -> Option<f64> {
    let quantity = match line.get("quantity")? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (quantity.is_finite() && quantity > 0.0).then_some(quantity)
}

/// Sums the retail lines of local orders that have no server copy yet and
/// were not cancelled or voided. An order the server already holds
/// (`supabase_id` set) was deducted there, even while a later edit of it
/// waits to sync, so it is left out. Organization and branch must match the
/// terminal's current identity, excluding orders left behind by a rebind.
pub(crate) fn unsynced_retail_quantities(
    conn: &Connection,
    organization_id: &str,
    branch_id: &str,
) -> Result<Vec<Value>, String> {
    if organization_id.is_empty() || branch_id.is_empty() {
        return Err("Retail stock requires organization and branch identity".to_string());
    }
    let sql = format!(
        "SELECT items FROM orders
         WHERE COALESCE(sync_status, 'pending') <> 'synced'
           AND NULLIF(TRIM(COALESCE(supabase_id, '')), '') IS NULL
           AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ({NOT_SOLD_STATUSES})
           AND organization_id = ?1
           AND branch_id = ?2"
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([organization_id, branch_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(|error| error.to_string())?;

    let mut totals: BTreeMap<(String, String), f64> = BTreeMap::new();
    for row in rows {
        let Some(items) = row.map_err(|error| error.to_string())? else {
            continue;
        };
        let Ok(Value::Array(lines)) = serde_json::from_str::<Value>(&items) else {
            continue;
        };
        for line in &lines {
            if text_field(line, &["line_role", "lineRole"]) == Some("deposit") {
                continue;
            }
            let Some(product) = text_field(line, &["retail_product_id", "retailProductId"]) else {
                continue;
            };
            let Some(quantity) = quantity_field(line) else {
                continue;
            };
            let variant = text_field(line, &["retail_variant_id", "retailVariantId"]).unwrap_or("");
            *totals
                .entry((product.to_string(), variant.to_string()))
                .or_insert(0.0) += quantity;
        }
    }

    Ok(totals
        .into_iter()
        .map(|((product, variant), quantity)| {
            json!({
                "productId": product,
                "variantId": if variant.is_empty() { Value::Null } else { Value::String(variant) },
                "quantity": (quantity * 1000.0).round() / 1000.0,
            })
        })
        .collect())
}

// On the blocking pool, never the window thread or a runtime worker: it reads
// the main connection (Tomikro 20/10/2026, see database_lock.rs).
#[tauri::command]
pub async fn orders_get_unsynced_retail_quantities(app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("orders_get_unsynced_retail_quantities", move || {
        let db = app.state::<db::DbState>();
        let organization_id = storage::get_credential("organization_id")
            .or_else(|| read_local_setting(&db, "terminal", "organization_id"))
            .unwrap_or_default();
        let branch_id = storage::get_credential("branch_id")
            .or_else(|| read_local_setting(&db, "terminal", "branch_id"))
            .unwrap_or_default();
        let conn = db
            .lock_traced("orders_get_unsynced_retail_quantities")
            .map_err(|error| error.to_string())?;
        let quantities =
            unsynced_retail_quantities(&conn, organization_id.trim(), branch_id.trim())?;
        Ok(json!({ "success": true, "quantities": quantities }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        conn
    }

    fn insert_order(
        conn: &Connection,
        id: &str,
        status: &str,
        sync_status: &str,
        supabase_id: Option<&str>,
        branch_id: &str,
        items: Value,
    ) {
        conn.execute(
            "INSERT INTO orders (id, items, status, sync_status, supabase_id, branch_id, organization_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'org-1')",
            params![id, items.to_string(), status, sync_status, supabase_id, branch_id],
        )
        .expect("insert order");
    }

    fn quantity_of(rows: &[Value], product: &str, variant: Option<&str>) -> Option<f64> {
        rows.iter()
            .find(|row| {
                row["productId"] == product
                    && match variant {
                        Some(variant) => row["variantId"] == variant,
                        None => row["variantId"].is_null(),
                    }
            })
            .and_then(|row| row["quantity"].as_f64())
    }

    #[test]
    fn sums_only_unsynced_sold_retail_lines_of_this_branch() {
        let conn = test_conn();
        // Offline sale: a base product, a variant, a measured line and a deposit.
        insert_order(
            &conn,
            "offline-1",
            "completed",
            "pending",
            None,
            "branch-1",
            json!([
                { "retail_product_id": "shampoo", "quantity": 2 },
                { "retail_product_id": "shampoo", "retail_variant_id": "500ml", "quantity": 1 },
                { "retailProductId": "rice", "quantity": "0.4256" },
                { "id": "manual", "line_role": "deposit", "retail_product_id": "shampoo", "quantity": 2 },
                { "menu_item_id": "coffee", "quantity": 3 },
                { "service_id": "haircut", "quantity": 1 }
            ]),
        );
        // A failed sync still left the shop.
        insert_order(
            &conn,
            "failed-1",
            "completed",
            "failed",
            Some(""),
            "branch-1",
            json!([{ "retail_product_id": "shampoo", "retail_variant_id": "500ml", "quantity": 1.5 }]),
        );
        // Already on the server, even with a pending edit: deducted there.
        insert_order(
            &conn,
            "synced-edit",
            "completed",
            "pending",
            Some("server-1"),
            "branch-1",
            json!([{ "retail_product_id": "shampoo", "quantity": 7 }]),
        );
        insert_order(
            &conn,
            "synced",
            "completed",
            "synced",
            None,
            "branch-1",
            json!([{ "retail_product_id": "shampoo", "quantity": 9 }]),
        );
        for (id, status) in [
            ("cancelled", "cancelled"),
            ("canceled", "Canceled"),
            ("voided", "voided"),
        ] {
            insert_order(
                &conn,
                id,
                status,
                "pending",
                None,
                "branch-1",
                json!([{ "retail_product_id": "shampoo", "quantity": 11 }]),
            );
        }
        // Another branch's leftover after a rebind.
        insert_order(
            &conn,
            "other-branch",
            "completed",
            "pending",
            None,
            "branch-2",
            json!([{ "retail_product_id": "shampoo", "quantity": 13 }]),
        );
        // Unreadable rows never break the sum.
        conn.execute(
            "INSERT INTO orders (id, items, status, sync_status, branch_id, organization_id)
             VALUES ('broken', 'not json', 'completed', 'pending', 'branch-1', 'org-1')",
            [],
        )
        .expect("insert broken order");

        insert_order(
            &conn,
            "other-org",
            "completed",
            "pending",
            None,
            "branch-1",
            json!([{ "retail_product_id": "shampoo", "quantity": 17 }]),
        );
        conn.execute(
            "UPDATE orders SET organization_id = 'org-2' WHERE id = 'other-org'",
            [],
        )
        .expect("set other organization");

        let rows = unsynced_retail_quantities(&conn, "org-1", "branch-1").expect("sum");
        assert_eq!(quantity_of(&rows, "shampoo", None), Some(2.0));
        assert_eq!(quantity_of(&rows, "shampoo", Some("500ml")), Some(2.5));
        assert_eq!(quantity_of(&rows, "rice", None), Some(0.426));
        assert_eq!(rows.len(), 3, "no menu, service or deposit line: {rows:?}");

        assert!(unsynced_retail_quantities(&conn, "org-1", "").is_err());
        assert!(unsynced_retail_quantities(&conn, "", "branch-1").is_err());
    }

    #[test]
    fn an_empty_till_reports_nothing() {
        let conn = test_conn();
        assert!(unsynced_retail_quantities(&conn, "org-1", "branch-1")
            .expect("sum")
            .is_empty());
    }
}
