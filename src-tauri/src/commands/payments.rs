use chrono::Utc;
use serde::Deserialize;
use tauri::Emitter;

use crate::{db, payload_arg0_as_string, payments, refunds, resolve_order_id};

#[derive(Debug)]
struct PaymentUpdateStatusPayload {
    order_id: String,
    payment_status: String,
    payment_method: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaymentVoidPayload {
    #[serde(alias = "payment_id")]
    payment_id: String,
    reason: String,
    #[serde(default, alias = "voided_by")]
    voided_by: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefundVoidPayload {
    #[serde(alias = "payment_id")]
    payment_id: String,
    reason: String,
    #[serde(default, alias = "staff_id")]
    staff_id: Option<String>,
}

fn parse_payment_update_status_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    arg2: Option<String>,
) -> Result<PaymentUpdateStatusPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(order_id)) => serde_json::json!({
            "orderId": order_id,
            "paymentStatus": arg1,
            "paymentMethod": arg2
        }),
        Some(v) => v,
        None => serde_json::json!({
            "paymentStatus": arg1,
            "paymentMethod": arg2
        }),
    };

    let order_id = payload_arg0_as_string(
        Some(payload.clone()),
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId")?;
    let payment_status = payload
        .get("paymentStatus")
        .or_else(|| payload.get("payment_status"))
        .or_else(|| payload.get("status"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| arg1.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .ok_or("Missing payment status")?;
    let payment_method = payload
        .get("paymentMethod")
        .or_else(|| payload.get("payment_method"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| arg2.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));

    Ok(PaymentUpdateStatusPayload {
        order_id: order_id.trim().to_string(),
        payment_status,
        payment_method,
    })
}

fn parse_payment_void_payload(
    payload: Option<serde_json::Value>,
) -> Result<PaymentVoidPayload, String> {
    let mut parsed: PaymentVoidPayload =
        serde_json::from_value(payload.ok_or("Missing void payment payload")?)
            .map_err(|e| format!("Invalid void payment payload: {e}"))?;

    parsed.payment_id = parsed.payment_id.trim().to_string();
    parsed.reason = parsed.reason.trim().to_string();
    if parsed.payment_id.is_empty() {
        return Err("Missing paymentId".into());
    }
    if parsed.reason.is_empty() {
        return Err("Missing reason".into());
    }
    Ok(parsed)
}

fn parse_refund_void_payload(
    payload: Option<serde_json::Value>,
) -> Result<RefundVoidPayload, String> {
    let mut parsed: RefundVoidPayload =
        serde_json::from_value(payload.ok_or("Missing void payment payload")?)
            .map_err(|e| format!("Invalid refund void payload: {e}"))?;

    parsed.payment_id = parsed.payment_id.trim().to_string();
    parsed.reason = parsed.reason.trim().to_string();
    if parsed.payment_id.is_empty() {
        return Err("Missing paymentId".into());
    }
    if parsed.reason.is_empty() {
        return Err("Missing reason".into());
    }
    Ok(parsed)
}

fn parse_order_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(
        arg0,
        &["orderId", "order_id", "id", "supabaseId", "supabase_id"],
    )
    .ok_or("Missing orderId".into())
}

fn parse_payment_id_payload(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["paymentId", "payment_id", "id"])
        .ok_or("Missing paymentId".into())
}

#[tauri::command]
pub async fn payment_update_payment_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<String>,
    arg2: Option<String>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_payment_update_status_payload(arg0, arg1, arg2)?;
    let order_id_raw = payload.order_id;
    let payment_status = payload.payment_status;
    let payment_method = payload.payment_method;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_id = resolve_order_id(&conn, &order_id_raw).ok_or("Order not found")?;
    conn.execute(
        "UPDATE orders
         SET payment_status = ?1,
             payment_method = COALESCE(?2, payment_method),
             sync_status = 'pending',
             updated_at = ?3
         WHERE id = ?4",
        rusqlite::params![
            payment_status,
            payment_method,
            Utc::now().to_rfc3339(),
            order_id
        ],
    )
    .map_err(|e| format!("update payment status: {e}"))?;
    drop(conn);
    let payload = serde_json::json!({
        "orderId": order_id_raw,
        "paymentStatus": payment_status,
        "paymentMethod": payment_method
    });
    let _ = app.emit("order_payment_updated", payload.clone());
    Ok(serde_json::json!({ "success": true, "data": payload }))
}

#[tauri::command]
pub async fn payment_record(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing payment payload")?;
    payments::record_payment(&db, &payload)
}

#[tauri::command]
pub async fn payment_void(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_payment_void_payload(arg0)?;
    payments::void_payment(
        &db,
        &payload.payment_id,
        &payload.reason,
        payload.voided_by.as_deref(),
    )
}

#[tauri::command]
pub async fn payment_get_order_payments(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    payments::get_order_payments(&db, &order_id)
}

#[tauri::command]
pub async fn payment_get_receipt_preview(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    payments::get_receipt_preview(&db, &order_id)
}

#[tauri::command]
pub async fn refund_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing refund payload")?;
    refunds::refund_payment(&db, &payload)
}

#[tauri::command]
pub async fn refund_void_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_refund_void_payload(arg0)?;
    refunds::void_payment_with_adjustment(
        &db,
        &payload.payment_id,
        &payload.reason,
        payload.staff_id.as_deref(),
    )
}

#[tauri::command]
pub async fn refund_list_order_adjustments(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_order_id_payload(arg0)?;
    refunds::list_order_adjustments(&db, &order_id)
}

#[tauri::command]
pub async fn refund_get_payment_balance(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payment_id = parse_payment_id_payload(arg0)?;
    refunds::get_payment_balance(&db, &payment_id)
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_payment_update_status_supports_legacy_args() {
        let parsed = parse_payment_update_status_payload(
            Some(serde_json::json!("order-1")),
            Some("paid".to_string()),
            Some("card".to_string()),
        )
        .expect("legacy args should parse");
        assert_eq!(parsed.order_id, "order-1");
        assert_eq!(parsed.payment_status, "paid");
        assert_eq!(parsed.payment_method.as_deref(), Some("card"));
    }

    #[test]
    fn parse_payment_update_status_supports_object_payload() {
        let parsed = parse_payment_update_status_payload(
            Some(serde_json::json!({
                "orderId": "order-2",
                "paymentStatus": "pending",
                "paymentMethod": "cash"
            })),
            None,
            None,
        )
        .expect("object payload should parse");
        assert_eq!(parsed.order_id, "order-2");
        assert_eq!(parsed.payment_status, "pending");
        assert_eq!(parsed.payment_method.as_deref(), Some("cash"));
    }

    #[test]
    fn parse_payment_void_payload_requires_reason() {
        let err = parse_payment_void_payload(Some(serde_json::json!({
            "paymentId": "pay-1"
        })))
        .expect_err("missing reason should fail");
        assert!(err.contains("Invalid void payment payload") || err.contains("Missing reason"));
    }

    #[test]
    fn parse_refund_void_payload_supports_aliases() {
        let parsed = parse_refund_void_payload(Some(serde_json::json!({
            "payment_id": "pay-2",
            "reason": "operator correction",
            "staff_id": "staff-1"
        })))
        .expect("alias payload should parse");
        assert_eq!(parsed.payment_id, "pay-2");
        assert_eq!(parsed.reason, "operator correction");
        assert_eq!(parsed.staff_id.as_deref(), Some("staff-1"));
    }

    #[test]
    fn parse_order_id_payload_supports_object_and_string() {
        let from_obj = parse_order_id_payload(Some(serde_json::json!({
            "orderId": "order-3"
        })))
        .expect("object order id should parse");
        let from_str = parse_order_id_payload(Some(serde_json::json!("order-4")))
            .expect("string order id should parse");
        assert_eq!(from_obj, "order-3");
        assert_eq!(from_str, "order-4");
    }
}
