//! Task 21.25: common lifetime, scoped targets and durable mutation admission.
//! Handler modules for 21.26/21.27 plug into this boundary, never around it.
pub mod contract;
pub mod printer_mutations;
mod read_only;
use self::contract::{Action, ConfiguredPrinterRef};
use super::{
    clock,
    contracts::{self, Command},
    critical_op::{self, SupportPermit},
    delivery,
    guards::Scope,
    replica,
    session::Runtime,
    snapshot,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Owner {
    DeviceApply,
    PrinterMutation,
    NativeOrphanClose,
    CloseoutReadiness,
    InspectPrinter,
    ExplainSync,
    InspectRoute,
    InspectCheckout,
    SampleContention,
    InspectUpdater,
}
impl Owner {
    pub fn source(self) -> &'static str {
        match self {
            Self::DeviceApply => "device_apply",
            Self::PrinterMutation => "printer_owner",
            Self::NativeOrphanClose => "native_orphan_close",
            Self::CloseoutReadiness => "closeout_readiness",
            Self::InspectPrinter => "printer_owner",
            Self::ExplainSync => "sync_queue",
            Self::InspectRoute => "configured_route",
            Self::InspectCheckout => "checkout_journal",
            Self::SampleContention => "runtime_lock_tracker",
            Self::InspectUpdater => "updater_owner",
        }
    }
}
pub fn owner(action: &Action) -> Option<Owner> {
    match action {
        Action::ApplyProfile { .. } => Some(Owner::DeviceApply),
        Action::PauseDispatch { .. } | Action::CancelJob { .. } => Some(Owner::PrinterMutation),
        Action::CloseOrphan { .. } => Some(Owner::NativeOrphanClose),
        Action::ExplainCloseout { .. } => Some(Owner::CloseoutReadiness),
        Action::InspectPrinter { .. } => Some(Owner::InspectPrinter),
        Action::ExplainSync { .. } => Some(Owner::ExplainSync),
        Action::InspectRoute { .. } => Some(Owner::InspectRoute),
        Action::InspectCheckout { .. } => Some(Owner::InspectCheckout),
        Action::SampleContention { .. } => Some(Owner::SampleContention),
        Action::InspectUpdater { .. } => Some(Owner::InspectUpdater),
    }
}

/// A mutation target's stable identity is distinct from its current state.
#[derive(Clone, Debug)]
pub struct Target {
    pub key: String,
    pub fingerprint: String,
}
#[derive(Debug)]
pub struct ResolvedPrinter {
    pub fingerprint: String,
}

fn local_scope(conn: &Connection) -> Result<Scope, String> {
    super::identity::local(conn)
}
fn profile(conn: &Connection, scope: &Scope, id: &str) -> Result<Value, String> {
    if local_scope(conn)? != *scope || uuid::Uuid::parse_str(id).is_err() {
        return Err("PAYLOAD_DRIFT".into());
    }
    // The existing owner explicitly projects this terminal-local table. No
    // SELECT * can silently widen this read if a future column is sensitive.
    let value =
        crate::printers::support_get_printer_profile(conn, id).map_err(|_| "PAYLOAD_DRIFT")?;
    if value["enabled"] != true {
        return Err("PAYLOAD_DRIFT".into());
    }
    Ok(value)
}
fn fingerprint(scope: &Scope, value: &Value) -> String {
    contracts::payload_hash(
        &json!({"organization_id":scope.organization_id,"branch_id":scope.branch_id,"terminal_id":scope.terminal_id,"profile":value}),
    )
}
fn revision(fingerprint: &str) -> Result<u64, String> {
    // A deterministic 52-bit configuration revision fits the shared safe integer
    // contract. Intent/approval binding retains the full 256-bit fingerprint.
    u64::from_str_radix(fingerprint.get(..13).ok_or("PAYLOAD_DRIFT")?, 16)
        .map_err(|_| "PAYLOAD_DRIFT".into())
}
/// Producer seam for the printer catalogue: no business DB migration required.
pub fn configured_printer_ref(
    conn: &Connection,
    scope: &Scope,
    id: &str,
) -> Result<ConfiguredPrinterRef, String> {
    let value = profile(conn, scope, id)?;
    Ok(ConfiguredPrinterRef {
        id: id.into(),
        configuration_revision: revision(&fingerprint(scope, &value))?,
    })
}
pub fn resolve_printer(
    conn: &Connection,
    scope: &Scope,
    reference: &ConfiguredPrinterRef,
) -> Result<ResolvedPrinter, String> {
    let value = profile(conn, scope, &reference.id)?;
    let fingerprint = fingerprint(scope, &value);
    if reference.configuration_revision != revision(&fingerprint)? {
        return Err("PAYLOAD_DRIFT".into());
    }
    Ok(ResolvedPrinter { fingerprint })
}

/// Age must come from the authenticated observation owner, never from the time
/// this accessor happened to read a cache. Unknown age cannot enable mutations.
pub fn check_availability(
    action: &Action,
    value: &Value,
    age_ms: Option<u64>,
) -> Result<(), String> {
    let kill = format!("catalogue:{}", action.id());
    if value["disabled_tools"].as_array().is_some_and(|a| {
        a.iter()
            .any(|v| v == &kill || v == "till_run_catalogue_action")
    }) {
        return Err("FEATURE_DISABLED".into());
    }
    if action.changes_state()
        && (value["available"] != true
            || value["catalogue_mutations"] != true
            || !age_ms.is_some_and(|age| age <= 60_000)
            || !value["disabled_tools"]
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string)))
    {
        return Err("FEATURE_DISABLED".into());
    }
    Ok(())
}

pub fn check_session(
    command: &Command,
    action: &Action,
    admission: &delivery::Admission,
    clock: &clock::ServerClock,
    presented: bool,
) -> Result<(), String> {
    if !presented || !admission.visible {
        return Err("TILL_PAUSED".into());
    }
    delivery::recheck(command, admission, clock, Instant::now()).map_err(str::to_string)?;
    if action.tier() > admission.tier_ceiling || !admission.tiers_enabled.contains(&action.tier()) {
        return Err("TIER_NOT_ALLOWED".into());
    }
    if admission
        .disabled_tools
        .contains(&format!("catalogue:{}", action.id()))
    {
        return Err("FEATURE_DISABLED".into());
    }
    Ok(())
}

/// Implementations preserve each owner's admission, confirmation and verification.
/// A waiting owner must call Execution::checkpoint after each wait and before
/// effects. It must use the supplied permit for SQLite/native cancellation.
pub trait Environment {
    fn checkpoint(
        &self,
        command: &Command,
        action: &Action,
        permit: &SupportPermit,
    ) -> Result<(), String>;
    fn target(&self, action: &Action, permit: &SupportPermit) -> Result<Target, String>;
    fn current_target(&self, action: &Action, permit: &SupportPermit) -> Result<Target, String> {
        self.target(action, permit)
    }
    fn supported(&self, owner: Owner) -> bool;
    fn snapshot(&self, execution: &Execution<'_>) -> Result<String, String>;
    fn delegate(&self, owner: Owner, execution: &Execution<'_>) -> Result<Value, String>;
}
pub struct Execution<'a> {
    pub command: &'a Command,
    pub action: &'a Action,
    pub permit: &'a SupportPermit,
    environment: &'a dyn Environment,
    target: &'a Target,
    accepted_fingerprint: RefCell<Option<String>>,
    effect_started: Cell<bool>,
    deadline: Option<Instant>,
}
impl Execution<'_> {
    pub fn checkpoint(&self) -> Result<(), String> {
        if self.permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        if self.deadline.is_some_and(|at| Instant::now() >= at) {
            return Err("QUERY_TIMEOUT".into());
        }
        self.environment
            .checkpoint(self.command, self.action, self.permit)?;
        let target = self.environment.current_target(self.action, self.permit)?;
        let accepted = self.accepted_fingerprint.borrow();
        if target.key != self.target.key
            || target.fingerprint != *accepted.as_ref().unwrap_or(&self.target.fingerprint)
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        Ok(())
    }
    pub(crate) fn before_effect(&self) -> Result<(), String> {
        self.checkpoint()?;
        self.effect_started.set(true);
        Ok(())
    }
    /// Only the device owner calls this after its transactional readback. Bind
    /// that exact saved record so a later external change still refuses.
    pub(crate) fn saved_printer_fingerprint(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<String, String> {
        let scope = local_scope(conn)?;
        Ok(fingerprint(&scope, &profile(conn, &scope, id)?))
    }
    pub(crate) fn accept_saved_printer(&self, fingerprint: String) {
        *self.accepted_fingerprint.borrow_mut() = Some(fingerprint);
    }
    pub fn after_wait<T>(&self, wait: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.checkpoint()?;
        let result = wait();
        self.checkpoint()?;
        result
    }
}

/// The dry-run table already has immutable hash/target/time/result slots. A
/// namespaced record is an intent, not a SQL preview, and is never consumable
/// by dry_run::load (which requires the closed Stored preview shape).
fn begin_intent(
    store: &Connection,
    execution: &Execution<'_>,
    snapshot_id: &str,
    now: impl FnOnce() -> Result<i64, String>,
) -> Result<String, String> {
    let id = format!("catalogue-intent:{}", execution.command.command_id);
    let tx = super::db::transaction(store).map_err(|_| "INTERNAL_ERROR")?;
    execution.checkpoint()?;
    let now = now()?;
    let existing: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM support_dry_runs WHERE dry_run_id=?1)",
            [&id],
            |r| r.get(0),
        )
        .map_err(|_| "INTERNAL_ERROR")?;
    if existing {
        return Err("OUTCOME_UNKNOWN".into());
    }
    let (attempts,last,unknown): (u64,Option<i64>,bool) = tx.query_row(
        "SELECT count(*),max(json_extract(result_json,'$.attempt_at_ms')),coalesce(max(json_extract(result_json,'$.outcome')='unknown'),0) FROM support_dry_runs WHERE target_key_sha256=?1 AND json_extract(result_json,'$.kind')='catalogue_intent' AND (json_extract(result_json,'$.session_id')=?2 OR ?3)",
        params![execution.target.key,execution.command.session_id,matches!(execution.action, Action::CancelJob {..})], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_| "INTERNAL_ERROR")?;
    if unknown {
        return Err("OUTCOME_UNKNOWN".into());
    }
    let cap = if matches!(execution.action, Action::CancelJob { .. }) {
        1
    } else {
        2
    };
    if attempts >= cap {
        return Err("REMEDY_ATTEMPT_CAP".into());
    }
    if last.is_some_and(|last| now.saturating_sub(last) < 300_000) {
        return Err("REMEDY_COOLDOWN".into());
    }
    let record = json!({"kind":"catalogue_intent","session_id":execution.command.session_id,"action_id":execution.action.id(),"target_fingerprint":execution.target.fingerprint,"snapshot_id":snapshot_id,"attempt_at_ms":now,"outcome":"unknown"});
    tx.execute("INSERT INTO support_dry_runs(dry_run_id,proposal_id,payload_sha256,target_key_sha256,result_json,expires_at,consumed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",params![id,execution.command.command_id,execution.command.payload_sha256,execution.target.key,record.to_string(),execution.command.expires_at,clock::iso(now)]).map_err(|_| "INTERNAL_ERROR")?;
    tx.commit().map_err(|_| "INTERNAL_ERROR")?;
    Ok(id)
}
fn finish_intent(store: &Connection, id: &str, output: &Value) -> Result<(), String> {
    let changed = store.execute("UPDATE support_dry_runs SET result_json=json_set(result_json,'$.outcome',?1,'$.result',json(?2)) WHERE dry_run_id=?3 AND json_extract(result_json,'$.kind')='catalogue_intent' AND json_extract(result_json,'$.outcome')='unknown'",params![output["outcome"].as_str().ok_or("INVALID_INPUT")?,output.to_string(),id]).map_err(|_| "INTERNAL_ERROR")?;
    if changed != 1 {
        return Err("OUTCOME_UNKNOWN".into());
    }
    Ok(())
}

pub fn execute(
    store: &Connection,
    command: &Command,
    action: &Action,
    environment: &dyn Environment,
    now: impl FnOnce() -> Result<i64, String>,
) -> Result<Value, String> {
    let deadline = (!action.changes_state()).then(|| Instant::now() + Duration::from_secs(5));
    let permit = critical_op::global()
        .try_begin_support(action.changes_state(), None)
        .map_err(str::to_string)?;
    environment.checkpoint(command, action, &permit)?;
    let target = environment.target(action, &permit)?;
    let execution = Execution {
        command,
        action,
        permit: &permit,
        environment,
        target: &target,
        accepted_fingerprint: RefCell::new(None),
        effect_started: Cell::new(false),
        deadline,
    };
    execution.checkpoint()?;
    let owner = owner(action)
        .filter(|owner| environment.supported(*owner))
        .ok_or("FEATURE_DISABLED")?;
    let intent = if action.changes_state() {
        let snapshot_id = execution.after_wait(|| environment.snapshot(&execution))?;
        if snapshot_id.is_empty() {
            return Err("SNAPSHOT_FAILED".into());
        }
        execution.checkpoint()?;
        Some(begin_intent(store, &execution, &snapshot_id, now)?)
    } else {
        None
    };
    let result = (|| {
        execution.checkpoint()?;
        let output = environment.delegate(owner, &execution)?;
        execution.checkpoint()?;
        contract::validate_output(action, &output)?;
        Ok(output)
    })();
    match (intent, result) {
        (Some(id), Ok(output)) => {
            finish_intent(store, &id, &output)?;
            Ok(output)
        }
        (Some(id), Err(code)) if !execution.effect_started.get() => {
            finish_intent(store, &id, &json!({"outcome":"failed"}))?;
            Err(code)
        }
        (Some(_), Err(_)) => Err("OUTCOME_UNKNOWN".into()),
        (None, result) => result,
    }
}

fn native_supported(owner: Owner) -> bool {
    matches!(
        owner,
        Owner::PrinterMutation
            | Owner::CloseoutReadiness
            | Owner::DeviceApply
            | Owner::NativeOrphanClose
            | Owner::InspectPrinter
            | Owner::ExplainSync
            | Owner::InspectRoute
            | Owner::InspectCheckout
            | Owner::SampleContention
            | Owner::InspectUpdater
    )
}

fn delegate_read(owner: Owner, conn: &Connection, permit: &SupportPermit) -> Result<Value, String> {
    if owner != Owner::CloseoutReadiness {
        return Err("FEATURE_DISABLED".into());
    }
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    let value = crate::diagnostics::support_closeout_readiness(conn, permit)
        .map_err(|_| "INTERNAL_ERROR")?;
    let count = |field: &str| {
        value[field]["count"]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("INTERNAL_ERROR")
    };
    let active = count("activeStaffBlockers")?;
    let payments = count("unsettledPaymentBlockers")?;
    let fiscal = count("fiscalQueueBlockers")?;
    let queued = count("queuedCloseouts")?;
    let unsynced = count("unsyncedSyncQueue")?;
    let gift = count("giftCloseProof")?;
    let fiscal_blocks = value["fiscalQueueBlockers"]["wouldBlockClose"]
        .as_bool()
        .ok_or("INTERNAL_ERROR")?;
    let ready =
        active == 0 && payments == 0 && unsynced == 0 && queued == 0 && gift == 0 && !fiscal_blocks;
    if permit.is_cancelled() {
        return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
    }
    Ok(
        json!({"kind":"untrusted_till_data","outcome":"resolved","observation_time":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"source":"closeout_readiness","complete":true,"details":[{"state":if ready{"ready"}else{"blocked"},"active_shifts":active,"pending_payments":payments,"pending_fiscal":fiscal,"queued_closeouts":queued}]}),
    )
}

struct Native<'a> {
    app: &'a tauri::AppHandle,
    runtime: &'a Runtime,
    live: PathBuf,
    scope: Scope,
    deadline: Option<Instant>,
    store: &'a Connection,
    approval: Option<super::approval_verify::ConsumedCommandApproval>,
    preview: RefCell<Option<crate::print::SupportPrintPreview>>,
    approved_target: Option<String>,
}
/// The target fingerprint a tier-3 cancellation payload must carry: the
/// printer's configuration fingerprint bound to the previewed job and attempt.
fn cancel_target_fingerprint(profile: &str, preview: &crate::print::SupportPrintPreview) -> String {
    contracts::payload_hash(&json!({"profile":profile,"attempt":preview.fingerprint}))
}
impl Native<'_> {
    fn cancel_preview(
        &self,
        printer_id: &str,
        permit: &SupportPermit,
    ) -> Result<crate::print::SupportPrintPreview, String> {
        let db = crate::print::support_printer_connection(&self.live)?;
        crate::print::support_preview_uncertain(
            &db,
            printer_id,
            permit,
            Instant::now() + Duration::from_secs(2),
        )
    }
    fn cancel_target(
        &self,
        reference: &ConfiguredPrinterRef,
        permit: &SupportPermit,
    ) -> Result<String, String> {
        let profile_fingerprint =
            resolve_printer(&self.read(permit)?, &self.scope, reference)?.fingerprint;
        let preview = self.cancel_preview(&reference.id, permit)?;
        Ok(cancel_target_fingerprint(&profile_fingerprint, &preview))
    }
    fn read(&self, permit: &SupportPermit) -> Result<Connection, String> {
        let conn = replica::read_connection(
            &self.live,
            permit,
            self.deadline
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(5)),
        )?;
        conn.execute_batch("PRAGMA query_only=ON")
            .map_err(replica::sql_error)?;
        Ok(conn)
    }
}
impl Environment for Native<'_> {
    fn checkpoint(
        &self,
        command: &Command,
        action: &Action,
        permit: &SupportPermit,
    ) -> Result<(), String> {
        if permit.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        if self.deadline.is_some_and(|at| Instant::now() >= at) {
            return Err("QUERY_TIMEOUT".into());
        }
        if !self.runtime.banner_ready.load(Ordering::Acquire)
            || !super::dispatch::window_visible(self.app)
        {
            return Err("TILL_PAUSED".into());
        }
        let core = self.runtime.core.lock().map_err(|_| "INTERNAL_ERROR")?;
        let session = core.session.as_ref().ok_or("SESSION_ENDED")?;
        check_session(command, action, &session.admission, &core.clock, true)?;
        let conn = self.read(permit)?;
        if super::identity::for_session(&conn, &core, &command.session_id)? != self.scope {
            return Err("PAYLOAD_DRIFT".into());
        }
        drop(core);
        let (value, age) = self
            .app
            .try_state::<std::sync::Arc<crate::sync::SyncState>>()
            .map(|state| crate::sync::support_availability_with_age(&self.live, &state))
            .unwrap_or((Value::Null, None));
        check_availability(action, &value, age)?;
        if printer_mutations::handles(action) {
            printer_mutations::authorize(self.app)?;
        }
        printer_mutations::recheck_approval(self, command)
    }
    fn target(&self, action: &Action, permit: &SupportPermit) -> Result<Target, String> {
        if let Some(reference) = action.printer() {
            let resolved = resolve_printer(&self.read(permit)?, &self.scope, reference)?;
            if resolved.fingerprint
                != fingerprint(
                    &self.scope,
                    &profile(&self.read(permit)?, &self.scope, &reference.id)?,
                )
            {
                return Err("PAYLOAD_DRIFT".into());
            }
            if matches!(action, Action::CancelJob { .. }) {
                *self.preview.borrow_mut() = Some(self.cancel_preview(&reference.id, permit)?);
            }
        }
        let target = self.current_target(action, permit)?;
        if matches!(action, Action::CancelJob { .. })
            && target.fingerprint
                != self
                    .approved_target
                    .as_deref()
                    .ok_or("APPROVAL_NOT_VERIFIED")?
        {
            return Err("PAYLOAD_DRIFT".into());
        }
        Ok(target)
    }
    fn current_target(&self, action: &Action, permit: &SupportPermit) -> Result<Target, String> {
        let conn = self.read(permit)?;
        if local_scope(&conn)? != self.scope {
            return Err("PAYLOAD_DRIFT".into());
        }
        let identity = json!({"organization_id":self.scope.organization_id,"branch_id":self.scope.branch_id,"terminal_id":self.scope.terminal_id,"printer_id":action.printer().map(|p|&p.id)});
        let fingerprint = if let Some(reference) = action.printer() {
            fingerprint(&self.scope, &profile(&conn, &self.scope, &reference.id)?)
        } else {
            contracts::payload_hash(&identity)
        };
        let preview = self.preview.borrow();
        let (key, fingerprint) = if matches!(action, Action::CancelJob { .. }) {
            let preview = preview.as_ref().ok_or("PAYLOAD_DRIFT")?;
            (
                contracts::payload_hash(
                    &json!({"action":"cancel_one_uncertain_job","job":preview.job_id,"attempt":preview.attempt_id.to_string()}),
                ),
                cancel_target_fingerprint(&fingerprint, preview),
            )
        } else {
            (
                match action {
                    Action::PauseDispatch { inputs, .. } => contracts::payload_hash(
                        &json!({"identity":identity,"control":serde_json::to_value(inputs.action).map_err(|_|"INVALID_INPUT")?}),
                    ),
                    _ => contracts::payload_hash(&identity),
                },
                fingerprint,
            )
        };
        Ok(Target { key, fingerprint })
    }
    fn supported(&self, owner: Owner) -> bool {
        native_supported(owner)
    }
    fn snapshot(&self, execution: &Execution<'_>) -> Result<String, String> {
        execution.checkpoint()?;
        let path = self
            .runtime
            .core
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .executor
            .db
            .path
            .clone();
        let store = Connection::open(path).map_err(|_| "SNAPSHOT_FAILED")?;
        store
            .busy_timeout(Duration::from_millis(100))
            .map_err(|_| "SNAPSHOT_FAILED")?;
        let snapshot = snapshot::take(
            &store,
            &self.live,
            &execution.command.session_id,
            None,
            execution.action.id(),
            execution.permit,
        )?;
        snapshot::verify_with(&snapshot, Some(execution.permit))?;
        execution.checkpoint()?;
        Ok(snapshot.id)
    }
    fn delegate(&self, owner: Owner, execution: &Execution<'_>) -> Result<Value, String> {
        if printer_mutations::handles(execution.action) {
            return printer_mutations::run(self, execution);
        }
        if read_only::handles(execution.action) {
            // The tier-3 proposal needs the target this till would accept; the
            // inspection returns it only while exactly one job qualifies.
            let cancel_target = match execution.action {
                Action::InspectPrinter { inputs, .. } => {
                    self.cancel_target(&inputs.printer, execution.permit).ok()
                }
                _ => None,
            };
            let conn = self.read(execution.permit)?;
            return read_only::run(self.app, &conn, execution, cancel_target.as_deref());
        }
        execution.checkpoint()?;
        if owner == Owner::NativeOrphanClose {
            let reference = execution.action.printer().ok_or("INVALID_INPUT")?;
            let conn = crate::print_dispatch::support_orphan_connection(&self.live)?;
            execution.checkpoint()?;
            let value = crate::print_dispatch::DispatchManager::new()
                .support_close_selected_profile(
                    &conn,
                    &reference.id,
                    execution.permit,
                    &|| execution.checkpoint(),
                    &|| execution.before_effect(),
                    chrono::Utc::now(),
                )?;
            return Ok(
                json!({"kind":"untrusted_till_data","outcome":"resolved","observation_time":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"source":"native_orphan_close","complete":true,"details":[{"missing_job_proven":value.missing_job_proven,"lane_released":value.lane_released,"live_worker":value.live_worker}]}),
            );
        }
        if owner == Owner::DeviceApply {
            let path = self
                .runtime
                .core
                .lock()
                .map_err(|_| "INTERNAL_ERROR")?
                .executor
                .db
                .path
                .clone();
            let store = Connection::open(path).map_err(|_| "INTERNAL_ERROR")?;
            store
                .busy_timeout(Duration::from_millis(100))
                .map_err(|_| "INTERNAL_ERROR")?;
            let context = self
                .runtime
                .core
                .lock()
                .map_err(|_| "INTERNAL_ERROR")?
                .approval_context()?;
            let value = super::device_apply::apply_catalogue_saved_profile(
                self.app, &store, execution, &context,
            )?;
            return Ok(
                json!({"kind":"untrusted_till_data","outcome":value["outcome"],"observation_time":value["observation_time"],"source":"device_apply","complete":true,"details":[{"status":if value["read_back"]["matches_record"]==true{"available"}else{"unavailable"},"readback_matches":value["read_back"]["matches_record"],"reachability":"unavailable","unavailable_reason":"live_check_on_site"}]}),
            );
        }
        let conn = self.read(execution.permit)?;
        delegate_read(owner, &conn, execution.permit)
    }
}

/// Called only on dispatch's blocking pool. No business mutex or keyring access.
pub fn run(
    app: &tauri::AppHandle,
    runtime: &Runtime,
    store: &Connection,
    command: &Command,
    approval: Option<super::approval_verify::ConsumedCommandApproval>,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    if !matches!(
        (command.kind.as_str(), approval.is_some()),
        ("breakglass_propose_catalogue_action", true) | ("till_run_catalogue_action", false)
    ) {
        return Err("APPROVAL_NOT_VERIFIED".into());
    }
    let action = if approval.is_some() {
        contract::parse(
            json!({"action_id":command.payload["action_id"],"version":command.payload["version"],"inputs":command.payload["inputs"]}),
        )?
    } else {
        contract::parse(command.payload.clone())?
    };
    if matches!(action, Action::CancelJob { .. }) && approval.is_none() {
        return Err("APPROVAL_NOT_VERIFIED".into());
    }
    if owner(&action).is_none() {
        return Err("FEATURE_DISABLED".into());
    }
    let live = app.state::<crate::db::DbState>().db_path.clone();
    let permit = critical_op::global()
        .try_begin_support(false, None)
        .map_err(str::to_string)?;
    let conn = replica::read_connection(&live, &permit, Instant::now() + Duration::from_secs(1))?;
    let scope = local_scope(&conn)?;
    drop(conn);
    drop(permit);
    let now = || {
        runtime
            .core
            .lock()
            .map_err(|_| "INTERNAL_ERROR")?
            .clock
            .now(&command.session_id)
            .ok_or_else(|| "COMMAND_EXPIRED".to_string())
    };
    execute(
        store,
        command,
        &action,
        &Native {
            app,
            runtime,
            live,
            scope,
            store,
            approval,
            preview: RefCell::new(None),
            approved_target: command.payload["target_fingerprint"]
                .as_str()
                .map(str::to_string),
            deadline: (!action.changes_state()).then_some(deadline),
        },
        now,
    )
}

#[cfg(test)]
mod tests;
