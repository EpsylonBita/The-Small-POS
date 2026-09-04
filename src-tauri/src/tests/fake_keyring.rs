//! In-memory keyring for hermetic tests.
//!
//! # Why this exists
//!
//! `storage.rs` today talks directly to the OS keyring (DPAPI on Windows,
//! Keychain on macOS, Secret Service on Linux). Tests that touch
//! credentials have to use `#[serial_test::serial]` to avoid racing on
//! the global keyring, and even then they leave residue in the OS
//! keyring that can bleed into subsequent test runs.
//!
//! `fake_keyring` is a per-thread in-memory override: tests install it,
//! `storage::get_credential` and the checked credential owner paths
//! observe the fake instead of the OS keyring, and on scope exit
//! everything is discarded.
//!
//! # Per-thread, not per-process
//!
//! The fake state lives in a `thread_local!`. Tests running in parallel
//! on different threads each have their own isolated fake keyring, so
//! we do NOT need `serial_test::serial` on tests that use this harness.
//!
//! Caveat: if a test spawns its own worker threads (e.g. through
//! `tokio::spawn`), those threads start with no fake installed and will
//! see the real OS keyring. Install explicitly on each worker thread if
//! you need one, or reshape the test to stay on the current thread.
//!
//! # Wave 0 status
//!
//! Wave 0 introduces:
//! - This module
//! - A `#[cfg(test)]`-only hook in `storage.rs::get_credential` /
//!   `set_credential` / `delete_credential` that delegates when a fake
//!   is installed on the current thread.
//!
//! No production code path is altered. No test consumes the fake yet —
//! Wave 7 will.

use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static STATE: RefCell<Option<HashMap<String, String>>> = const { RefCell::new(None) };
    static READ_FAILURES: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    static DEFERRED_READ_FAILURES: RefCell<HashMap<String, (usize, String)>> = RefCell::new(HashMap::new());
    static WRITE_FAILURES: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    static NEXT_WRITE_VALUES: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    static WRITE_HOOKS: RefCell<HashMap<String, Box<dyn FnMut()>>> = RefCell::new(HashMap::new());
    static DELETE_FAILURES: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// RAII guard that uninstalls the fake on drop.
///
/// ```ignore
/// let _guard = fake_keyring::install_empty();
/// storage::seed_terminal_credential_for_test("terminal_id", "uuid-here").unwrap();
/// // Fake is active until `_guard` drops at end of scope.
/// ```
#[must_use = "drop this guard to uninstall the fake keyring"]
pub struct Guard {
    _private: (),
}

impl Drop for Guard {
    fn drop(&mut self) {
        STATE.with(|slot| *slot.borrow_mut() = None);
        READ_FAILURES.with(|slot| slot.borrow_mut().clear());
        DEFERRED_READ_FAILURES.with(|slot| slot.borrow_mut().clear());
        WRITE_FAILURES.with(|slot| slot.borrow_mut().clear());
        NEXT_WRITE_VALUES.with(|slot| slot.borrow_mut().clear());
        WRITE_HOOKS.with(|slot| slot.borrow_mut().clear());
        DELETE_FAILURES.with(|slot| slot.borrow_mut().clear());
    }
}

/// Install an empty fake keyring on the current thread. Any existing
/// fake is replaced.
pub fn install_empty() -> Guard {
    STATE.with(|slot| *slot.borrow_mut() = Some(HashMap::new()));
    READ_FAILURES.with(|slot| slot.borrow_mut().clear());
    DEFERRED_READ_FAILURES.with(|slot| slot.borrow_mut().clear());
    WRITE_FAILURES.with(|slot| slot.borrow_mut().clear());
    NEXT_WRITE_VALUES.with(|slot| slot.borrow_mut().clear());
    WRITE_HOOKS.with(|slot| slot.borrow_mut().clear());
    DELETE_FAILURES.with(|slot| slot.borrow_mut().clear());
    Guard { _private: () }
}

/// Install a fake keyring pre-populated with `(key, value)` pairs.
pub fn install_seeded<I, K, V>(entries: I) -> Guard
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    let map: HashMap<String, String> = entries
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    STATE.with(|slot| *slot.borrow_mut() = Some(map));
    READ_FAILURES.with(|slot| slot.borrow_mut().clear());
    DEFERRED_READ_FAILURES.with(|slot| slot.borrow_mut().clear());
    WRITE_FAILURES.with(|slot| slot.borrow_mut().clear());
    NEXT_WRITE_VALUES.with(|slot| slot.borrow_mut().clear());
    WRITE_HOOKS.with(|slot| slot.borrow_mut().clear());
    DELETE_FAILURES.with(|slot| slot.borrow_mut().clear());
    Guard { _private: () }
}

/// Is a fake installed on the current thread?
///
/// `storage.rs` uses this to decide whether to delegate; production
/// callers should never need to check this directly.
pub(crate) fn is_installed() -> bool {
    STATE.with(|slot| slot.borrow().is_some())
}

/// Fetch a value from the fake keyring. Returns `None` if no fake is
/// installed OR the key is absent.
pub(crate) fn get(key: &str) -> Option<String> {
    STATE.with(|slot| slot.borrow().as_ref()?.get(key).cloned())
}

/// Inject a backend-style read failure for one credential. This is deliberately
/// test-only so security-sensitive callers can prove that `NoEntry` and an
/// unavailable OS credential backend are not collapsed into the same result.
pub(crate) fn fail_reads_for(key: &str, code: &str) {
    READ_FAILURES.with(|slot| {
        slot.borrow_mut().insert(key.to_string(), code.to_string());
    });
}

/// Fail one strict read after `successful_reads` successful reads of `key`.
/// This models a backend that accepts a write and then becomes unavailable
/// during durability readback without changing production storage behavior.
pub(crate) fn fail_read_after(key: &str, successful_reads: usize, code: &str) {
    DEFERRED_READ_FAILURES.with(|slot| {
        slot.borrow_mut()
            .insert(key.to_string(), (successful_reads, code.to_string()));
    });
}

/// Replace the value of the next successful fake write. Used to model a
/// backend readback mismatch after reporting write success.
pub(crate) fn replace_next_write_with(key: &str, value: &str) {
    NEXT_WRITE_VALUES.with(|slot| {
        slot.borrow_mut().insert(key.to_string(), value.to_string());
    });
}

pub(crate) fn after_next_write<F>(key: &str, hook: F)
where
    F: FnMut() + 'static,
{
    WRITE_HOOKS.with(|slot| {
        slot.borrow_mut().insert(key.to_string(), Box::new(hook));
    });
}

pub(crate) fn fail_writes_for(key: &str, code: &str) {
    WRITE_FAILURES.with(|slot| {
        slot.borrow_mut().insert(key.to_string(), code.to_string());
    });
}

pub(crate) fn fail_deletes_for(key: &str, code: &str) {
    DELETE_FAILURES.with(|slot| {
        slot.borrow_mut().insert(key.to_string(), code.to_string());
    });
}

pub(crate) fn clear_failures_for(key: &str) {
    READ_FAILURES.with(|slot| {
        slot.borrow_mut().remove(key);
    });
    DEFERRED_READ_FAILURES.with(|slot| {
        slot.borrow_mut().remove(key);
    });
    WRITE_FAILURES.with(|slot| {
        slot.borrow_mut().remove(key);
    });
    NEXT_WRITE_VALUES.with(|slot| {
        slot.borrow_mut().remove(key);
    });
    WRITE_HOOKS.with(|slot| {
        slot.borrow_mut().remove(key);
    });
    DELETE_FAILURES.with(|slot| {
        slot.borrow_mut().remove(key);
    });
}

pub(crate) fn get_strict(key: &str) -> Result<Option<String>, String> {
    if let Some(code) = READ_FAILURES.with(|slot| slot.borrow().get(key).cloned()) {
        return Err(code);
    }
    if let Some(code) = DEFERRED_READ_FAILURES.with(|slot| {
        let mut failures = slot.borrow_mut();
        let Some((remaining, code)) = failures.get_mut(key) else {
            return None;
        };
        if *remaining == 0 {
            let code = code.clone();
            failures.remove(key);
            Some(code)
        } else {
            *remaining -= 1;
            None
        }
    }) {
        return Err(code);
    }
    Ok(get(key))
}

/// Write a value into the fake keyring. Returns `true` if a fake is
/// installed (i.e. the write landed); `false` otherwise.
pub(crate) fn set(key: &str, value: &str) -> bool {
    set_checked(key, value).unwrap_or(false)
}

pub(crate) fn set_checked(key: &str, value: &str) -> Result<bool, String> {
    if let Some(code) = WRITE_FAILURES.with(|slot| slot.borrow().get(key).cloned()) {
        return Err(code);
    }
    let result = STATE.with(|slot| {
        if let Some(map) = slot.borrow_mut().as_mut() {
            let stored = NEXT_WRITE_VALUES
                .with(|values| values.borrow_mut().remove(key))
                .unwrap_or_else(|| value.to_string());
            map.insert(key.to_string(), stored);
            Ok(true)
        } else {
            Ok(false)
        }
    });
    if matches!(result, Ok(true)) {
        if let Some(mut hook) = WRITE_HOOKS.with(|hooks| hooks.borrow_mut().remove(key)) {
            hook();
        }
    }
    result
}

/// Remove a key from the fake keyring. Returns `true` iff a fake is
/// installed (matches the production `delete_credential` no-op-on-missing
/// contract). The return value does NOT signal whether the key existed.
pub(crate) fn delete(key: &str) -> bool {
    delete_checked(key).unwrap_or(false)
}

pub(crate) fn delete_checked(key: &str) -> Result<bool, String> {
    if let Some(code) = DELETE_FAILURES.with(|slot| slot.borrow().get(key).cloned()) {
        return Err(code);
    }
    STATE.with(|slot| {
        if let Some(map) = slot.borrow_mut().as_mut() {
            map.remove(key);
            Ok(true)
        } else {
            Ok(false)
        }
    })
}

// --- Inspection helpers for test assertions ---

/// List every key currently stored. Returns empty when no fake is
/// installed. Useful for G7 factory-reset assertions.
pub fn all_keys() -> Vec<String> {
    STATE.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    })
}

/// Count of keys stored. Zero if no fake is installed.
pub fn len() -> usize {
    STATE.with(|slot| slot.borrow().as_ref().map(|m| m.len()).unwrap_or(0))
}

/// `true` if no fake is installed OR it has zero entries.
pub fn is_empty() -> bool {
    len() == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_empty_starts_empty() {
        let _g = install_empty();
        assert!(is_installed());
        assert!(is_empty());
    }

    #[test]
    fn seeded_install_has_prefilled_entries() {
        let _g = install_seeded([
            ("terminal_id", "550e8400-e29b-41d4-a716-446655440000"),
            ("branch_id", "branch-1"),
        ]);
        assert_eq!(len(), 2);
        assert_eq!(
            get("terminal_id").as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
        assert_eq!(get("branch_id").as_deref(), Some("branch-1"));
    }

    #[test]
    fn get_returns_none_when_no_fake_installed() {
        // No guard in this test.
        assert!(!is_installed());
        assert_eq!(get("terminal_id"), None);
    }

    #[test]
    fn set_and_delete_round_trip() {
        let _g = install_empty();
        assert!(set("k", "v"));
        assert_eq!(get("k").as_deref(), Some("v"));
        assert!(delete("k"));
        assert_eq!(get("k"), None);
    }

    #[test]
    fn set_returns_false_when_no_fake_installed() {
        assert!(!set("k", "v"));
    }

    #[test]
    fn guard_uninstalls_on_drop() {
        {
            let _g = install_empty();
            assert!(is_installed());
        }
        assert!(!is_installed());
    }

    #[test]
    fn install_replaces_previous_fake_on_same_thread() {
        let _g1 = install_seeded([("a", "1")]);
        assert_eq!(get("a").as_deref(), Some("1"));

        let _g2 = install_seeded([("b", "2")]);
        assert_eq!(get("a"), None, "previous install should have been replaced");
        assert_eq!(get("b").as_deref(), Some("2"));
    }

    #[test]
    fn all_keys_lists_current_keys() {
        let _g = install_seeded([("one", "1"), ("two", "2"), ("three", "3")]);
        let mut keys = all_keys();
        keys.sort();
        assert_eq!(keys, vec!["one", "three", "two"]);
    }
}
