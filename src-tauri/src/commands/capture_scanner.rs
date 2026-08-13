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

use crate::capture::{store, wia};
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
/// path points at a PNG under `captures/_test/` that the settings flow shows so
/// the user can see for themselves that the right machine answered.
#[tauri::command]
pub async fn capture_scanner_test(
    arg0: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use tauri::Manager;

    let device_id = required_string(&arg0, "deviceId")?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;

    let result = tokio::task::spawn_blocking(move || {
        wia::WiaHost::global().test_scan(&device_id, &app_data_dir)
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
#[tauri::command]
pub async fn capture_scanner_acquire(
    arg0: Option<Value>,
    db: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    use tauri::Manager;

    let capture_id = required_string(&arg0, "captureId")?;
    let device_id = required_string(&arg0, "deviceId")?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;

    // Where this run starts is the document's own truth, read under the lock.
    let start_page_index = {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        store::list_pages(&conn, &capture_id)?.len()
    };

    let acquire_capture_id = capture_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        wia::WiaHost::global().acquire(
            &device_id,
            &app_data_dir,
            &acquire_capture_id,
            start_page_index,
        )
    })
    .await
    .map_err(|e| format!("capture_scanner_acquire join error: {e}"))?;

    let outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => return Ok(scan_failure(error)),
    };

    let conn = db
        .conn
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;

    let mut recorded = Vec::with_capacity(outcome.pages.len());
    for page in &outcome.pages {
        match store::record_page(&conn, &capture_id, page) {
            Ok(()) => recorded.push(json!({
                "pageIndex": page.page_index,
                "filePath": page.file_path.to_string_lossy(),
                "contentHash": page.content_hash,
                "byteSize": page.byte_size,
                "mime": page.mime,
            })),
            Err(error) => tracing::error!(
                "capture {capture_id} page {} written but not recorded: {error}",
                page.page_index
            ),
        }
    }

    Ok(json!({
        "success": true,
        "captureId": capture_id,
        "pages": recorded,
        "feederUsed": outcome.feeder_used,
        "reachedPageCap": outcome.reached_page_cap,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
