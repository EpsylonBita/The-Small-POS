//! Durable capture store over the v72 tables in `pos.db`.
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
//! **D-Rust1**. Requirements R8.6, R11.1, R11.3, R11.6, R13.4, R17.3.
//!
//! Everything a captured document needs to survive a crash lives here:
//! the document row and its lifecycle status, the page files' index and
//! digests, the review edits (`draft_json`), the per-page storage keys that
//! make an interrupted upload resumable, the watched-folder ingest ledger, and
//! the local event history the queue view renders.
//!
//! Two invariants are enforced at this boundary rather than trusted to callers:
//!
//! 1. **Lifecycle validity.** [`set_status`] refuses any move the design's
//!    state machine does not allow ([`CaptureStatus::can_transition_to`]), so a
//!    worker bug cannot strand a document in a state no screen can render.
//!    Terminal states never move again.
//!
//! 2. **File-first ordering.** [`record_page`] only accepts a
//!    [`WrittenPage`] — the receipt [`files::write_page_blocking`] issues — and
//!    re-checks that the file is still on disk. A page row can therefore never
//!    exist for bytes that were not durably written first, which is the local
//!    half of "durable before any network activity" (R11.1).

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::files::{self, WrittenPage};
use super::{CaptureIngestOutcome, CaptureSourceKind, CaptureStatus, MAX_CAPTURE_PAGES};

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A capture id becomes a directory name, so it is held to the path-segment
/// charset at every boundary it crosses — including this one, so a hostile id
/// can never be persisted and later replayed into a file path by a worker that
/// trusted the database.
fn assert_capture_id(capture_id: &str) -> Result<(), String> {
    files::sanitize_path_segment("capture_id", capture_id)
}

/// The document a capture source is about to start filling with pages.
#[derive(Clone, Debug)]
pub struct NewCaptureDocument {
    pub id: String,
    pub source_kind: CaptureSourceKind,
    pub source_name: Option<String>,
    pub staff_id: Option<String>,
    /// ISO 8601, captured at capture time — the FIFO key the worker drains by.
    pub captured_at: String,
    /// Whole-document hash, set by the watched-folder source for dedupe.
    pub content_hash: Option<String>,
}

/// A captured document as stored.
#[derive(Clone, Debug)]
pub struct CaptureDocument {
    pub id: String,
    pub status: CaptureStatus,
    pub source_kind: String,
    pub source_name: Option<String>,
    pub staff_id: Option<String>,
    pub captured_at: String,
    pub page_count: i64,
    pub content_hash: Option<String>,
    /// Raw `SupplierImportOcrResponse` JSON once recognition returned.
    pub recognition_json: Option<String>,
    /// Review edits, so leaving and returning (or restarting) loses nothing.
    pub draft_json: Option<String>,
    /// Sparse, page-indexed server storage keys — `None` means "not uploaded
    /// yet", which is what lets an interrupted upload resume at the first
    /// unuploaded page instead of resending the whole document.
    pub storage_keys: Vec<Option<String>>,
    /// Stable reason code; the renderer maps it to plain language.
    pub error_message: Option<String>,
    pub next_retry_at: Option<String>,
    pub attempts: i64,
    pub updated_at: String,
}

/// One page file on disk.
#[derive(Clone, Debug)]
pub struct CapturePage {
    pub id: String,
    pub capture_id: String,
    pub page_index: i64,
    pub file_path: String,
    pub content_hash: String,
    pub byte_size: i64,
    pub mime: String,
}

/// One local history entry.
#[derive(Clone, Debug)]
pub struct CaptureEvent {
    pub id: String,
    pub capture_id: Option<String>,
    pub event_type: String,
    pub staff_id: Option<String>,
    pub details_json: Option<String>,
    pub created_at: String,
}

/// What the watched folder decided about one file it saw.
#[derive(Clone, Debug)]
pub struct IngestLedgerEntry {
    pub content_hash: String,
    pub source_path: Option<String>,
    pub capture_id: Option<String>,
    pub outcome: CaptureIngestOutcome,
    pub seen_at: String,
}

fn parse_storage_keys(raw: Option<String>) -> Vec<Option<String>> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(items)) => items
            .into_iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect(),
        // A corrupt blob must not hide the document: treat it as "nothing
        // uploaded yet" and let the worker re-upload rather than fail closed
        // on a value that is only an optimization.
        _ => Vec::new(),
    }
}

fn document_from_row(row: &Row<'_>) -> rusqlite::Result<CaptureDocument> {
    let status_text: String = row.get("status")?;
    let storage_keys_json: Option<String> = row.get("storage_keys_json")?;
    Ok(CaptureDocument {
        id: row.get("id")?,
        // An unknown status cannot come from the CHECK-constrained column, but
        // a repaired database could still surprise us — surface it as
        // `needs_attention` so the document stays visible and actionable
        // rather than disappearing from every query.
        status: CaptureStatus::parse(&status_text).unwrap_or(CaptureStatus::NeedsAttention),
        source_kind: row.get("source_kind")?,
        source_name: row.get("source_name")?,
        staff_id: row.get("staff_id")?,
        captured_at: row.get("captured_at")?,
        page_count: row.get("page_count")?,
        content_hash: row.get("content_hash")?,
        recognition_json: row.get("recognition_json")?,
        draft_json: row.get("draft_json")?,
        storage_keys: parse_storage_keys(storage_keys_json),
        error_message: row.get("error_message")?,
        next_retry_at: row.get("next_retry_at")?,
        attempts: row.get("attempts")?,
        updated_at: row.get("updated_at")?,
    })
}

const DOCUMENT_COLUMNS: &str = "id, status, source_kind, source_name, staff_id, captured_at, \
     page_count, content_hash, recognition_json, draft_json, storage_keys_json, \
     error_message, next_retry_at, attempts, updated_at";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// Create a document in `capturing` — pages accumulating, nothing uploaded.
pub fn create_document(conn: &Connection, document: &NewCaptureDocument) -> Result<(), String> {
    assert_capture_id(&document.id)?;
    if document.captured_at.trim().is_empty() {
        return Err("captured_at is required".into());
    }

    let now = now_iso();
    conn.execute(
        "INSERT INTO capture_documents (
             id, status, source_kind, source_name, staff_id, captured_at,
             page_count, content_hash, attempts, updated_at
         ) VALUES (?1, 'capturing', ?2, ?3, ?4, ?5, 0, ?6, 0, ?7)",
        params![
            document.id,
            document.source_kind.as_str(),
            document.source_name,
            document.staff_id,
            document.captured_at,
            document.content_hash,
            now,
        ],
    )
    .map_err(|e| format!("create capture document: {e}"))?;

    record_event(
        conn,
        Some(&document.id),
        "captured",
        document.staff_id.as_deref(),
        Some(&serde_json::json!({
            "source_kind": document.source_kind.as_str(),
            "source_name": document.source_name,
        })),
    )?;

    Ok(())
}

pub fn get_document(conn: &Connection, id: &str) -> Result<Option<CaptureDocument>, String> {
    conn.query_row(
        &format!("SELECT {DOCUMENT_COLUMNS} FROM capture_documents WHERE id = ?1"),
        params![id],
        document_from_row,
    )
    .optional()
    .map_err(|e| format!("read capture document: {e}"))
}

/// Documents in any of `statuses`, oldest capture first (R11.3 FIFO).
pub fn list_documents_by_status(
    conn: &Connection,
    statuses: &[CaptureStatus],
) -> Result<Vec<CaptureDocument>, String> {
    if statuses.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = statuses
        .iter()
        .enumerate()
        .map(|(index, _)| format!("?{}", index + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {DOCUMENT_COLUMNS} FROM capture_documents
         WHERE status IN ({placeholders})
         ORDER BY captured_at ASC, id ASC"
    );

    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare capture document list: {e}"))?;
    let values: Vec<&str> = statuses.iter().map(|status| status.as_str()).collect();
    let rows = statement
        .query_map(rusqlite::params_from_iter(values), document_from_row)
        .map_err(|e| format!("query capture documents: {e}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read capture documents: {e}"))
}

/// Every document still owing the user or the worker something — the capture
/// queue, and the count behind the suppliers badge (R11.4, R11.5).
pub fn list_open_documents(conn: &Connection) -> Result<Vec<CaptureDocument>, String> {
    let open: Vec<CaptureStatus> = CaptureStatus::ALL
        .into_iter()
        .filter(|status| status.is_open())
        .collect();
    list_documents_by_status(conn, &open)
}

/// Move a document to `next`, refusing anything the state machine forbids.
///
/// `reason` is a stable code stored in `error_message`; the renderer maps it to
/// plain language. Passing `None` clears any previous reason, so a document
/// that retried successfully does not keep showing a stale failure.
///
/// Every accepted move is recorded in `capture_events`, which is what makes the
/// queue history (including discards, R13.4) reconstructable after a restart.
pub fn set_status(
    conn: &Connection,
    id: &str,
    next: CaptureStatus,
    reason: Option<&str>,
) -> Result<(), String> {
    let current = get_document(conn, id)?
        .ok_or_else(|| format!("Capture {id} not found"))?
        .status;

    if !current.can_transition_to(next) {
        return Err(format!(
            "Invalid capture transition {} -> {}",
            current.as_str(),
            next.as_str()
        ));
    }

    conn.execute(
        "UPDATE capture_documents
         SET status = ?2, error_message = ?3, updated_at = ?4
         WHERE id = ?1",
        params![id, next.as_str(), reason, now_iso()],
    )
    .map_err(|e| format!("update capture status: {e}"))?;

    // A no-op re-assert is legal but not history worth recording.
    if current != next {
        record_event(
            conn,
            Some(id),
            "status_changed",
            None,
            Some(&serde_json::json!({
                "from": current.as_str(),
                "to": next.as_str(),
                "reason": reason,
            })),
        )?;
    }

    Ok(())
}

/// Schedule the next automatic attempt.
///
/// `burn_attempt` is false while the terminal is offline or the module is
/// parked: those are not failures and must not consume the retry budget
/// (R11.2, R11.7).
pub fn schedule_retry(
    conn: &Connection,
    id: &str,
    next_retry_at: &str,
    burn_attempt: bool,
) -> Result<(), String> {
    let attempt_delta = i64::from(burn_attempt);
    conn.execute(
        "UPDATE capture_documents
         SET next_retry_at = ?2, attempts = attempts + ?3, updated_at = ?4
         WHERE id = ?1",
        params![id, next_retry_at, attempt_delta, now_iso()],
    )
    .map_err(|e| format!("schedule capture retry: {e}"))?;
    Ok(())
}

/// Clear the backoff after a successful step.
pub fn clear_retry(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE capture_documents
         SET next_retry_at = NULL, attempts = 0, updated_at = ?2
         WHERE id = ?1",
        params![id, now_iso()],
    )
    .map_err(|e| format!("clear capture retry: {e}"))?;
    Ok(())
}

/// Store the recognition result verbatim.
pub fn set_recognition_json(conn: &Connection, id: &str, recognition: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE capture_documents SET recognition_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, recognition, now_iso()],
    )
    .map_err(|e| format!("store capture recognition: {e}"))?;
    Ok(())
}

/// Persist review edits (R8.6, R17.3) — called when the user leaves review,
/// so returning later, or after a restart, resumes exactly where they were.
pub fn set_draft_json(conn: &Connection, id: &str, draft: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE capture_documents SET draft_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, draft, now_iso()],
    )
    .map_err(|e| format!("store capture draft: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/// Record a page that is already durably on disk.
///
/// Taking a [`WrittenPage`] rather than loose fields is deliberate: the only
/// way to obtain one is to have completed a durable write, so this signature
/// is the file-first ordering rule expressed in the type system. The existence
/// re-check catches the remaining case — a receipt kept across a crash that
/// wiped the file.
///
/// Upserts on `(capture_id, page_index)`, so re-scanning page N replaces it in
/// place exactly as the file write does.
pub fn record_page(conn: &Connection, capture_id: &str, page: &WrittenPage) -> Result<(), String> {
    assert_capture_id(capture_id)?;

    let document =
        get_document(conn, capture_id)?.ok_or_else(|| format!("Capture {capture_id} not found"))?;
    if document.status.is_terminal() {
        return Err(format!(
            "Capture {capture_id} is {} and accepts no more pages",
            document.status.as_str()
        ));
    }
    if page.page_index >= MAX_CAPTURE_PAGES {
        return Err(format!("A capture holds at most {MAX_CAPTURE_PAGES} pages"));
    }
    if !page.file_path.exists() {
        return Err("Capture page must be written to disk before it is recorded".into());
    }

    conn.execute(
        "INSERT INTO capture_pages (
             id, capture_id, page_index, file_path, content_hash, byte_size, mime
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (capture_id, page_index) DO UPDATE SET
             file_path = excluded.file_path,
             content_hash = excluded.content_hash,
             byte_size = excluded.byte_size,
             mime = excluded.mime",
        params![
            new_id(),
            capture_id,
            page.page_index as i64,
            page.file_path.to_string_lossy().to_string(),
            page.content_hash,
            page.byte_size as i64,
            page.mime,
        ],
    )
    .map_err(|e| format!("record capture page: {e}"))?;

    sync_page_count(conn, capture_id)?;
    record_event(
        conn,
        Some(capture_id),
        "page_added",
        None,
        Some(&serde_json::json!({
            "page_index": page.page_index,
            "byte_size": page.byte_size,
            "mime": page.mime,
        })),
    )?;

    Ok(())
}

/// Pages in document order.
pub fn list_pages(conn: &Connection, capture_id: &str) -> Result<Vec<CapturePage>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, capture_id, page_index, file_path, content_hash, byte_size, mime
             FROM capture_pages WHERE capture_id = ?1 ORDER BY page_index ASC",
        )
        .map_err(|e| format!("prepare capture page list: {e}"))?;

    let rows = statement
        .query_map(params![capture_id], |row| {
            Ok(CapturePage {
                id: row.get(0)?,
                capture_id: row.get(1)?,
                page_index: row.get(2)?,
                file_path: row.get(3)?,
                content_hash: row.get(4)?,
                byte_size: row.get(5)?,
                mime: row.get(6)?,
            })
        })
        .map_err(|e| format!("query capture pages: {e}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read capture pages: {e}"))
}

/// Drop one page from a document that has not been finished yet.
pub fn delete_page(conn: &Connection, capture_id: &str, page_index: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM capture_pages WHERE capture_id = ?1 AND page_index = ?2",
        params![capture_id, page_index],
    )
    .map_err(|e| format!("delete capture page: {e}"))?;

    sync_page_count(conn, capture_id)?;
    record_event(
        conn,
        Some(capture_id),
        "page_removed",
        None,
        Some(&serde_json::json!({ "page_index": page_index })),
    )
}

fn sync_page_count(conn: &Connection, capture_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE capture_documents
         SET page_count = (SELECT COUNT(*) FROM capture_pages WHERE capture_id = ?1),
             updated_at = ?2
         WHERE id = ?1",
        params![capture_id, now_iso()],
    )
    .map_err(|e| format!("sync capture page count: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Upload resumability
// ---------------------------------------------------------------------------

/// Server storage keys by page index; `None` where the page has not uploaded.
pub fn storage_keys(conn: &Connection, capture_id: &str) -> Result<Vec<Option<String>>, String> {
    Ok(get_document(conn, capture_id)?
        .map(|document| document.storage_keys)
        .unwrap_or_default())
}

/// Persist one page's storage key the moment its upload succeeds.
///
/// Written per page rather than per document on purpose (D11): an upload
/// interrupted after page 3 of 7 resumes at page 4 instead of resending
/// everything over a link that already proved flaky.
pub fn set_page_storage_key(
    conn: &Connection,
    capture_id: &str,
    page_index: usize,
    storage_key: &str,
) -> Result<(), String> {
    if page_index >= MAX_CAPTURE_PAGES {
        return Err(format!("A capture holds at most {MAX_CAPTURE_PAGES} pages"));
    }

    let mut keys = storage_keys(conn, capture_id)?;
    if keys.len() <= page_index {
        keys.resize(page_index + 1, None);
    }
    keys[page_index] = Some(storage_key.to_string());

    let encoded =
        serde_json::to_string(&keys).map_err(|e| format!("encode capture storage keys: {e}"))?;
    conn.execute(
        "UPDATE capture_documents SET storage_keys_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![capture_id, encoded, now_iso()],
    )
    .map_err(|e| format!("store capture storage keys: {e}"))?;

    Ok(())
}

/// Index of the first page still to upload, or `None` when all `page_count`
/// pages already have a key.
pub fn first_unuploaded_page(conn: &Connection, capture_id: &str) -> Result<Option<usize>, String> {
    let Some(document) = get_document(conn, capture_id)? else {
        return Ok(None);
    };
    let total = document.page_count.max(0) as usize;
    for index in 0..total {
        match document.storage_keys.get(index) {
            Some(Some(_)) => continue,
            _ => return Ok(Some(index)),
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Watched-folder ingest ledger
// ---------------------------------------------------------------------------

/// What this terminal already decided about a file with this content hash.
pub fn ledger_entry(
    conn: &Connection,
    content_hash: &str,
) -> Result<Option<IngestLedgerEntry>, String> {
    conn.query_row(
        "SELECT content_hash, source_path, capture_id, outcome, seen_at
         FROM capture_ingest_ledger WHERE content_hash = ?1",
        params![content_hash],
        |row| {
            let outcome: String = row.get(3)?;
            Ok(IngestLedgerEntry {
                content_hash: row.get(0)?,
                source_path: row.get(1)?,
                capture_id: row.get(2)?,
                outcome: CaptureIngestOutcome::parse(&outcome)
                    .unwrap_or(CaptureIngestOutcome::SkippedUnsupported),
                seen_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("read capture ingest ledger: {e}"))
}

/// Record an ingest decision, once per content hash.
///
/// `INSERT OR IGNORE` is the "once per hash" rule (R3.5): a folder full of the
/// same unsupported file produces one history entry, not one per sweep.
/// Returns `true` when this call was the first sighting.
pub fn record_ingest(conn: &Connection, entry: &IngestLedgerEntry) -> Result<bool, String> {
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO capture_ingest_ledger (
                 content_hash, source_path, capture_id, outcome, seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                entry.content_hash,
                entry.source_path,
                entry.capture_id,
                entry.outcome.as_str(),
                entry.seen_at,
            ],
        )
        .map_err(|e| format!("record capture ingest: {e}"))?;
    Ok(inserted > 0)
}

// ---------------------------------------------------------------------------
// Local history
// ---------------------------------------------------------------------------

/// Append one history entry (R13.4).
pub fn record_event(
    conn: &Connection,
    capture_id: Option<&str>,
    event_type: &str,
    staff_id: Option<&str>,
    details: Option<&Value>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO capture_events (id, capture_id, event_type, staff_id, details_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            new_id(),
            capture_id,
            event_type,
            staff_id,
            details.map(|value| value.to_string()),
            now_iso(),
        ],
    )
    .map_err(|e| format!("record capture event: {e}"))?;
    Ok(())
}

/// The terminal's most recent history entries across every document, newest
/// first (R13.4).
///
/// The queue view's history section reads this: it is the "what happened here
/// lately" list, including the discards R13.4 requires to stay visible.
pub fn list_recent_events(conn: &Connection, limit: i64) -> Result<Vec<CaptureEvent>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, capture_id, event_type, staff_id, details_json, created_at
             FROM capture_events
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("prepare capture history: {e}"))?;

    let rows = statement
        .query_map(params![limit.max(1)], |row| {
            Ok(CaptureEvent {
                id: row.get(0)?,
                capture_id: row.get(1)?,
                event_type: row.get(2)?,
                staff_id: row.get(3)?,
                details_json: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("query capture history: {e}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read capture history: {e}"))
}

/// The terminal's most recent watched-folder ingest decisions, newest first.
///
/// This is what makes a skip *visible* rather than silent (R3.4, R3.5): a
/// duplicate or unsupported file the watcher declined is a row here, and the
/// queue view's history section renders it in plain language.
pub fn list_recent_ingest(conn: &Connection, limit: i64) -> Result<Vec<IngestLedgerEntry>, String> {
    let mut statement = conn
        .prepare(
            "SELECT content_hash, source_path, capture_id, outcome, seen_at
             FROM capture_ingest_ledger
             ORDER BY seen_at DESC, rowid DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("prepare capture ingest history: {e}"))?;

    let rows = statement
        .query_map(params![limit.max(1)], |row| {
            let outcome: String = row.get(3)?;
            Ok(IngestLedgerEntry {
                content_hash: row.get(0)?,
                source_path: row.get(1)?,
                capture_id: row.get(2)?,
                outcome: CaptureIngestOutcome::parse(&outcome)
                    .unwrap_or(CaptureIngestOutcome::SkippedUnsupported),
                seen_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("query capture ingest history: {e}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read capture ingest history: {e}"))
}

/// Rewrite a not-yet-finished document's page order.
///
/// `order` lists the *current* page indexes in the order the user wants them.
/// Rows are renumbered in one transaction through a temporary negative index
/// space, because `(capture_id, page_index)` is unique and a naive in-place
/// renumber would collide halfway through.
///
/// Deliberately touches only the database: the page *files* keep their original
/// names, and every consumer already reads a page through its row's `file_path`
/// rather than reconstructing a name from its index. Reordering therefore moves
/// no bytes and cannot lose a page — the worst case is a page whose file name
/// no longer matches its position, which nothing reads.
pub fn reorder_pages(conn: &Connection, capture_id: &str, order: &[i64]) -> Result<(), String> {
    assert_capture_id(capture_id)?;

    let document =
        get_document(conn, capture_id)?.ok_or_else(|| format!("Capture {capture_id} not found"))?;
    if document.status.is_terminal() {
        return Err(format!(
            "Capture {capture_id} is {} and its pages cannot be reordered",
            document.status.as_str()
        ));
    }

    let existing: Vec<i64> = list_pages(conn, capture_id)?
        .into_iter()
        .map(|page| page.page_index)
        .collect();

    // The new order must be a permutation of exactly the pages that exist —
    // anything else would silently drop or duplicate a captured page.
    let mut sorted_request = order.to_vec();
    sorted_request.sort_unstable();
    let mut sorted_existing = existing.clone();
    sorted_existing.sort_unstable();
    if sorted_request != sorted_existing {
        return Err("Page order must list every existing page exactly once".into());
    }

    // Park every row in a negative index first so the final assignment can
    // never collide with a row that has not moved yet.
    for (offset, current) in order.iter().enumerate() {
        conn.execute(
            "UPDATE capture_pages SET page_index = ?3 WHERE capture_id = ?1 AND page_index = ?2",
            params![capture_id, current, -(offset as i64) - 1],
        )
        .map_err(|e| format!("stage capture page order: {e}"))?;
    }
    for offset in 0..order.len() {
        conn.execute(
            "UPDATE capture_pages SET page_index = ?3 WHERE capture_id = ?1 AND page_index = ?2",
            params![capture_id, -(offset as i64) - 1, offset as i64],
        )
        .map_err(|e| format!("apply capture page order: {e}"))?;
    }

    record_event(
        conn,
        Some(capture_id),
        "pages_reordered",
        None,
        Some(&serde_json::json!({ "order": order })),
    )
}

/// Renumber a document's pages to close the gap a removal left.
///
/// Called straight after [`delete_page`] so page indexes stay `0..n-1` — the
/// contiguity the uploader's resume logic and the server's `page-NNN` keys both
/// assume.
pub fn compact_page_indexes(conn: &Connection, capture_id: &str) -> Result<(), String> {
    assert_capture_id(capture_id)?;

    let existing: Vec<i64> = list_pages(conn, capture_id)?
        .into_iter()
        .map(|page| page.page_index)
        .collect();
    if existing
        .iter()
        .enumerate()
        .all(|(position, index)| *index == position as i64)
    {
        return Ok(());
    }

    for (offset, current) in existing.iter().enumerate() {
        conn.execute(
            "UPDATE capture_pages SET page_index = ?3 WHERE capture_id = ?1 AND page_index = ?2",
            params![capture_id, current, -(offset as i64) - 1],
        )
        .map_err(|e| format!("stage capture page compaction: {e}"))?;
    }
    for offset in 0..existing.len() {
        conn.execute(
            "UPDATE capture_pages SET page_index = ?3 WHERE capture_id = ?1 AND page_index = ?2",
            params![capture_id, -(offset as i64) - 1, offset as i64],
        )
        .map_err(|e| format!("apply capture page compaction: {e}"))?;
    }

    Ok(())
}

/// One document's history, oldest first.
pub fn list_events(conn: &Connection, capture_id: &str) -> Result<Vec<CaptureEvent>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, capture_id, event_type, staff_id, details_json, created_at
             FROM capture_events WHERE capture_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )
        .map_err(|e| format!("prepare capture event list: {e}"))?;

    let rows = statement
        .query_map(params![capture_id], |row| {
            Ok(CaptureEvent {
                id: row.get(0)?,
                capture_id: row.get(1)?,
                event_type: row.get(2)?,
                staff_id: row.get(3)?,
                details_json: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("query capture events: {e}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("read capture events: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::harness::TestDb;

    const PNG: &str = "image/png";

    fn new_document(id: &str, captured_at: &str) -> NewCaptureDocument {
        NewCaptureDocument {
            id: id.to_string(),
            source_kind: CaptureSourceKind::ConnectedScanner,
            source_name: Some("Front desk scanner".to_string()),
            staff_id: Some("staff-1".to_string()),
            captured_at: captured_at.to_string(),
            content_hash: None,
        }
    }

    /// Create a document plus one durably-written page, the way every capture
    /// source does: bytes to disk first, row second.
    fn seed_capture(db: &TestDb, id: &str, captured_at: &str) -> WrittenPage {
        let page =
            files::write_page_blocking(db.dir(), id, 0, PNG, b"page-bytes").expect("write page");
        let conn = db.state.conn.lock().expect("lock");
        create_document(&conn, &new_document(id, captured_at)).expect("create document");
        record_page(&conn, id, &page).expect("record page");
        page
    }

    #[test]
    fn a_captured_document_starts_capturing_with_its_pages_indexed() {
        let db = TestDb::open();
        let page = seed_capture(&db, "capture-a", "2026-08-05T09:00:00Z");

        let conn = db.state.conn.lock().expect("lock");
        let document = get_document(&conn, "capture-a")
            .expect("read")
            .expect("document exists");

        assert_eq!(document.status, CaptureStatus::Capturing);
        assert_eq!(document.source_kind, "connected_scanner");
        assert_eq!(document.page_count, 1);
        assert_eq!(document.attempts, 0);

        let pages = list_pages(&conn, "capture-a").expect("pages");
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].page_index, 0);
        assert_eq!(pages[0].content_hash, page.content_hash);
        assert_eq!(pages[0].byte_size, page.byte_size as i64);
    }

    #[test]
    fn a_page_row_can_never_exist_before_its_bytes_do() {
        let db = TestDb::open();
        let page = files::write_page_blocking(db.dir(), "capture-a", 0, PNG, b"page-bytes")
            .expect("write page");
        let conn = db.state.conn.lock().expect("lock");
        create_document(&conn, &new_document("capture-a", "2026-08-05T09:00:00Z"))
            .expect("create document");

        // Simulate the receipt outliving the file (crash between write and
        // record, disk wiped): recording must refuse rather than register a
        // page the uploader would later fail to read.
        std::fs::remove_file(&page.file_path).expect("remove page file");
        let error = record_page(&conn, "capture-a", &page).expect_err("must refuse");
        assert!(
            error.contains("written to disk"),
            "unexpected error: {error}"
        );
        assert!(list_pages(&conn, "capture-a").expect("pages").is_empty());

        // Once the bytes are really there, the same receipt is accepted.
        let page = files::write_page_blocking(db.dir(), "capture-a", 0, PNG, b"page-bytes")
            .expect("rewrite page");
        record_page(&conn, "capture-a", &page).expect("record page");
        assert_eq!(list_pages(&conn, "capture-a").expect("pages").len(), 1);
    }

    #[test]
    fn re_scanning_a_page_replaces_the_row_and_keeps_the_page_count_true() {
        let db = TestDb::open();
        seed_capture(&db, "capture-a", "2026-08-05T09:00:00Z");

        let second = files::write_page_blocking(db.dir(), "capture-a", 1, PNG, b"page-two")
            .expect("write page 2");
        let replacement =
            files::write_page_blocking(db.dir(), "capture-a", 0, PNG, b"page-one-again")
                .expect("re-scan page 1");

        let conn = db.state.conn.lock().expect("lock");
        record_page(&conn, "capture-a", &second).expect("record page 2");
        record_page(&conn, "capture-a", &replacement).expect("record re-scan");

        let pages = list_pages(&conn, "capture-a").expect("pages");
        assert_eq!(pages.len(), 2, "a re-scan replaces, never appends");
        assert_eq!(pages[0].content_hash, replacement.content_hash);
        assert_eq!(
            get_document(&conn, "capture-a")
                .expect("read")
                .expect("document")
                .page_count,
            2
        );

        delete_page(&conn, "capture-a", 1).expect("remove page 2");
        assert_eq!(
            get_document(&conn, "capture-a")
                .expect("read")
                .expect("document")
                .page_count,
            1
        );
    }

    #[test]
    fn the_store_refuses_transitions_the_state_machine_forbids() {
        let db = TestDb::open();
        seed_capture(&db, "capture-a", "2026-08-05T09:00:00Z");
        let conn = db.state.conn.lock().expect("lock");

        // Nothing uploads before the user finishes the document.
        let error = set_status(&conn, "capture-a", CaptureStatus::Uploading, None)
            .expect_err("capturing -> uploading must be refused");
        assert!(error.contains("Invalid capture transition"), "{error}");
        assert_eq!(
            get_document(&conn, "capture-a")
                .expect("read")
                .expect("document")
                .status,
            CaptureStatus::Capturing,
            "a refused transition must leave the row untouched",
        );

        // The designed path is accepted, carrying a reason where there is one.
        for (next, reason) in [
            (CaptureStatus::Waiting, None),
            (CaptureStatus::Uploading, None),
            (CaptureStatus::Reading, None),
            (CaptureStatus::NeedsAttention, Some("CAPTURE_UNREADABLE")),
        ] {
            set_status(&conn, "capture-a", next, reason)
                .unwrap_or_else(|e| panic!("{} must be reachable: {e}", next.as_str()));
        }

        let document = get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        assert_eq!(document.status, CaptureStatus::NeedsAttention);
        assert_eq!(
            document.error_message.as_deref(),
            Some("CAPTURE_UNREADABLE")
        );

        // Retry clears the stale reason instead of leaving it on screen.
        set_status(&conn, "capture-a", CaptureStatus::Waiting, None).expect("retry");
        assert!(get_document(&conn, "capture-a")
            .expect("read")
            .expect("document")
            .error_message
            .is_none());
    }

    #[test]
    fn a_committed_document_is_frozen() {
        let db = TestDb::open();
        seed_capture(&db, "capture-a", "2026-08-05T09:00:00Z");
        let conn = db.state.conn.lock().expect("lock");

        for next in [
            CaptureStatus::Waiting,
            CaptureStatus::Uploading,
            CaptureStatus::Reading,
            CaptureStatus::ReadyReview,
            CaptureStatus::Committing,
            CaptureStatus::Committed,
        ] {
            set_status(&conn, "capture-a", next, None).expect("walk the happy path");
        }

        assert!(set_status(&conn, "capture-a", CaptureStatus::Waiting, None).is_err());
        assert!(set_status(&conn, "capture-a", CaptureStatus::Discarded, None).is_err());

        let extra = files::write_page_blocking(db.dir(), "capture-a", 1, PNG, b"late")
            .expect("write late page");
        assert!(
            record_page(&conn, "capture-a", &extra).is_err(),
            "a committed document accepts no more pages",
        );
    }

    #[test]
    fn the_queue_lists_open_documents_oldest_first() {
        let db = TestDb::open();
        seed_capture(&db, "capture-late", "2026-08-05T11:00:00Z");
        seed_capture(&db, "capture-early", "2026-08-05T09:00:00Z");
        seed_capture(&db, "capture-mid", "2026-08-05T10:00:00Z");

        let conn = db.state.conn.lock().expect("lock");
        for next in [
            CaptureStatus::Waiting,
            CaptureStatus::Uploading,
            CaptureStatus::Reading,
            CaptureStatus::ReadyReview,
            CaptureStatus::Committing,
            CaptureStatus::Committed,
        ] {
            set_status(&conn, "capture-mid", next, None).expect("commit the middle one");
        }

        let open = list_open_documents(&conn).expect("open documents");
        let ids: Vec<&str> = open.iter().map(|document| document.id.as_str()).collect();
        assert_eq!(
            ids,
            ["capture-early", "capture-late"],
            "FIFO by capture time, committed documents excluded",
        );

        let waiting = list_documents_by_status(&conn, &[CaptureStatus::Committed])
            .expect("committed documents");
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].id, "capture-mid");
    }

    #[test]
    fn uploads_resume_at_the_first_page_without_a_storage_key() {
        let db = TestDb::open();
        seed_capture(&db, "capture-a", "2026-08-05T09:00:00Z");

        let conn = db.state.conn.lock().expect("lock");
        for index in 1..3 {
            let page = files::write_page_blocking(db.dir(), "capture-a", index, PNG, b"more-bytes")
                .expect("write page");
            record_page(&conn, "capture-a", &page).expect("record page");
        }

        assert_eq!(
            first_unuploaded_page(&conn, "capture-a").expect("first"),
            Some(0)
        );

        set_page_storage_key(
            &conn,
            "capture-a",
            0,
            "org/branch/captures/capture-a/page-000.png",
        )
        .expect("key 0");
        assert_eq!(
            first_unuploaded_page(&conn, "capture-a").expect("first"),
            Some(1)
        );

        set_page_storage_key(
            &conn,
            "capture-a",
            1,
            "org/branch/captures/capture-a/page-001.png",
        )
        .expect("key 1");
        set_page_storage_key(
            &conn,
            "capture-a",
            2,
            "org/branch/captures/capture-a/page-002.png",
        )
        .expect("key 2");
        assert_eq!(
            first_unuploaded_page(&conn, "capture-a").expect("first"),
            None
        );

        let keys = storage_keys(&conn, "capture-a").expect("keys");
        assert_eq!(keys.len(), 3);
        assert!(keys.iter().all(Option::is_some));
    }

    #[test]
    fn offline_and_parked_waits_never_burn_the_retry_budget() {
        let db = TestDb::open();
        seed_capture(&db, "capture-a", "2026-08-05T09:00:00Z");
        let conn = db.state.conn.lock().expect("lock");

        schedule_retry(&conn, "capture-a", "2026-08-05T09:00:30Z", false).expect("offline wait");
        schedule_retry(&conn, "capture-a", "2026-08-05T09:01:00Z", false).expect("still offline");
        assert_eq!(
            get_document(&conn, "capture-a")
                .expect("read")
                .expect("document")
                .attempts,
            0,
            "waiting for connectivity is not a failed attempt",
        );

        schedule_retry(&conn, "capture-a", "2026-08-05T09:02:00Z", true).expect("real failure");
        let document = get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        assert_eq!(document.attempts, 1);
        assert_eq!(
            document.next_retry_at.as_deref(),
            Some("2026-08-05T09:02:00Z")
        );

        clear_retry(&conn, "capture-a").expect("clear");
        let document = get_document(&conn, "capture-a")
            .expect("read")
            .expect("document");
        assert_eq!(document.attempts, 0);
        assert!(document.next_retry_at.is_none());
    }

    #[test]
    fn the_ingest_ledger_records_each_content_hash_once() {
        let db = TestDb::open();
        let conn = db.state.conn.lock().expect("lock");

        let entry = IngestLedgerEntry {
            content_hash: "hash-1".to_string(),
            source_path: Some("\\\\mfp\\scans\\invoice.pdf".to_string()),
            capture_id: None,
            outcome: CaptureIngestOutcome::SkippedUnsupported,
            seen_at: "2026-08-05T09:00:00Z".to_string(),
        };

        assert!(record_ingest(&conn, &entry).expect("first sighting"));
        assert!(
            !record_ingest(&conn, &entry).expect("second sighting"),
            "the same file must not produce a second history entry",
        );

        let stored = ledger_entry(&conn, "hash-1")
            .expect("read")
            .expect("entry exists");
        assert_eq!(stored.outcome, CaptureIngestOutcome::SkippedUnsupported);
        assert!(ledger_entry(&conn, "hash-unknown").expect("read").is_none());
    }

    /// R17.3: after a restart, the capture queue, in-progress review edits, and
    /// document statuses come back with no user action. R8.6: the edits are
    /// exactly the edits, not a re-derived approximation.
    #[test]
    fn a_restart_restores_documents_edits_statuses_and_history() {
        let db = TestDb::open();
        seed_capture(&db, "capture-review", "2026-08-05T09:00:00Z");
        seed_capture(&db, "capture-waiting", "2026-08-05T09:30:00Z");

        let draft = r#"{"rows":[{"name":"Tomatoes","quantity":6,"unitCost":1.25}]}"#;
        let recognition = r#"{"quality":"good","rows":[{"name":"Tomatoes"}]}"#;
        {
            let conn = db.state.conn.lock().expect("lock");
            for next in [
                CaptureStatus::Waiting,
                CaptureStatus::Uploading,
                CaptureStatus::Reading,
                CaptureStatus::ReadyReview,
            ] {
                set_status(&conn, "capture-review", next, None).expect("advance to review");
            }
            set_recognition_json(&conn, "capture-review", recognition).expect("recognition");
            set_draft_json(&conn, "capture-review", draft).expect("draft");
            set_page_storage_key(
                &conn,
                "capture-review",
                0,
                "org/branch/captures/capture-review/page-000.png",
            )
            .expect("storage key");

            set_status(&conn, "capture-waiting", CaptureStatus::Waiting, None).expect("waiting");
            set_status(
                &conn,
                "capture-waiting",
                CaptureStatus::Parked,
                Some("MODULE_REQUIRED"),
            )
            .expect("park");
        }

        let db = db.restart();
        let conn = db.state.conn.lock().expect("lock");

        let review = get_document(&conn, "capture-review")
            .expect("read")
            .expect("document survived");
        assert_eq!(review.status, CaptureStatus::ReadyReview);
        assert_eq!(review.draft_json.as_deref(), Some(draft));
        assert_eq!(review.recognition_json.as_deref(), Some(recognition));
        assert_eq!(
            review.storage_keys,
            vec![Some(
                "org/branch/captures/capture-review/page-000.png".to_string()
            )]
        );
        assert_eq!(review.page_count, 1);

        let parked = get_document(&conn, "capture-waiting")
            .expect("read")
            .expect("document survived");
        assert_eq!(parked.status, CaptureStatus::Parked);
        assert_eq!(parked.error_message.as_deref(), Some("MODULE_REQUIRED"));

        // The queue itself is restored, still FIFO.
        let ids: Vec<String> = list_open_documents(&conn)
            .expect("open documents")
            .into_iter()
            .map(|document| document.id)
            .collect();
        assert_eq!(ids, ["capture-review", "capture-waiting"]);

        // Page files are still on disk and still match their recorded digests.
        let pages = list_pages(&conn, "capture-review").expect("pages");
        assert_eq!(pages.len(), 1);
        let bytes = std::fs::read(&pages[0].file_path).expect("page bytes survived");
        assert_eq!(files::sha256_hex(&bytes), pages[0].content_hash);

        // And the history explaining how each document got here survived too.
        let history: Vec<String> = list_events(&conn, "capture-review")
            .expect("events")
            .into_iter()
            .map(|event| event.event_type)
            .collect();
        assert_eq!(
            history,
            [
                "captured",
                "page_added",
                "status_changed",
                "status_changed",
                "status_changed",
                "status_changed",
            ]
        );
    }

    #[test]
    fn a_discard_is_recorded_with_who_did_it() {
        let db = TestDb::open();
        seed_capture(&db, "capture-a", "2026-08-05T09:00:00Z");
        let conn = db.state.conn.lock().expect("lock");

        set_status(&conn, "capture-a", CaptureStatus::Discarded, None).expect("discard");
        record_event(
            &conn,
            Some("capture-a"),
            "discarded",
            Some("staff-7"),
            Some(&serde_json::json!({ "page_count": 1 })),
        )
        .expect("record discard");

        let discard = list_events(&conn, "capture-a")
            .expect("events")
            .into_iter()
            .find(|event| event.event_type == "discarded")
            .expect("discard is in the history");
        assert_eq!(discard.staff_id.as_deref(), Some("staff-7"));
        assert!(discard
            .details_json
            .as_deref()
            .unwrap_or_default()
            .contains("page_count"));
    }

    #[test]
    fn hostile_capture_ids_never_reach_the_database() {
        let db = TestDb::open();
        let conn = db.state.conn.lock().expect("lock");

        for hostile in ["../escape", "a/b", "a\\b", ""] {
            assert!(
                create_document(&conn, &new_document(hostile, "2026-08-05T09:00:00Z")).is_err(),
                "{hostile:?} must not be persistable as a capture id",
            );
        }
    }
}
