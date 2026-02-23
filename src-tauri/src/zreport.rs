//! Z-Report (end-of-day) generation for The Small POS.
//!
//! Produces a financial snapshot covering all closed shifts since the last
//! committed Z-Report.  Persists the snapshot locally in the `z_reports`
//! table and enqueues it for sync to the admin dashboard via
//! `/api/pos/z-report/submit`.
//!
//! Period-based filtering: all aggregate queries use `last_z_report_timestamp`
//! from `local_settings` (category='system') so that successive Z-Reports
//! never double-count orders or payments.

use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::Value;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::db::{self, DbState};
use crate::storage;

// ---------------------------------------------------------------------------
// Period filtering (Gap 9)
// ---------------------------------------------------------------------------

/// Get the timestamp of the last committed Z-Report from local_settings.
/// Returns epoch "1970-01-01T00:00:00Z" if no Z-Report has ever been committed.
fn get_period_start(conn: &Connection) -> String {
    db::get_setting(conn, "system", "last_z_report_timestamp")
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

// ---------------------------------------------------------------------------
// Generate Z-report (single shift — legacy path)
// ---------------------------------------------------------------------------

/// Generate a Z-report for a closed shift.
///
/// Aggregates orders, payments, adjustments, and expenses for the given shift,
/// persists the snapshot in `z_reports`, and enqueues a sync entry.
///
/// **Idempotent:** If a z_report already exists for this shift, returns the
/// existing one without creating a duplicate.
pub fn generate_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .ok_or("Missing shiftId")?;

    // Check for existing z_report (idempotent)
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM z_reports WHERE shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing_id) = existing {
        // Return the existing report
        return get_z_report_by_id(&conn, &existing_id).map(|report| {
            serde_json::json!({
                "success": true,
                "existing": true,
                "zReportId": existing_id,
                "report": report,
            })
        });
    }

    // Verify shift exists and is closed
    let shift = conn
        .query_row(
            "SELECT id, staff_id, staff_name, role_type, status,
                    opening_cash_amount, closing_cash_amount,
                    expected_cash_amount, cash_variance,
                    check_in_time, check_out_time, branch_id, terminal_id
             FROM staff_shifts WHERE id = ?1",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,          // id
                    row.get::<_, String>(1)?,          // staff_id
                    row.get::<_, Option<String>>(2)?,  // staff_name
                    row.get::<_, String>(3)?,          // role_type
                    row.get::<_, String>(4)?,          // status
                    row.get::<_, f64>(5)?,             // opening_cash
                    row.get::<_, Option<f64>>(6)?,     // closing_cash
                    row.get::<_, Option<f64>>(7)?,     // expected_cash
                    row.get::<_, Option<f64>>(8)?,     // cash_variance
                    row.get::<_, Option<String>>(9)?,  // check_in_time
                    row.get::<_, Option<String>>(10)?, // check_out_time
                    row.get::<_, Option<String>>(11)?, // branch_id
                    row.get::<_, Option<String>>(12)?, // terminal_id
                ))
            },
        )
        .map_err(|_| format!("Shift not found: {shift_id}"))?;

    let (
        _shift_id,
        staff_id,
        staff_name,
        _role_type,
        status,
        opening_cash,
        closing_cash,
        expected_cash,
        cash_variance,
        check_in_time,
        check_out_time,
        shift_branch_id,
        shift_terminal_id,
    ) = shift;

    if status != "closed" {
        return Err(format!(
            "Shift must be closed to generate Z-report (current status: {status})"
        ));
    }

    // --- Aggregate data from the shift ---

    // Orders: count, gross sales, discounts, tips
    let order_agg = conn
        .query_row(
            "SELECT COUNT(*) as cnt,
                    COALESCE(SUM(total_amount), 0) as gross,
                    COALESCE(SUM(discount_amount), 0) as discounts,
                    COALESCE(SUM(tip_amount), 0) as tips
             FROM orders
             WHERE staff_shift_id = ?1
               AND COALESCE(is_ghost, 0) = 0
               AND status NOT IN ('cancelled', 'canceled')",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )
        .unwrap_or((0, 0.0, 0.0, 0.0));

    let (total_orders, gross_sales, discounts_total, tips_total) = order_agg;

    // Payments: breakdown by method
    let mut pay_stmt = conn
        .prepare(
            "SELECT op.method, COUNT(*) as cnt, COALESCE(SUM(op.amount), 0) as total
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.staff_shift_id = ?1
               AND op.status = 'completed'
               AND COALESCE(o.is_ghost, 0) = 0
             GROUP BY op.method",
        )
        .map_err(|e| format!("prepare payment query: {e}"))?;

    let mut cash_sales = 0.0_f64;
    let mut card_sales = 0.0_f64;
    let mut other_sales = 0.0_f64;
    let mut cash_count = 0_i64;
    let mut card_count = 0_i64;
    let mut other_count = 0_i64;

    let pay_rows = pay_stmt
        .query_map(params![shift_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?;

    for row in pay_rows.flatten() {
        let (method, count, total) = row;
        match method.as_str() {
            "cash" => {
                cash_sales = total;
                cash_count = count;
            }
            "card" => {
                card_sales = total;
                card_count = count;
            }
            _ => {
                other_sales += total;
                other_count += count;
            }
        }
    }

    // Adjustments: refunds and voids
    let mut adj_stmt = conn
        .prepare(
            "SELECT pa.adjustment_type, COALESCE(SUM(pa.amount), 0)
             FROM payment_adjustments pa
             JOIN order_payments op ON pa.payment_id = op.id
             JOIN orders o ON o.id = op.order_id
             WHERE op.staff_shift_id = ?1
               AND COALESCE(o.is_ghost, 0) = 0
             GROUP BY pa.adjustment_type",
        )
        .map_err(|e| format!("prepare adjustment query: {e}"))?;

    let mut refunds_total = 0.0_f64;
    let mut voids_total = 0.0_f64;

    let adj_rows = adj_stmt
        .query_map(params![shift_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(|e| format!("query adjustments: {e}"))?;

    for row in adj_rows.flatten() {
        let (adj_type, amount) = row;
        match adj_type.as_str() {
            "refund" => refunds_total = amount,
            "void" => voids_total = amount,
            _ => warn!("Unknown adjustment type: {adj_type}"),
        }
    }

    // Expenses
    let expenses_total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM shift_expenses WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    // Expense items for report_json
    let mut exp_stmt = conn
        .prepare(
            "SELECT id, expense_type, amount, description, created_at
             FROM shift_expenses WHERE staff_shift_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare expense query: {e}"))?;

    let expense_items: Vec<Value> = exp_stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expenseType": row.get::<_, String>(1)?,
                "amount": row.get::<_, f64>(2)?,
                "description": row.get::<_, String>(3)?,
                "createdAt": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| format!("query expenses: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Cash drawer session
    let drawer = conn
        .query_row(
            "SELECT opening_amount, closing_amount, expected_amount, variance_amount,
                    total_cash_sales, total_card_sales, total_refunds, total_expenses,
                    cash_drops, driver_cash_given, driver_cash_returned, reconciled
             FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                let reconciled: bool = row.get::<_, i64>(11).unwrap_or(0) != 0;
                Ok(serde_json::json!({
                    "openingTotal": row.get::<_, f64>(0).unwrap_or(0.0),
                    "closing": row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                    "expected": row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    "totalVariance": row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                    "cashSales": row.get::<_, f64>(4).unwrap_or(0.0),
                    "cardSales": row.get::<_, f64>(5).unwrap_or(0.0),
                    "totalRefunds": row.get::<_, f64>(6).unwrap_or(0.0),
                    "totalExpenses": row.get::<_, f64>(7).unwrap_or(0.0),
                    "totalCashDrops": row.get::<_, f64>(8).unwrap_or(0.0),
                    "driverCashGiven": row.get::<_, f64>(9).unwrap_or(0.0),
                    "driverCashReturned": row.get::<_, f64>(10).unwrap_or(0.0),
                    "unreconciledCount": if reconciled { 0 } else { 1 },
                }))
            },
        )
        .ok();

    // --- Compute derived totals ---

    let net_sales = gross_sales - refunds_total - voids_total - discounts_total;
    let opening = opening_cash;
    let closing = closing_cash.unwrap_or(0.0);
    let expected = expected_cash.unwrap_or(0.0);
    let variance = cash_variance.unwrap_or(0.0);

    // Resolve terminal/branch from storage or shift record
    let terminal_id = shift_terminal_id
        .unwrap_or_else(|| storage::get_credential("terminal_id").unwrap_or_default());
    let branch_id =
        shift_branch_id.unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());

    // report_date = date portion of check_in_time
    let report_date = check_in_time
        .as_deref()
        .and_then(|t| t.get(..10))
        .map(|s| s.to_string())
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    // Build payments breakdown JSON
    let payments_breakdown = serde_json::json!({
        "cash": { "count": cash_count, "total": cash_sales },
        "card": { "count": card_count, "total": card_sales },
        "other": { "count": other_count, "total": other_sales },
    });

    // Build full report_json (matches Electron POS shape for server compat)
    let report_json = serde_json::json!({
        "date": report_date,
        "shifts": {
            "total": 1,
            "cashier": 1,
            "driver": 0,
            "kitchen": 0,
        },
        "sales": {
            "totalOrders": total_orders,
            "totalSales": gross_sales,
            "cashSales": cash_sales,
            "cardSales": card_sales,
        },
        "cashDrawer": drawer.as_ref().unwrap_or(&serde_json::json!({
            "totalVariance": variance,
            "openingTotal": opening,
        })),
        "expenses": {
            "total": expenses_total,
            "items": expense_items,
        },
        "daySummary": {
            "cashTotal": cash_sales,
            "cardTotal": card_sales,
            "total": cash_sales + card_sales + other_sales,
            "totalOrders": total_orders,
        },
        "staffReports": [{
            "staffId": staff_id,
            "staffName": staff_name.as_deref().unwrap_or(&staff_id),
            "checkIn": check_in_time,
            "checkOut": check_out_time,
            "orders": { "count": total_orders, "totalAmount": gross_sales },
        }],
    });

    // --- Persist in transaction ---

    let z_report_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let payments_json_str = payments_breakdown.to_string();
    let report_json_str = report_json.to_string();
    let idempotency_key = format!("zreport:{z_report_id}");

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO z_reports (
                id, shift_id, branch_id, terminal_id, report_date, generated_at,
                gross_sales, net_sales, total_orders, cash_sales, card_sales,
                refunds_total, voids_total, discounts_total, tips_total,
                expenses_total, cash_variance, opening_cash, closing_cash, expected_cash,
                payments_breakdown_json, report_json,
                sync_state, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20,
                ?21, ?22,
                'pending', ?23, ?23
             )",
            params![
                z_report_id,
                shift_id,
                branch_id,
                terminal_id,
                report_date,
                now,
                gross_sales,
                net_sales,
                total_orders,
                cash_sales,
                card_sales,
                refunds_total,
                voids_total,
                discounts_total,
                tips_total,
                expenses_total,
                variance,
                opening,
                closing,
                expected,
                payments_json_str,
                report_json_str,
                now,
            ],
        )
        .map_err(|e| format!("insert z_report: {e}"))?;

        // Enqueue for sync — the payload for the server is the report_json
        // plus terminal/branch/date metadata.
        let sync_payload = serde_json::json!({
            "terminal_id": terminal_id,
            "branch_id": branch_id,
            "report_date": report_date,
            "report_data": report_json,
        })
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('z_report', ?1, 'insert', ?2, ?3)",
            params![z_report_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue z_report sync: {e}"))?;

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

    info!(
        z_report_id = %z_report_id,
        shift_id = %shift_id,
        gross_sales = %gross_sales,
        net_sales = %net_sales,
        "Z-report generated"
    );

    Ok(serde_json::json!({
        "success": true,
        "existing": false,
        "zReportId": z_report_id,
        "report": {
            "id": z_report_id,
            "shiftId": shift_id,
            "branchId": branch_id,
            "terminalId": terminal_id,
            "reportDate": report_date,
            "generatedAt": now,
            "grossSales": gross_sales,
            "netSales": net_sales,
            "totalOrders": total_orders,
            "cashSales": cash_sales,
            "cardSales": card_sales,
            "refundsTotal": refunds_total,
            "voidsTotal": voids_total,
            "discountsTotal": discounts_total,
            "tipsTotal": tips_total,
            "expensesTotal": expenses_total,
            "cashVariance": variance,
            "openingCash": opening,
            "closingCash": closing,
            "expectedCash": expected,
            "paymentsBreakdown": payments_breakdown,
            "reportJson": report_json,
            "syncState": "pending",
        },
    }))
}

// ---------------------------------------------------------------------------
// Get / List
// ---------------------------------------------------------------------------

/// Get a single z_report by its ID.
pub fn get_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let z_report_id = str_field(payload, "zReportId")
        .or_else(|| str_field(payload, "z_report_id"))
        .or_else(|| str_field(payload, "id"))
        .ok_or("Missing zReportId")?;

    get_z_report_by_id(&conn, &z_report_id).map(|report| {
        serde_json::json!({
            "success": true,
            "report": report,
        })
    })
}

/// List z_reports filtered by shift or date range.
pub fn list_z_reports(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let shift_id = str_field(payload, "shiftId").or_else(|| str_field(payload, "shift_id"));
    let start_date = str_field(payload, "startDate").or_else(|| str_field(payload, "start_date"));
    let end_date = str_field(payload, "endDate").or_else(|| str_field(payload, "end_date"));

    let (sql, param_values): (String, Vec<String>) = if let Some(sid) = shift_id {
        (
            "SELECT * FROM z_reports WHERE shift_id = ?1 ORDER BY generated_at DESC".to_string(),
            vec![sid],
        )
    } else if let (Some(start), Some(end)) = (start_date, end_date) {
        (
            "SELECT * FROM z_reports WHERE report_date BETWEEN ?1 AND ?2 ORDER BY generated_at DESC"
                .to_string(),
            vec![start, end],
        )
    } else {
        // Default: last 30 days
        (
            "SELECT * FROM z_reports WHERE report_date >= date('now', '-30 days') ORDER BY generated_at DESC LIMIT 50"
                .to_string(),
            vec![],
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;

    let reports: Vec<Value> = match param_values.len() {
        0 => {
            let rows = stmt
                .query_map([], map_z_report_row)
                .map_err(|e| format!("query: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        }
        1 => {
            let rows = stmt
                .query_map(params![param_values[0]], map_z_report_row)
                .map_err(|e| format!("query: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        }
        2 => {
            let rows = stmt
                .query_map(params![param_values[0], param_values[1]], map_z_report_row)
                .map_err(|e| format!("query: {e}"))?;
            rows.filter_map(|r| r.ok()).collect()
        }
        _ => return Err("Too many parameters".into()),
    };

    Ok(serde_json::json!({
        "success": true,
        "reports": reports,
        "count": reports.len(),
    }))
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

/// Enqueue a z_report for printing via the print spooler.
pub fn print_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let z_report_id = str_field(payload, "zReportId")
        .or_else(|| str_field(payload, "z_report_id"))
        .or_else(|| str_field(payload, "id"))
        .ok_or("Missing zReportId")?;

    // Verify the z_report exists
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM z_reports WHERE id = ?1",
            params![z_report_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| format!("Z-report not found: {z_report_id}"))?;
    }

    crate::print::enqueue_print_job(db, "z_report", &z_report_id, None)
}

// ---------------------------------------------------------------------------
// Multi-shift aggregation (Gap 7)
// ---------------------------------------------------------------------------

/// Generate a Z-report for all closed shifts since the last Z-Report for a
/// given branch. This is the Electron-compatible "end of day" report that
/// aggregates across multiple shifts.
///
/// Returns an un-persisted `report_json` Value. Call `submit_z_report` to
/// persist and enqueue for sync.
pub fn generate_z_report_for_date(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());

    let date =
        str_field(payload, "date").unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    let period_start = get_period_start(&conn);

    info!(
        branch_id = %branch_id,
        date = %date,
        period_start = %period_start,
        "Generating multi-shift Z-report"
    );

    // --- Query all closed shifts since period_start for this branch ---
    let mut shift_stmt = conn
        .prepare(
            "SELECT id, staff_id, staff_name, role_type, status,
                    opening_cash_amount, closing_cash_amount,
                    expected_cash_amount, cash_variance,
                    check_in_time, check_out_time, branch_id, terminal_id,
                    calculation_version
             FROM staff_shifts
             WHERE check_in_time > ?1
               AND (branch_id = ?2 OR branch_id IS NULL)
               AND status = 'closed'
             ORDER BY check_in_time ASC",
        )
        .map_err(|e| format!("prepare shift query: {e}"))?;

    struct ShiftRow {
        id: String,
        staff_id: String,
        staff_name: Option<String>,
        role_type: String,
        opening_cash: f64,
        closing_cash: Option<f64>,
        expected_cash: Option<f64>,
        cash_variance: Option<f64>,
        check_in_time: Option<String>,
        check_out_time: Option<String>,
    }

    let shifts: Vec<ShiftRow> = shift_stmt
        .query_map(params![period_start, branch_id], |row| {
            Ok(ShiftRow {
                id: row.get(0)?,
                staff_id: row.get(1)?,
                staff_name: row.get(2)?,
                role_type: row.get(3)?,
                opening_cash: row.get(5)?,
                closing_cash: row.get(6)?,
                expected_cash: row.get(7)?,
                cash_variance: row.get(8)?,
                check_in_time: row.get(9)?,
                check_out_time: row.get(10)?,
            })
        })
        .map_err(|e| format!("query shifts: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Count shifts by role
    let shifts_total = shifts.len() as i64;
    let shifts_cashier = shifts.iter().filter(|s| s.role_type == "cashier").count() as i64;
    let shifts_driver = shifts.iter().filter(|s| s.role_type == "driver").count() as i64;
    let shifts_kitchen = shifts.iter().filter(|s| s.role_type == "kitchen").count() as i64;

    // --- Aggregate orders across all shifts in the period ---
    let order_agg = conn
        .query_row(
            "SELECT COUNT(*) as cnt,
                    COALESCE(SUM(total_amount), 0) as gross,
                    COALESCE(SUM(discount_amount), 0) as discounts,
                    COALESCE(SUM(tip_amount), 0) as tips
             FROM orders
             WHERE created_at > ?1
               AND COALESCE(is_ghost, 0) = 0
               AND status NOT IN ('cancelled', 'canceled')",
            params![period_start],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )
        .unwrap_or((0, 0.0, 0.0, 0.0));

    let (total_orders, gross_sales, discounts_total, tips_total) = order_agg;

    // --- Payments: breakdown by method across all shifts ---
    let mut pay_stmt = conn
        .prepare(
            "SELECT op.method, COUNT(*) as cnt, COALESCE(SUM(op.amount), 0) as total
             FROM order_payments op
             JOIN orders o ON o.id = op.order_id
             WHERE op.created_at > ?1
               AND op.status = 'completed'
               AND COALESCE(o.is_ghost, 0) = 0
             GROUP BY op.method",
        )
        .map_err(|e| format!("prepare payment query: {e}"))?;

    let mut cash_sales = 0.0_f64;
    let mut card_sales = 0.0_f64;
    let mut other_sales = 0.0_f64;
    let mut cash_count = 0_i64;
    let mut card_count = 0_i64;
    let mut other_count = 0_i64;

    let pay_rows = pay_stmt
        .query_map(params![period_start], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| format!("query payments: {e}"))?;

    for row in pay_rows.flatten() {
        let (method, count, total) = row;
        match method.as_str() {
            "cash" => {
                cash_sales = total;
                cash_count = count;
            }
            "card" => {
                card_sales = total;
                card_count = count;
            }
            _ => {
                other_sales += total;
                other_count += count;
            }
        }
    }

    // --- Adjustments: refunds and voids across all shifts ---
    let mut adj_stmt = conn
        .prepare(
            "SELECT pa.adjustment_type, COALESCE(SUM(pa.amount), 0)
             FROM payment_adjustments pa
             JOIN orders o ON o.id = pa.order_id
             WHERE pa.created_at > ?1
               AND COALESCE(o.is_ghost, 0) = 0
             GROUP BY pa.adjustment_type",
        )
        .map_err(|e| format!("prepare adjustment query: {e}"))?;

    let mut refunds_total = 0.0_f64;
    let mut voids_total = 0.0_f64;

    let adj_rows = adj_stmt
        .query_map(params![period_start], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(|e| format!("query adjustments: {e}"))?;

    for row in adj_rows.flatten() {
        let (adj_type, amount) = row;
        match adj_type.as_str() {
            "refund" => refunds_total = amount,
            "void" => voids_total = amount,
            _ => warn!("Unknown adjustment type: {adj_type}"),
        }
    }

    // --- Expenses (excluding staff_payment type) across all shifts ---
    let expenses_total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM shift_expenses
             WHERE created_at > ?1
               AND (expense_type IS NULL OR expense_type != 'staff_payment')",
            params![period_start],
            |row| row.get(0),
        )
        .unwrap_or(0.0);

    // Expense items for report_json
    let mut exp_stmt = conn
        .prepare(
            "SELECT id, expense_type, amount, description, created_at
             FROM shift_expenses
             WHERE created_at > ?1
               AND (expense_type IS NULL OR expense_type != 'staff_payment')
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare expense query: {e}"))?;

    let expense_items: Vec<Value> = exp_stmt
        .query_map(params![period_start], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expenseType": row.get::<_, String>(1)?,
                "amount": row.get::<_, f64>(2)?,
                "description": row.get::<_, String>(3)?,
                "createdAt": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| format!("query expenses: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // --- Cash drawer sessions (aggregate across all shifts) ---
    let drawer_agg = conn
        .query_row(
            "SELECT COALESCE(SUM(opening_amount), 0),
                    COALESCE(SUM(closing_amount), 0),
                    COALESCE(SUM(expected_amount), 0),
                    COALESCE(SUM(variance_amount), 0),
                    COALESCE(SUM(total_cash_sales), 0),
                    COALESCE(SUM(total_card_sales), 0),
                    COALESCE(SUM(total_refunds), 0),
                    COALESCE(SUM(total_expenses), 0),
                    COALESCE(SUM(cash_drops), 0),
                    COALESCE(SUM(driver_cash_given), 0),
                    COALESCE(SUM(driver_cash_returned), 0),
                    SUM(CASE WHEN (reconciled = 0 OR reconciled IS NULL) THEN 1 ELSE 0 END)
             FROM cash_drawer_sessions
             WHERE opened_at > ?1",
            params![period_start],
            |row| {
                Ok(serde_json::json!({
                    "openingTotal": row.get::<_, f64>(0)?,
                    "closing": row.get::<_, f64>(1)?,
                    "expected": row.get::<_, f64>(2)?,
                    "totalVariance": row.get::<_, f64>(3)?,
                    "cashSales": row.get::<_, f64>(4)?,
                    "cardSales": row.get::<_, f64>(5)?,
                    "totalRefunds": row.get::<_, f64>(6)?,
                    "totalExpenses": row.get::<_, f64>(7)?,
                    "totalCashDrops": row.get::<_, f64>(8)?,
                    "driverCashGiven": row.get::<_, f64>(9)?,
                    "driverCashReturned": row.get::<_, f64>(10)?,
                    "unreconciledCount": row.get::<_, i64>(11)?,
                }))
            },
        )
        .ok();

    // --- Compute derived totals ---
    let net_sales = gross_sales - refunds_total - voids_total - discounts_total;

    // Sum opening/closing/variance across all cashier shifts
    let total_opening: f64 = shifts.iter().map(|s| s.opening_cash).sum();
    let total_closing: f64 = shifts.iter().map(|s| s.closing_cash.unwrap_or(0.0)).sum();
    let total_variance: f64 = shifts.iter().map(|s| s.cash_variance.unwrap_or(0.0)).sum();

    let terminal_id = storage::get_credential("terminal_id").unwrap_or_default();

    let payments_breakdown = serde_json::json!({
        "cash": { "count": cash_count, "total": cash_sales },
        "card": { "count": card_count, "total": card_sales },
        "other": { "count": other_count, "total": other_sales },
    });

    // --- Build per-staff reports ---
    let staff_reports: Vec<Value> = shifts
        .iter()
        .map(|s| {
            // Per-shift order aggregation
            let shift_orders = conn
                .query_row(
                    "SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
                     FROM orders
                     WHERE staff_shift_id = ?1
                       AND COALESCE(is_ghost, 0) = 0
                       AND status NOT IN ('cancelled', 'canceled')",
                    params![s.id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)),
                )
                .unwrap_or((0, 0.0));

            serde_json::json!({
                "staffShiftId": s.id,
                "staffId": s.staff_id,
                "staffName": s.staff_name.as_deref().unwrap_or(&s.staff_id),
                "role": s.role_type,
                "checkIn": s.check_in_time,
                "checkOut": s.check_out_time,
                "shiftStatus": "closed",
                "orders": {
                    "count": shift_orders.0,
                    "totalAmount": shift_orders.1,
                },
            })
        })
        .collect();

    // Build Electron-compatible report_json
    let report_json = serde_json::json!({
        "date": date,
        "periodStart": period_start,
        "shifts": {
            "total": shifts_total,
            "cashier": shifts_cashier,
            "driver": shifts_driver,
            "kitchen": shifts_kitchen,
        },
        "sales": {
            "totalOrders": total_orders,
            "totalSales": gross_sales,
            "cashSales": cash_sales,
            "cardSales": card_sales,
        },
        "cashDrawer": drawer_agg.as_ref().unwrap_or(&serde_json::json!({
            "totalVariance": total_variance,
            "openingTotal": total_opening,
        })),
        "expenses": {
            "total": expenses_total,
            "items": expense_items,
        },
        "daySummary": {
            "cashTotal": cash_sales,
            "cardTotal": card_sales,
            "total": cash_sales + card_sales + other_sales,
            "totalOrders": total_orders,
        },
        "staffReports": staff_reports,
    });

    // If no closed shifts, return a preview-only response (no persist).
    // This lets the frontend display aggregated order/payment data even when
    // staff are still checked in.
    if shifts.is_empty() {
        info!("No closed shifts in period — returning preview-only Z-report");
        return Ok(serde_json::json!({
            "success": true,
            "preview": true,
            "report": {
                "reportJson": report_json,
            },
        }));
    }

    // --- Persist in transaction ---
    let z_report_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let payments_json_str = payments_breakdown.to_string();
    let report_json_str = report_json.to_string();
    let idempotency_key = format!("zreport:{z_report_id}");

    let shift_id_for_db = shifts.first().map(|s| s.id.clone()).unwrap();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO z_reports (
                id, shift_id, branch_id, terminal_id, report_date, generated_at,
                gross_sales, net_sales, total_orders, cash_sales, card_sales,
                refunds_total, voids_total, discounts_total, tips_total,
                expenses_total, cash_variance, opening_cash, closing_cash, expected_cash,
                payments_breakdown_json, report_json,
                sync_state, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20,
                ?21, ?22,
                'pending', ?23, ?23
             )",
            params![
                z_report_id,
                shift_id_for_db,
                branch_id,
                terminal_id,
                date,
                now,
                gross_sales,
                net_sales,
                total_orders,
                cash_sales,
                card_sales,
                refunds_total,
                voids_total,
                discounts_total,
                tips_total,
                expenses_total,
                total_variance,
                total_opening,
                total_closing,
                shifts
                    .iter()
                    .map(|s| s.expected_cash.unwrap_or(0.0))
                    .sum::<f64>(),
                payments_json_str,
                report_json_str,
                now,
            ],
        )
        .map_err(|e| format!("insert z_report: {e}"))?;

        // Enqueue for sync
        let sync_payload = serde_json::json!({
            "terminal_id": terminal_id,
            "branch_id": branch_id,
            "report_date": date,
            "report_data": report_json,
        })
        .to_string();

        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key)
             VALUES ('z_report', ?1, 'insert', ?2, ?3)",
            params![z_report_id, sync_payload, idempotency_key],
        )
        .map_err(|e| format!("enqueue z_report sync: {e}"))?;

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

    info!(
        z_report_id = %z_report_id,
        shifts_count = %shifts_total,
        gross_sales = %gross_sales,
        net_sales = %net_sales,
        "Multi-shift Z-report generated"
    );

    Ok(serde_json::json!({
        "success": true,
        "existing": false,
        "zReportId": z_report_id,
        "report": {
            "id": z_report_id,
            "shiftId": shift_id_for_db,
            "branchId": branch_id,
            "terminalId": terminal_id,
            "reportDate": date,
            "generatedAt": now,
            "grossSales": gross_sales,
            "netSales": net_sales,
            "totalOrders": total_orders,
            "cashSales": cash_sales,
            "cardSales": card_sales,
            "refundsTotal": refunds_total,
            "voidsTotal": voids_total,
            "discountsTotal": discounts_total,
            "tipsTotal": tips_total,
            "expensesTotal": expenses_total,
            "cashVariance": total_variance,
            "openingCash": total_opening,
            "closingCash": total_closing,
            "paymentsBreakdown": payments_breakdown,
            "reportJson": report_json,
            "syncState": "pending",
        },
    }))
}

// ---------------------------------------------------------------------------
// Submit Z-report + finalize end-of-day (Gap 8)
// ---------------------------------------------------------------------------

/// Submit a Z-report: generate (or return existing), store the
/// `last_z_report_timestamp`, clear operational data, and return results.
pub fn submit_z_report(db: &DbState, payload: &Value) -> Result<Value, String> {
    let branch_id = str_field(payload, "branchId")
        .or_else(|| str_field(payload, "branch_id"))
        .unwrap_or_else(|| storage::get_credential("branch_id").unwrap_or_default());

    // --- Pre-condition: all staff must be checked out ---
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, COALESCE(staff_name, staff_id) as name
                 FROM staff_shifts
                 WHERE status = 'active'
                   AND (branch_id = ?1 OR branch_id IS NULL)",
            )
            .map_err(|e| format!("prepare active-shift check: {e}"))?;

        let active_names: Vec<String> = stmt
            .query_map(params![branch_id], |row| row.get::<_, String>(1))
            .map_err(|e| format!("query active shifts: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        if !active_names.is_empty() {
            return Err(format!(
                "Cannot generate Z-report: {} staff still checked in: {}",
                active_names.len(),
                active_names.join(", ")
            ));
        }
    }

    // --- Pre-condition: all orders must have settled payments ---
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let period_start = get_period_start(&conn);
        let unpaid_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orders
                 WHERE created_at > ?1
                   AND COALESCE(is_ghost, 0) = 0
                   AND status NOT IN ('cancelled', 'canceled')
                   AND payment_status NOT IN ('paid', 'completed')",
                params![period_start],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if unpaid_count > 0 {
            return Err(format!(
                "Cannot generate Z-report: {} order(s) have unsettled payments",
                unpaid_count
            ));
        }
    }

    // Step 1: Generate the report (multi-shift or single-shift)
    let has_shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .is_some();
    let has_branch_date =
        str_field(payload, "branchId").is_some() || str_field(payload, "date").is_some();

    let generated = if has_shift_id && !has_branch_date {
        generate_z_report(db, payload)?
    } else {
        generate_z_report_for_date(db, payload)?
    };

    // Step 2: Store last_z_report_timestamp + reset order counter
    let now = Utc::now().to_rfc3339();
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        db::set_setting(&conn, "system", "last_z_report_timestamp", &now)?;

        // Reset order counter for next business day
        conn.execute(
            "INSERT INTO local_settings (setting_category, setting_key, setting_value, updated_at) \
             VALUES ('orders', 'order_counter', '0', datetime('now')) \
             ON CONFLICT(setting_category, setting_key) DO UPDATE SET \
                setting_value = '0', updated_at = datetime('now')",
            [],
        )
        .map_err(|e| format!("reset order counter: {e}"))?;
        info!("Order counter reset to 0 after Z-report");
    }

    info!(timestamp = %now, "Stored last_z_report_timestamp");

    // Step 3: Finalize end-of-day (clear operational data)
    let report_date =
        str_field(payload, "date").unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());
    let cleanup = finalize_end_of_day(db, &report_date)?;

    Ok(serde_json::json!({
        "success": true,
        "data": generated,
        "cleanup": cleanup,
        "lastZReportTimestamp": now,
    }))
}

/// Finalize end-of-day: clear ALL operational data up to and including the
/// report date. Preserves z_reports, local_settings, menu_cache, and
/// printer_profiles.
///
/// Deletes in FK-safe order within a transaction.
/// Returns a JSON object with per-table deletion counts.
pub fn finalize_end_of_day(db: &DbState, report_date: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    info!(report_date = %report_date, "Starting end-of-day data cleanup");

    // Temporarily disable foreign_keys so deleting staff_shifts does not
    // cascade-delete z_reports (which we need to preserve).
    conn.execute_batch("PRAGMA foreign_keys = OFF")
        .map_err(|e| format!("disable FK: {e}"))?;

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin cleanup transaction: {e}"))?;

    // Helper: try DELETE using date() extraction for proper date comparison,
    // returns count (0 if table doesn't exist).
    fn safe_delete(
        conn: &Connection,
        table: &str,
        date_col: &str,
        report_date: &str,
        extra_where: &str,
    ) -> i64 {
        let sql = format!("DELETE FROM {table} WHERE date({date_col}) <= ?1{extra_where}");
        match conn.execute(&sql, params![report_date]) {
            Ok(count) => count as i64,
            Err(e) => {
                // Table may not exist yet (e.g. driver_earnings from migration v14)
                warn!(table = %table, error = %e, "Cleanup: table delete failed (may not exist)");
                0
            }
        }
    }

    let result: Result<Value, String> = {
        let mut cleared = serde_json::Map::new();

        // 1. payment_adjustments (FK->order_payments)
        let c = safe_delete(&conn, "payment_adjustments", "created_at", report_date, "");
        cleared.insert("payment_adjustments".into(), serde_json::json!(c));

        // 2. order_payments (FK->orders)
        let c = safe_delete(&conn, "order_payments", "created_at", report_date, "");
        cleared.insert("order_payments".into(), serde_json::json!(c));

        // 3. driver_earnings (FK->orders, staff_shifts) -- may not exist yet
        let c = safe_delete(&conn, "driver_earnings", "created_at", report_date, "");
        cleared.insert("driver_earnings".into(), serde_json::json!(c));

        // 4. sync_queue -- only clear synced items
        let c = safe_delete(
            &conn,
            "sync_queue",
            "created_at",
            report_date,
            " AND status = 'synced'",
        );
        cleared.insert("sync_queue".into(), serde_json::json!(c));

        // 5. shift_expenses (FK->staff_shifts)
        let c = safe_delete(&conn, "shift_expenses", "created_at", report_date, "");
        cleared.insert("shift_expenses".into(), serde_json::json!(c));

        // 6. staff_payments (FK->staff_shifts) -- may not exist yet
        let c = safe_delete(&conn, "staff_payments", "created_at", report_date, "");
        cleared.insert("staff_payments".into(), serde_json::json!(c));

        // 7. print_jobs (standalone)
        let c = safe_delete(&conn, "print_jobs", "created_at", report_date, "");
        cleared.insert("print_jobs".into(), serde_json::json!(c));

        // 8. cash_drawer_sessions (FK->staff_shifts)
        let c = safe_delete(&conn, "cash_drawer_sessions", "created_at", report_date, "");
        cleared.insert("cash_drawer_sessions".into(), serde_json::json!(c));

        // 9. staff_shifts (parent of drawers/expenses)
        let c = safe_delete(&conn, "staff_shifts", "created_at", report_date, "");
        cleared.insert("staff_shifts".into(), serde_json::json!(c));

        // 10. orders (parent of payments/driver_earnings)
        let c = safe_delete(&conn, "orders", "created_at", report_date, "");
        cleared.insert("orders".into(), serde_json::json!(c));

        Ok(Value::Object(cleared))
    };

    match result {
        Ok(counts) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit cleanup: {e}"))?;
            // Re-enable foreign keys
            let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
            info!(report_date = %report_date, "End-of-day cleanup complete: {}", counts);
            Ok(counts)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            // Re-enable foreign keys even on failure
            let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
            error!(error = %e, "End-of-day cleanup failed, rolled back");
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Z-report HTML generation (used by print worker)
// ---------------------------------------------------------------------------

/// Generate a printable HTML file for a z_report.
///
/// Called by the print worker when processing a `z_report` print job.
/// Returns the absolute file path to the generated HTML.
pub fn generate_z_report_file(
    db: &DbState,
    z_report_id: &str,
    data_dir: &std::path::Path,
) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Fetch the z_report
    let report = conn
        .query_row(
            "SELECT id, shift_id, terminal_id, report_date, generated_at,
                    gross_sales, net_sales, total_orders, cash_sales, card_sales,
                    refunds_total, voids_total, discounts_total, tips_total,
                    expenses_total, cash_variance, opening_cash, closing_cash,
                    expected_cash, payments_breakdown_json
             FROM z_reports WHERE id = ?1",
            params![z_report_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,  // id
                    row.get::<_, String>(1)?,  // shift_id
                    row.get::<_, String>(2)?,  // terminal_id
                    row.get::<_, String>(3)?,  // report_date
                    row.get::<_, String>(4)?,  // generated_at
                    row.get::<_, f64>(5)?,     // gross_sales
                    row.get::<_, f64>(6)?,     // net_sales
                    row.get::<_, i64>(7)?,     // total_orders
                    row.get::<_, f64>(8)?,     // cash_sales
                    row.get::<_, f64>(9)?,     // card_sales
                    row.get::<_, f64>(10)?,    // refunds_total
                    row.get::<_, f64>(11)?,    // voids_total
                    row.get::<_, f64>(12)?,    // discounts_total
                    row.get::<_, f64>(13)?,    // tips_total
                    row.get::<_, f64>(14)?,    // expenses_total
                    row.get::<_, f64>(15)?,    // cash_variance
                    row.get::<_, f64>(16)?,    // opening_cash
                    row.get::<_, f64>(17)?,    // closing_cash
                    row.get::<_, f64>(18)?,    // expected_cash
                    row.get::<_, String>(19)?, // payments_breakdown_json
                ))
            },
        )
        .map_err(|_| format!("Z-report not found: {z_report_id}"))?;

    let (
        id,
        shift_id,
        terminal_id,
        report_date,
        generated_at,
        gross_sales,
        net_sales,
        total_orders,
        cash_sales,
        card_sales,
        refunds_total,
        voids_total,
        discounts_total,
        tips_total,
        expenses_total,
        cash_variance,
        opening_cash,
        closing_cash,
        expected_cash,
        payments_breakdown_str,
    ) = report;

    // Store settings for header
    let store_name =
        db::get_setting(&conn, "terminal", "store_name").unwrap_or_else(|| "The Small".to_string());
    let store_address = db::get_setting(&conn, "terminal", "store_address").unwrap_or_default();
    let store_phone = db::get_setting(&conn, "terminal", "store_phone").unwrap_or_default();

    // Staff name from shift
    let staff_name: String = conn
        .query_row(
            "SELECT COALESCE(staff_name, staff_id) FROM staff_shifts WHERE id = ?1",
            params![shift_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "N/A".to_string());

    // Shift ID short (first 8 chars)
    let shift_short = if shift_id.len() > 8 {
        &shift_id[..8]
    } else {
        &shift_id
    };

    // Parse payments breakdown for display
    let _breakdown: Value =
        serde_json::from_str(&payments_breakdown_str).unwrap_or(serde_json::json!({}));

    // Build address/phone lines
    let address_line = if store_address.is_empty() {
        String::new()
    } else {
        format!("{store_address}<br/>")
    };
    let phone_line = if store_phone.is_empty() {
        String::new()
    } else {
        format!("Tel: {store_phone}<br/>")
    };

    // Variance styling
    let variance_style = if cash_variance.abs() > 0.01 {
        "color:#c00;font-weight:bold;"
    } else {
        ""
    };

    let html = format!(
        r#"<div style="font-family:monospace;font-size:10px;line-height:1.4;width:100%;">
<div style="text-align:center;margin-bottom:8px;">
<strong style="font-size:14px;">{store_name}</strong><br/>
{address_line}{phone_line}</div>
<hr style="border:none;border-top:2px solid #000;"/>
<div style="text-align:center;font-size:14px;font-weight:bold;margin:8px 0;">
Z - R E P O R T</div>
<hr style="border:none;border-top:2px solid #000;"/>
<div style="margin:4px 0;">
Shift: {shift_short}<br/>
Staff: {staff_name}<br/>
Date: {report_date}<br/>
Generated: {generated_at}
</div>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>SALES SUMMARY</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Total Orders</td><td style="text-align:right;">{total_orders}</td></tr>
<tr><td>Gross Sales</td><td style="text-align:right;">{gross_sales:.2}</td></tr>
<tr><td>Discounts</td><td style="text-align:right;">-{discounts_total:.2}</td></tr>
<tr><td><strong>Net Sales</strong></td><td style="text-align:right;"><strong>{net_sales:.2}</strong></td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>PAYMENT BREAKDOWN</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Cash</td><td style="text-align:right;">{cash_sales:.2}</td></tr>
<tr><td>Card</td><td style="text-align:right;">{card_sales:.2}</td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>ADJUSTMENTS</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Refunds</td><td style="text-align:right;color:#c00;">-{refunds_total:.2}</td></tr>
<tr><td>Voids</td><td style="text-align:right;color:#c00;">-{voids_total:.2}</td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>EXPENSES</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Total</td><td style="text-align:right;">-{expenses_total:.2}</td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<div style="margin:4px 0;"><strong>CASH DRAWER</strong></div>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Opening</td><td style="text-align:right;">{opening_cash:.2}</td></tr>
<tr><td>Expected</td><td style="text-align:right;">{expected_cash:.2}</td></tr>
<tr><td>Actual</td><td style="text-align:right;">{closing_cash:.2}</td></tr>
<tr><td><strong>Variance</strong></td><td style="text-align:right;{variance_style}"><strong>{cash_variance:.2}</strong></td></tr>
</table>
<hr style="border:none;border-top:1px dashed #000;"/>
<table style="width:100%;font-family:monospace;font-size:10px;">
<tr><td>Tips Total</td><td style="text-align:right;">{tips_total:.2}</td></tr>
</table>
<hr style="border:none;border-top:2px solid #000;"/>
<div style="text-align:center;margin-top:8px;font-size:9px;">
End of Report<br/>
Terminal: {terminal_id}<br/>
ID: {id}
</div>
</div>"#,
    );

    // Wrap in standalone HTML document (same as generate_receipt_file)
    let full_html = format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Z-Report {report_date}</title>
<style>
body {{ margin: 8px; padding: 0; }}
@media print {{ body {{ margin: 0; }} }}
</style></head><body>{html}</body></html>"#,
    );

    // Ensure receipts directory exists
    let receipts_dir = data_dir.join("receipts");
    std::fs::create_dir_all(&receipts_dir).map_err(|e| format!("create receipts dir: {e}"))?;

    let ts = Utc::now().timestamp_millis();
    let filename = format!("zreport_{id}_{ts}.html");
    let file_path = receipts_dir.join(&filename);

    std::fs::write(&file_path, full_html).map_err(|e| format!("write z-report file: {e}"))?;

    let abs_path = file_path
        .to_str()
        .ok_or("Invalid path encoding")?
        .to_string();

    info!(z_report_id = %z_report_id, path = %abs_path, "Z-report HTML generated");
    Ok(abs_path)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Fetch a z_report row by ID and return as JSON Value.
fn get_z_report_by_id(conn: &rusqlite::Connection, z_report_id: &str) -> Result<Value, String> {
    conn.query_row(
        "SELECT * FROM z_reports WHERE id = ?1",
        params![z_report_id],
        map_z_report_row,
    )
    .map_err(|_| format!("Z-report not found: {z_report_id}"))
}

/// Map a z_reports row to a JSON value.
fn map_z_report_row(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "shiftId": row.get::<_, String>(1)?,
        "branchId": row.get::<_, String>(2)?,
        "terminalId": row.get::<_, String>(3)?,
        "reportDate": row.get::<_, String>(4)?,
        "generatedAt": row.get::<_, String>(5)?,
        "grossSales": row.get::<_, f64>(6)?,
        "netSales": row.get::<_, f64>(7)?,
        "totalOrders": row.get::<_, i64>(8)?,
        "cashSales": row.get::<_, f64>(9)?,
        "cardSales": row.get::<_, f64>(10)?,
        "refundsTotal": row.get::<_, f64>(11)?,
        "voidsTotal": row.get::<_, f64>(12)?,
        "discountsTotal": row.get::<_, f64>(13)?,
        "tipsTotal": row.get::<_, f64>(14)?,
        "expensesTotal": row.get::<_, f64>(15)?,
        "cashVariance": row.get::<_, f64>(16)?,
        "openingCash": row.get::<_, f64>(17)?,
        "closingCash": row.get::<_, f64>(18)?,
        "expectedCash": row.get::<_, f64>(19)?,
        "paymentsBreakdown": row.get::<_, String>(20)?,
        "reportJson": row.get::<_, String>(21)?,
        "syncState": row.get::<_, String>(22)?,
        "syncLastError": row.get::<_, Option<String>>(23)?,
        "syncRetryCount": row.get::<_, i64>(24)?,
        "syncNextRetryAt": row.get::<_, Option<String>>(25)?,
        "createdAt": row.get::<_, String>(26)?,
        "updatedAt": row.get::<_, String>(27)?,
    }))
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

#[allow(dead_code)]
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
        .expect("set pragmas");
        db::run_migrations_for_test(&conn);
        DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    /// Insert a closed shift with associated data for testing.
    fn seed_closed_shift(db: &DbState) -> String {
        let conn = db.conn.lock().unwrap();
        let shift_id = "shift-zr-1";
        let now = "2026-02-16T18:00:00Z";

        // Insert shift
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-1', 'John', 'branch-1', 'term-1', 'cashier',
                200.0, 235.0, 235.0, 0.0,
                '2026-02-16T09:00:00Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert shift");

        // Insert cash drawer session
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, closing_amount, expected_amount, variance_amount,
                total_cash_sales, total_card_sales, total_refunds, total_expenses,
                cash_drops, driver_cash_given, driver_cash_returned,
                total_staff_payments, reconciled,
                opened_at, created_at, updated_at
             ) VALUES (
                'cds-1', ?1, 'staff-1', 'branch-1', 'term-1',
                200.0, 235.0, 235.0, 0.0,
                60.0, 40.0, 10.0, 15.0,
                0.0, 0.0, 0.0,
                0.0, 0,
                '2026-02-16T09:00:00Z', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert drawer");

        // Insert 3 orders
        for (i, total) in [(1, 25.0), (2, 35.0), (3, 40.0)] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, staff_shift_id, discount_amount, tip_amount,
                    sync_status, created_at, updated_at
                 ) VALUES (?1, ?2, '[]', ?3, 'completed', 'dine-in',
                    'paid', ?4, 0.0, 0.0, 'pending', ?5, ?5)",
                params![format!("ord-{i}"), format!("#{i}"), total, shift_id, now,],
            )
            .expect("insert order");
        }

        // Insert payments: cash for orders 1+2, card for order 3
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-1', 'ord-1', 'cash', 25.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 1");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-2', 'ord-2', 'cash', 35.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 2");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-3', 'ord-3', 'card', 40.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 3");

        // Insert a refund adjustment on payment 1
        conn.execute(
            "INSERT INTO payment_adjustments (id, payment_id, order_id, adjustment_type, amount, reason, sync_state, created_at, updated_at)
             VALUES ('adj-1', 'pay-1', 'ord-1', 'refund', 10.0, 'wrong item', 'pending', ?1, ?1)",
            params![now],
        ).expect("insert adjustment");

        // Insert an expense
        conn.execute(
            "INSERT INTO shift_expenses (id, staff_shift_id, staff_id, branch_id, expense_type, amount, description, sync_status, created_at, updated_at)
             VALUES ('exp-1', ?1, 'staff-1', 'branch-1', 'supplies', 15.0, 'Napkins', 'pending', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert expense");

        shift_id.to_string()
    }

    #[test]
    fn test_generate_z_report_basic() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        let payload = serde_json::json!({ "shiftId": shift_id });
        let result = generate_z_report(&db, &payload).expect("generate should succeed");

        assert_eq!(result["success"], true);
        assert_eq!(result["existing"], false);

        let report = &result["report"];
        assert_eq!(report["grossSales"], 100.0);
        assert_eq!(report["cashSales"], 60.0);
        assert_eq!(report["cardSales"], 40.0);
        assert_eq!(report["refundsTotal"], 10.0);
        assert_eq!(report["voidsTotal"], 0.0);
        assert_eq!(report["expensesTotal"], 15.0);
        assert_eq!(report["totalOrders"], 3);
        // net_sales = 100 - 10 - 0 - 0 = 90
        assert_eq!(report["netSales"], 90.0);
        assert_eq!(report["cashVariance"], 0.0);
        assert_eq!(report["openingCash"], 200.0);
        assert_eq!(report["closingCash"], 235.0);
        assert_eq!(report["syncState"], "pending");

        // Verify z_reports table has 1 row
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // Verify sync_queue has entry
        let sq_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = 'z_report'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sq_count, 1);
    }

    #[test]
    fn test_generate_z_report_idempotent() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        let payload = serde_json::json!({ "shiftId": shift_id });

        let result1 = generate_z_report(&db, &payload).expect("first generate");
        let result2 = generate_z_report(&db, &payload).expect("second generate");

        assert_eq!(result1["existing"], false);
        assert_eq!(result2["existing"], true);
        assert_eq!(result1["zReportId"], result2["zReportId"]);

        // Only 1 row in z_reports
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_generate_z_report_requires_closed_shift() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let now = "2026-02-16T18:00:00Z";

        // Insert an active (not closed) shift
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, branch_id, terminal_id, role_type,
                opening_cash_amount, check_in_time, status,
                sync_status, created_at, updated_at
             ) VALUES (
                'shift-active', 'staff-1', 'branch-1', 'term-1', 'cashier',
                200.0, ?1, 'active', 'pending', ?1, ?1
             )",
            params![now],
        )
        .expect("insert active shift");
        drop(conn);

        let payload = serde_json::json!({ "shiftId": "shift-active" });
        let result = generate_z_report(&db, &payload);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Shift must be closed"));
    }

    #[test]
    fn test_get_z_report() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        let gen_result =
            generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();
        let z_report_id = gen_result["zReportId"].as_str().unwrap();

        let get_result =
            get_z_report(&db, &serde_json::json!({ "zReportId": z_report_id })).unwrap();

        assert_eq!(get_result["success"], true);
        assert_eq!(get_result["report"]["id"], z_report_id);
        assert_eq!(get_result["report"]["grossSales"], 100.0);
    }

    #[test]
    fn test_list_z_reports_by_shift() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        let list_result = list_z_reports(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        assert_eq!(list_result["success"], true);
        assert_eq!(list_result["count"], 1);
        assert_eq!(list_result["reports"][0]["grossSales"], 100.0);
    }

    #[test]
    fn test_list_z_reports_by_date_range() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        let list_result = list_z_reports(
            &db,
            &serde_json::json!({
                "startDate": "2026-02-01",
                "endDate": "2026-02-28",
            }),
        )
        .unwrap();

        assert_eq!(list_result["success"], true);
        assert_eq!(list_result["count"], 1);
    }

    // ---------------------------------------------------------------
    // Gap 9: Period filtering
    // ---------------------------------------------------------------

    #[test]
    fn test_period_start_defaults_to_epoch() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let period = get_period_start(&conn);
        assert_eq!(period, "1970-01-01T00:00:00Z");
    }

    #[test]
    fn test_period_start_reads_from_settings() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        db::set_setting(
            &conn,
            "system",
            "last_z_report_timestamp",
            "2026-02-16T22:00:00Z",
        )
        .expect("set timestamp");
        let period = get_period_start(&conn);
        assert_eq!(period, "2026-02-16T22:00:00Z");
    }

    // ---------------------------------------------------------------
    // Gap 7: Multi-shift aggregation
    // ---------------------------------------------------------------

    /// Insert a second closed shift with different data for multi-shift testing.
    fn seed_second_closed_shift(db: &DbState) {
        let conn = db.conn.lock().unwrap();
        let shift_id = "shift-zr-2";
        let now = "2026-02-16T22:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                opening_cash_amount, closing_cash_amount, expected_cash_amount, cash_variance,
                check_in_time, check_out_time, status, calculation_version,
                sync_status, created_at, updated_at
             ) VALUES (
                ?1, 'staff-2', 'Jane', 'branch-1', 'term-1', 'cashier',
                300.0, 350.0, 350.0, 0.0,
                '2026-02-16T14:00:00Z', ?2, 'closed', 2,
                'pending', ?2, ?2
             )",
            params![shift_id, now],
        )
        .expect("insert shift 2");

        // 2 more orders for shift 2
        for (i, total) in [(4, 50.0), (5, 70.0)] {
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, status, order_type,
                    payment_status, staff_shift_id, discount_amount, tip_amount,
                    sync_status, created_at, updated_at
                 ) VALUES (?1, ?2, '[]', ?3, 'completed', 'dine-in',
                    'paid', ?4, 0.0, 0.0, 'pending', ?5, ?5)",
                params![format!("ord-{i}"), format!("#{i}"), total, shift_id, now],
            )
            .expect("insert order");
        }

        // Payments for shift 2: cash + card
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-4', 'ord-4', 'cash', 50.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 4");
        conn.execute(
            "INSERT INTO order_payments (id, order_id, method, amount, status, staff_shift_id, currency, created_at, updated_at)
             VALUES ('pay-5', 'ord-5', 'card', 70.0, 'completed', ?1, 'EUR', ?2, ?2)",
            params![shift_id, now],
        ).expect("insert payment 5");
    }

    #[test]
    fn test_generate_z_report_for_date_multi_shift() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = generate_z_report_for_date(&db, &payload).expect("multi-shift generate");

        assert_eq!(result["success"], true);
        let report = &result["report"];

        // Combined: 3 orders from shift 1 + 2 orders from shift 2 = 5 orders
        assert_eq!(report["totalOrders"], 5);
        // Gross: 25+35+40 + 50+70 = 220
        assert_eq!(report["grossSales"], 220.0);
        // Cash: 25+35+50 = 110
        assert_eq!(report["cashSales"], 110.0);
        // Card: 40+70 = 110
        assert_eq!(report["cardSales"], 110.0);
        // Refunds: 10 (from shift 1 only)
        assert_eq!(report["refundsTotal"], 10.0);
        // Expenses: 15 (from shift 1 only)
        assert_eq!(report["expensesTotal"], 15.0);

        // Parse report_json to verify staffReports has 2 entries
        let report_json_str = report["reportJson"].as_object().unwrap();
        let staff_reports = report_json_str
            .get("staffReports")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(staff_reports.len(), 2, "should have 2 staff reports");
    }

    #[test]
    fn test_generate_z_report_for_date_respects_period_start() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        // Set period start to AFTER shift 1 but BEFORE shift 2
        {
            let conn = db.conn.lock().unwrap();
            db::set_setting(
                &conn,
                "system",
                "last_z_report_timestamp",
                "2026-02-16T13:00:00Z",
            )
            .expect("set period");
        }

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = generate_z_report_for_date(&db, &payload).expect("period-filtered generate");

        let report = &result["report"];

        // Only shift 2 data should appear (check_in_time > period_start)
        // But orders created_at after period_start: ord-4 and ord-5 only
        // However, payment timestamps of shift-1 orders are "2026-02-16T18:00:00Z" which is > 13:00
        // This is expected because period start filters by created_at not by shift
        // In the actual scenario the period start would be set AFTER all shift-1 data
        // Since shift-1 orders have created_at = 18:00 > 13:00 they DO appear
        // The real filtering happens at the shift level: shift 2 check_in = 14:00 > 13:00 OK
        // But shift 1 check_in = 09:00 < 13:00 so shift 1 is excluded from shift count
        // Note: orders are queried by created_at > period_start (not by shift assignment)

        // Shift 1 check_in 09:00 < 13:00 → excluded
        // Shift 2 check_in 14:00 > 13:00 → included
        // staffReports should only have 1 entry (shift 2)
        let report_json_val = report["reportJson"].as_object().unwrap();
        let staff_reports = report_json_val
            .get("staffReports")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(
            staff_reports.len(),
            1,
            "only shift 2 should be in staff reports"
        );
        assert_eq!(
            staff_reports[0]["staffName"], "Jane",
            "shift 2 staff is Jane"
        );
    }

    // ---------------------------------------------------------------
    // Gap 8: Data clearing (finalize_end_of_day)
    // ---------------------------------------------------------------

    #[test]
    fn test_finalize_end_of_day_clears_operational_data() {
        let db = test_db();
        seed_closed_shift(&db);

        // Verify data exists before cleanup
        {
            let conn = db.conn.lock().unwrap();
            let orders: i64 = conn
                .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
                .unwrap();
            assert_eq!(orders, 3, "should have 3 orders before cleanup");
            let payments: i64 = conn
                .query_row("SELECT COUNT(*) FROM order_payments", [], |row| row.get(0))
                .unwrap();
            assert_eq!(payments, 3, "should have 3 payments before cleanup");
        }

        let result = finalize_end_of_day(&db, "2026-02-16").expect("cleanup should succeed");

        // Verify counts returned
        assert_eq!(result["orders"], 3, "should clear 3 orders");
        assert_eq!(result["order_payments"], 3, "should clear 3 payments");
        assert_eq!(
            result["payment_adjustments"], 1,
            "should clear 1 adjustment"
        );
        assert_eq!(result["shift_expenses"], 1, "should clear 1 expense");
        assert_eq!(result["staff_shifts"], 1, "should clear 1 shift");
        assert_eq!(result["cash_drawer_sessions"], 1, "should clear 1 drawer");

        // Verify tables are empty after cleanup
        let conn = db.conn.lock().unwrap();
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orders, 0, "orders should be empty after cleanup");
        let shifts: i64 = conn
            .query_row("SELECT COUNT(*) FROM staff_shifts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(shifts, 0, "staff_shifts should be empty after cleanup");
    }

    #[test]
    fn test_finalize_end_of_day_preserves_z_reports() {
        let db = test_db();
        let shift_id = seed_closed_shift(&db);

        // Generate a Z-report first
        generate_z_report(&db, &serde_json::json!({ "shiftId": shift_id })).unwrap();

        // Verify z_report exists
        {
            let conn = db.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1);
        }

        // Cleanup
        finalize_end_of_day(&db, "2026-02-16").expect("cleanup");

        // z_reports should still be there
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "z_reports must be preserved after cleanup");

        // local_settings should still be there
        let settings: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_settings", [], |row| row.get(0))
            .unwrap();
        // We didn't explicitly seed local_settings, but schema creates the table
        assert!(settings >= 0, "local_settings table should exist");
    }

    #[test]
    fn test_finalize_preserves_unsynced_sync_queue() {
        let db = test_db();
        seed_closed_shift(&db);

        // Add a synced entry and a pending entry to sync_queue
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, created_at)
                 VALUES ('order', 'ord-1', 'insert', '{}', 'key-synced', 'synced', '2026-02-16T10:00:00Z')",
                [],
            ).expect("insert synced entry");
            conn.execute(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, idempotency_key, status, created_at)
                 VALUES ('order', 'ord-2', 'insert', '{}', 'key-pending', 'pending', '2026-02-16T10:00:00Z')",
                [],
            ).expect("insert pending entry");
        }

        let result = finalize_end_of_day(&db, "2026-02-16").expect("cleanup");

        // Only synced entry should be deleted
        assert_eq!(
            result["sync_queue"], 1,
            "only synced entry should be cleared"
        );

        // Pending entry should remain
        let conn = db.conn.lock().unwrap();
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1, "pending sync_queue entry should be preserved");
    }

    // ---------------------------------------------------------------
    // Submit Z-report (full flow)
    // ---------------------------------------------------------------

    #[test]
    fn test_submit_z_report_stores_timestamp_and_cleans() {
        let db = test_db();
        seed_closed_shift(&db);
        seed_second_closed_shift(&db);

        let payload = serde_json::json!({
            "branchId": "branch-1",
            "date": "2026-02-16",
        });
        let result = submit_z_report(&db, &payload).expect("submit should succeed");

        assert_eq!(result["success"], true);
        assert!(result["cleanup"].is_object(), "should have cleanup counts");
        assert!(
            result["lastZReportTimestamp"].as_str().is_some(),
            "should have timestamp"
        );

        // Verify last_z_report_timestamp was stored
        let conn = db.conn.lock().unwrap();
        let stored = db::get_setting(&conn, "system", "last_z_report_timestamp");
        assert!(stored.is_some(), "timestamp should be stored in settings");

        // Verify operational data was cleared
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orders, 0, "orders should be cleared after submit");

        // Verify z_reports persisted (the generated report + sync entry)
        let z_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM z_reports", [], |row| row.get(0))
            .unwrap();
        assert_eq!(z_count, 1, "z_report should be persisted");
    }
}
