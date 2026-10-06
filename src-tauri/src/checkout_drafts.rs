//! Scoped cart recovery. A deleted draft keeps a CAS tombstone so a late save
//! cannot resurrect an accepted or discarded checkout. Recovery never collects.
use crate::{
    db,
    table_session_cache::{self, Scope},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn scope(conn: &Connection, input: &Value) -> Result<Scope, String> {
    let current = table_session_cache::current_scope(conn)?;
    let requested = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .ok_or("CHECKOUT_DRAFT_SCOPE_REQUIRED")
    };
    let terminal = requested("terminalId")?;
    let alias = db::get_setting(conn, "terminal", "terminal_id");
    if requested("organizationId")? != current.organization
        || requested("branchId")? != current.branch
        || (terminal != current.terminal && alias.as_deref() != Some(terminal))
    {
        return Err("CHECKOUT_DRAFT_SCOPE_CHANGED".into());
    }
    Ok(current)
}

fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS checkout_drafts_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        generation INTEGER NOT NULL, draft_json TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(organization_id,branch_id,terminal_id));",
    )
    .map_err(|e| e.to_string())
}

fn read(conn: &Connection, scope: &Scope) -> Result<Value, String> {
    schema(conn)?;
    conn.execute("INSERT OR IGNORE INTO checkout_drafts_v1(organization_id,branch_id,terminal_id,generation,draft_json,updated_at) VALUES(?1,?2,?3,0,NULL,?4)",
        params![scope.organization,scope.branch,scope.terminal,chrono::Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    let row: Option<(i64, Option<String>, String)> = conn
        .query_row(
            "SELECT generation,draft_json,updated_at FROM checkout_drafts_v1
        WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3",
            params![scope.organization, scope.branch, scope.terminal],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (generation, raw, updated) = row.unwrap_or((0, None, String::new()));
    let draft = raw
        .map(|s| serde_json::from_str::<Value>(&s))
        .transpose()
        .map_err(|_| "CHECKOUT_DRAFT_INVALID")?;
    Ok(
        json!({"success":true,"generation":generation,"draft":draft,"updatedAt":updated,
        "scope":{"organizationId":scope.organization,"branchId":scope.branch,"terminalId":scope.terminal}}),
    )
}

fn validate(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                let key: String = key
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect();
                if matches!(
                    key.as_str(),
                    "pin"
                        | "managerpin"
                        | "staffpin"
                        | "password"
                        | "apikey"
                        | "posapikey"
                        | "accesstoken"
                        | "refreshtoken"
                        | "approvaltoken"
                        | "authorization"
                        | "credentials"
                ) {
                    return Err("CHECKOUT_DRAFT_SECRET_FORBIDDEN".into());
                }
                validate(child)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                validate(child)?;
            }
        }
        _ => (),
    }
    Ok(())
}

fn cancelled_edit_target(
    conn: &Connection,
    scope: &Scope,
    draft: &Value,
) -> Result<Option<String>, String> {
    if draft["context"]["editMode"].as_bool() != Some(true) {
        return Ok(None);
    }
    let Some(target) = draft["context"]["editOrderId"].as_str() else {
        return Ok(None);
    };
    conn.query_row("SELECT id FROM orders WHERE (id=?1 OR supabase_id=?1) AND organization_id=?2 AND branch_id=?3 AND LOWER(TRIM(status)) IN ('cancelled','canceled')",
        params![target, scope.organization, scope.branch], |row| row.get(0)).optional().map_err(|error| error.to_string())
}

/// Retire an abandoned editor, never an operator-confirmed financial request.
/// Keep its exact contents in an archive and advance the CAS generation so a
/// renderer that loaded before cancellation cannot resurrect it.
fn load(conn: &Connection, input: &Value) -> Result<Value, String> {
    let scope = scope(conn, input)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let previous = read(&tx, &scope)?;
    let draft = &previous["draft"];
    let Some(order) = cancelled_edit_target(&tx, &scope, draft)? else {
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(previous);
    };
    let request = draft["checkoutRequestId"].as_str().unwrap_or_default();
    let event = draft["submission"]["client_event_id"]
        .as_str()
        .unwrap_or(request);
    let protected = draft["phase"].as_str() != Some("editing")
        || !draft["submission"].is_null()
        || request.is_empty()
        || crate::edit_settlement_recovery::inspect(&tx, event, &order)?.is_some()
        || crate::table_attempt_recovery::inspect_edit(&tx, event, &order)?.is_some()
        || crate::edit_settlement_recovery::require_original_financial_attempt(&tx, &order, None).is_err()
        || crate::unsaved_payments::list(&tx, None)?.iter().any(|entry| entry.order_id == order || entry.order_id == request)
        || tx.query_row("SELECT EXISTS(SELECT 1 FROM ecr_transactions WHERE order_id IN (?1,?2) AND LOWER(TRIM(transaction_type)) IN ('sale','fiscal_receipt') AND LOWER(TRIM(status)) NOT IN ('declined'))",
            params![order,request], |row| row.get::<_,bool>(0)).map_err(|error|error.to_string())?;
    if protected {
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(previous);
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS checkout_draft_archive_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        generation INTEGER NOT NULL, draft_json TEXT NOT NULL, reason TEXT NOT NULL, archived_at TEXT NOT NULL,
        PRIMARY KEY(organization_id,branch_id,terminal_id,generation))").map_err(|error|error.to_string())?;
    let generation = previous["generation"]
        .as_i64()
        .ok_or("CHECKOUT_DRAFT_INVALID")?;
    let next = generation
        .checked_add(1)
        .ok_or("CHECKOUT_DRAFT_VERSION_EXHAUSTED")?;
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO checkout_draft_archive_v1 VALUES(?1,?2,?3,?4,?5,'edit_target_cancelled',?6)",
        params![
            scope.organization,
            scope.branch,
            scope.terminal,
            generation,
            draft.to_string(),
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.execute("UPDATE checkout_drafts_v1 SET generation=?1,draft_json=NULL,updated_at=?2 WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND generation=?6",
        params![next,now,scope.organization,scope.branch,scope.terminal,generation]).map_err(|error|error.to_string())?;
    let mut reply = read(&tx, &scope)?;
    reply["invalidation"] = json!({"reason":"edit_target_cancelled","orderId":order});
    tx.commit().map_err(|error| error.to_string())?;
    Ok(reply)
}

pub(crate) fn write(conn: &Connection, input: &Value, deleting: bool) -> Result<Value, String> {
    let scope = scope(conn, input)?;
    let expected = input
        .get("expectedGeneration")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
        .ok_or("CHECKOUT_DRAFT_GENERATION_REQUIRED")?;
    let raw = if deleting {
        None
    } else {
        let draft = input
            .get("draft")
            .filter(|v| v.is_object())
            .ok_or("CHECKOUT_DRAFT_REQUIRED")?;
        validate(draft)?;
        let raw = draft.to_string();
        if raw.len() > 2 * 1024 * 1024 {
            return Err("CHECKOUT_DRAFT_TOO_LARGE".into());
        }
        Some(raw)
    };
    schema(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let previous = read(&tx, &scope)?;
    if previous["generation"].as_i64() != Some(expected) {
        return Err("CHECKOUT_DRAFT_VERSION_CHANGED".into());
    }
    if !deleting
        && input["draft"]["phase"].as_str() == Some("editing")
        && cancelled_edit_target(&tx, &scope, &input["draft"])?.is_some()
    {
        return Err("CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED".into());
    }
    if !deleting
        && previous["draft"].is_object()
        && previous["draft"]["checkoutRequestId"] != input["draft"]["checkoutRequestId"]
    {
        return Err("CHECKOUT_REQUEST_ID_CHANGED".into());
    }
    let next = expected
        .checked_add(1)
        .ok_or("CHECKOUT_DRAFT_VERSION_EXHAUSTED")?;
    tx.execute("INSERT INTO checkout_drafts_v1(organization_id,branch_id,terminal_id,generation,draft_json,updated_at)
        VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(organization_id,branch_id,terminal_id) DO UPDATE
        SET generation=excluded.generation,draft_json=excluded.draft_json,updated_at=excluded.updated_at",
        params![scope.organization,scope.branch,scope.terminal,next,raw,chrono::Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    let reply = read(&tx, &scope)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(reply)
}

#[tauri::command]
pub fn checkout_draft_check_admission(
    arg0: Value,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    check_admission(&conn, &arg0)
}

fn check_admission(conn: &Connection, input: &Value) -> Result<Value, String> {
    let scope = scope(conn, input)?;
    // Existing-order collection uses original ledger provenance, never today's
    // currency to relabel an old NULL order. Validate before proposing adoption.
    let order_currency = if let Some(id) = input.get("orderId").and_then(Value::as_str) {
        let order = crate::resolve_order_id(conn, id).ok_or("ORDER_NOT_FOUND")?;
        let (organization, branch, status): (Option<String>, String, String) = conn
            .query_row(
                "SELECT organization_id,COALESCE(branch_id,''),status FROM orders WHERE id=?1",
                [&order],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| error.to_string())?;
        if organization.as_deref() != Some(scope.organization.as_str()) || branch != scope.branch {
            return Err("CHECKOUT_DRAFT_SCOPE_CHANGED".into());
        }
        if matches!(
            status.trim().to_ascii_lowercase().as_str(),
            "cancelled" | "canceled"
        ) {
            return Err("CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED".into());
        }
        let recorded = crate::shifts::recorded_operating_currency(conn, "orders", &order)?;
        let ledger = crate::fiscal::payload_builder::resolve_order_payment_currency(conn, &order)?;
        if recorded
            .as_ref()
            .zip(ledger.as_ref())
            .is_some_and(|(left, right)| left != right)
        {
            return Err("ORDER_CURRENCY_MISMATCH".into());
        }
        let currency = recorded.or(ledger).ok_or("ORDER_CURRENCY_UNAVAILABLE")?;
        if crate::shifts::require_operating_currency(conn, &branch)? != currency {
            return Err("ORDER_CURRENCY_MISMATCH".into());
        }
        Some(currency)
    } else {
        None
    };
    let (shift_id, _) =
        crate::sync::require_active_cashier_for_order_create(conn, &scope.branch, &scope.terminal)?;
    let currency = match crate::shifts::require_shift_operating_currency(conn, &shift_id) {
        Ok(currency) => currency,
        Err(error) if error == "SHIFT_CURRENCY_UNAVAILABLE" => {
            return crate::legacy_shift_currency::admission(conn, &shift_id);
        }
        Err(error) => return Err(error),
    };
    if order_currency.is_some_and(|original| original != currency) {
        return Err("ORDER_CURRENCY_MISMATCH".into());
    }
    Ok(json!({"success": true, "currency": currency}))
}

#[tauri::command]
pub fn checkout_draft_get(arg0: Value, db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::with_full_sync(&conn, |conn| load(conn, &arg0))
}
#[tauri::command]
pub fn checkout_draft_put(arg0: Value, db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::with_full_sync(&conn, |conn| write(conn, &arg0, false))
}
#[tauri::command]
pub fn checkout_draft_delete(
    arg0: Value,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    db::with_full_sync(&conn, |conn| write(conn, &arg0, true))
}

/// A missing row, cancelled/error response, or returned flag is never a refusal proof.
fn refusal_outcome(
    conn: &Connection,
    scope: &Scope,
    request: &str,
) -> Result<Option<&'static str>, String> {
    let orders: i64 = conn
        .query_row(
            "SELECT count(*) FROM orders WHERE client_request_id=?1 OR id=?1",
            [request],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if orders != 0
        || crate::unsaved_payments::list(conn, None)?
            .iter()
            .any(|entry| entry.order_id == request)
    {
        return Ok(None);
    }
    let orphan: i64 = conn.query_row(
        "SELECT count(*) FROM local_settings WHERE setting_category='ecr_orphaned_receipts' AND setting_key=?1",
        [request], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if orphan != 0 {
        return Ok(None);
    }
    let mut statement = conn
        .prepare(
            "SELECT status,receipt_data FROM ecr_transactions WHERE order_id=?1
         AND LOWER(TRIM(transaction_type)) IN ('sale','fiscal_receipt')",
        )
        .map_err(|error| error.to_string())?;
    let statuses = statement
        .query_map([request], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if statuses.is_empty() {
        return Ok(None);
    }
    let mut declined = false;
    let mut not_sent = false;
    for (status, receipt) in statuses {
        if status.trim().eq_ignore_ascii_case("declined") {
            declined = true;
            continue;
        }
        if status != "not_sent" {
            return Ok(None);
        }
        let Some(receipt) = receipt.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
            return Ok(None);
        };
        let proof = &receipt["initialFiscalAttempt"];
        if proof["version"].as_u64() != Some(1)
            || proof["organizationId"].as_str() != Some(scope.organization.as_str())
            || proof["branchId"].as_str() != Some(scope.branch.as_str())
            || proof["terminalId"].as_str() != Some(scope.terminal.as_str())
            || proof["ownerTerminalId"].as_str() != Some(scope.owner.as_str())
            || proof["orderReference"].as_str() != Some(request)
            || proof["requestFingerprint"]
                .as_str()
                .is_none_or(|value| value.is_empty())
            || receipt["dispatchProof"].as_str() != Some("not_sent")
            || !matches!(
                receipt["notSentReason"].as_str(),
                Some("disconnected" | "invalid_print_mode")
            )
        {
            return Ok(None);
        }
        not_sent = true;
    }
    Ok(Some(if declined && not_sent {
        "not_charged"
    } else if not_sent {
        "not_sent"
    } else {
        "declined"
    }))
}

pub(crate) fn resume_declined(conn: &Connection, input: &Value) -> Result<Value, String> {
    let scope = scope(conn, input)?;
    let expected = input
        .get("expectedGeneration")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or("CHECKOUT_DRAFT_GENERATION_REQUIRED")?;
    let request = input
        .get("clientRequestId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 255)
        .ok_or("CHECKOUT_REQUEST_ID_REQUIRED")?;
    let draft_id = input
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or("CHECKOUT_DRAFT_REQUIRED")?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let previous = read(&tx, &scope)?;
    if previous["generation"].as_i64() != Some(expected) {
        return Err("CHECKOUT_DRAFT_VERSION_CHANGED".into());
    }
    let mut draft = previous["draft"].clone();
    if !draft["cartItems"].is_array()
        || !draft["context"].is_object()
        || !draft["state"].is_object()
        || draft["schemaVersion"].as_i64() != Some(1)
        || draft["draftId"].as_str() != Some(draft_id)
        || draft["checkoutRequestId"].as_str() != Some(request)
        || draft["phase"].as_str() != Some("checkout_pending")
        || draft["context"]["editMode"].as_bool() == Some(true)
        || draft["submission"]["clientRequestId"].as_str() != Some(request)
        || draft["submission"]["paymentData"]["method"].as_str() != Some("card")
    {
        return Err("CHECKOUT_DRAFT_CHANGED".into());
    }
    if refusal_outcome(&tx, &scope, request)?.is_none() {
        return Err("CHECKOUT_DRAFT_DECLINE_NOT_PROVEN".into());
    }
    let next_request = uuid::Uuid::new_v4().to_string();
    draft["checkoutRequestId"] = json!(next_request);
    draft["context"]["checkoutRequestId"] = draft["checkoutRequestId"].clone();
    draft["phase"] = json!("editing");
    draft
        .as_object_mut()
        .ok_or("CHECKOUT_DRAFT_INVALID")?
        .remove("submission");
    let next = expected
        .checked_add(1)
        .ok_or("CHECKOUT_DRAFT_VERSION_EXHAUSTED")?;
    let changed = tx
        .execute(
            "UPDATE checkout_drafts_v1 SET generation=?1,draft_json=?2,updated_at=?3
        WHERE organization_id=?4 AND branch_id=?5 AND terminal_id=?6 AND generation=?7",
            params![
                next,
                draft.to_string(),
                chrono::Utc::now().to_rfc3339(),
                scope.organization,
                scope.branch,
                scope.terminal,
                expected
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("CHECKOUT_DRAFT_VERSION_CHANGED".into());
    }
    let reply = read(&tx, &scope)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(reply)
}

#[tauri::command]
pub fn checkout_draft_resume_declined(
    arg0: Value,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    db::with_full_sync(&conn, |conn| resume_declined(conn, &arg0))
}

pub(crate) fn inspect(conn: &Connection, input: &Value) -> Result<Value, String> {
    let scope = scope(conn, input)?;
    if let (Some(order), Some(event)) = (
        input.get("editOrderId").and_then(Value::as_str),
        input.get("clientEventId").and_then(Value::as_str),
    ) {
        if let Some(receipt) = crate::edit_settlement_recovery::inspect(conn, event, order)? {
            let outcome = match receipt["state"].as_str() {
                Some("applied") => "saved",
                _ => "uncertain",
            };
            return Ok(
                json!({"success":true,"outcome":outcome,"orderId":order,"recovery":receipt,"canCollect":false}),
            );
        }
        let proof = crate::table_attempt_recovery::inspect_edit(conn, event, order)?;
        let outcome = match proof
            .as_ref()
            .and_then(|p| p.get("recoveryState"))
            .and_then(Value::as_str)
        {
            Some("applied") => "saved",
            Some(_) => "uncertain",
            None => "not_found",
        };
        return Ok(
            json!({"success":true,"outcome":outcome,"orderId":order,"recovery":proof,"canCollect":false}),
        );
    }
    let request = input
        .get("clientRequestId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 255)
        .ok_or("CHECKOUT_REQUEST_ID_REQUIRED")?;
    let order:Option<String>=conn.query_row("SELECT id FROM orders WHERE client_request_id=?1 AND organization_id=?2 AND branch_id=?3
        AND (source_terminal_id=?4 OR terminal_id=?4 OR owner_terminal_id=?5) LIMIT 1",
        params![request,scope.organization,scope.branch,scope.terminal,scope.owner],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let payments = crate::unsaved_payments::list(conn, None)?
        .into_iter()
        .filter(|entry| {
            entry.order_id == request || order.as_deref() == Some(entry.order_id.as_str())
        })
        .filter(|entry| {
            order.is_some()
                || (entry
                    .request
                    .get("organization_id")
                    .or_else(|| entry.request.get("organizationId"))
                    .and_then(Value::as_str)
                    == Some(scope.organization.as_str())
                    && entry
                        .request
                        .get("branch_id")
                        .or_else(|| entry.request.get("branchId"))
                        .and_then(Value::as_str)
                        == Some(scope.branch.as_str()))
        })
        .map(|entry| crate::unsaved_payments::summary_json(&entry))
        .collect::<Vec<_>>();
    let mut stmt=conn.prepare("SELECT e.id,e.status,e.transaction_type FROM ecr_transactions e WHERE e.order_id IN (?1,?2)
        AND LOWER(TRIM(e.transaction_type)) IN ('sale','fiscal_receipt')
        AND LOWER(TRIM(e.status)) <> 'declined'
        AND COALESCE((CASE WHEN json_valid(e.receipt_data) THEN json_extract(e.receipt_data,'$.returnedToCustomer') END),0) <> 1
        AND NOT (LOWER(TRIM(e.status))='approved' AND EXISTS(SELECT 1 FROM order_payments p WHERE p.order_id=?2
            AND p.status='completed' AND (p.transaction_ref=e.id OR p.idempotency_key=e.id)
            AND COALESCE(p.amount_cents,CAST(ROUND(p.amount*100) AS INTEGER))=e.amount
            AND UPPER(TRIM(p.currency))=UPPER(TRIM(e.currency))))").map_err(|e|e.to_string())?;
    let ecr=stmt.query_map(params![request,order],|r|Ok(json!({"id":r.get::<_,String>(0)?,"status":r.get::<_,String>(1)?,"transactionType":r.get::<_,String>(2)?})))
        .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    // Order acceptance is not proof that an in-flight charge was recorded.
    // Preserve the frozen checkout until held or unknown money is reconciled.
    let outcome = if !payments.is_empty() {
        "held"
    } else if !ecr.is_empty() {
        // Versioned native pre-publication evidence may prove every attempt unsent.
        refusal_outcome(conn, &scope, request)?.unwrap_or("uncertain")
    } else if order.is_some() {
        "saved"
    } else if let Some(refusal) = refusal_outcome(conn, &scope, request)? {
        refusal
    } else {
        "not_found"
    };
    Ok(
        json!({"success":true,"outcome":outcome,"orderId":order,"payments":payments,"ecr":ecr,"canCollect":false}),
    )
}
#[tauri::command]
pub fn checkout_draft_inspect(
    arg0: Value,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    inspect(&conn, &arg0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cancelled_editor_fixture(conn: &Connection) -> Value {
        let mut input = seed(conn);
        conn.execute("INSERT INTO orders(id,organization_id,branch_id,items,total_amount,status,created_at,updated_at) VALUES('cancelled-target','org','branch','[]',10.5,'pending','now','now')", []).unwrap();
        input["draft"] = json!({"schemaVersion":1,"draftId":"original-editor","checkoutRequestId":"unconfirmed-edit","phase":"editing",
            "context":{"editMode":true,"editOrderId":"cancelled-target","orderType":"delivery"},
            "cartItems":[{"id":"retained-line","quantity":2,"price":5.25}],"state":{"manualDeliveryFee":0}});
        write(conn, &input, false).unwrap();
        conn.execute(
            "UPDATE orders SET status='cancelled' WHERE id='cancelled-target'",
            [],
        )
        .unwrap();
        input["expectedGeneration"] = json!(1);
        input
    }

    #[test]
    fn checkout_cancelled_target_archives_unconfirmed_editor_and_fences_late_save() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let input = cancelled_editor_fixture(&conn);
        let reply = load(&conn, &input).unwrap();
        assert!(reply["draft"].is_null());
        assert_eq!(reply["generation"], 2);
        assert_eq!(reply["invalidation"]["reason"], "edit_target_cancelled");
        let archived: String = conn
            .query_row(
                "SELECT draft_json FROM checkout_draft_archive_v1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&archived).unwrap(),
            input["draft"]
        );
        assert_eq!(
            write(&conn, &input, false).unwrap_err(),
            "CHECKOUT_DRAFT_VERSION_CHANGED"
        );
        let mut fresh = input.clone();
        fresh["expectedGeneration"] = json!(2);
        assert_eq!(
            write(&conn, &fresh, false).unwrap_err(),
            "CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED"
        );
        assert_eq!(load(&conn, &input).unwrap()["generation"], 2);
        assert_eq!(
            conn.query_row(
                "SELECT status FROM orders WHERE id='cancelled-target'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "cancelled"
        );
        fresh["orderId"] = json!("cancelled-target");
        assert_eq!(
            check_admission(&conn, &fresh).unwrap_err(),
            "CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED"
        );
    }

    #[test]
    fn checkout_cancelled_target_retains_confirmed_or_uncertain_originals() {
        for protection in ["pending", "submission", "held", "provider"] {
            let db = crate::tests::harness::TestDb::open();
            let conn = db.state.conn.lock().unwrap();
            let input = cancelled_editor_fixture(&conn);
            let mut original = input["draft"].clone();
            match protection {
                "pending" => original["phase"] = json!("checkout_pending"),
                "submission" => {
                    original["submission"] = json!({"action":"edit_settlement","settlementAction":{"type":"collect","amount":4.5}})
                }
                "held" => {
                    let held:crate::unsaved_payments::UnsavedChargedPayment=serde_json::from_value(json!({"idempotencyKey":"held-original","orderId":"cancelled-target","method":"cash","amount":4.5,"amountCents":450,"currency":"EUR","kind":"single","request":{"orderId":"cancelled-target"},"capturedAt":"now"})).unwrap();
                    crate::unsaved_payments::record(&conn, &held).unwrap();
                }
                "provider" => {
                    conn.execute("INSERT INTO ecr_devices(id,name,device_type,brand,protocol,connection_type,connection_details) VALUES('terminal-device','Reader','payment_terminal','test','test','network','{}')",[]).unwrap();
                    crate::db::ecr_insert_transaction(&conn,&json!({"id":"unknown-edit-sale","deviceId":"terminal-device","transactionType":"sale","amount":450,"currency":"EUR","orderId":"cancelled-target","status":"processing"})).unwrap();
                }
                _ => unreachable!(),
            }
            conn.execute(
                "UPDATE checkout_drafts_v1 SET draft_json=?1",
                [original.to_string()],
            )
            .unwrap();
            let reply = load(&conn, &input).unwrap();
            assert_eq!(reply["draft"], original, "{protection}");
            assert_eq!(reply["generation"], 1, "{protection}");
        }
    }

    #[test]
    fn checkout_cancelled_target_never_archives_foreign_scope_or_active_order() {
        for change in [
            "UPDATE orders SET branch_id='another'",
            "UPDATE orders SET status='completed'",
        ] {
            let db = crate::tests::harness::TestDb::open();
            let conn = db.state.conn.lock().unwrap();
            let input = cancelled_editor_fixture(&conn);
            conn.execute(change, []).unwrap();
            assert_eq!(load(&conn, &input).unwrap()["draft"], input["draft"]);
        }
    }
    #[test]
    fn checkout_existing_order_admission_uses_original_eur_before_legacy_shift_confirmation() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let test = crate::tests::harness::TestDb::open();
        let conn = test.state.conn.lock().unwrap();
        let mut input = seed(&conn);
        for (key, value) in [
            ("currency", "EUR"),
            ("store_currency_branch_id", "branch"),
            ("store_currency_available", "true"),
            ("store_currency_source", "branch_country"),
        ] {
            db::set_setting(&conn, "restaurant", key, value).unwrap();
        }
        conn.execute_batch("INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,status,check_in_time,created_at,updated_at) VALUES('legacy-shift','cashier','branch','11111111-1111-4111-8111-111111111111','cashier','active','now','now','now');
            INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,opening_amount,opened_at,created_at,updated_at) VALUES('legacy-drawer','legacy-shift','cashier','branch','11111111-1111-4111-8111-111111111111',0,'now','now','now');
            INSERT INTO orders(id,organization_id,branch_id,staff_shift_id,items,total_amount,payment_status,status,created_at,updated_at) VALUES('original-order','org','branch','legacy-shift','[]',6,'paid','pending','now','now');
            INSERT INTO order_payments(id,order_id,method,amount,currency,status,created_at,updated_at) VALUES('original-payment','original-order','card',6,'EUR','completed','now','now');").unwrap();
        input["orderId"] = json!("original-order");
        let reply = check_admission(&conn, &input).unwrap();
        assert_eq!(reply["code"], "LEGACY_SHIFT_CURRENCY_CONFIRMATION_REQUIRED");
        assert_eq!(reply["currency"], "EUR");
        assert_eq!(
            conn.query_row(
                "SELECT currency FROM orders WHERE id='original-order'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
            None
        );
        assert_eq!(
            conn.query_row(
                "SELECT currency FROM staff_shifts WHERE id='legacy-shift'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
            None
        );
        conn.execute(
            "UPDATE orders SET currency='CHF' WHERE id='original-order'",
            [],
        )
        .unwrap();
        assert_eq!(
            check_admission(&conn, &input).unwrap_err(),
            "ORDER_CURRENCY_MISMATCH"
        );
        conn.execute(
            "UPDATE orders SET branch_id='foreign' WHERE id='original-order'",
            [],
        )
        .unwrap();
        assert_eq!(
            check_admission(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_SCOPE_CHANGED"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM order_payments", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    fn seed(conn: &Connection) -> Value {
        for (k, v) in [
            ("organization_id", "org"),
            ("branch_id", "branch"),
            ("terminal_id", "11111111-1111-4111-8111-111111111111"),
        ] {
            db::set_setting(conn, "terminal", k, v).unwrap();
        }
        json!({"organizationId":"org","branchId":"branch","terminalId":"11111111-1111-4111-8111-111111111111","expectedGeneration":0,"draft":{"cartItems":[{"name":"Coffee","quantity":2}],"checkoutRequestId":"original"}})
    }
    #[test]
    fn checkout_draft_disk_restart_retains_identity_and_tombstone_fences_late_save() {
        let db = crate::tests::harness::TestDb::open();
        let mut input;
        {
            let conn = db.state.conn.lock().unwrap();
            input = seed(&conn);
            assert_eq!(write(&conn, &input, false).unwrap()["generation"], json!(1));
        }
        let db = db.restart();
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            read(&conn, &scope(&conn, &input).unwrap()).unwrap()["draft"]["checkoutRequestId"],
            json!("original")
        );
        input["expectedGeneration"] = json!(1);
        assert_eq!(write(&conn, &input, true).unwrap()["generation"], json!(2));
        assert_eq!(
            write(&conn, &input, false).unwrap_err(),
            "CHECKOUT_DRAFT_VERSION_CHANGED"
        );
        assert!(read(&conn, &scope(&conn, &input).unwrap()).unwrap()["draft"].is_null());
    }
    #[test]
    fn checkout_draft_rejects_scope_change_and_nested_approval_secrets() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let mut input = seed(&conn);
        input["branchId"] = json!("other");
        assert!(write(&conn, &input, false).is_err());
        input["branchId"] = json!("branch");
        input["draft"]["payment"] = json!({"managerPin":"1234"});
        assert_eq!(
            write(&conn, &input, false).unwrap_err(),
            "CHECKOUT_DRAFT_SECRET_FORBIDDEN"
        );
        assert!(read(&conn, &scope(&conn, &input).unwrap()).unwrap()["draft"].is_null());
    }
    #[test]
    fn checkout_inspection_absence_never_grants_collection() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let mut input = seed(&conn);
        input["clientRequestId"] = json!("original");
        let answer = inspect(&conn, &input).unwrap();
        assert_eq!(answer["outcome"], json!("not_found"));
        assert_eq!(answer["canCollect"], json!(false));
    }

    #[test]
    fn checkout_draft_existing_order_with_uncertain_card_never_reports_saved() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let mut input = seed(&conn);
        input["clientRequestId"] = json!("original");
        conn.execute("INSERT INTO orders(id,client_request_id,status,sync_status,items,total_amount,organization_id,branch_id,owner_terminal_id,created_at,updated_at) VALUES('local-order','original','pending','synced','[]',10,'org','branch',?1,'now','now')",[input["terminalId"].as_str().unwrap()]).unwrap();
        conn.execute("INSERT INTO ecr_devices(id,name,device_type,brand,protocol,connection_type,connection_details) VALUES('terminal-device','Reader','payment_terminal','test','test','network','{}')",[]).unwrap();
        crate::db::ecr_insert_transaction(&conn,&json!({"id":"original-sale","deviceId":"terminal-device","transactionType":"sale","amount":1000,"currency":"CHF","orderId":"original","status":"processing"})).unwrap();
        assert_eq!(
            inspect(&conn, &input).unwrap()["outcome"],
            json!("uncertain")
        );
        conn.execute("UPDATE ecr_transactions SET status='error',receipt_data=json_object('returnedToCustomer',false) WHERE id='original-sale'",[]).unwrap();
        assert_eq!(
            inspect(&conn, &input).unwrap()["outcome"],
            json!("uncertain")
        );
        conn.execute(
            "UPDATE ecr_transactions SET status='approved',receipt_data=json_object('directSaleAdmissionVersion',1) WHERE id='original-sale'",
            [],
        )
        .unwrap();
        assert_eq!(
            inspect(&conn, &input).unwrap()["outcome"],
            json!("uncertain")
        );
        conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,payment_origin,transaction_ref,terminal_device_id,created_at,updated_at) VALUES('payment','local-order','card',10,1000,'CHF','completed','terminal','original-sale','terminal-device','now','now')",[]).unwrap();
        assert_eq!(inspect(&conn, &input).unwrap()["outcome"], json!("saved"));
        let held:crate::unsaved_payments::UnsavedChargedPayment=serde_json::from_value(json!({"idempotencyKey":"held-money","orderId":"local-order","method":"card","amount":2,"amountCents":200,"currency":"CHF","kind":"single","request":{"orderId":"local-order"},"capturedAt":"now"})).unwrap();
        crate::unsaved_payments::record(&conn, &held).unwrap();
        assert_eq!(inspect(&conn, &input).unwrap()["outcome"], json!("held"));
    }

    fn frozen_card(conn: &Connection) -> Value {
        let mut input = seed(conn);
        input["draft"] = json!({"schemaVersion":1,"draftId":"original-draft","checkoutRequestId":"original",
            "phase":"checkout_pending","cartItems":[{"id":"original-item","name":"Coffee","quantity":2,"notes":"without sugar"}],
            "context":{"orderType":"pickup","editMode":false},"state":{"manualDiscountValue":2},
            "submission":{"clientRequestId":"original","paymentData":{"method":"card","amount":10}}});
        write(conn, &input, false).unwrap();
        input["expectedGeneration"] = json!(1);
        input["clientRequestId"] = json!("original");
        input["draftId"] = json!("original-draft");
        conn.execute("INSERT INTO ecr_devices(id,name,device_type,brand,protocol,connection_type,connection_details) VALUES('decline-device','Reader','payment_terminal','test','test','network','{}')",[]).unwrap();
        input
    }

    fn sale(conn: &Connection, id: &str, status: &str) {
        crate::db::ecr_insert_transaction(
            conn,
            &json!({"id":id,"deviceId":"decline-device","transactionType":"fiscal_receipt",
            "amount":1000,"currency":"EUR","orderId":"original","status":status}),
        )
        .unwrap();
    }

    #[test]
    fn checkout_definite_decline_after_restart_explicitly_resumes_cart_without_collecting() {
        let db = crate::tests::harness::TestDb::open();
        let input = {
            let conn = db.state.conn.lock().unwrap();
            let input = frozen_card(&conn);
            sale(&conn, "declined-sale", "declined");
            input
        };
        let db = db.restart();
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            inspect(&conn, &input).unwrap()["outcome"],
            json!("declined")
        );
        let resumed = resume_declined(&conn, &input).unwrap();
        assert_eq!(resumed["generation"], json!(2));
        assert_eq!(resumed["draft"]["cartItems"], input["draft"]["cartItems"]);
        assert_eq!(resumed["draft"]["state"], input["draft"]["state"]);
        assert_eq!(resumed["draft"]["draftId"], json!("original-draft"));
        assert_eq!(resumed["draft"]["phase"], json!("editing"));
        assert_ne!(resumed["draft"]["checkoutRequestId"], json!("original"));
        assert!(resumed["draft"].get("submission").is_none());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM ecr_transactions", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            resume_declined(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_VERSION_CHANGED"
        );
        let mut late = input.clone();
        late["expectedGeneration"] = json!(2);
        assert_eq!(
            write(&conn, &late, false).unwrap_err(),
            "CHECKOUT_REQUEST_ID_CHANGED"
        );
        let mut discard = input.clone();
        discard["expectedGeneration"] = json!(2);
        assert!(write(&conn, &discard, true).unwrap()["draft"].is_null());
    }

    #[test]
    fn checkout_resume_requires_positive_decline_and_rejects_every_unknown_or_mixed_status() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let input = frozen_card(&conn);
        assert_eq!(
            resume_declined(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN"
        );
        sale(&conn, "original-attempt", "declined");
        for status in [
            "pending",
            "processing",
            "timeout",
            "error",
            "cancelled",
            "approved",
        ] {
            sale(&conn, &format!("mixed-{status}"), status);
            assert_eq!(
                resume_declined(&conn, &input).unwrap_err(),
                "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN",
                "{status}"
            );
            conn.execute(
                "DELETE FROM ecr_transactions WHERE id=?1",
                [format!("mixed-{status}")],
            )
            .unwrap();
        }
        let mut stale = input.clone();
        stale["expectedGeneration"] = json!(0);
        assert_eq!(
            resume_declined(&conn, &stale).unwrap_err(),
            "CHECKOUT_DRAFT_VERSION_CHANGED"
        );
        stale = input.clone();
        stale["branchId"] = json!("other-branch");
        assert_eq!(
            resume_declined(&conn, &stale).unwrap_err(),
            "CHECKOUT_DRAFT_SCOPE_CHANGED"
        );
        assert_eq!(
            read(&conn, &scope(&conn, &input).unwrap()).unwrap()["draft"],
            input["draft"]
        );
    }

    #[test]
    fn checkout_resume_rejects_saved_order_held_money_or_orphan_approval_and_rolls_back_failed_update(
    ) {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let input = frozen_card(&conn);
        sale(&conn, "declined-attempt", "declined");
        conn.execute("INSERT INTO orders(id,client_request_id,status,sync_status,items,total_amount,organization_id,branch_id,created_at,updated_at) VALUES('saved-order','original','pending','synced','[]',10,'org','branch','now','now')",[]).unwrap();
        assert_eq!(
            resume_declined(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN"
        );
        conn.execute("DELETE FROM orders WHERE id='saved-order'", [])
            .unwrap();
        let held:crate::unsaved_payments::UnsavedChargedPayment=serde_json::from_value(json!({"idempotencyKey":"held-original","orderId":"original","method":"card","amount":10,"amountCents":1000,"currency":"EUR","kind":"new_order_checkout","request":{"clientRequestId":"original"},"capturedAt":"now"})).unwrap();
        crate::unsaved_payments::record(&conn, &held).unwrap();
        assert_eq!(
            resume_declined(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN"
        );
        crate::unsaved_payments::clear(&conn, "held-original").unwrap();
        db::set_setting(
            &conn,
            "ecr_orphaned_receipts",
            "original",
            "invalid approval marker",
        )
        .unwrap();
        assert_eq!(
            resume_declined(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN"
        );
        db::delete_setting(&conn, "ecr_orphaned_receipts", "original").unwrap();
        conn.execute_batch("CREATE TRIGGER interrupt_resume BEFORE UPDATE ON checkout_drafts_v1 BEGIN SELECT RAISE(ABORT,'interrupted resume'); END;").unwrap();
        assert!(resume_declined(&conn, &input)
            .unwrap_err()
            .contains("interrupted resume"));
        let retained = read(&conn, &scope(&conn, &input).unwrap()).unwrap();
        assert_eq!(retained["generation"], json!(1));
        assert_eq!(retained["draft"], input["draft"]);
    }

    #[test]
    fn checkout_not_sent_requires_exact_native_versioned_scope_and_preserves_mixed_refusal_labels()
    {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let input = frozen_card(&conn);
        sale(&conn, "original-preflight", "not_sent");
        assert_eq!(
            resume_declined(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN"
        );
        let owner = scope(&conn, &input).unwrap();
        let receipt = json!({"initialFiscalAttempt":{"version":1,"organizationId":owner.organization,"branchId":owner.branch,
            "terminalId":owner.terminal,"ownerTerminalId":owner.owner,"orderReference":"original","requestFingerprint":"native-hash"},
            "dispatchProof":"not_sent","notSentReason":"disconnected"});
        for (key, value) in [
            ("version", json!(2)),
            ("organizationId", json!("other")),
            ("branchId", json!("other")),
            ("terminalId", json!("other")),
            ("ownerTerminalId", json!("other")),
            ("orderReference", json!("other")),
            ("requestFingerprint", json!("")),
        ] {
            let mut invalid = receipt.clone();
            invalid["initialFiscalAttempt"][key] = value;
            conn.execute(
                "UPDATE ecr_transactions SET receipt_data=?1 WHERE id='original-preflight'",
                [invalid.to_string()],
            )
            .unwrap();
            assert_eq!(
                resume_declined(&conn, &input).unwrap_err(),
                "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN",
                "{key}"
            );
        }
        let mut invalid = receipt.clone();
        invalid["notSentReason"] = json!("timeout");
        conn.execute(
            "UPDATE ecr_transactions SET receipt_data=?1 WHERE id='original-preflight'",
            [invalid.to_string()],
        )
        .unwrap();
        assert_eq!(
            resume_declined(&conn, &input).unwrap_err(),
            "CHECKOUT_DRAFT_DECLINE_NOT_PROVEN"
        );
        conn.execute(
            "UPDATE ecr_transactions SET receipt_data=?1 WHERE id='original-preflight'",
            [receipt.to_string()],
        )
        .unwrap();
        assert_eq!(
            inspect(&conn, &input).unwrap()["outcome"],
            json!("not_sent")
        );
        sale(&conn, "declined-before-preflight", "declined");
        assert_eq!(
            inspect(&conn, &input).unwrap()["outcome"],
            json!("not_charged")
        );
        assert_eq!(
            resume_declined(&conn, &input).unwrap()["draft"]["phase"],
            json!("editing")
        );
    }
}
