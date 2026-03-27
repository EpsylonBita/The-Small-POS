use chrono::{Datelike, Local, TimeZone, Utc};
use rusqlite::params;
use serde::Deserialize;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::shifts as shift_service;
use crate::{db, fetch_supabase_rows, print, value_f64, value_str};

async fn emit_sync_status_snapshot(
    app: &tauri::AppHandle,
    sync_state: &std::sync::Arc<crate::sync::SyncState>,
) {
    let network_status = crate::sync::check_network_status().await;
    let network_is_online = network_status
        .get("isOnline")
        .and_then(serde_json::Value::as_bool);
    let _ = app.emit("network_status", &network_status);

    let db = app.state::<db::DbState>();
    if let Ok(mut status) = crate::sync::get_sync_status(&db, sync_state) {
        if let Some(is_online) = network_is_online {
            if let Some(status_obj) = status.as_object_mut() {
                status_obj.insert("isOnline".to_string(), serde_json::json!(is_online));
            }
        }
        let _ = app.emit("sync_status", &status);
        let _ = app.emit("sync-status-changed", &status);
    }
}

fn schedule_immediate_sync(app: tauri::AppHandle, entity_type: &'static str, entity_id: String) {
    tauri::async_runtime::spawn(async move {
        let sync_state = {
            let state = app.state::<std::sync::Arc<crate::sync::SyncState>>();
            state.inner().clone()
        };

        if !crate::storage::is_configured() {
            emit_sync_status_snapshot(&app, &sync_state).await;
            return;
        }

        let network_status = crate::sync::check_network_status().await;
        let network_is_online = network_status
            .get("isOnline")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !network_is_online {
            emit_sync_status_snapshot(&app, &sync_state).await;
            return;
        }

        let db_dir = {
            let state = app.state::<db::DbState>();
            state.db_path.parent().map(|value| value.to_path_buf())
        };

        let Some(db_dir) = db_dir else {
            warn!(entity_type, entity_id = %entity_id, "Skipping immediate sync: missing database directory");
            emit_sync_status_snapshot(&app, &sync_state).await;
            return;
        };

        let background_db = match db::init(&db_dir) {
            Ok(db) => db,
            Err(error) => {
                warn!(
                    entity_type,
                    entity_id = %entity_id,
                    %error,
                    "Failed to open background database for immediate sync"
                );
                emit_sync_status_snapshot(&app, &sync_state).await;
                return;
            }
        };

        match crate::sync::force_sync(&background_db, sync_state.as_ref(), &app).await {
            Ok(()) => {
                let _ = app.emit(
                    "sync_complete",
                    serde_json::json!({
                        "trigger": "auto",
                        "entityType": entity_type,
                        "entityId": entity_id,
                    }),
                );
            }
            Err(error) => {
                warn!(
                    entity_type,
                    entity_id = %entity_id,
                    %error,
                    "Immediate sync attempt failed"
                );
            }
        }

        emit_sync_status_snapshot(&app, &sync_state).await;
    });
}

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
struct ShiftExpenseDeletePayload {
    #[serde(alias = "expense_id", alias = "id")]
    expense_id: String,
    #[serde(alias = "shift_id", alias = "staff_shift_id", alias = "staffShiftId")]
    shift_id: String,
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
    #[serde(default, alias = "snapshot_check_out_time")]
    snapshot_check_out_time: Option<String>,
    #[serde(default, alias = "expected_amount")]
    expected_amount: Option<f64>,
    #[serde(default, alias = "closing_amount")]
    closing_amount: Option<f64>,
    #[serde(default, alias = "variance_amount")]
    variance_amount: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CashierShiftPayload {
    #[serde(alias = "cashier_shift_id", alias = "shift_id", alias = "id")]
    cashier_shift_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftStaffPaymentMutationPayload {
    #[serde(default, alias = "payment_id", alias = "id")]
    payment_id: Option<String>,
    #[serde(alias = "cashier_shift_id", alias = "shift_id")]
    cashier_shift_id: String,
    #[serde(
        alias = "paid_to_staff_id",
        alias = "recipient_staff_id",
        alias = "recipientStaffId",
        alias = "staff_id",
        alias = "staffId"
    )]
    paid_to_staff_id: String,
    amount: f64,
    #[serde(default, alias = "payment_type")]
    payment_type: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShiftStaffPaymentDeletePayload {
    #[serde(alias = "payment_id", alias = "id")]
    payment_id: String,
    #[serde(alias = "cashier_shift_id", alias = "shift_id")]
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

fn parse_shift_expense_delete_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<ShiftExpenseDeletePayload, String> {
    let payload = match (arg0, arg1) {
        (
            Some(serde_json::Value::String(expense_id)),
            Some(serde_json::Value::String(shift_id)),
        ) => serde_json::json!({
            "expenseId": expense_id,
            "shiftId": shift_id
        }),
        (Some(serde_json::Value::String(expense_id)), Some(serde_json::Value::Object(mut obj))) => {
            obj.entry("expenseId".to_string())
                .or_insert(serde_json::Value::String(expense_id));
            serde_json::Value::Object(obj)
        }
        (Some(serde_json::Value::Object(mut obj)), Some(serde_json::Value::String(shift_id))) => {
            obj.entry("shiftId".to_string())
                .or_insert(serde_json::Value::String(shift_id));
            serde_json::Value::Object(obj)
        }
        (lhs, rhs) => merge_payload_args(lhs, rhs),
    };

    let mut parsed: ShiftExpenseDeletePayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid expense delete payload: {e}"))?;
    parsed.expense_id = parsed.expense_id.trim().to_string();
    parsed.shift_id = parsed.shift_id.trim().to_string();
    if parsed.expense_id.is_empty() {
        return Err("Missing expenseId".into());
    }
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
    parsed.snapshot_check_out_time =
        parsed
            .snapshot_check_out_time
            .and_then(|value| match value.trim() {
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

fn parse_staff_payment_mutation_payload(
    arg0: Option<serde_json::Value>,
) -> Result<ShiftStaffPaymentMutationPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let mut parsed: ShiftStaffPaymentMutationPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid staff payment payload: {e}"))?;
    parsed.payment_id = parsed.payment_id.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    parsed.cashier_shift_id = parsed.cashier_shift_id.trim().to_string();
    parsed.paid_to_staff_id = parsed.paid_to_staff_id.trim().to_string();
    parsed.payment_type = parsed.payment_type.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    parsed.notes = parsed.notes.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    if parsed.cashier_shift_id.is_empty() {
        return Err("Missing cashierShiftId".into());
    }
    if parsed.paid_to_staff_id.is_empty() {
        return Err("Missing paidToStaffId".into());
    }
    if parsed.amount <= 0.0 {
        return Err("Amount must be positive".into());
    }

    Ok(parsed)
}

fn parse_staff_payment_delete_payload(
    arg0: Option<serde_json::Value>,
) -> Result<ShiftStaffPaymentDeletePayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let mut parsed: ShiftStaffPaymentDeletePayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid staff payment delete payload: {e}"))?;
    parsed.payment_id = parsed.payment_id.trim().to_string();
    parsed.cashier_shift_id = parsed.cashier_shift_id.trim().to_string();
    if parsed.payment_id.is_empty() {
        return Err("Missing paymentId".into());
    }
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

fn ensure_staff_payments_table(conn: &rusqlite::Connection) -> Result<(), String> {
    shift_service::ensure_staff_payments_table(conn)
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
    if let Some(shift_id) = result.get("shiftId").and_then(serde_json::Value::as_str) {
        schedule_immediate_sync(app.clone(), "shift", shift_id.to_string());
    }
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
    let requested_shift_id = value_str(&payload, &["shiftId", "shift_id"]);
    let mut result = shift_service::close_shift(&db, &payload)?;
    let success = result
        .get("success")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    if !success {
        return Ok(result);
    }

    let shift_id = value_str(&result, &["id", "shiftId", "shift_id"])
        .or_else(|| {
            result
                .get("shift")
                .and_then(|shift| value_str(shift, &["id", "shiftId", "shift_id"]))
        })
        .or(requested_shift_id);
    if let Some(shift_id) = shift_id {
        if crate::print::is_print_action_enabled(&db, "shift_close") {
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
        schedule_immediate_sync(app.clone(), "shift", shift_id);
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
pub async fn shift_get_by_id(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_cashier_shift_payload(arg0)?;
    shift_service::get_shift_by_id(&db, &payload.cashier_shift_id)
}

#[tauri::command]
pub async fn shift_get_sync_state(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_cashier_shift_payload(arg0)?;
    shift_service::get_shift_sync_state(&db, &payload.cashier_shift_id)
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
pub async fn shift_get_check_in_eligibility(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_branch_terminal_payload(arg0, arg1)?;
    shift_service::get_check_in_eligibility(&db, &payload.branch_id, &payload.terminal_id)
}

#[tauri::command]
pub async fn shift_get_active_cashier_by_terminal_loose(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_terminal_payload(arg0)?;
    shift_service::get_active_cashier_by_terminal_loose(&db, &payload.terminal_id)
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
        db.conn.lock().ok().and_then(|conn| {
            ["name", "display_name", "displayName"]
                .iter()
                .find_map(|key| db::get_setting(&conn, "terminal", key))
                .map(|value| value.trim().to_string())
                .filter(|value| {
                    !value.is_empty()
                        && !value.to_ascii_lowercase().starts_with("terminal-")
                        && !value.to_ascii_lowercase().starts_with("term-")
                })
        })
    });
    let shift_id = payload.shift_id.clone();
    let role_type_for_job = role_type.clone();
    let terminal_name_for_job = terminal_name.clone();

    let print_payload = serde_json::json!({
        "shiftId": shift_id,
        "roleType": role_type_for_job,
        "terminalName": terminal_name_for_job,
        "snapshotCheckOutTime": payload.snapshot_check_out_time,
        "expectedAmount": payload.expected_amount,
        "closingAmount": payload.closing_amount,
        "varianceAmount": payload.variance_amount,
    });

    if !crate::print::is_print_action_enabled(&db, "shift_close") {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }
    match print::enqueue_print_job_with_payload(
        &db,
        "shift_checkout",
        &payload.shift_id,
        None,
        Some(&print_payload),
    ) {
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
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.ok_or("Missing expense payload")?;
    let result = shift_service::record_expense(&db, &payload)?;
    if let Some(expense_id) = result.get("expenseId").and_then(serde_json::Value::as_str) {
        schedule_immediate_sync(app, "shift_expense", expense_id.to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn shift_delete_expense(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_shift_expense_delete_payload(arg0, arg1)?;
    let payload = serde_json::json!({
        "expenseId": parsed.expense_id,
        "shiftId": parsed.shift_id,
    });
    let result = shift_service::delete_expense(&db, &payload)?;
    if let Some(expense_id) = result.get("expenseId").and_then(serde_json::Value::as_str) {
        schedule_immediate_sync(app, "shift_expense", expense_id.to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn shift_get_expenses(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_shift_summary_payload(arg0, None)?;
    shift_service::get_expenses(&db, &payload.shift_id)
}

#[tauri::command]
pub async fn shift_record_staff_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_staff_payment_mutation_payload(arg0)?;
    let payload = serde_json::json!({
        "cashierShiftId": parsed.cashier_shift_id,
        "paidToStaffId": parsed.paid_to_staff_id,
        "amount": parsed.amount,
        "paymentType": parsed.payment_type.unwrap_or_else(|| "wage".to_string()),
        "notes": parsed.notes,
    });
    let result = shift_service::record_staff_payment(&db, &payload)?;
    if let Some(payment_id) = result.get("paymentId").and_then(serde_json::Value::as_str) {
        schedule_immediate_sync(app, "staff_payment", payment_id.to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn shift_update_staff_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_staff_payment_mutation_payload(arg0)?;
    let payment_id = parsed.payment_id.ok_or("Missing paymentId")?;
    let payload = serde_json::json!({
        "paymentId": payment_id,
        "cashierShiftId": parsed.cashier_shift_id,
        "paidToStaffId": parsed.paid_to_staff_id,
        "amount": parsed.amount,
        "paymentType": parsed.payment_type.unwrap_or_else(|| "wage".to_string()),
        "notes": parsed.notes,
    });
    let result = shift_service::update_staff_payment(&db, &payload)?;
    if let Some(payment_id) = result.get("paymentId").and_then(serde_json::Value::as_str) {
        schedule_immediate_sync(app, "staff_payment", payment_id.to_string());
    }
    Ok(result)
}

#[tauri::command]
pub async fn shift_delete_staff_payment(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let parsed = parse_staff_payment_delete_payload(arg0)?;
    let payload = serde_json::json!({
        "paymentId": parsed.payment_id,
        "cashierShiftId": parsed.cashier_shift_id,
    });
    let result = shift_service::delete_staff_payment(&db, &payload)?;
    if let Some(payment_id) = result.get("paymentId").and_then(serde_json::Value::as_str) {
        schedule_immediate_sync(app, "staff_payment", payment_id.to_string());
    }
    Ok(result)
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
            "SELECT sp.id, sp.cashier_shift_id, sp.paid_to_staff_id, sp.amount, sp.payment_type, sp.notes, sp.created_at, sp.updated_at,
                    (SELECT ss.staff_name
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1) AS staff_name,
                    (SELECT ss.role_type
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1) AS role_type
             FROM staff_payments sp
             WHERE sp.cashier_shift_id = ?1
             ORDER BY sp.created_at DESC",
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
                "updated_at": row.get::<_, String>(7)?,
                "staff_name": row.get::<_, Option<String>>(8)?,
                "role_type": row.get::<_, Option<String>>(9)?,
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
        "SELECT sp.id, sp.cashier_shift_id, sp.paid_to_staff_id, sp.amount, sp.payment_type, sp.notes,
                sp.created_at, sp.updated_at,
                (SELECT ss.staff_name
                 FROM staff_shifts ss
                 WHERE ss.id = sp.cashier_shift_id
                 LIMIT 1) AS cashier_name
                 FROM staff_payments sp
                 WHERE sp.paid_to_staff_id = ?1
                   AND (?2 IS NULL OR substr(sp.created_at, 1, 10) >= ?2)
                   AND (?3 IS NULL OR substr(sp.created_at, 1, 10) <= ?3)
                 ORDER BY sp.created_at DESC";
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
                "updated_at": row.get::<_, String>(7)?,
                "cashier_name": row.get::<_, Option<String>>(8)?,
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
            "terminalName": "Main POS",
            "snapshotCheckOutTime": "2026-03-24T09:30:00Z",
            "expectedAmount": 150.0,
            "closingAmount": 152.0,
            "varianceAmount": 2.0
        })))
        .expect("object payload should parse");
        assert_eq!(from_string.shift_id, "shift-3");
        assert_eq!(from_object.shift_id, "shift-4");
        assert_eq!(from_object.role_type.as_deref(), Some("cashier"));
        assert_eq!(from_object.terminal_name.as_deref(), Some("Main POS"));
        assert_eq!(
            from_object.snapshot_check_out_time.as_deref(),
            Some("2026-03-24T09:30:00Z")
        );
        assert_eq!(from_object.expected_amount, Some(150.0));
        assert_eq!(from_object.closing_amount, Some(152.0));
        assert_eq!(from_object.variance_amount, Some(2.0));
    }

    #[test]
    fn parse_shift_expense_delete_payload_supports_aliases_and_tuple() {
        let from_tuple = parse_shift_expense_delete_payload(
            Some(serde_json::json!("expense-1")),
            Some(serde_json::json!("shift-1")),
        )
        .expect("tuple payload should parse");
        let from_object = parse_shift_expense_delete_payload(
            Some(serde_json::json!({
                "expense_id": "expense-2",
                "staff_shift_id": "shift-2"
            })),
            None,
        )
        .expect("object payload should parse");

        assert_eq!(from_tuple.expense_id, "expense-1");
        assert_eq!(from_tuple.shift_id, "shift-1");
        assert_eq!(from_object.expense_id, "expense-2");
        assert_eq!(from_object.shift_id, "shift-2");
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
    fn parse_staff_payment_mutation_payload_supports_aliases() {
        let parsed = parse_staff_payment_mutation_payload(Some(serde_json::json!({
            "payment_id": "payment-1",
            "cashier_shift_id": "shift-3",
            "recipient_staff_id": "staff-7",
            "amount": 18.5,
            "payment_type": "bonus",
            "notes": "  payroll correction  "
        })))
        .expect("staff payment mutation payload should parse");

        assert_eq!(parsed.payment_id.as_deref(), Some("payment-1"));
        assert_eq!(parsed.cashier_shift_id, "shift-3");
        assert_eq!(parsed.paid_to_staff_id, "staff-7");
        assert_eq!(parsed.amount, 18.5);
        assert_eq!(parsed.payment_type.as_deref(), Some("bonus"));
        assert_eq!(parsed.notes.as_deref(), Some("payroll correction"));
    }

    #[test]
    fn parse_staff_payment_delete_payload_supports_aliases() {
        let parsed = parse_staff_payment_delete_payload(Some(serde_json::json!({
            "id": "payment-2",
            "shift_id": "shift-9"
        })))
        .expect("staff payment delete payload should parse");

        assert_eq!(parsed.payment_id, "payment-2");
        assert_eq!(parsed.cashier_shift_id, "shift-9");
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
