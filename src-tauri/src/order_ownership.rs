use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::business_day;

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

fn resolve_historical_financial_owner(
    conn: &Connection,
    current: &OrderAttributionSnapshot,
    financial_effective_at: &str,
) -> Result<Option<(String, String)>, String> {
    if let Some(current_shift_id) = current.shift_id.as_deref() {
        if let Some((role_type, staff_id, _, _)) = resolve_shift_context(conn, current_shift_id)? {
            if matches!(role_type.as_str(), "cashier" | "manager")
                && business_day::shift_contains_timestamp(conn, current_shift_id, financial_effective_at)?
            {
                return Ok(Some((current_shift_id.to_string(), staff_id)));
            }
        }
    }

    if current.branch_id.trim().is_empty() {
        return Ok(None);
    }

    business_day::find_cashier_owner_for_timestamp(
        conn,
        current.branch_id.as_str(),
        financial_effective_at,
    )
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

pub fn resolve_active_cashier_assignment_for_branch(
    conn: &Connection,
    branch_id: &str,
) -> Result<Option<(String, String)>, String> {
    let assignment = conn
        .query_row(
            "SELECT ss.id, ss.staff_id
             FROM staff_shifts ss
             LEFT JOIN cash_drawer_sessions cds
               ON cds.staff_shift_id = ss.id
              AND cds.closed_at IS NULL
             WHERE ss.branch_id = ?1
               AND ss.status = 'active'
               AND ss.role_type IN ('cashier', 'manager')
             ORDER BY
               CASE WHEN cds.id IS NULL THEN 1 ELSE 0 END,
               ss.check_in_time DESC
             LIMIT 1",
            params![branch_id],
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
        true,
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

#[allow(clippy::type_complexity)]
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

#[allow(clippy::too_many_arguments)]
pub fn apply_order_attribution(
    conn: &Connection,
    order_id: &str,
    target_shift_id: Option<&str>,
    target_staff_id: Option<&str>,
    target_driver_id: Option<&str>,
    target_driver_name: Option<&str>,
    target_order_type: Option<&str>,
    target_status: Option<&str>,
    reassign_financial_owner: bool,
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
    let effective_shift_id = if reassign_financial_owner {
        normalized_shift_id.clone()
    } else {
        current.shift_id.clone()
    };
    let effective_staff_id = if reassign_financial_owner {
        normalized_staff_id.clone()
    } else {
        current.staff_id.clone()
    };

    if reassign_financial_owner && current.shift_id != normalized_shift_id {
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
            effective_staff_id,
            effective_shift_id,
            normalized_driver_id,
            normalized_driver_name,
            normalized_order_type,
            normalized_status,
            now,
            order_id
        ],
    )
    .map_err(|e| format!("apply order attribution: {e}"))?;

    if reassign_financial_owner {
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
    }

    Ok(OrderAttributionSnapshot {
        shift_id: effective_shift_id,
        staff_id: effective_staff_id,
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

pub struct RemovedDriverEarning {
    pub id: String,
    pub supabase_id: Option<String>,
}

pub fn remove_driver_earning_for_order(
    conn: &Connection,
    order_id: &str,
) -> Result<Option<RemovedDriverEarning>, String> {
    let earning: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT id, supabase_id
             FROM driver_earnings
             WHERE order_id = ?1
             LIMIT 1",
            params![order_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .ok();

    let Some((earning_id, supabase_id)) = earning else {
        return Ok(None);
    };

    conn.execute(
        "DELETE FROM driver_earnings
         WHERE id = ?1",
        params![earning_id],
    )
    .map_err(|e| format!("delete driver earning: {e}"))?;

    Ok(Some(RemovedDriverEarning {
        id: earning_id,
        supabase_id: normalize_opt_text(supabase_id.as_deref()),
    }))
}

pub fn assign_order_to_cashier_pickup(
    conn: &Connection,
    order_id: &str,
    acting_terminal_id: Option<&str>,
    now: &str,
) -> Result<OrderAttributionSnapshot, String> {
    let current = load_order_attribution_snapshot(conn, order_id)?;
    let financial_effective_at =
        business_day::resolve_order_financial_effective_at(conn, order_id)?;
    let preferred_terminal_id =
        normalize_opt_text(acting_terminal_id).or_else(|| normalize_opt_text(Some(current.terminal_id.as_str())));
    let original_terminal_id = normalize_opt_text(Some(current.terminal_id.as_str()));

    let mut cashier_assignment = None;
    if !current.branch_id.trim().is_empty() {
        if let Some(terminal_id) = preferred_terminal_id.as_deref() {
            cashier_assignment =
                resolve_active_cashier_assignment(conn, current.branch_id.as_str(), terminal_id)?;
        }

        if cashier_assignment.is_none() {
            if let Some(terminal_id) = original_terminal_id.as_deref() {
                if preferred_terminal_id.as_deref() != Some(terminal_id) {
                    cashier_assignment = resolve_active_cashier_assignment(
                        conn,
                        current.branch_id.as_str(),
                        terminal_id,
                    )?;
                }
            }
        }

        if cashier_assignment.is_none() {
            cashier_assignment =
                resolve_active_cashier_assignment_for_branch(conn, current.branch_id.as_str())?;
        }
    }

    let (cashier_shift_id, cashier_staff_id) = if let Some((shift_id, staff_id)) = cashier_assignment
    {
        (Some(shift_id), Some(staff_id))
    } else {
        resolve_order_owner(
            conn,
            "pickup",
            current.branch_id.as_str(),
            preferred_terminal_id
                .as_deref()
                .or_else(|| original_terminal_id.as_deref())
                .unwrap_or_default(),
            current.driver_id.as_deref(),
            current.shift_id.as_deref(),
            current.staff_id.as_deref(),
        )?
    };

    let target_status = if current.status.eq_ignore_ascii_case("out_for_delivery") {
        Some("ready")
    } else {
        None
    };

    let reassign_to_cashier = cashier_shift_id
        .as_deref()
        .map(|shift_id| business_day::shift_contains_timestamp(conn, shift_id, &financial_effective_at))
        .transpose()?
        .unwrap_or(false);

    let (target_shift_id, target_staff_id, reassign_financial_owner) = if cashier_shift_id.is_some()
    {
        if reassign_to_cashier {
            (cashier_shift_id, cashier_staff_id, true)
        } else if let Some((historical_shift_id, historical_staff_id)) =
            resolve_historical_financial_owner(conn, &current, &financial_effective_at)?
        {
            (
                Some(historical_shift_id),
                Some(historical_staff_id),
                true,
            )
        } else {
            (None, None, true)
        }
    } else {
        (cashier_shift_id, cashier_staff_id, false)
    };

    apply_order_attribution(
        conn,
        order_id,
        target_shift_id.as_deref(),
        target_staff_id.as_deref(),
        None,
        None,
        Some("pickup"),
        target_status,
        reassign_financial_owner,
        now,
    )
}

pub fn repair_historical_pickup_financial_attribution(
    conn: &Connection,
    branch_id: &str,
    now: &str,
) -> Result<usize, String> {
    if branch_id.trim().is_empty() {
        return Ok(0);
    }

    let financial_expr = business_day::order_financial_timestamp_expr("o");
    let candidate_sql = format!(
        "SELECT o.id, {financial_expr}
         FROM orders o
         JOIN staff_shifts ss ON ss.id = o.staff_shift_id
         WHERE (?1 = '' OR o.branch_id = ?1 OR o.branch_id IS NULL)
           AND COALESCE(o.is_ghost, 0) = 0
           AND COALESCE(o.order_type, 'pickup') != 'delivery'
           AND o.staff_shift_id IS NOT NULL
           AND (
                {financial_expr} < ss.check_in_time
                OR (
                    ss.check_out_time IS NOT NULL
                    AND {financial_expr} > ss.check_out_time
                )
           )"
    );

    let candidates = conn
        .prepare(&candidate_sql)
        .map_err(|e| format!("prepare historical pickup repair query: {e}"))?
        .query_map(params![branch_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query historical pickup repair candidates: {e}"))?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();

    let mut repaired = 0usize;
    for (order_id, financial_effective_at) in candidates {
        let current = load_order_attribution_snapshot(conn, order_id.as_str())?;
        let historical_owner =
            resolve_historical_financial_owner(conn, &current, financial_effective_at.as_str())?;
        let (target_shift_id, target_staff_id) = if let Some((shift_id, staff_id)) = historical_owner
        {
            (Some(shift_id), Some(staff_id))
        } else {
            (None, None)
        };

        if current.shift_id == target_shift_id && current.staff_id == target_staff_id {
            continue;
        }

        apply_order_attribution(
            conn,
            order_id.as_str(),
            target_shift_id.as_deref(),
            target_staff_id.as_deref(),
            current.driver_id.as_deref(),
            current.driver_name.as_deref(),
            Some(current.order_type.as_str()),
            Some(current.status.as_str()),
            true,
            now,
        )?;
        repaired += 1;
    }

    Ok(repaired)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("pragma setup");
        db::run_migrations_for_test(&conn);
        conn
    }

    #[test]
    fn assign_pickup_prefers_acting_terminal_cashier_and_reassigns_payments() {
        let conn = test_conn();
        let now = "2026-03-13T10:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-shift', 'cashier-1', 'Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, 100.0, 'active', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-main', 'cash-shift', 'cashier-1', 'branch-1', 'terminal-main',
                100.0, ?1, ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver', 'branch-1', 'terminal-delivery', 'driver',
                ?1, 20.0, 'active', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, total_cash_sales, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-driver', 'driver-shift', 'driver-1', 'branch-1', 'terminal-delivery',
                20.0, 18.0, ?1, ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, payment_method, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                driver_name, created_at, updated_at
            ) VALUES (
                'order-1', '[]', 18.0, 'out_for_delivery', 'delivery', 'cash', 'paid',
                'pending', 'branch-1', 'terminal-delivery', 'driver-shift', 'driver-1',
                'driver-1', 'Driver', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, staff_id, currency, created_at, updated_at
            ) VALUES (
                'payment-1', 'order-1', 'cash', 18.0, 'completed', 'driver-shift', 'driver-1', 'EUR', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        assign_order_to_cashier_pickup(&conn, "order-1", Some("terminal-main"), now)
            .expect("convert order to pickup");

        let (shift_id, staff_id, driver_id, order_type, status): (
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id, driver_id, order_type, status
                 FROM orders
                 WHERE id = 'order-1'",
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
        let payment_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE id = 'payment-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let cashier_cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let driver_cash_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-driver'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(shift_id.as_deref(), Some("cash-shift"));
        assert_eq!(staff_id.as_deref(), Some("cashier-1"));
        assert_eq!(driver_id, None);
        assert_eq!(order_type, "pickup");
        assert_eq!(status, "ready");
        assert_eq!(payment_shift_id.as_deref(), Some("cash-shift"));
        assert_eq!(cashier_cash_sales, 18.0);
        assert_eq!(driver_cash_sales, 0.0);
    }

    #[test]
    fn assign_pickup_falls_back_to_existing_owner_when_no_cashier_is_active() {
        let conn = test_conn();
        let now = "2026-03-13T11:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-shift', 'driver-1', 'Driver', 'branch-1', 'terminal-delivery', 'driver',
                ?1, 20.0, 'active', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, payment_method, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                driver_name, created_at, updated_at
            ) VALUES (
                'order-2', '[]', 12.0, 'out_for_delivery', 'delivery', 'cash', 'paid',
                'pending', 'branch-1', 'terminal-delivery', 'driver-shift', 'driver-1',
                'driver-1', 'Driver', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        let applied = assign_order_to_cashier_pickup(&conn, "order-2", Some("terminal-main"), now)
            .expect("pickup conversion should not fail without active cashier");

        assert_eq!(applied.shift_id.as_deref(), Some("driver-shift"));
        assert_eq!(applied.staff_id.as_deref(), Some("driver-1"));
        assert_eq!(applied.driver_id, None);
        assert_eq!(applied.order_type, "pickup");
        assert_eq!(applied.status, "ready");
    }

    #[test]
    fn assign_pickup_restores_previous_day_cashier_instead_of_current_cashier() {
        let conn = test_conn();
        let payment_time = "2026-03-12T17:30:00Z";
        let old_cashier_start = "2026-03-12T09:00:00Z";
        let old_cashier_end = "2026-03-12T18:00:00Z";
        let current_cashier_start = "2026-03-13T09:00:00Z";
        let now = "2026-03-13T10:00:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-old', 'cashier-old', 'Old Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, ?2, 100.0, 'closed', 'pending', ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, total_cash_sales, opened_at, closed_at, created_at, updated_at
            ) VALUES (
                'drawer-old', 'cash-old', 'cashier-old', 'branch-1', 'terminal-main',
                100.0, 0.0, ?1, ?2, ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-new', 'cashier-new', 'Current Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, 100.0, 'active', 'pending', ?1, ?1
            )",
            params![current_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, total_cash_sales, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-new', 'cash-new', 'cashier-new', 'branch-1', 'terminal-main',
                100.0, 0.0, ?1, ?1, ?1
            )",
            params![current_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'driver-old', 'driver-1', 'Driver', 'branch-1', 'terminal-delivery', 'driver',
                ?1, 20.0, 'active', 'pending', ?1, ?1
            )",
            params![payment_time],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, payment_method, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, driver_id,
                driver_name, created_at, updated_at
            ) VALUES (
                'order-historical', '[]', 18.0, 'out_for_delivery', 'delivery', 'cash', 'paid',
                'pending', 'branch-1', 'terminal-delivery', 'driver-old', 'driver-1',
                'driver-1', 'Driver', ?1, ?1
            )",
            params![payment_time],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, staff_id, currency, created_at, updated_at
            ) VALUES (
                'payment-historical', 'order-historical', 'cash', 18.0, 'completed',
                'driver-old', 'driver-1', 'EUR', ?1, ?1
            )",
            params![payment_time],
        )
        .unwrap();

        assign_order_to_cashier_pickup(&conn, "order-historical", Some("terminal-main"), now)
            .expect("historical conversion should succeed");

        let (order_shift_id, order_staff_id, driver_id, order_type): (
            Option<String>,
            Option<String>,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT staff_shift_id, staff_id, driver_id, order_type
                 FROM orders
                 WHERE id = 'order-historical'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let payment_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE id = 'payment-historical'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let old_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let new_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-new'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(order_shift_id.as_deref(), Some("cash-old"));
        assert_eq!(order_staff_id.as_deref(), Some("cashier-old"));
        assert_eq!(payment_shift_id.as_deref(), Some("cash-old"));
        assert_eq!(driver_id, None);
        assert_eq!(order_type, "pickup");
        assert_eq!(old_drawer_sales, 18.0);
        assert_eq!(new_drawer_sales, 0.0);
    }

    #[test]
    fn repair_historical_pickup_financial_attribution_reverses_late_cashier_assignment() {
        let conn = test_conn();
        let old_cashier_start = "2026-03-12T09:00:00Z";
        let old_cashier_end = "2026-03-12T18:00:00Z";
        let late_cashier_start = "2026-03-13T09:00:00Z";
        let payment_time = "2026-03-12T17:45:00Z";
        let now = "2026-03-13T10:15:00Z";

        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, check_out_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-prev', 'cashier-prev', 'Previous Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, ?2, 100.0, 'closed', 'pending', ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, total_cash_sales, opened_at, closed_at, created_at, updated_at
            ) VALUES (
                'drawer-prev', 'cash-prev', 'cashier-prev', 'branch-1', 'terminal-main',
                100.0, 0.0, ?1, ?2, ?1, ?2
            )",
            params![old_cashier_start, old_cashier_end],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO staff_shifts (
                id, staff_id, staff_name, branch_id, terminal_id, role_type,
                check_in_time, opening_cash_amount, status, sync_status, created_at, updated_at
            ) VALUES (
                'cash-late', 'cashier-late', 'Late Cashier', 'branch-1', 'terminal-main', 'cashier',
                ?1, 100.0, 'active', 'pending', ?1, ?1
            )",
            params![late_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cash_drawer_sessions (
                id, staff_shift_id, cashier_id, branch_id, terminal_id,
                opening_amount, total_cash_sales, opened_at, created_at, updated_at
            ) VALUES (
                'drawer-late', 'cash-late', 'cashier-late', 'branch-1', 'terminal-main',
                100.0, 18.0, ?1, ?1, ?1
            )",
            params![late_cashier_start],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, payment_method, payment_status,
                sync_status, branch_id, terminal_id, staff_shift_id, staff_id, created_at, updated_at
            ) VALUES (
                'order-corrupt', '[]', 18.0, 'ready', 'pickup', 'cash', 'paid',
                'pending', 'branch-1', 'terminal-main', 'cash-late', 'cashier-late', ?1, ?2
            )",
            params![payment_time, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO order_payments (
                id, order_id, method, amount, status, staff_shift_id, staff_id, currency, created_at, updated_at
            ) VALUES (
                'payment-corrupt', 'order-corrupt', 'cash', 18.0, 'completed',
                'cash-late', 'cashier-late', 'EUR', ?1, ?2
            )",
            params![payment_time, now],
        )
        .unwrap();

        let repaired =
            repair_historical_pickup_financial_attribution(&conn, "branch-1", now).unwrap();
        assert_eq!(repaired, 1);

        let order_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM orders WHERE id = 'order-corrupt'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payment_shift_id: Option<String> = conn
            .query_row(
                "SELECT staff_shift_id FROM order_payments WHERE id = 'payment-corrupt'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let prev_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-prev'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let late_drawer_sales: f64 = conn
            .query_row(
                "SELECT total_cash_sales FROM cash_drawer_sessions WHERE id = 'drawer-late'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(order_shift_id.as_deref(), Some("cash-prev"));
        assert_eq!(payment_shift_id.as_deref(), Some("cash-prev"));
        assert_eq!(prev_drawer_sales, 18.0);
        assert_eq!(late_drawer_sales, 0.0);
    }

    #[test]
    fn remove_driver_earning_for_order_deletes_row_and_returns_remote_id() {
        let conn = test_conn();
        let now = "2026-03-13T12:00:00Z";

        conn.execute(
            "INSERT INTO orders (
                id, items, total_amount, status, order_type, sync_status, created_at, updated_at
            ) VALUES (
                'order-3', '[]', 10.0, 'completed', 'delivery', 'pending', ?1, ?1
            )",
            params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO driver_earnings (
                id, driver_id, staff_shift_id, order_id, branch_id,
                total_earning, payment_method, supabase_id, created_at, updated_at
            ) VALUES (
                'earning-1', 'driver-1', NULL, 'order-3', 'branch-1',
                3.0, 'cash', 'remote-earning-1', ?1, ?1
            )",
            params![now],
        )
        .unwrap();

        let removed = remove_driver_earning_for_order(&conn, "order-3")
            .expect("remove driver earning")
            .expect("driver earning should exist");
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM driver_earnings WHERE order_id = 'order-3'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(removed.id, "earning-1");
        assert_eq!(removed.supabase_id.as_deref(), Some("remote-earning-1"));
        assert_eq!(remaining, 0);
    }
}
