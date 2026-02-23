use serde_json::Value;

use crate::{customer_display, db, drawer, hardware_manager, loyalty, scale, scanner, serial};

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn value_to_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn value_to_u32(value: &Value) -> Option<u32> {
    value_to_u64(value).and_then(|v| u32::try_from(v).ok())
}

fn value_to_u16(value: &Value) -> Option<u16> {
    value_to_u64(value).and_then(|v| u16::try_from(v).ok())
}

fn value_to_usize(value: &Value) -> Option<usize> {
    value_to_u64(value).and_then(|v| usize::try_from(v).ok())
}

fn value_to_i32(value: &Value) -> Option<i32> {
    match value {
        Value::Number(n) => n
            .as_i64()
            .and_then(|v| i32::try_from(v).ok())
            .or_else(|| n.as_u64().and_then(|v| i32::try_from(v).ok())),
        Value::String(s) => s.trim().parse::<i32>().ok(),
        _ => None,
    }
}

fn value_to_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn payload_string(payload: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(value_to_string) {
            return Some(value);
        }
    }
    None
}

fn payload_u64(payload: &Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(value_to_u64) {
            return Some(value);
        }
    }
    None
}

fn payload_u32(payload: &Value, keys: &[&str]) -> Option<u32> {
    payload_u64(payload, keys).and_then(|v| u32::try_from(v).ok())
}

fn payload_u16(payload: &Value, keys: &[&str]) -> Option<u16> {
    payload_u64(payload, keys).and_then(|v| u16::try_from(v).ok())
}

fn payload_usize(payload: &Value, keys: &[&str]) -> Option<usize> {
    payload_u64(payload, keys).and_then(|v| usize::try_from(v).ok())
}

fn payload_i32(payload: &Value, keys: &[&str]) -> Option<i32> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(value_to_i32) {
            return Some(value);
        }
    }
    None
}

fn payload_f64(payload: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(value_to_f64) {
            return Some(value);
        }
    }
    None
}

fn parse_serial_open_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
) -> Result<(String, u32, Option<u64>), String> {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let port = payload_string(&payload, &["port", "portName", "name", "device", "arg0"])
            .ok_or("Missing port name")?;
        let baud =
            payload_u32(&payload, &["baud", "baudRate", "baud_rate", "arg1"]).unwrap_or(9600);
        let timeout = payload_u64(&payload, &["timeout", "timeoutMs", "timeout_ms", "arg2"]);
        return Ok((port, baud, timeout));
    }

    let port = arg0
        .as_ref()
        .and_then(value_to_string)
        .ok_or("Missing port name")?;
    let baud = arg1.as_ref().and_then(value_to_u32).unwrap_or(9600);
    let timeout = arg2.as_ref().and_then(value_to_u64);
    Ok((port, baud, timeout))
}

fn parse_required_handle(arg0: Option<Value>) -> Result<String, String> {
    match arg0 {
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            payload_string(
                &payload,
                &["handle", "portHandle", "port_handle", "id", "arg0"],
            )
            .ok_or("Missing port handle".into())
        }
        Some(v) => value_to_string(&v).ok_or("Missing port handle".into()),
        None => Err("Missing port handle".into()),
    }
}

fn parse_serial_read_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<(String, usize), String> {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let handle = payload_string(&payload, &["handle", "portHandle", "port_handle", "arg0"])
            .ok_or("Missing port handle")?;
        let max_bytes = payload_usize(
            &payload,
            &["maxBytes", "max_bytes", "length", "len", "arg1"],
        )
        .unwrap_or(256);
        return Ok((handle, max_bytes));
    }
    let handle = parse_required_handle(arg0)?;
    let max_bytes = arg1.as_ref().and_then(value_to_usize).unwrap_or(256);
    Ok((handle, max_bytes))
}

fn parse_serial_write_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<(String, Vec<u8>), String> {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let handle = payload_string(&payload, &["handle", "portHandle", "port_handle", "arg0"])
            .ok_or("Missing port handle")?;
        let data_value = payload
            .get("data")
            .or_else(|| payload.get("bytes"))
            .or_else(|| payload.get("arg1"))
            .cloned();
        let data = parse_byte_array_value(data_value).ok_or("Missing data to write")?;
        return Ok((handle, data));
    }

    let handle = parse_required_handle(arg0)?;
    let data = parse_byte_array_value(arg1).ok_or("Missing data to write")?;
    Ok((handle, data))
}

fn parse_byte_array_value(value: Option<Value>) -> Option<Vec<u8>> {
    match value {
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                let byte = value_to_u64(&item).and_then(|n| u8::try_from(n).ok())?;
                out.push(byte);
            }
            Some(out)
        }
        Some(Value::String(text)) => Some(text.into_bytes()),
        Some(_) | None => None,
    }
}

fn parse_scale_connect_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
) -> Result<(String, u32, String), String> {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let port = payload_string(&payload, &["port", "portName", "port_name", "arg0"])
            .ok_or("Missing port")?;
        let baud =
            payload_u32(&payload, &["baud", "baudRate", "baud_rate", "arg1"]).unwrap_or(9600);
        let protocol = payload_string(&payload, &["protocol", "arg2"])
            .unwrap_or_else(|| "generic".to_string());
        return Ok((port, baud, protocol));
    }
    let port = arg0
        .as_ref()
        .and_then(value_to_string)
        .ok_or("Missing port")?;
    let baud = arg1.as_ref().and_then(value_to_u32).unwrap_or(9600);
    let protocol = arg2
        .as_ref()
        .and_then(value_to_string)
        .unwrap_or_else(|| "generic".to_string());
    Ok((port, baud, protocol))
}

fn parse_display_connect_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    arg3: Option<Value>,
) -> Result<(String, String, Option<u16>, Option<u32>), String> {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let connection_type = payload_string(
            &payload,
            &["connectionType", "connection_type", "type", "arg0"],
        )
        .ok_or("Missing connection type")?;
        let target = payload_string(
            &payload,
            &["target", "portOrIp", "port_or_ip", "host", "ip", "arg1"],
        )
        .ok_or("Missing target (port or IP)")?;
        let port_number = payload_u16(
            &payload,
            &["portNumber", "port_number", "tcpPort", "tcp_port", "arg2"],
        );
        let baud_rate = payload_u32(&payload, &["baudRate", "baud_rate", "arg3"]);
        return Ok((connection_type, target, port_number, baud_rate));
    }

    let connection_type = arg0
        .as_ref()
        .and_then(value_to_string)
        .ok_or("Missing connection type")?;
    let target = arg1
        .as_ref()
        .and_then(value_to_string)
        .ok_or("Missing target (port or IP)")?;
    let port_number = arg2.as_ref().and_then(value_to_u16);
    let baud_rate = arg3.as_ref().and_then(value_to_u32);
    Ok((connection_type, target, port_number, baud_rate))
}

fn parse_display_show_line_args(arg0: Option<Value>, arg1: Option<Value>) -> (String, String) {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let line1 = payload_string(&payload, &["line1", "line_1", "text1", "firstLine", "arg0"])
            .unwrap_or_default();
        let line2 = payload_string(
            &payload,
            &["line2", "line_2", "text2", "secondLine", "arg1"],
        )
        .unwrap_or_default();
        return (line1, line2);
    }

    let line1 = arg0.as_ref().and_then(value_to_string).unwrap_or_default();
    let line2 = arg1.as_ref().and_then(value_to_string).unwrap_or_default();
    (line1, line2)
}

fn parse_display_show_item_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    arg3: Option<Value>,
) -> (String, f64, i32, String) {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let name = payload_string(&payload, &["name", "itemName", "item_name", "arg0"])
            .unwrap_or_default();
        let price = payload_f64(&payload, &["price", "amount", "arg1"]).unwrap_or(0.0);
        let qty = payload_i32(&payload, &["qty", "quantity", "count", "arg2"]).unwrap_or(1);
        let currency = payload_string(&payload, &["currency", "symbol", "arg3"])
            .unwrap_or_else(|| "$".to_string());
        return (name, price, qty, currency);
    }

    let name = arg0.as_ref().and_then(value_to_string).unwrap_or_default();
    let price = arg1.as_ref().and_then(value_to_f64).unwrap_or(0.0);
    let qty = arg2.as_ref().and_then(value_to_i32).unwrap_or(1);
    let currency = arg3
        .as_ref()
        .and_then(value_to_string)
        .unwrap_or_else(|| "$".to_string());
    (name, price, qty, currency)
}

fn parse_display_show_total_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    arg3: Option<Value>,
) -> (f64, f64, f64, String) {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let subtotal = payload_f64(&payload, &["subtotal", "subTotal", "arg0"]).unwrap_or(0.0);
        let tax = payload_f64(&payload, &["tax", "taxAmount", "tax_amount", "arg1"]).unwrap_or(0.0);
        let total =
            payload_f64(&payload, &["total", "grandTotal", "grand_total", "arg2"]).unwrap_or(0.0);
        let currency = payload_string(&payload, &["currency", "symbol", "arg3"])
            .unwrap_or_else(|| "$".to_string());
        return (subtotal, tax, total, currency);
    }

    let subtotal = arg0.as_ref().and_then(value_to_f64).unwrap_or(0.0);
    let tax = arg1.as_ref().and_then(value_to_f64).unwrap_or(0.0);
    let total = arg2.as_ref().and_then(value_to_f64).unwrap_or(0.0);
    let currency = arg3
        .as_ref()
        .and_then(value_to_string)
        .unwrap_or_else(|| "$".to_string());
    (subtotal, tax, total, currency)
}

fn parse_scanner_start_args(
    arg0: Option<Value>,
    arg1: Option<Value>,
) -> Result<(String, u32), String> {
    if let Some(Value::Object(obj)) = arg0 {
        let payload = Value::Object(obj);
        let port = payload_string(&payload, &["port", "portName", "port_name", "arg0"])
            .ok_or("Missing port")?;
        let baud =
            payload_u32(&payload, &["baud", "baudRate", "baud_rate", "arg1"]).unwrap_or(9600);
        return Ok((port, baud));
    }
    let port = arg0
        .as_ref()
        .and_then(value_to_string)
        .ok_or("Missing port")?;
    let baud = arg1.as_ref().and_then(value_to_u32).unwrap_or(9600);
    Ok((port, baud))
}

fn parse_loyalty_uid(arg0: Option<Value>) -> Result<String, String> {
    match arg0 {
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            payload_string(&payload, &["uid", "cardUid", "card_uid", "arg0"])
                .ok_or("Missing card UID".into())
        }
        Some(v) => value_to_string(&v).ok_or("Missing card UID".into()),
        None => Err("Missing card UID".into()),
    }
}

fn parse_device_type_payload(arg0: Option<Value>) -> Result<String, String> {
    match arg0 {
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            payload_string(&payload, &["deviceType", "device_type", "type", "arg0"])
                .ok_or("Missing device type".into())
        }
        Some(v) => value_to_string(&v).ok_or("Missing device type".into()),
        None => Err("Missing device type".into()),
    }
}

fn parse_optional_printer_id(arg0: Option<Value>) -> Option<String> {
    match arg0 {
        Some(Value::Object(obj)) => {
            let payload = Value::Object(obj);
            payload_string(&payload, &["printerId", "printer_id", "id", "arg0"])
        }
        Some(v) => value_to_string(&v),
        None => None,
    }
}

#[tauri::command]
pub async fn serial_list_ports() -> Result<Value, String> {
    serial::list_ports()
}

#[tauri::command]
pub async fn serial_open(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
) -> Result<Value, String> {
    let (port, baud, timeout) = parse_serial_open_args(arg0, arg1, arg2)?;
    serial::open_port(&port, baud, timeout)
}

#[tauri::command]
pub async fn serial_close(arg0: Option<Value>) -> Result<Value, String> {
    let handle = parse_required_handle(arg0)?;
    serial::close_port(&handle)
}

#[tauri::command]
pub async fn serial_read(arg0: Option<Value>, arg1: Option<Value>) -> Result<Value, String> {
    let (handle, max_bytes) = parse_serial_read_args(arg0, arg1)?;
    serial::read_port(&handle, max_bytes)
}

#[tauri::command]
pub async fn serial_write(arg0: Option<Value>, arg1: Option<Value>) -> Result<Value, String> {
    let (handle, data) = parse_serial_write_args(arg0, arg1)?;
    serial::write_port(&handle, &data)
}

#[tauri::command]
pub async fn scale_connect(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let (port, baud, protocol) = parse_scale_connect_args(arg0, arg1, arg2)?;
    scale::connect(&port, baud, &protocol, app)
}

#[tauri::command]
pub async fn scale_disconnect() -> Result<Value, String> {
    scale::disconnect()
}

#[tauri::command]
pub async fn scale_read_weight() -> Result<Value, String> {
    scale::read_weight()
}

#[tauri::command]
pub async fn scale_tare() -> Result<Value, String> {
    scale::tare()
}

#[tauri::command]
pub async fn scale_get_status() -> Result<Value, String> {
    scale::get_status()
}

#[tauri::command]
pub async fn display_connect(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    arg3: Option<Value>,
) -> Result<Value, String> {
    let (conn_type, target, port_number, baud_rate) =
        parse_display_connect_args(arg0, arg1, arg2, arg3)?;
    customer_display::connect(&conn_type, &target, port_number, baud_rate)
}

#[tauri::command]
pub async fn display_disconnect() -> Result<Value, String> {
    customer_display::disconnect()
}

#[tauri::command]
pub async fn display_show_line(arg0: Option<Value>, arg1: Option<Value>) -> Result<Value, String> {
    let (line1, line2) = parse_display_show_line_args(arg0, arg1);
    customer_display::show_line(&line1, &line2)
}

#[tauri::command]
pub async fn display_show_item(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    arg3: Option<Value>,
) -> Result<Value, String> {
    let (name, price, qty, currency) = parse_display_show_item_args(arg0, arg1, arg2, arg3);
    customer_display::show_item(&name, price, qty, &currency)
}

#[tauri::command]
pub async fn display_show_total(
    arg0: Option<Value>,
    arg1: Option<Value>,
    arg2: Option<Value>,
    arg3: Option<Value>,
) -> Result<Value, String> {
    let (subtotal, tax, total, currency) = parse_display_show_total_args(arg0, arg1, arg2, arg3);
    customer_display::show_total(subtotal, tax, total, &currency)
}

#[tauri::command]
pub async fn display_clear() -> Result<Value, String> {
    customer_display::clear()
}

#[tauri::command]
pub async fn display_get_status() -> Result<Value, String> {
    customer_display::get_status()
}

#[tauri::command]
pub async fn scanner_serial_start(
    arg0: Option<Value>,
    arg1: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let (port, baud) = parse_scanner_start_args(arg0, arg1)?;
    scanner::start(&port, baud, app)
}

#[tauri::command]
pub async fn scanner_serial_stop() -> Result<Value, String> {
    scanner::stop()
}

#[tauri::command]
pub async fn scanner_serial_status() -> Result<Value, String> {
    scanner::get_status()
}

#[tauri::command]
pub async fn loyalty_reader_start(app: tauri::AppHandle) -> Result<Value, String> {
    loyalty::start(app)
}

#[tauri::command]
pub async fn loyalty_reader_stop() -> Result<Value, String> {
    loyalty::stop()
}

#[tauri::command]
pub async fn loyalty_process_card(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let uid = parse_loyalty_uid(arg0)?;
    loyalty::process_card_scan(&uid, &app)
}

#[tauri::command]
pub async fn loyalty_reader_status() -> Result<Value, String> {
    loyalty::get_status()
}

#[tauri::command]
pub async fn hardware_get_status() -> Result<Value, String> {
    hardware_manager::get_status()
}

#[tauri::command]
pub async fn hardware_reconnect(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let device_type = parse_device_type_payload(arg0)?;
    // Build settings from local_settings
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut settings = serde_json::json!({});
    if let Some(val) = db::get_setting(&conn, "hardware", "scale_port") {
        settings["scale_port"] = val.into();
    }
    if let Some(val) = db::get_setting(&conn, "hardware", "barcode_scanner_port") {
        settings["barcode_scanner_port"] = val.into();
    }
    drop(conn);
    hardware_manager::reconnect(&device_type, &settings, &app)
}

#[tauri::command]
pub async fn drawer_open(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let printer_id = parse_optional_printer_id(arg0);
    drawer::open_cash_drawer(&db, printer_id.as_deref())
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_serial_open_args_supports_legacy_and_object_payloads() {
        let legacy = parse_serial_open_args(
            Some(serde_json::json!("COM3")),
            Some(serde_json::json!(19200)),
            Some(serde_json::json!(500)),
        )
        .expect("legacy serial_open payload should parse");
        assert_eq!(legacy.0, "COM3");
        assert_eq!(legacy.1, 19200);
        assert_eq!(legacy.2, Some(500));

        let object = parse_serial_open_args(
            Some(serde_json::json!({
                "port": "COM7",
                "baud_rate": 9600,
                "timeoutMs": 750
            })),
            None,
            None,
        )
        .expect("object serial_open payload should parse");
        assert_eq!(object.0, "COM7");
        assert_eq!(object.1, 9600);
        assert_eq!(object.2, Some(750));
    }

    #[test]
    fn parse_serial_write_args_supports_object_and_array_bytes() {
        let parsed = parse_serial_write_args(
            Some(serde_json::json!({
                "handle": "h-1",
                "data": [65, 66, 67]
            })),
            None,
        )
        .expect("serial_write object payload should parse");
        assert_eq!(parsed.0, "h-1");
        assert_eq!(parsed.1, vec![65, 66, 67]);
    }

    #[test]
    fn parse_scale_connect_args_supports_named_object_keys() {
        let parsed = parse_scale_connect_args(
            Some(serde_json::json!({
                "port": "COM8",
                "baudRate": 4800,
                "protocol": "toledo"
            })),
            None,
            None,
        )
        .expect("scale_connect object payload should parse");
        assert_eq!(parsed.0, "COM8");
        assert_eq!(parsed.1, 4800);
        assert_eq!(parsed.2, "toledo");
    }

    #[test]
    fn parse_display_connect_args_supports_connection_settings_shape() {
        let parsed = parse_display_connect_args(
            Some(serde_json::json!({
                "connection_type": "network",
                "port_or_ip": "192.168.1.42",
                "port_number": 9100
            })),
            None,
            None,
            None,
        )
        .expect("display_connect object payload should parse");
        assert_eq!(parsed.0, "network");
        assert_eq!(parsed.1, "192.168.1.42");
        assert_eq!(parsed.2, Some(9100));
        assert_eq!(parsed.3, None);
    }

    #[test]
    fn parse_display_show_item_args_supports_object_keys() {
        let parsed = parse_display_show_item_args(
            Some(serde_json::json!({
                "name": "Coffee",
                "price": 3.5,
                "qty": 2,
                "currency": "EUR"
            })),
            None,
            None,
            None,
        );
        assert_eq!(parsed.0, "Coffee");
        assert_eq!(parsed.1, 3.5);
        assert_eq!(parsed.2, 2);
        assert_eq!(parsed.3, "EUR");
    }

    #[test]
    fn parse_scanner_start_args_supports_object_payload() {
        let parsed = parse_scanner_start_args(
            Some(serde_json::json!({
                "port": "COM4",
                "baud_rate": 9600
            })),
            None,
        )
        .expect("scanner object payload should parse");
        assert_eq!(parsed.0, "COM4");
        assert_eq!(parsed.1, 9600);
    }

    #[test]
    fn parse_loyalty_uid_supports_object_payload() {
        let parsed = parse_loyalty_uid(Some(serde_json::json!({
            "uid": "ABC123"
        })))
        .expect("loyalty payload should parse");
        assert_eq!(parsed, "ABC123");
    }

    #[test]
    fn parse_device_type_payload_requires_value() {
        let err = parse_device_type_payload(Some(serde_json::json!({})))
            .expect_err("missing device type should fail");
        assert!(err.contains("Missing device type"));
    }
}
