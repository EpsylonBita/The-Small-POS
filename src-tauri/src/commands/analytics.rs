use chrono::{Local, Utc};
use rusqlite::params;
use serde::Deserialize;
use tauri::Emitter;
use tracing::{info, warn};

use crate::{db, escpos, printers, value_str, zreport};

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
    matches!(status.to_ascii_lowercase().as_str(), "cancelled" | "canceled")
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

fn number_from_value(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|v| v as f64))
        .or_else(|| value.as_u64().map(|v| v as f64))
}

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
    let id = crate::value_str(&payload, &["id"])
        .unwrap_or_else(|| format!("de-{}", uuid::Uuid::new_v4()));
    let driver_id =
        crate::value_str(&payload, &["driverId", "driver_id"]).ok_or("Missing driverId")?;
    let shift_id = crate::value_str(
        &payload,
        &["shiftId", "shift_id", "staffShiftId", "staff_shift_id"],
    );
    let order_id = crate::value_str(&payload, &["orderId", "order_id"]).ok_or("Missing orderId")?;
    let delivery_fee = crate::value_f64(&payload, &["deliveryFee", "delivery_fee"]).unwrap_or(0.0);
    let tip_amount = crate::value_f64(&payload, &["tipAmount", "tip_amount"]).unwrap_or(0.0);
    let payment_method = crate::value_str(&payload, &["paymentMethod", "payment_method"])
        .unwrap_or_else(|| "cash".to_string());
    let cash_collected =
        crate::value_f64(&payload, &["cashCollected", "cash_collected"]).unwrap_or(0.0);
    let card_amount = crate::value_f64(&payload, &["cardAmount", "card_amount"]).unwrap_or(0.0);

    let total_earning = delivery_fee + tip_amount;
    let cash_to_return = cash_collected - card_amount;
    let now = Utc::now().to_rfc3339();

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Validate shift exists and is active (if provided)
    if let Some(ref sid) = shift_id {
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM staff_shifts WHERE id = ?1",
                params![sid],
                |row| row.get(0),
            )
            .ok();
        match status.as_deref() {
            None => return Err("Shift not found".to_string()),
            Some(s) if s != "active" => {
                return Err("Cannot record earnings on inactive shift".to_string())
            }
            _ => {}
        }
    }

    // Check for duplicate order_id
    let existing: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM driver_earnings WHERE order_id = ?1",
            params![order_id],
            |row| row.get::<_, i32>(0),
        )
        .unwrap_or(0)
        > 0;
    if existing {
        return Err("Earning already recorded for this order".to_string());
    }

    // Resolve branch_id from shift if not provided
    let branch_id = crate::value_str(&payload, &["branchId", "branch_id"]).unwrap_or_else(|| {
        shift_id
            .as_ref()
            .and_then(|sid| {
                conn.query_row(
                    "SELECT branch_id FROM staff_shifts WHERE id = ?1",
                    params![sid],
                    |row| row.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()
            })
            .unwrap_or_default()
    });

    // Fetch order details for the JSON column
    let order_details: Option<String> = conn
        .query_row(
            "SELECT order_number, delivery_address, table_number, total_amount, payment_method, status FROM orders WHERE id = ?1",
            params![order_id],
            |row| {
                let detail = serde_json::json!({
                    "order_number": row.get::<_, Option<String>>(0).unwrap_or(None),
                    "address": row.get::<_, Option<String>>(1).unwrap_or(None)
                        .or_else(|| row.get::<_, Option<String>>(2).unwrap_or(None))
                        .unwrap_or_else(|| "N/A".to_string()),
                    "price": row.get::<_, f64>(3).unwrap_or(0.0),
                    "payment_type": row.get::<_, Option<String>>(4).unwrap_or(None),
                    "status": row.get::<_, Option<String>>(5).unwrap_or(None),
                });
                Ok(detail.to_string())
            },
        )
        .ok();

    conn.execute(
        "INSERT INTO driver_earnings (
            id, driver_id, staff_shift_id, order_id, branch_id,
            delivery_fee, tip_amount, total_earning,
            payment_method, cash_collected, card_amount, cash_to_return,
            order_details, settled, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15)",
        params![
            id,
            driver_id,
            shift_id,
            order_id,
            branch_id,
            delivery_fee,
            tip_amount,
            total_earning,
            payment_method,
            cash_collected,
            card_amount,
            cash_to_return,
            order_details,
            now,
            now
        ],
    )
    .map_err(|e| format!("driver_record_earning insert: {e}"))?;

    info!("Recorded driver earning {id} for order {order_id}");

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "id": id,
            "driverId": driver_id,
            "shiftId": shift_id,
            "orderId": order_id,
            "branchId": branch_id,
            "deliveryFee": delivery_fee,
            "tipAmount": tip_amount,
            "totalEarning": total_earning,
            "paymentMethod": payment_method,
            "cashCollected": cash_collected,
            "cardAmount": card_amount,
            "cashToReturn": cash_to_return,
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
            "SELECT id, staff_id, staff_name, branch_id, check_in_time
             FROM staff_shifts
             WHERE role_type = 'driver' AND status = 'active'
               AND (?1 = '' OR branch_id = ?1)
             ORDER BY check_in_time ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![branch_id], |row| {
            Ok(serde_json::json!({
                "shiftId": row.get::<_, String>(0)?,
                "staffId": row.get::<_, String>(1)?,
                "staffName": row.get::<_, Option<String>>(2)?,
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
    let mut qty_by_item: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (_id, _status, _created, items, _staff, _payment_method) in orders {
        let (_total, map) = crate::parse_item_totals(&items);
        for (name, qty) in map {
            *qty_by_item.entry(name).or_insert(0.0) += qty;
        }
    }
    let mut items: Vec<(String, f64)> = qty_by_item.into_iter().collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<serde_json::Value> = items
        .into_iter()
        .take(limit)
        .map(|(name, quantity)| serde_json::json!({ "name": name, "quantity": quantity }))
        .collect();
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
    let mut qty_by_item: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (_id, _status, _created, items, _staff, _payment_method) in orders {
        let (_total, map) = crate::parse_item_totals(&items);
        for (name, qty) in map {
            *qty_by_item.entry(name).or_insert(0.0) += qty;
        }
    }
    let mut items: Vec<(String, f64)> = qty_by_item.into_iter().collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<serde_json::Value> = items
        .into_iter()
        .take(limit)
        .map(|(name, quantity)| serde_json::json!({ "name": name, "quantity": quantity }))
        .collect();
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

    let Some(snapshot) = snapshot_or_payload(&payload) else {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Missing snapshot payload for native z-report print",
        }));
    };

    let profile = match printers::resolve_printer_profile(&db, None) {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": "No printer profile configured",
            }));
        }
        Err(error) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("Failed to resolve printer profile: {error}"),
            }));
        }
    };

    let printer_name = value_str(&profile, &["printerName", "printer_name", "name"]).unwrap_or_default();
    if printer_name.trim().is_empty() {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Printer profile has no printerName configured",
        }));
    }

    let paper_mm = profile
        .get("paperWidthMm")
        .or_else(|| profile.get("paper_width_mm"))
        .and_then(|value| value.as_i64())
        .unwrap_or(80) as i32;
    let paper = escpos::PaperWidth::from_mm(paper_mm);

    let report_date = value_str(&snapshot, &["date", "reportDate", "report_date"])
        .or_else(|| string_from_pointers(&snapshot, &["/date", "/reportDate", "/report_date"]))
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let terminal_name = value_str(&payload, &["terminalName", "terminal_name"])
        .or_else(|| value_str(&snapshot, &["terminalName", "terminal_name", "terminalId", "terminal_id"]))
        .or_else(|| string_from_pointers(&snapshot, &["/terminalName", "/terminal_name", "/terminalId", "/terminal_id"]));

    let shifts_total = number_from_pointers(
        &snapshot,
        &["/shifts/total", "/shiftsTotal", "/shifts_total"],
    )
    .unwrap_or(0.0)
    .round() as i64;
    let shifts_cashier = number_from_pointers(
        &snapshot,
        &["/shifts/cashier", "/shifts/cashiers", "/cashierShifts", "/cashier_shifts"],
    )
    .unwrap_or(0.0)
    .round() as i64;
    let shifts_driver = number_from_pointers(
        &snapshot,
        &["/shifts/driver", "/shifts/drivers", "/driverShifts", "/driver_shifts"],
    )
    .unwrap_or(0.0)
    .round() as i64;

    let total_orders = number_from_pointers(
        &snapshot,
        &[
            "/sales/totalOrders",
            "/sales/total_orders",
            "/daySummary/totalOrders",
            "/daySummary/total_orders",
            "/totalOrders",
            "/total_orders",
        ],
    )
    .unwrap_or(0.0)
    .round() as i64;
    let total_sales = number_from_pointers(
        &snapshot,
        &[
            "/sales/totalSales",
            "/sales/total_sales",
            "/daySummary/total",
            "/daySummary/totalAmount",
            "/totalSales",
            "/total_sales",
        ],
    )
    .unwrap_or(0.0);
    let cash_sales = number_from_pointers(
        &snapshot,
        &[
            "/sales/cashSales",
            "/sales/cash_sales",
            "/daySummary/cashTotal",
            "/cashSales",
            "/cash_sales",
        ],
    )
    .unwrap_or(0.0);
    let card_sales = number_from_pointers(
        &snapshot,
        &[
            "/sales/cardSales",
            "/sales/card_sales",
            "/daySummary/cardTotal",
            "/cardSales",
            "/card_sales",
        ],
    )
    .unwrap_or(0.0);

    let expenses_total = number_from_pointers(
        &snapshot,
        &["/expenses/total", "/expensesTotal", "/expenses_total"],
    )
    .unwrap_or(0.0);
    let driver_earnings_total = number_from_pointers(
        &snapshot,
        &[
            "/driverEarnings/totalEarnings",
            "/driverEarnings/total_earnings",
            "/driverEarningsTotal",
        ],
    )
    .unwrap_or(0.0);
    let driver_deliveries = number_from_pointers(
        &snapshot,
        &[
            "/driverEarnings/totalDeliveries",
            "/driverEarnings/total_deliveries",
            "/driverDeliveries",
        ],
    )
    .unwrap_or(0.0)
    .round() as i64;
    let cash_variance = number_from_pointers(
        &snapshot,
        &[
            "/cashDrawer/totalVariance",
            "/cashDrawer/cashVariance",
            "/cashDrawer/total_variance",
            "/cashVariance",
        ],
    )
    .unwrap_or(0.0);
    let cash_drops = number_from_pointers(
        &snapshot,
        &[
            "/cashDrawer/totalCashDrops",
            "/cashDrawer/cash_drops",
            "/cashDrops",
        ],
    )
    .unwrap_or(0.0);

    let generated_at = Utc::now().to_rfc3339();
    let mut receipt = escpos::EscPosBuilder::new().with_paper(paper);
    receipt
        .init()
        .center()
        .bold(true)
        .text("Z REPORT\n")
        .bold(false)
        .separator()
        .left()
        .line_pair("Date", &report_date);

    if let Some(name) = terminal_name.as_ref() {
        receipt.line_pair("Terminal", name);
    }

    receipt
        .line_pair("Generated", &generated_at)
        .separator()
        .line_pair("Shifts", &shifts_total.to_string());
    if shifts_cashier > 0 {
        receipt.line_pair("Cashier Shifts", &shifts_cashier.to_string());
    }
    if shifts_driver > 0 {
        receipt.line_pair("Driver Shifts", &shifts_driver.to_string());
    }

    receipt
        .separator()
        .line_pair("Orders", &total_orders.to_string())
        .line_pair("Sales", &format!("{total_sales:.2}"))
        .line_pair("Cash Sales", &format!("{cash_sales:.2}"))
        .line_pair("Card Sales", &format!("{card_sales:.2}"))
        .separator()
        .line_pair("Expenses", &format!("{expenses_total:.2}"))
        .line_pair("Driver Earn", &format!("{driver_earnings_total:.2}"))
        .line_pair("Deliveries", &driver_deliveries.to_string())
        .separator()
        .line_pair("Variance", &format!("{cash_variance:.2}"))
        .line_pair("Cash Drops", &format!("{cash_drops:.2}"))
        .separator()
        .center()
        .text("End of Z Report\n")
        .feed(4)
        .cut();

    let bytes = receipt.build();
    match printers::print_raw_to_windows(&printer_name, &bytes, "POS Z Report") {
        Ok(()) => {
            info!(
                printer_name = %printer_name,
                report_date = %report_date,
                "Printed z-report receipt from snapshot payload"
            );
            Ok(serde_json::json!({
                "success": true,
                "printerName": printer_name,
                "reportDate": report_date,
            }))
        }
        Err(error) => {
            warn!(
                printer_name = %printer_name,
                report_date = %report_date,
                error = %error,
                "Failed to print z-report receipt from snapshot payload"
            );
            Ok(serde_json::json!({
                "success": false,
                "error": error,
                "printerName": printer_name,
                "reportDate": report_date,
            }))
        }
    }
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
        zreport::generate_z_report(&db, &payload)?
    } else {
        zreport::generate_z_report_for_date(&db, &payload)?
    };

    // Frontend expects report_json fields (sales, cashDrawer, etc.) directly
    // under "data". Extract reportJson from the nested response.
    let report_data = generated
        .get("report")
        .and_then(|r| r.get("reportJson"))
        .cloned()
        .unwrap_or(generated.clone());

    Ok(serde_json::json!({ "success": true, "data": report_data }))
}

#[tauri::command]
pub async fn report_submit_z_report(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let result = zreport::submit_z_report(&db, &payload)?;
    let _ = app.emit("sync_complete", serde_json::json!({ "entity": "z_report" }));
    Ok(result)
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
}
