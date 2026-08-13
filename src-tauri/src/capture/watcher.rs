//! Watched-folder capture source — the "press Scan on the MFP" path.
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — design surfaces
//! **D-Rust3** (decision D5) and the PDF half of **D1**.
//! Requirements R3.2–R3.8, R5.3, R12.2, R12.4, R17.5, R17.7.
//!
//! The user configures their multifunction printer, once, to scan into a
//! folder. From then on the entire capture interaction is: press Scan on the
//! machine. This module is what turns that into a captured document on the POS.
//!
//! ## Why a poll sweep *and* a watcher (D5)
//!
//! `notify`'s Windows backend is `ReadDirectoryChangesW`, which is documented
//! as unreliable over SMB/network shares — and a share is exactly where an
//! office MFP scans to. Notifications are therefore treated as a *latency
//! optimization only*: [`start_watched_folder_worker`] runs an unconditional
//! [`POLL_SWEEP_INTERVAL_SECS`]-second sweep regardless, which is what actually
//! holds the 15-second detection SLA (R3.2). Everything the engine decides is
//! decided by [`sweep_folder`]; the watcher only ever wakes the loop early.
//!
//! That split is also why the engine is testable without timing races: tests
//! drive [`sweep_folder`] directly against a temp directory with an explicit
//! monotonic clock, and never wait on a filesystem event.
//!
//! ## The read-only guarantee (R17.5)
//!
//! A watched folder is user storage, not app storage. Ingest **copies** bytes
//! into the capture store under `{app_data_dir}/captures/`; the source file is
//! never modified, truncated, or deleted. The single exception is the per-source
//! opt-in [`Housekeeping::MoveDone`] setting — default off — which moves an
//! already-ingested file into a `Done` subfolder so the user's folder does not
//! grow forever. Nothing here ever touches a folder the user has not explicitly
//! configured as a capture source (R17.7).
//!
//! ## Exactly once (R3.3, R3.4)
//!
//! Two independent guards, because an MFP writes a file *while* the sweep may
//! be looking at it:
//!
//! 1. **Stability gate** — a candidate is only considered once its
//!    `(size, mtime)` has been unchanged across two observations
//!    [`STABILITY_WINDOW_MS`] apart *and* the whole file can be opened and read
//!    (on Windows a writer holding the file without share-read fails that read,
//!    which is precisely the signal we want).
//! 2. **Content-hash ledger** — `capture_ingest_ledger` is keyed by SHA-256, so
//!    dedupe survives restarts and recognizes the same document under a new
//!    name. Duplicates, unsupported types, and oversize files each record one
//!    ledger row per hash and a visible history event, rather than a repeating
//!    error (R3.4, R3.5, R12.2).
//!
//! ## PDFs (D1)
//!
//! Rust does not rasterize. A PDF is ingested as one document with
//! `original.pdf` retained, and [`EVENT_NEEDS_RENDER`] asks the renderer to
//! rasterize it with the already-bundled `pdfjs-dist` and hand the pages back
//! through [`capture_attach_rendered_pages`]. A PDF that cannot be rendered
//! becomes `needs_attention` with the original still on disk (R12.4).

use std::collections::HashMap;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::Utc;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{info, warn};

use super::files;
use super::store::{self, IngestLedgerEntry, NewCaptureDocument};
use super::{
    CaptureIngestOutcome, CaptureSourceKind, CaptureStatus, MAX_CAPTURE_PAGES,
    MAX_CAPTURE_PAGE_BYTES,
};
use crate::db;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// Unconditional sweep cadence. Chosen against the 15-second detection SLA
/// (R3.2) with room for one missed tick: 10 s sweep + the stability window
/// still lands inside 15 s on the common case, and the sweep runs whether or
/// not a single filesystem notification ever arrives.
pub const POLL_SWEEP_INTERVAL_SECS: u64 = 10;

/// A candidate must hold the same `(size, mtime)` for this long before it is
/// even read. 1.5 s per the design; long enough that a scanner flushing a
/// multi-megabyte page is caught mid-write, short enough to stay inside the SLA.
pub const STABILITY_WINDOW_MS: u64 = 1_500;

/// How often an unreachable folder is re-probed (R3.7). Deliberately slower
/// than the sweep cadence so a disconnected share is not hammered every tick.
pub const UNAVAILABLE_PROBE_SECS: u64 = 30;

/// `local_settings` home of the per-terminal capture source list (D-UI). Not
/// sensitive — folder paths and friendly names only — so no keyring.
const LOCAL_SETTINGS_CATEGORY: &str = "capture";
const SOURCES_SETTING_KEY: &str = "capture.sources";

/// Subfolder used by the opt-in [`Housekeeping::MoveDone`] setting. Always
/// excluded from sweeps so a moved file is never re-ingested.
const DONE_SUBFOLDER: &str = "Done";

/// A new captured document arrived on its own — the renderer raises the
/// "a new invoice arrived" notice with a direct path to review (R3.6).
pub const EVENT_DOCUMENT_ARRIVED: &str = "capture:document-arrived";

/// A PDF needs renderer-side rasterization before recognition (D1).
pub const EVENT_NEEDS_RENDER: &str = "capture:needs-render";

/// A source's reachability changed — drives the ready/watching/unavailable
/// chip in scan settings (R1.4, R3.7). Emitted only on a real change.
pub const EVENT_SOURCE_STATUS: &str = "capture:source-status";

/// File types a watched folder may deliver (R3.2). Deliberately the exact set
/// the requirement names; anything else is recorded as skipped, not ingested.
const SUPPORTED_EXTENSIONS: &[(&str, &str)] = &[
    ("pdf", "application/pdf"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
];

/// In-progress artifacts scanners and sync clients leave behind. These are not
/// "files that appeared" in any sense the user would recognize, so they are
/// ignored outright rather than recorded as skipped — recording them would fill
/// the skip history with noise the user cannot act on (R3.5's intent).
const TRANSIENT_SUFFIXES: &[&str] = &[
    ".tmp",
    ".part",
    ".partial",
    ".crdownload",
    ".filepart",
    ".ds_store",
];

// ---------------------------------------------------------------------------
// Source configuration
// ---------------------------------------------------------------------------

/// Optional post-ingest tidying, per source. Default [`Housekeeping::None`] —
/// the read-only guarantee (R17.5) is the default behavior, and moving the
/// user's files is something they must switch on deliberately.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Housekeeping {
    #[default]
    None,
    MoveDone,
}

impl Housekeeping {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("move_done") => Self::MoveDone,
            _ => Self::None,
        }
    }
}

/// One configured watched folder on this terminal.
///
/// Projected from the `CaptureSourceConfig` entries the renderer stores in
/// `local_settings`; only `watched_folder` entries reach this type.
#[derive(Clone, Debug)]
pub struct WatchedFolderSource {
    pub id: String,
    pub name: String,
    pub folder: PathBuf,
    pub housekeeping: Housekeeping,
}

/// Read the terminal's watched-folder sources.
///
/// Anything malformed is skipped with a warning rather than failing the whole
/// list: one bad entry must not silently stop every other folder from being
/// watched.
pub fn load_watched_folder_sources(conn: &Connection) -> Vec<WatchedFolderSource> {
    let Some(raw) = db::get_setting(conn, LOCAL_SETTINGS_CATEGORY, SOURCES_SETTING_KEY) else {
        return Vec::new();
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            warn!(%error, "Capture source list is not valid JSON; no folders watched");
            return Vec::new();
        }
    };
    let Some(entries) = parsed.as_array() else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|entry| {
            if entry.get("kind").and_then(|v| v.as_str())
                != Some(CaptureSourceKind::WatchedFolder.as_str())
            {
                return None;
            }
            let id = entry.get("id").and_then(|v| v.as_str())?.to_string();
            let folder = entry.get("folderPath").and_then(|v| v.as_str())?;
            if folder.trim().is_empty() {
                return None;
            }
            let name = entry
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Scan folder")
                .to_string();
            Some(WatchedFolderSource {
                id,
                name,
                folder: PathBuf::from(folder),
                housekeeping: Housekeeping::parse(
                    entry.get("housekeeping").and_then(|v| v.as_str()),
                ),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Sweep state
// ---------------------------------------------------------------------------

/// `(size, mtime)` — the pair the stability gate compares.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Fingerprint {
    size: u64,
    mtime_ms: i64,
}

#[derive(Clone, Debug)]
struct Tracked {
    fingerprint: Fingerprint,
    first_seen_ms: u64,
    /// `Some` once this exact `(path, fingerprint)` has been decided, so a file
    /// that simply sits in the folder is never re-read or re-reported.
    decided: Option<CaptureIngestOutcome>,
}

/// Per-source sweep state. Lives in the worker across ticks; a test owns one
/// directly and drives it with an explicit clock.
///
/// Deliberately *not* persisted: everything that must survive a restart lives
/// in `capture_ingest_ledger`. This is only a within-run optimization plus the
/// stability gate's short-term memory.
#[derive(Debug, Default)]
pub struct FolderWatchState {
    tracked: HashMap<PathBuf, Tracked>,
    /// `None` until the first probe — so the first status is always a real
    /// change and the UI never has to render an unknown source.
    available: Option<bool>,
    next_probe_ms: u64,
}

impl FolderWatchState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the folder was reachable at the last sweep.
    pub fn is_available(&self) -> bool {
        self.available.unwrap_or(false)
    }

    /// An unreachable folder is only re-probed every [`UNAVAILABLE_PROBE_SECS`]
    /// (R3.7) — a disconnected share should not be hit on every tick.
    fn should_probe(&self, now_ms: u64) -> bool {
        self.available != Some(false) || now_ms >= self.next_probe_ms
    }
}

/// What the sweep decided about one file.
#[derive(Clone, Debug)]
pub struct IngestDecision {
    pub path: PathBuf,
    pub outcome: CaptureIngestOutcome,
    /// The document created, for [`CaptureIngestOutcome::Ingested`].
    pub capture_id: Option<String>,
    /// `true` when the document is a PDF awaiting renderer-side rasterization.
    pub needs_render: bool,
    /// Absolute path of the retained `original.pdf`, when `needs_render`.
    pub original_path: Option<PathBuf>,
}

/// One pass over one folder.
#[derive(Clone, Debug, Default)]
pub struct SweepReport {
    pub decisions: Vec<IngestDecision>,
    /// `true` when this sweep was skipped because the folder is unreachable and
    /// its probe is not due yet.
    pub skipped_probe: bool,
}

impl SweepReport {
    /// Documents created by this sweep, in decision order.
    pub fn arrived(&self) -> impl Iterator<Item = &IngestDecision> {
        self.decisions
            .iter()
            .filter(|decision| decision.outcome == CaptureIngestOutcome::Ingested)
    }
}

/// The folder could not be enumerated — disconnected share, removed drive,
/// deleted directory, revoked permission (R3.7).
#[derive(Clone, Debug)]
pub struct FolderUnavailable(pub String);

// ---------------------------------------------------------------------------
// The sweep — the whole engine, directly testable
// ---------------------------------------------------------------------------

/// Enumerate a watched folder once and act on whatever is ready.
///
/// This is the single decision path: the `notify` watcher never ingests
/// anything, it only causes this to be called sooner. `now_ms` is a monotonic
/// millisecond clock supplied by the caller — production passes elapsed time
/// since worker start, tests pass explicit values, and neither has to sleep.
///
/// Returns [`FolderUnavailable`] when the folder itself cannot be read; the
/// caller flips the source's status and re-probes (R3.7).
pub fn sweep_folder(
    conn: &Connection,
    app_data_dir: &Path,
    source: &WatchedFolderSource,
    state: &mut FolderWatchState,
    now_ms: u64,
) -> Result<SweepReport, FolderUnavailable> {
    if !state.should_probe(now_ms) {
        return Ok(SweepReport {
            decisions: Vec::new(),
            skipped_probe: true,
        });
    }

    let entries = match fs::read_dir(&source.folder) {
        Ok(entries) => entries,
        Err(error) => {
            state.available = Some(false);
            state.next_probe_ms = now_ms + UNAVAILABLE_PROBE_SECS * 1_000;
            // Nothing tracked survives an outage: on recovery every file is
            // re-examined from scratch, which is what makes the catch-up sweep
            // pick up whatever landed while the folder was gone (R3.7).
            state.tracked.clear();
            return Err(FolderUnavailable(error.to_string()));
        }
    };

    state.available = Some(true);

    let mut report = SweepReport::default();
    let mut seen: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            // A file that vanished between listing and stat is simply not there
            // yet as far as this sweep is concerned.
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_transient_artifact(file_name) {
            continue;
        }
        // A zero-byte file is a placeholder a scanner has just created, never a
        // finished scan. Ignored outright like the other in-progress artifacts;
        // once it has bytes the stability gate starts from there.
        if metadata.len() == 0 {
            continue;
        }

        seen.push(path.clone());

        let fingerprint = Fingerprint {
            size: metadata.len(),
            mtime_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|delta| delta.as_millis() as i64)
                .unwrap_or_default(),
        };

        match state.tracked.get(&path) {
            // Same bytes as last time and already decided — nothing to do.
            Some(tracked) if tracked.fingerprint == fingerprint && tracked.decided.is_some() => {
                continue;
            }
            // Same bytes as last time, but not yet settled long enough.
            Some(tracked)
                if tracked.fingerprint == fingerprint
                    && now_ms.saturating_sub(tracked.first_seen_ms) < STABILITY_WINDOW_MS =>
            {
                continue;
            }
            // Still growing (or seen for the first time): restart the window.
            Some(tracked) if tracked.fingerprint != fingerprint => {
                state.tracked.insert(
                    path.clone(),
                    Tracked {
                        fingerprint,
                        first_seen_ms: now_ms,
                        decided: None,
                    },
                );
                continue;
            }
            None => {
                state.tracked.insert(
                    path.clone(),
                    Tracked {
                        fingerprint,
                        first_seen_ms: now_ms,
                        decided: None,
                    },
                );
                continue;
            }
            // Stable, undecided, window elapsed — fall through and decide.
            Some(_) => {}
        }

        match decide_file(conn, app_data_dir, source, &path, file_name, fingerprint) {
            Ok(decision) => {
                state.tracked.insert(
                    path.clone(),
                    Tracked {
                        fingerprint,
                        first_seen_ms: now_ms,
                        decided: Some(decision.outcome),
                    },
                );

                if decision.outcome == CaptureIngestOutcome::Ingested
                    && source.housekeeping == Housekeeping::MoveDone
                {
                    // Opt-in only, and never allowed to fail the ingest: the
                    // document is already durable and ledger-recorded, so a
                    // failed move is untidy, not lossy.
                    if let Err(error) = move_to_done(&source.folder, &path) {
                        warn!(source = %source.name, %error, "Capture housekeeping move failed");
                    } else {
                        state.tracked.remove(&path);
                        seen.pop();
                    }
                }

                report.decisions.push(decision);
            }
            Err(error) => {
                // A read that failed (writer still holding the file, transient
                // share hiccup) is not a decision: leave the candidate
                // undecided so the next sweep tries again.
                warn!(path = %path.display(), %error, "Capture ingest deferred");
                state.tracked.insert(
                    path.clone(),
                    Tracked {
                        fingerprint,
                        first_seen_ms: now_ms,
                        decided: None,
                    },
                );
            }
        }
    }

    // Forget files that are gone, so the tracker cannot grow without bound in a
    // folder the user empties regularly.
    state.tracked.retain(|path, _| seen.contains(path));

    Ok(report)
}

fn is_transient_artifact(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.starts_with('.')
        || lower.starts_with('~')
        || TRANSIENT_SUFFIXES
            .iter()
            .any(|suffix| lower.ends_with(suffix))
}

fn supported_mime(file_name: &str) -> Option<&'static str> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    SUPPORTED_EXTENSIONS
        .iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, mime)| *mime)
}

/// Bytes plus the hash that identifies them in the ledger.
struct Candidate {
    hash: String,
    bytes: Option<Vec<u8>>,
    oversize: bool,
}

/// Read a candidate exactly once, bounded.
///
/// Reading `MAX_CAPTURE_PAGE_BYTES + 1` settles both questions in one pass:
/// anything we could actually ingest arrives whole (so its ledger hash is the
/// true whole-document hash `capture_documents.content_hash` promises), and
/// anything oversize is identified by its bounded prefix plus its exact length
/// — still content-derived, so two copies of the same oversize file under
/// different names still collapse to one ledger row, without ever reading a
/// multi-gigabyte file off a network share.
///
/// The read is also the readability half of the stability gate: on Windows a
/// process still writing the file without share-read makes this fail, and a
/// failed read defers the decision rather than making one.
fn read_candidate(path: &Path, size: u64) -> Result<Candidate, String> {
    let limit = MAX_CAPTURE_PAGE_BYTES;
    let mut file = fs::File::open(path).map_err(|e| format!("open candidate: {e}"))?;
    let mut buffer = Vec::with_capacity((size.min(limit) as usize).saturating_add(1));
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut buffer)
        .map_err(|e| format!("read candidate: {e}"))?;

    if buffer.len() as u64 > limit {
        buffer.truncate(limit as usize);
        let mut identity = buffer;
        identity.extend_from_slice(format!(":{size}").as_bytes());
        return Ok(Candidate {
            hash: files::sha256_hex(&identity),
            bytes: None,
            oversize: true,
        });
    }

    Ok(Candidate {
        hash: files::sha256_hex(&buffer),
        bytes: Some(buffer),
        oversize: false,
    })
}

/// Classify one stable, readable file and act on it.
fn decide_file(
    conn: &Connection,
    app_data_dir: &Path,
    source: &WatchedFolderSource,
    path: &Path,
    file_name: &str,
    fingerprint: Fingerprint,
) -> Result<IngestDecision, String> {
    let candidate = read_candidate(path, fingerprint.size)?;
    let mime = supported_mime(file_name);
    let known = store::ledger_entry(conn, &candidate.hash)?;

    // Order matters: an unsupported type is refused on its extension alone, so
    // a huge unrelated file is never judged on size it was never eligible for.
    let outcome = if mime.is_none() {
        CaptureIngestOutcome::SkippedUnsupported
    } else if candidate.oversize {
        CaptureIngestOutcome::SkippedOversize
    } else if known.is_some() {
        CaptureIngestOutcome::SkippedDuplicate
    } else {
        CaptureIngestOutcome::Ingested
    };

    if outcome != CaptureIngestOutcome::Ingested {
        return record_skip(conn, path, &candidate.hash, outcome, known.as_ref());
    }

    let bytes = candidate
        .bytes
        .ok_or_else(|| "Captured document is empty".to_string())?;
    let mime = mime.unwrap_or("application/pdf");
    ingest_document(
        conn,
        app_data_dir,
        source,
        path,
        mime,
        &bytes,
        &candidate.hash,
    )
}

/// Record a refusal, on two different "once" rules (R3.4, R3.5, R12.2).
///
/// - The **ledger row** is once per content hash. That is the durable,
///   restart-surviving record, and it is what keeps a duplicate a duplicate
///   forever.
/// - The **history event** is once per `(hash, file name)`. A *new* copy of an
///   already-known document is a new thing the user should see skipped rather
///   than have silently discarded (R3.4); the same file still sitting in the
///   folder across a hundred sweeps and a restart is not, so it never repeats
///   (R3.5's "rather than raising repeated errors").
///
/// The two rules differ because the duplicate case can never insert a ledger
/// row — the hash is already there as `ingested` — so the ledger alone cannot
/// tell "seen again" from "never seen".
///
/// `known` is the ledger row this content already had, if any. When it names
/// *this same file*, nothing happened worth telling the user about: it is the
/// file we ingested, being looked at again after a restart — not a copy someone
/// dropped in.
fn record_skip(
    conn: &Connection,
    path: &Path,
    hash: &str,
    outcome: CaptureIngestOutcome,
    known: Option<&IngestLedgerEntry>,
) -> Result<IngestDecision, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let path_text = path.to_string_lossy().to_string();
    let is_the_same_file_again = known
        .and_then(|entry| entry.source_path.as_deref())
        .is_some_and(|source_path| source_path == path_text);

    store::record_ingest(
        conn,
        &IngestLedgerEntry {
            content_hash: hash.to_string(),
            source_path: Some(path_text),
            capture_id: None,
            outcome,
            seen_at: Utc::now().to_rfc3339(),
        },
    )?;

    if !is_the_same_file_again && !skip_already_in_history(conn, hash, file_name)? {
        store::record_event(
            conn,
            None,
            "ingest_skipped",
            None,
            Some(&serde_json::json!({
                "outcome": outcome.as_str(),
                "file_name": file_name,
                "content_hash": hash,
            })),
        )?;
    }

    Ok(IngestDecision {
        path: path.to_path_buf(),
        outcome,
        capture_id: None,
        needs_render: false,
        original_path: None,
    })
}

/// Whether this exact `(content, file name)` skip is already in the history.
fn skip_already_in_history(conn: &Connection, hash: &str, file_name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM capture_events
          WHERE event_type = 'ingest_skipped'
            AND json_extract(details_json, '$.content_hash') = ?1
            AND json_extract(details_json, '$.file_name') = ?2
          LIMIT 1",
        rusqlite::params![hash, file_name],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|e| format!("read capture skip history: {e}"))
}

/// Copy one file into the capture store as a new document.
///
/// Ordering is the durability contract: bytes land in app-protected storage
/// *first* (R11.1, R17.5), and only then does a single transaction create the
/// document, its page (images) and its ledger row. If the process dies between
/// the two, the ledger has no row, so the next sweep re-ingests under a fresh
/// capture id — a stray unreferenced page directory is the worst case, and a
/// lost invoice is impossible.
fn ingest_document(
    conn: &Connection,
    app_data_dir: &Path,
    source: &WatchedFolderSource,
    path: &Path,
    mime: &str,
    bytes: &[u8],
    hash: &str,
) -> Result<IngestDecision, String> {
    let capture_id = uuid::Uuid::new_v4().to_string();
    let is_pdf = mime == "application/pdf";

    let original_path = if is_pdf {
        Some(files::write_original_blocking(
            app_data_dir,
            &capture_id,
            bytes,
        )?)
    } else {
        None
    };
    let page = if is_pdf {
        None
    } else {
        Some(files::write_page_blocking(
            app_data_dir,
            &capture_id,
            0,
            mime,
            bytes,
        )?)
    };

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin capture ingest: {e}"))?;

    store::create_document(
        &tx,
        &NewCaptureDocument {
            id: capture_id.clone(),
            source_kind: CaptureSourceKind::WatchedFolder,
            source_name: Some(source.name.clone()),
            // A watched-folder arrival has no operator standing at the terminal;
            // the committing staff member is recorded at commit (R13.2).
            staff_id: None,
            captured_at: Utc::now().to_rfc3339(),
            content_hash: Some(hash.to_string()),
        },
    )?;

    if let Some(page) = page.as_ref() {
        store::record_page(&tx, &capture_id, page)?;
        // An image arrives complete: the document is finished the moment it is
        // copied in, so it goes straight onto the worker's queue.
        store::set_status(&tx, &capture_id, CaptureStatus::Waiting, None)?;
    }
    // A PDF stays `capturing` until the renderer hands its pages back through
    // `capture_attach_rendered_pages` (D1).

    store::record_ingest(
        &tx,
        &IngestLedgerEntry {
            content_hash: hash.to_string(),
            source_path: Some(path.to_string_lossy().to_string()),
            capture_id: Some(capture_id.clone()),
            outcome: CaptureIngestOutcome::Ingested,
            seen_at: Utc::now().to_rfc3339(),
        },
    )?;

    store::record_event(
        &tx,
        Some(&capture_id),
        "ingested",
        None,
        Some(&serde_json::json!({
            "source_id": source.id,
            "source_name": source.name,
            "file_name": path.file_name().and_then(|n| n.to_str()),
            "content_hash": hash,
            "mime": mime,
        })),
    )?;

    tx.commit()
        .map_err(|e| format!("commit capture ingest: {e}"))?;

    Ok(IngestDecision {
        path: path.to_path_buf(),
        outcome: CaptureIngestOutcome::Ingested,
        capture_id: Some(capture_id),
        needs_render: is_pdf,
        original_path,
    })
}

/// Opt-in housekeeping: move an ingested file into `{folder}/Done/`.
///
/// Never called unless the user switched it on for this source. Collisions get
/// a numeric suffix rather than overwriting the user's file — this is their
/// storage, and even in "tidy up" mode nothing of theirs is destroyed.
fn move_to_done(folder: &Path, path: &Path) -> Result<(), String> {
    let done = folder.join(DONE_SUBFOLDER);
    fs::create_dir_all(&done).map_err(|e| format!("create Done folder: {e}"))?;

    let file_name = path
        .file_name()
        .ok_or_else(|| "file has no name".to_string())?;
    let mut target = done.join(file_name);
    if target.exists() {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("scan")
            .to_string();
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|value| format!(".{value}"))
            .unwrap_or_default();
        for suffix in 1..1_000u32 {
            let candidate = done.join(format!("{stem} ({suffix}){extension}"));
            if !candidate.exists() {
                target = candidate;
                break;
            }
        }
    }

    fs::rename(path, &target).map_err(|e| format!("move to Done: {e}"))
}

// ---------------------------------------------------------------------------
// Renderer-side PDF rasterization (D1)
// ---------------------------------------------------------------------------

/// One page the renderer rasterized out of a retained PDF.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPageInput {
    pub page_index: usize,
    pub mime: String,
    /// Base64 image bytes, as produced by `pdfjs-dist` in the renderer.
    pub data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachRenderedPagesResult {
    pub success: bool,
    pub capture_id: String,
    pub page_count: usize,
    pub status: String,
}

/// Accept the pages the renderer rasterized for a watched-folder PDF.
///
/// The Rust side deliberately owns no PDF renderer (D1 — bundling pdfium was
/// rejected for binary size and packaging risk), so this is the return leg of
/// [`EVENT_NEEDS_RENDER`]: the frontend rasterizes with the already-bundled
/// `pdfjs-dist` and hands the pages back here, where they are written durably
/// and the document is finished onto the worker's queue.
///
/// `failure_reason` is the corrupt/unrenderable path (R12.4): the document
/// becomes `needs_attention` with a stated reason and the original PDF stays on
/// disk, available to the user, rather than being lost.
///
/// Lives in this module rather than `commands/` because it is one half of the
/// watched-folder engine's PDF handling and is meaningless without it.
#[tauri::command]
pub async fn capture_attach_rendered_pages(
    app: tauri::AppHandle,
    db: tauri::State<'_, db::DbState>,
    capture_id: String,
    pages: Vec<RenderedPageInput>,
    failure_reason: Option<String>,
) -> Result<AttachRenderedPagesResult, String> {
    files::sanitize_path_segment("capture_id", &capture_id)?;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;

    {
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        store::get_document(&conn, &capture_id)?
            .ok_or_else(|| format!("Capture {capture_id} not found"))?;
    }

    // Rasterization failed, or produced nothing usable: keep the document and
    // its original, state the reason, and let the user retry or type it in.
    if let Some(reason) = failure_reason.filter(|value| !value.trim().is_empty()) {
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        finish_needs_attention(&conn, &capture_id, &reason)?;
        return Ok(AttachRenderedPagesResult {
            success: true,
            capture_id,
            page_count: 0,
            status: CaptureStatus::NeedsAttention.as_str().to_string(),
        });
    }

    if pages.is_empty() {
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        finish_needs_attention(&conn, &capture_id, "render_failed")?;
        return Ok(AttachRenderedPagesResult {
            success: true,
            capture_id,
            page_count: 0,
            status: CaptureStatus::NeedsAttention.as_str().to_string(),
        });
    }

    if pages.len() > MAX_CAPTURE_PAGES {
        // A document longer than one invoice can be. Keep it and say so rather
        // than silently truncating evidence.
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        finish_needs_attention(&conn, &capture_id, "too_many_pages")?;
        return Ok(AttachRenderedPagesResult {
            success: true,
            capture_id,
            page_count: 0,
            status: CaptureStatus::NeedsAttention.as_str().to_string(),
        });
    }

    let mut ordered = pages;
    ordered.sort_by_key(|page| page.page_index);

    let mut written = Vec::with_capacity(ordered.len());
    for (index, page) in ordered.iter().enumerate() {
        let bytes = BASE64_STANDARD
            .decode(page.data.as_bytes())
            .map_err(|e| format!("decode rendered page {index}: {e}"))?;
        // Pages are re-indexed densely: the renderer's page numbering is a
        // detail, document order is what the store and the server contract on.
        written.push(
            files::write_page(
                app_data_dir.clone(),
                capture_id.clone(),
                index,
                page.mime.clone(),
                bytes,
            )
            .await?,
        );
    }

    let page_count = written.len();
    {
        let conn = db.conn.lock().map_err(|e| format!("db lock: {e}"))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("begin attach pages: {e}"))?;
        for page in &written {
            store::record_page(&tx, &capture_id, page)?;
        }
        store::set_status(&tx, &capture_id, CaptureStatus::Waiting, None)?;
        store::record_event(
            &tx,
            Some(&capture_id),
            "pages_rendered",
            None,
            Some(&serde_json::json!({ "page_count": page_count })),
        )?;
        tx.commit()
            .map_err(|e| format!("commit attach pages: {e}"))?;
    }

    Ok(AttachRenderedPagesResult {
        success: true,
        capture_id,
        page_count,
        status: CaptureStatus::Waiting.as_str().to_string(),
    })
}

fn finish_needs_attention(conn: &Connection, capture_id: &str, reason: &str) -> Result<(), String> {
    // `needs_attention` is not reachable from `capturing` — a document whose
    // pages never materialized has to be finished first. The original PDF is
    // untouched by either move.
    store::set_status(conn, capture_id, CaptureStatus::Waiting, None)?;
    store::set_status(
        conn,
        capture_id,
        CaptureStatus::NeedsAttention,
        Some(reason),
    )
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/// Start the watched-folder engine.
///
/// Registered in `lib.rs` `.setup()` with the standard `CancellationToken` and
/// its own `db::init` connection, exactly like the other background workers.
///
/// One supervisor task drives every configured folder rather than one task per
/// folder: sources are added and forgotten from the scan-settings modal at
/// runtime, so the set has to be re-read each tick anyway, and a supervisor
/// makes "a source appeared / disappeared" a plain map update instead of task
/// lifecycle juggling. Per-source state is still fully isolated
/// ([`FolderWatchState`] per source id).
///
/// Ordering per R3.8: each folder is swept **before** its `notify` watcher is
/// registered, so files that arrived while the POS was closed are ingested on
/// startup rather than waiting for the next change notification.
pub fn start_watched_folder_worker(
    app: tauri::AppHandle,
    db: Arc<db::DbState>,
    app_data_dir: PathBuf,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    let cadence = Duration::from_secs(interval_secs.max(1));

    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let mut watchers: HashMap<String, RecommendedWatcher> = HashMap::new();
        let mut states: HashMap<String, FolderWatchState> = HashMap::new();

        info!(
            interval_secs = cadence.as_secs(),
            "Invoice capture watched-folder worker started"
        );

        loop {
            let now_ms = started.elapsed().as_millis() as u64;
            let sources = {
                match db.conn.lock() {
                    Ok(conn) => load_watched_folder_sources(&conn),
                    Err(error) => {
                        warn!(%error, "Capture watcher could not read its source list");
                        Vec::new()
                    }
                }
            };

            // A forgotten source stops being watched immediately; its captures
            // are untouched (R2.6).
            let live: Vec<String> = sources.iter().map(|source| source.id.clone()).collect();
            watchers.retain(|id, _| live.contains(id));
            states.retain(|id, _| live.contains(id));

            for source in &sources {
                let mut state = states.remove(&source.id).unwrap_or_default();
                let was_available = state.available;

                let db_for_sweep = Arc::clone(&db);
                let dir_for_sweep = app_data_dir.clone();
                let source_for_sweep = source.clone();

                // Disk I/O over a possibly-hung network share must never park a
                // runtime worker thread.
                let joined = tokio::task::spawn_blocking(move || {
                    let result = match db_for_sweep.conn.lock() {
                        Ok(conn) => sweep_folder(
                            &conn,
                            &dir_for_sweep,
                            &source_for_sweep,
                            &mut state,
                            now_ms,
                        ),
                        Err(error) => Err(FolderUnavailable(format!("db lock: {error}"))),
                    };
                    (state, result)
                })
                .await;

                let (state, result) = match joined {
                    Ok(value) => value,
                    Err(error) => {
                        warn!(source = %source.name, %error, "Capture folder sweep task failed");
                        continue;
                    }
                };
                states.insert(source.id.clone(), state);

                match result {
                    Ok(report) => {
                        for decision in &report.decisions {
                            emit_decision(&app, source, decision);
                        }
                        // Only after the folder has been swept does the change
                        // watcher go on — R3.8's startup catch-up.
                        if !watchers.contains_key(&source.id) {
                            match spawn_notify_watcher(&source.folder, event_tx.clone()) {
                                Ok(watcher) => {
                                    watchers.insert(source.id.clone(), watcher);
                                }
                                Err(error) => {
                                    // Not fatal: the poll sweep alone already
                                    // meets the SLA, notifications only make it
                                    // faster.
                                    warn!(source = %source.name, %error, "Capture folder change notifications unavailable; polling only");
                                }
                            }
                        }
                        if was_available != Some(true) {
                            emit_source_status(&app, source, "watching", None);
                        }
                    }
                    Err(FolderUnavailable(reason)) => {
                        watchers.remove(&source.id);
                        if was_available != Some(false) {
                            warn!(source = %source.name, %reason, "Capture folder unavailable");
                            emit_source_status(&app, source, "unavailable", Some(&reason));
                        }
                    }
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(cadence) => {}
                _ = event_rx.recv() => {
                    // A change notification only shortens the wait; the sweep
                    // above is what decides anything. Drain the burst an MFP
                    // produces while writing one file so it costs one sweep.
                    while event_rx.try_recv().is_ok() {}
                }
                _ = cancel.cancelled() => {
                    info!("Invoice capture watched-folder worker cancelled");
                    break;
                }
            }
        }
    });
}

fn spawn_notify_watcher(
    folder: &Path,
    tx: UnboundedSender<()>,
) -> Result<RecommendedWatcher, String> {
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if result.is_ok() {
            // Payload deliberately discarded: the event is a hint to sweep
            // sooner, never a description of what to ingest.
            let _ = tx.send(());
        }
    })
    .map_err(|e| format!("create folder watcher: {e}"))?;

    watcher
        .watch(folder, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch folder: {e}"))?;

    Ok(watcher)
}

fn emit_decision(app: &tauri::AppHandle, source: &WatchedFolderSource, decision: &IngestDecision) {
    if decision.outcome != CaptureIngestOutcome::Ingested {
        return;
    }
    let Some(capture_id) = decision.capture_id.as_deref() else {
        return;
    };
    let file_name = decision
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    if decision.needs_render {
        let _ = app.emit(
            EVENT_NEEDS_RENDER,
            serde_json::json!({
                "captureId": capture_id,
                "sourceId": source.id,
                "sourceName": source.name,
                "fileName": file_name,
                "originalPath": decision
                    .original_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string()),
            }),
        );
    }

    let _ = app.emit(
        EVENT_DOCUMENT_ARRIVED,
        serde_json::json!({
            "captureId": capture_id,
            "sourceId": source.id,
            "sourceName": source.name,
            "sourceKind": CaptureSourceKind::WatchedFolder.as_str(),
            "fileName": file_name,
            "needsRender": decision.needs_render,
        }),
    );
}

fn emit_source_status(
    app: &tauri::AppHandle,
    source: &WatchedFolderSource,
    status: &str,
    reason: Option<&str>,
) {
    let _ = app.emit(
        EVENT_SOURCE_STATUS,
        serde_json::json!({
            "sourceId": source.id,
            "sourceName": source.name,
            "sourceKind": CaptureSourceKind::WatchedFolder.as_str(),
            "status": status,
            "reason": reason,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::harness::TestDb;

    /// Every test drives the poll path directly with an explicit clock — no
    /// sleeps, no filesystem events, no timing races.
    struct Folder {
        db: TestDb,
        dir: PathBuf,
        source: WatchedFolderSource,
        state: FolderWatchState,
        clock_ms: u64,
    }

    impl Folder {
        fn new() -> Self {
            Self::with_housekeeping(Housekeeping::None)
        }

        fn with_housekeeping(housekeeping: Housekeeping) -> Self {
            let db = TestDb::open();
            let dir = db.dir().join("scan-folder");
            fs::create_dir_all(&dir).expect("create watched folder");
            let source = WatchedFolderSource {
                id: "source-1".to_string(),
                name: "Back office scanner".to_string(),
                folder: dir.clone(),
                housekeeping,
            };
            Self {
                db,
                dir,
                source,
                state: FolderWatchState::new(),
                clock_ms: 0,
            }
        }

        fn drop_file(&self, name: &str, bytes: &[u8]) {
            fs::write(self.dir.join(name), bytes).expect("write folder file");
        }

        /// Advance the clock past the stability window and sweep.
        fn sweep_after(&mut self, advance_ms: u64) -> SweepReport {
            self.clock_ms += advance_ms;
            let conn = self.db.state.conn.lock().expect("lock");
            sweep_folder(
                &conn,
                self.db.dir(),
                &self.source,
                &mut self.state,
                self.clock_ms,
            )
            .expect("folder reachable")
        }

        /// The two sweeps every settled file needs: one to observe, one to act.
        fn settle_and_sweep(&mut self) -> SweepReport {
            self.sweep_after(0);
            self.sweep_after(STABILITY_WINDOW_MS + 100)
        }

        fn documents(&self) -> Vec<store::CaptureDocument> {
            let conn = self.db.state.conn.lock().expect("lock");
            store::list_open_documents(&conn).expect("list documents")
        }

        fn ledger_rows(&self) -> i64 {
            let conn = self.db.state.conn.lock().expect("lock");
            conn.query_row("SELECT COUNT(*) FROM capture_ingest_ledger", [], |row| {
                row.get(0)
            })
            .expect("count ledger")
        }

        fn ledger_rows_with(&self, outcome: CaptureIngestOutcome) -> i64 {
            let conn = self.db.state.conn.lock().expect("lock");
            conn.query_row(
                "SELECT COUNT(*) FROM capture_ingest_ledger WHERE outcome = ?1",
                rusqlite::params![outcome.as_str()],
                |row| row.get(0),
            )
            .expect("count ledger by outcome")
        }

        fn skip_events(&self) -> i64 {
            let conn = self.db.state.conn.lock().expect("lock");
            conn.query_row(
                "SELECT COUNT(*) FROM capture_events WHERE event_type = 'ingest_skipped'",
                [],
                |row| row.get(0),
            )
            .expect("count skip events")
        }
    }

    #[test]
    fn a_growing_file_is_held_until_it_stops_changing_then_ingested_exactly_once() {
        let mut folder = Folder::new();
        folder.drop_file("invoice.png", b"first-half");

        // Observation only — nothing is read on the sweep that first sees a file.
        let first = folder.sweep_after(0);
        assert!(
            first.decisions.is_empty(),
            "a freshly-seen file must not be ingested on sight"
        );
        assert!(folder.documents().is_empty());

        // The MFP is still writing: the fingerprint changed, so the window
        // restarts and the file is still not touched.
        folder.drop_file("invoice.png", b"first-half-and-the-rest");
        let growing = folder.sweep_after(STABILITY_WINDOW_MS + 100);
        assert!(
            growing.decisions.is_empty(),
            "a file whose size changed must restart the stability window"
        );
        assert!(folder.documents().is_empty());

        // Settled: one sweep to re-observe the new fingerprint, one to act.
        let ingested = folder.sweep_after(STABILITY_WINDOW_MS + 100);
        assert_eq!(ingested.decisions.len(), 1);
        assert_eq!(
            ingested.decisions[0].outcome,
            CaptureIngestOutcome::Ingested
        );

        let documents = folder.documents();
        assert_eq!(documents.len(), 1, "exactly one document");
        assert_eq!(documents[0].source_kind, "watched_folder");
        assert_eq!(
            documents[0].source_name.as_deref(),
            Some("Back office scanner")
        );
        assert_eq!(documents[0].page_count, 1);
        assert_eq!(
            documents[0].status,
            CaptureStatus::Waiting,
            "a complete image goes straight onto the worker's queue"
        );

        // The source file is untouched — the read-only guarantee (R17.5).
        assert_eq!(
            fs::read(folder.dir.join("invoice.png")).expect("source file survives"),
            b"first-half-and-the-rest"
        );

        // Sweeping again forever changes nothing.
        for _ in 0..3 {
            let repeat = folder.sweep_after(STABILITY_WINDOW_MS + 100);
            assert!(
                repeat.decisions.is_empty(),
                "a settled file is decided once"
            );
        }
        assert_eq!(folder.documents().len(), 1);
    }

    #[test]
    fn identical_content_is_deduped_across_a_restart_by_the_ledger() {
        let mut folder = Folder::new();
        folder.drop_file("invoice.png", b"the-same-invoice-bytes");
        let report = folder.settle_and_sweep();
        assert_eq!(report.decisions[0].outcome, CaptureIngestOutcome::Ingested);
        assert_eq!(folder.documents().len(), 1);

        // Restart the POS: in-memory sweep state is gone, the ledger is not.
        let Folder {
            db,
            dir,
            source,
            clock_ms,
            ..
        } = folder;
        let mut folder = Folder {
            db: db.restart(),
            dir,
            source,
            state: FolderWatchState::new(),
            clock_ms,
        };

        // The same bytes, under a different name — a second copy of one scan.
        folder.drop_file("invoice-copy.png", b"the-same-invoice-bytes");
        let report = folder.settle_and_sweep();

        let duplicate = report
            .decisions
            .iter()
            .find(|decision| decision.path.ends_with("invoice-copy.png"))
            .expect("the copy was decided");
        assert_eq!(duplicate.outcome, CaptureIngestOutcome::SkippedDuplicate);
        assert!(duplicate.capture_id.is_none());

        assert_eq!(
            folder.documents().len(),
            1,
            "identical content never produces a second document"
        );
        // Both files were re-examined after the restart, but only the new copy
        // is news: the skip the user dropped in is visible in history (R3.4),
        // while the original being recognized as the document it already
        // produced adds nothing.
        assert_eq!(report.decisions.len(), 2);
        assert_eq!(folder.skip_events(), 1);

        // The original file was re-examined after the restart and recognized
        // from the ledger too — still exactly one document.
        let again = folder.sweep_after(STABILITY_WINDOW_MS + 100);
        assert!(again.decisions.is_empty());
        assert_eq!(folder.documents().len(), 1);
    }

    #[test]
    fn unsupported_and_oversize_files_are_recorded_once_per_hash() {
        let mut folder = Folder::new();
        folder.drop_file("notes.txt", b"not an invoice");
        folder.drop_file("scan.docx", b"also not an invoice");
        folder.drop_file(
            "huge.pdf",
            &vec![7u8; (MAX_CAPTURE_PAGE_BYTES + 1) as usize],
        );

        let report = folder.settle_and_sweep();
        assert_eq!(report.decisions.len(), 3);
        assert_eq!(
            folder.ledger_rows_with(CaptureIngestOutcome::SkippedUnsupported),
            2
        );
        assert_eq!(
            folder.ledger_rows_with(CaptureIngestOutcome::SkippedOversize),
            1
        );
        assert_eq!(folder.skip_events(), 3, "one visible skip per file");
        assert!(
            folder.documents().is_empty(),
            "nothing refused becomes a document"
        );

        // Repeated sweeps must not raise repeated errors (R3.5) — the same
        // files, still sitting there, add nothing to either record.
        for _ in 0..3 {
            folder.sweep_after(STABILITY_WINDOW_MS + 100);
        }
        assert_eq!(folder.ledger_rows(), 3);
        assert_eq!(folder.skip_events(), 3);

        // A second copy of the same unsupported bytes is the same *content*, so
        // it adds no ledger row — but it is a different file the user just
        // dropped in, so the history says so once.
        folder.drop_file("notes-copy.txt", b"not an invoice");
        folder.settle_and_sweep();
        assert_eq!(
            folder.ledger_rows(),
            3,
            "the ledger is keyed by content, once per hash"
        );
        assert_eq!(folder.skip_events(), 4);

        // ...and that one time does not become every time.
        for _ in 0..3 {
            folder.sweep_after(STABILITY_WINDOW_MS + 100);
        }
        assert_eq!(folder.skip_events(), 4);

        // Every refused file is still exactly where the user left it.
        for name in ["notes.txt", "scan.docx", "huge.pdf", "notes-copy.txt"] {
            assert!(folder.dir.join(name).exists(), "{name} must survive");
        }
    }

    #[test]
    fn an_unreachable_folder_reports_unavailable_and_catches_up_on_recovery() {
        let mut folder = Folder::new();
        folder.drop_file("first.png", b"before-the-outage");
        folder.settle_and_sweep();
        assert_eq!(folder.documents().len(), 1);
        assert!(folder.state.is_available());

        // The share drops. Files keep arriving on the MFP side; the POS cannot
        // see them.
        let stash = folder.db.dir().join("offline-stash");
        fs::create_dir_all(&stash).expect("stash dir");
        fs::rename(&folder.dir, stash.join("scan-folder")).expect("take the folder away");

        folder.clock_ms += STABILITY_WINDOW_MS + 100;
        {
            let conn = folder.db.state.conn.lock().expect("lock");
            let outcome = sweep_folder(
                &conn,
                folder.db.dir(),
                &folder.source,
                &mut folder.state,
                folder.clock_ms,
            );
            assert!(outcome.is_err(), "a missing folder is unavailable");
        }
        assert!(!folder.state.is_available());

        // While unavailable the folder is probed on the slower cadence, not on
        // every sweep.
        folder.clock_ms += 1_000;
        {
            let conn = folder.db.state.conn.lock().expect("lock");
            let report = sweep_folder(
                &conn,
                folder.db.dir(),
                &folder.source,
                &mut folder.state,
                folder.clock_ms,
            )
            .expect("probe deferred, not attempted");
            assert!(report.skipped_probe, "probe must back off to 30 s");
        }

        // The share comes back, with what arrived while it was gone.
        fs::rename(stash.join("scan-folder"), &folder.dir).expect("restore the folder");
        folder.drop_file("during-outage.png", b"arrived-while-offline");

        folder.clock_ms += UNAVAILABLE_PROBE_SECS * 1_000;
        let catch_up = folder.settle_and_sweep();
        assert!(folder.state.is_available());
        assert!(
            catch_up
                .decisions
                .iter()
                .any(|decision| decision.path.ends_with("during-outage.png")
                    && decision.outcome == CaptureIngestOutcome::Ingested),
            "recovery must ingest what appeared while the folder was gone",
        );
        // The pre-outage file is still just one document — the ledger held.
        assert_eq!(folder.documents().len(), 2);
    }

    #[test]
    fn a_startup_sweep_ingests_files_that_appeared_while_the_pos_was_closed() {
        // The POS was never running when these landed: no watcher existed, no
        // event was ever delivered. Only the sweep can find them (R3.8).
        let mut folder = Folder::new();
        folder.drop_file("closed-1.png", b"arrived-while-closed-1");
        folder.drop_file("closed-2.jpg", b"arrived-while-closed-2");
        folder.drop_file("closed-3.pdf", b"%PDF-1.4 arrived-while-closed-3");

        let report = folder.settle_and_sweep();
        assert_eq!(report.arrived().count(), 3);
        assert_eq!(folder.documents().len(), 3);
    }

    #[test]
    fn a_pdf_is_kept_whole_and_waits_for_the_renderer_to_rasterize_it() {
        let mut folder = Folder::new();
        folder.drop_file("delivery-note.pdf", b"%PDF-1.7 two pages worth of invoice");

        let report = folder.settle_and_sweep();
        assert_eq!(report.decisions.len(), 1);
        let decision = &report.decisions[0];
        assert_eq!(decision.outcome, CaptureIngestOutcome::Ingested);
        assert!(decision.needs_render, "PDFs are rasterized in the renderer");

        let original = decision.original_path.clone().expect("original retained");
        assert_eq!(
            fs::read(&original).expect("read retained original"),
            b"%PDF-1.7 two pages worth of invoice",
            "the PDF is retained verbatim as evidence",
        );
        assert!(original.ends_with("original.pdf"));

        let documents = folder.documents();
        assert_eq!(documents.len(), 1);
        assert_eq!(
            documents[0].status,
            CaptureStatus::Capturing,
            "a PDF is not queued for recognition until its pages exist",
        );
        assert_eq!(documents[0].page_count, 0);
    }

    #[test]
    fn opt_in_housekeeping_moves_an_ingested_file_and_never_re_ingests_it() {
        let mut folder = Folder::with_housekeeping(Housekeeping::MoveDone);
        folder.drop_file("invoice.png", b"tidy-me-away");

        let report = folder.settle_and_sweep();
        assert_eq!(report.decisions[0].outcome, CaptureIngestOutcome::Ingested);

        assert!(
            !folder.dir.join("invoice.png").exists(),
            "the ingested file moved out of the watch root"
        );
        assert_eq!(
            fs::read(folder.dir.join(DONE_SUBFOLDER).join("invoice.png")).expect("moved copy"),
            b"tidy-me-away",
            "housekeeping moves, never deletes",
        );

        // The Done subfolder is excluded from sweeps, so nothing loops.
        for _ in 0..3 {
            let repeat = folder.sweep_after(STABILITY_WINDOW_MS + 100);
            assert!(repeat.decisions.is_empty());
        }
        assert_eq!(folder.documents().len(), 1);
    }

    #[test]
    fn housekeeping_is_off_unless_the_user_switched_it_on() {
        let mut folder = Folder::new();
        folder.drop_file("invoice.png", b"leave-me-alone");
        folder.settle_and_sweep();

        assert!(
            folder.dir.join("invoice.png").exists(),
            "the default is read-only: the user's file stays put",
        );
        assert!(!folder.dir.join(DONE_SUBFOLDER).exists());
    }

    #[test]
    fn in_progress_scanner_artifacts_are_ignored_without_history_noise() {
        let mut folder = Folder::new();
        folder.drop_file("scan.png.tmp", b"still being written");
        folder.drop_file(".hidden", b"system artifact");

        let report = folder.settle_and_sweep();
        assert!(report.decisions.is_empty());
        assert_eq!(folder.ledger_rows(), 0);
        assert_eq!(folder.skip_events(), 0);
    }

    #[test]
    fn only_watched_folder_entries_with_a_real_path_are_loaded() {
        let db = TestDb::open();
        let conn = db.state.conn.lock().expect("lock");

        db::set_setting(
            &conn,
            LOCAL_SETTINGS_CATEGORY,
            SOURCES_SETTING_KEY,
            &serde_json::json!([
                {
                    "id": "folder-1",
                    "kind": "watched_folder",
                    "name": "Office MFP",
                    "isDefault": true,
                    "folderPath": "C:/scans",
                    "housekeeping": "move_done"
                },
                {
                    "id": "folder-2",
                    "kind": "watched_folder",
                    "name": "Plain",
                    "isDefault": false,
                    "folderPath": "C:/other"
                },
                // A scanner source is not this engine's business.
                { "id": "wia-1", "kind": "connected_scanner", "name": "Desk scanner", "isDefault": false, "deviceId": "wia:1" },
                // Malformed entries are skipped, never fatal.
                { "id": "folder-3", "kind": "watched_folder", "name": "No path", "isDefault": false },
                { "kind": "watched_folder", "name": "No id", "isDefault": false, "folderPath": "C:/nope" }
            ])
            .to_string(),
        )
        .expect("store sources");

        let sources = load_watched_folder_sources(&conn);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].id, "folder-1");
        assert_eq!(sources[0].housekeeping, Housekeeping::MoveDone);
        assert_eq!(
            sources[1].housekeeping,
            Housekeeping::None,
            "housekeeping defaults to off"
        );
    }

    #[test]
    fn no_configured_source_means_nothing_is_ever_watched() {
        // R17.7: capture only ever happens from an explicitly configured source.
        let db = TestDb::open();
        let conn = db.state.conn.lock().expect("lock");
        assert!(load_watched_folder_sources(&conn).is_empty());

        db::set_setting(&conn, LOCAL_SETTINGS_CATEGORY, SOURCES_SETTING_KEY, "{oops")
            .expect("store bad json");
        assert!(load_watched_folder_sources(&conn).is_empty());
    }
}
