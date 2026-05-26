//! Replay branch for `parity_sync_queue` rows whose `module_type='fiscal'`.
//!
//! Implements Task 20 of `.claude/specs/fiscalization-core/tasks.md`.
//! Satisfies Reqs 4.5, 4.6.
//!
//! Called from the routing wiring in `crate::sync_queue::process_queue`
//! (T21) when it picks up a row whose `module_type` is `'fiscal'`. We
//! POST the stored payload back to the admin-dashboard, mark the local
//! row processed on success, or leave it pending on transient failure so
//! the existing claim-generation backoff handles the next attempt.
//!
//! Per Req 12, panics and network failures NEVER propagate to the queue
//! driver. This function returns a tagged [`ReplayOutcome`] for the
//! driver to act on, but always returns `Ok`-shaped data.

use serde::Serialize;
use tracing::{info, warn};

use super::dispatcher::{self, DispatchOutcome};

#[derive(Debug, Clone, Serialize)]
pub enum ReplayOutcome {
    /// Server accepted the replay. Driver should mark the row processed.
    Submitted(DispatchOutcome),
    /// Server returned `status='queued'` — server-side outbox owns the
    /// retry now. Driver may mark the local row processed (the SERVER
    /// will keep retrying via its own cron).
    HandedOffToServer(DispatchOutcome),
    /// Server returned `status='skipped'` — terminal local outcome.
    /// Driver should mark the row processed; no retry.
    SkippedByServer(DispatchOutcome),
    /// Server rejected with a permanent error. Driver should mark
    /// terminally failed and surface via the existing sync-error channel.
    FailedTerminal(DispatchOutcome),
    /// Transient failure (network, 5xx). Driver should leave the row
    /// pending so claim-generation backoff retries it.
    TransientFailure { error: String },
}

/// Replay a single `module_type='fiscal'` row.
///
/// The driver passes in the stored payload (verbatim from the
/// `parity_sync_queue.payload` column) plus its identifier and the
/// usual admin URL + API key context. We re-POST and report what to do
/// with the local row.
pub async fn replay_fiscal_row(
    payload_text: &str,
    admin_base_url: &str,
    api_key: &str,
    terminal_id: &str,
    queue_row_id: &str,
) -> ReplayOutcome {
    let payload = match serde_json::from_str::<serde_json::Value>(payload_text) {
        Ok(v) => v,
        Err(e) => {
            // Malformed payload is terminal — no retry will fix invalid JSON.
            warn!(
                "[fiscal.replay] row {queue_row_id} payload is not valid JSON: {e}. \
                 Marking failed-terminal so it stops blocking the queue."
            );
            return ReplayOutcome::FailedTerminal(DispatchOutcome {
                status: "failed".to_string(),
                outbox_row_id: None,
                plugin_id: None,
                reason: Some("local_payload_malformed".to_string()),
                authority_id: None,
            });
        }
    };

    match dispatcher::try_post(admin_base_url, api_key, terminal_id, &payload).await {
        Ok(outcome) => {
            info!(
                "[fiscal.replay] row {queue_row_id} server outcome: status={} plugin={:?} \
                 reason={:?}",
                outcome.status, outcome.plugin_id, outcome.reason
            );
            match outcome.status.as_str() {
                "submitted" => ReplayOutcome::Submitted(outcome),
                "queued" => ReplayOutcome::HandedOffToServer(outcome),
                "skipped" => ReplayOutcome::SkippedByServer(outcome),
                "failed" => ReplayOutcome::FailedTerminal(outcome),
                other => {
                    warn!(
                        "[fiscal.replay] row {queue_row_id} unexpected server status {other}; \
                         treating as transient and retrying."
                    );
                    ReplayOutcome::TransientFailure {
                        error: format!("unexpected server status: {other}"),
                    }
                }
            }
        }
        Err(e) => ReplayOutcome::TransientFailure { error: e },
    }
}
