//! Durable main-register receipt of satellite cash. Capture precedes remote close;
//! the server claim and local drawer credit are independently idempotent.
//!
//! States: `pending` (captured, the server claim is retried), `applied` (the
//! proof credited the drawer once), `refused` (the server, or its proof,
//! answered for good that this claim cannot be made: retrying cannot change
//! it) and `released` (a manager removed a refused claim as a close blocker;
//! no drawer was credited). Fix review 06/10/2026: a refusal used to stay
//! `pending`, retried forever, and kept the main cashier's close and the Z
//! blocked, in English only.
use crate::{db::DbState, money::Cents};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Handover {
    id: String,
    source: String,
    branch: String,
    terminal: String,
    cashier: String,
    drawer: String,
    currency: String,
    opening_cents: i64,
    counted_cents: i64,
    closed_by: Option<String>,
    applied: bool,
    /// `pending`, `applied`, `refused` or `released`.
    #[serde(default)]
    state: String,
    #[serde(default)]
    refusal_code: Option<String>,
}

/// The refusal a main cashier's close meets while a captured handover is
/// still being claimed.
pub(crate) const HANDOVER_PENDING: &str = "SATELLITE_HANDOVER_PENDING";
/// The refusal a main cashier's close meets while a refused handover is not
/// released by a manager.
pub(crate) const HANDOVER_REFUSED: &str = "SATELLITE_HANDOVER_REFUSED";
/// The recovery log action of a manager's release.
pub(crate) const RELEASE_ACTION_ID: &str = "satellite_handover_released";
/// The audit entry of an open phone shift a manager closed from the Main
/// without its cash handover (coordinator review 14/10/2026).
pub(crate) const CLOSE_WITHOUT_HANDOVER_ACTION_ID: &str = "phone_shift_closed_without_handover";
/// The server's own limit on the reason of a close without handover.
const CLOSE_WITHOUT_HANDOVER_REASON_MAX_CHARS: usize = 500;

const TABLE_COLUMNS: &str = "id TEXT PRIMARY KEY,
        satellite_shift_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        cashier_shift_id TEXT NOT NULL,
        drawer_id TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
        opening_cents INTEGER NOT NULL CHECK(opening_cents >= 0),
        counted_cents INTEGER NOT NULL CHECK(counted_cents >= 0),
        closed_by TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','refused','released')),
        last_error TEXT,
        proof_json TEXT,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        refusal_code TEXT,
        refusal_status INTEGER,
        refused_at TEXT,
        released_at TEXT,
        released_by TEXT,
        release_audit_id TEXT";
const RECEIVER_INDEX: &str = "CREATE INDEX IF NOT EXISTS satellite_cash_handovers_receiver ON satellite_cash_handovers(cashier_shift_id,state);";
/// One live claim per phone shift. A claim a manager released stays as
/// history, and the Main may claim that shift again with a new identity
/// (founder rule 13/10/2026: the Main closes every phone shift that holds
/// cash, so a released claim must not leave the shift unclosable and the Z
/// held for good). The server refuses a second proof for one shift.
const LIVE_CLAIM_INDEX: &str = "CREATE UNIQUE INDEX IF NOT EXISTS satellite_cash_handovers_one_live_claim ON satellite_cash_handovers(satellite_shift_id) WHERE state <> 'released';";

pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS satellite_cash_handovers ({TABLE_COLUMNS}); {RECEIVER_INDEX}"
    ))
    .map_err(|e| format!("satellite handover schema: {e}"))?;
    upgrade_states(conn)?;
    upgrade_live_claim(conn)?;
    conn.execute_batch(LIVE_CLAIM_INDEX)
        .map_err(|e| format!("satellite handover live claim index: {e}"))
}

/// A table that made the phone shift itself unique (before 1.4.131) is
/// rebuilt once so a released claim can be followed by a new one, every row
/// kept exactly as it was.
fn upgrade_live_claim(conn: &Connection) -> Result<(), String> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'satellite_cash_handovers'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("inspect satellite handover schema: {e}"))?;
    if sql.is_none_or(|sql| !sql.contains("satellite_shift_id TEXT NOT NULL UNIQUE")) {
        return Ok(());
    }
    conn.execute_batch("SAVEPOINT satellite_handover_live_claim")
        .map_err(|e| format!("begin satellite handover live claim: {e}"))?;
    let columns = "id, satellite_shift_id, branch_id, terminal_id, cashier_shift_id, drawer_id,         currency, opening_cents, counted_cents, closed_by, state, last_error, proof_json, created_at,         applied_at, refusal_code, refusal_status, refused_at, released_at, released_by, release_audit_id";
    let rebuilt = conn.execute_batch(&format!(
        "CREATE TABLE satellite_cash_handovers_v3 ({TABLE_COLUMNS});
         INSERT INTO satellite_cash_handovers_v3 ({columns})
         SELECT {columns} FROM satellite_cash_handovers;
         DROP TABLE satellite_cash_handovers;
         ALTER TABLE satellite_cash_handovers_v3 RENAME TO satellite_cash_handovers;
         {RECEIVER_INDEX}
         {LIVE_CLAIM_INDEX}"
    ));
    match rebuilt {
        Ok(()) => conn
            .execute_batch("RELEASE satellite_handover_live_claim")
            .map_err(|e| format!("commit satellite handover live claim: {e}")),
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO satellite_handover_live_claim; RELEASE satellite_handover_live_claim",
            );
            Err(format!("upgrade satellite handover live claim: {error}"))
        }
    }
}

/// A table created before the refused/released states (schema v96) is
/// rebuilt once with them, every captured row kept exactly as it was.
fn upgrade_states(conn: &Connection) -> Result<(), String> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'satellite_cash_handovers'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("inspect satellite handover schema: {e}"))?;
    if sql.is_none_or(|sql| sql.contains("'refused'")) {
        return Ok(());
    }
    conn.execute_batch("SAVEPOINT satellite_handover_states")
        .map_err(|e| format!("begin satellite handover states: {e}"))?;
    let rebuilt = conn.execute_batch(&format!(
        "CREATE TABLE satellite_cash_handovers_v2 ({TABLE_COLUMNS});
         INSERT INTO satellite_cash_handovers_v2 (id, satellite_shift_id, branch_id, terminal_id,
             cashier_shift_id, drawer_id, currency, opening_cents, counted_cents, closed_by, state,
             last_error, proof_json, created_at, applied_at)
         SELECT id, satellite_shift_id, branch_id, terminal_id, cashier_shift_id, drawer_id,
             currency, opening_cents, counted_cents, closed_by, state, last_error, proof_json,
             created_at, applied_at
         FROM satellite_cash_handovers;
         DROP TABLE satellite_cash_handovers;
         ALTER TABLE satellite_cash_handovers_v2 RENAME TO satellite_cash_handovers;
         {RECEIVER_INDEX}"
    ));
    match rebuilt {
        Ok(()) => conn
            .execute_batch("RELEASE satellite_handover_states")
            .map_err(|e| format!("commit satellite handover states: {e}")),
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO satellite_handover_states; RELEASE satellite_handover_states",
            );
            Err(format!("upgrade satellite handover states: {error}"))
        }
    }
}

fn read(conn: &Connection, source: &str) -> Result<Option<Handover>, String> {
    conn.query_row("SELECT id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,closed_by,state,refusal_code FROM satellite_cash_handovers WHERE satellite_shift_id=?1 AND state<>'released'",[source],|row| {
        let state: String = row.get(10)?;
        Ok(Handover {
            id:row.get(0)?,source:row.get(1)?,branch:row.get(2)?,terminal:row.get(3)?,cashier:row.get(4)?,drawer:row.get(5)?,currency:row.get(6)?,opening_cents:row.get(7)?,counted_cents:row.get(8)?,closed_by:row.get(9)?,applied:state=="applied",
            state, refusal_code: row.get(11)?,
        })
    }).optional().map_err(|e|format!("read satellite handover: {e}"))
}

fn money(value: f64) -> Result<i64, String> {
    if !value.is_finite() || value < 0.0 || value > 90_000_000_000.0 {
        return Err("SATELLITE_HANDOVER_INVALID_AMOUNT".to_string());
    }
    Ok(Cents::round_half_even(value).as_i64())
}

fn capture(conn: &Connection, payload: &Value) -> Result<Handover, String> {
    let required = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("SATELLITE_HANDOVER_MISSING_{key}"))
    };
    let branch = required("branchId")?;
    let terminal = required("terminalId")?;
    let source = required("satelliteShiftId")?;
    let currency = required("currency")?;
    if uuid::Uuid::parse_str(&source).is_err()
        || currency.len() != 3
        || !currency.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err("SATELLITE_HANDOVER_INVALID_IDENTITY".to_string());
    }
    let opening_cents = money(
        payload
            .get("openingCash")
            .and_then(Value::as_f64)
            .ok_or("SATELLITE_HANDOVER_OPENING_REQUIRED")?,
    )?;
    let counted_cents = money(
        payload
            .get("countedCash")
            .and_then(Value::as_f64)
            .ok_or("SATELLITE_HANDOVER_COUNTED_REQUIRED")?,
    )?;
    let closed_by = payload
        .get("closedBy")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if closed_by
        .as_deref()
        .is_some_and(|v| uuid::Uuid::parse_str(v).is_err())
    {
        return Err("SATELLITE_HANDOVER_INVALID_CLOSER".to_string());
    }
    if let Some(original) = read(conn, &source)? {
        if original.branch != branch
            || original.terminal != terminal
            || original.currency != currency
            || original.opening_cents != opening_cents
            || original.counted_cents != counted_cents
            || original.closed_by != closed_by
        {
            return Err(
                "SATELLITE_HANDOVER_IDENTITY_MISMATCH: retry the original captured handover"
                    .to_string(),
            );
        }
        return Ok(original);
    }
    if crate::db::get_setting(conn, "terminal", "terminal_id").as_deref() != Some(terminal.as_str())
    {
        return Err("SATELLITE_HANDOVER_TERMINAL_MISMATCH".to_string());
    }
    // This settles cash already collected in an original shift. A later country
    // change must not prevent two matching original drawers from reconciling.
    if crate::db::get_setting(conn, "terminal", "branch_id").as_deref() != Some(branch.as_str()) {
        return Err("SATELLITE_HANDOVER_BRANCH_MISMATCH".to_string());
    }
    let (cashier,drawer)=conn.query_row("SELECT ss.id,cds.id FROM staff_shifts ss JOIN cash_drawer_sessions cds ON cds.staff_shift_id=ss.id WHERE ss.branch_id=?1 AND ss.terminal_id=?2 AND ss.status='active' AND ss.role_type IN ('cashier','manager') AND cds.closed_at IS NULL AND ss.currency=?3 AND cds.currency=?3 ORDER BY ss.check_in_time DESC LIMIT 1",params![branch,terminal,currency],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())?.ok_or("SATELLITE_HANDOVER_RECEIVER_UNAVAILABLE: an active cashier drawer in the original currency is required")?;
    let intent = Handover {
        id: uuid::Uuid::new_v4().to_string(),
        source,
        branch,
        terminal,
        cashier,
        drawer,
        currency,
        opening_cents,
        counted_cents,
        closed_by,
        applied: false,
        state: "pending".to_string(),
        refusal_code: None,
    };
    conn.execute("INSERT INTO satellite_cash_handovers(id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,closed_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![intent.id,intent.source,intent.branch,intent.terminal,intent.cashier,intent.drawer,intent.currency,intent.opening_cents,intent.counted_cents,intent.closed_by,chrono::Utc::now().to_rfc3339()]).map_err(|e|format!("capture satellite handover: {e}"))?;
    Ok(intent)
}

/// A cashier shift that receives satellite cash closes only once every
/// captured handover is applied, or refused and released by a manager. The
/// refusal names its code (`SATELLITE_HANDOVER_PENDING`, or
/// `SATELLITE_HANDOVER_REFUSED: <server code>`) for the shift screen to say in
/// till language.
pub(crate) fn ensure_receiver_can_close(conn: &Connection, shift: &str) -> Result<(), String> {
    ensure_schema(conn)?;
    let blocking: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT state, refusal_code FROM satellite_cash_handovers
             WHERE cashier_shift_id = ?1 AND state IN ('pending', 'refused')
             ORDER BY CASE state WHEN 'refused' THEN 0 ELSE 1 END, created_at
             LIMIT 1",
            [shift],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match blocking {
        Some((state, code)) if state == "refused" => Err(format!(
            "{HANDOVER_REFUSED}: {}: the server refused this satellite cash handover for good; a manager can release it without crediting this drawer",
            code.unwrap_or_else(|| "SATELLITE_HANDOVER_REFUSED_UNKNOWN".to_string())
        )),
        Some(_) => Err(format!(
            "{HANDOVER_PENDING}: reconnect to finish receiving satellite cash before closing this cashier shift"
        )),
        None => Ok(()),
    }
}

fn request(intent: &Handover) -> Value {
    json!({"shift_id":intent.source,"action":"close","handover_id":intent.id,"receiving_cashier_shift_id":intent.cashier,"currency":intent.currency,"counted_cash_cents":intent.counted_cents,"closed_by":intent.closed_by})
}

fn outcome(intent: &Handover, applied: bool, error: Option<&str>) -> Value {
    json!({"success":true,"applied":applied,"pending":!applied,"handoverId":intent.id,"cashierShiftId":intent.cashier,"drawerId":intent.drawer,"error":error})
}

/// A refused claim: final, never resent. `error` names the refusal for the
/// shift screen; no drawer was credited.
fn refused_outcome(intent: &Handover, code: &str) -> Value {
    json!({"success":false,"applied":false,"pending":false,"refused":true,
        "released":intent.state=="released","errorCode":HANDOVER_REFUSED,"refusalCode":code,
        "error":format!("{HANDOVER_REFUSED}: {code}"),"handoverId":intent.id,
        "cashierShiftId":intent.cashier,"drawerId":intent.drawer})
}

/// How one failed claim ends: retried, or refused for good.
enum ClaimFailure {
    Retry(String),
    Refused {
        code: String,
        status: Option<u16>,
        message: String,
    },
}

/// The server's own answer refused the claim and the same claim can never
/// succeed: a 4xx with the application's error envelope (not a platform
/// page), except authentication, timeouts and rate limits, which heal.
fn classify_http_failure(error: &crate::api::AdminFetchError) -> ClaimFailure {
    match error.status() {
        Some(status)
            if (400..500).contains(&status)
                && !matches!(status, 401 | 408 | 425 | 429)
                && error.has_app_error_body() =>
        {
            ClaimFailure::Refused {
                code: error
                    .code()
                    .filter(|code| {
                        code.bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                    })
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("SATELLITE_HANDOVER_REFUSED_HTTP_{status}")),
                status: Some(status),
                message: error.to_string(),
            }
        }
        _ => ClaimFailure::Retry(error.to_string()),
    }
}

/// A proof the server returned that cannot credit this captured claim, or a
/// receiving drawer that closed: the server's receipt is immutable, so a
/// retry would meet the same answer.
fn classify_proof_failure(error: String) -> ClaimFailure {
    // A proof without a usable expected or variance (a negative or missing
    // expected) is the server's immutable receipt too: final, so the claim
    // can be released instead of holding the cashier's close for good
    // (re-review 15/10/2026).
    for code in [
        "SATELLITE_HANDOVER_PROOF_MISMATCH",
        "SATELLITE_HANDOVER_VARIANCE_PROOF_MISMATCH",
        "SATELLITE_HANDOVER_EXPECTED_PROOF_MISSING",
        "SATELLITE_HANDOVER_VARIANCE_PROOF_MISSING",
        "SATELLITE_HANDOVER_RECEIVER_CHANGED",
    ] {
        if error.starts_with(code) {
            return ClaimFailure::Refused {
                code: code.to_string(),
                status: None,
                message: error,
            };
        }
    }
    ClaimFailure::Retry(error)
}

fn mark_refused(
    conn: &Connection,
    intent: &Handover,
    code: &str,
    status: Option<u16>,
    message: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE satellite_cash_handovers
            SET state = 'refused', refusal_code = ?1, refusal_status = ?2, refused_at = ?3,
                last_error = ?4
          WHERE id = ?5 AND state = 'pending'",
        params![
            code,
            status.map(i64::from),
            chrono::Utc::now().to_rfc3339(),
            message,
            intent.id
        ],
    )
    .map_err(|e| format!("record the satellite handover refusal: {e}"))?;
    Ok(())
}

fn applied_outcome(conn: &Connection, intent: &Handover) -> Result<Value, String> {
    let raw: String = conn
        .query_row(
            "SELECT proof_json FROM satellite_cash_handovers WHERE id=?1 AND state='applied'",
            [&intent.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("read applied handover proof: {error}"))?;
    let proof: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("read applied handover proof: {error}"))?;
    let mut result = outcome(intent, true, None);
    result["handover"] = proof;
    Ok(result)
}

fn apply_proof(conn: &Connection, intent: &Handover, response: &Value) -> Result<(), String> {
    let proof = response
        .get("handover")
        .ok_or("SATELLITE_HANDOVER_PROOF_MISSING")?;
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("SATELLITE_HANDOVER_NOT_CONFIRMED".to_string());
    }
    for (key, expected) in [
        ("handover_id", &intent.id),
        ("shift_id", &intent.source),
        ("branch_id", &intent.branch),
        ("receiving_cashier_shift_id", &intent.cashier),
        ("terminal_id", &intent.terminal),
        ("currency", &intent.currency),
    ] {
        if proof.get(key).and_then(Value::as_str) != Some(expected.as_str()) {
            return Err(format!("SATELLITE_HANDOVER_PROOF_MISMATCH_{key}"));
        }
    }
    for (key, expected) in [
        ("opening_cash_cents", intent.opening_cents),
        ("counted_cash_cents", intent.counted_cents),
    ] {
        if proof.get(key).and_then(Value::as_i64) != Some(expected) {
            return Err(format!("SATELLITE_HANDOVER_PROOF_MISMATCH_{key}"));
        }
    }
    let expected = proof
        .get("expected_cash_cents")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or("SATELLITE_HANDOVER_EXPECTED_PROOF_MISSING")?;
    let variance = proof
        .get("cash_variance_cents")
        .and_then(Value::as_i64)
        .ok_or("SATELLITE_HANDOVER_VARIANCE_PROOF_MISSING")?;
    if intent.counted_cents.checked_sub(expected) != Some(variance) {
        return Err("SATELLITE_HANDOVER_VARIANCE_PROOF_MISMATCH".to_string());
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let original = read(conn, &intent.source)?.ok_or("SATELLITE_HANDOVER_CAPTURE_MISSING")?;
        if original.applied {
            return Ok(());
        }
        let changed=conn.execute("UPDATE cash_drawer_sessions SET driver_cash_given=COALESCE(driver_cash_given,0)+?1, driver_cash_given_cents=COALESCE(driver_cash_given_cents,CAST(ROUND(COALESCE(driver_cash_given,0)*100) AS INTEGER))+?2, driver_cash_returned=COALESCE(driver_cash_returned,0)+?3, driver_cash_returned_cents=COALESCE(driver_cash_returned_cents,CAST(ROUND(COALESCE(driver_cash_returned,0)*100) AS INTEGER))+?4, updated_at=?5 WHERE id=?6 AND staff_shift_id=?7 AND currency=?8 AND closed_at IS NULL AND EXISTS(SELECT 1 FROM staff_shifts WHERE id=?7 AND status='active' AND currency=?8)",params![Cents::new(intent.opening_cents).to_f64_dp2(),intent.opening_cents,Cents::new(intent.counted_cents).to_f64_dp2(),intent.counted_cents,chrono::Utc::now().to_rfc3339(),intent.drawer,intent.cashier,intent.currency]).map_err(|e|format!("apply satellite handover: {e}"))?;
        if changed != 1 {
            return Err("SATELLITE_HANDOVER_RECEIVER_CHANGED".to_string());
        }
        conn.execute("UPDATE satellite_cash_handovers SET state='applied',proof_json=?1,applied_at=?2,last_error=NULL WHERE id=?3",params![proof.to_string(),chrono::Utc::now().to_rfc3339(),intent.id]).map_err(|e|e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

async fn send(
    db: &DbState,
    intent: &Handover,
    admin: &str,
    api_key: &str,
) -> Result<Value, String> {
    if intent.applied {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        return applied_outcome(&conn, intent);
    }
    if matches!(intent.state.as_str(), "refused" | "released") {
        return Ok(refused_outcome(
            intent,
            intent
                .refusal_code
                .as_deref()
                .unwrap_or("SATELLITE_HANDOVER_REFUSED_UNKNOWN"),
        ));
    }
    // Reconfiguration cannot replay another terminal's cash claim through its credentials.
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if crate::db::get_setting(&conn, "terminal", "terminal_id").as_deref()
            != Some(intent.terminal.as_str())
            || crate::db::get_setting(&conn, "terminal", "branch_id").as_deref()
                != Some(intent.branch.as_str())
        {
            return Ok(outcome(
                intent,
                false,
                Some("SATELLITE_HANDOVER_TERMINAL_MISMATCH"),
            ));
        }
    }
    let response = crate::api::fetch_from_admin_detailed(
        admin,
        api_key,
        "/api/pos/shifts/remote-checkout",
        "POST",
        Some(request(intent)),
    )
    .await;
    let result = match response {
        Ok(body) => {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            apply_proof(&conn, intent, &body).map_err(classify_proof_failure)
        }
        Err(error) => Err(classify_http_failure(&error)),
    };
    match result {
        Ok(()) => {
            let conn = db.conn.lock().map_err(|error| error.to_string())?;
            applied_outcome(&conn, intent)
        }
        Err(ClaimFailure::Refused {
            code,
            status,
            message,
        }) => {
            // Final: never retried, and the close says so until a manager
            // releases it (fix review 06/10/2026).
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            mark_refused(&conn, intent, &code, status, &message)?;
            tracing::warn!(
                handover_id = %intent.id,
                code = %code,
                "Satellite cash handover refused for good"
            );
            Ok(refused_outcome(intent, &code))
        }
        Err(ClaimFailure::Retry(error)) => {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE satellite_cash_handovers SET last_error=?1 WHERE id=?2 AND state='pending'",
                params![error, intent.id],
            )
            .map_err(|e| e.to_string())?;
            Ok(outcome(intent, false, Some(&error)))
        }
    }
}

pub(crate) async fn record(db: &DbState, payload: &Value) -> Result<Value, String> {
    let intent = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        capture(&conn, payload)?
    };
    if intent.applied {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        return applied_outcome(&conn, &intent);
    }
    if matches!(intent.state.as_str(), "refused" | "released") {
        // The same captured claim again: its final answer, never resent.
        return Ok(refused_outcome(
            &intent,
            intent
                .refusal_code
                .as_deref()
                .unwrap_or("SATELLITE_HANDOVER_REFUSED_UNKNOWN"),
        ));
    }
    let Some(admin) = crate::storage::get_credential("admin_dashboard_url") else {
        return Ok(outcome(
            &intent,
            false,
            Some("Network configuration unavailable"),
        ));
    };
    let Some(key) = crate::sync::load_zeroized_pos_api_key_optional() else {
        return Ok(outcome(
            &intent,
            false,
            Some("Terminal authentication unavailable"),
        ));
    };
    send(db, &intent, &admin, &key).await
}

pub(crate) async fn recover_pending(
    db: &DbState,
    admin: &str,
    api_key: &str,
) -> Result<(), String> {
    let intents = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        // Refused and released claims are final: only pending ones retry.
        let mut stmt=conn.prepare("SELECT satellite_shift_id FROM satellite_cash_handovers WHERE state='pending' ORDER BY created_at LIMIT 20").map_err(|e|e.to_string())?;
        let sources = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        sources
            .into_iter()
            .map(|source| {
                read(&conn, &source)?.ok_or("SATELLITE_HANDOVER_CAPTURE_MISSING".to_string())
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    for intent in intents {
        send(db, &intent, admin, api_key).await?;
    }
    Ok(())
}

/// The captured handovers that still hold this cashier shift's close: still
/// claimed (`pending`) or refused for good and not released (`refused`).
pub(crate) fn blocking_handovers(
    conn: &Connection,
    cashier_shift: &str,
) -> Result<Vec<Value>, String> {
    ensure_schema(conn)?;
    let mut statement = conn
        .prepare(
            "SELECT id, satellite_shift_id, currency, opening_cents, counted_cents, state,
                    refusal_code, refusal_status, refused_at, created_at
             FROM satellite_cash_handovers
             WHERE cashier_shift_id = ?1 AND state IN ('pending', 'refused')
             ORDER BY created_at",
        )
        .map_err(|e| format!("prepare blocking satellite handovers: {e}"))?;
    let rows = statement
        .query_map([cashier_shift], |row| {
            Ok(json!({
                "handoverId": row.get::<_, String>(0)?,
                "satelliteShiftId": row.get::<_, String>(1)?,
                "currency": row.get::<_, String>(2)?,
                "openingCents": row.get::<_, i64>(3)?,
                "countedCents": row.get::<_, i64>(4)?,
                "state": row.get::<_, String>(5)?,
                "refusalCode": row.get::<_, Option<String>>(6)?,
                "refusalStatus": row.get::<_, Option<i64>>(7)?,
                "refusedAt": row.get::<_, Option<String>>(8)?,
                "capturedAt": row.get::<_, String>(9)?,
            }))
        })
        .map_err(|e| format!("read blocking satellite handovers: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read a blocking satellite handover: {e}"))
}

fn required_text(input: &Value, key: &str, code: &str) -> Result<String, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| code.to_string())
}

/// One manager decision that releases a refused claim (inside the caller's
/// transaction): what was captured, who approved, how, why and the restore
/// point taken before it.
struct ClaimRelease<'a> {
    handover_id: &'a str,
    code: Option<String>,
    manager: &'a str,
    via: &'static str,
    note: Option<&'a str>,
    snapshot_id: &'a str,
    now: &'a str,
    audit_id: &'a str,
}

/// Move a refused claim to `released` and audit it, nothing credited: the
/// step the release panel and a close without handover share, so both leave
/// the same trail.
fn release_refused_claim(conn: &Connection, release: &ClaimRelease<'_>) -> Result<(), String> {
    let captured: Value = conn
        .query_row(
            "SELECT json_object('handoverId', id, 'satelliteShiftId', satellite_shift_id,
                 'branchId', branch_id, 'terminalId', terminal_id, 'cashierShiftId', cashier_shift_id,
                 'drawerId', drawer_id, 'currency', currency, 'openingCents', opening_cents,
                 'countedCents', counted_cents, 'closedBy', closed_by, 'refusalCode', refusal_code,
                 'refusalStatus', refusal_status, 'refusedAt', refused_at, 'lastError', last_error,
                 'capturedAt', created_at)
             FROM satellite_cash_handovers WHERE id = ?1",
            [release.handover_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("read the satellite handover to release: {e}"))
        .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))?;
    let cashier_shift = captured
        .get("cashierShiftId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let changed = conn
        .execute(
            "UPDATE satellite_cash_handovers
                SET state = 'released', released_at = ?1, released_by = ?2, release_audit_id = ?3
              WHERE id = ?4 AND state = 'refused'",
            params![
                release.now,
                release.manager,
                release.audit_id,
                release.handover_id
            ],
        )
        .map_err(|e| format!("release the satellite handover: {e}"))?;
    if changed != 1 {
        return Err("SATELLITE_HANDOVER_RELEASE_CONFLICT".to_string());
    }
    let evidence = json!({"version":1,"handover":captured,"drawerCredited":false,
        "approvedBy":release.manager,"via":release.via,"note":release.note,
        "snapshotId":release.snapshot_id,"releasedAt":release.now});
    conn.execute(
        "INSERT INTO recovery_action_log (id, action_id, issue_code, entity_type, entity_id,
             shift_id, snapshot_point_id, success, message, actor_staff_id, payload_json, created_at)
         VALUES (?1, ?2, ?3, 'satellite_cash_handover', ?4, ?5, ?6, 1,
             'Refused satellite cash handover released as a close blocker; no drawer was credited',
             ?7, ?8, ?9)",
        params![
            release.audit_id,
            RELEASE_ACTION_ID,
            release
                .code
                .clone()
                .unwrap_or_else(|| HANDOVER_REFUSED.to_string()),
            release.handover_id,
            cashier_shift,
            release.snapshot_id,
            release.manager,
            evidence.to_string(),
            release.now
        ],
    )
    .map_err(|e| format!("audit the satellite handover release: {e}"))?;
    Ok(())
}

/// A manager releases a refused satellite handover so the receiving
/// cashier's close (and the day's Z) can go on. Nothing is credited to any
/// drawer and the captured claim is kept as it was: only its state moves
/// `refused` → `released`, with an audit entry naming the manager, the
/// server's refusal and a pre-action restore point. A manager's own PIN with
/// the order-cancel right approves it, as for the other manager decisions a
/// cashier on shift cannot make alone (the session PIN never does).
pub(crate) fn release(
    db: &DbState,
    auth_state: &crate::auth::AuthState,
    input: &Value,
) -> Result<Value, crate::auth::GuardedCommandError> {
    let handover_id = required_text(input, "handoverId", "SATELLITE_HANDOVER_ID_REQUIRED")?;
    let cashier_shift =
        required_text(input, "cashierShiftId", "SATELLITE_HANDOVER_SHIFT_REQUIRED")?;
    let pin = required_text(
        input,
        "managerPin",
        "SATELLITE_HANDOVER_MANAGER_PIN_REQUIRED",
    )?;
    let note = input
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|note| !note.is_empty())
        .map(|note| note.chars().take(200).collect::<String>());
    let check = |conn: &Connection| -> Result<Option<(String, Option<String>)>, String> {
        ensure_schema(conn)?;
        let row: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT cashier_shift_id, state, refusal_code FROM satellite_cash_handovers WHERE id = ?1",
                [&handover_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("read the satellite handover to release: {e}"))?;
        let (shift, state, code) = row.ok_or("SATELLITE_HANDOVER_NOT_FOUND")?;
        if shift != cashier_shift {
            return Err("SATELLITE_HANDOVER_SHIFT_MISMATCH".to_string());
        }
        match state.as_str() {
            "released" => Ok(None),
            "refused" => Ok(Some((state, code))),
            _ => Err("SATELLITE_HANDOVER_NOT_REFUSED: only a handover the server refused for good can be released".to_string()),
        }
    };
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        if check(&conn)?.is_none() {
            return Ok(
                json!({"success":true,"released":true,"alreadyReleased":true,
                "handoverId":handover_id,"cashierShiftId":cashier_shift}),
            );
        }
    }
    crate::auth::confirm_privileged_action(
        Some(json!({"pin": pin, "scope": "cash_drawer_control", "approval": "void_orders"})),
        db,
        auth_state,
    )?;
    let approver = crate::auth::authorize_money_action(
        crate::auth::MoneyApproval::VoidOrders,
        db,
        auth_state,
    )?;
    let manager = approver
        .manager_staff_id
        .ok_or("SATELLITE_HANDOVER_MANAGER_APPROVAL_REQUIRED")?;
    let snapshot = crate::recovery::create_pre_recovery_action_snapshot(db)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let audit_id = uuid::Uuid::new_v4().to_string();
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin satellite handover release: {e}"))?;
    let released = (|| -> Result<Value, String> {
        let Some((_, code)) = check(&conn)? else {
            return Ok(
                json!({"success":true,"released":true,"alreadyReleased":true,
                "handoverId":handover_id,"cashierShiftId":cashier_shift}),
            );
        };
        release_refused_claim(
            &conn,
            &ClaimRelease {
                handover_id: &handover_id,
                code,
                manager: &manager,
                via: approver.via,
                note: note.as_deref(),
                snapshot_id: &snapshot.id,
                now: &now,
                audit_id: &audit_id,
            },
        )?;
        Ok(
            json!({"success":true,"released":true,"alreadyReleased":false,
            "handoverId":handover_id,"cashierShiftId":cashier_shift,"auditId":audit_id,
            "snapshotId":snapshot.id}),
        )
    })();
    match released {
        Ok(answer) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit satellite handover release: {e}"))?;
            Ok(answer)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error.into())
        }
    }
}

/// The phone shifts whose only local claim a manager released (coordinator
/// review 14/10/2026): a till the server still calls receivable no longer
/// holds the cashier's close once its claim was released. A new claim of that
/// shift (pending, refused or applied) makes it count again.
pub(crate) fn released_sources(conn: &Connection) -> Result<Vec<String>, String> {
    ensure_schema(conn)?;
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT released.satellite_shift_id
             FROM satellite_cash_handovers released
             WHERE released.state = 'released'
               AND NOT EXISTS (
                   SELECT 1 FROM satellite_cash_handovers live
                   WHERE live.satellite_shift_id = released.satellite_shift_id
                     AND live.state <> 'released'
               )
             ORDER BY released.satellite_shift_id",
        )
        .map_err(|e| format!("prepare released satellite handovers: {e}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("read released satellite handovers: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read a released satellite handover: {e}"))
}

/// What the operator reads when the server refuses a close without handover:
/// its own code for the refusals the screen explains, `PHONE_SHIFT_CLOSE_OFFLINE`
/// without a connection, `PHONE_SHIFT_CLOSE_FAILED` otherwise.
fn close_without_handover_failure(error: &crate::api::AdminFetchError) -> String {
    if error.is_transport_failure() {
        return "PHONE_SHIFT_CLOSE_OFFLINE".to_string();
    }
    match error.code() {
        // `REMOTE_HANDOVER_APPROVAL_REQUIRED`: the server checks the
        // approver's own `pos.orders.cancel` right too (re-review 15/10/2026).
        Some(
            code @ ("REMOTE_CHECKOUT_MAIN_ONLY"
            | "REMOTE_CHECKOUT_NOT_UNIT_CHILD"
            | "REMOTE_HANDOVER_RECEIVER_MISMATCH"
            | "REMOTE_HANDOVER_APPROVAL_REQUIRED"),
        ) => code.to_string(),
        _ => {
            tracing::warn!(error = %error, "Close without handover refused by the server");
            "PHONE_SHIFT_CLOSE_FAILED".to_string()
        }
    }
}

/// A manager closes an open phone shift from the Main WITHOUT its cash
/// handover (coordinator review 14/10/2026), when the remote checkout can
/// never take it (refused for good) or the shift has no cash role. The server
/// closes a cash-free shift as `closed` with nothing to hand over, and any
/// other as `abandoned` with its cash untouched ("not counted"): a manager
/// settles that money. Nothing is credited to any drawer here and no claim is
/// captured. A manager's own PIN with the order-cancel right approves it, as
/// for the release of a refused claim; the audit entry names the manager, the
/// reason and the server's answer.
async fn close_without_handover_at(
    db: &DbState,
    auth_state: &crate::auth::AuthState,
    input: &Value,
    admin_url: Option<(&str, &str)>,
) -> Result<Value, crate::auth::GuardedCommandError> {
    let shift_id = required_text(
        input,
        "satelliteShiftId",
        "SATELLITE_HANDOVER_SOURCE_REQUIRED",
    )?;
    let reason = input
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| {
            !reason.is_empty() && reason.chars().count() <= CLOSE_WITHOUT_HANDOVER_REASON_MAX_CHARS
        })
        .map(ToString::to_string)
        .ok_or("PHONE_SHIFT_CLOSE_REASON_REQUIRED")?;
    let pin = required_text(
        input,
        "managerPin",
        "SATELLITE_HANDOVER_MANAGER_PIN_REQUIRED",
    )?;
    crate::auth::confirm_privileged_action(
        Some(json!({"pin": pin, "scope": "cash_drawer_control", "approval": "void_orders"})),
        db,
        auth_state,
    )?;
    let approver = crate::auth::authorize_money_action(
        crate::auth::MoneyApproval::VoidOrders,
        db,
        auth_state,
    )?;
    let manager = approver
        .manager_staff_id
        .ok_or("SATELLITE_HANDOVER_MANAGER_APPROVAL_REQUIRED")?;

    let body = json!({
        "shift_id": shift_id,
        "action": "close_without_handover",
        "approved_by": manager,
        "reason": reason,
    });
    let answer = match admin_url {
        Some((admin_url, api_key)) => {
            crate::api::fetch_from_admin_detailed(
                admin_url,
                api_key,
                "/api/pos/shifts/remote-checkout",
                "POST",
                Some(body),
            )
            .await
        }
        None => {
            let (admin_url, api_key) = crate::resolve_admin_endpoint(Some(db))
                .await
                .map_err(|_| "PHONE_SHIFT_CLOSE_FAILED".to_string())?;
            crate::api::fetch_from_admin_detailed(
                &admin_url,
                &api_key,
                "/api/pos/shifts/remote-checkout",
                "POST",
                Some(body),
            )
            .await
        }
    }
    .map_err(|error| close_without_handover_failure(&error))?;

    let shift = answer.get("shift").cloned().unwrap_or(Value::Null);
    let status = shift.get("status").and_then(Value::as_str).unwrap_or("");
    if answer.get("success").and_then(Value::as_bool) != Some(true)
        || shift.get("id").and_then(Value::as_str) != Some(shift_id.as_str())
        || !matches!(status, "closed" | "abandoned")
    {
        tracing::warn!(answer = %answer, "Close without handover: unexpected server answer");
        return Err("PHONE_SHIFT_CLOSE_FAILED".into());
    }
    let already_closed = answer
        .get("already_closed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let shift_view = json!({
        "id": shift_id,
        "status": status,
        "check_out_time": shift.get("check_out_time").cloned().unwrap_or(Value::Null),
    });

    // The shift is closed on the server now. A claim of it the server
    // refused for good would still hold the receiving cashier's close: it is
    // released in the same step, under this approval and with the release
    // panel's own trail (coordinator review 14/10/2026). A pending claim may
    // still prove and stays as it is.
    let refused_claim: Option<(String, Option<String>)> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        ensure_schema(&conn)?;
        conn.query_row(
            "SELECT id, refusal_code FROM satellite_cash_handovers
             WHERE satellite_shift_id = ?1 AND state = 'refused'",
            [&shift_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("read the refused claim of the closed phone shift: {e}"))?
    };
    let snapshot = if refused_claim.is_some() {
        Some(crate::recovery::create_pre_recovery_action_snapshot(db)?)
    } else {
        None
    };

    let now = chrono::Utc::now().to_rfc3339();
    let audit_id = uuid::Uuid::new_v4().to_string();
    let release_audit_id = refused_claim
        .as_ref()
        .map(|_| uuid::Uuid::new_v4().to_string());
    let evidence = json!({
        "version": 1,
        "satelliteShiftId": shift_id,
        "reason": reason,
        "approvedBy": manager,
        "via": approver.via,
        "drawerCredited": false,
        "alreadyClosed": already_closed,
        "shift": shift_view,
        "releasedClaim": refused_claim.as_ref().map(|(id, _)| id.clone()),
        "releaseAuditId": release_audit_id,
        "closedAt": now,
    });
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin close without handover audit: {e}"))?;
    let written = (|| -> Result<(), String> {
        if let (Some((handover_id, code)), Some(snapshot), Some(release_audit_id)) =
            (&refused_claim, &snapshot, &release_audit_id)
        {
            release_refused_claim(
                &conn,
                &ClaimRelease {
                    handover_id,
                    code: code.clone(),
                    manager: &manager,
                    via: approver.via,
                    note: Some(&reason),
                    snapshot_id: &snapshot.id,
                    now: &now,
                    audit_id: release_audit_id,
                },
            )?;
        }
        conn.execute(
            "INSERT INTO recovery_action_log (id, action_id, issue_code, entity_type, entity_id,
                 shift_id, snapshot_point_id, success, message, actor_staff_id, payload_json, created_at)
             VALUES (?1, ?2, 'PHONE_SHIFT_CLOSE_WITHOUT_HANDOVER', 'staff_shift', ?3, ?3, ?4, 1,
                 'Phone shift closed from the main register without its cash handover; no drawer was credited',
                 ?5, ?6, ?7)",
            params![
                audit_id,
                CLOSE_WITHOUT_HANDOVER_ACTION_ID,
                shift_id,
                snapshot.as_ref().map(|snapshot| snapshot.id.clone()),
                manager,
                evidence.to_string(),
                now
            ],
        )
        .map_err(|e| format!("audit the close without handover: {e}"))?;
        Ok(())
    })();
    match written {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("commit close without handover audit: {e}"))?,
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
    }
    drop(conn);
    tracing::info!(
        shift_status = %status,
        already_closed,
        "Phone shift closed from the main register without its cash handover"
    );
    Ok(json!({
        "success": true,
        "closedWithoutHandover": true,
        "alreadyClosed": already_closed,
        "shift": shift_view,
        "auditId": audit_id,
        "releasedHandoverId": refused_claim.map(|(id, _)| id),
    }))
}

/// The shift screen's satellite handover recovery: `list` the handovers that
/// hold a cashier's close, `release` a refused one (manager),
/// `released_sources` (the phone shifts whose claim was released) and
/// `close_without_handover` (manager, an open phone shift the remote checkout
/// cannot take).
#[tauri::command]
pub async fn shift_satellite_handover_recovery(
    arg0: Option<Value>,
    db: tauri::State<'_, DbState>,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
) -> Result<Value, crate::auth::GuardedCommandError> {
    let input = arg0.ok_or("Missing satellite handover recovery payload")?;
    match input.get("action").and_then(Value::as_str) {
        Some("list") => {
            let shift = required_text(
                &input,
                "cashierShiftId",
                "SATELLITE_HANDOVER_SHIFT_REQUIRED",
            )?;
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            Ok(json!({"success": true, "handovers": blocking_handovers(&conn, &shift)?}))
        }
        Some("released_sources") => {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            Ok(json!({"success": true, "satelliteShiftIds": released_sources(&conn)?}))
        }
        Some("release") => {
            let _lease = crate::repairs::acquire_terminal_binding_lease()?;
            release(&db, &auth_state, &input)
        }
        Some("close_without_handover") => {
            let _lease = crate::repairs::acquire_terminal_binding_lease()?;
            close_without_handover_at(&db, &auth_state, &input, None).await
        }
        _ => Err("SATELLITE_HANDOVER_RECOVERY_ACTION_INVALID".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SOURCE: &str = "11111111-1111-4111-8111-111111111111";
    const CASHIER: &str = "22222222-2222-4222-8222-222222222222";
    fn seed(conn: &Connection) {
        crate::db::run_migrations_for_test(conn);
        seed_rows(conn);
    }
    fn seed_rows(conn: &Connection) {
        for (category, key, value) in [
            ("terminal", "branch_id", "b1"),
            ("terminal", "terminal_id", "main"),
            ("restaurant", "store_currency_branch_id", "b1"),
            ("restaurant", "store_currency_available", "true"),
            ("restaurant", "store_currency_source", "branch_country"),
            ("restaurant", "currency", "CHF"),
        ] {
            crate::db::set_setting(conn, category, key, value).unwrap();
        }
        conn.execute("INSERT INTO staff_shifts(id,staff_id,branch_id,terminal_id,role_type,status,check_in_time,created_at,updated_at,currency) VALUES(?1,'staff','b1','main','cashier','active','now','now','now','CHF')",[CASHIER]).unwrap();
        conn.execute("INSERT INTO cash_drawer_sessions(id,staff_shift_id,cashier_id,branch_id,terminal_id,opened_at,created_at,updated_at,currency) VALUES('drawer',?1,'staff','b1','main','now','now','now','CHF')",[CASHIER]).unwrap();
    }
    fn payload() -> Value {
        json!({"satelliteShiftId":SOURCE,"branchId":"b1","terminalId":"main","currency":"CHF","openingCash":20.0,"countedCash":55.25})
    }
    fn proof(intent: &Handover) -> Value {
        json!({"success":true,"handover":{"handover_id":intent.id,"shift_id":intent.source,"branch_id":intent.branch,"receiving_cashier_shift_id":intent.cashier,"terminal_id":intent.terminal,"currency":intent.currency,"opening_cash_cents":intent.opening_cents,"counted_cash_cents":intent.counted_cents,"expected_cash_cents":5000,"cash_variance_cents":intent.counted_cents-5000}})
    }
    fn totals(conn: &Connection) -> (i64, i64) {
        conn.query_row("SELECT COALESCE(driver_cash_given_cents,0),COALESCE(driver_cash_returned_cents,0) FROM cash_drawer_sessions WHERE id='drawer'",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap()
    }

    #[test]
    fn satellite_handover_durable_crash_replay_credits_once_in_original_currency() {
        let path = std::env::temp_dir().join(format!(
            "satellite-handover-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&path).unwrap();
        seed(&conn);
        let intent = capture(&conn, &payload()).unwrap();
        assert!(ensure_receiver_can_close(&conn, CASHIER)
            .unwrap_err()
            .contains("SATELLITE_HANDOVER_PENDING"));
        assert_eq!(totals(&conn), (0, 0));
        let server_confirmation = proof(&intent); // server has closed; process dies before credit
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        crate::db::set_setting(&conn, "restaurant", "currency", "USD").unwrap();
        let retained = capture(&conn, &payload()).unwrap();
        assert_eq!(retained.id, intent.id);
        assert_eq!(request(&retained)["currency"], "CHF");
        apply_proof(&conn, &retained, &server_confirmation).unwrap();
        apply_proof(&conn, &retained, &server_confirmation).unwrap();
        assert_eq!(totals(&conn), (2000, 5525));
        assert!(read(&conn, SOURCE).unwrap().unwrap().applied);
        ensure_receiver_can_close(&conn, CASHIER).unwrap();
        let result = applied_outcome(&conn, &retained).unwrap();
        assert_eq!(result["handover"], server_confirmation["handover"]);
        assert_eq!(result["handover"]["expected_cash_cents"], 5000);
        assert_eq!(result["handover"]["cash_variance_cents"], 525);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn satellite_handover_conflicting_count_and_unproven_or_cross_currency_credit_refuse() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let intent = capture(&conn, &payload()).unwrap();
        let mut changed = payload();
        changed["countedCash"] = json!(56);
        assert!(capture(&conn, &changed)
            .unwrap_err()
            .contains("IDENTITY_MISMATCH"));
        assert!(apply_proof(
            &conn,
            &intent,
            &json!({"success":true,"already_closed":true})
        )
        .is_err());
        let mut wrong = proof(&intent);
        wrong["handover"]["currency"] = json!("USD");
        assert!(apply_proof(&conn, &intent, &wrong).is_err());
        wrong = proof(&intent);
        wrong["handover"]["receiving_cashier_shift_id"] = json!("different");
        assert!(apply_proof(&conn, &intent, &wrong).is_err());
        assert_eq!(totals(&conn), (0, 0));
        assert!(!read(&conn, SOURCE).unwrap().unwrap().applied);
    }

    #[test]
    fn satellite_handover_journal_failure_rolls_back_entire_drawer_credit() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let intent = capture(&conn, &payload()).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_handover_apply BEFORE UPDATE OF state ON satellite_cash_handovers WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'injected durability failure'); END;").unwrap();
        assert!(apply_proof(&conn, &intent, &proof(&intent)).is_err());
        assert_eq!(totals(&conn), (0, 0));
        assert!(!read(&conn, SOURCE).unwrap().unwrap().applied);
        conn.execute_batch("DROP TRIGGER fail_handover_apply;")
            .unwrap();
        apply_proof(&conn, &intent, &proof(&intent)).unwrap();
        assert_eq!(totals(&conn), (2000, 5525));
    }

    #[test]
    fn satellite_handover_capture_settles_matching_original_currency_after_country_change() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        crate::db::set_setting(&conn, "restaurant", "currency", "USD").unwrap();
        let mut updated = payload();
        updated["currency"] = json!("USD");
        assert!(capture(&conn, &updated)
            .unwrap_err()
            .contains("RECEIVER_UNAVAILABLE"));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM satellite_cash_handovers", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
        let original = capture(&conn, &payload()).unwrap();
        assert_eq!(original.currency, "CHF");
        apply_proof(&conn, &original, &proof(&original)).unwrap();
        assert_eq!(totals(&conn), (2000, 5525));
    }

    fn state(conn: &Connection) -> (String, Option<String>) {
        conn.query_row(
            "SELECT state, refusal_code FROM satellite_cash_handovers WHERE satellite_shift_id = ?1",
            [SOURCE],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    /// Fix review 06/10/2026: the satellite closed its own shift first, the
    /// server answered 409 REMOTE_HANDOVER_PROOF_UNAVAILABLE, the row stayed
    /// pending, was retried forever and held the main cashier's close and the
    /// Z, in English only. A 4xx refusal of the server's own is final now.
    #[test]
    fn satellite_handover_classifies_only_lasting_server_refusals_as_final() {
        let refusal = |status: u16, body: &str| {
            classify_http_failure(&crate::api::AdminFetchError::from_http_response_for_test(
                status, body,
            ))
        };
        let coded = |code: &str| format!(r#"{{"success":false,"error":"{code}","code":"{code}"}}"#);
        for (status, code) in [
            (409, "REMOTE_HANDOVER_PROOF_UNAVAILABLE"),
            (409, "REMOTE_HANDOVER_GIFT_CLOSE_REQUIRED"),
            (409, "REMOTE_HANDOVER_MOVEMENTS_UNAVAILABLE"),
            (409, "REMOTE_HANDOVER_CURRENCY_MISMATCH"),
            (403, "REMOTE_CHECKOUT_MAIN_ONLY"),
        ] {
            match refusal(status, &coded(code)) {
                ClaimFailure::Refused {
                    code: refused,
                    status: Some(answered),
                    ..
                } => assert_eq!((refused.as_str(), answered), (code, status)),
                _ => panic!("{status} {code} is final"),
            }
        }
        match refusal(404, r#"{"success":false,"error":"Shift not found"}"#) {
            ClaimFailure::Refused { code, .. } => {
                assert_eq!(code, "SATELLITE_HANDOVER_REFUSED_HTTP_404")
            }
            _ => panic!("the server's own 404 is final"),
        }
        // Authentication, timeouts, rate limits, server errors and platform
        // pages in front of the app heal: retried.
        for (status, body) in [
            (401, coded("UNAUTHORIZED")),
            (408, coded("TIMEOUT")),
            (429, coded("RATE_LIMITED")),
            (503, coded("REMOTE_HANDOVER_RETRY")),
            (500, coded("REMOTE_HANDOVER_FAILED")),
            (
                404,
                "<!doctype html><html><body>DEPLOYMENT_NOT_FOUND</body></html>".to_string(),
            ),
        ] {
            assert!(
                matches!(refusal(status, &body), ClaimFailure::Retry(_)),
                "{status} {body} retries"
            );
        }
        assert!(matches!(
            classify_proof_failure("SATELLITE_HANDOVER_PROOF_MISMATCH_currency".into()),
            ClaimFailure::Refused { .. }
        ));
        assert!(matches!(
            classify_proof_failure("database is locked".into()),
            ClaimFailure::Retry(_)
        ));
    }

    /// A proof that can never credit this claim is final too, through the
    /// real claim path: refused once, never resent, never credited.
    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn satellite_handover_refused_claim_is_never_resent_and_holds_the_close_until_released() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "main"),
            ("branch_id", "b1"),
        ]);
        let td = crate::tests::harness::TestDb::open();
        let intent = {
            let conn = td.state.conn.lock().unwrap();
            seed_rows(&conn);
            capture(&conn, &payload()).unwrap()
        };
        let mut mismatch = proof(&intent);
        mismatch["handover"]["receiving_cashier_shift_id"] = json!("another-cashier");
        let server = crate::tests::fake_http::MockServer::new(mismatch.to_string());
        let first = send(&td.state, &intent, &server.url, "plain-api-key")
            .await
            .unwrap();
        assert_eq!(first["refused"], true, "{first}");
        assert_eq!(server.count(), 1);
        {
            let conn = td.state.conn.lock().unwrap();
            assert_eq!(
                state(&conn),
                (
                    "refused".to_string(),
                    Some("SATELLITE_HANDOVER_PROOF_MISMATCH".to_string())
                )
            );
            let error = ensure_receiver_can_close(&conn, CASHIER).unwrap_err();
            assert!(
                error.starts_with("SATELLITE_HANDOVER_REFUSED: SATELLITE_HANDOVER_PROOF_MISMATCH"),
                "{error}"
            );
            assert_eq!(totals(&conn), (0, 0));
            assert_eq!(blocking_handovers(&conn, CASHIER).unwrap().len(), 1);
        }
        // Neither the sync cycle nor the same press again reaches the server.
        recover_pending(&td.state, &server.url, "plain-api-key")
            .await
            .unwrap();
        let again = record(&td.state, &payload()).await.unwrap();
        assert_eq!(again["refused"], true);
        assert_eq!(server.count(), 1, "a final refusal is never resent");
    }

    fn manager_on_duty(td: &crate::tests::harness::TestDb) -> crate::auth::AuthState {
        let conn = td.state.conn.lock().unwrap();
        crate::db::set_setting(&conn, "terminal", "__ignore_keyring", "1").unwrap();
        crate::db::set_setting(
            &conn,
            "staff",
            "staff_pin_hash",
            &bcrypt::hash("4321", 4).unwrap(),
        )
        .unwrap();
        let entry = |id: &str, pin: &str, permissions: &[&str]| {
            json!({"id": id, "canLoginPos": true, "isActive": true, "hasPin": true,
                "pinHash": bcrypt::hash(pin, 4).unwrap(), "permissions": permissions})
        };
        let directory = json!({"version": 1, "branch_id": "b1", "synced_at": "2026-10-06T07:00:00Z",
            "staff": [entry("staff-manager", "2468", &["pos.orders.cancel", "pos.refunds.process"]),
                      entry("staff", "1357", &["pos.orders.create"])]});
        crate::db::set_setting(
            &conn,
            "staff_auth_cache",
            "branch_b1",
            &directory.to_string(),
        )
        .unwrap();
        drop(conn);
        let auth = crate::auth::AuthState::new();
        crate::auth::login(Some(json!({"pin": "4321"})), &td.state, &auth)
            .expect("the main cashier's terminal login");
        auth
    }

    #[test]
    #[serial_test::serial]
    fn satellite_handover_release_is_a_managers_audited_decision_that_credits_no_drawer() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "main"),
            ("branch_id", "b1"),
        ]);
        let td = crate::tests::harness::TestDb::open();
        let intent = {
            let conn = td.state.conn.lock().unwrap();
            seed_rows(&conn);
            capture(&conn, &payload()).unwrap()
        };
        let auth = manager_on_duty(&td);
        let input = |pin: Option<&str>| {
            let mut input = json!({"action": "release", "handoverId": intent.id,
                "cashierShiftId": CASHIER, "note": "Satellite closed its own shift"});
            if let Some(pin) = pin {
                input["managerPin"] = json!(pin);
            }
            input
        };
        // Still being claimed: nothing to release.
        let pending = release(&td.state, &auth, &input(Some("2468"))).unwrap_err();
        assert!(format!("{pending:?}").contains("SATELLITE_HANDOVER_NOT_REFUSED"));
        {
            let conn = td.state.conn.lock().unwrap();
            mark_refused(
                &conn,
                &intent,
                "REMOTE_HANDOVER_PROOF_UNAVAILABLE",
                Some(409),
                "REMOTE_HANDOVER_PROOF_UNAVAILABLE (HTTP 409)",
            )
            .unwrap();
        }
        // A manager's own PIN, never the cashier's or none.
        assert!(
            format!("{:?}", release(&td.state, &auth, &input(None)).unwrap_err())
                .contains("SATELLITE_HANDOVER_MANAGER_PIN_REQUIRED")
        );
        assert!(release(&td.state, &auth, &input(Some("1357"))).is_err());
        assert_eq!(state(&td.state.conn.lock().unwrap()).0, "refused");
        let released = release(&td.state, &auth, &input(Some("2468"))).unwrap();
        assert_eq!(released["released"], true, "{released}");
        assert_eq!(released["alreadyReleased"], false);
        let conn = td.state.conn.lock().unwrap();
        assert_eq!(state(&conn).0, "released");
        ensure_receiver_can_close(&conn, CASHIER).unwrap();
        assert_eq!(totals(&conn), (0, 0), "no drawer is credited");
        let (actor, issue, payload): (Option<String>, String, String) = conn
            .query_row(
                "SELECT actor_staff_id, issue_code, payload_json FROM recovery_action_log WHERE action_id = ?1",
                [RELEASE_ACTION_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(actor.as_deref(), Some("staff-manager"));
        assert_eq!(issue, "REMOTE_HANDOVER_PROOF_UNAVAILABLE");
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["drawerCredited"], false);
        assert_eq!(payload["handover"]["countedCents"], 5525);
        assert_eq!(payload["note"], "Satellite closed its own shift");
        assert!(payload["snapshotId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
        drop(conn);
        // Idempotent, and the captured claim stays final.
        let again = release(&td.state, &auth, &input(Some("2468"))).unwrap();
        assert_eq!(again["alreadyReleased"], true);
    }

    /// One scripted answer per request; the request bodies are kept.
    fn spawn_status_server(
        responses: Vec<(u16, String)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = std::sync::Arc::clone(&bodies);
        std::thread::spawn(move || {
            for (stream, (status, body)) in listener.incoming().zip(responses) {
                let Ok(mut stream) = stream else { break };
                let mut buffer = vec![0u8; 32 * 1024];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let request_body = request
                    .split_once("\r\n\r\n")
                    .map(|(_, body)| body.to_string())
                    .unwrap_or_default();
                seen.lock().unwrap().push(request_body);
                let response = format!(
                    "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://{addr}"), bodies)
    }

    /// Coordinator review 14/10/2026: an open phone shift the remote checkout
    /// can never take closes from the Main without its cash, on a manager's
    /// own PIN and a reason. The server gets the manager as `approved_by`;
    /// nothing is credited and no claim is captured; the audit names the
    /// manager, the reason and the server's answer. Typed refusals reach the
    /// screen by their code.
    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn satellite_handover_close_without_handover_is_a_managers_audited_decision() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "main"),
            ("branch_id", "b1"),
        ]);
        let td = crate::tests::harness::TestDb::open();
        {
            let conn = td.state.conn.lock().unwrap();
            seed_rows(&conn);
        }
        let auth = manager_on_duty(&td);
        let closed = json!({"success": true, "already_closed": false,
            "shift": {"id": SOURCE, "status": "abandoned", "check_out_time": "2026-10-14T21:00:00Z"}})
        .to_string();
        let (url, bodies) = spawn_status_server(vec![
            (200, closed),
            (
                409,
                r#"{"success":false,"code":"REMOTE_HANDOVER_RECEIVER_MISMATCH","error":"Approver is not an active staff member"}"#.to_string(),
            ),
            (403, r#"{"success":false,"code":"REMOTE_CHECKOUT_NOT_UNIT_CHILD","error":"Not a phone of this register"}"#.to_string()),
            (
                403,
                r#"{"success":false,"code":"REMOTE_HANDOVER_APPROVAL_REQUIRED","error":"The approver cannot cancel orders"}"#.to_string(),
            ),
            (500, "upstream exploded".to_string()),
        ]);
        let input = |pin: Option<&str>, reason: &str| {
            let mut input = json!({"action": "close_without_handover", "satelliteShiftId": SOURCE,
                "reason": reason});
            if let Some(pin) = pin {
                input["managerPin"] = json!(pin);
            }
            input
        };
        let endpoint = Some((url.as_str(), "plain-api-key"));
        let error = |result: Result<Value, crate::auth::GuardedCommandError>| {
            format!("{:?}", result.unwrap_err())
        };

        // Nothing reaches the server without a reason or a manager's own PIN.
        assert!(error(
            close_without_handover_at(&td.state, &auth, &input(Some("2468"), "  "), endpoint).await
        )
        .contains("PHONE_SHIFT_CLOSE_REASON_REQUIRED"));
        assert!(error(
            close_without_handover_at(
                &td.state,
                &auth,
                &input(Some("2468"), &"x".repeat(501)),
                endpoint
            )
            .await
        )
        .contains("PHONE_SHIFT_CLOSE_REASON_REQUIRED"));
        assert!(error(
            close_without_handover_at(&td.state, &auth, &input(None, "Phone lost"), endpoint).await
        )
        .contains("SATELLITE_HANDOVER_MANAGER_PIN_REQUIRED"));
        assert!(close_without_handover_at(
            &td.state,
            &auth,
            &input(Some("1357"), "Phone lost"),
            endpoint
        )
        .await
        .is_err());
        assert!(bodies.lock().unwrap().is_empty());

        let done = close_without_handover_at(
            &td.state,
            &auth,
            &input(Some("2468"), " Phone lost "),
            endpoint,
        )
        .await
        .unwrap();
        assert_eq!(done["closedWithoutHandover"], true, "{done}");
        assert_eq!(done["alreadyClosed"], false);
        assert_eq!(done["shift"]["status"], "abandoned");
        let sent: Value = serde_json::from_str(&bodies.lock().unwrap()[0]).unwrap();
        assert_eq!(
            sent,
            json!({"shift_id": SOURCE, "action": "close_without_handover",
                "approved_by": "staff-manager", "reason": "Phone lost"})
        );
        {
            let conn = td.state.conn.lock().unwrap();
            assert_eq!(totals(&conn), (0, 0), "no drawer is credited");
            let claims: i64 = conn
                .query_row("SELECT COUNT(*) FROM satellite_cash_handovers", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(claims, 0, "no cash claim is captured");
            let (actor, entity, payload): (Option<String>, String, String) = conn
                .query_row(
                    "SELECT actor_staff_id, entity_id, payload_json FROM recovery_action_log WHERE action_id = ?1",
                    [CLOSE_WITHOUT_HANDOVER_ACTION_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(actor.as_deref(), Some("staff-manager"));
            assert_eq!(entity, SOURCE);
            let payload: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["drawerCredited"], false);
            assert_eq!(payload["reason"], "Phone lost");
            assert_eq!(payload["shift"]["status"], "abandoned");
        }

        for expected in [
            "REMOTE_HANDOVER_RECEIVER_MISMATCH",
            "REMOTE_CHECKOUT_NOT_UNIT_CHILD",
            "REMOTE_HANDOVER_APPROVAL_REQUIRED",
            "PHONE_SHIFT_CLOSE_FAILED",
        ] {
            let refused = close_without_handover_at(
                &td.state,
                &auth,
                &input(Some("2468"), "Phone lost"),
                endpoint,
            )
            .await;
            assert!(error(refused).contains(expected), "{expected}");
        }
        let audits: i64 = td
            .state
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM recovery_action_log WHERE action_id = ?1",
                [CLOSE_WITHOUT_HANDOVER_ACTION_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audits, 1, "a refused close writes no audit entry");
        assert!(
            close_without_handover_failure(&crate::api::AdminFetchError::transport("offline"))
                .contains("PHONE_SHIFT_CLOSE_OFFLINE")
        );
    }

    /// Coordinator review 14/10/2026: closing a phone shift without its
    /// handover also releases that shift's refused claim, under the same
    /// approval and with the release panel's trail, so the receiving cashier's
    /// close does not wait for a second manager action. A pending claim stays.
    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn satellite_handover_close_without_handover_releases_the_refused_claim_only() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "main"),
            ("branch_id", "b1"),
        ]);
        let td = crate::tests::harness::TestDb::open();
        let refused = {
            let conn = td.state.conn.lock().unwrap();
            seed_rows(&conn);
            let intent = capture(&conn, &payload()).unwrap();
            mark_refused(
                &conn,
                &intent,
                "ROLE_UNSUPPORTED",
                Some(409),
                "ROLE_UNSUPPORTED (HTTP 409)",
            )
            .unwrap();
            assert!(ensure_receiver_can_close(&conn, CASHIER).is_err());
            intent
        };
        let auth = manager_on_duty(&td);
        let answer = |id: &str| {
            json!({"success": true, "already_closed": true,
                "shift": {"id": id, "status": "abandoned", "check_out_time": "2026-10-14T21:00:00Z"}})
            .to_string()
        };
        let other = "33333333-3333-4333-8333-333333333333";
        let (url, _bodies) = spawn_status_server(vec![(200, answer(SOURCE)), (200, answer(other))]);
        let endpoint = Some((url.as_str(), "plain-api-key"));

        let done = close_without_handover_at(
            &td.state,
            &auth,
            &json!({"action": "close_without_handover", "satelliteShiftId": SOURCE,
                "managerPin": "2468", "reason": "Driver left with the phone"}),
            endpoint,
        )
        .await
        .unwrap();
        assert_eq!(done["releasedHandoverId"], json!(refused.id));
        {
            let conn = td.state.conn.lock().unwrap();
            assert_eq!(state(&conn).0, "released");
            ensure_receiver_can_close(&conn, CASHIER).unwrap();
            assert_eq!(totals(&conn), (0, 0), "no drawer is credited");
            let (actor, note, release_snapshot): (Option<String>, String, Option<String>) = conn
                .query_row(
                    "SELECT actor_staff_id, json_extract(payload_json, '$.note'), snapshot_point_id
                     FROM recovery_action_log WHERE action_id = ?1",
                    [RELEASE_ACTION_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(actor.as_deref(), Some("staff-manager"));
            assert_eq!(note, "Driver left with the phone");
            assert!(release_snapshot.is_some_and(|id| !id.is_empty()));
            let released_by: Option<String> = conn
                .query_row(
                    "SELECT released_by FROM satellite_cash_handovers WHERE id = ?1",
                    [&refused.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(released_by.as_deref(), Some("staff-manager"));
            // A pending claim of another phone shift stays as it is.
            let mut pending_payload = payload();
            pending_payload["satelliteShiftId"] = json!(other);
            capture(&conn, &pending_payload).unwrap();
        }
        let second = close_without_handover_at(
            &td.state,
            &auth,
            &json!({"action": "close_without_handover", "satelliteShiftId": other,
                "managerPin": "2468", "reason": "Phone lost"}),
            endpoint,
        )
        .await
        .unwrap();
        assert_eq!(second["releasedHandoverId"], Value::Null);
        let conn = td.state.conn.lock().unwrap();
        let pending: String = conn
            .query_row(
                "SELECT state FROM satellite_cash_handovers WHERE satellite_shift_id = ?1",
                [other],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, "pending", "a pending claim may still prove");
    }

    /// Founder decision 15/10/2026, the Main always receives: a closed driver
    /// till with a float is received at its own float and count, a count of 0
    /// included. The claim carries both, the proof must match them, and the
    /// drawer is credited once (given += float, returned += count).
    #[test]
    fn satellite_handover_receives_a_closed_driver_float_till_at_its_float_and_a_zero_count() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "main"),
            ("branch_id", "b1"),
        ]);
        let td = crate::tests::harness::TestDb::open();
        let conn = td.state.conn.lock().unwrap();
        seed_rows(&conn);
        let mut till = payload();
        till["openingCash"] = json!(20.0);
        till["countedCash"] = json!(0.0);
        let intent = capture(&conn, &till).unwrap();
        assert_eq!((intent.opening_cents, intent.counted_cents), (2000, 0));
        assert_eq!(request(&intent)["counted_cash_cents"], 0);

        let mut confirmation = proof(&intent);
        confirmation["handover"]["expected_cash_cents"] = json!(2000);
        confirmation["handover"]["cash_variance_cents"] = json!(-2000);
        // A proof that names another float never credits this claim.
        let mut other_float = confirmation.clone();
        other_float["handover"]["opening_cash_cents"] = json!(0);
        assert!(apply_proof(&conn, &intent, &other_float)
            .unwrap_err()
            .starts_with("SATELLITE_HANDOVER_PROOF_MISMATCH_opening_cash_cents"));
        assert_eq!(totals(&conn), (0, 0));

        apply_proof(&conn, &intent, &confirmation).unwrap();
        apply_proof(&conn, &intent, &confirmation).unwrap();
        assert_eq!(
            totals(&conn),
            (2000, 0),
            "credited once: the float given, nothing returned"
        );
        assert!(read(&conn, SOURCE).unwrap().unwrap().applied);
        ensure_receiver_can_close(&conn, CASHIER).unwrap();
    }

    /// Re-review 15/10/2026: a proof whose expected cash is negative (or
    /// missing) can never credit the claim. It is a final refusal, never left
    /// pending, and a manager's release then lets the cashier close.
    #[tokio::test(flavor = "current_thread")]
    #[serial_test::serial]
    async fn satellite_handover_a_proof_without_a_usable_expected_is_refused_and_releasable() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "main"),
            ("branch_id", "b1"),
        ]);
        let td = crate::tests::harness::TestDb::open();
        let intent = {
            let conn = td.state.conn.lock().unwrap();
            seed_rows(&conn);
            capture(&conn, &payload()).unwrap()
        };
        let mut negative = proof(&intent);
        negative["handover"]["expected_cash_cents"] = json!(-500);
        negative["handover"]["cash_variance_cents"] = json!(intent.counted_cents + 500);
        let server = crate::tests::fake_http::MockServer::new(negative.to_string());
        let first = send(&td.state, &intent, &server.url, "plain-api-key")
            .await
            .unwrap();
        assert_eq!(first["refused"], true, "{first}");
        {
            let conn = td.state.conn.lock().unwrap();
            assert_eq!(
                state(&conn),
                (
                    "refused".to_string(),
                    Some("SATELLITE_HANDOVER_EXPECTED_PROOF_MISSING".to_string())
                )
            );
            assert_eq!(totals(&conn), (0, 0), "nothing is credited");
            assert!(ensure_receiver_can_close(&conn, CASHIER)
                .unwrap_err()
                .starts_with(
                    "SATELLITE_HANDOVER_REFUSED: SATELLITE_HANDOVER_EXPECTED_PROOF_MISSING"
                ));
        }
        // Never resent.
        recover_pending(&td.state, &server.url, "plain-api-key")
            .await
            .unwrap();
        assert_eq!(server.count(), 1);

        let auth = manager_on_duty(&td);
        let released = release(
            &td.state,
            &auth,
            &json!({"action": "release", "handoverId": intent.id,
                "cashierShiftId": CASHIER, "managerPin": "2468"}),
        )
        .unwrap();
        assert_eq!(released["released"], true, "{released}");
        let conn = td.state.conn.lock().unwrap();
        ensure_receiver_can_close(&conn, CASHIER).unwrap();
        assert_eq!(totals(&conn), (0, 0));

        // A missing expected is the same final refusal.
        assert!(matches!(
            classify_proof_failure("SATELLITE_HANDOVER_EXPECTED_PROOF_MISSING".to_string()),
            ClaimFailure::Refused { .. }
        ));
        assert!(matches!(
            classify_proof_failure("database is locked".to_string()),
            ClaimFailure::Retry(_)
        ));
    }

    /// Coordinator review 14/10/2026: only a phone shift whose claims were all
    /// released is listed; a new live claim makes it count again.
    #[test]
    fn satellite_handover_released_sources_lists_only_shifts_without_a_live_claim() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        for (id, source, state) in [
            ("h1", "released-only", "released"),
            ("h2", "released-then-claimed", "released"),
            ("h3", "released-then-claimed", "pending"),
            ("h4", "refused", "refused"),
            ("h5", "applied", "applied"),
        ] {
            conn.execute(
                "INSERT INTO satellite_cash_handovers(id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,state,created_at)
                 VALUES (?1,?2,'b1','main','c1','d1','CHF',0,1000,?3,'2026-10-14T20:00:00Z')",
                params![id, source, state],
            )
            .unwrap();
        }
        assert_eq!(
            released_sources(&conn).unwrap(),
            vec!["released-only".to_string()]
        );
    }

    /// Schema v96 tables only allowed pending/applied: rebuilt once, every
    /// captured row kept.
    #[test]
    fn satellite_handover_v96_table_gains_the_final_states_keeping_its_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE satellite_cash_handovers (
            id TEXT PRIMARY KEY, satellite_shift_id TEXT NOT NULL UNIQUE, branch_id TEXT NOT NULL,
            terminal_id TEXT NOT NULL, cashier_shift_id TEXT NOT NULL, drawer_id TEXT NOT NULL,
            currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
            opening_cents INTEGER NOT NULL CHECK(opening_cents >= 0),
            counted_cents INTEGER NOT NULL CHECK(counted_cents >= 0), closed_by TEXT,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied')),
            last_error TEXT, proof_json TEXT, created_at TEXT NOT NULL, applied_at TEXT);
            CREATE INDEX satellite_cash_handovers_receiver ON satellite_cash_handovers(cashier_shift_id,state);
            INSERT INTO satellite_cash_handovers(id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,last_error,created_at)
            VALUES ('h1','s1','b1','main','c1','d1','CHF',2000,5525,'REMOTE_HANDOVER_PROOF_UNAVAILABLE (HTTP 409)','2026-10-05T20:00:00Z');").unwrap();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        let kept: (String, i64, Option<String>) = conn
            .query_row("SELECT state, counted_cents, last_error FROM satellite_cash_handovers WHERE id='h1'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap();
        assert_eq!(
            kept,
            (
                "pending".to_string(),
                5525,
                Some("REMOTE_HANDOVER_PROOF_UNAVAILABLE (HTTP 409)".to_string())
            )
        );
        conn.execute(
            "UPDATE satellite_cash_handovers SET state='refused', refusal_code='X' WHERE id='h1'",
            [],
        )
        .unwrap();
        assert!(ensure_receiver_can_close(&conn, "c1")
            .unwrap_err()
            .starts_with("SATELLITE_HANDOVER_REFUSED: X"));
    }

    /// Founder rule 13/10/2026: the Main closes every phone shift that holds
    /// cash, so a claim a manager released must not leave that shift
    /// unclosable (and the Z held for good). The released claim stays as
    /// history and the Main claims the shift again with a new identity; only
    /// one claim is ever live.
    #[test]
    fn satellite_handover_a_released_claim_can_be_followed_by_a_new_one() {
        let _keyring = crate::tests::fake_keyring::install_seeded([
            ("terminal_id", "main"),
            ("branch_id", "b1"),
        ]);
        let td = crate::tests::harness::TestDb::open();
        let conn = td.state.conn.lock().unwrap();
        seed_rows(&conn);
        let first = capture(&conn, &payload()).unwrap();
        // While a claim is live, the same press finds it again.
        assert_eq!(capture(&conn, &payload()).unwrap().id, first.id);
        mark_refused(
            &conn,
            &first,
            "REMOTE_HANDOVER_RECEIVER_MISMATCH",
            Some(409),
            "REMOTE_HANDOVER_RECEIVER_MISMATCH (HTTP 409)",
        )
        .unwrap();
        assert_eq!(capture(&conn, &payload()).unwrap().id, first.id);
        conn.execute(
            "UPDATE satellite_cash_handovers SET state='released', released_at='2026-10-14T20:00:00Z' WHERE id=?1",
            [&first.id],
        )
        .unwrap();

        let second = capture(&conn, &payload()).unwrap();
        assert_ne!(second.id, first.id, "a new identity after the release");
        assert_eq!(second.state, "pending");
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT id, state FROM satellite_cash_handovers WHERE satellite_shift_id=?1 ORDER BY created_at, state")
            .unwrap()
            .query_map([SOURCE], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2, "the released claim stays as history");
        assert!(rows.contains(&(first.id.clone(), "released".to_string())));
        assert!(rows.contains(&(second.id.clone(), "pending".to_string())));
        // Never two live claims for one phone shift.
        assert!(conn
            .execute(
                "INSERT INTO satellite_cash_handovers(id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,created_at)
                 VALUES ('dup',?1,'b1','main','c1','d1','CHF',0,0,'2026-10-14T20:00:00Z')",
                [SOURCE],
            )
            .is_err());
    }

    #[test]
    fn satellite_handover_table_unique_per_shift_is_rebuilt_once_keeping_its_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE satellite_cash_handovers ({});
             INSERT INTO satellite_cash_handovers(id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,state,refusal_code,released_at,created_at)
             VALUES ('h1','s1','b1','main','c1','d1','CHF',2000,5525,'released','X','2026-10-14T19:00:00Z','2026-10-14T18:00:00Z');",
            TABLE_COLUMNS.replace("satellite_shift_id TEXT NOT NULL,", "satellite_shift_id TEXT NOT NULL UNIQUE,")
        ))
        .unwrap();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        let kept: (String, i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT state, counted_cents, refusal_code, released_at FROM satellite_cash_handovers WHERE id='h1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            kept,
            (
                "released".to_string(),
                5525,
                Some("X".to_string()),
                Some("2026-10-14T19:00:00Z".to_string())
            )
        );
        conn.execute(
            "INSERT INTO satellite_cash_handovers(id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,created_at)
             VALUES ('h2','s1','b1','main','c2','d2','CHF',0,1000,'2026-10-14T20:00:00Z')",
            [],
        )
        .expect("a new claim after the released one");
    }
}
