use chrono::{DateTime, Duration, TimeZone, Utc};
use rusqlite::{
    types::{Value as SqlValue, ValueRef},
    Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::{db, storage};

const RECOVERY_DIR_NAME: &str = "recovery";
const RECOVERY_POINTS_DIR: &str = "points";
const RECOVERY_EXPORTS_DIR: &str = "exports";
const RECOVERY_QUARANTINE_DIR: &str = "quarantine";
const RECOVERY_PENDING_DIR: &str = "pending_restore";
const SNAPSHOT_FILE_NAME: &str = "snapshot.db";
const SNAPSHOT_WAL_FILE_NAME: &str = "snapshot.db-wal";
const SNAPSHOT_SHM_FILE_NAME: &str = "snapshot.db-shm";
const METADATA_FILE_NAME: &str = "metadata.json";
const RESTORE_FILE_NAME: &str = "restore.json";
const DENSE_RETENTION_HOURS: i64 = 24;
const TOTAL_RETENTION_DAYS: i64 = 7;
const DEFAULT_SNAPSHOT_INTERVAL_SECS: u64 = 15 * 60;
const RESTORED_ATTEMPT_UNKNOWN_OUTCOME_ERROR: &str =
    "Recovery cancelled an orphaned attempt; previous print outcome is unknown";
// Wave 5 C18: `parity_sync_queue` (added in migration v44) and
// `conflict_audit_log` were absent from both `POINT_TABLES` and
// `FINGERPRINT_TABLES`. Snapshots taken while items were queued in those
// tables under-reported sync backlog, so an operator evaluating a
// recovery point might wrongly conclude the queue was drained. Adding
// them here means recovery-point metadata and table-count fingerprints
// reflect the full durable queue surface.
//
// Wave 5 Session 7 PR 2: `sync_queue` dropped in migration v56 and
// removed from both arrays below. `parity_sync_queue` is now the sole
// durable queue surface; `conflict_audit_log` stays for conflict-history
// coverage.
const POINT_TABLES: &[&str] = &[
    "orders",
    "staff_shifts",
    "cash_drawer_sessions",
    "order_payments",
    "payment_adjustments",
    "shift_expenses",
    "driver_earnings",
    "z_reports",
    "parity_sync_queue",
    "conflict_audit_log",
];
const FINGERPRINT_TABLES: &[(&str, &[&str])] = &[
    ("orders", &["updated_at", "created_at"]),
    (
        "staff_shifts",
        &["updated_at", "check_out_time", "check_in_time"],
    ),
    (
        "cash_drawer_sessions",
        &["updated_at", "closed_at", "opened_at"],
    ),
    ("order_payments", &["updated_at", "created_at"]),
    ("payment_adjustments", &["updated_at", "created_at"]),
    ("shift_expenses", &["updated_at", "created_at"]),
    ("driver_earnings", &["updated_at", "created_at"]),
    ("z_reports", &["updated_at", "generated_at", "created_at"]),
    ("parity_sync_queue", &["updated_at", "created_at"]),
    ("conflict_audit_log", &["created_at"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPointKind {
    Scheduled,
    Manual,
    PreRecoveryAction,
    PreFactoryReset,
    PreEmergencyReset,
    PreClearOperationalData,
    PreRestore,
    PreMigration,
    QuarantinedOpenFailure,
}

impl RecoveryPointKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
            Self::PreRecoveryAction => "pre_recovery_action",
            Self::PreFactoryReset => "pre_factory_reset",
            Self::PreEmergencyReset => "pre_emergency_reset",
            Self::PreClearOperationalData => "pre_clear_operational_data",
            Self::PreRestore => "pre_restore",
            Self::PreMigration => "pre_migration",
            Self::QuarantinedOpenFailure => "quarantined_open_failure",
        }
    }

    fn is_destructive(self) -> bool {
        matches!(
            self,
            Self::PreRecoveryAction
                | Self::PreFactoryReset
                | Self::PreEmergencyReset
                | Self::PreClearOperationalData
                | Self::PreRestore
                | Self::PreMigration
                | Self::QuarantinedOpenFailure
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPointMetadata {
    pub id: String,
    pub kind: RecoveryPointKind,
    pub created_at: String,
    pub path: String,
    pub snapshot_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wal_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shm_path: Option<String>,
    pub schema_version: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    pub db_size_bytes: u64,
    pub snapshot_size_bytes: u64,
    pub fingerprint: String,
    pub table_counts: BTreeMap<String, i64>,
    pub sync_backlog: BTreeMap<String, BTreeMap<String, i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_period_start_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_report_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_z_report_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_z_report_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_z_report_generated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_z_report_sync_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_z_report_timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryListResponse {
    pub success: bool,
    pub points: Vec<RecoveryPointMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryExportResponse {
    pub success: bool,
    pub path: String,
    pub export_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRestoreResponse {
    pub success: bool,
    pub staged: bool,
    pub restart_required: bool,
    pub point_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_restore_point_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRestoreMetadata {
    point_id: String,
    created_at: String,
    staged_snapshot_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    staged_wal_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staged_shm_path: Option<String>,
    metadata: RecoveryPointMetadata,
}

struct SnapshotLayout {
    temp_dir: PathBuf,
    final_dir: PathBuf,
    temp_snapshot_path: PathBuf,
    final_snapshot_path: PathBuf,
}

pub(crate) fn recovery_root_for_db(db: &db::DbState) -> PathBuf {
    db.db_path
        .parent()
        .map(recovery_root_for_app_data)
        .unwrap_or_else(|| PathBuf::from(RECOVERY_DIR_NAME))
}

pub(crate) fn recovery_root_for_app_data(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(RECOVERY_DIR_NAME)
}

fn points_dir(root: &Path) -> PathBuf {
    root.join(RECOVERY_POINTS_DIR)
}

fn exports_dir(root: &Path) -> PathBuf {
    root.join(RECOVERY_EXPORTS_DIR)
}

fn quarantine_dir(root: &Path) -> PathBuf {
    root.join(RECOVERY_QUARANTINE_DIR)
}

fn pending_restore_dir(root: &Path) -> PathBuf {
    root.join(RECOVERY_PENDING_DIR)
}

fn parse_restored_attempt_target(value: &str, tag: &str) -> Option<(String, u64)> {
    let rest = value.strip_prefix(&format!("{tag}:"))?;
    let (length, rest) = rest.split_once(':')?;
    let length = length.parse::<usize>().ok()?;
    if rest.len() <= length || !rest.is_char_boundary(length) || rest.as_bytes()[length] != b':' {
        return None;
    }
    let component = rest[..length].to_owned();
    let suffix = rest[length + 1..].parse::<u64>().ok()?;
    Some((component, suffix))
}

fn restored_attempt_target_key(transport: &str, resolved_target: &str) -> Option<String> {
    let target = match transport {
        "windows" => {
            crate::print_dispatch::PrinterTargetKey::WindowsQueue(resolved_target.to_owned())
        }
        "raw_tcp" => {
            let (host, port) = parse_restored_attempt_target(resolved_target, "host")?;
            crate::print_dispatch::PrinterTargetKey::RawTcp {
                host,
                port: u16::try_from(port).ok()?,
            }
        }
        "serial" => {
            let (port_name, baud_rate) = parse_restored_attempt_target(resolved_target, "port")?;
            crate::print_dispatch::PrinterTargetKey::Serial {
                port_name,
                baud_rate: u32::try_from(baud_rate).ok()?,
            }
        }
        _ => return None,
    };
    crate::print_dispatch::normalize_target(&target).ok()
}

struct RestoredAttemptCandidate {
    row_id: i64,
    attempt_id: String,
    print_job_id: String,
    transport: String,
    resolved_target: String,
    document_name: String,
    spool_job_id: SqlValue,
    state: String,
}

fn restored_attempt_matches_windows_reconciliation_contract(
    attempt: &RestoredAttemptCandidate,
) -> bool {
    if attempt.transport != "windows"
        || !matches!(
            attempt.state.as_str(),
            "windows_queued"
                | "windows_printing"
                | "paused"
                | "cancel_requested"
                | "unknown"
                | "cancel_failed"
                | "spool_error"
        )
        || restored_attempt_target_key(&attempt.transport, &attempt.resolved_target).is_none()
    {
        return false;
    }

    let SqlValue::Integer(spool_job_id) = &attempt.spool_job_id else {
        return false;
    };
    let Ok(spool_job_id) = u32::try_from(*spool_job_id) else {
        return false;
    };
    if spool_job_id == 0 {
        return false;
    }

    let Ok(attempt_id) = Uuid::parse_str(&attempt.attempt_id) else {
        return false;
    };
    let Ok(print_job_id) = Uuid::parse_str(&attempt.print_job_id) else {
        return false;
    };
    let Ok(marker) = crate::windows_spooler::parse_document_marker(&attempt.document_name) else {
        return false;
    };
    marker.attempt_id == attempt_id && marker.local_job_id == print_job_id
}

fn cancel_replayable_restored_print_jobs(db_path: &Path) -> Result<usize, String> {
    let mut conn = Connection::open(db_path)
        .map_err(|e| format!("open restored database to cancel print replay: {e}"))?;
    let columns = read_table_columns(&conn, "print_jobs")?;
    let has_completed_at = columns.iter().any(|column| column == "completed_at");
    let has_history_expires_at = columns.iter().any(|column| column == "history_expires_at");
    let has_attempts = table_exists(&conn, "print_job_attempts")?;
    let has_target_state = table_exists(&conn, "print_target_state")?;
    let update = match (has_completed_at, has_history_expires_at) {
        (true, true) => {
            "UPDATE print_jobs
             SET status = 'cancelled',
                 warning_code = 'restored_cancelled',
                 warning_message = 'Print job cancelled during recovery restore',
                 updated_at = ?1,
                 completed_at = ?1,
                 history_expires_at = datetime(?1, '+30 days')
             WHERE status IN ('pending', 'printing')"
        }
        (true, false) => {
            "UPDATE print_jobs
             SET status = 'cancelled',
                 warning_code = 'restored_cancelled',
                 warning_message = 'Print job cancelled during recovery restore',
                 updated_at = ?1,
                 completed_at = ?1
             WHERE status IN ('pending', 'printing')"
        }
        (false, true) => {
            "UPDATE print_jobs
             SET status = 'cancelled',
                 warning_code = 'restored_cancelled',
                 warning_message = 'Print job cancelled during recovery restore',
                 updated_at = ?1,
                 history_expires_at = datetime(?1, '+30 days')
             WHERE status IN ('pending', 'printing')"
        }
        (false, false) => {
            "UPDATE print_jobs
             SET status = 'cancelled',
                 warning_code = 'restored_cancelled',
                 warning_message = 'Print job cancelled during recovery restore',
                 updated_at = ?1
             WHERE status IN ('pending', 'printing')"
        }
    };
    let now = Utc::now().to_rfc3339();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin restored print cancellation transaction: {e}"))?;

    if has_attempts {
        let orphan_attempts = {
            let restoration_candidates = format!(
                "({} OR attempt.state = 'spool_error')",
                crate::print_dispatch::shared_attempt_blocker_predicate_sql("attempt"),
            );
            let mut statement = tx
                .prepare(&format!(
                    "SELECT attempt.rowid, attempt.id, attempt.print_job_id,
                            attempt.transport, attempt.resolved_target, attempt.document_name,
                            attempt.spool_job_id, attempt.state
                     FROM print_job_attempts attempt
                     JOIN print_jobs job ON job.id = attempt.print_job_id
                     WHERE job.status IN ('pending', 'printing')
                       AND {restoration_candidates}",
                ))
                .map_err(|e| format!("prepare restored active print attempts: {e}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(RestoredAttemptCandidate {
                        row_id: row.get(0)?,
                        attempt_id: row.get(1)?,
                        print_job_id: row.get(2)?,
                        transport: row.get(3)?,
                        resolved_target: row.get(4)?,
                        document_name: row.get(5)?,
                        spool_job_id: row.get(6)?,
                        state: row.get(7)?,
                    })
                })
                .map_err(|e| format!("query restored active print attempts: {e}"))?;
            let mut attempts = Vec::new();
            for row in rows {
                let attempt =
                    row.map_err(|e| format!("read restored active print attempt: {e}"))?;
                if !restored_attempt_matches_windows_reconciliation_contract(&attempt) {
                    attempts.push(attempt);
                }
            }
            attempts
        };

        let terminalized_target_keys = orphan_attempts
            .iter()
            .filter_map(|attempt| {
                restored_attempt_target_key(&attempt.transport, &attempt.resolved_target)
            })
            .collect::<HashSet<_>>();
        for attempt in orphan_attempts {
            tx.execute(
                "UPDATE print_job_attempts
                 SET state = 'cancelled',
                     last_seen_at = ?1,
                     completed_at = ?1,
                     cancel_confirmed_at = ?1,
                     last_error = ?2
                 WHERE rowid = ?3",
                rusqlite::params![now, RESTORED_ATTEMPT_UNKNOWN_OUTCOME_ERROR, attempt.row_id],
            )
            .map_err(|e| format!("terminalize restored orphan print attempt: {e}"))?;
        }

        if has_target_state && !terminalized_target_keys.is_empty() {
            let remaining_blocker_keys = {
                let shared_blocker = crate::print_dispatch::shared_attempt_blocker_predicate_sql(
                    "print_job_attempts",
                );
                let mut statement = tx
                    .prepare(&format!(
                        "SELECT transport, resolved_target
                         FROM print_job_attempts
                         WHERE {shared_blocker}",
                    ))
                    .map_err(|e| format!("prepare remaining restored attempt blockers: {e}"))?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|e| format!("query remaining restored attempt blockers: {e}"))?;
                let mut keys = HashSet::new();
                for row in rows {
                    let (transport, resolved_target) =
                        row.map_err(|e| format!("read remaining restored attempt blocker: {e}"))?;
                    if let Some(key) = restored_attempt_target_key(&transport, &resolved_target) {
                        keys.insert(key);
                    }
                }
                keys
            };

            for target_key in terminalized_target_keys {
                if remaining_blocker_keys.contains(&target_key) {
                    continue;
                }
                tx.execute(
                    "UPDATE print_target_state
                     SET circuit_state = 'closed',
                         blocked_reason = NULL,
                         blocked_at = NULL,
                         updated_at = ?1
                     WHERE target_key = ?2 AND circuit_state = 'open'",
                    rusqlite::params![now, target_key],
                )
                .map_err(|e| format!("reset restored orphan print target circuit: {e}"))?;
            }
        }
    }

    let cancelled = tx
        .execute(update, rusqlite::params![now])
        .map_err(|e| format!("cancel replayable restored print jobs: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit restored print cancellation transaction: {e}"))?;
    Ok(cancelled)
}

pub(crate) fn ensure_recovery_dirs(app_data_dir: &Path) -> Result<(), String> {
    let root = recovery_root_for_app_data(app_data_dir);
    fs::create_dir_all(points_dir(&root))
        .map_err(|e| format!("create recovery points dir: {e}"))?;
    fs::create_dir_all(exports_dir(&root))
        .map_err(|e| format!("create recovery exports dir: {e}"))?;
    fs::create_dir_all(quarantine_dir(&root))
        .map_err(|e| format!("create recovery quarantine dir: {e}"))?;
    Ok(())
}

pub(crate) fn start_snapshot_monitor(
    db: Arc<db::DbState>,
    interval_secs: u64,
    cancel: tokio_util::sync::CancellationToken,
) {
    let cadence = std::time::Duration::from_secs(interval_secs.max(DEFAULT_SNAPSHOT_INTERVAL_SECS));
    tauri::async_runtime::spawn(async move {
        info!(
            interval_secs = cadence.as_secs(),
            "Recovery snapshot monitor started"
        );
        loop {
            if let Err(error) = maybe_create_scheduled_snapshot(db.as_ref()) {
                warn!(error = %error, "Scheduled recovery snapshot failed");
            }

            tokio::select! {
                _ = tokio::time::sleep(cadence) => {}
                _ = cancel.cancelled() => {
                    info!("Recovery snapshot monitor cancelled");
                    break;
                }
            }
        }
    });
}

pub(crate) fn maybe_apply_pending_restore(app_data_dir: &Path) -> Result<Option<Value>, String> {
    ensure_recovery_dirs(app_data_dir)?;
    let root = recovery_root_for_app_data(app_data_dir);
    let pending_dir = pending_restore_dir(&root);
    let restore_file = pending_dir.join(RESTORE_FILE_NAME);
    if !restore_file.exists() {
        return Ok(None);
    }

    let raw =
        fs::read_to_string(&restore_file).map_err(|e| format!("read pending restore: {e}"))?;
    let staged: PendingRestoreMetadata =
        serde_json::from_str(&raw).map_err(|e| format!("parse pending restore: {e}"))?;

    let staged_snapshot = PathBuf::from(&staged.staged_snapshot_path);
    if !staged_snapshot.exists() {
        return Err("Pending restore snapshot file is missing".into());
    }

    let db_path = app_data_dir.join("pos.db");
    let wal_path = app_data_dir.join("pos.db-wal");
    let shm_path = app_data_dir.join("pos.db-shm");
    let rollback_dir = pending_dir.join("rollback");

    if rollback_dir.exists() {
        let _ = fs::remove_dir_all(&rollback_dir);
    }
    fs::create_dir_all(&rollback_dir).map_err(|e| format!("create restore rollback dir: {e}"))?;

    let mut moved_files: Vec<(PathBuf, PathBuf)> = Vec::new();
    for path in [&db_path, &wal_path, &shm_path] {
        if path.exists() {
            let file_name = path
                .file_name()
                .map(PathBuf::from)
                .ok_or_else(|| format!("invalid database path: {}", path.display()))?;
            let backup_path = rollback_dir.join(file_name);
            fs::rename(path, &backup_path)
                .map_err(|e| format!("move existing database file {}: {e}", path.display()))?;
            moved_files.push((backup_path, path.to_path_buf()));
        }
    }

    let apply_result = (|| {
        fs::copy(&staged_snapshot, &db_path)
            .map_err(|e| format!("restore snapshot database file: {e}"))?;
        if let Some(wal_path_value) = staged.staged_wal_path.as_deref() {
            let source = PathBuf::from(wal_path_value);
            if source.exists() {
                fs::copy(&source, &wal_path)
                    .map_err(|e| format!("restore snapshot wal file: {e}"))?;
            }
        }
        if let Some(shm_path_value) = staged.staged_shm_path.as_deref() {
            let source = PathBuf::from(shm_path_value);
            if source.exists() {
                fs::copy(&source, &shm_path)
                    .map_err(|e| format!("restore snapshot shm file: {e}"))?;
            }
        }
        let cancelled_jobs = cancel_replayable_restored_print_jobs(&db_path)?;
        if cancelled_jobs > 0 {
            info!(
                cancelled_jobs,
                point_id = %staged.point_id,
                "Cancelled replayable print jobs on restored snapshot"
            );
        }
        Ok::<(), String>(())
    })();

    if let Err(error) = apply_result {
        let _ = fs::remove_file(&db_path);
        let _ = fs::remove_file(&wal_path);
        let _ = fs::remove_file(&shm_path);
        for (backup_path, original_path) in moved_files.into_iter().rev() {
            let _ = fs::rename(&backup_path, &original_path);
        }
        return Err(error);
    }

    let _ = fs::remove_dir_all(&rollback_dir);
    let _ = fs::remove_dir_all(&pending_dir);

    Ok(Some(json!({
        "success": true,
        "pointId": staged.point_id,
        "createdAt": staged.created_at,
        "cancelledPrintReplayJobs": true,
    })))
}

pub(crate) fn create_manual_snapshot(db: &db::DbState) -> Result<RecoveryPointMetadata, String> {
    create_snapshot_for_db(db, RecoveryPointKind::Manual, None)
}

pub(crate) fn create_pre_recovery_action_snapshot(
    db: &db::DbState,
) -> Result<RecoveryPointMetadata, String> {
    create_snapshot_for_db(db, RecoveryPointKind::PreRecoveryAction, None)
}

pub(crate) fn snapshot_before_destructive_action(
    db: &db::DbState,
    kind: RecoveryPointKind,
) -> Result<RecoveryPointMetadata, String> {
    create_snapshot_for_db(db, kind, None)
}

pub(crate) fn maybe_create_scheduled_snapshot(
    db: &db::DbState,
) -> Result<Option<RecoveryPointMetadata>, String> {
    let current_fingerprint = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        compute_operational_fingerprint(&conn)?
    };

    let points = list_recovery_points(db)?;
    if let Some(latest) = points.first() {
        if latest.fingerprint == current_fingerprint {
            return Ok(None);
        }
    }

    let point =
        create_snapshot_for_db(db, RecoveryPointKind::Scheduled, Some(current_fingerprint))?;
    Ok(Some(point))
}

pub(crate) fn create_pre_migration_snapshot(
    db_path: &Path,
    conn: &Connection,
) -> Result<Option<RecoveryPointMetadata>, String> {
    if !db_path.exists() {
        return Ok(None);
    }

    let app_data_dir = db_path
        .parent()
        .ok_or_else(|| "database path does not have a parent directory".to_string())?;
    ensure_recovery_dirs(app_data_dir)?;
    let root = recovery_root_for_app_data(app_data_dir);

    let point = create_snapshot_from_connection(
        conn,
        db_path,
        RecoveryPointKind::PreMigration,
        points_dir(&root),
        None,
        None,
    )?;

    prune_recovery_points(&root)?;
    Ok(Some(point))
}

pub(crate) fn quarantine_database_files(
    app_data_dir: &Path,
    db_path: &Path,
    reason: &str,
) -> Result<Option<RecoveryPointMetadata>, String> {
    let wal_path = app_data_dir.join("pos.db-wal");
    let shm_path = app_data_dir.join("pos.db-shm");
    if !db_path.exists() && !wal_path.exists() && !shm_path.exists() {
        return Ok(None);
    }

    ensure_recovery_dirs(app_data_dir)?;
    let root = recovery_root_for_app_data(app_data_dir);
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let dir_name = format!(
        "{}-{}-{}",
        Utc::now().format("%Y%m%d_%H%M%S"),
        RecoveryPointKind::QuarantinedOpenFailure.as_str(),
        &id
    );
    let temp_dir = quarantine_dir(&root).join(format!(".tmp-{dir_name}"));
    let final_dir = quarantine_dir(&root).join(dir_name);
    fs::create_dir_all(&temp_dir).map_err(|e| format!("create quarantine temp dir: {e}"))?;

    let snapshot_path = temp_dir.join(SNAPSHOT_FILE_NAME);
    let snapshot_wal_path = temp_dir.join(SNAPSHOT_WAL_FILE_NAME);
    let snapshot_shm_path = temp_dir.join(SNAPSHOT_SHM_FILE_NAME);
    let final_snapshot_wal_path = final_dir.join(SNAPSHOT_WAL_FILE_NAME);
    let final_snapshot_shm_path = final_dir.join(SNAPSHOT_SHM_FILE_NAME);

    if db_path.exists() {
        fs::rename(db_path, &snapshot_path)
            .map_err(|e| format!("move primary database into quarantine: {e}"))?;
    }
    if wal_path.exists() {
        fs::rename(&wal_path, &snapshot_wal_path)
            .map_err(|e| format!("move wal database into quarantine: {e}"))?;
    }
    if shm_path.exists() {
        fs::rename(&shm_path, &snapshot_shm_path)
            .map_err(|e| format!("move shm database into quarantine: {e}"))?;
    }

    let metadata = match open_snapshot_connection(&snapshot_path) {
        Ok(conn) => build_metadata_from_connection(
            &conn,
            db_path,
            RecoveryPointKind::QuarantinedOpenFailure,
            &id,
            &final_dir,
            &final_dir.join(SNAPSHOT_FILE_NAME),
            if snapshot_wal_path.exists() {
                Some(&final_snapshot_wal_path)
            } else {
                None
            },
            if snapshot_shm_path.exists() {
                Some(&final_snapshot_shm_path)
            } else {
                None
            },
            Some(reason.to_string()),
            fs::metadata(&snapshot_path)
                .map(|meta| meta.len())
                .unwrap_or(0),
        )?,
        Err(_) => build_storage_only_metadata(
            db_path,
            RecoveryPointKind::QuarantinedOpenFailure,
            &id,
            &created_at,
            &final_dir,
            &final_dir.join(SNAPSHOT_FILE_NAME),
            if snapshot_wal_path.exists() {
                Some(&final_snapshot_wal_path)
            } else {
                None
            },
            if snapshot_shm_path.exists() {
                Some(&final_snapshot_shm_path)
            } else {
                None
            },
            Some(reason.to_string()),
            fs::metadata(&snapshot_path)
                .map(|meta| meta.len())
                .unwrap_or(0),
        ),
    };

    write_json_file(&temp_dir.join(METADATA_FILE_NAME), &metadata)?;
    fs::rename(&temp_dir, &final_dir).map_err(|e| format!("finalize quarantine dir: {e}"))?;
    prune_recovery_points(&root)?;

    Ok(Some(metadata))
}

pub(crate) fn list_recovery_points(db: &db::DbState) -> Result<Vec<RecoveryPointMetadata>, String> {
    let root = recovery_root_for_db(db);
    load_recovery_points(&root)
}

pub(crate) fn export_current_bundle(db: &db::DbState) -> Result<RecoveryExportResponse, String> {
    let root = recovery_root_for_db(db);
    let exports_root = exports_dir(&root);
    fs::create_dir_all(&exports_root).map_err(|e| format!("create recovery exports dir: {e}"))?;

    let temp_export_dir = exports_root.join(format!(".tmp-current-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_export_dir)
        .map_err(|e| format!("create temporary export dir: {e}"))?;
    let temp_snapshot_path = temp_export_dir.join(SNAPSHOT_FILE_NAME);
    let final_zip = exports_root.join(format!(
        "thesmall-pos-recovery-current-{}.zip",
        Utc::now().format("%Y%m%d_%H%M%S")
    ));

    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        vacuum_into_snapshot(&conn, &temp_snapshot_path)?;
    }

    let snapshot_conn = open_snapshot_connection(&temp_snapshot_path)?;
    let metadata = build_metadata_from_connection(
        &snapshot_conn,
        &db.db_path,
        RecoveryPointKind::Manual,
        "current-export",
        &temp_export_dir,
        &temp_snapshot_path,
        None,
        None,
        None,
        fs::metadata(&temp_snapshot_path)
            .map(|meta| meta.len())
            .unwrap_or(0),
    )?;
    write_export_bundle(&snapshot_conn, &metadata, &temp_snapshot_path, &final_zip)?;
    let _ = fs::remove_dir_all(&temp_export_dir);

    Ok(RecoveryExportResponse {
        success: true,
        path: final_zip.to_string_lossy().to_string(),
        export_kind: "current".to_string(),
        point_id: None,
    })
}

pub(crate) fn export_recovery_point(
    db: &db::DbState,
    point_id: &str,
) -> Result<RecoveryExportResponse, String> {
    let root = recovery_root_for_db(db);
    let point = load_recovery_point_by_id(&root, point_id)?
        .ok_or_else(|| format!("Recovery point not found: {point_id}"))?;
    let exports_root = exports_dir(&root);
    fs::create_dir_all(&exports_root).map_err(|e| format!("create recovery exports dir: {e}"))?;

    let snapshot_path = PathBuf::from(&point.snapshot_path);
    let snapshot_conn = open_snapshot_connection(&snapshot_path)?;
    let final_zip = exports_root.join(format!(
        "thesmall-pos-recovery-{}-{}.zip",
        point.id,
        Utc::now().format("%Y%m%d_%H%M%S")
    ));
    write_export_bundle(&snapshot_conn, &point, &snapshot_path, &final_zip)?;

    Ok(RecoveryExportResponse {
        success: true,
        path: final_zip.to_string_lossy().to_string(),
        export_kind: "point".to_string(),
        point_id: Some(point.id),
    })
}

pub(crate) fn stage_restore_from_point(
    db: &db::DbState,
    point_id: &str,
) -> Result<RecoveryRestoreResponse, String> {
    let root = recovery_root_for_db(db);
    let point = load_recovery_point_by_id(&root, point_id)?
        .ok_or_else(|| format!("Recovery point not found: {point_id}"))?;

    validate_restore_point(db, &point)?;
    let pre_restore = create_snapshot_for_db(db, RecoveryPointKind::PreRestore, None)?;

    let pending_dir = pending_restore_dir(&root);
    if pending_dir.exists() {
        let _ = fs::remove_dir_all(&pending_dir);
    }
    fs::create_dir_all(&pending_dir).map_err(|e| format!("create pending restore dir: {e}"))?;

    let staged_snapshot_path = pending_dir.join(SNAPSHOT_FILE_NAME);
    fs::copy(PathBuf::from(&point.snapshot_path), &staged_snapshot_path)
        .map_err(|e| format!("stage restore snapshot: {e}"))?;

    let staged_wal_path = if let Some(path) = point.wal_path.as_deref() {
        let source = PathBuf::from(path);
        if source.exists() {
            let staged = pending_dir.join(SNAPSHOT_WAL_FILE_NAME);
            fs::copy(&source, &staged).map_err(|e| format!("stage restore wal: {e}"))?;
            Some(staged.to_string_lossy().to_string())
        } else {
            None
        }
    } else {
        None
    };

    let staged_shm_path = if let Some(path) = point.shm_path.as_deref() {
        let source = PathBuf::from(path);
        if source.exists() {
            let staged = pending_dir.join(SNAPSHOT_SHM_FILE_NAME);
            fs::copy(&source, &staged).map_err(|e| format!("stage restore shm: {e}"))?;
            Some(staged.to_string_lossy().to_string())
        } else {
            None
        }
    } else {
        None
    };

    let pending = PendingRestoreMetadata {
        point_id: point.id.clone(),
        created_at: Utc::now().to_rfc3339(),
        staged_snapshot_path: staged_snapshot_path.to_string_lossy().to_string(),
        staged_wal_path,
        staged_shm_path,
        metadata: point.clone(),
    };
    write_json_file(&pending_dir.join(RESTORE_FILE_NAME), &pending)?;

    Ok(RecoveryRestoreResponse {
        success: true,
        staged: true,
        restart_required: true,
        point_id: point.id,
        pre_restore_point_id: Some(pre_restore.id),
        message: "Recovery restore staged. Restart the app to apply it. Restored print jobs will be cancelled and will not replay automatically.".into(),
    })
}

fn create_snapshot_for_db(
    db: &db::DbState,
    kind: RecoveryPointKind,
    existing_fingerprint: Option<String>,
) -> Result<RecoveryPointMetadata, String> {
    let app_data_dir = db
        .db_path
        .parent()
        .ok_or_else(|| "database path does not have a parent directory".to_string())?;
    ensure_recovery_dirs(app_data_dir)?;
    let root = recovery_root_for_app_data(app_data_dir);
    let point = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        create_snapshot_from_connection(
            &conn,
            &db.db_path,
            kind,
            points_dir(&root),
            existing_fingerprint,
            None,
        )?
    };
    prune_recovery_points(&root)?;
    Ok(point)
}

fn create_snapshot_from_connection(
    conn: &Connection,
    db_path: &Path,
    kind: RecoveryPointKind,
    output_dir: PathBuf,
    existing_fingerprint: Option<String>,
    error: Option<String>,
) -> Result<RecoveryPointMetadata, String> {
    fs::create_dir_all(&output_dir).map_err(|e| format!("create recovery output dir: {e}"))?;
    let layout = build_snapshot_layout(&output_dir, kind);
    fs::create_dir_all(&layout.temp_dir).map_err(|e| format!("create recovery temp dir: {e}"))?;
    vacuum_into_snapshot(conn, &layout.temp_snapshot_path)?;

    let snapshot_size = fs::metadata(&layout.temp_snapshot_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    let mut metadata = build_metadata_from_connection(
        conn,
        db_path,
        kind,
        layout
            .final_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
        &layout.final_dir,
        &layout.final_snapshot_path,
        None,
        None,
        error,
        snapshot_size,
    )?;
    if let Some(fingerprint) = existing_fingerprint {
        metadata.fingerprint = fingerprint;
    }

    write_json_file(&layout.temp_dir.join(METADATA_FILE_NAME), &metadata)?;
    fs::rename(
        &layout.temp_snapshot_path,
        layout.temp_dir.join(SNAPSHOT_FILE_NAME),
    )
    .map_err(|e| format!("finalize recovery snapshot file: {e}"))?;
    fs::rename(&layout.temp_dir, &layout.final_dir)
        .map_err(|e| format!("finalize recovery snapshot directory: {e}"))?;

    Ok(metadata)
}

fn build_snapshot_layout(output_dir: &Path, kind: RecoveryPointKind) -> SnapshotLayout {
    let id = Uuid::new_v4().to_string();
    let dir_name = format!(
        "{}-{}-{}",
        Utc::now().format("%Y%m%d_%H%M%S"),
        kind.as_str(),
        &id
    );
    let temp_dir = output_dir.join(format!(".tmp-{dir_name}"));
    let final_dir = output_dir.join(&dir_name);
    SnapshotLayout {
        temp_snapshot_path: temp_dir.join("snapshot.tmp.db"),
        final_snapshot_path: final_dir.join(SNAPSHOT_FILE_NAME),
        temp_dir,
        final_dir,
    }
}

fn vacuum_into_snapshot(conn: &Connection, snapshot_path: &Path) -> Result<(), String> {
    if let Some(parent) = snapshot_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create snapshot parent dir: {e}"))?;
    }
    if snapshot_path.exists() {
        fs::remove_file(snapshot_path)
            .map_err(|e| format!("remove existing snapshot file: {e}"))?;
    }
    let escaped = snapshot_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
        .map_err(|e| format!("vacuum into snapshot: {e}"))?;
    Ok(())
}

fn build_metadata_from_connection(
    conn: &Connection,
    db_path: &Path,
    kind: RecoveryPointKind,
    id: &str,
    point_dir: &Path,
    snapshot_path: &Path,
    wal_path: Option<&Path>,
    shm_path: Option<&Path>,
    error: Option<String>,
    snapshot_size_bytes: u64,
) -> Result<RecoveryPointMetadata, String> {
    let created_at = Utc::now().to_rfc3339();
    let schema_version = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let table_counts = collect_table_counts(conn)?;
    let sync_backlog = collect_sync_backlog(conn)?;
    let fingerprint = compute_operational_fingerprint(conn)?;

    let terminal_id = read_identity_value(conn, "terminal_id");
    let branch_id = read_identity_value(conn, "branch_id");
    let organization_id = read_identity_value(conn, "organization_id");

    let (active_period_start_at, active_report_date) = if table_exists(conn, "staff_shifts")? {
        conn.query_row(
            "SELECT period_start_at, report_date
             FROM staff_shifts
             WHERE check_out_time IS NULL
             ORDER BY COALESCE(period_start_at, check_in_time) DESC
             LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("read active shift business-day metadata: {e}"))?
        .unwrap_or((None, None))
    } else {
        (None, None)
    };

    let (
        latest_z_report_id,
        latest_z_report_date,
        latest_z_report_generated_at,
        latest_z_report_sync_state,
    ) = if table_exists(conn, "z_reports")? {
        let date_column =
            first_existing_column(conn, "z_reports", &["report_date", "date", "business_date"])?;
        let generated_column =
            first_existing_column(conn, "z_reports", &["generated_at", "created_at"])?;
        let sync_column = first_existing_column(conn, "z_reports", &["sync_state", "status"])?;
        let query = format!(
            "SELECT id, {}, {}, {}
                 FROM z_reports
                 ORDER BY COALESCE({}, {}) DESC
                 LIMIT 1",
            date_column
                .as_deref()
                .map(quote_identifier)
                .unwrap_or_else(|| "NULL".to_string()),
            generated_column
                .as_deref()
                .map(quote_identifier)
                .unwrap_or_else(|| "NULL".to_string()),
            sync_column
                .as_deref()
                .map(quote_identifier)
                .unwrap_or_else(|| "NULL".to_string()),
            generated_column
                .as_deref()
                .map(quote_identifier)
                .unwrap_or_else(|| "id".to_string()),
            date_column
                .as_deref()
                .map(quote_identifier)
                .unwrap_or_else(|| "id".to_string()),
        );
        conn.query_row(&query, [], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .optional()
        .map_err(|e| format!("read latest z report metadata: {e}"))?
        .unwrap_or((None, None, None, None))
    } else {
        (None, None, None, None)
    };

    let db_size_bytes = fs::metadata(db_path)
        .map(|meta| meta.len())
        .unwrap_or(snapshot_size_bytes);

    Ok(RecoveryPointMetadata {
        id: id.to_string(),
        kind,
        created_at,
        path: point_dir.to_string_lossy().to_string(),
        snapshot_path: snapshot_path.to_string_lossy().to_string(),
        wal_path: wal_path.map(|path| path.to_string_lossy().to_string()),
        shm_path: shm_path.map(|path| path.to_string_lossy().to_string()),
        schema_version,
        terminal_id,
        branch_id,
        organization_id,
        db_size_bytes,
        snapshot_size_bytes,
        fingerprint,
        table_counts,
        sync_backlog,
        active_period_start_at,
        active_report_date,
        latest_z_report_id,
        latest_z_report_date,
        latest_z_report_generated_at,
        latest_z_report_sync_state,
        last_z_report_timestamp: db::get_setting(conn, "system", "last_z_report_timestamp"),
        error,
    })
}

fn build_storage_only_metadata(
    db_path: &Path,
    kind: RecoveryPointKind,
    id: &str,
    created_at: &str,
    point_dir: &Path,
    snapshot_path: &Path,
    wal_path: Option<&Path>,
    shm_path: Option<&Path>,
    error: Option<String>,
    snapshot_size_bytes: u64,
) -> RecoveryPointMetadata {
    let db_size_bytes = fs::metadata(db_path)
        .map(|meta| meta.len())
        .unwrap_or(snapshot_size_bytes);
    let terminal_id = storage::get_credential("terminal_id");
    let branch_id = storage::get_credential("branch_id");
    let organization_id = storage::get_credential("organization_id");
    let fingerprint = hash_string(&format!(
        "{}:{}:{}:{}",
        id,
        created_at,
        snapshot_size_bytes,
        kind.as_str()
    ));

    RecoveryPointMetadata {
        id: id.to_string(),
        kind,
        created_at: created_at.to_string(),
        path: point_dir.to_string_lossy().to_string(),
        snapshot_path: snapshot_path.to_string_lossy().to_string(),
        wal_path: wal_path.map(|path| path.to_string_lossy().to_string()),
        shm_path: shm_path.map(|path| path.to_string_lossy().to_string()),
        schema_version: 0,
        terminal_id,
        branch_id,
        organization_id,
        db_size_bytes,
        snapshot_size_bytes,
        fingerprint,
        table_counts: BTreeMap::new(),
        sync_backlog: BTreeMap::new(),
        active_period_start_at: None,
        active_report_date: None,
        latest_z_report_id: None,
        latest_z_report_date: None,
        latest_z_report_generated_at: None,
        latest_z_report_sync_state: None,
        last_z_report_timestamp: None,
        error,
    }
}

fn collect_table_counts(conn: &Connection) -> Result<BTreeMap<String, i64>, String> {
    let mut counts = BTreeMap::new();
    for table in POINT_TABLES {
        if !table_exists(conn, table)? {
            continue;
        }
        let query = format!("SELECT COUNT(*) FROM {}", quote_identifier(table));
        let count = conn
            .query_row(&query, [], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("count {table}: {e}"))?;
        counts.insert((*table).to_string(), count);
    }
    Ok(counts)
}

fn collect_sync_backlog(
    conn: &Connection,
) -> Result<BTreeMap<String, BTreeMap<String, i64>>, String> {
    let mut backlog = BTreeMap::new();

    // Wave 5 Session 7 PR 2: the legacy `sync_queue` branch was removed
    // when migration v56 dropped the table. `parity_sync_queue` is the
    // sole queue surface aggregated here; rows key on `table_name`
    // (parity's analogue of the legacy `entity_type`).
    if table_exists(conn, "parity_sync_queue")? {
        let mut stmt = conn
            .prepare(
                "SELECT table_name, status, COUNT(*)
                 FROM parity_sync_queue
                 GROUP BY table_name, status",
            )
            .map_err(|e| format!("prepare parity_sync_queue backlog: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| format!("query parity_sync_queue backlog: {e}"))?;
        for row in rows {
            let (table_name, status, count) =
                row.map_err(|e| format!("read parity_sync_queue backlog row: {e}"))?;
            backlog
                .entry(table_name)
                .or_insert_with(BTreeMap::new)
                .insert(status, count);
        }
    }

    for table in &[
        "order_payments",
        "payment_adjustments",
        "shift_expenses",
        "driver_earnings",
        "z_reports",
    ] {
        if !table_exists(conn, table)? {
            continue;
        }
        let Some(sync_column) = first_existing_column(conn, table, &["sync_state", "status"])?
        else {
            continue;
        };

        let query = format!(
            "SELECT {}, COUNT(*)
             FROM {}
             WHERE COALESCE({}, '') NOT IN ('', 'applied', 'synced', 'printed')
             GROUP BY {}",
            quote_identifier(&sync_column),
            quote_identifier(table),
            quote_identifier(&sync_column),
            quote_identifier(&sync_column),
        );
        let mut table_backlog = BTreeMap::new();
        let mut stmt = conn
            .prepare(&query)
            .map_err(|e| format!("prepare {table} backlog: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?
                        .unwrap_or_else(|| "unknown".to_string()),
                    row.get::<_, i64>(1)?,
                ))
            })
            .map_err(|e| format!("query {table} backlog: {e}"))?;
        for row in rows {
            let (state, count) = row.map_err(|e| format!("read {table} backlog row: {e}"))?;
            table_backlog.insert(state, count);
        }
        if !table_backlog.is_empty() {
            backlog.insert((*table).to_string(), table_backlog);
        }
    }

    Ok(backlog)
}

fn compute_operational_fingerprint(conn: &Connection) -> Result<String, String> {
    let mut parts = Vec::new();

    for (table, candidate_columns) in FINGERPRINT_TABLES {
        if !table_exists(conn, table)? {
            continue;
        }
        let count_query = format!("SELECT COUNT(*) FROM {}", quote_identifier(table));
        let count = conn
            .query_row(&count_query, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0);
        let max_timestamp =
            if let Some(column) = first_existing_column(conn, table, candidate_columns)? {
                let query = format!(
                    "SELECT MAX({}) FROM {}",
                    quote_identifier(&column),
                    quote_identifier(table)
                );
                conn.query_row(&query, [], |row| row.get::<_, Option<String>>(0))
                    .unwrap_or(None)
                    .unwrap_or_default()
            } else {
                String::new()
            };
        parts.push(format!("{table}:{count}:{max_timestamp}"));
    }

    Ok(hash_string(&parts.join("|")))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type IN ('table', 'view') AND name = ?1
         )",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists == 1)
    .map_err(|e| format!("table exists {table}: {e}"))
}

fn first_existing_column(
    conn: &Connection,
    table: &str,
    columns: &[&str],
) -> Result<Option<String>, String> {
    let existing = read_table_columns(conn, table)?;
    Ok(columns
        .iter()
        .find(|candidate| existing.iter().any(|column| column == **candidate))
        .map(|candidate| (*candidate).to_string()))
}

fn hash_string(input: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn read_identity_value(conn: &Connection, key: &str) -> Option<String> {
    db::get_setting(conn, "terminal", key)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| storage::get_credential(key))
        .map(|value| value.trim().to_string())
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("serialize json {}: {e}", path.display()))?;
    fs::write(path, serialized).map_err(|e| format!("write json {}: {e}", path.display()))
}

fn load_recovery_points(root: &Path) -> Result<Vec<RecoveryPointMetadata>, String> {
    let mut points = Vec::new();
    for dir in [points_dir(root), quarantine_dir(root)] {
        if !dir.exists() {
            continue;
        }
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("read recovery dir {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("read recovery entry: {e}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(".tmp-") {
                continue;
            }
            let metadata_path = path.join(METADATA_FILE_NAME);
            if !metadata_path.exists() {
                continue;
            }
            let raw = fs::read_to_string(&metadata_path)
                .map_err(|e| format!("read recovery metadata {}: {e}", metadata_path.display()))?;
            let metadata: RecoveryPointMetadata = serde_json::from_str(&raw)
                .map_err(|e| format!("parse recovery metadata {}: {e}", metadata_path.display()))?;
            points.push(metadata);
        }
    }

    points.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(points)
}

fn load_recovery_point_by_id(
    root: &Path,
    point_id: &str,
) -> Result<Option<RecoveryPointMetadata>, String> {
    Ok(load_recovery_points(root)?
        .into_iter()
        .find(|point| point.id == point_id))
}

fn prune_recovery_points(root: &Path) -> Result<(), String> {
    let now = Utc::now();
    let dense_cutoff = now - Duration::hours(DENSE_RETENTION_HOURS);
    let total_cutoff = now - Duration::days(TOTAL_RETENTION_DAYS);
    let mut hourly_buckets = HashSet::new();

    for point in load_recovery_points(root)? {
        let created_at = DateTime::parse_from_rfc3339(&point.created_at)
            .map(|timestamp| timestamp.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc.timestamp_opt(0, 0).single().unwrap_or_else(Utc::now));
        let point_path = PathBuf::from(&point.path);
        let keep = if created_at < total_cutoff {
            false
        } else if point.kind.is_destructive() || created_at >= dense_cutoff {
            true
        } else {
            hourly_buckets.insert(created_at.format("%Y%m%d%H").to_string())
        };
        if !keep && point_path.exists() {
            let _ = fs::remove_dir_all(&point_path);
        }
    }

    for dir in [points_dir(root), quarantine_dir(root)] {
        if !dir.exists() {
            continue;
        }
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("read recovery dir {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("read recovery entry: {e}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if !entry.file_name().to_string_lossy().starts_with(".tmp-") {
                continue;
            }
            let modified = fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|ts| ts.elapsed().ok())
                .map(|elapsed| elapsed.as_secs() > 3600)
                .unwrap_or(false);
            if modified {
                let _ = fs::remove_dir_all(path);
            }
        }
    }

    Ok(())
}

fn validate_restore_point(db: &db::DbState, point: &RecoveryPointMetadata) -> Result<(), String> {
    let (current_terminal_id, current_branch_id, current_org_id, current_schema_version) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        (
            read_identity_value(&conn, "terminal_id"),
            read_identity_value(&conn, "branch_id"),
            read_identity_value(&conn, "organization_id"),
            conn.query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0),
        )
    };

    if point.schema_version > current_schema_version {
        return Err(format!(
            "Recovery point schema version {} is newer than the current terminal schema {}",
            point.schema_version, current_schema_version
        ));
    }
    if let (Some(current), Some(candidate)) =
        (current_terminal_id.as_deref(), point.terminal_id.as_deref())
    {
        if !current.trim().is_empty() && !candidate.trim().is_empty() && current != candidate {
            return Err(format!(
                "Recovery point terminal {} does not match current terminal {}",
                candidate, current
            ));
        }
    }
    if let (Some(current), Some(candidate)) =
        (current_branch_id.as_deref(), point.branch_id.as_deref())
    {
        if !current.trim().is_empty() && !candidate.trim().is_empty() && current != candidate {
            return Err(format!(
                "Recovery point branch {} does not match current branch {}",
                candidate, current
            ));
        }
    }
    if let (Some(current), Some(candidate)) =
        (current_org_id.as_deref(), point.organization_id.as_deref())
    {
        if !current.trim().is_empty() && !candidate.trim().is_empty() && current != candidate {
            return Err(format!(
                "Recovery point organization {} does not match current organization {}",
                candidate, current
            ));
        }
    }

    Ok(())
}

fn open_snapshot_connection(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open snapshot database {}: {e}", path.display()))
}

fn write_export_bundle(
    snapshot_conn: &Connection,
    metadata: &RecoveryPointMetadata,
    snapshot_path: &Path,
    final_zip: &Path,
) -> Result<(), String> {
    if let Some(parent) = final_zip.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create export parent dir: {e}"))?;
    }

    let file =
        fs::File::create(final_zip).map_err(|e| format!("create recovery export zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let zip_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("metadata.json", zip_options)
        .map_err(|e| format!("start metadata entry: {e}"))?;
    let metadata_json = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("serialize recovery metadata: {e}"))?;
    zip.write_all(metadata_json.as_bytes())
        .map_err(|e| format!("write metadata entry: {e}"))?;

    let summary = json!({
        "generatedAt": Utc::now().to_rfc3339(),
        "pointId": metadata.id,
        "kind": metadata.kind,
        "terminalId": metadata.terminal_id,
        "branchId": metadata.branch_id,
        "organizationId": metadata.organization_id,
        "schemaVersion": metadata.schema_version,
        "tableCounts": metadata.table_counts,
        "syncBacklog": metadata.sync_backlog,
        "activeReportDate": metadata.active_report_date,
        "activePeriodStartAt": metadata.active_period_start_at,
        "latestZReportId": metadata.latest_z_report_id,
        "latestZReportDate": metadata.latest_z_report_date,
        "latestZReportGeneratedAt": metadata.latest_z_report_generated_at,
        "lastZReportTimestamp": metadata.last_z_report_timestamp,
    });
    zip.start_file("summary.json", zip_options)
        .map_err(|e| format!("start summary entry: {e}"))?;
    let summary_json = serde_json::to_string_pretty(&summary)
        .map_err(|e| format!("serialize recovery summary: {e}"))?;
    zip.write_all(summary_json.as_bytes())
        .map_err(|e| format!("write summary entry: {e}"))?;

    for table in POINT_TABLES {
        if !table_exists(snapshot_conn, table)? {
            continue;
        }
        let csv = render_table_as_csv(snapshot_conn, table)?;
        zip.start_file(format!("{table}.csv"), zip_options)
            .map_err(|e| format!("start csv entry for {table}: {e}"))?;
        zip.write_all(csv.as_bytes())
            .map_err(|e| format!("write csv entry for {table}: {e}"))?;
    }

    zip.start_file(SNAPSHOT_FILE_NAME, zip_options)
        .map_err(|e| format!("start snapshot db entry: {e}"))?;
    let mut snapshot_file =
        fs::File::open(snapshot_path).map_err(|e| format!("open snapshot db for export: {e}"))?;
    let mut buffer = Vec::new();
    snapshot_file
        .read_to_end(&mut buffer)
        .map_err(|e| format!("read snapshot db for export: {e}"))?;
    zip.write_all(&buffer)
        .map_err(|e| format!("write snapshot db entry: {e}"))?;

    zip.finish()
        .map_err(|e| format!("finalize recovery export zip: {e}"))?;
    Ok(())
}

fn render_table_as_csv(conn: &Connection, table: &str) -> Result<String, String> {
    let columns = read_table_columns(conn, table)?;
    if columns.is_empty() {
        return Ok(String::new());
    }

    let select_columns = columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    let query = format!(
        "SELECT {select_columns} FROM {} ORDER BY ROWID",
        quote_identifier(table)
    );
    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("prepare csv export for {table}: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("query csv export for {table}: {e}"))?;

    let mut out = String::new();
    out.push_str(
        &columns
            .iter()
            .map(|column| csv_escape(column))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');

    while let Some(row) = rows
        .next()
        .map_err(|e| format!("iterate csv export for {table}: {e}"))?
    {
        let mut cells = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            let value = sqlite_value_to_string(
                row.get_ref(index)
                    .map_err(|e| format!("read csv cell for {table}: {e}"))?,
            );
            cells.push(csv_escape(&value));
        }
        out.push_str(&cells.join(","));
        out.push('\n');
    }

    Ok(out)
}

fn read_table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))
        .map_err(|e| format!("prepare table_info for {table}: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("query table_info for {table}: {e}"))?;
    let mut columns = Vec::new();
    for row in rows {
        columns.push(row.map_err(|e| format!("read table_info row for {table}: {e}"))?);
    }
    Ok(columns)
}

fn sqlite_value_to_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(value) => value.to_string(),
        ValueRef::Real(value) => {
            if value.fract() == 0.0 {
                format!("{value:.1}")
            } else {
                value.to_string()
            }
        }
        ValueRef::Text(value) => String::from_utf8_lossy(value).to_string(),
        ValueRef::Blob(value) => value
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn csv_escape(value: &str) -> String {
    let needs_quotes =
        value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r');
    if !needs_quotes {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn temp_app_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{}_{}", prefix, Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn count_orders(app_data_dir: &Path) -> i64 {
        let conn = Connection::open(app_data_dir.join("pos.db")).expect("open db");
        conn.query_row("SELECT COUNT(*) FROM orders", [], |row| row.get(0))
            .expect("count orders")
    }

    fn count_print_jobs_by_status(app_data_dir: &Path, status: &str) -> i64 {
        let conn = Connection::open(app_data_dir.join("pos.db")).expect("open db");
        conn.query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE status = ?1",
            params![status],
            |row| row.get(0),
        )
        .expect("count print jobs by status")
    }

    fn stored_attempt_target(
        target: &crate::print_dispatch::PrinterTargetKey,
    ) -> (&'static str, String) {
        match target {
            crate::print_dispatch::PrinterTargetKey::WindowsQueue(queue) => {
                ("windows", queue.clone())
            }
            crate::print_dispatch::PrinterTargetKey::RawTcp { host, port } => {
                ("raw_tcp", format!("host:{}:{host}:{port}", host.len()))
            }
            crate::print_dispatch::PrinterTargetKey::Serial {
                port_name,
                baud_rate,
            } => (
                "serial",
                format!("port:{}:{port_name}:{baud_rate}", port_name.len()),
            ),
        }
    }

    fn insert_restored_job_attempt(
        conn: &Connection,
        job_id: Uuid,
        job_status: &str,
        attempt_id: Uuid,
        target: &crate::print_dispatch::PrinterTargetKey,
        attempt_state: &str,
        spool_job_id: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO print_jobs (
                id, entity_type, entity_id, status, created_at, updated_at
             ) VALUES (?1, 'order_receipt', ?1, ?2, ?3, ?3)",
            params![job_id.to_string(), job_status, "2026-07-01T00:00:00Z"],
        )
        .expect("insert restored parent print job");
        let (transport, resolved_target) = stored_attempt_target(target);
        let document_name =
            crate::windows_spooler::format_document_marker(job_id, attempt_id, "order_receipt")
                .expect("format restored attempt document marker");
        conn.execute(
            "INSERT INTO print_job_attempts (
                id, print_job_id, attempt_number, transport, resolved_target,
                document_name, spool_job_id, state, bytes_requested, bytes_written,
                started_at, last_seen_at
             ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 10, 0, ?8, ?8)",
            params![
                attempt_id.to_string(),
                job_id.to_string(),
                transport,
                resolved_target,
                document_name,
                spool_job_id,
                attempt_state,
                "2026-07-01T00:00:00Z",
            ],
        )
        .expect("insert restored print attempt");
    }

    fn insert_stale_target_circuit(
        conn: &Connection,
        target: &crate::print_dispatch::PrinterTargetKey,
    ) -> String {
        let target_key = crate::print_dispatch::normalize_target(target)
            .expect("normalize restored attempt target");
        let (transport, _) = stored_attempt_target(target);
        conn.execute(
            "INSERT INTO print_target_state (
                target_key, transport, circuit_state, blocked_reason, blocked_at, updated_at
             ) VALUES (?1, ?2, 'open', 'stale restored outcome', ?3, ?3)",
            params![target_key, transport, "2026-07-01T00:00:00Z"],
        )
        .expect("insert stale restored target circuit");
        target_key
    }

    #[test]
    fn manual_snapshot_is_listed_with_table_counts() {
        let app_data_dir = temp_app_dir("recovery_snapshot");
        let db_state = db::init(&app_data_dir).expect("init db");
        {
            let conn = db_state.conn.lock().expect("lock db");
            db::set_setting(&conn, "terminal", "terminal_id", "terminal-1").expect("set terminal");
            // W4e Step 0: dual-populate (12.0 → 1200).
            conn.execute(
                "INSERT INTO orders (
                    id, items, total_amount, total_amount_cents, status, order_type, sync_status, created_at, updated_at
                 ) VALUES (?1, '[]', 12.0, 1200, 'completed', 'pickup', 'pending', datetime('now'), datetime('now'))",
                params!["order-1"],
            )
            .expect("insert order");
        }

        let point = create_manual_snapshot(&db_state).expect("create snapshot");
        assert_eq!(point.table_counts.get("orders"), Some(&1));
        assert_eq!(point.terminal_id.as_deref(), Some("terminal-1"));

        let listed = list_recovery_points(&db_state).expect("list recovery points");
        assert_eq!(listed.len(), 1);

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn scheduled_snapshot_skips_unchanged_state() {
        let app_data_dir = temp_app_dir("recovery_scheduled");
        let db_state = db::init(&app_data_dir).expect("init db");

        assert!(maybe_create_scheduled_snapshot(&db_state)
            .expect("create first scheduled snapshot")
            .is_some());
        assert!(maybe_create_scheduled_snapshot(&db_state)
            .expect("skip unchanged snapshot")
            .is_none());

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn staged_v73_restore_cancels_replayable_jobs_with_history_timestamps() {
        let app_data_dir = temp_app_dir("recovery_restore");
        {
            let db_state = db::init(&app_data_dir).expect("init db");
            {
                let conn = db_state.conn.lock().expect("lock db");
                db::set_setting(&conn, "terminal", "terminal_id", "terminal-restore")
                    .expect("set terminal");
                // W4e Step 0: dual-populate (8.5 → 850).
                conn.execute(
                    "INSERT INTO orders (
                        id, items, total_amount, total_amount_cents, status, order_type, sync_status, created_at, updated_at
                     ) VALUES (?1, '[]', 8.5, 850, 'completed', 'pickup', 'pending', datetime('now'), datetime('now'))",
                    params!["order-before"],
                )
                .expect("insert original order");
                conn.execute(
                    "INSERT INTO print_jobs (
                        id, entity_type, entity_id, status, created_at, updated_at
                     ) VALUES (?1, 'order_receipt', 'order-before', 'pending', datetime('now'), datetime('now'))",
                    params!["job-before-pending"],
                )
                .expect("insert pending print job");
                conn.execute(
                    "INSERT INTO print_jobs (
                        id, entity_type, entity_id, status, created_at, updated_at
                     ) VALUES (?1, 'order_receipt', 'order-before', 'printing', datetime('now'), datetime('now'))",
                    params!["job-before-printing"],
                )
                .expect("insert printing print job");
            }
            let point = create_manual_snapshot(&db_state).expect("create snapshot");
            {
                let conn = db_state.conn.lock().expect("lock db");
                // W4e Step 0: dual-populate (9.5 → 950).
                conn.execute(
                    "INSERT INTO orders (
                        id, items, total_amount, total_amount_cents, status, order_type, sync_status, created_at, updated_at
                     ) VALUES (?1, '[]', 9.5, 950, 'completed', 'pickup', 'pending', datetime('now'), datetime('now'))",
                    params!["order-after"],
                )
                .expect("insert later order");
            }
            assert_eq!(count_orders(&app_data_dir), 2);
            stage_restore_from_point(&db_state, &point.id).expect("stage restore");
        }

        let restore_started_at = Utc::now();
        maybe_apply_pending_restore(&app_data_dir)
            .expect("apply pending restore")
            .expect("restore payload");
        let restore_finished_at = Utc::now();
        assert_eq!(count_orders(&app_data_dir), 1);
        assert_eq!(count_print_jobs_by_status(&app_data_dir, "cancelled"), 2);
        assert_eq!(count_print_jobs_by_status(&app_data_dir, "pending"), 0);
        assert_eq!(count_print_jobs_by_status(&app_data_dir, "printing"), 0);

        let history_expires_at = {
            let conn = Connection::open(app_data_dir.join("pos.db")).expect("open restored db");
            let mut statement = conn
                .prepare(
                    "SELECT id, updated_at, completed_at, history_expires_at
                     FROM print_jobs
                     ORDER BY id",
                )
                .expect("prepare restored print history query");
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .expect("query restored print history")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect restored print history");

            assert_eq!(rows.len(), 2);
            let mut common_expiry = None;
            for (id, updated_at, completed_at, history_expires_at) in rows {
                let completed_at = completed_at
                    .unwrap_or_else(|| panic!("restored job {id} missing completed_at"));
                let history_expires_at = history_expires_at
                    .unwrap_or_else(|| panic!("restored job {id} missing history_expires_at"));
                assert_eq!(completed_at, updated_at, "restored job {id}");

                let completed_at_utc = DateTime::parse_from_rfc3339(&completed_at)
                    .expect("parse restored completion timestamp")
                    .with_timezone(&Utc);
                assert!(completed_at_utc >= restore_started_at, "restored job {id}");
                assert!(completed_at_utc <= restore_finished_at, "restored job {id}");

                let expected_expiry = (completed_at_utc + Duration::days(30))
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string();
                assert_eq!(history_expires_at, expected_expiry, "restored job {id}");
                if let Some(expected_common_expiry) = &common_expiry {
                    assert_eq!(&history_expires_at, expected_common_expiry);
                } else {
                    common_expiry = Some(history_expires_at);
                }
            }
            common_expiry.expect("restored print history expiry")
        };

        let history_expires_at =
            chrono::NaiveDateTime::parse_from_str(&history_expires_at, "%Y-%m-%d %H:%M:%S")
                .expect("parse restored history expiry")
                .and_utc();
        let restored_db = db::init(&app_data_dir).expect("reopen restored db");
        let before_expiry = crate::print_history::purge_expired_print_jobs_at(
            &restored_db,
            &app_data_dir,
            history_expires_at - Duration::seconds(1),
        )
        .expect("purge restored history before expiry");
        assert_eq!(before_expiry.rows_deleted, 0);
        let at_expiry = crate::print_history::purge_expired_print_jobs_at(
            &restored_db,
            &app_data_dir,
            history_expires_at,
        )
        .expect("purge restored history at expiry");
        assert_eq!(at_expiry.rows_deleted, 2);
        drop(restored_db);

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn staged_v73_restore_releases_orphan_lanes_but_preserves_owned_windows_attempt() {
        use crate::print_dispatch::{
            DispatchError, DispatchManager, DispatchState, PrinterTargetKey,
        };

        let app_data_dir = temp_app_dir("recovery_restore_attempts");
        let nonce = Uuid::new_v4().to_string();
        let raw_target = PrinterTargetKey::RawTcp {
            host: format!("restore-raw-{nonce}.local"),
            port: 9100,
        };
        let serial_target = PrinterTargetKey::Serial {
            port_name: format!("COM-{nonce}"),
            baud_rate: 115_200,
        };
        let invalid_windows_target =
            PrinterTargetKey::WindowsQueue(format!("Restore Invalid {nonce}"));
        let owned_windows_target = PrinterTargetKey::WindowsQueue(format!("Restore Owned {nonce}"));
        let raw_job = Uuid::new_v4();
        let serial_job = Uuid::new_v4();
        let invalid_windows_job = Uuid::new_v4();
        let owned_windows_job = Uuid::new_v4();
        let raw_attempt = Uuid::new_v4();
        let serial_attempt = Uuid::new_v4();
        let invalid_windows_attempt = Uuid::new_v4();
        let owned_windows_attempt = Uuid::new_v4();
        let stale_target_keys;

        {
            let db_state = db::init(&app_data_dir).expect("init v73 restore db");
            {
                let conn = db_state.conn.lock().expect("lock v73 restore db");
                insert_restored_job_attempt(
                    &conn,
                    raw_job,
                    "pending",
                    raw_attempt,
                    &raw_target,
                    "submitting",
                    None,
                );
                insert_restored_job_attempt(
                    &conn,
                    serial_job,
                    "printing",
                    serial_attempt,
                    &serial_target,
                    "unknown",
                    None,
                );
                insert_restored_job_attempt(
                    &conn,
                    invalid_windows_job,
                    "pending",
                    invalid_windows_attempt,
                    &invalid_windows_target,
                    "windows_queued",
                    Some(0),
                );
                insert_restored_job_attempt(
                    &conn,
                    owned_windows_job,
                    "printing",
                    owned_windows_attempt,
                    &owned_windows_target,
                    "windows_queued",
                    Some(4_242),
                );
                stale_target_keys = [
                    insert_stale_target_circuit(&conn, &raw_target),
                    insert_stale_target_circuit(&conn, &serial_target),
                    insert_stale_target_circuit(&conn, &invalid_windows_target),
                ];
            }
            let point = create_manual_snapshot(&db_state).expect("create v73 attempt snapshot");
            stage_restore_from_point(&db_state, &point.id).expect("stage v73 attempt restore");
        }

        let restore_started_at = Utc::now();
        maybe_apply_pending_restore(&app_data_dir)
            .expect("apply v73 attempt restore")
            .expect("v73 attempt restore payload");
        let restore_finished_at = Utc::now();

        let conn = Connection::open(app_data_dir.join("pos.db")).expect("open restored v73 db");
        let mut restore_stamp = None;
        for job_id in [raw_job, serial_job, invalid_windows_job, owned_windows_job] {
            let row: (String, String, Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT status, updated_at, completed_at, history_expires_at
                     FROM print_jobs WHERE id = ?1",
                    [job_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("read restored parent metadata");
            assert_eq!(row.0, "cancelled", "restored parent {job_id}");
            assert_eq!(row.2.as_deref(), Some(row.1.as_str()));
            let restored_at = DateTime::parse_from_rfc3339(&row.1)
                .expect("parse restored parent timestamp")
                .with_timezone(&Utc);
            assert!(restored_at >= restore_started_at);
            assert!(restored_at <= restore_finished_at);
            assert_eq!(
                row.3,
                Some(
                    (restored_at + Duration::days(30))
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string()
                )
            );
            if let Some(expected) = &restore_stamp {
                assert_eq!(&row.1, expected);
            } else {
                restore_stamp = Some(row.1);
            }
        }
        let restore_stamp = restore_stamp.expect("common restore timestamp");

        for attempt_id in [raw_attempt, serial_attempt, invalid_windows_attempt] {
            let row: (
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ) = conn
                .query_row(
                    "SELECT state, last_seen_at, completed_at, cancel_confirmed_at, last_error
                     FROM print_job_attempts WHERE id = ?1",
                    [attempt_id.to_string()],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .expect("read terminalized restored attempt");
            assert_eq!(row.0, "cancelled", "restored attempt {attempt_id}");
            assert_eq!(row.1.as_deref(), Some(restore_stamp.as_str()));
            assert_eq!(row.2.as_deref(), Some(restore_stamp.as_str()));
            assert_eq!(row.3.as_deref(), Some(restore_stamp.as_str()));
            assert_eq!(
                row.4.as_deref(),
                Some("Recovery cancelled an orphaned attempt; previous print outcome is unknown")
            );
        }

        let owned: (String, i64, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT state, spool_job_id, completed_at, cancel_confirmed_at, last_error
                 FROM print_job_attempts WHERE id = ?1",
                [owned_windows_attempt.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("read preserved owned Windows attempt");
        assert_eq!(owned, ("windows_queued".into(), 4_242, None, None, None));

        for target_key in stale_target_keys {
            let row: (String, Option<String>, Option<String>, String) = conn
                .query_row(
                    "SELECT circuit_state, blocked_reason, blocked_at, updated_at
                     FROM print_target_state WHERE target_key = ?1",
                    [target_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("read reset restored target circuit");
            assert_eq!(row, ("closed".into(), None, None, restore_stamp.clone()));
        }

        let manager = DispatchManager::hydrate(&conn).expect("hydrate restored dispatch manager");
        for target in [raw_target, serial_target, invalid_windows_target] {
            let mut lease = manager
                .claim(target)
                .expect("terminalized restored lane must be claimable");
            lease.release_unstarted();
        }
        assert!(matches!(
            manager.claim(owned_windows_target.clone()),
            Err(DispatchError::LaneBusy)
        ));
        let active =
            crate::print_dispatch::active_attempts_for_target(&conn, &owned_windows_target)
                .expect("owned Windows attempt remains reconcilable");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].identity.attempt_id, owned_windows_attempt);
        assert_eq!(active[0].state, DispatchState::WindowsQueued);
        assert_eq!(active[0].spool_job_id, Some(4_242));
        drop(conn);

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn restore_preserves_every_valid_windows_attempt_despite_newer_active_and_terminal_attempts() {
        use crate::print_dispatch::{DispatchError, DispatchManager, PrinterTargetKey};

        let app_data_dir = temp_app_dir("recovery_restore_windows_contract");
        let db_state = db::init(&app_data_dir).expect("init Windows contract restore db");
        let nonce = Uuid::new_v4().to_string();
        let valid_target = PrinterTargetKey::WindowsQueue(format!("Valid Restore {nonce}"));
        let created_target = PrinterTargetKey::WindowsQueue(format!("Created Restore {nonce}"));
        let submitting_target =
            PrinterTargetKey::WindowsQueue(format!("Submitting Restore {nonce}"));
        let fractional_target =
            PrinterTargetKey::WindowsQueue(format!("Fractional Restore {nonce}"));
        let blob_target = PrinterTargetKey::WindowsQueue(format!("Blob Restore {nonce}"));
        let shared_target = PrinterTargetKey::WindowsQueue(format!("Shared Restore {nonce}"));
        let terminal_target = PrinterTargetKey::WindowsQueue(format!("Terminal Restore {nonce}"));
        let bad_marker_target =
            PrinterTargetKey::WindowsQueue(format!("Bad Marker Restore {nonce}"));
        let too_large_target = PrinterTargetKey::WindowsQueue(format!("Too Large Restore {nonce}"));

        let valid_job = Uuid::new_v4();
        let created_job = Uuid::new_v4();
        let submitting_job = Uuid::new_v4();
        let fractional_job = Uuid::new_v4();
        let blob_job = Uuid::new_v4();
        let multi_attempt_job = Uuid::new_v4();
        let bad_marker_job = Uuid::new_v4();
        let too_large_job = Uuid::new_v4();
        let valid_attempt = Uuid::new_v4();
        let created_attempt = Uuid::new_v4();
        let submitting_attempt = Uuid::new_v4();
        let fractional_attempt = Uuid::new_v4();
        let blob_attempt = Uuid::new_v4();
        let non_latest_attempt = Uuid::new_v4();
        let same_target_active_attempt = Uuid::new_v4();
        let newer_terminal_attempt = Uuid::new_v4();
        let bad_marker_attempt = Uuid::new_v4();
        let too_large_attempt = Uuid::new_v4();

        {
            let conn = db_state
                .conn
                .lock()
                .expect("lock Windows contract restore db");
            for (job, attempt, target, state, spool_job_id) in [
                (
                    valid_job,
                    valid_attempt,
                    &valid_target,
                    "windows_queued",
                    1_i64,
                ),
                (created_job, created_attempt, &created_target, "created", 2),
                (
                    submitting_job,
                    submitting_attempt,
                    &submitting_target,
                    "submitting",
                    3,
                ),
                (
                    fractional_job,
                    fractional_attempt,
                    &fractional_target,
                    "windows_queued",
                    4,
                ),
                (blob_job, blob_attempt, &blob_target, "windows_queued", 5),
                (
                    multi_attempt_job,
                    non_latest_attempt,
                    &shared_target,
                    "windows_queued",
                    6,
                ),
                (
                    bad_marker_job,
                    bad_marker_attempt,
                    &bad_marker_target,
                    "windows_queued",
                    8,
                ),
                (
                    too_large_job,
                    too_large_attempt,
                    &too_large_target,
                    "windows_queued",
                    i64::from(u32::MAX) + 1,
                ),
            ] {
                insert_restored_job_attempt(
                    &conn,
                    job,
                    "pending",
                    attempt,
                    target,
                    state,
                    Some(spool_job_id),
                );
            }

            conn.execute(
                "UPDATE print_job_attempts
                 SET spool_job_id = CAST(4.5 AS REAL)
                 WHERE id = ?1",
                [fractional_attempt.to_string()],
            )
            .expect("store fractional REAL JobId");
            conn.execute(
                "UPDATE print_job_attempts
                 SET spool_job_id = X'00000005'
                 WHERE id = ?1",
                [blob_attempt.to_string()],
            )
            .expect("store BLOB JobId");
            conn.execute(
                "UPDATE print_job_attempts
                 SET document_name = 'not-a-pos-owned-document'
                 WHERE id = ?1",
                [bad_marker_attempt.to_string()],
            )
            .expect("corrupt restored ownership marker");

            let (_, shared_resolved_target) = stored_attempt_target(&shared_target);
            let same_target_document_name = crate::windows_spooler::format_document_marker(
                multi_attempt_job,
                same_target_active_attempt,
                "order_receipt",
            )
            .expect("format same-target restored attempt marker");
            conn.execute(
                "INSERT INTO print_job_attempts (
                    id, print_job_id, attempt_number, transport, resolved_target,
                    document_name, spool_job_id, state, bytes_requested, bytes_written,
                    started_at, last_seen_at
                 ) VALUES (?1, ?2, 2, 'windows', ?3, ?4, ?5, 'windows_queued',
                           10, 0, ?6, ?6)",
                params![
                    same_target_active_attempt.to_string(),
                    multi_attempt_job.to_string(),
                    shared_resolved_target,
                    same_target_document_name,
                    i64::from(u32::MAX),
                    "2026-07-01T00:00:01Z",
                ],
            )
            .expect("insert same-target restored Windows attempt");

            let (_, terminal_resolved_target) = stored_attempt_target(&terminal_target);
            let terminal_document_name = crate::windows_spooler::format_document_marker(
                multi_attempt_job,
                newer_terminal_attempt,
                "order_receipt",
            )
            .expect("format newer terminal restored attempt marker");
            conn.execute(
                "INSERT INTO print_job_attempts (
                    id, print_job_id, attempt_number, transport, resolved_target,
                    document_name, spool_job_id, state, bytes_requested, bytes_written,
                    started_at, last_seen_at, completed_at
                 ) VALUES (?1, ?2, 3, 'windows', ?3, ?4, ?5, 'spool_completed',
                           10, 10, ?6, ?6, ?6)",
                params![
                    newer_terminal_attempt.to_string(),
                    multi_attempt_job.to_string(),
                    terminal_resolved_target,
                    terminal_document_name,
                    9_i64,
                    "2026-07-01T00:00:02Z",
                ],
            )
            .expect("insert newer terminal restored Windows attempt");

            let stored_types: (String, String) = conn
                .query_row(
                    "SELECT
                       (SELECT typeof(spool_job_id) FROM print_job_attempts WHERE id = ?1),
                       (SELECT typeof(spool_job_id) FROM print_job_attempts WHERE id = ?2)",
                    params![fractional_attempt.to_string(), blob_attempt.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read corrupt restored JobId storage classes");
            assert_eq!(stored_types, ("real".into(), "blob".into()));
        }

        cancel_replayable_restored_print_jobs(&db_state.db_path)
            .expect("cancel attempts outside Windows reconciliation contract");

        let conn = db_state
            .conn
            .lock()
            .expect("relock Windows contract restore db");
        for attempt_id in [
            valid_attempt,
            non_latest_attempt,
            same_target_active_attempt,
        ] {
            assert_eq!(
                conn.query_row(
                    "SELECT state FROM print_job_attempts WHERE id = ?1",
                    [attempt_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .expect("read preserved reconcilable attempt"),
                "windows_queued",
                "attempt {attempt_id} must remain reconcilable"
            );
        }
        for attempt_id in [
            created_attempt,
            submitting_attempt,
            fractional_attempt,
            blob_attempt,
            bad_marker_attempt,
            too_large_attempt,
        ] {
            let row: (String, Option<String>, Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT state, completed_at, cancel_confirmed_at, last_error
                     FROM print_job_attempts WHERE id = ?1",
                    [attempt_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("read terminalized non-reconcilable attempt");
            assert_eq!(row.0, "cancelled", "attempt {attempt_id}");
            assert!(row.1.is_some(), "attempt {attempt_id}");
            assert_eq!(row.2, row.1, "attempt {attempt_id}");
            assert_eq!(
                row.3.as_deref(),
                Some("Recovery cancelled an orphaned attempt; previous print outcome is unknown"),
                "attempt {attempt_id}"
            );
        }
        for job_id in [valid_job, multi_attempt_job] {
            assert_eq!(
                conn.query_row(
                    "SELECT status FROM print_jobs WHERE id = ?1",
                    [job_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .expect("read restored parent cancellation"),
                "cancelled",
                "recovery must cancel parent replay without discarding reconcilable Windows attempts"
            );
        }

        let manager = DispatchManager::hydrate(&conn)
            .expect("hydrate only contract-valid restored Windows attempts");
        for target in [valid_target, shared_target] {
            assert!(matches!(
                manager.claim(target),
                Err(DispatchError::LaneBusy)
            ));
        }
        for target in [
            created_target,
            submitting_target,
            fractional_target,
            blob_target,
            bad_marker_target,
            too_large_target,
            terminal_target,
        ] {
            let mut lease = manager
                .claim(target)
                .expect("non-reconcilable restored Windows lane must be released");
            lease.release_unstarted();
        }
        drop(conn);
        drop(db_state);

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn restore_cancellation_rolls_back_parent_attempt_and_circuit_together() {
        use crate::print_dispatch::PrinterTargetKey;

        let app_data_dir = temp_app_dir("recovery_restore_atomic");
        let db_state = db::init(&app_data_dir).expect("init atomic restore db");
        let job_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let target = PrinterTargetKey::RawTcp {
            host: format!("atomic-{}.local", Uuid::new_v4()),
            port: 9100,
        };
        let target_key;
        {
            let conn = db_state.conn.lock().expect("lock atomic restore db");
            insert_restored_job_attempt(
                &conn,
                job_id,
                "pending",
                attempt_id,
                &target,
                "submitting",
                None,
            );
            target_key = insert_stale_target_circuit(&conn, &target);
            conn.execute_batch(
                "CREATE TRIGGER inject_restore_final_parent_failure
                 AFTER UPDATE OF status ON print_jobs
                 WHEN NEW.status = 'cancelled'
                 BEGIN
                     SELECT CASE WHEN (
                         SELECT state FROM print_job_attempts
                         WHERE print_job_id = NEW.id
                     ) <> 'cancelled'
                     THEN RAISE(ABORT, 'attempt was not terminal before parent mutation') END;
                     SELECT CASE WHEN (
                         SELECT circuit_state FROM print_target_state LIMIT 1
                     ) <> 'closed'
                     THEN RAISE(ABORT, 'circuit was not reset before parent mutation') END;
                     SELECT RAISE(ABORT, 'injected after final parent mutation');
                 END;",
            )
            .expect("install final parent mutation failure trigger");
        }

        let error = cancel_replayable_restored_print_jobs(&db_state.db_path)
            .expect_err("final parent failure must roll back restore cancellation");
        assert!(error.contains("injected after final parent mutation"));

        let conn = db_state.conn.lock().expect("relock atomic restore db");
        let parent: (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, completed_at, history_expires_at
                 FROM print_jobs WHERE id = ?1",
                [job_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read rolled-back parent");
        assert_eq!(parent, ("pending".into(), None, None));
        let attempt: (String, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT state, completed_at, cancel_confirmed_at, last_error
                 FROM print_job_attempts WHERE id = ?1",
                [attempt_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read rolled-back attempt");
        assert_eq!(attempt, ("submitting".into(), None, None, None));
        assert_eq!(
            conn.query_row(
                "SELECT circuit_state FROM print_target_state WHERE target_key = ?1",
                [target_key],
                |row| row.get::<_, String>(0),
            )
            .expect("read rolled-back circuit"),
            "open"
        );
        drop(conn);
        drop(db_state);

        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn restored_print_job_cancellation_supports_pre_v73_schema_without_history_columns() {
        let app_data_dir = temp_app_dir("recovery_restore_pre_v73");
        let db_path = app_data_dir.join("pre-v73.db");
        {
            let conn = Connection::open(&db_path).expect("open pre-v73 db");
            conn.execute_batch(
                "CREATE TABLE print_jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'printing', 'printed', 'failed', 'cancelled')
                    ),
                    warning_code TEXT,
                    warning_message TEXT,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO print_jobs (id, status, updated_at)
                VALUES ('legacy-pending', 'pending', '2026-07-01T00:00:00Z');
                INSERT INTO print_jobs (id, status, updated_at)
                VALUES ('legacy-printing', 'printing', '2026-07-01T00:00:00Z');",
            )
            .expect("create pre-v73 print job schema");
            let columns = read_table_columns(&conn, "print_jobs").expect("read pre-v73 columns");
            assert!(!columns.iter().any(|column| column == "completed_at"));
            assert!(!columns.iter().any(|column| column == "history_expires_at"));
        }

        assert_eq!(
            cancel_replayable_restored_print_jobs(&db_path)
                .expect("cancel replayable pre-v73 print jobs"),
            2
        );
        let conn = Connection::open(&db_path).expect("reopen pre-v73 db");
        let cancelled = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE status = 'cancelled'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count cancelled pre-v73 print jobs");
        assert_eq!(cancelled, 2);
        drop(conn);

        let _ = fs::remove_dir_all(app_data_dir);
    }

    // ----------------------------------------------------------------------
    // Wave 5 C18 — collect_sync_backlog covers parity_sync_queue too
    // ----------------------------------------------------------------------

    #[test]
    fn collect_sync_backlog_includes_parity_sync_queue_rows() {
        let app_data_dir = temp_app_dir("recovery_parity_backlog");
        let db_state = db::init(&app_data_dir).expect("init db");
        let conn = db_state.conn.lock().expect("lock db");

        // Seed BOTH queues so the test proves the aggregation covers
        // parity_sync_queue rows even when sync_queue is empty.
        conn.execute(
            "INSERT INTO parity_sync_queue
                (id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status)
             VALUES (?1, 'order_payments', 'pay-1', 'INSERT', '{}', 'org-1',
                     datetime('now'), 0, 1000, 0, 'payments',
                     'manual', 1, 'pending')",
            params!["queue-w5-c18-1"],
        )
        .expect("seed pending parity row");
        conn.execute(
            "INSERT INTO parity_sync_queue
                (id, table_name, record_id, operation, data, organization_id,
                 created_at, attempts, retry_delay_ms, priority, module_type,
                 conflict_strategy, version, status)
             VALUES (?1, 'order_payments', 'pay-2', 'INSERT', '{}', 'org-1',
                     datetime('now'), 0, 1000, 0, 'payments',
                     'manual', 1, 'failed')",
            params!["queue-w5-c18-2"],
        )
        .expect("seed failed parity row");

        let backlog = collect_sync_backlog(&conn).expect("collect backlog");
        let payments = backlog
            .get("order_payments")
            .expect("order_payments present in backlog after parity queue aggregation");
        assert_eq!(payments.get("pending").copied(), Some(1));
        assert_eq!(payments.get("failed").copied(), Some(1));

        drop(conn);
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn point_tables_include_parity_sync_queue_and_conflict_audit_log() {
        assert!(
            POINT_TABLES.contains(&"parity_sync_queue"),
            "W5 C18: POINT_TABLES must include parity_sync_queue so recovery \
             snapshots reflect the active queue"
        );
        assert!(
            POINT_TABLES.contains(&"conflict_audit_log"),
            "W5 C18: POINT_TABLES must include conflict_audit_log so recovery \
             snapshots reflect conflict history"
        );
        let fingerprint_tables: std::collections::HashSet<&str> =
            FINGERPRINT_TABLES.iter().map(|(t, _)| *t).collect();
        assert!(
            fingerprint_tables.contains("parity_sync_queue"),
            "W5 C18: FINGERPRINT_TABLES must include parity_sync_queue"
        );
    }
}
