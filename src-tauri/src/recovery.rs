use chrono::{DateTime, Duration, TimeZone, Utc};
use rusqlite::{types::ValueRef, Connection, OpenFlags, OptionalExtension};
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
const POINT_TABLES: &[&str] = &[
    "orders",
    "staff_shifts",
    "cash_drawer_sessions",
    "order_payments",
    "payment_adjustments",
    "shift_expenses",
    "driver_earnings",
    "z_reports",
    "sync_queue",
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
    ("sync_queue", &["updated_at", "created_at"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPointKind {
    Scheduled,
    Manual,
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
            Self::PreFactoryReset
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

fn cancel_replayable_restored_print_jobs(db_path: &Path) -> Result<usize, String> {
    let conn = Connection::open(db_path)
        .map_err(|e| format!("open restored database to cancel print replay: {e}"))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE print_jobs
         SET status = 'cancelled',
             warning_code = 'restored_cancelled',
             warning_message = 'Print job cancelled during recovery restore',
             updated_at = ?1
         WHERE status IN ('pending', 'printing')",
        rusqlite::params![now],
    )
    .map_err(|e| format!("cancel replayable restored print jobs: {e}"))
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

    if table_exists(conn, "sync_queue")? {
        let mut stmt = conn
            .prepare(
                "SELECT entity_type, status, COUNT(*)
                 FROM sync_queue
                 GROUP BY entity_type, status",
            )
            .map_err(|e| format!("prepare sync queue backlog: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| format!("query sync queue backlog: {e}"))?;
        for row in rows {
            let (entity_type, status, count) =
                row.map_err(|e| format!("read sync queue backlog row: {e}"))?;
            backlog
                .entry(entity_type)
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

    #[test]
    fn manual_snapshot_is_listed_with_table_counts() {
        let app_data_dir = temp_app_dir("recovery_snapshot");
        let db_state = db::init(&app_data_dir).expect("init db");
        {
            let conn = db_state.conn.lock().expect("lock db");
            db::set_setting(&conn, "terminal", "terminal_id", "terminal-1").expect("set terminal");
            conn.execute(
                "INSERT INTO orders (
                    id, items, total_amount, status, order_type, sync_status, created_at, updated_at
                 ) VALUES (?1, '[]', 12.0, 'completed', 'pickup', 'pending', datetime('now'), datetime('now'))",
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
    fn staged_restore_replaces_db_on_next_start() {
        let app_data_dir = temp_app_dir("recovery_restore");
        {
            let db_state = db::init(&app_data_dir).expect("init db");
            {
                let conn = db_state.conn.lock().expect("lock db");
                db::set_setting(&conn, "terminal", "terminal_id", "terminal-restore")
                    .expect("set terminal");
                conn.execute(
                    "INSERT INTO orders (
                        id, items, total_amount, status, order_type, sync_status, created_at, updated_at
                     ) VALUES (?1, '[]', 8.5, 'completed', 'pickup', 'pending', datetime('now'), datetime('now'))",
                    params!["order-before"],
                )
                .expect("insert original order");
                conn.execute(
                    "INSERT INTO print_jobs (
                        id, entity_type, entity_id, status, created_at, updated_at
                     ) VALUES (?1, 'order_receipt', 'order-before', 'pending', datetime('now'), datetime('now'))",
                    params!["job-before"],
                )
                .expect("insert pending print job");
            }
            let point = create_manual_snapshot(&db_state).expect("create snapshot");
            {
                let conn = db_state.conn.lock().expect("lock db");
                conn.execute(
                    "INSERT INTO orders (
                        id, items, total_amount, status, order_type, sync_status, created_at, updated_at
                     ) VALUES (?1, '[]', 9.5, 'completed', 'pickup', 'pending', datetime('now'), datetime('now'))",
                    params!["order-after"],
                )
                .expect("insert later order");
            }
            assert_eq!(count_orders(&app_data_dir), 2);
            stage_restore_from_point(&db_state, &point.id).expect("stage restore");
        }

        maybe_apply_pending_restore(&app_data_dir)
            .expect("apply pending restore")
            .expect("restore payload");
        assert_eq!(count_orders(&app_data_dir), 1);
        assert_eq!(count_print_jobs_by_status(&app_data_dir, "cancelled"), 1);
        assert_eq!(count_print_jobs_by_status(&app_data_dir, "pending"), 0);

        let _ = fs::remove_dir_all(app_data_dir);
    }
}
