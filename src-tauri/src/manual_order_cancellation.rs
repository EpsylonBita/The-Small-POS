//! Record an operator-confirmed manual return and cancel in one durable write.
//! This never calls a provider or makes a charge. Provider originals cannot enter.
use crate::{
    auth, commands::orders, db, gift_financial_opening::OpeningScope, money::Cents, payments,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Emitter;

const ACTION: &str = "manual_order_cancel_v1";
const PROVIDER_REQUIRED: &str = "ORIGINAL_PROVIDER_RETURN_REQUIRED";
const SETUP_UNKNOWN: &str = "PAYMENT_CONNECTION_STATUS_UNAVAILABLE";

fn actor(auth: &auth::AuthState) -> Result<String, String> {
    if !["delete_order", "pos.orders.cancel", "void_orders"]
        .iter()
        .any(|permission| auth::has_permission(auth, Some(permission)))
    {
        return Err("ORDER_CANCELLATION_PERMISSION_REQUIRED".into());
    }
    auth::get_session_json(auth)["staffId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "AUTHENTICATION_REQUIRED".into())
}

fn no_connected_bank(conn: &Connection, scope: &OpeningScope) -> Result<(), String> {
    let connected: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM ecr_devices WHERE device_type='payment_terminal' AND enabled=1 AND status='connected')", [], |r| r.get(0)).map_err(|e|e.to_string())?;
    if connected {
        return Err(PROVIDER_REQUIRED.into());
    }
    let raw = db::get_setting(conn, "local", "admin_api_get::/api/pos/integrations")
        .ok_or(SETUP_UNKNOWN)?;
    let envelope: Value = serde_json::from_str(&raw).map_err(|_| SETUP_UNKNOWN)?;
    let data = envelope.get("data").unwrap_or(&envelope);
    let items = data["integrations"].as_array().ok_or(SETUP_UNKNOWN)?;
    if data["success"] != true {
        return Err(SETUP_UNKNOWN.into());
    }
    // Older deployed servers echo the branch on every row instead of the envelope.
    if let Some(branch) = data["branch_id"].as_str() {
        if branch != scope.branch_id {
            return Err(SETUP_UNKNOWN.into());
        }
    } else if items.is_empty()
        || items
            .iter()
            .any(|row| row["branch_id"].as_str() != Some(scope.branch_id.as_str()))
    {
        return Err(SETUP_UNKNOWN.into());
    }
    for row in items {
        if row["branch_id"]
            .as_str()
            .is_some_and(|branch| branch != scope.branch_id)
        {
            return Err(SETUP_UNKNOWN.into());
        }
        let provider = row["provider"]
            .as_str()
            .or_else(|| row["plugin_id"].as_str())
            .unwrap_or("");
        let payment = row["category"]
            .as_str()
            .is_some_and(|v| matches!(v, "payment" | "payments"))
            || matches!(
                provider,
                "stripe" | "viva" | "twint" | "worldline_terminals"
            );
        if !payment || row["is_purchased"] == false || row["is_enabled"] == false {
            continue;
        }
        if row["is_purchased"] != true || row["is_enabled"] != true {
            return Err(SETUP_UNKNOWN.into());
        }
        if matches!(provider, "twint" | "worldline_terminals") {
            match row["payment_setup"]["transport_ready"].as_bool() {
                Some(false) => continue,
                Some(true) => return Err(PROVIDER_REQUIRED.into()),
                None => return Err(SETUP_UNKNOWN.into()),
            }
        }
        match row["status"].as_str() {
            Some("connected" | "active" | "verified") => return Err(PROVIDER_REQUIRED.into()),
            Some(
                "inactive"
                | "disconnected"
                | "not_configured"
                | "pending"
                | "pending_verification"
                | "error",
            ) => {}
            _ => return Err(SETUP_UNKNOWN.into()),
        }
    }
    Ok(())
}

pub(crate) fn original_is_manual(
    method: &str,
    origin: &str,
    device: &str,
    reference: &str,
) -> bool {
    // Both timestamp prefixes are emitted by shipped manual receipt entry.
    let local_reference = reference.is_empty()
        || reference
            .strip_prefix("CASH-")
            .or_else(|| reference.strip_prefix("CARD-"))
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()));
    matches!(method, "cash" | "card")
        && matches!(origin, "manual" | "manual_card" | "manual_recovery")
        && device.is_empty()
        && local_reference
}

/// Require both the native original columns and the same contradictory-metadata
/// checks used by canonical table cancellation. Display names are never evidence.
pub(crate) fn original_is_manual_with_metadata(
    method: &str,
    origin: &str,
    device: &str,
    reference: &str,
    raw_metadata: Option<&str>,
) -> bool {
    if !original_is_manual(method, origin, device, reference) {
        return false;
    }
    let mut metadata = match raw_metadata.map(serde_json::from_str::<Value>).transpose() {
        Ok(None | Some(Value::Null)) => json!({}),
        Ok(Some(value)) if value.is_object() => value,
        _ => return false,
    };
    // Native origin is independently persisted. Supply it only when this alias
    // is absent/empty; the canonical classifier still checks every other alias.
    if metadata["payment_origin"].is_null() || metadata["payment_origin"].as_str() == Some("") {
        metadata["payment_origin"] = json!(origin);
    }
    crate::table_manual_cancellation::canonical_manual_receipt(&json!({
        "payment_method":method,"external_transaction_id":reference,"metadata":metadata
    }))
}

fn prepare(conn: &Connection, raw_id: &str) -> Result<Value, String> {
    let id = orders::validate_manual_cancel_target(conn, raw_id)?;
    prepare_validated(conn, &id)
}

pub(crate) fn prepare_validated(conn: &Connection, id: &str) -> Result<Value, String> {
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let branch: String = conn
        .query_row(
            "SELECT COALESCE(branch_id,'') FROM orders WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if branch != scope.branch_id {
        return Err("ORDER_BRANCH_MISMATCH".into());
    }
    let cash_returns = crate::staff_cash_returns::plan(conn, &id)?;
    let refusal = orders::cancel_refusal_code(conn, &id)?;
    if refusal.is_some_and(|code| {
        code != orders::ORDER_HAS_PAYMENTS && code != "STAFF_CASH_RETURN_REQUIRED"
    }) {
        return Err(refusal.unwrap().into());
    }
    let snapshot = payments::load_order_payment_balance_snapshot(conn, &id)?;
    let generation = payments::settlement_generation_token(
        &Sha256::digest(format!(
            "{}:{}",
            payments::settlement_generation_token(&snapshot.ledger_generation),
            serde_json::to_string(&cash_returns).map_err(|e| e.to_string())?
        ))
        .into(),
    );
    if refusal.is_none() || refusal == Some("STAFF_CASH_RETURN_REQUIRED") {
        return Ok(
            json!({"success":true,"orderId":id,"requiresReturn":false,"requiresHandback":!cash_returns.is_empty(),"amountCents":0,"payments":[],"currency":cash_returns.first().map(|row|row["currency"].clone()),"cashReturns":cash_returns,"generation":generation}),
        );
    }
    let (claimed_paid, total_cents): (bool,i64) = conn.query_row(
        "SELECT LOWER(TRIM(COALESCE(payment_status,''))) IN ('paid','completed'),COALESCE(total_amount_cents,CAST(ROUND(total_amount*100) AS INTEGER),0) FROM orders WHERE id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))
    ).map_err(|e|e.to_string())?;
    if claimed_paid {
        // Returning the rows we do have must not hide missing original money.
        // Prior refunded originals still prove received principal; voids and
        // placeholders do not. Tips are not principal coverage.
        let principal: i64 = conn.query_row(&format!("SELECT COALESCE(SUM(MAX(COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER),0)-COALESCE(tip_amount_cents,CAST(ROUND(tip_amount*100) AS INTEGER),0),0)),0) FROM order_payments p WHERE order_id=?1 AND status IN ('completed','refunded') AND NOT {}",payments::placeholder_payment_sql("p")),[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if principal < total_cents {
            return Err(orders::ORDER_PAYMENT_NOT_RECORDED.into());
        }
    }
    no_connected_bank(conn, &scope)?;
    let provider_attempt: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM ecr_transactions WHERE order_id=?1 AND LOWER(transaction_type)='sale' )",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if provider_attempt {
        return Err(PROVIDER_REQUIRED.into());
    }
    let mut stmt = conn.prepare("SELECT id,LOWER(TRIM(method)),LOWER(TRIM(COALESCE(payment_origin,''))),TRIM(COALESCE(terminal_device_id,'')),TRIM(COALESCE(transaction_ref,'')),currency,
        COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER),0) - COALESCE((SELECT SUM(COALESCE(a.amount_cents,CAST(ROUND(a.amount*100) AS INTEGER))) FROM payment_adjustments a WHERE a.payment_id=p.id AND a.adjustment_type='refund'),0)
        ,metadata
        FROM order_payments p WHERE order_id=?1 AND status='completed' ORDER BY id").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([&id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut portions = Vec::new();
    let mut currency: Option<String> = None;
    let mut cents = 0_i64;
    for (payment_id, method, origin, device, reference, unit, remaining, metadata) in rows {
        if payments::payment_is_platform_settlement(conn, &payment_id)? {
            continue;
        }
        let canonical: bool = conn.query_row("SELECT sync_state='applied' AND sync_status='synced' AND NULLIF(TRIM(remote_payment_id),'') IS NOT NULL FROM order_payments WHERE id=?1",[&payment_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !canonical {
            return Err("PAYMENT_SYNC_REQUIRED".into());
        }
        if payments::payment_is_placeholder(conn, &payment_id)?
            || !original_is_manual_with_metadata(
                &method,
                &origin,
                &device,
                &reference,
                metadata.as_deref(),
            )
        {
            return Err(PROVIDER_REQUIRED.into());
        }
        let unit = unit
            .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase()))
            .ok_or("PAYMENT_CURRENCY_UNAVAILABLE")?;
        if currency.as_ref().is_some_and(|known| known != &unit) {
            return Err("PAYMENT_CURRENCY_MISMATCH".into());
        }
        currency = Some(unit);
        if remaining < 0 {
            return Err("PAYMENT_BALANCE_INVALID".into());
        }
        if remaining > 0 {
            cents += remaining;
            portions.push(json!({"paymentId":payment_id,"amountCents":remaining}));
        }
    }
    let order_currency: Option<String> = conn
        .query_row("SELECT currency FROM orders WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    if order_currency
        .as_ref()
        .is_some_and(|known| Some(known) != currency.as_ref())
    {
        return Err("PAYMENT_CURRENCY_MISMATCH".into());
    }
    if cents <= 0 || cents != payments::load_store_taken_net_paid_cents(conn, &id)? {
        return Err("PAYMENT_BALANCE_INVALID".into());
    }
    Ok(
        json!({"success":true,"orderId":id,"requiresReturn":true,"generation":generation,"amountCents":cents,"currency":currency,"payments":portions,"requiresHandback":!cash_returns.is_empty(),"cashReturns":cash_returns}),
    )
}

fn commit(conn: &Connection, input: &Value, actor_id: &str) -> Result<Value, String> {
    let order_id = input["orderId"].as_str().ok_or("Missing orderId")?;
    let reason = input["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 2000)
        .ok_or("CANCELLATION_REASON_REQUIRED")?;
    let key = input["requestId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .ok_or("Missing requestId")?;
    let channel = input["returnChannel"]
        .as_str()
        .ok_or("RETURN_CHANNEL_REQUIRED")?;
    if !matches!(channel, "cash_drawer" | "bank") {
        return Err("RETURN_CHANNEL_REQUIRED".into());
    }
    let audit_id = format!("manual-cancel:{key}");
    db::with_full_sync(conn, |conn| {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
            let prior: Option<String> = conn
                .query_row(
                    "SELECT payload_json FROM recovery_action_log WHERE id=?1 AND action_id=?2",
                    params![audit_id, ACTION],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(raw) = prior {
                let saved: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                if saved["orderId"] != order_id
                    || saved["reason"] != reason
                    || saved["returnChannel"] != channel
                    || saved["organizationId"] != scope.organization_id
                    || saved["branchId"] != scope.branch_id
                    || saved["terminalId"] != scope.terminal_id
                {
                    return Err("CANCELLATION_REQUEST_CONFLICT".into());
                }
                let (status, branch): (String, String) = conn
                    .query_row(
                        "SELECT status,COALESCE(branch_id,'') FROM orders WHERE id=?1",
                        [order_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(|e| e.to_string())?;
                if status != "cancelled" || branch != scope.branch_id {
                    return Err("CANCELLATION_REQUEST_CONFLICT".into());
                }
                return Ok(json!({"success":true,"orderId":order_id,"duplicate":true}));
            }
            let plan = prepare(conn, order_id)?;
            if (plan["requiresReturn"] != true && plan["requiresHandback"] != true)
                || plan["generation"] != input["generation"]
            {
                return Err("CANCELLATION_PAYMENT_CHANGED".into());
            }
            let (shift_id, cashier_id) = crate::sync::require_active_cashier_for_order_create(
                conn,
                &scope.branch_id,
                &scope.terminal_id,
            )?;
            let currency = crate::shifts::require_operating_currency(conn, &scope.branch_id)?;
            if plan["currency"] != currency {
                return Err("PAYMENT_CURRENCY_MISMATCH".into());
            }
            let (recorded_shift_currency, cashier_terminal): (Option<String>, String) = conn
                .query_row(
                    "SELECT currency,terminal_id FROM staff_shifts WHERE id=?1",
                    [&shift_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| e.to_string())?;
            // A return has an immutable original payment currency. A pre-upgrade
            // opening may remain unknown; this is not adoption or a new sale.
            if recorded_shift_currency
                .as_ref()
                .is_some_and(|known| known != &currency)
            {
                return Err("PAYMENT_CURRENCY_MISMATCH".into());
            }
            let mut receiving_drawer = None;
            if channel == "cash_drawer" || plan["requiresHandback"] == true {
                let mut drawers=conn.prepare("SELECT cashier_id,branch_id,terminal_id,currency,closed_at,id FROM cash_drawer_sessions WHERE staff_shift_id=?1").map_err(|e|e.to_string())?;
                let drawers = drawers
                    .query_map([&shift_id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, Option<String>>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, String>(5)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                if drawers.len() != 1 {
                    return Err("CASHIER_DRAWER_UNAVAILABLE".into());
                }
                let (owner, branch, terminal, unit, closed, drawer) = &drawers[0];
                if owner != &cashier_id
                    || branch != &scope.branch_id
                    || terminal != &cashier_terminal
                    || closed.is_some()
                {
                    return Err("CASHIER_DRAWER_UNAVAILABLE".into());
                }
                if unit.as_ref().is_some_and(|known| known != &currency)
                    || (plan["requiresHandback"] == true
                        && (unit.as_ref() != Some(&currency)
                            || recorded_shift_currency.as_ref() != Some(&currency)))
                {
                    return Err("PAYMENT_CURRENCY_MISMATCH".into());
                }
                receiving_drawer = Some(drawer.clone());
            }
            let now = chrono::Utc::now().to_rfc3339();
            let mut receipts = Vec::new();
            for source in plan["cashReturns"]
                .as_array()
                .ok_or("STAFF_CASH_CUSTODY_INVALID")?
            {
                let receipt = crate::staff_cash_returns::record(
                    conn,
                    &scope,
                    order_id,
                    source,
                    &shift_id,
                    receiving_drawer
                        .as_deref()
                        .ok_or("CASHIER_DRAWER_UNAVAILABLE")?,
                    key,
                    actor_id,
                    reason,
                    &now,
                )?;
                receipts.push((source.clone(), receipt));
            }
            let mut adjustments = std::collections::HashMap::new();
            for portion in plan["payments"]
                .as_array()
                .ok_or("PAYMENT_BALANCE_INVALID")?
            {
                let payment_id = portion["paymentId"]
                    .as_str()
                    .ok_or("PAYMENT_BALANCE_INVALID")?;
                let refund = crate::refunds::refund_manual_cancellation_in_connection(
                    conn,
                    &json!({
                        "paymentId":payment_id,"amount":Cents::new(portion["amountCents"].as_i64().ok_or("PAYMENT_BALANCE_INVALID")?).to_f64_dp2(),
                        "reason":reason,"staffId":actor_id,"staffShiftId":shift_id,
                        "idempotencyKey":format!("manual-cancel:{key}:{payment_id}"),
                        "refundMethod":if channel=="cash_drawer" {"cash"} else {"card"},"cashHandler":"cashier_drawer"
                    }),
                )?;
                adjustments.insert(
                    payment_id.to_string(),
                    refund["adjustmentId"]
                        .as_str()
                        .ok_or("REFUND_NOT_RECORDED")?
                        .to_string(),
                );
            }
            for (source, receipt) in &receipts {
                crate::staff_cash_returns::enqueue(
                    conn,
                    source,
                    receipt,
                    actor_id,
                    reason,
                    adjustments
                        .get(source["paymentId"].as_str().unwrap_or_default())
                        .map(String::as_str),
                )?;
            }
            if !receipts.is_empty() {
                crate::shifts::replace_unfinished_shift_sync_rows_with_current_snapshot(
                    conn, &shift_id, &now,
                )?;
            }
            match orders::apply_order_status_in_connection(
                conn,
                order_id,
                "cancelled",
                None,
                Some(reason),
                &now,
            )? {
                orders::LocalStatusChange::Applied { .. } => {}
                orders::LocalStatusChange::Blocked(_) => {
                    return Err("ORDER_CANCELLATION_BLOCKED".into())
                }
            }
            let evidence = json!({"organizationId":scope.organization_id,"branchId":scope.branch_id,"terminalId":scope.terminal_id,"orderId":order_id,"reason":reason,"returnChannel":channel,"plan":plan,"actorStaffId":actor_id,"staffShiftId":shift_id,"charged":false,"operatorConfirmedReturned":true});
            conn.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,entity_type,entity_id,order_id,shift_id,success,actor_staff_id,payload_json,created_at) VALUES(?1,?2,'MANUAL_RETURN_AND_CANCEL','order',?3,?3,?4,1,?5,?6,?7)",params![audit_id,ACTION,order_id,shift_id,actor_id,evidence.to_string(),now]).map_err(|e|e.to_string())?;
            Ok(
                json!({"success":true,"orderId":order_id,"amountCents":plan["amountCents"],"currency":currency}),
            )
        })();
        match result {
            Ok(value) => {
                conn.execute_batch("COMMIT").map_err(|e| {
                    let _ = conn.execute_batch("ROLLBACK");
                    e.to_string()
                })?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

#[tauri::command]
pub async fn order_prepare_manual_cancel(
    arg0: Value,
    db: tauri::State<'_, db::DbState>,
    auth: tauri::State<'_, auth::AuthState>,
) -> Result<Value, String> {
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    actor(&auth)?;
    let (mut plan, table_session, table_candidate) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let raw = arg0["orderId"].as_str().ok_or("Missing orderId")?;
        if let Some(pending) = crate::table_manual_cancellation::pending_plan(&conn, raw)? {
            return Ok(pending);
        }
        let table = crate::table_manual_cancellation::resolve_session(
            &conn,
            raw,
            arg0["tableSessionId"].as_str(),
        )?;
        let candidate = crate::table_manual_cancellation::is_table_candidate(&conn, raw)?;
        let id: String = conn
            .query_row(
                "SELECT id FROM orders WHERE id=?1 OR supabase_id=?1",
                [raw],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let plan = if candidate {
            prepare_validated(&conn, &id)?
        } else {
            prepare(&conn, &id)?
        };
        (plan, table, candidate)
    };
    if table_candidate {
        let remote = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            crate::table_manual_cancellation::canonical_order(
                &conn,
                plan["orderId"].as_str().ok_or("Missing order")?,
            )?
        };
        let snapshot = crate::admin_fetch_detailed(
            Some(&db),
            &format!("/api/pos/staff-cash-returns/sync?order_id={remote}"),
            "GET",
            None,
        )
        .await
        .map_err(|_| "TABLE_MANUAL_CANCELLATION_UNAVAILABLE")?;
        let session = crate::table_manual_cancellation::snapshot_session(
            &snapshot,
            table_session.as_deref(),
        )?;
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        crate::table_manual_cancellation::validate_snapshot(&conn, &plan, &session, &snapshot)?;
        orders::validate_table_manual_cancel_target(
            &conn,
            plan["orderId"].as_str().unwrap(),
            &session,
        )?;
        plan["tableSessionId"] = json!(session);
        plan["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        if plan["requiresReturn"] == true || plan["requiresHandback"] == true {
            crate::table_manual_cancellation::receiver(
                &conn,
                plan["currency"]
                    .as_str()
                    .ok_or("PAYMENT_CURRENCY_UNAVAILABLE")?,
            )?;
        }
    }
    if plan["requiresHandback"] == true {
        let capability =
            crate::admin_fetch_detailed(Some(&db), "/api/pos/staff-cash-returns/sync", "GET", None)
                .await
                .map_err(|_| "STAFF_CASH_RETURN_UNAVAILABLE")?;
        if capability
            .pointer("/data/staff_cash_return_version")
            .or_else(|| capability.get("staff_cash_return_version"))
            .and_then(Value::as_i64)
            != Some(1)
        {
            return Err("STAFF_CASH_RETURN_UNAVAILABLE".into());
        }
    }
    Ok(plan)
}
#[tauri::command]
pub fn order_cancel_manual_refund(
    arg0: Value,
    db: tauri::State<'_, db::DbState>,
    auth: tauri::State<'_, auth::AuthState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    let actor_id = actor(&auth)?;
    let result = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        commit(&conn, &arg0, &actor_id)?
    };
    let event = json!({"orderId":result["orderId"],"status":"cancelled","cancellationReason":arg0["reason"]});
    let _ = app.emit("order_status_updated", event.clone());
    let _ = app.emit("order_realtime_update", event);
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    #[test]
    fn shipped_manual_card_reference_preserves_provenance() {
        for origin in ["manual", "manual_card", "manual_recovery"] {
            assert!(original_is_manual("card", origin, "", "CARD-1791226924826"));
        }
        for origin in [
            "",
            "payment_terminal",
            "stripe",
            "payment_terminal_unconfirmed",
        ] {
            assert!(!original_is_manual(
                "card",
                origin,
                "",
                "CARD-1791226924826"
            ));
        }
        for reference in ["CARD-", "CARD-provider", "CARD-123/charge", "pi_123"] {
            assert!(!original_is_manual("card", "manual", "", reference));
        }
        assert!(!original_is_manual(
            "card",
            "manual",
            "device",
            "CARD-1791226924826"
        ));
        let conn = setup();
        conn.execute(
            "UPDATE order_payments SET transaction_ref='CARD-1791226924826'",
            [],
        )
        .unwrap();
        assert_eq!(prepare(&conn, "order").unwrap()["amountCents"], 600);
        commit(&conn, &request(&conn, "bank"), "operator").unwrap();
        assert_eq!(count(&conn, "payment_adjustments"), 1);
    }

    pub(crate) fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        for (category, key, value) in [
            ("terminal", "organization_id", "org"),
            ("terminal", "branch_id", "branch"),
            ("terminal", "terminal_id", "terminal"),
            ("restaurant", "currency", "EUR"),
            ("restaurant", "store_currency_branch_id", "branch"),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
        ] {
            db::set_setting(&conn, category, key, value).unwrap();
        }
        db::set_setting(&conn,"local","admin_api_get::/api/pos/integrations",&json!({"path":"/api/pos/integrations","cachedAt":"2026-10-05T13:00:00Z","data":{"success":true,"integrations":[{"provider":"stripe","category":"payment","branch_id":"branch","is_purchased":false,"is_enabled":false,"status":"inactive"}]}}).to_string()).unwrap();
        conn.execute_batch("INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,status,check_in_time,currency,created_at,updated_at)
          VALUES('shift','cashier','branch','terminal','cashier','active','2026-10-05T10:00:00Z',NULL,'now','now');
          INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,currency,opening_amount,opening_amount_cents,total_card_sales,total_card_sales_cents,total_refunds,total_refunds_cents,opened_at,created_at,updated_at)
          VALUES('drawer','shift','cashier','branch','terminal',NULL,20,2000,6,600,0,0,'2026-10-05T10:00:00Z','now','now');
          INSERT INTO orders(id,items,total_amount,total_amount_cents,status,order_type,payment_status,staff_shift_id,branch_id,terminal_id,created_at,updated_at)
          VALUES('order','[]',6,600,'pending','pickup','paid','shift','branch','terminal','now','now');
          INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,staff_shift_id,payment_origin,transaction_ref,sync_state,sync_status,remote_payment_id,created_at,updated_at)
          VALUES('payment','order','card',6,600,'EUR','completed','shift','manual','CASH-1791199138332','applied','synced','8238ddd9-5e52-47b6-ac6d-3e398b14ae08','now','now');").unwrap();
        conn
    }
    fn request(conn: &Connection, channel: &str) -> Value {
        let plan = prepare(conn, "order").unwrap();
        json!({"orderId":"order","reason":"Customer cancelled","returnChannel":channel,"requestId":"request-1","generation":plan["generation"]})
    }
    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
    fn history_split_manual_order(conn: &Connection, status: &str) {
        conn.execute("UPDATE orders SET status=?1,total_amount=10.5,total_amount_cents=1050 WHERE id='order'",[status]).unwrap();
        conn.execute_batch("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,staff_shift_id,payment_origin,transaction_ref,sync_state,sync_status,remote_payment_id,created_at,updated_at)
          VALUES('cash-payment','order','cash',4.5,450,'EUR','completed','shift','manual',NULL,'applied','synced','62cd518c-e1dd-46a6-a130-831c6a60faf5','now','now');
          UPDATE cash_drawer_sessions SET total_cash_sales=4.5,total_cash_sales_cents=450;").unwrap();
    }

    pub(crate) fn staff_custody_fixture(conn: &Connection, role: &str) {
        history_split_manual_order(conn, "delivered");
        conn.execute_batch("UPDATE staff_shifts SET currency='EUR';UPDATE cash_drawer_sessions SET currency='EUR';UPDATE orders SET supabase_id='727dfed5-af5b-4491-a258-41d8659a5ce4',organization_id='org';").unwrap();
        conn.execute("INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,status,check_in_time,currency,created_at,updated_at) VALUES('worker-shift','worker','branch','terminal',?1,'active','2026-10-05T10:00:00Z','EUR','now','now')",[role]).unwrap();
        if role == "driver" {
            conn.execute_batch("UPDATE order_payments SET staff_id='worker',staff_shift_id='worker-shift' WHERE id='cash-payment';UPDATE orders SET order_type='delivery',driver_id='worker',staff_shift_id='worker-shift';
            INSERT INTO driver_earnings(id,driver_id,staff_shift_id,order_id,branch_id,delivery_fee,tip_amount,total_earning,payment_method,cash_collected,cash_collected_cents,cash_to_return,cash_to_return_cents,card_amount,card_amount_cents,settled,is_transferred,currency,created_at,updated_at) VALUES('earning','worker','worker-shift','order','branch',1,0.5,1.5,'mixed',4.5,450,4.5,450,6,600,0,0,'EUR','now','now');").unwrap();
        } else {
            conn.execute_batch("UPDATE order_payments SET staff_id='worker',staff_shift_id='worker-shift' WHERE id='cash-payment';UPDATE orders SET staff_shift_id='worker-shift';").unwrap();
        }
    }

    #[test]
    fn cancellation_pr_guard_cashier_receipt_outranks_later_driver_earning() {
        for channel in ["cash_drawer", "bank"] {
            let conn = setup();
            staff_custody_fixture(&conn, "driver");
            conn.execute_batch("UPDATE order_payments SET staff_id='cashier',staff_shift_id='shift',metadata='{\"collected_by\":\"cashier_drawer\"}' WHERE id='cash-payment';
                UPDATE driver_earnings SET cash_collected=0,cash_collected_cents=0,cash_to_return=0,cash_to_return_cents=0;").unwrap();
            let plan = prepare(&conn, "order").unwrap();
            assert_eq!(plan["requiresHandback"], false, "{plan}");
            assert_eq!(plan["cashReturns"], json!([]));
            assert_eq!(
                crate::order_ownership::courier_order_tender_cents(&conn, "order")
                    .unwrap()
                    .cash_cents,
                0
            );
            let input = request(&conn, channel);
            commit(&conn, &input, "operator").unwrap();
            assert_eq!(
                commit(&conn, &input, "operator").unwrap()["duplicate"],
                true
            );
            assert_eq!(count(&conn, "staff_order_cash_returns"), 0);
            let (intake,refunds):(i64,i64)=conn.query_row("SELECT COALESCE(driver_cash_returned_cents,0),total_refunds_cents FROM cash_drawer_sessions",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(intake, 0);
            assert_eq!(refunds, if channel == "cash_drawer" { 1050 } else { 0 });
            assert_eq!(
                crate::order_ownership::courier_order_tender_cents(&conn, "order")
                    .unwrap()
                    .cash_cents,
                0
            );
        }
    }

    #[test]
    fn cancellation_pr_guard_original_collector_and_legacy_custody_are_distinct() {
        for variant in [
            "driver",
            "server",
            "legacy",
            "legacy_zero",
            "foreign",
            "partial",
            "metadata_conflict",
            "alias_conflict",
            "handler_conflict",
            "closed",
            "settled",
        ] {
            let conn = setup();
            staff_custody_fixture(
                &conn,
                if variant == "server" {
                    "server"
                } else {
                    "driver"
                },
            );
            match variant {
                "legacy" | "legacy_zero" => {
                    conn.execute("UPDATE order_payments SET staff_id=NULL,staff_shift_id=NULL WHERE id='cash-payment'",[]).unwrap();
                }
                "foreign" => {
                    conn.execute(
                        "UPDATE staff_shifts SET branch_id='foreign' WHERE id='worker-shift'",
                        [],
                    )
                    .unwrap();
                }
                "partial" => {
                    conn.execute(
                        "UPDATE order_payments SET staff_shift_id=NULL WHERE id='cash-payment'",
                        [],
                    )
                    .unwrap();
                }
                "metadata_conflict" => {
                    conn.execute("UPDATE order_payments SET metadata='{\"staff_shift_id\":\"shift\",\"collected_by\":\"cashier_drawer\"}' WHERE id='cash-payment'",[]).unwrap();
                }
                "alias_conflict" => {
                    conn.execute("UPDATE order_payments SET metadata='{\"staff_shift_id\":\"worker-shift\",\"staffShiftId\":\"shift\"}' WHERE id='cash-payment'",[]).unwrap();
                }
                "handler_conflict" => {
                    conn.execute("UPDATE order_payments SET metadata='{\"collected_by\":\"cashier_drawer\"}' WHERE id='cash-payment'",[]).unwrap();
                }
                "closed" => {
                    conn.execute("UPDATE staff_shifts SET status='closed',check_out_time='2026-10-05T20:00:00Z' WHERE id='worker-shift'",[]).unwrap();
                }
                "settled" => {
                    conn.execute("UPDATE driver_earnings SET settled=1", [])
                        .unwrap();
                }
                _ => {}
            }
            if variant == "legacy_zero" {
                conn.execute(
                    "UPDATE driver_earnings SET cash_collected=0,cash_collected_cents=0",
                    [],
                )
                .unwrap();
            }
            let result = crate::staff_cash_returns::plan(&conn, "order");
            if matches!(
                variant,
                "legacy_zero"
                    | "foreign"
                    | "partial"
                    | "metadata_conflict"
                    | "alias_conflict"
                    | "handler_conflict"
            ) {
                assert_eq!(
                    result.unwrap_err(),
                    "STAFF_CASH_CUSTODY_AMBIGUOUS",
                    "{variant}"
                );
            } else {
                let result = result.unwrap();
                if matches!(variant, "closed" | "settled") {
                    assert!(result.is_empty(), "{variant}");
                } else {
                    assert_eq!(result[0]["amount_cents"], 450, "{variant}");
                }
            }
            assert_eq!(count(&conn, "staff_order_cash_returns"), 0);
        }
    }

    #[test]
    fn cancellation_pr_guard_provider_metadata_refuses_before_return() {
        for metadata in [
            json!({"provider":"stripe"}),
            json!({"terminalProcessed":"true"}),
            json!({"terminalDeviceId":"provider-device"}),
            json!({"paymentOrigin":"terminal"}),
            json!({"terminal_reference":"provider-proof"}),
        ] {
            let conn = setup();
            conn.execute(
                "UPDATE order_payments SET transaction_ref='CARD-1791226924826',metadata=?1",
                [metadata.to_string()],
            )
            .unwrap();
            assert_eq!(
                prepare(&conn, "order").unwrap_err(),
                PROVIDER_REQUIRED,
                "{metadata}"
            );
            assert_eq!(count(&conn, "payment_adjustments"), 0);
            assert_eq!(count(&conn, "recovery_action_log"), 0);
        }
    }

    #[test]
    fn staff_cancel_partial_driver_return_and_ambiguous_cross_tender_are_distinct() {
        let conn = setup();
        staff_custody_fixture(&conn, "driver");
        crate::refunds::refund_payment_in_connection(&conn,&json!({"paymentId":"cash-payment","amount":1,"reason":"Driver returned one euro","staffId":"worker","staffShiftId":"worker-shift","refundMethod":"cash","cashHandler":"driver_shift","idempotencyKey":"prior-driver"})).unwrap();
        let plan = prepare(&conn, "order").unwrap();
        assert_eq!(plan["cashReturns"][0]["amount_cents"], 350);
        commit(&conn, &request(&conn, "bank"), "cashier").unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT driver_cash_returned_cents FROM cash_drawer_sessions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            350
        );
        let other = setup();
        staff_custody_fixture(&other, "driver");
        crate::refunds::refund_payment_in_connection(&other,&json!({"paymentId":"payment","amount":1,"reason":"Cash against original card","staffId":"worker","staffShiftId":"worker-shift","refundMethod":"cash","cashHandler":"driver_shift","idempotencyKey":"ambiguous-driver"})).unwrap();
        assert_eq!(
            prepare(&other, "order").unwrap_err(),
            "STAFF_CASH_CUSTODY_AMBIGUOUS"
        );
        other
            .execute("UPDATE payment_adjustments SET refund_method=NULL", [])
            .unwrap();
        assert_eq!(
            prepare(&other, "order").unwrap_err(),
            "STAFF_CASH_CUSTODY_AMBIGUOUS"
        );
    }

    #[test]
    fn staff_cancel_legacy_null_handler_counts_only_with_driver_custody_proof() {
        for role in ["driver", "server"] {
            let conn = setup();
            staff_custody_fixture(&conn, role);
            conn.execute("INSERT INTO payment_adjustments(id,payment_id,order_id,adjustment_type,amount,amount_cents,reason,refund_method,cash_handler,sync_state,created_at,updated_at) VALUES('legacy','cash-payment','order','refund',1,100,'Legacy return','cash',NULL,'applied','now','now')",[]).unwrap();
            if role == "server" {
                assert_eq!(
                    prepare(&conn, "order").unwrap_err(),
                    "STAFF_CASH_CUSTODY_AMBIGUOUS"
                );
                assert_eq!(
                    crate::staff_cash_returns::waiter_cash(&conn, "worker-shift", None).unwrap(),
                    450
                );
            } else {
                assert_eq!(
                    prepare(&conn, "order").unwrap()["cashReturns"][0]["amount_cents"],
                    350
                );
            }
        }
    }

    #[test]
    fn staff_cancel_transport_retains_exact_receipts_and_acknowledges_cash_intake() {
        for standalone in [false, true] {
            let conn = setup();
            staff_custody_fixture(&conn, "driver");
            if standalone {
                for (payment, amount) in [("payment", 6.0), ("cash-payment", 4.5)] {
                    crate::refunds::refund_manual_cancellation_in_connection(&conn,&json!({"paymentId":payment,"amount":amount,"reason":"Already returned","staffId":"cashier","staffShiftId":"shift","refundMethod":"card","idempotencyKey":format!("before:{payment}")})).unwrap();
                }
            }
            commit(&conn, &request(&conn, "bank"), "admin-user").unwrap();
            let (id, adjustment): (String, Option<String>) = conn
                .query_row(
                    "SELECT id,adjustment_id FROM staff_order_cash_returns",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            let body = crate::sync_queue::apply_ack_for_test(
                &conn,
                if standalone {
                    "staff_order_cash_returns"
                } else {
                    "payment_adjustments"
                },
                adjustment.as_deref().unwrap_or(&id),
                &json!({"success":true,"id":id,"adjustment_id":adjustment}),
            )
            .unwrap();
            let receipt = if standalone {
                &body
            } else {
                &body["staff_cash_return"]
            };
            assert_eq!(receipt["id"], id);
            assert_eq!(receipt["amount_cents"], 450);
            assert!(receipt["idempotency_key"]
                .as_str()
                .unwrap()
                .contains("cash-return:cash-payment"));
            if standalone {
                assert!(body["actor_staff_id"].is_null());
            } else {
                assert_eq!(
                    body["idempotency_key"],
                    "manual-cancel:request-1:cash-payment"
                );
            }
            assert_eq!(
                conn.query_row(
                    "SELECT sync_status FROM staff_order_cash_returns",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "synced"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT driver_cash_returned_cents FROM cash_drawer_sessions",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                450
            );
        }
    }
    #[test]
    fn staff_cancel_cash_handback_and_customer_return_are_distinct_atomic_movements() {
        for role in ["driver", "server"] {
            for channel in ["cash_drawer", "bank"] {
                let conn = setup();
                staff_custody_fixture(&conn, role);
                let input = request(&conn, channel);
                commit(&conn, &input, "cashier").unwrap();
                let (intake,refund):(i64,i64)=conn.query_row("SELECT driver_cash_returned_cents,total_refunds_cents FROM cash_drawer_sessions WHERE id='drawer'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
                assert_eq!(intake, 450);
                assert_eq!(refund, if channel == "cash_drawer" { 1050 } else { 0 });
                assert_eq!(count(&conn, "staff_order_cash_returns"), 1);
                assert_eq!(count(&conn, "payment_adjustments"), 2);
                assert!(crate::staff_cash_returns::plan(&conn, "order")
                    .unwrap()
                    .is_empty());
                if role == "driver" {
                    assert_eq!(
                        conn.query_row(
                            "SELECT cash_collected_cents FROM driver_earnings WHERE id='earning'",
                            [],
                            |r| r.get::<_, i64>(0)
                        )
                        .unwrap(),
                        450
                    );
                } else {
                    assert_eq!(
                        crate::staff_cash_returns::waiter_cash(&conn, "worker-shift", None)
                            .unwrap(),
                        0
                    );
                }
                let original: String = conn
                    .query_row(
                        "SELECT payload_json FROM staff_order_cash_returns",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(commit(&conn, &input, "cashier").unwrap()["duplicate"], true);
                assert_eq!(count(&conn, "staff_order_cash_returns"), 1);
                assert_eq!(
                    conn.query_row(
                        "SELECT payload_json FROM staff_order_cash_returns",
                        [],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                    original
                );
                let queued:String=conn.query_row("SELECT data FROM parity_sync_queue WHERE table_name='payment_adjustments' AND json_extract(data,'$.paymentId')='cash-payment'",[],|r|r.get(0)).unwrap();
                let queued: Value = serde_json::from_str(&queued).unwrap();
                assert_eq!(queued["staff_cash_return"]["amount_cents"], 450);
            }
        }
    }

    #[test]
    fn staff_cancel_prior_full_return_records_handback_without_another_customer_refund() {
        let conn = setup();
        staff_custody_fixture(&conn, "driver");
        for (payment, amount) in [("payment", 6.0), ("cash-payment", 4.5)] {
            crate::refunds::refund_manual_cancellation_in_connection(&conn,&json!({"paymentId":payment,"amount":amount,"reason":"Already returned","staffId":"cashier","staffShiftId":"shift","refundMethod":"card","idempotencyKey":format!("prior:{payment}")})).unwrap();
        }
        assert_eq!(
            orders::cancel_refusal_code(&conn, "order").unwrap(),
            Some("STAFF_CASH_RETURN_REQUIRED")
        );
        let plan = prepare(&conn, "order").unwrap();
        assert_eq!(plan["requiresReturn"], false);
        assert_eq!(plan["requiresHandback"], true);
        let input = request(&conn, "cash_drawer");
        commit(&conn, &input, "cashier").unwrap();
        assert_eq!(count(&conn, "payment_adjustments"), 2);
        assert_eq!(count(&conn, "staff_order_cash_returns"), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM parity_sync_queue WHERE table_name='staff_order_cash_returns'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            conn.query_row(
                "SELECT driver_cash_returned_cents FROM cash_drawer_sessions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            450
        );
    }

    #[test]
    fn staff_cancel_closed_snapshots_and_transferred_cash_are_not_status_inferences() {
        for closed in [false, true] {
            let conn = setup();
            staff_custody_fixture(&conn, "driver");
            conn.execute("UPDATE driver_earnings SET is_transferred=1", [])
                .unwrap();
            if closed {
                conn.execute_batch("UPDATE staff_shifts SET status='closed',check_out_time='2026-10-05T11:00:00Z' WHERE id='worker-shift';UPDATE driver_earnings SET settled=1").unwrap();
            }
            let input = request(&conn, "cash_drawer");
            commit(&conn, &input, "cashier").unwrap();
            assert_eq!(
                count(&conn, "staff_order_cash_returns"),
                if closed { 0 } else { 1 }
            );
            assert_eq!(
                conn.query_row(
                    "SELECT cash_collected_cents FROM driver_earnings WHERE id='earning'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                450
            );
        }
    }

    #[test]
    fn staff_cancel_failure_rolls_back_handback_drawer_refunds_and_status() {
        let conn = setup();
        staff_custody_fixture(&conn, "driver");
        let input = request(&conn, "cash_drawer");
        conn.execute_batch("CREATE TRIGGER reject_cancel BEFORE UPDATE OF status ON orders WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'cancel failed');END;").unwrap();
        assert!(commit(&conn, &input, "cashier").is_err());
        assert_eq!(count(&conn, "staff_order_cash_returns"), 0);
        assert_eq!(count(&conn, "payment_adjustments"), 0);
        assert_eq!(
            conn.query_row(
                "SELECT COALESCE(driver_cash_returned_cents,0) FROM cash_drawer_sessions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT status FROM orders", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "delivered"
        );
    }

    #[test]
    fn history_cancel_completed_and_delivered_split_manual_returns_exactly_once() {
        for status in ["completed", "delivered"] {
            for channel in ["cash_drawer", "bank"] {
                let conn = setup();
                history_split_manual_order(&conn, status);
                // Generic cancellation cannot bypass the existing money gate.
                let refusal = orders::apply_order_status_in_connection(
                    &conn,
                    "order",
                    "cancelled",
                    None,
                    Some("Returned"),
                    "now",
                )
                .err()
                .expect("generic cancellation must retain received money");
                assert!(
                    refusal.contains(orders::ORDER_HAS_PAYMENTS),
                    "{status}: {refusal}"
                );
                assert_eq!(count(&conn, "payment_adjustments"), 0);
                let plan = prepare(&conn, "order").unwrap();
                assert_eq!(plan["amountCents"], 1050);
                assert_eq!(plan["payments"].as_array().unwrap().len(), 2);
                let input = request(&conn, channel);
                let result = commit(&conn, &input, "admin").unwrap();
                assert_eq!(result["amountCents"], 1050);
                assert_eq!(commit(&conn, &input, "admin").unwrap()["duplicate"], true);
                let (state,returned,rows):(String,i64,i64)=conn.query_row("SELECT status,(SELECT SUM(amount_cents) FROM payment_adjustments),(SELECT COUNT(*) FROM payment_adjustments) FROM orders WHERE id='order'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
                assert_eq!((state, returned, rows), ("cancelled".into(), 1050, 2));
                assert_eq!(count(&conn, "order_payments"), 2);
                assert_eq!(count(&conn, "recovery_action_log"), 1);
                let (card,cash,reference):(i64,i64,String)=conn.query_row("SELECT (SELECT amount_cents FROM order_payments WHERE id='payment'),(SELECT amount_cents FROM order_payments WHERE id='cash-payment'),(SELECT transaction_ref FROM order_payments WHERE id='payment')",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
                assert_eq!(
                    (card, cash, reference),
                    (600, 450, "CASH-1791199138332".into())
                );
                let cash_return: i64 = conn
                    .query_row(
                        "SELECT total_refunds_cents FROM cash_drawer_sessions",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(cash_return, if channel == "cash_drawer" { 1050 } else { 0 });
                let outbound:String=conn.query_row("SELECT data FROM parity_sync_queue WHERE table_name='orders' AND record_id='order'",[],|r|r.get(0)).unwrap();
                let outbound: Value = serde_json::from_str(&outbound).unwrap();
                assert_eq!(outbound["status"], "cancelled");
                assert_eq!(outbound["cancellationReason"], "Customer cancelled");
            }
        }
    }

    #[test]
    fn history_cancel_preserves_original_provider_table_and_terminal_status_guards() {
        for status in ["completed", "delivered"] {
            for (sql,expected) in [
                ("UPDATE order_payments SET payment_origin='terminal',transaction_ref='provider-approval' WHERE id='payment'",PROVIDER_REQUIRED),
                ("UPDATE orders SET table_id='bound-table' WHERE id='order'","TABLE_ORDER_CANONICAL_CANCEL_REQUIRED"),
            ] {
                let conn=setup();history_split_manual_order(&conn,status);conn.execute_batch(sql).unwrap();
                assert!(prepare(&conn,"order").unwrap_err().contains(expected));
                assert_eq!(count(&conn,"payment_adjustments"),0);
                assert_eq!(conn.query_row("SELECT status FROM orders WHERE id='order'",[],|r|r.get::<_,String>(0)).unwrap(),status);
            }
        }
        let conn = setup();
        conn.execute("UPDATE orders SET status='refunded' WHERE id='order'", [])
            .unwrap();
        assert!(prepare(&conn, "order")
            .unwrap_err()
            .contains("Invalid status transition"));
    }

    #[test]
    fn history_cancel_unpaid_completed_needs_no_return_and_preserves_reason() {
        let conn = setup();
        conn.execute_batch("DELETE FROM order_payments;UPDATE orders SET status='completed',payment_status='pending';").unwrap();
        assert_eq!(prepare(&conn, "order").unwrap()["requiresReturn"], false);
        assert!(matches!(
            orders::apply_order_status_in_connection(
                &conn,
                "order",
                "cancelled",
                None,
                Some("No money taken"),
                "now"
            )
            .unwrap(),
            orders::LocalStatusChange::Applied { .. }
        ));
        assert_eq!(count(&conn, "payment_adjustments"), 0);
    }

    #[test]
    fn manual_card_cash_drawer_return_cancels_atomically_without_changing_original_unknown_currency(
    ) {
        let conn = setup();
        assert_eq!(
            orders::cancel_refusal_code(&conn, "order").unwrap(),
            Some(orders::ORDER_HAS_PAYMENTS)
        );
        let input = request(&conn, "cash_drawer");
        assert_eq!(commit(&conn, &input, "admin").unwrap()["success"], true);
        let row:(String,String,Option<String>,i64,String,String)=conn.query_row("SELECT o.status,o.payment_status,o.currency,a.amount_cents,a.refund_method,a.cash_handler FROM orders o JOIN payment_adjustments a ON a.order_id=o.id",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
        assert_eq!(
            row,
            (
                "cancelled".into(),
                "pending".into(),
                None,
                600,
                "cash".into(),
                "cashier_drawer".into()
            )
        );
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT total_refunds_cents FROM cash_drawer_sessions",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            600
        );
        assert_eq!(count(&conn, "payment_adjustments"), 1);
        assert!(count(&conn, "parity_sync_queue") >= 2);
        assert_eq!(count(&conn, "ecr_transactions"), 0);
        let (method,pay_unit,shift_unit,drawer_unit,card_cents):(String,String,Option<String>,Option<String>,i64)=conn.query_row("SELECT p.method,p.currency,s.currency,d.currency,d.total_card_sales_cents FROM order_payments p,staff_shifts s,cash_drawer_sessions d",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
        assert_eq!(
            (method, pay_unit, shift_unit, drawer_unit, card_cents),
            ("card".into(), "EUR".into(), None, None, 600)
        );
    }
    #[test]
    fn manual_card_bank_return_does_not_take_cash_and_retry_cannot_double_refund() {
        let conn = setup();
        let input = request(&conn, "bank");
        commit(&conn, &input, "admin").unwrap();
        assert_eq!(commit(&conn, &input, "admin").unwrap()["duplicate"], true);
        let mut mismatch = input.clone();
        mismatch["returnChannel"] = json!("cash_drawer");
        assert!(commit(&conn, &mismatch, "admin")
            .unwrap_err()
            .contains("CONFLICT"));
        assert_eq!(count(&conn, "payment_adjustments"), 1);
        assert_eq!(count(&conn, "recovery_action_log"), 1);
        let (method,handler,refund):(String,Option<String>,i64)=conn.query_row("SELECT a.refund_method,a.cash_handler,d.total_refunds_cents FROM payment_adjustments a,cash_drawer_sessions d",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!((method, handler, refund), ("card".into(), None, 0));
    }
    #[test]
    fn unpaid_cancel_needs_no_return_or_bank_configuration() {
        let conn = setup();
        conn.execute_batch("DELETE FROM order_payments; UPDATE orders SET payment_status='pending'; DELETE FROM local_settings WHERE setting_key='admin_api_get::/api/pos/integrations';").unwrap();
        assert_eq!(prepare(&conn, "order").unwrap()["requiresReturn"], false);
        assert!(matches!(
            orders::apply_order_status_in_connection(
                &conn,
                "order",
                "cancelled",
                None,
                Some("Mistake"),
                "now"
            )
            .unwrap(),
            orders::LocalStatusChange::Applied { .. }
        ));
        assert_eq!(count(&conn, "payment_adjustments"), 0);
    }
    #[test]
    fn provider_original_cannot_be_manually_refunded_even_after_disconnection() {
        for sql in [
            "UPDATE order_payments SET payment_origin='terminal'",
            "UPDATE order_payments SET terminal_device_id='terminal-provider'",
            "UPDATE order_payments SET transaction_ref='provider-approval'",
            "UPDATE order_payments SET method='twint'",
            "UPDATE order_payments SET method='gift_card'",
        ] {
            let conn = setup();
            conn.execute_batch(sql).unwrap();
            assert_eq!(prepare(&conn, "order").unwrap_err(), PROVIDER_REQUIRED);
            assert_eq!(count(&conn, "payment_adjustments"), 0);
        }
    }
    #[test]
    fn connected_bank_blocks_manual_path_but_pending_twint_does_not() {
        for (provider, setup, expected) in [
            ("stripe", Value::Null, true),
            ("worldline_terminals", json!({"transport_ready":true}), true),
            ("twint", json!({"transport_ready":false}), false),
        ] {
            let conn = setup_connection();
            db::set_setting(&conn,"local","admin_api_get::/api/pos/integrations",&json!({"data":{"success":true,"branch_id":"branch","integrations":[{"provider":provider,"category":"payment","branch_id":"branch","is_purchased":true,"is_enabled":true,"status":"connected","payment_setup":setup}]}}).to_string()).unwrap();
            assert_eq!(prepare(&conn, "order").is_err(), expected);
        }
    }
    fn setup_connection() -> Connection {
        setup()
    }
    #[test]
    fn stale_or_unknown_scope_and_changed_ledger_fail_without_writes() {
        let conn = setup();
        let input = request(&conn, "bank");
        conn.execute_batch("UPDATE order_payments SET amount=7,amount_cents=700")
            .unwrap();
        assert_eq!(
            commit(&conn, &input, "admin").unwrap_err(),
            "CANCELLATION_PAYMENT_CHANGED"
        );
        assert_eq!(count(&conn, "payment_adjustments"), 0);
        db::set_setting(
            &conn,
            "local",
            "admin_api_get::/api/pos/integrations",
            &json!({"data":{"success":true,"integrations":[{"branch_id":"foreign"}]}}).to_string(),
        )
        .unwrap();
        assert_eq!(prepare(&conn, "order").unwrap_err(), SETUP_UNKNOWN);
    }
    #[test]
    fn failed_cancel_write_rolls_back_refund_drawer_and_outbox_then_retries_once() {
        let conn = setup();
        let input = request(&conn, "cash_drawer");
        conn.execute_batch("CREATE TRIGGER fail_cancel BEFORE UPDATE OF status ON orders WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'injected write failure'); END;").unwrap();
        assert!(commit(&conn, &input, "admin")
            .unwrap_err()
            .contains("injected write failure"));
        assert_eq!(count(&conn, "payment_adjustments"), 0);
        assert_eq!(count(&conn, "parity_sync_queue"), 0);
        assert_eq!(count(&conn, "recovery_action_log"), 0);
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT total_refunds_cents FROM cash_drawer_sessions",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            0
        );
        conn.execute_batch("DROP TRIGGER fail_cancel").unwrap();
        commit(&conn, &input, "admin").unwrap();
        assert_eq!(count(&conn, "payment_adjustments"), 1);
    }
    #[test]
    fn partial_refund_returns_only_remaining_cents() {
        let conn = setup();
        crate::refunds::refund_payment_in_connection(&conn,&json!({"paymentId":"payment","amount":2,"reason":"Prior return","refundMethod":"card","idempotencyKey":"prior"})).unwrap();
        let input = request(&conn, "cash_drawer");
        assert_eq!(prepare(&conn, "order").unwrap()["amountCents"], 400);
        commit(&conn, &input, "admin").unwrap();
        assert_eq!(count(&conn, "payment_adjustments"), 2);
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT total_refunds_cents FROM cash_drawer_sessions",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            400
        );
    }
    #[test]
    fn paid_label_without_payment_still_cannot_cancel_and_unauthenticated_is_denied() {
        let conn = setup();
        conn.execute_batch("DELETE FROM order_payments").unwrap();
        assert_eq!(
            prepare(&conn, "order").unwrap_err(),
            orders::ORDER_PAYMENT_NOT_RECORDED
        );
        assert!(actor(&auth::AuthState::new()).is_err());
    }
    #[test]
    fn retry_survives_restart_and_cannot_cross_terminal_scope() {
        let temp = crate::tests::harness::TempDir::new();
        let path = temp.path().join("manual-cancel.db");
        let conn = setup();
        conn.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
            .unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        let input = request(&conn, "cash_drawer");
        commit(&conn, &input, "admin").unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(commit(&conn, &input, "admin").unwrap()["duplicate"], true);
        assert_eq!(count(&conn, "payment_adjustments"), 1);
        assert_eq!(count(&conn, "parity_sync_queue"), 2);
        conn.execute("UPDATE orders SET status='pending'", [])
            .unwrap();
        assert_eq!(
            commit(&conn, &input, "admin").unwrap_err(),
            "CANCELLATION_REQUEST_CONFLICT"
        );
        conn.execute("UPDATE orders SET status='cancelled'", [])
            .unwrap();
        db::set_setting(&conn, "terminal", "terminal_id", "foreign-terminal").unwrap();
        assert_eq!(
            commit(&conn, &input, "admin").unwrap_err(),
            "CANCELLATION_REQUEST_CONFLICT"
        );
    }
    #[test]
    fn known_currency_conflict_or_closed_drawer_refuses_without_financial_writes() {
        for sql in [
            "UPDATE staff_shifts SET currency='CHF'",
            "UPDATE cash_drawer_sessions SET currency='CHF'",
            "UPDATE cash_drawer_sessions SET closed_at='now'",
        ] {
            let conn = setup();
            let input = request(&conn, "cash_drawer");
            conn.execute_batch(sql).unwrap();
            assert!(commit(&conn, &input, "admin").is_err());
            assert_eq!(count(&conn, "payment_adjustments"), 0);
        }
    }
    #[test]
    fn authenticated_admin_needs_no_additional_pin_confirmation() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let conn = setup();
        db::set_setting(
            &conn,
            "staff",
            "admin_pin_hash",
            &bcrypt::hash("1234", 4).unwrap(),
        )
        .unwrap();
        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };
        let auth = auth::AuthState::new();
        assert_eq!(
            auth::login(Some(json!({"pin":"1234"})), &db, &auth).unwrap()["success"],
            true
        );
        assert!(!actor(&auth).unwrap().is_empty());
    }
    #[test]
    fn historical_ecr_sale_attempt_refuses_even_when_device_is_disconnected_and_attempt_failed() {
        let conn = setup();
        conn.execute_batch("INSERT INTO ecr_devices(id,name,device_type,connection_type,status) VALUES('device','Bank terminal','payment_terminal','network','disconnected');
            INSERT INTO ecr_transactions(id,device_id,order_id,transaction_type,amount,currency,status,started_at) VALUES('sale','device','order','sale',600,'EUR','failed','now')").unwrap();
        assert_eq!(prepare(&conn, "order").unwrap_err(), PROVIDER_REQUIRED);
        assert_eq!(count(&conn, "payment_adjustments"), 0);
    }

    #[test]
    fn original_payment_must_sync_before_return_without_any_new_charge_or_adjustment() {
        for sql in [
            "UPDATE order_payments SET sync_state='waiting_parent'",
            "UPDATE order_payments SET remote_payment_id=NULL",
            "UPDATE order_payments SET sync_status='pending'",
        ] {
            let conn = setup();
            conn.execute_batch(sql).unwrap();
            assert_eq!(
                prepare(&conn, "order").unwrap_err(),
                "PAYMENT_SYNC_REQUIRED"
            );
            assert_eq!(count(&conn, "payment_adjustments"), 0);
            assert_eq!(count(&conn, "ecr_transactions"), 0);
        }
    }
    #[test]
    fn paid_claim_with_incomplete_original_coverage_must_restore_history_first() {
        let conn = setup();
        conn.execute_batch("UPDATE order_payments SET amount=2,amount_cents=200")
            .unwrap();
        assert_eq!(
            prepare(&conn, "order").unwrap_err(),
            orders::ORDER_PAYMENT_NOT_RECORDED
        );
        assert_eq!(count(&conn, "payment_adjustments"), 0);
        conn.execute_batch("UPDATE orders SET payment_status='partially_paid'")
            .unwrap();
        assert_eq!(prepare(&conn, "order").unwrap()["amountCents"], 200);
    }

    #[test]
    fn known_order_currency_must_agree_with_original_payment() {
        let conn = setup();
        conn.execute_batch("UPDATE orders SET currency='CHF'")
            .unwrap();
        assert_eq!(
            prepare(&conn, "order").unwrap_err(),
            "PAYMENT_CURRENCY_MISMATCH"
        );
        assert_eq!(count(&conn, "payment_adjustments"), 0);
    }

    #[test]
    fn cancelled_restore_unpaid_order_keeps_full_balance_and_no_money_history() {
        let conn = setup();
        conn.execute_batch(
            "DELETE FROM order_payments; UPDATE orders SET payment_status='pending';",
        )
        .unwrap();
        for (status, reason) in [("cancelled", Some("First cancellation")), ("pending", None)] {
            assert!(matches!(
                orders::apply_order_status_in_connection(
                    &conn,
                    "order",
                    status,
                    None,
                    reason,
                    "2026-10-06T10:00:00Z"
                )
                .unwrap(),
                orders::LocalStatusChange::Applied { .. }
            ));
        }
        let state: (String, String, Option<String>) = conn
            .query_row(
                "SELECT status,payment_status,cancellation_reason FROM orders WHERE id='order'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, ("pending".into(), "pending".into(), None));
        let balance = payments::load_order_payment_balance_snapshot(&conn, "order").unwrap();
        assert_eq!(balance.net_paid, 0.0);
        assert_eq!(balance.outstanding_amount, 6.0);
        assert_eq!(count(&conn, "order_payments"), 0);
        assert_eq!(count(&conn, "payment_adjustments"), 0);
        assert_eq!(prepare(&conn, "order").unwrap()["requiresReturn"], false);
        assert!(matches!(
            orders::apply_order_status_in_connection(
                &conn,
                "order",
                "cancelled",
                None,
                Some("Second cancellation"),
                "2026-10-06T10:01:00Z"
            )
            .unwrap(),
            orders::LocalStatusChange::Applied { .. }
        ));
        assert_eq!(count(&conn, "payment_adjustments"), 0);
    }

    #[test]
    fn cancelled_restore_refunded_order_collects_and_cancels_again_without_reusing_history() {
        // Canonical receipts may stay completed while separate adjustments
        // prove a full refund; both supported representations must behave alike.
        for original_status in ["refunded", "completed"] {
            let conn = setup();
            conn.execute_batch("UPDATE staff_shifts SET currency='EUR'; UPDATE cash_drawer_sessions SET currency='EUR'; UPDATE orders SET currency='EUR';").unwrap();
            let first = request(&conn, "bank");
            assert_eq!(commit(&conn, &first, "cashier").unwrap()["success"], true);
            let first_refund: String = conn.query_row(
                "SELECT json_object('id',id,'payment_id',payment_id,'amount_cents',amount_cents,'reason',reason,'refund_method',refund_method,'created_at',created_at) FROM payment_adjustments",
                [],|r|r.get(0)
            ).unwrap();
            let first_id: String = conn
                .query_row("SELECT id FROM payment_adjustments", [], |r| r.get(0))
                .unwrap();
            // Mirror acknowledgement only; receipt, amount and refund stay intact.
            conn.execute(
                "UPDATE order_payments SET status=?1 WHERE id='payment'",
                [original_status],
            )
            .unwrap();
            payments::recompute_order_payment_state(
                &conn,
                "order",
                "2026-10-06T10:00:00Z",
                "payment",
            )
            .unwrap();
            assert!(matches!(
                orders::apply_order_status_in_connection(
                    &conn,
                    "order",
                    "pending",
                    None,
                    None,
                    "2026-10-06T10:01:00Z"
                )
                .unwrap(),
                orders::LocalStatusChange::Applied { .. }
            ));
            let balance = payments::load_order_payment_balance_snapshot(&conn, "order").unwrap();
            assert_eq!(balance.net_paid, 0.0, "{original_status}");
            assert_eq!(balance.outstanding_amount, 6.0, "{original_status}");
            let state: (String, String, Option<String>) = conn
                .query_row(
                    "SELECT status,payment_status,cancellation_reason FROM orders WHERE id='order'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(state, ("pending".into(), "pending".into(), None));
            assert_eq!(
                commit(&conn, &first, "cashier").unwrap_err(),
                "CANCELLATION_REQUEST_CONFLICT"
            );
            let db = db::DbState {
                conn: std::sync::Mutex::new(conn),
                db_path: std::path::PathBuf::from(":memory:"),
            };
            let receipt = payments::record_payment_with_expected_balance(
                &db,
                &json!({
                "orderId":"order","method":"cash","amount":6.0,"cashReceived":6.0,"currency":"EUR",
                    "paymentOrigin":"manual","idempotencyKey":"restored-new-collection",
                    "staffId":"cashier","staffShiftId":"shift","collectedBy":"cashier_drawer",
                    "collectOutstandingBalance":true
                }),
                Some(balance),
            )
            .expect("restored order accepts one new collection");
            let conn = db.conn.lock().unwrap();
            let new_payment: String = conn
                .query_row(
                    "SELECT id FROM order_payments WHERE idempotency_key='restored-new-collection'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_ne!(new_payment, "payment", "{receipt}");
            // Acknowledgement enables manual cancellation of this exact new receipt.
            conn.execute("UPDATE order_payments SET sync_state='applied',sync_status='synced',remote_payment_id='2238ddd9-5e52-47b6-ac6d-3e398b14ae08' WHERE id=?1",[&new_payment]).unwrap();
            let paid = payments::load_order_payment_balance_snapshot(&conn, "order").unwrap();
            assert_eq!(paid.net_paid, 6.0);
            assert_eq!(paid.outstanding_amount, 0.0);
            let next_plan = prepare(&conn, "order").unwrap();
            assert_eq!(next_plan["amountCents"], 600);
            assert_eq!(
                next_plan["payments"],
                json!([{"paymentId":new_payment,"amountCents":600}])
            );
            let second = json!({"orderId":"order","reason":"Second cancellation","returnChannel":"cash_drawer","requestId":"request-2","generation":next_plan["generation"]});
            assert_eq!(commit(&conn, &second, "cashier").unwrap()["success"], true);
            assert_eq!(
                commit(&conn, &second, "cashier").unwrap()["duplicate"],
                true
            );
            let original_again:String=conn.query_row("SELECT json_object('id',id,'payment_id',payment_id,'amount_cents',amount_cents,'reason',reason,'refund_method',refund_method,'created_at',created_at) FROM payment_adjustments WHERE id=?1",[&first_id],|r|r.get(0)).unwrap();
            assert_eq!(original_again, first_refund, "original refund is immutable");
            assert_eq!(count(&conn, "order_payments"), 2);
            assert_eq!(count(&conn, "payment_adjustments"), 2);
            assert_eq!(count(&conn, "recovery_action_log"), 2);
            assert_eq!(conn.query_row::<i64,_,_>("SELECT COUNT(DISTINCT id) FROM recovery_action_log WHERE id IN ('manual-cancel:request-1','manual-cancel:request-2')",[],|r|r.get(0)).unwrap(),2);
            assert_eq!(
                conn.query_row::<i64, _, _>(
                    "SELECT total_refunds_cents FROM cash_drawer_sessions",
                    [],
                    |r| r.get(0)
                )
                .unwrap(),
                600
            );
            let end = payments::load_order_payment_balance_snapshot(&conn, "order").unwrap();
            assert_eq!(end.net_paid, 0.0);
            assert_eq!(end.outstanding_amount, 6.0);
            let final_status: String = conn
                .query_row("SELECT status FROM orders WHERE id='order'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(final_status, "cancelled");
        }
    }
}
