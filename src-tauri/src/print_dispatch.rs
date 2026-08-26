use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum PrinterTargetKey {
    WindowsQueue(String),
    RawTcp { host: String, port: u16 },
    Serial { port_name: String, baud_rate: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DispatchState {
    Created,
    Submitting,
    WindowsQueued,
    WindowsPrinting,
    Paused,
    Sent,
    SpoolCompleted,
    CancelRequested,
    Cancelled,
    TransportError,
    SpoolError,
    CancelFailed,
    Unknown,
}

const SHARED_ATTEMPT_BLOCKING_STATES_SQL: &str =
    "'created', 'submitting', 'windows_queued', 'windows_printing', 'paused', \
     'cancel_requested', 'unknown', 'cancel_failed'";
pub(crate) const MAX_WINDOWS_SPOOL_JOB_ID_SQL: &str = "4294967295";

/// The durable all-attempt blocker contract. A `spool_error` retains a target
/// only when SQLite persisted an actual Windows JobId in the native u32 range.
/// Other active lifecycle states are blockers regardless of native identity.
pub(crate) fn shared_attempt_blocker_predicate_sql(alias: &str) -> String {
    format!(
        "({alias}.state IN ({SHARED_ATTEMPT_BLOCKING_STATES_SQL}) \
          OR ({alias}.state = 'spool_error' \
              AND typeof({alias}.spool_job_id) = 'integer' \
              AND {alias}.spool_job_id BETWEEN 1 AND {MAX_WINDOWS_SPOOL_JOB_ID_SQL}))"
    )
}

pub(crate) fn attempt_state_is_shared_blocker(
    state: Option<&str>,
    spool_job_id: Option<i64>,
) -> bool {
    state.is_some_and(|state| {
        matches!(
            state,
            "created"
                | "submitting"
                | "windows_queued"
                | "windows_printing"
                | "paused"
                | "cancel_requested"
                | "unknown"
                | "cancel_failed"
        ) || (state == "spool_error"
            && spool_job_id.is_some_and(|job_id| (1..=i64::from(u32::MAX)).contains(&job_id)))
    })
}

impl DispatchState {
    /// Test-only roster of every state, used to pin the `as_str` / `from_str` round trip
    /// so a new variant cannot be added without a persisted spelling. Production never
    /// iterates the states -- it only maps a single value in either direction -- so this
    /// stays out of the shipped binary.
    #[cfg(test)]
    pub(crate) const ALL: [Self; 13] = [
        Self::Created,
        Self::Submitting,
        Self::WindowsQueued,
        Self::WindowsPrinting,
        Self::Paused,
        Self::Sent,
        Self::SpoolCompleted,
        Self::CancelRequested,
        Self::Cancelled,
        Self::TransportError,
        Self::SpoolError,
        Self::CancelFailed,
        Self::Unknown,
    ];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Submitting => "submitting",
            Self::WindowsQueued => "windows_queued",
            Self::WindowsPrinting => "windows_printing",
            Self::Paused => "paused",
            Self::Sent => "sent",
            Self::SpoolCompleted => "spool_completed",
            Self::CancelRequested => "cancel_requested",
            Self::Cancelled => "cancelled",
            Self::TransportError => "transport_error",
            Self::SpoolError => "spool_error",
            Self::CancelFailed => "cancel_failed",
            Self::Unknown => "unknown",
        }
    }

    pub(crate) fn from_str(value: &str) -> Result<Self, DispatchError> {
        match value {
            "created" => Ok(Self::Created),
            "submitting" => Ok(Self::Submitting),
            "windows_queued" => Ok(Self::WindowsQueued),
            "windows_printing" => Ok(Self::WindowsPrinting),
            "paused" => Ok(Self::Paused),
            "sent" => Ok(Self::Sent),
            "spool_completed" => Ok(Self::SpoolCompleted),
            "cancel_requested" => Ok(Self::CancelRequested),
            "cancelled" => Ok(Self::Cancelled),
            "transport_error" => Ok(Self::TransportError),
            "spool_error" => Ok(Self::SpoolError),
            "cancel_failed" => Ok(Self::CancelFailed),
            "unknown" => Ok(Self::Unknown),
            _ => Err(DispatchError::UnsupportedState(value.to_owned())),
        }
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Sent
                | Self::SpoolCompleted
                | Self::Cancelled
                | Self::TransportError
                | Self::SpoolError
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AttemptIdentity {
    pub local_job_id: String,
    pub attempt_id: Uuid,
    pub attempt_number: i64,
    pub target_key: PrinterTargetKey,
}

/// Test-only input to [`create_attempt`]; see the note there.
#[cfg(test)]
pub(crate) struct NewAttempt {
    pub local_job_id: String,
    pub target: PrinterTargetKey,
    pub document_kind: String,
    pub bytes_requested: i64,
    pub now: DateTime<Utc>,
}

pub(crate) struct PrepareManagedAttempt {
    pub local_job_id: String,
    pub printer_profile_id: String,
    pub target: PrinterTargetKey,
    pub document_kind: String,
    pub payload: Vec<u8>,
    pub render_profile_snapshot_json: String,
    pub now: DateTime<Utc>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ParentTransition {
    Dispatched { output_path: String },
    RetryableFailure { error: String },
    ManualFailure { error: String },
}

#[derive(Clone, Debug)]
pub(crate) struct AttemptObservation {
    pub now: DateTime<Utc>,
    pub native_status_bits: Option<u32>,
    pub native_status_text: Option<String>,
    pub bytes_written: Option<i64>,
    pub last_error: Option<String>,
}

impl Default for AttemptObservation {
    fn default() -> Self {
        Self {
            now: Utc::now(),
            native_status_bits: None,
            native_status_text: None,
            bytes_written: None,
            last_error: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApplyResult {
    Applied,
    NotApplied,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AttemptRecord {
    pub identity: AttemptIdentity,
    pub transport: String,
    pub resolved_target: String,
    pub document_name: String,
    pub spool_job_id: Option<u32>,
    pub state: DispatchState,
    pub native_status_bits: Option<u32>,
    pub native_status_text: Option<String>,
    pub bytes_requested: i64,
    pub bytes_written: i64,
    pub started_at: String,
    pub last_seen_at: Option<String>,
    pub completed_at: Option<String>,
    pub cancel_requested_at: Option<String>,
    pub cancel_confirmed_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OwnedWindowsControlResult {
    Requested,
    NotRequired,
    OwnershipNotConfirmed { reason: String },
    Failed { error: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OwnedWindowsReconcileOutcome {
    Active(DispatchState),
    SpoolCompleted,
    CancellationConfirmed,
    OwnershipNotConfirmed { reason: String },
    Failed { error: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OwnedWindowsReconcileResult {
    pub outcome: OwnedWindowsReconcileOutcome,
    pub target_released: bool,
}

fn cancelled_reconciliation_result(stage: &str) -> OwnedWindowsReconcileResult {
    OwnedWindowsReconcileResult {
        outcome: OwnedWindowsReconcileOutcome::Failed {
            error: stage.to_owned(),
        },
        target_released: false,
    }
}

#[derive(Debug, Error)]
pub(crate) enum DispatchError {
    #[error("invalid printer target: {0}")]
    InvalidTarget(&'static str),
    #[error("invalid byte count")]
    InvalidByteCount,
    #[error("print attempt does not exist")]
    MissingAttempt,
    // Test-only: raised solely by the cfg(test) `create_attempt` seam. The production
    // entry point (`prepare_managed_attempt`) reports an unusable parent as
    // `ParentNotEligible`, because it claims the row rather than merely probing it.
    #[cfg(test)]
    #[error("print job does not exist")]
    MissingPrintJob,
    #[error("print job id is not a UUID")]
    InvalidPrintJobId,
    #[error("print job is no longer eligible for managed preparation")]
    ParentNotEligible,
    #[error("resolved printer profile id is empty")]
    InvalidPrinterProfile,
    #[error("print queue is paused for the resolved printer profile")]
    QueuePaused,
    #[error("print snapshot operation failed: {0}")]
    Snapshot(String),
    #[error("Windows spool JobId must be nonzero")]
    InvalidWindowsJobId,
    #[error("invalid document marker: {0}")]
    InvalidDocumentMarker(#[from] crate::windows_spooler::MarkerParseError),
    #[error("unsupported dispatch state: {0}")]
    UnsupportedState(String),
    #[error("printer target lane is already held")]
    LaneBusy,
    #[error("printer target circuit is open")]
    CircuitOpen,
    #[error("printer target lane is not retained for reconciliation")]
    LaneNotRetained,
    // Test-only: raised solely by the cfg(test) `reconcile` seam below, which surfaces
    // `commit_reconciliation_transaction`'s "target not released" result as an error.
    // Production reads that result as a bool through `reconcile_owned_windows_attempt`.
    #[cfg(test)]
    #[error("printer target still has active reconciliation blockers")]
    TargetStillBlocked,
    #[error("native reconciliation was cancelled before durable commit")]
    ReconciliationCancelled,
    #[error("printer target lane lock is poisoned")]
    LockPoisoned,
    #[error("outcome cannot release or block a target lane")]
    InvalidLaneOutcome,
    #[error("attempt target does not match the claimed target lane")]
    AttemptTargetMismatch,
    #[error("attempt lease belongs to a different dispatch manager")]
    LeaseOwnershipMismatch,
    #[error("an unresolved outcome requires a nonempty blocked reason")]
    MissingBlockedReason,
    #[error("database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
}

fn normalized_component(value: &str) -> Result<String, DispatchError> {
    let value = value.trim().to_lowercase();
    if value.is_empty() {
        Err(DispatchError::InvalidTarget("target name is empty"))
    } else {
        Ok(value)
    }
}

fn length_prefixed(tag: &str, component: &str, suffix: Option<u64>) -> String {
    match suffix {
        Some(value) => format!("{tag}:{}:{component}:{value}", component.len()),
        None => format!("{tag}:{}:{component}", component.len()),
    }
}

pub(crate) fn normalize_target(target: &PrinterTargetKey) -> Result<String, DispatchError> {
    match target {
        PrinterTargetKey::WindowsQueue(queue) => Ok(length_prefixed(
            "windows",
            &normalized_component(queue)?,
            None,
        )),
        PrinterTargetKey::RawTcp { host, port } => {
            if *port == 0 {
                return Err(DispatchError::InvalidTarget("TCP port is zero"));
            }
            Ok(length_prefixed(
                "raw_tcp",
                &normalized_component(host)?,
                Some(u64::from(*port)),
            ))
        }
        PrinterTargetKey::Serial {
            port_name,
            baud_rate,
        } => {
            if *baud_rate == 0 {
                return Err(DispatchError::InvalidTarget("serial baud rate is zero"));
            }
            Ok(length_prefixed(
                "serial",
                &normalized_component(port_name)?,
                Some(u64::from(*baud_rate)),
            ))
        }
    }
}

fn transport_and_resolved(target: &PrinterTargetKey) -> (&'static str, String) {
    match target {
        PrinterTargetKey::WindowsQueue(queue) => ("windows", queue.clone()),
        PrinterTargetKey::RawTcp { host, port } => (
            "raw_tcp",
            length_prefixed("host", host, Some(u64::from(*port))),
        ),
        PrinterTargetKey::Serial {
            port_name,
            baud_rate,
        } => (
            "serial",
            length_prefixed("port", port_name, Some(u64::from(*baud_rate))),
        ),
    }
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Test-only attempt seeding.
///
/// Production always enters through [`prepare_managed_attempt`], which does everything
/// this does **and** claims the parent row (`pending` -> `printing`) in the same immediate
/// transaction, freezes the document snapshot, and honours the queue-paused gate. This
/// one only checks that a parent exists, so a caller could append an attempt to a job it
/// never claimed -- exactly the split-transaction shape that let jobs strand in
/// `printing`. Kept behind cfg(test) because tests legitimately need to fabricate an
/// attempt without driving a full managed dispatch; it must never become reachable from
/// shipped code.
#[cfg(test)]
pub(crate) fn create_attempt(
    conn: &Connection,
    request: NewAttempt,
) -> Result<AttemptIdentity, DispatchError> {
    if request.bytes_requested < 0 {
        return Err(DispatchError::InvalidByteCount);
    }
    normalize_target(&request.target)?;

    let parent_exists = conn
        .query_row(
            "SELECT 1 FROM print_jobs WHERE id = ?1",
            [&request.local_job_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !parent_exists {
        return Err(DispatchError::MissingPrintJob);
    }

    let local_job_uuid =
        Uuid::parse_str(&request.local_job_id).map_err(|_| DispatchError::InvalidPrintJobId)?;
    let attempt_id = Uuid::new_v4();
    let document_name = crate::windows_spooler::format_document_marker(
        local_job_uuid,
        attempt_id,
        &request.document_kind,
    )?;
    let (transport, resolved_target) = transport_and_resolved(&request.target);
    let started_at = timestamp(request.now);

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let attempt_number: i64 = tx.query_row(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1
         FROM print_job_attempts WHERE print_job_id = ?1",
        [&request.local_job_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO print_job_attempts
         (id, print_job_id, attempt_number, transport, resolved_target, document_name,
          state, bytes_requested, bytes_written, started_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'created', ?7, 0, ?8, ?8)",
        params![
            attempt_id.to_string(),
            request.local_job_id,
            attempt_number,
            transport,
            resolved_target,
            document_name,
            request.bytes_requested,
            started_at,
        ],
    )?;
    tx.commit()?;

    Ok(AttemptIdentity {
        local_job_id: request.local_job_id,
        attempt_id,
        attempt_number,
        target_key: request.target,
    })
}

pub(crate) fn prepare_managed_attempt(
    conn: &Connection,
    request: PrepareManagedAttempt,
) -> Result<AttemptIdentity, DispatchError> {
    if request.printer_profile_id.trim().is_empty() {
        return Err(DispatchError::InvalidPrinterProfile);
    }
    let bytes_requested =
        i64::try_from(request.payload.len()).map_err(|_| DispatchError::InvalidByteCount)?;
    normalize_target(&request.target)?;
    let local_job_uuid =
        Uuid::parse_str(&request.local_job_id).map_err(|_| DispatchError::InvalidPrintJobId)?;
    let attempt_id = Uuid::new_v4();
    let document_name = crate::windows_spooler::format_document_marker(
        local_job_uuid,
        attempt_id,
        &request.document_kind,
    )?;
    let encoded = crate::print_snapshot::encode_print_payload(&request.payload)
        .map_err(DispatchError::Snapshot)?;
    let (transport, resolved_target) = transport_and_resolved(&request.target);
    let now = timestamp(request.now);

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    if managed_queue_is_paused(&tx, &request.printer_profile_id)? {
        return Err(DispatchError::QueuePaused);
    }
    let claimed = tx.execute(
        "UPDATE print_jobs
         SET status = 'printing', printer_profile_id = ?1, updated_at = ?2
         WHERE id = ?3 AND status = 'pending'
           AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?2))",
        params![request.printer_profile_id, now, request.local_job_id],
    )?;
    if claimed != 1 {
        return Err(DispatchError::ParentNotEligible);
    }

    let stored = tx.query_row(
        "SELECT document_snapshot_version, document_snapshot_zlib,
                document_snapshot_sha256, render_profile_snapshot_json
         FROM print_jobs WHERE id = ?1",
        [&request.local_job_id],
        |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?,
                row.get::<_, Option<Vec<u8>>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        },
    )?;
    match stored {
        (None, None, None, None) => {
            let changed = tx.execute(
                "UPDATE print_jobs
                 SET document_snapshot_version = ?1,
                     document_snapshot_zlib = ?2,
                     document_snapshot_sha256 = ?3,
                     render_profile_snapshot_json = ?4
                 WHERE id = ?5
                   AND document_snapshot_version IS NULL
                   AND document_snapshot_zlib IS NULL
                   AND document_snapshot_sha256 IS NULL
                   AND render_profile_snapshot_json IS NULL",
                params![
                    encoded.version,
                    encoded.compressed,
                    encoded.sha256,
                    request.render_profile_snapshot_json,
                    request.local_job_id,
                ],
            )?;
            if changed != 1 {
                return Err(DispatchError::Snapshot(
                    "immutable snapshot write lost".into(),
                ));
            }
        }
        (Some(version), Some(compressed), Some(sha256), Some(envelope)) => {
            let stored_payload =
                crate::print_snapshot::decode_print_payload(version, &compressed, &sha256)
                    .map_err(DispatchError::Snapshot)?;
            if stored_payload != request.payload || envelope != request.render_profile_snapshot_json
            {
                return Err(DispatchError::Snapshot(
                    "immutable snapshot does not match frozen dispatch".into(),
                ));
            }
        }
        _ => {
            return Err(DispatchError::Snapshot(
                "immutable snapshot/envelope is partial".into(),
            ));
        }
    }

    let attempt_number: i64 = tx.query_row(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1
         FROM print_job_attempts WHERE print_job_id = ?1",
        [&request.local_job_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO print_job_attempts
         (id, print_job_id, attempt_number, transport, resolved_target, document_name,
          state, bytes_requested, bytes_written, started_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'created', ?7, 0, ?8, ?8)",
        params![
            attempt_id.to_string(),
            request.local_job_id,
            attempt_number,
            transport,
            resolved_target,
            document_name,
            bytes_requested,
            now,
        ],
    )?;
    tx.commit()?;

    Ok(AttemptIdentity {
        local_job_id: request.local_job_id,
        attempt_id,
        attempt_number,
        target_key: request.target,
    })
}

fn managed_queue_is_paused(
    conn: &Connection,
    printer_profile_id: &str,
) -> Result<bool, DispatchError> {
    let profile_key = format!("queue_paused_profile::{printer_profile_id}");
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM local_settings
             WHERE setting_category = 'printing'
               AND setting_key IN ('queue_paused', ?1)
               AND lower(trim(COALESCE(setting_value, ''))) IN ('1', 'true', 'yes', 'on')
         )",
        [profile_key],
        |row| row.get::<_, bool>(0),
    )
    .map_err(DispatchError::from)
}

pub(crate) fn begin_managed_submission(
    conn: &Connection,
    attempt_id: Uuid,
    now: DateTime<Utc>,
) -> Result<ApplyResult, DispatchError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let attempt = read_attempt(&tx, attempt_id)?.ok_or(DispatchError::MissingAttempt)?;
    if attempt.state != DispatchState::Created {
        return Ok(ApplyResult::NotApplied);
    }
    let latest_attempt_id: String = tx.query_row(
        "SELECT id FROM print_job_attempts
         WHERE print_job_id = ?1
         ORDER BY attempt_number DESC
         LIMIT 1",
        [&attempt.identity.local_job_id],
        |row| row.get(0),
    )?;
    if latest_attempt_id != attempt_id.to_string() {
        if transition_attempt(
            &tx,
            attempt_id,
            DispatchState::Cancelled,
            AttemptObservation {
                now,
                last_error: Some(
                    "Managed print attempt superseded by a newer parent epoch before I/O".into(),
                ),
                ..AttemptObservation::default()
            },
        )? == ApplyResult::Applied
        {
            tx.commit()?;
        }
        return Ok(ApplyResult::NotApplied);
    }
    let (parent_status, profile_id) = tx.query_row(
        "SELECT status, printer_profile_id FROM print_jobs WHERE id = ?1",
        [&attempt.identity.local_job_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    )?;
    let paused = match profile_id.as_deref() {
        Some(profile_id) => managed_queue_is_paused(&tx, profile_id)?,
        None => true,
    };
    if parent_status != "printing" || paused {
        if parent_status == "printing" && paused {
            tx.execute(
                "UPDATE print_jobs
                 SET status = 'pending', next_retry_at = NULL, updated_at = ?1
                 WHERE id = ?2 AND status = 'printing'",
                params![timestamp(now), attempt.identity.local_job_id],
            )?;
        }
        if transition_attempt(
            &tx,
            attempt_id,
            DispatchState::Cancelled,
            AttemptObservation {
                now,
                last_error: Some(if paused {
                    "Managed print attempt stopped before I/O because the queue was paused".into()
                } else {
                    "Managed print attempt stopped before I/O because the parent changed".into()
                }),
                ..AttemptObservation::default()
            },
        )? != ApplyResult::Applied
        {
            return Ok(ApplyResult::NotApplied);
        }
        tx.commit()?;
        return Ok(ApplyResult::NotApplied);
    }

    let result = transition_attempt(
        &tx,
        attempt_id,
        DispatchState::Submitting,
        AttemptObservation {
            now,
            ..AttemptObservation::default()
        },
    )?;
    if result == ApplyResult::Applied {
        tx.commit()?;
    }
    Ok(result)
}

pub(crate) fn cancel_managed_submission_before_io(
    conn: &Connection,
    attempt_id: Uuid,
    now: DateTime<Utc>,
) -> Result<ApplyResult, DispatchError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let attempt = read_attempt(&tx, attempt_id)?.ok_or(DispatchError::MissingAttempt)?;
    if attempt.state != DispatchState::Submitting {
        return Ok(ApplyResult::NotApplied);
    }
    if transition_attempt(
        &tx,
        attempt_id,
        DispatchState::CancelRequested,
        AttemptObservation {
            now,
            last_error: Some("Managed print attempt cancelled before transport I/O".into()),
            ..AttemptObservation::default()
        },
    )? != ApplyResult::Applied
    {
        return Ok(ApplyResult::NotApplied);
    }
    if transition_attempt(
        &tx,
        attempt_id,
        DispatchState::Cancelled,
        AttemptObservation {
            now,
            ..AttemptObservation::default()
        },
    )? != ApplyResult::Applied
    {
        return Ok(ApplyResult::NotApplied);
    }
    tx.commit()?;
    Ok(ApplyResult::Applied)
}

fn allowed_predecessors(next: DispatchState) -> &'static [DispatchState] {
    use DispatchState::*;
    match next {
        Submitting => &[Created],
        WindowsQueued => &[Submitting, Paused, Unknown],
        WindowsPrinting => &[WindowsQueued, Paused, Unknown],
        Paused => &[WindowsQueued, WindowsPrinting, Unknown],
        Sent => &[Submitting],
        SpoolCompleted => &[WindowsQueued, WindowsPrinting],
        CancelRequested => &[Created, Submitting, WindowsQueued, WindowsPrinting, Paused],
        Cancelled => &[Created, CancelRequested],
        TransportError => &[Created, Submitting],
        SpoolError => &[Submitting, WindowsQueued, WindowsPrinting, Paused],
        CancelFailed => &[CancelRequested],
        Unknown => &[
            Submitting,
            WindowsQueued,
            WindowsPrinting,
            Paused,
            CancelRequested,
        ],
        Created => &[],
    }
}

fn validate_observation_bytes(
    conn: &Connection,
    attempt_id: Uuid,
    bytes_written: Option<i64>,
) -> Result<(), DispatchError> {
    let Some(value) = bytes_written else {
        return Ok(());
    };
    if value < 0 {
        return Err(DispatchError::InvalidByteCount);
    }
    let counts = conn
        .query_row(
            "SELECT bytes_written, bytes_requested FROM print_job_attempts WHERE id = ?1",
            [attempt_id.to_string()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((current, requested)) = counts else {
        return Err(DispatchError::MissingAttempt);
    };
    if value < current || value > requested {
        return Err(DispatchError::InvalidByteCount);
    }
    Ok(())
}

pub(crate) fn transition_attempt(
    conn: &Connection,
    attempt_id: Uuid,
    next: DispatchState,
    observation: AttemptObservation,
) -> Result<ApplyResult, DispatchError> {
    validate_observation_bytes(conn, attempt_id, observation.bytes_written)?;
    let predecessors = allowed_predecessors(next);
    if predecessors.is_empty() {
        return Ok(ApplyResult::NotApplied);
    }
    let predecessor_sql = predecessors
        .iter()
        .map(|state| format!("'{}'", state.as_str()))
        .collect::<Vec<_>>()
        .join(",");
    let now = timestamp(observation.now);
    let completed_at = next.is_terminal().then_some(now.as_str());
    let cancel_requested_at = (next == DispatchState::CancelRequested).then_some(now.as_str());
    let cancel_confirmed_at = (next == DispatchState::Cancelled).then_some(now.as_str());
    let sql = format!(
        "UPDATE print_job_attempts
         SET state = ?1,
             last_seen_at = ?2,
             native_status_bits = COALESCE(?3, native_status_bits),
             native_status_text = COALESCE(?4, native_status_text),
             bytes_written = COALESCE(?5, bytes_written),
             last_error = COALESCE(?6, last_error),
             completed_at = COALESCE(?7, completed_at),
             cancel_requested_at = COALESCE(?8, cancel_requested_at),
             cancel_confirmed_at = COALESCE(?9, cancel_confirmed_at)
         WHERE id = ?10
           AND state IN ({predecessor_sql})
           AND (last_seen_at IS NULL OR last_seen_at <= ?2)
           AND (?5 IS NULL OR (bytes_written <= ?5 AND ?5 <= bytes_requested))"
    );
    let changed = conn.execute(
        &sql,
        params![
            next.as_str(),
            now,
            observation.native_status_bits.map(i64::from),
            observation.native_status_text,
            observation.bytes_written,
            observation.last_error,
            completed_at,
            cancel_requested_at,
            cancel_confirmed_at,
            attempt_id.to_string(),
        ],
    )?;
    Ok(if changed == 1 {
        ApplyResult::Applied
    } else {
        ApplyResult::NotApplied
    })
}

pub(crate) fn observe_attempt(
    conn: &Connection,
    attempt_id: Uuid,
    expected_state: DispatchState,
    observation: AttemptObservation,
) -> Result<ApplyResult, DispatchError> {
    if expected_state.is_terminal() {
        return Ok(ApplyResult::NotApplied);
    }
    validate_observation_bytes(conn, attempt_id, observation.bytes_written)?;
    let changed = conn.execute(
        "UPDATE print_job_attempts
         SET last_seen_at = ?1,
             native_status_bits = COALESCE(?2, native_status_bits),
             native_status_text = COALESCE(?3, native_status_text),
             bytes_written = COALESCE(?4, bytes_written),
             last_error = COALESCE(?5, last_error)
         WHERE id = ?6
           AND state = ?7
           AND (last_seen_at IS NULL OR last_seen_at <= ?1)
           AND (?4 IS NULL OR (bytes_written <= ?4 AND ?4 <= bytes_requested))",
        params![
            timestamp(observation.now),
            observation.native_status_bits.map(i64::from),
            observation.native_status_text,
            observation.bytes_written,
            observation.last_error,
            attempt_id.to_string(),
            expected_state.as_str(),
        ],
    )?;
    Ok(if changed == 1 {
        ApplyResult::Applied
    } else {
        ApplyResult::NotApplied
    })
}

fn target_from_storage(transport: &str, resolved: &str) -> Result<PrinterTargetKey, DispatchError> {
    match transport {
        "windows" => Ok(PrinterTargetKey::WindowsQueue(resolved.to_owned())),
        "raw_tcp" => parse_stored_target(resolved, "host").and_then(|(host, port)| {
            let port = u16::try_from(port)
                .map_err(|_| DispatchError::InvalidTarget("invalid stored TCP port"))?;
            Ok(PrinterTargetKey::RawTcp { host, port })
        }),
        "serial" => parse_stored_target(resolved, "port").and_then(|(port_name, baud_rate)| {
            let baud_rate = u32::try_from(baud_rate)
                .map_err(|_| DispatchError::InvalidTarget("invalid stored serial baud"))?;
            Ok(PrinterTargetKey::Serial {
                port_name,
                baud_rate,
            })
        }),
        _ => Err(DispatchError::InvalidTarget("invalid stored transport")),
    }
}

fn parse_stored_target(value: &str, tag: &str) -> Result<(String, u64), DispatchError> {
    let prefix = format!("{tag}:");
    let rest = value
        .strip_prefix(&prefix)
        .ok_or(DispatchError::InvalidTarget("invalid stored target"))?;
    let (length, rest) = rest
        .split_once(':')
        .ok_or(DispatchError::InvalidTarget("invalid stored target"))?;
    let length: usize = length
        .parse()
        .map_err(|_| DispatchError::InvalidTarget("invalid stored target length"))?;
    if rest.len() <= length || !rest.is_char_boundary(length) || rest.as_bytes()[length] != b':' {
        return Err(DispatchError::InvalidTarget("invalid stored target length"));
    }
    let component = rest[..length].to_owned();
    let suffix = rest[length + 1..]
        .parse()
        .map_err(|_| DispatchError::InvalidTarget("invalid stored target suffix"))?;
    Ok((component, suffix))
}

pub(crate) fn read_attempt(
    conn: &Connection,
    attempt_id: Uuid,
) -> Result<Option<AttemptRecord>, DispatchError> {
    let raw = conn
        .query_row(
            "SELECT print_job_id, attempt_number, transport, resolved_target, document_name,
                    spool_job_id, state, native_status_bits, native_status_text,
                    bytes_requested, bytes_written, started_at, last_seen_at, completed_at,
                    cancel_requested_at, cancel_confirmed_at, last_error
             FROM print_job_attempts WHERE id = ?1",
            [attempt_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<String>>(13)?,
                    row.get::<_, Option<String>>(14)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, Option<String>>(16)?,
                ))
            },
        )
        .optional()?;
    let Some((
        local_job_id,
        attempt_number,
        transport,
        resolved_target,
        document_name,
        spool_job_id,
        state,
        native_status_bits,
        native_status_text,
        bytes_requested,
        bytes_written,
        started_at,
        last_seen_at,
        completed_at,
        cancel_requested_at,
        cancel_confirmed_at,
        last_error,
    )) = raw
    else {
        return Ok(None);
    };
    let target_key = target_from_storage(&transport, &resolved_target)?;
    Ok(Some(AttemptRecord {
        identity: AttemptIdentity {
            local_job_id,
            attempt_id,
            attempt_number,
            target_key,
        },
        transport,
        resolved_target,
        document_name,
        spool_job_id: spool_job_id
            .map(|value| {
                let job_id =
                    u32::try_from(value).map_err(|_| DispatchError::InvalidWindowsJobId)?;
                std::num::NonZeroU32::new(job_id)
                    .map(std::num::NonZeroU32::get)
                    .ok_or(DispatchError::InvalidWindowsJobId)
            })
            .transpose()?,
        state: DispatchState::from_str(&state)?,
        native_status_bits: native_status_bits
            .map(|value| {
                u32::try_from(value)
                    .map_err(|_| DispatchError::InvalidTarget("invalid stored native status"))
            })
            .transpose()?,
        native_status_text,
        bytes_requested,
        bytes_written,
        started_at,
        last_seen_at,
        completed_at,
        cancel_requested_at,
        cancel_confirmed_at,
        last_error,
    }))
}

pub(crate) fn persist_spool_started(
    conn: &Connection,
    attempt_id: Uuid,
    started: &crate::windows_spooler::SpoolStarted,
) -> Result<ApplyResult, DispatchError> {
    if started.job_id == 0 {
        return Err(DispatchError::InvalidWindowsJobId);
    }
    crate::windows_spooler::parse_document_marker(&started.document_name)?;
    let changed = conn.execute(
        "UPDATE print_job_attempts
         SET spool_job_id = ?1, state = 'windows_queued', last_seen_at = ?2
         WHERE id = ?3
           AND transport = 'windows'
           AND state IN ('created', 'submitting')
           AND spool_job_id IS NULL
           AND (last_seen_at IS NULL OR last_seen_at <= ?2)
           AND resolved_target = ?4
           AND document_name = ?5",
        params![
            i64::from(started.job_id),
            timestamp(started.submitted_at),
            attempt_id.to_string(),
            started.printer_name,
            started.document_name,
        ],
    )?;
    Ok(if changed == 1 {
        ApplyResult::Applied
    } else {
        ApplyResult::NotApplied
    })
}

fn ownership_not_confirmed(reason: impl Into<String>) -> OwnedWindowsControlResult {
    OwnedWindowsControlResult::OwnershipNotConfirmed {
        reason: reason.into(),
    }
}

fn is_current_control_attempt(
    attempt: &AttemptRecord,
    control: crate::windows_spooler::SpoolJobControl,
) -> bool {
    use crate::windows_spooler::SpoolJobControl;
    let state_is_eligible = match control {
        SpoolJobControl::Pause => matches!(
            attempt.state,
            DispatchState::WindowsQueued | DispatchState::WindowsPrinting
        ),
        SpoolJobControl::Resume => matches!(
            attempt.state,
            DispatchState::WindowsQueued | DispatchState::WindowsPrinting | DispatchState::Paused
        ),
        SpoolJobControl::Delete => attempt.state == DispatchState::CancelRequested,
    };
    if attempt.transport != "windows"
        || !attempt.spool_job_id.is_some_and(|job_id| job_id > 0)
        || !state_is_eligible
    {
        return false;
    }
    true
}

fn persisted_marker_matches_attempt(attempt: &AttemptRecord) -> bool {
    let Ok(marker) = crate::windows_spooler::parse_document_marker(&attempt.document_name) else {
        return false;
    };
    let Ok(local_job_id) = Uuid::parse_str(&attempt.identity.local_job_id) else {
        return false;
    };
    marker.local_job_id == local_job_id && marker.attempt_id == attempt.identity.attempt_id
}

/// Requests one exact native control only after validating the persisted
/// queue/JobId/document marker and re-reading the current attempt epoch.
/// Native Delete success is deliberately only a request; later absence
/// reconciliation is the sole cancellation confirmation.
#[cfg(test)]
pub(crate) fn control_owned_windows_attempt(
    conn: &Connection,
    spooler: &dyn crate::windows_spooler::WindowsSpooler,
    attempt_id: Uuid,
    control: crate::windows_spooler::SpoolJobControl,
    now: DateTime<Utc>,
) -> Result<OwnedWindowsControlResult, DispatchError> {
    control_owned_windows_attempt_with_cancel(
        conn,
        spooler,
        attempt_id,
        control,
        now,
        &AtomicBool::new(false),
    )
}

/// Cancellation-aware variant used by bounded control batches.  The second
/// check immediately before SetJob is essential: a timed-out GetJob worker may
/// later return, but it must never issue a late native mutation after its
/// caller has abandoned the bounded operation.
pub(crate) fn control_owned_windows_attempt_with_cancel(
    conn: &Connection,
    spooler: &dyn crate::windows_spooler::WindowsSpooler,
    attempt_id: Uuid,
    control: crate::windows_spooler::SpoolJobControl,
    _now: DateTime<Utc>,
    cancel: &AtomicBool,
) -> Result<OwnedWindowsControlResult, DispatchError> {
    if cancel.load(Ordering::Acquire) {
        return Ok(OwnedWindowsControlResult::Failed {
            error: "native_control_cancelled_before_identity_query".into(),
        });
    }
    let before = match read_attempt(conn, attempt_id) {
        Ok(Some(attempt)) => attempt,
        Ok(None) => return Ok(ownership_not_confirmed("attempt_not_found")),
        Err(DispatchError::InvalidWindowsJobId) => {
            return Ok(ownership_not_confirmed("spool_job_id_invalid"));
        }
        Err(error) => return Err(error),
    };
    if !is_current_control_attempt(&before, control) || !persisted_marker_matches_attempt(&before) {
        return Ok(ownership_not_confirmed(
            "attempt_not_current_or_identity_invalid",
        ));
    }
    let Some(job_id) = before.spool_job_id.filter(|job_id| *job_id > 0) else {
        return Ok(ownership_not_confirmed("spool_job_id_missing_or_invalid"));
    };

    let native = match spooler.get_job(&before.resolved_target, job_id) {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return Ok(ownership_not_confirmed("native_job_absent")),
        Err(error) => {
            return Ok(OwnedWindowsControlResult::Failed {
                error: format!("native_identity_query_failed: {error}"),
            })
        }
    };
    let marker = match crate::windows_spooler::validate_owned_job(
        &before.resolved_target,
        job_id,
        &before.document_name,
        &native,
    ) {
        Ok(marker) => marker,
        Err(error) => return Ok(ownership_not_confirmed(error.to_string())),
    };
    let Ok(local_job_id) = Uuid::parse_str(&before.identity.local_job_id) else {
        return Ok(ownership_not_confirmed("persisted_job_id_invalid"));
    };
    if marker.local_job_id != local_job_id || marker.attempt_id != attempt_id {
        return Ok(ownership_not_confirmed("marker_identity_mismatch"));
    }

    if control == crate::windows_spooler::SpoolJobControl::Resume
        && !crate::windows_spooler::native_job_is_paused(native.status_bits)
    {
        return Ok(OwnedWindowsControlResult::NotRequired);
    }

    let current = match read_attempt(conn, attempt_id) {
        Ok(Some(attempt)) => attempt,
        Ok(None) => return Ok(ownership_not_confirmed("attempt_disappeared")),
        Err(DispatchError::InvalidWindowsJobId) => {
            return Ok(ownership_not_confirmed(
                "spool_job_id_invalid_before_control",
            ));
        }
        Err(error) => return Err(error),
    };
    if current.identity != before.identity
        || current.transport != before.transport
        || current.resolved_target != before.resolved_target
        || current.document_name != before.document_name
        || current.spool_job_id != before.spool_job_id
        || current.state != before.state
        || !is_current_control_attempt(&current, control)
    {
        return Ok(ownership_not_confirmed("attempt_changed_before_control"));
    }
    if cancel.load(Ordering::Acquire) {
        return Ok(OwnedWindowsControlResult::Failed {
            error: "native_control_cancelled_before_set_job".into(),
        });
    }

    match spooler.control_job(&current.resolved_target, job_id, control) {
        Ok(()) => Ok(OwnedWindowsControlResult::Requested),
        Err(error) => Ok(OwnedWindowsControlResult::Failed {
            error: error.to_string(),
        }),
    }
}

/// Persists a conservative unresolved state after a bounded native control
/// fails or times out.  It never confirms cancellation or completion.
pub(crate) fn record_owned_windows_control_failure(
    conn: &Connection,
    attempt_id: Uuid,
    control: crate::windows_spooler::SpoolJobControl,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<ApplyResult, DispatchError> {
    let Some(attempt) = read_attempt(conn, attempt_id)? else {
        return Ok(ApplyResult::NotApplied);
    };
    if attempt.transport != "windows"
        || !attempt.spool_job_id.is_some_and(|job_id| job_id > 0)
        || !persisted_marker_matches_attempt(&attempt)
    {
        return Ok(ApplyResult::NotApplied);
    }
    let state_is_eligible = match control {
        crate::windows_spooler::SpoolJobControl::Delete => matches!(
            attempt.state,
            DispatchState::CancelRequested | DispatchState::CancelFailed
        ),
        crate::windows_spooler::SpoolJobControl::Pause => matches!(
            attempt.state,
            DispatchState::WindowsQueued | DispatchState::WindowsPrinting | DispatchState::Unknown
        ),
        crate::windows_spooler::SpoolJobControl::Resume => {
            matches!(
                attempt.state,
                DispatchState::WindowsQueued
                    | DispatchState::WindowsPrinting
                    | DispatchState::Paused
                    | DispatchState::Unknown
            )
        }
    };
    if !state_is_eligible {
        return Ok(ApplyResult::NotApplied);
    }
    persist_reconciliation_block(conn, &attempt, reason, now)?;
    Ok(ApplyResult::Applied)
}

fn reconciliation_identity_matches(before: &AttemptRecord, current: &AttemptRecord) -> bool {
    current.identity == before.identity
        && current.transport == before.transport
        && current.resolved_target == before.resolved_target
        && current.document_name == before.document_name
        && current.spool_job_id == before.spool_job_id
}

fn reconciliation_state_is_blocking(attempt: &AttemptRecord) -> bool {
    matches!(
        attempt.state,
        DispatchState::WindowsQueued
            | DispatchState::WindowsPrinting
            | DispatchState::Paused
            | DispatchState::CancelRequested
            | DispatchState::Unknown
            | DispatchState::CancelFailed
    ) || (attempt.state == DispatchState::SpoolError
        && attempt.spool_job_id.is_some_and(|job_id| job_id > 0))
}

fn persist_reconciliation_block(
    conn: &Connection,
    attempt: &AttemptRecord,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), DispatchError> {
    let next = if attempt.cancel_requested_at.is_some()
        || matches!(
            attempt.state,
            DispatchState::CancelRequested | DispatchState::CancelFailed
        ) {
        DispatchState::CancelFailed
    } else {
        DispatchState::Unknown
    };
    let observation = AttemptObservation {
        now,
        last_error: Some(reason.to_owned()),
        ..AttemptObservation::default()
    };
    if attempt.state == next {
        observe_attempt(
            conn,
            attempt.identity.attempt_id,
            attempt.state,
            observation,
        )?;
    } else {
        transition_attempt(conn, attempt.identity.attempt_id, next, observation)?;
    }
    let (transport, _) = transport_and_resolved(&attempt.identity.target_key);
    let target_key = normalize_target(&attempt.identity.target_key)?;
    let now = timestamp(now);
    conn.execute(
        "INSERT INTO print_target_state
         (target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at)
         VALUES (?1, ?2, 'open', ?3, ?4, ?4)
         ON CONFLICT(target_key) DO UPDATE SET
             transport = excluded.transport,
             circuit_state = 'open',
             blocked_reason = excluded.blocked_reason,
             blocked_at = COALESCE(print_target_state.blocked_at, excluded.blocked_at),
             updated_at = excluded.updated_at",
        params![target_key, transport, reason, now],
    )?;
    Ok(())
}

fn conservative_native_state(
    current: &AttemptRecord,
    status: crate::windows_spooler::NativeJobStatus,
) -> DispatchState {
    if matches!(
        current.state,
        DispatchState::CancelRequested | DispatchState::CancelFailed
    ) {
        return current.state;
    }
    match status {
        crate::windows_spooler::NativeJobStatus::Printing => DispatchState::WindowsPrinting,
        crate::windows_spooler::NativeJobStatus::Paused => DispatchState::Paused,
        _ => DispatchState::WindowsQueued,
    }
}

fn reconcile_absent_attempt(
    conn: &Connection,
    attempt: &AttemptRecord,
    next: DispatchState,
    now: DateTime<Utc>,
) -> Result<ApplyResult, DispatchError> {
    let allowed = match next {
        DispatchState::Cancelled => {
            attempt.cancel_requested_at.is_some()
                && matches!(
                    attempt.state,
                    DispatchState::CancelRequested
                        | DispatchState::CancelFailed
                        | DispatchState::Unknown
                )
        }
        DispatchState::SpoolCompleted => matches!(
            attempt.state,
            DispatchState::WindowsQueued
                | DispatchState::WindowsPrinting
                | DispatchState::Paused
                | DispatchState::SpoolError
                | DispatchState::Unknown
        ),
        _ => false,
    };
    if !allowed {
        return Ok(ApplyResult::NotApplied);
    }
    let now = timestamp(now);
    let changed = conn.execute(
        "UPDATE print_job_attempts
         SET state = ?1,
             last_seen_at = ?2,
             completed_at = COALESCE(completed_at, ?2),
             cancel_confirmed_at = CASE
                 WHEN ?1 = 'cancelled' THEN COALESCE(cancel_confirmed_at, ?2)
                 ELSE cancel_confirmed_at
             END
         WHERE id = ?3 AND state = ?4
           AND (last_seen_at IS NULL OR last_seen_at <= ?2)",
        params![
            next.as_str(),
            now,
            attempt.identity.attempt_id.to_string(),
            attempt.state.as_str()
        ],
    )?;
    Ok(if changed == 1 {
        ApplyResult::Applied
    } else {
        ApplyResult::NotApplied
    })
}

/// Reconciles one persisted current Windows attempt against its exact native
/// JobId. Presence is never treated as completion. Only exact absence confirms
/// cancellation or spool completion, after which the manager atomically proves
/// that no target blocker remains before releasing the retained lane.
#[cfg(test)]
pub(crate) fn reconcile_owned_windows_attempt(
    conn: &Connection,
    manager: &DispatchManager,
    spooler: &dyn crate::windows_spooler::WindowsSpooler,
    attempt_id: Uuid,
    now: DateTime<Utc>,
) -> Result<OwnedWindowsReconcileResult, DispatchError> {
    reconcile_owned_windows_attempt_with_cancel(
        conn,
        manager,
        spooler,
        attempt_id,
        now,
        &AtomicBool::new(false),
    )
}

pub(crate) fn reconcile_owned_windows_attempt_with_cancel(
    conn: &Connection,
    manager: &DispatchManager,
    spooler: &dyn crate::windows_spooler::WindowsSpooler,
    attempt_id: Uuid,
    now: DateTime<Utc>,
    cancel: &AtomicBool,
) -> Result<OwnedWindowsReconcileResult, DispatchError> {
    if cancel.load(Ordering::Acquire) {
        return Ok(cancelled_reconciliation_result(
            "native_reconciliation_cancelled_before_identity_query",
        ));
    }
    let before = match read_attempt(conn, attempt_id) {
        Ok(Some(attempt)) => attempt,
        Ok(None) => {
            return Ok(OwnedWindowsReconcileResult {
                outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                    reason: "attempt_not_found".into(),
                },
                target_released: false,
            });
        }
        Err(DispatchError::InvalidWindowsJobId) => {
            return Ok(OwnedWindowsReconcileResult {
                outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                    reason: "spool_job_id_invalid".into(),
                },
                target_released: false,
            });
        }
        Err(error) => return Err(error),
    };
    if before.transport != "windows"
        || !before.spool_job_id.is_some_and(|job_id| job_id > 0)
        || !reconciliation_state_is_blocking(&before)
        || !persisted_marker_matches_attempt(&before)
    {
        return Ok(OwnedWindowsReconcileResult {
            outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                reason: "attempt_not_current_or_identity_invalid".into(),
            },
            target_released: false,
        });
    }
    let job_id = before
        .spool_job_id
        .filter(|job_id| *job_id > 0)
        .expect("checked above");
    let native_result = spooler.get_job(&before.resolved_target, job_id);
    if cancel.load(Ordering::Acquire) {
        return Ok(cancelled_reconciliation_result(
            "native_reconciliation_cancelled_before_persistence",
        ));
    }

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    if cancel.load(Ordering::Acquire) {
        return Ok(cancelled_reconciliation_result(
            "native_reconciliation_cancelled_after_transaction_acquired",
        ));
    }
    let current = match read_attempt(&tx, attempt_id) {
        Ok(Some(attempt)) => attempt,
        Ok(None) => {
            return Ok(OwnedWindowsReconcileResult {
                outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                    reason: "attempt_disappeared".into(),
                },
                target_released: false,
            });
        }
        Err(DispatchError::InvalidWindowsJobId) => {
            return Ok(OwnedWindowsReconcileResult {
                outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                    reason: "spool_job_id_invalid_before_persistence".into(),
                },
                target_released: false,
            });
        }
        Err(error) => return Err(error),
    };
    if !reconciliation_identity_matches(&before, &current)
        || !reconciliation_state_is_blocking(&current)
    {
        return Ok(OwnedWindowsReconcileResult {
            outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                reason: "attempt_changed_before_reconciliation".into(),
            },
            target_released: false,
        });
    }

    let outcome = match native_result {
        Ok(Some(snapshot)) => {
            let ownership = crate::windows_spooler::validate_owned_job(
                &current.resolved_target,
                job_id,
                &current.document_name,
                &snapshot,
            )
            .and_then(|marker| {
                let local_job_id =
                    Uuid::parse_str(&current.identity.local_job_id).map_err(|_| {
                        crate::windows_spooler::OwnershipError::InvalidMarker {
                            source: crate::windows_spooler::MarkerParseError::LocalJobId,
                        }
                    })?;
                if marker.local_job_id == local_job_id && marker.attempt_id == attempt_id {
                    Ok(marker)
                } else {
                    Err(crate::windows_spooler::OwnershipError::InvalidMarker {
                        source: crate::windows_spooler::MarkerParseError::DocumentKind,
                    })
                }
            });
            if let Err(error) = ownership {
                let reason = format!("ownership_not_confirmed: {error}");
                persist_reconciliation_block(&tx, &current, &reason, now)?;
                if cancel.load(Ordering::Acquire) {
                    return Ok(cancelled_reconciliation_result(
                        "native_reconciliation_cancelled_before_block_commit",
                    ));
                }
                tx.commit()?;
                manager.mark_target_blocked_in_memory(&current.identity.target_key)?;
                return Ok(OwnedWindowsReconcileResult {
                    outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed { reason },
                    target_released: false,
                });
            }

            let next = conservative_native_state(
                &current,
                crate::windows_spooler::map_native_job_status(snapshot.status_bits),
            );
            let observation = AttemptObservation {
                now,
                native_status_bits: Some(snapshot.status_bits),
                native_status_text: snapshot.status_text,
                ..AttemptObservation::default()
            };
            if next == current.state {
                observe_attempt(&tx, attempt_id, current.state, observation)?;
            } else if transition_attempt(&tx, attempt_id, next, observation)?
                != ApplyResult::Applied
            {
                return Ok(OwnedWindowsReconcileResult {
                    outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                        reason: "attempt_state_changed".into(),
                    },
                    target_released: false,
                });
            }
            if cancel.load(Ordering::Acquire) {
                return Ok(cancelled_reconciliation_result(
                    "native_reconciliation_cancelled_before_observation_commit",
                ));
            }
            tx.commit()?;
            return Ok(OwnedWindowsReconcileResult {
                outcome: OwnedWindowsReconcileOutcome::Active(next),
                target_released: false,
            });
        }
        Ok(None) => {
            let cancellation_requested = current.cancel_requested_at.is_some()
                || matches!(
                    current.state,
                    DispatchState::CancelRequested | DispatchState::CancelFailed
                );
            let next = if cancellation_requested {
                DispatchState::Cancelled
            } else {
                DispatchState::SpoolCompleted
            };
            if reconcile_absent_attempt(&tx, &current, next, now)? != ApplyResult::Applied {
                return Ok(OwnedWindowsReconcileResult {
                    outcome: OwnedWindowsReconcileOutcome::OwnershipNotConfirmed {
                        reason: "attempt_state_changed".into(),
                    },
                    target_released: false,
                });
            }
            if cancellation_requested {
                let cancel_parent_sql = format!(
                    "UPDATE print_jobs
                     SET status = 'cancelled',
                         warning_code = 'operator_cancelled',
                         warning_message = 'POS-owned Windows print cancellation confirmed',
                     completed_at = ?1,
                     history_expires_at = datetime(?1, '+30 days'),
                     updated_at = ?1
                     WHERE id = ?2
                       AND NOT EXISTS (
                           SELECT 1 FROM print_job_attempts blocker
                           WHERE blocker.print_job_id = print_jobs.id
                             AND {}
                       )",
                    shared_attempt_blocker_predicate_sql("blocker"),
                );
                tx.execute(
                    &cancel_parent_sql,
                    params![timestamp(now), current.identity.local_job_id,],
                )?;
                OwnedWindowsReconcileOutcome::CancellationConfirmed
            } else {
                OwnedWindowsReconcileOutcome::SpoolCompleted
            }
        }
        Err(error) => {
            let message = format!("native_reconciliation_failed: {error}");
            persist_reconciliation_block(&tx, &current, &message, now)?;
            if cancel.load(Ordering::Acquire) {
                return Ok(cancelled_reconciliation_result(
                    "native_reconciliation_cancelled_before_failure_commit",
                ));
            }
            tx.commit()?;
            manager.mark_target_blocked_in_memory(&current.identity.target_key)?;
            return Ok(OwnedWindowsReconcileResult {
                outcome: OwnedWindowsReconcileOutcome::Failed { error: message },
                target_released: false,
            });
        }
    };
    let target_released = match manager.commit_reconciliation_transaction(
        tx,
        &current.identity.target_key,
        now,
        cancel,
    ) {
        Ok(target_released) => target_released,
        Err(DispatchError::ReconciliationCancelled) => {
            return Ok(cancelled_reconciliation_result(
                "native_reconciliation_cancelled_after_lane_acquired",
            ));
        }
        Err(error) => return Err(error),
    };
    Ok(OwnedWindowsReconcileResult {
        outcome,
        target_released,
    })
}

pub(crate) fn record_owned_windows_reconciliation_failure(
    conn: &Connection,
    attempt_id: Uuid,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<ApplyResult, DispatchError> {
    let Some(attempt) = read_attempt(conn, attempt_id)? else {
        return Ok(ApplyResult::NotApplied);
    };
    if attempt.transport != "windows"
        || !attempt.spool_job_id.is_some_and(|job_id| job_id > 0)
        || !persisted_marker_matches_attempt(&attempt)
        || !reconciliation_state_is_blocking(&attempt)
    {
        return Ok(ApplyResult::NotApplied);
    }
    persist_reconciliation_block(conn, &attempt, reason, now)?;
    Ok(ApplyResult::Applied)
}

#[cfg(test)]
pub(crate) fn active_attempts_for_target(
    conn: &Connection,
    target: &PrinterTargetKey,
) -> Result<Vec<AttemptRecord>, DispatchError> {
    let wanted = normalize_target(target)?;
    let mut statement = conn.prepare(&format!(
        "SELECT id, transport, resolved_target FROM print_job_attempts
         WHERE {}
         ORDER BY started_at, id",
        shared_attempt_blocker_predicate_sql("print_job_attempts"),
    ))?;
    let ids = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut attempts = Vec::new();
    for (id, transport, resolved_target) in ids {
        let candidate = target_from_storage(&transport, &resolved_target)?;
        if normalize_target(&candidate)? != wanted {
            continue;
        }
        let id = Uuid::parse_str(&id).map_err(|_| DispatchError::MissingAttempt)?;
        if let Some(attempt) = read_attempt(conn, id)? {
            attempts.push(attempt);
        }
    }
    Ok(attempts)
}

fn active_target_blockers(
    conn: &Connection,
) -> Result<Vec<(String, DispatchState)>, DispatchError> {
    let mut statement = conn.prepare(&format!(
        "SELECT transport, resolved_target, state FROM print_job_attempts
         WHERE {}
         ORDER BY started_at, id",
        shared_attempt_blocker_predicate_sql("print_job_attempts"),
    ))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    rows.into_iter()
        .map(|(transport, resolved_target, state)| {
            let target = target_from_storage(&transport, &resolved_target)?;
            Ok((normalize_target(&target)?, DispatchState::from_str(&state)?))
        })
        .collect()
}

fn target_has_reconciliation_blockers(
    conn: &Connection,
    target: &PrinterTargetKey,
) -> Result<bool, DispatchError> {
    let wanted = normalize_target(target)?;
    Ok(active_target_blockers(conn)?
        .into_iter()
        .any(|(candidate, _)| candidate == wanted))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LaneBlock {
    Held(Uuid),
    Retained(Uuid),
    OpenHeld(Uuid),
    OpenRetained(Uuid),
}

type LaneRegistry = Arc<Mutex<HashMap<String, LaneBlock>>>;
static PROCESS_LANES: OnceLock<LaneRegistry> = OnceLock::new();

#[cfg(test)]
struct HydrationSnapshotGate {
    token: Uuid,
    expected_lanes: std::sync::Weak<Mutex<HashMap<String, LaneBlock>>>,
    reached: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
static HYDRATION_SNAPSHOT_GATE: OnceLock<Mutex<Option<HydrationSnapshotGate>>> = OnceLock::new();

#[cfg(test)]
struct ReconciliationLaneWaitSignal {
    token: Uuid,
    expected_lanes: std::sync::Weak<Mutex<HashMap<String, LaneBlock>>>,
    expected_target: String,
    reached: std::sync::mpsc::Sender<()>,
}

#[cfg(test)]
static RECONCILIATION_LANE_WAIT_SIGNAL: OnceLock<Mutex<Option<ReconciliationLaneWaitSignal>>> =
    OnceLock::new();

#[cfg(test)]
struct HydrationSnapshotGateRegistration {
    token: Uuid,
}

#[cfg(test)]
impl Drop for HydrationSnapshotGateRegistration {
    fn drop(&mut self) {
        let Ok(mut slot) = HYDRATION_SNAPSHOT_GATE
            .get_or_init(|| Mutex::new(None))
            .lock()
        else {
            return;
        };
        if slot.as_ref().map(|gate| gate.token) == Some(self.token) {
            *slot = None;
        }
    }
}

#[cfg(test)]
fn install_hydration_snapshot_gate_for_test(
    lanes: &LaneRegistry,
    reached: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
) -> HydrationSnapshotGateRegistration {
    let token = Uuid::new_v4();
    let mut slot = HYDRATION_SNAPSHOT_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(slot.is_none(), "hydration snapshot gate already installed");
    *slot = Some(HydrationSnapshotGate {
        token,
        expected_lanes: Arc::downgrade(lanes),
        reached,
        release,
    });
    HydrationSnapshotGateRegistration { token }
}

#[cfg(test)]
struct ReconciliationLaneWaitSignalRegistration {
    token: Uuid,
}

#[cfg(test)]
impl Drop for ReconciliationLaneWaitSignalRegistration {
    fn drop(&mut self) {
        let Ok(mut slot) = RECONCILIATION_LANE_WAIT_SIGNAL
            .get_or_init(|| Mutex::new(None))
            .lock()
        else {
            return;
        };
        if slot.as_ref().map(|signal| signal.token) == Some(self.token) {
            *slot = None;
        }
    }
}

#[cfg(test)]
fn install_reconciliation_lane_wait_signal_for_test(
    lanes: &LaneRegistry,
    normalized_target: &str,
    reached: std::sync::mpsc::Sender<()>,
) -> ReconciliationLaneWaitSignalRegistration {
    let token = Uuid::new_v4();
    let mut slot = RECONCILIATION_LANE_WAIT_SIGNAL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(
        slot.is_none(),
        "reconciliation lane signal already installed"
    );
    *slot = Some(ReconciliationLaneWaitSignal {
        token,
        expected_lanes: Arc::downgrade(lanes),
        expected_target: normalized_target.to_owned(),
        reached,
    });
    ReconciliationLaneWaitSignalRegistration { token }
}

#[cfg(test)]
fn pause_after_hydration_snapshot_for_test(lanes: &LaneRegistry) {
    let mut slot = HYDRATION_SNAPSHOT_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let matches_registry = slot.as_ref().is_some_and(|gate| {
        gate.expected_lanes
            .upgrade()
            .is_some_and(|expected| Arc::ptr_eq(&expected, lanes))
    });
    if !matches_registry {
        return;
    }
    let gate = slot.take().expect("matching hydration gate must exist");
    drop(slot);
    gate.reached.send(()).unwrap();
    gate.release.recv().unwrap();
}

#[cfg(test)]
fn signal_before_reconciliation_lane_lock_for_test(lanes: &LaneRegistry, normalized_target: &str) {
    let mut slot = RECONCILIATION_LANE_WAIT_SIGNAL
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let matches_scope = slot.as_ref().is_some_and(|signal| {
        signal.expected_target == normalized_target
            && signal
                .expected_lanes
                .upgrade()
                .is_some_and(|expected| Arc::ptr_eq(&expected, lanes))
    });
    if !matches_scope {
        return;
    }
    let signal = slot
        .take()
        .expect("matching reconciliation lane signal must exist");
    drop(slot);
    signal.reached.send(()).unwrap();
}

fn process_lane_registry() -> LaneRegistry {
    Arc::clone(PROCESS_LANES.get_or_init(|| Arc::new(Mutex::new(HashMap::new()))))
}

#[derive(Clone)]
pub(crate) struct DispatchManager {
    lanes: LaneRegistry,
}

impl Default for DispatchManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DispatchManager {
    pub(crate) fn new() -> Self {
        Self {
            lanes: process_lane_registry(),
        }
    }

    fn mark_target_blocked_in_memory(
        &self,
        target: &PrinterTargetKey,
    ) -> Result<(), DispatchError> {
        let normalized_key = normalize_target(target)?;
        let mut lanes = self.lanes.lock().map_err(|_| DispatchError::LockPoisoned)?;
        let blocked = match lanes.get(&normalized_key).copied() {
            Some(LaneBlock::Held(generation)) => LaneBlock::OpenHeld(generation),
            Some(LaneBlock::Retained(generation)) => LaneBlock::OpenRetained(generation),
            Some(block @ (LaneBlock::OpenHeld(_) | LaneBlock::OpenRetained(_))) => block,
            None => LaneBlock::OpenRetained(Uuid::new_v4()),
        };
        lanes.insert(normalized_key, blocked);
        Ok(())
    }

    pub(crate) fn hydrate(conn: &Connection) -> Result<Self, DispatchError> {
        Self::hydrate_with_registry(conn, process_lane_registry())
    }

    #[cfg(test)]
    pub(crate) fn isolated_for_test() -> Self {
        Self {
            lanes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    fn hydrate_isolated_for_test(conn: &Connection) -> Result<Self, DispatchError> {
        Self::hydrate_with_registry(conn, Arc::new(Mutex::new(HashMap::new())))
    }

    fn hydrate_with_registry(
        conn: &Connection,
        lanes: LaneRegistry,
    ) -> Result<Self, DispatchError> {
        // Hydration and reconciliation share the same DB-then-lane lock order.
        // The IMMEDIATE transaction prevents a reconciliation commit/removal
        // from landing between this durable snapshot and the lane update.
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        let mut statement =
            tx.prepare("SELECT target_key FROM print_target_state WHERE circuit_state = 'open'")?;
        let keys = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        if keys.iter().any(String::is_empty) {
            return Err(DispatchError::InvalidTarget("empty persisted target key"));
        }
        let active = active_target_blockers(&tx)?;
        #[cfg(test)]
        pause_after_hydration_snapshot_for_test(&lanes);
        let manager = Self { lanes };
        {
            let mut lanes = manager
                .lanes
                .lock()
                .map_err(|_| DispatchError::LockPoisoned)?;
            // Commit while the lane guard is held. A reconciler that starts
            // next will therefore remove any blocker this snapshot hydrates.
            tx.commit()?;
            for key in keys {
                let hydrated = match lanes.get(&key).copied() {
                    Some(LaneBlock::Held(generation)) => LaneBlock::OpenHeld(generation),
                    Some(LaneBlock::Retained(generation)) => LaneBlock::OpenRetained(generation),
                    Some(block @ (LaneBlock::OpenHeld(_) | LaneBlock::OpenRetained(_))) => block,
                    None => LaneBlock::OpenRetained(Uuid::new_v4()),
                };
                lanes.insert(key, hydrated);
            }
            for (key, state) in active {
                let unresolved =
                    matches!(state, DispatchState::Unknown | DispatchState::CancelFailed);
                let hydrated = match (lanes.get(&key).copied(), unresolved) {
                    (Some(LaneBlock::Held(generation)), true) => LaneBlock::OpenHeld(generation),
                    (Some(LaneBlock::Retained(generation)), true) => {
                        LaneBlock::OpenRetained(generation)
                    }
                    (Some(block @ (LaneBlock::OpenHeld(_) | LaneBlock::OpenRetained(_))), _) => {
                        block
                    }
                    (Some(block @ (LaneBlock::Held(_) | LaneBlock::Retained(_))), false) => block,
                    (None, true) => LaneBlock::OpenRetained(Uuid::new_v4()),
                    (None, false) => LaneBlock::Retained(Uuid::new_v4()),
                };
                lanes.insert(key, hydrated);
            }
        }
        Ok(manager)
    }

    pub(crate) fn claim(&self, target: PrinterTargetKey) -> Result<AttemptLease, DispatchError> {
        let normalized_key = normalize_target(&target)?;
        let token = Uuid::new_v4();
        let mut lanes = self.lanes.lock().map_err(|_| DispatchError::LockPoisoned)?;
        match lanes.get(&normalized_key) {
            Some(LaneBlock::Held(_) | LaneBlock::Retained(_)) => {
                return Err(DispatchError::LaneBusy);
            }
            Some(LaneBlock::OpenHeld(_) | LaneBlock::OpenRetained(_)) => {
                return Err(DispatchError::CircuitOpen);
            }
            None => {}
        }
        lanes.insert(normalized_key.clone(), LaneBlock::Held(token));
        drop(lanes);
        Ok(AttemptLease {
            lanes: Arc::clone(&self.lanes),
            target,
            normalized_key,
            token,
            release_on_drop: false,
        })
    }

    /// Test adapter over the shipped finalizer.
    ///
    /// The lane, lease and circuit-breaker assertions below used to run against a second
    /// copy of this logic (`finish_attempt`), which settled the attempt but left the
    /// parent `print_jobs` row untouched -- the split-write shape that stranded jobs in
    /// `printing`. Those guarantees now exercise `finalize_attempt_and_parent`, the
    /// routine production actually calls, so they cannot silently drift from it.
    ///
    /// Mirrors the live precondition (`prepare_managed_attempt` has already claimed the
    /// parent into `printing`) and picks the parent transition implied by the outcome.
    #[cfg(test)]
    pub(crate) fn finish_attempt_for_test(
        &self,
        conn: &Connection,
        lease: &mut AttemptLease,
        attempt_id: Uuid,
        outcome: DispatchState,
        blocked_reason: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<ApplyResult, DispatchError> {
        conn.execute(
            "UPDATE print_jobs SET status = 'printing'
             WHERE id = (SELECT print_job_id FROM print_job_attempts WHERE id = ?1)
               AND status <> 'printing'",
            [attempt_id.to_string()],
        )?;
        let parent = match blocked_reason {
            Some(error) => ParentTransition::ManualFailure {
                error: error.to_owned(),
            },
            None => ParentTransition::Dispatched {
                output_path: "windows://test".to_owned(),
            },
        };
        self.finalize_attempt_and_parent(
            conn,
            lease,
            attempt_id,
            outcome,
            parent,
            AttemptObservation {
                now,
                last_error: blocked_reason.map(str::to_owned),
                ..AttemptObservation::default()
            },
        )
    }

    pub(crate) fn finalize_attempt_and_parent(
        &self,
        conn: &Connection,
        lease: &mut AttemptLease,
        attempt_id: Uuid,
        outcome: DispatchState,
        parent: ParentTransition,
        observation: AttemptObservation,
    ) -> Result<ApplyResult, DispatchError> {
        if !Arc::ptr_eq(&self.lanes, &lease.lanes) {
            return Err(DispatchError::LeaseOwnershipMismatch);
        }
        let opens_circuit = matches!(
            outcome,
            DispatchState::Unknown | DispatchState::CancelFailed
        );
        if !opens_circuit && !outcome.is_terminal() {
            return Err(DispatchError::InvalidLaneOutcome);
        }
        let blocked_reason = observation
            .last_error
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if opens_circuit && blocked_reason.is_none() {
            return Err(DispatchError::MissingBlockedReason);
        }

        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        let attempt = read_attempt(&tx, attempt_id)?.ok_or(DispatchError::MissingAttempt)?;
        if normalize_target(&attempt.identity.target_key)? != lease.normalized_key {
            return Err(DispatchError::AttemptTargetMismatch);
        }
        if !opens_circuit {
            let circuit_is_open = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM print_target_state
                               WHERE target_key = ?1 AND circuit_state = 'open')",
                [&lease.normalized_key],
                |row| row.get::<_, bool>(0),
            )?;
            if circuit_is_open {
                return Err(DispatchError::CircuitOpen);
            }
        }

        let now = timestamp(observation.now);
        let parent_changed = match &parent {
            ParentTransition::Dispatched { output_path } => tx.execute(
                "UPDATE print_jobs
                 SET status = 'dispatched', output_path = ?1,
                     last_attempt_at = ?2, completed_at = ?2,
                     history_expires_at = datetime(?2, '+30 days'),
                     updated_at = ?2
                 WHERE id = ?3 AND status = 'printing'
                   AND ?4 = (
                       SELECT id FROM print_job_attempts
                       WHERE print_job_id = print_jobs.id
                       ORDER BY attempt_number DESC LIMIT 1
                   )",
                params![
                    output_path,
                    now,
                    attempt.identity.local_job_id,
                    attempt_id.to_string()
                ],
            )?,
            ParentTransition::RetryableFailure { error } => tx.execute(
                "UPDATE print_jobs
                 SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END,
                     retry_count = retry_count + 1,
                     last_error = ?1,
                     last_attempt_at = ?2,
                     next_retry_at = CASE
                         WHEN retry_count + 1 >= max_retries THEN NULL
                         ELSE datetime('now', '+' || (5 * (1 << MIN(retry_count, 4))) || ' seconds')
                     END,
                     completed_at = CASE
                         WHEN retry_count + 1 >= max_retries THEN ?2
                         ELSE NULL
                     END,
                     history_expires_at = CASE
                         WHEN retry_count + 1 >= max_retries THEN datetime(?2, '+30 days')
                         ELSE NULL
                     END,
                     updated_at = ?2
                 WHERE id = ?3 AND status = 'printing'
                   AND ?4 = (
                       SELECT id FROM print_job_attempts
                       WHERE print_job_id = print_jobs.id
                       ORDER BY attempt_number DESC LIMIT 1
                   )",
                params![
                    error,
                    now,
                    attempt.identity.local_job_id,
                    attempt_id.to_string()
                ],
            )?,
            ParentTransition::ManualFailure { error } => tx.execute(
                "UPDATE print_jobs
                 SET status = 'failed', retry_count = retry_count + 1,
                     last_error = ?1, last_attempt_at = ?2,
                     next_retry_at = NULL, completed_at = ?2,
                     history_expires_at = datetime(?2, '+30 days'),
                     updated_at = ?2
                 WHERE id = ?3 AND status = 'printing'
                   AND ?4 = (
                       SELECT id FROM print_job_attempts
                       WHERE print_job_id = print_jobs.id
                       ORDER BY attempt_number DESC LIMIT 1
                   )",
                params![
                    error,
                    now,
                    attempt.identity.local_job_id,
                    attempt_id.to_string()
                ],
            )?,
        };
        if parent_changed != 1 {
            return Ok(ApplyResult::NotApplied);
        }

        let result = transition_attempt(&tx, attempt_id, outcome, observation)?;
        if result == ApplyResult::NotApplied {
            return Ok(result);
        }
        let (transport, _) = transport_and_resolved(&lease.target);
        if opens_circuit {
            tx.execute(
                "INSERT INTO print_target_state
                 (target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at)
                 VALUES (?1, ?2, 'open', ?3, ?4, ?4)
                 ON CONFLICT(target_key) DO UPDATE SET
                     transport = excluded.transport,
                     circuit_state = 'open',
                     blocked_reason = excluded.blocked_reason,
                     blocked_at = excluded.blocked_at,
                     updated_at = excluded.updated_at",
                params![lease.normalized_key, transport, blocked_reason, now],
            )?;
        } else {
            tx.execute(
                "INSERT INTO print_target_state
                 (target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at)
                 VALUES (?1, ?2, 'closed', NULL, NULL, ?3)
                 ON CONFLICT(target_key) DO UPDATE SET
                     transport = excluded.transport,
                     circuit_state = 'closed', blocked_reason = NULL,
                     blocked_at = NULL, updated_at = excluded.updated_at
                 WHERE print_target_state.circuit_state <> 'open'",
                params![lease.normalized_key, transport, now],
            )?;
        }
        tx.commit()?;

        if opens_circuit {
            let mut lanes = self.lanes.lock().map_err(|_| DispatchError::LockPoisoned)?;
            if lanes.get(&lease.normalized_key) != Some(&LaneBlock::Held(lease.token)) {
                return Err(DispatchError::LaneBusy);
            }
            lanes.insert(
                lease.normalized_key.clone(),
                LaneBlock::OpenHeld(lease.token),
            );
        } else {
            lease.mark_terminal(outcome)?;
        }
        Ok(ApplyResult::Applied)
    }

    pub(crate) fn accept_windows_handoff(
        &self,
        conn: &Connection,
        lease: &AttemptLease,
        attempt_id: Uuid,
        output_path: &str,
        now: DateTime<Utc>,
    ) -> Result<ApplyResult, DispatchError> {
        if !Arc::ptr_eq(&self.lanes, &lease.lanes) {
            return Err(DispatchError::LeaseOwnershipMismatch);
        }
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        let attempt = read_attempt(&tx, attempt_id)?.ok_or(DispatchError::MissingAttempt)?;
        if normalize_target(&attempt.identity.target_key)? != lease.normalized_key {
            return Err(DispatchError::AttemptTargetMismatch);
        }
        if attempt.state != DispatchState::WindowsQueued {
            return Ok(ApplyResult::NotApplied);
        }
        let now = timestamp(now);
        let changed = tx.execute(
            "UPDATE print_jobs
             SET status = 'dispatched', output_path = ?1,
                 last_attempt_at = ?2, completed_at = ?2,
                 history_expires_at = datetime(?2, '+30 days'),
                 updated_at = ?2
             WHERE id = ?3 AND status = 'printing'
               AND EXISTS (
                   SELECT 1 FROM print_job_attempts
                   WHERE id = ?4 AND print_job_id = print_jobs.id
                     AND state = 'windows_queued'
                     AND attempt_number = (
                         SELECT MAX(latest.attempt_number)
                         FROM print_job_attempts latest
                         WHERE latest.print_job_id = print_jobs.id
                     )
               )",
            params![
                output_path,
                now,
                attempt.identity.local_job_id,
                attempt_id.to_string(),
            ],
        )?;
        if changed != 1 {
            return Ok(ApplyResult::NotApplied);
        }
        tx.commit()?;
        Ok(ApplyResult::Applied)
    }

    fn commit_reconciliation_transaction(
        &self,
        tx: Transaction<'_>,
        target: &PrinterTargetKey,
        now: DateTime<Utc>,
        cancel: &AtomicBool,
    ) -> Result<bool, DispatchError> {
        let normalized_key = normalize_target(target)?;
        let (transport, _) = transport_and_resolved(target);
        // Lock order is durable SQLite transaction -> lane registry, shared
        // with hydration. No path holds the lane mutex while acquiring a
        // SQLite transaction. Keeping this guard through COMMIT prevents a
        // claim or stale hydration snapshot from interleaving without changing
        // the in-memory lane value before the durable commit.
        #[cfg(test)]
        signal_before_reconciliation_lane_lock_for_test(&self.lanes, &normalized_key);
        let mut lanes = self.lanes.lock().map_err(|_| DispatchError::LockPoisoned)?;
        if cancel.load(Ordering::Acquire) {
            return Err(DispatchError::ReconciliationCancelled);
        }
        let retained = match lanes.get(&normalized_key).copied() {
            Some(LaneBlock::Held(_) | LaneBlock::OpenHeld(_)) => {
                return Err(DispatchError::LaneBusy);
            }
            Some(block @ (LaneBlock::Retained(_) | LaneBlock::OpenRetained(_))) => block,
            None => return Err(DispatchError::LaneNotRetained),
        };

        if target_has_reconciliation_blockers(&tx, target)? {
            if cancel.load(Ordering::Acquire) {
                return Err(DispatchError::ReconciliationCancelled);
            }
            tx.commit()?;
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO print_target_state
             (target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at)
             VALUES (?1, ?2, 'closed', NULL, NULL, ?3)
             ON CONFLICT(target_key) DO UPDATE SET
                 transport = excluded.transport,
                 circuit_state = 'closed',
                 blocked_reason = NULL,
                 blocked_at = NULL,
                 updated_at = excluded.updated_at",
            params![normalized_key, transport, timestamp(now)],
        )?;
        if cancel.load(Ordering::Acquire) {
            return Err(DispatchError::ReconciliationCancelled);
        }
        tx.commit()?;

        let removed = lanes.remove(&normalized_key);
        debug_assert_eq!(removed, Some(retained));
        Ok(true)
    }

    /// Release in-memory lanes that no durable blocker justifies any more.
    ///
    /// `AttemptLease::drop` parks an unreleased lane as `Retained`, and the only
    /// path that clears one runs through `reconcile_owned_windows_attempt_*`,
    /// which refuses anything that is not `transport = 'windows'` carrying a real
    /// spool id. A `raw_tcp` or `serial` lane that lands in `Retained` is
    /// therefore unreachable for the entire life of the process: every later
    /// `claim()` answers `LaneBusy`, `prepare_frozen_attempt` turns that into
    /// `Ok(None)`, and the job sits pending with no attempt row and no error to
    /// explain it. `hydrate` cannot help — it only ever inserts. A shop till
    /// printed nothing for fifteen hours that way after a single operator
    /// cancel, and only restarting the app cleared it.
    ///
    /// The durable tables are the authority, not this map. If nothing in
    /// `print_job_attempts` still blocks a target, its lane must not stay held,
    /// whatever transport it happens to use.
    ///
    /// Deliberately narrow: only `Retained`/`OpenRetained` are candidates, never
    /// `Held` — a held lane belongs to a worker that is running right now. The
    /// state is re-read under the lane lock before removal for that same reason.
    /// Lock order matches the rest of this module: SQLite transaction first,
    /// lane registry second, and the registry guard is kept across COMMIT so a
    /// claim cannot interleave.
    pub(crate) fn sweep_orphaned_lanes(
        &self,
        conn: &Connection,
        now: DateTime<Utc>,
    ) -> Result<Vec<String>, DispatchError> {
        let candidates: Vec<String> = {
            let lanes = self.lanes.lock().map_err(|_| DispatchError::LockPoisoned)?;
            lanes
                .iter()
                .filter(|(_, block)| {
                    matches!(block, LaneBlock::Retained(_) | LaneBlock::OpenRetained(_))
                })
                .map(|(key, _)| key.clone())
                .collect()
        };
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        let blocked: std::collections::HashSet<String> = active_target_blockers(&tx)?
            .into_iter()
            .map(|(key, _)| key)
            .collect();

        let mut released = Vec::new();
        {
            let mut lanes = self.lanes.lock().map_err(|_| DispatchError::LockPoisoned)?;
            for key in candidates {
                if blocked.contains(&key) {
                    continue;
                }
                match lanes.get(&key).copied() {
                    Some(LaneBlock::Retained(_) | LaneBlock::OpenRetained(_)) => {}
                    // Claimed, or already gone, since the snapshot above.
                    _ => continue,
                }
                // UPDATE, not UPSERT: without a row there is no circuit to close,
                // and this avoids having to reconstruct a PrinterTargetKey (and
                // its transport) from a normalized key string.
                tx.execute(
                    "UPDATE print_target_state
                     SET circuit_state = 'closed',
                         blocked_reason = NULL,
                         blocked_at = NULL,
                         updated_at = ?2
                     WHERE target_key = ?1",
                    params![key, timestamp(now)],
                )?;
                lanes.remove(&key);
                released.push(key);
            }
            tx.commit()?;
        }

        Ok(released)
    }

    /// Test seam over the live reconciliation commit.
    ///
    /// The body is `commit_reconciliation_transaction` -- the same private routine
    /// production drives through `reconcile_owned_windows_attempt` -- so tests written
    /// against this exercise real behaviour, not a copy. It exists only because that
    /// routine takes an open `Transaction` and a cancellation flag, which a unit test has
    /// no reason to construct. Production does not use it: it needs the released/blocked
    /// result as a value, plus the cancellation and target-blocking handling this wrapper
    /// discards.
    #[cfg(test)]
    pub(crate) fn reconcile(
        &self,
        conn: &Connection,
        target: &PrinterTargetKey,
        now: DateTime<Utc>,
    ) -> Result<(), DispatchError> {
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        if self.commit_reconciliation_transaction(tx, target, now, &AtomicBool::new(false))? {
            Ok(())
        } else {
            Err(DispatchError::TargetStillBlocked)
        }
    }
}

pub(crate) struct AttemptLease {
    lanes: Arc<Mutex<HashMap<String, LaneBlock>>>,
    target: PrinterTargetKey,
    normalized_key: String,
    token: Uuid,
    release_on_drop: bool,
}

impl AttemptLease {
    pub(crate) fn release_unstarted(&mut self) {
        self.release_on_drop = true;
    }

    fn mark_terminal(&mut self, outcome: DispatchState) -> Result<(), DispatchError> {
        if !outcome.is_terminal() {
            return Err(DispatchError::InvalidLaneOutcome);
        }
        self.release_on_drop = true;
        Ok(())
    }
}

impl Drop for AttemptLease {
    fn drop(&mut self) {
        let Ok(mut lanes) = self.lanes.lock() else {
            return;
        };
        if self.release_on_drop
            && lanes.get(&self.normalized_key) == Some(&LaneBlock::Held(self.token))
        {
            lanes.remove(&self.normalized_key);
        } else if !self.release_on_drop
            && lanes.get(&self.normalized_key) == Some(&LaneBlock::Held(self.token))
        {
            lanes.insert(self.normalized_key.clone(), LaneBlock::Retained(self.token));
        } else if !self.release_on_drop
            && lanes.get(&self.normalized_key) == Some(&LaneBlock::OpenHeld(self.token))
        {
            lanes.insert(
                self.normalized_key.clone(),
                LaneBlock::OpenRetained(self.token),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use rusqlite::{params, Connection};
    use std::sync::{atomic::AtomicBool, Arc, Mutex};
    use std::time::Duration;

    type TraceGate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    static TRACE_GATE: std::sync::OnceLock<std::sync::Mutex<Option<TraceGate>>> =
        std::sync::OnceLock::new();
    static TRACE_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    static CREATE_INSERT_GATE: std::sync::OnceLock<std::sync::Mutex<Option<TraceGate>>> =
        std::sync::OnceLock::new();
    static HYDRATION_RACE_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> =
        std::sync::OnceLock::new();
    static RECONCILIATION_CANCEL_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> =
        std::sync::OnceLock::new();
    static RECONCILIATION_DB_BUSY_SIGNAL: std::sync::OnceLock<
        std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
    > = std::sync::OnceLock::new();

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum HydrationRaceEvent {
        ReconciliationBlocked,
        ReconciliationCompleted,
    }

    static HYDRATION_RECONCILIATION_BUSY_SIGNAL: std::sync::OnceLock<
        std::sync::Mutex<Option<std::sync::mpsc::Sender<HydrationRaceEvent>>>,
    > = std::sync::OnceLock::new();

    fn signal_hydration_reconciliation_busy(_attempts: i32) -> bool {
        if let Some(sender) = HYDRATION_RECONCILIATION_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap()
            .take()
        {
            sender
                .send(HydrationRaceEvent::ReconciliationBlocked)
                .unwrap();
        }
        true
    }

    fn signal_reconciliation_db_busy(_attempts: i32) -> bool {
        if let Some(sender) = RECONCILIATION_DB_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap()
            .take()
        {
            sender.send(()).unwrap();
        }
        true
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum PreCommitLaneObservation {
        Retained,
        RegistryLocked,
        Changed,
    }

    struct PreCommitLaneProbe {
        lanes: LaneRegistry,
        normalized_key: String,
        observation: Option<PreCommitLaneObservation>,
    }

    static PRE_COMMIT_LANE_PROBE: std::sync::OnceLock<
        std::sync::Mutex<Option<PreCommitLaneProbe>>,
    > = std::sync::OnceLock::new();

    fn observe_lane_during_circuit_close(sql: &str) {
        if !sql
            .trim_start()
            .starts_with("INSERT INTO print_target_state")
        {
            return;
        }
        let probe_slot = PRE_COMMIT_LANE_PROBE.get_or_init(|| std::sync::Mutex::new(None));
        let mut probe_slot = probe_slot.lock().unwrap();
        let Some(probe) = probe_slot.as_mut() else {
            return;
        };
        if probe.observation.is_some() {
            return;
        }
        let lanes = Arc::clone(&probe.lanes);
        let normalized_key = probe.normalized_key.clone();
        probe.observation = Some(match lanes.try_lock() {
            Ok(lanes) => match lanes.get(&normalized_key) {
                Some(LaneBlock::Retained(_) | LaneBlock::OpenRetained(_)) => {
                    PreCommitLaneObservation::Retained
                }
                _ => PreCommitLaneObservation::Changed,
            },
            Err(std::sync::TryLockError::WouldBlock) => PreCommitLaneObservation::RegistryLocked,
            Err(std::sync::TryLockError::Poisoned(_)) => PreCommitLaneObservation::Changed,
        });
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CreateEvent {
        Blocked,
        Completed,
    }

    static CREATE_BUSY_SIGNAL: std::sync::OnceLock<
        std::sync::Mutex<Option<std::sync::mpsc::Sender<CreateEvent>>>,
    > = std::sync::OnceLock::new();

    fn pause_before_attempt_update(sql: &str) {
        if !sql.trim_start().starts_with("UPDATE print_job_attempts") {
            return;
        }
        let gate = TRACE_GATE.get_or_init(|| std::sync::Mutex::new(None));
        let Some((reached, release)) = gate.lock().unwrap().take() else {
            return;
        };
        reached.send(()).unwrap();
        release.recv().unwrap();
    }

    fn pause_before_attempt_insert(sql: &str) {
        if !sql
            .trim_start()
            .starts_with("INSERT INTO print_job_attempts")
        {
            return;
        }
        let gate = CREATE_INSERT_GATE.get_or_init(|| std::sync::Mutex::new(None));
        let Some((reached, release)) = gate.lock().unwrap().take() else {
            return;
        };
        reached.send(()).unwrap();
        release.recv().unwrap();
    }

    fn signal_create_busy(_attempts: i32) -> bool {
        if let Some(sender) = CREATE_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap()
            .take()
        {
            sender.send(CreateEvent::Blocked).unwrap();
        }
        true
    }

    struct IsolatedDbFile {
        path: std::path::PathBuf,
    }

    impl IsolatedDbFile {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "the-small-print-dispatch-{}-{}.sqlite",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let conn = Connection::open(&path).expect("open isolated file database");
            crate::db::run_migrations_for_test(&conn);
            drop(conn);
            Self { path }
        }

        fn open(&self) -> Connection {
            let conn = Connection::open(&self.path).expect("open isolated test connection");
            conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
                .unwrap();
            conn
        }
    }

    impl Drop for IsolatedDbFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(self.path.with_extension("sqlite-wal"));
            let _ = std::fs::remove_file(self.path.with_extension("sqlite-shm"));
        }
    }

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open isolated database");
        crate::db::run_migrations_for_test(&conn);
        conn
    }

    fn insert_job(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO print_jobs (id, entity_type, entity_id, status, created_at, updated_at)
             VALUES (?1, 'order_receipt', 'entity', 'pending', '2026-08-06T10:00:00Z', '2026-08-06T10:00:00Z')",
            [id],
        )
        .expect("insert print job");
    }

    fn at(second: u32) -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 6, 10, 0, second)
            .single()
            .expect("valid time")
    }

    fn new_windows_attempt(conn: &Connection, job_id: &str, second: u32) -> AttemptIdentity {
        create_attempt(
            conn,
            NewAttempt {
                local_job_id: job_id.to_owned(),
                target: PrinterTargetKey::WindowsQueue("Front".into()),
                document_kind: "receipt".into(),
                bytes_requested: 100,
                now: at(second),
            },
        )
        .unwrap()
    }

    fn observation(second: u32) -> AttemptObservation {
        AttemptObservation {
            now: at(second),
            ..AttemptObservation::default()
        }
    }

    fn assert_parent_history_at(
        conn: &Connection,
        job_id: &str,
        expected_status: &str,
        expected_at: &str,
    ) {
        let expected_expires: String = conn
            .query_row("SELECT datetime(?1, '+30 days')", [expected_at], |row| {
                row.get(0)
            })
            .unwrap();
        let row: (String, String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, updated_at, completed_at, history_expires_at
                 FROM print_jobs WHERE id = ?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(row.0, expected_status);
        assert_eq!(row.1, expected_at);
        assert_eq!(row.2.as_deref(), Some(expected_at));
        assert_eq!(row.3.as_deref(), Some(expected_expires.as_str()));
    }

    fn assert_parent_pending_history_at(conn: &Connection, job_id: &str, expected_at: &str) {
        let row: (String, String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, updated_at, completed_at, history_expires_at
                 FROM print_jobs WHERE id = ?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(row, ("pending".into(), expected_at.into(), None, None));
    }

    fn prepared_raw_attempt(
        conn: &Connection,
        job_id: &str,
        host: &str,
        max_retries: i64,
        second: u32,
    ) -> (DispatchManager, AttemptLease, AttemptIdentity) {
        insert_job(conn, job_id);
        conn.execute(
            "UPDATE print_jobs SET max_retries = ?1 WHERE id = ?2",
            params![max_retries, job_id],
        )
        .unwrap();
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::RawTcp {
            host: host.into(),
            port: 9100,
        };
        let lease = manager.claim(target.clone()).unwrap();
        let attempt = prepare_managed_attempt(
            conn,
            PrepareManagedAttempt {
                local_job_id: job_id.into(),
                printer_profile_id: "profile".into(),
                target,
                document_kind: "order_receipt".into(),
                payload: vec![1, 2, 3],
                render_profile_snapshot_json: r#"{"version":1}"#.into(),
                now: at(second),
            },
        )
        .unwrap();
        transition_attempt(
            conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(second + 1),
        )
        .unwrap();
        (manager, lease, attempt)
    }

    /// A leaked raw lane used to be a life sentence.
    ///
    /// AttemptLease::drop parks an unreleased lane as Retained, and the only
    /// clearing path is Windows-only, so a raw_tcp lane stuck there was
    /// unreachable for the whole process: claim() answered LaneBusy forever and
    /// the dispatcher deferred every job in silence. A till printed nothing for
    /// fifteen hours that way.
    #[test]
    fn sweep_releases_a_retained_raw_lane_with_no_durable_blocker() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, lease, attempt) = prepared_raw_attempt(&conn, &job_id, "10.0.0.5", 3, 1);
        let target = PrinterTargetKey::RawTcp {
            host: "10.0.0.5".into(),
            port: 9100,
        };
        let key = normalize_target(&target).unwrap();

        // Nothing durable justifies the lane any more...
        conn.execute(
            "DELETE FROM print_job_attempts WHERE id = ?1",
            params![attempt.attempt_id.to_string()],
        )
        .unwrap();
        // ...but the lease drops without releasing, which is the leak itself.
        drop(lease);
        assert!(
            matches!(
                manager.lanes.lock().unwrap().get(&key),
                Some(LaneBlock::Retained(_))
            ),
            "precondition: the drop must have retained the lane"
        );

        let released = manager.sweep_orphaned_lanes(&conn, at(9)).unwrap();

        assert_eq!(released, vec![key.clone()]);
        assert!(
            manager.lanes.lock().unwrap().get(&key).is_none(),
            "the lane must be claimable again"
        );
        assert!(
            manager.claim(target).is_ok(),
            "a swept lane must accept the next job"
        );
    }

    /// The durable tables are the authority in BOTH directions: a lane whose
    /// attempt still blocks it must survive the sweep untouched.
    #[test]
    fn sweep_keeps_a_retained_lane_whose_attempt_still_blocks() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, lease, _attempt) = prepared_raw_attempt(&conn, &job_id, "10.0.0.6", 3, 1);
        let key = normalize_target(&PrinterTargetKey::RawTcp {
            host: "10.0.0.6".into(),
            port: 9100,
        })
        .unwrap();

        // The attempt row stays: it is still Submitting, so it still blocks.
        drop(lease);

        let released = manager.sweep_orphaned_lanes(&conn, at(9)).unwrap();

        assert!(released.is_empty(), "a justified lane must not be released");
        assert!(
            matches!(
                manager.lanes.lock().unwrap().get(&key),
                Some(LaneBlock::Retained(_))
            ),
            "the lane must stay retained while its attempt blocks it"
        );
    }

    /// Held means a worker is printing RIGHT NOW. Sweeping that would hand the
    /// same printer to a second job mid-write.
    #[test]
    fn sweep_never_touches_a_held_lane() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, lease, attempt) = prepared_raw_attempt(&conn, &job_id, "10.0.0.7", 3, 1);
        let key = normalize_target(&PrinterTargetKey::RawTcp {
            host: "10.0.0.7".into(),
            port: 9100,
        })
        .unwrap();

        // No durable blocker, so only the Held state protects it.
        conn.execute(
            "DELETE FROM print_job_attempts WHERE id = ?1",
            params![attempt.attempt_id.to_string()],
        )
        .unwrap();

        let released = manager.sweep_orphaned_lanes(&conn, at(9)).unwrap();

        assert!(released.is_empty(), "a held lane is in use, not orphaned");
        assert!(
            matches!(
                manager.lanes.lock().unwrap().get(&key),
                Some(LaneBlock::Held(_))
            ),
            "the live worker must keep its lane"
        );
        drop(lease);
    }

    #[derive(Default)]
    struct ScriptedControlSpooler {
        snapshot: Mutex<Option<crate::windows_spooler::SpoolJobSnapshot>>,
        get_job_calls: Mutex<Vec<(String, u32)>>,
        controls: Mutex<Vec<(String, u32, crate::windows_spooler::SpoolJobControl)>>,
    }

    impl ScriptedControlSpooler {
        fn with_snapshot(snapshot: Option<crate::windows_spooler::SpoolJobSnapshot>) -> Self {
            Self {
                snapshot: Mutex::new(snapshot),
                ..Self::default()
            }
        }
    }

    impl crate::windows_spooler::WindowsSpooler for ScriptedControlSpooler {
        fn submit_raw(
            &self,
            _request: crate::windows_spooler::WindowsRawRequest,
            _cancel: &AtomicBool,
            _on_started: &mut dyn FnMut(
                &crate::windows_spooler::SpoolStarted,
            )
                -> Result<(), crate::windows_spooler::SpoolerError>,
        ) -> Result<crate::windows_spooler::SpoolSubmission, crate::windows_spooler::SpoolerError>
        {
            unreachable!("control tests never submit")
        }

        fn get_job(
            &self,
            printer_name: &str,
            job_id: u32,
        ) -> Result<
            Option<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            self.get_job_calls
                .lock()
                .unwrap()
                .push((printer_name.to_owned(), job_id));
            Ok(self.snapshot.lock().unwrap().clone())
        }

        fn enum_jobs(
            &self,
            _printer_name: &str,
        ) -> Result<
            Vec<crate::windows_spooler::SpoolJobSnapshot>,
            crate::windows_spooler::SpoolerError,
        > {
            unreachable!("control tests use exact GetJob only")
        }

        fn control_job(
            &self,
            printer_name: &str,
            job_id: u32,
            control: crate::windows_spooler::SpoolJobControl,
        ) -> Result<(), crate::windows_spooler::SpoolerError> {
            self.controls
                .lock()
                .unwrap()
                .push((printer_name.to_owned(), job_id, control));
            Ok(())
        }
    }

    fn queued_windows_attempt(
        conn: &Connection,
        queue: &str,
        job_id: u32,
        second: u32,
    ) -> AttemptIdentity {
        let local_job_id = Uuid::new_v4().to_string();
        insert_job(conn, &local_job_id);
        let attempt = create_attempt(
            conn,
            NewAttempt {
                local_job_id,
                target: PrinterTargetKey::WindowsQueue(queue.to_owned()),
                document_kind: "receipt".into(),
                bytes_requested: 10,
                now: at(second),
            },
        )
        .unwrap();
        assert_eq!(
            transition_attempt(
                conn,
                attempt.attempt_id,
                DispatchState::Submitting,
                observation(second + 1),
            )
            .unwrap(),
            ApplyResult::Applied
        );
        let document_name = read_attempt(conn, attempt.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        assert_eq!(
            persist_spool_started(
                conn,
                attempt.attempt_id,
                &crate::windows_spooler::SpoolStarted {
                    job_id,
                    printer_name: queue.to_owned(),
                    document_name,
                    submitted_at: at(second + 2),
                },
            )
            .unwrap(),
            ApplyResult::Applied
        );
        attempt
    }

    fn native_snapshot(
        queue: &str,
        job_id: u32,
        document_name: String,
    ) -> crate::windows_spooler::SpoolJobSnapshot {
        crate::windows_spooler::SpoolJobSnapshot {
            job_id,
            printer_name: queue.to_owned(),
            document_name,
            status_text: Some("Spooling".into()),
            status_bits: 0x0000_0008,
            position: 1,
            total_pages: 1,
            pages_printed: 0,
        }
    }

    #[test]
    fn exact_owned_delete_is_requested_but_not_confirmed() {
        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Front Queue", 73, 0);
        assert_eq!(
            transition_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::CancelRequested,
                observation(3),
            )
            .unwrap(),
            ApplyResult::Applied
        );
        let stored = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        let spooler = ScriptedControlSpooler::with_snapshot(Some(native_snapshot(
            "Front Queue",
            73,
            stored.document_name.clone(),
        )));

        let result = control_owned_windows_attempt(
            &conn,
            &spooler,
            attempt.attempt_id,
            crate::windows_spooler::SpoolJobControl::Delete,
            at(4),
        )
        .unwrap();

        assert_eq!(result, OwnedWindowsControlResult::Requested);
        assert_eq!(
            spooler.get_job_calls.lock().unwrap().as_slice(),
            &[("Front Queue".to_owned(), 73)]
        );
        assert_eq!(
            spooler.controls.lock().unwrap().as_slice(),
            &[(
                "Front Queue".to_owned(),
                73,
                crate::windows_spooler::SpoolJobControl::Delete,
            )]
        );
        let after = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        assert_eq!(after.state, DispatchState::CancelRequested);
        assert_eq!(after.cancel_confirmed_at, None);
    }

    #[test]
    fn mismatched_reused_or_missing_native_identity_never_reaches_set_job() {
        let cases = ["queue", "job_id", "document", "missing"];
        for case in cases {
            let conn = test_db();
            let attempt = queued_windows_attempt(&conn, "Front Queue", 73, 0);
            let stored = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
            let snapshot = match case {
                "queue" => Some(native_snapshot(
                    "Other Queue",
                    73,
                    stored.document_name.clone(),
                )),
                "job_id" => Some(native_snapshot(
                    "Front Queue",
                    74,
                    stored.document_name.clone(),
                )),
                "document" => Some(native_snapshot(
                    "Front Queue",
                    73,
                    crate::windows_spooler::format_document_marker(
                        Uuid::new_v4(),
                        Uuid::new_v4(),
                        "receipt",
                    )
                    .unwrap(),
                )),
                "missing" => None,
                _ => unreachable!(),
            };
            let spooler = ScriptedControlSpooler::with_snapshot(snapshot);

            let result = control_owned_windows_attempt(
                &conn,
                &spooler,
                attempt.attempt_id,
                crate::windows_spooler::SpoolJobControl::Pause,
                at(4),
            )
            .unwrap();

            assert!(matches!(
                result,
                OwnedWindowsControlResult::OwnershipNotConfirmed { .. }
            ));
            assert!(spooler.controls.lock().unwrap().is_empty(), "case={case}");
        }
    }

    #[test]
    fn older_active_owned_attempt_is_controllable_and_reconcilable_after_newer_terminal_epoch() {
        let conn = test_db();
        let attempt_a = queued_windows_attempt(&conn, "Front Queue", 73, 0);
        let stored_a = read_attempt(&conn, attempt_a.attempt_id).unwrap().unwrap();
        let attempt_b = create_attempt(
            &conn,
            NewAttempt {
                local_job_id: attempt_a.local_job_id.clone(),
                target: PrinterTargetKey::WindowsQueue("Front Queue".into()),
                document_kind: "receipt".into(),
                bytes_requested: 10,
                now: at(4),
            },
        )
        .unwrap();
        assert!(attempt_b.attempt_number > attempt_a.attempt_number);
        assert_eq!(
            transition_attempt(
                &conn,
                attempt_b.attempt_id,
                DispatchState::Submitting,
                observation(5),
            )
            .unwrap(),
            ApplyResult::Applied
        );
        assert_eq!(
            transition_attempt(
                &conn,
                attempt_b.attempt_id,
                DispatchState::Sent,
                observation(6),
            )
            .unwrap(),
            ApplyResult::Applied
        );
        let stale_spooler = ScriptedControlSpooler::with_snapshot(Some(native_snapshot(
            "Front Queue",
            73,
            stored_a.document_name.clone(),
        )));
        assert_eq!(
            control_owned_windows_attempt(
                &conn,
                &stale_spooler,
                attempt_a.attempt_id,
                crate::windows_spooler::SpoolJobControl::Pause,
                at(7),
            )
            .unwrap(),
            OwnedWindowsControlResult::Requested
        );
        assert_eq!(
            stale_spooler.controls.lock().unwrap().as_slice(),
            &[(
                "Front Queue".to_owned(),
                73,
                crate::windows_spooler::SpoolJobControl::Pause,
            )]
        );

        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        let reconciliation = reconcile_owned_windows_attempt(
            &conn,
            &manager,
            &stale_spooler,
            attempt_a.attempt_id,
            at(8),
        )
        .unwrap();
        assert!(matches!(
            reconciliation.outcome,
            OwnedWindowsReconcileOutcome::Active(DispatchState::WindowsQueued)
        ));
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&attempt_a.local_job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "pending",
            "an older native observation must not overwrite the newer terminal epoch"
        );

        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Front Queue", 81, 0);
        let wrong_attempt = Uuid::new_v4();
        let wrong_marker = crate::windows_spooler::format_document_marker(
            Uuid::parse_str(&attempt.local_job_id).unwrap(),
            wrong_attempt,
            "receipt",
        )
        .unwrap();
        conn.execute(
            "UPDATE print_job_attempts SET document_name = ?1 WHERE id = ?2",
            params![wrong_marker, attempt.attempt_id.to_string()],
        )
        .unwrap();
        let corrupt_spooler = ScriptedControlSpooler::with_snapshot(Some(native_snapshot(
            "Front Queue",
            81,
            wrong_marker,
        )));
        assert!(matches!(
            control_owned_windows_attempt(
                &conn,
                &corrupt_spooler,
                attempt.attempt_id,
                crate::windows_spooler::SpoolJobControl::Pause,
                at(5),
            )
            .unwrap(),
            OwnedWindowsControlResult::OwnershipNotConfirmed { .. }
        ));
        assert!(corrupt_spooler.controls.lock().unwrap().is_empty());
    }

    #[test]
    fn terminal_windows_attempt_is_refused_before_native_control() {
        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Front Queue", 73, 0);
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::SpoolCompleted,
            observation(3),
        )
        .unwrap();
        let stored = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        let spooler = ScriptedControlSpooler::with_snapshot(Some(native_snapshot(
            "Front Queue",
            73,
            stored.document_name,
        )));

        let result = control_owned_windows_attempt(
            &conn,
            &spooler,
            attempt.attempt_id,
            crate::windows_spooler::SpoolJobControl::Pause,
            at(4),
        )
        .unwrap();

        assert!(matches!(
            result,
            OwnedWindowsControlResult::OwnershipNotConfirmed { .. }
        ));
        assert!(spooler.get_job_calls.lock().unwrap().is_empty());
        assert!(spooler.controls.lock().unwrap().is_empty());
    }

    #[test]
    fn reconciliation_confirms_cancel_only_after_exact_owned_job_is_absent() {
        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Front Queue", 73, 0);
        conn.execute(
            "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
            [&attempt.local_job_id],
        )
        .unwrap();
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::CancelRequested,
            observation(3),
        )
        .unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        let spooler = ScriptedControlSpooler::with_snapshot(None);

        let result =
            reconcile_owned_windows_attempt(&conn, &manager, &spooler, attempt.attempt_id, at(4))
                .unwrap();

        assert_eq!(
            result,
            OwnedWindowsReconcileResult {
                outcome: OwnedWindowsReconcileOutcome::CancellationConfirmed,
                target_released: true,
            }
        );
        let after = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        assert_eq!(after.state, DispatchState::Cancelled);
        assert!(after.cancel_requested_at.is_some());
        assert!(after.cancel_confirmed_at.is_some());
        let parent: String = conn
            .query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&attempt.local_job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent, "cancelled");
        assert!(manager
            .claim(PrinterTargetKey::WindowsQueue("Front Queue".into()))
            .is_ok());
    }

    #[test]
    fn older_cancel_confirmation_keeps_parent_open_while_newer_attempt_is_active() {
        let conn = test_db();
        let first = queued_windows_attempt(&conn, "Front Queue", 73, 0);
        conn.execute(
            "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
            [&first.local_job_id],
        )
        .unwrap();
        transition_attempt(
            &conn,
            first.attempt_id,
            DispatchState::CancelRequested,
            observation(3),
        )
        .unwrap();
        let second = create_attempt(
            &conn,
            NewAttempt {
                local_job_id: first.local_job_id.clone(),
                target: PrinterTargetKey::WindowsQueue("Front Queue".into()),
                document_kind: "receipt".into(),
                bytes_requested: 10,
                now: at(4),
            },
        )
        .unwrap();
        transition_attempt(
            &conn,
            second.attempt_id,
            DispatchState::Submitting,
            observation(5),
        )
        .unwrap();
        let second_marker = read_attempt(&conn, second.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        persist_spool_started(
            &conn,
            second.attempt_id,
            &crate::windows_spooler::SpoolStarted {
                job_id: 74,
                printer_name: "Front Queue".into(),
                document_name: second_marker,
                submitted_at: at(6),
            },
        )
        .unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        let absent = ScriptedControlSpooler::with_snapshot(None);

        let result =
            reconcile_owned_windows_attempt(&conn, &manager, &absent, first.attempt_id, at(7))
                .unwrap();

        assert!(matches!(
            result.outcome,
            OwnedWindowsReconcileOutcome::CancellationConfirmed
        ));
        assert!(!result.target_released);
        assert_eq!(
            read_attempt(&conn, first.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Cancelled
        );
        assert_eq!(
            read_attempt(&conn, second.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::WindowsQueued
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&first.local_job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "dispatched"
        );
    }

    #[test]
    fn normal_native_absence_completes_transport_without_rewriting_dispatched_parent() {
        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Front Queue", 74, 0);
        conn.execute(
            "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
            [&attempt.local_job_id],
        )
        .unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        let spooler = ScriptedControlSpooler::with_snapshot(None);

        let result =
            reconcile_owned_windows_attempt(&conn, &manager, &spooler, attempt.attempt_id, at(4))
                .unwrap();

        assert_eq!(result.outcome, OwnedWindowsReconcileOutcome::SpoolCompleted);
        assert!(result.target_released);
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::SpoolCompleted
        );
        let parent: String = conn
            .query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&attempt.local_job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent, "dispatched");
    }

    #[test]
    fn hydration_snapshot_gate_ignores_a_parallel_decoy_registry() {
        let _serial = HYDRATION_RACE_TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let intended_database = IsolatedDbFile::new();
        let decoy_database = IsolatedDbFile::new();
        let intended_lanes = DispatchManager::isolated_for_test().lanes;
        let decoy_lanes = DispatchManager::isolated_for_test().lanes;
        let (snapshot_reached_tx, snapshot_reached_rx) = std::sync::mpsc::channel();
        let (release_snapshot_tx, release_snapshot_rx) = std::sync::mpsc::channel();
        // Pre-release both possible consumers so the RED implementation cannot
        // strand the decoy if it incorrectly steals this gate.
        release_snapshot_tx.send(()).unwrap();
        release_snapshot_tx.send(()).unwrap();
        let _snapshot_gate = install_hydration_snapshot_gate_for_test(
            &intended_lanes,
            snapshot_reached_tx,
            release_snapshot_rx,
        );

        let decoy_conn = decoy_database.open();
        let decoy = std::thread::spawn(move || {
            DispatchManager::hydrate_with_registry(&decoy_conn, decoy_lanes)
        });
        decoy.join().unwrap().unwrap();
        let decoy_signal = snapshot_reached_rx.try_recv();

        let intended_conn = intended_database.open();
        let intended = std::thread::spawn(move || {
            DispatchManager::hydrate_with_registry(&intended_conn, intended_lanes)
        });
        intended.join().unwrap().unwrap();
        let intended_signal = snapshot_reached_rx.try_recv();

        assert_eq!(
            decoy_signal,
            Err(std::sync::mpsc::TryRecvError::Empty),
            "a hydration on another lane registry must not consume the scoped gate"
        );
        assert_eq!(
            intended_signal,
            Ok(()),
            "the intended lane registry must still reach the scoped gate exactly once"
        );
        assert_eq!(
            snapshot_reached_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
    }

    #[test]
    fn stale_hydration_snapshot_cannot_resurrect_a_reconciled_target_lane() {
        let _serial = HYDRATION_RACE_TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap();
        let database = IsolatedDbFile::new();
        let setup_conn = database.open();
        let attempt = queued_windows_attempt(&setup_conn, "Hydration Race", 174, 0);
        let target = PrinterTargetKey::WindowsQueue("Hydration Race".into());
        let manager = DispatchManager::hydrate_isolated_for_test(&setup_conn).unwrap();

        let (snapshot_reached_tx, snapshot_reached_rx) = std::sync::mpsc::channel();
        let (release_snapshot_tx, release_snapshot_rx) = std::sync::mpsc::channel();
        let _snapshot_gate = install_hydration_snapshot_gate_for_test(
            &manager.lanes,
            snapshot_reached_tx,
            release_snapshot_rx,
        );

        let hydration_conn = database.open();
        let hydration_lanes = Arc::clone(&manager.lanes);
        let hydrator = std::thread::spawn(move || {
            DispatchManager::hydrate_with_registry(&hydration_conn, hydration_lanes)
        });
        snapshot_reached_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("hydration must pause after taking its durable snapshot");

        let (event_tx, event_rx) = std::sync::mpsc::channel();
        *HYDRATION_RECONCILIATION_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some(event_tx.clone());
        let reconciliation_conn = database.open();
        reconciliation_conn
            .busy_handler(Some(signal_hydration_reconciliation_busy))
            .unwrap();
        let reconciliation_manager = manager.clone();
        let reconciliation = std::thread::spawn(move || {
            let spooler = ScriptedControlSpooler::with_snapshot(None);
            let result = reconcile_owned_windows_attempt(
                &reconciliation_conn,
                &reconciliation_manager,
                &spooler,
                attempt.attempt_id,
                at(4),
            );
            event_tx
                .send(HydrationRaceEvent::ReconciliationCompleted)
                .unwrap();
            result
        });

        let first_event = event_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("reconciliation must either block or complete");
        release_snapshot_tx.send(()).unwrap();
        let hydrated = hydrator.join().unwrap().unwrap();
        let reconciled = reconciliation.join().unwrap().unwrap();
        *HYDRATION_RECONCILIATION_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = None;

        assert_eq!(
            first_event,
            HydrationRaceEvent::ReconciliationBlocked,
            "reconciliation must serialize behind the hydration snapshot"
        );
        assert_eq!(
            reconciled.outcome,
            OwnedWindowsReconcileOutcome::SpoolCompleted
        );
        assert!(reconciled.target_released);
        drop(hydrated);
        let mut lease = manager
            .claim(target)
            .expect("reconciled target must remain claimable after hydration completes");
        lease.release_unstarted();
    }

    #[test]
    fn reconciliation_lane_signal_ignores_a_parallel_decoy_registry_and_target() {
        let _serial = RECONCILIATION_CANCEL_TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let intended_database = IsolatedDbFile::new();
        let intended_setup = intended_database.open();
        let intended_attempt =
            queued_windows_attempt(&intended_setup, "Intended Lane Gate", 177, 0);
        intended_setup
            .execute(
                "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
                [&intended_attempt.local_job_id],
            )
            .unwrap();
        let intended_target = PrinterTargetKey::WindowsQueue("Intended Lane Gate".into());
        let intended_target_key = normalize_target(&intended_target).unwrap();
        let intended_manager = DispatchManager::hydrate_isolated_for_test(&intended_setup).unwrap();

        let decoy_database = IsolatedDbFile::new();
        let decoy_setup = decoy_database.open();
        let decoy_attempt = queued_windows_attempt(&decoy_setup, "Decoy Lane Gate", 178, 10);
        decoy_setup
            .execute(
                "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
                [&decoy_attempt.local_job_id],
            )
            .unwrap();
        let decoy_manager = DispatchManager::hydrate_isolated_for_test(&decoy_setup).unwrap();

        let (lane_wait_tx, lane_wait_rx) = std::sync::mpsc::channel();
        let _lane_wait_signal = install_reconciliation_lane_wait_signal_for_test(
            &intended_manager.lanes,
            &intended_target_key,
            lane_wait_tx,
        );

        let decoy_conn = decoy_database.open();
        let decoy_manager_worker = decoy_manager.clone();
        let decoy = std::thread::spawn(move || {
            reconcile_owned_windows_attempt(
                &decoy_conn,
                &decoy_manager_worker,
                &ScriptedControlSpooler::with_snapshot(None),
                decoy_attempt.attempt_id,
                at(14),
            )
        });
        let decoy_result = decoy.join().unwrap().unwrap();
        let decoy_signal = lane_wait_rx.try_recv();

        let intended_conn = intended_database.open();
        let intended_manager_worker = intended_manager.clone();
        let intended = std::thread::spawn(move || {
            reconcile_owned_windows_attempt(
                &intended_conn,
                &intended_manager_worker,
                &ScriptedControlSpooler::with_snapshot(None),
                intended_attempt.attempt_id,
                at(4),
            )
        });
        let intended_result = intended.join().unwrap().unwrap();
        let intended_signal = lane_wait_rx.try_recv();

        assert_eq!(
            decoy_result.outcome,
            OwnedWindowsReconcileOutcome::SpoolCompleted
        );
        assert!(decoy_result.target_released);
        assert_eq!(
            intended_result.outcome,
            OwnedWindowsReconcileOutcome::SpoolCompleted
        );
        assert!(intended_result.target_released);
        assert_eq!(
            decoy_signal,
            Err(std::sync::mpsc::TryRecvError::Empty),
            "another registry and target must not consume the scoped lane signal"
        );
        assert_eq!(
            intended_signal,
            Ok(()),
            "the intended registry and target must still reach the lane signal exactly once"
        );
        assert_eq!(
            lane_wait_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
    }

    #[test]
    fn cancellation_while_begin_immediate_waits_has_no_late_reconciliation_effects() {
        let _serial = RECONCILIATION_CANCEL_TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let database = IsolatedDbFile::new();
        let setup_conn = database.open();
        let attempt = queued_windows_attempt(&setup_conn, "Cancelled DB Wait", 175, 0);
        setup_conn
            .execute(
                "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
                [&attempt.local_job_id],
            )
            .unwrap();
        let target = PrinterTargetKey::WindowsQueue("Cancelled DB Wait".into());
        let target_key = normalize_target(&target).unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&setup_conn).unwrap();

        let blocker_conn = database.open();
        let blocker = Transaction::new_unchecked(&blocker_conn, TransactionBehavior::Immediate)
            .expect("hold the SQLite writer slot");
        let worker_conn = database.open();
        worker_conn
            .busy_handler(Some(signal_reconciliation_db_busy))
            .unwrap();
        let (busy_tx, busy_rx) = std::sync::mpsc::channel();
        *RECONCILIATION_DB_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some(busy_tx);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let worker_manager = manager.clone();
        let worker = std::thread::spawn(move || {
            reconcile_owned_windows_attempt_with_cancel(
                &worker_conn,
                &worker_manager,
                &ScriptedControlSpooler::with_snapshot(None),
                attempt.attempt_id,
                at(4),
                worker_cancel.as_ref(),
            )
        });

        busy_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("reconciliation must block on BEGIN IMMEDIATE");
        cancel.store(true, Ordering::Release);
        blocker.commit().unwrap();
        let cancelled = worker.join().unwrap().unwrap();
        *RECONCILIATION_DB_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = None;

        let before_recovery: (String, Option<String>, String, i64) = setup_conn
            .query_row(
                "SELECT a.state, a.completed_at, j.status,
                        (SELECT COUNT(*) FROM print_target_state WHERE target_key = ?1)
                 FROM print_job_attempts a
                 JOIN print_jobs j ON j.id = a.print_job_id
                 WHERE a.id = ?2",
                params![target_key, attempt.attempt_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let lane_before_recovery = manager.lanes.lock().unwrap().get(&target_key).copied();
        let recovered = reconcile_owned_windows_attempt(
            &setup_conn,
            &manager,
            &ScriptedControlSpooler::with_snapshot(None),
            attempt.attempt_id,
            at(5),
        )
        .unwrap();

        assert!(
            matches!(
                cancelled.outcome,
                OwnedWindowsReconcileOutcome::Failed { ref error }
                    if error.contains("cancelled")
            ),
            "late reconciliation result: {cancelled:?}"
        );
        assert_eq!(
            before_recovery,
            ("windows_queued".into(), None, "dispatched".into(), 0)
        );
        assert!(matches!(
            lane_before_recovery,
            Some(LaneBlock::Retained(_) | LaneBlock::OpenRetained(_))
        ));
        assert_eq!(
            recovered.outcome,
            OwnedWindowsReconcileOutcome::SpoolCompleted
        );
        assert!(recovered.target_released);
        let mut lease = manager.claim(target).unwrap();
        lease.release_unstarted();
    }

    #[test]
    fn cancellation_while_reconciliation_waits_for_lane_rolls_back_every_effect() {
        let _serial = RECONCILIATION_CANCEL_TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let database = IsolatedDbFile::new();
        let setup_conn = database.open();
        let attempt = queued_windows_attempt(&setup_conn, "Cancelled Lane Wait", 176, 0);
        setup_conn
            .execute(
                "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
                [&attempt.local_job_id],
            )
            .unwrap();
        let target = PrinterTargetKey::WindowsQueue("Cancelled Lane Wait".into());
        let target_key = normalize_target(&target).unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&setup_conn).unwrap();
        let lane_guard = manager.lanes.lock().unwrap();
        let (lane_wait_tx, lane_wait_rx) = std::sync::mpsc::channel();
        let _lane_wait_signal = install_reconciliation_lane_wait_signal_for_test(
            &manager.lanes,
            &target_key,
            lane_wait_tx,
        );

        let worker_conn = database.open();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let worker_manager = manager.clone();
        let worker = std::thread::spawn(move || {
            reconcile_owned_windows_attempt_with_cancel(
                &worker_conn,
                &worker_manager,
                &ScriptedControlSpooler::with_snapshot(None),
                attempt.attempt_id,
                at(4),
                worker_cancel.as_ref(),
            )
        });

        lane_wait_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("reconciliation must reach the held lane mutex");
        cancel.store(true, Ordering::Release);
        drop(lane_guard);
        let cancelled = worker.join().unwrap().unwrap();

        let before_recovery: (String, Option<String>, String, i64) = setup_conn
            .query_row(
                "SELECT a.state, a.completed_at, j.status,
                        (SELECT COUNT(*) FROM print_target_state WHERE target_key = ?1)
                 FROM print_job_attempts a
                 JOIN print_jobs j ON j.id = a.print_job_id
                 WHERE a.id = ?2",
                params![target_key, attempt.attempt_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let lane_before_recovery = manager.lanes.lock().unwrap().get(&target_key).copied();
        let recovered = reconcile_owned_windows_attempt(
            &setup_conn,
            &manager,
            &ScriptedControlSpooler::with_snapshot(None),
            attempt.attempt_id,
            at(5),
        )
        .unwrap();

        assert!(
            matches!(
                cancelled.outcome,
                OwnedWindowsReconcileOutcome::Failed { ref error }
                    if error.contains("cancelled")
            ),
            "late reconciliation result: {cancelled:?}"
        );
        assert_eq!(
            before_recovery,
            ("windows_queued".into(), None, "dispatched".into(), 0)
        );
        assert!(matches!(
            lane_before_recovery,
            Some(LaneBlock::Retained(_) | LaneBlock::OpenRetained(_))
        ));
        assert_eq!(
            recovered.outcome,
            OwnedWindowsReconcileOutcome::SpoolCompleted
        );
        assert!(recovered.target_released);
        let mut lease = manager.claim(target).unwrap();
        lease.release_unstarted();
    }

    #[test]
    fn absent_reconciliation_rolls_back_attempt_parent_and_circuit_when_close_fails() {
        let mut conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Atomic Queue", 174, 0);
        conn.execute(
            "UPDATE print_jobs SET status = 'dispatched' WHERE id = ?1",
            [&attempt.local_job_id],
        )
        .unwrap();
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::CancelRequested,
            AttemptObservation {
                now: at(3),
                ..AttemptObservation::default()
            },
        )
        .unwrap();
        let target = PrinterTargetKey::WindowsQueue("Atomic Queue".into());
        let target_key = normalize_target(&target).unwrap();
        conn.execute(
            "INSERT INTO print_target_state
             (target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at)
             VALUES (?1, 'windows', 'open', 'awaiting exact absence', datetime('now'), datetime('now'))",
            [&target_key],
        )
        .unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        *PRE_COMMIT_LANE_PROBE
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some(PreCommitLaneProbe {
            lanes: Arc::clone(&manager.lanes),
            normalized_key: target_key.clone(),
            observation: None,
        });
        conn.trace(Some(observe_lane_during_circuit_close));
        conn.execute_batch(
            "CREATE TRIGGER inject_reconciliation_close_failure
             BEFORE UPDATE OF circuit_state ON print_target_state
             WHEN NEW.circuit_state = 'closed'
             BEGIN
                 SELECT RAISE(ABORT, 'injected reconciliation close failure');
             END;",
        )
        .unwrap();
        let spooler = ScriptedControlSpooler::with_snapshot(None);

        assert!(matches!(
            reconcile_owned_windows_attempt(&conn, &manager, &spooler, attempt.attempt_id, at(4),),
            Err(DispatchError::Database(_))
        ));
        conn.trace(None);
        let lane_observation = PRE_COMMIT_LANE_PROBE
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap()
            .take()
            .and_then(|probe| probe.observation);
        assert!(
            matches!(
                lane_observation,
                Some(
                    PreCommitLaneObservation::Retained
                        | PreCommitLaneObservation::RegistryLocked
                )
            ),
            "in-memory lane state changed before the durable transaction committed: {lane_observation:?}"
        );
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::CancelRequested
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&attempt.local_job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "dispatched"
        );
        assert_eq!(
            conn.query_row(
                "SELECT circuit_state FROM print_target_state WHERE target_key = ?1",
                [&target_key],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "open"
        );

        conn.execute_batch("DROP TRIGGER inject_reconciliation_close_failure;")
            .unwrap();
        let recovered =
            reconcile_owned_windows_attempt(&conn, &manager, &spooler, attempt.attempt_id, at(5))
                .unwrap();
        assert_eq!(
            recovered.outcome,
            OwnedWindowsReconcileOutcome::CancellationConfirmed
        );
        assert!(recovered.target_released);
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Cancelled
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&attempt.local_job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "cancelled"
        );
        assert_eq!(
            conn.query_row(
                "SELECT circuit_state FROM print_target_state WHERE target_key = ?1",
                [&target_key],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "closed"
        );
        assert!(manager.claim(target).is_ok());
    }

    #[test]
    fn native_status_observation_is_conservative_and_keeps_target_blocked() {
        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Kitchen Queue", 75, 0);
        let stored = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        let spooler =
            ScriptedControlSpooler::with_snapshot(Some(crate::windows_spooler::SpoolJobSnapshot {
                status_bits: 0x0000_0010,
                status_text: Some("Printing page".into()),
                ..native_snapshot("Kitchen Queue", 75, stored.document_name)
            }));

        let result =
            reconcile_owned_windows_attempt(&conn, &manager, &spooler, attempt.attempt_id, at(4))
                .unwrap();

        assert_eq!(
            result.outcome,
            OwnedWindowsReconcileOutcome::Active(DispatchState::WindowsPrinting)
        );
        assert!(!result.target_released);
        let after = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        assert_eq!(after.state, DispatchState::WindowsPrinting);
        assert_eq!(after.native_status_bits, Some(0x10));
        assert_eq!(after.native_status_text.as_deref(), Some("Printing page"));
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue("Kitchen Queue".into())),
            Err(DispatchError::LaneBusy | DispatchError::CircuitOpen)
        ));
    }

    #[test]
    fn reused_job_id_opens_circuit_and_never_claims_completion() {
        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Front Queue", 76, 0);
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        let spooler = ScriptedControlSpooler::with_snapshot(Some(native_snapshot(
            "Front Queue",
            76,
            crate::windows_spooler::format_document_marker(
                Uuid::new_v4(),
                Uuid::new_v4(),
                "receipt",
            )
            .unwrap(),
        )));

        let result =
            reconcile_owned_windows_attempt(&conn, &manager, &spooler, attempt.attempt_id, at(4))
                .unwrap();

        assert!(matches!(
            result.outcome,
            OwnedWindowsReconcileOutcome::OwnershipNotConfirmed { .. }
        ));
        assert!(!result.target_released);
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Unknown
        );
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue("Front Queue".into())),
            Err(DispatchError::CircuitOpen)
        ));
    }

    #[test]
    fn reconciliation_releases_target_only_after_every_blocker_is_cleared() {
        let conn = test_db();
        let attempt_a = queued_windows_attempt(&conn, "Shared Queue", 77, 0);
        let attempt_b = queued_windows_attempt(&conn, "Shared Queue", 78, 4);
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();

        let first = reconcile_owned_windows_attempt(
            &conn,
            &manager,
            &ScriptedControlSpooler::with_snapshot(None),
            attempt_a.attempt_id,
            at(8),
        )
        .unwrap();
        assert_eq!(first.outcome, OwnedWindowsReconcileOutcome::SpoolCompleted);
        assert!(!first.target_released);
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue("Shared Queue".into())),
            Err(DispatchError::LaneBusy | DispatchError::CircuitOpen)
        ));

        let second = reconcile_owned_windows_attempt(
            &conn,
            &manager,
            &ScriptedControlSpooler::with_snapshot(None),
            attempt_b.attempt_id,
            at(9),
        )
        .unwrap();
        assert_eq!(second.outcome, OwnedWindowsReconcileOutcome::SpoolCompleted);
        assert!(second.target_released);
        assert!(manager
            .claim(PrinterTargetKey::WindowsQueue("Shared Queue".into()))
            .is_ok());
    }

    #[test]
    fn older_reconciliation_epoch_never_mutates_newer_attempt_or_parent() {
        let conn = test_db();
        let attempt_a = queued_windows_attempt(&conn, "Front Queue", 79, 0);
        let attempt_b = create_attempt(
            &conn,
            NewAttempt {
                local_job_id: attempt_a.local_job_id.clone(),
                target: PrinterTargetKey::WindowsQueue("Front Queue".into()),
                document_kind: "receipt".into(),
                bytes_requested: 10,
                now: at(4),
            },
        )
        .unwrap();
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();

        let result = reconcile_owned_windows_attempt(
            &conn,
            &manager,
            &ScriptedControlSpooler::with_snapshot(None),
            attempt_a.attempt_id,
            at(5),
        )
        .unwrap();

        assert_eq!(result.outcome, OwnedWindowsReconcileOutcome::SpoolCompleted);
        assert!(!result.target_released);
        assert_eq!(
            read_attempt(&conn, attempt_a.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::SpoolCompleted
        );
        assert_eq!(
            read_attempt(&conn, attempt_b.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Created
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&attempt_a.local_job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "pending"
        );
    }

    #[test]
    fn target_normalization_coalesces_equivalent_inputs_without_cross_transport_collisions() {
        let windows = normalize_target(&PrinterTargetKey::WindowsQueue("  FRONT Α  ".into()))
            .expect("windows target");
        assert_eq!(
            windows,
            normalize_target(&PrinterTargetKey::WindowsQueue("front α".into())).unwrap()
        );

        let tcp = normalize_target(&PrinterTargetKey::RawTcp {
            host: "  PRINT.EXAMPLE  ".into(),
            port: 9100,
        })
        .unwrap();
        assert_eq!(
            tcp,
            normalize_target(&PrinterTargetKey::RawTcp {
                host: "print.example".into(),
                port: 9100,
            })
            .unwrap()
        );
        assert_ne!(
            tcp,
            normalize_target(&PrinterTargetKey::RawTcp {
                host: "print.example".into(),
                port: 9101,
            })
            .unwrap()
        );
        assert_ne!(
            windows,
            normalize_target(&PrinterTargetKey::Serial {
                port_name: "front α".into(),
                baud_rate: 9100,
            })
            .unwrap()
        );
        assert_ne!(
            normalize_target(&PrinterTargetKey::Serial {
                port_name: "COM3".into(),
                baud_rate: 9_600,
            })
            .unwrap(),
            normalize_target(&PrinterTargetKey::Serial {
                port_name: " com3 ".into(),
                baud_rate: 115_200,
            })
            .unwrap()
        );

        assert!(normalize_target(&PrinterTargetKey::WindowsQueue("   ".into())).is_err());
        assert!(normalize_target(&PrinterTargetKey::RawTcp {
            host: "host".into(),
            port: 0,
        })
        .is_err());
        assert!(normalize_target(&PrinterTargetKey::Serial {
            port_name: " ".into(),
            baud_rate: 9_600,
        })
        .is_err());
    }

    #[test]
    fn ipv6_and_unicode_targets_round_trip_without_serialization_ambiguity() {
        let conn = test_db();
        let tcp_job = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &tcp_job);
        let tcp_target = PrinterTargetKey::RawTcp {
            host: "  [FE80::1%Δίκτυο]  ".into(),
            port: 9100,
        };
        let tcp = create_attempt(
            &conn,
            NewAttempt {
                local_job_id: tcp_job,
                target: tcp_target.clone(),
                document_kind: "receipt".into(),
                bytes_requested: 1,
                now: at(0),
            },
        )
        .unwrap();
        assert_eq!(
            read_attempt(&conn, tcp.attempt_id)
                .unwrap()
                .unwrap()
                .identity
                .target_key,
            tcp_target
        );
        assert_eq!(
            normalize_target(&tcp_target).unwrap(),
            normalize_target(&PrinterTargetKey::RawTcp {
                host: "[fe80::1%δίκτυο]".into(),
                port: 9100,
            })
            .unwrap()
        );
        assert_ne!(
            normalize_target(&tcp_target).unwrap(),
            normalize_target(&PrinterTargetKey::RawTcp {
                host: "[fe80::1%δίκτυο]:9100".into(),
                port: 1,
            })
            .unwrap()
        );

        let serial_job = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &serial_job);
        let serial_target = PrinterTargetKey::Serial {
            port_name: " Θύρα:Α ".into(),
            baud_rate: 115_200,
        };
        let serial = create_attempt(
            &conn,
            NewAttempt {
                local_job_id: serial_job,
                target: serial_target.clone(),
                document_kind: "receipt".into(),
                bytes_requested: 1,
                now: at(1),
            },
        )
        .unwrap();
        assert_eq!(
            read_attempt(&conn, serial.attempt_id)
                .unwrap()
                .unwrap()
                .identity
                .target_key,
            serial_target
        );
    }

    #[test]
    fn create_attempt_numbers_per_job_and_leaves_no_partial_rows_on_failure() {
        let conn = test_db();
        let job_a = uuid::Uuid::new_v4().to_string();
        let job_b = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_a);
        insert_job(&conn, &job_b);

        let make = |job: &str, second| {
            create_attempt(
                &conn,
                NewAttempt {
                    local_job_id: job.to_owned(),
                    target: PrinterTargetKey::WindowsQueue("  Front Desk  ".into()),
                    document_kind: "receipt".into(),
                    bytes_requested: 128,
                    now: at(second),
                },
            )
            .expect("create attempt")
        };
        assert_eq!(make(&job_a, 0).attempt_number, 1);
        assert_eq!(make(&job_a, 1).attempt_number, 2);
        assert_eq!(make(&job_a, 2).attempt_number, 3);
        assert_eq!(make(&job_b, 3).attempt_number, 1);

        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM print_job_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        for bad in [
            NewAttempt {
                local_job_id: uuid::Uuid::new_v4().to_string(),
                target: PrinterTargetKey::WindowsQueue("Front".into()),
                document_kind: "receipt".into(),
                bytes_requested: 1,
                now: at(4),
            },
            NewAttempt {
                local_job_id: job_a.clone(),
                target: PrinterTargetKey::WindowsQueue(" ".into()),
                document_kind: "receipt".into(),
                bytes_requested: 1,
                now: at(4),
            },
            NewAttempt {
                local_job_id: job_a.clone(),
                target: PrinterTargetKey::WindowsQueue("Front".into()),
                document_kind: "not/canonical".into(),
                bytes_requested: 1,
                now: at(4),
            },
            NewAttempt {
                local_job_id: job_a.clone(),
                target: PrinterTargetKey::WindowsQueue("Front".into()),
                document_kind: "receipt".into(),
                bytes_requested: -1,
                now: at(4),
            },
        ] {
            assert!(create_attempt(&conn, bad).is_err());
        }
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM print_job_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(after, before);

        let (resolved, marker): (String, String) = conn
            .query_row(
                "SELECT resolved_target, document_name FROM print_job_attempts
                 WHERE print_job_id = ?1 AND attempt_number = 1",
                [&job_a],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(resolved, "  Front Desk  ");
        let parsed = crate::windows_spooler::parse_document_marker(&marker).unwrap();
        assert_eq!(parsed.local_job_id.to_string(), job_a);

        assert!(conn
            .execute(
                "INSERT INTO print_job_attempts
                 (id, print_job_id, attempt_number, transport, resolved_target, document_name,
                  state, bytes_requested, bytes_written, started_at)
                 VALUES ('bad-state', ?1, 99, 'windows', 'Front', 'marker', 'bogus', 0, 0, 'now')",
                params![job_a],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO print_job_attempts
                 (id, print_job_id, attempt_number, transport, resolved_target, document_name,
                  state, bytes_requested, bytes_written, started_at)
                 VALUES ('bad-transport', ?1, 99, 'bluetooth', 'Front', 'marker', 'created', 0, 0, 'now')",
                params![job_a],
            )
            .is_err());
    }

    #[test]
    fn concurrent_same_job_attempt_creation_succeeds_with_consecutive_numbers() {
        let database = IsolatedDbFile::new();
        let setup = database.open();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&setup, &job_id);
        drop(setup);

        let (insert_reached_tx, insert_reached_rx) = std::sync::mpsc::channel();
        let (release_insert_tx, release_insert_rx) = std::sync::mpsc::channel();
        *CREATE_INSERT_GATE
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some((insert_reached_tx, release_insert_rx));

        let mut first_conn = database.open();
        first_conn.trace(Some(pause_before_attempt_insert));
        let first_job = job_id.clone();
        let first = std::thread::spawn(move || {
            create_attempt(
                &first_conn,
                NewAttempt {
                    local_job_id: first_job,
                    target: PrinterTargetKey::WindowsQueue("Front".into()),
                    document_kind: "receipt".into(),
                    bytes_requested: 1,
                    now: at(1),
                },
            )
        });
        insert_reached_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap();

        let (event_tx, event_rx) = std::sync::mpsc::channel();
        *CREATE_BUSY_SIGNAL
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some(event_tx.clone());
        let second_conn = database.open();
        second_conn.busy_handler(Some(signal_create_busy)).unwrap();
        let second_job = job_id.clone();
        let second = std::thread::spawn(move || {
            let result = create_attempt(
                &second_conn,
                NewAttempt {
                    local_job_id: second_job,
                    target: PrinterTargetKey::WindowsQueue("Front".into()),
                    document_kind: "receipt".into(),
                    bytes_requested: 1,
                    now: at(2),
                },
            );
            event_tx.send(CreateEvent::Completed).unwrap();
            result
        });

        let first_event = event_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            first_event,
            CreateEvent::Blocked | CreateEvent::Completed
        ));
        release_insert_tx.send(()).unwrap();
        if first_event == CreateEvent::Blocked {
            assert_eq!(
                event_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                CreateEvent::Completed
            );
        }

        let mut attempts = [first.join().unwrap(), second.join().unwrap()]
            .into_iter()
            .map(|result| result.expect("both concurrent creations must succeed"))
            .collect::<Vec<_>>();
        attempts.sort_by_key(|attempt| attempt.attempt_number);
        assert_eq!(
            attempts
                .iter()
                .map(|attempt| attempt.attempt_number)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn state_text_round_trips_every_v73_state() {
        let expected = [
            "created",
            "submitting",
            "windows_queued",
            "windows_printing",
            "paused",
            "sent",
            "spool_completed",
            "cancel_requested",
            "cancelled",
            "transport_error",
            "spool_error",
            "cancel_failed",
            "unknown",
        ];
        assert_eq!(DispatchState::ALL.len(), expected.len());
        for (state, text) in DispatchState::ALL.into_iter().zip(expected) {
            assert_eq!(state.as_str(), text);
            assert_eq!(DispatchState::from_str(text).unwrap(), state);
        }
        assert!(DispatchState::from_str("printed").is_err());
    }

    #[test]
    fn transition_graph_applies_each_allowed_edge_once_and_rejects_wrong_prior_state() {
        let edges = [
            (DispatchState::Created, DispatchState::Submitting),
            (DispatchState::Created, DispatchState::CancelRequested),
            (DispatchState::Created, DispatchState::Cancelled),
            (DispatchState::Created, DispatchState::TransportError),
            (DispatchState::Submitting, DispatchState::WindowsQueued),
            (DispatchState::Submitting, DispatchState::Sent),
            (DispatchState::Submitting, DispatchState::CancelRequested),
            (DispatchState::Submitting, DispatchState::TransportError),
            (DispatchState::Submitting, DispatchState::SpoolError),
            (DispatchState::Submitting, DispatchState::Unknown),
            (DispatchState::WindowsQueued, DispatchState::WindowsPrinting),
            (DispatchState::WindowsQueued, DispatchState::Paused),
            (DispatchState::WindowsQueued, DispatchState::SpoolCompleted),
            (DispatchState::WindowsQueued, DispatchState::CancelRequested),
            (DispatchState::WindowsQueued, DispatchState::SpoolError),
            (DispatchState::WindowsQueued, DispatchState::Unknown),
            (DispatchState::WindowsPrinting, DispatchState::Paused),
            (
                DispatchState::WindowsPrinting,
                DispatchState::SpoolCompleted,
            ),
            (
                DispatchState::WindowsPrinting,
                DispatchState::CancelRequested,
            ),
            (DispatchState::WindowsPrinting, DispatchState::SpoolError),
            (DispatchState::WindowsPrinting, DispatchState::Unknown),
            (DispatchState::Paused, DispatchState::WindowsQueued),
            (DispatchState::Paused, DispatchState::WindowsPrinting),
            (DispatchState::Paused, DispatchState::CancelRequested),
            (DispatchState::Paused, DispatchState::SpoolError),
            (DispatchState::Paused, DispatchState::Unknown),
            (DispatchState::CancelRequested, DispatchState::Cancelled),
            (DispatchState::CancelRequested, DispatchState::CancelFailed),
            (DispatchState::CancelRequested, DispatchState::Unknown),
        ];

        let conn = test_db();
        for (index, (from, to)) in edges.into_iter().enumerate() {
            let job_id = uuid::Uuid::new_v4().to_string();
            insert_job(&conn, &job_id);
            let attempt = new_windows_attempt(&conn, &job_id, 0);
            conn.execute(
                "UPDATE print_job_attempts SET state = ?1 WHERE id = ?2",
                params![from.as_str(), attempt.attempt_id.to_string()],
            )
            .unwrap();

            assert_eq!(
                transition_attempt(
                    &conn,
                    attempt.attempt_id,
                    to,
                    observation((index % 59 + 1) as u32),
                )
                .unwrap(),
                ApplyResult::Applied,
                "expected {from:?} -> {to:?}"
            );
            assert_eq!(
                transition_attempt(
                    &conn,
                    attempt.attempt_id,
                    to,
                    observation((index % 59 + 1) as u32),
                )
                .unwrap(),
                ApplyResult::NotApplied,
                "second application must fail for {to:?}"
            );
        }
    }

    #[test]
    fn late_success_never_overwrites_cancellation_or_unresolved_states() {
        let conn = test_db();
        for blocked_state in [
            DispatchState::CancelRequested,
            DispatchState::Cancelled,
            DispatchState::Unknown,
            DispatchState::CancelFailed,
        ] {
            for late in [DispatchState::Sent, DispatchState::SpoolCompleted] {
                let job_id = uuid::Uuid::new_v4().to_string();
                insert_job(&conn, &job_id);
                let attempt = new_windows_attempt(&conn, &job_id, 0);
                conn.execute(
                    "UPDATE print_job_attempts SET state = ?1 WHERE id = ?2",
                    params![blocked_state.as_str(), attempt.attempt_id.to_string()],
                )
                .unwrap();
                assert_eq!(
                    transition_attempt(&conn, attempt.attempt_id, late, observation(1)).unwrap(),
                    ApplyResult::NotApplied
                );
                assert_eq!(
                    read_attempt(&conn, attempt.attempt_id)
                        .unwrap()
                        .unwrap()
                        .state,
                    blocked_state
                );
            }
        }
    }

    #[test]
    fn observations_keep_timestamps_honest_and_bytes_monotonic() {
        let conn = test_db();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);

        let mut first = observation(1);
        first.bytes_written = Some(20);
        first.native_status_bits = Some(16);
        first.native_status_text = Some("spooling".into());
        assert_eq!(
            transition_attempt(&conn, attempt.attempt_id, DispatchState::Submitting, first,)
                .unwrap(),
            ApplyResult::Applied
        );

        let mut lower = observation(2);
        lower.bytes_written = Some(19);
        assert!(
            observe_attempt(&conn, attempt.attempt_id, DispatchState::Submitting, lower).is_err()
        );
        let mut too_large = observation(2);
        too_large.bytes_written = Some(101);
        assert!(observe_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            too_large
        )
        .is_err());

        let mut progress = observation(2);
        progress.bytes_written = Some(50);
        assert_eq!(
            observe_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::Submitting,
                progress,
            )
            .unwrap(),
            ApplyResult::Applied
        );
        assert_eq!(
            transition_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::CancelRequested,
                observation(3),
            )
            .unwrap(),
            ApplyResult::Applied
        );
        assert_eq!(
            transition_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::Cancelled,
                observation(4),
            )
            .unwrap(),
            ApplyResult::Applied
        );
        let row = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        assert_eq!(row.bytes_written, 50);
        assert_eq!(
            row.last_seen_at.as_deref(),
            Some("2026-08-06T10:00:04.000Z")
        );
        assert_eq!(
            row.cancel_requested_at.as_deref(),
            Some("2026-08-06T10:00:03.000Z")
        );
        assert_eq!(
            row.cancel_confirmed_at.as_deref(),
            Some("2026-08-06T10:00:04.000Z")
        );
        assert_eq!(row.completed_at, row.cancel_confirmed_at);
    }

    #[test]
    fn concurrent_observations_cannot_decrease_bytes_after_validation() {
        let _trace_test = TRACE_TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let database = IsolatedDbFile::new();
        let conn = database.open();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(1),
        )
        .unwrap();
        let mut initial = observation(2);
        initial.bytes_written = Some(20);
        observe_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            initial,
        )
        .unwrap();

        let (reached_tx, reached_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *TRACE_GATE
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some((reached_tx, release_rx));
        let mut lower_conn = database.open();
        lower_conn.trace(Some(pause_before_attempt_update));
        let attempt_id = attempt.attempt_id;
        let lower = std::thread::spawn(move || {
            let mut lower = observation(3);
            lower.bytes_written = Some(30);
            observe_attempt(&lower_conn, attempt_id, DispatchState::Submitting, lower)
        });

        reached_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut higher = observation(4);
        higher.bytes_written = Some(50);
        assert_eq!(
            observe_attempt(&conn, attempt.attempt_id, DispatchState::Submitting, higher,).unwrap(),
            ApplyResult::Applied
        );
        release_tx.send(()).unwrap();
        assert_eq!(lower.join().unwrap().unwrap(), ApplyResult::NotApplied);
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .bytes_written,
            50
        );
    }

    #[test]
    fn concurrent_equal_byte_observations_cannot_regress_last_seen_at() {
        let _trace_test = TRACE_TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let database = IsolatedDbFile::new();
        let conn = database.open();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(1),
        )
        .unwrap();
        let mut initial = observation(2);
        initial.bytes_written = Some(20);
        observe_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            initial,
        )
        .unwrap();

        let (reached_tx, reached_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *TRACE_GATE
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some((reached_tx, release_rx));
        let mut stale_conn = database.open();
        stale_conn.trace(Some(pause_before_attempt_update));
        let attempt_id = attempt.attempt_id;
        let stale = std::thread::spawn(move || {
            let mut stale = observation(3);
            stale.bytes_written = Some(20);
            observe_attempt(&stale_conn, attempt_id, DispatchState::Submitting, stale)
        });

        reached_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut newest = observation(4);
        newest.bytes_written = Some(20);
        assert_eq!(
            observe_attempt(&conn, attempt.attempt_id, DispatchState::Submitting, newest,).unwrap(),
            ApplyResult::Applied
        );
        release_tx.send(()).unwrap();
        assert_eq!(stale.join().unwrap().unwrap(), ApplyResult::NotApplied);
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .last_seen_at
                .as_deref(),
            Some("2026-08-06T10:00:04.000Z")
        );
    }

    #[test]
    fn stale_cancel_and_terminal_transitions_cannot_regress_timestamps() {
        let conn = test_db();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(1),
        )
        .unwrap();
        observe_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(4),
        )
        .unwrap();

        assert_eq!(
            transition_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::CancelRequested,
                observation(3),
            )
            .unwrap(),
            ApplyResult::NotApplied
        );
        assert_eq!(
            transition_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::CancelRequested,
                observation(5),
            )
            .unwrap(),
            ApplyResult::Applied
        );
        observe_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::CancelRequested,
            observation(7),
        )
        .unwrap();
        assert_eq!(
            transition_attempt(
                &conn,
                attempt.attempt_id,
                DispatchState::Cancelled,
                observation(6),
            )
            .unwrap(),
            ApplyResult::NotApplied
        );

        let persisted = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        assert_eq!(persisted.state, DispatchState::CancelRequested);
        assert_eq!(
            persisted.last_seen_at.as_deref(),
            Some("2026-08-06T10:00:07.000Z")
        );
        assert_eq!(
            persisted.cancel_requested_at.as_deref(),
            Some("2026-08-06T10:00:05.000Z")
        );
        assert_eq!(persisted.cancel_confirmed_at, None);
        assert_eq!(persisted.completed_at, None);
    }

    #[test]
    fn spool_started_is_persisted_before_fake_writer_continues_and_identity_is_immutable() {
        use crate::windows_spooler::{FakeWindowsSpooler, WindowsRawRequest, WindowsSpooler};

        let database = IsolatedDbFile::new();
        let conn = database.open();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(1),
        )
        .unwrap();
        let marker = read_attempt(&conn, attempt.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;

        let fake = Arc::new(FakeWindowsSpooler::new(4242));
        fake.set_block_after_started(true);
        fake.set_block_timeout(Duration::from_secs(10));
        let thread_fake = Arc::clone(&fake);
        let worker_conn = database.open();
        let attempt_id = attempt.attempt_id;
        let request_marker = marker.clone();
        let worker = std::thread::spawn(move || {
            thread_fake.submit_raw(
                WindowsRawRequest {
                    printer_name: "Front".into(),
                    document_name: request_marker,
                    bytes: Arc::from([1_u8, 2, 3]),
                },
                &AtomicBool::new(false),
                &mut |started| {
                    assert_eq!(
                        persist_spool_started(&worker_conn, attempt_id, started).unwrap(),
                        ApplyResult::Applied
                    );
                    Ok(())
                },
            )
        });

        assert!(fake.wait_until_submission_blocked(Duration::from_secs(10)));
        let persisted = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        assert_eq!(persisted.state, DispatchState::WindowsQueued);
        assert_eq!(persisted.spool_job_id, Some(4242));
        assert_eq!(persisted.document_name, marker);
        let different_job = crate::windows_spooler::SpoolStarted {
            job_id: 7777,
            printer_name: "Front".into(),
            document_name: marker.clone(),
            submitted_at: at(2),
        };
        assert_eq!(
            persist_spool_started(&conn, attempt.attempt_id, &different_job).unwrap(),
            ApplyResult::NotApplied
        );
        let different_marker = crate::windows_spooler::SpoolStarted {
            job_id: 4242,
            printer_name: "Front".into(),
            document_name: crate::windows_spooler::format_document_marker(
                uuid::Uuid::parse_str(&job_id).unwrap(),
                uuid::Uuid::new_v4(),
                "receipt",
            )
            .unwrap(),
            submitted_at: at(2),
        };
        assert_eq!(
            persist_spool_started(&conn, attempt.attempt_id, &different_marker).unwrap(),
            ApplyResult::NotApplied
        );
        fake.release_submission_block();
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn spool_started_rejects_a_callback_for_a_different_resolved_queue() {
        let conn = test_db();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(1),
        )
        .unwrap();
        let marker = read_attempt(&conn, attempt.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        let started = crate::windows_spooler::SpoolStarted {
            job_id: 4242,
            printer_name: "Back".into(),
            document_name: marker,
            submitted_at: at(2),
        };

        assert_eq!(
            persist_spool_started(&conn, attempt.attempt_id, &started).unwrap(),
            ApplyResult::NotApplied
        );
        let persisted = read_attempt(&conn, attempt.attempt_id).unwrap().unwrap();
        assert_eq!(persisted.state, DispatchState::Submitting);
        assert_eq!(persisted.spool_job_id, None);
    }

    #[test]
    fn spool_started_rejects_an_invalid_zero_job_id() {
        let conn = test_db();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        let marker = read_attempt(&conn, attempt.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        let started = crate::windows_spooler::SpoolStarted {
            job_id: 0,
            printer_name: "Front".into(),
            document_name: marker,
            submitted_at: at(1),
        };

        assert!(matches!(
            persist_spool_started(&conn, attempt.attempt_id, &started),
            Err(DispatchError::InvalidWindowsJobId)
        ));
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .spool_job_id,
            None
        );
    }

    #[test]
    fn corrupt_zero_spool_job_id_never_reaches_native_control_or_reconciliation() {
        let conn = test_db();
        let attempt = queued_windows_attempt(&conn, "Front", 73, 0);
        let marker = read_attempt(&conn, attempt.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        let manager = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        conn.execute(
            "UPDATE print_job_attempts SET spool_job_id = 0 WHERE id = ?1",
            [attempt.attempt_id.to_string()],
        )
        .unwrap();
        let spooler =
            ScriptedControlSpooler::with_snapshot(Some(crate::windows_spooler::SpoolJobSnapshot {
                job_id: 0,
                printer_name: "Front".into(),
                document_name: marker,
                status_text: Some("Paused".into()),
                status_bits: 0x1,
                position: 1,
                total_pages: 1,
                pages_printed: 0,
            }));

        let control = control_owned_windows_attempt(
            &conn,
            &spooler,
            attempt.attempt_id,
            crate::windows_spooler::SpoolJobControl::Pause,
            at(10),
        )
        .unwrap();
        assert!(matches!(
            control,
            OwnedWindowsControlResult::OwnershipNotConfirmed { .. }
        ));
        let reconciliation =
            reconcile_owned_windows_attempt(&conn, &manager, &spooler, attempt.attempt_id, at(11))
                .unwrap();
        assert!(matches!(
            reconciliation.outcome,
            OwnedWindowsReconcileOutcome::OwnershipNotConfirmed { .. }
        ));
        assert!(spooler.get_job_calls.lock().unwrap().is_empty());
        assert!(spooler.controls.lock().unwrap().is_empty());
        assert!(matches!(
            read_attempt(&conn, attempt.attempt_id),
            Err(DispatchError::InvalidWindowsJobId)
        ));
    }

    #[test]
    fn invalid_spool_error_identities_do_not_hydrate_target_blockers() {
        let conn = test_db();
        let invalid_values = [
            ("NULL", "null"),
            ("0", "integer"),
            ("-1", "integer"),
            ("4294967296", "integer"),
            ("CAST(4.5 AS REAL)", "real"),
            ("CAST('not-a-job-id' AS TEXT)", "text"),
            ("X'0000002A'", "blob"),
        ];
        let mut invalid_targets = Vec::new();
        for (index, (value, expected_storage_class)) in invalid_values.into_iter().enumerate() {
            let queue = format!("Invalid Spool Error {index}");
            let attempt = queued_windows_attempt(&conn, &queue, 73 + index as u32, 0);
            conn.execute(
                &format!(
                    "UPDATE print_job_attempts
                     SET state = 'spool_error', spool_job_id = {value}
                     WHERE id = ?1"
                ),
                [attempt.attempt_id.to_string()],
            )
            .unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT typeof(spool_job_id) FROM print_job_attempts WHERE id = ?1",
                    [attempt.attempt_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                expected_storage_class,
                "the test must exercise the intended SQLite storage class"
            );
            invalid_targets.push(PrinterTargetKey::WindowsQueue(queue));
        }

        let valid_queue = "Valid Spool Error";
        let valid = queued_windows_attempt(&conn, valid_queue, 99, 0);
        conn.execute(
            "UPDATE print_job_attempts SET state = 'spool_error' WHERE id = ?1",
            [valid.attempt_id.to_string()],
        )
        .unwrap();

        let named_blocker_queue = "Named Blocker With Invalid Native Id";
        let named_blocker = queued_windows_attempt(&conn, named_blocker_queue, 100, 0);
        conn.execute(
            "UPDATE print_job_attempts
             SET spool_job_id = CAST('invalid' AS TEXT)
             WHERE id = ?1",
            [named_blocker.attempt_id.to_string()],
        )
        .unwrap();

        let manager = DispatchManager::hydrate_isolated_for_test(&conn)
            .expect("invalid persisted native identities must not abort hydration");
        for target in invalid_targets {
            assert!(
                active_attempts_for_target(&conn, &target)
                    .expect("invalid spool_error must be excluded from target blockers")
                    .is_empty(),
                "invalid spool_error identity must not be a shared blocker"
            );
            let mut lease = manager
                .claim(target)
                .expect("invalid spool_error identity must not retain the target lane");
            lease.release_unstarted();
        }
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue(valid_queue.into())),
            Err(DispatchError::LaneBusy)
        ));
        assert!(matches!(
            manager.claim(PrinterTargetKey::WindowsQueue(named_blocker_queue.into())),
            Err(DispatchError::LaneBusy)
        ));
    }

    #[test]
    fn active_lookup_includes_v73_active_states_and_task_operations_do_not_expire_them() {
        let conn = test_db();
        let target = PrinterTargetKey::WindowsQueue(" FRONT ".into());
        let active_states = [
            DispatchState::Created,
            DispatchState::Submitting,
            DispatchState::WindowsQueued,
            DispatchState::WindowsPrinting,
            DispatchState::Paused,
            DispatchState::CancelRequested,
            DispatchState::Unknown,
        ];
        let terminal_states = [
            DispatchState::Sent,
            DispatchState::SpoolCompleted,
            DispatchState::Cancelled,
            DispatchState::TransportError,
            DispatchState::SpoolError,
        ];

        for state in active_states.into_iter().chain(terminal_states) {
            let job_id = uuid::Uuid::new_v4().to_string();
            insert_job(&conn, &job_id);
            let attempt = create_attempt(
                &conn,
                NewAttempt {
                    local_job_id: job_id,
                    target: target.clone(),
                    document_kind: "receipt".into(),
                    bytes_requested: 1,
                    now: at(0),
                },
            )
            .unwrap();
            conn.execute(
                "UPDATE print_job_attempts SET state = ?1 WHERE id = ?2",
                params![state.as_str(), attempt.attempt_id.to_string()],
            )
            .unwrap();
        }

        let active =
            active_attempts_for_target(&conn, &PrinterTargetKey::WindowsQueue("front".into()))
                .unwrap();
        let found = active.iter().map(|row| row.state).collect::<Vec<_>>();
        for state in active_states {
            assert!(found.contains(&state), "missing {state:?}");
        }
        for state in terminal_states {
            assert!(
                !found.contains(&state),
                "terminal state returned: {state:?}"
            );
        }

        let expired: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE history_expires_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(expired, 0);
    }

    #[test]
    fn target_lanes_are_independent_and_release_only_after_an_explicit_terminal_mark() {
        let manager = DispatchManager::isolated_for_test();
        let target_a = PrinterTargetKey::WindowsQueue("Front".into());
        let target_b = PrinterTargetKey::WindowsQueue("Kitchen".into());
        let mut lease_a = manager.claim(target_a.clone()).unwrap();
        assert!(matches!(
            manager.claim(target_a.clone()),
            Err(DispatchError::LaneBusy)
        ));

        let mut lease_b = manager.claim(target_b.clone()).unwrap();
        lease_b.mark_terminal(DispatchState::Sent).unwrap();
        drop(lease_b);
        let mut second_b = manager.claim(target_b).unwrap();
        second_b
            .mark_terminal(DispatchState::TransportError)
            .unwrap();
        drop(second_b);

        lease_a
            .mark_terminal(DispatchState::SpoolCompleted)
            .unwrap();
        drop(lease_a);
        assert!(manager.claim(target_a).is_ok());
    }

    #[test]
    fn unresolved_lease_drop_retains_the_lane_until_reconciliation() {
        let conn = test_db();
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::WindowsQueue("Front".into());
        drop(manager.claim(target.clone()).unwrap());
        assert!(matches!(
            manager.claim(target.clone()),
            Err(DispatchError::LaneBusy)
        ));

        manager
            .reconcile(&conn, &target, at(1))
            .expect("explicit reconciliation releases retained lane");
        assert!(manager.claim(target).is_ok());
    }

    #[test]
    fn reconciliation_refuses_to_release_a_live_lease() {
        let conn = test_db();
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::WindowsQueue("Front".into());
        let mut live = manager.claim(target.clone()).unwrap();

        assert!(matches!(
            manager.reconcile(&conn, &target, at(1)),
            Err(DispatchError::LaneBusy)
        ));
        assert!(matches!(
            manager.claim(target.clone()),
            Err(DispatchError::LaneBusy)
        ));
        live.mark_terminal(DispatchState::SpoolCompleted).unwrap();
        drop(live);
        assert!(manager.claim(target).is_ok());
    }

    #[test]
    fn unknown_and_cancel_failed_open_persisted_circuits_and_survive_restart() {
        for (prior, outcome) in [
            (DispatchState::Submitting, DispatchState::Unknown),
            (DispatchState::CancelRequested, DispatchState::CancelFailed),
        ] {
            let conn = test_db();
            let job_id = uuid::Uuid::new_v4().to_string();
            insert_job(&conn, &job_id);
            let attempt = new_windows_attempt(&conn, &job_id, 0);
            conn.execute(
                "UPDATE print_job_attempts SET state = ?1 WHERE id = ?2",
                params![prior.as_str(), attempt.attempt_id.to_string()],
            )
            .unwrap();

            let manager = DispatchManager::isolated_for_test();
            let target = PrinterTargetKey::WindowsQueue(" FRONT ".into());
            let mut lease = manager.claim(target.clone()).unwrap();
            assert_eq!(
                manager
                    .finish_attempt_for_test(
                        &conn,
                        &mut lease,
                        attempt.attempt_id,
                        outcome,
                        Some("operator review required"),
                        at(1),
                    )
                    .unwrap(),
                ApplyResult::Applied
            );
            drop(lease);
            assert!(matches!(
                manager.claim(target.clone()),
                Err(DispatchError::CircuitOpen)
            ));

            let normalized = normalize_target(&target).unwrap();
            let persisted: (String, String, Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT transport, circuit_state, blocked_reason, blocked_at
                     FROM print_target_state WHERE target_key = ?1",
                    [&normalized],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(persisted.0, "windows");
            assert_eq!(persisted.1, "open");
            assert_eq!(persisted.2.as_deref(), Some("operator review required"));
            assert_eq!(persisted.3.as_deref(), Some("2026-08-06T10:00:01.000Z"));

            let restarted = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
            assert!(matches!(
                restarted.claim(target.clone()),
                Err(DispatchError::CircuitOpen)
            ));
            assert!(matches!(
                restarted.reconcile(&conn, &target, at(2)),
                Err(DispatchError::TargetStillBlocked)
            ));
            conn.execute(
                "UPDATE print_job_attempts
                 SET state = CASE WHEN state = 'unknown' THEN 'spool_completed' ELSE 'cancelled' END,
                     completed_at = ?1
                 WHERE id = ?2",
                params![timestamp(at(2)), attempt.attempt_id.to_string()],
            )
            .unwrap();
            restarted.reconcile(&conn, &target, at(3)).unwrap();
            let circuit: (String, Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT circuit_state, blocked_reason, blocked_at
                     FROM print_target_state WHERE target_key = ?1",
                    [&normalized],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(circuit, ("closed".into(), None, None));
            assert!(restarted.claim(target).is_ok());
        }
    }

    #[test]
    fn live_unknown_and_cancel_failed_leases_cannot_be_reconciled_until_drop() {
        for (prior, outcome) in [
            (DispatchState::Submitting, DispatchState::Unknown),
            (DispatchState::CancelRequested, DispatchState::CancelFailed),
        ] {
            let conn = test_db();
            let job_id = uuid::Uuid::new_v4().to_string();
            insert_job(&conn, &job_id);
            let attempt = new_windows_attempt(&conn, &job_id, 0);
            conn.execute(
                "UPDATE print_job_attempts SET state = ?1 WHERE id = ?2",
                params![prior.as_str(), attempt.attempt_id.to_string()],
            )
            .unwrap();

            let manager = DispatchManager::isolated_for_test();
            let target = PrinterTargetKey::WindowsQueue(format!("Front-{outcome:?}"));
            conn.execute(
                "UPDATE print_job_attempts SET resolved_target = ?1 WHERE id = ?2",
                params![
                    match &target {
                        PrinterTargetKey::WindowsQueue(queue) => queue,
                        _ => unreachable!(),
                    },
                    attempt.attempt_id.to_string()
                ],
            )
            .unwrap();
            let mut lease = manager.claim(target.clone()).unwrap();
            assert_eq!(
                manager
                    .finish_attempt_for_test(
                        &conn,
                        &mut lease,
                        attempt.attempt_id,
                        outcome,
                        Some("manual reconciliation required"),
                        at(1),
                    )
                    .unwrap(),
                ApplyResult::Applied
            );

            assert!(matches!(
                manager.reconcile(&conn, &target, at(2)),
                Err(DispatchError::LaneBusy)
            ));
            assert_eq!(
                conn.query_row(
                    "SELECT circuit_state FROM print_target_state WHERE target_key = ?1",
                    [normalize_target(&target).unwrap()],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                "open"
            );

            drop(lease);
            assert!(matches!(
                manager.reconcile(&conn, &target, at(3)),
                Err(DispatchError::TargetStillBlocked)
            ));
            conn.execute(
                "UPDATE print_job_attempts
                 SET state = CASE WHEN state = 'unknown' THEN 'spool_completed' ELSE 'cancelled' END,
                     completed_at = ?1
                 WHERE id = ?2",
                params![timestamp(at(3)), attempt.attempt_id.to_string()],
            )
            .unwrap();
            manager.reconcile(&conn, &target, at(4)).unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT circuit_state FROM print_target_state WHERE target_key = ?1",
                    [normalize_target(&target).unwrap()],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
                "closed"
            );
        }
    }

    #[test]
    fn normal_terminal_finish_persists_closed_and_releases_the_lane() {
        let conn = test_db();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        conn.execute(
            "UPDATE print_job_attempts SET state = 'submitting' WHERE id = ?1",
            [attempt.attempt_id.to_string()],
        )
        .unwrap();
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::WindowsQueue("Front".into());
        let mut lease = manager.claim(target.clone()).unwrap();
        assert_eq!(
            manager
                .finish_attempt_for_test(
                    &conn,
                    &mut lease,
                    attempt.attempt_id,
                    DispatchState::Sent,
                    None,
                    at(1),
                )
                .unwrap(),
            ApplyResult::Applied
        );
        drop(lease);
        assert!(manager.claim(target.clone()).is_ok());
        assert_eq!(
            conn.query_row(
                "SELECT circuit_state FROM print_target_state WHERE target_key = ?1",
                [normalize_target(&target).unwrap()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "closed"
        );
    }

    /// Pins the shipped retry ladder below the cap. These assertions used to live in
    /// `print.rs` against `mark_print_job_failed`, which production stopped calling when
    /// the managed pipeline landed -- so the ladder could have drifted from
    /// `ParentTransition::RetryableFailure` without a single red test.
    #[test]
    fn retryable_failure_requeues_and_schedules_backoff_below_max_retries() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, mut lease, attempt) =
            prepared_raw_attempt(&conn, &job_id, "retry-ladder.local", 3, 0);

        assert_eq!(
            manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut lease,
                    attempt.attempt_id,
                    DispatchState::SpoolError,
                    ParentTransition::RetryableFailure {
                        error: "printer offline".into(),
                    },
                    AttemptObservation {
                        now: at(2),
                        last_error: Some("printer offline".into()),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::Applied
        );

        let (status, retry_count, next_retry_at, last_error): (
            String,
            i64,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT status, retry_count, next_retry_at, last_error
                 FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            status, "pending",
            "a retryable failure below the cap must requeue"
        );
        assert_eq!(retry_count, 1);
        assert_eq!(last_error, "printer offline");
        assert!(
            next_retry_at.is_some(),
            "a requeued job must carry its backoff deadline"
        );
    }

    /// The other half of the ladder: the attempt that exhausts `max_retries` is terminal
    /// and must not leave a backoff deadline behind for the worker to pick up.
    #[test]
    fn retryable_failure_is_terminal_once_max_retries_is_reached() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, mut lease, attempt) =
            prepared_raw_attempt(&conn, &job_id, "retry-exhausted.local", 1, 0);

        assert_eq!(
            manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut lease,
                    attempt.attempt_id,
                    DispatchState::SpoolError,
                    ParentTransition::RetryableFailure {
                        error: "printer offline".into(),
                    },
                    AttemptObservation {
                        now: at(2),
                        last_error: Some("printer offline".into()),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::Applied
        );

        let (status, retry_count, next_retry_at): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, retry_count, next_retry_at FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "failed", "the capped attempt must be terminal");
        assert_eq!(retry_count, 1);
        assert!(
            next_retry_at.is_none(),
            "an exhausted job must not schedule another attempt"
        );
    }

    /// Fail-closed contract for an ambiguous dispatch. Production picks
    /// `ParentTransition::ManualFailure` whenever the write may already have reached the
    /// printer (a post-start spooler error, or the dispatch timeout), so the queue must
    /// never re-send a receipt that could duplicate. This used to be asserted indirectly,
    /// by string-matching error text through `is_non_retryable_print_error`.
    #[test]
    fn manual_failure_is_terminal_and_never_schedules_an_auto_retry() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, mut lease, attempt) =
            prepared_raw_attempt(&conn, &job_id, "ambiguous-dispatch.local", 3, 0);

        assert_eq!(
            manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut lease,
                    attempt.attempt_id,
                    DispatchState::Unknown,
                    ParentTransition::ManualFailure {
                        error: "printer state is unknown".into(),
                    },
                    AttemptObservation {
                        now: at(2),
                        last_error: Some("printer state is unknown".into()),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::Applied
        );

        let (status, next_retry_at): (String, Option<String>) = conn
            .query_row(
                "SELECT status, next_retry_at FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert!(
            next_retry_at.is_none(),
            "an ambiguous dispatch must never queue an automatic re-send"
        );
    }

    #[test]
    fn manager_cannot_finish_a_lease_owned_by_another_manager() {
        let conn = test_db();
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        conn.execute(
            "UPDATE print_job_attempts SET state = 'submitting' WHERE id = ?1",
            [attempt.attempt_id.to_string()],
        )
        .unwrap();

        let owner = DispatchManager::isolated_for_test();
        let stranger = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::WindowsQueue("Front".into());
        let mut lease = owner.claim(target).unwrap();
        assert!(matches!(
            stranger.finish_attempt_for_test(
                &conn,
                &mut lease,
                attempt.attempt_id,
                DispatchState::Sent,
                None,
                at(1),
            ),
            Err(DispatchError::LeaseOwnershipMismatch)
        ));
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Submitting
        );
        lease.mark_terminal(DispatchState::TransportError).unwrap();
    }

    #[test]
    fn production_managers_share_one_registry_and_allow_one_concurrent_claim() {
        let target = PrinterTargetKey::WindowsQueue(format!("Shared-{}", uuid::Uuid::new_v4()));
        let managers = [DispatchManager::new(), DispatchManager::new()];
        let start = Arc::new(std::sync::Barrier::new(3));
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
        let mut workers = Vec::new();
        for manager in managers {
            let worker_start = Arc::clone(&start);
            let worker_results = result_tx.clone();
            let worker_release = Arc::clone(&release_rx);
            let worker_target = target.clone();
            workers.push(std::thread::spawn(move || {
                worker_start.wait();
                match manager.claim(worker_target) {
                    Ok(mut lease) => {
                        worker_results.send(true).unwrap();
                        worker_release.lock().unwrap().recv().unwrap();
                        lease.mark_terminal(DispatchState::TransportError).unwrap();
                    }
                    Err(DispatchError::LaneBusy) => worker_results.send(false).unwrap(),
                    Err(error) => panic!("unexpected claim error: {error}"),
                }
            }));
        }
        start.wait();
        let results = [
            result_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            result_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        ];
        assert_eq!(results.into_iter().filter(|won| *won).count(), 1);
        release_tx.send(()).unwrap();
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn terminal_finish_cannot_close_an_already_open_persisted_circuit() {
        let conn = test_db();
        let target = PrinterTargetKey::WindowsQueue(format!("Open-{}", uuid::Uuid::new_v4()));
        let queue = match &target {
            PrinterTargetKey::WindowsQueue(queue) => queue.clone(),
            _ => unreachable!(),
        };

        let unknown_job = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &unknown_job);
        let unknown_attempt = new_windows_attempt(&conn, &unknown_job, 0);
        conn.execute(
            "UPDATE print_job_attempts SET state = 'submitting', resolved_target = ?1 WHERE id = ?2",
            params![queue, unknown_attempt.attempt_id.to_string()],
        )
        .unwrap();

        let terminal_job = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &terminal_job);
        let terminal_attempt = new_windows_attempt(&conn, &terminal_job, 0);
        conn.execute(
            "UPDATE print_job_attempts SET state = 'submitting', resolved_target = ?1 WHERE id = ?2",
            params![queue, terminal_attempt.attempt_id.to_string()],
        )
        .unwrap();

        let opener = DispatchManager::isolated_for_test();
        let finisher = DispatchManager::isolated_for_test();
        let mut open_lease = opener.claim(target.clone()).unwrap();
        let mut terminal_lease = finisher.claim(target.clone()).unwrap();
        assert_eq!(
            opener
                .finish_attempt_for_test(
                    &conn,
                    &mut open_lease,
                    unknown_attempt.attempt_id,
                    DispatchState::Unknown,
                    Some("unknown native state"),
                    at(1),
                )
                .unwrap(),
            ApplyResult::Applied
        );

        assert!(matches!(
            finisher.finish_attempt_for_test(
                &conn,
                &mut terminal_lease,
                terminal_attempt.attempt_id,
                DispatchState::Sent,
                None,
                at(2),
            ),
            Err(DispatchError::CircuitOpen)
        ));
        assert_eq!(
            read_attempt(&conn, terminal_attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Submitting
        );
        let circuit: (String, Option<String>) = conn
            .query_row(
                "SELECT circuit_state, blocked_reason FROM print_target_state WHERE target_key = ?1",
                [normalize_target(&target).unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            circuit,
            ("open".into(), Some("unknown native state".into()))
        );
        drop(open_lease);
        drop(terminal_lease);
    }

    #[test]
    fn target_state_write_failure_rolls_back_attempt_and_retains_lane() {
        let conn = test_db();
        let target = PrinterTargetKey::WindowsQueue(format!("Fault-{}", uuid::Uuid::new_v4()));
        let queue = match &target {
            PrinterTargetKey::WindowsQueue(queue) => queue.clone(),
            _ => unreachable!(),
        };
        let job_id = uuid::Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 0);
        conn.execute(
            "UPDATE print_job_attempts SET state = 'submitting', resolved_target = ?1 WHERE id = ?2",
            params![queue, attempt.attempt_id.to_string()],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER inject_target_state_failure
             BEFORE INSERT ON print_target_state
             BEGIN
                 SELECT RAISE(ABORT, 'injected target-state failure');
             END;",
        )
        .unwrap();

        let manager = DispatchManager::isolated_for_test();
        let mut lease = manager.claim(target.clone()).unwrap();
        assert!(matches!(
            manager.finish_attempt_for_test(
                &conn,
                &mut lease,
                attempt.attempt_id,
                DispatchState::Unknown,
                Some("manual review"),
                at(1),
            ),
            Err(DispatchError::Database(_))
        ));
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Submitting
        );
        assert!(matches!(
            manager.claim(target.clone()),
            Err(DispatchError::LaneBusy)
        ));
        drop(lease);
        assert!(matches!(
            manager.claim(target.clone()),
            Err(DispatchError::LaneBusy)
        ));

        assert!(matches!(
            manager.reconcile(&conn, &target, at(2)),
            Err(DispatchError::TargetStillBlocked)
        ));
        assert!(matches!(
            manager.claim(target.clone()),
            Err(DispatchError::LaneBusy)
        ));
        conn.execute(
            "UPDATE print_job_attempts
             SET state = 'transport_error', completed_at = ?1
             WHERE id = ?2",
            params![timestamp(at(2)), attempt.attempt_id.to_string()],
        )
        .unwrap();
        assert!(matches!(
            manager.reconcile(&conn, &target, at(2)),
            Err(DispatchError::Database(_))
        ));
        conn.execute_batch("DROP TRIGGER inject_target_state_failure;")
            .unwrap();
        manager.reconcile(&conn, &target, at(3)).unwrap();
        assert!(manager.claim(target).is_ok());
    }

    #[test]
    fn poisoned_lane_registry_fails_closed_without_exposing_the_target() {
        let conn = test_db();
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::WindowsQueue(format!("Poison-{}", uuid::Uuid::new_v4()));
        let lease = manager.claim(target.clone()).unwrap();
        let lanes = Arc::clone(&manager.lanes);
        let poisoner = std::thread::spawn(move || {
            let _guard = lanes.lock().unwrap();
            panic!("intentional isolated registry poison");
        });
        assert!(poisoner.join().is_err());

        assert!(matches!(
            manager.claim(target.clone()),
            Err(DispatchError::LockPoisoned)
        ));
        assert!(matches!(
            manager.reconcile(&conn, &target, at(1)),
            Err(DispatchError::LockPoisoned)
        ));
        drop(lease);
        assert!(matches!(
            manager.claim(target),
            Err(DispatchError::LockPoisoned)
        ));
    }

    #[test]
    fn concurrent_claims_choose_one_same_target_winner_without_holding_other_targets() {
        let manager = Arc::new(DispatchManager::isolated_for_test());
        let held = manager
            .claim(PrinterTargetKey::WindowsQueue("Held".into()))
            .unwrap();
        let (other_tx, other_rx) = std::sync::mpsc::channel();
        let other_manager = Arc::clone(&manager);
        let other = std::thread::spawn(move || {
            let mut lease = other_manager
                .claim(PrinterTargetKey::WindowsQueue("Other".into()))
                .unwrap();
            other_tx.send(()).unwrap();
            lease.mark_terminal(DispatchState::Sent).unwrap();
        });
        other_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        other.join().unwrap();
        drop(held);

        let manager = Arc::new(DispatchManager::isolated_for_test());
        let start = Arc::new(std::sync::Barrier::new(3));
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let worker_manager = Arc::clone(&manager);
            let worker_start = Arc::clone(&start);
            let worker_results = result_tx.clone();
            let worker_release = Arc::clone(&release_rx);
            workers.push(std::thread::spawn(move || {
                worker_start.wait();
                match worker_manager.claim(PrinterTargetKey::RawTcp {
                    host: "Printer.Local".into(),
                    port: 9100,
                }) {
                    Ok(_lease) => {
                        worker_results.send(true).unwrap();
                        worker_release.lock().unwrap().recv().unwrap();
                    }
                    Err(DispatchError::LaneBusy) => worker_results.send(false).unwrap(),
                    Err(error) => panic!("unexpected claim error: {error}"),
                }
            }));
        }
        start.wait();
        let results = [
            result_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            result_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        ];
        assert_eq!(results.into_iter().filter(|won| *won).count(), 1);
        release_tx.send(()).unwrap();
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn managed_prepare_claims_parent_snapshot_profile_and_attempt_in_one_transaction() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let payload = b"frozen transport bytes".to_vec();
        let envelope =
            r#"{"version":1,"transport":{"kind":"raw_tcp","host":"printer.local","port":9100}}"#;

        let identity = prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "profile-default".into(),
                target: PrinterTargetKey::RawTcp {
                    host: "printer.local".into(),
                    port: 9100,
                },
                document_kind: "order_receipt".into(),
                payload: payload.clone(),
                render_profile_snapshot_json: envelope.into(),
                now: at(1),
            },
        )
        .expect("atomic preparation");

        let parent: (String, Option<String>) = conn
            .query_row(
                "SELECT status, printer_profile_id FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(parent, ("printing".into(), Some("profile-default".into())));
        assert_eq!(
            crate::print_snapshot::load_snapshot(&conn, &job_id).unwrap(),
            Some(payload)
        );
        assert_eq!(
            conn.query_row(
                "SELECT render_profile_snapshot_json FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            envelope
        );
        assert_eq!(
            read_attempt(&conn, identity.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Created
        );
    }

    #[test]
    fn managed_prepare_rolls_back_parent_and_snapshot_when_attempt_insert_fails() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        conn.execute_batch(
            "CREATE TRIGGER reject_managed_attempt BEFORE INSERT ON print_job_attempts
             BEGIN SELECT RAISE(ABORT, 'injected attempt failure'); END;",
        )
        .unwrap();

        let result = prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "profile-default".into(),
                target: PrinterTargetKey::WindowsQueue("Front".into()),
                document_kind: "order_receipt".into(),
                payload: b"must not persist".to_vec(),
                render_profile_snapshot_json: r#"{"version":1}"#.into(),
                now: at(1),
            },
        );
        assert!(result.is_err());
        let parent: (String, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT status, printer_profile_id, document_snapshot_version FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(parent, ("pending".into(), None, None));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM print_job_attempts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn managed_prepare_atomically_rejects_a_paused_resolved_profile() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        crate::db::set_setting(
            &conn,
            "printing",
            "queue_paused_profile::profile-default",
            "true",
        )
        .unwrap();

        let result = prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "profile-default".into(),
                target: PrinterTargetKey::RawTcp {
                    host: "paused.local".into(),
                    port: 9100,
                },
                document_kind: "order_receipt".into(),
                payload: vec![1, 2, 3],
                render_profile_snapshot_json: r#"{"version":1}"#.into(),
                now: at(1),
            },
        );

        assert!(matches!(result, Err(DispatchError::QueuePaused)));
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "pending"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM print_job_attempts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn managed_prepare_rejects_pending_parent_before_retry_backoff_expires() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        conn.execute(
            "UPDATE print_jobs
             SET next_retry_at = datetime('now', '+5 minutes')
             WHERE id = ?1",
            [&job_id],
        )
        .unwrap();

        let result = prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "profile-default".into(),
                target: PrinterTargetKey::RawTcp {
                    host: "backoff.local".into(),
                    port: 9100,
                },
                document_kind: "order_receipt".into(),
                payload: vec![1, 2, 3],
                render_profile_snapshot_json: r#"{"version":1}"#.into(),
                now: at(1),
            },
        );

        assert!(matches!(result, Err(DispatchError::ParentNotEligible)));
        let parent: (String, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT status, printer_profile_id, document_snapshot_version
                 FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(parent, ("pending".into(), None, None));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM print_job_attempts", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn managed_pre_io_stop_terminalizes_a_started_attempt_without_transport() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "profile".into(),
                target: PrinterTargetKey::RawTcp {
                    host: "stop.local".into(),
                    port: 9100,
                },
                document_kind: "order_receipt".into(),
                payload: vec![1, 2, 3],
                render_profile_snapshot_json: r#"{"version":1}"#.into(),
                now: at(1),
            },
        )
        .unwrap();
        assert_eq!(
            begin_managed_submission(&conn, attempt.attempt_id, at(2)).unwrap(),
            ApplyResult::Applied
        );
        conn.execute(
            "UPDATE print_jobs SET status = 'cancelled' WHERE id = ?1",
            [&job_id],
        )
        .unwrap();

        assert_eq!(
            cancel_managed_submission_before_io(&conn, attempt.attempt_id, at(3)).unwrap(),
            ApplyResult::Applied
        );
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Cancelled
        );
    }

    #[test]
    fn managed_dispatched_parent_stores_the_exact_observation_history_window() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, mut lease, attempt) =
            prepared_raw_attempt(&conn, &job_id, "history-dispatched.local", 3, 0);

        assert_eq!(
            manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut lease,
                    attempt.attempt_id,
                    DispatchState::Sent,
                    ParentTransition::Dispatched {
                        output_path: "receipt.html".into(),
                    },
                    AttemptObservation {
                        now: at(3),
                        bytes_written: Some(3),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::Applied
        );
        assert_parent_history_at(&conn, &job_id, "dispatched", "2026-08-06T10:00:03.000Z");
    }

    #[test]
    fn managed_retryable_failure_stamps_only_the_exhausted_parent() {
        let conn = test_db();
        let pending_id = Uuid::new_v4().to_string();
        let (pending_manager, mut pending_lease, pending_attempt) =
            prepared_raw_attempt(&conn, &pending_id, "history-retry-pending.local", 3, 0);
        assert_eq!(
            pending_manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut pending_lease,
                    pending_attempt.attempt_id,
                    DispatchState::TransportError,
                    ParentTransition::RetryableFailure {
                        error: "temporary transport error".into(),
                    },
                    AttemptObservation {
                        now: at(3),
                        last_error: Some("temporary transport error".into()),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::Applied
        );
        assert_parent_pending_history_at(&conn, &pending_id, "2026-08-06T10:00:03.000Z");

        let exhausted_id = Uuid::new_v4().to_string();
        let (exhausted_manager, mut exhausted_lease, exhausted_attempt) =
            prepared_raw_attempt(&conn, &exhausted_id, "history-retry-exhausted.local", 1, 4);
        assert_eq!(
            exhausted_manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut exhausted_lease,
                    exhausted_attempt.attempt_id,
                    DispatchState::TransportError,
                    ParentTransition::RetryableFailure {
                        error: "exhausted transport error".into(),
                    },
                    AttemptObservation {
                        now: at(7),
                        last_error: Some("exhausted transport error".into()),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::Applied
        );
        assert_parent_history_at(&conn, &exhausted_id, "failed", "2026-08-06T10:00:07.000Z");
    }

    #[test]
    fn managed_manual_failure_stores_the_exact_observation_history_window() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        let (manager, mut lease, attempt) =
            prepared_raw_attempt(&conn, &job_id, "history-manual.local", 3, 8);

        assert_eq!(
            manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut lease,
                    attempt.attempt_id,
                    DispatchState::TransportError,
                    ParentTransition::ManualFailure {
                        error: "manual review required".into(),
                    },
                    AttemptObservation {
                        now: at(11),
                        last_error: Some("manual review required".into()),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::Applied
        );
        assert_parent_history_at(&conn, &job_id, "failed", "2026-08-06T10:00:11.000Z");
    }

    #[test]
    fn managed_terminal_finalizer_is_atomic_and_late_success_cannot_overwrite_parent() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::RawTcp {
            host: "front".into(),
            port: 9100,
        };
        let mut lease = manager.claim(target.clone()).unwrap();
        let attempt = prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "profile".into(),
                target,
                document_kind: "order_receipt".into(),
                payload: vec![1, 2, 3],
                render_profile_snapshot_json: r#"{"version":1}"#.into(),
                now: at(1),
            },
        )
        .unwrap();
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(2),
        )
        .unwrap();

        conn.execute(
            "UPDATE print_jobs SET status = 'cancelled' WHERE id = ?1",
            [&job_id],
        )
        .unwrap();
        assert_eq!(
            manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut lease,
                    attempt.attempt_id,
                    DispatchState::Sent,
                    ParentTransition::Dispatched {
                        output_path: "receipt.html".into()
                    },
                    AttemptObservation {
                        now: at(3),
                        bytes_written: Some(3),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::NotApplied
        );
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Submitting
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "cancelled"
        );
    }

    #[test]
    fn late_terminal_result_from_attempt_a_cannot_finalize_newer_attempt_b_parent_epoch() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::RawTcp {
            host: "epoch.local".into(),
            port: 9100,
        };
        let mut lease = manager.claim(target.clone()).unwrap();
        let request = |now| PrepareManagedAttempt {
            local_job_id: job_id.clone(),
            printer_profile_id: "profile".into(),
            target: target.clone(),
            document_kind: "order_receipt".into(),
            payload: vec![1, 2, 3],
            render_profile_snapshot_json: r#"{"version":1}"#.into(),
            now,
        };
        let attempt_a = prepare_managed_attempt(&conn, request(at(1))).unwrap();
        begin_managed_submission(&conn, attempt_a.attempt_id, at(2)).unwrap();
        conn.execute(
            "UPDATE print_jobs SET status = 'pending' WHERE id = ?1",
            [&job_id],
        )
        .unwrap();
        let attempt_b = prepare_managed_attempt(&conn, request(at(3))).unwrap();
        begin_managed_submission(&conn, attempt_b.attempt_id, at(4)).unwrap();

        assert_eq!(
            manager
                .finalize_attempt_and_parent(
                    &conn,
                    &mut lease,
                    attempt_a.attempt_id,
                    DispatchState::Sent,
                    ParentTransition::Dispatched {
                        output_path: "late-a.html".into(),
                    },
                    AttemptObservation {
                        now: at(5),
                        bytes_written: Some(3),
                        ..AttemptObservation::default()
                    },
                )
                .unwrap(),
            ApplyResult::NotApplied
        );
        assert_eq!(
            read_attempt(&conn, attempt_a.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Submitting
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "printing"
        );
    }

    #[test]
    fn stale_attempt_a_cannot_begin_or_pause_newer_attempt_b_parent_epoch() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let target = PrinterTargetKey::RawTcp {
            host: "begin-epoch.local".into(),
            port: 9100,
        };
        let request = |now| PrepareManagedAttempt {
            local_job_id: job_id.clone(),
            printer_profile_id: "profile".into(),
            target: target.clone(),
            document_kind: "order_receipt".into(),
            payload: vec![1, 2, 3],
            render_profile_snapshot_json: r#"{"version":1}"#.into(),
            now,
        };
        let attempt_a = prepare_managed_attempt(&conn, request(at(1))).unwrap();
        conn.execute(
            "UPDATE print_jobs SET status = 'pending' WHERE id = ?1",
            [&job_id],
        )
        .unwrap();
        let attempt_b = prepare_managed_attempt(&conn, request(at(2))).unwrap();
        crate::db::set_setting(&conn, "printing", "queue_paused", "true").unwrap();

        assert_eq!(
            begin_managed_submission(&conn, attempt_a.attempt_id, at(3)).unwrap(),
            ApplyResult::NotApplied
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "printing"
        );
        assert_eq!(
            read_attempt(&conn, attempt_a.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Cancelled
        );
        assert_eq!(
            read_attempt(&conn, attempt_b.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::Created
        );
    }

    #[test]
    fn restart_hydration_blocks_active_attempts_even_without_target_state_row() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let attempt = new_windows_attempt(&conn, &job_id, 1);
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(2),
        )
        .unwrap();
        persist_spool_started(
            &conn,
            attempt.attempt_id,
            &crate::windows_spooler::SpoolStarted {
                job_id: 77,
                printer_name: "Front".into(),
                document_name: read_attempt(&conn, attempt.attempt_id)
                    .unwrap()
                    .unwrap()
                    .document_name,
                submitted_at: at(3),
            },
        )
        .unwrap();

        let restarted = DispatchManager::hydrate_isolated_for_test(&conn).unwrap();
        assert!(matches!(
            restarted.claim(PrinterTargetKey::WindowsQueue("front".into())),
            Err(DispatchError::LaneBusy)
        ));
    }

    #[test]
    fn windows_acceptance_dispatches_parent_without_terminalizing_attempt_or_lane() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::WindowsQueue("Front".into());
        let lease = manager.claim(target.clone()).unwrap();
        let attempt = prepare_managed_attempt(
            &conn,
            PrepareManagedAttempt {
                local_job_id: job_id.clone(),
                printer_profile_id: "profile".into(),
                target: target.clone(),
                document_kind: "order_receipt".into(),
                payload: vec![1, 2, 3],
                render_profile_snapshot_json: r#"{"version":1}"#.into(),
                now: at(1),
            },
        )
        .unwrap();
        transition_attempt(
            &conn,
            attempt.attempt_id,
            DispatchState::Submitting,
            observation(2),
        )
        .unwrap();
        let marker = read_attempt(&conn, attempt.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        persist_spool_started(
            &conn,
            attempt.attempt_id,
            &crate::windows_spooler::SpoolStarted {
                job_id: 91,
                printer_name: "Front".into(),
                document_name: marker,
                submitted_at: at(3),
            },
        )
        .unwrap();

        assert_eq!(
            manager
                .accept_windows_handoff(&conn, &lease, attempt.attempt_id, "receipt.html", at(4),)
                .unwrap(),
            ApplyResult::Applied
        );
        assert_eq!(
            read_attempt(&conn, attempt.attempt_id)
                .unwrap()
                .unwrap()
                .state,
            DispatchState::WindowsQueued
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "dispatched"
        );
        assert_parent_history_at(&conn, &job_id, "dispatched", "2026-08-06T10:00:04.000Z");
        drop(lease);
        assert!(matches!(
            manager.claim(target),
            Err(DispatchError::LaneBusy)
        ));
    }

    #[test]
    fn late_windows_acceptance_from_attempt_a_cannot_dispatch_newer_attempt_b_parent_epoch() {
        let conn = test_db();
        let job_id = Uuid::new_v4().to_string();
        insert_job(&conn, &job_id);
        let manager = DispatchManager::isolated_for_test();
        let target = PrinterTargetKey::WindowsQueue("Epoch Queue".into());
        let lease = manager.claim(target.clone()).unwrap();
        let request = |now| PrepareManagedAttempt {
            local_job_id: job_id.clone(),
            printer_profile_id: "profile".into(),
            target: target.clone(),
            document_kind: "order_receipt".into(),
            payload: vec![1, 2, 3],
            render_profile_snapshot_json: r#"{"version":1}"#.into(),
            now,
        };
        let attempt_a = prepare_managed_attempt(&conn, request(at(1))).unwrap();
        begin_managed_submission(&conn, attempt_a.attempt_id, at(2)).unwrap();
        let marker = read_attempt(&conn, attempt_a.attempt_id)
            .unwrap()
            .unwrap()
            .document_name;
        persist_spool_started(
            &conn,
            attempt_a.attempt_id,
            &crate::windows_spooler::SpoolStarted {
                job_id: 71,
                printer_name: "Epoch Queue".into(),
                document_name: marker,
                submitted_at: at(3),
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE print_jobs SET status = 'pending' WHERE id = ?1",
            [&job_id],
        )
        .unwrap();
        let attempt_b = prepare_managed_attempt(&conn, request(at(4))).unwrap();
        begin_managed_submission(&conn, attempt_b.attempt_id, at(5)).unwrap();

        assert_eq!(
            manager
                .accept_windows_handoff(&conn, &lease, attempt_a.attempt_id, "late-a.html", at(6),)
                .unwrap(),
            ApplyResult::NotApplied
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM print_jobs WHERE id = ?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "printing"
        );
    }
}
