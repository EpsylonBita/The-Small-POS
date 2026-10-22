//! Scoped cart recovery. A deleted draft keeps a CAS tombstone so a late save
//! cannot resurrect an accepted or discarded checkout. Recovery never collects.
use crate::{
    database_lock::run_blocking_command,
    db,
    table_session_cache::{self, Scope},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use tauri::Manager;

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

/// Every draft transaction writes (`read` keeps the slot row), so it takes the
/// write lock first. A DEFERRED one read and then upgraded: SQLite fails that
/// upgrade at once (`database is locked`) while another of this till's
/// connections writes, without waiting `busy_timeout` (Tomikro 21/10/2026,
/// `checkout_save_storage_busy`). IMMEDIATE waits for the lock instead.
fn write_transaction(conn: &Connection) -> Result<Transaction<'_>, String> {
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())
}

fn archive_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS checkout_draft_archive_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        generation INTEGER NOT NULL, draft_json TEXT NOT NULL, reason TEXT NOT NULL, archived_at TEXT NOT NULL,
        PRIMARY KEY(organization_id,branch_id,terminal_id,generation))").map_err(|error|error.to_string())
}

/// Who set a frozen checkout aside, what the till knew of it then, and the
/// money it named (Health lists these; the exact draft is in the archive).
fn park_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS checkout_draft_parks_v1 (
        organization_id TEXT NOT NULL, branch_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        generation INTEGER NOT NULL, checkout_request_id TEXT NOT NULL, outcome TEXT NOT NULL,
        method TEXT, amount REAL, currency TEXT, audit_json TEXT NOT NULL, parked_at TEXT NOT NULL,
        PRIMARY KEY(organization_id,branch_id,terminal_id,generation));",
    )
    .map_err(|error| error.to_string())
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
    let tx = write_transaction(conn)?;
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
    archive_schema(&tx)?;
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
    let tx = write_transaction(conn)?;
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

// Every draft command runs on Tokio's blocking pool, never the window thread
// or a runtime worker: a wait for the connection must not freeze the till or
// stall the runtime (Tomikro 20/10/2026, see database_lock.rs).
#[tauri::command]
pub async fn checkout_draft_check_admission(
    arg0: Value,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("checkout_draft_check_admission", move || {
        let db = app.state::<db::DbState>();
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("checkout_draft_check_admission")
            .map_err(|error| error.to_string())?;
        check_admission(&conn, &arg0)
    })
    .await
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
pub async fn checkout_draft_get(arg0: Value, app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("checkout_draft_get", move || {
        let db = app.state::<db::DbState>();
        get(&db, &arg0)
    })
    .await
}
#[tauri::command]
pub async fn checkout_draft_put(arg0: Value, app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("checkout_draft_put", move || {
        let db = app.state::<db::DbState>();
        put(&db, &arg0)
    })
    .await
}

#[derive(Clone, Copy)]
enum DraftOperation {
    Save,
    Read,
    Delete,
}

// These fixed codes survive the redacted support-log projection, which accepts
// `checkout_<save|read|delete>_<class>` (shared/pos/health/runtime-log-events).
// Never log the native error text or the draft: either can contain customer data.
fn failure_class(error: &str) -> &'static str {
    match error {
        "REPAIR_SCOPE_TRANSITION_PENDING" => "scope_transition",
        "REPAIR_RESET_PENDING" => "reset_pending",
        "REPAIR_STAGING_MAINTENANCE_FAILED" => "maintenance_pending",
        "CHECKOUT_DRAFT_SCOPE_CHANGED" | "CHECKOUT_DRAFT_SCOPE_REQUIRED" => "scope_changed",
        "CHECKOUT_DRAFT_VERSION_CHANGED" | "CHECKOUT_REQUEST_ID_CHANGED" => "version_changed",
        "CHECKOUT_DRAFT_EDIT_TARGET_CANCELLED" => "target_cancelled",
        "CHECKOUT_DRAFT_SECRET_FORBIDDEN"
        | "CHECKOUT_DRAFT_TOO_LARGE"
        | "CHECKOUT_DRAFT_REQUIRED"
        | "CHECKOUT_DRAFT_INVALID"
        | "CHECKOUT_DRAFT_GENERATION_REQUIRED"
        | "CHECKOUT_DRAFT_VERSION_EXHAUSTED" => "invalid",
        "database is locked" | "database table is locked" => "storage_busy",
        "database or disk is full" => "storage_full",
        "attempt to write a readonly database" => "storage_readonly",
        "disk I/O error" => "storage_io",
        _ => "unclassified",
    }
}

fn operation_name(operation: DraftOperation) -> &'static str {
    match operation {
        DraftOperation::Save => "save",
        DraftOperation::Read => "read",
        DraftOperation::Delete => "delete",
    }
}

fn failure_event(operation: DraftOperation, error: &str) -> String {
    format!(
        "checkout_{}_{}",
        operation_name(operation),
        failure_class(error)
    )
}

/// The renderer's own refusal of a checkout save or read, which never became a
/// native error (Tomikro 21/10/2026: a failed freeze left no trace). One fixed
/// code from the allow-listed classes; never text, cart or customer.
fn renderer_failure_event(input: &Value) -> Option<(String, &'static str)> {
    let operation = match input.get("operation").and_then(Value::as_str)? {
        "save" => DraftOperation::Save,
        "read" => DraftOperation::Read,
        _ => return None,
    };
    let class = match input.get("failureClass").and_then(Value::as_str) {
        Some("version_changed") => "version_changed",
        Some("scope_changed") => "scope_changed",
        Some("invalid") => "invalid",
        Some("storage_unavailable") => "storage_unavailable",
        _ => "unclassified",
    };
    let phase = match input.get("draftPhase").and_then(Value::as_str) {
        Some("editing") => "editing",
        Some("checkout_pending") => "checkout_pending",
        _ => "invalid",
    };
    Some((
        format!("checkout_{}_{class}", operation_name(operation)),
        phase,
    ))
}

#[tauri::command]
pub async fn checkout_draft_report_failure(arg0: Value) -> Result<Value, String> {
    let (event_code, phase) =
        renderer_failure_event(&arg0).ok_or("CHECKOUT_DRAFT_REPORT_INVALID")?;
    tracing::warn!(
        event_code = event_code.as_str(),
        draft_phase = phase,
        origin = "renderer",
        "Checkout persistence failed"
    );
    Ok(json!({"success": true}))
}

/// Tomikro 21/10/2026: a failed new-order checkout write left no trace in the
/// support log. Its fixed class (`checkout_create_<class>`), never the native
/// text, the order or the customer; `None` for a saved order.
pub(crate) fn create_failure_class(answer: &Result<Value, String>) -> Option<&'static str> {
    let code = match answer {
        Ok(reply) if reply["success"].as_bool() == Some(true) => return None,
        Ok(reply) => reply["errorCode"]
            .as_str()
            .or_else(|| reply["error"].as_str())
            .unwrap_or_default(),
        Err(error) => error.as_str(),
    };
    let upper = code.to_ascii_uppercase();
    Some(match code {
        crate::commands::orders::CHECKOUT_IN_PROGRESS => "in_progress",
        "FISCAL_CHECKOUT_NOT_APPROVED" => "fiscal_not_approved",
        "CARD_CONFIRMATION_REFUSED" => "card_confirmation_refused",
        crate::unsaved_payments::PAYMENT_NOT_SAVED_ERROR_CODE
        | crate::unsaved_payments::PAYMENT_NOT_SAVED_PENDING_ERROR_CODE => "payment_not_saved",
        _ if upper.contains("DATABASE IS LOCKED") || upper.contains("DATABASE TABLE IS LOCKED") => {
            "storage_busy"
        }
        _ if upper.contains("DISK IS FULL") || upper.contains("DATABASE OR DISK IS FULL") => {
            "storage_full"
        }
        _ if upper.contains("READONLY") => "storage_readonly",
        _ if upper.contains("DISK I/O") => "storage_io",
        _ if upper.contains("CURRENCY") => "currency_unavailable",
        _ if upper.contains("SHIFT") || upper.contains("CASHIER") => "shift_required",
        _ if upper.contains("SCOPE") || upper.contains("REPAIR_") => "scope_changed",
        _ => "unclassified",
    })
}

/// One fixed-code warning per failed new-order checkout write.
pub(crate) fn log_create_failure(answer: &Result<Value, String>) {
    if let Some(class) = create_failure_class(answer) {
        let event_code = format!("checkout_create_{class}");
        tracing::warn!(
            event_code = event_code.as_str(),
            "Checkout order write failed"
        );
    }
}

fn save_failure_event(error: &str) -> String {
    failure_event(DraftOperation::Save, error)
}

/// Read, save and delete all refuse first on the binding lease. Each rejection
/// gets one fixed-code warning so a support bundle can name the refusal.
fn logged(
    operation: DraftOperation,
    phase: Option<&'static str>,
    run: impl FnOnce() -> Result<Value, String>,
) -> Result<Value, String> {
    let result = run();
    if let Err(error) = &result {
        let event_code = failure_event(operation, error);
        match phase {
            Some(phase) => tracing::warn!(
                event_code = event_code.as_str(),
                draft_phase = phase,
                "Checkout persistence failed"
            ),
            None => tracing::warn!(
                event_code = event_code.as_str(),
                "Checkout persistence failed"
            ),
        }
    }
    result
}

fn get(db: &db::DbState, input: &Value) -> Result<Value, String> {
    logged(DraftOperation::Read, None, || {
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("checkout_draft_get")
            .map_err(|e| e.to_string())?;
        db::with_full_sync(&conn, |conn| load(conn, input))
    })
}

fn put(db: &db::DbState, input: &Value) -> Result<Value, String> {
    let phase = match input["draft"]["phase"].as_str() {
        Some("editing") => "editing",
        Some("checkout_pending") => "checkout_pending",
        _ => "invalid",
    };
    logged(DraftOperation::Save, Some(phase), || {
        // This exact lease refusal precedes every write. The live renderer may
        // briefly retry it with the same request; other failures are ambiguous.
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("checkout_draft_put")
            .map_err(|e| e.to_string())?;
        db::with_full_sync(&conn, |conn| write(conn, input, false))
    })
}

fn delete(db: &db::DbState, input: &Value) -> Result<Value, String> {
    logged(DraftOperation::Delete, None, || {
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("checkout_draft_delete")
            .map_err(|e| e.to_string())?;
        db::with_full_sync(&conn, |conn| write(conn, input, true))
    })
}
#[tauri::command]
pub async fn checkout_draft_delete(arg0: Value, app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("checkout_draft_delete", move || {
        let db = app.state::<db::DbState>();
        delete(&db, &arg0)
    })
    .await
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
    let tx = write_transaction(conn)?;
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
pub async fn checkout_draft_resume_declined(
    arg0: Value,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    run_blocking_command("checkout_draft_resume_declined", move || {
        let db = app.state::<db::DbState>();
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("checkout_draft_resume_declined")
            .map_err(|error| error.to_string())?;
        db::with_full_sync(&conn, |conn| resume_declined(conn, &arg0))
    })
    .await
}

fn orphaned_approval(conn: &Connection, request: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_settings WHERE setting_category='ecr_orphaned_receipts' AND setting_key=?1)",
        [request],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Tomikro 21/10/2026: whether a new-order card for `request` can only have
/// been charged outside this till. No terminal row of any status and no
/// orphaned approval names it, and no cash register would charge the card
/// (the fiscal checkout's own device selection). A failed lookup is never
/// "no device".
pub(crate) fn card_charge_outside_till_only(
    conn: &Connection,
    request: &str,
) -> Result<bool, String> {
    let rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM ecr_transactions WHERE order_id=?1",
            [request],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if rows != 0 || orphaned_approval(conn, request)? {
        return Ok(false);
    }
    Ok(db::ecr_try_get_default_device(conn, Some("cash_register"))?.is_none())
}

/// The cashier's answer that a separate bank POS charged this card. It is
/// recorded as collected and never reaches a terminal.
pub(crate) fn is_cashier_confirmed_card(payment: &Value) -> bool {
    let method = payment
        .get("method")
        .or_else(|| payment.get("paymentMethod"))
        .or_else(|| payment.get("payment_method"))
        .and_then(Value::as_str)
        .map(|method| method.trim().to_ascii_lowercase());
    method.as_deref() == Some("card")
        && payment["metadata"]["confirmation"].as_str() == Some("cashier")
        && payment["metadata"]["confirmation_action"].as_str() == Some("card_charged_outside_till")
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
    } else if orphaned_approval(conn, request)? {
        // The register approved this attempt but its audit row was lost: the
        // money may have moved, so it is never "nothing found".
        "uncertain"
    } else if let Some(refusal) = refusal_outcome(conn, &scope, request)? {
        refusal
    } else {
        "not_found"
    };
    // Nothing on this till could have charged a card for it: only the cashier
    // can say what the bank POS shows. A failed lookup offers no such answer.
    let cashier_can_confirm_card =
        outcome == "not_found" && card_charge_outside_till_only(conn, request).unwrap_or(false);
    Ok(
        json!({"success":true,"outcome":outcome,"orderId":order,"payments":payments,"ecr":ecr,"canCollect":false,
            "cashierCanConfirmCard":cashier_can_confirm_card}),
    )
}
#[tauri::command]
pub async fn checkout_draft_inspect(arg0: Value, app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("checkout_draft_inspect", move || {
        let db = app.state::<db::DbState>();
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("checkout_draft_inspect")
            .map_err(|e| e.to_string())?;
        let mut reply = inspect(&conn, &arg0)?;
        // A press still running may yet write its order: nothing is released
        // while it runs (Tomikro 21/10/2026).
        if let Some(request) = arg0.get("clientRequestId").and_then(Value::as_str) {
            reply["checkoutInProgress"] =
                json!(crate::commands::orders::checkout_in_progress(&db, request));
        }
        Ok(reply)
    })
    .await
}

struct ParkCandidate {
    scope: Scope,
    generation: i64,
    draft: Value,
    request: String,
    outcome: String,
}

/// The exact frozen attempt a manager may set aside, re-proved from the
/// slot itself: the generation, draft and request must all still match, and
/// an attempt the till proves saved is finished by recovery, never parked.
fn park_candidate(conn: &Connection, input: &Value) -> Result<ParkCandidate, String> {
    let scope = scope(conn, input)?;
    let generation = input
        .get("expectedGeneration")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or("CHECKOUT_DRAFT_GENERATION_REQUIRED")?;
    let request = input
        .get("clientRequestId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 255)
        .ok_or("CHECKOUT_REQUEST_ID_REQUIRED")?
        .to_string();
    let draft_id = input
        .get("draftId")
        .and_then(Value::as_str)
        .ok_or("CHECKOUT_DRAFT_REQUIRED")?;
    let previous = read(conn, &scope)?;
    if previous["generation"].as_i64() != Some(generation) {
        return Err("CHECKOUT_DRAFT_VERSION_CHANGED".into());
    }
    let draft = previous["draft"].clone();
    if draft["phase"].as_str() != Some("checkout_pending")
        || draft["draftId"].as_str() != Some(draft_id)
        || draft["checkoutRequestId"].as_str() != Some(request.as_str())
    {
        return Err("CHECKOUT_DRAFT_CHANGED".into());
    }
    let mut probe = json!({"organizationId":input["organizationId"],"branchId":input["branchId"],
        "terminalId":input["terminalId"],"clientRequestId":request});
    if draft["context"]["editMode"].as_bool() == Some(true) {
        probe["editOrderId"] = draft["context"]["editOrderId"].clone();
        probe["clientEventId"] = json!(draft["submission"]["client_event_id"]
            .as_str()
            .unwrap_or(request.as_str()));
    }
    let outcome = inspect(conn, &probe)?["outcome"]
        .as_str()
        .unwrap_or("uncertain")
        .to_string();
    if outcome == "saved" {
        return Err("CHECKOUT_DRAFT_PARK_NOT_NEEDED".into());
    }
    Ok(ParkCandidate {
        scope,
        generation,
        draft,
        request,
        outcome,
    })
}

/// A lost acknowledgement retried: this exact attempt was already parked.
fn parked_replay(conn: &Connection, input: &Value) -> Result<Option<Value>, String> {
    let scope = scope(conn, input)?;
    park_schema(conn)?;
    let (Some(generation), Some(request)) = (
        input.get("expectedGeneration").and_then(Value::as_i64),
        input.get("clientRequestId").and_then(Value::as_str),
    ) else {
        return Ok(None);
    };
    let outcome: Option<String> = conn
        .query_row(
            "SELECT outcome FROM checkout_draft_parks_v1 WHERE organization_id=?1 AND branch_id=?2
            AND terminal_id=?3 AND generation=?4 AND checkout_request_id=?5",
            params![
                scope.organization,
                scope.branch,
                scope.terminal,
                generation,
                request
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(outcome) = outcome else {
        return Ok(None);
    };
    let mut reply = read(conn, &scope)?;
    reply["parked"] = json!({"outcome":outcome,"generation":generation,"replayed":true});
    Ok(Some(reply))
}

/// Archive the exact draft, record the approval and free the slot in one
/// transaction. Orders, payments, terminal rows and held payments are never
/// touched: each keeps its own recovery.
fn park_write(conn: &Connection, input: &Value, approval: &Value) -> Result<Value, String> {
    let tx = write_transaction(conn)?;
    if let Some(replayed) = parked_replay(&tx, input)? {
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(replayed);
    }
    let candidate = park_candidate(&tx, input)?;
    let scope = &candidate.scope;
    archive_schema(&tx)?;
    let next = candidate
        .generation
        .checked_add(1)
        .ok_or("CHECKOUT_DRAFT_VERSION_EXHAUSTED")?;
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO checkout_draft_archive_v1 VALUES(?1,?2,?3,?4,?5,'manager_parked',?6)",
        params![
            scope.organization,
            scope.branch,
            scope.terminal,
            candidate.generation,
            candidate.draft.to_string(),
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    let submission = &candidate.draft["submission"];
    let payment = &submission["paymentData"];
    let amount = payment["amount"]
        .as_f64()
        .filter(|amount| *amount > 0.0)
        .or_else(|| submission["total"].as_f64());
    // A card request names no currency: it is the store's.
    let currency = payment["currency"]
        .as_str()
        .map(ToString::to_string)
        .or_else(|| db::get_setting(&tx, "restaurant", "currency"));
    let audit =
        json!({"decision":"parked","outcome":candidate.outcome,"approval":approval,"at":now});
    tx.execute(
        "INSERT INTO checkout_draft_parks_v1 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            scope.organization,
            scope.branch,
            scope.terminal,
            candidate.generation,
            candidate.request,
            candidate.outcome,
            payment["method"].as_str(),
            amount,
            currency,
            audit.to_string(),
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    let changed = tx
        .execute(
            "UPDATE checkout_drafts_v1 SET generation=?1,draft_json=NULL,updated_at=?2
            WHERE organization_id=?3 AND branch_id=?4 AND terminal_id=?5 AND generation=?6",
            params![
                next,
                now,
                scope.organization,
                scope.branch,
                scope.terminal,
                candidate.generation
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("CHECKOUT_DRAFT_VERSION_CHANGED".into());
    }
    let mut reply = read(&tx, scope)?;
    reply["parked"] = json!({"outcome":candidate.outcome,"generation":candidate.generation});
    tx.commit().map_err(|error| error.to_string())?;
    Ok(reply)
}

/// Tomikro 21/10/2026: one frozen card checkout with no evidence anywhere
/// blocked every new order, because this slot holds one draft per terminal.
/// A manager sets aside what recovery cannot settle. The proof is checked
/// before the approval is asked (a refused park never consumes a grant) and
/// again under the lock. Only a holder of the void-payments right approves
/// (review 22/10/2026, Android parity): the staff member on shift whose store
/// role grants it, else that right holder's own PIN.
fn park(db: &db::DbState, auth: &crate::auth::AuthState, input: &Value) -> Result<Value, String> {
    {
        let _lease = crate::repairs::acquire_terminal_binding_lease()?;
        let conn = db
            .lock_traced("checkout_draft_park")
            .map_err(|error| error.to_string())?;
        if let Some(replayed) = parked_replay(&conn, input)? {
            return Ok(replayed);
        }
        park_candidate(&conn, input)?;
    }
    let approver = crate::auth::authorize_permitted_money_action(
        crate::auth::MoneyApproval::VoidPayments,
        db,
        auth,
    )
    .map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()))?;
    let session = crate::auth::get_session_json(auth);
    let approved_by = approver.manager_staff_id.clone().or_else(|| {
        ["databaseStaffId", "staffId"].iter().find_map(|key| {
            session
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
    });
    let approval = json!({"approvedBy":approved_by,"via":approver.via});
    let _lease = crate::repairs::acquire_terminal_binding_lease()?;
    let conn = db
        .lock_traced("checkout_draft_park")
        .map_err(|error| error.to_string())?;
    db::with_full_sync(&conn, |conn| park_write(conn, input, &approval))
}

#[tauri::command]
pub async fn checkout_draft_park(arg0: Value, app: tauri::AppHandle) -> Result<Value, String> {
    run_blocking_command("checkout_draft_park", move || {
        let db = app.state::<db::DbState>();
        let auth = app.state::<crate::auth::AuthState>();
        park(&db, &auth, &arg0)
    })
    .await
}

/// Health: the attempts parked on this terminal in the last day, without any
/// customer data, so a manager checks each against the bank POS.
pub(crate) fn recent_parks(conn: &Connection) -> Result<Value, String> {
    let Ok(scope) = table_session_cache::current_scope(conn) else {
        // No bound terminal: no checkout can have been parked for it.
        return Ok(json!({"count":0,"details":[]}));
    };
    park_schema(conn)?;
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    let mut statement = conn
        .prepare(
            "SELECT generation,outcome,method,amount,currency,parked_at FROM checkout_draft_parks_v1
            WHERE organization_id=?1 AND branch_id=?2 AND terminal_id=?3 AND parked_at>=?4
            ORDER BY parked_at DESC LIMIT 20",
        )
        .map_err(|error| error.to_string())?;
    let details = statement
        .query_map(
            params![scope.organization, scope.branch, scope.terminal, since],
            |row| {
                Ok(json!({"generation":row.get::<_, i64>(0)?,"outcome":row.get::<_, String>(1)?,
                    "method":row.get::<_, Option<String>>(2)?,"amount":row.get::<_, Option<f64>>(3)?,
                    "currency":row.get::<_, Option<String>>(4)?,"parkedAt":row.get::<_, String>(5)?}))
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(json!({"count":details.len(),"details":details}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[serial_test::serial]
    fn checkout_save_transition_gate_rejects_before_writing_the_frozen_request() {
        // A real POS install's keyring must not decide this gate.
        let _keyring = crate::tests::fake_keyring::install_seeded([(
            "terminal_id",
            "11111111-1111-4111-8111-111111111111",
        )]);
        let isolation = crate::repairs::isolate_lifecycle_for_test();
        let db = crate::tests::harness::TestDb::open();
        let mut input = seed(&db.state.conn.lock().unwrap());
        input["draft"]["phase"] = json!("checkout_pending");
        crate::repairs::latch_startup_access_pending().unwrap();

        assert_eq!(
            put(&db.state, &input).unwrap_err(),
            "REPAIR_SCOPE_TRANSITION_PENDING"
        );
        let before = load(&db.state.conn.lock().unwrap(), &input).unwrap();
        assert_eq!(before["generation"], 0);
        assert!(before["draft"].is_null());

        // Simulate the authority owner releasing its gate. The original body
        // and CAS can now commit exactly once; a duplicate still cannot write.
        isolation.reset();
        let saved = put(&db.state, &input).unwrap();
        assert_eq!(saved["generation"], 1);
        assert_eq!(saved["draft"], input["draft"]);
        assert_eq!(
            put(&db.state, &input).unwrap_err(),
            "CHECKOUT_DRAFT_VERSION_CHANGED"
        );
        assert_eq!(load(&db.state.conn.lock().unwrap(), &input).unwrap(), saved);
        let conn = db.state.conn.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM orders", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM order_payments", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn checkout_save_failure_evidence_is_fixed_and_does_not_expose_native_errors() {
        for (error, expected) in [
            (
                "REPAIR_SCOPE_TRANSITION_PENDING",
                "checkout_save_scope_transition",
            ),
            ("REPAIR_RESET_PENDING", "checkout_save_reset_pending"),
            (
                "REPAIR_STAGING_MAINTENANCE_FAILED",
                "checkout_save_maintenance_pending",
            ),
            (
                "CHECKOUT_DRAFT_SCOPE_CHANGED",
                "checkout_save_scope_changed",
            ),
            (
                "CHECKOUT_DRAFT_VERSION_CHANGED",
                "checkout_save_version_changed",
            ),
            ("CHECKOUT_DRAFT_SECRET_FORBIDDEN", "checkout_save_invalid"),
            ("database is locked", "checkout_save_storage_busy"),
            ("database or disk is full", "checkout_save_storage_full"),
            (
                "attempt to write a readonly database",
                "checkout_save_storage_readonly",
            ),
            ("disk I/O error", "checkout_save_storage_io"),
            (
                "REPAIR_SCOPE_TRANSITION_PENDING customer PII_CANARY SECRET_CANARY",
                "checkout_save_unclassified",
            ),
            (
                "arbitrary native error PII_CANARY SECRET_CANARY",
                "checkout_save_unclassified",
            ),
        ] {
            assert_eq!(save_failure_event(error), expected);
        }
    }

    #[test]
    #[serial_test::serial]
    fn checkout_read_and_delete_refusals_get_their_own_fixed_codes() {
        for (operation, error, expected) in [
            (
                DraftOperation::Read,
                "REPAIR_SCOPE_TRANSITION_PENDING",
                "checkout_read_scope_transition",
            ),
            (
                DraftOperation::Read,
                "database is locked",
                "checkout_read_storage_busy",
            ),
            (
                DraftOperation::Delete,
                "REPAIR_STAGING_MAINTENANCE_FAILED",
                "checkout_delete_maintenance_pending",
            ),
            (
                DraftOperation::Delete,
                "CHECKOUT_DRAFT_VERSION_CHANGED",
                "checkout_delete_version_changed",
            ),
            (
                DraftOperation::Read,
                "arbitrary native error PII_CANARY",
                "checkout_read_unclassified",
            ),
        ] {
            assert_eq!(failure_event(operation, error), expected);
        }

        // The lease refusal precedes the read and the delete as it does the save.
        let _keyring = crate::tests::fake_keyring::install_seeded([(
            "terminal_id",
            "11111111-1111-4111-8111-111111111111",
        )]);
        let _isolation = crate::repairs::isolate_lifecycle_for_test();
        let db = crate::tests::harness::TestDb::open();
        let input = seed(&db.state.conn.lock().unwrap());
        crate::repairs::latch_startup_access_pending().unwrap();
        assert_eq!(
            get(&db.state, &input).unwrap_err(),
            "REPAIR_SCOPE_TRANSITION_PENDING"
        );
        assert_eq!(
            delete(&db.state, &input).unwrap_err(),
            "REPAIR_SCOPE_TRANSITION_PENDING"
        );
    }

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

    // Tomikro 21/10/2026: a card admitted before the till closed, and nothing
    // anywhere on the till. Only then may the cashier answer from the bank POS.
    #[test]
    fn checkout_admitted_card_without_any_evidence_is_only_the_cashiers_to_confirm() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let input = frozen_card(&conn);
        let answer = inspect(&conn, &input).unwrap();
        assert_eq!(answer["outcome"], json!("not_found"));
        assert_eq!(answer["cashierCanConfirmCard"], json!(true));
        assert_eq!(answer["canCollect"], json!(false));

        // A cash register that would charge the card has no record of it: the
        // card was not charged through this till, so there is nothing to confirm.
        conn.execute("INSERT INTO ecr_devices(id,name,device_type,brand,protocol,connection_type,connection_details,is_default,enabled) VALUES('register','Register','cash_register','test','test','network','{}',1,1)",[]).unwrap();
        crate::device_admission::admit_for_test(&conn, &[crate::device_admission::CASH_REGISTER]);
        let answer = inspect(&conn, &input).unwrap();
        assert_eq!(answer["outcome"], json!("not_found"));
        assert_eq!(answer["cashierCanConfirmCard"], json!(false));
        conn.execute("DELETE FROM ecr_devices WHERE id='register'", [])
            .unwrap();
        assert_eq!(
            inspect(&conn, &input).unwrap()["cashierCanConfirmCard"],
            json!(true)
        );

        // A terminal row of any status names it, even one given back.
        crate::db::ecr_insert_transaction(&conn,&json!({"id":"returned-sale","deviceId":"decline-device","transactionType":"sale","amount":1000,"currency":"EUR","orderId":"original","status":"approved"})).unwrap();
        conn.execute("UPDATE ecr_transactions SET receipt_data=json_object('returnedToCustomer',1) WHERE id='returned-sale'",[]).unwrap();
        let answer = inspect(&conn, &input).unwrap();
        assert_eq!(answer["cashierCanConfirmCard"], json!(false));
        conn.execute("DELETE FROM ecr_transactions", []).unwrap();

        // An orphaned register approval is money that may have moved.
        db::set_setting(&conn, "ecr_orphaned_receipts", "original", "{}").unwrap();
        let answer = inspect(&conn, &input).unwrap();
        assert_eq!(answer["outcome"], json!("uncertain"));
        assert_eq!(answer["cashierCanConfirmCard"], json!(false));
    }

    #[test]
    fn checkout_cashier_confirmation_is_only_a_card_with_the_exact_answer() {
        let confirmed = json!({"method":"card","metadata":{"confirmation":"cashier","confirmation_action":"card_charged_outside_till"}});
        assert!(is_cashier_confirmed_card(&confirmed));
        for changed in [
            json!({"method":"cash","metadata":{"confirmation":"cashier","confirmation_action":"card_charged_outside_till"}}),
            json!({"method":"card","metadata":{"confirmation":"cashier","confirmation_action":"confirm"}}),
            json!({"method":"card","metadata":{"confirmation":"terminal","confirmation_action":"card_charged_outside_till"}}),
            json!({"method":"card"}),
        ] {
            assert!(!is_cashier_confirmed_card(&changed), "{changed}");
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn checkout_park_archives_the_exact_attempt_frees_the_slot_and_touches_no_money() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let input = frozen_card(&conn);
        // Evidence and money that keep their own recovery.
        crate::db::ecr_insert_transaction(&conn,&json!({"id":"unknown-sale","deviceId":"decline-device","transactionType":"sale","amount":1000,"currency":"EUR","orderId":"original","status":"processing"})).unwrap();
        let held:crate::unsaved_payments::UnsavedChargedPayment=serde_json::from_value(json!({"idempotencyKey":"held-original","orderId":"original","method":"card","amount":10,"amountCents":1000,"currency":"EUR","kind":"new_order_checkout","request":{"organization_id":"org","branch_id":"branch","clientRequestId":"original"},"capturedAt":"now"})).unwrap();
        crate::unsaved_payments::record(&conn, &held).unwrap();
        assert_eq!(inspect(&conn, &input).unwrap()["outcome"], json!("held"));

        let approval = json!({"approvedBy":"manager-1","via":"manager_pin"});
        let reply = park_write(&conn, &input, &approval).unwrap();
        assert!(reply["draft"].is_null());
        assert_eq!(reply["generation"], json!(2));
        assert_eq!(reply["parked"]["outcome"], json!("held"));
        let (archived, reason): (String, String) = conn
            .query_row(
                "SELECT draft_json,reason FROM checkout_draft_archive_v1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&archived).unwrap(),
            input["draft"]
        );
        assert_eq!(reason, "manager_parked");
        let (request, method, amount, audit): (String, String, f64, String) = conn
            .query_row(
                "SELECT checkout_request_id,method,amount,audit_json FROM checkout_draft_parks_v1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (request.as_str(), method.as_str(), amount),
            ("original", "card", 10.0)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&audit).unwrap()["approval"],
            approval
        );
        assert_eq!(count(&conn, "SELECT count(*) FROM ecr_transactions"), 1);
        assert_eq!(crate::unsaved_payments::list(&conn, None).unwrap().len(), 1);

        // The parked attempt can never be written back; the slot is free.
        assert_eq!(
            write(&conn, &input, false).unwrap_err(),
            "CHECKOUT_DRAFT_VERSION_CHANGED"
        );
        // A lost acknowledgement retried is the same park, not a second one.
        let replay = park_write(&conn, &input, &approval).unwrap();
        assert_eq!(replay["parked"]["replayed"], json!(true));
        assert!(replay["draft"].is_null());
        assert_eq!(
            count(&conn, "SELECT count(*) FROM checkout_draft_parks_v1"),
            1
        );
        assert_eq!(
            count(&conn, "SELECT count(*) FROM checkout_draft_archive_v1"),
            1
        );
        let mut next = input.clone();
        next["expectedGeneration"] = json!(2);
        next["draft"] = json!({"schemaVersion":1,"draftId":"next-draft","checkoutRequestId":"next","phase":"editing",
            "cartItems":[],"context":{"orderType":"pickup"},"state":{}});
        assert_eq!(write(&conn, &next, false).unwrap()["generation"], json!(3));

        // Health lists it with its money and no customer data.
        let parks = recent_parks(&conn).unwrap();
        assert_eq!(parks["count"], json!(1));
        assert_eq!(parks["details"][0]["method"], json!("card"));
        assert_eq!(parks["details"][0]["amount"], json!(10.0));
        assert_eq!(parks["details"][0]["outcome"], json!("held"));
        assert!(!parks.to_string().contains("Coffee") && !parks.to_string().contains("sugar"));
    }

    #[test]
    fn checkout_park_refuses_a_saved_editable_stale_or_foreign_attempt() {
        let db = crate::tests::harness::TestDb::open();
        let conn = db.state.conn.lock().unwrap();
        let input = frozen_card(&conn);
        let approval = json!({"approvedBy":"manager-1","via":"manager_pin"});
        conn.execute("INSERT INTO orders(id,client_request_id,status,sync_status,items,total_amount,organization_id,branch_id,owner_terminal_id,created_at,updated_at) VALUES('saved-order','original','pending','synced','[]',10,'org','branch',?1,'now','now')",[input["terminalId"].as_str().unwrap()]).unwrap();
        assert_eq!(
            park_write(&conn, &input, &approval).unwrap_err(),
            "CHECKOUT_DRAFT_PARK_NOT_NEEDED"
        );
        conn.execute("DELETE FROM orders", []).unwrap();
        for (key, value, error) in [
            (
                "expectedGeneration",
                json!(0),
                "CHECKOUT_DRAFT_VERSION_CHANGED",
            ),
            (
                "clientRequestId",
                json!("another"),
                "CHECKOUT_DRAFT_CHANGED",
            ),
            ("draftId", json!("another"), "CHECKOUT_DRAFT_CHANGED"),
            ("branchId", json!("another"), "CHECKOUT_DRAFT_SCOPE_CHANGED"),
        ] {
            let mut changed = input.clone();
            changed[key] = value;
            assert_eq!(
                park_write(&conn, &changed, &approval).unwrap_err(),
                error,
                "{key}"
            );
        }
        // An editable cart is the cashier's to change or discard, never parked.
        let mut editable = input.clone();
        editable["draft"]["phase"] = json!("editing");
        editable["draft"]
            .as_object_mut()
            .unwrap()
            .remove("submission");
        assert_eq!(
            write(&conn, &editable, false).unwrap()["generation"],
            json!(2)
        );
        let mut fresh = input.clone();
        fresh["expectedGeneration"] = json!(2);
        assert_eq!(
            park_write(&conn, &fresh, &approval).unwrap_err(),
            "CHECKOUT_DRAFT_CHANGED"
        );
        // Every refusal rolled back, its audit table included.
        park_schema(&conn).unwrap();
        assert_eq!(
            count(&conn, "SELECT count(*) FROM checkout_draft_parks_v1"),
            0
        );
        assert_eq!(
            read(&conn, &scope(&conn, &input).unwrap()).unwrap()["draft"],
            editable["draft"]
        );
    }

    #[test]
    #[serial_test::serial]
    fn checkout_park_asks_approval_only_after_the_proof_and_writes_nothing_without_it() {
        let _isolation = crate::repairs::isolate_lifecycle_for_test();
        let _keyring = crate::tests::fake_keyring::install_seeded([(
            "terminal_id",
            "11111111-1111-4111-8111-111111111111",
        )]);
        let db = crate::tests::harness::TestDb::open();
        let input = frozen_card(&db.state.conn.lock().unwrap());
        let auth = crate::auth::AuthState::new();
        // No approval (no session): nothing is parked.
        let refused = park(&db.state, &auth, &input).unwrap_err();
        assert!(refused.contains("Active session required"), "{refused}");
        // A saved attempt is refused before any approval is asked.
        db.state.conn.lock().unwrap().execute("INSERT INTO orders(id,client_request_id,status,sync_status,items,total_amount,organization_id,branch_id,owner_terminal_id,created_at,updated_at) VALUES('saved-order','original','pending','synced','[]',10,'org','branch',?1,'now','now')",[input["terminalId"].as_str().unwrap()]).unwrap();
        assert_eq!(
            park(&db.state, &auth, &input).unwrap_err(),
            "CHECKOUT_DRAFT_PARK_NOT_NEEDED"
        );
        let conn = db.state.conn.lock().unwrap();
        let retained = read(&conn, &scope(&conn, &input).unwrap()).unwrap();
        assert_eq!(retained["generation"], json!(1));
        assert_eq!(retained["draft"], input["draft"]);
        assert_eq!(
            count(&conn, "SELECT count(*) FROM checkout_draft_parks_v1"),
            0
        );
    }

    /// A till whose session was opened with the terminal staff PIN (4321) and
    /// whose cashier on shift holds `cashier_rights`; a manager holds the
    /// void-payments right (2468).
    fn park_with_cashier_on_shift(
        cashier_rights: &[&str],
    ) -> (
        crate::repairs::RepairLifecycleTestIsolation,
        crate::tests::fake_keyring::Guard,
        crate::tests::harness::TestDb,
        crate::auth::AuthState,
        Value,
    ) {
        let isolation = crate::repairs::isolate_lifecycle_for_test();
        let keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "11111111-1111-4111-8111-111111111111"),
            ("branch_id", "branch"),
        ]);
        let db = crate::tests::harness::TestDb::open();
        let input = {
            let conn = db.state.conn.lock().unwrap();
            let input = frozen_card(&conn);
            db::set_setting(
                &conn,
                "staff",
                "staff_pin_hash",
                &bcrypt::hash("4321", 4).unwrap(),
            )
            .unwrap();
            let entry = |id: &str, pin: &str, rights: &[&str]| {
                json!({"id":id,"canLoginPos":true,"isActive":true,"hasPin":true,
                    "pinHash":bcrypt::hash(pin, 4).unwrap(),"permissions":rights})
            };
            let directory = json!({"version":1,"branch_id":"branch","staff":[
                entry("staff-cashier", "1357", cashier_rights),
                entry("staff-manager", "2468", &["pos.refunds.process"]),
            ]});
            db::set_setting(
                &conn,
                "staff_auth_cache",
                "branch_branch",
                &directory.to_string(),
            )
            .unwrap();
            conn.execute(
                "INSERT INTO staff_shifts (id, staff_id, staff_name, branch_id, terminal_id,
                    role_type, check_in_time, opening_cash_amount, opening_cash_amount_cents,
                    status, sync_status, created_at, updated_at, currency)
                 VALUES ('shift-open', 'staff-cashier', 'Cashier', 'branch', ?1, 'cashier',
                         '2026-10-22T08:00:00Z', 0, 0, 'active', 'pending',
                         '2026-10-22T08:00:00Z', '2026-10-22T08:00:00Z', 'EUR')",
                [input["terminalId"].as_str().unwrap()],
            )
            .unwrap();
            input
        };
        let auth = crate::auth::AuthState::new();
        crate::auth::login(Some(json!({"pin":"4321"})), &db.state, &auth)
            .expect("the terminal staff login");
        (isolation, keyring, db, auth, input)
    }

    fn confirm_park_pin(
        db: &crate::tests::harness::TestDb,
        auth: &crate::auth::AuthState,
        pin: &str,
        approval: Option<&str>,
    ) -> Result<Value, crate::auth::PrivilegedActionError> {
        let mut payload = json!({"pin":pin,"scope":"cash_drawer_control"});
        if let Some(approval) = approval {
            payload["approval"] = json!(approval);
        }
        crate::auth::confirm_privileged_action(Some(payload), &db.state, auth)
    }

    fn park_audit(db: &crate::tests::harness::TestDb) -> Vec<Value> {
        let conn = db.state.conn.lock().unwrap();
        park_schema(&conn).unwrap();
        let mut statement = conn
            .prepare("SELECT audit_json FROM checkout_draft_parks_v1")
            .unwrap();
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| serde_json::from_str::<Value>(&row.unwrap()).unwrap()["approval"].clone())
            .collect();
        rows
    }

    /// Review 22/10/2026: the park took any session's fresh PIN, so a cashier
    /// without the void-payments right could set a checkout aside. Android
    /// asks `resolvePrivilegedStaffId(['void_payments'])`.
    #[test]
    #[serial_test::serial]
    fn checkout_park_by_a_cashier_without_the_right_needs_a_right_holders_own_pin() {
        let (_isolation, _keyring, db, auth, input) =
            park_with_cashier_on_shift(&["pos.orders.create"]);
        // The session PIN, the approval the park used to accept, is not enough.
        confirm_park_pin(&db, &auth, "4321", None).expect("the session PIN");
        let asked: Value = serde_json::from_str(&park(&db.state, &auth, &input).unwrap_err())
            .expect("a structured approval request");
        assert_eq!(asked["code"], json!("REAUTH_REQUIRED"), "{asked}");
        assert_eq!(asked["approval"], json!("void_payments"), "{asked}");
        assert!(park_audit(&db).is_empty());
        // The cashier's own PIN cannot approve it.
        assert!(confirm_park_pin(&db, &auth, "1357", Some("void_payments")).is_err());
        assert!(park(&db.state, &auth, &input).is_err());
        assert!(park_audit(&db).is_empty());
        // A right holder's own PIN approves it once and is named.
        let approved = confirm_park_pin(&db, &auth, "2468", Some("void_payments"))
            .expect("the manager approves");
        assert_eq!(approved["approvedBy"], json!("staff-manager"));
        park(&db.state, &auth, &input).expect("parked");
        assert_eq!(
            park_audit(&db),
            vec![json!({"approvedBy":"staff-manager","via":"manager_pin"})]
        );
    }

    #[test]
    #[serial_test::serial]
    fn checkout_park_by_a_cashier_who_holds_the_right_needs_only_a_fresh_pin() {
        let (_isolation, _keyring, db, auth, input) =
            park_with_cashier_on_shift(&["pos.orders.create", "pos.refunds.process"]);
        let asked: Value = serde_json::from_str(&park(&db.state, &auth, &input).unwrap_err())
            .expect("a structured PIN request");
        assert_eq!(asked["code"], json!("REAUTH_REQUIRED"), "{asked}");
        assert_eq!(asked.get("approval"), None, "{asked}");
        confirm_park_pin(&db, &auth, "4321", None).expect("the session PIN");
        park(&db.state, &auth, &input).expect("parked");
        assert_eq!(
            park_audit(&db),
            vec![json!({"approvedBy":"staff-cashier","via":"shift_permission"})]
        );
    }

    #[test]
    fn checkout_create_failures_get_fixed_classes_without_native_text() {
        for (answer, class) in [
            (Ok(json!({"success":true,"orderId":"saved"})), None),
            (
                Ok(json!({"success":false,"errorCode":"CHECKOUT_IN_PROGRESS"})),
                Some("in_progress"),
            ),
            (
                Ok(json!({"success":false,"errorCode":"FISCAL_CHECKOUT_NOT_APPROVED"})),
                Some("fiscal_not_approved"),
            ),
            (
                Ok(json!({"success":false,"errorCode":"CARD_CONFIRMATION_REFUSED"})),
                Some("card_confirmation_refused"),
            ),
            (
                Ok(json!({"success":false,"errorCode":"PAYMENT_NOT_SAVED"})),
                Some("payment_not_saved"),
            ),
            (
                Err("create order: database is locked".to_string()),
                Some("storage_busy"),
            ),
            (
                Err("record initial payment: SHIFT_CURRENCY_UNAVAILABLE".to_string()),
                Some("currency_unavailable"),
            ),
            (
                Err("No active cashier shift on this terminal".to_string()),
                Some("shift_required"),
            ),
            (
                Err("customer PII_CANARY SECRET_CANARY".to_string()),
                Some("unclassified"),
            ),
        ] {
            assert_eq!(create_failure_class(&answer), class, "{answer:?}");
        }
    }

    // Tomikro 21/10/2026: another connection of this till (sync loop, print
    // worker) writing at the same moment made a draft save fail at once with
    // "database is locked". It now waits for the lock and saves.
    #[test]
    fn checkout_draft_save_waits_for_another_connection_writing_instead_of_failing() {
        let db = crate::tests::harness::TestDb::open();
        let input = {
            let conn = db.state.conn.lock().unwrap();
            let input = seed(&conn);
            read(&conn, &scope(&conn, &input).unwrap()).unwrap();
            input
        };
        let other = Connection::open(&db.state.db_path).unwrap();
        other
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS lock_probe(x); BEGIN IMMEDIATE; INSERT INTO lock_probe VALUES(1);",
            )
            .unwrap();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            other.execute_batch("COMMIT").unwrap();
        });
        let conn = db.state.conn.lock().unwrap();
        let started = std::time::Instant::now();
        let saved = write(&conn, &input, false).unwrap();
        writer.join().unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(250));
        assert_eq!(saved["generation"], json!(1));
        assert_eq!(saved["draft"], input["draft"]);
    }

    #[test]
    fn checkout_renderer_failures_get_fixed_allow_listed_codes_only() {
        for (input, expected) in [
            (
                json!({"operation":"save","failureClass":"version_changed","draftPhase":"checkout_pending"}),
                Some(("checkout_save_version_changed", "checkout_pending")),
            ),
            (
                json!({"operation":"read","failureClass":"storage_unavailable","draftPhase":"editing"}),
                Some(("checkout_read_storage_unavailable", "editing")),
            ),
            (
                json!({"operation":"save","failureClass":"PII_CANARY customer","draftPhase":"SECRET"}),
                Some(("checkout_save_unclassified", "invalid")),
            ),
            (json!({"operation":"drop","failureClass":"invalid"}), None),
        ] {
            let event = renderer_failure_event(&input);
            assert_eq!(
                event.as_ref().map(|(code, phase)| (code.as_str(), *phase)),
                expected,
                "{input}"
            );
        }
    }
}
