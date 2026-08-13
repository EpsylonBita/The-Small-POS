//! Connected-scanner acquisition over the WIA Automation layer.
//!
//! Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
//! **D-Rust2**, decision **D4**. Requirements R2.1, R2.2, R2.5, R5.1, R12.5.
//!
//! # Shape of this module
//!
//! Three layers, deliberately separated so the only untestable one is as thin
//! as possible:
//!
//! 1. **The contract** — [`ScannerBackend`] / [`ScannerJob`]. Two small traits
//!    describing what a scanner can do: name its devices, and hand over one
//!    page at a time until the feeder runs dry.
//! 2. **The logic** — [`acquire_pages`], [`test_scan`], [`normalize_to_png`],
//!    [`map_hresult`], [`WiaHost`]. The page loop (ADF vs flatbed), the page
//!    cap, the durable write, the reason-code mapping, and the thread
//!    lifecycle all live here, above the trait, and are covered by the mock
//!    tests at the bottom of this file.
//! 3. **The driver** — [`mod com`], compiled `cfg(windows)`. Raw `IDispatch`
//!    against `WIA.DeviceManager` (`wiaaut.dll`). This is the layer real
//!    hardware certification covers; it is a separate production gate
//!    (Out of Scope #5), so nothing here pretends to test it.
//!
//! # Why a dedicated thread
//!
//! WIA automation is apartment-threaded COM. Every object handed out by
//! `WIA.DeviceManager` belongs to the apartment that created it and may not
//! cross threads, and `CoInitializeEx`/`CoUninitialize` must pair on one
//! thread. A Tokio worker satisfies none of that: tasks move between workers,
//! and a scan that blocks for a minute would park a runtime thread.
//!
//! So [`WiaHost`] owns exactly one `std::thread`, initialized STA, and talks to
//! it over an mpsc channel — the same thread-isolation shape
//! `ecr::device_manager` uses to keep blocking device I/O off the runtime.
//! The commands at the bottom of this file reach it through `spawn_blocking`,
//! so the host is never touched from an async context either.
//!
//! # Never panic, always restartable
//!
//! Scanner drivers are third-party code reached through `IDispatch`; a bad one
//! can and does misbehave. Each command runs inside `catch_unwind` on the host
//! thread: a panic becomes a [`ScanErrorCode::DeviceError`] reply, the thread
//! then retires itself, and the *next* command transparently starts a fresh
//! apartment. A broken scan therefore costs one error message, never the POS.

use std::io::Cursor;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use super::files::{self, WrittenPage};
use super::MAX_CAPTURE_PAGES;

/// Capture id the one-off test scan writes under — `captures/_test/`.
///
/// A plain path segment (`files::sanitize_path_segment` allows `_`), so the
/// test page goes through the exact same durable-write path a real page does,
/// and a re-test replaces it in place rather than accumulating files.
pub const TEST_SCAN_CAPTURE_ID: &str = "_test";

/// Every captured page is stored as PNG (design D-Rust2).
const PAGE_MIME: &str = "image/png";

/// Fixed moderate scan resolution. High enough for OCR on a printed invoice,
/// low enough that an A4 page stays inside `MAX_CAPTURE_PAGE_BYTES` and inside
/// the server's per-file upload limit.
const SCAN_DPI: i32 = 200;

/// How long a caller waits on the host thread before giving up on it.
///
/// Generous on purpose: a ten-page ADF run at 200 DPI is minutes of real work,
/// and a truthful "still scanning" beats a premature failure. The timeouts
/// exist so a wedged driver cannot hold a caller forever, not to police speed.
const LIST_TIMEOUT: Duration = Duration::from_secs(60);
const TEST_TIMEOUT: Duration = Duration::from_secs(300);
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(900);

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/// Stable reason codes the frontend translates (R2.5, R12.5).
///
/// These strings are a contract with the capture UI's locale keys: the renderer
/// maps each to one plain-language sentence, and no HRESULT, driver message, or
/// COM jargon ever reaches the user as primary content (R12.1). The set is
/// deliberately small — four named situations a user can act on, plus one
/// catch-all — because every code added here is a sentence somebody has to
/// write in five locales.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScanErrorCode {
    /// The scanner is powered off, asleep, warming up, or off the network.
    DeviceOffline,
    /// Something else holds the scanner — another app, or another terminal.
    DeviceBusy,
    /// The saved device is no longer attached to this terminal.
    DeviceRemoved,
    /// The scan was cancelled (by the driver's own UI, or by shutdown).
    ScanCancelled,
    /// Anything else: jams, open covers, driver faults, unreadable transfers.
    DeviceError,
}

impl ScanErrorCode {
    /// Every variant. Pinned by test against the wire strings the UI maps.
    pub const ALL: [ScanErrorCode; 5] = [
        Self::DeviceOffline,
        Self::DeviceBusy,
        Self::DeviceRemoved,
        Self::ScanCancelled,
        Self::DeviceError,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeviceOffline => "device_offline",
            Self::DeviceBusy => "device_busy",
            Self::DeviceRemoved => "device_removed",
            Self::ScanCancelled => "scan_cancelled",
            Self::DeviceError => "device_error",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == value)
    }
}

/// A failed scanner operation: the code the UI renders, plus a technical
/// detail that only ever reaches logs and diagnostics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScanError {
    pub code: ScanErrorCode,
    pub detail: String,
}

impl ScanError {
    pub fn new(code: ScanErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub fn offline(detail: impl Into<String>) -> Self {
        Self::new(ScanErrorCode::DeviceOffline, detail)
    }

    pub fn busy(detail: impl Into<String>) -> Self {
        Self::new(ScanErrorCode::DeviceBusy, detail)
    }

    pub fn removed(detail: impl Into<String>) -> Self {
        Self::new(ScanErrorCode::DeviceRemoved, detail)
    }

    pub fn cancelled(detail: impl Into<String>) -> Self {
        Self::new(ScanErrorCode::ScanCancelled, detail)
    }

    pub fn device_error(detail: impl Into<String>) -> Self {
        Self::new(ScanErrorCode::DeviceError, detail)
    }
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

/// Map a Windows `HRESULT` to a reason code.
///
/// The WIA facility (`0x8021….`) carries the situations a user can actually do
/// something about; the handful of `HRESULT_FROM_WIN32` and RPC codes below are
/// the ways the same situations arrive when the failure happened before the
/// driver was even reached (device yanked mid-scan, WIA service not running).
///
/// `WIA_ERROR_PAPER_EMPTY` deliberately has no mapping: an empty feeder is how
/// an ADF run *ends*, and [`acquire_pages`] reads it as "no more pages" long
/// before anything asks for a reason code.
pub fn map_hresult(hresult: i32) -> ScanErrorCode {
    match hresult as u32 {
        // WIA_ERROR_OFFLINE, _WARMING_UP, _DEVICE_COMMUNICATION,
        // _NETWORK_RESERVATION_FAILED.
        0x8021_0005 | 0x8021_0007 | 0x8021_000A | 0x8021_0013 => ScanErrorCode::DeviceOffline,
        // RPC_S_SERVER_UNAVAILABLE / ERROR_NOT_READY / CO_E_SERVER_EXEC_FAILURE
        // — the WIA service or the device stack did not answer at all.
        0x8007_06BA | 0x8007_0015 | 0x8008_0005 => ScanErrorCode::DeviceOffline,

        // WIA_ERROR_BUSY, WIA_ERROR_DEVICE_LOCKED.
        0x8021_0006 | 0x8021_000D => ScanErrorCode::DeviceBusy,

        // WIA_S_NO_DEVICE_AVAILABLE, WIA_ERROR_ITEM_DELETED.
        0x8021_0015 | 0x8021_0009 => ScanErrorCode::DeviceRemoved,
        // ERROR_FILE_NOT_FOUND (a stale device id no longer resolves) and
        // ERROR_DEVICE_REMOVED (unplugged mid-scan).
        0x8007_0002 | 0x8007_07E6 => ScanErrorCode::DeviceRemoved,

        // ERROR_CANCELLED.
        0x8007_04C7 => ScanErrorCode::ScanCancelled,

        // Jams, open covers, lamp faults, driver exceptions, and anything the
        // driver invented: one message, one retry offer.
        _ => ScanErrorCode::DeviceError,
    }
}

// ---------------------------------------------------------------------------
// The backend contract
// ---------------------------------------------------------------------------

/// One discovered scanning device (R2.1).
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerDeviceInfo {
    /// WIA device id — stable across reboots, so it is what a saved capture
    /// source stores.
    pub device_id: String,
    /// The device's own name, shown as-is in the picker.
    pub name: String,
}

/// How the open job feeds paper, which is the only thing the page loop needs
/// to know about the hardware.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeedMode {
    /// Automatic document feeder: keep transferring until it reports empty.
    Feeder,
    /// Flatbed: one sheet on the glass, so exactly one page per acquire. The
    /// UI's "Add another page" covers the rest (R5.1).
    Flatbed,
}

/// The result of asking a job for one more page.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PageTransfer {
    /// Encoded image bytes, in whatever format the driver produced.
    Page(Vec<u8>),
    /// Nothing left to transfer — the normal end of an ADF run.
    FeederEmpty,
}

/// A scanner stack this terminal can talk to.
///
/// Not `Send`: implementations own apartment-bound COM objects. The host thread
/// builds one through a factory and keeps it for that thread's lifetime.
pub trait ScannerBackend {
    /// Devices this terminal can scan from, already filtered to scanners.
    fn list_devices(&mut self) -> Result<Vec<ScannerDeviceInfo>, ScanError>;

    /// Connect to one device and prepare it for a silent transfer — no vendor
    /// dialog, no user interaction (R2.2).
    fn open_job(&mut self, device_id: &str) -> Result<Box<dyn ScannerJob>, ScanError>;
}

/// One scanning session against one device.
pub trait ScannerJob {
    /// Fixed for the session — the loop decides ADF vs single page from it.
    fn feed_mode(&self) -> FeedMode;

    /// Transfer the next page, or report the feeder empty.
    fn transfer_page(&mut self) -> Result<PageTransfer, ScanError>;
}

// ---------------------------------------------------------------------------
// The page loop
// ---------------------------------------------------------------------------

/// What one acquire run produced.
#[derive(Clone, Debug)]
pub struct AcquireOutcome {
    /// Pages already durably on disk, in document order.
    pub pages: Vec<WrittenPage>,
    /// `true` when the pages came off an automatic feeder.
    pub feeder_used: bool,
    /// `true` when the run stopped because the document hit
    /// [`MAX_CAPTURE_PAGES`] — the UI then offers "finish this one and start
    /// another" rather than a bare error (R12.3).
    pub reached_page_cap: bool,
}

/// Where the test scan's page landed, for visual confirmation (R2.2).
#[derive(Clone, Debug)]
pub struct TestScanOutcome {
    pub file_path: PathBuf,
    pub byte_size: u64,
}

/// Re-encode whatever the driver transferred as PNG.
///
/// Two jobs in one decode: it normalizes every scanner's output to the single
/// format the capture store and the upload transport expect, and it *proves the
/// bytes are an image* before they are written as evidence. A truncated or
/// garbled transfer fails here rather than surfacing later as an invoice the
/// server cannot read.
pub fn normalize_to_png(bytes: &[u8]) -> Result<Vec<u8>, ScanError> {
    if bytes.is_empty() {
        return Err(ScanError::device_error(
            "the scanner returned no image data",
        ));
    }

    let decoded = image::load_from_memory(bytes)
        .map_err(|e| ScanError::device_error(format!("decode scanned page: {e}")))?;

    let mut encoded = Vec::new();
    decoded
        .write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
        .map_err(|e| ScanError::device_error(format!("encode scanned page: {e}")))?;

    Ok(encoded)
}

/// Transfer pages from `device_id` into the capture at `capture_id`.
///
/// The loop is the whole point of this function, and it is the same loop for
/// every backend:
///
/// - an **ADF** keeps going until the feeder reports empty (R5.1), so a stack
///   of sheets becomes one multi-page document without further user action;
/// - a **flatbed** stops after one page, because there is nothing else on the
///   glass — the UI offers "Add another page" instead of guessing;
/// - either way the run stops at [`MAX_CAPTURE_PAGES`], and says so, because a
///   captured document is exactly one invoice.
///
/// `start_page_index` is the capture's current page count, so re-entering an
/// in-progress document **appends**. Each page is written durably before it is
/// reported (R11.1) — the caller records the store rows from the receipts, and
/// a crash mid-run leaves whole pages, never a half one.
pub fn acquire_pages(
    backend: &mut dyn ScannerBackend,
    device_id: &str,
    app_data_dir: &Path,
    capture_id: &str,
    start_page_index: usize,
    max_pages: usize,
) -> Result<AcquireOutcome, ScanError> {
    if max_pages == 0 {
        return Err(ScanError::device_error("no pages were requested"));
    }
    if start_page_index >= MAX_CAPTURE_PAGES {
        return Err(ScanError::device_error(format!(
            "this document already holds its {MAX_CAPTURE_PAGES} pages"
        )));
    }

    // Never transfer past the document cap, whatever the caller asked for.
    let limit = start_page_index
        .saturating_add(max_pages)
        .min(MAX_CAPTURE_PAGES);

    let mut job = backend.open_job(device_id)?;
    let feed_mode = job.feed_mode();

    let mut pages: Vec<WrittenPage> = Vec::new();
    let mut page_index = start_page_index;
    let mut reached_page_cap = false;

    while page_index < limit {
        match job.transfer_page()? {
            PageTransfer::FeederEmpty => break,
            PageTransfer::Page(bytes) => {
                let png = normalize_to_png(&bytes)?;
                let written = files::write_page_blocking(
                    app_data_dir,
                    capture_id,
                    page_index,
                    PAGE_MIME,
                    &png,
                )
                .map_err(ScanError::device_error)?;
                pages.push(written);
                page_index += 1;
            }
        }

        // One sheet on the glass is one page; asking for another would rescan
        // the same sheet.
        if feed_mode == FeedMode::Flatbed {
            break;
        }

        if page_index >= MAX_CAPTURE_PAGES {
            reached_page_cap = true;
            break;
        }
    }

    Ok(AcquireOutcome {
        pages,
        feeder_used: feed_mode == FeedMode::Feeder,
        reached_page_cap,
    })
}

/// One silent page from `device_id`, saved under `captures/_test/` (R2.2).
///
/// Deliberately capped at a single page even on an ADF: a setup test proves the
/// device answers, and must not swallow a stack of paper to do it.
pub fn test_scan(
    backend: &mut dyn ScannerBackend,
    device_id: &str,
    app_data_dir: &Path,
) -> Result<TestScanOutcome, ScanError> {
    let outcome = acquire_pages(backend, device_id, app_data_dir, TEST_SCAN_CAPTURE_ID, 0, 1)?;

    let page = outcome
        .pages
        .into_iter()
        .next()
        .ok_or_else(|| ScanError::device_error("the scanner produced no page"))?;

    Ok(TestScanOutcome {
        file_path: page.file_path,
        byte_size: page.byte_size,
    })
}

// ---------------------------------------------------------------------------
// The host thread
// ---------------------------------------------------------------------------

/// What a caller asks the host thread to do.
#[derive(Clone, Debug)]
enum HostRequest {
    List,
    Test {
        device_id: String,
        app_data_dir: PathBuf,
    },
    Acquire {
        device_id: String,
        app_data_dir: PathBuf,
        capture_id: String,
        start_page_index: usize,
    },
}

impl HostRequest {
    fn timeout(&self) -> Duration {
        match self {
            Self::List => LIST_TIMEOUT,
            Self::Test { .. } => TEST_TIMEOUT,
            Self::Acquire { .. } => ACQUIRE_TIMEOUT,
        }
    }
}

/// What the host thread sends back.
#[derive(Debug)]
enum HostReply {
    Devices(Vec<ScannerDeviceInfo>),
    TestPage(TestScanOutcome),
    Pages(AcquireOutcome),
}

struct Job {
    request: HostRequest,
    reply: Sender<Result<HostReply, ScanError>>,
}

/// Builds the backend, on the host thread, in its own apartment.
///
/// `Send + Sync` because the host holds it across restarts; the *backend* it
/// returns never leaves the thread that created it.
pub type BackendFactory =
    Arc<dyn Fn() -> Result<Box<dyn ScannerBackend>, ScanError> + Send + Sync + 'static>;

/// Owns the single STA thread every COM call runs on.
///
/// Started on first use and restarted on demand: if the thread retires itself
/// after a driver panic, the next command finds the channel closed, starts a
/// fresh apartment, and runs there. Callers see one failed operation, not a
/// dead scanner.
pub struct WiaHost {
    factory: BackendFactory,
    channel: Mutex<Option<Sender<Job>>>,
    /// How many apartments this host has started — the observable evidence
    /// that a restart happened.
    starts: AtomicUsize,
}

/// Outcome of one attempt to reach the host thread.
enum Dispatched {
    /// The thread ran the command and answered.
    Replied(Result<HostReply, ScanError>),
    /// The thread was gone before it could answer. Safe to retry once: nothing
    /// ran, so nothing can be run twice.
    HostGone,
}

impl WiaHost {
    /// A host driving the platform's real scanner stack.
    pub fn new() -> Self {
        Self::with_backend_factory(platform_backend_factory())
    }

    /// A host driving `factory` — the seam the mock tests use.
    pub fn with_backend_factory(factory: BackendFactory) -> Self {
        Self {
            factory,
            channel: Mutex::new(None),
            starts: AtomicUsize::new(0),
        }
    }

    /// Process-wide host, started on first use.
    pub fn global() -> &'static WiaHost {
        static HOST: OnceLock<WiaHost> = OnceLock::new();
        HOST.get_or_init(WiaHost::new)
    }

    /// Apartments started so far.
    pub fn start_count(&self) -> usize {
        self.starts.load(Ordering::SeqCst)
    }

    /// Discovered scanners (R2.1).
    pub fn list_devices(&self) -> Result<Vec<ScannerDeviceInfo>, ScanError> {
        match self.execute(HostRequest::List)? {
            HostReply::Devices(devices) => Ok(devices),
            other => Err(unexpected_reply(&other)),
        }
    }

    /// One silent test page under `captures/_test/` (R2.2).
    pub fn test_scan(
        &self,
        device_id: &str,
        app_data_dir: &Path,
    ) -> Result<TestScanOutcome, ScanError> {
        let request = HostRequest::Test {
            device_id: device_id.to_string(),
            app_data_dir: app_data_dir.to_path_buf(),
        };
        match self.execute(request)? {
            HostReply::TestPage(outcome) => Ok(outcome),
            other => Err(unexpected_reply(&other)),
        }
    }

    /// Append pages to `capture_id` from `device_id` (R5.1).
    pub fn acquire(
        &self,
        device_id: &str,
        app_data_dir: &Path,
        capture_id: &str,
        start_page_index: usize,
    ) -> Result<AcquireOutcome, ScanError> {
        let request = HostRequest::Acquire {
            device_id: device_id.to_string(),
            app_data_dir: app_data_dir.to_path_buf(),
            capture_id: capture_id.to_string(),
            start_page_index,
        };
        match self.execute(request)? {
            HostReply::Pages(outcome) => Ok(outcome),
            other => Err(unexpected_reply(&other)),
        }
    }

    /// Retire the current apartment. The next command starts a fresh one.
    pub fn stop(&self) {
        self.forget_channel();
    }

    /// Send one command, restarting the apartment once if the old one had
    /// already retired itself.
    fn execute(&self, request: HostRequest) -> Result<HostReply, ScanError> {
        let timeout = request.timeout();

        match self.dispatch(request.clone(), timeout) {
            Dispatched::Replied(result) => result,
            Dispatched::HostGone => {
                // The previous apartment retired (a driver panic is the usual
                // reason). Nothing ran, so re-running is not a duplicate scan.
                tracing::warn!("WIA host thread had retired; starting a fresh apartment");
                match self.dispatch(request, timeout) {
                    Dispatched::Replied(result) => result,
                    Dispatched::HostGone => Err(ScanError::device_error(
                        "the scanning service could not be started",
                    )),
                }
            }
        }
    }

    fn dispatch(&self, request: HostRequest, timeout: Duration) -> Dispatched {
        let sender = match self.sender() {
            Ok(sender) => sender,
            Err(error) => return Dispatched::Replied(Err(error)),
        };

        let (reply_tx, reply_rx) = mpsc::channel();
        if sender
            .send(Job {
                request,
                reply: reply_tx,
            })
            .is_err()
        {
            self.forget_channel();
            return Dispatched::HostGone;
        }

        match reply_rx.recv_timeout(timeout) {
            Ok(result) => Dispatched::Replied(result),
            // The thread went away mid-command without answering.
            Err(RecvTimeoutError::Disconnected) => {
                self.forget_channel();
                Dispatched::HostGone
            }
            // A wedged driver. Retire the apartment so the next attempt gets a
            // clean one, and tell the user the scanner is tied up rather than
            // leaving them staring at a spinner.
            Err(RecvTimeoutError::Timeout) => {
                self.forget_channel();
                Dispatched::Replied(Err(ScanError::busy("the scanner did not answer in time")))
            }
        }
    }

    /// The live command channel, starting the apartment if there is none.
    fn sender(&self) -> Result<Sender<Job>, ScanError> {
        let mut guard = self
            .channel
            .lock()
            .map_err(|_| ScanError::device_error("scanner host lock poisoned"))?;

        if let Some(sender) = guard.as_ref() {
            return Ok(sender.clone());
        }

        let (tx, rx) = mpsc::channel::<Job>();
        let factory = Arc::clone(&self.factory);

        std::thread::Builder::new()
            .name("wia-host".into())
            .spawn(move || host_thread_main(factory, rx))
            .map_err(|e| ScanError::device_error(format!("start scanner host thread: {e}")))?;

        self.starts.fetch_add(1, Ordering::SeqCst);
        *guard = Some(tx.clone());
        Ok(tx)
    }

    fn forget_channel(&self) {
        if let Ok(mut guard) = self.channel.lock() {
            *guard = None;
        }
    }
}

impl Default for WiaHost {
    fn default() -> Self {
        Self::new()
    }
}

fn unexpected_reply(reply: &HostReply) -> ScanError {
    ScanError::device_error(format!("scanner host answered with {reply:?}"))
}

/// The host thread's whole life.
///
/// The backend is built lazily on the first command so a stack that cannot
/// initialize at all reports to a caller instead of dying anonymously at
/// startup, and every command runs inside `catch_unwind` so a third-party
/// driver's panic becomes an error message.
fn host_thread_main(factory: BackendFactory, rx: mpsc::Receiver<Job>) {
    let mut backend: Option<Box<dyn ScannerBackend>> = None;

    while let Ok(job) = rx.recv() {
        let Job { request, reply } = job;

        let outcome = catch_unwind(AssertUnwindSafe(|| {
            if backend.is_none() {
                backend = Some(factory()?);
            }
            let backend = backend
                .as_mut()
                .ok_or_else(|| ScanError::device_error("scanner backend missing"))?;
            run_request(backend.as_mut(), request)
        }));

        let (result, retire) = match outcome {
            Ok(result) => (result, false),
            Err(_) => {
                tracing::error!("WIA backend panicked; retiring this apartment");
                (
                    Err(ScanError::device_error(
                        "the scanner driver failed unexpectedly",
                    )),
                    true,
                )
            }
        };

        // A caller that has already given up is not an error worth handling.
        let _ = reply.send(result);

        if retire {
            // Drop the backend inside this apartment (COM objects may not be
            // released from another thread) and let the channel close, so the
            // next command starts somewhere clean.
            break;
        }
    }

    drop(backend);
}

fn run_request(
    backend: &mut dyn ScannerBackend,
    request: HostRequest,
) -> Result<HostReply, ScanError> {
    match request {
        HostRequest::List => backend.list_devices().map(HostReply::Devices),
        HostRequest::Test {
            device_id,
            app_data_dir,
        } => test_scan(backend, &device_id, &app_data_dir).map(HostReply::TestPage),
        HostRequest::Acquire {
            device_id,
            app_data_dir,
            capture_id,
            start_page_index,
        } => acquire_pages(
            backend,
            &device_id,
            &app_data_dir,
            &capture_id,
            start_page_index,
            MAX_CAPTURE_PAGES,
        )
        .map(HostReply::Pages),
    }
}

/// The backend factory for this build.
fn platform_backend_factory() -> BackendFactory {
    #[cfg(windows)]
    {
        Arc::new(|| {
            com::WiaAutomationBackend::create().map(|b| Box::new(b) as Box<dyn ScannerBackend>)
        })
    }
    #[cfg(not(windows))]
    {
        Arc::new(|| {
            Err(ScanError::device_error(
                "connected scanners need Windows scanning support",
            ))
        })
    }
}

// ---------------------------------------------------------------------------
// The Windows driver
// ---------------------------------------------------------------------------

/// WIA device type for a scanner (`WiaDeviceType.ScannerDeviceType`).
pub const WIA_SCANNER_DEVICE_TYPE: i32 = 1;

/// Discovery lists scanners only — cameras and video devices share the same
/// `DeviceInfos` collection and must not appear in an invoice-scanning picker
/// (R2.1).
pub fn is_scanner_device_type(device_type: i32) -> bool {
    device_type == WIA_SCANNER_DEVICE_TYPE
}

#[cfg(windows)]
mod com {
    //! Raw `IDispatch` against the WIA Automation layer (`wiaaut.dll`).
    //!
    //! Everything here is untested by this file's suite on purpose: it is the
    //! part only real hardware can verify, and that certification is a separate
    //! production gate. What keeps it honest is how *little* it decides — it
    //! transfers bytes and reports HRESULTs; the page loop, the cap, the
    //! durable write, and the reason-code mapping all live above the trait.
    //!
    //! Two conventions worth knowing when reading the `IDispatch` calls:
    //!
    //! - `DISPPARAMS.rgvarg` is in **reverse** argument order.
    //! - A failing automation call returns `DISP_E_EXCEPTION` and hides the
    //!   real HRESULT in `EXCEPINFO.scode`, so [`Dispatch::invoke`] digs it out
    //!   — without that, every scanner fault would look identical.

    use std::path::Path;

    use windows::core::{BSTR, GUID, PCWSTR};
    use windows::Win32::System::Com::{
        CLSIDFromProgID, CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch,
        CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, DISPATCH_FLAGS,
        DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS, EXCEPINFO,
    };
    use windows::Win32::System::Ole::DISPID_PROPERTYPUT;
    use windows::Win32::System::Variant::{VariantChangeType, VARIANT, VAR_CHANGE_FLAGS, VT_BSTR};

    use super::{
        is_scanner_device_type, map_hresult, FeedMode, PageTransfer, ScanError, ScannerBackend,
        ScannerDeviceInfo, ScannerJob, SCAN_DPI,
    };

    /// `LOCALE_USER_DEFAULT`. Inlined rather than pulling in the
    /// `Win32_Globalization` feature for one constant.
    const LOCALE_USER_DEFAULT: u32 = 0x0400;

    /// `DISP_E_EXCEPTION` — "the call failed, look in EXCEPINFO".
    const DISP_E_EXCEPTION: i32 = 0x8002_0009u32 as i32;

    /// `WIA_ERROR_PAPER_EMPTY` — the ADF is out of paper. Not a failure: it is
    /// how a feeder run ends.
    const WIA_ERROR_PAPER_EMPTY: i32 = 0x8021_0003u32 as i32;

    /// GDI+ image format ids the WIA automation layer converts to.
    const WIA_FORMAT_PNG: &str = "{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}";
    const WIA_FORMAT_JPEG: &str = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}";

    /// Device property ids (`wiadef.h`).
    const WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES: i32 = 3086;
    const WIA_DPS_DOCUMENT_HANDLING_STATUS: i32 = 3087;
    const WIA_DPS_DOCUMENT_HANDLING_SELECT: i32 = 3088;
    const WIA_DPS_PAGES: i32 = 3096;

    /// Item property ids (`wiadef.h`).
    const WIA_IPS_XRES: i32 = 6147;
    const WIA_IPS_YRES: i32 = 6148;

    /// Document-handling bit flags.
    const FEEDER_CAPABILITY: i32 = 0x001;
    const FEED_READY: i32 = 0x001;
    const FEEDER_SELECT: i32 = 0x001;
    const FLATBED_SELECT: i32 = 0x002;

    /// An initialized STA for as long as this value lives.
    ///
    /// `CoUninitialize` must run on the thread that called `CoInitializeEx`;
    /// tying it to a `Drop` guard owned by the backend guarantees that, because
    /// the host thread both creates and drops the backend.
    struct Apartment;

    impl Apartment {
        fn enter() -> Result<Self, ScanError> {
            // SAFETY: called once per host thread, before any COM object
            // exists on it. A second call on the same thread would return
            // RPC_E_CHANGED_MODE, which is why the host owns exactly one.
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr.is_err() {
                return Err(ScanError::new(
                    map_hresult(hr.0),
                    format!("CoInitializeEx failed: {hr:?}"),
                ));
            }
            Ok(Self)
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: paired with the `CoInitializeEx` in `enter`, on the same
            // thread, after every COM object built here has been released.
            unsafe { CoUninitialize() };
        }
    }

    /// Thin `IDispatch` wrapper: name lookup, calls, property get/put, and the
    /// `EXCEPINFO` unwrapping that makes scanner faults distinguishable.
    #[derive(Clone)]
    struct Dispatch(IDispatch);

    impl Dispatch {
        fn create(prog_id: &str) -> Result<Self, ScanError> {
            let wide = wide(prog_id);
            // SAFETY: `wide` outlives the call and is NUL-terminated.
            let clsid = unsafe { CLSIDFromProgID(PCWSTR(wide.as_ptr())) }.map_err(|e| {
                ScanError::device_error(format!(
                    "Windows scanning support is unavailable ({prog_id}): {e}"
                ))
            })?;

            // SAFETY: `clsid` is a valid CLSID and `IDispatch` is the requested
            // interface, so the returned pointer is an `IDispatch`.
            let dispatch: IDispatch = unsafe {
                CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER)
            }
            .map_err(|e| {
                ScanError::new(map_hresult(e.code().0), format!("create {prog_id}: {e}"))
            })?;

            Ok(Self(dispatch))
        }

        fn dispid(&self, name: &str) -> Result<i32, ScanError> {
            let wide = wide(name);
            let names = [PCWSTR(wide.as_ptr())];
            let mut dispid = 0i32;
            // SAFETY: one name in, one id out; both buffers outlive the call.
            unsafe {
                self.0.GetIDsOfNames(
                    &GUID::zeroed(),
                    names.as_ptr(),
                    1,
                    LOCALE_USER_DEFAULT,
                    &mut dispid,
                )
            }
            .map_err(|e| {
                ScanError::new(
                    map_hresult(e.code().0),
                    format!("scanner interface has no '{name}': {e}"),
                )
            })?;
            Ok(dispid)
        }

        /// Invoke `name`, translating `DISP_E_EXCEPTION` into the real HRESULT.
        fn invoke(
            &self,
            name: &str,
            flags: DISPATCH_FLAGS,
            args: &[VARIANT],
        ) -> Result<VARIANT, ScanError> {
            self.invoke_raw(name, flags, args)
                .map_err(|(_, error)| error)
        }

        /// [`Dispatch::invoke`], keeping the HRESULT.
        ///
        /// Used where a *specific* code is part of normal operation rather than
        /// a fault — `WIA_ERROR_PAPER_EMPTY` ending an ADF run. Matching on the
        /// number is the only honest way to do that; sniffing the formatted
        /// message would break the first time the wording changed.
        fn invoke_raw(
            &self,
            name: &str,
            flags: DISPATCH_FLAGS,
            args: &[VARIANT],
        ) -> Result<VARIANT, (i32, ScanError)> {
            let dispid = self.dispid(name).map_err(|error| (0, error))?;
            // IDispatch takes arguments in reverse order.
            let mut reversed: Vec<VARIANT> = args.iter().rev().cloned().collect();
            let mut put_dispid = DISPID_PROPERTYPUT;

            let params = DISPPARAMS {
                rgvarg: reversed.as_mut_ptr(),
                rgdispidNamedArgs: if flags == DISPATCH_PROPERTYPUT {
                    &mut put_dispid
                } else {
                    std::ptr::null_mut()
                },
                cArgs: reversed.len() as u32,
                cNamedArgs: u32::from(flags == DISPATCH_PROPERTYPUT),
            };

            let mut result = VARIANT::default();
            let mut excep = EXCEPINFO::default();

            // SAFETY: `params` points at `reversed`, which outlives the call;
            // `result` and `excep` are owned locals the callee fills in.
            let call = unsafe {
                self.0.Invoke(
                    dispid,
                    &GUID::zeroed(),
                    LOCALE_USER_DEFAULT,
                    flags,
                    &params,
                    Some(&mut result),
                    Some(&mut excep),
                    None,
                )
            };

            match call {
                Ok(()) => Ok(result),
                Err(error) => {
                    let mut hresult = error.code().0;
                    if hresult == DISP_E_EXCEPTION {
                        // The interesting code lives in the exception record;
                        // without this every fault would read as one generic
                        // automation error.
                        if excep.scode != 0 {
                            hresult = excep.scode;
                        } else if excep.wCode != 0 {
                            hresult = 0x8004_0200u32 as i32 + i32::from(excep.wCode);
                        }
                    }
                    Err((
                        hresult,
                        ScanError::new(
                            map_hresult(hresult),
                            format!("{name} failed (0x{:08X})", hresult as u32),
                        ),
                    ))
                }
            }
        }

        fn get(&self, name: &str) -> Result<VARIANT, ScanError> {
            self.invoke(name, DISPATCH_PROPERTYGET, &[])
        }

        fn get_indexed(&self, name: &str, index: VARIANT) -> Result<VARIANT, ScanError> {
            self.invoke(name, DISPATCH_PROPERTYGET, &[index])
        }

        fn call(&self, name: &str, args: &[VARIANT]) -> Result<VARIANT, ScanError> {
            self.invoke(name, DISPATCH_METHOD, args)
        }

        fn put(&self, name: &str, value: VARIANT) -> Result<(), ScanError> {
            self.invoke(name, DISPATCH_PROPERTYPUT, &[value])
                .map(|_| ())
        }

        fn get_object(&self, name: &str) -> Result<Dispatch, ScanError> {
            let value = self.get(name)?;
            variant_to_dispatch(&value, name)
        }

        fn get_object_indexed(&self, name: &str, index: VARIANT) -> Result<Dispatch, ScanError> {
            let value = self.get_indexed(name, index)?;
            variant_to_dispatch(&value, name)
        }

        fn get_i32(&self, name: &str) -> Result<i32, ScanError> {
            let value = self.get(name)?;
            i32::try_from(&value).map_err(|e| {
                ScanError::device_error(format!("scanner property '{name}' is not a number: {e}"))
            })
        }

        fn get_string(&self, name: &str) -> Result<String, ScanError> {
            let value = self.get(name)?;
            variant_to_string(&value).ok_or_else(|| {
                ScanError::device_error(format!("scanner property '{name}' is not text"))
            })
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn variant_to_dispatch(value: &VARIANT, name: &str) -> Result<Dispatch, ScanError> {
        IDispatch::try_from(value).map(Dispatch).map_err(|e| {
            ScanError::device_error(format!("scanner property '{name}' is not an object: {e}"))
        })
    }

    /// Read a VARIANT as text, coercing when the driver used a non-BSTR type.
    fn variant_to_string(value: &VARIANT) -> Option<String> {
        if value.vt() == VT_BSTR {
            // SAFETY: the discriminant says this union arm is the live one.
            return Some(unsafe { value.Anonymous.Anonymous.Anonymous.bstrVal.to_string() });
        }

        let mut coerced = VARIANT::default();
        // SAFETY: both VARIANTs are owned locals; `VariantChangeType` writes a
        // fully-formed VARIANT into `coerced` or leaves it VT_EMPTY.
        unsafe { VariantChangeType(&mut coerced, value, VAR_CHANGE_FLAGS(0), VT_BSTR) }.ok()?;
        if coerced.vt() != VT_BSTR {
            return None;
        }
        // SAFETY: as above, the discriminant now says BSTR.
        Some(unsafe { coerced.Anonymous.Anonymous.Anonymous.bstrVal.to_string() })
    }

    /// A WIA `Properties` collection, addressed by numeric property id.
    ///
    /// Names would be shorter but they are the driver's names; ids come from
    /// `wiadef.h` and are the same on every device.
    struct PropertyBag(Dispatch);

    impl PropertyBag {
        fn find(&self, property_id: i32) -> Option<Dispatch> {
            let count = self.0.get_i32("Count").ok()?;
            for index in 1..=count {
                let Ok(property) = self.0.get_object_indexed("Item", VARIANT::from(index)) else {
                    continue;
                };
                if property.get_i32("PropertyID").ok() == Some(property_id) {
                    return Some(property);
                }
            }
            None
        }

        fn read_i32(&self, property_id: i32) -> Option<i32> {
            self.find(property_id)?.get_i32("Value").ok()
        }

        /// Best-effort write. A device that refuses a setting still scans — at
        /// its own default — which is always better than failing the capture
        /// over a resolution hint.
        fn write_i32(&self, property_id: i32, value: i32) {
            let Some(property) = self.find(property_id) else {
                return;
            };
            if let Err(error) = property.put("Value", VARIANT::from(value)) {
                tracing::debug!("scanner property {property_id} not settable: {error}");
            }
        }
    }

    /// The real `WIA.DeviceManager`-backed backend.
    pub(super) struct WiaAutomationBackend {
        // Field order is drop order: the manager's COM objects must all be
        // released before the apartment closes.
        manager: Dispatch,
        _apartment: Apartment,
    }

    impl WiaAutomationBackend {
        pub(super) fn create() -> Result<Self, ScanError> {
            let apartment = Apartment::enter()?;
            let manager = Dispatch::create("WIA.DeviceManager")?;
            Ok(Self {
                manager,
                _apartment: apartment,
            })
        }

        fn connect(&self, device_id: &str) -> Result<Dispatch, ScanError> {
            let infos = self.manager.get_object("DeviceInfos")?;
            let count = infos.get_i32("Count")?;

            for index in 1..=count {
                let info = infos.get_object_indexed("Item", VARIANT::from(index))?;
                if info.get_string("DeviceID").ok().as_deref() != Some(device_id) {
                    continue;
                }
                let device = info.call("Connect", &[])?;
                return variant_to_dispatch(&device, "Connect");
            }

            Err(ScanError::removed(format!(
                "device {device_id} is no longer attached"
            )))
        }
    }

    impl ScannerBackend for WiaAutomationBackend {
        fn list_devices(&mut self) -> Result<Vec<ScannerDeviceInfo>, ScanError> {
            let infos = self.manager.get_object("DeviceInfos")?;
            let count = infos.get_i32("Count")?;

            let mut devices = Vec::new();
            for index in 1..=count {
                let Ok(info) = infos.get_object_indexed("Item", VARIANT::from(index)) else {
                    continue;
                };
                // One unreadable entry must not hide the rest of the list.
                let Ok(device_type) = info.get_i32("Type") else {
                    continue;
                };
                if !is_scanner_device_type(device_type) {
                    continue;
                }
                let Ok(device_id) = info.get_string("DeviceID") else {
                    continue;
                };

                let name = PropertyBag(match info.get_object("Properties") {
                    Ok(properties) => properties,
                    Err(_) => continue,
                })
                .find(WIA_DEVICE_NAME_PROPERTY_ID)
                .and_then(|property| property.get_string("Value").ok())
                .unwrap_or_else(|| device_id.clone());

                devices.push(ScannerDeviceInfo { device_id, name });
            }

            Ok(devices)
        }

        fn open_job(&mut self, device_id: &str) -> Result<Box<dyn ScannerJob>, ScanError> {
            let device = self.connect(device_id)?;
            let properties = PropertyBag(device.get_object("Properties")?);

            let capabilities = properties
                .read_i32(WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES)
                .unwrap_or(0);
            let status = properties
                .read_i32(WIA_DPS_DOCUMENT_HANDLING_STATUS)
                .unwrap_or(0);

            // Only drive the feeder when paper is actually loaded: on a
            // combo device that turns "the user put the invoice on the glass"
            // into a flatbed scan instead of an immediate paper-empty error.
            let use_feeder = capabilities & FEEDER_CAPABILITY != 0 && status & FEED_READY != 0;

            if use_feeder {
                properties.write_i32(WIA_DPS_DOCUMENT_HANDLING_SELECT, FEEDER_SELECT);
                // One page per Transfer, so the loop above the trait stays in
                // charge of how many pages a document gets.
                properties.write_i32(WIA_DPS_PAGES, 1);
            } else if capabilities & FLATBED_SELECT != 0 {
                properties.write_i32(WIA_DPS_DOCUMENT_HANDLING_SELECT, FLATBED_SELECT);
            }

            let items = device.get_object("Items")?;
            if items.get_i32("Count").unwrap_or(0) < 1 {
                return Err(ScanError::device_error(
                    "the scanner offered nothing to scan",
                ));
            }
            let item = items.get_object_indexed("Item", VARIANT::from(1))?;

            let item_properties = PropertyBag(item.get_object("Properties")?);
            item_properties.write_i32(WIA_IPS_XRES, SCAN_DPI);
            item_properties.write_i32(WIA_IPS_YRES, SCAN_DPI);

            let format = choose_format(&item);

            Ok(Box::new(WiaAutomationJob {
                item,
                format,
                feed_mode: if use_feeder {
                    FeedMode::Feeder
                } else {
                    FeedMode::Flatbed
                },
                properties,
                transferred: 0,
            }))
        }
    }

    /// Pick the transfer format up front, from what the item says it supports.
    ///
    /// Asking beforehand rather than transferring and retrying on rejection
    /// matters on a feeder: a failed transfer may already have pulled the
    /// sheet, so a "try PNG, fall back to JPEG" loop can silently eat a page of
    /// somebody's invoice. One question, one answer, one transfer per sheet.
    ///
    /// PNG is preferred (lossless, and what the capture store keeps anyway);
    /// JPEG is the universal fallback. Both are formats the `image` crate
    /// decodes, which is what [`super::normalize_to_png`] needs. A driver that
    /// will not enumerate its formats gets PNG, the automation layer's own
    /// default conversion target.
    fn choose_format(item: &Dispatch) -> String {
        let Ok(formats) = item.get_object("Formats") else {
            return WIA_FORMAT_PNG.to_string();
        };
        let Ok(count) = formats.get_i32("Count") else {
            return WIA_FORMAT_PNG.to_string();
        };

        let mut supports_jpeg = false;
        for index in 1..=count {
            let Ok(value) = formats.get_indexed("Item", VARIANT::from(index)) else {
                continue;
            };
            let Some(format) = variant_to_string(&value) else {
                continue;
            };
            let format = format.trim().to_ascii_uppercase();
            if format == WIA_FORMAT_PNG {
                return WIA_FORMAT_PNG.to_string();
            }
            if format == WIA_FORMAT_JPEG {
                supports_jpeg = true;
            }
        }

        if supports_jpeg {
            WIA_FORMAT_JPEG.to_string()
        } else {
            WIA_FORMAT_PNG.to_string()
        }
    }

    /// `Name` in the device's property bag (`WIA_DIP_DEV_NAME`).
    const WIA_DEVICE_NAME_PROPERTY_ID: i32 = 7;

    struct WiaAutomationJob {
        item: Dispatch,
        /// Chosen once from the item's own capabilities, never re-probed.
        format: String,
        feed_mode: FeedMode,
        properties: PropertyBag,
        transferred: usize,
    }

    impl WiaAutomationJob {
        /// Ask the device whether another sheet is waiting. Devices that do not
        /// report the status say "yes" by omission — the transfer's own
        /// paper-empty answer is then the authority.
        fn feeder_has_paper(&self) -> bool {
            match self.properties.read_i32(WIA_DPS_DOCUMENT_HANDLING_STATUS) {
                Some(status) => status & FEED_READY != 0,
                None => true,
            }
        }

        /// Pull one sheet through, saving via a temp file.
        ///
        /// The automation layer would also hand the bytes back as a SAFEARRAY,
        /// but `SaveFile` is the documented path and avoids an entire class of
        /// marshalling mistakes. The scratch file is read straight back and
        /// deleted; the *durable* copy is the one `acquire_pages` writes
        /// afterwards, so nothing depends on this temp file surviving.
        ///
        /// `Ok(None)` means the feeder reported empty — the normal end of an
        /// ADF run, not a failure.
        fn transfer_once(&self, scratch: &Path) -> Result<Option<Vec<u8>>, ScanError> {
            let image = match self.item.invoke_raw(
                "Transfer",
                DISPATCH_METHOD,
                &[VARIANT::from(self.format.as_str())],
            ) {
                Ok(image) => image,
                Err((hresult, _)) if hresult == WIA_ERROR_PAPER_EMPTY => return Ok(None),
                Err((_, error)) => return Err(error),
            };
            let image = variant_to_dispatch(&image, "Transfer")?;

            // SaveFile refuses to overwrite, so clear any leftover first.
            let _ = std::fs::remove_file(scratch);
            let target = scratch.to_string_lossy().to_string();
            image.call("SaveFile", &[VARIANT::from(BSTR::from(target.as_str()))])?;

            let bytes = std::fs::read(scratch)
                .map_err(|e| ScanError::device_error(format!("read scanned page: {e}")))?;
            let _ = std::fs::remove_file(scratch);

            Ok(Some(bytes))
        }
    }

    impl ScannerJob for WiaAutomationJob {
        fn feed_mode(&self) -> FeedMode {
            self.feed_mode
        }

        fn transfer_page(&mut self) -> Result<PageTransfer, ScanError> {
            if self.feed_mode == FeedMode::Feeder
                && self.transferred > 0
                && !self.feeder_has_paper()
            {
                return Ok(PageTransfer::FeederEmpty);
            }

            let scratch = std::env::temp_dir().join(format!(
                "the-small-scan-{}-{}.img",
                std::process::id(),
                self.transferred
            ));

            // Exactly one transfer per sheet. A retry here would ask the feeder
            // for another page, so a failure has to stay a failure.
            match self.transfer_once(&scratch)? {
                None => Ok(PageTransfer::FeederEmpty),
                Some(bytes) => {
                    self.transferred += 1;
                    Ok(PageTransfer::Page(bytes))
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::harness::TempDir;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;
    use std::thread::ThreadId;

    // -- fixtures ----------------------------------------------------------

    /// A real 2×2 PNG. Built through the `image` crate rather than hard-coded
    /// so the fixture is genuinely decodable by the same code path production
    /// uses.
    fn png_bytes() -> Vec<u8> {
        encode(image::ImageFormat::Png)
    }

    /// A real 2×2 JPEG — the format a driver that refuses PNG gives back.
    fn jpeg_bytes() -> Vec<u8> {
        encode(image::ImageFormat::Jpeg)
    }

    fn encode(format: image::ImageFormat) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            2,
            2,
            image::Rgb([200, 190, 180]),
        ));
        let mut out = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut out), format)
            .expect("encode fixture");
        out
    }

    /// One scripted scanning session.
    #[derive(Clone)]
    struct JobPlan {
        feed_mode: FeedMode,
        steps: VecDeque<Result<PageTransfer, ScanError>>,
    }

    impl JobPlan {
        /// A feeder holding `pages` sheets, reporting empty afterwards.
        fn feeder(pages: usize) -> Self {
            let mut steps: VecDeque<_> = (0..pages)
                .map(|_| Ok(PageTransfer::Page(png_bytes())))
                .collect();
            steps.push_back(Ok(PageTransfer::FeederEmpty));
            Self {
                feed_mode: FeedMode::Feeder,
                steps,
            }
        }

        /// A flatbed that would happily keep rescanning the same sheet — the
        /// loop, not the device, has to stop at one.
        fn flatbed() -> Self {
            Self {
                feed_mode: FeedMode::Flatbed,
                steps: (0..5)
                    .map(|_| Ok(PageTransfer::Page(png_bytes())))
                    .collect(),
            }
        }

        fn failing(error: ScanError) -> Self {
            Self {
                feed_mode: FeedMode::Feeder,
                steps: VecDeque::from([Err(error)]),
            }
        }
    }

    struct MockJob {
        plan: JobPlan,
        transfers: Arc<AtomicUsize>,
    }

    impl ScannerJob for MockJob {
        fn feed_mode(&self) -> FeedMode {
            self.plan.feed_mode
        }

        fn transfer_page(&mut self) -> Result<PageTransfer, ScanError> {
            self.transfers.fetch_add(1, Ordering::SeqCst);
            self.plan
                .steps
                .pop_front()
                .unwrap_or(Ok(PageTransfer::FeederEmpty))
        }
    }

    #[derive(Default)]
    struct MockScanner {
        devices: Vec<ScannerDeviceInfo>,
        list_error: Option<ScanError>,
        open_error: Option<ScanError>,
        plan: Option<JobPlan>,
        panic_on_list: bool,
        transfers: Arc<AtomicUsize>,
        /// Threads every call ran on — how "one dedicated thread" is proven.
        threads: Arc<Mutex<Vec<ThreadId>>>,
    }

    impl MockScanner {
        fn with_plan(plan: JobPlan) -> Self {
            Self {
                plan: Some(plan),
                ..Default::default()
            }
        }

        fn with_devices(devices: Vec<ScannerDeviceInfo>) -> Self {
            Self {
                devices,
                ..Default::default()
            }
        }
    }

    impl ScannerBackend for MockScanner {
        fn list_devices(&mut self) -> Result<Vec<ScannerDeviceInfo>, ScanError> {
            if let Ok(mut threads) = self.threads.lock() {
                threads.push(std::thread::current().id());
            }
            if self.panic_on_list {
                panic!("scanner driver exploded");
            }
            match &self.list_error {
                Some(error) => Err(error.clone()),
                None => Ok(self.devices.clone()),
            }
        }

        fn open_job(&mut self, _device_id: &str) -> Result<Box<dyn ScannerJob>, ScanError> {
            if let Some(error) = &self.open_error {
                return Err(error.clone());
            }
            let plan = self
                .plan
                .clone()
                .expect("mock scanner was asked for a job it has no plan for");
            Ok(Box::new(MockJob {
                plan,
                transfers: Arc::clone(&self.transfers),
            }))
        }
    }

    fn device(id: &str, name: &str) -> ScannerDeviceInfo {
        ScannerDeviceInfo {
            device_id: id.into(),
            name: name.into(),
        }
    }

    fn page_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("list capture dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    // -- reason codes ------------------------------------------------------

    #[test]
    fn reason_code_vocabulary_is_stable() {
        // These strings are the contract with the capture UI's locale keys.
        let expected = [
            "device_offline",
            "device_busy",
            "device_removed",
            "scan_cancelled",
            "device_error",
        ];
        let actual: Vec<&str> = ScanErrorCode::ALL
            .into_iter()
            .map(ScanErrorCode::as_str)
            .collect();
        assert_eq!(actual, expected);

        for code in ScanErrorCode::ALL {
            assert_eq!(ScanErrorCode::parse(code.as_str()), Some(code));
        }
        assert_eq!(ScanErrorCode::parse("device_on_fire"), None);
    }

    #[test]
    fn windows_scanner_errors_map_to_the_four_named_situations() {
        for (hresult, expected) in [
            // WIA_ERROR_OFFLINE / _WARMING_UP / _DEVICE_COMMUNICATION.
            (0x8021_0005u32, ScanErrorCode::DeviceOffline),
            (0x8021_0007, ScanErrorCode::DeviceOffline),
            (0x8021_000A, ScanErrorCode::DeviceOffline),
            // RPC_S_SERVER_UNAVAILABLE — the WIA service itself is down.
            (0x8007_06BA, ScanErrorCode::DeviceOffline),
            // WIA_ERROR_BUSY / _DEVICE_LOCKED.
            (0x8021_0006, ScanErrorCode::DeviceBusy),
            (0x8021_000D, ScanErrorCode::DeviceBusy),
            // WIA_S_NO_DEVICE_AVAILABLE / _ITEM_DELETED / ERROR_DEVICE_REMOVED.
            (0x8021_0015, ScanErrorCode::DeviceRemoved),
            (0x8021_0009, ScanErrorCode::DeviceRemoved),
            (0x8007_07E6, ScanErrorCode::DeviceRemoved),
            // ERROR_CANCELLED.
            (0x8007_04C7, ScanErrorCode::ScanCancelled),
            // Jams, open covers, driver faults: one generic, actionable code.
            (0x8021_0002, ScanErrorCode::DeviceError),
            (0x8021_0010, ScanErrorCode::DeviceError),
            (0x8000_4005, ScanErrorCode::DeviceError),
        ] {
            assert_eq!(
                map_hresult(hresult as i32),
                expected,
                "0x{hresult:08X} must map to {expected:?}",
            );
        }
    }

    #[test]
    fn discovery_lists_scanners_only() {
        // Cameras and video devices live in the same WIA collection; an
        // invoice-scanning picker must not offer them.
        assert!(is_scanner_device_type(WIA_SCANNER_DEVICE_TYPE));
        for other in [0, 2, 3, 4] {
            assert!(
                !is_scanner_device_type(other),
                "device type {other} is not a scanner",
            );
        }
    }

    // -- discovery ---------------------------------------------------------

    #[test]
    fn listing_returns_each_device_with_its_id_and_name() {
        let host = WiaHost::with_backend_factory(Arc::new(|| {
            Ok(Box::new(MockScanner::with_devices(vec![
                device("wia-1", "Office MFP"),
                device("wia-2", "Desk Scanner"),
            ])) as Box<dyn ScannerBackend>)
        }));

        let devices = host.list_devices().expect("list devices");

        assert_eq!(
            devices,
            vec![
                device("wia-1", "Office MFP"),
                device("wia-2", "Desk Scanner"),
            ]
        );
    }

    #[test]
    fn empty_discovery_is_an_empty_list_not_an_error() {
        // R2.4: no devices is a normal outcome the UI answers by suggesting the
        // watched folder — it must not arrive as a failure.
        let host = WiaHost::with_backend_factory(Arc::new(|| {
            Ok(Box::new(MockScanner::with_devices(Vec::new())) as Box<dyn ScannerBackend>)
        }));

        assert_eq!(host.list_devices().expect("list devices"), Vec::new());
    }

    #[test]
    fn an_unreachable_scanner_lists_as_offline_rather_than_hanging() {
        let host = WiaHost::with_backend_factory(Arc::new(|| {
            Ok(Box::new(MockScanner {
                list_error: Some(ScanError::offline("WIA_ERROR_OFFLINE")),
                ..Default::default()
            }) as Box<dyn ScannerBackend>)
        }));

        let error = host.list_devices().expect_err("offline device");
        assert_eq!(error.code, ScanErrorCode::DeviceOffline);
    }

    // -- the page loop -----------------------------------------------------

    #[test]
    fn a_feeder_keeps_transferring_until_the_paper_runs_out() {
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::feeder(3));

        let outcome = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            0,
            MAX_CAPTURE_PAGES,
        )
        .expect("acquire");

        assert_eq!(outcome.pages.len(), 3);
        assert!(outcome.feeder_used);
        assert!(!outcome.reached_page_cap);
        assert_eq!(
            outcome
                .pages
                .iter()
                .map(|page| page.page_index)
                .collect::<Vec<_>>(),
            vec![0, 1, 2],
        );

        let dir = files::capture_dir(temp.path(), "capture-a").expect("capture dir");
        assert_eq!(
            page_names(&dir),
            ["page-000.png", "page-001.png", "page-002.png"]
        );
    }

    #[test]
    fn a_flatbed_yields_exactly_one_page_however_many_it_would_offer() {
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::flatbed());
        let transfers = Arc::clone(&backend.transfers);

        let outcome = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            0,
            MAX_CAPTURE_PAGES,
        )
        .expect("acquire");

        assert_eq!(outcome.pages.len(), 1);
        assert!(!outcome.feeder_used);
        // The loop stopped asking — it did not scan the same sheet five times.
        assert_eq!(transfers.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn acquiring_again_appends_after_the_pages_already_captured() {
        let temp = TempDir::new();

        // Two pages already on the document (a flatbed user pressing "Add
        // another page" twice).
        for index in 0..2 {
            files::write_page_blocking(temp.path(), "capture-a", index, "image/png", &png_bytes())
                .expect("seed page");
        }

        let mut backend = MockScanner::with_plan(JobPlan::feeder(2));
        let outcome = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            2,
            MAX_CAPTURE_PAGES,
        )
        .expect("acquire");

        assert_eq!(
            outcome
                .pages
                .iter()
                .map(|page| page.page_index)
                .collect::<Vec<_>>(),
            vec![2, 3],
            "new pages append; they never overwrite what is already captured",
        );

        let dir = files::capture_dir(temp.path(), "capture-a").expect("capture dir");
        assert_eq!(
            page_names(&dir),
            [
                "page-000.png",
                "page-001.png",
                "page-002.png",
                "page-003.png"
            ]
        );
    }

    #[test]
    fn a_long_stack_stops_at_the_document_page_cap_and_says_so() {
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::feeder(MAX_CAPTURE_PAGES + 5));

        let outcome = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            0,
            MAX_CAPTURE_PAGES,
        )
        .expect("acquire");

        assert_eq!(outcome.pages.len(), MAX_CAPTURE_PAGES);
        assert!(
            outcome.reached_page_cap,
            "the UI needs to know it can offer 'finish this one and start another'",
        );
    }

    #[test]
    fn a_full_document_refuses_more_pages_before_touching_the_scanner() {
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::feeder(1));
        let transfers = Arc::clone(&backend.transfers);

        let error = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            MAX_CAPTURE_PAGES,
            1,
        )
        .expect_err("document already full");

        assert_eq!(error.code, ScanErrorCode::DeviceError);
        assert_eq!(
            transfers.load(Ordering::SeqCst),
            0,
            "no paper should move for a document that cannot hold the page",
        );
    }

    #[test]
    fn an_empty_feeder_produces_no_pages_rather_than_an_error() {
        // Pressing Scan with nothing loaded is a user situation, not a fault:
        // the document survives and the UI can simply say nothing came through.
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::feeder(0));

        let outcome = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            0,
            MAX_CAPTURE_PAGES,
        )
        .expect("acquire");

        assert!(outcome.pages.is_empty());
        assert!(!outcome.reached_page_cap);
    }

    #[test]
    fn pages_are_on_disk_with_their_digest_before_the_run_reports_them() {
        // R11.1: the receipt a caller records a store row from must describe
        // bytes that are already durable.
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::feeder(2));

        let outcome = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            0,
            MAX_CAPTURE_PAGES,
        )
        .expect("acquire");

        for page in &outcome.pages {
            let bytes = std::fs::read(&page.file_path).expect("page on disk");
            assert_eq!(page.byte_size, bytes.len() as u64);
            assert_eq!(page.content_hash, files::sha256_hex(&bytes));
            assert_eq!(page.mime, "image/png");
        }
    }

    #[test]
    fn a_failure_mid_stack_keeps_the_pages_already_written() {
        let temp = TempDir::new();
        let mut plan = JobPlan::feeder(2);
        // Two good pages, then the scanner is yanked.
        plan.steps.pop_back();
        plan.steps
            .push_back(Err(ScanError::removed("WIA_S_NO_DEVICE_AVAILABLE")));

        let mut backend = MockScanner::with_plan(plan);
        let error = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            0,
            MAX_CAPTURE_PAGES,
        )
        .expect_err("device removed");

        assert_eq!(error.code, ScanErrorCode::DeviceRemoved);

        let dir = files::capture_dir(temp.path(), "capture-a").expect("capture dir");
        assert_eq!(
            page_names(&dir),
            ["page-000.png", "page-001.png"],
            "a failure never takes already-captured pages with it",
        );
    }

    #[test]
    fn a_device_that_will_not_open_reports_its_reason_code() {
        let temp = TempDir::new();
        let mut backend = MockScanner {
            open_error: Some(ScanError::busy("WIA_ERROR_BUSY")),
            ..Default::default()
        };

        let error = acquire_pages(
            &mut backend,
            "wia-1",
            temp.path(),
            "capture-a",
            0,
            MAX_CAPTURE_PAGES,
        )
        .expect_err("busy device");

        assert_eq!(error.code, ScanErrorCode::DeviceBusy);
    }

    // -- image normalization ----------------------------------------------

    #[test]
    fn every_transferred_format_is_stored_as_png() {
        for (label, bytes) in [("png", png_bytes()), ("jpeg", jpeg_bytes())] {
            let normalized = normalize_to_png(&bytes)
                .unwrap_or_else(|e| panic!("normalize {label} transfer: {e}"));
            assert_eq!(
                &normalized[..8],
                b"\x89PNG\r\n\x1a\n",
                "{label} transfer must be stored as PNG",
            );
        }
    }

    #[test]
    fn a_garbled_transfer_is_refused_instead_of_stored_as_evidence() {
        for bytes in [Vec::new(), b"not an image at all".to_vec()] {
            let error = normalize_to_png(&bytes).expect_err("garbled transfer");
            assert_eq!(error.code, ScanErrorCode::DeviceError);
        }
    }

    // -- test scan ---------------------------------------------------------

    #[test]
    fn a_test_scan_writes_one_png_under_the_test_directory() {
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::feeder(4));
        let transfers = Arc::clone(&backend.transfers);

        let outcome = test_scan(&mut backend, "wia-1", temp.path()).expect("test scan");

        let expected_dir =
            files::capture_dir(temp.path(), TEST_SCAN_CAPTURE_ID).expect("test capture dir");
        assert_eq!(outcome.file_path.parent(), Some(expected_dir.as_path()));
        assert_eq!(
            outcome.file_path.file_name().and_then(|n| n.to_str()),
            Some("page-000.png"),
        );

        let bytes = std::fs::read(&outcome.file_path).expect("test page on disk");
        assert_eq!(outcome.byte_size, bytes.len() as u64);
        assert!(
            image::load_from_memory(&bytes).is_ok(),
            "the returned path must show a real image the user can confirm",
        );

        // A setup test proves the device answers; it must not swallow the stack.
        assert_eq!(transfers.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_test_scan_that_produced_nothing_is_a_stated_failure() {
        let temp = TempDir::new();
        let mut backend = MockScanner::with_plan(JobPlan::feeder(0));

        let error = test_scan(&mut backend, "wia-1", temp.path()).expect_err("no page");
        assert_eq!(error.code, ScanErrorCode::DeviceError);
    }

    #[test]
    fn re_testing_a_device_replaces_the_previous_test_page() {
        let temp = TempDir::new();

        for _ in 0..3 {
            let mut backend = MockScanner::with_plan(JobPlan::feeder(1));
            test_scan(&mut backend, "wia-1", temp.path()).expect("test scan");
        }

        let dir = files::capture_dir(temp.path(), TEST_SCAN_CAPTURE_ID).expect("test capture dir");
        assert_eq!(
            page_names(&dir),
            ["page-000.png"],
            "test scans must not accumulate files on the terminal",
        );
    }

    // -- the host thread ---------------------------------------------------

    #[test]
    fn every_com_call_runs_on_one_thread_that_is_not_the_caller() {
        let threads = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::clone(&threads);

        let host = WiaHost::with_backend_factory(Arc::new(move || {
            Ok(Box::new(MockScanner {
                devices: vec![device("wia-1", "Office MFP")],
                threads: Arc::clone(&shared),
                ..Default::default()
            }) as Box<dyn ScannerBackend>)
        }));

        host.list_devices().expect("first list");
        host.list_devices().expect("second list");
        host.list_devices().expect("third list");

        let observed = threads.lock().expect("thread log").clone();
        assert_eq!(observed.len(), 3);
        assert!(
            observed.windows(2).all(|pair| pair[0] == pair[1]),
            "COM must never move between threads: saw {observed:?}",
        );
        assert_ne!(
            observed[0],
            std::thread::current().id(),
            "the host must own its own thread, not borrow the caller's",
        );
        assert_eq!(
            host.start_count(),
            1,
            "one apartment served all three calls"
        );
    }

    #[test]
    fn the_backend_is_built_once_and_reused() {
        let builds = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&builds);

        let host = WiaHost::with_backend_factory(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(
                Box::new(MockScanner::with_devices(vec![device("wia-1", "MFP")]))
                    as Box<dyn ScannerBackend>,
            )
        }));

        host.list_devices().expect("first list");
        host.list_devices().expect("second list");

        assert_eq!(builds.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_driver_panic_becomes_an_error_and_the_next_scan_starts_a_fresh_host() {
        // The failure this guards against is a third-party driver taking the
        // POS down. It must cost one error message and nothing else.
        let exploded = Arc::new(AtomicBool::new(false));
        let builds = Arc::new(AtomicUsize::new(0));
        let flag = Arc::clone(&exploded);
        let counter = Arc::clone(&builds);

        let host = WiaHost::with_backend_factory(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            let first = !flag.swap(true, Ordering::SeqCst);
            Ok(Box::new(MockScanner {
                devices: vec![device("wia-1", "Office MFP")],
                panic_on_list: first,
                ..Default::default()
            }) as Box<dyn ScannerBackend>)
        }));

        let error = host.list_devices().expect_err("panicking driver");
        assert_eq!(error.code, ScanErrorCode::DeviceError);

        // The very next call works — a fresh apartment, transparently.
        let devices = host.list_devices().expect("host recovered");
        assert_eq!(devices, vec![device("wia-1", "Office MFP")]);

        assert_eq!(builds.load(Ordering::SeqCst), 2, "the host restarted once");
        assert_eq!(host.start_count(), 2);
    }

    #[test]
    fn a_backend_that_cannot_start_reports_instead_of_leaving_a_dead_host() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&attempts);

        let host = WiaHost::with_backend_factory(Arc::new(move || {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(ScanError::offline("WIA service unavailable"));
            }
            Ok(
                Box::new(MockScanner::with_devices(vec![device("wia-1", "MFP")]))
                    as Box<dyn ScannerBackend>,
            )
        }));

        let error = host.list_devices().expect_err("startup failure");
        assert_eq!(error.code, ScanErrorCode::DeviceOffline);

        // A failed start is not a permanent one: plugging the scanner in and
        // trying again has to work without restarting the POS.
        host.stop();
        assert_eq!(
            host.list_devices().expect("second attempt"),
            vec![device("wia-1", "MFP")]
        );
    }

    #[test]
    fn an_explicit_stop_retires_the_apartment_and_the_next_call_starts_another() {
        let host = WiaHost::with_backend_factory(Arc::new(|| {
            Ok(
                Box::new(MockScanner::with_devices(vec![device("wia-1", "MFP")]))
                    as Box<dyn ScannerBackend>,
            )
        }));

        host.list_devices().expect("first list");
        assert_eq!(host.start_count(), 1);

        host.stop();

        host.list_devices().expect("list after stop");
        assert_eq!(host.start_count(), 2);
    }

    #[test]
    fn acquire_and_test_run_through_the_host_the_same_way_the_commands_do() {
        let temp = TempDir::new();
        let host = WiaHost::with_backend_factory(Arc::new(|| {
            Ok(Box::new(MockScanner::with_plan(JobPlan::feeder(3))) as Box<dyn ScannerBackend>)
        }));

        let test = host.test_scan("wia-1", temp.path()).expect("test scan");
        assert!(test.file_path.exists());

        let outcome = host
            .acquire("wia-1", temp.path(), "capture-a", 0)
            .expect("acquire");
        assert_eq!(outcome.pages.len(), 3);
        assert!(outcome.feeder_used);
    }
}
