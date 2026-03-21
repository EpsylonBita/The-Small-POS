//! Shift management for The Small POS.
//!
//! Implements shift open/close lifecycle with cash variance calculation,
//! matching the Electron POS shift-handlers.ts logic. Supports cashier,
//! manager, driver, kitchen, and server roles.
//!
//! Phase 4B scope: open, close, get_active, get_active_by_terminal,
//! get_active_by_terminal_loose, get_active_cashier_by_terminal,
//! get_active_cashier_by_terminal_loose.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeMap;
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::{business_day, order_ownership, storage};

// ---------------------------------------------------------------------------
// Open shift
// ---------------------------------------------------------------------------

/// Open a new shift for a staff member.
///
/// Creates a `staff_shifts` row and, for cashier roles, a matching
/// `cash_drawer_sessions` row. Returns error if staff already has an active shift.
pub fn open_shift(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let staff_id = str_field(payload, "staffId")
        .or_else(|| str_field(payload, "staff_id"))
        .ok_or("Missing staffId")?;
    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());
    let terminal_id = str_field(payload, "terminalId")
        .or_else(|| str_field(payload, "terminal_id"))
        .unwrap_or_else(|| storage::get_credential("terminal_id").unwrap_or_default());
    let role_type = str_field(payload, "roleType")
        .or_else(|| str_field(payload, "role_type"))
        .unwrap_or_else(|| "cashier".to_string());
    let staff_name = str_field(payload, "staffName").or_else(|| str_field(payload, "staff_name"));
    let requested_opening_cash = num_field(payload, "openingCash")
        .or_else(|| num_field(payload, "opening_cash"))
        .or_else(|| num_field(payload, "startingAmount"))
        .or_else(|| num_field(payload, "starting_amount"))
        .unwrap_or(0.0);
    let opening_cash = if is_non_financial_shift_role(&role_type) {
        0.0
    } else {
        requested_opening_cash
    };

    // Check for existing active shift
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM staff_shifts WHERE staff_id = ?1 AND status = 'active'",
            params![staff_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing_id) = existing {
        return Err(format!(
            "Staff member already has an active shift ({})",
            existing_id
        ));
    }

    let shift_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    // Wrap all writes in a transaction for atomicity
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        let responsible_cashier_assignment = if role_returns_cash(&role_type) {
            find_active_cashier_assignment(&conn, &branch_id, &terminal_id)?
        } else {
            None
        };
        let responsible_cashier_shift_id = responsible_cashier_assignment
            .as_ref()
            .map(|(cashier_shift_id, _)| cashier_shift_id.clone());

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, calculation_version,
                transferred_to_cashier_shift_id, sync_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', 2, ?9, 'pending', ?10, ?10)",
            params![
                shift_id,
                staff_id,
                staff_name,
                branch_id,
                terminal_id,
                role_type,
                now,
                opening_cash,
                responsible_cashier_shift_id,
                now,
            ],
        )
        .map_err(|e| format!("insert shift: {e}"))?;

        // Create cash drawer session for cashier/manager roles
        if role_type == "cashier" || role_type == "manager" {
            let drawer_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opened_at, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    drawer_id,
                    shift_id,
                    staff_id,
                    branch_id,
                    terminal_id,
                    opening_cash,
                    now,
                    now,
                ],
            )
            .map_err(|e| format!("insert cash drawer: {e}"))?;

            // Inherit transferred driver shifts from previous cashier.
            // These are drivers with is_transfer_pending = 1 who haven't checked out yet.
            let claimed_count =
                claim_transferred_cash_staff(&conn, &branch_id, &terminal_id, &shift_id, &now)?;

            if claimed_count > 0 {
                info!(
                    cashier_shift = %shift_id,
                    claimed_staff = claimed_count,
                    "Claimed transferred cash-return staff for cashier handoff"
                );
            }
        }

        // Driver/server starting amount: deduct from the responsible cashier drawer.
        if role_returns_cash(&role_type) && opening_cash > 0.0 {
            match responsible_cashier_assignment.as_ref() {
                Some((_cashier_shift_id, drawer_id)) => {
                    conn.execute(
                        "UPDATE cash_drawer_sessions SET
                            driver_cash_given = COALESCE(driver_cash_given, 0) + ?1,
                            updated_at = ?2
                         WHERE id = ?3",
                        params![opening_cash, now, drawer_id],
                    )
                    .map_err(|e| format!("update cashier drawer for staff starting amount: {e}"))?;
                    info!(
                        staff_shift = %shift_id,
                        cashier_drawer = %drawer_id,
                        amount = %opening_cash,
                        role = %role_type,
                        "Cash-return staff starting amount deducted from cashier drawer"
                    );
                }
                None => {
                    return Err(
                        "No active cashier found. A cashier must be checked in before staff can take starting amounts.".to_string()
                    );
                }
            }
        }

        // Enqueue for sync
        let idempotency_key = format!("shift:open:{shift_id}:{}", Uuid::new_v4());
        let sync_payload = build_shift_open_sync_payload(
            &shift_id,
            &staff_id,
            staff_name.as_deref(),
            &branch_id,
            &terminal_id,
            &role_type,
            opening_cash,
            &now,
            2,
            responsible_cashier_assignment
                .as_ref()
                .map(|(cashier_shift_id, _)| cashier_shift_id.as_str()),
            responsible_cashier_assignment
                .as_ref()
                .map(|(_, drawer_id)| drawer_id.as_str()),
        )
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('shift', ?1, 'insert', ?2, ?3)",
            params![shift_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue shift sync: {e}"))?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    info!(shift_id = %shift_id, staff_id = %staff_id, role = %role_type, "Shift opened");

    Ok(serde_json::json!({
        "success": true,
        "shiftId": shift_id,
        "message": format!("Shift opened for {} ({})", staff_id, role_type)
    }))
}

fn build_shift_open_sync_payload(
    shift_id: &str,
    staff_id: &str,
    staff_name: Option<&str>,
    branch_id: &str,
    terminal_id: &str,
    role_type: &str,
    opening_cash: f64,
    check_in_time: &str,
    calculation_version: i64,
    responsible_cashier_shift_id: Option<&str>,
    responsible_cashier_drawer_id: Option<&str>,
) -> Value {
    let mut payload = serde_json::json!({
        "shiftId": shift_id,
        "staffId": staff_id,
        "staffName": staff_name,
        "branchId": branch_id,
        "terminalId": terminal_id,
        "roleType": role_type,
        "openingCash": opening_cash,
        "checkInTime": check_in_time,
        "calculationVersion": calculation_version,
    });

    if role_returns_cash(role_type) && opening_cash > 0.0 {
        payload["responsibleCashierShiftId"] = responsible_cashier_shift_id
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null);
        payload["responsibleCashierDrawerId"] = responsible_cashier_drawer_id
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null);
        payload["startingAmountSourceCashierShiftId"] =
            payload["responsibleCashierShiftId"].clone();
        payload["borrowedStartingAmount"] = serde_json::json!(opening_cash);
    }

    payload
}

fn load_cash_drawer_snapshot_for_shift(
    conn: &Connection,
    shift_id: &str,
) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT id, cashier_id, opening_amount, closing_amount, expected_amount,
                variance_amount, total_cash_sales, total_card_sales, total_refunds,
                total_expenses, cash_drops, driver_cash_given, driver_cash_returned,
                total_staff_payments, opened_at, closed_at, reconciled,
                reconciled_at, reconciled_by
         FROM cash_drawer_sessions
         WHERE staff_shift_id = ?1",
        params![shift_id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "cashierId": row.get::<_, Option<String>>(1)?,
                "openingAmount": row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                "closingAmount": row.get::<_, Option<f64>>(3)?,
                "expectedAmount": row.get::<_, Option<f64>>(4)?,
                "varianceAmount": row.get::<_, Option<f64>>(5)?,
                "totalCashSales": row.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
                "totalCardSales": row.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                "totalRefunds": row.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
                "totalExpenses": row.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
                "cashDrops": row.get::<_, Option<f64>>(10)?.unwrap_or(0.0),
                "driverCashGiven": row.get::<_, Option<f64>>(11)?.unwrap_or(0.0),
                "driverCashReturned": row.get::<_, Option<f64>>(12)?.unwrap_or(0.0),
                "totalStaffPayments": row.get::<_, Option<f64>>(13)?.unwrap_or(0.0),
                "openedAt": row.get::<_, String>(14)?,
                "closedAt": row.get::<_, Option<String>>(15)?,
                "reconciled": row.get::<_, Option<i64>>(16)?.unwrap_or(0) != 0,
                "reconciledAt": row.get::<_, Option<String>>(17)?,
                "reconciledBy": row.get::<_, Option<String>>(18)?,
            }))
        },
    )
    .optional()
    .map_err(|e| format!("load shift cash drawer snapshot: {e}"))
}

// ---------------------------------------------------------------------------
// Close shift
// ---------------------------------------------------------------------------

/// Close an active shift. Calculates expected cash and variance.
///
/// For cashier/manager: expected = opening + cash_sales - refunds - expenses
///   - deducted_staff_payments - drops - driver_cash_given + driver_cash_returned
///     For driver/server: expected = opening + cash_collected - expenses
///
/// Uses calculation_version to decide whether all staff_payments are deducted (V1)
/// or only cashier self-payments are deducted (V2).
pub fn close_shift(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .ok_or("Missing shiftId")?;
    let closing_cash = num_field(payload, "closingCash")
        .or_else(|| num_field(payload, "closing_cash"))
        .ok_or("Missing closingCash")?;
    let raw_closed_by = str_field(payload, "closedBy").or_else(|| str_field(payload, "closed_by"));
    let closed_by = sanitize_database_uuid(raw_closed_by.clone());
    let payment_amount =
        num_field(payload, "paymentAmount").or_else(|| num_field(payload, "payment_amount"));

    if raw_closed_by.is_some() && closed_by.is_none() {
        warn!(
            shift_id = %shift_id,
            closed_by = raw_closed_by.as_deref().unwrap_or_default(),
            "Ignoring non-UUID closedBy for shift close"
        );
    }

    // Fetch the active shift (include branch_id/terminal_id for driver return + transfer logic)
    let shift = conn
        .query_row(
            "SELECT id, staff_id, staff_name, role_type, opening_cash_amount, calculation_version,
                    branch_id, terminal_id, check_in_time
             FROM staff_shifts WHERE id = ?1 AND status = 'active'",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, Option<i32>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .map_err(|_| format!("No active shift found with id {shift_id}"))?;

    let (
        _id,
        staff_id,
        staff_name,
        role_type,
        opening_cash,
        calc_version,
        shift_branch_id,
        shift_terminal_id,
        shift_check_in_time,
    ) = shift;
    let calc_version = calc_version.unwrap_or(1);
    let shift_branch_id = shift_branch_id.unwrap_or_default();
    let shift_terminal_id = shift_terminal_id.unwrap_or_default();
    let is_non_financial_role = is_non_financial_shift_role(&role_type);
    let closing_cash_to_persist = if is_non_financial_role {
        0.0
    } else {
        closing_cash
    };

    let now = Utc::now().to_rfc3339();
    let order_financial_expr = business_day::order_financial_timestamp_expr("o");
    let persisted_payment_amount =
        if role_type == "cashier" || role_type == "manager" || is_non_financial_role {
            None
        } else {
            payment_amount
        };

    // Wrap the entire reconciliation + close in a single IMMEDIATE transaction so
    // that no order/payment can be inserted between the aggregate SELECTs and the
    // subsequent UPDATEs, which would cause an incorrect cash variance.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(f64, f64), String> {
        #[allow(clippy::needless_late_init)]
        let expected: f64;
        let mut returned_cash_target: Option<(String, String, f64)> = None;

        order_ownership::repair_historical_pickup_financial_attribution(
            &conn,
            &shift_branch_id,
            &now,
        )?;

        if role_type == "cashier" || role_type == "manager" {
            // Transfer active driver shifts to the next cashier BEFORE calculating expected.
            // This marks them as transferred and removes their starting amounts from driverCashGiven
            // so the closing cashier is not held liable for cash given to drivers who haven't returned.
            let transferred_driver_starting_total = transfer_active_cash_staff(
                &conn,
                &shift_branch_id,
                &shift_terminal_id,
                &shift_id,
                &now,
            )?;

            if transferred_driver_starting_total > 0.0 {
                // Subtract transferred driver starting amounts from driver_cash_given
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                    driver_cash_given = COALESCE(driver_cash_given, 0) - ?1,
                    updated_at = ?2
                 WHERE staff_shift_id = ?3",
                    params![transferred_driver_starting_total, now, shift_id],
                )
                .map_err(|e| format!("adjust driver_cash_given for transfers: {e}"))?;
                info!(
                    shift_id = %shift_id,
                    total_deducted = %transferred_driver_starting_total,
                    "Subtracted transferred driver starting amounts from driver_cash_given"
                );
            }

            // Reconcile-at-close: re-derive drawer totals from source-of-truth tables.
            // This catches any missed incremental updates during the shift.
            let reconciled_cash_sales: f64 = conn
                .query_row(
                    &format!(
                        "SELECT COALESCE(SUM(op.amount), 0)
                 FROM orders o
                 LEFT JOIN order_payments op ON op.order_id = o.id
                 WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
                   AND op.method = 'cash'
                   AND op.status = 'completed'
                   AND COALESCE(o.is_ghost, 0) = 0
                   AND {order_financial_expr} >= ?2
                   AND {order_financial_expr} <= ?3"
                    ),
                    params![shift_id, shift_check_in_time, now],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);
            let reconciled_card_sales: f64 = conn
                .query_row(
                    &format!(
                        "SELECT COALESCE(SUM(op.amount), 0)
                 FROM orders o
                 LEFT JOIN order_payments op ON op.order_id = o.id
                 WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
                   AND op.method = 'card'
                   AND op.status = 'completed'
                   AND COALESCE(o.is_ghost, 0) = 0
                   AND {order_financial_expr} >= ?2
                   AND {order_financial_expr} <= ?3"
                    ),
                    params![shift_id, shift_check_in_time, now],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);
            let reconciled_refunds: f64 = conn
                .query_row(
                    &format!(
                        "SELECT COALESCE(SUM(pa.amount), 0)
                 FROM orders o
                 JOIN payment_adjustments pa ON pa.order_id = o.id
                 LEFT JOIN order_payments op ON op.id = pa.payment_id
                 WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
                   AND pa.adjustment_type = 'refund'
                   AND COALESCE(o.is_ghost, 0) = 0
                   AND {order_financial_expr} >= ?2
                   AND {order_financial_expr} <= ?3"
                    ),
                    params![shift_id, shift_check_in_time, now],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);
            let reconciled_expenses: f64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(amount), 0)
                 FROM shift_expenses WHERE staff_shift_id = ?1",
                    params![shift_id],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);
            let reconciled_staff_payments: f64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(amount), 0)
                 FROM staff_payments
                 WHERE cashier_shift_id = ?1",
                    params![shift_id],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);

            // Write reconciled values to cash_drawer_sessions
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                total_cash_sales = ?1,
                total_card_sales = ?2,
                total_refunds = ?3,
                total_expenses = ?4,
                total_staff_payments = ?5,
                updated_at = ?6
             WHERE staff_shift_id = ?7",
                params![
                    reconciled_cash_sales,
                    reconciled_card_sales,
                    reconciled_refunds,
                    reconciled_expenses,
                    reconciled_staff_payments,
                    now,
                    shift_id,
                ],
            )
            .map_err(|e| format!("reconcile drawer totals: {e}"))?;

            // Fetch cash drawer session totals (now reconciled)
            let drawer = conn
                .query_row(
                    "SELECT total_cash_sales, total_refunds, total_expenses,
                        cash_drops, driver_cash_given, driver_cash_returned,
                        total_staff_payments
                 FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                    params![shift_id],
                    |row| {
                        Ok((
                            row.get::<_, f64>(0).unwrap_or(0.0),
                            row.get::<_, f64>(1).unwrap_or(0.0),
                            row.get::<_, f64>(2).unwrap_or(0.0),
                            row.get::<_, f64>(3).unwrap_or(0.0),
                            row.get::<_, f64>(4).unwrap_or(0.0),
                            row.get::<_, f64>(5).unwrap_or(0.0),
                            row.get::<_, f64>(6).unwrap_or(0.0),
                        ))
                    },
                )
                .unwrap_or((0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0));

            let (
                cash_sales,
                refunds,
                expenses,
                drops,
                driver_given,
                driver_returned,
                staff_payments,
            ) = drawer;
            let deducted_staff_payments = if calc_version >= 2 {
                conn.query_row(
                    "SELECT COALESCE(SUM(amount), 0)
                 FROM staff_payments
                 WHERE cashier_shift_id = ?1
                   AND paid_to_staff_id = ?2",
                    params![shift_id, staff_id],
                    |row| row.get(0),
                )
                .unwrap_or(0.0)
            } else {
                staff_payments
            };

            // Inherited driver expected returns: drivers transferred TO this cashier shift
            // who are still active. Their expected cash return is added to the cashier's expected.
            let inherited_driver_expected_returns = compute_inherited_cash_staff_expected_returns(
                &conn,
                &shift_id,
                &shift_check_in_time,
            )?;

            if inherited_driver_expected_returns != 0.0 {
                info!(
                    shift_id = %shift_id,
                    inherited = %inherited_driver_expected_returns,
                    "Including inherited driver expected returns in cashier formula"
                );
            }

            expected = opening_cash + cash_sales
                - refunds
                - expenses
                - deducted_staff_payments
                - drops
                - driver_given
                + driver_returned
                + inherited_driver_expected_returns;
        } else if is_non_financial_role {
            expected = 0.0;
        } else {
            // Driver / server: expected = opening + cash collected - expenses
            let cash_collected = if role_type == "driver" {
                compute_shift_cash_collected(&conn, &shift_id, &role_type)?
            } else {
                let (_, cash_collected, _, _) = compute_shift_payment_totals_in_window(
                    &conn,
                    &shift_id,
                    &role_type,
                    Some(shift_check_in_time.as_str()),
                    Some(now.as_str()),
                )?;
                cash_collected
            };

            // Sum expenses for this shift
            let expenses = compute_shift_expenses_total_in_window(
                &conn,
                &shift_id,
                Some(shift_check_in_time.as_str()),
                Some(now.as_str()),
            );
            let _legacy_payment_amount = payment_amount.unwrap_or(0.0);
            expected = opening_cash + cash_collected - expenses;
        }

        let variance = if is_non_financial_role {
            0.0
        } else {
            closing_cash_to_persist - expected
        };

        // Update cash drawer session (if cashier/manager) and persist the
        // reconciliation metadata captured during closeout.
        if role_type == "cashier" || role_type == "manager" {
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                    closing_amount = ?1, expected_amount = ?2,
                    variance_amount = ?3, reconciled = 1,
                    closed_at = ?4, reconciled_at = ?4, reconciled_by = ?5,
                    updated_at = ?4
                 WHERE staff_shift_id = ?6",
                params![
                    closing_cash_to_persist,
                    expected,
                    variance,
                    now,
                    closed_by.as_deref(),
                    shift_id,
                ],
            )
            .map_err(|e| format!("update cash drawer: {e}"))?;
        }

        if role_returns_cash(&role_type) {
            match resolve_cashier_drawer_for_staff_return(
                &conn,
                &shift_id,
                &shift_branch_id,
                &shift_terminal_id,
            )? {
                Some((cashier_shift_id, drawer_id)) => {
                    conn.execute(
                        "UPDATE cash_drawer_sessions SET
                            driver_cash_returned = COALESCE(driver_cash_returned, 0) + ?1,
                            updated_at = ?2
                         WHERE id = ?3",
                        params![closing_cash_to_persist, now, drawer_id],
                    )
                    .map_err(|e| format!("update cashier drawer for staff return: {e}"))?;
                    returned_cash_target = Some((
                        cashier_shift_id.clone(),
                        drawer_id.clone(),
                        closing_cash_to_persist,
                    ));
                    info!(
                        staff_shift = %shift_id,
                        cashier_shift = %cashier_shift_id,
                        cashier_drawer = %drawer_id,
                        actual_return = %closing_cash_to_persist,
                        role = %role_type,
                        "Cash-return staff checkout recorded on cashier drawer"
                    );
                }
                None => {
                    warn!(
                        staff_shift = %shift_id,
                        branch_id = %shift_branch_id,
                        role = %role_type,
                        "No active cashier drawer found for staff cash return"
                    );
                }
            }
        }

        // Compute staff earnings for this shift (all role types)
        let (order_count, total_sales, shift_cash_sales, shift_card_sales): (i64, f64, f64, f64) =
            conn.query_row(
                &format!(
                    "SELECT
                    COUNT(DISTINCT o.id),
                    COALESCE(SUM(o.total_amount), 0),
                    COALESCE(SUM(CASE WHEN op.method = 'cash' THEN op.amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN op.method = 'card' THEN op.amount ELSE 0 END), 0)
                 FROM orders o
                 LEFT JOIN order_payments op ON op.order_id = o.id AND op.status = 'completed'
                 WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
                   AND COALESCE(o.is_ghost, 0) = 0
                   AND o.status NOT IN ('cancelled', 'canceled')
                   AND {order_financial_expr} >= ?2
                   AND {order_financial_expr} <= ?3"
                ),
                params![shift_id, shift_check_in_time, now],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap_or((0, 0.0, 0.0, 0.0));

        // Update the shift record
        conn.execute(
            "UPDATE staff_shifts SET
                check_out_time = ?1, closing_cash_amount = ?2, expected_cash_amount = ?3,
                cash_variance = ?4, status = 'closed', payment_amount = ?5,
                closed_by = ?6, sync_status = 'pending', updated_at = ?1,
                total_orders_count = ?8, total_sales_amount = ?9,
                total_cash_sales = ?10, total_card_sales = ?11
             WHERE id = ?7",
            params![
                now,
                closing_cash_to_persist,
                expected,
                variance,
                persisted_payment_amount,
                closed_by,
                shift_id,
                order_count,
                total_sales,
                shift_cash_sales,
                shift_card_sales,
            ],
        )
        .map_err(|e| format!("close shift: {e}"))?;

        // Enqueue for sync
        let idempotency_key = format!("shift:close:{shift_id}:{}", Uuid::new_v4());
        let cash_drawer_snapshot = load_cash_drawer_snapshot_for_shift(&conn, &shift_id)?;
        let mut sync_payload = serde_json::json!({
            "shiftId": shift_id,
            "staffId": staff_id,
            "staffName": staff_name,
            "branchId": shift_branch_id,
            "terminalId": shift_terminal_id,
            "roleType": role_type,
            "openingCash": opening_cash,
            "checkInTime": shift_check_in_time,
            "checkOutTime": now,
            "calculationVersion": calc_version,
            "totalOrdersCount": order_count,
            "totalSalesAmount": total_sales,
            "totalCashSales": shift_cash_sales,
            "totalCardSales": shift_card_sales,
            "closingCash": closing_cash_to_persist,
            "expectedCash": expected,
            "variance": variance,
            "closedBy": closed_by,
            "paymentAmount": persisted_payment_amount,
        });
        if let Some(drawer_snapshot) = cash_drawer_snapshot {
            sync_payload["cashDrawer"] = drawer_snapshot;
        }
        if let Some((cashier_shift_id, drawer_id, returned_amount)) = returned_cash_target {
            sync_payload["returnedCashTargetCashierShiftId"] =
                Value::String(cashier_shift_id.clone());
            sync_payload["returnedCashTargetDrawerId"] = Value::String(drawer_id.clone());
            sync_payload["returnedCashAmount"] = serde_json::json!(returned_amount);
            sync_payload["resolvedCashierShiftId"] = Value::String(cashier_shift_id);
            sync_payload["resolvedCashierDrawerId"] = Value::String(drawer_id);
        }
        let sync_payload = sync_payload.to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('shift', ?1, 'update', ?2, ?3)",
            params![shift_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue shift close sync: {e}"))?;

        let remaining_active_shifts: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM staff_shifts
                 WHERE branch_id = ?1
                   AND status = 'active'",
                params![shift_branch_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if remaining_active_shifts == 0 {
            crate::zreport::ensure_pending_z_report_context_for_branch(
                &conn,
                &shift_branch_id,
                &now,
            )?;
        }

        Ok((expected, variance))
    })();

    match result {
        Ok((expected, variance)) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;

            info!(shift_id = %shift_id, variance = %variance, "Shift closed");

            Ok(serde_json::json!({
                "success": true,
                "variance": variance,
                "expected": expected,
                "closing": closing_cash,
                "message": format!("Shift closed. Variance: {:.2}", variance)
            }))
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Shift queries
// ---------------------------------------------------------------------------

/// Get the active shift for a staff member.
pub fn get_active(db: &DbState, staff_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    query_shift(
        &conn,
        "SELECT * FROM staff_shifts WHERE staff_id = ?1 AND status = 'active' LIMIT 1",
        params![staff_id],
    )
}

/// Get the active shift for a specific branch + terminal (strict match).
pub fn get_active_by_terminal(
    db: &DbState,
    branch_id: &str,
    terminal_id: &str,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    query_shift(
        &conn,
        "SELECT * FROM staff_shifts WHERE branch_id = ?1 AND terminal_id = ?2 AND status = 'active'
         ORDER BY check_in_time DESC LIMIT 1",
        params![branch_id, terminal_id],
    )
}

/// Get the active shift for a terminal (loose match — no branch filter).
pub fn get_active_by_terminal_loose(db: &DbState, terminal_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    query_shift(
        &conn,
        "SELECT * FROM staff_shifts WHERE terminal_id = ?1 AND status = 'active'
         ORDER BY check_in_time DESC LIMIT 1",
        params![terminal_id],
    )
}

/// Get the active cashier shift for a specific branch + terminal.
pub fn get_active_cashier_by_terminal(
    db: &DbState,
    branch_id: &str,
    terminal_id: &str,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    query_shift(
        &conn,
        "SELECT * FROM staff_shifts
         WHERE branch_id = ?1 AND terminal_id = ?2
           AND status = 'active' AND role_type = 'cashier'
         ORDER BY check_in_time DESC LIMIT 1",
        params![branch_id, terminal_id],
    )
}

/// Get the active drawer-owner shift for a terminal without relying on branch context.
///
/// This is used when the local branch cache is stale but the terminal ID is still
/// correct. It intentionally prefers cashier/manager rows over newer non-cash roles.
pub fn get_active_cashier_by_terminal_loose(
    db: &DbState,
    terminal_id: &str,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    query_shift(
        &conn,
        "SELECT * FROM staff_shifts
         WHERE terminal_id = ?1
           AND status = 'active'
           AND role_type IN ('cashier', 'manager')
         ORDER BY check_in_time DESC LIMIT 1",
        params![terminal_id],
    )
}

/// Get a specific shift by its ID.
pub fn get_shift_by_id(db: &DbState, shift_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    query_shift(
        &conn,
        "SELECT * FROM staff_shifts WHERE id = ?1 LIMIT 1",
        params![shift_id],
    )
}

// ---------------------------------------------------------------------------
// Shift summary
// ---------------------------------------------------------------------------

/// Get a summary of a shift: totals, payment breakdown, expenses, variance.
pub fn get_shift_summary(db: &DbState, shift_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_financial_expr = business_day::order_financial_timestamp_expr("o");

    // --- 1. Fetch the shift ---
    let (role_type, branch_id, terminal_id, check_in_time, shift): (
        String,
        String,
        String,
        String,
        Value,
    ) = conn
        .query_row(
            "SELECT id, staff_id, staff_name, role_type, status, opening_cash_amount,
                    closing_cash_amount, expected_cash_amount, cash_variance,
                    check_in_time, check_out_time, total_orders_count,
                    total_sales_amount, total_cash_sales, total_card_sales,
                    branch_id, terminal_id, calculation_version, payment_amount
             FROM staff_shifts WHERE id = ?1",
            params![shift_id],
            |row| {
                let rt: String = row.get(3)?;
                let bi: String = row.get::<_, Option<String>>(15)?.unwrap_or_default();
                let ti: String = row.get::<_, Option<String>>(16)?.unwrap_or_default();
                let ci: String = row.get(9)?;
                let val = serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "staff_id": row.get::<_, String>(1)?,
                    "staff_name": row.get::<_, Option<String>>(2)?,
                    "role_type": &rt,
                    "status": row.get::<_, String>(4)?,
                    "opening_cash_amount": row.get::<_, f64>(5)?,
                    "closing_cash_amount": row.get::<_, Option<f64>>(6)?,
                    "expected_cash_amount": row.get::<_, Option<f64>>(7)?,
                    "cash_variance": row.get::<_, Option<f64>>(8)?,
                    "check_in_time": &ci,
                    "check_out_time": row.get::<_, Option<String>>(10)?,
                    "total_orders_count": row.get::<_, i64>(11)?,
                    "total_sales_amount": row.get::<_, f64>(12)?,
                    "total_cash_sales": row.get::<_, f64>(13)?,
                    "total_card_sales": row.get::<_, f64>(14)?,
                    "branch_id": &bi,
                    "terminal_id": &ti,
                    "calculation_version": row.get::<_, i64>(17)?,
                    "payment_amount": row.get::<_, Option<f64>>(18)?,
                });
                Ok((rt, bi, ti, ci, val))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("Shift not found: {shift_id}"),
            _ => format!("query shift: {e}"),
        })?;

    // --- 2. Cash drawer session (all roles may have one) ---
    let cashier_check_out_time = shift.get("check_out_time").and_then(Value::as_str);

    let cash_drawer: Value = conn
        .query_row(
            "SELECT id, opening_amount, closing_amount, expected_amount, variance_amount,
                    total_cash_sales, total_card_sales, total_refunds, total_expenses,
                    cash_drops, driver_cash_given, driver_cash_returned, total_staff_payments,
                    opened_at, closed_at, reconciled
             FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "opening_amount": row.get::<_, f64>(1)?,
                    "closing_amount": row.get::<_, Option<f64>>(2)?,
                    "expected_amount": row.get::<_, Option<f64>>(3)?,
                    "variance_amount": row.get::<_, Option<f64>>(4)?,
                    "total_cash_sales": row.get::<_, f64>(5)?,
                    "total_card_sales": row.get::<_, f64>(6)?,
                    "total_refunds": row.get::<_, f64>(7)?,
                    "total_expenses": row.get::<_, f64>(8)?,
                    "cash_drops": row.get::<_, f64>(9)?,
                    "driver_cash_given": row.get::<_, f64>(10)?,
                    "driver_cash_returned": row.get::<_, f64>(11)?,
                    "total_staff_payments": row.get::<_, f64>(12)?,
                    "opened_at": row.get::<_, String>(13)?,
                    "closed_at": row.get::<_, Option<String>>(14)?,
                    "reconciled": row.get::<_, i64>(15)? != 0,
                }))
            },
        )
        .unwrap_or(Value::Null);

    let shift_end_param = cashier_check_out_time;

    // --- 3. Sales breakdown by order_type × payment_method ---
    let breakdown_sql = format!(
        "SELECT COALESCE(o.order_type, 'dine-in'), op.method,
                COUNT(DISTINCT o.id), COALESCE(SUM(op.amount), 0)
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
         WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
           AND op.status = 'completed'
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
           {}
           AND {order_financial_expr} >= ?2
           AND (?3 IS NULL OR {order_financial_expr} <= ?3)
         GROUP BY COALESCE(o.order_type, 'dine-in'), op.method",
        role_order_type_filter_sql(&role_type, "o")
    );
    let mut breakdown_stmt = conn
        .prepare(&breakdown_sql)
        .map_err(|e| format!("prepare breakdown: {e}"))?;

    let rows: Vec<(String, String, i64, f64)> = breakdown_stmt
        .query_map(params![shift_id, check_in_time, shift_end_param], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| format!("query breakdown: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let instore_types = ["dine-in", "takeaway", "pickup"];
    let is_instore = |t: &str| instore_types.contains(&t);

    #[allow(clippy::type_complexity)]
    let sum_by = |f: &dyn Fn(&(String, String, i64, f64)) -> bool| -> f64 {
        rows.iter().filter(|r| f(r)).map(|r| r.3).sum()
    };
    #[allow(clippy::type_complexity)]
    let count_by = |f: &dyn Fn(&(String, String, i64, f64)) -> bool| -> i64 {
        rows.iter().filter(|r| f(r)).map(|r| r.2).sum()
    };

    let breakdown = serde_json::json!({
        "instore": {
            "cashTotal": sum_by(&|r| is_instore(&r.0) && r.1 == "cash"),
            "cardTotal": sum_by(&|r| is_instore(&r.0) && r.1 == "card"),
            "cashCount": count_by(&|r| is_instore(&r.0) && r.1 == "cash"),
            "cardCount": count_by(&|r| is_instore(&r.0) && r.1 == "card"),
        },
        "delivery": {
            "cashTotal": sum_by(&|r| !is_instore(&r.0) && r.1 == "cash"),
            "cardTotal": sum_by(&|r| !is_instore(&r.0) && r.1 == "card"),
            "cashCount": count_by(&|r| !is_instore(&r.0) && r.1 == "cash"),
            "cardCount": count_by(&|r| !is_instore(&r.0) && r.1 == "card"),
        },
        "overall": {
            "cashTotal": sum_by(&|r| r.1 == "cash"),
            "cardTotal": sum_by(&|r| r.1 == "card"),
            "totalCount": count_by(&|_| true),
            "totalAmount": sum_by(&|_| true),
        }
    });

    // --- 4. Canceled orders breakdown ---
    let canceled_sql = format!(
        "SELECT COALESCE(payment_method, 'cash'), COUNT(*), COALESCE(SUM(total_amount), 0)
         FROM orders
         WHERE staff_shift_id = ?1
           AND COALESCE(is_ghost, 0) = 0
           AND status IN ('cancelled', 'canceled', 'refunded')
           {}
         GROUP BY payment_method",
        role_order_type_filter_sql(&role_type, "orders")
    );
    let mut canceled_stmt = conn
        .prepare(&canceled_sql)
        .map_err(|e| format!("prepare canceled: {e}"))?;

    let canceled_rows: Vec<(String, i64, f64)> = canceled_stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("query canceled: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let canceled_cash = canceled_rows.iter().find(|r| r.0 == "cash");
    let canceled_card = canceled_rows.iter().find(|r| r.0 == "card");

    let canceled_orders = serde_json::json!({
        "cashTotal": canceled_cash.map_or(0.0, |r| r.2),
        "cardTotal": canceled_card.map_or(0.0, |r| r.2),
        "cashCount": canceled_cash.map_or(0, |r| r.1),
        "cardCount": canceled_card.map_or(0, |r| r.1),
    });

    // --- 5. Cash refunds ---
    let cash_refunds: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(pa.amount), 0)
             FROM payment_adjustments pa
             JOIN order_payments op ON op.id = pa.payment_id
             JOIN orders o ON o.id = op.order_id
             WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
               AND pa.adjustment_type = 'refund'
               AND (
                    (COALESCE(pa.refund_method, '') = 'cash'
                     AND COALESCE(pa.cash_handler, 'cashier_drawer') = 'cashier_drawer')
                    OR (COALESCE(pa.refund_method, '') = '' AND op.method = 'cash')
               )
               AND COALESCE(o.is_ghost, 0) = 0
               AND {order_financial_expr} >= ?2
               AND (?3 IS NULL OR {order_financial_expr} <= ?3)"
            ),
            params![shift_id, check_in_time, shift_end_param],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    // --- 6. Expense items array + total ---
    let mut exp_stmt = conn
        .prepare(
            "SELECT id, expense_type, amount, description, receipt_number, status, created_at
             FROM shift_expenses WHERE staff_shift_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare expenses: {e}"))?;

    let expense_items: Vec<Value> = exp_stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expense_type": row.get::<_, String>(1)?,
                "amount": row.get::<_, f64>(2)?,
                "description": row.get::<_, String>(3)?,
                "receipt_number": row.get::<_, Option<String>>(4)?,
                "status": row.get::<_, String>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| format!("query expenses: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let total_expenses: f64 = expense_items
        .iter()
        .map(|e| e["amount"].as_f64().unwrap_or(0.0))
        .sum();

    // --- 7. Driver data (role-dependent) ---
    let mut driver_deliveries: Vec<Value> = Vec::new();
    let mut transferred_drivers: Vec<Value> = Vec::new();
    let mut transferred_waiters: Vec<Value> = Vec::new();
    let mut waiter_tables: Vec<Value> = Vec::new();
    let mut staff_payments: Vec<Value> = Vec::new();
    let mut cashier_orders: Vec<Value> = Vec::new();

    if role_type == "cashier" || role_type == "manager" {
        cashier_orders =
            build_cashier_order_history(&conn, shift_id, &check_in_time, cashier_check_out_time)?;
        driver_deliveries = build_cashier_staff_checkout_rows(
            &conn,
            shift_id,
            &branch_id,
            &terminal_id,
            &check_in_time,
            cashier_check_out_time,
        )?;
        transferred_drivers =
            build_inherited_cash_staff_rows(&conn, shift_id, &check_in_time, "driver")?;
        transferred_waiters =
            build_inherited_cash_staff_rows(&conn, shift_id, &check_in_time, "server")?;
        staff_payments = load_cashier_staff_payments(&conn, shift_id)?;
    } else if role_type == "driver" {
        // Backfill: create missing driver_earnings from orders assigned to this driver
        let driver_staff_id = shift["staff_id"].as_str().unwrap_or("");
        if !driver_staff_id.is_empty() {
            let mut missing_stmt = conn
                .prepare(
                    "SELECT o.id, o.total_amount, o.payment_method, o.delivery_fee, o.branch_id
                     FROM orders o
                     WHERE (o.driver_id = ?1 OR o.staff_shift_id = ?2)
                       AND o.order_type = 'delivery'
                       AND COALESCE(o.is_ghost, 0) = 0
                       AND o.created_at >= ?3
                       AND NOT EXISTS (SELECT 1 FROM driver_earnings de WHERE de.order_id = o.id)",
                )
                .map_err(|e| format!("prepare backfill: {e}"))?;
            let now = chrono::Utc::now().to_rfc3339();
            let backfill_rows: Vec<(String, f64, String, f64, String)> = missing_stmt
                .query_map(params![driver_staff_id, shift_id, check_in_time], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1).unwrap_or(0.0),
                        row.get::<_, String>(2)
                            .unwrap_or_else(|_| "cash".to_string()),
                        row.get::<_, f64>(3).unwrap_or(0.0),
                        row.get::<_, String>(4).unwrap_or_default(),
                    ))
                })
                .map_err(|e| format!("backfill query: {e}"))?
                .filter_map(|r| r.ok())
                .collect();

            for (oid, total, pm, del_fee, bid) in &backfill_rows {
                let pm_lower = pm.to_lowercase();
                let (_, cash, card, _total_paid) =
                    compute_shift_payment_totals_for_order(&conn, oid, *total, &pm_lower)?;
                let payment_method = if cash > 0.0 && card > 0.0 {
                    "mixed".to_string()
                } else if card > 0.0 {
                    "card".to_string()
                } else {
                    "cash".to_string()
                };
                let eid = uuid::Uuid::new_v4().to_string();
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO driver_earnings (
                        id, driver_id, staff_shift_id, order_id, branch_id,
                        delivery_fee, tip_amount, total_earning,
                        payment_method, cash_collected, card_amount, cash_to_return,
                        settled, created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?6, ?7, ?8, ?9, ?8, 0, ?10, ?10)",
                    params![
                        eid,
                        driver_staff_id,
                        shift_id,
                        oid,
                        bid,
                        del_fee,
                        payment_method,
                        cash,
                        card,
                        now
                    ],
                );
            }
            if !backfill_rows.is_empty() {
                info!(
                    "Backfilled {} driver_earnings for shift {shift_id}",
                    backfill_rows.len()
                );
            }
        }

        // For driver checkout: get individual delivery records
        let mut de_stmt = conn
            .prepare(
                "SELECT de.id, de.order_id, de.delivery_fee, de.tip_amount,
                        de.total_earning, de.payment_method, de.cash_collected,
                        de.card_amount, de.cash_to_return,
                        o.order_number, o.delivery_address, o.total_amount,
                        o.status, o.customer_name, o.customer_phone
                 FROM driver_earnings de
                 LEFT JOIN orders o ON de.order_id = o.id
                 WHERE de.staff_shift_id = ?1
                   AND (o.id IS NULL OR COALESCE(o.is_ghost, 0) = 0)
                   AND (o.id IS NULL OR o.order_type = 'delivery')
                 ORDER BY de.created_at DESC",
            )
            .map_err(|e| format!("prepare driver earnings: {e}"))?;

        driver_deliveries = de_stmt
            .query_map(params![shift_id], |row| {
                let status: String = row.get::<_, Option<String>>(12)?.unwrap_or_default();
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "order_id": row.get::<_, String>(1)?,
                    "delivery_fee": row.get::<_, f64>(2)?,
                    "tip_amount": row.get::<_, f64>(3)?,
                    "total_earning": row.get::<_, f64>(4)?,
                    "payment_method": row.get::<_, String>(5)?,
                    "cash_collected": row.get::<_, f64>(6)?,
                    "card_amount": row.get::<_, f64>(7)?,
                    "cash_to_return": row.get::<_, f64>(8)?,
                    "order_number": row.get::<_, Option<String>>(9)?,
                    "delivery_address": row.get::<_, Option<String>>(10)?,
                    "total_amount": row.get::<_, Option<f64>>(11)?,
                    "status": &status,
                    "order_status": &status,
                    "customer_name": row.get::<_, Option<String>>(13)?,
                    "customer_phone": row.get::<_, Option<String>>(14)?,
                }))
            })
            .map_err(|e| format!("query driver earnings: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
    } else if role_type == "server" {
        waiter_tables = build_waiter_tables(&conn, shift_id)?;
    }

    // --- Build response matching Electron POS shape ---
    let overall = &breakdown["overall"];
    let orders_count = overall["totalCount"].as_i64().unwrap_or(0);
    let sales_amount = overall["totalAmount"].as_f64().unwrap_or(0.0);

    let mut result = serde_json::json!({
        "shift": shift,
        "cashDrawer": cash_drawer,
        "expenses": expense_items,
        "totalExpenses": total_expenses,
        "breakdown": breakdown,
        "canceledOrders": canceled_orders,
        "cashRefunds": cash_refunds,
        "driverDeliveries": driver_deliveries,
        "waiterTables": waiter_tables,
        "staffPayments": staff_payments,
        "ordersCount": orders_count,
        "salesAmount": sales_amount,
    });

    if !transferred_drivers.is_empty() {
        result["transferredDrivers"] = serde_json::json!(transferred_drivers);
    }

    if !transferred_waiters.is_empty() {
        result["transferredWaiters"] = serde_json::json!(transferred_waiters);
    }

    if role_type == "cashier" || role_type == "manager" {
        result["cashierOrders"] = serde_json::json!(cashier_orders);
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Expense management
// ---------------------------------------------------------------------------

/// Record an expense during a shift.
///
/// Inserts into `shift_expenses`, updates the cash drawer session's
/// `total_expenses`, and enqueues for sync.
pub fn record_expense(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .ok_or("Missing shiftId")?;
    let amount = num_field(payload, "amount").ok_or("Missing amount")?;
    if amount <= 0.0 {
        return Err("Amount must be positive".into());
    }
    let expense_type = str_field(payload, "expenseType")
        .or_else(|| str_field(payload, "expense_type"))
        .unwrap_or_else(|| "other".to_string());
    let description = str_field(payload, "description").ok_or("Missing description")?;
    let receipt_number =
        str_field(payload, "receiptNumber").or_else(|| str_field(payload, "receipt_number"));

    // Verify shift exists and is active
    let (staff_id, branch_id): (String, String) = conn
        .query_row(
            "SELECT staff_id, branch_id FROM staff_shifts WHERE id = ?1 AND status = 'active'",
            params![shift_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| format!("No active shift found with id {shift_id}"))?;

    let expense_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO shift_expenses (
                id, staff_shift_id, staff_id, branch_id, expense_type,
                amount, description, receipt_number, status, sync_status,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 'pending', ?9, ?9)",
            params![
                expense_id,
                shift_id,
                staff_id,
                branch_id,
                expense_type,
                amount,
                description,
                receipt_number,
                now,
            ],
        )
        .map_err(|e| format!("insert expense: {e}"))?;

        // Update cash drawer total_expenses (if cashier/manager)
        conn.execute(
            "UPDATE cash_drawer_sessions SET
                total_expenses = COALESCE(total_expenses, 0) + ?1,
                updated_at = ?2
             WHERE staff_shift_id = ?3",
            params![amount, now, shift_id],
        )
        .map_err(|e| format!("update drawer expenses: {e}"))?;

        // Enqueue for sync
        let idempotency_key = format!("expense:{expense_id}:{}", Uuid::new_v4());
        let sync_payload = serde_json::json!({
            "expenseId": expense_id,
            "shiftId": shift_id,
            "staffId": staff_id,
            "branchId": branch_id,
            "expenseType": expense_type,
            "amount": amount,
            "description": description,
            "receiptNumber": receipt_number,
            "status": "pending",
            "createdAt": now,
            "updatedAt": now,
        })
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('shift_expense', ?1, 'insert', ?2, ?3)",
            params![expense_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue expense sync: {e}"))?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    info!(expense_id = %expense_id, shift_id = %shift_id, amount = %amount, "Expense recorded");

    Ok(serde_json::json!({
        "success": true,
        "expenseId": expense_id,
        "message": format!("Expense of {:.2} recorded", amount),
    }))
}

/// Get all expenses for a shift.
pub fn get_expenses(db: &DbState, shift_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, staff_shift_id, staff_id, branch_id, expense_type,
                    amount, description, receipt_number, status,
                    approved_by, approved_at, rejection_reason,
                    created_at, updated_at
             FROM shift_expenses
             WHERE staff_shift_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "shiftId": row.get::<_, String>(1)?,
                "staffId": row.get::<_, String>(2)?,
                "branchId": row.get::<_, String>(3)?,
                "expenseType": row.get::<_, String>(4)?,
                "amount": row.get::<_, f64>(5)?,
                "description": row.get::<_, String>(6)?,
                "receiptNumber": row.get::<_, Option<String>>(7)?,
                "status": row.get::<_, String>(8)?,
                "approvedBy": row.get::<_, Option<String>>(9)?,
                "approvedAt": row.get::<_, Option<String>>(10)?,
                "rejectionReason": row.get::<_, Option<String>>(11)?,
                "createdAt": row.get::<_, String>(12)?,
                "updatedAt": row.get::<_, String>(13)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut expenses = Vec::new();
    for row in rows {
        match row {
            Ok(expense) => expenses.push(expense),
            Err(e) => warn!("skipping malformed expense row: {e}"),
        }
    }

    Ok(serde_json::json!(expenses))
}

// ---------------------------------------------------------------------------
// Cash-return staff helpers
// ---------------------------------------------------------------------------

pub fn is_non_financial_shift_role(role_type: &str) -> bool {
    matches!(role_type.trim().to_ascii_lowercase().as_str(), "kitchen")
}

fn role_returns_cash(role_type: &str) -> bool {
    matches!(role_type, "driver" | "server")
}

fn find_active_cashier_assignment(
    conn: &rusqlite::Connection,
    branch_id: &str,
    terminal_id: &str,
) -> Result<Option<(String, String)>, String> {
    let assignment = conn
        .query_row(
            "SELECT ss.id, cds.id
         FROM cash_drawer_sessions cds
         INNER JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
         WHERE cds.branch_id = ?1
           AND ss.status = 'active'
           AND ss.role_type IN ('cashier', 'manager')
           AND cds.closed_at IS NULL
         ORDER BY
           CASE WHEN cds.terminal_id = ?2 THEN 0 ELSE 1 END,
           ss.check_in_time ASC
         LIMIT 1",
            params![branch_id, terminal_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    Ok(assignment)
}

fn compute_shift_expenses_total_in_window(
    conn: &rusqlite::Connection,
    shift_id: &str,
    window_start: Option<&str>,
    window_end: Option<&str>,
) -> f64 {
    conn.query_row(
        "SELECT COALESCE(SUM(amount), 0)
         FROM shift_expenses
         WHERE staff_shift_id = ?1
           AND (?2 IS NULL OR created_at >= ?2)
           AND (?3 IS NULL OR created_at <= ?3)",
        params![shift_id, window_start, window_end],
        |row| row.get(0),
    )
    .unwrap_or(0.0)
}

fn compute_shift_expenses_total(conn: &rusqlite::Connection, shift_id: &str) -> f64 {
    compute_shift_expenses_total_in_window(conn, shift_id, None, None)
}

fn role_order_type_filter_sql(role_type: &str, order_alias: &str) -> String {
    match role_type {
        "driver" => format!("AND COALESCE({order_alias}.order_type, 'dine-in') = 'delivery'"),
        "server" => format!("AND COALESCE({order_alias}.order_type, 'dine-in') != 'delivery'"),
        _ => String::new(),
    }
}

fn compute_shift_payment_totals_in_window(
    conn: &rusqlite::Connection,
    shift_id: &str,
    role_type: &str,
    window_start: Option<&str>,
    window_end: Option<&str>,
) -> Result<(i64, f64, f64, f64), String> {
    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let sql = format!(
        "SELECT
            COUNT(DISTINCT o.id),
            COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'cash' THEN op.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'card' THEN op.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN op.status = 'completed' THEN op.amount ELSE 0 END), 0)
         FROM orders o
         LEFT JOIN order_payments op ON op.order_id = o.id
         WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
           {}
           AND (?2 IS NULL OR {financial_expr} >= ?2)
           AND (?3 IS NULL OR {financial_expr} <= ?3)",
        role_order_type_filter_sql(role_type, "o")
    );
    conn.query_row(&sql, params![shift_id, window_start, window_end], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .map_err(|e| format!("query shift payment totals: {e}"))
}

fn compute_shift_payment_totals(
    conn: &rusqlite::Connection,
    shift_id: &str,
    role_type: &str,
) -> Result<(i64, f64, f64, f64), String> {
    compute_shift_payment_totals_in_window(conn, shift_id, role_type, None, None)
}

fn compute_driver_shift_earning_totals(
    conn: &rusqlite::Connection,
    shift_id: &str,
) -> Result<(i64, f64, f64, f64), String> {
    conn.query_row(
        "SELECT
            COUNT(*),
            COALESCE(SUM(cash_collected), 0),
            COALESCE(SUM(card_amount), 0),
            COALESCE(SUM(cash_collected + card_amount), 0)
         FROM driver_earnings
         WHERE staff_shift_id = ?1
           AND COALESCE(settled, 0) = 0
           AND COALESCE(is_transferred, 0) = 0",
        params![shift_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .map_err(|e| format!("query driver earning totals: {e}"))
}

fn compute_shift_payment_totals_for_order(
    conn: &rusqlite::Connection,
    order_id: &str,
    fallback_total: f64,
    fallback_method: &str,
) -> Result<(i64, f64, f64, f64), String> {
    let totals = conn
        .query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(CASE WHEN status = 'completed' AND method = 'cash' THEN amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'completed' AND method = 'card' THEN amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0)
             FROM order_payments
             WHERE order_id = ?1",
            params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("query order payment totals: {e}"))?;

    if totals.0 > 0 {
        Ok(totals)
    } else {
        let (cash, card) = match fallback_method {
            "card" => (0.0, fallback_total),
            "mixed" => (fallback_total, fallback_total),
            _ => (fallback_total, 0.0),
        };
        Ok((0, cash, card, fallback_total))
    }
}

fn compute_shift_cash_collected(
    conn: &rusqlite::Connection,
    shift_id: &str,
    role_type: &str,
) -> Result<f64, String> {
    if role_type == "driver" {
        let (earning_count, driver_cash_collected, _, _) =
            compute_driver_shift_earning_totals(conn, shift_id)?;
        if earning_count > 0 {
            return Ok(driver_cash_collected);
        }
    }

    let (_, cash_collected, _, _) = compute_shift_payment_totals(conn, shift_id, role_type)?;
    Ok(cash_collected)
}

fn resolve_cashier_drawer_for_staff_return(
    conn: &rusqlite::Connection,
    staff_shift_id: &str,
    branch_id: &str,
    terminal_id: &str,
) -> Result<Option<(String, String)>, String> {
    let assigned_cashier_shift_id: Option<String> = conn
        .query_row(
            "SELECT transferred_to_cashier_shift_id FROM staff_shifts WHERE id = ?1",
            params![staff_shift_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    if let Some(cashier_shift_id) = assigned_cashier_shift_id {
        let assigned_drawer = conn
            .query_row(
                "SELECT id FROM cash_drawer_sessions
                 WHERE staff_shift_id = ?1
                   AND closed_at IS NULL
                 LIMIT 1",
                params![cashier_shift_id],
                |row| row.get::<_, String>(0),
            )
            .ok();

        if let Some(drawer_id) = assigned_drawer {
            return Ok(Some((cashier_shift_id, drawer_id)));
        }
    }

    find_active_cashier_assignment(conn, branch_id, terminal_id)
}

/// Transfer active driver/server shifts currently assigned to this cashier.
///
/// Marks each shift as transfer-pending and returns the opening cash total so the
/// closing cashier is no longer charged for float that has not yet come back.
fn transfer_active_cash_staff(
    conn: &rusqlite::Connection,
    branch_id: &str,
    terminal_id: &str,
    closing_cashier_shift_id: &str,
    now: &str,
) -> Result<f64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, opening_cash_amount
             FROM staff_shifts
             WHERE role_type IN ('driver', 'server')
               AND status = 'active'
                AND COALESCE(is_transfer_pending, 0) = 0
               AND (
                    transferred_to_cashier_shift_id = ?1
                    OR (
                        transferred_to_cashier_shift_id IS NULL
                        AND branch_id = ?2
                        AND terminal_id = ?3
                    )
               )",
        )
        .map_err(|e| format!("prepare transfer staff query: {e}"))?;

    let drivers: Vec<(String, f64)> = stmt
        .query_map(
            params![closing_cashier_shift_id, branch_id, terminal_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1).unwrap_or(0.0),
                ))
            },
        )
        .map_err(|e| format!("query active cash staff: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut total_starting = 0.0;

    for (driver_shift_id, opening_cash) in &drivers {
        conn.execute(
            "UPDATE staff_shifts SET
                is_transfer_pending = 1,
                transferred_to_cashier_shift_id = NULL,
                updated_at = ?1
             WHERE id = ?2",
            params![now, driver_shift_id],
        )
        .map_err(|e| format!("mark staff transfer pending: {e}"))?;

        conn.execute(
            "UPDATE driver_earnings SET
                is_transferred = 1,
                updated_at = ?1
             WHERE staff_shift_id = ?2",
            params![now, driver_shift_id],
        )
        .map_err(|e| format!("mark driver earnings transferred: {e}"))?;

        let idempotency_key = format!("shift:transfer:{driver_shift_id}:{}", Uuid::new_v4());
        let sync_payload = serde_json::json!({
            "shiftId": driver_shift_id,
            "isTransferPending": true,
            "transferredToCashierShiftId": null,
        })
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('shift', ?1, 'update', ?2, ?3)",
            params![driver_shift_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue staff transfer sync: {e}"))?;

        total_starting += opening_cash;
        info!(
            driver_shift = %driver_shift_id,
            opening_cash = %opening_cash,
            "Driver marked as transfer pending"
        );
    }

    if !drivers.is_empty() {
        info!(
            count = drivers.len(),
            total_starting = %total_starting,
            "Transferred active cash-return staff to next cashier"
        );
    }

    Ok(total_starting)
}

/// Claim transfer-pending driver/server shifts for a new cashier.
///
/// The receiving cashier becomes responsible for the eventual return, but does not
/// inherit a new negative float because the money was already given by the previous cashier.
fn claim_transferred_cash_staff(
    conn: &rusqlite::Connection,
    branch_id: &str,
    terminal_id: &str,
    new_cashier_shift_id: &str,
    now: &str,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id
             FROM staff_shifts
             WHERE branch_id = ?1
               AND role_type IN ('driver', 'server')
                AND status = 'active'
               AND is_transfer_pending = 1
             ORDER BY
               CASE WHEN terminal_id = ?2 THEN 0 ELSE 1 END,
               check_in_time ASC",
        )
        .map_err(|e| format!("prepare claim transferred staff query: {e}"))?;

    let drivers: Vec<String> = stmt
        .query_map(params![branch_id, terminal_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("query transferred staff: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    for driver_shift_id in &drivers {
        conn.execute(
            "UPDATE staff_shifts SET
                transferred_to_cashier_shift_id = ?1,
                is_transfer_pending = 0,
                updated_at = ?2
             WHERE id = ?3",
            params![new_cashier_shift_id, now, driver_shift_id],
        )
        .map_err(|e| format!("claim transferred staff: {e}"))?;

        let idempotency_key = format!("shift:claim:{driver_shift_id}:{}", Uuid::new_v4());
        let sync_payload = serde_json::json!({
            "shiftId": driver_shift_id,
            "transferredToCashierShiftId": new_cashier_shift_id,
            "isTransferPending": false,
        })
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('shift', ?1, 'update', ?2, ?3)",
            params![driver_shift_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue staff claim sync: {e}"))?;
        info!(
            staff_shift = %driver_shift_id,
            new_cashier = %new_cashier_shift_id,
            "Transferred staff claimed by new cashier"
        );
    }

    Ok(drivers.len())
}

/// Compute the expected cash returns from inherited driver/server shifts.
///
/// These are active staff assigned to this cashier whose shift started before the
/// cashier checked in, which means the current drawer did not originally issue the float.
fn compute_inherited_cash_staff_expected_returns(
    conn: &rusqlite::Connection,
    cashier_shift_id: &str,
    cashier_check_in_time: &str,
) -> Result<f64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ss.id, ss.role_type, ss.opening_cash_amount
             FROM staff_shifts ss
             WHERE ss.transferred_to_cashier_shift_id = ?1
               AND ss.status = 'active'
               AND ss.role_type IN ('driver', 'server')
               AND ss.check_in_time < ?2",
        )
        .map_err(|e| format!("prepare inherited staff query: {e}"))?;

    let drivers: Vec<(String, String, f64)> = stmt
        .query_map(params![cashier_shift_id, cashier_check_in_time], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2).unwrap_or(0.0),
            ))
        })
        .map_err(|e| format!("query inherited staff: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut total = 0.0;

    for (staff_shift_id, role_type, opening) in &drivers {
        let cash_collected = compute_shift_cash_collected(conn, staff_shift_id, role_type)?;
        let expenses = compute_shift_expenses_total(conn, staff_shift_id);
        total += opening + cash_collected - expenses;
    }

    Ok(total)
}

pub(crate) fn build_cashier_staff_checkout_rows(
    conn: &rusqlite::Connection,
    cashier_shift_id: &str,
    branch_id: &str,
    terminal_id: &str,
    cashier_check_in_time: &str,
    cashier_check_out_time: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ss.id, ss.staff_id, ss.staff_name, ss.role_type, ss.status,
                    ss.opening_cash_amount, ss.check_in_time, ss.check_out_time
             FROM staff_shifts ss
             WHERE ss.role_type IN ('driver', 'server')
               AND ss.status IN ('active', 'closed')
               AND COALESCE(ss.is_transfer_pending, 0) = 0
               AND (
                    ss.transferred_to_cashier_shift_id = ?1
                    OR (
                        ss.transferred_to_cashier_shift_id IS NULL
                        AND ss.branch_id = ?2
                        AND ss.terminal_id = ?3
                        AND ss.check_in_time >= ?4
                        AND (?5 IS NULL OR ss.check_in_time <= ?5)
                    )
               )
             ORDER BY ss.check_in_time ASC",
        )
        .map_err(|e| format!("prepare cashier staff rows: {e}"))?;

    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        Option<String>,
        String,
        String,
        f64,
        String,
        Option<String>,
    )> = stmt
        .query_map(
            params![
                cashier_shift_id,
                branch_id,
                terminal_id,
                cashier_check_in_time,
                cashier_check_out_time
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, f64>(5).unwrap_or(0.0),
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .map_err(|e| format!("query cashier staff rows: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut result = Vec::new();
    for (
        staff_shift_id,
        staff_id,
        staff_name,
        role_type,
        status,
        opening_cash_amount,
        check_in_time,
        check_out_time,
    ) in rows
    {
        let (order_count, cash_collected, card_amount, total_amount) = if role_type == "driver" {
            compute_driver_shift_earning_totals(conn, &staff_shift_id)?
        } else {
            compute_shift_payment_totals_in_window(
                conn,
                &staff_shift_id,
                &role_type,
                Some(check_in_time.as_str()),
                check_out_time.as_deref(),
            )?
        };
        let expenses = compute_shift_expenses_total_in_window(
            conn,
            &staff_shift_id,
            Some(check_in_time.as_str()),
            check_out_time.as_deref(),
        );
        let amount_to_return = opening_cash_amount + cash_collected - expenses;
        let display_name = staff_name.clone().unwrap_or_else(|| staff_id.clone());

        result.push(serde_json::json!({
            "shift_id": staff_shift_id,
            "driver_id": staff_id,
            "driver_name": display_name,
            "staff_id": staff_id,
            "staff_name": staff_name,
            "role": role_type,
            "role_type": role_type,
            "status": status,
            "starting_amount": opening_cash_amount,
            "cash_collected": cash_collected,
            "card_amount": card_amount,
            "total_amount": total_amount,
            "order_count": order_count,
            "expenses": expenses,
            "amount_to_return": amount_to_return,
            "check_in_time": check_in_time,
            "check_out_time": check_out_time,
        }));
    }

    Ok(result)
}

fn build_cashier_order_history(
    conn: &rusqlite::Connection,
    cashier_shift_id: &str,
    cashier_check_in_time: &str,
    cashier_check_out_time: Option<&str>,
) -> Result<Vec<Value>, String> {
    let order_financial_expr = business_day::order_financial_timestamp_expr("o");
    let sql = format!(
        "SELECT
                o.id,
                o.order_number,
                o.created_at,
                COALESCE(o.order_type, 'dine-in'),
                o.table_number,
                o.customer_name,
                o.status,
                COALESCE(o.total_amount, 0),
                COALESCE(o.payment_method, 'cash'),
                COALESCE((
                    SELECT SUM(op.amount)
                    FROM order_payments op
                    WHERE op.order_id = o.id
                      AND op.status = 'completed'
                      AND op.method = 'cash'
                ), 0),
                COALESCE((
                    SELECT SUM(op.amount)
                    FROM order_payments op
                    WHERE op.order_id = o.id
                      AND op.status = 'completed'
                      AND op.method = 'card'
                ), 0)
         FROM orders o
         WHERE o.staff_shift_id = ?1
           AND COALESCE(o.is_ghost, 0) = 0
           AND {order_financial_expr} >= ?2
           AND (?3 IS NULL OR {order_financial_expr} <= ?3)
         ORDER BY {order_financial_expr} DESC, o.created_at DESC"
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare cashier order history: {e}"))?;

    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        f64,
        String,
        f64,
        f64,
    )> = stmt
        .query_map(
            params![
                cashier_shift_id,
                cashier_check_in_time,
                cashier_check_out_time
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, f64>(7).unwrap_or(0.0),
                    row.get::<_, String>(8)?,
                    row.get::<_, f64>(9).unwrap_or(0.0),
                    row.get::<_, f64>(10).unwrap_or(0.0),
                ))
            },
        )
        .map_err(|e| format!("query cashier order history: {e}"))?
        .filter_map(|row| row.ok())
        .collect();

    Ok(rows
        .into_iter()
        .map(
            |(
                order_id,
                order_number,
                created_at,
                order_type,
                table_number,
                customer_name,
                status,
                total_amount,
                payment_method,
                cash_amount,
                card_amount,
            )| {
                serde_json::json!({
                    "order_id": order_id,
                    "order_number": order_number,
                    "created_at": created_at,
                    "order_type": order_type,
                    "table_number": table_number,
                    "customer_name": customer_name,
                    "status": status,
                    "total_amount": total_amount,
                    "payment_method": payment_method,
                    "cash_amount": cash_amount,
                    "card_amount": card_amount,
                })
            },
        )
        .collect())
}

fn build_inherited_cash_staff_rows(
    conn: &rusqlite::Connection,
    cashier_shift_id: &str,
    cashier_check_in_time: &str,
    role_type: &str,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ss.id, ss.staff_id, ss.staff_name, ss.opening_cash_amount, ss.check_in_time
             FROM staff_shifts ss
             WHERE ss.transferred_to_cashier_shift_id = ?1
               AND ss.role_type = ?2
               AND ss.status = 'active'
               AND ss.check_in_time < ?3
             ORDER BY ss.check_in_time ASC",
        )
        .map_err(|e| format!("prepare inherited staff rows: {e}"))?;

    let rows: Vec<(String, String, Option<String>, f64, String)> = stmt
        .query_map(
            params![cashier_shift_id, role_type, cashier_check_in_time],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, f64>(3).unwrap_or(0.0),
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(|e| format!("query inherited staff rows: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut result = Vec::new();
    for (staff_shift_id, staff_id, staff_name, opening_amount, check_in_time) in rows {
        let (_, cash_collected, card_amount, total_amount) = if role_type == "driver" {
            compute_driver_shift_earning_totals(conn, &staff_shift_id)?
        } else {
            compute_shift_payment_totals_in_window(
                conn,
                &staff_shift_id,
                role_type,
                Some(check_in_time.as_str()),
                None,
            )?
        };
        let expenses = compute_shift_expenses_total_in_window(
            conn,
            &staff_shift_id,
            Some(check_in_time.as_str()),
            None,
        );
        let net_cash_amount = opening_amount + cash_collected - expenses;
        let display_name = staff_name.clone().unwrap_or_else(|| staff_id.clone());

        result.push(serde_json::json!({
            "shift_id": staff_shift_id,
            "driver_id": staff_id,
            "driver_name": display_name,
            "staff_id": staff_id,
            "staff_name": staff_name,
            "role_type": role_type,
            "starting_amount": opening_amount,
            "check_in_time": check_in_time,
            "cash_collected": cash_collected,
            "card_amount": card_amount,
            "total_amount": total_amount,
            "expenses": expenses,
            "net_cash_amount": net_cash_amount,
        }));
    }

    Ok(result)
}

fn load_cashier_staff_payments(
    conn: &rusqlite::Connection,
    cashier_shift_id: &str,
) -> Result<Vec<Value>, String> {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS staff_payments (
            id TEXT PRIMARY KEY,
            cashier_shift_id TEXT NOT NULL,
            paid_to_staff_id TEXT NOT NULL,
            amount REAL NOT NULL,
            payment_type TEXT NOT NULL DEFAULT 'wage',
            notes TEXT,
            created_at TEXT NOT NULL
        );",
    );

    let mut stmt = conn
        .prepare(
            "SELECT sp.id, sp.paid_to_staff_id, sp.amount, sp.payment_type, sp.notes, sp.created_at,
                    (SELECT ss.staff_name
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1) AS staff_name,
                    (SELECT ss.role_type
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1) AS role_type,
                    (SELECT ss.check_in_time
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1) AS check_in_time,
                    (SELECT ss.check_out_time
                     FROM staff_shifts ss
                     WHERE ss.staff_id = sp.paid_to_staff_id
                     ORDER BY ss.check_in_time DESC
                     LIMIT 1) AS check_out_time
             FROM staff_payments sp
             WHERE sp.cashier_shift_id = ?1
             ORDER BY sp.created_at DESC",
        )
        .map_err(|e| format!("prepare staff payments: {e}"))?;

    let payments = stmt
        .query_map(params![cashier_shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "staff_id": row.get::<_, String>(1)?,
                "staff_name": row.get::<_, Option<String>>(6)?,
                "role_type": row.get::<_, Option<String>>(7)?,
                "amount": row.get::<_, f64>(2)?,
                "payment_type": row.get::<_, String>(3)?,
                "description": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "created_at": row.get::<_, String>(5)?,
                "check_in_time": row.get::<_, Option<String>>(8)?,
                "check_out_time": row.get::<_, Option<String>>(9)?,
            }))
        })
        .map_err(|e| format!("query staff payments: {e}"))?
        .filter_map(|r| r.ok())
        .collect::<Vec<Value>>();

    Ok(payments)
}

fn build_waiter_tables(conn: &rusqlite::Connection, shift_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT o.id, o.order_number, COALESCE(o.table_number, 'Mobile POS') AS table_number,
                    COALESCE(o.total_amount, 0), COALESCE(o.payment_method, 'cash'), o.status,
                    COALESCE((
                        SELECT SUM(op.amount)
                        FROM order_payments op
                        WHERE op.order_id = o.id
                          AND op.status = 'completed'
                          AND op.method = 'cash'
                    ), 0) AS cash_amount,
                    COALESCE((
                        SELECT SUM(op.amount)
                        FROM order_payments op
                        WHERE op.order_id = o.id
                          AND op.status = 'completed'
                          AND op.method = 'card'
                    ), 0) AS card_amount
             FROM orders o
             WHERE o.staff_shift_id = ?1
               AND COALESCE(o.is_ghost, 0) = 0
               AND COALESCE(o.order_type, 'dine-in') != 'delivery'
               AND o.status NOT IN ('cancelled', 'canceled')
             ORDER BY table_number ASC, o.created_at ASC",
        )
        .map_err(|e| format!("prepare waiter tables: {e}"))?;

    #[allow(clippy::type_complexity)]
    let orders: Vec<(
        String,
        Option<String>,
        String,
        f64,
        String,
        String,
        f64,
        f64,
    )> = stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, f64>(3).unwrap_or(0.0),
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, f64>(6).unwrap_or(0.0),
                row.get::<_, f64>(7).unwrap_or(0.0),
            ))
        })
        .map_err(|e| format!("query waiter tables: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tables: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (
        order_id,
        order_number,
        table_number,
        total_amount,
        payment_method,
        status,
        cash_amount,
        card_amount,
    ) in orders
    {
        tables
            .entry(table_number.clone())
            .or_default()
            .push(serde_json::json!({
                "id": order_id,
                "order_id": order_id,
                "order_number": order_number,
                "total_amount": total_amount,
                "payment_method": payment_method,
                "status": status,
                "cash_amount": cash_amount,
                "card_amount": card_amount,
            }));
    }

    let mut result = Vec::new();
    for (table_number, orders) in tables {
        let order_count = orders.len() as i64;
        let total_amount: f64 = orders
            .iter()
            .map(|order| order["total_amount"].as_f64().unwrap_or(0.0))
            .sum();
        let cash_amount: f64 = orders
            .iter()
            .map(|order| order["cash_amount"].as_f64().unwrap_or(0.0))
            .sum();
        let card_amount: f64 = orders
            .iter()
            .map(|order| order["card_amount"].as_f64().unwrap_or(0.0))
            .sum();
        let payment_method = if cash_amount > 0.0 && card_amount > 0.0 {
            "mixed"
        } else if card_amount > 0.0 {
            "card"
        } else {
            "cash"
        };

        result.push(serde_json::json!({
            "table_number": table_number,
            "order_count": order_count,
            "total_amount": total_amount,
            "cash_amount": cash_amount,
            "card_amount": card_amount,
            "payment_method": payment_method,
            "orders": orders,
        }));
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Execute a shift query and return the first row as JSON, or null if not found.
fn query_shift(
    conn: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Value, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let col_names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();

    let result = stmt.query_row(params, |row| {
        let mut obj = serde_json::Map::new();
        for (i, name) in col_names.iter().enumerate() {
            let val = row_value_at(row, i);
            // Keep raw snake_case column names — frontend expects them
            obj.insert(name.clone(), val);
        }
        Ok(Value::Object(obj))
    });

    match result {
        Ok(shift) => Ok(shift),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Value::Null),
        Err(e) => {
            warn!("shift query error: {e}");
            Err(format!("shift query: {e}"))
        }
    }
}

/// Extract a column value from a row using SQLite's actual stored type.
/// Uses `get_ref` to avoid i64/f64 coercion issues where REAL values
/// like 100.0 would be returned as integer 100.
fn row_value_at(row: &rusqlite::Row, idx: usize) -> Value {
    use rusqlite::types::ValueRef;
    match row.get_ref(idx) {
        Ok(ValueRef::Integer(v)) => Value::Number(serde_json::Number::from(v)),
        Ok(ValueRef::Real(v)) => serde_json::json!(v),
        Ok(ValueRef::Text(v)) => Value::String(String::from_utf8_lossy(v).into_owned()),
        Ok(ValueRef::Null) => Value::Null,
        Ok(ValueRef::Blob(_)) => Value::Null,
        Err(_) => Value::Null,
    }
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

fn sanitize_database_uuid(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() || Uuid::parse_str(trimmed).is_err() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn num_field(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::{params, Connection};
    use serde_json::Value;

    const TEST_MANAGER_UUID: &str = "11111111-1111-4111-8111-111111111111";

    fn test_db() -> DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn load_latest_shift_sync_payload(db: &DbState, operation: &str, shift_id: &str) -> Value {
        let conn = db.conn.lock().unwrap();
        let payload: String = conn
            .query_row(
                "SELECT payload
                 FROM sync_queue
                 WHERE entity_type = 'shift'
                   AND operation = ?1
                   AND entity_id = ?2
                 ORDER BY id DESC
                 LIMIT 1",
                params![operation, shift_id],
                |row| row.get(0),
            )
            .expect("shift sync payload should exist");
        serde_json::from_str(&payload).expect("shift sync payload should be valid json")
    }

    #[test]
    fn test_driver_close_returns_cash_to_cashier() {
        let db = test_db();

        // Setup: Create active cashier shift + drawer, then an active driver shift
        {
            let conn = db.conn.lock().unwrap();

            // Cashier shift
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('cashier-shift', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    datetime('now'), 500.0, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Cashier drawer
            conn.execute(
                "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
                    terminal_id, opening_amount, driver_cash_given, opened_at, created_at, updated_at)
                 VALUES ('drawer-1', 'cashier-shift', 'cashier-1', 'branch-1', 'term-1',
                    500.0, 50.0, datetime('now'), datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Driver shift (opening_cash=50, same branch)
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-shift', 'driver-1', 'driver', 'branch-1', 'term-1',
                    datetime('now'), 50.0, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Order (must exist before driver_earnings FK)
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
                 VALUES ('ord-d1', '[]', 30.0, 'completed', 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Driver earnings: cash_collected = 30
            conn.execute(
                "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                    total_earning, payment_method, cash_collected, created_at, updated_at)
                 VALUES ('de-1', 'driver-1', 'driver-shift', 'ord-d1', 'branch-1',
                    30.0, 'cash', 30.0, datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }

        // Close the driver shift (closingCash = 80 => expected = 50 + 30 - 0 = 80, variance = 0)
        let payload = serde_json::json!({
            "shiftId": "driver-shift",
            "closingCash": 80.0,
        });
        let result = close_shift(&db, &payload).unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["expected"], 80.0);
        assert_eq!(result["variance"], 0.0);

        // Verify cashier's drawer was updated with driver_cash_returned = 80.0
        let conn = db.conn.lock().unwrap();
        let returned: f64 = conn
            .query_row(
                "SELECT driver_cash_returned FROM cash_drawer_sessions WHERE id = 'drawer-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            returned, 80.0,
            "driver_cash_returned should be 80.0 (expected return)"
        );
    }

    #[test]
    fn test_close_shift_persists_pending_z_report_context_when_last_shift_closes() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-pending-z', 'cashier-ctx', 'cashier', 'branch-ctx', 'term-ctx',
                    '2026-03-12T08:00:00Z', 250.0, 'active', 2, 'pending', '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-pending-z', 'cashier-pending-z', 'cashier-ctx', 'branch-ctx', 'term-ctx',
                    250.0, '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        let result = close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "cashier-pending-z",
                "closingCash": 250.0,
            }),
        )
        .expect("close shift should succeed");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let stored = db::get_setting(&conn, "system", "pending_z_report_context")
            .expect("pending z-report context should be stored");
        let parsed: serde_json::Value =
            serde_json::from_str(&stored).expect("pending z-report context should be valid json");

        assert_eq!(parsed["branchId"], "branch-ctx");
        assert_eq!(parsed["periodStartAt"], "2026-03-12T08:00:00Z");
        assert!(parsed["reportDate"].as_str().is_some());
        assert!(parsed["cutoffAt"].as_str().is_some());
    }

    #[test]
    fn test_shift_open_sync_payload_includes_actual_check_in_and_cashier_context() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at
                 ) VALUES (
                    'cashier-sync-open', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 200.0, 'active', 2, 'pending',
                    '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, driver_cash_given, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-sync-open', 'cashier-sync-open', 'cashier-1', 'branch-1', 'term-1',
                    200.0, 0.0, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        let result = open_shift(
            &db,
            &serde_json::json!({
                "staffId": "driver-1",
                "staffName": "Driver One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "driver",
                "openingCash": 40.0,
            }),
        )
        .expect("driver shift should open");

        let driver_shift_id = result["shiftId"]
            .as_str()
            .expect("shiftId should be present")
            .to_string();

        let conn = db.conn.lock().unwrap();
        let actual_check_in: String = conn
            .query_row(
                "SELECT check_in_time FROM staff_shifts WHERE id = ?1",
                params![driver_shift_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        let payload = load_latest_shift_sync_payload(&db, "insert", &driver_shift_id);
        assert_eq!(payload["staffId"], "driver-1");
        assert_eq!(payload["staffName"], "Driver One");
        assert_eq!(payload["checkInTime"], actual_check_in);
        assert_eq!(payload["calculationVersion"], 2);
        assert_eq!(payload["responsibleCashierShiftId"], "cashier-sync-open");
        assert_eq!(payload["responsibleCashierDrawerId"], "drawer-sync-open");
        assert_eq!(
            payload["startingAmountSourceCashierShiftId"],
            "cashier-sync-open"
        );
        assert_eq!(payload["borrowedStartingAmount"], 40.0);
    }

    #[test]
    fn test_cashier_close_marks_drawer_reconciled() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-reconcile', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 100.0, 'active', 2, 'pending',
                    '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-reconcile', 'cashier-reconcile', 'cashier-1', 'branch-1', 'term-1',
                    100.0, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        let result = close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "cashier-reconcile",
                "closingCash": 100.0,
                "closedBy": TEST_MANAGER_UUID,
            }),
        )
        .expect("close shift should reconcile drawer");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let (reconciled, reconciled_at, reconciled_by, closed_at): (
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT reconciled, reconciled_at, reconciled_by, closed_at
                 FROM cash_drawer_sessions
                 WHERE id = 'drawer-reconcile'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(reconciled, 1, "closed cashier drawer should be reconciled");
        assert_eq!(reconciled_by.as_deref(), Some(TEST_MANAGER_UUID));
        assert_eq!(
            reconciled_at, closed_at,
            "drawer reconciliation timestamp should match close timestamp"
        );
    }

    #[test]
    fn test_cashier_close_v2_deducts_only_self_staff_payments() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-self-pay', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 100.0, 'active', 2, 'pending',
                    '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, total_staff_payments, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-self-pay', 'cashier-self-pay', 'cashier-1', 'branch-1', 'term-1',
                    100.0, 23.0, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS staff_payments (
                    id TEXT PRIMARY KEY,
                    cashier_shift_id TEXT NOT NULL,
                    paid_to_staff_id TEXT NOT NULL,
                    amount REAL NOT NULL,
                    payment_type TEXT NOT NULL DEFAULT 'wage',
                    notes TEXT,
                    created_at TEXT NOT NULL
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO staff_payments (
                    id, cashier_shift_id, paid_to_staff_id, amount, payment_type, created_at
                 ) VALUES (
                    'self-payment-1', 'cashier-self-pay', 'cashier-1', 15.0, 'wage', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO staff_payments (
                    id, cashier_shift_id, paid_to_staff_id, amount, payment_type, created_at
                 ) VALUES (
                    'other-payment-1', 'cashier-self-pay', 'kitchen-1', 8.0, 'wage', '2026-03-18T09:15:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        let result = close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "cashier-self-pay",
                "closingCash": 85.0,
                "closedBy": TEST_MANAGER_UUID,
            }),
        )
        .expect("cashier close should deduct only cashier self-payments");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let (expected_cash_amount, cash_variance, payment_amount, total_staff_payments): (
            f64,
            f64,
            Option<f64>,
            f64,
        ) = conn
            .query_row(
                "SELECT ss.expected_cash_amount, ss.cash_variance, ss.payment_amount, cds.total_staff_payments
                 FROM staff_shifts ss
                 LEFT JOIN cash_drawer_sessions cds ON cds.staff_shift_id = ss.id
                 WHERE ss.id = 'cashier-self-pay'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert!((expected_cash_amount - 85.0).abs() < f64::EPSILON);
        assert!(cash_variance.abs() < f64::EPSILON);
        assert_eq!(
            payment_amount, None,
            "cashier close should no longer persist a standalone cashier payout"
        );
        assert!((total_staff_payments - 23.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_non_financial_shift_ignores_cash_amounts_on_open_and_close() {
        let db = test_db();

        let open_result = open_shift(
            &db,
            &serde_json::json!({
                "staffId": "kitchen-1",
                "staffName": "Kitchen One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "kitchen",
                "openingCash": 125.0,
            }),
        )
        .expect("open kitchen shift");
        let shift_id = open_result["shiftId"]
            .as_str()
            .expect("kitchen shift id")
            .to_string();

        close_shift(
            &db,
            &serde_json::json!({
                "shiftId": shift_id,
                "closingCash": 88.0,
                "paymentAmount": 20.0,
            }),
        )
        .expect("close kitchen shift");

        let conn = db.conn.lock().unwrap();
        let (opening, closing, expected, variance, payment_amount): (
            f64,
            Option<f64>,
            Option<f64>,
            Option<f64>,
            Option<f64>,
        ) = conn
            .query_row(
                "SELECT opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance, payment_amount
                 FROM staff_shifts
                 WHERE id = ?1",
                params![shift_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("load closed kitchen shift");
        let drawer_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                params![shift_id],
                |row| row.get(0),
            )
            .expect("count drawer rows");

        assert_eq!(opening, 0.0);
        assert_eq!(closing, Some(0.0));
        assert_eq!(expected, Some(0.0));
        assert_eq!(variance, Some(0.0));
        assert_eq!(payment_amount, None);
        assert_eq!(drawer_rows, 0);
    }

    #[test]
    fn test_cashier_close_sync_payload_includes_drawer_snapshot_and_reconciliation() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-sync-close', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T09:00:00Z', 100.0, 'active', 2, 'pending',
                    '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-sync-close', 'cashier-sync-close', 'cashier-1', 'branch-1', 'term-1',
                    100.0, '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "cashier-sync-close",
                "closingCash": 100.0,
                "closedBy": TEST_MANAGER_UUID,
            }),
        )
        .expect("cashier close should succeed");

        let payload = load_latest_shift_sync_payload(&db, "update", "cashier-sync-close");
        let cash_drawer = &payload["cashDrawer"];

        assert_eq!(payload["staffId"], "cashier-1");
        assert_eq!(payload["staffName"], "Cashier One");
        assert_eq!(payload["checkInTime"], "2026-03-18T09:00:00Z");
        assert!(payload["checkOutTime"].as_str().is_some());
        assert_eq!(payload["totalOrdersCount"], 0);
        assert_eq!(payload["totalSalesAmount"], 0.0);
        assert_eq!(payload["totalCashSales"], 0.0);
        assert_eq!(payload["totalCardSales"], 0.0);
        assert_eq!(cash_drawer["id"], "drawer-sync-close");
        assert_eq!(cash_drawer["openingAmount"], 100.0);
        assert_eq!(cash_drawer["closingAmount"], 100.0);
        assert_eq!(cash_drawer["expectedAmount"], 100.0);
        assert_eq!(cash_drawer["varianceAmount"], 0.0);
        assert_eq!(cash_drawer["reconciled"], true);
        assert_eq!(cash_drawer["reconciledBy"], TEST_MANAGER_UUID);
        assert_eq!(cash_drawer["reconciledAt"], cash_drawer["closedAt"]);
    }

    #[test]
    fn test_cashier_close_drops_placeholder_closed_by_from_local_state_and_sync_payload() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-placeholder-close', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T09:00:00Z', 100.0, 'active', 2, 'pending',
                    '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-placeholder-close', 'cashier-placeholder-close', 'cashier-1', 'branch-1', 'term-1',
                    100.0, '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "cashier-placeholder-close",
                "closingCash": 100.0,
                "closedBy": "admin-user",
            }),
        )
        .expect("cashier close should tolerate placeholder closedBy");

        let conn = db.conn.lock().unwrap();
        let (closed_by, reconciled_by): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT ss.closed_by, cds.reconciled_by
                 FROM staff_shifts ss
                 LEFT JOIN cash_drawer_sessions cds ON cds.staff_shift_id = ss.id
                 WHERE ss.id = 'cashier-placeholder-close'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(closed_by, None);
        assert_eq!(reconciled_by, None);
        drop(conn);

        let payload = load_latest_shift_sync_payload(&db, "update", "cashier-placeholder-close");
        assert!(payload["closedBy"].is_null());
        assert!(payload["cashDrawer"]["reconciledBy"].is_null());
    }

    #[test]
    fn test_driver_close_no_cashier_does_not_fail() {
        let db = test_db();

        // Setup: Driver shift with no active cashier
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-solo', 'driver-2', 'driver', 'branch-2', 'term-2',
                    datetime('now'), 50.0, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();
        }

        // Close should succeed even without a cashier
        let payload = serde_json::json!({
            "shiftId": "driver-solo",
            "closingCash": 50.0,
        });
        let result = close_shift(&db, &payload).unwrap();
        assert_eq!(result["success"], true);
    }

    #[test]
    fn test_cashier_close_transfers_active_drivers() {
        // When a cashier closes, active drivers should be marked is_transfer_pending = 1
        // and driver_cash_given should be reduced by their starting amounts.
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();

            // Cashier shift + drawer
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('cashier-1', 'staff-c1', 'cashier', 'b1', 't1',
                    datetime('now'), 500.0, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
                    terminal_id, opening_amount, driver_cash_given, opened_at, created_at, updated_at)
                 VALUES ('cd-1', 'cashier-1', 'staff-c1', 'b1', 't1',
                    500.0, 75.0, datetime('now'), datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Active driver 1 (opening_cash = 50)
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-a', 'staff-d1', 'driver', 'b1', 't1',
                    datetime('now'), 50.0, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Active driver 2 (opening_cash = 25)
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-b', 'staff-d2', 'driver', 'b1', 't1',
                    datetime('now'), 25.0, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();
        }

        // Close the cashier shift
        let payload = serde_json::json!({
            "shiftId": "cashier-1",
            "closingCash": 500.0,
        });
        let result = close_shift(&db, &payload).unwrap();
        assert_eq!(result["success"], true);

        // Verify drivers are marked as transfer pending
        let conn = db.conn.lock().unwrap();
        let pending_a: i32 = conn
            .query_row(
                "SELECT is_transfer_pending FROM staff_shifts WHERE id = 'driver-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_a, 1, "driver-a should be transfer pending");

        let pending_b: i32 = conn
            .query_row(
                "SELECT is_transfer_pending FROM staff_shifts WHERE id = 'driver-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_b, 1, "driver-b should be transfer pending");

        // Verify driver_cash_given was reduced: original 75 - (50 + 25) = 0
        let dcg: f64 = conn
            .query_row(
                "SELECT driver_cash_given FROM cash_drawer_sessions WHERE id = 'cd-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(dcg, 0.0, "driver_cash_given should be 75 - 75 = 0");
    }

    #[test]
    fn test_driver_close_sync_payload_includes_return_target_context() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('cashier-sync-target', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 500.0, 'active', 2, 'pending', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
                    terminal_id, opening_amount, driver_cash_given, opened_at, created_at, updated_at)
                 VALUES ('drawer-sync-target', 'cashier-sync-target', 'cashier-1', 'branch-1', 'term-1',
                    500.0, 50.0, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-sync-target', 'driver-1', 'Driver One', 'driver', 'branch-1', 'term-1',
                    '2026-03-18T09:00:00Z', 50.0, 'active', 2, 'pending', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, status, sync_status, created_at, updated_at)
                 VALUES ('ord-sync-target', '[]', 30.0, 'completed', 'pending', '2026-03-18T09:30:00Z', '2026-03-18T09:30:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                    total_earning, payment_method, cash_collected, created_at, updated_at)
                 VALUES ('de-sync-target', 'driver-1', 'driver-sync-target', 'ord-sync-target', 'branch-1',
                    30.0, 'cash', 30.0, '2026-03-18T09:30:00Z', '2026-03-18T09:30:00Z')",
                [],
            )
            .unwrap();
        }

        close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "driver-sync-target",
                "closingCash": 80.0,
            }),
        )
        .expect("driver close should succeed");

        let payload = load_latest_shift_sync_payload(&db, "update", "driver-sync-target");
        assert_eq!(payload["staffId"], "driver-1");
        assert_eq!(payload["staffName"], "Driver One");
        assert_eq!(
            payload["returnedCashTargetCashierShiftId"],
            "cashier-sync-target"
        );
        assert_eq!(payload["returnedCashTargetDrawerId"], "drawer-sync-target");
        assert_eq!(payload["returnedCashAmount"], 80.0);
        assert_eq!(payload["resolvedCashierShiftId"], "cashier-sync-target");
        assert_eq!(payload["resolvedCashierDrawerId"], "drawer-sync-target");
    }

    #[test]
    fn test_new_cashier_inherits_transferred_drivers() {
        // Full cycle: cashier1 -> driver -> close cashier1 -> cashier2 opens -> driver claimed by cashier2
        let db = test_db();

        // Step 1: Open cashier1 shift
        let c1_payload = serde_json::json!({
            "staffId": "staff-c1",
            "branchId": "b1",
            "terminalId": "t1",
            "roleType": "cashier",
            "openingCash": 500.0,
        });
        let c1_result = open_shift(&db, &c1_payload).unwrap();
        let c1_shift_id = c1_result["shiftId"].as_str().unwrap().to_string();

        // Step 2: Open a driver shift (will deduct from cashier1)
        let d_payload = serde_json::json!({
            "staffId": "staff-d1",
            "branchId": "b1",
            "terminalId": "t1",
            "roleType": "driver",
            "openingCash": 60.0,
        });
        let d_result = open_shift(&db, &d_payload).unwrap();
        let driver_shift_id = d_result["shiftId"].as_str().unwrap().to_string();

        // Verify cashier1's drawer has driver_cash_given = 60
        {
            let conn = db.conn.lock().unwrap();
            let dcg: f64 = conn
                .query_row(
                    "SELECT driver_cash_given FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                    params![c1_shift_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(dcg, 60.0, "cashier1 driver_cash_given should be 60");
        }

        // Step 3: Close cashier1 (driver should be marked transfer pending)
        let close_c1 = serde_json::json!({
            "shiftId": c1_shift_id,
            "closingCash": 440.0,
        });
        close_shift(&db, &close_c1).unwrap();

        // Verify driver is transfer pending
        {
            let conn = db.conn.lock().unwrap();
            let pending: i32 = conn
                .query_row(
                    "SELECT is_transfer_pending FROM staff_shifts WHERE id = ?1",
                    params![driver_shift_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                pending, 1,
                "driver should be transfer pending after cashier1 close"
            );
        }

        // Step 4: Open cashier2 (should inherit the driver)
        let c2_payload = serde_json::json!({
            "staffId": "staff-c2",
            "branchId": "b1",
            "terminalId": "t1",
            "roleType": "cashier",
            "openingCash": 500.0,
        });
        let c2_result = open_shift(&db, &c2_payload).unwrap();
        let c2_shift_id = c2_result["shiftId"].as_str().unwrap().to_string();

        // Verify driver was claimed by cashier2
        let conn = db.conn.lock().unwrap();
        let (transfer_id, pending): (Option<String>, i32) = conn
            .query_row(
                "SELECT transferred_to_cashier_shift_id, is_transfer_pending FROM staff_shifts WHERE id = ?1",
                params![driver_shift_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            transfer_id.as_deref(),
            Some(c2_shift_id.as_str()),
            "driver should be transferred to cashier2"
        );
        assert_eq!(pending, 0, "is_transfer_pending should be cleared");

        // Verify cashier2 does not inherit a new negative float.
        let dcg2: f64 = conn
            .query_row(
                "SELECT driver_cash_given FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                params![c2_shift_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            dcg2, 0.0,
            "cashier2 should not inherit driver_cash_given from the previous cashier"
        );
    }

    #[test]
    fn test_driver_summary_excludes_pickup_orders_from_driver_totals() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let now = "2026-03-05T10:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver One', 'driver', 'branch-1', 'term-1',
                ?1, 20.0, 'active', 2, 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, order_type,
                payment_status, payment_method, staff_shift_id, sync_status, created_at, updated_at
            ) VALUES (
                'order-delivery', '#D1', '[]', 30.0, 'completed', 'delivery',
                'paid', 'cash', 'driver-shift', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, status, order_type,
                payment_status, payment_method, staff_shift_id, sync_status, created_at, updated_at
            ) VALUES (
                'order-pickup', '#P1', '[]', 50.0, 'completed', 'pickup',
                'paid', 'cash', 'driver-shift', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
            ) VALUES (
                'pay-delivery', 'order-delivery', 'cash', 30.0, 'completed', 'driver-shift', 'EUR', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
            ) VALUES (
                'pay-pickup', 'order-pickup', 'cash', 50.0, 'completed', 'driver-shift', 'EUR', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id,
                delivery_fee, tip_amount, total_earning, payment_method,
                cash_collected, card_amount, cash_to_return, settled, created_at, updated_at
            ) VALUES (
                'earning-1', 'driver-1', 'driver-shift', 'order-delivery', 'branch-1',
                0.0, 0.0, 0.0, 'cash',
                30.0, 0.0, 30.0, 0, ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        drop(conn);

        let summary = get_shift_summary(&db, "driver-shift").unwrap();

        assert_eq!(summary["breakdown"]["overall"]["totalAmount"], 30.0);
        assert_eq!(summary["breakdown"]["overall"]["totalCount"], 1);
        assert_eq!(summary["breakdown"]["delivery"]["cashTotal"], 30.0);
        assert_eq!(summary["breakdown"]["instore"]["cashTotal"], 0.0);
        assert_eq!(
            summary["driverDeliveries"]
                .as_array()
                .map(|rows| rows.len())
                .unwrap_or_default(),
            1
        );
    }

    #[test]
    fn test_cashier_summary_excludes_previous_terminal_staff_rows() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let cashier_in = "2026-03-05T10:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'cashier-shift', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                ?1, 100.0, 'active', 2, 'pending', ?1, ?1
            )",
            params![cashier_in],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-1', 'cashier-shift', 'cashier-1', 'branch-1', 'term-1',
                100.0, ?1, ?1, ?1
            )",
            params![cashier_in],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, check_out_time, opening_cash_amount, status, calculation_version,
                sync_status, created_at, updated_at
            ) VALUES (
                'driver-old', 'driver-old', 'Old Driver', 'driver', 'branch-1', 'term-1',
                '2026-03-05T08:00:00Z', '2026-03-05T09:00:00Z', 15.0, 'closed', 2,
                'pending', '2026-03-05T08:00:00Z', '2026-03-05T09:00:00Z'
            )",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'driver-current', 'driver-current', 'Current Driver', 'driver', 'branch-1', 'term-1',
                '2026-03-05T10:30:00Z', 20.0, 'active', 2, 'pending',
                '2026-03-05T10:30:00Z', '2026-03-05T10:30:00Z'
            )",
            [],
        )
        .unwrap();

        for (order_id, shift_id, total_amount, created_at) in [
            ("order-old", "driver-old", 25.0, "2026-03-05T08:30:00Z"),
            (
                "order-current",
                "driver-current",
                40.0,
                "2026-03-05T10:45:00Z",
            ),
        ] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, payment_method, staff_shift_id, sync_status, created_at, updated_at
                ) VALUES (?1, ?1, '[]', ?2, 'completed', 'delivery',
                    'paid', 'cash', ?3, 'pending', ?4, ?4)",
                params![order_id, total_amount, shift_id, created_at],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
                ) VALUES (?1, ?2, 'cash', ?3, 'completed', ?4, 'EUR', ?5, ?5)",
                params![
                    format!("pay-{order_id}"),
                    order_id,
                    total_amount,
                    shift_id,
                    created_at
                ],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO driver_earnings (
                    id, driver_id, staff_shift_id, order_id, branch_id,
                    delivery_fee, tip_amount, total_earning, payment_method,
                    cash_collected, card_amount, cash_to_return, settled, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, 'branch-1',
                    0.0, 0.0, ?5, 'cash',
                    ?5, 0.0, ?5, 0, ?6, ?6
                )",
                params![
                    format!("earning-{order_id}"),
                    shift_id,
                    shift_id,
                    order_id,
                    total_amount,
                    created_at
                ],
            )
            .unwrap();
        }
        drop(conn);

        let summary = get_shift_summary(&db, "cashier-shift").unwrap();
        let rows = summary["driverDeliveries"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        assert_eq!(
            rows.len(),
            1,
            "only current cashier-period staff should appear"
        );
        assert_eq!(rows[0]["driver_name"], "Current Driver");
        assert_eq!(rows[0]["starting_amount"], 20.0);
        assert_eq!(rows[0]["cash_collected"], 40.0);
    }

    #[test]
    fn test_cashier_summary_includes_filtered_cashier_orders() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let cashier_in = "2026-03-05T10:00:00Z";
        let cashier_out = "2026-03-05T11:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, check_out_time, opening_cash_amount, status, calculation_version,
                sync_status, created_at, updated_at
            ) VALUES (
                'cashier-orders', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                ?1, ?2, 100.0, 'closed', 2, 'pending', ?1, ?2
            )",
            params![cashier_in, cashier_out],
        )
        .unwrap();

        for (order_id, order_number, total_amount, payment_method, created_at, is_ghost) in [
            (
                "order-valid",
                "C-101",
                40.0,
                "mixed",
                "2026-03-05T10:30:00Z",
                0,
            ),
            (
                "order-before",
                "C-099",
                15.0,
                "cash",
                "2026-03-05T09:55:00Z",
                0,
            ),
            (
                "order-after",
                "C-102",
                22.0,
                "card",
                "2026-03-05T11:15:00Z",
                0,
            ),
            (
                "order-ghost",
                "C-103",
                18.0,
                "cash",
                "2026-03-05T10:40:00Z",
                1,
            ),
        ] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type, payment_status,
                    payment_method, staff_shift_id, customer_name, table_number, is_ghost,
                    sync_status, created_at, updated_at
                ) VALUES (
                    ?1, ?2, '[]', ?3, 'completed', 'dine-in', 'paid',
                    ?4, 'cashier-orders', 'Alex', 'T1', ?5, 'pending', ?6, ?6
                )",
                params![
                    order_id,
                    order_number,
                    total_amount,
                    payment_method,
                    is_ghost,
                    created_at
                ],
            )
            .unwrap();
        }

        for (payment_id, order_id, method, amount, created_at) in [
            (
                "pay-valid-cash",
                "order-valid",
                "cash",
                30.0,
                "2026-03-05T10:30:00Z",
            ),
            (
                "pay-valid-card",
                "order-valid",
                "card",
                10.0,
                "2026-03-05T10:30:00Z",
            ),
            (
                "pay-before",
                "order-before",
                "cash",
                15.0,
                "2026-03-05T09:55:00Z",
            ),
            (
                "pay-after",
                "order-after",
                "card",
                22.0,
                "2026-03-05T11:15:00Z",
            ),
            (
                "pay-ghost",
                "order-ghost",
                "cash",
                18.0,
                "2026-03-05T10:40:00Z",
            ),
        ] {
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, 'completed', 'cashier-orders', 'EUR', ?5, ?5
                )",
                params![payment_id, order_id, method, amount, created_at],
            )
            .unwrap();
        }
        drop(conn);

        let summary = get_shift_summary(&db, "cashier-orders").unwrap();
        let orders = summary["cashierOrders"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        assert_eq!(
            orders.len(),
            1,
            "only current-window non-ghost orders should appear"
        );
        assert_eq!(orders[0]["order_id"], "order-valid");
        assert_eq!(orders[0]["order_number"], "C-101");
        assert_eq!(orders[0]["payment_method"], "mixed");
        assert_eq!(orders[0]["cash_amount"], 30.0);
        assert_eq!(orders[0]["card_amount"], 10.0);
        assert_eq!(orders[0]["customer_name"], "Alex");
        assert_eq!(orders[0]["table_number"], "T1");
    }

    #[test]
    fn test_cashier_summary_returns_empty_cashier_orders_for_quiet_shift() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let cashier_in = "2026-03-05T10:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'cashier-quiet', 'cashier-quiet', 'Quiet Cashier', 'cashier', 'branch-1', 'term-1',
                ?1, 50.0, 'active', 2, 'pending', ?1, ?1
            )",
            params![cashier_in],
        )
        .unwrap();
        drop(conn);

        let summary = get_shift_summary(&db, "cashier-quiet").unwrap();
        let orders = summary["cashierOrders"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        assert!(
            orders.is_empty(),
            "quiet cashier shifts should expose an empty cashierOrders array"
        );
    }
}
