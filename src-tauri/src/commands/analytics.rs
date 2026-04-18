use chrono::{Local, Utc};
use rusqlite::params;
use serde::Deserialize;
use serde_json::Value;
use std::cmp::Ordering;
use tauri::Emitter;
use tracing::{info, warn};

use crate::{db, order_ownership, payment_integrity, payments, print, value_str, zreport};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverShiftPayload {
    #[serde(
        alias = "shift_id",
        alias = "staffShiftId",
        alias = "staff_shift_id",
        alias = "id"
    )]
    shift_id: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DriverBranchPayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DeliveryZoneAnalyticsPayload {
    #[serde(default, alias = "zone_id")]
    zone_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReportTodayStatisticsPayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReportSalesTrendPayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default)]
    days: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReportTopItemsPayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReportWeeklyTopItemsPayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReportDailyStaffPerformancePayload {
    #[serde(default, alias = "branch_id")]
    branch_id: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvePaymentBlockerPayload {
    #[serde(alias = "order_id")]
    order_id: String,
    method: String,
}

fn normalize_payload_with_branch(arg0: Option<serde_json::Value>) -> serde_json::Value {
    match arg0 {
        Some(serde_json::Value::String(branch_id)) => serde_json::json!({
            "branchId": branch_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    }
}

fn parse_driver_shift_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(shift_id)) => serde_json::json!({
            "shiftId": shift_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: DriverShiftPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid shift payload: {e}"))?;
    parsed.shift_id = parsed.shift_id.trim().to_string();
    if parsed.shift_id.is_empty() {
        return Err("Missing shiftId".into());
    }
    Ok(parsed.shift_id)
}

fn parse_driver_branch_payload(arg0: Option<serde_json::Value>) -> String {
    let payload = normalize_payload_with_branch(arg0);
    let parsed: DriverBranchPayload = serde_json::from_value(payload).unwrap_or_default();
    parsed
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default()
}

fn parse_resolve_payment_blocker_payload(
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or_else(|| serde_json::json!({}));
    let mut parsed: ResolvePaymentBlockerPayload = serde_json::from_value(payload.clone())
        .map_err(|e| format!("Invalid payment blocker repair payload: {e}"))?;
    parsed.order_id = parsed.order_id.trim().to_string();
    parsed.method = parsed.method.trim().to_ascii_lowercase();
    if parsed.order_id.is_empty() {
        return Err("Missing orderId".into());
    }
    if parsed.method != "cash" && parsed.method != "card" {
        return Err("Method must be cash or card".into());
    }
    Ok(serde_json::json!({
        "orderId": parsed.order_id,
        "method": parsed.method,
    }))
}

fn parse_delivery_zone_analytics_payload(arg0: Option<serde_json::Value>) -> Option<String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(zone_id)) => serde_json::json!({
            "zoneId": zone_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let parsed: DeliveryZoneAnalyticsPayload = serde_json::from_value(payload).unwrap_or_default();
    parsed
        .zone_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_report_today_statistics_payload(
    arg0: Option<serde_json::Value>,
) -> ReportTodayStatisticsPayload {
    let payload = normalize_payload_with_branch(arg0);
    serde_json::from_value(payload).unwrap_or_default()
}

fn parse_report_sales_trend_payload(arg0: Option<serde_json::Value>) -> ReportSalesTrendPayload {
    let payload = normalize_payload_with_branch(arg0);
    serde_json::from_value(payload).unwrap_or_default()
}

fn parse_report_top_items_payload(arg0: Option<serde_json::Value>) -> ReportTopItemsPayload {
    let payload = normalize_payload_with_branch(arg0);
    serde_json::from_value(payload).unwrap_or_default()
}

fn parse_report_weekly_top_items_payload(
    arg0: Option<serde_json::Value>,
) -> ReportWeeklyTopItemsPayload {
    let payload = normalize_payload_with_branch(arg0);
    serde_json::from_value(payload).unwrap_or_default()
}

fn parse_report_daily_staff_performance_payload(
    arg0: Option<serde_json::Value>,
) -> ReportDailyStaffPerformancePayload {
    let payload = normalize_payload_with_branch(arg0);
    serde_json::from_value(payload).unwrap_or_default()
}

fn resolve_report_date(optional_date: Option<String>) -> String {
    optional_date
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string())
}

fn is_cancelled_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "cancelled" | "canceled"
    )
}

#[derive(Debug, Clone)]
struct AggregatedTopItem {
    menu_item_id: String,
    name: String,
    quantity: f64,
    revenue: f64,
    category_id: Option<String>,
}

fn truthy_from_keys(value: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| {
        value.get(*key).is_some_and(|raw| match raw {
            Value::Bool(flag) => *flag,
            Value::Number(num) => num.as_i64().map(|v| v != 0).unwrap_or(false),
            Value::String(text) => matches!(
                text.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            ),
            _ => false,
        })
    })
}

fn parse_top_item_quantity(item: &Value) -> f64 {
    let quantity = crate::value_f64(item, &["quantity"]).unwrap_or(1.0);
    if quantity > 0.0 {
        quantity
    } else {
        1.0
    }
}

fn parse_top_item_revenue(item: &Value, quantity: f64) -> f64 {
    crate::value_f64(item, &["total_price", "totalPrice"])
        .unwrap_or_else(|| {
            crate::value_f64(item, &["unit_price", "unitPrice", "price"]).unwrap_or(0.0) * quantity
        })
        .max(0.0)
}

fn normalize_top_item_menu_item_id(item: &Value) -> Option<String> {
    value_str(item, &["menu_item_id", "menuItemId"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("manual"))
}

fn aggregate_top_items_from_order_rows(
    orders: impl IntoIterator<Item = (String, String)>,
) -> Vec<AggregatedTopItem> {
    let mut by_menu_item_id: std::collections::HashMap<String, AggregatedTopItem> =
        std::collections::HashMap::new();

    for (status, items_json) in orders {
        if is_cancelled_status(&status) {
            continue;
        }

        let parsed =
            serde_json::from_str::<Value>(&items_json).unwrap_or_else(|_| serde_json::json!([]));
        let Some(items) = parsed.as_array() else {
            continue;
        };

        for item in items {
            if truthy_from_keys(item, &["is_manual", "isManual"])
                || truthy_from_keys(item, &["is_combo", "isCombo"])
                || value_str(item, &["combo_id", "comboId"]).is_some()
            {
                continue;
            }

            let Some(menu_item_id) = normalize_top_item_menu_item_id(item) else {
                continue;
            };

            let quantity = parse_top_item_quantity(item);
            let revenue = parse_top_item_revenue(item, quantity);
            let item_name = value_str(item, &["name", "item_name", "title"])
                .unwrap_or_else(|| "Item".to_string());
            let category_id = value_str(item, &["category_id", "categoryId"]).and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            });

            let entry = by_menu_item_id
                .entry(menu_item_id.clone())
                .or_insert_with(|| AggregatedTopItem {
                    menu_item_id: menu_item_id.clone(),
                    name: item_name.clone(),
                    quantity: 0.0,
                    revenue: 0.0,
                    category_id: category_id.clone(),
                });

            if (entry.name.trim().is_empty() || entry.name == "Item")
                && !item_name.trim().is_empty()
            {
                entry.name = item_name;
            }
            if entry.category_id.is_none() && category_id.is_some() {
                entry.category_id = category_id;
            }

            entry.quantity += quantity;
            entry.revenue += revenue;
        }
    }

    let mut items: Vec<AggregatedTopItem> = by_menu_item_id.into_values().collect();
    items.sort_by(|left, right| {
        right
            .quantity
            .partial_cmp(&left.quantity)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                right
                    .revenue
                    .partial_cmp(&left.revenue)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.name.cmp(&right.name))
    });
    items
}

fn top_items_to_json(items: Vec<AggregatedTopItem>, limit: usize) -> Vec<serde_json::Value> {
    items
        .into_iter()
        .take(limit)
        .map(|item| {
            serde_json::json!({
                "menuItemId": item.menu_item_id,
                "name": item.name,
                "quantity": item.quantity,
                "revenue": item.revenue,
                "categoryId": item.category_id,
            })
        })
        .collect()
}

#[allow(clippy::type_complexity)]
fn load_report_rows_for_day(
    conn: &rusqlite::Connection,
    branch_id: &str,
    date: &str,
) -> Result<Vec<(String, String, Option<String>, Option<String>, f64, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT status, created_at, payment_method, order_type, COALESCE(total_amount, 0), items
             FROM orders
             WHERE (?1 = '' OR branch_id = ?1)
               AND COALESCE(is_ghost, 0) = 0
               AND substr(created_at, 1, 10) = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![branch_id, date], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn extract_z_report_id_from_payload(payload: &serde_json::Value) -> Option<String> {
    crate::value_str(payload, &["zReportId", "z_report_id", "id"])
        .or_else(|| {
            payload.get("snapshot").and_then(|snapshot| {
                crate::value_str(snapshot, &["id", "zReportId", "z_report_id"])
            })
        })
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
}

#[allow(dead_code)]
fn number_from_value(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|v| v as f64))
        .or_else(|| value.as_u64().map(|v| v as f64))
}

#[allow(dead_code)]
fn number_from_pointers(value: &serde_json::Value, pointers: &[&str]) -> Option<f64> {
    for pointer in pointers {
        if let Some(v) = value.pointer(pointer).and_then(number_from_value) {
            return Some(v);
        }
    }
    None
}

fn string_from_pointers(value: &serde_json::Value, pointers: &[&str]) -> Option<String> {
    for pointer in pointers {
        if let Some(v) = value
            .pointer(pointer)
            .and_then(|raw| raw.as_str())
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty())
        {
            return Some(v);
        }
    }
    None
}

fn snapshot_or_payload(payload: &serde_json::Value) -> Option<serde_json::Value> {
    payload.get("snapshot").cloned().or_else(|| {
        if payload.get("sales").is_some()
            || payload.get("cashDrawer").is_some()
            || payload.get("driverEarnings").is_some()
            || payload.get("date").is_some()
        {
            Some(payload.clone())
        } else {
            None
        }
    })
}

fn flatten_generated_z_report_data(generated: &serde_json::Value) -> serde_json::Value {
    let mut report_data = match generated
        .get("report")
        .and_then(|report| report.get("reportJson"))
    {
        Some(serde_json::Value::String(raw)) => {
            serde_json::from_str::<serde_json::Value>(raw).unwrap_or_else(|_| generated.clone())
        }
        Some(value) => value.clone(),
        None => generated.clone(),
    };
    let Some(report) = generated.get("report") else {
        return report_data;
    };
    let Some(obj) = report_data.as_object_mut() else {
        return report_data;
    };

    for (key, value) in [
        ("shiftId", value_str(report, &["shiftId", "shift_id"])),
        (
            "terminalId",
            value_str(report, &["terminalId", "terminal_id"]),
        ),
        (
            "terminalName",
            value_str(report, &["terminalName", "terminal_name"]),
        ),
    ] {
        if !obj.contains_key(key) {
            if let Some(value) = value {
                obj.insert(key.to_string(), serde_json::Value::String(value));
            }
        }
    }

    if !obj.contains_key("shiftCount") {
        if let Some(count) = number_from_pointers(
            report,
            &[
                "/shiftCount",
                "/shift_count",
                "/reportJson/shifts/total",
                "/shifts/total",
            ],
        ) {
            obj.insert(
                "shiftCount".to_string(),
                serde_json::json!(count.round() as i64),
            );
        }
    }

    let period_start = obj
        .get("periodStart")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            obj.get("period")
                .and_then(|period| period.get("start"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        });
    let period_end = obj
        .get("periodEnd")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            obj.get("period")
                .and_then(|period| period.get("end"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        });

    if !obj.contains_key("period") && (period_start.is_some() || period_end.is_some()) {
        obj.insert(
            "period".to_string(),
            serde_json::json!({
                "start": period_start.clone(),
                "end": period_end.clone(),
            }),
        );
    }

    if !obj.contains_key("periodStart") {
        if let Some(period_start) = period_start {
            obj.insert(
                "periodStart".to_string(),
                serde_json::Value::String(period_start),
            );
        }
    }

    if !obj.contains_key("periodEnd") {
        if let Some(period_end) = period_end {
            obj.insert(
                "periodEnd".to_string(),
                serde_json::Value::String(period_end),
            );
        }
    }

    report_data
}

fn normalize_report_generate_payload(arg0: Option<serde_json::Value>) -> serde_json::Value {
    match arg0 {
        Some(serde_json::Value::String(shift_id)) => serde_json::json!({
            "shiftId": shift_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    }
}

#[tauri::command]
pub async fn driver_record_earning(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let driver_id =
        crate::value_str(&payload, &["driverId", "driver_id"]).ok_or("Missing driverId")?;
    let shift_id = crate::value_str(
        &payload,
        &["shiftId", "shift_id", "staffShiftId", "staff_shift_id"],
    );
    let order_id = crate::value_str(&payload, &["orderId", "order_id"]).ok_or("Missing orderId")?;
    let now = Utc::now().to_rfc3339();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let resolved_shift_id =
        order_ownership::resolve_driver_shift_id(&conn, &driver_id, shift_id.as_deref())?
            .ok_or("No active driver shift found")?;

    let assignment = order_ownership::assign_order_to_driver_shift(
        &conn,
        &order_id,
        &driver_id,
        None,
        &resolved_shift_id,
        &now,
    )?;

    let earning_id =
        order_ownership::upsert_driver_earning(&conn, &order_id, &driver_id, &assignment, &now)?;

    info!("Recorded driver earning {earning_id} for order {order_id}");

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "id": earning_id,
            "driverId": driver_id,
            "shiftId": resolved_shift_id,
            "orderId": order_id,
            "branchId": assignment.branch_id,
            "deliveryFee": assignment.delivery_fee,
            "tipAmount": assignment.tip_amount,
            "totalEarning": assignment.delivery_fee + assignment.tip_amount,
            "paymentMethod": assignment.payment_method,
            "cashCollected": assignment.cash_collected,
            "cardAmount": assignment.card_amount,
            "cashToReturn": assignment.cash_collected,
            "settled": false,
            "createdAt": now,
            "updatedAt": now
        }
    }))
}

#[tauri::command]
pub async fn driver_get_earnings(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let shift_id = parse_driver_shift_payload(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, driver_id, staff_shift_id, order_id, branch_id,
                    delivery_fee, tip_amount, total_earning,
                    payment_method, cash_collected, card_amount, cash_to_return,
                    order_details, settled, settled_at, settlement_batch_id,
                    is_transferred, supabase_id, created_at, updated_at
             FROM driver_earnings
             WHERE staff_shift_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("driver_get_earnings prepare: {e}"))?;

    let rows = stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "driver_id": row.get::<_, String>(1)?,
                "staff_shift_id": row.get::<_, Option<String>>(2)?,
                "order_id": row.get::<_, String>(3)?,
                "branch_id": row.get::<_, String>(4)?,
                "delivery_fee": row.get::<_, f64>(5)?,
                "tip_amount": row.get::<_, f64>(6)?,
                "total_earning": row.get::<_, f64>(7)?,
                "payment_method": row.get::<_, String>(8)?,
                "cash_collected": row.get::<_, f64>(9)?,
                "card_amount": row.get::<_, f64>(10)?,
                "cash_to_return": row.get::<_, f64>(11)?,
                "order_details": row.get::<_, Option<String>>(12)?,
                "settled": row.get::<_, i32>(13)? != 0,
                "settled_at": row.get::<_, Option<String>>(14)?,
                "settlement_batch_id": row.get::<_, Option<String>>(15)?,
                "is_transferred": row.get::<_, i32>(16)? != 0,
                "supabase_id": row.get::<_, Option<String>>(17)?,
                "created_at": row.get::<_, String>(18)?,
                "updated_at": row.get::<_, String>(19)?,
            }))
        })
        .map_err(|e| format!("driver_get_earnings query: {e}"))?;

    let mut result = Vec::new();
    for row in rows {
        match row {
            Ok(v) => result.push(v),
            Err(e) => warn!("driver_get_earnings row error: {e}"),
        }
    }
    Ok(serde_json::json!(result))
}

#[tauri::command]
pub async fn driver_get_shift_summary(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let shift_id = parse_driver_shift_payload(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let (
        count,
        total_fees,
        total_tips,
        total_earnings,
        cash_collected,
        card_amount,
        cash_to_return,
    ): (i64, f64, f64, f64, f64, f64, f64) = conn
        .query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(delivery_fee), 0),
                COALESCE(SUM(tip_amount), 0),
                COALESCE(SUM(total_earning), 0),
                COALESCE(SUM(cash_collected), 0),
                COALESCE(SUM(card_amount), 0),
                COALESCE(SUM(cash_to_return), 0)
             FROM driver_earnings
             WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|e| format!("driver_get_shift_summary query: {e}"))?;

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "shiftId": shift_id,
            "entries": count,
            "totalDeliveries": count,
            "totalDeliveryFees": total_fees,
            "totalTips": total_tips,
            "totalEarnings": total_earnings,
            "cashCollected": cash_collected,
            "totalCashCollected": cash_collected,
            "cardAmount": card_amount,
            "totalCardAmount": card_amount,
            "totalCashToReturn": cash_to_return
        }
    }))
}

#[tauri::command]
pub async fn driver_get_active(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let branch_id = parse_driver_branch_payload(arg0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT ss.id, ss.staff_id,
                    COALESCE(
                        NULLIF(TRIM(ss.staff_name), ''),
                        (SELECT s2.staff_name FROM staff_shifts s2
                         WHERE s2.staff_id = ss.staff_id
                           AND TRIM(COALESCE(s2.staff_name, '')) <> ''
                         ORDER BY s2.check_in_time DESC LIMIT 1)
                    ) AS resolved_name,
                    ss.branch_id, ss.check_in_time,
                    COALESCE(oc.active_count, 0) AS active_order_count
             FROM staff_shifts ss
             LEFT JOIN (
                 SELECT driver_id, COUNT(*) AS active_count
                 FROM orders
                 WHERE LOWER(COALESCE(order_type, '')) = 'delivery'
                   AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled', 'voided', 'delivered')
                   AND driver_id IS NOT NULL
                 GROUP BY driver_id
             ) oc ON oc.driver_id = ss.staff_id
             WHERE ss.role_type = 'driver' AND ss.status = 'active'
               AND (?1 = '' OR ss.branch_id = ?1)
             ORDER BY ss.check_in_time ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![branch_id], |row| {
            let staff_id: String = row.get(1)?;
            let staff_name: Option<String> = row.get(2)?;
            let active_count: i64 = row.get(5)?;
            let status = if active_count > 0 {
                "busy"
            } else {
                "available"
            };
            Ok(serde_json::json!({
                // Fields matching the frontend Driver interface
                "id": &staff_id,
                "name": staff_name.as_deref().unwrap_or(""),
                "phone": "",
                "status": status,
                "current_orders": active_count,
                "assignable": true,
                "availabilityReason": "active",
                // Backward-compatible fields
                "shiftId": row.get::<_, String>(0)?,
                "staffId": &staff_id,
                "staffName": &staff_name,
                "branchId": row.get::<_, Option<String>>(3)?,
                "checkInTime": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let data: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({ "success": true, "data": data }))
}

#[tauri::command]
pub async fn delivery_zone_track_validation(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let mut payload = arg0.unwrap_or(serde_json::json!({}));
    let id = crate::value_str(&payload, &["id"])
        .unwrap_or_else(|| format!("dzv-{}", uuid::Uuid::new_v4()));
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".to_string(), serde_json::json!(id));
        obj.entry("timestamp".to_string())
            .or_insert(serde_json::json!(Utc::now().to_rfc3339()));
    }
    let mut logs = crate::read_local_json_array(&db, "delivery_validation_logs_v1")?;
    logs.push(payload.clone());
    crate::write_local_json(
        &db,
        "delivery_validation_logs_v1",
        &serde_json::Value::Array(logs),
    )?;
    Ok(serde_json::json!({ "success": true, "data": payload, "aggregated": false }))
}

#[tauri::command]
pub async fn delivery_zone_get_analytics(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let zone_filter = parse_delivery_zone_analytics_payload(arg0);
    let logs = crate::read_local_json_array(&db, "delivery_validation_logs_v1")?;
    let mut total = 0i64;
    let mut valid = 0i64;
    let mut overrides = 0i64;
    for row in logs {
        if let Some(zone) = zone_filter.as_ref() {
            let zid = crate::value_str(&row, &["zoneId", "zone_id"]).unwrap_or_default();
            if &zid != zone {
                continue;
            }
        }
        total += 1;
        let result = crate::value_str(&row, &["result"])
            .unwrap_or_default()
            .to_lowercase();
        if matches!(result.as_str(), "valid" | "ok" | "success" | "inside_zone") {
            valid += 1;
        }
        if row
            .get("overrideApplied")
            .or_else(|| row.get("override_applied"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            overrides += 1;
        }
    }
    Ok(serde_json::json!({
        "success": true,
        "data": [{
            "zoneId": zone_filter,
            "totalValidations": total,
            "validCount": valid,
            "invalidCount": total - valid,
            "overrideCount": overrides,
            "validRate": if total > 0 { (valid as f64) / (total as f64) } else { 0.0 }
        }]
    }))
}

#[tauri::command]
pub async fn delivery_zone_request_override(
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    Ok(serde_json::json!({
        "success": true,
        "data": {
            "approved": true,
            "requestedAt": Utc::now().to_rfc3339(),
            "request": payload
        }
    }))
}

#[tauri::command]
pub async fn report_get_today_statistics(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_today_statistics_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let date = payload
        .date
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = crate::load_orders_for_period(&conn, &branch_id, &date, &date)?;
    let mut total_sales = 0.0f64;
    let mut completed = 0i64;
    let mut cancelled = 0i64;
    for (_id, status, _created_at, items_json, _staff, _payment_method) in &orders {
        let (order_total, _) = crate::parse_item_totals(items_json);
        total_sales += order_total;
        let st = status.to_lowercase();
        if matches!(
            st.as_str(),
            "completed" | "delivered" | "approved" | "ready"
        ) {
            completed += 1;
        }
        if matches!(st.as_str(), "cancelled" | "canceled" | "declined") {
            cancelled += 1;
        }
    }
    let total_orders = orders.len() as i64;
    let avg = if total_orders > 0 {
        total_sales / (total_orders as f64)
    } else {
        0.0
    };
    Ok(serde_json::json!({
        "success": true,
        "totalOrders": total_orders,
        "completedOrders": completed,
        "cancelledOrders": cancelled,
        "totalSales": total_sales,
        "averageOrderValue": avg
    }))
}

#[tauri::command]
pub async fn report_get_sales_trend(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_sales_trend_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let days = payload.days.unwrap_or(7).clamp(1, 60);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut points: Vec<serde_json::Value> = Vec::new();
    for i in (0..days).rev() {
        let date = (Local::now() - chrono::Duration::days(i))
            .format("%Y-%m-%d")
            .to_string();
        let orders = crate::load_orders_for_period(&conn, &branch_id, &date, &date)?;
        let mut total = 0.0f64;
        for (_id, _status, _created, items, _staff, _payment_method) in orders.iter() {
            let (order_total, _) = crate::parse_item_totals(items);
            total += order_total;
        }
        points.push(serde_json::json!({
            "date": date,
            "sales": total,
            "orders": orders.len()
        }));
    }
    Ok(serde_json::json!({ "success": true, "data": points }))
}

#[tauri::command]
pub async fn report_get_top_items(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_top_items_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let date = payload
        .date
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let limit = payload.limit.unwrap_or(10).clamp(1, 50) as usize;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = crate::load_orders_for_period(&conn, &branch_id, &date, &date)?;
    let aggregated = aggregate_top_items_from_order_rows(
        orders
            .into_iter()
            .map(|(_id, status, _created, items, _staff, _payment_method)| (status, items)),
    );
    let top = top_items_to_json(aggregated, limit);
    Ok(serde_json::json!({ "success": true, "data": top }))
}

#[tauri::command]
pub async fn report_get_weekly_top_items(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_weekly_top_items_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let limit = payload.limit.unwrap_or(10).clamp(1, 50) as usize;
    let today = Local::now().format("%Y-%m-%d").to_string();
    let from = (Local::now() - chrono::Duration::days(6))
        .format("%Y-%m-%d")
        .to_string();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = crate::load_orders_for_period(&conn, &branch_id, &from, &today)?;
    let aggregated = aggregate_top_items_from_order_rows(
        orders
            .into_iter()
            .map(|(_id, status, _created, items, _staff, _payment_method)| (status, items)),
    );
    let top = top_items_to_json(aggregated, limit);
    Ok(serde_json::json!({ "success": true, "data": top }))
}

#[tauri::command]
pub async fn report_get_daily_staff_performance(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_daily_staff_performance_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let date = payload
        .date
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let orders = crate::load_orders_for_period(&conn, &branch_id, &date, &date)?;
    let mut perf: std::collections::HashMap<String, (i64, f64)> = std::collections::HashMap::new();
    for (_id, _status, _created, items, staff, _payment_method) in orders {
        let staff_id = staff.unwrap_or_else(|| "unknown".to_string());
        let (total, _) = crate::parse_item_totals(&items);
        let entry = perf.entry(staff_id).or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 += total;
    }
    let data: Vec<serde_json::Value> = perf
        .into_iter()
        .map(|(staff_id, (orders_count, sales_total))| {
            serde_json::json!({
                "staffId": staff_id,
                "orders": orders_count,
                "sales": sales_total
            })
        })
        .collect();
    Ok(serde_json::json!({ "success": true, "data": data }))
}

#[tauri::command]
pub async fn report_get_hourly_sales(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_today_statistics_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let date = resolve_report_date(payload.date);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let rows = load_report_rows_for_day(&conn, &branch_id, &date)?;

    let mut hourly_orders = [0i64; 24];
    let mut hourly_revenue = [0.0f64; 24];

    for (status, created_at, _payment_method, _order_type, total_amount, items) in rows {
        if is_cancelled_status(&status) {
            continue;
        }
        let hour = created_at
            .get(11..13)
            .and_then(|raw| raw.parse::<usize>().ok())
            .filter(|h| *h < 24)
            .unwrap_or(0);
        let revenue = if total_amount > 0.0 {
            total_amount
        } else {
            crate::parse_item_totals(&items).0
        };
        hourly_orders[hour] += 1;
        hourly_revenue[hour] += revenue;
    }

    let data: Vec<serde_json::Value> = (0..24)
        .map(|hour| {
            serde_json::json!({
                "hour": hour,
                "orders": hourly_orders[hour],
                "revenue": hourly_revenue[hour],
            })
        })
        .collect();

    Ok(serde_json::json!({ "success": true, "data": data }))
}

#[tauri::command]
pub async fn report_get_payment_method_breakdown(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_today_statistics_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let date = resolve_report_date(payload.date);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let rows = load_report_rows_for_day(&conn, &branch_id, &date)?;

    let mut cash_count = 0i64;
    let mut cash_total = 0.0f64;
    let mut card_count = 0i64;
    let mut card_total = 0.0f64;

    for (status, _created_at, payment_method, _order_type, total_amount, items) in rows {
        if is_cancelled_status(&status) {
            continue;
        }
        let method = payment_method.unwrap_or_default().to_ascii_lowercase();
        let revenue = if total_amount > 0.0 {
            total_amount
        } else {
            crate::parse_item_totals(&items).0
        };

        if method.contains("cash") {
            cash_count += 1;
            cash_total += revenue;
        } else if method.contains("card") {
            card_count += 1;
            card_total += revenue;
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "cash": {
                "count": cash_count,
                "total": cash_total,
            },
            "card": {
                "count": card_count,
                "total": card_total,
            }
        }
    }))
}

#[tauri::command]
pub async fn report_get_order_type_breakdown(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_report_today_statistics_payload(arg0);
    let branch_id = payload
        .branch_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default();
    let date = resolve_report_date(payload.date);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let rows = load_report_rows_for_day(&conn, &branch_id, &date)?;

    let mut delivery_count = 0i64;
    let mut delivery_total = 0.0f64;
    let mut instore_count = 0i64;
    let mut instore_total = 0.0f64;

    for (status, _created_at, _payment_method, order_type, total_amount, items) in rows {
        if is_cancelled_status(&status) {
            continue;
        }
        let order_type = order_type.unwrap_or_default().to_ascii_lowercase();
        let revenue = if total_amount > 0.0 {
            total_amount
        } else {
            crate::parse_item_totals(&items).0
        };

        if order_type == "delivery" {
            delivery_count += 1;
            delivery_total += revenue;
        } else if matches!(
            order_type.as_str(),
            "dine-in" | "dinein" | "takeaway" | "pickup" | "instore" | "in-store"
        ) {
            instore_count += 1;
            instore_total += revenue;
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "delivery": {
                "count": delivery_count,
                "total": delivery_total,
            },
            "instore": {
                "count": instore_count,
                "total": instore_total,
            }
        }
    }))
}

#[tauri::command]
pub async fn report_print_z_report(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    if let Some(z_report_id) = extract_z_report_id_from_payload(&payload) {
        return zreport::print_z_report(&db, &serde_json::json!({ "zReportId": z_report_id }));
    }

    let Some(mut snapshot) = snapshot_or_payload(&payload) else {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Missing snapshot payload for queued z-report print",
        }));
    };

    if snapshot.get("terminalName").is_none() {
        if let Some(terminal_name) = value_str(&payload, &["terminalName", "terminal_name"]) {
            if let Some(obj) = snapshot.as_object_mut() {
                obj.insert(
                    "terminalName".to_string(),
                    serde_json::Value::String(terminal_name),
                );
            }
        }
    }

    let report_date = value_str(&snapshot, &["date", "reportDate", "report_date"])
        .or_else(|| string_from_pointers(&snapshot, &["/date", "/reportDate", "/report_date"]))
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let synthetic_id = format!(
        "snapshot-{}-{}",
        report_date.replace(|ch: char| !ch.is_ascii_alphanumeric(), ""),
        Utc::now().timestamp_millis()
    );

    if !crate::print::is_print_action_enabled(&db, "z_report") {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }
    print::enqueue_print_job_with_payload(&db, "z_report", &synthetic_id, None, Some(&snapshot))
}

#[tauri::command]
pub async fn report_generate_z_report(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = normalize_report_generate_payload(arg0);

    // If payload has shiftId (and no branchId/date), use single-shift path
    let has_shift_id = payload.get("shiftId").and_then(|v| v.as_str()).is_some()
        || payload.get("shift_id").and_then(|v| v.as_str()).is_some();
    let has_branch_or_date = payload.get("branchId").and_then(|v| v.as_str()).is_some()
        || payload.get("date").and_then(|v| v.as_str()).is_some();

    let generated = if has_shift_id && !has_branch_or_date {
        let generated = zreport::generate_z_report(&db, &payload)?;
        if !generated
            .get("existing")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            if let Some(z_report_id) = extract_z_report_id_from_payload(&generated) {
                zreport::discard_generated_z_report_by_id(&db, &z_report_id)?;
            }
        }
        generated
    } else {
        zreport::preview_z_report_for_date(&db, &payload)?
    };

    // Frontend expects report_json fields (sales, cashDrawer, etc.) directly
    // under "data". Extract reportJson from the nested response.
    let report_data = flatten_generated_z_report_data(&generated);

    Ok(serde_json::json!({ "success": true, "data": report_data }))
}

#[tauri::command]
pub async fn report_get_end_of_day_status(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = normalize_report_generate_payload(arg0);
    zreport::get_end_of_day_status(&db, &payload)
}

#[tauri::command]
pub async fn report_submit_z_report(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    sync_state: tauri::State<'_, std::sync::Arc<crate::sync::SyncState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let pre_closeout_drain = crate::sync::force_sync_until_closeout_stable(&db, &sync_state, &app)
        .await
        .map_err(|error| format!("Cannot close day: pre-Z-report sync failed: {error}"))?;
    info!(
        passes_executed = pre_closeout_drain.passes_executed,
        any_progress = pre_closeout_drain.any_progress,
        remaining_unsynced_count = pre_closeout_drain.remaining_unsynced_count,
        remaining_blockers_summary = if pre_closeout_drain.remaining_blockers_summary.is_empty() {
            "none"
        } else {
            pre_closeout_drain.remaining_blockers_summary.as_str()
        },
        "Pre-closeout sync drain finished"
    );
    if let Some(response) =
        crate::sync::build_sync_closeout_blocked_response_for_stage(&db, "pre-Z-report sync")?
    {
        return Ok(response);
    }

    let initial_blockers = zreport::unsettled_payment_blockers(&db, &payload)?;
    let blockers = if initial_blockers
        .iter()
        .any(|blocker| blocker.missing_local_payment_row())
    {
        let blocking_order_ids: Vec<String> = initial_blockers
            .iter()
            .filter(|blocker| blocker.missing_local_payment_row())
            .map(|blocker| blocker.order_id.clone())
            .collect();
        crate::sync::repair_local_payment_mirrors_for_orders(&db, &blocking_order_ids)
            .await
            .map_err(|repair_error| {
                format!(
                    "Cannot close day: failed to refresh payment mirrors for blocking orders: {repair_error}"
                )
            })?;
        zreport::unsettled_payment_blockers(&db, &payload)?
    } else {
        initial_blockers
    };

    if !blockers.is_empty() {
        return Ok(payment_integrity::build_unsettled_payment_blocker_response(
            "Cannot generate Z-report",
            &blockers,
        ));
    }

    let prepared = match zreport::prepare_z_report_submission(&db, &payload) {
        Ok(prepared) => prepared,
        Err(error) => {
            let blockers = zreport::unsettled_payment_blockers(&db, &payload)?;
            if blockers.is_empty() {
                return Err(error);
            }
            return Ok(payment_integrity::build_unsettled_payment_blocker_response(
                "Cannot generate Z-report",
                &blockers,
            ));
        }
    };

    let post_submission_drain =
        crate::sync::force_sync_until_closeout_stable(&db, &sync_state, &app)
            .await
            .map_err(|error| format!("Cannot close day: Z-report sync failed: {error}"))?;
    info!(
        passes_executed = post_submission_drain.passes_executed,
        any_progress = post_submission_drain.any_progress,
        remaining_unsynced_count = post_submission_drain.remaining_unsynced_count,
        remaining_blockers_summary = if post_submission_drain.remaining_blockers_summary.is_empty()
        {
            "none"
        } else {
            post_submission_drain.remaining_blockers_summary.as_str()
        },
        "Post-submission sync drain finished"
    );
    if let Some(response) =
        crate::sync::build_sync_closeout_blocked_response_for_stage(&db, "Z-report submission")?
    {
        return Ok(response);
    }

    let mut result = zreport::finalize_prepared_z_report_submission(&db, &prepared)?;

    let z_report_id = extract_z_report_id_from_payload(&result)
        .or_else(|| {
            result
                .get("data")
                .and_then(extract_z_report_id_from_payload)
        })
        .or_else(|| {
            result
                .get("data")
                .and_then(|value| value.get("data"))
                .and_then(extract_z_report_id_from_payload)
        })
        .or_else(|| extract_z_report_id_from_payload(&payload));

    if let Some(z_report_id) = z_report_id {
        if crate::print::is_print_action_enabled(&db, "z_report") {
            match print::enqueue_print_job(&db, "z_report", &z_report_id, None) {
                Ok(job) => {
                    if let Some(obj) = result.as_object_mut() {
                        obj.insert("autoPrintJob".to_string(), job);
                    }
                }
                Err(error) => {
                    warn!(
                        z_report_id = %z_report_id,
                        error = %error,
                        "Failed to enqueue automatic z-report print job"
                    );
                }
            }
        }
    }

    let _ = app.emit("sync_complete", serde_json::json!({ "entity": "z_report" }));
    Ok(result)
}

#[tauri::command]
pub async fn report_resolve_payment_blocker(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_resolve_payment_blocker_payload(arg0)?;
    payments::resolve_unsettled_payment_blocker_payment(&db, &payload)
}

#[tauri::command]
pub async fn inventory_get_stock_metrics() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": false,
        "notImplemented": true,
        "message": "Inventory service not yet implemented",
        "inStock": 0,
        "lowStock": 0,
        "outOfStock": 0,
    }))
}

#[tauri::command]
pub async fn products_get_catalog_count() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": false,
        "notImplemented": true,
        "message": "Product catalog service not yet implemented",
        "total": 0,
    }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_driver_shift_payload_supports_string_and_object() {
        let from_string = parse_driver_shift_payload(Some(serde_json::json!("shift-1")))
            .expect("string shift payload should parse");
        let from_object = parse_driver_shift_payload(Some(serde_json::json!({
            "shiftId": "shift-2"
        })))
        .expect("object shift payload should parse");
        assert_eq!(from_string, "shift-1");
        assert_eq!(from_object, "shift-2");
    }

    #[test]
    fn parse_driver_branch_payload_supports_optional_forms() {
        let from_string = parse_driver_branch_payload(Some(serde_json::json!("branch-1")));
        let from_object = parse_driver_branch_payload(Some(serde_json::json!({
            "branch_id": "branch-2"
        })));
        let from_none = parse_driver_branch_payload(None);
        assert_eq!(from_string, "branch-1");
        assert_eq!(from_object, "branch-2");
        assert_eq!(from_none, "");
    }

    #[test]
    fn parse_delivery_zone_analytics_payload_supports_string_and_alias() {
        let from_string = parse_delivery_zone_analytics_payload(Some(serde_json::json!("zone-a")));
        let from_object = parse_delivery_zone_analytics_payload(Some(serde_json::json!({
            "zone_id": "zone-b"
        })));
        assert_eq!(from_string.as_deref(), Some("zone-a"));
        assert_eq!(from_object.as_deref(), Some("zone-b"));
    }

    #[test]
    fn parse_report_top_items_payload_supports_legacy_branch_string() {
        let parsed = parse_report_top_items_payload(Some(serde_json::json!("branch-3")));
        assert_eq!(parsed.branch_id.as_deref(), Some("branch-3"));
        assert_eq!(parsed.limit, None);
    }

    #[test]
    fn aggregate_top_items_uses_menu_item_ids_and_skips_invalid_rows() {
        let rows = vec![
            (
                "pending".to_string(),
                serde_json::json!([
                    {
                        "menu_item_id": "item-1",
                        "name": "Burger",
                        "category_id": "cat-1",
                        "quantity": 2.0,
                        "total_price": 12.4
                    },
                    {
                        "menu_item_id": "manual",
                        "name": "Manual item",
                        "quantity": 1.0,
                        "total_price": 8.0
                    },
                    {
                        "menu_item_id": "combo-1",
                        "name": "Lunch Combo",
                        "quantity": 1.0,
                        "total_price": 9.0,
                        "is_combo": true
                    }
                ])
                .to_string(),
            ),
            (
                "completed".to_string(),
                serde_json::json!([
                    {
                        "menuItemId": "item-1",
                        "name": "Burger Deluxe",
                        "quantity": 1.0,
                        "unitPrice": 6.2
                    },
                    {
                        "menu_item_id": "item-2",
                        "name": "Fries",
                        "quantity": 3.0,
                        "total_price": 9.0,
                        "is_manual": true
                    },
                    {
                        "menu_item_id": "item-3",
                        "name": "Wrap",
                        "quantity": 1.0,
                        "total_price": 7.0,
                        "combo_id": "combo-wrap"
                    }
                ])
                .to_string(),
            ),
            (
                "cancelled".to_string(),
                serde_json::json!([
                    {
                        "menu_item_id": "item-2",
                        "name": "Fries",
                        "quantity": 5.0,
                        "total_price": 15.0
                    }
                ])
                .to_string(),
            ),
        ];

        let aggregated = aggregate_top_items_from_order_rows(rows);
        assert_eq!(aggregated.len(), 1);

        let burger = &aggregated[0];
        assert_eq!(burger.menu_item_id, "item-1");
        assert_eq!(burger.name, "Burger");
        assert_eq!(burger.category_id.as_deref(), Some("cat-1"));
        assert!((burger.quantity - 3.0).abs() < f64::EPSILON);
        assert!((burger.revenue - 18.6).abs() < f64::EPSILON);
    }

    #[test]
    fn top_items_json_preserves_legacy_fields_and_adds_menu_item_id() {
        let rows = vec![(
            "pending".to_string(),
            serde_json::json!([
                {
                    "menu_item_id": "item-9",
                    "name": "Crepe",
                    "categoryId": "cat-9",
                    "quantity": 2.0,
                    "totalPrice": 11.0
                }
            ])
            .to_string(),
        )];

        let json_rows = top_items_to_json(aggregate_top_items_from_order_rows(rows), 10);
        assert_eq!(json_rows.len(), 1);
        assert_eq!(
            json_rows[0].get("menuItemId").and_then(|v| v.as_str()),
            Some("item-9")
        );
        assert_eq!(
            json_rows[0].get("name").and_then(|v| v.as_str()),
            Some("Crepe")
        );
        assert_eq!(
            json_rows[0].get("categoryId").and_then(|v| v.as_str()),
            Some("cat-9")
        );
        assert_eq!(
            json_rows[0].get("quantity").and_then(|v| v.as_f64()),
            Some(2.0)
        );
        assert_eq!(
            json_rows[0].get("revenue").and_then(|v| v.as_f64()),
            Some(11.0)
        );
    }

    #[test]
    fn normalize_report_generate_payload_supports_shift_string() {
        let payload = normalize_report_generate_payload(Some(serde_json::json!("shift-9")));
        assert_eq!(
            payload.get("shiftId").and_then(|v| v.as_str()),
            Some("shift-9")
        );
    }

    #[test]
    fn extract_z_report_id_from_payload_supports_nested_snapshot() {
        let payload = serde_json::json!({
            "snapshot": {
                "id": "zr-42"
            }
        });
        assert_eq!(
            extract_z_report_id_from_payload(&payload).as_deref(),
            Some("zr-42")
        );
    }

    #[test]
    fn number_from_pointers_supports_mixed_numeric_types() {
        let payload = serde_json::json!({
            "sales": {
                "totalSales": 123.45
            },
            "counts": {
                "orders": 7
            }
        });
        assert_eq!(
            number_from_pointers(&payload, &["/sales/totalSales"]),
            Some(123.45)
        );
        assert_eq!(
            number_from_pointers(&payload, &["/counts/orders"]),
            Some(7.0)
        );
    }

    #[test]
    fn snapshot_or_payload_supports_nested_and_flat_forms() {
        let nested = serde_json::json!({
            "snapshot": { "sales": { "totalSales": 1 } }
        });
        let flat = serde_json::json!({
            "sales": { "totalSales": 2 }
        });
        let missing = serde_json::json!({
            "terminalName": "Main POS"
        });

        assert!(snapshot_or_payload(&nested).is_some());
        assert!(snapshot_or_payload(&flat).is_some());
        assert!(snapshot_or_payload(&missing).is_none());
    }

    #[test]
    fn flatten_generated_z_report_data_keeps_print_metadata() {
        let generated = serde_json::json!({
            "report": {
                "shiftId": "shift-aggregate-1",
                "terminalId": "terminal-9bf9dfce",
                "terminalName": "Front Counter",
                "reportJson": {
                    "date": "2026-03-15",
                    "sales": { "totalSales": 245.0, "totalOrders": 11 },
                    "shifts": { "total": 3 }
                }
            }
        });

        let flattened = flatten_generated_z_report_data(&generated);
        assert_eq!(flattened["shiftId"], "shift-aggregate-1");
        assert_eq!(flattened["terminalId"], "terminal-9bf9dfce");
        assert_eq!(flattened["terminalName"], "Front Counter");
        assert_eq!(flattened["shiftCount"], 3);
        assert_eq!(flattened["sales"]["totalSales"], 245.0);
    }

    #[test]
    fn flatten_generated_z_report_data_synthesizes_compatible_period_fields() {
        let generated = serde_json::json!({
            "report": {
                "reportJson": {
                    "date": "2026-03-15",
                    "periodStart": "2026-03-15T08:00:00Z",
                    "periodEnd": "2026-03-15T18:00:00Z"
                }
            }
        });

        let flattened = flatten_generated_z_report_data(&generated);
        assert_eq!(flattened["periodStart"], "2026-03-15T08:00:00Z");
        assert_eq!(flattened["periodEnd"], "2026-03-15T18:00:00Z");
        assert_eq!(flattened["period"]["start"], "2026-03-15T08:00:00Z");
        assert_eq!(flattened["period"]["end"], "2026-03-15T18:00:00Z");
    }
}
