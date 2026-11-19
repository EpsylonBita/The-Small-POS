//! Fresh canonical revision for non-financial header corrections. Local form
//! revisions and canonical CAS revisions are different clocks.
use rusqlite::Connection;
use serde_json::{json, Value};

pub(crate) fn capture(conn: &Connection, order: &str, request: &Value) -> Result<Value, String> {
    capture_except(conn, order, request, None)
}

/// Recovery may exclude only the exact refused row it is replacing. Every
/// other outstanding edit retains the ordinary preflight barrier.
pub(crate) fn capture_except(
    conn: &Connection,
    order: &str,
    request: &Value,
    excluded: Option<&str>,
) -> Result<Value, String> {
    let scope = crate::table_session_cache::current_scope(conn)?;
    let mut original: Value = conn.query_row(
        "SELECT supabase_id,organization_id,branch_id,COALESCE(version,1),remote_version,status,total_amount,items,notes,special_instructions,sync_status FROM orders WHERE id=?1",
        [order], |r| Ok(json!({"id":r.get::<_,Option<String>>(0)?,"organizationId":r.get::<_,Option<String>>(1)?,
            "branchId":r.get::<_,Option<String>>(2)?,"localVersion":r.get::<_,i64>(3)?,"remoteVersion":r.get::<_,Option<i64>>(4)?,
            "status":r.get::<_,String>(5)?,"totalCents":crate::money::Cents::round_half_even(r.get::<_,f64>(6)?).as_i64(),
            "items":r.get::<_,String>(7)?,"notes":r.get::<_,Option<String>>(8)?,"special_instructions":r.get::<_,Option<String>>(9)?,
            "syncStatus":r.get::<_,String>(10)?}))) .map_err(|e|e.to_string())?;
    if original["organizationId"] != scope.organization || original["branchId"] != scope.branch {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    let expected_local = request
        .get("expectedLocalVersion")
        .or_else(|| request.get("expected_local_version"))
        .and_then(Value::as_i64);
    let expected_display = request
        .get("expectedVersion")
        .or_else(|| request.get("expected_version"))
        .and_then(Value::as_i64);
    let displayed = original["remoteVersion"]
        .as_i64()
        .or(original["localVersion"].as_i64());
    if expected_local.is_some_and(|v| Some(v) != original["localVersion"].as_i64())
        || expected_display.is_some_and(|v| Some(v) != displayed)
    {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    original["terminalId"] = json!(scope.terminal);
    original["headers"] = crate::edit_settlement_recovery::capture_order_headers(conn, order)?;
    let payments:String=conn.query_row("SELECT COALESCE(json_group_array(json_object('id',id,'remote',remote_payment_id,'status',status,'amount',amount,'currency',currency,'method',method,'tip',tip_amount,'origin',payment_origin,'reference',transaction_ref,'sync',sync_status)), '[]') FROM (SELECT * FROM order_payments WHERE order_id=?1 ORDER BY id)",[order],|r|r.get(0)).map_err(|e|e.to_string())?;
    original["localPayments"] = json!(payments);
    let adjustments:String=conn.query_row("SELECT COALESCE(json_group_array(json_object('id',id,'payment',payment_id,'type',adjustment_type,'amount',amount,'cents',amount_cents,'method',refund_method,'handler',cash_handler,'shift',staff_shift_id)), '[]') FROM (SELECT * FROM payment_adjustments WHERE order_id=?1 ORDER BY id)",[order],|r|r.get(0)).map_err(|e|e.to_string())?;
    original["localAdjustments"] = json!(adjustments);
    let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM parity_sync_queue WHERE table_name='orders' AND record_id=?1 AND ((?2 IS NULL AND operation='UPDATE') OR (?2 IS NOT NULL AND id<>?2)))",rusqlite::params![order,excluded],|r|r.get(0)).map_err(|e|e.to_string())?;
    if pending {
        return Err("ORDER_HEADER_SYNC_REQUIRED".into());
    }
    Ok(original)
}

// Use the POS projection for names, options and money. Raw relation rows are
// not an alternative display shape: they may have no name until hydration.
// Only the two pricing facts omitted by the GET hydrator are supplemented,
// joined by the server line UUID (never position or product identity).
fn canonical_items(canonical: &Value) -> Result<Value, String> {
    let mut items = canonical["items"]
        .as_array()
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?
        .clone();
    if let Some(raw) = canonical.get("order_items") {
        let raw = raw.as_array().ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
        for item in &mut items {
            let id = item["id"]
                .as_str()
                .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
            let matches: Vec<_> = raw.iter().filter(|row| row["id"] == id).collect();
            if matches.len() != 1 {
                return Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into());
            }
            for key in ["original_unit_price", "is_price_overridden"] {
                if let Some(value) = matches[0].get(key).filter(|v| !v.is_null()) {
                    item[key] = value.clone();
                }
            }
        }
        if raw.len() != items.len() {
            return Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into());
        }
    }
    Ok(Value::Array(items))
}

fn item_signatures(raw: &Value, display: bool) -> Result<Vec<Value>, String> {
    let value = if let Some(raw) = raw.as_str() {
        serde_json::from_str(raw).map_err(|_| "EDIT_CANONICAL_SNAPSHOT_INVALID")?
    } else {
        raw.clone()
    };
    let mut signatures = Vec::new();
    for item in value.as_array().ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")? {
        let mut item = item.clone();
        let object = item
            .as_object_mut()
            .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
        let original_known = ["original_unit_price", "originalUnitPrice"]
            .iter()
            .any(|key| object.get(*key).is_some_and(|v| !v.is_null()));
        let override_known = ["is_price_overridden", "isPriceOverridden"]
            .iter()
            .any(|key| object.get(*key).is_some_and(Value::is_boolean));
        for key in [
            "source_order_item_id",
            "sourceOrderItemId",
            "order_item_id",
            "orderItemId",
        ] {
            object.remove(key);
        }
        object.insert("id".into(), json!("11111111-1111-4111-8111-111111111111"));
        // The established owner already removes _meta and normalizes empty
        // modifiers. A manual marker is not a money or product identity.
        let mut normalized = crate::edit_settlement_recovery::items(&json!([item]))?.remove(0);
        normalized.as_object_mut().unwrap().remove("id");
        normalized["originalKnown"] = json!(original_known);
        normalized["overrideKnown"] = json!(override_known);
        if !display {
            normalized.as_object_mut().unwrap().remove("name");
            normalized.as_object_mut().unwrap().remove("notes");
        }
        signatures.push(normalized);
    }
    Ok(signatures)
}

fn items_match(local: &Value, canonical: &Value, display: bool) -> Result<bool, String> {
    let local = item_signatures(local, display)?;
    let canonical = item_signatures(canonical, display)?;
    if local.len() != canonical.len() {
        return Ok(false);
    }
    // Pulls historically discarded these two facts. Missing local evidence
    // cannot prove a change; an explicitly retained false/price still can.
    // Other fields keep the existing comparison. One-to-one matching retains
    // multiplicity even when an old cart id cannot name a canonical UUID.
    let edges: Vec<Vec<usize>> = local
        .iter()
        .map(|left| {
            canonical
                .iter()
                .enumerate()
                .filter_map(|(index, right)| {
                    let mut left = left.clone();
                    let mut right = right.clone();
                    for (known, field) in [
                        ("originalKnown", "originalUnitCents"),
                        ("overrideKnown", "overridden"),
                    ] {
                        if left[known] != true {
                            left.as_object_mut().unwrap().remove(field);
                            right.as_object_mut().unwrap().remove(field);
                        }
                        left.as_object_mut().unwrap().remove(known);
                        right.as_object_mut().unwrap().remove(known);
                    }
                    (left == right).then_some(index)
                })
                .collect()
        })
        .collect();
    fn assign(
        left: usize,
        edges: &[Vec<usize>],
        seen: &mut [bool],
        owners: &mut [Option<usize>],
    ) -> bool {
        for &right in &edges[left] {
            if seen[right] {
                continue;
            }
            seen[right] = true;
            if owners[right].is_none() || assign(owners[right].unwrap(), edges, seen, owners) {
                owners[right] = Some(left);
                return true;
            }
        }
        false
    }
    let mut owners = vec![None; canonical.len()];
    Ok((0..local.len())
        .all(|left| assign(left, &edges, &mut vec![false; canonical.len()], &mut owners)))
}

/// Reads never change the cached order. Only an exact original permits the
/// fresh wire version; a changed order remains editable for explicit refresh.
#[cfg(test)]
pub(crate) fn verify(
    conn: &Connection,
    order: &str,
    before: &Value,
    answer: &Value,
) -> Result<Value, String> {
    verify_detailed(conn, order, before, answer).map_err(|refusal| refusal.code)
}

/// The one order of an exact `GET /api/pos/orders/sync?order_id=` answer.
pub(crate) fn exact_order(answer: &Value) -> Result<&Value, String> {
    let rows = answer
        .get("orders")
        .and_then(Value::as_array)
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if answer["success"] != true || answer["exact_order_lookup"] != true || rows.len() != 1 {
        return Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into());
    }
    Ok(&rows[0])
}

/// Every difference between the till's original and the server's order:
/// `(field, adoptable)`. Headers other than the fulfillment and the two
/// notes are non-money and may be adopted; the rest refuses.
pub(crate) fn drift(
    before: &Value,
    canonical: &Value,
) -> Result<Vec<(&'static str, bool)>, String> {
    let mut drifts = Vec::new();
    let amount = canonical["total_amount"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if json!(crate::money::Cents::round_half_even(amount).as_i64()) != before["totalCents"] {
        drifts.push(("total_amount", false));
    }
    if canonical["status"] != before["status"] {
        drifts.push(("status", false));
    }
    for (_, field) in crate::edit_settlement_recovery::EDIT_HEADER_FIELDS {
        if !crate::edit_settlement_recovery::same_canonical_header(
            &canonical[*field],
            &before["headers"][*field],
        ) {
            let name = crate::edit_settlement_recovery::EDIT_REFUSAL_FIELDS
                .iter()
                .copied()
                .find(|known| known == field)
                .unwrap_or("items");
            drifts.push((name, *field != "order_type"));
        }
    }
    let canonical_items = canonical_items(canonical)?;
    if !items_match(&before["items"], &canonical_items, true)? {
        if items_match(&before["items"], &canonical_items, false)? {
            drifts.push(("items.name", true));
        } else {
            drifts.push(("items", false));
        }
    }
    for (field, name) in [
        ("notes", "notes"),
        ("special_instructions", "special_instructions"),
    ] {
        if !crate::edit_settlement_recovery::same_canonical_header(
            &canonical[field],
            &before[field],
        ) {
            drifts.push((name, true));
        }
    }
    Ok(drifts)
}

/// [`verify`] naming the first differing field.
pub(crate) fn verify_detailed(
    conn: &Connection,
    order: &str,
    before: &Value,
    answer: &Value,
) -> Result<Value, crate::edit_settlement_recovery::EditRefusal> {
    use crate::edit_settlement_recovery::EditRefusal;
    if capture(conn, order, &json!({}))? != *before {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    let canonical = exact_order(answer)?;
    if canonical["id"] != before["id"]
        || canonical["organization_id"] != before["organizationId"]
        || canonical["branch_id"] != before["branchId"]
    {
        return Err("EDIT_SETTLEMENT_SCOPE_MISMATCH".into());
    }
    let version = canonical["version"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("EDIT_CANONICAL_SNAPSHOT_INVALID")?;
    if before["remoteVersion"]
        .as_i64()
        .is_some_and(|known| version < known)
    {
        return Err(EditRefusal::at(
            "EDIT_CANONICAL_ORIGINAL_CHANGED",
            Some("canonical_version"),
        ));
    }
    if let Some((field, _)) = drift(before, canonical)?.first() {
        return Err(EditRefusal::at(
            "EDIT_CANONICAL_ORIGINAL_CHANGED",
            Some(field),
        ));
    }
    Ok(json!({"version":1,"canonicalVersion":version,"original":before}))
}

/// Offline metadata remains a queued correction against its existing CAS base.
/// A transport failure is not evidence that a newer canonical revision matches.
pub(crate) fn offline(
    conn: &Connection,
    order: &str,
    original: &Value,
    error: &crate::api::AdminFetchError,
) -> Result<Value, String> {
    if !error.is_transport_failure() {
        return Err("EDIT_CANONICAL_PREFLIGHT_REQUIRED".into());
    }
    let version = original["remoteVersion"]
        .as_i64()
        .or(original["localVersion"].as_i64())
        .filter(|v| *v > 0)
        .ok_or("ORDER_VERSION_CONFLICT")?;
    let proof = json!({"version":1,"canonicalVersion":version,"source":"offline_cached_revision","original":original});
    verify_local(conn, order, &proof)?;
    Ok(proof)
}

fn intent(request: &Value) -> Value {
    json!({"items":request["items"],"orderUpdates":request.get("orderUpdates").or_else(||request.get("order_updates")).unwrap_or(&Value::Null),"financials":request["financials"],
        "orderNotes":request.get("orderNotes").or_else(||request.get("order_notes")).or_else(||request.get("notes")).or_else(||request.get("special_instructions")).unwrap_or(&Value::Null)})
}

pub(crate) fn verify_local(conn: &Connection, order: &str, proof: &Value) -> Result<i64, String> {
    if proof["version"] != 1 || capture(conn, order, &json!({}))? != proof["original"] {
        return Err("ORDER_VERSION_CONFLICT".into());
    }
    proof["canonicalVersion"]
        .as_i64()
        .filter(|v| *v > 0)
        .ok_or("EDIT_CANONICAL_PREFLIGHT_REQUIRED".into())
}

pub(crate) fn remote_id(original: &Value) -> Result<Option<&str>, String> {
    match original["id"].as_str().filter(|id| !id.trim().is_empty()) {
        Some(id) if uuid::Uuid::parse_str(id).is_ok() => {
            if original["syncStatus"] != "synced" {
                return Err("ORDER_HEADER_SYNC_REQUIRED".into());
            }
            Ok(Some(id))
        }
        Some(_) => Err("EDIT_CANONICAL_SNAPSHOT_INVALID".into()),
        None => Ok(None),
    }
}

fn cache_key(conn: &Connection, event: &str) -> Result<String, String> {
    let scope = crate::table_session_cache::current_scope(conn)?;
    Ok(format!(
        "{}:{}:{}:{event}",
        scope.organization, scope.branch, scope.terminal
    ))
}
pub(crate) fn remember(
    conn: &Connection,
    order: &str,
    event: &str,
    proof: &Value,
    request: &Value,
) -> Result<(), String> {
    verify_local(conn, order, proof)?;
    crate::db::set_setting(
        conn,
        "order_header_preflight_v1",
        &cache_key(conn, event)?,
        &json!({"orderId":order,"proof":proof,"intent":intent(request)}).to_string(),
    )
}
pub(crate) fn remembered(
    conn: &Connection,
    order: &str,
    event: &str,
    request: &Value,
) -> Result<Option<Value>, String> {
    let Some(raw) =
        crate::db::get_setting(conn, "order_header_preflight_v1", &cache_key(conn, event)?)
    else {
        return Ok(None);
    };
    let saved: Value =
        serde_json::from_str(&raw).map_err(|_| "EDIT_CANONICAL_PREFLIGHT_REQUIRED")?;
    if saved["orderId"] != order || saved["intent"] != intent(request) {
        return Err("RECOVERY_ORIGINAL_REQUEST_REQUIRED".into());
    }
    capture(conn, order, request)?;
    verify_local(conn, order, &saved["proof"])?;
    Ok(Some(saved["proof"].clone()))
}

#[cfg(test)]
mod shape_tests {
    use super::*;
    use crate::commands::orders::driver_restore_tests as fixture;

    fn answer(before: &Value, hydrated: &Value, raw: Option<&Value>) -> Value {
        let mut canonical = before["headers"].clone();
        for (key, value) in [
            ("id", before["id"].clone()),
            ("organization_id", before["organizationId"].clone()),
            ("branch_id", before["branchId"].clone()),
            ("version", json!(4)),
            ("status", before["status"].clone()),
            (
                "total_amount",
                json!(before["totalCents"].as_i64().unwrap() as f64 / 100.0),
            ),
            ("notes", before["notes"].clone()),
            (
                "special_instructions",
                before["special_instructions"].clone(),
            ),
            ("items", hydrated.clone()),
        ] {
            canonical[key] = value;
        }
        if let Some(raw) = raw {
            canonical["order_items"] = raw.clone();
        }
        json!({"success":true,"exact_order_lookup":true,"orders":[canonical]})
    }

    fn check(
        conn: &Connection,
        before: &Value,
        answer: &Value,
        edit_ok: bool,
        notice_ok: bool,
        label: &str,
    ) {
        let edit = verify_detailed(conn, fixture::ORDER, before, answer);
        let notice = crate::order_notice_recovery::verify(before, answer);
        assert_eq!(edit.is_ok(), edit_ok, "ordinary: {label}: {edit:?}");
        assert_eq!(notice.is_ok(), notice_ok, "notice: {label}: {notice:?}");
        if let Err(error) = edit {
            assert_eq!(error.code, "EDIT_CANONICAL_ORIGINAL_CHANGED", "{label}");
        }
        if let Err(error) = notice {
            assert_eq!(error, "EDIT_CANONICAL_ORIGINAL_CHANGED", "{label}");
        }
    }

    // The checked-in JSON is generated by executing the real TS mappers, not
    // a Rust reconstruction of their aliases/defaults. The generator also
    // records the pre-filter database rows, including a genuinely voided row.
    #[test]
    fn order_header_preflight_route_line_kinds_at_create_ack_pull_and_edit() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let conn = fixture::test_conn();
        fixture::paid_delivery_order(&conn);
        let data: Value =
            serde_json::from_str(include_str!("tests/fixtures/order-header-shapes.json")).unwrap();
        let mut scenarios = 0;
        for case in data["fixtures"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let raw = &case["raw"];
            let hydrated = &case["hydrated"];
            let created = &case["local"];
            let edit_ack = &case["ackItems"];
            // The actual create-ACK owner either projects server rows and
            // client ids, or keeps the original when identity cannot match.
            let ack = crate::edit_settlement_recovery::lines_with_client_ids(
                created.as_array().unwrap(),
                edit_ack.as_array().unwrap(),
            );
            let ack_projected = ack.is_some();
            let ack = ack.map(Value::Array).unwrap_or_else(|| created.clone());
            for (phase, local) in [
                ("create", created),
                ("ack", &ack),
                ("pull", hydrated),
                ("edit_ack", edit_ack),
            ] {
                conn.execute(
                    "UPDATE orders SET items=?1 WHERE id=?2",
                    rusqlite::params![local.to_string(), fixture::ORDER],
                )
                .unwrap();
                let before = capture(&conn, fixture::ORDER, &json!({})).unwrap();
                for view in ["exact_both", "hydrated_only", "raw_only"] {
                    let wire = if view == "raw_only" { raw } else { hydrated };
                    let response = answer(&before, wire, (view == "exact_both").then_some(raw));
                    let identity_matches = case["createMatches"] == true
                        || phase == "pull"
                        || phase == "edit_ack"
                        || (phase == "ack" && ack_projected);
                    // Hydrated-only answers cannot prove a retained override:
                    // the current route drops both original price and flag.
                    let price_matches =
                        !(name == "price_override" && view == "hydrated_only" && phase != "pull");
                    let local_name_missing = false; // API ACK hydrates name from _meta.product_name.
                    let server_name_missing = name == "hydrated_name" && view == "raw_only";
                    let display_matches = local_name_missing == server_name_missing;
                    check(
                        &conn,
                        &before,
                        &response,
                        identity_matches && price_matches && display_matches,
                        identity_matches && price_matches,
                        &format!("{name}/{phase}/{view}"),
                    );
                    scenarios += 1;
                }
            }
            // For every kind, use a captured canonical edit snapshot to prove
            // all established money/identity/selection and line-set guards.
            conn.execute(
                "UPDATE orders SET items=?1 WHERE id=?2",
                rusqlite::params![raw.to_string(), fixture::ORDER],
            )
            .unwrap();
            let before = capture(&conn, fixture::ORDER, &json!({})).unwrap();
            let base = answer(&before, hydrated, Some(raw));
            for (field, value) in [
                ("unit_price", json!(99)),
                ("total_price", json!(99)),
                ("quantity", json!(7)),
                ("original_unit_price", json!(98)),
                (
                    "is_price_overridden",
                    json!(raw[0]["is_price_overridden"] != true),
                ),
                ("customizations", json!({"actual_option":true})),
                (
                    "menu_item_id",
                    json!("33333333-3333-4333-8333-333333333333"),
                ),
                (
                    "retail_product_id",
                    json!("44444444-4444-4444-8444-444444444444"),
                ),
            ] {
                let mut changed = base.clone();
                changed["orders"][0]["order_items"][0][field] = value.clone();
                // These two are the only compared fields the hydrator omits.
                if !matches!(field, "original_unit_price" | "is_price_overridden") {
                    changed["orders"][0]["items"][0][field] = value;
                }
                check(
                    &conn,
                    &before,
                    &changed,
                    false,
                    false,
                    &format!("{name}/changed/{field}"),
                );
                scenarios += 1;
            }
            for field in ["name", "notes"] {
                let mut changed = base.clone();
                changed["orders"][0]["items"][0][field] = json!("Changed display");
                changed["orders"][0]["order_items"][0][if field == "name" {
                    "menu_item_name"
                } else {
                    field
                }] = json!("Changed display");
                check(
                    &conn,
                    &before,
                    &changed,
                    false,
                    true,
                    &format!("{name}/adoptable/{field}"),
                );
                scenarios += 1;
            }
            if name == "voided_line" {
                conn.execute(
                    "UPDATE orders SET items=?1 WHERE id=?2",
                    rusqlite::params![case["databaseRows"].to_string(), fixture::ORDER],
                )
                .unwrap();
                let stale = capture(&conn, fixture::ORDER, &json!({})).unwrap();
                check(
                    &conn,
                    &stale,
                    &base,
                    false,
                    false,
                    "stale till still contains the voided line",
                );
                conn.execute(
                    "UPDATE orders SET items=?1 WHERE id=?2",
                    rusqlite::params![raw.to_string(), fixture::ORDER],
                )
                .unwrap();
            }
            for add in [false, true] {
                let mut changed = base.clone();
                for field in ["items", "order_items"] {
                    let rows = changed["orders"][0][field].as_array_mut().unwrap();
                    if add {
                        let mut extra = rows[0].clone();
                        extra["id"] = json!("55555555-5555-4555-8555-555555555555");
                        rows.push(extra);
                    } else {
                        rows.clear();
                    }
                }
                check(
                    &conn,
                    &before,
                    &changed,
                    false,
                    false,
                    &format!("{name}/line_set/{add}"),
                );
                scenarios += 1;
            }
        }
        assert_eq!(scenarios, 312); // 13 kinds x (4 stages x 3 projections + 12 mutations)
    }

    #[test]
    fn order_header_preflight_tomikro_already_equal_without_manual_marker_or_raw_relation() {
        let data: Value =
            serde_json::from_str(include_str!("tests/fixtures/order-header-shapes.json")).unwrap();
        let case = data["fixtures"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "manual_tomikro")
            .unwrap();
        // Call the pre-existing settlement normalizer directly, removing only
        // transport line identity exactly as the original header comparator did.
        let signature = |rows: &Value| {
            let mut row = rows[0].clone();
            row["id"] = json!(fixture::ITEM);
            crate::edit_settlement_recovery::items(&json!([row]))
                .unwrap()
                .remove(0)
        };
        let local = signature(&case["local"]);
        let hydrated = signature(&case["hydrated"]);
        assert_eq!(local, hydrated);
        assert_eq!(local["customizations"], Value::Null);
        assert_eq!(local["originalUnitCents"], 1450);
        assert_eq!(local["overridden"], false);
        assert!(local.get("manual").is_none());
    }

    #[test]
    fn order_header_preflight_mixed_known_and_missing_prices_keep_multiplicity() {
        let plain = json!({"name":"Same", "quantity":1, "unit_price":10, "total_price":10});
        let mut known = plain.clone();
        known["original_unit_price"] = json!(12);
        known["is_price_overridden"] = json!(true);
        let mut other = plain.clone();
        other["original_unit_price"] = json!(14);
        other["is_price_overridden"] = json!(true);
        // Unknown first can match either; it must not steal the only match
        // of the retained original. Reordering is not a changed sale.
        assert!(items_match(
            &json!([plain.clone(), known.clone()]),
            &json!([known.clone(), other.clone()]),
            true
        )
        .unwrap());
        assert!(!items_match(
            &json!([known.clone(), known.clone()]),
            &json!([known.clone(), other]),
            true
        )
        .unwrap());
        assert!(!items_match(
            &json!([plain.clone(), known.clone()]),
            &json!([known]),
            true
        )
        .unwrap());
    }
    #[test]
    fn order_header_preflight_manual_flags_and_stored_combo_columns_are_not_identity() {
        let _keys = crate::tests::fake_keyring::install_empty();
        let conn = fixture::test_conn();
        fixture::paid_delivery_order(&conn);
        for local in [
            json!([{"id":"manual-old", "isManual":true, "menuItemId":null, "name":"Manual", "quantity":1, "price":14.5, "customizations":[]}]),
            json!([{"id":"combo-old", "is_combo":true, "combo_id":"legacy-combo", "combo_items":[{"quantity":2}], "name":"Manual", "quantity":1, "price":14.5, "customizations":[]}]),
        ] {
            conn.execute(
                "UPDATE orders SET items=?1 WHERE id=?2",
                rusqlite::params![local.to_string(), fixture::ORDER],
            )
            .unwrap();
            let before = capture(&conn, fixture::ORDER, &json!({})).unwrap();
            let hydrated = json!([{"id":fixture::ITEM,"menu_item_id":null,"name":"Manual","quantity":1,"unit_price":14.5,"total_price":14.5,"customizations":null}]);
            let mut raw = hydrated.clone();
            raw[0]["is_combo"] = json!(true);
            raw[0]["combo_id"] = json!("legacy-combo");
            raw[0]["combo_items"] = json!([{"quantity":2}]);
            let response = answer(&before, &hydrated, Some(&raw));
            check(
                &conn,
                &before,
                &response,
                true,
                true,
                "markers omitted by an older projection",
            );
        }
    }

    #[test]
    fn order_header_preflight_pricing_supplement_joins_uuid_not_position_and_rejects_bad_relation()
    {
        let one = json!({"id":"first", "name":"One", "quantity":1, "unit_price":10});
        let two = json!({"id":"second", "name":"Two", "quantity":1, "unit_price":11});
        let mut raw_one = one.clone();
        raw_one["original_unit_price"] = json!(12);
        let mut raw_two = two.clone();
        raw_two["original_unit_price"] = json!(13);
        let base = json!({"items":[one,two],"order_items":[raw_two,raw_one]});
        let items = canonical_items(&base).unwrap();
        assert_eq!(items[0]["original_unit_price"], 12);
        assert_eq!(items[1]["original_unit_price"], 13);
        for bad in [
            json!(null),
            json!([]),
            json!([
                base["order_items"][0].clone(),
                base["order_items"][0].clone()
            ]),
        ] {
            let mut changed = base.clone();
            changed["order_items"] = bad;
            assert_eq!(
                canonical_items(&changed).unwrap_err(),
                "EDIT_CANONICAL_SNAPSHOT_INVALID"
            );
        }
    }
}
