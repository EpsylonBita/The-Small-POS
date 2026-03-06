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

fn resolve_active_driver_assignment_for_shift(
    conn: &Connection,
    requested_shift_id: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    let Some(shift_id) = normalize_opt_text(requested_shift_id) else {
        return Ok(None);
    };

    let assignment = conn
        .query_row(
            "SELECT id, staff_id
             FROM staff_shifts
             WHERE id = ?1
               AND role_type = 'driver'
               AND status = 'active'
             LIMIT 1",
            params![shift_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    Ok(assignment)
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
    let mut normalized_driver_id = normalize_opt_text(driver_id);
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
            if normalized_order_type == "delivery"
                && normalized_driver_id.is_none()
                && shift_role == "driver"
            {
                normalized_driver_id = Some(shift_staff_id);
            }
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

        if let Some((shift_id, staff_id)) =
            resolve_active_driver_assignment_for_shift(conn, normalized_shift_id.as_deref())?
        {
            return Ok((Some(shift_id), Some(staff_id)));
        }
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
    let (old_shift_id, _old_staff_id, branch_id, delivery_fee, tip_amount): (
        Option<String>,
        Option<String>,
        String,
        f64,
        f64,
    ) = conn
        .query_row(
            "SELECT staff_shift_id, staff_id, COALESCE(branch_id, ''), COALESCE(delivery_fee, 0), COALESCE(tip_amount, 0)
             FROM orders
             WHERE id = ?1",
            params![order_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3).unwrap_or(0.0),
                    row.get::<_, f64>(4).unwrap_or(0.0),
                ))
            },
        )
        .map_err(|e| format!("load order ownership: {e}"))?;

    let (payment_method, cash_collected, card_amount, _paid_total) =
        get_order_payment_totals(conn, order_id)?;

    if old_shift_id.as_deref() != Some(driver_shift_id) {
        adjust_drawer_totals(
            conn,
            old_shift_id.as_deref(),
            -cash_collected,
            -card_amount,
            now,
        )?;
        adjust_drawer_totals(
            conn,
            Some(driver_shift_id),
            cash_collected,
            card_amount,
            now,
        )?;
    }

    conn.execute(
        "UPDATE orders
         SET staff_id = ?1,
             driver_id = ?1,
             driver_name = ?2,
             staff_shift_id = ?3,
             sync_status = 'pending',
             updated_at = ?4
         WHERE id = ?5",
        params![driver_id, driver_name, driver_shift_id, now, order_id],
    )
    .map_err(|e| format!("assign order ownership: {e}"))?;

    conn.execute(
        "UPDATE order_payments
         SET staff_id = ?1,
             staff_shift_id = ?2,
             sync_status = 'pending',
             updated_at = ?3
         WHERE order_id = ?4
           AND status = 'completed'",
        params![driver_id, driver_shift_id, now, order_id],
    )
    .map_err(|e| format!("reassign order payments: {e}"))?;

    Ok(DriverOwnershipAssignment {
        driver_shift_id: driver_shift_id.to_string(),
        branch_id,
        delivery_fee,
        tip_amount,
        payment_method,
        cash_collected,
        card_amount,
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
