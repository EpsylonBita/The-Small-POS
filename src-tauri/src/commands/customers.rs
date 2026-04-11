use chrono::Utc;
use serde::Deserialize;
use tauri::Emitter;

use crate::{
    db, normalize_phone, payload_arg0_as_string, read_local_json_array, read_local_setting,
    storage, sync_queue, value_i64, value_str, write_local_json,
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
    if let Some(resolved_street_number) =
        string_field(source, &["resolved_street_number"])
    {
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
    if let Some(phone) = string_field(source, &["phone", "customerPhone", "mobile", "telephone"]) {
        body.insert("phone".to_string(), serde_json::json!(phone));
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
    if let Some(resolved_street_number) =
        string_field(source, &["resolved_street_number"])
    {
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
        obj.entry("addresses".to_string())
            .or_insert(serde_json::json!([]));
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

async fn sync_customer_create_remote(
    db: &db::DbState,
    customer: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let body = build_remote_customer_create_body(customer);
    let name = string_field(&body, &["name"]).ok_or("Missing customer name")?;
    let phone = string_field(&body, &["phone"]).ok_or("Missing customer phone")?;
    if name.is_empty() || phone.is_empty() {
        return Err("Missing customer name or phone".into());
    }

    let response = crate::admin_fetch(Some(db), "/api/pos/customers", "POST", Some(body)).await?;
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
) -> Result<serde_json::Value, String> {
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
    let response = crate::admin_fetch(Some(db), &path, "PATCH", Some(body)).await?;
    let remote_customer = response
        .get("customer")
        .cloned()
        .or_else(|| response.get("data").cloned())
        .ok_or("Customer API response missing customer")?;
    Ok(remote_customer)
}

/// Fetch all customers for the organization via Supabase RPC and replace the local cache.
/// Calls `get_customers_for_pos_terminal` which validates terminal credentials server-side.
async fn sync_customer_fetch_all(db: &db::DbState) -> Result<Vec<serde_json::Value>, String> {
    let supabase_url =
        crate::storage::get_credential("supabase_url").ok_or("Missing supabase_url")?;
    let anon_key =
        crate::storage::get_credential("supabase_anon_key").ok_or("Missing supabase_anon_key")?;
    let org_id =
        crate::storage::get_credential("organization_id").ok_or("Missing organization_id")?;
    let terminal_id = crate::storage::get_credential("terminal_id").ok_or("Missing terminal_id")?;
    let api_key = crate::storage::get_credential("pos_api_key").ok_or("Missing pos_api_key")?;

    let base = supabase_url.trim_end_matches('/');
    let url = format!("{base}/rest/v1/rpc/get_customers_for_pos_terminal");

    let body = serde_json::json!({
        "p_organization_id": org_id,
        "p_terminal_id": terminal_id,
        "p_api_key": api_key,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(&url)
        .header("apikey", &anon_key)
        .header("Authorization", format!("Bearer {anon_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Supabase RPC request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Supabase customers RPC error ({status}): {body}"));
    }

    let rows: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("JSON parse error: {e}"))?;
    let customers = rows.as_array().cloned().unwrap_or_default();
    write_local_json(db, "customer_cache_v1", &serde_json::json!(customers))?;
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
) -> Result<serde_json::Value, String> {
    let body = build_remote_address_body(address);
    let street = string_field(&body, &["street_address"]).ok_or("Missing address street")?;
    if street.is_empty() {
        return Err("Missing address street".into());
    }

    let path = format!("/api/pos/customers/{customer_id}/addresses");
    let response = crate::admin_fetch(Some(db), &path, "POST", Some(body)).await?;
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
) -> Result<serde_json::Value, String> {
    let body = build_remote_address_body(address);
    if body.as_object().map(|obj| obj.is_empty()).unwrap_or(true) {
        return Err("Missing address updates".into());
    }

    let path = format!("/api/pos/customers/{customer_id}/addresses/{address_id}");
    let response = crate::admin_fetch(Some(db), &path, "PATCH", Some(body)).await?;
    let remote_address = response
        .get("address")
        .cloned()
        .ok_or("Address API response missing address")?;
    Ok(remote_address)
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

#[tauri::command]
pub async fn customer_lookup_by_phone(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<serde_json::Value, String> {
    let payload = parse_phone_payload(arg0)?;
    let phone = payload.phone;
    let phone_norm = normalize_phone(&phone);
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
        // Fetch all customers from admin API and refresh local cache
        match sync_customer_fetch_all(&db).await {
            Ok(customers) => return Ok(serde_json::json!(customers)),
            Err(e) => {
                tracing::warn!(error = %e, "Failed to fetch all customers, falling back to cache");
                let cache = read_local_json_array(&db, "customer_cache_v1")?;
                return Ok(serde_json::json!(cache));
            }
        }
    }
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
    Ok(serde_json::json!(matches))
}

#[tauri::command]
pub async fn customer_create(
    arg0: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = arg0.unwrap_or(serde_json::json!({}));
    let queue_payload = build_remote_customer_create_body(&payload);

    match sync_customer_create_remote(&db, &payload).await {
        Ok(remote_customer) => {
            let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
            let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
            write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
            let _ = app.emit("customer_created", customer.clone());
            let _ = app.emit("customer_realtime_update", customer.clone());
            Ok(serde_json::json!({ "success": true, "data": customer }))
        }
        Err(remote_error) => {
            let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
            let customer = upsert_customer_cache_entry(&mut cache, build_local_customer_from_source(&payload));
            write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;

            let customer_id =
                value_str(&customer, &["id", "customerId"]).ok_or("Missing local customer id")?;
            let version = value_i64(&customer, &["version"]).unwrap_or(1);
            enqueue_customer_sync_item(
                &db,
                "customers",
                &customer_id,
                "INSERT",
                &queue_payload,
                version,
            )?;

            let _ = app.emit("customer_created", customer.clone());
            let _ = app.emit("customer_realtime_update", customer.clone());
            Ok(serde_json::json!({
                "success": true,
                "queued": true,
                "offline": true,
                "warning": remote_error,
                "data": customer
            }))
        }
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
    let customer_id = payload.customer_id;
    let updates = payload.updates;
    let expected_version = payload.expected_version;
    let mut remote_updates = build_remote_customer_update_body(&updates);
    let mut remote_failure: Option<String> = None;

    if remote_updates
        .as_object()
        .map(|obj| !obj.is_empty())
        .unwrap_or(false)
    {
        match sync_customer_update_remote(&db, &customer_id, &updates, expected_version).await {
            Ok(remote_customer) => {
                let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
                let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
                write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
                let _ = app.emit("customer_updated", customer.clone());
                let _ = app.emit("customer_realtime_update", customer.clone());
                return Ok(serde_json::json!({ "success": true, "data": customer }));
            }
            Err(error) => {
                remote_failure = Some(error);
                if expected_version > 0 {
                    if let Some(obj) = remote_updates.as_object_mut() {
                        obj.insert(
                            "expected_version".to_string(),
                            serde_json::json!(expected_version),
                        );
                    }
                }
            }
        }
    }

    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;

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
        let mut conflicts = read_local_json_array(&db, "customer_conflicts_v1")?;
        conflicts.push(conflict_payload.clone());
        write_local_json(
            &db,
            "customer_conflicts_v1",
            &serde_json::Value::Array(conflicts),
        )?;
        let _ = app.emit("customer_sync_conflict", conflict_payload.clone());
        return Ok(serde_json::json!({
            "success": false,
            "conflict": true,
            "error": "Version conflict",
            "data": conflict_payload
        }));
    }

    if let Some(customer) = updated_customer.clone() {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        let version = value_i64(&customer, &["version"]).unwrap_or(expected_version.max(1));
        if remote_failure.is_some()
            && remote_updates
                .as_object()
                .map(|obj| !obj.is_empty())
                .unwrap_or(false)
        {
            enqueue_customer_sync_item(
                &db,
                "customers",
                &customer_id,
                "UPDATE",
                &remote_updates,
                version,
            )?;
        }
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({
            "success": true,
            "queued": remote_failure.is_some(),
            "offline": remote_failure.is_some(),
            "warning": remote_failure,
            "data": customer
        }));
    }

    Err("Customer not found".into())
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

#[tauri::command]
pub async fn customer_add_address(
    arg0: Option<serde_json::Value>,
    arg1: Option<serde_json::Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let payload = parse_customer_address_payload(arg0, arg1)?;
    let customer_id = payload.customer_id;
    let mut queue_payload = build_remote_address_body(&payload.address);
    if queue_payload
        .get("street_address")
        .and_then(|value| value.as_str())
        .is_none()
    {
        return Err("Missing address street".into());
    }
    if let Some(obj) = queue_payload.as_object_mut() {
        obj.insert("customer_id".to_string(), serde_json::json!(customer_id.clone()));
    }

    let (address, remote_failure) = match sync_customer_address_remote(&db, &customer_id, &payload.address).await {
        Ok(remote_address) => (normalize_address_for_cache(remote_address), None),
        Err(error) => (normalize_address_for_cache(queue_payload.clone()), Some(error)),
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
    } else if remote_failure.is_none() {
        if let Some(remote_customer) = sync_customer_fetch_remote_by_id(&db, &customer_id).await?
        {
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

    if remote_failure.is_some() {
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

    if let Some(customer) = customer.clone() {
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
        return Ok(serde_json::json!({
            "success": true,
            "queued": remote_failure.is_some(),
            "offline": remote_failure.is_some(),
            "warning": remote_failure,
            "data": address,
            "customer": customer
        }));
    }

    Ok(serde_json::json!({
        "success": true,
        "queued": remote_failure.is_some(),
        "offline": remote_failure.is_some(),
        "warning": remote_failure,
        "data": address
    }))
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
    let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
    let hinted_customer_id =
        value_str(&updates, &["customer_id", "customerId"]).map(|id| id.trim().to_string());
    let customer_id = hinted_customer_id
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

    let mut queue_payload = build_remote_address_body(&updates);
    if queue_payload
        .as_object()
        .map(|obj| obj.is_empty())
        .unwrap_or(true)
    {
        return Err("Missing address updates".into());
    }
    if let Some(obj) = queue_payload.as_object_mut() {
        obj.insert("customer_id".to_string(), serde_json::json!(customer_id.clone()));
        if expected_version > 0 {
            obj.insert(
                "expected_version".to_string(),
                serde_json::json!(expected_version),
            );
        }
    }

    let (address, remote_failure) = match sync_customer_address_update_remote(
        &db,
        &customer_id,
        &target_id,
        &updates,
    )
    .await
    {
        Ok(remote_address) => (normalize_address_for_cache(remote_address), None),
        Err(error) => {
            let mut local_payload = queue_payload.clone();
            if let Some(obj) = local_payload.as_object_mut() {
                obj.insert("id".to_string(), serde_json::json!(target_id.clone()));
            }
            (normalize_address_for_cache(local_payload), Some(error))
        }
    };

    let mut updated_customer: Option<serde_json::Value> = None;
    let mut cache_touched = false;
    for entry in &mut cache {
        let cached_customer_id = value_str(entry, &["id", "customerId"]).unwrap_or_default();
        if cached_customer_id != customer_id {
            continue;
        }

        if let Some(obj) = entry.as_object_mut() {
            let addresses = obj
                .entry("addresses".to_string())
                .or_insert_with(|| serde_json::json!([]));
            if let Some(arr) = addresses.as_array_mut() {
                let mut replaced = false;
                for addr in arr.iter_mut() {
                    let aid = value_str(addr, &["id", "addressId"]).unwrap_or_default();
                    if aid == target_id {
                        *addr = address.clone();
                        replaced = true;
                        break;
                    }
                }
                if !replaced {
                    arr.push(address.clone());
                }
            }

            let next_version = obj.get("version").and_then(|v| v.as_i64()).unwrap_or(1) + 1;
            obj.insert("version".to_string(), serde_json::json!(next_version));
            obj.insert(
                "updatedAt".to_string(),
                serde_json::json!(Utc::now().to_rfc3339()),
            );
            updated_customer = Some(serde_json::Value::Object(obj.clone()));
            cache_touched = true;
        }
        break;
    }

    let customer = if cache_touched {
        write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
        updated_customer.clone()
    } else if remote_failure.is_none() {
        if let Some(remote_customer) = sync_customer_fetch_remote_by_id(&db, &customer_id).await?
        {
            let mut cache = read_local_json_array(&db, "customer_cache_v1")?;
            let customer = upsert_customer_cache_entry(&mut cache, remote_customer);
            write_local_json(&db, "customer_cache_v1", &serde_json::Value::Array(cache))?;
            Some(customer)
        } else {
            updated_customer.clone()
        }
    } else {
        updated_customer.clone()
    };

    if remote_failure.is_some() {
        let version = value_i64(&address, &["version"]).unwrap_or(expected_version.max(1));
        enqueue_customer_sync_item(
            &db,
            "customer_addresses",
            &target_id,
            "UPDATE",
            &queue_payload,
            version,
        )?;
    }

    if let Some(customer) = customer.clone() {
        let _ = app.emit("customer_updated", customer.clone());
        let _ = app.emit("customer_realtime_update", customer.clone());
    }

    Ok(serde_json::json!({
        "success": true,
        "queued": remote_failure.is_some(),
        "offline": remote_failure.is_some(),
        "warning": remote_failure,
        "data": address,
        "customer": customer
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

#[cfg(test)]
mod dto_tests {
    use super::*;

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
            "phone": "6948128474",
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
            Some("6948128474")
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
}
