use chrono::Utc;
use serde::Deserialize;
use tauri::Emitter;

use crate::{
    db, fetch_supabase_rows, normalize_phone, payload_arg0_as_string, read_local_json_array,
    read_local_setting, storage, sync_queue, value_i64, value_str, write_local_json,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerLookupPayload {
    #[serde(alias = "customer_id", alias = "id")]
    customer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerPhonePayload {
    #[serde(alias = "customerPhone", alias = "mobile", alias = "telephone")]
    phone: String,
    /// Read only this terminal's customer cache: no privacy-tombstone sync,
    /// no remote lookup and no order-history fallback (Caller ID popups).
    #[serde(default)]
    cache_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerSearchPayload {
    #[serde(alias = "q", alias = "term", alias = "search")]
    query: String,
}

#[derive(Debug)]
struct CustomerUpdatePayload {
    customer_id: String,
    updates: serde_json::Value,
    expected_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomerBanPayload {
    #[serde(alias = "customer_id", alias = "id")]
    customer_id: String,
    #[serde(default, alias = "is_banned")]
    is_banned: bool,
}

#[derive(Debug)]
struct CustomerAddressPayload {
    customer_id: String,
    address: serde_json::Value,
}

#[derive(Debug)]
struct CustomerUpdateAddressPayload {
    target_id: String,
    updates: serde_json::Value,
    expected_version: i64,
}

#[derive(Debug)]
struct CustomerDeleteAddressPayload {
    customer_id: String,
    address_id: String,
}

#[derive(Debug)]
struct CustomerResolveConflictPayload {
    conflict_id: String,
    strategy: String,
    data: serde_json::Value,
}

fn parse_lookup_payload(
    arg0: Option<serde_json::Value>,
    err_msg: &str,
) -> Result<CustomerLookupPayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(customer_id)) => serde_json::json!({
            "customerId": customer_id
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let mut parsed: CustomerLookupPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid customer id payload: {e}"))?;
    parsed.customer_id = parsed.customer_id.trim().to_string();
    if parsed.customer_id.is_empty() {
        return Err(err_msg.to_string());
    }
    Ok(parsed)
}

fn parse_phone_payload(arg0: Option<serde_json::Value>) -> Result<CustomerPhonePayload, String> {
    let payload = match arg0 {
        Some(serde_json::Value::String(phone)) => serde_json::json!({
            "phone": phone
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let mut parsed: CustomerPhonePayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid phone payload: {e}"))?;
    parsed.phone = parsed.phone.trim().to_string();
    if parsed.phone.is_empty() {
        return Err("Missing phone".into());
    }
    Ok(parsed)
}

fn parse_search_payload(arg0: Option<serde_json::Value>) -> CustomerSearchPayload {
    let payload = match arg0 {
        Some(serde_json::Value::String(query)) => serde_json::json!({
            "query": query
        }),
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(v) => serde_json::json!({
            "query": v.to_string()
        }),
        None => serde_json::json!({
            "query": ""
        }),
    };
    let mut parsed: CustomerSearchPayload =
        serde_json::from_value(payload).unwrap_or_else(|_| CustomerSearchPayload {
            query: String::new(),
        });
    parsed.query = parsed.query.trim().to_string();
    parsed
}

fn parse_customer_update_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
) -> Result<CustomerUpdatePayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(customer_id)) => serde_json::json!({
            "customerId": customer_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let customer_id =
        payload_arg0_as_string(Some(base.clone()), &["customerId", "customer_id", "id"])
            .ok_or("Missing customerId")?;

    let updates = arg1
        .or_else(|| base.get("updates").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    if !updates.is_object() {
        return Err("updates must be an object".into());
    }

    let expected_version = match arg2 {
        Some(serde_json::Value::Number(num)) => num.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(num)) => num.parse::<i64>().unwrap_or(0),
        Some(serde_json::Value::Object(obj)) => value_i64(
            &serde_json::Value::Object(obj),
            &["currentVersion", "current_version", "version"],
        )
        .unwrap_or(0),
        Some(_) => 0,
        None => value_i64(&base, &["currentVersion", "current_version", "version"]).unwrap_or(0),
    };

    Ok(CustomerUpdatePayload {
        customer_id,
        updates,
        expected_version,
    })
}

fn parse_customer_ban_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<CustomerBanPayload, String> {
    let payload = match (arg0, arg1) {
        (
            Some(serde_json::Value::String(customer_id)),
            Some(serde_json::Value::Bool(is_banned)),
        ) => {
            serde_json::json!({
                "customerId": customer_id,
                "isBanned": is_banned
            })
        }
        (Some(serde_json::Value::Object(mut obj)), Some(serde_json::Value::Bool(is_banned))) => {
            obj.insert("isBanned".to_string(), serde_json::Value::Bool(is_banned));
            serde_json::Value::Object(obj)
        }
        (Some(v), None) => v,
        (Some(v), Some(_)) => v,
        (None, Some(v)) => v,
        (None, None) => serde_json::json!({}),
    };

    let mut parsed: CustomerBanPayload = serde_json::from_value(payload)
        .map_err(|e| format!("Invalid customer ban payload: {e}"))?;
    parsed.customer_id = parsed.customer_id.trim().to_string();
    if parsed.customer_id.is_empty() {
        return Err("Missing customerId".into());
    }
    Ok(parsed)
}

fn parse_customer_address_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<CustomerAddressPayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(customer_id)) => serde_json::json!({
            "customerId": customer_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };

    let customer_id =
        payload_arg0_as_string(Some(base.clone()), &["customerId", "customer_id", "id"])
            .ok_or("Missing customerId")?;
    let address = arg1
        .or_else(|| base.get("address").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    if !address.is_object() {
        return Err("address must be an object".into());
    }

    Ok(CustomerAddressPayload {
        customer_id,
        address,
    })
}

fn parse_customer_update_address_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
) -> Result<CustomerUpdateAddressPayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(target_id)) => serde_json::json!({
            "targetId": target_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let target_id = payload_arg0_as_string(
        Some(base.clone()),
        &[
            "targetId",
            "addressId",
            "address_id",
            "customerId",
            "customer_id",
            "id",
        ],
    )
    .ok_or("Missing customerId/addressId")?;

    let updates = arg1
        .or_else(|| base.get("updates").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    if !updates.is_object() {
        return Err("updates must be an object".into());
    }

    let expected_version = match arg2 {
        Some(serde_json::Value::Number(num)) => num.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(num)) => num.parse::<i64>().unwrap_or(0),
        Some(serde_json::Value::Object(obj)) => value_i64(
            &serde_json::Value::Object(obj),
            &["expectedVersion", "expected_version", "version"],
        )
        .unwrap_or(0),
        Some(_) => 0,
        None => value_i64(&base, &["expectedVersion", "expected_version", "version"]).unwrap_or(0),
    };

    Ok(CustomerUpdateAddressPayload {
        target_id,
        updates,
        expected_version,
    })
}

fn parse_customer_delete_address_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
) -> Result<CustomerDeleteAddressPayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(customer_id)) => serde_json::json!({
            "customerId": customer_id
        }),
        Some(value) => value,
        None => serde_json::json!({}),
    };
    let customer_id = payload_arg0_as_string(Some(base.clone()), &["customerId", "customer_id"])
        .ok_or("Missing customerId")?;
    let address_id = arg1
        .and_then(|value| value.as_str().map(str::trim).map(str::to_string))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            payload_arg0_as_string(
                Some(base),
                &["addressId", "address_id", "targetId", "target_id"],
            )
        })
        .ok_or("Missing addressId")?;

    Ok(CustomerDeleteAddressPayload {
        customer_id,
        address_id,
    })
}

fn parse_customer_resolve_conflict_payload(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
) -> Result<CustomerResolveConflictPayload, String> {
    let base = match arg0 {
        Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj),
        Some(serde_json::Value::String(conflict_id)) => serde_json::json!({
            "conflictId": conflict_id
        }),
        Some(v) => v,
        None => serde_json::json!({}),
    };
    let conflict_id =
        payload_arg0_as_string(Some(base.clone()), &["conflictId", "conflict_id", "id"])
            .ok_or("Missing conflictId")?;
    let strategy = arg1
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .or_else(|| value_str(&base, &["strategy"]))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "server_wins".to_string());
    let data = arg2
        .or_else(|| base.get("data").cloned())
        .unwrap_or_else(|| serde_json::json!({}));

    Ok(CustomerResolveConflictPayload {
        conflict_id,
        strategy,
        data,
    })
}

fn trim_to_option(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn value_f64_any(source: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(value) = source.get(*key) {
            if let Some(number) = value.as_f64() {
                return Some(number);
            }
            if let Some(number) = value.as_i64() {
                return Some(number as f64);
            }
            if let Some(raw) = value.as_str() {
                if let Ok(parsed) = raw.trim().parse::<f64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn value_bool_any(source: &serde_json::Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(value) = source.get(*key) {
            if let Some(flag) = value.as_bool() {
                return Some(flag);
            }
            if let Some(number) = value.as_i64() {
                return Some(number != 0);
            }
            if let Some(raw) = value.as_str() {
                let normalized = raw.trim().to_ascii_lowercase();
                if normalized == "true" || normalized == "1" || normalized == "yes" {
                    return Some(true);
                }
                if normalized == "false" || normalized == "0" || normalized == "no" {
                    return Some(false);
                }
            }
        }
    }
    None
}

fn first_address_entry(source: &serde_json::Value) -> Option<&serde_json::Value> {
    source
        .get("addresses")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
}

fn string_field(source: &serde_json::Value, keys: &[&str]) -> Option<String> {
    trim_to_option(value_str(source, keys))
}

fn customer_body_field(
    source: &serde_json::Value,
    top_keys: &[&str],
    address_keys: &[&str],
) -> Option<String> {
    string_field(source, top_keys).or_else(|| {
        first_address_entry(source).and_then(|address| string_field(address, address_keys))
    })
}

fn build_remote_customer_create_body(source: &serde_json::Value) -> serde_json::Value {
    let mut body = serde_json::Map::new();

    if let Some(name) = customer_body_field(source, &["name", "fullName"], &["name", "fullName"]) {
        body.insert("name".to_string(), serde_json::json!(name));
    }
    if let Some(phone) = customer_body_field(
        source,
        &["phone", "customerPhone", "mobile", "telephone"],
        &["phone"],
    ) {
        body.insert("phone".to_string(), serde_json::json!(phone));
    }
    if let Some(phone_country_code) =
        string_field(source, &["phone_country_code", "phoneCountryCode"])
    {
        body.insert(
            "phone_country_code".to_string(),
            serde_json::json!(phone_country_code.to_uppercase()),
        );
    }
    if let Some(email) = customer_body_field(source, &["email", "customerEmail"], &["email"]) {
        body.insert("email".to_string(), serde_json::json!(email));
    }
    if let Some(address) = customer_body_field(
        source,
        &["address", "street", "street_address", "deliveryAddress"],
        &["address", "street", "street_address"],
    ) {
        body.insert("address".to_string(), serde_json::json!(address));
    }
    if let Some(city) = customer_body_field(source, &["city", "deliveryCity"], &["city"]) {
        body.insert("city".to_string(), serde_json::json!(city));
    }
    if let Some(postal_code) = customer_body_field(
        source,
        &["postal_code", "postalCode", "deliveryPostalCode"],
        &["postal_code", "postalCode"],
    ) {
        body.insert("postal_code".to_string(), serde_json::json!(postal_code));
    }
    if let Some(floor_number) = customer_body_field(
        source,
        &["floor_number", "floorNumber", "deliveryFloor"],
        &["floor_number", "floorNumber", "floor"],
    ) {
        body.insert("floor_number".to_string(), serde_json::json!(floor_number));
    }
    if let Some(notes) = customer_body_field(
        source,
        &["notes", "delivery_notes"],
        &["notes", "delivery_notes"],
    ) {
        body.insert("notes".to_string(), serde_json::json!(notes));
    }
    if let Some(name_on_ringer) = customer_body_field(
        source,
        &["name_on_ringer", "nameOnRinger"],
        &["name_on_ringer", "nameOnRinger"],
    ) {
        body.insert(
            "name_on_ringer".to_string(),
            serde_json::json!(name_on_ringer),
        );
    }
    if let Some(branch_id) = string_field(source, &["branch_id", "branchId"]) {
        body.insert("branch_id".to_string(), serde_json::json!(branch_id));
    }

    if let Some(coords) = source.get("coordinates") {
        body.insert("coordinates".to_string(), coords.clone());
    }
    if let Some(latitude) = value_f64_any(source, &["latitude"]) {
        body.insert("latitude".to_string(), serde_json::json!(latitude));
    }
    if let Some(longitude) = value_f64_any(source, &["longitude"]) {
        body.insert("longitude".to_string(), serde_json::json!(longitude));
    }
    if let Some(place_id) = string_field(source, &["place_id", "google_place_id"]) {
        body.insert("place_id".to_string(), serde_json::json!(place_id));
    }
    if let Some(formatted_address) = string_field(source, &["formatted_address"]) {
        body.insert(
            "formatted_address".to_string(),
            serde_json::json!(formatted_address),
        );
    }
    if let Some(resolved_street_number) = string_field(source, &["resolved_street_number"]) {
        body.insert(
            "resolved_street_number".to_string(),
            serde_json::json!(resolved_street_number),
        );
    }
    if let Some(address_fingerprint) = string_field(source, &["address_fingerprint"]) {
        body.insert(
            "address_fingerprint".to_string(),
            serde_json::json!(address_fingerprint),
        );
    }

    serde_json::Value::Object(body)
}

fn build_remote_customer_update_body(source: &serde_json::Value) -> serde_json::Value {
    let mut body = serde_json::Map::new();

    if let Some(name) = string_field(source, &["name", "fullName"]) {
        body.insert("name".to_string(), serde_json::json!(name));
    }
    let phone_keys = ["phone", "customerPhone", "mobile", "telephone"];
    if let Some(phone_value) = phone_keys.iter().find_map(|key| source.get(*key)) {
        body.insert(
            "phone".to_string(),
            phone_value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
        );
    }
    let country_keys = ["phone_country_code", "phoneCountryCode"];
    if let Some(country_value) = country_keys.iter().find_map(|key| source.get(*key)) {
        body.insert(
            "phone_country_code".to_string(),
            country_value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| serde_json::Value::String(value.to_uppercase()))
                .unwrap_or(serde_json::Value::Null),
        );
    }
    if source.get("email").is_some() {
        let email = string_field(source, &["email"]);
        body.insert(
            "email".to_string(),
            email
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    if source.get("notes").is_some() {
        let notes = string_field(source, &["notes"]);
        body.insert(
            "notes".to_string(),
            notes
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(loyalty_points) = value_i64(source, &["loyalty_points", "loyaltyPoints"]) {
        body.insert(
            "loyalty_points".to_string(),
            serde_json::json!(loyalty_points),
        );
    }
    if let Some(is_active) = value_bool_any(source, &["is_active", "isActive"]) {
        body.insert("is_active".to_string(), serde_json::json!(is_active));
    }

    serde_json::Value::Object(body)
}

fn build_remote_address_body(source: &serde_json::Value) -> serde_json::Value {
    let mut body = serde_json::Map::new();

    if let Some(street) = string_field(source, &["street_address", "street", "address"]) {
        body.insert("street_address".to_string(), serde_json::json!(street));
    }
    if let Some(city) = string_field(source, &["city"]) {
        body.insert("city".to_string(), serde_json::json!(city));
    }
    if let Some(postal_code) = string_field(source, &["postal_code", "postalCode"]) {
        body.insert("postal_code".to_string(), serde_json::json!(postal_code));
    }
    if let Some(floor_number) = string_field(source, &["floor_number", "floorNumber", "floor"]) {
        body.insert("floor_number".to_string(), serde_json::json!(floor_number));
    }
    if let Some(notes) = string_field(source, &["notes", "delivery_notes"]) {
        body.insert("notes".to_string(), serde_json::json!(notes));
    }
    if let Some(name_on_ringer) = string_field(source, &["name_on_ringer", "nameOnRinger"]) {
        body.insert(
            "name_on_ringer".to_string(),
            serde_json::json!(name_on_ringer),
        );
    }
    if let Some(address_type) = string_field(source, &["address_type", "addressType"]) {
        body.insert("address_type".to_string(), serde_json::json!(address_type));
    }
    if let Some(is_default) = value_bool_any(source, &["is_default", "isDefault"]) {
        body.insert("is_default".to_string(), serde_json::json!(is_default));
    }
    if let Some(coords) = source.get("coordinates") {
        body.insert("coordinates".to_string(), coords.clone());
    }
    // PATCH distinguishes an omitted axis from an explicit location clear.
    // Keep nulls in the captured body so an offline replay has the same intent.
    for key in ["latitude", "longitude"] {
        if source.get(key).is_some_and(serde_json::Value::is_null) {
            body.insert(key.to_string(), serde_json::Value::Null);
        }
    }
    if let Some(latitude) = value_f64_any(source, &["latitude"]) {
        body.insert("latitude".to_string(), serde_json::json!(latitude));
    }
    if let Some(longitude) = value_f64_any(source, &["longitude"]) {
        body.insert("longitude".to_string(), serde_json::json!(longitude));
    }
    if let Some(place_id) = string_field(source, &ADDRESS_PLACE_KEYS) {
        body.insert("place_id".to_string(), serde_json::json!(place_id));
    } else if address_edit_clears_place(source) {
        // Like the point: an explicit null clears the stored place, so the
        // cache merge and the captured PATCH drop the old one.
        body.insert("place_id".to_string(), serde_json::Value::Null);
    }
    if let Some(formatted_address) = string_field(source, &["formatted_address"]) {
        body.insert(
            "formatted_address".to_string(),
            serde_json::json!(formatted_address),
        );
    }
    if let Some(resolved_street_number) = string_field(source, &["resolved_street_number"]) {
        body.insert(
            "resolved_street_number".to_string(),
            serde_json::json!(resolved_street_number),
        );
    }
    if let Some(address_fingerprint) = string_field(source, &["address_fingerprint"]) {
        body.insert(
            "address_fingerprint".to_string(),
            serde_json::json!(address_fingerprint),
        );
    }

    serde_json::Value::Object(body)
}

/// Keys of an address edit that carry its provider place.
const ADDRESS_PLACE_KEYS: [&str; 2] = ["place_id", "google_place_id"];

/// Whether an address edit clears its place: an explicit null and no place id
/// under the other key (desktop 1.4.124, fix 6: a text edit saved offline
/// sends `place_id: null` with its cleared point and must not keep the old
/// place). An omitted key leaves the place as it is.
fn address_edit_clears_place(edit: &serde_json::Value) -> bool {
    string_field(edit, &ADDRESS_PLACE_KEYS).is_none()
        && ADDRESS_PLACE_KEYS
            .iter()
            .any(|key| edit.get(*key).is_some_and(serde_json::Value::is_null))
}

fn normalize_customer_for_cache(mut customer: serde_json::Value) -> serde_json::Value {
    let now = Utc::now().to_rfc3339();
    if let Some(obj) = customer.as_object_mut() {
        if !obj.contains_key("id") {
            let generated = format!("cust-{}", uuid::Uuid::new_v4());
            obj.insert("id".to_string(), serde_json::json!(generated));
        }
        if !obj.contains_key("version") {
            obj.insert("version".to_string(), serde_json::json!(1));
        }

        let created_at = obj
            .get("createdAt")
            .cloned()
            .or_else(|| obj.get("created_at").cloned())
            .unwrap_or_else(|| serde_json::json!(now.clone()));
        let updated_at = obj
            .get("updatedAt")
            .cloned()
            .or_else(|| obj.get("updated_at").cloned())
            .unwrap_or_else(|| serde_json::json!(now.clone()));
        obj.insert("createdAt".to_string(), created_at);
        obj.insert("updatedAt".to_string(), updated_at);
        let addresses = obj
            .get("addresses")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(normalize_address_for_cache)
            .collect::<Vec<_>>();
        obj.insert("addresses".to_string(), serde_json::Value::Array(addresses));
    }
    customer
}

fn customer_has_addresses(customer: &serde_json::Value) -> bool {
    customer
        .get("addresses")
        .and_then(|value| value.as_array())
        .map(|addresses| !addresses.is_empty())
        .unwrap_or(false)
}

fn upsert_customer_cache_entry(
    cache: &mut Vec<serde_json::Value>,
    customer: serde_json::Value,
) -> serde_json::Value {
    let mut normalized = normalize_customer_for_cache(customer);
    let customer_id = value_str(&normalized, &["id", "customerId"]).unwrap_or_default();
    if customer_id.is_empty() {
        return normalized;
    }

    let existing = cache.iter().find(|entry| {
        value_str(entry, &["id", "customerId"])
            .map(|id| id == customer_id)
            .unwrap_or(false)
    });

    if let (Some(existing_entry), Some(obj)) = (existing, normalized.as_object_mut()) {
        if !customer_has_addresses(&serde_json::Value::Object(obj.clone())) {
            if let Some(addresses) = existing_entry.get("addresses") {
                obj.insert("addresses".to_string(), addresses.clone());
            }
        }
        if !obj.contains_key("selected_address_id") {
            if let Some(selected_address_id) = value_str(
                existing_entry,
                &["selected_address_id", "selectedAddressId"],
            ) {
                obj.insert(
                    "selected_address_id".to_string(),
                    serde_json::json!(selected_address_id),
                );
            }
        }
        if !obj.contains_key(sync_queue::LOCAL_CUSTOMER_ALIAS_FIELD) {
            if let Some(local_id) =
                value_str(existing_entry, &[sync_queue::LOCAL_CUSTOMER_ALIAS_FIELD])
            {
                obj.insert(
                    sync_queue::LOCAL_CUSTOMER_ALIAS_FIELD.to_string(),
                    serde_json::json!(local_id),
                );
            }
        }
    }

    cache.retain(|entry| {
        value_str(entry, &["id", "customerId"])
            .map(|id| id != customer_id)
            .unwrap_or(true)
    });
    cache.push(normalized.clone());
    normalized
}

fn normalize_address_for_cache(mut address: serde_json::Value) -> serde_json::Value {
    let now = Utc::now().to_rfc3339();
    if let Some(obj) = address.as_object_mut() {
        if !obj.contains_key("id") {
            let generated = format!("addr-{}", uuid::Uuid::new_v4());
            obj.insert("id".to_string(), serde_json::json!(generated));
        }
        if !obj.contains_key("version") {
            obj.insert("version".to_string(), serde_json::json!(1));
        }

        let created_at = obj
            .get("createdAt")
            .cloned()
            .or_else(|| obj.get("created_at").cloned())
            .unwrap_or_else(|| serde_json::json!(now.clone()));
        let updated_at = obj
            .get("updatedAt")
            .cloned()
            .or_else(|| obj.get("updated_at").cloned())
            .unwrap_or_else(|| serde_json::json!(now.clone()));
        obj.insert("createdAt".to_string(), created_at);
        obj.insert("updatedAt".to_string(), updated_at);

        if !obj.contains_key("street") {
            if let Some(street) =
                string_field(&serde_json::Value::Object(obj.clone()), &["street_address"])
            {
                obj.insert("street".to_string(), serde_json::json!(street));
            }
        }
        if !obj.contains_key("street_address") {
            if let Some(street) = string_field(&serde_json::Value::Object(obj.clone()), &["street"])
            {
                obj.insert("street_address".to_string(), serde_json::json!(street));
            }
        }

        let notes = obj
            .get("notes")
            .cloned()
            .or_else(|| obj.get("delivery_notes").cloned())
            .unwrap_or(serde_json::Value::Null);
        obj.insert("notes".to_string(), notes.clone());
        obj.insert("delivery_notes".to_string(), notes);
    }
    address
}

fn percent_encode_component(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for b in input.bytes() {
        let is_unreserved =
            b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~';
        if is_unreserved {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    encoded
}

fn is_not_found_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("http 404")
        || lower.contains("status 404")
        || lower.contains("customer not found")
        || lower.contains("address not found")
}

fn resolve_customer_queue_organization_id(db: &db::DbState) -> String {
    storage::get_credential("organization_id")
        .or_else(|| read_local_setting(db, "terminal", "organization_id"))
        .unwrap_or_else(|| "pending-org".to_string())
}

fn enqueue_customer_sync_item(
    db: &db::DbState,
    table_name: &str,
    record_id: &str,
    operation: &str,
    payload: &serde_json::Value,
    version: i64,
) -> Result<String, String> {
    let organization_id = resolve_customer_queue_organization_id(db);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    sync_queue::enqueue(
        &conn,
        &sync_queue::EnqueueInput {
            table_name: table_name.to_string(),
            record_id: record_id.to_string(),
            operation: operation.to_string(),
            data: payload.to_string(),
            organization_id,
            priority: Some(0),
            module_type: Some("customers".to_string()),
            conflict_strategy: Some("manual".to_string()),
            version: Some(version.max(1)),
        },
    )
}

fn build_local_customer_from_source(source: &serde_json::Value) -> serde_json::Value {
    let body = build_remote_customer_create_body(source);
    let customer_id = value_str(source, &["id", "customerId"])
        .unwrap_or_else(|| format!("cust-{}", uuid::Uuid::new_v4()));
    let now = Utc::now().to_rfc3339();

    let mut customer = normalize_customer_for_cache(serde_json::json!({
        "id": customer_id,
        "name": value_str(&body, &["name"]).unwrap_or_else(|| "Customer".to_string()),
        "phone": value_str(&body, &["phone"]).unwrap_or_default(),
        "phone_country_code": body.get("phone_country_code").cloned().unwrap_or(serde_json::Value::Null),
        "email": body.get("email").cloned().unwrap_or(serde_json::Value::Null),
        "branch_id": body.get("branch_id").cloned().unwrap_or(serde_json::Value::Null),
        "createdAt": now,
        "updatedAt": now,
    }));

    let address_body = build_remote_address_body(source);
    if address_body
        .as_object()
        .map(|obj| !obj.is_empty())
        .unwrap_or(false)
    {
        let address = normalize_address_for_cache(address_body);
        if let Some(obj) = customer.as_object_mut() {
            obj.insert("addresses".to_string(), serde_json::json!([address]));
        }
    }

    customer
}

/// How a failed customer write to the admin API is handled on this terminal.
///
/// Incident 2026-09-28 (Tomikro, desktop 1.4.118): symptom — the Z report
/// refused with "Cannot close day: pre-Z-report sync failed:
/// PARITY_SYNC_PARTIAL" after a cashier saved a customer whose 11-digit phone
/// the server rejected. Root cause — `customer_create` treated *every* remote
/// failure as "offline": it cached a local `cust-` customer, queued a parity
/// INSERT and reported success, so a deterministic 400 INVALID_PHONE became a
/// queue row that failed on every replay. Only failures a later replay can
/// outlive are deferred now; a coded application rejection is returned to the
/// form instead (regressions: `dto_tests::customer_create_*`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum CustomerRemoteFailure {
    /// Keep the offline-first path: cache locally, queue a parity row.
    Deferrable,
    /// Deterministic application rejection: a replay would fail the same way.
    Rejected { status: Option<u16>, code: String },
}

/// Upper bound for a server machine code echoed back to the renderer.
const CUSTOMER_REJECTION_CODE_MAX_LEN: usize = 64;

/// A server `code` is echoed only when it is a bounded machine identifier.
fn bounded_customer_rejection_code(code: &str) -> Option<String> {
    let code = code.trim();
    if code.is_empty()
        || code.len() > CUSTOMER_REJECTION_CODE_MAX_LEN
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return None;
    }
    Some(code.to_ascii_uppercase())
}

/// Defer: transport and local failures, 408, 429, every 5xx, 401/403 (soft
/// terminal-auth states the replay already rides out) and any 4xx whose body
/// is not the admin application's JSON envelope (Vercel platform pages).
/// Reject: every other 4xx that carries the application's JSON error body —
/// INVALID_PHONE, COUNTRY_CONTEXT_REQUIRED, INVALID_COORDINATES, DUPLICATE,
/// VERSION_MISMATCH, NOT_FOUND, missing-field and schema validation errors.
fn classify_customer_remote_failure(error: &crate::api::AdminFetchError) -> CustomerRemoteFailure {
    if error.is_transport_failure() {
        return CustomerRemoteFailure::Deferrable;
    }
    let Some(status) = error.status() else {
        return CustomerRemoteFailure::Deferrable;
    };
    match status {
        401 | 403 | 408 | 429 => CustomerRemoteFailure::Deferrable,
        400..=499 if error.has_app_error_body() => {
            let code = error
                .code()
                .and_then(bounded_customer_rejection_code)
                .unwrap_or_else(|| {
                    if status == 404 {
                        "NOT_FOUND".to_string()
                    } else {
                        format!("HTTP_{status}")
                    }
                });
            CustomerRemoteFailure::Rejected {
                status: Some(status),
                code,
            }
        }
        _ => CustomerRemoteFailure::Deferrable,
    }
}

/// Renderer envelope for a rejected customer write. It carries only bounded
/// codes: the server body may echo the customer record (a 409
/// VERSION_MISMATCH does), so its display text never reaches the form.
fn customer_rejection_response(status: Option<u16>, code: &str) -> serde_json::Value {
    let conflict = status == Some(409) && code == "VERSION_MISMATCH";
    let mut response = serde_json::json!({
        "success": false,
        "code": code,
        "errorCode": code,
        "status": status,
        "error": code,
    });
    if conflict {
        response["conflict"] = serde_json::json!(true);
    }
    response
}

/// `warning` of a customer write saved on this terminal and queued. A stable
/// code: the remote error text can echo what the cashier typed (a 5xx
/// constraint message carries the phone), so it never reaches the renderer.
const CUSTOMER_SAVED_OFFLINE: &str = "CUSTOMER_SAVED_OFFLINE";
/// `warning` of an address write saved on this terminal and queued.
const CUSTOMER_ADDRESS_SAVED_OFFLINE: &str = "CUSTOMER_ADDRESS_SAVED_OFFLINE";
/// Refusal: the customer exists only on this terminal and nothing queued
/// will create it on the office (no queued INSERT, no synced record).
const CUSTOMER_NOT_SYNCED: &str = "CUSTOMER_NOT_SYNCED";
/// Refusal: the customer's (or address's) INSERT is being sent right now.
/// Retrying a moment later reaches the office record.
const CUSTOMER_SYNC_IN_PROGRESS: &str = "CUSTOMER_SYNC_IN_PROGRESS";
/// Refusal: an edit of an office customer without a known record version
/// (the office answers a PATCH without `expected_version` with a 400).
const VERSION_REQUIRED: &str = "VERSION_REQUIRED";

/// Ids this terminal mints for customers the office has not acknowledged
/// (`build_local_customer_from_source`, `normalize_customer_for_cache`, the
/// orders-history fallback of `customer_lookup_by_phone`).
fn is_local_customer_id(customer_id: &str) -> bool {
    customer_id.trim().starts_with("cust-")
}

/// The cached office record that replaced the local customer `local_id` when
/// its INSERT synced (`sync_queue::LOCAL_CUSTOMER_ALIAS_FIELD`).
fn cached_synced_alias<'a>(
    cache: &'a [serde_json::Value],
    local_id: &str,
) -> Option<&'a serde_json::Value> {
    cache.iter().find(|entry| {
        value_str(entry, &[sync_queue::LOCAL_CUSTOMER_ALIAS_FIELD])
            .is_some_and(|alias| alias == local_id)
            && value_str(entry, &["id", "customerId"]).is_some_and(|id| id != local_id)
    })
}

fn cached_customer_version(cache: &[serde_json::Value], customer_id: &str) -> Option<i64> {
    cache
        .iter()
        .find(|entry| value_str(entry, &["id", "customerId"]).is_some_and(|id| id == customer_id))
        .and_then(|entry| value_i64(entry, &["version"]))
        .filter(|version| *version > 0)
}

/// Split a failed office call of a customer-directory write the same way as
/// customer create/update: `Some` is the structured rejection to show
/// (nothing cached or queued), `None` keeps the offline-first path.
fn customer_write_rejection(
    error: &crate::api::AdminFetchError,
    write: &'static str,
) -> Option<serde_json::Value> {
    match classify_customer_remote_failure(error) {
        CustomerRemoteFailure::Rejected { status, code } => {
            tracing::warn!(
                code = %code,
                status = ?status,
                write,
                "Customer-directory write rejected by the admin API; nothing cached or queued"
            );
            Some(customer_rejection_response(status, &code))
        }
        CustomerRemoteFailure::Deferrable => {
            tracing::info!(
                status = ?error.status(),
                transport = error.is_transport_failure(),
                write,
                "Customer-directory write saved on this terminal; queued for sync"
            );
            None
        }
    }
}

async fn sync_customer_create_remote(
    db: &db::DbState,
    body: serde_json::Value,
) -> Result<serde_json::Value, crate::api::AdminFetchError> {
    let response =
        crate::admin_fetch_detailed(Some(db), "/api/pos/customers", "POST", Some(body)).await?;
    let remote_customer = response
        .get("data")
        .cloned()
        .or_else(|| response.get("customer").cloned())
        .ok_or("Customer API response missing data")?;
    Ok(remote_customer)
}

async fn sync_customer_update_remote(
    db: &db::DbState,
    customer_id: &str,
    updates: &serde_json::Value,
    expected_version: i64,
) -> Result<serde_json::Value, crate::api::AdminFetchError> {
    let mut body = build_remote_customer_update_body(updates);
    if body.as_object().map(|obj| obj.is_empty()).unwrap_or(true) {
        return Err("Missing customer updates".into());
    }

    if expected_version > 0 {
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "expected_version".to_string(),
                serde_json::json!(expected_version),
            );
        }
    }

    let path = format!("/api/pos/customers/{customer_id}");
    let response = crate::admin_fetch_detailed(Some(db), &path, "PATCH", Some(body)).await?;
    let remote_customer = response
        .get("customer")
        .cloned()
        .or_else(|| response.get("data").cloned())
        .ok_or("Customer API response missing customer")?;
    Ok(remote_customer)
}

fn extract_customers_from_pos_response(response: &serde_json::Value) -> Vec<serde_json::Value> {
    if response
        .get("success")
        .and_then(|value| value.as_bool())
        .is_some_and(|success| !success)
        && is_not_found_error(
            response
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or_default(),
        )
    {
        return Vec::new();
    }

    if let Some(customers) = response.get("customers").and_then(|value| value.as_array()) {
        return customers.clone();
    }
    if let Some(customers) = response
        .pointer("/data/customers")
        .and_then(|value| value.as_array())
    {
        return customers.clone();
    }
    if let Some(customer) = response.get("customer").cloned() {
        if !customer.is_null() {
            return vec![customer];
        }
    }
    if let Some(customer) = response.pointer("/data/customer").cloned() {
        if !customer.is_null() {
            return vec![customer];
        }
    }
    Vec::new()
}

fn extract_privacy_tombstones(response: &serde_json::Value) -> Vec<serde_json::Value> {
    response
        .get("privacy_tombstones")
        .or_else(|| response.get("tombstones"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
}

fn customer_response_has_next_page(response: &serde_json::Value) -> bool {
    if let Some(has_next) = response
        .pointer("/pagination/hasNextPage")
        .and_then(|value| value.as_bool())
    {
        return has_next;
    }

    let page = response
        .pointer("/pagination/page")
        .and_then(|value| value.as_u64())
        .unwrap_or(1);
    let total_pages = response
        .pointer("/pagination/totalPages")
        .and_then(|value| value.as_u64())
        .unwrap_or(1);
    page < total_pages
}

fn sqlite_table_columns(
    conn: &rusqlite::Connection,
    table: &str,
) -> std::collections::HashSet<String> {
    let mut columns = std::collections::HashSet::new();
    let pragma = format!("PRAGMA table_info({table})");
    if let Ok(mut statement) = conn.prepare(&pragma) {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(1)) {
            for column in rows.flatten() {
                columns.insert(column);
            }
        }
    }
    columns
}

fn scrub_order_customer_snapshot(
    db: &db::DbState,
    target_id: &str,
    action: &str,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let columns = sqlite_table_columns(&conn, "orders");
    if columns.is_empty() {
        return Ok(());
    }

    let mut updates: Vec<&str> = Vec::new();
    if columns.contains("customer_name") {
        updates.push("customer_name = 'Privacy restricted'");
    }
    if columns.contains("customer_phone") {
        updates.push("customer_phone = NULL");
    }
    if columns.contains("customer_email") {
        updates.push("customer_email = NULL");
    }
    if columns.contains("delivery_address") {
        updates.push("delivery_address = NULL");
    }
    if columns.contains("delivery_notes") {
        updates.push("delivery_notes = NULL");
    }
    if columns.contains("delivery_latitude") {
        updates.push("delivery_latitude = NULL");
    }
    if columns.contains("delivery_longitude") {
        updates.push("delivery_longitude = NULL");
    }
    if columns.contains("delivery_address_id") {
        updates.push("delivery_address_id = NULL");
    }
    if columns.contains("delivery_address_fingerprint") {
        updates.push("delivery_address_fingerprint = NULL");
    }
    if updates.is_empty() {
        return Ok(());
    }

    let mut where_parts = vec!["id = ?1".to_string()];
    if columns.contains("customer_id") {
        where_parts.push("customer_id = ?1".to_string());
    }
    if columns.contains("customer_phone") && action != "remove" {
        where_parts.push("customer_phone = ?1".to_string());
    }

    let sql = format!(
        "UPDATE orders SET {} WHERE {}",
        updates.join(", "),
        where_parts.join(" OR ")
    );
    let _ = conn.execute(&sql, rusqlite::params![target_id]);
    Ok(())
}

fn apply_privacy_tombstones_to_cache(
    db: &db::DbState,
    tombstones: &[serde_json::Value],
) -> Result<Vec<String>, String> {
    if tombstones.is_empty() {
        return Ok(Vec::new());
    }

    let mut cache = read_local_json_array(db, "customer_cache_v1")?;
    let mut applied_ids: Vec<String> = Vec::new();

    for tombstone in tombstones {
        let tombstone_id = value_str(tombstone, &["id"]).unwrap_or_default();
        let target_type = value_str(tombstone, &["target_type", "targetType"]).unwrap_or_default();
        let target_id = value_str(tombstone, &["target_id", "targetId"]).unwrap_or_default();
        let action = value_str(tombstone, &["action"]).unwrap_or_else(|| "restrict".to_string());
        if tombstone_id.is_empty() || target_id.is_empty() {
            continue;
        }

        match target_type.as_str() {
            "customer" | "customers" => {
                cache.retain(|entry| {
                    value_str(entry, &["id", "customerId"])
                        .map(|id| id != target_id)
                        .unwrap_or(true)
                });
                scrub_order_customer_snapshot(db, &target_id, &action)?;
            }
            "customer_address" | "customer_addresses" | "address" => {
                for entry in &mut cache {
                    if let Some(obj) = entry.as_object_mut() {
                        if let Some(addresses) =
                            obj.get_mut("addresses").and_then(|v| v.as_array_mut())
                        {
                            addresses.retain(|address| {
                                value_str(address, &["id", "addressId"])
                                    .map(|id| id != target_id)
                                    .unwrap_or(true)
                            });
                        }
                    }
                }
                scrub_order_customer_snapshot(db, &target_id, &action)?;
            }
            "order_customer_snapshot" | "order" | "orders" => {
                scrub_order_customer_snapshot(db, &target_id, &action)?;
            }
            _ => {
                continue;
            }
        }

        applied_ids.push(tombstone_id);
    }

    write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    Ok(applied_ids)
}

async fn acknowledge_privacy_tombstones(db: &db::DbState, ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    let terminal_id = storage::get_credential("terminal_id")
        .or_else(|| read_local_setting(db, "terminal", "terminal_id"))
        .unwrap_or_else(|| "pos-tauri".to_string());
    crate::admin_fetch(
        Some(db),
        "/api/pos/privacy/tombstones/consume",
        "POST",
        Some(serde_json::json!({
            "ids": ids,
            "consumed_by": terminal_id,
        })),
    )
    .await
    .map(|_| ())
}

async fn sync_customer_privacy_tombstones(db: &db::DbState) -> Result<usize, String> {
    let response = crate::admin_fetch(Some(db), "/api/pos/privacy/tombstones", "GET", None).await?;
    let tombstones = extract_privacy_tombstones(&response);
    let applied_ids = apply_privacy_tombstones_to_cache(db, &tombstones)?;
    let applied_count = applied_ids.len();
    acknowledge_privacy_tombstones(db, applied_ids).await?;
    Ok(applied_count)
}

fn resolved_customer_sync_org_id(db: &db::DbState) -> Option<String> {
    storage::get_credential("organization_id")
        .or_else(|| read_local_setting(db, "terminal", "organization_id"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn fetch_supabase_table_pages(
    table: &str,
    params: &[(&str, String)],
    page_size: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let mut rows = Vec::new();
    let mut offset = 0usize;

    loop {
        let mut page_params = params.to_vec();
        page_params.push(("limit", page_size.to_string()));
        page_params.push(("offset", offset.to_string()));

        let response = fetch_supabase_rows(table, &page_params).await?;
        let page = response.as_array().cloned().unwrap_or_default();
        let page_len = page.len();
        rows.extend(page);

        if page_len < page_size {
            break;
        }

        offset += page_size;
        if offset > 1_000_000 {
            return Err(format!("{table} pagination exceeded safety limit"));
        }
    }

    Ok(rows)
}

async fn sync_customer_fetch_all_from_supabase(
    db: &db::DbState,
) -> Result<Vec<serde_json::Value>, String> {
    crate::hydrate_terminal_credentials_from_local_settings(db);

    let org_id = resolved_customer_sync_org_id(db)
        .ok_or("Terminal not configured: missing organization_id")?;
    let page_size = 1000usize;
    let mut customers = fetch_supabase_table_pages(
        "customers",
        &[
            ("select", "*".to_string()),
            ("organization_id", format!("eq.{org_id}")),
            ("order", "updated_at.desc.nullslast".to_string()),
        ],
        page_size,
    )
    .await?;

    let addresses = fetch_supabase_table_pages(
        "customer_addresses",
        &[
            ("select", "*".to_string()),
            ("organization_id", format!("eq.{org_id}")),
            ("order", "updated_at.desc.nullslast".to_string()),
        ],
        page_size,
    )
    .await
    .unwrap_or_else(|error| {
        tracing::warn!(error = %error, "Unable to fetch customer addresses from Supabase fallback");
        Vec::new()
    });

    let mut addresses_by_customer: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    for address in addresses {
        if let Some(customer_id) = value_str(&address, &["customer_id", "customerId"]) {
            addresses_by_customer
                .entry(customer_id)
                .or_default()
                .push(address);
        }
    }

    for customer in &mut customers {
        let Some(customer_id) = value_str(customer, &["id", "customer_id", "customerId"]) else {
            continue;
        };
        let attached_addresses = addresses_by_customer
            .remove(&customer_id)
            .unwrap_or_default();
        if let Some(object) = customer.as_object_mut() {
            object.insert(
                "addresses".to_string(),
                serde_json::Value::Array(attached_addresses),
            );
        }
    }

    let customers = customers
        .into_iter()
        .map(normalize_customer_for_cache)
        .collect::<Vec<_>>();

    write_local_json(db, "customer_cache_v1", &serde_json::json!(customers))?;
    Ok(customers)
}

/// Fetch all customers through the trusted POS admin API and replace the local cache.
async fn sync_customer_fetch_all(db: &db::DbState) -> Result<Vec<serde_json::Value>, String> {
    match sync_customer_fetch_all_from_supabase(db).await {
        Ok(customers) => {
            tracing::info!(
                count = customers.len(),
                "Synced customers directly from Supabase fallback"
            );
            return Ok(customers);
        }
        Err(error) => {
            tracing::warn!(
                error = %error,
                "Supabase customer directory fallback unavailable; trying admin API"
            );
        }
    }

    let _ = sync_customer_privacy_tombstones(db).await;
    let page_size = 500u64;
    let mut page = 1u64;
    let mut customers = Vec::new();
    let mut tombstones = Vec::new();

    loop {
        let path = format!("/api/pos/customers?page={page}&limit={page_size}");
        let response = crate::admin_fetch(Some(db), &path, "GET", None).await?;
        customers.extend(
            extract_customers_from_pos_response(&response)
                .into_iter()
                .map(normalize_customer_for_cache),
        );
        tombstones.extend(extract_privacy_tombstones(&response));

        if !customer_response_has_next_page(&response) {
            break;
        }

        page += 1;
        if page > 1000 {
            return Err("Customer pagination exceeded safety limit".into());
        }
    }

    write_local_json(db, "customer_cache_v1", &serde_json::json!(customers))?;
    let applied_ids = apply_privacy_tombstones_to_cache(db, &tombstones)?;
    let _ = acknowledge_privacy_tombstones(db, applied_ids).await;
    if !tombstones.is_empty() {
        return read_local_json_array(db, "customer_cache_v1");
    }
    Ok(customers)
}

async fn sync_customer_fetch_remote_by_id(
    db: &db::DbState,
    customer_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let path = format!("/api/pos/customers/{customer_id}");
    match crate::admin_fetch(Some(db), &path, "GET", None).await {
        Ok(response) => Ok(response
            .get("customer")
            .cloned()
            .or_else(|| response.get("data").cloned())),
        Err(error) if is_not_found_error(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn sync_customer_fetch_remote_by_phone(
    db: &db::DbState,
    phone: &str,
) -> Result<Option<serde_json::Value>, String> {
    let normalized_phone = normalize_phone(phone);
    if normalized_phone.is_empty() {
        return Ok(None);
    }

    let path = format!(
        "/api/pos/customers?phone={}",
        percent_encode_component(&normalized_phone)
    );
    match crate::admin_fetch(Some(db), &path, "GET", None).await {
        Ok(response) => {
            if response
                .get("success")
                .and_then(|value| value.as_bool())
                .is_some_and(|success| !success)
            {
                return Ok(None);
            }

            Ok(response
                .get("customer")
                .cloned()
                .or_else(|| {
                    response
                        .get("customers")
                        .and_then(|value| value.as_array())
                        .and_then(|customers| customers.first().cloned())
                })
                .or_else(|| response.get("data").cloned()))
        }
        Err(error) if is_not_found_error(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn sync_customer_address_remote(
    db: &db::DbState,
    customer_id: &str,
    address: &serde_json::Value,
) -> Result<serde_json::Value, crate::api::AdminFetchError> {
    let body = build_remote_address_body(address);
    let street = string_field(&body, &["street_address"]).ok_or("Missing address street")?;
    if street.is_empty() {
        return Err("Missing address street".into());
    }

    let path = format!("/api/pos/customers/{customer_id}/addresses");
    let response = crate::admin_fetch_detailed(Some(db), &path, "POST", Some(body)).await?;
    let remote_address = response
        .get("address")
        .cloned()
        .ok_or("Address API response missing address")?;
    Ok(remote_address)
}

async fn sync_customer_address_update_remote(
    db: &db::DbState,
    customer_id: &str,
    address_id: &str,
    address: &serde_json::Value,
) -> Result<serde_json::Value, crate::api::AdminFetchError> {
    let body = build_remote_address_body(address);
    if body.as_object().map(|obj| obj.is_empty()).unwrap_or(true) {
        return Err("Missing address updates".into());
    }

    let path = format!("/api/pos/customers/{customer_id}/addresses/{address_id}");
    let response = crate::admin_fetch_detailed(Some(db), &path, "PATCH", Some(body)).await?;
    let remote_address = response
        .get("address")
        .cloned()
        .ok_or("Address API response missing address")?;
    Ok(remote_address)
}

async fn sync_customer_address_delete_remote(
    db: &db::DbState,
    customer_id: &str,
    address_id: &str,
) -> Result<(), crate::api::AdminFetchError> {
    let path = format!("/api/pos/customers/{customer_id}/addresses/{address_id}");
    match crate::admin_fetch_detailed(Some(db), &path, "DELETE", None).await {
        Ok(_) => Ok(()),
        // DELETE is idempotent: an address the office itself says it does not
        // have is already gone. A platform 404 page is not that answer.
        Err(error) if address_already_gone(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn address_already_gone(error: &crate::api::AdminFetchError) -> bool {
    error.status() == Some(404) && error.has_app_error_body()
}

#[tauri::command]
pub async fn customer_get_cache_stats(
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    Ok(serde_json::json!({
        "total": cache.len(),
        "valid": cache.len(),
        "expired": 0
    }))
}

#[tauri::command]
pub async fn customer_clear_cache(
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let existing = read_local_json_array(&db, "customer_cache_v1")?;
    let count = existing.len();
    write_local_json(&db, "customer_cache_v1", &serde_json::json!([]))?;
    let _ = app.emit("customer_deleted", serde_json::json!({ "count": count }));
    Ok(serde_json::json!({ "success": true, "cleared": count }))
}

#[tauri::command]
pub async fn customer_invalidate_cache(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_phone_payload(arg0)?;
    let phone = payload.phone;
    let phone_norm = normalize_phone(&phone);
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let before = cache.len();
    cache.retain(|entry| {
        let p = value_str(entry, &["phone", "customerPhone", "mobile", "telephone"])
            .map(|s| normalize_phone(&s))
            .unwrap_or_default();
        p != phone_norm
    });
    let removed = before.saturating_sub(cache.len());
    write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    if removed > 0 {
        let _ = app.emit(
            "customer_deleted",
            serde_json::json!({ "removed": removed }),
        );
    }
    Ok(serde_json::json!({ "success": true, "removed": removed }))
}

/// Cache-only sibling of `customer_lookup_by_phone` — sync, takes an
/// already-locked `&Connection` so it can be called from inside
/// `sync::create_order` without re-acquiring the `db.conn` mutex
/// (which the caller already holds — re-acquiring would deadlock).
///
/// Returns the canonical UUID `customer_id` when the digit-normalized
/// phone matches a cache entry. Returns `None` when:
///   - phone is empty after normalization
///   - cache is empty / unparseable
///   - no entry's phone matches the normalized phone
///   - the matched entry has no `id` / `customerId`
///   - the matched id is not a valid UUID (e.g. the `cust-<uuid>`
///     synthetic ids that `customer_lookup_by_phone`'s orders-fallback
///     branch emits — those would later be rejected by
///     `resolvePersistedCustomerId` in the renderer, so we filter
///     them out at this gate).
///
/// Used by `sync::create_order` (Layer 3 of the customer ↔ order ↔
/// loyalty linkage repair) to derive `customer_id` from
/// `customer_phone` when the renderer didn't capture it. Strict
/// equality on the normalized phone — never partial / LIKE — to
/// guarantee we never silently link an order to the wrong customer.
pub fn resolve_customer_id_from_cache_conn(
    conn: &rusqlite::Connection,
    phone: &str,
) -> Option<String> {
    let normalized = normalize_phone(phone);
    if normalized.is_empty() {
        return None;
    }
    let raw = db::get_setting(conn, "local", "customer_cache_v1")?;
    let cache: Vec<serde_json::Value> = serde_json::from_str(&raw).ok()?;
    for entry in cache {
        let entry_phone_norm =
            value_str(&entry, &["phone", "customerPhone", "mobile", "telephone"])
                .map(|s| normalize_phone(&s))
                .unwrap_or_default();
        if !entry_phone_norm.is_empty() && entry_phone_norm == normalized {
            let id = value_str(&entry, &["id", "customerId"])?;
            if uuid::Uuid::parse_str(&id).is_ok() {
                return Some(id);
            }
        }
    }
    None
}

/// Country calling codes stripped from Caller ID numbers longer than 10
/// digits. Same list and order as the renderer's
/// `normalizeCallerIdSearchPhone` so both sides derive the same lookup key.
const CALLER_ID_COUNTRY_PREFIXES: [&str; 42] = [
    "351", "355", "357", "358", "359", "370", "371", "372", "373", "374", "375", "376", "377",
    "378", "380", "381", "382", "383", "385", "386", "387", "389", "420", "421", "423", "30", "31",
    "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "90",
];

/// National number used to match a Caller ID number against stored
/// customers: `+30 210 123 4567`, `00302101234567` and `2101234567` all map to
/// `2101234567`.
fn caller_id_phone_key(value: &str) -> String {
    let mut digits: String = value.chars().filter(char::is_ascii_digit).collect();
    if let Some(rest) = digits.strip_prefix("00") {
        digits = rest.to_string();
    }
    if let Some(prefix) = CALLER_ID_COUNTRY_PREFIXES
        .iter()
        .find(|prefix| digits.len() > 10 && digits.starts_with(**prefix))
    {
        digits = digits[prefix.len()..].to_string();
    }
    match digits.strip_prefix('0') {
        Some(rest) => rest.to_string(),
        None => digits,
    }
}

/// First cached customer whose phone matches `phone` as a Caller ID number.
fn find_cached_customer_for_caller_id(
    cache: Vec<serde_json::Value>,
    phone: &str,
) -> Option<serde_json::Value> {
    let key = caller_id_phone_key(phone);
    if key.len() < 3 {
        return None;
    }
    cache.into_iter().find(|entry| {
        value_str(entry, &["phone", "customerPhone", "mobile", "telephone"])
            .is_some_and(|stored| caller_id_phone_key(&stored) == key)
    })
}

#[tauri::command]
pub async fn customer_lookup_by_phone(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_phone_payload(arg0)?;
    if payload.cache_only {
        let cache = read_local_json_array(&db, "customer_cache_v1")?;
        return Ok(find_cached_customer_for_caller_id(cache, &payload.phone)
            .unwrap_or(serde_json::Value::Null));
    }
    let phone = payload.phone;
    let phone_norm = normalize_phone(&phone);
    let _ = sync_customer_privacy_tombstones(&db).await;
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    if let Some(found) = cache.into_iter().find(|entry| {
        value_str(entry, &["phone", "customerPhone", "mobile", "telephone"])
            .map(|s| normalize_phone(&s))
            .map(|s| s == phone_norm)
            .unwrap_or(false)
    }) {
        return Ok(found);
    }

    if let Some(remote_customer) = sync_customer_fetch_remote_by_phone(&db, &phone).await? {
        let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
        let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        return Ok(customer);
    }

    // Fallback from local orders history.
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT customer_name, customer_phone, customer_email
             FROM orders
             WHERE customer_phone IS NOT NULL
               AND COALESCE(is_ghost, 0) = 0
               AND replace(replace(replace(replace(customer_phone, '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?1
             ORDER BY updated_at DESC
             LIMIT 1",
            rusqlite::params![format!("%{phone_norm}%")],
            |row| {
                Ok(serde_json::json!({
                    "id": format!("cust-{}", uuid::Uuid::new_v4()),
                    "name": row.get::<_, Option<String>>(0)?,
                    "phone": row.get::<_, Option<String>>(1)?,
                    "email": row.get::<_, Option<String>>(2)?,
                    "source": "orders_fallback"
                }))
            },
        )
        .ok();
    Ok(row.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn customer_lookup_by_id(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_lookup_payload(arg0, "Missing customerId")?;
    let customer_id = payload.customer_id;
    let _ = sync_customer_privacy_tombstones(&db).await;
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    let found = cache.into_iter().find(|entry| {
        value_str(entry, &["id", "customerId"])
            .map(|id| id == customer_id)
            .unwrap_or(false)
    });
    if let Some(found) = found {
        return Ok(found);
    }

    if let Some(remote_customer) = sync_customer_fetch_remote_by_id(&db, &customer_id).await? {
        let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
        let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        return Ok(customer);
    }

    Ok(serde_json::Value::Null)
}

#[tauri::command]
pub async fn customer_search(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let query = parse_search_payload(arg0).query.to_lowercase();
    if query.is_empty() {
        // Fetch all customers through the fastest configured sync path and
        // refresh local cache. Do not call the admin privacy-tombstone endpoint
        // first here: if the tenant admin host is down, that request delays the
        // direct Supabase fallback and makes the Users page appear frozen.
        match sync_customer_fetch_all(&db).await {
            Ok(customers) => return Ok(serde_json::json!(customers)),
            Err(e) => {
                tracing::warn!(error = %e, "Failed to fetch all customers, falling back to cache");
                let cache = read_local_json_array(&db, "customer_cache_v1")?;
                return Ok(serde_json::json!(cache));
            }
        }
    }

    let _ = sync_customer_privacy_tombstones(&db).await;
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    let matches: Vec<serde_json::Value> = cache
        .into_iter()
        .filter(|entry| {
            let name = value_str(entry, &["name", "fullName"])
                .unwrap_or_default()
                .to_lowercase();
            let phone = value_str(entry, &["phone", "customerPhone"])
                .unwrap_or_default()
                .to_lowercase();
            let email = value_str(entry, &["email"])
                .unwrap_or_default()
                .to_lowercase();
            name.contains(&query) || phone.contains(&query) || email.contains(&query)
        })
        .collect();
    if matches.is_empty() {
        let path = format!(
            "/api/pos/customers?search={}",
            percent_encode_component(&query)
        );
        match crate::admin_fetch(Some(&db), &path, "GET", None).await {
            Ok(response) => {
                let remote_matches = extract_customers_from_pos_response(&response)
                    .into_iter()
                    .map(normalize_customer_for_cache)
                    .collect::<Vec<_>>();
                if !remote_matches.is_empty() {
                    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
                    for customer in remote_matches.iter().cloned() {
                        upsert_customer_cache_entry(&mut cache, customer);
                    }
                    write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
                    return Ok(serde_json::json!(remote_matches));
                }
            }
            Err(error) => {
                tracing::debug!(error = %error, "Remote customer search unavailable, using cache result");
            }
        }
    }
    Ok(serde_json::json!(matches))
}

/// Result of one customer create, before the Tauri events are emitted.
struct CustomerCreateOutcome {
    response: serde_json::Value,
    /// The customer to announce through `customer_created`; `None` when the
    /// write was rejected and nothing changed on this terminal.
    created: Option<serde_json::Value>,
}

/// A create without a name or phone can never succeed on the server
/// (`MISSING_PHONE_OR_NAME`), so it is refused before any request or queue row.
fn customer_create_precondition_failure(body: &serde_json::Value) -> Option<&'static str> {
    let has = |key: &str| string_field(body, &[key]).is_some_and(|value| !value.is_empty());
    (!has("name") || !has("phone")).then_some("MISSING_PHONE_OR_NAME")
}

/// Apply the outcome of the remote create to this terminal's cache and parity
/// queue. Kept free of the Tauri handle so the offline/reject split is tested
/// against a real database.
fn apply_customer_create_outcome(
    db: &db::DbState,
    payload: &serde_json::Value,
    queue_payload: &serde_json::Value,
    remote: Result<serde_json::Value, crate::api::AdminFetchError>,
) -> Result<CustomerCreateOutcome, String> {
    let remote_error = match remote {
        Ok(remote_customer) => {
            let mut cache = read_local_json_array(db, "customer_cache_v1")?;
            let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
            write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
            return Ok(CustomerCreateOutcome {
                response: serde_json::json!({ "success": true, "data": customer }),
                created: Some(customer),
            });
        }
        Err(remote_error) => remote_error,
    };

    if let CustomerRemoteFailure::Rejected { status, code } =
        classify_customer_remote_failure(&remote_error)
    {
        // The code alone names the failed contract; never log the phone.
        tracing::warn!(
            code = %code,
            status = ?status,
            "Customer create rejected by the admin API; nothing cached or queued"
        );
        return Ok(CustomerCreateOutcome {
            response: customer_rejection_response(status, &code),
            created: None,
        });
    }

    let mut cache = read_local_json_array(db, "customer_cache_v1")?;
    let customer =
        upsert_customer_cache_entry(&mut cache, build_local_customer_from_source(payload));
    write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))?;

    let customer_id =
        value_str(&customer, &["id", "customerId"]).ok_or("Missing local customer id")?;
    let version = value_i64(&customer, &["version"]).unwrap_or(1);
    enqueue_customer_sync_item(
        db,
        "customers",
        &customer_id,
        "INSERT",
        queue_payload,
        version,
    )?;

    tracing::info!(
        status = ?remote_error.status(),
        transport = remote_error.is_transport_failure(),
        "Customer create saved on this terminal; queued for sync"
    );
    Ok(CustomerCreateOutcome {
        response: serde_json::json!({
            "success": true,
            "queued": true,
            "offline": true,
            "warning": CUSTOMER_SAVED_OFFLINE,
            "data": customer
        }),
        created: Some(customer),
    })
}

#[tauri::command]
pub async fn customer_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let queue_payload = build_remote_customer_create_body(&payload);

    if let Some(code) = customer_create_precondition_failure(&queue_payload) {
        return Ok(customer_rejection_response(None, code));
    }

    let remote = sync_customer_create_remote(&db, queue_payload.clone()).await;
    let outcome = apply_customer_create_outcome(&db, &payload, &queue_payload, remote)?;
    if let Some(customer) = outcome.created {
        let _ = app.emit("customer_created", customer.clone());
        let _ = app.emit("customer_realtime_update", customer);
    }
    Ok(outcome.response)
}

/// Result of one customer update, before the Tauri events are emitted.
struct CustomerUpdateOutcome {
    response: serde_json::Value,
    /// Customer to announce through `customer_updated`.
    updated: Option<serde_json::Value>,
    /// Local version conflict to announce through `customer_sync_conflict`.
    conflict: Option<serde_json::Value>,
}

impl CustomerUpdateOutcome {
    fn answer(response: serde_json::Value) -> Self {
        Self {
            response,
            updated: None,
            conflict: None,
        }
    }

    fn refused(code: &str) -> Self {
        Self::answer(customer_rejection_response(None, code))
    }
}

/// Where one customer edit goes.
enum CustomerUpdatePlan {
    /// Answered on this terminal: folded into the queued INSERT of a customer
    /// the office has not seen yet, or refused with a code.
    Finished(CustomerUpdateOutcome),
    /// PATCH the office record `customer_id` with this version.
    Office {
        customer_id: String,
        expected_version: i64,
    },
    /// Nothing in the edit is for the office (the local ban flag): merge it
    /// into the cached customer only, as before.
    LocalOnly,
}

/// The fields of an edit that belong in a queued customer INSERT: the create
/// body's fields (name, phone, address, ...) plus the update body's explicit
/// clears (`email: null`).
fn queued_customer_insert_changes(
    updates: &serde_json::Value,
) -> serde_json::Map<String, serde_json::Value> {
    let mut changes = build_remote_customer_create_body(updates)
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(update_body) = build_remote_customer_update_body(updates).as_object() {
        for (key, value) in update_body {
            if !matches!(key.as_str(), "loyalty_points" | "is_active") {
                changes.insert(key.clone(), value.clone());
            }
        }
    }
    changes
}

/// Merge an edit into the cached copy of a customer that so far exists only
/// on this terminal. Returns the updated customer.
fn merge_updates_into_cached_customer(
    db: &db::DbState,
    customer_id: &str,
    updates: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut cache = read_local_json_array(db, "customer_cache_v1")?;
    let mut merged: Option<serde_json::Value> = None;
    for entry in &mut cache {
        if value_str(entry, &["id", "customerId"]).as_deref() != Some(customer_id) {
            continue;
        }
        if let (Some(dst), Some(src)) = (entry.as_object_mut(), updates.as_object()) {
            for (key, value) in src {
                if matches!(key.as_str(), "id" | "customerId" | "version") {
                    continue;
                }
                dst.insert(key.clone(), value.clone());
            }
            let next_version = dst.get("version").and_then(|v| v.as_i64()).unwrap_or(1) + 1;
            dst.insert("version".to_string(), serde_json::json!(next_version));
            dst.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
        }
        merged = Some(entry.clone());
        break;
    }
    let customer = match merged {
        Some(customer) => customer,
        None => {
            let mut source = if updates.is_object() {
                updates.clone()
            } else {
                serde_json::json!({})
            };
            source["id"] = serde_json::json!(customer_id);
            upsert_customer_cache_entry(&mut cache, build_local_customer_from_source(&source))
        }
    };
    write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    Ok(customer)
}

/// Decide where a customer edit goes (review 2026-09-29, audit VERIFY (d)):
/// - a local `cust-` customer whose INSERT is still queued (pending, failed
///   or parked as a conflict): the edit is folded into that INSERT, because
///   a PATCH to `/api/pos/customers/cust-…` can only answer 404 — and a
///   failed INSERT goes back to pending with the corrected record;
/// - its INSERT is being sent right now: `CUSTOMER_SYNC_IN_PROGRESS`;
/// - its INSERT already synced: the edit goes to the office record that
///   replaced it (the cached alias), with that record's version;
/// - none of these: `CUSTOMER_NOT_SYNCED`;
/// - an office customer edited without a known version (the renderer sends
///   -1 for a customer object without one): the cached version, else
///   `VERSION_REQUIRED` — a PATCH without `expected_version` is always a 400.
fn plan_customer_update(
    db: &db::DbState,
    customer_id: &str,
    updates: &serde_json::Value,
    expected_version: i64,
) -> Result<CustomerUpdatePlan, String> {
    let remote_updates = build_remote_customer_update_body(updates);
    if remote_updates
        .as_object()
        .map(|obj| obj.is_empty())
        .unwrap_or(true)
    {
        return Ok(CustomerUpdatePlan::LocalOnly);
    }

    if is_local_customer_id(customer_id) {
        let changes = queued_customer_insert_changes(updates);
        let merge = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            sync_queue::merge_into_queued_customer_directory_insert(
                &conn,
                "customers",
                customer_id,
                &changes,
            )?
        };
        return match merge {
            sync_queue::QueuedInsertMerge::Merged { .. } => {
                let customer = merge_updates_into_cached_customer(db, customer_id, updates)?;
                Ok(CustomerUpdatePlan::Finished(CustomerUpdateOutcome {
                    response: serde_json::json!({
                        "success": true,
                        "queued": true,
                        "offline": true,
                        "warning": CUSTOMER_SAVED_OFFLINE,
                        "data": customer
                    }),
                    updated: Some(customer),
                    conflict: None,
                }))
            }
            sync_queue::QueuedInsertMerge::InFlight => Ok(CustomerUpdatePlan::Finished(
                CustomerUpdateOutcome::refused(CUSTOMER_SYNC_IN_PROGRESS),
            )),
            sync_queue::QueuedInsertMerge::NotQueued => {
                // Read after the merge attempt: an INSERT that synced a moment
                // ago has already left its alias in the cache.
                let cache = read_local_json_array(db, "customer_cache_v1")?;
                let office = cached_synced_alias(&cache, customer_id).map(|entry| {
                    (
                        value_str(entry, &["id", "customerId"]).unwrap_or_default(),
                        value_i64(entry, &["version"]).filter(|version| *version > 0),
                    )
                });
                Ok(match office {
                    Some((office_id, Some(version))) => CustomerUpdatePlan::Office {
                        customer_id: office_id,
                        expected_version: version,
                    },
                    Some((_, None)) => CustomerUpdatePlan::Finished(
                        CustomerUpdateOutcome::refused(VERSION_REQUIRED),
                    ),
                    None => CustomerUpdatePlan::Finished(CustomerUpdateOutcome::refused(
                        CUSTOMER_NOT_SYNCED,
                    )),
                })
            }
        };
    }

    let expected_version = if expected_version > 0 {
        Some(expected_version)
    } else {
        cached_customer_version(
            &read_local_json_array(db, "customer_cache_v1")?,
            customer_id,
        )
    };
    Ok(match expected_version {
        Some(expected_version) => CustomerUpdatePlan::Office {
            customer_id: customer_id.to_string(),
            expected_version,
        },
        None => CustomerUpdatePlan::Finished(CustomerUpdateOutcome::refused(VERSION_REQUIRED)),
    })
}

/// A 409 `VERSION_MISMATCH` carries the office's latest record. Cache it so
/// reopening the customer (lookups read the cache first) edits the current
/// version instead of hitting the same conflict again.
fn refresh_customer_from_version_conflict(
    db: &db::DbState,
    customer_id: &str,
    error: &crate::api::AdminFetchError,
) -> Result<(), String> {
    let Some(latest) = error
        .app_error_field("customer")
        .filter(|value| value.is_object())
    else {
        return Ok(());
    };
    if value_str(latest, &["id", "customerId"]).as_deref() != Some(customer_id) {
        return Ok(());
    }
    let mut cache = read_local_json_array(db, "customer_cache_v1")?;
    upsert_customer_cache_entry(&mut cache, latest.clone());
    write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))
}

/// Apply an edit to this terminal's cache (and, when the office call was
/// deferred, the parity queue) — the pre-existing local path.
fn merge_customer_update_locally(
    db: &db::DbState,
    customer_id: &str,
    updates: &serde_json::Value,
    expected_version: i64,
    queue_for_sync: bool,
) -> Result<CustomerUpdateOutcome, String> {
    let mut cache = read_local_json_array(db, "customer_cache_v1")?;

    let mut updated_customer: Option<serde_json::Value> = None;
    let mut conflict: Option<serde_json::Value> = None;
    for entry in &mut cache {
        let id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if id != customer_id {
            continue;
        }
        let current_version = entry.get("version").and_then(|v| v.as_i64()).unwrap_or(1);
        if expected_version > 0 && expected_version != current_version {
            conflict = Some(serde_json::json!({
                "id": format!("cc-{}", uuid::Uuid::new_v4()),
                "customerId": customer_id,
                "expectedVersion": expected_version,
                "currentVersion": current_version,
                "updates": updates
            }));
            break;
        }
        if let (Some(dst), Some(src)) = (entry.as_object_mut(), updates.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
            dst.insert(
                "version".to_string(),
                serde_json::json!(current_version + 1),
            );
            dst.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
        }
        updated_customer = Some(entry.clone());
        break;
    }

    if let Some(conflict_payload) = conflict {
        let mut conflicts = read_local_json_array(db, "customer_conflicts_v1")?;
        conflicts.push(conflict_payload.clone());
        write_local_json(
            db,
            "customer_conflicts_v1",
            &serde_json::Value::Array(conflicts),
        )?;
        return Ok(CustomerUpdateOutcome {
            response: serde_json::json!({
                "success": false,
                "conflict": true,
                "error": "Version conflict",
                "data": conflict_payload
            }),
            updated: None,
            conflict: Some(conflict_payload),
        });
    }

    let Some(customer) = updated_customer else {
        return Err("Customer not found".into());
    };
    write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    let mut remote_updates = build_remote_customer_update_body(updates);
    let queued = queue_for_sync
        && remote_updates
            .as_object()
            .map(|obj| !obj.is_empty())
            .unwrap_or(false);
    if queued {
        if expected_version > 0 {
            if let Some(obj) = remote_updates.as_object_mut() {
                obj.insert(
                    "expected_version".to_string(),
                    serde_json::json!(expected_version),
                );
            }
        }
        let version = value_i64(&customer, &["version"]).unwrap_or(expected_version.max(1));
        enqueue_customer_sync_item(
            db,
            "customers",
            customer_id,
            "UPDATE",
            &remote_updates,
            version,
        )?;
    }
    Ok(CustomerUpdateOutcome {
        response: serde_json::json!({
            "success": true,
            "queued": queued,
            "offline": queued,
            "warning": queued.then_some(CUSTOMER_SAVED_OFFLINE),
            "data": customer
        }),
        updated: Some(customer),
        conflict: None,
    })
}

/// Apply the office's answer to an edit (`None`: nothing was sent). Same
/// split as customer_create: a coded application 4xx is shown on the form
/// and never merged locally or queued (an UPDATE the office refuses fails on
/// every replay); a transport, 5xx, 408/429, soft-auth or platform failure
/// keeps the offline-first path.
fn apply_customer_update_outcome(
    db: &db::DbState,
    customer_id: &str,
    updates: &serde_json::Value,
    expected_version: i64,
    remote: Option<Result<serde_json::Value, crate::api::AdminFetchError>>,
) -> Result<CustomerUpdateOutcome, String> {
    let queue_for_sync = match remote {
        Some(Ok(remote_customer)) => {
            let mut cache = read_local_json_array(db, "customer_cache_v1")?;
            let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
            write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
            return Ok(CustomerUpdateOutcome {
                response: serde_json::json!({ "success": true, "data": customer }),
                updated: Some(customer),
                conflict: None,
            });
        }
        Some(Err(error)) => {
            if let CustomerRemoteFailure::Rejected { status, code } =
                classify_customer_remote_failure(&error)
            {
                tracing::warn!(
                    code = %code,
                    status = ?status,
                    "Customer update rejected by the admin API; nothing merged or queued"
                );
                if code == "VERSION_MISMATCH" {
                    refresh_customer_from_version_conflict(db, customer_id, &error)?;
                }
                return Ok(CustomerUpdateOutcome::answer(customer_rejection_response(
                    status, &code,
                )));
            }
            tracing::info!(
                status = ?error.status(),
                transport = error.is_transport_failure(),
                "Customer update saved on this terminal; queued for sync"
            );
            true
        }
        None => false,
    };
    merge_customer_update_locally(db, customer_id, updates, expected_version, queue_for_sync)
}

fn emit_customer_update_outcome(app: &tauri::AppHandle, outcome: &CustomerUpdateOutcome) {
    if let Some(conflict) = outcome.conflict.as_ref() {
        let _ = app.emit("customer_sync_conflict", conflict.clone());
    }
    if let Some(customer) = outcome.updated.as_ref() {
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
    }
}

#[tauri::command]
pub async fn customer_update(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_update_payload(arg0, arg1, arg2)?;
    let updates = payload.updates;
    let outcome = match plan_customer_update(
        &db,
        &payload.customer_id,
        &updates,
        payload.expected_version,
    )? {
        CustomerUpdatePlan::Finished(outcome) => outcome,
        CustomerUpdatePlan::LocalOnly => apply_customer_update_outcome(
            &db,
            &payload.customer_id,
            &updates,
            payload.expected_version,
            None,
        )?,
        CustomerUpdatePlan::Office {
            customer_id,
            expected_version,
        } => {
            let remote =
                sync_customer_update_remote(&db, &customer_id, &updates, expected_version).await;
            apply_customer_update_outcome(
                &db,
                &customer_id,
                &updates,
                expected_version,
                Some(remote),
            )?
        }
    };
    emit_customer_update_outcome(&app, &outcome);
    Ok(outcome.response)
}

#[tauri::command]
pub async fn customer_update_ban_status(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_ban_payload(arg0, arg1)?;
    customer_update(
        Some(serde_json::json!(payload.customer_id)),
        Some(serde_json::json!({ "isBanned": payload.is_banned })),
        None,
        db,
        app,
    )
    .await
}

/// Keys of a queued customer INSERT that carry the customer's first address
/// (see `build_remote_customer_create_body`).
const CUSTOMER_INSERT_ADDRESS_KEYS: [&str; 12] = [
    "address",
    "city",
    "postal_code",
    "floor_number",
    "name_on_ringer",
    "coordinates",
    "latitude",
    "longitude",
    "place_id",
    "formatted_address",
    "resolved_street_number",
    "address_fingerprint",
];

/// Where an address write for a customer goes.
#[derive(Debug, PartialEq)]
enum CustomerAddressWritePlan {
    /// The office knows the customer, directly or as the office record that
    /// replaced a synced local customer: call it and classify failures.
    Office(String),
    /// A local customer whose INSERT is still queued. The office cannot know
    /// it yet (a call can only answer 404), so the write stays on this
    /// terminal: queued behind the INSERT and replayed against the office id
    /// once it lands, or folded into the INSERT itself.
    PendingLocal(String),
    /// Refused on this terminal with a code.
    Refused(serde_json::Value),
}

fn plan_customer_address_write(
    db: &db::DbState,
    customer_id: &str,
) -> Result<CustomerAddressWritePlan, String> {
    if !is_local_customer_id(customer_id) {
        return Ok(CustomerAddressWritePlan::Office(customer_id.to_string()));
    }
    let cache = read_local_json_array(db, "customer_cache_v1")?;
    if let Some(office_id) = cached_synced_alias(&cache, customer_id)
        .and_then(|entry| value_str(entry, &["id", "customerId"]))
    {
        return Ok(CustomerAddressWritePlan::Office(office_id));
    }
    let queued = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        sync_queue::queued_customer_directory_insert_status(&conn, "customers", customer_id)?
    };
    Ok(match queued {
        Some(_) => CustomerAddressWritePlan::PendingLocal(customer_id.to_string()),
        None => CustomerAddressWritePlan::Refused(customer_rejection_response(
            None,
            CUSTOMER_NOT_SYNCED,
        )),
    })
}

/// Keys of an address edit that carry its point.
const ADDRESS_POINT_KEYS: [&str; 3] = ["coordinates", "latitude", "longitude"];
/// Keys of an address edit that change its text. The office rebuilds the
/// formatted address from the text unless the edit brings one.
const ADDRESS_TEXT_KEYS: [&str; 3] = ["street_address", "city", "postal_code"];

/// What an address edit does to the address's point.
#[derive(Debug, Clone, Copy, PartialEq)]
enum AddressPointEdit {
    /// No coordinate key, or a pair the office refuses (INVALID_COORDINATES):
    /// the point stays as it is.
    Untouched,
    /// Explicit nulls, or (0, 0), which the office stores as "no point".
    Clear,
    Set {
        lat: f64,
        lng: f64,
    },
}

fn coordinate_number(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(raw) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn wgs84_point(lat: Option<f64>, lng: Option<f64>) -> Option<(f64, f64)> {
    let (lat, lng) = (lat?, lng?);
    (lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng))
    .then_some((lat, lng))
}

/// A point in the shapes an address carries in `coordinates`: `{lat, lng}`,
/// `{latitude, longitude}`, a GeoJSON Point or a `[lng, lat]` position.
fn address_point_from_value(value: &serde_json::Value) -> Option<(f64, f64)> {
    if let Some(position) = value.as_array() {
        return wgs84_point(
            position.get(1).and_then(coordinate_number),
            position.first().and_then(coordinate_number),
        );
    }
    if value.get("type").and_then(|kind| kind.as_str()) == Some("Point") {
        return value
            .get("coordinates")
            .filter(|position| position.is_array())
            .and_then(address_point_from_value);
    }
    let field = |keys: [&str; 2]| {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(coordinate_number))
    };
    wgs84_point(field(["lat", "latitude"]), field(["lng", "longitude"]))
}

/// The point a cached address has now: a readable `coordinates` first, then
/// the flat pair (the office reads its rows the same way).
fn stored_address_point(address: &serde_json::Value) -> Option<(f64, f64)> {
    address
        .get("coordinates")
        .and_then(address_point_from_value)
        .or_else(|| {
            wgs84_point(
                address.get("latitude").and_then(coordinate_number),
                address.get("longitude").and_then(coordinate_number),
            )
        })
}

/// Read an address edit's coordinates the way the office PATCH
/// (`/api/pos/customers/[id]/addresses/[addressId]`) reads them: no
/// coordinate key leaves the point alone; `coordinates: null` without a flat
/// pair, or `latitude: null` with `longitude: null`, clears it; otherwise a
/// readable `coordinates` wins, then the flat pair, a missing half of which
/// is the current point's. (0, 0) is stored as "no point".
fn address_point_edit(edit: &serde_json::Value, current: Option<(f64, f64)>) -> AddressPointEdit {
    if ADDRESS_POINT_KEYS
        .iter()
        .all(|key| edit.get(*key).is_none())
    {
        return AddressPointEdit::Untouched;
    }
    let coordinates = edit.get("coordinates");
    let latitude = edit.get("latitude");
    let longitude = edit.get("longitude");
    let explicit_clear = (coordinates.is_some_and(serde_json::Value::is_null)
        && latitude.is_none()
        && longitude.is_none())
        || (latitude.is_some_and(serde_json::Value::is_null)
            && longitude.is_some_and(serde_json::Value::is_null));
    if explicit_clear {
        return AddressPointEdit::Clear;
    }
    let flat = |value: Option<&serde_json::Value>, current: Option<f64>| match value {
        Some(value) => coordinate_number(value),
        None => current,
    };
    let point = coordinates.and_then(address_point_from_value).or_else(|| {
        wgs84_point(
            flat(latitude, current.map(|(lat, _)| lat)),
            flat(longitude, current.map(|(_, lng)| lng)),
        )
    });
    match point {
        Some((lat, lng)) if lat == 0.0 && lng == 0.0 => AddressPointEdit::Clear,
        Some((lat, lng)) => AddressPointEdit::Set { lat, lng },
        None => AddressPointEdit::Untouched,
    }
}

/// Spell a deferred address edit for the queued INSERT it is folded into,
/// where a `null` change removes the key. The INSERT carries the address
/// whole, so an edit that moves or clears the point rewrites all three
/// coordinate keys: `coordinates: null` alone would leave the INSERT's
/// `latitude`/`longitude`, and the office would store the old point. An edit
/// of the address text drops a formatted address that spelled the old text;
/// the office rebuilds it from the new text, as its PATCH does.
fn spell_address_edit_for_queued_insert(
    edit: &serde_json::Value,
    changes: &mut serde_json::Map<String, serde_json::Value>,
) {
    match address_point_edit(edit, None) {
        AddressPointEdit::Untouched => {}
        AddressPointEdit::Clear => {
            for key in ADDRESS_POINT_KEYS {
                changes.insert(key.to_string(), serde_json::Value::Null);
            }
        }
        AddressPointEdit::Set { lat, lng } => {
            changes.insert(
                "coordinates".to_string(),
                serde_json::json!({ "lat": lat, "lng": lng }),
            );
            changes.insert("latitude".to_string(), serde_json::json!(lat));
            changes.insert("longitude".to_string(), serde_json::json!(lng));
        }
    }
    if ADDRESS_TEXT_KEYS.iter().any(|key| edit.get(*key).is_some())
        && edit.get("formatted_address").is_none()
    {
        changes.insert("formatted_address".to_string(), serde_json::Value::Null);
    }
    // An explicitly cleared place leaves the INSERT under either spelling
    // (the customer INSERT body drops a null place id on its own).
    if address_edit_clears_place(edit) {
        for key in ADDRESS_PLACE_KEYS {
            changes.insert(key.to_string(), serde_json::Value::Null);
        }
    }
}

/// Fold an address edit into the queued INSERT of that address (an address
/// saved on this terminal and not sent yet), whoever its customer is.
fn merge_address_edit_into_queued_address_insert(
    db: &db::DbState,
    address_id: &str,
    queue_payload: &serde_json::Value,
) -> Result<sync_queue::QueuedInsertMerge, String> {
    let mut changes = queue_payload.as_object().cloned().unwrap_or_default();
    spell_address_edit_for_queued_insert(queue_payload, &mut changes);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    sync_queue::merge_into_queued_customer_directory_insert(
        &conn,
        "customer_addresses",
        address_id,
        &changes,
    )
}

/// Fold an address edit into the queued INSERT of a local customer: the
/// address it carries is the customer's first address.
fn merge_address_edit_into_customer_insert(
    db: &db::DbState,
    customer_id: &str,
    queue_payload: &serde_json::Value,
) -> Result<sync_queue::QueuedInsertMerge, String> {
    let mut changes = build_remote_customer_create_body(queue_payload)
        .as_object()
        .map(|body| {
            body.iter()
                .filter(|(key, _)| {
                    CUSTOMER_INSERT_ADDRESS_KEYS.contains(&key.as_str()) || key.as_str() == "notes"
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    spell_address_edit_for_queued_insert(queue_payload, &mut changes);
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    sync_queue::merge_into_queued_customer_directory_insert(
        &conn,
        "customers",
        customer_id,
        &changes,
    )
}

/// Remove an address that never reached the office from what is queued:
/// its own queued INSERT is withdrawn, or — for a local customer — the
/// address its customer INSERT carries is cleared. `Some(code)` refuses the
/// delete because the row is being sent right now.
fn remove_unsynced_address_from_queue(
    db: &db::DbState,
    plan: &CustomerAddressWritePlan,
    address_id: &str,
) -> Result<(bool, Option<&'static str>), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    match sync_queue::withdraw_queued_customer_address_insert(&conn, address_id)? {
        sync_queue::QueuedInsertWithdrawal::Withdrawn { .. } => return Ok((true, None)),
        sync_queue::QueuedInsertWithdrawal::InFlight => {
            return Ok((false, Some(CUSTOMER_SYNC_IN_PROGRESS)))
        }
        sync_queue::QueuedInsertWithdrawal::NotQueued => {}
    }
    let CustomerAddressWritePlan::PendingLocal(customer_id) = plan else {
        return Ok((false, None));
    };
    drop(conn);
    let carried_by_customer_insert = read_local_json_array(db, "customer_cache_v1")?
        .iter()
        .find(|entry| {
            value_str(entry, &["id", "customerId"]).as_deref() == Some(customer_id.as_str())
        })
        .and_then(|entry| entry.get("addresses").and_then(|v| v.as_array()).cloned())
        .is_some_and(|addresses| {
            addresses.iter().any(|address| {
                value_str(address, &["id", "addressId"]).as_deref() == Some(address_id)
            })
        });
    if !carried_by_customer_insert {
        return Ok((true, None));
    }
    let clears = CUSTOMER_INSERT_ADDRESS_KEYS
        .iter()
        .map(|key| (key.to_string(), serde_json::Value::Null))
        .collect::<serde_json::Map<_, _>>();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    Ok(
        match sync_queue::merge_into_queued_customer_directory_insert(
            &conn,
            "customers",
            customer_id,
            &clears,
        )? {
            sync_queue::QueuedInsertMerge::InFlight => (false, Some(CUSTOMER_SYNC_IN_PROGRESS)),
            _ => (true, None),
        },
    )
}

#[tauri::command]
pub async fn customer_add_address(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_address_payload(arg0, arg1)?;
    let mut queue_payload = build_remote_address_body(&payload.address);
    if queue_payload
        .get("street_address")
        .and_then(|value| value.as_str())
        .is_none()
    {
        return Err("Missing address street".into());
    }
    let (customer_id, office_knows_customer) =
        match plan_customer_address_write(&db, &payload.customer_id)? {
            CustomerAddressWritePlan::Refused(response) => return Ok(response),
            CustomerAddressWritePlan::Office(customer_id) => (customer_id, true),
            CustomerAddressWritePlan::PendingLocal(customer_id) => (customer_id, false),
        };
    if let Some(obj) = queue_payload.as_object_mut() {
        obj.insert(
            "customer_id".to_string(),
            serde_json::json!(customer_id.clone()),
        );
    }

    let remote = if office_knows_customer {
        Some(sync_customer_address_remote(&db, &customer_id, &payload.address).await)
    } else {
        None
    };
    let (address, deferred) = match remote {
        Some(Ok(remote_address)) => (normalize_address_for_cache(remote_address), false),
        Some(Err(error)) => {
            if let Some(rejection) = customer_write_rejection(&error, "customer_add_address") {
                return Ok(rejection);
            }
            (normalize_address_for_cache(queue_payload.clone()), true)
        }
        // Queued behind the local customer's own INSERT.
        None => (normalize_address_for_cache(queue_payload.clone()), true),
    };

    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let mut updated: Option<serde_json::Value> = None;
    for entry in &mut cache {
        let id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if id != customer_id {
            continue;
        }
        if let Some(obj) = entry.as_object_mut() {
            let addresses = obj
                .entry("addresses".to_string())
                .or_insert_with(|| serde_json::json!([]));
            if let Some(arr) = addresses.as_array_mut() {
                arr.push(address.clone());
            }
            let next_version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1) + 1;
            obj.insert("version".to_string(), serde_json::json!(next_version));
            obj.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
            updated = Some(serde_json::Value::Object(obj.clone()));
        }
        break;
    }

    let customer = if let Some(customer) = updated.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        Some(customer)
    } else if !deferred {
        if let Some(remote_customer) = sync_customer_fetch_remote_by_id(&db, &customer_id).await? {
            let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
            let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
            write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
            Some(customer)
        } else {
            None
        }
    } else {
        let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
        let placeholder = normalize_customer_for_cache(serde_json::json!({
            "id": customer_id,
            "addresses": [address.clone()],
        }));
        let customer = upsert_customer_cache_entry(&mut cache, placeholder);
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        Some(customer)
    };

    if deferred {
        let address_id = value_str(&address, &["id", "addressId"]).ok_or("Missing address id")?;
        let version = value_i64(&address, &["version"]).unwrap_or(1);
        enqueue_customer_sync_item(
            &db,
            "customer_addresses",
            &address_id,
            "INSERT",
            &queue_payload,
            version,
        )?;
    }

    let warning = deferred.then_some(CUSTOMER_ADDRESS_SAVED_OFFLINE);
    if let Some(customer) = customer.clone() {
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({
            "success": true,
            "queued": deferred,
            "offline": deferred,
            "warning": warning,
            "data": address,
            "customer": customer
        }));
    }

    Ok(serde_json::json!({
        "success": true,
        "queued": deferred,
        "offline": deferred,
        "warning": warning,
        "data": address
    }))
}

/// A deferred address edit merged into the cached address the way the office
/// PATCH applies it once the edit reaches it (desktop-address counterpart
/// request, 2026-09-29). Symptom: a coordinates-only write-back, or any
/// partial edit, that was queued (offline, 5xx, soft auth) or folded into a
/// queued INSERT left the saved address without its street, city, postal
/// code, floor and bell name. Root cause: the cached address was replaced by
/// the partial edit. Now only the fields the edit carries change (a street
/// also sets its `street` mirror, notes their `delivery_notes` mirror), the
/// point follows `address_point_edit` (explicit nulls clear it), a text edit
/// without its own formatted address rebuilds it from street, city and
/// postal code as the office does, and the address keeps its office
/// `version`: nothing reached the office yet.
fn merge_address_edit_into_cached_address(
    cached: &serde_json::Value,
    edit: &serde_json::Value,
) -> serde_json::Value {
    let (Some(current), Some(changes)) = (cached.as_object(), edit.as_object()) else {
        return normalize_address_for_cache(edit.clone());
    };
    let mut merged = current.clone();
    for (key, value) in changes {
        match key.as_str() {
            "id" | "version" | "expected_version" | "coordinates" | "latitude" | "longitude" => {}
            "street_address" => {
                merged.insert("street_address".to_string(), value.clone());
                merged.insert("street".to_string(), value.clone());
            }
            "notes" => {
                merged.insert("notes".to_string(), value.clone());
                merged.insert("delivery_notes".to_string(), value.clone());
            }
            "place_id" => {
                merged.insert("place_id".to_string(), value.clone());
                merged.insert("google_place_id".to_string(), value.clone());
            }
            _ => {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    if ADDRESS_TEXT_KEYS
        .iter()
        .any(|key| changes.contains_key(*key))
        && !changes.contains_key("formatted_address")
    {
        let text_source = serde_json::Value::Object(merged.clone());
        let text = [
            string_field(&text_source, &["street_address", "street"]),
            string_field(&text_source, &["city"]),
            string_field(&text_source, &["postal_code", "postalCode"]),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ");
        merged.insert(
            "formatted_address".to_string(),
            if text.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::json!(text)
            },
        );
    }
    match address_point_edit(edit, stored_address_point(cached)) {
        AddressPointEdit::Untouched => {}
        AddressPointEdit::Clear => {
            for key in ADDRESS_POINT_KEYS {
                merged.insert(key.to_string(), serde_json::Value::Null);
            }
        }
        AddressPointEdit::Set { lat, lng } => {
            merged.insert(
                "coordinates".to_string(),
                serde_json::json!({ "lat": lat, "lng": lng }),
            );
            merged.insert("latitude".to_string(), serde_json::json!(lat));
            merged.insert("longitude".to_string(), serde_json::json!(lng));
        }
    }
    merged.insert(
        "updatedAt".to_string(),
        serde_json::json!(Utc::now().to_rfc3339()),
    );
    serde_json::Value::Object(merged)
}

/// How an address edit lands in the cached customer.
enum CachedAddressWrite {
    /// The office's record: it replaces the cached address (a placeholder id
    /// is replaced by the office's own).
    Replace(serde_json::Value),
    /// A deferred edit (queued, or folded into a queued INSERT): merged into
    /// the cached address.
    Merge(serde_json::Value),
}

/// Write an address edit into the cached customer `customer_id` and bump the
/// customer's version. Returns the customer and the address as cached now,
/// or `None` when the customer is not cached.
fn write_address_edit_to_cached_customer(
    cache: &mut [serde_json::Value],
    customer_id: &str,
    target_id: &str,
    write: CachedAddressWrite,
) -> Option<(serde_json::Value, serde_json::Value)> {
    let customer = cache
        .iter_mut()
        .find(|entry| value_str(entry, &["id", "customerId"]).as_deref() == Some(customer_id))?
        .as_object_mut()?;
    let addresses = customer
        .entry("addresses".to_string())
        .or_insert_with(|| serde_json::json!([]));
    if !addresses.is_array() {
        *addresses = serde_json::json!([]);
    }
    let slots = addresses.as_array_mut()?;
    let index = slots
        .iter()
        .position(|address| value_str(address, &["id", "addressId"]).as_deref() == Some(target_id));
    let address = match (write, index) {
        (CachedAddressWrite::Replace(address), _) => address,
        (CachedAddressWrite::Merge(edit), Some(index)) => {
            merge_address_edit_into_cached_address(&slots[index], &edit)
        }
        (CachedAddressWrite::Merge(edit), None) => normalize_address_for_cache(edit),
    };
    match index {
        Some(index) => slots[index] = address.clone(),
        None => slots.push(address.clone()),
    }
    let next_version = customer
        .get("version")
        .and_then(|v| v.as_i64())
        .unwrap_or(1)
        + 1;
    customer.insert("version".to_string(), serde_json::json!(next_version));
    customer.insert(
        "updatedAt".to_string(),
        serde_json::json!(Utc::now().to_rfc3339()),
    );
    Some((serde_json::Value::Object(customer.clone()), address))
}

/// The body of an address edit as it is sent, queued or folded.
fn build_address_update_queue_payload(
    updates: &serde_json::Value,
    customer_id: &str,
    recreates_placeholder: bool,
    expected_version: i64,
) -> Result<serde_json::Value, String> {
    let mut queue_payload = build_remote_address_body(updates);
    if queue_payload
        .as_object()
        .map(|obj| obj.is_empty())
        .unwrap_or(true)
    {
        return Err("Missing address updates".into());
    }
    if let Some(obj) = queue_payload.as_object_mut() {
        obj.insert("customer_id".to_string(), serde_json::json!(customer_id));
        if recreates_placeholder && !obj.contains_key("is_default") {
            // A legacy fallback represents the customer's former single/default
            // address. Migrating it to customer_addresses must keep that role.
            obj.insert("is_default".to_string(), serde_json::json!(true));
        }
        if !recreates_placeholder && expected_version > 0 {
            obj.insert(
                "expected_version".to_string(),
                serde_json::json!(expected_version),
            );
        }
    }
    Ok(queue_payload)
}

/// Result of one address edit on this terminal, before the events.
enum AddressUpdateApplied {
    /// The office refused the edit with a code: nothing cached or queued.
    Rejected(serde_json::Value),
    Written {
        /// The address as cached now.
        address: serde_json::Value,
        /// The cached customer after the write; `None` when it is not cached.
        customer: Option<serde_json::Value>,
        /// The office has not seen the edit yet (queued or folded).
        deferred: bool,
    },
}

/// Apply the office's answer to an address edit (`None`: nothing was sent,
/// the edit was folded into a queued INSERT). The office's record replaces
/// the cached address; a coded application 4xx is shown and nothing is
/// cached or queued; a deferrable failure (transport, 5xx, 408/429, soft
/// auth, platform page) and a folded edit are merged into the cached address,
/// and only the deferrable failure is queued.
fn apply_customer_address_update_outcome(
    db: &db::DbState,
    customer_id: &str,
    target_id: &str,
    queue_payload: &serde_json::Value,
    recreates_placeholder: bool,
    expected_version: i64,
    remote: Option<Result<serde_json::Value, crate::api::AdminFetchError>>,
) -> Result<AddressUpdateApplied, String> {
    let deferred_edit = || {
        let mut edit = queue_payload.clone();
        if let Some(obj) = edit.as_object_mut() {
            obj.insert("id".to_string(), serde_json::json!(target_id));
            obj.remove("expected_version");
        }
        edit
    };
    let (write, enqueue_update) = match remote {
        Some(Ok(remote_address)) => (
            CachedAddressWrite::Replace(normalize_address_for_cache(remote_address)),
            false,
        ),
        Some(Err(error)) => {
            if let Some(rejection) = customer_write_rejection(&error, "customer_update_address") {
                return Ok(AddressUpdateApplied::Rejected(rejection));
            }
            (CachedAddressWrite::Merge(deferred_edit()), true)
        }
        None => (CachedAddressWrite::Merge(deferred_edit()), false),
    };
    let deferred = matches!(write, CachedAddressWrite::Merge(_));
    let uncached_address = match &write {
        CachedAddressWrite::Replace(address) => address.clone(),
        CachedAddressWrite::Merge(edit) => normalize_address_for_cache(edit.clone()),
    };

    // Read after the office call, so a sync that landed meanwhile stays.
    let mut cache = read_local_json_array(db, "customer_cache_v1")?;
    let (address, customer) =
        match write_address_edit_to_cached_customer(&mut cache, customer_id, target_id, write) {
            Some((customer, address)) => {
                write_local_json(db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
                (address, Some(customer))
            }
            None => (uncached_address, None),
        };

    if enqueue_update {
        let version = value_i64(&address, &["version"]).unwrap_or(expected_version.max(1));
        enqueue_customer_sync_item(
            db,
            "customer_addresses",
            target_id,
            if recreates_placeholder {
                "INSERT"
            } else {
                "UPDATE"
            },
            queue_payload,
            version,
        )?;
    }
    Ok(AddressUpdateApplied::Written {
        address,
        customer,
        deferred,
    })
}

#[tauri::command]
pub async fn customer_update_address(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_update_address_payload(arg0, arg1, arg2)?;
    let target_id = payload.target_id;
    let updates = payload.updates;
    let expected_version = payload.expected_version;
    let cache = read_local_json_array(&db, "customer_cache_v1")?;
    let hinted_customer_id =
        value_str(&updates, &["customer_id", "customerId"]).map(|id| id.trim().to_string());
    let requested_customer_id = hinted_customer_id
        .filter(|id| !id.is_empty())
        .or_else(|| {
            cache.iter().find_map(|entry| {
                let customer_id = value_str(entry, &["id", "customerId"])?;
                let has_address = entry
                    .get("addresses")
                    .and_then(|v| v.as_array())
                    .map(|addresses| {
                        addresses.iter().any(|addr| {
                            value_str(addr, &["id", "addressId"])
                                .map(|address_id| address_id == target_id)
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);
                if has_address {
                    Some(customer_id)
                } else {
                    None
                }
            })
        })
        .ok_or("Customer/address not found")?;
    let (customer_id, office_knows_customer) =
        match plan_customer_address_write(&db, &requested_customer_id)? {
            CustomerAddressWritePlan::Refused(response) => return Ok(response),
            CustomerAddressWritePlan::Office(customer_id) => (customer_id, true),
            CustomerAddressWritePlan::PendingLocal(customer_id) => (customer_id, false),
        };
    let recreates_placeholder = sync_queue::is_local_placeholder_id(&target_id);

    let queue_payload = build_address_update_queue_payload(
        &updates,
        &customer_id,
        recreates_placeholder,
        expected_version,
    )?;

    // An address saved on this terminal and not sent yet: the edit rides on
    // its queued INSERT (a PATCH could only answer 404).
    let folded_into_queue =
        match merge_address_edit_into_queued_address_insert(&db, &target_id, &queue_payload)? {
            sync_queue::QueuedInsertMerge::Merged { .. } => true,
            sync_queue::QueuedInsertMerge::InFlight => {
                return Ok(customer_rejection_response(None, CUSTOMER_SYNC_IN_PROGRESS))
            }
            sync_queue::QueuedInsertMerge::NotQueued if office_knows_customer => false,
            sync_queue::QueuedInsertMerge::NotQueued => {
                match merge_address_edit_into_customer_insert(&db, &customer_id, &queue_payload)? {
                    sync_queue::QueuedInsertMerge::Merged { .. } => true,
                    // The INSERT left the queue between the plan and now:
                    // it is syncing or just synced; a retry reaches the office.
                    _ => return Ok(customer_rejection_response(None, CUSTOMER_SYNC_IN_PROGRESS)),
                }
            }
        };

    let remote_result = if folded_into_queue {
        None
    } else if recreates_placeholder {
        // `legacy:<customer-id>` and `local-*` are renderer/local cache
        // placeholders, never canonical customer_addresses UUIDs. Sending
        // either to PATCH guarantees a 404. Materialize the edited address
        // through POST and replace the placeholder with the returned UUID.
        Some(sync_customer_address_remote(&db, &customer_id, &queue_payload).await)
    } else {
        Some(sync_customer_address_update_remote(&db, &customer_id, &target_id, &updates).await)
    };
    let (address, cached_customer, deferred) = match apply_customer_address_update_outcome(
        &db,
        &customer_id,
        &target_id,
        &queue_payload,
        recreates_placeholder,
        expected_version,
        remote_result,
    )? {
        AddressUpdateApplied::Rejected(response) => return Ok(response),
        AddressUpdateApplied::Written {
            address,
            customer,
            deferred,
        } => (address, customer, deferred),
    };

    let customer = match cached_customer {
        Some(customer) => Some(customer),
        None if !deferred => match sync_customer_fetch_remote_by_id(&db, &customer_id).await? {
            Some(remote_customer) => {
                let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
                let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
                write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
                Some(customer)
            }
            None => None,
        },
        None => None,
    };

    if let Some(customer) = customer.clone() {
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
    }

    Ok(serde_json::json!({
        "success": true,
        "queued": deferred,
        "offline": deferred,
        "warning": deferred.then_some(CUSTOMER_ADDRESS_SAVED_OFFLINE),
        "data": address,
        "customer": customer
    }))
}

#[tauri::command]
pub async fn customer_delete_address(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_delete_address_payload(arg0, arg1)?;
    let address_id = payload.address_id;
    let plan = plan_customer_address_write(&db, &payload.customer_id)?;
    if let CustomerAddressWritePlan::Refused(response) = plan {
        return Ok(response);
    }
    let (never_reached_office, refusal) =
        remove_unsynced_address_from_queue(&db, &plan, &address_id)?;
    if let Some(code) = refusal {
        return Ok(customer_rejection_response(None, code));
    }
    let (customer_id, deferred) = match plan {
        CustomerAddressWritePlan::Office(customer_id) if !never_reached_office => {
            let deferred =
                match sync_customer_address_delete_remote(&db, &customer_id, &address_id).await {
                    Ok(()) => false,
                    Err(error) => {
                        if let Some(rejection) =
                            customer_write_rejection(&error, "customer_delete_address")
                        {
                            return Ok(rejection);
                        }
                        true
                    }
                };
            (customer_id, deferred)
        }
        CustomerAddressWritePlan::Office(customer_id)
        | CustomerAddressWritePlan::PendingLocal(customer_id) => (customer_id, false),
        CustomerAddressWritePlan::Refused(response) => return Ok(response),
    };

    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let mut updated_customer: Option<serde_json::Value> = None;
    let mut removed_version = 1;
    let mut cache_touched = false;

    for entry in &mut cache {
        let cached_customer_id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if cached_customer_id != customer_id {
            continue;
        }

        if let Some(customer) = entry.as_object_mut() {
            if let Some(addresses) = customer
                .get_mut("addresses")
                .and_then(|value| value.as_array_mut())
            {
                if let Some(address) = addresses.iter().find(|address| {
                    value_str(address, &["id", "addressId"])
                        .is_some_and(|candidate| candidate == address_id)
                }) {
                    removed_version = value_i64(address, &["version"]).unwrap_or(1);
                }
                addresses.retain(|address| {
                    value_str(address, &["id", "addressId"])
                        .map(|candidate| candidate != address_id)
                        .unwrap_or(true)
                });
            }
            let next_version = customer
                .get("version")
                .and_then(|value| value.as_i64())
                .unwrap_or(1)
                + 1;
            customer.insert("version".to_string(), serde_json::json!(next_version));
            customer.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
            updated_customer = Some(serde_json::Value::Object(customer.clone()));
            cache_touched = true;
        }
        break;
    }

    if cache_touched {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
    }

    if deferred {
        enqueue_customer_sync_item(
            &db,
            "customer_addresses",
            &address_id,
            "DELETE",
            &serde_json::json!({
                "customer_id": customer_id,
                "address_id": address_id,
            }),
            removed_version,
        )?;
    }

    if let Some(customer) = updated_customer.clone() {
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer);
    }

    Ok(serde_json::json!({
        "success": true,
        "queued": deferred,
        "offline": deferred,
        "warning": deferred.then_some(CUSTOMER_ADDRESS_SAVED_OFFLINE),
        "data": {
            "id": address_id,
            "deleted": true
        },
        "customer": updated_customer
    }))
}

#[tauri::command]
pub async fn customer_get_conflicts(
    _arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
    Ok(serde_json::json!(conflicts))
}

#[tauri::command]
pub async fn customer_resolve_conflict(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    arg2: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_resolve_conflict_payload(arg0, arg1, arg2)?;
    let conflict_id = payload.conflict_id;
    let strategy = payload.strategy;
    let data = payload.data;
    let mut conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
    let mut resolved: Option<serde_json::Value> = None;
    conflicts.retain(|entry| {
        let id = value_str(entry, &["id", "conflictId"]).unwrap_or_default();
        if id == conflict_id {
            resolved = Some(entry.clone());
            false
        } else {
            true
        }
    });
    write_local_json(
        &db,
        "customer_conflicts_v1",
        &serde_json::Value::Array(conflicts),
    )?;

    if let Some(conflict) = resolved.clone() {
        if strategy == "merge" || strategy == "client_wins" {
            if let Some(customer_id) = value_str(&conflict, &["customerId", "customer_id"]) {
                let _ = customer_update(
                    Some(serde_json::json!(customer_id)),
                    Some(data),
                    None,
                    db,
                    app.clone(),
                )
                .await;
            }
        }
        let _ = app.emit(
            "customer_conflict_resolved",
            serde_json::json!({
                "conflictId": conflict_id,
                "strategy": strategy
            }),
        );
        return Ok(serde_json::json!({ "success": true }));
    }
    Ok(serde_json::json!({ "success": false, "error": "Conflict not found" }))
}

/// Resolve a customer INSERT the office rejected as a duplicate, the only way
/// the office allows: by selecting its existing record explicitly.
///
/// The office answers `DUPLICATE` and refuses to merge — deliberately, so no
/// till can pull a stranger's record by guessing a phone number. A replay
/// worker cannot «select it explicitly», so the row sits in the queue forever
/// and the sync card stays red. This is that selection, made by an operator
/// pressing a button: the same phone lookup the till runs whenever a customer
/// calls, followed by adopting whatever the office hands back.
///
/// Read-only against the office. Every write it makes is local.
pub(crate) async fn resolve_duplicate_customer_conflict(
    db: &db::DbState,
    sync_state: &crate::sync::SyncState,
    cancellation: &tokio_util::sync::CancellationToken,
    item_id: &str,
) -> Result<sync_queue::DuplicateCustomerAdoption, String> {
    let item_id = item_id.to_string();
    let conflict = crate::sync::guarded_renderer_local_mutation(db, sync_state, cancellation, {
        let item_id = item_id.clone();
        move |conn| sync_queue::find_duplicate_customer_conflict(conn, item_id.as_str())
    })
    .await?
    .ok_or_else(|| "DUPLICATE_CONFLICT_ITEM_NOT_A_CUSTOMER_DUPLICATE".to_string())?;

    let phone = conflict
        .phone
        .clone()
        .ok_or_else(|| "DUPLICATE_CONFLICT_QUEUED_CUSTOMER_HAS_NO_PHONE".to_string())?;

    let remote_customer = sync_customer_fetch_remote_by_phone(db, &phone)
        .await?
        .ok_or_else(|| "DUPLICATE_CONFLICT_SERVER_CUSTOMER_NOT_FOUND".to_string())?;
    let normalized = normalize_customer_for_cache(remote_customer);

    crate::sync::guarded_renderer_local_mutation(db, sync_state, cancellation, move |conn| {
        sync_queue::adopt_remote_customer_for_conflict(conn, &conflict, &normalized)
    })
    .await
}

#[cfg(test)]
mod dto_tests {
    use super::*;

    #[test]
    fn caller_id_phone_key_matches_the_renderer_lookup_normalization() {
        assert_eq!(caller_id_phone_key("+30 210 123 4567"), "2101234567");
        assert_eq!(caller_id_phone_key("00302101234567"), "2101234567");
        assert_eq!(caller_id_phone_key("210-123-4567"), "2101234567");
        assert_eq!(caller_id_phone_key("+41779990214"), "779990214");
        assert_eq!(caller_id_phone_key("0779990214"), "779990214");
        // Ten-digit national numbers keep a leading country-code look-alike.
        assert_eq!(caller_id_phone_key("3012345678"), "3012345678");
    }

    #[test]
    fn caller_id_cache_lookup_finds_a_known_customer_without_any_request() {
        let cache = vec![
            serde_json::json!({ "id": "c-other", "name": "Other", "phone": "2109999999" }),
            serde_json::json!({
                "id": "c-known",
                "name": "Μαρία",
                "phone": "+30 210 123 4567",
                "addresses": [{ "id": "a-1", "street_address": "Ερμού 1" }]
            }),
        ];

        let found = find_cached_customer_for_caller_id(cache.clone(), "2101234567")
            .expect("known caller resolves from the local cache");
        assert_eq!(found["id"], "c-known");
        assert_eq!(found["addresses"][0]["street_address"], "Ερμού 1");
        assert_eq!(
            find_cached_customer_for_caller_id(cache.clone(), "00302101234567").unwrap()["id"],
            "c-known"
        );
        assert!(find_cached_customer_for_caller_id(cache.clone(), "6900000000").is_none());
        assert!(find_cached_customer_for_caller_id(cache, "12").is_none());
    }

    #[test]
    fn parse_phone_payload_accepts_the_cache_only_flag() {
        let cache_only = parse_phone_payload(Some(serde_json::json!({
            "phone": "2101234567",
            "cacheOnly": true
        })))
        .expect("cache-only payload should parse");
        assert!(cache_only.cache_only);
        let plain = parse_phone_payload(Some(serde_json::json!("2101234567")))
            .expect("plain payload should parse");
        assert!(!plain.cache_only);
    }

    #[test]
    fn parse_phone_payload_supports_string_and_alias() {
        let from_string = parse_phone_payload(Some(serde_json::json!("2101234567")))
            .expect("string phone payload should parse");
        let from_alias = parse_phone_payload(Some(serde_json::json!({
            "customerPhone": " 6999999999 "
        })))
        .expect("alias phone payload should parse");
        assert_eq!(from_string.phone, "2101234567");
        assert_eq!(from_alias.phone, "6999999999");
    }

    #[test]
    fn parse_customer_update_payload_supports_legacy_tuple() {
        let parsed = parse_customer_update_payload(
            Some(serde_json::json!("cust-1")),
            Some(serde_json::json!({ "name": "Updated" })),
            Some(serde_json::json!(7)),
        )
        .expect("customer update tuple payload should parse");
        assert_eq!(parsed.customer_id, "cust-1");
        assert_eq!(parsed.expected_version, 7);
        assert_eq!(
            parsed.updates.get("name").and_then(|v| v.as_str()),
            Some("Updated")
        );
    }

    #[test]
    fn parse_customer_ban_payload_supports_legacy_args() {
        let parsed = parse_customer_ban_payload(
            Some(serde_json::json!("cust-2")),
            Some(serde_json::json!(true)),
        )
        .expect("customer ban tuple payload should parse");
        assert_eq!(parsed.customer_id, "cust-2");
        assert!(parsed.is_banned);
    }

    #[test]
    fn customer_response_pagination_detects_next_page() {
        assert!(customer_response_has_next_page(&serde_json::json!({
            "pagination": {
                "page": 1,
                "totalPages": 2,
                "hasNextPage": true
            }
        })));

        assert!(!customer_response_has_next_page(&serde_json::json!({
            "pagination": {
                "page": 2,
                "totalPages": 2,
                "hasNextPage": false
            }
        })));
    }

    #[test]
    fn extract_customers_from_list_response_uses_customers_array() {
        let customers = extract_customers_from_pos_response(&serde_json::json!({
            "success": true,
            "customers": [
                { "id": "cust-1", "name": "Customer One" },
                { "id": "cust-2", "name": "Customer Two" }
            ],
            "customer": null,
            "multiple": true
        }));

        assert_eq!(customers.len(), 2);
        assert_eq!(
            customers[0].get("id").and_then(|v| v.as_str()),
            Some("cust-1")
        );
        assert_eq!(
            customers[1].get("id").and_then(|v| v.as_str()),
            Some("cust-2")
        );
    }

    #[test]
    fn parse_customer_update_address_payload_supports_object() {
        let parsed = parse_customer_update_address_payload(
            Some(serde_json::json!({
                "addressId": "addr-1",
                "expectedVersion": 3
            })),
            Some(serde_json::json!({ "floor": "2" })),
            None,
        )
        .expect("address update payload should parse");
        assert_eq!(parsed.target_id, "addr-1");
        assert_eq!(parsed.expected_version, 3);
        assert_eq!(
            parsed.updates.get("floor").and_then(|v| v.as_str()),
            Some("2")
        );
    }

    #[test]
    fn parse_customer_delete_address_payload_supports_tuple_and_object() {
        let tuple = parse_customer_delete_address_payload(
            Some(serde_json::json!("cust-1")),
            Some(serde_json::json!("addr-1")),
        )
        .expect("address delete tuple should parse");
        assert_eq!(tuple.customer_id, "cust-1");
        assert_eq!(tuple.address_id, "addr-1");

        let object = parse_customer_delete_address_payload(
            Some(serde_json::json!({
                "customerId": "cust-2",
                "addressId": "addr-2"
            })),
            None,
        )
        .expect("address delete object should parse");
        assert_eq!(object.customer_id, "cust-2");
        assert_eq!(object.address_id, "addr-2");
    }

    #[test]
    fn parse_customer_resolve_conflict_payload_supports_legacy_tuple() {
        let parsed = parse_customer_resolve_conflict_payload(
            Some(serde_json::json!("conflict-1")),
            Some(serde_json::json!("client_wins")),
            Some(serde_json::json!({ "name": "Merged" })),
        )
        .expect("resolve conflict tuple payload should parse");
        assert_eq!(parsed.conflict_id, "conflict-1");
        assert_eq!(parsed.strategy, "client_wins");
        assert_eq!(
            parsed.data.get("name").and_then(|v| v.as_str()),
            Some("Merged")
        );
    }

    #[test]
    fn build_remote_customer_create_body_prefers_street_only_address_fields() {
        let source = serde_json::json!({
            "name": "Endrit Bashi",
            "phone": "+44 20 7946 0018",
            "phoneCountryCode": "GB",
            "addresses": [{
                "street_address": "Xenofontos 28",
                "city": "Thessaloniki",
                "postal_code": "54641",
                "floor_number": "2",
                "name_on_ringer": "Bashi"
            }]
        });

        let body = build_remote_customer_create_body(&source);
        assert_eq!(
            body.get("name").and_then(|v| v.as_str()),
            Some("Endrit Bashi")
        );
        assert_eq!(
            body.get("phone").and_then(|v| v.as_str()),
            Some("+44 20 7946 0018")
        );
        assert_eq!(
            body.get("phone_country_code").and_then(|v| v.as_str()),
            Some("GB")
        );
        let local = build_local_customer_from_source(&source);
        assert_eq!(
            local.get("phone_country_code").and_then(|v| v.as_str()),
            Some("GB")
        );
        assert_eq!(
            body.get("address").and_then(|v| v.as_str()),
            Some("Xenofontos 28")
        );
        assert_eq!(
            body.get("city").and_then(|v| v.as_str()),
            Some("Thessaloniki")
        );
        assert_eq!(
            body.get("postal_code").and_then(|v| v.as_str()),
            Some("54641")
        );
        assert_eq!(body.get("floor_number").and_then(|v| v.as_str()), Some("2"));
    }

    #[test]
    fn build_remote_customer_update_body_preserves_phone_clear_and_country_alias() {
        let clear = build_remote_customer_update_body(&serde_json::json!({
            "phone": null,
            "phone_country_code": null
        }));
        assert_eq!(clear.get("phone"), Some(&serde_json::Value::Null));
        assert_eq!(
            clear.get("phone_country_code"),
            Some(&serde_json::Value::Null)
        );

        let international = build_remote_customer_update_body(&serde_json::json!({
            "phone": "+44 20 7946 0018",
            "phoneCountryCode": "GB"
        }));
        assert_eq!(
            international.get("phone").and_then(|v| v.as_str()),
            Some("+44 20 7946 0018")
        );
        assert_eq!(
            international
                .get("phone_country_code")
                .and_then(|v| v.as_str()),
            Some("GB")
        );
    }

    #[test]
    fn address_update_queue_preserves_explicit_flat_coordinate_clear() {
        let body = build_address_update_queue_payload(
            &serde_json::json!({ "latitude": null, "longitude": null }),
            "customer-1",
            false,
            4,
        )
        .expect("flat null pair is an explicit location clear, not an empty update");
        assert_eq!(
            body,
            serde_json::json!({
                "customer_id": "customer-1", "expected_version": 4,
                "latitude": null, "longitude": null
            })
        );
        let floor_only = build_address_update_queue_payload(
            &serde_json::json!({ "floor_number": "2" }),
            "customer-1",
            false,
            4,
        )
        .expect("floor-only update");
        assert!(floor_only.get("coordinates").is_none());
        assert!(floor_only.get("latitude").is_none());
        assert!(floor_only.get("longitude").is_none());
    }

    #[test]
    fn build_remote_address_body_maps_known_aliases() {
        let source = serde_json::json!({
            "street": "Xenofontos 28",
            "city": "Thessaloniki",
            "postalCode": "54641",
            "floor": "2",
            "nameOnRinger": "Bashi",
            "isDefault": true
        });

        let body = build_remote_address_body(&source);
        assert_eq!(
            body.get("street_address").and_then(|v| v.as_str()),
            Some("Xenofontos 28")
        );
        assert_eq!(
            body.get("city").and_then(|v| v.as_str()),
            Some("Thessaloniki")
        );
        assert_eq!(
            body.get("postal_code").and_then(|v| v.as_str()),
            Some("54641")
        );
        assert_eq!(body.get("floor_number").and_then(|v| v.as_str()), Some("2"));
        assert_eq!(
            body.get("name_on_ringer").and_then(|v| v.as_str()),
            Some("Bashi")
        );
        assert_eq!(body.get("is_default").and_then(|v| v.as_bool()), Some(true));
    }

    // ---------------------------------------------------------------
    // Layer 3 of the customer ↔ order ↔ loyalty linkage repair —
    // resolve_customer_id_from_cache_conn coverage
    // ---------------------------------------------------------------

    fn setup_local_settings_table(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_settings (
                id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
                setting_category TEXT NOT NULL,
                setting_key TEXT NOT NULL,
                setting_value TEXT NOT NULL,
                last_sync TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(setting_category, setting_key)
            );",
        )
        .expect("create local_settings table");
    }

    fn write_cache(conn: &rusqlite::Connection, value: serde_json::Value) {
        crate::db::set_setting(conn, "local", "customer_cache_v1", &value.to_string())
            .expect("seed customer cache");
    }

    #[test]
    fn resolve_customer_id_from_cache_returns_id_on_phone_match() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        setup_local_settings_table(&conn);
        let cust_id = "11111111-2222-3333-4444-555555555555";
        write_cache(
            &conn,
            serde_json::json!([{
                "id": cust_id,
                "name": "Ada Lovelace",
                "phone": "6971729133"
            }]),
        );

        let resolved = resolve_customer_id_from_cache_conn(&conn, "6971729133");
        assert_eq!(resolved.as_deref(), Some(cust_id));
    }

    #[test]
    fn resolve_customer_id_from_cache_normalizes_phone_before_matching() {
        // normalize_phone (data_helpers.rs:36) strips ALL non-digit
        // characters — spaces, dashes, parens, plus signs. This test
        // verifies that input with formatting characters matches a
        // cache entry stored as bare digits. Country-prefix semantics
        // (e.g. matching "6971729133" to "+30 6971729133") is NOT in
        // scope — the resulting normalized strings differ ("6971729133"
        // vs "306971729133") and that's correct: matching across
        // country prefixes risks linking different customers and is
        // intentionally rejected.
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        setup_local_settings_table(&conn);
        let cust_id = "11111111-2222-3333-4444-555555555555";
        write_cache(
            &conn,
            serde_json::json!([{ "id": cust_id, "phone": "6971729133" }]),
        );

        // Input with spaces, dashes, parens — all stripped by normalize.
        let resolved = resolve_customer_id_from_cache_conn(&conn, "(697) 172-9133");
        assert_eq!(resolved.as_deref(), Some(cust_id));
    }

    #[test]
    fn resolve_customer_id_from_cache_returns_none_on_miss() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        setup_local_settings_table(&conn);
        write_cache(
            &conn,
            serde_json::json!([{
                "id": "11111111-2222-3333-4444-555555555555",
                "phone": "6971111111"
            }]),
        );

        let resolved = resolve_customer_id_from_cache_conn(&conn, "6979999999");
        assert!(resolved.is_none());
    }

    #[test]
    fn resolve_customer_id_from_cache_rejects_non_uuid_synthetic_ids() {
        // The customer_lookup_by_phone fallback path emits
        // synthetic ids of the form `cust-<uuid>` for orders-history
        // matches. Those would later be rejected by the renderer's
        // resolvePersistedCustomerId, so we filter them out at this
        // gate too — return None instead of bubbling them up to the
        // sync::create_order INSERT.
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        setup_local_settings_table(&conn);
        write_cache(
            &conn,
            serde_json::json!([{
                "id": "cust-11111111-2222-3333-4444-555555555555",
                "phone": "6971729133"
            }]),
        );

        let resolved = resolve_customer_id_from_cache_conn(&conn, "6971729133");
        assert!(resolved.is_none(), "non-UUID synthetic id must be rejected");
    }

    #[test]
    fn resolve_customer_id_from_cache_returns_none_on_empty_phone() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        setup_local_settings_table(&conn);
        let resolved = resolve_customer_id_from_cache_conn(&conn, "");
        assert!(resolved.is_none());
    }

    #[test]
    fn resolve_customer_id_from_cache_handles_missing_cache_row() {
        // No customer_cache_v1 row at all — function should return
        // None gracefully (offline / first-launch case).
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        setup_local_settings_table(&conn);
        let resolved = resolve_customer_id_from_cache_conn(&conn, "6971729133");
        assert!(resolved.is_none());
    }

    // -----------------------------------------------------------------------
    // Customer write failure classification (incident 2026-09-28)
    // -----------------------------------------------------------------------

    use crate::api::AdminFetchError;

    fn http_error(status: u16, body: &str) -> AdminFetchError {
        AdminFetchError::from_http_response_for_test(status, body)
    }

    fn rejected(status: u16, code: &str) -> CustomerRemoteFailure {
        CustomerRemoteFailure::Rejected {
            status: Some(status),
            code: code.to_string(),
        }
    }

    #[test]
    fn classifier_defers_connectivity_local_and_transient_failures() {
        let deferrable = [
            AdminFetchError::transport("Cannot reach admin dashboard"),
            AdminFetchError::transport("Failed to read admin response body"),
            AdminFetchError::statusless("TERMINAL_REBIND_PENDING"),
            AdminFetchError::statusless("Invalid JSON from admin dashboard: eof"),
            AdminFetchError::statusless("Customer API response missing data"),
            http_error(408, r#"{"success":false,"error":"Request timeout"}"#),
            http_error(
                429,
                r#"{"success":false,"error":"Too many requests","code":"RATE_LIMITED"}"#,
            ),
            http_error(500, r#"{"success":false,"error":"Server error"}"#),
            http_error(502, "Bad gateway"),
            http_error(
                503,
                r#"{"success":false,"error":"Unavailable","code":"CREATE_ERROR"}"#,
            ),
        ];
        for error in deferrable {
            assert_eq!(
                classify_customer_remote_failure(&error),
                CustomerRemoteFailure::Deferrable,
                "{error}"
            );
        }
    }

    #[test]
    fn classifier_defers_soft_terminal_auth_and_platform_pages() {
        let deferrable = [
            http_error(401, r#"{"error":"Terminal API key is invalid"}"#),
            http_error(
                401,
                r#"{"success":false,"error":"Terminal auth","code":"terminal_not_found"}"#,
            ),
            http_error(403, r#"{"error":"MODULE_REQUIRED"}"#),
            http_error(
                403,
                r#"{"success":false,"error":"Terminal not authorized","code":"TERMINAL_INACTIVE"}"#,
            ),
            // Vercel platform failures in front of the app carry no app code.
            http_error(
                404,
                "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n",
            ),
            http_error(402, "Payment required\n\nDEPLOYMENT_DISABLED\n"),
            http_error(410, "<!DOCTYPE html><html><body>Gone</body></html>"),
            http_error(
                404,
                r#"{"error":{"code":"DEPLOYMENT_NOT_FOUND","message":"not found"}}"#,
            ),
            http_error(400, ""),
        ];
        for error in deferrable {
            assert_eq!(
                classify_customer_remote_failure(&error),
                CustomerRemoteFailure::Deferrable,
                "{error}"
            );
        }
    }

    #[test]
    fn classifier_rejects_coded_application_4xx() {
        let cases = [
            (
                http_error(
                    400,
                    r#"{"success":false,"error":"The phone number is invalid","code":"INVALID_PHONE"}"#,
                ),
                rejected(400, "INVALID_PHONE"),
            ),
            (
                http_error(
                    400,
                    r#"{"success":false,"error":"Country required","code":"COUNTRY_CONTEXT_REQUIRED"}"#,
                ),
                rejected(400, "COUNTRY_CONTEXT_REQUIRED"),
            ),
            (
                http_error(
                    400,
                    r#"{"success":false,"code":"INVALID_COORDINATES","error":"Invalid coordinates","reason":"out_of_range"}"#,
                ),
                rejected(400, "INVALID_COORDINATES"),
            ),
            (
                http_error(
                    409,
                    r#"{"success":false,"error":"Customer already exists","code":"DUPLICATE"}"#,
                ),
                rejected(409, "DUPLICATE"),
            ),
            (
                http_error(
                    409,
                    r#"{"success":false,"error":"Customer version mismatch","code":"VERSION_MISMATCH","customer":{"id":"c-1","name":"Synthetic Name","phone":"6948128474"}}"#,
                ),
                rejected(409, "VERSION_MISMATCH"),
            ),
            (
                http_error(
                    404,
                    r#"{"success":false,"error":"Customer not found or access denied"}"#,
                ),
                rejected(404, "NOT_FOUND"),
            ),
            (
                http_error(400, r#"{"success":false,"error":"Missing phone or name"}"#),
                rejected(400, "HTTP_400"),
            ),
            (
                http_error(
                    400,
                    r#"{"success":false,"error":"Validation error","details":{"fieldErrors":{"email":["Invalid email"]}}}"#,
                ),
                rejected(400, "HTTP_400"),
            ),
            (
                http_error(422, r#"{"success":false,"error":"Unprocessable"}"#),
                rejected(422, "HTTP_422"),
            ),
            // Lower-case codes are normalised; unbounded codes fall back.
            (
                http_error(409, r#"{"success":false,"error":"dup","code":"duplicate"}"#),
                rejected(409, "DUPLICATE"),
            ),
            (
                http_error(
                    400,
                    r#"{"success":false,"error":"bad","code":"<script>alert(1)</script>"}"#,
                ),
                rejected(400, "HTTP_400"),
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(
                classify_customer_remote_failure(&error),
                expected,
                "{error}"
            );
        }
    }

    #[test]
    fn rejection_envelope_carries_codes_only_and_flags_version_conflicts() {
        let conflict = customer_rejection_response(Some(409), "VERSION_MISMATCH");
        assert_eq!(conflict["success"], false);
        assert_eq!(conflict["conflict"], true);
        assert_eq!(conflict["code"], "VERSION_MISMATCH");
        assert_eq!(conflict["errorCode"], "VERSION_MISMATCH");
        assert_eq!(conflict["status"], 409);
        assert_eq!(conflict["error"], "VERSION_MISMATCH");

        let invalid_phone = customer_rejection_response(Some(400), "INVALID_PHONE");
        assert_eq!(invalid_phone["code"], "INVALID_PHONE");
        assert!(invalid_phone.get("conflict").is_none());
        assert!(invalid_phone.get("data").is_none());
        assert!(invalid_phone.get("queued").is_none());

        let local = customer_rejection_response(None, "MISSING_PHONE_OR_NAME");
        assert_eq!(local["status"], serde_json::Value::Null);
    }

    #[test]
    fn create_without_name_or_phone_is_refused_before_any_request() {
        let body = build_remote_customer_create_body(&serde_json::json!({
            "name": "  ",
            "phone": "6948128474"
        }));
        assert_eq!(
            customer_create_precondition_failure(&body),
            Some("MISSING_PHONE_OR_NAME")
        );
        let body = build_remote_customer_create_body(&serde_json::json!({ "name": "Synthetic" }));
        assert_eq!(
            customer_create_precondition_failure(&body),
            Some("MISSING_PHONE_OR_NAME")
        );
        let body = build_remote_customer_create_body(&serde_json::json!({
            "name": "Synthetic",
            "phone": "6948128474"
        }));
        assert_eq!(customer_create_precondition_failure(&body), None);
    }

    fn customer_test_db() -> db::DbState {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: std::sync::Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn seed_customer_cache(db: &db::DbState) -> serde_json::Value {
        let cache = serde_json::json!([{
            "id": "4f0c8d9e-2f7a-4d0b-9a55-0e7f2b3c1a10",
            "name": "Existing Synthetic",
            "phone": "6948128474",
            "version": 3,
            "addresses": []
        }]);
        write_local_json(db, "customer_cache_v1", &cache).expect("seed customer cache");
        read_local_json_array(db, "customer_cache_v1")
            .map(serde_json::Value::Array)
            .expect("read seeded cache")
    }

    fn parity_rows(db: &db::DbState) -> Vec<(String, String, String, String)> {
        let conn = db.conn.lock().expect("lock test db");
        let mut stmt = conn
            .prepare(
                "SELECT table_name, operation, module_type, status
                   FROM parity_sync_queue ORDER BY created_at",
            )
            .expect("prepare parity rows");
        stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query parity rows")
        .map(|row| row.expect("parity row"))
        .collect()
    }

    fn create_payload(phone: &str) -> serde_json::Value {
        serde_json::json!({
            "name": "Synthetic Customer",
            "phone": phone,
            "phone_country_code": "GR",
            "address": "Synthetic Street 1",
            "city": "Thessaloniki"
        })
    }

    #[test]
    fn customer_create_rejected_invalid_phone_leaves_cache_and_queue_untouched() {
        // Regression for the 2026-09-28 Z block: a 400 INVALID_PHONE used to
        // create a local `cust-` customer plus a parity INSERT that failed on
        // every replay and blocked the day close.
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let seeded_cache = seed_customer_cache(&db);
        let payload = create_payload("69481284741");
        let queue_payload = build_remote_customer_create_body(&payload);

        let outcome = apply_customer_create_outcome(
            &db,
            &payload,
            &queue_payload,
            Err(http_error(
                400,
                r#"{"success":false,"error":"The phone number is invalid","code":"INVALID_PHONE"}"#,
            )),
        )
        .expect("rejection is a structured response, not an IPC error");

        assert!(outcome.created.is_none(), "no customer_created event");
        assert_eq!(outcome.response["success"], false);
        assert_eq!(outcome.response["code"], "INVALID_PHONE");
        assert_eq!(outcome.response["errorCode"], "INVALID_PHONE");
        assert_eq!(outcome.response["status"], 400);
        assert!(outcome.response.get("queued").is_none());
        assert!(
            !outcome.response.to_string().contains("69481284741"),
            "the rejected phone never travels back in the envelope"
        );
        assert!(parity_rows(&db).is_empty(), "no parity row may be queued");
        assert_eq!(
            serde_json::Value::Array(
                read_local_json_array(&db, "customer_cache_v1").expect("read cache")
            ),
            seeded_cache,
            "customer_cache_v1 must be untouched"
        );
    }

    #[test]
    fn customer_create_rejected_duplicate_is_not_queued_either() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let seeded_cache = seed_customer_cache(&db);
        let payload = create_payload("6948128474");
        let queue_payload = build_remote_customer_create_body(&payload);

        let outcome = apply_customer_create_outcome(
            &db,
            &payload,
            &queue_payload,
            Err(http_error(
                409,
                r#"{"success":false,"error":"Customer already exists","code":"DUPLICATE"}"#,
            )),
        )
        .expect("structured rejection");

        assert_eq!(outcome.response["code"], "DUPLICATE");
        assert_eq!(outcome.response["status"], 409);
        assert!(parity_rows(&db).is_empty());
        assert_eq!(
            serde_json::Value::Array(read_local_json_array(&db, "customer_cache_v1").unwrap()),
            seeded_cache
        );
    }

    #[test]
    fn customer_create_transport_failure_still_saves_offline_and_queues_one_insert() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        seed_customer_cache(&db);
        let payload = create_payload("6948128474");
        let queue_payload = build_remote_customer_create_body(&payload);

        let outcome = apply_customer_create_outcome(
            &db,
            &payload,
            &queue_payload,
            Err(AdminFetchError::transport(
                "Cannot reach admin dashboard at https://admin.example.test",
            )),
        )
        .expect("offline save");

        assert_eq!(outcome.response["success"], true);
        assert_eq!(outcome.response["queued"], true);
        assert_eq!(outcome.response["offline"], true);
        assert_eq!(outcome.response["warning"], CUSTOMER_SAVED_OFFLINE);
        assert!(
            !outcome.response.to_string().contains("admin.example.test"),
            "the remote error text never reaches the renderer"
        );
        let created = outcome.created.expect("offline customer is announced");
        let local_id = created["id"].as_str().expect("local id").to_string();
        assert!(local_id.starts_with("cust-"), "{local_id}");

        assert_eq!(
            parity_rows(&db),
            vec![(
                "customers".to_string(),
                "INSERT".to_string(),
                "customers".to_string(),
                "pending".to_string()
            )]
        );
        let cache = read_local_json_array(&db, "customer_cache_v1").expect("read cache");
        assert_eq!(cache.len(), 2);
        assert!(cache
            .iter()
            .any(|entry| entry["id"].as_str() == Some(local_id.as_str())));
    }

    #[test]
    fn customer_create_server_error_and_platform_page_stay_offline_first() {
        for error in [
            http_error(
                500,
                r#"{"success":false,"error":"duplicate key value violates unique constraint: Key (organization_id, phone)=(org, 6948128474)"}"#,
            ),
            http_error(503, r#"{"success":false,"error":"Server error"}"#),
            http_error(
                404,
                "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n",
            ),
            http_error(403, r#"{"error":"MODULE_REQUIRED"}"#),
        ] {
            let _keyring = crate::tests::fake_keyring::install_empty();
            let db = customer_test_db();
            let payload = create_payload("6948128474");
            let queue_payload = build_remote_customer_create_body(&payload);
            let outcome =
                apply_customer_create_outcome(&db, &payload, &queue_payload, Err(error.clone()))
                    .expect("offline save");
            assert_eq!(outcome.response["queued"], true, "{error}");
            assert_eq!(
                outcome.response["warning"], CUSTOMER_SAVED_OFFLINE,
                "{error}"
            );
            assert!(
                !outcome.response["warning"]
                    .to_string()
                    .contains("6948128474"),
                "{error}"
            );
            assert_eq!(parity_rows(&db).len(), 1, "{error}");
        }
    }

    #[test]
    fn customer_create_success_envelope_is_unchanged() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let payload = create_payload("6948128474");
        let queue_payload = build_remote_customer_create_body(&payload);
        let outcome = apply_customer_create_outcome(
            &db,
            &payload,
            &queue_payload,
            Ok(serde_json::json!({
                "id": "0b8e7f7c-3e2d-4b4a-8f36-3a1d5c9e2b71",
                "name": "Synthetic Customer",
                "phone": "6948128474",
                "version": 1
            })),
        )
        .expect("online create");

        assert_eq!(outcome.response["success"], true);
        assert_eq!(
            outcome.response["data"]["id"],
            "0b8e7f7c-3e2d-4b4a-8f36-3a1d5c9e2b71"
        );
        assert!(outcome.response.get("queued").is_none());
        assert!(outcome.response.get("code").is_none());
        assert!(outcome.created.is_some());
        assert!(parity_rows(&db).is_empty());
    }

    const OFFICE_ID: &str = "4f0c8d9e-2f7a-4d0b-9a55-0e7f2b3c1a10";

    /// A customer saved while offline: a local `cust-` id and a queued INSERT.
    fn create_local_customer(db: &db::DbState, phone: &str) -> String {
        let payload = create_payload(phone);
        let queue_payload = build_remote_customer_create_body(&payload);
        let outcome = apply_customer_create_outcome(
            db,
            &payload,
            &queue_payload,
            Err(AdminFetchError::transport("offline")),
        )
        .expect("offline create");
        outcome.response["data"]["id"]
            .as_str()
            .expect("local id")
            .to_string()
    }

    fn customer_row(
        db: &db::DbState,
        table_name: &str,
        operation: &str,
    ) -> Vec<(String, i64, Option<String>, serde_json::Value)> {
        let conn = db.conn.lock().expect("lock test db");
        let mut stmt = conn
            .prepare(
                "SELECT status, attempts, error_message, data FROM parity_sync_queue
                  WHERE table_name = ?1 AND operation = ?2 ORDER BY created_at",
            )
            .expect("prepare rows");
        stmt.query_map(rusqlite::params![table_name, operation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(3)?)
                    .unwrap_or(serde_json::Value::Null),
            ))
        })
        .expect("query rows")
        .map(|row| row.expect("row"))
        .collect()
    }

    fn set_queue_state(db: &db::DbState, table_name: &str, status: &str, error: Option<&str>) {
        let conn = db.conn.lock().expect("lock test db");
        conn.execute(
            "UPDATE parity_sync_queue SET status = ?1, attempts = 3, error_message = ?2
              WHERE table_name = ?3",
            rusqlite::params![status, error, table_name],
        )
        .expect("set queue state");
    }

    fn finished(plan: CustomerUpdatePlan) -> CustomerUpdateOutcome {
        match plan {
            CustomerUpdatePlan::Finished(outcome) => outcome,
            CustomerUpdatePlan::Office { customer_id, .. } => {
                panic!("expected a local answer, got an office PATCH to {customer_id}")
            }
            CustomerUpdatePlan::LocalOnly => panic!("expected a local answer, got LocalOnly"),
        }
    }

    fn cached(db: &db::DbState, customer_id: &str) -> Option<serde_json::Value> {
        read_local_json_array(db, "customer_cache_v1")
            .expect("read cache")
            .into_iter()
            .find(|entry| entry["id"].as_str() == Some(customer_id))
    }

    #[test]
    fn editing_an_offline_created_customer_folds_into_its_queued_insert() {
        // Review 2026-09-29 / audit VERIFY (d): the edit used to PATCH
        // /api/pos/customers/cust-… (404, now shown as NOT_FOUND) or queue an
        // UPDATE that replayed to 404 forever.
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let local_id = create_local_customer(&db, "6948128474");

        let outcome = finished(
            plan_customer_update(
                &db,
                &local_id,
                &serde_json::json!({ "name": "Renamed Synthetic", "phone": "6948128475" }),
                1,
            )
            .expect("plan"),
        );

        assert_eq!(outcome.response["success"], true);
        assert_eq!(outcome.response["queued"], true);
        assert_eq!(outcome.response["warning"], CUSTOMER_SAVED_OFFLINE);
        let updated = outcome.updated.expect("customer_updated is announced");
        assert_eq!(updated["id"], local_id.as_str());
        assert_eq!(updated["name"], "Renamed Synthetic");
        assert_eq!(
            cached(&db, &local_id).expect("cached")["phone"],
            "6948128475"
        );

        assert!(
            customer_row(&db, "customers", "UPDATE").is_empty(),
            "no UPDATE row"
        );
        let inserts = customer_row(&db, "customers", "INSERT");
        assert_eq!(inserts.len(), 1);
        assert_eq!(inserts[0].0, "pending");
        assert_eq!(inserts[0].3["name"], "Renamed Synthetic");
        assert_eq!(inserts[0].3["phone"], "6948128475");
        assert_eq!(
            inserts[0].3["address"], "Synthetic Street 1",
            "untouched fields stay"
        );
    }

    #[test]
    fn fixing_the_phone_of_a_rejected_offline_create_requeues_it() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let local_id = create_local_customer(&db, "69481284741");
        // What 1.4.118 left behind: the INSERT failed with INVALID_PHONE.
        set_queue_state(
            &db,
            "customers",
            "failed",
            Some("HTTP_400_CLIENT_ERROR:INVALID_PHONE"),
        );

        let outcome = finished(
            plan_customer_update(
                &db,
                &local_id,
                &serde_json::json!({ "phone": "6948128474" }),
                -1,
            )
            .expect("plan"),
        );
        assert_eq!(outcome.response["success"], true);

        let inserts = customer_row(&db, "customers", "INSERT");
        assert_eq!(inserts.len(), 1);
        let (status, attempts, error, data) = &inserts[0];
        assert_eq!(
            (status.as_str(), *attempts, error.as_deref()),
            ("pending", 0, None)
        );
        assert_eq!(data["phone"], "6948128474");
        assert!(customer_row(&db, "customers", "UPDATE").is_empty());
    }

    #[test]
    fn a_parked_duplicate_insert_takes_the_edit_and_goes_back_to_pending() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let local_id = create_local_customer(&db, "6948128474");
        set_queue_state(
            &db,
            "customers",
            "conflict",
            Some("SERVER_CONFLICT_DUPLICATE"),
        );

        finished(
            plan_customer_update(
                &db,
                &local_id,
                &serde_json::json!({ "phone": "6948128476" }),
                1,
            )
            .expect("plan"),
        );
        let inserts = customer_row(&db, "customers", "INSERT");
        assert_eq!(inserts[0].0, "pending");
        assert_eq!(inserts[0].3["phone"], "6948128476");
    }

    #[test]
    fn an_insert_being_sent_is_not_edited_under_it() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let local_id = create_local_customer(&db, "6948128474");
        set_queue_state(&db, "customers", "processing", None);
        let cache_before = read_local_json_array(&db, "customer_cache_v1").expect("cache");
        let insert_before = customer_row(&db, "customers", "INSERT");

        let outcome = finished(
            plan_customer_update(&db, &local_id, &serde_json::json!({ "name": "Renamed" }), 1)
                .expect("plan"),
        );
        assert_eq!(outcome.response["success"], false);
        assert_eq!(outcome.response["code"], CUSTOMER_SYNC_IN_PROGRESS);
        assert!(outcome.updated.is_none());
        assert_eq!(customer_row(&db, "customers", "INSERT"), insert_before);
        assert_eq!(
            read_local_json_array(&db, "customer_cache_v1").expect("cache"),
            cache_before
        );
    }

    #[test]
    fn a_synced_local_customer_is_edited_through_its_office_record() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        // What `sync_queue::remap_synced_local_customer` leaves behind.
        write_local_json(
            &db,
            "customer_cache_v1",
            &serde_json::json!([{
                "id": OFFICE_ID,
                "local_customer_id": "cust-synced-1",
                "name": "Synthetic",
                "version": 2
            }]),
        )
        .expect("seed cache");

        match plan_customer_update(
            &db,
            "cust-synced-1",
            &serde_json::json!({ "name": "Renamed" }),
            1,
        )
        .expect("plan")
        {
            CustomerUpdatePlan::Office {
                customer_id,
                expected_version,
            } => {
                assert_eq!(customer_id, OFFICE_ID);
                assert_eq!(expected_version, 2, "the office record's own version");
            }
            _ => panic!("expected an office PATCH"),
        }

        // Nothing queued and nothing synced: the office cannot know it.
        let outcome = finished(
            plan_customer_update(
                &db,
                "cust-unknown-1",
                &serde_json::json!({ "name": "Renamed" }),
                1,
            )
            .expect("plan"),
        );
        assert_eq!(outcome.response["code"], CUSTOMER_NOT_SYNCED);
        assert!(parity_rows(&db).is_empty());
    }

    #[test]
    fn an_office_customer_edit_without_a_version_uses_the_cached_one() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        seed_customer_cache(&db);

        match plan_customer_update(
            &db,
            OFFICE_ID,
            &serde_json::json!({ "name": "Renamed" }),
            -1,
        )
        .expect("plan")
        {
            CustomerUpdatePlan::Office {
                customer_id,
                expected_version,
            } => {
                assert_eq!(customer_id, OFFICE_ID);
                assert_eq!(expected_version, 3);
            }
            _ => panic!("expected an office PATCH"),
        }
        // An explicit version is kept as sent.
        match plan_customer_update(&db, OFFICE_ID, &serde_json::json!({ "name": "Renamed" }), 2)
            .expect("plan")
        {
            CustomerUpdatePlan::Office {
                expected_version, ..
            } => assert_eq!(expected_version, 2),
            _ => panic!("expected an office PATCH"),
        }
        // Unknown version and nothing cached: refused, never a 400 at the office.
        let outcome = finished(
            plan_customer_update(
                &db,
                "0b8e7f7c-3e2d-4b4a-8f36-3a1d5c9e2b71",
                &serde_json::json!({ "name": "Renamed" }),
                -1,
            )
            .expect("plan"),
        );
        assert_eq!(outcome.response["code"], VERSION_REQUIRED);
        // The local ban flag never reaches the office.
        assert!(matches!(
            plan_customer_update(&db, OFFICE_ID, &serde_json::json!({ "isBanned": true }), -1)
                .expect("plan"),
            CustomerUpdatePlan::LocalOnly
        ));
    }

    #[test]
    fn a_version_conflict_refreshes_the_cached_customer_and_queues_nothing() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        seed_customer_cache(&db);

        let outcome = apply_customer_update_outcome(
            &db,
            OFFICE_ID,
            &serde_json::json!({ "name": "Renamed" }),
            3,
            Some(Err(http_error(
                409,
                &serde_json::json!({
                    "success": false,
                    "error": "Customer version mismatch",
                    "code": "VERSION_MISMATCH",
                    "customer": {
                        "id": OFFICE_ID,
                        "name": "Changed Elsewhere",
                        "phone": "6948128474",
                        "version": 5
                    },
                    "expected_version": 5,
                    "received_version": 3
                })
                .to_string(),
            ))),
        )
        .expect("structured rejection");

        assert_eq!(outcome.response["success"], false);
        assert_eq!(outcome.response["conflict"], true);
        assert_eq!(outcome.response["code"], "VERSION_MISMATCH");
        assert!(
            !outcome.response.to_string().contains("Changed Elsewhere"),
            "the record is cached, not echoed"
        );
        let refreshed = cached(&db, OFFICE_ID).expect("cached");
        assert_eq!(refreshed["version"], 5);
        assert_eq!(refreshed["name"], "Changed Elsewhere");
        assert!(parity_rows(&db).is_empty());

        // Reopened from the cache, the next edit plans against version 5.
        match plan_customer_update(&db, OFFICE_ID, &serde_json::json!({ "name": "Again" }), -1)
            .expect("plan")
        {
            CustomerUpdatePlan::Office {
                expected_version, ..
            } => assert_eq!(expected_version, 5),
            _ => panic!("expected an office PATCH"),
        }
    }

    #[test]
    fn a_coded_update_rejection_is_shown_and_a_network_failure_is_queued() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let seeded = seed_customer_cache(&db);

        let rejected = apply_customer_update_outcome(
            &db,
            OFFICE_ID,
            &serde_json::json!({ "phone": "69481284741" }),
            3,
            Some(Err(http_error(
                400,
                r#"{"success":false,"error":"The phone number is invalid","code":"INVALID_PHONE"}"#,
            ))),
        )
        .expect("structured rejection");
        assert_eq!(rejected.response["code"], "INVALID_PHONE");
        assert!(rejected.updated.is_none());
        assert!(parity_rows(&db).is_empty());
        assert_eq!(
            serde_json::Value::Array(read_local_json_array(&db, "customer_cache_v1").unwrap()),
            seeded
        );

        let deferred = apply_customer_update_outcome(
            &db,
            OFFICE_ID,
            &serde_json::json!({ "name": "Renamed" }),
            3,
            Some(Err(AdminFetchError::transport("offline"))),
        )
        .expect("offline update");
        assert_eq!(deferred.response["success"], true);
        assert_eq!(deferred.response["queued"], true);
        assert_eq!(deferred.response["warning"], CUSTOMER_SAVED_OFFLINE);
        let updates = customer_row(&db, "customers", "UPDATE");
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].3["expected_version"], 3);
        assert_eq!(updates[0].3["name"], "Renamed");
    }

    #[test]
    fn address_writes_resolve_where_their_customer_lives() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();

        assert_eq!(
            plan_customer_address_write(&db, OFFICE_ID).expect("office"),
            CustomerAddressWritePlan::Office(OFFICE_ID.to_string())
        );

        let local_id = create_local_customer(&db, "6948128474");
        assert_eq!(
            plan_customer_address_write(&db, &local_id).expect("pending local"),
            CustomerAddressWritePlan::PendingLocal(local_id.clone())
        );

        match plan_customer_address_write(&db, "cust-unknown-2").expect("unknown") {
            CustomerAddressWritePlan::Refused(response) => {
                assert_eq!(response["code"], CUSTOMER_NOT_SYNCED)
            }
            other => panic!("expected a refusal, got {other:?}"),
        }

        let mut cache = read_local_json_array(&db, "customer_cache_v1").expect("cache");
        cache.push(serde_json::json!({
            "id": "0b8e7f7c-3e2d-4b4a-8f36-3a1d5c9e2b71",
            "local_customer_id": "cust-synced-2",
            "version": 1
        }));
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))
            .expect("seed alias");
        assert_eq!(
            plan_customer_address_write(&db, "cust-synced-2").expect("alias"),
            CustomerAddressWritePlan::Office("0b8e7f7c-3e2d-4b4a-8f36-3a1d5c9e2b71".to_string())
        );
    }

    #[test]
    fn an_address_edit_of_an_unsent_address_rides_on_its_queued_insert() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let queue_payload = serde_json::json!({
            "customer_id": OFFICE_ID,
            "street_address": "Unsent Street 5",
            "city": "Thessaloniki"
        });
        enqueue_customer_sync_item(
            &db,
            "customer_addresses",
            "addr-unsent-5",
            "INSERT",
            &queue_payload,
            1,
        )
        .expect("queue address insert");

        let edit = serde_json::json!({
            "customer_id": OFFICE_ID,
            "street_address": "Unsent Street 7",
            "expected_version": 2
        });
        assert!(matches!(
            merge_address_edit_into_queued_address_insert(&db, "addr-unsent-5", &edit)
                .expect("merge"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let inserts = customer_row(&db, "customer_addresses", "INSERT");
        assert_eq!(inserts.len(), 1);
        assert_eq!(inserts[0].3["street_address"], "Unsent Street 7");
        assert_eq!(inserts[0].3["city"], "Thessaloniki");
        assert!(inserts[0].3.get("expected_version").is_none());
        assert!(customer_row(&db, "customer_addresses", "UPDATE").is_empty());
    }

    #[test]
    fn an_address_edit_of_an_offline_customer_rides_on_the_customer_insert() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let local_id = create_local_customer(&db, "6948128474");

        let edit = serde_json::json!({
            "customer_id": local_id,
            "street_address": "Other Street 3",
            "city": "Athens",
            "floor_number": "2",
            "latitude": 37.98,
            "longitude": 23.72
        });
        assert!(matches!(
            merge_address_edit_into_customer_insert(&db, &local_id, &edit).expect("merge"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let inserts = customer_row(&db, "customers", "INSERT");
        let data = &inserts[0].3;
        assert_eq!(data["address"], "Other Street 3");
        assert_eq!(data["city"], "Athens");
        assert_eq!(data["floor_number"], "2");
        assert_eq!(data["latitude"], 37.98);
        assert_eq!(
            data["name"], "Synthetic Customer",
            "the customer fields stay"
        );
        assert!(data.get("customer_id").is_none());
        assert!(customer_row(&db, "customer_addresses", "UPDATE").is_empty());
    }

    #[test]
    fn deleting_an_address_that_never_reached_the_office_changes_only_the_queue() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();

        // An office customer's address saved offline and never sent.
        enqueue_customer_sync_item(
            &db,
            "customer_addresses",
            "addr-unsent-8",
            "INSERT",
            &serde_json::json!({ "customer_id": OFFICE_ID, "street_address": "Unsent Street 8" }),
            1,
        )
        .expect("queue address insert");
        let office_plan = CustomerAddressWritePlan::Office(OFFICE_ID.to_string());
        assert_eq!(
            remove_unsynced_address_from_queue(&db, &office_plan, "addr-unsent-8")
                .expect("withdraw"),
            (true, None)
        );
        assert!(customer_row(&db, "customer_addresses", "INSERT").is_empty());
        // An address the office has: nothing in the queue to change.
        assert_eq!(
            remove_unsynced_address_from_queue(&db, &office_plan, "addr-office-1")
                .expect("office address"),
            (false, None)
        );

        // The first address of an offline-created customer rides on its INSERT.
        let local_id = create_local_customer(&db, "6948128474");
        let address_id = cached(&db, &local_id).expect("cached")["addresses"][0]["id"]
            .as_str()
            .expect("address id")
            .to_string();
        let local_plan = CustomerAddressWritePlan::PendingLocal(local_id.clone());
        assert_eq!(
            remove_unsynced_address_from_queue(&db, &local_plan, &address_id).expect("clear"),
            (true, None)
        );
        let data = &customer_row(&db, "customers", "INSERT")[0].3;
        assert!(data.get("address").is_none(), "{data}");
        assert!(data.get("city").is_none(), "{data}");
        assert_eq!(data["name"], "Synthetic Customer");

        // Being sent right now: refused instead of racing the replay.
        set_queue_state(&db, "customers", "processing", None);
        assert_eq!(
            remove_unsynced_address_from_queue(&db, &local_plan, &address_id).expect("in flight"),
            (false, Some(CUSTOMER_SYNC_IN_PROGRESS))
        );
    }

    #[test]
    fn address_write_failures_split_like_customer_writes() {
        let coded = customer_write_rejection(
            &http_error(
                400,
                r#"{"success":false,"error":"Invalid coordinates","code":"INVALID_COORDINATES"}"#,
            ),
            "test",
        )
        .expect("coded 4xx is shown");
        assert_eq!(coded["code"], "INVALID_COORDINATES");
        assert_eq!(coded["status"], 400);

        let not_found = customer_write_rejection(
            &http_error(
                404,
                r#"{"success":false,"error":"Customer not found or access denied"}"#,
            ),
            "test",
        )
        .expect("an app 404 is shown");
        assert_eq!(not_found["code"], "NOT_FOUND");

        for deferred in [
            AdminFetchError::transport("offline"),
            http_error(503, r#"{"success":false,"error":"Server error"}"#),
            http_error(
                404,
                "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n",
            ),
            http_error(429, r#"{"success":false,"error":"Too many requests"}"#),
        ] {
            assert!(
                customer_write_rejection(&deferred, "test").is_none(),
                "{deferred}"
            );
        }

        // DELETE: only the office's own 404 means "already gone".
        assert!(address_already_gone(&http_error(
            404,
            r#"{"success":false,"error":"Address not found"}"#
        )));
        assert!(!address_already_gone(&http_error(
            404,
            "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n"
        )));
        assert!(!address_already_gone(&AdminFetchError::transport(
            "offline"
        )));
    }

    #[test]
    fn a_cache_refresh_keeps_the_local_alias_of_a_synced_customer() {
        let mut cache = vec![serde_json::json!({
            "id": OFFICE_ID,
            "local_customer_id": "cust-synced-3",
            "version": 1
        })];
        let refreshed = upsert_customer_cache_entry(
            &mut cache,
            serde_json::json!({ "id": OFFICE_ID, "name": "Synthetic", "version": 2 }),
        );
        assert_eq!(refreshed["local_customer_id"], "cust-synced-3");
        assert_eq!(cache.len(), 1);
    }

    // -----------------------------------------------------------------------
    // Deferred address edits merge into the cached address (desktop-address
    // counterpart request, 2026-09-29)
    // -----------------------------------------------------------------------

    const OFFICE_ADDRESS_ID: &str = "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
    const LOCATED: (f64, f64) = (40.6401, 22.9444);

    /// A saved address as the office sends it (`normalizePosAddressResponse`).
    fn office_address(
        address_id: &str,
        customer_id: &str,
        point: Option<(f64, f64)>,
    ) -> serde_json::Value {
        let (coordinates, latitude, longitude) = match point {
            Some((lat, lng)) => (
                serde_json::json!({ "lat": lat, "lng": lng }),
                serde_json::json!(lat),
                serde_json::json!(lng),
            ),
            None => (
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
            ),
        };
        serde_json::json!({
            "id": address_id,
            "customer_id": customer_id,
            "street_address": "Synthetic Street 12",
            "street": "Synthetic Street 12",
            "city": "Thessaloniki",
            "postal_code": "54622",
            "floor_number": "3",
            "name_on_ringer": "Synthetic Bell",
            "notes": "Side door",
            "delivery_notes": "Side door",
            "formatted_address": "Synthetic Street 12, Thessaloniki, 54622",
            "place_id": "synthetic-place-1",
            "google_place_id": "synthetic-place-1",
            "coordinates": coordinates,
            "latitude": latitude,
            "longitude": longitude,
            "is_default": true,
            "version": 4
        })
    }

    fn seed_office_customer_with_address(db: &db::DbState, address: serde_json::Value) {
        write_local_json(
            db,
            "customer_cache_v1",
            &serde_json::json!([{
                "id": OFFICE_ID,
                "name": "Existing Synthetic",
                "phone": "6948128474",
                "version": 3,
                "addresses": [address]
            }]),
        )
        .expect("seed customer with address");
    }

    /// `customer_update_address` after the office call (or after the fold).
    fn apply_address_edit(
        db: &db::DbState,
        customer_id: &str,
        address_id: &str,
        queue_payload: &serde_json::Value,
        remote: Option<Result<serde_json::Value, AdminFetchError>>,
    ) -> (serde_json::Value, Option<serde_json::Value>, bool) {
        match apply_customer_address_update_outcome(
            db,
            customer_id,
            address_id,
            queue_payload,
            false,
            4,
            remote,
        )
        .expect("apply address edit")
        {
            AddressUpdateApplied::Written {
                address,
                customer,
                deferred,
            } => (address, customer, deferred),
            AddressUpdateApplied::Rejected(response) => {
                panic!("unexpected rejection {response}")
            }
        }
    }

    fn office_address_edit(updates: serde_json::Value) -> serde_json::Value {
        build_address_update_queue_payload(&updates, OFFICE_ID, false, 4).expect("edit body")
    }

    fn assert_area_kept(address: &serde_json::Value) {
        for (key, value) in [
            ("street_address", "Synthetic Street 12"),
            ("street", "Synthetic Street 12"),
            ("city", "Thessaloniki"),
            ("postal_code", "54622"),
            ("floor_number", "3"),
            ("name_on_ringer", "Synthetic Bell"),
            ("notes", "Side door"),
            ("delivery_notes", "Side door"),
        ] {
            assert_eq!(address[key], value, "{key}: {address}");
        }
    }

    fn assert_point(address: &serde_json::Value, point: Option<(f64, f64)>) {
        match point {
            Some((lat, lng)) => {
                assert_eq!(
                    address["coordinates"],
                    serde_json::json!({ "lat": lat, "lng": lng }),
                    "{address}"
                );
                assert_eq!(address["latitude"], lat, "{address}");
                assert_eq!(address["longitude"], lng, "{address}");
            }
            None => {
                for key in ADDRESS_POINT_KEYS {
                    assert!(address[key].is_null(), "{key}: {address}");
                }
            }
        }
    }

    #[test]
    fn a_deferred_coordinates_only_address_edit_keeps_the_street_and_area() {
        // Regression: the cached address was replaced by the edit, so a
        // queued write-back of a located point left the saved address with
        // its coordinates only (no street, city, postal code, floor or bell).
        let _keyring = crate::tests::fake_keyring::install_empty();
        for failure in [
            AdminFetchError::transport("offline"),
            http_error(503, r#"{"success":false,"error":"Server error"}"#),
            http_error(401, r#"{"error":"Terminal API key is invalid"}"#),
        ] {
            let db = customer_test_db();
            seed_office_customer_with_address(
                &db,
                office_address(OFFICE_ADDRESS_ID, OFFICE_ID, None),
            );
            let edit = office_address_edit(serde_json::json!({
                "customer_id": OFFICE_ID,
                "coordinates": { "lat": LOCATED.0, "lng": LOCATED.1 },
                "latitude": LOCATED.0,
                "longitude": LOCATED.1
            }));

            let (address, customer, deferred) =
                apply_address_edit(&db, OFFICE_ID, OFFICE_ADDRESS_ID, &edit, Some(Err(failure)));

            assert!(deferred);
            assert_area_kept(&address);
            assert_point(&address, Some(LOCATED));
            assert_eq!(
                address["formatted_address"],
                "Synthetic Street 12, Thessaloniki, 54622"
            );
            assert_eq!(address["place_id"], "synthetic-place-1");
            assert_eq!(address["is_default"], true);
            assert_eq!(address["version"], 4, "the office version, not reset to 1");
            let customer = customer.expect("cached customer");
            assert_eq!(customer["version"], 4);
            assert_eq!(customer["addresses"].as_array().map(Vec::len), Some(1));
            assert_eq!(
                cached(&db, OFFICE_ID).expect("cached")["addresses"][0],
                address
            );

            // The queued PATCH carries the point only; the office keeps the rest.
            let updates = customer_row(&db, "customer_addresses", "UPDATE");
            assert_eq!(updates.len(), 1);
            let body = &updates[0].3;
            assert_eq!(body["latitude"], LOCATED.0);
            assert_eq!(body["expected_version"], 4);
            assert!(body.get("street_address").is_none(), "{body}");
            assert!(body.get("city").is_none(), "{body}");
        }
    }

    /// What the desktop Customers page sends for a street edit (1.4.124): a
    /// changed destination clears its point and place with explicit nulls.
    fn street_edit_with_cleared_pin(street: &str) -> serde_json::Value {
        serde_json::json!({
            "customer_id": OFFICE_ID,
            "street_address": street,
            "latitude": null,
            "longitude": null,
            "place_id": null
        })
    }

    #[test]
    fn a_deferred_street_edit_clears_the_old_pin_and_keeps_the_rest() {
        // Regression (desktop 1.4.123, fix 6): a street edit saved while the
        // office was unreachable kept the old point and place id in the
        // cache, so the next delivery order was zoned and priced from the
        // previous location. The explicit nulls now clear both, here and in
        // the queued PATCH.
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        seed_office_customer_with_address(
            &db,
            office_address(OFFICE_ADDRESS_ID, OFFICE_ID, Some(LOCATED)),
        );
        let edit = office_address_edit(street_edit_with_cleared_pin("Synthetic Street 14"));

        let (address, _, deferred) = apply_address_edit(
            &db,
            OFFICE_ID,
            OFFICE_ADDRESS_ID,
            &edit,
            Some(Err(http_error(
                503,
                r#"{"success":false,"error":"Server error"}"#,
            ))),
        );

        assert!(deferred);
        assert_eq!(address["street_address"], "Synthetic Street 14");
        assert_eq!(address["street"], "Synthetic Street 14");
        // As the office PATCH does: a text edit rebuilds the formatted address.
        assert_eq!(
            address["formatted_address"],
            "Synthetic Street 14, Thessaloniki, 54622"
        );
        for (key, value) in [
            ("city", "Thessaloniki"),
            ("postal_code", "54622"),
            ("floor_number", "3"),
            ("name_on_ringer", "Synthetic Bell"),
            ("notes", "Side door"),
            ("delivery_notes", "Side door"),
        ] {
            assert_eq!(address[key], value, "{key}: {address}");
        }
        assert_point(&address, None);
        for key in ["place_id", "google_place_id"] {
            assert!(address[key].is_null(), "{key}: {address}");
        }
        assert_eq!(address["version"], 4);
        assert_eq!(
            cached(&db, OFFICE_ID).expect("cached")["addresses"][0],
            address
        );
        // The queued PATCH carries the clear, so the office replay drops them too.
        let body = &customer_row(&db, "customer_addresses", "UPDATE")[0].3;
        assert_eq!(body["street_address"], "Synthetic Street 14");
        for key in ["latitude", "longitude", "place_id"] {
            assert_eq!(
                body.get(key),
                Some(&serde_json::Value::Null),
                "{key}: {body}"
            );
        }
    }

    #[test]
    fn a_deferred_edit_without_point_keys_keeps_the_point_and_place() {
        // An omitted key still means "unchanged": a floor-only edit keeps the
        // stored point and place id, and its PATCH does not mention them.
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        seed_office_customer_with_address(
            &db,
            office_address(OFFICE_ADDRESS_ID, OFFICE_ID, Some(LOCATED)),
        );
        let edit = office_address_edit(serde_json::json!({
            "customer_id": OFFICE_ID,
            "floor_number": "5"
        }));

        let (address, _, deferred) = apply_address_edit(
            &db,
            OFFICE_ID,
            OFFICE_ADDRESS_ID,
            &edit,
            Some(Err(AdminFetchError::transport("offline"))),
        );

        assert!(deferred);
        assert_eq!(address["floor_number"], "5");
        assert_point(&address, Some(LOCATED));
        assert_eq!(address["place_id"], "synthetic-place-1");
        assert_eq!(address["google_place_id"], "synthetic-place-1");
        let body = &customer_row(&db, "customer_addresses", "UPDATE")[0].3;
        for key in [
            "coordinates",
            "latitude",
            "longitude",
            "place_id",
            "google_place_id",
        ] {
            assert!(body.get(key).is_none(), "{key}: {body}");
        }
    }

    #[test]
    fn a_street_edit_folded_into_a_queued_address_insert_drops_the_old_place() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let address_id = "addr-unsent-14";
        let saved = office_address(address_id, OFFICE_ID, Some(LOCATED));
        seed_office_customer_with_address(&db, saved.clone());
        let mut insert_body = build_remote_address_body(&saved);
        insert_body["customer_id"] = serde_json::json!(OFFICE_ID);
        assert_eq!(insert_body["place_id"], "synthetic-place-1");
        enqueue_customer_sync_item(
            &db,
            "customer_addresses",
            address_id,
            "INSERT",
            &insert_body,
            1,
        )
        .expect("queue address insert");

        let edit = office_address_edit(street_edit_with_cleared_pin("Synthetic Street 14"));
        assert!(matches!(
            merge_address_edit_into_queued_address_insert(&db, address_id, &edit).expect("fold"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let insert = customer_row(&db, "customer_addresses", "INSERT")[0]
            .3
            .clone();
        assert_eq!(insert["street_address"], "Synthetic Street 14");
        for key in [
            "coordinates",
            "latitude",
            "longitude",
            "place_id",
            "google_place_id",
        ] {
            assert!(insert.get(key).is_none(), "{key}: {insert}");
        }
        let (address, _, deferred) = apply_address_edit(&db, OFFICE_ID, address_id, &edit, None);
        assert!(deferred);
        assert_point(&address, None);
        assert!(address["place_id"].is_null(), "{address}");
        assert!(address["google_place_id"].is_null(), "{address}");
    }

    #[test]
    fn a_street_edit_folded_into_an_offline_customer_insert_drops_the_old_place() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let local_id = create_local_customer(&db, "6948128474");
        let address_id = cached(&db, &local_id).expect("cached")["addresses"][0]["id"]
            .as_str()
            .expect("address id")
            .to_string();
        let local_edit = |updates: serde_json::Value| {
            build_address_update_queue_payload(&updates, &local_id, false, 1).expect("edit body")
        };
        // Locate it with a picked place first.
        let located = local_edit(serde_json::json!({
            "customer_id": local_id,
            "latitude": LOCATED.0,
            "longitude": LOCATED.1,
            "place_id": "synthetic-place-1"
        }));
        assert!(matches!(
            merge_address_edit_into_customer_insert(&db, &local_id, &located).expect("fold"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        assert_eq!(
            customer_row(&db, "customers", "INSERT")[0].3["place_id"],
            "synthetic-place-1"
        );
        let (address, _, _) = apply_address_edit(&db, &local_id, &address_id, &located, None);
        assert_point(&address, Some(LOCATED));
        assert_eq!(address["place_id"], "synthetic-place-1");

        let mut street = street_edit_with_cleared_pin("Synthetic Street 14");
        street["customer_id"] = serde_json::json!(local_id);
        let edit = local_edit(street);
        assert!(matches!(
            merge_address_edit_into_customer_insert(&db, &local_id, &edit).expect("fold"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let insert = customer_row(&db, "customers", "INSERT")[0].3.clone();
        assert_eq!(insert["address"], "Synthetic Street 14");
        for key in [
            "coordinates",
            "latitude",
            "longitude",
            "place_id",
            "google_place_id",
        ] {
            assert!(insert.get(key).is_none(), "{key}: {insert}");
        }
        let (address, _, deferred) = apply_address_edit(&db, &local_id, &address_id, &edit, None);
        assert!(deferred);
        assert_eq!(address["street_address"], "Synthetic Street 14");
        assert_point(&address, None);
        assert!(address["place_id"].is_null(), "{address}");
    }

    #[test]
    fn explicit_null_coordinates_clear_the_cached_point() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        seed_office_customer_with_address(
            &db,
            office_address(OFFICE_ADDRESS_ID, OFFICE_ID, Some(LOCATED)),
        );
        // AddCustomerModal's shape for an address saved without a point.
        let edit = office_address_edit(serde_json::json!({
            "customer_id": OFFICE_ID,
            "coordinates": null,
            "latitude": null,
            "longitude": null
        }));

        let (address, _, deferred) = apply_address_edit(
            &db,
            OFFICE_ID,
            OFFICE_ADDRESS_ID,
            &edit,
            Some(Err(AdminFetchError::transport("offline"))),
        );

        assert!(deferred);
        assert_point(&address, None);
        assert_area_kept(&address);
        assert_point(
            &cached(&db, OFFICE_ID).expect("cached")["addresses"][0],
            None,
        );
        // Both supported clear representations survive the captured PATCH.
        let body = &customer_row(&db, "customer_addresses", "UPDATE")[0].3;
        assert_eq!(body.get("coordinates"), Some(&serde_json::Value::Null));
        assert_eq!(body.get("latitude"), Some(&serde_json::Value::Null));
        assert_eq!(body.get("longitude"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn the_office_record_still_replaces_the_cached_address() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        seed_office_customer_with_address(&db, office_address(OFFICE_ADDRESS_ID, OFFICE_ID, None));
        let edit = office_address_edit(serde_json::json!({
            "customer_id": OFFICE_ID,
            "floor_number": "5"
        }));
        let mut office_record = office_address(OFFICE_ADDRESS_ID, OFFICE_ID, Some(LOCATED));
        office_record["floor_number"] = serde_json::json!("5");
        office_record["version"] = serde_json::json!(5);

        let (address, _, deferred) = apply_address_edit(
            &db,
            OFFICE_ID,
            OFFICE_ADDRESS_ID,
            &edit,
            Some(Ok(office_record)),
        );

        assert!(!deferred);
        assert_eq!(address["floor_number"], "5");
        assert_eq!(address["version"], 5);
        assert_point(&address, Some(LOCATED));
        assert!(parity_rows(&db).is_empty());
    }

    #[test]
    fn address_point_edits_read_like_the_office_patch() {
        let current = Some(LOCATED);
        let cases = [
            (
                serde_json::json!({ "city": "Thessaloniki" }),
                AddressPointEdit::Untouched,
            ),
            (
                serde_json::json!({ "coordinates": null }),
                AddressPointEdit::Clear,
            ),
            (
                serde_json::json!({ "latitude": null, "longitude": null }),
                AddressPointEdit::Clear,
            ),
            (
                serde_json::json!({ "coordinates": null, "latitude": 40.6, "longitude": 22.9 }),
                AddressPointEdit::Set {
                    lat: 40.6,
                    lng: 22.9,
                },
            ),
            // (0, 0) is what 1.4.118 sent for an address it never located.
            (
                serde_json::json!({ "coordinates": { "lat": 0, "lng": 0 } }),
                AddressPointEdit::Clear,
            ),
            (
                serde_json::json!({
                    "coordinates": { "type": "Point", "coordinates": [22.9, 40.6] }
                }),
                AddressPointEdit::Set {
                    lat: 40.6,
                    lng: 22.9,
                },
            ),
            // A missing half of the flat pair is the current point's.
            (
                serde_json::json!({ "latitude": "40.7" }),
                AddressPointEdit::Set {
                    lat: 40.7,
                    lng: LOCATED.1,
                },
            ),
        ];
        for (edit, expected) in cases {
            assert_eq!(address_point_edit(&edit, current), expected, "{edit}");
        }
        // A pair the office refuses (INVALID_COORDINATES) moves nothing.
        for edit in [
            serde_json::json!({ "coordinates": { "lat": 91, "lng": 22.9 } }),
            serde_json::json!({ "latitude": 40.7 }),
        ] {
            assert_eq!(
                address_point_edit(&edit, None),
                AddressPointEdit::Untouched,
                "{edit}"
            );
        }
    }

    #[test]
    fn an_edit_folded_into_a_queued_address_insert_merges_everywhere() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let address_id = "addr-unsent-9";
        // What customer_add_address leaves behind for an office customer
        // while the office is unreachable.
        let saved = office_address(address_id, OFFICE_ID, Some(LOCATED));
        seed_office_customer_with_address(&db, saved.clone());
        let mut insert_body = build_remote_address_body(&saved);
        insert_body["customer_id"] = serde_json::json!(OFFICE_ID);
        enqueue_customer_sync_item(
            &db,
            "customer_addresses",
            address_id,
            "INSERT",
            &insert_body,
            1,
        )
        .expect("queue address insert");

        // Clear the point: no coordinate key may survive in the INSERT.
        let edit = office_address_edit(serde_json::json!({
            "customer_id": OFFICE_ID,
            "coordinates": null,
            "latitude": null,
            "longitude": null
        }));
        assert!(matches!(
            merge_address_edit_into_queued_address_insert(&db, address_id, &edit).expect("fold"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let insert = customer_row(&db, "customer_addresses", "INSERT")[0]
            .3
            .clone();
        for key in ADDRESS_POINT_KEYS {
            assert!(insert.get(key).is_none(), "{key}: {insert}");
        }
        assert_eq!(insert["street_address"], "Synthetic Street 12");
        assert_eq!(insert["floor_number"], "3");
        assert_eq!(insert["name_on_ringer"], "Synthetic Bell");
        let (address, _, deferred) = apply_address_edit(&db, OFFICE_ID, address_id, &edit, None);
        assert!(deferred);
        assert_area_kept(&address);
        assert_point(&address, None);

        // Change the street: the INSERT and the cache keep the rest.
        let edit = office_address_edit(serde_json::json!({
            "customer_id": OFFICE_ID,
            "street_address": "Synthetic Street 14"
        }));
        assert!(matches!(
            merge_address_edit_into_queued_address_insert(&db, address_id, &edit).expect("fold"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let insert = customer_row(&db, "customer_addresses", "INSERT")[0]
            .3
            .clone();
        assert_eq!(insert["street_address"], "Synthetic Street 14");
        assert_eq!(insert["city"], "Thessaloniki");
        assert_eq!(insert["postal_code"], "54622");
        assert!(
            insert.get("formatted_address").is_none(),
            "the office rebuilds it from the new text: {insert}"
        );
        let (address, _, _) = apply_address_edit(&db, OFFICE_ID, address_id, &edit, None);
        assert_eq!(address["street_address"], "Synthetic Street 14");
        assert_eq!(address["street"], "Synthetic Street 14");
        assert_eq!(address["city"], "Thessaloniki");
        assert_eq!(address["floor_number"], "3");
        assert_eq!(address["name_on_ringer"], "Synthetic Bell");
        assert_eq!(
            address["formatted_address"],
            "Synthetic Street 14, Thessaloniki, 54622"
        );
        assert!(customer_row(&db, "customer_addresses", "UPDATE").is_empty());
        assert_eq!(customer_row(&db, "customer_addresses", "INSERT").len(), 1);
    }

    #[test]
    fn an_edit_folded_into_an_offline_customer_insert_merges_everywhere() {
        let _keyring = crate::tests::fake_keyring::install_empty();
        let db = customer_test_db();
        let local_id = create_local_customer(&db, "6948128474");
        let address_id = cached(&db, &local_id).expect("cached")["addresses"][0]["id"]
            .as_str()
            .expect("address id")
            .to_string();
        let local_edit = |updates: serde_json::Value| {
            build_address_update_queue_payload(&updates, &local_id, false, 1).expect("edit body")
        };

        // Locate it: a coordinates-only edit.
        let edit = local_edit(serde_json::json!({
            "customer_id": local_id,
            "coordinates": { "lat": LOCATED.0, "lng": LOCATED.1 },
            "latitude": LOCATED.0,
            "longitude": LOCATED.1
        }));
        assert_eq!(
            merge_address_edit_into_queued_address_insert(&db, &address_id, &edit)
                .expect("no insert of its own"),
            sync_queue::QueuedInsertMerge::NotQueued
        );
        assert!(matches!(
            merge_address_edit_into_customer_insert(&db, &local_id, &edit).expect("fold"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let insert = customer_row(&db, "customers", "INSERT")[0].3.clone();
        assert_eq!(insert["address"], "Synthetic Street 1");
        assert_eq!(insert["city"], "Thessaloniki");
        assert_eq!(
            insert["coordinates"],
            serde_json::json!({ "lat": LOCATED.0, "lng": LOCATED.1 })
        );
        assert_eq!(insert["latitude"], LOCATED.0);
        let (address, customer, deferred) =
            apply_address_edit(&db, &local_id, &address_id, &edit, None);
        assert!(deferred);
        assert!(customer.is_some());
        assert_eq!(address["id"], address_id.as_str());
        assert_eq!(address["street_address"], "Synthetic Street 1");
        assert_eq!(address["street"], "Synthetic Street 1");
        assert_eq!(address["city"], "Thessaloniki");
        assert_point(&address, Some(LOCATED));

        // Clear it again: the INSERT loses every coordinate key.
        let edit = local_edit(serde_json::json!({
            "customer_id": local_id,
            "coordinates": null,
            "latitude": null,
            "longitude": null
        }));
        assert!(matches!(
            merge_address_edit_into_customer_insert(&db, &local_id, &edit).expect("fold"),
            sync_queue::QueuedInsertMerge::Merged { .. }
        ));
        let insert = customer_row(&db, "customers", "INSERT")[0].3.clone();
        for key in ADDRESS_POINT_KEYS {
            assert!(insert.get(key).is_none(), "{key}: {insert}");
        }
        assert_eq!(insert["address"], "Synthetic Street 1");
        assert_eq!(insert["name"], "Synthetic Customer");
        let (address, _, _) = apply_address_edit(&db, &local_id, &address_id, &edit, None);
        assert_eq!(address["street_address"], "Synthetic Street 1");
        assert_eq!(address["city"], "Thessaloniki");
        assert_point(&address, None);
        assert!(customer_row(&db, "customer_addresses", "UPDATE").is_empty());
        assert!(customer_row(&db, "customer_addresses", "INSERT").is_empty());
    }
}
