//! Immutable order-bound staff cash handed to the cashier at cancellation.
//! Customer refunds remain separate movements; original earnings are retained.
use crate::{gift_financial_opening::OpeningScope, money::Cents};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS staff_order_cash_returns (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
 order_id TEXT NOT NULL, payment_id TEXT NOT NULL, source_staff_id TEXT NOT NULL,
 source_staff_shift_id TEXT NOT NULL, source_role TEXT NOT NULL CHECK(source_role IN ('driver','server')),
 receiving_cashier_shift_id TEXT NOT NULL, receiving_drawer_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL,
 cancellation_event_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL, reason TEXT NOT NULL,
 occurred_at TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
 adjustment_id TEXT, sync_status TEXT NOT NULL DEFAULT 'pending',
 FOREIGN KEY(order_id) REFERENCES orders(id), FOREIGN KEY(payment_id) REFERENCES order_payments(id));
 CREATE INDEX IF NOT EXISTS staff_cash_returns_order ON staff_order_cash_returns(order_id);
 CREATE INDEX IF NOT EXISTS staff_cash_returns_shift ON staff_order_cash_returns(source_staff_shift_id);";

pub(crate) fn sum(
    conn: &Connection,
    order: Option<&str>,
    shift: Option<&str>,
) -> Result<i64, String> {
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_order_cash_returns')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        return Ok(0);
    }
    conn.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM staff_order_cash_returns WHERE (?1 IS NULL OR order_id=?1) AND (?2 IS NULL OR source_staff_shift_id=?2)",params![order,shift],|r|r.get(0)).map_err(|e|e.to_string())
}

pub(crate) struct OriginalCashCollector {
    pub staff_id: String,
    pub shift_id: String,
    pub role: String,
    pub currency: Option<String>,
    pub active: bool,
}

/// Receipt attribution precedes a later delivery assignment. Native columns
/// and any saved metadata aliases must agree; no collector is guessed.
pub(crate) fn original_cash_collector(
    conn: &Connection,
    staff: Option<&str>,
    shift: Option<&str>,
    branch: &str,
    raw_metadata: Option<&str>,
) -> Result<Option<OriginalCashCollector>, String> {
    let metadata = raw_metadata
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|_| "STAFF_CASH_CUSTODY_AMBIGUOUS")?
        .unwrap_or(Value::Null);
    if !metadata.is_null() && !metadata.is_object() {
        return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
    }
    let alias = |keys: &[&str]| -> Result<Option<String>, String> {
        let mut found: Option<String> = None;
        for key in keys {
            let value = &metadata[*key];
            if value.is_null() {
                continue;
            }
            let value = value.as_str().ok_or("STAFF_CASH_CUSTODY_AMBIGUOUS")?.trim();
            if value.is_empty() {
                continue;
            }
            if found.as_deref().is_some_and(|prior| prior != value) {
                return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
            }
            found = Some(value.to_string());
        }
        Ok(found)
    };
    let merge = |column: Option<&str>, saved: Option<String>| -> Result<Option<String>, String> {
        let column = column.map(str::trim).filter(|value| !value.is_empty());
        if column
            .zip(saved.as_deref())
            .is_some_and(|(left, right)| left != right)
        {
            return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
        }
        Ok(column.map(str::to_owned).or(saved))
    };
    let staff = merge(staff, alias(&["staff_id", "staffId"])?)?;
    let shift = merge(shift, alias(&["staff_shift_id", "staffShiftId"])?)?;
    let handler = alias(&["collected_by", "collectedBy"])?;
    let Some(shift) = shift else {
        if staff.is_some() || handler.is_some() {
            return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
        }
        return Ok(None);
    };
    let (collector, recorded_branch):(OriginalCashCollector,Option<String>)=conn.query_row(
        "SELECT staff_id,id,role_type,currency,status='active' AND check_out_time IS NULL,branch_id FROM staff_shifts WHERE id=?1",
        [&shift],|r|Ok((OriginalCashCollector{staff_id:r.get(0)?,shift_id:r.get(1)?,role:r.get(2)?,currency:r.get(3)?,active:r.get(4)?},r.get(5)?)))
        .optional().map_err(|e|e.to_string())?.ok_or("STAFF_CASH_CUSTODY_AMBIGUOUS")?;
    if recorded_branch.as_deref() != Some(branch)
        || staff.as_ref().is_some_and(|id| id != &collector.staff_id)
        || !matches!(
            collector.role.as_str(),
            "cashier" | "manager" | "driver" | "server"
        )
        || handler.as_deref().is_some_and(|kind| match kind {
            "cashier_drawer" => !matches!(collector.role.as_str(), "cashier" | "manager"),
            "driver_shift" => !matches!(collector.role.as_str(), "driver" | "server"),
            _ => true,
        })
    {
        return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
    }
    Ok(Some(collector))
}

/// Original collector proof only. A cancelled label or cashier handover flag
/// alone does not establish a physical return.
pub(crate) fn plan(conn: &Connection, order: &str) -> Result<Vec<Value>, String> {
    let mut stmt=conn.prepare("SELECT p.id,p.remote_payment_id,p.staff_id,p.staff_shift_id,p.currency,
      COALESCE(p.amount_cents,CAST(ROUND(p.amount*100) AS INTEGER),0)-COALESCE((SELECT SUM(COALESCE(a.amount_cents,CAST(ROUND(a.amount*100) AS INTEGER),0)) FROM payment_adjustments a WHERE a.payment_id=p.id AND a.adjustment_type='refund' AND LOWER(COALESCE(a.refund_method,'cash'))='cash' AND LOWER(COALESCE(a.cash_handler,''))='driver_shift'),0),
      p.sync_state,p.sync_status,o.supabase_id,o.branch_id,p.payment_origin,p.transaction_ref,p.terminal_device_id,p.metadata
      FROM order_payments p JOIN orders o ON o.id=p.order_id WHERE p.order_id=?1 AND p.method='cash' AND p.status IN ('completed','refunded') ORDER BY p.id") .map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([order], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<String>>(10)?,
                r.get::<_, Option<String>>(11)?,
                r.get::<_, Option<String>>(12)?,
                r.get::<_, Option<String>>(13)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for (
        payment,
        remote_payment,
        staff,
        payment_shift,
        currency,
        gross,
        sync_state,
        sync_status,
        remote_order,
        branch,
        origin,
        reference,
        device,
        metadata,
    ) in rows
    {
        let collector = original_cash_collector(
            conn,
            staff.as_deref(),
            payment_shift.as_deref(),
            branch.as_deref().unwrap_or_default(),
            metadata.as_deref(),
        )?;
        if collector.as_ref().is_some_and(|owner| {
            !owner.active || matches!(owner.role.as_str(), "cashier" | "manager")
        }) {
            continue;
        }
        let mut drivers=conn.prepare("SELECT s.staff_id,s.id,s.role_type,s.currency,COALESCE(e.cash_collected_cents,CAST(ROUND(e.cash_collected*100) AS INTEGER),0) FROM driver_earnings e JOIN staff_shifts s ON s.id=e.staff_shift_id WHERE e.order_id=?1 AND COALESCE(e.settled,0)=0 AND s.status='active' AND s.check_out_time IS NULL AND s.branch_id=?2 AND s.role_type='driver' AND e.driver_id=s.staff_id").map_err(|e|e.to_string())?;
        let owners = drivers
            .query_map(params![order, branch], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let owner = match collector {
            Some(owner) if owner.role == "server" => {
                Some((owner.staff_id, owner.shift_id, owner.role, owner.currency))
            }
            Some(owner) => {
                let matching: Vec<_> = owners
                    .into_iter()
                    .filter(|row| row.0 == owner.staff_id && row.1 == owner.shift_id)
                    .collect();
                if matching.is_empty() && conn.query_row("SELECT EXISTS(SELECT 1 FROM driver_earnings WHERE order_id=?1 AND driver_id=?2 AND staff_shift_id=?3 AND settled=1)",params![order,owner.staff_id,owner.shift_id],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())? {
                    None
                } else {
                    if matching.len()!=1 { return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into()); }
                    Some((owner.staff_id,owner.shift_id,owner.role,owner.currency))
                }
            }
            None => {
                if owners.len() > 1 {
                    return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
                }
                match owners.into_iter().next() {
                    Some((staff, shift, role, unit, cash)) if cash > 0 && gross <= cash => {
                        Some((staff, shift, role, unit))
                    }
                    Some(_) => return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into()),
                    None => None,
                }
            }
        };
        let Some((source_staff, source_shift, role, source_currency)) = owner else {
            continue;
        };
        let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_order_cash_returns')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        let already = if exists {
            conn.query_row("SELECT COALESCE(SUM(amount_cents),0) FROM staff_order_cash_returns WHERE payment_id=?1",[&payment],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?
        } else {
            0
        };
        let legacy_cash_return=conn.query_row("SELECT COALESCE(SUM(COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER))),0) FROM payment_adjustments WHERE payment_id=?1 AND adjustment_type='refund' AND COALESCE(refund_method,'cash')='cash' AND TRIM(COALESCE(cash_handler,''))=''",[&payment],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?;
        if role == "server" && legacy_cash_return > 0 {
            return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
        }
        let legacy_driver_return = if role == "driver" {
            legacy_cash_return
        } else {
            0
        };
        let held = gross - legacy_driver_return - already;
        if held < 0 {
            return Err("STAFF_CASH_CUSTODY_INVALID".into());
        }
        if held == 0 {
            continue;
        }
        if sync_state != "applied"
            || sync_status != "synced"
            || remote_payment.as_deref().is_none_or(str::is_empty)
            || remote_order.as_deref().is_none_or(str::is_empty)
        {
            return Err("PAYMENT_SYNC_REQUIRED".into());
        }
        if !crate::manual_order_cancellation::original_is_manual_with_metadata(
            "cash",
            origin.as_deref().unwrap_or(""),
            device.as_deref().unwrap_or(""),
            reference.as_deref().unwrap_or(""),
            metadata.as_deref(),
        ) {
            return Err("ORIGINAL_PROVIDER_RETURN_REQUIRED".into());
        }
        let currency = currency
            .filter(|unit| unit.len() == 3 && unit.bytes().all(|b| b.is_ascii_uppercase()))
            .ok_or("PAYMENT_CURRENCY_UNAVAILABLE")?;
        if source_currency.as_deref() != Some(&currency) {
            return Err("PAYMENT_CURRENCY_MISMATCH".into());
        }
        result.push(json!({"paymentId":payment,"canonicalPaymentId":remote_payment,"canonicalOrderId":remote_order,"source_staff_id":source_staff,"source_staff_shift_id":source_shift,"source_role":role,"amount_cents":held,"currency":currency}));
    }
    if !result.is_empty() {
        let ambiguous:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM payment_adjustments a JOIN order_payments p ON p.id=a.payment_id WHERE p.order_id=?1 AND p.method<>'cash' AND a.adjustment_type='refund' AND COALESCE(a.refund_method,'cash')='cash' AND (a.cash_handler='driver_shift' OR TRIM(COALESCE(a.cash_handler,''))=''))",[order],|r|r.get(0)).map_err(|e|e.to_string())?;
        if ambiguous {
            return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
        }
    }
    Ok(result)
}

pub(crate) fn record(
    conn: &Connection,
    scope: &OpeningScope,
    order: &str,
    source: &Value,
    cashier_shift: &str,
    drawer: &str,
    event: &str,
    actor: &str,
    reason: &str,
    now: &str,
) -> Result<Value, String> {
    let payment = source["paymentId"]
        .as_str()
        .ok_or("STAFF_CASH_CUSTODY_INVALID")?;
    let cents = source["amount_cents"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or("STAFF_CASH_CUSTODY_INVALID")?;
    let id = uuid::Uuid::new_v4().to_string();
    let key = format!("manual-cancel:{event}:cash-return:{payment}");
    let receipt = json!({"id":id,"idempotency_key":key,"source_staff_id":source["source_staff_id"],"source_staff_shift_id":source["source_staff_shift_id"],"source_role":source["source_role"],"receiving_cashier_shift_id":cashier_shift,"receiving_drawer_id":drawer,"amount_cents":cents,"currency":source["currency"],"cancellation_event_id":event,"occurred_at":now});
    conn.execute("INSERT INTO staff_order_cash_returns(id,organization_id,branch_id,terminal_id,order_id,payment_id,source_staff_id,source_staff_shift_id,source_role,receiving_cashier_shift_id,receiving_drawer_id,amount_cents,currency,cancellation_event_id,actor_staff_id,reason,occurred_at,idempotency_key,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",params![id,scope.organization_id,scope.branch_id,scope.terminal_id,order,payment,source["source_staff_id"].as_str(),source["source_staff_shift_id"].as_str(),source["source_role"].as_str(),cashier_shift,drawer,cents,source["currency"].as_str(),event,actor,reason,now,key,receipt.to_string()]).map_err(|e|e.to_string())?;
    let updated=conn.execute("UPDATE cash_drawer_sessions SET driver_cash_returned=COALESCE(driver_cash_returned,0)+?1,driver_cash_returned_cents=COALESCE(driver_cash_returned_cents,CAST(ROUND(driver_cash_returned*100) AS INTEGER),0)+?2,updated_at=?3 WHERE id=?4 AND staff_shift_id=?5 AND closed_at IS NULL",params![Cents::new(cents).to_f64_dp2(),cents,now,drawer,cashier_shift]).map_err(|e|e.to_string())?;
    if updated != 1 {
        return Err("CASHIER_DRAWER_UNAVAILABLE".into());
    }
    Ok(receipt)
}

pub(crate) fn enqueue(
    conn: &Connection,
    source: &Value,
    receipt: &Value,
    actor: &str,
    reason: &str,
    adjustment: Option<&str>,
) -> Result<(), String> {
    let id = receipt["id"].as_str().ok_or("STAFF_CASH_CUSTODY_INVALID")?;
    if let Some(adjustment) = adjustment {
        let (queue_id,raw):(String,String)=conn.query_row("SELECT id,data FROM parity_sync_queue WHERE table_name='payment_adjustments' AND record_id=?1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[adjustment],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        let mut payload: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        payload["staff_cash_return"] = receipt.clone();
        conn.execute(
            "UPDATE parity_sync_queue SET data=?1 WHERE id=?2",
            params![payload.to_string(), queue_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE staff_order_cash_returns SET adjustment_id=?1 WHERE id=?2",
            params![adjustment, id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let mut payload = receipt.clone();
        payload["order_id"] = source["canonicalOrderId"].clone();
        payload["payment_id"] = source["canonicalPaymentId"].clone();
        payload["actor_staff_id"] = if uuid::Uuid::parse_str(actor).is_ok() {
            json!(actor)
        } else {
            Value::Null
        };
        payload["reason"] = json!(reason);
        crate::sync_queue::enqueue_payload_item(
            conn,
            "staff_order_cash_returns",
            id,
            "INSERT",
            &payload,
            Some(1),
            Some("staff_cash_return"),
            Some("manual"),
            Some(1),
        )?;
    }
    Ok(())
}

/// Cash actually collected by this waiter, including cancelled history until a
/// real driver-side payout or cashier handback removes it from their custody.
pub(crate) fn waiter_cash(
    conn: &Connection,
    shift: &str,
    order: Option<&str>,
) -> Result<i64, String> {
    let sql=format!("SELECT COALESCE(SUM(MAX(0,COALESCE(p.amount_cents,CAST(ROUND(p.amount*100) AS INTEGER),0)-COALESCE((SELECT SUM(COALESCE(a.amount_cents,CAST(ROUND(a.amount*100) AS INTEGER),0)) FROM payment_adjustments a WHERE a.payment_id=p.id AND a.adjustment_type='refund' AND COALESCE(a.refund_method,'cash')='cash' AND a.cash_handler='driver_shift'),0))),0) FROM order_payments p JOIN orders o ON o.id=p.order_id WHERE p.staff_shift_id=?1 AND (?2 IS NULL OR p.order_id=?2) AND p.method='cash' AND p.status IN ('completed','refunded') AND COALESCE(o.is_ghost,0)=0 AND NOT {}",crate::payments::placeholder_payment_sql("p"));
    let gross: i64 = conn
        .query_row(&sql, params![shift, order], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok((gross - sum(conn, order, Some(shift))?).max(0))
}
