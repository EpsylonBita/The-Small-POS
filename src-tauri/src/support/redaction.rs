//! Bounded typed redaction. No credential-store reads are permitted here.
use serde_json::{json, Value};
pub const MARKER: &str = "[REDACTED]";
fn luhn(digits: &str) -> bool {
    if !(13..=19).contains(&digits.len()) || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let sum: u32 = digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| {
            let n = u32::from(b - b'0');
            let n = if i % 2 == 1 { n * 2 } else { n };
            if n > 9 {
                n - 9
            } else {
                n
            }
        })
        .sum();
    sum % 10 == 0
}
fn number_pan(number: &serde_json::Number) -> bool {
    let text = number.to_string();
    if luhn(text.strip_prefix('-').unwrap_or(&text)) {
        return true;
    }
    // JSON/JavaScript numbers can encode the same PAN as 4111....0 or an
    // exponent. Normalize integral floats before applying the same Luhn rule.
    number.is_f64()
        && number.as_f64().is_some_and(|value| {
            let value = value.abs();
            value.fract() == 0.0 && (1e12..1e19).contains(&value) && luhn(&format!("{value:.0}"))
        })
}
pub(super) fn scrub_pan(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i;
        let mut digits = String::new();
        while i < chars.len()
            && (chars[i].is_ascii_digit()
                || matches!(chars[i], ' ' | '\t' | '\u{a0}' | '\u{200b}' | '-'))
        {
            if chars[i].is_ascii_digit() {
                digits.push(chars[i]);
                end = i + 1;
            }
            i += 1;
        }
        if luhn(&digits) {
            out.push_str(MARKER);
            out.extend(&chars[end..i]);
        } else {
            out.extend(&chars[start..i]);
        }
    }
    out
}
fn confirm(value: Value, depth: usize, nodes: &mut usize) -> Option<Value> {
    *nodes += 1;
    if depth > 32 || *nodes > 10000 {
        return None;
    }
    Some(match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, value) in map {
                if matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                    || crate::diagnostics::scrub_and_bound_text(&key, 1024) != key
                {
                    return None;
                }
                let presence = key.ends_with("Present")
                    || key.ends_with("present")
                    || key.starts_with("has")
                    || key.starts_with("is_");
                let value = if presence && !value.is_boolean() && !value.is_null() {
                    json!(MARKER)
                } else {
                    confirm(value, depth + 1, nodes)?
                };
                out.insert(key, value);
            }
            Value::Object(out)
        }
        Value::Array(list) => Value::Array(
            list.into_iter()
                .take(500)
                .map(|v| confirm(v, depth + 1, nodes))
                .collect::<Option<_>>()?,
        ),
        Value::String(s) => {
            let lower = s.to_ascii_lowercase();
            let credential_label = lower
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|word| {
                    [
                        "password",
                        "passwd",
                        "token",
                        "secret",
                        "authorization",
                        "bearer",
                        "api_key",
                        "apikey",
                        "access_token",
                        "pin",
                        "pin_hash",
                    ]
                    .contains(&word)
                })
                || lower.contains("api key");
            if ((s.contains('{') || s.contains('[')) && s.contains('"')) || credential_label {
                json!(MARKER)
            } else {
                json!(scrub_pan(&s))
            }
        }
        Value::Number(n) if number_pan(&n) => json!(MARKER),
        other => other,
    })
}
fn markers(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if value.as_str() == Some(MARKER) {
                    let key = key.to_ascii_lowercase();
                    if key.contains("email") {
                        *value = json!("[REDACTED_EMAIL]");
                    } else if key.contains("phone") || key.contains("mobile") {
                        *value = json!("[REDACTED_PHONE]");
                    }
                } else {
                    markers(value);
                }
            }
        }
        Value::Array(list) => {
            for value in list {
                markers(value);
            }
        }
        Value::String(text) => *text = text.chars().take(1024).collect(),
        _ => (),
    }
}
fn operational(original: &Value, redacted: &mut Value) {
    match (original, redacted) {
        (Value::Object(before), Value::Object(after)) => {
            for (key, value) in before {
                if let Some(out) = after.get_mut(key) {
                    let ip_address = key == "address"
                        && value.as_str().is_some_and(|s| {
                            s.parse::<std::net::Ipv4Addr>().is_ok()
                                || s.parse::<std::net::SocketAddrV4>().is_ok()
                        });
                    if ip_address || (key == "payload" && value == "redacted") {
                        *out = value.clone();
                    } else {
                        operational(value, out);
                    }
                }
            }
        }
        (Value::Array(before), Value::Array(after)) => {
            for (value, out) in before.iter().zip(after) {
                operational(value, out);
            }
        }
        _ => (),
    }
}
pub fn record(value: Value) -> Option<Value> {
    let confirmed = confirm(value, 0, &mut 0)?;
    let mut redacted = crate::diagnostics::redact_remote_diagnostics_value(confirmed.clone());
    operational(&confirmed, &mut redacted);
    markers(&mut redacted);
    Some(redacted)
}
pub fn records(values: impl IntoIterator<Item = Value>) -> (Vec<Value>, usize) {
    let mut output = Vec::new();
    let mut dropped = 0;
    for value in values {
        if let Some(value) = record(value) {
            output.push(value);
        } else {
            dropped += 1;
        }
    }
    (output, dropped)
}
pub fn text(value: &str) -> Value {
    let safe = record(json!({"value":value}))
        .and_then(|v| v.get("value").cloned())
        .unwrap_or(json!(MARKER));
    json!({"kind":"untrusted_till_data","value":safe})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_redaction_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../shared/pos/support/__fixtures__/support-redaction-vectors.json"
        ))
        .unwrap();
        for vector in vectors["vectors"].as_array().unwrap() {
            let value = record(vector["input"].clone()).unwrap();
            let encoded = value.to_string();
            for absent in vector["absent"].as_array().unwrap() {
                assert!(
                    !encoded.contains(absent.as_str().unwrap()),
                    "{}: {}",
                    vector["id"],
                    encoded
                );
            }
            if let Some(expected) = vector.get("expected") {
                assert_eq!(&value, expected, "{}", vector["id"]);
            }
        }
    }
}

#[cfg(test)]
mod bounds_tests {
    use super::*;
    #[test]
    fn unconfirmed_records_are_dropped_and_counted() {
        let (records, dropped) = records([
            json!({"__proto__":{"token":"your-test-secret"}}),
            json!({"safe":true}),
        ]);
        assert_eq!(dropped, 1);
        assert_eq!(records, vec![json!({"safe":true})]);
    }
    #[test]
    fn operational_addresses_and_payload_sentinel_keep_the_typed_contract() {
        assert_eq!(
            record(json!({"address":"192.168.1.19:9100","payload":"redacted"})).unwrap(),
            json!({"address":"192.168.1.19:9100","payload":"redacted"})
        );
    }
}

#[cfg(test)]
mod prose_tests {
    use super::*;
    #[test]
    fn credential_labels_with_spacing_or_quotes_are_masked() {
        for message in [
            "password = your-test-value",
            "Token : your-test-value",
            "authorization='your-test-value'",
            "API key = your-test-value",
            r#"failure { "customer_name": "your-test-value" }"#,
            r#"failure [ "your-test-value" ]"#,
        ] {
            let value = record(json!({"message":message})).unwrap();
            assert!(!value.to_string().contains("your-test-value"));
        }
    }
}

#[cfg(test)]
mod numeric_tests {
    use super::*;
    #[test]
    fn integral_float_exponent_and_negative_pan_values_are_masked() {
        for raw in [
            "4111111111111111.0",
            "4.111111111111111e15",
            "-4111111111111111",
        ] {
            let number: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(record(json!({"result":number})).unwrap()["result"], MARKER);
        }
    }
}
