//! ECR device admission (founder rule 08/10/2026): a plugin that is not
//! activated, configured and finished has no effect anywhere on the till.
//!
//! An ECR device saved on this till is admitted only through the plugin
//! behind it (the same contract as Android `POSSystemMobile`):
//! - a card terminal (`payment_terminal`) when
//!   `GET /api/pos/payments/manual-admission` answers
//!   `provider_connected: true` for exactly this terminal scope (a
//!   payment-category plugin is licensed and configured for the branch);
//! - a cash register (`cash_register`, the fiscal device) when
//!   `GET /api/pos/mydata/config` answers 200 with `config.mode ==
//!   "fiscal_device"` and `config.status == "connected"`. `connected` is the
//!   status the server sets only after the till's terminal-bound native
//!   protocol handshake was verified (`fiscal_device_not_verified` refuses
//!   anything less); `pending` (setup reserved, never finished), `inactive`
//!   and `error` are not finished.
//!
//! The last answer for each kind is kept in `local_settings` with its fetch
//! time and the terminal scope it was read for. Offline the last known answer
//! applies; a never fetched answer, an answer for another scope or an
//! unreadable one is "not admitted". A device that is not admitted is inert:
//! it is not the default device (`db::ecr_get_default_device`), never charges
//! a card or prints a fiscal receipt, and blocks nothing (manual cards, manual
//! returns, cancellations, edits, gift cards or the Z).

use crate::{
    db,
    gift_financial_opening::OpeningScope,
    manual_order_cancellation::{admission_from_response, ProviderAdmission},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

/// Tells the renderer that a stored answer was just re-read. Publishing never
/// reads anything and never changes when an answer is read.
pub(crate) const UPDATED_EVENT: &str = "ecr_device_admission_updated";
pub(crate) const CARD_TERMINAL: &str = "payment_terminal";
pub(crate) const CASH_REGISTER: &str = "cash_register";
/// A device whose plugin is not active, configured and finished.
pub(crate) const NOT_ADMITTED_CODE: &str = "DEVICE_NOT_ADMITTED";
/// A device saved without an explicit, known device type.
pub(crate) const TYPE_REQUIRED_CODE: &str = "DEVICE_TYPE_REQUIRED";
pub(crate) const MANUAL_ADMISSION_PATH: &str = "/api/pos/payments/manual-admission";
pub(crate) const MYDATA_CONFIG_PATH: &str = "/api/pos/mydata/config";
/// How often the heartbeat loop re-reads both answers.
pub(crate) const REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);

const CATEGORY: &str = "device_admission";
const CARD_KEY: &str = "card_terminal";
const FISCAL_KEY: &str = "cash_register";

/// One persisted admission answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Admission {
    pub(crate) admitted: bool,
    pub(crate) fetched_at: String,
    pub(crate) organization_id: String,
    pub(crate) branch_id: String,
    pub(crate) terminal_id: String,
    #[serde(default)]
    pub(crate) mode: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
}

/// The two device types this till knows; anything else is never admitted.
pub(crate) fn known_device_type(device_type: &str) -> Option<&'static str> {
    match device_type.trim() {
        CARD_TERMINAL => Some(CARD_TERMINAL),
        CASH_REGISTER => Some(CASH_REGISTER),
        _ => None,
    }
}

fn key_for(device_type: &str) -> Option<&'static str> {
    match known_device_type(device_type)? {
        CARD_TERMINAL => Some(CARD_KEY),
        _ => Some(FISCAL_KEY),
    }
}

fn read_stored(conn: &Connection, device_type: &str) -> Option<Admission> {
    let raw = db::get_setting(conn, CATEGORY, key_for(device_type)?)?;
    serde_json::from_str(&raw).ok()
}

fn same_scope(admission: &Admission, scope: &OpeningScope) -> bool {
    admission.organization_id == scope.organization_id
        && admission.branch_id == scope.branch_id
        && admission.terminal_id == scope.terminal_id
}

/// The last known answer for `device_type`, only when it was read for this
/// till's current terminal scope.
pub(crate) fn last_known(conn: &Connection, device_type: &str) -> Option<Admission> {
    // The stored row first: a till with no answer never resolves the scope.
    let stored = read_stored(conn, device_type)?;
    let scope = OpeningScope::resolve(conn)?;
    same_scope(&stored, &scope).then_some(stored)
}

/// Whether a device of `device_type` may act on this till.
pub(crate) fn is_admitted(conn: &Connection, device_type: &str) -> bool {
    last_known(conn, device_type).is_some_and(|admission| admission.admitted)
}

/// The admitted device types, in a fixed order.
pub(crate) fn admitted_types(conn: &Connection) -> Vec<&'static str> {
    [CARD_TERMINAL, CASH_REGISTER]
        .into_iter()
        .filter(|device_type| is_admitted(conn, device_type))
        .collect()
}

/// Whether an ECR device row (the camelCase JSON from `db::ecr_*`) is
/// admitted by its own type.
pub(crate) fn device_admitted(conn: &Connection, device: &Value) -> bool {
    device
        .get("deviceType")
        .or_else(|| device.get("device_type"))
        .and_then(Value::as_str)
        .is_some_and(|device_type| is_admitted(conn, device_type))
}

fn store(
    conn: &Connection,
    device_type: &str,
    scope: &OpeningScope,
    admitted: bool,
    mode: Option<String>,
    status: Option<String>,
) -> Result<Admission, String> {
    let key = key_for(device_type).ok_or(TYPE_REQUIRED_CODE)?;
    let admission = Admission {
        admitted,
        fetched_at: chrono::Utc::now().to_rfc3339(),
        organization_id: scope.organization_id.clone(),
        branch_id: scope.branch_id.clone(),
        terminal_id: scope.terminal_id.clone(),
        mode,
        status,
    };
    let raw = serde_json::to_string(&admission).map_err(|error| error.to_string())?;
    db::set_setting(conn, CATEGORY, key, &raw)?;
    Ok(admission)
}

/// Persist one answer for `device_type`, bound to `scope`.
pub(crate) fn record(
    conn: &Connection,
    device_type: &str,
    scope: &OpeningScope,
    admitted: bool,
    mode: Option<String>,
    status: Option<String>,
) -> Result<(), String> {
    store(conn, device_type, scope, admitted, mode, status).map(|_| ())
}

/// Persist a card-terminal answer read from manual-admission. Only a definite
/// answer is kept; an unavailable or unchecked one leaves the last known.
pub(crate) fn record_card_admission(
    conn: &Connection,
    scope: &OpeningScope,
    admission: ProviderAdmission,
) -> Result<(), String> {
    match admission {
        ProviderAdmission::Connected => record(conn, CARD_TERMINAL, scope, true, None, None),
        ProviderAdmission::NotConnected => record(conn, CARD_TERMINAL, scope, false, None, None),
        ProviderAdmission::NotChecked | ProviderAdmission::Unavailable => Ok(()),
    }
}

/// Read a `GET /api/pos/mydata/config` 200 answer: `(admitted, mode, status)`,
/// or `None` when it carries no readable config object.
pub(crate) fn fiscal_admission_from_response(
    response: &Value,
) -> Option<(bool, Option<String>, Option<String>)> {
    let config = response
        .get("config")
        .filter(|config| config.is_object())
        .or_else(|| {
            response
                .get("data")
                .and_then(|data| data.get("config"))
                .filter(|config| config.is_object())
        })?;
    let text = |key: &str| {
        config
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    };
    let mode = text("mode");
    let status = text("status");
    let admitted =
        mode.as_deref() == Some("fiscal_device") && status.as_deref() == Some("connected");
    Some((admitted, mode, status))
}

/// Persist the fiscal answer from a mydata-config read. A 404 from the admin
/// application itself (MyData not purchased or not configured for the branch)
/// is a definite "not admitted"; any other failure keeps the last known.
pub(crate) fn record_fiscal_result(
    conn: &Connection,
    scope: &OpeningScope,
    result: &Result<Value, crate::api::AdminFetchError>,
) -> Result<(), String> {
    match result {
        Ok(body) => match fiscal_admission_from_response(body) {
            Some((admitted, mode, status)) => {
                record(conn, CASH_REGISTER, scope, admitted, mode, status)
            }
            None => Ok(()),
        },
        Err(error) if error.status() == Some(404) && error.has_app_error_body() => {
            record(conn, CASH_REGISTER, scope, false, None, None)
        }
        Err(_) => Ok(()),
    }
}

/// Re-read both answers from the server for this till's scope. Network or
/// server failures keep the last known answers; a scope change during the
/// read discards them. Never holds the database lock across the requests.
async fn refresh_storing(db: &db::DbState) -> Result<Option<Admission>, String> {
    let scope = {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        OpeningScope::resolve(&conn)
    };
    let Some(scope) = scope else {
        return Ok(None);
    };
    let card = crate::admin_fetch_detailed(Some(db), MANUAL_ADMISSION_PATH, "GET", None).await;
    let fiscal = crate::admin_fetch_detailed(Some(db), MYDATA_CONFIG_PATH, "GET", None).await;
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    if OpeningScope::resolve(&conn).as_ref() != Some(&scope) {
        return Ok(None);
    }
    let card_admission = match card
        .as_ref()
        .ok()
        .map(|body| admission_from_response(&scope, body))
    {
        Some(ProviderAdmission::Connected) => {
            Some(store(&conn, CARD_TERMINAL, &scope, true, None, None)?)
        }
        Some(ProviderAdmission::NotConnected) => {
            Some(store(&conn, CARD_TERMINAL, &scope, false, None, None)?)
        }
        Some(ProviderAdmission::NotChecked | ProviderAdmission::Unavailable) | None => None,
    };
    record_fiscal_result(&conn, &scope, &fiscal)?;
    Ok(card_admission)
}

pub(crate) async fn refresh(db: &db::DbState) -> Result<(), String> {
    refresh_storing(db).await.map(|_| ())
}

/// The renderer's view of the card answer just stored.
pub(crate) fn card_event(admission: &Admission) -> Value {
    json!({
        "success": true,
        "cardTerminal": {
            "admitted": admission.admitted,
            "fetchedAt": admission.fetched_at,
            "organizationId": admission.organization_id,
            "branchId": admission.branch_id,
            "terminalId": admission.terminal_id,
        },
    })
}

/// Refresh both answers and dispatch the card update off the heartbeat loop.
pub(crate) async fn refresh_and_publish(
    app: &tauri::AppHandle,
    db: &db::DbState,
) -> Result<(), String> {
    if let Some(card) = refresh_storing(db).await? {
        let view = card_event(&card);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = app.emit(UPDATED_EVENT, view) {
                tracing::warn!(error = %error, "ECR device admission publish failed");
            }
        });
    }
    Ok(())
}

/// The renderer's view of both admissions (`ecr_get_device_admission`).
pub(crate) fn snapshot(conn: &Connection) -> Value {
    let card = last_known(conn, CARD_TERMINAL);
    let fiscal = last_known(conn, CASH_REGISTER);
    json!({
        "success": true,
        "cardTerminal": {
            "admitted": card.as_ref().is_some_and(|a| a.admitted),
            "fetchedAt": card.as_ref().map(|a| a.fetched_at.clone()),
            "organizationId": card.as_ref().map(|a| a.organization_id.as_str()),
            "branchId": card.as_ref().map(|a| a.branch_id.as_str()),
            "terminalId": card.as_ref().map(|a| a.terminal_id.as_str()),
        },
        "cashRegister": {
            "admitted": fiscal.as_ref().is_some_and(|a| a.admitted),
            "fetchedAt": fiscal.as_ref().map(|a| a.fetched_at.clone()),
            "mode": fiscal.as_ref().and_then(|a| a.mode.clone()),
            "status": fiscal.as_ref().and_then(|a| a.status.clone()),
        },
    })
}

/// Send a snapshot the caller already took to the renderer.
pub(crate) fn publish_snapshot(app: &tauri::AppHandle, view: &Value) {
    if let Err(error) = app.emit(UPDATED_EVENT, view.clone()) {
        tracing::warn!(error = %error, "ECR device admission publish failed");
    }
}

/// The refusal a till answers when a device it may not use is asked to act
/// or to be enabled.
pub(crate) fn not_admitted_response(device_type: &str) -> Value {
    let error = match known_device_type(device_type) {
        Some(CARD_TERMINAL) => {
            "This card terminal needs an active, configured payment plugin for this store. It stays inactive until then."
        }
        Some(_) => {
            "This cash register needs the MyData plugin in fiscal-device mode with its setup finished. It stays inactive until then."
        }
        None => "Choose whether this device is a card terminal or a cash register.",
    };
    json!({
        "success": false,
        "code": if known_device_type(device_type).is_some() { NOT_ADMITTED_CODE } else { TYPE_REQUIRED_CODE },
        "deviceType": device_type,
        "error": error,
    })
}

/// Admit every known device type for this till's scope (tests only). Seeds a
/// terminal scope into `local_settings` when the test has none, so the
/// admission never resolves a scope from the real keyring.
#[cfg(test)]
pub(crate) fn admit_for_test(conn: &Connection, device_types: &[&str]) {
    for (key, fallback) in [
        ("organization_id", "11111111-1111-4111-8111-111111111111"),
        ("branch_id", "22222222-2222-4222-8222-222222222222"),
        ("terminal_id", "terminal-admission-test"),
    ] {
        if db::get_setting(conn, "terminal", key)
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            db::set_setting(conn, "terminal", key, fallback).expect("seed terminal scope");
        }
    }
    let scope = OpeningScope::resolve(conn).expect("terminal scope");
    for device_type in device_types {
        let (mode, status) = if *device_type == CASH_REGISTER {
            (
                Some("fiscal_device".to_string()),
                Some("connected".to_string()),
            )
        } else {
            (None, None)
        };
        record(conn, device_type, &scope, true, mode, status).expect("record admission");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::run_migrations_for_test(&conn);
        conn
    }

    fn scope(conn: &Connection) -> OpeningScope {
        for (key, value) in [
            ("organization_id", "11111111-1111-4111-8111-111111111111"),
            ("branch_id", "22222222-2222-4222-8222-222222222222"),
            ("terminal_id", "terminal-1"),
        ] {
            db::set_setting(conn, "terminal", key, value).unwrap();
        }
        OpeningScope::resolve(conn).unwrap()
    }

    fn manual_admission(scope: &OpeningScope, provider_connected: bool) -> Value {
        json!({
            "success": true,
            "admission_version": 1,
            "organization_id": scope.organization_id,
            "branch_id": scope.branch_id,
            "terminal_id": scope.terminal_id,
            "provider_connected": provider_connected,
        })
    }

    #[test]
    fn store_returns_the_persisted_answer() {
        let conn = conn();
        let scope = scope(&conn);
        let stored = store(
            &conn,
            CASH_REGISTER,
            &scope,
            true,
            Some("fiscal_device".to_string()),
            Some("connected".to_string()),
        )
        .unwrap();
        assert_eq!(read_stored(&conn, CASH_REGISTER), Some(stored));
    }

    #[test]
    fn card_event_contains_only_the_stored_card_answer() {
        let conn = conn();
        let scope = scope(&conn);
        record(&conn, CARD_TERMINAL, &scope, true, None, None).unwrap();
        let stored = read_stored(&conn, CARD_TERMINAL).unwrap();
        assert_eq!(
            card_event(&stored),
            json!({
                "success": true,
                "cardTerminal": {
                    "admitted": true,
                    "fetchedAt": stored.fetched_at,
                    "organizationId": scope.organization_id,
                    "branchId": scope.branch_id,
                    "terminalId": scope.terminal_id,
                },
            })
        );
    }

    #[test]
    fn the_snapshot_names_the_scope_of_the_card_answer() {
        let conn = conn();
        let scope = scope(&conn);
        for key in ["organizationId", "branchId", "terminalId"] {
            assert_eq!(snapshot(&conn)["cardTerminal"][key], Value::Null);
        }
        record(&conn, CARD_TERMINAL, &scope, false, None, None).unwrap();
        let view = snapshot(&conn);
        assert_eq!(
            view["cardTerminal"]["organizationId"],
            scope.organization_id
        );
        assert_eq!(view["cardTerminal"]["branchId"], scope.branch_id);
        assert_eq!(view["cardTerminal"]["terminalId"], scope.terminal_id);
        // After a re-pair the stored answer is another scope's: no ids, not admitted.
        db::set_setting(
            &conn,
            "terminal",
            "branch_id",
            "33333333-3333-4333-8333-333333333333",
        )
        .unwrap();
        for key in ["organizationId", "branchId", "terminalId", "fetchedAt"] {
            assert_eq!(snapshot(&conn)["cardTerminal"][key], Value::Null);
        }
    }

    #[test]
    fn never_fetched_admits_nothing() {
        let conn = conn();
        scope(&conn);
        assert!(!is_admitted(&conn, CARD_TERMINAL));
        assert!(!is_admitted(&conn, CASH_REGISTER));
        assert!(admitted_types(&conn).is_empty());
        let view = snapshot(&conn);
        assert_eq!(view["cardTerminal"]["admitted"], false);
        assert_eq!(view["cardTerminal"]["fetchedAt"], Value::Null);
        assert_eq!(view["cashRegister"]["admitted"], false);
    }

    #[test]
    fn card_terminal_follows_provider_connected_only() {
        let conn = conn();
        let scope = scope(&conn);
        let connected = admission_from_response(&scope, &manual_admission(&scope, true));
        record_card_admission(&conn, &scope, connected).unwrap();
        assert!(is_admitted(&conn, CARD_TERMINAL));
        assert!(!is_admitted(&conn, CASH_REGISTER));

        let none = admission_from_response(&scope, &manual_admission(&scope, false));
        record_card_admission(&conn, &scope, none).unwrap();
        assert!(!is_admitted(&conn, CARD_TERMINAL));

        // An unreadable answer (another terminal's) keeps the last known.
        record_card_admission(&conn, &scope, connected).unwrap();
        let mut foreign = manual_admission(&scope, false);
        foreign["terminal_id"] = json!("terminal-2");
        record_card_admission(&conn, &scope, admission_from_response(&scope, &foreign)).unwrap();
        assert!(is_admitted(&conn, CARD_TERMINAL));
    }

    #[test]
    fn cash_register_needs_fiscal_device_mode_and_a_finished_setup() {
        let conn = conn();
        let scope = scope(&conn);
        let answer = |mode: &str, status: &str| {
            Ok(json!({ "config": { "mode": mode, "status": status }, "provider_status": {} }))
        };
        // The store of 08/10/2026: fiscal_device, setup never finished.
        record_fiscal_result(&conn, &scope, &answer("fiscal_device", "pending")).unwrap();
        assert!(!is_admitted(&conn, CASH_REGISTER));
        assert_eq!(snapshot(&conn)["cashRegister"]["status"], "pending");
        for (mode, status) in [
            ("fiscal_device", "inactive"),
            ("fiscal_device", "error"),
            ("provider", "connected"),
        ] {
            record_fiscal_result(&conn, &scope, &answer(mode, status)).unwrap();
            assert!(!is_admitted(&conn, CASH_REGISTER), "{mode}/{status}");
        }
        record_fiscal_result(&conn, &scope, &answer("fiscal_device", "connected")).unwrap();
        assert!(is_admitted(&conn, CASH_REGISTER));
        assert!(!is_admitted(&conn, CARD_TERMINAL));
        assert_eq!(admitted_types(&conn), vec![CASH_REGISTER]);
    }

    #[test]
    fn failures_keep_the_last_known_answer_and_an_app_404_revokes() {
        let conn = conn();
        let scope = scope(&conn);
        let connected = Ok(json!({ "config": { "mode": "fiscal_device", "status": "connected" } }));
        record_fiscal_result(&conn, &scope, &connected).unwrap();
        // Offline / platform page / server error: the last known stays.
        for error in [
            crate::api::AdminFetchError::transport("offline"),
            crate::api::AdminFetchError::with_status("bad gateway", 502),
            crate::api::AdminFetchError::from_http_response_for_test(404, "<html>not found</html>"),
        ] {
            record_fiscal_result(&conn, &scope, &Err(error)).unwrap();
            assert!(is_admitted(&conn, CASH_REGISTER));
        }
        // A 200 without a config object is unreadable, never "off".
        record_fiscal_result(&conn, &scope, &Ok(json!({ "error": "x" }))).unwrap();
        assert!(is_admitted(&conn, CASH_REGISTER));
        // The admin app's own 404: MyData not purchased for the branch.
        let not_purchased = crate::api::AdminFetchError::from_http_response_for_test(
            404,
            r#"{"error":"MyData plugin not purchased"}"#,
        );
        record_fiscal_result(&conn, &scope, &Err(not_purchased)).unwrap();
        assert!(!is_admitted(&conn, CASH_REGISTER));
    }

    #[test]
    fn an_answer_for_another_terminal_scope_admits_nothing() {
        let conn = conn();
        let scope = scope(&conn);
        record(&conn, CARD_TERMINAL, &scope, true, None, None).unwrap();
        assert!(is_admitted(&conn, CARD_TERMINAL));
        db::set_setting(
            &conn,
            "terminal",
            "branch_id",
            "33333333-3333-4333-8333-333333333333",
        )
        .unwrap();
        assert!(!is_admitted(&conn, CARD_TERMINAL));
        assert_eq!(snapshot(&conn)["cardTerminal"]["fetchedAt"], Value::Null);
    }

    #[test]
    fn unknown_device_types_are_never_admitted() {
        let conn = conn();
        admit_for_test(&conn, &[CARD_TERMINAL, CASH_REGISTER]);
        assert!(!is_admitted(&conn, "fiscal_printer"));
        assert!(!is_admitted(&conn, ""));
        assert!(device_admitted(
            &conn,
            &json!({ "deviceType": "payment_terminal" })
        ));
        assert!(!device_admitted(&conn, &json!({ "deviceType": "other" })));
        assert!(!device_admitted(&conn, &json!({})));
        assert_eq!(not_admitted_response("other")["code"], TYPE_REQUIRED_CODE);
        assert_eq!(
            not_admitted_response(CASH_REGISTER)["code"],
            NOT_ADMITTED_CODE
        );
    }
}
