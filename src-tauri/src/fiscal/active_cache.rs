//! Local cache of the "is fiscalization active for this branch?" state.
//!
//! Implements Task 21a of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Req 4.10, Req 4.11.
//!
//! Fed by [`super::status`] from `GET /api/pos/fiscal/status`. A FRESH
//! "Inactive" answer (the server told us no fiscal plugin is active for this
//! branch) is used for exactly one thing: queued fiscal rows of that branch
//! do not hold the Z — neither the close-day guard
//! ([`super::close_day_guard`]) nor the closeout drain's failure accounting
//! (`sync_queue::fiscal_row_is_closeout_exempt`).
//!
//! It is NOT used to skip queuing a receipt (review of the 29/09/2026 fixes,
//! decided for both POS apps): a store with a fiscal plugin lost every receipt
//! after one `active:false` answer while the dispatcher skipped the enqueue on
//! it. Receipts are always queued; the server answers `skipped` for a branch
//! without a plugin and the row drains.
//!
//! "Unknown" (no recent successful poll, or TTL expired) keeps every queued
//! row fail-closed for the Z.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long a successful health-poll result is considered fresh.
pub const FRESHNESS_TTL: Duration = Duration::from_secs(5 * 60);

/// Whether this branch's queued fiscal rows hold the Z.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheVerdict {
    /// Last poll confirmed at least one plugin is active for this branch.
    /// Queued rows hold the Z until the server accepts them.
    Active,
    /// Last poll (still fresh) confirmed NO plugin is active for this branch.
    /// Queued rows stay queued (they drain as `skipped`) but do not hold the Z.
    Inactive,
    /// No recent poll, or last poll TTL expired: fail closed, queued rows
    /// hold the Z.
    Unknown,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    active: bool,
    /// The plugin the server named with the answer (`fiscalization_gr`, ...),
    /// when it named one.
    plugin_id: Option<String>,
    /// The answer's `reason` (`active`, `adapter_not_registered`, ...), when
    /// the server gave one.
    reason: Option<String>,
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

/// Record the result of a successful `GET /api/pos/fiscal/status` answer
/// (fed by [`super::status`]).
///
/// `active=true` means a submission from this branch is dispatched (or fails
/// loudly because two plugins are active); `active=false` means the server
/// would skip it (no active plugin, missing branch config, ...).
pub fn update(branch_id: impl Into<String>, active: bool) {
    update_with_plugin(branch_id, active, None);
}

/// [`update`], keeping the plugin the server named with the answer (the
/// fiscal currency check reads it).
pub fn update_with_plugin(branch_id: impl Into<String>, active: bool, plugin_id: Option<String>) {
    update_with_status(branch_id, active, plugin_id, None);
}

/// [`update_with_plugin`], keeping the answer's `reason` too (the printed-VAT
/// rule counts only a plugin whose reason is `active`).
pub fn update_with_status(
    branch_id: impl Into<String>,
    active: bool,
    plugin_id: Option<String>,
    reason: Option<String>,
) {
    let trimmed = |value: Option<String>| {
        value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let mut s = state();
    s.by_branch.insert(
        branch_id.into(),
        CacheEntry {
            active,
            plugin_id: trimmed(plugin_id),
            reason: trimmed(reason),
            fetched_at: Instant::now(),
        },
    );
}

/// The plugin of a branch whose FRESH verdict is active, when the server
/// named one (two active plugins answer without one).
pub fn fresh_active_plugin_id(branch_id: &str) -> Option<String> {
    let s = state();
    s.by_branch
        .get(branch_id)
        .filter(|entry| entry.is_fresh() && entry.active)
        .and_then(|entry| entry.plugin_id.clone())
}

/// The plugin of a branch whose FRESH answer says a fiscal plugin is
/// connected and dispatching: `active` true, a named plugin and the reason
/// `active`. An active answer for another reason (`adapter_not_registered`,
/// `certification_missing`, ...), a stale or unknown verdict give `None`.
pub fn fresh_connected_plugin(branch_id: &str) -> Option<String> {
    let s = state();
    s.by_branch
        .get(branch_id)
        .filter(|entry| {
            entry.is_fresh()
                && entry.active
                && entry.reason.as_deref()
                    == Some(crate::fiscal::receipt_vat::FISCAL_STATUS_ACTIVE_REASON)
        })
        .and_then(|entry| entry.plugin_id.clone())
}

/// Branches whose fresh verdict is `Inactive`, for the SQL predicates that
/// exempt their fiscal rows from the Z closeout drain. Only ids made of
/// `[A-Za-z0-9_-]` (UUIDs, test ids) are returned, so a caller may embed them
/// as SQL string literals.
pub fn inactive_branch_ids() -> Vec<String> {
    let s = state();
    let mut ids: Vec<String> = s
        .by_branch
        .iter()
        .filter(|(branch_id, entry)| {
            entry.is_fresh()
                && !entry.active
                && !branch_id.is_empty()
                && branch_id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        })
        .map(|(branch_id, _)| branch_id.clone())
        .collect();
    ids.sort();
    ids
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
    #[serial_test::serial]
    fn unknown_when_not_recorded() {
        reset_for_tests();
        assert_eq!(verdict("branch-x"), CacheVerdict::Unknown);
    }

    #[test]
    #[serial_test::serial]
    fn active_after_update_true() {
        reset_for_tests();
        update("branch-a", true);
        assert_eq!(verdict("branch-a"), CacheVerdict::Active);
    }

    #[test]
    #[serial_test::serial]
    fn inactive_after_update_false() {
        reset_for_tests();
        update("branch-b", false);
        assert_eq!(verdict("branch-b"), CacheVerdict::Inactive);
    }

    #[test]
    #[serial_test::serial]
    fn inactive_branch_ids_lists_only_fresh_inactive_sql_safe_ids() {
        reset_for_tests();
        update("d28cef2e-bbf2-496a-b922-45b497525715", false);
        update("branch_active", true);
        update("x'); DROP TABLE orders; --", false);
        assert_eq!(
            inactive_branch_ids(),
            vec!["d28cef2e-bbf2-496a-b922-45b497525715".to_string()]
        );
    }

    #[test]
    #[serial_test::serial]
    fn isolated_per_branch() {
        reset_for_tests();
        update("branch-a", true);
        update("branch-b", false);
        assert_eq!(verdict("branch-a"), CacheVerdict::Active);
        assert_eq!(verdict("branch-b"), CacheVerdict::Inactive);
        assert_eq!(verdict("branch-c"), CacheVerdict::Unknown);
    }
}
