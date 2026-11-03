use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::OnceLock};

pub const EMBEDDED: &str =
    include_str!("../../../../shared/pos/support/generated/support-contracts.json");

#[derive(Debug, Deserialize)]
pub struct CommandDefinition {
    pub tier: u8,
    pub mutating: bool,
    pub platforms: Vec<String>,
    pub execution: String,
}

#[derive(Debug, Deserialize)]
pub struct Contracts {
    pub kinds: BTreeMap<String, CommandDefinition>,
    pub error_codes: Vec<String>,
    pub caps: Value,
    // Used by task 17.4 (Phase 3 write policy).
    #[allow(dead_code)]
    pub write_policy: Value,
    pub functions: Value,
    pub network: Value,
    pub probes: Value,
    pub payload_schemas: BTreeMap<String, Value>,
    pub protocol: Value,
    #[serde(flatten)]
    pub other: BTreeMap<String, Value>,
}

pub fn shared() -> &'static Contracts {
    static CONTRACTS: OnceLock<Contracts> = OnceLock::new();
    CONTRACTS.get_or_init(|| {
        serde_json::from_str(EMBEDDED).expect("invalid build-pinned support contracts")
    })
}

pub fn cap(section: &str, key: &str) -> u64 {
    shared().caps[section][key]
        .as_u64()
        .expect("missing build-pinned support cap")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub command_id: String,
    pub session_id: String,
    pub sequence: i64,
    pub kind: String,
    pub tier: u8,
    pub payload: Value,
    pub payload_sha256: String,
    pub idempotency_key: String,
    pub call_id: String,
    pub created_at: String,
    pub expires_at: String,
    pub server_time: String,
    pub approval: Option<Value>,
}

pub fn sha256(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// serde_json's map order is lexical (preserve_order is not enabled).
pub fn payload_hash(value: &Value) -> String {
    sha256(serde_json::to_string(value).expect("JSON value").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_contracts_drift() {
        let c = shared();
        assert_eq!(c.kinds.len(), 30);
        assert_eq!(c.error_codes.len(), 39);
        assert_eq!(c.payload_schemas.len(), c.kinds.len());
        assert_eq!(c.probes["catalogue"].as_object().unwrap().len(), 5);
        assert_eq!(c.network["port_groups"].as_object().unwrap().len(), 3);
        assert_eq!(c.functions["allowlist"].as_object().unwrap().len(), 6);
        assert_eq!(
            c.functions["allowlist"]
                .as_object()
                .unwrap()
                .values()
                .map(|v| v.as_array().unwrap().len())
                .sum::<usize>(),
            95
        );
        assert_eq!(
            c.network["port_groups"]
                .as_object()
                .unwrap()
                .values()
                .map(|v| v.as_array().unwrap().len())
                .sum::<usize>(),
            7
        );
        assert_eq!(
            c.write_policy["tables"]["windows"]
                .as_object()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            c.write_policy["tables"]["android"]
                .as_object()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(c.caps.as_object().unwrap().len(), 12);
        assert_eq!(c.write_policy["default"], "protected");
        assert_eq!(cap("transport", "tillCommandsPerMinute"), 120);
        assert_eq!(cap("onsite", "writeTransactionMs"), 250);
        assert_eq!(
            payload_hash(&serde_json::json!({})),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }
}
