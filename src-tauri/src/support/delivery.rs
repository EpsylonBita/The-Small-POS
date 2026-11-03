use super::{
    clock::{parse, ServerClock},
    contracts::{self, Command},
};
use std::{
    collections::{BTreeSet, VecDeque},
    time::Instant,
};

#[derive(Clone, Debug)]
pub struct Admission {
    pub session_id: String,
    pub active: bool,
    pub online: bool,
    pub visible: bool,
    pub tier_ceiling: u8,
    pub tiers_enabled: BTreeSet<u8>,
    pub disabled_tools: BTreeSet<String>,
    pub max_expires_at: String,
}

#[derive(Default)]
pub struct Delivery {
    pub received: VecDeque<Instant>,
    pub session: String,
}
impl Delivery {
    pub fn check(
        &mut self,
        c: &Command,
        a: &Admission,
        clock: &ServerClock,
        at: Instant,
    ) -> Result<(), &'static str> {
        if self.session != a.session_id {
            self.received.clear();
            self.session = a.session_id.clone();
        }
        while self.received.front().is_some_and(|old| {
            at.saturating_duration_since(*old) >= std::time::Duration::from_secs(60)
        }) {
            self.received.pop_front();
        }
        if self.received.len() as u64 >= contracts::cap("transport", "tillCommandsPerMinute") {
            return Err("RATE_LIMITED");
        }
        self.received.push_back(at);
        recheck(c, a, clock, at)
    }
}

pub fn recheck(
    c: &Command,
    a: &Admission,
    clock: &ServerClock,
    at: Instant,
) -> Result<(), &'static str> {
    if c.session_id != a.session_id || !a.active {
        return Err("SESSION_ENDED");
    }
    let now = clock.now_at(&a.session_id, at).ok_or("COMMAND_EXPIRED")?;
    if parse(&c.expires_at).map_err(|_| "COMMAND_EXPIRED")? <= now {
        return Err("COMMAND_EXPIRED");
    }
    if parse(&a.max_expires_at).map_err(|_| "SESSION_EXPIRED")? <= now {
        return Err("SESSION_EXPIRED");
    }
    let definition = contracts::shared()
        .kinds
        .get(&c.kind)
        .ok_or("INVALID_INPUT")?;
    let tier = if c.kind == "till_run_catalogue_action" {
        let action =
            super::catalogue::contract::parse(c.payload.clone()).map_err(|_| "INVALID_INPUT")?;
        // The shared schema's tier<3 refinement is not representable in its
        // emitted JSON schema. Preserve proposal-only admission explicitly.
        if action.tier() >= 3 {
            return Err("INVALID_INPUT");
        }
        action.tier()
    } else {
        definition.tier
    };
    if c.tier != tier || c.tier > a.tier_ceiling {
        return Err("TIER_NOT_ALLOWED");
    }
    if !a.tiers_enabled.contains(&c.tier) || a.disabled_tools.contains(&c.kind) {
        return Err("FEATURE_DISABLED");
    }
    if !definition.platforms.iter().any(|p| p == "windows") {
        return Err("UNSUPPORTED_ON_PLATFORM");
    }
    if c.sequence <= 0
        || c.sequence > 9_007_199_254_740_991
        || uuid::Uuid::parse_str(&c.command_id).is_err()
        || uuid::Uuid::parse_str(&c.call_id).is_err()
        || !(16..=64).contains(&c.idempotency_key.len())
        || !c
            .idempotency_key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("INVALID_INPUT");
    }
    if contracts::payload_hash(&c.payload) != c.payload_sha256 {
        return Err("PAYLOAD_MISMATCH");
    }
    let schema = contracts::shared()
        .payload_schemas
        .get(&c.kind)
        .ok_or("INVALID_INPUT")?;
    if !valid_schema(schema, &c.payload, 0) {
        return Err("INVALID_INPUT");
    }
    if !a.online {
        return Err("TILL_OFFLINE");
    }
    Ok(())
}

/// Closed subset of the emitted payload schemas. Unknown formats fail closed.
pub fn valid_schema(s: &serde_json::Value, v: &serde_json::Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    if let Some(variants) = s
        .get("anyOf")
        .or_else(|| s.get("oneOf"))
        .and_then(|a| a.as_array())
    {
        return variants.iter().any(|s| valid_schema(s, v, depth + 1));
    }
    if s.get("const").is_some_and(|c| c != v)
        || s["enum"]
            .as_array()
            .is_some_and(|values| !values.contains(v))
    {
        return false;
    }
    match s["type"].as_str() {
        Some("object") => {
            let Some(o) = v.as_object() else {
                return false;
            };
            let Some(properties) = s["properties"].as_object() else {
                return o.is_empty();
            };
            if s["additionalProperties"] == false && o.keys().any(|k| !properties.contains_key(k)) {
                return false;
            }
            if s["required"].as_array().is_some_and(|keys| {
                keys.iter()
                    .any(|k| k.as_str().is_none_or(|k| !o.contains_key(k)))
            }) {
                return false;
            }
            for (k, v) in o {
                if let Some(s) = properties.get(k) {
                    if !valid_schema(s, v, depth + 1) {
                        return false;
                    }
                }
            }
        }
        Some("array") => {
            let Some(a) = v.as_array() else {
                return false;
            };
            if s["minItems"].as_u64().is_some_and(|n| (a.len() as u64) < n)
                || s["maxItems"].as_u64().is_some_and(|n| a.len() as u64 > n)
            {
                return false;
            }
            if a.iter().any(|v| !valid_schema(&s["items"], v, depth + 1)) {
                return false;
            }
            if s["uniqueItems"] == true && a.iter().enumerate().any(|(i, v)| a[..i].contains(v)) {
                return false;
            }
        }
        Some("string") => {
            let Some(text) = v.as_str() else {
                return false;
            };
            let n = text.chars().count() as u64;
            if s["minLength"].as_u64().is_some_and(|min| n < min)
                || s["maxLength"].as_u64().is_some_and(|max| n > max)
            {
                return false;
            }
            match s["format"].as_str() {
                Some("date-time") => {
                    if !text.ends_with('Z') || parse(text).is_err() {
                        return false;
                    }
                }
                Some("uuid") => {
                    if uuid::Uuid::parse_str(text).is_err() {
                        return false;
                    }
                }
                Some("ipv4") => {
                    if text.parse::<std::net::Ipv4Addr>().is_err() {
                        return false;
                    }
                }
                Some(_) => return false,
                None => {}
            }
            if s.get("pattern").is_some() && s.get("format").is_none() {
                match s["pattern"].as_str() {
                    Some("^[A-Za-z0-9_-]{16,64}$") => {
                        if !(16..=64).contains(&text.len())
                            || !text
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                        {
                            return false;
                        }
                    }
                    Some("^[a-f0-9]{64}$") => {
                        if text.len() != 64
                            || !text
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        {
                            return false;
                        }
                    }
                    _ => return false,
                }
            }
        }
        Some("integer") | Some("number") => {
            let Some(n) = v.as_f64() else {
                return false;
            };
            if s["type"] == "integer" && n.fract() != 0.0 {
                return false;
            }
            if s["minimum"].as_f64().is_some_and(|m| n < m)
                || s["maximum"].as_f64().is_some_and(|m| n > m)
            {
                return false;
            }
        }
        Some("boolean") => {
            if !v.is_boolean() {
                return false;
            }
        }
        Some("null") => {
            if !v.is_null() {
                return false;
            }
        }
        None => {}
        Some(_) => return false,
    }
    true
}
