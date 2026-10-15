//! Phone shifts of this Main's unit (founder rule 13/10/2026: phones always
//! hand over to the Main).
//!
//! A phone ("mobile_waiter" child terminal) shift lives only on the server and
//! on the phone; this till's `staff_shifts` never holds it, so the local
//! active-shift gate of the Z cannot see it. The Z asks the server instead:
//!
//! - before it closes the local day, `GET /api/pos/shifts/unit-readiness`
//!   (`fetch_unit_readiness`): an open phone shift stops the Z, named
//!   (`Z_REPORT_UNIT_SHIFTS_OPEN`); a check that cannot be made stops it too
//!   (`Z_REPORT_UNIT_SHIFTS_UNAVAILABLE`), because the local day must not
//!   close unchecked. Only a server without the endpoint (404) or a till that
//!   is not a Main (403 `UNIT_READINESS_MAIN_ONLY`) skips the check;
//! - the queued Z itself declares `unit-shifts-z-gate-v1`
//!   (`api::UNIT_SHIFTS_Z_GATE_CAPABILITY`), and a `409
//!   Z_REPORT_UNIT_SHIFTS_OPEN` keeps that queue row waiting, never failed;
//! - the closed phone shifts of the window go into the stored Z as
//!   `phoneShifts` (its staff section), next to the local `staffReports`.
//!
//! Contract: `docs/architecture/phone-shift-handover.md`.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::time::Duration;
use tracing::warn;

use crate::api::AdminFetchError;
use crate::money::Cents;

/// The server's refusal of a Z while a phone shift of the unit is open, and
/// the native Z stage's own refusal code for the same.
pub(crate) const Z_REPORT_UNIT_SHIFTS_OPEN: &str = "Z_REPORT_UNIT_SHIFTS_OPEN";
/// The native Z stage could not check the phone shifts: the day stays open.
pub(crate) const Z_REPORT_UNIT_SHIFTS_UNAVAILABLE: &str = "Z_REPORT_UNIT_SHIFTS_UNAVAILABLE";
const UNIT_READINESS_MAIN_ONLY: &str = "UNIT_READINESS_MAIN_ONLY";
const UNIT_READINESS_PATH: &str = "/api/pos/shifts/unit-readiness";
/// A readiness read is a few indexed selects; the Z does not wait longer.
const UNIT_READINESS_TIMEOUT: Duration = Duration::from_secs(20);
/// The stage name the Z attempt record and the renderer see.
pub(crate) const UNIT_SHIFTS_STAGE: &str = "unit_shifts";
/// A queued Z's stored reason never grows past this (it names shifts).
const WAIT_REASON_MAX_CHARS: usize = 400;

/// The parts of the readiness answer the Z uses (server objects, unchanged).
#[derive(Debug, Clone, Default)]
pub(crate) struct UnitReadiness {
    pub open_shifts: Vec<Value>,
    pub closed_shifts: Vec<Value>,
}

#[derive(Debug, Clone)]
pub(crate) enum UnitReadinessOutcome {
    Ready(UnitReadiness),
    /// A server without the endpoint (404) or a till that is not a Main
    /// (403 `UNIT_READINESS_MAIN_ONLY`): the check does not apply.
    Skipped(&'static str),
    /// Anything else: offline, 5xx, 401, an unreadable answer.
    Unavailable(String),
}

fn readiness_path(since: Option<&str>) -> String {
    match since.map(str::trim).filter(|since| !since.is_empty()) {
        Some(since) => {
            crate::build_admin_query(UNIT_READINESS_PATH, Some(&json!({ "since": since })))
        }
        None => UNIT_READINESS_PATH.to_string(),
    }
}

fn is_named_shift(value: &Value) -> bool {
    ["id", "terminal_id"].iter().all(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    })
}

/// Read one readiness answer. An answer that is not the documented shape is
/// `Unavailable`, never an empty list: an empty list would let a Z through.
pub(crate) fn classify_readiness_response(
    result: Result<Value, AdminFetchError>,
) -> UnitReadinessOutcome {
    match result {
        Ok(body) => {
            let shifts = |key: &str| body.get(key).and_then(Value::as_array).cloned();
            match (
                body.get("success").and_then(Value::as_bool),
                shifts("open_shifts"),
                shifts("closed_shifts"),
            ) {
                (Some(true), Some(open_shifts), Some(closed_shifts))
                    if open_shifts.iter().all(is_named_shift)
                        && closed_shifts.iter().all(is_named_shift) =>
                {
                    UnitReadinessOutcome::Ready(UnitReadiness {
                        open_shifts,
                        closed_shifts,
                    })
                }
                _ => UnitReadinessOutcome::Unavailable("UNIT_READINESS_MALFORMED".to_string()),
            }
        }
        Err(error) => match error.status() {
            Some(404) => UnitReadinessOutcome::Skipped("not_found"),
            Some(403) if error.code() == Some(UNIT_READINESS_MAIN_ONLY) => {
                UnitReadinessOutcome::Skipped("not_main")
            }
            _ => UnitReadinessOutcome::Unavailable(error.to_string()),
        },
    }
}

/// `GET /api/pos/shifts/unit-readiness` against one admin endpoint.
pub(crate) async fn fetch_unit_readiness_from(
    admin_url: &str,
    api_key: &str,
    since: Option<&str>,
) -> UnitReadinessOutcome {
    classify_readiness_response(
        crate::api::fetch_from_admin_detailed_with_timeout(
            admin_url,
            api_key,
            &readiness_path(since),
            "GET",
            None,
            UNIT_READINESS_TIMEOUT,
        )
        .await,
    )
}

/// The same read with this terminal's own managed credentials.
pub(crate) async fn fetch_unit_readiness(
    db: &crate::db::DbState,
    since: Option<&str>,
) -> UnitReadinessOutcome {
    match crate::resolve_admin_endpoint(Some(db)).await {
        Ok((admin_url, api_key)) => fetch_unit_readiness_from(&admin_url, &api_key, since).await,
        Err(error) => UnitReadinessOutcome::Unavailable(error.to_string()),
    }
}

fn parse_instant(value: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?.trim())
        .ok()
        .map(|instant| instant.with_timezone(&Utc))
}

fn text<'a>(shift: &'a Value, key: &str) -> Option<&'a str> {
    shift
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// The open phone shifts that hold a Z whose window ends at `cutoff`. Only a
/// Z already issued has a cutoff in the past (`frozen`): a phone shift that
/// started after it belongs to the next POS day, as on the server
/// (`checkedInBefore: periodEnd`). An unreadable check-in time holds the Z.
pub(crate) fn open_shifts_holding_z(
    open_shifts: &[Value],
    frozen_cutoff: Option<&str>,
) -> Vec<Value> {
    let Some(cutoff) = parse_instant(frozen_cutoff) else {
        return open_shifts.to_vec();
    };
    open_shifts
        .iter()
        .filter(|shift| {
            parse_instant(text(shift, "check_in_time")).map_or(true, |check_in| check_in <= cutoff)
        })
        .cloned()
        .collect()
}

/// A plain-language list for logs and the refusal's English `error`, like the
/// server's `describeOpenUnitShifts`: `Maria (waiter, Phone 1), ...`.
pub(crate) fn describe_open_shifts(open_shifts: &[Value]) -> String {
    open_shifts
        .iter()
        .map(|shift| {
            let who = text(shift, "staff_name")
                .or_else(|| text(shift, "staff_id"))
                .or_else(|| text(shift, "id"))
                .unwrap_or("?");
            let role = text(shift, "role_type").unwrap_or("staff");
            let phone = text(shift, "terminal_name")
                .or_else(|| text(shift, "terminal_id"))
                .unwrap_or("?");
            format!("{who} ({role}, {phone})")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The Z refused before the local day closes: open phone shifts, named. The
/// renderer reads `openShifts` (the server's objects) in the store's language.
pub(crate) fn z_unit_shifts_open_response(open_shifts: &[Value]) -> Value {
    json!({
        "success": false,
        "errorCode": Z_REPORT_UNIT_SHIFTS_OPEN,
        "stage": UNIT_SHIFTS_STAGE,
        "error": format!(
            "Close the phone shifts before the Z: {}",
            describe_open_shifts(open_shifts)
        ),
        "openShifts": open_shifts,
    })
}

/// The Z refused because the phone shifts could not be checked. The detail
/// (which may name the admin URL) goes to the log, not to the operator.
pub(crate) fn z_unit_shifts_unavailable_response(detail: &str) -> Value {
    warn!(detail = %detail, "Z refused: the phone shifts of this register could not be checked");
    json!({
        "success": false,
        "errorCode": Z_REPORT_UNIT_SHIFTS_UNAVAILABLE,
        "stage": UNIT_SHIFTS_STAGE,
        "error": "The phone shifts of this register could not be checked, so the day cannot close now. Check the connection and try again.",
    })
}

/// Does a `POST /api/pos/z-report/submit` answer refuse the Z because a phone
/// shift of the unit is open? Only a 409 whose body names the code.
pub(crate) fn response_reports_unit_shifts_open(status: u16, body: &str) -> bool {
    status == 409
        && serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|body| body.get("code").and_then(Value::as_str).map(str::to_string))
            .as_deref()
            == Some(Z_REPORT_UNIT_SHIFTS_OPEN)
}

/// The same refusal read from `api::fetch_from_admin`'s error text, which
/// carries the answer's `error` sentence, `(HTTP 409)` and its body.
pub(crate) fn error_message_reports_unit_shifts_open(message: &str) -> bool {
    message.contains("(HTTP 409)") && message.contains(Z_REPORT_UNIT_SHIFTS_OPEN)
}

/// The names of open phone shifts, without any English word, for the
/// operator's own sentence: `Maria (Phone 1), Nikos (Phone 2)`.
pub(crate) fn open_shift_names(open_shifts: &[Value]) -> String {
    open_shifts
        .iter()
        .map(|shift| {
            let who = text(shift, "staff_name")
                .or_else(|| text(shift, "staff_id"))
                .or_else(|| text(shift, "id"))
                .unwrap_or("?");
            match text(shift, "terminal_name").or_else(|| text(shift, "terminal_id")) {
                Some(phone) => format!("{who} ({phone})"),
                None => who.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `Z_REPORT_UNIT_SHIFTS_OPEN: <names>`, bounded. The code, never an English
/// sentence, leads (coordinator review 14/10/2026): Sync health and the
/// closeout blockers turn it into the operator's own words with the names.
fn bounded_wait_reason(names: &str) -> String {
    let collapsed = names.split_whitespace().collect::<Vec<_>>().join(" ");
    let reason = if collapsed.is_empty() {
        Z_REPORT_UNIT_SHIFTS_OPEN.to_string()
    } else {
        format!("{Z_REPORT_UNIT_SHIFTS_OPEN}: {collapsed}")
    };
    if reason.chars().count() > WAIT_REASON_MAX_CHARS {
        reason.chars().take(WAIT_REASON_MAX_CHARS).collect()
    } else {
        reason
    }
}

/// The names the server's 409 refusal carries: its `open_shifts`, else what
/// its sentence lists after "before the Z:".
fn names_from_refusal(body: &Value) -> String {
    if let Some(open_shifts) = body
        .get("open_shifts")
        .and_then(Value::as_array)
        .filter(|shifts| !shifts.is_empty())
    {
        return open_shift_names(open_shifts);
    }
    body.get("error")
        .and_then(Value::as_str)
        .and_then(|sentence| sentence.split_once("before the Z:"))
        .map(|(_, names)| names.trim().to_string())
        .unwrap_or_default()
}

/// The queued Z's reason from the server's 409 body: the code, then the
/// names of the open phone shifts.
pub(crate) fn wait_reason_from_body(body: &str) -> String {
    let names = serde_json::from_str::<Value>(body)
        .ok()
        .map(|body| names_from_refusal(&body))
        .unwrap_or_default();
    bounded_wait_reason(&names)
}

/// The same from `api::fetch_from_admin`'s error text, which carries the
/// answer's body after `(HTTP 409): `.
pub(crate) fn wait_reason_from_error_message(message: &str) -> String {
    let names = message
        .split_once("(HTTP 409):")
        .and_then(|(_, body)| serde_json::from_str::<Value>(body.trim()).ok())
        .map(|body| names_from_refusal(&body))
        .unwrap_or_default();
    bounded_wait_reason(&names)
}

fn money_pair(target: &mut serde_json::Map<String, Value>, key: &str, amount: Option<f64>) {
    target.insert(key.to_string(), amount.map_or(Value::Null, Value::from));
    target.insert(
        format!("{key}_cents"),
        amount.map_or(Value::Null, |amount| {
            Value::from(Cents::round_half_even(amount).as_i64())
        }),
    );
}

fn number(shift: &Value, key: &str) -> Option<f64> {
    match shift.get(key)? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

fn optional_text(shift: &Value, key: &str) -> Value {
    text(shift, key).map_or(Value::Null, |value| Value::String(value.to_string()))
}

/// The stored Z's staff section for the phones (`phoneShifts`): each phone
/// shift that ended OR was received inside the window `[period_start,
/// cutoff]` (re-review 15/10/2026: a till that closed today and is received
/// tomorrow shows in both Zs, today "to receive", tomorrow "handed over"),
/// with its orders, sales, cash, card, count and handover state. A value the
/// server did not send stays null, never 0.
pub(crate) fn phone_shifts_for_z_window(
    closed_shifts: &[Value],
    period_start: &str,
    cutoff: &str,
) -> Vec<Value> {
    let start = parse_instant(Some(period_start));
    let end = parse_instant(Some(cutoff));
    closed_shifts
        .iter()
        .filter(|shift| {
            let inside = |moment: Option<DateTime<Utc>>| {
                moment.is_some_and(|moment| {
                    start.map_or(true, |start| moment >= start)
                        && end.map_or(true, |end| moment <= end)
                })
            };
            inside(parse_instant(text(shift, "check_out_time")))
                || inside(parse_instant(text(shift, "received_at")))
        })
        .map(|shift| {
            let mut entry = serde_json::Map::new();
            for (target, source) in [
                ("staffShiftId", "id"),
                ("staffId", "staff_id"),
                ("staffName", "staff_name"),
                ("role", "role_type"),
                ("terminalId", "terminal_id"),
                ("terminalName", "terminal_name"),
                ("checkIn", "check_in_time"),
                ("checkOut", "check_out_time"),
                ("status", "status"),
                ("currency", "currency"),
                ("handover", "handover"),
                ("closedBy", "closed_by"),
                ("receivedAt", "received_at"),
            ] {
                entry.insert(target.to_string(), optional_text(shift, source));
            }
            entry.insert(
                "terminalActive".to_string(),
                shift
                    .get("terminal_active")
                    .and_then(Value::as_bool)
                    .map_or(Value::Null, Value::Bool),
            );
            entry.insert(
                "ordersCount".to_string(),
                number(shift, "total_orders_count")
                    .map_or(Value::Null, |count| Value::from(count.round() as i64)),
            );
            for (target, source) in [
                ("salesTotal", "total_sales_amount"),
                ("cashSales", "total_cash_sales"),
                ("cardSales", "total_card_sales"),
                ("openingCash", "opening_cash_amount"),
                ("countedCash", "closing_cash_amount"),
                ("expectedCash", "expected_cash_amount"),
                ("cashVariance", "cash_variance"),
            ] {
                money_pair(&mut entry, target, number(shift, source));
            }
            Value::Object(entry)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_shift(id: &str, name: &str, check_in: &str) -> Value {
        json!({
            "id": id,
            "staff_id": format!("staff-{id}"),
            "staff_name": name,
            "role_type": "waiter",
            "terminal_id": "phone-1",
            "terminal_name": "Phone 1",
            "terminal_active": true,
            "check_in_time": check_in,
            "currency": "EUR",
            "opening_cash_amount": 0,
        })
    }

    fn closed_shift(id: &str, check_out: &str) -> Value {
        let mut shift = open_shift(id, "Nikos", "2026-10-14T08:00:00+00:00");
        let object = shift.as_object_mut().unwrap();
        for (key, value) in [
            ("status", json!("closed")),
            ("check_out_time", json!(check_out)),
            ("closing_cash_amount", json!(120.5)),
            ("expected_cash_amount", json!("120.50")),
            ("cash_variance", json!(0)),
            ("total_orders_count", json!(14)),
            ("total_sales_amount", json!(310.1)),
            ("total_cash_sales", json!(120.5)),
            ("total_card_sales", json!(189.6)),
            ("handover", json!("pending")),
            ("closed_by", json!("phone")),
            ("received_at", Value::Null),
            ("receivable", json!(true)),
        ] {
            object.insert(key.to_string(), value);
        }
        shift
    }

    fn ready_body(open: Vec<Value>, closed: Vec<Value>) -> Value {
        json!({
            "success": true,
            "main_terminal_id": "main-1",
            "open_shifts": open,
            "closed_shifts": closed,
            "pending_returns": [],
            "terminals": [],
        })
    }

    #[test]
    fn a_readiness_answer_is_read_or_unavailable_never_an_empty_list() {
        let open = open_shift("s1", "Maria", "2026-10-14T08:00:00Z");
        match classify_readiness_response(Ok(ready_body(vec![open.clone()], vec![]))) {
            UnitReadinessOutcome::Ready(readiness) => {
                assert_eq!(readiness.open_shifts, vec![open]);
                assert!(readiness.closed_shifts.is_empty());
            }
            other => panic!("expected ready, got {other:?}"),
        }

        for body in [
            json!({ "success": true }),
            json!({ "success": false, "open_shifts": [], "closed_shifts": [] }),
            json!({ "success": true, "open_shifts": "none", "closed_shifts": [] }),
            json!({ "success": true, "open_shifts": [{ "staff_name": "no id" }], "closed_shifts": [] }),
        ] {
            assert!(
                matches!(
                    classify_readiness_response(Ok(body.clone())),
                    UnitReadinessOutcome::Unavailable(_)
                ),
                "{body}"
            );
        }

        for (status, body) in [
            (
                503,
                r#"{"success":false,"code":"UNIT_READINESS_UNAVAILABLE","error":"Phone shifts unavailable"}"#,
            ),
            (500, "upstream exploded"),
            (401, r#"{"success":false,"error":"Unauthorized"}"#),
            (
                400,
                r#"{"success":false,"code":"UNIT_READINESS_INVALID","error":"since must be an ISO timestamp"}"#,
            ),
            (
                403,
                r#"{"success":false,"error":"Terminal not authorized"}"#,
            ),
        ] {
            assert!(
                matches!(
                    classify_readiness_response(Err(AdminFetchError::from_http_response_for_test(
                        status, body
                    ))),
                    UnitReadinessOutcome::Unavailable(_)
                ),
                "{status} {body}"
            );
        }
        assert!(matches!(
            classify_readiness_response(Err(AdminFetchError::transport(
                "Cannot reach admin dashboard"
            ))),
            UnitReadinessOutcome::Unavailable(_)
        ));
    }

    #[test]
    fn only_a_server_without_the_endpoint_or_a_till_that_is_not_a_main_skips_the_check() {
        assert!(matches!(
            classify_readiness_response(Err(AdminFetchError::from_http_response_for_test(
                404,
                "<!doctype html><html>Not found</html>"
            ))),
            UnitReadinessOutcome::Skipped("not_found")
        ));
        assert!(matches!(
            classify_readiness_response(Err(AdminFetchError::from_http_response_for_test(
                403,
                r#"{"success":false,"error":"Only a main terminal reads its phone shifts","code":"UNIT_READINESS_MAIN_ONLY"}"#
            ))),
            UnitReadinessOutcome::Skipped("not_main")
        ));
    }

    #[test]
    fn the_readiness_path_carries_the_window_start_encoded() {
        assert_eq!(readiness_path(None), "/api/pos/shifts/unit-readiness");
        assert_eq!(readiness_path(Some("  ")), "/api/pos/shifts/unit-readiness");
        assert_eq!(
            readiness_path(Some("2026-10-14T06:00:00+02:00")),
            "/api/pos/shifts/unit-readiness?since=2026-10-14T06%3A00%3A00%2B02%3A00"
        );
    }

    #[test]
    fn an_issued_z_is_held_only_by_phone_shifts_that_started_by_its_cutoff() {
        let before = open_shift("before", "Maria", "2026-10-14T20:00:00Z");
        let after = open_shift("after", "Eleni", "2026-10-15T07:00:00Z");
        let unknown = open_shift("unknown", "Kostas", "not a time");
        let all = vec![before.clone(), after.clone(), unknown.clone()];
        assert_eq!(
            open_shifts_holding_z(&all, None),
            all,
            "a live Z: every open shift"
        );
        assert_eq!(
            open_shifts_holding_z(&all, Some("2026-10-14T23:00:00+00:00")),
            vec![before, unknown],
            "an issued Z: the next day's shift does not hold it"
        );
    }

    #[test]
    fn the_refusal_names_each_open_phone_shift() {
        let response = z_unit_shifts_open_response(&[
            open_shift("s1", "Maria", "2026-10-14T08:00:00Z"),
            json!({ "id": "s2", "terminal_id": "phone-2", "role_type": "driver" }),
        ]);
        assert_eq!(response["success"], false);
        assert_eq!(response["errorCode"], Z_REPORT_UNIT_SHIFTS_OPEN);
        assert_eq!(response["stage"], "unit_shifts");
        assert_eq!(
            response["error"],
            "Close the phone shifts before the Z: Maria (waiter, Phone 1), s2 (driver, phone-2)"
        );
        assert_eq!(response["openShifts"].as_array().unwrap().len(), 2);
        let unavailable =
            z_unit_shifts_unavailable_response("Cannot reach admin dashboard at https://x");
        assert_eq!(unavailable["errorCode"], Z_REPORT_UNIT_SHIFTS_UNAVAILABLE);
        assert!(!unavailable["error"].as_str().unwrap().contains("https://"));
    }

    #[test]
    fn a_409_refusal_is_recognized_by_its_code_and_keeps_the_servers_sentence() {
        let body = r#"{"success":false,"code":"Z_REPORT_UNIT_SHIFTS_OPEN","error":"Close the phone shifts before the Z: Maria (waiter, Phone 1)","open_shifts":[]}"#;
        assert!(response_reports_unit_shifts_open(409, body));
        assert!(!response_reports_unit_shifts_open(503, body));
        assert!(!response_reports_unit_shifts_open(
            409,
            r#"{"success":false,"code":"Z_REPORT_FINALIZED_BOUND","error":"finalized"}"#
        ));
        assert!(!response_reports_unit_shifts_open(409, "not json"));
        // The code and the names, never the English sentence.
        assert_eq!(
            wait_reason_from_body(body),
            "Z_REPORT_UNIT_SHIFTS_OPEN: Maria (waiter, Phone 1)"
        );
        let with_shifts = r#"{"success":false,"code":"Z_REPORT_UNIT_SHIFTS_OPEN","error":"Close the phone shifts before the Z: Maria (waiter, Phone 1)","open_shifts":[{"id":"s1","staff_name":"Maria","role_type":"waiter","terminal_id":"phone-1","terminal_name":"Phone 1"},{"id":"s2","terminal_id":"phone-2"}]}"#;
        assert_eq!(
            wait_reason_from_body(with_shifts),
            "Z_REPORT_UNIT_SHIFTS_OPEN: Maria (Phone 1), s2 (phone-2)"
        );
        assert_eq!(
            wait_reason_from_body(r#"{"success":false,"code":"Z_REPORT_UNIT_SHIFTS_OPEN"}"#),
            "Z_REPORT_UNIT_SHIFTS_OPEN"
        );

        for refusal in [body, with_shifts] {
            let message = AdminFetchError::from_http_response_for_test(409, refusal).to_string();
            assert!(
                error_message_reports_unit_shifts_open(&message),
                "{message}"
            );
            assert_eq!(
                wait_reason_from_error_message(&message),
                wait_reason_from_body(refusal)
            );
        }
        assert!(!error_message_reports_unit_shifts_open(
            "Admin dashboard server error (HTTP 503)"
        ));

        let long = format!(
            r#"{{"success":false,"code":"Z_REPORT_UNIT_SHIFTS_OPEN","error":"{}"}}"#,
            "Maria (waiter, Phone 1), ".repeat(40)
        );
        assert!(wait_reason_from_body(&long).chars().count() <= WAIT_REASON_MAX_CHARS);
    }

    #[test]
    fn the_stored_z_lists_the_phone_shifts_that_closed_inside_its_window() {
        let shifts = vec![
            closed_shift("before-window", "2026-10-14T05:59:59Z"),
            closed_shift("inside", "2026-10-14T16:00:00+00:00"),
            closed_shift("after-cutoff", "2026-10-14T23:30:00Z"),
            json!({ "id": "no-checkout", "terminal_id": "phone-1", "check_out_time": null }),
        ];
        let listed =
            phone_shifts_for_z_window(&shifts, "2026-10-14T06:00:00Z", "2026-10-14T23:00:00Z");
        assert_eq!(listed.len(), 1);
        let entry = &listed[0];
        assert_eq!(entry["staffShiftId"], "inside");
        assert_eq!(entry["staffName"], "Nikos");
        assert_eq!(entry["role"], "waiter");
        assert_eq!(entry["terminalName"], "Phone 1");
        assert_eq!(entry["terminalActive"], true);
        assert_eq!(entry["ordersCount"], 14);
        assert_eq!(entry["salesTotal"], 310.1);
        assert_eq!(entry["salesTotal_cents"], 31010);
        assert_eq!(entry["cashSales_cents"], 12050);
        assert_eq!(entry["cardSales_cents"], 18960);
        assert_eq!(entry["countedCash"], 120.5);
        assert_eq!(
            entry["expectedCash_cents"], 12050,
            "a numeric string is read"
        );
        assert_eq!(entry["handover"], "pending");
        assert_eq!(entry["closedBy"], "phone");
        assert_eq!(entry["receivedAt"], Value::Null);

        // Re-review 15/10/2026: a till that closed in one window and was
        // received in the next shows in both Zs, as it read at each Z.
        let mut closed_today = closed_shift("received-next-day", "2026-10-14T20:00:00Z");
        let today = phone_shifts_for_z_window(
            std::slice::from_ref(&closed_today),
            "2026-10-14T06:00:00Z",
            "2026-10-14T23:00:00Z",
        );
        assert_eq!(today.len(), 1);
        assert_eq!(today[0]["handover"], "pending", "today: to receive");
        closed_today["handover"] = json!("received");
        closed_today["received_at"] = json!("2026-10-15T09:30:00Z");
        let tomorrow = phone_shifts_for_z_window(
            std::slice::from_ref(&closed_today),
            "2026-10-14T23:00:00Z",
            "2026-10-15T23:00:00Z",
        );
        assert_eq!(tomorrow.len(), 1, "received inside the next window");
        assert_eq!(tomorrow[0]["handover"], "received", "tomorrow: handed over");
        assert_eq!(tomorrow[0]["receivedAt"], "2026-10-15T09:30:00Z");
        // Neither closed nor received inside a window: not listed.
        assert!(phone_shifts_for_z_window(
            std::slice::from_ref(&closed_today),
            "2026-10-16T00:00:00Z",
            "2026-10-16T23:00:00Z",
        )
        .is_empty());

        // A till that never closed a Z (epoch start) still bounds by the cutoff;
        // a value the server did not send stays null.
        let sparse = vec![json!({
            "id": "sparse",
            "terminal_id": "phone-2",
            "check_out_time": "2026-10-14T10:00:00Z",
            "handover": "none",
        })];
        let listed =
            phone_shifts_for_z_window(&sparse, "1970-01-01T00:00:00Z", "2026-10-14T23:00:00Z");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["salesTotal"], Value::Null);
        assert_eq!(listed[0]["salesTotal_cents"], Value::Null);
        assert_eq!(listed[0]["ordersCount"], Value::Null);
        assert_eq!(listed[0]["terminalActive"], Value::Null);
    }
}
