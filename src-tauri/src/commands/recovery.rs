use serde_json::{json, Value};

use crate::{api, auth, db, payments, recovery, storage, sync, sync_queue};

fn parse_point_id(arg0: Option<Value>) -> Result<String, String> {
    crate::payload_arg0_as_string(arg0, &["id", "pointId", "point_id", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing recovery point id".to_string())
}

fn parse_open_dir_payload(arg0: Option<Value>) -> Option<String> {
    crate::payload_arg0_as_string(arg0, &["path", "dir", "directory", "value"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn open_directory(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = dir;
        Err("Opening recovery folder is not supported on this platform".into())
    }
}

fn request_field_str<'a>(request: &'a Value, key: &str) -> Option<&'a str> {
    request.get(key).and_then(Value::as_str).map(str::trim)
}

fn request_field_i64(request: &Value, key: &str) -> Option<i64> {
    request.get(key).and_then(|value| match value {
        Value::Number(num) => num.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn request_param<'a>(request: &'a Value, key: &str) -> Option<&'a Value> {
    request.get("params").and_then(Value::as_object)?.get(key)
}

fn request_param_str(request: &Value, key: &str) -> Option<String> {
    request_param(request, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn request_param_i64(request: &Value, key: &str) -> Option<i64> {
    request_param(request, key).and_then(|value| match value {
        Value::Number(num) => num.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn request_param_string_array(request: &Value, key: &str) -> Vec<String> {
    request_param(request, key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn load_admin_url(db: &db::DbState) -> Result<String, String> {
    let admin_url = storage::get_credential("admin_dashboard_url")
        .or_else(|| storage::get_credential("admin_url"))
        .or_else(|| crate::read_local_setting(db, "terminal", "admin_dashboard_url"))
        .or_else(|| crate::read_local_setting(db, "terminal", "admin_url"))
        .ok_or_else(|| "Admin URL not configured".to_string())?;
    let normalized = api::normalize_admin_url(&admin_url);
    if normalized.trim().is_empty() {
        return Err("Admin URL not configured".into());
    }
    Ok(normalized)
}

fn load_pos_api_key() -> Result<String, String> {
    let raw_api_key = storage::get_credential("pos_api_key")
        .ok_or_else(|| "POS API key not configured".to_string())?;
    let extracted =
        api::extract_api_key_from_connection_string(&raw_api_key).unwrap_or(raw_api_key);
    let normalized = extracted.trim().to_string();
    if normalized.is_empty() {
        return Err("POS API key not configured".into());
    }
    Ok(normalized)
}

#[tauri::command]
pub async fn recovery_list_points(
    db: tauri::State<'_, db::DbState>,
) -> Result<recovery::RecoveryListResponse, String> {
    let points = recovery::list_recovery_points(&db)?;
    Ok(recovery::RecoveryListResponse {
        success: true,
        points,
    })
}

#[tauri::command]
pub async fn recovery_create_snapshot(
    db: tauri::State<'_, db::DbState>,
) -> Result<recovery::RecoveryPointMetadata, String> {
    recovery::create_manual_snapshot(&db)
}

#[tauri::command]
pub async fn recovery_export_current(
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<recovery::RecoveryExportResponse, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    recovery::export_current_bundle(&db).map_err(Into::into)
}

#[tauri::command]
pub async fn recovery_export_point(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<recovery::RecoveryExportResponse, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    let point_id = parse_point_id(arg0)?;
    recovery::export_recovery_point(&db, &point_id).map_err(Into::into)
}

#[tauri::command]
pub async fn recovery_restore_point(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<recovery::RecoveryRestoreResponse, auth::GuardedCommandError> {
    auth::authorize_privileged_action(
        auth::PrivilegedActionScope::SystemControl,
        &db,
        &auth_state,
    )?;
    let point_id = parse_point_id(arg0)?;
    recovery::stage_restore_from_point(&db, &point_id).map_err(Into::into)
}

#[tauri::command]
pub async fn recovery_open_dir(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let app_data_dir = db
        .db_path
        .parent()
        .ok_or_else(|| "database path does not have a parent directory".to_string())?;
    let recovery_root = recovery::recovery_root_for_app_data(app_data_dir);
    let requested_path = parse_open_dir_payload(arg0);
    let target = if let Some(requested_path) = requested_path {
        let candidate = std::path::PathBuf::from(&requested_path);
        let normalized = if candidate.is_file() {
            candidate
                .parent()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| recovery_root.clone())
        } else {
            candidate
        };
        if !normalized.starts_with(&recovery_root) {
            return Err("Recovery path must stay inside the recovery directory".into());
        }
        normalized
    } else {
        recovery_root.clone()
    };

    if !target.exists() {
        return Err(format!(
            "Recovery directory does not exist: {}",
            target.display()
        ));
    }

    open_directory(&target)?;
    Ok(serde_json::json!({
        "success": true,
        "path": target.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
pub async fn recovery_execute_action(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    auth_state: tauri::State<'_, auth::AuthState>,
) -> Result<Value, auth::GuardedCommandError> {
    let request = arg0.ok_or_else(|| "Missing recovery action request".to_string())?;
    let action_id = request
        .get("actionId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match action_id {
        "openConnectionSettings" => Ok(json!({
            "success": true,
            "requiresRefresh": false,
            "routeTarget": {
                "screen": "connectionSettings",
            },
        })),
        "contactOperator" => Ok(json!({
            "success": true,
            "requiresRefresh": false,
            "message": "No automated fix is available for this issue yet. Contact operator.",
        })),
        "clearLegacyFinancialOrphan" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let entity_type = request
                .get("entityType")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("Missing entityType for legacy orphan cleanup")?;
            let entity_id = request
                .get("entityId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("Missing entityId for legacy orphan cleanup")?;

            let orphan_rows =
                sync::count_legacy_financial_parity_orphan_rows(&db, entity_type, entity_id)
                    .map_err(auth::GuardedCommandError::from)?;
            if orphan_rows == 0 {
                return Ok(json!({
                    "success": true,
                    "requiresRefresh": true,
                    "message": "No stale legacy financial rows remained for this issue.",
                }));
            }

            let result = sync::clear_legacy_financial_parity_orphan(&db, entity_type, entity_id)
                .map_err(auth::GuardedCommandError::from)?;

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Cleared {} stale legacy financial parity row(s).",
                    result.cleared,
                ),
            }))
        }
        "openShiftRepair" | "forceCloseShift" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let shift_id = request
                .get("shiftId")
                .and_then(|v| v.as_str())
                .ok_or("Missing shiftId for shift repair action")?;

            let reason = request
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("Stuck shift recovery via POS");

            let body = json!({
                "shift_id": shift_id,
                "reason": reason,
            });

            let api_result =
                crate::admin_fetch(Some(&db), "/api/pos/shifts/force-close", "POST", Some(body))
                    .await
                    .map_err(|e| format!("Force-close API call failed: {e}"))?;

            let api_success = api_result
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !api_success {
                let api_error = api_result
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown server error");
                return Err(format!("Server rejected force-close: {api_error}").into());
            }

            // Update local SQLite to match
            let now = chrono::Utc::now().to_rfc3339();
            if let Ok(conn) = db.conn.lock() {
                let _ = conn.execute(
                    "UPDATE staff_shifts
                     SET status = 'abandoned',
                         check_out_time = ?1,
                         closing_cash_amount = 0,
                         expected_cash_amount = 0,
                         cash_variance = 0,
                         sync_status = 'synced',
                         updated_at = ?1
                     WHERE id = ?2",
                    rusqlite::params![now, shift_id],
                );

                // Close associated cash_drawer_sessions
                let _ = conn.execute(
                    "UPDATE cash_drawer_sessions
                     SET closed_at = ?1,
                         closing_amount = 0,
                         updated_at = ?1
                     WHERE staff_shift_id = ?2 AND closed_at IS NULL",
                    rusqlite::params![now, shift_id],
                );
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Shift force-closed successfully",
            }))
        }

        "retrySync" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let queue_id = request.get("queueId").and_then(|v| v.as_i64());
            let entity_id = request
                .get("entityId")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if let Some(qid) = queue_id {
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'pending', retry_count = 0, updated_at = datetime('now') WHERE id = ?1",
                        rusqlite::params![qid],
                    );
                }
            } else if !entity_id.is_empty() {
                if let Ok(conn) = db.conn.lock() {
                    let _ = conn.execute(
                        "UPDATE sync_queue SET status = 'pending', retry_count = 0, updated_at = datetime('now') WHERE entity_id = ?1 AND status IN ('failed', 'blocked')",
                        rusqlite::params![entity_id],
                    );
                }
            }

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Sync rows were requeued.",
            }))
        }
        "runParitySyncNow" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let admin_url = load_admin_url(&db)?;
            let api_key = load_pos_api_key()?;
            let result = sync_queue::process_queue(&db.conn, &admin_url, &api_key)
                .await
                .map_err(auth::GuardedCommandError::from)?;
            let status = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                sync_queue::get_status(&conn)
            }
            .map_err(auth::GuardedCommandError::from)?;

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Parity sync processed {} item(s), failed {}, conflicts {}, remaining {}.",
                    result.processed,
                    result.failed,
                    result.conflicts,
                    status.total,
                ),
            }))
        }
        "retryParityItem" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let item_id = request_param_str(&request, "sampleItemId")
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| "Missing parity item id".to_string())?;
            let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
            sync_queue::retry_item(&conn, item_id.as_str())
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Parity item was requeued.",
            }))
        }
        "retryParityModule" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let module_type = request_param_str(&request, "moduleType")
                .or_else(|| request_field_str(&request, "entityId").map(ToOwned::to_owned))
                .ok_or_else(|| "Missing parity module type".to_string())?;
            let result = {
                let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
                sync_queue::retry_items_by_module(&conn, module_type.as_str())
            }
            .map_err(auth::GuardedCommandError::from)?;

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Parity module {} requeued {} item(s).",
                    module_type,
                    result.retried,
                ),
            }))
        }
        "validatePendingOrders" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let result =
                sync::validate_pending_orders(&db).map_err(auth::GuardedCommandError::from)?;
            let total_pending = result
                .get("total_pending")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let invalid = result.get("invalid").and_then(Value::as_i64).unwrap_or(0);
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Validated {total_pending} pending order(s); {invalid} invalid row(s) still need removal.",
                ),
            }))
        }
        "removeInvalidOrders" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let order_ids = request_param_string_array(&request, "orderIds");
            if order_ids.is_empty() {
                return Err("No invalid orders were provided for removal".into());
            }
            let result = sync::remove_invalid_orders(&db, order_ids)
                .map_err(auth::GuardedCommandError::from)?;
            let removed = result.get("removed").and_then(Value::as_i64).unwrap_or(0);
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Removed {removed} invalid order row(s) from the local queue."),
            }))
        }
        "retryFinancialItem" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let queue_id = request_field_i64(&request, "queueId")
                .or_else(|| request_param_i64(&request, "queueId"))
                .ok_or_else(|| "Missing financial queue id".to_string())?;
            sync::retry_financial_queue_item(&db, queue_id)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": "Financial sync item was requeued.",
            }))
        }
        "retryAllFailedFinancial" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let count: usize = {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                let now = chrono::Utc::now().to_rfc3339();
                let count = conn.execute(
                    "UPDATE sync_queue
                     SET status = 'pending',
                         retry_count = 0,
                         last_error = NULL,
                         next_retry_at = NULL,
                         updated_at = ?1
                     WHERE status = 'failed'
                       AND entity_type IN ('payment_adjustment', 'shift_expense', 'staff_payment', 'driver_earning', 'driver_earnings')",
                    rusqlite::params![now],
                )
                .map_err(|e| e.to_string())?;
                if count > 0 {
                    let _ = conn.execute(
                        "UPDATE payment_adjustments
                         SET sync_state = 'pending',
                             sync_retry_count = 0,
                             sync_last_error = NULL,
                             sync_next_retry_at = NULL,
                             updated_at = ?1
                         WHERE id IN (
                             SELECT entity_id
                             FROM sync_queue
                             WHERE entity_type = 'payment_adjustment'
                               AND status = 'pending'
                               AND updated_at = ?1
                        )",
                        rusqlite::params![now],
                    );
                }
                count
            };

            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {count} failed financial sync item(s)."),
            }))
        }
        "resolveCheckoutPaymentBlocker" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;

            let order_id = request_field_str(&request, "orderId")
                .map(ToOwned::to_owned)
                .ok_or_else(|| "Missing orderId for checkout payment repair".to_string())?;
            let preferred_method = request_param_str(&request, "preferredMethod")
                .or_else(|| request_param_str(&request, "paymentMethod"))
                .or_else(
                    || match request_param_str(&request, "reasonCode").as_deref() {
                        Some("missing_cash_payment") | Some("partial_cash_payment") => {
                            Some("cash".to_string())
                        }
                        Some("missing_card_payment") | Some("partial_card_payment") => {
                            Some("card".to_string())
                        }
                        _ => None,
                    },
                )
                .unwrap_or_else(|| "card".to_string());

            let result = payments::resolve_unsettled_payment_blocker_payment(
                &db,
                &json!({
                    "orderId": order_id,
                    "method": preferred_method,
                }),
            )
            .map_err(auth::GuardedCommandError::from)?;

            let success = result
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !success {
                let message = result
                    .get("error")
                    .and_then(Value::as_str)
                    .or_else(|| result.get("message").and_then(Value::as_str))
                    .unwrap_or("Failed to repair the missing payment record");
                return Err(message.to_string().into());
            }

            let order_number = request_field_str(&request, "orderNumber")
                .unwrap_or("the order")
                .to_string();
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Recorded the missing {} payment for {}.",
                    preferred_method,
                    order_number,
                ),
            }))
        }
        "repairOrphanedFinancial" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let admin_url = load_admin_url(&db)?;
            let api_key = load_pos_api_key()?;
            let stats = sync::repair_orphaned_financial_queue_items(&db, &admin_url, &api_key)
                .await
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!(
                    "Repaired {} orphaned item(s), requeued {}, skipped {}.",
                    stats.repaired,
                    stats.requeued,
                    stats.skipped,
                ),
            }))
        }
        "repairWaitingParentPayments" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired =
                sync::reconcile_deferred_payments(&db).map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Promoted {repaired} waiting-parent payment(s) for retry."),
            }))
        }
        "repairWaitingParentAdjustments" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::reconcile_deferred_adjustments(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Promoted {repaired} waiting-parent adjustment(s) for retry."),
            }))
        }
        "requeueFailedOrderValidationRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_order_validation_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed order validation row(s)."),
            }))
        }
        "requeueRetryableFailedShiftRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_retryable_failed_shift_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} retryable failed shift row(s)."),
            }))
        }
        "requeueFailedFinancialShiftRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_financial_shift_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed shift-bound financial row(s)."),
            }))
        }
        "requeueFailedShiftCashierReferenceRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_shift_cashier_reference_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} failed cashier-reference shift row(s)."),
            }))
        }
        "requeueFailedAdjustmentMissingEndpointRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_adjustment_missing_endpoint_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} adjustment row(s) blocked by the legacy endpoint error."),
            }))
        }
        "requeueFailedAdjustmentLegacyValidationRows" => {
            auth::authorize_privileged_action(
                auth::PrivilegedActionScope::CashDrawerControl,
                &db,
                &auth_state,
            )?;
            let repaired = sync::requeue_failed_adjustment_legacy_validation_rows(&db)
                .map_err(auth::GuardedCommandError::from)?;
            Ok(json!({
                "success": true,
                "requiresRefresh": true,
                "message": format!("Requeued {repaired} adjustment row(s) blocked by legacy validation."),
            }))
        }

        _ => Err(format!("Unknown recovery action: {action_id}").into()),
    }
}
