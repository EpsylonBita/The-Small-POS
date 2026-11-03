//! Closed, build-pinned inputs. Resource addresses and content are never inputs.
use crate::support::{contracts, delivery};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const VERSION: u8 = 1;
pub const IMPLEMENTATION_VERSION: u8 = 1;
pub const OUTPUT_MAX_BYTES: usize = 16 * 1024;
pub const DETAIL_MAX_ROWS: usize = 20;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct Version;
impl TryFrom<u8> for Version {
    type Error = &'static str;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if value == VERSION {
            Ok(Self)
        } else {
            Err("INVALID_INPUT")
        }
    }
}
impl From<Version> for u8 {
    fn from(_: Version) -> Self {
        VERSION
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfiguredPrinterRef {
    #[serde(deserialize_with = "guid")]
    pub id: String,
    #[serde(deserialize_with = "safe_integer")]
    pub configuration_revision: u64,
}
fn guid<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    uuid::Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    if value.len() != 36 {
        return Err(serde::de::Error::custom("INVALID_INPUT"));
    }
    Ok(value)
}
fn safe_integer<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom("INVALID_INPUT"));
    }
    Ok(value)
}
fn limit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u8, D::Error> {
    let value = u8::deserialize(deserializer)?;
    if !(1..=20).contains(&value) {
        return Err(serde::de::Error::custom("INVALID_INPUT"));
    }
    Ok(value)
}
fn duration<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    let value = u16::deserialize(deserializer)?;
    if !matches!(value, 250 | 1000) {
        return Err(serde::de::Error::custom("INVALID_INPUT"));
    }
    Ok(value)
}

macro_rules! closed_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Serialize)]
        pub enum $name { $(#[serde(rename = $value)] $variant),+ }
    };
}
macro_rules! input {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
    };
}
closed_enum!(PrinterDetail { Transport => "transport", OwnedJob => "owned_job", SpoolerService => "spooler_service" });
closed_enum!(Emulation { Escpos => "escpos", StarLine => "star_line" });
closed_enum!(PauseAction { Pause => "pause", ResumeOwnPause => "resume_own_pause" });
closed_enum!(CancelSelection { OldestDeadUncertainNonfiscal => "oldest_dead_uncertain_nonfiscal" });
closed_enum!(OrphanSelection { ProvenMissingJob => "proven_missing_job" });
closed_enum!(SyncView { Capacity => "capacity", RetryDisposition => "retry_disposition", DependencyWaits => "dependency_waits" });
closed_enum!(CheckoutSlot { CurrentTerminal => "current_terminal" });
closed_enum!(CheckoutView { StatusOnly => "status_only" });
closed_enum!(CloseoutSection { CloseoutReadiness => "closeout_readiness" });
closed_enum!(UpdaterView { InstalledState => "installed_state", CurrentOffer => "current_offer" });
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "target", deny_unknown_fields)]
pub enum RouteInput {
    #[serde(rename = "api")]
    Api {},
    #[serde(rename = "printer")]
    Printer { printer: ConfiguredPrinterRef },
}
input!(InspectPrinter {
    printer: ConfiguredPrinterRef,
    detail: PrinterDetail
});
input!(ApplyProfile {
    printer: ConfiguredPrinterRef,
    emulation: Emulation
});
input!(PauseDispatch {
    printer: ConfiguredPrinterRef,
    action: PauseAction
});
input!(CancelJob {
    printer: ConfiguredPrinterRef,
    selection: CancelSelection
});
input!(CloseOrphan {
    printer: ConfiguredPrinterRef,
    selection: OrphanSelection
});
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExplainSync {
    pub view: SyncView,
    #[serde(deserialize_with = "limit")]
    pub limit: u8,
}
input!(InspectCheckout {
    slot: CheckoutSlot,
    view: CheckoutView
});
input!(ExplainCloseout {
    section: CloseoutSection
});
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SampleContention {
    #[serde(deserialize_with = "duration")]
    pub duration_ms: u16,
}
input!(InspectUpdater { view: UpdaterView });

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action_id", deny_unknown_fields)]
pub enum Action {
    #[serde(rename = "printer.inspect_owned_transport.v1")]
    InspectPrinter {
        version: Version,
        inputs: InspectPrinter,
    },
    #[serde(rename = "printer.apply_saved_profile.v1")]
    ApplyProfile {
        version: Version,
        inputs: ApplyProfile,
    },
    #[serde(rename = "printer.pause_dispatch.v1")]
    PauseDispatch {
        version: Version,
        inputs: PauseDispatch,
    },
    #[serde(rename = "printer.cancel_one_uncertain_job.v1")]
    CancelJob { version: Version, inputs: CancelJob },
    #[serde(rename = "printer.close_proven_orphan.v1")]
    CloseOrphan {
        version: Version,
        inputs: CloseOrphan,
    },
    #[serde(rename = "sync.explain_blockers.v1")]
    ExplainSync {
        version: Version,
        inputs: ExplainSync,
    },
    #[serde(rename = "network.inspect_configured_route.v1")]
    InspectRoute {
        version: Version,
        inputs: RouteInput,
    },
    #[serde(rename = "checkout.inspect_current_attempt.v1")]
    InspectCheckout {
        version: Version,
        inputs: InspectCheckout,
    },
    #[serde(rename = "closeout.explain_readiness.v1")]
    ExplainCloseout {
        version: Version,
        inputs: ExplainCloseout,
    },
    #[serde(rename = "runtime.sample_db_contention.v1")]
    SampleContention {
        version: Version,
        inputs: SampleContention,
    },
    #[serde(rename = "updater.inspect_offer.v1")]
    InspectUpdater {
        version: Version,
        inputs: InspectUpdater,
    },
}
impl Action {
    pub fn id(&self) -> &'static str {
        match self {
            Self::InspectPrinter { .. } => "printer.inspect_owned_transport.v1",
            Self::ApplyProfile { .. } => "printer.apply_saved_profile.v1",
            Self::PauseDispatch { .. } => "printer.pause_dispatch.v1",
            Self::CancelJob { .. } => "printer.cancel_one_uncertain_job.v1",
            Self::CloseOrphan { .. } => "printer.close_proven_orphan.v1",
            Self::ExplainSync { .. } => "sync.explain_blockers.v1",
            Self::InspectRoute { .. } => "network.inspect_configured_route.v1",
            Self::InspectCheckout { .. } => "checkout.inspect_current_attempt.v1",
            Self::ExplainCloseout { .. } => "closeout.explain_readiness.v1",
            Self::SampleContention { .. } => "runtime.sample_db_contention.v1",
            Self::InspectUpdater { .. } => "updater.inspect_offer.v1",
        }
    }
    pub fn changes_state(&self) -> bool {
        matches!(
            self,
            Self::ApplyProfile { .. }
                | Self::PauseDispatch { .. }
                | Self::CancelJob { .. }
                | Self::CloseOrphan { .. }
        )
    }
    pub fn tier(&self) -> u8 {
        match self {
            Self::ExplainCloseout { .. } => 1,
            Self::CancelJob { .. } => 3,
            _ => 2,
        }
    }
    pub fn printer(&self) -> Option<&ConfiguredPrinterRef> {
        match self {
            Self::InspectPrinter { inputs, .. } => Some(&inputs.printer),
            Self::ApplyProfile { inputs, .. } => Some(&inputs.printer),
            Self::PauseDispatch { inputs, .. } => Some(&inputs.printer),
            Self::CancelJob { inputs, .. } => Some(&inputs.printer),
            Self::CloseOrphan { inputs, .. } => Some(&inputs.printer),
            Self::InspectRoute {
                inputs: RouteInput::Printer { printer },
                ..
            } => Some(printer),
            _ => None,
        }
    }
}

pub fn parse(value: Value) -> Result<Action, String> {
    if !delivery::valid_schema(
        &contracts::shared().payload_schemas["till_run_catalogue_action"],
        &value,
        0,
    ) {
        return Err("INVALID_INPUT".into());
    }
    serde_json::from_value(value).map_err(|_| "INVALID_INPUT".into())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalPayload {
    action_id: String,
    version: Version,
    inputs: CancelJob,
    target_fingerprint: String,
    catalogue_version: Version,
    implementation_version: Version,
    terminal_id: String,
    session_id: String,
    expires_at: String,
}
pub fn canonical_payload(value: Value) -> Result<String, String> {
    if !delivery::valid_schema(
        &contracts::shared().payload_schemas["breakglass_propose_catalogue_action"],
        &value,
        0,
    ) {
        return Err("INVALID_INPUT".into());
    }
    let payload: CanonicalPayload = serde_json::from_value(value).map_err(|_| "INVALID_INPUT")?;
    if payload.action_id != "printer.cancel_one_uncertain_job.v1" || IMPLEMENTATION_VERSION != 1 {
        return Err("INVALID_INPUT".into());
    }
    let value = serde_json::to_value(payload).map_err(|_| "INVALID_INPUT")?;
    serde_json::to_string(&value).map_err(|_| "INVALID_INPUT".into())
}

fn enumeration(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}
fn integer(max: u64) -> Value {
    json!({"type":"integer","minimum":0,"maximum":max})
}
fn object(fields: &[(&str, Value)]) -> Value {
    json!({"type":"object","additionalProperties":false,"required":fields.iter().map(|(k,_)|*k).collect::<Vec<_>>(),"properties":fields.iter().map(|(k,v)|(k.to_string(),v.clone())).collect::<serde_json::Map<_,_>>()})
}
fn detail_schema(action: &Action) -> (&'static str, Value) {
    let int = || integer(9_007_199_254_740_991);
    let boolean = || json!({"type":"boolean"});
    let status = || enumeration(&["available", "unavailable", "unknown", "not_applicable"]);
    match action {
        Action::InspectPrinter { .. } => (
            "printer_owner",
            object(&[
                (
                    "transport",
                    enumeration(&["raw_tcp", "windows_spooler", "other", "unknown"]),
                ),
                (
                    "ownership",
                    enumeration(&["owned", "foreign", "missing", "unknown", "not_applicable"]),
                ),
                (
                    "state",
                    enumeration(&[
                        "idle",
                        "queued",
                        "submitting",
                        "unknown",
                        "completed",
                        "cancelled",
                        "failed",
                        "unavailable",
                        "not_applicable",
                    ]),
                ),
                (
                    "service",
                    enumeration(&[
                        "running",
                        "stopped",
                        "absent",
                        "unavailable",
                        "not_applicable",
                    ]),
                ),
                ("observed_age_ms", int()),
            ]),
        ),
        Action::ApplyProfile { .. } => (
            "device_apply",
            object(&[
                ("status", status()),
                ("readback_matches", boolean()),
                ("reachability", status()),
            ]),
        ),
        Action::PauseDispatch { .. } => (
            "printer_owner",
            object(&[
                ("status", status()),
                ("paused", boolean()),
                ("in_flight", boolean()),
            ]),
        ),
        Action::CancelJob { .. } => (
            "printer_owner",
            object(&[
                (
                    "state",
                    enumeration(&[
                        "cancel_requested",
                        "cancel_confirmed",
                        "cancel_failed",
                        "unknown",
                    ]),
                ),
                ("lane_released", boolean()),
                ("physical_output", enumeration(&["unknown"])),
            ]),
        ),
        Action::CloseOrphan { .. } => (
            "native_orphan_close",
            object(&[
                ("missing_job_proven", boolean()),
                ("lane_released", boolean()),
                ("live_worker", boolean()),
            ]),
        ),
        Action::ExplainCloseout { .. } => (
            "closeout_readiness",
            object(&[
                (
                    "state",
                    enumeration(&["ready", "blocked", "unknown", "unavailable"]),
                ),
                ("active_shifts", int()),
                ("pending_payments", int()),
                ("pending_fiscal", int()),
                ("queued_closeouts", int()),
            ]),
        ),
        Action::ExplainSync { .. } => (
            "sync_queue",
            object(&[
                (
                    "source",
                    enumeration(&[
                        "central_queue",
                        "checkout_attempts",
                        "table_attempts",
                        "repair_attachments",
                        "z_submissions",
                        "gift_funding",
                        "gift_returns",
                        "payment_sync",
                        "adjustment_sync",
                        "drawer_sync",
                    ]),
                ),
                (
                    "disposition",
                    enumeration(&[
                        "capacity",
                        "exhausted_transport",
                        "rate_limited",
                        "dependency_wait",
                        "financial_gate",
                        "terminal_rejection",
                        "conflict",
                        "set_aside",
                        "unknown",
                        "unavailable",
                    ]),
                ),
                ("count", int()),
                ("retry_after_s", json!({"anyOf":[int(),{"type":"null"}]})),
            ]),
        ),
        Action::InspectRoute { .. } => (
            "configured_route",
            object(&[
                ("target", enumeration(&["api", "printer"])),
                ("state", status()),
                ("evidence", enumeration(&["local_only", "onsite_required"])),
                ("observed_age_ms", int()),
                (
                    "connectivity_type",
                    enumeration(&["wifi", "ethernet", "cellular", "other", "none"]),
                ),
                (
                    "route_present",
                    json!({"anyOf":[boolean(),enumeration(&["unknown"])]}),
                ),
                (
                    "retained_api_observation",
                    json!({"anyOf":[object(&[("state",enumeration(&["unavailable"]))]),object(&[("state",enumeration(&["reachable","unreachable"])),("observed_age_ms",int())])]}),
                ),
            ]),
        ),
        Action::InspectCheckout { .. } => (
            "checkout_journal",
            object(&[
                (
                    "state",
                    enumeration(&["saved", "not_found", "uncertain", "unavailable"]),
                ),
                (
                    "phase",
                    enumeration(&[
                        "none",
                        "editing",
                        "checkout_pending",
                        "pending_creation",
                        "canonical",
                        "acknowledged",
                        "blocked",
                        "parked",
                        "charged",
                        "unknown_card",
                        "pending_cash",
                        "retained",
                        "unknown",
                        "unavailable",
                    ]),
                ),
                ("generation", int()),
                ("order_exists", boolean()),
                ("payment_rows_present", boolean()),
                ("ecr_attempt_present", boolean()),
                ("held_correction_present", boolean()),
                ("pending_payments", int()),
                ("failed_payments", int()),
                ("parked_attempts", int()),
                (
                    "recovery",
                    enumeration(&[
                        "none",
                        "resume_checkout",
                        "cashier_payment_recovery",
                        "manager_park",
                        "local_health",
                        "unknown",
                    ]),
                ),
            ]),
        ),
        Action::SampleContention { .. } => (
            "runtime_lock_tracker",
            object(&[
                (
                    "state",
                    enumeration(&[
                        "observed_free",
                        "traced_holder",
                        "untraced_contention",
                        "poisoned",
                        "unavailable",
                    ]),
                ),
                (
                    "label",
                    enumeration(&[
                        "none",
                        "support",
                        "checkout",
                        "sync",
                        "printing",
                        "other_compiled",
                        "unknown",
                    ]),
                ),
                ("held_ms", int()),
                ("samples", integer(20)),
                ("elapsed_ms", integer(1000)),
            ]),
        ),
        Action::InspectUpdater { .. } => {
            let version = json!({"type":"array","minItems":3,"maxItems":3,"items":int()});
            (
                "updater_owner",
                object(&[
                    (
                        "state",
                        enumeration(&[
                            "no_newer_offer",
                            "newer_offer",
                            "lower_offer",
                            "unreachable",
                            "unavailable",
                            "unknown",
                        ]),
                    ),
                    ("installed_version", version.clone()),
                    (
                        "offered_version",
                        json!({"anyOf":[version,{"type":"null"}]}),
                    ),
                    ("artifact_verified", json!({"type":"boolean","const":false})),
                ]),
            )
        }
    }
}
pub fn validate_output(action: &Action, value: &Value) -> Result<(), String> {
    if serde_json::to_vec(value)
        .map_err(|_| "INVALID_INPUT")?
        .len()
        > OUTPUT_MAX_BYTES
        || value["details"]
            .as_array()
            .is_some_and(|v| v.len() > DETAIL_MAX_ROWS)
    {
        return Err("RESULT_TOO_LARGE".into());
    }
    let (source, mut detail) = detail_schema(action);
    if !matches!(
        action,
        Action::CancelJob { .. } | Action::CloseOrphan { .. }
    ) {
        detail["properties"]["unavailable_reason"] = enumeration(&[
            "live_check_on_site",
            "no_pure_offer_check",
            "owner_table_missing",
            "read_failed",
        ]);
    }
    if matches!(action, Action::InspectCheckout { .. }) {
        detail["properties"]["checkout_in_progress"] = json!({"type":"boolean"});
    }
    if matches!(action, Action::InspectPrinter { .. }) {
        detail["properties"]["cancel_target_fingerprint"] =
            json!({"type":"string","pattern":"^[a-f0-9]{64}$"});
    }
    if matches!(action, Action::InspectRoute { .. }) {
        detail["properties"]["retained_api_observation"]["anyOf"][0]["properties"]
            ["unavailable_reason"] = enumeration(&[
            "live_check_on_site",
            "no_pure_offer_check",
            "owner_table_missing",
            "read_failed",
        ]);
    }
    if detail.is_null() {
        return Err("FEATURE_DISABLED".into());
    }
    if super::owner(action).is_some_and(|owner| owner.source() != source) {
        return Err("INTERNAL_ERROR".into());
    }
    let schema = object(&[
        ("kind", enumeration(&["untrusted_till_data"])),
        (
            "outcome",
            enumeration(&["pending", "failed", "unknown", "resolved"]),
        ),
        (
            "observation_time",
            json!({"type":"string","format":"date-time"}),
        ),
        ("source", enumeration(&[source])),
        ("complete", json!({"type":"boolean"})),
        (
            "details",
            json!({"type":"array","maxItems":DETAIL_MAX_ROWS,"items":detail}),
        ),
    ]);
    if !delivery::valid_schema(&schema, value, 0) {
        return Err("INVALID_INPUT".into());
    }
    Ok(())
}
