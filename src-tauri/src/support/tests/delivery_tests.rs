use crate::support::{
    clock::ServerClock,
    contracts::Command,
    delivery::{Admission, Delivery},
};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

pub(super) fn command() -> Command {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../shared/pos/support/__fixtures__/routes/pos-support-commands.json"
    ))
    .unwrap();
    serde_json::from_value(fixture["response"]["commands"][0].clone()).unwrap()
}
pub(super) fn admission() -> Admission {
    Admission {
        session_id: command().session_id,
        active: true,
        online: true,
        visible: true,
        tier_ceiling: 1,
        tiers_enabled: BTreeSet::from([1]),
        disabled_tools: BTreeSet::new(),
        max_expires_at: "2026-11-01T13:00:00.000Z".into(),
    }
}
pub(super) fn clock() -> ServerClock {
    let mut clock = ServerClock::default();
    clock
        .observe(
            &command().session_id,
            "2026-11-01T12:00:00.000Z",
            Instant::now(),
        )
        .unwrap();
    clock
}

#[test]
fn delivery_refuses_wrong_session_expiry_hash_kind_tier_and_no_clock() {
    let original = command();
    let a = admission();
    let c = clock();
    let mut cases = Vec::new();
    let mut x = original.clone();
    x.session_id = "other".into();
    cases.push((x, "SESSION_ENDED"));
    let mut x = original.clone();
    x.expires_at = "2026-11-01T11:59:59.000Z".into();
    cases.push((x, "COMMAND_EXPIRED"));
    let mut x = original.clone();
    x.payload_sha256 = "0".repeat(64);
    cases.push((x, "PAYLOAD_MISMATCH"));
    let mut x = original.clone();
    x.kind = "eval".into();
    cases.push((x, "INVALID_INPUT"));
    let mut x = original.clone();
    x.tier = 3;
    cases.push((x, "TIER_NOT_ALLOWED"));
    let mut x = original.clone();
    x.sequence = 0;
    cases.push((x, "INVALID_INPUT"));
    for (x, code) in cases {
        assert_eq!(
            Delivery::default().check(&x, &a, &c, Instant::now()),
            Err(code),
            "{x:?}"
        );
    }
    assert_eq!(
        Delivery::default().check(&original, &a, &ServerClock::default(), Instant::now()),
        Err("COMMAND_EXPIRED")
    );
}

#[test]
fn authenticated_monotonic_time_cannot_be_rewound_or_reused_for_another_session() {
    let at = Instant::now();
    let mut c = ServerClock::default();
    let id = command().session_id;
    c.observe(&id, "2026-11-01T12:00:00.000Z", at).unwrap();
    c.observe(
        &id,
        "2026-11-01T11:00:00.000Z",
        at + Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(c.now_at("other", at + Duration::from_secs(61)), None);
    let mut a = admission();
    a.online = false;
    assert_eq!(
        Delivery::default().check(&command(), &a, &c, at + Duration::from_secs(61)),
        Err("COMMAND_EXPIRED")
    );
}

#[test]
fn independent_kill_switches_and_120_per_minute_cap() {
    let c = clock();
    let at = Instant::now();
    let mut a = admission();
    let mut d = Delivery::default();
    for _ in 0..120 {
        assert!(d.check(&command(), &a, &c, at).is_ok());
    }
    assert_eq!(d.check(&command(), &a, &c, at), Err("RATE_LIMITED"));
    a.disabled_tools.insert("till_health".into());
    assert_eq!(
        Delivery::default().check(&command(), &a, &c, at),
        Err("FEATURE_DISABLED")
    );
    a.disabled_tools.clear();
    a.tiers_enabled.clear();
    assert_eq!(
        Delivery::default().check(&command(), &a, &c, at),
        Err("FEATURE_DISABLED")
    );
}
