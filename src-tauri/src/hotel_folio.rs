//! Server-born folio settlements. Import is a local mirror, never an order mutation.
use crate::money::Cents;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn is_settlement(order: &Value) -> bool {
    order
        .get("order_context")
        .or_else(|| order.get("orderContext"))
        .and_then(Value::as_str)
        == Some("folio_settlement")
}

pub(crate) fn is_local(conn: &Connection, id: &str) -> Result<bool, String> {
    let mut columns = conn
        .prepare("PRAGMA table_info(orders)")
        .map_err(|e| e.to_string())?;
    if !columns
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .any(|name| name.ok().as_deref() == Some("order_context"))
    {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM orders WHERE id=?1 AND order_context='folio_settlement')",
        [id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn import(conn: &Connection, order: &Value) -> Result<String, String> {
    for key in ["organization_id", "branch_id"] {
        let expected =
            crate::storage::get_credential(key).ok_or("FOLIO_SETTLEMENT_SCOPE_REQUIRED")?;
        if order.get(key).and_then(Value::as_str) != Some(expected.as_str()) {
            return Err("FOLIO_SETTLEMENT_SCOPE_MISMATCH".into());
        }
    }
    import_scoped(conn, order)
}

fn import_scoped(conn: &Connection, order: &Value) -> Result<String, String> {
    if !is_settlement(order) {
        return Err("FOLIO_SETTLEMENT_REQUIRED".into());
    }
    let text = |key| {
        order
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("FOLIO_SETTLEMENT_INVALID:{key}"))
    };
    let local = text("client_order_id")?;
    let remote = text("id")?;
    let folio = text("folio_id")?;
    for id in [local, remote, folio] {
        uuid::Uuid::parse_str(id).map_err(|_| "FOLIO_SETTLEMENT_INVALID_ID")?;
    }
    let currency = text("currency")?;
    crate::fiscal::payload_builder::normalize_currency_code(currency)
        .ok_or("FOLIO_CURRENCY_UNAVAILABLE")?;
    let items = order
        .get("items")
        .or_else(|| order.get("order_items"))
        .and_then(Value::as_array)
        .ok_or("FOLIO_SETTLEMENT_ITEMS_REQUIRED")?;
    if items.is_empty()
        || items.iter().any(|item| {
            !matches!(
                item.get("folio_line_kind").and_then(Value::as_str),
                Some("revenue" | "transfer")
            )
        })
    {
        return Err("FOLIO_SETTLEMENT_INVALID_LINES".into());
    }
    let cents = order
        .get("total_amount_cents")
        .and_then(Value::as_i64)
        .ok_or("FOLIO_SETTLEMENT_AMOUNT_REQUIRED")?;
    let tax = order
        .get("tax_amount_cents")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut metadata = order
        .get("ghost_metadata")
        .filter(|m| m.is_object())
        .cloned()
        .unwrap_or(json!({}));
    metadata["folio_settlement"]["folio_id"] = json!(folio);
    let fiscal_lines = order
        .get("fiscal_line_snapshot")
        .and_then(Value::as_array)
        .ok_or("FOLIO_SETTLEMENT_SNAPSHOT_REQUIRED")?;
    if fiscal_lines.is_empty()
        && items
            .iter()
            .any(|item| item.get("folio_line_kind").and_then(Value::as_str) == Some("revenue"))
    {
        return Err("FOLIO_SETTLEMENT_SNAPSHOT_REQUIRED".into());
    }
    metadata["folio_settlement"]["fiscal_line_snapshot"] = json!(fiscal_lines);
    metadata["folio_settlement"]["fiscal_totals"] =
        order.get("fiscal_totals").cloned().unwrap_or(json!({}));
    let existing: Option<(String,String,String)> = conn.query_row("SELECT id,COALESCE(supabase_id,''),COALESCE(order_context,'') FROM orders WHERE id=?1 OR supabase_id=?2",params![local,remote],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    if let Some((id, server, context)) = existing {
        if id != local || server != remote || context != "folio_settlement" {
            return Err("SETTLEMENT_REQUEST_CONFLICT".into());
        }
        // Preserve local receipts and their paid projection, including offline payments.
        if order.get("status").and_then(Value::as_str) == Some("cancelled") {
            if crate::payments::load_store_taken_net_paid_cents(conn, local)? <= 0 {
                conn.execute("UPDATE orders SET status='cancelled' WHERE id=?1", [local])
                    .map_err(|e| e.to_string())?;
            }
        }
        return Ok(id);
    }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute("INSERT INTO orders(id,supabase_id,client_request_id,organization_id,branch_id,terminal_id,order_context,
      items,total_amount,total_amount_cents,subtotal,subtotal_cents,tax_amount,tax_amount_cents,currency,
      status,payment_status,sync_status,order_type,order_number,staff_id,staff_shift_id,ghost_metadata,created_at,updated_at)
      VALUES(?1,?2,?1,?3,?4,?5,'folio_settlement',?6,?7,?8,?7,?8,?9,?10,?11,?12,'pending','synced','room_service',?13,?14,?15,?16,?17,?17)",
      params![local,remote,text("organization_id")?,text("branch_id")?,order.get("terminal_id").and_then(Value::as_str),
      serde_json::to_string(items).map_err(|e|e.to_string())?,Cents::new(cents).to_f64_dp2(),cents,Cents::new(tax).to_f64_dp2(),tax,currency,
      order.get("status").and_then(Value::as_str).unwrap_or("completed"),order.get("order_number").and_then(Value::as_str),
      order.get("staff_id").and_then(Value::as_str),order.get("staff_shift_id").and_then(Value::as_str),metadata.to_string(),
      order.get("created_at").and_then(Value::as_str).unwrap_or(&now)]).map_err(|e|format!("import folio settlement: {e}"))?;
    Ok(local.into())
}

pub(crate) const SCHEMA_SQL: &str = r#"
CREATE TRIGGER IF NOT EXISTS folio_settlement_tenders_only
BEFORE INSERT ON order_payments WHEN (lower(trim(NEW.method))='room_charge' OR COALESCE(NEW.tip_amount_cents,0)<>0 OR COALESCE(NEW.tip_amount,0)<>0)
 AND EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND order_context='folio_settlement')
BEGIN SELECT RAISE(ABORT,'FOLIO_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS folio_settlement_no_order_outbox
BEFORE INSERT ON parity_sync_queue WHEN NEW.table_name='orders'
 AND EXISTS(SELECT 1 FROM orders WHERE (id=NEW.record_id OR supabase_id=NEW.record_id) AND order_context='folio_settlement')
BEGIN SELECT RAISE(ABORT,'FOLIO_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS folio_settlement_no_legacy_outbox
BEFORE INSERT ON sync_queue WHEN NEW.entity_type='order'
 AND EXISTS(SELECT 1 FROM orders WHERE (id=NEW.entity_id OR supabase_id=NEW.entity_id) AND order_context='folio_settlement')
BEGIN SELECT RAISE(ABORT,'FOLIO_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS folio_settlement_fixed_lines
BEFORE UPDATE OF items,total_amount,total_amount_cents,subtotal,tax_amount,discount_amount,discount_percentage,order_type,order_context ON orders
WHEN OLD.order_context='folio_settlement' AND (NEW.items IS NOT OLD.items OR NEW.total_amount IS NOT OLD.total_amount
 OR NEW.total_amount_cents IS NOT OLD.total_amount_cents OR NEW.subtotal IS NOT OLD.subtotal OR NEW.tax_amount IS NOT OLD.tax_amount
 OR NEW.discount_amount IS NOT OLD.discount_amount OR NEW.discount_percentage IS NOT OLD.discount_percentage
 OR NEW.order_type IS NOT OLD.order_type OR NEW.order_context IS NOT OLD.order_context)
BEGIN SELECT RAISE(ABORT,'FOLIO_SETTLEMENT_IMMUTABLE'); END;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::run_migrations_for_test(&conn);
        conn
    }
    fn order() -> Value {
        json!({"id":"11111111-1111-4111-8111-111111111111","client_order_id":"22222222-2222-4222-8222-222222222222",
       "folio_id":"33333333-3333-4333-8333-333333333333","organization_id":"org","branch_id":"branch","currency":"CHF","order_context":"folio_settlement",
       "total_amount_cents":15000,"tax_amount_cents":1300,
       "items":[{"folio_line_kind":"revenue","total_price":100.0},{"folio_line_kind":"transfer","total_price":50.0}],
       "fiscal_line_snapshot":[{"id":"room","grossAmount":100.0,"netAmount":87.0,"vatAmount":13.0,"grossUnitPrice":100.0,"quantity":1,"vatRate":13.0}]})
    }
    #[test]
    fn hotel_import_preserves_identity_receipts_and_fixed_money() {
        let conn = conn();
        let order = order();
        let id = import_scoped(&conn, &order).unwrap();
        assert_eq!(id, order["client_order_id"].as_str().unwrap());
        assert!(
            !crate::payment_integrity::load_order_payment_blockers(&conn, &id)
                .unwrap()
                .is_empty(),
            "An unpaid settlement blocks the Z"
        );
        conn.execute("INSERT INTO order_payments(id,order_id,method,amount,amount_cents,currency,status,created_at,updated_at) VALUES('receipt',?1,'cash',150,15000,'CHF','completed','now','now')",[&id]).unwrap();
        conn.execute("UPDATE orders SET payment_status='paid' WHERE id=?1", [&id])
            .unwrap();
        assert_eq!(import_scoped(&conn, &order).unwrap(), id);
        let paid: String = conn
            .query_row(
                "SELECT payment_status FROM orders WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(paid, "paid");
        assert!(conn
            .execute("UPDATE orders SET total_amount=99 WHERE id=?1", [&id])
            .unwrap_err()
            .to_string()
            .contains("FOLIO_SETTLEMENT_IMMUTABLE"));
        assert!(conn
            .execute(
                "INSERT INTO parity_sync_queue(table_name,record_id) VALUES('orders',?1)",
                [&id]
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO sync_queue(entity_type,entity_id) VALUES('order',?1)",
                [&id]
            )
            .is_err());
    }
    #[test]
    fn hotel_import_refuses_missing_snapshot_or_identity_conflict() {
        let conn = conn();
        let mut bad = order();
        bad["fiscal_line_snapshot"] = json!([]);
        assert!(import_scoped(&conn, &bad)
            .unwrap_err()
            .contains("SNAPSHOT_REQUIRED"));
        let order = order();
        let id = import_scoped(&conn, &order).unwrap();
        conn.execute("UPDATE orders SET supabase_id='other' WHERE id=?1", [&id])
            .unwrap();
        assert_eq!(
            import_scoped(&conn, &order).unwrap_err(),
            "SETTLEMENT_REQUEST_CONFLICT"
        );
    }
    #[test]
    fn hotel_only_transfers_have_no_fiscal_lines() {
        let conn = conn();
        let mut order = order();
        order["items"] = json!([{"folio_line_kind":"transfer","total_price":150.0}]);
        order["fiscal_line_snapshot"] = json!([]);
        let id = import_scoped(&conn, &order).unwrap();
        assert!(
            crate::fiscal::payload_builder::folio_fiscal_lines(&conn, &id)
                .unwrap()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn hotel_fiscal_snapshot_excludes_transfer_and_keeps_tax_exemption() {
        let conn = conn();
        let mut order = order();
        order["fiscal_line_snapshot"].as_array_mut().unwrap().push(json!({"id":"tax","description":"Accommodation tax","grossAmount":5.0,"netAmount":5.0,"vatAmount":0.0,"grossUnitPrice":5.0,"quantity":1,"vatRate":0.0,"taxExemptionReason":"accommodation_tax"}));
        let id = import_scoped(&conn, &order).unwrap();
        let lines = crate::fiscal::payload_builder::folio_fiscal_lines(&conn, &id)
            .unwrap()
            .unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines
                .iter()
                .map(|l| l["grossCents"].as_i64().unwrap())
                .sum::<i64>(),
            10500
        );
        assert_eq!(
            lines[1]["metadata"]["taxExemptionReason"],
            "accommodation_tax"
        );
    }
    #[test]
    fn hotel_register_fiscalizes_only_revenue_and_real_tenders() {
        let conn = conn();
        let id = import_scoped(&conn, &order()).unwrap();
        let lines = crate::fiscal::payload_builder::folio_fiscal_lines(&conn, &id)
            .unwrap()
            .unwrap();
        let tenders = vec![
            json!({"status":"completed","method":"cash","amount":50}),
            json!({"status":"completed","method":"card","amount":100}),
        ];
        let rates = vec![crate::ecr::protocol::TaxRateConfig {
            code: "configured-room-rate".into(),
            rate: 13.0,
            label: "Room VAT".into(),
            department: Some(1),
        }];
        let fiscal =
            crate::ecr::fiscal::build_folio_fiscal_data(&lines, &tenders, 15000, &rates, None)
                .unwrap();
        assert!(
            crate::ecr::fiscal::build_folio_fiscal_data(&lines, &tenders, 15000, &[], None)
                .unwrap_err()
                .contains("TAX_MAPPING_REQUIRED")
        );
        assert_eq!(fiscal.items.len(), 1);
        assert_eq!(fiscal.items[0].unit_price, 10000);
        assert_eq!(
            fiscal.payments.iter().map(|p| p.amount).collect::<Vec<_>>(),
            vec![3333, 6667]
        );
        assert!(crate::ecr::fiscal::build_folio_fiscal_data(
            &lines,
            &tenders[..1],
            15000,
            &rates,
            None
        )
        .is_err());
    }

    #[test]
    fn hotel_receipt_keeps_frozen_vat_and_separates_transfer_from_sale_lines() {
        let conn = conn();
        let id = import_scoped(&conn, &order()).unwrap();
        crate::db::set_setting(&conn, "tax", "default_tax_rate", "24").unwrap();
        let db = crate::db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        };
        let receipt = crate::print::build_order_receipt_doc(&db, &id).unwrap();
        assert_eq!(receipt.items.len(), 1);
        assert!(receipt
            .totals
            .iter()
            .any(|line| line.label == "Tax" && line.amount == 13.0));
        assert!(receipt
            .totals
            .iter()
            .any(|line| line.label == "Room charges collected" && line.amount == 50.0));
    }
    #[test]
    fn hotel_migration_backfills_a_later_integration_schema() {
        // A real upgrade takes the normal pre-migration backup; in-memory
        // connections intentionally cannot satisfy that recovery contract.
        let temporary = crate::tests::harness::TempDir::new();
        let conn = Connection::open(temporary.path().join("pos.db")).unwrap();
        crate::db::run_migrations_for_test(&conn);
        conn.execute_batch("DROP TRIGGER folio_settlement_no_order_outbox; DELETE FROM schema_version WHERE version=101;").unwrap();
        crate::db::run_migrations_for_test(&conn);
        let guards: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='folio_settlement_no_order_outbox'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(guards, 1);
        let version: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_version WHERE version=101",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, 1);
    }
}
