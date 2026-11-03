//! Attribution uses the gate's bounded start history, never a business journal.
//! Values are the shared `protected_check` vocabulary (tool-contracts.ts):
//! a digest that could not be taken is `not_run`, never a match.
use super::{critical_op, protected_digest::DigestOutcome};
use serde::Serialize;
use std::{collections::BTreeSet, time::Instant};
#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct ProtectedCheck {
    pub protected_check: &'static str,
    pub changed_tables: Vec<String>,
}
pub fn check(
    before: &DigestOutcome,
    after: &DigestOutcome,
    from: Instant,
    to: Instant,
) -> ProtectedCheck {
    let (DigestOutcome::Available(before), DigestOutcome::Available(after)) = (before, after)
    else {
        return ProtectedCheck {
            protected_check: "not_run",
            changed_tables: vec![],
        };
    };
    let names = before.keys().chain(after.keys()).collect::<BTreeSet<_>>();
    let changed_tables = names
        .into_iter()
        .filter(|name| before.get(*name) != after.get(*name))
        .cloned()
        .collect::<Vec<_>>();
    let protected_check = if changed_tables.is_empty() {
        "match"
    } else if from <= to
        && critical_op::global()
            .activity_between(from, to)
            .is_some_and(|v| v.is_empty())
    {
        "mismatch"
    } else {
        "inconclusive"
    };
    ProtectedCheck {
        protected_check,
        changed_tables,
    }
}
