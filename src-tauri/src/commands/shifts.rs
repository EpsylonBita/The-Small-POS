use chrono::{Datelike, Local, TimeZone, Utc};
use rusqlite::params;
use serde::Deserialize;
use tauri::Emitter;
use tracing::{info, warn};

use crate::shifts as shift_service;
use crate::{
    db, fetch_supabase_rows, hydrate_terminal_credentials_from_local_settings, print,
    read_local_setting, storage, value_f64, value_str,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftStaffPayload {
    #[serde(alias = "staff_id", alias = "id")]
    staff_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftTerminalPayload {
    #[serde(alias = "terminal_id", alias = "id")]
    terminal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftBranchTerminalPayload {
    #[serde(alias = "branch_id")]
    branch_id: String,
    #[serde(alias = "terminal_id")]
    terminal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftSummaryPayload {
    #[serde(alias = "shift_id", alias = "id")]
    shift_id: String,
    #[serde(default, alias = "skip_backfill")]
    skip_backfill: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftPrintCheckoutPayload {
    #[serde(alias = "shift_id", alias = "id")]
    shift_id: String,
    #[serde(default, alias = "role_type")]
    role_type: Option<String>,
    #[serde(default, alias = "terminal_name")]
    terminal_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CashierShiftPayload {
    #[serde(alias = "cashier_shift_id", alias = "shift_id", alias = "id")]
    cashier_shift_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftStaffPaymentsByStaffPayload {
    #[serde(alias = "staff_id")]
    staff_id: String,
    #[serde(default, alias = "date_from")]
    date_from: Option<String>,
    #[serde(default, alias = "date_to")]
    date_to: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftStaffDatePayload {
    #[serde(alias = "staff_id", alias = "id")]
    staff_id: String,
    date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftBranchPayload {
    #[serde(alias = "branch_id", alias = "id")]
    branch_id: String,
}

fn parse_shift_staff_payload(arg0: Option<serde_json::Value>) -> Result<ShiftStaffPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(staff_id)) => serde_json::json!({
            "staffId": staff_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: ShiftStaffPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid staff payload: {e}"))?;
    parsed.staff_id = parsed.staff_id.trim().to_string();
    if parsed.staff_id.is_empty() {
        return Err("Missing staffId".into());
    }
    Ok(parsed)
}

fn parse_shift_terminal_payload(
    arg0: Option<serde_json::Value>,
) -> Result<ShiftTerminalPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(terminal_id)) => serde_json::json!({
            "terminalId": terminal_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: ShiftTerminalPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid terminal payload: {e}"))?;
    parsed.terminal_id = parsed.terminal_id.trim().to_string();
    if parsed.terminal_id.is_empty() {
        return Err("Missing terminalId".into());
    }
    Ok(parsed)
}

fn merge_payload_args(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> serde_json::Value {
    match (arg0, arg1) {
        (Some(serde_json::Value::Object(mut base)), Some(serde_json::Value::Object(extra))) => {
            for (k, v) in extra {
                base.insert(k, v);
            }
            serde_json::Value::Object(base)
        }
        (Some(v), None) => v,
        (None, Some(v)) => v,
        (Some(v), Some(_)) => v,
        _ => serde_json::json!({}),
    }
}

fn parse_shift_branch_terminal_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<ShiftBranchTerminalPayload, String> {
    let payload = match (arg0, arg1) {
        (
            Some(serde_json::Value::String(branch_id)),
            Some(serde_json::Value::String(terminal_id)),
        ) => {
            serde_json::json!({
                "branchId": branch_id,
                "terminalId": terminal_id
            })
        }
        (
            Some(serde_json::Value::Object(mut obj)),
            Some(serde_json::Value::String(terminal_id)),
        ) => {
            obj.insert(
                "terminalId".to_string(),
                serde_json::Value::String(terminal_id),
            );
            serde_json::Value::Object(obj)
        }
        (Some(serde_json::Value::String(branch_id)), Some(serde_json::Value::Object(mut obj))) => {
            obj.entry("branchId".to_string())
                .or_insert(serde_json::Value::String(branch_id));
            serde_json::Value::Object(obj)
        }
        (lhs, rhs) => merge_payload_args(lhs, rhs),
    };

    let mut parsed: ShiftBranchTerminalPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid branch/terminal payload: {e}"))?;
    parsed.branch_id = parsed.branch_id.trim().to_string();
    parsed.terminal_id = parsed.terminal_id.trim().to_string();
    if parsed.branch_id.is_empty() {
        return Err("Missing branchId".into());
    }
    if parsed.terminal_id.is_empty() {
        return Err("Missing terminalId".into());
    }
    Ok(parsed)
}

fn parse_shift_summary_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<ShiftSummaryPayload, String> {
    let payload = match (arg0, arg1) {
        (Some(serde_json::Value::String(shift_id)), Some(serde_json::Value::Object(mut obj))) => {
            obj.entry("shiftId".to_string())
                .or_insert(serde_json::Value::String(shift_id));
            serde_json::Value::Object(obj)
        }
        (
            Some(serde_json::Value::String(shift_id)),
            Some(serde_json::Value::Bool(skip_backfill)),
        ) => {
            serde_json::json!({
                "shiftId": shift_id,
                "skipBackfill": skip_backfill
            })
        }
        (Some(serde_json::Value::String(shift_id)), _) => serde_json::json!({
            "shiftId": shift_id
        }),
        (lhs, rhs) => merge_payload_args(lhs, rhs),
    };

    let mut parsed: ShiftSummaryPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid shift summary payload: {e}"))?;
    parsed.shift_id = parsed.shift_id.trim().to_string();
    if parsed.shift_id.is_empty() {
        return Err("Missing shiftId".into());
    }
    Ok(parsed)
}

fn parse_shift_print_checkout_payload(
    arg0: Option<serde_json::Value>,
) -> Result<ShiftPrintCheckoutPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(shift_id)) => serde_json::json!({
            "shiftId": shift_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let mut parsed: ShiftPrintCheckoutPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid shift checkout print payload: {e}"))?;
    parsed.shift_id = parsed.shift_id.trim().to_string();
    parsed.role_type = parsed.role_type.and_then(|value| match value.trim() {
        "" => None,
        v => Some(v.to_string()),
    });
    parsed.terminal_name = parsed.terminal_name.and_then(|value| match value.trim() {
        "" => None,
        v => Some(v.to_string()),
    });

    if parsed.shift_id.is_empty() {
        return Err("Missing shiftId".into());
    }

    Ok(parsed)
}

fn parse_cashier_shift_payload(
    arg0: Option<serde_json::Value>,
) -> Result<CashierShiftPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(cashier_shift_id)) => serde_json::json!({
            "cashierShiftId": cashier_shift_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: CashierShiftPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid cashier shift payload: {e}"))?;
    parsed.cashier_shift_id = parsed.cashier_shift_id.trim().to_string();
    if parsed.cashier_shift_id.is_empty() {
        return Err("Missing cashierShiftId".into());
    }
    Ok(parsed)
}

fn parse_staff_payments_by_staff_payload(
    arg0: Option<serde_json::Value>,
) -> Result<ShiftStaffPaymentsByStaffPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(staff_id)) => serde_json::json!({
            "staffId": staff_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: ShiftStaffPaymentsByStaffPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid staff payments payload: {e}"))?;
    parsed.staff_id = parsed.staff_id.trim().to_string();
    parsed.date_from = parsed
        .date_from
        .and_then(|v| if v.trim().is_empty() { None } else { Some(v) });
    parsed.date_to = parsed
        .date_to
        .and_then(|v| if v.trim().is_empty() { None } else { Some(v) });
    if parsed.staff_id.is_empty() {
        return Err("Missing staffId".into());
    }
    Ok(parsed)
}

fn parse_staff_date_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<ShiftStaffDatePayload, String> {
    let payload = match (arg0, arg1) {
        (Some(serde_json::Value::String(staff_id)), Some(serde_json::Value::String(date))) => {
            serde_json::json!({
                "staffId": staff_id,
                "date": date
            })
        }
        (Some(serde_json::Value::Object(mut obj)), Some(serde_json::Value::String(date))) => {
            obj.entry("date".to_string())
                .or_insert(serde_json::Value::String(date));
            serde_json::Value::Object(obj)
        }
        (Some(serde_json::Value::String(staff_id)), Some(serde_json::Value::Object(mut obj))) => {
            obj.entry("staffId".to_string())
                .or_insert(serde_json::Value::String(staff_id));
            serde_json::Value::Object(obj)
        }
        (lhs, rhs) => merge_payload_args(lhs, rhs),
    };

    let mut parsed: ShiftStaffDatePayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid staff/date payload: {e}"))?;
    parsed.staff_id = parsed.staff_id.trim().to_string();
    parsed.date = parsed.date.trim().to_string();
    if parsed.staff_id.is_empty() {
        return Err("Missing staffId".into());
    }
    if parsed.date.is_empty() {
        return Err("Missing date".into());
    }
    Ok(parsed)
}

fn parse_branch_payload(arg0: Option<serde_json::Value>) -> Result<ShiftBranchPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(branch_id)) => serde_json::json!({
            "branchId": branch_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: ShiftBranchPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid branch payload: {e}"))?;
    parsed.branch_id = parsed.branch_id.trim().to_string();
    if parsed.branch_id.is_empty() {
        return Err("Missing branchId".into());
    }
    Ok(parsed)
}

fn parse_optional_branch_id(arg0: Option<serde_json::Value>) -> Option<String> {
    match arg0 {
        Some(serde_json::Value::String(branch_id)) => {
            let trimmed = branch_id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(serde_json::Value::Object(obj)) => {
            let payload = serde_json::Value::Object(obj);
            value_str(&payload, &["branchId", "branch_id"])
        }
        _ => None,
    }
}

fn ensure_staff_payments_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS staff_payments (
            id TEXT PRIMARY KEY,
            cashier_shift_id TEXT NOT NULL,
            paid_to_staff_id TEXT NOT NULL,
            amount REAL NOT NULL,
            payment_type TEXT NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_staff_payments_cashier_shift_id
            ON staff_payments(cashier_shift_id);
        CREATE INDEX IF NOT EXISTS idx_staff_payments_paid_to_staff_id
            ON staff_payments(paid_to_staff_id);
        CREATE INDEX IF NOT EXISTS idx_staff_payments_created_at
            ON staff_payments(created_at);
        ",
    )
    .map_err(|e| format!("ensure staff_payments table: {e}"))
}

fn map_scheduled_shift_row(row: &serde_json::Value) -> serde_json::Value {
    let staff_node = row.get("staff");
    let staff_obj = match staff_node {
        Some(serde_json::Value::Object(obj)) => Some(serde_json::Value::Object(obj.clone())),
        Some(serde_json::Value::Array(arr)) => arr
            .first()
            .and_then(|v| v.as_object().cloned())
            .map(serde_json::Value::Object),
        _ => None,
    };
    let staff_first = staff_obj
        .as_ref()
        .and_then(|s| s.get("first_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let staff_last = staff_obj
        .as_ref()
        .and_then(|s| s.get("last_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let staff_name = format!("{} {}", staff_first, staff_last).trim().to_string();

    serde_json::json!({
        "id": row.get("id").cloned().unwrap_or(serde_json::Value::Null),
        "staffId": row.get("staff_id").cloned().unwrap_or(serde_json::Value::Null),
        "branchId": row.get("branch_id").cloned().unwrap_or(serde_json::Value::Null),
        "startTime": row.get("start_time").cloned().unwrap_or(serde_json::Value::Null),
        "endTime": row.get("end_time").cloned().unwrap_or(serde_json::Value::Null),
        "breakStart": row.get("break_start").cloned().unwrap_or(serde_json::Value::Null),
        "breakEnd": row.get("break_end").cloned().unwrap_or(serde_json::Value::Null),
        "status": row.get("status").cloned().unwrap_or(serde_json::Value::Null),
        "notes": row.get("notes").cloned().unwrap_or(serde_json::Value::Null),
        "staffName": if staff_name.is_empty() { "Unknown".to_string() } else { staff_name },
        "staffCode": staff_obj
            .as_ref()
            .and_then(|s| s.get("staff_code"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
    })
}

#[tauri::command]
pub async fn shift_open(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing shift payload")?;
    let result = shift_service::open_shift(&db, &payload)?;
    let _ = app.emit(
        "shift_updated",
        serde_json::json!({
            "action": "open",
            "shift": result
        }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn shift_close(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing shift close payload")?;
    let mut result = shift_service::close_shift(&db, &payload)?;

    let shift_id = value_str(&result, &["id", "shiftId", "shift_id"]).or_else(|| {
        result
            .get("shift")
            .and_then(|shift| value_str(shift, &["id", "shiftId", "shift_id"]))
    });
    if let Some(shift_id) = shift_id {
        match print::enqueue_print_job(&db, "shift_checkout", &shift_id, None) {
            Ok(job) => {
                if let Some(obj) = result.as_object_mut() {
                    obj.insert("autoPrintJob".to_string(), job);
                }
            }
            Err(error) => {
                warn!(
                    shift_id = %shift_id,
                    error = %error,
                    "Failed to enqueue automatic shift checkout print job"
                );
            }
        }
    }

    let _ = app.emit(
        "shift_updated",
        serde_json::json!({
            "action": "close",
            "shift": result.clone()
        }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn shift_get_active(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_staff_payload(arg0)?;
    shift_service::get_active(&db, &payload.staff_id)
}

#[tauri::command]
pub async fn shift_get_active_by_terminal(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_branch_terminal_payload(arg0, arg1)?;
    shift_service::get_active_by_terminal(&db, &payload.branch_id, &payload.terminal_id)
}

#[tauri::command]
pub async fn shift_get_active_by_terminal_loose(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_terminal_payload(arg0)?;
    shift_service::get_active_by_terminal_loose(&db, &payload.terminal_id)
}

#[tauri::command]
pub async fn shift_get_active_cashier_by_terminal(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_branch_terminal_payload(arg0, arg1)?;
    shift_service::get_active_cashier_by_terminal(&db, &payload.branch_id, &payload.terminal_id)
}

#[tauri::command]
pub async fn shift_get_summary(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_summary_payload(arg0, arg1)?;
    let _skip_backfill = payload.skip_backfill;
    shift_service::get_shift_summary(&db, &payload.shift_id)
}

#[tauri::command]
pub async fn shift_print_checkout(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_print_checkout_payload(arg0)?;
    let summary = match shift_service::get_shift_summary(&db, &payload.shift_id) {
        Ok(summary) => summary,
        Err(error) => {
            return Ok(serde_json::json!({
                "success": false,
                "error": error,
                "shiftId": payload.shift_id,
                "roleType": payload.role_type,
                "terminalName": payload.terminal_name,
            }));
        }
    };

    let shift = summary
        .get("shift")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let role_type = payload.role_type.unwrap_or_else(|| {
        value_str(&shift, &["role_type", "roleType"]).unwrap_or_else(|| "staff".to_string())
    });
    let terminal_name = payload.terminal_name.or_else(|| {
        value_str(&shift, &["terminal_id", "terminalId"]).filter(|value| !value.is_empty())
    });

    match print::enqueue_print_job(&db, "shift_checkout", &payload.shift_id, None) {
        Ok(job) => Ok(serde_json::json!({
            "success": true,
            "queued": true,
            "shiftId": payload.shift_id,
            "roleType": role_type,
            "terminalName": terminal_name,
            "job": job,
            "jobId": job.get("jobId").cloned().unwrap_or(serde_json::Value::Null),
        })),
        Err(error) => Ok(serde_json::json!({
            "success": false,
            "error": error,
            "shiftId": payload.shift_id,
            "roleType": role_type,
            "terminalName": terminal_name,
        })),
    }
}

#[tauri::command]
pub async fn shift_record_expense(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing expense payload")?;
    shift_service::record_expense(&db, &payload)
}

#[tauri::command]
pub async fn shift_get_expenses(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_summary_payload(arg0, None)?;
    shift_service::get_expenses(&db, &payload.shift_id)
}

// -- Staff listing (for shift check-in) --------------------------------------

/// List staff members eligible for POS check-in, fetched via Supabase RPC.
#[tauri::command]
pub async fn shift_list_staff_for_checkin(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let branch_id = parse_optional_branch_id(arg0)
        .or_else(|| storage::get_credential("branch_id"))
        .or_else(|| read_local_setting(&db, "terminal", "branch_id"))
        .ok_or("Missing branchId")?;
    let supabase_url = storage::get_credential("supabase_url")
        .or_else(|| read_local_setting(&db, "terminal", "supabase_url"))
        .ok_or("Supabase not configured: missing URL")?;
    let supabase_key = storage::get_credential("supabase_anon_key")
        .ok_or("Supabase not configured: missing anon key")?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let url = format!(
        "{}/rest/v1/rpc/pos_list_staff_for_checkin",
        supabase_url.trim_end_matches('/')
    );

    let resp = client
        .post(&url)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {supabase_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "p_branch_id": branch_id }))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch staff: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Staff fetch failed ({status}): {body}"));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {e}"))?;

    let staff_list = data
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| {
            let id = value_str(&row, &["id"])?;
            let first_name = value_str(&row, &["first_name", "firstName"]).unwrap_or_default();
            let last_name = value_str(&row, &["last_name", "lastName"]).unwrap_or_default();
            let composed_name = format!("{first_name} {last_name}").trim().to_string();
            let name = value_str(&row, &["name", "full_name", "fullName", "display_name"])
                .or_else(|| {
                    if composed_name.is_empty() {
                        None
                    } else {
                        Some(composed_name.clone())
                    }
                })
                .unwrap_or_else(|| "Staff".to_string());

            let role_id = value_str(&row, &["role_id", "roleId"]).unwrap_or_default();
            let role_name =
                value_str(&row, &["role_name", "roleName"]).unwrap_or_else(|| "staff".to_string());
            let role_display_name = value_str(&row, &["role_display_name", "roleDisplayName"])
                .unwrap_or_else(|| "Staff".to_string());

            let roles = row
                .get("roles")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|role| {
                    let rid = value_str(&role, &["role_id", "roleId", "id"])
                        .or_else(|| if role_id.is_empty() { None } else { Some(role_id.clone()) })?;
                    Some(serde_json::json!({
                        "role_id": rid,
                        "role_name": value_str(&role, &["role_name", "roleName", "name"])
                            .unwrap_or_else(|| role_name.clone()),
                        "role_display_name": value_str(&role, &["role_display_name", "roleDisplayName", "display_name", "displayName"])
                            .unwrap_or_else(|| role_display_name.clone()),
                        "role_color": value_str(&role, &["role_color", "roleColor", "color"])
                            .unwrap_or_else(|| "#6B7280".to_string()),
                        "is_primary": role.get("is_primary").and_then(|v| v.as_bool()).unwrap_or(false),
                    }))
                })
                .collect::<Vec<serde_json::Value>>();

            Some(serde_json::json!({
                "id": id,
                "name": name,
                "first_name": first_name,
                "last_name": last_name,
                "email": value_str(&row, &["email"]).unwrap_or_default(),
                "role_id": role_id,
                "role_name": role_name,
                "role_display_name": role_display_name,
                "roles": roles,
                "can_login_pos": row.get("can_login_pos").and_then(|v| v.as_bool()).unwrap_or(true),
                "is_active": row.get("is_active").and_then(|v| v.as_bool()).unwrap_or(true),
                "hourly_rate": row.get("hourly_rate").cloned().unwrap_or(serde_json::Value::Null),
            }))
        })
        .collect::<Vec<serde_json::Value>>();

    Ok(serde_json::json!({
        "success": true,
        "data": staff_list
    }))
}

/// Get roles for a list of staff IDs.
#[tauri::command]
pub async fn shift_get_staff_roles(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    hydrate_terminal_credentials_from_local_settings(&db);

    let staff_ids = if let Some(serde_json::Value::Array(arr)) = arg0.as_ref() {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect::<Vec<String>>()
    } else if let Some(serde_json::Value::Object(obj)) = arg0.as_ref() {
        if let Some(serde_json::Value::Array(arr)) =
            obj.get("staffIds").or_else(|| obj.get("staff_ids"))
        {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<String>>()
        } else {
            Vec::new()
        }
    } else if let Some(serde_json::Value::String(single)) = arg0.as_ref() {
        let trimmed = single.trim();
        if trimmed.is_empty() {
            Vec::new()
        } else {
            vec![trimmed.to_string()]
        }
    } else {
        Vec::new()
    };

    if staff_ids.is_empty() {
        return Ok(serde_json::json!({
            "success": true,
            "data": {}
        }));
    }

    let supabase_url = storage::get_credential("supabase_url")
        .or_else(|| read_local_setting(&db, "terminal", "supabase_url"))
        .ok_or("Supabase not configured: missing URL")?;
    let supabase_key = storage::get_credential("supabase_anon_key")
        .ok_or("Supabase not configured: missing anon key")?;
    let organization_id = storage::get_credential("organization_id")
        .or_else(|| read_local_setting(&db, "terminal", "organization_id"))
        .unwrap_or_default();
    let branch_id = storage::get_credential("branch_id")
        .or_else(|| read_local_setting(&db, "terminal", "branch_id"))
        .unwrap_or_default();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let base = supabase_url.trim_end_matches('/');

    // Build role metadata lookup first.
    let roles_url =
        format!("{base}/rest/v1/roles?select=id,name,display_name,color&is_active=eq.true");
    let mut roles_req = client
        .get(&roles_url)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {supabase_key}"))
        .header("Content-Type", "application/json");
    if !organization_id.trim().is_empty() {
        roles_req = roles_req.header("x-organization-id", organization_id.trim());
    }
    if !branch_id.trim().is_empty() {
        roles_req = roles_req.header("x-branch-id", branch_id.trim());
    }

    let mut role_lookup: std::collections::HashMap<String, (String, String, String)> =
        std::collections::HashMap::new();
    if let Ok(resp) = roles_req.send().await {
        if resp.status().is_success() {
            if let Ok(rows) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = rows.as_array() {
                    for row in arr {
                        if let Some(id) = value_str(row, &["id"]) {
                            let name =
                                value_str(row, &["name"]).unwrap_or_else(|| "staff".to_string());
                            let display = value_str(row, &["display_name", "displayName"])
                                .unwrap_or_else(|| "Staff".to_string());
                            let color =
                                value_str(row, &["color"]).unwrap_or_else(|| "#6B7280".to_string());
                            role_lookup.insert(id, (name, display, color));
                        }
                    }
                }
            }
        }
    }

    // Prefer RPC; fallback to direct staff_roles query if RPC unavailable.
    let rpc_url = format!("{base}/rest/v1/rpc/pos_get_staff_roles_by_ids");
    let mut rpc_req = client
        .post(&rpc_url)
        .header("apikey", &supabase_key)
        .header("Authorization", format!("Bearer {supabase_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "p_staff_ids": staff_ids }));
    if !organization_id.trim().is_empty() {
        rpc_req = rpc_req.header("x-organization-id", organization_id.trim());
    }
    if !branch_id.trim().is_empty() {
        rpc_req = rpc_req.header("x-branch-id", branch_id.trim());
    }

    let mut roles_rows: Vec<serde_json::Value> = Vec::new();
    match rpc_req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let parsed = resp
                .json::<serde_json::Value>()
                .await
                .map_err(|e| format!("Failed to parse staff role RPC response: {e}"))?;
            roles_rows = parsed.as_array().cloned().unwrap_or_default();
        }
        _ => {
            let ids = staff_ids
                .iter()
                .map(|s| s.replace(',', ""))
                .collect::<Vec<String>>()
                .join(",");
            let fallback_url = format!(
                "{base}/rest/v1/staff_roles?staff_id=in.({ids})&select=staff_id,role_id,is_primary"
            );
            let mut fallback_req = client
                .get(&fallback_url)
                .header("apikey", &supabase_key)
                .header("Authorization", format!("Bearer {supabase_key}"))
                .header("Content-Type", "application/json");
            if !organization_id.trim().is_empty() {
                fallback_req = fallback_req.header("x-organization-id", organization_id.trim());
            }
            if !branch_id.trim().is_empty() {
                fallback_req = fallback_req.header("x-branch-id", branch_id.trim());
            }

            let fallback_resp = fallback_req
                .send()
                .await
                .map_err(|e| format!("Failed to fetch staff roles fallback: {e}"))?;
            if fallback_resp.status().is_success() {
                let parsed = fallback_resp
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|e| format!("Failed to parse staff roles fallback response: {e}"))?;
                roles_rows = parsed.as_array().cloned().unwrap_or_default();
            }
        }
    }

    let mut roles_by_staff: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut seen_by_staff: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    for row in roles_rows {
        let staff_id = value_str(&row, &["staff_id", "staffId"]).unwrap_or_default();
        let role_id = value_str(&row, &["role_id", "roleId"]).unwrap_or_default();
        if staff_id.is_empty() || role_id.is_empty() {
            continue;
        }

        let seen = seen_by_staff.entry(staff_id.clone()).or_default();
        if !seen.insert(role_id.clone()) {
            continue;
        }

        let (fallback_name, fallback_display, fallback_color) =
            role_lookup.get(&role_id).cloned().unwrap_or_else(|| {
                (
                    "staff".to_string(),
                    "Staff".to_string(),
                    "#6B7280".to_string(),
                )
            });

        let role_obj = serde_json::json!({
            "role_id": role_id,
            "role_name": value_str(&row, &["role_name", "roleName"]).unwrap_or(fallback_name),
            "role_display_name": value_str(&row, &["role_display_name", "roleDisplayName"]).unwrap_or(fallback_display),
            "role_color": value_str(&row, &["role_color", "roleColor"]).unwrap_or(fallback_color),
            "is_primary": row.get("is_primary").and_then(|v| v.as_bool()).unwrap_or(false),
        });
        roles_by_staff.entry(staff_id).or_default().push(role_obj);
    }

    Ok(serde_json::json!({
        "success": true,
        "data": roles_by_staff
    }))
}

#[tauri::command]
pub async fn shift_record_staff_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing staff payment payload")?;
    let cashier_shift_id = value_str(&payload, &["cashierShiftId", "cashier_shift_id"])
        .ok_or("Missing cashierShiftId")?;
    let paid_to_staff_id = value_str(
        &payload,
        &[
            "paidToStaffId",
            "paid_to_staff_id",
            "recipientStaffId",
            "recipient_staff_id",
            "staffId",
            "staff_id",
        ],
    )
    .ok_or("Missing paidToStaffId")?;
    let amount = value_f64(&payload, &["amount"]).ok_or("Missing amount")?;
    let payment_type =
        value_str(&payload, &["paymentType", "payment_type"]).unwrap_or_else(|| "wage".to_string());
    let notes = value_str(&payload, &["notes"]);

    let payment_id = uuid::Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    conn.execute(
        "INSERT INTO staff_payments (
            id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            payment_id,
            cashier_shift_id,
            paid_to_staff_id,
            amount,
            payment_type,
            notes,
            created_at
        ],
    )
    .map_err(|e| format!("record staff payment: {e}"))?;

    let _ = conn.execute(
        "UPDATE cash_drawer_sessions
         SET total_staff_payments = COALESCE(total_staff_payments, 0) + ?1,
             updated_at = datetime('now')
         WHERE staff_shift_id = ?2",
        rusqlite::params![amount, cashier_shift_id],
    );

    let sync_payload = serde_json::json!({
        "id": payment_id,
        "cashierShiftId": cashier_shift_id,
        "paidToStaffId": paid_to_staff_id,
        "amount": amount,
        "paymentType": payment_type,
        "notes": notes
    });
    let idem = format!(
        "staff-payment:{}:{}",
        payment_id,
        Utc::now().timestamp_millis()
    );
    let _ = conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
         VALUES ('staff_payment', ?1, 'insert', ?2, ?3)",
        rusqlite::params![payment_id, sync_payload.to_string(), idem],
    );

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id
    }))
}

#[tauri::command]
pub async fn shift_get_staff_payments(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_cashier_shift_payload(arg0)?;
    let cashier_shift_id = payload.cashier_shift_id;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
             FROM staff_payments
             WHERE cashier_shift_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![cashier_shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "cashier_shift_id": row.get::<_, String>(1)?,
                "paid_to_staff_id": row.get::<_, String>(2)?,
                "amount": row.get::<_, f64>(3)?,
                "payment_type": row.get::<_, String>(4)?,
                "notes": row.get::<_, Option<String>>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!(items))
}

#[tauri::command]
pub async fn shift_get_staff_payments_by_staff(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_staff_payments_by_staff_payload(arg0)?;
    let staff_id = payload.staff_id;
    let date_from = payload.date_from;
    let date_to = payload.date_to;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    let query =
        "SELECT id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at
                 FROM staff_payments
                 WHERE paid_to_staff_id = ?1
                   AND (?2 IS NULL OR substr(created_at, 1, 10) >= ?2)
                   AND (?3 IS NULL OR substr(created_at, 1, 10) <= ?3)
                 ORDER BY created_at DESC";
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![staff_id, date_from, date_to], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "cashier_shift_id": row.get::<_, String>(1)?,
                "paid_to_staff_id": row.get::<_, String>(2)?,
                "amount": row.get::<_, f64>(3)?,
                "payment_type": row.get::<_, String>(4)?,
                "notes": row.get::<_, Option<String>>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!(items))
}

#[tauri::command]
pub async fn shift_get_staff_payment_total_for_date(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<f64, String> {
    let payload = parse_staff_date_payload(arg0, arg1)?;
    let staff_id = payload.staff_id;
    let date = payload.date;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;
    let total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM staff_payments
             WHERE paid_to_staff_id = ?1 AND substr(created_at, 1, 10) = ?2",
            rusqlite::params![staff_id, date],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    Ok(total)
}

#[tauri::command]
pub async fn shift_backfill_driver_earnings(
    _arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Read legacy JSON array from local_settings
    let json_str = db::get_setting(&conn, "local", "driver_earnings_v1");
    let entries: Vec<serde_json::Value> = match json_str {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => {
            return Ok(
                serde_json::json!({ "message": "No legacy data found", "processed": 0, "total": 0 }),
            )
        }
    };

    let total = entries.len();
    let mut processed = 0i64;

    for entry in &entries {
        let id =
            value_str(entry, &["id"]).unwrap_or_else(|| format!("de-bf-{}", uuid::Uuid::new_v4()));
        let driver_id = match value_str(entry, &["driverId", "driver_id"]) {
            Some(v) => v,
            None => continue,
        };
        let shift_id = value_str(
            entry,
            &["shiftId", "shift_id", "staffShiftId", "staff_shift_id"],
        );
        let order_id = match value_str(entry, &["orderId", "order_id"]) {
            Some(v) => v,
            None => continue,
        };
        let branch_id = value_str(entry, &["branchId", "branch_id"]).unwrap_or_default();
        let delivery_fee = value_f64(entry, &["deliveryFee", "delivery_fee"]).unwrap_or(0.0);
        let tip_amount = value_f64(entry, &["tipAmount", "tip_amount"]).unwrap_or(0.0);
        let total_earning = delivery_fee + tip_amount;
        let payment_method = value_str(entry, &["paymentMethod", "payment_method"])
            .unwrap_or_else(|| "cash".to_string());
        let cash_collected = value_f64(entry, &["cashCollected", "cash_collected"]).unwrap_or(0.0);
        let card_amount = value_f64(entry, &["cardAmount", "card_amount"]).unwrap_or(0.0);
        let cash_to_return = cash_collected - card_amount;
        let order_details = entry
            .get("orderDetails")
            .or_else(|| entry.get("order_details"))
            .map(|v| v.to_string());
        let created_at = value_str(entry, &["createdAt", "created_at"])
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        let updated_at = value_str(entry, &["updatedAt", "updated_at"])
            .unwrap_or_else(|| Utc::now().to_rfc3339());

        let result = conn.execute(
            "INSERT OR IGNORE INTO driver_earnings (
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
                created_at,
                updated_at
            ],
        );

        match result {
            Ok(rows) if rows > 0 => processed += 1,
            Ok(_) => {} // INSERT OR IGNORE skipped duplicate
            Err(e) => warn!("Backfill skip for order {order_id}: {e}"),
        }
    }

    // Delete the legacy JSON key after successful backfill
    if processed > 0 || total > 0 {
        let _ = conn.execute(
            "DELETE FROM local_settings WHERE setting_category = 'local' AND setting_key = 'driver_earnings_v1'",
            [],
        );
        info!("Driver earnings backfill complete: {processed}/{total} migrated from JSON to SQL");
    }

    Ok(serde_json::json!({
        "message": "Backfill completed",
        "processed": processed,
        "total": total
    }))
}

#[tauri::command]
pub async fn shift_get_scheduled_shifts(
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).ok_or("Missing branchId")?;
    let start_date =
        value_str(&payload, &["startDate", "start_date"]).ok_or("Missing startDate")?;
    let end_date = value_str(&payload, &["endDate", "end_date"]).ok_or("Missing endDate")?;
    let staff_id = value_str(&payload, &["staffId", "staff_id"]);

    let mut params = vec![
        (
            "select",
            "id,staff_id,branch_id,start_time,end_time,break_start,break_end,status,notes,staff(id,first_name,last_name,staff_code)"
                .to_string(),
        ),
        ("branch_id", format!("eq.{branch_id}")),
        ("start_time", format!("gte.{start_date}")),
        ("start_time", format!("lte.{end_date}")),
        ("order", "start_time.asc".to_string()),
    ];
    if let Some(sid) = staff_id {
        params.push(("staff_id", format!("eq.{sid}")));
    }

    let raw = fetch_supabase_rows("salon_staff_shifts", &params).await?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let mapped: Vec<serde_json::Value> = arr.iter().map(map_scheduled_shift_row).collect();
    Ok(serde_json::json!(mapped))
}

#[tauri::command]
pub async fn shift_get_today_scheduled_shifts(
    arg0: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = parse_branch_payload(arg0)?;
    let branch_id = payload.branch_id;
    let now_local = Local::now();
    let y = now_local.year();
    let m = now_local.month();
    let d = now_local.day();
    let start_local = Local
        .with_ymd_and_hms(y, m, d, 0, 0, 0)
        .single()
        .ok_or("Failed to compute local start of day")?;
    let end_local = Local
        .with_ymd_and_hms(y, m, d, 23, 59, 59)
        .single()
        .ok_or("Failed to compute local end of day")?;

    let params = vec![
        (
            "select",
            "id,staff_id,branch_id,start_time,end_time,break_start,break_end,status,notes,staff(id,first_name,last_name,staff_code)"
                .to_string(),
        ),
        ("branch_id", format!("eq.{branch_id}")),
        ("start_time", format!("gte.{}", start_local.to_rfc3339())),
        ("start_time", format!("lte.{}", end_local.to_rfc3339())),
        ("order", "start_time.asc".to_string()),
    ];

    let raw = fetch_supabase_rows("salon_staff_shifts", &params).await?;
    let arr = raw.as_array().cloned().unwrap_or_default();
    let mapped: Vec<serde_json::Value> = arr.iter().map(map_scheduled_shift_row).collect();
    Ok(serde_json::json!(mapped))
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn parse_shift_branch_terminal_supports_legacy_strings() {
        let parsed = parse_shift_branch_terminal_payload(
            Some(serde_json::json!("branch-1")),
            Some(serde_json::json!("terminal-1")),
        )
        .expect("legacy branch/terminal args should parse");
        assert_eq!(parsed.branch_id, "branch-1");
        assert_eq!(parsed.terminal_id, "terminal-1");
    }

    #[test]
    fn parse_shift_summary_supports_shift_and_options() {
        let parsed = parse_shift_summary_payload(
            Some(serde_json::json!("shift-1")),
            Some(serde_json::json!({ "skipBackfill": true })),
        )
        .expect("summary payload should parse");
        assert_eq!(parsed.shift_id, "shift-1");
        assert_eq!(parsed.skip_backfill, Some(true));
    }

    #[test]
    fn parse_shift_print_checkout_payload_supports_string_and_object() {
        let from_string = parse_shift_print_checkout_payload(Some(serde_json::json!("shift-3")))
            .expect("string payload should parse");
        let from_object = parse_shift_print_checkout_payload(Some(serde_json::json!({
            "shiftId": "shift-4",
            "roleType": "cashier",
            "terminalName": "Main POS"
        })))
        .expect("object payload should parse");
        assert_eq!(from_string.shift_id, "shift-3");
        assert_eq!(from_object.shift_id, "shift-4");
        assert_eq!(from_object.role_type.as_deref(), Some("cashier"));
        assert_eq!(from_object.terminal_name.as_deref(), Some("Main POS"));
    }

    #[test]
    fn parse_cashier_shift_payload_supports_aliases() {
        let parsed = parse_cashier_shift_payload(Some(serde_json::json!({
            "cashier_shift_id": "shift-2"
        })))
        .expect("cashier shift payload should parse");
        assert_eq!(parsed.cashier_shift_id, "shift-2");
    }

    #[test]
    fn parse_staff_date_payload_supports_legacy_tuple() {
        let parsed = parse_staff_date_payload(
            Some(serde_json::json!("staff-1")),
            Some(serde_json::json!("2026-02-21")),
        )
        .expect("staff/date tuple payload should parse");
        assert_eq!(parsed.staff_id, "staff-1");
        assert_eq!(parsed.date, "2026-02-21");
    }

    #[test]
    fn parse_branch_payload_supports_string_and_object() {
        let from_string = parse_branch_payload(Some(serde_json::json!("branch-a")))
            .expect("string payload should parse");
        let from_object = parse_branch_payload(Some(serde_json::json!({
            "branchId": "branch-b"
        })))
        .expect("object payload should parse");
        assert_eq!(from_string.branch_id, "branch-a");
        assert_eq!(from_object.branch_id, "branch-b");
    }
}
