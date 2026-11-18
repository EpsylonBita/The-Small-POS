//! Tauri commands for the connected-scanner capture source.
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
//! **D-Rust2**, decision **D4**. Requirements R2.1, R2.2, R2.5, R5.1, R12.5.
//!
//! Three thin wrappers around [`crate::capture::wia`]. They do exactly three
//! things the adapter deliberately does not:
//!
//! 1. **Stay off the runtime.** Every call reaches the WIA host thread through
//!    `spawn_blocking`, so a scan that takes a minute never parks a Tokio
//!    worker (the `serial_read` / `ecr` precedent).
//! 2. **Record the store rows.** The adapter returns receipts for pages it has
//!    already written durably; these commands turn each receipt into a
//!    `capture_pages` row, which is why a page row can never describe bytes
//!    that are not on disk (R11.1).
//! 3. **Shape the answer.** A device that is offline, busy, removed, or
//!    cancelled is a *situation*, not a crash: it comes back as
//!    `{ success: false, code, detail }` so the renderer can map the code to
//!    one plain sentence (R12.1, R12.5). `Err` is reserved for a malformed
//!    call — a bug, not a scanner.

use serde_json::{json, Value};

use crate::capture::{files, store, wia};
use crate::db;

/// Pull a trimmed, non-empty string field out of the `arg0` payload.
///
/// Accepts either the object form (`{ deviceId: "…" }`) or a bare string, the
/// same latitude the other `arg0` commands allow their callers.
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

fn scanner_capture_is_editable(status: crate::capture::CaptureStatus, source_kind: &str) -> bool {
    status == crate::capture::CaptureStatus::Capturing
        && source_kind == crate::capture::CaptureSourceKind::ConnectedScanner.as_str()
}

/// The failure envelope the renderer maps to one plain-language sentence.
fn scan_failure(error: wia::ScanError) -> Value {
    tracing::warn!("scanner command failed: {error}");
    json!({
        "success": false,
        "code": error.code.as_str(),
        "detail": error.detail,
    })
}

/// Scanners this terminal can see (R2.1).
///
/// An empty list is a success, not an error — the settings flow answers it by
/// offering the watched folder, the zero-driver path (R2.4).
#[tauri::command]
pub async fn capture_scanner_list() -> Result<Value, String> {
    let result = tokio::task::spawn_blocking(|| wia::WiaHost::global().list_devices())
        .await
        .map_err(|e| format!("capture_scanner_list join error: {e}"))?;

    match result {
        Ok(devices) => Ok(json!({ "success": true, "devices": devices })),
        Err(error) => Ok(scan_failure(error)),
    }
}

/// One silent test page from a device, for visual confirmation (R2.2).
///
/// Silent means silent: no vendor dialog, no user interaction. The returned
/// path points at a JPEG under `captures/_test/` that the settings flow shows
/// so the user can see for themselves that the right machine answered.
#[tauri::command]
pub async fn capture_scanner_test(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use tauri::Manager;

    let device_id = required_string(&arg0, "deviceId")?;
    let feed_mode = match arg0
        .as_ref()
        .and_then(|v| v.get("feedMode"))
        .and_then(Value::as_str)
    {
        None | Some("flatbed") => wia::FeedMode::Flatbed,
        Some("feeder") => wia::FeedMode::Feeder,
        _ => return Err("Unknown scanner source mode".into()),
    };
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;

    let result = tokio::task::spawn_blocking(move || {
        wia::WiaHost::global().test_scan_profile(&device_id, &app_data_dir, feed_mode)
    })
    .await
    .map_err(|e| format!("capture_scanner_test join error: {e}"))?;

    match result {
        Ok(outcome) => Ok(json!({
            "success": true,
            "path": outcome.file_path.to_string_lossy(),
            "byteSize": outcome.byte_size,
        })),
        Err(error) => Ok(scan_failure(error)),
    }
}

/// Transfer pages from a device into an existing captured document (R5.1).
///
/// The starting page index comes from the store rather than the caller, so the
/// renderer cannot accidentally overwrite pages already captured: an ADF stack
/// and a flatbed user pressing "Add another page" both simply append.
///
/// Pages are recorded one at a time as their receipts are read. If recording
/// one row fails, the remaining rows are still attempted and the response
/// reports what actually landed — the *files* are already durable either way,
/// so a partial record is recoverable, whereas an abandoned response is not.
///
/// A run can succeed and still be unfinished. `stoppedEarly` says so, and the
/// renderer owes it a sentence: a device that goes busy mid-stack hands back
/// real pages with sheets possibly still in the feeder, and a response that
/// looked like any other success is how someone presses Done over half an
/// invoice.
#[tauri::command]
pub async fn capture_scanner_acquire(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use tauri::Manager;

    let capture_id = required_string(&arg0, "captureId")?;
    let device_id = required_string(&arg0, "deviceId")?;
    let mut feed_mode = match arg0
        .as_ref()
        .and_then(|v| v.get("feedMode"))
        .and_then(Value::as_str)
    {
        None | Some("flatbed") => wia::FeedMode::Flatbed,
        Some("feeder") => wia::FeedMode::Feeder,
        _ => return Err("Unknown scanner source mode".into()),
    };
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;

    // Acquire the fence before reading status/count or touching the scanner.
    // A timeout does not release it: the host context owns it until COM returns.
    let Some(lifecycle) = files::try_lock_lifecycle(&app_data_dir, &capture_id)? else {
        return Ok(scan_failure(wia::ScanError::busy(
            "this capture is already acquiring",
        )));
    };
    let lifecycle = std::sync::Arc::new(lifecycle);
    let replacement = arg0
        .as_ref()
        .and_then(|v| v.get("replacePageIndex"))
        .and_then(Value::as_u64);
    let (start_page_index, replace_hash) = {
        let conn = db.conn.lock().map_err(|_| "database lock poisoned")?;
        let doc = store::get_document(&conn, &capture_id)?.ok_or("capture not found")?;
        if !scanner_capture_is_editable(doc.status, &doc.source_kind) {
            return Ok(json!({ "success": false, "code": "not_editable" }));
        }
        store::reconcile_scan_receipts(&conn, &lifecycle, &app_data_dir, &capture_id)?;
        // Once selected, the device is pinned for this invoice. A twin device
        // with the same display name must never take over on resume.
        let source = store::latest_event_details(&conn, &capture_id, "capture_source")?;
        if let Some(source) = &source {
            if let Some(saved_mode) = source["feedMode"].as_str() {
                feed_mode = if saved_mode == "feeder" {
                    wia::FeedMode::Feeder
                } else {
                    wia::FeedMode::Flatbed
                };
            }
            if source["deviceId"]
                .as_str()
                .is_some_and(|saved| saved != device_id)
            {
                return Ok(scan_failure(wia::ScanError::removed(
                    "capture belongs to another scanner",
                )));
            }
        }
        {
            store::record_event(
                &conn,
                Some(&capture_id),
                "capture_source",
                None,
                Some(
                    &json!({ "deviceId": device_id, "sourceId": source.as_ref().and_then(|s| s.get("sourceId")),
                    "feedMode": if feed_mode == wia::FeedMode::Feeder { "feeder" } else { "flatbed" } }),
                ),
            )?;
        }
        conn.execute(
            "UPDATE capture_documents SET error_message = 'scan_incomplete' WHERE id = ?1",
            [&capture_id],
        )
        .map_err(|e| e.to_string())?;
        let pages = store::list_pages(&conn, &capture_id)?;
        if let Some(index) = replacement {
            let old = pages
                .iter()
                .find(|p| p.page_index == index as i64)
                .ok_or("replacement page not found")?;
            (index as usize, Some(old.content_hash.clone()))
        } else {
            (pages.len(), None)
        }
    };
    let callback_app = app.clone();
    let callback_dir = app_data_dir.clone();
    let callback_id = capture_id.clone();
    let observer: std::sync::Arc<wia::PageObserver> = std::sync::Arc::new(move |guard, receipt| {
        let db = callback_app.state::<db::DbState>();
        let conn = db.conn.lock().map_err(|_| "database lock poisoned")?;
        store::apply_scan_receipt(&conn, guard, &callback_dir, &callback_id, receipt)?;
        use tauri::Emitter;
        let _ = callback_app.emit("capture:pages-changed", json!({ "captureId": callback_id }));
        Ok(())
    });
    let finish_app = app.clone();
    let finish_id = capture_id.clone();
    let finish: std::sync::Arc<wia::FinishObserver> = std::sync::Arc::new(move |result| {
        use tauri::Emitter;
        let db = finish_app.state::<db::DbState>();
        let conn = db.conn.lock().map_err(|_| "database lock poisoned")?;
        let reason = match result {
            Ok(outcome) if outcome.reached_page_cap => Some("CAPTURE_TOO_MANY_PAGES"),
            Ok(outcome)
                if !outcome.stopped_early
                    && outcome.failure.is_none()
                    && !outcome.pages.is_empty() =>
            {
                None
            }
            _ => Some("scan_incomplete"),
        };
        conn.execute("UPDATE capture_documents SET error_message = ?2 WHERE id = ?1 AND status = 'capturing'",
            rusqlite::params![finish_id, reason]).map_err(|e| e.to_string())?;
        store::record_event(
            &conn,
            Some(&finish_id),
            "acquisition_finished",
            None,
            Some(
                &json!({ "reason": reason, "detail": match result { Ok(outcome) => outcome.failure.as_ref().map(|e| e.detail.as_str()), Err(error) => Some(error.detail.as_str()) } }),
            ),
        )?;
        let _ = finish_app.emit("capture:pages-changed", json!({ "captureId": finish_id }));
        Ok(())
    });
    let context = std::sync::Arc::new(wia::AcquisitionContext {
        guard: lifecycle,
        replace_hash,
        observer,
        finish: Some(finish),
        feed_mode,
    });
    let acquire_id = capture_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        wia::WiaHost::global().acquire_durable(
            &device_id,
            &app_data_dir,
            &acquire_id,
            start_page_index,
            if replacement.is_some() {
                1
            } else {
                crate::capture::MAX_CAPTURE_PAGES
            },
            context,
        )
    })
    .await
    .map_err(|e| format!("capture acquisition join: {e}"))?;
    match result {
        Err(error) => Ok(scan_failure(error)),
        Ok(outcome) => {
            let pages = outcome.pages.iter().map(|p| json!({ "pageIndex": p.page_index,
                "filePath": p.file_path, "contentHash": p.content_hash, "byteSize": p.byte_size, "mime": p.mime })).collect::<Vec<_>>();
            Ok(
                json!({ "success": outcome.failure.is_none() && !pages.is_empty(), "captureId": capture_id,
                "pages": pages, "feederUsed": outcome.feeder_used,
                "reachedPageCap": outcome.reached_page_cap, "stoppedEarly": outcome.stopped_early,
                "code": outcome.failure.as_ref().map(|e| e.code.as_str()),
                "detail": outcome.failure.as_ref().map(|e| &e.detail) }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_acquisition_cannot_append_to_a_folder_pdf_or_a_finished_capture() {
        use crate::capture::CaptureStatus;
        assert!(scanner_capture_is_editable(
            CaptureStatus::Capturing,
            "connected_scanner"
        ));
        assert!(!scanner_capture_is_editable(
            CaptureStatus::Capturing,
            "watched_folder"
        ));
        assert!(!scanner_capture_is_editable(
            CaptureStatus::Capturing,
            "file_pick"
        ));
        assert!(!scanner_capture_is_editable(
            CaptureStatus::Waiting,
            "connected_scanner"
        ));
    }

    #[test]
    fn a_missing_device_id_is_a_caller_bug_not_a_scanner_failure() {
        assert!(required_string(&None, "deviceId").is_err());
        assert!(required_string(&Some(json!({})), "deviceId").is_err());
        assert!(required_string(&Some(json!({ "deviceId": "   " })), "deviceId").is_err());
        assert!(required_string(&Some(json!({ "deviceId": 7 })), "deviceId").is_err());
    }

    #[test]
    fn device_ids_arrive_as_an_object_field_or_a_bare_string() {
        assert_eq!(
            required_string(&Some(json!({ "deviceId": " wia-1 " })), "deviceId"),
            Ok("wia-1".to_string()),
        );
        assert_eq!(
            required_string(&Some(json!("wia-1")), "deviceId"),
            Ok("wia-1".to_string()),
        );
    }

    #[test]
    fn a_scanner_situation_comes_back_as_a_code_the_renderer_can_translate() {
        // R12.1: the code is the contract; the detail never becomes the
        // primary thing a user reads.
        let failure = scan_failure(wia::ScanError::offline("WIA_ERROR_OFFLINE"));

        assert_eq!(failure["success"], json!(false));
        assert_eq!(failure["code"], json!("device_offline"));
        assert!(wia::ScanErrorCode::parse(failure["code"].as_str().expect("code")).is_some());
    }
}
