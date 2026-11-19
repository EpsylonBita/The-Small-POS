//! Restore one canonical receipt through the payment mirror owner.
use super::{clock, contracts::Command, critical_op::SupportPermit, guards, snapshot};
use rusqlite::{params, types::Value as Sql, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(super) const ACTION: &str = "payment.restore_receipt_mirror.v1";
pub(super) const CAPABILITY: &str = "support.payment-receipt-mirror.v1";
pub(super) const CONFLICT: &str = "PROTECTED_RECORD|PAYMENT_RECEIPT_CONFLICT";
const PRESENT: &str = "PROTECTED_RECORD|PAYMENT_RECEIPT_ALREADY_PRESENT";

pub(super) fn handles(command: &Command) -> bool {
    command.payload["action"]["action_id"] == ACTION
}

pub(super) fn ready(conn: &Connection) -> bool {
    conn.prepare(
        "SELECT c.result_json, c.post_json, p.tip_amount_cents, p.remote_payment_id,
        o.organization_id, o.currency, z.window_cutoff, g.local_order_id, e.fiscal_receipt_number
        FROM support_payment_receipt_commits c, order_payments p, orders o, z_reports z,
        gift_card_fiscal_operations g, ecr_transactions e LIMIT 0",
    )
    .is_ok()
}

pub(super) fn validate(command: &Command) -> Result<(), &'static str> {
    let binding = &command.payload["receipt_binding"];
    if !handles(command) {
        return if binding.is_null() {
            Ok(())
        } else {
            Err("INVALID_INPUT")
        };
    }
    let inputs = &command.payload["action"]["inputs"];
    let schema =
        &super::contracts::shared().other["schemas"]["ConfirmedPaymentReceiptBindingSchema"];
    if command.payload["rows_cap"] != 1
        || !super::delivery::valid_schema(schema, binding, 0)
        || binding["order_id"] != inputs["order_id"]
        || binding["server_payment_id"] != inputs["server_payment_id"]
    {
        return Err("INVALID_INPUT");
    }
    Ok(())
}

fn gate_refusal(code: &str) -> String {
    if code == "deferred_critical_operation" {
        "PREEMPTED_BY_CRITICAL_OPERATION".into()
    } else {
        code.into()
    }
}

fn conflict<T>() -> Result<T, String> {
    Err(CONFLICT.into())
}

fn rows(conn: &Connection, sql: &str, args: &[&str]) -> Result<Vec<Value>, String> {
    guards::rows(
        conn,
        sql,
        &args
            .iter()
            .map(|s| Sql::Text((*s).into()))
            .collect::<Vec<_>>(),
    )
}

fn order(conn: &Connection, scope: &guards::Scope, binding: &Value) -> Result<Value, String> {
    let id = binding["order_id"].as_str().ok_or(CONFLICT)?;
    let matches = rows(
        conn,
        "SELECT * FROM orders WHERE organization_id=?2 AND branch_id=?3
           AND (supabase_id=?1 OR (id=?1 AND NULLIF(supabase_id,'') IS NULL)) LIMIT 2",
        &[id, &scope.organization_id, &scope.branch_id],
    )?;
    let [order] = matches.as_slice() else {
        return conflict();
    };
    if order["currency"] != binding["currency"]
        || order["is_ghost"] == 1
        || text(&order["receipt_number"]).is_some()
        || order["order_context"] == "repair_settlement"
        || clock::parse(order["created_at"].as_str().unwrap_or_default()).is_err()
    {
        return conflict();
    }
    Ok(order.clone())
}

fn cents(decimal: &Value, explicit: &Value) -> Option<i64> {
    let amount = decimal.as_f64()?;
    let rounded = (amount * 100.0).round();
    let cents = rounded as i64;
    (rounded >= 0.0
        && rounded <= 9_007_199_254_740_991.0
        && rounded / 100.0 == amount
        && (explicit.is_null() || explicit.as_i64() == Some(cents)))
    .then_some(cents)
}

fn facts(row: &Value, local: bool) -> Option<(String, String, i64, i64)> {
    Some((
        row[if local { "method" } else { "payment_method" }]
            .as_str()?
            .into(),
        row["currency"].as_str()?.into(),
        cents(&row["amount"], &row["amount_cents"])?,
        cents(&row["tip_amount"], &row["tip_amount_cents"])?,
    ))
}

fn bound_facts(binding: &Value) -> Option<(String, String, i64, i64)> {
    Some((
        binding["method"].as_str()?.into(),
        binding["currency"].as_str()?.into(),
        binding["amount_cents"].as_i64()?,
        binding["tip_cents"].as_i64()?,
    ))
}

#[derive(Clone)]
struct Identity {
    id: String,
    stamped: Option<String>,
    key: Option<String>,
    reference: Option<String>,
}
fn text(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}
fn id(value: &Value) -> Option<&str> {
    text(value).filter(|s| uuid::Uuid::parse_str(s).is_ok())
}
fn metadata(row: &Value) -> Result<Value, String> {
    let metadata = match &row["metadata"] {
        Value::Null => json!({}),
        Value::String(s) => serde_json::from_str(s).map_err(|_| CONFLICT)?,
        value => value.clone(),
    };
    if !metadata.is_object() {
        return conflict();
    }
    Ok(metadata)
}
impl Identity {
    fn from_row(row: &Value) -> Result<Self, String> {
        let meta = metadata(row)?;
        let stamped = text(&meta["local_payment_id"]);
        let alias = text(&meta["localPaymentId"]);
        let refs = [
            "external_transaction_id",
            "externalTransactionId",
            "transaction_ref",
            "transactionRef",
        ]
        .into_iter()
        .filter_map(|key| text(&row[key]))
        .collect::<std::collections::BTreeSet<_>>();
        if stamped.zip(alias).is_some_and(|(a, b)| a != b) || refs.len() > 1 {
            return conflict();
        }
        Ok(Self {
            id: id(&row["id"]).ok_or(CONFLICT)?.into(),
            stamped: stamped.or(alias).map(str::to_string),
            key: text(&row["idempotency_key"]).map(str::to_string),
            reference: refs.into_iter().next().map(str::to_string),
        })
    }
    fn matches(&self, local: &Value) -> bool {
        local["remote_payment_id"] == self.id
            || local["id"] == self.id
            || self.stamped.as_ref().is_some_and(|s| local["id"] == *s)
            || self
                .key
                .as_ref()
                .is_some_and(|s| local["idempotency_key"] == *s)
            || local["idempotency_key"] == format!("server-payment:{}", self.id)
            || self
                .reference
                .as_ref()
                .is_some_and(|s| local["transaction_ref"] == *s)
    }
}

struct Prepared {
    local_order: String,
    remote: Value,
    created_at: String,
    identity: Identity,
    others: Vec<(Identity, Value)>,
}
fn project_metadata(original: &Value) -> Value {
    let mut safe = serde_json::Map::new();
    for key in [
        "staff_id",
        "staffId",
        "staff_shift_id",
        "staffShiftId",
        "tip_recipient_staff_id",
        "tip_recipient_staff_shift_id",
        "gift_card_id",
        "gift_card_transaction_id",
        "split_group_id",
        "split_portion_id",
    ] {
        if let Some(value) = id(&original[key]) {
            safe.insert(key.into(), json!(value));
        }
    }
    for (key, allowed) in [
        ("collected_by", &["cashier_drawer", "driver_shift"][..]),
        ("collectedBy", &["cashier_drawer", "driver_shift"][..]),
        (
            "tip_recipient_role",
            &["staff", "cashier", "waiter", "driver"][..],
        ),
    ] {
        if let Some(value) = text(&original[key]).filter(|value| allowed.contains(value)) {
            safe.insert(key.into(), json!(value));
        }
    }
    if let Some(origin) = text(&original["payment_origin"])
        .or_else(|| text(&original["paymentOrigin"]))
        .filter(|origin| {
            [
                "platform_settlement",
                "manual",
                "manual_card",
                "manual_recovery",
                "terminal",
                "cash_checkout_reconciled",
            ]
            .contains(origin)
        })
    {
        safe.insert("payment_origin".into(), json!(origin));
    }
    if original["source"] == "mobile_cart_checkout" {
        safe.insert("source".into(), json!("mobile_cart_checkout"));
    }
    Value::Object(safe)
}

fn prepare(
    scope: &guards::Scope,
    binding: &Value,
    local_order: String,
    server_order: &Value,
    ledger: Vec<Value>,
) -> Result<Prepared, String> {
    if server_order["id"] != binding["order_id"]
        || server_order["branch_id"] != scope.branch_id
        || server_order["organization_id"] != scope.organization_id
        || server_order["currency"] != binding["currency"]
        || server_order["is_test"] == true
        || !matches!(
            server_order.get("is_closed"),
            Some(Value::Bool(false) | Value::Null)
        )
        || server_order.get("z_report_id") != Some(&Value::Null)
        || server_order.get("fiscal_receipt_number") != Some(&Value::Null)
    {
        return conflict();
    }
    let mut target = None;
    let mut others = Vec::new();
    for row in ledger {
        if row["order_id"] != binding["order_id"]
            || row["branch_id"] != scope.branch_id
            || row["organization_id"] != scope.organization_id
        {
            return conflict();
        }
        let identity = Identity::from_row(&row)?;
        if row["id"] == binding["server_payment_id"] {
            if target.replace((identity, row)).is_some() {
                return conflict();
            }
        } else {
            others.push((identity, row));
        }
    }
    let (identity, row) = target.ok_or(CONFLICT)?;
    let created =
        clock::parse(row["created_at"].as_str().ok_or(CONFLICT)?).map_err(|_| CONFLICT)?;
    let meta = metadata(&row)?;
    if row["status"] != "completed"
        || facts(&row, false) != bound_facts(binding)
        || !row["adjustments"].as_array().is_some_and(Vec::is_empty)
        || row["refunded_amount_cents"] != 0
        || row["voided_amount_cents"] != 0
        || [
            &row["gift_reversed_amount_cents"],
            &meta["gift_reversed_amount_cents"],
        ]
        .iter()
        .any(|v| !v.is_null() && **v != 0)
        || !meta["platform_held_tender"].is_null()
    {
        return conflict();
    }
    let probe = json!({"id":identity.stamped.as_deref().unwrap_or(&identity.id),
        "remote_payment_id":identity.id,"idempotency_key":identity.key,"transaction_ref":identity.reference});
    if others.iter().any(|(other, _)| {
        other.matches(&probe)
            || identity.matches(&json!({"id":other.stamped,"remote_payment_id":other.id,
            "idempotency_key":other.key,"transaction_ref":other.reference}))
    }) {
        return conflict();
    }
    let mut remote = row;
    if remote["table_session_id"].is_null() {
        remote["table_session_id"] = meta["table_session_id"].clone();
    }
    remote["metadata"] = project_metadata(&meta);
    for key in [
        "staff_id",
        "staffId",
        "staff_shift_id",
        "staffShiftId",
        "table_session_id",
    ] {
        if id(&remote[key]).is_none() {
            remote.as_object_mut().ok_or(CONFLICT)?.remove(key);
        }
    }
    // Use a stable, non-secret local key. The unmodified canonical key and
    // external reference are used for correlation only.
    remote["idempotency_key"] = json!(format!("server-payment:{}", identity.id));
    if remote["payment_method"] == "gift_card"
        && (id(&remote["metadata"]["gift_card_id"]).is_none()
            || id(&remote["metadata"]["gift_card_transaction_id"]).is_none()
            || identity.reference.as_deref()
                != Some(&format!(
                    "gift_card:{}",
                    remote["metadata"]["gift_card_transaction_id"]
                        .as_str()
                        .unwrap_or_default()
                )))
    {
        return conflict();
    }
    let platform_reference = identity.reference.as_deref().is_some_and(|reference| {
        reference
            .strip_prefix("platform_settlement:")
            .and_then(|suffix| suffix.split_once(':'))
            .is_some_and(|(kind, order)| {
                matches!(kind, "online" | "cod")
                    && (order == local_order || binding["order_id"] == order)
            })
    });
    if remote["payment_method"] == "gift_card" || platform_reference {
        remote["external_transaction_id"] = json!(identity.reference);
    } else {
        remote
            .as_object_mut()
            .ok_or(CONFLICT)?
            .remove("external_transaction_id");
    }
    Ok(Prepared {
        local_order,
        remote,
        created_at: clock::iso(created),
        identity,
        others,
    })
}

fn closed_or_fiscal(conn: &Connection, order: &Value, receipt: &Prepared) -> Result<(), String> {
    let order_id = order["id"].as_str().ok_or(CONFLICT)?;
    let date = order["created_at"].as_str().ok_or(CONFLICT)?;
    let branch = order["branch_id"].as_str().ok_or(CONFLICT)?;
    let protected: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM z_reports WHERE branch_id=?1 AND
           COALESCE(julianday(COALESCE(window_cutoff,
                CASE WHEN json_valid(report_json) THEN COALESCE(json_extract(report_json,'$.period.end'),
                    json_extract(report_json,'$.periodEnd'),json_extract(report_json,'$.period_end')) END,
                generated_at)) >= MIN(julianday(?2),julianday(?3)),1))
         OR EXISTS(SELECT 1 FROM parity_sync_queue WHERE table_name='fiscal_submission' AND record_id IN (?4,?5,?6))
         OR EXISTS(SELECT 1 FROM gift_card_fiscal_operations WHERE local_order_id=?4)
         OR EXISTS(SELECT 1 FROM ecr_transactions WHERE order_id=?4 AND
                   (transaction_type='fiscal_receipt' OR fiscal_receipt_number IS NOT NULL))",
        params![branch, date, receipt.created_at, order_id, order["supabase_id"].as_str(), receipt.identity.id], |r| r.get(0),
    ).map_err(guards::error)?;
    if protected
        || [
            crate::business_day::last_z_anchor_utc(conn),
            crate::business_day::issued_z_cutoff(conn, branch),
        ]
        .into_iter()
        .flatten()
        .any(|anchor| {
            clock::parse(&anchor)
                .ok()
                .zip(
                    clock::parse(date)
                        .ok()
                        .zip(clock::parse(&receipt.created_at).ok()),
                )
                .is_none_or(|(end, (order_at, paid_at))| end >= order_at.min(paid_at))
        })
    {
        return conflict();
    }
    Ok(())
}

struct Ledger {
    payments: Vec<Value>,
    adjustments: Vec<Value>,
    totals: Value,
}
fn ledger(conn: &Connection, order: &Value, exclude: &str) -> Result<Ledger, String> {
    let order_id = order["id"].as_str().ok_or(CONFLICT)?;
    let payments = rows(
        conn,
        "SELECT * FROM order_payments WHERE order_id=?1 AND id<>?2 ORDER BY id",
        &[order_id, exclude],
    )?;
    let adjustments = rows(
        conn,
        "SELECT * FROM payment_adjustments WHERE order_id=?1 ORDER BY id",
        &[order_id],
    )?;
    let refunds = adjustments
        .iter()
        .filter(|row| row["adjustment_type"] == "refund")
        .collect::<Vec<_>>();
    let total = payments
        .iter()
        .filter(|row| row["status"] == "completed")
        .try_fold(0i64, |sum, row| {
            cents(&row["amount"], &row["amount_cents"]).and_then(|value| sum.checked_add(value))
        })
        .filter(|total| *total <= 9_007_199_254_740_991)
        .ok_or(CONFLICT)?;
    let totals = json!({
        "order_total_cents":cents(&order["total_amount"],&order["total_amount_cents"]).ok_or(CONFLICT)?,
        "other_payment_total_cents":total,
        "other_payments_sha256":super::confirmed_hash::hash(&json!({"rows":payments.iter().map(super::confirmed_hash::hash).collect::<Vec<_>>()})),
        "refunds_and_adjustments_sha256":super::confirmed_hash::hash(&json!({
            "refunds":refunds.into_iter().map(super::confirmed_hash::hash).collect::<Vec<_>>(),
            "adjustments":adjustments.iter().map(super::confirmed_hash::hash).collect::<Vec<_>>()
        })),
    });
    Ok(Ledger {
        payments,
        adjustments,
        totals,
    })
}

fn prove_absence(
    conn: &Connection,
    order: &Value,
    binding: &Value,
    receipt: &Prepared,
) -> Result<Value, String> {
    let method = binding["method"].as_str().ok_or(CONFLICT)?;
    if !crate::db::order_payments_admit_receipt_method(conn, method).map_err(guards::error)? {
        return conflict();
    }
    closed_or_fiscal(conn, order, receipt)?;
    let ids = &receipt.identity;
    let fallback = format!("server-payment:{}", ids.id);
    let matches = guards::rows(
        conn,
        "SELECT * FROM order_payments WHERE remote_payment_id=?1 OR id=?1
        OR id=?2 OR idempotency_key IN (?3,?4) OR transaction_ref=?5 LIMIT 2",
        &[
            Sql::Text(ids.id.clone()),
            ids.stamped.clone().map_or(Sql::Null, Sql::Text),
            ids.key.clone().map_or(Sql::Null, Sql::Text),
            Sql::Text(fallback),
            ids.reference.clone().map_or(Sql::Null, Sql::Text),
        ],
    )?;
    let ledger = ledger(conn, order, "")?;
    if let [row] = matches.as_slice() {
        if row["order_id"] == order["id"]
            && row["status"] == "completed"
            && (row["remote_payment_id"].is_null() || row["remote_payment_id"] == ids.id)
            && facts(row, true) == bound_facts(binding)
            && metadata(row)?["server_reversal"].is_null()
            && !ledger
                .adjustments
                .iter()
                .any(|a| a["payment_id"] == row["id"])
        {
            return Err(PRESENT.into());
        }
    }
    if !matches.is_empty()
        || !crate::unsaved_payments::list(conn, order["id"].as_str())
            .map_err(|_| CONFLICT)?
            .is_empty()
    {
        return conflict();
    }
    // A reconstructed placeholder or any other unidentified local receipt
    // could represent the target. Require a distinct canonical match for each.
    for local in &ledger.payments {
        let mut candidates = receipt.others.iter().filter(|(ids, _)| ids.matches(local));
        let (ids, canonical) = candidates.next().ok_or(CONFLICT)?;
        if local["currency"] != binding["currency"]
            || candidates.next().is_some()
            || local["status"] != canonical["status"]
            || facts(local, true).is_none()
            || facts(local, true) != facts(canonical, false)
            || (!local["remote_payment_id"].is_null() && local["remote_payment_id"] != ids.id)
            || ledger
                .payments
                .iter()
                .any(|other| other["id"] != local["id"] && ids.matches(other))
        {
            return conflict();
        }
    }
    if ledger
        .adjustments
        .iter()
        .any(|a| !ledger.payments.iter().any(|p| p["id"] == a["payment_id"]))
    {
        return conflict();
    }
    Ok(ledger.totals)
}

async fn fetch(state: &crate::db::DbState, id: &str) -> Result<(Value, Vec<Value>), String> {
    let (base, key) = crate::resolve_admin_endpoint(Some(state))
        .await
        .map_err(|_| "TILL_OFFLINE")?;
    let answer = crate::api::fetch_from_admin_detailed_with_timeout(
        &base,
        &key,
        &format!("/api/pos/orders/sync?order_id={id}&limit=1"),
        "GET",
        None,
        Duration::from_millis(2500),
    )
    .await
    .map_err(|_| CONFLICT)?;
    let [order] = answer["orders"]
        .as_array()
        .map(Vec::as_slice)
        .ok_or(CONFLICT)?
    else {
        return conflict();
    };
    let rows =
        crate::sync::fetch_order_payment_ledger(&base, &key, id, Duration::from_millis(2500))
            .await
            .map_err(|_| CONFLICT)?;
    Ok((order.clone(), rows))
}

// The current renderer polls the banner and paints this exact history label.
// Wait outside the writer until the visible banner has received the command.
fn notice_slot() -> &'static std::sync::Mutex<Option<(String, Instant)>> {
    static NOTICE: std::sync::Mutex<Option<(String, Instant)>> = std::sync::Mutex::new(None);
    &NOTICE
}

pub(super) fn notice_served(banner: &Value) {
    let Some(id) = banner["confirmed_command_id"].as_str() else {
        return;
    };
    let shown = banner["confirmed_history"].as_array().is_some_and(|rows| {
        rows.iter().any(|row| {
            row["command_id"] == id
                && row["label"]["key"] == "restorePaymentReceiptMirror"
                && row["state"] == "started"
        })
    });
    if shown {
        if let Ok(mut slot) = notice_slot().lock() {
            if slot.as_ref().is_none_or(|(previous, _)| previous != id) {
                *slot = Some((id.into(), Instant::now()));
            }
        }
    }
}

// The shipped banner accepts plain approved text for every action. Only send
// the optional localized label to a renderer that understands its shape.
pub(super) fn retain_compatible_notice(banner: &mut Value) {
    if let Some(history) = banner["confirmed_history"].as_array_mut() {
        for row in history
            .iter_mut()
            .filter(|row| row["label"]["key"] == "restorePaymentReceiptMirror")
        {
            if let Some(fields) = row.as_object_mut() {
                fields.remove("label");
            }
        }
    }
}

fn wait_for_notice(
    command: &Command,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        check()?;
        if notice_slot().lock().is_ok_and(|slot| {
            slot.as_ref().is_some_and(|(id, at)| {
                id == &command.command_id && at.elapsed() >= Duration::from_millis(50)
            })
        }) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("TILL_PAUSED".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn run(
    store: &Connection,
    live: &Path,
    command: &Command,
    scope: &guards::Scope,
    state: &crate::db::DbState,
    check: impl Fn() -> Result<(), String>,
    now: i64,
) -> Result<Value, String> {
    run_with_fetch(
        store,
        live,
        command,
        scope,
        check,
        now,
        |check| wait_for_notice(command, check),
        |id, check| {
            tauri::async_runtime::block_on(async {
                let future = fetch(state, id);
                tokio::pin!(future);
                loop {
                    tokio::select! {
                        result = &mut future => { check()?; return result }
                        _ = tokio::time::sleep(Duration::from_millis(10)) => check()?,
                    }
                }
            })
        },
    )
}

fn run_with_fetch(
    store: &Connection,
    live: &Path,
    command: &Command,
    scope: &guards::Scope,
    check: impl Fn() -> Result<(), String>,
    now: i64,
    present: impl FnOnce(&dyn Fn() -> Result<(), String>) -> Result<(), String>,
    fetch: impl FnOnce(&str, &dyn Fn() -> Result<(), String>) -> Result<(Value, Vec<Value>), String>,
) -> Result<Value, String> {
    validate(command)?;
    let gate = super::critical_op::global();
    let handoff = gate.register_process_cancel(|| {}).map_err(gate_refusal)?;
    let check = || {
        if handoff.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        check()
    };
    let reader = gate.try_begin_support(false, None).map_err(gate_refusal)?;
    let read =
        super::replica::read_connection(live, &reader, Instant::now() + Duration::from_secs(2))?;
    if !ready(&read) {
        return Err("FEATURE_DISABLED".into());
    }
    let binding = &command.payload["receipt_binding"];
    let local = order(&read, scope, binding)?;
    let local_id = local["id"].as_str().ok_or(CONFLICT)?.to_string();
    drop(read);
    check()?;
    let (server_order, rows) = fetch(binding["order_id"].as_str().ok_or("INVALID_INPUT")?, &check)?;
    check()?;
    let receipt = prepare(scope, binding, local_id, &server_order, rows)?;
    let read =
        super::replica::read_connection(live, &reader, Instant::now() + Duration::from_secs(2))?;
    prove_absence(&read, &order(&read, scope, binding)?, binding, &receipt)?;
    drop(read);
    let snap = snapshot::take(
        store,
        live,
        &command.session_id,
        None,
        "pre_command",
        &reader,
    )
    .map_err(|error| check().err().unwrap_or(error))?;
    check()?;
    let intent = store.execute(
        "INSERT INTO support_confirmed_events(session_id,command_id,event,details_json,created_at)
         SELECT session_id,command_id,event,json_set(details_json,'$.snapshot_id',?1),?2
           FROM support_confirmed_events
          WHERE session_id=?3 AND command_id=?4 AND event='confirmed_command_started'
          ORDER BY id DESC LIMIT 1",
        params![snap.id,clock::iso(now),command.session_id,command.command_id],
    ).map_err(guards::error)?;
    if intent != 1 {
        return Err("INTERNAL_ERROR".into());
    }
    present(&check)?;
    check()?;
    if reader.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    drop(reader);
    let writer = gate.try_begin_support(true, None).map_err(gate_refusal)?;
    apply(
        store, live, command, scope, now, &writer, &snap, receipt, check,
    )
}

fn apply(
    store: &Connection,
    live: &Path,
    command: &Command,
    scope: &guards::Scope,
    now: i64,
    writer: &SupportPermit,
    snap: &snapshot::Snapshot,
    receipt: Prepared,
    check: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let conn = crate::order_notice_recovery::observer_connection(live, true)?;
    let schema = guards::schema(&conn)?;
    if super::contracts::payload_hash(&json!(schema)) != snap.schema_sha256 {
        return Err("PAYLOAD_DRIFT".into());
    }
    let effects = super::confirmed_actions::Effects::install(&conn);
    let deadline = Instant::now() + Duration::from_millis(250);
    check()?;
    let tx = writer.begin_write_nowait(&conn)?;
    let result = (|| {
        if super::identity::local(&tx)? != *scope
            || snapshot::full_for_write(&tx, &schema, writer, deadline)? != snap.full
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        let binding = &command.payload["receipt_binding"];
        let before_order = order(&tx, scope, binding)?;
        if before_order["id"] != receipt.local_order {
            return conflict();
        }
        let before = prove_absence(&tx, &before_order, binding, &receipt)?;
        check()?;
        let local_id = crate::sync::restore_order_payment_mirror_before_payment_decision(
            &tx,
            &receipt.local_order,
            &receipt.remote,
            &receipt.created_at,
            &clock::iso(now),
        )
        .map_err(|_| CONFLICT)?;
        let found = rows(
            &tx,
            "SELECT * FROM order_payments WHERE id=?1",
            &[&local_id],
        )?;
        let [after] = found.as_slice() else {
            return conflict();
        };
        let after_order = order(&tx, scope, binding)?;
        let after_totals = ledger(&tx, &after_order, &local_id)?.totals;
        let balance =
            crate::payments::load_order_payment_balance_snapshot(&tx, &receipt.local_order)?;
        if after["order_id"] != receipt.local_order
            || after["remote_payment_id"] != receipt.identity.id
            || after["status"] != "completed"
            || after["sync_state"] != "applied"
            || facts(after, true) != bound_facts(binding)
            || before_order != after_order
            || before != after_totals
            || balance.net_paid > balance.order_total
            || super::confirmed_actions::changes(&tx, &effects, 1)? != 1
        {
            return conflict();
        }
        let data = json!({"step":"action","kind":"untrusted_till_data","observation_time":clock::iso(now),
            "snapshot_id":snap.id,"affected_ids":[local_id],"changed_rows":1,"outcome":"resolved",
            "verification":{"fresh":true,"matches_expected":true,"sync":"not_applicable"},
            "evidence":{"kind":"payment_receipt_mirror","local_payment_id":local_id,
                "local_receipt_before":null,"local_receipt_after":binding,"before_totals":before,
                "after_totals":after_totals,"charges_created":0,"refunds_created":0,"adjustments_created":0,
                "audit_ref":command.command_id},
            "undo":{"kind":"snapshot","reference":snap.id,"reason":null}});
        let post = snapshot::full_for_write(&tx, &schema, writer, deadline)?;
        tx.execute("INSERT INTO support_payment_receipt_commits(command_id,session_id,payload_sha256,result_json,post_json)
            VALUES(?1,?2,?3,?4,?5)",
            params![command.command_id,command.session_id,command.payload_sha256,data.to_string(),post.to_string()])
            .map_err(guards::error)?;
        #[cfg(test)]
        BEFORE_COMMIT.with(|hook| {
            if let Some(hook) = hook.borrow_mut().take() {
                hook();
            }
        });
        check()?;
        if writer.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        if Instant::now() >= deadline {
            return Err("QUERY_TIMEOUT".into());
        }
        Ok((data, post))
    })();
    let (data, post) = result.map_err(|error| check().err().unwrap_or(error))?;
    if let Err(error) = tx.commit() {
        if let Some(committed) = recover(store, live, command) {
            return Ok(committed);
        }
        return Err(
            if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
                check().err().unwrap_or_else(|| "QUERY_TIMEOUT".into())
            } else {
                "OUTCOME_UNKNOWN".into()
            },
        );
    }
    // The same commit stores the immutable outcome used after a restart.
    let _ = super::confirmed::save_post(store, &snap.id, &post);
    Ok(data)
}

#[cfg(test)]
thread_local! {
    static BEFORE_COMMIT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn recover(store: &Connection, live: &Path, command: &Command) -> Option<Value> {
    if !handles(command) {
        return None;
    }
    let conn = Connection::open_with_flags(live, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let (data, post): (String, String) = conn
        .query_row(
            "SELECT result_json,post_json FROM support_payment_receipt_commits
         WHERE command_id=?1 AND session_id=?2 AND payload_sha256=?3",
            params![
                command.command_id,
                command.session_id,
                command.payload_sha256
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()??;
    let data: Value = serde_json::from_str(&data).ok()?;
    let post = serde_json::from_str(&post).ok()?;
    let _ = super::confirmed::save_post(store, data["snapshot_id"].as_str()?, &post);
    Some(data)
}

#[cfg(test)]
#[path = "confirmed_payment_receipt_tests.rs"]
mod tests;
