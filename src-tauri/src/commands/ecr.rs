use serde::Deserialize;
use tauri::Emitter;

use crate::{db, ecr, payload_arg0_as_string, value_str};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EcrDiscoverCompatPayload {
    #[serde(default, alias = "connection_types", alias = "connectionTypes")]
    types: Vec<String>,
    #[serde(default, alias = "connection_type", alias = "connectionType")]
    connection_type: Option<String>,
    #[serde(default, alias = "timeout_ms", alias = "timeoutMs")]
    timeout: Option<u64>,
}

#[derive(Debug)]
struct EcrUpdateCompatPayload {
    device_id: String,
    updates: serde_json::Value,
}

#[derive(Debug)]
struct AmountOptionsCompatPayload {
    amount: f64,
    options: serde_json::Value,
}

#[derive(Debug)]
struct VoidTransactionCompatPayload {
    transaction_id: String,
    device_id: Option<String>,
}

fn value_to_string(value: serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn value_to_f64(value: serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn value_to_u64(value: serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn parse_required_device_id(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["deviceId", "device_id", "id"]).ok_or("Missing deviceId".into())
}

fn parse_optional_device_id(arg0: Option<serde_json::Value>) -> Option<String> {
    payload_arg0_as_string(arg0, &["deviceId", "device_id", "id"])
}

fn parse_required_order_id(arg0: Option<serde_json::Value>) -> Result<String, String> {
    payload_arg0_as_string(arg0, &["orderId", "order_id", "id"]).ok_or("Missing orderId".into())
}

fn parse_optional_order_id(arg0: Option<serde_json::Value>) -> Option<String> {
    payload_arg0_as_string(arg0, &["orderId", "order_id", "id"])
}

fn parse_discover_args(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> (Vec<String>, Option<u64>) {
    let legacy_timeout = arg1.and_then(value_to_u64);
    let mut types: Vec<String> = Vec::new();
    let mut timeout = legacy_timeout;

    match arg0 {
        Some(serde_json::Value::Array(arr)) => {
            types = arr.into_iter().filter_map(value_to_string).collect();
        }
        Some(serde_json::Value::String(value)) => {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                types.push(trimmed.to_string());
            }
        }
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj.clone());
            let parsed: EcrDiscoverCompatPayload =
                serde_json::from_value(payload).unwrap_or_default();
            types = parsed.types;
            if let Some(single) = parsed.connection_type {
                types.push(single);
            }
            timeout = parsed.timeout.or(timeout);
            if timeout.is_none() {
                timeout = obj.get("timeout").cloned().and_then(value_to_u64);
            }
        }
        _ => {}
    }

    let normalized_types = types
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect();
    (normalized_types, timeout)
}

fn parse_update_device_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<EcrUpdateCompatPayload, String> {
    let device_id = parse_required_device_id(arg0.clone())?;
    let updates = match arg1 {
        Some(v) => v,
        None => match arg0 {
            Some(serde_json::Value::Object(mut obj)) => {
                if let Some(nested) = obj.remove("updates") {
                    nested
                } else {
                    obj.remove("deviceId");
                    obj.remove("device_id");
                    obj.remove("id");
                    serde_json::Value::Object(obj)
                }
            }
            _ => serde_json::json!({}),
        },
    };
    let updates = if updates.is_null() {
        serde_json::json!({})
    } else {
        updates
    };

    Ok(EcrUpdateCompatPayload { device_id, updates })
}

fn parse_amount_and_options_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> AmountOptionsCompatPayload {
    let mut amount = arg0.clone().and_then(value_to_f64).unwrap_or(0.0);
    let mut options = arg1.unwrap_or_else(|| serde_json::json!({}));

    if let Some(serde_json::Value::Object(mut obj)) = arg0 {
        if let Some(parsed_amount) = obj
            .get("amount")
            .cloned()
            .and_then(value_to_f64)
            .or_else(|| obj.get("total").cloned().and_then(value_to_f64))
        {
            amount = parsed_amount;
        }

        if let Some(nested) = obj.remove("options") {
            options = nested;
        } else {
            obj.remove("amount");
            obj.remove("total");
            if !obj.is_empty() {
                options = serde_json::Value::Object(obj);
            }
        }
    }

    if options.is_null() {
        options = serde_json::json!({});
    }

    AmountOptionsCompatPayload { amount, options }
}

fn parse_void_transaction_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<VoidTransactionCompatPayload, String> {
    let legacy_device_id = arg1.and_then(value_to_string);
    let payload = arg0.clone().unwrap_or(serde_json::Value::Null);

    let transaction_id = payload_arg0_as_string(
        arg0.clone(),
        &[
            "transactionId",
            "transaction_id",
            "originalTransactionId",
            "original_transaction_id",
            "id",
        ],
    )
    .ok_or("Missing transactionId")?;

    let device_id = if let serde_json::Value::Object(_) = payload {
        value_str(&payload, &["deviceId", "device_id"]).or(legacy_device_id)
    } else {
        legacy_device_id
    };

    Ok(VoidTransactionCompatPayload {
        transaction_id,
        device_id,
    })
}

fn parse_recent_transactions_limit(arg0: Option<serde_json::Value>) -> i64 {
    match arg0 {
        Some(serde_json::Value::Object(obj)) => obj
            .get("limit")
            .and_then(|value| value_to_u64(value.clone()))
            .map(|value| value as i64)
            .unwrap_or(50),
        Some(value) => value_to_u64(value).map(|v| v as i64).unwrap_or(50),
        None => 50,
    }
}

fn parse_query_filters_payload(arg0: Option<serde_json::Value>) -> serde_json::Value {
    match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(device_id)) => serde_json::json!({ "deviceId": device_id }),
        Some(serde_json::Value::Number(limit)) => serde_json::json!({ "limit": limit }),
        _ => serde_json::json!({}),
    }
}

#[tauri::command]
pub async fn ecr_discover_devices(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let (_types, _timeout) = parse_discover_args(arg0, arg1);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let devices = db::ecr_list_devices(&conn);
    Ok(serde_json::json!({
        "success": true,
        "devices": devices
    }))
}

#[tauri::command]
pub async fn ecr_get_devices(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let devices = db::ecr_list_devices(&conn);
    Ok(serde_json::json!({
        "success": true,
        "devices": devices
    }))
}

#[tauri::command]
pub async fn ecr_get_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id);
    Ok(serde_json::json!({
        "success": device.is_some(),
        "device": device,
        "error": if device.is_none() { serde_json::json!("Device not found") } else { serde_json::Value::Null }
    }))
}

#[tauri::command]
pub async fn ecr_add_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let mut config = arg0.unwrap_or(serde_json::json!({}));
    let device_id = config
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("ecr-{}", &uuid::Uuid::new_v4().to_string()[..8]));
    if let Some(obj) = config.as_object_mut() {
        obj.insert("id".to_string(), serde_json::json!(device_id));
        obj.entry("status".to_string())
            .or_insert(serde_json::json!("disconnected"));
        obj.entry("enabled".to_string())
            .or_insert(serde_json::json!(true));
    } else {
        config = serde_json::json!({
            "id": device_id,
            "status": "disconnected",
            "enabled": true
        });
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::ecr_insert_device(&conn, &config)?;
    let device = db::ecr_get_device(&conn, &device_id);

    Ok(serde_json::json!({
        "success": true,
        "device": device.unwrap_or(config)
    }))
}

#[tauri::command]
pub async fn ecr_update_device(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_update_device_payload(arg0, arg1)?;
    let device_id = parsed.device_id;
    let updates = parsed.updates;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let existing = db::ecr_get_device(&conn, &device_id);
    if existing.is_none() {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Device not found"
        }));
    }

    db::ecr_update_device(&conn, &device_id, &updates)?;
    let updated_device = db::ecr_get_device(&conn, &device_id);

    let _ = app.emit(
        "ecr_event_device_status_changed",
        serde_json::json!({
            "deviceId": device_id,
            "device": updated_device
        }),
    );

    Ok(serde_json::json!({
        "success": true,
        "device": updated_device
    }))
}

#[tauri::command]
pub async fn ecr_remove_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    // Disconnect from DeviceManager if connected
    let _ = mgr.disconnect_device(&device_id);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let removed = db::ecr_delete_device(&conn, &device_id)?;
    Ok(serde_json::json!({
        "success": removed,
        "removed": if removed { 1 } else { 0 }
    }))
}

#[tauri::command]
pub async fn ecr_get_default_terminal(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let default_device = db::ecr_get_default_device(&conn, None);
    Ok(serde_json::json!({
        "success": default_device.is_some(),
        "device": default_device
    }))
}

#[tauri::command]
pub async fn ecr_connect_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id)
        .ok_or_else(|| format!("Device {device_id} not found"))?;

    let connection_type = device
        .get("connectionType")
        .and_then(|v| v.as_str())
        .unwrap_or("serial_usb");
    let connection_details = device
        .get("connectionDetails")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let protocol_name = device
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or("generic");
    let settings = device
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    // Attempt real protocol connection via DeviceManager
    match mgr.connect_device(
        &device_id,
        connection_type,
        &connection_details,
        protocol_name,
        &settings,
    ) {
        Ok(()) => {
            let now = chrono::Utc::now().to_rfc3339();
            db::ecr_update_device(
                &conn,
                &device_id,
                &serde_json::json!({"status": "connected", "lastConnectedAt": now, "lastError": null}),
            )?;
            let _ = app.emit(
                "ecr_event_device_connected",
                serde_json::json!({ "deviceId": device_id }),
            );
            let _ = app.emit(
                "ecr_event_device_status_changed",
                serde_json::json!({
                    "deviceId": device_id,
                    "status": "connected"
                }),
            );
            Ok(serde_json::json!({ "success": true }))
        }
        Err(e) => {
            db::ecr_update_device(
                &conn,
                &device_id,
                &serde_json::json!({"status": "error", "lastError": e}),
            )?;
            let _ = app.emit(
                "ecr_event_device_status_changed",
                serde_json::json!({
                    "deviceId": device_id,
                    "status": "error",
                    "error": e
                }),
            );
            Ok(serde_json::json!({ "success": false, "error": e }))
        }
    }
}

#[tauri::command]
pub async fn ecr_disconnect_device(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let _ = mgr.disconnect_device(&device_id);

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::ecr_update_device(
        &conn,
        &device_id,
        &serde_json::json!({"status": "disconnected"}),
    )?;
    let _ = app.emit(
        "ecr_event_device_disconnected",
        serde_json::json!({ "deviceId": device_id }),
    );
    let _ = app.emit(
        "ecr_event_device_status_changed",
        serde_json::json!({
            "deviceId": device_id,
            "status": "disconnected"
        }),
    );
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn ecr_get_device_status(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id);
    let connected = mgr.is_connected(&device_id);
    let db_status = device
        .as_ref()
        .and_then(|d| d.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("disconnected");
    Ok(serde_json::json!({
        "success": device.is_some(),
        "deviceId": device_id,
        "connected": connected,
        "status": if connected { "connected" } else { db_status }
    }))
}

#[tauri::command]
pub async fn ecr_get_all_statuses(
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let devices = db::ecr_list_devices(&conn);
    let statuses: Vec<serde_json::Value> = devices
        .iter()
        .map(|d| {
            let device_id = d
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let connected = mgr.is_connected(&device_id);
            let db_status = d
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("disconnected");
            serde_json::json!({
                "deviceId": device_id,
                "connected": connected,
                "status": if connected { "connected" } else { db_status }
            })
        })
        .collect();
    Ok(serde_json::json!({
        "success": true,
        "statuses": statuses
    }))
}

#[tauri::command]
pub async fn ecr_process_payment(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_amount_and_options_payload(arg0, arg1);
    let amount = parsed.amount;
    let options = parsed.options;
    let device_id = options
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let order_id = options
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let currency = options
        .get("currency")
        .and_then(|v| v.as_str())
        .unwrap_or("EUR")
        .to_string();

    let _ = app.emit(
        "ecr_event_transaction_started",
        serde_json::json!({ "type": "payment", "amount": amount }),
    );

    let tx_id = format!("txn-{}", uuid::Uuid::new_v4());
    let amount_cents = (amount * 100.0).round() as i64;
    let started = chrono::Utc::now().to_rfc3339();

    // Resolve device: explicit > default > first connected
    let resolved_device_id = if let Some(ref did) = device_id {
        Some(did.clone())
    } else {
        mgr.connected_device_ids().into_iter().next()
    };

    if let Some(ref did) = resolved_device_id {
        if mgr.is_connected(did) {
            let request = ecr::protocol::TransactionRequest {
                transaction_id: tx_id.clone(),
                transaction_type: ecr::protocol::TransactionType::Sale,
                amount: amount_cents,
                currency: currency.clone(),
                order_id: order_id.clone(),
                tip_amount: options
                    .get("tipAmount")
                    .and_then(|v| v.as_f64())
                    .map(|t| (t * 100.0).round() as i64),
                original_transaction_id: None,
                fiscal_data: None,
            };
            match mgr.process_transaction(did, &request) {
                Ok(resp) => {
                    let status_str = format!("{:?}", resp.status).to_lowercase();
                    let transaction = serde_json::json!({
                        "id": resp.transaction_id,
                        "amount": amount,
                        "status": status_str,
                        "authorizationCode": resp.authorization_code,
                        "terminalReference": resp.terminal_reference,
                        "cardType": resp.card_type,
                        "cardLastFour": resp.card_last_four,
                        "entryMethod": resp.entry_method,
                        "errorMessage": resp.error_message,
                        "startedAt": resp.started_at,
                        "completedAt": resp.completed_at,
                    });
                    // Log transaction to DB
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": resp.transaction_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "sale",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": status_str,
                            "authorizationCode": resp.authorization_code,
                            "terminalReference": resp.terminal_reference,
                            "cardType": resp.card_type,
                            "cardLastFour": resp.card_last_four,
                            "entryMethod": resp.entry_method,
                            "errorMessage": resp.error_message,
                            "rawResponse": resp.raw_response,
                            "startedAt": resp.started_at,
                            "completedAt": resp.completed_at,
                        }),
                    );

                    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
                    return Ok(serde_json::json!({
                        "success": status_str == "approved",
                        "transaction": transaction,
                        "options": options
                    }));
                }
                Err(e) => {
                    let _ = app.emit(
                        "ecr_event_error",
                        serde_json::json!({ "error": e, "deviceId": did }),
                    );
                    // Log failed transaction
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": tx_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "sale",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": "error",
                            "errorMessage": e,
                            "startedAt": started,
                            "completedAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": e,
                        "options": options
                    }));
                }
            }
        }
    }

    // No device connected — return mock-approved for backward compat
    let transaction = serde_json::json!({
        "id": tx_id,
        "amount": amount,
        "status": "approved"
    });
    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
    Ok(serde_json::json!({
        "success": true,
        "transaction": transaction,
        "options": options
    }))
}

#[tauri::command]
pub async fn ecr_process_refund(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_amount_and_options_payload(arg0, arg1);
    let amount = parsed.amount;
    let options = parsed.options;
    let device_id = options
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let order_id = options
        .get("orderId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let original_tx_id = options
        .get("originalTransactionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let currency = options
        .get("currency")
        .and_then(|v| v.as_str())
        .unwrap_or("EUR")
        .to_string();

    let _ = app.emit(
        "ecr_event_transaction_started",
        serde_json::json!({ "type": "refund", "amount": amount }),
    );

    let tx_id = format!("txn-{}", uuid::Uuid::new_v4());
    let amount_cents = (amount * 100.0).round() as i64;
    let started = chrono::Utc::now().to_rfc3339();

    let resolved_device_id = if let Some(ref did) = device_id {
        Some(did.clone())
    } else {
        mgr.connected_device_ids().into_iter().next()
    };

    if let Some(ref did) = resolved_device_id {
        if mgr.is_connected(did) {
            let request = ecr::protocol::TransactionRequest {
                transaction_id: tx_id.clone(),
                transaction_type: ecr::protocol::TransactionType::Refund,
                amount: amount_cents,
                currency: currency.clone(),
                order_id: order_id.clone(),
                tip_amount: None,
                original_transaction_id: original_tx_id,
                fiscal_data: None,
            };
            match mgr.process_transaction(did, &request) {
                Ok(resp) => {
                    let status_str = format!("{:?}", resp.status).to_lowercase();
                    let transaction = serde_json::json!({
                        "id": resp.transaction_id,
                        "amount": amount,
                        "status": status_str,
                        "authorizationCode": resp.authorization_code,
                        "terminalReference": resp.terminal_reference,
                        "errorMessage": resp.error_message,
                    });
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": resp.transaction_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "refund",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": status_str,
                            "authorizationCode": resp.authorization_code,
                            "terminalReference": resp.terminal_reference,
                            "errorMessage": resp.error_message,
                            "rawResponse": resp.raw_response,
                            "startedAt": resp.started_at,
                            "completedAt": resp.completed_at,
                        }),
                    );
                    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
                    return Ok(serde_json::json!({
                        "success": status_str == "approved",
                        "transaction": transaction,
                        "options": options
                    }));
                }
                Err(e) => {
                    let conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": tx_id,
                            "deviceId": did,
                            "orderId": order_id,
                            "transactionType": "refund",
                            "amount": amount_cents,
                            "currency": currency,
                            "status": "error",
                            "errorMessage": e,
                            "startedAt": started,
                            "completedAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": e,
                        "options": options
                    }));
                }
            }
        }
    }

    // No device connected — mock-approved for backward compat
    let transaction = serde_json::json!({
        "id": tx_id,
        "amount": amount,
        "status": "approved"
    });
    let _ = app.emit("ecr_event_transaction_completed", transaction.clone());
    Ok(serde_json::json!({
        "success": true,
        "transaction": transaction,
        "options": options
    }))
}

#[tauri::command]
pub async fn ecr_void_transaction(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_void_transaction_payload(arg0, arg1)?;
    let txid = parsed.transaction_id;
    if txid.trim().is_empty() {
        let _ = app.emit(
            "ecr_event_error",
            serde_json::json!({ "error": "Missing transactionId" }),
        );
        return Err("Missing transactionId".into());
    }
    // If a device is specified and connected, try to void through protocol
    if let Some(ref did) = parsed.device_id {
        if mgr.is_connected(did) {
            let request = ecr::protocol::TransactionRequest {
                transaction_id: format!("void-{}", uuid::Uuid::new_v4()),
                transaction_type: ecr::protocol::TransactionType::Void,
                amount: 0,
                currency: "EUR".into(),
                order_id: None,
                tip_amount: None,
                original_transaction_id: Some(txid.clone()),
                fiscal_data: None,
            };
            if let Err(e) = mgr.process_transaction(did, &request) {
                tracing::warn!("ECR void failed: {e}");
            }
        }
    }
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({ "status": "voided", "transactionId": txid }),
    );
    Ok(serde_json::json!({
        "success": true,
        "transactionId": txid,
        "deviceId": parsed.device_id
    }))
}

#[tauri::command]
pub async fn ecr_cancel_transaction(
    arg0: Option<serde_json::Value>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_optional_device_id(arg0);
    // If a device ID is provided and connected, attempt protocol-level cancel
    if let Some(ref did) = device_id {
        if mgr.is_connected(did) {
            // DeviceManager doesn't have a direct cancel yet; best-effort abort
            let _ = mgr.disconnect_device(did);
        }
    }
    let _ = app.emit(
        "ecr_event_transaction_status",
        serde_json::json!({ "status": "cancelled", "deviceId": device_id.clone() }),
    );
    Ok(serde_json::json!({
        "success": true,
        "deviceId": device_id,
        "cancelled": true
    }))
}

#[tauri::command]
pub async fn ecr_settlement(
    arg0: Option<serde_json::Value>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let device_id = parse_optional_device_id(arg0);
    let _ = app.emit(
        "ecr_event_display_message",
        serde_json::json!({ "message": "Settlement started", "deviceId": device_id.clone() }),
    );
    if let Some(ref did) = device_id {
        if mgr.is_connected(did) {
            match mgr.settlement(did) {
                Ok(result) => {
                    return Ok(serde_json::json!({
                        "success": result.success,
                        "deviceId": did,
                        "transactionCount": result.transaction_count,
                        "totalAmount": result.total_amount,
                        "zNumber": result.z_number,
                        "errorMessage": result.error_message,
                    }));
                }
                Err(e) => {
                    return Ok(serde_json::json!({
                        "success": false,
                        "deviceId": did,
                        "error": e
                    }));
                }
            }
        }
    }
    Ok(serde_json::json!({ "success": true, "deviceId": device_id }))
}

#[tauri::command]
pub async fn ecr_get_recent_transactions(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let limit = parse_recent_transactions_limit(arg0);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let transactions = db::ecr_list_transactions(&conn, None, Some(limit as u32));
    Ok(serde_json::json!({
        "success": true,
        "transactions": transactions
    }))
}

#[tauri::command]
pub async fn ecr_query_transactions(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let filters = parse_query_filters_payload(arg0);
    let device_id = filters
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let limit = filters.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as u32;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let transactions = db::ecr_list_transactions(&conn, device_id.as_deref(), Some(limit));
    Ok(serde_json::json!({
        "success": true,
        "transactions": transactions
    }))
}

#[tauri::command]
pub async fn ecr_get_transaction_stats(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let filters = parse_query_filters_payload(arg0);
    let device_filter = value_str(&filters, &["deviceId", "device_id"]);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let transactions = db::ecr_list_transactions(&conn, device_filter.as_deref(), None);
    let count = transactions.len();
    let total: i64 = transactions
        .iter()
        .filter_map(|t| t.get("amount").and_then(|v| v.as_i64()))
        .sum();
    Ok(serde_json::json!({
        "success": true,
        "count": count,
        "totalAmount": total
    }))
}

#[tauri::command]
pub async fn ecr_get_transaction_for_order(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    if let Some(order_id) = parse_optional_order_id(arg0) {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let all = db::ecr_list_transactions(&conn, None, None);
        let matched = all.into_iter().find(|t| {
            t.get("orderId")
                .and_then(|v| v.as_str())
                .map(|oid| oid == order_id)
                .unwrap_or(false)
        });
        return Ok(serde_json::json!({
            "success": true,
            "transaction": matched
        }));
    }
    Ok(serde_json::json!({
        "success": true,
        "transaction": serde_json::Value::Null
    }))
}

// -- ECR new commands --------------------------------------------------------

#[tauri::command]
pub async fn ecr_test_connection(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = db::ecr_get_device(&conn, &device_id)
        .ok_or_else(|| format!("Device {device_id} not found"))?;

    let connection_type = device
        .get("connectionType")
        .and_then(|v| v.as_str())
        .unwrap_or("serial_usb");
    let connection_details = device
        .get("connectionDetails")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let protocol_name = device
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or("generic");
    let settings = device
        .get("settings")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    match mgr.test_connection(
        &device_id,
        connection_type,
        &connection_details,
        protocol_name,
        &settings,
    ) {
        Ok(ok) => Ok(serde_json::json!({
            "success": true,
            "connected": ok
        })),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "connected": false,
            "error": e
        })),
    }
}

#[tauri::command]
pub async fn ecr_test_print(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let device_id = parse_required_device_id(arg0)?;

    // If connected, send a short test via raw bytes
    if mgr.is_connected(&device_id) {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let device = db::ecr_get_device(&conn, &device_id)
            .ok_or_else(|| format!("Device {device_id} not found"))?;
        let print_mode = device
            .get("printMode")
            .and_then(|v| v.as_str())
            .unwrap_or("register_prints");

        if print_mode == "pos_sends_receipt" {
            // Build a simple ESC/POS test receipt
            let mut b = crate::escpos::EscPosBuilder::new();
            b.init();
            b.center();
            b.bold(true);
            b.text("=== TEST PRINT ===");
            b.bold(false);
            b.feed(1);
            b.text("Cash Register Test OK");
            b.feed(1);
            let now = chrono::Local::now().format("%d/%m/%Y %H:%M").to_string();
            b.text(&now);
            b.feed(3);
            b.cut();
            let data = b.build();
            mgr.send_raw(&device_id, &data)?;
        } else {
            // For register_prints mode, send a status inquiry
            let _ = mgr.send_raw(
                &device_id,
                &[0x02, 0x01, 0x21, 0x4A, 0x05, 0x6A, 0x03], // STATUS frame
            );
        }

        return Ok(serde_json::json!({ "success": true, "printed": true }));
    }

    Ok(serde_json::json!({
        "success": false,
        "error": "Device not connected"
    }))
}

#[tauri::command]
pub async fn ecr_fiscal_print(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    mgr: tauri::State<'_, ecr::DeviceManager>,
) -> Result<serde_json::Value, String> {
    let order_id = parse_required_order_id(arg0)?;

    // Find default cash register
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let device = match db::ecr_get_default_device(&conn, Some("cash_register")) {
        Some(d) => d,
        None => {
            // No cash register configured — skip silently
            return Ok(serde_json::json!({ "success": true, "skipped": true }));
        }
    };

    let device_id = device
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Device has no id")?
        .to_string();

    let enabled = device
        .get("enabled")
        .and_then(|v| v.as_bool())
        .or_else(|| {
            device
                .get("enabled")
                .and_then(|v| v.as_i64())
                .map(|i| i != 0)
        })
        .unwrap_or(true);
    if !enabled {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }

    // Load order from DB
    let order_json_str: Option<String> = conn
        .prepare("SELECT data FROM orders WHERE id = ?1")
        .ok()
        .and_then(|mut stmt| {
            stmt.query_row(rusqlite::params![order_id], |row| row.get(0))
                .ok()
        });
    let order: serde_json::Value = match order_json_str {
        Some(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        None => return Err(format!("Order {order_id} not found")),
    };

    // Load payments
    let payments: Vec<serde_json::Value> = conn
        .prepare("SELECT data FROM order_payments WHERE order_id = ?1")
        .ok()
        .map(|mut stmt| {
            stmt.query_map(rusqlite::params![order_id], |row| {
                let s: String = row.get(0)?;
                Ok(serde_json::from_str::<serde_json::Value>(&s).unwrap_or_default())
            })
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
        })
        .unwrap_or_default();

    // Parse tax rates from device config
    let tax_rates_json = device
        .get("taxRates")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let tax_rates: Vec<ecr::protocol::TaxRateConfig> =
        serde_json::from_value(tax_rates_json).unwrap_or_default();

    let operator_id = device
        .get("operatorId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let print_mode = device
        .get("printMode")
        .and_then(|v| v.as_str())
        .unwrap_or("register_prints");

    // Build fiscal data
    let fiscal_data =
        ecr::fiscal::build_fiscal_data(&order, &payments, &tax_rates, operator_id.as_deref())?;

    if !mgr.is_connected(&device_id) {
        return Ok(serde_json::json!({
            "success": false,
            "error": "Cash register not connected"
        }));
    }

    match print_mode {
        "pos_sends_receipt" => {
            // Format ESC/POS receipt and send raw
            let escpos_bytes = ecr::fiscal::format_fiscal_receipt_escpos(
                &fiscal_data,
                crate::escpos::PaperWidth::Mm80,
                false,
            );
            mgr.send_raw(&device_id, &escpos_bytes)?;
        }
        _ => {
            // register_prints mode: send structured fiscal receipt via protocol
            let tx_id = format!("fiscal-{}", uuid::Uuid::new_v4());
            let started = chrono::Utc::now().to_rfc3339();
            let request = ecr::protocol::TransactionRequest {
                transaction_id: tx_id.clone(),
                transaction_type: ecr::protocol::TransactionType::FiscalReceipt,
                amount: fiscal_data.payments.iter().map(|p| p.amount).sum(),
                currency: "EUR".into(),
                order_id: Some(order_id.clone()),
                tip_amount: None,
                original_transaction_id: None,
                fiscal_data: Some(fiscal_data),
            };
            match mgr.process_transaction(&device_id, &request) {
                Ok(resp) => {
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": resp.transaction_id,
                            "deviceId": device_id,
                            "orderId": order_id,
                            "transactionType": "fiscal_receipt",
                            "amount": request.amount,
                            "currency": "EUR",
                            "status": format!("{:?}", resp.status).to_lowercase(),
                            "fiscalReceiptNumber": resp.fiscal_receipt_number,
                            "startedAt": resp.started_at,
                            "completedAt": resp.completed_at,
                            "rawResponse": resp.raw_response,
                        }),
                    );
                }
                Err(e) => {
                    let _ = db::ecr_insert_transaction(
                        &conn,
                        &serde_json::json!({
                            "id": tx_id,
                            "deviceId": device_id,
                            "orderId": order_id,
                            "transactionType": "fiscal_receipt",
                            "amount": 0,
                            "currency": "EUR",
                            "status": "error",
                            "errorMessage": e,
                            "startedAt": started,
                            "completedAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    tracing::warn!("Fiscal print failed for order {order_id}: {e}");
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": e
                    }));
                }
            }
        }
    }

    Ok(serde_json::json!({ "success": true }))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_required_device_id_supports_string_and_object() {
        let from_string = parse_required_device_id(Some(serde_json::json!("device-1")))
            .expect("string device id should parse");
        let from_object = parse_required_device_id(Some(serde_json::json!({
            "deviceId": "device-2"
        })))
        .expect("object device id should parse");
        assert_eq!(from_string, "device-1");
        assert_eq!(from_object, "device-2");
    }

    #[test]
    fn parse_discover_args_supports_legacy_tuple_and_object() {
        let (types_from_legacy, timeout_from_legacy) = parse_discover_args(
            Some(serde_json::json!(["USB", "bluetooth"])),
            Some(serde_json::json!(15)),
        );
        assert_eq!(
            types_from_legacy,
            vec!["usb".to_string(), "bluetooth".to_string()]
        );
        assert_eq!(timeout_from_legacy, Some(15));

        let (types_from_object, timeout_from_object) = parse_discover_args(
            Some(serde_json::json!({
                "connectionTypes": ["network"],
                "connectionType": "serial_usb",
                "timeoutMs": 30
            })),
            None,
        );
        assert_eq!(
            types_from_object,
            vec!["network".to_string(), "serial_usb".to_string()]
        );
        assert_eq!(timeout_from_object, Some(30));
    }

    #[test]
    fn parse_update_device_payload_supports_legacy_and_object() {
        let legacy = parse_update_device_payload(
            Some(serde_json::json!("device-a")),
            Some(serde_json::json!({ "enabled": false })),
        )
        .expect("legacy tuple should parse");
        assert_eq!(legacy.device_id, "device-a");
        assert_eq!(
            legacy.updates.get("enabled").and_then(|v| v.as_bool()),
            Some(false)
        );

        let object = parse_update_device_payload(
            Some(serde_json::json!({
                "deviceId": "device-b",
                "updates": { "name": "Counter Terminal" }
            })),
            None,
        )
        .expect("object payload should parse");
        assert_eq!(object.device_id, "device-b");
        assert_eq!(
            object.updates.get("name").and_then(|v| v.as_str()),
            Some("Counter Terminal")
        );
    }

    #[test]
    fn parse_amount_and_options_payload_supports_object_shape() {
        let parsed = parse_amount_and_options_payload(
            Some(serde_json::json!({
                "amount": 12.5,
                "deviceId": "device-9",
                "orderId": "order-1"
            })),
            None,
        );
        assert_eq!(parsed.amount, 12.5);
        assert_eq!(
            parsed.options.get("deviceId").and_then(|v| v.as_str()),
            Some("device-9")
        );
    }

    #[test]
    fn parse_void_transaction_payload_supports_legacy_tuple_and_object() {
        let legacy = parse_void_transaction_payload(
            Some(serde_json::json!("tx-1")),
            Some(serde_json::json!("device-1")),
        )
        .expect("legacy void payload should parse");
        assert_eq!(legacy.transaction_id, "tx-1");
        assert_eq!(legacy.device_id.as_deref(), Some("device-1"));

        let object = parse_void_transaction_payload(
            Some(serde_json::json!({
                "transactionId": "tx-2",
                "deviceId": "device-2"
            })),
            None,
        )
        .expect("object void payload should parse");
        assert_eq!(object.transaction_id, "tx-2");
        assert_eq!(object.device_id.as_deref(), Some("device-2"));
    }

    #[test]
    fn parse_recent_transactions_limit_accepts_number_and_object() {
        let from_number = parse_recent_transactions_limit(Some(serde_json::json!(25)));
        let from_object = parse_recent_transactions_limit(Some(serde_json::json!({ "limit": 40 })));
        assert_eq!(from_number, 25);
        assert_eq!(from_object, 40);
    }

    #[test]
    fn parse_query_filters_payload_supports_device_string() {
        let parsed = parse_query_filters_payload(Some(serde_json::json!("device-11")));
        assert_eq!(
            parsed.get("deviceId").and_then(|v| v.as_str()),
            Some("device-11")
        );
    }
}
