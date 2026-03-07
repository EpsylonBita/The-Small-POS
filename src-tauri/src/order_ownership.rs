use rusqlite::{params, Connection};
use uuid::Uuid;

pub struct DriverOwnershipAssignment {
    pub driver_shift_id: String,
    pub branch_id: String,
    pub delivery_fee: f64,
    pub tip_amount: f64,
    pub payment_method: String,
    pub cash_collected: f64,
    pub card_amount: f64,
}

#[allow(dead_code)]
pub struct OrderAttributionSnapshot {
    pub shift_id: Option<String>,
    pub staff_id: Option<String>,
    pub driver_id: Option<String>,
    pub driver_name: Option<String>,
    pub branch_id: String,
    pub terminal_id: String,
    pub delivery_fee: f64,
    pub tip_amount: f64,
    pub status: String,
    pub order_type: String,
    pub payment_method: String,
    pub cash_collected: f64,
    pub card_amount: f64,
    pub total_paid: f64,
    pub recorded_cash_collected: f64,
    pub recorded_card_amount: f64,
}

fn normalize_opt_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn resolve_shift_context(
    conn: &Connection,
    shift_id: &str,
) -> Result<Option<(String, String, String, String)>, String> {
    let shift_context = conn
        .query_row(
            "SELECT
                role_type,
                staff_id,
                COALESCE(branch_id, ''),
                COALESCE(terminal_id, '')
             FROM staff_shifts
             WHERE id = ?1
             LIMIT 1",
            params![shift_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .ok();

    Ok(shift_context)
}

pub fn resolve_active_cashier_assignment(
    conn: &Connection,
    branch_id: &str,
    terminal_id: &str,
) -> Result<Option<(String, String)>, String> {
    let assignment = conn
        .query_row(
            "SELECT ss.id, ss.staff_id
             FROM staff_shifts ss
             LEFT JOIN cash_drawer_sessions cds
               ON cds.staff_shift_id = ss.id
              AND cds.closed_at IS NULL
             WHERE ss.branch_id = ?1
               AND ss.terminal_id = ?2
               AND ss.status = 'active'
               AND ss.role_type IN ('cashier', 'manager')
             ORDER BY
               CASE WHEN cds.id IS NULL THEN 1 ELSE 0 END,
               ss.check_in_time DESC
             LIMIT 1",
            params![branch_id, terminal_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    Ok(assignment)
}

pub fn resolve_order_owner(
    conn: &Connection,
    order_type: &str,
    branch_id: &str,
    terminal_id: &str,
    driver_id: Option<&str>,
    requested_shift_id: Option<&str>,
    requested_staff_id: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let normalized_order_type = order_type.trim().to_ascii_lowercase();
    let normalized_driver_id = normalize_opt_text(driver_id);
    let normalized_shift_id = normalize_opt_text(requested_shift_id);
    let mut normalized_staff_id = normalize_opt_text(requested_staff_id);
    let mut effective_branch_id = normalize_opt_text(Some(branch_id));
    let mut effective_terminal_id = normalize_opt_text(Some(terminal_id));

    if let Some(shift_id) = normalized_shift_id.as_deref() {
        if let Some((shift_role, shift_staff_id, shift_branch_id, shift_terminal_id)) =
            resolve_shift_context(conn, shift_id)?
        {
            if effective_branch_id.is_none() {
                effective_branch_id = normalize_opt_text(Some(shift_branch_id.as_str()));
            }
            if effective_terminal_id.is_none() {
                effective_terminal_id = normalize_opt_text(Some(shift_terminal_id.as_str()));
            }
            if normalized_staff_id.is_none() {
                normalized_staff_id = Some(shift_staff_id.clone());
            }
            let _ = shift_role;
        }
    }

    if normalized_order_type == "delivery" {
        if let Some(driver_id_value) = normalized_driver_id.as_deref() {
            if let Some(driver_shift_id) =
                resolve_driver_shift_id(conn, driver_id_value, normalized_shift_id.as_deref())?
            {
                return Ok((Some(driver_shift_id), Some(driver_id_value.to_string())));
            }
        }

        return Ok((None, None));
    }

    if let (Some(branch_id_value), Some(terminal_id_value)) = (
        effective_branch_id.as_deref(),
        effective_terminal_id.as_deref(),
    ) {
        if let Some((cashier_shift_id, cashier_staff_id)) =
            resolve_active_cashier_assignment(conn, branch_id_value, terminal_id_value)?
        {
            return Ok((Some(cashier_shift_id), Some(cashier_staff_id)));
        }
    }

    let fallback_staff_id = if normalized_order_type == "delivery" {
        normalized_driver_id.or(normalized_staff_id)
    } else {
        normalized_staff_id
    };

    Ok((normalized_shift_id, fallback_staff_id))
}

pub fn resolve_driver_shift_id(
    conn: &Connection,
    driver_id: &str,
    requested_shift_id: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(shift_id) = requested_shift_id.filter(|sid| !sid.trim().is_empty()) {
        let matches_driver = conn
            .query_row(
                "SELECT CASE
                    WHEN staff_id = ?1 AND role_type = 'driver' AND status = 'active'
                    THEN 1 ELSE 0 END
                 FROM staff_shifts
                 WHERE id = ?2",
                params![driver_id, shift_id],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .unwrap_or(0)
            == 1;

        if matches_driver {
            return Ok(Some(shift_id.to_string()));
        }
    }

    let active_shift_id = conn
        .query_row(
            "SELECT id
             FROM staff_shifts
             WHERE staff_id = ?1
               AND role_type = 'driver'
               AND status = 'active'
             ORDER BY check_in_time DESC
             LIMIT 1",
            params![driver_id],
            |row| row.get::<_, String>(0),
        )
        .ok();

    Ok(active_shift_id)
}

pub fn assign_order_to_driver_shift(
    conn: &Connection,
    order_id: &str,
    driver_id: &str,
    driver_name: Option<&str>,
    driver_shift_id: &str,
    now: &str,
) -> Result<DriverOwnershipAssignment, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    let target_status = if is_final_order_status(&current.status) {
        None
    } else {
        Some("out_for_delivery")
    };
    let applied = apply_order_attribution(
        conn,
        order_id,
        Some(driver_shift_id),
        Some(driver_id),
        Some(driver_id),
        driver_name,
        Some("delivery"),
        target_status,
        now,
    )?;

    Ok(DriverOwnershipAssignment {
        driver_shift_id: driver_shift_id.to_string(),
        branch_id: applied.branch_id,
        delivery_fee: applied.delivery_fee,
        tip_amount: applied.tip_amount,
        payment_method: applied.payment_method,
        cash_collected: applied.cash_collected,
        card_amount: applied.card_amount,
    })
}

pub fn upsert_driver_earning(
    conn: &Connection,
    order_id: &str,
    driver_id: &str,
    assignment: &DriverOwnershipAssignment,
    now: &str,
) -> Result<String, String> {
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM driver_earnings WHERE order_id = ?1 LIMIT 1",
            params![order_id],
            |row| row.get(0),
        )
        .ok();

    let total_earning = assignment.delivery_fee + assignment.tip_amount;
    let cash_to_return = assignment.cash_collected;

    if let Some(existing_id) = existing_id {
        conn.execute(
            "UPDATE driver_earnings
             SET driver_id = ?1,
                 staff_shift_id = ?2,
                 branch_id = ?3,
                 delivery_fee = ?4,
                 tip_amount = ?5,
                 total_earning = ?6,
                 payment_method = ?7,
                 cash_collected = ?8,
                 card_amount = ?9,
                 cash_to_return = ?10,
                 updated_at = ?11
             WHERE id = ?12",
            params![
                driver_id,
                assignment.driver_shift_id,
                assignment.branch_id,
                assignment.delivery_fee,
                assignment.tip_amount,
                total_earning,
                assignment.payment_method,
                assignment.cash_collected,
                assignment.card_amount,
                cash_to_return,
                now,
                existing_id
            ],
        )
        .map_err(|e| format!("update driver earning: {e}"))?;

        Ok(existing_id)
    } else {
        let earning_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id,
                delivery_fee, tip_amount, total_earning,
                payment_method, cash_collected, card_amount, cash_to_return,
                settled, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?13)",
            params![
                earning_id,
                driver_id,
                assignment.driver_shift_id,
                order_id,
                assignment.branch_id,
                assignment.delivery_fee,
                assignment.tip_amount,
                total_earning,
                assignment.payment_method,
                assignment.cash_collected,
                assignment.card_amount,
                cash_to_return,
                now
            ],
        )
        .map_err(|e| format!("insert driver earning: {e}"))?;

        Ok(earning_id)
    }
}

pub fn get_order_payment_totals(
    conn: &Connection,
    order_id: &str,
) -> Result<(String, f64, f64, f64), String> {
    let (payment_count, cash_collected, card_amount, total_paid): (i64, f64, f64, f64) = conn
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
        .map_err(|e| format!("load order payments: {e}"))?;

    if payment_count == 0 {
        let (total_amount, payment_method) = conn
            .query_row(
                "SELECT COALESCE(total_amount, 0), COALESCE(payment_method, 'cash')
                 FROM orders
                 WHERE id = ?1",
                params![order_id],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|e| format!("load order payment fallback: {e}"))?;

        let normalized = payment_method.to_lowercase();
        let cash = if normalized == "cash" || normalized == "mixed" {
            total_amount
        } else {
            0.0
        };
        let card = if normalized == "card" || normalized == "mixed" {
            total_amount
        } else {
            0.0
        };
        return Ok((normalized, cash, card, total_amount));
    }

    let payment_method = if cash_collected > 0.0 && card_amount > 0.0 {
        "mixed".to_string()
    } else if card_amount > 0.0 {
        "card".to_string()
    } else if total_paid > 0.0 {
        "cash".to_string()
    } else {
        "cash".to_string()
    };

    Ok((payment_method, cash_collected, card_amount, total_paid))
}

pub fn is_final_order_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "delivered" | "completed" | "cancelled" | "canceled" | "refunded"
    )
}

pub fn is_cancelled_order_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "cancelled" | "canceled" | "refunded"
    )
}

pub fn load_order_attribution_snapshot(
    conn: &Connection,
    order_id: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let (
        shift_id,
        staff_id,
        driver_id,
        driver_name,
        branch_id,
        terminal_id,
        delivery_fee,
        tip_amount,
        status,
        order_type,
    ): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        f64,
        f64,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT
                staff_shift_id,
                staff_id,
                driver_id,
                driver_name,
                COALESCE(branch_id, ''),
                COALESCE(terminal_id, ''),
                COALESCE(delivery_fee, 0),
                COALESCE(tip_amount, 0),
                COALESCE(status, 'pending'),
                COALESCE(order_type, 'pickup')
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get::<_, f64>(6).unwrap_or(0.0),
                    row.get::<_, f64>(7).unwrap_or(0.0),
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .map_err(|e| format!("load order attribution snapshot: {e}"))?;

    let (payment_method, cash_collected, card_amount, total_paid) =
        get_order_payment_totals(conn, order_id)?;
    let (recorded_cash_collected, recorded_card_amount, _) =
        get_recorded_order_payment_totals(conn, order_id)?;

    Ok(OrderAttributionSnapshot {
        shift_id,
        staff_id,
        driver_id,
        driver_name,
        branch_id,
        terminal_id,
        delivery_fee,
        tip_amount,
        status,
        order_type,
        payment_method,
        cash_collected,
        card_amount,
        total_paid,
        recorded_cash_collected,
        recorded_card_amount,
    })
}

pub fn apply_order_attribution(
    conn: &Connection,
    order_id: &str,
    target_shift_id: Option<&str>,
    target_staff_id: Option<&str>,
    target_driver_id: Option<&str>,
    target_driver_name: Option<&str>,
    target_order_type: Option<&str>,
    target_status: Option<&str>,
    now: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    let normalized_shift_id = normalize_opt_text(target_shift_id);
    let normalized_staff_id = normalize_opt_text(target_staff_id);
    let normalized_driver_id = normalize_opt_text(target_driver_id);
    let normalized_driver_name = normalize_opt_text(target_driver_name);
    let normalized_order_type = target_order_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| current.order_type.clone());
    let normalized_status = target_status
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| current.status.clone());

    if current.shift_id != normalized_shift_id {
        adjust_drawer_totals(
            conn,
            current.shift_id.as_deref(),
            -current.recorded_cash_collected,
            -current.recorded_card_amount,
            now,
        )?;
        adjust_drawer_totals(
            conn,
            normalized_shift_id.as_deref(),
            current.recorded_cash_collected,
            current.recorded_card_amount,
            now,
        )?;
    }

    conn.execute(
        "UPDATE orders
         SET staff_id = ?1,
             staff_shift_id = ?2,
             driver_id = ?3,
             driver_name = ?4,
             order_type = ?5,
             status = ?6,
             sync_status = 'pending',
             updated_at = ?7
         WHERE id = ?8",
        params![
            normalized_staff_id,
            normalized_shift_id,
            normalized_driver_id,
            normalized_driver_name,
            normalized_order_type,
            normalized_status,
            now,
            order_id
        ],
    )
    .map_err(|e| format!("apply order attribution: {e}"))?;

    conn.execute(
        "UPDATE order_payments
         SET staff_id = ?1,
             staff_shift_id = ?2,
             sync_status = 'pending',
             updated_at = ?3
         WHERE order_id = ?4
           AND status = 'completed'",
        params![normalized_staff_id, normalized_shift_id, now, order_id],
    )
    .map_err(|e| format!("reassign order payments: {e}"))?;

    Ok(OrderAttributionSnapshot {
        shift_id: normalized_shift_id,
        staff_id: normalized_staff_id,
        driver_id: normalized_driver_id,
        driver_name: normalized_driver_name,
        branch_id: current.branch_id,
        terminal_id: current.terminal_id,
        delivery_fee: current.delivery_fee,
        tip_amount: current.tip_amount,
        status: normalized_status,
        order_type: normalized_order_type,
        payment_method: current.payment_method,
        cash_collected: current.cash_collected,
        card_amount: current.card_amount,
        total_paid: current.total_paid,
        recorded_cash_collected: current.recorded_cash_collected,
        recorded_card_amount: current.recorded_card_amount,
    })
}

pub fn reverse_order_drawer_attribution(
    conn: &Connection,
    order_id: &str,
    now: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    adjust_drawer_totals(
        conn,
        current.shift_id.as_deref(),
        -current.recorded_cash_collected,
        -current.recorded_card_amount,
        now,
    )?;
    Ok(current)
}

pub fn assign_order_to_cashier_pickup(
    conn: &Connection,
    order_id: &str,
    now: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    let (cashier_shift_id, cashier_staff_id) = resolve_active_cashier_assignment(
        conn,
        current.branch_id.as_str(),
        current.terminal_id.as_str(),
    )?
    .ok_or_else(|| "No active cashier shift available for pickup attribution".to_string())?;

    let target_status = if current.status.eq_ignore_ascii_case("out_for_delivery") {
        Some("ready")
    } else {
        None
    };

    apply_order_attribution(
        conn,
        order_id,
        Some(cashier_shift_id.as_str()),
        Some(cashier_staff_id.as_str()),
        None,
        None,
        Some("pickup"),
        target_status,
        now,
    )
}

fn get_recorded_order_payment_totals(
    conn: &Connection,
    order_id: &str,
) -> Result<(f64, f64, f64), String> {
    conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN status = 'completed' AND method = 'cash' THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'completed' AND method = 'card' THEN amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0)
         FROM order_payments
         WHERE order_id = ?1",
        params![order_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .map_err(|e| format!("load recorded order payments: {e}"))
}

fn adjust_drawer_totals(
    conn: &Connection,
    shift_id: Option<&str>,
    cash_delta: f64,
    card_delta: f64,
    now: &str,
) -> Result<(), String> {
    let Some(shift_id) = shift_id.filter(|sid| !sid.trim().is_empty()) else {
        return Ok(());
    };

    conn.execute(
        "UPDATE cash_drawer_sessions
         SET total_cash_sales = CASE
                WHEN COALESCE(total_cash_sales, 0) + ?1 < 0 THEN 0
                ELSE COALESCE(total_cash_sales, 0) + ?1
             END,
             total_card_sales = CASE
                WHEN COALESCE(total_card_sales, 0) + ?2 < 0 THEN 0
                ELSE COALESCE(total_card_sales, 0) + ?2
             END,
             updated_at = ?3
         WHERE staff_shift_id = ?4",
        params![cash_delta, card_delta, now, shift_id],
    )
    .map_err(|e| format!("adjust drawer totals: {e}"))?;

    Ok(())
}
