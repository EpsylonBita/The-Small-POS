use chrono::{DateTime, Utc};
use std::sync::{atomic::AtomicBool, Arc};
use thiserror::Error;
use uuid::Uuid;

/// Prefix reserved for document names created by The Small POS.
pub const POS_DOCUMENT_MARKER_PREFIX: &str = "TheSmallPOS";

/// The parsed, canonical ownership identity encoded in a spool document name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PosDocumentMarker {
    pub local_job_id: Uuid,
    pub attempt_id: Uuid,
    pub document_kind: String,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum MarkerParseError {
    #[error("document marker must contain exactly four path segments")]
    SegmentCount,
    #[error("document marker does not use the exact TheSmallPOS prefix")]
    Prefix,
    #[error("document marker contains an invalid local job UUID")]
    LocalJobId,
    #[error("document marker contains an invalid attempt UUID")]
    AttemptId,
    #[error("document marker contains an unsafe document kind")]
    DocumentKind,
}

/// Formats the ownership-only spool document name. It intentionally contains
/// no receipt, customer, or order content.
pub fn format_document_marker(
    local_job_id: Uuid,
    attempt_id: Uuid,
    document_kind: &str,
) -> Result<String, MarkerParseError> {
    validate_document_kind(document_kind)?;
    Ok(format!(
        "{POS_DOCUMENT_MARKER_PREFIX}/{local_job_id}/{attempt_id}/{document_kind}"
    ))
}

/// Parses only the exact marker format emitted by [`format_document_marker`].
pub fn parse_document_marker(value: &str) -> Result<PosDocumentMarker, MarkerParseError> {
    let segments: Vec<&str> = value.split('/').collect();
    if segments.len() != 4 {
        return Err(MarkerParseError::SegmentCount);
    }
    if segments[0] != POS_DOCUMENT_MARKER_PREFIX {
        return Err(MarkerParseError::Prefix);
    }

    let local_job_id = parse_canonical_uuid(segments[1], MarkerParseError::LocalJobId)?;
    let attempt_id = parse_canonical_uuid(segments[2], MarkerParseError::AttemptId)?;
    validate_document_kind(segments[3])?;

    Ok(PosDocumentMarker {
        local_job_id,
        attempt_id,
        document_kind: segments[3].to_owned(),
    })
}

fn parse_canonical_uuid(value: &str, error: MarkerParseError) -> Result<Uuid, MarkerParseError> {
    let parsed = Uuid::parse_str(value).map_err(|_| error.clone())?;
    if value != parsed.hyphenated().to_string() {
        return Err(error);
    }
    Ok(parsed)
}

fn validate_document_kind(value: &str) -> Result<(), MarkerParseError> {
    let is_safe = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if is_safe {
        Ok(())
    } else {
        Err(MarkerParseError::DocumentKind)
    }
}

pub type WindowsJobId = u32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowsRawRequest {
    pub printer_name: String,
    pub document_name: String,
    pub bytes: Arc<[u8]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpoolStarted {
    pub job_id: WindowsJobId,
    pub printer_name: String,
    pub document_name: String,
    pub submitted_at: DateTime<Utc>,
}

/// Spooler acceptance, not evidence that paper was physically printed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpoolSubmission {
    pub started: SpoolStarted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpoolerOperation {
    SubmitRaw,
    GetJob,
    // UNWIRED (queue-scan capability). Only produced by `enum_jobs`, which has no
    // caller yet -- see the "Queue-scan capability" note above `enum_jobs` below.
    #[allow(dead_code)]
    EnumJobs,
    ControlJob,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpoolerInputField {
    PrinterName,
    DocumentName,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpoolerPrimitive {
    WritePrinter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeJobField {
    PrinterName,
    DocumentName,
    Status,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MalformedResponseKind {
    CopiedBytesExceedAllocation,
    ResponseRangeOverflow,
    StructMisaligned,
    ShortStructRegion,
    CountInconsistent,
    CountOverflow,
    PointerOutOfRange { field: NativeJobField },
    PointerOutsideCopiedRegion { field: NativeJobField },
    PointerMisaligned { field: NativeJobField },
    MissingTerminator { field: NativeJobField },
    NullRequiredField { field: NativeJobField },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BufferSizingIssue {
    Zero,
    NonGrowing,
    ExceedsLimit,
    ArithmeticOverflow,
    AllocationFailed,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum SpoolerError {
    #[error("spool submission was cancelled")]
    Cancelled,
    #[error("spooler {operation:?} operation failed (code: {code:?})")]
    Operation {
        operation: SpoolerOperation,
        code: Option<u32>,
    },
    #[error("spooler {operation:?} native operation failed ({kind:?}, code: {code})")]
    NativeOperation {
        operation: SpoolerOperation,
        kind: NativeErrorKind,
        code: u32,
    },
    #[error("spooler {operation:?} rejected invalid {field:?} input")]
    InvalidInput {
        operation: SpoolerOperation,
        field: SpoolerInputField,
    },
    #[error("spooler {operation:?} {primitive:?} wrote {written} of {expected} bytes")]
    PartialWrite {
        operation: SpoolerOperation,
        primitive: SpoolerPrimitive,
        expected: u32,
        written: u32,
    },
    #[error("spooler {operation:?} returned malformed native data ({reason:?})")]
    MalformedResponse {
        operation: SpoolerOperation,
        reason: MalformedResponseKind,
    },
    #[error("spooler {operation:?} buffer sizing failed ({reason:?}, requested: {requested})")]
    BufferSizing {
        operation: SpoolerOperation,
        reason: BufferSizingIssue,
        requested: usize,
    },
    // Test-only. Production never raises this: the dispatch deadline is enforced one
    // layer up, where `print.rs` waits on the submission channel and maps a timeout to
    // `ParentTransition::ManualFailure`. Only the fake spooler constructs it, to drive
    // that path. Kept behind cfg(test) so it stays out of the shipped error surface.
    #[cfg(test)]
    #[error("spooler {operation:?} operation timed out")]
    TimedOut { operation: SpoolerOperation },
    #[error(
        "spool submission failed after native JobId {job_id} existed (abort succeeded: {abort_succeeded}): {cause}",
        job_id = .started.job_id
    )]
    AfterStart {
        started: SpoolStarted,
        abort_succeeded: bool,
        #[source]
        cause: Box<SpoolerError>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpoolJobSnapshot {
    pub job_id: WindowsJobId,
    pub printer_name: String,
    pub document_name: String,
    pub status_text: Option<String>,
    pub status_bits: u32,
    pub position: u32,
    pub total_pages: u32,
    pub pages_printed: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpoolJobControl {
    Pause,
    Resume,
    Delete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeJobStatus {
    Error,
    Offline,
    PaperOut,
    BlockedDeviceQueue,
    UserIntervention,
    Paused,
    Deleting,
    Printing,
    Spooling,
    Deleted,
    Printed,
    Complete,
    Unknown,
}

pub(crate) fn native_job_is_paused(status_bits: u32) -> bool {
    #[cfg(target_os = "windows")]
    use windows_sys::Win32::Graphics::Printing::JOB_STATUS_PAUSED;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_PAUSED: u32 = 0x0000_0001;

    status_bits & JOB_STATUS_PAUSED != 0
}

/// Maps the Winspool level-1 status bitmask using a stable severity-first
/// precedence while callers retain the original bits in [`SpoolJobSnapshot`].
pub fn map_native_job_status(status_bits: u32) -> NativeJobStatus {
    #[cfg(target_os = "windows")]
    use windows_sys::Win32::Graphics::Printing::{
        JOB_STATUS_BLOCKED_DEVQ, JOB_STATUS_COMPLETE, JOB_STATUS_DELETED, JOB_STATUS_DELETING,
        JOB_STATUS_ERROR, JOB_STATUS_OFFLINE, JOB_STATUS_PAPEROUT, JOB_STATUS_PAUSED,
        JOB_STATUS_PRINTED, JOB_STATUS_PRINTING, JOB_STATUS_SPOOLING, JOB_STATUS_USER_INTERVENTION,
    };
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_PAUSED: u32 = 0x0000_0001;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_ERROR: u32 = 0x0000_0002;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_DELETING: u32 = 0x0000_0004;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_SPOOLING: u32 = 0x0000_0008;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_PRINTING: u32 = 0x0000_0010;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_OFFLINE: u32 = 0x0000_0020;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_PAPEROUT: u32 = 0x0000_0040;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_PRINTED: u32 = 0x0000_0080;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_DELETED: u32 = 0x0000_0100;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_BLOCKED_DEVQ: u32 = 0x0000_0200;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_USER_INTERVENTION: u32 = 0x0000_0400;
    #[cfg(not(target_os = "windows"))]
    const JOB_STATUS_COMPLETE: u32 = 0x0000_1000;

    const ORDERED_STATUSES: &[(u32, NativeJobStatus)] = &[
        (JOB_STATUS_ERROR, NativeJobStatus::Error),
        (JOB_STATUS_OFFLINE, NativeJobStatus::Offline),
        (JOB_STATUS_PAPEROUT, NativeJobStatus::PaperOut),
        (JOB_STATUS_BLOCKED_DEVQ, NativeJobStatus::BlockedDeviceQueue),
        (
            JOB_STATUS_USER_INTERVENTION,
            NativeJobStatus::UserIntervention,
        ),
        (JOB_STATUS_PAUSED, NativeJobStatus::Paused),
        (JOB_STATUS_DELETING, NativeJobStatus::Deleting),
        (JOB_STATUS_PRINTING, NativeJobStatus::Printing),
        (JOB_STATUS_SPOOLING, NativeJobStatus::Spooling),
        (JOB_STATUS_DELETED, NativeJobStatus::Deleted),
        (JOB_STATUS_PRINTED, NativeJobStatus::Printed),
        (JOB_STATUS_COMPLETE, NativeJobStatus::Complete),
    ];

    ORDERED_STATUSES
        .iter()
        .find_map(|(bit, status)| (status_bits & bit != 0).then_some(*status))
        .unwrap_or(NativeJobStatus::Unknown)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeErrorKind {
    AccessDenied,
    InvalidJob,
    BufferSizing,
    Other(u32),
}

pub fn map_native_error_code(code: u32) -> NativeErrorKind {
    match code {
        5 => NativeErrorKind::AccessDenied,
        87 => NativeErrorKind::InvalidJob,
        122 => NativeErrorKind::BufferSizing,
        other => NativeErrorKind::Other(other),
    }
}

fn native_control_code(control: SpoolJobControl) -> u32 {
    #[cfg(target_os = "windows")]
    use windows_sys::Win32::Graphics::Printing::{
        JOB_CONTROL_DELETE, JOB_CONTROL_PAUSE, JOB_CONTROL_RESUME,
    };
    #[cfg(not(target_os = "windows"))]
    const JOB_CONTROL_PAUSE: u32 = 1;
    #[cfg(not(target_os = "windows"))]
    const JOB_CONTROL_RESUME: u32 = 2;
    #[cfg(not(target_os = "windows"))]
    const JOB_CONTROL_DELETE: u32 = 5;

    match control {
        SpoolJobControl::Pause => JOB_CONTROL_PAUSE,
        SpoolJobControl::Resume => JOB_CONTROL_RESUME,
        SpoolJobControl::Delete => JOB_CONTROL_DELETE,
    }
}

#[derive(Debug)]
struct OwnedUtf16(Vec<u16>);

impl OwnedUtf16 {
    fn new(
        value: &str,
        operation: SpoolerOperation,
        field: SpoolerInputField,
    ) -> Result<Self, SpoolerError> {
        if value.encode_utf16().any(|unit| unit == 0) {
            return Err(SpoolerError::InvalidInput { operation, field });
        }

        let mut units: Vec<u16> = value.encode_utf16().collect();
        units.push(0);
        Ok(Self(units))
    }

    fn as_slice(&self) -> &[u16] {
        &self.0
    }
}

fn validate_write_count(expected: u32, written: u32) -> Result<(), SpoolerError> {
    if expected == written {
        Ok(())
    } else {
        Err(SpoolerError::PartialWrite {
            operation: SpoolerOperation::SubmitRaw,
            primitive: SpoolerPrimitive::WritePrinter,
            expected,
            written,
        })
    }
}

// UNWIRED (queue-scan capability). Decodes one JOB_INFO_1W slot from a whole-queue
// enumeration; only `enum_jobs` produces these. The single-job path (`get_job`, which
// production does use) reads its snapshot directly and never batches. Retained with the
// rest of the queue-scan capability -- see the note above `enum_jobs` below.
#[allow(dead_code)]
struct LevelOneJobFields<'a> {
    job_id: WindowsJobId,
    printer_name: Option<&'a [u16]>,
    document_name: Option<&'a [u16]>,
    status_text: Option<&'a [u16]>,
    status_bits: u32,
    position: u32,
    total_pages: u32,
    pages_printed: u32,
}

// UNWIRED (queue-scan capability). Sole consumer of `LevelOneJobFields`; reachable only
// through `enum_jobs`. See the note above `enum_jobs` below.
#[allow(dead_code)]
fn snapshot_from_level_one(fields: LevelOneJobFields<'_>) -> SpoolJobSnapshot {
    let decode = |value: Option<&[u16]>| value.map(String::from_utf16_lossy).unwrap_or_default();
    SpoolJobSnapshot {
        job_id: fields.job_id,
        printer_name: decode(fields.printer_name),
        document_name: decode(fields.document_name),
        status_text: fields.status_text.map(String::from_utf16_lossy),
        status_bits: fields.status_bits,
        position: fields.position,
        total_pages: fields.total_pages,
        pages_printed: fields.pages_printed,
    }
}

/// Portable boundary for the later Windows spooler implementation.
pub trait WindowsSpooler: Send + Sync + 'static {
    fn submit_raw(
        &self,
        request: WindowsRawRequest,
        cancel: &AtomicBool,
        on_started: &mut dyn FnMut(&SpoolStarted) -> Result<(), SpoolerError>,
    ) -> Result<SpoolSubmission, SpoolerError>;

    fn get_job(
        &self,
        printer_name: &str,
        job_id: WindowsJobId,
    ) -> Result<Option<SpoolJobSnapshot>, SpoolerError>;

    // UNWIRED -- queue-scan capability, kept deliberately.
    //
    // Enumerates every job on a printer queue. Nothing calls it: crash recovery does not
    // need it, because `persist_spool_started` records the native job id and recovery
    // re-reads that one job through `get_job`.
    //
    // Its intended consumer was never written -- an orphan sweep that scans a queue for
    // entries whose spool id we lost (marker parsed back out of the document name via
    // `parse_document_marker`) plus legacy entries from older POS builds
    // (`is_exact_legacy_pos_document_name`). That feature needs an operator-confirmation
    // UI before it may act on anything, which is why it stopped here.
    //
    // Retained rather than deleted: the real implementation is vetted `unsafe` EnumJobs
    // code with non-obvious buffer sizing and alignment handling that is expensive to
    // reconstruct. Deleting it would also strand `SpoolerOperation::EnumJobs`,
    // `LevelOneJobFields`, `snapshot_from_level_one` and
    // `is_exact_legacy_pos_document_name`, which exist only to serve it.
    #[allow(dead_code)]
    fn enum_jobs(&self, printer_name: &str) -> Result<Vec<SpoolJobSnapshot>, SpoolerError>;

    fn control_job(
        &self,
        printer_name: &str,
        job_id: WindowsJobId,
        control: SpoolJobControl,
    ) -> Result<(), SpoolerError>;
}

#[derive(Clone, Copy, Debug, Default)]
/// Crate-private native primitive. Production control callers must query and
/// validate the exact document ownership plus active SQLite state immediately
/// before invoking [`WindowsSpooler::control_job`].
pub(crate) struct SystemWindowsSpooler;

#[cfg(target_os = "windows")]
mod system {
    use super::*;
    use std::{
        mem::{align_of, size_of, MaybeUninit},
        ptr,
        sync::atomic::Ordering,
    };
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, HANDLE},
        Graphics::Printing::{
            AbortPrinter, ClosePrinter, EndDocPrinter, EndPagePrinter, EnumJobsW, GetJobW,
            OpenPrinterW, SetJobW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W,
            JOB_INFO_1W,
        },
    };

    const RAW_CHUNK_SIZE: usize = 4096;
    const BUFFER_RETRIES: usize = 3;
    /// Native query buffers are capped at the greatest whole JOB_INFO_1W slot
    /// not exceeding 32 MiB. This is far above practical spool queues while
    /// preventing an untrusted/buggy spooler size report from exhausting POS
    /// memory. Keeping the bound slot-aligned avoids hidden rounding growth.
    const MAX_NATIVE_JOB_BUFFER_BYTES: usize =
        (32 * 1024 * 1024 / size_of::<JOB_INFO_1W>()) * size_of::<JOB_INFO_1W>();

    struct PrinterHandle(HANDLE);

    impl PrinterHandle {
        fn open(
            printer_name: &OwnedUtf16,
            operation: SpoolerOperation,
        ) -> Result<Self, SpoolerError> {
            let mut handle = ptr::null_mut();
            // SAFETY: `printer_name` owns a stable NUL-terminated UTF-16 buffer
            // for the duration of the call, `handle` is a valid out-pointer,
            // and a null PRINTER_DEFAULTS pointer requests Winspool defaults.
            let opened =
                unsafe { OpenPrinterW(printer_name.as_slice().as_ptr(), &mut handle, ptr::null()) };
            if opened == 0 || handle.is_null() {
                return Err(last_operation_error(operation));
            }
            Ok(Self(handle))
        }
    }

    impl Drop for PrinterHandle {
        fn drop(&mut self) {
            // SAFETY: `PrinterHandle` is created only from one successful
            // `OpenPrinterW` result and never exposes ownership of its handle,
            // so Drop closes that non-null handle exactly once.
            unsafe {
                ClosePrinter(self.0);
            }
        }
    }

    trait RawSubmissionApi {
        type Handle: Copy;

        fn open(&self, printer_name: &OwnedUtf16) -> Result<Self::Handle, SpoolerError>;
        fn close(&self, handle: Self::Handle);
        fn start_doc(
            &self,
            handle: Self::Handle,
            document_name: &OwnedUtf16,
            datatype: &OwnedUtf16,
        ) -> Result<u32, SpoolerError>;
        fn start_page(&self, handle: Self::Handle) -> Result<(), SpoolerError>;
        fn write(&self, handle: Self::Handle, bytes: &[u8]) -> Result<u32, SpoolerError>;
        fn end_page(&self, handle: Self::Handle) -> Result<(), SpoolerError>;
        fn end_doc(&self, handle: Self::Handle) -> Result<(), SpoolerError>;
        fn abort(&self, handle: Self::Handle) -> Result<(), SpoolerError>;
    }

    struct SubmissionHandle<'a, A: RawSubmissionApi> {
        api: &'a A,
        raw: A::Handle,
    }

    impl<'a, A: RawSubmissionApi> SubmissionHandle<'a, A> {
        fn open(api: &'a A, printer_name: &OwnedUtf16) -> Result<Self, SpoolerError> {
            Ok(Self {
                api,
                raw: api.open(printer_name)?,
            })
        }
    }

    impl<A: RawSubmissionApi> Drop for SubmissionHandle<'_, A> {
        fn drop(&mut self) {
            self.api.close(self.raw);
        }
    }

    struct SystemRawSubmissionApi;

    impl RawSubmissionApi for SystemRawSubmissionApi {
        type Handle = HANDLE;

        fn open(&self, printer_name: &OwnedUtf16) -> Result<Self::Handle, SpoolerError> {
            let mut handle = ptr::null_mut();
            // SAFETY: printer_name is stable NUL-terminated UTF-16, handle is a
            // valid out-pointer, and null defaults request Winspool defaults.
            let opened =
                unsafe { OpenPrinterW(printer_name.as_slice().as_ptr(), &mut handle, ptr::null()) };
            if opened == 0 || handle.is_null() {
                Err(last_operation_error(SpoolerOperation::SubmitRaw))
            } else {
                Ok(handle)
            }
        }

        fn close(&self, handle: Self::Handle) {
            // SAFETY: SubmissionHandle owns one successful OpenPrinterW handle
            // and invokes close exactly once from Drop.
            unsafe {
                ClosePrinter(handle);
            }
        }

        fn start_doc(
            &self,
            handle: Self::Handle,
            document_name: &OwnedUtf16,
            datatype: &OwnedUtf16,
        ) -> Result<u32, SpoolerError> {
            let doc_info = DOC_INFO_1W {
                pDocName: document_name.as_slice().as_ptr().cast_mut(),
                pOutputFile: ptr::null_mut(),
                pDatatype: datatype.as_slice().as_ptr().cast_mut(),
            };
            // SAFETY: handle is open and DOC_INFO_1W points to stable,
            // NUL-terminated buffers for the duration of the call.
            let job_id = unsafe { StartDocPrinterW(handle, 1, &doc_info) };
            if job_id == 0 {
                Err(last_operation_error(SpoolerOperation::SubmitRaw))
            } else {
                Ok(job_id)
            }
        }

        fn start_page(&self, handle: Self::Handle) -> Result<(), SpoolerError> {
            // SAFETY: StartDocPrinterW succeeded on this live handle.
            if unsafe { StartPagePrinter(handle) } == 0 {
                Err(last_operation_error(SpoolerOperation::SubmitRaw))
            } else {
                Ok(())
            }
        }

        fn write(&self, handle: Self::Handle, bytes: &[u8]) -> Result<u32, SpoolerError> {
            let mut written = 0u32;
            // SAFETY: bytes is readable for its bounded length (at most 4096)
            // during the call and written is a valid out-pointer.
            let result = unsafe {
                WritePrinter(
                    handle,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    &mut written,
                )
            };
            if result == 0 {
                Err(last_operation_error(SpoolerOperation::SubmitRaw))
            } else {
                Ok(written)
            }
        }

        fn end_page(&self, handle: Self::Handle) -> Result<(), SpoolerError> {
            // SAFETY: StartPagePrinter succeeded on this live document.
            if unsafe { EndPagePrinter(handle) } == 0 {
                Err(last_operation_error(SpoolerOperation::SubmitRaw))
            } else {
                Ok(())
            }
        }

        fn end_doc(&self, handle: Self::Handle) -> Result<(), SpoolerError> {
            // SAFETY: StartDocPrinterW succeeded and this is the sole success
            // finalization path for the document.
            if unsafe { EndDocPrinter(handle) } == 0 {
                Err(last_operation_error(SpoolerOperation::SubmitRaw))
            } else {
                Ok(())
            }
        }

        fn abort(&self, handle: Self::Handle) -> Result<(), SpoolerError> {
            // SAFETY: this runs only after StartDocPrinterW succeeds and before
            // the owning handle guard closes. The result is retained as cleanup
            // context; it never proves that the exact native JobId disappeared.
            if unsafe { AbortPrinter(handle) } == 0 {
                Err(last_operation_error(SpoolerOperation::SubmitRaw))
            } else {
                Ok(())
            }
        }
    }

    fn submit_raw_with_api<A: RawSubmissionApi>(
        api: &A,
        request: WindowsRawRequest,
        cancel: &AtomicBool,
        on_started: &mut dyn FnMut(&SpoolStarted) -> Result<(), SpoolerError>,
    ) -> Result<SpoolSubmission, SpoolerError> {
        cancelled(cancel)?;
        let printer_name = OwnedUtf16::new(
            &request.printer_name,
            SpoolerOperation::SubmitRaw,
            SpoolerInputField::PrinterName,
        )?;
        let document_name = OwnedUtf16::new(
            &request.document_name,
            SpoolerOperation::SubmitRaw,
            SpoolerInputField::DocumentName,
        )?;
        let datatype = OwnedUtf16(vec![b'R' as u16, b'A' as u16, b'W' as u16, 0]);
        cancelled(cancel)?;

        let handle = SubmissionHandle::open(api, &printer_name)?;
        cancelled(cancel)?;
        let job_id = api.start_doc(handle.raw, &document_name, &datatype)?;
        let started = SpoolStarted {
            job_id,
            printer_name: request.printer_name.clone(),
            document_name: request.document_name.clone(),
            submitted_at: Utc::now(),
        };

        let submission = (|| -> Result<(), SpoolerError> {
            on_started(&started)?;
            cancelled(cancel)?;
            api.start_page(handle.raw)?;
            for chunk in request.bytes.chunks(RAW_CHUNK_SIZE) {
                cancelled(cancel)?;
                let written = api.write(handle.raw, chunk)?;
                validate_write_count(chunk.len() as u32, written)?;
            }
            cancelled(cancel)?;
            api.end_page(handle.raw)?;
            cancelled(cancel)?;
            api.end_doc(handle.raw)?;
            Ok(())
        })();
        match submission {
            Ok(()) => Ok(SpoolSubmission { started }),
            Err(cause) => {
                let abort_succeeded = api.abort(handle.raw).is_ok();
                Err(SpoolerError::AfterStart {
                    started,
                    abort_succeeded,
                    cause: Box::new(cause),
                })
            }
        }
    }

    struct AlignedJobBuffer {
        storage: Vec<MaybeUninit<JOB_INFO_1W>>,
        allocation_size: usize,
        cb_size: u32,
    }

    impl AlignedJobBuffer {
        fn try_new(
            required_bytes: usize,
            operation: SpoolerOperation,
        ) -> Result<Self, SpoolerError> {
            let allocation_size = validated_buffer_allocation_size(required_bytes, operation)?;
            let slot_size = size_of::<JOB_INFO_1W>();
            let slots = allocation_size / slot_size;
            let cb_size =
                u32::try_from(allocation_size).map_err(|_| SpoolerError::BufferSizing {
                    operation,
                    reason: BufferSizingIssue::ArithmeticOverflow,
                    requested: required_bytes,
                })?;
            let mut storage = Vec::new();
            storage
                .try_reserve_exact(slots)
                .map_err(|_| SpoolerError::BufferSizing {
                    operation,
                    reason: BufferSizingIssue::AllocationFailed,
                    requested: required_bytes,
                })?;
            storage.resize_with(slots, MaybeUninit::uninit);
            Ok(Self {
                storage,
                allocation_size,
                cb_size,
            })
        }

        fn as_mut_bytes(&mut self) -> *mut u8 {
            self.storage.as_mut_ptr().cast::<u8>()
        }

        fn allocation_size(&self) -> usize {
            self.allocation_size
        }

        fn cb_size(&self) -> u32 {
            self.cb_size
        }
    }

    fn buffer_sizing_error(
        operation: SpoolerOperation,
        reason: BufferSizingIssue,
        requested: usize,
    ) -> SpoolerError {
        SpoolerError::BufferSizing {
            operation,
            reason,
            requested,
        }
    }

    fn validated_buffer_allocation_size(
        required_bytes: usize,
        operation: SpoolerOperation,
    ) -> Result<usize, SpoolerError> {
        if required_bytes == 0 {
            return Err(buffer_sizing_error(
                operation,
                BufferSizingIssue::Zero,
                required_bytes,
            ));
        }
        if required_bytes > MAX_NATIVE_JOB_BUFFER_BYTES || required_bytes > u32::MAX as usize {
            return Err(buffer_sizing_error(
                operation,
                BufferSizingIssue::ExceedsLimit,
                required_bytes,
            ));
        }

        let slot_size = size_of::<JOB_INFO_1W>();
        let slots = required_bytes
            .checked_add(slot_size - 1)
            .and_then(|rounded| rounded.checked_div(slot_size))
            .ok_or_else(|| {
                buffer_sizing_error(
                    operation,
                    BufferSizingIssue::ArithmeticOverflow,
                    required_bytes,
                )
            })?;
        let allocation_size = slots.checked_mul(slot_size).ok_or_else(|| {
            buffer_sizing_error(
                operation,
                BufferSizingIssue::ArithmeticOverflow,
                required_bytes,
            )
        })?;
        if allocation_size > MAX_NATIVE_JOB_BUFFER_BYTES {
            return Err(buffer_sizing_error(
                operation,
                BufferSizingIssue::ExceedsLimit,
                required_bytes,
            ));
        }
        u32::try_from(allocation_size).map_err(|_| {
            buffer_sizing_error(
                operation,
                BufferSizingIssue::ArithmeticOverflow,
                required_bytes,
            )
        })?;
        Ok(allocation_size)
    }

    fn validate_buffer_growth(
        previous_allocation: usize,
        reported_needed: usize,
        operation: SpoolerOperation,
    ) -> Result<usize, SpoolerError> {
        if reported_needed == 0 || reported_needed <= previous_allocation {
            return Err(buffer_sizing_error(
                operation,
                BufferSizingIssue::NonGrowing,
                reported_needed,
            ));
        }
        validated_buffer_allocation_size(reported_needed, operation)?;
        Ok(reported_needed)
    }

    fn malformed(operation: SpoolerOperation, reason: MalformedResponseKind) -> SpoolerError {
        SpoolerError::MalformedResponse { operation, reason }
    }

    fn checked_struct_bytes(
        count: usize,
        operation: SpoolerOperation,
    ) -> Result<usize, SpoolerError> {
        count
            .checked_mul(size_of::<JOB_INFO_1W>())
            .ok_or_else(|| malformed(operation, MalformedResponseKind::CountOverflow))
    }

    unsafe fn copy_native_wide(
        value: *const u16,
        required: bool,
        field: NativeJobField,
        allocation_start: usize,
        allocation_end: usize,
        copied_end: usize,
        operation: SpoolerOperation,
    ) -> Result<Option<String>, SpoolerError> {
        if value.is_null() {
            return if required {
                Err(malformed(
                    operation,
                    MalformedResponseKind::NullRequiredField { field },
                ))
            } else {
                Ok(None)
            };
        }

        let address = value as usize;
        if address < allocation_start || address >= allocation_end {
            return Err(malformed(
                operation,
                MalformedResponseKind::PointerOutOfRange { field },
            ));
        }
        if address >= copied_end {
            return Err(malformed(
                operation,
                MalformedResponseKind::PointerOutsideCopiedRegion { field },
            ));
        }
        if address % align_of::<u16>() != 0 {
            return Err(malformed(
                operation,
                MalformedResponseKind::PointerMisaligned { field },
            ));
        }

        let readable_units = (copied_end - address) / size_of::<u16>();
        for len in 0..readable_units {
            // SAFETY: address is aligned and the loop is bounded to complete
            // u16 elements wholly inside the API-reported initialized region.
            if unsafe { *value.add(len) } == 0 {
                // SAFETY: the preceding bounded scan established `len`
                // initialized, aligned UTF-16 units before the terminator.
                let units = unsafe { std::slice::from_raw_parts(value, len) };
                return Ok(Some(String::from_utf16_lossy(units)));
            }
        }
        Err(malformed(
            operation,
            MalformedResponseKind::MissingTerminator { field },
        ))
    }

    unsafe fn decode_level_one_response(
        allocation_base: *const u8,
        allocation_size: usize,
        copied_bytes: usize,
        count: usize,
        operation: SpoolerOperation,
    ) -> Result<Vec<SpoolJobSnapshot>, SpoolerError> {
        if copied_bytes > allocation_size {
            return Err(malformed(
                operation,
                MalformedResponseKind::CopiedBytesExceedAllocation,
            ));
        }
        let allocation_start = allocation_base as usize;
        let allocation_end = allocation_start
            .checked_add(allocation_size)
            .ok_or_else(|| malformed(operation, MalformedResponseKind::ResponseRangeOverflow))?;
        let copied_end = allocation_start
            .checked_add(copied_bytes)
            .ok_or_else(|| malformed(operation, MalformedResponseKind::ResponseRangeOverflow))?;
        if allocation_base.is_null() || allocation_start % align_of::<JOB_INFO_1W>() != 0 {
            return Err(malformed(
                operation,
                MalformedResponseKind::StructMisaligned,
            ));
        }

        let struct_bytes = checked_struct_bytes(count, operation)?;
        if struct_bytes > copied_bytes {
            let reason = if count > 0 && copied_bytes < size_of::<JOB_INFO_1W>() {
                MalformedResponseKind::ShortStructRegion
            } else {
                MalformedResponseKind::CountInconsistent
            };
            return Err(malformed(operation, reason));
        }

        let mut snapshots = Vec::new();
        snapshots.try_reserve_exact(count).map_err(|_| {
            buffer_sizing_error(operation, BufferSizingIssue::AllocationFailed, copied_bytes)
        })?;
        for index in 0..count {
            // SAFETY: base alignment and checked `count * size_of` prove this
            // complete JOB_INFO_1W lies in the API-reported initialized region.
            // Copying one value avoids forming a slice over allocation tail.
            let info = unsafe { ptr::read(allocation_base.cast::<JOB_INFO_1W>().add(index)) };
            // SAFETY: each helper validates nullability, alignment, allocation
            // range, initialized-region range, and a bounded NUL terminator
            // before reading/copying any UTF-16 units.
            let printer_name = unsafe {
                copy_native_wide(
                    info.pPrinterName,
                    true,
                    NativeJobField::PrinterName,
                    allocation_start,
                    allocation_end,
                    copied_end,
                    operation,
                )
            }?
            .ok_or_else(|| {
                malformed(
                    operation,
                    MalformedResponseKind::NullRequiredField {
                        field: NativeJobField::PrinterName,
                    },
                )
            })?;
            // SAFETY: same bounded decoder contract as printer_name.
            let document_name = unsafe {
                copy_native_wide(
                    info.pDocument,
                    true,
                    NativeJobField::DocumentName,
                    allocation_start,
                    allocation_end,
                    copied_end,
                    operation,
                )
            }?
            .ok_or_else(|| {
                malformed(
                    operation,
                    MalformedResponseKind::NullRequiredField {
                        field: NativeJobField::DocumentName,
                    },
                )
            })?;
            // SAFETY: status is optional, but every non-null pointer receives
            // the identical range/alignment/terminator validation.
            let status_text = unsafe {
                copy_native_wide(
                    info.pStatus,
                    false,
                    NativeJobField::Status,
                    allocation_start,
                    allocation_end,
                    copied_end,
                    operation,
                )
            }?;
            snapshots.push(SpoolJobSnapshot {
                job_id: info.JobId,
                printer_name,
                document_name,
                status_text,
                status_bits: info.Status,
                position: info.Position,
                total_pages: info.TotalPages,
                pages_printed: info.PagesPrinted,
            });
        }
        Ok(snapshots)
    }

    fn operation_error(operation: SpoolerOperation, code: u32) -> SpoolerError {
        SpoolerError::NativeOperation {
            operation,
            kind: map_native_error_code(code),
            code,
        }
    }

    fn last_operation_error(operation: SpoolerOperation) -> SpoolerError {
        // SAFETY: GetLastError has no pointer preconditions and is called
        // immediately after the failed Win32 operation on the same thread.
        operation_error(operation, unsafe { GetLastError() })
    }

    fn cancelled(cancel: &AtomicBool) -> Result<(), SpoolerError> {
        if cancel.load(Ordering::Acquire) {
            Err(SpoolerError::Cancelled)
        } else {
            Ok(())
        }
    }

    impl WindowsSpooler for SystemWindowsSpooler {
        fn submit_raw(
            &self,
            request: WindowsRawRequest,
            cancel: &AtomicBool,
            on_started: &mut dyn FnMut(&SpoolStarted) -> Result<(), SpoolerError>,
        ) -> Result<SpoolSubmission, SpoolerError> {
            submit_raw_with_api(&SystemRawSubmissionApi, request, cancel, on_started)
        }

        fn get_job(
            &self,
            printer_name: &str,
            job_id: WindowsJobId,
        ) -> Result<Option<SpoolJobSnapshot>, SpoolerError> {
            let printer_name = OwnedUtf16::new(
                printer_name,
                SpoolerOperation::GetJob,
                SpoolerInputField::PrinterName,
            )?;
            let handle = PrinterHandle::open(&printer_name, SpoolerOperation::GetJob)?;
            let mut needed = 0u32;
            // SAFETY: handle is live; null/zero is the documented sizing call
            // and `needed` is a valid out-pointer.
            let sized = unsafe { GetJobW(handle.0, job_id, 1, ptr::null_mut(), 0, &mut needed) };
            if sized == 0 {
                // SAFETY: read immediately after the failed GetJobW call.
                let code = unsafe { GetLastError() };
                if code == ERROR_INVALID_PARAMETER {
                    return Ok(None);
                }
                if code != ERROR_INSUFFICIENT_BUFFER {
                    return Err(operation_error(SpoolerOperation::GetJob, code));
                }
            }

            for _ in 0..BUFFER_RETRIES {
                let mut buffer =
                    AlignedJobBuffer::try_new(needed as usize, SpoolerOperation::GetJob)?;
                let capacity = buffer.cb_size();
                let allocation_size = buffer.allocation_size();
                let mut next_needed = 0u32;
                // SAFETY: buffer is writable/aligned for `capacity` bytes and
                // remains live while only API-reported copied bytes are decoded.
                let result = unsafe {
                    GetJobW(
                        handle.0,
                        job_id,
                        1,
                        buffer.as_mut_bytes(),
                        capacity,
                        &mut next_needed,
                    )
                };
                if result != 0 {
                    // SAFETY: buffer is live and aligned; the decoder treats
                    // `next_needed` as the exclusive initialized-byte boundary
                    // and validates the single structure and every pointer.
                    let snapshots = unsafe {
                        decode_level_one_response(
                            buffer.as_mut_bytes(),
                            allocation_size,
                            next_needed as usize,
                            1,
                            SpoolerOperation::GetJob,
                        )
                    }?;
                    return snapshots.into_iter().next().map(Some).ok_or_else(|| {
                        malformed(
                            SpoolerOperation::GetJob,
                            MalformedResponseKind::CountInconsistent,
                        )
                    });
                }

                // SAFETY: read immediately after the failed GetJobW call.
                let code = unsafe { GetLastError() };
                if code == ERROR_INVALID_PARAMETER {
                    return Ok(None);
                }
                if code != ERROR_INSUFFICIENT_BUFFER {
                    return Err(operation_error(SpoolerOperation::GetJob, code));
                }
                needed = u32::try_from(validate_buffer_growth(
                    allocation_size,
                    next_needed as usize,
                    SpoolerOperation::GetJob,
                )?)
                .map_err(|_| {
                    buffer_sizing_error(
                        SpoolerOperation::GetJob,
                        BufferSizingIssue::ArithmeticOverflow,
                        next_needed as usize,
                    )
                })?;
            }
            Err(operation_error(
                SpoolerOperation::GetJob,
                ERROR_INSUFFICIENT_BUFFER,
            ))
        }

        fn enum_jobs(&self, printer_name: &str) -> Result<Vec<SpoolJobSnapshot>, SpoolerError> {
            let printer_name = OwnedUtf16::new(
                printer_name,
                SpoolerOperation::EnumJobs,
                SpoolerInputField::PrinterName,
            )?;
            let handle = PrinterHandle::open(&printer_name, SpoolerOperation::EnumJobs)?;
            let mut needed = 0u32;
            let mut returned = 0u32;
            // SAFETY: handle is live; null/zero is the documented sizing call,
            // and both output counters are valid pointers.
            let sized = unsafe {
                EnumJobsW(
                    handle.0,
                    0,
                    u32::MAX,
                    1,
                    ptr::null_mut(),
                    0,
                    &mut needed,
                    &mut returned,
                )
            };
            if sized != 0 && returned == 0 {
                return Ok(Vec::new());
            }
            if sized == 0 {
                // SAFETY: read immediately after the failed EnumJobsW call.
                let code = unsafe { GetLastError() };
                if code != ERROR_INSUFFICIENT_BUFFER {
                    return Err(operation_error(SpoolerOperation::EnumJobs, code));
                }
            }

            for _ in 0..BUFFER_RETRIES {
                let mut buffer =
                    AlignedJobBuffer::try_new(needed as usize, SpoolerOperation::EnumJobs)?;
                let capacity = buffer.cb_size();
                let allocation_size = buffer.allocation_size();
                let mut next_needed = 0u32;
                returned = 0;
                // SAFETY: buffer is writable/aligned for `capacity` bytes and
                // stays live while only API-reported copied bytes are decoded.
                let result = unsafe {
                    EnumJobsW(
                        handle.0,
                        0,
                        u32::MAX,
                        1,
                        buffer.as_mut_bytes(),
                        capacity,
                        &mut next_needed,
                        &mut returned,
                    )
                };
                if result != 0 {
                    // SAFETY: buffer is live and aligned; the decoder bounds
                    // structures and every string by `next_needed`, then copies
                    // them before the allocation is dropped.
                    return unsafe {
                        decode_level_one_response(
                            buffer.as_mut_bytes(),
                            allocation_size,
                            next_needed as usize,
                            returned as usize,
                            SpoolerOperation::EnumJobs,
                        )
                    };
                }

                // SAFETY: read immediately after the failed EnumJobsW call.
                let code = unsafe { GetLastError() };
                if code != ERROR_INSUFFICIENT_BUFFER {
                    return Err(operation_error(SpoolerOperation::EnumJobs, code));
                }
                needed = u32::try_from(validate_buffer_growth(
                    allocation_size,
                    next_needed as usize,
                    SpoolerOperation::EnumJobs,
                )?)
                .map_err(|_| {
                    buffer_sizing_error(
                        SpoolerOperation::EnumJobs,
                        BufferSizingIssue::ArithmeticOverflow,
                        next_needed as usize,
                    )
                })?;
            }
            Err(operation_error(
                SpoolerOperation::EnumJobs,
                ERROR_INSUFFICIENT_BUFFER,
            ))
        }

        fn control_job(
            &self,
            printer_name: &str,
            job_id: WindowsJobId,
            control: SpoolJobControl,
        ) -> Result<(), SpoolerError> {
            let printer_name = OwnedUtf16::new(
                printer_name,
                SpoolerOperation::ControlJob,
                SpoolerInputField::PrinterName,
            )?;
            let handle = PrinterHandle::open(&printer_name, SpoolerOperation::ControlJob)?;
            // SAFETY: handle is live; level 0 requires null job data, and the
            // command is restricted by `SpoolJobControl` to one exact job.
            let result = unsafe {
                SetJobW(
                    handle.0,
                    job_id,
                    0,
                    ptr::null(),
                    native_control_code(control),
                )
            };
            if result == 0 {
                Err(last_operation_error(SpoolerOperation::ControlJob))
            } else {
                Ok(())
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct NativeFixture {
            storage: Vec<MaybeUninit<JOB_INFO_1W>>,
            copied_bytes: usize,
        }

        impl NativeFixture {
            fn blank(slots: usize, copied_bytes: usize) -> Self {
                Self {
                    storage: vec![MaybeUninit::zeroed(); slots],
                    copied_bytes,
                }
            }

            fn valid() -> Self {
                let struct_bytes = size_of::<JOB_INFO_1W>();
                let mut fixture = Self::blank(4, 0);
                let printer = fixture.write_wide(struct_bytes, "Κουζίνα");
                let document_offset = struct_bytes + ("Κουζίνα".encode_utf16().count() + 1) * 2;
                let document = fixture.write_wide(document_offset, "TheSmallPOS/marker");
                fixture.copied_bytes =
                    document_offset + ("TheSmallPOS/marker".encode_utf16().count() + 1) * 2;
                fixture.write_info(printer, document, ptr::null_mut());
                fixture
            }

            fn base(&self) -> *const u8 {
                self.storage.as_ptr().cast::<u8>()
            }

            fn allocation_size(&self) -> usize {
                self.storage.len() * size_of::<JOB_INFO_1W>()
            }

            fn write_wide(&mut self, offset: usize, value: &str) -> *mut u16 {
                let units: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
                let bytes = units.len() * size_of::<u16>();
                assert_eq!(offset % align_of::<u16>(), 0);
                assert!(offset + bytes <= self.allocation_size());
                // SAFETY: offset/length were checked against this live
                // allocation and source/destination do not overlap.
                unsafe {
                    ptr::copy_nonoverlapping(
                        units.as_ptr().cast::<u8>(),
                        self.storage.as_mut_ptr().cast::<u8>().add(offset),
                        bytes,
                    );
                    self.storage.as_mut_ptr().cast::<u8>().add(offset).cast()
                }
            }

            fn write_info(&mut self, printer: *mut u16, document: *mut u16, status: *mut u16) {
                // SAFETY: all-zero is a valid JOB_INFO_1W value because it is
                // composed solely of integer fields, pointers, and SYSTEMTIME
                // integer fields; required pointers are assigned below.
                let mut info: JOB_INFO_1W = unsafe { std::mem::zeroed() };
                info.JobId = 73;
                info.pPrinterName = printer;
                info.pDocument = document;
                info.pStatus = status;
                info.Status = 0x10;
                info.Position = 4;
                info.TotalPages = 2;
                info.PagesPrinted = 1;
                // SAFETY: the allocation is aligned for JOB_INFO_1W and has at
                // least one full slot; this initializes its leading structure.
                unsafe {
                    self.storage.as_mut_ptr().cast::<JOB_INFO_1W>().write(info);
                }
            }

            fn info_mut(&mut self) -> &mut JOB_INFO_1W {
                // SAFETY: write_info initialized the aligned leading slot in
                // every fixture before this accessor is used.
                unsafe { &mut *self.storage.as_mut_ptr().cast::<JOB_INFO_1W>() }
            }

            fn decode(&self, count: usize) -> Result<Vec<SpoolJobSnapshot>, SpoolerError> {
                // SAFETY: storage remains live and address-stable for the call;
                // decoder tests vary only the explicit trust boundaries.
                unsafe {
                    decode_level_one_response(
                        self.base(),
                        self.allocation_size(),
                        self.copied_bytes,
                        count,
                        SpoolerOperation::EnumJobs,
                    )
                }
            }
        }

        fn assert_malformed(
            result: Result<Vec<SpoolJobSnapshot>, SpoolerError>,
            reason: MalformedResponseKind,
        ) {
            assert_eq!(
                result,
                Err(SpoolerError::MalformedResponse {
                    operation: SpoolerOperation::EnumJobs,
                    reason,
                })
            );
        }

        #[test]
        fn decoder_rejects_short_struct_region_and_count_inconsistency() {
            let fixture = NativeFixture::blank(2, size_of::<JOB_INFO_1W>() - 1);
            assert_malformed(fixture.decode(1), MalformedResponseKind::ShortStructRegion);

            let fixture = NativeFixture::blank(2, size_of::<JOB_INFO_1W>());
            assert_malformed(fixture.decode(2), MalformedResponseKind::CountInconsistent);
        }

        #[test]
        fn checked_struct_region_rejects_count_overflow() {
            assert_eq!(
                checked_struct_bytes(usize::MAX, SpoolerOperation::EnumJobs),
                Err(SpoolerError::MalformedResponse {
                    operation: SpoolerOperation::EnumJobs,
                    reason: MalformedResponseKind::CountOverflow,
                })
            );
        }

        #[test]
        fn decoder_rejects_out_of_range_and_uncopied_tail_pointers() {
            let mut outside = NativeFixture::valid();
            // A one-past-allocation pointer is legal to construct but never to
            // dereference; the decoder must reject it first.
            outside.info_mut().pPrinterName = unsafe {
                outside
                    .base()
                    .add(outside.allocation_size())
                    .cast_mut()
                    .cast()
            };
            assert_malformed(
                outside.decode(1),
                MalformedResponseKind::PointerOutOfRange {
                    field: NativeJobField::PrinterName,
                },
            );

            let mut tail = NativeFixture::valid();
            tail.info_mut().pPrinterName =
                unsafe { tail.base().add(tail.copied_bytes + 2).cast_mut().cast() };
            assert_malformed(
                tail.decode(1),
                MalformedResponseKind::PointerOutsideCopiedRegion {
                    field: NativeJobField::PrinterName,
                },
            );
        }

        #[test]
        fn decoder_rejects_misaligned_pointer_and_missing_terminator() {
            let mut misaligned = NativeFixture::valid();
            misaligned.info_mut().pPrinterName = unsafe {
                misaligned
                    .base()
                    .add(size_of::<JOB_INFO_1W>() + 1)
                    .cast_mut()
                    .cast()
            };
            assert_malformed(
                misaligned.decode(1),
                MalformedResponseKind::PointerMisaligned {
                    field: NativeJobField::PrinterName,
                },
            );

            let mut unterminated = NativeFixture::blank(3, size_of::<JOB_INFO_1W>() + 8);
            let printer = unterminated.write_wide(size_of::<JOB_INFO_1W>(), "abc");
            let document = printer;
            unterminated.write_info(printer, document, ptr::null_mut());
            // Overwrite the terminator so every initialized u16 after the
            // pointer is nonzero.
            unsafe { printer.add(3).write(0x41) };
            assert_malformed(
                unterminated.decode(1),
                MalformedResponseKind::MissingTerminator {
                    field: NativeJobField::PrinterName,
                },
            );
        }

        #[test]
        fn decoder_rejects_null_required_fields_but_accepts_optional_null_status() {
            let mut null_printer = NativeFixture::valid();
            null_printer.info_mut().pPrinterName = ptr::null_mut();
            assert_malformed(
                null_printer.decode(1),
                MalformedResponseKind::NullRequiredField {
                    field: NativeJobField::PrinterName,
                },
            );

            let mut null_document = NativeFixture::valid();
            null_document.info_mut().pDocument = ptr::null_mut();
            assert_malformed(
                null_document.decode(1),
                MalformedResponseKind::NullRequiredField {
                    field: NativeJobField::DocumentName,
                },
            );

            let valid = NativeFixture::valid().decode(1).unwrap();
            assert_eq!(valid[0].status_text, None);
        }

        #[test]
        fn decoder_copies_valid_strings_only_from_the_reported_region() {
            let fixture = NativeFixture::valid();
            assert!(fixture.copied_bytes < fixture.allocation_size());

            let snapshots = fixture.decode(1).unwrap();

            assert_eq!(snapshots.len(), 1);
            assert_eq!(snapshots[0].job_id, 73);
            assert_eq!(snapshots[0].printer_name, "Κουζίνα");
            assert_eq!(snapshots[0].document_name, "TheSmallPOS/marker");
            assert_eq!(snapshots[0].position, 4);
        }

        #[test]
        fn decoder_rejects_copied_bytes_beyond_allocation() {
            let mut fixture = NativeFixture::valid();
            fixture.copied_bytes = fixture.allocation_size() + 1;
            assert_malformed(
                fixture.decode(1),
                MalformedResponseKind::CopiedBytesExceedAllocation,
            );
        }

        #[test]
        fn buffer_size_validation_accepts_boundary_and_rejects_zero_or_over_limit() {
            assert_eq!(
                validated_buffer_allocation_size(
                    MAX_NATIVE_JOB_BUFFER_BYTES,
                    SpoolerOperation::GetJob,
                ),
                Ok(MAX_NATIVE_JOB_BUFFER_BYTES)
            );
            assert!(matches!(
                validated_buffer_allocation_size(0, SpoolerOperation::GetJob),
                Err(SpoolerError::BufferSizing {
                    reason: BufferSizingIssue::Zero,
                    ..
                })
            ));
            assert!(matches!(
                validated_buffer_allocation_size(
                    MAX_NATIVE_JOB_BUFFER_BYTES + 1,
                    SpoolerOperation::GetJob,
                ),
                Err(SpoolerError::BufferSizing {
                    reason: BufferSizingIssue::ExceedsLimit,
                    ..
                })
            ));
        }

        #[test]
        fn buffer_growth_must_be_nonzero_and_strictly_increase() {
            assert_eq!(
                validate_buffer_growth(4096, 8192, SpoolerOperation::EnumJobs),
                Ok(8192)
            );
            for reported in [0, 4095, 4096] {
                assert!(matches!(
                    validate_buffer_growth(4096, reported, SpoolerOperation::EnumJobs),
                    Err(SpoolerError::BufferSizing {
                        reason: BufferSizingIssue::NonGrowing,
                        ..
                    })
                ));
            }
        }

        #[derive(Clone, Debug, Eq, PartialEq)]
        enum SubmissionEvent {
            Open,
            StartDoc,
            Callback,
            StartPage,
            Write(usize),
            EndPage,
            EndDoc,
            Abort,
            Close,
        }

        struct FakeSubmissionApi {
            events: Arc<std::sync::Mutex<Vec<SubmissionEvent>>>,
            cancel_after_first_write: Option<Arc<AtomicBool>>,
            abort_error: Option<SpoolerError>,
        }

        impl FakeSubmissionApi {
            fn new() -> Self {
                Self {
                    events: Arc::new(std::sync::Mutex::new(Vec::new())),
                    cancel_after_first_write: None,
                    abort_error: None,
                }
            }

            fn record(&self, event: SubmissionEvent) {
                self.events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(event);
            }

            fn events(&self) -> Vec<SubmissionEvent> {
                self.events
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            }
        }

        impl RawSubmissionApi for FakeSubmissionApi {
            type Handle = usize;

            fn open(&self, _printer_name: &OwnedUtf16) -> Result<Self::Handle, SpoolerError> {
                self.record(SubmissionEvent::Open);
                Ok(1)
            }

            fn close(&self, _handle: Self::Handle) {
                self.record(SubmissionEvent::Close);
            }

            fn start_doc(
                &self,
                _handle: Self::Handle,
                _document_name: &OwnedUtf16,
                _datatype: &OwnedUtf16,
            ) -> Result<u32, SpoolerError> {
                self.record(SubmissionEvent::StartDoc);
                Ok(73)
            }

            fn start_page(&self, _handle: Self::Handle) -> Result<(), SpoolerError> {
                self.record(SubmissionEvent::StartPage);
                Ok(())
            }

            fn write(&self, _handle: Self::Handle, bytes: &[u8]) -> Result<u32, SpoolerError> {
                self.record(SubmissionEvent::Write(bytes.len()));
                if let Some(cancel) = &self.cancel_after_first_write {
                    cancel.store(true, Ordering::Release);
                }
                Ok(bytes.len() as u32)
            }

            fn end_page(&self, _handle: Self::Handle) -> Result<(), SpoolerError> {
                self.record(SubmissionEvent::EndPage);
                Ok(())
            }

            fn end_doc(&self, _handle: Self::Handle) -> Result<(), SpoolerError> {
                self.record(SubmissionEvent::EndDoc);
                Ok(())
            }

            fn abort(&self, _handle: Self::Handle) -> Result<(), SpoolerError> {
                self.record(SubmissionEvent::Abort);
                match &self.abort_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(()),
                }
            }
        }

        fn submission_request(byte_count: usize) -> WindowsRawRequest {
            WindowsRawRequest {
                printer_name: "Kitchen".to_owned(),
                document_name: "TheSmallPOS/marker".to_owned(),
                bytes: vec![0x1b; byte_count].into(),
            }
        }

        #[test]
        fn injected_submission_orders_callback_chunks_finalization_and_single_close() {
            let api = FakeSubmissionApi::new();
            let events = Arc::clone(&api.events);

            let submission = submit_raw_with_api(
                &api,
                submission_request(8193),
                &AtomicBool::new(false),
                &mut |_| {
                    events
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(SubmissionEvent::Callback);
                    Ok(())
                },
            )
            .unwrap();

            assert_eq!(submission.started.job_id, 73);
            assert_eq!(
                api.events(),
                vec![
                    SubmissionEvent::Open,
                    SubmissionEvent::StartDoc,
                    SubmissionEvent::Callback,
                    SubmissionEvent::StartPage,
                    SubmissionEvent::Write(4096),
                    SubmissionEvent::Write(4096),
                    SubmissionEvent::Write(1),
                    SubmissionEvent::EndPage,
                    SubmissionEvent::EndDoc,
                    SubmissionEvent::Close,
                ]
            );
        }

        #[test]
        fn injected_submission_wraps_callback_error_with_job_id_then_aborts_and_closes_once() {
            let api = FakeSubmissionApi::new();
            let expected = SpoolerError::NativeOperation {
                operation: SpoolerOperation::SubmitRaw,
                kind: NativeErrorKind::AccessDenied,
                code: 5,
            };

            let result = submit_raw_with_api(
                &api,
                submission_request(1),
                &AtomicBool::new(false),
                &mut |_| Err(expected.clone()),
            );

            match result {
                Err(SpoolerError::AfterStart {
                    started,
                    abort_succeeded,
                    cause,
                }) => {
                    assert_eq!(started.job_id, 73);
                    assert!(abort_succeeded);
                    assert_eq!(*cause, expected);
                }
                other => panic!("expected post-StartDoc evidence, got {other:?}"),
            }
            assert_eq!(
                api.events(),
                vec![
                    SubmissionEvent::Open,
                    SubmissionEvent::StartDoc,
                    SubmissionEvent::Abort,
                    SubmissionEvent::Close,
                ]
            );
        }

        #[test]
        fn callback_failure_carries_job_id_even_when_abort_cleanup_fails() {
            let mut api = FakeSubmissionApi::new();
            api.abort_error = Some(SpoolerError::Operation {
                operation: SpoolerOperation::SubmitRaw,
                code: Some(1722),
            });
            let callback_error = SpoolerError::Operation {
                operation: SpoolerOperation::SubmitRaw,
                code: Some(5),
            };

            let result = submit_raw_with_api(
                &api,
                submission_request(1),
                &AtomicBool::new(false),
                &mut |_| Err(callback_error.clone()),
            );

            assert!(matches!(
                result,
                Err(SpoolerError::AfterStart {
                    started: SpoolStarted { job_id: 73, .. },
                    abort_succeeded: false,
                    ..
                })
            ));
            assert_eq!(
                api.events(),
                vec![
                    SubmissionEvent::Open,
                    SubmissionEvent::StartDoc,
                    SubmissionEvent::Abort,
                    SubmissionEvent::Close,
                ]
            );
        }

        #[test]
        fn injected_submission_cancels_between_chunks_then_aborts_and_closes_once() {
            let cancel = Arc::new(AtomicBool::new(false));
            let mut api = FakeSubmissionApi::new();
            api.cancel_after_first_write = Some(Arc::clone(&cancel));

            let result =
                submit_raw_with_api(&api, submission_request(8192), &cancel, &mut |_| Ok(()));

            match result {
                Err(SpoolerError::AfterStart {
                    started,
                    abort_succeeded,
                    cause,
                }) => {
                    assert_eq!(started.job_id, 73);
                    assert!(abort_succeeded);
                    assert_eq!(*cause, SpoolerError::Cancelled);
                }
                other => panic!("expected post-JobId cancellation evidence, got {other:?}"),
            }
            assert_eq!(
                api.events(),
                vec![
                    SubmissionEvent::Open,
                    SubmissionEvent::StartDoc,
                    SubmissionEvent::StartPage,
                    SubmissionEvent::Write(4096),
                    SubmissionEvent::Abort,
                    SubmissionEvent::Close,
                ]
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
impl WindowsSpooler for SystemWindowsSpooler {
    fn submit_raw(
        &self,
        _request: WindowsRawRequest,
        cancel: &AtomicBool,
        _on_started: &mut dyn FnMut(&SpoolStarted) -> Result<(), SpoolerError>,
    ) -> Result<SpoolSubmission, SpoolerError> {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(SpoolerError::Cancelled);
        }
        Err(SpoolerError::Operation {
            operation: SpoolerOperation::SubmitRaw,
            code: None,
        })
    }

    fn get_job(
        &self,
        _printer_name: &str,
        _job_id: WindowsJobId,
    ) -> Result<Option<SpoolJobSnapshot>, SpoolerError> {
        Err(SpoolerError::Operation {
            operation: SpoolerOperation::GetJob,
            code: None,
        })
    }

    fn enum_jobs(&self, _printer_name: &str) -> Result<Vec<SpoolJobSnapshot>, SpoolerError> {
        Err(SpoolerError::Operation {
            operation: SpoolerOperation::EnumJobs,
            code: None,
        })
    }

    fn control_job(
        &self,
        _printer_name: &str,
        _job_id: WindowsJobId,
        _control: SpoolJobControl,
    ) -> Result<(), SpoolerError> {
        Err(SpoolerError::Operation {
            operation: SpoolerOperation::ControlJob,
            code: None,
        })
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum OwnershipError {
    #[error("spool queue did not match the expected queue")]
    QueueMismatch { expected: String, actual: String },
    #[error("spool job ID did not match the expected job ID")]
    JobIdMismatch {
        expected: WindowsJobId,
        actual: WindowsJobId,
    },
    #[error("spool document name did not exactly match the expected document name")]
    DocumentNameMismatch { expected: String, actual: String },
    #[error("spool document marker is invalid: {source}")]
    InvalidMarker { source: MarkerParseError },
}

/// Compares queue names using ASCII case-insensitivity only. No whitespace
/// trimming or printer aliases are accepted as equivalent.
pub fn windows_queue_names_match(expected: &str, actual: &str) -> bool {
    expected.eq_ignore_ascii_case(actual)
}

/// Validates only the spool identity layer. A caller must additionally verify
/// its active SQLite attempt immediately before any future control operation.
pub fn validate_owned_job(
    expected_queue: &str,
    expected_job_id: WindowsJobId,
    expected_document_name: &str,
    snapshot: &SpoolJobSnapshot,
) -> Result<PosDocumentMarker, OwnershipError> {
    if !windows_queue_names_match(expected_queue, &snapshot.printer_name) {
        return Err(OwnershipError::QueueMismatch {
            expected: expected_queue.to_owned(),
            actual: snapshot.printer_name.clone(),
        });
    }
    if expected_job_id != snapshot.job_id {
        return Err(OwnershipError::JobIdMismatch {
            expected: expected_job_id,
            actual: snapshot.job_id,
        });
    }
    if expected_document_name != snapshot.document_name {
        return Err(OwnershipError::DocumentNameMismatch {
            expected: expected_document_name.to_owned(),
            actual: snapshot.document_name.clone(),
        });
    }

    let expected_marker = parse_document_marker(expected_document_name)
        .map_err(|source| OwnershipError::InvalidMarker { source })?;
    let current_marker = parse_document_marker(&snapshot.document_name)
        .map_err(|source| OwnershipError::InvalidMarker { source })?;
    if expected_marker != current_marker {
        return Err(OwnershipError::InvalidMarker {
            source: MarkerParseError::DocumentKind,
        });
    }
    Ok(current_marker)
}

/// Only narrow historical test names are classified as legacy POS documents.
/// Subsequent UI/control code must still require a discovered queue and
/// explicit operator confirmation before acting on any legacy entry.
// UNWIRED (queue-scan capability). The "discovered queue" this classifies entries from
// can only come from `enum_jobs`, which has no caller yet, so nothing reaches this.
// See the note above `enum_jobs`.
#[allow(dead_code)]
pub fn is_exact_legacy_pos_document_name(value: &str) -> bool {
    matches!(
        value,
        "POS Draft Test" | "POS Encoding Test" | "POS Branding Test"
    )
}

#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FakeSpoolControl {
    pub printer_name: String,
    pub job_id: WindowsJobId,
    pub control: SpoolJobControl,
}

#[cfg(test)]
#[derive(Default)]
struct FakeBlockState {
    enabled: bool,
    blocked: bool,
    released: bool,
}

/// Deterministic portable fake for worker tests. Its optional submission block
/// has a one-second timeout so a failed test cannot wait forever.
#[cfg(test)]
pub struct FakeWindowsSpooler {
    job_id: WindowsJobId,
    snapshots:
        std::sync::Mutex<std::collections::BTreeMap<(String, WindowsJobId), SpoolJobSnapshot>>,
    submissions: std::sync::Mutex<Vec<WindowsRawRequest>>,
    controls: std::sync::Mutex<Vec<FakeSpoolControl>>,
    block: (std::sync::Mutex<FakeBlockState>, std::sync::Condvar),
    block_timeout: std::sync::Mutex<std::time::Duration>,
}

#[cfg(test)]
impl FakeWindowsSpooler {
    pub fn new(job_id: WindowsJobId) -> Self {
        Self {
            job_id,
            snapshots: std::sync::Mutex::new(std::collections::BTreeMap::new()),
            submissions: std::sync::Mutex::new(Vec::new()),
            controls: std::sync::Mutex::new(Vec::new()),
            block: (
                std::sync::Mutex::new(FakeBlockState::default()),
                std::sync::Condvar::new(),
            ),
            block_timeout: std::sync::Mutex::new(std::time::Duration::from_secs(1)),
        }
    }

    pub fn seed_snapshot(&self, snapshot: SpoolJobSnapshot) {
        self.snapshots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((snapshot.printer_name.clone(), snapshot.job_id), snapshot);
    }

    pub fn submissions(&self) -> Vec<WindowsRawRequest> {
        self.submissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn controls(&self) -> Vec<FakeSpoolControl> {
        self.controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn set_block_after_started(&self, enabled: bool) {
        let mut state = self
            .block
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.enabled = enabled;
        state.blocked = false;
        state.released = false;
    }

    pub fn set_block_timeout(&self, timeout: std::time::Duration) {
        *self
            .block_timeout
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = timeout;
    }

    pub fn is_submission_blocked(&self) -> bool {
        self.block
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .blocked
    }

    pub fn wait_until_submission_blocked(&self, timeout: std::time::Duration) -> bool {
        let state = self
            .block
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, _) = self
            .block
            .1
            .wait_timeout_while(state, timeout, |state| !state.blocked)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.blocked
    }

    pub fn release_submission_block(&self) {
        let mut state = self
            .block
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.released = true;
        self.block.1.notify_all();
    }

    fn block_after_started(&self, cancel: &AtomicBool) -> Result<(), SpoolerError> {
        let mut state = self
            .block
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.enabled {
            return Ok(());
        }

        state.blocked = true;
        self.block.1.notify_all();
        let block_timeout = *self
            .block_timeout
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (mut state_after_wait, timeout) = self
            .block
            .1
            .wait_timeout_while(state, block_timeout, |state| !state.released)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if timeout.timed_out() && !state_after_wait.released {
            state_after_wait.blocked = false;
            return Err(SpoolerError::TimedOut {
                operation: SpoolerOperation::SubmitRaw,
            });
        }
        state_after_wait.blocked = false;
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(SpoolerError::Cancelled);
        }
        Ok(())
    }
}

#[cfg(test)]
impl WindowsSpooler for FakeWindowsSpooler {
    fn submit_raw(
        &self,
        request: WindowsRawRequest,
        cancel: &AtomicBool,
        on_started: &mut dyn FnMut(&SpoolStarted) -> Result<(), SpoolerError>,
    ) -> Result<SpoolSubmission, SpoolerError> {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(SpoolerError::Cancelled);
        }

        let started = SpoolStarted {
            job_id: self.job_id,
            printer_name: request.printer_name.clone(),
            document_name: request.document_name.clone(),
            submitted_at: Utc::now(),
        };
        if let Err(cause) = on_started(&started) {
            return Err(SpoolerError::AfterStart {
                started,
                // The portable fake cannot prove native deletion. Production
                // likewise treats AbortPrinter success as cleanup context only.
                abort_succeeded: false,
                cause: Box::new(cause),
            });
        }
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(SpoolerError::AfterStart {
                started,
                abort_succeeded: false,
                cause: Box::new(SpoolerError::Cancelled),
            });
        }
        if let Err(cause) = self.block_after_started(cancel) {
            return Err(SpoolerError::AfterStart {
                started,
                abort_succeeded: false,
                cause: Box::new(cause),
            });
        }
        self.submissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(request);
        Ok(SpoolSubmission { started })
    }

    fn get_job(
        &self,
        printer_name: &str,
        job_id: WindowsJobId,
    ) -> Result<Option<SpoolJobSnapshot>, SpoolerError> {
        Ok(self
            .snapshots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&(printer_name.to_owned(), job_id))
            .cloned())
    }

    fn enum_jobs(&self, printer_name: &str) -> Result<Vec<SpoolJobSnapshot>, SpoolerError> {
        Ok(self
            .snapshots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|((name, _), _)| name == printer_name)
            .map(|(_, snapshot)| snapshot.clone())
            .collect())
    }

    fn control_job(
        &self,
        printer_name: &str,
        job_id: WindowsJobId,
        control: SpoolJobControl,
    ) -> Result<(), SpoolerError> {
        self.controls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(FakeSpoolControl {
                printer_name: printer_name.to_owned(),
                job_id,
                control,
            });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        thread,
        time::Duration,
    };
    use uuid::Uuid;

    #[test]
    fn formats_and_parses_a_canonical_pos_document_marker() {
        let local_job_id = Uuid::parse_str("d2719c48-6699-4b99-8549-d02f1a262f48").unwrap();
        let attempt_id = Uuid::parse_str("ab5a4082-0a73-4fc4-969a-08f3cd7c13b7").unwrap();

        let marker = format_document_marker(local_job_id, attempt_id, "receipt").unwrap();
        let parsed = parse_document_marker(&marker).unwrap();

        assert_eq!(
            marker,
            "TheSmallPOS/d2719c48-6699-4b99-8549-d02f1a262f48/ab5a4082-0a73-4fc4-969a-08f3cd7c13b7/receipt"
        );
        assert_eq!(parsed.local_job_id.to_string(), local_job_id.to_string());
        assert_eq!(parsed.attempt_id.to_string(), attempt_id.to_string());
        assert_eq!(parsed.document_kind, "receipt");
    }

    #[test]
    fn rejects_malformed_marker_ids_prefix_segments_and_kinds() {
        let valid_job = "d2719c48-6699-4b99-8549-d02f1a262f48";
        let valid_attempt = "ab5a4082-0a73-4fc4-969a-08f3cd7c13b7";

        assert_eq!(
            parse_document_marker(&format!("TheSmallPOS/not-a-uuid/{valid_attempt}/receipt")),
            Err(MarkerParseError::LocalJobId)
        );
        assert_eq!(
            parse_document_marker(&format!("TheSmallPOS/{valid_job}/not-a-uuid/receipt")),
            Err(MarkerParseError::AttemptId)
        );
        assert_eq!(
            parse_document_marker(&format!("thesmallpos/{valid_job}/{valid_attempt}/receipt")),
            Err(MarkerParseError::Prefix)
        );
        assert_eq!(
            parse_document_marker(&format!("TheSmallPOS/{valid_job}/{valid_attempt}")),
            Err(MarkerParseError::SegmentCount)
        );

        for unsafe_kind in [
            "",
            "receipt/extra",
            "..",
            " receipt",
            "receipt ",
            "receipt\n",
        ] {
            assert_eq!(
                parse_document_marker(&format!(
                    "TheSmallPOS/{valid_job}/{valid_attempt}/{unsafe_kind}"
                )),
                Err(if unsafe_kind == "receipt/extra" {
                    MarkerParseError::SegmentCount
                } else {
                    MarkerParseError::DocumentKind
                })
            );
        }
    }

    #[test]
    fn rejects_noncanonical_uuid_spellings_in_both_marker_positions_and_ownership_validation() {
        let canonical_job = "d2719c48-6699-4b99-8549-d02f1a262f48";
        let canonical_attempt = "ab5a4082-0a73-4fc4-969a-08f3cd7c13b7";
        let noncanonical_jobs = [
            "d2719c4866994b998549d02f1a262f48",
            "D2719C48-6699-4B99-8549-D02F1A262F48",
            "{d2719c48-6699-4b99-8549-d02f1a262f48}",
            "urn:uuid:d2719c48-6699-4b99-8549-d02f1a262f48",
        ];
        let noncanonical_attempts = [
            "ab5a40820a734fc4969a08f3cd7c13b7",
            "AB5A4082-0A73-4FC4-969A-08F3CD7C13B7",
            "{ab5a4082-0a73-4fc4-969a-08f3cd7c13b7}",
            "urn:uuid:ab5a4082-0a73-4fc4-969a-08f3cd7c13b7",
        ];

        for job in noncanonical_jobs {
            let document_name = format!("TheSmallPOS/{job}/{canonical_attempt}/receipt");
            assert_eq!(
                parse_document_marker(&document_name),
                Err(MarkerParseError::LocalJobId)
            );
            assert!(matches!(
                validate_owned_job(
                    "Kitchen Printer",
                    42,
                    &document_name,
                    &snapshot("Kitchen Printer", 42, document_name.clone()),
                ),
                Err(OwnershipError::InvalidMarker {
                    source: MarkerParseError::LocalJobId
                })
            ));
        }

        for attempt in noncanonical_attempts {
            let document_name = format!("TheSmallPOS/{canonical_job}/{attempt}/receipt");
            assert_eq!(
                parse_document_marker(&document_name),
                Err(MarkerParseError::AttemptId)
            );
            assert!(matches!(
                validate_owned_job(
                    "Kitchen Printer",
                    42,
                    &document_name,
                    &snapshot("Kitchen Printer", 42, document_name.clone()),
                ),
                Err(OwnershipError::InvalidMarker {
                    source: MarkerParseError::AttemptId
                })
            ));
        }
    }

    fn marker() -> String {
        format_document_marker(
            Uuid::parse_str("d2719c48-6699-4b99-8549-d02f1a262f48").unwrap(),
            Uuid::parse_str("ab5a4082-0a73-4fc4-969a-08f3cd7c13b7").unwrap(),
            "receipt",
        )
        .unwrap()
    }

    fn snapshot(
        printer_name: &str,
        job_id: WindowsJobId,
        document_name: String,
    ) -> SpoolJobSnapshot {
        SpoolJobSnapshot {
            job_id,
            printer_name: printer_name.to_owned(),
            document_name,
            status_text: None,
            status_bits: 0,
            position: 1,
            total_pages: 1,
            pages_printed: 0,
        }
    }

    #[test]
    fn validates_only_the_exact_owned_job_identity() {
        let document_name = marker();
        let owned = validate_owned_job(
            "Kitchen Printer",
            42,
            &document_name,
            &snapshot("kitchen printer", 42, document_name.clone()),
        )
        .unwrap();

        assert_eq!(owned.document_kind, "receipt");
    }

    #[test]
    fn rejects_queue_job_id_document_and_marker_mismatches() {
        let document_name = marker();
        assert!(matches!(
            validate_owned_job(
                "Kitchen Printer",
                42,
                &document_name,
                &snapshot("Bar Printer", 42, document_name.clone()),
            ),
            Err(OwnershipError::QueueMismatch { .. })
        ));
        assert!(matches!(
            validate_owned_job(
                "Kitchen Printer",
                42,
                &document_name,
                &snapshot("Kitchen Printer", 43, document_name.clone()),
            ),
            Err(OwnershipError::JobIdMismatch { .. })
        ));
        assert!(matches!(
            validate_owned_job(
                "Kitchen Printer",
                42,
                &document_name,
                &snapshot("Kitchen Printer", 42, format!("{document_name}-other")),
            ),
            Err(OwnershipError::DocumentNameMismatch { .. })
        ));
        let malformed = "TheSmallPOS/not-a-uuid/ab5a4082-0a73-4fc4-969a-08f3cd7c13b7/receipt";
        assert!(matches!(
            validate_owned_job(
                "Kitchen Printer",
                42,
                malformed,
                &snapshot("Kitchen Printer", 42, malformed.to_owned()),
            ),
            Err(OwnershipError::InvalidMarker { .. })
        ));
    }

    #[test]
    fn queue_matching_is_case_insensitive_but_document_matching_is_exact() {
        let document_name = marker();
        assert!(validate_owned_job(
            "Kitchen Printer",
            42,
            &document_name,
            &snapshot("KITCHEN PRINTER", 42, document_name.clone()),
        )
        .is_ok());
        assert!(matches!(
            validate_owned_job(
                "Kitchen Printer",
                42,
                &document_name,
                &snapshot("Kitchen Printer", 42, document_name.to_ascii_uppercase()),
            ),
            Err(OwnershipError::DocumentNameMismatch { .. })
        ));
    }

    #[test]
    fn classifies_only_the_three_exact_legacy_document_names() {
        for name in ["POS Draft Test", "POS Encoding Test", "POS Branding Test"] {
            assert!(is_exact_legacy_pos_document_name(name));
        }
        for name in [
            "POS Receipt",
            "pos Draft Test",
            "POS Draft Test ",
            " POS Draft Test",
            "Other App",
        ] {
            assert!(!is_exact_legacy_pos_document_name(name));
        }
    }

    fn request() -> WindowsRawRequest {
        WindowsRawRequest {
            printer_name: "Kitchen Printer".to_owned(),
            document_name: marker(),
            bytes: Arc::from([0x1b, 0x40]),
        }
    }

    #[test]
    fn fake_exposes_seeded_snapshots_and_records_only_requested_control() {
        let fake = FakeWindowsSpooler::new(42);
        let seeded = snapshot("Kitchen Printer", 42, marker());
        fake.seed_snapshot(seeded.clone());

        assert_eq!(
            fake.get_job("Kitchen Printer", 42).unwrap(),
            Some(seeded.clone())
        );
        assert_eq!(fake.enum_jobs("Kitchen Printer").unwrap(), vec![seeded]);
        fake.control_job("Kitchen Printer", 42, SpoolJobControl::Pause)
            .unwrap();

        assert_eq!(
            fake.controls(),
            vec![FakeSpoolControl {
                printer_name: "Kitchen Printer".to_owned(),
                job_id: 42,
                control: SpoolJobControl::Pause,
            }]
        );
    }

    #[test]
    fn fake_calls_started_callback_before_a_configured_block_and_releases() {
        let fake = Arc::new(FakeWindowsSpooler::new(42));
        fake.set_block_after_started(true);
        let (started_sender, started_receiver) = mpsc::channel();
        let fake_for_thread = Arc::clone(&fake);

        let submission = thread::spawn(move || {
            let cancel = AtomicBool::new(false);
            fake_for_thread.submit_raw(request(), &cancel, &mut |started| {
                started_sender.send(started.job_id).unwrap();
                Ok(())
            })
        });

        assert_eq!(
            started_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap(),
            42
        );
        assert!(fake.wait_until_submission_blocked(Duration::from_secs(1)));
        fake.release_submission_block();
        assert_eq!(submission.join().unwrap().unwrap().started.job_id, 42);
    }

    #[test]
    fn fake_honors_pre_cancelled_submission_without_claiming_success() {
        let fake = FakeWindowsSpooler::new(42);
        let cancel = AtomicBool::new(true);
        let callback_called = AtomicBool::new(false);

        let result = fake.submit_raw(request(), &cancel, &mut |_| {
            callback_called.store(true, Ordering::SeqCst);
            Ok(())
        });

        assert_eq!(result, Err(SpoolerError::Cancelled));
        assert!(!callback_called.load(Ordering::SeqCst));
        assert!(fake.submissions().is_empty());
    }

    #[test]
    fn fake_preserves_post_start_identity_for_callback_errors_without_recording_payload() {
        let fake = FakeWindowsSpooler::new(42);
        fake.set_block_after_started(true);
        let expected = SpoolerError::Operation {
            operation: SpoolerOperation::SubmitRaw,
            code: Some(5),
        };

        let result = fake.submit_raw(request(), &AtomicBool::new(false), &mut |_| {
            Err(expected.clone())
        });

        match result {
            Err(SpoolerError::AfterStart {
                started,
                abort_succeeded,
                cause,
            }) => {
                assert_eq!(started.job_id, 42);
                assert!(!abort_succeeded);
                assert_eq!(*cause, expected);
            }
            other => panic!("expected post-StartDoc evidence, got {other:?}"),
        }
        assert!(!fake.is_submission_blocked());
        assert!(fake.submissions().is_empty());
    }

    #[test]
    fn fake_block_times_out_without_release() {
        let fake = FakeWindowsSpooler::new(42);
        fake.set_block_after_started(true);
        fake.set_block_timeout(Duration::from_millis(100));

        let result = fake.submit_raw(request(), &AtomicBool::new(false), &mut |_| Ok(()));

        match result {
            Err(SpoolerError::AfterStart {
                started,
                abort_succeeded,
                cause,
            }) => {
                assert_eq!(started.job_id, 42);
                assert!(!abort_succeeded);
                assert_eq!(
                    *cause,
                    SpoolerError::TimedOut {
                        operation: SpoolerOperation::SubmitRaw,
                    }
                );
            }
            other => panic!("expected post-JobId timeout evidence, got {other:?}"),
        }
        assert!(!fake.is_submission_blocked());
        assert!(fake.submissions().is_empty());
    }

    #[test]
    fn fake_honors_cancellation_that_arrives_while_blocked() {
        let fake = Arc::new(FakeWindowsSpooler::new(42));
        fake.set_block_after_started(true);
        let cancel = Arc::new(AtomicBool::new(false));
        let fake_for_thread = Arc::clone(&fake);
        let cancel_for_thread = Arc::clone(&cancel);
        let submission = thread::spawn(move || {
            fake_for_thread.submit_raw(request(), &cancel_for_thread, &mut |_| Ok(()))
        });

        assert!(fake.wait_until_submission_blocked(Duration::from_secs(1)));
        cancel.store(true, Ordering::SeqCst);
        fake.release_submission_block();

        match submission.join().unwrap() {
            Err(SpoolerError::AfterStart {
                started,
                abort_succeeded,
                cause,
            }) => {
                assert_eq!(started.job_id, 42);
                assert!(!abort_succeeded);
                assert_eq!(*cause, SpoolerError::Cancelled);
            }
            other => panic!("expected post-JobId cancellation evidence, got {other:?}"),
        }
        assert!(fake.submissions().is_empty());
    }

    #[test]
    fn windows_spooler_trait_is_object_safe_and_send_sync() {
        let spooler: Arc<dyn WindowsSpooler> = Arc::new(FakeWindowsSpooler::new(42));
        assert!(spooler.enum_jobs("Kitchen Printer").unwrap().is_empty());
    }

    #[test]
    fn native_status_uses_the_required_precedence_for_single_and_combined_bits() {
        let ordered = [
            (0x0000_0002, NativeJobStatus::Error),
            (0x0000_0020, NativeJobStatus::Offline),
            (0x0000_0040, NativeJobStatus::PaperOut),
            (0x0000_0200, NativeJobStatus::BlockedDeviceQueue),
            (0x0000_0400, NativeJobStatus::UserIntervention),
            (0x0000_0001, NativeJobStatus::Paused),
            (0x0000_0004, NativeJobStatus::Deleting),
            (0x0000_0010, NativeJobStatus::Printing),
            (0x0000_0008, NativeJobStatus::Spooling),
            (0x0000_0100, NativeJobStatus::Deleted),
            (0x0000_0080, NativeJobStatus::Printed),
            (0x0000_1000, NativeJobStatus::Complete),
        ];

        for (index, (bit, expected)) in ordered.iter().copied().enumerate() {
            assert_eq!(map_native_job_status(bit), expected);
            let all_lower_precedence_bits = ordered[index..]
                .iter()
                .fold(0, |combined, (candidate, _)| combined | candidate);
            assert_eq!(map_native_job_status(all_lower_precedence_bits), expected);
        }
        assert_eq!(map_native_job_status(0), NativeJobStatus::Unknown);
        assert_eq!(map_native_job_status(0x8000_0000), NativeJobStatus::Unknown);
        assert!(native_job_is_paused(0x0000_0021));
        assert!(!native_job_is_paused(0x0000_0020));
    }

    #[test]
    fn native_error_mapping_classifies_known_codes_and_preserves_unknown_codes() {
        assert_eq!(map_native_error_code(5), NativeErrorKind::AccessDenied);
        assert_eq!(map_native_error_code(87), NativeErrorKind::InvalidJob);
        assert_eq!(map_native_error_code(122), NativeErrorKind::BufferSizing);
        assert_eq!(map_native_error_code(1722), NativeErrorKind::Other(1722));
    }

    #[test]
    fn control_mapping_exposes_only_individual_pause_resume_and_delete_codes() {
        assert_eq!(native_control_code(SpoolJobControl::Pause), 1);
        assert_eq!(native_control_code(SpoolJobControl::Resume), 2);
        assert_eq!(native_control_code(SpoolJobControl::Delete), 5);
    }

    #[test]
    fn owned_utf16_rejects_embedded_nul_and_round_trips_unicode() {
        let invalid = OwnedUtf16::new(
            "Kitchen\0Printer",
            SpoolerOperation::SubmitRaw,
            SpoolerInputField::PrinterName,
        )
        .unwrap_err();
        assert_eq!(
            invalid,
            SpoolerError::InvalidInput {
                operation: SpoolerOperation::SubmitRaw,
                field: SpoolerInputField::PrinterName,
            }
        );
        assert!(!invalid.to_string().contains("Kitchen"));

        for value in ["Κουζίνα 🧾", "TheSmallPOS/δοκιμή/receipt"] {
            let owned = OwnedUtf16::new(
                value,
                SpoolerOperation::SubmitRaw,
                SpoolerInputField::DocumentName,
            )
            .unwrap();
            assert_eq!(owned.as_slice().last(), Some(&0));
            assert_eq!(
                String::from_utf16(&owned.as_slice()[..owned.as_slice().len() - 1]).unwrap(),
                value
            );
        }
    }

    #[test]
    fn write_count_validation_preserves_partial_write_context() {
        let error = validate_write_count(4096, 1024).unwrap_err();

        assert_eq!(
            error,
            SpoolerError::PartialWrite {
                operation: SpoolerOperation::SubmitRaw,
                primitive: SpoolerPrimitive::WritePrinter,
                expected: 4096,
                written: 1024,
            }
        );
        assert_eq!(
            error.to_string(),
            "spooler SubmitRaw WritePrinter wrote 1024 of 4096 bytes"
        );
        assert_eq!(validate_write_count(4096, 4096), Ok(()));
    }

    #[test]
    fn level_one_snapshot_conversion_copies_strings_and_handles_null_status() {
        let snapshot = {
            let printer_name: Vec<u16> = "Κουζίνα".encode_utf16().collect();
            let document_name: Vec<u16> = "TheSmallPOS/marker".encode_utf16().collect();
            snapshot_from_level_one(LevelOneJobFields {
                job_id: 73,
                printer_name: Some(&printer_name),
                document_name: Some(&document_name),
                status_text: None,
                status_bits: 0x0000_0010,
                position: 4,
                total_pages: 2,
                pages_printed: 1,
            })
        };

        assert_eq!(snapshot.job_id, 73);
        assert_eq!(snapshot.printer_name, "Κουζίνα");
        assert_eq!(snapshot.document_name, "TheSmallPOS/marker");
        assert_eq!(snapshot.status_text, None);
        assert_eq!(snapshot.status_bits, 0x0000_0010);
        assert_eq!(snapshot.position, 4);
        assert_eq!(snapshot.total_pages, 2);
        assert_eq!(snapshot.pages_printed, 1);
    }
}
