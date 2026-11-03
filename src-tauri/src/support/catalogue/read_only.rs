//! Six bounded local projections. None has a snapshot, intent or effect path.
use super::{
    contract::{Action, PrinterDetail, RouteInput, UpdaterView},
    Execution,
};
use crate::{database_lock, db::DbState, support::critical_op::SupportPermit};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

mod route;
#[cfg(test)]
mod tests;

static SAMPLING: AtomicBool = AtomicBool::new(false);

pub(super) fn handles(action: &Action) -> bool {
    matches!(
        action,
        Action::InspectPrinter { .. }
            | Action::ExplainSync { .. }
            | Action::InspectRoute { .. }
            | Action::InspectCheckout { .. }
            | Action::SampleContention { .. }
            | Action::InspectUpdater { .. }
    )
}

fn output(source: &str, complete: bool, details: Vec<Value>) -> Value {
    json!({"kind":"untrusted_till_data","outcome":if complete{"pending"}else{"unknown"},
        "observation_time":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
        "source":source,"complete":complete,"details":details})
}
fn unavailable_reason(conn: &Connection, tables: &[&str]) -> &'static str {
    for table in tables {
        match conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get::<_, bool>(0),
        ) {
            Ok(false) => return "owner_table_missing",
            Err(_) => return "read_failed",
            _ => (),
        }
    }
    "read_failed"
}
fn printer(
    conn: &Connection,
    input: &super::contract::InspectPrinter,
    cancel_target: Option<&str>,
) -> Value {
    let result = crate::print_dispatch::support_inspect_transport(conn, &input.printer.id);
    let (mut detail, mut complete) = match result {
        Ok(detail) => (detail, true),
        Err(_) => (
            json!({"transport":"unknown","ownership":"unknown","state":"unavailable","service":"unavailable","observed_age_ms":0,"unavailable_reason":unavailable_reason(conn, &["printer_profiles"])}),
            false,
        ),
    };
    if !matches!(input.detail, PrinterDetail::Transport) {
        if complete && detail["transport"] != "windows_spooler" {
            detail["state"] = json!("not_applicable");
            detail["ownership"] = json!("not_applicable");
        } else {
            if complete {
                detail["unavailable_reason"] = json!("live_check_on_site");
            }
            detail["state"] = json!("unavailable");
            detail["service"] = json!("unavailable");
            complete = false;
        }
    }
    if let Some(target) = cancel_target {
        detail["cancel_target_fingerprint"] = json!(target);
    }
    output("printer_owner", complete, vec![detail])
}
fn sync(conn: &Connection, input: &super::contract::ExplainSync) -> Result<Value, String> {
    let scope = crate::support::identity::local(conn)?;
    let (mut details, mut complete) =
        crate::sync::support_catalogue_queue_facts(conn, &scope, input.view);
    for row in &mut details {
        if row["disposition"] == "unavailable" {
            let tables: &[&str] = match row["source"].as_str() {
                Some("central_queue") => {
                    &["parity_sync_queue", "parity_sync_set_aside", "sync_queue"]
                }
                Some("checkout_attempts") => &["checkout_drafts_v1"],
                Some("table_attempts") => &["table_attempt_recovery_v1"],
                Some("repair_attachments") => &["parity_sync_queue", "parity_sync_set_aside"],
                Some("z_submissions") => &["z_reports"],
                Some("gift_funding") => &["gift_card_funding_attempts"],
                Some("gift_returns") => &["gift_card_return_attempts"],
                Some("payment_sync") => &["order_payments", "orders"],
                Some("adjustment_sync") => &["payment_adjustments", "orders"],
                Some("drawer_sync") => {
                    &["parity_sync_queue", "parity_sync_set_aside", "sync_queue"]
                }
                _ => &[],
            };
            row["unavailable_reason"] = json!(unavailable_reason(conn, tables));
        }
    }
    if details.len() > usize::from(input.limit) {
        complete = false;
        details.truncate(usize::from(input.limit));
    }
    Ok(output("sync_queue", complete, details))
}
fn checkout(conn: &Connection, db: &DbState) -> Value {
    let result = crate::checkout_drafts::inspect(conn, &json!({"view":"support_status_only"}));
    match result {
        Ok(value) => {
            // This process-local fact is not a durable journal phase. A live
            // press may still write; never turn its absent order into not_found.
            let live = value["clientRequestId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|request| crate::commands::orders::checkout_in_progress(db, request));
            let complete = live != Some(true);
            let mut detail = value["detail"].clone();
            if let Some(live) = live {
                detail["checkout_in_progress"] = json!(live);
            }
            output("checkout_journal", complete, vec![detail])
        }
        Err(_) => output(
            "checkout_journal",
            false,
            vec![
                json!({"state":"unavailable","phase":"unknown","generation":0,
            "order_exists":false,"payment_rows_present":false,"ecr_attempt_present":false,"held_correction_present":false,
            "pending_payments":0,"failed_payments":0,"parked_attempts":0,"recovery":"unknown","unavailable_reason":unavailable_reason(conn, &["checkout_drafts_v1"])}),
            ],
        ),
    }
}
fn updater(conn: &Connection, view: UpdaterView) -> Value {
    let current = matches!(view, UpdaterView::CurrentOffer);
    let result = crate::commands::updates::support_installed_state(conn);
    let (mut detail, mut complete) = match result {
        Ok(value) => (value, true),
        Err(_) => {
            let installed: Vec<u64> = env!("CARGO_PKG_VERSION")
                .split('.')
                .map(|s| s.parse().unwrap_or(0))
                .collect();
            (
                json!({"state":"unavailable","installed_version":installed,"offered_version":null,"artifact_verified":false,"unavailable_reason":unavailable_reason(conn, &["local_settings"])}),
                false,
            )
        }
    };
    if current {
        detail["unavailable_reason"] = json!("no_pure_offer_check");
        detail["state"] = json!("unavailable");
        detail["offered_version"] = Value::Null;
        complete = false;
    }
    output("updater_owner", complete, vec![detail])
}

struct Sampling;
impl Sampling {
    fn begin() -> Result<Self, String> {
        SAMPLING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "CONCURRENT_OPERATION".into())
    }
}
impl Drop for Sampling {
    fn drop(&mut self) {
        SAMPLING.store(false, Ordering::Release);
    }
}

fn sample(
    mutex: &Mutex<Connection>,
    duration_ms: u16,
    permit: &SupportPermit,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let _sampling = Sampling::begin()?;
    let start = Instant::now();
    let mut state = "observed_free";
    let mut label = "none";
    let mut held_ms = 0u64;
    let samples = duration_ms / 50;
    for index in 0..samples {
        check(permit, checkpoint)?;
        match database_lock::support_observe(mutex) {
            Err("poisoned") => {
                state = "poisoned";
                label = "unknown";
            }
            Err(_) if state != "poisoned" => {
                state = "unavailable";
                label = "unknown";
            }
            Ok(database_lock::Observation::Held(holder))
                if !matches!(state, "poisoned" | "unavailable") =>
            {
                if let Some(holder) = holder {
                    if state != "untraced_contention" {
                        state = "traced_holder";
                        label = compiled_label(holder.label);
                    }
                    held_ms = held_ms.max(
                        holder
                            .acquired_at
                            .elapsed()
                            .as_millis()
                            .min(9_007_199_254_740_991) as u64,
                    );
                } else {
                    state = "untraced_contention";
                    label = "unknown";
                }
            }
            _ => (),
        }
        // Fixed 50 ms sample cadence; short cancellable slices between ticks.
        let next = start + Duration::from_millis(u64::from(index + 1) * 50);
        while Instant::now() < next {
            std::thread::sleep(
                next.saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(5)),
            );
            check(permit, checkpoint)?;
        }
    }
    let elapsed = start.elapsed().as_millis();
    let mut detail = json!({"state":state,"label":label,"held_ms":held_ms,"samples":samples,"elapsed_ms":elapsed.min(1000)});
    if matches!(state, "poisoned" | "unavailable") {
        detail["unavailable_reason"] = json!("read_failed");
    }
    Ok(output(
        "runtime_lock_tracker",
        elapsed <= u128::from(duration_ms) + 50 && !matches!(state, "poisoned" | "unavailable"),
        vec![detail],
    ))
}
fn check(
    permit: &SupportPermit,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    checkpoint()?;
    if permit.is_cancelled() {
        Err("PREEMPTED_BY_CRITICAL_OPERATION".into())
    } else {
        Ok(())
    }
}
fn compiled_label(label: &str) -> &'static str {
    if label.starts_with("support") {
        "support"
    } else if label.starts_with("checkout") || label == "order_create_with_initial_payment" {
        "checkout"
    } else if label.starts_with("sync") || label == "parity_queue_process" {
        "sync"
    } else if label == "print_dispatch" {
        "printing"
    } else if database_lock::LOCK_LABELS.contains(&label) && label != database_lock::UNTRACED {
        "other_compiled"
    } else {
        "unknown"
    }
}

pub(super) fn run(
    app: &tauri::AppHandle,
    conn: &Connection,
    execution: &Execution<'_>,
    cancel_target: Option<&str>,
) -> Result<Value, String> {
    execution.checkpoint()?;
    let db = app.state::<DbState>();
    let result = collect(
        conn,
        &db,
        execution.action,
        execution.permit,
        &|| execution.checkpoint(),
        cancel_target,
    )?;
    execution.checkpoint()?;
    Ok(result)
}
fn collect(
    conn: &Connection,
    db: &DbState,
    action: &Action,
    permit: &SupportPermit,
    checkpoint: &dyn Fn() -> Result<(), String>,
    cancel_target: Option<&str>,
) -> Result<Value, String> {
    check(permit, checkpoint)?;
    let result = match action {
        Action::InspectPrinter { inputs, .. } => printer(conn, inputs, cancel_target),
        Action::ExplainSync { inputs, .. } => sync(conn, inputs)?,
        Action::InspectRoute { inputs, .. } => {
            let target = if matches!(inputs, RouteInput::Api { .. }) {
                "api"
            } else {
                "printer"
            };
            let detail = route::collect(target, &|| check(permit, checkpoint))?;
            let complete = detail["state"] == "available";
            output("configured_route", complete, vec![detail])
        }
        Action::InspectCheckout { .. } => checkout(conn, db),
        Action::SampleContention { inputs, .. } => {
            sample(&db.conn, inputs.duration_ms, permit, checkpoint)?
        }
        Action::InspectUpdater { inputs, .. } => updater(conn, inputs.view),
        _ => return Err("FEATURE_DISABLED".into()),
    };
    check(permit, checkpoint)?;
    super::contract::validate_output(action, &result)?;
    Ok(result)
}
