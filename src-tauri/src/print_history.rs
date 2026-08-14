//! Auditable Retry/Reprint operations for the managed print queue.

use crate::{db::DbState, print};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

const RETRYABLE_STATUS: &str = "failed";
const REPRINTABLE_STATUSES: [&str; 4] = ["printed", "dispatched", "failed", "cancelled"];
const PURGE_ROW_LIMIT: usize = 200;
const FROZEN_VALIDATION_CACHE_CAPACITY: usize = 256;
const ATTEMPT_BLOCKER_PREDICATE_SQL: &str = "
    state IN (
        'created', 'submitting', 'windows_queued',
        'windows_printing', 'paused', 'cancel_requested',
        'unknown', 'cancel_failed'
    )
    OR (
        state = 'spool_error'
        AND typeof(spool_job_id) = 'integer'
        AND spool_job_id BETWEEN 1 AND 4294967295
    )
";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FrozenValidationCacheKey {
    database_scope_digest: [u8; 32],
    database_scope_len: usize,
    job_id_digest: [u8; 32],
    job_id_len: usize,
    document_kind_digest: [u8; 32],
    document_kind_len: usize,
    snapshot_version: i64,
    compressed_len: usize,
    compressed_digest: [u8; 32],
    snapshot_sha256_digest: [u8; 32],
    snapshot_sha256_len: usize,
    render_envelope_digest: [u8; 32],
    render_envelope_len: usize,
}

fn immutable_identity_digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

impl FrozenValidationCacheKey {
    fn new(
        database_scope: &str,
        job_id: &str,
        document_kind: &str,
        snapshot_version: i64,
        compressed_len: usize,
        compressed_digest: [u8; 32],
        snapshot_sha256: &str,
        render_envelope: &str,
    ) -> Self {
        Self {
            database_scope_digest: immutable_identity_digest(database_scope),
            database_scope_len: database_scope.len(),
            job_id_digest: immutable_identity_digest(job_id),
            job_id_len: job_id.len(),
            document_kind_digest: immutable_identity_digest(document_kind),
            document_kind_len: document_kind.len(),
            snapshot_version,
            compressed_len,
            compressed_digest,
            snapshot_sha256_digest: immutable_identity_digest(snapshot_sha256),
            snapshot_sha256_len: snapshot_sha256.len(),
            render_envelope_digest: immutable_identity_digest(render_envelope),
            render_envelope_len: render_envelope.len(),
        }
    }
}

struct FrozenValidationCache {
    capacity: usize,
    entries: HashMap<FrozenValidationCacheKey, Result<(), String>>,
    insertion_order: VecDeque<FrozenValidationCacheKey>,
}

impl FrozenValidationCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            insertion_order: VecDeque::new(),
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    fn get(&self, key: &FrozenValidationCacheKey) -> Option<Result<(), String>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: FrozenValidationCacheKey, result: Result<(), String>) {
        if self.capacity == 0 || self.entries.contains_key(&key) {
            return;
        }
        while self.entries.len() >= self.capacity {
            let Some(oldest) = self.insertion_order.pop_front() else {
                self.entries.clear();
                break;
            };
            self.entries.remove(&oldest);
        }
        self.insertion_order.push_back(key.clone());
        self.entries.insert(key, result);
    }
}

fn cached_frozen_validation_with<F>(
    cache: &Mutex<FrozenValidationCache>,
    key: FrozenValidationCacheKey,
    validate: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    if let Some(cached) = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
    {
        return cached;
    }

    let result = validate();
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, result.clone());
    result
}

fn frozen_validation_cache() -> &'static Mutex<FrozenValidationCache> {
    static CACHE: OnceLock<Mutex<FrozenValidationCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(FrozenValidationCache::new(FROZEN_VALIDATION_CACHE_CAPACITY)))
}

#[derive(Clone, Copy)]
enum ReprintSourceKind {
    OrderBacked,
    SplitPaymentBacked,
    FrozenOnly,
}

struct ReprintSource {
    status: String,
    unexpired: bool,
    entity_type: String,
    entity_id: String,
    entity_payload_json: Option<String>,
    printer_profile_id: Option<String>,
    max_retries: i64,
    document_snapshot_version: Option<i64>,
    document_snapshot_zlib: Option<Vec<u8>>,
    document_snapshot_sha256: Option<String>,
    render_profile_snapshot_json: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct PrintHistoryEligibility {
    pub(crate) retryable: bool,
    pub(crate) reprintable: bool,
}

enum ReprintRuleFailure {
    UnsupportedDocumentType,
    IncompleteFrozenSnapshot,
    InvalidFrozenSnapshot(String),
    MissingLegacySource,
}

impl ReprintRuleFailure {
    fn mutation_error(self) -> String {
        match self {
            Self::UnsupportedDocumentType => {
                "This document type is unavailable for Reprint".to_string()
            }
            Self::IncompleteFrozenSnapshot => {
                "Frozen print snapshot/envelope is incomplete".to_string()
            }
            Self::InvalidFrozenSnapshot(error) => error,
            Self::MissingLegacySource => {
                "A safe compatibility source is unavailable for Reprint".to_string()
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintHistoryMutationResult {
    pub job_id: String,
    pub new_job_id: Option<String>,
    pub affected: usize,
    pub unchanged: bool,
    pub duplicate: bool,
    pub durable_changed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJobPurgeResult {
    pub rows_deleted: usize,
    pub files_deleted: usize,
    pub file_cleanup_skipped: usize,
    pub file_cleanup_failed: usize,
    pub durable_changed: bool,
}

#[derive(Clone, Copy, Debug)]
struct FileInspection {
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    is_reparse_point: bool,
}

trait FileOps {
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf>;
    fn inspect(&self, path: &Path) -> io::Result<FileInspection>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
}

struct RealFileOps;

impl FileOps for RealFileOps {
    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        #[cfg(windows)]
        {
            dunce::canonicalize(path)
        }
        #[cfg(not(windows))]
        {
            fs::canonicalize(path)
        }
    }

    fn inspect(&self, path: &Path) -> io::Result<FileInspection> {
        let metadata = fs::symlink_metadata(path)?;
        #[cfg(windows)]
        let is_reparse_point = {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        };
        #[cfg(not(windows))]
        let is_reparse_point = false;
        Ok(FileInspection {
            is_file: metadata.file_type().is_file(),
            is_directory: metadata.file_type().is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
            is_reparse_point,
        })
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

trait PurgeProbe {
    fn leaf_selection_layer(&self) {}
    fn reference_barrier(&self) {}
}

struct NoopPurgeProbe;

impl PurgeProbe for NoopPurgeProbe {}

#[cfg(windows)]
type CanonicalPathKey = String;
#[cfg(not(windows))]
type CanonicalPathKey = PathBuf;

fn timestamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn mutation_result(
    job_id: &str,
    new_job_id: Option<&str>,
    affected: usize,
    unchanged: bool,
    duplicate: bool,
    durable_changed: bool,
) -> PrintHistoryMutationResult {
    PrintHistoryMutationResult {
        job_id: job_id.to_owned(),
        new_job_id: new_job_id.map(str::to_owned),
        affected,
        unchanged,
        duplicate,
        durable_changed,
    }
}

fn has_attempt_blocker(conn: &Connection, job_id: &str) -> Result<bool, String> {
    let query = format!(
        "SELECT EXISTS(
             SELECT 1
             FROM print_job_attempts
             WHERE print_job_id = ?1
               AND ({ATTEMPT_BLOCKER_PREDICATE_SQL})
         )"
    );
    conn.query_row(&query, [job_id], |row| row.get(0))
        .map_err(|error| format!("Inspect print attempt blockers: {error}"))
}

fn reprint_source_kind(entity_type: &str) -> Option<ReprintSourceKind> {
    match entity_type {
        "order_receipt"
        | "kitchen_ticket"
        | "delivery_slip"
        | "order_completed_receipt"
        | "order_canceled_receipt" => Some(ReprintSourceKind::OrderBacked),
        "split_receipt" => Some(ReprintSourceKind::SplitPaymentBacked),
        "shift_checkout" | "z_report" => Some(ReprintSourceKind::FrozenOnly),
        _ => None,
    }
}

fn has_legacy_compatibility_source(
    conn: &Connection,
    kind: ReprintSourceKind,
    entity_id: &str,
) -> Result<bool, String> {
    let sql = match kind {
        ReprintSourceKind::OrderBacked => "SELECT EXISTS(SELECT 1 FROM orders WHERE id = ?1)",
        ReprintSourceKind::SplitPaymentBacked => {
            "SELECT EXISTS(
                 SELECT 1
                 FROM order_payments payment
                 JOIN orders parent_order ON parent_order.id = payment.order_id
                 WHERE payment.id = ?1 AND payment.status = 'completed'
             )"
        }
        ReprintSourceKind::FrozenOnly => return Ok(false),
    };
    conn.query_row(sql, [entity_id], |row| row.get(0))
        .map_err(|error| format!("Inspect legacy Reprint source: {error}"))
}

fn read_reprint_source(
    conn: &Connection,
    job_id: &str,
    now: &str,
) -> rusqlite::Result<Option<ReprintSource>> {
    conn.query_row(
        "SELECT status,
                history_expires_at IS NOT NULL
                AND julianday(history_expires_at) > julianday(?2),
                entity_type, entity_id, entity_payload_json,
                printer_profile_id, max_retries,
                document_snapshot_version, document_snapshot_zlib,
                document_snapshot_sha256, render_profile_snapshot_json
         FROM print_jobs
         WHERE id = ?1",
        params![job_id, now],
        |row| {
            Ok(ReprintSource {
                status: row.get(0)?,
                unexpired: row.get(1)?,
                entity_type: row.get(2)?,
                entity_id: row.get(3)?,
                entity_payload_json: row.get(4)?,
                printer_profile_id: row.get(5)?,
                max_retries: row.get(6)?,
                document_snapshot_version: row.get(7)?,
                document_snapshot_zlib: row.get(8)?,
                document_snapshot_sha256: row.get(9)?,
                render_profile_snapshot_json: row.get(10)?,
            })
        },
    )
    .optional()
}

fn frozen_source_fields(source: &ReprintSource) -> Result<(i64, &[u8], &str, &str), String> {
    let version = source
        .document_snapshot_version
        .ok_or_else(|| "Frozen print snapshot/envelope is incomplete".to_string())?;
    let compressed = source
        .document_snapshot_zlib
        .as_deref()
        .ok_or_else(|| "Frozen print snapshot/envelope is incomplete".to_string())?;
    let sha256 = source
        .document_snapshot_sha256
        .as_deref()
        .ok_or_else(|| "Frozen print snapshot/envelope is incomplete".to_string())?;
    let envelope = source
        .render_profile_snapshot_json
        .as_deref()
        .ok_or_else(|| "Frozen print snapshot/envelope is incomplete".to_string())?;
    Ok((version, compressed, sha256, envelope))
}

fn validate_frozen_source(source: &ReprintSource) -> Result<(), String> {
    let (version, compressed, sha256, envelope) = frozen_source_fields(source)?;
    print::validate_frozen_print_snapshot_for_history(
        version,
        compressed,
        sha256,
        envelope,
        &source.entity_type,
    )
}

fn evaluate_reprint_source_with_validator<F>(
    conn: &Connection,
    source: &ReprintSource,
    validate_frozen: F,
) -> Result<Result<(), ReprintRuleFailure>, String>
where
    F: FnOnce(&ReprintSource) -> Result<(), String>,
{
    let Some(source_kind) = reprint_source_kind(&source.entity_type) else {
        return Ok(Err(ReprintRuleFailure::UnsupportedDocumentType));
    };

    let snapshot_presence = (
        source.document_snapshot_version.is_some(),
        source.document_snapshot_zlib.is_some(),
        source.document_snapshot_sha256.is_some(),
        source.render_profile_snapshot_json.is_some(),
    );
    match snapshot_presence {
        (false, false, false, false) => {
            if has_legacy_compatibility_source(conn, source_kind, &source.entity_id)? {
                Ok(Ok(()))
            } else {
                Ok(Err(ReprintRuleFailure::MissingLegacySource))
            }
        }
        (true, true, true, true) => match validate_frozen(source) {
            Ok(()) => Ok(Ok(())),
            Err(error) => Ok(Err(ReprintRuleFailure::InvalidFrozenSnapshot(error))),
        },
        _ => Ok(Err(ReprintRuleFailure::IncompleteFrozenSnapshot)),
    }
}

fn evaluate_reprint_source(
    conn: &Connection,
    source: &ReprintSource,
) -> Result<Result<(), ReprintRuleFailure>, String> {
    evaluate_reprint_source_with_validator(conn, source, validate_frozen_source)
}

fn print_history_eligibility_with_validator<F>(
    conn: &Connection,
    job_id: &str,
    now: DateTime<Utc>,
    validate_frozen: F,
) -> Result<PrintHistoryEligibility, String>
where
    F: FnOnce(&ReprintSource) -> Result<(), String>,
{
    let now = timestamp(now);
    let Some(source) = read_reprint_source(conn, job_id, &now)
        .map_err(|error| format!("Inspect print history eligibility: {error}"))?
    else {
        return Ok(PrintHistoryEligibility::default());
    };
    if !source.unexpired || has_attempt_blocker(conn, job_id)? {
        return Ok(PrintHistoryEligibility::default());
    }

    let retryable = source.status == RETRYABLE_STATUS;
    let reprintable = if REPRINTABLE_STATUSES.contains(&source.status.as_str()) {
        evaluate_reprint_source_with_validator(conn, &source, validate_frozen)?.is_ok()
    } else {
        false
    };
    Ok(PrintHistoryEligibility {
        retryable,
        reprintable,
    })
}

#[cfg(test)]
pub(crate) fn print_history_eligibility(
    conn: &Connection,
    job_id: &str,
    now: DateTime<Utc>,
) -> Result<PrintHistoryEligibility, String> {
    print_history_eligibility_with_validator(conn, job_id, now, validate_frozen_source)
}

fn print_history_eligibility_with_validation_cache(
    conn: &Connection,
    database_scope: &str,
    job_id: &str,
    now: DateTime<Utc>,
    cache: &Mutex<FrozenValidationCache>,
) -> Result<PrintHistoryEligibility, String> {
    print_history_eligibility_with_validator(conn, job_id, now, |source| {
        let (version, compressed, sha256, envelope) = frozen_source_fields(source)?;
        let key = FrozenValidationCacheKey::new(
            database_scope,
            job_id,
            &source.entity_type,
            version,
            compressed.len(),
            Sha256::digest(compressed).into(),
            sha256,
            envelope,
        );
        cached_frozen_validation_with(cache, key, || validate_frozen_source(source))
    })
}

pub(crate) fn print_history_eligibility_cached(
    conn: &Connection,
    database_scope: &str,
    job_id: &str,
    now: DateTime<Utc>,
) -> Result<PrintHistoryEligibility, String> {
    print_history_eligibility_with_validation_cache(
        conn,
        database_scope,
        job_id,
        now,
        frozen_validation_cache(),
    )
}

fn begin_immediate(
    db: &DbState,
) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    db.conn
        .lock()
        .map_err(|_| "Print history database lock is poisoned".to_string())
}

pub fn retry_failed_print_job(
    db: &DbState,
    job_id: &str,
    now: DateTime<Utc>,
) -> Result<PrintHistoryMutationResult, String> {
    let now = timestamp(now);
    let mut conn = begin_immediate(db)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Begin Retry transaction: {error}"))?;

    let eligibility = tx
        .query_row(
            "SELECT status,
                    history_expires_at IS NOT NULL
                    AND julianday(history_expires_at) > julianday(?2)
             FROM print_jobs
             WHERE id = ?1",
            params![job_id, now],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Read Retry source: {error}"))?
        .ok_or_else(|| "Print job is not available for Retry".to_string())?;
    if eligibility.0 != RETRYABLE_STATUS || !eligibility.1 {
        return Err("Print job is not available for Retry".into());
    }
    if has_attempt_blocker(&tx, job_id)? {
        return Err("Print job still has an active transport attempt".into());
    }

    let affected = tx
        .execute(
            "UPDATE print_jobs
             SET status = 'pending', retry_count = 0,
                 next_retry_at = NULL, last_error = NULL,
                 warning_code = NULL, warning_message = NULL,
                 last_attempt_at = NULL, completed_at = NULL,
                 history_expires_at = NULL, updated_at = ?2
             WHERE id = ?1 AND status = 'failed'",
            params![job_id, now],
        )
        .map_err(|error| format!("Reset print job for Retry: {error}"))?;
    if affected != 1 {
        return Err("Print job changed before Retry could be committed".into());
    }
    tx.commit()
        .map_err(|error| format!("Commit Retry transaction: {error}"))?;

    Ok(mutation_result(job_id, None, 1, false, false, true))
}

pub fn clone_reprint_job(
    db: &DbState,
    source_job_id: &str,
    now: DateTime<Utc>,
) -> Result<PrintHistoryMutationResult, String> {
    let now = timestamp(now);
    let mut conn = begin_immediate(db)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Begin Reprint transaction: {error}"))?;

    let source = read_reprint_source(&tx, source_job_id, &now)
        .map_err(|error| format!("Read Reprint source: {error}"))?
        .ok_or_else(|| "Print job is not available for Reprint".to_string())?;
    if !REPRINTABLE_STATUSES.contains(&source.status.as_str()) || !source.unexpired {
        return Err("Print job is not available for Reprint".into());
    }
    if has_attempt_blocker(&tx, source_job_id)? {
        return Err("Print job still has an active transport attempt".into());
    }

    if let Err(failure) = evaluate_reprint_source(&tx, &source)? {
        return Err(failure.mutation_error());
    }

    let active_child_query = format!(
        "SELECT child.id
             FROM print_jobs child
             WHERE child.reprint_of_job_id = ?1
               AND (
                    child.status IN ('pending', 'printing')
                    OR EXISTS(
                        SELECT 1
                        FROM print_job_attempts attempt
                        WHERE attempt.print_job_id = child.id
                          AND ({ATTEMPT_BLOCKER_PREDICATE_SQL})
                    )
               )
             ORDER BY child.created_at ASC, child.id ASC
             LIMIT 1"
    );
    let active_child = tx
        .query_row(&active_child_query, [source_job_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|error| format!("Inspect active Reprint child: {error}"))?;
    if let Some(child_id) = active_child {
        tx.commit()
            .map_err(|error| format!("Commit coalesced Reprint transaction: {error}"))?;
        return Ok(mutation_result(
            source_job_id,
            Some(&child_id),
            0,
            true,
            true,
            false,
        ));
    }

    let child_id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO print_jobs (
             id, entity_type, entity_id, entity_payload_json,
             printer_profile_id, status, output_path, retry_count,
             max_retries, next_retry_at, last_error, warning_code,
             warning_message, last_attempt_at, created_at, updated_at,
             document_snapshot_version, document_snapshot_zlib,
             document_snapshot_sha256, render_profile_snapshot_json,
             reprint_of_job_id, completed_at, history_expires_at
         ) VALUES (
             ?1, ?2, ?3, ?4, ?5, 'pending', NULL, 0,
             ?6, NULL, NULL, NULL, NULL, NULL, ?7, ?7,
             ?8, ?9, ?10, ?11, ?12, NULL, NULL
         )",
        params![
            child_id,
            source.entity_type,
            source.entity_id,
            source.entity_payload_json,
            source.printer_profile_id,
            source.max_retries,
            now,
            source.document_snapshot_version,
            source.document_snapshot_zlib,
            source.document_snapshot_sha256,
            source.render_profile_snapshot_json,
            source_job_id,
        ],
    )
    .map_err(|error| format!("Insert Reprint child: {error}"))?;
    tx.commit()
        .map_err(|error| format!("Commit Reprint transaction: {error}"))?;

    Ok(mutation_result(
        source_job_id,
        Some(&child_id),
        1,
        false,
        false,
        true,
    ))
}

fn canonical_path_key(path: &Path) -> CanonicalPathKey {
    #[cfg(windows)]
    {
        path.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

fn has_parent_traversal(path: &Path) -> bool {
    path.components()
        .any(|component| component == Component::ParentDir)
}

fn has_only_trusted_components<O: FileOps + ?Sized>(ops: &O, path: &Path) -> bool {
    if !path.is_absolute() || has_parent_traversal(path) {
        return false;
    }

    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if !current.is_absolute() {
            continue;
        }
        let Ok(inspection) = ops.inspect(&current) else {
            return false;
        };
        if inspection.is_symlink || inspection.is_reparse_point {
            return false;
        }
    }
    true
}

fn trusted_receipts_root<O: FileOps + ?Sized>(ops: &O, data_dir: &Path) -> Option<PathBuf> {
    let receipts_root = data_dir.join("receipts");
    if !has_only_trusted_components(ops, &receipts_root) {
        return None;
    }
    let canonical_root = ops.canonicalize(&receipts_root).ok()?;
    if !has_only_trusted_components(ops, &canonical_root) {
        return None;
    }
    let root_inspection = ops.inspect(&canonical_root).ok()?;
    if !root_inspection.is_directory
        || root_inspection.is_file
        || root_inspection.is_symlink
        || root_inspection.is_reparse_point
    {
        return None;
    }
    Some(canonical_root)
}

fn trusted_artifact_candidate<O: FileOps + ?Sized>(
    ops: &O,
    candidate: &Path,
    canonical_root: &Path,
) -> Option<PathBuf> {
    if !has_only_trusted_components(ops, candidate) {
        return None;
    }
    let canonical_candidate = ops.canonicalize(candidate).ok()?;
    if canonical_candidate == canonical_root || !canonical_candidate.starts_with(canonical_root) {
        return None;
    }
    if !has_only_trusted_components(ops, &canonical_candidate) {
        return None;
    }
    let inspection = ops.inspect(&canonical_candidate).ok()?;
    if !inspection.is_file
        || inspection.is_directory
        || inspection.is_symlink
        || inspection.is_reparse_point
    {
        return None;
    }
    Some(canonical_candidate)
}

fn current_artifact_references<O: FileOps + ?Sized>(
    conn: &Connection,
    ops: &O,
) -> Result<(HashSet<PathBuf>, HashSet<CanonicalPathKey>), ()> {
    let mut statement = conn
        .prepare("SELECT output_path FROM print_jobs WHERE output_path IS NOT NULL")
        .map_err(|_| ())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| ())?;
    let raw = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?
        .into_iter()
        .map(PathBuf::from)
        .collect::<HashSet<_>>();
    let mut canonical = HashSet::with_capacity(raw.len());
    for path in &raw {
        let canonical_path = ops.canonicalize(path).map_err(|_| ())?;
        canonical.insert(canonical_path_key(&canonical_path));
    }
    Ok((raw, canonical))
}

fn cleanup_deleted_artifacts<O: FileOps + ?Sized>(
    db: &DbState,
    ops: &O,
    probe: &impl PurgeProbe,
    data_dir: &Path,
    deleted_output_paths: Vec<PathBuf>,
    result: &mut PrintJobPurgeResult,
) {
    let mut seen_raw_candidates = HashSet::new();
    let candidates = deleted_output_paths
        .into_iter()
        .filter(|path| seen_raw_candidates.insert(path.clone()))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return;
    }

    let Some(canonical_root) = trusted_receipts_root(ops, data_dir) else {
        result.file_cleanup_skipped += candidates.len();
        return;
    };
    let canonical_root_key = canonical_path_key(&canonical_root);

    let mut seen_canonical_candidates = HashSet::new();
    let mut removable = Vec::new();

    for candidate in candidates {
        let Some(canonical_candidate) =
            trusted_artifact_candidate(ops, &candidate, &canonical_root)
        else {
            result.file_cleanup_skipped += 1;
            continue;
        };
        let candidate_key = canonical_path_key(&canonical_candidate);
        if !seen_canonical_candidates.insert(candidate_key.clone()) {
            continue;
        }
        removable.push((candidate, candidate_key));
    }

    if removable.is_empty() {
        return;
    }

    probe.reference_barrier();
    let Ok(mut conn) = begin_immediate(db) else {
        result.file_cleanup_skipped += removable.len();
        return;
    };
    let Ok(tx) = conn.transaction_with_behavior(TransactionBehavior::Immediate) else {
        result.file_cleanup_skipped += removable.len();
        return;
    };
    let Ok((surviving_raw, surviving_canonical)) = current_artifact_references(&tx, ops) else {
        result.file_cleanup_skipped += removable.len();
        let _ = tx.commit();
        return;
    };
    let Some(revalidated_root) = trusted_receipts_root(ops, data_dir) else {
        result.file_cleanup_skipped += removable.len();
        let _ = tx.commit();
        return;
    };
    if canonical_path_key(&revalidated_root) != canonical_root_key {
        result.file_cleanup_skipped += removable.len();
        let _ = tx.commit();
        return;
    }

    for (candidate, expected_key) in removable {
        if surviving_raw.contains(&candidate) || surviving_canonical.contains(&expected_key) {
            result.file_cleanup_skipped += 1;
            continue;
        }
        let revalidated_candidate = trusted_artifact_candidate(ops, &candidate, &revalidated_root);
        let Some(revalidated_candidate) =
            revalidated_candidate.filter(|path| canonical_path_key(path) == expected_key)
        else {
            result.file_cleanup_skipped += 1;
            continue;
        };
        match ops.remove_file(&revalidated_candidate) {
            Ok(()) => result.files_deleted += 1,
            Err(_) => result.file_cleanup_failed += 1,
        }
    }
    let _ = tx.commit();
}

pub fn purge_expired_print_jobs_at(
    db: &DbState,
    data_dir: &Path,
    now: DateTime<Utc>,
) -> Result<PrintJobPurgeResult, String> {
    purge_expired_print_jobs_at_with_file_ops(db, data_dir, now, &RealFileOps)
}

fn purge_expired_print_jobs_at_with_file_ops<O: FileOps + ?Sized>(
    db: &DbState,
    data_dir: &Path,
    now: DateTime<Utc>,
    file_ops: &O,
) -> Result<PrintJobPurgeResult, String> {
    purge_expired_print_jobs_at_with_file_ops_and_probe(
        db,
        data_dir,
        now,
        file_ops,
        &NoopPurgeProbe,
    )
}

fn purge_expired_print_jobs_at_with_file_ops_and_probe<O: FileOps + ?Sized>(
    db: &DbState,
    data_dir: &Path,
    now: DateTime<Utc>,
    file_ops: &O,
    probe: &impl PurgeProbe,
) -> Result<PrintJobPurgeResult, String> {
    let now = timestamp(now);
    let mut conn = begin_immediate(db)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Begin print history purge transaction: {error}"))?;
    let mut rows_deleted = 0usize;
    let mut deleted_output_paths = Vec::new();

    while rows_deleted < PURGE_ROW_LIMIT {
        probe.leaf_selection_layer();
        let candidates = {
            let expired_leaf_selection_query = format!(
                "SELECT job.id, job.output_path
                 FROM print_jobs job
                 WHERE job.status IN ('printed', 'dispatched', 'failed', 'cancelled')
                   AND job.history_expires_at IS NOT NULL
                   AND julianday(job.history_expires_at) <= julianday(?1)
                   AND NOT EXISTS (
                       SELECT 1
                       FROM print_job_attempts attempt
                       WHERE attempt.print_job_id = job.id
                         AND ({ATTEMPT_BLOCKER_PREDICATE_SQL})
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM print_jobs child
                       WHERE child.reprint_of_job_id = job.id
                   )
                 ORDER BY julianday(job.history_expires_at), job.id
                 LIMIT ?2"
            );
            let mut statement = tx
                .prepare(&expired_leaf_selection_query)
                .map_err(|error| format!("Prepare expired print history leaf layer: {error}"))?;
            let rows = statement
                .query_map(
                    params![now, (PURGE_ROW_LIMIT - rows_deleted) as i64],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|error| format!("Select expired print history leaf layer: {error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Collect expired print history leaf layer: {error}"))?
        };
        if candidates.is_empty() {
            break;
        }

        for (job_id, output_path) in candidates {
            let expired_leaf_delete_query = format!(
                "DELETE FROM print_jobs
                 WHERE id = ?1
                   AND status IN ('printed', 'dispatched', 'failed', 'cancelled')
                   AND history_expires_at IS NOT NULL
                   AND julianday(history_expires_at) <= julianday(?2)
                   AND NOT EXISTS (
                       SELECT 1
                       FROM print_job_attempts attempt
                       WHERE attempt.print_job_id = print_jobs.id
                         AND ({ATTEMPT_BLOCKER_PREDICATE_SQL})
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM print_jobs child
                       WHERE child.reprint_of_job_id = print_jobs.id
                   )"
            );
            let changed = tx
                .execute(&expired_leaf_delete_query, params![job_id, now])
                .map_err(|error| format!("Delete expired print history leaf: {error}"))?;
            if changed != 1 {
                return Err("Expired print history leaf changed before deletion".into());
            }
            rows_deleted += 1;
            if let Some(output_path) = output_path {
                deleted_output_paths.push(PathBuf::from(output_path));
            }
        }
    }

    tx.commit()
        .map_err(|error| format!("Commit print history purge transaction: {error}"))?;
    drop(conn);

    let mut result = PrintJobPurgeResult {
        rows_deleted,
        files_deleted: 0,
        file_cleanup_skipped: 0,
        file_cleanup_failed: 0,
        durable_changed: rows_deleted > 0,
    };
    cleanup_deleted_artifacts(
        db,
        file_ops,
        probe,
        data_dir,
        deleted_output_paths,
        &mut result,
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        cached_frozen_validation_with, clone_reprint_job, print_history_eligibility,
        print_history_eligibility_with_validation_cache, purge_expired_print_jobs_at,
        purge_expired_print_jobs_at_with_file_ops,
        purge_expired_print_jobs_at_with_file_ops_and_probe, retry_failed_print_job,
        FileInspection, FileOps, FrozenValidationCache, FrozenValidationCacheKey,
        PrintHistoryEligibility, PrintHistoryMutationResult, PrintJobPurgeResult, PurgeProbe,
    };
    use crate::{db, print_snapshot};
    use chrono::{DateTime, Utc};
    use rusqlite::{params, types::Value, Connection};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;
    use uuid::Uuid;

    const NOW: &str = "2026-08-07T12:00:00Z";
    const FUTURE: &str = "2026-09-06T12:00:00Z";

    fn now() -> DateTime<Utc> {
        NOW.parse().expect("valid deterministic Task 8 time")
    }

    fn test_db() -> db::DbState {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("configure test db");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        }
    }

    fn test_file_db_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "the-small-task8-history-{}-{}.sqlite",
            std::process::id(),
            Uuid::new_v4()
        ))
    }

    fn open_file_db(path: &PathBuf) -> db::DbState {
        let conn = Connection::open(path).expect("open file db");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )
        .expect("configure file db");
        db::run_migrations_for_test(&conn);
        db::DbState {
            conn: Mutex::new(conn),
            db_path: path.clone(),
        }
    }

    fn valid_envelope(document_kind: &str) -> String {
        json!({
            "version": 2,
            "renderer_layout_revision": "task8-test-revision",
            "effective_profile_id": "profile-frozen",
            "effective_profile_name": "Frozen Printer",
            "driver_type": "escpos",
            "document_kind": document_kind,
            "transport": { "kind": "raw_tcp", "host": "192.0.2.10", "port": 9100 },
            "paper_width_mm": 80,
            "printable_width_dots": 576,
            "left_margin_dots": 0,
            "encoding": "cp737",
            "code_page": 15,
            "greek_render_mode": null,
            "command_profile": "full_style",
            "emulation": "escpos",
            "template": "classic",
            "font_type": "a",
            "layout_density": "balanced",
            "header_emphasis": "normal",
            "layout_density_scale": 1.0,
            "text_scale": 1.0,
            "classic_customer_render_mode": "text",
            "raster_threshold": 128,
            "body_font_weight": 600,
            "decimal_comma": true,
            "detected_brand": "generic",
            "language": "el",
            "organization_name": "Task 8 Store",
            "store_subtitle": null,
            "store_address": null,
            "store_phone": null,
            "vat_number": null,
            "tax_office": null,
            "footer_text": null,
            "show_qr_code": false,
            "qr_configured": false,
            "copy_label": null,
            "currency_symbol": "EUR",
            "cut_paper": true,
            "logo_enabled": false,
            "logo_configured": false,
            "logo_included": false,
            "logo_scale": 1.0,
            "drawer": {
                "profile_id": "profile-frozen",
                "enabled": false,
                "mode": "none",
                "host": null,
                "port": 9100
            },
            "warning_codes": []
        })
        .to_string()
    }

    fn insert_job(conn: &Connection, id: &str, entity_type: &str, status: &str, frozen: bool) {
        let encoded = print_snapshot::encode_print_payload(
            format!("frozen-payload:{entity_type}:{id}").as_bytes(),
        )
        .expect("encode frozen payload");
        conn.execute(
            "INSERT INTO print_jobs (
                id, entity_type, entity_id, entity_payload_json,
                printer_profile_id, status, output_path, retry_count,
                max_retries, next_retry_at, last_error, warning_code,
                warning_message, last_attempt_at, created_at, updated_at,
                document_snapshot_version, document_snapshot_zlib,
                document_snapshot_sha256, render_profile_snapshot_json,
                completed_at, history_expires_at
             ) VALUES (
                ?1, ?2, ?3, ?4, 'profile-frozen', ?5, 'C:/old/output.html',
                2, 7, '2026-08-07T12:05:00Z', 'old failure', 'warn-code',
                'old warning', '2026-08-07T11:59:00Z',
                '2026-08-01T10:00:00Z', '2026-08-07T11:59:00Z',
                ?6, ?7, ?8, ?9, '2026-08-07T11:59:00Z', ?10
             )",
            params![
                id,
                entity_type,
                format!("entity-{id}"),
                format!(r#"{{"source":"{id}"}}"#),
                status,
                frozen.then_some(encoded.version),
                frozen.then_some(encoded.compressed),
                frozen.then_some(encoded.sha256),
                frozen.then(|| valid_envelope(entity_type)),
                FUTURE,
            ],
        )
        .expect("insert Task 8 print job");
    }

    fn insert_attempt_numbered(
        conn: &Connection,
        job_id: &str,
        attempt_number: i64,
        state: &str,
        spool_job_id: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO print_job_attempts (
                id, print_job_id, attempt_number, transport, resolved_target,
                document_name, spool_job_id, state, started_at
             ) VALUES (?1, ?2, ?3, 'windows', 'Task8 Queue',
                       'Task8 Document', ?4, ?5, ?6)",
            params![
                Uuid::new_v4().to_string(),
                job_id,
                attempt_number,
                spool_job_id,
                state,
                NOW
            ],
        )
        .expect("insert Task 8 attempt");
    }

    fn insert_attempt(conn: &Connection, job_id: &str, state: &str, spool_job_id: Option<i64>) {
        insert_attempt_numbered(conn, job_id, 1, state, spool_job_id);
    }

    fn insert_attempt_with_spool_value(
        conn: &Connection,
        job_id: &str,
        state: &str,
        spool_job_id: Value,
    ) {
        conn.execute(
            "INSERT INTO print_job_attempts (
                id, print_job_id, attempt_number, transport, resolved_target,
                document_name, spool_job_id, state, started_at
             ) VALUES (?1, ?2, 1, 'windows', 'Task8 Queue',
                       'Task8 Document', ?3, ?4, ?5)",
            params![Uuid::new_v4().to_string(), job_id, spool_job_id, state, NOW],
        )
        .expect("insert Task 8 attempt with an exact SQLite spool identity type");
    }

    fn invalid_spool_job_id_values() -> Vec<(&'static str, Value)> {
        vec![
            ("null", Value::Null),
            ("zero", Value::Integer(0)),
            ("negative", Value::Integer(-1)),
            ("over-u32", Value::Integer(i64::from(u32::MAX) + 1)),
            ("real", Value::Real(42.5)),
            ("text", Value::Text("not-a-job-id".to_string())),
            ("blob", Value::Blob(vec![42])),
        ]
    }

    #[derive(Clone, Copy)]
    enum FrozenFixtureFault {
        None,
        Codec,
        Hash,
    }

    fn install_frozen_fixture(
        conn: &Connection,
        id: &str,
        entity_type: &str,
        envelope: String,
        fault: FrozenFixtureFault,
    ) {
        let encoded = print_snapshot::encode_print_payload(
            format!("eligibility-payload:{entity_type}:{id}").as_bytes(),
        )
        .expect("encode eligibility payload");
        let sha256 = if matches!(fault, FrozenFixtureFault::Hash) {
            "0".repeat(64)
        } else {
            encoded.sha256
        };
        let version = if matches!(fault, FrozenFixtureFault::Codec) {
            encoded.version + 1
        } else {
            encoded.version
        };
        conn.execute(
            "UPDATE print_jobs
             SET document_snapshot_version = ?2,
                 document_snapshot_zlib = ?3,
                 document_snapshot_sha256 = ?4,
                 render_profile_snapshot_json = ?5
             WHERE id = ?1",
            params![id, version, encoded.compressed, sha256, envelope],
        )
        .expect("install eligibility frozen fixture");
    }

    fn eligibility(conn: &Connection, id: &str) -> PrintHistoryEligibility {
        print_history_eligibility(conn, id, now()).expect("inspect print history eligibility")
    }

    #[test]
    fn history_eligibility_covers_status_expiry_and_all_attempt_blockers() {
        let db = test_db();
        let blockers = [
            ("created", None),
            ("submitting", None),
            ("windows_queued", Some(41)),
            ("windows_printing", Some(42)),
            ("paused", Some(43)),
            ("cancel_requested", Some(44)),
            ("unknown", Some(45)),
            ("cancel_failed", Some(46)),
            ("spool_error", Some(1)),
            ("spool_error", Some(i64::from(u32::MAX))),
        ];
        {
            let conn = db.conn.lock().unwrap();
            for status in ["printed", "dispatched", "failed", "cancelled"] {
                insert_job(
                    &conn,
                    &format!("eligible-{status}"),
                    "order_receipt",
                    status,
                    true,
                );
                let expired_id = format!("expired-{status}");
                insert_job(&conn, &expired_id, "order_receipt", status, true);
                conn.execute(
                    "UPDATE print_jobs SET history_expires_at = ?2 WHERE id = ?1",
                    params![expired_id, NOW],
                )
                .unwrap();
            }
            for status in ["pending", "printing"] {
                insert_job(
                    &conn,
                    &format!("nonterminal-{status}"),
                    "order_receipt",
                    status,
                    true,
                );
            }

            for (index, (state, spool_job_id)) in blockers.iter().copied().enumerate() {
                let id = format!("eligibility-blocker-{index}");
                insert_job(&conn, &id, "order_receipt", "failed", true);
                insert_attempt(&conn, &id, state, spool_job_id);
            }

            for (identity, spool_job_id) in invalid_spool_job_id_values() {
                let id = format!("eligibility-invalid-spool-{identity}");
                insert_job(&conn, &id, "order_receipt", "failed", true);
                insert_attempt_with_spool_value(&conn, &id, "spool_error", spool_job_id);
            }

            insert_job(
                &conn,
                "older-blocker-newer-terminal",
                "order_receipt",
                "failed",
                true,
            );
            insert_attempt_numbered(
                &conn,
                "older-blocker-newer-terminal",
                1,
                "unknown",
                Some(88),
            );
            insert_attempt_numbered(&conn, "older-blocker-newer-terminal", 2, "sent", Some(88));
        }

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            eligibility(&conn, "missing-history-job"),
            PrintHistoryEligibility {
                retryable: false,
                reprintable: false,
            }
        );
        for status in ["printed", "dispatched", "failed", "cancelled"] {
            assert_eq!(
                eligibility(&conn, &format!("eligible-{status}")),
                PrintHistoryEligibility {
                    retryable: status == "failed",
                    reprintable: true,
                },
                "terminal state {status}"
            );
            assert_eq!(
                eligibility(&conn, &format!("expired-{status}")),
                PrintHistoryEligibility {
                    retryable: false,
                    reprintable: false,
                },
                "expired terminal state {status}"
            );
        }
        for status in ["pending", "printing"] {
            assert_eq!(
                eligibility(&conn, &format!("nonterminal-{status}")),
                PrintHistoryEligibility {
                    retryable: false,
                    reprintable: false,
                },
                "nonterminal state {status}"
            );
        }
        for index in 0..blockers.len() {
            assert_eq!(
                eligibility(&conn, &format!("eligibility-blocker-{index}")),
                PrintHistoryEligibility {
                    retryable: false,
                    reprintable: false,
                },
                "blocker fixture {index}"
            );
        }
        for (identity, _) in invalid_spool_job_id_values() {
            assert_eq!(
                eligibility(&conn, &format!("eligibility-invalid-spool-{identity}")),
                PrintHistoryEligibility {
                    retryable: true,
                    reprintable: true,
                },
                "invalid SQLite spool identity {identity} must not block eligibility"
            );
        }
        assert_eq!(
            eligibility(&conn, "older-blocker-newer-terminal"),
            PrintHistoryEligibility {
                retryable: false,
                reprintable: false,
            },
            "an older unresolved attempt must not be hidden by a newer terminal attempt"
        );
    }

    #[test]
    fn history_eligibility_applies_legacy_split_and_frozen_validation_rules() {
        let db = test_db();
        let direct_legacy_types = [
            "order_receipt",
            "kitchen_ticket",
            "delivery_slip",
            "order_completed_receipt",
            "order_canceled_receipt",
        ];
        {
            let conn = db.conn.lock().unwrap();
            for entity_type in direct_legacy_types {
                let id = format!("eligibility-legacy-{entity_type}");
                insert_job(&conn, &id, entity_type, "printed", false);
                conn.execute(
                    "INSERT INTO orders (id) VALUES (?1)",
                    [format!("entity-{id}")],
                )
                .unwrap();
            }
            insert_job(
                &conn,
                "eligibility-legacy-missing-order",
                "order_receipt",
                "printed",
                false,
            );

            insert_job(
                &conn,
                "eligibility-split-completed",
                "split_receipt",
                "printed",
                false,
            );
            conn.execute(
                "INSERT INTO orders (id) VALUES ('eligibility-split-parent')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                     id, order_id, method, amount, status, created_at, updated_at
                 ) VALUES (
                     'entity-eligibility-split-completed', 'eligibility-split-parent',
                     'cash', 5.0, 'completed', ?1, ?1
                 )",
                [NOW],
            )
            .unwrap();

            insert_job(
                &conn,
                "eligibility-split-voided",
                "split_receipt",
                "printed",
                false,
            );
            conn.execute(
                "INSERT INTO order_payments (
                     id, order_id, method, amount, status, created_at, updated_at
                 ) VALUES (
                     'entity-eligibility-split-voided', 'eligibility-split-parent',
                     'cash', 5.0, 'voided', ?1, ?1
                 )",
                [NOW],
            )
            .unwrap();

            insert_job(
                &conn,
                "eligibility-split-orphan",
                "split_receipt",
                "printed",
                false,
            );
            conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                     id, order_id, method, amount, status, created_at, updated_at
                 ) VALUES (
                     'entity-eligibility-split-orphan', 'missing-split-parent',
                     'cash', 5.0, 'completed', ?1, ?1
                 )",
                [NOW],
            )
            .unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

            for entity_type in ["shift_checkout", "z_report"] {
                insert_job(
                    &conn,
                    &format!("eligibility-{entity_type}-valid"),
                    entity_type,
                    "printed",
                    true,
                );
                insert_job(
                    &conn,
                    &format!("eligibility-{entity_type}-missing"),
                    entity_type,
                    "printed",
                    false,
                );
            }

            insert_job(
                &conn,
                "eligibility-frozen-partial",
                "shift_checkout",
                "printed",
                false,
            );
            conn.execute(
                "UPDATE print_jobs SET document_snapshot_version = 1
                 WHERE id = 'eligibility-frozen-partial'",
                [],
            )
            .unwrap();

            for (id, fault, envelope) in [
                (
                    "eligibility-frozen-codec",
                    FrozenFixtureFault::Codec,
                    valid_envelope("shift_checkout"),
                ),
                (
                    "eligibility-frozen-hash",
                    FrozenFixtureFault::Hash,
                    valid_envelope("shift_checkout"),
                ),
                (
                    "eligibility-frozen-envelope",
                    FrozenFixtureFault::None,
                    "{not-json".to_string(),
                ),
                (
                    "eligibility-frozen-kind",
                    FrozenFixtureFault::None,
                    valid_envelope("order_receipt"),
                ),
            ] {
                insert_job(&conn, id, "shift_checkout", "printed", false);
                install_frozen_fixture(&conn, id, "shift_checkout", envelope, fault);
            }
            let mut invalid_target =
                serde_json::from_str::<serde_json::Value>(&valid_envelope("shift_checkout"))
                    .unwrap();
            invalid_target["transport"]["host"] = json!("");
            insert_job(
                &conn,
                "eligibility-frozen-target",
                "shift_checkout",
                "printed",
                false,
            );
            install_frozen_fixture(
                &conn,
                "eligibility-frozen-target",
                "shift_checkout",
                invalid_target.to_string(),
                FrozenFixtureFault::None,
            );

            insert_job(
                &conn,
                "eligibility-corrupt-order-with-legacy",
                "order_receipt",
                "printed",
                false,
            );
            conn.execute(
                "INSERT INTO orders (id) VALUES ('entity-eligibility-corrupt-order-with-legacy')",
                [],
            )
            .unwrap();
            install_frozen_fixture(
                &conn,
                "eligibility-corrupt-order-with-legacy",
                "order_receipt",
                valid_envelope("order_receipt"),
                FrozenFixtureFault::Hash,
            );

            for (id, entity_type) in [
                ("eligibility-forged-test", "test_print"),
                ("eligibility-forged-unknown", "future_document"),
            ] {
                insert_job(&conn, id, entity_type, "printed", true);
            }
        }

        let conn = db.conn.lock().unwrap();
        for entity_type in direct_legacy_types {
            assert_eq!(
                eligibility(&conn, &format!("eligibility-legacy-{entity_type}")),
                PrintHistoryEligibility {
                    retryable: false,
                    reprintable: true,
                },
                "safe legacy order source {entity_type}"
            );
        }
        assert_eq!(
            eligibility(&conn, "eligibility-split-completed"),
            PrintHistoryEligibility {
                retryable: false,
                reprintable: true,
            }
        );
        for id in [
            "eligibility-legacy-missing-order",
            "eligibility-split-voided",
            "eligibility-split-orphan",
            "eligibility-shift_checkout-missing",
            "eligibility-z_report-missing",
            "eligibility-frozen-partial",
            "eligibility-frozen-codec",
            "eligibility-frozen-hash",
            "eligibility-frozen-envelope",
            "eligibility-frozen-kind",
            "eligibility-frozen-target",
            "eligibility-corrupt-order-with-legacy",
            "eligibility-forged-test",
            "eligibility-forged-unknown",
        ] {
            assert_eq!(
                eligibility(&conn, id),
                PrintHistoryEligibility {
                    retryable: false,
                    reprintable: false,
                },
                "unsafe source fixture {id} must fail closed without an eligibility error"
            );
        }
        for id in [
            "eligibility-shift_checkout-valid",
            "eligibility-z_report-valid",
        ] {
            assert_eq!(
                eligibility(&conn, id),
                PrintHistoryEligibility {
                    retryable: false,
                    reprintable: true,
                },
                "valid frozen-only fixture {id}"
            );
        }
    }

    fn frozen_cache_key(
        scope: &str,
        job_id: &str,
        document_kind: &str,
        version: i64,
        compressed_len: usize,
        checksum: &str,
        envelope: &str,
    ) -> FrozenValidationCacheKey {
        FrozenValidationCacheKey::new(
            scope,
            job_id,
            document_kind,
            version,
            compressed_len,
            Sha256::digest(format!("compressed:{checksum}").as_bytes()).into(),
            checksum,
            envelope,
        )
    }

    #[test]
    fn frozen_validation_cache_key_retains_no_private_identity_text_and_stays_bounded() {
        let private_scope = "PRIVATE-DATABASE-SCOPE-SENTINEL";
        let private_job = "PRIVATE-JOB-SENTINEL";
        let private_checksum = format!("PRIVATE-CHECKSUM-SENTINEL-{}", "c".repeat(512 * 1024));
        let private_envelope = format!("PRIVATE-ENVELOPE-SENTINEL-{}", "e".repeat(1024 * 1024));
        let small = frozen_cache_key("db", "job", "z_report", 1, 10, "sha", "envelope");
        let large = frozen_cache_key(
            private_scope,
            private_job,
            "z_report",
            1,
            10,
            &private_checksum,
            &private_envelope,
        );

        let small_debug = format!("{small:?}");
        let large_debug = format!("{large:?}");
        for sentinel in [
            "PRIVATE-DATABASE-SCOPE-SENTINEL",
            "PRIVATE-JOB-SENTINEL",
            "PRIVATE-CHECKSUM-SENTINEL",
            "PRIVATE-ENVELOPE-SENTINEL",
        ] {
            assert!(
                !large_debug.contains(sentinel),
                "cache key retained private identity text: {sentinel}"
            );
        }
        assert!(
            large_debug.len() <= small_debug.len() + 256,
            "cache key debug/retained identity grew with private input: small={} large={}",
            small_debug.len(),
            large_debug.len()
        );
        assert_eq!(
            std::mem::size_of_val(&large),
            std::mem::size_of_val(&small),
            "cache key must have fixed inline size"
        );
    }

    #[test]
    fn frozen_validation_cache_memoizes_positive_and_negative_results() {
        let cache = Mutex::new(FrozenValidationCache::new(8));
        let positive = frozen_cache_key(
            "db-a",
            "job-a",
            "shift_checkout",
            1,
            4 * 1024 * 1024,
            "checksum-a",
            "envelope-a",
        );
        let positive_calls = AtomicUsize::new(0);
        assert_eq!(
            cached_frozen_validation_with(&cache, positive.clone(), || {
                positive_calls.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }),
            Ok(())
        );
        assert_eq!(
            cached_frozen_validation_with(&cache, positive, || {
                positive_calls.fetch_add(1, Ordering::AcqRel);
                Err("must-not-revalidate-positive".to_string())
            }),
            Ok(())
        );
        assert_eq!(positive_calls.load(Ordering::Acquire), 1);

        let negative = frozen_cache_key(
            "db-a",
            "job-b",
            "shift_checkout",
            1,
            4 * 1024 * 1024,
            "checksum-b",
            "envelope-b",
        );
        let negative_calls = AtomicUsize::new(0);
        assert_eq!(
            cached_frozen_validation_with(&cache, negative.clone(), || {
                negative_calls.fetch_add(1, Ordering::AcqRel);
                Err("immutable-frozen-corruption".to_string())
            }),
            Err("immutable-frozen-corruption".to_string())
        );
        assert_eq!(
            cached_frozen_validation_with(&cache, negative, || {
                negative_calls.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }),
            Err("immutable-frozen-corruption".to_string())
        );
        assert_eq!(negative_calls.load(Ordering::Acquire), 1);
        assert_eq!(cache.lock().unwrap().len(), 2);
    }

    #[test]
    fn frozen_validation_cache_isolates_db_job_and_every_immutable_identity_field() {
        let cache = Mutex::new(FrozenValidationCache::new(32));
        let keys = [
            frozen_cache_key("db-a", "job-a", "shift_checkout", 1, 10, "sha-a", "env-a"),
            frozen_cache_key("db-b", "job-a", "shift_checkout", 1, 10, "sha-a", "env-a"),
            frozen_cache_key("db-a", "job-b", "shift_checkout", 1, 10, "sha-a", "env-a"),
            frozen_cache_key("db-a", "job-a", "z_report", 1, 10, "sha-a", "env-a"),
            frozen_cache_key("db-a", "job-a", "shift_checkout", 2, 10, "sha-a", "env-a"),
            frozen_cache_key("db-a", "job-a", "shift_checkout", 1, 11, "sha-a", "env-a"),
            frozen_cache_key("db-a", "job-a", "shift_checkout", 1, 10, "sha-b", "env-a"),
            frozen_cache_key("db-a", "job-a", "shift_checkout", 1, 10, "sha-a", "env-b"),
        ];
        let calls = AtomicUsize::new(0);
        for key in keys.iter().cloned() {
            cached_frozen_validation_with(&cache, key, || {
                calls.fetch_add(1, Ordering::AcqRel);
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(calls.load(Ordering::Acquire), keys.len());
        assert_eq!(cache.lock().unwrap().len(), keys.len());

        for key in keys.iter().cloned() {
            cached_frozen_validation_with(&cache, key, || {
                calls.fetch_add(1, Ordering::AcqRel);
                Err("must-hit-exact-key".to_string())
            })
            .unwrap();
        }
        assert_eq!(calls.load(Ordering::Acquire), keys.len());
    }

    #[test]
    fn frozen_validation_cache_is_bounded_and_evicted_entries_revalidate() {
        let cache = Mutex::new(FrozenValidationCache::new(2));
        let first = frozen_cache_key("db", "job-1", "z_report", 1, 10, "sha-1", "env-1");
        let second = frozen_cache_key("db", "job-2", "z_report", 1, 10, "sha-2", "env-2");
        let third = frozen_cache_key("db", "job-3", "z_report", 1, 10, "sha-3", "env-3");
        let calls = AtomicUsize::new(0);

        for key in [first.clone(), second, third] {
            cached_frozen_validation_with(&cache, key, || {
                calls.fetch_add(1, Ordering::AcqRel);
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(calls.load(Ordering::Acquire), 3);
        assert_eq!(cache.lock().unwrap().len(), 2);

        cached_frozen_validation_with(&cache, first, || {
            calls.fetch_add(1, Ordering::AcqRel);
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 4);
        assert_eq!(cache.lock().unwrap().len(), 2);
    }

    #[test]
    fn history_validation_cache_never_caches_mutable_eligibility_state() {
        let db = test_db();
        let cache = Mutex::new(FrozenValidationCache::new(8));
        let conn = db.conn.lock().unwrap();
        insert_job(
            &conn,
            "mutable-eligibility",
            "shift_checkout",
            "failed",
            true,
        );

        let inspect = || {
            print_history_eligibility_with_validation_cache(
                &conn,
                "memory-db-a",
                "mutable-eligibility",
                now(),
                &cache,
            )
            .expect("inspect cached history eligibility")
        };
        assert_eq!(
            inspect(),
            PrintHistoryEligibility {
                retryable: true,
                reprintable: true,
            }
        );
        assert_eq!(cache.lock().unwrap().len(), 1);

        conn.execute(
            "UPDATE print_jobs SET status = 'pending' WHERE id = 'mutable-eligibility'",
            [],
        )
        .unwrap();
        assert_eq!(inspect(), PrintHistoryEligibility::default());

        conn.execute(
            "UPDATE print_jobs
             SET status = 'failed', history_expires_at = ?1
             WHERE id = 'mutable-eligibility'",
            [NOW],
        )
        .unwrap();
        assert_eq!(inspect(), PrintHistoryEligibility::default());

        conn.execute(
            "UPDATE print_jobs SET history_expires_at = ?1 WHERE id = 'mutable-eligibility'",
            [FUTURE],
        )
        .unwrap();
        insert_attempt(&conn, "mutable-eligibility", "unknown", Some(91));
        assert_eq!(inspect(), PrintHistoryEligibility::default());

        conn.execute(
            "DELETE FROM print_job_attempts WHERE print_job_id = 'mutable-eligibility'",
            [],
        )
        .unwrap();
        assert_eq!(
            inspect(),
            PrintHistoryEligibility {
                retryable: true,
                reprintable: true,
            }
        );
        assert_eq!(cache.lock().unwrap().len(), 1);
    }

    #[test]
    fn frozen_validation_cache_revalidates_a_same_length_changed_compressed_snapshot() {
        let db = test_db();
        let cache = Mutex::new(FrozenValidationCache::new(8));
        {
            let conn = db.conn.lock().unwrap();
            insert_job(
                &conn,
                "same-length-compressed-snapshot",
                "shift_checkout",
                "printed",
                true,
            );
            let inspect = || {
                print_history_eligibility_with_validation_cache(
                    &conn,
                    "memory-db-a",
                    "same-length-compressed-snapshot",
                    now(),
                    &cache,
                )
                .expect("inspect cached history eligibility")
            };

            assert_eq!(
                inspect(),
                PrintHistoryEligibility {
                    retryable: false,
                    reprintable: true,
                }
            );
            assert_eq!(cache.lock().unwrap().len(), 1);

            let mut changed_compressed: Vec<u8> = conn
                .query_row(
                    "SELECT document_snapshot_zlib FROM print_jobs WHERE id = ?1",
                    ["same-length-compressed-snapshot"],
                    |row| row.get(0),
                )
                .expect("read frozen compressed snapshot");
            let last = changed_compressed
                .last_mut()
                .expect("frozen compressed snapshot is non-empty");
            *last ^= 0x01;
            conn.execute_batch("DROP TRIGGER trg_print_jobs_snapshot_immutable;")
                .expect("test fixture permits simulated persisted corruption");
            conn.execute(
                "UPDATE print_jobs SET document_snapshot_zlib = ?2 WHERE id = ?1",
                params!["same-length-compressed-snapshot", changed_compressed],
            )
            .expect("change frozen compressed snapshot without changing its length");

            assert_eq!(
                inspect(),
                PrintHistoryEligibility::default(),
                "a warm positive cache entry must not authorize different compressed bytes"
            );
            assert_eq!(cache.lock().unwrap().len(), 2);
        }

        assert!(
            clone_reprint_job(&db, "same-length-compressed-snapshot", now()).is_err(),
            "direct Reprint must still exact-revalidate the changed snapshot"
        );
    }

    fn insert_purge_job(
        conn: &Connection,
        id: &str,
        status: &str,
        history_expires_at: Option<&str>,
        reprint_of_job_id: Option<&str>,
        output_path: Option<&Path>,
    ) {
        conn.execute(
            "INSERT INTO print_jobs (
                 id, entity_type, entity_id, status, output_path,
                 created_at, updated_at, completed_at, history_expires_at,
                 reprint_of_job_id
             ) VALUES (
                 ?1, 'order_receipt', ?2, ?3, ?4,
                 '2026-07-01T12:00:00Z', '2026-07-08T12:00:00Z',
                 '2026-07-08T12:00:00Z', ?5, ?6
             )",
            params![
                id,
                format!("entity-{id}"),
                status,
                output_path.map(|path| path.to_string_lossy().into_owned()),
                history_expires_at,
                reprint_of_job_id,
            ],
        )
        .expect("insert purge print job");
    }

    fn job_exists(conn: &Connection, id: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM print_jobs WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .expect("inspect purge job")
    }

    struct TestDataDir {
        path: PathBuf,
    }

    impl TestDataDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "the-small-task8-purge-{}-{}",
                std::process::id(),
                Uuid::new_v4()
            ));
            fs::create_dir_all(path.join("receipts")).expect("create isolated receipts root");
            Self { path }
        }

        fn receipts(&self) -> PathBuf {
            self.path.join("receipts")
        }
    }

    impl Drop for TestDataDir {
        fn drop(&mut self) {
            if self.path.starts_with(std::env::temp_dir()) {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }

    #[derive(Default)]
    struct TestFileOps {
        forced_symlinks: HashSet<PathBuf>,
        forced_reparse_points: HashSet<PathBuf>,
        canonical_overrides: HashMap<PathBuf, PathBuf>,
        canonicalize_failures: HashSet<PathBuf>,
        canonicalize_calls: Mutex<HashMap<PathBuf, usize>>,
        remove_failures: HashSet<PathBuf>,
        remove_calls: Mutex<Vec<PathBuf>>,
    }

    impl FileOps for TestFileOps {
        fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
            *self
                .canonicalize_calls
                .lock()
                .unwrap()
                .entry(path.to_path_buf())
                .or_default() += 1;
            if self.canonicalize_failures.contains(path) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated canonicalization failure",
                ));
            }
            if let Some(overridden) = self.canonical_overrides.get(path) {
                return Ok(overridden.clone());
            }
            #[cfg(windows)]
            {
                dunce::canonicalize(path)
            }
            #[cfg(not(windows))]
            {
                fs::canonicalize(path)
            }
        }

        fn inspect(&self, path: &Path) -> io::Result<FileInspection> {
            let metadata = fs::symlink_metadata(path)?;
            Ok(FileInspection {
                is_file: metadata.file_type().is_file(),
                is_directory: metadata.file_type().is_dir(),
                is_symlink: metadata.file_type().is_symlink()
                    || self.forced_symlinks.contains(path),
                is_reparse_point: self.forced_reparse_points.contains(path),
            })
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.remove_calls.lock().unwrap().push(path.to_path_buf());
            if self.remove_failures.contains(path) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated remove failure",
                ));
            }
            fs::remove_file(path)
        }
    }

    #[derive(Default)]
    struct CountingPurgeProbe {
        leaf_selection_layers: AtomicUsize,
        reference_barriers: AtomicUsize,
    }

    impl PurgeProbe for CountingPurgeProbe {
        fn leaf_selection_layer(&self) {
            self.leaf_selection_layers.fetch_add(1, Ordering::SeqCst);
        }

        fn reference_barrier(&self) {
            self.reference_barriers.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct ValidationMutationFileOps {
        base: TestFileOps,
        candidate: PathBuf,
        trusted_canonical: PathBuf,
        alternate_canonical: PathBuf,
        candidate_canonicalize_calls: AtomicUsize,
        remove_calls: AtomicUsize,
        events: Mutex<Vec<&'static str>>,
    }

    impl FileOps for ValidationMutationFileOps {
        fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
            if path == self.candidate || path == self.trusted_canonical {
                let call = self
                    .candidate_canonicalize_calls
                    .fetch_add(1, Ordering::SeqCst);
                self.events.lock().unwrap().push(if call == 0 {
                    "initial_candidate_validation"
                } else {
                    "pre_remove_revalidation"
                });
                return Ok(if call == 0 {
                    self.trusted_canonical.clone()
                } else {
                    self.alternate_canonical.clone()
                });
            }
            self.base.canonicalize(path)
        }

        fn inspect(&self, path: &Path) -> io::Result<FileInspection> {
            self.base.inspect(path)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.remove_calls.fetch_add(1, Ordering::SeqCst);
            self.base.remove_file(path)
        }
    }

    struct CommitProbeFileOps<'a> {
        base: TestFileOps,
        db: &'a db::DbState,
        candidate: PathBuf,
        purged_job_id: &'a str,
        callback_calls: AtomicUsize,
        observed_committed_row: AtomicBool,
        observed_final_reference_barrier: AtomicBool,
    }

    impl FileOps for CommitProbeFileOps<'_> {
        fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
            if path == self.candidate && !self.observed_committed_row.load(Ordering::SeqCst) {
                let conn = self
                    .db
                    .conn
                    .try_lock()
                    .expect("purge must release the DB mutex before preliminary file cleanup");
                assert!(
                    !job_exists(&conn, self.purged_job_id),
                    "purge must commit the row deletion before preliminary file cleanup"
                );
                self.observed_committed_row.store(true, Ordering::SeqCst);
            }
            self.base.canonicalize(path)
        }

        fn inspect(&self, path: &Path) -> io::Result<FileInspection> {
            self.base.inspect(path)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.callback_calls.fetch_add(1, Ordering::SeqCst);
            assert!(
                self.db.conn.try_lock().is_err(),
                "purge must hold its final DB reference barrier during removal"
            );
            self.observed_final_reference_barrier
                .store(true, Ordering::SeqCst);
            self.base.remove_file(path)
        }
    }

    struct LateReferenceFileOps<'a> {
        base: TestFileOps,
        db: &'a db::DbState,
        candidate: PathBuf,
        surviving_alias: PathBuf,
        purged_job_id: &'a str,
        injected: AtomicBool,
        observed_committed_deletion: AtomicBool,
        remove_calls: AtomicUsize,
    }

    impl FileOps for LateReferenceFileOps<'_> {
        fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
            if path == self.candidate && !self.injected.swap(true, Ordering::SeqCst) {
                let conn = self.db.conn.try_lock().expect(
                    "purge must commit and release its deletion transaction before file work",
                );
                assert!(
                    !job_exists(&conn, self.purged_job_id),
                    "the expired row deletion must already be durable before the late reference"
                );
                insert_purge_job(
                    &conn,
                    "late-surviving-artifact-reference",
                    "printed",
                    Some(FUTURE),
                    None,
                    Some(&self.surviving_alias),
                );
                self.observed_committed_deletion
                    .store(true, Ordering::SeqCst);
            }
            self.base.canonicalize(path)
        }

        fn inspect(&self, path: &Path) -> io::Result<FileInspection> {
            self.base.inspect(path)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            self.remove_calls.fetch_add(1, Ordering::SeqCst);
            self.base.remove_file(path)
        }
    }

    #[derive(Clone, Debug, PartialEq)]
    struct FrozenFields {
        entity_type: String,
        entity_id: String,
        entity_payload_json: Option<String>,
        printer_profile_id: Option<String>,
        max_retries: i64,
        document_snapshot_version: Option<i64>,
        document_snapshot_zlib: Option<Vec<u8>>,
        document_snapshot_sha256: Option<String>,
        render_profile_snapshot_json: Option<String>,
        output_path: Option<String>,
    }

    fn load_frozen_fields(conn: &Connection, id: &str) -> FrozenFields {
        conn.query_row(
            "SELECT entity_type, entity_id, entity_payload_json,
                    printer_profile_id, max_retries, document_snapshot_version,
                    document_snapshot_zlib, document_snapshot_sha256,
                    render_profile_snapshot_json, output_path
             FROM print_jobs WHERE id = ?1",
            [id],
            |row| {
                Ok(FrozenFields {
                    entity_type: row.get(0)?,
                    entity_id: row.get(1)?,
                    entity_payload_json: row.get(2)?,
                    printer_profile_id: row.get(3)?,
                    max_retries: row.get(4)?,
                    document_snapshot_version: row.get(5)?,
                    document_snapshot_zlib: row.get(6)?,
                    document_snapshot_sha256: row.get(7)?,
                    render_profile_snapshot_json: row.get(8)?,
                    output_path: row.get(9)?,
                })
            },
        )
        .expect("load frozen Task 8 fields")
    }

    fn load_full_job_row(conn: &Connection, id: &str) -> Vec<Value> {
        conn.query_row("SELECT * FROM print_jobs WHERE id = ?1", [id], |row| {
            (0..row.as_ref().column_count())
                .map(|index| row.get::<_, Value>(index))
                .collect()
        })
        .expect("load every print job field")
    }

    fn load_full_attempt_ledger(conn: &Connection, job_id: &str) -> Vec<Vec<Value>> {
        let mut statement = conn
            .prepare(
                "SELECT * FROM print_job_attempts
                 WHERE print_job_id = ?1
                 ORDER BY attempt_number, id",
            )
            .expect("prepare full attempt ledger query");
        let column_count = statement.column_count();
        statement
            .query_map([job_id], |row| {
                (0..column_count)
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .expect("read full attempt ledger")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect full attempt ledger")
    }

    #[test]
    fn retry_preserves_identity_frozen_source_and_attempt_ledger_while_resetting_terminal_state() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_job(&conn, "retry-source", "order_receipt", "failed", true);
            insert_attempt(&conn, "retry-source", "transport_error", None);
        }
        let before = {
            let conn = db.conn.lock().unwrap();
            load_frozen_fields(&conn, "retry-source")
        };

        let result = retry_failed_print_job(&db, "retry-source", now()).expect("Retry succeeds");
        assert_eq!(result.affected, 1);
        assert_eq!(result.job_id, "retry-source");
        assert_eq!(result.new_job_id, None);

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            load_frozen_fields(&conn, "retry-source"),
            before,
            "Retry must preserve source, payload, profile, target, output, limits, and snapshot"
        );
        let row: (
            String,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
        ) = conn
            .query_row(
                "SELECT status, retry_count, next_retry_at, last_error,
                        warning_code, warning_message, completed_at,
                        history_expires_at,
                        (SELECT COUNT(*) FROM print_job_attempts a
                         WHERE a.print_job_id = print_jobs.id)
                 FROM print_jobs WHERE id = 'retry-source'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, 0);
        assert_eq!((row.2, row.3, row.4, row.5), (None, None, None, None));
        assert_eq!((row.6, row.7), (None, None));
        assert_eq!(row.8, 1, "Retry must retain the attempt ledger");
    }

    #[test]
    fn retry_rejects_expired_failed_job_without_any_durable_mutation() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_job(
                &conn,
                "expired-retry-source",
                "order_receipt",
                "failed",
                true,
            );
            conn.execute(
                "UPDATE print_jobs
                 SET history_expires_at = '2026-08-06T12:00:00Z'
                 WHERE id = 'expired-retry-source'",
                [],
            )
            .unwrap();
            insert_attempt_numbered(&conn, "expired-retry-source", 1, "transport_error", None);
            insert_attempt_numbered(&conn, "expired-retry-source", 2, "sent", Some(73));
        }
        let (job_before, attempts_before, changes_before) = {
            let conn = db.conn.lock().unwrap();
            (
                load_full_job_row(&conn, "expired-retry-source"),
                load_full_attempt_ledger(&conn, "expired-retry-source"),
                conn.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
            )
        };

        let error = retry_failed_print_job(&db, "expired-retry-source", now())
            .expect_err("expired failed jobs must be unavailable for Retry");
        assert_eq!(error, "Print job is not available for Retry");

        let conn = db.conn.lock().unwrap();
        assert_eq!(
            load_full_job_row(&conn, "expired-retry-source"),
            job_before,
            "Retry rejection must preserve every print_jobs column"
        );
        assert_eq!(
            load_full_attempt_ledger(&conn, "expired-retry-source"),
            attempts_before,
            "Retry rejection must preserve every attempt field and row"
        );
        assert_eq!(
            conn.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            changes_before,
            "Retry rejection must perform no durable SQL mutation"
        );
    }

    #[test]
    fn mutation_response_keeps_source_and_child_ids_distinct_and_serializes_only_operational_data()
    {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_job(&conn, "response-retry", "order_receipt", "failed", true);
            insert_job(&conn, "response-reprint", "order_receipt", "printed", true);
        }

        let retry = retry_failed_print_job(&db, "response-retry", now()).expect("Retry response");
        assert_eq!(
            retry,
            PrintHistoryMutationResult {
                job_id: "response-retry".into(),
                new_job_id: None,
                affected: 1,
                unchanged: false,
                duplicate: false,
                durable_changed: true,
            }
        );

        let created = clone_reprint_job(&db, "response-reprint", now()).expect("new Reprint");
        assert_eq!(created.job_id, "response-reprint");
        let child_id = created.new_job_id.clone().expect("new Reprint child id");
        assert_ne!(child_id, "response-reprint");
        assert_eq!(created.affected, 1);
        assert!(!created.unchanged);
        assert!(!created.duplicate);
        assert!(created.durable_changed);
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            json!({
                "jobId": "response-reprint",
                "newJobId": child_id,
                "affected": 1,
                "unchanged": false,
                "duplicate": false,
                "durableChanged": true,
            }),
            "serialized mutations must expose exactly the typed operational fields"
        );

        let coalesced =
            clone_reprint_job(&db, "response-reprint", now()).expect("coalesced Reprint");
        assert_eq!(
            coalesced,
            PrintHistoryMutationResult {
                job_id: "response-reprint".into(),
                new_job_id: Some(child_id),
                affected: 0,
                unchanged: true,
                duplicate: true,
                durable_changed: false,
            }
        );
    }

    #[test]
    fn retry_rejects_every_active_attempt_blocker_and_preserves_failed_parent() {
        for (index, (state, spool_job_id)) in [
            ("created", None),
            ("submitting", None),
            ("windows_queued", Some(41)),
            ("windows_printing", Some(42)),
            ("paused", Some(43)),
            ("cancel_requested", Some(44)),
            ("unknown", Some(45)),
            ("cancel_failed", Some(46)),
            ("spool_error", Some(1)),
            ("spool_error", Some(i64::from(u32::MAX))),
        ]
        .into_iter()
        .enumerate()
        {
            let db = test_db();
            let id = format!("retry-blocked-{index}");
            {
                let conn = db.conn.lock().unwrap();
                insert_job(&conn, &id, "order_receipt", "failed", true);
                insert_attempt(&conn, &id, state, spool_job_id);
            }
            assert!(
                retry_failed_print_job(&db, &id, now()).is_err(),
                "attempt state {state} must block Retry"
            );
            let conn = db.conn.lock().unwrap();
            let status: String = conn
                .query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(status, "failed");
        }
    }

    #[test]
    fn retry_allows_spool_errors_without_a_valid_native_identity() {
        for (identity, spool_job_id) in invalid_spool_job_id_values() {
            let db = test_db();
            let id = format!("retry-invalid-spool-{identity}");
            {
                let conn = db.conn.lock().unwrap();
                insert_job(&conn, &id, "order_receipt", "failed", true);
                insert_attempt_with_spool_value(&conn, &id, "spool_error", spool_job_id);
            }

            let result = retry_failed_print_job(&db, &id, now())
                .unwrap_or_else(|error| panic!("invalid SQLite identity {identity}: {error}"));
            assert_eq!(result.affected, 1);
            let conn = db.conn.lock().unwrap();
            let status: String = conn
                .query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(status, "pending");
        }
    }

    #[test]
    fn reprint_accepts_all_terminal_states_and_copies_frozen_fields_without_mutating_source() {
        for status in ["printed", "dispatched", "failed", "cancelled"] {
            let db = test_db();
            let source_id = format!("source-{status}");
            {
                let conn = db.conn.lock().unwrap();
                insert_job(&conn, &source_id, "order_receipt", status, true);
            }
            let before_state: (String, String, Option<String>, Option<String>) = {
                let conn = db.conn.lock().unwrap();
                conn.query_row(
                    "SELECT status, updated_at, completed_at, history_expires_at
                     FROM print_jobs WHERE id = ?1",
                    [&source_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap()
            };
            let before_frozen = {
                let conn = db.conn.lock().unwrap();
                load_frozen_fields(&conn, &source_id)
            };

            let result = clone_reprint_job(&db, &source_id, now()).expect("Reprint succeeds");
            assert_eq!(result.affected, 1);
            assert_eq!(result.job_id, source_id);
            let child_id = result.new_job_id.expect("Reprint child id");
            assert_ne!(child_id, source_id);
            Uuid::parse_str(&child_id).expect("Reprint child id must be a UUID");

            let conn = db.conn.lock().unwrap();
            let after_state: (String, String, Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT status, updated_at, completed_at, history_expires_at
                     FROM print_jobs WHERE id = ?1",
                    [&source_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert_eq!(
                after_state, before_state,
                "Reprint must not mutate its source"
            );
            assert_eq!(
                load_frozen_fields(&conn, &source_id),
                before_frozen,
                "Reprint must not mutate any source or frozen field"
            );

            let child_identity: (String, String) = conn
                .query_row(
                    "SELECT status, reprint_of_job_id
                     FROM print_jobs WHERE id = ?1",
                    [&child_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(child_identity.0, "pending");
            assert_eq!(child_identity.1, source_id);

            let child_frozen = load_frozen_fields(&conn, &child_id);
            let mut expected_child_frozen = before_frozen.clone();
            expected_child_frozen.output_path = None;
            assert_eq!(
                child_frozen, expected_child_frozen,
                "Reprint copies exact source/payload/profile/limit/snapshot fields but not output_path"
            );
        }
    }

    #[test]
    fn legacy_reprint_requires_the_exact_safe_mutable_compatibility_source() {
        let db = test_db();
        let direct_legacy_types = [
            "order_receipt",
            "kitchen_ticket",
            "delivery_slip",
            "order_completed_receipt",
            "order_canceled_receipt",
        ];
        {
            let conn = db.conn.lock().unwrap();
            for entity_type in direct_legacy_types {
                let source_id = format!("legacy-{entity_type}");
                insert_job(&conn, &source_id, entity_type, "printed", false);
                conn.execute(
                    "INSERT INTO orders (id) VALUES (?1)",
                    [format!("entity-{source_id}")],
                )
                .unwrap();
            }

            insert_job(&conn, "legacy-split", "split_receipt", "printed", false);
            conn.execute("INSERT INTO orders (id) VALUES ('legacy-split-order')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                     id, order_id, method, amount, status, created_at, updated_at
                 ) VALUES (
                     'entity-legacy-split', 'legacy-split-order', 'cash', 8.5,
                     'completed', ?1, ?1
                 )",
                [NOW],
            )
            .unwrap();

            for (id, entity_type) in [
                ("legacy-missing-order", "order_receipt"),
                ("legacy-missing-payment", "split_receipt"),
                ("legacy-test-print", "test_print"),
                ("legacy-unknown", "future_document"),
            ] {
                insert_job(&conn, id, entity_type, "printed", false);
            }

            insert_job(
                &conn,
                "legacy-split-voided",
                "split_receipt",
                "printed",
                false,
            );
            conn.execute(
                "INSERT INTO orders (id) VALUES ('legacy-split-voided-order')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO order_payments (
                     id, order_id, method, amount, status, created_at, updated_at
                 ) VALUES (
                     'entity-legacy-split-voided', 'legacy-split-voided-order',
                     'cash', 4.0, 'voided', ?1, ?1
                 )",
                [NOW],
            )
            .unwrap();

            insert_job(
                &conn,
                "legacy-partial-order",
                "order_receipt",
                "printed",
                false,
            );
            conn.execute(
                "INSERT INTO orders (id) VALUES ('entity-legacy-partial-order')",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE print_jobs SET document_snapshot_version = 1
                 WHERE id = 'legacy-partial-order'",
                [],
            )
            .unwrap();

            for (id, entity_type) in [
                ("forged-test-print", "test_print"),
                ("forged-unknown", "future_document"),
            ] {
                insert_job(&conn, id, entity_type, "printed", true);
            }
        }

        for entity_type in direct_legacy_types {
            let source_id = format!("legacy-{entity_type}");
            let result = clone_reprint_job(&db, &source_id, now())
                .unwrap_or_else(|error| panic!("{entity_type} legacy source rejected: {error}"));
            assert_eq!(result.job_id, source_id);
            assert!(result.new_job_id.is_some());
        }
        let split = clone_reprint_job(&db, "legacy-split", now()).expect("completed split source");
        assert_eq!(split.job_id, "legacy-split");
        assert!(split.new_job_id.is_some());

        for source_id in [
            "legacy-missing-order",
            "legacy-missing-payment",
            "legacy-split-voided",
            "legacy-test-print",
            "legacy-unknown",
            "legacy-partial-order",
            "forged-test-print",
            "forged-unknown",
        ] {
            assert!(
                clone_reprint_job(&db, source_id, now()).is_err(),
                "unsafe legacy source {source_id} must be rejected"
            );
        }
    }

    #[test]
    fn checkout_and_z_report_reprint_reject_missing_or_partial_frozen_snapshot() {
        for entity_type in ["shift_checkout", "z_report"] {
            let db = test_db();
            let missing = format!("{entity_type}-missing");
            let partial = format!("{entity_type}-partial");
            {
                let conn = db.conn.lock().unwrap();
                insert_job(&conn, &missing, entity_type, "printed", false);
                insert_job(&conn, &partial, entity_type, "printed", false);
                conn.execute(
                    "UPDATE print_jobs SET document_snapshot_version = 1
                     WHERE id = ?1",
                    [&partial],
                )
                .unwrap();
            }
            assert!(clone_reprint_job(&db, &missing, now()).is_err());
            assert!(clone_reprint_job(&db, &partial, now()).is_err());
            let conn = db.conn.lock().unwrap();
            let children: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM print_jobs
                     WHERE reprint_of_job_id IN (?1, ?2)",
                    params![missing, partial],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(children, 0);
        }
    }

    #[test]
    fn reprint_coalesces_an_active_direct_child_but_terminal_child_allows_another_clone() {
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_job(&conn, "coalesce-source", "order_receipt", "printed", true);
        }
        let first = clone_reprint_job(&db, "coalesce-source", now()).expect("first clone");
        assert_eq!(first.affected, 1);
        assert_eq!(first.job_id, "coalesce-source");
        let first_id = first.new_job_id.expect("first Reprint child id");

        let duplicate = clone_reprint_job(&db, "coalesce-source", now()).expect("coalesced clone");
        assert_eq!(duplicate.affected, 0);
        assert_eq!(duplicate.job_id, "coalesce-source");
        assert_eq!(duplicate.new_job_id.as_deref(), Some(first_id.as_str()));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE print_jobs
                 SET status = 'printed', completed_at = ?2, history_expires_at = ?3
                 WHERE id = ?1",
                params![first_id, NOW, FUTURE],
            )
            .unwrap();
        }

        let second = clone_reprint_job(&db, "coalesce-source", now()).expect("second clone");
        assert_eq!(second.affected, 1);
        assert_eq!(second.job_id, "coalesce-source");
        assert_ne!(second.new_job_id.as_deref(), Some(first_id.as_str()));
    }

    #[test]
    fn reprint_coalesces_terminal_direct_children_with_live_attempt_blockers() {
        let db = test_db();
        let blockers = [
            ("created", None),
            ("submitting", None),
            ("windows_queued", Some(71)),
            ("windows_printing", Some(72)),
            ("paused", Some(73)),
            ("cancel_requested", Some(74)),
            ("unknown", Some(75)),
            ("cancel_failed", Some(76)),
            ("spool_error", Some(1)),
            ("spool_error", Some(i64::from(u32::MAX))),
        ];
        {
            let conn = db.conn.lock().unwrap();
            for (index, (state, spool_job_id)) in blockers.iter().copied().enumerate() {
                let source_id = format!("child-blocker-source-{index}");
                let child_id = format!("child-blocker-child-{index}");
                let child_status = ["dispatched", "failed", "cancelled"][index % 3];
                insert_job(&conn, &source_id, "order_receipt", "printed", true);
                insert_job(&conn, &child_id, "order_receipt", child_status, true);
                conn.execute(
                    "UPDATE print_jobs SET reprint_of_job_id = ?1 WHERE id = ?2",
                    params![source_id, child_id],
                )
                .unwrap();
                insert_attempt(&conn, &child_id, state, spool_job_id);
            }

            insert_job(&conn, "ordered-source", "order_receipt", "printed", true);
            for child_id in ["ordered-child-b", "ordered-child-a"] {
                insert_job(&conn, child_id, "order_receipt", "failed", true);
                conn.execute(
                    "UPDATE print_jobs SET reprint_of_job_id = 'ordered-source'
                     WHERE id = ?1",
                    [child_id],
                )
                .unwrap();
                insert_attempt(&conn, child_id, "unknown", Some(91));
            }

            for (identity, spool_job_id) in invalid_spool_job_id_values() {
                let source_id = format!("invalid-spool-source-{identity}");
                let child_id = format!("invalid-spool-child-{identity}");
                insert_job(&conn, &source_id, "order_receipt", "printed", true);
                insert_job(&conn, &child_id, "order_receipt", "failed", true);
                conn.execute(
                    "UPDATE print_jobs SET reprint_of_job_id = ?1 WHERE id = ?2",
                    params![source_id, child_id],
                )
                .unwrap();
                insert_attempt_with_spool_value(&conn, &child_id, "spool_error", spool_job_id);
            }
        }

        for index in 0..blockers.len() {
            let source_id = format!("child-blocker-source-{index}");
            let child_id = format!("child-blocker-child-{index}");
            let result = clone_reprint_job(&db, &source_id, now()).expect("coalesced child");
            assert_eq!(result.job_id, source_id);
            assert_eq!(result.new_job_id.as_deref(), Some(child_id.as_str()));
            assert_eq!(result.affected, 0);
            assert!(result.duplicate);
            assert!(!result.durable_changed);
            let conn = db.conn.lock().unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM print_jobs WHERE reprint_of_job_id = ?1",
                    [&source_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "live child blocker must prevent another clone");
        }

        let ordered = clone_reprint_job(&db, "ordered-source", now()).expect("ordered coalesce");
        assert_eq!(ordered.job_id, "ordered-source");
        assert_eq!(ordered.new_job_id.as_deref(), Some("ordered-child-a"));

        for (identity, _) in invalid_spool_job_id_values() {
            let source_id = format!("invalid-spool-source-{identity}");
            let child_id = format!("invalid-spool-child-{identity}");
            let result = clone_reprint_job(&db, &source_id, now())
                .unwrap_or_else(|error| panic!("invalid SQLite identity {identity}: {error}"));
            assert_eq!(result.job_id, source_id);
            assert_eq!(result.affected, 1);
            assert_ne!(result.new_job_id.as_deref(), Some(child_id.as_str()));
        }
    }

    #[test]
    fn purge_enforces_the_exact_retention_boundary_and_every_attempt_blocker() {
        let data_dir = TestDataDir::new();
        let db = test_db();
        let blockers = [
            ("created", None),
            ("submitting", None),
            ("windows_queued", Some(41)),
            ("windows_printing", Some(42)),
            ("paused", Some(43)),
            ("cancel_requested", Some(44)),
            ("unknown", Some(45)),
            ("cancel_failed", Some(46)),
            ("spool_error", Some(1)),
            ("spool_error", Some(i64::from(u32::MAX))),
        ];
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "retained-at-29-days",
                "printed",
                Some("2026-08-08T12:00:00Z"),
                None,
                None,
            );
            insert_purge_job(
                &conn,
                "expired-at-31-days",
                "failed",
                Some("2026-08-06T12:00:00Z"),
                None,
                None,
            );
            insert_purge_job(
                &conn,
                "expired-at-exact-boundary",
                "cancelled",
                Some(NOW),
                None,
                None,
            );
            for status in ["pending", "printing"] {
                insert_purge_job(
                    &conn,
                    &format!("nonterminal-{status}"),
                    status,
                    Some("2026-08-01T12:00:00Z"),
                    None,
                    None,
                );
            }
            for (index, (state, spool_job_id)) in blockers.iter().copied().enumerate() {
                let id = format!("purge-blocked-{index}");
                insert_purge_job(
                    &conn,
                    &id,
                    ["printed", "dispatched", "failed", "cancelled"][index % 4],
                    Some("2026-08-01T12:00:00Z"),
                    None,
                    None,
                );
                insert_attempt(&conn, &id, state, spool_job_id);
            }
            for (identity, spool_job_id) in invalid_spool_job_id_values() {
                let id = format!("purge-invalid-spool-{identity}");
                insert_purge_job(
                    &conn,
                    &id,
                    "dispatched",
                    Some("2026-08-01T12:00:00Z"),
                    None,
                    None,
                );
                insert_attempt_with_spool_value(&conn, &id, "spool_error", spool_job_id);
            }
        }

        let result = purge_expired_print_jobs_at(&db, &data_dir.path, now()).unwrap();
        assert_eq!(
            result,
            PrintJobPurgeResult {
                rows_deleted: 9,
                files_deleted: 0,
                file_cleanup_skipped: 0,
                file_cleanup_failed: 0,
                durable_changed: true,
            }
        );
        let conn = db.conn.lock().unwrap();
        assert!(job_exists(&conn, "retained-at-29-days"));
        assert!(!job_exists(&conn, "expired-at-31-days"));
        assert!(!job_exists(&conn, "expired-at-exact-boundary"));
        for (identity, _) in invalid_spool_job_id_values() {
            assert!(
                !job_exists(&conn, &format!("purge-invalid-spool-{identity}")),
                "invalid SQLite spool identity {identity} must not retain expired history"
            );
        }
        for status in ["pending", "printing"] {
            assert!(job_exists(&conn, &format!("nonterminal-{status}")));
        }
        for index in 0..blockers.len() {
            assert!(job_exists(&conn, &format!("purge-blocked-{index}")));
        }
    }

    #[test]
    fn purge_deletes_expired_reprint_chains_leaf_first_and_cascades_attempts_only() {
        let data_dir = TestDataDir::new();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "expired-source-with-younger-child",
                "printed",
                Some("2026-08-01T12:00:00Z"),
                None,
                None,
            );
            insert_purge_job(
                &conn,
                "younger-child",
                "printed",
                Some("2026-08-08T12:00:00Z"),
                Some("expired-source-with-younger-child"),
                None,
            );

            insert_purge_job(
                &conn,
                "chain-root",
                "printed",
                Some("2026-08-01T12:00:00Z"),
                None,
                None,
            );
            insert_purge_job(
                &conn,
                "chain-middle",
                "failed",
                Some("2026-08-02T12:00:00Z"),
                Some("chain-root"),
                None,
            );
            insert_purge_job(
                &conn,
                "chain-leaf",
                "cancelled",
                Some("2026-08-03T12:00:00Z"),
                Some("chain-middle"),
                None,
            );

            insert_purge_job(
                &conn,
                "attempt-cascade-parent",
                "dispatched",
                Some("2026-08-01T12:00:00Z"),
                None,
                None,
            );
            insert_attempt(&conn, "attempt-cascade-parent", "sent", None);
        }

        let result = purge_expired_print_jobs_at(&db, &data_dir.path, now()).unwrap();
        assert_eq!(result.rows_deleted, 4);
        assert!(result.durable_changed);
        let conn = db.conn.lock().unwrap();
        assert!(job_exists(&conn, "expired-source-with-younger-child"));
        assert!(job_exists(&conn, "younger-child"));
        for id in [
            "chain-root",
            "chain-middle",
            "chain-leaf",
            "attempt-cascade-parent",
        ] {
            assert!(!job_exists(&conn, id));
        }
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM print_job_attempts
                 WHERE print_job_id = 'attempt-cascade-parent'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "attempt rows may cascade only after their unblocked parent is selected"
        );
    }

    #[test]
    fn purge_caps_each_transaction_at_200_in_deterministic_expiry_and_id_order() {
        let data_dir = TestDataDir::new();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            for index in 0..201 {
                insert_purge_job(
                    &conn,
                    &format!("cap-{index:03}"),
                    "printed",
                    Some("2026-08-01T12:00:00Z"),
                    None,
                    None,
                );
            }
        }

        let first = purge_expired_print_jobs_at(&db, &data_dir.path, now()).unwrap();
        assert_eq!(first.rows_deleted, 200);
        assert!(first.durable_changed);
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM print_jobs", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
                1
            );
            assert!(job_exists(&conn, "cap-200"));
        }

        let second = purge_expired_print_jobs_at(&db, &data_dir.path, now()).unwrap();
        assert_eq!(second.rows_deleted, 1);
        assert!(second.durable_changed);
        let third = purge_expired_print_jobs_at(&db, &data_dir.path, now()).unwrap();
        assert_eq!(third.rows_deleted, 0);
        assert!(!third.durable_changed);
    }

    #[test]
    fn purge_selects_expired_leaves_once_per_chain_layer_not_once_per_row() {
        let data_dir = TestDataDir::new();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            for chain in 0..50 {
                let mut parent = None;
                for layer in 0..4 {
                    let id = format!("layered-{chain:03}-{layer}");
                    insert_purge_job(
                        &conn,
                        &id,
                        "printed",
                        Some("2026-08-01T12:00:00Z"),
                        parent.as_deref(),
                        None,
                    );
                    parent = Some(id);
                }
            }
        }
        let ops = TestFileOps::default();
        let probe = CountingPurgeProbe::default();

        let result = purge_expired_print_jobs_at_with_file_ops_and_probe(
            &db,
            &data_dir.path,
            now(),
            &ops,
            &probe,
        )
        .unwrap();

        assert_eq!(result.rows_deleted, 200);
        assert_eq!(
            probe.leaf_selection_layers.load(Ordering::SeqCst),
            4,
            "50 four-row chains require four set-based leaf selections, not 200 full scans"
        );
        assert_eq!(probe.reference_barriers.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn purge_canonicalizes_retained_history_once_and_uses_one_batch_reference_barrier() {
        let data_dir = TestDataDir::new();
        let receipts = data_dir.receipts();
        let candidates = (0..12)
            .map(|index| receipts.join(format!("scale-expired-{index:03}.html")))
            .collect::<Vec<_>>();
        let retained = (0..40)
            .map(|index| receipts.join(format!("scale-retained-{index:03}.html")))
            .collect::<Vec<_>>();
        for path in candidates.iter().chain(retained.iter()) {
            fs::write(path, b"bounded purge complexity fixture").unwrap();
        }

        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            for (index, path) in candidates.iter().enumerate() {
                insert_purge_job(
                    &conn,
                    &format!("scale-expired-{index:03}"),
                    "printed",
                    Some("2026-08-01T12:00:00Z"),
                    None,
                    Some(path),
                );
            }
            for (index, path) in retained.iter().enumerate() {
                insert_purge_job(
                    &conn,
                    &format!("scale-retained-{index:03}"),
                    "printed",
                    Some(FUTURE),
                    None,
                    Some(path),
                );
            }
        }
        let ops = TestFileOps::default();
        let probe = CountingPurgeProbe::default();

        let result = purge_expired_print_jobs_at_with_file_ops_and_probe(
            &db,
            &data_dir.path,
            now(),
            &ops,
            &probe,
        )
        .unwrap();

        assert_eq!(result.rows_deleted, candidates.len());
        assert_eq!(result.files_deleted, candidates.len());
        assert_eq!(
            probe.reference_barriers.load(Ordering::SeqCst),
            1,
            "the complete removable batch must share one BEGIN IMMEDIATE barrier"
        );
        let canonicalize_calls = ops.canonicalize_calls.lock().unwrap();
        for path in &retained {
            assert_eq!(
                canonicalize_calls.get(path).copied().unwrap_or_default(),
                1,
                "each retained reference must be canonicalized once regardless of candidate count"
            );
        }
        for path in &candidates {
            assert_eq!(
                canonicalize_calls.get(path).copied().unwrap_or_default(),
                2,
                "each removable candidate needs preliminary and immediate pre-remove validation"
            );
        }
    }

    #[test]
    fn purge_is_independent_of_global_and_profile_queue_pause_settings() {
        let data_dir = TestDataDir::new();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "paused-queue-terminal",
                "printed",
                Some("2026-08-01T12:00:00Z"),
                None,
                None,
            );
            conn.execute(
                "UPDATE print_jobs SET printer_profile_id = 'profile-paused'
                 WHERE id = 'paused-queue-terminal'",
                [],
            )
            .unwrap();
            db::set_setting(&conn, "printing", "queue_paused", "true").unwrap();
            db::set_setting(
                &conn,
                "printing",
                "queue_paused_profile::profile-paused",
                "true",
            )
            .unwrap();
        }

        let result = purge_expired_print_jobs_at(&db, &data_dir.path, now()).unwrap();
        assert_eq!(result.rows_deleted, 1);
        assert!(result.durable_changed);
    }

    #[test]
    fn purge_deletes_only_trusted_unshared_regular_artifacts_and_serializes_no_paths() {
        let data_dir = TestDataDir::new();
        let receipts = data_dir.receipts();
        let safe = receipts.join("safe-receipt.html");
        let external = data_dir.path.join("external-receipt.html");
        let traversal_target = receipts.join("traversal-receipt.html");
        let traversal = receipts
            .join("existing-directory")
            .join("..")
            .join("traversal-receipt.html");
        let directory = receipts.join("directory-candidate");
        let missing = receipts.join("missing-receipt.html");
        let direct_link = receipts.join("direct-link-receipt.html");
        let intermediate = receipts.join("junction-directory");
        let intermediate_file = intermediate.join("escaped-receipt.html");
        let shared = receipts.join("Shared-Canonical-Receipt.html");
        let shared_alias = if cfg!(windows) {
            receipts.join("shared-canonical-receipt.HTML")
        } else {
            receipts.join(".").join("Shared-Canonical-Receipt.html")
        };
        fs::create_dir_all(receipts.join("existing-directory")).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::create_dir_all(&intermediate).unwrap();
        for path in [
            &safe,
            &external,
            &traversal_target,
            &direct_link,
            &intermediate_file,
            &shared,
        ] {
            fs::write(path, b"isolated Task 8 artifact").unwrap();
        }

        let relative = PathBuf::from("relative-receipt.html");
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            for (id, path) in [
                ("artifact-safe-a", safe.as_path()),
                ("artifact-safe-b", safe.as_path()),
                ("artifact-external", external.as_path()),
                ("artifact-relative", relative.as_path()),
                ("artifact-traversal", traversal.as_path()),
                ("artifact-directory", directory.as_path()),
                ("artifact-missing", missing.as_path()),
                ("artifact-direct-link", direct_link.as_path()),
                ("artifact-intermediate-link", intermediate_file.as_path()),
                ("artifact-shared-deleted", shared.as_path()),
            ] {
                insert_purge_job(
                    &conn,
                    id,
                    "printed",
                    Some("2026-08-01T12:00:00Z"),
                    None,
                    Some(path),
                );
            }
            insert_purge_job(
                &conn,
                "artifact-shared-survivor",
                "printed",
                Some("2026-08-08T12:00:00Z"),
                None,
                Some(&shared_alias),
            );
        }

        let mut ops = TestFileOps::default();
        ops.forced_symlinks.insert(direct_link.clone());
        ops.forced_reparse_points.insert(direct_link.clone());
        ops.forced_reparse_points.insert(intermediate.clone());
        ops.canonical_overrides.insert(
            intermediate_file.clone(),
            fs::canonicalize(&external).unwrap(),
        );

        let result =
            purge_expired_print_jobs_at_with_file_ops(&db, &data_dir.path, now(), &ops).unwrap();
        assert_eq!(
            result,
            PrintJobPurgeResult {
                rows_deleted: 10,
                files_deleted: 1,
                file_cleanup_skipped: 8,
                file_cleanup_failed: 0,
                durable_changed: true,
            }
        );
        assert!(!safe.exists());
        for path in [
            &external,
            &traversal_target,
            &directory,
            &direct_link,
            &intermediate_file,
            &shared,
        ] {
            assert!(path.exists(), "unsafe or shared artifact must remain");
        }
        assert_eq!(ops.remove_calls.lock().unwrap().len(), 1);
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({
                "rowsDeleted": 10,
                "filesDeleted": 1,
                "fileCleanupSkipped": 8,
                "fileCleanupFailed": 0,
                "durableChanged": true,
            }),
            "purge result must expose counts and durable state only"
        );
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("receipt"));
        assert!(!serialized.contains(&data_dir.path.to_string_lossy().to_string()));
    }

    #[test]
    fn purge_skips_all_file_cleanup_when_the_receipts_root_is_untrusted() {
        let data_dir = TestDataDir::new();
        let artifact = data_dir.receipts().join("untrusted-root-receipt.html");
        fs::write(&artifact, b"isolated Task 8 artifact").unwrap();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "untrusted-root-job",
                "failed",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&artifact),
            );
        }
        let mut ops = TestFileOps::default();
        ops.forced_reparse_points.insert(data_dir.receipts());

        let result =
            purge_expired_print_jobs_at_with_file_ops(&db, &data_dir.path, now(), &ops).unwrap();
        assert_eq!(result.rows_deleted, 1);
        assert_eq!(result.files_deleted, 0);
        assert_eq!(result.file_cleanup_skipped, 1);
        assert_eq!(result.file_cleanup_failed, 0);
        assert!(artifact.exists());
        assert!(ops.remove_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn purge_revalidates_a_candidate_immediately_before_remove_when_path_state_changes() {
        let data_dir = TestDataDir::new();
        let candidate = data_dir
            .receipts()
            .join("stateful-revalidation-receipt.html");
        let alternate = data_dir.path.join("stateful-alternate-regular-file.html");
        fs::write(&candidate, b"original isolated Task 8 artifact").unwrap();
        fs::write(&alternate, b"alternate isolated Task 8 artifact").unwrap();
        let base = TestFileOps::default();
        let trusted_canonical = base.canonicalize(&candidate).unwrap();
        let alternate_canonical = base.canonicalize(&alternate).unwrap();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "stateful-revalidation-job",
                "printed",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&candidate),
            );
        }
        let ops = ValidationMutationFileOps {
            base,
            candidate: candidate.clone(),
            trusted_canonical,
            alternate_canonical,
            candidate_canonicalize_calls: AtomicUsize::new(0),
            remove_calls: AtomicUsize::new(0),
            events: Mutex::new(Vec::new()),
        };

        let result =
            purge_expired_print_jobs_at_with_file_ops(&db, &data_dir.path, now(), &ops).unwrap();
        assert_eq!(
            result,
            PrintJobPurgeResult {
                rows_deleted: 1,
                files_deleted: 0,
                file_cleanup_skipped: 1,
                file_cleanup_failed: 0,
                durable_changed: true,
            }
        );
        assert_eq!(
            ops.candidate_canonicalize_calls.load(Ordering::SeqCst),
            2,
            "the candidate must be canonicalized during both validation phases"
        );
        assert_eq!(
            *ops.events.lock().unwrap(),
            ["initial_candidate_validation", "pre_remove_revalidation"],
            "the state change must occur only during immediate pre-remove validation"
        );
        assert_eq!(ops.remove_calls.load(Ordering::SeqCst), 0);
        assert!(candidate.exists());
        assert!(alternate.exists());
        let conn = db.conn.lock().unwrap();
        assert!(!job_exists(&conn, "stateful-revalidation-job"));
    }

    #[test]
    fn purge_commits_before_file_work_and_reacquires_a_final_reference_barrier() {
        let data_dir = TestDataDir::new();
        let artifact = data_dir
            .receipts()
            .join("commit-before-removal-receipt.html");
        let second_artifact = data_dir
            .receipts()
            .join("commit-before-removal-second-receipt.html");
        fs::write(&artifact, b"isolated Task 8 artifact").unwrap();
        fs::write(&second_artifact, b"second isolated Task 8 artifact").unwrap();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "commit-before-removal-job",
                "failed",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&artifact),
            );
            insert_purge_job(
                &conn,
                "commit-before-removal-second-job",
                "cancelled",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&second_artifact),
            );
        }
        let ops = CommitProbeFileOps {
            base: TestFileOps::default(),
            db: &db,
            candidate: artifact.clone(),
            purged_job_id: "commit-before-removal-job",
            callback_calls: AtomicUsize::new(0),
            observed_committed_row: AtomicBool::new(false),
            observed_final_reference_barrier: AtomicBool::new(false),
        };
        let probe = CountingPurgeProbe::default();

        let result = purge_expired_print_jobs_at_with_file_ops_and_probe(
            &db,
            &data_dir.path,
            now(),
            &ops,
            &probe,
        )
        .unwrap();
        assert_eq!(
            result,
            PrintJobPurgeResult {
                rows_deleted: 2,
                files_deleted: 2,
                file_cleanup_skipped: 0,
                file_cleanup_failed: 0,
                durable_changed: true,
            }
        );
        assert_eq!(ops.callback_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            probe.reference_barriers.load(Ordering::SeqCst),
            1,
            "one final reference barrier must cover the complete removal batch"
        );
        assert!(ops.observed_committed_row.load(Ordering::SeqCst));
        assert!(
            ops.observed_final_reference_barrier.load(Ordering::SeqCst),
            "the final DB reference barrier must cover the remove callback"
        );
        assert!(!artifact.exists());
        assert!(!second_artifact.exists());
    }

    #[test]
    fn purge_retains_artifact_when_a_canonical_alias_reference_appears_after_delete_commit() {
        let data_dir = TestDataDir::new();
        let receipts = data_dir.receipts();
        let alias_directory = receipts.join("late-reference-alias-directory");
        fs::create_dir_all(&alias_directory).unwrap();
        let artifact = receipts.join("late-reference-receipt.html");
        let surviving_alias = alias_directory
            .join("..")
            .join("late-reference-receipt.html");
        fs::write(&artifact, b"isolated Task 8 late-reference artifact").unwrap();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "late-reference-expired-job",
                "failed",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&artifact),
            );
        }
        let ops = LateReferenceFileOps {
            base: TestFileOps::default(),
            db: &db,
            candidate: artifact.clone(),
            surviving_alias: surviving_alias.clone(),
            purged_job_id: "late-reference-expired-job",
            injected: AtomicBool::new(false),
            observed_committed_deletion: AtomicBool::new(false),
            remove_calls: AtomicUsize::new(0),
        };

        let result =
            purge_expired_print_jobs_at_with_file_ops(&db, &data_dir.path, now(), &ops).unwrap();

        assert_eq!(result.rows_deleted, 1);
        assert_eq!(result.files_deleted, 0);
        assert_eq!(result.file_cleanup_skipped, 1);
        assert_eq!(result.file_cleanup_failed, 0);
        assert!(result.durable_changed);
        assert!(ops.observed_committed_deletion.load(Ordering::SeqCst));
        assert_eq!(ops.remove_calls.load(Ordering::SeqCst), 0);
        assert!(
            artifact.exists(),
            "a newly shared artifact must be retained"
        );
        let conn = db.conn.lock().unwrap();
        assert!(!job_exists(&conn, "late-reference-expired-job"));
        assert!(job_exists(&conn, "late-surviving-artifact-reference"));
        assert_eq!(
            fs::canonicalize(&surviving_alias).unwrap(),
            fs::canonicalize(&artifact).unwrap(),
            "the late raw reference must be a canonical alias of the artifact"
        );
    }

    #[test]
    fn purge_fails_closed_when_any_live_artifact_reference_cannot_be_canonicalized() {
        let data_dir = TestDataDir::new();
        let receipts = data_dir.receipts();
        let alias_directory = receipts.join("canonical-failure-alias-directory");
        fs::create_dir_all(&alias_directory).unwrap();
        let artifact = receipts.join("canonical-failure-receipt.html");
        let surviving_alias = alias_directory
            .join("..")
            .join("canonical-failure-receipt.html");
        fs::write(
            &artifact,
            b"isolated Task 8 canonicalization failure artifact",
        )
        .unwrap();
        assert_ne!(artifact, surviving_alias);
        assert_eq!(
            fs::canonicalize(&artifact).unwrap(),
            fs::canonicalize(&surviving_alias).unwrap(),
            "the injected failure must hide a real canonical alias"
        );

        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "canonical-failure-expired-job",
                "failed",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&artifact),
            );
            insert_purge_job(
                &conn,
                "canonical-failure-live-reference",
                "printed",
                Some(FUTURE),
                None,
                Some(&surviving_alias),
            );
        }
        let mut ops = TestFileOps::default();
        ops.canonicalize_failures.insert(surviving_alias.clone());

        let result =
            purge_expired_print_jobs_at_with_file_ops(&db, &data_dir.path, now(), &ops).unwrap();

        assert_eq!(
            result,
            PrintJobPurgeResult {
                rows_deleted: 1,
                files_deleted: 0,
                file_cleanup_skipped: 1,
                file_cleanup_failed: 0,
                durable_changed: true,
            }
        );
        assert!(
            artifact.exists(),
            "an unresolved live alias must fail closed"
        );
        assert!(ops.remove_calls.lock().unwrap().is_empty());
        let conn = db.conn.lock().unwrap();
        assert!(!job_exists(&conn, "canonical-failure-expired-job"));
        assert!(job_exists(&conn, "canonical-failure-live-reference"));
    }

    #[test]
    fn purge_rolls_back_sql_before_touching_files_when_a_delete_trigger_aborts() {
        let data_dir = TestDataDir::new();
        let first_artifact = data_dir.receipts().join("secret-rollback-first.html");
        let later_artifact = data_dir.receipts().join("secret-rollback-later.html");
        fs::write(&first_artifact, b"first isolated Task 8 artifact").unwrap();
        fs::write(&later_artifact, b"later isolated Task 8 artifact").unwrap();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "rollback-a-first-job",
                "cancelled",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&first_artifact),
            );
            insert_purge_job(
                &conn,
                "rollback-z-later-job",
                "cancelled",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&later_artifact),
            );
            conn.execute_batch(
                "CREATE TRIGGER task8_force_purge_rollback
                 BEFORE DELETE ON print_jobs
                 WHEN OLD.id = 'rollback-z-later-job'
                 BEGIN
                     SELECT RAISE(ABORT, 'forced Task 8 purge rollback');
                 END;",
            )
            .unwrap();
        }

        let error = purge_expired_print_jobs_at(&db, &data_dir.path, now()).unwrap_err();
        assert!(!error.contains("secret-rollback-first"));
        assert!(!error.contains("secret-rollback-later"));
        assert!(first_artifact.exists());
        assert!(later_artifact.exists());
        let conn = db.conn.lock().unwrap();
        assert!(
            job_exists(&conn, "rollback-a-first-job"),
            "the earlier DELETE must roll back when the later guarded DELETE aborts"
        );
        assert!(job_exists(&conn, "rollback-z-later-job"));
    }

    #[test]
    fn purge_commits_rows_even_when_a_real_remove_attempt_fails() {
        let data_dir = TestDataDir::new();
        let artifact = data_dir.receipts().join("remove-failure-receipt.html");
        fs::write(&artifact, b"isolated Task 8 artifact").unwrap();
        let db = test_db();
        {
            let conn = db.conn.lock().unwrap();
            insert_purge_job(
                &conn,
                "remove-failure-job",
                "dispatched",
                Some("2026-08-01T12:00:00Z"),
                None,
                Some(&artifact),
            );
        }
        let mut ops = TestFileOps::default();
        let canonical_artifact = ops.canonicalize(&artifact).unwrap();
        ops.remove_failures.insert(canonical_artifact);

        let result =
            purge_expired_print_jobs_at_with_file_ops(&db, &data_dir.path, now(), &ops).unwrap();
        assert_eq!(result.rows_deleted, 1);
        assert_eq!(result.files_deleted, 0);
        assert_eq!(result.file_cleanup_skipped, 0);
        assert_eq!(result.file_cleanup_failed, 1);
        assert!(result.durable_changed);
        assert!(artifact.exists());
        let conn = db.conn.lock().unwrap();
        assert!(!job_exists(&conn, "remove-failure-job"));
    }

    #[test]
    fn concurrent_file_db_double_click_creates_exactly_one_active_direct_child() {
        let path = test_file_db_path();
        {
            let db = open_file_db(&path);
            let conn = db.conn.lock().unwrap();
            insert_job(&conn, "concurrent-source", "order_receipt", "printed", true);
        }
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let thread_path = path.clone();
            let thread_barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let db = open_file_db(&thread_path);
                thread_barrier.wait();
                clone_reprint_job(&db, "concurrent-source", now())
            }));
        }
        barrier.wait();
        let results: Vec<PrintHistoryMutationResult> = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker thread").expect("clone result"))
            .collect();
        assert_eq!(
            results.iter().map(|result| result.affected).sum::<usize>(),
            1,
            "only one concurrent request may insert a child"
        );
        assert_eq!(results[0].job_id, "concurrent-source");
        assert_eq!(results[1].job_id, "concurrent-source");
        assert_eq!(results[0].new_job_id, results[1].new_job_id);

        let db = open_file_db(&path);
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs
                 WHERE reprint_of_job_id = 'concurrent-source'
                   AND status IN ('pending', 'printing')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(conn);
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
