//! Process-only evidence: a gate refusal must survive missing notice tables.
//! Slots are claimed atomically; no database or blocking mutex is used here.
use serde_json::{json, Value};
use std::hash::{Hash, Hasher};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

struct Observation {
    key: AtomicU64,
    refusals: AtomicU64,
    resolved_through: AtomicU64,
    checked: AtomicBool,
    reported: AtomicBool,
    code: Mutex<String>,
    code_unknown: AtomicBool,
}
impl Observation {
    const fn new() -> Self {
        Self {
            key: AtomicU64::new(0),
            refusals: AtomicU64::new(0),
            resolved_through: AtomicU64::new(0),
            checked: AtomicBool::new(false),
            reported: AtomicBool::new(false),
            code: Mutex::new(String::new()),
            code_unknown: AtomicBool::new(false),
        }
    }
    fn record(&self, error: Option<&str>) {
        if let Some(error) = error {
            // Even contention on the optional reason cannot lose a refusal.
            if let Ok(mut code) = self.code.try_lock() {
                *code = crate::order_notice_recovery::notice_failure_code(error);
                self.code_unknown.store(false, Ordering::SeqCst);
            } else {
                self.code_unknown.store(true, Ordering::SeqCst);
            }
            // A refusal after a successful read starts a new episode, and
            // every episode reaches us, however quickly a retry got through.
            if self.refusals.load(Ordering::SeqCst) == self.resolved_through.load(Ordering::SeqCst)
            {
                self.reported.store(false, Ordering::SeqCst);
            }
            self.refusals.fetch_add(1, Ordering::SeqCst);
        } else {
            self.resolved_through
                .store(self.refusals.load(Ordering::SeqCst), Ordering::SeqCst);
            self.checked.store(true, Ordering::SeqCst);
        }
    }
    fn snapshot(&self) -> Value {
        let refusals = self.refusals.load(Ordering::SeqCst);
        let unavailable = refusals > self.resolved_through.load(Ordering::SeqCst);
        let pending_report = refusals > 0 && !self.reported.load(Ordering::SeqCst);
        if unavailable || pending_report {
            let Ok(code) = self.code.try_lock() else {
                return json!({"status":"unknown"});
            };
            let code = if self.code_unknown.load(Ordering::SeqCst) || code.is_empty() {
                "ORDER_NOTICE_OBSERVATION_FAILED"
            } else {
                code.as_str()
            };
            json!({"status":if unavailable {"unavailable"}else{"clear"},"code":code,
                "refusal_count":refusals,"pending_report":pending_report})
        } else if self.checked.load(Ordering::SeqCst) {
            json!({"status":"clear"})
        } else {
            json!({"status":"unknown"})
        }
    }
}

// A desktop process has one store database. Separate slots also isolate test
// databases. Keys are local path hashes and never enter Health or reports.
static OBSERVATIONS: [Observation; 4096] = [const { Observation::new() }; 4096];
fn observation(path: &std::path::Path) -> Option<&'static Observation> {
    if path.as_os_str().is_empty() {
        return None;
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    let key = hasher.finish().max(1);
    for offset in 0..OBSERVATIONS.len() {
        let slot = &OBSERVATIONS[(key as usize).wrapping_add(offset) % OBSERVATIONS.len()];
        let present = slot.key.load(Ordering::SeqCst);
        if present == key
            || (present == 0
                && match slot
                    .key
                    .compare_exchange(0, key, Ordering::SeqCst, Ordering::SeqCst)
                {
                    Ok(_) => true,
                    Err(actual) => actual == key,
                })
        {
            return Some(slot);
        }
    }
    tracing::warn!("Order notice gate observation capacity exhausted");
    None
}
pub(crate) fn record(conn: &rusqlite::Connection, error: Option<&str>) {
    if let Some(slot) = conn
        .path()
        .and_then(|path| observation(std::path::Path::new(path)))
    {
        slot.record(error);
    }
}
pub(crate) fn health(path: &std::path::Path) -> Value {
    observation(path)
        .map(Observation::snapshot)
        .unwrap_or_else(|| json!({"status":"unknown"}))
}
pub(crate) fn reported(path: &std::path::Path) {
    if let Some(slot) = observation(path) {
        slot.reported.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn order_notice_gate_records_without_waiting_and_needs_a_successful_read_to_clear() {
        let state = Observation::new();
        let lock = state.code.lock().unwrap();
        state.record(Some("no such table: recovery_action_log"));
        assert_eq!(state.refusals.load(Ordering::SeqCst), 1);
        assert_eq!(state.snapshot()["status"], "unknown");
        drop(lock);
        // The reason was contended away, the refusal was not.
        assert_eq!(
            state.snapshot(),
            json!({"status":"unavailable","code":"ORDER_NOTICE_OBSERVATION_FAILED","refusal_count":1,"pending_report":true})
        );
        state.record(Some("no such table: recovery_action_log"));
        assert_eq!(
            state.snapshot()["code"],
            "NOTICE_TABLE_MISSING_RECOVERY_ACTION_LOG"
        );
        assert_eq!(state.snapshot()["refusal_count"], 2);
        state.record(None);
        assert_eq!(state.snapshot()["status"], "clear");
        assert_eq!(state.snapshot()["pending_report"], true);
        state.reported.store(true, Ordering::SeqCst);
        assert_eq!(state.snapshot(), json!({"status":"clear"}));
        state.record(Some("ORDER_NOTICE_READ_FAILED: private data"));
        assert_eq!(state.snapshot()["code"], "ORDER_NOTICE_READ_FAILED");
        assert_eq!(state.snapshot()["refusal_count"], 3);
        // That refusal came after a successful read: a new episode, which is
        // reported again even if the very next read succeeds.
        state.record(None);
        assert_eq!(state.snapshot()["status"], "clear");
        assert_eq!(state.snapshot()["pending_report"], true);
    }
}
