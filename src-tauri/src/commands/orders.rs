use chrono::Utc;
use serde::Deserialize;
use tauri::Emitter;

use crate::{
    db, fetch_supabase_rows, normalize_status_for_storage, payload_arg0_as_string,
    read_local_json_array, resolve_order_id, storage, sync, value_f64, value_i64, value_str,
    write_local_json,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderUpdateStatusPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    status: String,
    #[serde(default, alias = "estimated_time")]
    estimated_time: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderUpdateItemsRawPayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
    #[serde(default)]
    items: Vec<serde_json::Value>,
    #[serde(
        default,
        alias = "order_notes",
        alias = "notes",
        alias = "special_instructions"
    )]
    order_notes: Option<serde_json::Value>,
}

#[derive(Debug)]
struct OrderUpdateItemsPayload {
    order_id: String,
    items: Vec<serde_json::Value>,
    order_notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderDeletePayload {
    #[serde(alias = "order_id")]
    #[serde(alias = "id")]
    #[serde(alias = "supabaseId")]
    #[serde(alias = "supabase_id")]
    order_id: String,
}

fn parse_order_update_status_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
) -> Result<OrderUpdateStatusPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(mut obj)) => {
            if obj.get("status").is_none() {
                if let Some(status) = arg1 {
                    obj.insert("status".to_string(), serde_json::Value::String(status));
                }
            }
            serde_json::Value::Object(obj)
        }
        Some(serde_json::Value::String(order_id)) => {
            serde_json::json!({ "orderId": order_id, "status": arg1 })
        }
        Some(v) => v,
        None => serde_json::json!({ "status": arg1 }),
    };
    let mut parsed: OrderUpdateStatusPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid order status payload: {e}"))?;
    parsed.order_id = parsed.order_id.trim().to_string();
    parsed.status = parsed.status.trim().to_string();
    if parsed.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    if parsed.status.is_empty() {
        return Err("Missing status".into());
    }
    Ok(parsed)
}

fn merge_order_update_items_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> serde_json::Value {
    match (arg0, arg1) {
        // Common invoke shape from typed bridge: (orderId, items[])
        (Some(serde_json::Value::String(order_id)), Some(serde_json::Value::Array(items))) => {
            serde_json::json!({
                "orderId": order_id,
                "items": items
            })
        }
        // Alternate invoke shape: (orderId, { items, orderNotes? })
        (Some(serde_json::Value::String(order_id)), Some(serde_json::Value::Object(mut extra))) => {
            extra.insert("orderId".to_string(), serde_json::Value::String(order_id));
            serde_json::Value::Object(extra)
        }
        // If arg0 is object and arg1 is array, treat arg1 as items override
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Array(items))) => {
            base.insert("items".to_string(), serde_json::Value::Array(items));
            serde_json::Value::Object(base)
        }
        // Generic object/object merge
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), None) => v,
        (None, Some(v)) => v,
        _ => serde_json::json!({}),
    }
}

fn parse_order_update_items_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<OrderUpdateItemsPayload, String> {
    let payload = merge_order_update_items_payload(arg0, arg1);
    if let Some(items) = payload.get("items") {
        if !items.is_array() {
            return Err("items must be an array".into());
        }
    }
    let raw: OrderUpdateItemsRawPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid order update payload: {e}"))?;
    let order_id = raw.order_id.trim().to_string();
    if order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    let order_notes = raw
        .order_notes
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(OrderUpdateItemsPayload {
        order_id,
        items: raw.items,
        order_notes,
    })
}

fn parse_order_delete_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
) -> Result<OrderDeletePayload, String> {
    let order_id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing orderId")?;
    let mut payload: OrderDeletePayload = serde_json::from_value(serde_json::json!({
        "orderId": order_id
    }))
    .map_err(|e| format!("Invalid order delete payload: {e}"))?;
    payload.order_id = payload.order_id.trim().to_string();
    if payload.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    Ok(payload)
}

#[tauri::command]
pub async fn order_get_all(
    db: tauri::State<'_, db::DbState>,
) -> Result<Vec<serde_json::Value>, String> {
    sync::get_all_orders(&db)
}

#[tauri::command]
pub async fn order_get_by_id(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing order ID")?;
    let resolved_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let by_local: Option<String> = conn
            .query_row(
                "SELECT id FROM orders WHERE id = ?1 LIMIT 1",
                rusqlite::params![id.clone()],
                |row| row.get(0),
            )
            .ok();
        if let Some(v) = by_local {
            v
        } else {
            conn.query_row(
                "SELECT id FROM orders WHERE supabase_id = ?1 LIMIT 1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|_| "Order not found")?
        }
    };
    sync::get_order_by_id(&db, &resolved_id)
}

#[tauri::command]
pub async fn order_get_by_customer_phone(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let customer_phone =
        payload_arg0_as_string(arg0, &["customerPhone", "customer_phone", "phone"])
            .or(arg1)
            .ok_or("Missing customer phone")?;
    let normalized = customer_phone
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
        .collect::<String>();
    let all_orders = sync::get_all_orders(&db)?;
    let filtered: Vec<serde_json::Value> = all_orders
        .into_iter()
        .filter(|o| {
            let phone = o
                .get("customerPhone")
                .and_then(|v| v.as_str())
                .or_else(|| o.get("customer_phone").and_then(|v| v.as_str()))
                .unwrap_or("")
                .chars()
                .filter(|c| !matches!(c, ' ' | '-' | '(' | ')'))
                .collect::<String>();
            !phone.is_empty() && (phone.contains(&normalized) || normalized.contains(&phone))
        })
        .collect();

    Ok(serde_json::json!({
        "success": true,
        "orders": filtered
    }))
}

#[tauri::command]
pub async fn order_update_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_update_status_payload(arg0, arg1)?;
    let order_id_raw = payload.order_id;
    let status = normalize_status_for_storage(&payload.status);
    let estimated_time = payload.estimated_time;
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Order not found")?
    };

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE orders
             SET status = ?1, sync_status = 'pending', updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![status, now, actual_order_id],
        )
        .map_err(|e| format!("update order status: {e}"))?;
        if let Some(eta) = estimated_time {
            let _ = conn.execute(
                "UPDATE orders SET estimated_time = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![eta, now, actual_order_id],
            );
        }
        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "status": status,
            "estimatedTime": estimated_time
        });
        let idem = format!(
            "order:update-status:{}:{}",
            actual_order_id,
            Utc::now().timestamp_millis()
        );
        let _ = conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', ?1, 'update', ?2, ?3)",
            rusqlite::params![actual_order_id, sync_payload.to_string(), idem],
        );
    }

    let event_payload = serde_json::json!({
        "orderId": actual_order_id,
        "status": status,
        "estimatedTime": estimated_time
    });
    let _ = app.emit("order_status_updated", event_payload.clone());
    let _ = app.emit("order_realtime_update", event_payload);

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
pub async fn order_update_items(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_update_items_payload(arg0, arg1)?;
    let order_id_raw = payload.order_id;
    let items = payload.items;
    let notes = payload.order_notes;
    let total = items
        .iter()
        .map(|item| {
            let qty = value_f64(item, &["quantity"]).unwrap_or(1.0);
            if let Some(tp) = value_f64(item, &["total_price", "totalPrice"]) {
                tp
            } else {
                value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0) * qty
            }
        })
        .sum::<f64>();
    let now = Utc::now().to_rfc3339();

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Order not found")?
    };

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let items_json =
            serde_json::to_string(&items).map_err(|e| format!("serialize items: {e}"))?;
        if let Some(order_notes) = notes.clone() {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, special_instructions = ?3, sync_status = 'pending', updated_at = ?4
                 WHERE id = ?5",
                rusqlite::params![items_json, total, order_notes, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        } else {
            conn.execute(
                "UPDATE orders
                 SET items = ?1, total_amount = ?2, sync_status = 'pending', updated_at = ?3
                 WHERE id = ?4",
                rusqlite::params![items_json, total, now, actual_order_id],
            )
            .map_err(|e| format!("update order items: {e}"))?;
        }
        let sync_payload = serde_json::json!({
            "orderId": actual_order_id,
            "items": items,
            "orderNotes": notes
        });
        let idem = format!(
            "order:update-items:{}:{}",
            actual_order_id,
            Utc::now().timestamp_millis()
        );
        let _ = conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', ?1, 'update', ?2, ?3)",
            rusqlite::params![actual_order_id, sync_payload.to_string(), idem],
        );
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &actual_order_id) {
        let _ = app.emit("order_realtime_update", order_json);
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
pub async fn order_delete(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_order_delete_payload(arg0, arg1)?;
    let order_id_raw = payload.order_id;

    let actual_order_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id_raw],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    if let Some(actual_id) = actual_order_id.clone() {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM orders WHERE id = ?1",
            rusqlite::params![actual_id.clone()],
        )
        .map_err(|e| format!("delete order: {e}"))?;
        // Electron parity: order delete remains local-only.
        // Also purge stale queued order delete operations so they cannot poison
        // /api/pos/orders/sync (which only accepts insert/update).
        let _ = conn.execute(
            "DELETE FROM sync_queue
             WHERE entity_type = 'order'
               AND operation = 'delete'
               AND (entity_id = ?1 OR status IN ('pending', 'in_progress', 'failed', 'deferred'))",
            rusqlite::params![actual_id],
        );
        let _ = app.emit("order_deleted", serde_json::json!({ "orderId": actual_id }));
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": actual_order_id
    }))
}

#[tauri::command]
pub async fn order_save_from_remote(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let order_data = payload.get("orderData").cloned().unwrap_or(payload);
    let remote_id = value_str(&order_data, &["id", "supabase_id", "supabaseId"])
        .ok_or("Missing remote order id")?;

    let existing_local_id = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM orders WHERE supabase_id = ?1 OR id = ?1 LIMIT 1",
            rusqlite::params![remote_id.clone()],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };
    if let Some(local_id) = existing_local_id {
        return Ok(serde_json::json!({
            "success": true,
            "orderId": local_id,
            "alreadyExists": true
        }));
    }

    let local_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let items = order_data
        .get("items")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let items_json = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());

    let order_number = value_str(&order_data, &["order_number", "orderNumber"]);
    let customer_name = value_str(&order_data, &["customer_name", "customerName"]);
    let customer_phone = value_str(&order_data, &["customer_phone", "customerPhone"]);
    let customer_email = value_str(&order_data, &["customer_email", "customerEmail"]);
    let total_amount = value_f64(&order_data, &["total_amount", "totalAmount"]).unwrap_or(0.0);
    let tax_amount = value_f64(&order_data, &["tax_amount", "taxAmount"]).unwrap_or(0.0);
    let subtotal = value_f64(&order_data, &["subtotal"]).unwrap_or(0.0);
    let status = normalize_status_for_storage(
        &value_str(&order_data, &["status"]).unwrap_or_else(|| "pending".to_string()),
    );
    let order_type =
        value_str(&order_data, &["order_type", "orderType"]).unwrap_or_else(|| "pickup".into());
    let table_number = value_str(&order_data, &["table_number", "tableNumber"]);
    let delivery_address = value_str(
        &order_data,
        &["delivery_address", "deliveryAddress", "address"],
    );
    let delivery_notes = value_str(&order_data, &["delivery_notes", "deliveryNotes"]);
    let name_on_ringer = value_str(&order_data, &["name_on_ringer", "nameOnRinger"]);
    let special_instructions = value_str(&order_data, &["special_instructions", "notes"]);
    let estimated_time = value_i64(&order_data, &["estimated_time", "estimatedTime"]);
    let payment_status = value_str(&order_data, &["payment_status", "paymentStatus"])
        .unwrap_or_else(|| "pending".into());
    let payment_method = value_str(&order_data, &["payment_method", "paymentMethod"]);
    let payment_tx_id = value_str(
        &order_data,
        &["payment_transaction_id", "paymentTransactionId"],
    );
    let staff_shift_id = value_str(&order_data, &["staff_shift_id", "staffShiftId"]);
    let staff_id = value_str(&order_data, &["staff_id", "staffId"]);
    let discount_pct =
        value_f64(&order_data, &["discount_percentage", "discountPercentage"]).unwrap_or(0.0);
    let discount_amount =
        value_f64(&order_data, &["discount_amount", "discountAmount"]).unwrap_or(0.0);
    let tip_amount = value_f64(&order_data, &["tip_amount", "tipAmount"]).unwrap_or(0.0);
    let tax_rate = value_f64(&order_data, &["tax_rate", "taxRate"]);
    let delivery_fee = value_f64(&order_data, &["delivery_fee", "deliveryFee"]).unwrap_or(0.0);
    let branch_id = value_str(&order_data, &["branch_id", "branchId"])
        .or_else(|| storage::get_credential("branch_id"));
    let terminal_id = value_str(&order_data, &["terminal_id", "terminalId"])
        .or_else(|| storage::get_credential("terminal_id"));
    let plugin = value_str(
        &order_data,
        &["plugin", "platform", "order_plugin", "orderPlatform"],
    );
    let external_plugin_order_id = value_str(
        &order_data,
        &[
            "external_plugin_order_id",
            "externalPluginOrderId",
            "external_platform_order_id",
            "externalPlatformOrderId",
        ],
    );
    let created_at = value_str(&order_data, &["created_at", "createdAt"]).unwrap_or(now.clone());
    let updated_at = value_str(&order_data, &["updated_at", "updatedAt"]).unwrap_or(now.clone());

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO orders (
                id, order_number, customer_name, customer_phone, customer_email,
                items, total_amount, tax_amount, subtotal, status,
                order_type, table_number, delivery_address, delivery_notes,
                name_on_ringer, special_instructions, created_at, updated_at,
                estimated_time, supabase_id, sync_status, payment_status, payment_method,
                payment_transaction_id, staff_shift_id, staff_id, discount_percentage,
                discount_amount, tip_amount, version, terminal_id, branch_id,
                plugin, external_plugin_order_id, tax_rate, delivery_fee
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18,
                ?19, ?20, 'synced', ?21, ?22,
                ?23, ?24, ?25, ?26,
                ?27, ?28, 1, ?29, ?30,
                ?31, ?32, ?33, ?34
            )",
            rusqlite::params![
                local_id,
                order_number,
                customer_name,
                customer_phone,
                customer_email,
                items_json,
                total_amount,
                tax_amount,
                subtotal,
                status,
                order_type,
                table_number,
                delivery_address,
                delivery_notes,
                name_on_ringer,
                special_instructions,
                created_at,
                updated_at,
                estimated_time,
                remote_id,
                payment_status,
                payment_method,
                payment_tx_id,
                staff_shift_id,
                staff_id,
                discount_pct,
                discount_amount,
                tip_amount,
                terminal_id,
                branch_id,
                plugin,
                external_plugin_order_id,
                tax_rate,
                delivery_fee,
            ],
        )
        .map_err(|e| format!("save remote order: {e}"))?;
    }

    if let Ok(order_json) = sync::get_order_by_id(&db, &local_id) {
        let _ = app.emit("order_created", order_json);
    }

    Ok(serde_json::json!({
        "success": true,
        "orderId": local_id
    }))
}

#[tauri::command]
pub async fn order_fetch_items_from_supabase(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .or(arg1)
    .ok_or("Missing orderId")?;

    if let Ok(items_json) = fetch_supabase_rows(
        "order_items",
        &[
            (
                "select",
                "id,menu_item_id,quantity,unit_price,total_price,notes,customizations".to_string(),
            ),
            ("order_id", format!("eq.{}", order_id)),
        ],
    )
    .await
    {
        let rows = items_json.as_array().cloned().unwrap_or_default();
        if !rows.is_empty() {
            let ids: Vec<String> = rows
                .iter()
                .filter_map(|r| {
                    r.get("menu_item_id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect();

            let mut names: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            if !ids.is_empty() {
                if let Ok(subcats) = fetch_supabase_rows(
                    "subcategories",
                    &[
                        ("select", "id,name,name_en,name_el".to_string()),
                        ("id", format!("in.({})", ids.join(","))),
                    ],
                )
                .await
                {
                    if let Some(arr) = subcats.as_array() {
                        for row in arr {
                            if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                                let name = value_str(row, &["name", "name_en", "name_el"])
                                    .unwrap_or_else(|| "Item".to_string());
                                names.insert(id.to_string(), name);
                            }
                        }
                    }
                }
            }

            let transformed: Vec<serde_json::Value> = rows
                .into_iter()
                .enumerate()
                .map(|(i, row)| {
                    let menu_item_id = row.get("menu_item_id").and_then(|v| v.as_str()).unwrap_or("");
                    let quantity = row.get("quantity").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    let unit_price = row.get("unit_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let total_price = row
                        .get("total_price")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(unit_price * quantity);
                    let default_name = format!("Item {}", i + 1);
                    let item_name = names.get(menu_item_id).cloned().unwrap_or(default_name);
                    serde_json::json!({
                        "id": row.get("id").cloned().unwrap_or(serde_json::Value::Null),
                        "menu_item_id": menu_item_id,
                        "name": item_name,
                        "quantity": quantity,
                        "price": unit_price,
                        "unit_price": unit_price,
                        "total_price": total_price,
                        "notes": row.get("notes").cloned().unwrap_or(serde_json::Value::Null),
                        "customizations": row.get("customizations").cloned().unwrap_or(serde_json::Value::Null),
                    })
                })
                .collect();
            return Ok(serde_json::json!(transformed));
        }
    }

    // Fallback: use local order cache (by local ID or Supabase ID).
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let items_str: Option<String> = conn
        .query_row(
            "SELECT items FROM orders WHERE id = ?1 OR supabase_id = ?1 LIMIT 1",
            rusqlite::params![order_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(s) = items_str {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if v.is_array() {
                return Ok(v);
            }
        }
    }
    Ok(serde_json::json!([]))
}

#[tauri::command]
pub async fn order_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    _app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let normalized = payload.get("orderData").cloned().unwrap_or(payload);
    let mut resp = sync::create_order(&db, &normalized)?;
    let order_id = resp
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            resp.get("order")
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    if let Some(order_id) = order_id.clone() {
        if let Some(obj) = resp.as_object_mut() {
            obj.entry("orderId".to_string())
                .or_insert_with(|| serde_json::Value::String(order_id.clone()));
            obj.entry("data".to_string())
                .or_insert_with(|| serde_json::json!({ "orderId": order_id.clone() }));
        }
    }

    // NOTE: We intentionally do NOT emit order_created/order_realtime_update here.
    // Self-created orders are added to state directly in the frontend store.
    // Only order_save_from_remote() emits these events (for orders from other terminals).
    Ok(resp)
}

#[tauri::command]
pub async fn orders_clear_all(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count = conn
        .execute("DELETE FROM orders", [])
        .map_err(|e| e.to_string())?;
    let _ = app.emit("orders_cleared", serde_json::json!({ "count": count }));
    Ok(serde_json::json!({
        "success": true,
        "cleared": count
    }))
}

#[tauri::command]
pub async fn orders_get_conflicts() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([]))
}

#[tauri::command]
pub async fn orders_resolve_conflict(
    arg0: Option<String>,
    arg1: Option<String>,
    _arg2: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conflict_id = arg0.unwrap_or_default();
    let strategy = arg1.unwrap_or_else(|| "server_wins".to_string());
    let _ = app.emit(
        "order_conflict_resolved",
        serde_json::json!({
            "conflictId": conflict_id,
            "strategy": strategy
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "conflictId": conflict_id,
        "strategy": strategy
    }))
}

#[tauri::command]
pub async fn order_approve(
    arg0: Option<String>,
    arg1: Option<i64>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let estimated_time = arg1;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET status = 'confirmed',
             estimated_time = COALESCE(?1, estimated_time),
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![estimated_time, now, order_id],
    )
    .map_err(|e| format!("approve order: {e}"))?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "status": "confirmed",
        "estimatedTime": estimated_time
    });
    let idem = format!(
        "order:approve:{}:{}",
        order_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'update', ?2, ?3)",
        rusqlite::params![order_id, payload.to_string(), idem],
    );
    drop(conn);

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(
        serde_json::json!({ "success": true, "orderId": order_id_raw, "estimatedTime": estimated_time }),
    )
}

#[tauri::command]
pub async fn order_decline(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let reason = arg1.unwrap_or_else(|| "Declined".to_string());
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = ?1,
             sync_status = 'pending',
             updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![reason, now, order_id],
    )
    .map_err(|e| format!("decline order: {e}"))?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "status": "cancelled",
        "reason": reason
    });
    let idem = format!(
        "order:decline:{}:{}",
        order_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'update', ?2, ?3)",
        rusqlite::params![order_id, payload.to_string(), idem],
    );
    drop(conn);

    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true, "orderId": order_id_raw }))
}

#[tauri::command]
pub async fn order_assign_driver(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let driver_id = arg1.ok_or("Missing driverId")?;
    let notes = arg2;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET staff_id = ?1,
             delivery_notes = COALESCE(?2, delivery_notes),
             sync_status = 'pending',
             updated_at = ?3
         WHERE id = ?4",
        rusqlite::params![driver_id, notes, now, order_id],
    )
    .map_err(|e| format!("assign driver: {e}"))?;
    drop(conn);

    let payload = serde_json::json!({
        "orderId": order_id_raw,
        "driverId": driver_id,
        "notes": notes
    });
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

#[tauri::command]
pub async fn order_notify_platform_ready(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE orders SET status = 'ready', sync_status = 'pending', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, order_id],
    )
    .map_err(|e| format!("set ready status: {e}"))?;
    drop(conn);
    let payload = serde_json::json!({ "orderId": order_id_raw, "status": "ready" });
    let _ = app.emit("order_status_updated", payload.clone());
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn order_update_preparation(
    arg0: Option<String>,
    arg1: Option<String>,
    arg2: Option<f64>,
    arg3: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id = arg0.ok_or("Missing orderId")?;
    let stage = arg1.unwrap_or_else(|| "preparing".to_string());
    let progress = arg2.unwrap_or(0.0).clamp(0.0, 100.0);
    let message = arg3;
    let mut all = read_local_json_array(&db, "order_preparation_states")?;
    all.retain(|item| {
        item.get("orderId")
            .and_then(|v| v.as_str())
            .map(|v| v != order_id)
            .unwrap_or(true)
    });
    all.push(serde_json::json!({
        "orderId": order_id,
        "stage": stage,
        "progress": progress,
        "message": message,
        "updatedAt": Utc::now().to_rfc3339()
    }));
    write_local_json(
        &db,
        "order_preparation_states",
        &serde_json::Value::Array(all),
    )?;

    let payload = serde_json::json!({
        "orderId": order_id,
        "preparationStage": stage,
        "preparationProgress": progress,
        "message": message
    });
    let _ = app.emit("order_realtime_update", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

#[tauri::command]
pub async fn order_update_type(
    arg0: Option<String>,
    arg1: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let order_type = arg1.ok_or("Missing orderType")?;
    let now = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders SET order_type = ?1, sync_status = 'pending', updated_at = ?2 WHERE id = ?3",
        rusqlite::params![order_type, now, order_id],
    )
    .map_err(|e| format!("update order type: {e}"))?;
    let payload = serde_json::json!({
        "orderId": order_id,
        "orderType": order_type
    });
    let idem = format!(
        "order:update-type:{}:{}",
        order_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('order', ?1, 'update', ?2, ?3)",
        rusqlite::params![order_id, payload.to_string(), idem],
    );
    drop(conn);
    let _ = app.emit("order_realtime_update", payload);
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn order_save_for_retry(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing order payload")?;
    let mut queue = read_local_json_array(&db, "order_retry_queue")?;
    queue.push(serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "order": payload,
        "retryCount": 0,
        "savedAt": Utc::now().to_rfc3339()
    }));
    write_local_json(
        &db,
        "order_retry_queue",
        &serde_json::Value::Array(queue.clone()),
    )?;
    let _ = app.emit(
        "order_sync_conflict",
        serde_json::json!({ "queueLength": queue.len() }),
    );
    Ok(serde_json::json!({ "success": true, "queueLength": queue.len() }))
}

#[tauri::command]
pub async fn order_get_retry_queue(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let queue = read_local_json_array(&db, "order_retry_queue")?;
    Ok(serde_json::json!(queue))
}

#[tauri::command]
pub async fn order_process_retry_queue(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let queue = read_local_json_array(&db, "order_retry_queue")?;
    let mut remaining: Vec<serde_json::Value> = Vec::new();
    let mut processed = 0usize;
    for mut item in queue {
        let order_payload = item
            .get("order")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let result = sync::create_order(&db, &order_payload);
        if result.is_ok() {
            processed += 1;
            continue;
        }
        let retry_count = item.get("retryCount").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        if let Some(obj) = item.as_object_mut() {
            obj.insert("retryCount".to_string(), serde_json::json!(retry_count));
            obj.insert(
                "lastAttemptAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
            if let Err(err) = result {
                obj.insert("lastError".to_string(), serde_json::json!(err));
            }
        }
        if retry_count < 3 {
            remaining.push(item);
        }
    }
    write_local_json(
        &db,
        "order_retry_queue",
        &serde_json::Value::Array(remaining.clone()),
    )?;
    let _ = app.emit(
        "sync_retry_scheduled",
        serde_json::json!({
            "processed": processed,
            "remaining": remaining.len()
        }),
    );
    Ok(serde_json::json!({
        "success": true,
        "processed": processed,
        "remaining": remaining.len()
    }))
}

#[tauri::command]
pub async fn orders_force_sync_retry(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    let updated = conn
        .execute(
            "UPDATE sync_queue
             SET status = 'pending', retry_count = 0, last_error = NULL, updated_at = datetime('now')
             WHERE entity_type = 'order' AND entity_id = ?1",
            rusqlite::params![order_id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        let fallback_payload = serde_json::json!({ "orderId": order_id_raw });
        let idem = format!(
            "order:force-retry:{}:{}",
            order_id_raw,
            Utc::now().timestamp_millis()
        );
        let _ = conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('order', ?1, 'update', ?2, ?3)",
            rusqlite::params![order_id_raw, fallback_payload.to_string(), idem],
        );
    }
    Ok(serde_json::json!({ "success": true, "orderId": order_id_raw, "updated": updated }))
}

#[tauri::command]
pub async fn orders_get_retry_info(
    arg0: Option<String>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id_raw = arg0.ok_or("Missing orderId")?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).unwrap_or(order_id_raw.clone());
    let mut stmt = conn
        .prepare(
            "SELECT id, status, retry_count, max_retries, last_error, created_at, updated_at
             FROM sync_queue
             WHERE entity_type = 'order' AND entity_id = ?1
             ORDER BY id DESC
             LIMIT 5",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![order_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "status": row.get::<_, String>(1)?,
                "retryCount": row.get::<_, i64>(2)?,
                "maxRetries": row.get::<_, i64>(3)?,
                "lastError": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, String>(5)?,
                "updatedAt": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let entries: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({
        "success": true,
        "orderId": order_id_raw,
        "entries": entries,
        "hasRetries": !entries.is_empty()
    }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_status_payload_supports_legacy_shape() {
        let parsed = parse_order_update_status_payload(
            Some(serde_json::json!("order-1")),
            Some("approved".to_string()),
        )
        .expect("legacy status payload should parse");
        assert_eq!(parsed.order_id, "order-1");
        assert_eq!(parsed.status, "approved");
        assert_eq!(parsed.estimated_time, None);
    }

    #[test]
    fn parse_status_payload_supports_object_with_fallback_status_arg() {
        let parsed = parse_order_update_status_payload(
            Some(serde_json::json!({
                "orderId": "order-2",
                "estimatedTime": 18
            })),
            Some("confirmed".to_string()),
        )
        .expect("object status payload should parse");
        assert_eq!(parsed.order_id, "order-2");
        assert_eq!(parsed.status, "confirmed");
        assert_eq!(parsed.estimated_time, Some(18));
    }

    #[test]
    fn parse_items_payload_supports_legacy_tuple_shape() {
        let parsed = parse_order_update_items_payload(
            Some(serde_json::json!("order-3")),
            Some(serde_json::json!([
                { "name": "Item", "quantity": 2, "price": 3.5 }
            ])),
        )
        .expect("legacy items payload should parse");
        assert_eq!(parsed.order_id, "order-3");
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(parsed.order_notes, None);
    }

    #[test]
    fn parse_items_payload_rejects_non_array_items() {
        let err = parse_order_update_items_payload(
            Some(serde_json::json!({
                "orderId": "order-4",
                "items": "invalid"
            })),
            None,
        )
        .expect_err("non-array items should be rejected");
        assert!(err.contains("items must be an array"));
    }

    #[test]
    fn parse_delete_payload_supports_arg1_fallback() {
        let parsed =
            parse_order_delete_payload(Some(serde_json::json!({})), Some("order-5".into()))
                .expect("delete payload should parse");
        assert_eq!(parsed.order_id, "order-5");
    }
}
