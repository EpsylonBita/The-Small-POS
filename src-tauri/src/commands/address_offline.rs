use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::{
    db, read_local_json, read_local_json_array, value_f64, value_str, write_local_json,
};

const DELIVERY_ZONES_CACHE_KEY: &str = "delivery_zones_cache_v1";
const ADDRESS_CANDIDATES_CACHE_KEY: &str = "address_candidates_cache_v1";
const MAX_CANDIDATES_PER_BRANCH: usize = 1000;

fn extract_number_token(input: &str) -> Option<String> {
    let mut token = String::new();
    let mut saw_digit = false;
    for ch in input.chars() {
        if ch.is_ascii_digit() {
            token.push(ch);
            saw_digit = true;
            continue;
        }
        if saw_digit && ch.is_alphabetic() {
            token.push(ch);
            break;
        }
        if saw_digit {
            break;
        }
    }
    let normalized = token.trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_number(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
}

fn parse_lat_lng(value: Option<&Value>) -> Option<(f64, f64)> {
    let candidate = value?;
    if !candidate.is_object() {
        return None;
    }
    let lat = candidate
        .get("lat")
        .and_then(Value::as_f64)
        .or_else(|| candidate.get("latitude").and_then(Value::as_f64));
    let lng = candidate
        .get("lng")
        .and_then(Value::as_f64)
        .or_else(|| candidate.get("longitude").and_then(Value::as_f64));
    match (lat, lng) {
        (Some(lat), Some(lng)) => Some((lat, lng)),
        _ => None,
    }
}

fn point_in_polygon(lat: f64, lng: f64, polygon: &[Value]) -> bool {
    if polygon.len() < 3 {
        return false;
    }

    let mut inside = false;
    let x = lng;
    let y = lat;
    let mut j = polygon.len() - 1;
    for i in 0..polygon.len() {
        let pi = &polygon[i];
        let pj = &polygon[j];

        let xi = value_f64(pi, &["lng", "longitude"]).unwrap_or(0.0);
        let yi = value_f64(pi, &["lat", "latitude"]).unwrap_or(0.0);
        let xj = value_f64(pj, &["lng", "longitude"]).unwrap_or(0.0);
        let yj = value_f64(pj, &["lat", "latitude"]).unwrap_or(0.0);

        let intersects = (yi > y) != (yj > y)
            && x < ((xj - xi) * (y - yi)) / ((yj - yi).max(f64::EPSILON)) + xi;

        if intersects {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn build_fingerprint(address: &str, lat: Option<f64>, lng: Option<f64>) -> String {
    let normalized = address.trim().to_lowercase();
    match (lat, lng) {
        (Some(lat), Some(lng)) => format!("{normalized}|{lat:.5}|{lng:.5}"),
        _ => normalized,
    }
}

#[tauri::command]
pub async fn delivery_zone_cache_refresh(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or_else(|| json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let mut path = "/api/pos/delivery-zones".to_string();
    if !branch_id.is_empty() {
        path.push_str(&format!("?branch_id={branch_id}"));
    }

    let response = crate::admin_fetch(Some(&db), &path, "GET", None).await?;
    let zones = response
        .get("zones")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| response.as_array().cloned())
        .unwrap_or_default();

    let now = Utc::now().to_rfc3339();
    let mut existing = read_local_json(&db, DELIVERY_ZONES_CACHE_KEY).unwrap_or_else(|_| json!({}));
    if !existing.is_object() {
        existing = json!({});
    }

    if existing.get("branches").and_then(Value::as_object).is_none() {
        existing["branches"] = json!({});
    }

    let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
    for zone in zones {
        let bid = value_str(&zone, &["branch_id", "branchId"])
            .or_else(|| (!branch_id.is_empty()).then_some(branch_id.clone()))
            .unwrap_or_default();
        if bid.is_empty() {
            continue;
        }
        grouped.entry(bid).or_default().push(zone);
    }

    if grouped.is_empty() && !branch_id.is_empty() {
        grouped.insert(branch_id.clone(), Vec::new());
    }

    for (bid, branch_zones) in grouped {
        existing["branches"][bid] = json!({
            "updated_at": now,
            "zones": branch_zones,
        });
    }
    existing["updated_at"] = json!(now);

    write_local_json(&db, DELIVERY_ZONES_CACHE_KEY, &existing)?;

    Ok(json!({
        "success": true,
        "updated_at": now,
        "branch_count": existing["branches"].as_object().map(|o| o.len()).unwrap_or(0),
    }))
}

#[tauri::command]
pub async fn delivery_zone_validate_local(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or_else(|| json!({}));
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let address = value_str(&payload, &["address"]).unwrap_or_default();
    let order_amount = value_f64(&payload, &["orderAmount", "order_amount"]).unwrap_or(0.0);

    let coords = parse_lat_lng(payload.get("coordinates"))
        .or_else(|| parse_lat_lng(payload.get("location")))
        .or_else(|| parse_lat_lng(payload.get("address")));
    let input_number = normalize_number(
        value_str(&payload, &["input_street_number"])
            .or_else(|| extract_number_token(&address)),
    );
    let resolved_number = normalize_number(value_str(&payload, &["resolved_street_number"]));
    let house_number_match = match (input_number.as_ref(), resolved_number.as_ref()) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    };

    let address_fingerprint = value_str(&payload, &["address_fingerprint"]).unwrap_or_else(|| {
        build_fingerprint(
            &address,
            coords.map(|c| c.0),
            coords.map(|c| c.1),
        )
    });

    if !house_number_match {
        return Ok(json!({
            "success": true,
            "isValid": false,
            "deliveryAvailable": false,
            "validation_status": "requires_selection",
            "house_number_match": false,
            "requires_override": false,
            "reason": "Street number does not match selected address",
            "suggestedAction": "select_exact_address",
            "address_fingerprint": address_fingerprint,
            "validation_source": "offline_cache",
        }));
    }

    let cache = read_local_json(&db, DELIVERY_ZONES_CACHE_KEY).unwrap_or_else(|_| json!({}));
    let mut zones: Vec<Value> = Vec::new();

    if !branch_id.is_empty() {
        zones = cache
            .get("branches")
            .and_then(|b| b.get(&branch_id))
            .and_then(|b| b.get("zones"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
    }

    if zones.is_empty() {
        if let Some(branches) = cache.get("branches").and_then(Value::as_object) {
            for branch in branches.values() {
                if let Some(branch_zones) = branch.get("zones").and_then(Value::as_array) {
                    zones.extend(branch_zones.iter().cloned());
                }
            }
        }
    }

    if coords.is_none() || zones.is_empty() {
        return Ok(json!({
            "success": true,
            "isValid": false,
            "deliveryAvailable": false,
            "validation_status": "unverified_offline",
            "house_number_match": house_number_match,
            "requires_override": true,
            "reason": "Offline validation data unavailable for this address",
            "suggestedAction": "manual_override",
            "address_fingerprint": address_fingerprint,
            "validation_source": "offline_cache",
        }));
    }

    let (lat, lng) = coords.unwrap_or((0.0, 0.0));
    let mut selected_zone: Option<Value> = None;
    for zone in zones {
        if !zone
            .get("is_active")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            continue;
        }
        let polygon = zone
            .get("polygon_coordinates")
            .and_then(Value::as_array)
            .or_else(|| zone.get("polygon").and_then(Value::as_array))
            .cloned()
            .unwrap_or_default();
        if point_in_polygon(lat, lng, &polygon) {
            selected_zone = Some(zone);
            break;
        }
    }

    if let Some(zone) = selected_zone {
        let min_order = value_f64(&zone, &["minimum_order_amount", "min_order_amount"]).unwrap_or(0.0);
        return Ok(json!({
            "success": true,
            "isValid": true,
            "deliveryAvailable": true,
            "validation_status": "in_zone",
            "house_number_match": true,
            "requires_override": false,
            "address_fingerprint": address_fingerprint,
            "validation_source": "offline_cache",
            "coordinates": { "lat": lat, "lng": lng },
            "selectedZone": {
                "id": value_str(&zone, &["id"]).unwrap_or_default(),
                "name": value_str(&zone, &["name"]).unwrap_or_else(|| "Zone".to_string()),
                "delivery_fee": value_f64(&zone, &["delivery_fee"]).unwrap_or(0.0),
                "minimum_order_amount": min_order,
                "estimated_delivery_time_min": value_f64(&zone, &["estimated_time_min", "estimated_delivery_time_min"]).unwrap_or(30.0),
                "estimated_delivery_time_max": value_f64(&zone, &["estimated_time_max", "estimated_delivery_time_max"]).unwrap_or(45.0),
            },
            "meetsMinimumOrder": order_amount >= min_order,
            "minimumOrderAmount": min_order,
        }));
    }

    Ok(json!({
        "success": true,
        "isValid": false,
        "deliveryAvailable": false,
        "validation_status": "out_of_zone",
        "house_number_match": true,
        "requires_override": true,
        "reason": "Address is outside delivery area",
        "suggestedAction": "pickup_or_override",
        "address_fingerprint": address_fingerprint,
        "validation_source": "offline_cache",
        "coordinates": { "lat": lat, "lng": lng },
    }))
}

fn candidate_key(candidate: &Value) -> String {
    let place_id = value_str(candidate, &["place_id", "id"]).unwrap_or_default();
    if !place_id.is_empty() {
        return place_id;
    }
    let name = value_str(candidate, &["name", "street_address", "address"]).unwrap_or_default();
    let formatted = value_str(candidate, &["formatted_address"]).unwrap_or_default();
    let lat = candidate
        .get("location")
        .and_then(|l| l.get("lat"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let lng = candidate
        .get("location")
        .and_then(|l| l.get("lng"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    format!("{name}|{formatted}|{lat:.5}|{lng:.5}")
}

fn candidate_matches_query(candidate: &Value, query: &str) -> bool {
    let fields = [
        value_str(candidate, &["name"]),
        value_str(candidate, &["formatted_address"]),
        value_str(candidate, &["street_address", "address"]),
        value_str(candidate, &["city"]),
    ];
    fields
        .into_iter()
        .flatten()
        .any(|field| field.to_lowercase().contains(query))
}

#[tauri::command]
pub async fn address_search_local(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let payload = arg0.unwrap_or_else(|| json!({}));
    let query = value_str(&payload, &["query", "q"]).unwrap_or_default();
    let branch_id = value_str(&payload, &["branchId", "branch_id"]).unwrap_or_default();
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, 20) as usize;

    if query.len() < 2 {
        return Ok(json!({ "success": true, "places": [], "source": "offline_cache" }));
    }

    let mut all_candidates = read_local_json_array(&db, ADDRESS_CANDIDATES_CACHE_KEY)?;
    let customer_cache = read_local_json_array(&db, "customer_cache_v1")?;
    for customer in customer_cache {
        let city = value_str(&customer, &["city"]).unwrap_or_default();
        let street = value_str(&customer, &["address", "street_address"]).unwrap_or_default();
        let postal = value_str(&customer, &["postal_code"]).unwrap_or_default();
        if !street.is_empty() {
            let formatted = [street.clone(), city.clone(), postal.clone()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            all_candidates.push(json!({
                "place_id": format!("local-customer-{}", uuid::Uuid::new_v4()),
                "name": street,
                "formatted_address": formatted,
                "city": city,
                "postal_code": postal,
                "source": "offline_cache",
                "verified": true,
                "branch_id": value_str(&customer, &["branch_id"]).unwrap_or_default(),
                "updated_at": Utc::now().to_rfc3339(),
            }));
        }

        if let Some(addresses) = customer.get("addresses").and_then(Value::as_array) {
            for addr in addresses {
                let street = value_str(addr, &["street_address", "street", "address"]).unwrap_or_default();
                if street.is_empty() {
                    continue;
                }
                let city = value_str(addr, &["city"]).unwrap_or_default();
                let postal = value_str(addr, &["postal_code"]).unwrap_or_default();
                let formatted = [street.clone(), city.clone(), postal.clone()]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ");
                all_candidates.push(json!({
                    "place_id": value_str(addr, &["place_id"]).unwrap_or_else(|| format!("local-address-{}", uuid::Uuid::new_v4())),
                    "name": street,
                    "formatted_address": formatted,
                    "city": city,
                    "postal_code": postal,
                    "location": {
                        "lat": value_f64(addr, &["latitude", "lat"]).unwrap_or(0.0),
                        "lng": value_f64(addr, &["longitude", "lng"]).unwrap_or(0.0),
                    },
                    "source": "offline_cache",
                    "verified": true,
                    "branch_id": value_str(addr, &["branch_id"]).unwrap_or_default(),
                    "updated_at": Utc::now().to_rfc3339(),
                }));
            }
        }
    }

    let query_lower = query.to_lowercase();
    let mut seen: HashSet<String> = HashSet::new();
    let mut ranked: Vec<(i32, Value)> = Vec::new();
    for candidate in all_candidates {
        let candidate_branch = value_str(&candidate, &["branch_id"]).unwrap_or_default();
        if !branch_id.is_empty() && !candidate_branch.is_empty() && candidate_branch != branch_id {
            continue;
        }
        if !candidate_matches_query(&candidate, &query_lower) {
            continue;
        }
        let key = candidate_key(&candidate);
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);

        let name = value_str(&candidate, &["name"]).unwrap_or_default().to_lowercase();
        let formatted = value_str(&candidate, &["formatted_address"]).unwrap_or_default().to_lowercase();
        let mut score = 0;
        if name.starts_with(&query_lower) {
            score += 100;
        }
        if formatted.starts_with(&query_lower) {
            score += 80;
        }
        if name.contains(&query_lower) {
            score += 40;
        }
        if formatted.contains(&query_lower) {
            score += 20;
        }
        if candidate
            .get("verified")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            score += 25;
        }
        ranked.push((score, candidate));
    }

    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let places: Vec<Value> = ranked
        .into_iter()
        .take(limit)
        .map(|(_, mut candidate)| {
            if candidate.get("source").is_none() {
                candidate["source"] = json!("offline_cache");
            }
            candidate
        })
        .collect();

    Ok(json!({
        "success": true,
        "places": places,
        "source": "offline_cache",
    }))
}

#[tauri::command]
pub async fn address_upsert_local_candidate(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let mut candidate = arg0.unwrap_or_else(|| json!({}));
    if !candidate.is_object() {
        return Err("Candidate payload must be an object".to_string());
    }

    let now = Utc::now().to_rfc3339();
    let branch_id = value_str(&candidate, &["branch_id", "branchId"]).unwrap_or_default();

    if candidate.get("place_id").is_none() {
        candidate["place_id"] = json!(format!("local-{}", uuid::Uuid::new_v4()));
    }
    candidate["verified"] = json!(true);
    candidate["updated_at"] = json!(now.clone());
    candidate["last_used_at"] = json!(now);
    if !branch_id.is_empty() && candidate.get("branch_id").is_none() {
        candidate["branch_id"] = json!(branch_id.clone());
    }

    let mut candidates = read_local_json_array(&db, ADDRESS_CANDIDATES_CACHE_KEY)?;
    let key = candidate_key(&candidate);
    candidates.retain(|existing| candidate_key(existing) != key);
    candidates.push(candidate.clone());

    let mut by_branch: HashMap<String, Vec<Value>> = HashMap::new();
    for item in candidates {
        let bid = value_str(&item, &["branch_id"]).unwrap_or_default();
        by_branch.entry(bid).or_default().push(item);
    }

    let mut trimmed: Vec<Value> = Vec::new();
    for (_bid, mut branch_candidates) in by_branch {
        branch_candidates.sort_by(|a, b| {
            let a_ts = value_str(a, &["last_used_at", "updated_at"]).unwrap_or_default();
            let b_ts = value_str(b, &["last_used_at", "updated_at"]).unwrap_or_default();
            b_ts.cmp(&a_ts)
        });
        trimmed.extend(branch_candidates.into_iter().take(MAX_CANDIDATES_PER_BRANCH));
    }

    write_local_json(&db, ADDRESS_CANDIDATES_CACHE_KEY, &Value::Array(trimmed.clone()))?;

    Ok(json!({
        "success": true,
        "count": trimmed.len(),
        "candidate": candidate,
    }))
}
