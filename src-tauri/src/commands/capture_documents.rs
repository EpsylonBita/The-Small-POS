//! Tauri commands the invoice-capture UI drives the capture store with.
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
//! **D-UI**. Requirements R5.1, R5.2, R8.6, R10.5, R11.4, R11.5, R12.3, R13.4,
//! R17.1, R17.3.
//!
//! [`crate::capture::store`] already owns every rule about what a captured
//! document may do; this module is the renderer's door to it and adds exactly
//! three things on top:
//!
//! 1. **Shape.** Documents, pages, history, and ingest decisions come back as
//!    camelCase JSON the review/queue views render directly, so no screen has
//!    to know the column names.
//! 2. **Files follow rows.** Removing a page or discarding a document deletes
//!    bytes as well as rows, and a discard removes the *whole* capture
//!    directory — the only local delete path a user can trigger (R10.5). The
//!    other local delete path is the worker's post-commit cleanup, which is
//!    gated on the server confirming the attachment (R11.8).
//! 3. **The worker hears about it.** Finishing a document emits
//!    [`EVENT_DOCUMENT_ARRIVED`], which is the capture worker's early-wake
//!    signal — a finished scan starts uploading in about a second rather than
//!    waiting out the 15 s cadence (R17.1).
//!
//! What this module deliberately does *not* do is decide statuses. Every
//! transition goes through [`store::set_status`], so an impossible move is
//! refused here exactly as it is refused for the worker — a renderer bug can
//! never strand a document in a state no screen can render.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::capture::watcher::EVENT_DOCUMENT_ARRIVED;
use crate::capture::worker;
use crate::capture::{files, store, CaptureSourceKind, CaptureStatus, MAX_CAPTURE_PAGES};
use crate::db;

/// How many history entries the queue view asks for. Enough to answer "what
/// happened here today" without turning the history section into a log file.
const HISTORY_LIMIT: i64 = 60;

/// Longest edge of a page thumbnail, in pixels.
///
/// Thumbnails exist so the page strip and the settings flow's test scan can be
/// *seen*; a full-resolution page is up to 10 MB, and base64 of that crossing
/// the IPC boundary for every page of every open capture is not something the
/// UI should ever pay for. 320 px is comfortably legible at the strip's size.
const PREVIEW_MAX_EDGE: u32 = 320;

// ---------------------------------------------------------------------------
// Argument plumbing
// ---------------------------------------------------------------------------

fn field<'a>(arg0: &'a Option<Value>, key: &str) -> Option<&'a Value> {
    match arg0 {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// Pull a trimmed, non-empty string out of the `arg0` payload.
///
/// Accepts the bare-string form too, matching `capture_scanner.rs` and the
/// other `arg0` commands.
fn required_string(arg0: &Option<Value>, key: &str) -> Result<String, String> {
    let value = match arg0 {
        Some(Value::Object(map)) => map.get(key).and_then(Value::as_str),
        Some(Value::String(raw)) => Some(raw.as_str()),
        _ => None,
    };

    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

fn optional_string(arg0: &Option<Value>, key: &str) -> Option<String> {
    field(arg0, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn required_index(arg0: &Option<Value>, key: &str) -> Result<i64, String> {
    field(arg0, key)
        .and_then(Value::as_i64)
        .filter(|index| *index >= 0)
        .ok_or_else(|| format!("{key} is required"))
}

/// Takes `&db::DbState` rather than `&State<'_, DbState>` so the guard's
/// lifetime is the state's, not the (shorter, elided) borrow of the `State`
/// wrapper. Call sites pass `&db` and deref coercion does the rest — the same
/// signature `capture::worker::lock` uses.
fn lock(db: &db::DbState) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    db.conn
        .lock()
        .map_err(|_| "database lock poisoned".to_string())
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

fn page_json(page: &store::CapturePage) -> Value {
    json!({
        "pageIndex": page.page_index,
        "filePath": page.file_path,
        "contentHash": page.content_hash,
        "byteSize": page.byte_size,
        "mime": page.mime,
    })
}

fn event_json(event: &store::CaptureEvent) -> Value {
    json!({
        "id": event.id,
        "captureId": event.capture_id,
        "eventType": event.event_type,
        "staffId": event.staff_id,
        "details": event
            .details_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
        "createdAt": event.created_at,
    })
}

/// One document as the queue and page views read it.
///
/// `recognition` and `draft` are re-parsed rather than passed through as
/// strings so the renderer never has to `JSON.parse` an IPC payload. A blob
/// that will not parse becomes `null` instead of failing the whole list — the
/// document must still be visible and actionable even if one of its cached
/// payloads is damaged.
fn document_json(document: &store::CaptureDocument, pages: &[store::CapturePage]) -> Value {
    json!({
        "captureId": document.id,
        "status": document.status.as_str(),
        "sourceKind": document.source_kind,
        "sourceName": document.source_name,
        "staffId": document.staff_id,
        "capturedAt": document.captured_at,
        "pageCount": document.page_count,
        "recognition": document
            .recognition_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
        "draft": document
            .draft_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
        "storageKeys": document.storage_keys,
        "reasonCode": document.error_message,
        "attempts": document.attempts,
        "updatedAt": document.updated_at,
        "pages": pages.iter().map(page_json).collect::<Vec<_>>(),
    })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Every not-yet-finished document on this terminal, oldest capture first.
///
/// This is the queue view's list *and* the badge count's source (R11.4, R11.5):
/// `capturing` documents are in it too, because a half-scanned invoice the user
/// walked away from is exactly the kind of work that must not be forgettable.
#[tauri::command]
pub async fn capture_list_documents(db: tauri::State<'_, db::DbState>) -> Result<Value, String> {
    let conn = lock(&db)?;
    let documents = store::list_open_documents(&conn)?;

    let mut out = Vec::with_capacity(documents.len());
    for document in &documents {
        let pages = store::list_pages(&conn, &document.id)?;
        out.push(document_json(document, &pages));
    }

    Ok(json!({ "success": true, "documents": out }))
}

/// One document with its pages and its own history.
#[tauri::command]
pub async fn capture_get_document(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let capture_id = required_string(&arg0, "captureId")?;
    let conn = lock(&db)?;

    let Some(document) = store::get_document(&conn, &capture_id)? else {
        return Ok(json!({ "success": false, "code": "not_found" }));
    };
    let pages = store::list_pages(&conn, &capture_id)?;
    let events = store::list_events(&conn, &capture_id)?;

    Ok(json!({
        "success": true,
        "document": document_json(&document, &pages),
        "events": events.iter().map(event_json).collect::<Vec<_>>(),
    }))
}

/// The terminal's recent capture history (R13.4) plus the watched folder's
/// recent ingest decisions.
///
/// The ingest list is what makes a skip *visible* rather than silent: a
/// duplicate the watcher declined is a row here, and the history section says
/// so in plain language instead of the file simply never appearing (R3.4).
#[tauri::command]
pub async fn capture_history(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let limit = field(&arg0, "limit")
        .and_then(Value::as_i64)
        .unwrap_or(HISTORY_LIMIT)
        .clamp(1, 500);

    let conn = lock(&db)?;
    let events = store::list_recent_events(&conn, limit)?;
    let ingest = store::list_recent_ingest(&conn, limit)?;

    Ok(json!({
        "success": true,
        "events": events.iter().map(event_json).collect::<Vec<_>>(),
        "ingest": ingest
            .iter()
            .map(|entry| json!({
                "contentHash": entry.content_hash,
                "sourcePath": entry.source_path,
                "captureId": entry.capture_id,
                "outcome": entry.outcome.as_str(),
                "seenAt": entry.seen_at,
            }))
            .collect::<Vec<_>>(),
    }))
}

/// A thumbnail of one stored page, as a `data:` URL.
///
/// Decoding happens on the blocking pool: a 10 MB PNG decode on the async
/// runtime would stall every other command for the duration.
#[tauri::command]
pub async fn capture_page_preview(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let capture_id = required_string(&arg0, "captureId")?;
    let page_index = required_index(&arg0, "pageIndex")?;

    let page = {
        let conn = lock(&db)?;
        store::list_pages(&conn, &capture_id)?
            .into_iter()
            .find(|page| page.page_index == page_index)
    };
    let Some(page) = page else {
        return Ok(json!({ "success": false, "code": "not_found" }));
    };

    let dir = files::capture_dir(&app_data_dir(&app)?, &capture_id)?;
    let path = PathBuf::from(&page.file_path);
    // The row's path is re-proved against the capture directory rather than
    // trusted: a repaired or hand-edited database must not be able to point
    // this command at an arbitrary file on disk.
    if path.parent() != Some(dir.as_path()) {
        return Err("Capture page resolves outside its capture directory".into());
    }

    let encoded = tokio::task::spawn_blocking(move || thumbnail_data_url(&path))
        .await
        .map_err(|e| format!("capture preview task failed: {e}"))?;

    match encoded {
        Ok(data_url) => Ok(json!({ "success": true, "dataUrl": data_url })),
        Err(error) => {
            tracing::warn!("capture page preview failed: {error}");
            Ok(json!({ "success": false, "code": "unreadable" }))
        }
    }
}

/// A thumbnail of a connected scanner's test page (R2.2).
///
/// `capture_scanner_test` answers with a path under `captures/_test/`; this
/// turns that path into something the settings flow can actually show. The path
/// is re-derived from the canonical test directory instead of being trusted, so
/// the command cannot be talked into reading elsewhere on disk.
#[tauri::command]
pub async fn capture_test_preview(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let raw_path = required_string(&arg0, "path")?;
    let test_dir = files::capture_dir(&app_data_dir(&app)?, "_test")?;

    let candidate = PathBuf::from(&raw_path);
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Test scan path has no file name".to_string())?;
    let path = test_dir.join(file_name);
    if path.parent() != Some(test_dir.as_path()) {
        return Err("Test scan resolves outside the test directory".into());
    }

    let encoded = tokio::task::spawn_blocking(move || thumbnail_data_url(&path))
        .await
        .map_err(|e| format!("capture test preview task failed: {e}"))?;

    match encoded {
        Ok(data_url) => Ok(json!({ "success": true, "dataUrl": data_url })),
        Err(error) => {
            tracing::warn!("capture test preview failed: {error}");
            Ok(json!({ "success": false, "code": "unreadable" }))
        }
    }
}

/// The retained original document of a capture, base64-encoded.
///
/// The return leg of `capture:needs-render` (D1): Rust deliberately owns no PDF
/// renderer, so the bytes go to the webview, which rasterizes them with the
/// already-bundled `pdfjs-dist` and hands pages back through
/// `capture_attach_rendered_pages`.
///
/// This exists instead of granting the renderer a filesystem plugin. The path
/// is derived entirely from the capture id — the caller supplies no path at
/// all — so the only file this command can ever read is the `original.pdf` of
/// a capture that exists in this terminal's own store.
#[tauri::command]
pub async fn capture_read_original(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use base64::Engine as _;

    let capture_id = required_string(&arg0, "captureId")?;

    {
        let conn = lock(&db)?;
        store::get_document(&conn, &capture_id)?
            .ok_or_else(|| format!("Capture {capture_id} not found"))?;
    }

    let path = files::original_path(&app_data_dir(&app)?, &capture_id)?;
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| format!("capture original read task failed: {e}"))?;

    match bytes {
        Ok(bytes) => Ok(json!({
            "success": true,
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        })),
        Err(error) => {
            tracing::warn!("capture {capture_id} original unreadable: {error}");
            Ok(json!({ "success": false, "code": "unreadable" }))
        }
    }
}

/// Decode an image, scale its longest edge down to [`PREVIEW_MAX_EDGE`], and
/// return it as a PNG `data:` URL.
fn thumbnail_data_url(path: &std::path::Path) -> Result<String, String> {
    use base64::Engine as _;

    let image = image::open(path).map_err(|e| format!("decode capture page: {e}"))?;
    let thumbnail = image.thumbnail(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE);

    let mut buffer = std::io::Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("encode capture thumbnail: {e}"))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// Open a new captured document in `capturing`.
///
/// The id is minted here rather than in the renderer so the same value is the
/// directory name, the server's staging prefix, the commit claim key, and the
/// `Idempotency-Key` — one identity, minted once, by the layer that also
/// enforces the path-segment charset.
#[tauri::command]
pub async fn capture_start_document(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let source_kind_raw = required_string(&arg0, "sourceKind")?;
    let source_kind = CaptureSourceKind::parse(&source_kind_raw)
        .ok_or_else(|| format!("Unknown capture source kind: {source_kind_raw}"))?;

    let capture_id = uuid::Uuid::new_v4().to_string();
    let document = store::NewCaptureDocument {
        id: capture_id.clone(),
        source_kind,
        source_name: optional_string(&arg0, "sourceName"),
        staff_id: optional_string(&arg0, "staffId"),
        captured_at: chrono::Utc::now().to_rfc3339(),
        content_hash: None,
    };

    let conn = lock(&db)?;
    store::create_document(&conn, &document)?;

    Ok(json!({
        "success": true,
        "captureId": capture_id,
        "status": CaptureStatus::Capturing.as_str(),
    }))
}

/// Move a document to `status`, enforcing the design's state machine.
///
/// One command for every transition the UI can cause — finishing a capture,
/// retrying a failed one, taking a failed one to manual entry, starting a
/// commit, recording a rejection, discarding — because the *rules* live in
/// [`CaptureStatus::can_transition_to`], not in eleven near-identical commands
/// that could each drift from them.
///
/// Two transitions carry side effects:
/// - `waiting` emits [`EVENT_DOCUMENT_ARRIVED`] so the worker wakes now
///   instead of at its next cadence tick.
/// - `discarded` deletes the capture's files. This is the only user-triggered
///   local delete, and it is why discard must be a confirmed action in the UI
///   (R10.5).
#[tauri::command]
pub async fn capture_advance(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let capture_id = required_string(&arg0, "captureId")?;
    let status_raw = required_string(&arg0, "status")?;
    let next = CaptureStatus::parse(&status_raw)
        .ok_or_else(|| format!("Unknown capture status: {status_raw}"))?;
    let reason = optional_string(&arg0, "reason");
    let staff_id = optional_string(&arg0, "staffId");

    {
        let conn = lock(&db)?;

        // A document is only ever finished with pages on it. Refusing here
        // rather than letting the worker discover an empty capture keeps the
        // failure where the user can still do something about it.
        if next == CaptureStatus::Waiting {
            let pages = store::list_pages(&conn, &capture_id)?;
            if pages.is_empty() {
                return Ok(json!({
                    "success": false,
                    "code": "no_pages",
                }));
            }
        }

        store::set_status(&conn, &capture_id, next, reason.as_deref())?;

        if next == CaptureStatus::Discarded {
            store::record_event(
                &conn,
                Some(&capture_id),
                "discarded",
                staff_id.as_deref(),
                Some(&json!({ "reason": reason })),
            )?;
        }
    }

    if next == CaptureStatus::Discarded {
        // Rows first, bytes second: a document the user confirmed away is
        // already invisible before the (possibly slow) directory removal runs,
        // and a failed removal leaves orphan bytes rather than a resurrected
        // document.
        let dir = app_data_dir(&app)?;
        let id = capture_id.clone();
        let removed = tokio::task::spawn_blocking(move || files::remove_capture_files(&dir, &id))
            .await
            .map_err(|e| format!("capture discard task failed: {e}"))?;
        if let Err(error) = removed {
            tracing::warn!("capture {capture_id} rows discarded but files remain: {error}");
        }
    }

    if next == CaptureStatus::Waiting {
        let _ = app.emit(
            EVENT_DOCUMENT_ARRIVED,
            json!({ "captureId": capture_id, "needsRender": false }),
        );
    }

    Ok(json!({ "success": true, "status": next.as_str() }))
}

/// Persist review edits so leaving the drawer (or restarting the POS) loses
/// nothing (R8.6, R17.3).
#[tauri::command]
pub async fn capture_save_draft(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let capture_id = required_string(&arg0, "captureId")?;
    let draft = field(&arg0, "draft")
        .cloned()
        .ok_or_else(|| "draft is required".to_string())?;

    let conn = lock(&db)?;
    store::set_draft_json(&conn, &capture_id, &draft.to_string())?;

    Ok(json!({ "success": true }))
}

/// Record the server's verbatim commit result and move to `committed`.
///
/// Delegates to [`worker::confirm_commit`] rather than writing the status
/// directly, because that function is also what makes the document eligible
/// for local cleanup — and cleanup keys off the stored result, so the only way
/// to reach the terminal state is by way of something the server actually said
/// (R11.8).
#[tauri::command]
pub async fn capture_confirm_commit(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let capture_id = required_string(&arg0, "captureId")?;
    let result = field(&arg0, "result")
        .cloned()
        .ok_or_else(|| "result is required".to_string())?;
    let staff_id = optional_string(&arg0, "staffId");

    let conn = lock(&db)?;
    worker::confirm_commit(&conn, &capture_id, &result, staff_id.as_deref())?;

    Ok(json!({
        "success": true,
        "status": CaptureStatus::Committed.as_str(),
    }))
}

// ---------------------------------------------------------------------------
// Page management before the document is finished (R5.2)
// ---------------------------------------------------------------------------

/// Drop one page and close the gap it left.
///
/// Indexes stay contiguous `0..n-1` because the uploader's resume logic and the
/// server's `page-NNN` object keys both assume it.
#[tauri::command]
pub async fn capture_remove_page(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let capture_id = required_string(&arg0, "captureId")?;
    let page_index = required_index(&arg0, "pageIndex")?;

    let (remaining, removed_path) = {
        let conn = lock(&db)?;
        let document = store::get_document(&conn, &capture_id)?
            .ok_or_else(|| format!("Capture {capture_id} not found"))?;
        if document.status != CaptureStatus::Capturing {
            return Ok(json!({ "success": false, "code": "not_editable" }));
        }

        let removed_path = store::list_pages(&conn, &capture_id)?
            .into_iter()
            .find(|page| page.page_index == page_index)
            .map(|page| page.file_path);

        store::delete_page(&conn, &capture_id, page_index)?;
        store::compact_page_indexes(&conn, &capture_id)?;
        (store::list_pages(&conn, &capture_id)?.len(), removed_path)
    };

    if let Some(path) = removed_path {
        let dir = files::capture_dir(&app_data_dir(&app)?, &capture_id)?;
        let path = PathBuf::from(path);
        if path.parent() == Some(dir.as_path()) {
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(path)).await;
        }
    }

    Ok(json!({ "success": true, "pageCount": remaining }))
}

/// Reorder the pages of a document that has not been finished yet.
///
/// `order` lists the current page indexes in the order the user wants them.
#[tauri::command]
pub async fn capture_reorder_pages(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
) -> Result<Value, String> {
    let capture_id = required_string(&arg0, "captureId")?;
    let order: Vec<i64> = field(&arg0, "order")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .ok_or_else(|| "order is required".to_string())?;

    if order.len() > MAX_CAPTURE_PAGES {
        return Err(format!("A capture holds at most {MAX_CAPTURE_PAGES} pages"));
    }

    let conn = lock(&db)?;
    let document = store::get_document(&conn, &capture_id)?
        .ok_or_else(|| format!("Capture {capture_id} not found"))?;
    if document.status != CaptureStatus::Capturing {
        return Ok(json!({ "success": false, "code": "not_editable" }));
    }

    store::reorder_pages(&conn, &capture_id, &order)?;

    Ok(json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_string_accepts_the_object_and_bare_string_forms() {
        assert_eq!(
            required_string(&Some(json!({ "captureId": " abc " })), "captureId"),
            Ok("abc".to_string()),
        );
        assert_eq!(
            required_string(&Some(json!("abc")), "captureId"),
            Ok("abc".to_string()),
        );
    }

    #[test]
    fn a_missing_or_blank_capture_id_is_a_caller_bug() {
        assert!(required_string(&None, "captureId").is_err());
        assert!(required_string(&Some(json!({})), "captureId").is_err());
        assert!(required_string(&Some(json!({ "captureId": "  " })), "captureId").is_err());
        assert!(required_string(&Some(json!({ "captureId": 7 })), "captureId").is_err());
    }

    #[test]
    fn page_indexes_must_be_non_negative_integers() {
        assert_eq!(
            required_index(&Some(json!({ "pageIndex": 0 })), "pageIndex"),
            Ok(0)
        );
        assert!(required_index(&Some(json!({ "pageIndex": -1 })), "pageIndex").is_err());
        assert!(required_index(&Some(json!({ "pageIndex": "2" })), "pageIndex").is_err());
        assert!(required_index(&None, "pageIndex").is_err());
    }

    #[test]
    fn document_json_never_leaks_a_raw_json_string_to_the_renderer() {
        let document = store::CaptureDocument {
            id: "cap-1".into(),
            status: CaptureStatus::ReadyReview,
            source_kind: "connected_scanner".into(),
            source_name: Some("Front desk scanner".into()),
            staff_id: Some("staff-1".into()),
            captured_at: "2026-08-06T10:00:00Z".into(),
            page_count: 1,
            content_hash: None,
            recognition_json: Some(r#"{"quality":"good"}"#.into()),
            // A damaged blob must not hide the document — it degrades to null.
            draft_json: Some("{not json".into()),
            storage_keys: vec![Some("key-0".into())],
            error_message: None,
            next_retry_at: None,
            attempts: 0,
            updated_at: "2026-08-06T10:00:01Z".into(),
        };

        let encoded = document_json(&document, &[]);

        assert_eq!(encoded["recognition"]["quality"], json!("good"));
        assert_eq!(encoded["draft"], Value::Null);
        assert_eq!(encoded["status"], json!("ready_review"));
        assert_eq!(encoded["captureId"], json!("cap-1"));
    }

    #[test]
    fn history_limit_is_clamped_to_a_sane_window() {
        // A renderer asking for a million rows gets the cap, not the database.
        let huge = field(&Some(json!({ "limit": 1_000_000 })), "limit")
            .and_then(Value::as_i64)
            .unwrap_or(HISTORY_LIMIT)
            .clamp(1, 500);
        assert_eq!(huge, 500);

        let none = field(&Some(json!({})), "limit")
            .and_then(Value::as_i64)
            .unwrap_or(HISTORY_LIMIT)
            .clamp(1, 500);
        assert_eq!(none, HISTORY_LIMIT);
    }
}
