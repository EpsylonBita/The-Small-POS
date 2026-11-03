use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard, OnceLock,
    },
    time::Instant,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CriticalKind {
    Checkout,
    Card,
    Fiscal,
    ZClose,
    ShiftClose,
    Restore,
    Migration,
}
struct Work {
    write: bool,
    cancelled: Arc<AtomicBool>,
    interrupt: Option<Arc<rusqlite::InterruptHandle>>,
}
struct ProcessCancel {
    cancelled: Arc<AtomicBool>,
    handle: Option<Box<dyn FnOnce() + Send>>,
}
#[derive(Default)]
struct State {
    restore: bool,
    next: u64,
    critical: BTreeMap<u64, CriticalKind>,
    work: BTreeMap<u64, Work>,
    process_cancels: BTreeMap<u64, ProcessCancel>,
    history: VecDeque<(Instant, CriticalKind)>,
    lost_before: Option<Instant>,
}
#[derive(Default)]
pub struct CriticalOpGate {
    state: Mutex<State>,
    changed: Condvar,
}
pub struct RestoreLease {
    gate: Arc<CriticalOpGate>,
}
impl Drop for RestoreLease {
    fn drop(&mut self) {
        self.gate.lock().restore = false;
        self.gate.changed.notify_all();
    }
}
pub struct CriticalToken {
    gate: Arc<CriticalOpGate>,
    id: u64,
}
pub struct SupportPermit {
    gate: Arc<CriticalOpGate>,
    id: u64,
    pub cancelled: Arc<AtomicBool>,
}
/// Keep alive until the command ends. A cancelled registration never becomes
/// launchable again, even after the pre-empting critical operation has ended.
// Used by the task 21.4 runner before resuming its suspended process.
#[allow(dead_code)]
pub struct ProcessCancelGuard {
    gate: Arc<CriticalOpGate>,
    id: u64,
    cancelled: Arc<AtomicBool>,
}
impl ProcessCancelGuard {
    #[allow(dead_code)]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}
impl Drop for ProcessCancelGuard {
    fn drop(&mut self) {
        let removed = self.gate.lock().process_cancels.remove(&self.id);
        // A captured job controller may itself tear down on Drop.
        drop(removed);
        self.gate.changed.notify_all();
    }
}
impl CriticalOpGate {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn begin_critical(self: &Arc<Self>, kind: CriticalKind) -> CriticalToken {
        let mut state = self.lock();
        // Existing native call sites return a token, not a Result. Hold entry
        // only for the explicitly approved restore/restart window. Ordinary
        // support writes never block or refuse a critical operation.
        while state.restore {
            state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        self.admit_critical(state, kind)
    }
    pub fn try_begin_critical(
        self: &Arc<Self>,
        kind: CriticalKind,
    ) -> Result<CriticalToken, &'static str> {
        let state = self.lock();
        if state.restore {
            return Err("RESTORE_RESTARTING");
        }
        Ok(self.admit_critical(state, kind))
    }
    fn admit_critical(
        self: &Arc<Self>,
        mut state: MutexGuard<'_, State>,
        kind: CriticalKind,
    ) -> CriticalToken {
        state.next += 1;
        let id = state.next;
        state.critical.insert(id, kind);
        state.history.push_back((Instant::now(), kind));
        if state.history.len() > 4096 {
            state.lost_before = state.history.pop_front().map(|(at, _)| at);
        }
        // No worker code runs under the gate lock. Registration and interrupt
        // share the lock, closing the write-admission/pre-emption race.
        for work in state.work.values() {
            work.cancelled.store(true, Ordering::Release);
            if let Some(handle) = &work.interrupt {
                handle.interrupt();
            }
        }
        let handles = Self::take_process_cancels(&mut state);
        drop(state);
        let token = CriticalToken {
            gate: self.clone(),
            id,
        };
        // Callbacks signal job termination synchronously, before admission
        // returns; they must not wait for exit/pipe drain. The runner owns that
        // bounded teardown. Never invoke or drop user handles under the mutex.
        for handle in handles {
            handle();
        }
        token
    }
    pub fn active(&self) -> bool {
        let state = self.lock();
        state.restore || !state.critical.is_empty()
    }
    pub fn restoring(&self) -> bool {
        self.lock().restore
    }
    pub fn begin_exclusive_restore(self: &Arc<Self>) -> Result<RestoreLease, &'static str> {
        let mut state = self.lock();
        if state.restore || !state.critical.is_empty() {
            return Err("deferred_critical_operation");
        }
        state.restore = true;
        for work in state.work.values() {
            work.cancelled.store(true, Ordering::Release);
            if let Some(handle) = &work.interrupt {
                handle.interrupt();
            }
        }
        let handles = Self::take_process_cancels(&mut state);
        drop(state);
        let lease = RestoreLease { gate: self.clone() };
        for handle in handles {
            handle();
        }
        Ok(lease)
    }
    pub fn support_idle(&self) -> bool {
        let state = self.lock();
        state.work.is_empty() && state.process_cancels.is_empty()
    }
    /// Atomically check admission and register the suspended job's termination
    /// signal. Recheck is_cancelled immediately before resume. A critical start
    /// after registration both sets that sticky flag and kills the job, including
    /// a still-suspended child, so the check/resume interval cannot escape kill.
    /// The callback must only signal termination, never wait for process exit.
    // Wired by the task 21.4 runner; deliberately contains no OS process types.
    #[allow(dead_code)]
    pub fn register_process_cancel(
        self: &Arc<Self>,
        handle: impl FnOnce() + Send + 'static,
    ) -> Result<ProcessCancelGuard, &'static str> {
        let mut state = self.lock();
        if state.restore || !state.critical.is_empty() {
            drop(state);
            return Err("deferred_critical_operation");
        }
        state.next += 1;
        let id = state.next;
        let cancelled = Arc::new(AtomicBool::new(false));
        state.process_cancels.insert(
            id,
            ProcessCancel {
                cancelled: cancelled.clone(),
                handle: Some(Box::new(handle)),
            },
        );
        Ok(ProcessCancelGuard {
            gate: self.clone(),
            id,
            cancelled,
        })
    }
    fn take_process_cancels(state: &mut State) -> Vec<Box<dyn FnOnce() + Send>> {
        state
            .process_cancels
            .values_mut()
            .filter_map(|registration| {
                registration.cancelled.store(true, Ordering::Release);
                registration.handle.take()
            })
            .collect()
    }
    pub fn try_begin_support(
        self: &Arc<Self>,
        write: bool,
        interrupt: Option<Arc<rusqlite::InterruptHandle>>,
    ) -> Result<SupportPermit, &'static str> {
        let mut state = self.lock();
        if state.restore || !state.critical.is_empty() {
            return Err("deferred_critical_operation");
        }
        if state.work.values().any(|w| w.write) || (write && !state.work.is_empty()) {
            return Err("CONCURRENT_OPERATION");
        }
        state.next += 1;
        let id = state.next;
        let cancelled = Arc::new(AtomicBool::new(false));
        state.work.insert(
            id,
            Work {
                write,
                cancelled: cancelled.clone(),
                interrupt,
            },
        );
        Ok(SupportPermit {
            gate: self.clone(),
            id,
            cancelled,
        })
    }
    // Used by task 17.10 (Phase 3 guarded writes).
    #[allow(dead_code)]
    pub fn try_begin_support_write(
        self: &Arc<Self>,
        interrupt: Arc<rusqlite::InterruptHandle>,
    ) -> Result<SupportPermit, &'static str> {
        self.try_begin_support(true, Some(interrupt))
    }
    /// None means the bounded history cannot prove this window quiet.
    // Used by task 17.10 (Phase 3 guarded writes).
    #[allow(dead_code)]
    pub fn activity_between(&self, from: Instant, to: Instant) -> Option<Vec<CriticalKind>> {
        let state = self.lock();
        if state.lost_before.is_some_and(|at| from <= at) {
            return None;
        }
        Some(
            state
                .history
                .iter()
                .filter(|(at, _)| *at >= from && *at <= to)
                .map(|(_, kind)| *kind)
                .collect(),
        )
    }
    pub fn cancel_support(&self) {
        let mut state = self.lock();
        for work in state.work.values() {
            work.cancelled.store(true, Ordering::Release);
            if let Some(handle) = &work.interrupt {
                handle.interrupt();
            }
        }
        let handles = Self::take_process_cancels(&mut state);
        drop(state);
        for handle in handles {
            handle();
        }
    }
}
impl Drop for CriticalToken {
    fn drop(&mut self) {
        self.gate.lock().critical.remove(&self.id);
        self.gate.changed.notify_all();
    }
}
impl Drop for SupportPermit {
    fn drop(&mut self) {
        self.gate.lock().work.remove(&self.id);
        self.gate.changed.notify_all();
    }
}
impl SupportPermit {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    /// The only support business-write entry: short lock wait and a native
    /// progress deadline. Callers must keep the RAII transaction on this worker.
    // Used by task 17.10 (Phase 3 guarded writes).
    #[allow(dead_code)]
    pub fn begin_write<'a>(
        &self,
        conn: &'a rusqlite::Connection,
    ) -> Result<rusqlite::Transaction<'a>, String> {
        if !self
            .gate
            .lock()
            .work
            .get(&self.id)
            .is_some_and(|work| work.write)
        {
            return Err("TIER_NOT_ALLOWED".into());
        }
        conn.busy_timeout(std::time::Duration::from_millis(100))
            .map_err(|_| "INTERNAL_ERROR")?;
        self.guard_connection(conn, Instant::now() + std::time::Duration::from_millis(250));
        if self.is_cancelled() {
            return Err("PREEMPTED_BY_CRITICAL_OPERATION".into());
        }
        crate::db::immediate_transaction(conn).map_err(|_| "PREEMPTED_BY_CRITICAL_OPERATION".into())
    }
    /// Install before BEGIN and recheck cancellation before writing. This flag
    /// also closes SQLite's idle-interrupt race and caps transaction duration.
    pub fn guard_connection(&self, conn: &rusqlite::Connection, deadline: Instant) {
        let mut state = self.gate.lock();
        let write = if let Some(work) = state.work.get_mut(&self.id) {
            let handle = Arc::new(conn.get_interrupt_handle());
            if work.cancelled.load(Ordering::Acquire) {
                handle.interrupt();
            }
            work.interrupt = Some(handle);
            work.write
        } else {
            true
        };
        drop(state);
        let deadline = if write {
            deadline.min(Instant::now() + std::time::Duration::from_millis(250))
        } else {
            deadline
        };
        let cancel = self.cancelled.clone();
        conn.progress_handler(
            if write { 1 } else { 100 },
            Some(move || cancel.load(Ordering::Acquire) || Instant::now() >= deadline),
        );
    }
}
pub fn global() -> Arc<CriticalOpGate> {
    #[cfg(test)]
    if let Some(gate) = TEST_GATE.with(|gate| gate.borrow().clone()) {
        return gate;
    }
    static GATE: OnceLock<Arc<CriticalOpGate>> = OnceLock::new();
    GATE.get_or_init(CriticalOpGate::new).clone()
}

#[cfg(test)]
thread_local! {
    static TEST_GATE: std::cell::RefCell<Option<Arc<CriticalOpGate>>> = const { std::cell::RefCell::new(None) };
}

/// Give the current test thread its own gate until the guard drops, so a checkout
/// that another test opens on the process gate cannot defer this test's support
/// write. Cross-thread pre-emption tests keep using the process gate.
#[cfg(test)]
pub(crate) fn install_test_gate() -> TestGateGuard {
    let gate = CriticalOpGate::new();
    TEST_GATE.with(|slot| *slot.borrow_mut() = Some(gate.clone()));
    TestGateGuard { _gate: gate }
}

#[cfg(test)]
pub(crate) struct TestGateGuard {
    _gate: Arc<CriticalOpGate>,
}

#[cfg(test)]
impl Drop for TestGateGuard {
    fn drop(&mut self) {
        TEST_GATE.with(|slot| *slot.borrow_mut() = None);
    }
}
pub fn begin_critical(kind: CriticalKind) -> CriticalToken {
    global().begin_critical(kind)
}
// Used by task 17.10 (Phase 3 guarded writes).
#[allow(dead_code)]
pub fn end_critical(token: CriticalToken) {
    drop(token);
}

#[derive(Default)]
struct PaymentSignals {
    tokens: BTreeMap<(String, String), Option<CriticalToken>>,
    closed: BTreeSet<(String, String)>,
    closed_windows: BTreeSet<String>,
    generation: u64,
}
impl PaymentSignals {
    fn open(&mut self, window: &str, id: &str, gate: &Arc<CriticalOpGate>) {
        if self.closed_windows.contains(window)
            || (id != "payment" && self.closed.contains(&(window.into(), id.into())))
        {
            return;
        }
        self.tokens
            .entry((window.into(), id.into()))
            .or_insert_with(|| {
                // An informational renderer signal never blocks a sale, including
                // during restore. Native financial commands keep their own guards.
                gate.try_begin_critical(CriticalKind::Checkout).ok()
            });
    }
    fn close(&mut self, window: &str, id: &str) {
        self.tokens.remove(&(window.into(), id.into()));
        if id != "payment" {
            self.closed.insert((window.into(), id.into()));
        }
    }
    fn clear(&mut self, window: Option<&str>) {
        self.tokens
            .retain(|(owner, _), _| window.is_some_and(|w| owner != w));
        self.closed
            .retain(|(owner, _)| window.is_some_and(|w| owner != w));
        if let Some(window) = window {
            self.closed_windows.insert(window.into());
        } else {
            self.generation = self.generation.wrapping_add(1);
        }
    }
    fn open_in_generation(
        &mut self,
        window: &str,
        id: &str,
        gate: &Arc<CriticalOpGate>,
        generation: u64,
    ) {
        if generation == self.generation {
            self.open(window, id, gate);
        }
    }
}
static PAYMENT_SIGNAL_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
fn payment_signals() -> &'static Mutex<PaymentSignals> {
    static SIGNALS: OnceLock<Mutex<PaymentSignals>> = OnceLock::new();
    SIGNALS.get_or_init(Mutex::default)
}
pub fn clear_payment_signals(window: Option<&str>) {
    let mut signals = payment_signals().lock().unwrap_or_else(|e| e.into_inner());
    signals.clear(window);
    PAYMENT_SIGNAL_GENERATION.store(signals.generation, Ordering::Release);
}
#[tauri::command]
pub async fn support_payment_open(
    arg0: Option<serde_json::Value>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let owner = window.label().to_owned();
    let generation = PAYMENT_SIGNAL_GENERATION.load(Ordering::Acquire);
    // A stable caller token makes repeated opens idempotent. The default also
    // makes older callers' repeated no-argument opens one signal per window.
    let id = arg0
        .as_ref()
        .and_then(|v| v.as_str().or_else(|| v["token"].as_str()))
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .unwrap_or("payment")
        .to_owned();
    crate::database_lock::run_blocking_command("support_payment_open", move || {
        payment_signals()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .open_in_generation(&owner, &id, &global(), generation);
        Ok(id)
    })
    .await
}
#[tauri::command]
pub async fn support_payment_closed(
    arg0: Option<serde_json::Value>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let owner = window.label().to_owned();
    let id = arg0
        .as_ref()
        .and_then(|v| v.as_str().or_else(|| v["token"].as_str()))
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .unwrap_or("payment")
        .to_owned();
    crate::database_lock::run_blocking_command("support_payment_closed", move || {
        payment_signals()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close(&owner, &id);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod payment_signal_tests {
    use super::*;
    #[test]
    fn delayed_open_after_close_window_destroy_or_session_end_cannot_leak_a_token() {
        let _gate = install_test_gate();
        let gate = global();
        let mut signals = PaymentSignals::default();
        signals.close("main", "your_cancelled_modal");
        signals.open("main", "your_cancelled_modal", &gate);
        assert!(!gate.active());
        signals.clear(Some("closed_window"));
        signals.open("closed_window", "your_delayed_open", &gate);
        assert!(!gate.active());
        let generation = signals.generation;
        signals.clear(None);
        signals.open_in_generation("main", "your_old_session", &gate, generation);
        assert!(!gate.active());
        signals.open_in_generation("main", "your_new_session", &gate, signals.generation);
        assert!(gate.active());
        signals.clear(None);
        assert!(!gate.active());
    }
    #[test]
    fn duplicate_open_close_and_window_session_cleanup_are_idempotent() {
        let _gate = install_test_gate();
        let gate = global();
        let mut signals = PaymentSignals::default();
        signals.open("main", "your_payment", &gate);
        signals.open("main", "your_payment", &gate);
        assert_eq!(gate.lock().critical.len(), 1);
        signals.close("main", "your_payment");
        signals.close("main", "your_payment");
        assert!(!gate.active());
        signals.open("main", "your_first", &gate);
        signals.open("other", "your_second", &gate);
        signals.clear(Some("main"));
        assert_eq!(gate.lock().critical.len(), 1);
        signals.clear(None);
        assert!(!gate.active());
    }
    #[test]
    fn payment_signal_during_restore_never_waits_or_refuses_payment() {
        let _gate = install_test_gate();
        let gate = global();
        let lease = gate.begin_exclusive_restore().unwrap();
        let mut signals = PaymentSignals::default();
        let start = Instant::now();
        signals.open("main", "your_payment", &gate);
        assert!(start.elapsed() < std::time::Duration::from_millis(50));
        signals.close("main", "your_payment");
        drop(lease);
        assert!(!gate.active());
    }
}
