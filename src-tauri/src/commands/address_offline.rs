use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::{db, read_local_json, read_local_json_array, value_f64, value_str, write_local_json};

const DELIVERY_ZONES_CACHE_KEY: &str = "delivery_zones_cache_v1";
const ADDRESS_CANDIDATES_CACHE_KEY: &str = "address_candidates_cache_v1";
const MAX_CANDIDATES_PER_BRANCH: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct HouseNumberParts {
    raw: String,
    digits: String,
    suffix: Option<char>,
}

fn canonicalize_suffix(ch: char) -> char {
    match ch {
        'a' | 'A' | 'α' | 'Α' => 'a',
        _ => ch.to_lowercase().next().unwrap_or(ch),
    }
}

fn parse_number_parts(input: &str) -> Option<HouseNumberParts> {
    let mut digits = String::new();
    let mut raw_suffix: Option<char> = None;
    let mut canonical_suffix: Option<char> = None;
    let mut saw_digit = false;

    for ch in input.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            saw_digit = true;
            continue;
        }
        if saw_digit && raw_suffix.is_none() && ch.is_alphabetic() {
            raw_suffix = Some(ch);
            canonical_suffix = Some(canonicalize_suffix(ch));
            break;
        }
        if saw_digit {
            break;
        }
    }

    if digits.is_empty() {
        return None;
    }

    let raw = match raw_suffix {
        Some(suffix) => format!("{digits}{suffix}"),
        None => digits.clone(),
    };

    Some(HouseNumberParts {
        raw,
        digits,
        suffix: canonical_suffix,
    })
}

fn extract_number_token(input: &str) -> Option<String> {
    parse_number_parts(input).map(|parts| parts.raw)
}

fn normalize_number(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        parse_number_parts(&v).map(|parts| match parts.suffix {
            Some(suffix) => format!("{}{}", parts.digits, suffix),
            None => parts.digits,
        })
    })
}

/// A usable delivery point: finite, inside the WGS84 range and not the exact
/// (0, 0) placeholder. About two thirds of Tomikro's saved addresses have no
/// coordinates; an absent point used to be read as (0, 0) ("Null Island"),
/// checked against the zone and reported as out of zone. An address that was
/// never located must stay *unchecked*, never "outside the delivery area".
fn valid_lat_lng(lat: f64, lng: f64) -> Option<(f64, f64)> {
    let in_range = lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng);
    (in_range && !(lat == 0.0 && lng == 0.0)).then_some((lat, lng))
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
        (Some(lat), Some(lng)) => valid_lat_lng(lat, lng),
        _ => None,
    }
}

/// The stored point of a cached customer or address record, from its
/// `latitude`/`longitude` (or `lat`/`lng`) fields or its `coordinates` object.
fn stored_lat_lng(record: &Value) -> Option<(f64, f64)> {
    let flat = match (
        value_f64(record, &["latitude", "lat"]),
        value_f64(record, &["longitude", "lng"]),
    ) {
        (Some(lat), Some(lng)) => valid_lat_lng(lat, lng),
        _ => None,
    };
    flat.or_else(|| parse_lat_lng(record.get("coordinates")))
}

/// Location + verification for a local address candidate: a candidate is
/// "verified" (offered by the offline search) only with a usable point.
fn candidate_location_fields(point: Option<(f64, f64)>) -> (Option<Value>, bool) {
    match point {
        Some((lat, lng)) => (Some(json!({ "lat": lat, "lng": lng })), true),
        None => (None, false),
    }
}

/// Apply the location rule to a remembered candidate in place: without a
/// usable point it loses `location` and `verified`. Candidates remembered by
/// desktop 1.4.118 can hold `{lat: 0, lng: 0}` with a forced `verified: true`
/// (it re-saved picked offline suggestions that way), and they survive the
/// update in `address_candidates_cache_v1`.
fn normalize_candidate_location(candidate: &mut Value) {
    let (location, verified) = candidate_location_fields(parse_lat_lng(candidate.get("location")));
    let Some(object) = candidate.as_object_mut() else {
        return;
    };
    match location {
        Some(location) => {
            object.insert("location".to_string(), location);
        }
        None => {
            object.remove("location");
        }
    }
    object.insert("verified".to_string(), json!(verified));
}

/// Why the offline zone check could not run. `coordinates_missing` mirrors the
/// server's `/api/pos/delivery-zones/validate` reason (re-picking the address
/// can fix it); `zone_cache_unavailable` means this terminal has no zones for
/// the branch, which re-picking cannot fix.
fn offline_zone_unchecked_reason(has_zones: bool) -> &'static str {
    if has_zones {
        "coordinates_missing"
    } else {
        "zone_cache_unavailable"
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

        let intersects =
            (yi > y) != (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi).max(f64::EPSILON)) + xi;

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

    // THE-306 gating sweep item 3: an org without the delivery_zones module
    // gets the uniform MODULE_REQUIRED denial here — that is "no zones", not
    // an error. Cache the empty set so offline validation agrees with the
    // acquisition boundary.
    let response = match crate::admin_fetch(Some(&db), &path, "GET", None).await {
        Ok(response) => response,
        Err(error) if crate::is_module_required_error(&error) => json!({ "zones": [] }),
        Err(error) => return Err(error),
    };
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

    if existing
        .get("branches")
        .and_then(Value::as_object)
        .is_none()
    {
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
        value_str(&payload, &["input_street_number"]).or_else(|| extract_number_token(&address)),
    );
    let resolved_number = normalize_number(value_str(&payload, &["resolved_street_number"]));
    let house_number_match = match (input_number.as_ref(), resolved_number.as_ref()) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    };

    let address_fingerprint = value_str(&payload, &["address_fingerprint"])
        .unwrap_or_else(|| build_fingerprint(&address, coords.map(|c| c.0), coords.map(|c| c.1)));

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

    // Module audit 2026-09-16: only aggregate every cached branch when the caller did not
    // name one. A branch with no cached zones must stay unverified instead of being
    // validated against another branch's polygons.
    if zones.is_empty() && branch_id.is_empty() {
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
            "reason_code": offline_zone_unchecked_reason(!zones.is_empty()),
            "zone_checked": false,
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
        let min_order =
            value_f64(&zone, &["minimum_order_amount", "min_order_amount"]).unwrap_or(0.0);
        return Ok(json!({
            "success": true,
            "isValid": true,
            "deliveryAvailable": true,
            "validation_status": "in_zone",
            "house_number_match": true,
            "requires_override": false,
            "zone_checked": true,
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
        "zone_checked": true,
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

fn local_address_candidate(
    place_id: String,
    street: String,
    city: String,
    postal: String,
    branch_id: String,
    point: Option<(f64, f64)>,
) -> Value {
    let formatted = [street.clone(), city.clone(), postal.clone()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let (location, verified) = candidate_location_fields(point);
    let mut candidate = json!({
        "place_id": place_id,
        "name": street,
        "formatted_address": formatted,
        "city": city,
        "postal_code": postal,
        "source": "offline_cache",
        "verified": verified,
        "branch_id": branch_id,
        "updated_at": Utc::now().to_rfc3339(),
    });
    if let Some(location) = location {
        candidate["location"] = location;
    }
    candidate
}

/// Offline search candidates from the customer cache. A customer or address
/// without a usable stored point gets no `location` and `verified: false`,
/// so the renderer never offers it as a located suggestion (it used to get
/// `{lat: 0, lng: 0}` and `verified: true`, and the (0, 0) point was then
/// zone-checked as "out of zone" and re-saved as a verified candidate).
fn customer_cache_address_candidates(customer_cache: &[Value]) -> Vec<Value> {
    let mut candidates = Vec::new();
    for customer in customer_cache {
        let street = value_str(customer, &["address", "street_address"]).unwrap_or_default();
        if !street.is_empty() {
            candidates.push(local_address_candidate(
                format!("local-customer-{}", uuid::Uuid::new_v4()),
                street,
                value_str(customer, &["city"]).unwrap_or_default(),
                value_str(customer, &["postal_code"]).unwrap_or_default(),
                value_str(customer, &["branch_id"]).unwrap_or_default(),
                stored_lat_lng(customer),
            ));
        }

        if let Some(addresses) = customer.get("addresses").and_then(Value::as_array) {
            for addr in addresses {
                let street =
                    value_str(addr, &["street_address", "street", "address"]).unwrap_or_default();
                if street.is_empty() {
                    continue;
                }
                candidates.push(local_address_candidate(
                    value_str(addr, &["place_id"])
                        .unwrap_or_else(|| format!("local-address-{}", uuid::Uuid::new_v4())),
                    street,
                    value_str(addr, &["city"]).unwrap_or_default(),
                    value_str(addr, &["postal_code"]).unwrap_or_default(),
                    value_str(addr, &["branch_id"]).unwrap_or_default(),
                    stored_lat_lng(addr),
                ));
            }
        }
    }
    candidates
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

    let remembered = read_local_json_array(&db, ADDRESS_CANDIDATES_CACHE_KEY)?;
    let customer_cache = read_local_json_array(&db, "customer_cache_v1")?;
    let places =
        rank_local_address_candidates(remembered, &customer_cache, &query, &branch_id, limit);

    Ok(json!({
        "success": true,
        "places": places,
        "source": "offline_cache",
    }))
}

/// The offline address search over remembered candidates and the customer
/// cache. Every candidate, remembered or derived, passes the same location
/// rule first, so a remembered `{lat: 0, lng: 0}` is never offered as a
/// located, verified suggestion.
fn rank_local_address_candidates(
    remembered: Vec<Value>,
    customer_cache: &[Value],
    query: &str,
    branch_id: &str,
    limit: usize,
) -> Vec<Value> {
    let mut all_candidates = remembered;
    all_candidates
        .iter_mut()
        .for_each(normalize_candidate_location);
    all_candidates.extend(customer_cache_address_candidates(customer_cache));

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

        let name = value_str(&candidate, &["name"])
            .unwrap_or_default()
            .to_lowercase();
        let formatted = value_str(&candidate, &["formatted_address"])
            .unwrap_or_default()
            .to_lowercase();
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
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, mut candidate)| {
            if candidate.get("source").is_none() {
                candidate["source"] = json!("offline_cache");
            }
            candidate
        })
        .collect()
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
    // Only a candidate with a usable point is remembered as verified; a
    // missing or (0, 0) location is dropped instead of being re-offered as a
    // located address by the offline search.
    normalize_candidate_location(&mut candidate);
    candidate["updated_at"] = json!(now.clone());
    candidate["last_used_at"] = json!(now);
    if !branch_id.is_empty() && candidate.get("branch_id").is_none() {
        candidate["branch_id"] = json!(branch_id.clone());
    }

    let mut candidates = read_local_json_array(&db, ADDRESS_CANDIDATES_CACHE_KEY)?;
    // Rewrite what older versions remembered while the cache is open anyway.
    candidates.iter_mut().for_each(normalize_candidate_location);
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
        trimmed.extend(
            branch_candidates
                .into_iter()
                .take(MAX_CANDIDATES_PER_BRANCH),
        );
    }

    write_local_json(
        &db,
        ADDRESS_CANDIDATES_CACHE_KEY,
        &Value::Array(trimmed.clone()),
    )?;

    Ok(json!({
        "success": true,
        "count": trimmed.len(),
        "candidate": candidate,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        candidate_location_fields, customer_cache_address_candidates, extract_number_token,
        normalize_candidate_location, normalize_number, offline_zone_unchecked_reason,
        parse_lat_lng, rank_local_address_candidates,
    };
    use serde_json::{json, Value};

    #[test]
    fn a_point_that_was_never_located_is_not_a_point() {
        assert_eq!(
            parse_lat_lng(Some(&json!({ "lat": 0.0, "lng": 0.0 }))),
            None
        );
        assert_eq!(parse_lat_lng(Some(&json!({ "lat": 0, "lng": 0 }))), None);
        assert_eq!(
            parse_lat_lng(Some(&json!({ "lat": null, "lng": null }))),
            None
        );
        assert_eq!(
            parse_lat_lng(Some(&json!({ "latitude": 91.0, "longitude": 22.9 }))),
            None
        );
        assert_eq!(
            parse_lat_lng(Some(&json!({ "lat": 40.6, "lng": 181.0 }))),
            None
        );
        assert_eq!(
            parse_lat_lng(Some(&json!({ "lat": "40.6", "lng": "22.9" }))),
            None
        );
        assert_eq!(parse_lat_lng(None), None);
        assert_eq!(
            parse_lat_lng(Some(&json!({ "lat": 40.6264, "lng": 22.9484 }))),
            Some((40.6264, 22.9484))
        );
        // A real point on one axis only is still a real point.
        assert_eq!(
            parse_lat_lng(Some(&json!({ "latitude": 0.0, "longitude": 22.9 }))),
            Some((0.0, 22.9))
        );
    }

    fn candidate_for<'a>(candidates: &'a [Value], street: &str) -> &'a Value {
        candidates
            .iter()
            .find(|candidate| candidate["name"] == street)
            .unwrap_or_else(|| panic!("missing candidate for {street}"))
    }

    #[test]
    fn customer_cache_addresses_without_coordinates_are_not_located_or_verified() {
        let cache = vec![json!({
            "id": "c-1",
            "address": "Customer Level Street 1",
            "city": "Thessaloniki",
            "addresses": [
                { "street_address": "Null Coordinates 2", "latitude": null, "longitude": null },
                { "street_address": "No Coordinates 3", "city": "Thessaloniki" },
                { "street_address": "Null Island 4", "latitude": 0.0, "longitude": 0.0 },
                { "street_address": "Nested Null 5", "coordinates": { "lat": null, "lng": null } },
                { "street_address": "Located 6", "latitude": 40.6264, "longitude": 22.9484 },
                { "street_address": "Nested Located 7", "coordinates": { "lat": 40.61, "lng": 22.96 } }
            ]
        })];

        let candidates = customer_cache_address_candidates(&cache);
        assert_eq!(candidates.len(), 7);
        for street in [
            "Customer Level Street 1",
            "Null Coordinates 2",
            "No Coordinates 3",
            "Null Island 4",
            "Nested Null 5",
        ] {
            let candidate = candidate_for(&candidates, street);
            assert!(
                candidate.get("location").is_none(),
                "{street} must not get a (0, 0) location"
            );
            assert_eq!(
                candidate["verified"], false,
                "{street} must not be verified"
            );
        }
        let located = candidate_for(&candidates, "Located 6");
        assert_eq!(located["verified"], true);
        assert_eq!(
            located["location"],
            json!({ "lat": 40.6264, "lng": 22.9484 })
        );
        let nested = candidate_for(&candidates, "Nested Located 7");
        assert_eq!(nested["verified"], true);
        assert_eq!(nested["location"], json!({ "lat": 40.61, "lng": 22.96 }));
    }

    #[test]
    fn remembered_candidates_are_verified_only_with_a_usable_point() {
        assert_eq!(
            candidate_location_fields(parse_lat_lng(Some(&json!({ "lat": 0, "lng": 0 })))),
            (None, false)
        );
        assert_eq!(
            candidate_location_fields(parse_lat_lng(None)),
            (None, false)
        );
        assert_eq!(
            candidate_location_fields(parse_lat_lng(Some(&json!({ "lat": 40.6, "lng": 22.9 })))),
            (Some(json!({ "lat": 40.6, "lng": 22.9 })), true)
        );
    }

    #[test]
    fn remembered_legacy_candidates_lose_a_null_island_point_and_verification() {
        // What desktop 1.4.118 stored after a cashier picked an uncoordinated
        // offline suggestion (AddCustomerModal re-saved it as verified).
        let mut legacy = json!({
            "place_id": "local-address-synthetic",
            "name": "Synthetic Street 12",
            "city": "Thessaloniki",
            "postal_code": "54622",
            "location": { "lat": 0, "lng": 0 },
            "verified": true,
            "source": "offline_cache"
        });
        normalize_candidate_location(&mut legacy);
        assert!(legacy.get("location").is_none(), "{legacy}");
        assert_eq!(legacy["verified"], false);
        assert_eq!(legacy["name"], "Synthetic Street 12");

        let mut unlocated = json!({ "place_id": "p-2", "name": "No Point 3", "verified": true });
        normalize_candidate_location(&mut unlocated);
        assert!(unlocated.get("location").is_none());
        assert_eq!(unlocated["verified"], false);

        let mut located = json!({
            "place_id": "p-3",
            "name": "Located 4",
            "location": { "lat": 40.6264, "lng": 22.9484 },
            "verified": true
        });
        normalize_candidate_location(&mut located);
        assert_eq!(
            located["location"],
            json!({ "lat": 40.6264, "lng": 22.9484 })
        );
        assert_eq!(located["verified"], true);
    }

    #[test]
    fn offline_search_never_offers_a_remembered_null_island_candidate_as_located() {
        // Review 2026-09-29: the search returned remembered candidates as
        // stored, so a 1.4.118 (0, 0) "verified" entry kept being offered and
        // the renderer's `verified === true` filter kept it.
        let remembered = vec![
            json!({
                "place_id": "local-address-legacy",
                "name": "Synthetic Street 12",
                "formatted_address": "Synthetic Street 12, Thessaloniki, 54622",
                "city": "Thessaloniki",
                "postal_code": "54622",
                "location": { "lat": 0, "lng": 0 },
                "verified": true,
                "branch_id": "branch-1"
            }),
            json!({
                "place_id": "google-located",
                "name": "Synthetic Street 14",
                "formatted_address": "Synthetic Street 14, Thessaloniki",
                "location": { "lat": 40.6264, "lng": 22.9484 },
                "verified": true,
                "branch_id": "branch-1"
            }),
        ];

        let places =
            rank_local_address_candidates(remembered, &[], "synthetic street", "branch-1", 5);
        assert_eq!(places.len(), 2);
        let legacy = places
            .iter()
            .find(|place| place["place_id"] == "local-address-legacy")
            .expect("the legacy candidate is still searchable");
        assert!(legacy.get("location").is_none(), "{legacy}");
        assert_eq!(legacy["verified"], false);
        let located = places
            .iter()
            .find(|place| place["place_id"] == "google-located")
            .expect("located candidate");
        assert_eq!(located["verified"], true);
        assert_eq!(
            located["location"],
            json!({ "lat": 40.6264, "lng": 22.9484 })
        );
        // Only the located candidate survives a `verified === true` filter.
        assert_eq!(
            places
                .iter()
                .filter(|place| place["verified"] == true)
                .count(),
            1
        );
    }

    #[test]
    fn unchecked_offline_zone_says_why() {
        // Zones are cached but the address has no usable point: re-pick it.
        assert_eq!(offline_zone_unchecked_reason(true), "coordinates_missing");
        // No cached zones: re-picking the address cannot help.
        assert_eq!(
            offline_zone_unchecked_reason(false),
            "zone_cache_unavailable"
        );
    }

    fn numbers_match(left: &str, right: &str) -> bool {
        normalize_number(Some(left.to_string())) == normalize_number(Some(right.to_string()))
    }

    #[test]
    fn matches_identical_alphanumeric_house_numbers() {
        assert!(numbers_match("29A", "29A"));
    }

    #[test]
    fn matches_latin_and_greek_alpha_suffixes() {
        assert!(numbers_match("29A", "29Α"));
        assert_eq!(
            normalize_number(Some("29Α".to_string())),
            Some("29a".to_string())
        );
    }

    #[test]
    fn rejects_different_suffixes() {
        assert!(!numbers_match("29A", "29B"));
    }

    #[test]
    fn rejects_different_digits() {
        assert!(!numbers_match("29", "31"));
    }

    #[test]
    fn extracts_alphanumeric_token_from_greek_text() {
        assert_eq!(
            extract_number_token("Μάρκου Μπότσαρη 29Α, Θεσσαλονίκη"),
            Some("29Α".to_string())
        );
    }
}
