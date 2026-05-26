//! Local cache of the "is fiscalization active for this branch?" state.
//!
//! Implements Task 21a of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Req 4.10, Req 4.11.
//!
//! The fiscal dispatcher consults this cache BEFORE enqueueing to the
//! offline `parity_sync_queue`. When the cache says "Inactive" (the last
//! successful `/api/plugins/fiscal/health` poll told us no fiscal plugin
//! is configured for this branch), the dispatcher skips the enqueue
//! entirely — otherwise the local outbox would fill with payloads that
//! will only ever resolve to `status='skipped'` once replayed.
//!
//! When the cache says "Unknown" (no recent successful poll, or TTL
//! expired), the dispatcher falls back to the normal online/offline path
//! — never enqueue speculatively on unknown, so genuine network outages
//! don't accidentally lose receipts while the cache is stale.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long a successful health-poll result is considered fresh.
pub const FRESHNESS_TTL: Duration = Duration::from_secs(5 * 60);

/// What the local dispatcher should do with this branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheVerdict {
    /// Last poll confirmed at least one plugin is active for this branch.
    /// Dispatcher proceeds with normal online / offline-enqueue path.
    Active,
    /// Last poll confirmed NO plugin is active for this branch.
    /// Dispatcher SHALL NOT enqueue — skip silently.
    Inactive,
    /// No recent poll, or last poll TTL expired. Fall back to online
    /// attempt; on failure, enqueue (don't drop the receipt on unknown).
    Unknown,
}

#[derive(Debug, Clone, Copy)]
struct CacheEntry {
    active: bool,
    fetched_at: Instant,
}

impl CacheEntry {
    fn is_fresh(&self) -> bool {
        self.fetched_at.elapsed() < FRESHNESS_TTL
    }
}

#[derive(Default)]
struct CacheState {
    by_branch: HashMap<String, CacheEntry>,
}

fn state() -> MutexGuard<'static, CacheState> {
    static CACHE: OnceLock<Mutex<CacheState>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(CacheState::default()))
        .lock()
        .expect("FiscalActiveCache mutex poisoned")
}

/// Look up the current verdict for a branch.
///
/// Returns `Unknown` if there is no cached value, OR the cached value
/// has aged past [`FRESHNESS_TTL`]. Stale entries are NOT evicted on read
/// — they may still be observed by tests; eviction happens lazily on the
/// next [`update`] for the same branch.
pub fn verdict(branch_id: &str) -> CacheVerdict {
    let s = state();
    match s.by_branch.get(branch_id) {
        Some(entry) if entry.is_fresh() => {
            if entry.active {
                CacheVerdict::Active
            } else {
                CacheVerdict::Inactive
            }
        }
        _ => CacheVerdict::Unknown,
    }
}

/// Record the result of a successful `/api/plugins/fiscal/health` poll.
///
/// `active=true` means at least one plugin returned a record with no
/// `activeReason` (i.e. it is configured AND fully active per Req 2.4).
/// `active=false` means every record either had a reason or there were
/// no records at all.
pub fn update(branch_id: impl Into<String>, active: bool) {
    let mut s = state();
    s.by_branch.insert(
        branch_id.into(),
        CacheEntry {
            active,
            fetched_at: Instant::now(),
        },
    );
}

/// Test-only: clear all cached entries between tests. NEVER call in production.
#[cfg(test)]
pub fn reset_for_tests() {
    state().by_branch.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_when_not_recorded() {
        reset_for_tests();
        assert_eq!(verdict("branch-x"), CacheVerdict::Unknown);
    }

    #[test]
    fn active_after_update_true() {
        reset_for_tests();
        update("branch-a", true);
        assert_eq!(verdict("branch-a"), CacheVerdict::Active);
    }

    #[test]
    fn inactive_after_update_false() {
        reset_for_tests();
        update("branch-b", false);
        assert_eq!(verdict("branch-b"), CacheVerdict::Inactive);
    }

    #[test]
    fn isolated_per_branch() {
        reset_for_tests();
        update("branch-a", true);
        update("branch-b", false);
        assert_eq!(verdict("branch-a"), CacheVerdict::Active);
        assert_eq!(verdict("branch-b"), CacheVerdict::Inactive);
        assert_eq!(verdict("branch-c"), CacheVerdict::Unknown);
    }
}
