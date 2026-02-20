//! Shift management for The Small POS.
//!
//! Implements shift open/close lifecycle with cash variance calculation,
//! matching the Electron POS shift-handlers.ts logic. Supports cashier,
//! manager, driver, kitchen, and server roles.
//!
//! Phase 4B scope: open, close, get_active, get_active_by_terminal,
//! get_active_by_terminal_loose, get_active_cashier_by_terminal.

use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::storage;

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
    let opening_cash = num_field(payload, "openingCash")
        .or_else(|| num_field(payload, "opening_cash"))
        .or_else(|| num_field(payload, "startingAmount"))
        .or_else(|| num_field(payload, "starting_amount"))
        .unwrap_or(0.0);

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
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, calculation_version,
                sync_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', 2, 'pending', ?9, ?9)",
            params![
                shift_id,
                staff_id,
                staff_name,
                branch_id,
                terminal_id,
                role_type,
                now,
                opening_cash,
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
            let total_inherited =
                claim_transferred_drivers(&conn, &branch_id, &terminal_id, &shift_id, &now)?;

            if total_inherited > 0.0 {
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                        driver_cash_given = COALESCE(driver_cash_given, 0) + ?1,
                        updated_at = ?2
                     WHERE id = ?3",
                    params![total_inherited, now, drawer_id],
                )
                .map_err(|e| format!("update drawer for inherited drivers: {e}"))?;
                info!(
                    cashier_shift = %shift_id,
                    inherited_driver_cash = %total_inherited,
                    "Inherited transferred driver starting amounts"
                );
            }
        }

        // Driver starting amount: deduct from active cashier's drawer
        if role_type == "driver" && opening_cash > 0.0 {
            let cashier_drawer_id: Option<String> = conn
                .query_row(
                    "SELECT cds.id
                     FROM cash_drawer_sessions cds
                     INNER JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
                     WHERE cds.branch_id = ?1
                       AND cds.terminal_id = ?2
                       AND ss.status = 'active'
                       AND ss.role_type = 'cashier'
                       AND cds.closed_at IS NULL
                     LIMIT 1",
                    params![branch_id, terminal_id],
                    |row| row.get(0),
                )
                .ok();

            match cashier_drawer_id {
                Some(drawer_id) => {
                    conn.execute(
                        "UPDATE cash_drawer_sessions SET
                            driver_cash_given = COALESCE(driver_cash_given, 0) + ?1,
                            updated_at = ?2
                         WHERE id = ?3",
                        params![opening_cash, now, drawer_id],
                    )
                    .map_err(|e| {
                        format!("update cashier drawer for driver starting amount: {e}")
                    })?;
                    info!(
                        driver_shift = %shift_id,
                        cashier_drawer = %drawer_id,
                        amount = %opening_cash,
                        "Driver starting amount deducted from cashier drawer"
                    );
                }
                None => {
                    return Err(
                        "No active cashier found. A cashier must be checked in before drivers can take starting amounts.".to_string()
                    );
                }
            }
        }

        // Enqueue for sync
        let idempotency_key = format!("shift:open:{shift_id}:{}", Utc::now().timestamp_millis());
        let sync_payload = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string());

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

// ---------------------------------------------------------------------------
// Close shift
// ---------------------------------------------------------------------------

/// Close an active shift. Calculates expected cash and variance.
///
/// For cashier/manager: expected = opening + cash_sales - refunds - expenses
///   - drops - driver_cash_given + driver_cash_returned
///     For driver/server: expected = opening + cash_collected - expenses
///
/// Uses calculation_version to decide whether staff_payments are deducted (V1)
/// or informational only (V2).
pub fn close_shift(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .ok_or("Missing shiftId")?;
    let closing_cash = num_field(payload, "closingCash")
        .or_else(|| num_field(payload, "closing_cash"))
        .ok_or("Missing closingCash")?;
    let closed_by = str_field(payload, "closedBy").or_else(|| str_field(payload, "closed_by"));
    let payment_amount =
        num_field(payload, "paymentAmount").or_else(|| num_field(payload, "payment_amount"));

    // Fetch the active shift (include branch_id/terminal_id for driver return + transfer logic)
    let shift = conn
        .query_row(
            "SELECT id, staff_id, role_type, opening_cash_amount, calculation_version,
                    branch_id, terminal_id
             FROM staff_shifts WHERE id = ?1 AND status = 'active'",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<i32>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|_| format!("No active shift found with id {shift_id}"))?;

    let (_id, _staff_id, role_type, opening_cash, calc_version, shift_branch_id, shift_terminal_id) =
        shift;
    let calc_version = calc_version.unwrap_or(1);
    let shift_branch_id = shift_branch_id.unwrap_or_default();
    let shift_terminal_id = shift_terminal_id.unwrap_or_default();

    let now = Utc::now().to_rfc3339();
    let expected: f64;

    if role_type == "cashier" || role_type == "manager" {
        // Transfer active driver shifts to the next cashier BEFORE calculating expected.
        // This marks them as transferred and removes their starting amounts from driverCashGiven
        // so the closing cashier is not held liable for cash given to drivers who haven't returned.
        let transferred_driver_starting_total =
            transfer_active_drivers(&conn, &shift_branch_id, &shift_terminal_id, &shift_id, &now)?;

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
                "SELECT COALESCE(SUM(op.amount), 0)
                 FROM order_payments op
                 JOIN orders o ON o.id = op.order_id
                 WHERE o.staff_shift_id = ?1 AND op.method = 'cash' AND op.status = 'completed'",
                params![shift_id],
                |row| row.get(0),
            )
            .unwrap_or(0.0);
        let reconciled_card_sales: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(op.amount), 0)
                 FROM order_payments op
                 JOIN orders o ON o.id = op.order_id
                 WHERE o.staff_shift_id = ?1 AND op.method = 'card' AND op.status = 'completed'",
                params![shift_id],
                |row| row.get(0),
            )
            .unwrap_or(0.0);
        let reconciled_refunds: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(pa.amount), 0)
                 FROM payment_adjustments pa
                 JOIN orders o ON o.id = pa.order_id
                 WHERE o.staff_shift_id = ?1 AND pa.adjustment_type = 'refund'",
                params![shift_id],
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

        // Write reconciled values to cash_drawer_sessions
        conn.execute(
            "UPDATE cash_drawer_sessions SET
                total_cash_sales = ?1,
                total_card_sales = ?2,
                total_refunds = ?3,
                total_expenses = ?4,
                updated_at = ?5
             WHERE staff_shift_id = ?6",
            params![
                reconciled_cash_sales,
                reconciled_card_sales,
                reconciled_refunds,
                reconciled_expenses,
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

        let (cash_sales, refunds, expenses, drops, driver_given, driver_returned, staff_payments) =
            drawer;

        // Inherited driver expected returns: drivers transferred TO this cashier shift
        // who are still active. Their expected cash return is added to the cashier's expected.
        let inherited_driver_expected_returns =
            compute_inherited_driver_expected_returns(&conn, &shift_id)?;

        if inherited_driver_expected_returns != 0.0 {
            info!(
                shift_id = %shift_id,
                inherited = %inherited_driver_expected_returns,
                "Including inherited driver expected returns in cashier formula"
            );
        }

        // V2: staff_payments are informational, not deducted
        // V1: staff_payments deducted from expected
        expected = if calc_version >= 2 {
            opening_cash + cash_sales - refunds - expenses - drops - driver_given
                + driver_returned
                + inherited_driver_expected_returns
        } else {
            opening_cash + cash_sales - refunds - expenses - drops - driver_given
                + driver_returned
                + inherited_driver_expected_returns
                - staff_payments
        };
    } else {
        // Driver / server / kitchen: expected = opening + cash_collected - expenses
        // For drivers, cash_collected comes from driver_earnings table.
        let cash_collected: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(cash_collected), 0) FROM driver_earnings WHERE staff_shift_id = ?1",
                params![shift_id],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        // Sum expenses for this shift
        let expenses: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(amount), 0) FROM shift_expenses WHERE staff_shift_id = ?1",
                params![shift_id],
                |row| row.get(0),
            )
            .unwrap_or(0.0);

        if calc_version >= 2 {
            expected = opening_cash + cash_collected - expenses;
        } else {
            let pmt = payment_amount.unwrap_or(0.0);
            expected = opening_cash + cash_collected - expenses - pmt;
        }
    }

    let variance = closing_cash - expected;

    // Wrap all writes in a transaction for atomicity
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        // Update cash drawer session (if cashier/manager)
        if role_type == "cashier" || role_type == "manager" {
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                    closing_amount = ?1, expected_amount = ?2,
                    variance_amount = ?3, closed_at = ?4, updated_at = ?4
                 WHERE staff_shift_id = ?5",
                params![closing_cash, expected, variance, now, shift_id,],
            )
            .map_err(|e| format!("update cash drawer: {e}"))?;
        }

        // Driver cash return: update active cashier's drawer with the expected return amount.
        // Uses `expected` (formula-derived) not `closingCash` (self-reported) to match Electron behavior.
        // For V2: also record driver's payment_amount in total_staff_payments (informational only).
        if role_type == "driver" {
            let pmt = payment_amount.unwrap_or(0.0);
            let staff_payment_to_add = if calc_version >= 2 { pmt } else { 0.0 };

            let cashier_drawer_id: Option<String> = conn
                .query_row(
                    "SELECT cds.id
                     FROM cash_drawer_sessions cds
                     INNER JOIN staff_shifts ss ON cds.staff_shift_id = ss.id
                     WHERE cds.branch_id = ?1
                       AND ss.status = 'active'
                       AND (ss.role_type = 'cashier' OR ss.role_type = 'manager')
                       AND cds.closed_at IS NULL
                     LIMIT 1",
                    params![shift_branch_id],
                    |row| row.get(0),
                )
                .ok();

            match cashier_drawer_id {
                Some(drawer_id) => {
                    conn.execute(
                        "UPDATE cash_drawer_sessions SET
                            driver_cash_returned = COALESCE(driver_cash_returned, 0) + ?1,
                            total_staff_payments = COALESCE(total_staff_payments, 0) + ?2,
                            updated_at = ?3
                         WHERE id = ?4",
                        params![expected, staff_payment_to_add, now, drawer_id],
                    )
                    .map_err(|e| format!("update cashier drawer for driver return: {e}"))?;
                    info!(
                        driver_shift = %shift_id,
                        cashier_drawer = %drawer_id,
                        expected_return = %expected,
                        staff_payment = %staff_payment_to_add,
                        "Driver cash return recorded on cashier drawer"
                    );
                }
                None => {
                    warn!(
                        driver_shift = %shift_id,
                        branch_id = %shift_branch_id,
                        "No active cashier found for driver cash return — cash returned physically"
                    );
                }
            }
        }

        // Update the shift record
        conn.execute(
            "UPDATE staff_shifts SET
                check_out_time = ?1, closing_cash_amount = ?2, expected_cash_amount = ?3,
                cash_variance = ?4, status = 'closed', payment_amount = ?5,
                closed_by = ?6, sync_status = 'pending', updated_at = ?1
             WHERE id = ?7",
            params![
                now,
                closing_cash,
                expected,
                variance,
                payment_amount,
                closed_by,
                shift_id,
            ],
        )
        .map_err(|e| format!("close shift: {e}"))?;

        // Enqueue for sync
        let idempotency_key = format!("shift:close:{shift_id}:{}", Utc::now().timestamp_millis());
        let sync_payload = serde_json::json!({
            "shiftId": shift_id,
            "closingCash": closing_cash,
            "expectedCash": expected,
            "variance": variance,
            "closedBy": closed_by,
            "paymentAmount": payment_amount,
        })
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('shift', ?1, 'update', ?2, ?3)",
            params![shift_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue shift close sync: {e}"))?;

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

    info!(shift_id = %shift_id, variance = %variance, "Shift closed");

    Ok(serde_json::json!({
        "success": true,
        "variance": variance,
        "expected": expected,
        "closing": closing_cash,
        "message": format!("Shift closed. Variance: {:.2}", variance)
    }))
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

// ---------------------------------------------------------------------------
// Shift summary
// ---------------------------------------------------------------------------

/// Get a summary of a shift: totals, payment breakdown, expenses, variance.
pub fn get_shift_summary(db: &DbState, shift_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

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

    // --- 3. Sales breakdown by order_type × payment_method ---
    let mut breakdown_stmt = conn
        .prepare(
            "SELECT COALESCE(order_type, 'dine-in'), COALESCE(payment_method, 'cash'),
                    COUNT(*), COALESCE(SUM(total_amount), 0)
             FROM orders
             WHERE staff_shift_id = ?1 AND status NOT IN ('cancelled', 'canceled')
             GROUP BY order_type, payment_method",
        )
        .map_err(|e| format!("prepare breakdown: {e}"))?;

    let rows: Vec<(String, String, i64, f64)> = breakdown_stmt
        .query_map(params![shift_id], |row| {
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

    let sum_by = |f: &dyn Fn(&(String, String, i64, f64)) -> bool| -> f64 {
        rows.iter().filter(|r| f(r)).map(|r| r.3).sum()
    };
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
    let mut canceled_stmt = conn
        .prepare(
            "SELECT COALESCE(payment_method, 'cash'), COUNT(*), COALESCE(SUM(total_amount), 0)
             FROM orders
             WHERE staff_shift_id = ?1 AND status IN ('cancelled', 'canceled', 'refunded')
             GROUP BY payment_method",
        )
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
            "SELECT COALESCE(SUM(total_amount), 0) FROM orders
             WHERE staff_shift_id = ?1 AND status = 'refunded' AND payment_method = 'cash'",
            params![shift_id],
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

    if role_type == "cashier" || role_type == "manager" {
        // For cashier checkout: get closed driver shifts from same terminal/day
        let start_of_day = if let Some(date_part) = check_in_time.get(..10) {
            format!("{date_part}T00:00:00")
        } else {
            check_in_time.clone()
        };
        let end_of_day = if let Some(date_part) = check_in_time.get(..10) {
            format!("{date_part}T23:59:59")
        } else {
            check_in_time.clone()
        };

        let mut drv_stmt = conn
            .prepare(
                "SELECT ds.id, ds.staff_id, ds.staff_name, ds.opening_cash_amount,
                        ds.payment_amount, ds.check_in_time, ds.check_out_time
                 FROM staff_shifts ds
                 WHERE ds.check_in_time >= ?1 AND ds.check_in_time <= ?2
                   AND ds.branch_id = ?3 AND ds.terminal_id = ?4
                   AND ds.role_type = 'driver' AND ds.status = 'closed'
                   AND ds.is_transfer_pending = 0
                   AND ds.transferred_to_cashier_shift_id IS NULL
                 ORDER BY ds.check_in_time ASC",
            )
            .map_err(|e| format!("prepare driver shifts: {e}"))?;

        let drv_shifts: Vec<(String, String, Option<String>, f64, Option<f64>)> = drv_stmt
            .query_map(
                params![start_of_day, end_of_day, branch_id, terminal_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,         // id
                        row.get::<_, String>(1)?,         // staff_id
                        row.get::<_, Option<String>>(2)?, // staff_name
                        row.get::<_, f64>(3)?,            // opening_cash
                        row.get::<_, Option<f64>>(4)?,    // payment_amount
                    ))
                },
            )
            .map_err(|e| format!("query driver shifts: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        for (ds_id, ds_staff_id, ds_name, ds_opening, ds_payment) in &drv_shifts {
            let drv_expenses: f64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(amount), 0) FROM shift_expenses
                     WHERE staff_shift_id = ?1 AND expense_type != 'staff_payment'",
                    params![ds_id],
                    |row| row.get(0),
                )
                .unwrap_or(0.0);

            driver_deliveries.push(serde_json::json!({
                "driver_id": ds_staff_id,
                "driver_name": ds_name.as_deref().unwrap_or(ds_staff_id),
                "starting_amount": ds_opening,
                "driver_payment": ds_payment.unwrap_or(0.0),
                "expenses": drv_expenses,
                "shift_id": ds_id,
                "role": "driver",
            }));
        }

        // Transferred drivers (inherited from previous cashier)
        let mut tr_stmt = conn
            .prepare(
                "SELECT ds.id, ds.staff_id, ds.staff_name, ds.opening_cash_amount, ds.check_in_time
                 FROM staff_shifts ds
                 WHERE ds.transferred_to_cashier_shift_id = ?1
                   AND ds.role_type = 'driver' AND ds.status = 'active'
                 ORDER BY ds.check_in_time ASC",
            )
            .map_err(|e| format!("prepare transferred drivers: {e}"))?;

        transferred_drivers = tr_stmt
            .query_map(params![shift_id], |row| {
                Ok(serde_json::json!({
                    "shift_id": row.get::<_, String>(0)?,
                    "driver_id": row.get::<_, String>(1)?,
                    "driver_name": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    "starting_amount": row.get::<_, f64>(3)?,
                    "check_in_time": row.get::<_, String>(4)?,
                }))
            })
            .map_err(|e| format!("query transferred drivers: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
    } else if role_type == "driver" {
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
        "staffPayments": [],
        "ordersCount": orders_count,
        "salesAmount": sales_amount,
    });

    if !transferred_drivers.is_empty() {
        result["transferredDrivers"] = serde_json::json!(transferred_drivers);
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
        let idempotency_key = format!("expense:{expense_id}:{}", Utc::now().timestamp_millis());
        let sync_payload = serde_json::json!({
            "expenseId": expense_id,
            "shiftId": shift_id,
            "staffId": staff_id,
            "branchId": branch_id,
            "expenseType": expense_type,
            "amount": amount,
            "description": description,
            "receiptNumber": receipt_number,
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
// Driver transfer helpers
// ---------------------------------------------------------------------------

/// Transfer active (non-pending) drivers on this branch/terminal when a cashier closes.
///
/// Marks each driver shift as `is_transfer_pending = 1` and enqueues a sync entry.
/// Returns the sum of their opening_cash_amount (to be subtracted from driver_cash_given).
fn transfer_active_drivers(
    conn: &rusqlite::Connection,
    branch_id: &str,
    terminal_id: &str,
    _closing_cashier_shift_id: &str,
    now: &str,
) -> Result<f64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, opening_cash_amount
             FROM staff_shifts
             WHERE branch_id = ?1
               AND terminal_id = ?2
               AND role_type = 'driver'
               AND status = 'active'
               AND COALESCE(is_transfer_pending, 0) = 0
               AND transferred_to_cashier_shift_id IS NULL",
        )
        .map_err(|e| format!("prepare transfer drivers query: {e}"))?;

    let drivers: Vec<(String, f64)> = stmt
        .query_map(params![branch_id, terminal_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1).unwrap_or(0.0),
            ))
        })
        .map_err(|e| format!("query active drivers: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut total_starting = 0.0;

    for (driver_shift_id, opening_cash) in &drivers {
        // Mark driver as transfer pending
        conn.execute(
            "UPDATE staff_shifts SET
                is_transfer_pending = 1,
                transferred_to_cashier_shift_id = NULL,
                updated_at = ?1
             WHERE id = ?2",
            params![now, driver_shift_id],
        )
        .map_err(|e| format!("mark driver transfer pending: {e}"))?;

        // Mark driver earnings as transferred
        conn.execute(
            "UPDATE driver_earnings SET
                is_transferred = 1,
                updated_at = ?1
             WHERE staff_shift_id = ?2",
            params![now, driver_shift_id],
        )
        .map_err(|e| format!("mark driver earnings transferred: {e}"))?;

        // Enqueue sync for the driver shift
        let idempotency_key = format!(
            "shift:transfer:{driver_shift_id}:{}",
            Utc::now().timestamp_millis()
        );
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
        .map_err(|e| format!("enqueue driver transfer sync: {e}"))?;

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
            "Transferred active driver shifts to next cashier"
        );
    }

    Ok(total_starting)
}

/// Claim transferred drivers (is_transfer_pending = 1) when a new cashier opens.
///
/// Sets `transferred_to_cashier_shift_id` to the new cashier's shift and clears pending flag.
/// Returns the sum of their opening_cash_amount (to be added to new cashier's driver_cash_given).
fn claim_transferred_drivers(
    conn: &rusqlite::Connection,
    branch_id: &str,
    terminal_id: &str,
    new_cashier_shift_id: &str,
    now: &str,
) -> Result<f64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, opening_cash_amount
             FROM staff_shifts
             WHERE branch_id = ?1
               AND terminal_id = ?2
               AND role_type = 'driver'
               AND status = 'active'
               AND is_transfer_pending = 1",
        )
        .map_err(|e| format!("prepare claim transferred drivers query: {e}"))?;

    let drivers: Vec<(String, f64)> = stmt
        .query_map(params![branch_id, terminal_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1).unwrap_or(0.0),
            ))
        })
        .map_err(|e| format!("query transferred drivers: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut total_inherited = 0.0;

    for (driver_shift_id, opening_cash) in &drivers {
        conn.execute(
            "UPDATE staff_shifts SET
                transferred_to_cashier_shift_id = ?1,
                is_transfer_pending = 0,
                updated_at = ?2
             WHERE id = ?3",
            params![new_cashier_shift_id, now, driver_shift_id],
        )
        .map_err(|e| format!("claim transferred driver: {e}"))?;

        // Enqueue sync for the driver shift update
        let idempotency_key = format!(
            "shift:claim:{driver_shift_id}:{}",
            Utc::now().timestamp_millis()
        );
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
        .map_err(|e| format!("enqueue driver claim sync: {e}"))?;

        total_inherited += opening_cash;
        info!(
            driver_shift = %driver_shift_id,
            new_cashier = %new_cashier_shift_id,
            opening_cash = %opening_cash,
            "Transferred driver claimed by new cashier"
        );
    }

    Ok(total_inherited)
}

/// Compute the expected cash returns from drivers inherited by this cashier shift.
///
/// For each active driver with `transferred_to_cashier_shift_id = this_shift`,
/// computes `opening + cash_collected - expenses` and returns the sum.
fn compute_inherited_driver_expected_returns(
    conn: &rusqlite::Connection,
    cashier_shift_id: &str,
) -> Result<f64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT
                ss.id,
                ss.opening_cash_amount,
                ss.payment_amount,
                ss.calculation_version,
                (SELECT COALESCE(SUM(cash_collected), 0) FROM driver_earnings WHERE staff_shift_id = ss.id) AS cash_collected,
                (SELECT COALESCE(SUM(amount), 0) FROM shift_expenses WHERE staff_shift_id = ss.id) AS expenses
             FROM staff_shifts ss
             WHERE ss.transferred_to_cashier_shift_id = ?1
               AND ss.status = 'active'
               AND ss.role_type = 'driver'",
        )
        .map_err(|e| format!("prepare inherited drivers query: {e}"))?;

    let drivers: Vec<(String, f64, f64, i32, f64, f64)> = stmt
        .query_map(params![cashier_shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1).unwrap_or(0.0),
                row.get::<_, f64>(2).unwrap_or(0.0),
                row.get::<_, i32>(3).unwrap_or(1),
                row.get::<_, f64>(4).unwrap_or(0.0),
                row.get::<_, f64>(5).unwrap_or(0.0),
            ))
        })
        .map_err(|e| format!("query inherited drivers: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut total = 0.0;

    for (_id, opening, payment, version, cash_collected, expenses) in &drivers {
        let driver_expected = if *version >= 2 {
            // V2: payment NOT deducted from driver expected return
            opening + cash_collected - expenses
        } else {
            // V1: payment IS deducted from driver expected return
            opening + cash_collected - expenses - payment
        };
        total += driver_expected;
    }

    Ok(total)
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
    use rusqlite::Connection;

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

        // Verify cashier2's drawer has driver_cash_given = 60 (inherited)
        let dcg2: f64 = conn
            .query_row(
                "SELECT driver_cash_given FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                params![c2_shift_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            dcg2, 60.0,
            "cashier2 driver_cash_given should be 60 (inherited)"
        );
    }
}
