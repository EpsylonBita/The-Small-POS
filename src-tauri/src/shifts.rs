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
use std::{collections::BTreeMap, future::Future};
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::DbState;
use crate::money::Cents;
use crate::{business_day, order_ownership, payment_integrity, storage, sync_queue};

#[derive(Debug)]
struct CheckInEligibility {
    business_day_start_at: String,
    has_cashier_for_business_day: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ShiftBusinessDayContext {
    pub(crate) report_date: String,
    pub(crate) period_start_at: String,
}

impl CheckInEligibility {
    fn requires_cashier_first(&self) -> bool {
        !self.has_cashier_for_business_day
    }

    fn as_value(&self) -> Value {
        serde_json::json!({
            "businessDayStartAt": self.business_day_start_at,
            "hasCashierForBusinessDay": self.has_cashier_for_business_day,
            "requiresCashierFirst": self.requires_cashier_first(),
        })
    }
}

pub(crate) fn resolve_shift_business_day_context(
    conn: &Connection,
    branch_id: &str,
    fallback_at: &str,
    stored_report_date: Option<&str>,
    stored_period_start_at: Option<&str>,
) -> ShiftBusinessDayContext {
    let period_start_at = stored_period_start_at
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| business_day::resolve_period_start(conn, branch_id, Some(fallback_at)));

    let report_date = stored_report_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            business_day::report_date_for_business_window(&period_start_at, fallback_at)
        });

    ShiftBusinessDayContext {
        report_date,
        period_start_at,
    }
}

fn block_on_shift_close_repair_future<F>(future: F) -> F::Output
where
    F: Future,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(future)),
        Err(_) => tauri::async_runtime::block_on(future),
    }
}

fn load_checkout_payment_blockers_with_auto_repair(
    db: &DbState,
    branch_id: &str,
    period_start_at: &str,
    cutoff_at: &str,
) -> Result<Vec<payment_integrity::UnsettledPaymentBlocker>, String> {
    let load_blockers = || {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        payment_integrity::load_branch_window_payment_blockers(
            &conn,
            branch_id,
            period_start_at,
            Some(cutoff_at),
            true,
        )
    };

    let initial_blockers = load_blockers()?;
    let blocking_order_ids: Vec<String> = initial_blockers
        .iter()
        .filter(|blocker| blocker.missing_local_payment_row())
        .map(|blocker| blocker.order_id.clone())
        .collect();

    if blocking_order_ids.is_empty() {
        return Ok(initial_blockers);
    }

    match block_on_shift_close_repair_future(crate::sync::repair_local_payment_mirrors_for_orders(
        db,
        &blocking_order_ids,
    )) {
        Ok(_) => load_blockers(),
        Err(error) => {
            warn!(
                branch_id = %branch_id,
                order_ids = ?blocking_order_ids,
                error = %error,
                "Failed to auto-repair payment mirrors before shift close"
            );
            Ok(initial_blockers)
        }
    }
}

// ---------------------------------------------------------------------------
// Open shift
// ---------------------------------------------------------------------------

/// Open a new shift for a staff member.
///
/// Creates a `staff_shifts` row and, for cashier roles, a matching
/// `cash_drawer_sessions` row. Returns error if staff already has an active shift.
pub fn open_shift(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let normalize_runtime_identity = |value: String| -> Option<String> {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            return None;
        }
        let lower = trimmed.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "default-branch" | "default-terminal" | "default-organization" | "default-org"
        ) {
            return None;
        }
        Some(trimmed)
    };

    let staff_id = str_field(payload, "staffId")
        .or_else(|| str_field(payload, "staff_id"))
        .ok_or("Missing staffId")?;

    // Wave 1 C15: keyring is authoritative when provisioned.
    //
    // Threat model: the renderer-supplied `branchId` / `terminalId` in the
    // payload used to be preferred over the keyring, so a tampered renderer
    // could open a shift against any tenant by choosing an arbitrary ID.
    //
    // New resolution (per identity):
    //   - keyring EMPTY, renderer supplies   → renderer (onboarding/tests)
    //   - keyring has X, renderer EMPTY      → keyring
    //   - keyring has X, renderer has X      → keyring (match; safe)
    //   - keyring has X, renderer has Y ≠ X  → REJECT with tenant-mismatch
    //
    // Keyring emptiness alone is not an error here — the admin-API key
    // check at the ingress layer already gates unprovisioned terminals out
    // of production tenants; onboarding tests legitimately open shifts
    // before the keyring is populated.
    let resolve_tenant_id = |renderer_key_camel: &str,
                             renderer_key_snake: &str,
                             keyring_key: &str|
     -> Result<String, String> {
        let renderer = str_field(payload, renderer_key_camel)
            .or_else(|| str_field(payload, renderer_key_snake))
            .and_then(&normalize_runtime_identity);
        let keyring = storage::get_credential(keyring_key).and_then(&normalize_runtime_identity);
        match (keyring, renderer) {
            (Some(k), Some(r)) if k != r => Err(format!(
                "Tenant mismatch: renderer {renderer_key_camel} ({r:?}) does not match provisioned {keyring_key} ({k:?})"
            )),
            (Some(k), _) => Ok(k),
            (None, Some(r)) => Ok(r),
            (None, None) => Err(format!("Missing {renderer_key_camel}")),
        }
    };

    let branch_id = resolve_tenant_id("branchId", "branch_id", "branch_id")?;
    let terminal_id = resolve_tenant_id("terminalId", "terminal_id", "terminal_id")?;
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

    let shift_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    // Wave 2a C2: open the transaction FIRST. The duplicate-shift check
    // used to run here (lines 186–199 on HEAD) outside any transaction.
    // Two terminals racing to open a shift for the same staff could both
    // pass the pre-check and then both INSERT successfully, violating
    // the "one active shift per staff" invariant. Moving the SELECT
    // inside `BEGIN IMMEDIATE` — combined with the partial UNIQUE index
    // added in `migrate_v46` as defence-in-depth — serialises the
    // check-then-insert under SQLite's WAL write lock.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        // Re-check inside the transaction: this is the authoritative
        // guard. Any concurrent writer that beat us to `BEGIN IMMEDIATE`
        // has already committed their INSERT, so their row is visible.
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

        let check_in_eligibility = resolve_check_in_eligibility(&conn, &branch_id, &terminal_id)?;
        if !role_type.trim().eq_ignore_ascii_case("cashier")
            && check_in_eligibility.requires_cashier_first()
        {
            return Err(
                "The first check-in for this business day must be a cashier. Start a cashier shift first."
                    .to_string(),
            );
        }

        let responsible_cashier_assignment = if role_returns_cash(&role_type) {
            find_active_cashier_assignment(&conn, &branch_id, &terminal_id)?
        } else {
            None
        };
        let responsible_cashier_shift_id = responsible_cashier_assignment
            .as_ref()
            .map(|(cashier_shift_id, _)| cashier_shift_id.clone());
        let shift_business_day = ShiftBusinessDayContext {
            report_date: business_day::report_date_for_business_window(
                &check_in_eligibility.business_day_start_at,
                &now,
            ),
            period_start_at: check_in_eligibility.business_day_start_at.clone(),
        };

        // W4c dual-write: every monetary REAL column gets its `_cents` sibling.
        let opening_cash_cents = Cents::round_half_even(opening_cash).as_i64();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, report_date, period_start_at,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, transferred_to_cashier_shift_id,
                sync_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', 2, ?12, 'pending', ?13, ?13)",
            params![
                shift_id,
                staff_id,
                staff_name,
                branch_id,
                terminal_id,
                role_type,
                now,
                shift_business_day.report_date.as_str(),
                shift_business_day.period_start_at.as_str(),
                opening_cash,
                opening_cash_cents,
                responsible_cashier_shift_id,
                now,
            ],
        )
        .map_err(|e| format!("insert shift: {e}"))?;

        // Create cash drawer session for cashier/manager roles
        if role_type == "cashier" || role_type == "manager" {
            let drawer_id = Uuid::new_v4().to_string();
            // W4c dual-write: opening_amount → opening_amount_cents.
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents, opened_at, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    drawer_id,
                    shift_id,
                    staff_id,
                    branch_id,
                    terminal_id,
                    opening_cash,
                    opening_cash_cents,
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
                    // W4c dual-write: driver_cash_given → driver_cash_given_cents.
                    conn.execute(
                        "UPDATE cash_drawer_sessions SET
                            driver_cash_given = COALESCE(driver_cash_given, 0) + ?1,
                            driver_cash_given_cents = COALESCE(driver_cash_given_cents, 0) + ?2,
                            updated_at = ?3
                         WHERE id = ?4",
                        params![opening_cash, opening_cash_cents, now, drawer_id],
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

        // Wave 5 Session 6: shift-open row enqueued via parity queue. The
        // parity dispatcher has no dedicated case for "staff_shifts" so the
        // endpoint is resolved via module_type="shifts" → /api/pos/shifts/sync
        // (same admin endpoint the legacy drain hit). idempotency_key is now
        // read from staff_shifts.idempotency_key (v47/v49) instead of the
        // volatile per-enqueue UUID (C17).
        let sync_payload = build_shift_open_sync_payload(
            &shift_id,
            &staff_id,
            staff_name.as_deref(),
            &branch_id,
            &terminal_id,
            &role_type,
            opening_cash,
            &now,
            shift_business_day.report_date.as_str(),
            shift_business_day.period_start_at.as_str(),
            2,
            responsible_cashier_assignment
                .as_ref()
                .map(|(cashier_shift_id, _)| cashier_shift_id.as_str()),
            responsible_cashier_assignment
                .as_ref()
                .map(|(_, drawer_id)| drawer_id.as_str()),
        );

        sync_queue::enqueue_payload_item(
            &conn,
            "staff_shifts",
            &shift_id,
            "INSERT",
            &sync_payload,
            Some(1),
            Some("shifts"),
            Some("manual"),
            Some(1),
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
    report_date: &str,
    period_start_at: &str,
    calculation_version: i64,
    responsible_cashier_shift_id: Option<&str>,
    responsible_cashier_drawer_id: Option<&str>,
) -> Value {
    let opening_cash_cents = Cents::round_half_even(opening_cash).as_i64();
    // W4d-i: emit BOTH legacy float (`openingCash`, `borrowedStartingAmount`)
    // and integer cents (`opening_cash_cents`, `borrowed_starting_amount_cents`)
    // keys. Admin-dashboard still reads the float keys; cents are forward-compat.
    let mut payload = serde_json::json!({
        "shiftId": shift_id,
        "staffId": staff_id,
        "staffName": staff_name,
        "branchId": branch_id,
        "terminalId": terminal_id,
        "roleType": role_type,
        "openingCash": opening_cash,
        "opening_cash_cents": opening_cash_cents,
        "checkInTime": check_in_time,
        "reportDate": report_date,
        "periodStartAt": period_start_at,
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
        payload["borrowed_starting_amount_cents"] = serde_json::json!(opening_cash_cents);
    }

    payload
}

fn load_cash_drawer_snapshot_for_shift(
    conn: &Connection,
    shift_id: &str,
) -> Result<Option<Value>, String> {
    conn.query_row(
        // W4b-ii: read all 12 monetary columns from their cents siblings
        // with COALESCE-real fallback (removed in 4e). The round_half_even
        // pre-conversion the 4d-replay had at the JSON-emit boundary
        // becomes a no-op now that the source is already integer cents.
        "SELECT id, cashier_id,
                COALESCE(opening_amount_cents, CAST(ROUND(opening_amount * 100) AS INTEGER), 0),
                COALESCE(closing_amount_cents, CAST(ROUND(closing_amount * 100) AS INTEGER)),
                COALESCE(expected_amount_cents, CAST(ROUND(expected_amount * 100) AS INTEGER)),
                COALESCE(variance_amount_cents, CAST(ROUND(variance_amount * 100) AS INTEGER)),
                COALESCE(total_cash_sales_cents, CAST(ROUND(total_cash_sales * 100) AS INTEGER), 0),
                COALESCE(total_card_sales_cents, CAST(ROUND(total_card_sales * 100) AS INTEGER), 0),
                COALESCE(total_refunds_cents, CAST(ROUND(total_refunds * 100) AS INTEGER), 0),
                COALESCE(total_expenses_cents, CAST(ROUND(total_expenses * 100) AS INTEGER), 0),
                COALESCE(cash_drops_cents, CAST(ROUND(cash_drops * 100) AS INTEGER), 0),
                COALESCE(driver_cash_given_cents, CAST(ROUND(driver_cash_given * 100) AS INTEGER), 0),
                COALESCE(driver_cash_returned_cents, CAST(ROUND(driver_cash_returned * 100) AS INTEGER), 0),
                COALESCE(total_staff_payments_cents, CAST(ROUND(total_staff_payments * 100) AS INTEGER), 0),
                opened_at, closed_at, reconciled,
                reconciled_at, reconciled_by
         FROM cash_drawer_sessions
         WHERE staff_shift_id = ?1",
        params![shift_id],
        |row| {
            // W4d-i: emit BOTH legacy float and integer cents keys for the
            // 12 monetary drawer fields. Admin still reads the float keys.
            let opening_amount_cents = row.get::<_, i64>(2)?;
            let closing_amount_cents = row.get::<_, Option<i64>>(3)?;
            let expected_amount_cents = row.get::<_, Option<i64>>(4)?;
            let variance_amount_cents = row.get::<_, Option<i64>>(5)?;
            let total_cash_sales_cents = row.get::<_, i64>(6)?;
            let total_card_sales_cents = row.get::<_, i64>(7)?;
            let total_refunds_cents = row.get::<_, i64>(8)?;
            let total_expenses_cents = row.get::<_, i64>(9)?;
            let cash_drops_cents = row.get::<_, i64>(10)?;
            let driver_cash_given_cents = row.get::<_, i64>(11)?;
            let driver_cash_returned_cents = row.get::<_, i64>(12)?;
            let total_staff_payments_cents = row.get::<_, i64>(13)?;
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "cashierId": row.get::<_, Option<String>>(1)?,
                "openingAmount": Cents::new(opening_amount_cents).to_f64_dp2(),
                "opening_amount_cents": opening_amount_cents,
                "closingAmount": closing_amount_cents.map(|c| Cents::new(c).to_f64_dp2()),
                "closing_amount_cents": closing_amount_cents,
                "expectedAmount": expected_amount_cents.map(|c| Cents::new(c).to_f64_dp2()),
                "expected_amount_cents": expected_amount_cents,
                "varianceAmount": variance_amount_cents.map(|c| Cents::new(c).to_f64_dp2()),
                "variance_amount_cents": variance_amount_cents,
                "totalCashSales": Cents::new(total_cash_sales_cents).to_f64_dp2(),
                "total_cash_sales_cents": total_cash_sales_cents,
                "totalCardSales": Cents::new(total_card_sales_cents).to_f64_dp2(),
                "total_card_sales_cents": total_card_sales_cents,
                "totalRefunds": Cents::new(total_refunds_cents).to_f64_dp2(),
                "total_refunds_cents": total_refunds_cents,
                "totalExpenses": Cents::new(total_expenses_cents).to_f64_dp2(),
                "total_expenses_cents": total_expenses_cents,
                "cashDrops": Cents::new(cash_drops_cents).to_f64_dp2(),
                "cash_drops_cents": cash_drops_cents,
                "driverCashGiven": Cents::new(driver_cash_given_cents).to_f64_dp2(),
                "driver_cash_given_cents": driver_cash_given_cents,
                "driverCashReturned": Cents::new(driver_cash_returned_cents).to_f64_dp2(),
                "driver_cash_returned_cents": driver_cash_returned_cents,
                "totalStaffPayments": Cents::new(total_staff_payments_cents).to_f64_dp2(),
                "total_staff_payments_cents": total_staff_payments_cents,
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
/// For calculation_version >= 2, recorded staff payouts for the cashier shift are
/// used as the source of truth, with the cash drawer aggregate as a fallback.
pub fn close_shift(db: &DbState, payload: &Value) -> Result<Value, String> {
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

    let now = Utc::now().to_rfc3339();

    // Fetch the active shift (include branch_id/terminal_id for driver return + transfer logic)
    let (
        staff_id,
        staff_name,
        role_type,
        opening_cash,
        calc_version,
        shift_branch_id,
        shift_terminal_id,
        shift_check_in_time,
        shift_business_day,
    ) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let shift = conn
            .query_row(
                // W4b-ii: cents-with-real-fallback shim (removed in 4e).
                "SELECT id, staff_id, staff_name, role_type,
                        COALESCE(opening_cash_amount_cents, CAST(ROUND(opening_cash_amount * 100) AS INTEGER), 0),
                        calculation_version,
                        branch_id, terminal_id, check_in_time, report_date, period_start_at
                 FROM staff_shifts WHERE id = ?1 AND status = 'active'",
                params![shift_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
                        row.get::<_, Option<i32>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
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
            stored_report_date,
            stored_period_start_at,
        ) = shift;
        let shift_branch_id = shift_branch_id.unwrap_or_default();
        let shift_terminal_id = shift_terminal_id.unwrap_or_default();
        let shift_business_day = resolve_shift_business_day_context(
            &conn,
            &shift_branch_id,
            &now,
            stored_report_date.as_deref(),
            stored_period_start_at.as_deref(),
        );

        (
            staff_id,
            staff_name,
            role_type,
            opening_cash,
            calc_version.unwrap_or(1),
            shift_branch_id,
            shift_terminal_id,
            shift_check_in_time,
            shift_business_day,
        )
    };
    let is_non_financial_role = is_non_financial_shift_role(&role_type);
    let closing_cash_to_persist = if is_non_financial_role {
        0.0
    } else {
        closing_cash
    };

    let order_financial_expr = business_day::order_financial_timestamp_expr("o");
    let persisted_payment_amount =
        if role_type == "cashier" || role_type == "manager" || is_non_financial_role {
            None
        } else {
            payment_amount
        };

    if role_type == "cashier" || role_type == "manager" {
        let blockers = load_checkout_payment_blockers_with_auto_repair(
            db,
            &shift_branch_id,
            shift_business_day.period_start_at.as_str(),
            now.as_str(),
        )?;
        if !blockers.is_empty() {
            return Ok(payment_integrity::build_unsettled_payment_blocker_response(
                "Cannot close shift",
                &blockers,
            ));
        }
    }

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Wrap the entire reconciliation + close in a single IMMEDIATE transaction so
    // that no order/payment can be inserted between the aggregate SELECTs and the
    // subsequent UPDATEs, which would cause an incorrect cash variance.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    order_ownership::repair_historical_pickup_financial_attribution(&conn, &shift_branch_id, &now)
        .inspect_err(|_| {
            let _ = conn.execute_batch("ROLLBACK");
        })?;

    if role_type == "cashier" || role_type == "manager" {
        let blockers = payment_integrity::load_branch_window_payment_blockers(
            &conn,
            &shift_branch_id,
            shift_business_day.period_start_at.as_str(),
            Some(now.as_str()),
            true,
        )
        .inspect_err(|_| {
            let _ = conn.execute_batch("ROLLBACK");
        })?;
        if !blockers.is_empty() {
            let _ = conn.execute_batch("ROLLBACK");
            return Ok(payment_integrity::build_unsettled_payment_blocker_response(
                "Cannot close shift",
                &blockers,
            ));
        }
    }

    let result = (|| -> Result<(f64, f64), String> {
        #[allow(clippy::needless_late_init)]
        let expected: f64;
        let mut returned_cash_target: Option<(String, String, f64)> = None;

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
                // Subtract transferred driver starting amounts from driver_cash_given.
                // W4c dual-write: mirror onto driver_cash_given_cents.
                let transferred_driver_starting_total_cents =
                    Cents::round_half_even(transferred_driver_starting_total).as_i64();
                conn.execute(
                    "UPDATE cash_drawer_sessions SET
                    driver_cash_given = COALESCE(driver_cash_given, 0) - ?1,
                    driver_cash_given_cents = COALESCE(driver_cash_given_cents, 0) - ?2,
                    updated_at = ?3
                 WHERE staff_shift_id = ?4",
                    params![
                        transferred_driver_starting_total,
                        transferred_driver_starting_total_cents,
                        now,
                        shift_id
                    ],
                )
                .map_err(|e| format!("adjust driver_cash_given for transfers: {e}"))?;
                info!(
                    shift_id = %shift_id,
                    total_deducted = %transferred_driver_starting_total,
                    "Subtracted transferred driver starting amounts from driver_cash_given"
                );
            }

            // Wave 2a (shifts.rs:823 high-severity finding): require all
            // drivers in this cashier's business-day window to have
            // closed or been transferred before the cashier can close.
            // Otherwise the expected-cash formula — which deducts
            // `driver_given` but adds back `driver_returned` — understates
            // expected for active drivers, because `driver_returned = 0`
            // and `inherited_driver_expected_returns` only covers
            // drivers explicitly transferred to this cashier. Rejecting
            // here is simpler and auditable.
            // `transfer_active_cash_staff` has already run. Any drivers
            // that were successfully transferred to a specific next
            // cashier have `transferred_to_cashier_shift_id` set;
            // drivers for which the transfer target is not yet known
            // are marked with `is_transfer_pending = 1`. Either form
            // is acceptable — the outstanding cash obligation moves
            // with the driver. An "orphan" here is a driver who is
            // BOTH unassigned AND not flagged pending — meaning
            // transfer never happened and the cashier's formula
            // would silently understate expected.
            let orphan_active_dependent_drivers: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM staff_shifts
                     WHERE status = 'active'
                       AND role_type IN ('driver', 'server')
                       AND branch_id = ?1
                       AND check_in_time >= ?2
                       AND check_in_time <= ?3
                       AND transferred_to_cashier_shift_id IS NULL
                       AND COALESCE(is_transfer_pending, 0) = 0",
                    params![shift_branch_id, shift_check_in_time.as_str(), now.as_str()],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if orphan_active_dependent_drivers > 0 {
                return Err(format!(
                    "Cannot close cashier shift: {} driver/server shift(s) in this business day \
                     are still active and not transferred. Close or transfer them first.",
                    orphan_active_dependent_drivers
                ));
            }

            // Reconcile-at-close: re-derive drawer totals from source-of-truth tables.
            // This catches any missed incremental updates during the shift.
            // W4b-ii: cents-with-real-fallback shim wraps each SUM (4e removes).
            let reconciled_cash_sales: f64 = conn
                .query_row(
                    &format!(
                        "SELECT COALESCE(SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER))), 0)
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
                    |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
                )
                .unwrap_or(0.0);
            let reconciled_card_sales: f64 = conn
                .query_row(
                    &format!(
                        "SELECT COALESCE(SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER))), 0)
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
                    |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
                )
                .unwrap_or(0.0);
            let reconciled_refunds: f64 = conn
                .query_row(
                    &format!(
                        "SELECT COALESCE(SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER))), 0)
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
                    |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
                )
                .unwrap_or(0.0);
            let reconciled_expenses: f64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
                 FROM shift_expenses
                 WHERE staff_shift_id = ?1
                   AND (expense_type IS NULL OR expense_type != 'staff_payment')",
                    params![shift_id],
                    |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
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

            // Write reconciled values to cash_drawer_sessions (W4c dual-write).
            let reconciled_cash_sales_cents =
                Cents::round_half_even(reconciled_cash_sales).as_i64();
            let reconciled_card_sales_cents =
                Cents::round_half_even(reconciled_card_sales).as_i64();
            let reconciled_refunds_cents = Cents::round_half_even(reconciled_refunds).as_i64();
            let reconciled_expenses_cents = Cents::round_half_even(reconciled_expenses).as_i64();
            let reconciled_staff_payments_cents =
                Cents::round_half_even(reconciled_staff_payments).as_i64();
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                total_cash_sales = ?1, total_cash_sales_cents = ?2,
                total_card_sales = ?3, total_card_sales_cents = ?4,
                total_refunds = ?5, total_refunds_cents = ?6,
                total_expenses = ?7, total_expenses_cents = ?8,
                total_staff_payments = ?9, total_staff_payments_cents = ?10,
                updated_at = ?11
             WHERE staff_shift_id = ?12",
                params![
                    reconciled_cash_sales,
                    reconciled_cash_sales_cents,
                    reconciled_card_sales,
                    reconciled_card_sales_cents,
                    reconciled_refunds,
                    reconciled_refunds_cents,
                    reconciled_expenses,
                    reconciled_expenses_cents,
                    reconciled_staff_payments,
                    reconciled_staff_payments_cents,
                    now,
                    shift_id,
                ],
            )
            .map_err(|e| format!("reconcile drawer totals: {e}"))?;

            // Fetch cash drawer session totals (now reconciled).
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            let drawer = conn
                .query_row(
                    "SELECT
                        COALESCE(total_cash_sales_cents, CAST(ROUND(total_cash_sales * 100) AS INTEGER), 0),
                        COALESCE(total_refunds_cents, CAST(ROUND(total_refunds * 100) AS INTEGER), 0),
                        COALESCE(total_expenses_cents, CAST(ROUND(total_expenses * 100) AS INTEGER), 0),
                        COALESCE(cash_drops_cents, CAST(ROUND(cash_drops * 100) AS INTEGER), 0),
                        COALESCE(driver_cash_given_cents, CAST(ROUND(driver_cash_given * 100) AS INTEGER), 0),
                        COALESCE(driver_cash_returned_cents, CAST(ROUND(driver_cash_returned * 100) AS INTEGER), 0),
                        COALESCE(total_staff_payments_cents, CAST(ROUND(total_staff_payments * 100) AS INTEGER), 0)
                 FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
                    params![shift_id],
                    |row| {
                        Ok((
                            Cents::new(row.get::<_, i64>(0).unwrap_or(0)).to_f64_dp2(),
                            Cents::new(row.get::<_, i64>(1).unwrap_or(0)).to_f64_dp2(),
                            Cents::new(row.get::<_, i64>(2).unwrap_or(0)).to_f64_dp2(),
                            Cents::new(row.get::<_, i64>(3).unwrap_or(0)).to_f64_dp2(),
                            Cents::new(row.get::<_, i64>(4).unwrap_or(0)).to_f64_dp2(),
                            Cents::new(row.get::<_, i64>(5).unwrap_or(0)).to_f64_dp2(),
                            Cents::new(row.get::<_, i64>(6).unwrap_or(0)).to_f64_dp2(),
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
                let recorded_staff_payouts: f64 = conn
                    .query_row(
                        "SELECT COALESCE(SUM(amount), 0)
                         FROM staff_payments
                         WHERE cashier_shift_id = ?1",
                        params![shift_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0.0);

                if recorded_staff_payouts > 0.0 {
                    recorded_staff_payouts
                } else {
                    staff_payments
                }
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
        // W4c dual-write: closing_amount, expected_amount, variance_amount.
        let closing_cash_to_persist_cents =
            Cents::round_half_even(closing_cash_to_persist).as_i64();
        let expected_cents = Cents::round_half_even(expected).as_i64();
        let variance_cents = Cents::round_half_even(variance).as_i64();
        if role_type == "cashier" || role_type == "manager" {
            conn.execute(
                "UPDATE cash_drawer_sessions SET
                    closing_amount = ?1, closing_amount_cents = ?2,
                    expected_amount = ?3, expected_amount_cents = ?4,
                    variance_amount = ?5, variance_amount_cents = ?6,
                    reconciled = 1,
                    closed_at = ?7, reconciled_at = ?7, reconciled_by = ?8,
                    updated_at = ?7
                 WHERE staff_shift_id = ?9",
                params![
                    closing_cash_to_persist,
                    closing_cash_to_persist_cents,
                    expected,
                    expected_cents,
                    variance,
                    variance_cents,
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
                    // W4c dual-write: driver_cash_returned → driver_cash_returned_cents.
                    conn.execute(
                        "UPDATE cash_drawer_sessions SET
                            driver_cash_returned = COALESCE(driver_cash_returned, 0) + ?1,
                            driver_cash_returned_cents = COALESCE(driver_cash_returned_cents, 0) + ?2,
                            updated_at = ?3
                         WHERE id = ?4",
                        params![
                            closing_cash_to_persist,
                            closing_cash_to_persist_cents,
                            now,
                            drawer_id
                        ],
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
                    if closing_cash_to_persist_cents > 0 {
                        return Err(format!(
                            "Cannot close {role_type} shift with returned cash but no active cashier drawer"
                        ));
                    }
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

        // Update the shift record (W4c dual-write: 7 monetary columns mirror).
        // Note: `closing_cash_to_persist_cents`, `expected_cents`, `variance_cents`
        // were computed for the cash-drawer reconciliation update above and are
        // reused here. The other four cents values are computed inline below.
        let persisted_payment_amount_cents =
            persisted_payment_amount.map(|v| Cents::round_half_even(v).as_i64());
        let total_sales_cents = Cents::round_half_even(total_sales).as_i64();
        let shift_cash_sales_cents = Cents::round_half_even(shift_cash_sales).as_i64();
        let shift_card_sales_cents = Cents::round_half_even(shift_card_sales).as_i64();
        conn.execute(
            "UPDATE staff_shifts SET
                check_out_time = ?1,
                closing_cash_amount = ?2, closing_cash_amount_cents = ?3,
                expected_cash_amount = ?4, expected_cash_amount_cents = ?5,
                cash_variance = ?6, cash_variance_cents = ?7,
                status = 'closed',
                payment_amount = ?8, payment_amount_cents = ?9,
                closed_by = ?10, sync_status = 'pending', updated_at = ?1,
                total_orders_count = ?12,
                total_sales_amount = ?13, total_sales_amount_cents = ?14,
                total_cash_sales = ?15, total_cash_sales_cents = ?16,
                total_card_sales = ?17, total_card_sales_cents = ?18,
                report_date = COALESCE(report_date, ?19),
                period_start_at = COALESCE(period_start_at, ?20)
             WHERE id = ?11",
            params![
                now,
                closing_cash_to_persist,
                closing_cash_to_persist_cents,
                expected,
                expected_cents,
                variance,
                variance_cents,
                persisted_payment_amount,
                persisted_payment_amount_cents,
                closed_by,
                shift_id,
                order_count,
                total_sales,
                total_sales_cents,
                shift_cash_sales,
                shift_cash_sales_cents,
                shift_card_sales,
                shift_card_sales_cents,
                shift_business_day.report_date.as_str(),
                shift_business_day.period_start_at.as_str(),
            ],
        )
        .map_err(|e| format!("close shift: {e}"))?;

        // Wave 5 Session 6: shift-close row now flows through parity queue.
        // Same module_type="shifts" routing as shift-open above.
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
            "reportDate": shift_business_day.report_date.as_str(),
            "periodStartAt": shift_business_day.period_start_at.as_str(),
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

        sync_queue::enqueue_payload_item(
            &conn,
            "staff_shifts",
            &shift_id,
            "UPDATE",
            &sync_payload,
            Some(1),
            Some("shifts"),
            Some("manual"),
            Some(1),
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
                "shiftId": shift_id,
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
        "SELECT * FROM staff_shifts WHERE staff_id = ?1 AND status = 'active'
         ORDER BY check_in_time DESC LIMIT 1",
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

pub fn get_check_in_eligibility(
    db: &DbState,
    branch_id: &str,
    terminal_id: &str,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let eligibility = resolve_check_in_eligibility(&conn, branch_id, terminal_id)?;
    Ok(eligibility.as_value())
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

pub fn get_shift_sync_state(db: &DbState, shift_id: &str) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let shift_sync_status: Option<String> = conn
        .query_row(
            "SELECT sync_status
             FROM staff_shifts
             WHERE id = ?1
             LIMIT 1",
            params![shift_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load shift sync status: {e}"))?;

    let Some(shift_sync_status) = shift_sync_status else {
        return Err(format!("No shift found with id {shift_id}"));
    };

    // Wave 5 Session 6: union parity_sync_queue (new canonical queue for
    // staff_shifts) with the legacy sync_queue so a shift created either
    // before or after the producer cutover reports its live state. Parity's
    // 'processing' status is projected back to the legacy 'in_progress'
    // label so the renderer's enum check remains stable.
    let queue_row: Option<(
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = conn
        .query_row(
            "SELECT status, last_error, retry_count, next_retry_at, created_at, updated_at
             FROM (
                 SELECT
                     CASE status WHEN 'processing' THEN 'in_progress' ELSE status END AS status,
                     error_message AS last_error,
                     attempts AS retry_count,
                     next_retry_at,
                     created_at,
                     COALESCE(last_attempt, created_at) AS updated_at
                 FROM parity_sync_queue
                 WHERE table_name = 'staff_shifts'
                   AND record_id = ?1
                   AND status IN ('pending', 'processing', 'failed', 'conflict')
                 UNION ALL
                 SELECT status, last_error, retry_count, next_retry_at, created_at, updated_at
                 FROM sync_queue
                 WHERE entity_type = 'shift'
                   AND entity_id = ?1
                   AND status IN ('failed', 'in_progress', 'queued_remote', 'pending')
             )
             ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
             LIMIT 1",
            params![shift_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("load shift sync queue state: {e}"))?;

    let (queue_status, last_error, retry_count, next_retry_at, queue_created_at, queue_updated_at) =
        match queue_row {
            Some((
                queue_status,
                last_error,
                retry_count,
                next_retry_at,
                queue_created_at,
                queue_updated_at,
            )) => (
                Some(queue_status),
                last_error,
                retry_count,
                next_retry_at,
                queue_created_at,
                queue_updated_at,
            ),
            None => (None, None, 0_i64, None, None, None),
        };

    Ok(serde_json::json!({
        "shiftId": shift_id,
        "shiftSyncStatus": shift_sync_status,
        "queueStatus": queue_status,
        "lastError": last_error,
        "retryCount": retry_count,
        "nextRetryAt": next_retry_at,
        "queueCreatedAt": queue_created_at,
        "queueUpdatedAt": queue_updated_at,
    }))
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
            // W4b-ii: cents-with-real-fallback shim on 8 monetary columns
            // (cols 5,6,7,8,12,13,14,18). 4e removes the COALESCE arms.
            "SELECT id, staff_id, staff_name, role_type, status,
                    COALESCE(opening_cash_amount_cents, CAST(ROUND(opening_cash_amount * 100) AS INTEGER), 0),
                    COALESCE(closing_cash_amount_cents, CAST(ROUND(closing_cash_amount * 100) AS INTEGER)),
                    COALESCE(expected_cash_amount_cents, CAST(ROUND(expected_cash_amount * 100) AS INTEGER)),
                    COALESCE(cash_variance_cents, CAST(ROUND(cash_variance * 100) AS INTEGER)),
                    check_in_time, check_out_time, total_orders_count,
                    COALESCE(total_sales_amount_cents, CAST(ROUND(total_sales_amount * 100) AS INTEGER), 0),
                    COALESCE(total_cash_sales_cents, CAST(ROUND(total_cash_sales * 100) AS INTEGER), 0),
                    COALESCE(total_card_sales_cents, CAST(ROUND(total_card_sales * 100) AS INTEGER), 0),
                    branch_id, terminal_id, calculation_version,
                    COALESCE(payment_amount_cents, CAST(ROUND(payment_amount * 100) AS INTEGER))
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
                    "opening_cash_amount": Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                    "closing_cash_amount": row.get::<_, Option<i64>>(6)?
                        .map(|c| Cents::new(c).to_f64_dp2()),
                    "expected_cash_amount": row.get::<_, Option<i64>>(7)?
                        .map(|c| Cents::new(c).to_f64_dp2()),
                    "cash_variance": row.get::<_, Option<i64>>(8)?
                        .map(|c| Cents::new(c).to_f64_dp2()),
                    "check_in_time": &ci,
                    "check_out_time": row.get::<_, Option<String>>(10)?,
                    "total_orders_count": row.get::<_, i64>(11)?,
                    "total_sales_amount": Cents::new(row.get::<_, i64>(12)?).to_f64_dp2(),
                    "total_cash_sales": Cents::new(row.get::<_, i64>(13)?).to_f64_dp2(),
                    "total_card_sales": Cents::new(row.get::<_, i64>(14)?).to_f64_dp2(),
                    "branch_id": &bi,
                    "terminal_id": &ti,
                    "calculation_version": row.get::<_, i64>(17)?,
                    "payment_amount": row.get::<_, Option<i64>>(18)?
                        .map(|c| Cents::new(c).to_f64_dp2()),
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
            // W4b-ii: cents-with-real-fallback shim on 12 monetary columns.
            "SELECT id,
                    COALESCE(opening_amount_cents, CAST(ROUND(opening_amount * 100) AS INTEGER), 0),
                    COALESCE(closing_amount_cents, CAST(ROUND(closing_amount * 100) AS INTEGER)),
                    COALESCE(expected_amount_cents, CAST(ROUND(expected_amount * 100) AS INTEGER)),
                    COALESCE(variance_amount_cents, CAST(ROUND(variance_amount * 100) AS INTEGER)),
                    COALESCE(total_cash_sales_cents, CAST(ROUND(total_cash_sales * 100) AS INTEGER), 0),
                    COALESCE(total_card_sales_cents, CAST(ROUND(total_card_sales * 100) AS INTEGER), 0),
                    COALESCE(total_refunds_cents, CAST(ROUND(total_refunds * 100) AS INTEGER), 0),
                    COALESCE(total_expenses_cents, CAST(ROUND(total_expenses * 100) AS INTEGER), 0),
                    COALESCE(cash_drops_cents, CAST(ROUND(cash_drops * 100) AS INTEGER), 0),
                    COALESCE(driver_cash_given_cents, CAST(ROUND(driver_cash_given * 100) AS INTEGER), 0),
                    COALESCE(driver_cash_returned_cents, CAST(ROUND(driver_cash_returned * 100) AS INTEGER), 0),
                    COALESCE(total_staff_payments_cents, CAST(ROUND(total_staff_payments * 100) AS INTEGER), 0),
                    opened_at, closed_at, reconciled
             FROM cash_drawer_sessions WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "opening_amount": Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    "closing_amount": row.get::<_, Option<i64>>(2)?.map(|c| Cents::new(c).to_f64_dp2()),
                    "expected_amount": row.get::<_, Option<i64>>(3)?.map(|c| Cents::new(c).to_f64_dp2()),
                    "variance_amount": row.get::<_, Option<i64>>(4)?.map(|c| Cents::new(c).to_f64_dp2()),
                    "total_cash_sales": Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                    "total_card_sales": Cents::new(row.get::<_, i64>(6)?).to_f64_dp2(),
                    "total_refunds": Cents::new(row.get::<_, i64>(7)?).to_f64_dp2(),
                    "total_expenses": Cents::new(row.get::<_, i64>(8)?).to_f64_dp2(),
                    "cash_drops": Cents::new(row.get::<_, i64>(9)?).to_f64_dp2(),
                    "driver_cash_given": Cents::new(row.get::<_, i64>(10)?).to_f64_dp2(),
                    "driver_cash_returned": Cents::new(row.get::<_, i64>(11)?).to_f64_dp2(),
                    "total_staff_payments": Cents::new(row.get::<_, i64>(12)?).to_f64_dp2(),
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
    // W6: `orders.payment_method` was dropped in v55. Derive the method
    // per cancelled order inline via a subquery that matches
    // `payments::derive_payment_method` semantics (multi-method =
    // "split"; one method = that method; zero rows =
    // "pending"). The consumer at `canceled_rows.iter().find(|r| r.0 ==
    // "cash")` etc. only keys on "cash"/"card" buckets; the new
    // "pending" bucket (for fully-voided cancels) is silently
    // discarded, matching the old behavior where cancelled orders
    // without a stored method defaulted to 'cash' then were still
    // bucketed correctly by the consumer.
    let canceled_sql = format!(
        "SELECT COALESCE((
                SELECT CASE
                    WHEN COUNT(DISTINCT LOWER(TRIM(method))) > 1
                      THEN 'split'
                    ELSE LOWER(TRIM(MIN(method)))
                END
                FROM order_payments
                WHERE order_id = orders.id
                  AND status = 'completed'
                  AND TRIM(COALESCE(method, '')) != ''
            ), 'pending') AS pm,
            COUNT(*),
            COALESCE(SUM(COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER))), 0)
         FROM orders
         WHERE staff_shift_id = ?1
           AND COALESCE(is_ghost, 0) = 0
           AND status IN ('cancelled', 'canceled', 'refunded')
           {}
         GROUP BY pm",
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
                // W4b-ii: SUM is integer cents now; expose as f64 to
                // keep the existing tuple type and downstream JSON
                // shape (canceled_orders.cashTotal/cardTotal).
                Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
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
    // W4b-ii: cents-with-real-fallback shim (removed in 4e).
    let cash_refunds: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER))), 0)
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
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    // --- 6. Expense items array + total ---
    let mut exp_stmt = conn
        .prepare(
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            "SELECT id, expense_type,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    description, receipt_number, status, created_at
             FROM shift_expenses WHERE staff_shift_id = ?1
             ORDER BY created_at ASC",
        )
        .map_err(|e| format!("prepare expenses: {e}"))?;

    let expense_items: Vec<Value> = exp_stmt
        .query_map(params![shift_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "expense_type": row.get::<_, String>(1)?,
                "amount": Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
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

    // --- 7. Tips credited to this exact staff shift ---
    // Payment collection and tip ownership are intentionally independent:
    // a cashier may collect a waiter/driver tip. Attribute by the durable
    // recipient shift written on order_payments, never by the payment owner.
    let tip_sql = format!(
        "SELECT op.id, op.order_id, o.order_number,
                COALESCE(
                    op.tip_amount_cents,
                    CAST(ROUND(op.tip_amount * 100) AS INTEGER),
                    0
                ),
                op.tip_recipient_role, op.created_at
         FROM order_payments op
         JOIN orders o ON o.id = op.order_id
         WHERE op.tip_recipient_staff_shift_id = ?1
           AND op.status = 'completed'
           AND COALESCE(o.is_ghost, 0) = 0
           AND o.status NOT IN ('cancelled', 'canceled', 'refunded')
           AND {order_financial_expr} >= ?2
           AND (?3 IS NULL OR {order_financial_expr} <= ?3)
         ORDER BY op.created_at ASC"
    );
    let mut tip_stmt = conn
        .prepare(&tip_sql)
        .map_err(|e| format!("prepare shift tip allocations: {e}"))?;
    let tip_allocations: Vec<Value> = tip_stmt
        .query_map(params![shift_id, check_in_time, shift_end_param], |row| {
            Ok(serde_json::json!({
                "paymentId": row.get::<_, String>(0)?,
                "orderId": row.get::<_, String>(1)?,
                "orderNumber": row.get::<_, Option<String>>(2)?,
                "amount": Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                "recipientRole": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, String>(5)?,
            }))
        })
        .map_err(|e| format!("query shift tip allocations: {e}"))?
        .filter_map(Result::ok)
        .collect();
    let tips_received = tip_allocations
        .iter()
        .map(|entry| entry["amount"].as_f64().unwrap_or(0.0))
        .sum::<f64>();

    // --- 8. Driver data (role-dependent) ---
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
            // W6: `orders.payment_method` was dropped in v55. Drop the
            // column from the SELECT; the Rust re-derives the method
            // from `order_payments` sums below anyway (cash/card
            // conditional), so the stored column was only a fallback
            // for the no-payment-rows case where it always defaulted to
            // 'cash' on NULL. Keep that default explicitly.
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            let mut missing_stmt = conn
                .prepare(
                    "SELECT o.id,
                            COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0),
                            COALESCE(o.delivery_fee_cents, CAST(ROUND(o.delivery_fee * 100) AS INTEGER), 0),
                            o.branch_id
                     FROM orders o
                     WHERE (o.driver_id = ?1 OR o.staff_shift_id = ?2)
                       AND o.order_type = 'delivery'
                       AND COALESCE(o.is_ghost, 0) = 0
                       AND o.created_at >= ?3
                       AND NOT EXISTS (SELECT 1 FROM driver_earnings de WHERE de.order_id = o.id)",
                )
                .map_err(|e| format!("prepare backfill: {e}"))?;
            let now = chrono::Utc::now().to_rfc3339();
            let backfill_rows: Vec<(String, f64, f64, String)> = missing_stmt
                .query_map(params![driver_staff_id, shift_id, check_in_time], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        // W4b-ii: cents → f64-dp2.
                        Cents::new(row.get::<_, i64>(1).unwrap_or(0)).to_f64_dp2(),
                        Cents::new(row.get::<_, i64>(2).unwrap_or(0)).to_f64_dp2(),
                        row.get::<_, String>(3).unwrap_or_default(),
                    ))
                })
                .map_err(|e| format!("backfill query: {e}"))?
                .filter_map(|r| r.ok())
                .collect();

            for (oid, total, del_fee, bid) in &backfill_rows {
                let (_, cash, card, _total_paid) =
                    compute_shift_payment_totals_for_order(&conn, oid, *total, "cash")?;
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
                // W4b-ii: cents-with-real-fallback shim on 7 monetary cols.
                "SELECT de.id, de.order_id,
                        COALESCE(de.delivery_fee_cents, CAST(ROUND(de.delivery_fee * 100) AS INTEGER), 0),
                        COALESCE(de.tip_amount_cents, CAST(ROUND(de.tip_amount * 100) AS INTEGER), 0),
                        COALESCE(de.total_earning_cents, CAST(ROUND(de.total_earning * 100) AS INTEGER), 0),
                        de.payment_method,
                        COALESCE(de.cash_collected_cents, CAST(ROUND(de.cash_collected * 100) AS INTEGER), 0),
                        COALESCE(de.card_amount_cents, CAST(ROUND(de.card_amount * 100) AS INTEGER), 0),
                        COALESCE(de.cash_to_return_cents, CAST(ROUND(de.cash_to_return * 100) AS INTEGER), 0),
                        o.order_number, o.delivery_address,
                        COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER)),
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
                    "delivery_fee": Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                    "tip_amount": Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
                    "total_earning": Cents::new(row.get::<_, i64>(4)?).to_f64_dp2(),
                    "payment_method": row.get::<_, String>(5)?,
                    "cash_collected": Cents::new(row.get::<_, i64>(6)?).to_f64_dp2(),
                    "card_amount": Cents::new(row.get::<_, i64>(7)?).to_f64_dp2(),
                    "cash_to_return": Cents::new(row.get::<_, i64>(8)?).to_f64_dp2(),
                    "order_number": row.get::<_, Option<String>>(9)?,
                    "delivery_address": row.get::<_, Option<String>>(10)?,
                    "total_amount": row.get::<_, Option<i64>>(11)?
                        .map(|c| Cents::new(c).to_f64_dp2()),
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
        "tipsReceived": tips_received,
        "tipAllocations": tip_allocations,
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
        // W4c dual-write: shift_expenses.amount and cash_drawer_sessions.total_expenses.
        let amount_cents = Cents::round_half_even(amount).as_i64();
        conn.execute(
            "INSERT INTO shift_expenses (
                id, staff_shift_id, staff_id, branch_id, expense_type,
                amount, amount_cents, description, receipt_number, status, sync_status,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 'pending', ?10, ?10)",
            params![
                expense_id,
                shift_id,
                staff_id,
                branch_id,
                expense_type,
                amount,
                amount_cents,
                description,
                receipt_number,
                now,
            ],
        )
        .map_err(|e| format!("insert expense: {e}"))?;

        // Update cash drawer total_expenses (if cashier/manager).
        conn.execute(
            "UPDATE cash_drawer_sessions SET
                total_expenses = COALESCE(total_expenses, 0) + ?1,
                total_expenses_cents = COALESCE(total_expenses_cents, 0) + ?2,
                updated_at = ?3
             WHERE staff_shift_id = ?4",
            params![amount, amount_cents, now, shift_id],
        )
        .map_err(|e| format!("update drawer expenses: {e}"))?;

        // Wave 5 Session 6: enqueue via canonical parity queue. Idempotency
        // key now flows from `shift_expenses.idempotency_key` (populated by
        // v47/v49) inside `prepare_financial_request`, so the producer no
        // longer stamps a volatile UUID per-enqueue (C17).
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
        });

        sync_queue::enqueue_payload_item(
            &conn,
            "shift_expenses",
            &expense_id,
            "INSERT",
            &sync_payload,
            Some(1),
            Some("financial"),
            Some("manual"),
            Some(1),
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
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            "SELECT id, staff_shift_id, staff_id, branch_id, expense_type,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0),
                    description, receipt_number, status,
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
                "shift_id": row.get::<_, String>(1)?,
                "staff_id": row.get::<_, String>(2)?,
                "branch_id": row.get::<_, String>(3)?,
                "expense_type": row.get::<_, String>(4)?,
                "amount": Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                "description": row.get::<_, String>(6)?,
                "receipt_number": row.get::<_, Option<String>>(7)?,
                "status": row.get::<_, String>(8)?,
                "approved_by": row.get::<_, Option<String>>(9)?,
                "approved_at": row.get::<_, Option<String>>(10)?,
                "rejection_reason": row.get::<_, Option<String>>(11)?,
                "created_at": row.get::<_, String>(12)?,
                "updated_at": row.get::<_, String>(13)?,
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

/// Delete a previously recorded shift expense.
///
/// Removes the local row, recomputes the owning drawer's expense total, and
/// enqueues a canonical delete sync row after clearing any unfinished queue
/// rows for the same expense so the stale local insert cannot be replayed.
pub fn delete_expense(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let expense_id = str_field(payload, "expenseId")
        .or_else(|| str_field(payload, "expense_id"))
        .or_else(|| str_field(payload, "id"))
        .ok_or("Missing expenseId")?;
    let shift_id = str_field(payload, "shiftId")
        .or_else(|| str_field(payload, "shift_id"))
        .or_else(|| str_field(payload, "staffShiftId"))
        .or_else(|| str_field(payload, "staff_shift_id"))
        .ok_or("Missing shiftId")?;

    // W4b-ii: cents-with-real-fallback shim (removed in 4e).
    let expense_row: Option<(String, String, f64)> = conn
        .query_row(
            "SELECT staff_shift_id, branch_id,
                    COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER), 0)
             FROM shift_expenses
             WHERE id = ?1",
            params![expense_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                ))
            },
        )
        .optional()
        .map_err(|e| format!("load expense: {e}"))?;

    let Some((stored_shift_id, branch_id, amount)) = expense_row else {
        return Err("Expense not found".into());
    };

    if stored_shift_id != shift_id {
        return Err(format!("Expense does not belong to shift {shift_id}"));
    }

    let now = Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "DELETE FROM shift_expenses WHERE id = ?1",
            params![expense_id],
        )
        .map_err(|e| format!("delete expense: {e}"))?;

        let remaining_total = compute_shift_expenses_total(&conn, &stored_shift_id);
        // W4c dual-write: recompute_drawer_expenses → cents sibling.
        let remaining_total_cents = Cents::round_half_even(remaining_total).as_i64();
        conn.execute(
            "UPDATE cash_drawer_sessions SET
                total_expenses = ?1,
                total_expenses_cents = ?2,
                updated_at = ?3
             WHERE staff_shift_id = ?4",
            params![remaining_total, remaining_total_cents, now, stored_shift_id],
        )
        .map_err(|e| format!("recompute drawer expenses: {e}"))?;

        // Clear lingering legacy-queue rows for this expense. Session 7 will
        // seal/drop the legacy table once all deployed terminals have drained
        // their backlog; until then, transitional producers must continue to
        // invalidate pre-migration rows so the DELETE is authoritative.
        conn.execute(
            "DELETE FROM sync_queue
             WHERE entity_type = 'shift_expense'
               AND entity_id = ?1
               AND status NOT IN ('synced', 'applied')",
            params![expense_id],
        )
        .map_err(|e| format!("clear unfinished legacy expense queue rows: {e}"))?;

        // Clear lingering parity-queue rows so the pending INSERT is superseded.
        sync_queue::clear_unsynced_items(&conn, "shift_expenses", &expense_id)
            .map_err(|e| format!("clear unfinished parity expense queue rows: {e}"))?;

        let sync_payload = serde_json::json!({
            "expenseId": expense_id,
            "shiftId": stored_shift_id,
            "staffShiftId": stored_shift_id,
            "branchId": branch_id,
            "amount": amount,
            "deletedAt": now,
        });

        sync_queue::enqueue_payload_item(
            &conn,
            "shift_expenses",
            &expense_id,
            "DELETE",
            &sync_payload,
            Some(1),
            Some("financial"),
            Some("manual"),
            Some(1),
        )
        .map_err(|e| format!("enqueue expense delete sync: {e}"))?;

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
        expense_id = %expense_id,
        shift_id = %stored_shift_id,
        amount = %amount,
        "Expense deleted"
    );

    Ok(serde_json::json!({
        "success": true,
        "expenseId": expense_id,
        "shiftId": stored_shift_id,
    }))
}

// ---------------------------------------------------------------------------
// Staff payment management
// ---------------------------------------------------------------------------

pub(crate) fn ensure_staff_payments_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS staff_payments (
            id TEXT PRIMARY KEY,
            cashier_shift_id TEXT NOT NULL,
            paid_to_staff_id TEXT NOT NULL,
            amount REAL NOT NULL,
            payment_type TEXT NOT NULL DEFAULT 'wage',
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_staff_payments_cashier_shift_id
            ON staff_payments(cashier_shift_id);
        CREATE INDEX IF NOT EXISTS idx_staff_payments_paid_to_staff_id
            ON staff_payments(paid_to_staff_id);
        CREATE INDEX IF NOT EXISTS idx_staff_payments_created_at
            ON staff_payments(created_at);
        ",
    )
    .map_err(|e| format!("ensure staff_payments table: {e}"))?;

    let has_updated_at: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM pragma_table_info('staff_payments')
                WHERE name = 'updated_at'
            )",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !has_updated_at {
        conn.execute(
            "ALTER TABLE staff_payments
             ADD COLUMN updated_at TEXT",
            [],
        )
        .map_err(|e| format!("add staff_payments.updated_at: {e}"))?;
    }

    conn.execute(
        "UPDATE staff_payments
         SET updated_at = COALESCE(NULLIF(trim(updated_at), ''), created_at)
         WHERE updated_at IS NULL OR trim(updated_at) = ''",
        [],
    )
    .map_err(|e| format!("backfill staff_payments.updated_at: {e}"))?;

    Ok(())
}

fn compute_staff_payments_total(conn: &Connection, cashier_shift_id: &str) -> Result<f64, String> {
    ensure_staff_payments_table(conn)?;
    conn.query_row(
        "SELECT COALESCE(SUM(amount), 0)
         FROM staff_payments
         WHERE cashier_shift_id = ?1",
        params![cashier_shift_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("compute staff payment total: {e}"))
}

/// Clear unfinished sync rows for an entity across BOTH queues. Session 7
/// will seal/drop the legacy `sync_queue` once deployed terminals drain;
/// until then, helpers that supersede a pending mutation must invalidate
/// rows on both tables so the new canonical row is authoritative.
///
/// `legacy_entity_type` is the `sync_queue.entity_type` value (e.g. `"shift"`,
/// `"staff_payment"`). `parity_table_name` is the matching `parity_sync_queue.table_name`
/// value (e.g. `"staff_shifts"`, `"staff_payments"`).
fn clear_unfinished_sync_queue_rows(
    conn: &Connection,
    legacy_entity_type: &str,
    parity_table_name: &str,
    entity_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM sync_queue
         WHERE entity_type = ?1
           AND entity_id = ?2
           AND status NOT IN ('synced', 'applied')",
        params![legacy_entity_type, entity_id],
    )
    .map_err(|e| format!("clear unfinished {legacy_entity_type} legacy queue rows: {e}"))?;
    sync_queue::clear_unsynced_items(conn, parity_table_name, entity_id)
        .map_err(|e| format!("clear unfinished {parity_table_name} parity queue rows: {e}"))?;
    Ok(())
}

fn recompute_active_cashier_staff_payment_total(
    conn: &Connection,
    cashier_shift_id: &str,
    written_at: &str,
) -> Result<f64, String> {
    let total_staff_payments = compute_staff_payments_total(conn, cashier_shift_id)?;
    // W4c dual-write: recompute_active_drawer_staff_payments → cents sibling.
    let total_staff_payments_cents = Cents::round_half_even(total_staff_payments).as_i64();
    let updated = conn
        .execute(
            "UPDATE cash_drawer_sessions
             SET total_staff_payments = ?1,
                 total_staff_payments_cents = ?2,
                 updated_at = ?3
             WHERE staff_shift_id = ?4",
            params![
                total_staff_payments,
                total_staff_payments_cents,
                written_at,
                cashier_shift_id
            ],
        )
        .map_err(|e| format!("recompute active drawer staff payments: {e}"))?;

    if updated == 0 {
        return Err(format!(
            "No cash drawer session found for cashier shift {cashier_shift_id}"
        ));
    }

    Ok(total_staff_payments)
}

pub(crate) fn recompute_closed_cashier_shift_financial_snapshot(
    conn: &Connection,
    shift_id: &str,
    written_at: &str,
) -> Result<(f64, f64), String> {
    let (
        role_type,
        opening_cash,
        _calc_version,
        check_in_time,
        check_out_time,
        closing_cash_amount,
    ): (String, f64, i64, String, String, f64) = conn
        .query_row(
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            "SELECT role_type,
                    COALESCE(opening_cash_amount_cents, CAST(ROUND(opening_cash_amount * 100) AS INTEGER), 0),
                    calculation_version,
                    check_in_time, check_out_time,
                    COALESCE(closing_cash_amount_cents, CAST(ROUND(closing_cash_amount * 100) AS INTEGER), 0)
             FROM staff_shifts
             WHERE id = ?1
               AND status = 'closed'",
            params![shift_id],
            |row| {
                Ok((
                    row.get(0)?,
                    Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    Cents::new(row.get::<_, i64>(5)?).to_f64_dp2(),
                ))
            },
        )
        .map_err(|e| format!("load closed shift context: {e}"))?;

    if role_type != "cashier" && role_type != "manager" {
        return Err(format!(
            "Staff payments can only be corrected on cashier or manager shifts ({shift_id})"
        ));
    }

    if check_out_time.trim().is_empty() {
        return Err(format!("Closed shift {shift_id} is missing check_out_time"));
    }

    let order_financial_expr = business_day::order_financial_timestamp_expr("o");

    let (
        reconciled_order_count,
        reconciled_cash_sales,
        reconciled_card_sales,
        reconciled_total_sales,
    ) = compute_shift_payment_totals_in_window(
        conn,
        shift_id,
        &role_type,
        Some(check_in_time.as_str()),
        Some(check_out_time.as_str()),
    )?;

    // W4b-ii: cents-with-real-fallback shim (removed in 4e).
    let reconciled_refunds: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(COALESCE(pa.amount_cents, CAST(ROUND(pa.amount * 100) AS INTEGER))), 0)
                 FROM orders o
                 JOIN payment_adjustments pa ON pa.order_id = o.id
                 LEFT JOIN order_payments op ON op.id = pa.payment_id
                 WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1
                   AND pa.adjustment_type = 'refund'
                   AND COALESCE(o.is_ghost, 0) = 0
                   AND {order_financial_expr} >= ?2
                   AND {order_financial_expr} <= ?3"
            ),
            params![shift_id, check_in_time, check_out_time],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    let reconciled_expenses: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
             FROM shift_expenses
             WHERE staff_shift_id = ?1
               AND (expense_type IS NULL OR expense_type != 'staff_payment')",
            params![shift_id],
            |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
        )
        .unwrap_or(0.0);

    let reconciled_staff_payments = compute_staff_payments_total(conn, shift_id)?;

    // W4c dual-write: reconciled drawer totals mirror onto cents siblings.
    let reconciled_cash_sales_cents = Cents::round_half_even(reconciled_cash_sales).as_i64();
    let reconciled_card_sales_cents = Cents::round_half_even(reconciled_card_sales).as_i64();
    let reconciled_refunds_cents = Cents::round_half_even(reconciled_refunds).as_i64();
    let reconciled_expenses_cents = Cents::round_half_even(reconciled_expenses).as_i64();
    let reconciled_staff_payments_cents =
        Cents::round_half_even(reconciled_staff_payments).as_i64();
    let drawer_updated = conn
        .execute(
            "UPDATE cash_drawer_sessions SET
                total_cash_sales = ?1, total_cash_sales_cents = ?2,
                total_card_sales = ?3, total_card_sales_cents = ?4,
                total_refunds = ?5, total_refunds_cents = ?6,
                total_expenses = ?7, total_expenses_cents = ?8,
                total_staff_payments = ?9, total_staff_payments_cents = ?10,
                updated_at = ?11
             WHERE staff_shift_id = ?12",
            params![
                reconciled_cash_sales,
                reconciled_cash_sales_cents,
                reconciled_card_sales,
                reconciled_card_sales_cents,
                reconciled_refunds,
                reconciled_refunds_cents,
                reconciled_expenses,
                reconciled_expenses_cents,
                reconciled_staff_payments,
                reconciled_staff_payments_cents,
                written_at,
                shift_id,
            ],
        )
        .map_err(|e| format!("recompute closed drawer totals: {e}"))?;

    if drawer_updated == 0 {
        return Err(format!(
            "No cash drawer session found for closed cashier shift {shift_id}"
        ));
    }

    // W4b-ii: cents-with-real-fallback shim (removed in 4e).
    let (cash_drops, driver_cash_given, driver_cash_returned): (f64, f64, f64) = conn
        .query_row(
            "SELECT COALESCE(cash_drops_cents, CAST(ROUND(cash_drops * 100) AS INTEGER), 0),
                    COALESCE(driver_cash_given_cents, CAST(ROUND(driver_cash_given * 100) AS INTEGER), 0),
                    COALESCE(driver_cash_returned_cents, CAST(ROUND(driver_cash_returned * 100) AS INTEGER), 0)
             FROM cash_drawer_sessions
             WHERE staff_shift_id = ?1",
            params![shift_id],
            |row| {
                Ok((
                    Cents::new(row.get::<_, i64>(0)?).to_f64_dp2(),
                    Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
                    Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
                ))
            },
        )
        .map_err(|e| format!("load closed drawer cash movement totals: {e}"))?;

    // calc_version currently has no behavioural difference for staff-payment
    // deduction; both V1 and V2 use `reconciled_staff_payments` directly.
    // Keeping the binding makes the intent explicit if a future calc_version
    // wants to diverge.
    let deducted_staff_payments = reconciled_staff_payments;

    let inherited_driver_expected_returns =
        compute_inherited_cash_staff_expected_returns(conn, shift_id, &check_in_time)?;

    let expected = opening_cash + reconciled_cash_sales
        - reconciled_refunds
        - reconciled_expenses
        - deducted_staff_payments
        - cash_drops
        - driver_cash_given
        + driver_cash_returned
        + inherited_driver_expected_returns;
    let variance = closing_cash_amount - expected;

    // W4c dual-write: corrected expected/variance and shift snapshot mirror.
    let expected_cents_corrected = Cents::round_half_even(expected).as_i64();
    let variance_cents_corrected = Cents::round_half_even(variance).as_i64();
    let reconciled_total_sales_cents = Cents::round_half_even(reconciled_total_sales).as_i64();
    conn.execute(
        "UPDATE cash_drawer_sessions SET
            expected_amount = ?1, expected_amount_cents = ?2,
            variance_amount = ?3, variance_amount_cents = ?4,
            updated_at = ?5
         WHERE staff_shift_id = ?6",
        params![
            expected,
            expected_cents_corrected,
            variance,
            variance_cents_corrected,
            written_at,
            shift_id
        ],
    )
    .map_err(|e| format!("update corrected closed drawer snapshot: {e}"))?;

    conn.execute(
        "UPDATE staff_shifts SET
            expected_cash_amount = ?1, expected_cash_amount_cents = ?2,
            cash_variance = ?3, cash_variance_cents = ?4,
            total_orders_count = ?5,
            total_sales_amount = ?6, total_sales_amount_cents = ?7,
            total_cash_sales = ?8, total_cash_sales_cents = ?9,
            total_card_sales = ?10, total_card_sales_cents = ?11,
            sync_status = 'pending',
            updated_at = ?12
         WHERE id = ?13",
        params![
            expected,
            expected_cents_corrected,
            variance,
            variance_cents_corrected,
            reconciled_order_count,
            reconciled_total_sales,
            reconciled_total_sales_cents,
            reconciled_cash_sales,
            reconciled_cash_sales_cents,
            reconciled_card_sales,
            reconciled_card_sales_cents,
            written_at,
            shift_id,
        ],
    )
    .map_err(|e| format!("update corrected closed shift snapshot: {e}"))?;

    Ok((expected, variance))
}

fn build_shift_update_sync_payload_from_db(
    conn: &Connection,
    shift_id: &str,
) -> Result<String, String> {
    let (
        staff_id,
        staff_name,
        branch_id,
        terminal_id,
        role_type,
        opening_cash,
        check_in_time,
        check_out_time,
        report_date,
        period_start_at,
        calculation_version,
        total_orders_count,
        total_sales_amount,
        total_cash_sales,
        total_card_sales,
        closing_cash_amount,
        expected_cash_amount,
        cash_variance,
        payment_amount,
        closed_by,
    ): (
        String,
        Option<String>,
        String,
        String,
        String,
        f64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        i64,
        f64,
        f64,
        f64,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT staff_id, staff_name, branch_id, terminal_id, role_type,
                    opening_cash_amount, check_in_time, check_out_time,
                    report_date, period_start_at, calculation_version,
                    total_orders_count, total_sales_amount, total_cash_sales,
                    total_card_sales, closing_cash_amount, expected_cash_amount,
                    cash_variance, payment_amount, closed_by
             FROM staff_shifts
             WHERE id = ?1",
            params![shift_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                    row.get(18)?,
                    row.get(19)?,
                ))
            },
        )
        .map_err(|e| format!("load shift sync payload source: {e}"))?;

    let fallback_at = check_out_time.as_deref().unwrap_or(&check_in_time);
    let shift_business_day = resolve_shift_business_day_context(
        conn,
        &branch_id,
        fallback_at,
        report_date.as_deref(),
        period_start_at.as_deref(),
    );

    // W4d-i: emit BOTH legacy float and integer cents keys for the 8
    // monetary shift-update fields. Admin-dashboard still reads the
    // float keys; cents are forward-compat.
    let mut payload = serde_json::json!({
        "shiftId": shift_id,
        "staffId": staff_id,
        "staffName": staff_name,
        "branchId": branch_id,
        "terminalId": terminal_id,
        "roleType": role_type,
        "openingCash": opening_cash,
        "opening_cash_cents": Cents::round_half_even(opening_cash).as_i64(),
        "checkInTime": check_in_time,
        "checkOutTime": check_out_time,
        "reportDate": shift_business_day.report_date,
        "periodStartAt": shift_business_day.period_start_at,
        "calculationVersion": calculation_version,
        "totalOrdersCount": total_orders_count,
        "totalSalesAmount": total_sales_amount,
        "total_sales_amount_cents": Cents::round_half_even(total_sales_amount).as_i64(),
        "totalCashSales": total_cash_sales,
        "total_cash_sales_cents": Cents::round_half_even(total_cash_sales).as_i64(),
        "totalCardSales": total_card_sales,
        "total_card_sales_cents": Cents::round_half_even(total_card_sales).as_i64(),
        "closingCash": closing_cash_amount,
        "closing_cash_cents": closing_cash_amount.map(|v| Cents::round_half_even(v).as_i64()),
        "expectedCash": expected_cash_amount,
        "expected_cash_cents": expected_cash_amount.map(|v| Cents::round_half_even(v).as_i64()),
        "variance": cash_variance,
        "cash_variance_cents": cash_variance.map(|v| Cents::round_half_even(v).as_i64()),
        "closedBy": closed_by,
        "paymentAmount": payment_amount,
        "payment_amount_cents": payment_amount.map(|v| Cents::round_half_even(v).as_i64()),
    });

    if let Some(drawer_snapshot) = load_cash_drawer_snapshot_for_shift(conn, shift_id)? {
        payload["cashDrawer"] = drawer_snapshot;
    }

    Ok(payload.to_string())
}

pub(crate) fn replace_unfinished_shift_sync_rows_with_current_snapshot(
    conn: &Connection,
    shift_id: &str,
    _written_at: &str,
) -> Result<(), String> {
    clear_unfinished_sync_queue_rows(conn, "shift", "staff_shifts", shift_id)?;

    // Wave 5 Session 6: corrected-snapshot shift UPDATE flows through the
    // parity queue. `build_shift_update_sync_payload_from_db` currently
    // returns a String (legacy API), so we parse it back to Value so the
    // parity helper can accept it without double-stringification.
    let sync_payload_str = build_shift_update_sync_payload_from_db(conn, shift_id)?;
    let sync_payload: Value = serde_json::from_str(&sync_payload_str)
        .map_err(|e| format!("parse corrected shift snapshot payload: {e}"))?;

    sync_queue::enqueue_payload_item(
        conn,
        "staff_shifts",
        shift_id,
        "UPDATE",
        &sync_payload,
        Some(1),
        Some("shifts"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("enqueue corrected shift snapshot sync: {e}"))?;

    Ok(())
}

fn build_staff_payment_sync_payload(
    payment_id: &str,
    cashier_shift_id: &str,
    paid_to_staff_id: &str,
    amount: f64,
    payment_type: &str,
    notes: Option<&str>,
    created_at: &str,
    updated_at: &str,
) -> String {
    // W4d-i: emit BOTH `amount` (legacy float) and `amount_cents` (new
    // integer). Admin-dashboard still reads the float key.
    serde_json::json!({
        "id": payment_id,
        "cashierShiftId": cashier_shift_id,
        "paidByCashierShiftId": cashier_shift_id,
        "paidToStaffId": paid_to_staff_id,
        "amount": amount,
        "amount_cents": Cents::round_half_even(amount).as_i64(),
        "paymentType": payment_type,
        "notes": notes,
        "createdAt": created_at,
        "updatedAt": updated_at,
    })
    .to_string()
}

fn enqueue_staff_payment_upsert_sync(
    conn: &Connection,
    payment_id: &str,
    cashier_shift_id: &str,
    paid_to_staff_id: &str,
    amount: f64,
    payment_type: &str,
    notes: Option<&str>,
    created_at: &str,
    updated_at: &str,
    operation: &str,
) -> Result<(), String> {
    clear_unfinished_sync_queue_rows(conn, "staff_payment", "staff_payments", payment_id)?;

    // Wave 5 Session 6: staff_payments upsert flows through the parity
    // queue's financial dispatcher (/api/pos/financial/sync via
    // prepare_financial_request on table_name="staff_payments"). Note:
    // staff_payments was explicitly excluded from v47 (per db.rs:3056) so
    // the idempotency key falls back to the deterministic synthetic
    // `entity:staff_payments:{payment_id}` — still stable enough for
    // exactly-once because the payment id never changes across retries.
    let sync_payload_str = build_staff_payment_sync_payload(
        payment_id,
        cashier_shift_id,
        paid_to_staff_id,
        amount,
        payment_type,
        notes,
        created_at,
        updated_at,
    );
    let sync_payload: Value = serde_json::from_str(&sync_payload_str)
        .map_err(|e| format!("parse staff payment upsert payload: {e}"))?;

    let parity_op = operation.to_uppercase();
    sync_queue::enqueue_payload_item(
        conn,
        "staff_payments",
        payment_id,
        &parity_op,
        &sync_payload,
        Some(1),
        Some("financial"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("enqueue staff payment {operation} sync: {e}"))?;

    Ok(())
}

fn enqueue_staff_payment_delete_sync(
    conn: &Connection,
    payment_id: &str,
    cashier_shift_id: &str,
    paid_to_staff_id: &str,
    deleted_at: &str,
) -> Result<(), String> {
    clear_unfinished_sync_queue_rows(conn, "staff_payment", "staff_payments", payment_id)?;

    let sync_payload = serde_json::json!({
        "id": payment_id,
        "cashierShiftId": cashier_shift_id,
        "paidByCashierShiftId": cashier_shift_id,
        "paidToStaffId": paid_to_staff_id,
        "deletedAt": deleted_at,
        "updatedAt": deleted_at,
    });

    sync_queue::enqueue_payload_item(
        conn,
        "staff_payments",
        payment_id,
        "DELETE",
        &sync_payload,
        Some(1),
        Some("financial"),
        Some("manual"),
        Some(1),
    )
    .map_err(|e| format!("enqueue staff payment delete sync: {e}"))?;

    Ok(())
}

fn reconcile_cashier_shift_after_staff_payment_mutation(
    conn: &Connection,
    shift_id: &str,
    written_at: &str,
) -> Result<(), String> {
    let (role_type, status): (String, String) = conn
        .query_row(
            "SELECT role_type, status
             FROM staff_shifts
             WHERE id = ?1",
            params![shift_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("load shift role/status for staff payment correction: {e}"))?;

    if role_type != "cashier" && role_type != "manager" {
        return Err(format!(
            "Staff payments can only be corrected on cashier or manager shifts ({shift_id})"
        ));
    }

    if status == "closed" {
        recompute_closed_cashier_shift_financial_snapshot(conn, shift_id, written_at)?;
        replace_unfinished_shift_sync_rows_with_current_snapshot(conn, shift_id, written_at)?;
    } else {
        recompute_active_cashier_staff_payment_total(conn, shift_id, written_at)?;
    }

    Ok(())
}

pub fn record_staff_payment(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    let cashier_shift_id = str_field(payload, "cashierShiftId")
        .or_else(|| str_field(payload, "cashier_shift_id"))
        .ok_or("Missing cashierShiftId")?;
    let paid_to_staff_id = str_field(payload, "paidToStaffId")
        .or_else(|| str_field(payload, "paid_to_staff_id"))
        .or_else(|| str_field(payload, "recipientStaffId"))
        .or_else(|| str_field(payload, "recipient_staff_id"))
        .or_else(|| str_field(payload, "staffId"))
        .or_else(|| str_field(payload, "staff_id"))
        .ok_or("Missing paidToStaffId")?;
    let amount = num_field(payload, "amount").ok_or("Missing amount")?;
    if amount <= 0.0 {
        return Err("Amount must be positive".into());
    }
    let payment_type = str_field(payload, "paymentType")
        .or_else(|| str_field(payload, "payment_type"))
        .unwrap_or_else(|| "wage".to_string());
    let notes = str_field(payload, "notes");

    let role_type: String = conn
        .query_row(
            "SELECT role_type
             FROM staff_shifts
             WHERE id = ?1",
            params![cashier_shift_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("load cashier shift for staff payment: {e}"))?;
    if role_type != "cashier" && role_type != "manager" {
        return Err("Staff payments require a cashier or manager drawer".into());
    }

    let payment_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type,
                notes, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                payment_id,
                cashier_shift_id,
                paid_to_staff_id,
                amount,
                payment_type,
                notes,
                now,
            ],
        )
        .map_err(|e| format!("insert staff payment: {e}"))?;

        reconcile_cashier_shift_after_staff_payment_mutation(&conn, &cashier_shift_id, &now)?;
        enqueue_staff_payment_upsert_sync(
            &conn,
            &payment_id,
            &cashier_shift_id,
            &paid_to_staff_id,
            amount,
            &payment_type,
            notes.as_deref(),
            &now,
            &now,
            "insert",
        )?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id,
    }))
}

pub fn update_staff_payment(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    let payment_id = str_field(payload, "paymentId")
        .or_else(|| str_field(payload, "payment_id"))
        .or_else(|| str_field(payload, "id"))
        .ok_or("Missing paymentId")?;
    let cashier_shift_id = str_field(payload, "cashierShiftId")
        .or_else(|| str_field(payload, "cashier_shift_id"))
        .ok_or("Missing cashierShiftId")?;
    let paid_to_staff_id = str_field(payload, "paidToStaffId")
        .or_else(|| str_field(payload, "paid_to_staff_id"))
        .or_else(|| str_field(payload, "recipientStaffId"))
        .or_else(|| str_field(payload, "recipient_staff_id"))
        .or_else(|| str_field(payload, "staffId"))
        .or_else(|| str_field(payload, "staff_id"))
        .ok_or("Missing paidToStaffId")?;
    let amount = num_field(payload, "amount").ok_or("Missing amount")?;
    if amount <= 0.0 {
        return Err("Amount must be positive".into());
    }
    let payment_type = str_field(payload, "paymentType")
        .or_else(|| str_field(payload, "payment_type"))
        .unwrap_or_else(|| "wage".to_string());
    let notes = str_field(payload, "notes");

    let (stored_shift_id, created_at): (String, String) = conn
        .query_row(
            "SELECT cashier_shift_id, created_at
             FROM staff_payments
             WHERE id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Staff payment not found".to_string())?;

    if stored_shift_id != cashier_shift_id {
        return Err(format!(
            "Staff payment does not belong to cashier shift {cashier_shift_id}"
        ));
    }

    let now = Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "UPDATE staff_payments
             SET paid_to_staff_id = ?1,
                 amount = ?2,
                 payment_type = ?3,
                 notes = ?4,
                 updated_at = ?5
             WHERE id = ?6",
            params![
                paid_to_staff_id,
                amount,
                payment_type,
                notes,
                now,
                payment_id,
            ],
        )
        .map_err(|e| format!("update staff payment: {e}"))?;

        reconcile_cashier_shift_after_staff_payment_mutation(&conn, &cashier_shift_id, &now)?;
        enqueue_staff_payment_upsert_sync(
            &conn,
            &payment_id,
            &cashier_shift_id,
            &paid_to_staff_id,
            amount,
            &payment_type,
            notes.as_deref(),
            &created_at,
            &now,
            "update",
        )?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id,
    }))
}

pub fn delete_staff_payment(db: &DbState, payload: &Value) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    ensure_staff_payments_table(&conn)?;

    let payment_id = str_field(payload, "paymentId")
        .or_else(|| str_field(payload, "payment_id"))
        .or_else(|| str_field(payload, "id"))
        .ok_or("Missing paymentId")?;
    let cashier_shift_id = str_field(payload, "cashierShiftId")
        .or_else(|| str_field(payload, "cashier_shift_id"))
        .ok_or("Missing cashierShiftId")?;

    let (stored_shift_id, paid_to_staff_id): (String, String) = conn
        .query_row(
            "SELECT cashier_shift_id, paid_to_staff_id
             FROM staff_payments
             WHERE id = ?1",
            params![payment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Staff payment not found".to_string())?;

    if stored_shift_id != cashier_shift_id {
        return Err(format!(
            "Staff payment does not belong to cashier shift {cashier_shift_id}"
        ));
    }

    let now = Utc::now().to_rfc3339();

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin transaction: {e}"))?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "DELETE FROM staff_payments WHERE id = ?1",
            params![payment_id],
        )
        .map_err(|e| format!("delete staff payment: {e}"))?;

        reconcile_cashier_shift_after_staff_payment_mutation(&conn, &cashier_shift_id, &now)?;
        enqueue_staff_payment_delete_sync(
            &conn,
            &payment_id,
            &cashier_shift_id,
            &paid_to_staff_id,
            &now,
        )?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit: {e}"))?;
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "paymentId": payment_id,
    }))
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

fn resolve_check_in_eligibility(
    conn: &rusqlite::Connection,
    branch_id: &str,
    terminal_id: &str,
) -> Result<CheckInEligibility, String> {
    let business_day_start_at = business_day::resolve_period_start(conn, branch_id, None);
    let has_cashier_for_business_day = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM staff_shifts
                WHERE role_type = 'cashier'
                  AND (?1 = '' OR branch_id = ?1 OR branch_id IS NULL)
                  AND (?2 = '' OR terminal_id = ?2 OR terminal_id IS NULL)
                  AND check_in_time >= ?3
            )",
            params![branch_id, terminal_id, business_day_start_at.as_str()],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| format!("query check-in eligibility: {e}"))?;

    Ok(CheckInEligibility {
        business_day_start_at,
        has_cashier_for_business_day,
    })
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
        // W4b-ii: cents-with-real-fallback shim (removed in 4e).
        "SELECT COALESCE(SUM(COALESCE(amount_cents, CAST(ROUND(amount * 100) AS INTEGER))), 0)
         FROM shift_expenses
         WHERE staff_shift_id = ?1
           AND (?2 IS NULL OR created_at >= ?2)
           AND (?3 IS NULL OR created_at <= ?3)",
        params![shift_id, window_start, window_end],
        |row| row.get::<_, i64>(0).map(|c| Cents::new(c).to_f64_dp2()),
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
            COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'cash' THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0) ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN op.status = 'completed' AND op.method = 'card' THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0) ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN op.status = 'completed' THEN COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER), 0) ELSE 0 END), 0)
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
        Ok((
            row.get(0)?,
            Cents::new(row.get::<_, i64>(1)?).to_f64_dp2(),
            Cents::new(row.get::<_, i64>(2)?).to_f64_dp2(),
            Cents::new(row.get::<_, i64>(3)?).to_f64_dp2(),
        ))
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
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            "SELECT id,
                    COALESCE(opening_cash_amount_cents, CAST(ROUND(opening_cash_amount * 100) AS INTEGER), 0)
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
                    Cents::new(row.get::<_, i64>(1).unwrap_or(0)).to_f64_dp2(),
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

        // Wave 5 Session 6: transfer-pending staff_shifts update routes
        // through parity's module_type="shifts" endpoint.
        let sync_payload = serde_json::json!({
            "shiftId": driver_shift_id,
            "isTransferPending": true,
            "transferredToCashierShiftId": null,
        });

        sync_queue::enqueue_payload_item(
            conn,
            "staff_shifts",
            driver_shift_id,
            "UPDATE",
            &sync_payload,
            Some(1),
            Some("shifts"),
            Some("manual"),
            Some(1),
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

        // Wave 5 Session 6: claim-transferred staff_shifts update routes
        // through parity's module_type="shifts" endpoint.
        let sync_payload = serde_json::json!({
            "shiftId": driver_shift_id,
            "transferredToCashierShiftId": new_cashier_shift_id,
            "isTransferPending": false,
        });

        sync_queue::enqueue_payload_item(
            conn,
            "staff_shifts",
            driver_shift_id,
            "UPDATE",
            &sync_payload,
            Some(1),
            Some("shifts"),
            Some("manual"),
            Some(1),
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
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            "SELECT ss.id, ss.role_type,
                    COALESCE(ss.opening_cash_amount_cents, CAST(ROUND(ss.opening_cash_amount * 100) AS INTEGER), 0)
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
                Cents::new(row.get::<_, i64>(2).unwrap_or(0)).to_f64_dp2(),
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
    // W6: derive payment method from `order_payments` instead of the
    // dropped `orders.payment_method` column. Matches the semantic of
    // `payments::derive_payment_method` (multi-method = "split").
    // The cashier UI consumes this value directly as the
    // presentation label.
    // W4b-ii: cents-with-real-fallback shim (removed in 4e).
    let sql = format!(
        "SELECT
                o.id,
                o.order_number,
                o.created_at,
                COALESCE(o.order_type, 'dine-in'),
                o.table_number,
                o.customer_name,
                o.status,
                COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0),
                COALESCE((
                    SELECT CASE
                        WHEN COUNT(DISTINCT LOWER(TRIM(method))) > 1
                          THEN 'split'
                        ELSE LOWER(TRIM(MIN(method)))
                    END
                    FROM order_payments op2
                    WHERE op2.order_id = o.id
                      AND op2.status = 'completed'
                      AND TRIM(COALESCE(op2.method, '')) != ''
                ), 'pending'),
                COALESCE((
                    SELECT SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)))
                    FROM order_payments op
                    WHERE op.order_id = o.id
                      AND op.status = 'completed'
                      AND op.method = 'cash'
                ), 0),
                COALESCE((
                    SELECT SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)))
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
                    Cents::new(row.get::<_, i64>(7).unwrap_or(0)).to_f64_dp2(),
                    row.get::<_, String>(8)?,
                    Cents::new(row.get::<_, i64>(9).unwrap_or(0)).to_f64_dp2(),
                    Cents::new(row.get::<_, i64>(10).unwrap_or(0)).to_f64_dp2(),
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
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            "SELECT ss.id, ss.staff_id, ss.staff_name,
                    COALESCE(ss.opening_cash_amount_cents, CAST(ROUND(ss.opening_cash_amount * 100) AS INTEGER), 0),
                    ss.check_in_time
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
                    Cents::new(row.get::<_, i64>(3).unwrap_or(0)).to_f64_dp2(),
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
    ensure_staff_payments_table(conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT sp.id, sp.cashier_shift_id, sp.paid_to_staff_id, sp.amount, sp.payment_type,
                    sp.notes, sp.created_at, sp.updated_at,
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
                "cashier_shift_id": row.get::<_, String>(1)?,
                "staff_id": row.get::<_, String>(2)?,
                "paid_to_staff_id": row.get::<_, String>(2)?,
                "paid_by_cashier_shift_id": row.get::<_, String>(1)?,
                "staff_name": row.get::<_, Option<String>>(8)?,
                "role_type": row.get::<_, Option<String>>(9)?,
                "amount": row.get::<_, f64>(3)?,
                "payment_type": row.get::<_, String>(4)?,
                "notes": row.get::<_, Option<String>>(5)?,
                "description": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "created_at": row.get::<_, String>(6)?,
                "updated_at": row.get::<_, String>(7)?,
                "check_in_time": row.get::<_, Option<String>>(10)?,
                "check_out_time": row.get::<_, Option<String>>(11)?,
            }))
        })
        .map_err(|e| format!("query staff payments: {e}"))?
        .filter_map(|r| r.ok())
        .collect::<Vec<Value>>();

    Ok(payments)
}

fn build_waiter_tables(conn: &rusqlite::Connection, shift_id: &str) -> Result<Vec<Value>, String> {
    // W6: derive payment_method per order from `order_payments` instead
    // of reading the dropped `orders.payment_method` column. The table-
    // level `payment_method` emitted below at the end of this function
    // is independently computed from cash+card sums and is unaffected.
    let mut stmt = conn
        .prepare(
            // W4b-ii: cents-with-real-fallback shim (removed in 4e).
            "SELECT o.id, o.order_number, COALESCE(o.table_number, 'Mobile POS') AS table_number,
                    COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0),
                    COALESCE((
                        SELECT CASE
                            WHEN COUNT(DISTINCT LOWER(TRIM(method))) > 1
                              THEN 'split'
                            ELSE LOWER(TRIM(MIN(method)))
                        END
                        FROM order_payments op2
                        WHERE op2.order_id = o.id
                          AND op2.status = 'completed'
                          AND TRIM(COALESCE(op2.method, '')) != ''
                    ), 'pending'),
                    o.status,
                    COALESCE((
                        SELECT SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)))
                        FROM order_payments op
                        WHERE op.order_id = o.id
                          AND op.status = 'completed'
                          AND op.method = 'cash'
                    ), 0) AS cash_amount,
                    COALESCE((
                        SELECT SUM(COALESCE(op.amount_cents, CAST(ROUND(op.amount * 100) AS INTEGER)))
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
                Cents::new(row.get::<_, i64>(3).unwrap_or(0)).to_f64_dp2(),
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                Cents::new(row.get::<_, i64>(6).unwrap_or(0)).to_f64_dp2(),
                Cents::new(row.get::<_, i64>(7).unwrap_or(0)).to_f64_dp2(),
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
        // W6: align the table-level method label with the new canonical
        // vocabulary — "split" for mixed cash+card (was "mixed" pre-W6).
        let payment_method = if cash_amount > 0.0 && card_amount > 0.0 {
            "split"
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

    #[test]
    fn test_shift_close_repair_bridge_reenters_tokio_runtime_without_panicking() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");

        let result =
            runtime.block_on(async { block_on_shift_close_repair_future(async { 42usize }) });

        assert_eq!(result, 42);
    }

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
    fn shift_summary_attributes_tip_to_recipient_shift_not_payment_owner() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                 id, staff_id, staff_name, role_type, branch_id, terminal_id,
                 check_in_time, opening_cash_amount, opening_cash_amount_cents,
                 status, calculation_version, sync_status, created_at, updated_at
             ) VALUES (
                 'shift-waiter-tip', 'staff-waiter-tip', 'Alex Waiter', 'server',
                 'branch-tip', 'terminal-tip', '2026-07-23T08:00:00Z',
                 0.0, 0, 'active', 2, 'pending',
                 '2026-07-23T08:00:00Z', '2026-07-23T08:00:00Z'
             )",
            [],
        )
        .expect("insert waiter shift");
        conn.execute(
            "INSERT INTO orders (
                 id, order_number, items, order_type,
                 total_amount, total_amount_cents, tip_amount, tip_amount_cents,
                 status, payment_status, staff_shift_id, sync_status, created_at, updated_at
             ) VALUES (
                 'order-waiter-tip', 'TIP-42', '[]', 'dine-in',
                 12.0, 1200, 2.0, 200,
                 'completed', 'paid', 'shift-waiter-tip', 'pending',
                 '2026-07-23T09:00:00Z', '2026-07-23T09:00:00Z'
             )",
            [],
        )
        .expect("insert waiter order");
        conn.execute(
            "INSERT INTO order_payments (
                 id, order_id, method, amount, amount_cents,
                 staff_id, staff_shift_id,
                 tip_amount, tip_amount_cents, tip_recipient_role,
                 tip_recipient_staff_id, tip_recipient_staff_shift_id,
                 status, sync_status, sync_state, created_at, updated_at
             ) VALUES (
                 'payment-waiter-tip', 'order-waiter-tip', 'card', 12.0, 1200,
                 'staff-cashier', 'shift-cashier-other',
                 2.0, 200, 'waiter',
                 'staff-waiter-tip', 'shift-waiter-tip',
                 'completed', 'pending', 'pending',
                 '2026-07-23T09:00:00Z', '2026-07-23T09:00:00Z'
             )",
            [],
        )
        .expect("insert waiter tip payment");
        drop(conn);

        let summary = get_shift_summary(&db, "shift-waiter-tip").expect("get shift summary");
        assert_eq!(
            summary.get("tipsReceived").and_then(Value::as_f64),
            Some(2.0)
        );
        let allocations = summary
            .get("tipAllocations")
            .and_then(Value::as_array)
            .expect("tip allocations");
        assert_eq!(allocations.len(), 1);
        assert_eq!(
            allocations[0].get("paymentId").and_then(Value::as_str),
            Some("payment-waiter-tip")
        );
        assert_eq!(
            allocations[0].get("recipientRole").and_then(Value::as_str),
            Some("waiter")
        );
    }

    fn load_latest_shift_sync_payload(db: &DbState, operation: &str, shift_id: &str) -> Value {
        // Wave 5 Session 6: shift producers now write to parity_sync_queue.
        // Parity stores `operation` uppercased ("INSERT"/"UPDATE"); legacy
        // tests used lowercase, so normalize the caller's input.
        let parity_op = operation.to_uppercase();
        let conn = db.conn.lock().unwrap();
        let payload: String = conn
            .query_row(
                "SELECT data
                 FROM parity_sync_queue
                 WHERE table_name = 'staff_shifts'
                   AND operation = ?1
                   AND record_id = ?2
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![parity_op, shift_id],
                |row| row.get(0),
            )
            .expect("shift sync payload should exist");
        serde_json::from_str(&payload).expect("shift sync payload should be valid json")
    }

    fn set_business_day_start(db: &DbState, timestamp: &str) {
        let conn = db.conn.lock().unwrap();
        db::set_setting(&conn, "system", "last_z_report_timestamp", timestamp)
            .expect("set business day start");
    }

    #[test]
    fn test_driver_close_returns_cash_to_cashier() {
        let db = test_db();

        // Setup: Create active cashier shift + drawer, then an active driver shift
        {
            let conn = db.conn.lock().unwrap();

            // W4e Step 0: dual-populate every monetary column.
            // Cashier shift (500.0 → 50000)
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('cashier-shift', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    datetime('now'), 500.0, 50000, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Cashier drawer (500.0 → 50000, 50.0 → 5000)
            conn.execute(
                "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
                    terminal_id, opening_amount, opening_amount_cents,
                    driver_cash_given, driver_cash_given_cents,
                    opened_at, created_at, updated_at)
                 VALUES ('drawer-1', 'cashier-shift', 'cashier-1', 'branch-1', 'term-1',
                    500.0, 50000, 50.0, 5000, datetime('now'), datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();

            // Driver shift (opening_cash=50.0 → 5000, same branch)
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-shift', 'driver-1', 'driver', 'branch-1', 'term-1',
                    datetime('now'), 50.0, 5000, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Order (30.0 → 3000)
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
                 VALUES ('ord-d1', '[]', 30.0, 3000, 'completed', 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Driver earnings: cash_collected = 30 (30.0 → 3000)
            conn.execute(
                "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                    total_earning, total_earning_cents,
                    payment_method,
                    cash_collected, cash_collected_cents,
                    created_at, updated_at)
                 VALUES ('de-1', 'driver-1', 'driver-shift', 'ord-d1', 'branch-1',
                    30.0, 3000, 'cash', 30.0, 3000, datetime('now'), datetime('now'))",
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
            // W4e Step 0: dual-populate (250.0 → 25000).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-pending-z', 'cashier-ctx', 'cashier', 'branch-ctx', 'term-ctx',
                    '2026-03-12T08:00:00Z', 250.0, 25000, 'active', 2, 'pending', '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-pending-z', 'cashier-pending-z', 'cashier-ctx', 'branch-ctx', 'term-ctx',
                    250.0, 25000, '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z'
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
    fn test_cashier_close_returns_payment_blockers_for_unsettled_orders() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (250.0/13.7 → 25000/1370).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version,
                    report_date, period_start_at, sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-blocked-close', 'cashier-ctx', 'cashier', 'branch-ctx', 'term-ctx',
                    '2026-03-12T08:00:00Z', 250.0, 25000, 'active', 2,
                    '2026-03-12', '2026-03-12T08:00:00Z', 'pending', '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-blocked-close', 'cashier-blocked-close', 'cashier-ctx', 'branch-ctx', 'term-ctx',
                    250.0, 25000, '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z', '2026-03-12T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, branch_id, staff_shift_id, items, total_amount, total_amount_cents, status,
                    payment_status, sync_status, created_at, updated_at
                 ) VALUES (
                    'order-blocked-close', 'ORD-blocked-close', 'branch-ctx', 'cashier-blocked-close', '[]', 13.7, 1370, 'completed',
                    'pending', 'pending', '2026-03-12T12:00:00Z', '2026-03-12T12:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        let result = close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "cashier-blocked-close",
                "closingCash": 250.0,
            }),
        )
        .expect("close shift should return a structured blocker payload");

        assert_eq!(result["success"], false);
        assert_eq!(result["errorCode"], "UNSETTLED_PAYMENT_BLOCKER");
        assert_eq!(result["blockers"][0]["orderNumber"], "ORD-blocked-close");
    }

    #[test]
    fn test_check_in_eligibility_requires_cashier_first_when_only_previous_day_cashier_exists() {
        let db = test_db();
        set_business_day_start(&db, "2026-03-22T08:00:00Z");

        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (120.0 → 12000).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at
                 ) VALUES (
                    'cashier-previous-day', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-21T12:00:00Z', 120.0, 12000, 'closed', 2, 'pending',
                    '2026-03-21T12:00:00Z', '2026-03-21T12:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        let result = get_check_in_eligibility(&db, "branch-1", "term-1")
            .expect("check-in eligibility should resolve");

        assert_eq!(result["businessDayStartAt"], "2026-03-22T08:00:00Z");
        assert_eq!(result["hasCashierForBusinessDay"], false);
        assert_eq!(result["requiresCashierFirst"], true);
    }

    #[test]
    fn test_shift_open_blocks_non_cashier_before_first_cashier_of_business_day() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        set_business_day_start(&db, "2026-03-22T08:00:00Z");

        let result = open_shift(
            &db,
            &serde_json::json!({
                "staffId": "kitchen-1",
                "staffName": "Kitchen One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "kitchen",
            }),
        );

        assert!(result.is_err(), "non-cashier shift should be blocked");
        assert_eq!(
            result.unwrap_err(),
            "The first check-in for this business day must be a cashier. Start a cashier shift first."
        );
    }

    #[test]
    fn test_shift_open_allows_cashier_as_first_shift_of_business_day() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        set_business_day_start(&db, "2026-03-22T08:00:00Z");

        let result = open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-1",
                "staffName": "Cashier One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 150.0,
            }),
        )
        .expect("cashier should be allowed as first shift");

        assert!(result["success"].as_bool().unwrap_or(true));
        let eligibility = get_check_in_eligibility(&db, "branch-1", "term-1")
            .expect("check-in eligibility should resolve after cashier opens");
        assert_eq!(eligibility["requiresCashierFirst"], false);
        assert_eq!(eligibility["hasCashierForBusinessDay"], true);
    }

    #[test]
    fn test_shift_open_allows_non_cashier_after_first_cashier_of_business_day() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        set_business_day_start(&db, "2026-03-22T08:00:00Z");

        open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-1",
                "staffName": "Cashier One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 200.0,
            }),
        )
        .expect("cashier should open first");

        let result = open_shift(
            &db,
            &serde_json::json!({
                "staffId": "kitchen-1",
                "staffName": "Kitchen One",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "kitchen",
            }),
        )
        .expect("non-cashier should open after cashier");

        assert!(result["shiftId"].as_str().is_some());
    }

    #[test]
    fn test_shift_open_sync_payload_includes_actual_check_in_and_cashier_context() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (200.0/0.0 → 20000/0).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at
                 ) VALUES (
                    'cashier-sync-open', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 200.0, 20000, 'active', 2, 'pending',
                    '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents,
                    driver_cash_given, driver_cash_given_cents,
                    opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-sync-open', 'cashier-sync-open', 'cashier-1', 'branch-1', 'term-1',
                    200.0, 20000, 0.0, 0, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
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
        let (actual_check_in, actual_report_date, actual_period_start_at): (
            String,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT check_in_time, report_date, period_start_at
                 FROM staff_shifts
                 WHERE id = ?1",
                params![driver_shift_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
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
        // Wave 4d wire-format cutover: the borrowed-starting-amount field is
        // emitted as integer cents (snake_case) on the outbound payload. 40
        // dollars → 4000 cents. Tests pre-dating the cutover asserted a
        // camelCase float; aligned here.
        assert_eq!(payload["borrowed_starting_amount_cents"], 4000);
        assert_eq!(payload["reportDate"], actual_report_date.unwrap());
        assert_eq!(payload["periodStartAt"], actual_period_start_at.unwrap());
    }

    #[test]
    fn test_cashier_close_marks_drawer_reconciled() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (100.0 → 10000).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-reconcile', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 100.0, 10000, 'active', 2, 'pending',
                    '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-reconcile', 'cashier-reconcile', 'cashier-1', 'branch-1', 'term-1',
                    100.0, 10000, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
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
    fn test_cashier_close_v2_deducts_all_staff_payouts_from_drawer() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (100.0/23.0 → 10000/2300).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-self-pay', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 100.0, 10000, 'active', 2, 'pending',
                    '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents,
                    total_staff_payments, total_staff_payments_cents,
                    opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-self-pay', 'cashier-self-pay', 'cashier-1', 'branch-1', 'term-1',
                    100.0, 10000, 23.0, 2300, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
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
                "closingCash": 77.0,
                "closedBy": TEST_MANAGER_UUID,
            }),
        )
        .expect("cashier close should deduct all recorded staff payouts");
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

        assert!((expected_cash_amount - 77.0).abs() < f64::EPSILON);
        assert!(cash_variance.abs() < f64::EPSILON);
        assert_eq!(
            payment_amount, None,
            "cashier close should no longer persist a standalone cashier payout"
        );
        assert!((total_staff_payments - 23.0).abs() < f64::EPSILON);
    }

    #[test]
    fn cash_drawer_formula_ignores_legacy_staff_payment_expense_rows() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-legacy-staff-expense', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 100.0, 10000, 'active', 2, 'pending',
                    '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents,
                    opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-legacy-staff-expense', 'cashier-legacy-staff-expense', 'cashier-1', 'branch-1', 'term-1',
                    100.0, 10000, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute_batch("PRAGMA ignore_check_constraints = ON;")
                .unwrap();
            conn.execute(
                "INSERT INTO shift_expenses (
                    id, staff_shift_id, staff_id, branch_id, expense_type,
                    amount, amount_cents, description, sync_status, created_at, updated_at
                 ) VALUES (
                    'legacy-staff-payment-expense', 'cashier-legacy-staff-expense', 'cashier-1', 'branch-1',
                    'staff_payment', 23.0, 2300, 'legacy staff payout mirror', 'pending',
                    '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute_batch("PRAGMA ignore_check_constraints = OFF;")
                .unwrap();
            ensure_staff_payments_table(&conn).unwrap();
            conn.execute(
                "INSERT INTO staff_payments (
                    id, cashier_shift_id, paid_to_staff_id, amount, payment_type, created_at, updated_at
                 ) VALUES (
                    'canonical-staff-payment', 'cashier-legacy-staff-expense', 'kitchen-1',
                    23.0, 'wage', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
        }

        let result = close_shift(
            &db,
            &serde_json::json!({
                "shiftId": "cashier-legacy-staff-expense",
                "closingCash": 77.0,
                "closedBy": TEST_MANAGER_UUID,
            }),
        )
        .expect("cashier close should ignore legacy staff_payment expense rows");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let (expected_cash_amount, cash_variance, drawer_expenses, drawer_staff_payments): (
            f64,
            f64,
            f64,
            f64,
        ) = conn
            .query_row(
                "SELECT ss.expected_cash_amount, ss.cash_variance, cds.total_expenses, cds.total_staff_payments
                 FROM staff_shifts ss
                 LEFT JOIN cash_drawer_sessions cds ON cds.staff_shift_id = ss.id
                 WHERE ss.id = 'cashier-legacy-staff-expense'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert!((expected_cash_amount - 77.0).abs() < f64::EPSILON);
        assert!(cash_variance.abs() < f64::EPSILON);
        assert!(drawer_expenses.abs() < f64::EPSILON);
        assert!((drawer_staff_payments - 23.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_non_financial_shift_ignores_cash_amounts_on_open_and_close() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();

        open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-bootstrap",
                "staffName": "Cashier Bootstrap",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 100.0,
            }),
        )
        .expect("open bootstrap cashier shift");

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
            // W4e Step 0: dual-populate (100.0 → 10000).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-sync-close', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T09:00:00Z', 100.0, 10000, 'active', 2, 'pending',
                    '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-sync-close', 'cashier-sync-close', 'cashier-1', 'branch-1', 'term-1',
                    100.0, 10000, '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
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
        // close_shift's outer payload money fields are still camelCase f64;
        // the cashDrawer sub-object has been migrated to snake_case i64 cents
        // by Wave 4d. Tests now verify both conventions where they're each
        // the current canonical shape.
        assert_eq!(payload["totalSalesAmount"], 0.0);
        assert_eq!(payload["totalCashSales"], 0.0);
        assert_eq!(payload["totalCardSales"], 0.0);
        assert_eq!(cash_drawer["id"], "drawer-sync-close");
        assert_eq!(cash_drawer["opening_amount_cents"], 10000);
        assert_eq!(cash_drawer["closing_amount_cents"], 10000);
        assert_eq!(cash_drawer["expected_amount_cents"], 10000);
        assert_eq!(cash_drawer["variance_amount_cents"], 0);
        assert_eq!(cash_drawer["reconciled"], true);
        assert_eq!(cash_drawer["reconciledBy"], TEST_MANAGER_UUID);
        assert_eq!(cash_drawer["reconciledAt"], cash_drawer["closedAt"]);
    }

    #[test]
    fn test_cashier_close_drops_placeholder_closed_by_from_local_state_and_sync_payload() {
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (100.0 → 10000).
            conn.execute(
                "INSERT INTO staff_shifts (
                    id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version,
                    sync_status, created_at, updated_at
                 ) VALUES (
                    'cashier-placeholder-close', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T09:00:00Z', 100.0, 10000, 'active', 2, 'pending',
                    '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
                 )",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (
                    id, staff_shift_id, cashier_id, branch_id, terminal_id,
                    opening_amount, opening_amount_cents, opened_at, created_at, updated_at
                 ) VALUES (
                    'drawer-placeholder-close', 'cashier-placeholder-close', 'cashier-1', 'branch-1', 'term-1',
                    100.0, 10000, '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z'
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
    fn test_driver_close_no_cashier_with_returned_cash_fails() {
        let db = test_db();

        // Setup: Driver shift with no active cashier
        {
            let conn = db.conn.lock().unwrap();
            // W4e Step 0: dual-populate (50.0 → 5000).
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-solo', 'driver-2', 'driver', 'branch-2', 'term-2',
                    datetime('now'), 50.0, 5000, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();
        }

        // Close should fail rather than silently losing the returned drawer target.
        let payload = serde_json::json!({
            "shiftId": "driver-solo",
            "closingCash": 50.0,
        });
        let result = close_shift(&db, &payload).unwrap_err();
        assert!(result.contains("no active cashier drawer"));
    }

    #[test]
    fn test_cashier_close_transfers_active_drivers() {
        // When a cashier closes, active drivers should be marked is_transfer_pending = 1
        // and driver_cash_given should be reduced by their starting amounts.
        let db = test_db();

        {
            let conn = db.conn.lock().unwrap();

            // W4e Step 0: dual-populate (500/75/50/25 → 50000/7500/5000/2500).
            // Cashier shift + drawer
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('cashier-1', 'staff-c1', 'cashier', 'b1', 't1',
                    datetime('now'), 500.0, 50000, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
                    terminal_id, opening_amount, opening_amount_cents,
                    driver_cash_given, driver_cash_given_cents,
                    opened_at, created_at, updated_at)
                 VALUES ('cd-1', 'cashier-1', 'staff-c1', 'b1', 't1',
                    500.0, 50000, 75.0, 7500, datetime('now'), datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();

            // Active driver 1 (opening_cash = 50 → 5000)
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-a', 'staff-d1', 'driver', 'b1', 't1',
                    datetime('now'), 50.0, 5000, 'active', 2, 'pending', datetime('now'), datetime('now'))",
                [],
            ).unwrap();

            // Active driver 2 (opening_cash = 25 → 2500)
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-b', 'staff-d2', 'driver', 'b1', 't1',
                    datetime('now'), 25.0, 2500, 'active', 2, 'pending', datetime('now'), datetime('now'))",
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
            // W4e Step 0: dual-populate every monetary column (500/50/30 → 50000/5000/3000).
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('cashier-sync-target', 'cashier-1', 'cashier', 'branch-1', 'term-1',
                    '2026-03-18T08:00:00Z', 500.0, 50000, 'active', 2, 'pending', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cash_drawer_sessions (id, staff_shift_id, cashier_id, branch_id,
                    terminal_id, opening_amount, opening_amount_cents,
                    driver_cash_given, driver_cash_given_cents,
                    opened_at, created_at, updated_at)
                 VALUES ('drawer-sync-target', 'cashier-sync-target', 'cashier-1', 'branch-1', 'term-1',
                    500.0, 50000, 50.0, 5000, '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T08:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, staff_name, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES ('driver-sync-target', 'driver-1', 'Driver One', 'driver', 'branch-1', 'term-1',
                    '2026-03-18T09:00:00Z', 50.0, 5000, 'active', 2, 'pending', '2026-03-18T09:00:00Z', '2026-03-18T09:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orders (id, items, total_amount, total_amount_cents, status, sync_status, created_at, updated_at)
                 VALUES ('ord-sync-target', '[]', 30.0, 3000, 'completed', 'pending', '2026-03-18T09:30:00Z', '2026-03-18T09:30:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO driver_earnings (id, driver_id, staff_shift_id, order_id, branch_id,
                    total_earning, total_earning_cents,
                    payment_method,
                    cash_collected, cash_collected_cents,
                    created_at, updated_at)
                 VALUES ('de-sync-target', 'driver-1', 'driver-sync-target', 'ord-sync-target', 'branch-1',
                    30.0, 3000, 'cash', 30.0, 3000, '2026-03-18T09:30:00Z', '2026-03-18T09:30:00Z')",
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

        let conn = db.conn.lock().unwrap();
        let (report_date, period_start_at): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT report_date, period_start_at
                 FROM staff_shifts
                 WHERE id = 'driver-sync-target'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        drop(conn);

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
        assert_eq!(payload["reportDate"], report_date.unwrap());
        assert_eq!(payload["periodStartAt"], period_start_at.unwrap());
    }

    #[test]
    fn test_new_cashier_inherits_transferred_drivers() {
        let _fake = crate::tests::fake_keyring::install_empty();
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

        // W4e Step 0: dual-populate every monetary column (20/30/50 → 2000/3000/5000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver One', 'driver', 'branch-1', 'term-1',
                ?1, 20.0, 2000, 'active', 2, 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id, sync_status, created_at, updated_at
            ) VALUES (
                'order-delivery', '#D1', '[]', 30.0, 3000, 'completed', 'delivery',
                'paid', 'driver-shift', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, order_number, items, total_amount, total_amount_cents, status, order_type,
                payment_status, staff_shift_id, sync_status, created_at, updated_at
            ) VALUES (
                'order-pickup', '#P1', '[]', 50.0, 5000, 'completed', 'pickup',
                'paid', 'driver-shift', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
            ) VALUES (
                'pay-delivery', 'order-delivery', 'cash', 30.0, 3000, 'completed', 'driver-shift', 'EUR', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
            ) VALUES (
                'pay-pickup', 'order-pickup', 'cash', 50.0, 5000, 'completed', 'driver-shift', 'EUR', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id,
                delivery_fee, delivery_fee_cents,
                tip_amount, tip_amount_cents,
                total_earning, total_earning_cents,
                payment_method,
                cash_collected, cash_collected_cents,
                card_amount, card_amount_cents,
                cash_to_return, cash_to_return_cents,
                settled, created_at, updated_at
            ) VALUES (
                'earning-1', 'driver-1', 'driver-shift', 'order-delivery', 'branch-1',
                0.0, 0, 0.0, 0, 0.0, 0, 'cash',
                30.0, 3000, 0.0, 0, 30.0, 3000, 0, ?1, ?1
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

        // W4e Step 0: dual-populate (100/15/20 → 10000/1500/2000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'cashier-shift', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                ?1, 100.0, 10000, 'active', 2, 'pending', ?1, ?1
            )",
            params![cashier_in],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-1', 'cashier-shift', 'cashier-1', 'branch-1', 'term-1',
                100.0, 10000, ?1, ?1, ?1
            )",
            params![cashier_in],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, check_out_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version,
                sync_status, created_at, updated_at
            ) VALUES (
                'driver-old', 'driver-old', 'Old Driver', 'driver', 'branch-1', 'term-1',
                '2026-03-05T08:00:00Z', '2026-03-05T09:00:00Z', 15.0, 1500, 'closed', 2,
                'pending', '2026-03-05T08:00:00Z', '2026-03-05T09:00:00Z'
            )",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'driver-current', 'driver-current', 'Current Driver', 'driver', 'branch-1', 'term-1',
                '2026-03-05T10:30:00Z', 20.0, 2000, 'active', 2, 'pending',
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
            // W4e Step 0: dual-populate via Cents::round_half_even.
            let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type,
                    payment_status, staff_shift_id, sync_status, created_at, updated_at
                ) VALUES (?1, ?1, '[]', ?2, ?3, 'completed', 'delivery',
                    'paid', ?4, 'pending', ?5, ?5)",
                params![
                    order_id,
                    total_amount,
                    total_amount_cents,
                    shift_id,
                    created_at
                ],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
                ) VALUES (?1, ?2, 'cash', ?3, ?4, 'completed', ?5, 'EUR', ?6, ?6)",
                params![
                    format!("pay-{order_id}"),
                    order_id,
                    total_amount,
                    total_amount_cents,
                    shift_id,
                    created_at
                ],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO driver_earnings (
                    id, driver_id, staff_shift_id, order_id, branch_id,
                    delivery_fee, delivery_fee_cents,
                    tip_amount, tip_amount_cents,
                    total_earning, total_earning_cents,
                    payment_method,
                    cash_collected, cash_collected_cents,
                    card_amount, card_amount_cents,
                    cash_to_return, cash_to_return_cents,
                    settled, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, 'branch-1',
                    0.0, 0, 0.0, 0, ?5, ?6, 'cash',
                    ?5, ?6, 0.0, 0, ?5, ?6, 0, ?7, ?7
                )",
                params![
                    format!("earning-{order_id}"),
                    shift_id,
                    shift_id,
                    order_id,
                    total_amount,
                    total_amount_cents,
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

        // W4e Step 0: dual-populate (100.0 → 10000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, check_out_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version,
                sync_status, created_at, updated_at
            ) VALUES (
                'cashier-orders', 'cashier-1', 'Cashier One', 'cashier', 'branch-1', 'term-1',
                ?1, ?2, 100.0, 10000, 'closed', 2, 'pending', ?1, ?2
            )",
            params![cashier_in, cashier_out],
        )
        .unwrap();

        // W6: `orders.payment_method` is gone in v55 — the stored-column
        // fixtures are irrelevant. The derived method is computed from
        // `order_payments` rows seeded below, so the cashier summary
        // correctly classifies "order-valid" (cash+card = split).
        for (order_id, order_number, total_amount, created_at, is_ghost) in [
            ("order-valid", "C-101", 40.0, "2026-03-05T10:30:00Z", 0),
            ("order-before", "C-099", 15.0, "2026-03-05T09:55:00Z", 0),
            ("order-after", "C-102", 22.0, "2026-03-05T11:15:00Z", 0),
            ("order-ghost", "C-103", 18.0, "2026-03-05T10:40:00Z", 1),
        ] {
            // W4e Step 0: dual-populate via Cents::round_half_even.
            let total_amount_cents = Cents::round_half_even(total_amount).as_i64();
            conn.execute(
                "INSERT INTO orders (
                    id, order_number, items, total_amount, total_amount_cents, status, order_type, payment_status,
                    staff_shift_id, customer_name, table_number, is_ghost,
                    sync_status, created_at, updated_at
                ) VALUES (
                    ?1, ?2, '[]', ?3, ?4, 'completed', 'dine-in', 'paid',
                    'cashier-orders', 'Alex', 'T1', ?5, 'pending', ?6, ?6
                )",
                params![order_id, order_number, total_amount, total_amount_cents, is_ghost, created_at],
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
            // W4e Step 0: dual-populate via Cents::round_half_even.
            let amount_cents = Cents::round_half_even(amount).as_i64();
            conn.execute(
                "INSERT INTO order_payments (
                    id, order_id, method, amount, amount_cents, status, staff_shift_id, currency, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, 'completed', 'cashier-orders', 'EUR', ?6, ?6
                )",
                params![payment_id, order_id, method, amount, amount_cents, created_at],
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
        // W6: two completed methods (cash + card) → derive returns
        // "split" (canonical new vocabulary; was "mixed" pre-v55).
        assert_eq!(orders[0]["payment_method"], "split");
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

        // W4e Step 0: dual-populate (50.0 → 5000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, role_type, branch_id, terminal_id,
                check_in_time, opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status,
                created_at, updated_at
            ) VALUES (
                'cashier-quiet', 'cashier-quiet', 'Quiet Cashier', 'cashier', 'branch-1', 'term-1',
                ?1, 50.0, 5000, 'active', 2, 'pending', ?1, ?1
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

    #[test]
    fn test_delete_expense_removes_local_row_recomputes_drawer_and_requeues_delete() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let created_at = "2026-03-26T10:00:00Z";

        // W4e Step 0: dual-populate (100/15/10/5 → 10000/1500/1000/500).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'cashier-delete', 'cashier-1', 'cashier', 'branch-1', 'term-1', ?1,
                100.0, 10000, 'active', 2, 'pending', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_expenses, total_expenses_cents,
                opened_at, created_at, updated_at
            ) VALUES (
                'drawer-delete', 'cashier-delete', 'cashier-1', 'branch-1', 'term-1', 100.0, 10000,
                15.0, 1500, ?1, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shift_expenses (
                id, staff_shift_id, staff_id, branch_id, expense_type, amount, amount_cents, description,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'expense-delete', 'cashier-delete', 'cashier-1', 'branch-1', 'other', 10.0, 1000, 'Wrong expense',
                'pending', 'pending', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shift_expenses (
                id, staff_shift_id, staff_id, branch_id, expense_type, amount, amount_cents, description,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'expense-keep', 'cashier-delete', 'cashier-1', 'branch-1', 'supplies', 5.0, 500, 'Keep expense',
                'pending', 'pending', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
            ) VALUES (
                'shift_expense', 'expense-delete', 'insert',
                '{\"shiftId\":\"cashier-delete\",\"amount\":10}', 'expense-delete:insert', 'pending'
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let result = delete_expense(
            &db,
            &serde_json::json!({
                "expenseId": "expense-delete",
                "shiftId": "cashier-delete",
            }),
        )
        .expect("expense delete should succeed");
        assert_eq!(result["success"], true);
        assert_eq!(result["expenseId"], "expense-delete");

        let conn = db.conn.lock().unwrap();
        let deleted_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM shift_expenses WHERE id = 'expense-delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let total_expenses: f64 = conn
            .query_row(
                "SELECT total_expenses FROM cash_drawer_sessions WHERE id = 'drawer-delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // Wave 5 Session 6: the pending legacy-queue insert must be cleared
        // and the canonical delete now lives on parity_sync_queue, not the
        // legacy table. We assert both halves of that split-brain cleanup.
        let legacy_remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sync_queue
                 WHERE entity_type = 'shift_expense' AND entity_id = 'expense-delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let parity_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM parity_sync_queue
                 WHERE table_name = 'shift_expenses' AND record_id = 'expense-delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let (operation, status, data): (String, String, String) = conn
            .query_row(
                "SELECT operation, status, data
                 FROM parity_sync_queue
                 WHERE table_name = 'shift_expenses' AND record_id = 'expense-delete'
                 ORDER BY created_at DESC
                 LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let payload: Value =
            serde_json::from_str(&data).expect("delete sync data should be valid json");

        assert_eq!(
            deleted_count, 0,
            "deleted expense row should be removed locally"
        );
        assert_eq!(
            total_expenses, 5.0,
            "drawer total_expenses should be recomputed from remaining expenses"
        );
        assert_eq!(
            legacy_remaining, 0,
            "pending legacy-queue insert for the deleted expense should be cleared"
        );
        assert_eq!(
            parity_rows, 1,
            "the canonical delete should land on parity_sync_queue"
        );
        assert_eq!(operation, "DELETE");
        assert_eq!(status, "pending");
        assert_eq!(payload["expenseId"], "expense-delete");
        assert_eq!(payload["shiftId"], "cashier-delete");
        assert_eq!(payload["staffShiftId"], "cashier-delete");
        assert_eq!(payload["branchId"], "branch-1");
        assert!(payload["deletedAt"].as_str().is_some());
    }

    #[test]
    fn test_delete_expense_keeps_synced_history_and_recomputes_remaining_total() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let created_at = "2026-03-26T10:00:00Z";

        // W4e Step 0: dual-populate (100/9/4/5 → 10000/900/400/500).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'cashier-delete-synced', 'cashier-1', 'cashier', 'branch-1', 'term-1', ?1,
                100.0, 10000, 'active', 2, 'synced', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_expenses, total_expenses_cents,
                opened_at, created_at, updated_at
            ) VALUES (
                'drawer-delete-synced', 'cashier-delete-synced', 'cashier-1', 'branch-1', 'term-1', 100.0, 10000,
                9.0, 900, ?1, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shift_expenses (
                id, staff_shift_id, staff_id, branch_id, expense_type, amount, amount_cents, description,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'expense-synced', 'cashier-delete-synced', 'cashier-1', 'branch-1', 'other', 4.0, 400, 'Synced expense',
                'pending', 'synced', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shift_expenses (
                id, staff_shift_id, staff_id, branch_id, expense_type, amount, amount_cents, description,
                status, sync_status, created_at, updated_at
            ) VALUES (
                'expense-stays', 'cashier-delete-synced', 'cashier-1', 'branch-1', 'supplies', 5.0, 500, 'Remaining expense',
                'pending', 'pending', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status, synced_at
            ) VALUES (
                'shift_expense', 'expense-synced', 'insert',
                '{\"shiftId\":\"cashier-delete-synced\",\"amount\":4}', 'expense-synced:insert', 'synced', ?1
            )",
            params![created_at],
        )
        .unwrap();
        drop(conn);

        delete_expense(
            &db,
            &serde_json::json!({
                "expenseId": "expense-synced",
                "shiftId": "cashier-delete-synced",
            }),
        )
        .expect("synced expense delete should succeed");

        let conn = db.conn.lock().unwrap();
        let total_expenses: f64 = conn
            .query_row(
                "SELECT total_expenses
                 FROM cash_drawer_sessions
                 WHERE id = 'drawer-delete-synced'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // Wave 5 Session 6: synced history rows stay on the legacy queue
        // (drain-only until Session 7 drops it) while the new delete is
        // enqueued on parity_sync_queue. Assert both sides so we catch either
        // a regression that drops legacy history OR one that misroutes the
        // new delete back to the legacy table.
        let legacy_rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT operation, status
                 FROM sync_queue
                 WHERE entity_type = 'shift_expense' AND entity_id = 'expense-synced'
                 ORDER BY id ASC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<(String, String)>, _>>()
            .unwrap();
        let parity_rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT operation, status
                 FROM parity_sync_queue
                 WHERE table_name = 'shift_expenses' AND record_id = 'expense-synced'
                 ORDER BY created_at ASC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<(String, String)>, _>>()
            .unwrap();

        assert_eq!(
            total_expenses, 5.0,
            "drawer total_expenses should match the remaining synced + unsynced local rows"
        );
        assert_eq!(
            legacy_rows,
            vec![("insert".to_string(), "synced".to_string())],
            "synced legacy history should remain untouched by the new delete"
        );
        assert_eq!(
            parity_rows,
            vec![("DELETE".to_string(), "pending".to_string())],
            "the canonical delete should land on parity_sync_queue"
        );
    }

    #[test]
    fn test_update_staff_payment_recomputes_active_drawer_total_and_requeues_sync() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let created_at = "2026-03-26T10:00:00Z";

        ensure_staff_payments_table(&conn).unwrap();
        // W4e Step 0: dual-populate (100/18 → 10000/1800). staff_payments
        // table is excluded from cents migration per migrate_v54 docstring.
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'cashier-staff-update', 'cashier-1', 'cashier', 'branch-1', 'term-1', ?1,
                100.0, 10000, 'active', 2, 'pending', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_staff_payments, total_staff_payments_cents,
                opened_at, created_at, updated_at
            ) VALUES (
                'drawer-staff-update', 'cashier-staff-update', 'cashier-1', 'branch-1', 'term-1',
                100.0, 10000, 18.0, 1800, ?1, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at, updated_at
            ) VALUES (
                'payment-update-target', 'cashier-staff-update', 'staff-1', 12.0, 'wage', 'initial', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at, updated_at
            ) VALUES (
                'payment-update-other', 'cashier-staff-update', 'staff-2', 6.0, 'tip', NULL, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
            ) VALUES (
                'staff_payment', 'payment-update-target', 'insert', '{}', 'staff-payment:update-target:insert', 'pending'
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let result = update_staff_payment(
            &db,
            &serde_json::json!({
                "paymentId": "payment-update-target",
                "cashierShiftId": "cashier-staff-update",
                "paidToStaffId": "staff-3",
                "amount": 10.0,
                "paymentType": "bonus",
                "notes": "corrected amount",
            }),
        )
        .expect("staff payment update should succeed");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let (paid_to_staff_id, amount, payment_type, notes, updated_at): (
            String,
            f64,
            String,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT paid_to_staff_id, amount, payment_type, notes, updated_at
                 FROM staff_payments
                 WHERE id = 'payment-update-target'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let total_staff_payments: f64 = conn
            .query_row(
                "SELECT total_staff_payments
                 FROM cash_drawer_sessions
                 WHERE id = 'drawer-staff-update'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // Wave 5 Session 6: staff_payments mutations now write to parity.
        let queue_rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT operation, status
                 FROM parity_sync_queue
                 WHERE table_name = 'staff_payments' AND record_id = 'payment-update-target'
                 ORDER BY created_at ASC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<(String, String)>, _>>()
            .unwrap();

        assert_eq!(paid_to_staff_id, "staff-3");
        assert!((amount - 10.0).abs() < f64::EPSILON);
        assert_eq!(payment_type, "bonus");
        assert_eq!(notes.as_deref(), Some("corrected amount"));
        assert_ne!(updated_at, created_at);
        assert!(
            (total_staff_payments - 16.0).abs() < f64::EPSILON,
            "drawer total should be recomputed from all current staff_payments rows"
        );
        assert_eq!(
            queue_rows,
            vec![("UPDATE".to_string(), "pending".to_string())],
            "unfinished sync rows should be replaced by one canonical update row"
        );
    }

    #[test]
    fn test_delete_staff_payment_recomputes_active_drawer_total_and_requeues_delete() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let created_at = "2026-03-26T10:00:00Z";

        ensure_staff_payments_table(&conn).unwrap();
        // W4e Step 0: dual-populate (100/18 → 10000/1800).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'cashier-staff-delete', 'cashier-1', 'cashier', 'branch-1', 'term-1', ?1,
                100.0, 10000, 'active', 2, 'pending', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                total_staff_payments, total_staff_payments_cents,
                opened_at, created_at, updated_at
            ) VALUES (
                'drawer-staff-delete', 'cashier-staff-delete', 'cashier-1', 'branch-1', 'term-1',
                100.0, 10000, 18.0, 1800, ?1, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at, updated_at
            ) VALUES (
                'payment-delete-target', 'cashier-staff-delete', 'staff-1', 12.0, 'wage', NULL, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at, updated_at
            ) VALUES (
                'payment-delete-other', 'cashier-staff-delete', 'staff-2', 6.0, 'tip', NULL, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
            ) VALUES (
                'staff_payment', 'payment-delete-target', 'insert', '{}', 'staff-payment:delete-target:insert', 'pending'
            )",
            [],
        )
        .unwrap();
        drop(conn);

        let result = delete_staff_payment(
            &db,
            &serde_json::json!({
                "paymentId": "payment-delete-target",
                "cashierShiftId": "cashier-staff-delete",
            }),
        )
        .expect("staff payment delete should succeed");
        assert_eq!(result["success"], true);

        let conn = db.conn.lock().unwrap();
        let deleted_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_payments WHERE id = 'payment-delete-target'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let total_staff_payments: f64 = conn
            .query_row(
                "SELECT total_staff_payments
                 FROM cash_drawer_sessions
                 WHERE id = 'drawer-staff-delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // Wave 5 Session 6: staff_payments delete now writes to parity.
        let queue_rows: Vec<(String, String)> = conn
            .prepare(
                "SELECT operation, status
                 FROM parity_sync_queue
                 WHERE table_name = 'staff_payments' AND record_id = 'payment-delete-target'
                 ORDER BY created_at ASC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<(String, String)>, _>>()
            .unwrap();

        assert_eq!(deleted_count, 0);
        assert!(
            (total_staff_payments - 6.0).abs() < f64::EPSILON,
            "drawer total should be recomputed from remaining staff_payments rows"
        );
        assert_eq!(
            queue_rows,
            vec![("DELETE".to_string(), "pending".to_string())],
            "unfinished sync rows should be replaced by one canonical delete row"
        );
    }

    #[test]
    fn test_update_staff_payment_recomputes_closed_shift_expected_and_variance() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let created_at = "2026-03-26T10:00:00Z";

        ensure_staff_payments_table(&conn).unwrap();
        // W4e Step 0: dual-populate every monetary column (100/80/80/0/20 → 10000/8000/8000/0/2000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time, check_out_time,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'cashier-staff-closed-update', 'cashier-1', 'cashier', 'branch-1', 'term-1', ?1, ?1,
                100.0, 10000, 80.0, 8000, 80.0, 8000, 0.0, 0, 'closed', 2, 'synced', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                closing_amount, closing_amount_cents,
                expected_amount, expected_amount_cents,
                variance_amount, variance_amount_cents,
                total_staff_payments, total_staff_payments_cents,
                opened_at, closed_at, reconciled, created_at, updated_at
            ) VALUES (
                'drawer-staff-closed-update', 'cashier-staff-closed-update', 'cashier-1', 'branch-1', 'term-1',
                100.0, 10000, 80.0, 8000, 80.0, 8000, 0.0, 0, 20.0, 2000, ?1, ?1, 1, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at, updated_at
            ) VALUES (
                'payment-closed-update-target', 'cashier-staff-closed-update', 'staff-1', 20.0, 'wage', NULL, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
            ) VALUES (
                'shift', 'cashier-staff-closed-update', 'update', '{}', 'shift:closed-update:stale', 'pending'
            )",
            []
        )
        .unwrap();
        drop(conn);

        update_staff_payment(
            &db,
            &serde_json::json!({
                "paymentId": "payment-closed-update-target",
                "cashierShiftId": "cashier-staff-closed-update",
                "paidToStaffId": "staff-1",
                "amount": 12.0,
                "paymentType": "wage",
            }),
        )
        .expect("closed shift staff payment update should succeed");

        let conn = db.conn.lock().unwrap();
        let (shift_expected, shift_variance, drawer_expected, drawer_variance, drawer_total): (
            f64,
            f64,
            f64,
            f64,
            f64,
        ) = conn
            .query_row(
                "SELECT ss.expected_cash_amount, ss.cash_variance,
                        cds.expected_amount, cds.variance_amount, cds.total_staff_payments
                 FROM staff_shifts ss
                 JOIN cash_drawer_sessions cds ON cds.staff_shift_id = ss.id
                 WHERE ss.id = 'cashier-staff-closed-update'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        // Wave 5 Session 6: shift correction writes to parity_sync_queue.
        // The staff_payment mutation also writes to parity but with a
        // different record_id (payment UUID), so this query — scoped to
        // record_id = shift id — sees only the shift-correction row.
        let queue_rows: Vec<(String, String, String)> = conn
            .prepare(
                "SELECT table_name, operation, status
                 FROM parity_sync_queue
                 WHERE record_id = 'cashier-staff-closed-update'
                 ORDER BY created_at ASC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<(String, String, String)>, _>>()
            .unwrap();

        assert!((shift_expected - 88.0).abs() < f64::EPSILON);
        assert!((shift_variance - (-8.0)).abs() < f64::EPSILON);
        assert!((drawer_expected - 88.0).abs() < f64::EPSILON);
        assert!((drawer_variance - (-8.0)).abs() < f64::EPSILON);
        assert!((drawer_total - 12.0).abs() < f64::EPSILON);
        assert_eq!(
            queue_rows,
            vec![(
                "staff_shifts".to_string(),
                "UPDATE".to_string(),
                "pending".to_string()
            )],
            "closed shift corrections should replace unfinished shift sync rows with one fresh snapshot"
        );
    }

    #[test]
    fn test_delete_staff_payment_recomputes_closed_shift_expected_and_variance() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let created_at = "2026-03-26T10:00:00Z";

        ensure_staff_payments_table(&conn).unwrap();
        // W4e Step 0: dual-populate (100/80/80/0/20 → 10000/8000/8000/0/2000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time, check_out_time,
                opening_cash_amount, opening_cash_amount_cents,
                closing_cash_amount, closing_cash_amount_cents,
                expected_cash_amount, expected_cash_amount_cents,
                cash_variance, cash_variance_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'cashier-staff-closed-delete', 'cashier-1', 'cashier', 'branch-1', 'term-1', ?1, ?1,
                100.0, 10000, 80.0, 8000, 80.0, 8000, 0.0, 0, 'closed', 2, 'synced', ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opening_amount_cents,
                closing_amount, closing_amount_cents,
                expected_amount, expected_amount_cents,
                variance_amount, variance_amount_cents,
                total_staff_payments, total_staff_payments_cents,
                opened_at, closed_at, reconciled, created_at, updated_at
            ) VALUES (
                'drawer-staff-closed-delete', 'cashier-staff-closed-delete', 'cashier-1', 'branch-1', 'term-1',
                100.0, 10000, 80.0, 8000, 80.0, 8000, 0.0, 0, 20.0, 2000, ?1, ?1, 1, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at, updated_at
            ) VALUES (
                'payment-closed-delete-target', 'cashier-staff-closed-delete', 'staff-1', 8.0, 'tip', NULL, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_payments (
                id, cashier_shift_id, paid_to_staff_id, amount, payment_type, notes, created_at, updated_at
            ) VALUES (
                'payment-closed-delete-other', 'cashier-staff-closed-delete', 'staff-2', 12.0, 'wage', NULL, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key, status
            ) VALUES (
                'shift', 'cashier-staff-closed-delete', 'update', '{}', 'shift:closed-delete:stale', 'pending'
            )",
            []
        )
        .unwrap();
        drop(conn);

        delete_staff_payment(
            &db,
            &serde_json::json!({
                "paymentId": "payment-closed-delete-target",
                "cashierShiftId": "cashier-staff-closed-delete",
            }),
        )
        .expect("closed shift staff payment delete should succeed");

        let conn = db.conn.lock().unwrap();
        let deleted_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staff_payments WHERE id = 'payment-closed-delete-target'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let (shift_expected, shift_variance, drawer_expected, drawer_variance, drawer_total): (
            f64,
            f64,
            f64,
            f64,
            f64,
        ) = conn
            .query_row(
                "SELECT ss.expected_cash_amount, ss.cash_variance,
                        cds.expected_amount, cds.variance_amount, cds.total_staff_payments
                 FROM staff_shifts ss
                 JOIN cash_drawer_sessions cds ON cds.staff_shift_id = ss.id
                 WHERE ss.id = 'cashier-staff-closed-delete'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        // Wave 5 Session 6: shift correction writes to parity_sync_queue.
        let queue_rows: Vec<(String, String, String)> = conn
            .prepare(
                "SELECT table_name, operation, status
                 FROM parity_sync_queue
                 WHERE record_id = 'cashier-staff-closed-delete'
                 ORDER BY created_at ASC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<(String, String, String)>, _>>()
            .unwrap();

        assert_eq!(deleted_count, 0);
        assert!((shift_expected - 88.0).abs() < f64::EPSILON);
        assert!((shift_variance - (-8.0)).abs() < f64::EPSILON);
        assert!((drawer_expected - 88.0).abs() < f64::EPSILON);
        assert!((drawer_variance - (-8.0)).abs() < f64::EPSILON);
        assert!((drawer_total - 12.0).abs() < f64::EPSILON);
        assert_eq!(
            queue_rows,
            vec![(
                "staff_shifts".to_string(),
                "UPDATE".to_string(),
                "pending".to_string()
            )],
            "closed shift corrections should replace unfinished shift sync rows with one fresh snapshot"
        );
    }

    #[test]
    fn test_get_shift_sync_state_returns_pending_queue_metadata_for_open_shift() {
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();
        let result = open_shift(
            &db,
            &serde_json::json!({
                "staffId": "cashier-sync-state",
                "staffName": "Cashier Sync State",
                "branchId": "branch-1",
                "terminalId": "term-1",
                "roleType": "cashier",
                "openingCash": 125.0,
            }),
        )
        .expect("shift should open");

        let shift_id = result["shiftId"]
            .as_str()
            .expect("shift id should be present")
            .to_string();
        let sync_state =
            get_shift_sync_state(&db, &shift_id).expect("shift sync state should resolve");

        assert_eq!(sync_state["shiftId"], shift_id);
        assert_eq!(sync_state["shiftSyncStatus"], "pending");
        assert_eq!(sync_state["queueStatus"], "pending");
        assert_eq!(sync_state["retryCount"], 0);
        assert!(sync_state["queueCreatedAt"].as_str().is_some());
        assert!(sync_state["queueUpdatedAt"].as_str().is_some());
    }

    #[test]
    fn test_get_shift_sync_state_returns_failed_queue_metadata() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let created_at = "2026-03-26T10:00:00Z";
        let failed_at = "2026-03-26T10:05:00Z";
        let next_retry_at = "2026-03-26T10:10:00Z";

        // W4e Step 0: dual-populate (100.0 → 10000).
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, role_type, branch_id, terminal_id, check_in_time,
                opening_cash_amount, opening_cash_amount_cents,
                status, calculation_version, sync_status, created_at, updated_at
            ) VALUES (
                'shift-sync-failed', 'cashier-1', 'cashier', 'branch-1', 'term-1', ?1,
                100.0, 10000, 'active', 2, 'failed', ?1, ?2
            )",
            params![created_at, failed_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, last_error, next_retry_at, created_at, updated_at
            ) VALUES (
                'shift', 'shift-sync-failed', 'insert', '{}', 'shift-sync-failed:open',
                'pending', 1, NULL, NULL, ?1, ?1
            )",
            params![created_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (
                entity_type, entity_id, operation, payload, idempotency_key,
                status, retry_count, last_error, next_retry_at, created_at, updated_at
            ) VALUES (
                'shift', 'shift-sync-failed', 'insert', '{}', 'shift-sync-failed:retry',
                'failed', 3, 'Validation failed: branch access denied', ?2, ?1, ?3
            )",
            params![created_at, next_retry_at, failed_at],
        )
        .unwrap();
        drop(conn);

        let sync_state = get_shift_sync_state(&db, "shift-sync-failed")
            .expect("shift sync state should resolve");

        assert_eq!(sync_state["shiftId"], "shift-sync-failed");
        assert_eq!(sync_state["shiftSyncStatus"], "failed");
        assert_eq!(sync_state["queueStatus"], "failed");
        assert_eq!(
            sync_state["lastError"],
            "Validation failed: branch access denied"
        );
        assert_eq!(sync_state["retryCount"], 3);
        assert_eq!(sync_state["nextRetryAt"], next_retry_at);
        assert_eq!(sync_state["queueCreatedAt"], created_at);
        assert_eq!(sync_state["queueUpdatedAt"], failed_at);
    }

    // =======================================================================
    // Wave 0 regression test for Critical C2 (cross-terminal shift open race).
    //
    // On HEAD, `open_shift` (shifts.rs ~line 186) runs the "does this staff
    // member already have an active shift?" SELECT *outside* the enclosing
    // `BEGIN IMMEDIATE` transaction that starts at line 205. Two terminals
    // opening a shift for the same staff member simultaneously can both pass
    // the pre-check, then both INSERT successfully — leaving TWO active
    // shifts where the invariant says there must be AT MOST ONE.
    //
    // This test replicates the buggy pattern directly with raw SQL against
    // a shared on-disk SQLite file (WAL mode permits concurrent writers).
    // Two threads race through a SELECT, sleep briefly, then INSERT.
    //
    // Wave 2a's C2 fix will either (a) move the SELECT inside `BEGIN
    // IMMEDIATE`, or (b) add a partial unique index via `migrate_v46`:
    //   CREATE UNIQUE INDEX idx_one_active_shift_per_staff
    //       ON staff_shifts(staff_id) WHERE status='active';
    // After either fix, this raw-SQL replica will still show the bug —
    // so at Wave 2a the test will be rewired to call the actual
    // `open_shift` entry-point so it picks up the fix.
    // =======================================================================

    #[test]
    fn concurrent_shift_open_rejects_second_starter() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let db_path =
            std::env::temp_dir().join(format!("pos-shift-race-{}.db", uuid::Uuid::new_v4()));

        // Setup: fresh file-backed DB with migrations + WAL + foreign keys.
        {
            let conn = Connection::open(&db_path).expect("open db for setup");
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA synchronous = NORMAL;",
            )
            .expect("pragma setup");
            db::run_migrations_for_test(&conn);
        }

        /// Mirrors the buggy pattern in shifts.rs::open_shift — pre-check
        /// SELECT runs outside the IMMEDIATE tx. Returns Ok(shift_id) on
        /// INSERT success, Err(msg) if pre-check or INSERT rejects.
        fn attempt_open_mirroring_bug(
            path: &std::path::Path,
            staff_id: &str,
        ) -> Result<String, String> {
            let conn = Connection::open(path).map_err(|e| format!("open: {e}"))?;
            conn.execute_batch("PRAGMA busy_timeout = 5000;")
                .map_err(|e| format!("pragma: {e}"))?;

            // Pre-check OUTSIDE transaction (mirrors the bug).
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM staff_shifts WHERE staff_id = ?1 AND status = 'active'",
                    params![staff_id],
                    |row| row.get(0),
                )
                .ok();
            if let Some(existing_id) = existing {
                return Err(format!("already active: {existing_id}"));
            }

            // Small window where the other thread's INSERT can slip in
            // after OUR pre-check but before OUR INSERT.
            thread::sleep(std::time::Duration::from_millis(15));

            conn.execute_batch("BEGIN IMMEDIATE")
                .map_err(|e| format!("begin: {e}"))?;
            let shift_id = uuid::Uuid::new_v4().to_string();
            let now = Utc::now().to_rfc3339();
            // W4e Step 0: dual-populate (0.0 → 0).
            let ins = conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, role_type, branch_id, terminal_id,
                    check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, calculation_version, sync_status,
                    created_at, updated_at)
                 VALUES (?1, ?2, 'cashier', 'branch-race', ?3, ?4, 0.0, 0, 'active', 2, 'pending', ?4, ?4)",
                params![shift_id, staff_id, format!("term-{shift_id}"), now],
            );
            match ins {
                Ok(_) => {
                    conn.execute_batch("COMMIT")
                        .map_err(|e| format!("commit: {e}"))?;
                    Ok(shift_id)
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(format!("insert rejected: {e}"))
                }
            }
        }

        let staff_id = "staff-race-test";
        let barrier = Arc::new(Barrier::new(2));

        let (path_a, path_b) = (db_path.clone(), db_path.clone());
        let (bar_a, bar_b) = (Arc::clone(&barrier), Arc::clone(&barrier));

        let ta = thread::spawn(move || {
            bar_a.wait();
            attempt_open_mirroring_bug(&path_a, staff_id)
        });
        let tb = thread::spawn(move || {
            bar_b.wait();
            attempt_open_mirroring_bug(&path_b, staff_id)
        });

        let ra = ta.join().expect("t1 join");
        let rb = tb.join().expect("t2 join");

        // Count successful INSERTs before cleanup.
        let ok_count = [&ra, &rb].iter().filter(|r| r.is_ok()).count();

        // Also: query the DB for total active shifts.
        let active_count: i64 = {
            let conn = Connection::open(&db_path).expect("open for verify");
            conn.query_row(
                "SELECT COUNT(*) FROM staff_shifts WHERE staff_id = ?1 AND status = 'active'",
                params![staff_id],
                |row| row.get(0),
            )
            .expect("count active shifts")
        };

        // Best-effort cleanup (ignore failures on WAL sidecar files).
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));

        assert_eq!(
            ok_count, 1,
            "Expected exactly one concurrent shift-open to succeed, got {ok_count}. \
             Results: ra={ra:?} rb={rb:?}. Wave 2a C2 must close this race."
        );
        assert_eq!(
            active_count, 1,
            "Expected exactly one active shift in DB after the race, found {active_count}. \
             Cross-terminal exclusivity invariant violated (Wave 2a C2)."
        );
    }

    // ------------------------------------------------------------------
    // Wave 1 C15: keyring is authoritative for tenant identity
    // ------------------------------------------------------------------

    #[test]
    fn open_shift_accepts_renderer_identity_matching_keyring() {
        let _fake = crate::tests::fake_keyring::install_seeded([
            ("branch_id", "branch-seeded"),
            ("terminal_id", "terminal-seeded"),
        ]);
        let db = test_db();

        let payload = serde_json::json!({
            "staffId": "staff-match",
            "branchId": "branch-seeded",
            "terminalId": "terminal-seeded",
            "roleType": "cashier",
            "openingCash": 100.0,
        });
        let result = open_shift(&db, &payload);
        assert!(
            result.is_ok(),
            "matching renderer identity must succeed: {result:?}"
        );
    }

    #[test]
    fn open_shift_rejects_renderer_branch_id_disagreeing_with_keyring() {
        let _fake = crate::tests::fake_keyring::install_seeded([
            ("branch_id", "branch-real"),
            ("terminal_id", "terminal-real"),
        ]);
        let db = test_db();

        let payload = serde_json::json!({
            "staffId": "staff-evil-branch",
            "branchId": "branch-evil",
            "terminalId": "terminal-real",
            "roleType": "cashier",
            "openingCash": 100.0,
        });
        let err = open_shift(&db, &payload).expect_err("tenant mismatch must reject");
        assert!(
            err.contains("Tenant mismatch") && err.contains("branchId"),
            "error message must flag the mismatched field; got: {err}"
        );

        // Nothing should have landed in staff_shifts.
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM staff_shifts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "rejected shift must not be persisted");
    }

    #[test]
    fn open_shift_rejects_renderer_terminal_id_disagreeing_with_keyring() {
        let _fake = crate::tests::fake_keyring::install_seeded([
            ("branch_id", "branch-real"),
            ("terminal_id", "terminal-real"),
        ]);
        let db = test_db();

        let payload = serde_json::json!({
            "staffId": "staff-evil-terminal",
            "branchId": "branch-real",
            "terminalId": "terminal-evil",
            "roleType": "cashier",
            "openingCash": 100.0,
        });
        let err = open_shift(&db, &payload).expect_err("tenant mismatch must reject");
        assert!(
            err.contains("Tenant mismatch") && err.contains("terminalId"),
            "error message must flag the mismatched field; got: {err}"
        );
    }

    #[test]
    fn open_shift_uses_keyring_when_renderer_omits_identity() {
        let _fake = crate::tests::fake_keyring::install_seeded([
            ("branch_id", "branch-from-keyring"),
            ("terminal_id", "terminal-from-keyring"),
        ]);
        let db = test_db();

        // Renderer sends only staffId — everything else must fill from keyring.
        let payload = serde_json::json!({
            "staffId": "staff-keyring-only",
            "roleType": "cashier",
            "openingCash": 100.0,
        });
        let result = open_shift(&db, &payload).expect("shift should open using keyring");
        let shift_id = result["shiftId"]
            .as_str()
            .expect("response carries shiftId")
            .to_string();

        let conn = db.conn.lock().unwrap();
        let (branch, terminal): (String, String) = conn
            .query_row(
                "SELECT branch_id, terminal_id FROM staff_shifts WHERE id = ?1",
                params![shift_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(branch, "branch-from-keyring");
        assert_eq!(terminal, "terminal-from-keyring");
    }

    #[test]
    fn open_shift_falls_back_to_renderer_when_keyring_empty() {
        // Unprovisioned terminal: no keyring entries. Renderer value is used;
        // this preserves onboarding / legacy behaviour. Admin-API key gate
        // already prevents unprovisioned terminals from hitting real tenants.
        let _fake = crate::tests::fake_keyring::install_empty();
        let db = test_db();

        let payload = serde_json::json!({
            "staffId": "staff-onboarding",
            "branchId": "branch-renderer",
            "terminalId": "terminal-renderer",
            "roleType": "cashier",
            "openingCash": 100.0,
        });
        let result = open_shift(&db, &payload).expect("onboarding shift should open");
        let shift_id = result["shiftId"].as_str().unwrap().to_string();

        let conn = db.conn.lock().unwrap();
        let (branch, terminal): (String, String) = conn
            .query_row(
                "SELECT branch_id, terminal_id FROM staff_shifts WHERE id = ?1",
                params![shift_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(branch, "branch-renderer");
        assert_eq!(terminal, "terminal-renderer");
    }
}
