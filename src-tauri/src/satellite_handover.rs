//! Durable main-register receipt of satellite cash. Capture precedes remote close;
//! the server claim and local drawer credit are independently idempotent.
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
}

pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS satellite_cash_handovers (
        id TEXT PRIMARY KEY,
        satellite_shift_id TEXT NOT NULL UNIQUE,
        branch_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        cashier_shift_id TEXT NOT NULL,
        drawer_id TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
        opening_cents INTEGER NOT NULL CHECK(opening_cents >= 0),
        counted_cents INTEGER NOT NULL CHECK(counted_cents >= 0),
        closed_by TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied')),
        last_error TEXT,
        proof_json TEXT,
        created_at TEXT NOT NULL,
        applied_at TEXT
    ); CREATE INDEX IF NOT EXISTS satellite_cash_handovers_receiver ON satellite_cash_handovers(cashier_shift_id,state);")
        .map_err(|e| format!("satellite handover schema: {e}"))
}

fn read(conn: &Connection, source: &str) -> Result<Option<Handover>, String> {
    conn.query_row("SELECT id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,closed_by,state FROM satellite_cash_handovers WHERE satellite_shift_id=?1",[source],|row| Ok(Handover {
        id:row.get(0)?,source:row.get(1)?,branch:row.get(2)?,terminal:row.get(3)?,cashier:row.get(4)?,drawer:row.get(5)?,currency:row.get(6)?,opening_cents:row.get(7)?,counted_cents:row.get(8)?,closed_by:row.get(9)?,applied:row.get::<_,String>(10)?=="applied",
    })).optional().map_err(|e|format!("read satellite handover: {e}"))
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
    };
    conn.execute("INSERT INTO satellite_cash_handovers(id,satellite_shift_id,branch_id,terminal_id,cashier_shift_id,drawer_id,currency,opening_cents,counted_cents,closed_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![intent.id,intent.source,intent.branch,intent.terminal,intent.cashier,intent.drawer,intent.currency,intent.opening_cents,intent.counted_cents,intent.closed_by,chrono::Utc::now().to_rfc3339()]).map_err(|e|format!("capture satellite handover: {e}"))?;
    Ok(intent)
}

pub(crate) fn ensure_receiver_can_close(conn: &Connection, shift: &str) -> Result<(), String> {
    let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM satellite_cash_handovers WHERE cashier_shift_id=?1 AND state='pending')",[shift],|row|row.get(0)).map_err(|e|e.to_string())?;
    if pending {
        return Err("SATELLITE_HANDOVER_PENDING: reconnect to finish receiving satellite cash before closing this cashier shift".to_string());
    }
    Ok(())
}

fn request(intent: &Handover) -> Value {
    json!({"shift_id":intent.source,"action":"close","handover_id":intent.id,"receiving_cashier_shift_id":intent.cashier,"currency":intent.currency,"counted_cash_cents":intent.counted_cents,"closed_by":intent.closed_by})
}

fn outcome(intent: &Handover, applied: bool, error: Option<&str>) -> Value {
    json!({"success":true,"applied":applied,"pending":!applied,"handoverId":intent.id,"cashierShiftId":intent.cashier,"drawerId":intent.drawer,"error":error})
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
    let response = crate::api::fetch_from_admin(
        admin,
        api_key,
        "/api/pos/shifts/remote-checkout",
        "POST",
        Some(request(intent)),
    )
    .await;
    let result = response.and_then(|body| {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        apply_proof(&conn, intent, &body)
    });
    match result {
        Ok(()) => {
            let conn = db.conn.lock().map_err(|error| error.to_string())?;
            applied_outcome(&conn, intent)
        }
        Err(error) => {
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
        capture(&conn, payload)?
    };
    if intent.applied {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        return applied_outcome(&conn, &intent);
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

#[cfg(test)]
mod tests {
    use super::*;
    const SOURCE: &str = "11111111-1111-4111-8111-111111111111";
    const CASHIER: &str = "22222222-2222-4222-8222-222222222222";
    fn seed(conn: &Connection) {
        crate::db::run_migrations_for_test(conn);
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
}
