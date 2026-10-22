//! Traced access to a SQLite connection mutex, and a watchdog for long holds.
//!
//! Tomikro, 20/10/2026, 1.4.133: around 16:34Z the till window froze and
//! "Complete order" in the cart did nothing for 7–15 minutes, and the support
//! bundle held no refusal code. Twenty-six Tauri commands, among them the
//! checkout draft save, were plain synchronous `fn`s. Tauri 2 runs those on the
//! main (window) thread, and most of them wait for `DbState.conn`, a
//! `std::sync::Mutex`. While another holder kept the connection, the main
//! thread blocked inside the mutex and the whole window stopped responding.
//! The commands are now `async fn`s that run their body on Tokio's blocking
//! pool through [`run_blocking_command`], pinned by
//! `commands::diagnostics::main_thread_command_audit`. This module also makes
//! the next long wait visible.
//!
//! Three fixed warn codes, which both support-bundle projectors keep
//! (`diagnostics_runtime_logs.rs` and `shared/pos/health/runtime-log-events.ts`):
//! - `db_lock_wait_slow`: a traced acquisition waited more than 500 ms. The
//!   line names the waiting site (`lock_label`), the site that held the lock
//!   when the wait began (`holder_label`) and the wait (`duration_ms`).
//! - `db_lock_held_long`: the watchdog found the main connection held for more
//!   than 3 s without a break. Once per episode, with the holder and the hold
//!   so far (`duration_ms`).
//! - `db_lock_released`: the watchdog saw the lock of a reported episode free
//!   again (or taken by another holder); `duration_ms` is the hold up to that
//!   check, at most one check interval late.
//!
//! Labels are fixed names of code sites from [`LOCK_LABELS`], never data. A
//! holder that took the lock with a plain `conn.lock()` is `untraced`.
//!
//! Holders are recorded per mutex: the till opens one connection per
//! background worker (sync loop, print worker, ...), each behind its own
//! mutex, and only the main one (the Tauri-managed `DbState`) is watched.
//! Those connections contend with the main one inside SQLite (busy timeout),
//! which shows up here as a long hold by the waiting statement's site.

use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LockResult, Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{Duration, Instant};

/// Explicit target: the projectors classify a line by its target, and
/// `database` makes these lines component `database`.
pub(crate) const LOG_TARGET: &str = "the_small_pos_lib::database_lock";

pub(crate) const SLOW_WAIT_THRESHOLD: Duration = Duration::from_millis(500);
pub(crate) const HELD_LONG_THRESHOLD: Duration = Duration::from_secs(3);
pub(crate) const WATCHDOG_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) const EVENT_WAIT_SLOW: &str = "db_lock_wait_slow";
pub(crate) const EVENT_HELD_LONG: &str = "db_lock_held_long";
pub(crate) const EVENT_RELEASED: &str = "db_lock_released";

/// The event codes a database-lock line may carry, sorted. Equal to
/// `shared/pos/health/__fixtures__/runtime-log-db-lock.json` (tests compare).
pub(crate) const EVENT_CODES: &[&str] = &[EVENT_HELD_LONG, EVENT_RELEASED, EVENT_WAIT_SLOW];

/// A holder that took the lock without a label.
pub(crate) const UNTRACED: &str = "untraced";

/// Every lock-site label, sorted. Equal to the shared fixture (tests compare);
/// a source scan keeps every `lock_traced`/`database_lock::lock` label listed.
pub(crate) const LOCK_LABELS: &[&str] = &[
    "admin_cache_list_paths",
    "checkout_draft_check_admission",
    "checkout_draft_delete",
    "checkout_draft_get",
    "checkout_draft_inspect",
    "checkout_draft_park",
    "checkout_draft_put",
    "checkout_draft_resume_declined",
    "inventory_snapshot_overlays",
    "order_create_with_initial_payment",
    "orders_apply_table_session_snapshot",
    "orders_create",
    "orders_get_table_session_snapshot",
    "parity_queue_process",
    "print_dispatch",
    "repairs_access_reconciliation",
    "repairs_startup_janitor",
    "shift_confirm_legacy_currency",
    "sync_queue_clear",
    "sync_queue_dequeue",
    "sync_queue_enqueue",
    "sync_queue_enqueue_table_batch",
    "sync_queue_items_by_id",
    "sync_queue_length",
    "sync_queue_list_conflicts",
    "sync_queue_list_items",
    "sync_queue_make_due",
    "sync_queue_peek",
    "sync_queue_retry_item",
    "sync_queue_retry_module",
    "sync_queue_status",
    "table_attempt_recovery_status",
    UNTRACED,
    "z_report_generate",
    "z_report_generate_for_date",
    "z_report_readiness",
    "z_report_submit",
];

/// The traced holder of one mutex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Holder {
    /// Distinguishes one acquisition from the next by the same site.
    pub(crate) token: u64,
    pub(crate) label: &'static str,
    pub(crate) acquired_at: Instant,
}

/// Current traced holders, keyed by mutex address. A leaf lock: it is held
/// only for a few vector operations and never while taking another lock.
pub(crate) struct LockTracker {
    holders: Mutex<Vec<(usize, Holder)>>,
    next_token: AtomicU64,
}

impl LockTracker {
    pub(crate) const fn new() -> Self {
        Self {
            holders: Mutex::new(Vec::new()),
            next_token: AtomicU64::new(0),
        }
    }

    fn holders(&self) -> MutexGuard<'_, Vec<(usize, Holder)>> {
        self.holders.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn begin(&self, key: usize, label: &'static str, acquired_at: Instant) -> u64 {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed) + 1;
        let mut holders = self.holders();
        // Only a forgotten guard could leave an entry for a mutex we now own.
        holders.retain(|(held, _)| *held != key);
        holders.push((
            key,
            Holder {
                token,
                label,
                acquired_at,
            },
        ));
        token
    }

    fn end(&self, key: usize, token: u64) {
        self.holders()
            .retain(|(held, holder)| !(*held == key && holder.token == token));
    }

    pub(crate) fn holder(&self, mutex: &Mutex<Connection>) -> Option<Holder> {
        let key = key(mutex);
        self.holders()
            .iter()
            .find(|(held, _)| *held == key)
            .map(|(_, holder)| *holder)
    }
}

static TRACKER: LockTracker = LockTracker::new();

fn key(mutex: &Mutex<Connection>) -> usize {
    std::ptr::from_ref(mutex) as usize
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// A connection guard that records its holder until it is dropped.
pub(crate) struct TracedConnection<'a> {
    guard: MutexGuard<'a, Connection>,
    tracker: &'a LockTracker,
    key: usize,
    token: u64,
}

impl Drop for TracedConnection<'_> {
    fn drop(&mut self) {
        // Runs before the `guard` field unlocks: a holder record never
        // outlives the hold, so a later untraced holder is not misnamed.
        self.tracker.end(self.key, self.token);
    }
}

impl Deref for TracedConnection<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.guard
    }
}

impl DerefMut for TracedConnection<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.guard
    }
}

/// One acquisition that waited longer than the threshold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SlowWait {
    pub(crate) label: &'static str,
    pub(crate) holder_label: &'static str,
    pub(crate) waited: Duration,
}

/// Lock `mutex` for the site `label` (one of [`LOCK_LABELS`]), recording the
/// holder and warning once with `db_lock_wait_slow` when the wait exceeded
/// 500 ms. The result and its poison error behave as `Mutex::lock`'s.
pub(crate) fn lock<'a>(
    mutex: &'a Mutex<Connection>,
    label: &'static str,
) -> LockResult<TracedConnection<'a>> {
    lock_with(mutex, label, &TRACKER, SLOW_WAIT_THRESHOLD, log_slow_wait)
}

pub(crate) fn lock_with<'a>(
    mutex: &'a Mutex<Connection>,
    label: &'static str,
    tracker: &'a LockTracker,
    threshold: Duration,
    on_slow_wait: impl FnOnce(SlowWait),
) -> LockResult<TracedConnection<'a>> {
    let (result, waited, holder) = match mutex.try_lock() {
        Ok(guard) => (Ok(guard), Duration::ZERO, None),
        Err(TryLockError::Poisoned(poisoned)) => (Err(poisoned), Duration::ZERO, None),
        Err(TryLockError::WouldBlock) => {
            // The holder when the wait began; it may hand over before we get it.
            let holder = tracker.holder(mutex);
            let started = Instant::now();
            let result = mutex.lock();
            (result, started.elapsed(), holder)
        }
    };
    if waited > threshold {
        on_slow_wait(SlowWait {
            label,
            holder_label: holder.map_or(UNTRACED, |holder| holder.label),
            waited,
        });
    }
    let key = key(mutex);
    let traced = |guard| TracedConnection {
        guard,
        tracker,
        key,
        token: tracker.begin(key, label, Instant::now()),
    };
    match result {
        Ok(guard) => Ok(traced(guard)),
        Err(poisoned) => Err(PoisonError::new(traced(poisoned.into_inner()))),
    }
}

pub(crate) fn log_slow_wait(wait: SlowWait) {
    tracing::warn!(
        target: LOG_TARGET,
        event_code = EVENT_WAIT_SLOW,
        lock_label = wait.label,
        holder_label = wait.holder_label,
        duration_ms = millis(wait.waited),
        "Database lock wait was slow"
    );
}

impl crate::db::DbState {
    /// `self.conn.lock()` for the site `label`, traced by [`lock`].
    pub(crate) fn lock_traced(&self, label: &'static str) -> LockResult<TracedConnection<'_>> {
        lock(&self.conn, label)
    }
}

/// Run the synchronous body of the Tauri command `label` on Tokio's blocking
/// pool, for a body that may wait for `DbState.conn` or any other blocking
/// lock or I/O.
///
/// Neither synchronous form is safe for such a body. A plain `fn` command runs
/// on the window thread (the 20/10 freeze). A `fn` marked
/// `#[tauri::command(async)]` runs on a Tokio runtime worker (tauri-macros
/// 2.6.3 `body_async` spawns the call on the runtime); a few of those waiting
/// on a long hold park every worker and stall HTTP futures, timers and the
/// other commands. So the command is an `async fn` that re-acquires its
/// managed state inside `work` from an owned `AppHandle`. A panic or a
/// cancellation of the worker becomes the command's error.
pub(crate) async fn run_blocking_command<T, E, F>(label: &'static str, work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => Err(E::from(format!("{label} worker panicked"))),
        Err(_) => Err(E::from(format!("{label} worker was cancelled"))),
    }
}

/// What one watchdog check saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Observation {
    Free,
    /// Held; by the traced holder when there is one.
    Held(Option<Holder>),
}

/// One check of `mutex`: `try_lock` only, released at once, never a wait.
pub(crate) fn observe(mutex: &Mutex<Connection>, tracker: &LockTracker) -> Observation {
    match mutex.try_lock() {
        Ok(guard) => {
            drop(guard);
            Observation::Free
        }
        Err(TryLockError::Poisoned(poisoned)) => {
            drop(poisoned);
            Observation::Free
        }
        Err(TryLockError::WouldBlock) => Observation::Held(tracker.holder(mutex)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WatchdogEvent {
    HeldLong {
        holder_label: &'static str,
        held: Duration,
    },
    Released {
        holder_label: &'static str,
        held: Duration,
    },
}

#[derive(Clone, Copy, Debug)]
struct Episode {
    /// The traced acquisition, or `None` for an untraced holder.
    token: Option<u64>,
    label: &'static str,
    since: Instant,
    reported: bool,
}

/// Episode bookkeeping of the watchdog, free of threads and clocks.
///
/// An episode is one continuous hold: one traced acquisition (exact start),
/// or consecutive checks that found the lock held by untraced code (start =
/// the first such check, so a run of short untraced holds that each check
/// happens to hit can read as one).
#[derive(Debug, Default)]
pub(crate) struct WatchdogEpisode {
    current: Option<Episode>,
}

impl WatchdogEpisode {
    pub(crate) fn observe(
        &mut self,
        observation: Observation,
        now: Instant,
        threshold: Duration,
    ) -> Vec<WatchdogEvent> {
        let mut events = Vec::new();
        let token = match observation {
            Observation::Free => None,
            Observation::Held(holder) => Some(holder.map(|holder| holder.token)),
        };
        if let Some(episode) = self.current {
            if token != Some(episode.token) {
                if episode.reported {
                    events.push(WatchdogEvent::Released {
                        holder_label: episode.label,
                        held: now.saturating_duration_since(episode.since),
                    });
                }
                self.current = None;
            }
        }
        if let Observation::Held(holder) = observation {
            let episode = self.current.get_or_insert(Episode {
                token: holder.map(|holder| holder.token),
                label: holder.map_or(UNTRACED, |holder| holder.label),
                since: holder.map_or(now, |holder| holder.acquired_at.min(now)),
                reported: false,
            });
            let held = now.saturating_duration_since(episode.since);
            if !episode.reported && held > threshold {
                episode.reported = true;
                events.push(WatchdogEvent::HeldLong {
                    holder_label: episode.label,
                    held,
                });
            }
        }
        events
    }
}

pub(crate) fn log_watchdog_event(event: WatchdogEvent) {
    match event {
        WatchdogEvent::HeldLong { holder_label, held } => tracing::warn!(
            target: LOG_TARGET,
            event_code = EVENT_HELD_LONG,
            holder_label,
            duration_ms = millis(held),
            "Database lock held long"
        ),
        WatchdogEvent::Released { holder_label, held } => tracing::warn!(
            target: LOG_TARGET,
            event_code = EVENT_RELEASED,
            holder_label,
            duration_ms = millis(held),
            "Database lock released after a long hold"
        ),
    }
}

/// Start the watchdog of the main connection once per process. It checks
/// every second with `try_lock` and never waits for, or keeps, the lock.
pub(crate) fn start_watchdog(app: tauri::AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("db-lock-watchdog".into())
        .spawn(move || {
            use tauri::Manager;
            let mut episode = WatchdogEpisode::default();
            loop {
                std::thread::sleep(WATCHDOG_INTERVAL);
                let Some(db) = app.try_state::<crate::db::DbState>() else {
                    continue;
                };
                let observation = observe(&db.conn, &TRACKER);
                for event in episode.observe(observation, Instant::now(), HELD_LONG_THRESHOLD) {
                    log_watchdog_event(event);
                }
            }
        });
    if let Err(error) = spawned {
        STARTED.store(false, Ordering::SeqCst);
        tracing::warn!(target: LOG_TARGET, error = %error, "Database lock watchdog did not start");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    fn connection() -> Mutex<Connection> {
        Mutex::new(Connection::open_in_memory().expect("open in-memory connection"))
    }

    /// The body runs on the blocking pool, not the runtime thread that awaits
    /// it; its result is the command's, and a panic becomes the command's error.
    #[tokio::test(flavor = "current_thread")]
    async fn database_lock_blocking_command_runs_off_the_runtime_thread() {
        let runtime_thread = std::thread::current().id();
        let body_thread = run_blocking_command("example_command", || {
            Ok::<_, String>(std::thread::current().id())
        })
        .await
        .unwrap();
        assert_ne!(body_thread, runtime_thread);
        assert_eq!(
            run_blocking_command::<(), String, _>("example_command", || Err("REFUSED".into()))
                .await,
            Err("REFUSED".to_string())
        );
        assert_eq!(
            run_blocking_command::<(), String, _>("example_command", || panic!("example panic"))
                .await,
            Err("example_command worker panicked".to_string())
        );
    }

    #[test]
    fn database_lock_records_the_holder_and_clears_it_on_drop() {
        let tracker = LockTracker::new();
        let mutex = connection();
        let before = Instant::now();
        let mut slow = 0;
        let guard = lock_with(
            &mutex,
            "checkout_draft_put",
            &tracker,
            SLOW_WAIT_THRESHOLD,
            |_| slow += 1,
        )
        .expect("lock");
        let holder = tracker.holder(&mutex).expect("holder recorded");
        assert_eq!(holder.label, "checkout_draft_put");
        assert!(holder.acquired_at >= before && holder.acquired_at <= Instant::now());
        // The guard is the connection.
        assert_eq!(
            guard
                .query_row("SELECT 7", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            7
        );
        drop(guard);
        assert_eq!(tracker.holder(&mutex), None);
        assert_eq!(slow, 0, "an uncontended lock never warns");
        // The next acquisition is a new holder.
        let again = lock_with(
            &mutex,
            "sync_queue_status",
            &tracker,
            SLOW_WAIT_THRESHOLD,
            |_| {},
        )
        .expect("relock");
        let next = tracker.holder(&mutex).expect("second holder");
        assert_eq!(next.label, "sync_queue_status");
        assert_ne!(next.token, holder.token);
        drop(again);
        assert_eq!(tracker.holder(&mutex), None);
    }

    #[test]
    fn database_lock_holders_of_different_connections_are_separate() {
        let tracker = LockTracker::new();
        let (main, worker) = (connection(), connection());
        let main_guard = lock_with(
            &main,
            "checkout_draft_get",
            &tracker,
            SLOW_WAIT_THRESHOLD,
            |_| {},
        )
        .unwrap();
        let worker_guard = lock_with(
            &worker,
            "print_dispatch",
            &tracker,
            SLOW_WAIT_THRESHOLD,
            |_| {},
        )
        .unwrap();
        assert_eq!(tracker.holder(&main).unwrap().label, "checkout_draft_get");
        assert_eq!(tracker.holder(&worker).unwrap().label, "print_dispatch");
        drop(worker_guard);
        assert_eq!(tracker.holder(&main).unwrap().label, "checkout_draft_get");
        assert_eq!(tracker.holder(&worker), None);
        drop(main_guard);
        assert_eq!(tracker.holder(&main), None);
    }

    /// Hold `mutex` traced as `label` on another thread for `hold`, returning
    /// once the hold has begun.
    fn hold_on_thread(
        mutex: Arc<Mutex<Connection>>,
        tracker: Arc<LockTracker>,
        label: Option<&'static str>,
        hold: Duration,
    ) -> std::thread::JoinHandle<()> {
        let (held, wait) = mpsc::channel();
        let handle = std::thread::spawn(move || match label {
            Some(label) => {
                let _guard =
                    lock_with(&mutex, label, &tracker, SLOW_WAIT_THRESHOLD, |_| {}).unwrap();
                held.send(()).unwrap();
                std::thread::sleep(hold);
            }
            None => {
                let _guard = mutex.lock().unwrap();
                held.send(()).unwrap();
                std::thread::sleep(hold);
            }
        });
        wait.recv().expect("holder started");
        handle
    }

    #[test]
    fn database_lock_measures_a_slow_wait_and_names_the_holder_once() {
        let tracker = Arc::new(LockTracker::new());
        let mutex = Arc::new(connection());
        let hold = Duration::from_millis(250);
        let holder = hold_on_thread(
            Arc::clone(&mutex),
            Arc::clone(&tracker),
            Some("parity_queue_process"),
            hold,
        );
        let mut waits = Vec::new();
        let guard = lock_with(
            &mutex,
            "checkout_draft_put",
            &tracker,
            Duration::from_millis(50),
            |wait| waits.push(wait),
        )
        .expect("lock after the holder");
        assert_eq!(waits.len(), 1, "one warning per slow wait");
        assert_eq!(waits[0].label, "checkout_draft_put");
        assert_eq!(waits[0].holder_label, "parity_queue_process");
        // The wait covers most of the hold (the holder started first).
        assert!(
            waits[0].waited >= Duration::from_millis(150),
            "{:?}",
            waits[0]
        );
        assert_eq!(tracker.holder(&mutex).unwrap().label, "checkout_draft_put");
        drop(guard);
        holder.join().unwrap();

        // The next, uncontended acquisition does not warn again.
        let mut more = 0;
        drop(
            lock_with(
                &mutex,
                "checkout_draft_put",
                &tracker,
                Duration::from_millis(50),
                |_| more += 1,
            )
            .unwrap(),
        );
        assert_eq!(more, 0);
    }

    #[test]
    fn database_lock_a_short_wait_does_not_warn_and_an_untraced_holder_is_named_untraced() {
        let tracker = Arc::new(LockTracker::new());
        let mutex = Arc::new(connection());
        let holder = hold_on_thread(
            Arc::clone(&mutex),
            Arc::clone(&tracker),
            None,
            Duration::from_millis(200),
        );
        let mut waits = Vec::new();
        drop(
            lock_with(
                &mutex,
                "sync_queue_status",
                &tracker,
                Duration::from_millis(50),
                |wait| waits.push(wait),
            )
            .unwrap(),
        );
        holder.join().unwrap();
        assert_eq!(waits.len(), 1);
        assert_eq!(waits[0].holder_label, UNTRACED);

        let holder = hold_on_thread(
            Arc::clone(&mutex),
            Arc::clone(&tracker),
            Some("print_dispatch"),
            Duration::from_millis(20),
        );
        let mut short = 0;
        drop(
            lock_with(
                &mutex,
                "sync_queue_status",
                &tracker,
                Duration::from_secs(5),
                |_| short += 1,
            )
            .unwrap(),
        );
        holder.join().unwrap();
        assert_eq!(short, 0, "a wait under the threshold never warns");
    }

    #[test]
    fn database_lock_poison_behaves_as_the_plain_mutex_and_stays_traced() {
        let tracker = LockTracker::new();
        let mutex = connection();
        let plain_message = {
            let poisoned = Arc::new(connection());
            let thread_mutex = Arc::clone(&poisoned);
            let _ = std::thread::spawn(move || {
                let _guard = thread_mutex.lock().unwrap();
                panic!("poison the plain mutex");
            })
            .join();
            let message = poisoned.lock().map(|_| ()).unwrap_err().to_string();
            message
        };
        std::thread::scope(|scope| {
            let _ = scope
                .spawn(|| {
                    let _guard = mutex.lock().unwrap();
                    panic!("poison the traced mutex");
                })
                .join();
        });
        let error = match lock_with(
            &mutex,
            "print_dispatch",
            &tracker,
            SLOW_WAIT_THRESHOLD,
            |_| {},
        ) {
            Ok(_) => panic!("a poisoned mutex reports poison"),
            Err(error) => error,
        };
        assert_eq!(error.to_string(), plain_message);
        let recovered = error.into_inner();
        assert_eq!(tracker.holder(&mutex).unwrap().label, "print_dispatch");
        drop(recovered);
        assert_eq!(tracker.holder(&mutex), None);
        assert_eq!(observe(&mutex, &tracker), Observation::Free);
    }

    #[test]
    fn database_lock_watchdog_check_never_waits_and_names_the_holder() {
        let tracker = LockTracker::new();
        let mutex = connection();
        assert_eq!(observe(&mutex, &tracker), Observation::Free);
        let traced = lock_with(
            &mutex,
            "z_report_generate",
            &tracker,
            SLOW_WAIT_THRESHOLD,
            |_| {},
        )
        .unwrap();
        let started = Instant::now();
        match observe(&mutex, &tracker) {
            Observation::Held(Some(holder)) => assert_eq!(holder.label, "z_report_generate"),
            other => panic!("expected the traced holder, got {other:?}"),
        }
        assert!(started.elapsed() < Duration::from_millis(100));
        drop(traced);
        let untraced = mutex.lock().unwrap();
        assert_eq!(observe(&mutex, &tracker), Observation::Held(None));
        drop(untraced);
        assert_eq!(observe(&mutex, &tracker), Observation::Free);
        // The check itself released the lock.
        assert!(mutex.try_lock().is_ok());
    }

    fn holder(token: u64, label: &'static str, acquired_at: Instant) -> Observation {
        Observation::Held(Some(Holder {
            token,
            label,
            acquired_at,
        }))
    }

    #[test]
    fn database_lock_watchdog_reports_a_long_hold_once_and_its_release() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let threshold = HELD_LONG_THRESHOLD;
        let mut episode = WatchdogEpisode::default();
        assert!(episode
            .observe(Observation::Free, at(0), threshold)
            .is_empty());
        let held = holder(7, "parity_queue_process", at(500));
        for ms in [1_000, 2_000, 3_500] {
            assert!(episode.observe(held, at(ms), threshold).is_empty(), "{ms}");
        }
        assert_eq!(
            episode.observe(held, at(3_600), threshold),
            vec![WatchdogEvent::HeldLong {
                holder_label: "parity_queue_process",
                held: Duration::from_millis(3_100),
            }]
        );
        for ms in [4_600, 60_000, 600_000] {
            assert!(
                episode.observe(held, at(ms), threshold).is_empty(),
                "once per episode ({ms})"
            );
        }
        assert_eq!(
            episode.observe(Observation::Free, at(601_000), threshold),
            vec![WatchdogEvent::Released {
                holder_label: "parity_queue_process",
                held: Duration::from_millis(600_500),
            }]
        );
        assert!(episode
            .observe(Observation::Free, at(602_000), threshold)
            .is_empty());
    }

    #[test]
    fn database_lock_watchdog_a_new_holder_is_a_new_episode() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let threshold = HELD_LONG_THRESHOLD;
        let mut episode = WatchdogEpisode::default();
        // Many short holds the checks happen to hit are not one long hold.
        for (token, ms) in [(1, 0), (2, 1_000), (3, 2_000), (4, 3_000), (5, 4_000)] {
            let observation = holder(token, "sync_queue_status", at(ms));
            assert!(episode
                .observe(observation, at(ms + 10), threshold)
                .is_empty());
        }
        // A reported hold that hands straight over: released, then a new episode.
        let first = holder(10, "z_report_generate", at(5_000));
        assert_eq!(episode.observe(first, at(8_100), threshold).len(), 1);
        let second = holder(11, "checkout_draft_put", at(9_000));
        assert_eq!(
            episode.observe(second, at(9_050), threshold),
            vec![WatchdogEvent::Released {
                holder_label: "z_report_generate",
                held: Duration::from_millis(4_050),
            }]
        );
        assert_eq!(
            episode.observe(second, at(12_001), threshold),
            vec![WatchdogEvent::HeldLong {
                holder_label: "checkout_draft_put",
                held: Duration::from_millis(3_001),
            }]
        );
        // Exactly the threshold is not "more than 3 s".
        let mut exact = WatchdogEpisode::default();
        let held = holder(20, "print_dispatch", at(0));
        assert!(exact.observe(held, at(3_000), threshold).is_empty());
    }

    #[test]
    fn database_lock_watchdog_counts_an_untraced_hold_from_the_first_check() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let threshold = HELD_LONG_THRESHOLD;
        let mut episode = WatchdogEpisode::default();
        for ms in [0, 1_000, 2_000, 3_000] {
            assert!(episode
                .observe(Observation::Held(None), at(ms), threshold)
                .is_empty());
        }
        assert_eq!(
            episode.observe(Observation::Held(None), at(4_000), threshold),
            vec![WatchdogEvent::HeldLong {
                holder_label: UNTRACED,
                held: Duration::from_millis(4_000),
            }]
        );
        // A traced holder after it means the untraced one let go.
        let traced = holder(1, "checkout_draft_get", at(4_500));
        assert_eq!(
            episode.observe(traced, at(4_600), threshold),
            vec![WatchdogEvent::Released {
                holder_label: UNTRACED,
                held: Duration::from_millis(4_600),
            }]
        );
        assert!(episode
            .observe(Observation::Free, at(5_000), threshold)
            .is_empty());
    }

    #[test]
    fn database_lock_labels_and_codes_are_the_shared_lists() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/pos/health/__fixtures__/runtime-log-db-lock.json"
        ))
        .unwrap();
        let list = |key: &str| -> Vec<String> {
            fixture[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(EVENT_CODES, list("eventCodes").as_slice());
        assert_eq!(LOCK_LABELS, list("labels").as_slice());
        for list in [EVENT_CODES, LOCK_LABELS] {
            assert!(
                list.windows(2).all(|pair| pair[0] < pair[1]),
                "sorted, unique"
            );
            for value in list {
                assert!(
                    !value.is_empty()
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte == b'_'),
                    "{value}"
                );
            }
        }
    }

    /// Every traced lock site names a listed label as a string literal, so a
    /// label can never carry data and the projectors keep it.
    #[test]
    fn database_lock_every_site_uses_a_listed_literal_label() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut pending = vec![root];
        let mut sites = 0;
        let this_file = std::path::Path::new(file!())
            .file_name()
            .unwrap()
            .to_owned();
        while let Some(path) = pending.pop() {
            for entry in std::fs::read_dir(&path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if path.extension().is_none_or(|extension| extension != "rs")
                    || path.file_name() == Some(this_file.as_os_str())
                {
                    continue;
                }
                let source = std::fs::read_to_string(&path).unwrap();
                for call in ["lock_traced(", "database_lock::lock("] {
                    for (index, _) in source.match_indices(call) {
                        if source[..index].ends_with("fn ") {
                            continue;
                        }
                        let rest = &source[index + call.len()..];
                        // `database_lock::lock(mutex, "label")` or `lock_traced("label")`.
                        let rest = if call == "database_lock::lock(" {
                            rest.split_once(',').map(|(_, label)| label).unwrap_or("")
                        } else {
                            rest
                        };
                        let label = rest
                            .trim_start()
                            .strip_prefix('"')
                            .and_then(|rest| rest.split_once('"'))
                            .map(|(label, _)| label);
                        let line = source[..index].lines().count();
                        match label {
                            Some(label) if LOCK_LABELS.contains(&label) && label != UNTRACED => {
                                sites += 1
                            }
                            _ => panic!(
                                "{}:{line}: a traced lock site needs a listed literal label",
                                path.display()
                            ),
                        }
                    }
                }
            }
        }
        assert!(sites >= 30, "the traced sites were found ({sites})");
    }
}
