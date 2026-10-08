//! Record an operator-confirmed manual return and cancel in one durable write.
//! This never calls a provider or makes a charge. Provider originals cannot enter.
use crate::{
    auth, commands::orders, db, gift_financial_opening::OpeningScope, money::Cents, payments,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use tauri::Emitter;

const ACTION: &str = "manual_order_cancel_v1";
const PROVIDER_REQUIRED: &str = "ORIGINAL_PROVIDER_RETURN_REQUIRED";
const SETUP_UNKNOWN: &str = "PAYMENT_CONNECTION_STATUS_UNAVAILABLE";
/// A receipt this till mirrored from another till has no local provenance:
/// its canonical server row decides, and reading it needs a connection.
pub(crate) const RECEIPT_CHECK_UNAVAILABLE: &str = "ORIGINAL_RECEIPT_CHECK_UNAVAILABLE";
/// An efood/Wolt (or other external) order returns its money through the
/// platform; the till never records a manual return for it (Android
/// `readManualCancellationState`).
pub(crate) const PLATFORM_ORDER_RETURN_REQUIRED: &str = "PLATFORM_ORDER_RETURN_REQUIRED";
const PERMISSION_REQUIRED: &str = "ORDER_CANCELLATION_PERMISSION_REQUIRED";
/// The store-role permission that lets a staff member cancel a paid order
/// (THE-448 catalogue name; Android `CATALOGUE_PERMISSIONS_BY_ACTION.void_orders`).
const STORE_CANCEL_PERMISSION: &str = "pos.orders.cancel";
/// `order_payments.payment_origin` of a receipt mirrored from the server.
const MIRRORED_RECEIPT_ORIGIN: &str = "sync_reconstructed";

/// Who authorizes a paid-order cancellation (review 06/10/2026). The same
/// order of authority as Android's `resolvePrivilegedStaffId(['void_orders'])`:
/// the terminal's own session when it carries the right (the desktop admin
/// session today), else the cashier or manager checked in at this till when
/// their store role grants `pos.orders.cancel`, else a staff member who holds
/// it and approves with their own PIN (founder 07/10/2026). Neither of the
/// last two needs a terminal session: the session expires after two hours
/// while the till stays open, and the store could not cancel at all. The
/// canonical table lifecycle keeps its own staff-PIN approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CancellationActor {
    /// The identity kept in this till's audit rows.
    pub(crate) audit_id: String,
    /// The identity the server checks: the approving staff member, or `None`
    /// for the terminal's own admin session (terminal authority). Never the
    /// shift owner by substitution.
    pub(crate) staff_id: Option<String>,
}

fn uuid_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|candidate| uuid::Uuid::parse_str(candidate).is_ok())
        .map(str::to_owned)
}

/// A flag of a staff-directory entry under any of its spellings: an explicit
/// false wins, an absent flag is unknown (default-deny, as the check-in).
fn directory_flag(entry: &Value, keys: &[&str]) -> Option<bool> {
    let mut seen = None;
    for key in keys {
        match entry.get(*key).and_then(Value::as_bool) {
            Some(false) => return Some(false),
            Some(true) => seen = Some(true),
            None => {}
        }
    }
    seen
}

/// Whether the staff directory this till keeps for its branch (the same data
/// the check-in and the manager PIN trust) grants `permission` to `staff_id`.
fn staff_holds_store_permission(
    conn: &Connection,
    branch_id: &str,
    staff_id: &str,
    permission: &str,
) -> bool {
    let Some(raw) = db::get_setting(
        conn,
        "staff_auth_cache",
        &format!("branch_{}", branch_id.trim()),
    ) else {
        return false;
    };
    let Ok(cache) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let cached_branch = cache
        .get("branch_id")
        .or_else(|| cache.get("branchId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if !cached_branch.is_empty() && cached_branch != branch_id.trim() {
        return false;
    }
    cache["staff"].as_array().is_some_and(|staff| {
        staff.iter().any(|entry| {
            entry["id"].as_str().map(str::trim) == Some(staff_id)
                && directory_flag(entry, &["isActive", "is_active"]) == Some(true)
                && directory_flag(entry, &["canLoginPos", "can_login_pos", "canLoginPOS"])
                    == Some(true)
                && entry["permissions"].as_array().is_some_and(|names| {
                    names
                        .iter()
                        .any(|name| name.as_str().map(str::trim) == Some(permission))
                })
        })
    })
}

/// The session or the cashier on shift when either may cancel, without using
/// a manager's approval.
fn standing_cancellation_actor(
    conn: &Connection,
    auth: &auth::AuthState,
) -> Result<Option<CancellationActor>, String> {
    let session = auth::get_session_json(auth);
    if let Some(session_staff) = session["staffId"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if ["delete_order", "pos.orders.cancel", "void_orders"]
            .iter()
            .any(|permission| auth::has_permission(auth, Some(permission)))
        {
            let staff_id = uuid_text(session["databaseStaffId"].as_str());
            return Ok(Some(CancellationActor {
                audit_id: staff_id.clone().unwrap_or_else(|| session_staff.to_owned()),
                staff_id,
            }));
        }
    }
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    if let Some((_, cashier)) = crate::order_ownership::resolve_active_cashier_assignment(
        conn,
        &scope.branch_id,
        &scope.terminal_id,
    )? {
        if let Some(cashier) = uuid_text(Some(&cashier)) {
            if staff_holds_store_permission(
                conn,
                &scope.branch_id,
                &cashier,
                STORE_CANCEL_PERMISSION,
            ) {
                return Ok(Some(CancellationActor {
                    audit_id: cashier.clone(),
                    staff_id: Some(cashier),
                }));
            }
        }
    }
    Ok(None)
}

/// The till asks for an approver's own PIN; the screen shows the PIN prompt
/// and sends the cancellation again. The text keeps the permission code, so
/// a screen that cannot ask still says why.
fn approval_required() -> String {
    let error = auth::PrivilegedActionError::manager_approval(
        auth::MoneyApproval::VoidOrders,
        format!(
            "{PERMISSION_REQUIRED}: a staff member who may cancel paid orders approves it with their own PIN"
        ),
    );
    serde_json::to_string(&error).unwrap_or_else(|_| PERMISSION_REQUIRED.into())
}

/// Whether this till can cancel a paid order now or after an approver's PIN.
/// The plan is shown only then; nothing is used up.
pub(crate) fn cancellation_possible(
    conn: &Connection,
    auth: &auth::AuthState,
) -> Result<(), String> {
    if standing_cancellation_actor(conn, auth)?.is_some() {
        return Ok(());
    }
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    if auth::manager_approval_available(conn, &scope.branch_id, auth::MoneyApproval::VoidOrders) {
        return Ok(());
    }
    Err(PERMISSION_REQUIRED.into())
}

/// Who cancels: see [`CancellationActor`]. An approver's PIN is used once.
pub(crate) fn cancellation_actor(
    conn: &Connection,
    auth: &auth::AuthState,
) -> Result<CancellationActor, String> {
    if let Some(actor) = standing_cancellation_actor(conn, auth)? {
        return Ok(actor);
    }
    // Only a server staff identity approves: the server checks its rights.
    match auth::take_manager_approval(auth, auth::MoneyApproval::VoidOrders)
        .and_then(|approver| uuid_text(Some(&approver)))
    {
        Some(approver) => Ok(CancellationActor {
            audit_id: approver.clone(),
            staff_id: Some(approver),
        }),
        None => Err(approval_required()),
    }
}

/// The fresh, terminal-authenticated answer to "is a bank transport
/// connected for this branch" (`GET /api/pos/payments/manual-admission`, the
/// check Android's `requireNoConnectedPaymentProvider` makes). A cached or
/// module-gated integrations list is not evidence; errors never mean "off".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ProviderAdmission {
    #[default]
    NotChecked,
    Unavailable,
    Connected,
    NotConnected,
}

/// Read one manual-admission answer for exactly this terminal scope.
pub(crate) fn admission_from_response(scope: &OpeningScope, response: &Value) -> ProviderAdmission {
    let body = if response.get("admission_version").is_some() {
        response
    } else {
        response.get("data").unwrap_or(response)
    };
    if body["success"] != true
        || body["admission_version"] != 1
        || body["organization_id"].as_str() != Some(scope.organization_id.as_str())
        || body["branch_id"].as_str() != Some(scope.branch_id.as_str())
        || body["terminal_id"].as_str() != Some(scope.terminal_id.as_str())
    {
        return ProviderAdmission::Unavailable;
    }
    match body["provider_connected"].as_bool() {
        Some(true) => ProviderAdmission::Connected,
        Some(false) => ProviderAdmission::NotConnected,
        None => ProviderAdmission::Unavailable,
    }
}

/// Receipts this till mirrored from another till (`sync_reconstructed`, no
/// local provenance), judged by their canonical server rows with the server's
/// own classifier (`is_manual_pos_cancellation_receipt`, mirrored by
/// [`crate::table_manual_cancellation::canonical_manual_receipt`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum CanonicalReceipts {
    #[default]
    NotChecked,
    Unavailable,
    /// Local payment ids whose canonical row matches this till's mirror and
    /// proves an ordinary manual original.
    Verified(BTreeSet<String>),
}

/// The remote evidence a return needs, gathered before the local write and
/// bound to the terminal scope it was read for.
#[derive(Clone, Debug, Default)]
pub(crate) struct ReturnEvidence {
    pub(crate) scope: Option<OpeningScope>,
    pub(crate) admission: ProviderAdmission,
    pub(crate) receipts: CanonicalReceipts,
}

/// What a cancellation of `order_id` needs from the server, read locally.
pub(crate) struct EvidenceNeeds {
    admission: bool,
    mirrored_receipts: bool,
    canonical_order: Option<String>,
}

pub(crate) fn evidence_needs(conn: &Connection, order_id: &str) -> Result<EvidenceNeeds, String> {
    let mirrored_receipts: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM order_payments WHERE order_id=?1 AND status IN ('completed','refunded')
               AND LOWER(TRIM(COALESCE(payment_origin,'')))=?2 AND LOWER(TRIM(COALESCE(method,''))) IN ('cash','card'))",
            params![order_id, MIRRORED_RECEIPT_ORIGIN],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let canonical_order: Option<String> = conn
        .query_row(
            "SELECT supabase_id FROM orders WHERE id=?1",
            [order_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(EvidenceNeeds {
        admission: payments::load_store_taken_net_paid_cents(conn, order_id)? > 0,
        mirrored_receipts,
        canonical_order: uuid_text(canonical_order.as_deref()),
    })
}

fn canonical_amount_cents(row: &Value) -> Option<i64> {
    row["amount_cents"].as_i64().or_else(|| {
        row["amount"]
            .as_f64()
            .map(|amount| Cents::round_half_even(amount).as_i64())
    })
}

/// Classify this order's mirrored receipts from a canonical cancellation
/// snapshot (`GET /api/pos/staff-cash-returns/sync?order_id=`). A row whose
/// identity, tender, status, currency or amount differs from the local mirror
/// proves nothing.
pub(crate) fn canonical_receipts_from_snapshot(
    conn: &Connection,
    order_id: &str,
    snapshot: &Value,
) -> Result<CanonicalReceipts, String> {
    let data = snapshot.get("data").unwrap_or(snapshot);
    let Some(rows) = data["payments"].as_array() else {
        return Ok(CanonicalReceipts::Unavailable);
    };
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    let remote: Option<String> = conn
        .query_row(
            "SELECT supabase_id FROM orders WHERE id=?1",
            [order_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(remote) = uuid_text(remote.as_deref()) else {
        return Ok(CanonicalReceipts::Unavailable);
    };
    if data["order"]["id"].as_str().is_some_and(|id| id != remote) {
        return Ok(CanonicalReceipts::Unavailable);
    }
    let mut statement = conn
        .prepare(
            "SELECT id,COALESCE(remote_payment_id,''),LOWER(TRIM(method)),status,COALESCE(currency,''),
               COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER),0)
             FROM order_payments WHERE order_id=?1 AND status IN ('completed','refunded')
               AND LOWER(TRIM(COALESCE(payment_origin,'')))=?2",
        )
        .map_err(|e| e.to_string())?;
    let mirrors = statement
        .query_map(params![order_id, MIRRORED_RECEIPT_ORIGIN], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut verified = BTreeSet::new();
    for (local, canonical_id, method, status, currency, cents) in mirrors {
        let Some(row) = rows
            .iter()
            .find(|row| !canonical_id.is_empty() && row["id"].as_str() == Some(&canonical_id))
        else {
            continue;
        };
        if row["order_id"].as_str() == Some(remote.as_str())
            && row["organization_id"].as_str() == Some(scope.organization_id.as_str())
            && row["branch_id"].as_str() == Some(scope.branch_id.as_str())
            && row["payment_method"].as_str() == Some(method.as_str())
            && row["status"].as_str() == Some(status.as_str())
            && row["currency"].as_str() == Some(currency.as_str())
            && canonical_amount_cents(row) == Some(cents)
            && crate::table_manual_cancellation::canonical_manual_receipt(row)
        {
            verified.insert(local);
        }
    }
    Ok(CanonicalReceipts::Verified(verified))
}

/// Gather the remote evidence for `order_id`: a fresh provider admission when
/// money is to be returned, and the canonical rows of mirrored receipts.
/// `snapshot` is a canonical cancellation snapshot the caller already tried
/// to read (table checks): `Some(None)` when that read failed. Read failures
/// are recorded as unavailable, never as approval.
pub(crate) async fn fetch_return_evidence(
    db: &db::DbState,
    order_id: &str,
    snapshot: Option<Option<&Value>>,
) -> Result<ReturnEvidence, String> {
    let (needs, scope) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        (
            evidence_needs(&conn, order_id)?,
            OpeningScope::resolve(&conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?,
        )
    };
    let admission = if needs.admission {
        match crate::admin_fetch_detailed(
            Some(db),
            "/api/pos/payments/manual-admission",
            "GET",
            None,
        )
        .await
        {
            Ok(body) => admission_from_response(&scope, &body),
            Err(_) => ProviderAdmission::Unavailable,
        }
    } else {
        ProviderAdmission::NotChecked
    };
    // The same answer admits or retires this till's card terminal
    // (`crate::device_admission`); only a definite answer is kept.
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if OpeningScope::resolve(&conn).as_ref() == Some(&scope) {
            if let Err(error) =
                crate::device_admission::record_card_admission(&conn, &scope, admission)
            {
                tracing::warn!(error = %error, "card terminal admission was not saved");
            }
        }
    }
    let receipts = if !needs.mirrored_receipts {
        CanonicalReceipts::NotChecked
    } else {
        let fetched = match (snapshot, needs.canonical_order.as_deref()) {
            (Some(_), _) | (None, None) => None,
            (None, Some(remote)) => crate::admin_fetch_detailed(
                Some(db),
                &format!("/api/pos/staff-cash-returns/sync?order_id={remote}"),
                "GET",
                None,
            )
            .await
            .ok(),
        };
        match snapshot.flatten().or(fetched.as_ref()) {
            Some(snapshot) => {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                canonical_receipts_from_snapshot(&conn, order_id, snapshot)?
            }
            None => CanonicalReceipts::Unavailable,
        }
    };
    Ok(ReturnEvidence {
        scope: Some(scope),
        admission,
        receipts,
    })
}

/// No bank transport may own the return. The branch's providers are judged by
/// the fresh admission only. A card terminal saved on this till counts only
/// through that same admission (founder rule 08/10/2026, Android parity): it
/// is admitted exactly when a payment plugin is connected, which already
/// refuses here. A terminal whose plugin is not active, configured and
/// finished is inert and never blocks a manual return (08/10/2026: a fiscal
/// cash register saved as an enabled `payment_terminal`, with no payment
/// plugin in the store, refused every manual return of a paid card order).
fn no_connected_bank(admission: ProviderAdmission) -> Result<(), String> {
    match admission {
        ProviderAdmission::NotConnected => Ok(()),
        ProviderAdmission::Connected => Err(PROVIDER_REQUIRED.into()),
        ProviderAdmission::NotChecked | ProviderAdmission::Unavailable => Err(SETUP_UNKNOWN.into()),
    }
}

/// Our own channels (`pos`, `kiosk`, `web`, `android-ios`) or no recorded
/// source. An external order id or any other source returns money through its
/// platform (`crate::platforms`, the shared closed classification).
fn order_source_allows_manual_return(conn: &Connection, id: &str) -> Result<bool, String> {
    let (plugin, external): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT plugin,external_plugin_order_id FROM orders WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    if external.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        return Ok(false);
    }
    Ok(
        match plugin
            .as_deref()
            .and_then(crate::platforms::normalize_platform_slug)
        {
            None => true,
            Some(slug) => crate::platforms::INTERNAL_ORDER_PLATFORMS.contains(&slug.as_str()),
        },
    )
}

/// One receipt's manual provenance. A receipt recorded on this till keeps the
/// native column rule; a mirrored receipt is judged by its canonical row.
fn receipt_is_manual(
    conn: &Connection,
    payment_id: &str,
    receipts: &CanonicalReceipts,
) -> Result<bool, String> {
    let (method, origin, device, reference, metadata): (String, String, String, String, Option<String>) = conn
        .query_row(
            "SELECT LOWER(TRIM(COALESCE(method,''))),LOWER(TRIM(COALESCE(payment_origin,''))),TRIM(COALESCE(terminal_device_id,'')),TRIM(COALESCE(transaction_ref,'')),metadata FROM order_payments WHERE id=?1",
            [payment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| e.to_string())?;
    if origin == MIRRORED_RECEIPT_ORIGIN {
        if !matches!(method.as_str(), "cash" | "card") || !device.is_empty() {
            return Ok(false);
        }
        return match receipts {
            CanonicalReceipts::Verified(ids) => Ok(ids.contains(payment_id)),
            CanonicalReceipts::NotChecked | CanonicalReceipts::Unavailable => {
                Err(RECEIPT_CHECK_UNAVAILABLE.into())
            }
        };
    }
    Ok(original_is_manual_with_metadata(
        &method,
        &origin,
        &device,
        &reference,
        metadata.as_deref(),
    ))
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

fn prepare(conn: &Connection, raw_id: &str, evidence: &ReturnEvidence) -> Result<Value, String> {
    let id = orders::validate_manual_cancel_target(conn, raw_id)?;
    prepare_validated(conn, &id, evidence)
}

pub(crate) fn prepare_validated(
    conn: &Connection,
    id: &str,
    evidence: &ReturnEvidence,
) -> Result<Value, String> {
    let scope = OpeningScope::resolve(conn).ok_or("TERMINAL_SCOPE_UNAVAILABLE")?;
    // Evidence read for another terminal scope (a rebind mid-request) proves
    // nothing here.
    let (admission, receipts) = if evidence.scope.as_ref() == Some(&scope) {
        (evidence.admission, evidence.receipts.clone())
    } else {
        (ProviderAdmission::NotChecked, CanonicalReceipts::NotChecked)
    };
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
    // Staff-held cash is handed back only from a proven manual original; a
    // receipt mirrored from another till is judged by its canonical row.
    for source in &cash_returns {
        let payment = source["paymentId"]
            .as_str()
            .ok_or("STAFF_CASH_CUSTODY_INVALID")?;
        if !receipt_is_manual(conn, payment, &receipts)? {
            return Err(PROVIDER_REQUIRED.into());
        }
    }
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
        // placeholders do not. A receipt tip covers only the tip the order
        // total contains (tip-inclusive rule, `payments::load_principal_paid_for_order`):
        // a 22.00 order with its 2.00 tip, paid by one 22.00 receipt, is paid.
        let (principal, receipt_tips): (i64, i64) = conn.query_row(&format!("SELECT COALESCE(SUM(MAX(gross-tip,0)),0),COALESCE(SUM(MIN(tip,gross)),0) FROM (SELECT MAX(COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER),0),0) AS gross,MAX(COALESCE(tip_amount_cents,CAST(ROUND(tip_amount*100) AS INTEGER),0),0) AS tip FROM order_payments p WHERE order_id=?1 AND status IN ('completed','refunded') AND NOT {})",payments::placeholder_payment_sql("p")),[&id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        let covered =
            principal + receipt_tips.min(payments::load_order_tip_inside_total_cents(conn, id)?);
        if covered < total_cents {
            return Err(orders::ORDER_PAYMENT_NOT_RECORDED.into());
        }
    }
    // The order's own source first: an efood/Wolt order's money is the
    // platform's to return, whatever its payment row says (Android parity).
    if !order_source_allows_manual_return(conn, id)? {
        return Err(PLATFORM_ORDER_RETURN_REQUIRED.into());
    }
    no_connected_bank(admission)?;
    let provider_attempt: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM ecr_transactions WHERE order_id=?1 AND LOWER(transaction_type)='sale' )",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if provider_attempt {
        return Err(PROVIDER_REQUIRED.into());
    }
    let mut stmt = conn.prepare("SELECT id,currency,
        COALESCE(amount_cents,CAST(ROUND(amount*100) AS INTEGER),0) - COALESCE((SELECT SUM(COALESCE(a.amount_cents,CAST(ROUND(a.amount*100) AS INTEGER))) FROM payment_adjustments a WHERE a.payment_id=p.id AND a.adjustment_type='refund'),0)
        FROM order_payments p WHERE order_id=?1 AND status='completed' ORDER BY id").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([&id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut portions = Vec::new();
    let mut currency: Option<String> = None;
    let mut cents = 0_i64;
    for (payment_id, unit, remaining) in rows {
        if payments::payment_is_platform_settlement(conn, &payment_id)? {
            continue;
        }
        let canonical: bool = conn.query_row("SELECT sync_state='applied' AND sync_status='synced' AND NULLIF(TRIM(remote_payment_id),'') IS NOT NULL FROM order_payments WHERE id=?1",[&payment_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !canonical {
            return Err("PAYMENT_SYNC_REQUIRED".into());
        }
        if payments::payment_is_placeholder(conn, &payment_id)?
            || !receipt_is_manual(conn, &payment_id, &receipts)?
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

/// The local order a manual cancellation request names (local or canonical id).
fn requested_order(conn: &Connection, input: &Value) -> Result<String, String> {
    let raw = input["orderId"].as_str().ok_or("Missing orderId")?;
    conn.query_row(
        "SELECT id FROM orders WHERE id=?1 OR supabase_id=?1",
        [raw],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Whether this exact request was already committed (its audit row exists);
/// its replay needs no fresh evidence and never returns money again.
fn already_committed(conn: &Connection, input: &Value) -> Result<bool, String> {
    let Some(key) = input["requestId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(false);
    };
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM recovery_action_log WHERE id=?1 AND action_id=?2)",
        params![format!("manual-cancel:{key}"), ACTION],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn commit(
    conn: &Connection,
    input: &Value,
    actor: &CancellationActor,
    evidence: &ReturnEvidence,
) -> Result<Value, String> {
    let actor_id = actor.audit_id.as_str();
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
            let plan = prepare(conn, order_id, evidence)?;
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
            // Payments whose staff-held cash the cashier receives in this
            // cancellation: their customer return is linked to that handback.
            let handback_payments: BTreeSet<&str> = receipts
                .iter()
                .filter_map(|(source, _)| source["paymentId"].as_str())
                .collect();
            let mut adjustments = std::collections::HashMap::new();
            for portion in plan["payments"]
                .as_array()
                .ok_or("PAYMENT_BALANCE_INVALID")?
            {
                let payment_id = portion["paymentId"]
                    .as_str()
                    .ok_or("PAYMENT_BALANCE_INVALID")?;
                // A Bank return linked to a handback still names the
                // receiving cashier drawer: the server's atomic handback
                // requires it. It never debits the drawer (refunds.rs).
                let cash_handler = (channel == "cash_drawer"
                    || handback_payments.contains(payment_id))
                .then_some("cashier_drawer");
                let refund = crate::refunds::refund_manual_cancellation_in_connection(
                    conn,
                    &json!({
                        "paymentId":payment_id,"amount":Cents::new(portion["amountCents"].as_i64().ok_or("PAYMENT_BALANCE_INVALID")?).to_f64_dp2(),
                        "reason":reason,"staffId":actor.staff_id,"staffShiftId":shift_id,
                        "idempotencyKey":format!("manual-cancel:{key}:{payment_id}"),
                        "refundMethod":if channel=="cash_drawer" {"cash"} else {"card"},"cashHandler":cash_handler
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
            let audit = json!({"organizationId":scope.organization_id,"branchId":scope.branch_id,"terminalId":scope.terminal_id,"orderId":order_id,"reason":reason,"returnChannel":channel,"plan":plan,"actorStaffId":actor_id,"authorizingStaffId":actor.staff_id,"staffShiftId":shift_id,"charged":false,"operatorConfirmedReturned":true});
            conn.execute("INSERT INTO recovery_action_log(id,action_id,issue_code,entity_type,entity_id,order_id,shift_id,success,actor_staff_id,payload_json,created_at) VALUES(?1,?2,'MANUAL_RETURN_AND_CANCEL','order',?3,?3,?4,1,?5,?6,?7)",params![audit_id,ACTION,order_id,shift_id,actor_id,audit.to_string(),now]).map_err(|e|e.to_string())?;
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
    let raw = arg0["orderId"].as_str().ok_or("Missing orderId")?;
    let permitted = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        cancellation_possible(&conn, &auth)
    };
    if permitted.is_err() {
        // The rights come from the staff directory this till keeps, read
        // again only when a shift screen opens: a right given on the
        // dashboard (06/10/2026) was refused until then. Read it once more,
        // bounded; offline, the stored directory decides.
        if let Ok(Err(error)) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            auth::refresh_staff_auth_directory(&db, None),
        )
        .await
        {
            tracing::debug!(error = %error, "Staff directory refresh before a cancellation failed");
        }
    }
    let (id, table_session, table_candidate) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        // The approver's PIN, when one is needed, is asked at the commit.
        if permitted.is_err() {
            cancellation_possible(&conn, &auth)?;
        }
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
        (id, table, candidate)
    };
    // A table check reads its canonical snapshot (payments with their
    // canonical metadata) once; the same rows classify mirrored receipts.
    // A failed read is reported after the local refusals below.
    let snapshot = if table_candidate {
        let remote = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            crate::table_manual_cancellation::canonical_order(&conn, &id)
        };
        Some(match remote {
            Ok(remote) => crate::admin_fetch_detailed(
                Some(&db),
                &format!("/api/pos/staff-cash-returns/sync?order_id={remote}"),
                "GET",
                None,
            )
            .await
            .map_err(|_| "TABLE_MANUAL_CANCELLATION_UNAVAILABLE".to_string()),
            Err(error) => Err(error),
        })
    } else {
        None
    };
    let evidence =
        fetch_return_evidence(&db, &id, snapshot.as_ref().map(|read| read.as_ref().ok())).await?;
    let mut plan = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if table_candidate {
            prepare_validated(&conn, &id, &evidence)?
        } else {
            prepare(&conn, &id, &evidence)?
        }
    };
    if let Some(snapshot) = snapshot {
        let snapshot = snapshot?;
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
pub async fn order_cancel_manual_refund(
    arg0: Value,
    db: tauri::State<'_, db::DbState>,
    auth: tauri::State<'_, auth::AuthState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let _binding = crate::repairs::acquire_terminal_binding_lease()?;
    let (actor, order_id, replay) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        (
            cancellation_actor(&conn, &auth)?,
            requested_order(&conn, &arg0)?,
            already_committed(&conn, &arg0)?,
        )
    };
    // The same fresh evidence as the preview, read again for the write: a
    // provider connected meanwhile, or a mirrored receipt's canonical row,
    // still decides. A committed request replays without new evidence.
    let evidence = if replay {
        ReturnEvidence::default()
    } else {
        fetch_return_evidence(&db, &order_id, None).await?
    };
    let result = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        commit(&conn, &arg0, &actor, &evidence)?
    };
    let event = json!({"orderId":result["orderId"],"status":"cancelled","cancellationReason":arg0["reason"]});
    let _ = app.emit("order_status_updated", event.clone());
    let _ = app.emit("order_realtime_update", event);
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh manual-admission answer for the test terminal: no provider.
    pub(crate) fn admitted(conn: &Connection) -> ReturnEvidence {
        ReturnEvidence {
            scope: OpeningScope::resolve(conn),
            admission: ProviderAdmission::NotConnected,
            receipts: CanonicalReceipts::NotChecked,
        }
    }

    /// The legacy test actors: a staff UUID is sent to the server, any other
    /// identity is the terminal's own session.
    pub(crate) fn test_actor(id: &str) -> CancellationActor {
        CancellationActor {
            audit_id: id.to_string(),
            staff_id: uuid_text(Some(id)),
        }
    }

    // The planning and commit paths with a fresh, provider-free admission.
    fn prepare(conn: &Connection, raw_id: &str) -> Result<Value, String> {
        super::prepare(conn, raw_id, &admitted(conn))
    }
    fn commit(conn: &Connection, input: &Value, actor: &str) -> Result<Value, String> {
        super::commit(conn, input, &test_actor(actor), &admitted(conn))
    }

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

    #[test]
    fn tipped_checkout_receipt_covers_the_tip_inside_the_order_total() {
        // A 6.00 order whose total holds a 1.00 tip, paid by one 6.00 receipt
        // carrying that tip, is paid (tip-inclusive rule, 06/10/2026). Before,
        // the receipt tip was subtracted and the cancel answered
        // ORDER_PAYMENT_NOT_RECORDED for every tipped checkout.
        let conn = setup();
        conn.execute_batch(
            "UPDATE order_payments SET transaction_ref='CARD-1791226924826',tip_amount=1,tip_amount_cents=100;
             UPDATE orders SET tip_amount=1,tip_amount_cents=100;",
        )
        .unwrap();
        assert_eq!(prepare(&conn, "order").unwrap()["amountCents"], 600);
        // A receipt tip the total does not contain covers none of it.
        conn.execute("UPDATE orders SET tip_amount=0,tip_amount_cents=0", [])
            .unwrap();
        assert_eq!(
            prepare(&conn, "order").unwrap_err(),
            orders::ORDER_PAYMENT_NOT_RECORDED
        );
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
    fn admission(conn: &Connection, body: Value) -> ReturnEvidence {
        let scope = OpeningScope::resolve(conn).unwrap();
        ReturnEvidence {
            admission: admission_from_response(&scope, &body),
            scope: Some(scope),
            receipts: CanonicalReceipts::NotChecked,
        }
    }

    #[test]
    fn connected_bank_blocks_manual_path_from_the_fresh_admission_only() {
        // The branch's providers are judged by the fresh terminal-authenticated
        // manual-admission answer (Android parity), never by a cached,
        // module-gated integrations list: a stale cache says nothing.
        let fresh = |connected: Value| json!({"success":true,"admission_version":1,"organization_id":"org","branch_id":"branch","terminal_id":"terminal","provider_connected":connected});
        let conn = setup();
        db::set_setting(&conn,"local","admin_api_get::/api/pos/integrations",&json!({"data":{"success":true,"branch_id":"branch","integrations":[{"provider":"stripe","category":"payment","branch_id":"branch","is_purchased":true,"is_enabled":true,"status":"connected"}]}}).to_string()).unwrap();
        assert_eq!(
            super::prepare(&conn, "order", &admission(&conn, fresh(json!(false)))).unwrap()
                ["amountCents"],
            600
        );
        assert_eq!(
            super::prepare(&conn, "order", &admission(&conn, fresh(json!(true)))).unwrap_err(),
            PROVIDER_REQUIRED
        );
        // Envelope-wrapped answers read the same.
        assert_eq!(
            super::prepare(
                &conn,
                "order",
                &admission(&conn, json!({"success":true,"data":fresh(json!(false))}))
            )
            .unwrap()["amountCents"],
            600
        );
        assert_eq!(count(&conn, "payment_adjustments"), 0);
    }

    #[test]
    fn unknown_or_foreign_admission_never_authorizes_a_manual_return() {
        let conn = setup();
        // The module-gated integrations cache was the old (and only) evidence;
        // without a fresh answer the status is unknown.
        conn.execute_batch(
            "DELETE FROM local_settings WHERE setting_key='admin_api_get::/api/pos/integrations'",
        )
        .unwrap();
        assert_eq!(
            super::prepare(&conn, "order", &ReturnEvidence::default()).unwrap_err(),
            SETUP_UNKNOWN
        );
        for body in [
            json!({"success":false,"code":"PAYMENT_ADMISSION_UNAVAILABLE"}),
            json!({"success":true,"admission_version":2,"organization_id":"org","branch_id":"branch","terminal_id":"terminal","provider_connected":false}),
            json!({"success":true,"admission_version":1,"organization_id":"org","branch_id":"foreign","terminal_id":"terminal","provider_connected":false}),
            json!({"success":true,"admission_version":1,"organization_id":"org","branch_id":"branch","terminal_id":"other-till","provider_connected":false}),
            json!({"success":true,"admission_version":1,"organization_id":"org","branch_id":"branch","terminal_id":"terminal"}),
        ] {
            assert_eq!(
                super::prepare(&conn, "order", &admission(&conn, body.clone())).unwrap_err(),
                SETUP_UNKNOWN,
                "{body}"
            );
        }
        // Evidence read for another terminal scope proves nothing here.
        let mut moved = admitted(&conn);
        moved.scope.as_mut().unwrap().terminal_id = "other-till".into();
        assert_eq!(
            super::prepare(&conn, "order", &moved).unwrap_err(),
            SETUP_UNKNOWN
        );
        assert_eq!(count(&conn, "payment_adjustments"), 0);
    }

    /// Founder rule 08/10/2026 (Android parity): a saved card terminal counts
    /// only through the payment plugin behind it. 08/10/2026: the fiscal cash
    /// register "Rbs Elio CR" was saved as an enabled `payment_terminal` in a
    /// store with no payment plugin, and every manual return of a paid card
    /// order was refused with ORIGINAL_PROVIDER_RETURN_REQUIRED.
    #[test]
    fn a_saved_card_terminal_without_its_payment_plugin_never_blocks_a_manual_return() {
        for (device_type, enabled, status, stale_admitted) in [
            ("payment_terminal", 1, "disconnected", false),
            ("payment_terminal", 1, "connected", false),
            // A stale "admitted" answer never outvotes the fresh one.
            ("payment_terminal", 1, "connected", true),
            ("payment_terminal", 0, "connected", false),
            ("cash_register", 1, "connected", true),
        ] {
            let conn = setup();
            conn.execute("INSERT INTO ecr_devices(id,name,brand,device_type,connection_type,status,enabled) VALUES('device','Rbs Elio CR','RBS',?1,'network',?2,?3)",params![device_type,status,enabled]).unwrap();
            if stale_admitted {
                let scope = OpeningScope::resolve(&conn).unwrap();
                crate::device_admission::record(&conn, device_type, &scope, true, None, None)
                    .unwrap();
            }
            assert_eq!(
                prepare(&conn, "order").unwrap()["amountCents"],
                600,
                "{device_type} enabled={enabled} {status}"
            );
            // The fresh answer also retires the saved terminal on this till.
            let evidence = admitted(&conn);
            crate::device_admission::record_card_admission(
                &conn,
                evidence.scope.as_ref().unwrap(),
                evidence.admission,
            )
            .unwrap();
            assert!(!crate::device_admission::is_admitted(
                &conn,
                crate::device_admission::CARD_TERMINAL
            ));
        }
    }

    /// A connected payment plugin still owns the return, with or without a
    /// card terminal saved on this till.
    #[test]
    fn a_connected_payment_plugin_still_requires_the_provider_return() {
        for device in [false, true] {
            let conn = setup();
            if device {
                conn.execute_batch("INSERT INTO ecr_devices(id,name,device_type,connection_type,status,enabled) VALUES('device','Card','payment_terminal','network','connected',1);").unwrap();
            }
            let mut evidence = admitted(&conn);
            evidence.admission = ProviderAdmission::Connected;
            assert_eq!(
                super::prepare(&conn, "order", &evidence).unwrap_err(),
                PROVIDER_REQUIRED,
                "device={device}"
            );
        }
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
        assert_eq!(
            super::prepare(
                &conn,
                "order",
                &admission(
                    &conn,
                    json!({"success":true,"admission_version":1,"organization_id":"org","branch_id":"foreign","terminal_id":"terminal","provider_connected":false})
                )
            )
            .unwrap_err(),
            SETUP_UNKNOWN
        );
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
    fn paid_label_without_payment_still_cannot_cancel_and_nobody_unauthorized_cancels() {
        let conn = setup();
        conn.execute_batch("DELETE FROM order_payments").unwrap();
        assert_eq!(
            prepare(&conn, "order").unwrap_err(),
            orders::ORDER_PAYMENT_NOT_RECORDED
        );
        // No session, no right on shift, and nobody in the directory who
        // could approve: refused before the plan is shown.
        let auth = auth::AuthState::new();
        assert_eq!(
            cancellation_possible(&conn, &auth).unwrap_err(),
            PERMISSION_REQUIRED
        );
        let asked: Value =
            serde_json::from_str(&cancellation_actor(&conn, &auth).unwrap_err()).unwrap();
        assert_eq!(asked["code"], "REAUTH_REQUIRED");
        assert_eq!(asked["approval"], "void_orders");
        assert!(asked["reason"]
            .as_str()
            .unwrap()
            .starts_with(PERMISSION_REQUIRED));
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
        // The terminal's own admin session authorizes; it names no staff
        // member to the server (terminal authority), never the shift owner.
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            cancellation_actor(&conn, &auth).unwrap(),
            CancellationActor {
                audit_id: "admin-user".into(),
                staff_id: None
            }
        );
    }
    #[test]
    fn historical_ecr_sale_attempt_refuses_even_when_device_is_disconnected_and_attempt_failed() {
        let conn = setup();
        // A removed (disabled) terminal: its historical SALE attempt alone refuses.
        conn.execute_batch("INSERT INTO ecr_devices(id,name,device_type,connection_type,status,enabled) VALUES('device','Bank terminal','payment_terminal','network','disconnected',0);
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

    // ---- Review 06/10/2026 -------------------------------------------------

    const CASHIER_SHIFT: &str = "6d3f2a10-7c4b-4e5a-9b1c-2f3e4d5a6b7c";
    const CASHIER: &str = "0b8e7c6d-5a4f-4b3c-8d2e-1f0a9b8c7d6e";
    const APPROVER: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const REMOTE_ORDER: &str = "727dfed5-af5b-4491-a258-41d8659a5ce4";
    const REMOTE_PAYMENT: &str = "8238ddd9-5e52-47b6-ac6d-3e398b14ae08";

    /// The receiving cashier's shift and identity as the server knows them.
    fn canonical_cashier(conn: &Connection) {
        conn.execute_batch(&format!(
            "PRAGMA foreign_keys=OFF;
             UPDATE staff_shifts SET id='{CASHIER_SHIFT}',staff_id='{CASHIER}' WHERE id='shift';
             UPDATE cash_drawer_sessions SET staff_shift_id='{CASHIER_SHIFT}',cashier_id='{CASHIER}' WHERE staff_shift_id='shift';
             UPDATE order_payments SET staff_shift_id='{CASHIER_SHIFT}' WHERE staff_shift_id='shift';
             UPDATE orders SET staff_shift_id='{CASHIER_SHIFT}' WHERE staff_shift_id='shift';"
        ))
        .unwrap();
    }

    fn linked_handback(conn: &Connection) -> (String, String) {
        conn.query_row(
            "SELECT id,adjustment_id FROM staff_order_cash_returns",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn bank_return_of_staff_held_cash_is_sent_with_the_cashier_drawer_and_never_debits_it() {
        // Symptom: a Bank return of cash a driver or waiter held queued
        // `cashHandler: null`; the server's atomic handback requires
        // `cashier_drawer`, so it was refused forever (409
        // STAFF_CASH_RETURN_REJECTED): a cancelled order with an unrefunded
        // receipt and the driver still shown holding the cash.
        for role in ["driver", "server"] {
            let conn = setup();
            staff_custody_fixture(&conn, role);
            commit(&conn, &request(&conn, "bank"), "admin-user").unwrap();
            let mut statement = conn
                .prepare("SELECT payment_id,refund_method,cash_handler FROM payment_adjustments ORDER BY payment_id")
                .unwrap();
            let rows = statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(
                rows,
                vec![
                    (
                        "cash-payment".into(),
                        "card".into(),
                        Some("cashier_drawer".into())
                    ),
                    ("payment".into(), "card".into(), None),
                ],
                "{role}"
            );
            // A Bank return pays no drawer cash; the staff cash entered once.
            let (refunds, intake): (i64, i64) = conn
                .query_row(
                    "SELECT total_refunds_cents,driver_cash_returned_cents FROM cash_drawer_sessions WHERE id='drawer'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!((refunds, intake), (0, 450), "{role}");
            // The exact body sent to /api/pos/payments/adjustments/sync.
            let (receipt, adjustment) = linked_handback(&conn);
            let body = crate::sync_queue::apply_ack_for_test(
                &conn,
                "payment_adjustments",
                &adjustment,
                &json!({"success":true,"id":receipt,"adjustment_id":adjustment}),
            )
            .unwrap();
            assert_eq!(body["adjustment_type"], "refund", "{body}");
            assert_eq!(body["refund_method"], "card", "{body}");
            assert_eq!(body["cash_handler"], "cashier_drawer", "{body}");
            assert_eq!(body["amount"], 4.5, "{body}");
            assert_eq!(
                body["idempotency_key"],
                "manual-cancel:request-1:cash-payment"
            );
            assert_eq!(body["staff_cash_return"]["amount_cents"], 450);
            assert_eq!(body["staff_cash_return"]["source_role"], role);
            assert_eq!(body["staff_cash_return"]["receiving_drawer_id"], "drawer");
            // The terminal's admin session names no staff member.
            assert!(body.get("staff_id").is_none(), "{body}");
            // An unlinked Bank return names no handler, as before.
            let unlinked: String = conn
                .query_row(
                    "SELECT id FROM payment_adjustments WHERE payment_id='payment'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let plain = crate::sync_queue::apply_ack_for_test(
                &conn,
                "payment_adjustments",
                &unlinked,
                &json!({"success":true,"adjustment_id":unlinked}),
            )
            .unwrap();
            assert!(plain.get("cash_handler").is_none(), "{plain}");
            assert!(plain.get("staff_cash_return").is_none(), "{plain}");
            assert_eq!(plain["refund_method"], "card");
        }
    }

    #[test]
    fn manual_cancellation_names_the_authorizing_actor_never_the_shift_owner() {
        // Symptom: the desktop actor `admin-user` is not a UUID, so the refund
        // fell back to the shift owner; the server then required that
        // cashier's own `pos.orders.cancel` and could refuse it forever.
        for (actor, expected) in [("admin-user", None), (APPROVER, Some(APPROVER))] {
            let conn = setup();
            staff_custody_fixture(&conn, "driver");
            canonical_cashier(&conn);
            commit(&conn, &request(&conn, "bank"), actor).unwrap();
            let mut statement = conn
                .prepare("SELECT staff_id,staff_shift_id FROM payment_adjustments")
                .unwrap();
            let rows = statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(rows.len(), 2);
            for (staff, shift) in rows {
                assert_eq!(staff.as_deref(), expected, "{actor}");
                assert_eq!(shift.as_deref(), Some(CASHIER_SHIFT), "{actor}");
            }
            let (receipt, adjustment) = linked_handback(&conn);
            let body = crate::sync_queue::apply_ack_for_test(
                &conn,
                "payment_adjustments",
                &adjustment,
                &json!({"success":true,"id":receipt,"adjustment_id":adjustment}),
            )
            .unwrap();
            assert_eq!(
                body.get("staff_id").and_then(Value::as_str),
                expected,
                "{body}"
            );
            assert_eq!(body["staff_shift_id"], CASHIER_SHIFT);
        }
    }

    #[test]
    fn a_cashier_whose_store_role_may_cancel_authorizes_without_the_admin_session() {
        // Android lets any staff member whose store role has
        // `pos.orders.cancel` cancel a paid order; the desktop accepted only
        // its admin session (the hardcoded `delete_order`).
        let _keyring = crate::tests::fake_keyring::install_empty();
        let conn = setup();
        canonical_cashier(&conn);
        db::set_setting(
            &conn,
            "staff",
            "staff_pin_hash",
            &bcrypt::hash("2468", 4).unwrap(),
        )
        .unwrap();
        let directory = |id: &str, permissions: Value, active: bool, branch: &str| {
            json!({"version":1,"branch_id":branch,"staff":[{"id":id,"isActive":active,"canLoginPos":true,"hasPin":true,"permissions":permissions}]}).to_string()
        };
        db::set_setting(
            &conn,
            "staff_auth_cache",
            "branch_branch",
            &directory(CASHIER, json!(["pos.orders.cancel"]), true, "branch"),
        )
        .unwrap();
        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };
        let auth = auth::AuthState::new();
        let cashier = CancellationActor {
            audit_id: CASHIER.into(),
            staff_id: Some(CASHIER.into()),
        };
        // 07/10/2026: the terminal session had expired (two hours) while the
        // till stayed open, and the store could not cancel a paid order. The
        // cashier on shift needs no session.
        assert_eq!(
            cancellation_actor(&db.conn.lock().unwrap(), &auth).unwrap(),
            cashier
        );
        assert_eq!(
            auth::login(Some(json!({"pin":"2468"})), &db, &auth).unwrap()["success"],
            true
        );
        assert_eq!(
            cancellation_actor(&db.conn.lock().unwrap(), &auth).unwrap(),
            cashier
        );
        for refused in [
            directory(CASHIER, json!(["pos.orders.view"]), true, "branch"),
            directory(CASHIER, json!(["pos.orders.cancel"]), false, "branch"),
            directory(APPROVER, json!(["pos.orders.cancel"]), true, "branch"),
            directory(CASHIER, json!(["pos.orders.cancel"]), true, "other-branch"),
        ] {
            let conn = db.conn.lock().unwrap();
            db::set_setting(&conn, "staff_auth_cache", "branch_branch", &refused).unwrap();
            // Nobody listed has a PIN to approve with: refused before the plan.
            assert_eq!(
                cancellation_possible(&conn, &auth).unwrap_err(),
                PERMISSION_REQUIRED,
                "{refused}"
            );
            assert!(
                cancellation_actor(&conn, &auth)
                    .unwrap_err()
                    .contains(PERMISSION_REQUIRED),
                "{refused}"
            );
        }
    }

    #[test]
    fn an_approver_pin_cancels_a_paid_order_once_without_a_session() {
        // Founder 07/10/2026: when nobody at the till may cancel a paid order,
        // a staff member who may approves it with their own PIN, as the table
        // cancellation does. The terminal session may have expired.
        let _keyring = crate::tests::fake_keyring::install_empty();
        let conn = setup();
        canonical_cashier(&conn);
        let directory = json!({"version":1,"branch_id":"branch","staff":[
            {"id":CASHIER,"isActive":true,"canLoginPos":true,"hasPin":true,
             "pinHash":bcrypt::hash("2468",4).unwrap(),"permissions":["pos.orders.view"]},
            {"id":APPROVER,"isActive":true,"canLoginPos":true,"hasPin":true,
             "pinHash":bcrypt::hash("1357",4).unwrap(),"permissions":["pos.orders.cancel"]}
        ]});
        db::set_setting(
            &conn,
            "staff_auth_cache",
            "branch_branch",
            &directory.to_string(),
        )
        .unwrap();
        let db = db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };
        let auth = auth::AuthState::new();
        let confirm = |pin: &str| {
            auth::confirm_privileged_action(
                Some(json!({"pin":pin,"scope":"cash_drawer_control","approval":"void_orders"})),
                &db,
                &auth,
            )
        };
        let asks = || {
            let error = cancellation_actor(&db.conn.lock().unwrap(), &auth).unwrap_err();
            let asked: Value = serde_json::from_str(&error).unwrap();
            assert_eq!(asked["code"], "REAUTH_REQUIRED", "{error}");
            assert_eq!(asked["approval"], "void_orders", "{error}");
        };

        // The plan is shown: someone can approve it.
        cancellation_possible(&db.conn.lock().unwrap(), &auth).unwrap();
        asks();
        // The cashier's own PIN does not hold the right.
        assert_eq!(confirm("2468").unwrap_err().reason, "Invalid PIN");
        asks();
        let approved = confirm("1357").unwrap();
        assert_eq!(approved["approvedBy"], APPROVER);
        assert_eq!(approved["sessionId"], Value::Null);
        assert_eq!(
            cancellation_actor(&db.conn.lock().unwrap(), &auth).unwrap(),
            CancellationActor {
                audit_id: APPROVER.into(),
                staff_id: Some(APPROVER.into())
            }
        );
        // Used once.
        asks();
        let audited: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM recovery_action_log
                 WHERE action_id='manager_approval' AND issue_code='void_orders'
                   AND actor_staff_id=?1",
                [APPROVER],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audited, 1);
    }

    #[test]
    fn a_delivery_platform_order_never_records_a_manual_return_like_android() {
        // Android refuses `external_plugin_order_id` and non-internal sources;
        // the desktop accepted an efood/Wolt order whose payment row was manual.
        for (plugin, external, refused) in [
            (Some("efood"), None, true),
            (Some("Wolt"), Some("W-77"), true),
            (None, Some("EXT-1"), true),
            (Some("unknown_market"), None, true),
            (Some("pos"), None, false),
            (Some("kiosk"), None, false),
            (Some("android-ios"), None, false),
            (None, None, false),
        ] {
            let conn = setup();
            conn.execute(
                "UPDATE orders SET plugin=?1,external_plugin_order_id=?2",
                params![plugin, external],
            )
            .unwrap();
            let result = prepare(&conn, "order");
            if refused {
                assert_eq!(
                    result.unwrap_err(),
                    PLATFORM_ORDER_RETURN_REQUIRED,
                    "{plugin:?} {external:?}"
                );
            } else {
                assert_eq!(result.unwrap()["amountCents"], 600, "{plugin:?}");
            }
            assert_eq!(count(&conn, "payment_adjustments"), 0);
        }
    }

    fn canonical_snapshot(payment: Value) -> Value {
        json!({"success":true,"data":{"order":{"id":REMOTE_ORDER},"payments":[payment],"adjustments":[],"staff_cash_returns":[]}})
    }

    fn canonical_cash_row() -> Value {
        json!({"id":REMOTE_PAYMENT,"order_id":REMOTE_ORDER,"organization_id":"org","branch_id":"branch",
            "payment_method":"cash","status":"completed","currency":"EUR","amount":6,"amount_cents":600,
            "external_transaction_id":null,"metadata":{"payment_origin":"cash_checkout_reconciled","source":"mobile_cart_checkout"}})
    }

    fn mirrored_cash_order() -> Connection {
        let conn = setup();
        conn.execute_batch(&format!(
            "UPDATE orders SET supabase_id='{REMOTE_ORDER}';
             UPDATE order_payments SET method='cash',payment_origin='sync_reconstructed',transaction_ref=NULL,metadata=NULL;"
        ))
        .unwrap();
        conn
    }

    #[test]
    fn a_receipt_taken_on_another_till_is_judged_by_its_canonical_row() {
        // Symptom: in a desktop-main + Android-satellite store, a plain cash
        // order paid on Android was mirrored here (`sync_reconstructed`, no
        // metadata) and refused as a provider original with a misleading
        // "originalReturnRequired"; Android and the server accept it.
        let conn = mirrored_cash_order();
        assert!(!original_is_manual_with_metadata(
            "cash",
            "sync_reconstructed",
            "",
            "",
            None
        ));
        // Without its canonical row the till cannot judge it.
        assert_eq!(
            prepare(&conn, "order").unwrap_err(),
            RECEIPT_CHECK_UNAVAILABLE
        );
        let mut evidence = admitted(&conn);
        evidence.receipts = CanonicalReceipts::Unavailable;
        assert_eq!(
            super::prepare(&conn, "order", &evidence).unwrap_err(),
            RECEIPT_CHECK_UNAVAILABLE
        );
        // The server's own classifier over its canonical row decides.
        evidence.receipts = canonical_receipts_from_snapshot(
            &conn,
            "order",
            &canonical_snapshot(canonical_cash_row()),
        )
        .unwrap();
        assert_eq!(
            evidence.receipts,
            CanonicalReceipts::Verified(BTreeSet::from(["payment".to_string()]))
        );
        let plan = super::prepare(&conn, "order", &evidence).unwrap();
        assert_eq!(plan["amountCents"], 600);
        let input = json!({"orderId":"order","reason":"Customer cancelled","returnChannel":"cash_drawer","requestId":"request-1","generation":plan["generation"]});
        super::commit(&conn, &input, &test_actor("admin-user"), &evidence).unwrap();
        assert_eq!(count(&conn, "payment_adjustments"), 1);
        // Provider evidence, or a canonical row that differs from the mirror,
        // never passes.
        let mut provider = canonical_cash_row();
        provider["metadata"] = json!({"provider":"viva"});
        let mut processed = canonical_cash_row();
        processed["metadata"] = json!({"terminal_processed":true});
        let mut amount = canonical_cash_row();
        amount["amount_cents"] = json!(500);
        let mut status = canonical_cash_row();
        status["status"] = json!("refunded");
        let mut branch = canonical_cash_row();
        branch["branch_id"] = json!("other-branch");
        let mut tender = canonical_cash_row();
        tender["payment_method"] = json!("card");
        for row in [provider, processed, amount, status, branch, tender] {
            let conn = mirrored_cash_order();
            let mut evidence = admitted(&conn);
            evidence.receipts =
                canonical_receipts_from_snapshot(&conn, "order", &canonical_snapshot(row.clone()))
                    .unwrap();
            assert_eq!(
                super::prepare(&conn, "order", &evidence).unwrap_err(),
                PROVIDER_REQUIRED,
                "{row}"
            );
            assert_eq!(count(&conn, "payment_adjustments"), 0);
        }
        // A snapshot of another order proves nothing.
        let conn = mirrored_cash_order();
        let mut other = canonical_snapshot(canonical_cash_row());
        other["data"]["order"]["id"] = json!("11111111-2222-4333-8444-555555555555");
        assert_eq!(
            canonical_receipts_from_snapshot(&conn, "order", &other).unwrap(),
            CanonicalReceipts::Unavailable
        );
    }

    #[test]
    fn a_waiter_cash_handback_of_a_mirrored_receipt_needs_its_canonical_row() {
        let conn = setup();
        staff_custody_fixture(&conn, "server");
        conn.execute(
            "UPDATE order_payments SET payment_origin='sync_reconstructed',metadata=NULL WHERE id='cash-payment'",
            [],
        )
        .unwrap();
        // The custody plan itself no longer refuses (it only lists receipts).
        assert_eq!(
            crate::staff_cash_returns::plan(&conn, "order").unwrap()[0]["amount_cents"],
            450
        );
        assert_eq!(
            prepare(&conn, "order").unwrap_err(),
            RECEIPT_CHECK_UNAVAILABLE
        );
        let mut evidence = admitted(&conn);
        evidence.receipts =
            CanonicalReceipts::Verified(BTreeSet::from(["cash-payment".to_string()]));
        let plan = super::prepare(&conn, "order", &evidence).unwrap();
        assert_eq!(plan["requiresHandback"], true);
        assert_eq!(plan["cashReturns"][0]["amount_cents"], 450);
        evidence.receipts = CanonicalReceipts::Verified(BTreeSet::new());
        assert_eq!(
            super::prepare(&conn, "order", &evidence).unwrap_err(),
            PROVIDER_REQUIRED
        );
    }

    // Store incident 07/10/2026 (desktop 1.4.125): a paid delivery order (one
    // manual card receipt with a 0.75 tip) went to a driver, was marked
    // delivered, then reset to pending; its cancellation was refused. The
    // path runs on the real local halves (`commands::orders::driver_restore_tests`).

    fn refunds(conn: &Connection) -> (i64, i64, String) {
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM payment_adjustments WHERE adjustment_type='refund'),
                    (SELECT COALESCE(SUM(amount_cents),0) FROM payment_adjustments WHERE adjustment_type='refund'),
                    (SELECT status FROM orders WHERE id=?1)",
            [crate::commands::orders::driver_restore_tests::ORDER],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn a_paid_delivery_reset_from_delivered_cancels_with_one_manual_return() {
        use crate::commands::orders::driver_restore_tests as restore;
        let _keyring = crate::tests::fake_keyring::install_empty();
        let mut conn = restore::test_conn();
        restore::paid_delivery_order(&conn);
        let mut server = restore::assign_and_deliver(&conn);
        restore::reset_to_pending(&mut conn);
        // RESET replays the receipt without its driver: until the server took
        // it, no return of that original is recorded (the cashier is told to
        // sync, never to charge again).
        assert_eq!(
            prepare(&conn, restore::ORDER).unwrap_err(),
            "PAYMENT_SYNC_REQUIRED"
        );
        server.sync(&conn);
        let plan = prepare(&conn, restore::ORDER).unwrap();
        assert_eq!(plan["requiresReturn"], true, "{plan}");
        assert_eq!(plan["requiresHandback"], false);
        assert_eq!(plan["cashReturns"], json!([]));
        assert_eq!(plan["amountCents"], 1075);
        assert_eq!(
            plan["payments"],
            json!([{"paymentId":restore::PAYMENT,"amountCents":1075}])
        );
        let input = json!({"orderId":restore::ORDER,"reason":"Customer cancelled","returnChannel":"bank",
            "requestId":"restored-cancel","generation":plan["generation"]});
        assert_eq!(
            commit(&conn, &input, "operator").unwrap()["amountCents"],
            1075
        );
        assert_eq!(
            commit(&conn, &input, "operator").unwrap()["duplicate"],
            true
        );
        assert_eq!(refunds(&conn), (1, 1075, "cancelled".into()));
        assert_eq!(count(&conn, "staff_order_cash_returns"), 0);
    }

    #[test]
    fn an_untipped_delivery_order_cancels_after_a_driver_run_and_reset() {
        // Without a driver tip nothing re-sent the receipt, yet driver
        // assignment and RESET marked it unsynced: refused forever with
        // PAYMENT_SYNC_REQUIRED before the fix.
        use crate::commands::orders::driver_restore_tests as restore;
        let _keyring = crate::tests::fake_keyring::install_empty();
        let mut conn = restore::test_conn();
        restore::paid_delivery_order(&conn);
        restore::without_tip(&conn);
        let mut server = restore::assign_and_deliver(&conn);
        // A delivered order with its driver cancels too (history cancel).
        assert_eq!(prepare(&conn, restore::ORDER).unwrap()["amountCents"], 1000);
        restore::reset_to_pending(&mut conn);
        assert_eq!(prepare(&conn, restore::ORDER).unwrap()["amountCents"], 1000);
        server.sync(&conn);
        let plan = prepare(&conn, restore::ORDER).unwrap();
        let input = json!({"orderId":restore::ORDER,"reason":"Customer cancelled","returnChannel":"bank",
            "requestId":"untipped-cancel","generation":plan["generation"]});
        commit(&conn, &input, "operator").unwrap();
        assert_eq!(refunds(&conn), (1, 1000, "cancelled".into()));
    }

    #[test]
    fn a_reset_delivery_order_corrected_after_reset_cancels_all_its_money_once() {
        use crate::commands::orders::driver_restore_tests as restore;
        let _keyring = crate::tests::fake_keyring::install_empty();
        let mut conn = restore::test_conn();
        restore::paid_delivery_order(&conn);
        let mut server = restore::assign_deliver_and_restore(&mut conn);
        let mut request = restore::correction_request("restored-edit");
        restore::preflight_correction(&conn, &server, &mut request).unwrap();
        assert_eq!(
            restore::save_correction(&conn, &request).unwrap()["success"],
            true
        );
        // The collected difference is not returned before it synced either.
        assert_eq!(
            prepare(&conn, restore::ORDER).unwrap_err(),
            "PAYMENT_SYNC_REQUIRED"
        );
        restore::sync_correction(&conn, &mut server, "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d");
        assert!(
            restore::queued(&conn).is_empty(),
            "{:?}",
            restore::queued(&conn)
        );
        let plan = prepare(&conn, restore::ORDER).unwrap();
        assert_eq!(plan["amountCents"], 1275, "{plan}");
        assert_eq!(plan["payments"].as_array().unwrap().len(), 2);
        let input = json!({"orderId":restore::ORDER,"reason":"Customer cancelled","returnChannel":"cash_drawer",
            "requestId":"restored-edited-cancel","generation":plan["generation"]});
        commit(&conn, &input, "operator").unwrap();
        assert_eq!(
            commit(&conn, &input, "operator").unwrap()["duplicate"],
            true
        );
        assert_eq!(refunds(&conn), (2, 1275, "cancelled".into()));
        let drawer_refunds: i64 = conn
            .query_row(
                "SELECT total_refunds_cents FROM cash_drawer_sessions WHERE id='cashier-drawer'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(drawer_refunds, 1275);
    }
}
