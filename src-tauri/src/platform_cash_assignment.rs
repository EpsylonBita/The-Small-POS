use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::{business_day, db, device_admission, money::Cents, payments};

const RULE: &str = "platform_cash_at_assignment";
const SAVEPOINT: &str = "SAVEPOINT platform_cash_at_assignment";
const RELEASE: &str = "RELEASE platform_cash_at_assignment";
const ROLLBACK: &str =
    "ROLLBACK TO platform_cash_at_assignment; RELEASE platform_cash_at_assignment";

pub(crate) struct PlatformCash {
    order_id: String,
    remote_order_id: Option<String>,
    terminal_id: String,
    branch_id: String,
    amount_cents: i64,
    tip_cents: i64,
    currency: String,
    driver_id: String,
    shift_id: String,
    declaration: Value,
}

pub(crate) fn platform_driver_cash_auto_enabled(conn: &Connection) -> bool {
    let Some(features) = db::get_setting(conn, "terminal", "enabled_features")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
    else {
        return false;
    };
    let read = |key| {
        features
            .get(key)
            .and_then(crate::edit_settlement_recovery::feature_flag)
    };
    read("platform_driver_cash_auto").or_else(|| read("platformDriverCashAuto")) == Some(true)
}

pub(crate) fn has_unresolved_collection(
    conn: &Connection,
    order_id: &str,
    remote_order_id: Option<&str>,
    client_request_id: Option<&str>,
) -> Result<bool, String> {
    let gift_debit: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM gift_card_redemption_attempts
                           WHERE local_order_id = ?1 AND status IN ('pending', 'remote_applied'))",
            [order_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("read unresolved gift debit: {error}"))?;
    if gift_debit {
        return Ok(true);
    }
    crate::unsaved_payments::has_unresolved_for_order(
        conn,
        order_id,
        remote_order_id,
        client_request_id,
    )
}

impl PlatformCash {
    pub(crate) fn before_move(
        conn: &Connection,
        order_id: &str,
        driver_id: &str,
        shift_id: &str,
        now: &str,
    ) -> Option<Self> {
        if !platform_driver_cash_auto_enabled(conn)
            || !payments::platform_declares_store_driver_cash(conn, order_id)
            || crate::hotel_folio::is_local(conn, order_id).ok()?
        {
            return None;
        }

        let admission =
            device_admission::last_known_in_local_scope(conn, device_admission::CASH_REGISTER)?;
        if admission.admitted
            || crate::fiscal::active_cache::try_closeout_verdict(&admission.branch_id)
                != crate::fiscal::active_cache::CacheVerdict::Inactive
        {
            return None;
        }

        let (remote_order_id, client_request_id, financial_at, currency) = conn
            .query_row(
                &format!(
                    "SELECT NULLIF(TRIM(o.supabase_id), ''), NULLIF(TRIM(o.client_request_id), ''),
                            {}, o.currency
                     FROM orders o
                     JOIN staff_shifts s ON s.id = ?2 AND s.staff_id = ?3
                         AND s.role_type = 'driver' AND s.status = 'active'
                         AND s.terminal_id = ?4 AND s.branch_id = o.branch_id
                         AND s.currency = o.currency
                     WHERE o.id = ?1 AND o.branch_id = ?5
                       AND NULLIF(TRIM(o.driver_id), '') IS NULL
                       AND o.order_type = 'delivery'
                       AND COALESCE(o.is_ghost, 0) = 0 AND COALESCE(o.is_test, 0) = 0
                       AND LOWER(COALESCE(o.status, '')) NOT IN ('cancelled', 'canceled')
                       AND {}
                       AND NOT EXISTS (SELECT 1 FROM order_payments WHERE order_id = o.id)
                       AND NOT EXISTS (SELECT 1 FROM payment_adjustments WHERE order_id = o.id)
                       AND NOT EXISTS (SELECT 1 FROM recovery_action_log
                           WHERE order_id = o.id AND action_id = ?6)",
                    business_day::order_financial_timestamp_expr("o"),
                    payments::unpaid_order_header_sql("o.payment_status")
                ),
                params![
                    order_id,
                    shift_id,
                    driver_id,
                    admission.terminal_id,
                    admission.branch_id,
                    RULE
                ],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .ok()?;

        let start = business_day::resolve_period_start(conn, &admission.branch_id, None);
        let inclusive = business_day::open_period_lower_bound_inclusive(conn, &admission.branch_id);
        let in_open_period: bool = conn
            .query_row(
                "SELECT COALESCE(julianday(?1) BETWEEN julianday(?2) AND julianday(?3)
                                 AND (?4 OR julianday(?1) > julianday(?2)), 0)",
                params![financial_at, start, now, inclusive],
                |row| row.get(0),
            )
            .ok()?;
        if !in_open_period {
            return None;
        }
        if has_unresolved_collection(
            conn,
            order_id,
            remote_order_id.as_deref(),
            client_request_id.as_deref(),
        )
        .ok()?
            || crate::commands::ecr::direct_sale_admission(conn, order_id, None).is_err()
        {
            return None;
        }
        let balance = payments::load_order_payment_balance_snapshot(conn, order_id).ok()?;
        let amount_cents = Cents::round_half_even(balance.outstanding_amount).as_i64();
        if amount_cents <= 0 {
            return None;
        }
        let tip_cents = payments::load_order_tip_inside_total_cents(conn, order_id).ok()?;
        let (_, food_delivery) = payments::platform_food_delivery(conn, order_id)?;
        let declaration: serde_json::Map<String, Value> = [
            "delivery_provider",
            "payment_method",
            "payment_type",
            "prepaid",
            "box_daas",
            "box_daas_declared",
        ]
        .into_iter()
        .map(|key| {
            let value = food_delivery
                .get(key)
                .cloned()
                .unwrap_or_else(|| json!("<missing>"));
            (key.to_owned(), value)
        })
        .collect();
        // Keep the terminal DB id in the audit when available.
        let terminal_id = db::get_setting(conn, "terminal", "source_terminal_db_id")
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
            .unwrap_or(admission.terminal_id);
        Some(Self {
            order_id: order_id.to_owned(),
            remote_order_id,
            terminal_id,
            branch_id: admission.branch_id,
            amount_cents,
            tip_cents,
            currency,
            driver_id: driver_id.to_owned(),
            shift_id: shift_id.to_owned(),
            declaration: Value::Object(declaration),
        })
    }

    pub(crate) fn payment_input(&self) -> Result<payments::PaymentRecordInput, String> {
        let amount = Cents::new(self.amount_cents).to_f64_dp2();
        let mut payload = json!({
            "orderId": self.order_id,
            "method": "cash",
            "amount": amount,
            "currency": self.currency,
            "paymentOrigin": "manual",
            "staffId": self.driver_id,
            "staffShiftId": self.shift_id,
            "cashReceived": amount,
            "changeGiven": 0.0,
        });
        if self.tip_cents > 0 {
            payload["tipAmount"] = json!(Cents::new(self.tip_cents).to_f64_dp2());
        }
        payments::build_payment_record_input(&payload)
    }

    fn record(&self, conn: &Connection, actor: Option<&str>, now: &str) -> Result<(), String> {
        let input = self.payment_input()?;
        let recorded = payments::record_payment_in_connection(
            conn,
            &input,
            &payments::PaymentInsertOptions::local(),
        )?;
        let verified: bool = conn
            .query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM order_payments p JOIN orders o ON o.id = p.order_id
                    WHERE p.id = ?1 AND p.order_id = ?2 AND p.staff_shift_id = ?3 AND p.staff_id = ?4
                      AND p.status = 'completed' AND p.method = 'cash' AND p.payment_origin = 'manual'
                      AND p.amount_cents = ?5 AND p.currency = ?6 AND o.payment_status = 'paid'
                 )",
                params![
                    recorded.payment_id,
                    self.order_id,
                    self.shift_id,
                    self.driver_id,
                    self.amount_cents,
                    self.currency
                ],
                |row| row.get(0),
            )
            .map_err(|error| format!("read assigned cash receipt: {error}"))?;
        let balance = payments::load_order_payment_balance_snapshot(conn, &self.order_id)?;
        if !verified || Cents::round_half_even(balance.outstanding_amount).as_i64() != 0 {
            return Err("Assigned cash receipt did not cover the order under its driver".into());
        }

        let payload = json!({
            "paymentId": recorded.payment_id,
            "orderId": self.order_id,
            "remoteOrderId": self.remote_order_id,
            "terminalId": self.terminal_id,
            "branchId": self.branch_id,
            "amountCents": self.amount_cents,
            "currency": self.currency,
            "driverId": self.driver_id,
            "driverShiftId": self.shift_id,
            "recordedAt": now,
            "rule": RULE,
            "ruleVersion": 1,
            "actor": actor.unwrap_or("unknown"),
            "declaration": self.declaration,
        });
        let inserted = conn
            .execute(
                "INSERT INTO recovery_action_log
                    (id, action_id, issue_code, success, entity_type, entity_id, order_id,
                     shift_id, actor_staff_id, payload_json, created_at)
                 VALUES (?1, ?2, ?2, 1, 'order', ?3, ?3, ?4, ?5, ?6, ?7)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    RULE,
                    self.order_id,
                    self.shift_id,
                    actor,
                    payload.to_string(),
                    now
                ],
            )
            .map_err(|error| format!("write assigned cash audit: {error}"))?;
        if inserted != 1 {
            return Err("Assigned cash audit was not written".into());
        }
        Ok(())
    }

    /// Returns None after a recoverable failure, with the released move still in place.
    pub(crate) fn try_with_tail<T>(
        &self,
        conn: &Connection,
        actor: Option<&str>,
        now: &str,
        tail: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        if let Err(error) = conn.execute_batch(SAVEPOINT) {
            if conn.is_autocommit() {
                return Err(format!("Driver assignment transaction lost: {error}"));
            }
            tracing::warn!(error = %error, "PAYMENT_NOT_SAVED: could not start optional platform cash receipt");
            return Ok(None);
        }
        let attempt = self
            .record(conn, actor, now)
            .and_then(|()| tail())
            .and_then(|result| {
                conn.execute_batch(RELEASE)
                    .map_err(|error| format!("release assigned cash: {error}"))?;
                Ok(result)
            });
        match attempt {
            Ok(result) => Ok(Some(result)),
            Err(error) => {
                conn.execute_batch(ROLLBACK)
                    .map_err(|rollback| format!("Could not roll back assigned cash: {rollback}"))?;
                tracing::warn!(%error, "PAYMENT_NOT_SAVED: optional platform cash receipt rolled back");
                Ok(None)
            }
        }
    }
}
