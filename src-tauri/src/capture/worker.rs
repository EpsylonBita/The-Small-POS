//! Capture worker — the recognition pipeline, and the local-cleanup rule.
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
//! **D-Rust4**. Requirements R6.1, R6.2, R6.5, R7.4, R10.3, R11.2, R11.3,
//! R11.6, R11.7, R11.8, R11.9, R12.6, R17.6.
//!
//! One background loop drives every captured document from "the user finished
//! scanning" to "ready to check", and nothing else on the terminal has to be
//! watching for it to happen:
//!
//! ```text
//! waiting ──upload each page (admin_fetch_raw)──▶ uploading
//!         ──recognize (storageKeys)────────────▶ reading
//!         ──store recognition_json─────────────▶ ready_review  (+ capture:status-changed)
//! ```
//!
//! **Recognition is background work, not a screen.** The document itself
//! carries the busy state (`uploading` / `reading` render as "Reading your
//! invoice…"), so the user may walk away, serve a customer, or close the
//! suppliers area without cancelling anything: the worker holds no UI state and
//! takes no instruction from the renderer. When a document reaches
//! `ready_review` the worker emits [`EVENT_STATUS_CHANGED`], which is what
//! surfaces the finished result — with no delay beyond this document's normal
//! turn in the queue (R6.2, R11.9, R17.6).
//!
//! **Nothing is ever lost.** Every failure moves a document sideways, never off
//! the queue (R11.6):
//!
//! - **Offline** — the pass is skipped entirely. The document stays `waiting`
//!   and **no attempt is burned**: waiting for connectivity is not a failure
//!   (R11.2).
//! - **Transient HTTP** (5xx, 408, 429, credential/authorization states) — back
//!   to `waiting` on an exponential backoff. Deliberately **never** escalated
//!   to `needs_attention`: a flaky link is not something the user can fix by
//!   re-reading their invoice, and R12.6 asks for silent automatic retry with a
//!   truthful status (which `waiting` is).
//! - **403 `MODULE_REQUIRED`** — `parked` on the slow 30-minute probe cadence
//!   [`MODULE_PARK_RETRY_SECS`], mirroring the parity queue's
//!   `mark_module_required`, and resumed automatically the moment the module is
//!   back. No attempt burned — entitlement is a billing state, not a data
//!   problem (R11.7).
//! - **Typed 4xx** — `needs_attention` with a stable reason code the renderer
//!   maps to plain language. The document, its pages and its edits are all
//!   retained; the user retries or fills the invoice in by hand (R7.4, R11.6).
//!
//! Documents are drained FIFO by `captured_at` (R11.3), and an upload
//! interrupted after page 3 of 7 resumes at page 4 — every page's storage key
//! is persisted the instant its request succeeds (D11).
//!
//! **Local cleanup** (R11.8, R10.3) is the mirror image of that promise: page
//! files are deleted *only* for `committed` documents, and only once the server
//! has confirmed the invoice **with its attachment present**. A document that
//! is `waiting`, `ready_review`, `needs_attention` or `parked` is never
//! cleaned, whatever the disk pressure — those bytes are the only copy.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{Emitter, Listener};
use tracing::{info, warn};

use crate::api::AdminFetchError;
use crate::db;
use crate::sync_queue;

use super::files;
use super::store::{self, CaptureDocument};
use super::{CaptureStatus, MAX_CAPTURE_PAGES, MAX_CAPTURE_PAGE_BYTES};

// ---------------------------------------------------------------------------
// Cadence and vocabulary
// ---------------------------------------------------------------------------

/// Base cadence of the worker loop. The loop also wakes early on a new capture
/// or on connectivity coming back, so this is the *worst* case wait, not the
/// typical one.
pub const WORKER_INTERVAL_SECS: u64 = 15;

/// Emitted whenever a document's lifecycle status changes. The renderer's
/// notification manager listens for this to raise "Ready to check" (R11.9).
pub const EVENT_STATUS_CHANGED: &str = "capture:status-changed";

/// Local history event recording the server's verbatim commit result. Written
/// by [`confirm_commit`]; read by [`cleanup_committed_captures`], which is the
/// only thing allowed to delete a committed document's page files.
pub const EVENT_COMMIT_CONFIRMED: &str = "committed";

/// Local history event recording that a committed document's page files were
/// removed after the server confirmed its attachment.
pub const EVENT_LOCAL_FILES_CLEANED: &str = "local_files_cleaned";

/// First backoff step after a transient failure.
pub const BASE_BACKOFF_SECS: i64 = 15;

/// Backoff ceiling. A terminal that has been failing for an hour still re-tries
/// every quarter hour — slow enough not to hammer, fast enough that recovery is
/// noticed without anyone pressing anything.
pub const MAX_BACKOFF_SECS: i64 = 15 * 60;

/// Re-probe cadence for module-parked documents. Deliberately *the* parity
/// queue constant rather than a copy of its value: the two must not drift, and
/// "the suppliers module came back" should reach a parked capture and a parked
/// queue row on the same schedule (R11.7).
pub const MODULE_PARK_RETRY_SECS: i64 = sync_queue::MODULE_REQUIRED_RETRY_SECS;

/// Suppliers module inactive for this organization. Parked, never lost.
pub const REASON_MODULE_REQUIRED: &str = "MODULE_REQUIRED";

/// The document could not be read (server refused it as unusable input).
pub const REASON_UNREADABLE: &str = "CAPTURE_UNREADABLE";

/// A page is larger than the terminal or the server will accept.
pub const REASON_TOO_LARGE: &str = "CAPTURE_TOO_LARGE";

/// More pages than one invoice may hold.
pub const REASON_TOO_MANY_PAGES: &str = "CAPTURE_TOO_MANY_PAGES";

const ATTACHMENTS_PATH: &str = "/api/pos/suppliers/import/attachments";
const OCR_PATH: &str = "/api/pos/suppliers/import/ocr";
const OCTET_STREAM: &str = "application/octet-stream";

/// Recognition gets its own request budget instead of the 30-second API
/// default. On a cold serverless start the OCR route creates a recognition
/// worker and may fetch language packs before answering — observed worst case
/// just under a minute. With the default budget the client hung up at exactly
/// 30s, the capture re-queued, and the identical doomed request repeated for
/// a day (51 attempts) while the server kept doing work nobody received.
/// Generous is correct here: the worker processes one document at a time and
/// the user is never waiting on this screen (R6.2 — results surface later).
const OCR_RECOGNITION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Statuses the worker is responsible for moving forward. `capturing` is the
/// user's, `ready_review` is the user's, and the terminal states are nobody's.
///
/// `parked` is deliberately absent: a parked document is unparked by
/// [`resume_parked_recognition`] *first*, so what the queue hands out is always
/// something the pipeline can legally act on.
const ACTIONABLE: [CaptureStatus; 3] = [
    CaptureStatus::Waiting,
    // `uploading` / `reading` appear here because a crash mid-step leaves a
    // document in them; resuming is exactly what the next turn should do.
    CaptureStatus::Uploading,
    CaptureStatus::Reading,
];

// ---------------------------------------------------------------------------
// Failure classification (pure)
// ---------------------------------------------------------------------------

/// What a failed worker step means for the document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StepFailure {
    /// The request never reached the dashboard. Nothing about the document is
    /// wrong, so nothing about the document changes.
    Offline,
    /// `403 MODULE_REQUIRED` — the organization has not acquired the suppliers
    /// module. Carries the missing-module list for the log.
    ModuleRequired(String),
    /// Server-side or infrastructure trouble that is expected to pass.
    Transient,
    /// A typed client error: this document needs a person. Carries the stable
    /// reason code the renderer maps to plain language.
    NeedsAttention(&'static str),
}

/// Recover the verbatim response body the transport embedded in its error
/// message, so the *shared* uniform-contract parser decides what
/// `MODULE_REQUIRED` means — rather than this module inventing a second,
/// drift-prone opinion about the same 403.
///
/// `api::admin_http_error_from_body` formats a JSON error as
/// `"{message} (HTTP {status}): {body}"`, so the original body is the brace-
/// delimited span inside the message.
fn module_required_reason(error: &AdminFetchError) -> Option<String> {
    let status = error.status()?;
    let message = error.to_string();
    let start = message.find('{')?;
    let end = message.rfind('}')?;
    if end < start {
        return None;
    }
    sync_queue::parse_module_required_response(status, &message[start..=end])
}

/// Map one transport failure onto the worker's failure policy.
pub fn classify_admin_error(error: &AdminFetchError) -> StepFailure {
    if let Some(missing) = module_required_reason(error) {
        return StepFailure::ModuleRequired(missing);
    }

    match error.status() {
        // No HTTP status at all: DNS, connect, timeout, plain-HTTP refusal —
        // the terminal never got an answer. Treated as offline so a link that
        // drops mid-upload costs the document nothing (R11.2).
        None => StepFailure::Offline,
        Some(408) | Some(429) => StepFailure::Transient,
        // Credential / authorization states are an operator problem, not a
        // document problem. Telling the user "we couldn't read this file"
        // would be a lie, so these back off and re-probe instead.
        Some(401) | Some(403) => StepFailure::Transient,
        Some(413) => StepFailure::NeedsAttention(REASON_TOO_LARGE),
        Some(status) if (400..500).contains(&status) => {
            StepFailure::NeedsAttention(REASON_UNREADABLE)
        }
        // 5xx and anything unclassified: fail closed onto the retry path, never
        // onto a dead end (handling rule 1).
        Some(_) => StepFailure::Transient,
    }
}

/// Exponential backoff: 15s, 30s, 1m, 2m, … capped at [`MAX_BACKOFF_SECS`].
pub fn backoff_delay_secs(attempts: i64) -> i64 {
    let steps = attempts.clamp(0, 16) as u32;
    let factor = 1_i64.checked_shl(steps).unwrap_or(i64::MAX);
    BASE_BACKOFF_SECS
        .saturating_mul(factor)
        .clamp(BASE_BACKOFF_SECS, MAX_BACKOFF_SECS)
}

/// Is this document's scheduled retry time in the past?
///
/// An unparseable `next_retry_at` reads as due: a corrupt timestamp must not be
/// able to strand a captured invoice forever.
pub fn is_due(document: &CaptureDocument, now: DateTime<Utc>) -> bool {
    match document.next_retry_at.as_deref() {
        None => true,
        Some(raw) => DateTime::parse_from_rfc3339(raw)
            .map(|at| at.with_timezone(&Utc) <= now)
            .unwrap_or(true),
    }
}

// ---------------------------------------------------------------------------
// Queue selection and failure application (pure DB effects — no network)
// ---------------------------------------------------------------------------

/// The oldest document whose next attempt is due (R11.3 FIFO).
pub fn next_actionable(
    conn: &Connection,
    now: DateTime<Utc>,
) -> Result<Option<CaptureDocument>, String> {
    let documents = store::list_documents_by_status(conn, &ACTIONABLE)?;
    Ok(documents.into_iter().find(|document| is_due(document, now)))
}

/// A `parked` document that already holds a recognition result was parked on
/// its **commit**, not its recognition. Its replay lives in the parity queue,
/// which re-probes the module on the very same cadence — so the worker leaves
/// it alone rather than pulling it back into a recognition it already finished.
fn is_parked_commit(document: &CaptureDocument) -> bool {
    document.status == CaptureStatus::Parked && document.recognition_json.is_some()
}

/// Bring a module-parked document back onto the recognition queue.
///
/// Returns `true` when the document was resumed. Called at the top of every
/// turn: the probe *is* the resume, so a terminal whose organization re-acquired
/// the module recovers with nobody pressing anything (R11.7).
pub fn resume_parked_recognition(
    conn: &Connection,
    document: &CaptureDocument,
) -> Result<bool, String> {
    if document.status != CaptureStatus::Parked || is_parked_commit(document) {
        return Ok(false);
    }
    store::set_status(conn, &document.id, CaptureStatus::Waiting, None)?;
    store::clear_retry(conn, &document.id)?;
    Ok(true)
}

/// Apply the worker's failure policy to a document. Returns the status it now
/// holds.
///
/// This is the whole of "a failure moves a document sideways, never off the
/// queue" in one place, with no network in sight — which is what makes the
/// policy testable rather than merely asserted.
pub fn apply_step_failure(
    conn: &Connection,
    document: &CaptureDocument,
    failure: &StepFailure,
) -> Result<CaptureStatus, String> {
    let now = Utc::now();
    match failure {
        StepFailure::Offline => {
            store::set_status(conn, &document.id, CaptureStatus::Waiting, None)?;
            store::schedule_retry(
                conn,
                &document.id,
                &(now + ChronoDuration::seconds(WORKER_INTERVAL_SECS as i64)).to_rfc3339(),
                // Waiting for connectivity is not a failed attempt (R11.2).
                false,
            )?;
            Ok(CaptureStatus::Waiting)
        }
        StepFailure::ModuleRequired(missing) => {
            store::set_status(
                conn,
                &document.id,
                CaptureStatus::Parked,
                Some(REASON_MODULE_REQUIRED),
            )?;
            store::schedule_retry(
                conn,
                &document.id,
                &(now + ChronoDuration::seconds(MODULE_PARK_RETRY_SECS)).to_rfc3339(),
                // Entitlement is a billing state; it must not consume the
                // document's retry budget (R11.7).
                false,
            )?;
            if !missing.is_empty() {
                warn!(
                    capture_id = %document.id,
                    missing_modules = %missing,
                    "Capture parked pending module acquisition"
                );
            }
            Ok(CaptureStatus::Parked)
        }
        StepFailure::Transient => {
            store::set_status(conn, &document.id, CaptureStatus::Waiting, None)?;
            store::schedule_retry(
                conn,
                &document.id,
                &(now + ChronoDuration::seconds(backoff_delay_secs(document.attempts)))
                    .to_rfc3339(),
                true,
            )?;
            Ok(CaptureStatus::Waiting)
        }
        StepFailure::NeedsAttention(reason) => {
            store::set_status(
                conn,
                &document.id,
                CaptureStatus::NeedsAttention,
                Some(reason),
            )?;
            // No automatic retry: the next move is the user's (try again, or
            // fill the invoice in by hand). The document and every edit on it
            // stay exactly where they are (R7.4, R11.6).
            clear_retry_timestamp(conn, &document.id)?;
            Ok(CaptureStatus::NeedsAttention)
        }
    }
}

/// Drop a document's pending retry time without touching its attempt count.
fn clear_retry_timestamp(conn: &Connection, capture_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE capture_documents SET next_retry_at = NULL WHERE id = ?1",
        rusqlite::params![capture_id],
    )
    .map_err(|e| format!("clear capture retry time: {e}"))?;
    Ok(())
}

/// Pre-flight the document's own pages before a single byte leaves the
/// terminal, so the limits are reported as a capture problem rather than as an
/// upload failure (R12.2, R12.3).
pub fn precheck_pages(pages: &[store::CapturePage]) -> Option<StepFailure> {
    if pages.is_empty() {
        // A finished document with no pages cannot be recognized. It is kept
        // and explained rather than quietly retried forever.
        return Some(StepFailure::NeedsAttention(REASON_UNREADABLE));
    }
    if pages.len() > MAX_CAPTURE_PAGES {
        return Some(StepFailure::NeedsAttention(REASON_TOO_MANY_PAGES));
    }
    if pages
        .iter()
        .any(|page| page.byte_size.max(0) as u64 > MAX_CAPTURE_PAGE_BYTES)
    {
        return Some(StepFailure::NeedsAttention(REASON_TOO_LARGE));
    }
    None
}

// ---------------------------------------------------------------------------
// Commit confirmation and local cleanup (R11.8)
// ---------------------------------------------------------------------------

/// Does this commit result prove the invoice exists **with its attachment**?
///
/// Both halves are required. `attachmentPending` means the server kept the
/// staged pages because assembly failed and its retry sweep still needs them —
/// the local copy stays too, because at that moment nothing anywhere is a
/// finished attachment.
pub fn commit_is_confirmed_with_attachment(result: &Value) -> bool {
    let invoice_id = result
        .get("supplierInvoiceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if invoice_id.is_empty() {
        return false;
    }
    if result
        .get("attachmentPending")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    result
        .get("attachmentUrl")
        .and_then(Value::as_str)
        .map(|url| !url.trim().is_empty())
        .unwrap_or(false)
}

/// Record the server's verbatim commit result and move the document to
/// `committed`.
///
/// This is the *only* door to the terminal state, and deliberately so: local
/// cleanup keys off the stored result, so a document can only ever become
/// eligible for cleanup by way of something the server actually said.
pub fn confirm_commit(
    conn: &Connection,
    capture_id: &str,
    result: &Value,
    staff_id: Option<&str>,
) -> Result<(), String> {
    store::record_event(
        conn,
        Some(capture_id),
        EVENT_COMMIT_CONFIRMED,
        staff_id,
        Some(result),
    )?;
    store::set_status(conn, capture_id, CaptureStatus::Committed, None)
}

/// The most recent server-confirmed commit result for a document, if any.
pub fn committed_result(conn: &Connection, capture_id: &str) -> Result<Option<Value>, String> {
    Ok(store::list_events(conn, capture_id)?
        .into_iter()
        .rev()
        .filter(|event| event.event_type == EVENT_COMMIT_CONFIRMED)
        .find_map(|event| {
            event
                .details_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        }))
}

/// Delete the local page files of committed documents whose invoice **and
/// attachment** the server confirmed. Returns the capture ids cleaned.
///
/// Every other status is skipped unconditionally — this function is the whole
/// implementation of R11.8's "the client SHALL never delete captured documents
/// that have not been committed", and it holds no matter how the caller feels
/// about disk pressure.
pub fn cleanup_committed_captures(
    conn: &Connection,
    app_data_dir: &Path,
) -> Result<Vec<String>, String> {
    let committed = store::list_documents_by_status(conn, &[CaptureStatus::Committed])?;
    let mut cleaned = Vec::new();

    for document in committed {
        let Some(result) = committed_result(conn, &document.id)? else {
            // Committed without a stored server result (a legacy row, or a
            // commit confirmed by a path that predates this rule): keep the
            // bytes. Retaining an extra copy costs disk; deleting the only
            // copy of an invoice costs the business.
            continue;
        };
        if !commit_is_confirmed_with_attachment(&result) {
            continue;
        }
        if files::remove_capture_files(app_data_dir, &document.id).is_err() {
            // A file that will not delete is not a reason to lose the row; the
            // next pass tries again.
            continue;
        }
        store::record_event(
            conn,
            Some(&document.id),
            EVENT_LOCAL_FILES_CLEANED,
            None,
            Some(&json!({
                "supplier_invoice_id": result.get("supplierInvoiceId"),
                "attachment_url": result.get("attachmentUrl"),
            })),
        )?;
        cleaned.push(document.id);
    }

    Ok(cleaned)
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// Percent-encode a free-text query value, and drop everything that could ever
/// be read as a path.
///
/// `validate_admin_api_path` percent-*decodes* before checking for `..`, so an
/// encoded dot would not help; source names are display strings, so the safe
/// and honest move is to keep only the characters that carry meaning.
fn encode_query_value(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'))
        .take(60)
        .map(|c| {
            if c == ' ' {
                "%20".to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}

/// Build the raw-upload path for one page (D11: metadata rides outside the
/// body, one request per page).
fn page_upload_path(document: &CaptureDocument, page_index: i64) -> String {
    let mut path = format!(
        "{ATTACHMENTS_PATH}?captureId={}&pageIndex={page_index}&kind=page&sourceKind={}",
        document.id, document.source_kind
    );
    if let Some(name) = document.source_name.as_deref() {
        let encoded = encode_query_value(name);
        if !encoded.is_empty() {
            path.push_str(&format!("&sourceName={encoded}"));
        }
    }
    if let Some(staff_id) = document.staff_id.as_deref() {
        let encoded = encode_query_value(staff_id);
        if !encoded.is_empty() {
            path.push_str(&format!("&staffId={encoded}"));
        }
    }
    path
}

/// The storage key the server assigned to an uploaded page.
fn read_storage_key(response: &Value) -> Option<String> {
    response
        .get("storageKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// The worker turn
// ---------------------------------------------------------------------------

fn lock(db: &db::DbState) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.conn
        .lock()
        .map_err(|error| format!("capture worker db lock: {error}"))
}

fn emit_status(
    app: &tauri::AppHandle,
    capture_id: &str,
    status: CaptureStatus,
    reason: Option<&str>,
) {
    let _ = app.emit(
        EVENT_STATUS_CHANGED,
        json!({
            "captureId": capture_id,
            "status": status.as_str(),
            "reason": reason,
        }),
    );
}

/// Advance one document by as far as it can go this turn.
async fn advance_document(
    app: &tauri::AppHandle,
    db: &Arc<db::DbState>,
    app_data_dir: &Path,
    document: CaptureDocument,
) -> Result<(), String> {
    let capture_id = document.id.clone();

    // ---- pages, and the client-side limits ------------------------------ //
    let pages = {
        let conn = lock(db)?;
        store::list_pages(&conn, &capture_id)?
    };
    if let Some(failure) = precheck_pages(&pages) {
        let status = {
            let conn = lock(db)?;
            apply_step_failure(&conn, &document, &failure)?
        };
        emit_status(app, &capture_id, status, reason_of(&failure));
        return Ok(());
    }

    // ---- upload, resuming at the first page without a storage key ------- //
    if document.status != CaptureStatus::Reading {
        let conn_status = {
            let conn = lock(db)?;
            store::set_status(&conn, &capture_id, CaptureStatus::Uploading, None)?;
            store::first_unuploaded_page(&conn, &capture_id)?
        };
        emit_status(app, &capture_id, CaptureStatus::Uploading, None);

        if let Some(first) = conn_status {
            for page in pages.iter().filter(|page| page.page_index >= first as i64) {
                let bytes = {
                    let dir = app_data_dir.to_path_buf();
                    let id = capture_id.clone();
                    let index = page.page_index.max(0) as usize;
                    let mime = page.mime.clone();
                    tokio::task::spawn_blocking(move || {
                        files::read_page_blocking(&dir, &id, index, &mime)
                    })
                    .await
                    .map_err(|error| format!("read capture page task: {error}"))?
                };
                let bytes = match bytes {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        // The bytes are gone or unreadable on this terminal;
                        // that is a document problem the user must see.
                        warn!(capture_id = %capture_id, %error, "Capture page unreadable on disk");
                        let failure = StepFailure::NeedsAttention(REASON_UNREADABLE);
                        let status = {
                            let conn = lock(db)?;
                            apply_step_failure(&conn, &document, &failure)?
                        };
                        emit_status(app, &capture_id, status, Some(REASON_UNREADABLE));
                        return Ok(());
                    }
                };

                let digest = files::sha256_hex(&bytes);
                let path = page_upload_path(&document, page.page_index);
                let response = crate::admin_fetch_raw(
                    Some(db.as_ref()),
                    &path,
                    "POST",
                    OCTET_STREAM,
                    &[
                        ("x-capture-content-type", page.mime.as_str()),
                        ("x-capture-content-hash", digest.as_str()),
                    ],
                    bytes,
                )
                .await;

                match response {
                    Ok(body) => {
                        let Some(storage_key) = read_storage_key(&body) else {
                            // A 2xx without a key is a contract break, not a
                            // document fault: retry rather than blame the scan.
                            let status = {
                                let conn = lock(db)?;
                                apply_step_failure(&conn, &document, &StepFailure::Transient)?
                            };
                            emit_status(app, &capture_id, status, None);
                            return Ok(());
                        };
                        // Persisted the instant the request succeeds, so an
                        // interruption here resumes at the *next* page (D11).
                        let conn = lock(db)?;
                        store::set_page_storage_key(
                            &conn,
                            &capture_id,
                            page.page_index.max(0) as usize,
                            &storage_key,
                        )?;
                    }
                    Err(error) => {
                        let failure = classify_admin_error(&error);
                        let status = {
                            let conn = lock(db)?;
                            apply_step_failure(&conn, &document, &failure)?
                        };
                        emit_status(app, &capture_id, status, reason_of(&failure));
                        return Ok(());
                    }
                }
            }
        }
    }

    // ---- recognition ----------------------------------------------------- //
    let storage_keys = {
        let conn = lock(db)?;
        store::storage_keys(&conn, &capture_id)?
    };
    let ordered: Vec<String> = storage_keys.into_iter().flatten().collect();
    if ordered.len() < pages.len() {
        // Should not happen (the loop above only exits early on failure), but
        // fail closed onto the retry path rather than recognizing a partial
        // document as if it were the whole invoice.
        let status = {
            let conn = lock(db)?;
            apply_step_failure(&conn, &document, &StepFailure::Transient)?
        };
        emit_status(app, &capture_id, status, None);
        return Ok(());
    }

    {
        let conn = lock(db)?;
        store::set_status(&conn, &capture_id, CaptureStatus::Reading, None)?;
    }
    emit_status(app, &capture_id, CaptureStatus::Reading, None);

    let recognition = crate::admin_fetch_detailed_with_timeout(
        Some(db.as_ref()),
        OCR_PATH,
        "POST",
        Some(json!({ "storageKeys": ordered })),
        OCR_RECOGNITION_TIMEOUT,
    )
    .await;

    match recognition {
        Ok(result) => {
            let conn = lock(db)?;
            store::set_recognition_json(&conn, &capture_id, &result.to_string())?;
            store::clear_retry(&conn, &capture_id)?;
            store::set_status(&conn, &capture_id, CaptureStatus::ReadyReview, None)?;
            drop(conn);
            // The finished result surfaces here — nothing had to stay on
            // screen, and nothing was cancelled by walking away (R6.2, R11.9).
            emit_status(app, &capture_id, CaptureStatus::ReadyReview, None);
            info!(capture_id = %capture_id, "Captured invoice is ready to check");
        }
        Err(error) => {
            // A transient failure re-queues with no reason recorded anywhere
            // (DB, event, or UI) — this log line is deliberately the one place
            // the actual transport error survives. Removing it returns the
            // worker to retrying invisibly for days, which is how a torn-off
            // storage download and a too-short client timeout each hid here.
            warn!(capture_id = %capture_id, error = ?error, "Invoice recognition failed; capture will retry");
            let failure = classify_admin_error(&error);
            let status = {
                let conn = lock(db)?;
                apply_step_failure(&conn, &document, &failure)?
            };
            emit_status(app, &capture_id, status, reason_of(&failure));
        }
    }

    Ok(())
}

fn reason_of(failure: &StepFailure) -> Option<&'static str> {
    match failure {
        StepFailure::Offline | StepFailure::Transient => None,
        StepFailure::ModuleRequired(_) => Some(REASON_MODULE_REQUIRED),
        StepFailure::NeedsAttention(reason) => Some(reason),
    }
}

/// Resume every module-parked recognition whose probe is due, and report how
/// many came back onto the queue.
fn resume_due_parked(db: &Arc<db::DbState>, now: DateTime<Utc>) -> Result<usize, String> {
    let conn = lock(db)?;
    let parked = store::list_documents_by_status(&conn, &[CaptureStatus::Parked])?;
    let mut resumed = 0;
    for document in parked {
        if !is_due(&document, now) {
            continue;
        }
        if resume_parked_recognition(&conn, &document)? {
            resumed += 1;
        }
    }
    Ok(resumed)
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

/// Start the capture worker.
///
/// Registered in `lib.rs` `.setup()` with the standard `CancellationToken` and
/// its own `db::init` connection, exactly like the other background workers.
///
/// The loop runs on [`WORKER_INTERVAL_SECS`] but also wakes early on two
/// events, which is what makes a capture feel immediate rather than "up to 15
/// seconds late": a new document arriving from any source, and connectivity
/// coming back after an offline stretch.
pub fn start_capture_worker(
    app: tauri::AppHandle,
    db: Arc<db::DbState>,
    app_data_dir: PathBuf,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    let cadence = Duration::from_secs(interval_secs.max(1));
    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    {
        let tx = wake_tx.clone();
        app.listen(super::watcher::EVENT_DOCUMENT_ARRIVED, move |_event| {
            let _ = tx.send(());
        });
    }
    {
        let tx = wake_tx.clone();
        app.listen("network_status", move |event| {
            let online = serde_json::from_str::<Value>(event.payload())
                .ok()
                .and_then(|payload| payload.get("isOnline").and_then(Value::as_bool));
            // Only a transition *into* reachable is worth an early turn; the
            // cadence covers everything else.
            if online == Some(true) {
                let _ = tx.send(());
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        info!(
            interval_secs = cadence.as_secs(),
            "Invoice capture worker started"
        );

        loop {
            if cancel.is_cancelled() {
                info!("Invoice capture worker cancelled");
                break;
            }

            // Committed documents whose attachment the server confirmed are the
            // only local files this worker ever deletes (R11.8).
            {
                let db_for_cleanup = Arc::clone(&db);
                let dir = app_data_dir.clone();
                let cleaned =
                    tokio::task::spawn_blocking(move || match db_for_cleanup.conn.lock() {
                        Ok(conn) => cleanup_committed_captures(&conn, &dir),
                        Err(error) => Err(format!("capture cleanup db lock: {error}")),
                    })
                    .await;
                match cleaned {
                    Ok(Ok(ids)) if !ids.is_empty() => {
                        info!(count = ids.len(), "Cleaned up committed capture files")
                    }
                    Ok(Err(error)) => warn!(%error, "Capture cleanup failed"),
                    Err(error) => warn!(%error, "Capture cleanup task failed"),
                    _ => {}
                }
            }

            let now = Utc::now();
            match resume_due_parked(&db, now) {
                Ok(resumed) if resumed > 0 => {
                    info!(count = resumed, "Resumed parked captures — module is back")
                }
                Err(error) => warn!(%error, "Capture park probe failed"),
                _ => {}
            }

            let has_work = match lock(&db).and_then(|conn| next_actionable(&conn, now)) {
                Ok(document) => document.is_some(),
                Err(error) => {
                    warn!(%error, "Capture worker could not read its queue");
                    false
                }
            };

            // Offline documents stay `waiting` with nothing burned (R11.2), and
            // the connectivity probe is only paid for when there is work.
            let online = has_work
                && crate::sync::check_network_status()
                    .await
                    .get("isOnline")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);

            if online {
                loop {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let next = match lock(&db).and_then(|conn| next_actionable(&conn, Utc::now())) {
                        Ok(Some(document)) => document,
                        Ok(None) => break,
                        Err(error) => {
                            warn!(%error, "Capture worker could not read its queue");
                            break;
                        }
                    };
                    let capture_id = next.id.clone();
                    if let Err(error) = advance_document(&app, &db, &app_data_dir, next).await {
                        warn!(capture_id = %capture_id, %error, "Capture worker turn failed");
                        break;
                    }
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(cadence) => {}
                _ = wake_rx.recv() => {
                    // Coalesce a burst (an ADF handing over eight pages) into
                    // one turn rather than eight.
                    while wake_rx.try_recv().is_ok() {}
                }
                _ = cancel.cancelled() => {
                    info!("Invoice capture worker cancelled");
                    break;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::files;
    use crate::capture::store::NewCaptureDocument;
    use crate::capture::CaptureSourceKind;
    use crate::tests::harness::TestDb;

    const PNG: &str = "image/png";

    fn seed(db: &TestDb, id: &str, captured_at: &str, pages: usize) {
        let written: Vec<_> = (0..pages)
            .map(|index| {
                files::write_page_blocking(db.dir(), id, index, PNG, b"page-bytes")
                    .expect("write page")
            })
            .collect();
        let conn = db.state.conn.lock().expect("lock");
        store::create_document(
            &conn,
            &NewCaptureDocument {
                id: id.to_string(),
                source_kind: CaptureSourceKind::WatchedFolder,
                source_name: Some("Back office scans".to_string()),
                staff_id: Some("staff-1".to_string()),
                captured_at: captured_at.to_string(),
                content_hash: None,
            },
        )
        .expect("create document");
        for page in &written {
            store::record_page(&conn, id, page).expect("record page");
        }
        store::set_status(&conn, id, CaptureStatus::Waiting, None).expect("finish document");
    }

    fn document(db: &TestDb, id: &str) -> CaptureDocument {
        let conn = db.state.conn.lock().expect("lock");
        store::get_document(&conn, id)
            .expect("read")
            .expect("document exists")
    }

    // -- classification ---------------------------------------------------- //

    #[test]
    fn every_transport_outcome_maps_onto_the_documented_failure_policy() {
        // No status = the request never got an answer.
        assert_eq!(
            classify_admin_error(&AdminFetchError::statusless("Cannot reach admin dashboard")),
            StepFailure::Offline
        );

        for status in [500, 502, 503, 408, 429, 401, 403] {
            assert_eq!(
                classify_admin_error(&AdminFetchError::with_status("server trouble", status)),
                StepFailure::Transient,
                "HTTP {status} must retry rather than blame the document",
            );
        }

        assert_eq!(
            classify_admin_error(&AdminFetchError::with_status("too big", 413)),
            StepFailure::NeedsAttention(REASON_TOO_LARGE)
        );
        for status in [400, 415, 422] {
            assert_eq!(
                classify_admin_error(&AdminFetchError::with_status("nope", status)),
                StepFailure::NeedsAttention(REASON_UNREADABLE),
                "HTTP {status} is a typed client error the user must see",
            );
        }
    }

    #[test]
    fn a_module_denial_is_recognized_through_the_shared_uniform_contract() {
        // The exact string `api::admin_http_error_from_body` builds for the
        // admin API's uniform 403.
        let error = AdminFetchError::with_status(
            r#"MODULE_REQUIRED (HTTP 403): {"success":false,"error":"MODULE_REQUIRED","missingModules":["suppliers"]}"#,
            403,
        );
        assert_eq!(
            classify_admin_error(&error),
            StepFailure::ModuleRequired("suppliers".to_string())
        );

        // A plain 403 that is NOT the uniform contract must not be mistaken
        // for one — it retries as a credential state instead.
        let plain = AdminFetchError::with_status(
            r#"Terminal not authorized (HTTP 403): {"success":false,"error":"Forbidden"}"#,
            403,
        );
        assert_eq!(classify_admin_error(&plain), StepFailure::Transient);
    }

    #[test]
    fn backoff_grows_exponentially_and_is_capped() {
        assert_eq!(backoff_delay_secs(0), BASE_BACKOFF_SECS);
        assert_eq!(backoff_delay_secs(1), BASE_BACKOFF_SECS * 2);
        assert_eq!(backoff_delay_secs(2), BASE_BACKOFF_SECS * 4);
        assert!(backoff_delay_secs(3) < backoff_delay_secs(4));
        for attempts in [8, 20, 5_000, i64::MAX] {
            assert_eq!(
                backoff_delay_secs(attempts),
                MAX_BACKOFF_SECS,
                "backoff must never run away ({attempts} attempts)",
            );
        }
    }

    // -- failure application ------------------------------------------------ //

    #[test]
    fn offline_keeps_the_document_waiting_and_burns_nothing() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 1);
        let conn = db.state.conn.lock().expect("lock");

        let before = store::get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        store::set_status(&conn, "capture-a", CaptureStatus::Uploading, None).expect("uploading");

        let status =
            apply_step_failure(&conn, &before, &StepFailure::Offline).expect("apply offline");
        assert_eq!(status, CaptureStatus::Waiting);

        let after = store::get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        assert_eq!(after.status, CaptureStatus::Waiting);
        assert_eq!(after.attempts, 0, "being offline is not a failed attempt");
        assert!(after.next_retry_at.is_some());
        assert!(
            after.error_message.is_none(),
            "offline is not an error to show"
        );
    }

    #[test]
    fn a_module_denial_parks_on_the_slow_cadence_without_burning_an_attempt() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 1);
        let conn = db.state.conn.lock().expect("lock");
        let before = store::get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");

        let status = apply_step_failure(
            &conn,
            &before,
            &StepFailure::ModuleRequired("suppliers".to_string()),
        )
        .expect("apply park");
        assert_eq!(status, CaptureStatus::Parked);

        let after = store::get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        assert_eq!(after.status, CaptureStatus::Parked);
        assert_eq!(
            after.error_message.as_deref(),
            Some(REASON_MODULE_REQUIRED),
            "the renderer needs the code to say 'nothing is lost' in plain language",
        );
        assert_eq!(after.attempts, 0, "entitlement must not consume retries");

        // The probe rides the parity queue's module cadence, not the fast one.
        let scheduled =
            DateTime::parse_from_rfc3339(after.next_retry_at.as_deref().expect("probe scheduled"))
                .expect("rfc3339")
                .with_timezone(&Utc);
        let seconds_out = (scheduled - Utc::now()).num_seconds();
        assert!(
            (MODULE_PARK_RETRY_SECS - 60..=MODULE_PARK_RETRY_SECS + 60).contains(&seconds_out),
            "park probe must be on the ~{MODULE_PARK_RETRY_SECS}s module cadence, got {seconds_out}s",
        );
        assert_eq!(
            MODULE_PARK_RETRY_SECS,
            sync_queue::MODULE_REQUIRED_RETRY_SECS,
            "the capture park cadence must not drift from the parity queue's",
        );
    }

    #[test]
    fn a_parked_capture_resumes_by_itself_and_a_parked_commit_is_left_to_the_queue() {
        let db = TestDb::open();
        seed(&db, "capture-recognition", "2026-08-05T09:00:00Z", 1);
        seed(&db, "capture-commit", "2026-08-05T09:30:00Z", 1);
        let conn = db.state.conn.lock().expect("lock");

        store::set_status(
            &conn,
            "capture-recognition",
            CaptureStatus::Parked,
            Some(REASON_MODULE_REQUIRED),
        )
        .expect("park recognition");

        // The commit-parked document finished recognition first.
        for next in [
            CaptureStatus::Uploading,
            CaptureStatus::Reading,
            CaptureStatus::ReadyReview,
            CaptureStatus::Committing,
        ] {
            store::set_status(&conn, "capture-commit", next, None).expect("advance");
        }
        store::set_recognition_json(&conn, "capture-commit", r#"{"quality":"good"}"#)
            .expect("recognition");
        store::set_status(
            &conn,
            "capture-commit",
            CaptureStatus::Parked,
            Some(REASON_MODULE_REQUIRED),
        )
        .expect("park commit");

        let recognition = store::get_document(&conn, "capture-recognition")
            .expect("read")
            .expect("document");
        let commit = store::get_document(&conn, "capture-commit")
            .expect("read")
            .expect("document");

        assert!(resume_parked_recognition(&conn, &recognition).expect("resume recognition"));
        assert!(
            !resume_parked_recognition(&conn, &commit).expect("commit is not the worker's"),
            "a commit parked in the parity queue must not be dragged back through recognition",
        );

        assert_eq!(
            store::get_document(&conn, "capture-recognition")
                .expect("read")
                .expect("document")
                .status,
            CaptureStatus::Waiting,
        );
        assert_eq!(
            store::get_document(&conn, "capture-commit")
                .expect("read")
                .expect("document")
                .status,
            CaptureStatus::Parked,
        );

        // A parked document is never handed to the pipeline directly — it is
        // unparked first, so the pipeline only ever sees a state it can act on.
        store::set_status(
            &conn,
            "capture-recognition",
            CaptureStatus::Parked,
            Some(REASON_MODULE_REQUIRED),
        )
        .expect("re-park");
        assert!(
            next_actionable(&conn, Utc::now()).expect("pick").is_none(),
            "parked documents must not reach the upload/recognition pipeline",
        );
    }

    #[test]
    fn a_transient_failure_backs_off_and_burns_exactly_one_attempt() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 1);
        let conn = db.state.conn.lock().expect("lock");

        for expected_attempts in 1..=3 {
            let before = store::get_document(&conn, "capture-a")
                .expect("read")
                .expect("document");
            apply_step_failure(&conn, &before, &StepFailure::Transient).expect("apply transient");
            let after = store::get_document(&conn, "capture-a")
                .expect("read")
                .expect("document");
            assert_eq!(after.attempts, expected_attempts);
            assert_eq!(
                after.status,
                CaptureStatus::Waiting,
                "a flaky link must never dead-end a document",
            );
        }
    }

    #[test]
    fn a_typed_client_error_needs_attention_and_keeps_the_document_and_its_edits() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 1);
        let draft = r#"{"rows":[{"name":"Tomatoes","quantity":6}]}"#;
        let conn = db.state.conn.lock().expect("lock");
        store::set_draft_json(&conn, "capture-a", draft).expect("draft");

        let before = store::get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        let status = apply_step_failure(
            &conn,
            &before,
            &StepFailure::NeedsAttention(REASON_UNREADABLE),
        )
        .expect("apply needs attention");
        assert_eq!(status, CaptureStatus::NeedsAttention);

        let after = store::get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        assert_eq!(after.status, CaptureStatus::NeedsAttention);
        assert_eq!(after.error_message.as_deref(), Some(REASON_UNREADABLE));
        assert_eq!(
            after.draft_json.as_deref(),
            Some(draft),
            "edits survive a rejection — the user gets them back (R11.6)",
        );
        assert!(
            after.next_retry_at.is_none(),
            "the next move belongs to the user, not to an automatic retry",
        );
        assert_eq!(
            store::list_pages(&conn, "capture-a").expect("pages").len(),
            1,
            "a needs-attention document keeps its pages",
        );
    }

    // -- queue order and resumability -------------------------------------- //

    #[test]
    fn the_queue_is_drained_oldest_first_and_skips_documents_still_backing_off() {
        let db = TestDb::open();
        seed(&db, "capture-late", "2026-08-05T11:00:00Z", 1);
        seed(&db, "capture-early", "2026-08-05T09:00:00Z", 1);
        let conn = db.state.conn.lock().expect("lock");

        let now = Utc::now();
        assert_eq!(
            next_actionable(&conn, now)
                .expect("pick")
                .expect("a document is due")
                .id,
            "capture-early",
            "FIFO by capture time (R11.3)",
        );

        // Push the oldest into a backoff window; the next one takes its turn
        // rather than the whole queue stalling behind it.
        store::schedule_retry(
            &conn,
            "capture-early",
            &(now + ChronoDuration::seconds(600)).to_rfc3339(),
            true,
        )
        .expect("schedule");
        assert_eq!(
            next_actionable(&conn, now)
                .expect("pick")
                .expect("a document is due")
                .id,
            "capture-late",
        );

        // And once its window elapses it is first again.
        assert_eq!(
            next_actionable(&conn, now + ChronoDuration::seconds(900))
                .expect("pick")
                .expect("a document is due")
                .id,
            "capture-early",
        );
    }

    #[test]
    fn an_interrupted_upload_resumes_at_the_first_page_without_a_storage_key() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 4);
        let conn = db.state.conn.lock().expect("lock");

        assert_eq!(
            store::first_unuploaded_page(&conn, "capture-a").expect("first"),
            Some(0)
        );

        // Three pages made it across before the link dropped. Each key was
        // persisted the moment its request returned (D11).
        for index in 0..3 {
            store::set_page_storage_key(
                &conn,
                "capture-a",
                index,
                &format!("org/branch/captures/capture-a/page-{index:03}.png"),
            )
            .expect("persist key");
        }

        // The interruption itself: back to waiting, one attempt burned.
        let before = store::get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        apply_step_failure(&conn, &before, &StepFailure::Transient).expect("interrupt");

        assert_eq!(
            store::first_unuploaded_page(&conn, "capture-a").expect("first"),
            Some(3),
            "the next turn resends page 4 only — never the three that landed",
        );

        let keys = store::storage_keys(&conn, "capture-a").expect("keys");
        assert_eq!(keys.iter().filter(|key| key.is_some()).count(), 3);
    }

    #[test]
    fn client_side_limits_are_reported_before_a_byte_leaves_the_terminal() {
        assert_eq!(
            precheck_pages(&[]),
            Some(StepFailure::NeedsAttention(REASON_UNREADABLE)),
        );

        let page = |index: i64, byte_size: i64| store::CapturePage {
            id: format!("page-{index}"),
            capture_id: "capture-a".to_string(),
            page_index: index,
            file_path: "unused".to_string(),
            content_hash: "hash".to_string(),
            byte_size,
            mime: PNG.to_string(),
        };

        let fine: Vec<_> = (0..MAX_CAPTURE_PAGES as i64)
            .map(|i| page(i, 1_000))
            .collect();
        assert_eq!(precheck_pages(&fine), None);

        let too_many: Vec<_> = (0..MAX_CAPTURE_PAGES as i64 + 1)
            .map(|i| page(i, 1_000))
            .collect();
        assert_eq!(
            precheck_pages(&too_many),
            Some(StepFailure::NeedsAttention(REASON_TOO_MANY_PAGES)),
        );

        assert_eq!(
            precheck_pages(&[page(0, MAX_CAPTURE_PAGE_BYTES as i64 + 1)]),
            Some(StepFailure::NeedsAttention(REASON_TOO_LARGE)),
        );
    }

    #[test]
    fn the_upload_path_carries_the_metadata_that_rides_outside_the_body() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 1);
        let path = page_upload_path(&document(&db, "capture-a"), 2);

        assert!(path.starts_with(ATTACHMENTS_PATH));
        assert!(path.contains("captureId=capture-a"));
        assert!(path.contains("pageIndex=2"));
        assert!(path.contains("kind=page"));
        assert!(path.contains("sourceKind=watched_folder"));
        assert!(path.contains("sourceName=Back%20office%20scans"));
        // The path is handed to the same `/api/pos` allowlist `admin_fetch`
        // uses, so it must survive it (R17.4).
        crate::validate_admin_api_path(&path).expect("upload path must pass the POS allowlist");
    }

    #[test]
    fn free_text_source_names_can_never_smuggle_a_path_into_the_query() {
        assert_eq!(encode_query_value("../../etc"), "etc");
        assert_eq!(encode_query_value("Front desk"), "Front%20desk");
        assert_eq!(encode_query_value("scans\\\\share"), "scansshare");
        assert!(encode_query_value(&"x".repeat(500)).len() <= 60);
    }

    // -- commit confirmation and local cleanup (R11.8) ---------------------- //

    fn commit_result(attachment_url: Option<&str>, pending: bool) -> Value {
        json!({
            "success": true,
            "supplierId": "supplier-1",
            "supplierInvoiceId": "invoice-1",
            "createdInvoice": true,
            "captureId": "capture-a",
            "attachmentUrl": attachment_url,
            "attachmentPending": pending,
        })
    }

    #[test]
    fn only_an_invoice_with_its_attachment_counts_as_confirmed() {
        assert!(commit_is_confirmed_with_attachment(&commit_result(
            Some("org/branch/invoice-1/scan-capture-a.pdf"),
            false
        )));

        // No attachment yet, or the server still owes the assembly: the local
        // copy is the only copy, so it stays.
        assert!(!commit_is_confirmed_with_attachment(&commit_result(
            None, false
        )));
        assert!(!commit_is_confirmed_with_attachment(&commit_result(
            Some("  "),
            false
        )));
        assert!(!commit_is_confirmed_with_attachment(&commit_result(
            Some("org/branch/invoice-1/scan-capture-a.pdf"),
            true
        )));

        let mut without_invoice = commit_result(Some("key.pdf"), false);
        without_invoice["supplierInvoiceId"] = Value::Null;
        assert!(!commit_is_confirmed_with_attachment(&without_invoice));
    }

    #[test]
    fn cleanup_removes_the_local_copy_only_after_the_server_confirmed_the_attachment() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 2);
        let conn = db.state.conn.lock().expect("lock");

        for next in [
            CaptureStatus::Uploading,
            CaptureStatus::Reading,
            CaptureStatus::ReadyReview,
            CaptureStatus::Committing,
        ] {
            store::set_status(&conn, "capture-a", next, None).expect("advance");
        }

        // Committed, but the server is still assembling the PDF.
        confirm_commit(
            &conn,
            "capture-a",
            &commit_result(None, true),
            Some("staff-9"),
        )
        .expect("confirm pending commit");
        assert!(cleanup_committed_captures(&conn, db.dir())
            .expect("cleanup")
            .is_empty());
        assert_eq!(
            store::list_pages(&conn, "capture-a").expect("pages").len(),
            2,
        );
        assert!(
            files::page_path(db.dir(), "capture-a", 0, PNG)
                .expect("page path")
                .exists(),
            "an attachment-pending invoice keeps its only copy",
        );

        // The sweep finished; now the attachment really exists server-side.
        confirm_commit(
            &conn,
            "capture-a",
            &commit_result(Some("org/branch/invoice-1/scan-capture-a.pdf"), false),
            Some("staff-9"),
        )
        .expect("confirm assembled commit");
        assert_eq!(
            cleanup_committed_captures(&conn, db.dir()).expect("cleanup"),
            vec!["capture-a".to_string()],
        );
        assert!(!files::page_path(db.dir(), "capture-a", 0, PNG)
            .expect("page path")
            .exists());

        // The history says what happened to the bytes.
        assert!(store::list_events(&conn, "capture-a")
            .expect("events")
            .iter()
            .any(|event| event.event_type == EVENT_LOCAL_FILES_CLEANED));
    }

    #[test]
    fn cleanup_never_touches_a_document_that_is_not_committed() {
        let db = TestDb::open();
        let uncommitted = [
            ("capture-waiting", CaptureStatus::Waiting),
            ("capture-review", CaptureStatus::ReadyReview),
            ("capture-attention", CaptureStatus::NeedsAttention),
            ("capture-parked", CaptureStatus::Parked),
        ];
        for (id, _) in uncommitted {
            seed(&db, id, "2026-08-05T09:00:00Z", 1);
        }

        let conn = db.state.conn.lock().expect("lock");
        store::set_status(&conn, "capture-review", CaptureStatus::Uploading, None).expect("step");
        store::set_status(&conn, "capture-review", CaptureStatus::Reading, None).expect("step");
        store::set_status(&conn, "capture-review", CaptureStatus::ReadyReview, None).expect("step");
        store::set_status(
            &conn,
            "capture-attention",
            CaptureStatus::NeedsAttention,
            Some(REASON_UNREADABLE),
        )
        .expect("step");
        store::set_status(
            &conn,
            "capture-parked",
            CaptureStatus::Parked,
            Some(REASON_MODULE_REQUIRED),
        )
        .expect("step");

        // Even with a commit result forged onto every one of them, cleanup
        // refuses: the status gate comes first.
        for (id, _) in uncommitted {
            store::record_event(
                &conn,
                Some(id),
                EVENT_COMMIT_CONFIRMED,
                None,
                Some(&commit_result(Some("key.pdf"), false)),
            )
            .expect("forge a confirmation");
        }

        assert!(cleanup_committed_captures(&conn, db.dir())
            .expect("cleanup")
            .is_empty());
        for (id, expected) in uncommitted {
            let document = store::get_document(&conn, id)
                .expect("read")
                .expect("document");
            assert_eq!(document.status, expected);
            assert!(
                files::page_path(db.dir(), id, 0, PNG)
                    .expect("page path")
                    .exists(),
                "{id} is not committed — its bytes are untouchable (R11.8)",
            );
        }
    }

    #[test]
    fn a_committed_document_without_a_server_result_keeps_its_local_copy() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 1);
        let conn = db.state.conn.lock().expect("lock");
        for next in [
            CaptureStatus::Uploading,
            CaptureStatus::Reading,
            CaptureStatus::ReadyReview,
            CaptureStatus::Committing,
            CaptureStatus::Committed,
        ] {
            store::set_status(&conn, "capture-a", next, None).expect("advance");
        }

        assert!(committed_result(&conn, "capture-a")
            .expect("read")
            .is_none());
        assert!(cleanup_committed_captures(&conn, db.dir())
            .expect("cleanup")
            .is_empty());
        assert!(files::page_path(db.dir(), "capture-a", 0, PNG)
            .expect("page path")
            .exists());
    }

    #[test]
    fn the_stored_commit_result_is_the_servers_words_verbatim() {
        let db = TestDb::open();
        seed(&db, "capture-a", "2026-08-05T09:00:00Z", 1);
        let conn = db.state.conn.lock().expect("lock");
        for next in [
            CaptureStatus::Uploading,
            CaptureStatus::Reading,
            CaptureStatus::ReadyReview,
            CaptureStatus::Committing,
        ] {
            store::set_status(&conn, "capture-a", next, None).expect("advance");
        }

        let result = commit_result(Some("org/branch/invoice-1/scan-capture-a.pdf"), false);
        confirm_commit(&conn, "capture-a", &result, Some("staff-9")).expect("confirm");

        assert_eq!(
            store::get_document(&conn, "capture-a")
                .expect("read")
                .expect("document")
                .status,
            CaptureStatus::Committed,
        );
        assert_eq!(
            committed_result(&conn, "capture-a").expect("read"),
            Some(result),
        );

        let event = store::list_events(&conn, "capture-a")
            .expect("events")
            .into_iter()
            .find(|event| event.event_type == EVENT_COMMIT_CONFIRMED)
            .expect("the confirmation is in the history");
        assert_eq!(event.staff_id.as_deref(), Some("staff-9"));
    }
}
