//! Page-file layout for captured invoices.
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
//! **D-Rust1**. Requirements R11.1, R17.2, R17.5.
//!
//! ```text
//! {app_data_dir}/captures/{captureId}/page-000.png
//! {app_data_dir}/captures/{captureId}/original.pdf
//! ```
//!
//! Three properties this module exists to guarantee:
//!
//! 1. **App-protected storage only** (R17.5). Every path is built under
//!    `{app_data_dir}/captures/`, never in a shared or public location. A
//!    watched folder is read *from*, never written into — that is the
//!    watcher's concern, and it copies bytes in through here.
//!
//! 2. **Durable before any network activity** (R11.1). [`write_page_blocking`]
//!    writes to a sibling temp file, `fsync`s it, then renames it into place.
//!    The rename is atomic, so a crash mid-write leaves either the previous
//!    page or no page — never a truncated one that the worker would happily
//!    upload as evidence. Only after this returns may a caller touch the
//!    network.
//!
//! 3. **Never blocking the next page** (R17.2). [`write_page`] is the async
//!    entry point and offloads the whole synchronous write to `spawn_blocking`,
//!    so the scanner or camera can accept page N+1 while page N is still
//!    hitting the disk.
//!
//! ## Path safety
//!
//! `captureId` is minted by a client and reaches this module from the
//! renderer, the WIA adapter, and the watched-folder watcher. It becomes a
//! directory name, so it is treated as hostile input everywhere:
//!
//! - [`sanitize_path_segment`] (the `print.rs::write_print_html_file` guard)
//!   rejects anything outside `[A-Za-z0-9_-]`, which kills `..`, `/`, `\`,
//!   NUL, control characters, drive letters, and UNC prefixes by construction.
//! - Every directory is then re-resolved with `std::fs::canonicalize` and
//!   checked with `starts_with` against the canonical captures root, which is
//!   itself checked against the canonical app-data directory (the
//!   `commands/diagnostics.rs::diagnostics_open_export_dir` guard). Canonicalizing
//!   both sides makes the comparison symlink- and junction-proof: a
//!   `captures/{id}` that is a junction pointing anywhere else fails the check
//!   instead of writing outside app storage.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use super::MAX_CAPTURE_PAGES;

/// Directory under the app data dir that holds every capture.
const CAPTURES_DIR: &str = "captures";

/// Filename for a retained original document (a watched-folder / file-pick
/// PDF kept verbatim alongside its rasterized pages).
const ORIGINAL_FILE_NAME: &str = "original.pdf";

/// Page mimes this terminal may store, with the extension each maps to.
///
/// Deliberately the same allowlist the server's attachments route enforces —
/// a page written here must be a page the server will later agree to store.
const PAGE_MIME_EXTENSIONS: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/webp", "webp"),
];

/// A page that is now durably on disk.
///
/// Only [`write_page_blocking`] can produce one, which is what lets the store
/// layer require file-first ordering at the type level: a `capture_pages` row
/// cannot be recorded for bytes that never landed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WrittenPage {
    pub page_index: usize,
    pub file_path: PathBuf,
    /// Lowercase hex SHA-256 of the bytes on disk. Also the digest the
    /// upload transport sends as `x-capture-content-hash`.
    pub content_hash: String,
    pub byte_size: u64,
    pub mime: String,
}

/// Reject any path segment that is not a plain `[A-Za-z0-9_-]` token.
///
/// Lifted verbatim in behavior from `print.rs::write_print_html_file`'s guard:
/// a machine-minted id passes, and every traversal, separator, control
/// character, and NUL fails.
pub fn sanitize_path_segment(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.len() > 128 {
        return Err(format!("{label} exceeds 128 characters"));
    }
    for ch in value.chars() {
        if !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' {
            return Err(format!(
                "{label} contains invalid character; only [A-Za-z0-9_-] allowed"
            ));
        }
    }
    Ok(())
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    let mut out = String::with_capacity(digest.as_ref().len() * 2);
    for byte in digest.as_ref() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Extension for a page mime, or an error naming the allowed types in plain
/// terms (the caller maps this to user-facing copy).
pub fn page_extension(mime: &str) -> Result<&'static str, String> {
    let normalized = mime.trim().to_ascii_lowercase();
    PAGE_MIME_EXTENSIONS
        .iter()
        .find(|(candidate, _)| *candidate == normalized)
        .map(|(_, extension)| *extension)
        .ok_or_else(|| format!("Unsupported page type: {mime}"))
}

/// `page-000.png` — zero-padded so lexical order is page order, matching the
/// server's `page-NNN.{ext}` object keys.
pub fn page_file_name(page_index: usize, mime: &str) -> Result<String, String> {
    if page_index >= MAX_CAPTURE_PAGES {
        return Err(format!("A capture holds at most {MAX_CAPTURE_PAGES} pages"));
    }
    let extension = page_extension(mime)?;
    Ok(format!("page-{page_index:03}.{extension}"))
}

/// Canonical `{app_data_dir}/captures`, created if absent.
///
/// The root itself is checked against the canonical app-data directory, so a
/// tampered or symlinked `captures` directory is refused before any capture id
/// is even considered.
pub fn captures_root(app_data_dir: &Path) -> Result<PathBuf, String> {
    let root = app_data_dir.join(CAPTURES_DIR);
    fs::create_dir_all(&root).map_err(|e| format!("create captures dir: {e}"))?;

    let canonical_root =
        fs::canonicalize(&root).map_err(|e| format!("resolve captures dir: {e}"))?;
    let canonical_app_data =
        fs::canonicalize(app_data_dir).map_err(|e| format!("resolve app data dir: {e}"))?;

    if !canonical_root.starts_with(&canonical_app_data) {
        return Err("Captures directory resolves outside the app data directory".into());
    }

    Ok(canonical_root)
}

/// Canonical `{app_data_dir}/captures/{capture_id}`, created if absent.
pub fn capture_dir(app_data_dir: &Path, capture_id: &str) -> Result<PathBuf, String> {
    sanitize_path_segment("capture_id", capture_id)?;

    let canonical_root = captures_root(app_data_dir)?;
    let dir = canonical_root.join(capture_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create capture dir: {e}"))?;

    let canonical_dir = fs::canonicalize(&dir).map_err(|e| format!("resolve capture dir: {e}"))?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err("Capture directory resolves outside the captures directory".into());
    }

    Ok(canonical_dir)
}

/// Absolute path a page will occupy. The file need not exist yet.
pub fn page_path(
    app_data_dir: &Path,
    capture_id: &str,
    page_index: usize,
    mime: &str,
) -> Result<PathBuf, String> {
    let dir = capture_dir(app_data_dir, capture_id)?;
    let path = dir.join(page_file_name(page_index, mime)?);
    assert_parent_is(&path, &dir)?;
    Ok(path)
}

/// Absolute path of a capture's retained original document.
pub fn original_path(app_data_dir: &Path, capture_id: &str) -> Result<PathBuf, String> {
    let dir = capture_dir(app_data_dir, capture_id)?;
    let path = dir.join(ORIGINAL_FILE_NAME);
    assert_parent_is(&path, &dir)?;
    Ok(path)
}

/// Lexical containment check for a path whose file may not exist yet — the
/// canonicalize/`starts_with` check needs an existing target, so the parent
/// (already canonical) carries the guarantee and this pins the leaf to it.
fn assert_parent_is(path: &Path, expected_parent: &Path) -> Result<(), String> {
    match path.parent() {
        Some(parent) if parent == expected_parent => Ok(()),
        _ => Err("Capture file path escapes its capture directory".into()),
    }
}

/// Re-resolve a file that now exists and confirm it is still inside `dir`.
///
/// Run *after* the write: between building the path and completing it, the
/// leaf could have been replaced by a link pointing elsewhere. Canonicalizing
/// the real file closes that window.
fn assert_written_within(path: &Path, dir: &Path) -> Result<(), String> {
    let canonical = fs::canonicalize(path).map_err(|e| format!("resolve capture page: {e}"))?;
    if !canonical.starts_with(dir) {
        return Err("Capture page resolves outside its capture directory".into());
    }
    Ok(())
}

/// Write one page durably, synchronously.
///
/// Callers on the async runtime should use [`write_page`] instead; this is the
/// blocking body and the entry point for synchronous contexts (the WIA host
/// thread, the watcher's poll sweep).
///
/// Durability: bytes go to `page-000.png.part`, the file is `fsync`ed, then
/// renamed onto the final name. The rename is atomic on both NTFS and POSIX,
/// so an interrupted write can never leave a half page that later uploads as
/// evidence. The rename also replaces an existing page in place, which is
/// exactly what re-scanning page N must do.
pub fn write_page_blocking(
    app_data_dir: &Path,
    capture_id: &str,
    page_index: usize,
    mime: &str,
    bytes: &[u8],
) -> Result<WrittenPage, String> {
    if bytes.is_empty() {
        return Err("Captured page is empty".into());
    }
    let byte_size = bytes.len() as u64;
    if byte_size > super::MAX_CAPTURE_PAGE_BYTES {
        return Err("This file is too big. Try scanning at normal quality.".into());
    }

    let dir = capture_dir(app_data_dir, capture_id)?;
    let file_name = page_file_name(page_index, mime)?;
    let final_path = dir.join(&file_name);
    assert_parent_is(&final_path, &dir)?;

    let temp_path = dir.join(format!("{file_name}.part"));
    assert_parent_is(&temp_path, &dir)?;

    {
        let mut file =
            fs::File::create(&temp_path).map_err(|e| format!("create capture page: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("write capture page: {e}"))?;
        // The fsync is the whole point: without it the rename can land while
        // the data is still only in the page cache.
        file.sync_all()
            .map_err(|e| format!("flush capture page: {e}"))?;
    }

    fs::rename(&temp_path, &final_path).map_err(|e| {
        // Leave nothing half-written behind if the rename itself fails.
        let _ = fs::remove_file(&temp_path);
        format!("commit capture page: {e}")
    })?;

    assert_written_within(&final_path, &dir)?;

    Ok(WrittenPage {
        page_index,
        file_path: final_path,
        content_hash: sha256_hex(bytes),
        byte_size,
        mime: mime.trim().to_ascii_lowercase(),
    })
}

/// Write one page durably without parking the async runtime.
///
/// R17.2: accepting page N must not block capturing page N+1, so the disk work
/// runs on the blocking pool and each page's write is an independent task.
pub async fn write_page(
    app_data_dir: PathBuf,
    capture_id: String,
    page_index: usize,
    mime: String,
    bytes: Vec<u8>,
) -> Result<WrittenPage, String> {
    tokio::task::spawn_blocking(move || {
        write_page_blocking(&app_data_dir, &capture_id, page_index, &mime, &bytes)
    })
    .await
    .map_err(|e| format!("capture page write task failed: {e}"))?
}

/// Write a capture's retained original document (`original.pdf`) durably.
///
/// The watched-folder source copies a PDF in verbatim here (R17.5 — the source
/// file is never modified) and keeps it: it is both the evidence attached to
/// the committed invoice and the only copy if rasterization later fails
/// (R12.4). Same temp/`fsync`/rename dance as [`write_page_blocking`], for the
/// same reason — a crash mid-copy must never leave a truncated PDF that the
/// renderer would try to rasterize and the server would store as evidence.
pub fn write_original_blocking(
    app_data_dir: &Path,
    capture_id: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("Captured document is empty".into());
    }
    if bytes.len() as u64 > super::MAX_CAPTURE_PAGE_BYTES {
        return Err("This file is too big. Try scanning at normal quality.".into());
    }

    let dir = capture_dir(app_data_dir, capture_id)?;
    let final_path = dir.join(ORIGINAL_FILE_NAME);
    assert_parent_is(&final_path, &dir)?;

    let temp_path = dir.join(format!("{ORIGINAL_FILE_NAME}.part"));
    assert_parent_is(&temp_path, &dir)?;

    {
        let mut file =
            fs::File::create(&temp_path).map_err(|e| format!("create capture original: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("write capture original: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("flush capture original: {e}"))?;
    }

    fs::rename(&temp_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("commit capture original: {e}")
    })?;

    assert_written_within(&final_path, &dir)?;

    Ok(final_path)
}

/// Read a stored page back for upload.
pub fn read_page_blocking(
    app_data_dir: &Path,
    capture_id: &str,
    page_index: usize,
    mime: &str,
) -> Result<Vec<u8>, String> {
    let dir = capture_dir(app_data_dir, capture_id)?;
    let path = dir.join(page_file_name(page_index, mime)?);
    assert_parent_is(&path, &dir)?;
    assert_written_within(&path, &dir)?;
    fs::read(&path).map_err(|e| format!("read capture page: {e}"))
}

/// Delete every file of one capture.
///
/// Only ever called for an explicit confirmed discard, or for a `committed`
/// document once the server has confirmed the invoice *with its attachment*
/// (R11.8). Missing files are not an error — a partially cleaned capture must
/// still finish cleaning.
pub fn remove_capture_files(app_data_dir: &Path, capture_id: &str) -> Result<(), String> {
    sanitize_path_segment("capture_id", capture_id)?;

    let canonical_root = captures_root(app_data_dir)?;
    let dir = canonical_root.join(capture_id);
    if !dir.exists() {
        return Ok(());
    }

    let canonical_dir = fs::canonicalize(&dir).map_err(|e| format!("resolve capture dir: {e}"))?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err("Capture directory resolves outside the captures directory".into());
    }

    fs::remove_dir_all(&canonical_dir).map_err(|e| format!("remove capture dir: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::harness::TempDir;

    const PNG: &str = "image/png";

    #[test]
    fn sanitize_path_segment_blocks_traversal_separators_and_control_chars() {
        assert!(sanitize_path_segment("capture_id", "abc-123").is_ok());
        assert!(
            sanitize_path_segment("capture_id", "550e8400-e29b-41d4-a716-446655440000").is_ok()
        );
        assert!(sanitize_path_segment("capture_id", "_test").is_ok());

        for hostile in [
            "",
            "..",
            "../evil",
            "..\\evil",
            "a/b",
            "a\\b",
            "C:evil",
            "\\\\server\\share",
            "abc\0def",
            "abc\ndef",
            "abc def",
            "abc.png",
        ] {
            assert!(
                sanitize_path_segment("capture_id", hostile).is_err(),
                "{hostile:?} must be refused as a path segment",
            );
        }

        assert!(sanitize_path_segment("capture_id", &"a".repeat(129)).is_err());
    }

    #[test]
    fn capture_paths_stay_inside_app_protected_storage() {
        let temp = TempDir::new();
        let root = captures_root(temp.path()).expect("captures root");
        let dir = capture_dir(temp.path(), "capture-a").expect("capture dir");

        assert!(
            dir.starts_with(&root),
            "capture dir must live under the root"
        );
        assert!(
            root.starts_with(fs::canonicalize(temp.path()).expect("canonical app data")),
            "captures root must live under the app data dir",
        );

        let path = page_path(temp.path(), "capture-a", 0, PNG).expect("page path");
        assert_eq!(path.parent(), Some(dir.as_path()));
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("page-000.png")
        );
    }

    #[test]
    fn traversal_capture_ids_never_reach_the_filesystem() {
        let temp = TempDir::new();
        for hostile in ["../escape", "..", "a/b", "a\\b"] {
            assert!(capture_dir(temp.path(), hostile).is_err());
            assert!(page_path(temp.path(), hostile, 0, PNG).is_err());
            assert!(original_path(temp.path(), hostile).is_err());
            assert!(remove_capture_files(temp.path(), hostile).is_err());
            assert!(
                write_page_blocking(temp.path(), hostile, 0, PNG, b"bytes").is_err(),
                "{hostile:?} must not be writable",
            );
        }

        // Nothing escaped: the temp dir holds only the captures root.
        let escaped = temp.path().join("escape");
        assert!(
            !escaped.exists(),
            "no directory may be created outside captures/"
        );
    }

    #[test]
    fn page_names_are_zero_padded_and_capped() {
        assert_eq!(page_file_name(0, PNG).expect("page 0"), "page-000.png");
        assert_eq!(
            page_file_name(9, "image/jpeg").expect("page 9"),
            "page-009.jpg"
        );
        assert_eq!(
            page_file_name(3, "image/webp").expect("page 3"),
            "page-003.webp"
        );
        assert_eq!(
            page_file_name(1, "IMAGE/PNG").expect("upper mime"),
            "page-001.png"
        );

        assert!(page_file_name(10, PNG).is_err(), "page 11 exceeds the cap");
        assert!(
            page_file_name(0, "application/pdf").is_err(),
            "pages are images"
        );
        assert!(page_file_name(0, "text/html").is_err());
    }

    #[test]
    fn writing_a_page_is_durable_and_returns_its_digest() {
        let temp = TempDir::new();
        let bytes = b"scanned-page-bytes";

        let written =
            write_page_blocking(temp.path(), "capture-a", 0, PNG, bytes).expect("write page");

        assert_eq!(written.page_index, 0);
        assert_eq!(written.byte_size, bytes.len() as u64);
        assert_eq!(written.mime, "image/png");
        assert_eq!(written.content_hash, sha256_hex(bytes));
        assert_eq!(fs::read(&written.file_path).expect("read back"), bytes);

        // No temp artifact survives a successful write.
        let leftovers: Vec<String> = fs::read_dir(written.file_path.parent().expect("parent"))
            .expect("list capture dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(leftovers, vec!["page-000.png".to_string()]);
    }

    #[test]
    fn re_scanning_a_page_replaces_it_in_place() {
        let temp = TempDir::new();
        write_page_blocking(temp.path(), "capture-a", 1, PNG, b"first").expect("first write");
        let second =
            write_page_blocking(temp.path(), "capture-a", 1, PNG, b"second-take").expect("re-scan");

        assert_eq!(
            fs::read(&second.file_path).expect("read back"),
            b"second-take"
        );

        let dir = capture_dir(temp.path(), "capture-a").expect("capture dir");
        let page_files = fs::read_dir(&dir).expect("list").count();
        assert_eq!(page_files, 1, "a re-scan replaces, never appends");
    }

    #[test]
    fn oversize_and_empty_pages_are_refused_before_touching_disk() {
        let temp = TempDir::new();

        assert!(write_page_blocking(temp.path(), "capture-a", 0, PNG, b"").is_err());

        let oversize = vec![0u8; (super::super::MAX_CAPTURE_PAGE_BYTES + 1) as usize];
        assert!(write_page_blocking(temp.path(), "capture-a", 0, PNG, &oversize).is_err());

        let dir = capture_dir(temp.path(), "capture-a").expect("capture dir");
        assert_eq!(fs::read_dir(&dir).expect("list").count(), 0);
    }

    #[test]
    fn pages_are_index_addressed_so_write_order_never_decides_page_order() {
        let temp = TempDir::new();

        // Deliberately out of order: the last page lands first.
        for (index, body) in [(2usize, "third"), (0, "first"), (1, "second")] {
            write_page_blocking(temp.path(), "capture-a", index, PNG, body.as_bytes())
                .unwrap_or_else(|e| panic!("write page {index}: {e}"));
        }

        let dir = capture_dir(temp.path(), "capture-a").expect("capture dir");
        let mut names: Vec<String> = fs::read_dir(&dir)
            .expect("list capture dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();

        // Lexical order is document order — that is what the zero padding buys.
        assert_eq!(names, ["page-000.png", "page-001.png", "page-002.png"]);
        assert_eq!(
            read_page_blocking(temp.path(), "capture-a", 0, PNG).expect("page 0"),
            b"first"
        );
        assert_eq!(
            read_page_blocking(temp.path(), "capture-a", 2, PNG).expect("page 2"),
            b"third"
        );
    }

    /// R17.2: accepting page N must not block capturing page N+1. Both writes
    /// are issued before either is awaited, so if `write_page` serialized the
    /// caller (or ran on the runtime thread) this could not complete.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_page_writes_do_not_block_each_other() {
        let temp = TempDir::new();
        let dir = temp.path().to_path_buf();

        let first = tokio::spawn(write_page(
            dir.clone(),
            "capture-a".to_string(),
            0,
            PNG.to_string(),
            b"page-zero".to_vec(),
        ));
        let second = tokio::spawn(write_page(
            dir.clone(),
            "capture-a".to_string(),
            1,
            PNG.to_string(),
            b"page-one".to_vec(),
        ));

        let (first, second) = tokio::join!(first, second);
        let first = first.expect("join first").expect("write first");
        let second = second.expect("join second").expect("write second");

        assert_eq!(first.page_index, 0);
        assert_eq!(second.page_index, 1);
        assert_eq!(
            fs::read(&first.file_path).expect("read first"),
            b"page-zero"
        );
        assert_eq!(
            fs::read(&second.file_path).expect("read second"),
            b"page-one"
        );
    }

    #[test]
    fn removing_a_capture_clears_only_its_own_files() {
        let temp = TempDir::new();
        write_page_blocking(temp.path(), "capture-a", 0, PNG, b"a").expect("write a");
        write_page_blocking(temp.path(), "capture-b", 0, PNG, b"b").expect("write b");

        remove_capture_files(temp.path(), "capture-a").expect("remove a");

        assert!(!captures_root(temp.path())
            .expect("root")
            .join("capture-a")
            .exists());
        assert!(captures_root(temp.path())
            .expect("root")
            .join("capture-b")
            .exists());

        // Idempotent: discarding an already-cleaned capture is not an error.
        remove_capture_files(temp.path(), "capture-a").expect("second remove");
    }

    #[test]
    fn sha256_hex_matches_the_upload_header_contract() {
        // Well-known SHA-256 of "abc" — the same digest the server recomputes
        // and compares against `x-capture-content-hash`.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
