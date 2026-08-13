//! Invoice capture subsystem (desktop track).
//!
//! Spec: `.claude/specs/invoice-scan-capture/` — design surface **D-Rust1**.
//! Requirements R8.6, R11.1, R13.4, R17.2, R17.3, R17.5.
//!
//! A scanned supplier invoice enters the POS here and stays here until the
//! server confirms a committed invoice carrying its attachment. The subsystem
//! is built around one promise — **never lose a captured document**:
//!
//! - [`files`] writes page bytes into app-protected storage *before* any
//!   network activity, on a blocking pool so accepting page N never blocks
//!   capturing page N+1 (R11.1, R17.2, R17.5).
//! - [`store`] records those pages and their document in `pos.db` (migration
//!   v72), including the review edits that must survive a restart (R8.6,
//!   R17.3) and the local history the queue view shows (R13.4).
//! - [`watcher`] turns "press Scan on the MFP" into one of those documents,
//!   copying bytes out of a user-chosen folder without ever writing back into
//!   it (R3.2–R3.8, R17.5).
//!
//! The lifecycle vocabulary below is the Rust half of a three-way parity
//! contract: [`CaptureStatus`] here, the `status` CHECK on `capture_documents`
//! (db.rs migration v72), and `CaptureStatus` in
//! `shared/types/supplier-capture.ts` — plus the mobile client's identical
//! `invoice_captures.status`. All four must enumerate the same ten states.

// The store lands ahead of its consumers: the WIA adapter, the watched-folder
// watcher, the capture worker, and the capture UI commands are the following
// tasks in the same plan. Same precedent as `core_helpers.rs`'s
// `validate_terminal_id_path_safe`. Remove once those callers exist.
#![allow(dead_code)]

pub mod files;
pub mod store;
pub mod watcher;
pub mod wia;
pub mod worker;

/// Page cap for one captured document — one capture is exactly one invoice.
///
/// Mirrors `MAX_CAPTURE_PAGES` on the server's attachments route, which
/// re-enforces the same cap. Enforced client-side first so the user is told
/// at capture time rather than after an upload round trip (R12.3).
pub const MAX_CAPTURE_PAGES: usize = 10;

/// Per-page byte ceiling, mirroring the server's `MAX_CAPTURE_UPLOAD_BYTES`
/// (and `MAX_OCR_UPLOAD_BYTES` behind it). A page this terminal accepts must
/// be a page the server will later agree to store and read (R12.2).
pub const MAX_CAPTURE_PAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Where a captured document came from.
///
/// Mirrors `CaptureSourceKind` in `shared/types/supplier-capture.ts` and the
/// zod enum accepted by `POST /api/pos/suppliers/import/commit`. The desktop
/// client only produces the first three; `camera` and `usb_scanner` are mobile
/// kinds, kept in the enum so a shared row shape round-trips unchanged.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureSourceKind {
    ConnectedScanner,
    WatchedFolder,
    Camera,
    UsbScanner,
    FilePick,
}

impl CaptureSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ConnectedScanner => "connected_scanner",
            Self::WatchedFolder => "watched_folder",
            Self::Camera => "camera",
            Self::UsbScanner => "usb_scanner",
            Self::FilePick => "file_pick",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "connected_scanner" => Some(Self::ConnectedScanner),
            "watched_folder" => Some(Self::WatchedFolder),
            "camera" => Some(Self::Camera),
            "usb_scanner" => Some(Self::UsbScanner),
            "file_pick" => Some(Self::FilePick),
            _ => None,
        }
    }
}

/// The capture lifecycle.
///
/// Every state except [`Committed`](Self::Committed) and
/// [`Discarded`](Self::Discarded) retains the document *and its edits* — a
/// failure moves a document sideways, never off the queue (R11.6).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureStatus {
    /// Pages accumulating on the terminal; the user has not finished yet.
    Capturing,
    /// Durable and queued for recognition — offline, or simply not its turn.
    Waiting,
    /// Pages uploading to the staging route.
    Uploading,
    /// Recognition in flight server-side.
    Reading,
    /// Recognition done (good or poor); awaiting review and commit.
    ReadyReview,
    /// Recognition or commit failed with a stated reason; document retained.
    NeedsAttention,
    /// The suppliers module is inactive for this organization; auto-resumes.
    Parked,
    /// Commit in flight, or queued as an offline mutation.
    Committing,
    /// Saved server-side. Terminal state.
    Committed,
    /// Explicitly discarded by the user. Terminal state.
    Discarded,
}

impl CaptureStatus {
    /// Every variant, in lifecycle order. Pinned against the schema CHECK and
    /// the shared TypeScript union by test.
    pub const ALL: [CaptureStatus; 10] = [
        Self::Capturing,
        Self::Waiting,
        Self::Uploading,
        Self::Reading,
        Self::ReadyReview,
        Self::NeedsAttention,
        Self::Parked,
        Self::Committing,
        Self::Committed,
        Self::Discarded,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Capturing => "capturing",
            Self::Waiting => "waiting",
            Self::Uploading => "uploading",
            Self::Reading => "reading",
            Self::ReadyReview => "ready_review",
            Self::NeedsAttention => "needs_attention",
            Self::Parked => "parked",
            Self::Committing => "committing",
            Self::Committed => "committed",
            Self::Discarded => "discarded",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
    }

    /// `true` once the document can never move again.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Committed | Self::Discarded)
    }

    /// `true` while the document still owes the user an action or the worker a
    /// turn — i.e. it belongs in the capture queue and its badge count (R11.5).
    pub fn is_open(self) -> bool {
        !self.is_terminal()
    }

    /// Whether `self -> next` is a move the design's state machine allows.
    ///
    /// This is the local half of "fail closed, never lose": a worker that
    /// computes a nonsensical next state is refused at the store boundary
    /// instead of stranding a document in a state no UI knows how to render.
    ///
    /// Re-asserting the same status is always allowed — workers and the
    /// renderer both re-write a status they already hold (a retry that lands
    /// on the same outcome, a status refresh), and that must stay an
    /// idempotent no-op rather than an error.
    pub fn can_transition_to(self, next: CaptureStatus) -> bool {
        use CaptureStatus::*;

        if self == next {
            return true;
        }

        match self {
            // Pages are still accumulating: finish the document, or throw the
            // draft away. Nothing is uploaded from here.
            Capturing => matches!(next, Waiting | Discarded),

            // Queued for the worker. It picks the document up (Uploading), or
            // the module gate / a typed failure diverts it first.
            Waiting => matches!(next, Uploading | Parked | NeedsAttention | Discarded),

            // Uploading pages. Transient failure or going offline drops back to
            // Waiting with no attempt burned (R11.2); a module gate parks it.
            Uploading => matches!(
                next,
                Reading | Waiting | Parked | NeedsAttention | Discarded
            ),

            // Recognition in flight. Same divert rules as Uploading, and the
            // success edge to review.
            Reading => matches!(
                next,
                ReadyReview | Waiting | Parked | NeedsAttention | Discarded
            ),

            // Recognition finished. The user saves (Committing), throws it away,
            // or re-queues it for another read ("scan again" / retry).
            ReadyReview => matches!(next, Committing | Waiting | Discarded),

            // A stated reason is on the document. Retry re-queues it; manual
            // entry carries it straight to review so the capture still lands on
            // the invoice as its attachment (R7.5).
            NeedsAttention => matches!(next, Waiting | ReadyReview | Discarded),

            // The module gate resumes automatically to whichever phase parked
            // it — recognition (Waiting) or the queued commit (Committing).
            Parked => matches!(next, Waiting | Committing | Discarded),

            // Commit in flight or queued. Rejection is a stated reason with the
            // edits retained; a queued replay hitting the module gate parks.
            Committing => matches!(next, Committed | NeedsAttention | Parked),

            // Terminal.
            Committed | Discarded => false,
        }
    }
}

/// What the watched-folder ingest decided about a file it saw.
///
/// Recorded once per content hash so an unsupported or duplicate file produces
/// a single history entry rather than a repeating error (R3.4, R3.5).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureIngestOutcome {
    Ingested,
    SkippedDuplicate,
    SkippedUnsupported,
    SkippedOversize,
}

impl CaptureIngestOutcome {
    pub const ALL: [CaptureIngestOutcome; 4] = [
        Self::Ingested,
        Self::SkippedDuplicate,
        Self::SkippedUnsupported,
        Self::SkippedOversize,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ingested => "ingested",
            Self::SkippedDuplicate => "skipped_duplicate",
            Self::SkippedUnsupported => "skipped_unsupported",
            Self::SkippedOversize => "skipped_oversize",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|outcome| outcome.as_str() == value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use CaptureStatus::*;

    #[test]
    fn status_vocabulary_matches_the_shared_type_and_schema_check() {
        // The exact ten strings the `capture_documents.status` CHECK accepts
        // and the shared `CaptureStatus` union declares.
        let expected = [
            "capturing",
            "waiting",
            "uploading",
            "reading",
            "ready_review",
            "needs_attention",
            "parked",
            "committing",
            "committed",
            "discarded",
        ];

        let actual: Vec<&str> = CaptureStatus::ALL
            .into_iter()
            .map(CaptureStatus::as_str)
            .collect();
        assert_eq!(actual, expected);

        for status in CaptureStatus::ALL {
            assert_eq!(CaptureStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(CaptureStatus::parse("almost_done"), None);
    }

    #[test]
    fn ingest_outcome_vocabulary_matches_the_schema_check() {
        let actual: Vec<&str> = CaptureIngestOutcome::ALL
            .into_iter()
            .map(CaptureIngestOutcome::as_str)
            .collect();
        assert_eq!(
            actual,
            [
                "ingested",
                "skipped_duplicate",
                "skipped_unsupported",
                "skipped_oversize"
            ]
        );
        assert_eq!(CaptureIngestOutcome::parse("skipped_because"), None);
    }

    #[test]
    fn source_kind_vocabulary_matches_the_shared_type() {
        for (kind, wire) in [
            (CaptureSourceKind::ConnectedScanner, "connected_scanner"),
            (CaptureSourceKind::WatchedFolder, "watched_folder"),
            (CaptureSourceKind::Camera, "camera"),
            (CaptureSourceKind::UsbScanner, "usb_scanner"),
            (CaptureSourceKind::FilePick, "file_pick"),
        ] {
            assert_eq!(kind.as_str(), wire);
            assert_eq!(CaptureSourceKind::parse(wire), Some(kind));
        }
        assert_eq!(CaptureSourceKind::parse("fax"), None);
    }

    #[test]
    fn happy_path_walks_the_designed_state_machine() {
        let happy = [
            Capturing,
            Waiting,
            Uploading,
            Reading,
            ReadyReview,
            Committing,
            Committed,
        ];
        for pair in happy.windows(2) {
            assert!(
                pair[0].can_transition_to(pair[1]),
                "{:?} -> {:?} is the happy path and must be allowed",
                pair[0],
                pair[1],
            );
        }
    }

    #[test]
    fn transient_failures_and_module_gates_move_sideways_not_off_the_queue() {
        // Offline / transient HTTP drops back to Waiting; no state is skipped.
        assert!(Uploading.can_transition_to(Waiting));
        assert!(Reading.can_transition_to(Waiting));

        // MODULE_REQUIRED parks from every in-flight phase, and resumes.
        for from in [Waiting, Uploading, Reading] {
            assert!(from.can_transition_to(Parked), "{from:?} must be parkable");
        }
        assert!(Committing.can_transition_to(Parked));
        assert!(Parked.can_transition_to(Waiting));
        assert!(Parked.can_transition_to(Committing));

        // A stated reason keeps the document: retry re-queues, manual entry
        // goes straight to review.
        assert!(NeedsAttention.can_transition_to(Waiting));
        assert!(NeedsAttention.can_transition_to(ReadyReview));

        // A rejected commit is a stated reason, not a lost document.
        assert!(Committing.can_transition_to(NeedsAttention));
    }

    #[test]
    fn terminal_states_never_move_again() {
        for terminal in [Committed, Discarded] {
            assert!(terminal.is_terminal());
            assert!(!terminal.is_open());
            for next in CaptureStatus::ALL {
                if next == terminal {
                    continue;
                }
                assert!(
                    !terminal.can_transition_to(next),
                    "{terminal:?} must not move to {next:?}",
                );
            }
        }
    }

    #[test]
    fn illegal_shortcuts_are_refused() {
        // Nothing uploads before the user finishes the document.
        assert!(!Capturing.can_transition_to(Uploading));
        assert!(!Capturing.can_transition_to(Committing));
        // Recognition cannot be skipped.
        assert!(!Waiting.can_transition_to(ReadyReview));
        assert!(!Waiting.can_transition_to(Reading));
        assert!(!Uploading.can_transition_to(ReadyReview));
        // A commit cannot be resurrected into recognition, and a document in
        // review cannot claim to be committed without a commit attempt.
        assert!(!Committing.can_transition_to(Waiting));
        assert!(!ReadyReview.can_transition_to(Committed));
        // A capture is only ever discarded by explicit user action, never by
        // an in-flight commit.
        assert!(!Committing.can_transition_to(Discarded));
    }

    #[test]
    fn re_asserting_the_same_status_is_an_idempotent_no_op() {
        for status in CaptureStatus::ALL {
            assert!(
                status.can_transition_to(status),
                "{status:?} must accept an idempotent re-assert",
            );
        }
    }
}
