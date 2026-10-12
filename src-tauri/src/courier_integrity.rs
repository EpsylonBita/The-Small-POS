//! Read-only support evidence for the zero-cash courier snapshot incident.
//! This compares receipts with saved earnings; it never establishes physical debt.
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(crate) fn collect(conn: &Connection) -> Result<Value, String> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='driver_earnings')",
        [], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if !exists {
        return Ok(json!({"status":"not_applicable", "issues":[]}));
    }
    let branch = crate::db::get_setting(conn, "terminal", "branch_id")
        .filter(|s| !s.trim().is_empty())
        .or_else(|| crate::storage::get_credential("branch_id").map(|value| value.to_string()))
        .ok_or("COURIER_INTEGRITY_BRANCH_UNKNOWN")?;
    let mut stmt = conn
        .prepare(
            "SELECT de.id, de.order_id, o.order_number, de.driver_id, de.staff_shift_id,
                ss.status, ss.check_out_time, de.currency, de.created_at, de.updated_at
         FROM driver_earnings de JOIN orders o ON o.id=de.order_id
         JOIN staff_shifts ss ON ss.id=de.staff_shift_id
         WHERE de.branch_id=?1 AND o.branch_id=?1 AND ss.branch_id=?1
           AND ss.role_type='driver' AND ss.staff_id=de.driver_id AND o.driver_id=de.driver_id
           AND o.order_type='delivery' AND o.status IN ('delivered','completed')
           AND COALESCE(o.is_ghost,0)=0 AND COALESCE(de.is_transferred,0)=0
           AND COALESCE(de.cash_collected_cents,CAST(ROUND(de.cash_collected*100) AS INTEGER),0)=0
           AND (ss.status='active' OR julianday(de.created_at)>=julianday('now','-30 days'))
         ORDER BY CASE WHEN ss.status='active' THEN 0 ELSE 1 END, de.created_at DESC, de.id
         LIMIT 251",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![branch], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let truncated = rows.len() > 250;
    let checked = rows.len().min(250);
    let mut issues = Vec::new();
    for (id, order, number, driver, shift, status, closed, currency, created, updated) in
        rows.into_iter().take(250)
    {
        let (_, cash, _, _) = crate::order_ownership::get_order_payment_totals(conn, &order)?;
        let receipt_cents = crate::money::Cents::round_half_even(cash).as_i64();
        if receipt_cents <= 0 {
            continue;
        }
        // A staff handback is separate from the customer refund already counted above.
        let returned = crate::staff_cash_returns::sum(conn, Some(&order), Some(&shift))?;
        if returned >= receipt_cents {
            continue;
        }
        issues.push(json!({
            "entityType":"driver_earning", "entityId":id, "orderId":order, "orderNumber":number,
            "reasonCode":"courier_cash_missing_from_earning", "suggestedFix":"contact_support",
            "driverId":driver, "shiftId":shift, "shiftStatus":status, "checkOutTime":closed,
            "currency":currency, "recordedCashCents":0, "receiptCashCents":receipt_cents-returned,
            "differenceCents":receipt_cents-returned,
            "createdAt":created, "updatedAt":updated,
            "details":"Cash receipts exist but the saved courier cash is zero. Review collection and shift records; this is not proof of unreturned cash."
        }));
    }
    if truncated {
        issues.push(
            json!({"entityType":"driver_earning", "entityId":"scan-limit",
            "reasonCode":"courier_cash_check_incomplete", "suggestedFix":"contact_support"}),
        );
    }
    Ok(
        json!({"status":"ok", "checkedAt":chrono::Utc::now().to_rfc3339(),
        "lookbackDays":30,"candidateLimit":250,"checkedCount":checked,"truncated":truncated,"issues":issues}),
    )
}
