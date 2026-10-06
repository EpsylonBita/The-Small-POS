//! Is fiscalization active for this terminal's branch?
//!
//! Feeds [`super::active_cache`] from `GET /api/pos/fiscal/status`.
//!
//! Field incident 29/09/2026 (Le Petit Paris, Android POS 1.0.12): a store
//! without a fiscal plugin had its Z-report blocked by two fiscal queue rows.
//! The close-day guard's "plugin inactive → do not block" bypass and the
//! dispatcher's "inactive → do not enqueue" short-circuit both read the active
//! cache, and nothing ever wrote to it — on either app: `active_cache::update`
//! had no production caller here either, so the verdict was always "unknown".
//!
//! Contract (terminal auth, organization and branch from the terminal):
//! `200 { active: boolean, pluginId: string | null, reason: string,
//! checkedAt: string }`. Only a well-formed answer updates the cache. An
//! unreachable server, an older server without the route (404), a `503
//! fiscal_status_unavailable` or a malformed body leave the verdict to expire
//! to "unknown" — the fail-closed behaviour: the Z guard still blocks.
//! Receipts are queued whatever the verdict (review of the 29/09/2026 fixes);
//! a fresh inactive verdict only keeps them from holding the Z.
//!
//! Refreshed by the background sync pass (at most every four minutes, inside
//! the cache's five-minute TTL; a minute after a failure), right after a
//! terminal settings sync and a staff login (both mark it due), and right
//! before a Z-report submission. POS parity: Android's `fiscalActiveStatus.ts`.

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tracing::{debug, info, warn};

use super::active_cache::{self, CacheVerdict};
use crate::api::{self, AdminFetchError};

/// The POS fiscal status route (admin-dashboard `api/pos/fiscal/status`).
pub const STATUS_PATH: &str = "/api/pos/fiscal/status";

/// Background refresh period, inside [`active_cache::FRESHNESS_TTL`].
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(4 * 60);

/// Retry sooner after a failed refresh, still inside the TTL.
pub const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60);

/// A status check never holds a sync pass or a Z-report for long.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Unix milliseconds before which the background pass skips the refresh.
static NEXT_REFRESH_DUE_MS: AtomicI64 = AtomicI64::new(0);

/// Set by [`mark_due`] and consumed by the throttled refresh that serves it.
/// Separate from the schedule: a refresh already in flight when a settings
/// sync or a staff login asked for a new answer writes the next schedule
/// when it finishes, which used to overwrite the request and delay it by the
/// whole four-minute interval.
static REFRESH_FORCED: AtomicBool = AtomicBool::new(false);

/// The server's answer, as the contract names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiscalStatus {
    pub active: bool,
    pub plugin_id: Option<String>,
    pub reason: String,
    pub checked_at: String,
}

/// Why a refresh could not produce a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnknownReason {
    /// The terminal has no branch (or no admin credentials) yet.
    NotConfigured,
    /// An older server without the route (404).
    EndpointUnavailable,
    /// Network failure, timeout, 5xx (incl. `503 fiscal_status_unavailable`)
    /// or an authentication refusal.
    FetchFailed,
    /// A 2xx body that does not carry a boolean `active`.
    MalformedResponse,
}

impl UnknownReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::EndpointUnavailable => "endpoint_unavailable",
            Self::FetchFailed => "fetch_failed",
            Self::MalformedResponse => "malformed_response",
        }
    }
}

/// Outcome of one refresh. `Active`/`Inactive` have updated the cache;
/// `Unknown` left it alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FiscalStatusRefresh {
    Active(FiscalStatus),
    Inactive(FiscalStatus),
    Unknown(UnknownReason),
}

/// The verdict the dispatcher and the close-day guard use right now, as the
/// stable label diagnostics and the Z-report carry.
pub fn verdict_label(branch_id: &str) -> &'static str {
    if branch_id.trim().is_empty() {
        return "unknown";
    }
    match active_cache::verdict(branch_id.trim()) {
        CacheVerdict::Active => "active",
        CacheVerdict::Inactive => "inactive",
        CacheVerdict::Unknown => "unknown",
    }
}

/// Accepts the contract body, also when wrapped as `{ success, data }`.
pub fn parse_fiscal_status_response(body: &Value) -> Option<FiscalStatus> {
    let candidate = if body.get("active").is_some() {
        body
    } else {
        body.get("data").filter(|data| data.is_object())?
    };
    let active = candidate.get("active")?.as_bool()?;
    let text = |key: &str| {
        candidate
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    };
    let reason = text("reason").unwrap_or_default();
    // Older servers counted purchased but pending/error branch configurations
    // as active. An explicitly disconnected branch has no active fiscal plugin.
    let active = active && reason != "branch_config_not_connected";
    Some(FiscalStatus {
        active,
        plugin_id: if active { text("pluginId") } else { None },
        reason,
        checked_at: text("checkedAt").unwrap_or_default(),
    })
}

/// Turn one fetch result into a verdict, updating the cache only on a
/// well-formed answer.
pub fn apply_fiscal_status_result(
    branch_id: &str,
    result: Result<Value, AdminFetchError>,
) -> FiscalStatusRefresh {
    let branch_id = branch_id.trim();
    if branch_id.is_empty() {
        return FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured);
    }
    match result {
        Ok(body) => match parse_fiscal_status_response(&body) {
            Some(status) => {
                active_cache::update_with_plugin(
                    branch_id,
                    status.active,
                    status.plugin_id.clone(),
                );
                if status.active {
                    FiscalStatusRefresh::Active(status)
                } else {
                    FiscalStatusRefresh::Inactive(status)
                }
            }
            None => {
                warn!("[fiscal.status] malformed fiscal status response ignored");
                FiscalStatusRefresh::Unknown(UnknownReason::MalformedResponse)
            }
        },
        Err(error) if error.status() == Some(404) => {
            debug!("[fiscal.status] server has no fiscal status route; verdict stays unknown");
            FiscalStatusRefresh::Unknown(UnknownReason::EndpointUnavailable)
        }
        Err(error) => {
            debug!(
                status = ?error.status(),
                "[fiscal.status] fiscal status check failed; verdict stays unknown"
            );
            FiscalStatusRefresh::Unknown(UnknownReason::FetchFailed)
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn schedule_next_refresh(outcome: &FiscalStatusRefresh) {
    let delay = match outcome {
        FiscalStatusRefresh::Active(_) | FiscalStatusRefresh::Inactive(_) => REFRESH_INTERVAL,
        FiscalStatusRefresh::Unknown(_) => RETRY_AFTER_FAILURE,
    };
    NEXT_REFRESH_DUE_MS.store(
        now_ms().saturating_add(i64::try_from(delay.as_millis()).unwrap_or(i64::MAX)),
        Ordering::Relaxed,
    );
}

/// Ask with an injected fetch and feed the cache.
pub async fn refresh_with<F, Fut>(branch_id: &str, fetch: F) -> FiscalStatusRefresh
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, AdminFetchError>>,
{
    refresh_with_timeout(branch_id, REQUEST_TIMEOUT, fetch).await
}

async fn refresh_with_timeout<F, Fut>(
    branch_id: &str,
    timeout: Duration,
    fetch: F,
) -> FiscalStatusRefresh
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, AdminFetchError>>,
{
    if branch_id.trim().is_empty() {
        return FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured);
    }
    let result = match tokio::time::timeout(timeout, fetch()).await {
        Ok(result) => result,
        Err(_) => Err(AdminFetchError::transport(
            "fiscal status request timed out",
        )),
    };
    let previous = active_cache::verdict(branch_id.trim());
    let outcome = apply_fiscal_status_result(branch_id, result);
    schedule_next_refresh(&outcome);
    match &outcome {
        FiscalStatusRefresh::Active(status) if previous != CacheVerdict::Active => info!(
            branch_id = %branch_id.trim(),
            active = status.active,
            reason = %status.reason,
            "[fiscal.status] fiscalization became active"
        ),
        FiscalStatusRefresh::Inactive(status) if previous == CacheVerdict::Active => info!(
            branch_id = %branch_id.trim(),
            active = status.active,
            reason = %status.reason,
            "[fiscal.status] fiscalization became inactive"
        ),
        FiscalStatusRefresh::Active(status) | FiscalStatusRefresh::Inactive(status) => debug!(
            branch_id = %branch_id.trim(),
            active = status.active,
            reason = %status.reason,
            "[fiscal.status] fiscal-active verdict refreshed"
        ),
        FiscalStatusRefresh::Unknown(reason) => debug!(
            branch_id = %branch_id.trim(),
            reason = reason.as_str(),
            "[fiscal.status] fiscal-active verdict unknown"
        ),
    }
    outcome
}

/// Ask the server now (bounded by [`REQUEST_TIMEOUT`]).
pub async fn refresh_now(admin_url: &str, api_key: &str, branch_id: &str) -> FiscalStatusRefresh {
    if admin_url.trim().is_empty() || api_key.trim().is_empty() {
        return FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured);
    }
    refresh_with(branch_id, || {
        api::fetch_from_admin_detailed_with_timeout(
            admin_url,
            api_key,
            STATUS_PATH,
            "GET",
            None,
            REQUEST_TIMEOUT,
        )
    })
    .await
}

/// Whether a throttled refresh should run now: a pending [`mark_due`]
/// request (consumed here, so a request made while this refresh is in flight
/// stays pending for the next pass) or an elapsed schedule.
fn claim_due_refresh() -> bool {
    if REFRESH_FORCED.swap(false, Ordering::AcqRel) {
        return true;
    }
    now_ms() >= NEXT_REFRESH_DUE_MS.load(Ordering::Acquire)
}

/// Throttled refresh for the background sync pass: at most every
/// [`REFRESH_INTERVAL`] after an answer, every [`RETRY_AFTER_FAILURE`] after a
/// failure, and immediately once [`mark_due`] ran.
pub async fn refresh_if_due(
    admin_url: &str,
    api_key: &str,
    branch_id: &str,
) -> Option<FiscalStatusRefresh> {
    if !claim_due_refresh() {
        return None;
    }
    Some(refresh_now(admin_url, api_key, branch_id).await)
}

/// Make the next background pass refresh (settings sync, staff login). The
/// request survives a refresh that is already in flight.
pub fn mark_due() {
    REFRESH_FORCED.store(true, Ordering::Release);
    NEXT_REFRESH_DUE_MS.store(0, Ordering::Release);
}

/// Refresh with the terminal's stored credentials and branch (the Z-report
/// path). A terminal without them keeps its current verdict.
pub async fn refresh_from_stored_credentials() -> FiscalStatusRefresh {
    let Some(admin_url) = crate::storage::get_credential("admin_dashboard_url") else {
        return FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured);
    };
    let Some(api_key) = crate::sync::load_zeroized_pos_api_key_optional() else {
        return FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured);
    };
    let branch_id = crate::storage::get_credential("branch_id").unwrap_or_default();
    refresh_now(&admin_url, &api_key, &branch_id).await
}

/// [`refresh_from_stored_credentials`] behind the background throttle (the
/// Z preview, which re-reads every 30 s while it is open).
pub async fn refresh_if_due_from_stored_credentials() -> Option<FiscalStatusRefresh> {
    if !claim_due_refresh() {
        return None;
    }
    Some(refresh_from_stored_credentials().await)
}

#[cfg(test)]
pub(crate) fn reset_schedule_for_tests() {
    REFRESH_FORCED.store(false, Ordering::Relaxed);
    NEXT_REFRESH_DUE_MS.store(0, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicitly_disconnected_branch_is_inactive_even_with_older_server_verdict() {
        let reply = parse_fiscal_status_response(&json!({
            "active":true,"pluginId":"mydata","reason":"branch_config_not_connected"
        }))
        .unwrap();
        assert!(!reply.active);
        assert_eq!(reply.plugin_id, None);
        for reason in [
            "active",
            "credentials_missing",
            "certification_missing",
            "no_active_plugin",
        ] {
            assert!(
                parse_fiscal_status_response(&json!({"active":true,"reason":reason}))
                    .unwrap()
                    .active
            );
        }
    }

    #[test]
    fn parses_the_contract_body_and_the_wrapped_form() {
        let plain = parse_fiscal_status_response(&json!({
            "active": false,
            "pluginId": null,
            "reason": "branch_config_missing",
            "checkedAt": "2026-09-30T08:00:00.000Z",
        }))
        .expect("contract body");
        assert!(!plain.active);
        assert_eq!(plain.plugin_id, None);
        assert_eq!(plain.reason, "branch_config_missing");

        let wrapped = parse_fiscal_status_response(&json!({
            "success": true,
            "data": { "active": true, "pluginId": "mydata", "reason": "active", "checkedAt": "x" },
        }))
        .expect("wrapped body");
        assert!(wrapped.active);
        assert_eq!(wrapped.plugin_id.as_deref(), Some("mydata"));

        for malformed in [
            json!({}),
            json!({ "active": "false" }),
            json!({ "success": false, "error": "fiscal_status_unavailable" }),
            json!({ "data": { "active": null } }),
            json!(null),
        ] {
            assert_eq!(
                parse_fiscal_status_response(&malformed),
                None,
                "{malformed}"
            );
        }
    }

    #[test]
    #[serial_test::serial]
    fn only_a_well_formed_answer_moves_the_verdict() {
        active_cache::reset_for_tests();

        let inactive = apply_fiscal_status_result(
            "branch-lpp",
            Ok(
                json!({ "active": false, "pluginId": null, "reason": "branch_config_missing", "checkedAt": "t" }),
            ),
        );
        assert!(matches!(inactive, FiscalStatusRefresh::Inactive(_)));
        assert_eq!(active_cache::verdict("branch-lpp"), CacheVerdict::Inactive);
        assert_eq!(verdict_label("branch-lpp"), "inactive");

        let active = apply_fiscal_status_result(
            "branch-fiscal",
            Ok(
                json!({ "active": true, "pluginId": "mydata", "reason": "active", "checkedAt": "t" }),
            ),
        );
        assert!(matches!(active, FiscalStatusRefresh::Active(_)));
        assert_eq!(verdict_label("branch-fiscal"), "active");

        // 404 (older server), 503 (config read failed), a transport error and
        // a malformed body never write a verdict: fail closed.
        for (branch, result, reason) in [
            (
                "branch-old-server",
                Err(AdminFetchError::from_http_response_for_test(
                    404,
                    "Not Found",
                )),
                UnknownReason::EndpointUnavailable,
            ),
            (
                "branch-503",
                Err(AdminFetchError::from_http_response_for_test(
                    503,
                    r#"{"success":false,"error":"fiscal_status_unavailable"}"#,
                )),
                UnknownReason::FetchFailed,
            ),
            (
                "branch-offline",
                Err(AdminFetchError::transport("connection refused")),
                UnknownReason::FetchFailed,
            ),
            (
                "branch-garbage",
                Ok(json!({ "ok": true })),
                UnknownReason::MalformedResponse,
            ),
        ] {
            assert_eq!(
                apply_fiscal_status_result(branch, result),
                FiscalStatusRefresh::Unknown(reason),
                "{branch}"
            );
            assert_eq!(
                active_cache::verdict(branch),
                CacheVerdict::Unknown,
                "{branch}"
            );
            assert_eq!(verdict_label(branch), "unknown", "{branch}");
        }

        assert_eq!(
            apply_fiscal_status_result("  ", Ok(json!({ "active": false }))),
            FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured)
        );
    }

    #[test]
    #[serial_test::serial]
    fn a_failed_check_keeps_the_last_known_verdict_until_it_expires() {
        active_cache::reset_for_tests();
        apply_fiscal_status_result("branch-keep", Ok(json!({ "active": false })));
        let failed =
            apply_fiscal_status_result("branch-keep", Err(AdminFetchError::transport("timeout")));
        assert_eq!(
            failed,
            FiscalStatusRefresh::Unknown(UnknownReason::FetchFailed)
        );
        assert_eq!(
            active_cache::verdict("branch-keep"),
            CacheVerdict::Inactive,
            "a failure does not overwrite a fresh answer; the TTL expires it"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_background_refresh_is_throttled_and_mark_due_forces_it() {
        active_cache::reset_for_tests();
        reset_schedule_for_tests();

        let first = refresh_with("branch-throttle", || async {
            Ok(json!({ "active": false, "reason": "branch_config_missing" }))
        })
        .await;
        assert!(matches!(first, FiscalStatusRefresh::Inactive(_)));
        assert!(
            now_ms() < NEXT_REFRESH_DUE_MS.load(Ordering::Relaxed),
            "an answer schedules the next refresh"
        );
        // Due-gate: the background pass skips while the verdict is fresh.
        assert!(refresh_if_due("", "", "branch-throttle").await.is_none());

        mark_due();
        // Due again; with no credentials the refresh reports not configured
        // and leaves the fresh verdict alone.
        assert_eq!(
            refresh_if_due("", "", "branch-throttle").await,
            Some(FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured))
        );
        assert_eq!(
            active_cache::verdict("branch-throttle"),
            CacheVerdict::Inactive
        );
        reset_schedule_for_tests();
    }

    /// Review of the 29/09/2026 fixes: `mark_due` only zeroed the schedule,
    /// so a refresh already in flight when a settings sync or a staff login
    /// asked for a fresh answer rescheduled itself four minutes out on
    /// completion and silently swallowed the request.
    #[tokio::test]
    #[serial_test::serial]
    async fn a_due_request_made_while_a_refresh_is_in_flight_is_not_lost() {
        active_cache::reset_for_tests();
        reset_schedule_for_tests();
        let (release, released) = tokio::sync::oneshot::channel::<()>();

        let in_flight = refresh_with("branch-in-flight", move || async move {
            let _ = released.await;
            Ok(json!({ "active": true, "pluginId": "fiscalization_gr", "reason": "active" }))
        });
        let settings_sync = async move {
            // The refresh has sent its request and waits for the answer.
            tokio::task::yield_now().await;
            mark_due();
            let _ = release.send(());
        };
        let (outcome, ()) = tokio::join!(in_flight, settings_sync);

        assert!(matches!(outcome, FiscalStatusRefresh::Active(_)));
        assert!(
            now_ms() < NEXT_REFRESH_DUE_MS.load(Ordering::Relaxed),
            "the finished refresh scheduled its successor"
        );
        assert_eq!(
            refresh_if_due("", "", "branch-in-flight").await,
            Some(FiscalStatusRefresh::Unknown(UnknownReason::NotConfigured)),
            "the request made mid-flight is served by the next pass"
        );
        assert!(
            refresh_if_due("", "", "branch-in-flight").await.is_none(),
            "and only once"
        );
        assert_eq!(
            active_cache::fresh_active_plugin_id("branch-in-flight").as_deref(),
            Some("fiscalization_gr"),
            "the answer keeps the plugin it named"
        );
        active_cache::reset_for_tests();
        reset_schedule_for_tests();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_slow_server_times_out_as_unknown() {
        active_cache::reset_for_tests();
        reset_schedule_for_tests();
        let outcome = refresh_with_timeout("branch-slow", Duration::from_millis(20), || async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(json!({ "active": false }))
        })
        .await;
        assert_eq!(
            outcome,
            FiscalStatusRefresh::Unknown(UnknownReason::FetchFailed)
        );
        assert_eq!(active_cache::verdict("branch-slow"), CacheVerdict::Unknown);
        reset_schedule_for_tests();
    }
}
