use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Role {
    Waiter,
    Driver,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Line {
    #[serde(deserialize_with = "nullable_text")]
    pub payment_id: Option<String>,
    pub order_id: String,
    #[serde(deserialize_with = "nullable_text")]
    pub order_number: Option<String>,
    #[serde(deserialize_with = "nullable_text")]
    pub table_code: Option<String>,
    pub method: String,
    pub cents: i64,
}

fn nullable_text<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Option::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Snapshot {
    version: u8,
    pub role_type: Role,
    pub total_cents: i64,
    pub payout_cents: i64,
    pub lines: Vec<Line>,
}

impl Snapshot {
    pub fn empty(role_type: Role) -> Self {
        Self {
            version: 1,
            role_type,
            total_cents: 0,
            payout_cents: 0,
            lines: Vec::new(),
        }
    }

    pub fn try_new(role_type: Role, lines: Vec<Line>) -> Option<Self> {
        let total_cents = lines
            .iter()
            .try_fold(0_i64, |sum, line| sum.checked_add(line.cents))?;
        Some(Self {
            total_cents,
            lines,
            ..Self::empty(role_type)
        })
    }

    fn valid_wire(&self) -> bool {
        const MAX_WIRE_LINES: usize = 500;
        let guid = |id: &str| id.len() == 36 && uuid::Uuid::parse_str(id).is_ok();
        self.version == 1
            && self.payout_cents >= 0
            && self.lines.len() <= MAX_WIRE_LINES
            && self.lines.iter().all(|line| {
                line.cents > 0
                    && !line.method.is_empty()
                    && guid(&line.order_id)
                    && line.payment_id.as_deref().is_none_or(guid)
            })
            && self
                .lines
                .iter()
                .try_fold(0_i64, |sum, line| sum.checked_add(line.cents))
                == Some(self.total_cents)
    }

    pub fn read_wire(value: &Value) -> Option<Self> {
        let snapshot: Self = serde_json::from_value(value.clone()).ok()?;
        snapshot.valid_wire().then_some(snapshot)
    }

    pub fn wire_value(&self) -> Option<Value> {
        self.valid_wire().then(|| serde_json::json!(self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wt_sync_kept_tips_match_shared_wire_examples() {
        let wire: Value = serde_json::from_str(include_str!(
            "../../../shared/pos/waiter-tips/__fixtures__/waiter-tips-wire.json"
        ))
        .unwrap();
        for fixture in wire["keptTips"]["valid"].as_array().unwrap() {
            let snapshot = Snapshot::read_wire(fixture).expect("valid wire snapshot");
            assert_eq!(snapshot.wire_value().as_ref(), Some(fixture));
        }
        for fixture in wire["keptTips"]["invalid"].as_array().unwrap() {
            assert!(Snapshot::read_wire(fixture).is_none(), "{fixture}");
        }
        let mut unknown = wire["keptTips"]["valid"][0].clone();
        unknown["lines"][0]["unknown"] = serde_json::json!(true);
        assert!(Snapshot::read_wire(&unknown).is_none());
    }
}
