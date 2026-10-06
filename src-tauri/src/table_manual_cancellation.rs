//! Exact canonical table cancellation financial intent and once-only receipt mirror.
//! Never releases a table or invents a local refund before canonical acknowledgement.
use crate::{gift_financial_opening::OpeningScope, money::Cents};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// A proven server refusal: nothing was applied and nothing can apply later.
pub(crate) const REFUSED: &str = "TABLE_CANCELLATION_REFUSED";
/// An apply request older than this can no longer commit: every approval it
/// could carry has expired (the server grants five minutes).
const APPROVAL_EXPIRY_MARGIN_MINUTES: i64 = 15;
const RELEASE_ACTION: &str = "table_cancel_release_v1";

/// The tables only. Paths that run inside another writer's statements or
/// receipt savepoint (the canonical receipt mirror, the session preflight)
/// never migrate columns.
fn create_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS table_manual_cancel_intents_v1 (
      organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,terminal_id TEXT NOT NULL,
      event_id TEXT NOT NULL,order_id TEXT NOT NULL,session_id TEXT NOT NULL,
      generation TEXT NOT NULL,channel TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,
      request_json TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
      PRIMARY KEY(organization_id,branch_id,terminal_id,event_id));
      CREATE TABLE IF NOT EXISTS table_manual_cancel_preflights_v1(
      organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,terminal_id TEXT NOT NULL,order_id TEXT NOT NULL,
      session_id TEXT NOT NULL,PRIMARY KEY(organization_id,branch_id,terminal_id,order_id));",
    )
    .map_err(|e| e.to_string())
}

fn schema(conn: &Connection) -> Result<(), String> {
    create_tables(conn)?;
    // Refusal state (review 06/10/2026). `dispatch_count` counts apply
    // requests, recorded before each is sent; NULL is the unknown history of
    // an intent saved before this tracking existed, whose last possible
    // request is bounded by the upgrade itself (`last_dispatch_at`).
    // `outcome`: NULL while the server outcome may still be unknown,
    // `refused` once a server refusal is proven, `released` after a manager
    // clears it with an audit entry.
    let has = |column: &str| -> Result<bool, String> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('table_manual_cancel_intents_v1') WHERE name=?1)",
            [column],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
    };
    if !has("dispatch_count")? {
        conn.execute_batch(
            "ALTER TABLE table_manual_cancel_intents_v1 ADD COLUMN dispatch_count INTEGER;
             ALTER TABLE table_manual_cancel_intents_v1 ADD COLUMN last_dispatch_at TEXT;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE table_manual_cancel_intents_v1 SET last_dispatch_at=?1 WHERE applied=0",
            [chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    }
    for column in ["outcome", "refusal_code", "resolved_at", "resolved_by"] {
        if !has(column)? {
            conn.execute_batch(&format!(
                "ALTER TABLE table_manual_cancel_intents_v1 ADD COLUMN {column} TEXT"
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn exists(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='table_manual_cancel_intents_v1')",[],|r|r.get(0)).map_err(|e|e.to_string())
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("TABLE_CANCELLATION_RECEIPT_INVALID:{key}"))
}
fn amount(v: &Value) -> Result<i64, String> {
    v["amount_cents"]
        .as_i64()
        .or_else(|| {
            v["amount"]
                .as_f64()
                .map(|n| Cents::round_half_even(n).as_i64())
        })
        .ok_or("TABLE_CANCELLATION_RECEIPT_INVALID".into())
}
pub(crate) fn canonical_order(conn: &Connection, order: &str) -> Result<String, String> {
    conn.query_row("SELECT supabase_id FROM orders WHERE id=?1", [order], |r| {
        r.get::<_, Option<String>>(0)
    })
    .map_err(|e| e.to_string())?
    .filter(|s| uuid::Uuid::parse_str(s).is_ok())
    .ok_or("TABLE_CANCEL_SYNC_REQUIRED".into())
}
pub(crate) fn resolve_session(
    conn: &Connection,
    raw: &str,
    requested: Option<&str>,
) -> Result<Option<String>, String> {
    let (stored,kind):(Option<String>,String)=conn.query_row("SELECT NULLIF(TRIM(table_session_id),''),COALESCE(order_type,'') FROM orders WHERE id=?1 OR supabase_id=?1",[raw],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if requested.is_some()
        && requested != stored.as_deref()
        && (stored.is_some() || !matches!(kind.as_str(), "dine-in" | "dine_in"))
    {
        return Err("TABLE_CANCEL_SYNC_REQUIRED".into());
    }
    Ok(stored.or_else(|| requested.map(str::to_string)))
}
/// Whether a cancellation belongs to the canonical table lifecycle. Decided by
/// table evidence (a check session, a table binding or number, or retained
/// table-service history), as Android's `isTableServiceOrder`; the dine-in
/// label alone is not a table check. A kiosk eat-in order has none and is
/// cancelled like any counter order (review 06/10/2026).
pub(crate) fn is_table_candidate(conn: &Connection, raw: &str) -> Result<bool, String> {
    #[allow(clippy::type_complexity)]
    let (id, remote, session, dine_in, bound, organization, branch, owner): (
        String,
        Option<String>,
        bool,
        bool,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT id,supabase_id,NULLIF(TRIM(COALESCE(table_session_id,'')),'') IS NOT NULL,
               COALESCE(order_type,'') IN ('dine-in','dine_in'),
               NULLIF(TRIM(COALESCE(table_id,'')),'') IS NOT NULL OR NULLIF(TRIM(COALESCE(table_number,'')),'') IS NOT NULL,
               organization_id,branch_id,owner_terminal_id
             FROM orders WHERE id=?1 OR supabase_id=?1",
            [raw],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    if session {
        return Ok(true);
    }
    if !dine_in {
        return Ok(false);
    }
    if bound {
        return Ok(true);
    }
    crate::table_session_cache::has_order_history(
        conn,
        &id,
        remote.as_deref(),
        organization.as_deref(),
        branch.as_deref(),
        owner.as_deref(),
    )
}
pub(crate) fn original_session_proven(
    conn: &Connection,
    order: &str,
    session: &str,
) -> Result<bool, String> {
    create_tables(conn)?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    conn.query_row("SELECT EXISTS(SELECT 1 FROM table_manual_cancel_preflights_v1 p JOIN orders o ON o.id=p.order_id WHERE p.organization_id=?1 AND p.branch_id=?2 AND p.terminal_id=?3 AND p.order_id=?4 AND p.session_id=?5 AND o.order_type IN ('dine-in','dine_in'))",params![scope.organization_id,scope.branch_id,scope.terminal_id,order,session],|r|r.get(0)).map_err(|e|e.to_string())
}
pub(crate) fn snapshot_session(
    response: &Value,
    requested: Option<&str>,
) -> Result<String, String> {
    let data = response.get("data").unwrap_or(response);
    let remote = text(&data["order"], "id")?;
    let sessions = data["table_sessions"]
        .as_array()
        .ok_or("TABLE_CANCEL_SYNC_REQUIRED")?;
    let eligible: Vec<_> = sessions
        .iter()
        .filter(|s| s["active_order_id"] == remote && requested.is_none_or(|id| s["id"] == id))
        .collect();
    if eligible.len() != 1 {
        return Err("TABLE_CANCEL_SYNC_REQUIRED".into());
    }
    Ok(text(eligible[0], "id")?.to_string())
}
// Match the canonical table-return classifier before the operator confirms a
// physical return. Local receipt columns alone cannot disprove remote provider
// metadata that was added or restored after the last payment download.
pub(crate) fn canonical_manual_receipt(payment: &Value) -> bool {
    let method = payment["payment_method"].as_str().unwrap_or_default();
    let metadata = &payment["metadata"];
    if !matches!(method, "cash" | "card")
        || (!metadata.is_null() && !metadata.is_object())
        || metadata.get("platform_held_tender").is_some()
    {
        return false;
    }
    let manual = ["payment_origin", "paymentOrigin"].iter().any(|key| {
        matches!(
            metadata[*key].as_str(),
            Some("manual" | "manual_card" | "manual_recovery")
        )
    });
    let reference_allowed = |reference: &str| {
        reference.is_empty()
            || reference.strip_prefix("CASH-").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
            })
            || (manual
                && reference.strip_prefix("CARD-").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
                }))
    };
    for key in [
        "provider",
        "terminal_device_id",
        "terminalDeviceId",
        "terminal_reference",
        "terminalReference",
        "ecr_terminal_reference",
        "ecrTerminalReference",
        "terminalTransactionId",
    ] {
        let value = &metadata[key];
        if !value.is_null() && value.as_str().is_none_or(|s| !s.trim().is_empty()) {
            return false;
        }
    }
    for key in ["terminal_processed", "terminalProcessed"] {
        if metadata[key] == true
            || metadata[key]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("true"))
        {
            return false;
        }
    }
    for key in ["payment_origin", "paymentOrigin"] {
        let value = &metadata[key];
        if !value.is_null()
            && !value.as_str().is_some_and(|origin| {
                origin.trim().is_empty()
                    || matches!(origin, "manual" | "manual_card" | "manual_recovery")
                    || (origin == "cash_checkout_reconciled"
                        && method == "cash"
                        && metadata["source"] == "mobile_cart_checkout")
            })
        {
            return false;
        }
    }
    for key in [
        "external_transaction_id",
        "externalTransactionId",
        "transaction_ref",
    ] {
        let value = &metadata[key];
        if !value.is_null()
            && !value
                .as_str()
                .is_some_and(|s| s.trim().is_empty() || reference_allowed(s))
        {
            return false;
        }
    }
    let reference = &payment["external_transaction_id"];
    if !reference.is_null() && !reference.as_str().is_some_and(reference_allowed) {
        return false;
    }
    method == "cash" || manual || reference.as_str().is_some_and(|s| s.starts_with("CASH-"))
}

pub(crate) fn validate_snapshot(
    conn: &Connection,
    plan: &Value,
    session: &str,
    response: &Value,
) -> Result<(), String> {
    let data = response.get("data").unwrap_or(response);
    if data["table_manual_refund_version"] != 1 {
        return Err("TABLE_MANUAL_CANCELLATION_UNAVAILABLE".into());
    }
    let order = text(plan, "orderId")?;
    let remote = canonical_order(conn, order)?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let original = &data["order"];
    if original["id"] != remote
        || original["organization_id"] != scope.organization_id
        || original["branch_id"] != scope.branch_id
        || (original["table_session_id"]
            .as_str()
            .is_some_and(|id| id != session))
    {
        return Err("CANCELLATION_PAYMENT_CHANGED".into());
    }
    let (status,total):(String,i64)=conn.query_row("SELECT status,COALESCE(total_amount_cents,CAST(ROUND(total_amount*100) AS INTEGER)) FROM orders WHERE id=?1",[order],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if original["status"] != status
        || Cents::round_half_even(
            original["total_amount"]
                .as_f64()
                .ok_or("CANCELLATION_PAYMENT_CHANGED")?,
        )
        .as_i64()
            != total
    {
        return Err("CANCELLATION_PAYMENT_CHANGED".into());
    }
    let canonical = data["payments"]
        .as_array()
        .ok_or("CANCELLATION_PAYMENT_CHANGED")?;
    let mut statement=conn.prepare("SELECT remote_payment_id,method,status,currency,COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER)),id FROM order_payments WHERE order_id=?1 AND status IN ('completed','refunded')").map_err(|e|e.to_string())?;
    let local = statement
        .query_map([order], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if canonical
        .iter()
        .filter(|p| matches!(p["status"].as_str(), Some("completed" | "refunded")))
        .count()
        != local.len()
    {
        return Err("CANCELLATION_PAYMENT_CHANGED".into());
    }
    for (id, method, status, currency, cents, local_id) in local {
        let p = canonical
            .iter()
            .find(|p| p["id"] == id)
            .ok_or("CANCELLATION_PAYMENT_CHANGED")?;
        if p["order_id"] != remote
            || p["organization_id"] != scope.organization_id
            || p["branch_id"] != scope.branch_id
            || p["payment_method"] != method
            || p["status"] != status
            || p["currency"] != currency
            || amount(p)? != cents
        {
            return Err("CANCELLATION_PAYMENT_CHANGED".into());
        }
        let handback = plan["cashReturns"].as_array().and_then(|rows| {
            rows.iter()
                .find(|source| source["canonicalPaymentId"] == id)
        });
        let returning = plan["payments"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|portion| portion["paymentId"] == local_id));
        if (returning || handback.is_some()) && !canonical_manual_receipt(p) {
            return Err("ORIGINAL_PROVIDER_RETURN_REQUIRED".into());
        }
        if let Some(source) = handback.filter(|source| source["source_role"] == "server") {
            // The server uses the original receipt collector, never the order's
            // mutable updated_by or its current assigned waiter.
            for (column, alias, source_key) in [
                ("staff_id", "staffId", "source_staff_id"),
                ("staff_shift_id", "staffShiftId", "source_staff_shift_id"),
            ] {
                let collector = [&p[column], &p["metadata"][column], &p["metadata"][alias]]
                    .into_iter()
                    .find(|value| !value.is_null());
                if collector.is_none_or(|value| value != &source[source_key]) {
                    return Err("STAFF_CASH_CUSTODY_AMBIGUOUS".into());
                }
            }
        }
        let local_return:i64=conn.query_row("SELECT COALESCE(SUM(COALESCE(a.amount_cents,CAST(ROUND(a.amount*100) AS INTEGER))),0) FROM payment_adjustments a JOIN order_payments p ON p.id=a.payment_id WHERE p.order_id=?1 AND p.remote_payment_id=?2 AND a.adjustment_type IN ('refund','void')",params![order,id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let remote_return = data["adjustments"]
            .as_array()
            .ok_or("CANCELLATION_PAYMENT_CHANGED")?
            .iter()
            .filter(|a| {
                a["payment_id"] == id
                    && matches!(a["adjustment_type"].as_str(), Some("refund" | "void"))
            })
            .try_fold(0_i64, |sum, a| Ok::<_, String>(sum + amount(a)?))?;
        if local_return != remote_return {
            return Err("CANCELLATION_PAYMENT_CHANGED".into());
        }
    }
    let remote_handbacks = data["staff_cash_returns"]
        .as_array()
        .ok_or("CANCELLATION_PAYMENT_CHANGED")?
        .iter()
        .try_fold(0_i64, |sum, a| Ok::<_, String>(sum + amount(a)?))?;
    if remote_handbacks != crate::staff_cash_returns::sum(conn, Some(order), None)? {
        return Err("CANCELLATION_PAYMENT_CHANGED".into());
    }
    create_tables(conn)?;
    conn.execute("INSERT INTO table_manual_cancel_preflights_v1(organization_id,branch_id,terminal_id,order_id,session_id) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(organization_id,branch_id,terminal_id,order_id) DO UPDATE SET session_id=excluded.session_id",params![scope.organization_id,scope.branch_id,scope.terminal_id,order,session]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(crate) fn receiver(conn: &Connection, currency: &str) -> Result<(String, String), String> {
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let (shift, cashier) = crate::sync::require_active_cashier_for_order_create(
        conn,
        &scope.branch_id,
        &scope.terminal_id,
    )?;
    if crate::shifts::require_operating_currency(conn, &scope.branch_id)? != currency {
        return Err("PAYMENT_CURRENCY_MISMATCH".into());
    }
    let unit: Option<String> = conn
        .query_row(
            "SELECT currency FROM staff_shifts WHERE id=?1",
            [&shift],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if unit.as_deref() != Some(currency) {
        return Err("SHIFT_CURRENCY_UNAVAILABLE".into());
    }
    let mut s=conn.prepare("SELECT d.id FROM cash_drawer_sessions d JOIN staff_shifts s ON s.id=d.staff_shift_id WHERE d.staff_shift_id=?1 AND d.cashier_id=?2 AND d.branch_id=?3 AND d.terminal_id=s.terminal_id AND d.currency=?4 AND d.closed_at IS NULL").map_err(|e|e.to_string())?;
    let rows = s
        .query_map(params![shift, cashier, scope.branch_id, currency], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if rows.len() != 1 {
        return Err("CASHIER_DRAWER_UNAVAILABLE".into());
    }
    Ok((shift, rows[0].clone()))
}
pub(crate) fn original(conn: &Connection, event: &str) -> Result<Option<Value>, String> {
    if !exists(conn)? {
        return Ok(None);
    }
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let raw:Option<String>=conn.query_row("SELECT request_json FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND event_id=?4",params![scope.organization_id,scope.branch_id,scope.terminal_id,event],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
}
pub(crate) fn freeze(
    conn: &Connection,
    order: &str,
    session: &str,
    event: &str,
    reason: &str,
    actor: &str,
    input: &Value,
    evidence: &crate::manual_order_cancellation::ReturnEvidence,
) -> Result<Value, String> {
    schema(conn)?;
    uuid::Uuid::parse_str(event).map_err(|_| "CANCELLATION_REQUEST_CONFLICT")?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let generation = text(input, "generation")?;
    let channel = text(input, "returnChannel")?;
    if !matches!(channel, "cash_drawer" | "bank") {
        return Err("RETURN_CHANNEL_REQUIRED".into());
    }
    if let Some(prior) = original(conn, event)? {
        let matches:bool=conn.query_row("SELECT order_id=?1 AND session_id=?2 AND generation=?3 AND channel=?4 AND reason=?5 AND actor=?6 FROM table_manual_cancel_intents_v1 WHERE organization_id=?7 AND branch_id=?8 AND terminal_id=?9 AND event_id=?10",params![order,session,generation,channel,reason,actor,scope.organization_id,scope.branch_id,scope.terminal_id,event],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !matches {
            return Err("CANCELLATION_REQUEST_CONFLICT".into());
        }
        return Ok(prior);
    }
    crate::commands::orders::validate_table_manual_cancel_target(conn, order, session)?;
    let plan = crate::manual_order_cancellation::prepare_validated(conn, order, evidence)?;
    if plan["generation"] != generation
        || (plan["requiresReturn"] != true && plan["requiresHandback"] != true)
    {
        return Err("CANCELLATION_PAYMENT_CHANGED".into());
    }
    // A refused attempt of this order stays until a manager clears it; an
    // attempt whose outcome may be unknown anywhere in the branch is resumed
    // first. A proven refusal elsewhere does not hold this check.
    if unreleased_orders(conn, &scope.branch_id)?
        .iter()
        .any(|id| id == order)
    {
        return Err(format!("{REFUSED}: clear the refused cancellation first"));
    }
    if !unresolved_orders(conn, &scope.branch_id)?.is_empty() {
        return Err("TABLE_CANCELLATION_PENDING".into());
    }
    let currency = text(&plan, "currency")?;
    let (cashier, drawer) = receiver(conn, currency)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut handbacks = Vec::new();
    for source in plan["cashReturns"]
        .as_array()
        .ok_or("STAFF_CASH_CUSTODY_INVALID")?
    {
        handbacks.push(json!({"id":uuid::Uuid::new_v4().to_string(),"idempotency_key":format!("table-cancel:{event}:cash-return:{}",source["paymentId"].as_str().unwrap_or_default()),"payment_id":source["canonicalPaymentId"],"source_staff_id":source["source_staff_id"],"source_staff_shift_id":source["source_staff_shift_id"],"source_role":source["source_role"],"receiving_cashier_shift_id":cashier,"receiving_drawer_id":drawer,"amount_cents":source["amount_cents"],"currency":currency,"cancellation_event_id":event,"occurred_at":now}));
    }
    let mut refunds = Vec::new();
    for portion in plan["payments"]
        .as_array()
        .ok_or("PAYMENT_BALANCE_INVALID")?
    {
        let payment = text(portion, "paymentId")?;
        let remote: String = conn
            .query_row(
                "SELECT remote_payment_id FROM order_payments WHERE id=?1 AND order_id=?2",
                params![payment, order],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut refund = json!({"adjustment_id":uuid::Uuid::new_v4().to_string(),"payment_id":remote,"amount_cents":portion["amountCents"],"idempotency_key":format!("table-cancel:{event}:refund:{payment}")});
        if let Some(index) = handbacks.iter().position(|h| h["payment_id"] == remote) {
            let mut h = handbacks.remove(index);
            h.as_object_mut().unwrap().remove("payment_id");
            refund["staff_cash_return"] = h;
        }
        refunds.push(refund);
    }
    let mut request = json!({"action":"whole_order_cancel","client_event_id":event,"cancellation_reason":reason,"approved_staff_id":actor});
    if !refunds.is_empty() {
        request["manual_refund"] = json!({"version":1,"currency":currency,"refund_method":if channel=="cash_drawer"{"cash"}else{"card"},"cashier_shift_id":cashier,"drawer_id":drawer,"occurred_at":now,"refunds":refunds});
    }
    if !handbacks.is_empty() {
        request["staff_cash_returns"] = json!(handbacks);
    }
    conn.execute("INSERT INTO table_manual_cancel_intents_v1(organization_id,branch_id,terminal_id,event_id,order_id,session_id,generation,channel,reason,actor,request_json,created_at,dispatch_count) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0)",params![scope.organization_id,scope.branch_id,scope.terminal_id,event,order,session,generation,channel,reason,actor,request.to_string(),now]).map_err(|e|e.to_string())?;
    Ok(request)
}
/// The saved, not yet applied cancellation of this order: a pending one is
/// resumed with its original reason and channel; a refused one (`refused`)
/// sends nothing more and waits for a manager to clear it.
pub(crate) fn pending_plan(conn: &Connection, raw: &str) -> Result<Option<Value>, String> {
    if !exists(conn)? {
        return Ok(None);
    }
    schema(conn)?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    #[allow(clippy::type_complexity)]
    let row:Option<(String,String,String,String,String,String,String,Option<String>,Option<String>)>=conn.query_row("SELECT i.event_id,i.order_id,i.session_id,i.generation,i.channel,i.reason,i.request_json,i.outcome,i.refusal_code FROM table_manual_cancel_intents_v1 i JOIN orders o ON o.id=i.order_id WHERE i.organization_id=?1 AND i.branch_id=?2 AND i.terminal_id=?3 AND i.applied=0 AND COALESCE(i.outcome,'')<>'released' AND (o.id=?4 OR o.supabase_id=?4) ORDER BY i.created_at DESC LIMIT 1",params![scope.organization_id,scope.branch_id,scope.terminal_id,raw],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))).optional().map_err(|e|e.to_string())?;
    row.map(|(event,order,session,generation,channel,reason,raw,outcome,refusal)|{
        let request:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        let refunds=request.pointer("/manual_refund/refunds").and_then(Value::as_array).cloned().unwrap_or_default();
        let cents=refunds.iter().try_fold(0_i64,|sum,r|Ok::<_,String>(sum+amount(r)?))?;
        let has_handback=request["staff_cash_returns"].as_array().is_some_and(|a|!a.is_empty())||refunds.iter().any(|r|r.get("staff_cash_return").is_some());
        let currency=request.pointer("/manual_refund/currency").or_else(||request.pointer("/staff_cash_returns/0/currency")).cloned().ok_or("PAYMENT_CURRENCY_UNAVAILABLE")?;
        let refused=outcome.as_deref()==Some("refused");
        Ok(json!({"success":true,"orderId":order,"tableSessionId":session,"generation":generation,"requestId":event,"requiresReturn":cents>0,"requiresHandback":has_handback,"amountCents":cents,"currency":currency,"pending":true,"refused":refused,"refusalCode":refusal,"reason":reason,"returnChannel":channel}))
    }).transpose()
}
fn orders_where(conn: &Connection, branch: &str, condition: &str) -> Result<Vec<String>, String> {
    if !exists(conn)? {
        return Ok(vec![]);
    }
    // These holds are read inside other writers' transactions and statements
    // (refunds, Z readiness): never migrate here. Before the refusal columns
    // exist, every saved intent is unresolved.
    let tracked: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('table_manual_cancel_intents_v1') WHERE name='outcome')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let condition = if tracked { condition } else { "1=1" };
    let mut s = conn
        .prepare(&format!("SELECT DISTINCT order_id FROM table_manual_cancel_intents_v1 WHERE applied=0 AND {condition} AND (?1='' OR branch_id=?1)"))
        .map_err(|e| e.to_string())?;
    let rows = s
        .query_map([branch], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}
/// Orders whose saved table cancellation is not applied and not cleared:
/// they hold that order's other money actions and the Z. A proven refusal
/// stays here until a manager clears it with an audit entry.
pub(crate) fn pending(conn: &Connection, branch: &str) -> Result<Vec<String>, String> {
    unreleased_orders(conn, branch)
}
fn unreleased_orders(conn: &Connection, branch: &str) -> Result<Vec<String>, String> {
    orders_where(conn, branch, "COALESCE(outcome,'')<>'released'")
}
/// Orders whose saved table cancellation may still have applied on the
/// server (no proven outcome yet).
fn unresolved_orders(conn: &Connection, branch: &str) -> Result<Vec<String>, String> {
    orders_where(conn, branch, "outcome IS NULL")
}
/// Orders held only by a proven refusal (no attempt whose outcome may still
/// be unknown): nothing was returned or cancelled, and a manager clears it
/// before a new attempt. The Z names them so, not as awaiting a receipt.
pub(crate) fn refused_only(conn: &Connection, branch: &str) -> Result<Vec<String>, String> {
    let unresolved: std::collections::BTreeSet<String> =
        unresolved_orders(conn, branch)?.into_iter().collect();
    Ok(orders_where(conn, branch, "outcome='refused'")?
        .into_iter()
        .filter(|order| !unresolved.contains(order))
        .collect())
}

/// The money state of one cancellation event, for the approver lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventMoneyState {
    /// No financial intent: a reason-only cancellation.
    None,
    /// A frozen return whose server outcome may still be unknown.
    Unresolved,
    /// A proven refusal (cleared or not): it never applied money.
    Refused,
    Applied,
}

pub(crate) fn event_money_state(
    conn: &Connection,
    organization: &str,
    branch: &str,
    event: &str,
) -> Result<EventMoneyState, String> {
    if !exists(conn)? {
        return Ok(EventMoneyState::None);
    }
    schema(conn)?;
    // Event identities are UUIDs minted by this till: unique in the branch.
    let row: Option<(bool, Option<String>)> = conn
        .query_row(
            "SELECT applied,outcome FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND event_id=?3 ORDER BY applied DESC LIMIT 1",
            params![organization, branch, event],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match row {
        None => EventMoneyState::None,
        Some((true, _)) => EventMoneyState::Applied,
        Some((false, Some(_))) => EventMoneyState::Refused,
        Some((false, None)) => EventMoneyState::Unresolved,
    })
}

/// Record, before the server is asked to apply `event`, that an apply request
/// is about to leave this till. Only an intent without a proven outcome may
/// be sent. `Ok(None)`: the event has no financial intent (reason only).
/// Otherwise the apply-request count including this one (`Some(None)` for an
/// intent saved before tracking existed).
pub(crate) fn mark_dispatch(conn: &Connection, event: &str) -> Result<Option<Option<i64>>, String> {
    if !exists(conn)? {
        return Ok(None);
    }
    schema(conn)?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let state: Option<(bool, Option<String>)> = conn
        .query_row(
            "SELECT applied,outcome FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND event_id=?4",
            params![scope.organization_id, scope.branch_id, scope.terminal_id, event],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match state {
        None => return Ok(None),
        Some((false, None)) => {}
        Some(_) => {
            return Err(format!(
                "{REFUSED}: this cancellation was refused and is no longer sent"
            ))
        }
    }
    conn.execute(
        "UPDATE table_manual_cancel_intents_v1 SET dispatch_count=CASE WHEN dispatch_count IS NULL THEN NULL ELSE dispatch_count+1 END,last_dispatch_at=?1
         WHERE organization_id=?2 AND branch_id=?3 AND terminal_id=?4 AND event_id=?5 AND applied=0 AND outcome IS NULL",
        params![chrono::Utc::now().to_rfc3339(), scope.organization_id, scope.branch_id, scope.terminal_id, event],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT dispatch_count FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND event_id=?4",
        params![scope.organization_id, scope.branch_id, scope.terminal_id, event],
        |r| r.get::<_, Option<i64>>(0),
    )
    .map(|count| Some(count))
    .map_err(|e| e.to_string())
}

/// What proves that a saved cancellation never applied money.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RefusalProof {
    /// The server refused the approval and no apply request was ever sent.
    ApprovalRefused,
    /// The first and only apply request was definitively refused.
    ApplyRefused,
    /// The server reports the event uncommitted after every approval its
    /// apply requests could carry expired (`last_dispatch_at` as checked).
    ExpiredUncommitted { last_dispatch_at: Option<String> },
    /// No apply request was ever sent for it.
    NeverSent,
}

impl RefusalProof {
    fn code(&self) -> &'static str {
        match self {
            Self::ApprovalRefused => "approval_refused",
            Self::ApplyRefused => "apply_refused",
            Self::ExpiredUncommitted { .. } => "expired_uncommitted",
            Self::NeverSent => "never_sent",
        }
    }
}

/// Make a proven server refusal terminal: the intent is never sent again and
/// stays until a manager clears it. Returns whether the proof held; an intent
/// whose outcome cannot be proven keeps its pending state.
pub(crate) fn mark_refused(
    conn: &Connection,
    event: &str,
    proof: &RefusalProof,
    server_code: &str,
) -> Result<bool, String> {
    if !exists(conn)? {
        return Ok(false);
    }
    schema(conn)?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let row: Option<(bool, Option<String>, Option<i64>, Option<String>)> = conn
        .query_row(
            "SELECT applied,outcome,dispatch_count,last_dispatch_at FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND event_id=?4",
            params![scope.organization_id, scope.branch_id, scope.terminal_id, event],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((applied, outcome, dispatches, last_dispatch_at)) = row else {
        return Ok(false);
    };
    if applied {
        return Ok(false);
    }
    if outcome.is_some() {
        return Ok(true);
    }
    let proven = match proof {
        RefusalProof::ApprovalRefused | RefusalProof::NeverSent => dispatches == Some(0),
        RefusalProof::ApplyRefused => dispatches == Some(1),
        RefusalProof::ExpiredUncommitted {
            last_dispatch_at: checked,
        } => {
            checked == &last_dispatch_at
                && last_dispatch_at
                    .as_deref()
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                    .is_some_and(|at| {
                        chrono::Utc::now().signed_duration_since(at)
                            >= chrono::Duration::minutes(APPROVAL_EXPIRY_MARGIN_MINUTES)
                    })
        }
    };
    if !proven {
        return Ok(false);
    }
    let code = format!(
        "{}:{}",
        proof.code(),
        server_code.chars().take(120).collect::<String>()
    );
    let changed = conn
        .execute(
            "UPDATE table_manual_cancel_intents_v1 SET outcome='refused',refusal_code=?1,resolved_at=?2
             WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND event_id=?6 AND applied=0 AND outcome IS NULL
               AND dispatch_count IS ?7 AND last_dispatch_at IS ?8",
            params![code, chrono::Utc::now().to_rfc3339(), scope.organization_id, scope.branch_id, scope.terminal_id, event, dispatches, last_dispatch_at],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed == 1)
}

/// Whether a manager may clear the saved cancellation `event` of `order` now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReleaseCheck {
    /// Its refusal is proven; it can be cleared.
    Proven,
    /// No apply request was ever sent for it: it cannot have applied.
    NeverSent,
    /// Its outcome is unknown, but every approval its apply requests could
    /// carry has expired: one fresh server read that it is uncommitted proves it.
    ServerReadRequired {
        session: String,
        actor: String,
        last_dispatch_at: Option<String>,
    },
}

pub(crate) fn release_check(
    conn: &Connection,
    order: &str,
    event: &str,
) -> Result<ReleaseCheck, String> {
    if !exists(conn)? {
        return Err("TABLE_CANCELLATION_ORIGINAL_REQUIRED".into());
    }
    schema(conn)?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, bool, Option<String>, Option<i64>, Option<String>)> = conn
        .query_row(
            "SELECT order_id,session_id,actor,applied,outcome,dispatch_count,last_dispatch_at FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND event_id=?4",
            params![scope.organization_id, scope.branch_id, scope.terminal_id, event],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (owner, session, actor, applied, outcome, dispatches, last_dispatch_at) =
        row.ok_or("TABLE_CANCELLATION_ORIGINAL_REQUIRED")?;
    if owner != order {
        return Err("CANCELLATION_REQUEST_CONFLICT".into());
    }
    if applied {
        return Err("TABLE_CANCELLATION_ALREADY_APPLIED".into());
    }
    match outcome.as_deref() {
        Some("refused") => return Ok(ReleaseCheck::Proven),
        Some(_) => return Err("TABLE_CANCELLATION_ALREADY_CLEARED".into()),
        None => {}
    }
    if dispatches == Some(0) {
        return Ok(ReleaseCheck::NeverSent);
    }
    let waited = last_dispatch_at
        .as_deref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| chrono::Utc::now().signed_duration_since(at));
    match waited {
        Some(elapsed) if elapsed >= chrono::Duration::minutes(APPROVAL_EXPIRY_MARGIN_MINUTES) => {
            Ok(ReleaseCheck::ServerReadRequired {
                session,
                actor,
                last_dispatch_at,
            })
        }
        Some(elapsed) => Err(format!(
            "TABLE_CANCELLATION_RELEASE_WAIT:{}",
            (APPROVAL_EXPIRY_MARGIN_MINUTES - elapsed.num_minutes()).max(1)
        )),
        None => Err("TABLE_CANCELLATION_PENDING".into()),
    }
}

/// A manager clears a proven-refused cancellation (review 06/10/2026). The
/// audit entry keeps the frozen request, the proof and who cleared it; the
/// original refund identities stay retained and are never reused. Never
/// clears an intent whose server outcome may still apply money: an intent
/// without a recorded refusal is first proven by `proof` (never sent, or
/// uncommitted after expiry as read from the server).
pub(crate) fn release(
    conn: &Connection,
    order: &str,
    event: &str,
    released_by: &str,
    note: &str,
    proof: Option<&RefusalProof>,
) -> Result<Value, String> {
    match release_check(conn, order, event)? {
        ReleaseCheck::Proven => {}
        ReleaseCheck::NeverSent | ReleaseCheck::ServerReadRequired { .. } => {
            let proven = match proof {
                Some(proof) => mark_refused(conn, event, proof, "cleared_by_manager")?,
                None => false,
            };
            if !proven {
                return Err("TABLE_CANCELLATION_PENDING".into());
            }
        }
    }
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let before: String = conn
        .query_row(
            "SELECT json_object('event_id',event_id,'order_id',order_id,'session_id',session_id,'generation',generation,'channel',channel,'reason',reason,'actor',actor,'request',json(request_json),'applied',applied,'created_at',created_at,'dispatch_count',dispatch_count,'last_dispatch_at',last_dispatch_at,'outcome',outcome,'refusal_code',refusal_code,'resolved_at',resolved_at)
             FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND event_id=?4",
            params![scope.organization_id, scope.branch_id, scope.terminal_id, event],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let audit = json!({"organizationId":scope.organization_id,"branchId":scope.branch_id,"terminalId":scope.terminal_id,
        "orderId":order,"clientEventId":event,"releasedBy":released_by,"note":note,"releasedAt":now,
        "before":serde_json::from_str::<Value>(&before).map_err(|e|e.to_string())?,"charged":false,"moneyMoved":false});
    let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE table_manual_cancel_intents_v1 SET outcome='released',resolved_at=?1,resolved_by=?2
             WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND event_id=?6 AND applied=0 AND outcome='refused'",
            params![now, released_by, scope.organization_id, scope.branch_id, scope.terminal_id, event],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("TABLE_CANCELLATION_PENDING".into());
    }
    transaction
        .execute(
            "INSERT INTO recovery_action_log(id,action_id,issue_code,entity_type,entity_id,order_id,success,message,actor_staff_id,payload_json,created_at)
             VALUES(?1,?2,'TABLE_CANCELLATION_REFUSED','order',?3,?3,1,?4,?5,?6,?7)",
            params![format!("table-cancel-release:{event}"), RELEASE_ACTION, order,
                "A manager cleared a refused table cancellation; no money was returned", released_by, audit.to_string(), now],
        )
        .map_err(|e| e.to_string())?;
    // The crash-recovery owner only reads this event's server receipt; a
    // proven refusal has none to read. Retire its row so the till stops
    // reporting a cancellation waiting for approval.
    let recovery: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='table_attempt_recovery_v1')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if recovery {
        transaction
            .execute(
                "UPDATE table_attempt_recovery_v1 SET status='applied',last_error_code='TABLE_CANCELLATION_RELEASED',next_retry_at=NULL,lease_until=NULL,updated_at=?1
                 WHERE organization_id=?2 AND branch_id=?3 AND terminal_id=?4 AND kind='whole_order_cancel' AND client_event_id=?5",
                params![now, scope.organization_id, scope.branch_id, scope.terminal_id, event],
            )
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(json!({"success":true,"released":true,"orderId":order,"clientEventId":event}))
}
fn same_fields(expected: &Value, actual: &Value, fields: &[&str]) -> Result<(), String> {
    for key in fields {
        if expected[*key] != actual[*key] {
            return Err(format!("TABLE_CANCELLATION_RECEIPT_MISMATCH:{key}"));
        }
    }
    Ok(())
}
/// Called inside the canonical-response savepoint. All validation precedes writes;
/// any caller failure rolls the entire parent, receipts, and drawer projection back.
pub(crate) fn mirror(conn: &Connection, response: &Value) -> Result<(), String> {
    let Some(result) = response.pointer("/workflow/manual_cancellation") else {
        return Ok(());
    };
    create_tables(conn)?;
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let mut s=conn.prepare("SELECT event_id,order_id,request_json,applied FROM table_manual_cancel_intents_v1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3").map_err(|e|e.to_string())?;
    let intents = s
        .query_map(
            params![scope.organization_id, scope.branch_id, scope.terminal_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let adjustments = result["payment_adjustments"]
        .as_array()
        .ok_or("TABLE_CANCELLATION_RECEIPT_INVALID")?;
    let handbacks = result["staff_cash_returns"]
        .as_array()
        .ok_or("TABLE_CANCELLATION_RECEIPT_INVALID")?;
    let mut selected = None;
    for (event, order, raw, applied) in intents {
        let request: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let refunds = request
            .pointer("/manual_refund/refunds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut expected_handbacks = request["staff_cash_returns"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for refund in &refunds {
            if let Some(h) = refund.get("staff_cash_return") {
                let mut h = h.clone();
                h["payment_id"] = refund["payment_id"].clone();
                expected_handbacks.push(h);
            }
        }
        if refunds.len() == adjustments.len()
            && expected_handbacks.len() == handbacks.len()
            && refunds
                .iter()
                .all(|r| adjustments.iter().any(|a| a["id"] == r["adjustment_id"]))
            && expected_handbacks
                .iter()
                .all(|h| handbacks.iter().any(|a| a["id"] == h["id"]))
        {
            if selected.is_some() {
                return Err("TABLE_CANCELLATION_RECEIPT_AMBIGUOUS".into());
            }
            selected = Some((event, order, request, applied, refunds, expected_handbacks));
        }
    }
    let (event, order, request, applied, refunds, expected_handbacks) =
        selected.ok_or("TABLE_CANCELLATION_ORIGINAL_REQUIRED")?;
    let remote = canonical_order(conn, &order)?;
    let unit = request
        .pointer("/manual_refund/currency")
        .or_else(|| expected_handbacks.first().map(|h| &h["currency"]))
        .and_then(Value::as_str)
        .ok_or("PAYMENT_CURRENCY_UNAVAILABLE")?;
    for a in adjustments.iter().chain(handbacks.iter()) {
        if a["organization_id"] != scope.organization_id
            || a["branch_id"] != scope.branch_id
            || a["order_id"] != remote
            || a["reason"] != request["cancellation_reason"]
        {
            return Err("TABLE_CANCELLATION_RECEIPT_MISMATCH".into());
        }
    }
    for expected in &refunds {
        let a = adjustments
            .iter()
            .find(|a| a["id"] == expected["adjustment_id"])
            .unwrap();
        same_fields(
            expected,
            a,
            &["payment_id", "amount_cents", "idempotency_key"],
        )?;
        if a["adjustment_type"] != "refund"
            || a["staff_shift_id"] != request["manual_refund"]["cashier_shift_id"]
            || a["refund_method"] != request["manual_refund"]["refund_method"]
            || a["cash_handler"] != "cashier_drawer"
            || a["staff_id"] != request["approved_staff_id"]
        {
            return Err("TABLE_CANCELLATION_RECEIPT_MISMATCH".into());
        }
    }
    for h in &expected_handbacks {
        let a = handbacks.iter().find(|a| a["id"] == h["id"]).unwrap();
        same_fields(
            h,
            a,
            &[
                "id",
                "payment_id",
                "idempotency_key",
                "source_staff_id",
                "source_staff_shift_id",
                "source_role",
                "receiving_cashier_shift_id",
                "receiving_drawer_id",
                "amount_cents",
                "currency",
                "cancellation_event_id",
            ],
        )?;
    }
    if applied {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut shifts = std::collections::BTreeSet::new();
    for a in adjustments {
        let payment:String=conn.query_row("SELECT id FROM order_payments WHERE order_id=?1 AND remote_payment_id=?2 AND currency=?3",params![order,text(a,"payment_id")?,unit],|r|r.get(0)).map_err(|e|e.to_string())?;
        let cents = amount(a)?;
        let inserted=conn.execute("INSERT OR IGNORE INTO payment_adjustments(id,payment_id,order_id,adjustment_type,amount,amount_cents,reason,staff_id,staff_shift_id,sync_state,refund_method,cash_handler,adjustment_context,idempotency_key,created_at,updated_at) VALUES(?1,?2,?3,'refund',?4,?5,?6,?7,?8,'applied',?9,'cashier_drawer','manual',?10,?11,?11)",params![text(a,"id")?,payment,order,Cents::new(cents).to_f64_dp2(),cents,request["cancellation_reason"].as_str(),a["staff_id"].as_str(),a["staff_shift_id"].as_str(),a["refund_method"].as_str(),a["idempotency_key"].as_str(),now]).map_err(|e|e.to_string())?;
        if inserted != 1 {
            return Err("TABLE_CANCELLATION_RECEIPT_ALREADY_EXISTS".into());
        }
        if a["refund_method"] == "cash" {
            let updated=conn.execute("UPDATE cash_drawer_sessions SET total_refunds=COALESCE(total_refunds,0)+?1,total_refunds_cents=COALESCE(total_refunds_cents,CAST(ROUND(total_refunds*100) AS INTEGER),0)+?2,updated_at=?3 WHERE id=?4 AND staff_shift_id=?5 AND closed_at IS NULL",params![Cents::new(cents).to_f64_dp2(),cents,now,request["manual_refund"]["drawer_id"].as_str(),a["staff_shift_id"].as_str()]).map_err(|e|e.to_string())?;
            if updated != 1 {
                return Err("CASHIER_DRAWER_UNAVAILABLE".into());
            }
        }
        conn.execute("UPDATE order_payments SET status='refunded',updated_at=?1 WHERE id=?2 AND COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER))=(SELECT SUM(amount_cents) FROM payment_adjustments WHERE payment_id=?2 AND adjustment_type='refund')",params![now,payment]).map_err(|e|e.to_string())?;
        shifts.insert(text(a, "staff_shift_id")?.to_string());
    }
    for a in handbacks {
        let payment:String=conn.query_row("SELECT id FROM order_payments WHERE order_id=?1 AND remote_payment_id=?2 AND currency=?3",params![order,text(a,"payment_id")?,unit],|r|r.get(0)).map_err(|e|e.to_string())?;
        let cents = amount(a)?;
        conn.execute("INSERT INTO staff_order_cash_returns(id,organization_id,branch_id,terminal_id,order_id,payment_id,source_staff_id,source_staff_shift_id,source_role,receiving_cashier_shift_id,receiving_drawer_id,amount_cents,currency,cancellation_event_id,actor_staff_id,reason,occurred_at,idempotency_key,payload_json,sync_status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'synced')",params![text(a,"id")?,scope.organization_id,scope.branch_id,scope.terminal_id,order,payment,a["source_staff_id"].as_str(),a["source_staff_shift_id"].as_str(),a["source_role"].as_str(),a["receiving_cashier_shift_id"].as_str(),a["receiving_drawer_id"].as_str(),cents,unit,event,request["approved_staff_id"].as_str(),request["cancellation_reason"].as_str(),a["occurred_at"].as_str(),a["idempotency_key"].as_str(),a.to_string()]).map_err(|e|e.to_string())?;
        let updated=conn.execute("UPDATE cash_drawer_sessions SET driver_cash_returned=COALESCE(driver_cash_returned,0)+?1,driver_cash_returned_cents=COALESCE(driver_cash_returned_cents,CAST(ROUND(driver_cash_returned*100) AS INTEGER),0)+?2,updated_at=?3 WHERE id=?4 AND staff_shift_id=?5 AND closed_at IS NULL",params![Cents::new(cents).to_f64_dp2(),cents,now,a["receiving_drawer_id"].as_str(),a["receiving_cashier_shift_id"].as_str()]).map_err(|e|e.to_string())?;
        if updated != 1 {
            return Err("CASHIER_DRAWER_UNAVAILABLE".into());
        }
        shifts.insert(text(a, "receiving_cashier_shift_id")?.to_string());
    }
    for shift in shifts {
        crate::shifts::replace_unfinished_shift_sync_rows_with_current_snapshot(
            conn, &shift, &now,
        )?;
    }
    conn.execute("UPDATE table_manual_cancel_intents_v1 SET applied=1 WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND event_id=?4",params![scope.organization_id,scope.branch_id,scope.terminal_id,event]).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    const SESSION: &str = "22222222-2222-4222-8222-222222222222";
    const EVENT: &str = "33333333-3333-4333-8333-333333333333";
    const ACTOR: &str = "44444444-4444-4444-8444-444444444444";
    fn fixture() -> Connection {
        let conn = crate::manual_order_cancellation::tests::setup();
        crate::manual_order_cancellation::tests::staff_custody_fixture(&conn, "server");
        conn.execute("UPDATE orders SET table_id='table',table_session_id=?1,order_type='dine-in',sync_status='synced'",[SESSION]).unwrap();
        conn
    }
    fn frozen(conn: &Connection, channel: &str) -> Value {
        let plan = crate::manual_order_cancellation::prepare_validated(
            conn,
            "order",
            &crate::manual_order_cancellation::tests::admitted(conn),
        )
        .unwrap();
        freeze(
            conn,
            "order",
            SESSION,
            EVENT,
            "Customer cancelled",
            ACTOR,
            &json!({"generation":plan["generation"],"returnChannel":channel}),
            &crate::manual_order_cancellation::tests::admitted(conn),
        )
        .unwrap()
    }
    fn response(conn: &Connection, request: &Value) -> Value {
        let mut refunds = vec![];
        let mut handbacks = vec![];
        for r in request["manual_refund"]["refunds"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let mut a = r.clone();
            a["id"] = a["adjustment_id"].clone();
            a["adjustment_type"] = json!("refund");
            a["refund_method"] = request["manual_refund"]["refund_method"].clone();
            a["cash_handler"] = json!("cashier_drawer");
            a["staff_shift_id"] = request["manual_refund"]["cashier_shift_id"].clone();
            a["staff_id"] = request["approved_staff_id"].clone();
            if let Some(h) = r.get("staff_cash_return") {
                let mut h = h.clone();
                h["payment_id"] = r["payment_id"].clone();
                handbacks.push(h);
            }
            refunds.push(a);
        }
        handbacks.extend(
            request["staff_cash_returns"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        for row in refunds.iter_mut().chain(handbacks.iter_mut()) {
            row["organization_id"] = json!("org");
            row["branch_id"] = json!("branch");
            row["order_id"] = json!(canonical_order(conn, "order").unwrap());
            row["reason"] = request["cancellation_reason"].clone();
        }
        json!({"workflow":{"manual_cancellation":{"payments":[],"payment_adjustments":refunds,"staff_cash_returns":handbacks}}})
    }

    fn preflight_snapshot(conn: &Connection) -> Value {
        let remote = canonical_order(conn, "order").unwrap();
        let mut statement = conn.prepare("SELECT remote_payment_id,method,status,currency,amount_cents,transaction_ref,staff_id,staff_shift_id FROM order_payments ORDER BY id").unwrap();
        let payments = statement.query_map([], |r| Ok(json!({
            "id":r.get::<_,String>(0)?,"payment_method":r.get::<_,String>(1)?,
            "status":r.get::<_,String>(2)?,"currency":r.get::<_,String>(3)?,
            "amount_cents":r.get::<_,i64>(4)?,"external_transaction_id":r.get::<_,Option<String>>(5)?,
            "staff_id":r.get::<_,Option<String>>(6)?,"staff_shift_id":r.get::<_,Option<String>>(7)?,
            "metadata":{"payment_origin":"manual"},
            "order_id":remote,"organization_id":"org","branch_id":"branch"
        }))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        json!({"data":{"table_manual_refund_version":1,
            "order":{"id":remote,"organization_id":"org","branch_id":"branch",
                "status":"delivered","total_amount":10.5,"table_session_id":SESSION},
            "payments":payments,"adjustments":[],"staff_cash_returns":[],
            "table_sessions":[{"id":SESSION,"active_order_id":remote,"status":"closed"}]}})
    }

    #[test]
    fn table_manual_cancellation_snapshot_refuses_canonical_provider_proof_before_picker() {
        let conn = fixture();
        let plan = crate::manual_order_cancellation::prepare_validated(
            &conn,
            "order",
            &crate::manual_order_cancellation::tests::admitted(&conn),
        )
        .unwrap();
        let original = preflight_snapshot(&conn);
        let mut patches = vec![];
        for key in [
            "provider",
            "terminal_device_id",
            "terminalDeviceId",
            "terminal_reference",
            "terminalReference",
            "ecr_terminal_reference",
            "ecrTerminalReference",
            "terminalTransactionId",
        ] {
            patches.push(json!({key:"provider-evidence"}));
        }
        for key in [
            "external_transaction_id",
            "externalTransactionId",
            "transaction_ref",
        ] {
            patches.push(json!({key:"provider-reference"}));
        }
        patches.extend([
            json!({"platform_held_tender":null}),
            json!({"terminal_processed":true}),
            json!({"terminalProcessed":"TRUE"}),
            json!({"paymentOrigin":"payment_terminal"}),
        ]);
        for index in 0..2 {
            for patch in &patches {
                let mut changed = original.clone();
                changed["data"]["payments"][index]["metadata"]
                    .as_object_mut()
                    .unwrap()
                    .extend(patch.as_object().unwrap().clone());
                assert_eq!(
                    validate_snapshot(&conn, &plan, SESSION, &changed).unwrap_err(),
                    "ORIGINAL_PROVIDER_RETURN_REQUIRED",
                    "{index}: {patch}"
                );
            }
            let mut changed = original.clone();
            changed["data"]["payments"][index]["external_transaction_id"] =
                json!("provider-reference");
            assert_eq!(
                validate_snapshot(&conn, &plan, SESSION, &changed).unwrap_err(),
                "ORIGINAL_PROVIDER_RETURN_REQUIRED"
            );
        }
        assert!(!original_session_proven(&conn, "order", SESSION).unwrap());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM payment_adjustments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            crate::staff_cash_returns::sum(&conn, Some("order"), None).unwrap(),
            0
        );
        validate_snapshot(&conn, &plan, SESSION, &original).unwrap();
    }

    #[test]
    fn table_manual_cancellation_snapshot_checks_canonical_waiter_collector_precedence() {
        let conn = fixture();
        let plan = crate::manual_order_cancellation::prepare_validated(
            &conn,
            "order",
            &crate::manual_order_cancellation::tests::admitted(&conn),
        )
        .unwrap();
        let original = preflight_snapshot(&conn);
        let index = original["data"]["payments"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| p["payment_method"] == "cash")
            .unwrap();
        for (column, alias, known) in [
            ("staff_id", "staffId", "worker"),
            ("staff_shift_id", "staffShiftId", "worker-shift"),
        ] {
            for value in [json!("different-collector"), Value::Null] {
                let mut changed = original.clone();
                changed["data"]["payments"][index][column] = value;
                assert_eq!(
                    validate_snapshot(&conn, &plan, SESSION, &changed).unwrap_err(),
                    "STAFF_CASH_CUSTODY_AMBIGUOUS"
                );
            }
            let mut changed = original.clone();
            changed["data"]["payments"][index][column] = json!("different-collector");
            changed["data"]["payments"][index]["metadata"][alias] = json!(known);
            assert_eq!(
                validate_snapshot(&conn, &plan, SESSION, &changed).unwrap_err(),
                "STAFF_CASH_CUSTODY_AMBIGUOUS"
            );
            for key in [column, alias] {
                let mut compatible = original.clone();
                compatible["data"]["payments"][index][column] = Value::Null;
                compatible["data"]["payments"][index]["metadata"][key] = json!(known);
                validate_snapshot(&conn, &plan, SESSION, &compatible).unwrap();
            }
        }
        validate_snapshot(&conn, &plan, SESSION, &original).unwrap();
    }

    #[test]
    fn table_manual_cancellation_snapshot_manual_reference_compatibility_is_explicit() {
        let conn = fixture();
        let plan = crate::manual_order_cancellation::prepare_validated(
            &conn,
            "order",
            &crate::manual_order_cancellation::tests::admitted(&conn),
        )
        .unwrap();
        let mut snapshot = preflight_snapshot(&conn);
        let index = snapshot["data"]["payments"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| p["payment_method"] == "card")
            .unwrap();
        snapshot["data"]["payments"][index]["metadata"] = Value::Null;
        validate_snapshot(&conn, &plan, SESSION, &snapshot).unwrap(); // Shipped legacy CASH reference.
        snapshot["data"]["payments"][index]["external_transaction_id"] =
            json!("CARD-1791226924826");
        assert_eq!(
            validate_snapshot(&conn, &plan, SESSION, &snapshot).unwrap_err(),
            "ORIGINAL_PROVIDER_RETURN_REQUIRED"
        );
        snapshot["data"]["payments"][index]["metadata"] = json!({"payment_origin":"manual"});
        validate_snapshot(&conn, &plan, SESSION, &snapshot).unwrap();
    }

    #[test]
    fn table_manual_cancellation_canonical_parent_and_refunds_apply_in_one_savepoint() {
        let conn = fixture();
        for (key, value) in [
            ("__ignore_keyring", "1"),
            ("owner_terminal_id", "terminal"),
            ("source_terminal_id", "terminal"),
            ("pos_operating_mode", "main_isolated"),
            ("terminal_type", "main"),
        ] {
            db::set_setting(&conn, "terminal", key, value).unwrap();
        }
        let request = frozen(&conn, "cash_drawer");
        let mut receipt = response(&conn, &request);
        receipt["cafe_lan_snapshot"] = json!({"orders":[{"id":canonical_order(&conn,"order").unwrap(),"organization_id":"org","branch_id":"branch","owner_terminal_id":"terminal","terminal_id":"terminal","source_terminal_id":"terminal","version":2,"order_number":"001","order_type":"dine-in","status":"cancelled","payment_status":"pending","total_amount":10.5,"subtotal":10.5,"tax_amount":0,"created_at":"2026-10-05T10:00:00Z","updated_at":"2026-10-05T19:00:00Z","table_id":null,"table_session_id":null,"order_items":[{"id":"55555555-5555-4555-8555-555555555555","quantity":1,"unit_price":10.5,"total_price":10.5,"name":"Meal"}]}],"sessions":[],"tables":[],"payments":[]});
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        crate::sync::apply_lan_canonical_response(&conn, "/api/pos/table-sessions", &receipt)
            .unwrap();
        conn.execute_batch("COMMIT").unwrap();
        assert_eq!(
            conn.query_row("SELECT status FROM orders WHERE id='order'", [], |r| r
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "cancelled"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM order_payments WHERE status='refunded'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        crate::sync::apply_lan_canonical_response(&conn, "/api/pos/table-sessions", &receipt)
            .unwrap();
        conn.execute_batch("COMMIT").unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT total_refunds_cents FROM cash_drawer_sessions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1050
        );
    }
    #[test]
    fn table_manual_cancellation_closed_session_history_and_pending_restart_keep_original() {
        let conn = fixture();
        let request = frozen(&conn, "bank");
        let pending = pending_plan(&conn, "order").unwrap().unwrap();
        assert_eq!(pending["requestId"], EVENT);
        assert_eq!(pending["returnChannel"], "bank");
        assert_eq!(pending["reason"], "Customer cancelled");
        assert_eq!(pending["amountCents"], 1050);
        assert_eq!(
            crate::edit_settlement_recovery::require_original_financial_attempt(
                &conn, "order", None
            )
            .unwrap_err(),
            "TABLE_CANCELLATION_PENDING"
        );
        let closed = json!({"data":{"order":{"id":canonical_order(&conn,"order").unwrap(),"table_session_id":null},"table_sessions":[{"id":SESSION,"status":"closed","active_order_id":canonical_order(&conn,"order").unwrap()}]}});
        assert_eq!(snapshot_session(&closed, None).unwrap(), SESSION);
        let mut reused = closed.clone();
        reused["data"]["table_sessions"][0]["active_order_id"] = json!("different-order");
        assert!(snapshot_session(&reused, None).is_err());
        assert_eq!(original(&conn, EVENT).unwrap(), Some(request));
    }
    #[test]
    fn table_manual_cancellation_freezes_exact_return_and_mirrors_once() {
        for channel in ["cash_drawer", "bank"] {
            let mut conn = fixture();
            let request = frozen(&conn, channel);
            let input = json!({"generation":crate::manual_order_cancellation::prepare_validated(&conn,"order",&crate::manual_order_cancellation::tests::admitted(&conn)).unwrap()["generation"],"returnChannel":channel});
            assert_eq!(
                freeze(
                    &conn,
                    "order",
                    SESSION,
                    EVENT,
                    "Customer cancelled",
                    ACTOR,
                    &input,
                    &crate::manual_order_cancellation::tests::admitted(&conn),
                )
                .unwrap(),
                request
            );
            assert_eq!(pending(&conn, "branch").unwrap(), vec!["order"]);
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM payment_adjustments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            let receipt = response(&conn, &request);
            let tx = conn.transaction().unwrap();
            mirror(&tx, &receipt).unwrap();
            tx.commit().unwrap();
            assert!(pending(&conn, "branch").unwrap().is_empty());
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM payment_adjustments", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                crate::staff_cash_returns::waiter_cash(&conn, "worker-shift", None).unwrap(),
                0
            );
            let balances:(i64,i64)=conn.query_row("SELECT driver_cash_returned_cents,total_refunds_cents FROM cash_drawer_sessions",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(
                balances,
                (450, if channel == "cash_drawer" { 1050 } else { 0 })
            );
            mirror(&conn, &receipt).unwrap();
            assert_eq!(conn.query_row("SELECT driver_cash_returned_cents,total_refunds_cents FROM cash_drawer_sessions",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).unwrap(),balances);
            assert!(freeze(
                &conn,
                "order",
                SESSION,
                EVENT,
                "Changed reason",
                ACTOR,
                &input,
                &crate::manual_order_cancellation::tests::admitted(&conn),
            )
            .is_err());
        }
    }
    #[test]
    fn table_manual_cancellation_mismatch_and_failed_projection_preserve_pending_original() {
        let mut conn = fixture();
        let request = frozen(&conn, "cash_drawer");
        let receipt = response(&conn, &request);
        let mut changed = receipt.clone();
        changed["workflow"]["manual_cancellation"]["payment_adjustments"][0]["amount_cents"] =
            json!(1);
        assert!(mirror(&conn, &changed).is_err());
        conn.execute_batch("CREATE TRIGGER block_drawer BEFORE UPDATE ON cash_drawer_sessions BEGIN SELECT RAISE(ABORT,'test projection failure');END;").unwrap();
        {
            let tx = conn.transaction().unwrap();
            assert!(mirror(&tx, &receipt).is_err());
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM payment_adjustments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(pending(&conn, "branch").unwrap(), vec!["order"]);
        assert_eq!(original(&conn, EVENT).unwrap(), Some(request));
    }
    #[test]
    fn table_manual_cancellation_refuses_foreign_scope_and_changed_cashier() {
        let conn = fixture();
        let request = frozen(&conn, "bank");
        let mut receipt = response(&conn, &request);
        receipt["workflow"]["manual_cancellation"]["staff_cash_returns"][0]
            ["receiving_drawer_id"] = json!("other");
        assert!(mirror(&conn, &receipt).is_err());
        db::set_setting(&conn, "terminal", "branch_id", "other").unwrap();
        assert!(original(&conn, EVENT).unwrap().is_none());
        assert!(mirror(&conn, &response(&conn, &request)).is_err());
    }
    #[test]
    fn table_manual_cancellation_no_money_preflight_and_legacy_receiver_are_explicit() {
        let conn = fixture();
        conn.execute_batch(
            "DELETE FROM order_payments;UPDATE orders SET payment_status='pending';",
        )
        .unwrap();
        let plan = crate::manual_order_cancellation::prepare_validated(
            &conn,
            "order",
            &crate::manual_order_cancellation::tests::admitted(&conn),
        )
        .unwrap();
        assert_eq!(plan["requiresReturn"], false);
        assert_eq!(plan["requiresHandback"], false);
        let legacy = crate::manual_order_cancellation::tests::setup();
        assert_eq!(
            receiver(&legacy, "EUR").unwrap_err(),
            "SHIFT_CURRENCY_UNAVAILABLE"
        );
    }

    // ---- Review 06/10/2026 -------------------------------------------------

    #[test]
    fn a_kiosk_eat_in_order_is_not_a_table_check_without_table_evidence() {
        // Symptom: every dine-in order was a table check, so a kiosk eat-in
        // order (no table) was refused with TABLE_CANCEL_SYNC_REQUIRED (offline
        // TABLE_MANUAL_CANCELLATION_UNAVAILABLE) and could not be cancelled.
        let conn = crate::manual_order_cancellation::tests::setup();
        conn.execute("UPDATE orders SET order_type='dine-in'", [])
            .unwrap();
        assert!(!is_table_candidate(&conn, "order").unwrap());
        // Its paid manual return follows the ordinary path.
        let id = crate::commands::orders::validate_manual_cancel_target(&conn, "order").unwrap();
        let plan = crate::manual_order_cancellation::prepare_validated(
            &conn,
            &id,
            &crate::manual_order_cancellation::tests::admitted(&conn),
        )
        .unwrap();
        assert_eq!(plan["amountCents"], 600);
        assert!(plan.get("tableSessionId").is_none());
        for (sql, table) in [
            ("UPDATE orders SET table_session_id='session'", true),
            ("UPDATE orders SET table_id='table'", true),
            ("UPDATE orders SET table_number='4'", true),
            (
                "UPDATE orders SET order_type='pickup',table_number='4'",
                false,
            ),
        ] {
            let conn = crate::manual_order_cancellation::tests::setup();
            conn.execute("UPDATE orders SET order_type='dine-in'", [])
                .unwrap();
            conn.execute_batch(sql).unwrap();
            assert_eq!(is_table_candidate(&conn, "order").unwrap(), table, "{sql}");
        }
        // Retained table-service history (a closed check) is table evidence.
        let conn = crate::manual_order_cancellation::tests::setup();
        conn.execute_batch(
            "UPDATE orders SET order_type='dine-in',supabase_id='727dfed5-af5b-4491-a258-41d8659a5ce4';
             CREATE TABLE IF NOT EXISTS table_order_history_v1 (organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,owner_terminal_id TEXT NOT NULL,
               order_id TEXT NOT NULL,PRIMARY KEY(organization_id,branch_id,owner_terminal_id,order_id));
             INSERT INTO table_order_history_v1 VALUES('org','branch','terminal','727dfed5-af5b-4491-a258-41d8659a5ce4');",
        )
        .unwrap();
        assert!(is_table_candidate(&conn, "order").unwrap());
    }

    fn intent_row(conn: &Connection) -> (Option<i64>, Option<String>, Option<String>) {
        conn.query_row(
            "SELECT dispatch_count,outcome,last_dispatch_at FROM table_manual_cancel_intents_v1 WHERE event_id=?1",
            [EVENT],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    /// Review 06/10/2026: the Z described every saved table cancellation as
    /// "awaiting its canonical receipt", also one the server had refused,
    /// which never gets one. A refusal is now told as such.
    #[test]
    fn the_z_names_a_refused_table_cancellation_as_refused() {
        let conn = fixture();
        frozen(&conn, "bank");
        let table_blocker = |conn: &Connection| {
            crate::payment_integrity::load_payments_not_saved_blockers(conn, "branch")
                .unwrap()
                .into_iter()
                .find(|blocker| blocker.reason_code == "table_cancellation_not_saved")
                .expect("the saved cancellation holds the Z")
        };
        assert_eq!(table_blocker(&conn).reason_variant, None);
        assert!(refused_only(&conn, "branch").unwrap().is_empty());

        assert!(mark_refused(&conn, EVENT, &RefusalProof::ApprovalRefused, "HTTP_403").unwrap());
        assert_eq!(refused_only(&conn, "branch").unwrap(), vec!["order"]);
        let refused = table_blocker(&conn);
        assert_eq!(refused.reason_variant.as_deref(), Some("refused"));
        assert!(
            refused.reason_text.contains("refused"),
            "{}",
            refused.reason_text
        );
        assert!(!refused.reason_text.contains("awaiting"));
    }

    #[test]
    fn a_refused_approval_before_any_apply_request_is_terminal_and_cleared_by_a_manager() {
        // Symptom: the table cancellation was saved before the server PIN
        // approval; when the server refused it the request could never be
        // abandoned and held the order's refunds and the Z for good.
        let conn = fixture();
        let request = frozen(&conn, "bank");
        assert_eq!(intent_row(&conn).0, Some(0));
        assert!(mark_refused(&conn, EVENT, &RefusalProof::ApprovalRefused, "HTTP_403").unwrap());
        let plan = pending_plan(&conn, "order").unwrap().unwrap();
        assert_eq!(
            (plan["pending"].clone(), plan["refused"].clone()),
            (json!(true), json!(true))
        );
        assert_eq!(plan["refusalCode"], "approval_refused:HTTP_403");
        // Terminal: never sent again, and it still holds the order and the Z
        // until a manager clears it.
        assert!(mark_dispatch(&conn, EVENT).unwrap_err().contains(REFUSED));
        assert_eq!(pending(&conn, "branch").unwrap(), vec!["order"]);
        assert_eq!(
            crate::edit_settlement_recovery::require_original_financial_attempt(
                &conn, "order", None
            )
            .unwrap_err(),
            "TABLE_CANCELLATION_PENDING"
        );
        crate::table_attempt_recovery::schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO table_attempt_recovery_v1(organization_id,branch_id,terminal_id,owner_terminal_id,kind,client_event_id,local_order_id,session_id,request_json,status,updated_at)
             VALUES('org','branch','terminal','terminal','whole_order_cancel',?1,'order',?2,?3,'approval_required','now')",
            params![EVENT, SESSION, request.to_string()],
        )
        .unwrap();
        let cleared = release(&conn, "order", EVENT, ACTOR, "Customer stayed", None).unwrap();
        assert_eq!(cleared["released"], true);
        assert!(pending(&conn, "branch").unwrap().is_empty());
        assert!(pending_plan(&conn, "order").unwrap().is_none());
        crate::edit_settlement_recovery::require_original_financial_attempt(&conn, "order", None)
            .unwrap();
        // One audit entry names who cleared it and keeps the frozen request.
        let (actor, payload): (String, String) = conn
            .query_row(
                "SELECT actor_staff_id,payload_json FROM recovery_action_log WHERE action_id=?1",
                [RELEASE_ACTION],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(actor, ACTOR);
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["before"]["request"], request);
        assert_eq!(payload["before"]["outcome"], "refused");
        assert_eq!(payload["moneyMoved"], false);
        // Nothing was refunded or handed back; the recovery owner stops asking.
        for table in ["payment_adjustments", "staff_order_cash_returns"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{table}"
            );
        }
        let recovery: String = conn
            .query_row(
                "SELECT status FROM table_attempt_recovery_v1 WHERE client_event_id=?1",
                [EVENT],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recovery, "applied");
        assert_eq!(intent_row(&conn).1.as_deref(), Some("released"));
        // A released attempt is cleared once.
        assert!(release(&conn, "order", EVENT, ACTOR, "again", None).is_err());
    }

    #[test]
    fn a_request_that_may_have_applied_money_is_never_cleared_without_proof() {
        let conn = fixture();
        frozen(&conn, "cash_drawer");
        assert_eq!(mark_dispatch(&conn, EVENT).unwrap(), Some(Some(1)));
        // Once an apply request left the till, an approval refusal proves nothing.
        assert!(!mark_refused(&conn, EVENT, &RefusalProof::ApprovalRefused, "HTTP_403").unwrap());
        assert!(!mark_refused(&conn, EVENT, &RefusalProof::NeverSent, "never_sent").unwrap());
        assert!(release_check(&conn, "order", EVENT)
            .unwrap_err()
            .starts_with("TABLE_CANCELLATION_RELEASE_WAIT"));
        assert!(release(&conn, "order", EVENT, ACTOR, "clear", None).is_err());
        assert_eq!(intent_row(&conn).1, None);
        // Every approval it could carry has expired: one server read that it
        // is uncommitted proves it.
        let old = (chrono::Utc::now() - chrono::Duration::minutes(20)).to_rfc3339();
        conn.execute(
            "UPDATE table_manual_cancel_intents_v1 SET last_dispatch_at=?1",
            [&old],
        )
        .unwrap();
        let ReleaseCheck::ServerReadRequired {
            session,
            actor,
            last_dispatch_at,
        } = release_check(&conn, "order", EVENT).unwrap()
        else {
            panic!("expected a server read");
        };
        assert_eq!((session.as_str(), actor.as_str()), (SESSION, ACTOR));
        // A proof read against another apply request is refused.
        assert!(release(
            &conn,
            "order",
            EVENT,
            ACTOR,
            "clear",
            Some(&RefusalProof::ExpiredUncommitted {
                last_dispatch_at: Some(chrono::Utc::now().to_rfc3339())
            })
        )
        .is_err());
        release(
            &conn,
            "order",
            EVENT,
            ACTOR,
            "clear",
            Some(&RefusalProof::ExpiredUncommitted { last_dispatch_at }),
        )
        .unwrap();
        assert!(pending(&conn, "branch").unwrap().is_empty());
    }

    #[test]
    fn only_the_first_and_only_apply_request_refusal_is_proof() {
        let conn = fixture();
        frozen(&conn, "bank");
        assert_eq!(mark_dispatch(&conn, EVENT).unwrap(), Some(Some(1)));
        assert!(mark_refused(&conn, EVENT, &RefusalProof::ApplyRefused, "HTTP_409").unwrap());
        assert_eq!(intent_row(&conn).1.as_deref(), Some("refused"));
        let conn = fixture();
        frozen(&conn, "bank");
        mark_dispatch(&conn, EVENT).unwrap();
        assert_eq!(mark_dispatch(&conn, EVENT).unwrap(), Some(Some(2)));
        assert!(!mark_refused(&conn, EVENT, &RefusalProof::ApplyRefused, "HTTP_409").unwrap());
        // A reason-only attempt has no financial intent to track.
        assert_eq!(mark_dispatch(&conn, "plain-event").unwrap(), None);
    }

    #[test]
    fn a_proven_refusal_elsewhere_does_not_hold_another_check_but_an_unknown_one_does() {
        // Symptom: one orphaned saved return (applied=0) made every other
        // manual table cancellation in the branch fail with
        // TABLE_CANCELLATION_PENDING.
        for (outcome, blocks) in [
            (None, true),
            (Some("refused"), false),
            (Some("released"), false),
        ] {
            let conn = fixture();
            schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO table_manual_cancel_intents_v1(organization_id,branch_id,terminal_id,event_id,order_id,session_id,generation,channel,reason,actor,request_json,created_at,dispatch_count,outcome)
                 VALUES('org','branch','terminal','44444444-aaaa-4aaa-8aaa-444444444444','other-order','other-session','g','bank','r',?1,'{}','now',1,?2)",
                params![ACTOR, outcome],
            )
            .unwrap();
            let plan = crate::manual_order_cancellation::prepare_validated(
                &conn,
                "order",
                &crate::manual_order_cancellation::tests::admitted(&conn),
            )
            .unwrap();
            let result = freeze(
                &conn,
                "order",
                SESSION,
                EVENT,
                "Customer cancelled",
                ACTOR,
                &json!({"generation":plan["generation"],"returnChannel":"bank"}),
                &crate::manual_order_cancellation::tests::admitted(&conn),
            );
            assert_eq!(result.is_err(), blocks, "{outcome:?}");
            if blocks {
                assert_eq!(result.unwrap_err(), "TABLE_CANCELLATION_PENDING");
            }
        }
    }

    #[test]
    fn a_legacy_saved_cancellation_is_bounded_by_the_upgrade() {
        // An intent saved before dispatch tracking: its history is unknown, so
        // nothing is cleared until every approval it could carry has expired
        // since this upgrade and the server reports it uncommitted.
        let conn = fixture();
        conn.execute_batch(
            "CREATE TABLE table_manual_cancel_intents_v1 (
              organization_id TEXT NOT NULL,branch_id TEXT NOT NULL,terminal_id TEXT NOT NULL,
              event_id TEXT NOT NULL,order_id TEXT NOT NULL,session_id TEXT NOT NULL,
              generation TEXT NOT NULL,channel TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,
              request_json TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
              PRIMARY KEY(organization_id,branch_id,terminal_id,event_id));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO table_manual_cancel_intents_v1 VALUES('org','branch','terminal',?1,'order',?2,'g','bank','Customer left',?3,?4,0,'2026-10-01T10:00:00Z')",
            params![EVENT, SESSION, ACTOR, json!({"action":"whole_order_cancel","client_event_id":EVENT,"manual_refund":{"currency":"EUR","refunds":[{"amount_cents":1050}]}}).to_string()],
        )
        .unwrap();
        // The order and Z holds read it without migrating (they run inside
        // other writers' work): a legacy intent is unresolved.
        assert_eq!(pending(&conn, "branch").unwrap(), vec!["order"]);
        let migrated: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('table_manual_cancel_intents_v1') WHERE name='outcome')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!migrated);
        let plan = pending_plan(&conn, "order").unwrap().unwrap();
        assert_eq!(plan["refused"], false);
        let (dispatches, outcome, stamped) = intent_row(&conn);
        assert_eq!((dispatches, outcome), (None, None));
        assert!(stamped.is_some());
        assert!(!mark_refused(&conn, EVENT, &RefusalProof::ApprovalRefused, "HTTP_403").unwrap());
        assert!(release_check(&conn, "order", EVENT)
            .unwrap_err()
            .starts_with("TABLE_CANCELLATION_RELEASE_WAIT"));
    }
}
