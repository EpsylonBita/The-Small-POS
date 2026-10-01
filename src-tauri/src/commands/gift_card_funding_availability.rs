//! Advisory hosted gift funding availability (`GET /api/pos/gift-cards/status`).
//!
//! `gift_funding_status` is the local attempt journal only. This read asks the
//! server whether the selected purpose authority may fund: the selected
//! cashier's usable original (its scoped hosted session) or the separately
//! authorized manager (the volatile grant authority, read and never consumed).
//! Native sends that private `x-staff-session-id` once, with no body, cache,
//! retry or fallback, and writes nothing: no attempt, opening, shift, drawer,
//! queue or setting row.
//!
//! The actor, trusted scope and authority are pinned before the await. A held
//! reply is published only while the dedicated clear has not run and the same
//! authority is still live in the same trusted scope. The strictly validated
//! projection is small and secret-free and never carries server diagnostics.
//! It is advisory: every funding write is decided again by the server.

use std::fmt;

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use tracing::warn;

use super::{
    capture_fence, cashier_scope, funding_auth, grant_session, hosted_refusal, is_code,
    is_currency, is_uuid, lock, not_configured, same_uuid, scope_unavailable, str_field,
    uuid_field, FundingError, FUNDING_CONTRACT, HTTP_TIMEOUT,
};
use crate::api::{self, AdminFetchError};
use crate::db;
use crate::gift_financial_opening::{self as opening, OpeningScope};

const STATUS_PATH: &str = "/api/pos/gift-cards/status";
const REQUEST_KEYS: [&str; 2] = ["staffId", "authority"];
/// Every mode of the shared readiness contract (`funding-readiness.ts`).
const MODE_KEYS: [&str; 4] = [
    "cash_confirmed",
    "external_card_recorded",
    "manager_grant",
    "verified_capture",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Authority {
    /// The selected cashier's usable original opening.
    Cashier,
    /// The separately authorized manager's grant authority.
    Manager,
}

impl Authority {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "cashier" => Some(Self::Cashier),
            "manager" => Some(Self::Manager),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Cashier => "cashier",
            Self::Manager => "manager",
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct AvailabilityRequest {
    staff_id: String,
    authority: Authority,
}

impl AvailabilityRequest {
    /// Exactly `staffId` and `authority`: no credential, header, URL or scope.
    pub(super) fn parse(payload: &Value) -> Result<Self, FundingError> {
        let Some(obj) = payload
            .as_object()
            .filter(|obj| obj.keys().all(|key| REQUEST_KEYS.contains(&key.as_str())))
        else {
            return Err(FundingError::new(
                "INVALID_FUNDING_REQUEST",
                "Only staffId and authority are accepted",
            ));
        };
        let staff_id = uuid_field(obj, "staffId")
            .ok_or_else(|| FundingError::new("INVALID_STAFF_ID", "staffId must be a UUID"))?;
        let authority = str_field(obj, "authority")
            .and_then(Authority::parse)
            .ok_or_else(|| {
                FundingError::new(
                    "INVALID_FUNDING_REQUEST",
                    "authority must be cashier or manager",
                )
            })?;
        Ok(Self {
            staff_id,
            authority,
        })
    }
}

/// The pinned actor, scope and authority of one read. Debug never shows the
/// session.
pub(super) struct AvailabilityPlan {
    request: AvailabilityRequest,
    scope: OpeningScope,
    /// Cashier only: the original opening whose hosted session is sent.
    pub(super) opening_key: Option<String>,
    pub(super) staff_session: String,
    fence: u64,
}

impl fmt::Debug for AvailabilityPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AvailabilityPlan")
            .field("request", &self.request)
            .field("opening_key", &self.opening_key)
            .finish_non_exhaustive()
    }
}

/// The purpose authority's current private session: the selected cashier's
/// usable original, or the manager's live grant authority (never consumed).
/// Neither substitutes for the other.
fn live_authority(
    conn: &Connection,
    scope: &OpeningScope,
    request: &AvailabilityRequest,
    now: DateTime<Utc>,
) -> Result<(Option<String>, String), FundingError> {
    match request.authority {
        Authority::Cashier => {
            let cashier =
                opening::scoped_hosted_cashier(conn, &cashier_scope(scope, &request.staff_id), now)
                    .map_err(hosted_refusal)?;
            Ok((
                Some(cashier.opening_key().to_string()),
                cashier.staff_session_header().to_string(),
            ))
        }
        Authority::Manager => Ok((None, grant_session(scope, &request.staff_id, now)?)),
    }
}

/// Pins the trusted scope and the live purpose authority before any await; a
/// missing scope or a missing, expired or cleared authority refuses here,
/// before transport.
pub(super) fn plan_availability(
    conn: &Connection,
    request: &AvailabilityRequest,
    now: DateTime<Utc>,
) -> Result<AvailabilityPlan, FundingError> {
    // Captured first: any later dedicated clear fences the reply.
    let fence = capture_fence();
    let scope = opening::trusted_scope(conn).ok_or_else(scope_unavailable)?;
    let (opening_key, staff_session) = live_authority(conn, &scope, request, now)?;
    Ok(AvailabilityPlan {
        request: request.clone(),
        scope,
        opening_key,
        staff_session,
        fence,
    })
}

/// Rechecks the original authority after endpoint resolution and hosted I/O.
/// A refusal carries neither the prior actor nor any readiness.
fn ensure_current_authority(
    conn: &Connection,
    plan: &AvailabilityPlan,
    now: DateTime<Utc>,
) -> Result<(), FundingError> {
    if !funding_auth().admits(plan.fence) {
        return Err(FundingError::new(
            "HOSTED_AUTHORIZATION_SUPERSEDED",
            "Authorization was cleared during the read; authorize again",
        ));
    }
    match opening::trusted_scope(conn) {
        Some(current) if current == plan.scope => {}
        Some(_) => return Err(super::scope_changed()),
        None => return Err(scope_unavailable()),
    }
    let (opening_key, staff_session) = live_authority(conn, &plan.scope, &plan.request, now)?;
    if opening_key != plan.opening_key || staff_session != plan.staff_session {
        return Err(FundingError::new(
            "HOSTED_AUTHORIZATION_CHANGED",
            "The authorization changed during the read; check again",
        ));
    }
    Ok(())
}

pub(super) fn finish_availability(
    conn: &Connection,
    plan: &AvailabilityPlan,
    reply: Result<&Value, &AdminFetchError>,
    now: DateTime<Utc>,
) -> Result<Value, FundingError> {
    ensure_current_authority(conn, plan, now)?;
    let body = reply.map_err(|_| {
        FundingError::new(
            "AVAILABILITY_READ_FAILED",
            "Gift card funding availability could not be read",
        )
    })?;
    let hosted = parse_availability(body, &plan.request.staff_id)?;
    Ok(projection(plan, &hosted))
}

struct ModeAvailability {
    supported: bool,
    ready: bool,
    /// The server's reason code while not ready.
    reason: Option<String>,
}

/// The validated nonsecret subset of the hosted status reply.
struct HostedAvailability {
    configured: bool,
    enabled: bool,
    unavailable: bool,
    currency: Option<String>,
    configuration_required: Option<String>,
    funding_configured: bool,
    modes: Vec<(&'static str, ModeAvailability)>,
    operator_ready: bool,
    operator_reason: Option<String>,
    return_payments: bool,
}

fn invalid(field: &'static str) -> FundingError {
    warn!("gift funding availability reply rejected at {field}");
    FundingError::new(
        "AVAILABILITY_REPLY_INVALID",
        "The gift card funding availability reply was not recognized",
    )
}

fn object<'a>(
    obj: &'a Map<String, Value>,
    key: &'static str,
) -> Result<&'a Map<String, Value>, FundingError> {
    obj.get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(key))
}

fn flag(obj: &Map<String, Value>, key: &'static str) -> Result<bool, FundingError> {
    obj.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(key))
}

/// Present, and either null or a string accepted by `valid`.
fn nullable(
    obj: &Map<String, Value>,
    key: &'static str,
    valid: fn(&str) -> bool,
) -> Result<Option<String>, FundingError> {
    match obj.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid(value) => Ok(Some(value.clone())),
        _ => Err(invalid(key)),
    }
}

/// Strict shape of `status/route.ts` with `funding-readiness.ts`. Missing,
/// partial or contradictory readiness refuses, never guesses; server
/// diagnostics (`error`) and unread fields are dropped.
fn parse_availability(body: &Value, staff_id: &str) -> Result<HostedAvailability, FundingError> {
    let root = body.as_object().ok_or_else(|| invalid("body"))?;
    if root.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(invalid("success"));
    }
    let gift = object(root, "gift_cards")?;
    let configured = flag(gift, "configured")?;
    let enabled = flag(gift, "enabled")?;
    let unavailable = flag(gift, "unavailable")?;
    // The outer copies, when present, agree with the inner ones.
    for (key, inner) in [
        ("configured", configured),
        ("enabled", enabled),
        ("unavailable", unavailable),
    ] {
        if root
            .get(key)
            .is_some_and(|outer| outer.as_bool() != Some(inner))
        {
            return Err(invalid(key));
        }
    }
    let currency = nullable(gift, "currency", is_currency)?;
    let configuration_required = nullable(gift, "configuration_required", is_code)?;
    if currency.is_some() && configuration_required.is_some() {
        return Err(invalid("configuration_required"));
    }

    let funding = object(gift, "funding")?;
    if str_field(funding, "contract") != Some(FUNDING_CONTRACT) {
        return Err(invalid("contract"));
    }
    let funding_configured = flag(funding, "configured")?;
    for (key, expected) in [
        ("staff_session_required", true),
        ("verified_capture", false),
        ("fiscal_receipt", false),
    ] {
        if funding.get(key).and_then(Value::as_bool) != Some(expected) {
            return Err(invalid(key));
        }
    }
    let listed = object(funding, "modes")?;
    let mut modes = Vec::with_capacity(MODE_KEYS.len());
    for key in MODE_KEYS {
        let mode = object(listed, key)?;
        let (supported, ready) = (flag(mode, "supported")?, flag(mode, "ready")?);
        let reason = str_field(mode, "reason").ok_or_else(|| invalid("reason"))?;
        // Ready needs support and carries no reason; not ready carries a code.
        let consistent = if ready {
            supported && reason.is_empty()
        } else {
            is_code(reason)
        };
        if !consistent {
            return Err(invalid(key));
        }
        let reason = (!ready).then(|| reason.to_string());
        modes.push((
            key,
            ModeAvailability {
                supported,
                ready,
                reason,
            },
        ));
    }
    // This client has no verified capture: it is never offered here.
    if modes
        .iter()
        .any(|(key, mode)| *key == "verified_capture" && (mode.supported || mode.ready))
    {
        return Err(invalid("verified_capture"));
    }

    let operator = object(gift, "operator")?;
    if operator
        .get("staff_session_required")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(invalid("operator"));
    }
    let operator_ready = flag(operator, "ready")?;
    let operator_reason = nullable(operator, "reason", is_code)?;
    let reported = nullable(operator, "staff_id", is_uuid)?;
    let return_payments = flag(object(operator, "capabilities")?, "return_payments")?;
    // Ready names its staff and no reason; not ready names a reason and may
    // still name the session's staff (for example a missing permission).
    if operator_ready == operator_reason.is_some()
        || (operator_ready && reported.is_none())
        || (return_payments && !operator_ready)
    {
        return Err(invalid("operator"));
    }
    // The session answered for other staff: nothing of it is adopted.
    if reported
        .as_deref()
        .is_some_and(|reported| !same_uuid(reported, staff_id))
    {
        return Err(FundingError::new(
            "HOSTED_STAFF_MISMATCH",
            "The hosted session answered for different staff",
        ));
    }
    // Readiness only with its whole basis: enabled and readable, a store
    // currency, the funding foundation and this ready operator.
    let basis =
        enabled && !unavailable && currency.is_some() && funding_configured && operator_ready;
    if !basis && modes.iter().any(|(_, mode)| mode.ready) {
        return Err(invalid("modes"));
    }
    Ok(HostedAvailability {
        configured,
        enabled,
        unavailable,
        currency,
        configuration_required,
        funding_configured,
        modes,
        operator_ready,
        operator_reason,
        return_payments,
    })
}

/// The approved projection: trusted actor and scope plus validated readiness.
fn projection(plan: &AvailabilityPlan, hosted: &HostedAvailability) -> Value {
    let modes: Map<String, Value> = hosted
        .modes
        .iter()
        .map(|(key, mode)| {
            let view =
                json!({ "supported": mode.supported, "ready": mode.ready, "reason": mode.reason });
            (key.to_string(), view)
        })
        .collect();
    json!({
        "success": true,
        "availability": {
            "staffId": plan.request.staff_id,
            "authority": plan.request.authority.as_str(),
            "organizationId": plan.scope.organization_id,
            "branchId": plan.scope.branch_id,
            "terminalId": plan.scope.terminal_id,
            "configured": hosted.configured,
            "enabled": hosted.enabled,
            "unavailable": hosted.unavailable,
            "currency": hosted.currency,
            "configurationRequired": hosted.configuration_required,
            "fundingConfigured": hosted.funding_configured,
            "modes": modes,
            "operator": {
                "ready": hosted.operator_ready,
                "reason": hosted.operator_reason,
                "returnPayments": hosted.return_payments,
            },
            "verifiedCapture": false,
            "fiscalReceipt": false,
        },
    })
}

/// One advisory read for the selected purpose authority.
pub(super) async fn read_availability(db: &db::DbState, payload: &Value) -> Result<Value, String> {
    read_availability_with_endpoint(db, payload, crate::resolve_admin_endpoint(Some(db))).await
}

/// Keep endpoint resolution inside the same invocation fence as the hosted read.
/// The injectable future also lets tests hold this earlier await without keychain or HTTP access.
pub(super) async fn read_availability_with_endpoint(
    db: &db::DbState,
    payload: &Value,
    endpoint: impl std::future::Future<
        Output = Result<(String, zeroize::Zeroizing<String>), AdminFetchError>,
    >,
) -> Result<Value, String> {
    let request = match AvailabilityRequest::parse(payload) {
        Ok(request) => request,
        Err(error) => return Ok(error.to_value(None)),
    };
    let plan = {
        let conn = lock(db)?;
        match plan_availability(&conn, &request, Utc::now()) {
            Ok(plan) => plan,
            Err(error) => return Ok(error.to_value(None)),
        }
    };
    let endpoint = endpoint.await;
    {
        let conn = lock(db)?;
        if let Err(error) = ensure_current_authority(&conn, &plan, Utc::now()) {
            return Ok(error.to_value(None));
        }
    }
    let Ok((url, api_key)) = endpoint else {
        return Ok(not_configured().to_value(None));
    };
    // The existing status GET with only the private header added.
    let reply = api::fetch_from_admin_detailed_with_staff_session(
        &url,
        &api_key,
        STATUS_PATH,
        "GET",
        None,
        Some(plan.staff_session.as_str()),
        HTTP_TIMEOUT,
    )
    .await;
    let conn = lock(db)?;
    Ok(
        finish_availability(&conn, &plan, reply.as_ref(), Utc::now())
            .unwrap_or_else(|error| error.to_value(None)),
    )
}
